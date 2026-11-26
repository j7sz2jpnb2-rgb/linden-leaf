import { computeContentHash, findSameContentBook, contentIdentityRelation } from './document-identity.js'
// js/import-queue.js - Universal, Resilient Import Queue for Linden Leaf
// Features: bounded concurrency, non-blocking incremental shelf display,
// independent low-priority cover generation, cancellability, retry, and crash-resilient cleanup.

import * as db from './db.js'
import { normalizeCoverBlob } from './pdf-cover.js'
import { platformBridge } from './platformBridge.js'
import { extractPdfCover } from './pdf-cover.js'
import { resolveBookTitle } from './book-title.js'
import { SUPPORTED_IMPORT_FORMATS } from './book-metadata.js'
import { t } from './i18n.js'

export const findDuplicateBook = (existingBooks, { format, fileName = '', fileObj = {}, metadata = {}, computedStableKey = '' }) => {
    if (!Array.isArray(existingBooks) || existingBooks.length === 0) return null
    const GENERIC_TITLES = ['未命名', '未命名书籍', '未命名电子书', 'pdf 文档', 'pdf document', 'document', 'untitled', 'untitled e-book', 'untitled book', '新文件', '文档']
    const rawTitle = (metadata.title || '').trim().toLowerCase()
    const rawBase = fileName.replace(/\.[^/.]+$/, '').trim().toLowerCase()
    const isGenericTitle = !rawTitle || GENERIC_TITLES.includes(rawTitle) || GENERIC_TITLES.includes(rawBase)

    const metaAuthor = (metadata.author || '').trim().toLowerCase()
    const isKnownAuthor = metaAuthor && !metaAuthor.includes('未知') && !metaAuthor.includes('unknown')

    return existingBooks.find(b => {
        if (b.format !== format) return false

        const bAuthor = (b.author || '').trim().toLowerCase()
        const isKnownBAuthor = bAuthor && !bAuthor.includes('未知') && !bAuthor.includes('unknown')

        // If both books have distinct, known authors, they are definitely different books!
        if (isKnownAuthor && isKnownBAuthor && bAuthor !== metaAuthor) {
            return false
        }

        // Different bytes: must NOT silently replace even if same identifier or title (LL-01)
        if (b.size && fileObj.size && b.size !== fileObj.size) {
            return false
        }

        // Strict stableKey / identifier match proves duplicate identity when authors and bytes are compatible
        if (b.stableKey && computedStableKey && b.stableKey === computedStableKey) return true
        if (metadata.identifier && b.identifier && metadata.identifier === b.identifier) return true

        // Generic title without stableKey or identifier match must not match by fuzzy title alone
        if (isGenericTitle) {
            return Boolean(b.size && fileObj.size && b.size === fileObj.size &&
                           b.filename && b.filename.toLowerCase() === fileName.toLowerCase())
        }

        const bTitle = (b.title || '').trim().toLowerCase()
        const titleMatches = bTitle === rawTitle || bTitle === rawBase
        if (!titleMatches) return false

        if (b.size && fileObj.size && b.size === fileObj.size) return true
        if (isKnownAuthor && bAuthor && bAuthor === metaAuthor) return true
        if (b.filename && b.filename.toLowerCase() === fileName.toLowerCase()) return true
        return false
    }) || null
}

