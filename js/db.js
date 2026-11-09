// db.js - IndexedDB storage wrapper for Universal E-Book Reader
import { buildTranslationRevisionArchive, checkTranslationCompatibility } from './translation-job-core.js'
import { resolveReadingState } from './tags-manager.js'
import { withReadableBookTitle } from './book-title.js'

const DB_NAME = 'UniversalReaderDB'
const DB_VERSION = 10

let dbInstance = null
let _openPromise = null

// Helper: Normalize any timestamp format (epoch ms number, Date object, ISO string) to numerical epoch ms (LL-29)
export const normalizeTimestampMs = (t) => {
    if (!t) return 0
    if (typeof t === 'number') return isNaN(t) ? 0 : t
    if (t instanceof Date) return t.getTime()
    const ms = new Date(t).getTime()
    return isNaN(ms) ? 0 : ms
}

// Helper: Format Date to local 'YYYY-MM-DD'
export const toLocalDateKey = (dateInput = new Date()) => {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export const computeContentHash = async (blobOrFile) => {
    if (!blobOrFile) return null
    try {
        const size = blobOrFile.size || 0
        if (size === 0) return 'e_empty'
        const subtle = globalThis.crypto?.subtle
        if (!subtle) return `sz_${size}`
        if (size <= 2 * 1024 * 1024) {
            const buf = await blobOrFile.arrayBuffer()
            const hashBuf = await subtle.digest('SHA-256', buf)
            const arr = Array.from(new Uint8Array(hashBuf))
            return arr.map(b => b.toString(16).padStart(2, '0')).join('')
        }
        // For larger files: sample head 64KB, middle 64KB, tail 64KB + length
        const head = blobOrFile.slice(0, 64 * 1024)
        const midPos = Math.floor(size / 2)
        const mid = blobOrFile.slice(midPos, midPos + 64 * 1024)
        const tail = blobOrFile.slice(Math.max(0, size - 64 * 1024))
        const [hBuf, mBuf, tBuf] = await Promise.all([head.arrayBuffer(), mid.arrayBuffer(), tail.arrayBuffer()])
        const totalLen = hBuf.byteLength + mBuf.byteLength + tBuf.byteLength + 8
        const combined = new Uint8Array(totalLen)
        combined.set(new Uint8Array(hBuf), 0)
        combined.set(new Uint8Array(mBuf), hBuf.byteLength)
        combined.set(new Uint8Array(tBuf), hBuf.byteLength + mBuf.byteLength)
        const dv = new DataView(combined.buffer)
        dv.setBigUint64(hBuf.byteLength + mBuf.byteLength + tBuf.byteLength, BigInt(size), true)
        const hashBuf = await subtle.digest('SHA-256', combined)
        const arr = Array.from(new Uint8Array(hashBuf))
        return 's_' + arr.map(b => b.toString(16).padStart(2, '0')).join('')
    } catch (_) {
        return null
    }
}

export const openDB = () => {
    if (dbInstance) return Promise.resolve(dbInstance)
    if (_openPromise) return _openPromise
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB is not available in current environment'))
    }
    _openPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        
        req.onupgradeneeded = e => {
            const db = e.target.result
            
            // Store for Books (Metadata only)
            if (!db.objectStoreNames.contains('books')) {
                const bookStore = db.createObjectStore('books', { keyPath: 'id' })
                bookStore.createIndex('addedAt', 'addedAt', { unique: false })
                bookStore.createIndex('lastReadAt', 'lastReadAt', { unique: false })
            }

            // Store for Book Binary Files (Separated from metadata to prevent OOM)
            if (!db.objectStoreNames.contains('book_files')) {
                db.createObjectStore('book_files', { keyPath: 'id' })
            }

            // Store for Bookmarks
            if (!db.objectStoreNames.contains('bookmarks')) {
                const bmStore = db.createObjectStore('bookmarks', { keyPath: 'id' })
                bmStore.createIndex('bookId', 'bookId', { unique: false })
            }

            // Store for Highlights & Notes
            if (!db.objectStoreNames.contains('highlights')) {
                const hlStore = db.createObjectStore('highlights', { keyPath: 'id' })
                hlStore.createIndex('bookId', 'bookId', { unique: false })
            }

            // Store for App Settings & State
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' })
            }

            // Store for Reading Sessions
            if (!db.objectStoreNames.contains('reading_sessions')) {
                const sessionStore = db.createObjectStore('reading_sessions', { keyPath: 'id' })
                sessionStore.createIndex('bookId', 'bookId', { unique: false })
                sessionStore.createIndex('date', 'date', { unique: false })
                sessionStore.createIndex('startTime', 'startTime', { unique: false })
            }

            // Store for Custom Reading Lists
            if (!db.objectStoreNames.contains('custom_lists')) {
                const listStore = db.createObjectStore('custom_lists', { keyPath: 'id' })
                listStore.createIndex('createdAt', 'createdAt', { unique: false })
            }

            // Store for Deletion Tombstones (Cloud Sync Deletion Propagation)
            if (!db.objectStoreNames.contains('deleted_records')) {
                const delStore = db.createObjectStore('deleted_records', { keyPath: 'id' })
                delStore.createIndex('type', 'type', { unique: false })
                delStore.createIndex('deletedAt', 'deletedAt', { unique: false })
            }

            // Store for PDF Page Drawings & Marker Annotations
            if (!db.objectStoreNames.contains('pdf_drawings')) {
                const drawStore = db.createObjectStore('pdf_drawings', { keyPath: 'id' })
                drawStore.createIndex('bookId', 'bookId', { unique: false })
            }

            // Store for Local Cross-Book Full-Text Search Indexes
            if (!db.objectStoreNames.contains('fulltext_index')) {
                const ftStore = db.createObjectStore('fulltext_index', { keyPath: 'bookId' })
                ftStore.createIndex('indexedAt', 'indexedAt', { unique: false })
                ftStore.createIndex('extractorVersion', 'extractorVersion', { unique: false })
            }

            // Store for AI Conversations
            if (!db.objectStoreNames.contains('ai_conversations')) {
                const convStore = db.createObjectStore('ai_conversations', { keyPath: 'id' })
                convStore.createIndex('bookId', 'bookId', { unique: false })
                convStore.createIndex('createdAt', 'createdAt', { unique: false })
                convStore.createIndex('updatedAt', 'updatedAt', { unique: false })
            }

            // Store for AI Messages
            if (!db.objectStoreNames.contains('ai_messages')) {
                const msgStore = db.createObjectStore('ai_messages', { keyPath: 'id' })
                msgStore.createIndex('conversationId', 'conversationId', { unique: false })
                msgStore.createIndex('createdAt', 'createdAt', { unique: false })
            }

            // Store for Chapter Bilingual Translations & Paragraph Cache (v10)
            if (!db.objectStoreNames.contains('chapter_translations')) {
                const transStore = db.createObjectStore('chapter_translations', { keyPath: 'id' })
                transStore.createIndex('bookId', 'bookId', { unique: false })
                transStore.createIndex('chapterKey', 'chapterKey', { unique: false })
                transStore.createIndex('bookChapter', ['bookId', 'chapterKey'], { unique: false })
                transStore.createIndex('updatedAt', 'updatedAt', { unique: false })
            }

            // Migrate DB_VERSION < 4 records (strip blob from books and save to book_files)
            if (e.oldVersion < 4 && e.oldVersion > 0) {
                try {
                    const tx = e.target.transaction
                    const bookStore = tx.objectStore('books')
                    const fileStore = tx.objectStore('book_files')
                    const cursorReq = bookStore.openCursor()
                    cursorReq.onsuccess = ev => {
                        const cursor = ev.target.result
                        if (cursor) {
                            const val = cursor.value
                            if (val && val.blob) {
                                fileStore.put({ id: val.id, blob: val.blob })
                                delete val.blob
                                cursor.update(val)
                            }
                            cursor.continue()
                        }
                    }
                } catch (err) {
                    console.warn('[DB Upgrade] Migration error:', err)
                }
            }

            // DB v7: machine-local native paths belong in book_files, never in
            // syncable book metadata. Preserve any existing blob in the same record.
            if (e.oldVersion < 7 && e.oldVersion > 0) {
                try {
                    const tx = e.target.transaction
                    const bookStore = tx.objectStore('books')
                    const fileStore = tx.objectStore('book_files')
                    const cursorReq = bookStore.openCursor()
                    cursorReq.onsuccess = ev => {
                        const cursor = ev.target.result
                        if (!cursor) return
                        const val = cursor.value
                        if (val?.nativePath) {
                            const nativePath = val.nativePath
                            delete val.nativePath
                            const fileReq = fileStore.get(val.id)
                            fileReq.onsuccess = () => {
                                const local = fileReq.result || { id: val.id }
                                local.nativePath = nativePath
                                fileStore.put(local)
                            }
                            cursor.update(val)
                        }
                        cursor.continue()
                    }
                } catch (err) {
                    console.warn('[DB Upgrade] nativePath migration error:', err)
                }
            }
        }

        req.onblocked = () => {
            console.warn('IndexedDB upgrade blocked by another open tab or instance.')
        }

        req.onsuccess = e => {
            dbInstance = e.target.result
            _openPromise = null
            dbInstance.onversionchange = () => {
                dbInstance.close()
                dbInstance = null
                _openPromise = null
                console.warn('IndexedDB version changed; connection closed.')
            }
            resolve(dbInstance)
        }

        req.onerror = e => {
            _openPromise = null
            console.error('IndexedDB open error:', e)
            reject(req.error || e)
        }
    })
    return _openPromise
}

// Content Identity & Revision Management
let _cachedRevisionOrigin = null

export const getRevisionOrigin = async () => {
    if (_cachedRevisionOrigin) return _cachedRevisionOrigin
    try {
        const saved = await getSetting('device_revision_origin')
        if (saved && typeof saved === 'string') {
            _cachedRevisionOrigin = saved
            return saved
        }
        const generated = `orig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        await setSetting('device_revision_origin', generated)
        _cachedRevisionOrigin = generated
        return generated
    } catch (e) {
        if (!_cachedRevisionOrigin) {
            _cachedRevisionOrigin = `orig_mem_${Date.now().toString(36)}`
        }
        return _cachedRevisionOrigin
    }
}

export const generateRevision = () => {
    return `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export const isContentIdentityMatching = (item, currentSnapshot, options = {}) => {
    if (!item || !currentSnapshot) return { matches: false, status: 'unconfirmed', pendingConfirmation: true }

    const allowCrossBook = Boolean(options.allowCrossBook || currentSnapshot.allowCrossBook)

    // Different bookId -> if not allowCrossBook, never matches
    if (!allowCrossBook && item.bookId && currentSnapshot.bookId && item.bookId !== currentSnapshot.bookId) {
        return { matches: false, status: 'different_book', pendingConfirmation: false }
    }

    const itemOrigin = item.revisionOrigin || null
    const itemRev = item.blobRevision || null
    const itemHash = item.documentHash || null

    const currentOrigin = currentSnapshot.revisionOrigin || null
    const currentRev = currentSnapshot.blobRevision || null
    const currentHash = currentSnapshot.documentHash || null

    // 1. Both hashes known: compare byte identity directly
    if (itemHash && currentHash) {
        if (itemHash === currentHash) {
            return { matches: true, status: 'matched_by_hash', pendingConfirmation: false }
        } else {
            return { matches: false, status: 'hash_conflict', pendingConfirmation: false }
        }
    }

    // 2. Same origin (or both un-origined) and same revision
    const originsCompatible = (!itemOrigin && !currentOrigin) || (itemOrigin && currentOrigin && itemOrigin === currentOrigin)
    if (originsCompatible) {
        if (itemRev && currentRev) {
            if (itemRev === currentRev) {
                // If one has a hash and the other has a conflicting hash, reject!
                if (itemHash && currentHash && itemHash !== currentHash) {
                    return { matches: false, status: 'hash_conflict', pendingConfirmation: false }
                }
                return { matches: true, status: 'matched_by_revision', pendingConfirmation: false }
            } else {
                return { matches: false, status: 'revision_mismatch', pendingConfirmation: false }
            }
        } else if (!itemRev && !currentRev && !itemHash && !currentHash) {
            return { matches: true, status: 'matched_unversioned', pendingConfirmation: false }
        }
    }

    // 3. Unconfirmed cases (different origin without matching hash, or legacy without revision/hash)
    const isLegacy = !itemRev && !itemHash
    return {
        matches: false,
        status: isLegacy ? 'legacy_unconfirmed' : 'unconfirmed',
        pendingConfirmation: true
    }
}

// Books CRUD
export const LARGE_PDF_SNAPSHOT_THRESHOLD = 25 * 1024 * 1024 // 25 MB

export function createLazySnapshotBlob(filePath, size, type = 'application/pdf', byteOffset = 0, byteLength = null) {
    const totalSize = (byteLength !== null && byteLength !== undefined) ? byteLength : size
    const dummy = new Blob([], { type })
    const lazyObj = {
        isLazySnapshot: true,
        nativeSnapshotOnly: true,
        nativeSnapshotPath: filePath,
        size: totalSize,
        type,
        byteOffset,
        byteLength: totalSize,
        async materialize() {
            if (typeof platformBridge !== 'undefined' && platformBridge.readFileBuffer) {
                const buf = await platformBridge.readFileBuffer(filePath)
                if (!buf) throw new Error(`Failed to read native snapshot at: ${filePath}`)
                let ab = buf instanceof ArrayBuffer ? buf : (ArrayBuffer.isView(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.buffer || buf)
                if (byteOffset > 0 || (byteLength !== null && totalSize < ab.byteLength)) {
                    const sliced = ab.slice(byteOffset, byteOffset + totalSize)
                    return new Blob([sliced], { type })
                }
                return new Blob([ab], { type })
            }
            throw new Error(`Platform bridge unavailable to materialize native snapshot at: ${filePath}`)
        },
        async arrayBuffer() {
            if (typeof platformBridge !== 'undefined' && platformBridge.readFileBuffer) {
                const buf = await platformBridge.readFileBuffer(filePath)
                if (!buf) throw new Error(`Failed to read native snapshot at: ${filePath}`)
                let ab = buf instanceof ArrayBuffer ? buf : (ArrayBuffer.isView(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.buffer || buf)
                if (byteOffset > 0 || (byteLength !== null && totalSize < ab.byteLength)) {
                    return ab.slice(byteOffset, byteOffset + totalSize)
                }
                return ab
            }
            throw new Error(`Platform bridge unavailable to read native snapshot at: ${filePath}`)
        },
        async text() {
            const buf = await this.arrayBuffer()
            return new TextDecoder().decode(buf)
        },
        async bytes() {
            const buf = await this.arrayBuffer()
            return new Uint8Array(buf)
        },
        slice(start = 0, end = totalSize, contentType = type) {
            const s = Math.max(0, start < 0 ? totalSize + start : start)
            const e = Math.min(totalSize, end < 0 ? totalSize + end : end)
            const newLength = Math.max(0, e - s)
            return createLazySnapshotBlob(filePath, size, contentType, byteOffset + s, newLength)
        }
    }

    return new Proxy(dummy, {
        get(target, prop) {
            if (prop in lazyObj) {
                const val = lazyObj[prop]
                return typeof val === 'function' ? val.bind(lazyObj) : val
            }
            if (prop === Symbol.toStringTag) return 'Blob'
            const val = Reflect.get(target, prop)
            return typeof val === 'function' ? val.bind(target) : val
        }
    })
}

export const saveBook = async bookData => {
    const db = await openDB()
    const origin = await getRevisionOrigin()
    const { blob, ...meta } = bookData
    const nativePath = bookData.nativePath
    const nativeSnapshotPath = bookData.nativeSnapshotPath

    return new Promise((resolve, reject) => {
        try {
            const storeNames = (blob || nativePath || nativeSnapshotPath) ? ['books', 'book_files'] : ['books']
            if (db.objectStoreNames.contains('deleted_records')) {
                storeNames.push('deleted_records')
            }
            const tx = db.transaction(storeNames, 'readwrite')
            const bookStore = tx.objectStore('books')

            const explicitBlobRevision = meta.blobRevision || null
            const generatedBlobRevision = (blob || nativeSnapshotPath) ? (explicitBlobRevision || generateRevision()) : explicitBlobRevision
            if (generatedBlobRevision) {
                meta.blobRevision = generatedBlobRevision
            }

            if (meta.title != null) {
                if (blob || nativePath || nativeSnapshotPath) {
                    meta.isCloudOnly = false
                    meta.hasLocalFile = true
                }
                if (meta.totalReadingSeconds == null) meta.totalReadingSeconds = 0
                if (!meta.addedAt) meta.addedAt = Date.now()
                if (meta.lastReadAt === undefined || meta.lastReadAt === null) meta.lastReadAt = 0
                if (meta.lastOpenedAt === undefined || meta.lastOpenedAt === null) meta.lastOpenedAt = 0
                if (!meta._preserveUpdatedAt || !meta.updatedAt) {
                    meta.updatedAt = Date.now()
                }
                delete meta._preserveUpdatedAt
                bookStore.put(meta)
            } else if (meta.id) {
                // Partial metadata update or only file blob update
                const getReq = bookStore.get(meta.id)
                getReq.onsuccess = () => {
                    const existing = getReq.result
                    if (existing) {
                        Object.assign(existing, meta)
                        if (blob || nativePath || nativeSnapshotPath) {
                            existing.isCloudOnly = false
                            existing.hasLocalFile = true
                        }
                        existing.updatedAt = meta._preserveUpdatedAt ? (meta.updatedAt || Date.now()) : Date.now()
                        delete existing._preserveUpdatedAt
                        bookStore.put(existing)
                    }
                }
            }

            let previousSnapshotPath = null
            if ((blob || nativePath || nativeSnapshotPath) && meta.id) {
                const fileStore = tx.objectStore('book_files')
                const fileReq = fileStore.get(meta.id)
                fileReq.onsuccess = () => {
                    const local = fileReq.result || { id: meta.id }
                    const suppliedSnapshot = nativeSnapshotPath || blob?.nativeSnapshotPath || null
                    const suppliedSnapshotPath = typeof suppliedSnapshot === 'object' ? suppliedSnapshot?.path : suppliedSnapshot
                    const nativeDescriptor = blob && !(blob instanceof Blob) && (blob.isLazySnapshot || blob.nativeSnapshotOnly || typeof blob.materialize === 'function')
                    // Supplying new bytes must never relabel an old cache as those new bytes.
                    const effectiveSnapshotPath = blob
                        ? ((suppliedSnapshotPath && (suppliedSnapshotPath !== local.nativeSnapshotPath || nativeDescriptor)) ? suppliedSnapshotPath : null)
                        : (suppliedSnapshotPath || local.nativeSnapshotPath || null)
                    const isLazy = blob && (blob.isLazySnapshot || blob.nativeSnapshotOnly || typeof blob.materialize === 'function')
                    const isTauri = typeof platformBridge !== 'undefined' && platformBridge.isTauri
                    const format = (meta.format || '').toLowerCase()
                    const isLargeNativePdf = isTauri &&
                        (format === 'pdf' || (blob?.type && blob.type.includes('pdf'))) &&
                        effectiveSnapshotPath &&
                        ((blob?.size > LARGE_PDF_SNAPSHOT_THRESHOLD) || !blob)

                    if (blob) {
                        previousSnapshotPath = local.nativeSnapshotPath || null
                        local.blobRevision = explicitBlobRevision || generatedBlobRevision || generateRevision()
                        local.revisionOrigin = origin
                        local.documentHash = meta.documentHash !== undefined ? meta.documentHash : null
                        local.nativeSnapshotPath = effectiveSnapshotPath
                        local.nativeSnapshotRevision = effectiveSnapshotPath ? local.blobRevision : null
                        local.nativeSnapshotOrigin = effectiveSnapshotPath ? origin : null
                        local.nativeSnapshotSize = effectiveSnapshotPath ? (blob.size || blob.byteLength || 0) : null

                        if (isLargeNativePdf || isLazy) {
                            local.blob = null
                            local.nativeSnapshotOnly = true
                        } else {
                            local.blob = blob
                            local.nativeSnapshotOnly = false
                        }
                    } else if (effectiveSnapshotPath) {
                        previousSnapshotPath = local.nativeSnapshotPath || null
                        local.blobRevision = explicitBlobRevision || generatedBlobRevision || local.blobRevision || generateRevision()
                        local.revisionOrigin = local.revisionOrigin || origin
                        local.documentHash = meta.documentHash !== undefined ? meta.documentHash : (local.documentHash || null)
                        local.nativeSnapshotPath = effectiveSnapshotPath
                        local.nativeSnapshotRevision = local.blobRevision
                        local.nativeSnapshotOrigin = local.revisionOrigin
                        local.nativeSnapshotSize = meta.size || meta.fileSize || local.nativeSnapshotSize || 0
                        local.nativeSnapshotOnly = true
                        local.blob = null
                    } else if (nativePath) {
                        local.blobRevision = explicitBlobRevision || local.blobRevision || generateRevision()
                        local.revisionOrigin = local.revisionOrigin || origin
                        local.documentHash = meta.documentHash !== undefined ? meta.documentHash : (local.documentHash || null)
                        local.nativeSnapshotSize = meta.size || meta.fileSize || local.nativeSnapshotSize || 0
                        local.nativeSnapshotOnly = true
                        local.blob = null
                    }
                    if (nativePath !== undefined) local.nativePath = nativePath
                    const effectivePath = effectiveSnapshotPath || nativePath || local.nativePath || null
                    const effectiveSize = local.nativeSnapshotSize || meta.size || meta.fileSize || 0
                    local.sourceDescriptor = {
                        kind: effectiveSnapshotPath ? 'native-snapshot' : (local.nativePath ? 'linked-file' : (local.blob ? 'embedded-blob' : 'unknown')),
                        path: effectivePath,
                        size: effectiveSize,
                        revision: local.blobRevision,
                        documentHash: local.documentHash || null
                    }
                    local.updatedAt = Date.now()
                    fileStore.put(local)
                    if (blob) {
                        const metadata = bookStore.get(meta.id)
                        metadata.onsuccess = () => {
                            if (!metadata.result) return
                            bookStore.put({ ...metadata.result,
                                blobRevision: local.blobRevision, revisionOrigin: local.revisionOrigin,
                                nativeSnapshotPath: local.nativeSnapshotPath, nativeSnapshotRevision: local.nativeSnapshotRevision,
                                nativeSnapshotOrigin: local.nativeSnapshotOrigin, nativeSnapshotSize: local.nativeSnapshotSize,
                                nativeSnapshotOnly: local.nativeSnapshotOnly })
                        }
                    }
                }
            }
            // Item 2: Do NOT purge tombstones from deleted_records in saveBook
            tx.oncomplete = () => {
                if (previousSnapshotPath && previousSnapshotPath !== nativeSnapshotPath &&
                    typeof platformBridge !== 'undefined' && platformBridge.reclaimSnapshot) {
                    openDB().then(db2 => {
                        if (!db2.objectStoreNames.contains('book_files')) return
                        const checkTx = db2.transaction(['book_files'], 'readonly')
                        const req = checkTx.objectStore('book_files').getAll()
                        req.onsuccess = () => {
                            const files = req.result || []
                            const isStillReferenced = files.some(f => f.nativeSnapshotPath === previousSnapshotPath)
                            if (!isStillReferenced) {
                                platformBridge.reclaimSnapshot(previousSnapshotPath).catch(err => {
                                    console.warn('[db.saveBook] Replaced snapshot reclaim notice:', err)
                                })
                            }
                        }
                    }).catch(() => {})
                }
                invalidateReadingStatsCache()
                resolve(meta.id)
            }
            tx.onerror = () => reject(tx.error || new Error('Failed to save book'))
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
        } catch (err) {
            reject(err)
        }
    })
}

export const getBookFileBlob = async id => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(['book_files', 'books'], 'readonly')
            const fileStore = tx.objectStore('book_files')
            const req = fileStore.get(id)
            req.onsuccess = async () => {
                const rec = req.result
                if (rec && rec.blob instanceof Blob) {
                    resolve(rec.blob)
                    return
                }
                const diskPath = rec?.nativeSnapshotPath || rec?.nativePath || rec?.sourceDescriptor?.path
                if (diskPath && typeof platformBridge !== 'undefined' && platformBridge.readFileBuffer) {
                    try {
                        const buf = await platformBridge.readFileBuffer(diskPath)
                        if (buf) {
                            const ext = (diskPath.split('.').pop() || '').toLowerCase()
                            const mimeType = ext === 'pdf' ? 'application/pdf' : (ext === 'txt' ? 'text/plain' : (ext === 'epub' ? 'application/epub+zip' : 'application/octet-stream'))
                            const blob = new Blob([buf], { type: mimeType })
                            resolve(blob)
                            return
                        }
                    } catch (e) {
                        console.warn('[db.getBookFileBlob] native read buffer notice:', e)
                    }
                }
                // Fallback to legacy books table
                const bookReq = tx.objectStore('books').get(id)
                bookReq.onsuccess = () => {
                    resolve(bookReq.result?.blob || null)
                }
                bookReq.onerror = () => resolve(null)
            }
            req.onerror = () => resolve(null)
        } catch (e) {
            resolve(null)
        }
    })
}
export const getBookBlob = getBookFileBlob
export const getBookFile = getBookFileBlob

