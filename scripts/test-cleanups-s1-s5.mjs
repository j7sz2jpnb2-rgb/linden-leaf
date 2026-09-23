// scripts/test-cleanups-s1-s5.mjs
// Regressions and counterexamples for:
// 1. recordBookOpened timestamp semantics & sync anti-example
// 2. getReadingStats month/week period calculation isolation
// 3. Sync format sanitization & HTML escaping in cards/stats
// 4. Remote filename traversal defense & URL containment
// 5. Port check listener classification & query failure tracking

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { analyzePortConnections } from './verify-shortcut-launch.mjs';

const root = 'D:/LindenLeaf-Dev/astra-mupdf-core';
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

console.log('====================================================');
console.log('Starting Cleanups & Security Regressions Test Suite');
console.log('====================================================\n');

// -----------------------------------------------------------------------------
// Suite 1: recordBookOpened Timestamp Semantics & Sync Preemption Anti-Example
// -----------------------------------------------------------------------------
console.log('Suite 1: recordBookOpened Semantics & Sync LWW Invariance');

class MockIDBTransaction {
    constructor(store, shouldAbort = false) {
        this.store = store;
        this.shouldAbort = shouldAbort;
        this.error = shouldAbort ? new Error('Mock transaction abort') : null;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
    }
    objectStore() { return this.store; }
    commit() {
        if (this.shouldAbort) {
            if (this.onabort) this.onabort();
        } else {
            if (this.oncomplete) this.oncomplete();
        }
    }
}

class MockIDBStore {
    constructor(dataMap) {
        this.data = dataMap;
    }
    get(id) {
        const item = this.data.get(id);
        const req = { result: item ? JSON.parse(JSON.stringify(item)) : undefined, onsuccess: null, onerror: null };
        setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
        return req;
    }
    put(val) {
        this.data.set(val.id, JSON.parse(JSON.stringify(val)));
        const req = { onsuccess: null, onerror: null };
        setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
        return req;
    }
}

async function testRecordBookOpened() {
    const dbSource = read('js/db.js');
    const funcMatch = dbSource.slice(dbSource.indexOf('export const recordBookOpened ='), dbSource.indexOf('// Progress crash recovery backup')).replace(/^export /gm, '');

    const initialBook = {
        id: 'book-1',
        title: 'Test Book',
        updatedAt: 1000,
        lastOpenedAt: 500,
        lastReadAt: 600,
        progress: { fraction: 0.25, page: 10 },
        totalReadingSeconds: 300,
        isFavorite: true,
        favoriteUpdatedAt: 900,
        customListIds: ['list-1'],
        listsUpdatedAt: 950
    };

    const storeMap = new Map([['book-1', initialBook]]);
    let shouldAbortNext = false;

    const fakeDB = {
        transaction: (name, mode) => {
            const tx = new MockIDBTransaction(new MockIDBStore(storeMap), shouldAbortNext);
            setTimeout(() => tx.commit(), 5);
            return tx;
        }
    };

    const ctx = {
        openDB: async () => fakeDB,
        Date
    };

    const recordOpened = vm.runInNewContext(funcMatch + '\nrecordBookOpened', ctx);

    // 1.1 Opening book updates lastOpenedAt monotonically without touching updatedAt
    const res = await recordOpened('book-1', 2000);
    assert.equal(res, true, 'Must return true on success');
    const updated = storeMap.get('book-1');
    assert.equal(updated.lastOpenedAt, 2000, 'lastOpenedAt must be updated');
    assert.equal(updated.updatedAt, 1000, 'updatedAt must NOT be changed by opening a book');
    assert.equal(updated.lastReadAt, 600, 'lastReadAt must remain unchanged');
    assert.equal(updated.progress.fraction, 0.25, 'progress must remain unchanged');
    assert.equal(updated.totalReadingSeconds, 300, 'reading duration must remain unchanged');
    assert.equal(updated.favoriteUpdatedAt, 900, 'favorite timestamp must remain unchanged');
    console.log('  [PASS] 1.1 recordBookOpened updates lastOpenedAt without touching updatedAt or reading stats');

    // 1.2 Older openedAt does not rewind lastOpenedAt
    await recordOpened('book-1', 1500);
    const notRewound = storeMap.get('book-1');
    assert.equal(notRewound.lastOpenedAt, 2000, 'Older openedAt must not rewind lastOpenedAt');
    assert.equal(notRewound.updatedAt, 1000, 'updatedAt still unchanged');
    console.log('  [PASS] 1.2 Older openedAt is monotonically ignored');

    // 1.3 Transaction abort rejects and does not claim success
    shouldAbortNext = true;
    let failed = false;
    try {
        await recordOpened('book-1', 3000);
    } catch (e) {
        failed = true;
    }
    assert.equal(failed, true, 'Must reject on transaction abort');
    console.log('  [PASS] 1.3 Transaction failure cleanly rejects');

    // 1.4 Sync preemption anti-example using real mergeSyncData
    const syncSource = read('js/syncEngine.js');
    const helpers = syncSource.slice(syncSource.indexOf('export const ALLOWED_BOOK_FORMATS ='), syncSource.indexOf('export const isAutoDownloadEligible =')).replace(/^export /gm, '');
    const mergeSnippet = syncSource.slice(syncSource.indexOf('export const mergeSyncData ='), syncSource.indexOf('export const applyMergedPayload =')).replace(/^export /gm, '');
    const merge = vm.runInNewContext(helpers + '\n' + mergeSnippet + '\nmergeSyncData', { Date, Map, Set });

    // Local device: opened book at T=5000, but has NO favorite changes (favoriteUpdatedAt missing, updatedAt=1000)
    // Remote device: edited favorite at T=3000, updatedAt=3000 (missing favoriteUpdatedAt, relies on updatedAt fallback)
    const local = {
        booksMeta: [{
            id: 'book-1',
            title: 'Test Book',
            updatedAt: 1000, // NOT bumped by open
            lastOpenedAt: 5000,
            isFavorite: false,
            favoriteUpdatedAt: null
        }],
        highlights: [], sessions: [], bookmarks: [], customLists: [], deletedRecords: []
    };

    const remote = {
        booksMeta: [{
            id: 'book-1',
            title: 'Test Book',
            updatedAt: 3000, // Remote edit happened after local book was imported
            lastOpenedAt: 2000,
            isFavorite: true,
            favoriteUpdatedAt: null
        }],
        highlights: [], sessions: [], bookmarks: [], customLists: [], deletedRecords: []
    };

    const merged = merge(local, remote).merged;
    const mergedBook = merged.booksMeta.find(b => b.id === 'book-1');
    assert.equal(mergedBook.isFavorite, true, 'Remote edit must win because local open did not corrupt updatedAt');
    console.log('  [PASS] 1.4 Sync anti-example: Opening book does not preempt remote metadata edits');
}

