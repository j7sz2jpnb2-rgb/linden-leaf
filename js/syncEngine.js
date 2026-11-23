import { contentIdentityRelation, identityHashes, identityAliases } from './document-identity.js'
import { MAX_AUTO_SYNC_BYTES, ALLOWED_BOOK_FORMATS, sanitizeSyncFormat, sanitizeCloudFileName, isAutoDownloadEligible, isAutoUploadEligible, buildBookSyncMeta } from './book-metadata.js'
export { MAX_AUTO_SYNC_BYTES, ALLOWED_BOOK_FORMATS, sanitizeSyncFormat, sanitizeCloudFileName, isAutoDownloadEligible, isAutoUploadEligible, buildBookSyncMeta } from './book-metadata.js'
import { reconcileBookSyncMeta, mergeDrawingStrokes, mergeSyncData } from './sync-model.js'
export { reconcileBookSyncMeta, mergeDrawingStrokes, mergeSyncData } from './sync-model.js'
// js/syncEngine.js - Multi-device WebDAV & Nutstore Sync and Conflict Resolution Engine
import * as db from './db.js'
import { checkTranslationCompatibility, buildTranslationRevisionArchive } from './translation-job-core.js'
import { getLocale, t } from './i18n.js'

let _activeSyncPromise = null

// Persistence and transport for multi-device sync. Pure merge rules live in sync-model.js.
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
        deviceName: (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.includes('Windows')) ? 'Windows PC' : t('syncEngine.defaultDeviceName'),
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

/**
 * 2. Deterministic LWW Merge Algorithm
 */

/**
 * 3. Apply Merged Payload back into Local IndexedDB
 */