export const getBookNativePath = async id => {
    if (!id) return null
    const db = await openDB()
    return new Promise(resolve => {
        try {
            const tx = db.transaction('book_files', 'readonly')
            const req = tx.objectStore('book_files').get(id)
            req.onsuccess = () => resolve(req.result?.nativePath || null)
            req.onerror = () => resolve(null)
        } catch { resolve(null) }
    })
}

export function isValidRating(rating) {
    if (rating === null) return true
    if (typeof rating !== 'number' || isNaN(rating)) return false
    if (rating < 0.5 || rating > 5.0) return false
    return Math.round(rating * 2) === rating * 2
}

export const saveBookRating = async (id, rating) => {
    if (!id || !isValidRating(rating)) return false
    await saveBook({
        id,
        rating,
        ratingUpdatedAt: Date.now()
    })
    return true
}

export const saveBookNativePath = async (id, nativePath) => {
    if (!id || !nativePath) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('book_files', 'readwrite')
        const store = tx.objectStore('book_files')
        const req = store.get(id)
        req.onsuccess = () => {
            const local = req.result || { id }
            local.nativePath = nativePath
            store.put(local)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed saving native book path'))
    })
}

// Bind a native cache to the exact version read by the caller. This changes only
// local cache metadata; progress, annotations and the content identity stay intact.
export const bindSavedPdfNativeSnapshot = async (snapshot, descriptor) => {
    if (!snapshot?.bookId || !snapshot.blobRevision || !descriptor?.path || descriptor.size !== snapshot.blob?.size) return false
    const database = await openDB()
    return new Promise((resolve, reject) => {
        const tx = database.transaction(['book_files', 'books'], 'readwrite')
        const files = tx.objectStore('book_files'), books = tx.objectStore('books')
        let file, book, pending = 2, bound = false
        const apply = () => {
            if (--pending) return
            if (!file?.blob || !book || file.blobRevision !== snapshot.blobRevision ||
                (file.revisionOrigin || snapshot.revisionOrigin) !== snapshot.revisionOrigin || file.blob.size !== snapshot.blob.size) return
            const fields = {
                nativeSnapshotPath: descriptor.path,
                nativeSnapshotRevision: snapshot.blobRevision,
                nativeSnapshotOrigin: snapshot.revisionOrigin,
                nativeSnapshotSize: descriptor.size
            }
            files.put({ ...file, ...fields })
            books.put({ ...book, ...fields })
            bound = true
        }
        const fr = files.get(snapshot.bookId), br = books.get(snapshot.bookId)
        fr.onsuccess = () => { file = fr.result; apply() }
        br.onsuccess = () => { book = br.result; apply() }
        tx.oncomplete = () => resolve(bound)
        tx.onerror = () => reject(tx.error || new Error('Failed binding saved PDF snapshot'))
        tx.onabort = () => reject(tx.error || new Error('Saved PDF snapshot transaction aborted'))
    })
}

export const hasBookFileBlob = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            const tx = db.transaction('book_files', 'readonly')
            const req = tx.objectStore('book_files').count(id)
            req.onsuccess = () => resolve(req.result > 0)
            req.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const saveBookFileBlob = async (id, blob) => {
    if (!id || !blob) return false
    const db = await openDB()
    const origin = await getRevisionOrigin()
    const newRevision = generateRevision()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['books', 'book_files'], 'readwrite')
        const fileStore = tx.objectStore('book_files')
        const bookStore = tx.objectStore('books')

        const localReq = fileStore.get(id)
        localReq.onsuccess = () => {
            const local = localReq.result || { id }
            local.blob = blob
            local.blobRevision = newRevision
            local.revisionOrigin = origin
            local.documentHash = null // Clear old hash association
            local.nativeSnapshotPath = null
            local.nativeSnapshotRevision = null
            local.nativeSnapshotOrigin = null
            local.nativeSnapshotSize = null
            local.updatedAt = Date.now()
            fileStore.put(local)
        }

        const bookReq = bookStore.get(id)
        bookReq.onsuccess = () => {
            const book = bookReq.result
            if (book) {
                book.isCloudOnly = false
                book.hasLocalFile = true
                book.blobRevision = newRevision
                book.revisionOrigin = origin
                book.size = blob.size
                // Do NOT touch updatedAt here so downloading binary does not conflict with remote deletions
                bookStore.put(book)
            }
        }

        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed saving book blob'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const getBookFileSnapshot = async id => {
    if (!id) return null
    const db = await openDB()
    const origin = await getRevisionOrigin()

    // 1. First attempt: Read in a strictly readonly transaction
    const readResult = await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(['book_files', 'books'], 'readonly')
            const fileStore = tx.objectStore('book_files')
            const bookStore = tx.objectStore('books')

            let fileRecord = null
            let bookRecord = null

            const fReq = fileStore.get(id)
            const bReq = bookStore.get(id)

            fReq.onsuccess = () => { fileRecord = fReq.result || null }
            bReq.onsuccess = () => { bookRecord = bReq.result || null }

            tx.oncomplete = () => resolve({ fileRecord, bookRecord })
            tx.onerror = () => reject(tx.error || new Error(`Failed to read book file snapshot ${id}`))
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted for snapshot ${id}`))
        } catch (err) {
            reject(err)
        }
    })

    const { fileRecord, bookRecord } = readResult

    // If valid fileRecord with blob and existing blobRevision, return frozen snapshot immediately!
    if (fileRecord && fileRecord.blob && fileRecord.blobRevision) {
        return Object.freeze({
            bookId: id,
            blob: fileRecord.blob,
            blobRevision: fileRecord.blobRevision,
            revisionOrigin: fileRecord.revisionOrigin || origin,
            documentHash: fileRecord.documentHash || null,
            nativePath: fileRecord.nativePath || null,
            nativeSnapshotPath: fileRecord.nativeSnapshotPath || null,
            nativeSnapshotRevision: fileRecord.nativeSnapshotRevision || null,
            nativeSnapshotOrigin: fileRecord.nativeSnapshotOrigin || null,
            nativeSnapshotSize: fileRecord.nativeSnapshotSize ?? null,
            nativeSnapshotOnly: false,
            format: bookRecord?.format || null,
            title: bookRecord?.title || '',
            author: bookRecord?.author || '',
            progress: bookRecord?.progress || null
        })
    }

    // Check if large native PDF with nativeSnapshotOnly, OR linked file with nativePath / nativeSnapshotPath
    const effectiveFilePath = fileRecord?.nativeSnapshotPath || fileRecord?.nativePath || fileRecord?.sourceDescriptor?.path
    if (fileRecord && (fileRecord.nativeSnapshotOnly || (!fileRecord.blob && effectiveFilePath))) {
        const snapshotSize = fileRecord.nativeSnapshotSize || fileRecord.sourceDescriptor?.size || bookRecord?.size || 0
        const format = (bookRecord?.format || fileRecord.format || 'pdf').toLowerCase()
        const mimeType = format === 'pdf' ? 'application/pdf' : (format === 'txt' ? 'text/plain' : (format === 'epub' ? 'application/epub+zip' : 'application/octet-stream'))
        const virtualBlob = createLazySnapshotBlob(effectiveFilePath, snapshotSize, mimeType)
        return Object.freeze({
            bookId: id,
            blob: virtualBlob,
            blobRevision: fileRecord.blobRevision || 'v_native',
            revisionOrigin: fileRecord.revisionOrigin || origin,
            documentHash: fileRecord.documentHash || null,
            nativePath: fileRecord.nativePath || null,
            nativeSnapshotPath: fileRecord.nativeSnapshotPath || null,
            nativeSnapshotRevision: fileRecord.nativeSnapshotRevision || fileRecord.blobRevision || 'v_native',
            nativeSnapshotOrigin: fileRecord.nativeSnapshotOrigin || origin,
            nativeSnapshotSize: snapshotSize,
            nativeSnapshotOnly: true,
            sourceDescriptor: fileRecord.sourceDescriptor || {
                kind: fileRecord.nativeSnapshotPath ? 'native-snapshot' : 'linked-file',
                path: effectiveFilePath,
                size: snapshotSize,
                revision: fileRecord.blobRevision || 'v_native',
                documentHash: fileRecord.documentHash || null
            },
            format: bookRecord?.format || format || 'pdf',
            title: bookRecord?.title || '',
            author: bookRecord?.author || '',
            progress: bookRecord?.progress || null
        })
    }

    // 2. Legacy record backfill: Only when blob exists but lacks blobRevision (or blob is in legacy books table)
    // Execute a readwrite transaction to persist the revision and reread within the same transaction.
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(['book_files', 'books'], 'readwrite')
            const fileStore = tx.objectStore('book_files')
            const bookStore = tx.objectStore('books')

            let persistedFile = null
            let persistedBook = null

            const fReq = fileStore.get(id)
            const bReq = bookStore.get(id)

            fReq.onsuccess = () => {
                let fRec = fReq.result || null
                bReq.onsuccess = () => {
                    let bRec = bReq.result || null

                    // If blob is in legacy books table
                    if ((!fRec || !fRec.blob) && bRec && bRec.blob) {
                        const newRev = generateRevision()
                        fRec = {
                            id,
                            blob: bRec.blob,
                            blobRevision: newRev,
                            revisionOrigin: origin,
                            documentHash: null,
                            nativePath: bRec.nativePath || null,
                            updatedAt: Date.now()
                        }
                        fileStore.put(fRec)
                        if (bRec.progress && !bRec.progress.blobRevision) {
                            bRec.progress.blobRevision = newRev
                            bRec.progress.revisionOrigin = origin
                        }
                        bRec.blobRevision = newRev
                        bRec.revisionOrigin = origin
                        bRec.documentHash = null
                        delete bRec.blob
                        bookStore.put(bRec)
                        persistedFile = fRec
                        persistedBook = bRec
                        return
                    }

                    if (fRec && fRec.blob) {
                        if (!fRec.blobRevision) {
                            fRec.blobRevision = generateRevision()
                            fRec.revisionOrigin = fRec.revisionOrigin || origin
                            fRec.documentHash = fRec.documentHash || null
                            fRec.updatedAt = Date.now()
                            fileStore.put(fRec)
                        }
                        if (bRec) {
                            if (!bRec.blobRevision) {
                                bRec.blobRevision = fRec.blobRevision
                                bRec.revisionOrigin = fRec.revisionOrigin
                                bRec.documentHash = fRec.documentHash
                            }
                            if (bRec.progress && !bRec.progress.blobRevision) {
                                bRec.progress.blobRevision = fRec.blobRevision
                                bRec.progress.revisionOrigin = fRec.revisionOrigin
                            }
                            bookStore.put(bRec)
                        }
                        persistedFile = fRec
                        persistedBook = bRec
                    }
                }
            }

            tx.oncomplete = () => {
                if (!persistedFile || !persistedFile.blob) {
                    return resolve(null)
                }
                resolve(Object.freeze({
                    bookId: id,
                    blob: persistedFile.blob,
                    blobRevision: persistedFile.blobRevision,
                    revisionOrigin: persistedFile.revisionOrigin || origin,
                    documentHash: persistedFile.documentHash || null,
                    nativePath: persistedFile.nativePath || null,
                    nativeSnapshotPath: persistedFile.nativeSnapshotPath || null,
                    nativeSnapshotRevision: persistedFile.nativeSnapshotRevision || null,
                    nativeSnapshotOrigin: persistedFile.nativeSnapshotOrigin || null,
                    nativeSnapshotSize: persistedFile.nativeSnapshotSize ?? null,
                    format: persistedBook?.format || null,
                    title: persistedBook?.title || '',
                    author: persistedBook?.author || '',
                    progress: persistedBook?.progress || null
                }))
            }

            tx.onerror = () => reject(tx.error || new Error(`Failed to backfill legacy book file snapshot ${id}`))
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted for legacy snapshot backfill ${id}`))
        } catch (err) {
            reject(err)
        }
    })
}


export const getBook = async id => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('books', 'readonly')
            const store = tx.objectStore('books')
            const req = store.get(id)
            req.onsuccess = () => resolve(withReadableBookTitle(req.result || null))
            req.onerror = () => reject(req.error || new Error(`Failed to get book ${id}`))
        } catch (err) {
            reject(err)
        }
    })
}

export const getAllBooks = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('books', 'readonly')
            const store = tx.objectStore('books')
            const req = store.getAll()
            req.onsuccess = () => {
                const list = (req.result || []).map(withReadableBookTitle)
                list.sort((a, b) => {
                    const aRead = a.lastReadAt || 0
                    const bRead = b.lastReadAt || 0
                    if (bRead !== aRead) return bRead - aRead
                    return (b.addedAt || 0) - (a.addedAt || 0)
                })
                resolve(list)
            }
            req.onerror = () => reject(req.error || new Error('Failed to get all books'))
        } catch (err) {
            reject(err)
        }
    })
}

// Map of bookId -> Promise chain to serialize progress updates per book
const _progressQueues = new Map()

