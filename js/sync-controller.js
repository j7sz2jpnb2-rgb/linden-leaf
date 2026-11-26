import { DomEvents } from './dom-events.js'
import * as db from './db.js'
import * as syncEngine from './syncEngine.js'
import { getSafeCloudFileName as buildSafeCloudFileName } from './book-metadata.js'
import { platformBridge } from './platformBridge.js'
import { escapeHTML } from './ui-format.js'
import { getLocale, t } from './i18n.js'

/** Owns sync UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class SyncController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this._activeTransfers = new Set()
    }

    refreshLocale() {
        this.refreshSyncStatusUI()
    }

    initDOM() {
        this.dom = {
            modalWebdavSync: document.getElementById('modal-webdav-sync'),
            btnOpenSyncModal: document.getElementById('btn-open-sync-modal'),
            btnCloseSyncModal: document.getElementById('btn-close-sync-modal'),
            btnSyncDisable: document.getElementById('btn-sync-disable'),
            btnSyncSaveEnable: document.getElementById('btn-sync-save-enable'),
            syncStatusBadgeSidebar: document.getElementById('sync-status-badge-sidebar'),
            syncInputServer: document.getElementById('sync-input-server'),
            syncInputUsername: document.getElementById('sync-input-username'),
            syncInputPassword: document.getElementById('sync-input-password'),
            btnToggleSyncPwd: document.getElementById('btn-toggle-sync-pwd'),
            syncInputDir: document.getElementById('sync-input-dir'),
            btnSyncTestConn: document.getElementById('btn-sync-test-conn'),
            btnSyncTriggerNow: document.getElementById('btn-sync-trigger-now'),
            syncStatusCard: document.getElementById('sync-status-card'),
            syncStatusDot: document.getElementById('sync-status-dot'),
            syncStatusTitle: document.getElementById('sync-status-title'),
            syncStatusDesc: document.getElementById('sync-status-desc')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(document.getElementById('btn-oauth-login'), 'click', () => this.handleOAuthLogin());
        this.events.on(document.getElementById('btn-browse-cloud-books'), 'click', () => this.openCloudBookPickerUI());
    }

    dispose() { this.events.dispose(); this._bound = false }

    async getBookStorage() {
        const { getBookStorage } = await import('./storage-providers.js')
        return getBookStorage(this.syncConfig)
    }

    async handleCloudBookClick(book) {
        if (!book) return
        if (this._activeTransfers?.has(book.id)) {
            return this.app.dialogs.showToast(t('syncCtrl.transferring', { title: book.title }), 'info')
        }

        const format = (book.format || '').toLowerCase()
        const size = book.size || book.cloudBackup?.size || 0
        const sizeMb = (size / 1048576).toFixed(1)

        // Strict format & size defense: PDF, CBZ or >= 15MB files MUST prompt user confirmation
        const isHighRisk = format === 'pdf' || format === 'cbz' || size >= 15 * 1024 * 1024

        if (isHighRisk) {
            const formatName = format.toUpperCase()
            const confirmMsg = t('syncCtrl.downloadConfirmMsg', { title: book.title, format: formatName, sizeMb })
            const confirmed = await this.app.dialogs.showConfirmDialog(t('syncCtrl.downloadConfirmTitle'), confirmMsg)
            if (!confirmed) return
        }

        if (!this.syncConfig?.enabled) {
            this.app.dialogs.showToast(t('syncCtrl.needProviderConfig'), 'warning')
            return this.openWebdavSyncModal()
        }

        this._activeTransfers?.add(book.id)
        const fileName = book.cloudBackup?.fileName || `${book.stableKey || book.id}.${book.format}`
        this.app.dialogs.showToast(t('syncCtrl.downloadingBook', { title: book.title }), 'cloud')

        try {
            const res = await (await this.getBookStorage()).downloadBookBinary(fileName)
            if (!res || !res.success || !res.buffer) {
                throw new Error(res?.error || t('syncCtrl.downloadFailedDefault'))
            }

            const mimeType = format === 'pdf' ? 'application/pdf' : 'application/octet-stream'
            const blob = new Blob([res.buffer], { type: mimeType })
            if (!await db.saveBookFileBlob(book.id, blob)) return

            // Re-fetch fresh book record from DB to preserve any concurrent sync updates
            const freshBook = (await db.getBook(book.id)) || book
            freshBook.isCloudOnly = false
            freshBook.hasLocalFile = true
            freshBook.cloudBackupState = 'synced'
            freshBook._preserveUpdatedAt = true
            await db.saveBook(freshBook)

            // Auto-heal / extract cover for the downloaded book
            if (!freshBook.coverBlob) {
                await this.app.imports.tryExtractAndSaveCover(freshBook)
            }

            await this.app.bookshelf.refreshBookshelf()

            // Only auto-open if the user isn't already actively reading another book
            if (!this.app.currentBookId) {
                this.app.dialogs.showToast(t('syncCtrl.readyOpening', { title: book.title }), 'book')
                await this.app.openBook(book.id)
            } else {
                this.app.dialogs.showToast(t('syncCtrl.downloadedReady', { title: book.title }), 'success')
            }
        } catch (err) {
            console.error('Download cloud book error:', err)
            this.app.dialogs.showToast(t('syncCtrl.pullFailed', { error: err.message }), 'error')
        } finally {
            this._activeTransfers?.delete(book.id)
        }
    }

    async handleUploadBookToCloud(book) {
        if (!book) return
        if (book.isCloudOnly) {
            return this.handleCloudBookClick(book)
        }

        if (this._activeTransfers?.has(book.id)) {
            return this.app.dialogs.showToast(t('syncCtrl.uploading', { title: book.title }), 'info')
        }

        // Prevent unintentional quota wastage: confirm before re-uploading an already backed-up book
        if (book.cloudBackup?.hasBackup) {
            const backupDate = book.cloudBackup.uploadedAt ? new Date(book.cloudBackup.uploadedAt).toLocaleString(getLocale()) : t('syncCtrl.completed')
            const backupSize = (book.cloudBackup.size ? (book.cloudBackup.size / 1048576).toFixed(1) : (book.size / 1048576).toFixed(1))
            const confirmReupload = await this.app.dialogs.showConfirmDialog(
                t('syncCtrl.overwriteConfirmTitle'),
                t('syncCtrl.overwriteConfirmMsg', { title: book.title, date: backupDate, sizeMb: backupSize })
            )
            if (!confirmReupload) return
        }

        if (!this.syncConfig?.enabled) {
            this.app.dialogs.showToast(t('syncCtrl.needProviderConfig'), 'warning')
            return this.openWebdavSyncModal()
        }

        const format = (book.format || '').toLowerCase()
        const size = book.size || 0
        const sizeMb = (size / 1048576).toFixed(1)
        const isHighRisk = format === 'pdf' || format === 'cbz' || size >= 15 * 1024 * 1024

        if (isHighRisk && !book.cloudBackup?.hasBackup) {
            const confirmMsg = t('syncCtrl.uploadConfirmMsg', { title: book.title, format: format.toUpperCase(), sizeMb })
            const confirmed = await this.app.dialogs.showConfirmDialog(t('syncCtrl.uploadConfirmTitle'), confirmMsg)
            if (!confirmed) return
        }

        this._activeTransfers?.add(book.id)
        try {
            // Read the bytes and their revision from the same snapshot.
            const initialSnapshot = await db.getBookFileSnapshot(book.id)
            const arrayBuffer = await initialSnapshot?.blob?.arrayBuffer().catch(() => null)
            if (!arrayBuffer?.byteLength) {
                return this.app.dialogs.showToast(t('syncCtrl.localFileMissingOrEmpty'), 'warning')
            }

            this.app.dialogs.showToast(t('syncCtrl.uploadingBook', { title: book.title }), 'cloud')
            const initialSize = arrayBuffer.byteLength
            const fileName = this.getSafeCloudFileName(book)
            const contentStillMatches = async () => {
                const latest = await db.getBookFileSnapshot(book.id).catch(() => null)
                return latest && latest.blobRevision === initialSnapshot.blobRevision &&
                    latest.documentHash === initialSnapshot.documentHash && latest.blob?.size === initialSize
            }
            const showFileChanged = () => this.app.dialogs.showToast(t('syncCtrl.fileChangedReupload', { title: book.title }), 'warning')

            const storage = await this.getBookStorage()
            if (!await contentStillMatches()) return showFileChanged()
            const res = await storage.uploadBookBinary(fileName, arrayBuffer)
            if (!res || !res.success) {
                throw new Error(res?.error || t('syncCtrl.uploadFailedDefault'))
            }
            if (!await contentStillMatches()) return showFileChanged()

            const uploadedFileName = res.fileName || fileName
            await db.saveBook({
                id: book.id,
                cloudBackup: {
                    hasBackup: true,
                    fileName: uploadedFileName,
                    size: initialSize,
                    format: book.format,
                    uploadedAt: Date.now()
                },
                cloudBackupState: 'synced',
                updatedAt: Date.now()
            })

            this.app.dialogs.showToast(t('syncCtrl.uploadSuccess', { title: book.title }), 'cloud')
            await this.app.bookshelf.refreshBookshelf()

            // Trigger silent metadata sync so cloud index is immediately updated
            this.triggerSilentBackgroundSync()
        } catch (err) {
            console.error('Upload book error:', err)
            this.app.dialogs.showToast(t('syncCtrl.backupFailed', { error: err.message }), 'error')
        } finally {
            this._activeTransfers?.delete(book.id)
        }
    }

    async processAutoDownloadQueue(pendingBooks = []) {
        if (!pendingBooks || pendingBooks.length === 0) return
        if (!this.syncConfig?.enabled) return

        // Prevent race condition: ensure only one auto-download loop runs at a time
        if (this._isAutoDownloading) {
            console.log('[AutoDownload] Queue already in progress, skipping duplicate invocation.')
            return
        }
        this._isAutoDownloading = true

        try {
            console.log(`[AutoDownload] Starting sequential download for ${pendingBooks.length} books...`)
            for (const book of pendingBooks) {
                try {
                    // Check if user deleted this book from local shelf while in queue!
                    const currentBook = await db.getBook(book.id)
                    if (!currentBook) {
                        console.log(`[AutoDownload] Book "${book.title}" was removed, skipping download.`)
                        continue
                    }

                    if (!syncEngine.isAutoDownloadEligible(currentBook)) continue
                    const hasLocal = await db.hasBookFileBlob(currentBook.id)
                    if (hasLocal) continue

                    // If user is currently manually downloading this book, skip duplicate auto download
                    if (this._activeTransfers?.has(currentBook.id)) continue

                    const fileName = currentBook.cloudBackup?.fileName || `${currentBook.stableKey || currentBook.id}.${currentBook.format}`
                    const res = await (await this.getBookStorage()).downloadBookBinary(fileName)
                    if (res && res.success && res.buffer) {
                        // Double check before saving: did the user delete it while downloading?
                        const stillExists = await db.getBook(currentBook.id)
                        if (!stillExists) {
                            console.log(`[AutoDownload] Book "${book.title}" deleted during download, skipping save.`)
                            continue
                        }

                        const mimeType = (currentBook.format === 'pdf') ? 'application/pdf' : 'application/octet-stream'
                        const blob = new Blob([res.buffer], { type: mimeType })
                        if (!await db.saveBookFileBlob(currentBook.id, blob)) continue

                        const freshBook = (await db.getBook(currentBook.id)) || currentBook
                        freshBook.isCloudOnly = false
                        freshBook.hasLocalFile = true
                        freshBook.cloudBackupState = 'synced'
                        freshBook._preserveUpdatedAt = true
                        await db.saveBook(freshBook)

                        // Auto-heal / extract cover for auto-downloaded book
                        if (!freshBook.coverBlob) {
                            await this.app.imports.tryExtractAndSaveCover(freshBook)
                        }

                        console.log(`[AutoDownload] Successfully auto-downloaded: ${freshBook.title}`)

                        // Incrementally refresh bookshelf so UI immediately reflects readiness
                        await this.app.bookshelf.refreshBookshelf()
                    }
                    // Delay 2500ms between downloads to strictly honor Nutstore 30 req/min limit (60s/2.5s = 24 req/min)
                    await new Promise(r => setTimeout(r, 2500))
                } catch (err) {
                    console.warn(`[AutoDownload] Failed downloading ${book.title}:`, err.message)
                }
            }
        } finally {
            this._isAutoDownloading = false
            await this.app.bookshelf.refreshBookshelf()
        }
    }

    async initSyncService() {
        if (!platformBridge?.getSyncConfig) return
        try {
            this.syncConfig = await platformBridge.getSyncConfig()
            if (this.syncConfig?.disableAutoSync && typeof window !== 'undefined') {
                window.__LINDEN_DISABLE_AUTO_SYNC__ = true
            }
        } catch (e) {
            this.syncConfig = {
                enabled: false,
                serverType: 'jianguoyun',
                serverUrl: 'https://dav.jianguoyun.com/dav/',
                username: '',
                password: '',
                hasPassword: false,
                remoteDir: 'LindenLeaf',
                autoSyncOnStartup: true,
                autoSyncOnBookClose: true,
                lastSyncTime: null,
                lastSyncStatus: null,
                lastSyncSummary: null
            }
        }

        this.app.updateUserProfileDisplay()
        if (this.app.bookshelf.dom?.heroGreetingTitle && this.app.bookshelf.shelfCategory === 'all') {
            const greetingData = this.app.bookshelf.getDynamicGreeting()
            this.app.bookshelf.dom.heroGreetingTitle.innerText = greetingData.title
            this.app.bookshelf.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
        }
        this.renderSyncUI()

        // Auto sync on startup
        if (this.syncConfig.enabled && this.syncConfig.autoSyncOnStartup && !this.syncConfig.disableAutoSync) {
            setTimeout(() => {
                this.triggerSilentBackgroundSync()
            }, 1200)
        }
    }

    openWebdavSyncModal() {
        this.renderSyncUI()
        const modal = this.dom.modalWebdavSync || document.getElementById('modal-webdav-sync')
        if (modal) {
            modal.style.display = 'flex'
            void modal.offsetHeight
            modal.classList.add('show')
        }
    }

    closeWebdavSyncModal() {
        const modal = this.dom.modalWebdavSync || document.getElementById('modal-webdav-sync')
        if (modal) {
            modal.classList.remove('show')
            setTimeout(() => {
                if (modal && !modal.classList.contains('show')) {
                    modal.style.display = 'none'
                }
            }, 220)
        }
    }

    setupSyncEventListeners() {
        // Open/close dedicated WebDAV modal
        const btnOpen = this.dom.btnOpenSyncModal || document.getElementById('btn-open-sync-modal')
        btnOpen?.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.openWebdavSyncModal()
        })
        const btnClose = this.dom.btnCloseSyncModal || document.getElementById('btn-close-sync-modal')
        btnClose?.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.closeWebdavSyncModal()
        })
        const modal = this.dom.modalWebdavSync || document.getElementById('modal-webdav-sync')
        modal?.addEventListener('click', e => {
            if (e.target === modal) this.closeWebdavSyncModal()
        })

        // Helper to update field visibility based on active preset
        const updateSyncFieldPanels = (preset) => {
            const fWebdav = document.getElementById('sync-fields-webdav')
            const fOauth = document.getElementById('sync-fields-oauth')
            const fLocal = document.getElementById('sync-fields-local')
            if (fWebdav) fWebdav.style.display = (preset === 'jianguoyun' || preset === 'custom') ? 'block' : 'none'
            if (fOauth) fOauth.style.display = (preset === 'onedrive' || preset === 'google_drive') ? 'block' : 'none'
            if (fLocal) fLocal.style.display = (preset === 'local_folder') ? 'block' : 'none'
        }

        // Preset tab switching
        document.querySelectorAll('.btn-sync-preset')?.forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.btn-sync-preset').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                const preset = btn.dataset.preset
                const serverInput = this.dom.syncInputServer || document.getElementById('sync-input-server')
                if (preset === 'jianguoyun' && serverInput) {
                    serverInput.value = 'https://dav.jianguoyun.com/dav/'
                }
                updateSyncFieldPanels(preset)
            })
        })

        // Pick local folder button
        const btnPickFolder = document.getElementById('btn-sync-pick-folder')
        btnPickFolder?.addEventListener('click', async () => {
            try {
                let folder = null
                if (platformBridge?.dialogPickFolder) {
                    folder = await platformBridge.dialogPickFolder({ title: t('modal.localSyncDir') })
                }
                if (folder) {
                    const input = document.getElementById('sync-input-local-folder')
                    if (input) input.value = folder
                }
            } catch (err) {
                console.warn('Pick folder failed:', err)
            }
        })

        document.getElementById('btn-oauth-cancel')?.addEventListener('click', () => {
            const pending = this._pendingOAuth
            if (!pending || pending.consumed) return
            pending.cancelled = true
            pending.abortController?.abort()
            this.app.dialogs.showToast(t('syncCtrl.signingOut'), 'info')
        })

        // OAuth logout button
        const btnOAuthLogout = document.getElementById('btn-oauth-logout')
        btnOAuthLogout?.addEventListener('click', async () => {
            try {
                const config = this.getSyncConfigFromUI()
                const { getStorageProvider } = await import('./storage-providers.js')
                const provider = getStorageProvider(config.providerType, config)
                if (typeof provider?.logout === 'function') {
                    await provider.logout()
                }
                if (this.syncConfig) {
                    this.syncConfig.hasOAuthToken = false
                }
                const oauthStatus = document.getElementById('sync-oauth-status')
                if (oauthStatus) oauthStatus.innerText = t('syncCtrl.unauthorized')
                this.app.dialogs.showToast(t('syncCtrl.signedOut'))
            } catch (err) {
                this.app.dialogs.showToast(t('syncCtrl.signOutFailed', { error: err.message }))
            }
        })

        // Password visibility toggle (only controls input type for entered text, per S04)
        const btnTogglePwd = this.dom.btnToggleSyncPwd || document.getElementById('btn-toggle-sync-pwd')
        btnTogglePwd?.addEventListener('click', () => {
            const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
            if (!pwdInput) return
            const isPwd = pwdInput.type === 'password'
            if (isPwd) {
                pwdInput.type = 'text'
                btnTogglePwd.setAttribute('title', t('syncCtrl.hidePwd'))
                btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            } else {
                pwdInput.type = 'password'
                btnTogglePwd.setAttribute('title', t('syncCtrl.showPwd'))
                btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
            }
        })

        // Save & Enable Button
        const btnSaveEnable = this.dom.btnSyncSaveEnable || document.getElementById('btn-sync-save-enable')
        btnSaveEnable?.addEventListener('click', async () => {
            const saved = await this.saveSyncConfig({ enabled: true })
            if (!saved) {
                this.app.dialogs.showToast(t('syncCtrl.saveFailed'), 'error')
                return
            }
            this.renderSyncUI()
            this.closeWebdavSyncModal()
            this.app.dialogs.showToast(t('syncCtrl.syncEnabledToast'), 'success')
            this.triggerSilentBackgroundSync()
        })

        // Disable Sync Button
        const btnDisable = this.dom.btnSyncDisable || document.getElementById('btn-sync-disable')
        btnDisable?.addEventListener('click', async () => {
            const saved = await this.saveSyncConfig({ enabled: false })
            if (!saved) {
                this.app.dialogs.showToast(t('syncCtrl.saveSettingsFailed'), 'error')
                return
            }
            this.renderSyncUI()
            this.closeWebdavSyncModal()
            this.app.dialogs.showToast(t('syncCtrl.syncDisabledToast'), 'success')
        })

        // Action buttons inside modal
        const btnTest = this.dom.btnSyncTestConn || document.getElementById('btn-sync-test-conn')
        btnTest?.addEventListener('click', () => this.testSyncConnection())
        const btnTrigger = this.dom.btnSyncTriggerNow || document.getElementById('btn-sync-trigger-now')
        btnTrigger?.addEventListener('click', () => this.triggerManualSync())
    }

    renderSyncUI() {
        if (!this.syncConfig) return
        this.populateSyncForm()
        this.refreshSyncStatusUI()
    }

    populateSyncForm() {
        if (!this.syncConfig) return
        const c = this.syncConfig

        // Form fields inside modal
        const serverInput = this.dom?.syncInputServer || (typeof document !== 'undefined' ? document.getElementById('sync-input-server') : null)
        if (serverInput) serverInput.value = c.serverUrl || 'https://dav.jianguoyun.com/dav/'
        const userInput = this.dom?.syncInputUsername || (typeof document !== 'undefined' ? document.getElementById('sync-input-username') : null)
        if (userInput) userInput.value = c.username || ''
        const pwdInput = this.dom?.syncInputPassword || (typeof document !== 'undefined' ? document.getElementById('sync-input-password') : null)
        const btnTogglePwd = this.dom?.btnToggleSyncPwd || (typeof document !== 'undefined' ? document.getElementById('btn-toggle-sync-pwd') : null)
        if (pwdInput) {
            pwdInput.type = 'password'
            pwdInput.value = c.password || ''
        }
        if (btnTogglePwd) {
            btnTogglePwd.setAttribute('title', t('syncCtrl.showPwd'))
            btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
        }
        const dirInput = this.dom?.syncInputDir || (typeof document !== 'undefined' ? document.getElementById('sync-input-dir') : null)
        if (dirInput) dirInput.value = c.remoteDir || 'LindenLeaf'

        const localFolderInput = typeof document !== 'undefined' ? document.getElementById('sync-input-local-folder') : null
        if (localFolderInput) localFolderInput.value = c.folderPath || ''

        const clientIdInput = typeof document !== 'undefined' ? document.getElementById('sync-input-client-id') : null
        if (clientIdInput) clientIdInput.value = c.clientId || ''

        const includeUserFilesInput = typeof document !== 'undefined' ? document.getElementById('sync-oauth-include-user-files') : null
        if (includeUserFilesInput) {
            includeUserFilesInput.checked = Boolean(c.includeUserFiles)
        }

        // Update preset active button and visible section
        const activePreset = c.serverType || (c.providerType === 'local_folder' ? 'local_folder' : (c.providerType === 'onedrive' ? 'onedrive' : (c.providerType === 'google_drive' ? 'google_drive' : 'jianguoyun')))
        if (typeof document !== 'undefined') {
            document.querySelectorAll('.btn-sync-preset')?.forEach(btn => {
                const isMatch = btn.dataset.preset === activePreset
                btn.classList.toggle('active', isMatch)
            })
            const fWebdav = document.getElementById('sync-fields-webdav')
            const fOauth = document.getElementById('sync-fields-oauth')
            const fLocal = document.getElementById('sync-fields-local')
            if (fWebdav) fWebdav.style.display = (activePreset === 'jianguoyun' || activePreset === 'custom') ? 'block' : 'none'
            if (fOauth) fOauth.style.display = (activePreset === 'onedrive' || activePreset === 'google_drive') ? 'block' : 'none'
            if (fLocal) fLocal.style.display = (activePreset === 'local_folder') ? 'block' : 'none'
        }
    }

    refreshSyncStatusUI() {
        if (!this.syncConfig) return
        const c = this.syncConfig

        // Update sidebar status badge
        const badge = this.dom?.syncStatusBadgeSidebar || (typeof document !== 'undefined' ? document.getElementById('sync-status-badge-sidebar') : null)
        if (badge) {
            if (c.enabled && (c.username || c.folderPath || c.hasOAuthToken || c.clientId)) {
                let typeName = 'WebDAV'
                if (c.serverType === 'jianguoyun') typeName = t('syncCtrl.providerJianguoyun')
                else if (c.providerType === 'onedrive' || c.serverType === 'onedrive') typeName = 'OneDrive'
                else if (c.providerType === 'google_drive' || c.serverType === 'google_drive') typeName = 'Google Drive'
                else if (c.providerType === 'local_folder' || c.serverType === 'local_folder') typeName = t('syncCtrl.providerLocalFolder')
                badge.innerText = t('syncCtrl.badgeEnabled', { provider: typeName })
                badge.style.background = 'rgba(16, 185, 129, 0.12)'
                badge.style.color = '#059669'
            } else {
                badge.innerText = t('settings.syncUnconfigured')
                badge.style.background = 'var(--bg-tertiary)'
                badge.style.color = 'var(--text-muted)'
            }
        }

        const pwdInput = this.dom?.syncInputPassword || (typeof document !== 'undefined' ? document.getElementById('sync-input-password') : null)
        if (pwdInput) pwdInput.placeholder = t(c.hasPassword && !c.password ? 'syncCtrl.pwdSavedPlaceholder' : 'syncCtrl.pwdAppPlaceholder')
        const btnTogglePwd = this.dom?.btnToggleSyncPwd || (typeof document !== 'undefined' ? document.getElementById('btn-toggle-sync-pwd') : null)
        if (btnTogglePwd) btnTogglePwd.setAttribute('title', t(pwdInput?.type === 'text' ? 'syncCtrl.hidePwd' : 'syncCtrl.showPwd'))

        const oauthStatus = typeof document !== 'undefined' ? document.getElementById('sync-oauth-status') : null
        if (oauthStatus) {
            oauthStatus.innerText = c.hasOAuthToken ? t('syncCtrl.authorized') : t('syncCtrl.unauthorized')
        }

        // Update status card
        const dot = this.dom?.syncStatusDot || (typeof document !== 'undefined' ? document.getElementById('sync-status-dot') : null)
        const title = this.dom?.syncStatusTitle || (typeof document !== 'undefined' ? document.getElementById('sync-status-title') : null)
        const desc = this.dom?.syncStatusDesc || (typeof document !== 'undefined' ? document.getElementById('sync-status-desc') : null)

        if (c.lastSyncTime) {
            const locale = getLocale()
            const timeStr = new Date(c.lastSyncTime).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            const dateStr = new Date(c.lastSyncTime).toLocaleDateString(locale)
            const isOk = c.lastSyncStatus === 'success'
            if (dot) dot.innerHTML = `<span class="sync-indicator-dot ${isOk ? 'online' : 'offline'}"></span>`
            if (title) {
                title.innerText = isOk ? t('syncCtrl.statusHealthy') : t('syncCtrl.statusError')
                title.style.color = isOk ? '#059669' : '#dc2626'
            }
            if (desc) desc.innerText = t('syncCtrl.lastSyncLine', { date: dateStr, time: timeStr, summary: c.lastSyncSummary || '' })
        } else {
            if (dot) dot.innerHTML = '<span class="sync-indicator-dot idle"></span>'
            if (title) {
                title.innerText = t('syncCtrl.statusNever')
                title.style.color = 'var(--text-secondary)'
            }
            if (desc) desc.innerText = t('syncCtrl.neverSyncedHint')
        }
    }

    getSyncConfigFromUI() {
        const activePreset = typeof document !== 'undefined' ? document.querySelector('.btn-sync-preset.active')?.dataset.preset : null
        const serverType = activePreset || this.syncConfig?.serverType || 'jianguoyun'
        const serverInput = this.dom?.syncInputServer || (typeof document !== 'undefined' ? document.getElementById('sync-input-server') : null)
        const userInput = this.dom?.syncInputUsername || (typeof document !== 'undefined' ? document.getElementById('sync-input-username') : null)
        const pwdInput = this.dom?.syncInputPassword || (typeof document !== 'undefined' ? document.getElementById('sync-input-password') : null)
        const dirInput = this.dom?.syncInputDir || (typeof document !== 'undefined' ? document.getElementById('sync-input-dir') : null)
        const localFolderInput = typeof document !== 'undefined' ? document.getElementById('sync-input-local-folder') : null
        const clientIdInput = typeof document !== 'undefined' ? document.getElementById('sync-input-client-id') : null
        const includeUserFilesInput = typeof document !== 'undefined' ? document.getElementById('sync-oauth-include-user-files') : null

        let providerType = (serverType === 'local_folder' ? 'local_folder' : 
            (serverType === 'onedrive' ? 'onedrive' : 
            (serverType === 'google_drive' ? 'google_drive' : 'webdav')))
        if (!activePreset && this.syncConfig?.providerType) {
            providerType = this.syncConfig.providerType
        }

        return {
            enabled: this.syncConfig?.enabled || false,
            serverType,
            providerType,
            folderPath: localFolderInput?.value.trim() || this.syncConfig?.folderPath || '',
            clientId: clientIdInput?.value.trim() || this.syncConfig?.clientId || '',
            includeUserFiles: includeUserFilesInput ? includeUserFilesInput.checked : Boolean(this.syncConfig?.includeUserFiles),
            accountId: this.syncConfig?.accountId || '',
            disableAutoSync: this.syncConfig?.disableAutoSync || false,
            hasOAuthToken: this.syncConfig?.hasOAuthToken || false,
            serverUrl: serverInput?.value.trim() || this.syncConfig?.serverUrl || 'https://dav.jianguoyun.com/dav/',
            username: userInput?.value.trim() || this.syncConfig?.username || '',
            password: pwdInput?.value || this.syncConfig?.password || '',
            hasPassword: this.syncConfig?.hasPassword || false,
            remoteDir: dirInput?.value.trim() || this.syncConfig?.remoteDir || 'LindenLeaf',
            autoSyncOnStartup: true,
            autoSyncOnBookClose: true,
            lastSyncTime: this.syncConfig?.lastSyncTime || null,
            lastSyncStatus: this.syncConfig?.lastSyncStatus || null,
            lastSyncSummary: this.syncConfig?.lastSyncSummary || null,
            confirmedEndpoint: this.syncConfig?.confirmedEndpoint || null,
            confirmedEndpoints: this.syncConfig?.confirmedEndpoints || [],
            requiresReview: Boolean(this.syncConfig?.requiresReview),
            lastSyncedEndpoint: this.syncConfig?.lastSyncedEndpoint || null
        }
    }

    async saveSyncConfig(overrideConfig = null) {
        const baseCfg = this.getSyncConfigFromUI()
        const cfg = { ...baseCfg, ...(overrideConfig || {}) }
        if (platformBridge?.saveSyncConfig) {
            try {
                const ok = await platformBridge.saveSyncConfig(cfg)
                if (ok === false) {
                    console.error('[CloudSync] syncSaveConfig returned false')
                    return false
                }
                if (platformBridge.getSyncConfig) {
                    const refreshed = await platformBridge.getSyncConfig()
                    if (refreshed) {
                        this.syncConfig = {
                            ...this.syncConfig,
                            ...refreshed,
                            ...(cfg.lastSyncTime ? {
                                lastSyncTime: cfg.lastSyncTime,
                                lastSyncStatus: cfg.lastSyncStatus,
                                lastSyncSummary: cfg.lastSyncSummary
                            } : {})
                        }
                    }
                } else {
                    this.syncConfig = { ...this.syncConfig, ...cfg }
                }
            } catch (err) {
                console.error('[CloudSync] syncSaveConfig threw error:', err)
                return false
            }
        } else {
            this.syncConfig = { ...this.syncConfig, ...cfg }
        }
        this.app.updateUserProfileDisplay()
        if (this.app.bookshelf.dom?.heroGreetingTitle && this.app.bookshelf.shelfCategory === 'all') {
            const greetingData = this.app.bookshelf.getDynamicGreeting()
            this.app.bookshelf.dom.heroGreetingTitle.innerText = greetingData.title
            this.app.bookshelf.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
        }
        return true
    }

    async testSyncConnection() {
        const saved = await this.saveSyncConfig()
        if (!saved) {
            this.app.dialogs.showToast(t('syncCtrl.saveBeforeTestFailed'), 'error')
            return
        }
        const config = this.syncConfig || {}
        const isOAuth = config.providerType === 'onedrive' || config.providerType === 'google_drive'
        const isLocalFolder = config.providerType === 'local_folder'
        if (isOAuth) {
            if (!config.clientId) {
                this.app.dialogs.showToast(t('syncCtrl.needClientId'), 'warning')
                return
            }
        } else if (isLocalFolder) {
            if (!config.folderPath) {
                this.app.dialogs.showToast(t('syncCtrl.needLocalFolder'), 'warning')
                return
            }
        } else {
            if (!config.username || (!config.password && !config.hasPassword)) {
                this.app.dialogs.showToast(t('syncCtrl.needWebdavCreds'), 'warning')
                return
            }
        }

        const btnTest = this.dom.btnSyncTestConn || document.getElementById('btn-sync-test-conn')
        if (btnTest) {
            btnTest.disabled = true
            btnTest.innerHTML = `<svg class="syncing-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>${t('syncCtrl.testingBtn')}</span>`
        }

        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')

        try {
            let res = null
            if (config.providerType && config.providerType !== 'webdav') {
                try {
                    const { getStorageProvider } = await import('./storage-providers.js')
                    const provider = getStorageProvider(config.providerType, config)
                    res = await provider.authenticate()
                } catch (pErr) {
                    res = { success: false, error: pErr.message || String(pErr) }
                }
            } else if (platformBridge?.testSyncConnection) {
                res = await platformBridge.testSyncConnection(config)
            } else {
                res = { success: true, message: t('syncCtrl.webdavTestOk') }
            }
            if (res.success) {
                if (dot) dot.innerHTML = '<span class="sync-indicator-dot online"></span>'
                if (title) {
                    title.innerText = t('syncCtrl.testPassTitle')
                    title.style.color = '#059669'
                }
                if (desc) desc.innerText = res.message || t('syncCtrl.webdavTestPassDesc')
                this.app.dialogs.showToast(t('syncCtrl.jianguoyunTestOk'), 'cloud')
            } else {
                if (dot) dot.innerHTML = '<span class="sync-indicator-dot offline"></span>'
                if (title) {
                    title.innerText = t('syncCtrl.connectFailedTitle')
                    title.style.color = '#dc2626'
                }
                if (desc) desc.innerText = res.error || t('syncCtrl.webdavUnreachable')
                this.app.dialogs.showToast(res.error || t('syncCtrl.checkCredsError'), 'error')
            }
        } catch (e) {
            if (dot) dot.innerHTML = '<span class="sync-indicator-dot offline"></span>'
            if (title) {
                title.innerText = t('syncCtrl.connectExceptionTitle')
                title.style.color = '#dc2626'
            }
            if (desc) desc.innerText = e.message
            this.app.dialogs.showToast(t('syncCtrl.connectExceptionToast', { error: e.message }), 'error')
        } finally {
            if (btnTest) {
                btnTest.disabled = false
                btnTest.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg><span>${t('syncCtrl.testBtn')}</span>`
            }
        }
    }

    async triggerManualSync() {
        const saved = await this.saveSyncConfig()
        if (!saved) {
            this.app.dialogs.showToast(t('syncCtrl.saveBeforeSyncFailed'), 'error')
            return
        }
        const config = this.syncConfig || {}
        const isOAuth = config.providerType === 'onedrive' || config.providerType === 'google_drive'
        const isLocalFolder = config.providerType === 'local_folder'
        if (isOAuth) {
            if (!config.clientId) {
                this.app.dialogs.showToast(t('syncCtrl.needOAuthClientAndAuth'), 'warning')
                return
            }
        } else if (isLocalFolder) {
            if (!config.folderPath) {
                this.app.dialogs.showToast(t('syncCtrl.needLocalFolder'), 'warning')
                return
            }
        } else {
            if (!config.username || (!config.password && !config.hasPassword)) {
                this.app.dialogs.showToast(t('syncCtrl.needWebdavBeforeSync'), 'warning')
                return
            }
        }

        const btnTrigger = this.dom.btnSyncTriggerNow || document.getElementById('btn-sync-trigger-now')
        if (btnTrigger) {
            btnTrigger.disabled = true
            btnTrigger.innerHTML = `<svg class="syncing-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>${t('syncCtrl.syncingBtn')}</span>`
        }
        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        if (dot) dot.innerHTML = '<span class="sync-indicator-dot syncing"></span>'
        if (title) {
            title.innerText = t('syncCtrl.syncingTitle')
            title.style.color = '#d97706'
        }

        const normFolder = String(config.folderPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
        const endpointIdentity = `${config.providerType || 'webdav'}::${config.serverUrl || ''}::${config.username || config.accountId || ''}::${config.remoteDir || ''}::${normFolder}`
        const isFirstSyncForEndpoint = !config.lastSyncTime || config.lastSyncedEndpoint !== endpointIdentity

        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')
        try {
            let provider = null
            try {
                const { getStorageProvider } = await import('./storage-providers.js')
                provider = getStorageProvider(config.providerType || 'webdav', config)
            } catch (_) {}

            const prep = await this.prepareFirstSync(config, { isManual: true, provider })
            if (!prep?.shouldProceed) return

            const res = await syncEngine.executeSyncLifecycle(config, {
                provider,
                onProgress: (msg) => {
                    if (desc) desc.innerText = msg
                }
            })

            this._lastSyncedUsername = config.username
            this._lastSyncedRemoteDir = config.remoteDir

            const stats = res.stats || {}
            let summaryParts = []
            if (stats.booksUpdated) summaryParts.push(t('syncCtrl.statBooks', { count: stats.booksUpdated }))
            if (stats.highlightsAdded) summaryParts.push(t('syncCtrl.statHighlights', { count: stats.highlightsAdded }))
            if (stats.sessionsAdded) summaryParts.push(t('syncCtrl.statSessions', { count: stats.sessionsAdded }))
            if (stats.listsAdded) summaryParts.push(t('syncCtrl.statLists', { count: stats.listsAdded }))
            const summaryStr = summaryParts.length > 0 ? `(${summaryParts.join(t('syncCtrl.statComma'))})` : t('syncCtrl.statAligned')

            const syncTime = Date.now()
            this.syncConfig.lastSyncTime = syncTime
            this.syncConfig.lastSyncedEndpoint = endpointIdentity
            this.syncConfig.lastSyncStatus = 'success'
            this.syncConfig.lastSyncSummary = summaryStr
            await this.saveSyncConfig({
                lastSyncTime: syncTime,
                lastSyncedEndpoint: endpointIdentity,
                lastSyncStatus: 'success',
                lastSyncSummary: summaryStr
            })
            this.refreshSyncStatusUI()

            const successMsg = isFirstSyncForEndpoint
                ? t('syncCtrl.firstSyncDone', { summary: summaryStr })
                : t('syncCtrl.syncSuccess', { summary: summaryStr })
            this.app.dialogs.showToast(successMsg, 'cloud')
            await this.app.bookshelf.renderCustomListsSidebar()
            await this.app.bookshelf.refreshBookshelf()
            if (this.app.bookshelf.shelfCategory === 'stats') {
                await this.app.stats.renderStatsDashboard()
            }

            if (this.app.currentBookId && res?.deletedBookIds && res.deletedBookIds.includes(this.app.currentBookId)) {
                this.app.dialogs.showToast(t('syncCtrl.bookDeletedRemotely'), 'warning')
                this.app.closeReader()
            }

            if (res?.pendingAutoDownloads && res.pendingAutoDownloads.length > 0) {
                this.processAutoDownloadQueue(res.pendingAutoDownloads)
            }
        } catch (err) {
            console.error('Manual sync error:', err)
            // Item 3: Failed sync must NOT update lastSyncTime as a success record
            this.syncConfig.lastSyncStatus = 'error'
            this.syncConfig.lastSyncSummary = err.message
            await this.saveSyncConfig({
                lastSyncStatus: 'error',
                lastSyncSummary: err.message
            })
            this.refreshSyncStatusUI()
            this.app.dialogs.showToast(t('syncCtrl.syncFailedToast', { error: err.message }), 'error')
        } finally {
            if (btnTrigger) {
                btnTrigger.disabled = false
                btnTrigger.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>${t('syncCtrl.syncNowBtn')}</span>`
            }
        }
    }

    async triggerSilentBackgroundSync() {
        if (typeof process !== 'undefined' && (process.env?.DISABLE_AUTO_SYNC || process.env?.LINDEN_DISABLE_AUTO_SYNC)) return
        if (typeof window !== 'undefined' && (window.DISABLE_AUTO_SYNC || window.__LINDEN_DISABLE_AUTO_SYNC__)) return
        if (!this.syncConfig?.enabled) return
        const config = this.syncConfig || {}
        const isOAuth = config.providerType === 'onedrive' || config.providerType === 'google_drive'
        const isLocalFolder = config.providerType === 'local_folder'
        if (isOAuth) {
            if (!config.clientId || !config.hasOAuthToken) return
        } else if (isLocalFolder) {
            if (!config.folderPath) return
        } else {
            if (!config.username || (!config.password && !config.hasPassword)) return
        }

        const now = Date.now()
        if (this._lastSilentSyncAttempt && (now - this._lastSilentSyncAttempt < 10000)) {
            return // Cooldown 10s
        }
        this._lastSilentSyncAttempt = now

        const normFolder = String(config.folderPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
        const endpointIdentity = `${config.providerType || 'webdav'}::${config.serverUrl || ''}::${config.username || config.accountId || ''}::${config.remoteDir || ''}::${normFolder}`
        try {
            const prep = await this.prepareFirstSync(config, { isManual: false })
            if (!prep?.shouldProceed) return
        } catch (err) {
            console.warn('[CloudSync] Pre-flight check failed, background sync stopped:', err)
            return
        }

        try {
            console.log('[CloudSync] Starting silent background sync with 35s timeout...')
            let provider = null
            try {
                const { getStorageProvider } = await import('./storage-providers.js')
                provider = getStorageProvider(config.providerType || 'webdav', config)
            } catch (_) {}

            const syncPromise = syncEngine.executeSyncLifecycle(config, { provider })
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Silent background sync timeout (35s)')), 35000))
            const res = await Promise.race([syncPromise, timeoutPromise])
            const syncTime = Date.now()
            this.syncConfig.lastSyncTime = syncTime
            this.syncConfig.lastSyncedEndpoint = endpointIdentity
            this.syncConfig.lastSyncStatus = 'success'
            await this.saveSyncConfig({
                lastSyncTime: syncTime,
                lastSyncedEndpoint: endpointIdentity,
                lastSyncStatus: 'success'
            })
            this.refreshSyncStatusUI()
            console.log('[CloudSync] Silent background sync completed successfully:', res?.stats)
            if (this.app.bookshelf.shelfCategory === 'stats') {
                this.app.stats.renderStatsDashboard()
            }

            if (this.app.currentBookId && res?.deletedBookIds && res.deletedBookIds.includes(this.app.currentBookId)) {
                this.app.dialogs.showToast(t('syncCtrl.bookDeletedRemotely'), 'warning')
                this.app.closeReader()
            }

            if (res?.pendingAutoDownloads && res.pendingAutoDownloads.length > 0) {
                this.processAutoDownloadQueue(res.pendingAutoDownloads)
            }
        } catch (e) {
            console.warn('[CloudSync] Silent background sync error (ignored):', e.message)
        }
    }

    async startOAuthLogin(providerType = 'onedrive', options = {}) {
        const { getStorageProvider } = await import('./storage-providers.js')
        const provider = getStorageProvider(providerType, this.syncConfig || {})
        if (typeof provider.startOAuthLogin === 'function') {
            const login = await provider.startOAuthLogin('http://localhost:18520/callback', options)
            return login
        }
        throw new Error(`Provider ${providerType} does not support OAuth login`)
    }

    async prepareFirstSync(config = this.syncConfig, { isManual = false, provider = null } = {}) {
        const cfg = config || {}
        const normFolder = String(cfg.folderPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
        const endpointIdentity = `${cfg.providerType || 'webdav'}::${cfg.serverUrl || ''}::${cfg.username || cfg.accountId || ''}::${cfg.remoteDir || ''}::${normFolder}`
        let confirmed = cfg.confirmedEndpoint === endpointIdentity || (Array.isArray(cfg.confirmedEndpoints) && cfg.confirmedEndpoints.includes(endpointIdentity))
        if (!confirmed && !isManual) {
            cfg.requiresReview = true
            if (this.syncConfig) this.syncConfig.requiresReview = true
            await this.saveSyncConfig?.({ requiresReview: true })
            this.app.dialogs.showToast?.(t('syncCtrl.newEndpointDetected'), 'info')
            return { shouldProceed: false, requiresReview: true, endpointIdentity }
        }
        const first = !cfg.lastSyncTime || cfg.lastSyncedEndpoint !== endpointIdentity
        if (!confirmed || first) {
            if (!provider) {
                const { getStorageProvider } = await import('./storage-providers.js')
                provider = getStorageProvider(cfg.providerType || 'webdav', cfg)
            }
            const preview = await syncEngine.previewSyncPayload(cfg, provider)
            if (!confirmed) {
                const describe = x => t('syncCtrl.previewCount', { books: x.books, highlights: x.highlights, bookmarks: x.bookmarks, sessions: x.sessions })
                const accepted = await this.app.dialogs.showConfirmDialog(
                    t('syncCtrl.firstSyncConfirmTitle'),
                    t('syncCtrl.firstSyncConfirmMsg', {
                        local: describe(preview.local),
                        remoteSuffix: preview.remoteExists ? '' : t('syncCtrl.remoteNoDataSuffix'),
                        remote: describe(preview.remote)
                    })
                )
                if (!accepted) return { shouldProceed: false, cancelled: true, endpointIdentity }
                const confirmedEndpoints = [...new Set([...(cfg.confirmedEndpoints || []), endpointIdentity])]
                const updated = { confirmedEndpoint: endpointIdentity, confirmedEndpoints, requiresReview: false }
                if (!await this.saveSyncConfig(updated)) throw new Error(t('syncCtrl.saveAckFailed'))
                Object.assign(cfg, updated)
                if (this.syncConfig) Object.assign(this.syncConfig, updated)
                confirmed = true
            }
            let backupRes = null
            if (typeof window !== 'undefined' && window.advancedSettings?.createFullDataBackup) {
                backupRes = await window.advancedSettings.createFullDataBackup()
            } else if (typeof db.createFullBackup === 'function') backupRes = await db.createFullBackup()
            if (!backupRes || backupRes.success !== true) throw new Error(backupRes?.error || t('syncCtrl.backupWriteFailed'))
        }
        return { shouldProceed: true, endpointIdentity }
    }

    async handleOAuthCallback(providerType, code, codeVerifier, nonce, includeUserFiles = false) {
        const normalizedType = providerType === 'googledrive' ? 'google_drive' : providerType
        const { getStorageProvider } = await import('./storage-providers.js')
        const provider = getStorageProvider(normalizedType, {
            ...(this.syncConfig || {}),
            providerType: normalizedType,
            accountId: ''
        })
        if (typeof provider.handleOAuthCallback === 'function') {
            const res = await provider.handleOAuthCallback(code, codeVerifier, 'http://localhost:18520/callback', nonce, includeUserFiles)
            if (res && res.success) {
                const resolvedAccountId = res.accountId || provider.accountId
                if (!resolvedAccountId) throw new Error(t('syncCtrl.oauthNoSubject'))
                const updatedCfg = {
                    ...this.syncConfig,
                    providerType: normalizedType,
                    accountId: resolvedAccountId,
                    hasOAuthToken: true
                }
                this.syncConfig = updatedCfg
                await this.saveSyncConfig(updatedCfg)
                this.app.dialogs.showToast(t('syncCtrl.oauthSuccess'), 'cloud')
            }
            return res
        }
        throw new Error(`Provider ${providerType} does not support OAuth callback`)
    }

    async handleOAuthLogin() {
        try {
            if (this._pendingOAuth) { this.app.dialogs.showToast(t('syncCtrl.oauthInProgress'), 'warning'); return }
            const providerType = this.syncConfig?.providerType || document.querySelector('.btn-sync-preset.active')?.dataset.preset || document.getElementById('sync-provider-select')?.value
            if (providerType !== 'onedrive' && providerType !== 'googledrive' && providerType !== 'google_drive') {
                this.app.dialogs.showToast(t('syncCtrl.selectCloudProvider'))
                return
            }
            const clientId = this.syncConfig?.clientId || document.getElementById('sync-input-client-id')?.value?.trim()
            if (!clientId) {
                this.app.dialogs.showToast(t('syncCtrl.needClientId'), 'warning')
                return
            }
            const filesInput = document.getElementById('sync-oauth-include-user-files')
            const includeUserFiles = filesInput ? filesInput.checked : Boolean(this.syncConfig?.includeUserFiles)
            const config = {
                ...(this.syncConfig || {}),
                providerType,
                clientId,
                includeUserFiles
            }
            if (this.dom && typeof this.saveSyncConfig === 'function') {
                await this.saveSyncConfig(config)
            }
            const { getStorageProvider } = await import('./storage-providers.js')
            const provider = getStorageProvider(providerType, this.syncConfig || config)
            if (typeof provider?.startOAuthLogin === 'function') {
                const login = await provider.startOAuthLogin('http://localhost:18520/callback', { includeUserFiles })
                const pendingSession = {
                    providerType,
                    ...login,
                    createdAt: Date.now(),
                    abortController: new AbortController(),
                    consumed: false
                }
                this._pendingOAuth = pendingSession
                const cancelButton = document.getElementById('btn-oauth-cancel')
                if (cancelButton) cancelButton.style.display = ''

                let opened = false
                const openAuthUrl = () => {
                    if (opened || this._pendingOAuth !== pendingSession || pendingSession.consumed || pendingSession.cancelled) return
                    opened = true
                    if (login?.authUrl) {
                        const openPromise = window.platformBridge?.openExternal
                            ? Promise.resolve(window.platformBridge.openExternal(login.authUrl))
                            : (typeof window !== 'undefined' && window.open
                                ? Promise.resolve(Boolean(window.open(login.authUrl, '_blank', 'noopener,noreferrer')))
                                : Promise.resolve(false))
                        openPromise.then((ok) => {
                            if (this._pendingOAuth !== pendingSession || pendingSession.consumed || pendingSession.cancelled) return
                            if (ok === false) {
                                pendingSession.cancelled = true
                                pendingSession.abortController.abort()
                                if (this._pendingOAuth === pendingSession) this._pendingOAuth = null
                                if (cancelButton?.style) cancelButton.style.display = 'none'
                                this.app.dialogs.showToast(t('syncCtrl.oauthStartFailed', { error: 'Unable to open browser' }), 'error')
                                return
                            }
                            this.app.dialogs.showToast(t('syncCtrl.oauthOpenedBrowser'))
                        }).catch((openErr) => {
                            if (this._pendingOAuth !== pendingSession || pendingSession.consumed || pendingSession.cancelled) return
                            pendingSession.cancelled = true
                            pendingSession.abortController.abort()
                            if (this._pendingOAuth === pendingSession) this._pendingOAuth = null
                            if (cancelButton?.style) cancelButton.style.display = 'none'
                            this.app.dialogs.showToast(t('syncCtrl.oauthStartFailed', { error: openErr?.message || String(openErr) }), 'error')
                        })
                    }
                }

                if (typeof window !== 'undefined' && typeof window.platformBridge?.waitOAuthCallback === 'function') {
                    this._pendingOAuthCallbackPromise = Promise.resolve(window.platformBridge.waitOAuthCallback(18520, 180, openAuthUrl, login.state, pendingSession.abortController.signal)).then(async (cbRes) => {
                        if (!cbRes || cbRes.cancelled || pendingSession.cancelled) return cbRes
                        if (cbRes.error) {
                            this.app.dialogs.showToast(t('syncCtrl.oauthIncomplete', { error: cbRes.error }), 'warning')
                            return cbRes
                        }
                        const activePending = this._pendingOAuth
                        const isExpired = !activePending || (Date.now() - (activePending.createdAt || 0) > 10 * 60 * 1000)
                        const hasValidState = typeof cbRes?.state === 'string' &&
                            cbRes.state.length > 0 &&
                            typeof login?.state === 'string' &&
                            login.state.length > 0 &&
                            cbRes.state === login.state &&
                            activePending === pendingSession &&
                            !activePending.consumed
                        if (!hasValidState || isExpired) {
                            this.app.dialogs.showToast(t('syncCtrl.oauthInvalidState'), 'error')
                            return { success: false, error: 'Invalid or missing OAuth state' }
                        }
                        if (typeof cbRes?.code === 'string' && cbRes.code.length > 0) {
                            activePending.consumed = true
                            if (cancelButton) cancelButton.style.display = 'none'
                            return await this.handleOAuthCallback(providerType, cbRes.code, login.codeVerifier, login.nonce, includeUserFiles)
                        }
                        return { success: false, error: 'Missing OAuth authorization code' }
                    }).catch((cbErr) => {
                        this.app.dialogs.showToast(t('syncCtrl.oauthCallbackError', { error: cbErr?.message || cbErr }), 'error')
                        return { success: false, error: cbErr?.message || String(cbErr) }
                    }).finally(() => {
                        if (this._pendingOAuth === pendingSession) this._pendingOAuth = null
                        if (cancelButton) cancelButton.style.display = 'none'
                    })
                } else {
                    this._pendingOAuth = null
                    if (cancelButton) cancelButton.style.display = 'none'
                    throw new Error(t('syncCtrl.oauthNoLocalCallback'))
                }
            }
        } catch (err) {
            this._pendingOAuth?.abortController?.abort()
            this._pendingOAuth = null
            const cancelButton = document.getElementById('btn-oauth-cancel')
            if (cancelButton?.style) cancelButton.style.display = 'none'
            this.app.dialogs.showToast(t('syncCtrl.oauthStartFailed', { error: err.message }))
        }
    }

    async openCloudBookPickerUI(pageToken = null) {
        const panel = document.getElementById('cloud-books-picker-panel')
        const listContainer = document.getElementById('cloud-books-list-container')
        const spaceSelect = document.getElementById('cloud-books-space-select')
        const btnNextPage = document.getElementById('btn-cloud-books-next-page')
        if (panel) panel.style.display = 'block'
        if (listContainer && !pageToken) {
            listContainer.innerHTML = `<div style="color: var(--text-muted); padding: 4px 0;">${escapeHTML(t('syncCtrl.driveLoading'))}</div>`
        }
        try {
            const space = spaceSelect?.value || 'approot'
            const res = await this.browseAndImportCloudBooks({ pageSize: 20, pageToken, space })
            const items = res?.items || []
            if (listContainer) {
                if (!pageToken) listContainer.innerHTML = ''
                if (items.length === 0 && !pageToken) {
                    listContainer.innerHTML = `<div style="color: var(--text-muted); padding: 4px 0;">${escapeHTML(t('syncCtrl.driveEmpty'))}</div>`
                } else {
                    for (const item of items) {
                        const row = document.createElement('div')
                        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 2px; border-bottom: 1px solid var(--border-color);'
                        const nameEl = document.createElement('span')
                        nameEl.textContent = item.name || item.id
                        nameEl.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;'
                        const btnImport = document.createElement('button')
                        btnImport.type = 'button'
                        btnImport.className = 'btn-secondary-action'
                        btnImport.style.cssText = 'padding: 2px 8px; font-size: 0.72rem;'
                        btnImport.textContent = t('syncCtrl.driveImportBtn')
                        btnImport.addEventListener('click', async () => {
                            btnImport.disabled = true
                            btnImport.textContent = t('syncCtrl.driveImportingBtn')
                            try {
                                await this.browseAndImportCloudBooks({ space, selectedFileId: item.id, selectedFileMeta: item })
                                btnImport.textContent = t('syncCtrl.driveImportedBtn')
                            } catch (e) {
                                btnImport.disabled = false
                                btnImport.textContent = t('common.retry')
                                this.app.dialogs.showToast(t('syncCtrl.driveImportFailed', { error: e.message || e }), 'error')
                            }
                        })
                        row.appendChild(nameEl)
                        row.appendChild(btnImport)
                        listContainer.appendChild(row)
                    }
                }
            }
            if (btnNextPage) {
                if (res?.nextPageToken) {
                    btnNextPage.style.display = 'inline-block'
                    btnNextPage.onclick = () => this.openCloudBookPickerUI(res.nextPageToken)
                } else {
                    btnNextPage.style.display = 'none'
                }
            }
            if (spaceSelect && !spaceSelect._boundCloudSpace) {
                spaceSelect._boundCloudSpace = true
                spaceSelect.addEventListener('change', () => this.openCloudBookPickerUI(null))
            }
            return res
        } catch (err) {
            if (listContainer) {
                listContainer.innerHTML = `<div style="color: #dc2626; padding: 4px 0;">${escapeHTML(err.message || String(err))}</div>`
            }
            this.app.dialogs.showToast(t('syncCtrl.driveReadFailed', { error: err.message || err }), 'warning')
            return null
        }
    }

    async browseAndImportCloudBooks({ pageSize = 20, pageToken = null, space = 'approot', selectedFileId = null, selectedFileMeta = null, signal = null } = {}) {
        const providerType = this.syncConfig?.providerType
        if (providerType !== 'onedrive' && providerType !== 'google_drive' && providerType !== 'googledrive') {
            throw new Error(t('syncCtrl.oauthProviderRequired'))
        }
        const normalizedType = providerType === 'googledrive' ? 'google_drive' : providerType
        const { getStorageProvider } = await import('./storage-providers.js')
        const provider = getStorageProvider(normalizedType, this.syncConfig || {})
        const auth = await provider.authenticate()
        if (!auth.success) {
            throw new Error(auth.error || t('syncCtrl.oauthLoginRequired'))
        }
        const listing = await provider.listCloudBooks(pageSize, pageToken, { space })
        if (selectedFileId) {
            let target = selectedFileMeta || (listing.items || []).find(it => it.id === selectedFileId)
            if (!target && typeof provider.getCloudBookMeta === 'function') {
                try {
                    target = await provider.getCloudBookMeta(selectedFileId)
                } catch (_) {}
            }
            if (!target) {
                target = { id: selectedFileId, name: selectedFileId }
            }
            const buf = await provider.downloadCloudBook(target.id, signal)
            const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : (buf?.buffer || []))
            let finalName = target.name || selectedFileId
            const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04
            const isPdf = bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
            const isTxt = (target.mimeType === 'text/plain') || (!isZip && !isPdf && bytes.length > 0 && !bytes.subarray(0, Math.min(bytes.length, 512)).some(b => b === 0))
            if (!/\.[a-zA-Z0-9]+$/.test(finalName)) {
                if (isZip) finalName += '.epub'
                else if (isPdf) finalName += '.pdf'
                else if (isTxt) finalName += '.txt'
                else finalName += '.epub'
            } else if (finalName.endsWith('.pdf') && isZip) {
                finalName = finalName.replace(/\.pdf$/, '.epub')
            } else if (finalName.endsWith('.pdf') && isTxt && !isPdf) {
                finalName = finalName.replace(/\.pdf$/, '.txt')
            }
            const fileObj = new File([buf], finalName)
            const imported = await this.app.importFilesAndWait([fileObj])
            return { listing, imported }
        }
        return listing
    }

    getSafeCloudFileName(book) {
        return buildSafeCloudFileName(book)
    }
}
