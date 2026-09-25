// js/syncEngine.js - Multi-device WebDAV & Nutstore Sync and Conflict Resolution Engine
import * as db from './db.js'

let _activeSyncPromise = null

// Book Cloud Sync Safety Rules (Format & Size Defense)
export const MAX_AUTO_SYNC_BYTES = 15 * 1024 * 1024 // 15MB safe threshold for auto download/upload

export const ALLOWED_BOOK_FORMATS = new Set(['epub', 'pdf', 'mobi', 'azw', 'azw3', 'txt', 'cbz', 'docx', 'fb2', 'djvu', 'md'])

export const sanitizeSyncFormat = (raw) => {
    if (typeof raw !== 'string') return 'epub'
    const clean = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    return ALLOWED_BOOK_FORMATS.has(clean) ? clean : 'epub'
}

export const sanitizeCloudFileName = (raw) => {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.includes('%') || trimmed.startsWith('.')) {
        return null
    }
    return trimmed
}

export const isAutoDownloadEligible = (bookMeta) => {
    if (!bookMeta) return false
    const hasCloud = !!(bookMeta.cloudBackup?.hasBackup || bookMeta.hasCloudBackup)
    if (!hasCloud) return false
    const fmt = (bookMeta.format || '').toLowerCase()
    const size = bookMeta.size || bookMeta.cloudBackup?.size || 0
    // High-risk large formats (PDF, CBZ) require explicit user confirmation to protect 3GB monthly quota
    if (fmt === 'pdf' || fmt === 'cbz') return false
    if (size >= MAX_AUTO_SYNC_BYTES) return false
    return true
}

export const isAutoUploadEligible = (bookMeta) => {
    if (!bookMeta) return false
    const fmt = (bookMeta.format || '').toLowerCase()
    const size = bookMeta.size || 0
    // Never auto-upload PDF or CBZ or files >= 15MB to protect 1GB monthly quota
    if (fmt === 'pdf' || fmt === 'cbz') return false
    if (size >= MAX_AUTO_SYNC_BYTES) return false
    return true
}

/**
 * Pure deterministic reconciliation function for book sync metadata
 * Handles tags, readingStatus, completedAt (with explicit null preservation),
 * lists, favorites, progress, and cloud backup.
 * Both mergeSyncData and applyMergedPayloadToLocal MUST use this exact function.
 */
export const reconcileBookSyncMeta = (localBook = {}, incomingMeta = {}, localClientId = '', incomingClientId = '') => {
    const isIncomingNewer = (inTime, locTime) => {
        const iT = inTime || 0
        const lT = locTime || 0
        if (iT !== lT) return iT > lT
        return (incomingClientId || '') > (localClientId || '')
    }

    // 1. Tags: LWW based on explicit tagsUpdatedAt. Missing incoming tags never deletes local tags.
    let tags = localBook.tags || []
    let tagsUpdatedAt = localBook.tagsUpdatedAt || 0
    if (Array.isArray(incomingMeta.tags)) {
        if (isIncomingNewer(incomingMeta.tagsUpdatedAt, localBook.tagsUpdatedAt)) {
            tags = incomingMeta.tags
            tagsUpdatedAt = incomingMeta.tagsUpdatedAt || 0
        }
    }

    // 2. Reading Status & completedAt: LWW based on statusUpdatedAt
    let readingStatus = localBook.readingStatus || 'unread'
    let statusUpdatedAt = localBook.statusUpdatedAt || 0
    let completedAt = localBook.completedAt !== undefined ? localBook.completedAt : null

    if (incomingMeta.readingStatus && isIncomingNewer(incomingMeta.statusUpdatedAt, localBook.statusUpdatedAt)) {
        readingStatus = incomingMeta.readingStatus
        statusUpdatedAt = incomingMeta.statusUpdatedAt || 0
        // Explicitly preserve null when un-marking finished!
        if (incomingMeta.completedAt !== undefined) {
            completedAt = incomingMeta.completedAt
        } else {
            completedAt = (incomingMeta.readingStatus === 'finished') ? (incomingMeta.statusUpdatedAt || Date.now()) : null
        }
    }

    // 3. Custom Lists: LWW based on listsUpdatedAt
    let customListIds = localBook.customListIds || []
    let listsUpdatedAt = localBook.listsUpdatedAt || 0
    if (Array.isArray(incomingMeta.customListIds)) {
        if (isIncomingNewer(incomingMeta.listsUpdatedAt, localBook.listsUpdatedAt)) {
            customListIds = incomingMeta.customListIds
            listsUpdatedAt = incomingMeta.listsUpdatedAt || 0
        }
    }

    // 4. Favorite: LWW based on favoriteUpdatedAt
    let isFavorite = Boolean(localBook.isFavorite)
    let favoriteUpdatedAt = localBook.favoriteUpdatedAt || 0
    if (incomingMeta.favoriteUpdatedAt || incomingMeta.isFavorite !== undefined) {
        if (isIncomingNewer(incomingMeta.favoriteUpdatedAt, localBook.favoriteUpdatedAt)) {
            isFavorite = Boolean(incomingMeta.isFavorite)
            favoriteUpdatedAt = incomingMeta.favoriteUpdatedAt || 0
        }
    }

    // 5. Reading Progress & Last Read
    const localReadTime = localBook.lastReadAt || 0
    const inReadTime = incomingMeta.lastReadAt || 0
    let isIncomingReadNewer = false
    if (inReadTime !== localReadTime) {
        isIncomingReadNewer = inReadTime > localReadTime
    } else {
        isIncomingReadNewer = (incomingMeta.progress?.fraction || 0) > (localBook.progress?.fraction || 0)
    }

    const progress = isIncomingReadNewer ? (incomingMeta.progress || localBook.progress) : (localBook.progress || incomingMeta.progress)
    const lastReadAt = Math.max(localReadTime, inReadTime)
    const totalReadingSeconds = Math.max(localBook.totalReadingSeconds || 0, incomingMeta.totalReadingSeconds || 0)

    // 6. Cloud Backup: newer uploadedAt wins
    let cloudBackup = localBook.cloudBackup || null
    if (incomingMeta.cloudBackup) {
        const inUp = incomingMeta.cloudBackup.uploadedAt || 0
        const locUp = localBook.cloudBackup?.uploadedAt || 0
        if (inUp >= locUp || !localBook.cloudBackup?.hasBackup) {
            cloudBackup = incomingMeta.cloudBackup
        }
    }

    return {
        tags,
        tagsUpdatedAt,
        readingStatus,
        statusUpdatedAt,
        completedAt,
        customListIds,
        listsUpdatedAt,
        isFavorite,
        favoriteUpdatedAt,
        progress,
        lastReadAt,
        totalReadingSeconds,
        cloudBackup
    }
}