// -----------------------------------------------------------------------------
// Suite 2: getReadingStats Period Calculation Isolation
// -----------------------------------------------------------------------------
console.log('\nSuite 2: getReadingStats Period Calculation Isolation');

async function testReadingStatsPeriodIsolation() {
    const db = read('js/db.js');
    const statsSource = db.slice(db.indexOf('export const getReadingStats ='), db.indexOf('export const saveCustomList =')).replace(/^export /gm, '');

    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
    const key = d => {
        d = new Date(d);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const sessions = [
        { id: 'past', bookId: 'audit-book', durationSeconds: 36000, date: key(prev), startTime: prev.getTime() },
        { id: 'today', bookId: 'audit-book', durationSeconds: 600, date: key(now), startTime: now.getTime() }
    ];

    const stats = vm.runInNewContext(statsSource + '\ngetReadingStats', {
        Date, Map, Set, toLocalDateKey: key,
        getAllReadingSessions: async () => sessions,
        getAllBooks: async () => [{
            id: 'audit-book',
            title: 'Audit Book',
            totalReadingSeconds: 36600,
            lastReadAt: now.getTime(),
            addedAt: prev.getTime()
        }],
        getAllHighlights: async () => []
    });

    const monthStats = await stats('month', now.getFullYear(), now.getMonth() + 1);
    assert.equal(monthStats.viewTotalSeconds, 600, `Current month viewTotalSeconds must be 600, got ${monthStats.viewTotalSeconds}`);
    assert.equal(monthStats.periodBooks[0].periodReadingSeconds, 600, `Current month period reading seconds must be 600, got ${monthStats.periodBooks[0].periodReadingSeconds}`);
    assert.equal(monthStats.totalSeconds, 36600, 'Total lifetime reading seconds must remain 36600');
    console.log('  [PASS] 2.1 Current month stats accurately report 600s instead of inflating with lifetime 36600s');

    // Check week view as well
    const weekStats = await stats('week', now.getFullYear(), now.getMonth() + 1, 0);
    assert.equal(weekStats.viewTotalSeconds, 600, 'Current week must strictly count this week sessions');
    console.log('  [PASS] 2.2 Current week stats strictly isolate week sessions');

    // Total view reflects lifetime
    const totalStats = await stats('total');
    assert.equal(totalStats.viewTotalSeconds, 36600, 'Total view properly reports lifetime reading seconds');
    console.log('  [PASS] 2.3 Total view accurately reports lifetime total');
}

// -----------------------------------------------------------------------------
// Suite 3: Format & Filename Sanitization and Output Escaping
// -----------------------------------------------------------------------------
console.log('\nSuite 3: Format & Filename Defense (S2 & S4)');

async function testFormatAndFilenameDefense() {
    const sync = read('js/syncEngine.js');
    const mergeSource = sync.slice(sync.indexOf('export const mergeSyncData ='), sync.indexOf('export const applyMergedPayload =')).replace(/^export /gm, '');
    const helpers = sync.slice(sync.indexOf('export const ALLOWED_BOOK_FORMATS ='), sync.indexOf('export const isAutoDownloadEligible =')).replace(/^export /gm, '');

    const merge = vm.runInNewContext(helpers + '\n' + mergeSource + '\nmergeSyncData', { Date, Map, Set });

    const untrustedFormat = '<img src="data:," data-audit="probe">';
    const traversalFilename = '../../audit-target.txt';

    const local = { booksMeta: [], highlights: [], sessions: [], bookmarks: [], customLists: [], deletedRecords: [] };
    const remote = {
        ...local,
        booksMeta: [{
            id: 'audit-book',
            format: untrustedFormat,
            title: 'Audit Book',
            cloudBackup: { hasBackup: true, fileName: traversalFilename }
        }]
    };

    const merged = merge(local, remote).merged;
    const book = merged.booksMeta.find(b => b.id === 'audit-book');

    assert.equal(book.format, 'epub', 'Malicious format string must be sanitized to safe fallback "epub"');
    assert.equal(book.cloudBackup.fileName, null, 'Path traversal filename must be sanitized out to null');
    assert.equal(book.cloudBackup.hasBackup, false, 'Invalid backup entry must have hasBackup=false');
    console.log('  [PASS] 3.1 mergeSyncData strictly sanitizes format injection and path traversal filenames');

    // Card builder escaping check
    const app = read('js/app.js');
    const cardSource = app.slice(app.indexOf('    createBookCard(book,'), app.indexOf('    getDynamicGreeting()'));
    const fakeDocument = { createElement: () => ({ dataset: {}, style: { setProperty() {} }, innerHTML: '' }) };
    const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const cardMethod = vm.runInNewContext('({' + cardSource + '}).createBookCard', { document: fakeDocument, escapeHTML, tracker: null });

    // Even if somehow an unescaped tag got past, createBookCard must escape it
    const testBook = { id: 'x', title: 'Test', format: '<script>alert(1)</script>', isCloudOnly: true };
    const card = cardMethod(testBook);
    assert(!card.innerHTML.includes('<script>'), 'Card innerHTML must NOT contain raw unescaped script tag');
    assert(card.innerHTML.includes('&lt;SCRIPT&gt;'), 'Card innerHTML must contain properly escaped tag');
    console.log('  [PASS] 3.2 createBookCard escapes format strings against HTML injection');
}

// -----------------------------------------------------------------------------
// Suite 4: Port Check Listener Classification (3.B)
// -----------------------------------------------------------------------------
console.log('\nSuite 4: Port Check Listener Classification (3.B)');

function testPortListenerAnalysis() {
    const targetPorts = [9222, 9223, 9333, 9444];
    const appPids = [1000, 1001, 1002];

    // Case 1: Query failed
    assert.throws(() => {
        analyzePortConnections([], targetPorts, appPids, true, new Error('Permission denied'));
    }, /Port query execution failed/, 'Must throw on query execution error');
    console.log('  [PASS] 4.1 Query failure raises error and is not swallowed');

    // Case 2: Clean query with no listeners
    const cleanResult = analyzePortConnections([], targetPorts, appPids, false, null);
    assert.equal(cleanResult.clean, true);
    assert.equal(cleanResult.unrelatedListeners.length, 0);
    console.log('  [PASS] 4.2 Empty listener list passes cleanly');

    // Case 3: App-owned listener found
    const appListening = [
        { LocalPort: 9222, OwningProcess: 1001, State: 'Listen' }
    ];
    assert.throws(() => {
        analyzePortConnections(appListening, targetPorts, appPids, false, null);
    }, /Unexpected application debug port listening/, 'Must throw when app owns target listener');
    console.log('  [PASS] 4.3 App-owned target port listener triggers failure');

    // Case 4: Unrelated listener (e.g. PID 9999)
    const unrelatedListening = [
        { LocalPort: 9222, OwningProcess: 9999, State: 'Listen' }
    ];
    const unrelatedResult = analyzePortConnections(unrelatedListening, targetPorts, appPids, false, null);
    assert.equal(unrelatedResult.clean, true);
    assert.equal(unrelatedResult.unrelatedListeners.length, 1);
    assert.equal(unrelatedResult.unrelatedListeners[0].pid, 9999);
    console.log('  [PASS] 4.4 Unrelated listener is correctly identified without false positive');
}

async function runAll() {
    await testRecordBookOpened();
    await testReadingStatsPeriodIsolation();
    await testFormatAndFilenameDefense();
    testPortListenerAnalysis();
    console.log('\n====================================================');
    console.log('All Cleanups & Security Regressions Passed Successfully!');
    console.log('====================================================');
}

runAll().catch(e => {
    console.error('Test Suite Failed:', e);
    process.exitCode = 1;
});
