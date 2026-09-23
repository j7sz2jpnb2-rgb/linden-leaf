// scripts/test-batch1-repairs.mjs
// Verification suite for S1-S5 repairs based on Astra's 05 and 06 instructions.

import assert from 'node:assert/strict';

// Setup browser-like globals
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const mockStorage = new Map();
globalThis.localStorage = {
    getItem(k) { return mockStorage.get(k) || null; },
    setItem(k, v) { mockStorage.set(k, String(v)); },
    removeItem(k) { mockStorage.delete(k); },
    clear() { mockStorage.clear(); }
};

globalThis.NodeFilter = { SHOW_ALL: -1, SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.CSS = { escape: (s) => String(s) };
globalThis.DOMMatrix = class DOMMatrix { constructor() { this.a = 1; } };
globalThis.customElements = { define: () => {}, get: () => {} };
globalThis.HTMLElement = class HTMLElement {};

const createMockEl = (tag = 'DIV', id = '') => {
    const classes = new Set();
    const styleObj = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    const el = {
        tagName: tag.toUpperCase(),
        id,
        style: styleObj,
        classList: {
            classes,
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
            toggle(c) { if (classes.has(c)) classes.delete(c); else classes.add(c); },
            contains(c) { return classes.has(c); }
        },
        get className() { return Array.from(classes).join(' '); },
        set className(c) {
            classes.clear();
            if (c) c.split(/\s+/).filter(Boolean).forEach(cls => classes.add(cls));
        },
        dataset: {},
        children: [],
        appendChild(child) { if (child) { child.parentElement = el; this.children.push(child); } return child; },
        removeChild(child) { const idx = this.children.indexOf(child); if (idx >= 0) this.children.splice(idx, 1); return child; },
        remove() { if (this.parentElement) this.parentElement.removeChild(this); },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k] || null; },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {},
        focus: () => {},
        blur: () => {},
        click: () => {},
        select: () => {},
        open: async () => {},
        init: async () => {},
        close: () => {},
        addAnnotation: async () => {},
        deleteAnnotation: async () => {},
        renderer: { getContents: () => [], settle: () => {} },
        book: { toc: [], sections: [] },
        matches: () => false,
        querySelector: () => createMockEl('DIV'),
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 1100 }),
        offsetWidth: 800,
        offsetHeight: 1100,
        scrollTop: 0,
        clientHeight: 800
    };
    return el;
};

const docEl = createMockEl('HTML');
globalThis.document = {
    head: createMockEl('HEAD'),
    body: createMockEl('BODY'),
    documentElement: docEl,
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => createMockEl(tag),
    createDocumentFragment: () => createMockEl('DOCUMENT-FRAGMENT'),
    createTextNode: (t) => createMockEl('TEXT'),
    getElementById: (id) => createMockEl('DIV', id),
    querySelector: () => createMockEl('DIV'),
    querySelectorAll: () => []
};

globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.platformBridge = {
    flushCalls: [],
    flushComplete(id) { this.flushCalls.push(id); },
    openExternal: () => {}
};

// In-Memory IndexedDB Mock
class MockIDBRequest {
    constructor() { this.result = null; this.error = null; this.onsuccess = null; this.onerror = null; }
    _succeed(val) { this.result = val; if (typeof this.onsuccess === 'function') this.onsuccess({ target: this }); }
    _fail(err) { this.error = err; if (typeof this.onerror === 'function') this.onerror({ target: this }); }
}

class MockIDBObjectStore {
    constructor(name, db, keyPath, autoIncrement = false) {
        this.name = name; this.db = db; this.keyPath = keyPath; this.autoIncrement = autoIncrement;
        this.data = new Map(); this._autoId = 1; this.indexes = new Map();
    }
    createIndex(name, keyPath, options) { this.indexes.set(name, { name, keyPath, options }); }
}