/**
 * 1. Export local sync payload from IndexedDB
 */
export const buildBookSyncMeta = (b) => {
    const rawIdent = b.identifier
    const isEphemeral = typeof rawIdent === 'string' && /^(txt|docx|pdf)-\d{10,}$/.test(rawIdent)
    const validIdent = isEphemeral ? null : rawIdent
    const stableKey = b.stableKey || validIdent || `${b.title || ''}_${b.size || 0}_${b.format || ''}`.replace(/\s+/g, '').toLowerCase()
    return {
        id: b.id,
        stableKey,
        identifier: validIdent,
        title: b.title,
        author: b.author,
        format: b.format,
        size: b.size,
        cover: b.cover || null,
        isFavorite: !!b.isFavorite,
        favoriteUpdatedAt: b.favoriteUpdatedAt || b.updatedAt || 0,
        customListIds: b.customListIds || [],
        listsUpdatedAt: b.listsUpdatedAt || b.updatedAt || 0,
        progress: b.progress || { fraction: 0 },
        tags: Array.isArray(b.tags) ? b.tags : [],
        tagsUpdatedAt: b.tagsUpdatedAt || 0,
        readingStatus: b.readingStatus || (b.lastReadAt > 0 ? 'reading' : 'unread'),
        statusUpdatedAt: b.statusUpdatedAt || 0,
        completedAt: b.completedAt || null,
        lastReadAt: b.lastReadAt || 0,
        totalReadingSeconds: b.totalReadingSeconds || 0,
        addedAt: b.addedAt || Date.now(),
        updatedAt: b.updatedAt || b.lastReadAt || b.addedAt || Date.now(),
        cloudBackup: b.cloudBackup || (b.cloudBackupState === 'synced' ? {
            hasBackup: true,
            fileName: b.cloudBackupFileName || `${b.stableKey || b.id}.${b.format}`,
            size: b.size,
            format: b.format,
            uploadedAt: b.cloudBackupUploadedAt || Date.now()
        } : null)
    }
}

export const exportSyncPayload = async () => {
    const allBooks = await db.getAllBooks()
    const allLists = await db.getAllCustomLists()
    const allHighlights = await db.getAllHighlights()
    const allBookmarks = await db.getAllBookmarks()
    const allSessions = await db.getAllReadingSessions()
    const deletedRecords = await db.getAllDeletedRecords()
    const allPdfDrawings = (typeof db.getAllPdfDrawings === 'function') ? (await db.getAllPdfDrawings()) : []
    const settings = (await db.getSetting('readerSettings')) || (await db.getSetting('reader_settings')) || {}

    const booksMeta = allBooks.map(buildBookSyncMeta)


    return {
        version: 1,
        clientId: localStorage.getItem('linden_sync_client_id') || `client_${Math.random().toString(36).slice(2, 10)}`,
        deviceName: navigator.userAgent.includes('Windows') ? 'Windows PC' : 'Linden 客户端',
        updatedAt: Date.now(),
        settings,
        customLists: allLists,
        booksMeta,
        highlights: allHighlights,
        bookmarks: allBookmarks,
        readingSessions: allSessions,
        pdfDrawings: allPdfDrawings,
        deletedRecords: deletedRecords || []
    }
}

/**
 * 2. Deterministic LWW Merge Algorithm
 */
