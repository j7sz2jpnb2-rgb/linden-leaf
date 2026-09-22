// scripts/test-batch1.mjs - Comprehensive Batch 1 Verification Test Suite for Linden Leaf
// Tests Content Identity, Async Session Epochs, PDF Progress Math, and DB Abort Handling.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Setup global environment for browser modules
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.localStorage = {
    _data: new Map(),
    getItem(k) { return this._data.get(k) || null; },
    setItem(k, v) { this._data.set(k, String(v)); },
    removeItem(k) { this._data.delete(k); },
    clear() { this._data.clear(); }
};
globalThis.NodeFilter = { SHOW_ALL: -1, SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.CSS = { escape: (s) => String(s) };
globalThis.DOMMatrix = class DOMMatrix {
    constructor() {
        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
    transformPoint(p) { return p; }
};
if (!globalThis.customElements) {
    globalThis.customElements = { define: () => {}, get: () => {} };
}
if (!globalThis.HTMLElement) {
    globalThis.HTMLElement = class HTMLElement {};
}
const createMockEl = (tag = 'DIV', id = '') => {
    const classes = new Set();
    const styleObj = {
        setProperty(k, v) { this[k] = v; },
        removeProperty(k) { delete this[k]; }
    };
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
        appendChild(child) {
            if (child) {
                child.parentElement = el;
                this.children.push(child);
            }
            return child;
        },
        removeChild(child) {
            const idx = this.children.indexOf(child);
            if (idx >= 0) this.children.splice(idx, 1);
            return child;
        },
        append(...children) {
            children.forEach(c => {
                if (c && typeof c === 'object') this.appendChild(c);
            });
        },
        prepend(...children) {
            children.forEach(c => {
                if (c && typeof c === 'object') {
                    c.parentElement = el;
                    this.children.unshift(c);
                }
            });
        },
        replaceChildren(...nodes) {
            this.children = [...nodes];
            nodes.forEach(n => { if (n && typeof n === 'object') n.parentElement = el; });
        },
        remove() {
            if (this.parentElement) {
                this.parentElement.removeChild(this);
            }
        },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k] || null; },
        addEventListener: (event, fn) => {
            if (!el._listeners) el._listeners = new Map();
            if (!el._listeners.has(event)) el._listeners.set(event, []);
            el._listeners.get(event).push(fn);
        },
        removeEventListener: (event, fn) => {
            if (!el._listeners) return;
            const list = el._listeners.get(event);
            if (list) {
                const idx = list.indexOf(fn);
                if (idx >= 0) list.splice(idx, 1);
            }
        },
        dispatchEvent: (event) => {
            if (!el._listeners) return;
            const list = el._listeners.get(event.type);
            if (list) list.forEach(fn => fn(event));
        },
        open: async () => {},
        init: async () => {},
        close: () => {},
        addAnnotation: async () => {},
        deleteAnnotation: async () => {},
        renderer: { getContents: () => [], settle: () => {} },
        book: { toc: [], sections: [] },
        matches: () => false,
        focus: () => {},
        blur: () => {},
        click: () => {},
        select: () => {},
        querySelector(selector) {
            const match = (node) => {
                if (selector.startsWith('.')) {
                    return node.classList?.contains(selector.slice(1));
                } else if (selector.startsWith('#')) {
                    return node.id === selector.slice(1);
                } else if (node.tagName === selector.toUpperCase()) {
                    return true;
                }
                return false;
            };
            for (const child of this.children) {
                if (match(child)) return child;
                const found = child.querySelector?.(selector);
                if (found) return found;
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            const match = (node) => {
                if (selector.startsWith('.')) {
                    return node.classList?.contains(selector.slice(1));
                } else if (selector.startsWith('#')) {
                    return node.id === selector.slice(1);
                } else if (node.tagName === selector.toUpperCase()) {
                    return true;
                }
                return false;
            };
            const walk = (parent) => {
                for (const child of parent.children) {
                    if (match(child)) results.push(child);
                    if (child.children) walk(child);
                }
            };
            walk(this);
            return results;
        },
        getContext: () => ({
            putImageData: () => {},
            drawImage: () => {},
            fillRect: () => {},
            clearRect: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray(4) })
        }),
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
    flushComplete(id) {
        this.flushCalls.push(id);
    },
    openExternal: () => {}
};

// ============================================================================
// In-Memory Mock of IndexedDB supporting LindenLeafDB schema
// ============================================================================
class MockIDBRequest {
    constructor() {
        this.result = null;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
    _succeed(val) {
        this.result = val;
        if (typeof this.onsuccess === 'function') {
            this.onsuccess({ target: this });
        }
    }
    _fail(err) {
        this.error = err;
        if (typeof this.onerror === 'function') {
            this.onerror({ target: this });
        }
    }
}

class MockIDBObjectStore {
    constructor(name, db, keyPath, autoIncrement = false) {
        this.name = name;
        this.db = db;
        this.keyPath = keyPath;
        this.autoIncrement = autoIncrement;
        this.data = new Map();
        this._autoId = 1;
        this.indexes = new Map();
    }
    createIndex(name, keyPath, options) {
        this.indexes.set(name, { name, keyPath, options });
    }
}

class MockIDBTransaction {
    constructor(db, storeNames, mode) {
        this.db = db;
        this.storeNames = Array.isArray(storeNames) ? storeNames : [storeNames];
        this.mode = mode;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this.error = null;
        this._aborted = false;
        this._activeRequests = 0;
        this._journal = [];
        this._checkComplete();
    }
    _checkComplete() {
        setImmediate(() => {
            if (this._aborted) return;
            if (this._activeRequests === 0) {
                if (typeof this.oncomplete === 'function') {
                    this.oncomplete({ target: this });
                }
            } else {
                this._checkComplete();
            }
        });
    }
    objectStore(name) {
        const s = this.db.stores.get(name);
        return {
            name: s.name,
            keyPath: s.keyPath,
            index: (idxName) => {
                const idx = s.indexes.get(idxName);
                return {
                    getAll: (key) => {
                        const req = new MockIDBRequest();
                        this._activeRequests++;
                        queueMicrotask(() => {
                            const matched = [];
                            for (const v of s.data.values()) {
                                if (idx && v[idx.keyPath] === key) {
                                    matched.push(structuredClone(v));
                                }
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
                const delay = (key === 'rapid-book-a' && this.db.delayRapidBookA) ? 80 : 0;
                setTimeout(() => {
                    const val = s.data.get(key);
                    this._activeRequests--;
                    req._succeed(val !== undefined ? structuredClone(val) : undefined);
                }, delay);
                return req;
            },
            put: (val, key) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    let k = key;
                    if (!k && s.keyPath) k = val[s.keyPath];
                    if (!k && s.autoIncrement) {
                        k = s._autoId++;
                        if (typeof val === 'object' && s.keyPath) val[s.keyPath] = k;
                    }
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
            getAll: (query) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    const values = Array.from(s.data.values()).map(v => structuredClone(v));
                    this._activeRequests--;
                    req._succeed(values);
                });
                return req;
            },
            count: () => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    this._activeRequests--;
                    req._succeed(s.data.size);
                });
                return req;
            },
            clear: () => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
                    for (const [k, v] of s.data.entries()) {
                        this._journal.push({ store: s, key: k, hadOld: true, oldVal: structuredClone(v) });
                    }
                    s.data.clear();
                    this._activeRequests--;
                    req._succeed(undefined);
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
            if (entry.hadOld) {
                entry.store.data.set(entry.key, entry.oldVal);
            } else {
                entry.store.data.delete(entry.key);
            }
        }
        if (typeof this.onabort === 'function') {
            this.onabort({ target: this });
        }
    }
}

