import { contentIdentityRelation, findSameContentBook, identityHashes, isSameBookPath } from './document-identity.js'

function sameFileIdentity(saved, current) {
    if (!saved || !current) return false
    if (!saved.fileId || !current.fileId || saved.fileId !== current.fileId) return false
    if (saved.volumeId && current.volumeId && saved.volumeId !== current.volumeId) return false
    return Number(saved.size) > 0 && Number(saved.size) === Number(current.size) &&
        Number(saved.mtimeMs) > 0 && Number(saved.mtimeMs) === Number(current.mtimeMs)
}

// Owns local PDF preparation and registration. The caller only handles reader/window UI.
export async function openLocalPdfSource(file, { db, bridge }) {
    const books = await db.getAllBooks()
    const candidates = books.filter(b => b.format === 'pdf' && isSameBookPath(b, file.filePath))
    let descriptor = null, staged = null, committed = false, currentIdentity = null
    try {
        if (candidates.length) {
            if (typeof bridge.getNativeFileIdentity === 'function') {
                currentIdentity = await bridge.getNativeFileIdentity(file.filePath)
                for (const book of candidates.filter(b => sameFileIdentity(b.fileIdentity, currentIdentity))) {
                    const size = book.nativeSnapshotSize || book.size || 0
                    if (book.nativeSnapshotPath && book.documentHash &&
                        await bridge.validatePdfSnapshot(book.nativeSnapshotPath, size)) {
                        return {
                            book,
                            descriptor: {
                                path: book.nativeSnapshotPath,
                                size,
                                revision: book.blobRevision,
                                documentHash: book.documentHash,
                                documentHashAliases: book.documentHashAliases || [],
                            },
                        }
                    }
                }
            }
            const currentHash = await bridge.computeNativeFileHash(file.filePath)
            for (const book of candidates.filter(b => contentIdentityRelation(b, { documentHash: currentHash }) === 'same')) {
                const size = book.nativeSnapshotSize || book.size || 0
                if (book.nativeSnapshotPath && await bridge.validatePdfSnapshot(book.nativeSnapshotPath, size)) {
                    descriptor = { path: book.nativeSnapshotPath, size, revision: book.blobRevision,
                        documentHash: currentHash, documentHashAliases: book.documentHashAliases || [] }
                    break
                }
            }
        }
        if (!descriptor) descriptor = staged = await bridge.stagePdfSource(file.filePath)
        if (!descriptor) return null // Platform has no native PDF backend; caller uses the normal import queue.
        if (!currentIdentity && typeof bridge.getNativeFileIdentity === 'function') {
            currentIdentity = await bridge.getNativeFileIdentity(file.filePath)
        }
        const identity = { ...descriptor, format: 'pdf', filename: file.filename, nativePath: file.filePath }
        const existing = await findSameContentBook(books, identity, db.getBookFileSnapshot)
        let snapshot = descriptor
        if (existing?.nativeSnapshotPath && existing.nativeSnapshotPath !== descriptor.path &&
            await bridge.validatePdfSnapshot(existing.nativeSnapshotPath, descriptor.size)) {
            snapshot = { ...descriptor, path: existing.nativeSnapshotPath, revision: existing.blobRevision }
            if (staged) { await bridge.reclaimSnapshot(staged.path); staged = null }
        }
        const now = Date.now()
        const book = existing ? {
            ...existing,
            // Keep the historical primary hash for existing annotation bindings; add the verified canonical ID.
            documentHashAliases: [...new Set([...identityHashes(existing), ...identityHashes(descriptor)])].filter(h => h !== existing.documentHash)
        } : {
            id: 'ext_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
            title: file.filename.replace(/\.[^/.]+$/, ''), format: 'pdf', isRecentOnly: true,
            documentHash: descriptor.documentHash, addedAt: now, progress: { fraction: 0, updatedAt: now }
        }
        Object.assign(book, {
            nativePath: file.filePath, filePath: file.filePath,
            nativeSnapshotPath: snapshot.path, nativeSnapshotSize: snapshot.size,
            nativeSnapshotOnly: true, blobRevision: snapshot.revision || book.blobRevision,
            size: snapshot.size, fileSize: snapshot.size, hasLocalFile: true, isOffline: false, updatedAt: now,
            ...(currentIdentity?.fileId ? { fileIdentity: currentIdentity } : {})
        })
        await db.saveBook(book, { bindNativeSnapshot: true })
        committed = true
        return { book, descriptor: snapshot }
    } finally {
        if (staged && !committed) await bridge.reclaimSnapshot(staged.path)
    }
}