export class ImportQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 2
        this.coverMaxConcurrent = options.coverMaxConcurrent || 1
        this.onBookSaved = options.onBookSaved || (() => {})
        this.onProgress = options.onProgress || (() => {})
        this.onJobChange = options.onJobChange || (() => {})
        this.onBatchComplete = options.onBatchComplete || (() => {})

        this.jobs = new Map() // jobId -> Job
        this._activeImportCount = 0
        this._activeCoverCount = 0
        this._coverQueue = [] // Array of { bookId, format, snapshotPath }
        this._shelfRefreshTimer = null
        this._pendingShelfRefreshBooks = new Set()
        this._commitTail = Promise.resolve()
        this._isPaused = false
    }

    /**
     * Configure runtime resource budget (concurrency, low memory mode)
     * @param {object} [budget]
     * @param {number} [budget.maxConcurrent]
     * @param {number} [budget.coverMaxConcurrent]
     * @param {boolean} [budget.isLowMemoryDevice]
     */
    setResourceBudget(budget = {}) {
        if (typeof budget.maxConcurrent === 'number' && budget.maxConcurrent > 0) {
            this.maxConcurrent = budget.maxConcurrent
        }
        if (typeof budget.coverMaxConcurrent === 'number' && budget.coverMaxConcurrent > 0) {
            this.coverMaxConcurrent = budget.coverMaxConcurrent
        }
        if (budget.isLowMemoryDevice) {
            this.maxConcurrent = 1
            this.coverMaxConcurrent = 1
        }
    }

    get isBusy() {
        return this._activeImportCount > 0 || this._activeCoverCount > 0 || Array.from(this.jobs.values()).some(j => j.status === 'running' || j.status === 'queued')
    }

    /**
     * Add files to the import queue
     * @param {Array<File | { filePath: string, filename: string, buffer?: ArrayBuffer }>} items
     * @returns {Array<string>} List of assigned job IDs
     */
    enqueue(items) {
        if (!items || !items.length) return []
        this._batchCompletedFired = false
        this._batchId = (this._batchId || 0) + 1
        const jobIds = []

        for (const item of items) {
            const filename = item.filename || item.name || (item.filePath ? item.filePath.split(/[\\/]/).pop() : t('book.defaultUntitled'))
            const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
            const job = {
                id: jobId,
                rawItem: item,
                filename,
                filePath: item.filePath || null,
                fileSize: item.size || 0,
                status: 'queued', // queued | running | cancelling | succeeded | failed | cancelled
                phase: 'pending', // pending | reading | parsing | saving | cover | done
                progressText: t('importQueue.progress.waiting'),
                bookId: null,
                error: null,
                errorType: null,
                durationMs: {},
                bytesProcessed: 0,
                attemptToken: 0,
                abortController: new AbortController()
            }
            this.jobs.set(jobId, job)
            jobIds.push(jobId)
            this._notifyJobChange(job)
        }

        this._notifyProgress()
        this._scheduleNext()
        return jobIds
    }

    /**
     * Enqueue items and await their terminal completion (succeeded, failed, or cancelled)
     * @param {Array<File | { filePath: string, filename: string }>} items
     * @returns {Promise<Array<object>>} Completed job objects
     */
    enqueueAndWait(items) {
        const ids = this.enqueue(items)
        if (!ids || ids.length === 0) return Promise.resolve([])
        return new Promise(resolve => {
            const check = () => {
                const finishedJobs = ids.map(id => this.jobs.get(id)).filter(Boolean)
                const allFinished = finishedJobs.length === ids.length && finishedJobs.every(j => ['succeeded', 'failed', 'cancelled'].includes(j.status))
                if (allFinished) {
                    this._waitCallbacks = (this._waitCallbacks || []).filter(cb => cb !== check)
                    resolve(finishedJobs)
                }
            }
            if (!this._waitCallbacks) this._waitCallbacks = []
            this._waitCallbacks.push(check)
            check()
        })
    }

    /**
     * Cancel a specific job with genuine cancellation semantics
     * @param {string} jobId
     */
    cancel(jobId) {
        const job = this.jobs.get(jobId)
        if (!job) return
        if (job.status === 'queued') {
            job.status = 'cancelled'
            job.phase = 'done'
            job.progressText = t('importQueue.progress.cancelled')
            this._releaseTerminalJobResources(job)
            this._notifyJobChange(job)
            this._notifyProgress()
            this._checkBatchFinished()
        } else if (job.status === 'running') {
            job.status = 'cancelling'
            job.progressText = t('importQueue.progress.cancelling')
            this._notifyJobChange(job)
            this._notifyProgress()
            try { job.abortController.abort() } catch (e) {}
        }
    }

    /**
     * Cancel all queued and running import tasks
     */
    cancelAll() {
        for (const job of this.jobs.values()) {
            if (job.status === 'queued' || job.status === 'running') {
                this.cancel(job.id)
            }
        }
    }

    /**
     * Retry a failed or cancelled job safely without race conditions
     * @param {string} jobId
     */
    retry(jobId) {
        const job = this.jobs.get(jobId)
        if (!job) return
        // Forbidden while actively executing or cancelling old attempt
        if (job.status === 'running' || job.status === 'cancelling') {
            console.warn(`[ImportQueue] Job ${jobId} is currently ${job.status}, cannot retry until finalized.`)
            return
        }
        if (job.status !== 'failed' && job.status !== 'cancelled') return

        const raw = job.rawItem
        const hasAccessibleSource = Boolean(
            (raw?.filePath) ||
            (raw?.buffer) ||
            (raw instanceof Blob)
        )
        if (!hasAccessibleSource) {
            job.status = 'failed'
            job.progressText = t('importQueue.progress.sourceLost')
            this._notifyJobChange(job)
            this._notifyProgress()
            return
        }

        job.status = 'queued'
        job.phase = 'pending'
        job.progressText = t('importQueue.progress.retrying')
        job.error = null
        job.errorType = null
        job.abortController = new AbortController()
        job.attemptToken = (job.attemptToken || 0) + 1
        this._notifyJobChange(job)
        this._notifyProgress()
        this._scheduleNext()
    }

    /**
     * Purge completed and cancelled jobs to keep memory bounded and prevent resurrecting badges
     */
    clearCompleted() {
        for (const [id, job] of this.jobs.entries()) {
            if (job.status === 'succeeded' || job.status === 'cancelled') {
                this.jobs.delete(id)
            }
        }
        this._notifyProgress()
    }

    /**
     * Free heavy heap references (e.g. buffers) on jobs that reached a terminal state
     * @param {object} job
     */
    _releaseTerminalJobResources(job) {
        if (!job) return
        if (job.status === 'succeeded') {
            job.rawItem = null
            job.fileBuffer = null
        } else if (job.rawItem) {
            if (job.rawItem.buffer) {
                job.rawItem.buffer = null
            }
            if (job.rawItem.filePath) {
                // Retain only light path metadata for potential retry, discard heavy blobs/buffers
                job.rawItem = { filePath: job.rawItem.filePath, filename: job.filename }
            } else if (job.rawItem instanceof File || job.rawItem instanceof Blob) {
                // User-selected File/Blob: release heavy heap reference, retain filename and mark re-select required
                job.rawItem = { filename: job.filename, fileSize: job.fileSize, requiresReSelect: true }
            }
            job.fileBuffer = null
        }
    }

    /**
     * Get active queue snapshot summary
     */
    getSummary() {
        let queued = 0, running = 0, cancelling = 0, succeeded = 0, failed = 0, cancelled = 0
        for (const job of this.jobs.values()) {
            if (job.status === 'queued') queued++
            else if (job.status === 'running') running++
            else if (job.status === 'cancelling') cancelling++
            else if (job.status === 'succeeded') succeeded++
            else if (job.status === 'failed') failed++
            else if (job.status === 'cancelled') cancelled++
        }
        const activeCovers = this._activeCoverCount + this._coverQueue.length
        return {
            total: this.jobs.size,
            queued,
            running,
            cancelling,
            succeeded,
            failed,
            cancelled,
            activeCovers,
            isIdle: queued === 0 && running === 0 && cancelling === 0 && activeCovers === 0
        }
    }

    _notifyJobChange(job) {
        try { this.onJobChange(job) } catch (e) {}
        if (this._waitCallbacks && this._waitCallbacks.length > 0) {
            for (const cb of [...this._waitCallbacks]) {
                try { cb() } catch (_) {}
            }
        }
    }

    _notifyProgress() {
        try { this.onProgress(this.getSummary()) } catch (e) {}
    }

    _scheduleNext() {
        if (this._isPaused) return

        while (this._activeImportCount < this.maxConcurrent) {
            // Find next queued job
            let nextJob = null
            for (const job of this.jobs.values()) {
                if (job.status === 'queued') {
                    if (job.status === 'cancelling' || job.abortController?.signal?.aborted) {
                        job.status = 'cancelled'
                        job.phase = 'cancelled'
                        job.progressText = t('importQueue.progress.cancelled')
                        this._releaseTerminalJobResources(job)
                        this._notifyJobChange(job)
                        continue
                    }
                    nextJob = job
                    break
                }
            }
            if (!nextJob) break

            this._activeImportCount++
            nextJob.status = 'running'
            this._notifyJobChange(nextJob)
            this._notifyProgress()

            this._executeImportJob(nextJob)
                .finally(() => {
                    this._activeImportCount--
                    this._scheduleNext()
                    this._checkBatchFinished()
                })
        }

        this._scheduleNextCover()
    }

    _checkBatchFinished() {
        const summary = this.getSummary()
        if (summary.isIdle && summary.total > 0 && !this._batchCompletedFired) {
            this._batchCompletedFired = true
            try { this.onBatchComplete(summary) } catch (e) {}
        }
    }

    /**
     * Process an individual import job
     * @param {object} job
     */
    async _executeImportJob(job) {
        const t0_total = performance.now()
        let nativeSnapshotPath = null
        let stageDescriptor = null
        let releaseCommit = null
        let savedBookId = null
        let parsedEpub = null
        let isCommittedToDb = false
        const signal = job.abortController.signal
        const myToken = job.attemptToken || 0

        const isAborted = () => signal.aborted || job.status === 'cancelling' || job.attemptToken !== myToken

        try {
            if (isAborted()) {
                job.status = 'cancelled'
                job.phase = 'cancelled'
                job.progressText = t('importQueue.progress.cancelled')
                this._releaseTerminalJobResources(job)
                this._notifyJobChange(job)
                return
            }

            const raw = job.rawItem
            const fileName = job.filename
            let ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : ''
            if (!ext && raw.type) {
                if (raw.type === 'text/plain') ext = 'txt'
                else if (raw.type === 'application/pdf') ext = 'pdf'
                else if (raw.type === 'application/epub+zip') ext = 'epub'
            }

            if (!SUPPORTED_IMPORT_FORMATS.includes(ext)) {
                throw new Error(t('importQueue.error.unsupportedFormat', { ext }))
            }

            // Phase 1: Reading file source
            job.phase = 'reading'
            job.progressText = t('importQueue.progress.reading')
            this._notifyJobChange(job)

            const t0_read = performance.now()
            let fileBuffer = null
            let fileObj = null

            if (raw instanceof File || raw instanceof Blob) {
                fileObj = raw
                job.fileSize = raw.size
            } else if (raw.file instanceof File || raw.file instanceof Blob) {
                fileObj = raw.file
                job.fileSize = raw.file.size
            } else if (raw.buffer) {
                fileBuffer = raw.buffer
            } else if (raw.filePath) {
                // If PDF on Tauri, stage to native cache first
                stageDescriptor = null
                if (ext === 'pdf' && platformBridge.isTauri && platformBridge.stagePdfSource) {
                    try {
                        const staged = await platformBridge.stagePdfSource(raw.filePath)
                        if (staged) {
                            stageDescriptor = typeof staged === 'object' ? staged : { path: staged }
                            nativeSnapshotPath = stageDescriptor.path || String(staged)
                        }
                    } catch (stageErr) {
                        console.warn('[ImportQueue] stagePdfSource skipped:', stageErr)
                    }
                }

                if (raw.receiveParsedEpub && ext === 'epub') {
                    try {
                        stageDescriptor = await platformBridge.stageEpubSnapshot(raw.filePath)
                        if (stageDescriptor) {
                            nativeSnapshotPath = stageDescriptor.path
                            fileObj = db.createLazySnapshotBlob(nativeSnapshotPath, stageDescriptor.size, 'application/epub+zip')
                        }
                    } catch (error) {
                        console.warn('[ImportQueue] EPUB snapshot staging unavailable:', error)
                    }
                } else if (nativeSnapshotPath) {
                    fileObj = { name: fileName, size: stageDescriptor.size, nativeSnapshotOnly: true }
                    if (!fileObj.size) throw new Error(t('importQueue.error.missingSnapshotSize'))
                }

                if (!fileObj && (!fileBuffer || fileBuffer.byteLength === 0)) {
                    if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                        platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                        nativeSnapshotPath = null
                        stageDescriptor = null
                    }
                    fileBuffer = await platformBridge.readFileBuffer(raw.filePath, { signal })
                }
            }

            if (!fileObj && fileBuffer) {
                let ab = fileBuffer
                if (Array.isArray(ab)) ab = new Uint8Array(ab).buffer
                else if (ArrayBuffer.isView(ab)) ab = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength)
                fileObj = new File([ab], fileName)
            }

            if (!fileObj || fileObj.size === 0) {
                throw new Error(t('importQueue.error.unreadable', { name: fileName }))
            }

            job.fileSize = fileObj.size
            job.bytesProcessed = fileObj.size
            job.durationMs.read = Math.round(performance.now() - t0_read)

            if (signal.aborted) {
                job.status = 'cancelled'
                if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                    platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                }
                return
            }

            // Phase 2: Metadata extraction (fast lightweight parser without full reader instantiation)
            job.phase = 'parsing'
            job.progressText = t('importQueue.progress.parsing')
            this._notifyJobChange(job)

            const t0_parse = performance.now()
            let format = ext
            if (ext === 'md') format = 'txt'
            else if (ext === 'azw' || ext === 'azw3') format = 'azw3'

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]] || ''
}