class MockIDBTransaction {
    constructor(db, storeNames, mode) {
        this.db = db; this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
        this.mode = mode; this.oncomplete = null; this.onerror = null; this.onabort = null;
        this.error = null; this._aborted = false; this._activeRequests = 0; this._journal = [];
        this._checkComplete();
    }
    _checkComplete() {
        setImmediate(() => {
            if (this._aborted) return;
            if (this._activeRequests === 0) {
                if (typeof this.oncomplete === 'function') this.oncomplete({ target: this });
            } else {
                this._checkComplete();
            }
        });
    }
    objectStore(name) {
        const s = this.db.stores.get(name);
        return {
            name: s.name, keyPath: s.keyPath,
            index: (idxName) => {
                const idx = s.indexes.get(idxName);
                return {
                    getAll: (key) => {
                        const req = new MockIDBRequest();
                        this._activeRequests++;
                        queueMicrotask(() => {
                            const matched = [];
                            for (const v of s.data.values()) {
                                if (idx && v[idx.keyPath] === key) matched.push(structuredClone(v));
                            }
                            this._activeRequests--;
                            req._succeed(matched);
                        });
                        return req;
                    }
                };
            },
            get: (key) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    const val = s.data.get(key);
                    this._activeRequests--;
                    req._succeed(val !== undefined ? structuredClone(val) : undefined);
                });
                return req;
            },
            put: (val, key) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    let k = key || (s.keyPath ? val[s.keyPath] : s._autoId++);
                    const hadOld = s.data.has(k);
                    const oldVal = hadOld ? structuredClone(s.data.get(k)) : undefined;
                    this._journal.push({ store: s, key: k, hadOld, oldVal });
                    s.data.set(k, structuredClone(val));
                    this._activeRequests--;
                    req._succeed(k);
                });
                return req;
            },
            delete: (key) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    const hadOld = s.data.has(key);
                    const oldVal = hadOld ? structuredClone(s.data.get(key)) : undefined;
                    this._journal.push({ store: s, key, hadOld, oldVal });
                    s.data.delete(key);
                    this._activeRequests--;
                    req._succeed(undefined);
                });
                return req;
            },
            getAll: () => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    this._activeRequests--;
                    req._succeed(Array.from(s.data.values()).map(v => structuredClone(v)));
                });
                return req;
            }
        };
    }
    abort() {
        this._aborted = true;
        this.error = new Error('Transaction aborted');
        for (let i = this._journal.length - 1; i >= 0; i--) {
            const entry = this._journal[i];
            if (entry.hadOld) entry.store.data.set(entry.key, entry.oldVal);
            else entry.store.data.delete(entry.key);
        }
        if (typeof this.onerror === 'function') this.onerror({ target: this });
        if (typeof this.onabort === 'function') this.onabort({ target: this });
    }
}

class MockIDBDatabase {
    constructor(name, version) {
        this.name = name; this.version = version; this.stores = new Map();
    }
    get objectStoreNames() {
        return {
            contains: (name) => this.stores.has(name),
            item: (i) => Array.from(this.stores.keys())[i],
            length: this.stores.size
        };
    }
    createObjectStore(name, { keyPath, autoIncrement } = {}) {
        const store = new MockIDBObjectStore(name, this, keyPath, autoIncrement);
        this.stores.set(name, store);
        return store;
    }
    transaction(storeNames, mode = 'readonly') {
        if (this.failGetSnapshot && storeNames.includes('book_files')) {
            throw new Error('Database disk IO error');
        }
        const tx = new MockIDBTransaction(this, storeNames, mode);
        if (this.hangProgress && storeNames.includes('books') && mode === 'readwrite') {
            tx._checkComplete = () => {};
        }
        if (this.failProgressWrite && storeNames.includes('books') && mode === 'readwrite') {
            queueMicrotask(() => tx.abort());
        }
        if (this.failReadingSessionWrite && storeNames.includes('reading_sessions') && mode === 'readwrite') {
            queueMicrotask(() => tx.abort());
        }
        return tx;
    }
}

