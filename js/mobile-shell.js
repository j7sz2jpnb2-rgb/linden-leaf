/**
 * js/mobile-shell.js - Linden Leaf Mobile UI Controller & Adaptive Shell
 * 
 * Features:
 * - 4-Destination Inset Floating Bottom Navigation Bar: 书架 (Shelf), 笔记 (Notes), 搜索 (Search), 我的 (Me)
 * - Apple Music Style Floating MiniPlayer -> Expanding to Full Now Playing Sheet
 * - Immersive Reader Tool Layer (Floating Top Bar & 4-Action Bottom Bar: 目录, 显示, 听书, 更多)
 * - Pure SVG System Icons (Zero Emoji for functional controls)
 * - Dedicated Mobile Views:
 *   1. Compact Continue-Reading Card & Responsive Book Grid (No giant greeting screen)
 *   2. Comprehensive Notes View with Exact Position Jump (EPUB CFI & PDF Page)
 *   3. Real Realtime Search (Books & Notes with Race Condition Safeguard)
 *   4. Clean iOS/Apple Style Me Page (Reading Stats, AI History, WebDAV Sync, Themes, Settings)
 * - Mobile Touch & Long-Press Context Action Sheet for Books
 * - Single Unified Android Back Press Hierarchy & Safe Area Insets
 */

import * as db from './db.js'
import { ttsPlayer } from './tts-player.js'
import { platformBridge } from './platformBridge.js'
import { advancedSettings } from './advanced-settings.js'
import { MobileSettings } from './mobile-settings.js'
import { resolveReadingState, setReadingStatus, updateBookTags } from './tags-manager.js'

