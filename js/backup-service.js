import { contentIdentityRelation } from './document-identity.js'
// Backup/restore data operations. UI integration is supplied through applyConfig.
import * as db from './db.js'
import { sanitizeAdvancedSettings, STORAGE_KEY_CONFIG } from './advanced-settings-schema.js'
import { buildBookSyncMeta } from './book-metadata.js'
import { collectPdfPreferences, restoredPdfPreferenceEntries } from './pdf-preferences.js'
import { t } from './i18n.js'

export async function assembleFullBackupData(activeDb = db, config = {}) {
    const [sessions, highlights, books, bookmarks, drawings, customLists, chapterTranslations, deletedRecords] = await Promise.all([
        activeDb.getAllReadingSessions(), activeDb.getAllHighlights(), activeDb.getAllBooks(),
        activeDb.getAllBookmarks(), activeDb.getAllPdfDrawings(), activeDb.getAllCustomLists(),
        activeDb.getAllChapterTranslations(), activeDb.getAllDeletedRecords()
    ])
    const manualTocs = {}
    for (const book of books) {
        const toc = await activeDb.getSetting(`linden_manual_toc_${book.id}`)
        if (Array.isArray(toc) && toc.length) manualTocs[book.id] = toc
    }

    const readerSettings = (await activeDb.getSetting?.('readerSettings')) || (await activeDb.getSetting?.('reader_settings')) || {}

    let readingPresets = []
    try {
        const rawPresets = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_reading_presets_v1') : null
        if (rawPresets) readingPresets = JSON.parse(rawPresets) || []
    } catch (_) {}

    let customPalette = null
    try {
        const rawPalette = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_custom_semantic_palette_v1') : null
        if (rawPalette) customPalette = JSON.parse(rawPalette)
    } catch (_) {}

    let userName = ''
    try {
        userName = (typeof localStorage !== 'undefined' ? (localStorage.getItem('linden_user_name') || '') : '').trim()
    } catch (_) {}

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

    const safeConfig = { ...(config || {}) }
    const sensitiveKeys = ['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory']
    for (const k of sensitiveKeys) {
        delete safeConfig[k]
    }

    const bookMapById = new Map(books.map(b => [b.id, b]))
    const enrichedSessions = sessions.map(s => {
        if (!s) return s
        const b = s.bookId ? bookMapById.get(s.bookId) : null
        return {
            ...s,
            bookTitle: s.bookTitle || b?.customTitle || b?.title || '',
            bookAuthor: s.bookAuthor || b?.customAuthor || b?.author || ''
        }
    })

    return {
        format: 'linden-leaf-full-backup',
        schemaVersion: 4,
        exportedAt: new Date().toISOString(),
        userName,
        readerSettings,
        readingPresets,
        customPalette,
        bookSettingsOverrides,
        config: safeConfig,
        sessions: enrichedSessions,
        highlights,
        bookmarks,
        drawings,
        customLists,
        readingLists: customLists,
        chapterTranslations,
        deletedRecords,
        manualTocs,
        pdfToolPreferences: collectPdfPreferences(books),
        books: books.map(b => ({
            ...buildBookSyncMeta(b),
            nativePath: b.nativePath || null,
            nativeSnapshotPath: b.nativeSnapshotPath || null,
            sourceDescriptor: b.sourceDescriptor || null,
            isRecentOnly: Boolean(b.isRecentOnly),
            currentLocation: b.currentLocation || null
        }))
    }
}

