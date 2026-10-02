// db.js - IndexedDB storage wrapper for Universal E-Book Reader
import { buildTranslationRevisionArchive, checkTranslationCompatibility } from './translation-job-core.js'

const DB_NAME = 'UniversalReaderDB'
const DB_VERSION = 10

let dbInstance = null
let _openPromise = null

// Helper: Format Date to local 'YYYY-MM-DD'
export const toLocalDateKey = (dateInput = new Date()) => {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export const openDB = () => {
    if (dbInstance) return Promise.resolve(dbInstance)
    if (_openPromise) return _openPromise
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

export const isContentIdentityMatching = (item, currentSnapshot) => {
    if (!item || !currentSnapshot) return { matches: false, status: 'unconfirmed', pendingConfirmation: true }

    // Different bookId -> never matches
    if (item.bookId && currentSnapshot.bookId && item.bookId !== currentSnapshot.bookId) {
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
export const saveBook = async bookData => {
    const db = await openDB()
    const origin = await getRevisionOrigin()
    const { blob, nativePath, nativeSnapshotPath, ...meta } = bookData

    return new Promise((resolve, reject) => {
        try {
            const storeNames = (blob || nativePath) ? ['books', 'book_files'] : ['books']
            if (db.objectStoreNames.contains('deleted_records')) {
                storeNames.push('deleted_records')
            }
            const tx = db.transaction(storeNames, 'readwrite')
            const bookStore = tx.objectStore('books')

            if (meta.title != null) {
                if (blob) {
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
                        if (blob) {
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
            if ((blob || nativePath) && meta.id) {
                const fileStore = tx.objectStore('book_files')
                const fileReq = fileStore.get(meta.id)
                fileReq.onsuccess = () => {
                    const local = fileReq.result || { id: meta.id }
                    if (blob) {
                        previousSnapshotPath = local.nativeSnapshotPath || null
                        local.blob = blob
                        local.blobRevision = generateRevision()
                        local.revisionOrigin = origin
                        local.documentHash = null // Clear old hash association
                        local.nativeSnapshotPath = nativeSnapshotPath || null
                        local.nativeSnapshotRevision = nativeSnapshotPath ? local.blobRevision : null
                        local.nativeSnapshotOrigin = nativeSnapshotPath ? origin : null
                        local.nativeSnapshotSize = nativeSnapshotPath ? blob.size : null
                    }
                    if (nativePath !== undefined) local.nativePath = nativePath
                    local.updatedAt = Date.now()
                    fileStore.put(local)
                }
            }
            if (storeNames.includes('deleted_records') && meta.id && meta.title != null) {
                tx.objectStore('deleted_records').delete(meta.id)
                if (meta.stableKey) {
                    tx.objectStore('deleted_records').delete(`key:${meta.stableKey}`)
                }
            }
            tx.oncomplete = () => {
                if (previousSnapshotPath && previousSnapshotPath !== nativeSnapshotPath &&
                    typeof platformBridge !== 'undefined' && platformBridge.reclaimSnapshot) {
                    openDB().then(db2 => {
                        if (!db2.objectStoreNames.contains('book_files')) return
                        const checkTx = db2.transaction(['book_files'], 'readonly')
                        const req = checkTx.objectStore('book_files').getAll()
                        req.onsuccess = () => {
                            const files = req.result || []
                            const isStillReferenced = files.some(f => f.id !== meta.id && f.nativeSnapshotPath === previousSnapshotPath)
                            if (!isStillReferenced) {
                                platformBridge.reclaimSnapshot(previousSnapshotPath).catch(err => {
                                    console.warn('[db.saveBook] Replaced snapshot reclaim notice:', err)
                                })
                            }
                        }
                    }).catch(() => {})
                }
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
            req.onsuccess = () => {
                if (req.result && req.result.blob) {
                    resolve(req.result.blob)
                } else {
                    // Fallback to legacy books table
                    const bookReq = tx.objectStore('books').get(id)
                    bookReq.onsuccess = () => {
                        resolve(bookReq.result?.blob || null)
                    }
                    bookReq.onerror = () => resolve(null)
                }
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
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['books', 'book_files'], 'readwrite')
        const fileStore = tx.objectStore('book_files')
        const bookStore = tx.objectStore('books')

        const localReq = fileStore.get(id)
        localReq.onsuccess = () => {
            const local = localReq.result || { id }
            local.blob = blob
            local.blobRevision = generateRevision()
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
            format: bookRecord?.format || null,
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
            req.onsuccess = () => resolve(req.result || null)
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
                const list = req.result || []
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
                bookStore.delete(id)
                if (recordTombstone && storeNames.includes('deleted_records')) {
                    tx.objectStore('deleted_records').put({ id, stableKey, type: 'book', deletedAt: tombstoneTime })
                    if (stableKey) {
                        tx.objectStore('deleted_records').put({ id: `key:${stableKey}`, stableKey, type: 'book', deletedAt: tombstoneTime })
                    }
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
        tx.oncomplete = () => resolve(highlight.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to save highlight'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving highlight'))
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
        store.delete(id)
        if (recordTombstone && storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'highlight', deletedAt: tombstoneTime })
        }
        tx.oncomplete = () => resolve(true)
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
        tx.oncomplete = () => resolve(bookmark.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to save bookmark'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted saving bookmark'))
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
        store.delete(id)
        if (recordTombstone && storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'bookmark', deletedAt: tombstoneTime })
        }
        tx.oncomplete = () => resolve(true)
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
// Reading Sessions & Reading Analytics
// ==========================================
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
            const delta = Math.max(0, (session.durationSeconds || 0) - prevDuration)
            
            sessStore.put(session)

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
                        book.lastReadAt = Date.now()
                        bookStore.put(book)
                    }
                }
            }
        }

        tx.oncomplete = () => resolve(session.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to record session'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const saveReadingSession = recordReadingSession

export const getAllReadingSessions = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reading_sessions', 'readonly')
        const store = tx.objectStore('reading_sessions')
        const req = store.getAll()
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get sessions'))
    })
}

// Calculate Reading Full Statistics (Supports Week, Month, Year, Total views)
export const getReadingStats = async (viewMode = 'month', targetYear = new Date().getFullYear(), targetMonth = new Date().getMonth() + 1, weekOffset = 0) => {
    const allRawSessions = await getAllReadingSessions()
    const getSessionDur = s => {
        if (!s) return 0
        const v = s.durationSeconds != null ? s.durationSeconds
            : s.readingSeconds != null ? s.readingSeconds
            : s.seconds != null ? s.seconds : 0
        return typeof v === 'number' && !isNaN(v) && v > 0 ? Math.round(v) : 0
    }
    const sessions = allRawSessions.filter(s => s && getSessionDur(s) > 0)
    const books = await getAllBooks()
    const highlights = await getAllHighlights()

    const now = new Date()
    const todayStr = toLocalDateKey(now)
    let totalSeconds = 0
    const dailyMap = {} // 'YYYY-MM-DD' -> seconds
    const monthlyMap = {} // 'YYYY-MM' -> seconds
    const yearlyMap = {} // 'YYYY' -> seconds
    const activeDates = new Set()
    let earliestTime = now.getTime()

    const computeActiveSessionSeconds = (sessList) => {
        const rawIntervals = []
        let unintervaledSeconds = 0
        for (const s of sessList) {
            const dur = getSessionDur(s)
            if (dur <= 0) continue
            if (s.startTime) {
                const startMs = s.startTime
                const endMs = s.endTime || (startMs + dur * 1000)
                if (endMs > startMs) {
                    rawIntervals.push([startMs, endMs])
                } else {
                    unintervaledSeconds += dur
                }
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
                unionSecs += Math.round((cur[1] - cur[0]) / 1000)
                cur = [next[0], next[1]]
            }
        }
        unionSecs += Math.round((cur[1] - cur[0]) / 1000)
        return unionSecs + unintervaledSeconds
    }

    const dayGroupMap = new Map()
    for (const sess of sessions) {
        const d = sess.date || toLocalDateKey(sess.startTime || now)
        if (!dayGroupMap.has(d)) dayGroupMap.set(d, [])
        dayGroupMap.get(d).push(sess)

        if (sess.startTime && sess.startTime < earliestTime) {
            earliestTime = sess.startTime
        }
    }

    for (const [d, daySessions] of dayGroupMap.entries()) {
        const dur = computeActiveSessionSeconds(daySessions)
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

    // Include book totalReadingSeconds fallback if sessions store is empty
    if (sessions.length === 0) {
        for (const b of books) {
            if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
                const bTime = b.lastReadAt || b.addedAt || now.getTime()
                const d = toLocalDateKey(bTime)
                dailyMap[d] = (dailyMap[d] || 0) + b.totalReadingSeconds
                const ym = d.slice(0, 7)
                monthlyMap[ym] = (monthlyMap[ym] || 0) + b.totalReadingSeconds
                const y = d.slice(0, 4)
                yearlyMap[y] = (yearlyMap[y] || 0) + b.totalReadingSeconds
                if (bTime < earliestTime) earliestTime = bTime
                totalSeconds += b.totalReadingSeconds
            }
        }
        for (const [d, daySecs] of Object.entries(dailyMap)) {
            if (daySecs >= 60) {
                activeDates.add(d)
            }
        }
    }

    let totalBookFallback = 0
    for (const b of books) {
        if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
            totalBookFallback += b.totalReadingSeconds
        }
    }
    const finalTotalSeconds = Math.max(totalSeconds, totalBookFallback)

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
    const finishedCount = books.filter(b => b.readingStatus === 'finished' || Boolean(b.completedAt)).length
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
        periodBookDurationMap.set(bId, computeActiveSessionSeconds(bSessList))
    }

    const allSessionBookMap = new Map()
    const allBookSessions = new Map()
    for (const sess of allRawSessions) {
        if (sess && sess.bookId && (sess.durationSeconds || 0) > 0) {
            if (!allBookSessions.has(sess.bookId)) allBookSessions.set(sess.bookId, [])
            allBookSessions.get(sess.bookId).push(sess)
        }
    }
    for (const [bId, bSessList] of allBookSessions.entries()) {
        allSessionBookMap.set(bId, computeActiveSessionSeconds(bSessList))
    }
    const enrichedBooks = books.map(b => {
        const sessTotal = allSessionBookMap.get(b.id) || 0
        return {
            ...b,
            totalReadingSeconds: Math.max(b.totalReadingSeconds || 0, sessTotal)
        }
    })
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

    const periodFinishedBooks = periodBooks.filter(b => (b.progress?.fraction || 0) >= 0.99 || b.isFinished)

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
        streakDays,
        activeDaysCount: activeDates.size,
        companionDays,
        earliestDateStr: new Date(earliestTime).toLocaleDateString('zh-CN'),
        finishedCount,
        totalBooksCount: books.length,
        totalHighlightsCount: highlights.length,
        periodBooks,
        periodBooksCount: periodBooks.length,
        periodFinishedBooks,
        periodFinishedCount: periodFinishedBooks.length,
        periodHighlights,
        periodHighlightsCount: periodHighlights.length,
        chartData,
        peakInfo: peakInfo.seconds > 0 ? peakInfo : null,
        topBooks: topBooks.slice(0, 10),
        recentSessions: sessions.slice(0, 15)
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
            const pageMatch = drawing.id.match(/_page_(\d+)$/)
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

        const verifyAndResolve = (record) => {
            if (!record) return null
            const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash })
            return match.matches ? record : null
        }

        if (blobRevision) {
            const candidates = []
            if (revisionOrigin) {
                candidates.push(`${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`)
            }
            candidates.push(`${bookId}_rev_${blobRevision}_page_${pageIndex}`)
            candidates.push(`${bookId}_page_${pageIndex}`)

            const checkNextCandidate = () => {
                if (candidates.length === 0) return resolve(null)
                const candidateKey = candidates.shift()
                const req = store.get(candidateKey)
                req.onsuccess = () => {
                    const record = req.result
                    if (record) {
                        const verified = verifyAndResolve(record)
                        if (verified) {
                            return resolve(verified)
                        }
                        // If record fails identity check due to hash conflict or different revision/book, reject immediately!
                        const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash })
                        if (match.status === 'hash_conflict' || match.status === 'different_book') {
                            return resolve(null)
                        }
                    }
                    checkNextCandidate()
                }
                req.onerror = () => resolve(null)
            }

            checkNextCandidate()
        } else {
            const req = store.get(`${bookId}_page_${pageIndex}`)
            req.onsuccess = () => {
                const record = req.result
                if (!record) return resolve(null)
                if (documentHash || revisionOrigin) {
                    const match = isContentIdentityMatching(record, { bookId, blobRevision, revisionOrigin, documentHash })
                    if (!match.matches) return resolve(null)
                }
                resolve(record)
            }
            req.onerror = () => reject(req.error || new Error('Failed to get PDF drawing'))
        }
    })
}