export const updateBookProgress = async (id, progressData) => {
    if (!id) return null
    const prevQueue = _progressQueues.get(id) || Promise.resolve()
    const nextQueue = prevQueue.then(async () => {
        const db = await openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction('books', 'readwrite')
            const store = tx.objectStore('books')
            const getReq = store.get(id)
            getReq.onsuccess = () => {
                const book = getReq.result
                if (!book) return resolve(null)
                // Stale progress from an earlier snapshot or session must not overwrite newer progress
                if (book.progress?.updatedAt && progressData?.updatedAt && book.progress.updatedAt > progressData.updatedAt) {
                    return resolve(false)
                }
                book.progress = progressData
                book.lastReadAt = Math.max(book.lastReadAt || 0, progressData.updatedAt || Date.now())
                book.updatedAt = Date.now()
                store.put(book)
            }
            tx.oncomplete = () => {
                try {
                    clearPendingProgressBackup(id, progressData?.updatedAt, progressData?._backupId)
                } catch (e) {}
                try {
                    if (typeof BroadcastChannel !== 'undefined') {
                        const bc = new BroadcastChannel('linden-sync-bus')
                        bc.postMessage({ type: 'BOOK_PROGRESS_UPDATED', bookId: id, timestamp: Date.now() })
                        bc.close()
                    }
                } catch (e) {}
                resolve(true)
            }
            tx.onerror = () => reject(tx.error || new Error('Failed to update progress'))
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted updating progress'))
        })
    }).catch(err => {
        throw err
    })

    _progressQueues.set(id, nextQueue.catch(() => {}))
    return nextQueue
}

export const recordBookOpened = async (id, openedAt = Date.now()) => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            book.lastOpenedAt = Math.max(book.lastOpenedAt || 0, openedAt)
            if (book.readingStatus === 'unread' || book.readingStatus === 'want_to_read') {
                book.readingStatus = 'reading'
                book.updatedAt = Math.max(book.updatedAt || 0, openedAt)
            }
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to record book opened'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted recording book opened'))
    })
}

// Progress crash recovery backup
export const backupPendingProgress = (bookId, progress) => {
    if (!bookId || !progress || typeof localStorage === 'undefined') return false
    try {
        const backupId = `pbk_${bookId}_${progress.updatedAt || Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        progress._backupId = backupId
        const payload = {
            backupId,
            bookId,
            progress,
            timestamp: Date.now(),
            version: progress.updatedAt || Date.now()
        }

        let allBackups = {}
        try {
            const rawMap = localStorage.getItem('linden_pending_progress_backups')
            if (rawMap) allBackups = JSON.parse(rawMap) || {}
        } catch (e) {}
        allBackups[bookId] = payload
        localStorage.setItem('linden_pending_progress_backups', JSON.stringify(allBackups))

        // Legacy single key mirror
        localStorage.setItem('linden_pending_progress_backup', JSON.stringify(payload))
        return true
    } catch (e) {
        return false
    }
}

export const clearPendingProgressBackup = (bookId, updatedAt = null, backupId = null) => {
    if (!bookId || typeof localStorage === 'undefined') return
    try {
        let shouldClearLegacy = false
        const rawMap = localStorage.getItem('linden_pending_progress_backups')
        if (rawMap) {
            const allBackups = JSON.parse(rawMap) || {}
            const existing = allBackups[bookId]
            if (existing) {
                // Strict matching: if backupId provided, must match OR existing must be strictly older
                const idMatches = backupId != null && existing.backupId === backupId
                const isStrictlyOlder = updatedAt != null && existing.version < updatedAt && (existing.progress?.updatedAt || 0) < updatedAt
                const isExactTimeMatchWithoutId = backupId == null && updatedAt != null && existing.progress?.updatedAt === updatedAt

                if (idMatches || isStrictlyOlder || isExactTimeMatchWithoutId || (backupId == null && updatedAt == null)) {
                    delete allBackups[bookId]
                    localStorage.setItem('linden_pending_progress_backups', JSON.stringify(allBackups))
                    shouldClearLegacy = true
                }
            } else {
                shouldClearLegacy = true
            }
        }

        const raw = localStorage.getItem('linden_pending_progress_backup')
        if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed?.bookId === bookId) {
                const idMatches = backupId != null && parsed.backupId === backupId
                const isStrictlyOlder = updatedAt != null && parsed.version < updatedAt && (parsed.progress?.updatedAt || 0) < updatedAt
                const isExactTimeMatchWithoutId = backupId == null && updatedAt != null && parsed.progress?.updatedAt === updatedAt
                if (idMatches || isStrictlyOlder || isExactTimeMatchWithoutId || (backupId == null && updatedAt == null) || shouldClearLegacy) {
                    localStorage.removeItem('linden_pending_progress_backup')
                }
            }
        }
    } catch (e) {}
}

let _progressRecoveryPromise = null

export const recoverPendingProgressBackup = () => {
    if (_progressRecoveryPromise) return _progressRecoveryPromise
    _progressRecoveryPromise = (async () => {
        const result = {
            recovered: [],
            filtered: [],
            failed: [],
            deferred: []
        }
        if (typeof localStorage === 'undefined') return result
        try {
            let backupsToRecover = []
            let rawMapExists = false
            try {
                const rawMap = localStorage.getItem('linden_pending_progress_backups')
                if (rawMap) {
                    rawMapExists = true
                    const parsedMap = JSON.parse(rawMap)
                    if (parsedMap && typeof parsedMap === 'object') {
                        backupsToRecover = Object.values(parsedMap)
                    }
                }
            } catch (e) {}

            try {
                const rawLegacy = localStorage.getItem('linden_pending_progress_backup')
                if (rawLegacy) {
                    const parsedLegacy = JSON.parse(rawLegacy)
                    // Strict pairing: If rawMap exists, legacy key must correspond to an entry in rawMap
                    if (parsedLegacy?.bookId) {
                        const inMap = backupsToRecover.some(b => b.bookId === parsedLegacy.bookId)
                        if (!inMap && !rawMapExists) {
                            backupsToRecover.push(parsedLegacy)
                        } else if (!inMap && rawMapExists) {
                            // Stale legacy mirror: clean it up to prevent resurrection
                            localStorage.removeItem('linden_pending_progress_backup')
                        }
                    }
                }
            } catch (e) {}

            for (const data of backupsToRecover) {
                if (!data || !data.bookId || !data.progress) {
                    if (data?.bookId) clearPendingProgressBackup(data.bookId)
                    result.filtered.push({ bookId: data?.bookId, reason: 'malformed_data' })
                    continue
                }

                const { bookId, progress, backupId } = data
                try {
                    // 1. Check if book still exists
                    const book = await getBook(bookId)
                    if (!book) {
                        console.log(`[DB] Skipping progress backup for deleted book: ${bookId}`)
                        clearPendingProgressBackup(bookId, null, backupId)
                        result.filtered.push({ bookId, backupId, reason: 'book_deleted' })
                        continue
                    }

                    // 2. Check content identity
                    const snapshot = await getBookFileSnapshot(bookId)
                    if (snapshot) {
                        if (progress.blobRevision) {
                            const matchRes = isContentIdentityMatching(progress, snapshot)
                            if (!matchRes.matches) {
                                console.log(`[DB] Discarding progress backup due to content mismatch for book: ${bookId}`)
                                clearPendingProgressBackup(bookId, null, backupId)
                                result.filtered.push({ bookId, backupId, reason: 'content_mismatch' })
                                continue
                            }
                        } else {
                            // Legacy backup without blobRevision
                            if (progress.documentHash && snapshot.documentHash) {
                                if (progress.documentHash !== snapshot.documentHash) {
                                    console.log(`[DB] Discarding legacy progress backup due to documentHash conflict for book: ${bookId}`)
                                    clearPendingProgressBackup(bookId, null, backupId)
                                    result.filtered.push({ bookId, backupId, reason: 'hash_conflict' })
                                    continue
                                }
                            } else if (book.progress?.blobRevision && book.progress.blobRevision !== snapshot.blobRevision) {
                                console.log(`[DB] Discarding legacy progress backup lacking revision for replaced book: ${bookId}`)
                                clearPendingProgressBackup(bookId, null, backupId)
                                result.filtered.push({ bookId, backupId, reason: 'unconfirmed_legacy_revision' })
                                continue
                            }
                        }
                    }

                    // 3. Check timestamps (do not overwrite newer progress with older progress)
                    if (book.progress?.updatedAt && progress.updatedAt && book.progress.updatedAt > progress.updatedAt) {
                        console.log(`[DB] Discarding obsolete progress backup (newer progress exists) for book: ${bookId}`)
                        clearPendingProgressBackup(bookId, null, backupId)
                        result.filtered.push({ bookId, backupId, reason: 'obsolete_progress' })
                        continue
                    }

                    // 4. Update progress
                    const updated = await updateBookProgress(bookId, progress)
                    if (updated !== false && updated !== null) {
                        // 5. Clean up ONLY this backup item
                        clearPendingProgressBackup(bookId, progress.updatedAt, backupId)
                        console.log(`[DB] Successfully recovered progress backup for book: ${bookId}`)
                        result.recovered.push({ bookId, backupId, progress })
                    } else {
                        result.filtered.push({ bookId, backupId, reason: 'update_skipped' })
                    }
                } catch (itemErr) {
                    console.warn(`[DB] Failed to recover progress backup for book ${bookId}:`, itemErr)
                    // Retain backup on failure
                    result.failed.push({ bookId, backupId, error: itemErr, data })
                }
            }
        } catch (e) {
            console.warn('[DB] Failed to recover pending progress backup:', e)
        }
        return result
    })().finally(() => {
        _progressRecoveryPromise = null
    })
    return _progressRecoveryPromise
}

export const updateBookReadingTime = async (id, addedSeconds) => {
    if (!id || !addedSeconds || addedSeconds <= 0) return
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            book.totalReadingSeconds = (book.totalReadingSeconds || 0) + addedSeconds
            book.lastReadAt = Date.now()
            book.updatedAt = Date.now()
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update reading time'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted updating reading time'))
    })
}

export const updateBookMetadata = async (id, { title, author }) => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            if (title != null) book.title = title.trim()
            if (author != null) book.author = author.trim()
            book.updatedAt = Date.now()
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update book metadata'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted updating book metadata'))
    })
}

export const toggleBookFavorite = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        let isFav = false
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return
            book.isFavorite = !book.isFavorite
            book.favoriteUpdatedAt = Date.now()
            book.updatedAt = Date.now()
            isFav = book.isFavorite
            store.put(book)
        }
        tx.oncomplete = () => resolve(isFav)
        tx.onerror = () => reject(tx.error || new Error('Failed to toggle book favorite'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const relinkBookFile = async (bookId, fileData = {}) => {
    if (!bookId) return false
    const db = await openDB()
    const origin = await getRevisionOrigin()
    const { blob = null, nativePath = null, nativeSnapshotPath = null, documentHash = null } = fileData

    const newRevision = blob ? generateRevision() : null
    return new Promise((resolve, reject) => {
        const storeNames = ['books', 'book_files'].filter(s => db.objectStoreNames.contains(s))
        const tx = db.transaction(storeNames, 'readwrite')
        const bookStore = tx.objectStore('books')
        const fileStore = db.objectStoreNames.contains('book_files') ? tx.objectStore('book_files') : null
        let book = null

        const bookReq = bookStore.get(bookId)
        bookReq.onsuccess = () => {
            book = bookReq.result
            if (book) {
                if (blob) {
                    book.isCloudOnly = false
                    book.hasLocalFile = true
                    book.size = blob.size
                    book.blobRevision = newRevision
                    book.revisionOrigin = origin
                    book.documentHash = documentHash || null
                    delete book.blob
                    if (book.progress && typeof book.progress === 'object') book.progress = { ...book.progress, blobRevision: newRevision, revisionOrigin: origin, documentHash: documentHash || null }
                }
                if (nativePath !== undefined && nativePath !== null) {
                    book.nativePath = nativePath
                    book.filePath = nativePath
                }
                book.updatedAt = Date.now()
                bookStore.put(book)
            } else {
                tx.abort()
            }
        }

        if (fileStore) {
            const fileReq = fileStore.get(bookId)
            fileReq.onsuccess = () => {
                const local = fileReq.result || { id: bookId }
                if (blob) {
                    const isTauri = typeof platformBridge !== 'undefined' && platformBridge.isTauri
                    const effectiveSnapshotPath = nativeSnapshotPath || null
                    const format = (book?.format || '').toLowerCase()
                    const isLargeNativePdf = isTauri &&
                        (format === 'pdf' || (blob.type && blob.type.includes('pdf'))) &&
                        effectiveSnapshotPath &&
                        blob.size > LARGE_PDF_SNAPSHOT_THRESHOLD

                    local.blobRevision = newRevision
                    local.revisionOrigin = origin
                    local.documentHash = documentHash || null
                    local.nativeSnapshotPath = effectiveSnapshotPath
                    local.nativeSnapshotRevision = effectiveSnapshotPath ? local.blobRevision : null
                    local.nativeSnapshotOrigin = effectiveSnapshotPath ? origin : null
                    local.nativeSnapshotSize = effectiveSnapshotPath ? blob.size : null

                    if (isLargeNativePdf) {
                        local.blob = null
                        local.nativeSnapshotOnly = true
                    } else {
                        local.blob = blob
                        local.nativeSnapshotOnly = false
                    }
                } else if (documentHash) {
                    local.documentHash = documentHash
                }
                if (nativePath !== undefined && nativePath !== null) {
                    local.nativePath = nativePath
                }
                local.updatedAt = Date.now()
                fileStore.put(local)
            }
        }

        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error(`Failed to relink file for book ${bookId}`))
        tx.onabort = () => reject(tx.error || new Error(`Transaction aborted relinking book ${bookId}`))
    })
}

export const deleteBook = async (id, recordTombstone = true, tombstoneTime = Date.now()) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        try {
            const allPossibleStores = ['books', 'book_files', 'bookmarks', 'highlights', 'deleted_records', 'pdf_drawings', 'fulltext_index']
            const storeNames = allPossibleStores.filter(name => db.objectStoreNames.contains(name))
            const tx = db.transaction(storeNames, 'readwrite')
            
            // Delete main book entry and binary blob file
            const bookStore = tx.objectStore('books')
            const bookReq = bookStore.get(id)
            bookReq.onsuccess = () => {
                const book = bookReq.result
                const stableKey = book?.stableKey || null
                const documentHash = book?.documentHash || null
                const format = book?.format || null
                const size = book?.size || 0
                bookStore.delete(id)
                if (recordTombstone && storeNames.includes('deleted_records')) {
                    tx.objectStore('deleted_records').put({
                        id,
                        stableKey,
                        documentHash,
                        format,
                        size,
                        type: 'book',
                        deletedAt: tombstoneTime
                    })
                }
            }
            let oldSnapshotPath = null
            if (storeNames.includes('book_files')) {
                const fileStore = tx.objectStore('book_files')
                const fileReq = fileStore.get(id)
                fileReq.onsuccess = () => {
                    oldSnapshotPath = fileReq.result?.nativeSnapshotPath || null
                    fileStore.delete(id)
                }
            }
            if (storeNames.includes('fulltext_index')) {
                tx.objectStore('fulltext_index').delete(id)
            }
            
            // Safely clean up associated bookmarks, highlights, and pdf_drawings
            // Note: reading_sessions are PERMANENT user statistics logs and are NEVER purged on book removal!
            const cleanStoreByIndex = (storeName, indexName) => {
                try {
                    if (!storeNames.includes(storeName)) return
                    const store = tx.objectStore(storeName)
                    const index = store.index(indexName)
                    const req = index.getAllKeys(id)
                    req.onsuccess = () => {
                        const keys = req.result || []
                        const typeMap = { bookmarks: 'bookmark', highlights: 'highlight', books: 'book', pdf_drawings: 'pdfDrawing' }
                        const recType = typeMap[storeName] || storeName
                        for (const key of keys) {
                            store.delete(key)
                            if (recordTombstone && storeNames.includes('deleted_records')) {
                                tx.objectStore('deleted_records').put({ id: key, type: recType, deletedAt: tombstoneTime })
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[deleteBook] Clean ${storeName} error:`, e)
                }
            }

            cleanStoreByIndex('bookmarks', 'bookId')
            cleanStoreByIndex('highlights', 'bookId')
            cleanStoreByIndex('pdf_drawings', 'bookId')

            tx.oncomplete = () => {
                if (oldSnapshotPath && typeof platformBridge !== 'undefined' && platformBridge.reclaimSnapshot) {
                    openDB().then(db2 => {
                        if (!db2.objectStoreNames.contains('book_files')) return
                        const checkTx = db2.transaction(['book_files'], 'readonly')
                        const req = checkTx.objectStore('book_files').getAll()
                        req.onsuccess = () => {
                            const files = req.result || []
                            const isStillReferenced = files.some(f => f.id !== id && f.nativeSnapshotPath === oldSnapshotPath)
                            if (!isStillReferenced) {
                                platformBridge.reclaimSnapshot(oldSnapshotPath).catch(err => {
                                    console.warn('[db.deleteBook] Safe snapshot reclaim notice:', err)
                                })
                            }
                        }
                    }).catch(() => {})
                }
                invalidateReadingStatsCache()
                resolve(true)
            }
            tx.onerror = () => reject(tx.error || new Error(`Failed to delete book ${id}`))
            tx.onabort = () => reject(tx.error || new Error(`Delete transaction aborted for book ${id}`))
        } catch (err) {
            reject(err)
        }
    })
}

// Highlights & Notes
export const saveHighlight = async highlight => {
    if (!highlight || !highlight.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        store.put(highlight)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(highlight.id)
        }
        tx.oncomplete = () => {
            invalidateReadingStatsCache()
            resolve(highlight.id)
        }
        tx.onerror = () => reject(tx.error || new Error('Failed to save highlight'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving highlight'))
    })
}

export const applySyncedHighlight = async highlight => {
    if (!highlight || !highlight.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const hasDeleted = db.objectStoreNames.contains('deleted_records')
        const storeNames = hasDeleted ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        const delStore = hasDeleted ? tx.objectStore('deleted_records') : null

        const incomingTime = highlight.updatedAt || highlight.createdAt || 0

        const checkExistingAndPut = () => {
            const exReq = store.get(highlight.id)
            exReq.onsuccess = () => {
                const ex = exReq.result
                const exTime = ex ? (ex.updatedAt || ex.createdAt || 0) : 0
                if (ex && exTime > incomingTime) {
                    return resolve(false)
                }
                store.put(highlight)
                invalidateReadingStatsCache()
                resolve(true)
            }
            exReq.onerror = () => reject(exReq.error || new Error('Failed to get highlight'))
        }

        if (delStore) {
            const tombReq = delStore.get(highlight.id)
            tombReq.onsuccess = () => {
                const tomb = tombReq.result
                if (tomb && (tomb.deletedAt || 0) >= incomingTime) {
                    return resolve(false)
                }
                checkExistingAndPut()
            }
            tombReq.onerror = () => reject(tombReq.error || new Error('Failed to check deleted_records'))
        } else {
            checkExistingAndPut()
        }

        tx.oncomplete = () => {}
        tx.onerror = () => reject(tx.error || new Error('Transaction error saving synced highlight'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving synced highlight'))
    })
}

export const applySyncedHighlightsBatch = async (highlights = []) => {
    const valid = (highlights || []).filter(h => h && h.id)
    if (valid.length === 0) return 0
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const hasDeleted = db.objectStoreNames.contains('deleted_records')
        const storeNames = hasDeleted ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        const delStore = hasDeleted ? tx.objectStore('deleted_records') : null
        let applied = 0

        for (const highlight of valid) {
            const incomingTime = highlight.updatedAt || highlight.createdAt || 0
            const checkExistingAndPut = () => {
                const exReq = store.get(highlight.id)
                exReq.onsuccess = () => {
                    const ex = exReq.result
                    const exTime = ex ? (ex.updatedAt || ex.createdAt || 0) : 0
                    if (ex && exTime > incomingTime) return
                    store.put(highlight)
                    applied++
                }
            }
            if (delStore) {
                const tombReq = delStore.get(highlight.id)
                tombReq.onsuccess = () => {
                    const tomb = tombReq.result
                    if (tomb && (tomb.deletedAt || 0) >= incomingTime) return
                    checkExistingAndPut()
                }
            } else {
                checkExistingAndPut()
            }
        }

        tx.oncomplete = () => resolve(applied)
        tx.onerror = () => reject(tx.error || new Error('Batch transaction error saving synced highlights'))
        tx.onabort = () => reject(tx.error || new Error('Batch transaction aborted saving synced highlights'))
    })
}