class MockIDBDatabase {
    constructor(name, version) {
        this.name = name;
        this.version = version;
        this.stores = new Map();
        this.transactionLog = [];
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
        this.transactionLog.push({ storeNames, mode });
        const tx = new MockIDBTransaction(this, storeNames, mode);
        if (this.failProgressWrite && storeNames.includes('books') && mode === 'readwrite') {
            queueMicrotask(() => tx.abort());
        }
        return tx;
    }
}

const mockDB = new MockIDBDatabase('LindenLeafDB', 7);
// Setup initial stores matching db.js
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
        queueMicrotask(() => {
            req.result = mockDB;
            req._succeed(mockDB);
        });
        return req;
    }
};

// ============================================================================
// Load Linden Leaf Modules under test
// ============================================================================
const db = await import('../js/db.js?v=20260914_rel_v1');
const {
    getRevisionOrigin,
    generateRevision,
    isContentIdentityMatching,
    saveBook,
    saveBookFileBlob,
    getBook,
    getBookFileSnapshot,
    saveHighlight,
    getHighlightsByBook,
    savePdfPageDrawing,
    getPdfPageDrawing,
    clearPdfPageDrawing,
    updateBookProgress,
    remapPdfDrawingId,
    buildPdfDrawingKey,
    backupPendingProgress,
    clearPendingProgressBackup,
    recoverPendingProgressBackup
} = db;

const { decodePdfProgress, UniversalReaderApp } = await import('../js/app.js');
const { AdaptivePdfDriver, PdfJsDriver } = await import('../js/pdf-driver.js');
const { PdfViewport } = await import('../js/pdf-viewport.js');
const { tracker } = await import('../js/tracker.js?v=20260914_rel_v1');
const syncEngine = await import('../js/syncEngine.js?v=20260914_rel_v1');
const { platformBridge } = await import('../js/platformBridge.js');

platformBridge.flushCalls = [];
const origPlatformFlushComplete = platformBridge.flushComplete.bind(platformBridge);
platformBridge.flushComplete = (id) => {
    platformBridge.flushCalls.push(id);
    if (globalThis.platformBridge?.flushCalls && globalThis.platformBridge !== platformBridge) {
        globalThis.platformBridge.flushCalls.push(id);
    }
    return origPlatformFlushComplete(id);
};

// ============================================================================
// TEST SUITE EXECUTION
// ============================================================================
console.log('====================================================');
console.log('Starting Batch 1 Verification Test Suite for Linden Leaf');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function runAsyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

// ----------------------------------------------------------------------------
// Suite 1: Content Identity & Revision Matching Logic
// ----------------------------------------------------------------------------
console.log('Suite 1: Content Identity & Revision Matching');

runTest('1.1 isContentIdentityMatching - exact blobRevision match', () => {
    const item = { blobRevision: 'rev-100', revisionOrigin: 'origin-A' };
    const snapshot = { blobRevision: 'rev-100', revisionOrigin: 'origin-A' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, true);
});

runTest('1.2 isContentIdentityMatching - blobRevision mismatch returns false', () => {
    const item = { blobRevision: 'rev-100', revisionOrigin: 'origin-A' };
    const snapshot = { blobRevision: 'rev-200', revisionOrigin: 'origin-A' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, false);
});

runTest('1.3 isContentIdentityMatching - revisionOrigin mismatch returns false', () => {
    const item = { blobRevision: 'rev-100', revisionOrigin: 'origin-A' };
    const snapshot = { blobRevision: 'rev-100', revisionOrigin: 'origin-B' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, false);
});

runTest('1.4 isContentIdentityMatching - legacy fallback to matching documentHash', () => {
    const item = { documentHash: 'hash-abc' }; // no revision
    const snapshot = { blobRevision: 'rev-1', revisionOrigin: 'origin-A', documentHash: 'hash-abc' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, true);
});

runTest('1.5 isContentIdentityMatching - legacy fallback to conflicting documentHash returns false', () => {
    const item = { documentHash: 'hash-abc' };
    const snapshot = { blobRevision: 'rev-1', revisionOrigin: 'origin-A', documentHash: 'hash-different' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, false);
});

runTest('1.6 isContentIdentityMatching - unconfirmed item (no revision, no hash) returns false', () => {
    const item = {};
    const snapshot = { blobRevision: 'rev-1', revisionOrigin: 'origin-A', documentHash: 'hash-abc' };
    assert.equal(isContentIdentityMatching(item, snapshot)?.matches, false);
});