export const clearPdfPageDrawing = async (bookId, pageIndex, recordTombstone = true, tombstoneTime = Date.now(), versionMeta = {}) => {
    if (!bookId || pageIndex == null) return false
    const db = await openDB()
    const { blobRevision = null, revisionOrigin = null } = versionMeta
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

    return new Promise((resolve, reject) => {
        const storeNames = recordTombstone && db.objectStoreNames.contains('deleted_records')
            ? ['pdf_drawings', 'deleted_records']
            : ['pdf_drawings']
        const tx = db.transaction(storeNames, 'readwrite')
        const drawStore = tx.objectStore('pdf_drawings')
        for (const k of keysToDelete) {
            drawStore.delete(k)
        }
        if (recordTombstone && storeNames.includes('deleted_records')) {
            const delStore = tx.objectStore('deleted_records')
            for (const k of keysToDelete) {
                delStore.put({
                    id: k,
                    type: 'pdfDrawing',
                    deletedAt: tombstoneTime
                })
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

export const recoverInterruptedAiMessages = async () => {
    if (typeof indexedDB === 'undefined') return 0
    const db = await openDB()
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
                        val.status = 'interrupted'
                        cursor.update(val)
                        recovered++
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
export const saveChapterTranslation = async (record) => {
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
                    try {
                        const json = JSON.stringify(cursor.value)
                        estimatedBytes += json.length * 2
                    } catch (err) {}
                    cursor.continue()
                } else {
                    resolve({ count, estimatedBytes })
                }
            }
            req.onerror = () => resolve({ count: 0, estimatedBytes: 0 })
        } catch (e) {
            resolve({ count: 0, estimatedBytes: 0 })
        }
    })
}

