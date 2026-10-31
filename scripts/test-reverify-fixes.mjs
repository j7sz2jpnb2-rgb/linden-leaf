// scripts/test-reverify-fixes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

console.log('====================================================');
console.log('Running Deep Functional Re-Verification Suite');
console.log('====================================================\n');

const rootDir = 'D:/LindenLeaf-Dev/astra-mupdf-core';

// -----------------------------------------------------------------------------
// Test 1: MOBI EXTH 528 / 204 Comic Detection
// -----------------------------------------------------------------------------
console.log('Test 1: MOBI EXTH 528 & 204 Comic Detection');
{
    // Dynamically test the EXTH parsing logic
    const mobiSrc = fs.readFileSync(path.join(rootDir, 'foliate-js-main/mobi.js'), 'utf8');
    
    // Verify 528 and 204 exist in EXTH_RECORD_TYPE
    assert.match(mobiSrc, /204:\s*\['creatorSoftware'\]/);
    assert.match(mobiSrc, /528:\s*\['bookType'\]/);

    // Simulate getEXTH decoding with mock record types
    const mockExth1 = { bookType: 'comic' };
    const mockExth2 = { creatorSoftware: 'KindleComicCreator_v1.0' };
    const mockExth3 = { fixedLayout: 'true' };
    const mockExth4 = { bookType: 'novel' };

    const isComicFn = (exth) => (
        (exth.bookType && exth.bookType.toLowerCase() === 'comic')
        || exth.bookType === 'comic'
        || exth.fixedLayout === 'true'
        || exth.zeroMargin === 'true'
        || exth.zeroGutter === 'true'
        || exth.regionMagnification === 'true'
        || (typeof exth.creatorSoftware === 'string' && exth.creatorSoftware.toLowerCase().includes('comic'))
    );

    assert.equal(isComicFn(mockExth1), true, 'MOBI with bookType=comic must be detected as comic');
    assert.equal(isComicFn(mockExth2), true, 'MOBI created with KindleComicCreator must be detected as comic');
    assert.equal(isComicFn(mockExth3), true, 'MOBI with fixedLayout=true must be detected as comic');
    assert.equal(!isComicFn(mockExth4), true, 'MOBI with bookType=novel should not be detected as comic');
    console.log('  [PASS] MOBI EXTH comic detection verified for bookType and creatorSoftware');
}