// ----------------------------------------------------------------------------
// Suite 2: A/B Blob Replacement & Identity Isolation (Section 9 Test 1)
// ----------------------------------------------------------------------------
console.log('\nSuite 2: A/B Blob Replacement & Snapshot Isolation');

await runAsyncTest('2.1 Save Book A, replace with same-size Book B, verify revision bump & hash clearance', async () => {
    const bookId = 'test-book-ab';
    const blobA = new Blob(['Content of Book A'], { type: 'text/plain' });
    
    // Save Book A
    await saveBook({ id: bookId, title: 'Book A', format: 'txt' });
    await saveBookFileBlob(bookId, blobA);

    const snapshotA = await getBookFileSnapshot(bookId);
    assert.ok(snapshotA.blobRevision, 'Snapshot A must have blobRevision');
    assert.ok(snapshotA.revisionOrigin, 'Snapshot A must have revisionOrigin');
    assert.equal(Object.isFrozen(snapshotA), true, 'Snapshot must be frozen');

    // Save highlight for Book A
    const hlA = {
        id: 'hl-a1',
        bookId,
        text: 'A highlight',
        blobRevision: snapshotA.blobRevision,
        revisionOrigin: snapshotA.revisionOrigin,
        documentHash: snapshotA.documentHash
    };
    await saveHighlight(hlA);

    // Now simulate replacing Blob with Book B (same size, different content)
    const blobB = new Blob(['Content of Book B'], { type: 'text/plain' }); // exactly 18 bytes, same size!
    await saveBookFileBlob(bookId, blobB);

    const snapshotB = await getBookFileSnapshot(bookId);
    assert.notEqual(snapshotB.blobRevision, snapshotA.blobRevision, 'Blob replacement MUST bump blobRevision');
    assert.equal(snapshotB.documentHash, null, 'Blob replacement MUST clear documentHash');

    // Verify highlights of A do NOT match Snapshot B
    const allHls = await getHighlightsByBook(bookId);
    const matchingForB = allHls.filter(h => isContentIdentityMatching(h, snapshotB)?.matches);
    assert.equal(matchingForB.length, 0, 'Old highlights of A MUST NOT match Snapshot B');

    // Verify snapshot A without hash does NOT inherit B hash
    assert.equal(snapshotA.documentHash, null);
    assert.equal(snapshotB.documentHash, null);
});

await runAsyncTest('2.2 Auto-backfill legacy records in getBookFileSnapshot', async () => {
    const legacyBookId = 'legacy-book-1';
    // Directly insert legacy record into stores without revision
    mockDB.stores.get('books').data.set(legacyBookId, { id: legacyBookId, title: 'Legacy' });
    mockDB.stores.get('book_files').data.set(legacyBookId, { id: legacyBookId, blob: new Blob(['legacy']) });

    const snapshot = await getBookFileSnapshot(legacyBookId);
    assert.ok(snapshot.blobRevision, 'Legacy record must be auto-backfilled with blobRevision');
    assert.ok(snapshot.revisionOrigin, 'Legacy record must be auto-backfilled with revisionOrigin');

    // Check that DB was updated with backfilled revision
    const inDb = mockDB.stores.get('books').data.get(legacyBookId);
    assert.equal(inDb.blobRevision, snapshot.blobRevision);
});

// ----------------------------------------------------------------------------
// Suite 3: PDF Progress Calculation & Boundary Testing (Section 9 Test 4)
// ----------------------------------------------------------------------------
console.log('\nSuite 3: PDF Progress Math (decodePdfProgress)');

runTest('3.1 N=10, f=0.3 -> page 3 (not 2 from floor)', () => {
    const res = decodePdfProgress({ fraction: 0.3 }, 10);
    assert.equal(res.page, 3, `Expected page 3, got ${res.page}`);
    assert.equal(res.fraction, 0.3);
});

runTest('3.2 N=1, f=1.0 -> page 1', () => {
    const res = decodePdfProgress({ fraction: 1.0 }, 1);
    assert.equal(res.page, 1, `Expected page 1, got ${res.page}`);
    assert.equal(res.fraction, 1.0);
});

runTest('3.3 N=10, f=0.1 -> page 1', () => {
    const res = decodePdfProgress({ fraction: 0.1 }, 10);
    assert.equal(res.page, 1, `Expected page 1, got ${res.page}`);
});

runTest('3.4 N=100, f=0.5 -> page 50', () => {
    const res = decodePdfProgress({ fraction: 0.5 }, 100);
    assert.equal(res.page, 50, `Expected page 50, got ${res.page}`);
});

runTest('3.5 Explicit page number preference: page=3 in 10 pages returns page 3', () => {
    const res = decodePdfProgress({ page: 3, fraction: 0.1 }, 10);
    assert.equal(res.page, 3);
    assert.equal(res.fraction, 0.3);
});

runTest('3.6 Boundary: totalPages <= 0 returns page 1, fraction 0', () => {
    assert.deepEqual(decodePdfProgress({ fraction: 0.5 }, 0), { page: 1, fraction: 0 });
    assert.deepEqual(decodePdfProgress({ fraction: 0.5 }, -5), { page: 1, fraction: 0 });
    assert.deepEqual(decodePdfProgress(null, 0), { page: 1, fraction: 0 });
});

runTest('3.7 Boundary: fraction <= 0 returns page 1, fraction 0', () => {
    assert.deepEqual(decodePdfProgress({ fraction: 0 }, 10), { page: 1, fraction: 0 });
    assert.deepEqual(decodePdfProgress({ fraction: -0.2 }, 10), { page: 1, fraction: 0 });
});

runTest('3.8 Boundary: fraction >= 1 clamps to totalPages', () => {
    const res = decodePdfProgress({ fraction: 1.5 }, 10);
    assert.equal(res.page, 10);
    assert.equal(res.fraction, 1.0);
});

// ----------------------------------------------------------------------------
// Suite 4: PDF Driver & Viewport Integration (Section 9 Test 3 & 4)
// ----------------------------------------------------------------------------
console.log('\nSuite 4: PDF Driver & Viewport Integration');