// Open an existing identical book without transferring its source into the WebView.
export async function openLocalEpubSource(file, { db, bridge, queue }) {
    const candidates = (await db.getAllBooks()).filter(book =>
        book.format === 'epub' && !book.isCloudOnly && isSameBookPath(book, file.filePath))
    if (candidates.length) {
        const documentHash = await bridge.computeNativeFileHash(file.filePath)
        for (const book of candidates) {
            if (contentIdentityRelation(book, { documentHash }) !== 'same') continue
            const snapshot = await db.getBookFileSnapshot(book.id)
            if (snapshot?.blob && contentIdentityRelation(snapshot, { documentHash }) === 'same' &&
                (!snapshot.nativeSnapshotOnly ||
                    await bridge.validateNativeSnapshot(snapshot.nativeSnapshotPath, snapshot.nativeSnapshotSize))) {
                return { bookId: book.id, epub: null }
            }
        }
    }
    let epub = null
    const [job] = await queue.enqueueAndWait([{
        filePath: file.filePath, filename: file.filename, isRecentOnly: true,
        receiveParsedEpub(book, documentHash) { epub = { book, documentHash } }
    }])
    if (job?.status !== 'succeeded') throw new Error(job?.error || 'Failed to import EPUB')
    return { bookId: job.bookId, epub }
}

// Fast zero-copy PDF open path for Windows desktop cold starts / Finder/Explorer launches.
// Modes:
// - 'direct'    (default): open original path read-only immediately, defer hash/reconcile to background
// - 'ephemeral' : open original path read-only without persisting a library card until pinned
// - 'snapshot'  : delegate to classic synchronous snapshot staging (openLocalPdfSource)
export async function openLocalPdfDirectFirst(file, { db, bridge, mode = 'direct' }) {
    if (!file || !file.filePath) return null
    if (mode === 'snapshot' || typeof bridge?.authorizeDirectPdfPath !== 'function') {
        return openLocalPdfSource(file, { db, bridge })
    }

    const authOk = await bridge.authorizeDirectPdfPath(file.filePath).catch(() => false)
    if (!authOk) {
        return openLocalPdfSource(file, { db, bridge })
    }

    let currentIdentity = null
    if (typeof bridge.getNativeFileIdentity === 'function') {
        currentIdentity = await bridge.getNativeFileIdentity(file.filePath).catch(() => null)
    }

    const books = await db.getAllBooks()
    const pathMatches = books.filter(b => b.format === 'pdf' && isSameBookPath(b, file.filePath))
    let existing = null
    if (currentIdentity?.fileId) {
        existing = pathMatches.find(b => sameFileIdentity(b.fileIdentity, currentIdentity)) || null
    }
    if (!existing && pathMatches.length) {
        existing = pathMatches.find(b =>
            !b.fileIdentity ||
            !currentIdentity?.size ||
            !b.size ||
            b.size === currentIdentity.size
        ) || pathMatches[0]
    }

    const now = Date.now()
    if (existing) {
        const openPath = (existing.nativeSnapshotPath && await bridge.validatePdfSnapshot?.(existing.nativeSnapshotPath, existing.nativeSnapshotSize || existing.size || 0).catch(() => false))
            ? existing.nativeSnapshotPath
            : file.filePath
        const isDirect = openPath === file.filePath
        const bookUpdates = {
            ...existing,
            nativePath: file.filePath,
            filePath: file.filePath,
            hasLocalFile: true,
            isOffline: false,
            directReadOnly: isDirect,
            updatedAt: now,
            ...(currentIdentity?.fileId ? { fileIdentity: currentIdentity } : {}),
            ...(currentIdentity?.size ? { size: currentIdentity.size, fileSize: currentIdentity.size } : {})
        }
        await db.saveBook(bookUpdates, { bindNativeSnapshot: !isDirect })
        return {
            book: bookUpdates,
            descriptor: {
                path: openPath,
                size: currentIdentity?.size || existing.size || existing.nativeSnapshotSize || file.size || 0,
                revision: existing.blobRevision || 1,
                documentHash: existing.documentHash || null,
                documentHashAliases: existing.documentHashAliases || [],
                directReadOnly: isDirect,
                ephemeral: false
            },
            ephemeral: false,
            needsBackgroundReconcile: !existing.documentHash || (mode === 'snapshot' && isDirect)
        }
    }

    const rawTitle = (file.filename || file.filePath.split(/[\\/]/).pop() || 'PDF').replace(/\.[^/.]+$/, '')
    const size = currentIdentity?.size || file.size || 0

    if (mode === 'ephemeral') {
        const tempId = 'ephem_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7)
        const ephemeralBook = {
            id: tempId,
            title: rawTitle,
            format: 'pdf',
            isEphemeral: true,
            isRecentOnly: true,
            nativePath: file.filePath,
            filePath: file.filePath,
            directReadOnly: true,
            size,
            fileSize: size,
            hasLocalFile: true,
            isOffline: false,
            addedAt: now,
            updatedAt: now,
            progress: { fraction: 0, updatedAt: now },
            ...(currentIdentity?.fileId ? { fileIdentity: currentIdentity } : {})
        }
        return {
            book: ephemeralBook,
            descriptor: {
                path: file.filePath,
                size,
                revision: 1,
                documentHash: null,
                documentHashAliases: [],
                directReadOnly: true,
                ephemeral: true
            },
            ephemeral: true,
            needsBackgroundReconcile: false
        }
    }

    const newBook = {
        id: 'ext_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        title: rawTitle,
        format: 'pdf',
        isRecentOnly: true,
        nativePath: file.filePath,
        filePath: file.filePath,
        directReadOnly: true,
        documentHash: null,
        size,
        fileSize: size,
        hasLocalFile: true,
        isOffline: false,
        addedAt: now,
        updatedAt: now,
        progress: { fraction: 0, updatedAt: now },
        ...(currentIdentity?.fileId ? { fileIdentity: currentIdentity } : {})
    }
    await db.saveBook(newBook, { bindNativeSnapshot: false })

    return {
        book: newBook,
        descriptor: {
            path: file.filePath,
            size,
            revision: 1,
            documentHash: null,
            documentHashAliases: [],
            directReadOnly: true,
            ephemeral: false
        },
        ephemeral: false,
        needsBackgroundReconcile: true
    }
}

