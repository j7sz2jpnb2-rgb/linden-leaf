// js/syncEngine.js - Multi-device WebDAV & Nutstore Sync and Conflict Resolution Engine
import * as db from './db.js'

let _activeSyncPromise = null

/**
 * 1. Export local sync payload from IndexedDB
 */
export const exportSyncPayload = async () => {
    const allBooks = await db.getAllBooks()
    const allLists = await db.getAllCustomLists()
    const allHighlights = await db.getAllHighlights()
    const allBookmarks = await db.getAllBookmarks()
    const allSessions = await db.getAllReadingSessions()
    const deletedRecords = await db.getAllDeletedRecords()
    const allPdfDrawings = (typeof db.getAllPdfDrawings === 'function') ? (await db.getAllPdfDrawings()) : []
    const settings = (await db.getSetting('readerSettings')) || (await db.getSetting('reader_settings')) || {}

    const booksMeta = allBooks.map(b => ({
        id: b.id,
        stableKey: b.stableKey || (b.identifier || `${b.title || ''}_${b.size || 0}_${b.format || ''}`.replace(/\s+/g, '').toLowerCase()),
        identifier: b.identifier || null,
        title: b.title,
        author: b.author,
        format: b.format,
        size: b.size,
        isFavorite: !!b.isFavorite,
        favoriteUpdatedAt: b.favoriteUpdatedAt || b.updatedAt || 0,
        customListIds: b.customListIds || [],
        listsUpdatedAt: b.listsUpdatedAt || b.updatedAt || 0,
        progress: b.progress || { fraction: 0 },
        lastReadAt: b.lastReadAt || 0,
        totalReadingSeconds: b.totalReadingSeconds || 0,
        addedAt: b.addedAt || Date.now(),
        updatedAt: b.updatedAt || b.lastReadAt || b.addedAt || Date.now()
    }))

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

    // A. Merge Tombstones (Deleted Records with plural/singular normalization)
    const normalizeTombType = t => {
        if (!t) return 'unknown'
        if (t === 'bookmarks') return 'bookmark'
        if (t === 'highlights') return 'highlight'
        if (t === 'books') return 'book'
        if (t === 'pdf_drawings' || t === 'pdfDrawing') return 'pdfDrawing'
        return t
    }
    const tombstoneMap = new Map()
    ;(remotePayload.deletedRecords || []).forEach(t => {
        if (t && t.id) {
            const normType = normalizeTombType(t.type)
            const key = `${normType}:${t.id}`
            tombstoneMap.set(key, { ...t, type: normType, deletedAt: clampTime(t.deletedAt) })
        }
    })
    ;(localPayload.deletedRecords || []).forEach(t => {
        if (!t || !t.id) return
        const normType = normalizeTombType(t.type)
        const key = `${normType}:${t.id}`
        const localDel = clampTime(t.deletedAt)
        if (!tombstoneMap.has(key)) {
            tombstoneMap.set(key, { ...t, type: normType, deletedAt: localDel })
        } else {
            const remoteT = tombstoneMap.get(key)
            const newer = localDel >= (remoteT.deletedAt || 0) ? { ...t, type: normType, deletedAt: localDel } : remoteT
            tombstoneMap.set(key, newer)
        }
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

        let localBook = bookMap.get(remoteBook.id)
        if (!localBook && remoteBook.stableKey) {
            localBook = Array.from(bookMap.values()).find(b => b.isLocal && b.stableKey && b.stableKey === remoteBook.stableKey)
        }

        if (!localBook) {
            bookMap.set(remoteBook.id, {
                ...remoteBook,
                lastReadAt: rLastRead,
                updatedAt: rUpdated,
                favoriteUpdatedAt: rFavUpdated,
                listsUpdatedAt: rListsUpdated,
                isRemoteOnly: true
            })
            stats.booksUpdated++
        } else {
            const localTime = localBook.lastReadAt || localBook.updatedAt || 0
            const remoteTime = rLastRead || rUpdated || 0

            // Progress: LWW (whichever was read more recently wins; if timestamps tie, higher progress wins)
            const isRemoteReadNewer = remoteTime > localTime || (remoteTime === localTime && (remoteBook.progress?.fraction || 0) > (localBook.progress?.fraction || 0))
            const newestProgress = isRemoteReadNewer ? (remoteBook.progress || localBook.progress) : (localBook.progress || remoteBook.progress)
            const newestLastReadAt = Math.max(localTime, remoteTime)

            // Total Reading Seconds: max
            const mergedTotalSeconds = Math.max(localBook.totalReadingSeconds || 0, remoteBook.totalReadingSeconds || 0)

            // Custom lists & Favorites: LWW based on field timestamp
            const isRemoteNewer = remoteTime > localTime
            const isFav = (rFavUpdated || localBook.favoriteUpdatedAt)
                ? (rFavUpdated >= (localBook.favoriteUpdatedAt || 0) ? remoteBook.isFavorite : localBook.isFavorite)
                : (isRemoteNewer ? remoteBook.isFavorite : localBook.isFavorite)

            const mergedLists = (rListsUpdated || localBook.listsUpdatedAt)
                ? (rListsUpdated >= (localBook.listsUpdatedAt || 0) ? (remoteBook.customListIds || []) : (localBook.customListIds || []))
                : (isRemoteNewer ? (remoteBook.customListIds || []) : (localBook.customListIds || []))

            if (remoteTime > localTime || remoteBook.totalReadingSeconds !== localBook.totalReadingSeconds) {
                stats.booksUpdated++
            }

            bookMap.set(localBook.id, {
                ...localBook,
                stableKey: localBook.stableKey || remoteBook.stableKey,
                progress: newestProgress,
                lastReadAt: newestLastReadAt,
                totalReadingSeconds: mergedTotalSeconds,
                customListIds: mergedLists,
                isFavorite: !!isFav,
                favoriteUpdatedAt: Math.max(localBook.favoriteUpdatedAt || 0, rFavUpdated),
                listsUpdatedAt: Math.max(localBook.listsUpdatedAt || 0, rListsUpdated),
                updatedAt: Math.max(localBook.updatedAt || 0, rUpdated)
            })
        }
    })
    
    // Filter books by book tombstones
    const mergedBooksMeta = Array.from(bookMap.values()).filter(b => {
        const tombKey = `book:${b.id}`
        if (tombstoneMap.has(tombKey)) {
            const tomb = tombstoneMap.get(tombKey)
            if ((tomb.deletedAt || 0) >= (b.updatedAt || b.addedAt || 0)) return false
        }
        return true
    })

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
            let targetId = d.id
            let targetBookId = d.bookId
            if (d.bookId && bookIdRemap.has(d.bookId)) {
                targetBookId = bookIdRemap.get(d.bookId)
                if (d.id.includes('_page_')) {
                    const parts = d.id.split('_page_')
                    targetId = `${targetBookId}_page_${parts[1]}`
                }
            }
            drawingMap.set(targetId, { ...d, id: targetId, bookId: targetBookId, updatedAt: clampTime(d.updatedAt) })
        }
    })
    ;(localPayload.pdfDrawings || []).forEach(d => {
        if (!d || !d.id) return
        const localUpdated = clampTime(d.updatedAt)
        if (!drawingMap.has(d.id)) {
            drawingMap.set(d.id, { ...d, updatedAt: localUpdated })
        } else {
            const remoteD = drawingMap.get(d.id)
            if (localUpdated >= (remoteD.updatedAt || 0)) {
                drawingMap.set(d.id, { ...d, updatedAt: localUpdated })
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
    // A. Apply Deletion Tombstones
    if (Array.isArray(mergedPayload.deletedRecords)) {
        for (const tomb of mergedPayload.deletedRecords) {
            if (tomb && tomb.id) {
                const delTime = tomb.deletedAt || Date.now()
                if (tomb.type === 'book' || tomb.type === 'books') {
                    await db.deleteBook(tomb.id, false, delTime)
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
    if (Array.isArray(mergedPayload.booksMeta)) {
        const allLocalBooks = await db.getAllBooks()
        for (const meta of mergedPayload.booksMeta) {
            let localBook = allLocalBooks.find(b => b.id === meta.id)
            if (!localBook && meta.stableKey) {
                localBook = allLocalBooks.find(b => (b.stableKey && b.stableKey === meta.stableKey) || (b.title === meta.title && b.size === meta.size))
            }
            if (localBook && localBook.id !== meta.id) {
                bookIdRemap.set(meta.id, localBook.id)
            }
            if (localBook) {
                let changed = false
                const isRemoteReadNewer = (meta.lastReadAt || 0) > (localBook.lastReadAt || 0) ||
                    (meta.lastReadAt === localBook.lastReadAt && (meta.progress?.fraction || 0) > (localBook.progress?.fraction || 0))
                
                if (meta.progress && isRemoteReadNewer) {
                    localBook.progress = meta.progress
                    localBook.lastReadAt = meta.lastReadAt || localBook.lastReadAt
                    changed = true
                }
                if (meta.totalReadingSeconds != null && meta.totalReadingSeconds > (localBook.totalReadingSeconds || 0)) {
                    localBook.totalReadingSeconds = meta.totalReadingSeconds
                    changed = true
                }
                if (meta.isFavorite !== localBook.isFavorite) {
                    localBook.isFavorite = meta.isFavorite
                    localBook.favoriteUpdatedAt = meta.favoriteUpdatedAt || localBook.favoriteUpdatedAt || Date.now()
                    changed = true
                }
                if (Array.isArray(meta.customListIds)) {
                    localBook.customListIds = meta.customListIds
                    localBook.listsUpdatedAt = meta.listsUpdatedAt || localBook.listsUpdatedAt || Date.now()
                    changed = true
                }
                if (changed) {
                    localBook.updatedAt = meta.updatedAt || Date.now()
                    localBook._preserveUpdatedAt = true
                    await db.saveBook(localBook)
                }
            }
        }
    }

    // D. Apply Highlights (with BookId Remapping)
    if (Array.isArray(mergedPayload.highlights)) {
        for (const hl of mergedPayload.highlights) {
            if (hl && hl.bookId && bookIdRemap.has(hl.bookId)) {
                hl.bookId = bookIdRemap.get(hl.bookId)
            }
            await db.saveHighlight(hl)
        }
    }

    // E. Apply Bookmarks (with BookId Remapping)
    if (Array.isArray(mergedPayload.bookmarks)) {
        for (const bm of mergedPayload.bookmarks) {
            if (bm && bm.bookId && bookIdRemap.has(bm.bookId)) {
                bm.bookId = bookIdRemap.get(bm.bookId)
            }
            await db.saveBookmark(bm)
        }
    }

    // F. Apply Reading Sessions (with BookId Remapping, pass false to prevent duplicate duration addition to books)
    if (Array.isArray(mergedPayload.readingSessions)) {
        for (const sess of mergedPayload.readingSessions) {
            if (sess && sess.bookId && bookIdRemap.has(sess.bookId)) {
                sess.bookId = bookIdRemap.get(sess.bookId)
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
                if (d && d.bookId && bookIdRemap.has(d.bookId)) {
                    const targetBookId = bookIdRemap.get(d.bookId)
                    d.bookId = targetBookId
                    if (d.id && d.id.includes('_page_')) {
                        const parts = d.id.split('_page_')
                        d.id = `${targetBookId}_page_${parts[1]}`
                    }
                }
                store.put(d)
            })
            await new Promise((res) => {
                tx.oncomplete = res
                tx.onerror = res
            })
        }
    }

    return true
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
        await applyMergedPayload(merged)

        onProgress('同步完成！', 'done')
        return { success: true, stats, timestamp: Date.now() }
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
