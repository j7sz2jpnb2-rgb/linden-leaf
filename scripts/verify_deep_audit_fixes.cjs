// scripts/verify_deep_audit_fixes.cjs - Targeted End-to-End Test for Deep Audit Fixes
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');

function createStaticServer() {
    const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml'
    };

    const server = http.createServer((req, res) => {
        let reqPath = req.url.split('?')[0];
        if (reqPath === '/') reqPath = '/index.html';
        const filePath = path.join(rootDir, reqPath);

        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            return res.end('Not Found: ' + filePath);
        }

        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
}

async function runTests() {
    console.log('=== STARTING DEEP AUDIT FIXES VERIFICATION ===\n');

    let hasError = false;

    const staticApp = await createStaticServer();
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log('  [Browser ' + msg.type() + ']', msg.text()));
    page.on('pageerror', err => console.error('  [Page Error]', err));

    await page.goto(`http://127.0.0.1:${staticApp.port}/index.html`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));

    // Test 1: Strict Deduplication & Generic Title Protection
    console.log('[Test 1] Testing Strict Deduplication & Generic Title Protection...');
    const dedupeResult = await page.evaluate(async () => {
        try {
            const app = window.app || window.readerApp;
            const db = await import('./js/db.js?v=' + Date.now());

            // 1. Two generic files with same default title but different sizes
            const fileGen1 = new File(['第一本未命名文档内容...'], '未命名.txt', { type: 'text/plain' });
            const fileGen2 = new File(['第二本未命名文档内容是完全不同的长度和内容，字数明显更多...'], '未命名.txt', { type: 'text/plain' });

            const id1 = await app.processAndSaveBook(fileGen1);
            const id2 = await app.processAndSaveBook(fileGen2);

            const isGenericDistinct = id1 !== id2; // MUST be different books!

            // 2. Specific non-generic book imported twice
            const fileSpec1 = new File(['这是史记精选第一章内容...'], '史记·精选.txt', { type: 'text/plain' });
            const fileSpec2 = new File(['这是史记精选第一章内容...'], '史记·精选.txt', { type: 'text/plain' });

            const specId1 = await app.processAndSaveBook(fileSpec1);
            const specId2 = await app.processAndSaveBook(fileSpec2);

            const isSpecificReused = specId1 === specId2; // MUST reuse same book!

            // Cleanup
            await db.deleteBook(id1);
            await db.deleteBook(id2);
            await db.deleteBook(specId1);

            return {
                success: isGenericDistinct && isSpecificReused,
                isGenericDistinct,
                isSpecificReused,
                id1, id2, specId1, specId2
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  Dedupe Result:', dedupeResult);
    if (!dedupeResult.success) {
        console.error('❌ Deduplication Test Failed');
        hasError = true;
    } else {
        console.log('✅ Strict Deduplication & Generic Title Protection Verified!');
    }

    // Test 2: Tombstone Recording & Cloud Deletion Propagation
    console.log('\n[Test 2] Testing Tombstone Recording & Cloud Sync Deletion Propagation...');
    const tombstoneResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());
            const syncEngine = await import('./js/syncEngine.js?v=' + Date.now());

            // 1. Create a highlight and delete it
            const testHl = {
                id: 'hl_tomb_test_1',
                bookId: 'book_tomb_test',
                cfi: '/6/2[chap1]!/4/1:0',
                text: '要删除的划线测试',
                color: '#facc15',
                createdAt: 1000,
                updatedAt: 1000
            };
            await db.saveHighlight(testHl);
            await db.deleteHighlight('hl_tomb_test_1');

            // 2. Verify tombstone in db
            const deletedRecords = await db.getAllDeletedRecords();
            const hasHlTomb = deletedRecords.some(r => r.id === 'hl_tomb_test_1' && r.type === 'highlight');

            // 3. Test syncEngine merge with remote payload that still has the deleted highlight
            const localPayload = await syncEngine.exportSyncPayload();
            const remotePayload = {
                version: 1,
                booksMeta: [],
                customLists: [],
                highlights: [testHl], // Remote still has it
                bookmarks: [],
                readingSessions: [],
                deletedRecords: []
            };

            const { merged } = syncEngine.mergeSyncData(localPayload, remotePayload);
            const isHlOmittedFromMerged = !merged.highlights.some(h => h.id === 'hl_tomb_test_1');
            const isTombstonePreserved = merged.deletedRecords.some(r => r.id === 'hl_tomb_test_1');

            // Cleanup tombstone
            await db.removeDeletedRecord('hl_tomb_test_1');

            return {
                success: hasHlTomb && isHlOmittedFromMerged && isTombstonePreserved,
                hasHlTomb,
                isHlOmittedFromMerged,
                isTombstonePreserved
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  Tombstone Result:', tombstoneResult);
    if (!tombstoneResult.success) {
        console.error('❌ Tombstone Sync Test Failed');
        hasError = true;
    } else {
        console.log('✅ Tombstone Recording & Deletion Propagation Verified!');
    }

    // Test 3: Reading Progress Boundary (lastReadAt = 0 tie breaker)
    console.log('\n[Test 3] Testing Reading Progress Boundary Comparison...');
    const progressResult = await page.evaluate(async () => {
        try {
            const syncEngine = await import('./js/syncEngine.js?v=' + Date.now());

            const localPayload = {
                version: 1,
                booksMeta: [{
                    id: 'book_prog_test_1',
                    title: '未读图书',
                    lastReadAt: 0,
                    progress: { fraction: 0.42 }
                }],
                customLists: [],
                highlights: [],
                bookmarks: [],
                readingSessions: [],
                deletedRecords: []
            };

            const remotePayload = {
                version: 1,
                booksMeta: [{
                    id: 'book_prog_test_1',
                    title: '未读图书',
                    lastReadAt: 0,
                    progress: { fraction: 0 } // Remote has 0
                }],
                customLists: [],
                highlights: [],
                bookmarks: [],
                readingSessions: [],
                deletedRecords: []
            };

            const { merged } = syncEngine.mergeSyncData(localPayload, remotePayload);
            const mergedBook = merged.booksMeta.find(b => b.id === 'book_prog_test_1');
            const isFractionPreserved = mergedBook && mergedBook.progress.fraction === 0.42;

            return {
                success: isFractionPreserved,
                mergedFraction: mergedBook?.progress?.fraction
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  Progress Result:', progressResult);
    if (!progressResult.success) {
        console.error('❌ Progress Boundary Test Failed');
        hasError = true;
    } else {
        console.log('✅ Reading Progress Boundary Comparison Verified!');
    }

    // Test 4: deleteBook Preserves Historical Reading Sessions
    console.log('\n[Test 4] Testing deleteBook Preserves Historical Reading Sessions...');
    const sessionPreserveResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());

            const bookId = 'book_sess_preserve_test';
            await db.saveBook({ id: bookId, title: '即将删除的测试书' });

            const testSess = {
                id: 'sess_preserve_test_1',
                bookId: bookId,
                bookTitle: '即将删除的测试书',
                date: '2026-08-27',
                startTime: Date.now() - 3600000,
                endTime: Date.now(),
                durationSeconds: 3600
            };
            await db.recordReadingSession(testSess);

            // Delete book from shelf
            await db.deleteBook(bookId);

            // Verify reading_sessions STILL contains the record!
            const allSessions = await db.getAllReadingSessions();
            const sessionStillExists = allSessions.some(s => s.id === 'sess_preserve_test_1');

            return {
                success: sessionStillExists,
                sessionStillExists
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  Session Preserve Result:', sessionPreserveResult);
    if (!sessionPreserveResult.success) {
        console.error('❌ Session Preservation Test Failed');
        hasError = true;
    } else {
        console.log('✅ deleteBook Preserves Historical Reading Sessions Verified!');
    }

    // Test 5: updateBookMetadata updatedAt Timestamp
    console.log('\n[Test 5] Testing updateBookMetadata updatedAt Timestamp...');
    const metadataResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());

            const bookId = 'book_meta_ts_test';
            await db.saveBook({ id: bookId, title: '原标题', author: '原作者' });

            const beforeUpdate = Date.now();
            await db.updateBookMetadata(bookId, { title: '新标题', author: '新作者' });

            const book = await db.getBook(bookId);
            const hasUpdatedAt = book && book.updatedAt && book.updatedAt >= beforeUpdate;

            await db.deleteBook(bookId);

            return {
                success: hasUpdatedAt && book.title === '新标题' && book.author === '新作者',
                hasUpdatedAt,
                updatedAt: book?.updatedAt
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  Metadata Result:', metadataResult);
    if (!metadataResult.success) {
        console.error('❌ Metadata Timestamp Test Failed');
        hasError = true;
    } else {
        console.log('✅ updateBookMetadata updatedAt Timestamp Verified!');
    }

    await browser.close();
    staticApp.server.close();

    if (hasError) {
        console.error('\n❌ DEEP AUDIT VERIFICATION FINISHED WITH ERRORS');
        process.exit(1);
    } else {
        console.log('\n🌟 ALL DEEP AUDIT REFACTORS & FIXES PASSED 100%!');
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