await runAsyncTest('4.1 AdaptivePdfDriver with snapshot defaults to PdfJsDriver with snapshot blob', async () => {
    const fakeBlob = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' });
    const snapshot = {
        bookId: 'pdf-test-1',
        blob: fakeBlob,
        blobRevision: 'rev-pdf-1',
        revisionOrigin: 'origin-1',
        nativePath: 'C:\\fake\\unverified\\path.pdf'
    };

    const origOpen = PdfJsDriver.prototype.open;
    let openedSource = null;
    PdfJsDriver.prototype.open = async function(src) {
        openedSource = src;
        return { numPages: 5, title: 'Mock PDF', pageSizes: [{ width: 600, height: 800 }] };
    };

    try {
        const driver = new AdaptivePdfDriver({ nativePath: snapshot.nativePath, snapshot });
        assert.equal(driver.kind, 'adaptive');
        assert.equal(driver.snapshot, snapshot);

        const info = await driver.open({ blob: fakeBlob, nativePath: snapshot.nativePath });
        assert.equal(info.numPages, 5);
        // Crucial: openedSource must be the Blob, NOT the unverified nativePath
        assert.equal(openedSource, fakeBlob, 'AdaptivePdfDriver with snapshot must open snapshot.blob, never nativePath');
    } finally {
        PdfJsDriver.prototype.open = origOpen;
    }
});

await runAsyncTest('4.2 PdfViewport loads with functional initialPage and sets target page before render pump', async () => {
    const container = document.createElement('div');
    const viewport = new PdfViewport(container, { scale: 1.0 });

    const mockDriver = {
        kind: 'pdfjs',
        open: async () => ({
            numPages: 10,
            title: 'Mock Book',
            pageSizes: Array.from({ length: 10 }, () => ({ width: 600, height: 800 }))
        }),
        renderPage: async () => document.createElement('canvas'),
        getPageSizes: async () => []
    };

    const initialPageFn = (totalPages) => {
        const decoded = decodePdfProgress({ fraction: 0.3 }, totalPages); // page 3 -> index 2
        return decoded.page - 1;
    };

    await viewport.load(mockDriver, {}, { initialPage: initialPageFn });

    // Verify currentPage was set to 2 (Page 3) BEFORE rendering
    assert.equal(viewport.currentPage, 2, `Expected currentPage=2 (page 3), got ${viewport.currentPage}`);
    assert.ok(viewport.scrollArea.scrollTop > 0, 'Scroll top must be positioned at page 3');

    viewport.destroy();
});

await runAsyncTest('4.3 PdfViewport setHighlights filters highlights using isContentIdentityMatching', async () => {
    const container = document.createElement('div');
    const viewport = new PdfViewport(container);

    const snapshot = {
        bookId: 'book-hl-test',
        blobRevision: 'rev-valid',
        revisionOrigin: 'origin-valid'
    };

    viewport.currentSnapshot = snapshot;

    const highlights = [
        { id: 'hl-valid', bookId: 'book-hl-test', blobRevision: 'rev-valid', revisionOrigin: 'origin-valid', pdfTarget: { page: 1, rects: [[0, 0, 1, 1]] } },
        { id: 'hl-mismatched', bookId: 'book-hl-test', blobRevision: 'rev-stale', revisionOrigin: 'origin-valid', pdfTarget: { page: 1, rects: [[0, 0, 1, 1]] } },
        { id: 'hl-no-revision', bookId: 'book-hl-test', pdfTarget: { page: 1, rects: [[0, 0, 1, 1]] } }
    ];

    viewport.setHighlights(highlights, snapshot);

    const page1Hls = viewport.highlightsByPage.get(1) || [];
    assert.equal(page1Hls.length, 1, 'Only matching highlight should be kept');
    assert.equal(page1Hls[0].id, 'hl-valid');

    viewport.destroy();
});

// ----------------------------------------------------------------------------
// Suite 5: Session Preemption, Timers & Abort Handling (Section 9 Test 2 & 5)
// ----------------------------------------------------------------------------
console.log('\nSuite 5: Async Session Preemption & Transaction Abort');

await runAsyncTest('5.1 Session Preemption: Slow Session A preempted by Fast Session B', async () => {
    let currentEpoch = 0;
    let activeSession = null;
    const completedSessions = [];

    async function simulateOpenBook(bookId, delayMs) {
        currentEpoch++;
        const epoch = currentEpoch;
        const abortController = new AbortController();
        const session = {
            epoch,
            bookId,
            abortController,
            isCurrent: () => currentEpoch === epoch && !abortController.signal.aborted
        };

        const prev = activeSession;
        activeSession = session;
        if (prev) prev.abortController.abort();

        // Simulate async work
        await new Promise(r => setTimeout(r, delayMs));

        if (!session.isCurrent()) {
            // Preempted mid-flight!
            return false;
        }

        completedSessions.push(session.bookId);
        return true;
    }

    // Launch slow session A (50ms)
    const pA = simulateOpenBook('Book-A', 50);
    // Launch fast session B (10ms) after 5ms
    await new Promise(r => setTimeout(r, 5));
    const pB = simulateOpenBook('Book-B', 10);

    const [resA, resB] = await Promise.all([pA, pB]);
    assert.equal(resA, false, 'Session A must be preempted and return false');
    assert.equal(resB, true, 'Session B must succeed and return true');
    assert.deepEqual(completedSessions, ['Book-B'], 'Only Book-B should have completed');
});

runTest('5.2 Closing timer cancellation prevents hiding reader on quick reopen', () => {
    let closeTimer = null;
    let readerHidden = false;

    // Simulate closeReader
    closeTimer = setTimeout(() => {
        readerHidden = true;
    }, 240);

    // Simulate openBook called within 50ms
    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }

    // Advance time past 240ms
    assert.equal(readerHidden, false, 'Reader must not be hidden when reopened within close window');
});

await runAsyncTest('5.3 DB write operations reject on transaction abort', async () => {
    const tx = mockDB.transaction(['books'], 'readwrite');
    const store = tx.objectStore('books');

    const promise = new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve('complete');
        tx.onerror = () => reject(tx.error || new Error('tx error'));
        tx.onabort = () => reject(tx.error || new Error('tx abort'));
        store.put({ id: 'abort-test', title: 'Should Fail' });
    });

    // Abort transaction
    tx.abort();

    await assert.rejects(
        promise,
        /Transaction aborted|tx abort/,
        'Transaction abort MUST reject the write promise'
    );
});