export const getHighlightsByBook = async bookId => {
    if (!bookId) return []
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('highlights', 'readonly')
        const index = tx.objectStore('highlights').index('bookId')
        const req = index.getAll(bookId)
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get highlights'))
    })
}

export const getAllHighlights = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('highlights', 'readonly')
        const store = tx.objectStore('highlights')
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get all highlights'))
    })
}

export const deleteHighlight = async (id, recordTombstone = true, tombstoneTime = Date.now()) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const existing = getReq.result
            if (existing) {
                const exTime = existing.updatedAt || existing.createdAt || 0
                if (tombstoneTime && exTime > tombstoneTime) {
                    // Local highlight has been updated after the deletion tombstone. Protect it!
                    return resolve(false)
                }
            }
            store.delete(id)
            if (recordTombstone && storeNames.includes('deleted_records')) {
                tx.objectStore('deleted_records').put({ id, type: 'highlight', deletedAt: tombstoneTime })
            }
            invalidateReadingStatsCache()
            resolve(true)
        }
        getReq.onerror = () => reject(getReq.error || new Error('Failed to get highlight before deleting'))
        tx.oncomplete = () => {}
        tx.onerror = () => reject(tx.error || new Error('Failed to delete highlight'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted deleting highlight'))
    })
}

// Bookmarks
export const saveBookmark = async bookmark => {
    if (!bookmark || !bookmark.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        store.put(bookmark)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(bookmark.id)
        }
        tx.oncomplete = () => {
            invalidateReadingStatsCache()
            resolve(bookmark.id)
        }
        tx.onerror = () => reject(tx.error || new Error('Failed to save bookmark'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving bookmark'))
    })
}

export const applySyncedBookmark = async bookmark => {
    if (!bookmark || !bookmark.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const hasDeleted = db.objectStoreNames.contains('deleted_records')
        const storeNames = hasDeleted ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        const delStore = hasDeleted ? tx.objectStore('deleted_records') : null

        const incomingTime = bookmark.updatedAt || bookmark.createdAt || 0

        const checkExistingAndPut = () => {
            const exReq = store.get(bookmark.id)
            exReq.onsuccess = () => {
                const ex = exReq.result
                const exTime = ex ? (ex.updatedAt || ex.createdAt || 0) : 0
                if (ex && exTime > incomingTime) {
                    return resolve(false)
                }
                store.put(bookmark)
                invalidateReadingStatsCache()
                resolve(true)
            }
            exReq.onerror = () => reject(exReq.error || new Error('Failed to get bookmark'))
        }

        if (delStore) {
            const tombReq = delStore.get(bookmark.id)
            tombReq.onsuccess = () => {
                const tomb = tombReq.result
                if (tomb && (tomb.deletedAt || 0) >= incomingTime) {
                    return resolve(false)
                }
                checkExistingAndPut()
            }
            tombReq.onerror = () => reject(tombReq.error || new Error('Failed to check deleted_records'))
        } else {
            checkExistingAndPut()
        }

        tx.oncomplete = () => {}
        tx.onerror = () => reject(tx.error || new Error('Transaction error saving synced bookmark'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving synced bookmark'))
    })
}

export const applySyncedBookmarksBatch = async (bookmarks = []) => {
    const valid = (bookmarks || []).filter(b => b && b.id)
    if (valid.length === 0) return 0
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const hasDeleted = db.objectStoreNames.contains('deleted_records')
        const storeNames = hasDeleted ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        const delStore = hasDeleted ? tx.objectStore('deleted_records') : null
        let applied = 0

        for (const bookmark of valid) {
            const incomingTime = bookmark.updatedAt || bookmark.createdAt || 0
            const checkExistingAndPut = () => {
                const exReq = store.get(bookmark.id)
                exReq.onsuccess = () => {
                    const ex = exReq.result
                    const exTime = ex ? (ex.updatedAt || ex.createdAt || 0) : 0
                    if (ex && exTime > incomingTime) return
                    store.put(bookmark)
                    applied++
                }
            }
            if (delStore) {
                const tombReq = delStore.get(bookmark.id)
                tombReq.onsuccess = () => {
                    const tomb = tombReq.result
                    if (tomb && (tomb.deletedAt || 0) >= incomingTime) return
                    checkExistingAndPut()
                }
            } else {
                checkExistingAndPut()
            }
        }

        tx.oncomplete = () => resolve(applied)
        tx.onerror = () => reject(tx.error || new Error('Batch transaction error saving synced bookmarks'))
        tx.onabort = () => reject(tx.error || new Error('Batch transaction aborted saving synced bookmarks'))
    })
}

export const getBookmarksByBook = async bookId => {
    if (!bookId) return []
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly')
        const index = tx.objectStore('bookmarks').index('bookId')
        const req = index.getAll(bookId)
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get bookmarks'))
    })
}

export const getAllBookmarks = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly')
        const store = tx.objectStore('bookmarks')
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get all bookmarks'))
    })
}

export const deleteBookmark = async (id, recordTombstone = true, tombstoneTime = Date.now()) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const existing = getReq.result
            if (existing) {
                const exTime = existing.updatedAt || existing.createdAt || 0
                if (tombstoneTime && exTime > tombstoneTime) {
                    // Local bookmark has been updated after the deletion tombstone. Protect it!
                    return resolve(false)
                }
            }
            store.delete(id)
            if (recordTombstone && storeNames.includes('deleted_records')) {
                tx.objectStore('deleted_records').put({ id, type: 'bookmark', deletedAt: tombstoneTime })
            }
            invalidateReadingStatsCache()
            resolve(true)
        }
        getReq.onerror = () => reject(getReq.error || new Error('Failed to get bookmark before deleting'))
        tx.oncomplete = () => {}
        tx.onerror = () => reject(tx.error || new Error('Failed to delete bookmark'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted deleting bookmark'))
    })
}

// Settings
export const getSetting = async (key, defaultValue = null) => {
    try {
        const db = await openDB()
        return new Promise(resolve => {
            try {
                const tx = db.transaction('settings', 'readonly')
                const req = tx.objectStore('settings').get(key)
                req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue)
                req.onerror = () => resolve(defaultValue)
            } catch (err) {
                resolve(defaultValue)
            }
        })
    } catch (e) {
        return defaultValue
    }
}

export const setSetting = async (key, value) => {
    try {
        const db = await openDB()
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction('settings', 'readwrite')
                tx.objectStore('settings').put({ key, value })
                tx.oncomplete = () => resolve(true)
                tx.onerror = () => reject(tx.error || new Error('Failed to save setting'))
            } catch (err) {
                reject(err)
            }
        })
    } catch (e) {
        return false
    }
}

// ==========================================
// ==========================================
// Reading Sessions & Reading Analytics
// ==========================================

export const mergeSessionIntervals = (ivListA = [], ivListB = []) => {
    const combined = []
    const add = (list) => {
        if (!Array.isArray(list)) return
        for (const iv of list) {
            let s = 0, e = 0
            if (Array.isArray(iv) && iv.length >= 2) {
                s = typeof normalizeTimestampMs === 'function' ? normalizeTimestampMs(iv[0]) : Number(iv[0])
                e = typeof normalizeTimestampMs === 'function' ? normalizeTimestampMs(iv[1]) : Number(iv[1])
            } else if (iv && typeof iv === 'object') {
                s = typeof normalizeTimestampMs === 'function' ? normalizeTimestampMs(iv.start ?? iv.startMs) : Number(iv.start ?? iv.startMs)
                e = typeof normalizeTimestampMs === 'function' ? normalizeTimestampMs(iv.end ?? iv.endMs) : Number(iv.end ?? iv.endMs)
            }
            if (e > s) combined.push([s, e])
        }
    }
    add(ivListA)
    add(ivListB)
    if (combined.length === 0) return []
    combined.sort((a, b) => a[0] - b[0])
    const merged = [combined[0]]
    for (let i = 1; i < combined.length; i++) {
        const last = merged[merged.length - 1]
        const curr = combined[i]
        if (curr[0] <= last[1]) {
            last[1] = Math.max(last[1], curr[1])
        } else {
            merged.push(curr)
        }
    }
    return merged
}

export const calculateIntervalUnionSeconds = (intervals = []) => {
    if (!Array.isArray(intervals) || intervals.length === 0) return 0
    let totalMs = 0
    for (const iv of intervals) {
        if (Array.isArray(iv) && iv.length >= 2) {
            totalMs += Math.max(0, iv[1] - iv[0])
        } else if (iv && typeof iv === 'object') {
            const s = Number(iv.start ?? iv.startMs ?? 0)
            const e = Number(iv.end ?? iv.endMs ?? 0)
            totalMs += Math.max(0, e - s)
        }
    }
    return Math.round(totalMs / 1000)
}

export const recordReadingSession = async (session, updateBookTotal = true) => {
    if (!session || !session.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = updateBookTotal ? ['reading_sessions', 'books'] : ['reading_sessions']
        const tx = db.transaction(storeNames, 'readwrite')
        const sessStore = tx.objectStore('reading_sessions')
        const bookStore = updateBookTotal ? tx.objectStore('books') : null

        const getSessReq = sessStore.get(session.id)
        getSessReq.onsuccess = () => {
            const existing = getSessReq.result
            const prevDuration = (existing && existing.durationSeconds) ? existing.durationSeconds : 0
            const incomingDuration = session.durationSeconds || 0
            const effectiveDuration = Math.max(prevDuration, incomingDuration)

            const mergedIntervals = mergeSessionIntervals(existing?.activeIntervals, session?.activeIntervals)
            const intervalSecs = calculateIntervalUnionSeconds(mergedIntervals)

            const prevActive = (existing && typeof existing.activeDurationSeconds === 'number') ? existing.activeDurationSeconds : 0
            const incomingActive = (session && typeof session.activeDurationSeconds === 'number') ? session.activeDurationSeconds : 0
            const effectiveActive = Math.max(prevActive, incomingActive, intervalSecs)
            const delta = Math.max(0, effectiveDuration - prevDuration)
            
            const mergedSession = {
                ...existing,
                ...session,
                durationSeconds: effectiveDuration,
                activeDurationSeconds: effectiveActive,
                activeIntervals: mergedIntervals.length > 0 ? mergedIntervals : (existing?.activeIntervals || session?.activeIntervals || []),
                startTime: existing?.startTime ? Math.min(existing.startTime, session.startTime || existing.startTime) : session.startTime,
                endTime: Math.max(existing?.endTime || 0, session.endTime || 0) || Date.now(),
            }
            sessStore.put(mergedSession)

            // Increment book totalReadingSeconds only in normal reading, and totalListeningSeconds for listening
            if (updateBookTotal && session.bookId && delta > 0 && bookStore) {
                const getBookReq = bookStore.get(session.bookId)
                getBookReq.onsuccess = () => {
                    const book = getBookReq.result
                    if (book) {
                        const isListen = Boolean(session.isListening || session.kind === 'listen')
                        if (isListen) {
                            book.totalListeningSeconds = (book.totalListeningSeconds || 0) + delta
                        } else {
                            book.totalReadingSeconds = (book.totalReadingSeconds || 0) + delta
                        }
                        book.lastReadAt = Math.max(book.lastReadAt || 0, Number(session.endTime) || Date.now())
                        bookStore.put(book)
                    }
                }
            }
        }

        tx.oncomplete = () => {
            invalidateReadingStatsCache()
            resolve(session.id)
        }
        tx.onerror = () => reject(tx.error || new Error('Failed to record session'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const saveReadingSession = recordReadingSession

export const saveReadingSessionsBatch = async (sessions = []) => {
    const valid = (sessions || []).filter(s => s && (s.id || s.bookId)).map(s => {
        if (!s.id) {
            return {
                ...s,
                id: `${s.bookId}_${s.startTime || Date.now()}_${Math.random().toString(36).slice(2, 7)}`
            }
        }
        return s
    })
    if (valid.length === 0) return 0
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['reading_sessions'], 'readwrite')
        const sessStore = tx.objectStore('reading_sessions')
        for (const session of valid) {
            const getReq = sessStore.get(session.id)
            getReq.onsuccess = () => {
                const existing = getReq.result
                if (existing) {
                    const prevDuration = existing.durationSeconds || 0
                    const incomingDuration = session.durationSeconds || 0
                    const effectiveDuration = Math.max(prevDuration, incomingDuration)

                    const mergedIntervals = mergeSessionIntervals(existing.activeIntervals, session.activeIntervals)
                    const intervalSecs = calculateIntervalUnionSeconds(mergedIntervals)

                    const prevActive = (typeof existing.activeDurationSeconds === 'number') ? existing.activeDurationSeconds : 0
                    const incomingActive = (typeof session.activeDurationSeconds === 'number') ? session.activeDurationSeconds : 0
                    const effectiveActive = Math.max(prevActive, incomingActive, intervalSecs)

                    const merged = {
                        ...existing,
                        ...session,
                        durationSeconds: effectiveDuration,
                        activeDurationSeconds: effectiveActive,
                        activeIntervals: mergedIntervals.length > 0 ? mergedIntervals : (existing.activeIntervals || session.activeIntervals || []),
                        startTime: existing.startTime ? Math.min(existing.startTime, session.startTime || existing.startTime) : session.startTime,
                        endTime: Math.max(existing.endTime || 0, session.endTime || 0) || Date.now(),
                    }
                    sessStore.put(merged)
                } else {
                    sessStore.put(session)
                }
            }
        }
        tx.oncomplete = () => {
            invalidateReadingStatsCache()
            resolve(valid.length)
        }
        tx.onerror = () => reject(tx.error || new Error('Failed batch saving reading sessions'))
        tx.onabort = () => reject(tx.error || new Error('Batch reading sessions transaction aborted'))
    })
}

export const getAllReadingSessions = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reading_sessions', 'readonly')
        const store = tx.objectStore('reading_sessions')
        const req = store.getAll()
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => normalizeTimestampMs(b.startTime) - normalizeTimestampMs(a.startTime))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get sessions'))
    })
}

export const getSessionDur = s => {
    if (!s) return 0
    const v = s.activeDurationSeconds != null ? s.activeDurationSeconds
        : s.durationSeconds != null ? s.durationSeconds
        : s.readingSeconds != null ? s.readingSeconds
        : s.seconds != null ? s.seconds : 0
    return typeof v === 'number' && !isNaN(v) && v > 0 ? Math.round(v) : 0
}

export const computeActiveSessionSeconds = (sessList) => {
    if (!sessList) return 0
    const rawIntervals = []
    let unintervaledSeconds = 0
    for (const s of sessList) {
        const dur = getSessionDur(s)
        if (dur <= 0) continue
        // Only construct intervals if activeIntervals was explicitly recorded (LL-28)
        if (Array.isArray(s.activeIntervals) && s.activeIntervals.length > 0) {
            const before = rawIntervals.length
            for (const iv of s.activeIntervals) {
                if (Array.isArray(iv) && iv.length >= 2) {
                    const st = normalizeTimestampMs(iv[0])
                    const et = normalizeTimestampMs(iv[1])
                    if (et > st) {
                        rawIntervals.push([st, et])
                    }
                }
            }
            if (rawIntervals.length === before) unintervaledSeconds += dur
        } else {
            unintervaledSeconds += dur
        }
    }
    if (rawIntervals.length === 0) return unintervaledSeconds
    rawIntervals.sort((a, b) => a[0] - b[0])
    let unionSecs = 0
    let cur = [rawIntervals[0][0], rawIntervals[0][1]]
    for (let i = 1; i < rawIntervals.length; i++) {
        const next = rawIntervals[i]
        if (next[0] <= cur[1]) {
            cur[1] = Math.max(cur[1], next[1])
        } else {
            unionSecs += (cur[1] - cur[0]) / 1000
            cur = [next[0], next[1]]
        }
    }
    unionSecs += (cur[1] - cur[0]) / 1000
    return Math.round(unionSecs) + unintervaledSeconds
}

let _statsRevision = 1
let _cachedAggregatedStats = null

export const invalidateReadingStatsCache = () => {
    _statsRevision++
    _cachedAggregatedStats = null
}

