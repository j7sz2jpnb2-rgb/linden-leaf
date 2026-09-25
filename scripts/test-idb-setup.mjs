// scripts/test-idb-setup.mjs - Lightweight In-Memory IndexedDB Mock for Unit Tests

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
        if (!s) throw new Error(`ObjectStore not found: ${name}`);
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
            getAll: () => {
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

export const mockDB = new MockIDBDatabase('LindenLeafDB', 8);

// Setup default Linden Leaf object stores
mockDB.createObjectStore('books', { keyPath: 'id' });
mockDB.createObjectStore('book_files', { keyPath: 'id' });
mockDB.createObjectStore('bookmarks', { keyPath: 'id' });
mockDB.createObjectStore('highlights', { keyPath: 'id' });
mockDB.createObjectStore('settings', { keyPath: 'key' });
mockDB.createObjectStore('reading_sessions', { keyPath: 'id' });
mockDB.createObjectStore('custom_lists', { keyPath: 'id' });
mockDB.createObjectStore('deleted_records', { keyPath: 'id' });
mockDB.createObjectStore('pdf_drawings', { keyPath: 'id' });
mockDB.createObjectStore('fulltext_index', { keyPath: 'bookId' });

if (!globalThis.addEventListener) {
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
}
globalThis.window = globalThis;
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