const formatContributor = contributor => {
    if (!contributor) return t('book.unknownAuthor')
    if (typeof contributor === 'string') return contributor
    if (Array.isArray(contributor)) {
        return contributor.map(c => typeof c === 'string' ? c : formatLanguageMap(c?.name)).join(', ')
    }
    return formatLanguageMap(contributor?.name) || t('book.unknownAuthor')
}

            let metadata = {
                title: fileName.replace(/\.[^/.]+$/, ''),
                author: t('book.unknownAuthor'),
                language: t('book.lang.zh')
            }

            let initialCoverBlob = null

            if (format === 'txt') {
                const { readTxtMetadata, TXT_LAYOUT_VERSION } = await import('../foliate-js-main/txt.js')
                metadata.txtLayoutVersion = TXT_LAYOUT_VERSION
                metadata.language = 'und'
                try {
                    Object.assign(metadata, await readTxtMetadata(fileObj))
                } catch (error) {
                    console.warn('[ImportQueue] Text metadata extraction:', error)
                }
            }

            // For EPUB: read metadata and cover via zip loader & EPUB module
            if (format === 'epub' || format === 'cbz') {
                try {
                    const { makeZipLoader } = await import('../foliate-js-main/view.js')
                    const loader = await makeZipLoader(fileObj)
                    if (format === 'epub') {
                        const { EPUB } = await import('../foliate-js-main/epub.js')
                        const epub = new EPUB(loader)
                        epub.loader = loader
                        try {
                            await epub.init()
                        } catch (error) {
                            epub.destroy()
                            throw error
                        }
                        parsedEpub = epub
                        if (epub?.metadata) {
                            const bookTitle = formatLanguageMap(epub.metadata.title)
                            metadata.title = resolveBookTitle(bookTitle, fileName)
                            const bookAuthor = formatContributor(epub.metadata.author)
                            if (bookAuthor && !['未知作者', '未知', 'unknown', 'unknown author'].includes(bookAuthor.trim().toLowerCase())) {
                                metadata.author = bookAuthor
                            }
                            if (epub.metadata.language) {
                                const rawLang = Array.isArray(epub.metadata.language) ? epub.metadata.language[0] : epub.metadata.language
                                if (rawLang && typeof rawLang === 'string') {
                                    const l = rawLang.toLowerCase()
                                    metadata.language = l.startsWith('zh') ? t('book.lang.zh') : l.startsWith('en') ? t('book.lang.en') : l.startsWith('ja') ? t('book.lang.ja') : l
                                }
                            }
                            if (epub.metadata.identifier) {
                                metadata.identifier = epub.metadata.identifier
                            }
                        }
                        if (typeof epub?.getCover === 'function') {
                            initialCoverBlob = await epub.getCover()
                        }
                    }
                    if (!initialCoverBlob) {
                        const imgEntries = (loader.entries || []).filter(e => /\.(jpe?g|png|webp)$/i.test(e.filename))
                        const coverEntry = imgEntries.find(e => /cover/i.test(e.filename)) || imgEntries[0]
                        if (coverEntry) {
                            const mime = coverEntry.filename.endsWith('.png') ? 'image/png' : coverEntry.filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
                            initialCoverBlob = await loader.loadBlob(coverEntry.filename, mime)
                        }
                    }
                    if (initialCoverBlob) {
                        initialCoverBlob = await normalizeCoverBlob(initialCoverBlob)
                    }
                } catch (metaErr) {
                    console.warn('[ImportQueue] Fast zip metadata extract warning:', metaErr)
                } finally {
                    if (parsedEpub && !raw.receiveParsedEpub) {
                        parsedEpub.destroy()
                        parsedEpub = null
                    }
                }
            }

            if (['mobi', 'azw3', 'fb2', 'docx'].includes(format)) {
                try {
                    const { makeBook } = await import('../foliate-js-main/view.js')
                    const parsed = await makeBook(fileObj)
                    try {
                        metadata.title = resolveBookTitle(formatLanguageMap(parsed.metadata?.title), fileName)
                        metadata.author = formatContributor(parsed.metadata?.author)
                        metadata.language = formatLanguageMap(parsed.metadata?.language) || metadata.language
                        initialCoverBlob = await parsed.getCover?.() || null
                        if (initialCoverBlob) initialCoverBlob = await normalizeCoverBlob(initialCoverBlob)
                    } finally { parsed.destroy?.() }
                } catch (error) { console.warn('[ImportQueue] Metadata extraction:', error) }
            }

            job.durationMs.parse = Math.round(performance.now() - t0_parse)

            if (isAborted()) {
                job.status = 'cancelled'
                job.phase = 'cancelled'
                job.progressText = t('importQueue.progress.cancelled')
                if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                    platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                }
                this._releaseTerminalJobResources(job)
                this._notifyJobChange(job)
                return
            }

            // Phase 3: Save to database & deduplication
            job.phase = 'saving'
            job.progressText = t('importQueue.progress.saving')
            this._notifyJobChange(job)

            const t0_save = performance.now()

            const computedStableKey = metadata.identifier || `${metadata.title || ''}_${fileObj.size || 0}_${format}`.replace(/\s+/g, '').toLowerCase()

            // Parsing remains concurrent; serialize the short identity-check/commit section.
            const previousCommit = this._commitTail
            this._commitTail = new Promise(resolve => { releaseCommit = resolve })
            await previousCommit
            if (isAborted()) throw new DOMException('Import cancelled', 'AbortError')

            const existingBooks = await db.getAllBooks()
            const incomingHash = stageDescriptor?.documentHash || await computeContentHash(fileObj)
            const sourceIdentity = { format, filename: fileName, size: fileObj.size, documentHash: incomingHash,
                legacyDocumentHash: stageDescriptor?.legacyDocumentHash, nativePath: raw.filePath, stableKey: computedStableKey }
            const sameContent = await findSameContentBook(existingBooks, sourceIdentity, db.getBookFileSnapshot)
            const match = sameContent || findDuplicateBook(existingBooks.filter(b => b.isCloudOnly &&
                contentIdentityRelation(b, sourceIdentity) !== 'different'), {
                format,
                fileName,
                fileObj,
                metadata,
                computedStableKey
            })

            if (isAborted()) {
                job.status = 'cancelled'
                job.phase = 'cancelled'
                job.progressText = t('importQueue.progress.cancelled')
                if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                    platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                }
                this._releaseTerminalJobResources(job)
                this._notifyJobChange(job)
                return
            }

            savedBookId = null
            let reuseExisting = Boolean(sameContent && !sameContent.isCloudOnly)
            if (reuseExisting && raw.receiveParsedEpub) {
                const snapshot = await db.getBookFileSnapshot(sameContent.id)
                reuseExisting = Boolean(snapshot?.blob && (!snapshot.nativeSnapshotOnly ||
                    await platformBridge.validateNativeSnapshot(snapshot.nativeSnapshotPath, snapshot.nativeSnapshotSize)))
            }

            if (reuseExisting) {
                savedBookId = sameContent.id
                if (nativeSnapshotPath && nativeSnapshotPath !== sameContent.nativeSnapshotPath) {
                    await platformBridge.reclaimSnapshot(nativeSnapshotPath)
                    nativeSnapshotPath = null
                }
            } else if (match && (match.isCloudOnly || sameContent)) {
                // Restore the local bytes for a placeholder or a missing identical snapshot.
                savedBookId = match.id
                await db.saveBook({
                    id: match.id,
                    blob: fileObj,
                    nativePath: raw.filePath || null,
                    nativeSnapshotPath,
                    blobRevision: stageDescriptor?.revision || null,
                    documentHash: incomingHash,
                    filename: fileName,
                    isCloudOnly: false,
                    hasLocalFile: true,
                    updatedAt: Date.now()
                })
                if (!match.coverBlob && initialCoverBlob) {
                    await db.saveBook({ id: match.id, coverBlob: initialCoverBlob })
                }
            } else {
                // Default: Keep both books without silent overwrite to protect existing progress and notes
                savedBookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                const stableKey = computedStableKey
                await db.saveBook({
                    id: savedBookId,
                    stableKey,
                    identifier: metadata.identifier || null,
                    title: metadata.title,
                    author: metadata.author,
                    language: metadata.language,
                    ...(format === 'txt' ? { txtLayoutVersion: metadata.txtLayoutVersion } : {}),
                    format,
                    filename: fileName,
                    size: fileObj.size,
                    blob: fileObj,
                    nativePath: raw.filePath || null,
                    nativeSnapshotPath,
                    blobRevision: stageDescriptor?.revision || null,
                    documentHash: incomingHash,
                    coverBlob: initialCoverBlob,
                    isRecentOnly: Boolean(raw.isRecentOnly),
                    readingStatus: 'unread',
                    tags: [],
                    tagsUpdatedAt: Date.now(),
                    addedAt: Date.now(),
                    lastReadAt: 0,
                    totalReadingSeconds: 0,
                    progress: { fraction: 0 },
                    hasLocalFile: true,
                    isCloudOnly: false
                })
            }

            isCommittedToDb = true
            if (!reuseExisting && parsedEpub && raw.receiveParsedEpub) {
                raw.receiveParsedEpub(parsedEpub, incomingHash)
                parsedEpub = null
            }
            job.durationMs.save = Math.round(performance.now() - t0_save)
            job.bookId = savedBookId
            job.status = 'succeeded'
            job.phase = 'done'
            job.progressText = t('importQueue.progress.succeeded')
            job.durationMs.total = Math.round(performance.now() - t0_total)

            this._notifyJobChange(job)
            this._notifyProgress()

            // Trigger immediate throttled shelf update so book appears right away!
            this._triggerThrottledShelfRefresh(savedBookId)

            // Phase 4: Queue low-priority cover generation if no cover yet
            if (!initialCoverBlob && format === 'pdf') {
                const fileSnapshot = await db.getBookFileSnapshot(savedBookId)
                this._enqueueCoverGeneration({
                    bookId: savedBookId,
                    format,
                    fileOrBlob: fileSnapshot?.blob || fileObj,
                    snapshot: fileSnapshot || (nativeSnapshotPath ? {
                        nativeSnapshotPath,
                        blob: fileObj,
                        nativeSnapshotSize: fileObj.size,
                        nativeSnapshotOnly: Boolean(fileObj.size > 25 * 1024 * 1024)
                    } : null)
                })
            }
            fileBuffer = null

        } catch (err) {
            if (!isCommittedToDb && nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
            }

            if (isCommittedToDb || job.status === 'succeeded' || job.bookId) {
                // Book already committed to DB, preserve succeeded status
            } else if (isAborted() || signal.aborted) {
                job.status = 'cancelled'
                job.phase = 'cancelled'
                job.progressText = t('importQueue.progress.cancelled')
            } else {
                job.status = 'failed'
                job.phase = 'failed'
                job.error = err.message || String(err)
                job.progressText = t('importQueue.progress.failed', { error: job.error })
                console.error(`[ImportQueue] Job ${job.id} failed:`, err)
            }
            this._notifyJobChange(job)
            this._notifyProgress()
        } finally {
            parsedEpub?.destroy()
            releaseCommit?.()
            this._releaseTerminalJobResources(job)
        }
    }

    _triggerThrottledShelfRefresh(bookId) {
        if (bookId) this._pendingShelfRefreshBooks.add(bookId)
        if (this._shelfRefreshTimer) return
        this._shelfRefreshTimer = setTimeout(() => {
            this._shelfRefreshTimer = null
            const books = Array.from(this._pendingShelfRefreshBooks)
            this._pendingShelfRefreshBooks.clear()
            try { this.onBookSaved(books) } catch (e) {}
        }, 150)
    }

    _enqueueCoverGeneration(item) {
        this._coverQueue.push(item)
        this._scheduleNextCover()
    }

    async _scheduleNextCover() {
        if (this._activeCoverCount >= this.coverMaxConcurrent || this._coverQueue.length === 0) return
        const item = this._coverQueue.shift()
        if (!item) return

        this._activeCoverCount++
        try {
            let coverBlob = null
            if (item.format === 'pdf') {
                coverBlob = await extractPdfCover(item.fileOrBlob, { snapshot: item.snapshot })
            }

            if (coverBlob) {
                const bookStillExists = await db.getBook(item.bookId)
                if (bookStillExists) {
                    await db.saveBook({ id: item.bookId, coverBlob })
                    this._triggerThrottledShelfRefresh(item.bookId)
                }
            }
        } catch (coverErr) {
            console.warn('[ImportQueue] Background cover generation warning:', coverErr)
        } finally {
            this._activeCoverCount--
            this._scheduleNextCover()
        }
    }
}

export const importQueue = new ImportQueue()