// Calculate Reading Full Statistics (Supports Week, Month, Year, Total views)
export const getReadingStats = async (viewMode = 'month', targetYear = new Date().getFullYear(), targetMonth = new Date().getMonth() + 1, weekOffset = 0) => {
    const _normalizeTimestampMs = typeof normalizeTimestampMs === 'function' ? normalizeTimestampMs : (t) => {
        if (!t) return 0
        if (typeof t === 'number') return t
        const p = Date.parse(t)
        return isNaN(p) ? 0 : p
    }
    const _getSessionDur = typeof getSessionDur === 'function' ? getSessionDur : (s) => {
        if (!s) return 0
        const v = s.activeDurationSeconds != null ? s.activeDurationSeconds
            : s.durationSeconds != null ? s.durationSeconds
            : s.readingSeconds != null ? s.readingSeconds
            : s.seconds != null ? s.seconds : 0
        return typeof v === 'number' && !isNaN(v) && v > 0 ? Math.round(v) : 0
    }
    const _computeActiveSessionSeconds = typeof computeActiveSessionSeconds === 'function' ? computeActiveSessionSeconds : (sessList) => {
        if (!sessList) return 0
        let total = 0
        for (const s of sessList) {
            total += _getSessionDur(s)
        }
        return total
    }
    const _resolveReadingState = typeof resolveReadingState === 'function' ? resolveReadingState : (b) => {
        if (!b) return 'unread'
        if (b.readingStatus) return b.readingStatus
        if (b.status) return b.status
        if (b.completedAt) return 'finished'
        const f = b.progress?.fraction || 0
        return f >= 0.999 ? 'finished' : (f > 0 ? 'reading' : 'unread')
    }

    let agg = _cachedAggregatedStats
    if (!agg || agg.rev !== _statsRevision) {
        const allRawSessions = await getAllReadingSessions()
        const sessions = allRawSessions.filter(s => s && _getSessionDur(s) > 0)
        const books = await getAllBooks()
        const highlights = await getAllHighlights()
        const bookTitles = new Map(books.map(book => [book.id, book.title]))

        const now = new Date()
        let totalSeconds = 0
        const dailyMap = {} // 'YYYY-MM-DD' -> seconds
        const monthlyMap = {} // 'YYYY-MM' -> seconds
        const yearlyMap = {} // 'YYYY' -> seconds
        const activeDates = new Set()
        let earliestTime = now.getTime()

        const dayGroupMap = new Map()
        for (const sess of sessions) {
            const d = sess.date || toLocalDateKey(sess.startTime || now)
            if (!dayGroupMap.has(d)) dayGroupMap.set(d, [])
            dayGroupMap.get(d).push(sess)

            const sStart = _normalizeTimestampMs(sess.startTime)
            if (sStart && sStart < earliestTime) {
                earliestTime = sStart
            }
        }

        for (const [d, daySessions] of dayGroupMap.entries()) {
            const dur = _computeActiveSessionSeconds(daySessions)
            totalSeconds += dur
            dailyMap[d] = dur
            const ym = d.slice(0, 7)
            monthlyMap[ym] = (monthlyMap[ym] || 0) + dur
            const y = d.slice(0, 4)
            yearlyMap[y] = (yearlyMap[y] || 0) + dur
        }

        // Active reading days: any natural day with total reading time in dailyMap >= 60 seconds
        for (const [d, daySecs] of Object.entries(dailyMap)) {
            if (daySecs >= 60) {
                activeDates.add(d)
            }
        }

        let unallocatedHistoricalSeconds = 0
        for (const b of books) {
            if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
                const bTime = b.lastReadAt || b.addedAt || now.getTime()
                if (bTime < earliestTime) earliestTime = bTime
            }
        }
        let totalBookFallback = 0
        for (const b of books) {
            if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
                totalBookFallback += b.totalReadingSeconds
            }
        }
        if (totalBookFallback > totalSeconds) {
            unallocatedHistoricalSeconds = totalBookFallback - totalSeconds
        }

        agg = {
            rev: _statsRevision,
            books,
            highlights,
            bookTitles,
            totalSeconds,
            dailyMap,
            monthlyMap,
            yearlyMap,
            activeDates,
            earliestTime,
            unallocatedHistoricalSeconds
        }
        _cachedAggregatedStats = agg
    }

    const { books, highlights, bookTitles, totalSeconds, dailyMap, monthlyMap, yearlyMap, activeDates, earliestTime, unallocatedHistoricalSeconds } = agg
    const now = new Date()
    const todayStr = toLocalDateKey(now)
    const finalTotalSeconds = totalSeconds + unallocatedHistoricalSeconds

    // Calculate true consecutive reading streak days
    let streakDays = 0
    const todayKey = todayStr
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterdayKey = toLocalDateKey(yesterdayDate)

    let curCheck = new Date(now)
    if (activeDates.has(todayKey)) {
        streakDays = 1
        curCheck.setDate(curCheck.getDate() - 1)
    } else if (activeDates.has(yesterdayKey)) {
        curCheck = yesterdayDate
    }

    if (activeDates.has(todayKey) || activeDates.has(yesterdayKey)) {
        while (true) {
            const k = toLocalDateKey(curCheck)
            if (activeDates.has(k)) {
                if (k !== todayKey) streakDays++
                curCheck.setDate(curCheck.getDate() - 1)
            } else {
                break
            }
        }
    }

    // 1. Overall Stats
    const todaySeconds = dailyMap[todayStr] || 0
    const finishedCount = books.filter(b => _resolveReadingState(b) === 'finished').length
    const companionDays = Math.max(1, Math.floor((now.getTime() - earliestTime) / (86400 * 1000)) + 1)

    // 2. View Specific Distribution Charts
    let chartData = []
    let viewTotalSeconds = 0
    let peakInfo = { label: '', timeStr: '', seconds: 0 }
    let viewReadDays = 0
    let weekDateRangeStr = ''
    let monday = null
    let sunday = null

    if (viewMode === 'week') {
        // Calculate Monday through Sunday for (current week + weekOffset)
        const baseDate = new Date(now)
        baseDate.setDate(baseDate.getDate() + (weekOffset * 7))
        const curDay = baseDate.getDay() || 7 // 1 (Mon) to 7 (Sun)
        monday = new Date(baseDate)
        monday.setDate(baseDate.getDate() - curDay + 1)
        monday.setHours(0, 0, 0, 0)
        sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        sunday.setHours(23, 59, 59, 999)

        if (monday.getFullYear() !== sunday.getFullYear()) {
            weekDateRangeStr = `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 - ${sunday.getFullYear()}年${sunday.getMonth() + 1}月${sunday.getDate()}日`
        } else if (monday.getFullYear() !== now.getFullYear()) {
            weekDateRangeStr = `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 - ${sunday.getMonth() + 1}月${sunday.getDate()}日`
        } else {
            weekDateRangeStr = `${monday.getMonth() + 1}月${monday.getDate()}日 - ${sunday.getMonth() + 1}月${sunday.getDate()}日`
        }
        const weekLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

        for (let i = 0; i < 7; i++) {
            const d = new Date(monday)
            d.setDate(monday.getDate() + i)
            const dateStr = toLocalDateKey(d)
            const secs = dailyMap[dateStr] || 0
            viewTotalSeconds += secs
            if (secs >= 60) viewReadDays++
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${weekLabels[i]}阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: weekLabels[i],
                subLabel: `${d.getMonth() + 1}/${d.getDate()}`,
                fullDate: `${d.getMonth() + 1}月${d.getDate()}日 (${weekLabels[i]})`,
                seconds: secs,
                minutes: mins,
                isCurrent: dateStr === todayStr
            })
        }
    } else if (viewMode === 'month') {
        // 1 to N days of target month in LOCAL time
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate()
        const curMonthStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}`

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${curMonthStr}-${String(day).padStart(2, '0')}`
            const secs = dailyMap[dateStr] || 0
            viewTotalSeconds += secs
            if (secs >= 60) viewReadDays++
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${day}日阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${day}`,
                fullDate: `${targetMonth}月${day}日`,
                seconds: secs,
                minutes: mins,
                isCurrent: dateStr === todayStr && targetYear === now.getFullYear() && targetMonth === (now.getMonth() + 1),
                isKeyTick: day === 1 || day === 5 || day === 10 || day === 15 || day === 20 || day === 25 || day === daysInMonth
            })
        }
    } else if (viewMode === 'year') {
        // Count active days in this year
        const yearPrefix = `${targetYear}-`
        for (const [d, s] of Object.entries(dailyMap)) {
            if (d.startsWith(yearPrefix) && s >= 60) {
                viewReadDays++
            }
        }
        // 1 to 12 months of target year
        for (let m = 1; m <= 12; m++) {
            const ym = `${targetYear}-${String(m).padStart(2, '0')}`
            const secs = monthlyMap[ym] || 0
            viewTotalSeconds += secs
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${m}月阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${m}月`,
                fullDate: `${targetYear}年${m}月`,
                seconds: secs,
                minutes: mins,
                isCurrent: m === (now.getMonth() + 1) && targetYear === now.getFullYear()
            })
        }
    } else if (viewMode === 'total') {
        viewReadDays = activeDates.size
        // Multi-year distribution
        const startY = Math.min(new Date(earliestTime).getFullYear(), now.getFullYear() - 3)
        const endY = now.getFullYear()
        for (let y = startY; y <= endY; y++) {
            const secs = yearlyMap[String(y)] || 0
            viewTotalSeconds += secs
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${y}年阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${y}年`,
                fullDate: `${y}年`,
                seconds: secs,
                minutes: mins,
                isCurrent: y === endY
            })
        }
        if (finalTotalSeconds > viewTotalSeconds) {
            const diff = finalTotalSeconds - viewTotalSeconds
            const curYearItem = chartData.find(c => c.isCurrent) || chartData[chartData.length - 1]
            if (curYearItem) {
                curYearItem.seconds += diff
                curYearItem.minutes = Math.floor(curYearItem.seconds / 60)
            }
            viewTotalSeconds = finalTotalSeconds
        }
    }

    // Filter sessions belonging to the current viewMode period
    const mondayKey = viewMode === 'week' ? toLocalDateKey(monday) : null
    const sundayKey = viewMode === 'week' ? toLocalDateKey(sunday) : null
    const monthPrefix = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
    const yearPrefix = `${targetYear}-`
    const isSessInPeriod = (s) => {
        if (!s) return false
        const d = s.date || toLocalDateKey(s.startTime || now)
        if (viewMode === 'week') {
            return d >= mondayKey && d <= sundayKey
        }
        if (viewMode === 'month') {
            return d.startsWith(monthPrefix)
        }
        if (viewMode === 'year') {
            return d.startsWith(yearPrefix)
        }
        return true // 'total'
    }

    const periodSessions = sessions.filter(isSessInPeriod)
    const periodBookDurationMap = new Map()
    const periodBookSessions = new Map()
    periodSessions.forEach(s => {
        if (s.bookId) {
            if (!periodBookSessions.has(s.bookId)) periodBookSessions.set(s.bookId, [])
            periodBookSessions.get(s.bookId).push(s)
        }
    })
    for (const [bId, bSessList] of periodBookSessions.entries()) {
        periodBookDurationMap.set(bId, _computeActiveSessionSeconds(bSessList))
    }

    const allSessionBookMap = new Map()
    const allBookSessions = new Map()
    for (const sess of allRawSessions) {
        if (sess && sess.bookId && (_getSessionDur(sess) > 0)) {
            if (!allBookSessions.has(sess.bookId)) allBookSessions.set(sess.bookId, [])
            allBookSessions.get(sess.bookId).push(sess)
        }
    }
    for (const [bId, bSessList] of allBookSessions.entries()) {
        allSessionBookMap.set(bId, _computeActiveSessionSeconds(bSessList))
    }
    const localBookMap = new Map(books.map(b => [b.id, b]))
    const enrichedBooks = books.map(b => {
        const sessTotal = allSessionBookMap.get(b.id) || 0
        return {
            ...b,
            totalReadingSeconds: Math.max(b.totalReadingSeconds || 0, sessTotal)
        }
    })

    // Collect all bookIds that appear in sessions but are not in local books
    // (e.g. read on another device and synced via WebDAV, or locally deleted book)
    for (const [bId, bSessList] of allBookSessions.entries()) {
        if (!localBookMap.has(bId)) {
            const sorted = [...bSessList].sort((a, b) => {
                const ta = _normalizeTimestampMs(a.endTime || a.startTime || 0)
                const tb = _normalizeTimestampMs(b.endTime || b.startTime || 0)
                return tb - ta
            })
            const latestSession = sorted[0] || {}
            const sessTotal = allSessionBookMap.get(bId) || 0
            enrichedBooks.push({
                id: bId,
                title: latestSession.bookTitle || '跨端同步或已归档图书',
                author: latestSession.bookAuthor || '未知作者',
                cover: null,
                format: 'epub',
                totalReadingSeconds: sessTotal,
                isCloudOrArchived: true,
                progress: { fraction: latestSession.endProgress || 0 }
            })
        }
    }

    const topBooks = [...enrichedBooks].sort((a, b) => (b.totalReadingSeconds || 0) - (a.totalReadingSeconds || 0))

    const isCurrentPeriod = (viewMode === 'month' && targetYear === now.getFullYear() && targetMonth === (now.getMonth() + 1))
        || (viewMode === 'week' && weekOffset === 0)
        || (viewMode === 'year' && targetYear === now.getFullYear())
        || (viewMode === 'total')

    let periodBooks = []
    if (viewMode === 'total') {
        // In 'total' view, reflect all books that have either session duration or totalReadingSeconds
        periodBooks = enrichedBooks
            .map(b => {
                const sessDur = periodBookDurationMap.get(b.id) || 0
                const bookDur = b.totalReadingSeconds || 0
                const dur = Math.max(sessDur, bookDur)
                return {
                    ...b,
                    periodReadingSeconds: dur,
                    totalReadingSeconds: dur
                }
            })
            .filter(b => b.periodReadingSeconds > 0)
            .sort((a, b) => b.periodReadingSeconds - a.periodReadingSeconds)

        // Reconcile total view with periodBooks sum
        const periodBooksSum = periodBooks.reduce((sum, b) => sum + (b.periodReadingSeconds || 0), 0)
        if (periodBooksSum > viewTotalSeconds) {
            const diff = periodBooksSum - viewTotalSeconds
            const curItem = chartData.find(c => c.isCurrent) || chartData[chartData.length - 1]
            if (curItem) {
                curItem.seconds += diff
                curItem.minutes = Math.round(curItem.seconds / 60)
            }
            viewTotalSeconds = periodBooksSum
        }
    } else if (periodBookDurationMap.size > 0) {
        // For specific periods (week, month, year), period duration comes strictly from period sessions
        periodBooks = enrichedBooks
            .filter(b => periodBookDurationMap.has(b.id))
            .map(b => {
                const sessDur = periodBookDurationMap.get(b.id) || 0
                const bookDur = b.totalReadingSeconds || 0
                return {
                    ...b,
                    periodReadingSeconds: sessDur,
                    totalReadingSeconds: Math.max(bookDur, sessDur)
                }
            })
            .sort((a, b) => b.periodReadingSeconds - a.periodReadingSeconds)
    }

    const isCompletedInPeriod = (b) => {
        if (!b) return false
        const isFinished = _resolveReadingState(b) === 'finished'
        if (!isFinished) return false
        if (viewMode === 'total') return true
        const finishTime = b.completedAt || b.lastReadAt || b.updatedAt
        if (finishTime) {
            const d = toLocalDateKey(finishTime)
            if (viewMode === 'week') {
                return d >= mondayKey && d <= sundayKey
            }
            if (viewMode === 'month') {
                return d.startsWith(monthPrefix)
            }
            if (viewMode === 'year') {
                return d.startsWith(yearPrefix)
            }
            return true
        }
        return false
    }
    const periodFinishedBooks = books.filter(isCompletedInPeriod)

    // Compute finished books in current calendar year (for annual reading goal ring)
    const curYearPrefix = `${now.getFullYear()}-`
    const currentYearFinishedBooks = books.filter(b => {
        if (!b) return false
        if (_resolveReadingState(b) !== 'finished') return false
        const finishTime = b.completedAt || b.lastReadAt || b.updatedAt
        return finishTime ? toLocalDateKey(finishTime).startsWith(curYearPrefix) : false
    })
    const currentYearFinishedCount = currentYearFinishedBooks.length

    // Compute finished books in targetYear (if viewing historical year)
    const targetYearPrefix = `${targetYear}-`
    const targetYearFinishedBooks = books.filter(b => {
        if (!b) return false
        if (_resolveReadingState(b) !== 'finished') return false
        const finishTime = b.completedAt || b.lastReadAt || b.updatedAt
        return finishTime ? toLocalDateKey(finishTime).startsWith(targetYearPrefix) : false
    })
    const yearFinishedCount = targetYearFinishedBooks.length

    // Active reading duration in current calendar month & year
    const curMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const currentMonthSeconds = monthlyMap[curMonthKey] || 0
    const currentYearSeconds = yearlyMap[String(now.getFullYear())] || 0

    const periodHighlights = highlights.filter(h => {
        if (!h) return false
        const hTime = h.createdAt || h.updatedAt || 0
        const d = toLocalDateKey(hTime)
        if (viewMode === 'week') {
            const mondayKey = toLocalDateKey(monday)
            const sundayKey = toLocalDateKey(sunday)
            return d >= mondayKey && d <= sundayKey
        }
        if (viewMode === 'month') {
            const ym = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
            return d.startsWith(ym)
        }
        if (viewMode === 'year') {
            return d.startsWith(`${targetYear}-`)
        }
        return true
    })

    const totalRoundedMins = Math.round(viewTotalSeconds / 60)

    return {
        viewMode,
        targetYear,
        targetMonth,
        weekOffset,
        weekDateRangeStr,
        todaySeconds,
        todayMinutes: Math.round(todaySeconds / 60),
        viewTotalSeconds,
        viewHours: Math.floor(totalRoundedMins / 60),
        viewMins: totalRoundedMins % 60,
        viewReadDays,
        totalSeconds: finalTotalSeconds,
        totalHours: parseFloat((finalTotalSeconds / 3600).toFixed(1)),
        unallocatedHistoricalSeconds,
        streakDays,
        activeDaysCount: activeDates.size,
        companionDays,
        earliestDateStr: new Date(earliestTime).toLocaleDateString('zh-CN'),
        finishedCount,
        currentYearFinishedCount,
        yearFinishedCount,
        currentMonthSeconds,
        targetMonthSeconds: monthlyMap[monthPrefix] || 0,
        currentYearSeconds,
        targetYearSeconds: yearlyMap[String(targetYear)] || 0,
        totalBooksCount: books.length,
        totalHighlightsCount: highlights.length,
        periodBooks,
        periodBooksCount: periodBooks.length,
        periodFinishedBooks,
        periodFinishedCount: periodFinishedBooks.length,
        periodHighlights: periodHighlights.map(note => ({ ...note, bookTitle: note.bookTitle || bookTitles.get(note.bookId) || '已移除的图书' })),
        periodHighlightsCount: periodHighlights.length,
        chartData,
        peakInfo: peakInfo.seconds > 0 ? peakInfo : null,
        topBooks: topBooks.slice(0, 10),
        recentSessions: sessions.slice(0, 15).map(session => ({ ...session, bookTitle: session.bookTitle || bookTitles.get(session.bookId) || '已移除的图书', date: session.date || toLocalDateKey(session.startTime) }))
    }
}

// ==========================================================
// Custom Reading Lists CRUD
// ==========================================================

export const saveCustomList = async listData => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['custom_lists', 'deleted_records'] : ['custom_lists']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('custom_lists')
        if (!listData.id) {
            listData.id = `list_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        }
        if (!listData.createdAt) listData.createdAt = Date.now()
        listData.updatedAt = Date.now()
        store.put(listData)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(listData.id)
        }
        tx.oncomplete = () => resolve(listData)
        tx.onerror = () => reject(tx.error || new Error('Failed to save custom list'))
    })
}

export const applySyncedCustomList = async listData => {
    if (!listData || !listData.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const hasDeleted = db.objectStoreNames.contains('deleted_records')
        const storeNames = hasDeleted ? ['custom_lists', 'deleted_records'] : ['custom_lists']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('custom_lists')
        const delStore = hasDeleted ? tx.objectStore('deleted_records') : null

        const incomingTime = listData.updatedAt || listData.createdAt || 0

        const checkExistingAndPut = () => {
            const exReq = store.get(listData.id)
            exReq.onsuccess = () => {
                const ex = exReq.result
                const exTime = ex ? (ex.updatedAt || ex.createdAt || 0) : 0
                if (ex && exTime > incomingTime) {
                    return resolve(false)
                }
                store.put(listData)
                resolve(true)
            }
            exReq.onerror = () => reject(exReq.error || new Error('Failed to get custom list'))
        }

        if (delStore) {
            const tombReq = delStore.get(listData.id)
            tombReq.onsuccess = () => {
                const tomb = tombReq.result
                if (tomb && (tomb.deletedAt || 0) >= incomingTime) {
                    return resolve(false)
                }
                checkExistingAndPut()
            }
            tombReq.onerror = () => reject(tombReq.error || new Error('Failed to check deleted_records'))
        } else {
            checkExistingAndPut()
        }

        tx.oncomplete = () => {}
        tx.onerror = () => reject(tx.error || new Error('Transaction error saving synced custom list'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving synced custom list'))
    })
}

export const getAllCustomLists = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('custom_lists', 'readonly')
        const store = tx.objectStore('custom_lists')
        const req = store.getAll()
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get custom lists'))
    })
}