export async function createFullDataBackup(options = {}) {
    const payload = await assembleFullBackupData(options.db || db, options.config || {})
    const backupId = 'backup_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
    const jsonContent = JSON.stringify(payload, null, 2)
    const filename = options.filename || `linden_leaf_auto_backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}_${backupId.replace(/^backup_/, '')}.json`
    let backupPath = null

    const bridge = options.bridge || (typeof window !== 'undefined' ? window.platformBridge : null)
    if (!bridge) {
        return {
            success: false,
            error: t('backupError.noBridge')
        }
    }

    try {
        const paths = typeof bridge.fsGetAppPaths === 'function' ? await bridge.fsGetAppPaths() : null
        const baseDir = options.targetDir || paths?.data_dir || paths?.config_dir
        if (!baseDir) {
            throw new Error(t('backupError.noTargetDir'))
        }
        const sep = baseDir.includes('/') ? '/' : '\\'
        backupPath = `${baseDir.replace(/[\\/]+$/, '')}${sep}${filename}`
        if (typeof bridge.writeSyncFile === 'function') {
            const res = await bridge.writeSyncFile(backupPath, jsonContent)
            if (!res || !res.success) throw new Error(t('backupError.writeFailedWithMsg', { message: res?.error || 'CAS/Write failed' }))
        } else if (typeof bridge.writeFileText === 'function') {
            const wrote = await bridge.writeFileText(backupPath, jsonContent)
            if (wrote === false) throw new Error(t('backupError.writeFailed'))
        } else if (typeof bridge.saveTextFile === 'function') {
            const wrote = await bridge.saveTextFile(backupPath, jsonContent)
            if (wrote === false) throw new Error(t('backupError.writeFailed'))
        } else {
            throw new Error(t('backupError.bridgeUnsupported'))
        }
        return {
            success: true,
            backupId,
            path: backupPath,
            payload
        }
    } catch (err) {
        console.error('[createFullDataBackup] failed:', err)
        throw new Error(t('backupError.autoBackupFailed', { message: err.message || String(err) }))
    }
}