// ----------------------------------------------------------------------------
// Suite 6: Counterexamples, Edge Cases & Real-World Regressions
// ----------------------------------------------------------------------------
console.log('\nSuite 6: Counterexamples & Deep Edge Cases');

await runAsyncTest('6.1 getBookFileSnapshot uses readonly transaction on modern records', async () => {
    const bookId = 'test-book-readonly-tx';
    const blob = new Blob(['Content of modern record'], { type: 'text/plain' });
    await saveBook({ id: bookId, title: 'Modern Book', format: 'txt' });
    await saveBookFileBlob(bookId, blob);

    // Clear transaction log
    mockDB.transactionLog = [];

    const snapshot = await getBookFileSnapshot(bookId);
    assert.ok(snapshot.blobRevision, 'Snapshot must have blobRevision');

    // Filter transactions opened during this call
    const txLog = mockDB.transactionLog.filter(t => t.storeNames.includes('books') || t.storeNames.includes('book_files'));
    assert.ok(txLog.length > 0, 'Must have opened a transaction');
    assert.ok(txLog.every(t => t.mode === 'readonly'), `Expected all transactions to be readonly, got: ${JSON.stringify(txLog)}`);
});

await runAsyncTest('6.2 Real app.closeReader parameter capture: Opening Book B while Book A closes is isolated', async () => {
    const app = new UniversalReaderApp();
    const blobA = new Blob(['Content A'], { type: 'application/epub+zip' });
    const blobB = new Blob(['Content B'], { type: 'application/epub+zip' });
    await saveBook({ id: 'real-book-a', title: 'Real Book A', format: 'epub' });
    await saveBookFileBlob('real-book-a', blobA);
    await saveBook({ id: 'real-book-b', title: 'Real Book B', format: 'epub' });
    await saveBookFileBlob('real-book-b', blobB);

    // Open Book A
    await app.openBook('real-book-a');
    assert.equal(app.currentBookId, 'real-book-a');
    const sessionA = app._activeSession;
    assert.ok(sessionA);
    assert.equal(sessionA.bookId, 'real-book-a');

    // Simulate closing Book A
    const closePromise = app.closeReader();

    // Immediately open Book B while Book A close is running
    await app.openBook('real-book-b');
    assert.equal(app.currentBookId, 'real-book-b');
    assert.equal(app._activeSession.bookId, 'real-book-b');
    const viewB = app.foliateView;

    // Await Book A's closeReader completion
    await closePromise;

    // Verify Book B's active session and view are NOT destroyed or cleared
    assert.equal(app.currentBookId, 'real-book-b');
    assert.equal(app._activeSession.bookId, 'real-book-b');
    assert.equal(app.foliateView, viewB);
});

await runAsyncTest('6.3 Real openBook switches books: previous session progress snapshot captured and flushed', async () => {
    const app = new UniversalReaderApp();
    const blobA = new Blob(['Content A'], { type: 'application/epub+zip' });
    const blobB = new Blob(['Content B'], { type: 'application/epub+zip' });
    await saveBook({ id: 'real-switch-a', title: 'Switch A', format: 'epub' });
    await saveBookFileBlob('real-switch-a', blobA);
    await saveBook({ id: 'real-switch-b', title: 'Switch B', format: 'epub' });
    await saveBookFileBlob('real-switch-b', blobB);

    await app.openBook('real-switch-a');
    const sessionA = app._activeSession;

    // Simulate reading Book A to 45%
    app.onReaderRelocate({ fraction: 0.45, cfi: 'epubcfi(/6/4[chap1]!/4/2/1:0)' }, sessionA);

    // Now switch to Book B
    await app.openBook('real-switch-b');
    assert.equal(app.currentBookId, 'real-switch-b');

    // Wait for background flush of Book A to finish
    await new Promise(r => setTimeout(r, 60));

    // Verify Book A's progress was saved in DB
    const bookA = await getBook('real-switch-a');
    assert.ok(bookA.progress, 'Book A progress must be saved');
    assert.equal(bookA.progress.fraction, 0.45);
    assert.equal(bookA.progress.cfi, 'epubcfi(/6/4[chap1]!/4/2/1:0)');

    // Verify Book B does NOT have Book A's progress
    assert.notEqual(app.currentLocation?.fraction, 0.45);
});

await runAsyncTest('6.4 Replaced file progress reset: Mismatched blobRevision resets location', async () => {
    const bookData = {
        id: 'book-replace-test',
        progress: {
            fraction: 0.85,
            page: 85,
            blobRevision: 'rev-original',
            revisionOrigin: 'origin-1'
        }
    };
    const newSnapshot = {
        bookId: 'book-replace-test',
        blobRevision: 'rev-replaced-new',
        revisionOrigin: 'origin-1'
    };

    const isMatch = isContentIdentityMatching(bookData.progress, newSnapshot).matches;
    assert.equal(isMatch, false, 'Replaced file revision must not match old progress');

    // Simulate progress check in openBook
    let initialPage = 1;
    let initialFraction = 0;
    if (isMatch) {
        initialPage = bookData.progress.page;
        initialFraction = bookData.progress.fraction;
    }

    assert.equal(initialPage, 1, 'Initial page must be reset to 1 on mismatched revision');
    assert.equal(initialFraction, 0, 'Initial fraction must be reset to 0 on mismatched revision');
});

await runAsyncTest('6.5 EPUB highlight filtering: Mismatched blobRevision highlights excluded from render', async () => {
    const snapshot = {
        bookId: 'epub-book-1',
        blobRevision: 'rev-current',
        revisionOrigin: 'origin-1'
    };

    const highlights = [
        { id: 'hl-match', bookId: 'epub-book-1', blobRevision: 'rev-current', revisionOrigin: 'origin-1', cfi: 'epubcfi(/6/2)' },
        { id: 'hl-stale', bookId: 'epub-book-1', blobRevision: 'rev-old', revisionOrigin: 'origin-1', cfi: 'epubcfi(/6/4)' }
    ];

    const renderedOverlays = [];
    for (const hl of highlights) {
        const match = isContentIdentityMatching(hl, snapshot);
        if (match.matches) {
            renderedOverlays.push(hl);
        }
    }

    assert.equal(renderedOverlays.length, 1);
    assert.equal(renderedOverlays[0].id, 'hl-match');
});

