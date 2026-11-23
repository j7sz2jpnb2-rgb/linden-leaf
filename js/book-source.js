import { contentIdentityRelation, findSameContentBook, identityHashes, isSameBookPath } from './document-identity.js'

// Owns local PDF preparation and registration. The caller only handles reader/window UI.
export async function openLocalPdfSource(file, { db, bridge }) {
    const books = await db.getAllBooks()
    const candidates = books.filter(b => b.format === 'pdf' && isSameBookPath(b, file.filePath))
    let descriptor = null, staged = null, committed = false
    try {
        if (candidates.length) {
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
            size: snapshot.size, fileSize: snapshot.size, hasLocalFile: true, isOffline: false, updatedAt: now
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