// Compute full content hash + merge matching prior library record (notes/aliases/progress) in background
// after the first page has already rendered via openLocalPdfDirectFirst.
export async function reconcileDirectPdfInBackground({ file, book, db, bridge, pageCount = 0, onReconciled = null }) {
    if (!file?.filePath || !book?.id || book.isEphemeral) return null
    if (typeof bridge?.computeNativeFileHash !== 'function') return null

    const documentHash = await bridge.computeNativeFileHash(file.filePath).catch(() => null)
    if (!documentHash) return null

    const currentIdentity = typeof bridge.getNativeFileIdentity === 'function'
        ? await bridge.getNativeFileIdentity(file.filePath).catch(() => null)
        : null
    const books = await db.getAllBooks()
    const matched = await findSameContentBook(
        books.filter(b => String(b.id) !== String(book.id)),
        {
            format: 'pdf',
            filename: file.filename,
            nativePath: file.filePath,
            documentHash,
            size: currentIdentity?.size || book.size || 0
        },
        db.getBookFileSnapshot
    )

    const updatedBook = {
        ...(await db.getBook(book.id) || book),
        documentHash,
        ...(currentIdentity?.fileId ? { fileIdentity: currentIdentity } : {}),
        ...(currentIdentity?.size ? { size: currentIdentity.size, fileSize: currentIdentity.size } : {}),
        updatedAt: Date.now()
    }
    if (matched) {
        updatedBook.documentHashAliases = [...new Set([
            ...(Array.isArray(updatedBook.documentHashAliases) ? updatedBook.documentHashAliases : []),
            ...identityHashes(matched)
        ])].filter(h => h !== documentHash)
    }
    await db.saveBook(updatedBook, { bindNativeSnapshot: false })

    let relinkStats = null
    if (matched && typeof db.relinkBookAnnotations === 'function') {
        relinkStats = await db.relinkBookAnnotations(updatedBook.id, matched.id, { nowMs: Date.now() }).catch(() => null)
    }

    if (typeof bridge.updatePdfQuickIndex === 'function') {
        bridge.updatePdfQuickIndex({
            path: file.filePath,
            bookId: updatedBook.id,
            pageCount: pageCount || 0,
            lastPage: Math.max(0, (updatedBook.progress?.page || 1) - 1),
            fileSize: updatedBook.size || 0,
            mtimeMs: Number(currentIdentity?.modifiedMs || 0)
        }).catch(() => {})
    }

    const result = {
        book: await db.getBook(updatedBook.id) || updatedBook,
        matchedBook: matched || null,
        relinkStats,
        documentHash
    }
    if (typeof onReconciled === 'function') {
        try { onReconciled(result) } catch (_) {}
    }
    return result
}
