import { contentIdentityRelation, identityHashes, identityAliases } from './document-identity.js'
// Pure sync reconciliation. Transport and persistence live in syncEngine.js.
import { checkTranslationCompatibility, buildTranslationRevisionArchive } from './translation-job-core.js'
import { mergeSessionIntervals, calculateIntervalUnionSeconds, remapPdfDrawingId, getSessionDur } from './reading-data.js'
import { sanitizeSyncFormat, sanitizeCloudFileName } from './book-metadata.js'

export const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60 days TTL to prevent infinite JSON bloat

const canonicalSerialize = (value) => {
    if (value === null || value === undefined) return 'null'
    if (typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(canonicalSerialize).join(',') + ']'
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalSerialize(value[k])).join(',') + '}'
}

// Strict total order on equal timestamps: writerId/clientId -> canonical content digest.
// Guarantees commutativity: pickWinner(A, B) === pickWinner(B, A) regardless of merge direction.
const compareCanonicalTieBreak = (a, b, aClient = '', bClient = '') => {
    const aWriter = String(a?.writerId || a?.clientId || aClient || '')
    const bWriter = String(b?.writerId || b?.clientId || bClient || '')
    if (aWriter !== bWriter) return aWriter > bWriter ? 1 : -1
    const aCanon = canonicalSerialize(a)
    const bCanon = canonicalSerialize(b)
    if (aCanon !== bCanon) return aCanon > bCanon ? 1 : -1
    return 0
}