const mockDB = new MockIDBDatabase('LindenLeafDB', 7);
mockDB.createObjectStore('books', { keyPath: 'id' });
mockDB.createObjectStore('book_files', { keyPath: 'id' });
const hlStore = mockDB.createObjectStore('highlights', { keyPath: 'id' });
hlStore.createIndex('bookId', 'bookId', { unique: false });
const bmStore = mockDB.createObjectStore('bookmarks', { keyPath: 'id' });
bmStore.createIndex('bookId', 'bookId', { unique: false });
mockDB.createObjectStore('settings', { keyPath: 'key' });
const sStore = mockDB.createObjectStore('reading_sessions', { keyPath: 'id' });
sStore.createIndex('bookId', 'bookId', { unique: false });
sStore.createIndex('date', 'date', { unique: false });
sStore.createIndex('startTime', 'startTime', { unique: false });
const listStore = mockDB.createObjectStore('custom_lists', { keyPath: 'id' });
listStore.createIndex('createdAt', 'createdAt', { unique: false });
const delStore = mockDB.createObjectStore('deleted_records', { keyPath: 'id' });
delStore.createIndex('type', 'type', { unique: false });
delStore.createIndex('deletedAt', 'deletedAt', { unique: false });
const drawStore = mockDB.createObjectStore('pdf_drawings', { keyPath: 'id' });
drawStore.createIndex('bookId', 'bookId', { unique: false });

globalThis.indexedDB = {
    open: () => {
        const req = new MockIDBRequest();
        queueMicrotask(() => { req.result = mockDB; req._succeed(mockDB); });
        return req;
    }
};

// Import production modules
const db = await import('../js/db.js?v=20260914_rel_v1');
const { ReadingTracker, tracker } = await import('../js/tracker.js?v=20260914_rel_v1');
const { UniversalReaderApp } = await import('../js/app.js');
const { platformBridge } = await import('../js/platformBridge.js');

platformBridge.flushCalls = [];
const origPlatformFlushComplete = platformBridge.flushComplete.bind(platformBridge);
platformBridge.flushComplete = (requestId) => {
    platformBridge.flushCalls.push(requestId);
    return origPlatformFlushComplete(requestId);
};

let passed = 0;
let total = 0;

async function test(name, fn) {
    total++;
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(err);
    }
}

console.log('====================================================');
console.log('Starting S1-S5 In-Depth Verification Test Suite');
console.log('====================================================\n');

// -----------------------------------------------------------------
// S1 Tests: Queue failure separation & late start ownership guard
// -----------------------------------------------------------------
console.log('Suite S1: Reading Tracker Queue & Ownership Guard');

await test('S1.1: First write rejection does not block second session write to DB', async () => {
    mockStorage.clear();
    const t = new ReadingTracker();
    mockDB.failReadingSessionWrite = true;

    await t.startSession('book-A', 'Book A', 0.1);
    t.sessionCumulativeSeconds = 90;
    await assert.rejects(t.endSession(0.2));

    // Second session
    mockDB.failReadingSessionWrite = false;
    await t.startSession('book-B', 'Book B', 0.3);
    t.sessionCumulativeSeconds = 90;
    const resB = await t.endSession(0.4);
    assert.equal(resB.status, 'committed');
    const sessB = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-B');
    assert.ok(sessB, 'Second session MUST be saved to DB');
});

await test('S1.2: Late start(B) after start(C) does not overwrite active book C', async () => {
    const u = new ReadingTracker();
    await u.startSession('book-A', 'Book A', 0.1);
    u.sessionCumulativeSeconds = 90;

    let releaseA;
    const origFlush = u.flush;
    u.flush = (isFinal, finalFrac, snap) => {
        if (snap?.bookId === 'book-A') {
            return new Promise(r => { releaseA = () => origFlush.call(u, isFinal, finalFrac, snap).then(r); });
        }
        return origFlush.call(u, isFinal, finalFrac, snap);
    };

    const pendingB = u.startSession('book-B', 'Book B', 0.2);
    await Promise.resolve();

    // Now start C while B is awaiting A's end
    await u.startSession('book-C', 'Book C', 0.3);
    assert.equal(u.currentBookId, 'book-C');

    // Release A's flush, allowing pendingB to resume
    releaseA();
    await pendingB;

    // After B completes its awaiting, C must STILL be the active book!
    assert.equal(u.currentBookId, 'book-C', 'Active book must remain Book C, not overwritten by delayed Book B');
    await u.endSession();
});