export const mergeSyncData = (localPayload, remotePayload) => {
    if (!remotePayload || !remotePayload.booksMeta) {
        return {
            merged: localPayload,
            stats: { booksUpdated: 0, highlightsAdded: 0, sessionsAdded: 0, listsAdded: 0 }
        }
    }

    const stats = {
        booksUpdated: 0,
        highlightsAdded: 0,
        sessionsAdded: 0,
        listsAdded: 0
    }

    const maxAllowedTime = Date.now() + 60 * 1000 // Allow max 1 min clock drift
    const clampTime = (t) => (typeof t === 'number' && !isNaN(t) ? Math.min(t, maxAllowedTime) : 0)

    // A. Merge Tombstones (Deleted Records with plural/singular normalization and 60-day TTL)
    const TOMBSTONE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000 // 60 days TTL to prevent infinite JSON bloat
    const minTombstoneTime = Date.now() - TOMBSTONE_MAX_AGE_MS

    const normalizeTombType = t => {
        if (!t) return 'unknown'
        if (t === 'bookmarks') return 'bookmark'
        if (t === 'highlights') return 'highlight'
        if (t === 'books') return 'book'
        if (t === 'pdf_drawings' || t === 'pdfDrawing') return 'pdfDrawing'
        return t
    }
    const tombstoneMap = new Map()
    const registerTomb = (t, delTime) => {
        if (!t || !t.id) return
        const normType = normalizeTombType(t.type)
        const key = `${normType}:${t.id}`
        if (!tombstoneMap.has(key) || delTime >= (tombstoneMap.get(key).deletedAt || 0)) {
            tombstoneMap.set(key, { ...t, type: normType, deletedAt: delTime })
        }
        if (normType === 'book' && t.stableKey) {
            const keyByStable = `book:${t.stableKey}`
            if (!tombstoneMap.has(keyByStable) || delTime >= (tombstoneMap.get(keyByStable).deletedAt || 0)) {
                tombstoneMap.set(keyByStable, { ...t, type: 'book', deletedAt: delTime })
            }
        }
    }

    ;(remotePayload.deletedRecords || []).forEach(t => {
        if (t && t.id) {
            const delTime = clampTime(t.deletedAt)
            if (delTime >= minTombstoneTime) {
                registerTomb(t, delTime)
            }
        }
    })
    ;(localPayload.deletedRecords || []).forEach(t => {
        if (!t || !t.id) return
        const localDel = clampTime(t.deletedAt)
        if (localDel < minTombstoneTime) return
        registerTomb(t, localDel)
    })

    // B. Merge Custom Lists (Union by ID with Tombstone filtering)
    const listMap = new Map()
    ;(remotePayload.customLists || []).forEach(l => {
        if (l && l.id) listMap.set(l.id, { ...l, updatedAt: clampTime(l.updatedAt), createdAt: clampTime(l.createdAt) })
    })
    ;(localPayload.customLists || []).forEach(l => {
        if (!l || !l.id) return
        const localUpdated = clampTime(l.updatedAt) || clampTime(l.createdAt) || 0
        if (!listMap.has(l.id)) {
            listMap.set(l.id, { ...l, updatedAt: localUpdated })
            stats.listsAdded++
        } else {
            const remoteL = listMap.get(l.id)
            const remoteUpdated = (remoteL.updatedAt || remoteL.createdAt || 0)
            const isLocalNewer = localUpdated > remoteUpdated || (localUpdated === remoteUpdated && (localPayload.clientId || '') >= (remotePayload.clientId || ''))
            const newer = isLocalNewer ? { ...l, updatedAt: localUpdated } : remoteL
            listMap.set(l.id, newer)
        }
    })
    const mergedCustomLists = Array.from(listMap.values()).filter(l => {
        const tombKey = `custom_list:${l.id}`
        if (tombstoneMap.has(tombKey)) {
            const tomb = tombstoneMap.get(tombKey)
            if ((tomb.deletedAt || 0) >= (l.updatedAt || l.createdAt || 0)) return false
        }
        return !l.deleted
    })

    // C. Merge Books Metadata & Progress (LWW on lastReadAt / fraction with stableKey resolution)
    const bookMap = new Map()
    ;(localPayload.booksMeta || []).forEach(b => {
        if (b && b.id) {
            bookMap.set(b.id, {
                ...b,
                lastReadAt: clampTime(b.lastReadAt),
                favoriteUpdatedAt: clampTime(b.favoriteUpdatedAt),
                listsUpdatedAt: clampTime(b.listsUpdatedAt),
                tagsUpdatedAt: clampTime(b.tagsUpdatedAt),
                statusUpdatedAt: clampTime(b.statusUpdatedAt),
                updatedAt: clampTime(b.updatedAt),
                isLocal: true
            })
        }
    })

    ;(remotePayload.booksMeta || []).forEach(remoteBook => {
        if (!remoteBook || !remoteBook.id) return
        const rLastRead = clampTime(remoteBook.lastReadAt)
        const rUpdated = clampTime(remoteBook.updatedAt)
        const rFavUpdated = clampTime(remoteBook.favoriteUpdatedAt)
        const rListsUpdated = clampTime(remoteBook.listsUpdatedAt)
        const rTagsUpdated = clampTime(remoteBook.tagsUpdatedAt)
        const rStatusUpdated = clampTime(remoteBook.statusUpdatedAt)

        const safeFormat = sanitizeSyncFormat(remoteBook.format)
        let safeCloud = remoteBook.cloudBackup
        if (safeCloud) {
            const safeName = sanitizeCloudFileName(safeCloud.fileName)
            safeCloud = safeName ? { ...safeCloud, fileName: safeName } : { ...safeCloud, hasBackup: false, fileName: null }
        }
        const cleanRemoteBook = {
            ...remoteBook,
            format: safeFormat,
            cloudBackup: safeCloud
        }

        let localBook = bookMap.get(cleanRemoteBook.id)
        if (!localBook && cleanRemoteBook.stableKey) {
            localBook = Array.from(bookMap.values()).find(b => b.isLocal && b.stableKey && b.stableKey === cleanRemoteBook.stableKey)
        }

        if (!localBook) {
            bookMap.set(cleanRemoteBook.id, {
                ...cleanRemoteBook,
                tags: Array.isArray(cleanRemoteBook.tags) ? cleanRemoteBook.tags : [],
                tagsUpdatedAt: rTagsUpdated,
                readingStatus: cleanRemoteBook.readingStatus || 'unread',
                statusUpdatedAt: rStatusUpdated,
                completedAt: cleanRemoteBook.completedAt || null,
                lastReadAt: rLastRead,
                updatedAt: rUpdated,
                favoriteUpdatedAt: rFavUpdated,
                listsUpdatedAt: rListsUpdated,
                isRemoteOnly: true
            })
            stats.booksUpdated++
        } else {
            const localReadTime = localBook.lastReadAt || 0
            const remoteReadTime = rLastRead || 0
            const reconciled = reconcileBookSyncMeta(localBook, cleanRemoteBook, localPayload.clientId, remotePayload.clientId)

            if (remoteReadTime > localReadTime || cleanRemoteBook.totalReadingSeconds !== localBook.totalReadingSeconds) {
                stats.booksUpdated++
            }

            bookMap.set(localBook.id, {
                ...localBook,
                format: sanitizeSyncFormat(localBook.format || cleanRemoteBook.format),
                stableKey: localBook.stableKey || cleanRemoteBook.stableKey,
                cloudBackup: reconciled.cloudBackup,
                progress: reconciled.progress,
                lastReadAt: reconciled.lastReadAt,
                totalReadingSeconds: reconciled.totalReadingSeconds,
                customListIds: reconciled.customListIds,
                tags: reconciled.tags,
                tagsUpdatedAt: reconciled.tagsUpdatedAt,
                readingStatus: reconciled.readingStatus,
                statusUpdatedAt: reconciled.statusUpdatedAt,
                completedAt: reconciled.completedAt,
                isFavorite: reconciled.isFavorite,
                favoriteUpdatedAt: reconciled.favoriteUpdatedAt,
                listsUpdatedAt: reconciled.listsUpdatedAt,
                updatedAt: Math.max(localBook.updatedAt || 0, rUpdated)
            })
        }
    })
    
    // Filter books by book tombstones (checking both id and stableKey)
    const mergedBooksMeta = Array.from(bookMap.values()).filter(b => {
        const tombKey = `book:${b.id}`
        const tombByKey = b.stableKey ? `book:${b.stableKey}` : null
        const tomb = tombstoneMap.get(tombKey) || (tombByKey ? tombstoneMap.get(tombByKey) : null)
        if (tomb) {
            if ((tomb.deletedAt || 0) >= (b.updatedAt || b.addedAt || 0)) return false
        }
        return true
    })
    const validBookIdSet = new Set(mergedBooksMeta.map(b => b.id))

    // Map remote book IDs to local book IDs for books matched by stableKey
    const bookIdRemap = new Map()
    ;(remotePayload.booksMeta || []).forEach(remoteBook => {
        if (!remoteBook || !remoteBook.id) return
        let localBook = bookMap.get(remoteBook.id)
        if (!localBook && remoteBook.stableKey) {
            localBook = Array.from(bookMap.values()).find(b => b.isLocal && b.stableKey && b.stableKey === remoteBook.stableKey)
        }
        if (localBook && localBook.id !== remoteBook.id) {
            bookIdRemap.set(remoteBook.id, localBook.id)
        }
    })

    // D. Merge Highlights & Notes (Union by ID with Tombstone filtering and BookId Remapping)
    const hlMap = new Map()
    ;(remotePayload.highlights || []).forEach(h => {
        if (h && h.id) {
            const targetBookId = (h.bookId && bookIdRemap.has(h.bookId)) ? bookIdRemap.get(h.bookId) : h.bookId
            hlMap.set(h.id, { ...h, bookId: targetBookId, updatedAt: clampTime(h.updatedAt), createdAt: clampTime(h.createdAt) })
        }
    })
    ;(localPayload.highlights || []).forEach(h => {
        if (!h || !h.id) return
        const localUpdated = clampTime(h.updatedAt) || clampTime(h.createdAt) || 0
        if (!hlMap.has(h.id)) {
            hlMap.set(h.id, { ...h, updatedAt: localUpdated })
            stats.highlightsAdded++
        } else {
            const remoteH = hlMap.get(h.id)
            const remoteUpdated = (remoteH.updatedAt || remoteH.createdAt || 0)
            const isLocalNewer = localUpdated > remoteUpdated || (localUpdated === remoteUpdated && (localPayload.clientId || '') >= (remotePayload.clientId || ''))
            const newer = isLocalNewer ? { ...h, updatedAt: localUpdated } : remoteH
            hlMap.set(h.id, newer)
        }
    })
    const mergedHighlights = Array.from(hlMap.values()).filter(h => {
        const tombKey = `highlight:${h.id}`
        if (tombstoneMap.has(tombKey)) {
            const tomb = tombstoneMap.get(tombKey)
            if ((tomb.deletedAt || 0) >= (h.updatedAt || h.createdAt || 0)) return false
        }
        // Filter out orphaned highlights if parent book was deleted
        if (h.bookId && (tombstoneMap.has(`book:${h.bookId}`) || !validBookIdSet.has(h.bookId))) {
            return false
        }
        return !h.deleted
    })

    // E. Merge Bookmarks (Union by ID with Tombstone filtering and BookId Remapping)
    const bmMap = new Map()
    ;(remotePayload.bookmarks || []).forEach(b => {
        if (b && b.id) {
            const targetBookId = (b.bookId && bookIdRemap.has(b.bookId)) ? bookIdRemap.get(b.bookId) : b.bookId
            bmMap.set(b.id, { ...b, bookId: targetBookId, createdAt: clampTime(b.createdAt) })
        }
    })
    ;(localPayload.bookmarks || []).forEach(b => {
        if (!b || !b.id) return
        const localCreated = clampTime(b.createdAt) || 0
        if (!bmMap.has(b.id)) {
            bmMap.set(b.id, { ...b, createdAt: localCreated })
        } else {
            const remoteB = bmMap.get(b.id)
            const remoteCreated = remoteB.createdAt || 0
            const isLocalNewer = localCreated > remoteCreated || (localCreated === remoteCreated && (localPayload.clientId || '') >= (remotePayload.clientId || ''))
            const newer = isLocalNewer ? { ...b, createdAt: localCreated } : remoteB
            bmMap.set(b.id, newer)
        }
    })
    const mergedBookmarks = Array.from(bmMap.values()).filter(b => {
        const tombKey = `bookmark:${b.id}`
        if (tombstoneMap.has(tombKey)) {
            const tomb = tombstoneMap.get(tombKey)
            if ((tomb.deletedAt || 0) >= (b.createdAt || 0)) return false
        }
        // Filter out orphaned bookmarks if parent book was deleted
        if (b.bookId && (tombstoneMap.has(`book:${b.bookId}`) || !validBookIdSet.has(b.bookId))) {
            return false
        }
        return !b.deleted
    })

    // F. Merge Reading Sessions (Union by ID with duration max and BookId Remapping)
    const sessMap = new Map()
    ;(remotePayload.readingSessions || []).forEach(s => {
        if (s && s.id) {
            const targetBookId = (s.bookId && bookIdRemap.has(s.bookId)) ? bookIdRemap.get(s.bookId) : s.bookId
            sessMap.set(s.id, { ...s, bookId: targetBookId })
        }
    })
    ;(localPayload.readingSessions || []).forEach(s => {
        if (!s || !s.id) return
        if (!sessMap.has(s.id)) {
            sessMap.set(s.id, s)
            stats.sessionsAdded++
        } else {
            const remoteS = sessMap.get(s.id)
            const localDur = s.durationSeconds || 0
            const remoteDur = remoteS.durationSeconds || 0
            if (localDur > remoteDur || (localDur === remoteDur && (s.endTime || 0) > (remoteS.endTime || 0))) {
                sessMap.set(s.id, { ...remoteS, ...s, durationSeconds: Math.max(localDur, remoteDur) })
            }
        }
    })
    const mergedSessions = Array.from(sessMap.values())

    // G. Merge Settings (LWW on updatedAt)
    const localSetTime = localPayload.settings?.updatedAt || 0
    const remoteSetTime = remotePayload.settings?.updatedAt || 0
    const mergedSettings = remoteSetTime > localSetTime ? remotePayload.settings : localPayload.settings

    // H. Merge PDF Drawings (LWW by id and updatedAt, filtered by book tombstones and BookId Remapping)
    const drawingMap = new Map()
    ;(remotePayload.pdfDrawings || []).forEach(d => {
        if (d && d.id) {
            let targetBookId = d.bookId
            if (d.bookId && bookIdRemap.has(d.bookId)) {
                targetBookId = bookIdRemap.get(d.bookId)
            }
            const targetId = db.remapPdfDrawingId ? db.remapPdfDrawingId(d, targetBookId) : d.id
            drawingMap.set(targetId, { ...d, id: targetId, bookId: targetBookId, updatedAt: clampTime(d.updatedAt) })
        }
    })
    ;(localPayload.pdfDrawings || []).forEach(d => {
        if (!d || !d.id) return
        const localUpdated = clampTime(d.updatedAt)
        const localId = db.remapPdfDrawingId ? db.remapPdfDrawingId(d, d.bookId) : d.id
        const localRecord = { ...d, id: localId, updatedAt: localUpdated }
        if (!drawingMap.has(localId)) {
            drawingMap.set(localId, localRecord)
        } else {
            const remoteD = drawingMap.get(localId)
            if (localUpdated >= (remoteD.updatedAt || 0)) {
                drawingMap.set(localId, localRecord)
            }
        }
    })
    const mergedPdfDrawings = Array.from(drawingMap.values()).filter(d => {
        if (!d || !d.bookId) return false
        const bookTombKey = `book:${d.bookId}`
        if (tombstoneMap.has(bookTombKey)) return false
        const drawingTombKey = `pdfDrawing:${d.id}`
        if (tombstoneMap.has(drawingTombKey)) {
            const tomb = tombstoneMap.get(drawingTombKey)
            if ((tomb.deletedAt || 0) >= (d.updatedAt || 0)) return false
        }
        return true
    })

    const merged = {
        version: 1,
        updatedAt: Date.now(),
        settings: mergedSettings,
        customLists: mergedCustomLists,
        booksMeta: mergedBooksMeta,
        highlights: mergedHighlights,
        bookmarks: mergedBookmarks,
        readingSessions: mergedSessions,
        pdfDrawings: mergedPdfDrawings,
        deletedRecords: Array.from(tombstoneMap.values())
    }

    return { merged, stats }
}
/**
 * 3. Apply Merged Payload back into Local IndexedDB
 */