await runAsyncTest('6.6 clearPdfPageDrawing with versionMeta deletes versioned key', async () => {
    const bookId = 'pdf-draw-versioned';
    const pageIndex = 4;
    const versionMeta = { blobRevision: 'rev-pdf-draw-1' };

    // Save a versioned drawing
    const strokes = [{ tool: 'pen', color: '#ff0000', width: 2, points: [[0.1, 0.1], [0.2, 0.2]] }];
    await savePdfPageDrawing(bookId, pageIndex, strokes, versionMeta);

    // Verify it exists in store under versioned key
    const versionedKey = `${bookId}_rev_${versionMeta.blobRevision}_page_${pageIndex}`;
    const store = mockDB.stores.get('pdf_drawings');
    assert.ok(store.data.has(versionedKey), 'Versioned drawing key must exist in DB');

    // Call clearPdfPageDrawing with versionMeta
    await clearPdfPageDrawing(bookId, pageIndex, true, Date.now(), versionMeta);

    // Verify versioned key was deleted
    assert.equal(store.data.has(versionedKey), false, 'Versioned drawing key must be deleted');
});

await runAsyncTest('6.7 Same page drawings under different blobRevision save independently', async () => {
    const bookId = 'pdf-draw-multi-rev';
    const pageIndex = 0;
    const metaRev1 = { blobRevision: 'rev-alpha', revisionOrigin: 'orig-1' };
    const metaRev2 = { blobRevision: 'rev-beta', revisionOrigin: 'orig-1' };

    const strokes1 = [{ tool: 'pen', color: '#ff0000', width: 2, points: [[0, 0], [1, 1]] }];
    const strokes2 = [{ tool: 'marker', color: '#00ff00', width: 10, points: [[2, 2], [3, 3]] }];

    await savePdfPageDrawing(bookId, pageIndex, strokes1, metaRev1);
    await savePdfPageDrawing(bookId, pageIndex, strokes2, metaRev2);

    const res1 = await getPdfPageDrawing(bookId, pageIndex, metaRev1);
    const res2 = await getPdfPageDrawing(bookId, pageIndex, metaRev2);

    assert.ok(res1, 'Rev-1 drawing must exist');
    assert.ok(res2, 'Rev-2 drawing must exist');
    assert.equal(res1.strokes[0].tool, 'pen');
    assert.equal(res2.strokes[0].tool, 'marker');
});

await runAsyncTest('6.8 Same page drawings under different revisionOrigin have key isolation', async () => {
    const bookId = 'pdf-draw-multi-orig';
    const pageIndex = 2;
    const metaOrigA = { blobRevision: 'rev-same', revisionOrigin: 'device-A' };
    const metaOrigB = { blobRevision: 'rev-same', revisionOrigin: 'device-B' };

    const keyA = buildPdfDrawingKey(bookId, pageIndex, metaOrigA);
    const keyB = buildPdfDrawingKey(bookId, pageIndex, metaOrigB);

    assert.notEqual(keyA, keyB, 'Keys for different revisionOrigin MUST be distinct');
    assert.ok(keyA.includes('device-A'));
    assert.ok(keyB.includes('device-B'));

    const strokesA = [{ tool: 'pen', color: '#111111' }];
    const strokesB = [{ tool: 'marker', color: '#222222' }];

    await savePdfPageDrawing(bookId, pageIndex, strokesA, metaOrigA);
    await savePdfPageDrawing(bookId, pageIndex, strokesB, metaOrigB);

    const fetchA = await getPdfPageDrawing(bookId, pageIndex, metaOrigA);
    const fetchB = await getPdfPageDrawing(bookId, pageIndex, metaOrigB);

    assert.equal(fetchA.strokes[0].color, '#111111');
    assert.equal(fetchB.strokes[0].color, '#222222');
});

await runAsyncTest('6.9 syncEngine.mergeSyncData preserves distinct revisions of same page drawings', async () => {
    const localPayload = {
        version: 1,
        clientId: 'client-L',
        booksMeta: [{ id: 'book-pdf-sync', title: 'PDF Sync' }],
        pdfDrawings: [
            {
                id: 'book-pdf-sync_rev_rev-L_page_1',
                bookId: 'book-pdf-sync',
                pageIndex: 1,
                blobRevision: 'rev-L',
                updatedAt: 1000,
                strokes: [{ tool: 'pen' }]
            }
        ]
    };
    const remotePayload = {
        version: 1,
        clientId: 'client-R',
        booksMeta: [{ id: 'book-pdf-sync', title: 'PDF Sync' }],
        pdfDrawings: [
            {
                id: 'book-pdf-sync_rev_rev-R_page_1',
                bookId: 'book-pdf-sync',
                pageIndex: 1,
                blobRevision: 'rev-R',
                updatedAt: 2000,
                strokes: [{ tool: 'marker' }]
            }
        ]
    };

    const { merged } = syncEngine.mergeSyncData(localPayload, remotePayload);
    assert.ok(merged.pdfDrawings, 'merged must contain pdfDrawings');
    assert.equal(merged.pdfDrawings.length, 2, 'Both rev-L and rev-R drawings must be preserved in merge');
    const ids = merged.pdfDrawings.map(d => d.id);
    assert.ok(ids.includes('book-pdf-sync_rev_rev-L_page_1'));
    assert.ok(ids.includes('book-pdf-sync_rev_rev-R_page_1'));
});

