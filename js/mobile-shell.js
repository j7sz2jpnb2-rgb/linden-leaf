/**
 * js/mobile-shell.js - Linden Leaf Mobile UI Controller & Adaptive Shell
 * 
 * Features:
 * - 4-Destination Inset Floating Bottom Navigation Bar: 书架 (Shelf), 笔记 (Notes), 搜索 (Search), 我的 (Me)
 * - Floating MiniPlayer -> Expanding to Full Now Playing Sheet
 * - Immersive Reader Tool Layer (Floating Top Bar & 4-Action Bottom Bar: 目录, 显示, 听书, 更多)
 * - Pure SVG System Icons (Zero Emoji for functional controls)
 * - Dedicated Mobile Views:
 *   1. Compact Continue-Reading Card & Responsive Book Grid (No giant greeting screen)
 *   2. Comprehensive Notes View with Exact Position Jump (EPUB CFI & PDF Page)
 *   3. Real Realtime Search (Books & Notes with Race Condition Safeguard)
 *   4. Clean Grouped Me Page (Reading Stats, AI History, WebDAV Sync, Themes, Settings)
 * - Mobile Touch & Long-Press Context Action Sheet for Books
 * - Single Unified Android Back Press Hierarchy & Safe Area Insets
 */

import * as db from './db.js'
import { applyI18n, getLocale, isEnglish, setLocale, t } from './i18n.js'
import { ttsPlayer } from './tts-player.js'
import { platformBridge } from './platformBridge.js'
import { resolveReadingState, setReadingStatus, updateBookTags } from './tags-manager.js'
import { escapeHTML, DEFAULT_READER_NAME, getGreetingPeriodKey, renderEditorialCoverHTML, mapHighlightDisplayColor } from './ui-format.js'
import { getDefaultReaderSettings, resolveEffectiveReaderLayout } from './reader-style-builder.js'
import { FEATURE_CURL_PAGE_TURN_ENABLED } from './page-turn-controller.js'

const LEGACY_DEFAULT_READER_NAMES = new Set(['Linden 读者', '我的书架', '读者'])

function resolveGreetingDisplayName(explicitName = '') {
    const stored = typeof localStorage !== 'undefined' ? (localStorage.getItem('linden_user_name') || '') : ''
    const raw = (typeof explicitName === 'string' && explicitName.trim())
        ? explicitName
        : ((typeof window !== 'undefined' ? window.app?.getUserDisplayName?.() : '') || stored)
    const normalized = String(raw || '').trim()
    if (normalized && !LEGACY_DEFAULT_READER_NAMES.has(normalized)) {
        return normalized
    }
    return DEFAULT_READER_NAME
}

function formatGreetingText(name) {
    const resolvedName = resolveGreetingDisplayName(name)
    const periodKey = getGreetingPeriodKey()
    return t('greeting.titleFormat', {
        prefix: t(`greeting.${periodKey}.title`),
        name: resolvedName
    })
}

function normalizeMobileTurnMode(mode) {
    if (mode === 'curl') {
        return FEATURE_CURL_PAGE_TURN_ENABLED ? 'cover' : 'slide'
    }
    return mode || 'slide'
}

/** Syncs mobile page-turn pill state and experimental curl capability hint. */
function syncMobilePageTurnUI(mode) {
    const resolved = normalizeMobileTurnMode(mode)
    document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(b => {
        const active = b.dataset.mobileTurn === resolved
        b.classList.toggle('active', active)
        b.setAttribute('aria-pressed', String(active))
    })
    const noteEl = document.getElementById('mobile-page-turn-note')
    if (noteEl) {
        noteEl.hidden = resolved !== 'cover' || !FEATURE_CURL_PAGE_TURN_ENABLED
    }
    return resolved
}

function getReadingStatusLabels() {
    return {
        unread: t('status.unread'),
        want_to_read: t('status.wantToRead'),
        reading: t('status.reading'),
        on_hold: t('status.onHold'),
        finished: t('status.finished')
    }
}

function getTtsProviderLabel(provider) {
    const map = {
        system: t('mobileSettings.ttsProvider.system'),
        offline: t('mobileSettings.ttsProvider.offline'),
        api: t('mobileSettings.ttsProvider.api')
    }
    return map[provider] || map.system
}

let _cachedAdvancedSettings = null
async function getAdvancedSettings() {
    if (_cachedAdvancedSettings) return _cachedAdvancedSettings
    if (typeof window !== 'undefined' && window.advancedSettings) {
        _cachedAdvancedSettings = window.advancedSettings
        return _cachedAdvancedSettings
    }
    const mod = await import('./advanced-settings.js')
    _cachedAdvancedSettings = mod.advancedSettings
    return _cachedAdvancedSettings
}

let _MobileSettingsClass = null
async function getMobileSettingsClass() {
    if (_MobileSettingsClass) return _MobileSettingsClass
    const mod = await import('./mobile-settings.js')
    _MobileSettingsClass = mod.MobileSettings
    return _MobileSettingsClass
}

function getBookFraction(book) {
    if (!book) return 0
    if (typeof book.progress === 'number' && Number.isFinite(book.progress)) {
        return Math.max(0, Math.min(1, book.progress))
    }
    if (book.progress && typeof book.progress.fraction === 'number' && Number.isFinite(book.progress.fraction)) {
        return Math.max(0, Math.min(1, book.progress.fraction))
    }
    if (typeof book.progressPercentage === 'number' && Number.isFinite(book.progressPercentage)) {
        return Math.max(0, Math.min(1, book.progressPercentage / 100))
    }
    if (resolveReadingState(book) === 'finished') {
        return 1
    }
    return 0
}

export function getBookCoverUrl(book) {
    if (!book) return null
    if (book.coverBlob && window.coverUrlPool) {
        return window.coverUrlPool.getForBook(book)
    }
    if (book.cover && typeof book.cover === 'string' && !book.cover.includes('icon.png')) {
        const trimmed = book.cover.trim()
        if (/^(blob:|data:image\/|https:\/\/|http:\/\/|\.\/|assets\/)/i.test(trimmed)) {
            return trimmed
        }
    }
    return null
}

export function renderBookCoverHTML(book, extraClass = '', isThumb = false) {
    const url = getBookCoverUrl(book)
    const title = book?.title || t('book.untitled')

    if (url) {
        return `<img class="mobile-book-cover-img ${escapeHTML(extraClass)}" src="${escapeHTML(url)}" alt="${escapeHTML(title)}" loading="lazy"/>`
    }

    return renderEditorialCoverHTML(book, {
        thumb: Boolean(isThumb),
        extraClass: escapeHTML(extraClass),
    })
}

if (typeof window !== 'undefined') {
    window.getBookCoverUrl = getBookCoverUrl
    window.renderBookCoverHTML = renderBookCoverHTML
}