export const applyMergedPayload = async mergedPayload => {
    const allLocalBooks = await db.getAllBooks()

    // A. Apply Deletion Tombstones (with protection for re-imported / surviving books)
    const survivingBookIds = new Set((mergedPayload.booksMeta || []).map(b => b.id))
    const survivingStableKeys = new Set((mergedPayload.booksMeta || []).filter(b => b.stableKey).map(b => b.stableKey))
    const deletedBookIds = []
    const deletedStableKeys = new Set()
    if (Array.isArray(mergedPayload.deletedRecords)) {
        for (const tomb of mergedPayload.deletedRecords) {
            if (tomb && tomb.id) {
                const delTime = tomb.deletedAt || Date.now()
                if (tomb.type === 'book' || tomb.type === 'books') {
                    // Never delete a book if it survived in mergedPayload.booksMeta or if local book was added/updated after tombstone
                    if (survivingBookIds.has(tomb.id) || (tomb.stableKey && survivingStableKeys.has(tomb.stableKey))) {
                        continue
                    }
                    const localByStable = tomb.stableKey ? allLocalBooks.find(b => b.stableKey === tomb.stableKey) : null
                    const localBook = allLocalBooks.find(b => b.id === tomb.id) || localByStable
                    if (localBook && (localBook.updatedAt || localBook.addedAt || 0) > delTime) {
                        continue
                    }

                    await db.deleteBook(tomb.id, false, delTime)
                    deletedBookIds.push(tomb.id)
                    // Also cross-delete local book matching stableKey if ID differed across devices
                    if (tomb.stableKey) {
                        deletedStableKeys.add(tomb.stableKey)
                        if (localByStable && localByStable.id !== tomb.id) {
                            await db.deleteBook(localByStable.id, false, delTime)
                            deletedBookIds.push(localByStable.id)
                        }
                    }
                } else if (tomb.type === 'highlight' || tomb.type === 'highlights') {
                    await db.deleteHighlight(tomb.id, false, delTime)
                } else if (tomb.type === 'bookmark' || tomb.type === 'bookmarks') {
                    await db.deleteBookmark(tomb.id, false, delTime)
                } else if (tomb.type === 'custom_list') {
                    await db.deleteCustomList(tomb.id, false, delTime)
                } else if (tomb.type === 'pdfDrawing' || tomb.type === 'pdf_drawings') {
                    const parts = tomb.id.split('_page_')
                    const localDrawing = parts.length === 2 ? await db.getPdfPageDrawing(parts[0], parseInt(parts[1], 10)) : null
                    if (!localDrawing || delTime >= (localDrawing.updatedAt || 0)) {
                        await db.clearPdfDrawingById(tomb.id)
                    }
                }
            }
        }
    }

    // B. Apply custom lists
    if (Array.isArray(mergedPayload.customLists)) {
        for (const list of mergedPayload.customLists) {
            await db.saveCustomList(list)
        }
    }

    // C. Apply books progress, reading times, favorite & lists (with BookId Remapping for multi-device sync)
    const bookIdRemap = new Map()
    const pendingAutoDownloads = []
    if (Array.isArray(mergedPayload.booksMeta)) {
        for (const meta of mergedPayload.booksMeta) {
            if (!meta || !meta.id) continue
            if (deletedBookIds.includes(meta.id) || (meta.stableKey && deletedStableKeys.has(meta.stableKey))) {
                continue
            }
            let localBook = allLocalBooks.find(b => b.id === meta.id)
            if (!localBook && meta.stableKey) {
                localBook = allLocalBooks.find(b => (b.stableKey && b.stableKey === meta.stableKey) || 
                    (meta.title && meta.size > 0 && b.title === meta.title && b.size === meta.size))
            }
            if (localBook && localBook.id !== meta.id) {
                bookIdRemap.set(meta.id, localBook.id)
            }
            if (localBook) {
                let changed = false
                const reconciled = reconcileBookSyncMeta(localBook, meta, '', 'incoming')

                if (JSON.stringify(localBook.tags || []) !== JSON.stringify(reconciled.tags || [])) {
                    localBook.tags = reconciled.tags
                    localBook.tagsUpdatedAt = reconciled.tagsUpdatedAt
                    changed = true
                }
                if (localBook.readingStatus !== reconciled.readingStatus || localBook.completedAt !== reconciled.completedAt) {
                    localBook.readingStatus = reconciled.readingStatus
                    localBook.statusUpdatedAt = reconciled.statusUpdatedAt
                    localBook.completedAt = reconciled.completedAt
                    changed = true
                }
                if (JSON.stringify(localBook.customListIds || []) !== JSON.stringify(reconciled.customListIds || [])) {
                    localBook.customListIds = reconciled.customListIds
                    localBook.listsUpdatedAt = reconciled.listsUpdatedAt
                    changed = true
                }
                if (localBook.isFavorite !== reconciled.isFavorite) {
                    localBook.isFavorite = reconciled.isFavorite
                    localBook.favoriteUpdatedAt = reconciled.favoriteUpdatedAt
                    changed = true
                }
                if (reconciled.lastReadAt > (localBook.lastReadAt || 0) || (reconciled.progress && !localBook.progress)) {
                    localBook.progress = reconciled.progress
                    localBook.lastReadAt = reconciled.lastReadAt
                    changed = true
                }
                if (reconciled.totalReadingSeconds > (localBook.totalReadingSeconds || 0)) {
                    localBook.totalReadingSeconds = reconciled.totalReadingSeconds
                    changed = true
                }
                if (reconciled.cloudBackup && (!localBook.cloudBackup || (reconciled.cloudBackup.uploadedAt || 0) >= (localBook.cloudBackup?.uploadedAt || 0))) {
                    localBook.cloudBackup = reconciled.cloudBackup
                    changed = true
                }
                if (changed) {
                    localBook.updatedAt = meta.updatedAt || localBook.updatedAt || Date.now()
                    localBook._preserveUpdatedAt = true
                    await db.saveBook(localBook)
                }
                if (localBook.isCloudOnly && isAutoDownloadEligible(meta)) {
                    localBook.cloudBackupState = 'pending_auto_download'
                    await db.saveBook(localBook)
                    pendingAutoDownloads.push(localBook)
                }
            } else if (meta.cloudBackup && meta.cloudBackup.hasBackup) {
                // Book exists in cloud but not locally: create cloud-only placeholder
                const isAutoEligible = isAutoDownloadEligible(meta)
                const cloudBookRecord = {
                    ...meta,
                    format: sanitizeSyncFormat(meta.format),
                    isCloudOnly: true,
                    hasLocalFile: false,
                    tags: Array.isArray(meta.tags) ? meta.tags : [],
                    tagsUpdatedAt: meta.tagsUpdatedAt || 0,
                    readingStatus: meta.readingStatus || 'unread',
                    statusUpdatedAt: meta.statusUpdatedAt || 0,
                    completedAt: meta.completedAt || null,
                    cloudBackup: meta.cloudBackup,
                    cloudBackupState: isAutoEligible ? 'pending_auto_download' : 'cloud_only',
                    addedAt: meta.addedAt || Date.now(),
                    updatedAt: meta.updatedAt || Date.now(),
                    _preserveUpdatedAt: true
                }
                await db.saveBook(cloudBookRecord)
                if (isAutoEligible) {
                    pendingAutoDownloads.push(cloudBookRecord)
                }
            }
        }
    }


    // D. Apply Highlights (with BookId Remapping)
    if (Array.isArray(mergedPayload.highlights)) {
        for (const hl of mergedPayload.highlights) {
            if (!hl) continue
            if (hl.bookId && bookIdRemap.has(hl.bookId)) {
                hl.bookId = bookIdRemap.get(hl.bookId)
            }
            if (hl.bookId && deletedBookIds.includes(hl.bookId)) {
                continue
            }
            await db.saveHighlight(hl)
        }
    }

    // E. Apply Bookmarks (with BookId Remapping)
    if (Array.isArray(mergedPayload.bookmarks)) {
        for (const bm of mergedPayload.bookmarks) {
            if (!bm) continue
            if (bm.bookId && bookIdRemap.has(bm.bookId)) {
                bm.bookId = bookIdRemap.get(bm.bookId)
            }
            if (bm.bookId && deletedBookIds.includes(bm.bookId)) {
                continue
            }
            await db.saveBookmark(bm)
        }
    }

    // F. Apply Reading Sessions (with BookId Remapping, pass false to prevent duplicate duration addition to books)
    if (Array.isArray(mergedPayload.readingSessions)) {
        for (const sess of mergedPayload.readingSessions) {
            if (!sess) continue
            if (sess.bookId && bookIdRemap.has(sess.bookId)) {
                sess.bookId = bookIdRemap.get(sess.bookId)
            }
            if (sess.bookId && deletedBookIds.includes(sess.bookId)) {
                continue
            }
            await db.saveReadingSession(sess, false)
        }
    }

    // G. Apply Settings
    if (mergedPayload.settings && typeof mergedPayload.settings === 'object' && Object.keys(mergedPayload.settings).length > 0) {
        const localSettings = (await db.getSetting('readerSettings')) || {}
        const mergedSettings = { ...localSettings, ...mergedPayload.settings }
        await db.setSetting('readerSettings', mergedSettings)
    }

    // H. Apply PDF Drawings (with BookId Remapping)
    if (Array.isArray(mergedPayload.pdfDrawings) && mergedPayload.pdfDrawings.length > 0) {
        const dbInstance = await db.openDB()
        if (dbInstance.objectStoreNames.contains('pdf_drawings')) {
            const tx = dbInstance.transaction('pdf_drawings', 'readwrite')
            const store = tx.objectStore('pdf_drawings')
            mergedPayload.pdfDrawings.forEach(d => {
                if (!d) return
                let targetBookId = d.bookId
                if (d.bookId && bookIdRemap.has(d.bookId)) {
                    targetBookId = bookIdRemap.get(d.bookId)
                }
                d.bookId = targetBookId
                d.id = db.remapPdfDrawingId ? db.remapPdfDrawingId(d, targetBookId) : d.id
                if (d.bookId && deletedBookIds.includes(d.bookId)) {
                    return
                }
                store.put(d)
            })
            await new Promise((res, rej) => {
                tx.oncomplete = () => res()
                tx.onerror = () => rej(tx.error || new Error('Failed to save pdf drawings transaction'))
            })
        }
    }

    return { success: true, pendingAutoDownloads: pendingAutoDownloads || [], deletedBookIds: deletedBookIds || [] }
}