export const deleteCustomList = async (id, recordTombstone = true, tombstoneTime = Date.now()) => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records')
            ? ['books', 'custom_lists', 'deleted_records']
            : ['books', 'custom_lists']
        const tx = db.transaction(storeNames, 'readwrite')
        const bookStore = tx.objectStore('books')
        const listStore = tx.objectStore('custom_lists')
        listStore.delete(id)
        if (recordTombstone && storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'custom_list', deletedAt: tombstoneTime })
        }
        
        const req = bookStore.openCursor()
        req.onsuccess = e => {
            const cursor = e.target.result
            if (cursor) {
                const book = cursor.value
                if (book.customListIds && book.customListIds.includes(id)) {
                    book.customListIds = book.customListIds.filter(lid => lid !== id)
                    book.listsUpdatedAt = Date.now()
                    cursor.update(book)
                }
                cursor.continue()
            }
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error(`Failed to delete list ${id}`))
    })
}

export const updateCustomList = async (id, updateData) => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('custom_lists', 'readwrite')
        const store = tx.objectStore('custom_lists')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const item = getReq.result
            if (!item) return resolve(null)
            Object.assign(item, updateData, { updatedAt: Date.now() })
            store.put(item)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update custom list'))
    })
}

// ==========================================================
// Tombstone & Cloud Deletion Records
// ==========================================================

export const getAllDeletedRecords = async () => {
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve([])
            const tx = db.transaction('deleted_records', 'readonly')
            const req = tx.objectStore('deleted_records').getAll()
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

export const recordDeletedItem = async (id, type) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve(false)
            const tx = db.transaction('deleted_records', 'readwrite')
            tx.objectStore('deleted_records').put({ id, type, deletedAt: Date.now() })
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const removeDeletedRecord = async (id) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve(true)
            const tx = db.transaction('deleted_records', 'readwrite')
            tx.objectStore('deleted_records').delete(id)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const setBookLists = async (bookId, listIds) => {
    const book = await getBook(bookId)
    if (!book) return false
    book.customListIds = Array.isArray(listIds) ? listIds : []
    await saveBook(book)
    return true
}

export const addBookToList = async (bookId, listId) => {
    const book = await getBook(bookId)
    if (!book) return false
    if (!book.customListIds) book.customListIds = []
    if (!book.customListIds.includes(listId)) {
        book.customListIds.push(listId)
        await saveBook(book)
    }
    return true
}

export const removeBookFromList = async (bookId, listId) => {
    const book = await getBook(bookId)
    if (!book || !book.customListIds) return false
    book.customListIds = book.customListIds.filter(id => id !== listId)
    await saveBook(book)
    return true
}

// ==========================================================
// PDF Freehand Drawing & Annotations CRUD
// ==========================================================
export const buildPdfDrawingKey = (bookId, pageIndex, versionMeta = {}) => {
    if (!bookId || pageIndex == null) return null
    const blobRevision = versionMeta?.blobRevision || null
    const revisionOrigin = versionMeta?.revisionOrigin || null
    if (blobRevision) {
        return revisionOrigin
            ? `${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`
            : `${bookId}_rev_${blobRevision}_page_${pageIndex}`
    }
    return `${bookId}_page_${pageIndex}`
}

export const remapPdfDrawingId = (drawing, targetBookId) => {
    if (!drawing || !targetBookId) return drawing?.id || null
    let pageIndex = drawing.pageIndex
    let blobRevision = drawing.blobRevision || null
    let revisionOrigin = drawing.revisionOrigin || null

    if (drawing.id && typeof drawing.id === 'string') {
        if (!blobRevision) {
            const revMatch = drawing.id.match(/_rev_(.+?)_page_(\d+)$/)
            if (revMatch) {
                blobRevision = revMatch[1]
                if (pageIndex == null) pageIndex = parseInt(revMatch[2], 10)
            }
        }
        if (!revisionOrigin) {
            const origMatch = drawing.id.match(/_orig_(.+?)_rev_/)
            if (origMatch) revisionOrigin = origMatch[1]
        }
        if (pageIndex == null) {
            const pageMatch = drawing.id.match(/_(?:page|drawing)_(\d+)$/)
            if (pageMatch) pageIndex = parseInt(pageMatch[1], 10)
        }
    }

    // Preserve and backfill structured identity fields
    if (pageIndex != null) drawing.pageIndex = pageIndex
    if (blobRevision) drawing.blobRevision = blobRevision
    if (revisionOrigin) drawing.revisionOrigin = revisionOrigin

    return buildPdfDrawingKey(targetBookId, pageIndex != null ? pageIndex : 0, { blobRevision, revisionOrigin })
}

export const savePdfPageDrawing = async (bookId, pageIndex, strokes, versionMeta = {}) => {
    if (!bookId || pageIndex == null) return false
    const db = await openDB()
    const { blobRevision = null, revisionOrigin = null, documentHash = null } = versionMeta
    const drawingId = buildPdfDrawingKey(bookId, pageIndex, versionMeta)

    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records')
            ? ['pdf_drawings', 'deleted_records']
            : ['pdf_drawings']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('pdf_drawings')
        const record = {
            id: drawingId,
            bookId,
            pageIndex,
            blobRevision,
            revisionOrigin,
            documentHash,
            strokes: strokes || [],
            updatedAt: Date.now()
        }
        store.put(record)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(drawingId)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to save PDF drawing'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving drawing'))
    })
}

export const getPdfPageDrawing = async (bookId, pageIndex, versionMeta = {}) => {
    if (!bookId || pageIndex == null) return null
    const db = await openDB()
    const { blobRevision = null, revisionOrigin = null, documentHash = null } = versionMeta
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdf_drawings', 'readonly')
        const store = tx.objectStore('pdf_drawings')

        const verifyAndResolve = (record, allowCross = false) => {
            if (!record) return null
            const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash }, { allowCrossBook: allowCross })
            return match.matches ? record : null
        }

        const candidates = []
        if (blobRevision) {
            if (revisionOrigin) {
                candidates.push(`${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`)
            }
            candidates.push(`${bookId}_rev_${blobRevision}_page_${pageIndex}`)
        }
        candidates.push(`${bookId}_page_${pageIndex}`)
        candidates.push(`${bookId}_drawing_${pageIndex}`)

        const checkCrossDeviceHashFallback = () => {
            if (!documentHash || typeof store.openCursor !== 'function') return resolve(null)
            const req = store.openCursor()
            req.onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    const record = cursor.value
                    if (record && record.pageIndex === pageIndex && record.documentHash === documentHash) {
                        const verified = verifyAndResolve(record, true)
                        if (verified) return resolve(verified)
                    }
                    cursor.continue()
                } else {
                    resolve(null)
                }
            }
            req.onerror = () => resolve(null)
        }

        const checkNextCandidate = () => {
            if (candidates.length === 0) return checkCrossDeviceHashFallback()
            const candidateKey = candidates.shift()
            const req = store.get(candidateKey)
            req.onsuccess = () => {
                const record = req.result
                if (record) {
                    const verified = verifyAndResolve(record)
                    if (verified) {
                        return resolve(verified)
                    }
                    const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash })
                    if (match.status === 'hash_conflict') {
                        return resolve(null)
                    }
                }
                checkNextCandidate()
            }
            req.onerror = () => checkNextCandidate()
        }

        checkNextCandidate()
    })
}

export const clearPdfPageDrawing = async (bookId, pageIndex, recordTombstone = true, tombstoneTime = Date.now(), versionMeta = {}) => {
    if (!bookId || pageIndex == null) return false
    const db = await openDB()
    const { blobRevision = null, revisionOrigin = null, documentHash = null } = versionMeta

    return new Promise((resolve, reject) => {
        const storeNames = recordTombstone && db.objectStoreNames.contains('deleted_records')
            ? ['pdf_drawings', 'deleted_records']
            : ['pdf_drawings']
        const tx = db.transaction(storeNames, 'readwrite')
        const drawStore = tx.objectStore('pdf_drawings')
        const delStore = (recordTombstone && storeNames.includes('deleted_records'))
            ? tx.objectStore('deleted_records')
            : null

        const candidateKeys = new Set()
        if (blobRevision) {
            if (revisionOrigin) {
                candidateKeys.add(`${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`)
            }
            candidateKeys.add(`${bookId}_rev_${blobRevision}_page_${pageIndex}`)
        }
        candidateKeys.add(`${bookId}_page_${pageIndex}`)

        if (typeof drawStore.openCursor === 'function') {
            const req = drawStore.openCursor()
            req.onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    const key = String(cursor.key)
                    const record = cursor.value
                    const keyMatches = (key.startsWith(`${bookId}_`) && key.endsWith(`_page_${pageIndex}`)) || candidateKeys.has(key)
                    const recordMatches = (record?.bookId === bookId && record?.pageIndex === pageIndex)

                    if (keyMatches || recordMatches) {
                        let shouldDelete = true
                        if (documentHash || revisionOrigin || blobRevision) {
                            const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash })
                            if (!match.matches && match.status !== 'legacy_migrated') {
                                shouldDelete = false
                            }
                        }
                        if (shouldDelete) {
                            cursor.delete()
                            if (delStore) {
                                delStore.put({
                                    id: key,
                                    type: 'pdfDrawing',
                                    deletedAt: tombstoneTime
                                })
                            }
                        }
                    }
                    cursor.continue()
                }
            }
            req.onerror = () => reject(req.error || new Error('Failed to cursor scan PDF drawings'))
        } else {
            const keysToDelete = []
            if (blobRevision) {
                if (revisionOrigin) {
                    keysToDelete.push(`${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`)
                } else {
                    keysToDelete.push(`${bookId}_rev_${blobRevision}_page_${pageIndex}`)
                }
            } else {
                keysToDelete.push(`${bookId}_page_${pageIndex}`)
            }
            for (const k of keysToDelete) {
                drawStore.delete(k)
                if (delStore) {
                    delStore.put({
                        id: k,
                        type: 'pdfDrawing',
                        deletedAt: tombstoneTime
                    })
                }
            }
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to clear PDF drawing'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted clearing drawing'))
    })
}

export const clearPdfDrawingById = async (drawingId, recordTombstone = false, tombstoneTime = Date.now()) => {
    if (!drawingId) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = recordTombstone && db.objectStoreNames.contains('deleted_records')
            ? ['pdf_drawings', 'deleted_records']
            : ['pdf_drawings']
        const tx = db.transaction(storeNames, 'readwrite')
        tx.objectStore('pdf_drawings').delete(drawingId)
        if (recordTombstone && storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({
                id: drawingId,
                type: 'pdfDrawing',
                deletedAt: tombstoneTime
            })
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error(`Failed to clear PDF drawing ${drawingId}`))
        tx.onabort = () => reject(tx.error || new Error(`Transaction aborted clearing drawing ${drawingId}`))
    })
}

export const getAllPdfDrawings = async () => {
    const db = await openDB()
    if (!db.objectStoreNames.contains('pdf_drawings')) return []
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdf_drawings', 'readonly')
        const store = tx.objectStore('pdf_drawings')
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get all PDF drawings'))
    })
}

// ==========================================
// Cross-Book Full-Text Search Index Storage
// ==========================================
export const saveBookSearchIndex = async (bookId, indexRecord) => {
    if (!bookId || !indexRecord || typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        try {
            if (!db.objectStoreNames.contains('fulltext_index')) return resolve(false)
            const tx = db.transaction('fulltext_index', 'readwrite')
            const store = tx.objectStore('fulltext_index')
            store.put({
                ...indexRecord,
                bookId,
                updatedAt: Date.now()
            })
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => reject(tx.error || new Error(`Failed to save search index for ${bookId}`))
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving search index'))
        } catch (e) {
            resolve(false)
        }
    })
}

export const getBookSearchIndex = async (bookId) => {
    if (!bookId || typeof indexedDB === 'undefined') return null
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('fulltext_index')) return resolve(null)
            const tx = db.transaction('fulltext_index', 'readonly')
            const store = tx.objectStore('fulltext_index')
            const req = store.get(bookId)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => resolve(null)
        } catch (e) {
            resolve(null)
        }
    })
}

export const deleteBookSearchIndex = async (bookId) => {
    if (!bookId || typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('fulltext_index')) return resolve(false)
            const tx = db.transaction('fulltext_index', 'readwrite')
            const store = tx.objectStore('fulltext_index')
            store.delete(bookId)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const getBookSearchIndexIds = async () => {
    if (typeof indexedDB === 'undefined') return []
    const db = await openDB()
    if (!db.objectStoreNames.contains('fulltext_index')) return []
    return new Promise(resolve => {
        const request = db.transaction('fulltext_index', 'readonly').objectStore('fulltext_index').getAllKeys()
        request.onsuccess = () => resolve(request.result || [])
        request.onerror = () => resolve([])
    })
}

export const getAllBookSearchIndexes = async () => {
    if (typeof indexedDB === 'undefined') return []
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('fulltext_index')) return resolve([])
            const tx = db.transaction('fulltext_index', 'readonly')
            const store = tx.objectStore('fulltext_index')
            const req = store.getAll()
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

// ============================================================================
// AI Reading History Persistence (IndexedDB)
// ============================================================================

export const saveAiConversation = async (conv) => {
    if (!conv || !conv.id || typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_conversations')) return resolve(false)
            const tx = db.transaction('ai_conversations', 'readwrite')
            const store = tx.objectStore('ai_conversations')
            const record = {
                ...conv,
                updatedAt: conv.updatedAt || Date.now()
            }
            store.put(record)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const getAiConversation = async (id) => {
    if (!id || typeof indexedDB === 'undefined') return null
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_conversations')) return resolve(null)
            const tx = db.transaction('ai_conversations', 'readonly')
            const store = tx.objectStore('ai_conversations')
            const req = store.get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => resolve(null)
        } catch (e) {
            resolve(null)
        }
    })
}

export const getAiConversationsByBook = async (bookId) => {
    if (typeof indexedDB === 'undefined') return []
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_conversations')) return resolve([])
            const tx = db.transaction('ai_conversations', 'readonly')
            const store = tx.objectStore('ai_conversations')
            if (bookId) {
                const idx = store.index('bookId')
                const req = idx.getAll(bookId)
                req.onsuccess = () => {
                    const list = req.result || []
                    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                    resolve(list)
                }
                req.onerror = () => resolve([])
            } else {
                const req = store.getAll()
                req.onsuccess = () => {
                    const list = req.result || []
                    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                    resolve(list)
                }
                req.onerror = () => resolve([])
            }
        } catch (e) {
            resolve([])
        }
    })
}

export const getAllAiConversations = async () => {
    return getAiConversationsByBook(null)
}

export const deleteAiConversation = async (id) => {
    if (!id || typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            const stores = []
            if (db.objectStoreNames.contains('ai_conversations')) stores.push('ai_conversations')
            if (db.objectStoreNames.contains('ai_messages')) stores.push('ai_messages')
            if (stores.length === 0) return resolve(false)

            const tx = db.transaction(stores, 'readwrite')
            if (db.objectStoreNames.contains('ai_conversations')) {
                tx.objectStore('ai_conversations').delete(id)
            }
            if (db.objectStoreNames.contains('ai_messages')) {
                const msgStore = tx.objectStore('ai_messages')
                const idx = msgStore.index('conversationId')
                const req = idx.openKeyCursor(IDBKeyRange.only(id))
                req.onsuccess = (e) => {
                    const cursor = e.target.result
                    if (cursor) {
                        msgStore.delete(cursor.primaryKey)
                        cursor.continue()
                    }
                }
            }
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const saveAiMessage = async (msg) => {
    if (!msg || !msg.id || typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_messages')) return resolve(false)
            const tx = db.transaction('ai_messages', 'readwrite')
            const store = tx.objectStore('ai_messages')
            store.put(msg)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const getAiMessages = async (conversationId) => {
    if (!conversationId || typeof indexedDB === 'undefined') return []
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_messages')) return resolve([])
            const tx = db.transaction('ai_messages', 'readonly')
            const store = tx.objectStore('ai_messages')
            const idx = store.index('conversationId')
            const req = idx.getAll(conversationId)
            req.onsuccess = () => {
                const list = req.result || []
                list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
                resolve(list)
            }
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

export const clearAllAiHistory = async () => {
    if (typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            const stores = []
            if (db.objectStoreNames.contains('ai_conversations')) stores.push('ai_conversations')
            if (db.objectStoreNames.contains('ai_messages')) stores.push('ai_messages')
            if (stores.length === 0) return resolve(true)
            const tx = db.transaction(stores, 'readwrite')
            stores.forEach(s => tx.objectStore(s).clear())
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const recoverInterruptedAiMessages = async (maxAgeMs = 120000) => {
    if (typeof indexedDB === 'undefined') return 0
    const db = await openDB()
    const now = Date.now()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('ai_messages')) return resolve(0)
            const tx = db.transaction('ai_messages', 'readwrite')
            const store = tx.objectStore('ai_messages')
            const req = store.openCursor()
            let recovered = 0
            req.onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    const val = cursor.value
                    if (val && (val.status === 'streaming' || val.status === 'queued')) {
                        const lastActivity = Math.max(val.updatedAt || 0, val.createdAt || 0, val.timestamp || 0)
                        if (now - lastActivity >= maxAgeMs) {
                            val.status = 'interrupted'
                            val.updatedAt = now
                            cursor.update(val)
                            recovered++
                        }
                    }
                    cursor.continue()
                } else {
                    resolve(recovered)
                }
            }
            req.onerror = () => resolve(0)
        } catch (e) {
            resolve(0)
        }
    })
}

// ==========================================
// Chapter Bilingual Translation Storage (v10)
// ==========================================
let _cachedChapterTransStats = null
export const saveChapterTranslation = async (record) => {
    _cachedChapterTransStats = null
    if (typeof indexedDB === 'undefined' || !record?.id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve(false)
            const stores = ['chapter_translations']
            if (db.objectStoreNames.contains('deleted_records')) stores.push('deleted_records')
            const tx = db.transaction(stores, 'readwrite')
            const store = tx.objectStore('chapter_translations')
            const delStore = stores.includes('deleted_records') ? tx.objectStore('deleted_records') : null

            const doSave = () => {
                const archive = (typeof buildTranslationRevisionArchive === 'function')
                    ? buildTranslationRevisionArchive(record)
                    : record
                store.put({
                    ...archive,
                    updatedAt: archive.updatedAt || Date.now()
                })
            }

            if (delStore) {
                const getTomb = delStore.get(record.id)
                getTomb.onsuccess = () => {
                    const tomb = getTomb.result
                    if (tomb && (tomb.deletedAt || 0) >= (record.updatedAt || 0)) {
                        // Deleted by tombstone, do not resurrect
                        try { tx.abort() } catch (_) {}
                        return resolve(false)
                    }
                    if (tomb) {
                        delStore.delete(record.id)
                    }
                    doSave()
                }
                getTomb.onerror = () => doSave()
            } else {
                doSave()
            }

            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
            tx.onabort = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const getChapterTranslation = async (bookId, chapterKey) => {
    if (typeof indexedDB === 'undefined' || !bookId || chapterKey == null) return null
    const db = await openDB()
    const id = `${bookId}::${chapterKey}`
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve(null)
            const tx = db.transaction('chapter_translations', 'readonly')
            const store = tx.objectStore('chapter_translations')
            const req = store.get(id)
            req.onsuccess = () => resolve(req.result || null)
            req.onerror = () => resolve(null)
        } catch (e) {
            resolve(null)
        }
    })
}

