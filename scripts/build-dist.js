// scripts/build-dist.js
// Prepares clean frontend distribution folder (dist-tauri) for Tauri packaging.
// Uses strict whitelist, validates resources, cleans stale artifacts safely,
// and generates build-info with resource checksum and commit hash.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist-tauri');

console.log('[build-dist] Preparing frontend dist for Tauri at:', distDir);

// Safety validation: distDir must be strictly inside rootDir
const relative = path.relative(rootDir, distDir);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    console.error('[build-dist] FATAL: Invalid distDir path outside project root:', distDir);
    process.exit(1);
}

// Check for junction or symlink escape
if (fs.existsSync(distDir)) {
    try {
        const stat = fs.lstatSync(distDir);
        if (stat.isSymbolicLink()) {
            console.error('[build-dist] Refusing to clean symlinked dist directory. Removing symlink only.');
            fs.unlinkSync(distDir);
        } else {
            fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 3 });
        }
    } catch (err) {
        console.error('[build-dist] Failed to clean existing dist-tauri folder:', err);
        process.exit(1);
    }
}
fs.mkdirSync(distDir, { recursive: true });

const requiredWhitelist = [
    'index.html',
    'js',
    'css',
    'assets',
    'foliate-js-main',
    'vendor',
    'services'
];

for (const item of requiredWhitelist) {
    const src = path.join(rootDir, item);
    const dest = path.join(distDir, item);
    if (!fs.existsSync(src)) {
        console.error(`[build-dist] FATAL: Required whitelist resource missing: ${item} at ${src}`);
        process.exit(1);
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
    console.log(`[build-dist] Copied ${item} -> dist-tauri/${item}`);
}

// Compute resource digest across all files copied to dist-tauri (excluding build-info itself)
function hashDirectory(dir, baseDir = dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const hashes = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            hashes.push(...hashDirectory(fullPath, baseDir));
        } else if (entry.isFile()) {
            if (entry.name === 'build-info.json') continue;
            const content = fs.readFileSync(fullPath);
            const fileHash = crypto.createHash('sha256').update(content).digest('hex');
            hashes.push(`${relPath}:${fileHash}`);
        }
    }
    return hashes;
}

const allFileHashes = hashDirectory(distDir);
const combinedDigest = crypto.createHash('sha256').update(allFileHashes.join('\n')).digest('hex');

// Get git commit if possible
let commitHash = 'dev-baseline';
try {
    commitHash = execSync('git rev-parse --short HEAD', { cwd: rootDir, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim() || 'dev-baseline';
} catch (e) {
    commitHash = 'dev-baseline';
}

let pkgVersion = '1.2.3';
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    pkgVersion = pkg.version || pkgVersion;
} catch (e) {}

const buildTimestamp = new Date().toISOString();
const buildId = `ll-${pkgVersion}-${commitHash}-${Date.now().toString(36)}`;

const buildInfo = {
    buildId,
    version: pkgVersion,
    commit: commitHash,
    resourceHash: combinedDigest,
    backend: 'pdfjs',
    timestamp: buildTimestamp,
    resourceCount: allFileHashes.length
};

fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2), 'utf8');
console.log(`[build-dist] Generated build-info.json: buildId=${buildId} resources=${allFileHashes.length} hash=${combinedDigest.slice(0, 12)}`);
console.log('[build-dist] Frontend dist preparation complete at dist-tauri!');