/**
 * 4. Master Full Sync Lifecycle Executor with Mutex and ETag Optimistic Concurrency
 */
export const executeSyncLifecycle = async (config, { onProgress = () => {} } = {}) => {
    if (!window.electronAPI?.syncFetchRemote || !window.electronAPI?.syncSaveRemote) {
        throw new Error('当前环境不支持桌面云同步 API')
    }

    if (_activeSyncPromise) {
        return await _activeSyncPromise
    }

    _activeSyncPromise = (async () => {
        onProgress('正在提取本地阅读数据...', 'export')
        const localPayload = await exportSyncPayload()

        onProgress('正在拉取云端数据...', 'fetch')
        const remoteRes = await window.electronAPI.syncFetchRemote(config)
        if (remoteRes.error) {
            throw new Error(`云端读取失败: ${remoteRes.error}`)
        }

        const remoteData = remoteRes.exists ? remoteRes.data : null
        const remoteEtag = remoteRes.etag || null

        onProgress('正在执行多端数据智能合并...', 'merge')
        let { merged, stats } = mergeSyncData(localPayload, remoteData)

        let maxRetries = 2
        let currentRemoteEtag = remoteEtag
        let lastSaveRes = null

        while (maxRetries >= 0) {
            onProgress('正在上传合并数据至云端...', 'upload')
            lastSaveRes = await window.electronAPI.syncSaveRemote(config, merged, currentRemoteEtag)
            if (lastSaveRes.success) break

            if (lastSaveRes.isConflict && maxRetries > 0) {
                maxRetries--
                onProgress('检测到云端并发更新，正在自动合并最新数据...', 'merge')
                await new Promise(r => setTimeout(r, 600 * (2 - maxRetries)))
                const reFetch = await window.electronAPI.syncFetchRemote(config)
                if (reFetch.error) throw new Error(`云端重新拉取失败: ${reFetch.error}`)
                currentRemoteEtag = reFetch.etag || null
                const reMergedResult = mergeSyncData(localPayload, reFetch.exists ? reFetch.data : null)
                merged = reMergedResult.merged
                stats = reMergedResult.stats
                continue
            }

            throw new Error(`云端保存失败: ${lastSaveRes.error || '未知网络错误'}`)
        }

        onProgress('正在更新本地书库与阅读记录...', 'apply')
        const applyRes = await applyMergedPayload(merged)

        onProgress('同步完成！', 'done')
        return { 
            success: true, 
            stats, 
            pendingAutoDownloads: applyRes?.pendingAutoDownloads || [], 
            deletedBookIds: applyRes?.deletedBookIds || [],
            timestamp: Date.now() 
        }
    })().finally(() => {
        _activeSyncPromise = null
    })

    return await _activeSyncPromise
}


if (typeof window !== 'undefined') {
    window.syncEngine = {
        exportSyncPayload,
        mergeSyncData,
        applyMergedPayload,
        executeSyncLifecycle
    }
}
