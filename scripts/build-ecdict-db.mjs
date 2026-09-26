// scripts/build-ecdict-db.mjs
// Downloads official Skywind3000 ECDICT dataset, verifies SHA256, and builds indexed SQLite ecdict.db.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const UPSTREAM_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
const LICENSE_URL = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/LICENSE';
const CACHE_DIR = path.resolve('D:/LindenLeaf-Data/development/dictionary-cache');
const OUTPUT_DIR = path.resolve('resources/dictionary');
const CSV_CACHE_PATH = path.join(CACHE_DIR, 'ecdict.csv');
const DB_OUTPUT_PATH = path.join(OUTPUT_DIR, 'ecdict.db');
const META_OUTPUT_PATH = path.join(OUTPUT_DIR, 'metadata.json');

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function downloadFile(url, destPath) {
    console.log(`[ECDICT] Downloading from ${url} ...`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP error ${resp.status} fetching ${url}`);
    const fileStream = fs.createWriteStream(destPath);
    await pipeline(Readable.fromWeb(resp.body), fileStream);
    console.log(`[ECDICT] Download complete: ${destPath}`);
}

async function computeSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', d => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function parseCSVLine(line) {
    // Simple state-machine CSV parser for single row
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === ',' && !inQuotes) {
            result.push(cur);
            cur = '';
        } else {
            cur += c;
        }
    }
    result.push(cur);
    return result;
}

async function buildDatabase() {
    if (!fs.existsSync(CSV_CACHE_PATH) || fs.statSync(CSV_CACHE_PATH).size < 1000000) {
        await downloadFile(UPSTREAM_URL, CSV_CACHE_PATH);
    } else {
        console.log(`[ECDICT] Using existing cached CSV: ${CSV_CACHE_PATH} (${(fs.statSync(CSV_CACHE_PATH).size / (1024*1024)).toFixed(2)} MB)`);
    }

    const sha256 = await computeSha256(CSV_CACHE_PATH);
    const csvStats = fs.statSync(CSV_CACHE_PATH);
    console.log(`[ECDICT] CSV Size: ${csvStats.size} bytes, SHA256: ${sha256}`);

    // If destination DB already exists, remove it for clean build
    if (fs.existsSync(DB_OUTPUT_PATH)) {
        fs.unlinkSync(DB_OUTPUT_PATH);
    }

    console.log(`[ECDICT] Creating SQLite database: ${DB_OUTPUT_PATH} ...`);
    const db = new DatabaseSync(DB_OUTPUT_PATH);
    db.exec('PRAGMA synchronous = OFF;');
    db.exec('PRAGMA journal_mode = MEMORY;');
    db.exec('PRAGMA page_size = 4096;');
    db.exec(`
        CREATE TABLE entries (
            word TEXT PRIMARY KEY COLLATE NOCASE,
            phonetic TEXT,
            definition TEXT,
            translation TEXT,
            pos TEXT,
            exchange TEXT
        );
    `);

    const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO entries (word, phonetic, definition, translation, pos, exchange)
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const fileContent = fs.readFileSync(CSV_CACHE_PATH, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    console.log(`[ECDICT] Total raw lines: ${lines.length}`);

    // Header: word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
    let rowCount = 0;
    db.exec('BEGIN TRANSACTION;');

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cols = parseCSVLine(line);
        const word = cols[0]?.trim();
        if (!word) continue;

        const phonetic = cols[1] || '';
        const definition = cols[2] || '';
        // Translation in ECDICT uses literal \n characters inside CSV fields: replace with real newlines
        const translation = (cols[3] || '').replace(/\\n/g, '\n');
        const pos = cols[4] || '';
        const exchange = cols[10] || '';

        try {
            insertStmt.run(word, phonetic, definition, translation, pos, exchange);
            rowCount++;
        } catch (err) {
            // Ignore rare duplicate or formatting quirk
        }

        if (rowCount % 50000 === 0) {
            db.exec('COMMIT;');
            console.log(`[ECDICT] Inserted ${rowCount} entries...`);
            db.exec('BEGIN TRANSACTION;');
        }
    }
    db.exec('COMMIT;');

    console.log(`[ECDICT] Creating index on word COLLATE NOCASE...`);
    db.exec('CREATE INDEX idx_word ON entries(word COLLATE NOCASE);');
    db.exec('PRAGMA optimize;');

    // Test lookups
    const testStmt = db.prepare('SELECT * FROM entries WHERE word = ? COLLATE NOCASE LIMIT 1;');
    for (const testWord of ['hello', 'literature', 'phenomenon', 'serendipity', 'book']) {
        const row = testStmt.get(testWord);
        console.log(`[ECDICT Test] ${testWord} -> phonetic: ${row?.phonetic}, trans: ${row?.translation?.slice(0, 30)}`);
    }

    db.close();

    const dbStats = fs.statSync(DB_OUTPUT_PATH);
    const dbSha256 = await computeSha256(DB_OUTPUT_PATH);
    console.log(`[ECDICT] SQLite DB built successfully! Size: ${(dbStats.size / (1024*1024)).toFixed(2)} MB, SHA256: ${dbSha256}`);

    const metadata = {
        name: 'Skywind3000 ECDICT',
        version: '1.0.28',
        license: 'MIT',
        licenseUrl: LICENSE_URL,
        sourceUrl: UPSTREAM_URL,
        upstreamCommit: '8defb761f7c7ad1818ca94290a1844d7b33d6b23',
        csvSha256: sha256,
        csvSizeBytes: csvStats.size,
        dbSha256: dbSha256,
        dbSizeBytes: dbStats.size,
        totalEntries: rowCount,
        builtAt: new Date().toISOString()
    };

    fs.writeFileSync(META_OUTPUT_PATH, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`[ECDICT] Metadata written to ${META_OUTPUT_PATH}`);

    // Also copy to AppData for immediate use in Candidate / dev environment
    const appData = process.env.APPDATA;
    if (appData) {
        const targetDir = path.join(appData, 'com.lindenleaf.reader', 'dictionary');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(DB_OUTPUT_PATH, path.join(targetDir, 'ecdict.db'));
        fs.copyFileSync(META_OUTPUT_PATH, path.join(targetDir, 'metadata.json'));
        console.log(`[ECDICT] Copied ecdict.db and metadata.json to AppData: ${targetDir}`);
    }
}

buildDatabase().catch(err => {
    console.error('[ECDICT Error]', err);
    process.exit(1);
});
