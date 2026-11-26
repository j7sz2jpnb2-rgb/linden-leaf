import { DomEvents } from './dom-events.js'
import { contentIdentityRelation, computeContentHash } from './document-identity.js'
import * as db from './db.js'
import { platformBridge } from './platformBridge.js'
import { normalizeCoverBlob } from './pdf-cover.js'
import { coverUrlPool } from './cover-url-pool.js'
import { escapeHTML } from './ui-format.js'
import { t } from './i18n.js'

/** Owns imports UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class ImportFolderController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}

    }

    initDOM() {
        this.dom = {
            fileInput: document.getElementById('file-input'),
            dropZoneOverlay: document.getElementById('drop-zone-overlay'),
            importDockBadge: document.getElementById('import-dock-badge'),
            importDockSpinner: document.getElementById('import-dock-spinner'),
            importDockText: document.getElementById('import-dock-text'),
            importTaskPanel: document.getElementById('import-task-panel'),
            importTaskList: document.getElementById('import-task-list'),
            importPanelSummaryBadge: document.getElementById('import-panel-summary-badge'),
            importPanelStats: document.getElementById('import-panel-stats'),
            btnImportRetryFailed: document.getElementById('btn-import-retry-failed'),
            btnImportCancelAll: document.getElementById('btn-import-cancel-all'),
            btnImportMinimize: document.getElementById('btn-import-minimize'),
            btnImportClose: document.getElementById('btn-import-close'),
            btnImportClearDone: document.getElementById('btn-import-clear-done'),
            btnImport: document.getElementById('btn-import'),
            btnLinkFolder: document.getElementById('btn-link-folder')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(this.dom.btnImport, 'click', async () => {
            if (typeof platformBridge !== 'undefined' && platformBridge.openFileDialog) {
                try {
                    const fileItems = await platformBridge.openFileDialog()
                    if (fileItems && fileItems.length > 0) {
                        this.app.importQueue.enqueue(fileItems)
                    }
                } catch (dialogErr) {
                    console.error('[Import] Dialog error:', dialogErr)
                    this.app.dialogs.showToast(t('import.error.dialogFailed'), 'warning')
                }
            } else {
                this.dom.fileInput?.click()
            }
        });
        this.events.on(this.dom.fileInput, 'change', e => this.handleFileSelect(e));
        this.events.on(window, 'dragover', e => {
            e.preventDefault()
            this.dom.dropZoneOverlay?.classList.add('active')
        });
        this.events.on(window, 'dragleave', e => {
            if (e.relatedTarget === null) {
                this.dom.dropZoneOverlay?.classList.remove('active')
            }
        });
        this.events.on(window, 'drop', e => {
            e.preventDefault()
            this.dom.dropZoneOverlay?.classList.remove('active')
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                this.importFiles(Array.from(e.dataTransfer.files))
            }
        });
        this.events.on(this.dom.btnLinkFolder, 'click', () => this.linkLocalFolder());
            this.initImportCenter();
    }

    dispose() {
        this.events.dispose()
        clearTimeout(this._linkedRescanTimer)
        this._importCenterInitialized = false
        this._bound = false
    }

    async handleFileSelect(e) {
        const files = Array.from(e.target.files)
        if (files.length > 0) {
            await this.importFiles(files)
            this.dom.fileInput.value = ''
        }
    }

    async importFiles(files) {
        if (!files || files.length === 0) return
        this.app.importQueue.enqueue(files)
        const isReaderOpen = this.app.dom.readerView && this.app.dom.readerView.style.display !== 'none'
        if (!isReaderOpen) {
            this.showImportPanel()
        } else {
            this.minimizeImportPanel()
        }
    }

    initImportCenter() {
        if (!this.dom.importTaskPanel || this._importCenterInitialized) return
        this._importCenterInitialized = true
        this.app.importQueue.onBookSaved = () => this.app.bookshelf.refreshBookshelf()

        this.importCenterMinimized = false

        this.events.on(this.dom.importDockBadge, 'click', () => {
            this.showImportPanel()
        })

        this.events.on(this.dom.btnImportMinimize, 'click', () => {
            this.minimizeImportPanel()
        })

        this.events.on(this.dom.btnImportClose, 'click', () => {
            this.closeImportPanel()
        })

        this.events.on(this.dom.btnImportCancelAll, 'click', () => {
            this.app.importQueue.cancelAll()
            this.renderImportTaskList()
        })

        this.events.on(this.dom.btnImportRetryFailed, 'click', () => {
            for (const job of this.app.importQueue.jobs.values()) {
                if (job.status === 'failed') {
                    this.app.importQueue.retry(job.id)
                }
            }
            this.renderImportTaskList()
        })

        this.events.on(this.dom.btnImportClearDone, 'click', () => {
            for (const [id, job] of this.app.importQueue.jobs.entries()) {
                if (job.status === 'succeeded' || job.status === 'cancelled') {
                    this.app.importQueue.jobs.delete(id)
                }
            }
            this.renderImportTaskList()
            const summary = this.app.importQueue.getSummary()
            this.updateImportCenterUI(summary)
            if (summary.total === 0) {
                this.closeImportPanel()
            }
        })

        this.app.importQueue.onJobChange = (job) => {
            this.renderImportTaskItem(job)
            this.updateImportCenterUI(this.app.importQueue.getSummary())
        }

        this.app.importQueue.onProgress = (summary) => {
            this.updateImportCenterUI(summary)
        }

        this.app.importQueue.onBatchComplete = (summary) => {
            this.updateImportCenterUI(summary)
            this.app.bookshelf.refreshBookshelf()
        }
    }

    showImportPanel() {
        if (!this.dom.importTaskPanel) return
        this.importCenterMinimized = false
        this.dom.importTaskPanel.style.display = 'flex'
        if (this.dom.importDockBadge) this.dom.importDockBadge.style.display = 'none'
        this.renderImportTaskList()
    }

    minimizeImportPanel() {
        if (!this.dom.importTaskPanel) return
        this.importCenterMinimized = true
        this.dom.importTaskPanel.style.display = 'none'
        const summary = this.app.importQueue.getSummary()
        if (this.dom.importDockBadge && summary.total > 0) {
            this.dom.importDockBadge.style.display = 'flex'
        }
    }

    closeImportPanel() {
        if (!this.dom.importTaskPanel) return
        this.dom.importTaskPanel.style.display = 'none'
        const summary = this.app.importQueue.getSummary()
        if (summary.running > 0 || summary.queued > 0) {
            this.minimizeImportPanel()
        } else {
            this.importBatchDismissed = true
            const currentBatchId = this.app.importQueue._batchId || 1
            try {
                localStorage.setItem('linden_import_dismissed_batch', String(currentBatchId))
            } catch (e) {}
            if (typeof this.app.importQueue.clearCompleted === 'function') {
                this.app.importQueue.clearCompleted()
            }
            if (this.dom.importDockBadge) this.dom.importDockBadge.style.display = 'none'
        }
    }

    updateImportCenterUI(summary) {
        if (!summary) summary = this.app.importQueue.getSummary()

        const dismissedBatch = localStorage.getItem('linden_import_dismissed_batch')
        const currentBatchId = this.app.importQueue._batchId || 0
        if (dismissedBatch && String(currentBatchId) === String(dismissedBatch)) {
            this.importBatchDismissed = true
        }

        if (this.dom.importPanelSummaryBadge) {
            this.dom.importPanelSummaryBadge.textContent = t('import.summary.totalBadge', { count: summary.total })
        }

        if (this.dom.importPanelStats) {
            if (summary.total === 0) {
                this.dom.importPanelStats.textContent = t('import.summary.empty')
            } else if (summary.running > 0 || summary.queued > 0) {
                this.dom.importPanelStats.textContent = t('import.summary.inProgress', {
                    running: summary.running,
                    queued: summary.queued,
                    succeeded: summary.succeeded
                }) + (summary.failed > 0 ? t('import.summary.failedSuffix', { count: summary.failed }) : '')
            } else {
                this.dom.importPanelStats.textContent = t('import.summary.completed', { succeeded: summary.succeeded }) +
                    (summary.failed > 0 ? t('import.summary.completedFailedSuffix', { count: summary.failed }) : '')
            }
        }

        if (this.dom.btnImportRetryFailed) {
            this.dom.btnImportRetryFailed.style.display = summary.failed > 0 ? 'inline-block' : 'none'
        }

        const isReaderOpen = this.app.dom.readerView && this.app.dom.readerView.style.display !== 'none'

        if (summary.running > 0 || summary.queued > 0) {
            this.importBatchDismissed = false
        }

        if (summary.total > 0 && !this.importBatchDismissed) {
            if (isReaderOpen) {
                if (this.dom.importTaskPanel) this.dom.importTaskPanel.style.display = 'none'
                if (summary.running > 0 || summary.queued > 0) {
                    if (this.dom.importDockBadge) this.dom.importDockBadge.style.display = 'flex'
                } else {
                    if (this.dom.importDockBadge) this.dom.importDockBadge.style.display = 'none'
                }
            } else if (!this.importCenterMinimized) {
                if (this.dom.importTaskPanel?.style.display !== 'flex') {
                    this.showImportPanel()
                }
            } else if (this.importCenterMinimized && this.dom.importDockBadge) {
                if (summary.running > 0 || summary.queued > 0) {
                    this.dom.importDockBadge.style.display = 'flex'
                } else {
                    this.dom.importDockBadge.style.display = 'none'
                }
            }
        } else {
            if (this.dom.importDockBadge) this.dom.importDockBadge.style.display = 'none'
            if (this.dom.importTaskPanel) this.dom.importTaskPanel.style.display = 'none'
        }

        if (this.dom.importDockSpinner) {
            if (summary.running > 0 || summary.queued > 0) {
                this.dom.importDockSpinner.classList.add('active')
            } else {
                this.dom.importDockSpinner.classList.remove('active')
            }
        }

        if (this.dom.importDockText) {
            if (summary.running > 0 || summary.queued > 0) {
                this.dom.importDockText.textContent = t('import.dock.running', {
                    done: summary.succeeded + summary.failed,
                    total: summary.total
                })
            } else {
                this.dom.importDockText.textContent = t('import.dock.done', {
                    succeeded: summary.succeeded,
                    total: summary.total
                })
            }
        }
    }

    renderImportTaskList() {
        if (!this.dom.importTaskList) return
        this.dom.importTaskList.innerHTML = ''
        const jobs = Array.from(this.app.importQueue.jobs.values())
        if (jobs.length === 0) {
            this.dom.importTaskList.innerHTML = `<div class="import-empty-state" style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">${escapeHTML(t('import.emptyList'))}</div>`
            return
        }
        for (const job of jobs) {
            this.renderImportTaskItem(job)
        }
    }

    renderImportTaskItem(job) {
        if (!this.dom.importTaskList) return
        let itemEl = document.getElementById(`import-item-${job.id}`)
        if (!itemEl) {
            const emptyEl = this.dom.importTaskList.querySelector('.import-empty-state')
            if (emptyEl) {
                this.dom.importTaskList.innerHTML = ''
            }
            itemEl = document.createElement('div')
            itemEl.id = `import-item-${job.id}`
            itemEl.className = 'import-task-item'
            this.dom.importTaskList.appendChild(itemEl)
        }

        const sizeStr = job.fileSize ? ` · ${(job.fileSize / (1024 * 1024)).toFixed(1)} MB` : ''
        const statusMap = {
            queued: { label: t('import.status.queued'), cls: 'queued' },
            running: { label: job.progressText || t('import.status.running'), cls: 'running' },
            cancelling: { label: t('import.status.cancelling'), cls: 'cancelling' },
            succeeded: { label: t('import.status.succeeded'), cls: 'succeeded' },
            failed: { label: t('import.status.failed'), cls: 'failed' },
            cancelled: { label: t('import.status.cancelled'), cls: 'cancelled' }
        }
        const st = statusMap[job.status] || { label: job.status, cls: 'queued' }
        const errHint = job.error ? `<div style="color: #ef4444; font-size: 0.7rem; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(job.error)}">${escapeHTML(job.error)}</div>` : ''

        let actionBtn = ''
        if (job.status === 'queued' || job.status === 'running') {
            actionBtn = `<button class="import-task-btn" data-action="cancel" data-id="${job.id}">${escapeHTML(t('import.btn.cancel'))}</button>`
        } else if (job.status === 'failed') {
            actionBtn = `<button class="import-task-btn" data-action="retry" data-id="${job.id}">${escapeHTML(t('import.btn.retry'))}</button>`
        }

        itemEl.innerHTML = `
            <div class="import-task-meta">
                <div class="import-task-title" title="${escapeHTML(job.filename)}">${escapeHTML(job.filename)}</div>
                <div class="import-task-sub">
                    <span class="import-task-status-chip ${st.cls}">${escapeHTML(st.label)}</span>
                    <span>${sizeStr}</span>
                </div>
                ${errHint}
            </div>
            <div class="import-task-action-wrap">
                ${actionBtn}
            </div>
        `

        const btn = itemEl.querySelector('.import-task-btn')
        if (btn) {
            btn.onclick = () => {
                const act = btn.getAttribute('data-action')
                if (act === 'cancel') {
                    this.app.importQueue.cancel(job.id)
                } else if (act === 'retry') {
                    this.app.importQueue.retry(job.id)
                }
            }
        }
    }

    async processAndSaveBook(file, customFileName, nativePath = null, nativeSnapshotPath = null) {
        const [job] = await this.app.importQueue.enqueueAndWait([{
            file, filename: customFileName || file.name, filePath: nativePath,
            nativeSnapshotPath, isRecentOnly: true
        }])
        if (job?.status !== 'succeeded') throw new Error(job?.error || t('import.error.cancelled'))
        return job.bookId
    }

    async tryExtractAndSaveCover(book) {
        if (!book || book.coverBlob) return book?.coverBlob
        let fileBlob = book.blob
        if (!fileBlob) {
            fileBlob = await db.getBookFile(book.id)
        }
        if (!fileBlob) return null

        let coverBlob = null
        try {
            const { makeBook } = await import('../foliate-js-main/view.js')
            const tempBook = await makeBook(fileBlob)
            if (typeof tempBook.getCover === 'function') {
                coverBlob = await tempBook.getCover()
            }
            tempBook.destroy?.()
        } catch (e) {
            console.warn('tryExtractAndSaveCover foliate error:', e)
        }

        // Secondary robust fallback for EPUB / CBZ files
        if (!coverBlob && (book.format === 'epub' || book.format === 'cbz' || fileBlob?.type?.includes('zip') || fileBlob?.type?.includes('epub') || book.title?.endsWith('.epub') || book.title?.endsWith('.cbz'))) {
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js')
                const loader = await makeZipLoader(fileBlob)
                const imgEntries = loader.entries.filter(e => /\.(jpe?g|png|webp)$/i.test(e.filename))
                const coverEntry = imgEntries.find(e => /cover/i.test(e.filename)) || imgEntries[0]
                if (coverEntry) {
                    const mime = coverEntry.filename.endsWith('.png') ? 'image/png' : 'image/jpeg'
                    coverBlob = await loader.loadBlob(coverEntry.filename, mime)
                }
            } catch (e) {
                console.warn('Fallback zip cover auto-heal error:', e)
            }
        }

        if (coverBlob) {
            coverBlob = (await normalizeCoverBlob(coverBlob)) || coverBlob
            book.coverBlob = coverBlob
            await db.saveBook(book)
            coverUrlPool.revoke(book.id)
            const coverUrl = coverUrlPool.get(book.id, coverBlob, book.coverRevision ?? 0)
            
            // Dynamically update DOM if present on shelf
            const gridEl = document.querySelector(`.leaf-book-card[data-id="${book.id}"] .leaf-cover-box`)
            if (gridEl) {
                const existingImg = gridEl.querySelector('.leaf-cover-img')
                if (existingImg) {
                    existingImg.src = coverUrl
                } else {
                    const cleanText = gridEl.querySelector('.editorial-cover-fallback, .leaf-clean-cover')
                    if (cleanText) {
                        const img = document.createElement('img')
                        img.className = 'leaf-cover-img'
                        img.src = coverUrl
                        img.alt = escapeHTML(book.title)
                        img.decoding = 'async'
                        cleanText.replaceWith(img)
                    }
                }
            }
        }
        return coverBlob
    }

    debouncedRescanLinkedRoots() {
        const now = Date.now()
        if (this._lastLinkedRescan && (now - this._lastLinkedRescan < 5000)) return
        this._lastLinkedRescan = now
        if (this._linkedRescanTimer) clearTimeout(this._linkedRescanTimer)
        this._linkedRescanTimer = setTimeout(async () => {
            try {
                if (!window.platformBridge?.fsScanFolder) return
                const linkedRoots = (await db.getSetting?.('linkedFolderRoots', [])) || []
                for (const root of linkedRoots) {
                    await this.linkLocalFolder(root, { isSilent: true })
                }
            } catch (_) {}
        }, 500)
    }

    async linkLocalFolder(targetFolder = null, { isSilent = false } = {}) {
        if (!window.platformBridge?.dialogPickFolder || !window.platformBridge?.fsScanFolder) {
            if (!isSilent) this.app.dialogs.showToast(t('import.folder.unsupported'), 'warning')
            return
        }
        let folder = targetFolder
        if (!folder) {
            folder = await window.platformBridge.dialogPickFolder({ title: t('import.folder.pickTitle') })
        }
        if (!folder) return
        if (!isSilent) this.app.dialogs.showToast(t('import.folder.scanning', { folder }), 'info')

        const normalizePath = p => (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
        const splitPathSegments = p => (p || '').replace(/\\/g, '/').split('/').filter(Boolean).map(s => s.toLowerCase())
        const isUnderFolder = (filePath, folderPath) => {
            const fileParts = splitPathSegments(filePath)
            const rootParts = splitPathSegments(folderPath)
            if (fileParts.length < rootParts.length) return false
            for (let i = 0; i < rootParts.length; i++) {
                if (fileParts[i] !== rootParts[i]) return false
            }
            return true
        }
        const getRelativePath = (filePath, folderPath) => {
            const normF = normalizePath(filePath)
            const normRoot = normalizePath(folderPath)
            if (normF.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
                return normF.slice(normRoot.length + 1)
            }
            return normF
        }

        let scanRes = null
        try {
            scanRes = await window.platformBridge.fsScanFolder(folder, 5)
        } catch (scanErr) {
            if (!isSilent) this.app.dialogs.showToast(t('import.folder.scanFailed', { error: scanErr?.message || scanErr }), 'error')
            // Root offline / scan failure / permission denied: do NOT treat as deleting all books, only mark offline
            try {
                const existing = await (db.getAllBooks ? db.getAllBooks().catch(() => []) : [])
                for (const b of existing) {
                    if (b.isLinked && isUnderFolder(b.nativePath || b.filePath, folder)) {
                        b.hasLocalFile = false
                        b.isOffline = true
                        await db.saveBook?.(b)
                    }
                }
            } catch (_) {}
            return
        }

        const files = Array.isArray(scanRes) ? scanRes : (scanRes?.files || scanRes?.items || [])
        const scanComplete = (scanRes && typeof scanRes === 'object' && 'complete' in scanRes) ? Boolean(scanRes.complete) : true
        const scanErrors = (scanRes && typeof scanRes === 'object' && Array.isArray(scanRes.errors)) ? scanRes.errors : []

        if (!files || files.length === 0) {
            if (scanComplete && scanErrors.length === 0) {
                try {
                    const existing = await (db.getAllBooks ? db.getAllBooks().catch(() => []) : [])
                    for (const b of existing) {
                        if (b.isLinked && isUnderFolder(b.nativePath || b.filePath, folder)) {
                            b.hasLocalFile = false
                            b.isOffline = true
                            await db.saveBook?.(b)
                        }
                    }
                } catch (_) {}
                if (!isSilent) this.app.dialogs.showToast(t('import.folder.empty'), 'info')
            } else if (!isSilent) {
                this.app.dialogs.showToast(t('import.folder.restricted', { count: scanErrors.length }), 'warning')
            }
            return
        }

        const existingBooks = await (db.getAllBooks ? db.getAllBooks().catch(() => []) : [])
        const scannedPathSet = new Set(files.map(f => normalizePath(f.path).toLowerCase()))
        const matchedExistingIds = new Set()
        let added = 0
        let updated = 0

        // Find existing linked books under this folder that are missing from the current scan
        const missingInFolder = existingBooks.filter(b => 
            b.isLinked && 
            isUnderFolder(b.nativePath || b.filePath, folder) && 
            !scannedPathSet.has(normalizePath(b.nativePath || b.filePath).toLowerCase())
        )

        for (const file of files) {
            const normFilePath = normalizePath(file.path)
            const relPath = getRelativePath(file.path, folder)
            const format = (file.ext || file.extension || '').toLowerCase()
            const size = Number(file.size ?? file.fileSize ?? 0)
            const title = file.name.replace(/\.[^/.]+$/, '')
            const stableKey = `${title}_${size}_${format}`
            const fid = file.fileId || file.file_id || file.inode || file.id || null
            const volId = file.volumeId || file.volume_id || null
            const fileMtime = Number(file.modified_time ?? file.mtime ?? 0)

            // 1. Collect all existing candidates at this exact path (case-insensitive), independent of getAllBooks() reading sort order
            const samePathCandidates = existingBooks.filter(b =>
                !matchedExistingIds.has(b.id) &&
                (normalizePath(b.nativePath).toLowerCase() === normFilePath.toLowerCase() ||
                 normalizePath(b.filePath).toLowerCase() === normFilePath.toLowerCase())
            )

            let matchedBook = null
            if (samePathCandidates.length > 0) {
                let effectiveFileHash = file.documentHash || file.document_hash || null
                const needsOnDemandHash = !effectiveFileHash && samePathCandidates.some(cand => {
                    const candFid = cand.fileId || cand.file_id || cand.inode || null
                    const candMtime = Number(cand.mtime ?? cand.modified_time ?? 0)
                    const sizeMatch = !cand.size || !size || Math.abs(cand.size - size) === 0
                    const idDiff = Boolean(fid && candFid && fid !== candFid)
                    const mtimeDiff = Boolean(fileMtime > 0 && candMtime > 0 && fileMtime !== candMtime)
                    return sizeMatch && (idDiff || mtimeDiff) && Boolean(cand.documentHash)
                })
                if (needsOnDemandHash && typeof window !== 'undefined' && typeof window.platformBridge?.computeNativeFileHash === 'function') {
                    try {
                        effectiveFileHash = await window.platformBridge.computeNativeFileHash(file.path)
                        if (effectiveFileHash) file.documentHash = effectiveFileHash
                    } catch (_) {}
                }

                // Prefer active/non-offline candidate first when comparing versions at the same path
                const orderedCandidates = [...samePathCandidates].sort((a, b) => Number(Boolean(a.isOffline)) - Number(Boolean(b.isOffline)))
                for (const cand of orderedCandidates) {
                    const candFid = cand.fileId || cand.file_id || cand.inode || null
                    const candMtime = Number(cand.mtime ?? cand.modified_time ?? 0)
                    const hasSizeMismatch = Boolean(cand.size && size > 0 && Math.abs(cand.size - size) > 0)
                    const hasFileIdMismatch = Boolean(fid && candFid && fid !== candFid)
                    const hasMtimeMismatch = Boolean(fileMtime > 0 && candMtime > 0 && fileMtime !== candMtime)
                    if (effectiveFileHash && cand.documentHash && contentIdentityRelation({ documentHash: effectiveFileHash }, cand) === 'unknown') {
                        const savedSnapshot = await db.getBookFileSnapshot(cand.id)
                        const savedHash = cand.nativeSnapshotPath ? await platformBridge.computeNativeFileHash(cand.nativeSnapshotPath)
                            : savedSnapshot?.blob instanceof Blob ? await computeContentHash(savedSnapshot.blob) : null
                        if (savedHash) cand.documentHashAliases = [...new Set([...(cand.documentHashAliases || []), savedHash])]
                    }
                    const hasHashMismatch = contentIdentityRelation({ documentHash: effectiveFileHash }, cand) === 'different'
                    const isConfirmedSameHash = contentIdentityRelation({ documentHash: effectiveFileHash }, cand) === 'same'

                    if (!hasHashMismatch && !hasSizeMismatch && (isConfirmedSameHash || (!hasFileIdMismatch && !hasMtimeMismatch))) {
                        matchedBook = cand
                        break
                    }
                }

                // Mark all non-matching historical versions at this path as offline & consumed so they are not re-matched
                for (const cand of samePathCandidates) {
                    if (cand !== matchedBook) {
                        matchedExistingIds.add(cand.id)
                        if (!cand.isOffline || cand.hasLocalFile !== false) {
                            cand.isOffline = true
                            cand.hasLocalFile = false
                            await db.saveBook(cand)
                        }
                    }
                }
            }

            // 2. Candidate rename/move match from missing books in this folder
            if (!matchedBook && size > 0) {
                // 2a. Stable file identifier if available (also require same size and no mtime/hash conflict)
                if (fid) {
                    matchedBook = missingInFolder.find(b => {
                        if (matchedExistingIds.has(b.id)) return false
                        const bFid = b.fileId || b.file_id || b.inode || null
                        if (bFid !== fid) return false
                        if (b.size && size > 0 && b.size !== size) return false
                        const bMtime = Number(b.mtime ?? b.modified_time ?? 0)
                        if (!file.documentHash && fileMtime > 0 && bMtime > 0 && fileMtime !== bMtime) return false
                        if (contentIdentityRelation(file, b) === 'different') return false
                        return true
                    })
                }
                // 2b. Exact content/document hash match
                if (!matchedBook && (file.documentHash || file.hash)) {
                    const h = file.documentHash || file.hash
                    matchedBook = missingInFolder.find(b => !matchedExistingIds.has(b.id) && b.documentHash === h)
                }
                // 2c. Relative path match
                if (!matchedBook && relPath) {
                    matchedBook = missingInFolder.find(b => {
                        if (matchedExistingIds.has(b.id)) return false
                        if (b.relativePath !== relPath || b.size !== size || b.format !== format) return false
                        const bMtime = Number(b.mtime ?? b.modified_time ?? 0)
                        if (!file.documentHash && fileMtime > 0 && bMtime > 0 && fileMtime !== bMtime) return false
                        if (file.documentHash && b.documentHash && file.documentHash !== b.documentHash) return false
                        return true
                    })
                }
            }

            const inferredMime = format === 'pdf' ? 'application/pdf' : (format === 'txt' ? 'text/plain' : (format === 'epub' ? 'application/epub+zip' : `application/${format}`))

            if (matchedBook) {
                matchedExistingIds.add(matchedBook.id)
                // Preserved identity: update path and state without modifying notes or rolling back progress
                matchedBook.nativePath = file.path
                matchedBook.filePath = file.path
                matchedBook.rootId = folder
                matchedBook.relativePath = relPath
                matchedBook.title = title
                matchedBook.format = format
                matchedBook.size = size
                matchedBook.fileSize = size
                matchedBook.mtime = fileMtime
                matchedBook.modified_time = fileMtime
                matchedBook.hasLocalFile = true
                matchedBook.isOffline = false
                matchedBook.stableKey = stableKey
                if (volId) matchedBook.volumeId = volId
                if (fid) matchedBook.fileId = fid
                if (file.documentHash) matchedBook.documentHash = file.documentHash
                if (format !== 'pdf' && typeof db.createLazySnapshotBlob === 'function' && !matchedBook.blob) {
                    matchedBook.blob = db.createLazySnapshotBlob(file.path, size, inferredMime)
                }
                await db.saveBook(matchedBook)
                updated++
            } else {
                let hash = 0
                for (let i = 0; i < file.path.length; i++) hash = ((hash << 5) - hash) + file.path.charCodeAt(i) | 0
                const id = 'linked_' + Math.abs(hash).toString(36) + '_' + Math.random().toString(36).slice(2, 6)
                const newBook = {
                    id,
                    title,
                    author: t('book.unknownAuthor'),
                    format,
                    size,
                    fileSize: size,
                    mtime: fileMtime,
                    modified_time: fileMtime,
                    volumeId: volId,
                    fileId: fid,
                    filePath: file.path,
                    nativePath: file.path,
                    rootId: folder,
                    relativePath: relPath,
                    documentHash: file.documentHash || null,
                    stableKey,
                    isLinked: true,
                    hasLocalFile: true,
                    isOffline: false,
                    addedAt: Date.now(),
                    updatedAt: Date.now(),
                    progress: { fraction: 0, updatedAt: Date.now() }
                }
                if (format !== 'pdf' && typeof db.createLazySnapshotBlob === 'function') {
                    newBook.blob = db.createLazySnapshotBlob(file.path, size, inferredMime)
                }
                await db.saveBook(newBook)
                added++
            }
        }

        // Mark missing linked books as offline ONLY when the folder scan was complete without directory errors
        if (scanComplete && scanErrors.length === 0) {
            for (const b of existingBooks) {
                if (b.isLinked && isUnderFolder(b.nativePath || b.filePath, folder) && !matchedExistingIds.has(b.id) && !scannedPathSet.has(normalizePath(b.nativePath || b.filePath).toLowerCase())) {
                    b.hasLocalFile = false
                    b.isOffline = true
                    await db.saveBook(b)
                }
            }
        }

        // Save linked folder root to settings
        try {
            if (db.getSetting && db.setSetting) {
                const roots = (await db.getSetting('linkedFolderRoots', [])) || []
                if (!roots.includes(folder)) {
                    roots.push(folder)
                    await db.setSetting('linkedFolderRoots', roots)
                    this.app._populateStoragePaths?.()
                }
            }
        } catch (_) {}

        if (!isSilent) {
            if (!scanComplete || scanErrors.length > 0) {
                this.app.dialogs.showToast(t('import.folder.partialDone', { errors: scanErrors.length, added, updated }), 'warning')
            } else {
                this.app.dialogs.showToast(t('import.folder.done', { added, updated, total: files.length }), 'success')
            }
        }
        await this.app.bookshelf.refreshBookshelf?.()
    }
}