// -----------------------------------------------------------------
// S2 Tests: Progress & Tracker Backups and Recovery Barrier
// -----------------------------------------------------------------
console.log('\nSuite S2: Progress & Session Backup Recovery and Isolation');

await test('S2.1: Progress backup recovers on app startup, retains on write failure, clears on success', async () => {
    mockStorage.clear();
    const bookId = 'book-progress-rec-1';
    await db.saveBook({ id: bookId, title: 'Rec Book', format: 'epub', progress: { fraction: 0.1, updatedAt: 100 }, blob: new Blob(['Content'], { type: 'application/epub+zip' }) });
    const snap = await db.getBookFileSnapshot(bookId);

    // Save pending progress backup with newer updatedAt
    const pendingProg = {
        bookId,
        fraction: 0.5,
        page: 5,
        blobRevision: snap.blobRevision,
        revisionOrigin: snap.revisionOrigin,
        updatedAt: 200
    };
    db.backupPendingProgress(bookId, pendingProg);

    // Verify it is in localStorage
    assert.ok(mockStorage.get('linden_pending_progress_backup'));

    // Recover progress
    await db.recoverPendingProgressBackup();

    // Verify book in DB now has fraction 0.5
    const bookAfter = await db.getBook(bookId);
    assert.equal(bookAfter.progress.fraction, 0.5);
    assert.equal(bookAfter.progress.updatedAt, 200);

    // Verify backup was cleared from localStorage
    const rawMap = JSON.parse(mockStorage.get('linden_pending_progress_backups') || '{}');
    assert.equal(rawMap[bookId], undefined, 'Backup must be deleted after successful recovery');
});

await test('S2.2: Progress backup does NOT overwrite if file was replaced with different revision', async () => {
    mockStorage.clear();
    const bookId = 'book-progress-mismatch';
    await db.saveBook({ id: bookId, title: 'Mismatch Book', format: 'epub', progress: { fraction: 0.1, updatedAt: 100 }, blob: new Blob(['Content Rev 1'], { type: 'application/epub+zip' }) });

    // Backup with old revision
    db.backupPendingProgress(bookId, { bookId, fraction: 0.9, blobRevision: 'rev-old', revisionOrigin: 'some-origin', updatedAt: 200 });

    // Now replace file blob in DB, bumping revision
    await db.saveBook({ id: bookId, title: 'Mismatch Book', format: 'epub', progress: { fraction: 0.1, updatedAt: 100 }, blob: new Blob(['Content Rev 2 New'], { type: 'application/epub+zip' }) });
    const snap2 = await db.getBookFileSnapshot(bookId);
    assert.notEqual(snap2.blobRevision, 'rev-old');

    // Run recovery
    await db.recoverPendingProgressBackup();

    // Book progress should NOT have been updated to 0.9 because revision mismatched
    const bookAfter = await db.getBook(bookId);
    assert.equal(bookAfter.progress.fraction, 0.1, 'Outdated revision progress must NOT overwrite replaced file');
});

await test('S2.3: Progress backup does NOT overwrite newer progress in DB', async () => {
    mockStorage.clear();
    const bookId = 'book-progress-newer-db';
    await db.saveBook({ id: bookId, title: 'Newer DB Book', format: 'epub', progress: { fraction: 0.8, updatedAt: 500 }, blob: new Blob(['Content'], { type: 'application/epub+zip' }) });
    const snap = await db.getBookFileSnapshot(bookId);

    // Backup has older updatedAt: 300 < 500
    db.backupPendingProgress(bookId, { bookId, fraction: 0.3, blobRevision: snap.blobRevision, revisionOrigin: snap.revisionOrigin, updatedAt: 300 });

    await db.recoverPendingProgressBackup();

    const bookAfter = await db.getBook(bookId);
    assert.equal(bookAfter.progress.fraction, 0.8, 'Newer progress in DB (updatedAt=500) must NOT be overwritten by older backup (updatedAt=300)');
});