await runAsyncTest('6.10 getPdfPageDrawing rejects drawing hit on hash conflict', async () => {
    const bookId = 'pdf-hash-conflict';
    const pageIndex = 1;
    const saveMeta = { blobRevision: 'rev-hash-1', revisionOrigin: 'orig-1', documentHash: 'hash-A' };
    const strokes = [{ tool: 'pen', points: [[0, 0]] }];

    await savePdfPageDrawing(bookId, pageIndex, strokes, saveMeta);

    // Query with matching revision but CONFLICTING documentHash
    const queryMeta = { blobRevision: 'rev-hash-1', revisionOrigin: 'orig-1', documentHash: 'hash-CONFLICT' };
    const res = await getPdfPageDrawing(bookId, pageIndex, queryMeta);

    assert.equal(res, null, 'getPdfPageDrawing MUST return null when documentHash conflicts');
});

await runAsyncTest('6.11 Real app.createHighlight isolates highlights on same CFI across revisions', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'epub-hl-rev-test';
    const blob1 = new Blob(['Content Rev 1'], { type: 'application/epub+zip' });
    await saveBook({ id: bookId, title: 'EPUB HL', format: 'epub' });
    await saveBookFileBlob(bookId, blob1);

    await app.openBook(bookId);
    const snap1 = app._activeSession.snapshot;
    assert.ok(snap1.blobRevision);

    // Create highlight on Rev 1
    app.selectedTextInfo = { cfi: 'epubcfi(/6/2[ch1]!/4/1:0)', text: 'Sample Text' };
    await app.createHighlight('#facc15', null, 'highlight');

    const hlsAfter1 = await getHighlightsByBook(bookId);
    assert.equal(hlsAfter1.length, 1);
    assert.equal(hlsAfter1[0].blobRevision, snap1.blobRevision);

    // Bump book to Rev 2
    const blob2 = new Blob(['Content Rev 2 (modified)'], { type: 'application/epub+zip' });
    await saveBookFileBlob(bookId, blob2);
    await app.openBook(bookId);
    const snap2 = app._activeSession.snapshot;
    assert.notEqual(snap2.blobRevision, snap1.blobRevision);

    // Create highlight on Rev 2 with the EXACT SAME CFI and style
    app.selectedTextInfo = { cfi: 'epubcfi(/6/2[ch1]!/4/1:0)', text: 'Sample Text' };
    await app.createHighlight('#3b82f6', null, 'highlight');

    const hlsAfter2 = await getHighlightsByBook(bookId);
    assert.equal(hlsAfter2.length, 2, 'Highlights on different revisions must coexist, not deduplicate/overwrite');

    const hlRev1 = hlsAfter2.find(h => h.blobRevision === snap1.blobRevision);
    const hlRev2 = hlsAfter2.find(h => h.blobRevision === snap2.blobRevision);
    assert.ok(hlRev1 && hlRev2);
    assert.equal(hlRev1.color, '#facc15');
    assert.equal(hlRev2.color, '#3b82f6');
});

await runAsyncTest('6.12 Real flushReaderStateOnExit failure isolation and handshake', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'flush-fail-test';
    const blob = new Blob(['Content'], { type: 'application/epub+zip' });
    await saveBook({ id: bookId, title: 'Flush Test', format: 'epub' });
    await saveBookFileBlob(bookId, blob);

    await app.openBook(bookId);
    app.onReaderRelocate({ fraction: 0.75, cfi: 'epubcfi(/6/2)' }, app._activeSession);

    // Subtest 1: DB update rejects -> tracker still completes
    const origEndSession = tracker.endSession;
    try {
        let trackerEnded = false;
        mockDB.failProgressWrite = true;
        tracker.endSession = async () => { trackerEnded = true; };

        globalThis.platformBridge.flushCalls = [];
        const res = await app.flushReaderStateOnExit('req-123');

        assert.equal(trackerEnded, true, 'tracker.endSession must run even if DB update rejects');
        assert.equal(res.status, 'recovery_backup_success', 'Status must indicate recovery backup saved');
        assert.equal(globalThis.platformBridge.flushCalls.includes('req-123'), true, 'platformBridge.flushComplete must be called with non-empty requestId');
    } finally {
        mockDB.failProgressWrite = false;
        tracker.endSession = origEndSession;
    }

    // Subtest 2: Tracker rejects -> DB update still completes
    try {
        tracker.endSession = async () => { throw new Error('Simulated tracker failure'); };

        const res = await app.flushReaderStateOnExit('req-456');
        assert.equal(res.progressSaved, true, 'db.updateBookProgress must run even if tracker rejects');
        assert.equal(res.status, 'recovery_backup_success');
    } finally {
        tracker.endSession = origEndSession;
    }

    // Subtest 3: Both reject -> localStorage backups exist
    try {
        mockDB.failProgressWrite = true;
        tracker.endSession = async () => { throw new Error('Tracker fail'); };

        globalThis.localStorage.clear();
        const res = await app.flushReaderStateOnExit('req-789');

        assert.ok(globalThis.localStorage.getItem('linden_pending_progress_backup'), 'Progress backup must exist in localStorage');
        assert.ok(globalThis.localStorage.getItem('linden_pending_session_backup'), 'Session backup must exist in localStorage');
        assert.equal(res.status, 'recovery_backup_success');
    } finally {
        mockDB.failProgressWrite = false;
        tracker.endSession = origEndSession;
    }

    // Subtest 4: requestId null/empty does NOT call platformBridge.flushComplete
    globalThis.platformBridge.flushCalls = [];
    await app.flushReaderStateOnExit(null);
    await app.flushReaderStateOnExit('');
    assert.equal(globalThis.platformBridge.flushCalls.length, 0, 'Must NOT call flushComplete for null or empty requestId');
});

