import { DomEvents } from './dom-events.js'
import { updater } from './updater.js'
import { platformBridge } from './platformBridge.js'
import { t, getIntlLocale } from './i18n.js'

/** Owns updates UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class UpdateController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}

    }

    initDOM() {
        this.dom = {
            brandVersionDisplay: document.getElementById('brand-version-display'),
            btnCheckUpdates: document.getElementById('btn-check-updates'),
            btnCheckUpdatesText: document.getElementById('btn-check-updates-text'),
            btnOpenGithubRepo: document.getElementById('btn-open-github-repo'),
            appVersionBadgeSidebar: document.getElementById('app-version-badge-sidebar'),
            modalUpdateDialog: document.getElementById('modal-update-dialog'),
            updateModalTitle: document.getElementById('update-modal-title'),
            updateCurrentVersion: document.getElementById('update-current-version'),
            updateLatestVersion: document.getElementById('update-latest-version'),
            updatePublishedDate: document.getElementById('update-published-date'),
            updateReleaseNotes: document.getElementById('update-release-notes'),
            btnCloseUpdateModal: document.getElementById('btn-close-update-modal'),
            btnUpdateLater: document.getElementById('btn-update-later'),
            btnUpdateDownload: document.getElementById('btn-update-download')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;

    }

    dispose() { this.events.dispose(); this._bound = false }

    setupUpdateEventListeners() {
        this.dom.btnCheckUpdates?.addEventListener('click', () => this.handleCheckForUpdates(false))
        this.dom.btnOpenGithubRepo?.addEventListener('click', () => {
            const repoUrl = localStorage.getItem('linden_custom_github_repo_url') || 'https://github.com/j7sz2jpnb2-rgb/linden-leaf'
            platformBridge.openExternal(repoUrl)
        })
        this.dom.btnCloseUpdateModal?.addEventListener('click', () => this.closeUpdateModal())
        this.dom.btnUpdateLater?.addEventListener('click', () => this.closeUpdateModal())
        this.dom.modalUpdateDialog?.addEventListener('click', e => {
            if (e.target === this.dom.modalUpdateDialog) this.closeUpdateModal()
        })
        this.dom.btnUpdateDownload?.addEventListener('click', () => {
            if (this._latestUpdateInfo?.downloadUrl) {
                platformBridge.openExternal(this._latestUpdateInfo.downloadUrl)
            }
            this.closeUpdateModal()
        })
    }

    async initUpdateService() {
        await updater.init()
        if (this.dom.brandVersionDisplay) {
            this.dom.brandVersionDisplay.innerText = `v${updater.currentVersion}`
        }
        if (this.dom.appVersionBadgeSidebar) {
            this.dom.appVersionBadgeSidebar.innerText = `v${updater.currentVersion}`
        }
        if (this.dom.updateCurrentVersion) {
            this.dom.updateCurrentVersion.innerText = `v${updater.currentVersion}`
        }

        // P11: Satellite reader windows skip background update check
        if (!this.app.isSatelliteReaderWindow) {
            setTimeout(async () => {
                await this.handleCheckForUpdates(true)
            }, 8000)
        }
    }

    openUpdateModal(info) {
        if (!this.dom.modalUpdateDialog || this.app.isSatelliteReaderWindow) return
        this._latestUpdateInfo = info
        this._lastFocusedElementBeforeUpdateModal = document.activeElement

        const stripEmoji = (str) => {
            if (!str) return ''
            return str.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F900}-\u{1F9FF}]/gu, '').trim()
        }

        if (this.dom.updateModalTitle) {
            this.dom.updateModalTitle.innerText = t('updater.modalTitle')
        }
        const cleanCurrent = (info.currentVersion || '').replace(/^[vV]/, '')
        const cleanLatest = (info.latestVersion || '').replace(/^[vV]/, '')
        if (this.dom.updateCurrentVersion) {
            this.dom.updateCurrentVersion.innerText = t('updater.currentVersionPrefix', { version: cleanCurrent })
        }
        if (this.dom.updateLatestVersion) {
            this.dom.updateLatestVersion.innerText = t('updater.latestHeader', { version: cleanLatest })
        }
        if (this.dom.updatePublishedDate) {
            this.dom.updatePublishedDate.innerText = info.publishedAt || new Date().toLocaleDateString(getIntlLocale())
        }
        if (this.dom.updateReleaseNotes) {
            let notes = stripEmoji(info.releaseNotes || t('updater.defaultNotes'))
            notes = notes.replace(/#{1,6}\s*/g, '').replace(/\*\*(.*?)\*\*/g, '$1')
            this.dom.updateReleaseNotes.innerText = notes
        }

        this.dom.modalUpdateDialog.style.display = 'flex'
        this.dom.modalUpdateDialog.classList.add('show')

        if (this._updateModalKeyDownHandler) {
            window.removeEventListener('keydown', this._updateModalKeyDownHandler)
        }
        this._updateModalKeyDownHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                this.closeUpdateModal()
                return
            }
            if (e.key === 'Tab') {
                const focusables = this.dom.modalUpdateDialog.querySelectorAll('button:not([disabled]), [tabindex="0"]')
                if (focusables.length === 0) return
                const first = focusables[0]
                const last = focusables[focusables.length - 1]
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault()
                    last.focus()
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }
        window.addEventListener('keydown', this._updateModalKeyDownHandler)
        this.dom.btnUpdateDownload?.focus()
    }

    closeUpdateModal() {
        if (!this.dom.modalUpdateDialog) return
        if (this._updateModalKeyDownHandler) {
            window.removeEventListener('keydown', this._updateModalKeyDownHandler)
            this._updateModalKeyDownHandler = null
        }
        this.dom.modalUpdateDialog.classList.remove('show')
        setTimeout(() => {
            this.dom.modalUpdateDialog.style.display = 'none'
            if (this._lastFocusedElementBeforeUpdateModal?.focus) {
                this._lastFocusedElementBeforeUpdateModal.focus()
                this._lastFocusedElementBeforeUpdateModal = null
            }
        }, 200)
    }

    async handleCheckForUpdates(silent = false) {
        if (!silent && this.dom.btnCheckUpdates) {
            this.dom.btnCheckUpdates.disabled = true
            if (this.dom.btnCheckUpdatesText) this.dom.btnCheckUpdatesText.innerText = t('updater.checking')
        }

        try {
            const res = await updater.checkForUpdates()
            if (res.success) {
                if (res.hasUpdate) {
                    this.openUpdateModal(res)
                } else if (!silent) {
                    this.app.dialogs.showToast(t('updater.upToDate', { version: res.currentVersion }), 'success')
                }
            } else if (!silent) {
                this.app.dialogs.showToast(res.error || t('updater.checkFailed'), 'warning')
            }
        } catch (err) {
            if (!silent) {
                this.app.dialogs.showToast(t('updater.checkError', { message: err.message }), 'warning')
            }
        } finally {
            if (!silent && this.dom.btnCheckUpdates) {
                this.dom.btnCheckUpdates.disabled = false
                if (this.dom.btnCheckUpdatesText) this.dom.btnCheckUpdatesText.innerText = t('settings.checkUpdatesBtn')
            }
        }
    }
}