export function formatNoteDate(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    try {
        return d.toLocaleString(getLocale(), {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    } catch {
        const year = d.getFullYear()
        const month = d.getMonth() + 1
        const day = d.getDate()
        const hour = String(d.getHours()).padStart(2, '0')
        const min = String(d.getMinutes()).padStart(2, '0')
        return `${year}/${month}/${day} ${hour}:${min}`
    }
}

export class MobileShellController {
    constructor() {
        this.currentTab = 'home' // 'home' | 'shelf' | 'notes' | 'me' | 'search'
        this.activeSheet = null // null | 'toc' | 'display' | 'more' | 'book-action'
        this.isNowPlayingOpen = false
        this.readerToolsVisible = false
        this.selectedBookForAction = null
        this.longPressTimer = null
        this.homeGeneration = 0
        this.shelfFilter = 'all'
        this.notesGeneration = 0
        this.meGeneration = 0
        this.searchGeneration = 0
        this.isInReader = false
        this._settingsPageInstance = null
        this._settingsOpenToken = 0
        this.settingsPage = {
            open: async (group) => {
                const token = ++this._settingsOpenToken
                const sp = await this.ensureSettingsPage()
                if (token !== this._settingsOpenToken) return
                return sp.open(group)
            },
            close: () => {
                this._settingsOpenToken++
                this._settingsPageInstance?.close?.()
            },
            back: () => {
                if (!this._settingsPageInstance) {
                    this._settingsOpenToken++
                    return false
                }
                return this._settingsPageInstance.back?.() ?? false
            }
        }

        this.init()
    }

    async ensureSettingsPage() {
        if (!this._settingsPageInstance) {
            const Cls = await getMobileSettingsClass()
            this._settingsPageInstance = new Cls(this)
            Object.assign(this.settingsPage, this._settingsPageInstance)
        }
        return this._settingsPageInstance
    }

    init() {
        if (typeof window === 'undefined') return

        // 1. Inject DOM structures
        this.injectMobileDOM()

        // 2. Setup listeners
        this.setupNavigationListeners()
        this.setupMiniPlayerListeners()
        this.setupReaderToolListeners()
        this.setupLongPressListeners()

        // 3. Monitor Viewport & Resize
        window.addEventListener('resize', () => this.handleResize())
        window.addEventListener('orientationchange', () => setTimeout(() => this.handleResize(), 80))
        if (window.visualViewport && !platformBridge.isAndroid) {
            const handleViewportChange = () => {
                const isShort = window.visualViewport.height < window.innerHeight * 0.78
                const keyboardHeight = Math.max(0, window.innerHeight - window.visualViewport.height - (window.visualViewport.offsetTop || 0))
                const imePx = (isShort || keyboardHeight > 50) ? `${Math.round(keyboardHeight)}px` : '0px'
                document.documentElement.classList.toggle('keyboard-open', isShort || keyboardHeight > 50)
                document.documentElement.style.setProperty('--ime-bottom', imePx)
                document.documentElement.style.setProperty('--ime-inset-bottom', imePx)
                document.documentElement.style.setProperty('--viewport-keyboard-offset', imePx)
            }
            window.visualViewport.addEventListener('resize', handleViewportChange)
            window.visualViewport.addEventListener('scroll', handleViewportChange)
            handleViewportChange()
        }
        this.handleResize()

        // 4. Hook TTS Player State Changes
        ttsPlayer.onStateChange((state) => {
            this.updateMiniPlayerState(state)
            this.updateNowPlayingState(state)
        })

        // 5. Initial Refresh of Tabs (skip if opening directly into reader / satellite window)
        const isSatelliteReader = document.documentElement.classList.contains('satellite-reader-window')
        if (!this.isInReader && !isSatelliteReader) {
            this.switchTab('home')
        }
        platformBridge.syncSystemInsets?.().catch?.(() => {})
        fetch('./build-info.json').then(r => r.ok ? r.json() : null).then(info => {
            const label = document.getElementById('mobile-app-version')
            if (label && info?.version) {
                label.dataset.hasVersion = '1'
                label.textContent = `v${info.version}`
            }
        }).catch(() => {})
    }

    isMobileViewport() {
        if (platformBridge.isAndroid) return true
        // Keep Windows/desktop side-by-side companion docked mode in desktop UI down to 480px width
        if (platformBridge.isTauri && window.app?.externalCompanion?.isActive && window.innerWidth >= 480) {
            return false
        }
        return window.innerWidth < 768
    }

    syncViewportArtifacts(isMobile) {
        const searchBar = document.getElementById('mobile-shelf-search-bar')
        if (searchBar) searchBar.style.display = isMobile ? '' : 'none'

        const segControl = document.getElementById('mobile-shelf-segmented-control')
        if (segControl) segControl.style.display = isMobile ? '' : 'none'

        if (!isMobile) {
            document.body.classList.remove('mobile-ai-history-active')
            document.getElementById('mobile-history-actions-dialog')?.close()
            this.activeSubviewKey = null
            document.body.classList.remove('mobile-subview-active')
            const subHeader = document.getElementById('mobile-subview-header')
            if (subHeader) subHeader.style.display = 'none'
        }
    }

    handleResize() {
        const isMobile = this.isMobileViewport()
        const viewportChanged = this._mobileViewport !== isMobile
        this._mobileViewport = isMobile
        document.documentElement.classList.toggle('is-mobile-viewport', isMobile)

        const mobileRoot = document.getElementById('mobile-shell-root')
        if (mobileRoot) {
            mobileRoot.style.display = isMobile ? 'block' : 'none'
        }

        const shelfArea = document.getElementById('bookshelf-view')
        const readerView = document.getElementById('reader-view')
        const isReaderActive = Boolean(
            this.isInReader ||
            this._homeOpeningBookId ||
            window.app?._activeSession ||
            (readerView && readerView.classList.contains('active') && (window.getComputedStyle ? window.getComputedStyle(readerView).display !== 'none' : readerView.style.display === 'block'))
        )

        if (!isMobile) {
            this.settingsPage.close()
            this.syncViewportArtifacts(false)
            // Restore desktop view
            if (!isReaderActive && shelfArea) {
                shelfArea.style.display = 'flex'
                if (viewportChanged) window.app?.refreshBookshelf()
            }
            document.getElementById('books-grid')?.classList.remove('is-list-mode')
            this.closeAllSheets()
            this.closeNowPlayingSheet()
            this.setReaderToolsVisible(false)
        } else {
            this.syncViewportArtifacts(true)
            // Keyboard and width changes must preserve an open stats/history subview.
            if (!isReaderActive && !this.activeSubviewKey) {
                this.switchTab(this.currentTab || 'home')
            }
        }
    }

    _setReaderLoadingIndicator(visible, bookTitle = '') {
        if (typeof document === 'undefined') return
        const host = document.getElementById('reader-content-area') || document.getElementById('reader-view')
        let overlay = document.getElementById('mobile-reader-loading-overlay')
        if (!visible) {
            if (overlay) {
                overlay.hidden = true
                overlay.style.display = 'none'
            }
            return
        }
        if (!host) return
        if (!overlay) {
            overlay = document.createElement('div')
            overlay.id = 'mobile-reader-loading-overlay'
            overlay.setAttribute('role', 'status')
            overlay.setAttribute('aria-live', 'polite')
            overlay.style.cssText = [
                'position: absolute',
                'inset: 0',
                'z-index: 25',
                'display: flex',
                'flex-direction: column',
                'align-items: center',
                'justify-content: center',
                'gap: 8px',
                'padding: 24px',
                'text-align: center',
                'pointer-events: none',
                'background: var(--book-bg, var(--bg-primary, var(--mobile-bg-page, #faf9f5)))',
                'color: var(--text-muted, var(--mobile-text-muted, #6b7280))'
            ].join('; ')
            overlay.innerHTML = `
                <div class="mobile-reader-loading-title" style="font-size: 15px; font-weight: 600; color: var(--text-primary, var(--mobile-text, inherit)); max-width: 80vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></div>
                <div class="mobile-reader-loading-label" style="font-size: 13px; opacity: 0.78;"></div>
            `
            host.appendChild(overlay)
        }
        const titleNode = overlay.querySelector('.mobile-reader-loading-title')
        const labelNode = overlay.querySelector('.mobile-reader-loading-label')
        if (titleNode) titleNode.textContent = bookTitle || ''
        if (labelNode) labelNode.textContent = t('common.loading')
        overlay.hidden = false
        overlay.style.display = 'flex'
    }

    finishReaderSessionLoading() {
        this._isReaderSessionLoading = false
        this._setReaderLoadingIndicator(false)
    }

    beginReaderSessionLoading(bookTitle = '') {
        this._isReaderSessionLoading = true
        this._pdfScrubbing = false
        this._pdfScrubBook = null
        this.hasReaderChapter = false

        const resolvedTitle = (typeof bookTitle === 'string' && bookTitle.trim())
            ? bookTitle.trim()
            : t('mobile.reader.defaultTitle')
        const titleEl = document.getElementById('mobile-reader-title')
        if (titleEl) titleEl.innerText = resolvedTitle
        const chapterEl = document.getElementById('mobile-reader-chapter-name')
        if (chapterEl) chapterEl.innerText = t('search.currentChapter')
        const progressEl = document.getElementById('mobile-reader-progress-pct')
        if (progressEl) progressEl.innerText = '0%'

        const tocContainer = document.getElementById('mobile-toc-container')
        if (tocContainer) tocContainer.innerHTML = ''
        const pageSlider = document.getElementById('mobile-pdf-page-slider')
        if (pageSlider) {
            pageSlider.value = '1'
            pageSlider.max = '1'
            pageSlider.disabled = true
        }

        this.closeNowPlayingSheet()
        this.setReaderInView(true)
        this._setReaderLoadingIndicator(true, resolvedTitle)

        document.body.classList.remove('mobile-pdf-reading', 'mobile-pdf-tools-visible')
        for (const id of ['mobile-pdf-page-badge', 'mobile-pdf-reset-zoom', 'mobile-pdf-progress']) {
            const el = document.getElementById(id)
            if (el) el.hidden = true
        }
    }

    setReaderInView(inReader, options = {}) {
        this.settingsPage.close()
        this.isInReader = inReader
        document.body.classList.toggle('mobile-reader-active', inReader)
        const navBar = document.getElementById('mobile-nav-bar')
        if (navBar) {
            navBar.classList.toggle('hidden-in-reader', inReader)
        }
        if (inReader) {
            const shelfArea = document.getElementById('bookshelf-view')
            if (shelfArea) shelfArea.style.display = 'none'
            const shelfHeader = document.getElementById('mobile-header-bar')
            if (shelfHeader) shelfHeader.style.display = 'none'
            const shelfPalette = document.getElementById('btn-mobile-palette')
            if (shelfPalette) shelfPalette.style.display = 'none'
            if (document.body.classList.contains('mobile-subview-active') || this.activeSubviewKey) {
                this.activeSubviewKey = null
                document.body.classList.remove('mobile-subview-active', 'mobile-ai-history-active')
                const subHeader = document.getElementById('mobile-subview-header')
                if (subHeader) subHeader.style.display = 'none'
            }
            // Deactivate all mobile tabs and bottom bar active states when reader is open
            document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
            document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))
            this.closeAllSheets()
            this.setReaderToolsVisible(false)
            this.syncPdfControls()
            this.updateMiniPlayerState(ttsPlayer.state)
        } else {
            this._homeOpeningBookId = null
            this.finishReaderSessionLoading()
            document.body.classList.remove('mobile-pdf-reading', 'mobile-pdf-tools-visible')
            this._pdfScrubbing = false
            this._pdfScrubBook = null
            this.hasReaderChapter = false
            const chapterEl = document.getElementById('mobile-reader-chapter-name')
            if (chapterEl) chapterEl.innerText = t('search.currentChapter')
            const titleEl = document.getElementById('mobile-reader-title')
            if (titleEl) titleEl.innerText = t('mobile.reader.defaultTitle')
            this.setReaderToolsVisible(false)
            this.switchTab(this.currentTab || 'home', { skipRender: Boolean(options?.deferRender), force: true })
        }
    }

    injectMobileDOM() {
        if (document.getElementById('mobile-shell-root')) return

        const root = document.createElement('div')
        root.id = 'mobile-shell-root'
        root.className = 'mobile-shell-root'

        root.innerHTML = `
            <!-- Tab 1: Reading Home -->
            <section id="mobile-home-view" class="mobile-view-container mobile-only active">
                <header class="mobile-home-top-bar" id="mobile-home-top-bar">
                    <div class="home-top-left">
                        <h1 class="mobile-reading-title mobile-home-title" data-i18n="mobile.nav.home">${t('mobile.nav.home')}</h1>
                        <p class="mobile-reading-greeting" id="mobile-home-greeting">${escapeHTML(formatGreetingText(resolveGreetingDisplayName()))}</p>
                    </div>
                    <div class="home-top-actions">
                        <button id="btn-home-menu" class="mobile-header-circle-btn" title="${escapeHTML(t('mobile.home.moreSettingsTitle'))}" data-i18n-title="mobile.home.moreSettingsTitle">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                        </button>
                    </div>
                </header>

                <div class="mobile-home-cards-container" id="mobile-home-cards-container">
                    <!-- Populated dynamically by renderHomeTab() -->
                </div>
            </section>

            <!-- Mobile Bookshelf Header Bar -->
            <header id="mobile-header-bar" class="mobile-header-bar mobile-only" style="display: none;">
                <div class="mobile-header-title-group">
                    <h1 class="mobile-header-title" data-i18n="mobile.nav.shelf">${t('mobile.nav.shelf')}</h1>
                    <span class="mobile-header-subtitle" id="mobile-shelf-book-count">${escapeHTML(t('mobile.shelf.countDefault', { count: 0 }))}</span>
                </div>
                <div class="mobile-header-actions">
                    <button id="btn-mobile-shelf-filter" class="mobile-icon-btn" title="${escapeHTML(t('mobile.shelf.filterTitle'))}" data-i18n-title="mobile.shelf.filterTitle">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
                    </button>
                    <button id="btn-mobile-import-book" class="mobile-icon-btn" title="${escapeHTML(t('mobile.shelf.importBook'))}" data-i18n-title="mobile.shelf.importBook">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                </div>
            </header>

            <!-- Tab 3: Mobile Notes View -->
            <section id="mobile-notes-view" class="mobile-view-container mobile-only">
                <header class="mobile-notes-header">
                    <div class="notes-header-left">
                        <h1 class="mobile-notes-title" data-i18n="mobile.nav.notes">${t('mobile.nav.notes')}</h1>
                    </div>
                    <div class="notes-header-actions">
                        <button id="btn-mobile-export-notes" type="button" disabled class="mobile-header-circle-btn" title="${escapeHTML(t('mobile.notes.copyAllTitle'))}" data-i18n-title="mobile.notes.copyAllTitle">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                        </button>
                        <button id="btn-mobile-notes-avatar" class="mobile-header-circle-btn" title="${escapeHTML(t('mobile.notes.profileCenterTitle'))}" data-i18n-title="mobile.notes.profileCenterTitle">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </button>
                    </div>
                </header>
                <div id="mobile-notes-list" class="mobile-notes-list">
                    <!-- Populated dynamically -->
                </div>
                <button id="btn-mobile-notes-fab" class="mobile-notes-fab" title="${escapeHTML(t('mobile.notes.addTitle'))}" data-i18n-title="mobile.notes.addTitle">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
            </section>

            <!-- Search Subview (Triggered from Bookshelf) -->
            <section id="mobile-search-view" class="mobile-view-container mobile-only">
                <div class="mobile-search-header">
                    <button id="btn-mobile-search-back" class="mobile-icon-btn" title="${escapeHTML(t('mobile.common.backToShelfTitle'))}" data-i18n-title="mobile.common.backToShelfTitle">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <div class="mobile-search-input-box">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" id="mobile-search-input" placeholder="${escapeHTML(t('mobile.search.inputPlaceholder'))}" data-i18n-placeholder="mobile.search.inputPlaceholder" autocomplete="off"/>
                        <button id="btn-mobile-clear-search" class="mobile-search-clear-btn" style="display: none;">✕</button>
                    </div>
                </div>
                <div id="mobile-search-results" class="mobile-search-results">
                    <!-- Populated dynamically -->
                </div>
            </section>

            <section id="mobile-me-view" class="mobile-view-container mobile-only">
                <header class="mobile-me-header"><h1 class="mobile-header-title" data-i18n="mobileSettings.tabMe">${t('mobileSettings.tabMe')}</h1></header>
                <div class="mobile-profile-hero">
                    <button type="button" class="mobile-profile-user-row" id="cell-open-profile">
                        <span class="mobile-profile-info"><span class="mobile-profile-name" id="mobile-user-name">${DEFAULT_READER_NAME}</span><span class="mobile-profile-sub" data-i18n="mobile.me.profileSubtitle">${t('mobile.me.profileSubtitle')}</span></span>
                        <span class="mobile-profile-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span>
                    </button>
                    <button type="button" class="mobile-profile-stats-card" id="cell-profile-stats" aria-label="${escapeHTML(t('mobile.me.viewStatsAria'))}" data-i18n-aria-label="mobile.me.viewStatsAria">
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-hours">${escapeHTML(t('time.minutes', { count: 0 }))}</span><span class="mobile-stat-key" data-i18n="mobile.stats.readingTime">${t('mobile.stats.readingTime')}</span></span>
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-books">0</span><span class="mobile-stat-key" data-i18n="mobile.me.statBooks">${t('mobile.me.statBooks')}</span></span>
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-notes">0</span><span class="mobile-stat-key" data-i18n="mobile.me.statNotes">${t('mobile.me.statNotes')}</span></span>
                    </button>
                </div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title" data-i18n="mobile.me.groupRecords">${t('mobile.me.groupRecords')}</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-stats"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="nav.readingStats">${t('nav.readingStats')}</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-ai-history"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="nav.aiHistory">${t('nav.aiHistory')}</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title" data-i18n="mobile.me.groupPreferences">${t('mobile.me.groupPreferences')}</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-display-theme"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobileSettings.group.appearance.title">${t('mobileSettings.group.appearance.title')}</span></span><span class="mobile-cell-right"><span id="mobile-current-theme-name">${escapeHTML(t('mobile.theme.light'))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-tts-settings"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobileSettings.group.tts.title">${t('mobileSettings.group.tts.title')}</span></span><span class="mobile-cell-right"><span id="mobile-tts-engine-name">${escapeHTML(t('mobileSettings.ttsProvider.system'))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-toggle-language"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobile.me.languageLabel">${t('mobile.me.languageLabel')}</span></span><span class="mobile-cell-right"><span id="mobile-current-language-name">${escapeHTML(isEnglish() ? t('settings.langEnBtn') : t('settings.langZhBtn'))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-advanced-settings"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobile.me.allSettings">${t('mobile.me.allSettings')}</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title" data-i18n="mobile.me.groupDataApp">${t('mobile.me.groupDataApp')}</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-webdav"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobile.me.cloudSync">${t('mobile.me.cloudSync')}</span></span><span class="mobile-cell-right"><span id="mobile-sync-status-text">${escapeHTML(t('settings.syncUnconfigured'))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-backup"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobileSettings.group.backup.title">${t('mobileSettings.group.backup.title')}</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-about-app"><span class="mobile-cell-left"><span class="mobile-cell-label" data-i18n="mobileSettings.group.about.title">${t('mobileSettings.group.about.title')}</span></span><span class="mobile-cell-right"><span id="mobile-app-version">${escapeHTML(t('mobile.me.versionInfo'))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
            </section>

            <!-- Floating Mini-Player -->
            <div id="mobile-mini-player" class="mobile-mini-player mobile-only" style="display: none;">
                <div class="mini-cover-thumb" id="mini-player-cover"></div>
                <div class="mini-meta-box">
                    <span class="mini-title" id="mini-player-title">${escapeHTML(t('tts.mediaTitleFallback'))}</span>
                    <span class="mini-snippet" id="mini-player-snippet">${escapeHTML(t('mobile.miniPlayer.ready'))}</span>
                </div>
                <div class="mini-actions">
                    <button id="btn-mini-play-pause" class="mini-btn" title="${escapeHTML(t('mobile.tts.playPauseTitle'))}" data-i18n-title="mobile.tts.playPauseTitle">
                        <svg id="mini-icon-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
                        <svg id="mini-icon-pause" viewBox="0 0 24 24" style="display: none;"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>
                    </button>
                    <button id="btn-mini-next" class="mini-btn" title="${escapeHTML(t('tts.nextParaTitle'))}" data-i18n-title="tts.nextParaTitle">
                        <svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                </div>
            </div>

            <!-- Full Now Playing Sheet -->
            <div id="mobile-now-playing-sheet" class="mobile-now-playing-sheet mobile-only">
                <div class="now-playing-header">
                    <button id="btn-now-playing-collapse" class="now-playing-collapse-btn" title="${escapeHTML(t('mobile.nowPlaying.collapseTitle'))}" data-i18n-title="mobile.nowPlaying.collapseTitle">
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <span class="now-playing-header-title" data-i18n="mobile.nowPlaying.headerTitle">${t('mobile.nowPlaying.headerTitle')}</span>
                    <div style="width: 36px;"></div>
                </div>

                <div class="now-playing-artwork-wrap" id="np-artwork-wrap"></div>

                <div class="now-playing-title-box">
                    <h2 class="now-playing-book-title" id="np-book-title">${escapeHTML(t('mobile.nowPlaying.defaultBookTitle'))}</h2>
                    <p class="now-playing-chapter-title" id="np-chapter-title">${escapeHTML(t('mobile.nowPlaying.defaultChapterTitle'))}</p>
                </div>

                <div class="now-playing-paragraph-card" id="np-paragraph-text">
                    ${escapeHTML(t('mobile.nowPlaying.tapPlayPrompt'))}
                </div>

                <div class="now-playing-progress-wrap">
                    <input type="range" id="np-progress-slider" class="now-playing-slider" min="0" max="100" value="0"/>
                    <div class="now-playing-time-row">
                        <span id="np-progress-cur">${escapeHTML(t('mobile.nowPlaying.segmentCurrent', { current: 1 }))}</span>
                        <span id="np-progress-total">${escapeHTML(t('mobile.nowPlaying.segmentTotal', { total: 1 }))}</span>
                    </div>
                </div>

                <div class="now-playing-main-controls">
                    <button id="btn-np-prev" class="np-btn np-btn-step" title="${escapeHTML(t('tts.prevParaTitle'))}" data-i18n-title="tts.prevParaTitle">
                        <svg viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20" fill="currentColor"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                    <button id="btn-np-play-pause" class="np-btn np-btn-play" title="${escapeHTML(t('mobile.tts.playPauseTitle'))}" data-i18n-title="mobile.tts.playPauseTitle">
                        <svg id="np-icon-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
                        <svg id="np-icon-pause" viewBox="0 0 24 24" style="display: none;"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>
                    </button>
                    <button id="btn-np-next" class="np-btn np-btn-step" title="${escapeHTML(t('tts.nextParaTitle'))}" data-i18n-title="tts.nextParaTitle">
                        <svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                </div>

                <div class="now-playing-secondary-row">
                    <button id="btn-np-rate" class="np-pill-opt" title="${escapeHTML(t('tts.rateTitle'))}" data-i18n-title="tts.rateTitle">
                        <span id="np-rate-label">1.0x</span>
                    </button>
                    <button id="btn-np-timer" class="np-pill-opt" title="${escapeHTML(t('tts.sleepTitle'))}" data-i18n-title="tts.sleepTitle">
                        <span id="np-timer-label">${escapeHTML(t('mobile.nowPlaying.timerOff'))}</span>
                    </button>
                    <button id="btn-np-engine" class="np-pill-opt" title="${escapeHTML(t('tts.engineTitle'))}" data-i18n-title="tts.engineTitle">
                        <span id="np-engine-label">${escapeHTML(t('mobileSettings.ttsProvider.system'))}</span>
                    </button>
                </div>
            </div>

            <!-- Docked Bottom 4-Destination Navigation Bar -->
            <nav id="mobile-nav-bar" class="mobile-nav-bar mobile-only">
                <button class="mobile-nav-tab active" data-tab="home" id="tab-btn-home" aria-label="${escapeHTML(t('mobile.nav.home'))}" data-i18n-aria-label="mobile.nav.home">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                    </div>
                    <span class="mobile-nav-label" data-i18n="mobile.nav.home">${t('mobile.nav.home')}</span>
                </button>
                <button class="mobile-nav-tab" data-tab="shelf" id="tab-btn-shelf" aria-label="${escapeHTML(t('mobile.nav.shelf'))}" data-i18n-aria-label="mobile.nav.shelf">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    </div>
                    <span class="mobile-nav-label" data-i18n="mobile.nav.shelf">${t('mobile.nav.shelf')}</span>
                </button>
                <button class="mobile-nav-tab" data-tab="notes" id="tab-btn-notes" aria-label="${escapeHTML(t('mobile.nav.notes'))}" data-i18n-aria-label="mobile.nav.notes">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-10 10-5 1 1-5Z"/><path d="m14 5 5 5"/></svg>
                    </div>
                    <span class="mobile-nav-label" data-i18n="mobile.nav.notes">${t('mobile.nav.notes')}</span>
                </button>
                <button class="mobile-nav-tab" data-tab="me" id="tab-btn-me" aria-label="${escapeHTML(t('mobileSettings.tabMe'))}" data-i18n-aria-label="mobileSettings.tabMe">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </div>
                    <span class="mobile-nav-label" data-i18n="mobileSettings.tabMe">${t('mobileSettings.tabMe')}</span>
                </button>
            </nav>

            <!-- Immersive Reader Floating Mobile Top Bar -->
            <div id="mobile-reader-top-bar" class="mobile-reader-top-bar mobile-only">
                <button id="btn-mobile-reader-back" class="mobile-icon-btn" title="${escapeHTML(t('mobile.common.backToShelfTitle'))}" data-i18n-title="mobile.common.backToShelfTitle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <span id="mobile-reader-title" class="mobile-reader-title">${escapeHTML(t('mobile.reader.defaultTitle'))}</span>
                <button id="btn-mobile-reader-ai" class="mobile-icon-btn" title="${escapeHTML(t('mobile.reader.aiTitle'))}" data-i18n-title="mobile.reader.aiTitle">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                </button>
            </div>

            <!-- Immersive Reader Floating Mobile Bottom Bar (4 Tools) -->
            <div id="mobile-reader-bottom-bar" class="mobile-reader-bottom-bar mobile-only">
                <div id="mobile-pdf-progress" class="mobile-pdf-progress" hidden>
                    <button id="btn-mobile-pdf-page" class="mobile-pdf-page-number" aria-label="${escapeHTML(t('mobile.pdf.jumpPageTitle'))}" data-i18n-aria-label="mobile.pdf.jumpPageTitle">1 / 1</button>
                    <input id="mobile-pdf-page-slider" type="range" min="1" max="1" value="1" aria-label="${escapeHTML(t('mobile.pdf.pageSliderAria'))}" data-i18n-aria-label="mobile.pdf.pageSliderAria"/>
                </div>
                <div class="mobile-reader-tools-row">
                    <button id="btn-tool-toc" class="mobile-reader-tool-btn" title="${escapeHTML(t('reader.drawer.toc'))}" data-i18n-title="reader.drawer.toc">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        <span data-i18n="reader.drawer.toc">${t('reader.drawer.toc')}</span>
                    </button>
                    <button id="btn-tool-display" class="mobile-reader-tool-btn" title="${escapeHTML(t('mobile.reader.displayTitle'))}" data-i18n-title="mobile.reader.displayTitle">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19L9.5 5h1L16 19"/><path d="M6 14h8"/><path d="M17 19l2.5-6h.5l2.5 6"/><path d="M18 16.5h3.5"/></svg>
                        <span data-i18n="mobile.reader.displayBtn">${t('mobile.reader.displayBtn')}</span>
                    </button>
                    <button id="btn-tool-tts" class="mobile-reader-tool-btn" title="${escapeHTML(t('mobileSettings.group.tts.title'))}" data-i18n-title="mobileSettings.group.tts.title">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                        <span data-i18n="mobileSettings.group.tts.title">${t('mobileSettings.group.tts.title')}</span>
                    </button>
                    <button id="btn-tool-pdf-search" class="mobile-reader-tool-btn" aria-label="${escapeHTML(t('mobile.pdf.searchDocAria'))}" data-i18n-aria-label="mobile.pdf.searchDocAria" hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
                        <span data-i18n="mobile.pdf.searchBtn">${t('mobile.pdf.searchBtn')}</span>
                    </button>
                    <button id="btn-tool-more" class="mobile-reader-tool-btn" title="${escapeHTML(t('mobile.common.more'))}" data-i18n-title="mobile.common.more">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                        <span data-i18n="mobile.common.more">${t('mobile.common.more')}</span>
                    </button>
                </div>
                <div class="mobile-reader-meta-row">
                    <span id="mobile-reader-chapter-name">${escapeHTML(t('search.currentChapter'))}</span>
                    <span id="mobile-reader-progress-pct">0%</span>
                </div>
            </div>

            <button id="mobile-pdf-page-badge" class="mobile-pdf-page-badge mobile-only" aria-label="${escapeHTML(t('mobile.pdf.showControlsAria'))}" data-i18n-aria-label="mobile.pdf.showControlsAria" hidden></button>
            <button id="mobile-pdf-reset-zoom" class="mobile-pdf-reset-zoom mobile-only" data-i18n="mobile.pdf.resetFitWidth" hidden>${t('mobile.pdf.resetFitWidth')}</button>

            <!-- Mobile Bottom Sheet Backdrop -->
            <div id="mobile-sheet-backdrop" class="mobile-bottom-sheet-backdrop mobile-only"></div>

            <!-- Mobile TOC Sheet -->
            <div id="mobile-toc-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title" data-i18n="mobile.toc.title">${t('mobile.toc.title')}</h3>
                <div class="mobile-sheet-content" id="mobile-toc-container"></div>
            </div>

            <!-- Mobile Display & Theme Sheet -->
            <div id="mobile-display-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title">${escapeHTML(t('mobile.display.title'))}</h3>
                <div class="mobile-sheet-content">
                    <div id="mobile-pdf-display-controls" class="mobile-pdf-display-controls" hidden>
                        <div class="mobile-pdf-fit-options">
                            <button type="button" data-pdf-fit="fit-width" data-i18n="pdf.fitWidthTitle">${t('pdf.fitWidthTitle')}</button>
                            <button type="button" data-pdf-fit="fit-page" data-i18n="mobile.pdf.fitPage">${t('mobile.pdf.fitPage')}</button>
                        </div>
                        <div class="mobile-pdf-zoom-row">
                            <span data-i18n="mobile.pdf.zoom">${t('mobile.pdf.zoom')}</span>
                            <div class="mobile-pdf-zoom-stepper">
                                <button id="btn-mobile-pdf-zoom-out" type="button" aria-label="${escapeHTML(t('mobile.pdf.zoomOut'))}" data-i18n-aria-label="mobile.pdf.zoomOut">−</button>
                                <output id="mobile-pdf-zoom-value">100%</output>
                                <button id="btn-mobile-pdf-zoom-in" type="button" aria-label="${escapeHTML(t('mobile.pdf.zoomIn'))}" data-i18n-aria-label="mobile.pdf.zoomIn">+</button>
                            </div>
                        </div>
                        <div class="mobile-pdf-appearance" aria-label="${escapeHTML(t('settings.pageColor'))}" data-i18n-aria-label="settings.pageColor">
                            <button type="button" data-pdf-appearance="original" data-i18n="mobile.pdf.appearanceOriginal">${t('mobile.pdf.appearanceOriginal')}</button>
                            <button type="button" data-pdf-appearance="night" data-i18n="mobile.pdf.appearanceNight">${t('mobile.pdf.appearanceNight')}</button>
                        </div>
                        <p class="mobile-pdf-display-hint" data-i18n="mobile.pdf.appearanceHint">${t('mobile.pdf.appearanceHint')}</p>
                    </div>
                    <button type="button" class="mobile-theme-system mobile-theme-palette-pill" data-theme="system"><span data-i18n="settings.themeSystem">${t('settings.themeSystem')}</span><span class="mobile-theme-check" aria-hidden="true">✓</span></button>
                    <div class="mobile-theme-palette-row">
                        <button class="mobile-theme-palette-pill" data-theme="light" style="background: #ffffff; color: #1c1917;" data-i18n="mobile.theme.light">${t('mobile.theme.light')}</button>
                        <button class="mobile-theme-palette-pill" data-theme="sepia" style="background: #f4ecd8; color: #451a03;" data-i18n="mobile.theme.sepia">${t('mobile.theme.sepia')}</button>
                        <button class="mobile-theme-palette-pill" data-theme="dark" style="background: #1c1917; color: #f5f5f4;" data-i18n="mobile.theme.dark">${t('mobile.theme.dark')}</button>
                        <button class="mobile-theme-palette-pill" data-theme="black" style="background: #000000; color: #e7e5e4;" data-i18n="mobile.theme.black">${t('mobile.theme.black')}</button>
                    </div>

                    <div id="mobile-reflow-controls">
                    <div class="mobile-stepper-row">
                        <span class="mobile-stepper-label" data-i18n="mobile.display.fontSize">${t('mobile.display.fontSize')}</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-font-dec" class="mobile-stepper-btn">A-</button>
                            <span id="val-font-size">18px</span>
                            <button id="btn-font-inc" class="mobile-stepper-btn">A+</button>
                        </div>
                    </div>

                    <div class="mobile-stepper-row" style="margin-top: 1rem;">
                        <span class="mobile-stepper-label" data-i18n="mobile.display.lineHeight">${t('mobile.display.lineHeight')}</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-lh-dec" class="mobile-stepper-btn">-</button>
                            <span id="val-line-height">1.6</span>
                            <button id="btn-lh-inc" class="mobile-stepper-btn">+</button>
                        </div>
                    </div>

                    <div class="mobile-sheet-subheading" data-i18n="mobile.display.fontFamily">${t('mobile.display.fontFamily')}</div>
                    <div class="mobile-option-row" id="mobile-font-family-row">
                        <button type="button" class="mobile-option-pill" data-mobile-font="serif" style="font-family: var(--font-serif, 'Noto Serif SC', serif);" data-i18n="appearance.fontLabel.serif">${t('appearance.fontLabel.serif')}</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="sans" style="font-family: var(--font-sans, 'Noto Sans SC', sans-serif);" data-i18n="appearance.fontLabel.sans">${t('appearance.fontLabel.sans')}</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="kaiti" style="font-family: var(--font-kaiti, 'LXGW WenKai', serif);" data-i18n="appearance.fontLabel.kaiti">${t('appearance.fontLabel.kaiti')}</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="mono" style="font-family: var(--font-mono, monospace);" data-i18n="appearance.fontLabel.mono">${t('appearance.fontLabel.mono')}</button>
                    </div>

                    <div class="mobile-sheet-subheading" data-i18n="settings.pageAnim">${t('settings.pageAnim')}</div>
                    <div class="mobile-option-row" id="mobile-page-turn-row">
                        <button type="button" class="mobile-option-pill" data-mobile-turn="none" data-i18n="mobile.display.turnNone">${t('mobile.display.turnNone')}</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="slide" data-i18n="mobile.display.turnSlide">${t('mobile.display.turnSlide')}</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="cover" data-i18n="mobile.display.turnCover">${t('mobile.display.turnCover')}</button>
                    </div>
                    <div class="mobile-sheet-note" id="mobile-page-turn-note" data-i18n="mobile.display.turnCurlHint" hidden>${t('mobile.display.turnCurlHint')}</div>

                    <button type="button" id="btn-mobile-more-reading-settings" class="mobile-sheet-link-btn">
                        <span data-i18n="mobile.display.moreSettings">${t('mobile.display.moreSettings')}</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                    </div>
                </div>
            </div>

            <div id="mobile-pdf-page-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title" data-i18n="mobile.pdf.jumpPageTitle">${t('mobile.pdf.jumpPageTitle')}</h3>
                <form id="mobile-pdf-page-form" class="mobile-sheet-content">
                    <label for="mobile-pdf-page-input" id="mobile-pdf-page-range">${escapeHTML(t('mobile.pdf.pageLabel'))}</label>
                    <div class="mobile-pdf-jump-row">
                        <input id="mobile-pdf-page-input" type="number" inputmode="numeric" min="1" required aria-label="${escapeHTML(t('mobile.pdf.targetPageAria'))}" data-i18n-aria-label="mobile.pdf.targetPageAria"/>
                        <button type="submit" data-i18n="mobile.pdf.goBtn">${t('mobile.pdf.goBtn')}</button>
                    </div>
                </form>
            </div>

            <!-- Mobile More Actions Sheet -->
            <div id="mobile-more-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title" data-i18n="mobile.common.moreActions">${t('mobile.common.moreActions')}</h3>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="cell-more-book-details">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.reader.moreDetails">${t('mobile.reader.moreDetails')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="cell-more-translate">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 6"/><path d="M4 14l6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.reader.moreTranslate">${t('mobile.reader.moreTranslate')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="cell-more-fit-width">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.reader.moreFitWidth">${t('mobile.reader.moreFitWidth')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="cell-more-ocr-extract">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h3"/><path d="M20 7V4h-3"/><path d="M4 17v3h3"/><path d="M20 17v3h-3"/><line x1="9" y1="12" x2="15" y2="12"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.reader.moreOcr">${t('mobile.reader.moreOcr')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Book Long-Press Action Sheet -->
            <div id="mobile-book-action-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title" id="action-sheet-book-title">${escapeHTML(t('mobile.common.bookActions'))}</h3>
                    <span class="mobile-sheet-subtitle" id="action-sheet-book-subtitle">EPUB</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="act-sheet-read">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.bookAction.read">${t('mobile.bookAction.read')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-details">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.bookAction.info">${t('mobile.bookAction.info')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-edit">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.bookAction.editInfo">${t('mobile.bookAction.editInfo')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-tags">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="overview.filterTagBtn">${t('overview.filterTagBtn')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-category">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.bookAction.category">${t('mobile.bookAction.category')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-booklist">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.bookAction.addToList">${t('mobile.bookAction.addToList')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-mark-as">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="16 10 11 15 8 12"/></svg>
                                </span>
                                <span class="mobile-cell-label" id="act-sheet-mark-label" data-i18n="mobile.bookAction.markAs">${t('mobile.bookAction.markAs')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <span id="act-sheet-current-status-tag" style="font-size: 12px; color: var(--mobile-text-muted);">${escapeHTML(t('status.reading'))}</span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-select">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.common.select">${t('mobile.common.select')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-delete">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon" style="color: #ef4444;">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                </span>
                                <span class="mobile-cell-label" style="color: #ef4444;" data-i18n="common.remove">${t('common.remove')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-more">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.common.more">${t('mobile.common.more')}</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Share Action Sheet -->
            <div id="mobile-share-action-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title" id="share-sheet-book-title">${escapeHTML(t('mobile.share.title'))}</h3>
                    <span class="mobile-sheet-subtitle" id="share-sheet-book-subtitle">${escapeHTML(t('mobile.share.chooseMethod'))}</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="share-act-file">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.share.shareFile">${t('mobile.share.shareFile')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-poster">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.share.sharePoster">${t('mobile.share.sharePoster')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-screenshot">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.share.shareScreenshot">${t('mobile.share.shareScreenshot')}</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-save">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                </span>
                                <span class="mobile-cell-label" data-i18n="mobile.share.saveLocal">${t('mobile.share.saveLocal')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Goal Edit Sheet -->
            <div id="mobile-goal-edit-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title" data-i18n="mobile.goal.sheetTitle">${t('mobile.goal.sheetTitle')}</h3>
                    <span class="mobile-sheet-subtitle" data-i18n="mobile.goal.sheetSubtitle">${t('mobile.goal.sheetSubtitle')}</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="goal-setting-block">
                        <label class="goal-setting-label" data-i18n="mobile.goal.dailyDurationLabel">${t('mobile.goal.dailyDurationLabel')}</label>
                        <div class="goal-pill-group" id="goal-time-options">
                            <button type="button" class="goal-pill-btn" data-time="30" data-i18n="mobile.goal.opt30m">${t('mobile.goal.opt30m')}</button>
                            <button type="button" class="goal-pill-btn" data-time="60" data-i18n="mobile.goal.opt60m">${t('mobile.goal.opt60m')}</button>
                            <button type="button" class="goal-pill-btn active" data-time="120" data-i18n="mobile.goal.opt2h">${t('mobile.goal.opt2h')}</button>
                            <button type="button" class="goal-pill-btn" data-time="180" data-i18n="mobile.goal.opt3h">${t('mobile.goal.opt3h')}</button>
                        </div>
                    </div>
                    <button type="button" class="mobile-btn-primary" id="btn-save-reading-goal" data-i18n="mobile.goal.saveBtn" style="width: 100%; margin-top: 18px; padding: 12px; border-radius: 9999px; background: var(--mobile-primary, #da7756); color: var(--mobile-card-bg, #fff); font-weight: 600; border: none; cursor: pointer;">
                        ${t('mobile.goal.saveBtn')}
                    </button>
                </div>
            </div>

            <!-- Floating Layout Toggle Button -->
            <button id="btn-mobile-palette" class="mobile-floating-palette-btn mobile-only" title="${escapeHTML(t('mobile.shelf.toggleLayoutTitle'))}" data-i18n-title="mobile.shelf.toggleLayoutTitle" data-i18n-aria-label="mobile.shelf.toggleLayoutTitle" style="display: none;">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
            </button>
        `

        document.body.appendChild(root)
    }

    setupNavigationListeners() {
        const tabs = ['home', 'shelf', 'notes', 'me']
        tabs.forEach(tab => {
            const btn = document.getElementById(`tab-btn-${tab}`)
            btn?.addEventListener('click', () => this.switchTab(tab))
        })

        // Top bar action buttons
        document.getElementById('btn-mobile-export-notes')?.addEventListener('click', () => this.exportNotes())
        document.getElementById('btn-mobile-notes-fab')?.addEventListener('click', () => {
            if (window.app?.currentBookId) {
                this.setReaderInView(true)
                document.getElementById('reader-view').style.display = 'block'
                window.app.showToast(t('mobile.notes.fabInBookHint'), 'ℹ')
            } else {
                window.app?.showToast?.(t('mobile.notes.fabNoBookHint'), 'ℹ')
            }
        })

        document.getElementById('btn-home-menu')?.addEventListener('click', () => {
            this.switchTab('me')
        })
        document.getElementById('btn-mobile-notes-avatar')?.addEventListener('click', () => {
            this.switchTab('me')
        })

        // Bookshelf header filter button
        document.getElementById('btn-mobile-shelf-filter')?.addEventListener('click', () => {
            const tagBtn = document.getElementById('btn-overview-open-tags')
            if (tagBtn) tagBtn.click()
        })

        // Mobile header import book button (Issue 1 Fix)
        document.getElementById('btn-mobile-import-book')?.addEventListener('click', async () => {
            const desktopImportBtn = document.getElementById('btn-import')
            if (desktopImportBtn) {
                desktopImportBtn.click()
                return
            }
            try {
                const fileItems = await platformBridge.openFileDialog()
                if (fileItems && fileItems.length > 0 && window.app?.importQueue) {
                    window.app.importQueue.enqueue(fileItems)
                }
            } catch (err) {
                document.getElementById('file-input')?.click()
            }
        })

        // Search back button
        document.getElementById('btn-mobile-search-back')?.addEventListener('click', () => {
            this.switchTab('shelf')
        })

        // Layout mode toggle button (list/grid)
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) {
            document.querySelector('#mobile-header-bar .mobile-header-actions')?.prepend(paletteBtn)
            paletteBtn.title = t('mobile.shelf.toggleLayoutTitle')
            paletteBtn.setAttribute('aria-label', t('mobile.shelf.toggleLayoutTitle'))
            paletteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'
        }
        paletteBtn?.addEventListener('click', () => {
            const grid = document.getElementById('books-grid')
            if (grid) {
                const isList = grid.classList.toggle('is-list-mode')
                localStorage.setItem('linden_mobile_shelf_mode', isList ? 'list' : 'grid')
                paletteBtn.classList.toggle('active', isList)
                window.app?.refreshBookshelf({ resetScroll: true })
            }
        })

        // Mobile Sheet Backdrop click
        document.getElementById('mobile-sheet-backdrop')?.addEventListener('click', () => {
            this.closeAllSheets()
        })
    }

    switchTab(targetTab, options = {}) {
        if ((this.isInReader || this._homeOpeningBookId) && !options?.force) return
        document.body.classList.remove('mobile-ai-history-active')
        document.getElementById('mobile-history-actions-dialog')?.close()
        this.currentTab = targetTab
        // Mobile navigation must not hide the desktop bookshelf on startup.
        if (!this.isMobileViewport()) return
        const navTabs = ['home', 'shelf', 'notes', 'me']

        // Update tab buttons
        navTabs.forEach(tab => {
            const btn = document.getElementById(`tab-btn-${tab}`)
            btn?.classList.toggle('active', tab === targetTab)
        })

        // Toggle Views
        const homeView = document.getElementById('mobile-home-view')
        const shelfArea = document.getElementById('bookshelf-view')
        const notesView = document.getElementById('mobile-notes-view')
        const searchView = document.getElementById('mobile-search-view')
        const meView = document.getElementById('mobile-me-view')
        const headerBar = document.getElementById('mobile-header-bar')
        const paletteBtn = document.getElementById('btn-mobile-palette')

        if (document.body.classList.contains('mobile-subview-active')) {
            this.activeSubviewKey = null
            document.body.classList.remove('mobile-subview-active')
            const subHeader = document.getElementById('mobile-subview-header')
            if (subHeader) subHeader.style.display = 'none'
            if (window.app?.shelfCategory && ['stats', 'ai-history', 'notes'].includes(window.app.shelfCategory)) {
                window.app.switchShelfCategory?.('all')
            }
        }

        if (homeView) homeView.classList.toggle('active', targetTab === 'home')
        if (shelfArea) shelfArea.style.display = targetTab === 'shelf' ? 'flex' : 'none'
        if (headerBar) headerBar.style.display = targetTab === 'shelf' ? 'flex' : 'none'
        if (notesView) notesView.classList.toggle('active', targetTab === 'notes')
        if (searchView) searchView.classList.toggle('active', targetTab === 'search')
        if (meView) meView.classList.toggle('active', targetTab === 'me')
        if (paletteBtn) paletteBtn.style.display = targetTab === 'shelf' ? 'flex' : 'none'

        const skipRender = Boolean(options?.skipRender)
        // Specific Tab Loads
        if (targetTab === 'home') {
            const homeCards = document.getElementById('mobile-home-cards-container')
            if (!skipRender || !homeCards || homeCards.childElementCount === 0) {
                this.renderHomeTab()
            }
        } else if (targetTab === 'shelf') {
            if (!skipRender) this.renderShelfTab()
        } else if (targetTab === 'notes') {
            this.renderNotesTab()
        } else if (targetTab === 'search') {
            this.initSearchTab()
        } else if (targetTab === 'me') {
            this.renderMeTab()
        }
    }

    ensureSubviewHeader(title) {
        if (!this.isMobileViewport()) {
            const existing = document.getElementById('mobile-subview-header')
            if (existing) existing.style.display = 'none'
            return
        }
        const workspace = document.querySelector('#bookshelf-view .leaf-content-workspace') || document.getElementById('bookshelf-view')
        if (!workspace) return
        let header = document.getElementById('mobile-subview-header')
        if (!header) {
            header = document.createElement('header')
            header.id = 'mobile-subview-header'
            header.className = 'mobile-only'
            header.innerHTML = `
                <button type="button" class="mobile-subview-back" id="btn-mobile-subview-back" aria-label="${escapeHTML(t('mobileSettings.backAria'))}" data-i18n-aria-label="mobileSettings.backAria">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    <span data-i18n="mobileSettings.backAria">${t('mobileSettings.backAria')}</span>
                </button>
                <span class="mobile-subview-title" id="mobile-subview-title"></span>
                <span style="width: 64px;" aria-hidden="true"></span>
            `
            header.querySelector('#btn-mobile-subview-back')?.addEventListener('click', () => {
                const split = document.querySelector('.ai-history-split-pane')
                if (this.activeSubviewKey === 'ai-history' && split?.classList.contains('show-detail')) {
                    split.classList.remove('show-detail')
                    return
                }
                this.exitStatsOrAiSubview()
            })
            workspace.insertBefore(header, workspace.firstChild)
        }
        const titleEl = header.querySelector('#mobile-subview-title')
        if (titleEl) titleEl.textContent = title || ''
        header.style.display = 'flex'
    }

    openStatsSubview() {
        this.subviewReturnTab = this.currentTab || 'me'
        this.activeSubviewKey = 'stats'
        document.body.classList.add('mobile-subview-active')
        const headerBar = document.getElementById('mobile-header-bar')
        if (headerBar) headerBar.style.display = 'none'
        const contCard = document.getElementById('mobile-continue-reading-container')
        if (contCard) contCard.style.display = 'none'
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) paletteBtn.style.display = 'none'

        document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))

        const shelfArea = document.getElementById('bookshelf-view')
        if (shelfArea) shelfArea.style.display = 'flex'
        this.ensureSubviewHeader(t('nav.readingStats'))
        const workspace = document.querySelector('#bookshelf-view .leaf-content-workspace')
        if (workspace) workspace.scrollTop = 0

        if (typeof window.app?.openStatsView === 'function') {
            window.app.openStatsView()
        } else if (typeof window.app?.renderStatsDashboard === 'function') {
            window.app.renderStatsDashboard()
        } else if (typeof window.app?.switchShelfCategory === 'function') {
            window.app.switchShelfCategory('stats')
        }
    }

    openAiHistorySubview() {
        this.subviewReturnTab = this.currentTab || 'me'
        this.activeSubviewKey = 'ai-history'
        document.querySelector('.ai-history-split-pane')?.classList.remove('show-detail')
        document.body.classList.add('mobile-ai-history-active')
        document.body.classList.add('mobile-subview-active')
        const headerBar = document.getElementById('mobile-header-bar')
        if (headerBar) headerBar.style.display = 'none'
        const contCard = document.getElementById('mobile-continue-reading-container')
        if (contCard) contCard.style.display = 'none'
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) paletteBtn.style.display = 'none'

        document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))

        const shelfArea = document.getElementById('bookshelf-view')
        if (shelfArea) shelfArea.style.display = 'flex'
        this.ensureSubviewHeader(t('nav.aiHistory'))
        const workspace = document.querySelector('#bookshelf-view .leaf-content-workspace')
        if (workspace) workspace.scrollTop = 0

        const aiNavBtn = document.getElementById('nav-cat-ai-history')
        if (aiNavBtn) {
            aiNavBtn.click()
        } else if (typeof window.app?.switchShelfCategory === 'function') {
            window.app.switchShelfCategory('ai-history')
        }
    }

    exitStatsOrAiSubview() {
        document.body.classList.remove('mobile-ai-history-active')
        document.getElementById('mobile-history-actions-dialog')?.close()
        this.activeSubviewKey = null
        document.body.classList.remove('mobile-subview-active')
        const subHeader = document.getElementById('mobile-subview-header')
        if (subHeader) subHeader.style.display = 'none'
        if (window.app?.shelfCategory && ['stats', 'ai-history', 'notes'].includes(window.app.shelfCategory)) {
            window.app.switchShelfCategory?.('all')
        }
        const returnTab = this.subviewReturnTab || 'me'
        this.subviewReturnTab = null
        this.switchTab(returnTab)
    }

    ensureShelfSegmentedControl(counts) {
        const existingSeg = document.getElementById('mobile-shelf-segmented-control')
        if (!this.isMobileViewport()) {
            if (existingSeg) existingSeg.style.display = 'none'
            return
        }
        const shelfScreen = document.getElementById('modern-shelf-screen')
        if (!shelfScreen || !shelfScreen.parentNode) return

        let segControl = existingSeg
        if (!segControl) {
            segControl = document.createElement('div')
            segControl.id = 'mobile-shelf-segmented-control'
            segControl.className = 'mobile-shelf-segmented-control mobile-only'
            shelfScreen.parentNode.insertBefore(segControl, shelfScreen)
        }
        segControl.style.display = ''

        const currentFilter = this.shelfFilter || 'all'

        segControl.innerHTML = `
            <button class="shelf-seg-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
                <span>${escapeHTML(t('overview.tab.all'))}</span>
                <span class="shelf-seg-count">${counts.all}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'reading' ? 'active' : ''}" data-filter="reading">
                <span>${escapeHTML(t('overview.tab.reading'))}</span>
                <span class="shelf-seg-count">${counts.reading}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'on_hold' ? 'active' : ''}" data-filter="on_hold">
                <span>${escapeHTML(t('overview.tab.paused'))}</span>
                <span class="shelf-seg-count">${counts.on_hold}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'finished' ? 'active' : ''}" data-filter="finished">
                <span>${escapeHTML(t('overview.tab.finished'))}</span>
                <span class="shelf-seg-count">${counts.finished}</span>
            </button>
        `

        segControl.querySelectorAll('.shelf-seg-btn').forEach(btn => {
            btn.onclick = () => {
                const filter = btn.dataset.filter || 'all'
                this.shelfFilter = filter
                window.app?.refreshBookshelf({ resetScroll: true })
            }
        })
    }

    renderShelfCardDetails(book, state) {
        const fraction = getBookFraction(book)
        const info = [
            (book.format || '').toUpperCase(),
            getReadingStatusLabels()[state],
            fraction > 0 ? Math.round(fraction * 100) + '%' : ''
        ].filter(Boolean).join(' · ')
        return `
            <div class="mobile-book-author mobile-only">${escapeHTML(book.author || t('book.unknownAuthor'))}</div>
            <div class="mobile-book-info mobile-only">${escapeHTML(info)}</div>
            <button type="button" class="mobile-book-more-btn mobile-only" aria-label="${escapeHTML(t('mobile.common.bookActions'))}" title="${escapeHTML(t('mobile.common.bookActions'))}">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
        `
    }

    syncShelfControls(counts, visibleCount) {
        this.ensureShelfSegmentedControl(counts)
        this.ensureShelfSearchBar()
        const filter = this.shelfFilter
        const countEl = document.getElementById('mobile-shelf-book-count')
        if (countEl) {
            if (filter === 'all') {
                countEl.innerText = visibleCount === 1
                    ? t('mobile.shelf.countAllOne')
                    : t('mobile.shelf.countAll', { count: visibleCount })
            } else {
                const countKeyMap = {
                    reading: 'mobile.shelf.countReading',
                    on_hold: 'mobile.shelf.countOnHold',
                    finished: 'mobile.shelf.countFinished'
                }
                countEl.innerText = t(countKeyMap[filter] || 'mobile.shelf.countDefault', { count: visibleCount })
            }
        }

        const searchBarEl = document.getElementById('mobile-shelf-search-bar')
        const searchSpan = searchBarEl?.querySelector('.mobile-shelf-search-inner span')
        if (searchSpan) {
            searchSpan.innerText = visibleCount === 1
                ? t('mobile.shelf.searchBookCountOne')
                : t('mobile.shelf.searchBookCount', { count: visibleCount })
            if (searchBarEl) searchBarEl.dataset.localeApplied = getLocale()
        }
    }

    ensureShelfSearchBar() {
        const existingBar = document.getElementById('mobile-shelf-search-bar')
        if (!this.isMobileViewport()) {
            if (existingBar) existingBar.style.display = 'none'
            return
        }
        const shelfScreen = document.getElementById('modern-shelf-screen')
        if (!shelfScreen || !shelfScreen.parentNode) return

        let searchBar = existingBar
        if (!searchBar) {
            searchBar = document.createElement('div')
            searchBar.id = 'mobile-shelf-search-bar'
            searchBar.className = 'mobile-shelf-search-bar mobile-only'
            searchBar.innerHTML = `
                <div class="mobile-shelf-search-inner">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <span data-i18n="mobile.shelf.searchPlaceholder">${escapeHTML(t('mobile.shelf.searchPlaceholder'))}</span>
                </div>
            `
            shelfScreen.parentNode.insertBefore(searchBar, shelfScreen)
        } else {
            searchBar.style.display = ''
            const span = searchBar.querySelector('.mobile-shelf-search-inner span')
            if (span) {
                span.setAttribute('data-i18n', 'mobile.shelf.searchPlaceholder')
                if (searchBar.dataset.localeApplied !== getLocale() || !document.getElementById('mobile-shelf-segmented-control')) {
                    span.textContent = t('mobile.shelf.searchPlaceholder')
                }
            }
        }
        searchBar.onclick = () => {
            this.switchTab('search')
            setTimeout(() => {
                const inp = document.getElementById('mobile-search-input')
                inp?.focus()
            }, 100)
        }

        // Ensure order: segmented control -> search bar -> shelfScreen
        const segControl = document.getElementById('mobile-shelf-segmented-control')
        if (segControl && searchBar && segControl.nextSibling !== searchBar) {
            shelfScreen.parentNode.insertBefore(segControl, searchBar)
        }

        // Clean up any legacy continue reading card inside bookshelf so it does not duplicate
        const oldContCard = document.getElementById('mobile-continue-reading-container')
        if (oldContCard) {
            oldContCard.style.display = 'none'
        }
    }

    renderShelfTab() {
        const app = window.app
        if (app?.shelfCategory === 'all') return app.refreshBookshelf()
        return app?.switchShelfCategory('all')
    }

    syncShelfLayout() {
        const isList = localStorage.getItem('linden_mobile_shelf_mode') === 'list'
        document.getElementById('books-grid')?.classList.toggle('is-list-mode', isList)
        document.getElementById('btn-mobile-palette')?.classList.toggle('active', isList)
    }

    async refreshContinueReadingCard() {
        // Compatibility forwarder
        if (!this.isMobileViewport()) return
        await this.renderHomeTab()
    }

    async renderHomeTab() {
        const container = document.getElementById('mobile-home-cards-container')
        if (!container) return

        const userName = resolveGreetingDisplayName()

        const greeting = document.getElementById('mobile-home-greeting')
        if (greeting) { greeting.textContent = formatGreetingText(userName) }
        const renderGeneration = this.homeGeneration = (this.homeGeneration || 0) + 1
        try {
            const books = await db.getAllBooks()
            if (this.homeGeneration !== renderGeneration) return
            if (!books || books.length === 0) {
                container.innerHTML = `
                    <div class="home-empty-container">
                        <div class="home-empty-icon">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                        </div>
                        <h3 class="home-empty-title">${escapeHTML(t('mobile.home.emptyTitle'))}</h3>
                        <p class="home-empty-desc">${escapeHTML(t('mobile.home.emptyDesc'))}</p>
                        <button class="home-empty-btn" id="btn-home-empty-import" type="button">
                            <span>${escapeHTML(t('mobile.shelf.importBook'))}</span>
                        </button>
                    </div>
                `
                container.querySelector('#btn-home-empty-import')?.addEventListener('click', () => {
                    document.getElementById('btn-mobile-import-book')?.click()
                })
                return
            }

            // 1. Calculate Cumulative Reading Stats & Analytics
            let analytics = null
            try {
                analytics = await db.getReadingStats()
            } catch (_) {}
            if (this.homeGeneration !== renderGeneration) return

            const totalSecs = analytics?.totalSeconds ?? books.reduce((acc, b) => acc + (b.totalReadingSeconds || 0), 0)
            const totalH = Math.floor(totalSecs / 3600)
            const totalM = Math.floor((totalSecs % 3600) / 60)
            const totalBooksCount = books.length
            const totalDurationStr = totalH > 0
                ? t('time.hoursMinutes', { hours: totalH, mins: totalM })
                : t('time.minutes', { count: totalM })
            const totalBooksLabel = totalBooksCount === 1
                ? t('mobile.home.bookCountOne')
                : t('mobile.home.bookCountOther', { count: totalBooksCount })
            const readingStatsStr = t('mobile.home.cumulativeSummary', {
                duration: totalDurationStr,
                books: totalBooksLabel
            })

            // 2. Select Currently Reading Book (Hero Card)
            const sortedByRead = [...books].sort((a, b) => {
                const aTime = Math.max(...[a.lastReadAt, a.lastOpenedAt, a.progress?.updatedAt].map(value => new Date(value || 0).getTime() || 0))
                const bTime = Math.max(...[b.lastReadAt, b.lastOpenedAt, b.progress?.updatedAt].map(value => new Date(value || 0).getTime() || 0))
                return bTime - aTime
            })
            const currentBook = sortedByRead.find(b => resolveReadingState(b) === 'reading') || sortedByRead[0]
            const fraction = getBookFraction(currentBook)
            const pct = Number.isFinite(fraction) ? Math.round(fraction * 100) : 0
            const pctDisplay = Number.isFinite(fraction)
                ? ((fraction * 100).toFixed(1).replace(/\.0$/, '') + '%')
                : '0%'

            // Book reading duration (No falsy bug)
            const bSecs = (typeof currentBook.totalReadingSeconds === 'number') ? currentBook.totalReadingSeconds : 0
            let bookTimeLabel = ''
            if (bSecs >= 3600) {
                const bH = Math.floor(bSecs / 3600)
                const bM = Math.floor((bSecs % 3600) / 60)
                bookTimeLabel = t('mobile.home.bookReadTime', { time: t('time.hoursMinutes', { hours: bH, mins: bM }) })
            } else if (bSecs >= 60) {
                const bM = Math.floor(bSecs / 60)
                bookTimeLabel = t('mobile.home.bookReadTime', { time: t('time.minutes', { count: bM }) })
            } else if (bSecs > 0) {
                bookTimeLabel = t('mobile.home.bookReadTime', { time: t('mobile.time.seconds', { count: bSecs }) })
            } else if (pct > 0) {
                bookTimeLabel = t('mobile.home.bookReadTime', { time: t('time.lessThanOneMinute') })
            } else {
                bookTimeLabel = t('mobile.home.notStartedReading')
            }

            // Streak days (computed from analytics or stored preference)
            const streakDays = Math.max(0, Number(analytics?.streakDays) || 0)
            const streakLabel = streakDays > 0
                ? (streakDays === 1 ? t('mobile.home.streakDaysOne') : t('mobile.home.streakDays', { days: streakDays }))
                : t('mobile.home.streakStart')

            // User initial or avatar
            const userInitial = userName ? userName.charAt(0).toUpperCase() : 'R'

            // 3. Today's Reading Goals (Card 3 Dynamic Calculation)
            const storedDailyGoal = parseInt(localStorage.getItem('linden_daily_goal_minutes') || '0', 10)
            const settingsDailyGoal = Number(window.app?.settings?.readingGoalToday)
            const targetMins = Math.max(1, Number.isFinite(settingsDailyGoal) && settingsDailyGoal > 0 ? settingsDailyGoal : (storedDailyGoal > 0 ? storedDailyGoal : 45))

            const todaySecs = Math.max(0, Number(analytics?.todaySeconds) || 0)
            const todayMins = Math.floor(todaySecs / 60)
            const todayH = Math.floor(todayMins / 60)
            const remM = todayMins % 60
            const todayTimeStr = todayH > 0
                ? t('time.hoursMinutes', { hours: todayH, mins: remM })
                : t('time.minutes', { count: todayMins })
            const targetH = Math.floor(targetMins / 60)
            const targetRemM = targetMins % 60
            const targetTimeStr = targetH > 0
                ? (targetRemM > 0 ? t('time.hoursMinutes', { hours: targetH, mins: targetRemM }) : t('time.hours', { hours: targetH }))
                : t('time.minutes', { count: targetMins })

            const timePct = Math.min(100, Math.round((todayMins / targetMins) * 100))
            const encouragement = timePct >= 100
                ? t('mobile.home.goalDone')
                : todaySecs > 0
                    ? t('mobile.home.goalInProgress', { time: todayTimeStr })
                    : t('mobile.home.goalStart')

            // 4. Recommended books gallery
            const otherBooks = books.filter(b => b.id !== currentBook.id)
            const recList = otherBooks.length > 0 ? otherBooks : books
            const start = (this.recommendationOffset || 0) % recList.length
            const recommendations = [...recList.slice(start), ...recList.slice(0, start)].slice(0, 10)
            const recsHTML = recommendations.map(b => `
                <div class="home-rec-item" data-rec-id="${escapeHTML(String(b.id))}">
                    <div class="home-rec-cover">
                        ${renderBookCoverHTML(b, 'rec-cover-inner', true)}
                    </div>
                    <span class="home-rec-title" title="${escapeHTML(b.title || t('book.untitled'))}">${escapeHTML(b.title || t('book.untitled'))}</span>
                </div>
            `).join('')

            if (this.homeGeneration !== renderGeneration) return
            // Render reading overview and the current book.
            container.innerHTML = `
                <!-- Card 1: Cumulative Reading Card -->
                <div class="home-card home-cumulative-card" id="home-card-cumulative">
                    <div class="home-cumulative-left">
                        <div class="home-avatar-circle" id="home-avatar-circle">
                            <span>${escapeHTML(userInitial)}</span>
                        </div>
                        <div class="home-cumulative-info">
                            <span class="home-cumulative-title">${escapeHTML(t('mobile.home.cumulativeTitle'))}</span>
                            <span class="home-cumulative-sub" id="home-cumulative-sub">${escapeHTML(readingStatsStr)}</span>
                        </div>
                    </div>
                    <div class="home-card-chevron">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                </div>

                <!-- Card 2: Currently Reading Hero Card -->
                <div class="home-card home-hero-card" id="home-hero-card" data-book-id="${escapeHTML(String(currentBook.id || ''))}">
                    <div class="home-hero-header">
                        <span class="home-hero-label" id="btn-home-hero-reading-link">
                            ${escapeHTML(t('mobile.home.currentlyReading'))}
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                        <span class="home-hero-streak-badge">${escapeHTML(streakLabel)}</span>
                    </div>
                    <div class="home-hero-body" id="btn-home-hero-open">
                        <div class="home-hero-book-3d reading-book-cover-3d">
                            ${renderBookCoverHTML(currentBook, 'stage-main-cover-inner')}
                        </div>
                        <div class="home-hero-info">
                            <h2 class="home-hero-book-title hero-book-title reading-stage-book-title">${escapeHTML(currentBook.title || t('book.untitled'))}</h2>
                            <p class="home-hero-book-author reading-stage-book-author">${escapeHTML(currentBook.author || t('book.unknownAuthor'))}</p>
                            <div class="home-hero-progress-row">
                                <span>${escapeHTML(t('mobile.home.readingProgress'))}</span>
                                <span class="home-hero-progress-pct hero-progress-text">${pctDisplay}</span>
                            </div>
                            <div class="home-hero-progress-track reading-stage-progress-track">
                                <div class="home-hero-progress-fill reading-stage-progress-bar" style="width: ${pct}%;"></div>
                            </div>
                        </div>
                    </div>
                    <div class="home-hero-footer">
                        <span class="home-hero-time">
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            <span>${escapeHTML(bookTimeLabel)}</span>
                        </span>
                        <button type="button" class="home-hero-action" id="btn-home-continue-reading">
                            ${escapeHTML(t('mobile.home.continueReading'))}
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Card 3: Today's Reading Goals -->
                <div class="home-card home-goals-card" id="home-goals-card">
                    <div class="home-goals-header">
                        <span class="home-goals-title">${escapeHTML(t('mobile.home.todayGoalTitle'))}</span>
                        <div class="home-goals-actions">
                            <button type="button" class="home-goals-action-btn" id="btn-goal-share" title="${escapeHTML(t('mobile.home.shareTitle'))}" hidden>
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                            </button>
                            <button type="button" class="home-goals-action-btn" id="btn-goal-edit" title="${escapeHTML(t('mobile.home.editGoalTitle'))}">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                            </button>
                        </div>
                    </div>
                    <p class="home-goals-encouragement">${escapeHTML(encouragement)}</p>
                    <div class="home-goal-item">
                        <div class="home-goal-item-top">
                            <span class="home-goal-item-left">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                <span>${escapeHTML(t('mobile.stats.readingTime'))}</span>
                            </span>
                            <span class="home-goal-item-val"><strong>${escapeHTML(todayTimeStr)}</strong> / ${escapeHTML(targetTimeStr)}</span>
                        </div>
                        <div class="home-goal-track">
                            <div class="home-goal-fill" style="width: ${timePct}%;"></div>
                        </div>
                    </div>
                </div>

                <!-- Card 4: Featured / Random Recommendations -->
                <div class="home-card home-recs-card" id="home-recs-card">
                    <div class="home-recs-header">
                        <span class="home-recs-title" id="btn-home-recs-title">
                            ${escapeHTML(t('mobile.home.featuredBooks'))}
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                        <button type="button" class="home-recs-refresh-btn" id="btn-recs-refresh" title="${escapeHTML(t('mobile.home.refreshRecsTitle'))}">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>
                        </button>
                    </div>
                    <div class="home-recs-gallery" id="home-recs-gallery">
                        ${recsHTML}
                    </div>
                </div>
            `

            // Bind Event Listeners
            container.querySelector('#home-card-cumulative')?.addEventListener('click', () => {
                this.openStatsSubview()
            })

            container.querySelector('#btn-home-hero-reading-link')?.addEventListener('click', (e) => {
                e.stopPropagation()
                this.shelfFilter = 'reading'
                this.switchTab('shelf')
            })

            const heroCardEl = container.querySelector('#home-hero-card')
            container.querySelector('#btn-home-continue-reading')?.addEventListener('click', (e) => {
                e.stopPropagation()
                this._openBookFromHome(currentBook.id, heroCardEl, currentBook)
            })

            heroCardEl?.addEventListener('click', (e) => {
                if (e.target?.closest?.('#btn-home-hero-reading-link')) return
                this._openBookFromHome(currentBook.id, e.currentTarget, currentBook)
            })

            container.querySelector('#btn-goal-edit')?.addEventListener('click', (e) => {
                e.stopPropagation()
                this.openGoalEditSheet()
            })

            container.querySelector('#btn-home-recs-title')?.addEventListener('click', () => {
                this.switchTab('shelf')
            })

            container.querySelector('#btn-recs-refresh')?.addEventListener('click', (e) => {
                e.stopPropagation()
                this.recommendationOffset = start + Math.min(3, recList.length)
                this.renderHomeTab()
            })

            const recBookMap = new Map(recList.map(b => [String(b.id), b]))
            container.querySelectorAll('.home-rec-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation()
                    const bId = item.dataset.recId
                    if (bId) this._openBookFromHome(bId, item, recBookMap.get(String(bId)) || null)
                })
            })

        } catch (err) {
            console.error('[MobileShell] Error rendering home tab:', err)
        }
    }

    async _openBookFromHome(bookId, triggerEl = null, bookHint = null) {
        if (!bookId || this._homeOpeningBookId) return
        this._homeOpeningBookId = bookId
        const continueBtn = triggerEl?.querySelector?.('#btn-home-continue-reading') || null
        if (triggerEl) {
            triggerEl.setAttribute('aria-busy', 'true')
            triggerEl.style.opacity = '0.72'
        }
        if (continueBtn) continueBtn.disabled = true
        let enteredImmediateLoading = false
        if (this.isMobileViewport() && !bookHint?.isCloudOnly) {
            const shelfArea = document.getElementById('bookshelf-view')
            const readerView = document.getElementById('reader-view')
            if (shelfArea) shelfArea.style.display = 'none'
            if (readerView) {
                readerView.classList.remove('closing')
                readerView.style.display = 'block'
                readerView.classList.add('active')
            }
            this.beginReaderSessionLoading(bookHint?.title || '')
            enteredImmediateLoading = true
        }
        try {
            await Promise.resolve(window.app?.openBook?.(bookId))
        } finally {
            if (this._homeOpeningBookId === bookId) {
                this._homeOpeningBookId = null
            }
            if (enteredImmediateLoading && !window.app?._activeSession && !window.app?.currentBookId && this.isInReader) {
                const readerView = document.getElementById('reader-view')
                if (readerView) {
                    readerView.classList.remove('active', 'closing')
                    readerView.style.display = 'none'
                }
                this.setReaderInView(false, { deferRender: true })
            }
            if (triggerEl) {
                triggerEl.removeAttribute('aria-busy')
                triggerEl.style.opacity = ''
            }
            if (continueBtn) continueBtn.disabled = false
        }
    }

    async renderNotesTab() {
        const list = document.getElementById('mobile-notes-list')
        if (!list) return

        const generation = ++this.notesGeneration
        const exportButton = document.getElementById('btn-mobile-export-notes')
        list.onclick = null
        exportButton.disabled = true

        try {
            const [highlights, books] = await Promise.all([db.getAllHighlights(), db.getAllBooks()])
            if (generation !== this.notesGeneration) return
            if (!highlights.length) {
                list.innerHTML = `
                    <div class="mobile-empty-state">
                        <div class="mobile-empty-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        </div>
                        <h4 class="mobile-empty-title">${escapeHTML(t('mobile.notes.emptyTitle'))}</h4>
                        <p class="mobile-empty-desc">${escapeHTML(t('mobile.notes.emptyDesc'))}</p>
                    </div>
                `
                return
            }

            highlights.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            const bookMap = new Map(books.map(({ id, title, author, format }) => [id, { title, author, format }]))
            const highlightsById = new Map(highlights.map(highlight => [String(highlight.id), highlight]))
            const pageSize = 50
            const pageCount = Math.ceil(highlights.length / pageSize)
            let page = 0
            const renderPage = () => {
                const start = page * pageSize
                list.innerHTML = highlights.slice(start, start + pageSize)
                    .map(hl => this.renderNoteCard(hl, bookMap)).join('')
                if (pageCount > 1) {
                    const pagination = `
                        <div class="mobile-notes-pagination">
                            <button type="button" class="btn-secondary-action" data-note-page="-1" ${page === 0 ? 'disabled' : ''}>${escapeHTML(t('search.prevPage'))}</button>
                            <span>${escapeHTML(t('app.pageOfTotal', { page: page + 1, total: pageCount }))}</span>
                            <button type="button" class="btn-secondary-action" data-note-page="1" ${page === pageCount - 1 ? 'disabled' : ''}>${escapeHTML(t('search.nextPage'))}</button>
                        </div>
                    `
                    list.insertAdjacentHTML('afterbegin', pagination)
                    list.insertAdjacentHTML('beforeend', pagination)
                }
            }
            list.onclick = async event => {
                const pageButton = event.target.closest('[data-note-page]')
                if (pageButton) {
                    page += Number(pageButton.dataset.notePage)
                    renderPage()
                    list.scrollIntoView({ block: 'start' })
                    list.querySelector('[data-note-page]:not(:disabled)')?.focus({ preventScroll: true })
                    return
                }
                const card = event.target.closest('.mobile-note-card')
                if (!card) return
                const highlight = highlightsById.get(card.dataset.hlId)
                try {
                    if (event.target.closest('.note-act-more-btn')) {
                        this.openNoteActions(highlight, bookMap.get(highlight.bookId))
                    } else {
                        await this.locateNote(highlight)
                    }
                } catch (error) {
                    window.app?.showToast?.(error.message || t('mobile.common.actionIncomplete'), 'warning')
                }
            }
            renderPage()
            exportButton.disabled = false
        } catch (error) {
            console.error('[MobileShell] Error rendering notes tab:', error)
        }
    }

    renderNoteCard(hl, bookMap) {
        const book = bookMap.get(hl.bookId)
        const bookTitle = book?.title || t('annotations.unknownBook')
        const chapterStr = hl.chapterTitle && hl.chapterTitle !== 'undefined' ? hl.chapterTitle : ''
        const dateStr = formatNoteDate(hl.createdAt)
        const bottomMeta = [bookTitle, chapterStr, dateStr].filter(Boolean).join(' · ')
        const quoteText = hl.text || ''
        const noteText = hl.note || ''
        const noteTitle = hl.title || ''

        const mappedColor = mapHighlightDisplayColor(hl.color || '#D6A736')
        const rawColor = String(mappedColor || '#c89b3c').trim()
        const quoteColor = /^[#a-zA-Z0-9(),.%\s-]+$/.test(rawColor) ? rawColor : '#c89b3c'
        const safeHlId = escapeHTML(String(hl.id || ''))

        return `
            <div class="mobile-note-card" data-hl-id="${safeHlId}">
                ${noteTitle ? `<h3 class="note-card-title">${escapeHTML(noteTitle)}</h3>` : ''}
                ${quoteText ? `
                    <div class="note-quote-block" style="border-left-color: ${escapeHTML(quoteColor)};">
                        <div class="note-quote-body">${escapeHTML(quoteText)}</div>
                    </div>
                ` : ''}
                ${noteText ? `<div class="note-thought-body"><span class="mobile-thought-tag">${escapeHTML(t('annotations.thoughtBadge'))}</span><span>${escapeHTML(noteText)}</span></div>` : ''}
                <div class="note-card-footer">
                    <span class="note-footer-date">${escapeHTML(bottomMeta)}</span>
                    <div class="note-footer-actions">
                        <button class="note-act-more-btn" type="button" title="${escapeHTML(t('mobile.common.moreActions'))}" data-hl-id="${safeHlId}">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `
    }

    async locateNote(highlight) {
        const app = window.app
        const bookId = highlight.bookId
        if (!bookId || !app) return
        const target = highlight.pdfTarget
        const firstSegment = target?.segments?.[0]
        const page = firstSegment?.page ?? target?.page ?? 0
        const rects = firstSegment?.rects?.length ? firstSegment.rects : target?.rects
        const yRatio = rects?.[0]?.[1] ?? 0
        const isPdf = Boolean(target || highlight.formatType === 'pdf')
        const highlightColor = highlight.color || '#facc15'
        const location = highlight.cfi
            ? { cfi: highlight.cfi, highlightId: highlight.id, highlightColor, isHighlightJump: true }
            : (isPdf ? { page: page + 1, yRatio, highlightId: highlight.id, rects, highlightColor, isHighlightJump: true } : null)

        if (String(app.currentBookId) !== String(bookId)) {
            return app.openBook(bookId, location)
        }
        this.setReaderInView(true)
        document.getElementById('reader-view').style.display = 'block'
        if (app.pdfViewport && isPdf) {
            app.pdfViewport.goToPage(page, yRatio)
            app.pdfViewport.pulseHighlight?.(page, highlight.id, rects, highlightColor)
        } else if (highlight.cfi && app.foliateView) {
            await app.foliateView.goTo(highlight.cfi)
            const theme = document.documentElement.getAttribute('data-theme')
            const isDark = theme === 'dark' || theme === 'black'
            app.foliateView.pulseHighlight?.(highlight.cfi, {
                color: highlightColor,
                isDark,
                writingMode: app.settings?.writingMode,
            })
        }
    }

    openNoteActions(highlight, book) {
        let sheet = document.getElementById('mobile-note-actions-sheet')
        if (!sheet) {
            sheet = document.createElement('div')
            sheet.id = 'mobile-note-actions-sheet'
            sheet.className = 'mobile-bottom-sheet mobile-only'
            document.getElementById('mobile-shell-root').appendChild(sheet)
        }
        sheet.innerHTML = `<div class="mobile-sheet-handle"></div><div class="mobile-sheet-header-compact"><h3 class="mobile-sheet-title" data-i18n="mobile.notes.actionSheetTitle">${escapeHTML(t('mobile.notes.actionSheetTitle'))}</h3></div><div class="mobile-sheet-content"><div class="mobile-group-box"><button type="button" class="mobile-cell-item" data-note-action="locate" data-i18n="mobile.notes.locateOrigin">${escapeHTML(t('mobile.notes.locateOrigin'))}</button><button type="button" class="mobile-cell-item" data-note-action="copy" data-i18n="mobile.notes.copyNote">${escapeHTML(t('mobile.notes.copyNote'))}</button><button type="button" class="mobile-cell-item" data-note-action="quote" data-i18n="mobile.notes.createQuoteCard">${escapeHTML(t('mobile.notes.createQuoteCard'))}</button></div></div>`
        this.openSheet('note-actions')
        sheet.classList.add('open')
        sheet.onclick = async event => {
            const action = event.target.closest('[data-note-action]')?.dataset.noteAction
            if (!action) return
            this.closeAllSheets()
            try {
                if (action === 'locate') {
                    await this.locateNote(highlight)
                } else if (action === 'copy') {
                    if (!navigator.clipboard) throw new Error(t('mobile.notes.clipboardUnavailable'))
                    const excerpt = highlight.text || ''
                    const note = highlight.note || ''
                    await navigator.clipboard.writeText(excerpt && note
                        ? `${excerpt}\n\n${t('mobile.notes.thoughtPrefix')}${note}` : excerpt || note)
                    window.app?.showToast?.(t('annotations.copiedToast'), 'success')
                } else if (action === 'quote') {
                    await window.app?.openQuoteCardModal?.(highlight.text || highlight.note || '',
                        highlight.chapterTitle || '', null,
                        { bookId: highlight.bookId, bookTitle: book?.title || t('annotations.unknownBook'), author: book?.author || '', format: book?.format || '' })
                }
            } catch (error) {
                window.app?.showToast?.(error.message || t('mobile.common.actionIncomplete'), 'warning')
            }
        }
    }

    async exportNotes() {
        try {
            const [highlights, books] = await Promise.all([db.getAllHighlights(), db.getAllBooks()])
            if (!highlights.length) {
                window.app?.showToast?.(t('mobile.notes.emptyTitle'), 'info')
                return
            }
            if (!navigator.clipboard) throw new Error(t('mobile.notes.clipboardUnavailable'))
            const sortedHl = highlights.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            const bookMap = new Map(books.map(book => [book.id, book]))
            let md = `# ${t('mobile.notes.exportHeading')}\n\n`
            md += `* ${t('mobile.notes.exportTimeLabel', { time: new Date().toLocaleString(getLocale()) })}\n`
            md += `* ${t('mobile.notes.exportCountLabel', { count: sortedHl.length })}\n\n---\n\n`
            sortedHl.forEach((hl, i) => {
                const b = bookMap.get(hl.bookId)
                const quotedBookTitle = t('syncEngine.report.quotedTitle', { title: b?.title || t('annotations.unknownBook') })
                md += `### ${i + 1}. ${quotedBookTitle}${hl.chapterTitle ? ' - ' + hl.chapterTitle : ''}\n\n`
                md += `> ${(hl.text || '').replace(/\n/g, '\n> ')}\n\n`
                if (hl.note) md += `**${t('mobile.notes.thoughtPrefix')}**${hl.note}\n\n`
                if (hl.createdAt) {
                    md += `*${t('mobile.notes.exportRecordedAt', { date: new Date(hl.createdAt).toLocaleDateString(getLocale()) })}*\n\n`
                }
                md += `---\n\n`
            })
            await navigator.clipboard.writeText(md)
            window.app?.showToast?.(t('mobile.notes.exportedToast'), '✓')
        } catch (error) {
            window.app?.showToast?.(error.message || t('mobile.common.actionIncomplete'), 'warning')
        }
    }

    initSearchTab() {
        const input = document.getElementById('mobile-search-input')
        const clearBtn = document.getElementById('btn-mobile-clear-search')
        const resultsEl = document.getElementById('mobile-search-results')
        if (!input || !resultsEl) return

        const doSearch = async (query) => {
            const thisGen = ++this.searchGeneration

            if (!query) {
                resultsEl.innerHTML = `
                    <div class="mobile-empty-state">
                        <div class="mobile-empty-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        </div>
                        <h4 class="mobile-empty-title">${escapeHTML(t('mobile.search.emptyTitle'))}</h4>
                        <p class="mobile-empty-desc">${escapeHTML(t('mobile.search.emptyDesc'))}</p>
                    </div>
                `
                if (clearBtn) clearBtn.style.display = 'none'
                return
            }

            if (clearBtn) clearBtn.style.display = 'block'

            const books = await db.getAllBooks()
            const highlights = await db.getAllHighlights()
            if (thisGen !== this.searchGeneration) return // Race condition guard

            const lowerQ = query.toLowerCase()
            const matchedBooks = (books || []).filter(b => 
                (b.title && b.title.toLowerCase().includes(lowerQ)) ||
                (b.author && b.author.toLowerCase().includes(lowerQ))
            )
            const matchedNotes = (highlights || []).filter(hl =>
                (hl.text && hl.text.toLowerCase().includes(lowerQ)) ||
                (hl.note && hl.note.toLowerCase().includes(lowerQ))
            )

            if (matchedBooks.length === 0 && matchedNotes.length === 0) {
                resultsEl.innerHTML = `
                    <div class="mobile-empty-state">
                        <h4 class="mobile-empty-title">${escapeHTML(t('mobile.search.noResultTitle'))}</h4>
                        <p class="mobile-empty-desc">${escapeHTML(t('mobile.search.noResultDesc'))}</p>
                    </div>
                `
                return
            }

            let html = ''
            if (matchedBooks.length > 0) {
                html += `<div class="search-section-label">${escapeHTML(t('mobile.search.matchedBooks', { count: matchedBooks.length }))}</div>`
                html += matchedBooks.map(b => {
                    const coverHtml = renderBookCoverHTML(b, 'search-result-cover-img', true)
                    const pct = Math.round(getBookFraction(b) * 100)
                    const metaText = t('mobile.search.bookMeta', {
                        author: b.author || t('book.unknownAuthor'),
                        pct
                    })
                    return `
                        <div class="search-result-book-item" data-book-id="${escapeHTML(String(b.id || ''))}">
                            <div class="search-result-thumb">
                                ${coverHtml}
                            </div>
                            <div class="search-result-info">
                                <div class="search-result-title">${escapeHTML(b.title || t('book.untitled'))}</div>
                                <div class="search-result-meta">${escapeHTML(metaText)}</div>
                            </div>
                        </div>
                    `
                }).join('')
            }

            if (matchedNotes.length > 0) {
                const bookMap = new Map((books || []).map(b => [b.id, b]))
                html += `<div class="search-section-label">${escapeHTML(t('mobile.search.matchedNotes', { count: matchedNotes.length }))}</div>`
                html += matchedNotes.slice(0, 15).map(hl => {
                    const book = bookMap.get(hl.bookId)
                    const quotedTitle = t('syncEngine.report.quotedTitle', {
                        title: escapeHTML(book?.title || t('mobile.search.defaultBookLabel'))
                    })
                    return `
                        <div class="mobile-note-card search-result-note-item" data-book-id="${escapeHTML(String(hl.bookId || ''))}" data-hl-id="${escapeHTML(String(hl.id || ''))}">
                            <div class="note-card-meta">
                                <span class="note-source-title">${quotedTitle}${hl.chapterTitle ? ' · ' + escapeHTML(hl.chapterTitle) : ''}</span>
                            </div>
                            <div class="note-quote-body">${escapeHTML(hl.text || '')}</div>
                            ${hl.note ? `<div class="note-thought-body">${escapeHTML(hl.note)}</div>` : ''}
                        </div>
                    `
                }).join('')
            }

            resultsEl.innerHTML = html

            // Bind book click
            resultsEl.querySelectorAll('.search-result-book-item').forEach(item => {
                item.addEventListener('click', () => {
                    const bId = item.dataset.bookId
                    if (bId) {
                        window.app?.openBook?.(bId)
                    }
                })
            })

            // Bind note click
            resultsEl.querySelectorAll('.search-result-note-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const bId = item.dataset.bookId
                    const hlId = item.dataset.hlId
                    const hl = highlights.find(h => String(h.id) === String(hlId))
                    if (hl) {
                        await this.locateNote(hl)
                    } else if (bId) {
                        await window.app?.openBook?.(bId)
                    }
                })
            })
        }

        let searchDebounceTimer = null
        input.oninput = () => {
            clearTimeout(searchDebounceTimer)
            searchDebounceTimer = setTimeout(() => {
                doSearch(input.value.trim())
            }, 200)
        }
        if (clearBtn) {
            clearBtn.onclick = () => {
                clearTimeout(searchDebounceTimer)
                input.value = ''
                doSearch('')
            }
        }

        this._runMobileSearch = () => doSearch(input.value.trim())
        doSearch(input.value.trim())
    }

    async renderMeTab() {
        const langNameEl = document.getElementById('mobile-current-language-name')
        if (langNameEl) langNameEl.innerText = isEnglish() ? t('settings.langEnBtn') : t('settings.langZhBtn')
        const langCell = document.getElementById('cell-toggle-language')
        if (langCell) {
            langCell.onclick = () => {
                const next = isEnglish() ? 'zh-CN' : 'en'
                setLocale(next, { persist: true, broadcast: true, applyDom: true })
            }
        }

        const renderGeneration = this.meGeneration = (this.meGeneration || 0) + 1
        try {
            const books = await db.getAllBooks()
            const highlights = await db.getAllHighlights()
            const stats = await db.getReadingStats()
            if (this.meGeneration !== renderGeneration) return

            // Safe resolution of reading hours from real totalSeconds (Issue 10 Fix)
            const totalSec = stats?.totalSeconds || 0
            const minutes = Math.round((totalSec || (stats?.totalHours || 0) * 3600) / 60)
            const readingTime = minutes < 60
                ? t('time.minutes', { count: minutes })
                : (minutes % 60
                    ? t('time.hoursMinutes', { hours: Math.floor(minutes / 60), mins: minutes % 60 })
                    : t('mobile.time.hoursOnly', { hours: Math.floor(minutes / 60) }))
            const booksCount = books?.length || 0
            const notesCount = highlights?.length || 0

            const hEl = document.getElementById('mobile-stat-hours')
            const bEl = document.getElementById('mobile-stat-books')
            const nEl = document.getElementById('mobile-stat-notes')

            if (hEl) {
                hEl.innerText = isEnglish()
                    ? readingTime
                    : readingTime.replace(/\s*(小时|分钟)\s*/g, '$1')
            }
            if (bEl) bEl.innerText = booksCount
            if (nEl) nEl.innerText = notesCount

            // User Display Name & Avatar
            const userName = resolveGreetingDisplayName()
            const uNameEl = document.getElementById('mobile-user-name')
            const uAvatarEl = document.getElementById('mobile-user-avatar')
            if (uNameEl) uNameEl.innerText = userName
            if (uAvatarEl) uAvatarEl.innerText = userName.charAt(0).toUpperCase()

            this.syncThemeLabel()

            // Sync Status
            const syncStatusEl = document.getElementById('mobile-sync-status-text')
            if (syncStatusEl) {
                const cfg = window.app?.syncConfig
                syncStatusEl.innerText = cfg?.serverUrl && cfg?.username
                    ? (cfg.enabled ? t('mobile.me.syncEnabled') : t('mobile.me.syncConfigured'))
                    : t('settings.syncUnconfigured')
            }

            // Cell click bindings (idempotent onclick assignment to prevent listener stacking)
            const statsCell = document.getElementById('cell-open-stats')
            if (statsCell) statsCell.onclick = () => this.openStatsSubview()
            const aiCell = document.getElementById('cell-open-ai-history')
            if (aiCell) aiCell.onclick = () => this.openAiHistorySubview()
            const webdavCell = document.getElementById('cell-open-webdav')
            if (webdavCell) webdavCell.onclick = () => window.app?.openWebdavSyncModal?.()
            const displayCell = document.getElementById('cell-open-display-theme')
            if (displayCell) displayCell.onclick = () => this.settingsPage.open('appearance')
            const advCell = document.getElementById('cell-open-advanced-settings')
            if (advCell) advCell.onclick = () => this.settingsPage.open('index')
            for (const [id, group] of [['cell-open-tts-settings', 'tts'], ['cell-open-backup', 'backup'], ['cell-open-profile', 'profile'], ['cell-about-app', 'about']]) {
                const cell = document.getElementById(id)
                if (cell) cell.onclick = () => this.settingsPage.open(group)
            }
            const profileStatsCell = document.getElementById('cell-profile-stats')
            if (profileStatsCell) profileStatsCell.onclick = () => this.openStatsSubview()
            const ttsProv = window.advancedSettings?.config?.ttsProvider || 'system'
            const engineEl = document.getElementById('mobile-tts-engine-name')
            if (engineEl) engineEl.textContent = getTtsProviderLabel(ttsProv)
        } catch (e) {
            console.error('[MobileShell] Error rendering Me tab:', e)
        }
    }

    syncThemeLabel() {
        const tNameEl = document.getElementById('mobile-current-theme-name')
        if (!tNameEl) return
        const isSystem = window.app?.themeMode === 'system'
        const curTheme = document.documentElement.getAttribute('data-theme') || 'light'
        const themeNames = {
            light: t('mobile.theme.light'),
            sepia: t('mobile.theme.sepia'),
            green: t('settings.themeGreen'),
            eink: t('settings.themeEink'),
            dark: t('mobile.theme.dark'),
            black: t('mobile.theme.black')
        }
        const resolvedThemeLabel = themeNames[curTheme] || curTheme
        tNameEl.innerText = isSystem ? `${t('settings.themeSystem')} (${resolvedThemeLabel})` : resolvedThemeLabel
    }

    setupMiniPlayerListeners() {
        const mini = document.getElementById('mobile-mini-player')
        const playBtn = document.getElementById('btn-mini-play-pause')
        const nextBtn = document.getElementById('btn-mini-next')

        mini?.addEventListener('click', (e) => {
            if (e.target.closest('.mini-btn')) return
            this.openNowPlayingSheet()
        })

        playBtn?.addEventListener('click', (e) => {
            e.stopPropagation()
            if (ttsPlayer.state === 'playing') ttsPlayer.pause()
            else ttsPlayer.resume()
        })

        nextBtn?.addEventListener('click', (e) => {
            e.stopPropagation()
            ttsPlayer.next()
        })

        // Now Playing Sheet Controls
        document.getElementById('btn-now-playing-collapse')?.addEventListener('click', () => {
            this.closeNowPlayingSheet()
        })

        document.getElementById('btn-np-play-pause')?.addEventListener('click', () => {
            if (ttsPlayer.state === 'playing') ttsPlayer.pause()
            else ttsPlayer.resume()
        })

        document.getElementById('btn-np-next')?.addEventListener('click', () => ttsPlayer.next())
        document.getElementById('btn-np-prev')?.addEventListener('click', () => ttsPlayer.prev())

        // Rate pill
        document.getElementById('btn-np-rate')?.addEventListener('click', () => {
            const rates = [0.75, 1.0, 1.25, 1.5, 2.0]
            const curIdx = rates.indexOf(ttsPlayer.rate)
            const nextRate = rates[(curIdx + 1) % rates.length]
            ttsPlayer.setRate(nextRate)
            const lbl = document.getElementById('np-rate-label')
            if (lbl) lbl.innerText = `${nextRate}x`
        })

        // Timer pill
        document.getElementById('btn-np-timer')?.addEventListener('click', () => {
            const timers = [0, 15, 30, 45, 60]
            const curIdx = timers.indexOf(ttsPlayer.sleepTimerDurationMinutes)
            const nextTimer = timers[(curIdx + 1) % timers.length]
            ttsPlayer.setSleepTimer(nextTimer)
            const timerLbl = document.getElementById('np-timer-label')
            if (timerLbl) {
                timerLbl.innerText = nextTimer > 0
                    ? t('mobile.nowPlaying.timerOn', { mins: nextTimer })
                    : t('mobile.nowPlaying.timerOff')
            }
        })

        // Engine pill (Issue 5 Fix)
        document.getElementById('btn-np-engine')?.addEventListener('click', () => {
            this.closeNowPlayingSheet()
            this.settingsPage.open('tts')
        })

        // Slider scrubbing (Issue 5 Fix)
        document.getElementById('np-progress-slider')?.addEventListener('change', (e) => {
            const targetIdx = parseInt(e.target.value, 10)
            if (!isNaN(targetIdx) && ttsPlayer.segments.length > 0) {
                ttsPlayer.play(targetIdx).catch(() => {})
            }
        })
    }

    updateMiniPlayerState(state) {
        const mini = document.getElementById('mobile-mini-player')
        if (!mini) return

        // Hide miniplayer in reader or when completely idle/stopped
        const isReaderActive = document.getElementById('reader-view')?.style.display !== 'none'
        if (isReaderActive || state === 'idle' || state === 'stopped') {
            mini.style.display = 'none'
            document.body.classList.remove('has-miniplayer')
            return
        }

        mini.style.display = 'flex'
        document.body.classList.add('has-miniplayer')

        const playIcon = document.getElementById('mini-icon-play')
        const pauseIcon = document.getElementById('mini-icon-pause')
        if (playIcon && pauseIcon) {
            playIcon.style.display = state === 'playing' ? 'none' : 'block'
            pauseIcon.style.display = state === 'playing' ? 'block' : 'none'
        }

        const app = window.app
        const titleEl = document.getElementById('mini-player-title')
        const snippetEl = document.getElementById('mini-player-snippet')
        const coverWrap = document.getElementById('mini-player-cover')

        const curBook = ttsPlayer.sessionBookOwner || app?.currentBookData
        const bookTitle = curBook?.title || t('tts.mediaTitleFallback')
        if (titleEl) titleEl.innerText = bookTitle
        if (coverWrap) {
            coverWrap.innerHTML = renderBookCoverHTML(curBook, 'mini-cover-img', true)
        }

        const curSeg = ttsPlayer.segments[ttsPlayer.currentIndex]
        if (snippetEl) {
            snippetEl.innerText = curSeg?.text || t('mobile.miniPlayer.ready')
        }
    }

    updateNowPlayingState(state) {
        const playIcon = document.getElementById('np-icon-play')
        const pauseIcon = document.getElementById('np-icon-pause')
        if (playIcon && pauseIcon) {
            playIcon.style.display = state === 'playing' ? 'none' : 'block'
            pauseIcon.style.display = state === 'playing' ? 'block' : 'none'
        }

        const curBook = ttsPlayer.sessionBookOwner || window.app?.currentBookData
        const npBookTitleEl = document.getElementById('np-book-title')
        const npChapterEl = document.getElementById('np-chapter-title')
        if (npBookTitleEl && !curBook?.title) {
            npBookTitleEl.innerText = t('mobile.nowPlaying.defaultBookTitle')
        }
        if (npChapterEl && !curBook?.currentChapterTitle) {
            npChapterEl.innerText = t('mobile.nowPlaying.defaultChapterTitle')
        }

        const curSeg = ttsPlayer.segments[ttsPlayer.currentIndex]
        const pTextEl = document.getElementById('np-paragraph-text')
        if (pTextEl) {
            pTextEl.innerText = curSeg?.text || t('mobile.nowPlaying.tapPlayPrompt')
        }

        const timerLbl = document.getElementById('np-timer-label')
        if (timerLbl) {
            const mins = Number(ttsPlayer.sleepTimerDurationMinutes) || 0
            timerLbl.innerText = mins > 0
                ? t('mobile.nowPlaying.timerOn', { mins })
                : t('mobile.nowPlaying.timerOff')
        }
        const engineLbl = document.getElementById('np-engine-label')
        if (engineLbl) {
            engineLbl.innerText = getTtsProviderLabel(window.advancedSettings?.config?.ttsProvider || 'system')
        }

        const curEl = document.getElementById('np-progress-cur')
        const totalEl = document.getElementById('np-progress-total')
        const slider = document.getElementById('np-progress-slider')
        if (ttsPlayer.segments.length > 0) {
            if (curEl) curEl.innerText = t('mobile.nowPlaying.segmentCurrent', { current: ttsPlayer.currentIndex + 1 })
            if (totalEl) totalEl.innerText = t('mobile.nowPlaying.segmentTotal', { total: ttsPlayer.segments.length })
            if (slider) {
                slider.disabled = false
                slider.max = ttsPlayer.segments.length - 1
                slider.value = ttsPlayer.currentIndex
            }
        } else {
            if (curEl) curEl.innerText = t('mobile.nowPlaying.waiting')
            if (totalEl) totalEl.innerText = t('mobile.nowPlaying.noSegments')
            if (slider) {
                slider.disabled = true
                slider.max = 0
                slider.value = 0
            }
        }
    }

    openNowPlayingSheet() {
        this.isNowPlayingOpen = true
        const sheet = document.getElementById('mobile-now-playing-sheet')
        if (sheet) sheet.classList.add('open')

        const app = window.app
        const titleEl = document.getElementById('np-book-title')
        const chapterEl = document.getElementById('np-chapter-title')
        const artworkWrap = document.getElementById('np-artwork-wrap')
        const curBook = ttsPlayer.sessionBookOwner || app?.currentBookData
        const bookTitle = curBook?.title || t('mobile.nowPlaying.defaultBookTitle')
        if (titleEl) titleEl.innerText = bookTitle
        if (chapterEl) {
            chapterEl.innerText = curBook?.currentChapterTitle || t('mobile.nowPlaying.defaultChapterTitle')
        }
        if (artworkWrap) {
            artworkWrap.innerHTML = renderBookCoverHTML(curBook, 'np-cover-img', false)
        }

        this.updateNowPlayingState(ttsPlayer.state)
    }

    closeNowPlayingSheet() {
        this.isNowPlayingOpen = false
        const sheet = document.getElementById('mobile-now-playing-sheet')
        if (sheet) sheet.classList.remove('open')
    }

    syncPdfControls() {
        const viewport = this.isInReader ? window.app?.pdfViewport : null
        const isPdf = Boolean(this.isInReader && (viewport || window.app?.currentBookData?.format === 'pdf'))
        const ready = Boolean(viewport?.numPages)
        document.body.classList.toggle('mobile-pdf-reading', isPdf)
        document.body.classList.toggle('mobile-pdf-tools-visible', isPdf && this.readerToolsVisible)
        const displayTitle = document.querySelector('#mobile-display-sheet .mobile-sheet-title')
        if (displayTitle) displayTitle.textContent = isPdf ? t('mobile.pdf.displayTitle') : t('mobile.display.title')
        const setHidden = (id, hidden) => {
            const element = document.getElementById(id)
            if (element) element.hidden = hidden
        }
        setHidden('mobile-pdf-progress', !isPdf)
        setHidden('mobile-pdf-display-controls', !isPdf)
        setHidden('mobile-reflow-controls', isPdf)
        setHidden('btn-mobile-reader-ai', isPdf)
        setHidden('btn-tool-pdf-search', !isPdf)
        const quiet = ready && !this.readerToolsVisible && !this.activeSheet && !this.isNowPlayingOpen
        setHidden('mobile-pdf-page-badge', !quiet)
        setHidden('mobile-pdf-reset-zoom', !(quiet && viewport.scale > viewport.getFitScale('fit-width') * 1.15))
        const badge = document.getElementById('mobile-pdf-page-badge')
        const page = ready ? viewport.currentPage + 1 : 1
        const total = ready ? viewport.numPages : 1
        if (badge) badge.textContent = `${page} / ${total}`
        const slider = document.getElementById('mobile-pdf-page-slider')
        const pageLabel = document.getElementById('btn-mobile-pdf-page')
        if (slider) {
            slider.disabled = !ready || total < 2
            slider.max = total
            if (!this._pdfScrubbing) slider.value = page
            slider.setAttribute('aria-valuetext', t('mobile.pdf.pageValueText', { page: slider.value, total }))
        }
        if (pageLabel) {
            pageLabel.disabled = !ready
            pageLabel.textContent = `${this._pdfScrubbing ? slider?.value : page} / ${total}`
        }
        const zoom = document.getElementById('mobile-pdf-zoom-value')
        if (zoom && ready) zoom.textContent = `${Math.round(viewport.scale * 100)}%`
        document.querySelectorAll('[data-pdf-fit]').forEach(button => {
            button.disabled = !ready
            button.setAttribute('aria-pressed', String(viewport?.zoomMode === button.dataset.pdfFit))
        })
        document.querySelectorAll('[data-pdf-appearance]').forEach(button => {
            button.setAttribute('aria-pressed', String((viewport?.pageAppearance || 'original') === button.dataset.pdfAppearance))
        })
    }

    getMobileDisplayDefaults() {
        return getDefaultReaderSettings({
            isMobile: this.isMobileViewport(),
            isAndroid: Boolean(platformBridge.isAndroid),
            viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 390,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 844
        })
    }

    setReaderToolsVisible(visible, bookTitle = '') {
        this.readerToolsVisible = visible !== undefined ? visible : !this.readerToolsVisible
        const topBar = document.getElementById('mobile-reader-top-bar')
        const bottomBar = document.getElementById('mobile-reader-bottom-bar')
        if (topBar) topBar.classList.toggle('visible', this.readerToolsVisible)
        if (bottomBar) bottomBar.classList.toggle('visible', this.readerToolsVisible)
        if (this.readerToolsVisible) {
            const isCbz = window.app?.currentBookData?.format === 'cbz' || window.app?.isCbz
            const isPdf = Boolean(document.body.classList.contains('mobile-pdf-reading') || window.app?.pdfViewport || window.app?.currentBookData?.format === 'pdf')
            const ttsBtn = document.getElementById('btn-tool-tts')
            if (ttsBtn) ttsBtn.style.display = (isCbz || isPdf) ? 'none' : 'flex'
        }
        if (bookTitle) {
            const titleEl = document.getElementById('mobile-reader-title')
            if (titleEl) titleEl.innerText = bookTitle
        }
        if (!this.readerToolsVisible) {
            this.closeAllSheets()
        }
        this.syncPdfControls()
    }

    toggleReaderTools(force) {
        this.setReaderToolsVisible(force !== undefined ? force : !this.readerToolsVisible)
    }

    updateReaderProgress(pctDisplay, chName) {
        const progressEl = document.getElementById('mobile-reader-progress-pct')
        const chapterEl = document.getElementById('mobile-reader-chapter-name')
        if (progressEl) progressEl.innerText = `${pctDisplay}%`
        if (chapterEl && chName) {
            this.hasReaderChapter = true
            chapterEl.innerText = chName
        }
        this.syncPdfControls()
    }

    updateUserProfileDisplay(displayName) {
        const nameEl = document.getElementById('mobile-user-name')
        const avatarEl = document.getElementById('mobile-user-avatar')
        const greetingEl = document.getElementById('mobile-home-greeting')
        const name = resolveGreetingDisplayName(displayName)
        if (nameEl) nameEl.innerText = name
        if (avatarEl) avatarEl.innerText = name ? name.charAt(0).toUpperCase() : 'R'
        if (greetingEl) {
            greetingEl.innerText = formatGreetingText(name)
        }
    }

    setupReaderToolListeners() {
        const appViewport = () => this.isInReader ? window.app?.pdfViewport : null
        document.getElementById('mobile-pdf-page-badge')?.addEventListener('click', () => window.app?.toggleReaderUI(true))
        document.getElementById('mobile-pdf-reset-zoom')?.addEventListener('click', () => appViewport()?.setZoom('fit-width'))
        document.getElementById('btn-tool-pdf-search')?.addEventListener('click', () => {
            window.app?.toggleReaderUI(false)
            window.app?.openDrawer('search')
        })
        document.getElementById('btn-mobile-pdf-page')?.addEventListener('click', () => this.openSheet('pdf-page'))
        const pageSlider = document.getElementById('mobile-pdf-page-slider')
        pageSlider?.addEventListener('pointerdown', () => {
            this._pdfScrubBook = window.app?.currentBookId
            this._pdfScrubbing = true
        })
        pageSlider?.addEventListener('input', () => {
            this._pdfScrubbing = true
            this.syncPdfControls()
        })
        pageSlider?.addEventListener('change', () => {
            const page = Number(pageSlider.value) - 1
            this._pdfScrubbing = false
            if (!this._pdfScrubBook || this._pdfScrubBook === window.app?.currentBookId) appViewport()?.goToPage(page)
            this._pdfScrubBook = null
            this.syncPdfControls()
        })
        pageSlider?.addEventListener('pointerup', () => {
            this._pdfScrubbing = false
        })
        pageSlider?.addEventListener('pointercancel', () => {
            this._pdfScrubbing = false
            this._pdfScrubBook = null
            this.syncPdfControls()
        })
        document.getElementById('mobile-pdf-page-form')?.addEventListener('submit', event => {
            event.preventDefault()
            const viewport = appViewport()
            const page = Number(document.getElementById('mobile-pdf-page-input')?.value)
            if (!viewport || !Number.isInteger(page) || page < 1 || page > viewport.numPages) return
            this.closeAllSheets()
            viewport.goToPage(page - 1)
        })
        document.querySelectorAll('[data-pdf-fit]').forEach(button => button.addEventListener('click', () => {
            appViewport()?.setZoom(button.dataset.pdfFit)
        }))
        for (const [id, factor] of [['btn-mobile-pdf-zoom-out', 1 / 1.2], ['btn-mobile-pdf-zoom-in', 1.2]]) {
            document.getElementById(id)?.addEventListener('click', () => {
                const viewport = appViewport()
                if (viewport) viewport.setZoom(viewport.scale * factor)
            })
        }
        document.querySelectorAll('[data-pdf-appearance]').forEach(button => button.addEventListener('click', () => {
            const mode = button.dataset.pdfAppearance
            appViewport()?.setPageAppearance(mode)
            window.app?.setSetting('pdfPageAppearance', mode)
            window.app?.saveSettingsDebounced()
            this.syncPdfControls()
        }))
        // Back to shelf
        document.getElementById('btn-mobile-reader-back')?.addEventListener('click', () => {
            window.app?.closeReader?.()
        })

        // AI trigger
        document.getElementById('btn-mobile-reader-ai')?.addEventListener('click', () => {
            document.getElementById('btn-toggle-ai-sidebar')?.click()
        })

        // 4 Bottom tools
        document.getElementById('btn-tool-toc')?.addEventListener('click', () => this.openSheet('toc'))
        document.getElementById('btn-tool-display')?.addEventListener('click', () => this.openSheet('display'))
        
        // TTS Tool trigger (Issue 9 Fix + Wave 2 start gating)
        document.getElementById('btn-tool-tts')?.addEventListener('click', async () => {
            if (ttsPlayer.state === 'idle' || ttsPlayer.state === 'stopped') {
                const started = await ttsPlayer.play(0).catch(() => false)
                if (started === false && (ttsPlayer.state === 'idle' || ttsPlayer.state === 'stopped')) {
                    return
                }
            }
            this.openNowPlayingSheet()
        })

        document.getElementById('btn-tool-more')?.addEventListener('click', () => this.openSheet('more'))

        // Display palette buttons
        document.querySelectorAll('.mobile-theme-palette-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const theme = pill.dataset.theme
                if (theme) {
                    window.app?.applyTheme?.(theme)
                    document.querySelectorAll('.mobile-theme-palette-pill').forEach(p => {
                        p.classList.toggle('active', p === pill)
                        p.setAttribute('aria-pressed', String(p === pill))
                    })
                }
            })
        })

        // Steppers (Issue 5 Fix)
        document.getElementById('btn-font-inc')?.addEventListener('click', () => {
            const cur = parseInt(window.app?.settings?.fontSize ?? this.getMobileDisplayDefaults().fontSize, 10)
            const next = Math.min(36, cur + 1)
            window.app?.setSetting?.('fontSize', next)
            window.app?.saveSettingsDebounced?.()
            const v = document.getElementById('val-font-size')
            if (v) v.innerText = `${next}px`
        })
        document.getElementById('btn-font-dec')?.addEventListener('click', () => {
            const cur = parseInt(window.app?.settings?.fontSize ?? this.getMobileDisplayDefaults().fontSize, 10)
            if (cur > 12) {
                const next = cur - 1
                window.app?.setSetting?.('fontSize', next)
                window.app?.saveSettingsDebounced?.()
                const v = document.getElementById('val-font-size')
                if (v) v.innerText = `${next}px`
            }
        })

        // Line-height Stepper (Issue 5 Fix)
        document.getElementById('btn-lh-inc')?.addEventListener('click', () => {
            const cur = parseFloat(window.app?.settings?.lineHeight ?? this.getMobileDisplayDefaults().lineHeight)
            const next = Math.min(2.5, +(cur + 0.1).toFixed(1))
            if (window.app?.currentBookFormat === 'epub' && window.app?.settings?.preserveOriginalStyles) {
                window.app?.setSetting?.('preserveOriginalStyles', false)
            }
            window.app?.setSetting?.('lineHeight', next)
            window.app?.saveSettingsDebounced?.()
            const v = document.getElementById('val-line-height')
            if (v) v.innerText = next.toFixed(1)
        })

        // Quick Font Selection (Feedback 3 & 150)
        document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(btn => {
            btn.addEventListener('click', () => {
                const fontKey = btn.dataset.mobileFont
                if (window.app?.currentBookFormat === 'epub') {
                    window.app?.setSetting?.('preserveOriginalStyles', false)
                }
                window.app?.setSetting?.('font', fontKey)
                window.app?.saveSettingsDebounced?.()
                window.app?.updateSettingsUI?.()
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    const active = b.dataset.mobileFont === fontKey
                    b.classList.toggle('active', active)
                    b.setAttribute('aria-pressed', String(active))
                })
            })
        })

        // Quick Page Turn Animation Selection (Feedback 3, 5 & 152)
        document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(btn => {
            btn.addEventListener('click', () => {
                const turnKey = syncMobilePageTurnUI(btn.dataset.mobileTurn)
                window.app?.setSetting?.('pageTurnMode', turnKey)
                window.app?.pageTurnController?.setMode?.(turnKey)
                window.app?.saveSettingsDebounced?.()
                if (window.app?.dom?.turnAnimationSelect) {
                    window.app.dom.turnAnimationSelect.value = turnKey
                }
            })
        })

        // Link to full appearance / reading settings
        document.getElementById('btn-mobile-more-reading-settings')?.addEventListener('click', () => {
            this.closeAllSheets()
            this.settingsPage.open('appearance')
        })
        document.getElementById('btn-lh-dec')?.addEventListener('click', () => {
            const cur = parseFloat(window.app?.settings?.lineHeight ?? this.getMobileDisplayDefaults().lineHeight)
            const next = Math.max(1.0, +(cur - 0.1).toFixed(1))
            if (window.app?.currentBookFormat === 'epub' && window.app?.settings?.preserveOriginalStyles) {
                window.app?.setSetting?.('preserveOriginalStyles', false)
            }
            window.app?.setSetting?.('lineHeight', next)
            window.app?.saveSettingsDebounced?.()
            const v = document.getElementById('val-line-height')
            if (v) v.innerText = next.toFixed(1)
        })

        // More sheet actions
        document.getElementById('cell-more-book-details')?.addEventListener('click', () => {
            this.closeAllSheets()
            const bId = window.app?.currentBookId || window.app?.currentBookData?.id
            if (bId) window.app?.openBookDetailsModal?.(bId)
        })
        document.getElementById('cell-more-translate')?.addEventListener('click', () => {
            this.closeAllSheets()
            window.app?.chapterTranslationManager?.openConfirmModal?.()
        })
        document.getElementById('cell-more-fit-width')?.addEventListener('click', () => {
            this.closeAllSheets()
            window.app?.pdfViewport?.setZoom?.('fit-width')
        })
        document.getElementById('cell-more-ocr-extract')?.addEventListener('click', () => {
            this.closeAllSheets()
            document.getElementById('btn-pdf-ocr-extract')?.click()
        })
    }

    openSheet(type) {
        this.closeAllSheets()
        this.activeSheet = type
        const backdrop = document.getElementById('mobile-sheet-backdrop')
        if (backdrop) backdrop.classList.add('open')
        this.syncPdfControls()

        if (type === 'toc') {
            const sheet = document.getElementById('mobile-toc-sheet')
            const container = document.getElementById('mobile-toc-container')
            const desktopToc = document.getElementById('toc-tree-container')
            if (sheet && container) {
                if (desktopToc && desktopToc.innerHTML.trim()) {
                    container.innerHTML = desktopToc.innerHTML
                } else {
                    container.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--mobile-text-muted);">${escapeHTML(t('annotations.toc.empty'))}</div>`
                }

                // Bind functional click to all toc items (Issue 2 Fix)
                const origItems = desktopToc ? Array.from(desktopToc.querySelectorAll('.toc-item')) : []
                container.querySelectorAll('.toc-item').forEach((item, idx) => {
                    item.addEventListener('click', (e) => {
                        e.stopPropagation()
                        const orig = origItems[idx]
                        if (orig) {
                            orig.click()
                        } else {
                            const href = item.dataset.href
                            if (window.app?.pdfViewport) {
                                const pageIdx = parseInt(href?.replace(/[^0-9]/g, ''), 10) - 1 || 0
                                window.app.pdfViewport.goToPage(pageIdx)
                            } else if (window.app?.foliateView && href) {
                                window.app.foliateView.goTo(href)
                            }
                        }
                        this.closeAllSheets()
                        this.setReaderToolsVisible(false)
                    })
                })
                sheet.classList.add('open')
            }
        } else if (type === 'display') {
            this.syncPdfControls()
            const sheet = document.getElementById('mobile-display-sheet')
            if (sheet) {
                // Sync current settings to UI
                const defaults = this.getMobileDisplayDefaults()
                const resolvedLayout = resolveEffectiveReaderLayout(window.app?.settings || {}, {
                    isMobile: this.isMobileViewport(),
                    isAndroid: Boolean(platformBridge.isAndroid),
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    format: window.app?.currentBookData?.format || ''
                })
                const fVal = document.getElementById('val-font-size')
                const lhVal = document.getElementById('val-line-height')
                const curFontSize = parseInt(window.app?.settings?.fontSize ?? resolvedLayout.fontSize ?? defaults.fontSize, 10)
                const curLineHeight = parseFloat(window.app?.settings?.lineHeight ?? resolvedLayout.layout?.lineHeight ?? defaults.lineHeight)
                if (fVal) fVal.innerText = `${curFontSize}px`
                if (lhVal) lhVal.innerText = `${Number.isFinite(curLineHeight) ? curLineHeight : defaults.lineHeight}`

                const curFont = window.app?.settings?.font || defaults.font || 'serif'
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    const active = b.dataset.mobileFont === curFont
                    b.classList.toggle('active', active)
                    b.setAttribute('aria-pressed', String(active))
                })

                const curTurn = syncMobilePageTurnUI(window.app?.settings?.pageTurnMode || defaults.pageTurnMode || 'slide')
                if (window.app?.settings?.pageTurnMode === 'curl') {
                    window.app.setSetting?.('pageTurnMode', curTurn)
                }
                const isSys = window.app?.themeMode === 'system'
                const curT = document.documentElement.getAttribute('data-theme') || 'light'
                document.querySelectorAll('.mobile-theme-palette-pill').forEach(p => {
                    p.setAttribute('aria-pressed', String(p.dataset.theme === (isSys ? 'system' : curT)))
                    if (isSys) {
                        p.classList.toggle('active', p.dataset.theme === 'system')
                    } else {
                        p.classList.toggle('active', p.dataset.theme === curT)
                    }
                })
                sheet.classList.add('open')
            }
        } else if (type === 'more') {
            const sheet = document.getElementById('mobile-more-sheet')
            if (sheet) {
                const isPdf = window.app?.currentBookData?.format === 'pdf'
                const isCbz = window.app?.currentBookData?.format === 'cbz' || window.app?.isCbz
                const transEl = document.getElementById('cell-more-translate')
                const fitWidthEl = document.getElementById('cell-more-fit-width')
                const ocrEl = document.getElementById('cell-more-ocr-extract')
                if (transEl) transEl.style.display = (['epub', 'txt'].includes(window.app?.currentBookData?.format)) ? 'flex' : 'none'
                if (fitWidthEl) fitWidthEl.style.display = isPdf ? 'flex' : 'none'
                if (ocrEl) ocrEl.style.display = isPdf ? 'flex' : 'none'
                sheet.classList.add('open')
            }
        } else if (type === 'pdf-page') {
            const viewport = window.app?.pdfViewport
            if (!viewport?.numPages) { this.closeAllSheets(); return }
            const input = document.getElementById('mobile-pdf-page-input')
            input.max = viewport.numPages
            input.value = viewport.currentPage + 1
            document.getElementById('mobile-pdf-page-range').textContent = t('mobile.pdf.pageRange', { total: viewport.numPages })
            document.getElementById('mobile-pdf-page-sheet').classList.add('open')
            input.focus()
            input.select()
        } else if (type === 'book-action') {
            const sheet = document.getElementById('mobile-book-action-sheet')
            if (sheet) sheet.classList.add('open')
        } else if (type === 'share') {
            const sheet = document.getElementById('mobile-share-action-sheet')
            if (sheet) sheet.classList.add('open')
        } else if (type === 'goal-edit') {
            const sheet = document.getElementById('mobile-goal-edit-sheet')
            if (sheet) sheet.classList.add('open')
        }
    }

    closeAllSheets() {
        this.activeSheet = null
        const bookMenu = document.getElementById('mobile-book-action-sheet')
        bookMenu?.classList.remove('mobile-book-popover')
        if (bookMenu) { bookMenu.style.removeProperty('left'); bookMenu.style.removeProperty('top'); bookMenu.style.removeProperty('width') }
        document.getElementById('mobile-sheet-backdrop')?.classList.remove('has-book-popover')
        document.getElementById('mobile-sheet-backdrop')?.classList.remove('open')
        document.querySelectorAll('.mobile-bottom-sheet').forEach(s => s.classList.remove('open'))
        const noteSheet = document.getElementById('mobile-note-actions-sheet')
        if (noteSheet) noteSheet.onclick = null
        document.getElementById('mobile-pdf-page-input')?.blur()
        this.syncPdfControls()
    }

    setupLongPressListeners() {
        const shelf = document.getElementById('bookshelf-view')
        if (!shelf) return

        let suppressNextClick = false

        shelf.addEventListener('touchstart', (e) => {
            if (e.touches && e.touches.length > 1) {
                cancelLongPress()
                return
            }
            const card = e.target.closest('.leaf-book-card')
            if (!card) return

            const bookId = card.dataset.id
            if (!bookId) return

            this.longPressTimer = setTimeout(() => {
                this.longPressTimer = null
                suppressNextClick = true
                setTimeout(() => { suppressNextClick = false }, 500)
                this.openBookActionSheet(bookId)
            }, 550)
        }, { passive: true })

        const cancelLongPress = () => {
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer)
                this.longPressTimer = null
            }
        }

        shelf.addEventListener('touchend', cancelLongPress, { passive: true })
        shelf.addEventListener('touchcancel', cancelLongPress, { passive: true })
        shelf.addEventListener('touchmove', cancelLongPress, { passive: true })

        shelf.addEventListener('click', (e) => {
            if (suppressNextClick) {
                suppressNextClick = false
                e.preventDefault()
                e.stopPropagation()
            }
        }, true)
    }

    async openBookActionSheet(bookId, anchor = null) {
        this.selectedBookForAction = bookId
        const book = await db.getBook(bookId)
        if (!book || this.selectedBookForAction !== bookId) return
        const app = window.app
        const bind = (id, action) => {
            const item = document.getElementById(id)
            if (item) item.onclick = async () => {
                this.closeAllSheets()
                try { await action() } catch (e) { app?.showToast?.(e.message || t('mobile.common.actionIncomplete'), 'warning') }
            }
        }
        document.getElementById('action-sheet-book-title').innerText = book.title || t('mobile.common.bookActions')
        document.getElementById('action-sheet-book-subtitle').innerText = `${(book.format || 'EPUB').toUpperCase()} · ${book.author || t('book.unknownAuthor')}`
        const statusLabels = getReadingStatusLabels()
        document.getElementById('act-sheet-current-status-tag').innerText = statusLabels[resolveReadingState(book)] || statusLabels.unread
        document.getElementById('act-sheet-category').hidden = true
        bind('act-sheet-read', () => app.openBook(bookId))
        bind('act-sheet-details', () => app.openBookDetailsModal(bookId))
        bind('act-sheet-edit', async () => {
            const title = await app.showInputDialog({ title: t('mobile.bookAction.editTitlePrompt'), value: book.title || '' })
            if (title === null || !title.trim()) return
            const author = await app.showInputDialog({ title: t('mobile.bookAction.editAuthorPrompt'), value: book.author || '' })
            if (author === null) return
            await db.updateBookMetadata(bookId, { title: title.trim(), author: author.trim() })
            await app.refreshBookshelf()
            this.renderHomeTab()
        })
        bind('act-sheet-tags', async () => {
            const sep = isEnglish() ? ', ' : '，'
            const value = await app.showInputDialog({
                title: t('mobile.bookAction.editTagsTitle'),
                message: t('mobile.bookAction.editTagsMessage'),
                value: (book.tags || []).join(sep)
            })
            if (value === null) return
            await updateBookTags(bookId, value.split(/[,，]/))
            await app.refreshBookshelf()
        })
        bind('act-sheet-booklist', () => app.openManageBookListsModal(bookId))
        bind('act-sheet-mark-as', () => {
            let sheet = document.getElementById('mobile-reading-status-sheet')
            if (!sheet) {
                sheet = document.createElement('div')
                sheet.id = 'mobile-reading-status-sheet'
                sheet.className = 'mobile-bottom-sheet mobile-only'
                document.getElementById('mobile-shell-root').appendChild(sheet)
            }
            sheet.innerHTML = `<div class="mobile-sheet-handle"></div><div class="mobile-sheet-header-compact"><h3 class="mobile-sheet-title" data-i18n="mobile.bookAction.statusSheetTitle">${escapeHTML(t('mobile.bookAction.statusSheetTitle'))}</h3></div><div class="mobile-sheet-content"><div class="mobile-group-box">${Object.entries(statusLabels).map(([status, label]) => `<button class="mobile-cell-item" type="button" data-status="${status}" aria-pressed="${resolveReadingState(book) === status}"><span>${escapeHTML(label)}</span>${resolveReadingState(book) === status ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : ''}</button>`).join('')}</div></div>`
            sheet.querySelectorAll('[data-status]').forEach(button => {
                button.onclick = async () => {
                    button.disabled = true
                    try {
                        await setReadingStatus(bookId, button.dataset.status)
                        this.closeAllSheets()
                        await app.refreshBookshelf()
                        this.renderHomeTab()
                    } catch (e) { app?.showToast?.(e.message || t('mobile.bookAction.updateFailed'), 'warning'); button.disabled = false }
                }
            })
            this.openSheet('reading-status')
            sheet.classList.add('open')
        })
        bind('act-sheet-select', () => {
            app.toggleBatchMode(true)
            if (!app.selectedBookIds.has(bookId)) app.toggleBookSelection(bookId)
        })
        bind('act-sheet-delete', async () => {
            await app.handleDeleteBook(book)
            this.renderHomeTab()
        })
        bind('act-sheet-more', () => this.openShareActionSheet(bookId))
        this.openSheet('book-action')
        const sheet = document.getElementById('mobile-book-action-sheet')
        const backdrop = document.getElementById('mobile-sheet-backdrop')
        const rect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
        if (sheet && rect && (rect.width > 0 || rect.height > 0)) {
            sheet.classList.add('mobile-book-popover')
            const width = Math.min(268, window.innerWidth - 32)
            const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0
            const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0
            const height = Math.min(sheet.scrollHeight, window.innerHeight - safeTop - safeBottom - 32)
            sheet.style.width = width + 'px'
            sheet.style.left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)) + 'px'
            sheet.style.top = Math.max(safeTop + 16, Math.min(rect.bottom, window.innerHeight - safeBottom - height - 16)) + 'px'
            backdrop?.classList.add('has-book-popover')
        } else if (sheet) {
            sheet.classList.remove('mobile-book-popover')
            sheet.style.removeProperty('left')
            sheet.style.removeProperty('top')
            sheet.style.removeProperty('width')
            backdrop?.classList.remove('has-book-popover')
        }
    }

    async openShareActionSheet(bookId) {
        this.selectedBookForShare = bookId
        const book = await db.getBook(bookId)
        if (!book || this.selectedBookForShare !== bookId) return
        document.getElementById('share-sheet-book-title').innerText = book.title || t('mobile.share.title')
        document.getElementById('share-sheet-book-subtitle').innerText = t('mobile.share.exportOriginalSubtitle')
        for (const id of ['share-act-poster', 'share-act-screenshot']) document.getElementById(id).hidden = true
        const exportFile = async (share) => {
            const app = window.app
            try {
                let nativePath = await db.getBookNativePath(bookId)
                const filename = book.filename || `${book.title || 'book'}.${book.format || 'epub'}`
                if (!nativePath) {
                    const snapshot = await db.getBookFileSnapshot(bookId)
                    if (!snapshot?.blob) throw new Error(t('mobile.share.downloadFirstError'))
                    nativePath = snapshot.nativePath || await platformBridge.createBookSnapshot(filename, await snapshot.blob.arrayBuffer())
                }
                if (!nativePath) throw new Error(t('mobile.share.unsupportedError'))
                this.closeAllSheets()
                const result = await platformBridge.exportBookFile(nativePath, filename, share)
                if (result?.cancelled) return
                if (!result?.success) throw new Error(result?.error || t('mobile.share.exportIncomplete'))
                app?.showToast?.(share ? t('mobile.share.openedSystemShare') : t('mobile.share.fileSaved'), 'success')
            } catch (e) { app?.showToast?.(e.message || t('mobile.share.exportFailed'), 'warning') }
        }
        document.getElementById('share-act-file').onclick = () => exportFile(true)
        document.getElementById('share-act-save').onclick = () => exportFile(false)
        this.openSheet('share')
    }

    openGoalEditSheet() {
        const storedGoal = parseInt(localStorage.getItem('linden_daily_goal_minutes') || '0', 10)
        const settingsGoal = Number(window.app?.settings?.readingGoalToday)
        const current = Math.max(1, Number.isFinite(settingsGoal) && settingsGoal > 0 ? settingsGoal : (storedGoal > 0 ? storedGoal : 45))
        const group = document.getElementById('goal-time-options')
        group?.querySelectorAll('.goal-pill-btn').forEach(button => {
            button.classList.toggle('active', Number(button.dataset.time) === current)
            button.onclick = () => {
                group.querySelectorAll('.goal-pill-btn').forEach(b => b.classList.remove('active'))
                button.classList.add('active')
            }
        })
        const save = document.getElementById('btn-save-reading-goal')
        if (save) save.onclick = async () => {
            const next = Number(group?.querySelector('.goal-pill-btn.active')?.dataset.time) || current
            try { localStorage.setItem('linden_daily_goal_minutes', String(next)) } catch {}
            if (window.app?.setSetting) {
                window.app.setSetting('readingGoalToday', next, 'global')
                if (window.app.appearance?.dom?.settingGoalToday) {
                    window.app.appearance.dom.settingGoalToday.value = next
                }
                await window.app.saveSettings?.()
            }
            this.closeAllSheets()
            this.renderHomeTab()
        }
        this.openSheet('goal-edit')
    }

    handleBackPress() {
        const historyDialog = document.getElementById('mobile-history-actions-dialog')
        if (historyDialog?.open) { historyDialog.close(); return true }
        // 1. Now Playing full sheet open?
        if (this.isNowPlayingOpen) {
            this.closeNowPlayingSheet()
            return true
        }

        // 2. Bottom sheets open? (TOC / Display / More / Book Action)
        if (this.activeSheet) {
            this.closeAllSheets()
            return true
        }

        if (this.settingsPage.back()) return true

        // 3. Reader tools visible? Dismiss them first
        if (this.readerToolsVisible) {
            this.setReaderToolsVisible(false)
            return true
        }

        // 4. In search view? Return to Shelf Tab
        if (this.currentTab === 'search') {
            this.switchTab('shelf')
            return true
        }

        // 5. In a mobile subview? (stats / ai-history)
        const aiSplit = document.querySelector('.ai-history-split-pane.show-detail')
        if (aiSplit) {
            aiSplit.classList.remove('show-detail')
            return true
        }
        if (document.body.classList.contains('mobile-subview-active')) {
            this.exitStatsOrAiSubview()
            return true
        }

        // 6. In Reader View? Let app.js handle reader exit & its internal state cleanly
        if (this.isInReader) {
            return false
        }

        // 7. Secondary Tab in mobile navigation? Return to Home Tab
        if (this.currentTab && this.currentTab !== 'home') {
            this.switchTab('home')
            return true
        }

        // 8. Hand off to app.js (modals, drawer, category reset, double-back to exit, etc.)
        return false
    }

    refreshLocale() {
        const root = document.getElementById('mobile-shell-root')
        if (root) applyI18n(root)

        const subviewHeader = document.getElementById('mobile-subview-header')
        if (subviewHeader) {
            applyI18n(subviewHeader)
            const subTitle = document.getElementById('mobile-subview-title')
            if (subTitle && this.activeSubviewKey) {
                subTitle.textContent = this.activeSubviewKey === 'stats'
                    ? t('nav.readingStats')
                    : t('nav.aiHistory')
            }
        }

        const shelfSearchBar = document.getElementById('mobile-shelf-search-bar')
        if (shelfSearchBar) {
            if (!this.isMobileViewport()) {
                shelfSearchBar.style.display = 'none'
            }
            applyI18n(shelfSearchBar)
            delete shelfSearchBar.dataset.localeApplied
        }

        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) {
            const layoutTitle = t('mobile.shelf.toggleLayoutTitle')
            paletteBtn.title = layoutTitle
            paletteBtn.setAttribute('aria-label', layoutTitle)
        }

        const versionEl = document.getElementById('mobile-app-version')
        if (versionEl && !versionEl.dataset.hasVersion) {
            versionEl.textContent = t('mobile.me.versionInfo')
        }

        if (!this.isInReader) {
            const readerTitleEl = document.getElementById('mobile-reader-title')
            if (readerTitleEl) readerTitleEl.innerText = t('mobile.reader.defaultTitle')
        }
        const chapterEl = document.getElementById('mobile-reader-chapter-name')
        if (chapterEl && !this.hasReaderChapter) {
            chapterEl.innerText = t('search.currentChapter')
        }

        const langNameEl = document.getElementById('mobile-current-language-name')
        if (langNameEl) langNameEl.innerText = isEnglish() ? t('settings.langEnBtn') : t('settings.langZhBtn')

        this.updateMiniPlayerState(ttsPlayer.state)
        this.updateNowPlayingState(ttsPlayer.state)
        this.syncPdfControls()

        if (this.activeSheet === 'pdf-page') {
            const viewport = window.app?.pdfViewport
            const rangeEl = document.getElementById('mobile-pdf-page-range')
            if (rangeEl && viewport?.numPages) {
                rangeEl.textContent = t('mobile.pdf.pageRange', { total: viewport.numPages })
            }
        } else if (this.activeSheet === 'reading-status') {
            const statusLabels = getReadingStatusLabels()
            document.querySelectorAll('#mobile-reading-status-sheet [data-status]').forEach(btn => {
                const span = btn.querySelector('span')
                if (span && statusLabels[btn.dataset.status]) {
                    span.textContent = statusLabels[btn.dataset.status]
                }
            })
        } else if (this.activeSheet === 'book-action' && this.selectedBookForAction) {
            db.getBook(this.selectedBookForAction).then(book => {
                if (!book || this.activeSheet !== 'book-action') return
                const titleEl = document.getElementById('action-sheet-book-title')
                const subEl = document.getElementById('action-sheet-book-subtitle')
                const tagEl = document.getElementById('act-sheet-current-status-tag')
                const statusLabels = getReadingStatusLabels()
                if (titleEl) titleEl.innerText = book.title || t('mobile.common.bookActions')
                if (subEl) subEl.innerText = `${(book.format || 'EPUB').toUpperCase()} · ${book.author || t('book.unknownAuthor')}`
                if (tagEl) tagEl.innerText = statusLabels[resolveReadingState(book)] || statusLabels.unread
            }).catch(() => {})
        } else if (this.activeSheet === 'share') {
            const subEl = document.getElementById('share-sheet-book-subtitle')
            if (subEl) subEl.innerText = t('mobile.share.exportOriginalSubtitle')
        } else if (this.activeSheet === 'toc') {
            const desktopToc = document.getElementById('toc-tree-container')
            const tocContainer = document.getElementById('mobile-toc-container')
            if (tocContainer && (!desktopToc || !desktopToc.innerHTML.trim())) {
                tocContainer.innerHTML = `<div style="padding: 2rem; text-align: center; color: var(--mobile-text-muted);">${escapeHTML(t('annotations.toc.empty'))}</div>`
            }
        }

        this.renderHomeTab()
        this.renderMeTab()
        if (this.isMobileViewport() && (this.currentTab === 'shelf' || document.getElementById('mobile-shelf-segmented-control'))) {
            this.renderShelfTab()
        }
        if (this.currentTab === 'notes') {
            this.renderNotesTab()
        }
        if (this.currentTab === 'search') {
            if (typeof this._runMobileSearch === 'function') this._runMobileSearch()
            else this.initSearchTab()
        }
        this._settingsPageInstance?.refreshLocale?.()
    }

    setupBackPressHandler() {
        // No-op: window.__handleAndroidBackPress is managed in app.js and delegates to this.handleBackPress()
    }
}

// Instantiate singleton
export const mobileShell = new MobileShellController()
if (typeof window !== 'undefined') {
    window.mobileShell = mobileShell
}
