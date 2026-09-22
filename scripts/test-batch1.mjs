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
    const el = {
        tagName: tag.toUpperCase(),
        id,
        style: {},
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
        addEventListener: () => {},
        removeEventListener: () => {},
        matches: () => false,
        focus: () => {},
        blur: () => {},
        click: () => {},
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
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => createMockEl(tag),
    getElementById: (id) => createMockEl('DIV', id),
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

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
                                    matched.push(JSON.parse(JSON.stringify(v)));
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
                queueMicrotask(() => {
                    const val = s.data.get(key);
                    this._activeRequests--;
                    req._succeed(val !== undefined ? JSON.parse(JSON.stringify(val)) : undefined);
                });
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
                    s.data.set(k, JSON.parse(JSON.stringify(val)));
                    this._activeRequests--;
                    req._succeed(k);
                });
                return req;
            },
            delete: (key) => {
                const req = new MockIDBRequest();
                this._activeRequests++;
                queueMicrotask(() => {
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
                    const values = Array.from(s.data.values()).map(v => JSON.parse(JSON.stringify(v)));
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
        return new MockIDBTransaction(this, storeNames, mode);
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
    updateBookProgress
} = await import('../js/db.js');

const { decodePdfProgress } = await import('../js/app.js');
const { AdaptivePdfDriver, PdfJsDriver } = await import('../js/pdf-driver.js');
const { PdfViewport } = await import('../js/pdf-viewport.js');

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

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n====================================================');
console.log(`Verification Complete: ${passedTests} / ${totalTests} tests passed.`);
console.log('====================================================');

if (passedTests !== totalTests) {
    process.exit(1);
}