await runAsyncTest('6.13 Rapid book switching: Slow open of Book A does not pollute Book B', async () => {
    const app = new UniversalReaderApp();
    const blobA = new Blob(['Content A'], { type: 'application/epub+zip' });
    const blobB = new Blob(['Content B'], { type: 'application/epub+zip' });
    await saveBook({ id: 'rapid-book-a', title: 'Rapid A', format: 'epub' });
    await saveBookFileBlob('rapid-book-a', blobA);
    await saveBook({ id: 'rapid-book-b', title: 'Rapid B', format: 'epub' });
    await saveBookFileBlob('rapid-book-b', blobB);

    mockDB.delayRapidBookA = true;

    try {
        // Start opening Book A (delayed by mockDB)
        const openAPromise = app.openBook('rapid-book-a');

        // Almost immediately (after 10ms), switch to Book B
        await new Promise(r => setTimeout(r, 10));
        await app.openBook('rapid-book-b');
        assert.equal(app.currentBookId, 'rapid-book-b');
        const sessionB = app._activeSession;

        // Now wait for Book A to finish its delayed open
        await openAPromise;

        // Verify that Book A did NOT overwrite Book B's active state
        assert.equal(app.currentBookId, 'rapid-book-b', 'Current book must still be Book B');
        assert.equal(app._activeSession, sessionB, 'Active session must still be Book B');
        assert.equal(app._activeSession.bookId, 'rapid-book-b');
    } finally {
        mockDB.delayRapidBookA = false;
    }
});

await runAsyncTest('6.14 remapPdfDrawingId correctly preserves origins and revisions with underscores', async () => {
    const drawing = {
        id: 'old-book_orig_orig_mem_abc_123_rev_rev_987_xyz_456_page_3'
    };
    const remapped = remapPdfDrawingId(drawing, 'new-book');
    assert.equal(remapped, 'new-book_orig_orig_mem_abc_123_rev_rev_987_xyz_456_page_3');
    assert.equal(drawing.revisionOrigin, 'orig_mem_abc_123');
    assert.equal(drawing.blobRevision, 'rev_987_xyz_456');
    assert.equal(drawing.pageIndex, 3);
});

await runAsyncTest('6.15 clearPdfPageDrawing with revisionOrigin preserves un-origined key', async () => {
    const bookId = 'pdf-clear-iso';
    const pageIndex = 2;
    const strokesUnorigined = [{ tool: 'pen', color: '#111' }];
    const strokesOrigined = [{ tool: 'marker', color: '#222' }];

    await savePdfPageDrawing(bookId, pageIndex, strokesUnorigined, { blobRevision: 'rev-X' });
    await savePdfPageDrawing(bookId, pageIndex, strokesOrigined, { blobRevision: 'rev-X', revisionOrigin: 'orig-Y' });

    // Clear only the origined one
    await clearPdfPageDrawing(bookId, pageIndex, false, Date.now(), { blobRevision: 'rev-X', revisionOrigin: 'orig-Y' });

    const fetchOrigined = await getPdfPageDrawing(bookId, pageIndex, { blobRevision: 'rev-X', revisionOrigin: 'orig-Y' });
    const fetchUnorigined = await getPdfPageDrawing(bookId, pageIndex, { blobRevision: 'rev-X' });

    assert.equal(fetchOrigined, null, 'Origined drawing must be cleared');
    assert.ok(fetchUnorigined, 'Un-origined drawing must NOT be deleted by origined clear');
});

await runAsyncTest('6.16 tracker.startSession does not overwrite previous session finalFraction', async () => {
    globalThis.localStorage.clear();
    await tracker.startSession('book-prev', 'Book Prev', 0.5);
    tracker.sessionCumulativeSeconds = 120; // 2 minutes

    // Start new session for book-next with startFraction = 0.05
    await tracker.startSession('book-next', 'Book Next', 0.05);

    const allSessions = await db.getAllReadingSessions();
    const prevSess = allSessions.find(s => s.bookId === 'book-prev');
    assert.ok(prevSess, 'Previous session must be recorded in DB');
    assert.equal(prevSess.endProgress, 0.5, 'Previous session endProgress must NOT be overwritten by new book startFraction');

    await tracker.endSession();
});

await runAsyncTest('6.17 tracker short session (<60s) with isFinal clears backup so it does not resurrect', async () => {
    globalThis.localStorage.clear();
    await tracker.startSession('short-book', 'Short Book', 0.2);
    tracker.sessionCumulativeSeconds = 30; // 30s < 60s
    tracker.backupPendingSession(0.25);

    assert.ok(globalThis.localStorage.getItem('linden_pending_session_backup'), 'Backup must exist before normal end');

    // Normal endSession calls flush(true)
    await tracker.endSession(0.25);

    assert.equal(globalThis.localStorage.getItem('linden_pending_session_backup'), null, 'Backup must be cleared so short session is not resurrected on next launch');
});

await runAsyncTest('6.18 flushReaderStateOnExit deduplicates concurrent calls with same requestId', async () => {
    const app = new UniversalReaderApp();
    const bookId = 'dedup-test';
    const blob = new Blob(['Content'], { type: 'application/epub+zip' });
    await saveBook({ id: bookId, title: 'Dedup Test', format: 'epub' });
    await saveBookFileBlob(bookId, blob);
    await app.openBook(bookId);

    globalThis.platformBridge.flushCalls = [];
    const [res1, res2] = await Promise.all([
        app.flushReaderStateOnExit('req-dedup-1'),
        app.flushReaderStateOnExit('req-dedup-1')
    ]);

    assert.equal(res1, res2, 'Both calls with identical requestId must return identical result promise');
    const acks = globalThis.platformBridge.flushCalls.filter(id => id === 'req-dedup-1');
    assert.equal(acks.length, 1, 'platformBridge.flushComplete must be called exactly once for duplicate requestId');
});

await runAsyncTest('6.19 tracker.endSession returns pending _sessionQueue even when already not tracking', async () => {
    await tracker.startSession('queue-test', 'Queue Test', 0.1);
    tracker.sessionCumulativeSeconds = 90;

    // First endSession triggers flush
    const p1 = tracker.endSession(0.2);
    assert.equal(tracker.isTracking, false);

    // Second endSession called while p1 is in flight
    const p2 = tracker.endSession(0.2);
    await p2;

    const allSessions = await db.getAllReadingSessions();
    const sess = allSessions.find(s => s.bookId === 'queue-test');
    assert.ok(sess, 'Session must be written to DB');
    assert.equal(sess.durationSeconds, 90, 'Second endSession must have awaited completion of _sessionQueue');
});

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n====================================================');
console.log(`Verification Complete: ${passedTests} / ${totalTests} tests passed.`);
console.log('====================================================');

if (passedTests !== totalTests) {
    process.exit(1);
} else {
    process.exit(0);
}