export const deleteChapterTranslation = async (bookId, chapterKey) => {
    if (typeof indexedDB === 'undefined' || !bookId || chapterKey == null) return false
    const db = await openDB()
    const id = `${bookId}::${chapterKey}`
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve(false)
            const stores = ['chapter_translations']
            if (db.objectStoreNames.contains('deleted_records')) stores.push('deleted_records')
            const tx = db.transaction(stores, 'readwrite')
            const store = tx.objectStore('chapter_translations')
            store.delete(id)
            if (stores.includes('deleted_records')) {
                tx.objectStore('deleted_records').put({
                    id,
                    type: 'chapter_translation',
                    deletedAt: Date.now()
                })
            }
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const listChapterTranslationsForBook = async (bookId) => {
    if (typeof indexedDB === 'undefined' || !bookId) return []
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve([])
            const tx = db.transaction('chapter_translations', 'readonly')
            const store = tx.objectStore('chapter_translations')
            const index = store.index('bookId')
            const req = index.getAll(bookId)
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

export const getAllChapterTranslations = async () => {
    if (typeof indexedDB === 'undefined') return []
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve([])
            const tx = db.transaction('chapter_translations', 'readonly')
            const store = tx.objectStore('chapter_translations')
            const req = store.getAll()
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

export { buildTranslationRevisionArchive, checkTranslationCompatibility }

export const clearAllChapterTranslations = async (bookId = null) => {
    _cachedChapterTransStats = null
    if (typeof indexedDB === 'undefined') return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve(true)
            const stores = ['chapter_translations']
            if (db.objectStoreNames.contains('deleted_records')) stores.push('deleted_records')
            const tx = db.transaction(stores, 'readwrite')
            const ctStore = tx.objectStore('chapter_translations')
            const delStore = stores.includes('deleted_records') ? tx.objectStore('deleted_records') : null

            if (bookId) {
                const index = ctStore.index('bookId')
                const req = index.getAll(bookId)
                req.onsuccess = () => {
                    const list = req.result || []
                    const now = Date.now()
                    list.forEach(item => {
                        if (item?.id) {
                            ctStore.delete(item.id)
                            if (delStore) {
                                delStore.put({ id: item.id, type: 'chapter_translation', deletedAt: now })
                            }
                        }
                    })
                }
            } else {
                if (delStore) {
                    const req = ctStore.getAll()
                    req.onsuccess = () => {
                        const list = req.result || []
                        const now = Date.now()
                        list.forEach(item => {
                            if (item?.id) {
                                delStore.put({ id: item.id, type: 'chapter_translation', deletedAt: now })
                            }
                        })
                        ctStore.clear()
                    }
                } else {
                    ctStore.clear()
                }
            }
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const getChapterTranslationsStats = async () => {
    if (_cachedChapterTransStats && (Date.now() - _cachedChapterTransStats.timestamp < 60000)) {
        return { count: _cachedChapterTransStats.count, estimatedBytes: _cachedChapterTransStats.estimatedBytes }
    }
    if (typeof indexedDB === 'undefined') return { count: 0, estimatedBytes: 0 }
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('chapter_translations')) return resolve({ count: 0, estimatedBytes: 0 })
            const tx = db.transaction('chapter_translations', 'readonly')
            const store = tx.objectStore('chapter_translations')
            const req = store.openCursor()
            let count = 0
            let estimatedBytes = 0
            req.onsuccess = (e) => {
                const cursor = e.target.result
                if (cursor) {
                    count++
                    const val = cursor.value
                    if (val) {
                        const textLen = (val.translatedText ? val.translatedText.length : 0) + (val.originalText ? val.originalText.length : 0)
                        const paraEst = Array.isArray(val.paragraphs) ? val.paragraphs.length * 150 : 0
                        estimatedBytes += (textLen * 2) + paraEst + 256
                    }
                    cursor.continue()
                } else {
                    _cachedChapterTransStats = { count, estimatedBytes, timestamp: Date.now() }
                    resolve({ count, estimatedBytes })
                }
            }
            req.onerror = () => resolve({ count: 0, estimatedBytes: 0 })
        } catch (e) {
            resolve({ count: 0, estimatedBytes: 0 })
        }
    })
}

/**
 * R09: Normalize navigation target into typed location object
 * @param {*} target
 * @returns {object|null}
 */
export function normalizeNavigationTarget(target) {
    if (target == null) return null
    if (typeof target === 'number') {
        const pageIndex = Math.max(0, Math.floor(target))
        return {
            type: 'pdf',
            page: pageIndex + 1,
            pageIndex: pageIndex,
            yRatio: 0
        }
    }
    if (typeof target === 'string') {
        if (/^\d+$/.test(target.trim())) {
            const pageNum = Math.max(1, parseInt(target.trim(), 10))
            return {
                type: 'pdf',
                page: pageNum,
                pageIndex: pageNum - 1,
                yRatio: 0
            }
        }
        return {
            type: 'epub',
            cfi: target
        }
    }
    if (typeof target === 'object') {
        const res = { ...target }
        if (res.cfi) {
            res.type = 'epub'
            return res
        }
        if (res.charOffset !== undefined) {
            res.type = res.type || 'txt'
            return res
        }
        if (res.page !== undefined || res.pageIndex !== undefined) {
            res.type = 'pdf'
            if (res.page !== undefined && res.pageIndex === undefined) {
                res.page = Math.max(1, Math.floor(res.page))
                res.pageIndex = res.page - 1
            } else if (res.pageIndex !== undefined && res.page === undefined) {
                res.pageIndex = Math.max(0, Math.floor(res.pageIndex))
                res.page = res.pageIndex + 1
            } else if (res.page !== undefined && res.pageIndex !== undefined) {
                res.page = Math.max(1, Math.floor(res.page))
                res.pageIndex = Math.max(0, Math.floor(res.pageIndex))
            }
            if (res.yRatio !== undefined && typeof res.yRatio === 'number') {
                res.yRatio = Math.max(0, Math.min(1, res.yRatio))
            } else {
                res.yRatio = 0
            }
            return res
        }
        return res
    }
    return null
}

export const createFullBackup = async (options = {}) => {
    if (typeof window !== 'undefined' && window.advancedSettingsManager?.createFullDataBackup) {
        return await window.advancedSettingsManager.createFullDataBackup(options)
    }
    const { AdvancedSettingsManager } = await import('./advanced-settings.js')
    const mgr = new AdvancedSettingsManager()
    return await mgr.createFullDataBackup(options)
}

const RESTORE_JOURNAL_PREFIX = '__restore_journal_'
const RESTORE_LOCALSTORAGE_JOURNAL_KEY = '__linden_pending_restore_journal'
const _activeRestoreLockReleasers = new Map()

export const acquireRestoreOperationLock = async (operationId) => {
    if (!operationId) return
    if (_activeRestoreLockReleasers.has(operationId)) return
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        const acquired = await new Promise((resolveGranted) => {
            let releaseGlobal = null
            const holdGlobal = new Promise((r) => { releaseGlobal = r })
            navigator.locks.request(
                'linden_restore_database_mutex',
                { mode: 'exclusive' },
                async () => {
                    let releaseOp = null
                    const holdOp = new Promise((r) => { releaseOp = r })
                    navigator.locks.request(
                        `linden_restore_op_${operationId}`,
                        { mode: 'exclusive' },
                        async () => {
                            _activeRestoreLockReleasers.set(operationId, () => {
                                _activeRestoreLockReleasers.delete(operationId)
                                if (releaseOp) releaseOp()
                                if (releaseGlobal) releaseGlobal()
                            })
                            resolveGranted(true)
                            await holdOp
                        }
                    ).catch(() => {
                        if (releaseGlobal) releaseGlobal()
                        resolveGranted(false)
                    })
                    await holdGlobal
                }
            ).catch(() => {
                resolveGranted(false)
            })
        })
        if (!acquired) throw new Error('无法取得恢复互斥锁，已停止恢复')
    } else if (typeof window !== 'undefined') {
        throw new Error('当前环境缺少跨窗口锁，已停止恢复以保护数据')
    } else {
        // Non-browser / Node test context: process-isolated
        _activeRestoreLockReleasers.set(operationId, () => {
            _activeRestoreLockReleasers.delete(operationId)
        })
    }
}

export const releaseRestoreOperationLock = async (operationId) => {
    if (!operationId) return
    const releaser = _activeRestoreLockReleasers.get(operationId)
    if (typeof releaser === 'function') {
        _activeRestoreLockReleasers.delete(operationId)
        try { releaser() } catch (_) {}
    }
}

const computeRecordRevision = (rec) => {
    if (!rec || typeof rec !== 'object') return String(rec)
    const summary = {}
    for (const k of Object.keys(rec).sort()) {
        if (k === '_preserveUpdatedAt') continue
        const v = rec[k]
        if (typeof Blob !== 'undefined' && v instanceof Blob) {
            summary[k] = `[blob:${v.size || 0}:${v.type || ''}]`
        } else if (typeof ArrayBuffer !== 'undefined' && (v instanceof ArrayBuffer || ArrayBuffer.isView(v))) {
            summary[k] = `[binary:${v.byteLength || 0}]`
        } else {
            summary[k] = v
        }
    }
    try {
        return JSON.stringify(summary)
    } catch (_) {
        return String(rec.updatedAt || rec.createdAt || rec.deletedAt || '')
    }
}

/**
 * Atomic Single-Transaction Restore Plan Executor (Item 2 / Group 1)
 * Enforces tombstones from both deleted_records store and incoming plan inside the
 * single readwrite transaction, and records a per-key before-image/revision journal
 * for selective post-commit rollback and startup crash recovery.
 *
 * @param {object} plan
 * @param {IDBDatabase} [customDb]
 * @returns {Promise<{ success: boolean, stats: object, operationId: string, journal: object }>}
 */