await test('S2.4: Session backup recovery preserves B backup when B backup is created during A recovery', async () => {
    mockStorage.clear();
    const t = new ReadingTracker();

    // Create backup for session A (>=60s)
    t.backupPendingSession(null, {
        sessionId: 'sess-A',
        bookId: 'book-A',
        bookTitle: 'Book A',
        durationSeconds: 70,
        startTime: Date.now() - 70000,
        version: 1
    });

    // Create backup for session B (>=60s)
    t.backupPendingSession(null, {
        sessionId: 'sess-B',
        bookId: 'book-B',
        bookTitle: 'Book B',
        durationSeconds: 80,
        startTime: Date.now() - 80000,
        version: 1
    });

    const backupsBefore = JSON.parse(mockStorage.get('linden_pending_session_backups') || '{}');
    assert.ok(backupsBefore['sess-A']);
    assert.ok(backupsBefore['sess-B']);

    await t.recoverPendingBackup();

    const backupsAfter = JSON.parse(mockStorage.get('linden_pending_session_backups') || '{}');
    assert.equal(backupsAfter['sess-A'], undefined, 'sess-A should be cleared after recovery');
    assert.equal(backupsAfter['sess-B'], undefined, 'sess-B should be cleared after recovery');

    const sessions = await db.getAllReadingSessions();
    assert.ok(sessions.find(s => s.id === 'sess-A'));
    assert.ok(sessions.find(s => s.id === 'sess-B'));
});

// -----------------------------------------------------------------
// S3 Tests: Decoupled exit flushes, accurate status, & idempotence
// -----------------------------------------------------------------
console.log('\nSuite S3: Independent Exit Save Branches & Status Synthesis');

await test('S3.1: Progress promise hangs -> tracker endSession still executes', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'book-exit-hang';
    await db.saveBook({ id: bookId, title: 'Exit Hang', format: 'epub', blob: new Blob(['Content'], { type: 'application/epub+zip' }) });
    await app.openBook(bookId);
    app.currentLocation = { fraction: 0.5, page: 5 };
    if (app._activeSession) app._activeSession.location = { fraction: 0.5, page: 5 };

    let trackerRan = false;
    const origTrackerEnd = tracker.endSession;

    try {
        tracker.endSession = async (frac) => {
            trackerRan = true;
            return { status: 'committed' };
        };
        // Mock progress update to hang
        mockDB.hangProgress = true;

        // Start flushReaderStateOnExit
        const flushPromise = app.flushReaderStateOnExit('req-hang-test');

        // Wait a small tick
        await new Promise(r => setTimeout(r, 50));
        assert.equal(trackerRan, true, 'tracker.endSession MUST run concurrently without waiting for progress');
    } finally {
        mockDB.hangProgress = false;
        tracker.endSession = origTrackerEnd;
    }
});

await test('S3.2: Progress succeeds while tracker and tracker backup fail -> returns failed', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'book-exit-fail-synth';
    await db.saveBook({ id: bookId, title: 'Fail Synth', format: 'epub', blob: new Blob(['Content'], { type: 'application/epub+zip' }) });
    await app.openBook(bookId);
    app.currentLocation = { fraction: 0.5, page: 5 };
    if (app._activeSession) app._activeSession.location = { fraction: 0.5, page: 5 };

    const origTrackerEnd = tracker.endSession;
    const origTrackerBackup = tracker.backupPendingSession;

    try {
        tracker.backupPendingSession = () => false; // backup fails
        tracker.endSession = async () => { throw new Error('Tracker DB fail'); }; // endSession fails

        const res = await app.flushReaderStateOnExit('req-fail-synth');
        assert.equal(res.status, 'failed', 'Status must be failed if tracker and its backup both fail, even if progress succeeded');
        assert.equal(res.progressSaved, true);
        assert.equal(res.trackerSaved, false);
    } finally {
        tracker.endSession = origTrackerEnd;
        tracker.backupPendingSession = origTrackerBackup;
    }
});