export const reconcileBookSyncMeta = (localBook = {}, incomingMeta = {}, localClientId = '', incomingClientId = '', options = {}) => {
    const nowMs = Number.isFinite(options?.nowMs) ? options.nowMs : Date.now()
    const isIncomingNewer = (inTime, locTime, inVal, locVal) => {
        const iT = inTime || 0
        const lT = locTime || 0
        if (iT !== lT) return iT > lT
        const inId = String(incomingClientId || '')
        const locId = String(localClientId || '')
        if (inId !== locId) return inId > locId
        return canonicalSerialize(inVal) > canonicalSerialize(locVal)
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

    if (incomingMeta.readingStatus && isIncomingNewer(incomingMeta.statusUpdatedAt, localBook.statusUpdatedAt, incomingMeta.readingStatus, localBook.readingStatus)) {
        readingStatus = incomingMeta.readingStatus
        statusUpdatedAt = incomingMeta.statusUpdatedAt || 0
        // Explicitly preserve null when un-marking finished!
        if (incomingMeta.completedAt !== undefined) {
            completedAt = incomingMeta.completedAt
        } else {
            completedAt = (incomingMeta.readingStatus === 'finished') ? (incomingMeta.statusUpdatedAt || nowMs) : null
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
            isIncomingReadNewer = compareCanonicalTieBreak(incomingMeta.progress, localBook.progress, incomingClientId, localClientId) > 0
        }
    }

    const progress = isIncomingReadNewer ? (incomingMeta.progress || localBook.progress) : (localBook.progress || incomingMeta.progress)
    const lastReadAt = Math.max(localBook.lastReadAt || 0, incomingMeta.lastReadAt || 0, localProgressTime, inProgressTime)
    const totalReadingSeconds = Math.max(localBook.totalReadingSeconds || 0, incomingMeta.totalReadingSeconds || 0)
    const totalListeningSeconds = Math.max(localBook.totalListeningSeconds || 0, incomingMeta.totalListeningSeconds || 0)

    // 6. Cloud Backup: newer uploadedAt wins (deterministic tie-break on equal timestamp)
    let cloudBackup = localBook.cloudBackup || null
    if (incomingMeta.cloudBackup) {
        const inUp = incomingMeta.cloudBackup.uploadedAt || 0
        const locUp = localBook.cloudBackup?.uploadedAt || 0
        if (!localBook.cloudBackup?.hasBackup || inUp > locUp || (inUp === locUp && compareCanonicalTieBreak(incomingMeta.cloudBackup, localBook.cloudBackup, incomingClientId, localClientId) > 0)) {
            cloudBackup = incomingMeta.cloudBackup
        }
    }

    // 7. Rating: LWW based on ratingUpdatedAt. Explicit null propagates to cancel/clear rating across devices.
    let rating = localBook.rating !== undefined ? localBook.rating : null
    let ratingUpdatedAt = localBook.ratingUpdatedAt || 0
    if (incomingMeta.ratingUpdatedAt !== undefined && isIncomingNewer(incomingMeta.ratingUpdatedAt, localBook.ratingUpdatedAt, incomingMeta.rating, localBook.rating)) {
        rating = incomingMeta.rating !== undefined ? incomingMeta.rating : null
        ratingUpdatedAt = incomingMeta.ratingUpdatedAt || 0
    }

    // 8. Custom Title & Custom Author: LWW based on updatedAt
    let customTitle = localBook.customTitle !== undefined ? localBook.customTitle : null
    let customAuthor = localBook.customAuthor !== undefined ? localBook.customAuthor : null
    if (incomingMeta.customTitle !== undefined && isIncomingNewer(incomingMeta.updatedAt, localBook.updatedAt, incomingMeta.customTitle, localBook.customTitle)) {
        customTitle = incomingMeta.customTitle
    }
    if (incomingMeta.customAuthor !== undefined && isIncomingNewer(incomingMeta.updatedAt, localBook.updatedAt, incomingMeta.customAuthor, localBook.customAuthor)) {
        customAuthor = incomingMeta.customAuthor
    }

    // 9. Archive state: LWW based on archivedUpdatedAt (preserves notes & progress while hiding from active shelf)
    let isArchived = Boolean(localBook.isArchived)
    let archivedAt = localBook.archivedAt ?? null
    let archivedUpdatedAt = localBook.archivedUpdatedAt || 0
    if (incomingMeta.archivedUpdatedAt !== undefined || incomingMeta.isArchived !== undefined) {
        const inArchTime = incomingMeta.archivedUpdatedAt || 0
        if (isIncomingNewer(inArchTime, archivedUpdatedAt, Boolean(incomingMeta.isArchived), isArchived)) {
            isArchived = Boolean(incomingMeta.isArchived)
            archivedAt = isArchived ? (incomingMeta.archivedAt ?? inArchTime ?? nowMs) : null
            archivedUpdatedAt = inArchTime
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
        rating,
        ratingUpdatedAt,
        customTitle,
        customAuthor,
        isArchived,
        archivedAt,
        archivedUpdatedAt,
        progress,
        lastReadAt,
        totalReadingSeconds,
        totalListeningSeconds,
        cloudBackup
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
            if (sTime > exTime || (sTime === exTime && compareCanonicalTieBreak(s, existing) > 0)) {
                strokeMap.set(key, s)
            }
        }
    }
    return Array.from(strokeMap.entries())
        .sort(([ka], [kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
        .map(([, val]) => val)
}

export const mergeSyncData = (localPayload = {}, remotePayload = null, options = {}) => {
    const nowMs = Number.isFinite(options?.nowMs) ? options.nowMs : Date.now()
    const effectiveLocalClientId = options?.localClientId
        ?? localPayload?.clientId
        ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_client_id') : '')
        ?? ''

    if (!remotePayload || typeof remotePayload !== 'object') {
        return {
            merged: localPayload || {},
            stats: { booksUpdated: 0, highlightsAdded: 0, sessionsAdded: 0, listsAdded: 0, staleDeviceWarning: false }
        }
    }

    const stats = {
        booksUpdated: 0,
        highlightsAdded: 0,
        sessionsAdded: 0,
        listsAdded: 0,
        staleDeviceWarning: false,
        tombstoneHorizonAt: 0
    }

    const maxAllowedTime = nowMs + 60 * 1000 // Allow max 1 min clock drift
    const clampTime = (t) => (typeof t === 'number' && Number.isFinite(t) ? Math.min(t, maxAllowedTime) : 0)

    // A. Merge Tombstones (Deleted Records with plural/singular normalization and 60-day TTL)
    const minTombstoneTime = nowMs - TOMBSTONE_TTL_MS
    stats.tombstoneHorizonAt = minTombstoneTime

    // Detect if either device has been offline longer than the tombstone retention window
    const localLastSync = Number(localPayload.lastSyncedAt || 0)
    const remoteLastSync = Number(remotePayload.lastSyncedAt || 0)
    if ((localLastSync > 0 && localLastSync < minTombstoneTime) || (remoteLastSync > 0 && remoteLastSync < minTombstoneTime)) {
        stats.staleDeviceWarning = true
    }

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
        if (normType === 'book') {
            if (identityHashes(t).length) {
                for (const hash of identityHashes(t)) {
                const keyByHash = `book:hash:${hash}`
                if (!tombstoneMap.has(keyByHash) || delTime >= (tombstoneMap.get(keyByHash).deletedAt || 0)) {
                    tombstoneMap.set(keyByHash, { ...t, id: tId, type: 'book', deletedAt: delTime })
                }
                }
            } else if (t.stableKey) {
                const legacyKey = `book:legacy:${t.stableKey}`
                if (!tombstoneMap.has(legacyKey) || delTime >= (tombstoneMap.get(legacyKey).deletedAt || 0)) {
                    tombstoneMap.set(legacyKey, { ...t, id: tId, type: 'book', deletedAt: delTime })
                }
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
    const bookIdRemap = new Map()
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

    // P09: Pre-index local books by stableKey to avoid O(N*M) full-scan comparisons
    const localBooksByStableKey = new Map()
    for (const b of bookMap.values()) {
        if (b.isLocal && b.stableKey) {
            let list = localBooksByStableKey.get(b.stableKey)
            if (!list) {
                list = []
                localBooksByStableKey.set(b.stableKey, list)
            }
            list.push(b)
        }
    }

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
        if (localBook) {
            const hashDiff = contentIdentityRelation(localBook, cleanRemoteBook) === 'different'
            const fmtDiff = localBook.format && cleanRemoteBook.format && sanitizeSyncFormat(localBook.format) !== sanitizeSyncFormat(cleanRemoteBook.format)
            const sizeDiff = localBook.size && cleanRemoteBook.size && localBook.size !== cleanRemoteBook.size
            if (hashDiff || fmtDiff || sizeDiff) {
                // Different content identity on same ID; do not merge
                localBook = null
            }
        }
        if (!localBook && cleanRemoteBook.stableKey) {
            const candidates = localBooksByStableKey.get(cleanRemoteBook.stableKey) || []
            localBook = candidates.find(b => {
                if (b.format && cleanRemoteBook.format && b.format !== cleanRemoteBook.format) return false
                if (b.size && cleanRemoteBook.size && b.size !== cleanRemoteBook.size) return false
                if (b.documentHash && cleanRemoteBook.documentHash && contentIdentityRelation(b, cleanRemoteBook) !== 'same') return false
                return true
            })
        }

        if (localBook && localBook.id !== cleanRemoteBook.id) bookIdRemap.set(cleanRemoteBook.id, localBook.id)

        if (!localBook) {
            let targetId = cleanRemoteBook.id
            if (bookMap.has(targetId)) {
                const suffix = (cleanRemoteBook.documentHash || cleanRemoteBook.stableKey || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'rem'
                targetId = `${cleanRemoteBook.id}_remote_${suffix}`
                bookIdRemap.set(cleanRemoteBook.id, targetId)
            }
            bookMap.set(targetId, {
                ...cleanRemoteBook,
                id: targetId,
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
            const reconciled = reconcileBookSyncMeta(localBook, cleanRemoteBook, effectiveLocalClientId, remotePayload.clientId, { nowMs })

            if (remoteReadTime > localReadTime || cleanRemoteBook.totalReadingSeconds !== localBook.totalReadingSeconds || cleanRemoteBook.totalListeningSeconds !== localBook.totalListeningSeconds) {
                stats.booksUpdated++
            }

            bookMap.set(localBook.id, {
                ...localBook,
                format: sanitizeSyncFormat(localBook.format || cleanRemoteBook.format),
                stableKey: localBook.stableKey || cleanRemoteBook.stableKey,
                documentHash: localBook.documentHash || cleanRemoteBook.documentHash || null,
                documentHashAliases: identityAliases(localBook.documentHash || cleanRemoteBook.documentHash, localBook, cleanRemoteBook),
                cloudBackup: reconciled.cloudBackup,
                progress: reconciled.progress,
                lastReadAt: reconciled.lastReadAt,
                totalReadingSeconds: reconciled.totalReadingSeconds,
                totalListeningSeconds: reconciled.totalListeningSeconds,
                customTitle: reconciled.customTitle,
                customAuthor: reconciled.customAuthor,
                customListIds: reconciled.customListIds,
                tags: reconciled.tags,
                tagsUpdatedAt: reconciled.tagsUpdatedAt,
                readingStatus: reconciled.readingStatus,
                statusUpdatedAt: reconciled.statusUpdatedAt,
                completedAt: reconciled.completedAt,
                rating: reconciled.rating,
                ratingUpdatedAt: reconciled.ratingUpdatedAt,
                isArchived: reconciled.isArchived,
                archivedAt: reconciled.archivedAt,
                archivedUpdatedAt: reconciled.archivedUpdatedAt,
                isFavorite: reconciled.isFavorite,
                favoriteUpdatedAt: reconciled.favoriteUpdatedAt,
                listsUpdatedAt: reconciled.listsUpdatedAt,
                updatedAt: Math.max(localBook.updatedAt || 0, rUpdated)
            })
        }
    })
    
    // Filter books by book tombstones (checking exact id, documentHash, and legacy fallback)
    const mergedBooksMeta = Array.from(bookMap.values()).filter(b => {
        const tombById = tombstoneMap.get(`book:${b.id}`)
        const tombs = [tombById, ...identityHashes(b).map(h => tombstoneMap.get(`book:hash:${h}`))].filter(Boolean)
        let tomb = tombs.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))[0]
        if (!tomb && b.stableKey && !b.documentHash) {
            const legacyTomb = tombstoneMap.get(`book:legacy:${b.stableKey}`)
            if (legacyTomb && !legacyTomb.documentHash) {
                const cleanFmt = sanitizeSyncFormat(legacyTomb.format)
                const cleanBFmt = sanitizeSyncFormat(b.format)
                if (cleanFmt === cleanBFmt && (!legacyTomb.size || !b.size || legacyTomb.size === b.size)) {
                    tomb = legacyTomb
                }
            }
        }
        if (tomb) {
            if ((tomb.deletedAt || 0) >= (b.updatedAt || b.addedAt || 0)) return false
        }
        return true
    })
    const validBookIdSet = new Set(mergedBooksMeta.map(b => b.id))

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
        const localRec = { ...h, updatedAt: localUpdated, createdAt: clampTime(h.createdAt) }
        if (!hlMap.has(h.id)) {
            hlMap.set(h.id, localRec)
            stats.highlightsAdded++
        } else {
            const remoteH = hlMap.get(h.id)
            const remoteUpdated = (remoteH.updatedAt || remoteH.createdAt || 0)
            const isLocalNewer = localUpdated > remoteUpdated || (localUpdated === remoteUpdated && compareCanonicalTieBreak(localRec, remoteH, effectiveLocalClientId, remotePayload.clientId) > 0)
            const newer = isLocalNewer ? localRec : remoteH
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
        const localRec = { ...b, createdAt: localCreated }
        if (!bmMap.has(b.id)) {
            bmMap.set(b.id, localRec)
        } else {
            const remoteB = bmMap.get(b.id)
            const remoteCreated = remoteB.createdAt || 0
            const isLocalNewer = localCreated > remoteCreated || (localCreated === remoteCreated && compareCanonicalTieBreak(localRec, remoteB, effectiveLocalClientId, remotePayload.clientId) > 0)
            const newer = isLocalNewer ? localRec : remoteB
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
            const mergedIntervals = mergeSessionIntervals(s.activeIntervals, remoteS.activeIntervals)
            const intervalSecs = calculateIntervalUnionSeconds(mergedIntervals)
            sessMap.set(s.id, {
                ...remoteS,
                ...s,
                bookTitle: bestTitle,
                bookAuthor: bestAuthor,
                durationSeconds: Math.max(localDur, remoteDur),
                activeDurationSeconds: Math.max(getSessionDur(s), getSessionDur(remoteS), intervalSecs),
                activeIntervals: mergedIntervals
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

    // G. Merge Settings (Deterministic LWW on updatedAt)
    const localSetTime = clampTime(localPayload.settings?.updatedAt)
    const remoteSetTime = clampTime(remotePayload.settings?.updatedAt)
    let mergedSettings = localPayload.settings
    if (!localPayload.settings) {
        mergedSettings = remotePayload.settings
    } else if (remotePayload.settings) {
        if (remoteSetTime > localSetTime) {
            mergedSettings = remotePayload.settings
        } else if (remoteSetTime === localSetTime) {
            mergedSettings = compareCanonicalTieBreak(remotePayload.settings, localPayload.settings, remotePayload.clientId, effectiveLocalClientId) > 0
                ? remotePayload.settings
                : localPayload.settings
        }
    }

    // G2. Merge Reading Presets (Deterministic LWW union by ID, stable sort BEFORE 10-item cap)
    const presetMap = new Map()
    ;(remotePayload.readingPresets || []).forEach(p => {
        if (p && p.id) presetMap.set(p.id, { ...p, updatedAt: clampTime(p.updatedAt) || clampTime(p.createdAt) })
    })
    ;(localPayload.readingPresets || []).forEach(p => {
        if (!p || !p.id) return
        const localUpdated = clampTime(p.updatedAt) || clampTime(p.createdAt) || 0
        const localRec = { ...p, updatedAt: localUpdated }
        if (!presetMap.has(p.id)) {
            presetMap.set(p.id, localRec)
        } else {
            const remP = presetMap.get(p.id)
            const remUpdated = remP.updatedAt || remP.createdAt || 0
            if (localUpdated > remUpdated || (localUpdated === remUpdated && compareCanonicalTieBreak(localRec, remP, effectiveLocalClientId, remotePayload.clientId) > 0)) {
                presetMap.set(p.id, localRec)
            }
        }
    })
    const mergedReadingPresets = Array.from(presetMap.values())
        .sort((a, b) => {
            const tDiff = (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
            if (tDiff !== 0) return tDiff
            return String(a.id).localeCompare(String(b.id))
        })
        .slice(0, 10)

    // G3. Merge Custom Semantic Palette (Deterministic LWW)
    let mergedCustomPalette = localPayload.customPalette || null
    if (remotePayload.customPalette) {
        if (!mergedCustomPalette) {
            mergedCustomPalette = remotePayload.customPalette
        } else {
            const remPalTime = clampTime(remotePayload.customPalette.updatedAt)
            const locPalTime = clampTime(mergedCustomPalette.updatedAt)
            if (remPalTime > locPalTime || (remPalTime === locPalTime && compareCanonicalTieBreak(remotePayload.customPalette, mergedCustomPalette, remotePayload.clientId, effectiveLocalClientId) > 0)) {
                mergedCustomPalette = remotePayload.customPalette
            }
        }
    }

    // G4. Merge User Name (Deterministic preference for non-empty / newer)
    const locUserName = (localPayload.userName || '').trim()
    const remUserName = (remotePayload.userName || '').trim()
    const locPayTime = clampTime(localPayload.updatedAt)
    const remPayTime = clampTime(remotePayload.updatedAt)
    let mergedUserName = locUserName || remUserName
    if (locUserName && remUserName) {
        if (remPayTime > locPayTime) {
            mergedUserName = remUserName
        } else if (remPayTime === locPayTime) {
            mergedUserName = compareCanonicalTieBreak(remUserName, locUserName, remotePayload.clientId, effectiveLocalClientId) > 0 ? remUserName : locUserName
        }
    }

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
            const targetId = remapPdfDrawingId(d, targetBookId)
            drawingMap.set(targetId, { ...d, id: targetId, bookId: targetBookId, updatedAt: clampTime(d.updatedAt) })
        }
    })
    ;(localPayload.pdfDrawings || []).forEach(d => {
        if (!d || !d.id) return
        const localUpdated = clampTime(d.updatedAt)
        const localId = remapPdfDrawingId(d, d.bookId)
        const localRecord = { ...d, id: localId, updatedAt: localUpdated }
        if (!drawingMap.has(localId)) {
            drawingMap.set(localId, localRecord)
        } else {
            const remoteD = drawingMap.get(localId)
            const mergedStrokes = mergeDrawingStrokes(remoteD.strokes || [], localRecord.strokes || [])
            const remUp = remoteD.updatedAt || 0
            const isLocalNewer = localUpdated > remUp || (localUpdated === remUp && compareCanonicalTieBreak(localRecord, remoteD, effectiveLocalClientId, remotePayload.clientId) > 0)
            const baseRecord = isLocalNewer ? localRecord : remoteD
            drawingMap.set(localId, {
                ...baseRecord,
                strokes: mergedStrokes,
                updatedAt: Math.max(localUpdated, remUp)
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
        let effectiveBookId = ct.bookId
        if (effectiveBookId && bookIdRemap.has(effectiveBookId)) {
            effectiveBookId = bookIdRemap.get(effectiveBookId)
        }
        const chapKey = ct.chapterSourceKey || ct.chapterKey || ''
        if (effectiveBookId && chapKey) {
            return `${effectiveBookId}::${chapKey}`
        }
        const bookKey = ct.bookStableKey || ct.contentHash || effectiveBookId || ''
        return `${bookKey}::${chapKey}` || ct.id || ''
    }

    ;(remotePayload.chapterTranslations || []).forEach(ct => {
        if (!ct) return
        let targetBookId = ct.bookId
        if (ct.bookId && bookIdRemap.has(ct.bookId)) {
            targetBookId = bookIdRemap.get(ct.bookId)
        }
        const chapKey = ct.chapterSourceKey || ct.chapterKey || ''
        let targetId = ct.id
        if (targetBookId !== ct.bookId) {
            targetId = chapKey ? `${targetBookId}::${chapKey}` : (ct.id ? ct.id.replace(ct.bookId, targetBookId) : ct.id)
        }
        const cleanCt = { ...ct, bookId: targetBookId, id: targetId, chapterKey: chapKey || ct.chapterKey }
        const key = getCtStableKey(cleanCt)
        if (key) ctMap.set(key, structuredClone(cleanCt))
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
            const isCompatible = checkTranslationCompatibility(ct, remoteCt)
            const locCtUp = ct.updatedAt || 0
            const remCtUp = remoteCt.updatedAt || 0
            const isLocalCtNewer =
                locCtUp > remCtUp ||
                (locCtUp === remCtUp &&
                    compareCanonicalTieBreak(ct, remoteCt, localPayload.clientId, remotePayload.clientId) >= 0)

            if (!isCompatible) {
                // Incompatible versions MUST NOT be mixed. Retain both as conflict revisions.
                const primary = structuredClone(isLocalCtNewer ? ct : remoteCt)
                const secondary = structuredClone(isLocalCtNewer ? remoteCt : ct)
                if (!Array.isArray(primary.conflictRevisions)) primary.conflictRevisions = []
                const existingRevIds = new Set(primary.conflictRevisions.map(r => r.revisionId).filter(Boolean))
                const secRevId = secondary.revisionId || `conflict_${secondary.updatedAt || nowMs}`
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
                primary.conflictRevisions.sort((a, b) => String(a?.revisionId || '').localeCompare(String(b?.revisionId || '')))
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
                        } else if (
                            locCtUp > remCtUp ||
                            (locCtUp === remCtUp &&
                                compareCanonicalTieBreak(p, remP, localPayload.clientId, remotePayload.clientId) >= 0)
                        ) {
                            paraMap.set(p.id, structuredClone(p))
                        }
                    }
                })
                const mergedParas = Array.from(paraMap.values())
                    .sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || ''), undefined, { numeric: true }))
                const maxUpdated = Math.max(locCtUp, remCtUp)
                const expectedTotal = Math.max(Number(ct.totalParagraphs) || 0, Number(remoteCt.totalParagraphs) || 0)

                // Strict completion condition: ALL expected paragraphs must be verified completed with non-empty translation
                const hasIncomplete = mergedParas.some(p => p.status !== 'completed' || !p.translation || !String(p.translation).trim())
                const meetsTotalCount = expectedTotal > 0
                    ? mergedParas.length >= expectedTotal
                    : (ct.status === 'completed' || remoteCt.status === 'completed')
                const allCompleted = mergedParas.length > 0 && !hasIncomplete && meetsTotalCount
                const winner = isLocalCtNewer ? ct : remoteCt
                const loser = isLocalCtNewer ? remoteCt : ct

                ctMap.set(key, {
                    ...loser,
                    ...winner,
                    status: allCompleted ? 'completed' : 'partial',
                    paragraphs: mergedParas,
                    totalParagraphs: expectedTotal > 0 ? expectedTotal : mergedParas.length,
                    updatedAt: maxUpdated
                })
            } else if (isLocalCtNewer) {
                ctMap.set(key, structuredClone(ct))
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

    // I. Merge Persistent Bidirectional Portals (LWW by ID with bookId remapping and tombstone check)
    const portalMap = new Map()
    ;(remotePayload.portals || []).forEach(p => {
        if (!p || !p.id) return
        const sId = bookIdRemap.get(p.sourceBookId) || p.sourceBookId
        const tId = bookIdRemap.get(p.targetBookId) || p.targetBookId
        portalMap.set(p.id, {
            ...structuredClone(p),
            sourceBookId: sId,
            targetBookId: tId,
            updatedAt: clampTime(p.updatedAt) || clampTime(p.createdAt) || 0,
        })
    })
    ;(localPayload.portals || []).forEach(p => {
        if (!p || !p.id) return
        const locUp = clampTime(p.updatedAt) || clampTime(p.createdAt) || 0
        const locRec = { ...structuredClone(p), updatedAt: locUp }
        if (!portalMap.has(p.id)) {
            portalMap.set(p.id, locRec)
        } else {
            const remP = portalMap.get(p.id)
            const remUp = remP.updatedAt || remP.createdAt || 0
            if (locUp > remUp || (locUp === remUp && compareCanonicalTieBreak(locRec, remP, effectiveLocalClientId, remotePayload.clientId) > 0)) {
                portalMap.set(p.id, locRec)
            }
        }
    })
    const mergedPortals = Array.from(portalMap.values()).filter(p => {
        if (!p || !p.id) return false
        const tombKey = `portal:${p.id}`
        if (tombstoneMap.has(tombKey)) {
            const tomb = tombstoneMap.get(tombKey)
            if ((tomb.deletedAt || 0) >= (p.updatedAt || p.createdAt || 0)) return false
        }
        if ((p.sourceBookId && tombstoneMap.has(`book:${p.sourceBookId}`)) ||
            (p.targetBookId && tombstoneMap.has(`book:${p.targetBookId}`))) {
            return false
        }
        return true
    })

    // Retain unknown top-level schema properties from remotePayload to prevent clobbering future schema extensions
    const unknownRemoteFields = {}
    if (remotePayload && typeof remotePayload === 'object') {
        const knownKeys = new Set([
            'version', 'clientId', 'deviceName', 'updatedAt', 'lastSyncedAt', 'tombstoneHorizonAt', 'settings',
            'customLists', 'booksMeta', 'highlights', 'bookmarks',
            'readingSessions', 'pdfDrawings', 'chapterTranslations', 'portals', 'deletedRecords',
            'readingPresets', 'customPalette', 'userName', 'bookSettingsOverrides', 'advancedSettings'
        ])
        for (const [k, v] of Object.entries(remotePayload)) {
            if (!knownKeys.has(k)) {
                unknownRemoteFields[k] = structuredClone(v)
            }
        }
    }

    const byStableId = (a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))
    const dedupedTombstones = Array.from(
        new Map(
            Array.from(tombstoneMap.values())
                .filter(t => t && t.id)
                .map(t => [`${t.type || 'unknown'}:${t.id}`, t])
        ).values()
    ).sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))

    const merged = {
        ...unknownRemoteFields,
        version: Math.max(localPayload.version || 1, remotePayload.version || 1),
        clientId: effectiveLocalClientId,
        updatedAt: nowMs,
        lastSyncedAt: nowMs,
        tombstoneHorizonAt: minTombstoneTime,
        settings: mergedSettings,
        readingPresets: mergedReadingPresets,
        customPalette: mergedCustomPalette,
        userName: mergedUserName,
        bookSettingsOverrides: mergedBookSettingsOverrides,
        advancedSettings: mergedAdvancedSettings,
        customLists: mergedCustomLists.map(l => ({
            ...l,
            bookIds: Array.isArray(l.bookIds) ? l.bookIds.map(id => bookIdRemap.get(id) || id) : []
        })).sort(byStableId),
        booksMeta: mergedBooksMeta.sort(byStableId),
        highlights: mergedHighlights.sort(byStableId),
        bookmarks: mergedBookmarks.sort(byStableId),
        readingSessions: mergedSessions.sort(byStableId),
        pdfDrawings: mergedPdfDrawings.sort(byStableId),
        chapterTranslations: mergedChapterTranslations.sort(byStableId),
        portals: mergedPortals.sort(byStableId),
        deletedRecords: dedupedTombstones
    }

    return { merged, stats }
}

