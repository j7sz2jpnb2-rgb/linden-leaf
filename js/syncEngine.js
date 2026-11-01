// js/syncEngine.js - Multi-device WebDAV & Nutstore Sync and Conflict Resolution Engine
import * as db from './db.js'
import { checkTranslationCompatibility, buildTranslationRevisionArchive } from './translation-job-core.js'

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

    // 4. Favorite: LWW based on favoriteUpdatedAt (with updatedAt fallback)
    let isFavorite = Boolean(localBook.isFavorite)
    let favoriteUpdatedAt = localBook.favoriteUpdatedAt || localBook.updatedAt || 0
    if (incomingMeta.favoriteUpdatedAt || incomingMeta.isFavorite !== undefined) {
        const inFavTime = incomingMeta.favoriteUpdatedAt || incomingMeta.updatedAt || 0
        if (isIncomingNewer(inFavTime, favoriteUpdatedAt)) {
            isFavorite = Boolean(incomingMeta.isFavorite)
            favoriteUpdatedAt = inFavTime
        }
    }

    // 5. Reading Progress & Last Read (strictly compare progress timestamps; do NOT fall back to lastReadAt which changes during listening / browsing)
    const localProgressTime = localBook.progress?.updatedAt || localBook.progress?.timestamp || 0
    const inProgressTime = incomingMeta.progress?.updatedAt || incomingMeta.progress?.timestamp || 0
    let isIncomingReadNewer = false
    if (inProgressTime !== localProgressTime) {
        isIncomingReadNewer = inProgressTime > localProgressTime
    } else {
        const inFrac = incomingMeta.progress?.fraction || 0
        const locFrac = localBook.progress?.fraction || 0
        if (inFrac !== locFrac) {
            isIncomingReadNewer = inFrac > locFrac
        } else {
            isIncomingReadNewer = String(incomingClientId || '') > String(localClientId || '')
        }
    }

    const progress = isIncomingReadNewer ? (incomingMeta.progress || localBook.progress) : (localBook.progress || incomingMeta.progress)
    const lastReadAt = Math.max(localBook.lastReadAt || 0, incomingMeta.lastReadAt || 0, localProgressTime, inProgressTime)
    const totalReadingSeconds = Math.max(localBook.totalReadingSeconds || 0, incomingMeta.totalReadingSeconds || 0)
    const totalListeningSeconds = Math.max(localBook.totalListeningSeconds || 0, incomingMeta.totalListeningSeconds || 0)

    // 6. Cloud Backup: newer uploadedAt wins
    let cloudBackup = localBook.cloudBackup || null
    if (incomingMeta.cloudBackup) {
        const inUp = incomingMeta.cloudBackup.uploadedAt || 0
        const locUp = localBook.cloudBackup?.uploadedAt || 0
        if (inUp >= locUp || !localBook.cloudBackup?.hasBackup) {
            cloudBackup = incomingMeta.cloudBackup
        }
    }

    // 7. Rating: LWW based on ratingUpdatedAt. Explicit null propagates to cancel/clear rating across devices.
    let rating = localBook.rating !== undefined ? localBook.rating : null
    let ratingUpdatedAt = localBook.ratingUpdatedAt || 0
    if (incomingMeta.ratingUpdatedAt !== undefined && isIncomingNewer(incomingMeta.ratingUpdatedAt, localBook.ratingUpdatedAt)) {
        rating = incomingMeta.rating !== undefined ? incomingMeta.rating : null
        ratingUpdatedAt = incomingMeta.ratingUpdatedAt || 0
    }

    // 8. Custom Title & Custom Author: LWW based on updatedAt
    let customTitle = localBook.customTitle !== undefined ? localBook.customTitle : null
    let customAuthor = localBook.customAuthor !== undefined ? localBook.customAuthor : null
    if (incomingMeta.customTitle !== undefined && isIncomingNewer(incomingMeta.updatedAt, localBook.updatedAt)) {
        customTitle = incomingMeta.customTitle
    }
    if (incomingMeta.customAuthor !== undefined && isIncomingNewer(incomingMeta.updatedAt, localBook.updatedAt)) {
        customAuthor = incomingMeta.customAuthor
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
        rating,
        ratingUpdatedAt,
        customTitle,
        customAuthor,
        progress,
        lastReadAt,
        totalReadingSeconds,
        totalListeningSeconds,
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
        customTitle: b.customTitle || null,
        customAuthor: b.customAuthor || null,
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
        rating: b.rating !== undefined ? b.rating : null,
        ratingUpdatedAt: b.ratingUpdatedAt || 0,
        lastReadAt: b.lastReadAt || 0,
        totalReadingSeconds: b.totalReadingSeconds || 0,
        totalListeningSeconds: b.totalListeningSeconds || 0,
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

    // Enrich reading sessions with bookTitle and bookAuthor if missing from book records
    const bookMapById = new Map(allBooks.map(b => [b.id, b]))
    const enrichedSessions = allSessions.map(s => {
        if (!s) return s
        const b = s.bookId ? bookMapById.get(s.bookId) : null
        return {
            ...s,
            bookTitle: s.bookTitle || b?.customTitle || b?.title || '',
            bookAuthor: s.bookAuthor || b?.customAuthor || b?.author || ''
        }
    })

    const booksMeta = allBooks.map(buildBookSyncMeta)

    // Reading presets
    let readingPresets = []
    try {
        const rawPresets = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_reading_presets_v1') : null
        if (rawPresets) readingPresets = JSON.parse(rawPresets) || []
    } catch (_) {}

    // Custom semantic palette
    let customPalette = null
    try {
        const rawPalette = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_custom_semantic_palette_v1') : null
        if (rawPalette) customPalette = JSON.parse(rawPalette)
    } catch (_) {}

    // User name
    let userName = ''
    try {
        userName = (typeof localStorage !== 'undefined' ? (localStorage.getItem('linden_user_name') || '') : '').trim()
    } catch (_) {}

    // Single book setting overrides
    const bookSettingsOverrides = {}
    try {
        if (typeof localStorage !== 'undefined') {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i)
                if (k && k.startsWith('linden_book_settings_')) {
                    const bId = k.replace('linden_book_settings_', '')
                    try {
                        bookSettingsOverrides[bId] = JSON.parse(localStorage.getItem(k))
                    } catch (_) {}
                }
            }
        }
    } catch (_) {}

    // Safe advanced settings (without sensitive keys)
    let advancedSettings = {}
    try {
        const rawAdv = typeof localStorage !== 'undefined'
            ? (localStorage.getItem('linden_advanced_settings_config') || localStorage.getItem('linden_advanced_settings'))
            : null
        if (rawAdv) {
            const parsed = JSON.parse(rawAdv)
            if (parsed && typeof parsed === 'object') {
                const safe = { ...parsed }
                const sensitiveKeys = ['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory']
                for (const sk of sensitiveKeys) delete safe[sk]
                advancedSettings = safe
            }
        }
    } catch (_) {}

    let chapterTranslations = []
    const syncChapterTrans = (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_chapter_translations') : 'false') === 'true'
    if (syncChapterTrans && typeof db.getAllChapterTranslations === 'function') {
        chapterTranslations = await db.getAllChapterTranslations()
    }

    return {
        version: 2,
        clientId: (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_client_id') : '') || `client_${Math.random().toString(36).slice(2, 10)}`,
        deviceName: (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('Windows')) ? 'Windows PC' : 'Linden 客户端',
        updatedAt: Date.now(),
        settings,
        readingPresets,
        customPalette,
        userName,
        bookSettingsOverrides,
        advancedSettings,
        customLists: allLists,
        booksMeta,
        highlights: allHighlights,
        bookmarks: allBookmarks,
        readingSessions: enrichedSessions,
        pdfDrawings: allPdfDrawings,
        chapterTranslations,
        deletedRecords: deletedRecords || []
    }
}

export const mergeDrawingStrokes = (strokesA = [], strokesB = []) => {
    const strokeMap = new Map()
    const formatPt = (pt) => {
        if (!pt) return ''
        const x = Array.isArray(pt) ? pt[0] : pt.x
        const y = Array.isArray(pt) ? pt[1] : pt.y
        const fx = typeof x === 'number' ? x.toFixed(2) : String(x ?? '')
        const fy = typeof y === 'number' ? y.toFixed(2) : String(y ?? '')
        return `${fx},${fy}`
    }
    const getStrokeKey = (s) => {
        if (!s) return null
        if (s.id) return String(s.id)
        const pts = Array.isArray(s.points) ? s.points : []
        const p0 = formatPt(pts[0])
        const pN = pts.length > 1 ? formatPt(pts[pts.length - 1]) : ''
        return `${s.color || ''}_${s.width || ''}_${s.tool || ''}_${pts.length}_${p0}_${pN}`
    }

    for (const s of strokesA) {
        if (!s) continue
        const key = getStrokeKey(s)
        if (key) strokeMap.set(key, s)
    }

    for (const s of strokesB) {
        if (!s) continue
        const key = getStrokeKey(s)
        if (!key) continue
        if (!strokeMap.has(key)) {
            strokeMap.set(key, s)
        } else {
            const existing = strokeMap.get(key)
            const sTime = s.updatedAt || s.timestamp || 0
            const exTime = existing.updatedAt || existing.timestamp || 0
            if (sTime > exTime) {
                strokeMap.set(key, s)
            }
        }
    }
    return Array.from(strokeMap.values())
}

/**
 * 2. Deterministic LWW Merge Algorithm
 */
export const mergeSyncData = (localPayload = {}, remotePayload = null) => {
    if (!remotePayload || typeof remotePayload !== 'object') {
        return {
            merged: localPayload || {},
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
        if (t === 'chapter_translations' || t === 'chapterTranslation') return 'chapter_translation'
        return t
    }
    const tombstoneMap = new Map()
    const registerTomb = (t, delTime) => {
        if (!t) return
        const tId = t.id || t.recordId
        const tType = t.type || t.recordType
        if (!tId) return
        const normType = normalizeTombType(tType)
        const key = `${normType}:${tId}`
        if (!tombstoneMap.has(key) || delTime >= (tombstoneMap.get(key).deletedAt || 0)) {
            tombstoneMap.set(key, { ...t, id: tId, type: normType, deletedAt: delTime })
        }
        if (!tombstoneMap.has(tId) || delTime >= (tombstoneMap.get(tId).deletedAt || 0)) {
            tombstoneMap.set(tId, { ...t, id: tId, type: normType, deletedAt: delTime })
        }
        if (normType === 'book' && t.stableKey) {
            const keyByStable = `book:${t.stableKey}`
            if (!tombstoneMap.has(keyByStable) || delTime >= (tombstoneMap.get(keyByStable).deletedAt || 0)) {
                tombstoneMap.set(keyByStable, { ...t, id: tId, type: 'book', deletedAt: delTime })
            }
        }
    }

    ;(remotePayload.deletedRecords || []).forEach(t => {
        if (t && (t.id || t.recordId)) {
            const delTime = clampTime(t.deletedAt)
            if (delTime >= minTombstoneTime) {
                registerTomb(t, delTime)
            }
        }
    })
    ;(localPayload.deletedRecords || []).forEach(t => {
        if (!t || !(t.id || t.recordId)) return
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
                rating: b.rating !== undefined ? b.rating : null,
                ratingUpdatedAt: clampTime(b.ratingUpdatedAt),
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
        const rRatingUpdated = clampTime(remoteBook.ratingUpdatedAt)

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
                rating: cleanRemoteBook.rating !== undefined ? cleanRemoteBook.rating : null,
                ratingUpdatedAt: rRatingUpdated,
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

            if (remoteReadTime > localReadTime || cleanRemoteBook.totalReadingSeconds !== localBook.totalReadingSeconds || cleanRemoteBook.totalListeningSeconds !== localBook.totalListeningSeconds) {
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
                totalListeningSeconds: reconciled.totalListeningSeconds,
                customListIds: reconciled.customListIds,
                tags: reconciled.tags,
                tagsUpdatedAt: reconciled.tagsUpdatedAt,
                readingStatus: reconciled.readingStatus,
                statusUpdatedAt: reconciled.statusUpdatedAt,
                completedAt: reconciled.completedAt,
                rating: reconciled.rating,
                ratingUpdatedAt: reconciled.ratingUpdatedAt,
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

    // F. Merge Reading Sessions (Union by ID with duration max, BookId Remapping, and Title/Author Preservation)
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
            const bestTitle = s.bookTitle || remoteS.bookTitle || ''
            const bestAuthor = s.bookAuthor || remoteS.bookAuthor || ''
            sessMap.set(s.id, {
                ...remoteS,
                ...s,
                bookTitle: bestTitle,
                bookAuthor: bestAuthor,
                durationSeconds: Math.max(localDur, remoteDur)
            })
        }
    })
    // Backfill missing titles/authors from mergedBooksMeta if available
    const bookTitleMetaMap = new Map()
    mergedBooksMeta.forEach(b => {
        if (b && b.id) {
            bookTitleMetaMap.set(b.id, {
                title: b.customTitle || b.title || '',
                author: b.customAuthor || b.author || ''
            })
        }
    })
    const mergedSessions = Array.from(sessMap.values()).map(s => {
        if (!s) return s
        const meta = s.bookId ? bookTitleMetaMap.get(s.bookId) : null
        return {
            ...s,
            bookTitle: s.bookTitle || meta?.title || '',
            bookAuthor: s.bookAuthor || meta?.author || ''
        }
    })

    // G. Merge Settings (LWW on updatedAt)
    const localSetTime = localPayload.settings?.updatedAt || 0
    const remoteSetTime = remotePayload.settings?.updatedAt || 0
    const mergedSettings = remoteSetTime > localSetTime ? remotePayload.settings : localPayload.settings

    // G2. Merge Reading Presets (Union by ID with LWW, max 10)
    const presetMap = new Map()
    ;(remotePayload.readingPresets || []).forEach(p => {
        if (p && p.id) presetMap.set(p.id, { ...p, updatedAt: clampTime(p.updatedAt) || clampTime(p.createdAt) })
    })
    ;(localPayload.readingPresets || []).forEach(p => {
        if (!p || !p.id) return
        const localUpdated = clampTime(p.updatedAt) || clampTime(p.createdAt) || 0
        if (!presetMap.has(p.id)) {
            presetMap.set(p.id, { ...p, updatedAt: localUpdated })
        } else {
            const remP = presetMap.get(p.id)
            const remUpdated = remP.updatedAt || remP.createdAt || 0
            if (localUpdated >= remUpdated) {
                presetMap.set(p.id, { ...p, updatedAt: localUpdated })
            }
        }
    })
    const mergedReadingPresets = Array.from(presetMap.values()).slice(0, 10)

    // G3. Merge Custom Semantic Palette (LWW)
    let mergedCustomPalette = localPayload.customPalette || null
    if (remotePayload.customPalette) {
        if (!mergedCustomPalette || (remotePayload.customPalette.updatedAt || 0) >= (mergedCustomPalette.updatedAt || 0)) {
            mergedCustomPalette = remotePayload.customPalette
        }
    }

    // G4. Merge User Name (Prefer non-empty / newer)
    const locUserName = (localPayload.userName || '').trim()
    const remUserName = (remotePayload.userName || '').trim()
    const mergedUserName = remUserName && (!locUserName || (remotePayload.updatedAt || 0) > (localPayload.updatedAt || 0)) ? remUserName : (locUserName || remUserName)

    // G5. Merge Book Settings Overrides (Remap bookIds, LWW)
    const mergedBookSettingsOverrides = {}
    if (remotePayload.bookSettingsOverrides && typeof remotePayload.bookSettingsOverrides === 'object') {
        for (const [bId, ov] of Object.entries(remotePayload.bookSettingsOverrides)) {
            const targetId = bookIdRemap.get(bId) || bId
            mergedBookSettingsOverrides[targetId] = { ...ov }
        }
    }
    if (localPayload.bookSettingsOverrides && typeof localPayload.bookSettingsOverrides === 'object') {
        for (const [bId, ov] of Object.entries(localPayload.bookSettingsOverrides)) {
            mergedBookSettingsOverrides[bId] = { ...(mergedBookSettingsOverrides[bId] || {}), ...ov }
        }
    }

    // G6. Merge Safe Advanced Settings (Non-sensitive, LWW)
    const mergedAdvancedSettings = {
        ...(remotePayload.advancedSettings || {}),
        ...(localPayload.advancedSettings || {})
    }

    // H. Merge PDF Drawings (Stroke-level merge by identity, filtered by book tombstones and BookId Remapping)
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
            const mergedStrokes = mergeDrawingStrokes(remoteD.strokes || [], localRecord.strokes || [])
            const isLocalNewer = localUpdated >= (remoteD.updatedAt || 0)
            const baseRecord = isLocalNewer ? localRecord : remoteD
            drawingMap.set(localId, {
                ...baseRecord,
                strokes: mergedStrokes,
                updatedAt: Math.max(localUpdated, remoteD.updatedAt || 0)
            })
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

    // H. Merge Chapter Translations (Stable Identity Normalization, Revision Deduplication, Version-Compatible)
    const ctMap = new Map()
    const getCtStableKey = (ct) => {
        if (!ct) return ''
        const bookKey = ct.bookStableKey || ct.contentHash || ct.bookId || ''
        const chapKey = ct.chapterSourceKey || ct.chapterKey || ''
        return `${bookKey}::${chapKey}` || ct.id || ''
    }

    ;(remotePayload.chapterTranslations || []).forEach(ct => {
        if (!ct) return
        const key = getCtStableKey(ct)
        if (key) ctMap.set(key, structuredClone(ct))
    })
    ;(localPayload.chapterTranslations || []).forEach(ct => {
        if (!ct) return
        const key = getCtStableKey(ct)
        if (!key) return
        if (!ctMap.has(key)) {
            ctMap.set(key, structuredClone(ct))
        } else {
            const remoteCt = ctMap.get(key)
            // Strict version compatibility: sourceHash, parserVersion, targetLanguage, promptVersion
            const isCompatible = typeof db.checkTranslationCompatibility === 'function'
                ? db.checkTranslationCompatibility(ct, remoteCt)
                : checkTranslationCompatibility(ct, remoteCt)

            if (!isCompatible) {
                // Incompatible versions MUST NOT be mixed. Retain both as conflict revisions.
                const primary = (ct.updatedAt || 0) >= (remoteCt.updatedAt || 0) ? structuredClone(ct) : structuredClone(remoteCt)
                const secondary = (ct.updatedAt || 0) >= (remoteCt.updatedAt || 0) ? structuredClone(remoteCt) : structuredClone(ct)
                if (!Array.isArray(primary.conflictRevisions)) primary.conflictRevisions = []
                const existingRevIds = new Set(primary.conflictRevisions.map(r => r.revisionId).filter(Boolean))
                const secRevId = secondary.revisionId || `conflict_${secondary.updatedAt || Date.now()}`
                if (!existingRevIds.has(secRevId)) {
                    primary.conflictRevisions.push({
                        revisionId: secRevId,
                        sourceHash: secondary.sourceHash,
                        parserVersion: secondary.parserVersion,
                        targetLanguage: secondary.targetLanguage,
                        promptVersion: secondary.promptVersion,
                        updatedAt: secondary.updatedAt,
                        status: secondary.status,
                        paragraphs: secondary.paragraphs,
                        reason: 'incompatible_version_conflict'
                    })
                    existingRevIds.add(secRevId)
                }
                if (Array.isArray(secondary.conflictRevisions)) {
                    for (const cr of secondary.conflictRevisions) {
                        if (cr && cr.revisionId && !existingRevIds.has(cr.revisionId)) {
                            primary.conflictRevisions.push(cr)
                            existingRevIds.add(cr.revisionId)
                        }
                    }
                }
                ctMap.set(key, primary)
            } else if (Array.isArray(ct.paragraphs) && Array.isArray(remoteCt.paragraphs)) {
                const paraMap = new Map()
                remoteCt.paragraphs.forEach(p => { if (p && p.id) paraMap.set(p.id, structuredClone(p)) })
                ct.paragraphs.forEach(p => {
                    if (!p || !p.id) return
                    if (!paraMap.has(p.id)) {
                        paraMap.set(p.id, structuredClone(p))
                    } else {
                        const remP = paraMap.get(p.id)
                        const pCompleted = p.status === 'completed' && typeof p.translation === 'string' && p.translation.trim().length > 0
                        const remPCompleted = remP.status === 'completed' && typeof remP.translation === 'string' && remP.translation.trim().length > 0

                        if (pCompleted && !remPCompleted) {
                            paraMap.set(p.id, structuredClone(p))
                        } else if (!pCompleted && remPCompleted) {
                            // keep remote completed paragraph
                        } else if ((ct.updatedAt || 0) >= (remoteCt.updatedAt || 0)) {
                            paraMap.set(p.id, structuredClone(p))
                        }
                    }
                })
                const mergedParas = Array.from(paraMap.values())
                const maxUpdated = Math.max(ct.updatedAt || 0, remoteCt.updatedAt || 0)
                const expectedTotal = Math.max(Number(ct.totalParagraphs) || 0, Number(remoteCt.totalParagraphs) || 0)

                // Strict completion condition: ALL expected paragraphs must be verified completed with non-empty translation
                const hasIncomplete = mergedParas.some(p => p.status !== 'completed' || !p.translation || !String(p.translation).trim())
                const meetsTotalCount = expectedTotal > 0
                    ? mergedParas.length >= expectedTotal
                    : (ct.status === 'completed' || remoteCt.status === 'completed')
                const allCompleted = mergedParas.length > 0 && !hasIncomplete && meetsTotalCount

                ctMap.set(ct.id, {
                    ...remoteCt,
                    ...ct,
                    status: allCompleted ? 'completed' : 'partial',
                    paragraphs: mergedParas,
                    totalParagraphs: expectedTotal > 0 ? expectedTotal : mergedParas.length,
                    updatedAt: maxUpdated
                })
            } else if ((ct.updatedAt || 0) >= (remoteCt.updatedAt || 0)) {
                ctMap.set(ct.id, structuredClone(ct))
            }
        }
    })
    const mergedChapterTranslations = Array.from(ctMap.values()).filter(ct => {
        if (!ct || !ct.bookId) return false
        const bookTombKey = `book:${ct.bookId}`
        if (tombstoneMap.has(bookTombKey)) return false
        const ctTombKey = ct.id ? `chapter_translation:${ct.id}` : null
        if (ctTombKey && tombstoneMap.has(ctTombKey)) {
            const tomb = tombstoneMap.get(ctTombKey)
            if ((tomb.deletedAt || 0) >= (ct.updatedAt || 0)) return false
        }
        if (ct.id && tombstoneMap.has(ct.id)) {
            const tomb = tombstoneMap.get(ct.id)
            if ((tomb.deletedAt || 0) >= (ct.updatedAt || 0)) return false
        }
        return true
    })

    // Retain unknown top-level schema properties from remotePayload to prevent clobbering future schema extensions
    const unknownRemoteFields = {}
    if (remotePayload && typeof remotePayload === 'object') {
        const knownKeys = new Set([
            'version', 'clientId', 'deviceName', 'updatedAt', 'settings',
            'customLists', 'booksMeta', 'highlights', 'bookmarks',
            'readingSessions', 'pdfDrawings', 'chapterTranslations', 'deletedRecords',
            'readingPresets', 'customPalette', 'userName', 'bookSettingsOverrides', 'advancedSettings'
        ])
        for (const [k, v] of Object.entries(remotePayload)) {
            if (!knownKeys.has(k)) {
                unknownRemoteFields[k] = structuredClone(v)
            }
        }
    }

    const merged = {
        ...unknownRemoteFields,
        version: Math.max(localPayload.version || 1, remotePayload.version || 1),
        clientId: localPayload.clientId || (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_client_id') : '') || '',
        updatedAt: Date.now(),
        settings: mergedSettings,
        readingPresets: mergedReadingPresets,
        customPalette: mergedCustomPalette,
        userName: mergedUserName,
        bookSettingsOverrides: mergedBookSettingsOverrides,
        advancedSettings: mergedAdvancedSettings,
        customLists: mergedCustomLists.map(l => ({
            ...l,
            bookIds: Array.isArray(l.bookIds) ? l.bookIds.map(id => bookIdRemap.get(id) || id) : []
        })),
        booksMeta: mergedBooksMeta,
        highlights: mergedHighlights,
        bookmarks: mergedBookmarks,
        readingSessions: mergedSessions,
        pdfDrawings: mergedPdfDrawings,
        chapterTranslations: mergedChapterTranslations,
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
                } else if (tomb.type === 'chapter_translation' || tomb.type === 'chapter_translations' || tomb.type === 'chapterTranslation') {
                    const parts = tomb.id.split('::')
                    if (parts.length === 2) {
                        const localCt = await db.getChapterTranslation(parts[0], parts[1])
                        if (localCt && delTime >= (localCt.updatedAt || 0)) {
                            await db.deleteChapterTranslation(parts[0], parts[1])
                        }
                    }
                }
            }
        }
    }

    // B. Apply custom lists
    if (Array.isArray(mergedPayload.customLists)) {
        for (const list of mergedPayload.customLists) {
            if (typeof db.applySyncedCustomList === 'function') {
                await db.applySyncedCustomList(list)
            } else {
                await db.saveCustomList(list)
            }
        }
    }

    // C. Apply books progress, reading times, favorite & lists (with BookId Remapping for multi-device sync)
    const bookIdRemap = new Map()
    const pendingAutoDownloads = []
    if (Array.isArray(mergedPayload.booksMeta)) {
        const localClientId = (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_client_id') : '') || ''
        const incomingClientId = mergedPayload.clientId || ''
        for (const meta of mergedPayload.booksMeta) {
            if (!meta || !meta.id) continue
            // Re-check tombstones with fresh DB query to avoid race with concurrent local delete
            const allDeleted = typeof db.getAllDeletedRecords === 'function' ? await db.getAllDeletedRecords() : []
            const tombstone = allDeleted.find(t => (t.id === meta.id || (meta.stableKey && t.stableKey === meta.stableKey)))
            if (tombstone && (tombstone.deletedAt || 0) >= (meta.updatedAt || meta.addedAt || 0)) {
                continue
            }

            // Fresh read directly from DB rather than stale snapshot to avoid clobbering concurrent user edits
            let localBook = await db.getBook(meta.id)
            if (!localBook && meta.stableKey) {
                const currentBooks = typeof db.getAllBooks === 'function' ? await db.getAllBooks() : allLocalBooks
                localBook = currentBooks.find(b => (b.stableKey && b.stableKey === meta.stableKey) || 
                    (meta.title && meta.size > 0 && b.title === meta.title && b.size === meta.size))
            }
            if (localBook && localBook.id !== meta.id) {
                bookIdRemap.set(meta.id, localBook.id)
            }
            if (localBook) {
                let changed = false
                const reconciled = reconcileBookSyncMeta(localBook, meta, localClientId, incomingClientId)

                if (JSON.stringify(localBook.tags || []) !== JSON.stringify(reconciled.tags || []) || (reconciled.tagsUpdatedAt || 0) > (localBook.tagsUpdatedAt || 0)) {
                    localBook.tags = reconciled.tags
                    localBook.tagsUpdatedAt = reconciled.tagsUpdatedAt
                    changed = true
                }
                if (localBook.readingStatus !== reconciled.readingStatus || localBook.completedAt !== reconciled.completedAt || (reconciled.statusUpdatedAt || 0) > (localBook.statusUpdatedAt || 0)) {
                    localBook.readingStatus = reconciled.readingStatus
                    localBook.statusUpdatedAt = reconciled.statusUpdatedAt
                    localBook.completedAt = reconciled.completedAt
                    changed = true
                }
                if (JSON.stringify(localBook.customListIds || []) !== JSON.stringify(reconciled.customListIds || []) || (reconciled.listsUpdatedAt || 0) > (localBook.listsUpdatedAt || 0)) {
                    localBook.customListIds = reconciled.customListIds
                    localBook.listsUpdatedAt = reconciled.listsUpdatedAt
                    changed = true
                }
                if (localBook.isFavorite !== reconciled.isFavorite || (reconciled.favoriteUpdatedAt || 0) > (localBook.favoriteUpdatedAt || 0)) {
                    localBook.isFavorite = reconciled.isFavorite
                    localBook.favoriteUpdatedAt = reconciled.favoriteUpdatedAt
                    changed = true
                }
                if (localBook.rating !== reconciled.rating || (reconciled.ratingUpdatedAt || 0) > (localBook.ratingUpdatedAt || 0)) {
                    localBook.rating = reconciled.rating
                    localBook.ratingUpdatedAt = reconciled.ratingUpdatedAt
                    changed = true
                }
                const progressChanged = JSON.stringify(localBook.progress || null) !== JSON.stringify(reconciled.progress || null)
                const lastReadChanged = (reconciled.lastReadAt || 0) !== (localBook.lastReadAt || 0)
                if (progressChanged || lastReadChanged || (reconciled.progress && !localBook.progress)) {
                    localBook.progress = reconciled.progress
                    localBook.lastReadAt = reconciled.lastReadAt
                    changed = true
                }
                if (reconciled.totalReadingSeconds > (localBook.totalReadingSeconds || 0)) {
                    localBook.totalReadingSeconds = reconciled.totalReadingSeconds
                    changed = true
                }
                if (reconciled.totalListeningSeconds > (localBook.totalListeningSeconds || 0)) {
                    localBook.totalListeningSeconds = reconciled.totalListeningSeconds
                    changed = true
                }
                if (reconciled.cloudBackup && (!localBook.cloudBackup || (reconciled.cloudBackup.uploadedAt || 0) >= (localBook.cloudBackup?.uploadedAt || 0))) {
                    localBook.cloudBackup = reconciled.cloudBackup
                    changed = true
                }
                if (reconciled.customTitle !== undefined && reconciled.customTitle !== localBook.customTitle) {
                    localBook.customTitle = reconciled.customTitle
                    changed = true
                }
                if (reconciled.customAuthor !== undefined && reconciled.customAuthor !== localBook.customAuthor) {
                    localBook.customAuthor = reconciled.customAuthor
                    changed = true
                }
                if (changed) {
                    // Check if book was deleted right before saving
                    const liveCheck = await db.getBook(localBook.id)
                    if (liveCheck) {
                        // Preserve any higher timestamps that occurred locally between read and write
                        if ((liveCheck.tagsUpdatedAt || 0) > (localBook.tagsUpdatedAt || 0)) {
                            localBook.tags = liveCheck.tags
                            localBook.tagsUpdatedAt = liveCheck.tagsUpdatedAt
                        }
                        localBook.updatedAt = meta.updatedAt || localBook.updatedAt || Date.now()
                        localBook._preserveUpdatedAt = true
                        await db.saveBook(localBook)
                    }
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
                    rating: meta.rating !== undefined ? meta.rating : null,
                    ratingUpdatedAt: meta.ratingUpdatedAt || 0,
                    customTitle: meta.customTitle || null,
                    customAuthor: meta.customAuthor || null,
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


    // D. Apply Highlights (with BookId Remapping and Local Tombstone / Edit Protection)
    if (Array.isArray(mergedPayload.highlights)) {
        for (const hl of mergedPayload.highlights) {
            if (!hl) continue
            if (hl.bookId && bookIdRemap.has(hl.bookId)) {
                hl.bookId = bookIdRemap.get(hl.bookId)
            }
            if (hl.bookId && deletedBookIds.includes(hl.bookId)) {
                continue
            }
            if (typeof db.applySyncedHighlight === 'function') {
                await db.applySyncedHighlight(hl)
            } else {
                await db.saveHighlight(hl)
            }
        }
    }

    // E. Apply Bookmarks (with BookId Remapping and Local Tombstone Protection)
    if (Array.isArray(mergedPayload.bookmarks)) {
        for (const bm of mergedPayload.bookmarks) {
            if (!bm) continue
            if (bm.bookId && bookIdRemap.has(bm.bookId)) {
                bm.bookId = bookIdRemap.get(bm.bookId)
            }
            if (bm.bookId && deletedBookIds.includes(bm.bookId)) {
                continue
            }
            if (typeof db.applySyncedBookmark === 'function') {
                await db.applySyncedBookmark(bm)
            } else {
                await db.saveBookmark(bm)
            }
        }
    }

    // F. Apply Reading Sessions (with BookId Remapping, pass false to prevent duplicate duration addition to books)
    if (Array.isArray(mergedPayload.readingSessions)) {
        for (const sess of mergedPayload.readingSessions) {
            if (!sess) continue
            if (sess.bookId && bookIdRemap.has(sess.bookId)) {
                sess.bookId = bookIdRemap.get(sess.bookId)
            }
            // Reading sessions are permanently retained even if books were deleted
            await db.saveReadingSession(sess, false)
        }
    }

    // G. Apply Settings
    if (mergedPayload.settings && typeof mergedPayload.settings === 'object' && Object.keys(mergedPayload.settings).length > 0) {
        const localSettings = (await db.getSetting('readerSettings')) || {}
        const mergedSettings = { ...localSettings, ...mergedPayload.settings }
        await db.setSetting('readerSettings', mergedSettings)
    }

    // G2. Apply Reading Presets
    if (Array.isArray(mergedPayload.readingPresets) && typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem('linden_reading_presets_v1', JSON.stringify(mergedPayload.readingPresets))
            if (typeof window !== 'undefined' && window.readingPresetsManager?.load) {
                window.readingPresetsManager.load()
            }
        } catch (_) {}
    }

    // G3. Apply Custom Semantic Palette
    if (mergedPayload.customPalette && typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem('linden_custom_semantic_palette_v1', JSON.stringify(mergedPayload.customPalette))
            if (typeof window !== 'undefined' && window.themeCustomizer?.load) {
                window.themeCustomizer.load()
            }
        } catch (_) {}
    }

    // G4. Apply User Name
    if (mergedPayload.userName && typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem('linden_user_name', mergedPayload.userName)
        } catch (_) {}
    }

    // G5. Apply Book Settings Overrides
    if (mergedPayload.bookSettingsOverrides && typeof localStorage !== 'undefined') {
        try {
            for (const [bId, ov] of Object.entries(mergedPayload.bookSettingsOverrides)) {
                if (bId && ov && typeof ov === 'object') {
                    localStorage.setItem(`linden_book_settings_${bId}`, JSON.stringify(ov))
                }
            }
        } catch (_) {}
    }

    // G6. Apply Safe Advanced Settings
    if (mergedPayload.advancedSettings && typeof localStorage !== 'undefined') {
        try {
            const rawCur = localStorage.getItem('linden_advanced_settings_config') || localStorage.getItem('linden_advanced_settings')
            const curAdv = rawCur ? JSON.parse(rawCur) : {}
            const mergedAdv = { ...curAdv, ...mergedPayload.advancedSettings }
            localStorage.setItem('linden_advanced_settings_config', JSON.stringify(mergedAdv))
            if (typeof window !== 'undefined') {
                window.app?.advancedSettings?.load?.()
                window.app?.advancedSettings?.applyAllSettings?.()
            }
        } catch (_) {}
    }

    // H. Apply PDF Drawings (with BookId Remapping and Local Tombstone / Edit Protection)
    if (Array.isArray(mergedPayload.pdfDrawings) && mergedPayload.pdfDrawings.length > 0) {
        const dbInstance = await db.openDB()
        if (dbInstance.objectStoreNames.contains('pdf_drawings')) {
            const hasDeleted = dbInstance.objectStoreNames.contains('deleted_records')
            const storeNames = hasDeleted ? ['pdf_drawings', 'deleted_records'] : ['pdf_drawings']
            const tx = dbInstance.transaction(storeNames, 'readwrite')
            const store = tx.objectStore('pdf_drawings')
            const delStore = hasDeleted ? tx.objectStore('deleted_records') : null

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
                const incomingTime = d.updatedAt || 0
                if (delStore) {
                    const tombReq = delStore.get(d.id)
                    tombReq.onsuccess = () => {
                        const tomb = tombReq.result
                        if (tomb && (tomb.deletedAt || 0) >= incomingTime) {
                            return
                        }
                        const exReq = store.get(d.id)
                        exReq.onsuccess = () => {
                            const ex = exReq.result
                            if (ex && (ex.updatedAt || 0) > incomingTime) {
                                return
                            }
                            store.put(d)
                        }
                    }
                } else {
                    const exReq = store.get(d.id)
                    exReq.onsuccess = () => {
                        const ex = exReq.result
                        if (ex && (ex.updatedAt || 0) > incomingTime) {
                            return
                        }
                        store.put(d)
                    }
                }
            })
            await new Promise((res, rej) => {
                tx.oncomplete = () => res()
                tx.onerror = () => rej(tx.error || new Error('Failed to save pdf drawings transaction'))
                tx.onabort = () => rej(tx.error || new Error('PDF drawings transaction aborted'))
            })
        }
    }

    // I. Apply Chapter Translations (with BookId Remapping)
    const syncChapterTrans = (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_chapter_translations') : 'false') === 'true'
    if (syncChapterTrans && Array.isArray(mergedPayload.chapterTranslations) && mergedPayload.chapterTranslations.length > 0 && typeof db.saveChapterTranslation === 'function') {
        for (const ct of mergedPayload.chapterTranslations) {
            if (!ct || !ct.bookId || !ct.chapterKey) continue
            let targetBookId = ct.bookId
            if (bookIdRemap.has(targetBookId)) {
                targetBookId = bookIdRemap.get(targetBookId)
            }
            if (deletedBookIds.includes(targetBookId)) continue
            const record = { ...ct, bookId: targetBookId, id: `${targetBookId}::${ct.chapterKey}` }
            const localCt = await db.getChapterTranslation(targetBookId, ct.chapterKey)
            if (!localCt || (record.updatedAt || 0) >= (localCt.updatedAt || 0)) {
                await db.saveChapterTranslation(record)
            }
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
            const summaryMd = generateReadingSummaryMarkdown(merged)
            lastSaveRes = await window.electronAPI.syncSaveRemote(config, merged, currentRemoteEtag, summaryMd)
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



/**
 * 5. Auto-Generate Comprehensive Human-Readable Markdown Reading & Sync Report
 * Covers: Client status, reading stats, daily book-by-book register, shelf items, and notes
 */
export const generateReadingSummaryMarkdown = (payload) => {
    if (!payload || typeof payload !== 'object') return ''
    const syncTime = new Date(payload.updatedAt || Date.now()).toLocaleString('zh-CN')
    const device = payload.deviceName || 'Linden Leaf 客户端'
    const books = Array.isArray(payload.booksMeta) ? payload.booksMeta : []
    const sessions = Array.isArray(payload.readingSessions) ? payload.readingSessions : []
    const highlights = Array.isArray(payload.highlights) ? payload.highlights : []
    const customLists = Array.isArray(payload.customLists) ? payload.customLists : []

    // Sum durations combining booksMeta and readingSessions
    // to ensure cross-device synced books or deleted books are not omitted
    const bookSessionReadingMap = new Map()
    const bookSessionListenMap = new Map()
    const allBookIdsInSessions = new Set()

    sessions.forEach(s => {
        if (!s) return
        const dur = Number(s.durationSeconds || s.activeDurationSeconds || s.readingSeconds || s.seconds || 0) || 0
        if (dur <= 0) return
        const bId = s.bookId || 'unknown'
        allBookIdsInSessions.add(bId)
        if (s.isListening || s.kind === 'listen') {
            bookSessionListenMap.set(bId, (bookSessionListenMap.get(bId) || 0) + dur)
        } else {
            bookSessionReadingMap.set(bId, (bookSessionReadingMap.get(bId) || 0) + dur)
        }
    })

    const accountedBookIds = new Set()
    let totalSecs = 0
    let totalListenSecs = 0

    books.forEach(b => {
        if (!b) return
        const bId = b.id || b.stableKey
        if (bId) accountedBookIds.add(bId)
        const sessRead = bId ? (bookSessionReadingMap.get(bId) || 0) : 0
        const sessListen = bId ? (bookSessionListenMap.get(bId) || 0) : 0
        totalSecs += Math.max(b.totalReadingSeconds || 0, sessRead)
        totalListenSecs += Math.max(b.totalListeningSeconds || 0, sessListen)
    })

    for (const bId of allBookIdsInSessions) {
        if (!accountedBookIds.has(bId)) {
            totalSecs += (bookSessionReadingMap.get(bId) || 0)
            totalListenSecs += (bookSessionListenMap.get(bId) || 0)
        }
    }

    const totalHours = (totalSecs / 3600).toFixed(1)
    const totalListenHours = (totalListenSecs / 3600).toFixed(1)
    const finishedBooks = books.filter(b => b.readingStatus === 'finished')
    const readingBooks = books.filter(b => b.readingStatus === 'reading')

    let md = `# Linden Leaf (菩提叶阅读) - 云端同步与阅读数据总览\n\n`
    md += `> 本文档由 Linden Leaf WebDAV 云同步引擎自动生成。\n`
    md += `> 同步时间：**${syncTime}** | 同步设备：**${device}** | 数据协议版本：**v${payload.version || 2}**\n\n`

    md += `## 📊 阅读总体概览\n\n`
    md += `- **书架藏书**：共 ${books.length} 本（读完 ${finishedBooks.length} 本，在读 ${readingBooks.length} 本）\n`
    md += `- **总阅读时长**：${totalHours} 小时 (${Math.round(totalSecs / 60)} 分钟)\n`
    if (totalListenSecs > 0) {
        md += `- **总听书时长**：${totalListenHours} 小时 (${Math.round(totalListenSecs / 60)} 分钟)\n`
    }
    md += `- **读书笔记与划线**：共 ${highlights.length} 条\n`
    md += `- **阅读会话记录**：共 ${sessions.length} 次登记\n\n`

    // Daily Reading Book-by-Book Register
    md += `## 📅 每日读书详细登记表\n\n`
    md += `按日期聚合归档每日所读的具体书名、作者与时长明细：\n\n`
    md += `| 日期 | 具体阅读书目 | 作者 | 阅读/听书时长 | 记录条数 |\n`
    md += `| :--- | :--- | :--- | :--- | :--- |\n`

    const dateMap = new Map()
    sessions.forEach(s => {
        if (!s) return
        const d = s.date || (s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : '未知日期')
        if (!dateMap.has(d)) dateMap.set(d, [])
        dateMap.get(d).push(s)
    })

    const sortedDates = Array.from(dateMap.keys()).sort((a, b) => b.localeCompare(a))
    if (sortedDates.length === 0) {
        md += `| - | 暂无每日阅读记录 | - | - | 0 |\n`
    } else {
        sortedDates.slice(0, 60).forEach(d => {
            const daySess = dateMap.get(d)
            const bookDurMap = new Map()
            const bookAuthorMap = new Map()
            let dayTotalSecs = 0
            daySess.forEach(s => {
                const title = s.bookTitle || '未知书名'
                const author = s.bookAuthor || ''
                const dur = s.durationSeconds || 0
                dayTotalSecs += dur
                bookDurMap.set(title, (bookDurMap.get(title) || 0) + dur)
                if (author) bookAuthorMap.set(title, author)
            })
            const bookTitles = Array.from(bookDurMap.entries()).map(([t, sec]) => {
                const mins = Math.round(sec / 60)
                const durStr = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
                return `《${t}》(${durStr})`
            }).join('、')
            const authors = Array.from(new Set(Array.from(bookAuthorMap.values()).filter(Boolean))).join('、') || '-'
            const totalMins = Math.round(dayTotalSecs / 60)
            const dayDurStr = totalMins >= 60 ? `${Math.floor(totalMins / 60)}小时${totalMins % 60}分` : `${totalMins}分钟`
            md += `| ${d} | ${bookTitles} | ${authors} | ${dayDurStr} | ${daySess.length} 条 |\n`
        })
        if (sortedDates.length > 60) {
            md += `| ... | *(其余 ${sortedDates.length - 60} 天的历史记录已在此处截断，完整数据保存在 linden_sync_data.json)* | ... | ... | ... |\n`
        }
    }
    md += `\n`

    // Bookshelf
    md += `## 📚 书架图书明细与状态\n\n`
    md += `| 书名 | 作者 | 格式 | 状态 | 评分 | 标签 | 阅读时长 | 进度 |\n`
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`
    const statusLabels = { unread: '未读', want_to_read: '想读', reading: '在读', on_hold: '搁置', finished: '读完' }
    books.forEach(b => {
        const title = b.customTitle || b.title || '未知书名'
        const author = b.customAuthor || b.author || '-'
        const fmt = (b.format || 'doc').toUpperCase()
        const st = statusLabels[b.readingStatus] || '未读'
        const rating = b.rating != null ? `${b.rating} ★` : '-'
        const tags = Array.isArray(b.tags) && b.tags.length ? b.tags.join(', ') : '-'
        const dur = Math.round((b.totalReadingSeconds || 0) / 60)
        const durStr = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60}m` : `${dur}m`
        const frac = Math.round(((b.progress?.fraction || 0) * 100))
        md += `| 《${title}》 | ${author} | ${fmt} | ${st} | ${rating} | ${tags} | ${durStr} | ${frac}% |\n`
    })
    md += `\n`

    // Custom Lists
    if (customLists.length > 0) {
        md += `## 📑 自定义书单\n\n`
        customLists.forEach(l => {
            const bCount = Array.isArray(l.bookIds) ? l.bookIds.length : 0
            md += `- **${l.name || '未命名书单'}** (${bCount} 本书)\n`
        })
        md += `\n`
    }

    // Highlights excerpt
    if (highlights.length > 0) {
        md += `## ✍️ 近期精选划线与想法笔记 (最新 20 条)\n\n`
        const sortedHl = [...highlights].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20)
        sortedHl.forEach(h => {
            const bTitle = h.bookTitle ? `《${h.bookTitle}》` : ''
            const chap = h.chapterTitle ? ` · ${h.chapterTitle}` : ''
            const date = h.createdAt ? new Date(h.createdAt).toLocaleDateString('zh-CN') : ''
            md += `> ${h.text || ''}\n\n`
            if (h.note) {
                md += `**想法笔记**：${h.note}\n\n`
            }
            md += `*—— 出处：${bTitle}${chap} (${date})*\n\n---\n\n`
        })
    }

    return md
}

if (typeof window !== 'undefined') {
    window.syncEngine = {
        exportSyncPayload,
        mergeSyncData,
        applyMergedPayload,
        executeSyncLifecycle,
        generateReadingSummaryMarkdown
    }
}