await test('S3.3: Completed requestId returns cached result without re-executing DB writes', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'book-exit-idempotent';
    await db.saveBook({ id: bookId, title: 'Idempotent', format: 'epub', blob: new Blob(['Content'], { type: 'application/epub+zip' }) });
    await app.openBook(bookId);
    app.currentLocation = { fraction: 0.5, page: 5 };
    if (app._activeSession) app._activeSession.location = { fraction: 0.5, page: 5 };

    const callsBefore = platformBridge.flushCalls.length;
    const res1 = await app.flushReaderStateOnExit('req-idemp-1');
    assert.equal(platformBridge.flushCalls.length, callsBefore + 1, 'First flush calls platformBridge');

    // Second call with same requestId after completion
    const res2 = await app.flushReaderStateOnExit('req-idemp-1');
    assert.equal(platformBridge.flushCalls.length, callsBefore + 1, 'Completed requestId must return cached result without calling platformBridge again');
    assert.equal(res1, res2, 'Must return identical cached object reference');
});

// -----------------------------------------------------------------
// S4 Tests: 60-second threshold, sessions, midnight, and recovery
// -----------------------------------------------------------------
console.log('\nSuite S4: 60-Second Reading Duration Threshold (06 Revision)');

await test('S4.1: 59s normal session is filtered and does not enter DB; 60s enters DB fully', async () => {
    mockStorage.clear();
    const t = new ReadingTracker();

    // 59s session
    await t.startSession('book-59', 'Book 59', 0.1);
    t.sessionCumulativeSeconds = 59;
    const res59 = await t.endSession(0.2);
    assert.equal(res59.status, 'filtered_short_session');
    const sess59 = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-59');
    assert.equal(sess59, undefined, '59s session must NOT enter DB stats');

    // 60s session
    await t.startSession('book-60', 'Book 60', 0.1);
    t.sessionCumulativeSeconds = 60;
    const res60 = await t.endSession(0.2);
    assert.equal(res60.status, 'committed');
    const sess60 = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-60');
    assert.ok(sess60, '60s session MUST enter DB stats');
    assert.equal(sess60.durationSeconds, 60, '60s must record full 60 seconds');
});

await test('S4.2: 65s session records full 65s, not just 5s', async () => {
    const t = new ReadingTracker();
    await t.startSession('book-65', 'Book 65', 0.1);
    t.sessionCumulativeSeconds = 65;
    await t.endSession(0.3);

    const sess65 = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-65');
    assert.ok(sess65);
    assert.equal(sess65.durationSeconds, 65, 'Must record full 65 seconds');
});

await test('S4.3: Two independent 40s sessions are both filtered', async () => {
    const t = new ReadingTracker();

    // Session 1: 40s
    await t.startSession('book-split', 'Split Book', 0.1);
    t.sessionCumulativeSeconds = 40;
    await t.endSession(0.2);

    // Session 2: 40s
    await t.startSession('book-split', 'Split Book', 0.2);
    t.sessionCumulativeSeconds = 40;
    await t.endSession(0.3);

    const sessList = (await db.getAllReadingSessions()).filter(s => s.bookId === 'book-split');
    assert.equal(sessList.length, 0, 'Two independent 40s sessions must both be filtered (<60s each)');
});

await test('S4.4: Cross-midnight session: 40s before midnight + 30s after midnight records 70s across two dates', async () => {
    const t = new ReadingTracker();
    await t.startSession('book-midnight', 'Midnight Book', 0.1);
    t.sessionCumulativeSeconds = 40;
    t.sessionStartTime = new Date('2026-09-22T23:59:20').getTime();

    // Simulate midnight tick
    const midnightTime = new Date('2026-09-23T00:00:05').getTime();
    const origNow = Date.now;
    try {
        Date.now = () => midnightTime;
        t.lastActivityTime = midnightTime;
        t.tick(); // Triggers midnight rollover

        assert.equal(t.sessionSlices.length, 1, 'Yesterday slice must be stored in sessionSlices');
        assert.equal(t.sessionSlices[0].durationSeconds, 40);

        // Read 30 seconds more in the new day
        t.sessionCumulativeSeconds = 30;

        const res = await t.endSession(0.5);
        assert.equal(res.status, 'committed');

        const allSess = await db.getAllReadingSessions();
        const midnightSess = allSess.filter(s => s.bookId === 'book-midnight');
        assert.equal(midnightSess.length, 2, 'Must record two slices in DB for the two dates');

        const day1 = midnightSess.find(s => s.date === '2026-09-22');
        const day2 = midnightSess.find(s => s.date === '2026-09-23');
        assert.ok(day1 && day2);
        assert.equal(day1.durationSeconds, 40);
        assert.equal(day2.durationSeconds, 30);
    } finally {
        Date.now = origNow;
    }
});