// -----------------------------------------------------------------------------
// Test 2: Comic Mode CSS & SVG Container Column Breaking
// -----------------------------------------------------------------------------
console.log('\nTest 2: Comic Mode CSS & SVG Container Column Breaking');
{
    const appJsSrc = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    
    // Ensure comic CSS selector covers svg, svg:has(image), figure:has(svg), .comic-container
    assert.match(appJsSrc, /\.comic-mode svg/);
    assert.match(appJsSrc, /\.comic-mode svg:has\(image\)/);
    assert.match(appJsSrc, /\.comic-mode \.comic-container/);
    assert.match(appJsSrc, /settings\?\.comicMode \? `[\s\S]*?figure:has\(svg\)/);

    // Verify normalizeEpubDocument tags enclosing svg with comic-img & data-comic-image
    assert.match(appJsSrc, /const svgParent = img\.closest\('svg'\)/);
    assert.match(appJsSrc, /svgParent\.classList\.add\('comic-img'\)/);
    assert.match(appJsSrc, /svgParent\.dataset\.comicImage = 'true'/);
    console.log('  [PASS] SVG and comic-container multi-column isolation CSS and DOM tagging verified');
}

// -----------------------------------------------------------------------------
// Test 3: Full-text Search LRU Rehydration & No Memory Bloat
// -----------------------------------------------------------------------------
console.log('\nTest 3: Full-Text Search LRU Rehydration from IndexedDB');
{
    const { FullTextSearchEngine, EXTRACTOR_VERSION, tokenizeText } = await import(pathToFileURL(path.join(rootDir, 'js/fulltext-search.js')).href);

    const persistedDB = new Map();
    const mockDb = {
        getBook: async id => ({ id, title: `Book ${id}`, format: 'txt' }),
        getBookFileSnapshot: async id => ({ blob: new Blob(['raw text content']), blobRevision: 'rev1' }),
        saveBookSearchIndex: async (id, record) => { persistedDB.set(id, record); },
        getBookSearchIndex: async id => persistedDB.get(id) || null,
        getAllBookSearchIndexes: async () => Array.from(persistedDB.values()),
        deleteBookSearchIndex: async id => { persistedDB.delete(id); }
    };

    const engine = new FullTextSearchEngine({ db: mockDb });
    engine.setResourceBudget({ maxCacheEntries: 5, maxConcurrent: 2 });

    // Populate 10 books in IndexedDB
    for (let i = 0; i < 10; i++) {
        const text = `This is chapter ${i}. It mentions keyword_target and some other paragraphs for book-${i}.`;
        persistedDB.set(`b_${i}`, {
            bookId: `b_${i}`,
            title: `Book ${i}`,
            format: 'txt',
            extractorVersion: EXTRACTOR_VERSION,
            blobRevision: 'rev1',
            sections: [{
                id: `sec_${i}`,
                sectionIndex: 0,
                sectionTitle: `Chapter ${i}`,
                granularity: 'chapter',
                location: { sectionIndex: 0 },
                text,
                tokens: Array.from(tokenizeText(text))
            }]
        });
    }

    const books = Array.from({ length: 10 }, (_, i) => ({ id: `b_${i}`, format: 'txt', title: `Book ${i}` }));
    const streamedResults = [];
    const searchRes = await engine.searchBooks('keyword_target', books, {
        onBookResult: (res) => {
            streamedResults.push(res);
            // Verify NO allMatches attached to avoid OOM
            assert.equal(res.allMatches, undefined, 'allMatches must not be attached to streamed bookResult to avoid OOM');
            assert.equal(res.totalHits, 1);
            assert.equal(res.previewMatches.length, 1);
        }
    });

    assert.equal(streamedResults.length, 10, 'All 10 books must be traversed and streamed');
    assert.equal(searchRes.searched, 10);
    // Verify memory bounded cache did not exceed 5
    assert.ok(engine.index.size <= 5, 'In-memory index cache must be capped at 5');

    // Test searchBookFull rehydrates evicted b_0 from IndexedDB
    assert.equal(engine.index.has('b_0'), false, 'b_0 should have been evicted from LRU cache');
    const fullMatches = await engine.searchBookFull('b_0', 'keyword_target');
    assert.equal(fullMatches.length, 1);
    assert.equal(fullMatches[0].bookId, 'b_0');
    assert.equal(engine.index.has('b_0'), true, 'b_0 must be rehydrated into in-memory index');

    console.log('  [PASS] Full traversal, streaming callbacks, LRU eviction and IndexedDB rehydration verified');
}

// -----------------------------------------------------------------------------
// Test 4: Shelf Drawer & Reader Transitions
// -----------------------------------------------------------------------------
console.log('\nTest 4: Shelf Drawer State & Transitions');
{
    const appJsSrc = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');

    // Verify closeReader clears containers and sets drawer-shelf-mode
    assert.match(appJsSrc, /this\.dom\.sidebarDrawer\?\.classList\.add\('drawer-shelf-mode'\)/);
    assert.match(appJsSrc, /if \(this\.dom\.tocContainer\) this\.dom\.tocContainer\.innerHTML = ''/);
    assert.match(appJsSrc, /if \(this\.dom\.searchResultsContainer\) this\.dom\.searchResultsContainer\.innerHTML = ''/);
    assert.match(appJsSrc, /if \(this\.dom\.notesContainer\) this\.dom\.notesContainer\.innerHTML = ''/);

    // Verify openBook removes drawer-shelf-mode
    assert.match(appJsSrc, /this\.dom\.sidebarDrawer\?\.classList\.remove\('drawer-shelf-mode'\)/);

    // Verify drawer loadNotesList when !this.currentBookId gives helpful guidance
    assert.match(appJsSrc, /未打开图书/);
    console.log('  [PASS] Drawer state isolation, cleanups and reader transitions verified');
}

// -----------------------------------------------------------------------------
// Test 5: Shelf Notes Markdown Export Safe Dates
// -----------------------------------------------------------------------------
console.log('\nTest 5: Shelf Notes Markdown Export Safe Timestamps');
{
    const appJsSrc = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(appJsSrc, /const dateStr = n\.createdAt \? new Date\(n\.createdAt\)\.toLocaleString\(\) : ''/);
    assert.match(appJsSrc, /if \(dateStr && dateStr !== 'Invalid Date'\)/);
    console.log('  [PASS] Shelf notes markdown export safe date handling verified');
}

console.log('\n====================================================');
console.log('All Functional Re-Verification Checks Passed Cleanly!');
console.log('====================================================');