function escapeHTML(str) {
    if (!str) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function getBookFraction(book) {
    if (!book || !book.progress) return 0
    if (typeof book.progress === 'number' && Number.isFinite(book.progress)) {
        return Math.max(0, Math.min(1, book.progress))
    }
    if (typeof book.progress.fraction === 'number' && Number.isFinite(book.progress.fraction)) {
        return Math.max(0, Math.min(1, book.progress.fraction))
    }
    return 0
}

export function getBookCoverUrl(book) {
    if (!book) return null
    if (book.coverBlob && window.coverUrlPool) {
        return window.coverUrlPool.get(book.id, book.coverBlob)
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
    const title = book?.title || '无标题图书'
    const author = book?.author || '未知作者'
    const fmt = (book?.format || 'BOOK').toUpperCase()

    if (url) {
        return `<img class="mobile-book-cover-img ${escapeHTML(extraClass)}" src="${escapeHTML(url)}" alt="${escapeHTML(title)}" loading="lazy"/>`
    }

    // Editorial typographic cover fallback (NO app logo!)
    return `
        <div class="editorial-cover-fallback ${extraClass} ${isThumb ? 'is-thumb' : ''}">
            <div class="cover-fallback-header">
                <span class="cover-fallback-format">${escapeHTML(fmt)}</span>
            </div>
            <div class="cover-fallback-body">
                <div class="cover-fallback-title">${escapeHTML(title)}</div>
            </div>
            <div class="cover-fallback-footer">
                <span class="cover-fallback-author">${escapeHTML(author)}</span>
            </div>
        </div>
    `
}

if (typeof window !== 'undefined') {
    window.getBookCoverUrl = getBookCoverUrl
    window.renderBookCoverHTML = renderBookCoverHTML
}

export function formatNoteDate(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const day = d.getDate()
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${year}/${month}/${day} ${hour}:${min}`
}

export class MobileShellController {
    constructor() {
        this.currentTab = 'home' // 'home' | 'shelf' | 'notes' | 'me' | 'search'
        this.activeSheet = null // null | 'toc' | 'display' | 'more' | 'book-action'
        this.isNowPlayingOpen = false
        this.readerToolsVisible = false
        this.selectedBookForAction = null
        this.longPressTimer = null
        this.searchGeneration = 0
        this.isInReader = false
        this.settingsPage = new MobileSettings(this)

        this.init()
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
        if (window.visualViewport) {
            const handleViewportChange = () => {
                const isShort = window.visualViewport.height < window.innerHeight * 0.78
                document.documentElement.classList.toggle('keyboard-open', isShort)
                const keyboardHeight = Math.max(0, window.innerHeight - window.visualViewport.height - (window.visualViewport.offsetTop || 0))
                if (keyboardHeight > 50) {
                    document.documentElement.style.setProperty('--viewport-keyboard-offset', `${Math.round(keyboardHeight)}px`)
                } else {
                    document.documentElement.style.setProperty('--viewport-keyboard-offset', '0px')
                }
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

        // 5. Initial Refresh of Tabs (Switch immediately to eliminate cold-start shelf flash)
        this.switchTab('home')
        platformBridge.syncSystemInsets?.().catch?.(() => {})
        fetch('./build-info.json').then(r => r.ok ? r.json() : null).then(info => {
            const label = document.getElementById('mobile-app-version')
            if (label && info?.version) label.textContent = `v${info.version}`
        }).catch(() => {})
    }

    isMobileViewport() {
        return platformBridge.isAndroid || window.innerWidth < 768
    }

    handleResize() {
        const isMobile = this.isMobileViewport()
        document.documentElement.classList.toggle('is-mobile-viewport', isMobile)

        const mobileRoot = document.getElementById('mobile-shell-root')
        if (mobileRoot) {
            mobileRoot.style.display = isMobile ? 'block' : 'none'
        }

        const shelfArea = document.getElementById('bookshelf-view')
        const readerView = document.getElementById('reader-view')
        const isReaderActive = Boolean(this.isInReader || (readerView && readerView.classList.contains('active') && (window.getComputedStyle ? window.getComputedStyle(readerView).display !== 'none' : readerView.style.display === 'block')))

        if (!isMobile) {
            this.settingsPage.close()
            // Restore desktop view
            if (!isReaderActive && shelfArea) {
                shelfArea.style.display = 'flex'
            }
            this.closeAllSheets()
            this.closeNowPlayingSheet()
            this.setReaderToolsVisible(false)
        } else {
            // Mobile viewport: if not in reader, restore the active tab view
            if (!isReaderActive) {
                this.switchTab(this.currentTab || 'home')
            }
        }
    }

    setReaderInView(inReader) {
        this.settingsPage.close()
        this.isInReader = inReader
        document.body.classList.toggle('mobile-reader-active', inReader)
        const navBar = document.getElementById('mobile-nav-bar')
        if (navBar) {
            navBar.classList.toggle('hidden-in-reader', inReader)
        }
        const globalFab = document.getElementById('btn-mobile-global-fab')
        if (globalFab) {
            globalFab.style.display = inReader ? 'none' : ((this.currentTab === 'home' || this.currentTab === 'shelf') ? 'flex' : 'none')
        }
        if (inReader) {
            const shelfHeader = document.getElementById('mobile-header-bar')
            if (shelfHeader) shelfHeader.style.display = 'none'
            const shelfPalette = document.getElementById('btn-mobile-palette')
            if (shelfPalette) shelfPalette.style.display = 'none'
            // Deactivate all mobile tabs and bottom bar active states when reader is open
            document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
            document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))
            this.closeAllSheets()
            this.setReaderToolsVisible(false)
            this.syncPdfControls()
            this.updateMiniPlayerState(ttsPlayer.state)
        } else {
            document.body.classList.remove('mobile-pdf-reading', 'mobile-pdf-tools-visible')
            this._pdfScrubbing = false
            this._pdfScrubBook = null
            this.setReaderToolsVisible(false)
            this.switchTab(this.currentTab || 'home')
        }
    }

    injectMobileDOM() {
        if (document.getElementById('mobile-shell-root')) return

        const root = document.createElement('div')
        root.id = 'mobile-shell-root'
        root.className = 'mobile-shell-root'

        root.innerHTML = `
            <!-- Tab 1: Reading Home (12_122.jpg & 15_122.jpg Reproduction) -->
            <section id="mobile-home-view" class="mobile-view-container mobile-only active">
                <header class="mobile-home-top-bar" id="mobile-home-top-bar">
                    <div class="home-top-left">
                        <h1 class="mobile-reading-title mobile-home-title">首页</h1>
                        <p class="mobile-reading-greeting" id="mobile-home-greeting"></p>
                    </div>
                    <div class="home-top-actions">
                        <button id="btn-home-menu" class="mobile-header-circle-btn" title="更多设置">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                        </button>
                    </div>
                </header>

                <div class="mobile-home-cards-container" id="mobile-home-cards-container">
                    <!-- Populated dynamically by renderHomeTab() according to 12_122.jpg & 15_122.jpg -->
                </div>
            </section>

            <!-- Mobile Bookshelf Header Bar -->
            <header id="mobile-header-bar" class="mobile-header-bar mobile-only" style="display: none;">
                <div class="mobile-header-title-group">
                    <h1 class="mobile-header-title">书架</h1>
                    <span class="mobile-header-subtitle" id="mobile-shelf-book-count">共 0 本藏书</span>
                </div>
                <div class="mobile-header-actions">
                    <button id="btn-mobile-shelf-filter" class="mobile-icon-btn" title="筛选图书">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
                    </button>
                    <button id="btn-mobile-import-book" class="mobile-icon-btn" title="导入图书">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                </div>
            </header>

            <!-- Tab 3: Mobile Notes View (Template 10_122.jpg Direct Reproduction) -->
            <section id="mobile-notes-view" class="mobile-view-container mobile-only">
                <header class="mobile-notes-header">
                    <div class="notes-header-left">
                        <h1 class="mobile-notes-title">想法</h1>
                    </div>
                    <div class="notes-header-actions">
                        <button id="btn-mobile-export-notes" class="mobile-header-circle-btn" title="复制全部笔记">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1.8"/><circle cx="5" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                        </button>
                        <button id="btn-mobile-notes-avatar" class="mobile-header-circle-btn" title="个人中心">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </button>
                    </div>
                </header>
                <div id="mobile-notes-list" class="mobile-notes-list">
                    <!-- Populated dynamically -->
                </div>
                <button id="btn-mobile-notes-fab" class="mobile-notes-fab" title="记录想法">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
            </section>

            <!-- Search Subview (Triggered from Bookshelf) -->
            <section id="mobile-search-view" class="mobile-view-container mobile-only">
                <div class="mobile-search-header">
                    <button id="btn-mobile-search-back" class="mobile-icon-btn" title="返回书架">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <div class="mobile-search-input-box">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" id="mobile-search-input" placeholder="搜索书名、作者或笔记内容..." autocomplete="off"/>
                        <button id="btn-mobile-clear-search" class="mobile-search-clear-btn" style="display: none;">✕</button>
                    </div>
                </div>
                <div id="mobile-search-results" class="mobile-search-results">
                    <!-- Populated dynamically -->
                </div>
            </section>

            <section id="mobile-me-view" class="mobile-view-container mobile-only">
                <header class="mobile-me-header"><h1 class="mobile-header-title">我的</h1></header>
                <div class="mobile-profile-hero">
                    <button type="button" class="mobile-profile-user-row" id="cell-open-profile">
                        <span class="mobile-profile-info"><span class="mobile-profile-name" id="mobile-user-name">诶云朵？！</span><span class="mobile-profile-sub">个人资料与阅读目标</span></span>
                        <span class="mobile-profile-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span>
                    </button>
                    <button type="button" class="mobile-profile-stats-card" id="cell-profile-stats" aria-label="查看阅读统计">
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-hours">0 分钟</span><span class="mobile-stat-key">阅读时长</span></span>
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-books">0</span><span class="mobile-stat-key">藏书</span></span>
                        <span class="mobile-stat-col"><span class="mobile-stat-val" id="mobile-stat-notes">0</span><span class="mobile-stat-key">想法</span></span>
                    </button>
                </div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title">阅读记录</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-stats"><span class="mobile-cell-left"><span class="mobile-cell-label">阅读统计</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-ai-history"><span class="mobile-cell-left"><span class="mobile-cell-label">AI 阅读记录</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title">阅读偏好</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-display-theme"><span class="mobile-cell-left"><span class="mobile-cell-label">外观与排版</span></span><span class="mobile-cell-right"><span id="mobile-current-theme-name">浅色</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-tts-settings"><span class="mobile-cell-left"><span class="mobile-cell-label">听书</span></span><span class="mobile-cell-right"><span id="mobile-tts-engine-name">系统语音</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-advanced-settings"><span class="mobile-cell-left"><span class="mobile-cell-label">全部设置</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
                <div class="mobile-settings-group"><h2 class="mobile-group-title">数据与应用</h2><div class="mobile-group-box">
                    <button type="button" class="mobile-cell-item" id="cell-open-webdav"><span class="mobile-cell-left"><span class="mobile-cell-label">云端同步</span></span><span class="mobile-cell-right"><span id="mobile-sync-status-text">未配置</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-open-backup"><span class="mobile-cell-left"><span class="mobile-cell-label">数据与备份</span></span><span class="mobile-cell-right"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                    <button type="button" class="mobile-cell-item" id="cell-about-app"><span class="mobile-cell-left"><span class="mobile-cell-label">关于 Linden Leaf</span></span><span class="mobile-cell-right"><span id="mobile-app-version">版本信息</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></span></button>
                </div></div>
            </section>

            <!-- Floating Apple Music Style Mini-Player -->
            <div id="mobile-mini-player" class="mobile-mini-player mobile-only" style="display: none;">
                <div class="mini-cover-thumb" id="mini-player-cover"></div>
                <div class="mini-meta-box">
                    <span class="mini-title" id="mini-player-title">Linden Leaf 朗读</span>
                    <span class="mini-snippet" id="mini-player-snippet">准备播放...</span>
                </div>
                <div class="mini-actions">
                    <button id="btn-mini-play-pause" class="mini-btn" title="播放 / 暂停">
                        <svg id="mini-icon-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
                        <svg id="mini-icon-pause" viewBox="0 0 24 24" style="display: none;"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>
                    </button>
                    <button id="btn-mini-next" class="mini-btn" title="下一段">
                        <svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                </div>
            </div>

            <!-- Full Now Playing Sheet -->
            <div id="mobile-now-playing-sheet" class="mobile-now-playing-sheet mobile-only">
                <div class="now-playing-header">
                    <button id="btn-now-playing-collapse" class="now-playing-collapse-btn" title="收起播放器">
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    <span class="now-playing-header-title">正在朗读</span>
                    <div style="width: 36px;"></div>
                </div>

                <div class="now-playing-artwork-wrap" id="np-artwork-wrap"></div>

                <div class="now-playing-title-box">
                    <h2 class="now-playing-book-title" id="np-book-title">书名</h2>
                    <p class="now-playing-chapter-title" id="np-chapter-title">章节</p>
                </div>

                <div class="now-playing-paragraph-card" id="np-paragraph-text">
                    轻点下方播放键开始朗读当前段落...
                </div>

                <div class="now-playing-progress-wrap">
                    <input type="range" id="np-progress-slider" class="now-playing-slider" min="0" max="100" value="0"/>
                    <div class="now-playing-time-row">
                        <span id="np-progress-cur">第 1 段</span>
                        <span id="np-progress-total">共 1 段</span>
                    </div>
                </div>

                <div class="now-playing-main-controls">
                    <button id="btn-np-prev" class="np-btn np-btn-step" title="上一段">
                        <svg viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20" fill="currentColor"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                    <button id="btn-np-play-pause" class="np-btn np-btn-play" title="播放 / 暂停">
                        <svg id="np-icon-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg>
                        <svg id="np-icon-pause" viewBox="0 0 24 24" style="display: none;"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>
                    </button>
                    <button id="btn-np-next" class="np-btn np-btn-step" title="下一段">
                        <svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                    </button>
                </div>

                <div class="now-playing-secondary-row">
                    <button id="btn-np-rate" class="np-pill-opt" title="朗读语速">
                        <span id="np-rate-label">1.0x</span>
                    </button>
                    <button id="btn-np-timer" class="np-pill-opt" title="睡眠定时">
                        <span id="np-timer-label">定时: 关</span>
                    </button>
                    <button id="btn-np-engine" class="np-pill-opt" title="语音引擎">
                        <span id="np-engine-label">系统语音</span>
                    </button>
                </div>
            </div>

            <!-- Docked Bottom 4-Destination Navigation Bar (Matching Image 15 with Safe Cushion & Labels) -->
            <nav id="mobile-nav-bar" class="mobile-nav-bar mobile-only">
                <button class="mobile-nav-tab active" data-tab="home" id="tab-btn-home" aria-label="首页">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                    </div>
                    <span class="mobile-nav-label">首页</span>
                </button>
                <button class="mobile-nav-tab" data-tab="shelf" id="tab-btn-shelf" aria-label="书架">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    </div>
                    <span class="mobile-nav-label">书架</span>
                </button>
                <button class="mobile-nav-tab" data-tab="notes" id="tab-btn-notes" aria-label="想法">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m16 3 5 5-10 10-5 1 1-5Z"/><path d="m14 5 5 5"/></svg>
                    </div>
                    <span class="mobile-nav-label">想法</span>
                </button>
                <button class="mobile-nav-tab" data-tab="me" id="tab-btn-me" aria-label="我的">
                    <div class="mobile-nav-icon-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    </div>
                    <span class="mobile-nav-label">我的</span>
                </button>
            </nav>

            <!-- Immersive Reader Floating Mobile Top Bar -->
            <div id="mobile-reader-top-bar" class="mobile-reader-top-bar mobile-only">
                <button id="btn-mobile-reader-back" class="mobile-icon-btn" title="返回书架">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <span id="mobile-reader-title" class="mobile-reader-title">书名</span>
                <div style="display: flex; gap: 0.35rem;">
                    <button id="btn-mobile-pdf-more" class="mobile-icon-btn" aria-label="更多操作" hidden>
                        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                    </button>
                    <button id="btn-mobile-reader-ai" class="mobile-icon-btn" title="AI 阅读助手">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    </button>
                </div>
            </div>

            <!-- Immersive Reader Floating Mobile Bottom Bar (4 Tools) -->
            <div id="mobile-reader-bottom-bar" class="mobile-reader-bottom-bar mobile-only">
                <div id="mobile-pdf-progress" class="mobile-pdf-progress" hidden>
                    <button id="btn-mobile-pdf-page" class="mobile-pdf-page-number" aria-label="跳转页码">1 / 1</button>
                    <input id="mobile-pdf-page-slider" type="range" min="1" max="1" value="1" aria-label="阅读页码"/>
                </div>
                <div class="mobile-reader-tools-row">
                    <button id="btn-tool-toc" class="mobile-reader-tool-btn" title="目录">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        <span>目录</span>
                    </button>
                    <button id="btn-tool-display" class="mobile-reader-tool-btn" title="显示设置">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19L9.5 5h1L16 19"/><path d="M6 14h8"/><path d="M17 19l2.5-6h.5l2.5 6"/><path d="M18 16.5h3.5"/></svg>
                        <span>显示</span>
                    </button>
                    <button id="btn-tool-tts" class="mobile-reader-tool-btn" title="听书">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                        <span>听书</span>
                    </button>
                    <button id="btn-tool-pdf-search" class="mobile-reader-tool-btn" aria-label="搜索文档" hidden>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
                        <span>搜索</span>
                    </button>
                    <button id="btn-tool-more" class="mobile-reader-tool-btn" title="更多">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                        <span>更多</span>
                    </button>
                </div>
                <div class="mobile-reader-meta-row">
                    <span id="mobile-reader-chapter-name">当前章节</span>
                    <span id="mobile-reader-progress-pct">0%</span>
                </div>
            </div>

            <button id="mobile-pdf-page-badge" class="mobile-pdf-page-badge mobile-only" aria-label="显示阅读控制" hidden></button>
            <button id="mobile-pdf-reset-zoom" class="mobile-pdf-reset-zoom mobile-only" hidden>恢复适宽</button>

            <!-- Mobile Bottom Sheet Backdrop -->
            <div id="mobile-sheet-backdrop" class="mobile-bottom-sheet-backdrop mobile-only"></div>

            <!-- Mobile TOC Sheet -->
            <div id="mobile-toc-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title">书籍目录</h3>
                <div class="mobile-sheet-content" id="mobile-toc-container"></div>
            </div>

            <!-- Mobile Display & Theme Sheet -->
            <div id="mobile-display-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title">阅读外观与主题</h3>
                <div class="mobile-sheet-content">
                    <div id="mobile-pdf-display-controls" class="mobile-pdf-display-controls" hidden>
                        <div class="mobile-pdf-fit-options">
                            <button type="button" data-pdf-fit="fit-width">适合宽度</button>
                            <button type="button" data-pdf-fit="fit-page">完整一页</button>
                        </div>
                        <div class="mobile-pdf-zoom-row">
                            <span>缩放</span>
                            <div class="mobile-pdf-zoom-stepper">
                                <button id="btn-mobile-pdf-zoom-out" type="button" aria-label="缩小">−</button>
                                <output id="mobile-pdf-zoom-value">100%</output>
                                <button id="btn-mobile-pdf-zoom-in" type="button" aria-label="放大">+</button>
                            </div>
                        </div>
                        <div class="mobile-pdf-appearance" aria-label="页面颜色">
                            <button type="button" data-pdf-appearance="original">原色</button>
                            <button type="button" data-pdf-appearance="night">夜间</button>
                        </div>
                        <p class="mobile-pdf-display-hint">夜间会调整页面颜色，彩色图表建议使用原色。</p>
                    </div>
                    <button type="button" class="mobile-theme-system mobile-theme-palette-pill" data-theme="system">跟随系统<span class="mobile-theme-check" aria-hidden="true">✓</span></button>
                    <div class="mobile-theme-palette-row">
                        <button class="mobile-theme-palette-pill" data-theme="light" style="background: #ffffff; color: #1c1917;">浅色</button>
                        <button class="mobile-theme-palette-pill" data-theme="sepia" style="background: #f4ecd8; color: #451a03;">羊皮纸</button>
                        <button class="mobile-theme-palette-pill" data-theme="dark" style="background: #1c1917; color: #f5f5f4;">深灰</button>
                        <button class="mobile-theme-palette-pill" data-theme="black" style="background: #000000; color: #e7e5e4;">纯黑</button>
                    </div>

                    <div id="mobile-reflow-controls">
                    <div class="mobile-stepper-row">
                        <span class="mobile-stepper-label">字号</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-font-dec" class="mobile-stepper-btn">A-</button>
                            <span id="val-font-size">18px</span>
                            <button id="btn-font-inc" class="mobile-stepper-btn">A+</button>
                        </div>
                    </div>

                    <div class="mobile-stepper-row" style="margin-top: 1rem;">
                        <span class="mobile-stepper-label">行距</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-lh-dec" class="mobile-stepper-btn">-</button>
                            <span id="val-line-height">1.6</span>
                            <button id="btn-lh-inc" class="mobile-stepper-btn">+</button>
                        </div>
                    </div>

                    <div class="mobile-sheet-subheading">正文字体</div>
                    <div class="mobile-option-row" id="mobile-font-family-row">
                        <button type="button" class="mobile-option-pill" data-mobile-font="serif" style="font-family: var(--font-serif, 'Noto Serif SC', serif);">宋体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="sans" style="font-family: var(--font-sans, 'Noto Sans SC', sans-serif);">黑体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="kaiti" style="font-family: var(--font-kaiti, 'LXGW WenKai', serif);">楷体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="mono" style="font-family: var(--font-mono, monospace);">等宽</button>
                    </div>

                    <div class="mobile-sheet-subheading">翻页动效</div>
                    <div class="mobile-option-row" id="mobile-page-turn-row">
                        <button type="button" class="mobile-option-pill" data-mobile-turn="none">无动画</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="slide">滑动</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="cover">覆盖</button>
                    </div>

                    <button type="button" id="btn-mobile-more-reading-settings" class="mobile-sheet-link-btn">
                        <span>更多排版与显示设置</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                    </div>
                </div>
            </div>

            <div id="mobile-pdf-page-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title">跳转页码</h3>
                <form id="mobile-pdf-page-form" class="mobile-sheet-content">
                    <label for="mobile-pdf-page-input" id="mobile-pdf-page-range">页码</label>
                    <div class="mobile-pdf-jump-row">
                        <input id="mobile-pdf-page-input" type="number" inputmode="numeric" min="1" required aria-label="目标页码"/>
                        <button type="submit">前往</button>
                    </div>
                </form>
            </div>

            <!-- Mobile More Actions Sheet -->
            <div id="mobile-more-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <h3 class="mobile-sheet-title">更多操作</h3>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="cell-more-book-details">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                </span>
                                <span class="mobile-cell-label">书籍详情与元数据</span>
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
                                <span class="mobile-cell-label">本章双语翻译</span>
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
                                <span class="mobile-cell-label">恢复页面适宽</span>
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
                                <span class="mobile-cell-label">提取当前页面文字 (OCR)</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Book Long-Press Action Sheet (14_122.jpg Reproduction) -->
            <div id="mobile-book-action-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title" id="action-sheet-book-title">图书操作</h3>
                    <span class="mobile-sheet-subtitle" id="action-sheet-book-subtitle">EPUB</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="act-sheet-read">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                                </span>
                                <span class="mobile-cell-label">打开阅读</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-details">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                </span>
                                <span class="mobile-cell-label">信息</span>
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
                                <span class="mobile-cell-label">编辑信息</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-tags">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>
                                </span>
                                <span class="mobile-cell-label">标签</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-category">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                </span>
                                <span class="mobile-cell-label">分类</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-booklist">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                                </span>
                                <span class="mobile-cell-label">加入书单</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-mark-as">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="16 10 11 15 8 12"/></svg>
                                </span>
                                <span class="mobile-cell-label" id="act-sheet-mark-label">标记为...</span>
                            </div>
                            <div class="mobile-cell-right">
                                <span id="act-sheet-current-status-tag" style="font-size: 12px; color: var(--mobile-text-muted);">在读</span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-select">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                                </span>
                                <span class="mobile-cell-label">选择</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-delete">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon" style="color: #ef4444;">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                </span>
                                <span class="mobile-cell-label" style="color: #ef4444;">移除</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="act-sheet-more">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                                </span>
                                <span class="mobile-cell-label">更多</span>
                            </div>
                            <div class="mobile-cell-right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Share Action Sheet (14_122.jpg Right Half Direct Reproduction) -->
            <div id="mobile-share-action-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title" id="share-sheet-book-title">分享图书</h3>
                    <span class="mobile-sheet-subtitle" id="share-sheet-book-subtitle">选择分享方式</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="mobile-group-box">
                        <div class="mobile-cell-item" id="share-act-file">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                </span>
                                <span class="mobile-cell-label">分享文件</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-poster">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                                </span>
                                <span class="mobile-cell-label">分享统计海报</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-screenshot">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                                </span>
                                <span class="mobile-cell-label">分享页面截图</span>
                            </div>
                        </div>
                        <div class="mobile-cell-item" id="share-act-save">
                            <div class="mobile-cell-left">
                                <span class="mobile-cell-icon">
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                                </span>
                                <span class="mobile-cell-label">保存到本地</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Mobile Goal Edit Sheet (12_122.jpg & 15_122.jpg Today's Goal Configuration) -->
            <div id="mobile-goal-edit-sheet" class="mobile-bottom-sheet mobile-only">
                <div class="mobile-sheet-handle"></div>
                <div class="mobile-sheet-header-compact">
                    <h3 class="mobile-sheet-title">编辑今日阅读目标</h3>
                    <span class="mobile-sheet-subtitle">给自己留一段阅读时间</span>
                </div>
                <div class="mobile-sheet-content">
                    <div class="goal-setting-block">
                        <label class="goal-setting-label">每日阅读时长</label>
                        <div class="goal-pill-group" id="goal-time-options">
                            <button type="button" class="goal-pill-btn" data-time="30">30 分钟</button>
                            <button type="button" class="goal-pill-btn" data-time="60">60 分钟</button>
                            <button type="button" class="goal-pill-btn active" data-time="120">2 小时</button>
                            <button type="button" class="goal-pill-btn" data-time="180">3 小时</button>
                        </div>
                    </div>
                    <button type="button" class="mobile-btn-primary" id="btn-save-reading-goal" style="width: 100%; margin-top: 18px; padding: 12px; border-radius: 9999px; background: var(--mobile-primary, #da7756); color: #fff; font-weight: 600; border: none; cursor: pointer;">
                        保存目标
                    </button>
                </div>
            </div>

            <!-- Floating Palette Button (14_122.jpg & 15_122.jpg Bottom Right) -->
            <button id="btn-mobile-palette" class="mobile-floating-palette-btn mobile-only" title="排版切换 (列表 / 网格)" style="display: none;">
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

        // Top bar action buttons (12_122.jpg & 15_122.jpg)
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

        // Floating Palette button (14_122.jpg list/grid mode toggle)
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) {
            document.querySelector('#mobile-header-bar .mobile-header-actions')?.prepend(paletteBtn)
            paletteBtn.title = '切换列表 / 网格'
            paletteBtn.setAttribute('aria-label', '切换列表 / 网格')
            paletteBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'
        }
        paletteBtn?.addEventListener('click', () => {
            const grid = document.getElementById('books-grid')
            if (grid) {
                const isList = grid.classList.toggle('is-list-mode')
                localStorage.setItem('linden_mobile_shelf_mode', isList ? 'list' : 'grid')
                paletteBtn.classList.toggle('active', isList)
            }
        })

        // Mobile Sheet Backdrop click
        document.getElementById('mobile-sheet-backdrop')?.addEventListener('click', () => {
            this.closeAllSheets()
        })
    }

    switchTab(targetTab) {
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

        // Specific Tab Loads
        if (targetTab === 'home') {
            this.renderHomeTab()
        } else if (targetTab === 'shelf') {
            this.renderShelfTab()
        } else if (targetTab === 'notes') {
            this.renderNotesTab()
        } else if (targetTab === 'search') {
            this.initSearchTab()
        } else if (targetTab === 'me') {
            this.renderMeTab()
        }
    }

    ensureSubviewHeader(title) {
        const workspace = document.querySelector('#bookshelf-view .jane-content-workspace') || document.getElementById('bookshelf-view')
        if (!workspace) return
        let header = document.getElementById('mobile-subview-header')
        if (!header) {
            header = document.createElement('header')
            header.id = 'mobile-subview-header'
            header.className = 'mobile-only'
            header.innerHTML = `
                <button type="button" class="mobile-subview-back" id="btn-mobile-subview-back" aria-label="返回">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    <span>返回</span>
                </button>
                <span class="mobile-subview-title" id="mobile-subview-title"></span>
                <span style="width: 64px;" aria-hidden="true"></span>
            `
            header.querySelector('#btn-mobile-subview-back')?.addEventListener('click', () => {
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
        document.body.classList.add('mobile-subview-active')
        const headerBar = document.getElementById('mobile-header-bar')
        if (headerBar) headerBar.style.display = 'none'
        const contCard = document.getElementById('mobile-continue-reading-container')
        if (contCard) contCard.style.display = 'none'
        const globalFab = document.getElementById('btn-mobile-global-fab')
        if (globalFab) globalFab.style.display = 'none'
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) paletteBtn.style.display = 'none'

        document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))

        const shelfArea = document.getElementById('bookshelf-view')
        if (shelfArea) shelfArea.style.display = 'flex'
        this.ensureSubviewHeader('阅读统计')

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
        document.body.classList.add('mobile-subview-active')
        const headerBar = document.getElementById('mobile-header-bar')
        if (headerBar) headerBar.style.display = 'none'
        const contCard = document.getElementById('mobile-continue-reading-container')
        if (contCard) contCard.style.display = 'none'
        const globalFab = document.getElementById('btn-mobile-global-fab')
        if (globalFab) globalFab.style.display = 'none'
        const paletteBtn = document.getElementById('btn-mobile-palette')
        if (paletteBtn) paletteBtn.style.display = 'none'

        document.querySelectorAll('.mobile-nav-tab').forEach(el => el.classList.remove('active'))
        document.querySelectorAll('.mobile-view-container').forEach(el => el.classList.remove('active'))

        const shelfArea = document.getElementById('bookshelf-view')
        if (shelfArea) shelfArea.style.display = 'flex'
        this.ensureSubviewHeader('AI 问答历史')

        const aiNavBtn = document.getElementById('nav-cat-ai-history')
        if (aiNavBtn) {
            aiNavBtn.click()
        } else if (typeof window.app?.switchShelfCategory === 'function') {
            window.app.switchShelfCategory('ai-history')
        }
    }

    exitStatsOrAiSubview() {
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

    ensureShelfSegmentedControl(books) {
        const shelfScreen = document.getElementById('modern-shelf-screen')
        if (!shelfScreen || !shelfScreen.parentNode) return

        let segControl = document.getElementById('mobile-shelf-segmented-control')
        if (!segControl) {
            segControl = document.createElement('div')
            segControl.id = 'mobile-shelf-segmented-control'
            segControl.className = 'mobile-shelf-segmented-control mobile-only'
            shelfScreen.parentNode.insertBefore(segControl, shelfScreen)
        }

        const allCount = books?.length || 0
        let readingCount = 0
        let shelvedCount = 0
        let finishedCount = 0
        if (books) {
            for (const b of books) {
                const state = resolveReadingState(b)
                if (state === 'reading') readingCount++
                else if (state === 'on_hold') shelvedCount++
                else if (state === 'finished') finishedCount++
            }
        }

        const currentFilter = this.shelfFilter || 'all'

        segControl.innerHTML = `
            <button class="shelf-seg-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">
                <span>全部</span>
                <span class="shelf-seg-count">${allCount}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'reading' ? 'active' : ''}" data-filter="reading">
                <span>在读</span>
                <span class="shelf-seg-count">${readingCount}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'on_hold' ? 'active' : ''}" data-filter="on_hold">
                <span>搁置</span>
                <span class="shelf-seg-count">${shelvedCount}</span>
            </button>
            <button class="shelf-seg-btn ${currentFilter === 'finished' ? 'active' : ''}" data-filter="finished">
                <span>读完</span>
                <span class="shelf-seg-count">${finishedCount}</span>
            </button>
        `

        segControl.querySelectorAll('.shelf-seg-btn').forEach(btn => {
            btn.onclick = () => {
                const filter = btn.dataset.filter || 'all'
                this.applyShelfFilter(filter, books)
            }
        })
    }

    applyShelfFilter(filter, books) {
        this.shelfFilter = filter

        // Update active class on buttons
        const segControl = document.getElementById('mobile-shelf-segmented-control')
        if (segControl) {
            segControl.querySelectorAll('.shelf-seg-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.filter === filter)
            })
        }

        const bookMap = new Map()
        if (books) {
            books.forEach(b => bookMap.set(String(b.id), b))
        }

        const grid = document.getElementById('books-grid')
        let visibleCount = 0
        if (grid) {
            const cards = grid.querySelectorAll('.jane-book-card')
            cards.forEach(card => {
                const bookId = card.dataset.id
                const book = bookMap.get(String(bookId))
                const state = book ? resolveReadingState(book) : 'unread'

                let show = false
                if (filter === 'all') {
                    show = true
                } else if (filter === 'reading') {
                    show = (state === 'reading')
                } else if (filter === 'on_hold') {
                    show = (state === 'on_hold')
                } else if (filter === 'finished') {
                    show = (state === 'finished')
                }

                card.style.display = show ? '' : 'none'
                if (show) visibleCount++

                if (book) {
                    let author = card.querySelector('.mobile-book-author')
                    if (!author) { author = document.createElement('div'); author.className = 'mobile-book-author mobile-only'; card.appendChild(author) }
                    author.textContent = book.author || '未知作者'
                    let info = card.querySelector('.mobile-book-info')
                    if (!info) { info = document.createElement('div'); info.className = 'mobile-book-info mobile-only'; card.appendChild(info) }
                    const names = { unread: '未读', want_to_read: '想读', reading: '在读', on_hold: '搁置', finished: '读完' }
                    info.textContent = [(book.format || '').toUpperCase(), names[state], getBookFraction(book) > 0 ? Math.round(getBookFraction(book) * 100) + '%' : ''].filter(Boolean).join(' · ')
                }
                // Ensure mobile more button (···) is present (14_122.jpg reproduction)
                let moreBtn = card.querySelector('.mobile-book-more-btn')
                if (!moreBtn) {
                    moreBtn = document.createElement('button')
                    moreBtn.className = 'mobile-book-more-btn mobile-only'
                    moreBtn.type = 'button'
                    moreBtn.title = '图书操作'
                    moreBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`
                    moreBtn.addEventListener('click', (e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        this.openBookActionSheet(bookId, moreBtn)
                    })
                    card.appendChild(moreBtn)
                }
            })

            let emptyHint = grid.querySelector('.mobile-shelf-empty-hint')
            if (visibleCount === 0) {
                if (!emptyHint) {
                    emptyHint = document.createElement('div')
                    emptyHint.className = 'mobile-shelf-empty-hint mobile-only'
                    emptyHint.style.cssText = 'grid-column: 1 / -1; padding: 48px 20px; text-align: center; color: var(--mobile-text-muted); font-size: 0.9rem;'
                    grid.appendChild(emptyHint)
                }
                const labelMap = { all: '书架暂无藏书', reading: '暂无正在阅读的图书', on_hold: '暂无搁置的图书', finished: '暂无已读完的图书' }
                emptyHint.textContent = labelMap[filter] || '暂无图书'
                emptyHint.style.display = 'block'
            } else if (emptyHint) {
                emptyHint.style.display = 'none'
            }
        } else {
            visibleCount = books?.length || 0
        }

        const countEl = document.getElementById('mobile-shelf-book-count')
        if (countEl) {
            const labelMap = { all: '全部藏书', reading: '在读藏书', on_hold: '搁置藏书', finished: '已读藏书' }
            countEl.innerText = `共 ${visibleCount} 本${labelMap[filter] || '藏书'}`
        }

        const searchSpan = document.querySelector('#mobile-shelf-search-bar .mobile-shelf-search-inner span')
        if (searchSpan) {
            searchSpan.innerText = `搜索 ${visibleCount} 本书`
        }
    }

    ensureShelfSearchBar() {
        const shelfScreen = document.getElementById('modern-shelf-screen')
        if (!shelfScreen || !shelfScreen.parentNode) return

        let searchBar = document.getElementById('mobile-shelf-search-bar')
        if (!searchBar) {
            searchBar = document.createElement('div')
            searchBar.id = 'mobile-shelf-search-bar'
            searchBar.className = 'mobile-shelf-search-bar mobile-only'
            searchBar.innerHTML = `
                <div class="mobile-shelf-search-inner">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <span>搜索书名、作者或笔记...</span>
                </div>
            `
            shelfScreen.parentNode.insertBefore(searchBar, shelfScreen)
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

    async renderShelfTab() {
        if (this.currentTab === 'shelf') {
            const shelfArea = document.getElementById('bookshelf-view')
            if (shelfArea) shelfArea.style.display = 'flex'
            const headerBar = document.getElementById('mobile-header-bar')
            if (headerBar) headerBar.style.display = 'flex'
        }

        let books = []
        try {
            books = await db.getAllBooks()
        } catch (_) {}

        this.ensureShelfSegmentedControl(books)
        this.ensureShelfSearchBar()
        this.applyShelfFilter(this.shelfFilter || 'all', books)

        // Restore list/grid layout mode
        const savedMode = localStorage.getItem('linden_mobile_shelf_mode')
        const grid = document.getElementById('books-grid')
        if (grid && savedMode === 'list') {
            grid.classList.add('is-list-mode')
            document.getElementById('btn-mobile-palette')?.classList.add('active')
        }
    }

    async refreshContinueReadingCard() {
        // Compatibility forwarder
        await this.renderHomeTab()
        this.ensureShelfSearchBar()
    }

    async renderHomeTab() {
        const container = document.getElementById('mobile-home-cards-container')
        if (!container) return

        const userName = window.app?.getUserDisplayName?.() || localStorage.getItem('linden_user_name') || '诶云朵？！'

        const greeting = document.getElementById('mobile-home-greeting')
        if (greeting) { const h = new Date().getHours(); greeting.textContent = (h < 11 ? '早上好' : h < 18 ? '下午好' : '晚上好') + '，' + userName }
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
                        <h3 class="home-empty-title">书架尚无图书</h3>
                        <p class="home-empty-desc">导入一本心仪的电子书，开启今日的阅读时光。</p>
                        <button class="home-empty-btn" id="btn-home-empty-import" type="button">
                            <span>导入图书</span>
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

            const totalSecs = analytics?.totalSeconds ?? books.reduce((acc, b) => acc + (b.totalReadingSeconds || 0), 0)
            const totalH = Math.floor(totalSecs / 3600)
            const totalM = Math.floor((totalSecs % 3600) / 60)
            const totalBooksCount = books.length
            const readingStatsStr = totalH > 0
                ? `${totalH} 小时 ${totalM} 分钟 · ${totalBooksCount} 本`
                : (totalM > 0 ? `${totalM} 分钟 · ${totalBooksCount} 本` : `0 分钟 · ${totalBooksCount} 本`)

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
            let bookTimeStr = '0 分钟'
            if (bSecs >= 3600) {
                const bH = Math.floor(bSecs / 3600)
                const bM = Math.floor((bSecs % 3600) / 60)
                bookTimeStr = `${bH} 小时 ${bM} 分钟`
            } else if (bSecs >= 60) {
                const bM = Math.floor(bSecs / 60)
                bookTimeStr = `${bM} 分钟`
            } else if (bSecs > 0) {
                bookTimeStr = `${bSecs} 秒`
            } else {
                bookTimeStr = (pct > 0 ? '少于 1 分钟' : '未开始阅读')
            }

            // Streak days (computed from analytics or stored preference)
            const streakDays = Math.max(0, Number(analytics?.streakDays) || 0)

            // User initial or avatar
            const userInitial = userName ? userName.charAt(0).toUpperCase() : 'R'

            // 3. Today's Reading Goals (Card 3 Dynamic Calculation)
            const targetMins = Math.max(1, parseInt(localStorage.getItem('linden_daily_goal_minutes') || '30', 10) || 30)

            const todaySecs = Math.max(0, Number(analytics?.todaySeconds) || 0)
            const todayMins = Math.floor(todaySecs / 60)
            const todayH = Math.floor(todayMins / 60)
            const remM = todayMins % 60
            const todayTimeStr = todayH > 0 ? `${todayH} 小时 ${remM} 分钟` : `${todayMins} 分钟`
            const targetTimeStr = `${targetMins} 分钟`

            const timePct = Math.min(100, Math.round((todayMins / targetMins) * 100))
            const encouragement = timePct >= 100 ? '今日目标已完成，留一点时间给自己。'
                : todaySecs > 0 ? `今天已读 ${todayTimeStr}，按自己的节奏继续。` : '从几页书开始，享受一段安静的时间。'

            // 4. Recommended books gallery (Image 15: horizontal list)
            const otherBooks = books.filter(b => b.id !== currentBook.id)
            const recList = otherBooks.length > 0 ? otherBooks : books
            const start = (this.recommendationOffset || 0) % recList.length
            const recommendations = [...recList.slice(start), ...recList.slice(0, start)].slice(0, 10)
            const recsHTML = recommendations.map(b => `
                <div class="home-rec-item" data-rec-id="${b.id}">
                    <div class="home-rec-cover">
                        ${renderBookCoverHTML(b, 'rec-cover-inner', true)}
                    </div>
                    <span class="home-rec-title" title="${escapeHTML(b.title || '无标题')}">${escapeHTML(b.title || '无标题')}</span>
                </div>
            `).join('')

            if (this.homeGeneration !== renderGeneration) return
            // Render reading overview and the current book.
            container.innerHTML = `
                <!-- Card 1: 累计阅读卡 (Cumulative Reading Card) -->
                <div class="home-card home-cumulative-card" id="home-card-cumulative">
                    <div class="home-cumulative-left">
                        <div class="home-avatar-circle" id="home-avatar-circle">
                            <span>${escapeHTML(userInitial)}</span>
                        </div>
                        <div class="home-cumulative-info">
                            <span class="home-cumulative-title">累计阅读</span>
                            <span class="home-cumulative-sub" id="home-cumulative-sub">${readingStatsStr}</span>
                        </div>
                    </div>
                    <div class="home-card-chevron">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                </div>

                <!-- Card 2: 正在读主角卡 (Hero Card) -->
                <div class="home-card home-hero-card" id="home-hero-card" data-book-id="${escapeHTML(String(currentBook.id || ''))}">
                    <div class="home-hero-header">
                        <span class="home-hero-label" id="btn-home-hero-reading-link">
                            正在读
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                        <span class="home-hero-streak-badge">${streakDays > 0 ? `连续阅读 ${streakDays} 天` : '从今天开始'}</span>
                    </div>
                    <div class="home-hero-body" id="btn-home-hero-open">
                        <div class="home-hero-book-3d reading-book-cover-3d">
                            ${renderBookCoverHTML(currentBook, 'stage-main-cover-inner')}
                        </div>
                        <div class="home-hero-info">
                            <h2 class="home-hero-book-title hero-book-title reading-stage-book-title">${escapeHTML(currentBook.title || '无标题图书')}</h2>
                            <p class="home-hero-book-author reading-stage-book-author">${escapeHTML(currentBook.author || '未知作者')}</p>
                            <div class="home-hero-progress-row">
                                <span>阅读进度</span>
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
                            <span>本书已读 ${bookTimeStr}</span>
                        </span>
                        <button type="button" class="home-hero-action" id="btn-home-continue-reading">
                            继续阅读
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </button>
                    </div>
                </div>

                <!-- Card 3: 今日目标卡 (Today's Reading Goals) -->
                <div class="home-card home-goals-card" id="home-goals-card">
                    <div class="home-goals-header">
                        <span class="home-goals-title">今日目标</span>
                        <div class="home-goals-actions">
                            <button type="button" class="home-goals-action-btn" id="btn-goal-share" title="分享" hidden>
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                            </button>
                            <button type="button" class="home-goals-action-btn" id="btn-goal-edit" title="编辑目标">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                            </button>
                        </div>
                    </div>
                    <p class="home-goals-encouragement">${escapeHTML(encouragement)}</p>
                    <div class="home-goal-item">
                        <div class="home-goal-item-top">
                            <span class="home-goal-item-left">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                                <span>阅读时长</span>
                            </span>
                            <span class="home-goal-item-val"><strong>${escapeHTML(todayTimeStr)}</strong> / ${escapeHTML(targetTimeStr)}</span>
                        </div>
                        <div class="home-goal-track">
                            <div class="home-goal-fill" style="width: ${timePct}%;"></div>
                        </div>
                    </div>
                </div>

                <!-- Card 4: 随机推荐 / 书架精选 (Random Recommendations) -->
                <div class="home-card home-recs-card" id="home-recs-card">
                    <div class="home-recs-header">
                        <span class="home-recs-title" id="btn-home-recs-title">
                            书架精选
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        </span>
                        <button type="button" class="home-recs-refresh-btn" id="btn-recs-refresh" title="换一批">
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
                this.switchTab('shelf')
                this.applyShelfFilter('reading', books)
            })

            container.querySelector('#home-hero-card')?.addEventListener('click', () => {
                window.app?.openBook?.(currentBook.id)
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

            container.querySelectorAll('.home-rec-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation()
                    const bId = item.dataset.recId
                    if (bId) window.app?.openBook?.(bId)
                })
            })

        } catch (err) {
            console.error('[MobileShell] Error rendering home tab:', err)
        }
    }

    async renderNotesTab() {
        const listEl = document.getElementById('mobile-notes-list')
        const countEl = document.getElementById('mobile-notes-count')
        if (!listEl) return

        try {
            const highlights = await db.getAllHighlights()
            const books = await db.getAllBooks()
            const bookMap = new Map((books || []).map(b => [b.id, b]))

            if (countEl) countEl.innerText = `${highlights.length} 条划线与批注`

            if (!highlights || highlights.length === 0) {
                listEl.innerHTML = `
                    <div class="mobile-empty-state">
                        <div class="mobile-empty-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        </div>
                        <h4 class="mobile-empty-title">暂无读书笔记</h4>
                        <p class="mobile-empty-desc">阅读时长按选中文本，轻点「划线」或「批注」即可汇总在此。</p>
                    </div>
                `
                return
            }

            // Sort highlights by createdAt desc
            const sortedHl = highlights.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

            // Section 8 "想法" Style: Quiet source citation inside quote block, upright quote body, unboxed comments, quiet footer
            listEl.innerHTML = sortedHl.map(hl => {
                const book = bookMap.get(hl.bookId)
                const bookTitle = book?.title || '未知图书'
                const sourceCitation = hl.chapterTitle ? escapeHTML(hl.chapterTitle) : `《${escapeHTML(bookTitle)}》`
                const dateStr = formatNoteDate(hl.createdAt)
                const quoteText = hl.text || ''
                const noteText = hl.note || ''
                const noteTitle = hl.title || ''
                const fullCopyText = quoteText ? (noteText ? `${quoteText}\n\n想法：${noteText}` : quoteText) : noteText

                const rawColor = String(hl.color || '#D8D2C5').trim()
                const quoteColor = /^[#a-zA-Z0-9(),.%\s-]+$/.test(rawColor) ? rawColor : '#D8D2C5'
                const safeHlId = escapeHTML(String(hl.id || ''))
                const safeBookId = escapeHTML(String(hl.bookId || ''))

                return `
                    <div class="mobile-note-card" data-hl-id="${safeHlId}" data-book-id="${safeBookId}">
                        ${noteTitle ? `<h3 class="note-card-title">${escapeHTML(noteTitle)}</h3>` : ''}
                        ${quoteText ? `
                            <div class="note-quote-block" style="border-left-color: ${escapeHTML(quoteColor)};">
                                <div class="note-quote-source"><span class="note-source-title">${sourceCitation}</span></div>
                                <div class="note-quote-body">${escapeHTML(quoteText)}</div>
                            </div>
                        ` : ''}
                        ${noteText ? `<div class="note-thought-body">${escapeHTML(noteText)}</div>` : ''}
                        <div class="note-card-footer">
                            <span class="note-footer-date">${dateStr}</span>
                            <div class="note-footer-actions">
                                <button class="note-act-more-btn" title="更多操作" data-hl-id="${safeHlId}" data-book-id="${safeBookId}" data-text="${escapeHTML(fullCopyText)}">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                `
            }).join('')

            // Bind jump action to card click and quote click
            const handleJump = async (bId, hlId) => {
                if (!bId) return
                const hl = highlights.find(h => String(h.id) === String(hlId))
                const target = hl?.pdfTarget || {}
                const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                const page = firstSegment?.page ?? target.page ?? 0
                const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                const firstRect = rects?.[0]
                const yRatio = firstRect ? firstRect[1] : 0
                const loc = hl?.cfi ? { cfi: hl.cfi } : ((hl?.pdfTarget || hl?.formatType === 'pdf') ? { page: page + 1, yRatio } : null)

                if (window.app?.currentBookId && String(window.app.currentBookId) === String(bId)) {
                    this.setReaderInView(true)
                    const readerView = document.getElementById('reader-view')
                    if (readerView) readerView.style.display = 'block'
                    if (window.app.pdfViewport && (hl?.pdfTarget || hl?.formatType === 'pdf')) {
                        window.app.pdfViewport.goToPage(page, yRatio)
                        window.app.pdfViewport.pulseHighlight?.(page, hl.id, rects)
                    } else if (hl?.cfi && window.app.foliateView) {
                        window.app.foliateView.goTo(hl.cfi)
                    }
                } else {
                    await window.app?.openBook?.(bId, loc)
                }
            }

            listEl.querySelectorAll('.mobile-note-card').forEach(card => {
                card.addEventListener('click', async (e) => {
                    if (e.target.closest('.note-act-more-btn')) return
                    await handleJump(card.dataset.bookId, card.dataset.hlId)
                })
            })

            listEl.querySelectorAll('.note-act-more-btn').forEach(btn => {
                btn.addEventListener('click', async function noteActions(event) {
    event.stopPropagation()
    const highlight = highlights.find(item => String(item.id) === String(btn.dataset.hlId))
    if (!highlight) return
    const book = bookMap.get(highlight.bookId)
    let sheet = document.getElementById('mobile-note-actions-sheet')
    if (!sheet) {
        sheet = document.createElement('div')
        sheet.id = 'mobile-note-actions-sheet'
        sheet.className = 'mobile-bottom-sheet mobile-only'
        document.getElementById('mobile-shell-root').appendChild(sheet)
    }
    sheet.innerHTML = '<div class="mobile-sheet-handle"></div><div class="mobile-sheet-header-compact"><h3 class="mobile-sheet-title">这条想法</h3></div><div class="mobile-sheet-content"><div class="mobile-group-box"><button type="button" class="mobile-cell-item" data-note-action="locate">定位原文</button><button type="button" class="mobile-cell-item" data-note-action="copy">复制笔记</button><button type="button" class="mobile-cell-item" data-note-action="quote">制作书摘</button></div></div>'
    const actions = {
        locate: () => handleJump(highlight.bookId, highlight.id),
        copy: async () => {
            if (!navigator.clipboard) throw new Error('当前环境无法复制文字')
            await navigator.clipboard.writeText(btn.dataset.text || '')
            window.app?.showToast?.('笔记已复制', 'success')
        },
        quote: () => window.app?.openQuoteCardModal?.(highlight.text || highlight.note || '',
            highlight.chapterTitle || '', null,
            { bookId: highlight.bookId, bookTitle: book?.title || '未知图书', author: book?.author || '', format: book?.format || '' })
    }
    sheet.querySelectorAll('[data-note-action]').forEach(button => {
        button.onclick = async () => {
            this.closeAllSheets()
            try { await actions[button.dataset.noteAction]() }
            catch (error) { window.app?.showToast?.(error.message || '操作未完成', 'warning') }
        }
    })
    this.openSheet('note-actions')
    sheet.classList.add('open')
}.bind(this))
            })

            const btnNotesFab = document.getElementById('btn-mobile-notes-fab')
            if (btnNotesFab) {
                btnNotesFab.onclick = () => {
                    if (window.app?.currentBookId) {
                        this.setReaderInView(true)
                        const readerView = document.getElementById('reader-view')
                        if (readerView) readerView.style.display = 'block'
                        window.app?.showToast?.('在阅读时长按选中文本即可划线或批注', 'ℹ')
                    } else {
                        window.app?.showToast?.('打开书籍并长按文字即可添加想法', 'ℹ')
                    }
                }
            }

            // Bind export button
            const btnExportNotes = document.getElementById('btn-mobile-export-notes')
            if (btnExportNotes) {
                btnExportNotes.onclick = async () => {
                    let md = `# Linden Leaf 读书笔记汇编\n\n`
                    md += `* 导出时间：${new Date().toLocaleString()}\n`
                    md += `* 笔记总数：${highlights.length}\n\n---\n\n`
                    sortedHl.forEach((hl, i) => {
                        const b = bookMap.get(hl.bookId)
                        md += `### ${i + 1}. 《${b?.title || '未知图书'}》${hl.chapterTitle ? ' - ' + hl.chapterTitle : ''}\n\n`
                        md += `> ${(hl.text || '').replace(/\n/g, '\n> ')}\n\n`
                        if (hl.note) md += `**想法**：${hl.note}\n\n`
                        md += `*记录于 ${hl.createdAt ? new Date(hl.createdAt).toLocaleDateString() : ''}*\n\n---\n\n`
                    })
                    if (navigator.clipboard) {
                        await navigator.clipboard.writeText(md)
                        window.app?.showToast?.('笔记已复制到剪贴板 (Markdown)', '✓')
                    }
                }
            }

        } catch (e) {
            console.error('[MobileShell] Error rendering notes tab:', e)
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
                        <h4 class="mobile-empty-title">搜书名、作者或笔记</h4>
                        <p class="mobile-empty-desc">输入关键字实时在藏书与划线笔记中检索。</p>
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
                        <h4 class="mobile-empty-title">未找到相关结果</h4>
                        <p class="mobile-empty-desc">请尝试调整关键词或搜索其他书名。</p>
                    </div>
                `
                return
            }

            let html = ''
            if (matchedBooks.length > 0) {
                html += `<div class="search-section-label">相关图书 (${matchedBooks.length})</div>`
                html += matchedBooks.map(b => {
                    const coverHtml = renderBookCoverHTML(b, 'search-result-cover-img', true)
                    const pct = Math.round(getBookFraction(b) * 100)
                    return `
                        <div class="search-result-book-item" data-book-id="${escapeHTML(String(b.id || ''))}">
                            <div class="search-result-thumb">
                                ${coverHtml}
                            </div>
                            <div class="search-result-info">
                                <div class="search-result-title">${escapeHTML(b.title)}</div>
                                <div class="search-result-meta">${escapeHTML(b.author || '未知作者')} · 进度 ${pct}%</div>
                            </div>
                        </div>
                    `
                }).join('')
            }

            if (matchedNotes.length > 0) {
                const bookMap = new Map((books || []).map(b => [b.id, b]))
                html += `<div class="search-section-label">匹配笔记 (${matchedNotes.length})</div>`
                html += matchedNotes.slice(0, 15).map(hl => {
                    const book = bookMap.get(hl.bookId)
                    return `
                        <div class="mobile-note-card search-result-note-item" data-book-id="${escapeHTML(String(hl.bookId || ''))}" data-hl-id="${escapeHTML(String(hl.id || ''))}">
                            <div class="note-card-meta">
                                <span class="note-source-title">《${escapeHTML(book?.title || '书籍')}》${hl.chapterTitle ? ' · ' + escapeHTML(hl.chapterTitle) : ''}</span>
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
                    const target = hl?.pdfTarget || {}
                    const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                    const page = firstSegment?.page ?? target.page ?? 0
                    const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                    const firstRect = rects?.[0]
                    const yRatio = firstRect ? firstRect[1] : 0
                    const loc = hl?.cfi ? { cfi: hl.cfi } : ((hl?.pdfTarget || hl?.formatType === 'pdf') ? { page: page + 1, yRatio } : null)

                    if (window.app?.currentBookId && String(window.app.currentBookId) === String(bId)) {
                        this.setReaderInView(true)
                        const readerView = document.getElementById('reader-view')
                        if (readerView) readerView.style.display = 'block'
                        if (window.app.pdfViewport && (hl?.pdfTarget || hl?.formatType === 'pdf')) {
                            window.app.pdfViewport.goToPage(page, yRatio)
                            window.app.pdfViewport.pulseHighlight?.(page, hl.id, rects)
                        } else if (hl?.cfi && window.app.foliateView) {
                            window.app.foliateView.goTo(hl.cfi)
                        }
                    } else {
                        await window.app?.openBook?.(bId, loc)
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

        if (!input.value.trim()) {
            doSearch('')
        }
    }

    async renderMeTab() {
        try {
            const books = await db.getAllBooks()
            const highlights = await db.getAllHighlights()
            const stats = await db.getReadingStats()

            // Safe resolution of reading hours from real totalSeconds (Issue 10 Fix)
            const totalSec = stats?.totalSeconds || 0
            const minutes = Math.round((totalSec || (stats?.totalHours || 0) * 3600) / 60)
            const readingTime = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`
            const booksCount = books?.length || 0
            const notesCount = highlights?.length || 0

            const hEl = document.getElementById('mobile-stat-hours')
            const bEl = document.getElementById('mobile-stat-books')
            const nEl = document.getElementById('mobile-stat-notes')

            if (hEl) hEl.innerText = readingTime
            if (bEl) bEl.innerText = booksCount
            if (nEl) nEl.innerText = notesCount

            // User Display Name & Avatar
            const userName = window.app?.getUserDisplayName?.() || localStorage.getItem('linden_user_name') || '诶云朵？！'
            const uNameEl = document.getElementById('mobile-user-name')
            const uAvatarEl = document.getElementById('mobile-user-avatar')
            if (uNameEl) uNameEl.innerText = userName
            if (uAvatarEl) uAvatarEl.innerText = userName.charAt(0).toUpperCase()

            // Theme name
            const isSystem = window.app?.themeMode === 'system'
            const curTheme = document.documentElement.getAttribute('data-theme') || 'light'
            const themeNames = { light: '浅色', sepia: '羊皮', dark: '夜间', black: '纯黑' }
            const tNameEl = document.getElementById('mobile-current-theme-name')
            if (tNameEl) tNameEl.innerText = isSystem ? `跟随系统 (${themeNames[curTheme] || curTheme})` : (themeNames[curTheme] || curTheme)

            // Sync Status
            const syncStatusEl = document.getElementById('mobile-sync-status-text')
            if (syncStatusEl) {
                const cfg = window.app?.syncConfig
                syncStatusEl.innerText = cfg?.serverUrl && cfg?.username ? (cfg.enabled ? '已开启' : '已配置') : '未配置'
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
            document.getElementById('cell-profile-stats').onclick = () => this.openStatsSubview()
            const engineName = { system: '系统语音', offline: '自建服务', api: '云端 API' }
            document.getElementById('mobile-tts-engine-name').textContent = engineName[advancedSettings.config.ttsProvider] || '系统语音'
        } catch (e) {
            console.error('[MobileShell] Error rendering Me tab:', e)
        }
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
            const lbl = document.getElementById('np-timer-label')
            if (lbl) lbl.innerText = nextTimer > 0 ? `定时: ${nextTimer}分` : '定时: 关'
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
        const bookTitle = curBook?.title || 'Linden Leaf 朗读'
        if (titleEl) titleEl.innerText = bookTitle
        if (coverWrap) {
            coverWrap.innerHTML = renderBookCoverHTML(curBook, 'mini-cover-img', true)
        }

        const curSeg = ttsPlayer.segments[ttsPlayer.currentIndex]
        if (snippetEl && curSeg?.text) {
            snippetEl.innerText = curSeg.text
        }
    }

    updateNowPlayingState(state) {
        const playIcon = document.getElementById('np-icon-play')
        const pauseIcon = document.getElementById('np-icon-pause')
        if (playIcon && pauseIcon) {
            playIcon.style.display = state === 'playing' ? 'none' : 'block'
            pauseIcon.style.display = state === 'playing' ? 'block' : 'none'
        }

        const curSeg = ttsPlayer.segments[ttsPlayer.currentIndex]
        const pTextEl = document.getElementById('np-paragraph-text')
        if (pTextEl && curSeg?.text) {
            pTextEl.innerText = curSeg.text
        }

        const curEl = document.getElementById('np-progress-cur')
        const totalEl = document.getElementById('np-progress-total')
        const slider = document.getElementById('np-progress-slider')
        if (ttsPlayer.segments.length > 0) {
            if (curEl) curEl.innerText = `第 ${ttsPlayer.currentIndex + 1} 段`
            if (totalEl) totalEl.innerText = `共 ${ttsPlayer.segments.length} 段`
            if (slider) {
                slider.disabled = false
                slider.max = ttsPlayer.segments.length - 1
                slider.value = ttsPlayer.currentIndex
            }
        } else {
            if (curEl) curEl.innerText = '等待朗读'
            if (totalEl) totalEl.innerText = '未加载分段'
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
        const bookTitle = curBook?.title || 'Linden Leaf'
        if (titleEl) titleEl.innerText = bookTitle
        if (chapterEl && curBook?.currentChapterTitle) {
            chapterEl.innerText = curBook.currentChapterTitle
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
        if (displayTitle) displayTitle.textContent = isPdf ? 'PDF 显示' : '阅读外观与主题'
        const setHidden = (id, hidden) => {
            const element = document.getElementById(id)
            if (element) element.hidden = hidden
        }
        setHidden('mobile-pdf-progress', !isPdf)
        setHidden('mobile-pdf-display-controls', !isPdf)
        setHidden('mobile-reflow-controls', isPdf)
        setHidden('btn-mobile-pdf-more', !isPdf)
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
            slider.setAttribute('aria-valuetext', `第 ${slider.value} 页，共 ${total} 页`)
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

    setReaderToolsVisible(visible, bookTitle = '') {
        this.readerToolsVisible = visible !== undefined ? visible : !this.readerToolsVisible
        const topBar = document.getElementById('mobile-reader-top-bar')
        const bottomBar = document.getElementById('mobile-reader-bottom-bar')
        if (topBar) topBar.classList.toggle('visible', this.readerToolsVisible)
        if (bottomBar) bottomBar.classList.toggle('visible', this.readerToolsVisible)
        if (this.readerToolsVisible) {
            const isCbz = window.app?.currentBookData?.format === 'cbz' || window.app?.isCbz
            const ttsBtn = document.getElementById('btn-tool-tts')
            if (ttsBtn) ttsBtn.style.display = isCbz ? 'none' : 'flex'
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
        if (chapterEl && chName) chapterEl.innerText = chName
        this.syncPdfControls()
    }

    updateUserProfileDisplay(displayName) {
        const nameEl = document.getElementById('mobile-user-name')
        const avatarEl = document.getElementById('mobile-user-avatar')
        const homeAvatarEl = document.getElementById('home-overview-avatar')
        const greetingEl = document.getElementById('mobile-home-greeting')
        const name = displayName || window.app?.settings?.userName || '书友'
        if (nameEl) nameEl.innerText = name
        if (avatarEl) avatarEl.innerText = name ? name.charAt(0).toUpperCase() : 'R'
        if (homeAvatarEl) homeAvatarEl.innerText = name ? name.charAt(0).toUpperCase() : 'R'
        if (greetingEl) {
            const now = new Date()
            const hour = now.getHours()
            let timeGreet = '早上好'
            if (hour >= 12 && hour < 14) timeGreet = '中午好'
            else if (hour >= 14 && hour < 19) timeGreet = '下午好'
            else if (hour >= 19 || hour < 5) timeGreet = '晚上好'
            greetingEl.innerText = `${timeGreet}，${name}`
        }
    }

    setupReaderToolListeners() {
        const appViewport = () => this.isInReader ? window.app?.pdfViewport : null
        document.getElementById('btn-mobile-pdf-more')?.addEventListener('click', () => this.openSheet('more'))
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
        
        // TTS Tool trigger (Issue 9 Fix)
        document.getElementById('btn-tool-tts')?.addEventListener('click', () => {
            if (ttsPlayer.state === 'idle' || ttsPlayer.state === 'stopped') {
                if (ttsPlayer.segments.length === 0) {
                    ttsPlayer.extractSegments()
                }
                ttsPlayer.play(0).catch(() => {})
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
            const cur = parseInt(window.app?.settings?.fontSize || 18, 10)
            const next = Math.min(36, cur + 1)
            window.app?.setSetting?.('fontSize', next)
            window.app?.saveSettingsDebounced?.()
            const v = document.getElementById('val-font-size')
            if (v) v.innerText = `${next}px`
        })
        document.getElementById('btn-font-dec')?.addEventListener('click', () => {
            const cur = parseInt(window.app?.settings?.fontSize || 18, 10)
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
            const cur = parseFloat(window.app?.settings?.lineHeight || 1.6)
            const next = Math.min(2.5, +(cur + 0.1).toFixed(1))
            window.app?.setSetting?.('lineHeight', next)
            window.app?.saveSettingsDebounced?.()
            const v = document.getElementById('val-line-height')
            if (v) v.innerText = next.toFixed(1)
        })

        // Quick Font Selection (Feedback 3 & 150)
        document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(btn => {
            btn.addEventListener('click', () => {
                const fontKey = btn.dataset.mobileFont
                window.app?.setSetting?.('font', fontKey)
                window.app?.saveSettingsDebounced?.()
                window.app?.updateSettingsUI?.()
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileFont === fontKey)
                })
            })
        })

        // Quick Page Turn Animation Selection (Feedback 3, 5 & 152)
        document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(btn => {
            btn.addEventListener('click', () => {
                let turnKey = btn.dataset.mobileTurn
                if (turnKey === 'curl') turnKey = 'slide'
                window.app?.setSetting?.('pageTurnMode', turnKey)
                window.app?.pageTurnController?.setMode?.(turnKey)
                window.app?.saveSettingsDebounced?.()
                if (window.app?.dom?.turnAnimationSelect) {
                    window.app.dom.turnAnimationSelect.value = turnKey
                }
                document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileTurn === turnKey)
                })
            })
        })

        // Link to full appearance / reading settings
        document.getElementById('btn-mobile-more-reading-settings')?.addEventListener('click', () => {
            this.closeAllSheets()
            this.settingsPage.open('appearance')
        })
        document.getElementById('btn-lh-dec')?.addEventListener('click', () => {
            const cur = parseFloat(window.app?.settings?.lineHeight || 1.6)
            const next = Math.max(1.0, +(cur - 0.1).toFixed(1))
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
                    container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--mobile-text-muted);">本书未检测到目录结构</div>'
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
                const fVal = document.getElementById('val-font-size')
                const lhVal = document.getElementById('val-line-height')
                if (fVal) fVal.innerText = `${window.app?.settings?.fontSize || 18}px`
                if (lhVal) lhVal.innerText = `${window.app?.settings?.lineHeight || 1.6}`

                const curFont = window.app?.settings?.font || 'serif'
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileFont === curFont)
                })

                let curTurn = window.app?.settings?.pageTurnMode || 'slide'
                if (curTurn === 'curl') curTurn = 'slide'
                document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileTurn === curTurn)
                })
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
            document.getElementById('mobile-pdf-page-range').textContent = `第 1–${viewport.numPages} 页`
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
            const card = e.target.closest('.jane-book-card')
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
                try { await action() } catch (e) { app?.showToast?.(e.message || '操作未完成', 'warning') }
            }
        }
        document.getElementById('action-sheet-book-title').innerText = book.title || '图书操作'
        document.getElementById('action-sheet-book-subtitle').innerText = `${(book.format || 'EPUB').toUpperCase()} · ${book.author || '未知作者'}`
        const labels = { unread: '未读', want_to_read: '想读', reading: '在读', on_hold: '搁置', finished: '读完' }
        document.getElementById('act-sheet-current-status-tag').innerText = labels[resolveReadingState(book)] || '未读'
        document.getElementById('act-sheet-category').hidden = true
        bind('act-sheet-read', () => app.openBook(bookId))
        bind('act-sheet-details', () => app.openBookDetailsModal(bookId))
        bind('act-sheet-edit', async () => {
            const title = await app.showInputDialog({ title: '编辑书名', value: book.title || '' })
            if (title === null || !title.trim()) return
            const author = await app.showInputDialog({ title: '编辑作者', value: book.author || '' })
            if (author === null) return
            await db.updateBookMetadata(bookId, { title: title.trim(), author: author.trim() })
            await app.refreshBookshelf()
            this.renderHomeTab()
        })
        bind('act-sheet-tags', async () => {
            const value = await app.showInputDialog({ title: '编辑标签', message: '使用逗号分隔多个标签', value: (book.tags || []).join('，') })
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
            sheet.innerHTML = `<div class="mobile-sheet-handle"></div><div class="mobile-sheet-header-compact"><h3 class="mobile-sheet-title">阅读状态</h3></div><div class="mobile-sheet-content"><div class="mobile-group-box">${Object.entries(labels).map(([status, label]) => `<button class="mobile-cell-item" type="button" data-status="${status}" aria-pressed="${resolveReadingState(book) === status}"><span>${label}</span>${resolveReadingState(book) === status ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>' : ''}</button>`).join('')}</div></div>`
            sheet.querySelectorAll('[data-status]').forEach(button => {
                button.onclick = async () => {
                    button.disabled = true
                    try {
                        await setReadingStatus(bookId, button.dataset.status)
                        this.closeAllSheets()
                        await app.refreshBookshelf()
                        this.renderHomeTab()
                    } catch (e) { app?.showToast?.(e.message || '更新失败', 'warning'); button.disabled = false }
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
        sheet.classList.add('mobile-book-popover')
        const rect = anchor?.getBoundingClientRect()
        const width = Math.min(268, window.innerWidth - 32)
        const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0
        const safeBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')) || 0
        const height = Math.min(sheet.scrollHeight, window.innerHeight - safeTop - safeBottom - 32)
        sheet.style.width = width + 'px'
        sheet.style.left = Math.max(16, Math.min((rect?.right ?? window.innerWidth - 16) - width, window.innerWidth - width - 16)) + 'px'
        sheet.style.top = Math.max(safeTop + 16, Math.min(rect?.bottom ?? window.innerHeight / 3, window.innerHeight - safeBottom - height - 16)) + 'px'
        document.getElementById('mobile-sheet-backdrop').classList.add('has-book-popover')
    }

    async openShareActionSheet(bookId) {
        this.selectedBookForShare = bookId
        const book = await db.getBook(bookId)
        if (!book || this.selectedBookForShare !== bookId) return
        document.getElementById('share-sheet-book-title').innerText = book.title || '分享图书'
        document.getElementById('share-sheet-book-subtitle').innerText = '导出原始文件'
        for (const id of ['share-act-poster', 'share-act-screenshot']) document.getElementById(id).hidden = true
        const exportFile = async (share) => {
            const app = window.app
            try {
                let nativePath = await db.getBookNativePath(bookId)
                const filename = book.filename || `${book.title || 'book'}.${book.format || 'epub'}`
                if (!nativePath) {
                    const snapshot = await db.getBookFileSnapshot(bookId)
                    if (!snapshot?.blob) throw new Error('请先将这本书下载到本机，再导出文件')
                    nativePath = snapshot.nativePath || await platformBridge.createBookSnapshot(filename, await snapshot.blob.arrayBuffer())
                }
                if (!nativePath) throw new Error('当前环境暂不支持导出原始文件')
                this.closeAllSheets()
                const result = await platformBridge.exportBookFile(nativePath, filename, share)
                if (result?.cancelled) return
                if (!result?.success) throw new Error(result?.error || '导出未完成')
                app?.showToast?.(share ? '已打开系统分享面板' : '文件已保存', 'success')
            } catch (e) { app?.showToast?.(e.message || '导出失败', 'warning') }
        }
        document.getElementById('share-act-file').onclick = () => exportFile(true)
        document.getElementById('share-act-save').onclick = () => exportFile(false)
        this.openSheet('share')
    }

    openGoalEditSheet() {
        const current = Math.max(1, parseInt(localStorage.getItem('linden_daily_goal_minutes') || '30', 10) || 30)
        const group = document.getElementById('goal-time-options')
        group?.querySelectorAll('.goal-pill-btn').forEach(button => {
            button.classList.toggle('active', Number(button.dataset.time) === current)
            button.onclick = () => {
                group.querySelectorAll('.goal-pill-btn').forEach(b => b.classList.remove('active'))
                button.classList.add('active')
            }
        })
        const save = document.getElementById('btn-save-reading-goal')
        if (save) save.onclick = () => {
            const next = Number(group?.querySelector('.goal-pill-btn.active')?.dataset.time) || current
            localStorage.setItem('linden_daily_goal_minutes', String(next))
            this.closeAllSheets()
            this.renderHomeTab()
        }
        this.openSheet('goal-edit')
    }

    handleBackPress() {
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

    setupBackPressHandler() {
        // No-op: window.__handleAndroidBackPress is managed in app.js and delegates to this.handleBackPress()
    }
}

// Instantiate singleton
export const mobileShell = new MobileShellController()
if (typeof window !== 'undefined') {
    window.mobileShell = mobileShell
}