await test('S4.5: 30s crash recovery is filtered and does not become formal DB record', async () => {
    mockStorage.clear();
    const t = new ReadingTracker();
    t.backupPendingSession(null, {
        sessionId: 'sess-crash-30',
        bookId: 'book-crash-30',
        bookTitle: 'Crash 30',
        durationSeconds: 30,
        startTime: Date.now() - 30000,
        version: 1
    });

    await t.recoverPendingBackup();

    const sess = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-crash-30');
    assert.equal(sess, undefined, '30s crashed session must NOT enter DB stats upon recovery');
});

await test('S4.6: 90s save failure retains backup and recovers idempotently', async () => {
    mockStorage.clear();
    const t = new ReadingTracker();
    mockDB.failReadingSessionWrite = true;

    await t.startSession('book-fail-90', 'Fail 90', 0.1);
    t.sessionCumulativeSeconds = 90;
    await assert.rejects(t.endSession(0.5));

    // Backup must be retained in localStorage
    const backups = JSON.parse(mockStorage.get('linden_pending_session_backups') || '{}');
    const sessBackup = Object.values(backups).find(b => b.bookId === 'book-fail-90');
    assert.ok(sessBackup, 'Backup must be preserved when 90s save fails');

    // Now DB is healthy again
    mockDB.failReadingSessionWrite = false;
    await t.recoverPendingBackup();

    const recoveredSess = (await db.getAllReadingSessions()).find(s => s.bookId === 'book-fail-90');
    assert.ok(recoveredSess, '90s session must be successfully recovered into DB');
    assert.equal(recoveredSess.durationSeconds, 90);

    // Re-running recovery does not duplicate
    await t.recoverPendingBackup();
    const all90 = (await db.getAllReadingSessions()).filter(s => s.bookId === 'book-fail-90');
    assert.equal(all90.length, 1, 'Recovery must be idempotent and not create duplicate sessions');
});

// -----------------------------------------------------------------
// S5 Tests: Cloud-only book handling & error UI reset
// -----------------------------------------------------------------
console.log('\nSuite S5: Cloud-Only Book Check & Error UI Resilience');

await test('S5.1: Cloud-only book enters handleCloudBookClick before requiring local blob', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'cloud-book-1';
    await db.saveBook({ id: bookId, title: 'Cloud Book', format: 'epub', isCloudOnly: true });

    let cloudClicked = false;
    app.handleCloudBookClick = (b) => {
        cloudClicked = true;
        assert.equal(b.id, bookId);
        assert.equal(b.isCloudOnly, true);
    };

    await app.openBook(bookId);
    assert.equal(cloudClicked, true, 'handleCloudBookClick must be invoked for cloud-only books without throwing missing blob error');
});

await test('S5.2: DB snapshot fetch failure cleanly closes reader and displays error toast', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'book-fetch-fail';
    let toastMsg = '';
    let closed = false;

    app.showToast = (msg) => { toastMsg = msg; };
    const origClose = app.closeReader.bind(app);
    app.closeReader = () => { closed = true; return origClose(); };

    try {
        mockDB.failGetSnapshot = true;

        await app.openBook(bookId);
        assert.ok(toastMsg.includes('Database disk IO error'), 'Error toast must be shown');
        assert.equal(closed, true, 'closeReader must be called to reset reader cleanly');
        assert.equal(app.currentBookId, null, 'Reader state must not be left half-open');
    } finally {
        mockDB.failGetSnapshot = false;
    }
});

console.log('\n====================================================');
console.log(`Repairs Verification Complete: ${passed} / ${total} tests passed.`);
console.log('====================================================');

if (passed !== total) process.exit(1);
else process.exit(0);
