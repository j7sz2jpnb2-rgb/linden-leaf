// scripts/verify_all_architectural_fixes.cjs - Automated End-to-End Test for All Architectural Refactors
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const rootDir = 'C:\\Users\\Administrator\\.gemini\\antigravity\\scratch\\universal-reader';

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
    console.log('=== STARTING ALL ARCHITECTURAL FIXES VERIFICATION ===\n');

    let hasError = false;

    // Test 1: package.json files whitelist check
    console.log('[Test 1] Verifying package.json build files configuration...');
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const filesList = pkg.build?.files || [];
    const hasServices = filesList.includes('services/**/*');
    if (!hasServices) {
        console.error('❌ package.json build.files is missing services/**/*');
        hasError = true;
    } else {
        console.log('✅ package.json files whitelist correctly includes services/**/*');
    }

    // Launch headless browser for IndexedDB, Deduplication, and TTS tests
    const staticApp = await createStaticServer();
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-gpu']
    });

    const page = await browser.newPage();
    page.on('console', msg => {
        if (msg.type() === 'error') console.error('  [Browser Error]', msg.text());
    });
    page.on('pageerror', err => console.error('  [Page Error]', err));

    await page.goto(`http://127.0.0.1:${staticApp.port}/index.html`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1200));

    // Test 2: IndexedDB Decoupling (books metadata vs book_files blob)
    console.log('\n[Test 2] Testing IndexedDB metadata & binary separation (OOM Prevention)...');
    const dbDecoupleResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());
            
            // Create a dummy 2MB Blob
            const dummyBytes = new Uint8Array(2 * 1024 * 1024);
            dummyBytes.fill(65);
            const dummyBlob = new Blob([dummyBytes], { type: 'application/epub+zip' });

            const testBook = {
                id: 'test_book_decouple_1',
                title: '测试内存隔离书籍',
                author: '架构测试员',
                format: 'epub',
                size: dummyBlob.size,
                blob: dummyBlob,
                isFavorite: false,
                customListIds: ['list_arch_1'],
                addedAt: Date.now(),
                lastReadAt: Date.now(),
                totalReadingSeconds: 300,
                progress: { fraction: 0.25 }
            };

            // 1. Save Book
            await db.saveBook(testBook);

            // 2. Fetch all books (Should NOT have blob)
            const allBooks = await db.getAllBooks();
            const retrieved = allBooks.find(b => b.id === 'test_book_decouple_1');
            const hasBlobInMeta = retrieved && 'blob' in retrieved && retrieved.blob !== undefined;

            // 3. Fetch file blob separately
            const fileBlob = await db.getBookFileBlob('test_book_decouple_1');
            const isBlobValid = fileBlob && fileBlob.size === dummyBlob.size;

            // 4. Delete book
            await db.deleteBook('test_book_decouple_1');
            const afterDeleteMeta = await db.getBook('test_book_decouple_1');
            const afterDeleteBlob = await db.getBookFileBlob('test_book_decouple_1');

            return {
                success: !hasBlobInMeta && isBlobValid && !afterDeleteMeta && !afterDeleteBlob,
                hasBlobInMeta,
                isBlobValid,
                isCleanedUp: !afterDeleteMeta && !afterDeleteBlob
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  DB Decouple Result:', dbDecoupleResult);
    if (!dbDecoupleResult.success) {
        console.error('❌ IndexedDB Decouple Test Failed');
        hasError = true;
    } else {
        console.log('✅ IndexedDB Decoupling Verified! Zero-blob metadata queries prevent OOM.');
    }

    // Test 3: Deduplication and reading progress preservation on re-import
    console.log('\n[Test 3] Testing File Association & De-duplication...');
    await page.waitForFunction(() => !!window.app || !!window.readerApp, { timeout: 10000 });

    const dedupeResult = await page.evaluate(async () => {
        try {
            const app = window.app || window.readerApp;

            const dummyBytes = new Uint8Array(1024);
            const file1 = new File([dummyBytes], '三体_全集.epub', { type: 'application/epub+zip' });
            
            // First import
            const bookId1 = await app.processAndSaveBook(file1);

            // Simulate user reading and making progress
            const db = await import('./js/db.js');
            await db.updateBookProgress(bookId1, { fraction: 0.65, cfi: '/6/4[chap1]!/4/2/1:0' });

            // Second import of same file
            const file2 = new File([dummyBytes], '三体_全集.epub', { type: 'application/epub+zip' });
            const bookId2 = await app.processAndSaveBook(file2);

            // Verify same ID returned and progress preserved
            const bookRecord = await db.getBook(bookId1);
            const isSameId = bookId1 === bookId2;
            const isProgressPreserved = bookRecord.progress && bookRecord.progress.fraction === 0.65;

            // Clean up
            await db.deleteBook(bookId1);

            return {
                success: isSameId && isProgressPreserved,
                isSameId,
                isProgressPreserved,
                progressFraction: bookRecord.progress?.fraction
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
        console.log('✅ De-duplication Verified! Existing book records and reading progress are preserved.');
    }

    // Test 4: TTS Sentence Chunking
    console.log('\n[Test 4] Testing TTS Sentence Splitting & Queueing...');
    const ttsResult = await page.evaluate(async () => {
        try {
            const { tts } = await import('./js/tts.js?v=' + Date.now());
            const sampleText = `这是第一句话，充满了哲理。这是第二句话！它带有一些激动人心的色彩？另外，还有第三句话；这是一段长文本测试。`;
            const sentences = tts.splitIntoSentences(sampleText);
            
            return {
                success: sentences.length >= 3 && sentences.every(s => s.length > 0),
                sentencesCount: sentences.length,
                sentences
            };
        } catch (e) {
            return { success: false, error: e.message, stack: e.stack };
        }
    });

    console.log('  TTS Result:', ttsResult);
    if (!ttsResult.success) {
        console.error('❌ TTS Sentence Splitting Test Failed');
        hasError = true;
    } else {
        console.log('✅ TTS Sentence Chunking Verified! Bypasses Chromium 15s audio timeout.');
    }

    // Test 5: Strict Deduplication & Generic Title Protection
    console.log('\n[Test 5] Testing Strict Deduplication & Generic Title Protection...');
    const dedupeGenericResult = await page.evaluate(async () => {
        try {
            const app = window.app || window.readerApp;
            const db = await import('./js/db.js?v=' + Date.now());

            const fileGen1 = new File(['第一本未命名文档内容...'], '未命名.txt', { type: 'text/plain' });
            const fileGen2 = new File(['第二本未命名文档内容是完全不同的长度和内容，字数明显更多...'], '未命名.txt', { type: 'text/plain' });

            const id1 = await app.processAndSaveBook(fileGen1);
            const id2 = await app.processAndSaveBook(fileGen2);

            const isGenericDistinct = id1 !== id2; // MUST be different books!

            const fileSpec1 = new File(['这是史记精选第一章内容...'], '史记·精选.txt', { type: 'text/plain' });
            const fileSpec2 = new File(['这是史记精选第一章内容...'], '史记·精选.txt', { type: 'text/plain' });

            const specId1 = await app.processAndSaveBook(fileSpec1);
            const specId2 = await app.processAndSaveBook(fileSpec2);

            const isSpecificReused = specId1 === specId2; // MUST reuse same book!

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

    console.log('  Dedupe Generic Result:', dedupeGenericResult);
    if (!dedupeGenericResult.success) {
        console.error('❌ Generic Deduplication Test Failed');
        hasError = true;
    } else {
        console.log('✅ Strict Deduplication & Generic Title Protection Verified!');
    }

    // Test 6: Tombstone Recording & Cloud Deletion Propagation
    console.log('\n[Test 6] Testing Tombstone Recording & Cloud Sync Deletion Propagation...');
    const tombstoneResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());
            const syncEngine = await import('./js/syncEngine.js?v=' + Date.now());

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

            const deletedRecords = await db.getAllDeletedRecords();
            const hasHlTomb = deletedRecords.some(r => r.id === 'hl_tomb_test_1' && r.type === 'highlight');

            const localPayload = await syncEngine.exportSyncPayload();
            const remotePayload = {
                version: 1,
                booksMeta: [],
                customLists: [],
                highlights: [testHl],
                bookmarks: [],
                readingSessions: [],
                deletedRecords: []
            };

            const { merged } = syncEngine.mergeSyncData(localPayload, remotePayload);
            const isHlOmittedFromMerged = !merged.highlights.some(h => h.id === 'hl_tomb_test_1');
            const isTombstonePreserved = merged.deletedRecords.some(r => r.id === 'hl_tomb_test_1');

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

    // Test 7: Reading Progress Boundary (lastReadAt = 0 tie breaker)
    console.log('\n[Test 7] Testing Reading Progress Boundary Comparison...');
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
                    progress: { fraction: 0 }
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

    // Test 8: deleteBook Preserves Historical Reading Sessions
    console.log('\n[Test 8] Testing deleteBook Preserves Historical Reading Sessions...');
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

            await db.deleteBook(bookId);

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

    // Test 9: updateBookMetadata updatedAt Timestamp
    console.log('\n[Test 9] Testing updateBookMetadata updatedAt Timestamp...');
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

    // Test 10: getBookFile alias test
    console.log('\n[Test 10] Testing getBookFile export alias...');
    const aliasResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());
            const hasAlias = typeof db.getBookFile === 'function' && typeof db.getBookFileBlob === 'function';
            return { success: hasAlias, isFunction: typeof db.getBookFile === 'function' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
    console.log('  Alias Result:', aliasResult);
    if (!aliasResult.success) {
        console.error('❌ getBookFile Alias Test Failed');
        hasError = true;
    } else {
        console.log('✅ getBookFile Alias Verified!');
    }

    // Test 11: recordReadingSession updateBookTotal = false prevents double counting
    console.log('\n[Test 11] Testing recordReadingSession updateBookTotal flag (Prevents sync double counting)...');
    const syncReplayResult = await page.evaluate(async () => {
        try {
            const db = await import('./js/db.js?v=' + Date.now());
            const bookId = `book_test_sync_${Date.now()}`;
            await db.saveBook({
                id: bookId,
                title: '同步测试书',
                totalReadingSeconds: 1800
            });

            // Simulate cloud sync replay with updateBookTotal = false
            await db.saveReadingSession({
                id: `sess_remote_${Date.now()}`,
                bookId: bookId,
                durationSeconds: 1800,
                date: db.toLocalDateKey(Date.now()),
                startTime: Date.now() - 1800000,
                endTime: Date.now()
            }, false);

            const book = await db.getBook(bookId);
            await db.deleteBook(bookId);

            return {
                success: book?.totalReadingSeconds === 1800,
                totalReadingSeconds: book?.totalReadingSeconds
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
    console.log('  Sync Replay Result:', syncReplayResult);
    if (!syncReplayResult.success) {
        console.error('❌ Sync Replay Double Counting Prevention Test Failed');
        hasError = true;
    } else {
        console.log('✅ Sync Replay Double Counting Prevention Verified! (Duration remains exactly 1800s)');
    }

    // Test 12: Search makeExcerpt multi-node array slicing
    console.log('\n[Test 12] Testing search.js makeExcerpt multi-node array slice fix...');
    const searchExcerptResult = await page.evaluate(async () => {
        try {
            const { search } = await import('./foliate-js-main/search.js?v=' + Date.now());
            const strs = ['欢迎阅读', '三体', '宇宙文明的故事'];
            const results = Array.from(search(strs, '三体宇宙'));
            const res = results[0];
            const hasFullMatch = res && res.excerpt && res.excerpt.match === '三体宇宙';
            return {
                success: results.length > 0 && hasFullMatch,
                matchText: res?.excerpt?.match,
                excerpt: res?.excerpt
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
    console.log('  Search Excerpt Result:', searchExcerptResult);
    if (!searchExcerptResult.success) {
        console.error('❌ Search Excerpt Test Failed');
        hasError = true;
    } else {
        console.log('✅ Search Excerpt Multi-node Slice Verified!');
    }

    await browser.close();
    staticApp.server.close();

    if (hasError) {
        console.error('\n❌ VERIFICATION FINISHED WITH ERRORS');
        process.exit(1);
    } else {
        console.log('\n🌟 ALL ARCHITECTURAL REFACTORS & BUG FIXES PASSED 100%!');
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