export async function restoreFullDataBackup(backupData, activeDb = db, applyConfig = () => {}) {
    const operationId = `restore_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (typeof activeDb.applyRestorePlan !== 'function') throw new Error(t('backupError.txRequired'))
    const acquire = activeDb.acquireRestoreOperationLock
    if (typeof acquire === 'function') await acquire(operationId)
    try {
        return await _restoreFullDataBackupLocked(backupData, activeDb, operationId, applyConfig)
    } finally {
        if (typeof activeDb.releaseRestoreOperationLock === 'function') await activeDb.releaseRestoreOperationLock(operationId)
    }
}

async function _restoreFullDataBackupLocked(backupData, activeDb, operationId, applyConfig) {
    if (!backupData || typeof backupData !== 'object') {
        throw new Error(t('backupError.invalidData'))
    }
    if (backupData.format !== 'linden-leaf-full-backup' || ![1, 2, 3, 4].includes(backupData.schemaVersion)) {
        throw new Error(t('backupError.unsupportedFormat'))
    }

    // 1. Snapshot existing records to verify conflicts & support rollback
    const [
        existingBooks,
        existingHighlights,
        existingBookmarks,
        existingSessions,
        existingTranslations,
        existingDrawings,
        existingLists,
        existingDeleted
    ] = await Promise.all([
        activeDb.getAllBooks ? activeDb.getAllBooks() : Promise.resolve([]),
        activeDb.getAllHighlights ? activeDb.getAllHighlights() : Promise.resolve([]),
        activeDb.getAllBookmarks ? activeDb.getAllBookmarks() : Promise.resolve([]),
        activeDb.getAllReadingSessions ? activeDb.getAllReadingSessions() : Promise.resolve([]),
        activeDb.getAllChapterTranslations ? activeDb.getAllChapterTranslations() : Promise.resolve([]),
        activeDb.getAllPdfDrawings ? activeDb.getAllPdfDrawings() : (activeDb.getAllPdfPageDrawings ? activeDb.getAllPdfPageDrawings() : Promise.resolve([])),
        activeDb.getAllCustomLists ? activeDb.getAllCustomLists() : Promise.resolve([]),
        activeDb.getAllDeletedRecords ? activeDb.getAllDeletedRecords() : Promise.resolve([])
    ])

    const snapshot = {
        books: existingBooks || [],
        highlights: existingHighlights || [],
        bookmarks: existingBookmarks || [],
        sessions: existingSessions || [],
        translations: existingTranslations || [],
        drawings: existingDrawings || [],
        lists: existingLists || [],
        deletedRecords: existingDeleted || []
    }

    const existingBookMap = new Map((snapshot.books).map(b => [b.id, b]))
    const bookIdRemap = new Map()

    // 2. Tombstone reconciliation: combine local tombstones and incoming backup tombstones
    const combinedDeleted = [
        ...(existingDeleted || []),
        ...(Array.isArray(backupData.deletedRecords) ? backupData.deletedRecords : [])
    ].filter(Boolean)
    const tombstonedBookIds = new Set()
    const isTombstoned = (b) => {
        if (!b) return false
        return combinedDeleted.some(dr => {
            if (
                dr.id === b.id ||
                (b.stableKey && (dr.id === `key:${b.stableKey}` || dr.stableKey === `id:${b.id}`)) ||
                (b.documentHash && (dr.id === `docHash:${b.documentHash}` || dr.documentHash === b.documentHash || dr.stableKey === `hash:${b.documentHash}`))
            ) {
                return (dr.deletedAt || 0) >= (b.updatedAt || b.addedAt || 0)
            }
            return false
        })
    }
    if (Array.isArray(backupData.books)) {
        for (const b of backupData.books) {
            if (b && b.id && isTombstoned(b)) {
                tombstonedBookIds.add(b.id)
            }
        }
    }
    for (const dr of combinedDeleted) {
        if (dr && (dr.type === 'book' || dr.type === 'books')) {
            const matchBook = Array.isArray(backupData.books) ? backupData.books.find(b => b && b.id === dr.id) : null
            if (!matchBook || (dr.deletedAt || 0) >= (matchBook.updatedAt || matchBook.addedAt || 0)) {
                tombstonedBookIds.add(dr.id)
            }
        }
    }

    const isItemTombstoned = (item) => {
        if (!item || !item.id) return false
        if (item.bookId && tombstonedBookIds.has(item.bookId)) return true
        return combinedDeleted.some(dr => {
            if (dr.id === item.id) {
                return (dr.deletedAt || 0) >= (item.updatedAt || item.createdAt || 0)
            }
            return false
        })
    }

    // 3. Pre-map books to resolve content identity conflicts
    if (Array.isArray(backupData.books)) {
        for (const b of backupData.books) {
            if (!b || !b.id) continue
            if (isTombstoned(b)) continue
            let existing = existingBookMap.get(b.id)
            if (!existing && typeof activeDb.getBook === 'function') {
                existing = await activeDb.getBook(b.id).catch(() => null)
                if (existing) existingBookMap.set(b.id, existing)
            }
            if (existing) {
                let isConflict = false
                if (contentIdentityRelation(existing, b) === 'different') {
                    isConflict = true
                } else if (!existing.documentHash || !b.documentHash) {
                    if (existing.format && b.format && existing.format.toLowerCase() !== b.format.toLowerCase()) {
                        isConflict = true
                    } else if (existing.size && b.size && existing.size !== b.size) {
                        isConflict = true
                    } else if (existing.stableKey && b.stableKey && existing.stableKey !== b.stableKey) {
                        isConflict = true
                    }
                }

                if (isConflict) {
                    const cleanHash = (b.documentHash || '').replace(/[^a-zA-Z0-9_-]/g, '')
                    const suffix = cleanHash || (b.stableKey || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'diff'
                    let mappedId = `${b.id}_backup_${suffix}`
                    let counter = 1
                    while (existingBookMap.has(mappedId) && existingBookMap.get(mappedId).documentHash !== b.documentHash) {
                        mappedId = `${b.id}_backup_${suffix}_${counter++}`
                    }
                    bookIdRemap.set(b.id, mappedId)
                }
            }
        }
    }

    // 4. Build restore plan
    const booksToPut = []
    const highlightsToPut = []
    const bookmarksToPut = []
    const sessionsToPut = []
    const translationsToPut = []
    const drawingsToPut = []
    const listsToPut = []
    const settingsToPut = []

    // 4a. Chapter Translations
    if (Array.isArray(backupData.chapterTranslations)) {
        const existingTrMap = new Map((snapshot.translations || []).map(t => [t.id, t]))
        for (const ct of backupData.chapterTranslations) {
            if (ct && ct.bookId && ct.chapterKey) {
                if (isItemTombstoned(ct)) continue
                const targetBookId = bookIdRemap.get(ct.bookId) || ct.bookId
                const targetId = `${targetBookId}::${ct.chapterKey}`
                const existing = existingTrMap.get(targetId)
                if (existing && (existing.updatedAt || 0) > (ct.updatedAt || 0)) {
                    continue
                }
                translationsToPut.push({
                    ...ct,
                    bookId: targetBookId,
                    id: targetId
                })
            }
        }
    }

    // 4b. Reading Sessions
    if (Array.isArray(backupData.sessions)) {
        const existingSessionMap = new Map((snapshot.sessions || []).map(s => [s.id, s]))
        for (const s of backupData.sessions) {
            if (!s || !s.id) continue
            if (isItemTombstoned(s)) continue
            const targetBookId = (s.bookId && bookIdRemap.has(s.bookId)) ? bookIdRemap.get(s.bookId) : s.bookId
            const targetSessionId = targetBookId !== s.bookId ? `${s.id}_remap_${targetBookId}` : s.id
            let finalSession = { ...s, id: targetSessionId, bookId: targetBookId }
            const existing = existingSessionMap.get(targetSessionId)
            if (existing) {
                finalSession = {
                    ...existing,
                    ...finalSession,
                    durationSeconds: Math.max(existing.durationSeconds || 0, s.durationSeconds || 0),
                    activeDurationSeconds: Math.max(existing.activeDurationSeconds || 0, s.activeDurationSeconds || 0),
                    updatedAt: Math.max(existing.updatedAt || 0, s.updatedAt || 0)
                }
            }
            sessionsToPut.push(finalSession)
        }
    }

    // 4c. Highlights
    if (Array.isArray(backupData.highlights)) {
        const existingHlMap = new Map((snapshot.highlights || []).map(h => [h.id, h]))
        for (const h of backupData.highlights) {
            if (!h || !h.id) continue
            if (isItemTombstoned(h)) continue
            const targetBookId = (h.bookId && bookIdRemap.has(h.bookId)) ? bookIdRemap.get(h.bookId) : h.bookId
            const targetHlId = targetBookId !== h.bookId ? `${h.id}_remap_${targetBookId}` : h.id
            const incomingTime = h.updatedAt || h.createdAt || 0
            const existing = existingHlMap.get(targetHlId)
            if (existing) {
                const existingTime = existing.updatedAt || existing.createdAt || 0
                if (existingTime > incomingTime) {
                    continue
                }
            }
            highlightsToPut.push({
                ...h,
                id: targetHlId,
                bookId: targetBookId
            })
        }
    }

    // 4d. Bookmarks
    if (Array.isArray(backupData.bookmarks)) {
        const existingBmMap = new Map((snapshot.bookmarks || []).map(bm => [bm.id, bm]))
        for (const bm of backupData.bookmarks) {
            if (!bm || !bm.id) continue
            if (isItemTombstoned(bm)) continue
            const targetBookId = (bm.bookId && bookIdRemap.has(bm.bookId)) ? bookIdRemap.get(bm.bookId) : bm.bookId
            const targetBmId = targetBookId !== bm.bookId ? `${bm.id}_remap_${targetBookId}` : bm.id
            const incomingTime = bm.updatedAt || bm.createdAt || 0
            const existing = existingBmMap.get(targetBmId)
            if (existing) {
                const existingTime = existing.updatedAt || existing.createdAt || 0
                if (existingTime > incomingTime) continue
            }
            bookmarksToPut.push({ ...bm, id: targetBmId, bookId: targetBookId })
        }
    }

    // 4e. PDF Drawings
    if (Array.isArray(backupData.drawings)) {
        for (const d of backupData.drawings) {
            if (!d || !d.bookId || d.pageIndex == null) continue
            if (isItemTombstoned(d)) continue
            const targetBookId = bookIdRemap.has(d.bookId) ? bookIdRemap.get(d.bookId) : d.bookId
            const targetDrawingId = (typeof activeDb.remapPdfDrawingId === 'function')
                ? activeDb.remapPdfDrawingId(d, targetBookId)
                : (typeof activeDb.buildPdfDrawingKey === 'function'
                    ? activeDb.buildPdfDrawingKey(targetBookId, d.pageIndex, d)
                    : (typeof db.buildPdfDrawingKey === 'function'
                        ? db.buildPdfDrawingKey(targetBookId, d.pageIndex, d)
                        : `${targetBookId}_page_${d.pageIndex}`))
            drawingsToPut.push({
                ...d,
                bookId: targetBookId,
                id: targetDrawingId
            })
        }
    }

    // 4f. Custom Lists
    const lists = backupData.customLists || backupData.readingLists
    if (Array.isArray(lists)) {
        for (const l of lists) {
            if (!l || !l.id) continue
            const remappedBookIds = Array.isArray(l.bookIds) 
                ? l.bookIds.map(bId => bookIdRemap.get(bId) || bId)
                : l.bookIds
            listsToPut.push({ ...l, bookIds: remappedBookIds })
        }
    }

    // 4g. Books
    if (Array.isArray(backupData.books)) {
        for (const b of backupData.books) {
            if (!b || !b.id) continue
            if (isTombstoned(b)) continue

            if (bookIdRemap.has(b.id)) {
                const mappedId = bookIdRemap.get(b.id)
                const existingTarget = existingBookMap.get(mappedId)
                if (existingTarget) {
                    let progress = existingTarget.progress
                    const existingProgTime = existingTarget.progress?.updatedAt || 0
                    const incomingProgTime = b.progress?.updatedAt || 0
                    if (incomingProgTime > existingProgTime) {
                        progress = b.progress
                    } else if (existingProgTime === 0 && incomingProgTime === 0) {
                        const exFrac = existingTarget.progress?.fraction || 0
                        const inFrac = b.progress?.fraction || 0
                        progress = inFrac > exFrac ? b.progress : existingTarget.progress
                    }

                    const totalReadingSeconds = Math.max(
                        existingTarget.totalReadingSeconds || 0,
                        b.totalReadingSeconds || 0
                    )

                    booksToPut.push({
                        ...b,
                        ...existingTarget,
                        id: mappedId,
                        title: existingTarget.title || b.title,
                        author: existingTarget.author || b.author,
                        progress: progress || existingTarget.progress || b.progress,
                        totalReadingSeconds,
                        updatedAt: Math.max(existingTarget.updatedAt || 0, b.updatedAt || 0),
                        hasLocalFile: existingTarget.hasLocalFile !== undefined ? existingTarget.hasLocalFile : false,
                        isCloudOnly: existingTarget.hasLocalFile ? false : true,
                        documentHash: existingTarget.documentHash || b.documentHash
                    })
                } else {
                    booksToPut.push({
                        ...b,
                        id: mappedId,
                        hasLocalFile: false,
                        isCloudOnly: true
                    })
                }
                continue
            }

            const existing = existingBookMap.get(b.id)
            if (existing) {
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

                booksToPut.push({
                    ...b,
                    ...existing,
                    title: existing.title || b.title,
                    author: existing.author || b.author,
                    progress: progress || existing.progress || b.progress,
                    totalReadingSeconds,
                    updatedAt: Math.max(existing.updatedAt || 0, b.updatedAt || 0),
                    hasLocalFile: existing.hasLocalFile !== undefined ? existing.hasLocalFile : b.hasLocalFile,
                    isCloudOnly: existing.hasLocalFile ? false : (existing.isCloudOnly !== undefined ? existing.isCloudOnly : b.isCloudOnly),
                    nativeSnapshotPath: existing.nativeSnapshotPath || b.nativeSnapshotPath,
                    blobRevision: existing.blobRevision || b.blobRevision,
                    documentHash: existing.documentHash || b.documentHash,
                    coverBlob: existing.coverBlob || b.coverBlob
                })
            } else {
                booksToPut.push({
                    ...b,
                    hasLocalFile: false,
                    isCloudOnly: true
                })
            }
        }
    }

    // 4h. Settings
    if (backupData.readerSettings && typeof backupData.readerSettings === 'object') {
        settingsToPut.push({ key: 'readerSettings', value: backupData.readerSettings })
    }
    if (backupData.manualTocs && typeof backupData.manualTocs === 'object') {
        for (const [origBookId, toc] of Object.entries(backupData.manualTocs)) {
            if (Array.isArray(toc) && toc.length > 0) {
                const targetBookId = bookIdRemap.get(origBookId) || origBookId
                settingsToPut.push({ key: `linden_manual_toc_${targetBookId}`, value: toc })
            }
        }
    }

    // 4i. Deleted records (tombstones)
    const deletedRecordsToPut = []
    if (Array.isArray(backupData.deletedRecords)) {
        for (const dr of backupData.deletedRecords) {
            if (!dr || !dr.id) continue
            deletedRecordsToPut.push(dr)
        }
    }

    const restorePlan = {
        booksToPut,
        highlightsToPut,
        bookmarksToPut,
        sessionsToPut,
        translationsToPut,
        drawingsToPut,
        listsToPut,
        settingsToPut,
        deletedRecordsToPut
    }

    // 5. Changelog for out-of-transaction settings (localStorage)
    const localStorageLog = new Map()
    const localStorageEntries = []
    const recordLocalStorage = (k, afterVal = undefined) => {
        if (typeof localStorage !== 'undefined') {
            if (!localStorageLog.has(k)) {
                const prev = localStorage.getItem(k)
                localStorageLog.set(k, { beforeValue: prev, afterValue: afterVal })
                localStorageEntries.push({
                    key: k,
                    hadBefore: prev !== null && prev !== undefined,
                    beforeValue: prev,
                    afterValue: afterVal
                })
            } else if (afterVal !== undefined) {
                const existing = localStorageLog.get(k)
                existing.afterValue = afterVal
                const entry = localStorageEntries.find(e => e.key === k)
                if (entry) entry.afterValue = afterVal
            }
        }
    }

    if (typeof localStorage !== 'undefined') {
        if (Array.isArray(backupData.readingPresets)) recordLocalStorage('linden_reading_presets_v1', JSON.stringify(backupData.readingPresets))
        if (backupData.customPalette) recordLocalStorage('linden_custom_semantic_palette_v1', JSON.stringify(backupData.customPalette))
        if (backupData.userName) recordLocalStorage('linden_user_name', backupData.userName)
        if (backupData.config && typeof backupData.config === 'object') recordLocalStorage(STORAGE_KEY_CONFIG, JSON.stringify(sanitizeAdvancedSettings(backupData.config)))
        if (backupData.bookSettingsOverrides && typeof backupData.bookSettingsOverrides === 'object') {
            for (const [bId, ov] of Object.entries(backupData.bookSettingsOverrides)) {
                const targetId = bookIdRemap.get(bId) || bId
                if (targetId && ov && typeof ov === 'object') {
                    recordLocalStorage(`linden_book_settings_${targetId}`, JSON.stringify(ov))
                }
            }
        }
    }

    const toolEntries = restoredPdfPreferenceEntries(backupData.pdfToolPreferences, bookIdRemap,
        new Set([...existingBooks, ...booksToPut].filter(b => !tombstonedBookIds.has(b.id)).map(b => b.id)))
    for (const [key, value] of toolEntries) recordLocalStorage(key, value)

    restorePlan.operationId = operationId
    restorePlan.persistJournal = true
    restorePlan.localStorageEntries = localStorageEntries

    let applyRes = null
    try {
        applyRes = await activeDb.applyRestorePlan(restorePlan)

        // 6. Apply out-of-transaction localStorage items
        if (typeof localStorage !== 'undefined') {
            if (Array.isArray(backupData.readingPresets)) {
                recordLocalStorage('linden_reading_presets_v1')
                localStorage.setItem('linden_reading_presets_v1', JSON.stringify(backupData.readingPresets))
                if (typeof window !== 'undefined' && window.readingPresetsManager?.load) {
                    window.readingPresetsManager.load()
                }
            }
            if (backupData.customPalette) {
                recordLocalStorage('linden_custom_semantic_palette_v1')
                localStorage.setItem('linden_custom_semantic_palette_v1', JSON.stringify(backupData.customPalette))
                if (typeof window !== 'undefined' && window.themeCustomizer?.load) {
                    window.themeCustomizer.load()
                }
            }
            if (backupData.userName) {
                recordLocalStorage('linden_user_name')
                localStorage.setItem('linden_user_name', backupData.userName)
            }
            if (backupData.bookSettingsOverrides && typeof backupData.bookSettingsOverrides === 'object') {
                for (const [bId, ov] of Object.entries(backupData.bookSettingsOverrides)) {
                    const targetId = bookIdRemap.get(bId) || bId
                    if (targetId && ov && typeof ov === 'object') {
                        const k = `linden_book_settings_${targetId}`
                        recordLocalStorage(k)
                        localStorage.setItem(k, JSON.stringify(ov))
                    }
                }
            }
        }

        for (const [key, value] of toolEntries) localStorage.setItem(key, value)

        // 7. Advanced Config
        if (backupData.config && typeof backupData.config === 'object') {
            await applyConfig(sanitizeAdvancedSettings(backupData.config))
        }

        // 8. Commit durable restore journal
        const commitFn = typeof activeDb.commitRestoreOperation === 'function'
            ? activeDb.commitRestoreOperation
            : (typeof db.commitRestoreOperation === 'function' ? db.commitRestoreOperation : null)
        if (commitFn) {
            const commitRes = await commitFn(applyRes?.operationId || operationId, activeDb !== db ? activeDb : null, { retainLock: true })
            if (commitRes === false) throw new Error(t('backupError.commitFailed'))
        }
    } catch (restoreErr) {
        // Selective Journal Rollback: revert ONLY keys modified by this restore operation
        // whose revision still matches afterRevision (never overwriting concurrent user edits!)
        try {
            const rollbackFn = typeof activeDb.rollbackRestoreOperation === 'function'
                ? activeDb.rollbackRestoreOperation
                : (typeof db.rollbackRestoreOperation === 'function' ? db.rollbackRestoreOperation : null)

            if (applyRes && rollbackFn) {
                await rollbackFn(applyRes.operationId || operationId, applyRes.journal || null, null, { retainLock: true })
            }
        } catch (_) {}

        // Revert localStorage changes from log ONLY if current value still matches afterValue
        if (typeof localStorage !== 'undefined') {
            for (const [k, info] of localStorageLog.entries()) {
                try {
                    const currentVal = localStorage.getItem(k)
                    const expectedAfter = typeof info === 'object' && info !== null ? info.afterValue : undefined
                    const prevVal = typeof info === 'object' && info !== null ? info.beforeValue : info
                    if (expectedAfter !== undefined && currentVal !== expectedAfter) {
                        // User or another task modified this key after restore; preserve newer settings!
                        continue
                    }
                    if (prevVal === null || prevVal === undefined) {
                        localStorage.removeItem(k)
                    } else {
                        localStorage.setItem(k, prevVal)
                    }
                } catch (_) {}
            }
        }
        throw restoreErr
    }

    const restoredBooks = booksToPut.length
    const restoredHighlights = highlightsToPut.length
    const restoredSessions = sessionsToPut.length
    const restoredBookmarks = bookmarksToPut.length
    const restoredDrawings = drawingsToPut.length
    const restoredLists = listsToPut.length

    return { restoredBooks, restoredSessions, restoredHighlights, restoredBookmarks, restoredDrawings, restoredLists }
}