export const applyMergedPayload = async (mergedPayload, customDb = null) => {
    const activeDb = customDb || (typeof globalThis.db !== 'undefined' && globalThis.db ? globalThis.db : db)
    const allLocalBooks = await activeDb.getAllBooks()
    const allDeleted = (typeof activeDb.getAllDeletedRecords === 'function' ? await activeDb.getAllDeletedRecords() : []) || []

    // A. Apply Deletion Tombstones (with protection for re-imported / surviving books)
    const survivingBookIds = new Set((mergedPayload.booksMeta || []).map(b => b.id))
    const survivingHashes = new Set((mergedPayload.booksMeta || []).filter(b => b.documentHash).map(b => b.documentHash))
    const deletedBookIds = []
    if (Array.isArray(mergedPayload.deletedRecords)) {
        for (const tomb of mergedPayload.deletedRecords) {
            if (tomb && tomb.id) {
                const delTime = tomb.deletedAt || Date.now()
                if (tomb.type === 'book' || tomb.type === 'books') {
                    // Match candidates: exact id, exact documentHash, or legacy (no hash on either side AND format + size match)
                    const candidateBooks = allLocalBooks.filter(b => {
                        if (b.id === tomb.id) return true
                        if (contentIdentityRelation(tomb, b) === 'same') return true
                        if (!tomb.documentHash && !b.documentHash && tomb.stableKey && b.stableKey === tomb.stableKey) {
                            const cleanTombFmt = sanitizeSyncFormat(tomb.format)
                            const cleanBFmt = sanitizeSyncFormat(b.format)
                            if (cleanTombFmt && cleanBFmt && cleanTombFmt !== cleanBFmt) return false
                            if (tomb.size && b.size && tomb.size !== b.size) return false
                            return true
                        }
                        return false
                    })

                    for (const localBook of candidateBooks) {
                        // Never delete if this local book survived in mergedPayload
                        if (survivingBookIds.has(localBook.id)) continue
                        if (localBook.documentHash && survivingHashes.has(localBook.documentHash)) continue
                        if ((localBook.updatedAt || localBook.addedAt || 0) > delTime) continue

                        await activeDb.deleteBook(localBook.id, false, delTime)
                        deletedBookIds.push(localBook.id)
                    }
                } else if (tomb.type === 'highlight' || tomb.type === 'highlights') {
                    await activeDb.deleteHighlight(tomb.id, false, delTime)
                } else if (tomb.type === 'bookmark' || tomb.type === 'bookmarks') {
                    await activeDb.deleteBookmark(tomb.id, false, delTime)
                } else if (tomb.type === 'custom_list') {
                    await activeDb.deleteCustomList(tomb.id, false, delTime)
                } else if (tomb.type === 'pdfDrawing' || tomb.type === 'pdf_drawings') {
                    const parts = tomb.id.split('_page_')
                    const localDrawing = parts.length === 2 && typeof activeDb.getPdfPageDrawing === 'function' ? await activeDb.getPdfPageDrawing(parts[0], parseInt(parts[1], 10)) : null
                    if (!localDrawing || delTime >= (localDrawing.updatedAt || 0)) {
                        if (typeof activeDb.clearPdfDrawingById === 'function') await activeDb.clearPdfDrawingById(tomb.id)
                    }
                } else if (tomb.type === 'chapter_translation' || tomb.type === 'chapter_translations' || tomb.type === 'chapterTranslation') {
                    const parts = tomb.id.split('::')
                    if (parts.length === 2) {
                        const localCt = typeof activeDb.getChapterTranslation === 'function' ? await activeDb.getChapterTranslation(parts[0], parts[1]) : null
                        if (localCt && delTime >= (localCt.updatedAt || 0)) {
                            if (typeof activeDb.deleteChapterTranslation === 'function') await activeDb.deleteChapterTranslation(parts[0], parts[1])
                        }
                    }
                }
            }
        }
    }

    // B. Apply custom lists
    if (Array.isArray(mergedPayload.customLists)) {
        for (const list of mergedPayload.customLists) {
            if (typeof activeDb.applySyncedCustomList === 'function') {
                await activeDb.applySyncedCustomList(list)
            } else if (typeof activeDb.saveCustomList === 'function') {
                await activeDb.saveCustomList(list)
            }
        }
    }

    // C. Apply books progress, reading times, favorite & lists (with BookId Remapping for multi-device sync)
    const bookIdRemap = new Map()
    const pendingAutoDownloads = []
    if (Array.isArray(mergedPayload.booksMeta)) {
        const localClientId = (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_sync_client_id') : '') || ''
        const incomingClientId = mergedPayload.clientId || ''

        // Pre-build indexes for fast candidate lookup and strict content identity verification
        const localBooksById = new Map()
        const localBooksByHash = new Map()
        const localBooksByWeakKey = new Map()
        for (const b of allLocalBooks || []) {
            if (b.id) localBooksById.set(b.id, b)
            for (const hash of identityHashes(b)) localBooksByHash.set(hash, b)
            const wk = b.stableKey || (b.title && b.size > 0 ? `${b.title}_${b.size}` : null)
            if (wk) {
                if (!localBooksByWeakKey.has(wk)) localBooksByWeakKey.set(wk, [])
                localBooksByWeakKey.get(wk).push(b)
            }
        }

        for (const meta of mergedPayload.booksMeta) {
            if (!meta || !meta.id) continue
            // Re-check tombstones with fresh DB query to avoid race with concurrent local delete
            const tombstone = allDeleted.find(t => {
                if (t.id === meta.id) return true
                if (contentIdentityRelation(t, meta) === 'same') return true
                if (!t.documentHash && !meta.documentHash && meta.stableKey && t.stableKey === meta.stableKey) {
                    const cleanTombFmt = sanitizeSyncFormat(t.format)
                    const cleanMetaFmt = sanitizeSyncFormat(meta.format)
                    if (cleanTombFmt && cleanMetaFmt && cleanTombFmt !== cleanMetaFmt) return false
                    if (t.size && meta.size && t.size !== meta.size) return false
                    return true
                }
                return false
            })
            if (tombstone && (tombstone.deletedAt || 0) >= (meta.updatedAt || meta.addedAt || 0)) {
                continue
            }

            // Fresh read directly from DB rather than stale snapshot to avoid clobbering concurrent user edits
            let localBook = (typeof activeDb.getBook === 'function' ? await activeDb.getBook(meta.id) : null) || localBooksById.get(meta.id)
            if (!localBook && meta.documentHash) {
                localBook = localBooksByHash.get(meta.documentHash)
            }
            if (!localBook) {
                const wk = meta.stableKey || (meta.title && meta.size > 0 ? `${meta.title}_${meta.size}` : null)
                const candidates = wk ? (localBooksByWeakKey.get(wk) || []) : []
                for (const cand of candidates) {
                    if (meta.documentHash && cand.documentHash) {
                        if (contentIdentityRelation(meta, cand) === 'same') {
                            localBook = cand
                            break
                        }
                        continue
                    }
                    const cleanMetaFmt = sanitizeSyncFormat(meta.format)
                    const cleanCandFmt = sanitizeSyncFormat(cand.format)
                    if (cleanMetaFmt && cleanCandFmt && cleanMetaFmt !== cleanCandFmt) continue
                    if (meta.size && cand.size && meta.size !== cand.size) continue
                    if (meta.title && cand.title && meta.title === cand.title) {
                        localBook = cand
                        break
                    }
                }
            }

            if (localBook) {
                // Re-read candidate from DB before commit to prevent clobbering concurrent modifications
                const fresh = typeof activeDb.getBook === 'function' ? await activeDb.getBook(localBook.id) : null
                if (fresh) localBook = fresh
            }

            if (localBook && localBook.id !== meta.id) {
                bookIdRemap.set(meta.id, localBook.id)
            }
            if (localBook) {
                let changed = false
                const aliases = identityAliases(localBook.documentHash, localBook, meta)
                if (aliases.length !== (localBook.documentHashAliases || []).length) { localBook.documentHashAliases = aliases; changed = true }
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
                    const liveCheck = typeof activeDb.getBook === 'function' ? await activeDb.getBook(localBook.id) : null
                    if (liveCheck) {
                        // Preserve any higher timestamps that occurred locally between read and write
                        if ((liveCheck.tagsUpdatedAt || 0) > (localBook.tagsUpdatedAt || 0)) {
                            localBook.tags = liveCheck.tags
                            localBook.tagsUpdatedAt = liveCheck.tagsUpdatedAt
                        }
                        localBook.updatedAt = meta.updatedAt || localBook.updatedAt || Date.now()
                        localBook._preserveUpdatedAt = true
                        if (typeof activeDb.saveBook === 'function') await activeDb.saveBook(localBook)
                    }
                }
                if (localBook.isCloudOnly && isAutoDownloadEligible(meta)) {
                    localBook.cloudBackupState = 'pending_auto_download'
                    if (typeof activeDb.saveBook === 'function') await activeDb.saveBook(localBook)
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
                    documentHash: meta.documentHash || null,
                    documentHashAliases: meta.documentHashAliases || [],
                    blobRevision: meta.blobRevision || null,
                    revisionOrigin: meta.revisionOrigin || null,
                    cropSettings: meta.cropSettings || null,
                    customTitle: meta.customTitle || null,
                    customAuthor: meta.customAuthor || null,
                    cloudBackup: meta.cloudBackup,
                    cloudBackupState: isAutoEligible ? 'pending_auto_download' : 'cloud_only',
                    addedAt: meta.addedAt || Date.now(),
                    updatedAt: meta.updatedAt || Date.now(),
                    _preserveUpdatedAt: true
                }
                if (typeof activeDb.saveBook === 'function') await activeDb.saveBook(cloudBookRecord)
                if (isAutoEligible) {
                    pendingAutoDownloads.push(cloudBookRecord)
                }
            }
        }
    }

    // D. Apply Highlights in a single batched transaction (with BookId Remapping and Local Tombstone / Edit Protection)
    if (Array.isArray(mergedPayload.highlights)) {
        const preparedHighlights = []
        for (const hl of mergedPayload.highlights) {
            if (!hl) continue
            if (hl.bookId && bookIdRemap.has(hl.bookId)) {
                hl.bookId = bookIdRemap.get(hl.bookId)
            }
            if (hl.bookId && deletedBookIds.includes(hl.bookId)) {
                continue
            }
            preparedHighlights.push(hl)
        }
        if (typeof activeDb.applySyncedHighlightsBatch === 'function') {
            await activeDb.applySyncedHighlightsBatch(preparedHighlights)
        } else {
            for (const hl of preparedHighlights) {
                if (typeof activeDb.applySyncedHighlight === 'function') await activeDb.applySyncedHighlight(hl)
                else if (typeof activeDb.saveHighlight === 'function') await activeDb.saveHighlight(hl)
            }
        }
    }

    // E. Apply Bookmarks in a single batched transaction (with BookId Remapping and Local Tombstone Protection)
    if (Array.isArray(mergedPayload.bookmarks)) {
        const preparedBookmarks = []
        for (const bm of mergedPayload.bookmarks) {
            if (!bm) continue
            if (bm.bookId && bookIdRemap.has(bm.bookId)) {
                bm.bookId = bookIdRemap.get(bm.bookId)
            }
            if (bm.bookId && deletedBookIds.includes(bm.bookId)) {
                continue
            }
            preparedBookmarks.push(bm)
        }
        if (typeof activeDb.applySyncedBookmarksBatch === 'function') {
            await activeDb.applySyncedBookmarksBatch(preparedBookmarks)
        } else {
            for (const bm of preparedBookmarks) {
                if (typeof activeDb.applySyncedBookmark === 'function') await activeDb.applySyncedBookmark(bm)
                else if (typeof activeDb.saveBookmark === 'function') await activeDb.saveBookmark(bm)
            }
        }
    }

    // F. Apply Reading Sessions in a single batched transaction (with BookId Remapping)
    if (Array.isArray(mergedPayload.readingSessions)) {
        const preparedSessions = []
        for (const sess of mergedPayload.readingSessions) {
            if (!sess) continue
            if (sess.bookId && bookIdRemap.has(sess.bookId)) {
                sess.bookId = bookIdRemap.get(sess.bookId)
            }
            preparedSessions.push(sess)
        }
        if (typeof activeDb.saveReadingSessionsBatch === 'function') {
            await activeDb.saveReadingSessionsBatch(preparedSessions)
        } else {
            for (const sess of preparedSessions) {
                if (typeof activeDb.saveReadingSession === 'function') await activeDb.saveReadingSession(sess, false)
            }
        }
    }

    // G. Apply Settings
    if (mergedPayload.settings && typeof mergedPayload.settings === 'object' && Object.keys(mergedPayload.settings).length > 0) {
        const localSettings = (typeof activeDb.getSetting === 'function' ? await activeDb.getSetting('readerSettings') : null) || {}
        const mergedSettings = { ...localSettings, ...mergedPayload.settings }
        if (typeof activeDb.setSetting === 'function') await activeDb.setSetting('readerSettings', mergedSettings)
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

    // G6. Apply Safe Advanced Settings (strip sensitive keys and non-loopback offline endpoints from remote payload)
    if (mergedPayload.advancedSettings && typeof localStorage !== 'undefined') {
        try {
            const rawCur = localStorage.getItem('linden_advanced_settings_config') || localStorage.getItem('linden_advanced_settings')
            const curAdv = rawCur ? JSON.parse(rawCur) : {}
            const safeIncoming = { ...mergedPayload.advancedSettings }
            const blockedKeys = new Set(['ttsapikey', 'apikey', 'secret', 'password', 'token', 'auth', 'privatekey', 'dictstoragepath', 'customdirectory', 'ttsofflineendpoint'])
            for (const key of Object.keys(safeIncoming)) {
                if (blockedKeys.has(key.toLowerCase())) {
                    delete safeIncoming[key]
                }
            }
            const mergedAdv = { ...curAdv, ...safeIncoming }
            localStorage.setItem('linden_advanced_settings_config', JSON.stringify(mergedAdv))
            if (typeof window !== 'undefined') {
                window.app?.advancedSettings?.load?.()
                window.app?.advancedSettings?.applyAllSettings?.()
            }
        } catch (_) {}
    }

    // H. Apply PDF Drawings (with BookId Remapping and Local Tombstone / Edit Protection)
    if (Array.isArray(mergedPayload.pdfDrawings) && mergedPayload.pdfDrawings.length > 0) {
        const getDbPromise = typeof activeDb.openDB === 'function' ? activeDb.openDB() : (typeof db.openDB === 'function' ? db.openDB() : null)
        const dbInstance = getDbPromise ? await getDbPromise : null
        if (dbInstance && dbInstance.objectStoreNames && dbInstance.objectStoreNames.contains('pdf_drawings')) {
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
                d.id = (activeDb.remapPdfDrawingId || db.remapPdfDrawingId) ? (activeDb.remapPdfDrawingId || db.remapPdfDrawingId)(d, targetBookId) : d.id
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
    if (syncChapterTrans && Array.isArray(mergedPayload.chapterTranslations) && mergedPayload.chapterTranslations.length > 0 && typeof activeDb.saveChapterTranslation === 'function') {
        for (const ct of mergedPayload.chapterTranslations) {
            const chapKey = ct.chapterKey || ct.chapterSourceKey
            if (!ct || !ct.bookId || !chapKey) continue
            let targetBookId = ct.bookId
            if (bookIdRemap.has(targetBookId)) {
                targetBookId = bookIdRemap.get(targetBookId)
            }
            if (deletedBookIds.includes(targetBookId)) continue
            const record = { ...ct, bookId: targetBookId, chapterKey: chapKey, id: `${targetBookId}::${chapKey}` }
            const localCt = typeof activeDb.getChapterTranslation === 'function' ? await activeDb.getChapterTranslation(targetBookId, chapKey) : null
            if (!localCt || (record.updatedAt || 0) >= (localCt.updatedAt || 0)) {
                await activeDb.saveChapterTranslation(record)
            }
        }
    }

    return { success: true, pendingAutoDownloads: pendingAutoDownloads || [], deletedBookIds: deletedBookIds || [] }
}

/**
 * 4. Master Full Sync Lifecycle Executor with Mutex and ETag Optimistic Concurrency
 */
export function validateSyncPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(t('syncEngine.error.invalidFormat'))
    }
    const version = data.schemaVersion ?? data.version
    if (typeof version !== 'number') {
        throw new Error(t('syncEngine.error.missingVersion'))
    }
    if (version > 4) {
        throw new Error(t('syncEngine.error.unsupportedVersion', { version }))
    }
    const knownKeys = ['booksMeta', 'highlights', 'bookmarks', 'readingSessions', 'customLists', 'deletedRecords', 'pdfDrawings']
    if (version < 1 || !knownKeys.some(k => Object.prototype.hasOwnProperty.call(data, k)) || knownKeys.some(k => Object.prototype.hasOwnProperty.call(data, k) && !Array.isArray(data[k]))) {
        throw new Error(t('syncEngine.error.invalidSchema'))
    }
    return true
}

export const previewSyncPayload = async (config, provider) => {
    let remoteData = null
    if (provider) {
        const res = await provider.readFile('linden_sync_data.json')
        if (!res || res.error || res.authError || res.offline || res.invalid || res.status === 'invalid' || res.status === 'offline' || res.status === 'auth-error' || res.status === 401 || res.status === 403) throw new Error(res?.error || t('syncEngine.error.remoteReadFailed'))
        if (!(res.missing || res.status === 'missing')) {
            if (res.content == null || (typeof res.content === 'string' && !res.content.trim())) throw new Error(t('syncEngine.error.remoteEmpty'))
            try { remoteData = typeof res.content === 'string' ? JSON.parse(res.content) : res.content } catch (_) { throw new Error(t('syncEngine.error.remoteCorrupt')) }
            validateSyncPayload(remoteData)
        }
    } else {
        const bridge = typeof window !== 'undefined' ? (window.platformBridge || window.electronAPI) : null
        if (!bridge?.syncFetchRemote) throw new Error(t('syncEngine.error.noCloudRead'))
        const res = await bridge.syncFetchRemote(config)
        if (!res || res.error) throw new Error(res?.error || t('syncEngine.error.remoteReadFailed'))
        if (res.exists) { remoteData = res.data; validateSyncPayload(remoteData) }
    }
    const localData = await exportSyncPayload()
    const summarize = data => ({ books: data?.booksMeta?.length || 0, highlights: data?.highlights?.length || 0, bookmarks: data?.bookmarks?.length || 0, sessions: data?.readingSessions?.length || 0 })
    return { local: summarize(localData), remote: summarize(remoteData), remoteExists: remoteData !== null }
}

export const executeSyncLifecycle = async (config, { onProgress = () => {}, provider = null } = {}) => {

    let activeProvider = provider
    if (!activeProvider && config?.providerType) {
        try {
            const { getStorageProvider } = await import('./storage-providers.js')
            activeProvider = getStorageProvider(config.providerType, config)
        } catch (_) {}
    }

    const bridge = (typeof window !== 'undefined' ? (window.platformBridge || window.electronAPI) : null)
    if (!activeProvider && (!bridge?.syncFetchRemote || !bridge?.syncSaveRemote)) {
        throw new Error(t('syncEngine.error.noDesktopSyncApi'))
    }

    if (_activeSyncPromise) {
        return await _activeSyncPromise
    }

    _activeSyncPromise = (async () => {
        onProgress(t('syncEngine.progress.exporting'), 'export')
        const localPayload = await exportSyncPayload()

        let remoteData = null
        let remoteEtag = null

        if (activeProvider) {
            onProgress(t('syncEngine.progress.fetching'), 'fetch')
            const fileRes = await activeProvider.readFile('linden_sync_data.json')
            if (!fileRes || fileRes.error || fileRes.invalid || fileRes.status === 'invalid') {
                throw new Error(fileRes?.error || t('syncEngine.error.noResponseOrInvalid'))
            }
            if (fileRes.status === 'auth-error' || fileRes.authError || fileRes.status === 401 || fileRes.status === 403) {
                throw new Error(t('syncEngine.error.authError'))
            }
            if (fileRes.status === 'offline' || fileRes.offline) {
                throw new Error(t('syncEngine.error.offline'))
            }
            if (fileRes.status === 'missing' || fileRes.missing) {
                remoteData = null
            } else if (fileRes.content !== undefined && fileRes.content !== null) {
                const rawStr = typeof fileRes.content === 'string' ? fileRes.content.trim() : null
                if (typeof fileRes.content === 'string' && !rawStr) {
                    throw new Error(t('syncEngine.error.corruptEmpty'))
                }
                try {
                    remoteData = rawStr ? JSON.parse(rawStr) : fileRes.content
                } catch (e) {
                    console.warn('[Sync] Failed to parse remote JSON:', e)
                    remoteData = null
                    throw new Error(t('syncEngine.error.corruptJson', { detail: e.message }))
                }
                validateSyncPayload(remoteData)
            } else {
                throw new Error(t('syncEngine.error.readInvalid'))
            }
            remoteEtag = fileRes?.etag || null
        } else {
            onProgress(t('syncEngine.progress.fetchingBridge'), 'fetch')
            const remoteRes = await bridge.syncFetchRemote(config)
            if (remoteRes.error) {
                throw new Error(t('syncEngine.error.readFailed', { detail: remoteRes.error }))
            }
            remoteData = remoteRes.exists ? remoteRes.data : null
            if (remoteData) {
                validateSyncPayload(remoteData)
            }
            remoteEtag = remoteRes.etag || null
        }

        onProgress(t('syncEngine.progress.merging'), 'merge')
        let { merged, stats } = mergeSyncData(localPayload, remoteData)

        let maxRetries = 2
        let currentRemoteEtag = remoteEtag
        let lastSaveRes = null

        while (maxRetries >= 0) {
            onProgress(t('syncEngine.progress.uploading'), 'upload')
            const summaryMd = generateReadingSummaryMarkdown(merged)

            if (activeProvider) {
                const writeContent = JSON.stringify(merged, null, 2)
                const writeRes = await activeProvider.writeFile('linden_sync_data.json', writeContent, { ifMatch: currentRemoteEtag })
                if (writeRes.success) break

                if (writeRes.conflict && maxRetries > 0) {
                    maxRetries--
                    onProgress(t('syncEngine.progress.conflictMerge'), 'merge')
                    await new Promise(r => setTimeout(r, 600 * (2 - maxRetries)))
                    const reFetch = await activeProvider.readFile('linden_sync_data.json')
                    if (!reFetch || reFetch.authError || reFetch.offline || reFetch.invalid) {
                        throw new Error(t('syncEngine.error.refetchFailed'))
                    }
                    let reRemoteData = null
                    if (reFetch.missing) {
                        reRemoteData = null
                    } else if (reFetch.content !== undefined && reFetch.content !== null) {
                        const rawStr = typeof reFetch.content === 'string' ? reFetch.content.trim() : null
                        if (typeof reFetch.content === 'string' && !rawStr) {
                            throw new Error(t('syncEngine.error.refetchEmpty'))
                        }
                        try {
                            reRemoteData = rawStr ? JSON.parse(rawStr) : reFetch.content
                        } catch (e) {
                            throw new Error(t('syncEngine.error.refetchParse', { detail: e.message }))
                        }
                        validateSyncPayload(reRemoteData)
                    } else {
                        throw new Error(t('syncEngine.error.refetchInvalid'))
                    }
                    currentRemoteEtag = reFetch?.etag || null
                    const reMergedResult = mergeSyncData(localPayload, reRemoteData)
                    merged = reMergedResult.merged
                    stats = reMergedResult.stats
                    continue
                }
                throw new Error(t('syncEngine.error.saveFailed', { detail: writeRes.error || t('syncEngine.error.conflictOrStorage') }))
            } else {
                lastSaveRes = await bridge.syncSaveRemote(config, merged, currentRemoteEtag, summaryMd)
                if (lastSaveRes.success) break

                if (lastSaveRes.isConflict && maxRetries > 0) {
                    maxRetries--
                    onProgress(t('syncEngine.progress.conflictMerge'), 'merge')
                    await new Promise(r => setTimeout(r, 600 * (2 - maxRetries)))
                    const reFetch = await bridge.syncFetchRemote(config)
                    if (reFetch.error) throw new Error(t('syncEngine.error.refetchBridgeFailed', { detail: reFetch.error }))
                    currentRemoteEtag = reFetch.etag || null
                    const reMergedResult = mergeSyncData(localPayload, reFetch.exists ? reFetch.data : null)
                    merged = reMergedResult.merged
                    stats = reMergedResult.stats
                    continue
                }

                throw new Error(t('syncEngine.error.saveFailed', { detail: lastSaveRes.error || t('syncEngine.error.unknownNetwork') }))
            }
        }

        onProgress(t('syncEngine.progress.applying'), 'apply')
        const applyRes = await applyMergedPayload(merged)

        onProgress(t('syncEngine.progress.done'), 'done')
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
    const locale = getLocale()
    const syncTime = new Date(payload.updatedAt || Date.now()).toLocaleString(locale)
    const device = payload.deviceName || t('syncEngine.defaultDeviceName')
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

    let md = t('syncEngine.report.title')
    md += t('syncEngine.report.generatedBy')
    md += t('syncEngine.report.metaLine', { syncTime, device, version: payload.version || 2 })

    md += t('syncEngine.report.overviewHeading')
    md += t('syncEngine.report.overviewBooks', { total: books.length, finished: finishedBooks.length, reading: readingBooks.length })
    md += t('syncEngine.report.overviewReadingTime', { hours: totalHours, minutes: Math.round(totalSecs / 60) })
    if (totalListenSecs > 0) {
        md += t('syncEngine.report.overviewListenTime', { hours: totalListenHours, minutes: Math.round(totalListenSecs / 60) })
    }
    md += t('syncEngine.report.overviewNotes', { count: highlights.length })
    md += t('syncEngine.report.overviewSessions', { count: sessions.length })

    // Daily Reading Book-by-Book Register
    md += t('syncEngine.report.dailyHeading')
    md += t('syncEngine.report.dailyDesc')
    md += t('syncEngine.report.dailyTableHeader')

    const dateMap = new Map()
    sessions.forEach(s => {
        if (!s) return
        const d = s.date || (s.startTime ? new Date(s.startTime).toISOString().slice(0, 10) : t('syncEngine.report.unknownDate'))
        if (!dateMap.has(d)) dateMap.set(d, [])
        dateMap.get(d).push(s)
    })

    const sortedDates = Array.from(dateMap.keys()).sort((a, b) => b.localeCompare(a))
    if (sortedDates.length === 0) {
        md += t('syncEngine.report.dailyEmptyRow')
    } else {
        const listSep = t('syncEngine.report.listSep')
        sortedDates.slice(0, 60).forEach(d => {
            const daySess = dateMap.get(d)
            const bookDurMap = new Map()
            const bookAuthorMap = new Map()
            let dayTotalSecs = 0
            daySess.forEach(s => {
                const title = s.bookTitle || t('syncEngine.report.unknownTitle')
                const author = s.bookAuthor || ''
                const dur = s.durationSeconds || 0
                dayTotalSecs += dur
                bookDurMap.set(title, (bookDurMap.get(title) || 0) + dur)
                if (author) bookAuthorMap.set(title, author)
            })
            const bookTitles = Array.from(bookDurMap.entries()).map(([bookName, sec]) => {
                const mins = Math.round(sec / 60)
                const durStr = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
                return `${t('syncEngine.report.quotedTitle', { title: bookName })}(${durStr})`
            }).join(listSep)
            const authors = Array.from(new Set(Array.from(bookAuthorMap.values()).filter(Boolean))).join(listSep) || '-'
            const totalMins = Math.round(dayTotalSecs / 60)
            const dayDurStr = totalMins >= 60 ? t('syncEngine.report.durationHoursMins', { hours: Math.floor(totalMins / 60), mins: totalMins % 60 }) : t('syncEngine.report.durationMins', { mins: totalMins })
            md += `| ${d} | ${bookTitles} | ${authors} | ${dayDurStr} | ${t('syncEngine.report.sessionCount', { count: daySess.length })} |\n`
        })
        if (sortedDates.length > 60) {
            md += t('syncEngine.report.truncatedDates', { count: sortedDates.length - 60 })
        }
    }
    md += `\n`

    // Bookshelf
    md += t('syncEngine.report.shelfHeading')
    md += t('syncEngine.report.shelfTableHeader')
    const statusLabels = {
        unread: t('status.unread'),
        want_to_read: t('status.wantToRead'),
        reading: t('status.reading'),
        on_hold: t('status.onHold'),
        finished: t('status.finished')
    }
    books.forEach(b => {
        const title = b.customTitle || b.title || t('syncEngine.report.unknownTitle')
        const author = b.customAuthor || b.author || '-'
        const fmt = (b.format || 'doc').toUpperCase()
        const st = statusLabels[b.readingStatus] || t('status.unread')
        const rating = b.rating != null ? `${b.rating} ★` : '-'
        const tags = Array.isArray(b.tags) && b.tags.length ? b.tags.join(', ') : '-'
        const dur = Math.round((b.totalReadingSeconds || 0) / 60)
        const durStr = dur >= 60 ? `${Math.floor(dur / 60)}h${dur % 60}m` : `${dur}m`
        const frac = Math.round(((b.progress?.fraction || 0) * 100))
        md += `| ${t('syncEngine.report.catalogTitle', { title })} | ${author} | ${fmt} | ${st} | ${rating} | ${tags} | ${durStr} | ${frac}% |\n`
    })
    md += `\n`

    // Custom Lists
    if (customLists.length > 0) {
        md += t('syncEngine.report.listsHeading')
        customLists.forEach(l => {
            const bCount = Array.isArray(l.bookIds) ? l.bookIds.length : 0
            md += t('syncEngine.report.listItem', { name: l.name || t('syncEngine.report.unnamedList'), count: bCount })
        })
        md += `\n`
    }

    // Highlights excerpt
    if (highlights.length > 0) {
        md += t('syncEngine.report.highlightsHeading')
        const sortedHl = [...highlights].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20)
        sortedHl.forEach(h => {
            const bTitle = h.bookTitle ? t('syncEngine.report.quotedTitle', { title: h.bookTitle }) : ''
            const chap = h.chapterTitle ? ` · ${h.chapterTitle}` : ''
            const date = h.createdAt ? new Date(h.createdAt).toLocaleDateString(locale) : ''
            md += `> ${h.text || ''}\n\n`
            if (h.note) {
                md += t('syncEngine.report.noteLabel', { note: h.note })
            }
            md += t('syncEngine.report.sourceLine', { source: `${bTitle}${chap}`, date })
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