export const applyRestorePlan = async (plan, customDb = null) => {
    if (!plan || typeof plan !== 'object') {
        throw new Error('无效的恢复计划 (Invalid restore plan)')
    }
    const db = customDb || await openDB()
    const targetStores = [
        'books', 'book_files', 'highlights', 'bookmarks',
        'reading_sessions', 'chapter_translations', 'pdf_drawings',
        'custom_lists', 'settings', 'deleted_records'
    ].filter(s => db.objectStoreNames.contains(s))

    const operationId = plan.operationId || `restore_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (plan.persistJournal !== false) {
        await acquireRestoreOperationLock(operationId)
    }

    return new Promise((resolve, reject) => {
        let tx = null
        const rejectAndRelease = (err) => {
            releaseRestoreOperationLock(operationId)
            reject(err)
        }
        try {
            tx = db.transaction(targetStores, 'readwrite')

            const stats = {
                books: 0,
                highlights: 0,
                bookmarks: 0,
                sessions: 0,
                translations: 0,
                drawings: 0,
                lists: 0,
                settings: 0,
                deletedRecords: 0
            }

            const journalEntries = []
            const journal = {
                operationId,
                createdAt: Date.now(),
                status: 'committed_pending_finalize',
                entries: journalEntries,
                localStorageEntries: Array.isArray(plan.localStorageEntries) ? plan.localStorageEntries : []
            }

            let aborted = false
            const fail = (err) => {
                if (!aborted) {
                    aborted = true
                    try { tx.abort() } catch (_) {}
                    rejectAndRelease(err)
                }
            }

            const isValidIdbKey = (k) => (typeof k === 'string' && k.length > 0) || (typeof k === 'number' && !Number.isNaN(k))
            const abortWithDataError = () => {
                const err = new DOMException("Evaluating the object store's key path yielded a value that is not a valid key.", "DataError")
                fail(err)
                return false
            }

            let pendingAsyncOps = 0
            const flushJournalToSettingsStore = () => {
                if (aborted) return
                if (plan.persistJournal !== false && tx.objectStoreNames.contains('settings')) {
                    const setStore = tx.objectStore('settings')
                    if (setStore && typeof setStore.put === 'function') {
                        try {
                            setStore.put({
                                key: `${RESTORE_JOURNAL_PREFIX}${operationId}`,
                                value: journal,
                                updatedAt: Date.now()
                            })
                        } catch (_) {}
                    }
                }
            }

            const beginAsyncOp = () => { pendingAsyncOps++ }
            const endAsyncOp = () => {
                pendingAsyncOps = Math.max(0, pendingAsyncOps - 1)
                if (pendingAsyncOps === 0) {
                    flushJournalToSettingsStore()
                }
            }

            const executeWritesWithTombstones = (existingDeletedInTx) => {
                if (aborted) return

                const deletedList = plan.deletedRecordsToPut || plan.deletedRecords || []
                const combinedTombstones = [
                    ...(Array.isArray(existingDeletedInTx) ? existingDeletedInTx : []),
                    ...(Array.isArray(deletedList) ? deletedList : [])
                ].filter(Boolean)

                const getBookTombstoneDeletedAt = (b) => {
                    if (!b) return 0
                    let maxDel = 0
                    for (const dr of combinedTombstones) {
                        if (dr.type !== 'book') continue
                        const matchId = dr.id && b.id && dr.id === b.id
                        const matchHash = b.documentHash && dr.documentHash && dr.documentHash === b.documentHash
                        const matchStableId = dr.stableKey && b.id && dr.stableKey === `id:${b.id}`
                        const matchStableHash = dr.stableKey && b.documentHash && dr.stableKey === `hash:${b.documentHash}`
                        if (matchId || matchHash || matchStableId || matchStableHash) {
                            const delAt = dr.deletedAt || 0
                            if (delAt > maxDel) maxDel = delAt
                        }
                    }
                    return maxDel
                }

                const getBookIdTombstoneDeletedAt = (bookId) => {
                    if (!bookId) return 0
                    let maxDel = 0
                    for (const dr of combinedTombstones) {
                        if (dr.type !== 'book') continue
                        if (dr.id === bookId || dr.stableKey === `id:${bookId}`) {
                            const delAt = dr.deletedAt || 0
                            if (delAt > maxDel) maxDel = delAt
                        }
                    }
                    return maxDel
                }

                const getItemTombstoneDeletedAt = (type, item) => {
                    if (!item) return 0
                    let maxDel = 0
                    for (const dr of combinedTombstones) {
                        if (dr.type === type && dr.id === item.id) {
                            const delAt = dr.deletedAt || 0
                            if (delAt > maxDel) maxDel = delAt
                        }
                    }
                    if (item.bookId) {
                        const bookDel = getBookIdTombstoneDeletedAt(item.bookId)
                        if (bookDel > maxDel) maxDel = bookDel
                    }
                    return maxDel
                }

                const putWithLWW = (store, item, id, statKey, mergeFn = null, tombstoneDeletedAt = 0) => {
                    const inTime = item.updatedAt || item.addedAt || item.createdAt || item.startTime || item.modified_time || 0
                    if (tombstoneDeletedAt > 0 && tombstoneDeletedAt >= inTime) {
                        // Suppressed by newer or equal tombstone; if store already has an older active record, remove it
                        if (typeof store.get === 'function' && typeof store.delete === 'function') {
                            beginAsyncOp()
                            const getReq = store.get(id)
                            getReq.onsuccess = () => {
                                if (!aborted) {
                                    const existing = getReq.result
                                    const exTime = existing ? (existing.updatedAt || existing.addedAt || existing.createdAt || existing.startTime || existing.modified_time || 0) : 0
                                    if (existing && exTime <= tombstoneDeletedAt) {
                                        journalEntries.push({
                                            store: store.name,
                                            key: id,
                                            hadBefore: true,
                                            beforeImage: existing,
                                            afterAction: 'delete',
                                            afterRevision: null
                                        })
                                        store.delete(id)
                                    }
                                }
                                endAsyncOp()
                            }
                            getReq.onerror = () => {
                                endAsyncOp()
                                fail(getReq.error || new Error(`Failed to get from ${store.name}`))
                            }
                        }
                        return
                    }

                    if (typeof store.get !== 'function') {
                        journalEntries.push({
                            store: store.name || statKey,
                            key: id,
                            hadBefore: false,
                            beforeImage: null,
                            afterAction: 'put',
                            afterRevision: computeRecordRevision(item)
                        })
                        const putReq = store.put(item)
                        if (putReq && typeof putReq === 'object' && 'onsuccess' in putReq) {
                            putReq.onsuccess = () => {
                                if (!aborted && statKey) stats[statKey] = (stats[statKey] || 0) + 1
                            }
                            putReq.onerror = () => fail(putReq.error || new Error(`Failed to put in ${store.name}`))
                        } else {
                            if (!aborted && statKey) stats[statKey] = (stats[statKey] || 0) + 1
                        }
                        return
                    }

                    beginAsyncOp()
                    const getReq = store.get(id)
                    getReq.onsuccess = () => {
                        if (aborted) {
                            endAsyncOp()
                            return
                        }
                        const existing = getReq.result
                        const exTime = existing ? (existing.updatedAt || existing.addedAt || existing.createdAt || existing.startTime || existing.modified_time || 0) : 0
                        if (existing && exTime > inTime) {
                            // Existing record is newer (e.g. concurrent edit)! Do not overwrite with older backup edit.
                            endAsyncOp()
                            return
                        }
                        const toPut = (existing && mergeFn) ? mergeFn(existing, item) : item
                        journalEntries.push({
                            store: store.name,
                            key: id,
                            hadBefore: existing !== undefined && existing !== null,
                            beforeImage: existing !== undefined && existing !== null ? existing : null,
                            afterAction: 'put',
                            afterRevision: computeRecordRevision(toPut)
                        })
                        const putReq = store.put(toPut)
                        if (putReq && typeof putReq === 'object' && 'onsuccess' in putReq) {
                            putReq.onsuccess = () => {
                                if (!aborted && statKey) stats[statKey] = (stats[statKey] || 0) + 1
                                endAsyncOp()
                            }
                            putReq.onerror = () => {
                                endAsyncOp()
                                fail(putReq.error || new Error(`Failed to put in ${store.name}`))
                            }
                        } else {
                            if (!aborted && statKey) stats[statKey] = (stats[statKey] || 0) + 1
                            endAsyncOp()
                        }
                    }
                    getReq.onerror = () => {
                        endAsyncOp()
                        fail(getReq.error || new Error(`Failed to get from ${store.name}`))
                    }
                }

                const mergeBook = (existing, b) => {
                    let progress = existing.progress
                    const existingProgTime = existing.progress?.updatedAt || 0
                    const incomingProgTime = b.progress?.updatedAt || 0
                    if (incomingProgTime > existingProgTime) {
                        progress = b.progress
                    } else if (existingProgTime === 0 && incomingProgTime === 0) {
                        const exFrac = existing.progress?.fraction || 0
                        const inFrac = b.progress?.fraction || 0
                        progress = inFrac > exFrac ? b.progress : existing.progress
                    }

                    const totalReadingSeconds = Math.max(
                        existing.totalReadingSeconds || 0,
                        b.totalReadingSeconds || 0
                    )

                    const incomingIsNewer = (b.updatedAt || 0) >= (existing.updatedAt || 0)

                    return {
                        ...b,
                        ...existing,
                        title: incomingIsNewer ? (b.title || existing.title) : (existing.title || b.title),
                        author: incomingIsNewer ? (b.author || existing.author) : (existing.author || b.author),
                        progress: progress || existing.progress || b.progress,
                        totalReadingSeconds,
                        updatedAt: Math.max(existing.updatedAt || 0, b.updatedAt || 0),
                        hasLocalFile: existing.hasLocalFile !== undefined ? existing.hasLocalFile : b.hasLocalFile,
                        isCloudOnly: existing.hasLocalFile ? false : (existing.isCloudOnly !== undefined ? existing.isCloudOnly : b.isCloudOnly),
                        nativeSnapshotPath: existing.nativeSnapshotPath || b.nativeSnapshotPath,
                        blobRevision: existing.blobRevision || b.blobRevision,
                        documentHash: existing.documentHash || b.documentHash,
                        coverBlob: existing.coverBlob || b.coverBlob
                    }
                }

                // 1. Books
                if (Array.isArray(plan.booksToPut) && tx.objectStoreNames.contains('books')) {
                    const bookStore = tx.objectStore('books')
                    for (const b of plan.booksToPut) {
                        if (b) {
                            if (!isValidIdbKey(b.id)) return abortWithDataError()
                            const tombDelAt = getBookTombstoneDeletedAt(b)
                            putWithLWW(bookStore, b, b.id, 'books', mergeBook, tombDelAt)
                        }
                    }
                }

                // 1b. Book Files
                if (Array.isArray(plan.bookFilesToPut) && tx.objectStoreNames.contains('book_files')) {
                    const fileStore = tx.objectStore('book_files')
                    for (const f of plan.bookFilesToPut) {
                        if (f) {
                            if (!isValidIdbKey(f.id)) return abortWithDataError()
                            const tombDelAt = getBookIdTombstoneDeletedAt(f.id)
                            const fTime = f.updatedAt || 0
                            if (tombDelAt > 0 && tombDelAt >= fTime) continue
                            if (typeof fileStore.get === 'function') {
                                beginAsyncOp()
                                const gReq = fileStore.get(f.id)
                                gReq.onsuccess = () => {
                                    if (!aborted) {
                                        const existing = gReq.result
                                        journalEntries.push({
                                            store: 'book_files',
                                            key: f.id,
                                            hadBefore: existing !== undefined && existing !== null,
                                            beforeImage: existing !== undefined && existing !== null ? existing : null,
                                            afterAction: 'put',
                                            afterRevision: computeRecordRevision(f)
                                        })
                                        fileStore.put(f)
                                        stats.bookFiles = (stats.bookFiles || 0) + 1
                                    }
                                    endAsyncOp()
                                }
                                gReq.onerror = () => {
                                    endAsyncOp()
                                    fail(gReq.error)
                                }
                            } else {
                                fileStore.put(f)
                                stats.bookFiles = (stats.bookFiles || 0) + 1
                            }
                        }
                    }
                }

                // 2. Highlights
                if (Array.isArray(plan.highlightsToPut) && tx.objectStoreNames.contains('highlights')) {
                    const hlStore = tx.objectStore('highlights')
                    for (const h of plan.highlightsToPut) {
                        if (h) {
                            if (!isValidIdbKey(h.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('highlight', h)
                            putWithLWW(hlStore, h, h.id, 'highlights', null, tombDelAt)
                        }
                    }
                }

                // 3. Bookmarks
                if (Array.isArray(plan.bookmarksToPut) && tx.objectStoreNames.contains('bookmarks')) {
                    const bmStore = tx.objectStore('bookmarks')
                    for (const bm of plan.bookmarksToPut) {
                        if (bm) {
                            if (!isValidIdbKey(bm.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('bookmark', bm)
                            putWithLWW(bmStore, bm, bm.id, 'bookmarks', null, tombDelAt)
                        }
                    }
                }

                // 4. Reading Sessions
                if (Array.isArray(plan.sessionsToPut) && tx.objectStoreNames.contains('reading_sessions')) {
                    const sessStore = tx.objectStore('reading_sessions')
                    for (const s of plan.sessionsToPut) {
                        if (s) {
                            if (!isValidIdbKey(s.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('session', s)
                            putWithLWW(sessStore, s, s.id, 'sessions', null, tombDelAt)
                        }
                    }
                }

                // 5. Chapter Translations
                if (Array.isArray(plan.translationsToPut) && tx.objectStoreNames.contains('chapter_translations')) {
                    const trStore = tx.objectStore('chapter_translations')
                    for (const ct of plan.translationsToPut) {
                        if (ct) {
                            if (!isValidIdbKey(ct.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('translation', ct)
                            putWithLWW(trStore, ct, ct.id, 'translations', null, tombDelAt)
                        }
                    }
                }

                // 6. PDF Drawings
                if (Array.isArray(plan.drawingsToPut) && tx.objectStoreNames.contains('pdf_drawings')) {
                    const drawStore = tx.objectStore('pdf_drawings')
                    for (const d of plan.drawingsToPut) {
                        if (d) {
                            if (!isValidIdbKey(d.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('drawing', d)
                            putWithLWW(drawStore, d, d.id, 'drawings', null, tombDelAt)
                        }
                    }
                }

                // 7. Custom Lists
                if (Array.isArray(plan.listsToPut) && tx.objectStoreNames.contains('custom_lists')) {
                    const listStore = tx.objectStore('custom_lists')
                    for (const l of plan.listsToPut) {
                        if (l) {
                            if (!isValidIdbKey(l.id)) return abortWithDataError()
                            const tombDelAt = getItemTombstoneDeletedAt('list', l)
                            putWithLWW(listStore, l, l.id, 'lists', null, tombDelAt)
                        }
                    }
                }

                // 8. Settings
                if (Array.isArray(plan.settingsToPut) && tx.objectStoreNames.contains('settings')) {
                    const setStore = tx.objectStore('settings')
                    for (const st of plan.settingsToPut) {
                        if (st) {
                            if (!isValidIdbKey(st.key)) return abortWithDataError()
                            if (typeof setStore.get === 'function') {
                                beginAsyncOp()
                                const gReq = setStore.get(st.key)
                                gReq.onsuccess = () => {
                                    if (!aborted) {
                                        const existing = gReq.result
                                        journalEntries.push({
                                            store: 'settings',
                                            key: st.key,
                                            hadBefore: existing !== undefined && existing !== null,
                                            beforeImage: existing !== undefined && existing !== null ? existing : null,
                                            afterAction: 'put',
                                            afterRevision: computeRecordRevision(st)
                                        })
                                        setStore.put(st)
                                        stats.settings++
                                    }
                                    endAsyncOp()
                                }
                                gReq.onerror = () => {
                                    endAsyncOp()
                                    fail(gReq.error)
                                }
                            } else {
                                setStore.put(st)
                                stats.settings++
                            }
                        }
                    }
                }

                // 9. Deleted Records (tombstones)
                const tombstoneTypeToStore = {
                    book: 'books',
                    books: 'books',
                    highlight: 'highlights',
                    highlights: 'highlights',
                    bookmark: 'bookmarks',
                    bookmarks: 'bookmarks',
                    session: 'reading_sessions',
                    sessions: 'reading_sessions',
                    reading_session: 'reading_sessions',
                    translation: 'chapter_translations',
                    translations: 'chapter_translations',
                    drawing: 'pdf_drawings',
                    drawings: 'pdf_drawings',
                    list: 'custom_lists',
                    lists: 'custom_lists'
                }
                if (Array.isArray(deletedList) && tx.objectStoreNames.contains('deleted_records')) {
                    const delStore = tx.objectStore('deleted_records')
                    for (const dr of deletedList) {
                        if (dr) {
                            if (!isValidIdbKey(dr.id)) return abortWithDataError()
                            const targetStoreName = dr.type ? tombstoneTypeToStore[String(dr.type).toLowerCase()] : null
                            if (targetStoreName && tx.objectStoreNames.contains(targetStoreName)) {
                                const tStore = tx.objectStore(targetStoreName)
                                if (typeof tStore.get === 'function' && typeof tStore.delete === 'function') {
                                    beginAsyncOp()
                                    const tGetReq = tStore.get(dr.id)
                                    tGetReq.onsuccess = () => {
                                        if (!aborted) {
                                            const activeRec = tGetReq.result
                                            const activeTime = activeRec ? (activeRec.updatedAt || activeRec.addedAt || activeRec.createdAt || activeRec.startTime || activeRec.modified_time || 0) : 0
                                            if (activeRec && (dr.deletedAt || 0) >= activeTime) {
                                                journalEntries.push({
                                                    store: targetStoreName,
                                                    key: dr.id,
                                                    hadBefore: true,
                                                    beforeImage: activeRec,
                                                    afterAction: 'delete',
                                                    afterRevision: null
                                                })
                                                tStore.delete(dr.id)
                                            }
                                        }
                                        endAsyncOp()
                                    }
                                    tGetReq.onerror = () => {
                                        endAsyncOp()
                                        fail(tGetReq.error)
                                    }
                                }
                            }
                            if (typeof delStore.get !== 'function') {
                                const putReq = delStore.put(dr)
                                if (putReq && typeof putReq === 'object' && 'onsuccess' in putReq) {
                                    putReq.onsuccess = () => {
                                        if (!aborted) stats.deletedRecords = (stats.deletedRecords || 0) + 1
                                    }
                                    putReq.onerror = () => fail(putReq.error)
                                } else {
                                    if (!aborted) stats.deletedRecords = (stats.deletedRecords || 0) + 1
                                }
                                continue
                            }
                            beginAsyncOp()
                            const getReq = delStore.get(dr.id)
                            getReq.onsuccess = () => {
                                if (aborted) {
                                    endAsyncOp()
                                    return
                                }
                                const existing = getReq.result
                                const exTime = existing?.deletedAt || 0
                                const inTime = dr.deletedAt || 0
                                if (existing && exTime > inTime) {
                                    endAsyncOp()
                                    return
                                }
                                journalEntries.push({
                                    store: 'deleted_records',
                                    key: dr.id,
                                    hadBefore: existing !== undefined && existing !== null,
                                    beforeImage: existing !== undefined && existing !== null ? existing : null,
                                    afterAction: 'put',
                                    afterRevision: computeRecordRevision(dr)
                                })
                                const putReq = delStore.put(dr)
                                if (putReq && typeof putReq === 'object' && 'onsuccess' in putReq) {
                                    putReq.onsuccess = () => {
                                        if (!aborted) stats.deletedRecords = (stats.deletedRecords || 0) + 1
                                        endAsyncOp()
                                    }
                                    putReq.onerror = () => {
                                        endAsyncOp()
                                        fail(putReq.error)
                                    }
                                } else {
                                    if (!aborted) stats.deletedRecords = (stats.deletedRecords || 0) + 1
                                    endAsyncOp()
                                }
                            }
                            getReq.onerror = () => {
                                endAsyncOp()
                                fail(getReq.error)
                            }
                        }
                    }
                }

                if (pendingAsyncOps === 0) {
                    flushJournalToSettingsStore()
                }
            }

            if (tx.objectStoreNames.contains('deleted_records')) {
                const delStore = tx.objectStore('deleted_records')
                if (delStore && typeof delStore.getAll === 'function') {
                    const allDelReq = delStore.getAll()
                    allDelReq.onsuccess = () => {
                        if (aborted) return
                        executeWritesWithTombstones(allDelReq.result || [])
                    }
                    allDelReq.onerror = () => fail(allDelReq.error || new Error('Failed to read deleted_records in transaction'))
                } else {
                    executeWritesWithTombstones([])
                }
            } else {
                executeWritesWithTombstones([])
            }

            tx.oncomplete = () => {
                invalidateReadingStatsCache()
                resolve({ success: true, stats, operationId, journal })
            }

            tx.onerror = () => {
                fail(tx.error || new Error('applyRestorePlan 事务执行失败'))
            }

            tx.onabort = () => {
                fail(tx.error || new Error('applyRestorePlan 事务已回滚'))
            }
        } catch (err) {
            if (tx) {
                try { tx.abort() } catch (_) {}
            }
            rejectAndRelease(err)
        }
    })
}

/**
 * Mark a restore operation journal as committed and clean up durable recovery entries.
 * Never swallows durable cleanup failure, and always releases the cross-window lock in finally.
 */
export const commitRestoreOperation = async (operationId, customDb = null, { retainLock = false } = {}) => {
    if (!operationId) return false
    try {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(RESTORE_LOCALSTORAGE_JOURNAL_KEY)
            }
        } catch (_) {}
        const db = customDb || await openDB()
        if (!db || !db.objectStoreNames || !db.objectStoreNames.contains('settings')) return true
        await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(['settings'], 'readwrite')
                const req = tx.objectStore('settings').delete(`${RESTORE_JOURNAL_PREFIX}${operationId}`)
                if (req && typeof req === 'object') {
                    req.onerror = () => reject(req.error || new Error('Failed to delete restore journal entry'))
                }
                tx.oncomplete = () => resolve(true)
                tx.onerror = () => reject(tx.error || new Error('Failed to commit restore operation journal'))
                tx.onabort = () => reject(tx.error || new Error('Restore operation journal commit aborted'))
            } catch (err) {
                reject(err)
            }
        })
        return true
    } finally {
        if (!retainLock) await releaseRestoreOperationLock(operationId)
    }
}

/**
 * Roll back ONLY the records touched by a specific restore operation whose current
 * revision in IndexedDB still matches the restore operation's afterRevision.
 * Never overwrites concurrent/subsequent user edits and never creates tombstones.
 */
export const rollbackRestoreOperation = async (operationId, fallbackJournal = null, customDb = null, { retainLock = false } = {}) => {
    try {
        const db = customDb || await openDB()
        const targetStores = [
            'books', 'book_files', 'highlights', 'bookmarks',
            'reading_sessions', 'chapter_translations', 'pdf_drawings',
            'custom_lists', 'settings', 'deleted_records'
        ].filter(s => db.objectStoreNames && db.objectStoreNames.contains(s))

        let journal = fallbackJournal
        if (!journal && operationId && targetStores.includes('settings')) {
            journal = await new Promise((resolve) => {
                try {
                    const rtx = db.transaction(['settings'], 'readonly')
                    const req = rtx.objectStore('settings').get(`${RESTORE_JOURNAL_PREFIX}${operationId}`)
                    req.onsuccess = () => resolve(req.result?.value || null)
                    req.onerror = () => resolve(null)
                } catch (_) {
                    resolve(null)
                }
            })
        }

        if (!journal || !Array.isArray(journal.entries)) {
            return { rolledBack: 0, skippedConcurrent: 0 }
        }

        let rolledBack = 0
        let skippedConcurrent = 0

        if (targetStores.length > 0) {
            await new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction(targetStores, 'readwrite')
                    for (const entry of journal.entries) {
                        if (!entry || !entry.store || !tx.objectStoreNames.contains(entry.store)) continue
                        const st = tx.objectStore(entry.store)
                        if (typeof st.get !== 'function') continue
                        const getReq = st.get(entry.key)
                        getReq.onsuccess = () => {
                            const current = getReq.result
                            if (entry.afterAction === 'put') {
                                if (current === undefined || current === null) {
                                    skippedConcurrent++
                                    return
                                }
                                const currentRev = computeRecordRevision(current)
                                if (entry.afterRevision && currentRev !== entry.afterRevision) {
                                    // Record was modified after the restore committed; preserve the newer user edit!
                                    skippedConcurrent++
                                    return
                                }
                                if (entry.hadBefore && entry.beforeImage !== null && entry.beforeImage !== undefined) {
                                    st.put(entry.beforeImage)
                                    rolledBack++
                                } else {
                                    st.delete(entry.key)
                                    rolledBack++
                                }
                            } else if (entry.afterAction === 'delete') {
                                if ((current === undefined || current === null) && entry.hadBefore && entry.beforeImage) {
                                    st.put(entry.beforeImage)
                                    rolledBack++
                                }
                            }
                        }
                    }
                    if (operationId && tx.objectStoreNames.contains('settings')) {
                        try {
                            tx.objectStore('settings').delete(`${RESTORE_JOURNAL_PREFIX}${operationId}`)
                        } catch (_) {}
                    }
                    tx.oncomplete = () => {
                        invalidateReadingStatsCache()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error || new Error('rollbackRestoreOperation failed'))
                    tx.onabort = () => reject(tx.error || new Error('rollbackRestoreOperation aborted'))
                } catch (e) {
                    reject(e)
                }
            })
        }

        if (Array.isArray(journal.localStorageEntries) && typeof localStorage !== 'undefined') {
            for (const lsEntry of journal.localStorageEntries) {
                if (!lsEntry || !lsEntry.key) continue
                try {
                    const currentVal = localStorage.getItem(lsEntry.key)
                    if (lsEntry.afterValue !== undefined && currentVal !== lsEntry.afterValue) {
                        // Key was modified after this restore operation applied; preserve newer settings!
                        skippedConcurrent++
                        continue
                    }
                    if (lsEntry.hadBefore && lsEntry.beforeValue !== null && lsEntry.beforeValue !== undefined) {
                        localStorage.setItem(lsEntry.key, lsEntry.beforeValue)
                        rolledBack++
                    } else {
                        localStorage.removeItem(lsEntry.key)
                        rolledBack++
                    }
                } catch (_) {}
            }
            try {
                localStorage.removeItem(RESTORE_LOCALSTORAGE_JOURNAL_KEY)
            } catch (_) {}
        }

        return { rolledBack, skippedConcurrent }
    } finally {
        if (!retainLock) await releaseRestoreOperationLock(operationId)
    }
}

/**
 * Startup takeover barrier: inspects any unfinished restore journals in IndexedDB / localStorage
 * and cleanly rolls them back before bookshelf or sync runs, ONLY if the exclusive lock for
 * that operationId is not currently held by an alive window.
 */
export const recoverPendingRestoreOperations = async (customDb = null) => {
    const db = customDb || await openDB()
    const readPending = async () => {
        const pending = []
        if (db.objectStoreNames?.contains('settings')) {
            const items = await new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction(['settings'], 'readonly')
                    const req = tx.objectStore('settings').getAll()
                    req.onsuccess = () => resolve(req.result || [])
                    req.onerror = () => reject(req.error || new Error('读取恢复记录失败'))
                } catch (err) { reject(err) }
            })
            for (const item of items) if (item && typeof item.key === 'string' && item.key.startsWith(RESTORE_JOURNAL_PREFIX) && item.value) pending.push(item.value)
        }
        if (pending.length === 0 && typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(RESTORE_LOCALSTORAGE_JOURNAL_KEY)
            if (raw) {
                let parsed
                try { parsed = JSON.parse(raw) } catch (_) { throw new Error('恢复日志损坏，请先备份应用数据后处理') }
                if (parsed?.operationId) pending.push(parsed)
            }
        }
        return pending
    }
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
        if ((await readPending()).length) throw new Error('存在未完成的恢复记录，但当前环境缺少跨窗口锁；已保留记录并停止自动接管')
        return 0
    }
    return await navigator.locks.request('linden_restore_database_mutex', { mode: 'exclusive', ifAvailable: true }, async globalLock => {
        if (!globalLock) return 0
        const pending = await readPending()
        let count = 0
        for (const journal of pending) {
            if (!journal?.operationId || _activeRestoreLockReleasers.has(journal.operationId)) continue
            const recovered = await navigator.locks.request(`linden_restore_op_${journal.operationId}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
                if (!lock) return false
                await rollbackRestoreOperation(journal.operationId, journal, db)
                return true
            })
            if (recovered) count++
        }
        return count
    })
}
