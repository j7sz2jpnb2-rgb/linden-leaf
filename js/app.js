// app.js - Universal E-Book Reader Core Application (Jane Reader UI & Open Source Fonts)

export const APP_BUILD_VER = '20260826_63'

import '../foliate-js-main/view.js?v=20260826_63'
import { Overlayer } from '../foliate-js-main/overlayer.js?v=20260826_63'
import * as db from './db.js?v=20260826_63'
import { tracker } from './tracker.js?v=20260826_63'
import { quoteCard, THEMES } from './quote-card.js?v=20260826_63'
import * as syncEngine from './syncEngine.js?v=20260826_63'
import { updater } from './updater.js?v=20260826_63'

// Format language map helper
const escapeHTML = str => {
    if (!str) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]] || ''
}

const formatContributor = contributor => {
    if (!contributor) return '未知作者'
    if (typeof contributor === 'string') return contributor
    if (Array.isArray(contributor)) {
        return contributor.map(c => typeof c === 'string' ? c : formatLanguageMap(c?.name)).join(', ')
    }
    return formatLanguageMap(contributor?.name) || '未知作者'
}

// Format file size
const formatFileSize = bytes => {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'kB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// Format relative/absolute timestamp
const formatDateTime = ts => {
    if (!ts || ts === 0) return '-'
    const now = Date.now()
    const diff = (now - ts) / 1000 // seconds
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
    if (diff < 86400 * 3) return `${Math.floor(diff / 86400)} 天前`

    const d = new Date(ts)
    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const date = d.getDate()
    const hours = d.getHours()
    const minutes = String(d.getMinutes()).padStart(2, '0')
    const seconds = String(d.getSeconds()).padStart(2, '0')
    const period = hours < 12 ? '上午' : '下午'
    const h12 = hours % 12 || 12
    return `${year}年${month}月${date}日 ${period} ${h12}:${minutes}:${seconds}`
}

// Object URL Lifecycle Pool to prevent Blob memory leaks
class ObjectUrlPool {
    constructor() {
        this.cache = new Map()
    }
    get(key, blob) {
        if (!blob) return ''
        if (this.cache.has(key)) return this.cache.get(key)
        const url = URL.createObjectURL(blob)
        this.cache.set(key, url)
        return url
    }
    revoke(key) {
        if (this.cache.has(key)) {
            URL.revokeObjectURL(this.cache.get(key))
            this.cache.delete(key)
        }
    }
    clear() {
        for (const url of this.cache.values()) {
            URL.revokeObjectURL(url)
        }
        this.cache.clear()
    }
}
const coverUrlPool = new ObjectUrlPool()

const formatFontWeight = w => {
    const num = parseInt(w, 10) || 400
    if (num <= 300) return '细体 (300)'
    if (num === 400) return '标准 (400)'
    if (num === 500) return '适中 (500)'
    if (num === 600) return '半粗 (600)'
    if (num === 700) return '粗体 (700)'
    return '浓黑 (800)'
}

// Generate CSS for Reader Content inside iframe
const buildContentCSS = (settings) => {
    const { theme, font, fontSize, fontWeight = 400, letterSpacing = 0, lineHeight, justify, hyphenate, writingMode = 'horizontal' } = settings || {}
    const parsedWeight = parseInt(fontWeight, 10)
    const safeWeight = isNaN(parsedWeight) ? 400 : Math.min(900, Math.max(100, parsedWeight))
    const headingWeight = Math.min(900, Math.max(600, safeWeight + 200))
    
    // Jane Reader Classical Vertical Writing Mode Rules
    const isVertical = writingMode === 'vertical-rl'
    const verticalStyles = isVertical ? `
        html, body {
            writing-mode: vertical-rl !important;
            text-orientation: mixed !important;
            line-break: strict !important;
            word-break: break-all !important;
            -webkit-font-smoothing: antialiased;
        }
        p {
            text-indent: 2em !important;
            margin-block-start: 0 !important;
            margin-block-end: 0.8em !important;
        }
        h1, h2, h3, h4, h5, h6 {
            text-indent: 0 !important;
            margin-inline-start: 0.8em !important;
            margin-inline-end: 0.8em !important;
            font-weight: 700;
        }
        img, svg, video {
            max-inline-size: 100% !important;
            max-block-size: 90vh !important;
        }
    ` : `
        html, body {
            writing-mode: horizontal-tb !important;
        }
        /* Normalize aggressive publisher break rules and huge margins to prevent blank / single-word pages */
        h1, h2, h3, h4, h5, h6, .chapter-title, .titlepage, section.chapter {
            page-break-before: auto !important;
            break-before: auto !important;
            -webkit-column-break-before: auto !important;
            max-height: none !important;
        }
        h1.chapter-title {
            margin-top: 1.5em !important;
            margin-bottom: 0.5em !important;
        }
        p.chapter-subtitle {
            margin-top: 0 !important;
            margin-bottom: 1.5em !important;
        }
    `

    // Declarative Theme & Font Configuration Presets
    const THEME_PALETTES = {
        light: { text: '#212529', link: '#2563eb', bg: 'transparent', selection: 'rgba(59, 130, 246, 0.28)' },
        sepia: { text: '#3b2e1e', link: '#b45309', bg: 'transparent', selection: 'rgba(217, 119, 6, 0.26)' },
        dark:  { text: '#e2e8f0', link: '#38bdf8', bg: 'transparent', selection: 'rgba(96, 165, 250, 0.36)' },
        black: { text: '#cccccc', link: '#a1a1aa', bg: 'transparent', selection: 'rgba(96, 165, 250, 0.36)' },
        green: { text: '#1b4d1d', link: '#2e7d32', bg: 'transparent', selection: 'rgba(16, 185, 129, 0.25)' },
        eink:  { text: '#000000', link: '#000000', bg: 'transparent', selection: 'rgba(0, 0, 0, 0.18)' },
        warm:  { text: '#292524', link: '#d97706', bg: 'transparent', selection: 'rgba(245, 158, 11, 0.28)' }
    }

    const FONT_PRESETS = {
        serif: '"Noto Serif SC", "Source Han Serif SC", "思源宋体", "Songti SC", "STSong", "SimSun", "宋体", serif',
        sans:  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Source Han Sans SC", "思源黑体", "PingFang SC", "Microsoft YaHei", "微软雅黑", sans-serif',
        kaiti: '"LXGW WenKai Screen", "LXGW WenKai", "霞鹜文楷", "STKaiti", "Kaiti SC", "KaiTi", "楷体", serif',
        mono:  '"Fira Code", "Cascadia Code", Consolas, Menlo, Monaco, "Courier New", monospace'
    }

    const activeTheme = THEME_PALETTES[theme] || THEME_PALETTES.light
    const textColor = activeTheme.text
    const linkColor = activeTheme.link
    const bgColor = activeTheme.bg
    const selectionBg = activeTheme.selection
    const fontFamily = FONT_PRESETS[font] || FONT_PRESETS.serif

    return `
        @import url('https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.1.0/style.css');
        @import url('https://fonts.font.im/css2?family=Noto+Serif+SC:wght@300;400;500;600;700;900&family=Noto+Sans+SC:wght@300;400;500;700;900&display=swap');
        @namespace epub "http://www.idpf.org/2007/ops";
        html {
            color-scheme: light dark;
        }
        *, *::before, *::after, body, p, div, span, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, em, strong, i, b, a, section, article {
            font-family: ${fontFamily} !important;
            letter-spacing: ${letterSpacing}px !important;
        }
        body, p, div, span, li, blockquote, dd, dt, a, section, article {
            font-weight: ${safeWeight} !important;
        }
        h1, h2, h3, h4, h5, h6, strong, b {
            font-weight: ${headingWeight} !important;
        }
        body {
            color: ${textColor} !important;
            background-color: ${bgColor} !important;
            font-size: ${fontSize}px !important;
            box-sizing: border-box;
            margin: 0 !important;
            padding: 0 !important;
        }
        p, li, blockquote, dd, div {
            line-height: ${lineHeight} !important;
            text-align: ${justify ? 'justify' : 'start'};
            -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
            hyphens: ${hyphenate ? 'auto' : 'manual'};
        }
        p {
            text-indent: 2em;
            margin-top: 0 !important;
            margin-bottom: 0.65em !important;
            orphans: 2 !important;
            widows: 2 !important;
        }
        li, dd {
            margin-top: 0.4em;
            margin-bottom: 0.4em;
        }

        /* Elements that must NEVER have 2em text-indent (Center, Right, Headings, Poetry, Captions) */
        p.no-indent, .no-indent,
        [data-align="center"], [data-align="right"],
        [data-reader-heading], [data-poetry-line], [data-has-media],
        h1, h2, h3, h4, h5, h6,
        blockquote, pre, figure, figcaption,
        .poetry, .verse, .subtitle, .author, .date, [class*="sequence"],
        .titlepage *,
        [align="center"], [align="right"],
        [style*="text-align:center" i], [style*="text-align: center" i],
        [style*="text-align:right" i], [style*="text-align: right" i] {
            text-indent: 0 !important;
        }

        /* Remove any pseudo-element hacks */
        p::before, .no-indent::before, h1::before, h2::before, h3::before, h4::before, h5::before, h6::before {
            content: none !important;
            display: none !important;
        }

        /* 1. Chapter First Visible Heading (Compact top margin) */
        [data-first-heading="true"] {
            margin-top: 0.5em !important;
            margin-bottom: 1.2em !important;
            text-indent: 0 !important;
            page-break-after: avoid !important;
            break-after: avoid !important;
        }

        /* 2. Chapter Headings in single-file books (Force Break to New Page / Column with Bold Center) */
        [data-chapter-heading="true"]:not([data-first-heading="true"]) {
            break-before: column !important;
            page-break-before: always !important;
            margin-top: 3.5em !important;
            margin-bottom: 1.8em !important;
            text-indent: 0 !important;
            font-weight: bold !important;
            font-size: 1.25em !important;
            text-align: center !important;
            break-after: avoid !important;
            page-break-after: avoid !important;
            display: block !important;
            clear: both !important;
        }

        /* 3. In-document Subsections & Poem Titles (Generous 3.2em respiratory margin & avoid orphan headings) */
        [data-section-heading="true"]:not([data-chapter-heading="true"]) {
            margin-top: 3.2em !important;
            margin-bottom: 1.2em !important;
            text-indent: 0 !important;
            page-break-after: avoid !important;
            break-after: avoid !important;
            clear: both !important;
            display: block !important;
        }

        /* Subtitle / Author directly following a heading (Bond tightly with previous heading) */
        h1 + p, h2 + p, h3 + p,
        [data-reader-heading] + p[data-align="center"],
        [data-reader-heading] + .contenttitle1,
        [data-reader-heading] + [class*="author" i],
        [data-reader-heading] + [class*="subtitle" i] {
            margin-top: -0.3em !important;
            text-indent: 0 !important;
            page-break-after: avoid !important;
            break-after: avoid !important;
        }

        /* 3. Anti-Phantom Blank Page: eliminate trailing element bottom margins at section end */
        body > :last-child,
        body > div:last-child > :last-child,
        body > section:last-child > :last-child {
            margin-bottom: 0 !important;
            padding-bottom: 0 !important;
        }

        /* 4. Target Calibre / Pandoc dummy page-break markers directly in CSS as well */
        [id*="calibre_pb" i],
        [class*="calibre_pb" i],
        .calibre_pb,
        h1:empty, h2:empty, h3:empty, h4:empty, h5:empty, h6:empty,
        [data-reader-heading]:empty {
            display: none !important;
            height: 0 !important;
            min-height: 0 !important;
            max-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            font-size: 0 !important;
            line-height: 0 !important;
            border: none !important;
        }

        /* Full page SVG illustrations and standalone chapter dividers */
        svg {
            max-width: 100% !important;
            max-height: 100% !important;
            box-sizing: border-box !important;
        }

        blockquote {
            margin: 1.2em 0 0.8em 0;
            padding: 0;
        }
        /* Explicit alignment attributes override justify/start */
        [align="left"] { text-align: left !important; }
        [align="center"] { text-align: center !important; }
        [align="right"] { text-align: right !important; }
        [align="justify"] { text-align: justify !important; }

        /* Legacy MOBI / HTML font size relative mapping (Scale harmoniously with reader font size) */
        font[size="1"] { font-size: 0.72em !important; }
        font[size="2"] { font-size: 0.85em !important; }
        font[size="3"] { font-size: 1.0em !important; }
        font[size="4"] { font-size: 1.35em !important; font-weight: 700 !important; line-height: 1.4 !important; }
        font[size="5"] { font-size: 1.65em !important; font-weight: 700 !important; line-height: 1.35 !important; }
        font[size="6"] { font-size: 2.0em !important; font-weight: 700 !important; line-height: 1.3 !important; }
        font[size="7"] { font-size: 2.5em !important; font-weight: 700 !important; line-height: 1.25 !important; }

        ${(theme === 'dark' || theme === 'black') ? `
        font[color] {
            filter: brightness(1.7) contrast(1.1) !important;
        }
        font[color="#000000"], font[color="black"], font[color="#000"], font[color="#111111"], font[color="#222222"], font[color="#333333"] {
            color: ${textColor} !important;
            filter: none !important;
        }
        ` : ''}

        h1, h2, h3, h4, h5, h6 {
            color: ${textColor} !important;
            line-height: 1.3 !important;
        }
        a:link, a:visited {
            color: ${linkColor} !important;
            text-decoration: underline;
        }
        img {
            max-width: 100% !important;
            height: auto !important;
        }
        ::selection, *::selection {
            background: ${selectionBg} !important;
            color: inherit !important;
        }

        /* Hide EPUB 3 / HTML5 Footnotes & Endnotes Content Blocks from regular text flow */
        aside[epub\\:type~="footnote"],
        aside[epub\\:type~="endnote"],
        aside[epub\\:type~="rearnote"],
        aside[role~="doc-footnote"],
        aside[role~="doc-endnote"],
        aside[role~="doc-rearnote"],
        aside.footnote,
        aside.endnote,
        aside.rearnote,
        div.footnote:not(:has(a[href])),
        div.endnote:not(:has(a[href])),
        li.footnote,
        li.endnote,
        section.footnotes {
            display: none !important;
        }

        /* Footnote references styling (WeChat Read style - unselectable so drag selection ignores footnote markers) */
        a[epub\\:type~="noteref"],
        a[role~="doc-noteref"],
        a.epub-footnote,
        a.footnote-ref,
        a.noteref,
        sup a,
        sup.footnote {
            cursor: pointer !important;
            text-decoration: none !important;
            color: #8b5cf6 !important;
            font-weight: 600;
            padding: 0 2px;
            display: inline-block;
            user-select: none !important;
            -webkit-user-select: none !important;
        }
        sup img.epub-footnote,
        a.epub-footnote img {
            vertical-align: super;
            display: inline-block;
            cursor: pointer !important;
            opacity: 0.85;
            transition: transform 0.15s ease, opacity 0.15s ease;
        }
        sup a:hover img.epub-footnote,
        a.epub-footnote:hover img,
        sup a:hover {
            opacity: 1;
            transform: scale(1.2);
        }
    `
}

class UniversalReaderApp {
    constructor() {
        this.currentBookId = null
        this.currentBookData = null
        this.foliateView = null
        this.activeDrawer = null
        this.activeTab = 'toc'
        this.currentSearchResults = []
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
        this.selectedTextInfo = null
        this.clickedHighlightInfo = null
        this.currentLocation = null

        // Shelf UI state
        this.shelfViewMode = 'shelf' // 'shelf' (Skeuomorphic), 'grid' (Modern Grid), 'list' (Table)
        this.shelfCategory = 'all' // 'all', 'unread', 'finished'
        this.sortField = 'addedAt' // 'title', 'author', 'language', 'size', 'lastReadAt', 'addedAt'
        this.sortOrder = 'desc' // 'asc', 'desc'
        this.searchQuery = ''
        this.currentBooksList = []

        // Reader typography preferences
        this.settings = {
            theme: 'light',
            font: 'serif', // Default to Adobe Source Han Serif
            fontSize: 18,
            fontWeight: 400,
            lineHeight: 1.6,
            margin: 48,
            maxWidth: 760,
            gap: 6,
            columnCount: '2',
            justify: true,
            hyphenate: true,
            realisticPen: true,
            fullscreenAutohide: false,
            shelfViewMode: 'shelf'
        }

        // WeChat Read Stats State
        this.statsViewMode = 'month' // 'week', 'month', 'year', 'total'
        this.statsYear = new Date().getFullYear()
        this.statsMonth = new Date().getMonth() + 1
        this.statsWeekOffset = 0

        // Custom Reading Lists State
        this.customLists = []
        this.selectedListIcon = '📌'
        this.managingBookId = null
        this.icons = ['📌', '🌟', '📜', '📚', '📑', '🎯', '💡', '☕', '🌿', '🚀', '🏛️', '🎨', '📖', '🔮', '💼', '🔖']

        // PDF Freehand Drawing & OCR State
        this.pdfDrawTool = null // 'marker' | 'pen' | 'eraser' | null
        this.pdfDrawColor = 'rgba(250, 204, 21, 0.45)'
        this.pdfDrawWidth = 18
        this.currentPdfPageIndex = 1
        this.pdfOverlayCanvas = null

        this.initDOM()
        this.bindEvents()

        this.checkFirstTimeUser()
        this.loadSettings().then(async () => {
            this.applyTheme(this.settings.theme)
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
            await this.initSyncService()
        })
    }

    initDOM() {
        this.dom = {
            // Main views
            bookshelfView: document.getElementById('bookshelf-view'),
            readerView: document.getElementById('reader-view'),
            readerContentArea: document.getElementById('reader-content-area'),
            fileInput: document.getElementById('file-input'),
            dropZoneOverlay: document.getElementById('drop-zone-overlay'),

            // Bookshelf elements
            shelfSearch: document.getElementById('shelf-search'),
            btnImport: document.getElementById('btn-import'),
            btnHeaderFavorite: document.getElementById('btn-header-favorite'),
            btnSortToggle: document.getElementById('btn-sort-toggle'),
            sortDropdownMenu: document.getElementById('sort-dropdown-menu'),
            sortMenuItems: document.querySelectorAll('#sort-dropdown-menu .sort-menu-item'),
            btnViewShelf: document.getElementById('btn-view-shelf'),
            btnViewGrid: document.getElementById('btn-view-grid'),
            btnViewList: document.getElementById('btn-view-list'),
            booksShelf: document.getElementById('books-shelf'),
            bookContainer: document.getElementById('reader-content-area'),

            // Skeuomorphic Bookshelf
            booksGrid: document.getElementById('books-grid'),
            booksTableContainer: document.getElementById('books-table-container'),
            booksTableBody: document.getElementById('books-table-body'),
            booksWorkspace: document.querySelector('.jane-content-workspace'),
            mainArea: document.querySelector('.jane-main-area'),
            shelfHeaderActions: document.getElementById('shelf-header-actions'),
            bookCountFooter: document.getElementById('book-count-footer'),
            navCategoryItems: document.querySelectorAll('.jane-sidebar .nav-item'),
            currentCategoryTitle: document.getElementById('current-category-title'),

            // WeChat Read Stats Dashboard
            statsDashboardContainer: document.getElementById('stats-dashboard-container'),
            statsSegmentedTabs: document.querySelectorAll('.stats-tab-btn'),
            statsDateNavigator: document.getElementById('stats-date-navigator'),
            statsDateLabel: document.getElementById('stats-date-label'),
            btnStatsPrevDate: document.getElementById('btn-stats-prev-date'),
            btnStatsNextDate: document.getElementById('btn-stats-next-date'),
            statsHeroTime: document.getElementById('stats-hero-time'),
            statsHeroSub: document.getElementById('stats-hero-sub'),
            quadReadBooks: document.getElementById('quad-read-books'),
            quadFinishedBooks: document.getElementById('quad-finished-books'),
            quadReadDays: document.getElementById('quad-read-days'),
            quadNoteCount: document.getElementById('quad-note-count'),
            statsDistributionChart: document.getElementById('stats-distribution-chart'),
            statsPeakPill: document.getElementById('stats-peak-pill'),
            statsPeakText: document.getElementById('stats-peak-text'),
            statsYMax: document.getElementById('stats-y-max'),
            statsYMid: document.getElementById('stats-y-mid'),
            statsLeaderboardList: document.getElementById('stats-leaderboard-list'),
            statsRecentSessions: document.getElementById('stats-recent-sessions'),
            btnRefreshStats: document.getElementById('btn-refresh-stats'),

            // Reader Header & Footer
            readerTopBar: document.getElementById('reader-top-bar'),
            readerBottomBar: document.getElementById('reader-bottom-bar'),
            readerBookTitle: document.getElementById('reader-book-title'),
            readerPageNumber: document.getElementById('reader-page-number'),
            readerLiveTimer: document.getElementById('reader-live-timer'),
            readerEtaBadge: document.getElementById('reader-eta-badge'),
            btnBackToShelf: document.getElementById('btn-back-to-shelf'),
            btnShelfSettings: document.getElementById('btn-shelf-settings'),
            btnNavLeft: document.getElementById('btn-nav-left'),
            btnNavRight: document.getElementById('btn-nav-right'),
            btnPrevPage: document.getElementById('btn-nav-left'),
            btnNextPage: document.getElementById('btn-nav-right'),
            btnToggleTOC: document.getElementById('btn-toggle-toc'),
            btnToggleSearch: document.getElementById('btn-toggle-search'),
            btnToggleNotes: document.getElementById('btn-toggle-notes'),
            btnToggleSettings: document.getElementById('btn-toggle-settings'),
            btnToggleFullscreen: document.getElementById('btn-toggle-fullscreen'),
            progressSlider: document.getElementById('reader-progress-slider'),
            progressText: document.getElementById('reader-progress-text'),

            // Sidebar Drawer
            sidebarDrawer: document.getElementById('sidebar-drawer'),
            drawerBackdrop: document.getElementById('drawer-backdrop'),
            drawerCloseBtn: document.getElementById('drawer-close-btn'),
            tabButtons: document.querySelectorAll('.tab-btn'),
            tabPanels: {
                toc: document.getElementById('panel-toc'),
                notes: document.getElementById('panel-notes'),
                search: document.getElementById('panel-search'),
                settings: document.getElementById('panel-settings')
            },
            tocContainer: document.getElementById('toc-tree-container'),
            notesContainer: document.getElementById('notes-list-container'),
            btnExportNotes: document.getElementById('btn-export-notes'),
            searchQueryInput: document.getElementById('search-query-input'),
            btnClearSearchInput: document.getElementById('btn-clear-search-input'),
            btnExecSearch: document.getElementById('btn-exec-search'),
            btnClearSearchHighlights: document.getElementById('btn-clear-search-highlights'),
            searchResultsContainer: document.getElementById('search-results-container'),

            // Floating Reader Search Bar
            readerSearchBar: document.getElementById('reader-search-bar'),
            searchBarTitle: document.getElementById('search-bar-title'),
            btnSearchBarPrev: document.getElementById('btn-search-bar-prev'),
            btnSearchBarNext: document.getElementById('btn-search-bar-next'),
            btnSearchBarClose: document.getElementById('btn-search-bar-close'),

            // Appearance settings inputs
            themeButtons: document.querySelectorAll('.theme-btn'),
            fontButtons: document.querySelectorAll('.font-choice-btn'),
            fontSizeSlider: document.getElementById('setting-font-size'),
            fontSizeValue: document.getElementById('value-font-size'),
            fontWeightSlider: document.getElementById('setting-font-weight'),
            fontWeightValue: document.getElementById('value-font-weight'),
            lineHeightSlider: document.getElementById('setting-line-height'),
            lineHeightValue: document.getElementById('value-line-height'),
            marginSlider: document.getElementById('setting-margin'),
            marginValue: document.getElementById('value-margin'),
            maxWidthSlider: document.getElementById('setting-max-width'),
            maxWidthValue: document.getElementById('value-max-width'),
            gapSlider: document.getElementById('setting-gap'),
            gapValue: document.getElementById('value-gap'),
            columnCountSelect: document.getElementById('setting-column-count'),
            layoutSelect: document.getElementById('setting-layout-mode'),
            settingRealisticPen: document.getElementById('setting-realistic-pen'),
            settingFullscreenAutohide: document.getElementById('setting-fullscreen-autohide'),

            letterSpacingSlider: document.getElementById('setting-letter-spacing'),
            letterSpacingValue: document.getElementById('value-letter-spacing'),
            chineseQuotesSwitch: document.getElementById('setting-chinese-quotes'),

            // Selection Popup
            selectionPopup: document.getElementById('selection-popup'),
            popupMultiBadge: document.getElementById('popup-multi-badge'),
            btnPopupUnderline: document.getElementById('popup-underline'),
            btnPopupDashed: document.getElementById('popup-dashed'),
            btnPopupCopy: document.getElementById('popup-copy'),
            btnPopupSearch: document.getElementById('popup-search'),
            btnPopupNote: document.getElementById('popup-note'),
            btnPopupShare: document.getElementById('popup-share'),
            popupColorDots: document.querySelectorAll('#selection-popup .color-dot'),

            // Highlight Action Popup
            highlightActionPopup: document.getElementById('highlight-action-popup'),
            hlActionNote: document.getElementById('hl-action-note'),
            hlActionCopy: document.getElementById('hl-action-copy'),
            hlActionShare: document.getElementById('hl-action-share'),
            hlActionDel: document.getElementById('hl-action-del'),
            hlActionColorDots: document.querySelectorAll('#highlight-action-popup .color-dot'),

            // Quote Share Card Modal
            quoteCardBackdrop: document.getElementById('quote-card-backdrop'),
            quoteCardDialog: document.getElementById('quote-card-dialog'),
            btnQuoteClose: document.getElementById('btn-quote-close'),
            quoteCanvasWrap: document.getElementById('quote-card-canvas-wrap'),
            quoteThemePicker: document.getElementById('quote-theme-picker'),
            quoteTitleLayoutControl: document.getElementById('quote-title-layout-control'),
            quoteUserNameInput: document.getElementById('quote-user-name-input'),
            quoteTextEditor: document.getElementById('quote-text-editor'),
            btnQuoteToggleDetails: document.getElementById('btn-quote-toggle-details'),
            quoteDetailsPanel: document.getElementById('quote-details-panel'),
            quoteDetailsChevron: document.getElementById('quote-details-chevron'),
            quoteBookTitleInput: document.getElementById('quote-book-title-input'),
            quoteBookAuthorInput: document.getElementById('quote-book-author-input'),
            quoteChapterTitleInput: document.getElementById('quote-chapter-title-input'),
            btnQuoteSaveToShelf: document.getElementById('btn-quote-save-to-shelf'),
            btnQuoteCopyClipboard: document.getElementById('btn-quote-copy-clipboard'),
            btnQuoteDownload: document.getElementById('btn-quote-download'),
            quoteCopyToast: document.getElementById('quote-copy-toast'),

            // Footnote Popup
            footnotePopup: document.getElementById('footnote-popup'),
            footnotePopupTitle: document.getElementById('footnote-popup-title'),
            footnotePopupContent: document.getElementById('footnote-popup-content'),
            btnCloseFootnote: document.getElementById('btn-close-footnote'),

            // PDF Zoom & Freehand Drawing & OCR Controls
            pdfZoomBar: document.getElementById('pdf-zoom-control-bar'),
            btnPdfZoomOut: document.getElementById('btn-pdf-zoom-out'),
            pdfZoomSlider: document.getElementById('pdf-zoom-slider'),
            btnPdfZoomIn: document.getElementById('btn-pdf-zoom-in'),
            pdfZoomPercentInput: document.getElementById('pdf-zoom-percent-input'),
            btnPdfFitWidth: document.getElementById('btn-pdf-fit-width'),
            btnPdfFitPage: document.getElementById('btn-pdf-fit-page'),
            btnPdfSpreadToggle: document.getElementById('btn-pdf-spread-toggle'),
            btnPdfMarkerYellow: document.getElementById('btn-pdf-marker-yellow'),
            btnPdfMarkerGreen: document.getElementById('btn-pdf-marker-green'),
            btnPdfPenRed: document.getElementById('btn-pdf-pen-red'),
            btnPdfEraser: document.getElementById('btn-pdf-eraser'),
            btnPdfClearDraw: document.getElementById('btn-pdf-clear-draw'),
            btnPdfOcrExtract: document.getElementById('btn-pdf-ocr-extract'),

            // PDF OCR Modal Elements
            modalPdfOcr: document.getElementById('modal-pdf-ocr'),
            btnClosePdfOcr: document.getElementById('btn-close-pdf-ocr'),
            btnCancelPdfOcr: document.getElementById('btn-cancel-pdf-ocr'),
            btnCopyPdfOcr: document.getElementById('btn-copy-pdf-ocr'),
            pdfOcrResultText: document.getElementById('pdf-ocr-result-text'),
            pdfOcrStatusIcon: document.getElementById('pdf-ocr-status-icon'),
            pdfOcrStatusText: document.getElementById('pdf-ocr-status-text'),
            pdfOcrCharCount: document.getElementById('pdf-ocr-char-count'),

            // Global Toast & Input Modal
            globalToast: document.getElementById('global-toast'),
            globalToastIcon: document.getElementById('global-toast-icon'),
            globalToastMsg: document.getElementById('global-toast-msg'),
            globalModalBackdrop: document.getElementById('global-modal-backdrop'),
            globalModalTitle: document.getElementById('global-modal-title'),
            globalModalInput: document.getElementById('global-modal-input'),
            globalModalClose: document.getElementById('global-modal-close'),
            globalModalCancel: document.getElementById('global-modal-cancel'),
            globalModalConfirm: document.getElementById('global-modal-confirm'),

            // Welcome Onboarding & Profile
            welcomeModalBackdrop: document.getElementById('welcome-modal-backdrop'),
            welcomeUsernameInput: document.getElementById('welcome-username-input'),
            btnWelcomeConfirm: document.getElementById('btn-welcome-confirm'),
            settingUserName: document.getElementById('setting-user-name'),

            // Custom Reading Lists Elements
            customListsContainer: document.getElementById('custom-lists-container'),
            btnCreateList: document.getElementById('btn-create-list'),
            btnListAddBooks: document.getElementById('btn-list-add-books'),
            modalCreateList: document.getElementById('modal-create-list'),
            modalCreateListTitle: document.getElementById('modal-create-list-title'),
            inputCustomListName: document.getElementById('input-custom-list-name'),
            customListIconPicker: document.getElementById('custom-list-icon-picker'),
            btnConfirmCreateList: document.getElementById('btn-confirm-create-list'),
            btnCancelCreateList: document.getElementById('btn-cancel-create-list'),
            btnCloseCreateList: document.getElementById('btn-close-create-list'),
            modalManageBookLists: document.getElementById('modal-manage-book-lists'),
            manageBookTargetTitle: document.getElementById('manage-book-target-title'),
            bookListsCheckboxContainer: document.getElementById('book-lists-checkbox-container'),
            btnSaveBookLists: document.getElementById('btn-save-book-lists'),
            btnCancelBookLists: document.getElementById('btn-cancel-book-lists'),
            btnCloseBookLists: document.getElementById('btn-close-book-lists'),
            btnQuickNewListInModal: document.getElementById('btn-quick-new-list-in-modal'),
            modalBatchAddToList: document.getElementById('modal-batch-add-to-list'),
            batchAddListModalTitle: document.getElementById('batch-add-list-modal-title'),
            batchAddBooksContainer: document.getElementById('batch-add-books-container'),
            btnConfirmBatchAddList: document.getElementById('btn-confirm-batch-add-list'),
            btnCancelBatchAddList: document.getElementById('btn-cancel-batch-add-list'),
            btnCloseBatchAddList: document.getElementById('btn-close-batch-add-list'),

            // WebDAV & Nutstore Sync Elements
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
            syncStatusDesc: document.getElementById('sync-status-desc'),

            // Update & About Elements
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

    checkFirstTimeUser() {
        const isInit = localStorage.getItem('linden_user_initialized')
        const currentName = localStorage.getItem('linden_user_name') || 'Linden 读者'
        if (this.dom.settingUserName) {
            this.dom.settingUserName.value = currentName
        }
        if (this.dom.quoteUserNameInput) {
            this.dom.quoteUserNameInput.value = currentName
        }
        if (!isInit && this.dom.welcomeModalBackdrop) {
            this.dom.welcomeModalBackdrop.style.display = 'flex'
            if (this.dom.welcomeUsernameInput) {
                this.dom.welcomeUsernameInput.value = currentName
                setTimeout(() => {
                    this.dom.welcomeUsernameInput?.focus()
                    this.dom.welcomeUsernameInput?.select()
                }, 100)
            }
        }
    }

    showToast(msg, icon = 'ℹ️', duration = 2500) {
        if (!this.dom.globalToast) return
        if (this._toastTimer) clearTimeout(this._toastTimer)
        if (typeof icon === 'number') {
            duration = icon
            icon = 'ℹ️'
        }
        if (this.dom.globalToastIcon) this.dom.globalToastIcon.innerText = icon || 'ℹ️'
        if (this.dom.globalToastMsg) this.dom.globalToastMsg.innerText = msg
        this.dom.globalToast.style.display = 'flex'
        requestAnimationFrame(() => {
            this.dom.globalToast?.classList.add('show')
        })
        this._toastTimer = setTimeout(() => {
            this.dom.globalToast?.classList.remove('show')
            setTimeout(() => {
                if (!this.dom.globalToast?.classList.contains('show')) {
                    this.dom.globalToast.style.display = 'none'
                }
            }, 250)
        }, duration)
    }

    showInputDialog({ title = '输入内容', placeholder = '', value = '', isMultiline = false }) {
        return new Promise(resolve => {
            if (!this.dom.globalModalBackdrop) {
                const res = prompt(title, value)
                return resolve(res)
            }

            // Cleanup any previously active instance
            if (this._inputDialogCleanup) {
                this._inputDialogCleanup()
                this._inputDialogCleanup = null
            }

            if (this.dom.globalModalTitle) this.dom.globalModalTitle.innerText = title
            if (this.dom.globalModalInput) {
                this.dom.globalModalInput.placeholder = placeholder
                this.dom.globalModalInput.value = value || ''
                this.dom.globalModalInput.rows = isMultiline ? 4 : 2
            }

            let isResolved = false
            const close = (result) => {
                if (isResolved) return
                isResolved = true
                this.dom.globalModalBackdrop?.classList.remove('show')
                setTimeout(() => {
                    if (this.dom.globalModalBackdrop && !this.dom.globalModalBackdrop.classList.contains('show')) {
                        this.dom.globalModalBackdrop.style.display = 'none'
                    }
                }, 200)
                cleanup()
                resolve(result)
            }

            const onConfirm = () => {
                const val = this.dom.globalModalInput?.value ?? ''
                close(val)
            }

            const onCancel = () => close(null)

            const onKeydown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                } else if (e.key === 'Enter' && (!isMultiline || e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    onConfirm()
                }
            }

            const cleanup = () => {
                this.dom.globalModalConfirm?.removeEventListener('click', onConfirm)
                this.dom.globalModalCancel?.removeEventListener('click', onCancel)
                this.dom.globalModalClose?.removeEventListener('click', onCancel)
                this.dom.globalModalInput?.removeEventListener('keydown', onKeydown)
                this._inputDialogCleanup = null
            }

            this._inputDialogCleanup = cleanup

            this.dom.globalModalConfirm?.addEventListener('click', onConfirm)
            this.dom.globalModalCancel?.addEventListener('click', onCancel)
            this.dom.globalModalClose?.addEventListener('click', onCancel)
            this.dom.globalModalInput?.addEventListener('keydown', onKeydown)

            this.dom.globalModalBackdrop.style.display = 'flex'
            requestAnimationFrame(() => {
                this.dom.globalModalBackdrop?.classList.add('show')
                this.dom.globalModalInput?.focus()
                this.dom.globalModalInput?.select()
            })
        })
    }

    async loadSettings() {
        const saved = await db.getSetting('readerSettings')
        if (saved) {
            this.settings = { ...this.settings, ...saved }
            if (this.settings.shelfViewMode) this.shelfViewMode = this.settings.shelfViewMode
        }
        this.updateSettingsUI()
    }

    saveSettingsDebounced(delay = 200) {
        this.applySettingsToReader()
        clearTimeout(this._saveSettingsTimer)
        this._saveSettingsTimer = setTimeout(() => {
            this.saveSettings().catch(err => console.warn('Failed to save settings:', err))
        }, delay)
    }

    async saveSettings() {
        clearTimeout(this._saveSettingsTimer)
        this.settings.shelfViewMode = this.shelfViewMode
        this.settings.updatedAt = Date.now()
        await db.setSetting('readerSettings', this.settings)
        this.applySettingsToReader()
    }

    updateSettingsUI() {
        // Theme active state
        this.dom.themeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.val === this.settings.theme)
        })
        // Font active state
        this.dom.fontButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.val === this.settings.font)
        })
        // Sliders
        if (this.dom.fontSizeSlider) {
            this.dom.fontSizeSlider.value = this.settings.fontSize
            this.dom.fontSizeValue.innerText = `${this.settings.fontSize}px`
        }
        if (this.dom.fontWeightSlider) {
            this.dom.fontWeightSlider.value = this.settings.fontWeight || 400
            this.dom.fontWeightValue.innerText = formatFontWeight(this.settings.fontWeight || 400)
        }
        if (this.dom.letterSpacingSlider) {
            this.dom.letterSpacingSlider.value = this.settings.letterSpacing || 0
            this.dom.letterSpacingValue.innerText = `${this.settings.letterSpacing || 0}px`
        }
        if (this.dom.chineseQuotesSwitch) {
            this.dom.chineseQuotesSwitch.checked = !!this.settings.chineseQuotes
        }
        if (this.dom.lineHeightSlider) {
            this.dom.lineHeightSlider.value = this.settings.lineHeight
            this.dom.lineHeightValue.innerText = this.settings.lineHeight
        }
        if (this.dom.marginSlider) {
            this.dom.marginSlider.value = this.settings.margin || 48
            this.dom.marginValue.innerText = `${this.settings.margin || 48}px`
        }
        if (this.dom.maxWidthSlider) {
            this.dom.maxWidthSlider.value = this.settings.maxWidth || 760
            this.dom.maxWidthValue.innerText = `${this.settings.maxWidth || 760}px`
        }
        if (this.dom.gapSlider) {
            this.dom.gapSlider.value = this.settings.gap || 6
            this.dom.gapValue.innerText = `${this.settings.gap || 6}%`
        }
        if (this.dom.columnCountSelect) {
            this.dom.columnCountSelect.value = this.settings.columnCount || '2'
        }
        if (this.dom.layoutSelect) {
            this.dom.layoutSelect.value = this.settings.layout
        }
        const writingModeSelect = document.getElementById('setting-writing-mode')
        if (writingModeSelect) {
            writingModeSelect.value = this.settings.writingMode || 'horizontal'
        }
        if (this.dom.settingRealisticPen) {
            this.dom.settingRealisticPen.checked = this.settings.realisticPen !== false
        }
        if (this.dom.settingFullscreenAutohide) {
            this.dom.settingFullscreenAutohide.checked = !!this.settings.fullscreenAutohide
        }

        // View mode switcher buttons
        this.dom.btnViewShelf?.classList.toggle('active', this.shelfViewMode === 'shelf')
        this.dom.btnViewGrid?.classList.toggle('active', this.shelfViewMode === 'grid')
        this.dom.btnViewList?.classList.toggle('active', this.shelfViewMode === 'list')
    }

    async openStatsView() {
        this.shelfCategory = 'stats'
        await this.refreshBookshelf()
    }

    async setShelfViewMode(mode) {
        if (['shelf', 'grid', 'list'].includes(mode)) {
            this.shelfViewMode = mode
            this.updateSettingsUI()
            await this.saveSettings()
            await this.refreshBookshelf()
        }
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme)
        this.settings.theme = theme
        this.applySettingsToReader()
    }

    applySettingsToReader() {
        if (!this.foliateView || !this.foliateView.renderer) return
        const r = this.foliateView.renderer
        
        if (this.foliateView.isFixedLayout) {
            if (r.setSpread && this.foliateView.lastLocation != null) {
                r.setSpread(this.settings.columnCount || '1')
            }
            return
        }

        // Pass margin, max-inline-size, max-column-count, gap, flow to paginator
        if (r.setAttribute) {
            r.setAttribute('flow', this.settings.layout || 'paginated')
            r.setAttribute('margin', `${this.settings.margin || 48}px`)
            r.setAttribute('max-inline-size', `${this.settings.maxWidth || 760}px`)
            r.setAttribute('max-column-count', this.settings.columnCount || '2')
            r.setAttribute('gap', `${this.settings.gap || 6}%`)
        }

        // Pass CSS inside iframe
        const css = buildContentCSS(this.settings)
        if (r.setStyles) {
            r.setStyles(css)
        }
    }

    bindEvents() {
        // Bookshelf actions
        this.dom.btnImport?.addEventListener('click', async () => {
            if (window.electronAPI?.openFileDialog) {
                const fileItems = await window.electronAPI.openFileDialog()
                if (fileItems && fileItems.length > 0) {
                    for (const f of fileItems) {
                        const buffer = f.buffer || (window.electronAPI.readFileBuffer ? await window.electronAPI.readFileBuffer(f.filePath) : null)
                        if (buffer) {
                            const fileObj = new File([buffer], f.filename)
                            await this.processAndSaveBook(fileObj)
                        }
                    }
                    this.refreshBookshelf()
                }
            } else {
                this.dom.fileInput?.click()
            }
        })
        this.dom.fileInput?.addEventListener('change', e => this.handleFileSelect(e))

        // Electron OS File Association Listener with complete UI & lifecycle tear-down
        if (window.electronAPI?.onOpenFile) {
            window.electronAPI.onOpenFile(async fileInfo => {
                if (!fileInfo || !fileInfo.buffer) return
                try {
                    // 1. Close any active modal dialogs
                    const modals = [
                        this.dom.globalModalBackdrop,
                        this.dom.welcomeModalBackdrop,
                        this.dom.modalCreateList,
                        this.dom.modalManageBookLists,
                        this.dom.modalBatchAddToList,
                        document.getElementById('modal-stats-detail'),
                        document.getElementById('modal-webdav-sync'),
                        document.getElementById('quote-card-backdrop'),
                        document.getElementById('footnote-popup')
                    ]
                    modals.forEach(m => {
                        if (m) {
                            m.classList?.remove('show')
                            m.style.display = 'none'
                        }
                    })

                    // 2. Close active drawer
                    if (this.activeDrawer) {
                        this.closeDrawer()
                    }

                    // 3. If currently reading a book, gracefully flush & close it first
                    if (this.currentBookId) {
                        await this.closeReader()
                    }

                    const fileObj = new File([fileInfo.buffer], fileInfo.filename)
                    const bookId = await this.processAndSaveBook(fileObj)
                    if (bookId) {
                        await this.openBook(bookId)
                    }
                } catch (err) {
                    console.error('Failed to open file from OS event:', err)
                }
            })

            // Notify main process that renderer is ready to receive and process file associations
            window.electronAPI?.rendererReady?.().catch(() => {})
        }
        this.dom.btnShelfSettings?.addEventListener('click', () => this.openDrawer('settings'))
        this.setupSyncEventListeners()
        this.setupUpdateEventListeners()
        this.initUpdateService()

        // Welcome Onboarding Save
        const handleWelcomeSave = () => {
            const name = this.dom.welcomeUsernameInput?.value.trim() || 'Linden 读者'
            localStorage.setItem('linden_user_name', name)
            localStorage.setItem('linden_user_initialized', 'true')
            if (this.dom.welcomeModalBackdrop) this.dom.welcomeModalBackdrop.style.display = 'none'
            if (this.dom.settingUserName) this.dom.settingUserName.value = name
            if (this.dom.quoteUserNameInput) this.dom.quoteUserNameInput.value = name
            if (quoteCard) quoteCard.userName = name
            this.showToast(`✨ 欢迎您，${name}！祝您阅读愉快`, '🌱')
        }
        this.dom.btnWelcomeConfirm?.addEventListener('click', handleWelcomeSave)
        this.dom.welcomeUsernameInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter') handleWelcomeSave()
        })

        // Setting User Name Input
        this.dom.settingUserName?.addEventListener('input', e => {
            const name = e.target.value.trim() || 'Linden 读者'
            localStorage.setItem('linden_user_name', name)
            if (this.dom.quoteUserNameInput) this.dom.quoteUserNameInput.value = name
            if (quoteCard) quoteCard.userName = name
        })

        // Quick favorite toggle button in header
        this.dom.btnHeaderFavorite?.addEventListener('click', () => {
            if (this.shelfCategory === 'favorite') {
                this.shelfCategory = 'all'
            } else {
                this.shelfCategory = 'favorite'
            }
            this.dom.navCategoryItems?.forEach(i => {
                i.classList.toggle('active', i.dataset.category === this.shelfCategory)
            })
            const titles = { all: '全部图书', favorite: '⭐️ 收藏的书', unread: '待读清单', finished: '已读完', stats: '📊 阅读统计看板' }
            if (this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.innerText = titles[this.shelfCategory] || '全部图书'
            }
            this.refreshBookshelf()
        })

        let searchTimer = null
        this.dom.shelfSearch?.addEventListener('input', e => {
            this.searchQuery = e.target.value
            clearTimeout(searchTimer)
            searchTimer = setTimeout(() => this.refreshBookshelf(), 150)
        })

        // Window resize adaptive layout for skeuomorphic shelf
        let resizeTimer = null
        window.addEventListener('resize', () => {
            if (this.shelfViewMode === 'shelf' && this.dom.bookshelfView?.style.display !== 'none') {
                clearTimeout(resizeTimer)
                resizeTimer = setTimeout(() => {
                    if (this.currentBooksList) this.renderBooksShelf(this.currentBooksList)
                }, 100)
            }
        })

        // Category switching
        this.dom.navCategoryItems?.forEach(item => {
            item.addEventListener('click', () => {
                this.dom.navCategoryItems.forEach(i => i.classList.remove('active'))
                document.querySelectorAll('.custom-list-nav-item').forEach(i => i.classList.remove('active'))
                item.classList.add('active')
                this.shelfCategory = item.dataset.category
                const titles = { all: '全部图书', favorite: '⭐️ 收藏的书', unread: '待读清单', finished: '已读完', stats: '📊 阅读统计看板' }
                if (this.dom.currentCategoryTitle) {
                    this.dom.currentCategoryTitle.innerText = titles[this.shelfCategory] || '全部图书'
                }
                
                if (this.shelfCategory === 'stats') {
                    this.dom.mainArea?.classList.remove('wood-shelf-active')
                    this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
                    if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
                    if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
                    if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
                    if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'block'
                    if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
                    if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
                    this.renderStatsDashboard()
                } else {
                    if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
                    if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
                    if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'
                    this.refreshBookshelf()
                }
            })
        })

        // Custom Reading Lists Events
        this.dom.btnCreateList?.addEventListener('click', () => this.openCreateListModal())
        this.dom.btnCloseCreateList?.addEventListener('click', () => this.closeCreateListModal())
        this.dom.btnCancelCreateList?.addEventListener('click', () => this.closeCreateListModal())
        this.dom.btnConfirmCreateList?.addEventListener('click', () => this.handleCreateListConfirm())
        this.dom.inputCustomListName?.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.handleCreateListConfirm()
        })
        this.dom.modalCreateList?.addEventListener('click', e => {
            if (e.target === this.dom.modalCreateList) this.closeCreateListModal()
        })

        this.dom.btnCloseBookLists?.addEventListener('click', () => this.closeManageBookListsModal())
        this.dom.btnCancelBookLists?.addEventListener('click', () => this.closeManageBookListsModal())
        this.dom.btnSaveBookLists?.addEventListener('click', () => this.handleSaveBookLists())
        this.dom.btnQuickNewListInModal?.addEventListener('click', () => {
            this.closeManageBookListsModal()
            this.openCreateListModal()
        })
        this.dom.modalManageBookLists?.addEventListener('click', e => {
            if (e.target === this.dom.modalManageBookLists) this.closeManageBookListsModal()
        })

        this.dom.btnListAddBooks?.addEventListener('click', () => this.openBatchAddToListModal())
        this.dom.btnCloseBatchAddList?.addEventListener('click', () => this.closeBatchAddToListModal())
        this.dom.btnCancelBatchAddList?.addEventListener('click', () => this.closeBatchAddToListModal())
        this.dom.btnConfirmBatchAddList?.addEventListener('click', () => this.handleConfirmBatchAddList())
        this.dom.modalBatchAddToList?.addEventListener('click', e => {
            if (e.target === this.dom.modalBatchAddToList) this.closeBatchAddToListModal()
        })

        // WeChat Read Stats Segmented Tabs (周 / 月 / 年 / 总)
        this.dom.statsSegmentedTabs?.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.dom.statsSegmentedTabs.forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                this.statsViewMode = btn.dataset.mode || 'month'
                if (this.statsViewMode === 'week') {
                    this.statsWeekOffset = 0
                }
                this.renderStatsDashboard()
            })
        })

        // Stats Date Navigator (上一周期 / 下一周期)
        this.dom.btnStatsPrevDate?.addEventListener('click', () => {
            if (this.statsViewMode === 'week') {
                this.statsWeekOffset--
            } else if (this.statsViewMode === 'month') {
                this.statsMonth--
                if (this.statsMonth < 1) { this.statsMonth = 12; this.statsYear-- }
            } else if (this.statsViewMode === 'year') {
                this.statsYear--
            }
            this.renderStatsDashboard()
        })
        this.dom.btnStatsNextDate?.addEventListener('click', () => {
            if (this.dom.btnStatsNextDate.disabled) return
            const now = new Date()
            if (this.statsViewMode === 'week') {
                if ((this.statsWeekOffset || 0) >= 0) return
                this.statsWeekOffset++
            } else if (this.statsViewMode === 'month') {
                if (this.statsYear > now.getFullYear() || (this.statsYear === now.getFullYear() && this.statsMonth >= (now.getMonth() + 1))) return
                this.statsMonth++
                if (this.statsMonth > 12) { this.statsMonth = 1; this.statsYear++ }
            } else if (this.statsViewMode === 'year') {
                if (this.statsYear >= now.getFullYear()) return
                this.statsYear++
            }
            this.renderStatsDashboard()
        })

        // Refresh Stats Button
        this.dom.btnRefreshStats?.addEventListener('click', () => this.renderStatsDashboard())

        // Stats Quad KPI Cards Interactions -> Opens period details modal
        document.getElementById('card-quad-read-books')?.addEventListener('click', () => {
            this.openStatsDetailModal('read_books')
        })
        document.getElementById('card-quad-finished-books')?.addEventListener('click', () => {
            this.openStatsDetailModal('finished_books')
        })
        document.getElementById('card-quad-read-days')?.addEventListener('click', () => {
            const chartCard = document.querySelector('.stats-chart-card')
            if (chartCard) {
                chartCard.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
        })
        document.getElementById('card-quad-notes')?.addEventListener('click', () => {
            this.openStatsDetailModal('notes')
        })
        document.getElementById('btn-close-stats-detail')?.addEventListener('click', () => {
            this.closeStatsDetailModal()
        })
        document.getElementById('btn-stats-detail-confirm')?.addEventListener('click', () => {
            this.closeStatsDetailModal()
        })
        document.getElementById('modal-stats-detail')?.addEventListener('click', e => {
            if (e.target === document.getElementById('modal-stats-detail')) {
                this.closeStatsDetailModal()
            }
        })

        // View Mode Switcher
        this.dom.btnViewShelf?.addEventListener('click', () => this.setShelfViewMode('shelf'))
        this.dom.btnViewGrid?.addEventListener('click', () => this.setShelfViewMode('grid'))
        this.dom.btnViewList?.addEventListener('click', () => this.setShelfViewMode('list'))

        // Sort Dropdown
        this.dom.btnSortToggle?.addEventListener('click', e => {
            e.stopPropagation()
            this.dom.sortDropdownMenu?.classList.toggle('active')
        })
        document.addEventListener('click', e => {
            if (this.dom.sortDropdownMenu && !this.dom.sortDropdownMenu.contains(e.target) && e.target !== this.dom.btnSortToggle) {
                this.dom.sortDropdownMenu.classList.remove('active')
            }
        })
        this.dom.sortMenuItems?.forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.sort) {
                    this.sortField = item.dataset.sort
                    this.dom.sortMenuItems.forEach(i => {
                        if (i.dataset.sort) {
                            i.classList.toggle('active', i.dataset.sort === this.sortField)
                            const chk = i.querySelector('.sort-check')
                            if (chk) chk.innerText = i.dataset.sort === this.sortField ? '✓' : ''
                        }
                    })
                }
                if (item.dataset.order) {
                    this.sortOrder = item.dataset.order
                    this.dom.sortMenuItems.forEach(i => {
                        if (i.dataset.order) {
                            i.classList.toggle('active', i.dataset.order === this.sortOrder)
                            const chk = i.querySelector('.order-check')
                            if (chk) chk.innerText = i.dataset.order === this.sortOrder ? '✓' : ''
                        }
                    })
                }
                this.refreshBookshelf()
            })
        })

        // Drag & Drop
        window.addEventListener('dragover', e => {
            e.preventDefault()
            this.dom.dropZoneOverlay?.classList.add('active')
        })
        window.addEventListener('dragleave', e => {
            if (e.relatedTarget === null) {
                this.dom.dropZoneOverlay?.classList.remove('active')
            }
        })
        window.addEventListener('drop', e => {
            e.preventDefault()
            this.dom.dropZoneOverlay?.classList.remove('active')
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                this.importFiles(Array.from(e.dataTransfer.files))
            }
        })

        // Reader View navigation & UI toggles
        this.dom.btnBackToShelf?.addEventListener('click', () => this.closeReader())
        this.dom.btnNavLeft?.addEventListener('click', () => this.turnPagePrev())
        this.dom.btnNavRight?.addEventListener('click', () => this.turnPageNext())
        this.dom.btnPrevPage?.addEventListener('click', () => this.turnPagePrev())
        this.dom.btnNextPage?.addEventListener('click', () => this.turnPageNext())

        this.dom.readerContentArea?.addEventListener('click', e => {
            if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.selection-popup') || e.target.closest('.highlight-action-popup') || e.target.closest('input') || e.target.closest('.nav-arrow-left') || e.target.closest('.nav-arrow-right')) return
            this.toggleReaderUI()
        })

        // Progress Slider (Smooth debounced seeking and guaranteed change commit)
        let progressSeekTimer = null
        const executeSeek = fraction => {
            if (this.foliateView) {
                this.foliateView.goToFraction(fraction)
            }
        }
        this.dom.progressSlider?.addEventListener('input', e => {
            const fraction = parseFloat(e.target.value) / 100
            if (this.dom.progressText) {
                this.dom.progressText.innerText = `${Math.round(fraction * 100)}%`
            }
            clearTimeout(progressSeekTimer)
            progressSeekTimer = setTimeout(() => executeSeek(fraction), 80)
        })
        this.dom.progressSlider?.addEventListener('change', e => {
            clearTimeout(progressSeekTimer)
            const fraction = parseFloat(e.target.value) / 100
            executeSeek(fraction)
        })

        // Drawer toggles
        this.dom.btnToggleTOC?.addEventListener('click', () => this.openDrawer('toc'))
        this.dom.btnToggleSearch?.addEventListener('click', () => this.openDrawer('search'))
        this.dom.btnToggleNotes?.addEventListener('click', () => this.openDrawer('notes'))
        this.dom.btnToggleSettings?.addEventListener('click', () => this.openDrawer('settings'))
        this.dom.drawerCloseBtn?.addEventListener('click', () => this.closeDrawer())
        this.dom.drawerBackdrop?.addEventListener('click', () => this.closeDrawer())

        // Drawer Tab switching
        this.dom.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab))
        })

        // Appearance settings
        this.dom.themeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyTheme(btn.dataset.val)
                this.saveSettings()
                this.updateSettingsUI()
            })
        })

        this.dom.fontButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.settings.font = btn.dataset.val
                this.saveSettings()
                this.updateSettingsUI()
            })
        })

        this.dom.fontSizeSlider?.addEventListener('input', e => {
            this.settings.fontSize = parseInt(e.target.value, 10)
            this.dom.fontSizeValue.innerText = `${this.settings.fontSize}px`
            this.saveSettingsDebounced()
        })

        this.dom.fontWeightSlider?.addEventListener('input', e => {
            this.settings.fontWeight = parseInt(e.target.value, 10)
            this.dom.fontWeightValue.innerText = formatFontWeight(this.settings.fontWeight)
            this.saveSettingsDebounced()
        })

        this.dom.lineHeightSlider?.addEventListener('input', e => {
            this.settings.lineHeight = parseFloat(e.target.value)
            this.dom.lineHeightValue.innerText = this.settings.lineHeight
            this.saveSettingsDebounced()
        })

        this.dom.marginSlider?.addEventListener('input', e => {
            this.settings.margin = parseInt(e.target.value, 10)
            this.dom.marginValue.innerText = `${this.settings.margin}px`
            this.saveSettingsDebounced()
        })

        this.dom.maxWidthSlider?.addEventListener('input', e => {
            this.settings.maxWidth = parseInt(e.target.value, 10)
            this.dom.maxWidthValue.innerText = `${this.settings.maxWidth}px`
            this.saveSettingsDebounced()
        })

        this.dom.gapSlider?.addEventListener('input', e => {
            this.settings.gap = parseInt(e.target.value, 10)
            this.dom.gapValue.innerText = `${this.settings.gap}%`
            this.saveSettingsDebounced()
        })

        this.dom.columnCountSelect?.addEventListener('change', e => {
            this.settings.columnCount = e.target.value
            this.saveSettings()
        })

        this.dom.layoutSelect?.addEventListener('change', e => {
            this.settings.layout = e.target.value
            this.saveSettings()
        })

        this.dom.settingRealisticPen?.addEventListener('change', async e => {
            this.settings.realisticPen = e.target.checked
            await this.saveSettings()
            await this.reloadAnnotations()
            this.showToast(this.settings.realisticPen ? '已开启模拟手绘笔痕' : '已关闭模拟手绘笔痕')
        })

        this.dom.settingFullscreenAutohide?.addEventListener('change', async e => {
            this.settings.fullscreenAutohide = e.target.checked
            await this.saveSettings()
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                this.toggleReaderUI(!this.settings.fullscreenAutohide)
            }
            this.showToast(this.settings.fullscreenAutohide ? '已开启全屏自动隐藏上下栏' : '已关闭全屏自动隐藏上下栏')
        })

        // Search
        this.dom.btnExecSearch?.addEventListener('click', () => this.executeSearch())
        this.dom.searchQueryInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.executeSearch()
        })
        this.dom.searchQueryInput?.addEventListener('input', e => {
            if (this.dom.btnClearSearchInput) {
                this.dom.btnClearSearchInput.style.display = e.target.value.trim() ? 'block' : 'none'
            }
        })
        this.dom.btnClearSearchInput?.addEventListener('click', () => {
            if (this.dom.searchQueryInput) this.dom.searchQueryInput.value = ''
            if (this.dom.btnClearSearchInput) this.dom.btnClearSearchInput.style.display = 'none'
            this.clearSearchState(true)
        })
        this.dom.btnClearSearchHighlights?.addEventListener('click', () => {
            this.clearSearchState(true)
        })

        // Floating Reader Search Bar navigation
        this.dom.btnSearchBarPrev?.addEventListener('click', () => this.navigateSearchMatch(-1))
        this.dom.btnSearchBarNext?.addEventListener('click', () => this.navigateSearchMatch(1))
        this.dom.btnSearchBarClose?.addEventListener('click', () => this.clearSearchState(false))

        // Notes export
        this.dom.btnExportNotes?.addEventListener('click', () => this.exportNotesToMarkdown())

        this.dom.letterSpacingSlider?.addEventListener('input', e => {
            this.settings.letterSpacing = parseFloat(e.target.value) || 0
            this.dom.letterSpacingValue.innerText = `${this.settings.letterSpacing}px`
            this.saveSettings()
        })

        
        // Jane Reader Writing Mode Toggle (Horizontal vs Vertical-RL)
        const writingModeSelect = document.getElementById('setting-writing-mode')
        if (writingModeSelect) {
            writingModeSelect.value = this.settings.writingMode || 'horizontal'
            writingModeSelect.addEventListener('change', e => {
                this.settings.writingMode = e.target.value
                this.saveSettings()
                this.applySettingsToReader()
            })
        }

        this.dom.chineseQuotesSwitch?.addEventListener('change', e => {
            this.settings.chineseQuotes = e.target.checked
            this.saveSettings()
        })

        // Prevent popup clicks from losing selection
        ;[this.dom.selectionPopup, this.dom.highlightActionPopup].forEach(p => {
            if (p) {
                p.addEventListener('mousedown', e => e.preventDefault())
                p.addEventListener('click', e => e.stopPropagation())
            }
        })

        // Selection popup actions
        this.dom.popupColorDots.forEach(dot => {
            dot.addEventListener('click', () => this.createHighlight(dot.dataset.color, 'highlight'))
        })
        this.dom.btnPopupUnderline?.addEventListener('click', () => {
            this.createHighlight('#2563eb', 'underline')
        })
        this.dom.btnPopupDashed?.addEventListener('click', () => {
            this.createHighlight('#64748b', 'dashed')
        })
        this.dom.btnPopupNote?.addEventListener('click', async () => {
            const noteText = await this.showInputDialog({
                title: '💭 添加划线想法 / 批注',
                placeholder: '记录你对该段落的思考或体会...',
                isMultiline: true
            })
            if (noteText !== null) {
                await this.createHighlight('#facc15', 'highlight', noteText)
            }
        })
        this.dom.btnPopupCopy?.addEventListener('click', async () => {
            if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
                const mergedText = this.multiSelectedRanges.map(r => r.text).join('\n\n')
                await navigator.clipboard.writeText(mergedText)
                this.showToast(`📋 已合并复制 ${this.multiSelectedRanges.length} 处选区内容`, '📋')
                this.clearVirtualMultiSelections()
                this.multiSelectedRanges = []
                const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
                iframe?.contentDocument?.getSelection()?.removeAllRanges()
                this.hideSelectionPopup()
            } else if (this.selectedTextInfo?.text) {
                await navigator.clipboard.writeText(this.selectedTextInfo.text)
                this.showToast('📋 已复制选中文字到剪贴板', '📋')
                this.hideSelectionPopup()
            }
        })
        this.dom.btnPopupSearch?.addEventListener('click', () => {
            const text = this.selectedTextInfo?.text
            if (text) {
                const query = encodeURIComponent(text.slice(0, 100))
                window.open(`https://www.baidu.com/s?wd=${query}`, '_blank')
                this.hideSelectionPopup()
            }
        })


        // Highlight Click Action Popup events
        this.dom.hlActionColorDots.forEach(dot => {
            dot.addEventListener('click', async () => {
                if (this.clickedHighlightInfo) {
                    await this.updateHighlightColor(this.clickedHighlightInfo.value, dot.dataset.color)
                }
            })
        })
        this.dom.hlActionNote?.addEventListener('click', async () => {
            if (this.clickedHighlightInfo) {
                const hl = await this.findHighlightByCFI(this.clickedHighlightInfo.value)
                const currentNote = hl?.note || ''
                const noteText = await this.showInputDialog({
                    title: '✏️ 编辑笔记想法 / 批注',
                    value: currentNote,
                    placeholder: '修改或补充您的思考...',
                    isMultiline: true
                })
                if (noteText !== null) {
                    await this.updateHighlightNote(this.clickedHighlightInfo.value, noteText)
                }
            }
        })
        this.dom.hlActionCopy?.addEventListener('click', async () => {
            if (this.clickedHighlightInfo) {
                const hl = await this.findHighlightByCFI(this.clickedHighlightInfo.value)
                if (hl?.text) navigator.clipboard.writeText(hl.text)
                this.hideHighlightActionPopup()
            }
        })
        this.dom.hlActionDel?.addEventListener('click', async () => {
            if (this.clickedHighlightInfo) {
                await this.deleteHighlightByCFI(this.clickedHighlightInfo.value)
                this.hideHighlightActionPopup()
            }
        })

        // Selection Share Button
        this.dom.btnPopupShare?.addEventListener('click', () => {
            if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
                const joinedQuote = this.multiSelectedRanges.map(r => r.text).join('\n\n……\n\n')
                const chapter = this.currentLocation?.tocItem?.label || ''
                this.openQuoteCardModal(joinedQuote, chapter)
                this.hideSelectionPopup()
            } else if (this.selectedTextInfo?.text) {
                const chapter = this.currentLocation?.tocItem?.label || ''
                this.openQuoteCardModal(this.selectedTextInfo.text, chapter)
                this.hideSelectionPopup()
            }
        })

        // Highlight Action Share Button
        this.dom.hlActionShare?.addEventListener('click', async () => {
            if (this.clickedHighlightInfo) {
                const hl = await this.findHighlightByCFI(this.clickedHighlightInfo.value)
                if (hl?.text) {
                    this.openQuoteCardModal(hl.text, hl.chapterTitle || '')
                }
            }
        })

        // Quote Share Card Dialog Controls
        this.dom.btnQuoteClose?.addEventListener('click', () => this.closeQuoteCardModal())
        this.dom.quoteCardBackdrop?.addEventListener('click', e => {
            if (e.target === this.dom.quoteCardBackdrop) this.closeQuoteCardModal()
        })

        this.dom.quoteTitleLayoutControl?.querySelectorAll('.seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.dom.quoteTitleLayoutControl.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                quoteCard.titleLayout = btn.dataset.layout
                this.updateQuoteCardPreview()
            })
        })

        this.dom.quoteUserNameInput?.addEventListener('input', e => {
            quoteCard.userName = e.target.value.trim() || 'Linden 读者'
            this.updateQuoteCardPreview(false)
        })

        this.dom.quoteTextEditor?.addEventListener('input', e => {
            quoteCard.quoteText = e.target.value
            this.updateQuoteCardPreview(false)
        })

        // Quote Details Expand Toggle
        this.dom.btnQuoteToggleDetails?.addEventListener('click', () => {
            const panel = this.dom.quoteDetailsPanel
            if (!panel) return
            const isHidden = panel.style.display === 'none'
            panel.style.display = isHidden ? 'flex' : 'none'
            this.dom.btnQuoteToggleDetails.classList.toggle('active', isHidden)
        })

        // Quote Custom Book Title, Author, Chapter Inputs
        this.dom.quoteBookTitleInput?.addEventListener('input', e => {
            quoteCard.bookTitle = e.target.value.trim() || '未命名书籍'
            this.updateQuoteCardPreview(false)
        })

        this.dom.quoteBookAuthorInput?.addEventListener('input', e => {
            quoteCard.author = e.target.value.trim() || '未知作者'
            this.updateQuoteCardPreview(false)
        })

        this.dom.quoteChapterTitleInput?.addEventListener('input', e => {
            quoteCard.chapterTitle = e.target.value.trim()
            this.updateQuoteCardPreview(false)
        })

        // Permanently Save Book Metadata to IndexedDB & UI
        this.dom.btnQuoteSaveToShelf?.addEventListener('click', async () => {
            if (!this.currentBookId) return
            const newTitle = this.dom.quoteBookTitleInput?.value.trim() || this.currentBookData?.title
            const newAuthor = this.dom.quoteBookAuthorInput?.value.trim() || this.currentBookData?.author
            try {
                await db.updateBookMetadata(this.currentBookId, { title: newTitle, author: newAuthor })
                if (this.currentBookData) {
                    this.currentBookData.title = newTitle
                    this.currentBookData.author = newAuthor
                }
                if (this.dom.readerBookTitle) {
                    this.dom.readerBookTitle.innerText = newTitle
                }
                this.showToast('🎉 书籍信息已成功永久保存到书库！', '💾')
            } catch (err) {
                console.error('Failed to update book metadata:', err)
                this.showToast(`保存失败: ${err.message}`, '⚠️')
            }
        })

        this.dom.btnQuoteCopyClipboard?.addEventListener('click', async () => {
            const res = await quoteCard.copyImageToClipboard()
            if (res.success) {
                this.showToast('图片已复制到剪贴板，可直接粘贴发送', '✓')
                if (this.dom.quoteCopyToast) {
                    this.dom.quoteCopyToast.style.display = 'block'
                    setTimeout(() => {
                        if (this.dom.quoteCopyToast) this.dom.quoteCopyToast.style.display = 'none'
                    }, 4000)
                }
            } else {
                this.showToast(`复制失败: ${res.error || '剪贴板权限受限，请使用保存图片下载'}`, '⚠️')
            }
        })

        this.dom.btnQuoteDownload?.addEventListener('click', async () => {
            await quoteCard.downloadImage()
        })



        // Fullscreen Toggle
        this.dom.btnToggleFullscreen?.addEventListener('click', () => this.toggleFullscreen())

        document.addEventListener('fullscreenchange', () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement)
            if (this.dom.btnToggleFullscreen) {
                if (isFs) {
                    this.dom.btnToggleFullscreen.title = '退出全屏 (快捷键 F / Esc)'
                    this.dom.btnToggleFullscreen.innerHTML = `
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
                        </svg>
                    `
                } else {
                    this.dom.btnToggleFullscreen.title = '全屏阅读 (快捷键 F)'
                    this.dom.btnToggleFullscreen.innerHTML = `
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                        </svg>
                    `
                }
            }

            if (isFs) {
                if (this.settings.fullscreenAutohide) {
                    this.toggleReaderUI(false)
                }
            } else {
                this.toggleReaderUI(true)
            }
        })

        // Edge proximity handler when in fullscreen with autohide enabled
        const handleFullscreenProximity = (clientY) => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) return
            if (!this.settings.fullscreenAutohide) return
            const winH = window.innerHeight

            if (clientY <= 50) {
                this.dom.readerTopBar?.classList.remove('autohide')
                clearTimeout(this._fsTopTimer)
                this._fsTopTimer = setTimeout(() => {
                    if ((document.fullscreenElement || document.webkitFullscreenElement) && this.settings.fullscreenAutohide) {
                        this.dom.readerTopBar?.classList.add('autohide')
                    }
                }, 3000)
            }
            if (clientY >= winH - 50) {
                this.dom.readerBottomBar?.classList.remove('autohide')
                this.dom.pdfZoomBar?.classList.remove('autohide')
                clearTimeout(this._fsBottomTimer)
                this._fsBottomTimer = setTimeout(() => {
                    if ((document.fullscreenElement || document.webkitFullscreenElement) && this.settings.fullscreenAutohide) {
                        this.dom.readerBottomBar?.classList.add('autohide')
                        this.dom.pdfZoomBar?.classList.add('autohide')
                    }
                }, 3000)
            }
        }
        window.addEventListener('mousemove', e => handleFullscreenProximity(e.clientY), { passive: true })
        this._handleFullscreenProximity = handleFullscreenProximity

        // Footnote Popup Close
        this.dom.btnCloseFootnote?.addEventListener('click', () => this.hideFootnotePopup())
        document.addEventListener('click', e => {
            if (this.dom.footnotePopup && this.dom.footnotePopup.style.display !== 'none' && !this.dom.footnotePopup.contains(e.target)) {
                this.hideFootnotePopup()
            }
        })

        // PDF Zoom Bar Controls
        this.dom.btnPdfZoomOut?.addEventListener('click', () => this.stepPDFZoom(-10))
        this.dom.btnPdfZoomIn?.addEventListener('click', () => this.stepPDFZoom(10))
        this.dom.pdfZoomSlider?.addEventListener('input', e => {
            const val = parseFloat(e.target.value) || 100
            this.setPDFZoom(val / 100)
        })
        this.dom.pdfZoomPercentInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                this.parseAndSetPDFZoom(e.target.value)
                e.target.blur()
            }
        })
        this.dom.pdfZoomPercentInput?.addEventListener('blur', e => {
            this.parseAndSetPDFZoom(e.target.value)
        })
        this.dom.btnPdfFitWidth?.addEventListener('click', () => this.setPDFZoom('fit-width'))
        this.dom.btnPdfFitPage?.addEventListener('click', () => this.setPDFZoom('fit-page'))
        this.dom.btnPdfSpreadToggle?.addEventListener('click', () => {
            const nextMode = this.settings.columnCount === '2' ? '1' : '2'
            this.settings.columnCount = nextMode
            if (this.dom.columnCountSelect) this.dom.columnCountSelect.value = nextMode
            this.saveSettings()
            if (this.foliateView?.renderer?.setSpread) {
                this.foliateView.renderer.setSpread(nextMode)
            }
            this.showToast(nextMode === '2' ? '📖 已切换为双页展开' : '📄 已切换为单页展示')
        })

        // PDF Freehand Drawing Tool Listeners
        const pdfToolBtns = [
            this.dom.btnPdfMarkerYellow,
            this.dom.btnPdfMarkerGreen,
            this.dom.btnPdfPenRed,
            this.dom.btnPdfEraser
        ]
        pdfToolBtns.forEach(btn => {
            btn?.addEventListener('click', () => {
                const tool = btn.dataset.tool
                const color = btn.dataset.color || '#ef4444'
                if (this.pdfDrawTool === tool && (tool === 'eraser' || this.pdfDrawColor === color)) {
                    // Toggle off
                    this.pdfDrawTool = null
                    pdfToolBtns.forEach(b => b?.classList.remove('active'))
                    this.setPdfOverlayDrawingActive(false)
                    this.showToast('已退出手动画笔模式')
                } else {
                    // Activate tool
                    this.pdfDrawTool = tool
                    this.pdfDrawColor = color
                    this.pdfDrawWidth = tool === 'marker' ? 18 : (tool === 'pen' ? 3 : 26)
                    pdfToolBtns.forEach(b => b?.classList.remove('active'))
                    btn.classList.add('active')
                    this.setPdfOverlayDrawingActive(true)
                    const toolName = tool === 'marker' ? '🖍️ 荧光马克笔 (半透明)' : (tool === 'pen' ? '✏️ 批注笔' : '🧹 橡皮擦')
                    this.showToast(`已开启 ${toolName}，可在页面上自由绘制`)
                }
            })
        })

        // PDF Clear Page Drawing
        this.dom.btnPdfClearDraw?.addEventListener('click', async () => {
            if (!this.currentBookId || this.currentPdfPageIndex == null) return
            await db.clearPdfPageDrawing(this.currentBookId, this.currentPdfPageIndex)
            this.redrawPdfPageOverlay()
            this.showToast('🗑️ 已清空当前页手绘批注')
        })

        // PDF OCR Extract Button
        this.dom.btnPdfOcrExtract?.addEventListener('click', () => this.handlePdfOcrExtract())
        this.dom.btnClosePdfOcr?.addEventListener('click', () => this.closePdfOcrModal())
        this.dom.btnCancelPdfOcr?.addEventListener('click', () => this.closePdfOcrModal())
        this.dom.modalPdfOcr?.addEventListener('click', e => {
            if (e.target === this.dom.modalPdfOcr) this.closePdfOcrModal()
        })
        this.dom.btnCopyPdfOcr?.addEventListener('click', () => {
            const text = this.dom.pdfOcrResultText?.value || ''
            if (!text.trim()) {
                this.showToast('没有可复制的识别文字', '⚠️')
                return
            }
            navigator.clipboard.writeText(text).then(() => {
                this.showToast('📋 识别文字已复制到剪贴板', '✅')
            }).catch(() => {
                this.showToast('复制失败，请手动选取复制', '⚠️')
            })
        })

        // Click Page Number to Jump
        this.dom.readerPageNumber?.addEventListener('click', async () => {
            const total = this.currentLocation?.totalPages || this.currentLocation?.location?.total || 1
            const curr = this.currentLocation?.page || (this.currentLocation?.location?.current != null ? this.currentLocation.location.current + 1 : 1)
            const targetStr = await this.showInputDialog({
                title: `📖 快速跳转页码 (1 ~ ${total})`,
                value: String(curr),
                placeholder: `输入 1 到 ${total} 之间的数字页码`
            })
            if (targetStr != null) {
                const targetPage = parseInt(targetStr, 10)
                if (!isNaN(targetPage) && targetPage >= 1 && targetPage <= total) {
                    if (this.foliateView) {
                        this.foliateView.goTo(targetPage - 1)
                    }
                } else if (targetStr.trim() !== '') {
                    this.showToast('请输入有效的页码数字', '⚠️')
                }
            }
        })

        // Ctrl + Mouse Wheel Zoom on Reader
        window.addEventListener('wheel', e => {
            if (e.ctrlKey || e.metaKey) {
                if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                    e.preventDefault()
                    this.stepPDFZoom(e.deltaY < 0 ? 10 : -10)
                }
            }
        }, { passive: false })

        // Keyboard Shortcuts
        document.addEventListener('keydown', e => this.handleGlobalKeydown(e))
    }

    setPDFZoom(zoomVal) {
        if (!this.foliateView?.renderer) return
        let displayStr = '100%'
        let sliderVal = 100

        if (zoomVal === 'fit-width') {
            this.foliateView.renderer.setAttribute('zoom', 'fit-width')
            displayStr = '适宽'
            this.dom.btnPdfFitWidth?.classList.add('active')
            this.dom.btnPdfFitPage?.classList.remove('active')
        } else if (zoomVal === 'fit-page') {
            this.foliateView.renderer.setAttribute('zoom', 'fit-page')
            displayStr = '适页'
            this.dom.btnPdfFitPage?.classList.add('active')
            this.dom.btnPdfFitWidth?.classList.remove('active')
        } else {
            const num = typeof zoomVal === 'number' ? zoomVal : (parseFloat(zoomVal) || 1)
            const clamped = Math.max(0.3, Math.min(3.0, num))
            this.foliateView.renderer.setAttribute('zoom', clamped)
            sliderVal = Math.round(clamped * 100)
            displayStr = `${sliderVal}%`
            this.dom.btnPdfFitWidth?.classList.remove('active')
            this.dom.btnPdfFitPage?.classList.remove('active')
        }

        if (this.dom.pdfZoomSlider) this.dom.pdfZoomSlider.value = sliderVal
        if (this.dom.pdfZoomPercentInput) this.dom.pdfZoomPercentInput.value = displayStr
    }

    stepPDFZoom(deltaPct) {
        const currSliderVal = parseFloat(this.dom.pdfZoomSlider?.value) || 100
        const nextVal = Math.max(30, Math.min(300, currSliderVal + deltaPct))
        this.setPDFZoom(nextVal / 100)
    }

    parseAndSetPDFZoom(inputVal) {
        if (!inputVal) return
        const str = String(inputVal).trim().toLowerCase()
        if (str.includes('宽') || str === 'fit-width') {
            this.setPDFZoom('fit-width')
        } else if (str.includes('页') || str === 'fit-page' || str === 'auto') {
            this.setPDFZoom('fit-page')
        } else {
            const num = parseFloat(str.replace('%', ''))
            if (!isNaN(num) && num > 0) {
                this.setPDFZoom(num / 100)
            } else {
                this.setPDFZoom('fit-page')
            }
        }
    }

    // ==========================================================
    // PDF Freehand Drawing & Light OCR Annotation Engine
    // ==========================================================
    getPdfActiveDocAndTarget() {
        if (!this.foliateView) return null
        
        // Find iframes in shadow roots or documents
        const renderer = this.foliateView.renderer
        let iframes = []
        if (renderer?.shadowRoot) {
            iframes = Array.from(renderer.shadowRoot.querySelectorAll('iframe'))
        }
        if (iframes.length === 0 && this.foliateView.shadowRoot) {
            iframes = Array.from(this.foliateView.shadowRoot.querySelectorAll('iframe'))
        }
        if (iframes.length === 0) {
            iframes = Array.from(document.querySelectorAll('foliate-fxl iframe, foliate-view iframe'))
        }

        for (const iframe of iframes) {
            try {
                const doc = iframe.contentDocument
                if (doc) {
                    const canvas = doc.querySelector('canvas')
                    const img = doc.querySelector('img')
                    const svg = doc.querySelector('svg')
                    const container = doc.getElementById('page-container') || doc.body || doc.documentElement
                    return { iframe, doc, canvas, img, svg, container }
                }
            } catch (e) {}
        }
        return null
    }

    setPdfOverlayDrawingActive(isActive) {
        const activeObj = this.getPdfActiveDocAndTarget()
        if (!activeObj?.doc) return
        const overlayCanvases = activeObj.doc.querySelectorAll('.pdf-draw-overlay-canvas')
        overlayCanvases.forEach(cvs => {
            if (isActive) {
                cvs.classList.add('is-drawing-active')
                cvs.style.pointerEvents = 'auto'
            } else {
                cvs.classList.remove('is-drawing-active')
                cvs.style.pointerEvents = 'none'
            }
        })
    }

    async renderPdfDrawingOverlayForCurrentPage() {
        const activeObj = this.getPdfActiveDocAndTarget()
        if (!activeObj?.doc || !this.currentBookId) return

        const { doc, container, canvas, img, svg } = activeObj
        const targetElement = canvas || img || svg || container
        if (!targetElement) return

        // Ensure container position relative
        container.style.position = 'relative'

        let overlayCanvas = doc.getElementById('pdf-page-draw-overlay')
        if (!overlayCanvas) {
            overlayCanvas = doc.createElement('canvas')
            overlayCanvas.id = 'pdf-page-draw-overlay'
            overlayCanvas.className = 'pdf-draw-overlay-canvas'
            if (this.pdfDrawTool) {
                overlayCanvas.classList.add('is-drawing-active')
                overlayCanvas.style.pointerEvents = 'auto'
            } else {
                overlayCanvas.style.pointerEvents = 'none'
            }
            container.appendChild(overlayCanvas)
            this.attachPdfDrawingPointerEvents(overlayCanvas, doc)
        }

        // Match dimensions to target
        const rect = targetElement.getBoundingClientRect()
        const targetWidth = canvas?.width || Math.round(rect.width) || 800
        const targetHeight = canvas?.height || Math.round(rect.height) || 1100

        overlayCanvas.width = targetWidth
        overlayCanvas.height = targetHeight
        overlayCanvas.style.position = 'absolute'
        overlayCanvas.style.top = (targetElement.offsetTop || 0) + 'px'
        overlayCanvas.style.left = (targetElement.offsetLeft || 0) + 'px'
        overlayCanvas.style.width = (targetElement.style.width || (rect.width ? `${rect.width}px` : '100%'))
        overlayCanvas.style.height = (targetElement.style.height || (rect.height ? `${rect.height}px` : '100%'))
        overlayCanvas.style.zIndex = '30'

        this.pdfOverlayCanvas = overlayCanvas

        // Load saved strokes from IndexedDB
        await this.redrawPdfPageOverlay()
    }

    async redrawPdfPageOverlay() {
        const activeObj = this.getPdfActiveDocAndTarget()
        if (!activeObj?.doc || !this.currentBookId || this.currentPdfPageIndex == null) return
        const overlayCanvas = activeObj.doc.getElementById('pdf-page-draw-overlay')
        if (!overlayCanvas) return

        const ctx = overlayCanvas.getContext('2d')
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

        const drawingRecord = await db.getPdfPageDrawing(this.currentBookId, this.currentPdfPageIndex)
        const strokes = drawingRecord?.strokes || []

        strokes.forEach(stroke => {
            this.drawSingleStrokeOnCanvas(ctx, stroke, overlayCanvas.width, overlayCanvas.height)
        })
    }

    drawSingleStrokeOnCanvas(ctx, stroke, w, h) {
        if (!stroke.points || stroke.points.length === 0) return
        ctx.save()
        if (stroke.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out'
            ctx.strokeStyle = 'rgba(0,0,0,1)'
            ctx.lineWidth = (stroke.width || 24) * (w / 800)
        } else if (stroke.tool === 'marker') {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || 'rgba(250, 204, 21, 0.45)'
            ctx.lineWidth = (stroke.width || 18) * (w / 800)
        } else {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || '#ef4444'
            ctx.lineWidth = (stroke.width || 3) * (w / 800)
        }
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        ctx.beginPath()
        const p0 = stroke.points[0]
        ctx.moveTo(p0[0] * w, p0[1] * h)

        if (stroke.points.length === 1) {
            ctx.lineTo(p0[0] * w + 0.5, p0[1] * h + 0.5)
        } else {
            for (let i = 1; i < stroke.points.length; i++) {
                const pt = stroke.points[i]
                ctx.lineTo(pt[0] * w, pt[1] * h)
            }
        }
        ctx.stroke()
        ctx.restore()
    }

    attachPdfDrawingPointerEvents(canvasElement, doc) {
        let isDrawing = false
        let currentStroke = null
        let currentStrokesList = []
        let gestureBookId = null
        let gesturePageIndex = null

        const getCoords = e => {
            const rect = canvasElement.getBoundingClientRect()
            return [
                Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
                Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
            ]
        }

        const handlePointerDown = async e => {
            if (!this.pdfDrawTool || !this.currentBookId || this.currentPdfPageIndex == null) return
            e.preventDefault()
            e.stopPropagation()
            isDrawing = true
            gestureBookId = this.currentBookId
            gesturePageIndex = this.currentPdfPageIndex

            // Fetch current strokes for this specific book & page
            const drawingRecord = await db.getPdfPageDrawing(gestureBookId, gesturePageIndex)
            currentStrokesList = drawingRecord?.strokes || []

            const [nx, ny] = getCoords(e)
            currentStroke = {
                tool: this.pdfDrawTool,
                color: this.pdfDrawColor,
                width: this.pdfDrawWidth,
                points: [[nx, ny]]
            }

            const ctx = canvasElement.getContext('2d')
            this.drawSingleStrokeOnCanvas(ctx, currentStroke, canvasElement.width, canvasElement.height)
        }

        const handlePointerMove = e => {
            if (!isDrawing || !currentStroke) return
            e.preventDefault()
            e.stopPropagation()

            const [nx, ny] = getCoords(e)
            currentStroke.points.push([nx, ny])

            const ctx = canvasElement.getContext('2d')
            // Draw latest segment
            this.drawSingleStrokeOnCanvas(ctx, currentStroke, canvasElement.width, canvasElement.height)
        }

        const handlePointerUp = async e => {
            if (!isDrawing || !currentStroke) return
            isDrawing = false

            if (currentStroke.points.length > 0 && gestureBookId && gesturePageIndex != null) {
                currentStrokesList.push(currentStroke)
                await db.savePdfPageDrawing(gestureBookId, gesturePageIndex, currentStrokesList)
            }
            currentStroke = null
            gestureBookId = null
            gesturePageIndex = null
            await this.redrawPdfPageOverlay()
        }

        canvasElement.addEventListener('pointerdown', handlePointerDown)
        canvasElement.addEventListener('pointermove', handlePointerMove)
        canvasElement.addEventListener('pointerup', handlePointerUp)
        canvasElement.addEventListener('pointercancel', handlePointerUp)
    }

    // ==========================================================
    // Lightweight On-Demand PDF OCR Text Extraction
    // ==========================================================
    async handlePdfOcrExtract() {
        if (!this.dom.modalPdfOcr) return

        this.dom.modalPdfOcr.style.display = 'flex'
        if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '⏳'
        if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '正在提取当前页面图像并进行文字识别...'
        if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = ''
        if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = '共 0 字'

        try {
            const activeObj = this.getPdfActiveDocAndTarget()
            let imageSource = null

            if (activeObj?.canvas) {
                imageSource = activeObj.canvas
            } else if (activeObj?.img) {
                imageSource = activeObj.img.src
            } else if (activeObj?.doc) {
                // Fallback: search any canvas in document
                const anyCanvas = activeObj.doc.querySelector('canvas')
                if (anyCanvas) imageSource = anyCanvas
            }

            if (!imageSource) {
                // Check if any canvas in reader content area
                const readerCanvas = document.querySelector('#reader-content-area canvas')
                if (readerCanvas) imageSource = readerCanvas
            }

            if (!imageSource) {
                if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '⚠️'
                if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '未找到可识别的页面图像，请确认页面已完全载入。'
                return
            }

            if (typeof Tesseract === 'undefined') {
                if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '⚠️'
                if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = 'OCR 识别引擎未就绪，请检查网络或刷新重试。'
                return
            }

            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = 'OCR 引擎分析识别中 (中文/英文)...'
            
            const result = await Tesseract.recognize(imageSource, 'chi_sim+eng', {
                workerPath: './vendor/tesseract/worker.min.js'
            })

            const recognizedText = (result?.data?.text || '').trim()
            if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = recognizedText
            if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = `共 ${recognizedText.length} 字`
            
            if (recognizedText.length > 0) {
                if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '✅'
                if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '识别完成！可在上方选词或点击下方按钮快速复制'
            } else {
                if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = 'ℹ️'
                if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '识别结束，当前页未检测到明显文字或图像较模糊。'
            }
        } catch (err) {
            console.error('PDF OCR error:', err)
            if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '⚠️'
            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = `识别出错: ${err.message || '未知错误'}`
        }
    }

    closePdfOcrModal() {
        if (this.dom.modalPdfOcr) {
            this.dom.modalPdfOcr.style.display = 'none'
        }
    }

    showFootnotePopup({ title, text, rect }) {
        if (!this.dom.footnotePopup) return
        if (this.dom.footnotePopupTitle) this.dom.footnotePopupTitle.innerText = title || '💡 译注与说明'
        if (this.dom.footnotePopupContent) this.dom.footnotePopupContent.innerText = text

        this.dom.footnotePopup.style.display = 'block'
        this.dom.footnotePopup.style.opacity = '1'

        const popupWidth = this.dom.footnotePopup.offsetWidth || 340
        const popupHeight = this.dom.footnotePopup.offsetHeight || 120

        // Calculate best top/left position near rect
        let left = (rect?.left || (window.innerWidth / 2)) + ((rect?.width || 0) / 2) - (popupWidth / 2)
        let top = (rect?.top || (window.innerHeight / 2)) - popupHeight - 14 // above the anchor

        if (top < 70) {
            // If too close to top bar, place below anchor
            top = (rect?.top || 100) + (rect?.height || 20) + 14
        }

        // Clamp within viewport
        left = Math.max(16, Math.min(window.innerWidth - popupWidth - 16, left))
        top = Math.max(60, Math.min(window.innerHeight - popupHeight - 20, top))

        this.dom.footnotePopup.style.left = `${left}px`
        this.dom.footnotePopup.style.top = `${top}px`
    }

    hideFootnotePopup() {
        if (this.dom.footnotePopup) {
            this.dom.footnotePopup.style.display = 'none'
        }
    }

    turnPageNext() {
        if (!this.foliateView) return
        if (typeof this.foliateView.goRight === 'function') {
            this.foliateView.goRight()
        } else if (typeof this.foliateView.next === 'function') {
            this.foliateView.next()
        }
    }

    turnPagePrev() {
        if (!this.foliateView) return
        if (typeof this.foliateView.goLeft === 'function') {
            this.foliateView.goLeft()
        } else if (typeof this.foliateView.prev === 'function') {
            this.foliateView.prev()
        }
    }

    handleGlobalKeydown(e) {
        if (e?.target?.tagName === 'INPUT' || e?.target?.tagName === 'TEXTAREA' || e?.target?.isContentEditable) return

        // Global Escape dismissal for any active modals or drawers
        if (e.key === 'Escape') {
            const statsDetailModal = document.getElementById('modal-stats-detail')
            if (statsDetailModal && (statsDetailModal.classList.contains('show') || statsDetailModal.style.display !== 'none')) {
                this.closeStatsDetailModal()
                return
            }
            const syncModal = this.dom.modalWebdavSync || document.getElementById('modal-webdav-sync')
            if (syncModal && (syncModal.classList.contains('show') || syncModal.style.display !== 'none')) {
                this.closeWebdavSyncModal()
                return
            }
            if (this.dom.quoteCardBackdrop && this.dom.quoteCardBackdrop.style.display !== 'none') {
                this.closeQuoteCardModal()
                return
            }
            if (this.dom.modalManageBookLists && this.dom.modalManageBookLists.style.display !== 'none') {
                this.closeManageBookListsModal()
                return
            }
            if (this.dom.modalCreateList && this.dom.modalCreateList.style.display !== 'none') {
                this.closeCreateListModal()
                return
            }
            const updateModal = this.dom.modalUpdateDialog || document.getElementById('modal-update-dialog')
            if (updateModal && (updateModal.classList.contains('show') || updateModal.style.display !== 'none')) {
                this.closeUpdateModal()
                return
            }
            if (this.dom.modalBatchAddToList && this.dom.modalBatchAddToList.style.display !== 'none') {
                this.closeBatchAddModal()
                return
            }
            if (this.activeDrawer) {
                this.closeDrawer()
                return
            }
        }

        if (this.dom.bookshelfView.style.display === 'none') {
            // Check if any modal backdrop or popup dialog is active
            const isModalActive = () => {
                const modalBackdrops = [
                    this.dom.globalModalBackdrop || document.getElementById('global-modal-backdrop'),
                    this.dom.modalCreateList || document.getElementById('modal-create-list'),
                    this.dom.modalManageBookLists || document.getElementById('modal-manage-book-lists'),
                    this.dom.modalBatchAddToList || document.getElementById('modal-batch-add-to-list'),
                    this.dom.modalUpdateDialog || document.getElementById('modal-update-dialog'),
                    this.dom.modalWebdavSync || document.getElementById('modal-webdav-sync'),
                    document.getElementById('modal-stats-detail'),
                    document.getElementById('quote-card-backdrop'),
                    document.getElementById('modal-pdf-ocr')
                ]
                return modalBackdrops.some(m => m && (m.classList?.contains('show') || (m.style.display !== 'none' && m.style.display !== '')))
            }

            if (isModalActive()) {
                return
            }

            switch (e.key) {
                case 'ArrowUp': {
                    e.preventDefault()
                    const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                    if (container && container.scrollHeight > container.clientHeight + 10) {
                        container.scrollBy({ top: -90, behavior: 'smooth' })
                    } else {
                        this.turnPagePrev()
                    }
                    break
                }
                case 'ArrowDown': {
                    e.preventDefault()
                    const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                    if (container && container.scrollHeight > container.clientHeight + 10) {
                        container.scrollBy({ top: 90, behavior: 'smooth' })
                    } else {
                        this.turnPageNext()
                    }
                    break
                }
                case 'ArrowLeft':
                case 'PageUp':
                case 'h':
                case 'H':
                case 'k':
                case 'K':
                    e.preventDefault()
                    this.turnPagePrev()
                    break
                case 'ArrowRight':
                case 'PageDown':
                case ' ':
                case 'l':
                case 'L':
                case 'j':
                case 'J':
                case 'Enter':
                    e.preventDefault()
                    this.turnPageNext()
                    break
                case 'f':
                case 'F':
                    e.preventDefault()
                    this.toggleFullscreen()
                    break
                case 'F3':
                    e.preventDefault()
                    if (this.currentSearchMatches.length > 0) {
                        this.navigateSearchMatch(e.shiftKey ? -1 : 1)
                    }
                    break
                case 'Escape':
                    if (this.dom.quoteCardBackdrop && this.dom.quoteCardBackdrop.style.display !== 'none') {
                        this.closeQuoteCardModal()
                        return
                    }
                    if (this.currentSearchMatches.length > 0 || (this.dom.readerSearchBar && this.dom.readerSearchBar.style.display !== 'none')) {
                        this.clearSearchState(false)
                    }
                    if (this.activeDrawer) {
                        this.closeDrawer()
                    } else if (document.fullscreenElement) {
                        document.exitFullscreen()
                    }
                    this.hideSelectionPopup()
                    this.hideHighlightActionPopup()
                    break
            }
        }
    }

    toggleFullscreen() {
        if (window.electronAPI?.toggleFullscreen) {
            window.electronAPI.toggleFullscreen()
            return
        }
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
            if (req) {
                req.call(document.documentElement).catch(err => console.warn('Fullscreen request failed:', err))
            }
        } else {
            const exit = document.exitFullscreen || document.webkitExitFullscreen
            if (exit) {
                exit.call(document).catch(err => console.warn('Exit fullscreen failed:', err))
            }
        }
    }

    // ==========================================
    // Quote Card Generator Logic (WeChat Read Style)
    // ==========================================
    cleanFootnoteMarkers(text) {
        if (!text) return ''
        return text
            // Remove bracketed footnote numbers like [10], [1], [注1], [ 12 ], [a], [note], etc.
            .replace(/\s*\[\s*(?:注|note|\d+|[a-zA-Z])\s*\]/gi, '')
            .replace(/\s*〔\s*\d+\s*〕/g, '')
            .replace(/\s*【\s*\d+\s*】/g, '')
            .replace(/\s*［\s*\d+\s*］/g, '')
            .replace(/\s*\(?(?:①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|⑪|⑫|⑬|⑭|⑮|⑯|⑰|⑱|⑲|⑳)\)?/g, '')
            .replace(/[ \t]+/g, ' ')
            .trim()
    }

    async openQuoteCardModal(text, chapterTitle = '') {
        this.hideSelectionPopup()
        this.hideHighlightActionPopup()

        const cleanedText = this.cleanFootnoteMarkers(text)
        const cleanedChapter = this.cleanFootnoteMarkers(chapterTitle)

        const bookTitle = this.currentBookData?.title || '未命名书籍'
        const author = this.currentBookData?.author || '未知作者'
        const pageIndex = this.currentLocation?.pageNumber || ''

        quoteCard.setData({
            bookTitle,
            author,
            quoteText: cleanedText,
            chapterTitle: cleanedChapter,
            pageIndex,
            userName: this.dom.quoteUserNameInput?.value || 'Linden 读者'
        })

        if (this.dom.quoteTextEditor) {
            this.dom.quoteTextEditor.value = cleanedText
        }
        if (this.dom.quoteBookTitleInput) {
            this.dom.quoteBookTitleInput.value = bookTitle
        }
        if (this.dom.quoteBookAuthorInput) {
            this.dom.quoteBookAuthorInput.value = author
        }
        if (this.dom.quoteChapterTitleInput) {
            this.dom.quoteChapterTitleInput.value = cleanedChapter
        }

        // Render Theme Pickers
        this.renderQuoteThemePicker()

        // Show Modal
        if (this.dom.quoteCardBackdrop) {
            this.dom.quoteCardBackdrop.style.display = 'flex'
        }

        // Render Canvas Preview
        await this.updateQuoteCardPreview()
    }

    closeQuoteCardModal() {
        if (this.dom.quoteCardBackdrop) {
            this.dom.quoteCardBackdrop.style.display = 'none'
        }
        if (this.dom.quoteCopyToast) {
            this.dom.quoteCopyToast.style.display = 'none'
        }
    }

    renderQuoteThemePicker() {
        if (!this.dom.quoteThemePicker) return
        this.dom.quoteThemePicker.innerHTML = ''

        THEMES.forEach(t => {
            const btn = document.createElement('button')
            btn.className = `quote-theme-pill ${t.id === quoteCard.currentThemeId ? 'active' : ''}`
            btn.dataset.theme = t.id
            btn.innerHTML = `
                <span class="quote-theme-color-dot" style="background: ${t.bg};"></span>
                <span>${t.name}</span>
            `
            btn.addEventListener('click', async () => {
                this.dom.quoteThemePicker.querySelectorAll('.quote-theme-pill').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                quoteCard.setTheme(t.id)
                await this.updateQuoteCardPreview()
            })
            this.dom.quoteThemePicker.appendChild(btn)
        })
    }

    async updateQuoteCardPreview(immediate = true) {
        if (!this.dom.quoteCanvasWrap) return
        if (this._quoteCardDebounceTimer) {
            clearTimeout(this._quoteCardDebounceTimer)
            this._quoteCardDebounceTimer = null
        }

        const executeRender = async () => {
            this._quoteCardToken = (this._quoteCardToken || 0) + 1
            const currentToken = this._quoteCardToken
            const canvas = await quoteCard.renderCanvas()
            if (this._quoteCardToken === currentToken && this.dom.quoteCanvasWrap) {
                this.dom.quoteCanvasWrap.innerHTML = ''
                this.dom.quoteCanvasWrap.appendChild(canvas)
            }
        }

        if (immediate) {
            await executeRender()
        } else {
            this._quoteCardDebounceTimer = setTimeout(executeRender, 200)
        }
    }

    // ==========================================
    // Bookshelf Logic
    // ==========================================
    async handleFileSelect(e) {
        const files = Array.from(e.target.files)
        if (files.length > 0) {
            await this.importFiles(files)
            this.dom.fileInput.value = ''
        }
    }

    async importFiles(files) {
        for (const file of files) {
            try {
                await this.processAndSaveBook(file)
            } catch (err) {
                console.error(`Failed to import file ${file.name}:`, err)
                this.showToast(`导入书籍 ${file.name} 失败: ${err.message}`, '⚠️')
            }
        }
        await this.refreshBookshelf()
    }

    async processAndSaveBook(file, customFileName) {
        const fileName = customFileName || file.name || file.filename || (file.path ? file.path.split(/[\\/]/).pop() : '未命名电子书.txt')
        let ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : ''
        if (!ext) {
            if (file.type === 'text/plain') ext = 'txt'
            else if (file.type === 'application/pdf') ext = 'pdf'
            else if (file.type === 'application/epub+zip') ext = 'epub'
            else ext = 'txt'
        }
        
        const SUPPORTED_EXTS = ['epub', 'mobi', 'azw', 'azw3', 'pdf', 'docx', 'txt', 'md', 'cbz', 'fb2']
        if (!SUPPORTED_EXTS.includes(ext)) {
            throw new Error(`不支持的文件格式 .${ext}。支持的格式包括：EPUB, PDF, DOCX, MOBI, AZW, AZW3, TXT, MD, CBZ, FB2`)
        }

        let format = ext
        if (ext === 'md') format = 'txt'
        else if (ext === 'azw' || ext === 'azw3') format = 'azw3'
        else if (ext === 'docx') format = 'docx'

        let metadata = { title: fileName.replace(/\.[^/.]+$/, ''), author: '未知作者', language: '中文' }
        let coverBlob = null

        try {
            const { makeBook } = await import('../foliate-js-main/view.js?v=20260826_63')
            const tempBook = await makeBook(file)
            if (tempBook.metadata) {
                const bookTitle = formatLanguageMap(tempBook.metadata.title)
                if (bookTitle && !['未命名', '未命名书籍', '未命名电子书', 'untitled'].includes(bookTitle.trim().toLowerCase())) {
                    metadata.title = bookTitle
                }
                const bookAuthor = formatContributor(tempBook.metadata.author)
                if (bookAuthor && !['未知作者', '未知', 'unknown'].includes(bookAuthor.trim().toLowerCase())) {
                    metadata.author = bookAuthor
                }
                if (tempBook.metadata.language) {
                    const rawLang = Array.isArray(tempBook.metadata.language)
                        ? tempBook.metadata.language[0]
                        : tempBook.metadata.language
                    if (rawLang && typeof rawLang === 'string') {
                        const l = rawLang.toLowerCase()
                        metadata.language = l.startsWith('zh') ? '中文' : l.startsWith('en') ? '英语' : l.startsWith('ja') ? '日语' : l
                    }
                }
            }
            if (typeof tempBook.getCover === 'function') {
                coverBlob = await tempBook.getCover()
            }
            tempBook.destroy?.()
        } catch (e) {
            console.warn('Metadata/Cover extraction warning:', e)
        }

        // Secondary robust fallback for EPUB / CBZ files
        if (!coverBlob && (format === 'epub' || format === 'cbz' || file.name?.endsWith('.epub') || file.name?.endsWith('.cbz'))) {
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260826_63')
                const loader = await makeZipLoader(file)
                const imgEntries = loader.entries.filter(e => /\.(jpe?g|png|webp)$/i.test(e.filename))
                const coverEntry = imgEntries.find(e => /cover/i.test(e.filename)) || imgEntries[0]
                if (coverEntry) {
                    const mime = coverEntry.filename.endsWith('.png') ? 'image/png' : coverEntry.filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
                    coverBlob = await loader.loadBlob(coverEntry.filename, mime)
                }
            } catch (e) {
                console.warn('Fallback zip cover extraction error:', e)
            }
        }

        // Check for existing book to prevent duplicates and preserve reading progress
        const GENERIC_TITLES = ['未命名', '未命名书籍', '未命名电子书', 'pdf 文档', 'document', 'untitled', '新文件', '文档']
        const rawTitle = (metadata.title || '').trim().toLowerCase()
        const rawBase = fileName.replace(/\.[^/.]+$/, '').trim().toLowerCase()
        const isGenericTitle = !rawTitle || GENERIC_TITLES.includes(rawTitle) || GENERIC_TITLES.includes(rawBase)

        const existingBooks = await db.getAllBooks()
        const match = isGenericTitle ? null : existingBooks.find(b => {
            if (b.format !== format) return false
            const bTitle = (b.title || '').trim().toLowerCase()
            const titleMatches = bTitle === rawTitle || bTitle === rawBase
            if (!titleMatches) return false
            
            // Accurate match: match by identifier or author/size
            const bAuthor = (b.author || '').trim().toLowerCase()
            const metaAuthor = (metadata.author || '').trim().toLowerCase()
            const isKnownAuthor = metaAuthor && !metaAuthor.includes('未知') && !metaAuthor.includes('unknown')
            if (isKnownAuthor && bAuthor && bAuthor === metaAuthor) {
                return true
            }
            if (b.size && file.size && b.size === file.size) {
                return true
            }
            if (metadata.identifier && b.identifier && metadata.identifier === b.identifier) {
                return true
            }
            return !isKnownAuthor && (!b.size || !file.size)
        })

        if (match) {
            console.log(`[processAndSaveBook] Found existing book record: ${match.title} (${match.id})`)
            await db.saveBook({ id: match.id, blob: file })
            return match.id
        }

        const stableKey = metadata.identifier || `${metadata.title || ''}_${file.size || 0}_${format}`.replace(/\s+/g, '').toLowerCase()
        const bookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const bookRecord = {
            id: bookId,
            stableKey,
            identifier: metadata.identifier || null,
            title: metadata.title,
            author: metadata.author,
            language: metadata.language || '中文',
            format: format,
            size: file.size,
            blob: file,
            coverBlob: coverBlob,
            addedAt: Date.now(),
            lastReadAt: 0,
            progress: { fraction: 0 }
        }

        await db.saveBook(bookRecord)
        return bookId
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
            const { makeBook } = await import('../foliate-js-main/view.js?v=20260826_63')
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
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260826_63')
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
            book.coverBlob = coverBlob
            await db.saveBook(book)
            const coverUrl = coverUrlPool.get(book.id, coverBlob)
            
            // Dynamically update DOM if present on shelf
            const skeuoEl = document.querySelector(`.skeuo-book[data-id="${book.id}"] .skeuo-book-cover`)
            if (skeuoEl) {
                const existingImg = skeuoEl.querySelector('.skeuo-cover-img')
                if (existingImg) {
                    existingImg.src = coverUrl
                } else {
                    const cleanCover = skeuoEl.querySelector('.skeuo-clean-cover')
                    if (cleanCover) {
                        cleanCover.outerHTML = `<img class="skeuo-cover-img" src="${coverUrl}" alt="${escapeHTML(book.title)}" loading="lazy"/>`
                    }
                }
            }
            const gridEl = document.querySelector(`.jane-book-card[data-id="${book.id}"] .jane-cover-box`)
            if (gridEl) {
                const existingImg = gridEl.querySelector('.jane-cover-img')
                if (existingImg) {
                    existingImg.src = coverUrl
                } else {
                    const cleanText = gridEl.querySelector('div')
                    if (cleanText) {
                        const img = document.createElement('img')
                        img.className = 'jane-cover-img'
                        img.src = coverUrl
                        img.alt = escapeHTML(book.title)
                        img.loading = 'lazy'
                        cleanText.replaceWith(img)
                    }
                }
            }
        }
        return coverBlob
    }

    async refreshBookshelf() {
        if (this.shelfCategory === 'stats') {
            this.dom.mainArea?.classList.remove('wood-shelf-active')
            this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'block'
            if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
            if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
            return this.renderStatsDashboard()
        }

        if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
        if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
        if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'

        let books = await db.getAllBooks()
        
        // 1. Filter by category
        if (this.shelfCategory === 'favorite') {
            books = books.filter(b => b.isFavorite)
        } else if (this.shelfCategory === 'unread' || this.shelfCategory === 'list_unread') {
            books = books.filter(b => b.customListIds?.includes('list_unread') || (!b.progress?.fraction || b.progress.fraction === 0))
        } else if (this.shelfCategory === 'finished') {
            books = books.filter(b => b.progress?.fraction && b.progress.fraction >= 0.99)
        } else if (this.shelfCategory.startsWith('list_')) {
            const listId = this.shelfCategory
            books = books.filter(b => b.customListIds && b.customListIds.includes(listId))
        }

        // Toggle header favorite button active state
        this.dom.btnHeaderFavorite?.classList.toggle('active', this.shelfCategory === 'favorite')

        // Toggle header Add Books To List button
        if (this.dom.btnListAddBooks) {
            this.dom.btnListAddBooks.style.display = this.shelfCategory.startsWith('list_') ? 'inline-flex' : 'none'
        }

        // 2. Filter by search query
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.trim().toLowerCase()
            books = books.filter(b => (b.title && b.title.toLowerCase().includes(q)) || (b.author && b.author.toLowerCase().includes(q)))
        }

        // 3. Sort books
        books.sort((a, b) => {
            let valA = a[this.sortField] ?? ''
            let valB = b[this.sortField] ?? ''
            if (typeof valA === 'string') {
                const res = valA.localeCompare(valB, 'zh-CN')
                return this.sortOrder === 'asc' ? res : -res
            }
            return this.sortOrder === 'asc' ? (valA - valB) : (valB - valA)
        })

        this.currentBooksList = books

        // 4. Update count footer
        this.dom.bookCountFooter.innerText = `${books.length} 本图书`

        // 5. Render active view
        if (this.shelfViewMode === 'shelf') {
            this.dom.mainArea?.classList.add('wood-shelf-active')
            this.dom.booksWorkspace?.classList.add('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'flex'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            this.renderBooksShelf(books)
        } else if (this.shelfViewMode === 'grid') {
            this.dom.mainArea?.classList.remove('wood-shelf-active')
            this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'grid'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            this.renderBooksGrid(books)
        } else {
            this.dom.mainArea?.classList.remove('wood-shelf-active')
            this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'block'
            this.renderBooksTable(books)
        }
    }

    renderBooksShelf(books) {
        if (!this.dom.booksShelf) return
        const container = this.dom.booksShelf
        container.innerHTML = ''

        if (books.length === 0) {
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory.startsWith('list_')
            let emptyIcon = isFavView ? '⭐' : (isCustomList ? '📑' : '📚')
            let emptyTitle = isFavView ? '暂无收藏图书' : (isCustomList ? '此书单暂无图书' : '书架空空如也')
            let emptySub = isFavView ? '点击任意书籍封面左上角的星星 ★ 即可加入收藏' : (isCustomList ? '点击右上角「+」或在图书卡片上点击 📑 即可加入此书单' : '拖拽电子书到此处，或点击右上角「+」导入图书')

            container.innerHTML = `
                <div class="wood-shelf-empty-state">
                    <div class="empty-book-icon">${emptyIcon}</div>
                    <h3>${emptyTitle}</h3>
                    <p>${emptySub}</p>
                </div>
            `
            return
        }

        // Exactly 4 books per row, dynamic unlimited rows
        const booksPerRow = 4
        const rows = []
        for (let i = 0; i < books.length; i += booksPerRow) {
            rows.push(books.slice(i, i + booksPerRow))
        }

        const shelfFragment = document.createDocumentFragment()
        for (let r = 0; r < rows.length; r++) {
            const shelfRow = document.createElement('div')
            shelfRow.className = 'wood-shelf-row'

            const booksWrap = document.createElement('div')
            booksWrap.className = 'wood-shelf-books'

            const rowBooks = rows[r] || []
            rowBooks.forEach(book => {
                const bookEl = this.createSkeuomorphicBookElement(book)
                booksWrap.appendChild(bookEl)
            })

            // 3D Wood Shelf Plank
            const plank = document.createElement('div')
            plank.className = 'wood-shelf-plank'
            plank.innerHTML = `
                <div class="wood-shelf-surface"></div>
                <div class="wood-shelf-front">
                    <div class="wood-shelf-bevel-highlight"></div>
                </div>
                <div class="wood-shelf-shadow"></div>
            `

            shelfRow.appendChild(booksWrap)
            shelfRow.appendChild(plank)
            shelfFragment.appendChild(shelfRow)
        }
        container.appendChild(shelfFragment)
    }

    createSkeuomorphicBookElement(book) {
        const card = document.createElement('div')
        card.className = 'skeuo-book'
        card.dataset.id = book.id

        const fraction = book.progress?.fraction || 0
        const progressPct = (fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 2 : (fraction % 1 === 0 ? 0 : 2))
        
        let coverUrl = ''
        const isRealImageCover = book.coverBlob && book.coverBlob.type !== 'image/svg+xml'
        if (isRealImageCover) {
            coverUrl = coverUrlPool.get(book.id, book.coverBlob)
        }

        const COVER_PALETTES = [
            { bg: '#f8fafc', border: '#94a3b8', text: '#0f172a', author: '#64748b', tag: 'TXT' },
            { bg: '#fdfbf7', border: '#d4b996', text: '#451a03', author: '#78350f', tag: 'DOC' },
            { bg: '#f0fdf4', border: '#86efac', text: '#14532d', author: '#15803d', tag: 'BOOK' },
            { bg: '#eff6ff', border: '#93c5fd', text: '#1e3a8a', author: '#2563eb', tag: 'EPUB' },
            { bg: '#faf5ff', border: '#d8b4fe', text: '#581c87', author: '#7e22ce', tag: 'NOVEL' },
            { bg: '#fff7ed', border: '#fdba74', text: '#9a3412', author: '#ea580c', tag: 'LIT' },
            { bg: '#fdf4ff', border: '#f0abfc', text: '#701a75', author: '#c026d3', tag: 'CLASSIC' }
        ]
        // High-dispersion hash using title, author, id, format
        const seedStr = `${book.title || ''}|${book.author || ''}|${book.id || ''}|${book.format || ''}`
        let hash = 5381
        for (let i = 0; i < seedStr.length; i++) {
            hash = ((hash << 5) + hash) ^ seedStr.charCodeAt(i)
        }
        const palette = COVER_PALETTES[Math.abs(hash >>> 0) % COVER_PALETTES.length]

        let coverInner = ''
        if (coverUrl) {
            coverInner = `<img class="skeuo-cover-img" src="${coverUrl}" alt="${escapeHTML(book.title)}" loading="lazy"/>`
        } else {
            coverInner = `
                <div class="skeuo-clean-cover" style="background: ${palette.bg}; border-left-color: ${palette.border};">
                    <div class="skeuo-clean-badge">${palette.tag}</div>
                    <div class="skeuo-clean-title" style="color: ${palette.text};">${escapeHTML(book.title)}</div>
                    <div class="skeuo-clean-author" style="color: ${palette.author};">${escapeHTML(book.author || '未知作者')}</div>
                </div>
            `
        }

        // Clean Understated Progress Tag
        let progressTag = ''
        if (fraction >= 0.99) {
            progressTag = '<div class="skeuo-clean-tag is-finished">已读完</div>'
        } else if (fraction > 0) {
            progressTag = `<div class="skeuo-clean-tag">${progressPct}%</div>`
        } else {
            progressTag = '<div class="skeuo-clean-tag is-new">新书</div>'
        }

        const favActive = book.isFavorite ? 'active' : ''
        const favClass = book.isFavorite ? 'is-favorite' : ''
        const favTitle = book.isFavorite ? '取消收藏' : '加入收藏'

        card.innerHTML = `
            <div class="skeuo-book-cover ${favClass}">
                <button class="skeuo-fav-btn ${favActive}" title="${favTitle}">★</button>
                <button class="skeuo-list-btn" title="加入与管理书单">📑</button>
                <button class="skeuo-delete-btn" title="从书架删除">×</button>
                ${progressTag}
                ${coverInner}
                <div class="skeuo-spine-gloss"></div>
                <div class="skeuo-paper-edge"></div>
            </div>
            <div class="skeuo-book-shelf-shadow"></div>
        `

        card.querySelector('.skeuo-fav-btn')?.addEventListener('click', async e => {
            e.stopPropagation()
            const isFav = await db.toggleBookFavorite(book.id)
            book.isFavorite = isFav
            const btn = card.querySelector('.skeuo-fav-btn')
            if (btn) {
                btn.className = `skeuo-fav-btn ${isFav ? 'active' : ''}`
                btn.title = isFav ? '取消收藏' : '加入收藏'
            }
            const coverEl = card.querySelector('.skeuo-book-cover')
            if (coverEl) {
                if (isFav) coverEl.classList.add('is-favorite')
                else coverEl.classList.remove('is-favorite')
            }
            this.showToast(isFav ? `⭐ 已将《${book.title}》加入收藏` : `已取消《${book.title}》收藏`, '⭐')
            if (this.shelfCategory === 'favorite') {
                this.refreshBookshelf()
            }
        })

        card.querySelector('.skeuo-list-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            this.openManageBookListsModal(book.id)
        })

        card.querySelector('.skeuo-delete-btn')?.addEventListener('click', e => {
            e.stopPropagation()
            this.handleDeleteBook(book)
        })

        card.addEventListener('click', () => this.openBook(book.id))
        return card
    }

    createBookCard(book) {
        const card = document.createElement('div')
        card.className = 'jane-book-card'
        card.dataset.id = book.id

        const fraction = book.progress?.fraction || 0
        const progressPct = (fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 2 : (fraction % 1 === 0 ? 0 : 2))
        
        let coverUrl = ''
        if (book.coverBlob) {
            coverUrl = coverUrlPool.get(book.id, book.coverBlob)
        }

        let progressBadge = `<span class="jane-progress-label">${progressPct}%</span>`
        if (fraction === 0) {
            progressBadge = `<span class="jane-progress-label"><span class="badge-new">新</span></span>`
        }
        if (book.totalReadingSeconds && book.totalReadingSeconds >= 60) {
            progressBadge += `<span class="jane-progress-label" style="margin-left: 4px; color: var(--accent-purple); font-size: 0.72rem;">· ${tracker.formatDuration(book.totalReadingSeconds)}</span>`
        }

        const favActive = book.isFavorite ? 'active' : ''
        const favClass = book.isFavorite ? 'is-favorite' : ''
        const favTitle = book.isFavorite ? '取消收藏' : '加入收藏'

        card.innerHTML = `
            <div class="jane-cover-box ${favClass}" style="position: relative;">
                <button class="grid-fav-btn ${favActive}" title="${favTitle}">★</button>
                <button class="grid-list-btn" title="加入与管理书单">📑</button>
                <button class="grid-delete-btn" title="从书架删除">×</button>
                ${coverUrl 
                    ? `<img class="jane-cover-img" src="${coverUrl}" alt="${escapeHTML(book.title)}" loading="lazy"/>`
                    : `<div style="padding: 0.8rem; text-align: center; color: var(--text-muted); font-size: 0.75rem; font-weight: 600;">${escapeHTML(book.title)}</div>`
                }
            </div>
            <div>${progressBadge}</div>
            <div class="jane-book-title" title="${escapeHTML(book.title)}">${escapeHTML(book.title)}</div>
        `
        return card
    }

    renderBooksGrid(books) {
        this.dom.booksGrid.innerHTML = ''

        if (books.length === 0) {
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory.startsWith('list_')
            let emptyIcon = isFavView ? '⭐' : (isCustomList ? '📑' : '📚')
            let emptyTitle = isFavView ? '暂无收藏图书' : (isCustomList ? '此书单暂无图书' : '书架空空如也')
            let emptySub = isFavView ? '点击书籍封面左上角的星星 ★ 即可加入收藏' : (isCustomList ? '点击右上角「+」或在图书卡片上点击 📑 即可加入此书单' : '拖拽电子书到此处，或点击右上角「+」导入')

            this.dom.booksGrid.innerHTML = `
                <div class="jane-empty-state" style="grid-column: 1 / -1;">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">${emptyIcon}</div>
                    <h3>${emptyTitle}</h3>
                    <p>${emptySub}</p>
                </div>
            `
            return
        }

        const gridFragment = document.createDocumentFragment()
        books.forEach(book => {
            const card = this.createBookCard(book)

            card.querySelector('.grid-fav-btn')?.addEventListener('click', async e => {
                e.stopPropagation()
                const isFav = await db.toggleBookFavorite(book.id)
                book.isFavorite = isFav
                const btn = card.querySelector('.grid-fav-btn')
                if (btn) {
                    btn.className = `grid-fav-btn ${isFav ? 'active' : ''}`
                    btn.title = isFav ? '取消收藏' : '加入收藏'
                }
                const coverBox = card.querySelector('.jane-cover-box')
                if (coverBox) {
                    if (isFav) coverBox.classList.add('is-favorite')
                    else coverBox.classList.remove('is-favorite')
                }
                this.showToast(isFav ? `⭐ 已将《${book.title}》加入收藏` : `已取消《${book.title}》收藏`, '⭐')
                if (this.shelfCategory === 'favorite') {
                    this.refreshBookshelf()
                }
            })

            card.querySelector('.grid-list-btn')?.addEventListener('click', e => {
                e.stopPropagation()
                this.openManageBookListsModal(book.id)
            })

            card.querySelector('.grid-delete-btn')?.addEventListener('click', e => {
                e.stopPropagation()
                this.handleDeleteBook(book)
            })

            card.addEventListener('click', () => this.openBook(book.id))
            gridFragment.appendChild(card)
        })
        this.dom.booksGrid.appendChild(gridFragment)
    }

    renderBooksTable(books) {
        this.dom.booksTableBody.innerHTML = ''

        if (books.length === 0) {
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory.startsWith('list_')
            let emptyMsg = isFavView ? '暂无收藏图书，点击图书 ★ 按钮即可加入收藏' : (isCustomList ? '此书单暂无图书，点击右上角「+」即可添加图书' : '暂无符合条件的图书')
            this.dom.booksTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-tertiary);">${emptyMsg}</td></tr>`
            return
        }

        const tableFragment = document.createDocumentFragment()
        books.forEach(book => {
            const row = document.createElement('tr')
            row.className = 'jane-table-row'
            row.dataset.id = book.id

            const fraction = book.progress?.fraction || 0
            const progressPct = (fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 2 : (fraction % 1 === 0 ? 0 : 2))
            const sizeStr = formatFileSize(book.size)
            const dateStr = book.addedAt ? new Date(book.addedAt).toLocaleDateString('zh-CN') : '-'

            row.innerHTML = `
                <td class="jane-table-cell" style="width: 40px; text-align: center;">
                    <button class="table-fav-btn ${book.isFavorite ? 'active' : ''}" title="${book.isFavorite ? '取消收藏' : '加入收藏'}" style="background: none; border: none; font-size: 1.1rem; cursor: pointer; color: ${book.isFavorite ? '#f59e0b' : 'var(--text-tertiary)'};">★</button>
                </td>
                <td class="jane-table-cell font-medium" style="font-weight: 600;">${escapeHTML(book.title)}</td>
                <td class="jane-table-cell text-muted">${escapeHTML(book.author || '未知作者')}</td>
                <td class="jane-table-cell text-muted">${(book.format || 'epub').toUpperCase()} · ${sizeStr}</td>
                <td class="jane-table-cell text-muted">${progressPct}%</td>
                <td class="jane-table-cell text-muted">${dateStr}</td>
                <td class="jane-table-cell" style="text-align: center; white-space: nowrap;">
                    <button class="table-list-btn" title="加入与管理书单" style="color: var(--accent-purple); border: 1px solid rgba(139,92,246,0.25); background: rgba(139,92,246,0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px;">📑 书单</button>
                    <button class="table-delete-btn" title="从书架删除" style="color: #ef4444; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;">删除</button>
                </td>
            `

            row.querySelector('.table-fav-btn')?.addEventListener('click', async e => {
                e.stopPropagation()
                const isFav = await db.toggleBookFavorite(book.id)
                book.isFavorite = isFav
                const btn = row.querySelector('.table-fav-btn')
                if (btn) {
                    btn.className = `table-fav-btn ${isFav ? 'active' : ''}`
                    btn.style.color = isFav ? '#f59e0b' : 'var(--text-tertiary)'
                    btn.title = isFav ? '取消收藏' : '加入收藏'
                }
                this.showToast(isFav ? `⭐ 已将《${book.title}》加入收藏` : `已取消《${book.title}》收藏`, '⭐')
                if (this.shelfCategory === 'favorite') {
                    this.refreshBookshelf()
                }
            })

            row.querySelector('.table-list-btn')?.addEventListener('click', e => {
                e.stopPropagation()
                this.openManageBookListsModal(book.id)
            })

            row.querySelector('.table-delete-btn')?.addEventListener('click', e => {
                e.stopPropagation()
                this.handleDeleteBook(book)
            })

            row.addEventListener('click', () => this.openBook(book.id))
            tableFragment.appendChild(row)
        })
        this.dom.booksTableBody.appendChild(tableFragment)
    }

    async handleDeleteBook(book) {
        if (!book || !book.id) return
        if (!confirm(`确定要从书架中删除《${book.title}》吗？`)) return
        try {
            await db.deleteBook(book.id)
            coverUrlPool.revoke(book.id)
            this.showToast(`已从书架删除《${book.title}》`, '🗑️')
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
        } catch (err) {
            console.error('Delete book error:', err)
            this.showToast(`删除失败: ${err.message}`, '⚠️')
            await this.refreshBookshelf()
        }
    }

    // ==========================================================
    // Custom Reading Lists Management
    // ==========================================================

    async renderCustomListsSidebar() {
        if (!this.dom.customListsContainer) return
        this.customLists = await db.getAllCustomLists()
        const allBooks = await db.getAllBooks()

        this.dom.customListsContainer.innerHTML = ''
        this.customLists.forEach(list => {
            let count = 0
            if (list.id === 'list_unread') {
                count = allBooks.filter(b => b.customListIds?.includes('list_unread') || (!b.progress?.fraction || b.progress.fraction === 0)).length
            } else {
                count = allBooks.filter(b => b.customListIds && b.customListIds.includes(list.id)).length
            }

            const item = document.createElement('button')
            item.className = `custom-list-nav-item ${this.shelfCategory === list.id ? 'active' : ''}`
            item.dataset.listId = list.id
            item.title = list.name

            const iconSpan = document.createElement('span')
            iconSpan.className = 'list-icon'
            iconSpan.textContent = list.icon || '📑'

            const titleSpan = document.createElement('span')
            titleSpan.className = 'list-title'
            titleSpan.textContent = list.name

            const badgeSpan = document.createElement('span')
            badgeSpan.className = `list-count-badge ${!list.isBuiltIn ? 'has-del' : ''}`
            badgeSpan.textContent = String(count)

            item.appendChild(iconSpan)
            item.appendChild(titleSpan)
            item.appendChild(badgeSpan)

            if (!list.isBuiltIn) {
                const delSpan = document.createElement('span')
                delSpan.className = 'list-del-btn'
                delSpan.title = '删除书单'
                delSpan.textContent = '✕'
                item.appendChild(delSpan)
            }

            item.addEventListener('click', e => {
                if (e.target.classList.contains('list-del-btn')) {
                    e.stopPropagation()
                    this.handleDeleteCustomList(list)
                    return
                }

                // Deselect built-in library items
                this.dom.navCategoryItems?.forEach(i => i.classList.remove('active'))
                document.querySelectorAll('.custom-list-nav-item').forEach(i => i.classList.remove('active'))
                item.classList.add('active')

                this.shelfCategory = list.id
                if (this.dom.currentCategoryTitle) {
                    this.dom.currentCategoryTitle.innerText = `${list.icon || '📑'} ${list.name}`
                }

                if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
                if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
                if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'
                this.refreshBookshelf()
            })

            this.dom.customListsContainer.appendChild(item)
        })
    }

    async handleDeleteCustomList(list) {
        if (!confirm(`确定要删除书单「${list.name}」吗？\n（书单内的图书不会被删除，仅移除该分类）`)) return
        await db.deleteCustomList(list.id)
        this.showToast(`已删除书单「${list.name}」`, '🗑️')
        if (this.shelfCategory === list.id) {
            this.shelfCategory = 'all'
            document.getElementById('nav-cat-all')?.classList.add('active')
            if (this.dom.currentCategoryTitle) this.dom.currentCategoryTitle.innerText = '全部图书'
        }
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    openCreateListModal() {
        if (!this.dom.modalCreateList) return
        if (this.dom.inputCustomListName) {
            this.dom.inputCustomListName.value = ''
        }
        this.selectedListIcon = '📌'
        this.renderIconPicker()
        this.dom.modalCreateList.style.display = 'flex'
        requestAnimationFrame(() => {
            this.dom.modalCreateList?.classList.add('show')
            this.dom.inputCustomListName?.focus()
        })
    }

    closeCreateListModal() {
        if (this.dom.modalCreateList) {
            this.dom.modalCreateList.classList.remove('show')
            setTimeout(() => {
                this.dom.modalCreateList.style.display = 'none'
            }, 180)
        }
    }

    renderIconPicker() {
        if (!this.dom.customListIconPicker) return
        this.dom.customListIconPicker.innerHTML = ''
        this.icons.forEach(ic => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = `icon-pick-btn ${this.selectedListIcon === ic ? 'active' : ''}`
            btn.innerText = ic
            btn.addEventListener('click', () => {
                this.selectedListIcon = ic
                this.dom.customListIconPicker.querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
            })
            this.dom.customListIconPicker.appendChild(btn)
        })
    }

    async handleCreateListConfirm() {
        const name = this.dom.inputCustomListName?.value.trim()
        if (!name) {
            this.showToast('请输入书单名称', '⚠️')
            this.dom.inputCustomListName?.focus()
            return
        }
        const newList = {
            id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name,
            icon: this.selectedListIcon || '📑',
            isBuiltIn: false,
            createdAt: Date.now()
        }
        await db.saveCustomList(newList)
        this.closeCreateListModal()
        this.showToast(`✨ 书单「${name}」创建成功！`, '📑')
        
        // Auto-switch to newly created list
        this.shelfCategory = newList.id
        this.dom.navCategoryItems?.forEach(i => i.classList.remove('active'))
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = `${newList.icon} ${newList.name}`
        }
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    async openManageBookListsModal(bookId) {
        this.managingBookId = bookId
        const book = await db.getBook(bookId)
        if (!book) return

        if (this.dom.manageBookTargetTitle) {
            this.dom.manageBookTargetTitle.innerText = `《${book.title}》`
        }

        this.customLists = await db.getAllCustomLists()
        const currentListIds = book.customListIds || []

        if (this.dom.bookListsCheckboxContainer) {
            this.dom.bookListsCheckboxContainer.innerHTML = ''
            this.customLists.forEach(list => {
                const isChecked = currentListIds.includes(list.id)
                const row = document.createElement('label')
                row.className = 'book-list-check-row'

                const input = document.createElement('input')
                input.type = 'checkbox'
                input.dataset.listId = list.id
                input.checked = isChecked

                const iconSpan = document.createElement('span')
                iconSpan.style.fontSize = '1.1rem'
                iconSpan.textContent = list.icon || '📑'

                const nameSpan = document.createElement('span')
                nameSpan.style.cssText = 'flex: 1; font-size: 0.88rem; font-weight: 500; color: var(--text-main);'
                nameSpan.textContent = list.name

                row.appendChild(input)
                row.appendChild(iconSpan)
                row.appendChild(nameSpan)
                this.dom.bookListsCheckboxContainer.appendChild(row)
            })
        }

        if (this.dom.modalManageBookLists) {
            this.dom.modalManageBookLists.style.display = 'flex'
            requestAnimationFrame(() => {
                this.dom.modalManageBookLists?.classList.add('show')
            })
        }
    }

    closeManageBookListsModal() {
        if (this.dom.modalManageBookLists) {
            this.dom.modalManageBookLists.classList.remove('show')
            setTimeout(() => {
                this.dom.modalManageBookLists.style.display = 'none'
            }, 180)
        }
        this.managingBookId = null
    }

    async handleSaveBookLists() {
        if (!this.managingBookId) return
        const checked = []
        this.dom.bookListsCheckboxContainer?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            if (cb.dataset.listId) checked.push(cb.dataset.listId)
        })

        await db.setBookLists(this.managingBookId, checked)
        const book = await db.getBook(this.managingBookId)
        this.closeManageBookListsModal()
        this.showToast(`已更新《${book?.title || '图书'}》所属书单`, '✅')
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    async openBatchAddToListModal() {
        if (!this.shelfCategory.startsWith('list_')) return
        const listId = this.shelfCategory
        const currentList = this.customLists.find(l => l.id === listId)
        if (!currentList) return

        if (this.dom.batchAddListModalTitle) {
            this.dom.batchAddListModalTitle.innerText = `${currentList.icon} 添加图书到「${currentList.name}」`
        }

        const allBooks = await db.getAllBooks()
        if (this.dom.batchAddBooksContainer) {
            this.dom.batchAddBooksContainer.innerHTML = ''
            allBooks.forEach(b => {
                const inList = b.customListIds && b.customListIds.includes(listId)
                const row = document.createElement('label')
                row.className = 'book-list-check-row'
                row.innerHTML = `
                    <input type="checkbox" data-book-id="${b.id}" ${inList ? 'checked' : ''} />
                    <span style="flex: 1; font-size: 0.88rem; font-weight: 500; color: var(--text-main);">${escapeHTML(b.title)}</span>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHTML(b.author || '')}</span>
                `
                this.dom.batchAddBooksContainer.appendChild(row)
            })
        }

        if (this.dom.modalBatchAddToList) {
            this.dom.modalBatchAddToList.style.display = 'flex'
            requestAnimationFrame(() => {
                this.dom.modalBatchAddToList?.classList.add('show')
            })
        }
    }

    closeBatchAddToListModal() {
        if (this.dom.modalBatchAddToList) {
            this.dom.modalBatchAddToList.classList.remove('show')
            setTimeout(() => {
                this.dom.modalBatchAddToList.style.display = 'none'
            }, 180)
        }
    }

    async handleConfirmBatchAddList() {
        if (!this.shelfCategory.startsWith('list_')) return
        const listId = this.shelfCategory
        const checkedBookIds = new Set()
        this.dom.batchAddBooksContainer?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            if (cb.dataset.bookId) checkedBookIds.add(cb.dataset.bookId)
        })

        const allBooks = await db.getAllBooks()
        for (const b of allBooks) {
            if (!b.customListIds) b.customListIds = []
            const isChecked = checkedBookIds.has(b.id)
            const wasInList = b.customListIds.includes(listId)

            if (isChecked && !wasInList) {
                b.customListIds.push(listId)
                await db.saveBook(b)
            } else if (!isChecked && wasInList) {
                b.customListIds = b.customListIds.filter(id => id !== listId)
                await db.saveBook(b)
            }
        }

        this.closeBatchAddToListModal()
        this.showToast('书单图书列表已更新！', '📑')
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    // ==========================================
    // Reader Logic
    // ==========================================
    async openBook(bookId) {
        const bookData = await db.getBook(bookId)
        if (!bookData) return this.showToast('找不到该书籍！', '⚠️')

        if (this.dom.welcomeModalBackdrop) {
            this.dom.welcomeModalBackdrop.style.display = 'none'
        }

        this._currentBookEpoch = (this._currentBookEpoch || 0) + 1
        const currentEpoch = this._currentBookEpoch

        this.currentBookId = bookId
        this.currentBookData = bookData
        this.currentLocation = null

        // Switch View
        this.dom.bookshelfView.style.display = 'none'
        this.dom.readerView.classList.add('active')
        this.dom.readerBookTitle.innerText = bookData.title

        // Create or Reset Foliate View
        if (this.foliateView) {
            this.foliateView.close?.()
            this.foliateView.remove()
        }

        this.foliateView = document.createElement('foliate-view')
        this.dom.readerContentArea.appendChild(this.foliateView)

        // Pre-register ALL Events BEFORE calling open / init so the initial section load event is never missed!
        this.foliateView.addEventListener('relocate', e => {
            if (this._currentBookEpoch === currentEpoch) {
                this.onReaderRelocate(e.detail)
            }
        })
        this.foliateView.addEventListener('load', e => {
            if (this._currentBookEpoch === currentEpoch) {
                this.onSectionLoaded(e.detail)
            }
        })

        // Intercept Footnote / Anchor links so Foliate doesn't jump to hidden footnote elements
        this.foliateView.addEventListener('link', async e => {
            if (this._currentBookEpoch !== currentEpoch) return
            const { a, href, href_ } = e.detail || {}
            const targetHref = href_ || href || ''
            
            // 1. Handle external web links safely without hijacking reader iframe
            if (targetHref.startsWith('http://') || targetHref.startsWith('https://') || targetHref.startsWith('mailto:')) {
                e.preventDefault()
                try {
                    window.open(targetHref, '_blank')
                } catch (openErr) {
                    console.warn('Failed to open external link:', targetHref, openErr)
                }
                return
            }

            // 2. Check for Footnote / Annotation popups
            const isSup = a?.closest('sup')
            const isNoteref = a?.getAttribute('epub:type') === 'noteref' ||
                              a?.getAttribute('role') === 'doc-noteref' ||
                              a?.classList?.contains('epub-footnote') ||
                              a?.classList?.contains('footnote-ref') ||
                              (isSup && /(?:foot)?note|fn|ref/i.test(targetHref))

            if (isNoteref) {
                const targetId = targetHref.includes('#') ? targetHref.split('#')[1] : null
                const doc = a?.ownerDocument
                let targetEl = targetId && doc ? doc.getElementById(targetId) : null
                
                let footnoteText = targetEl ? (targetEl.textContent || targetEl.innerText || '').trim() : ''
                if (!footnoteText && a) {
                    const img = a.querySelector('img')
                    footnoteText = (img?.getAttribute('alt') || a.getAttribute('title') || '').trim()
                }

                // ONLY intercept if valid popup footnote text was actually found in the current doc!
                if (footnoteText) {
                    e.preventDefault()
                    const rect = a.getBoundingClientRect()
                    const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
                    const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                    
                    this.showFootnotePopup({
                        title: '💡 译注与说明',
                        text: footnoteText,
                        rect: {
                            top: rect.top + iframeRect.top,
                            left: rect.left + iframeRect.left,
                            width: rect.width,
                            height: rect.height
                        }
                    })
                    return
                }
            }
            // Normal navigation (TOC links, cross-chapter jumps) will proceed via Foliate goTo!
        })

        // Overlayer Annotation Rendering
        this.foliateView.addEventListener('draw-annotation', e => {
            if (this._currentBookEpoch !== currentEpoch) return
            const { draw, annotation } = e.detail
            const { color = '#facc15', style = 'highlight' } = annotation
            if (style === 'underline') {
                draw(Overlayer.underline, { color, width: 2.6 })
            } else if (style === 'dashed') {
                draw(Overlayer.dashed, { color: color === '#facc15' ? '#64748b' : color, width: 2 })
            } else if (style === 'squiggly') {
                draw(Overlayer.squiggly, { color, width: 2.2 })
            } else if (style === 'strikethrough') {
                draw(Overlayer.strikethrough, { color, width: 2.5 })
            } else {
                draw(Overlayer.highlight, { color, realisticPen: this.settings.realisticPen !== false })
            }
        })

        // When new section overlay is mounted, draw all saved highlights!
        this.foliateView.addEventListener('create-overlay', async () => {
            if (this.currentBookId && this._currentBookEpoch === currentEpoch) {
                const highlights = await db.getHighlightsByBook(this.currentBookId)
                if (this._currentBookEpoch !== currentEpoch) return
                for (const hl of highlights) {
                    try {
                        await this.foliateView.addAnnotation({
                            value: `${hl.cfi}::${hl.style || 'highlight'}`,
                            id: hl.id,
                            color: hl.color,
                            style: hl.style || 'highlight'
                        })
                    } catch (err) {
                        // Section index mismatch handled internally by foliate-js
                    }
                }
            }
        })

        // Clicked an existing highlight on the page!
        this.foliateView.addEventListener('show-annotation', e => {
            if (this._currentBookEpoch !== currentEpoch) return
            const { value, range } = e.detail
            this.onHighlightClicked(value, range)
        })

        try {
            const fileBlob = await db.getBookFileBlob(bookId)
            const targetBlob = fileBlob || bookData.blob
            if (!targetBlob) {
                this.showToast('无法读取书籍文件数据', '⚠️')
                return this.closeReader()
            }
            await this.foliateView.open(targetBlob)
            if (this._currentBookEpoch !== currentEpoch) return
            
            // Set initial styles & flow
            this.applySettingsToReader()

            // Restore location
            const lastLoc = bookData.progress?.cfi || bookData.progress?.fraction || 0
            await this.foliateView.init({ lastLocation: lastLoc })
            if (this._currentBookEpoch !== currentEpoch) return

            // Ensure any already-loaded content doc is initialized
            const contents = this.foliateView.renderer?.getContents?.() || []
            for (const item of contents) {
                if (item?.doc) this.onSectionLoaded(item)
            }

            // Start Reading Session & Timer
            const startFrac = bookData.progress?.fraction || 0
            tracker.startSession(bookId, bookData.title, startFrac)
            tracker.onTickCallback = ({ seconds, isIdle }) => {
                if (this.dom.readerLiveTimer && this._currentBookEpoch === currentEpoch) {
                    const timeText = seconds < 60 ? '< 1分钟' : `${Math.floor(seconds / 60)}分钟`
                    this.dom.readerLiveTimer.innerText = isIdle ? `⏱️ 暂停中 (${timeText})` : `⏱️ ${timeText}`
                }
            }

            // Manage PDF Floating Zoom Bar visibility
            if (this.foliateView.isFixedLayout || bookData.format === 'pdf') {
                if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'flex'
                this.setPDFZoom('fit-page')
            } else {
                if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'none'
            }

            // Defer non-critical TOC and notes population so first page paints with zero delay
            setTimeout(() => {
                if (this.currentBookId === bookId && this._currentBookEpoch === currentEpoch && this.foliateView) {
                    this.renderTOC(this.foliateView.book?.toc || [])
                    this.loadNotesList()
                }
            }, 20)

        } catch (err) {
            if (this._currentBookEpoch === currentEpoch) {
                console.error('Failed to open book in foliate-view:', err)
                this.showToast(`打开书籍失败: ${err.message}`, '⚠️')
                this.closeReader()
            }
        }
    }

    async closeReader() {
        // Immediately flush any pending progress debounce save before closing
        if (this._progressDebounceTimer) {
            clearTimeout(this._progressDebounceTimer)
            this._progressDebounceTimer = null
        }
        if (this.currentBookId && this.currentLocation) {
            try {
                await db.updateBookProgress(this.currentBookId, {
                    fraction: this.currentLocation.fraction || 0,
                    cfi: this.currentLocation.cfi,
                    tocItem: this.currentLocation.tocItem ? { label: this.currentLocation.tocItem.label, href: this.currentLocation.tocItem.href } : null
                })
            } catch (err) {
                console.warn('Failed to flush final book progress:', err)
            }
        }

        if (this.currentLocation?.fraction != null) {
            await tracker.endSession(this.currentLocation.fraction)
        } else {
            await tracker.endSession()
        }

        if (this.dom.pdfZoomBar) {
            this.dom.pdfZoomBar.style.display = 'none'
        }

        if (this.foliateView) {
            this.foliateView.close?.()
            this.foliateView.remove()
            this.foliateView = null
        }
        // tts removed
        this.clearSearchState(true)
        this.closeDrawer()
        this.hideSelectionPopup()
        this.hideHighlightActionPopup()
        this.dom.readerView.classList.remove('active')
        this.dom.bookshelfView.style.display = 'flex'
        this.currentBookId = null
        this.currentBookData = null
        this.currentLocation = null
        this.refreshBookshelf()

        if (this.syncConfig?.enabled && this.syncConfig?.autoSyncOnBookClose) {
            this.triggerSilentBackgroundSync()
        }
    }

    onReaderRelocate(detail) {
        if (!this.currentBookId) return
        const activeBookId = this.currentBookId
        const activeEpoch = this._currentBookEpoch

        tracker.resetActivity()
        tracker.recordPageTurn()
        this.currentLocation = detail
        const fraction = detail.fraction || 0
        const pct = Math.round(fraction * 100)
        this.dom.progressSlider.value = pct
        this.dom.progressText.innerText = `${pct}%`

        // Smart Estimated Time Left (ETA) using Adaptive Dual-State Time Window Engine
        if (this.dom.readerEtaBadge) {
            if (fraction >= 0.99) {
                this.dom.readerEtaBadge.innerText = '🎉 即将读完'
            } else if (fraction <= 0.005) {
                this.dom.readerEtaBadge.innerText = '预计还需 --'
            } else {
                const totalPages = detail.totalPages || (detail.location?.total > 0 ? detail.location.total : null)
                const currentPage = detail.page || (detail.location?.current != null ? detail.location.current + 1 : null)
                let remainingSecs = 0
                const paceSecs = tracker.getCurrentPaceSecs()
                
                if (totalPages && currentPage && totalPages > currentPage) {
                    const remainingPages = totalPages - currentPage
                    remainingSecs = remainingPages * paceSecs
                } else {
                    const totalActiveSecs = (this.currentBookData?.totalReadingSeconds || 0) + (tracker.sessionCumulativeSeconds || 0)
                    if (totalActiveSecs >= 90 && fraction > 0.01) {
                        const rawRemaining = (totalActiveSecs / fraction) * (1 - fraction)
                        remainingSecs = Math.min(86400, Math.max(60, Math.round(rawRemaining)))
                    } else {
                        const estimatedTotalScreens = Math.max(20, Math.round(1 / Math.max(0.005, fraction || 0.01)))
                        remainingSecs = Math.round((1 - fraction) * Math.min(250, estimatedTotalScreens) * paceSecs)
                    }
                }
                this.dom.readerEtaBadge.innerText = `预计还需 ${tracker.formatDuration(remainingSecs)}`
            }
        }

        // PDF Page Index Tracking and Overlay Mount
        const isPdfMode = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
        if (isPdfMode) {
            this.currentPdfPageIndex = detail.page || (detail.location?.current != null ? detail.location.current + 1 : 1)
            setTimeout(() => {
                if (this.currentBookId === activeBookId && this._currentBookEpoch === activeEpoch) {
                    this.renderPdfDrawingOverlayForCurrentPage()
                }
            }, 100)
        }

        // Page Number Indicator
        if (this.dom.readerPageNumber) {
            if (detail.page != null && detail.totalPages != null) {
                this.dom.readerPageNumber.innerText = `${detail.page} / ${detail.totalPages} 页`
            } else if (detail.location?.total > 0) {
                this.dom.readerPageNumber.innerText = `第 ${detail.location.current + 1} / ${detail.location.total} 页`
            } else {
                this.dom.readerPageNumber.innerText = `${pct}%`
            }
        }

        // Update active TOC item
        if (detail.tocItem) {
            this.highlightActiveTOCItem(detail.tocItem.href)
        }

        // Save progress to IndexedDB with debounce
        clearTimeout(this._progressDebounceTimer)
        this._progressDebounceTimer = setTimeout(() => {
            if (this.currentBookId === activeBookId && this._currentBookEpoch === activeEpoch) {
                db.updateBookProgress(activeBookId, {
                    fraction: fraction,
                    cfi: detail.cfi,
                    tocItem: detail.tocItem ? { label: detail.tocItem.label, href: detail.tocItem.href } : null
                }).catch(err => console.warn('Failed to update book progress:', err))
            }
        }, 500)
    }

    toggleReaderUI(forceState) {
        if (forceState === true) {
            this.dom.readerTopBar?.classList.remove('autohide')
            this.dom.readerBottomBar?.classList.remove('autohide')
            this.dom.pdfZoomBar?.classList.remove('autohide')
        } else if (forceState === false) {
            this.dom.readerTopBar?.classList.add('autohide')
            this.dom.readerBottomBar?.classList.add('autohide')
            this.dom.pdfZoomBar?.classList.add('autohide')
        } else {
            this.dom.readerTopBar?.classList.toggle('autohide')
            this.dom.readerBottomBar?.classList.toggle('autohide')
            this.dom.pdfZoomBar?.classList.toggle('autohide')
        }
    }

    normalizeEpubDocument(doc) {
        if (!doc || !doc.body) return
        const win = doc.defaultView || window

        try {
            // 1. Safe Non-Destructive Hiding of Calibre Dummy Page Breaks & Ghost Elements
            // (Preserve element IDs for TOC / CFI / Footnote jumping, but eliminate all visual footprint)
            const calibrePbs = doc.querySelectorAll('[id*="calibre_pb" i], [class*="calibre_pb" i], .calibre_pb')
            calibrePbs.forEach(el => {
                el.dataset.readerHidden = 'true'
                el.style.setProperty('display', 'none', 'important')
                el.style.setProperty('height', '0', 'important')
                el.style.setProperty('min-height', '0', 'important')
                el.style.setProperty('max-height', '0', 'important')
                el.style.setProperty('margin', '0', 'important')
                el.style.setProperty('padding', '0', 'important')
                el.style.setProperty('font-size', '0', 'important')
                el.style.setProperty('line-height', '0', 'important')
                el.style.setProperty('border', 'none', 'important')
            })

            // Safely collapse trailing ghost empty spacer paragraphs at the bottom of the section
            const allBlocks = Array.from(doc.querySelectorAll('p, div'))
            for (let i = allBlocks.length - 1; i >= 0; i--) {
                const el = allBlocks[i]
                if (!el.isConnected) continue
                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, audio, canvas, table, iframe')
                if (!rawText && !hasMedia && el.children.length <= 1) {
                    if (el === doc.body.lastElementChild || (el.parentElement === doc.body && !el.nextElementSibling)) {
                        el.dataset.readerHidden = 'true'
                        el.style.setProperty('display', 'none', 'important')
                        el.style.setProperty('height', '0', 'important')
                        el.style.setProperty('margin', '0', 'important')
                        el.style.setProperty('padding', '0', 'important')
                    }
                } else {
                    if (el.parentElement === doc.body) break
                }
            }

            // 2. Deep Heading & Chapter Title Recognition
            const chapterPattern = /^(?:第[一二三四五六七八九十百千0-9\s]+[章节回部篇卷折幕集期讲]|chapter\s+\d+|section\s+\d+|prologue|epilogue|引言|序言|楔子|尾声|结语|后记|前言)\b/i

            const candidateList = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="heading" i], [class*="chapter" i], .contenttitle, .contenttitle1, .contenttitle2, .chaptertitle, .sequencetitle, [id^="toc_" i], [id^="chap" i]'))

            // Also scan short standalone paragraphs matching Chinese/English chapter patterns (like 《黑暗托马》)
            const allP = doc.querySelectorAll('p, div')
            allP.forEach(p => {
                if (!candidateList.includes(p)) {
                    const txt = (p.textContent || '').trim()
                    if (txt.length >= 2 && txt.length <= 40 && chapterPattern.test(txt)) {
                        candidateList.push(p)
                    }
                }
            })

            let isFirstHeadingFound = false

            candidateList.forEach(el => {
                if (el.classList.contains('titlepage') || el.closest('.titlepage')) return

                const rawHeadingText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, canvas')
                
                // Empty anchor headings (like <h1 id="a004"></h1> placed before full-page SVG illustrations in 砂女)
                if (!rawHeadingText && !hasMedia) {
                    el.dataset.readerHidden = 'true'
                    el.style.setProperty('display', 'none', 'important')
                    el.style.setProperty('height', '0', 'important')
                    el.style.setProperty('min-height', '0', 'important')
                    el.style.setProperty('max-height', '0', 'important')
                    el.style.setProperty('margin', '0', 'important')
                    el.style.setProperty('padding', '0', 'important')
                    el.style.setProperty('font-size', '0', 'important')
                    el.style.setProperty('line-height', '0', 'important')
                    el.style.setProperty('border', 'none', 'important')
                    return
                }

                el.dataset.readerHeading = 'true'
                const isChapter = chapterPattern.test(rawHeadingText) || /chapter|chap/i.test(el.id || el.className)
                if (isChapter) {
                    el.dataset.chapterHeading = 'true'
                }

                if (isFirstHeadingFound) {
                    el.dataset.sectionHeading = 'true'
                    return
                }

                // Check if this heading has substantive visible content before it
                let hasVisibleContentBefore = false
                let current = el
                while (current && current !== doc.body) {
                    let prev = current.previousElementSibling
                    while (prev) {
                        const cleanText = (prev.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                        const hasMedia = prev.querySelector('img, svg, picture, video, canvas, table')
                        if ((cleanText.length > 0 || hasMedia) && !prev.dataset.readerHidden) {
                            hasVisibleContentBefore = true
                            break
                        }
                        prev = prev.previousElementSibling
                    }
                    if (hasVisibleContentBefore) break
                    current = current.parentElement
                }

                if (!hasVisibleContentBefore) {
                    el.dataset.firstHeading = 'true'
                    isFirstHeadingFound = true
                } else {
                    el.dataset.sectionHeading = 'true'
                }
            })

            // 3. Computed Style Penetration & Semantic Tagging (Solves InDesign/Calibre hashed classes)
            const allParagraphs = doc.querySelectorAll('p, div, blockquote, h1, h2, h3, h4, h5, h6, span, section, article')
            allParagraphs.forEach(el => {
                // Mark media containers
                if (el.querySelector('img, svg, picture, video, canvas')) {
                    el.dataset.hasMedia = 'true'
                    return
                }

                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                if (!rawText && !el.dataset.readerHidden) {
                    el.dataset.emptyLine = 'true'
                    return
                }

                // Penetrate real computed style via getComputedStyle
                try {
                    const style = win.getComputedStyle(el)
                    const textAlign = style?.textAlign
                    const alignAttr = (el.getAttribute('align') || '').toLowerCase()
                    const className = (el.className || '').toLowerCase()

                    if (textAlign === 'center' || alignAttr === 'center' || /center/i.test(className)) {
                        el.dataset.align = 'center'
                    } else if (textAlign === 'right' || alignAttr === 'right' || /right|sequence/i.test(className)) {
                        el.dataset.align = 'right'
                    }
                } catch (styleErr) {
                    // Fallback to attribute / class heuristics if window context is detached
                    const alignAttr = (el.getAttribute('align') || '').toLowerCase()
                    const inlineAlign = (el.style?.textAlign || '').toLowerCase()
                    if (alignAttr === 'center' || inlineAlign === 'center') el.dataset.align = 'center'
                    else if (alignAttr === 'right' || inlineAlign === 'right') el.dataset.align = 'right'
                }

                // Poetry line detection (short verse lines in poem collections)
                const className = (el.className || '').toLowerCase()
                if (className.includes('copyright') || className.includes('poetry') || className.includes('verse') || className.includes('poem')) {
                    const txt = (el.textContent || '').trim()
                    if (txt.length < 35 && !txt.endsWith('。') && !txt.endsWith('”') && !txt.endsWith('；')) {
                        el.dataset.poetryLine = 'true'
                    }
                }
            })
        } catch (e) {
            console.warn('[DOM Normalizer] Warning:', e)
        }
    }

    onSectionLoaded({ doc, index }) {
        if (!doc || doc._readerInitDone) return
        doc._readerInitDone = true

        // Industrial-grade DOM Normalization (Prune ghost pagebreaks, format headings, normalize poetry)
        this.normalizeEpubDocument(doc)

        // Throttled activity heartbeat on reading doc (mousemove, scroll, selection, keydown)
        let lastActReset = 0
        const triggerActReset = () => {
            const now = Date.now()
            if (now - lastActReset > 3000) {
                lastActReset = now
                tracker.resetActivity()
            }
        }
        ;['mousemove', 'scroll', 'pointerdown', 'selectionchange', 'keydown'].forEach(evt => {
            doc.addEventListener(evt, triggerActReset, { passive: true })
        })

        // Fullscreen edge proximity listener inside iframe document
        doc.addEventListener('mousemove', e => {
            if (this._handleFullscreenProximity) {
                const iframe = this.foliateView?.renderer?.querySelector?.('iframe') || document.querySelector('iframe')
                const iframeRect = iframe?.getBoundingClientRect?.() || { top: 0, left: 0 }
                this._handleFullscreenProximity((e.clientY || 0) + iframeRect.top)
            }
        }, { passive: true })

        // Chinese Quotes Transformation (Jane Reader feature)
        if (this.settings.chineseQuotes && doc.body) {
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
            let n = walker.nextNode()
            while (n) {
                if (n.nodeValue && /["'“”‘’]/.test(n.nodeValue)) {
                    n.nodeValue = n.nodeValue
                        .replace(/“/g, '「').replace(/”/g, '」')
                        .replace(/‘/g, '『').replace(/’/g, '』')
                }
                n = walker.nextNode()
            }
        }

        let selectionTimeout = null
        let isCtrlActive = false

        const iframeKeyHandler = e => {
            if (e.key === 'Control' || e.key === 'Meta') isCtrlActive = true
            if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'h', 'H', 'l', 'L', 'j', 'J', 'k', 'K', ' ', 'Enter'].includes(e.key)) {
                e.preventDefault()
                e.stopPropagation()
            }
            this.handleGlobalKeydown(e)
        }
        doc.addEventListener('keydown', iframeKeyHandler, true)
        if (doc.defaultView) {
            doc.defaultView.addEventListener('keydown', iframeKeyHandler, true)
        }
        doc.addEventListener('keyup', e => {
            if (e.key === 'Control' || e.key === 'Meta') isCtrlActive = false
        })
        doc.addEventListener('pointerdown', e => {
            if (!e.ctrlKey && !e.metaKey && !isCtrlActive) {
                const sel = doc.getSelection()
                if (sel && sel.isCollapsed) {
                    this.clearVirtualMultiSelections()
                    this.multiSelectedRanges = []
                    if (this.dom.popupMultiBadge) this.dom.popupMultiBadge.style.display = 'none'
                }
            }
        })

        const checkSelection = (evt) => {
            const sel = doc.getSelection()
            if (!sel || sel.isCollapsed) return
            const text = sel.toString().trim()
            if (!text) return

            try {
                const range = sel.getRangeAt(0)
                let rect = range.getBoundingClientRect()
                const clientRects = Array.from(range.getClientRects())
                if ((!rect || (rect.width === 0 && rect.height === 0)) && clientRects.length > 0) {
                    rect = clientRects[0]
                }
                
                const iframe = doc.defaultView?.frameElement || this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView
                const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                const scaleX = iframe.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                const scaleY = iframe.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                
                const absRect = {
                    top: iframeRect.top + ((rect?.top || 0) * scaleY),
                    left: iframeRect.left + ((rect?.left || 0) * scaleX),
                    width: (rect?.width || (clientRects.length > 0 ? clientRects[0].width : 100)) * scaleX,
                    height: (rect?.height || (clientRects.length > 0 ? clientRects[0].height : 24)) * scaleY
                }

                let cfi = null
                try {
                    cfi = this.foliateView.getCFI(index, range)
                } catch (cfiErr) {
                    console.warn('getCFI fallback on index:', index, cfiErr)
                }

                const currentItem = {
                    text,
                    range,
                    cfi,
                    index,
                    rect: absRect
                }

                const isCtrl = evt?.ctrlKey || evt?.metaKey || isCtrlActive
                if (isCtrl) {
                    if (!this.multiSelectedRanges) this.multiSelectedRanges = []
                    const exists = this.multiSelectedRanges.some(r => r.text === text && r.index === index)
                    if (!exists) {
                        this.multiSelectedRanges.push(currentItem)
                    }
                    this.renderVirtualMultiSelections()
                    if (this.dom.popupMultiBadge) {
                        this.dom.popupMultiBadge.style.display = 'inline-block'
                        this.dom.popupMultiBadge.innerText = `已选 ${this.multiSelectedRanges.length} 处`
                    }
                } else {
                    if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
                        this.clearVirtualMultiSelections()
                    }
                    this.multiSelectedRanges = [currentItem]
                    if (this.dom.popupMultiBadge) {
                        this.dom.popupMultiBadge.style.display = 'none'
                    }
                }

                this.selectedTextInfo = currentItem
                this.hideHighlightActionPopup()
                this.showSelectionPopup(absRect)
            } catch (err) {
                console.warn('checkSelection warning:', err)
            }
        }

        // Selection change listener inside iframe
        doc.addEventListener('selectionchange', (e) => {
            if (selectionTimeout) clearTimeout(selectionTimeout)
            selectionTimeout = setTimeout(() => {
                const sel = doc.getSelection()
                if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
                    if (!this.multiSelectedRanges || this.multiSelectedRanges.length <= 1) {
                        this.hideSelectionPopup()
                    }
                } else {
                    checkSelection(e)
                }
            }, 120)
        })

        // Pointer displacement tracking to prevent Drag-as-Click false positive
        let pointerStartX = 0
        let pointerStartY = 0
        let isDragGesture = false

        doc.addEventListener('pointerdown', e => {
            pointerStartX = e.clientX
            pointerStartY = e.clientY
            isDragGesture = false
        }, { passive: true })

        doc.addEventListener('pointermove', e => {
            if (Math.abs(e.clientX - pointerStartX) > 8 || Math.abs(e.clientY - pointerStartY) > 8) {
                isDragGesture = true
            }
        }, { passive: true })

        // Click on page: Intercept Footnotes, Center 50% toggles toolbars, left/right 25% flips pages
        doc.addEventListener('click', async e => {
            if (isDragGesture) {
                isDragGesture = false
                return
            }

            const a = e.target.closest('a[href]') || e.target.closest('a')
            if (a) {
                const href = a.getAttribute('href') || ''
                const isNoteref = a.getAttribute('epub:type') === 'noteref' || 
                                  a.getAttribute('role') === 'doc-noteref' || 
                                  href.startsWith('#footnote') || 
                                  href.startsWith('#note') ||
                                  href.includes('footnote') ||
                                  href.includes('note') ||
                                  a.classList.contains('epub-footnote') ||
                                  a.querySelector('img.epub-footnote') ||
                                  a.querySelector('img')

                if (isNoteref || (href.startsWith('#') && href.length > 1 && !href.includes('chapter') && !href.includes('cover'))) {
                    const targetId = href.startsWith('#') ? href.slice(1) : href.split('#')[1]
                    let targetEl = targetId ? doc.getElementById(targetId) : null
                    
                    // NOTE: display:none elements return empty string on innerText, MUST use textContent!
                    let footnoteText = targetEl ? (targetEl.textContent || targetEl.innerText || '').trim() : ''
                    
                    // Fallback to img alt or title or text
                    if (!footnoteText) {
                        const img = a.querySelector('img')
                        footnoteText = (img?.getAttribute('alt') || a.getAttribute('title') || '').trim()
                    }

                    // If still empty and link points to another file in book, resolve external section
                    if (!footnoteText && targetId && this.foliateView?.book?.resolveHref) {
                        try {
                            const resolved = this.foliateView.book.resolveHref(href)
                            if (resolved && resolved.index != null && resolved.index !== index) {
                                const targetSec = this.foliateView.book.sections[resolved.index]
                                const loaded = await targetSec?.load?.()
                                const secDoc = typeof loaded === 'string' ? new DOMParser().parseFromString(loaded, 'text/html') : (loaded?.doc || loaded)
                                if (secDoc && typeof secDoc.getElementById === 'function') {
                                    const extEl = secDoc.getElementById(targetId)
                                    if (extEl) footnoteText = (extEl.textContent || extEl.innerText || '').trim()
                                }
                            }
                        } catch (err) {
                            console.warn('External footnote lookup error:', err)
                        }
                    }
                    
                    if (footnoteText) {
                        e.preventDefault()
                        e.stopPropagation()
                        e.stopImmediatePropagation()
                        
                        const rect = a.getBoundingClientRect()
                        const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
                        const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                        
                        this.showFootnotePopup({
                            title: '💡 译注与说明',
                            text: footnoteText,
                            rect: {
                                top: rect.top + iframeRect.top,
                                left: rect.left + iframeRect.left,
                                width: rect.width,
                                height: rect.height
                            }
                        })
                        return
                    }
                }

                // If 'a' has a real external or cross-chapter link (not dummy #, not javascript:, not pure name anchor), let Foliate handle navigation
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    return
                }
            }

            this.hideFootnotePopup()

            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.selection-popup') || e.target.closest('.highlight-action-popup')) return
            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                this.hideHighlightActionPopup()
                return
            }

            this.hideHighlightActionPopup()

            // Content clicks inside iframe toggle the menu bar (page turning is strictly via Left/Right UI buttons & Arrow keys)
            this.toggleReaderUI()
        })

        // Mouse wheel / trackpad scrolling handler
        let wheelCooldown = false
        doc.addEventListener('wheel', e => {
            if (this.settings.layout === 'scrolled') return
            // In PDF / Fixed-layout mode, wheel / trackpad must scroll the container for free panning!
            if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                const host = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer
                if (host) {
                    host.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' })
                }
                return
            }

            // In paginated EPUB mode, wheel flips pages
            if (wheelCooldown) return
            if (Math.abs(e.deltaY) > 25 || Math.abs(e.deltaX) > 25) {
                wheelCooldown = true
                if (e.deltaY > 0 || e.deltaX > 0) {
                    this.turnPageNext()
                } else {
                    this.turnPagePrev()
                }
                setTimeout(() => {
                    if (this.foliateView) wheelCooldown = false
                }, 250)
            }
        }, { passive: true })

        // Multi-event listeners for robust text selection with debounce
        let selectionDebounceTimer = null
        const triggerCheckSelection = (e) => {
            clearTimeout(selectionDebounceTimer)
            selectionDebounceTimer = setTimeout(() => {
                checkSelection(e)
            }, 40)
        }

        doc.addEventListener('pointerup', (e) => triggerCheckSelection(e))
        doc.addEventListener('touchend', (e) => triggerCheckSelection(e))
    }

    renderVirtualMultiSelections() {
        if (!this.foliateView || !this.multiSelectedRanges) return
        this.clearVirtualMultiSelections()
        this.multiSelectedRanges.forEach((item, idx) => {
            if (item.cfi) {
                try {
                    this.foliateView.addAnnotation({
                        value: item.cfi,
                        id: `__vsel_${idx}__`,
                        color: 'rgba(59, 130, 246, 0.38)',
                        style: 'highlight'
                    })
                } catch (e) {
                    console.warn('renderVirtualMultiSelections error:', e)
                }
            }
        })
    }

    clearVirtualMultiSelections() {
        if (!this.foliateView || !this.multiSelectedRanges) return
        this.multiSelectedRanges.forEach((item, idx) => {
            if (item.cfi) {
                try {
                    this.foliateView.deleteAnnotation({
                        value: item.cfi,
                        id: `__vsel_${idx}__`
                    })
                } catch (e) {}
            }
        })
    }



    showSelectionPopup(rect) {
        const popup = this.dom.selectionPopup
        if (!popup) return
        popup.style.display = 'flex'
        const popupWidth = popup.offsetWidth || 280
        const popupHeight = popup.offsetHeight || 44
        let top = rect.top - popupHeight - 10
        if (top < 10) top = rect.top + rect.height + 10
        top = Math.max(10, Math.min(window.innerHeight - popupHeight - 10, top))
        let left = rect.left + (rect.width / 2) - (popupWidth / 2)
        left = Math.max(12, Math.min(window.innerWidth - popupWidth - 12, left))
        
        popup.style.top = `${top}px`
        popup.style.left = `${left}px`
        popup.classList.add('active')
    }

    hideSelectionPopup() {
        if (this.dom.selectionPopup) {
            this.dom.selectionPopup.classList.remove('active')
            this.dom.selectionPopup.style.display = 'none'
        }
        this.selectedTextInfo = null
    }

    showHighlightActionPopup(rect) {
        const popup = this.dom.highlightActionPopup
        if (!popup) return
        popup.style.display = 'flex'
        const popupWidth = popup.offsetWidth || 220
        const popupHeight = popup.offsetHeight || 44
        let top = rect.top - popupHeight - 10
        if (top < 10) top = rect.top + rect.height + 10
        let left = rect.left + (rect.width / 2) - (popupWidth / 2)
        left = Math.max(12, Math.min(window.innerWidth - popupWidth - 12, left))

        popup.style.top = `${top}px`
        popup.style.left = `${left}px`
        popup.classList.add('active')
    }

    hideHighlightActionPopup() {
        if (this.dom.highlightActionPopup) {
            this.dom.highlightActionPopup.classList.remove('active')
            this.dom.highlightActionPopup.style.display = 'none'
        }
        this.clickedHighlightInfo = null
    }

    async onHighlightClicked(value, range) {
        this.hideSelectionPopup()
        if (!range) return
        try {
            const rect = range.getBoundingClientRect()
            const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
            const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
            const absRect = {
                top: rect.top + iframeRect.top,
                left: rect.left + iframeRect.left,
                width: rect.width,
                height: rect.height
            }
            this.clickedHighlightInfo = { value, range, rect: absRect }
            this.showHighlightActionPopup(absRect)
        } catch (e) {
            console.warn('onHighlightClicked error:', e)
        }
    }

    async createHighlight(color, style = 'highlight', note = '') {
        if ((!this.selectedTextInfo && (!this.multiSelectedRanges || this.multiSelectedRanges.length === 0)) || !this.currentBookId) return
        
        const colorVal = color || '#facc15'

        // Multi-range batch creation
        if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
            const rangesToProcess = [...this.multiSelectedRanges]
            this.clearVirtualMultiSelections()
            for (const item of rangesToProcess) {
                const cfi = item.cfi
                const text = item.text.trim()
                if (!text || !cfi) continue
                const hl = {
                    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    bookId: this.currentBookId,
                    cfi: cfi,
                    text: text,
                    color: colorVal,
                    style: style,
                    note: note,
                    chapterTitle: this.currentLocation?.tocItem?.label || '正文',
                    createdAt: Date.now()
                }
                await db.saveHighlight(hl)
                if (this.foliateView && cfi) {
                    try {
                        await this.foliateView.addAnnotation({
                            value: `${cfi}::${style}`,
                            id: hl.id,
                            color: hl.color,
                            style: hl.style
                        })
                    } catch (e) {}
                }
            }
            this.showToast(`✨ 已为 ${rangesToProcess.length} 处选区添加标注`)
            this.multiSelectedRanges = []
            const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
            iframe?.contentDocument?.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
            this.loadNotesList()
            return
        }

        const cfi = this.selectedTextInfo.cfi
        const text = this.selectedTextInfo.text.trim()

        // 1. Check if an annotation of the EXACT SAME style already exists on this CFI
        const existingNotes = await db.getHighlightsByBook(this.currentBookId)
        const matched = existingNotes.find(n => n.cfi === cfi && (n.style || 'highlight') === style)

        if (matched) {
            // If user clicked the same color/style with no new note -> TOGGLE OFF / CANCEL THIS STYLE!
            if (!note && matched.color === colorVal) {
                await db.deleteHighlight(matched.id)
                if (this.foliateView && matched.cfi) {
                    await this.foliateView.deleteAnnotation({ value: `${matched.cfi}::${style}`, id: matched.id })
                }
                const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
                iframe?.contentDocument?.getSelection()?.removeAllRanges()
                this.hideSelectionPopup()
                this.loadNotesList()
                return
            }

            // Update color or note of existing annotation of this style
            matched.color = colorVal
            if (note) matched.note = note
            if (cfi) matched.cfi = cfi
            await db.saveHighlight(matched)

            if (this.foliateView && matched.cfi) {
                try {
                    await this.foliateView.addAnnotation({
                        value: `${matched.cfi}::${style}`,
                        id: matched.id,
                        color: matched.color,
                        style: matched.style
                    })
                } catch (err) {}
            }

            const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
            iframe?.contentDocument?.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
            this.loadNotesList()
            return
        }

        // 2. New Highlight Record (coexists with other styles like highlight + underline!)
        const hl = {
            id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: this.currentBookId,
            cfi: cfi,
            text: text,
            color: colorVal,
            style: style,
            note: note,
            chapterTitle: this.currentLocation?.tocItem?.label || '正文',
            createdAt: Date.now()
        }

        await db.saveHighlight(hl)

        // Draw annotation immediately onto foliate-view
        if (this.foliateView && cfi) {
            try {
                await this.foliateView.addAnnotation({
                    value: `${cfi}::${style}`,
                    id: hl.id,
                    color: hl.color,
                    style: hl.style
                })
            } catch (err) {
                console.warn('Failed to draw annotation:', err)
            }
        }

        // Clear text selection
        const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
        iframe?.contentDocument?.getSelection()?.removeAllRanges()

        this.hideSelectionPopup()
        this.loadNotesList()
    }

    async updateHighlightColor(value, newColor) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            // If user clicked the SAME color again -> TOGGLE OFF / CANCEL HIGHLIGHT!
            if (hl.color === newColor) {
                await this.deleteHighlightByCFI(value)
                this.hideHighlightActionPopup()
                return
            }

            hl.color = newColor
            await db.saveHighlight(hl)
            // Re-add to redraw color
            if (this.foliateView) {
                await this.foliateView.addAnnotation({
                    value: `${hl.cfi}::${hl.style || 'highlight'}`,
                    id: hl.id,
                    color: newColor,
                    style: hl.style || 'highlight'
                })
            }
            this.loadNotesList()
            this.hideHighlightActionPopup()
        }
    }

    async updateHighlightNote(value, newNote) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            hl.note = newNote
            await db.saveHighlight(hl)
            this.loadNotesList()
            this.hideHighlightActionPopup()
        }
    }

    async deleteHighlightByCFI(value) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            await db.deleteHighlight(hl.id)
            if (this.foliateView) {
                await this.foliateView.deleteAnnotation({ value: `${hl.cfi}::${hl.style || 'highlight'}`, id: hl.id })
            }
            this.loadNotesList()
        }
    }

    async findHighlightByCFI(value) {
        if (!this.currentBookId || !value) return null
        const rawCFI = value.includes('::') ? value.split('::')[0] : value
        const notes = await db.getHighlightsByBook(this.currentBookId)
        return notes.find(n => n.id === value || n.cfi === rawCFI || n.cfi === value || `${n.cfi}::${n.style}` === value)
    }

    // ==========================================
    // Drawer Management (TOC, Notes, Search, Settings)
    // ==========================================
    openDrawer(tab) {
        this.dom.sidebarDrawer.classList.add('open')
        this.dom.drawerBackdrop.classList.add('active')
        this.activeDrawer = true
        this.switchTab(tab)
    }

    closeDrawer() {
        this.dom.sidebarDrawer.classList.remove('open')
        this.dom.drawerBackdrop.classList.remove('active')
        this.activeDrawer = false
    }

    switchTab(tabName) {
        this.activeTab = tabName
        this.dom.tabButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName)
        })
        Object.keys(this.dom.tabPanels).forEach(key => {
            this.dom.tabPanels[key].style.display = key === tabName ? 'block' : 'none'
        })

        const titles = {
            toc: '目录导航',
            notes: '高亮与笔记',
            search: '全文检索',
            settings: '排版与视觉设置'
        }
        if (this.dom.drawerTitle) {
            this.dom.drawerTitle.innerText = titles[tabName] || '菜单'
        }

        if (tabName === 'notes') this.loadNotesList()
    }

    renderTOC(toc) {
        const container = this.dom.tocContainer
        container.innerHTML = ''

        if (!toc || toc.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 1rem 0;">本书未检测到目录结构</div>'
            return
        }

        const buildTree = items => {
            const ul = document.createElement('ul')
            ul.className = 'toc-list'
            let lastKey = ''

            items.forEach(item => {
                const label = (item.label || '无标题章节').trim().replace(/[\s\t\u3000\u00A0]+/g, ' ')
                const href = item.href || ''
                const key = `${label}:::${href}`
                // Only deduplicate if BOTH the label AND target destination (href/anchor) are identical
                if (key && key === lastKey && (!item.subitems || item.subitems.length === 0)) {
                    return
                }
                lastKey = key

                const li = document.createElement('li')
                li.className = 'toc-item'
                li.dataset.href = item.href
                li.innerText = label
                li.addEventListener('click', () => {
                    this.foliateView?.goTo(item.href)
                    this.closeDrawer()
                })
                ul.appendChild(li)

                if (item.subitems && item.subitems.length > 0) {
                    const subUl = buildTree(item.subitems)
                    subUl.style.paddingLeft = '1.2rem'
                    ul.appendChild(subUl)
                }
            })
            return ul
        }

        container.appendChild(buildTree(toc))
    }

    highlightActiveTOCItem(href) {
        if (!href) return
        this.dom.tocContainer.querySelectorAll('.toc-item').forEach(el => {
            el.classList.toggle('active', el.dataset.href === href)
        })
    }

    async loadNotesList() {
        if (!this.currentBookId) return
        const allNotes = await db.getHighlightsByBook(this.currentBookId)
        const container = this.dom.notesContainer
        container.innerHTML = ''

        const notes = [...allNotes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

        if (notes.length === 0) {
            container.innerHTML = `
                <div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem 1rem; text-align: center; line-height: 1.6;">
                    <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">✏️</div>
                    <div style="font-weight: 600; color: var(--text-main); margin-bottom: 0.3rem;">暂无划线与笔记</div>
                    <div style="font-size: 0.78rem;">在阅读正文中用鼠标拖选文字，在弹出的工具栏上点击颜色点或【U】即可快速划线、记录想法！</div>
                </div>
            `
            return
        }

        notes.forEach(note => {
            const card = document.createElement('div')
            card.className = 'highlight-card'
            card.style.borderLeftColor = note.color || '#facc15'

            card.innerHTML = `
                <div class="highlight-text">“${escapeHTML(note.text)}”</div>
                ${note.note ? `<div class="highlight-note">${escapeHTML(note.note)}</div>` : ''}
                <div class="highlight-meta">
                    <span>${escapeHTML(note.chapterTitle || '正文')} • ${new Date(note.createdAt).toLocaleDateString()}</span>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn-note-share" style="color: var(--accent-purple); font-size: 0.75rem; font-weight: 600; background: none; border: none; cursor: pointer;">📷 分享卡片</button>
                        <button class="btn-note-del" style="color: #ef4444; font-size: 0.75rem; background: none; border: none; cursor: pointer;">删除</button>
                    </div>
                </div>
            `

            card.addEventListener('click', e => {
                if (e.target.classList.contains('btn-note-del') || e.target.classList.contains('btn-note-share')) return
                if (note.cfi && this.foliateView) {
                    this.foliateView.goTo(note.cfi)
                    this.closeDrawer()
                }
            })

            card.querySelector('.btn-note-share')?.addEventListener('click', e => {
                e.stopPropagation()
                this.openQuoteCardModal(note.text, note.chapterTitle || '')
            })

            card.querySelector('.btn-note-del')?.addEventListener('click', async e => {
                e.stopPropagation()
                await db.deleteHighlight(note.id)
                if (this.foliateView && note.cfi) {
                    await this.foliateView.deleteAnnotation({ value: note.cfi, id: note.id })
                }
                this.loadNotesList()
            })

            container.appendChild(card)
        })
    }

    async exportNotesToMarkdown() {
        if (!this.currentBookId || !this.currentBookData) return
        const notes = await db.getHighlightsByBook(this.currentBookId)
        if (notes.length === 0) return this.showToast('当前书籍暂无笔记可导出', '📝')

        let md = `# 《${this.currentBookData.title}》阅读笔记\n\n`
        md += `* 作者：${this.currentBookData.author || '未知作者'}\n`
        md += `* 导出时间：${new Date().toLocaleString()}\n`
        md += `* 划线条数：${notes.length}\n\n---\n\n`

        notes.forEach((n, idx) => {
            const chap = n.chapterTitle && n.chapterTitle !== 'undefined' ? n.chapterTitle : '划线片段'
            md += `### ${idx + 1}. ${chap}\n\n`
            md += `> ${n.text}\n\n`
            if (n.note) md += `**批注**：${n.note}\n\n`
            md += `*时间：${new Date(n.createdAt).toLocaleString()}*\n\n`
        })

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${this.currentBookData.title || '电子书'}_读书笔记.md`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
    }

    async redrawAllAnnotations() {
        return this.reloadAnnotations()
    }

    async executeSearch() {
        const query = this.dom.searchQueryInput.value.trim()
        if (!query || !this.foliateView) return

        this._searchToken = (this._searchToken || 0) + 1
        const currentToken = this._searchToken

        const container = this.dom.searchResultsContainer
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">正在全书检索中...</div>'

        try {
            const matches = []
            let totalCount = 0

            const iter = this.foliateView.search({ query })
            for await (const result of iter) {
                if (this._searchToken !== currentToken) return
                if (result === 'done') break
                if (result.subitems && result.subitems.length > 0) {
                    matches.push({
                        label: result.label || '当前章节',
                        items: result.subitems
                    })
                    totalCount += result.subitems.length
                    if (totalCount >= 100) break
                }
            }

            if (this._searchToken !== currentToken) return
            container.innerHTML = ''
            if (matches.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.8rem 0; text-align: center;">未检索到相关内容</div>'
                return
            }

            const summaryEl = document.createElement('div')
            summaryEl.style.fontSize = '0.75rem'
            summaryEl.style.color = 'var(--text-muted)'
            summaryEl.style.marginBottom = '0.75rem'
            summaryEl.style.paddingBottom = '0.4rem'
            summaryEl.style.borderBottom = '1px solid var(--border-subtle)'
            summaryEl.innerText = `共检索到 ${totalCount} 处匹配结果：`
            container.appendChild(summaryEl)

            const flatMatches = []
            matches.forEach(group => {
                const groupHeader = document.createElement('div')
                groupHeader.style.fontSize = '0.78rem'
                groupHeader.style.fontWeight = '700'
                groupHeader.style.color = 'var(--accent-purple)'
                groupHeader.style.marginTop = '0.6rem'
                groupHeader.style.marginBottom = '0.3rem'
                groupHeader.innerText = group.label
                container.appendChild(groupHeader)

                group.items.forEach(item => {
                    flatMatches.push(item)
                    const itemEl = document.createElement('div')
                    itemEl.className = 'search-result-item'
                    const { pre = '', match = query, post = '' } = item.excerpt || {}
                    itemEl.innerHTML = `${escapeHTML(pre)}<mark>${escapeHTML(match)}</mark>${escapeHTML(post)}`
                    itemEl.addEventListener('click', async () => {
                        if (item.cfi) {
                            const idx = this.currentSearchMatches.findIndex(m => m.cfi === item.cfi)
                            if (idx !== -1) this.currentSearchMatchIndex = idx
                            await this.foliateView.goTo(item.cfi)
                            this.updateSearchBarUI()
                            this.closeDrawer()
                        }
                    })
                    container.appendChild(itemEl)
                })
            })

            this.currentSearchMatches = flatMatches
            this.currentSearchMatchIndex = 0
            this.currentSearchQuery = query
            this.updateSearchBarUI()

        } catch (e) {
            console.error('Search error:', e)
            container.innerHTML = `<div style="color: #ef4444; font-size: 0.85rem;">搜索失败: ${e.message}</div>`
        }
    }

    clearSearchState(clearInput = false) {
        this._searchToken = (this._searchToken || 0) + 1
        if (this.foliateView?.clearSearch) {
            this.foliateView.clearSearch()
        }
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
        if (this.dom.readerSearchBar) {
            this.dom.readerSearchBar.style.display = 'none'
        }
        if (clearInput) {
            if (this.dom.searchQueryInput) this.dom.searchQueryInput.value = ''
            if (this.dom.btnClearSearchInput) this.dom.btnClearSearchInput.style.display = 'none'
            if (this.dom.searchResultsContainer) this.dom.searchResultsContainer.innerHTML = ''
        }
    }

    async navigateSearchMatch(direction) {
        if (this.currentSearchMatches.length === 0 || !this.foliateView) return
        this.currentSearchMatchIndex = (this.currentSearchMatchIndex + direction + this.currentSearchMatches.length) % this.currentSearchMatches.length
        const target = this.currentSearchMatches[this.currentSearchMatchIndex]
        if (target?.cfi) {
            await this.foliateView.goTo(target.cfi)
            this.updateSearchBarUI()
        }
    }

    updateSearchBarUI() {
        if (!this.dom.readerSearchBar || this.currentSearchMatches.length === 0) return
        this.dom.readerSearchBar.style.display = 'flex'
        const curr = this.currentSearchMatchIndex + 1
        const total = this.currentSearchMatches.length
        if (this.dom.searchBarTitle) {
            this.dom.searchBarTitle.innerText = `🔍 "${this.currentSearchQuery}" (${curr}/${total})`
        }
    }

    // ==========================================
    // Sample Books Demo & Deduplication
    // ==========================================
    // Safe no-op deduplication helper (never cascade delete user books)
    async deduplicateBooks() {
        return 0
    }

    async loadSampleBooks() {
        if (this.dom.btnLoadSamples) this.dom.btnLoadSamples.disabled = true

        try {
            const existingBooks = await db.getAllBooks()
            const existingTitles = new Set(existingBooks.map(b => b.title?.trim()))

            const samples = [
                {
                    name: '现代化电子书阅读器设计白皮书.docx',
                    url: './samples/sample_whitepaper.docx'
                },
                {
                    name: '三国演义（精选前三回）.txt',
                    url: './samples/sample_sanguo.txt'
                },
                {
                    name: 'Alice_in_Wonderland.epub',
                    url: './samples/sample_alice.epub'
                },
                {
                    name: 'Universal_Reader_PDF_Test.pdf',
                    url: './samples/sample_doc.pdf'
                },
                {
                    name: 'Comic_Adventure.cbz',
                    url: './samples/sample_comic.cbz'
                },
                {
                    name: 'Universal_Reader_Guide.txt',
                    url: './samples/sample_guide.txt'
                }
            ]

            let addedCount = 0
            for (const sample of samples) {
                const baseTitle = sample.name.replace(/\.[^/.]+$/, '').trim()
                if (existingTitles.has(baseTitle)) {
                    continue // Skip books that are already in bookshelf!
                }
                const res = await fetch(sample.url)
                if (res.ok) {
                    const blob = await res.blob()
                    const file = new File([blob], sample.name)
                    await this.processAndSaveBook(file)
                    addedCount++
                }
            }

            if (addedCount === 0) {
                this.showToast('ℹ️ 预置样例图书均已在书架中')
            } else {
                this.showToast(`📚 成功载入 ${addedCount} 本预置演示图书`)
            }

            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
        } catch (e) {
            console.error('Failed to load sample books:', e)
            this.showToast('⚠️ 加载样例图书失败: ' + e.message)
        } finally {
            if (this.dom.btnLoadSamples) this.dom.btnLoadSamples.disabled = false
        }
    }

    // ==========================================
    // WeChat Read Style Statistics Dashboard
    // ==========================================
    async renderStatsDashboard() {
        if (!this.dom.statsDashboardContainer) return
        this._statsReqId = (this._statsReqId || 0) + 1
        const currentReqId = this._statsReqId

        try {
            const mode = this.statsViewMode || 'month'
            const stats = await db.getReadingStats(mode, this.statsYear, this.statsMonth, this.statsWeekOffset || 0)
            if (currentReqId !== this._statsReqId) return // Drop stale response!

            // 1. Update Date Navigator Text
            if (this.dom.statsDateLabel) {
                if (this.dom.statsDateNavigator) this.dom.statsDateNavigator.style.visibility = 'visible'
                if (mode === 'week') {
                    if (this.statsWeekOffset === 0) {
                        this.dom.statsDateLabel.innerText = stats.weekDateRangeStr ? `本周 (${stats.weekDateRangeStr})` : `本周`
                    } else {
                        this.dom.statsDateLabel.innerText = stats.weekDateRangeStr || `第 ${this.statsWeekOffset} 周`
                    }
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const isFutureOrCurrent = (this.statsWeekOffset || 0) >= 0
                        this.dom.btnStatsNextDate.disabled = isFutureOrCurrent
                        this.dom.btnStatsNextDate.style.opacity = isFutureOrCurrent ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isFutureOrCurrent ? 'default' : 'pointer'
                    }
                } else if (mode === 'month') {
                    this.dom.statsDateLabel.innerText = `${stats.targetYear}年${stats.targetMonth}月`
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const now = new Date()
                        const isCurrentOrFuture = this.statsYear > now.getFullYear() || (this.statsYear === now.getFullYear() && this.statsMonth >= (now.getMonth() + 1))
                        this.dom.btnStatsNextDate.disabled = isCurrentOrFuture
                        this.dom.btnStatsNextDate.style.opacity = isCurrentOrFuture ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isCurrentOrFuture ? 'default' : 'pointer'
                    }
                } else if (mode === 'year') {
                    this.dom.statsDateLabel.innerText = `${stats.targetYear}年`
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const now = new Date()
                        const isCurrentOrFuture = this.statsYear >= now.getFullYear()
                        this.dom.btnStatsNextDate.disabled = isCurrentOrFuture
                        this.dom.btnStatsNextDate.style.opacity = isCurrentOrFuture ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isCurrentOrFuture ? 'default' : 'pointer'
                    }
                } else if (mode === 'total') {
                    this.dom.statsDateLabel.innerText = `全部历年总览`
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'none'
                    if (this.dom.btnStatsNextDate) this.dom.btnStatsNextDate.style.display = 'none'
                }
            }

            // 2. Hero Big Duration Banner
            if (this.dom.statsHeroTime) {
                if (mode === 'total') {
                    const totalH = stats.totalHours || 0
                    this.dom.statsHeroTime.innerHTML = `${totalH}<span class="stats-unit">小时</span>`
                } else {
                    const h = stats.viewHours || 0
                    const m = stats.viewMins || 0
                    if (h > 0) {
                        this.dom.statsHeroTime.innerHTML = `${h}<span class="stats-unit">小时</span> ${m}<span class="stats-unit">分钟</span>`
                    } else {
                        this.dom.statsHeroTime.innerHTML = `${m}<span class="stats-unit">分钟</span>`
                    }
                }
            }

            // 3. Hero Sub Insight Text
            if (this.dom.statsHeroSub) {
                if (mode === 'total') {
                    this.dom.statsHeroSub.innerText = `${stats.earliestDateStr} 至今 · 与 Linden Leaf 相伴 ${stats.companionDays} 天`
                } else {
                    const now = new Date()
                    const targetYear = stats.targetYear || now.getFullYear()
                    const targetMonth = stats.targetMonth || (now.getMonth() + 1)
                    let divisor = 1
                    if (mode === 'week') {
                        const dayOfWeek = now.getDay() || 7
                        divisor = (this.statsWeekOffset === 0) ? dayOfWeek : 7
                    } else if (mode === 'month') {
                        const isCurrentMonth = targetYear === now.getFullYear() && targetMonth === (now.getMonth() + 1)
                        divisor = isCurrentMonth ? Math.max(1, now.getDate()) : (stats.chartData?.length || 30)
                    } else if (mode === 'year') {
                        const isCurrentYear = targetYear === now.getFullYear()
                        if (isCurrentYear) {
                            const startOfYear = new Date(now.getFullYear(), 0, 1)
                            divisor = Math.max(1, Math.floor((now.getTime() - startOfYear.getTime()) / (86400 * 1000)) + 1)
                        } else {
                            const isLeap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || (targetYear % 400 === 0)
                            divisor = isLeap ? 366 : 365
                        }
                    } else {
                        divisor = Math.max(1, stats.companionDays || 1)
                    }

                    const avgSecondsPerDay = stats.viewTotalSeconds / divisor
                    let avgText = ''
                    if (avgSecondsPerDay >= 3600) {
                        const h = (avgSecondsPerDay / 3600).toFixed(1)
                        avgText = `${h} 小时`
                    } else if (avgSecondsPerDay >= 60) {
                        avgText = `${Math.round(avgSecondsPerDay / 60)} 分钟`
                    } else if (stats.viewTotalSeconds > 0) {
                        avgText = `< 1 分钟`
                    } else {
                        avgText = `0 分钟`
                    }
                    this.dom.statsHeroSub.innerText = `日均阅读 ${avgText}`
                }
            }

            // 4. Quad Micro KPIs (读过 / 读完 / 阅读天数 / 笔记)
            this.latestStats = stats
            if (this.dom.quadReadBooks) this.dom.quadReadBooks.innerText = `${stats.periodBooksCount != null ? stats.periodBooksCount : stats.totalBooksCount}`
            if (this.dom.quadFinishedBooks) this.dom.quadFinishedBooks.innerText = `${stats.periodFinishedCount != null ? stats.periodFinishedCount : stats.finishedCount}`
            if (this.dom.quadReadDays) this.dom.quadReadDays.innerText = `${stats.viewReadDays || 0}`
            if (this.dom.quadNoteCount) this.dom.quadNoteCount.innerText = `${stats.periodHighlightsCount != null ? stats.periodHighlightsCount : stats.totalHighlightsCount}`

            // 5. Render Distribution Bar Chart
            this.renderDistributionChart(stats)

            // 6. Books Leaderboard
            this.renderLeaderboard(stats.topBooks)

            // 7. Recent Sessions Timeline
            this.renderRecentSessions(stats.recentSessions)

        } catch (err) {
            console.error('Failed to render stats dashboard:', err)
        }
    }

    renderDistributionChart(stats) {
        const container = this.dom.statsDistributionChart
        if (!container) return
        container.innerHTML = ''

        const data = stats.chartData || []
        if (data.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem; width:100%; text-align:center;">暂无记录</div>`
            return
        }

        const maxMins = Math.max(30, ...data.map(d => d.minutes))
        
        // Update Y Axis Reference Labels
        if (this.dom.statsYMax) {
            this.dom.statsYMax.innerText = maxMins >= 60 ? `${(maxMins/60).toFixed(0)}h` : `${maxMins}m`
        }
        if (this.dom.statsYMid) {
            const mid = Math.round(maxMins / 2)
            this.dom.statsYMid.innerText = mid >= 60 ? `${(mid/60).toFixed(0)}h` : `${mid}m`
        }

        // Update Chart Card Title
        const chartTitleEl = document.querySelector('.stats-card-title')
        if (chartTitleEl) {
            if (stats.viewMode === 'week') {
                chartTitleEl.innerText = stats.weekOffset === 0 ? '本周每日阅读分布' : `${stats.weekDateRangeStr} 每日阅读分布`
            }
            else if (stats.viewMode === 'month') chartTitleEl.innerText = `${stats.targetYear}年${stats.targetMonth}月 每日阅读分布`
            else if (stats.viewMode === 'year') chartTitleEl.innerText = `${stats.targetYear}年 每月阅读分布`
            else if (stats.viewMode === 'total') chartTitleEl.innerText = '历年阅读时长总分布'
        }

        data.forEach(item => {
            const col = document.createElement('div')
            col.className = 'chart-bar-col'

            const heightPct = item.minutes > 0 ? Math.max(8, Math.round((item.minutes / maxMins) * 100)) : 0
            const isZero = item.minutes === 0

            const showLabel = stats.viewMode === 'month' ? (item.isKeyTick || item.isCurrent) : true

            col.innerHTML = `
                <div class="chart-tooltip">${item.fullDate || item.label}: ${item.minutes} 分钟</div>
                <div class="chart-bar-track">
                    <div class="chart-bar-pill ${item.isCurrent ? 'today' : ''} ${isZero ? 'zero' : ''}" style="height: ${heightPct}%;"></div>
                </div>
                <div class="chart-day-label ${item.isCurrent ? 'today' : ''}">${showLabel ? item.label : ''}</div>
            `
            container.appendChild(col)
        })

        // Update Peak Pill
        if (this.dom.statsPeakPill && this.dom.statsPeakText) {
            if (stats.peakInfo && stats.peakInfo.seconds > 0) {
                this.dom.statsPeakText.innerText = `🏆 ${stats.peakInfo.label} · ${stats.peakInfo.timeStr}`
                this.dom.statsPeakPill.style.display = 'inline-flex'
            } else {
                this.dom.statsPeakPill.style.display = 'none'
            }
        }
    }

    renderLeaderboard(books) {
        const container = this.dom.statsLeaderboardList
        if (!container) return
        container.innerHTML = ''

        const validBooks = (books || []).filter(b => (b.totalReadingSeconds && b.totalReadingSeconds > 0) || (b.progress?.fraction && b.progress.fraction > 0))

        if (validBooks.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 2.5rem 1rem;">
                    📖 还没有阅读记录，点击任意书籍开始阅读打卡吧！
                </div>
            `
            return
        }

        validBooks.forEach((book, idx) => {
            const item = document.createElement('div')
            item.className = 'leaderboard-item'
            item.dataset.id = book.id

            let rankClass = ''
            let rankText = `${idx + 1}`
            if (idx === 0) { rankClass = 'rank-1'; rankText = '🥇' }
            else if (idx === 1) { rankClass = 'rank-2'; rankText = '🥈' }
            else if (idx === 2) { rankClass = 'rank-3'; rankText = '🥉' }

            let coverUrl = ''
            if (book.coverBlob) {
                coverUrl = coverUrlPool.get(book.id, book.coverBlob)
            }

            const fraction = book.progress?.fraction || 0
            const progressPct = (fraction * 100).toFixed(fraction > 0 && fraction < 0.1 ? 2 : (fraction % 1 === 0 ? 0 : 2))
            const timeStr = tracker.formatDuration(book.totalReadingSeconds || 0)

            item.innerHTML = `
                <div class="rank-badge ${rankClass}">${rankText}</div>
                ${coverUrl 
                    ? `<img class="item-thumb" src="${coverUrl}" alt="${escapeHTML(book.title)}"/>`
                    : `<div class="item-thumb" style="display:flex;align-items:center;justify-content:center;font-size:8px;color:#94a3b8;">书</div>`
                }
                <div class="item-info">
                    <div class="item-title" title="${escapeHTML(book.title)}">${escapeHTML(book.title)}</div>
                    <div class="item-meta">
                        <span class="item-time">已读 ${timeStr}</span>
                        <span>进度 ${progressPct}%</span>
                    </div>
                    <div class="item-progress-track">
                        <div class="item-progress-fill" style="width: ${Math.min(100, fraction * 100)}%;"></div>
                    </div>
                </div>
            `

            item.addEventListener('click', () => this.openBook(book.id))
            container.appendChild(item)
        })
    }

    renderRecentSessions(sessions) {
        const container = this.dom.statsRecentSessions
        if (!container) return
        container.innerHTML = ''

        if (!sessions || sessions.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1.5rem;">
                    暂无最近单次阅读流水
                </div>
            `
            return
        }

        sessions.forEach(sess => {
            const item = document.createElement('div')
            item.className = 'session-item'

            const timeFormatted = new Date(sess.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            const durStr = tracker.formatDuration(sess.durationSeconds || 0)

            item.innerHTML = `
                <div class="session-item-left">
                    <div class="session-dot"></div>
                    <div>
                        <div class="session-book-title">${escapeHTML(sess.bookTitle || '未知书籍')}</div>
                        <div class="session-time-range">${escapeHTML(sess.date)} ${timeFormatted}</div>
                    </div>
                </div>
                <div class="session-duration-pill">${durStr}</div>
            `
            container.appendChild(item)
        })
    }

    openStatsDetailModal(type) {
        const modal = document.getElementById('modal-stats-detail')
        const iconEl = document.getElementById('stats-detail-modal-icon')
        const titleEl = document.getElementById('stats-detail-modal-title')
        const listEl = document.getElementById('stats-detail-modal-list')
        if (!modal || !listEl) return

        listEl.innerHTML = ''
        const stats = this.latestStats || {}
        let periodLabel = '本期'
        if (stats.viewMode === 'week') periodLabel = stats.weekDateRangeStr ? `本周 (${stats.weekDateRangeStr})` : '本周'
        else if (stats.viewMode === 'month') periodLabel = `${stats.targetYear}年${stats.targetMonth}月`
        else if (stats.viewMode === 'year') periodLabel = `${stats.targetYear}年`
        else if (stats.viewMode === 'total') periodLabel = '全部历年'

        if (type === 'read_books') {
            if (iconEl) iconEl.innerText = '📚'
            if (titleEl) titleEl.innerText = `${periodLabel} 读过的图书 (${stats.periodBooks?.length || 0} 本)`

            const books = stats.periodBooks || []
            if (books.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">该周期内暂无阅读图书记录</div>'
            } else {
                books.forEach(b => {
                    const row = document.createElement('div')
                    row.className = 'stats-detail-book-row'
                    row.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-secondary); cursor: pointer;'

                    const progressPct = b.progress?.fraction ? Math.round(b.progress.fraction * 100) : 0
                    const durStr = tracker.formatDuration(b.periodReadingSeconds || b.totalReadingSeconds || 0)

                    row.innerHTML = `
                        <div style="width: 44px; height: 60px; border-radius: 4px; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            ${b.coverUrl ? `<img src="${b.coverUrl}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 1.25rem;">📖</span>`}
                        </div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(b.title)}</div>
                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(b.author || '未知作者')} · ${(b.format || 'txt').toUpperCase()}</div>
                            <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                                <span style="font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; background: rgba(124, 58, 237, 0.1); color: var(--accent-purple); font-weight: 600;">本期阅读 ${durStr}</span>
                                <span style="font-size: 0.72rem; color: var(--text-muted);">已读 ${progressPct}%</span>
                            </div>
                        </div>
                        <button class="btn-primary-action" style="font-size: 0.76rem; padding: 0.35rem 0.75rem; white-space: nowrap;">打开阅读 ›</button>
                    `
                    row.addEventListener('click', () => {
                        this.closeStatsDetailModal()
                        this.openBook(b.id)
                    })
                    listEl.appendChild(row)
                })
            }
        } else if (type === 'finished_books') {
            if (iconEl) iconEl.innerText = '🏆'
            if (titleEl) titleEl.innerText = `${periodLabel} 读完的图书 (${stats.periodFinishedBooks?.length || 0} 本)`

            const books = stats.periodFinishedBooks || []
            if (books.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">该周期内暂无读完的图书</div>'
            } else {
                books.forEach(b => {
                    const row = document.createElement('div')
                    row.className = 'stats-detail-book-row'
                    row.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-secondary); cursor: pointer;'

                    const durStr = tracker.formatDuration(b.periodReadingSeconds || b.totalReadingSeconds || 0)

                    row.innerHTML = `
                        <div style="width: 44px; height: 60px; border-radius: 4px; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            ${b.coverUrl ? `<img src="${b.coverUrl}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 1.25rem;">🏆</span>`}
                        </div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(b.title)}</div>
                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(b.author || '未知作者')} · ${(b.format || 'txt').toUpperCase()}</div>
                            <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                                <span style="font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; background: rgba(34, 197, 94, 0.12); color: #16a34a; font-weight: 600;">已读完 · 共 ${durStr}</span>
                            </div>
                        </div>
                        <button class="btn-primary-action" style="font-size: 0.76rem; padding: 0.35rem 0.75rem; white-space: nowrap;">重温阅读 ›</button>
                    `
                    row.addEventListener('click', () => {
                        this.closeStatsDetailModal()
                        this.openBook(b.id)
                    })
                    listEl.appendChild(row)
                })
            }
        } else if (type === 'notes') {
            if (iconEl) iconEl.innerText = '📝'
            if (titleEl) titleEl.innerText = `${periodLabel} 划线与想法 (${stats.periodHighlights?.length || 0} 条)`

            const notes = stats.periodHighlights || []
            if (notes.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">该周期内暂无划线或想法</div>'
            } else {
                notes.forEach(n => {
                    const row = document.createElement('div')
                    row.style.cssText = 'padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-secondary); display: flex; flex-direction: column; gap: 6px;'

                    row.innerHTML = `
                        <div style="font-size: 0.88rem; color: var(--text-main); line-height: 1.5; border-left: 3px solid var(--accent-purple); padding-left: 8px;">“${escapeHTML(n.text || '')}”</div>
                        ${n.note ? `<div style="font-size: 0.82rem; color: var(--accent-purple); background: var(--bg-tertiary); padding: 4px 8px; border-radius: 4px;">💡 想法：${escapeHTML(n.note)}</div>` : ''}
                        <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                            <span>📖 《${escapeHTML(n.bookTitle || '图书')}》 · ${escapeHTML(n.chapterTitle || '')}</span>
                            <span>${new Date(n.createdAt).toLocaleDateString()}</span>
                        </div>
                    `
                    listEl.appendChild(row)
                })
            }
        }

        modal.style.display = 'flex'
        requestAnimationFrame(() => {
            modal.classList.add('show')
        })
    }

    closeStatsDetailModal() {
        const modal = document.getElementById('modal-stats-detail')
        if (modal) {
            modal.classList.remove('show')
            setTimeout(() => { modal.style.display = 'none' }, 220)
        }
    }

    async reloadAnnotations() {
        if (!this.currentBookId || !this.foliateView) return
        try {
            const highlights = await db.getHighlightsByBook(this.currentBookId)
            const contents = this.foliateView.renderer?.getContents?.() || []
            for (const content of contents) {
                if (content.overlayer?.element) {
                    while (content.overlayer.element.firstChild) {
                        content.overlayer.element.removeChild(content.overlayer.element.firstChild)
                    }
                }
            }
            for (const hl of highlights) {
                try {
                    await this.foliateView.addAnnotation({
                        value: `${hl.cfi}::${hl.style || 'highlight'}`,
                        id: hl.id,
                        color: hl.color,
                        style: hl.style || 'highlight'
                    })
                } catch (err) {}
            }
        } catch (e) {
            console.warn('Failed to reload annotations:', e)
        }
    }

    // ==========================================================
    // WebDAV & Nutstore Cloud Sync Controller
    // ==========================================================
    async initSyncService() {
        if (!window.electronAPI?.syncGetConfig) return
        try {
            this.syncConfig = await window.electronAPI.syncGetConfig()
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

        this.renderSyncUI()

        // Auto sync on startup
        if (this.syncConfig.enabled && this.syncConfig.autoSyncOnStartup && this.syncConfig.username && (this.syncConfig.password || this.syncConfig.hasPassword)) {
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
            })
        })

        // Password visibility toggle
        const btnTogglePwd = this.dom.btnToggleSyncPwd || document.getElementById('btn-toggle-sync-pwd')
        btnTogglePwd?.addEventListener('click', () => {
            const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
            if (!pwdInput) return
            const isPwd = pwdInput.type === 'password'
            pwdInput.type = isPwd ? 'text' : 'password'
            btnTogglePwd.innerText = isPwd ? '🙈' : '👁️'
        })

        // Save & Enable Button
        const btnSaveEnable = this.dom.btnSyncSaveEnable || document.getElementById('btn-sync-save-enable')
        btnSaveEnable?.addEventListener('click', async () => {
            const cfg = this.getSyncConfigFromUI()
            cfg.enabled = true
            this.syncConfig = cfg
            await this.saveSyncConfig()
            this.renderSyncUI()
            this.closeWebdavSyncModal()
            this.showToast('云端同步已开启，多端数据将自动实时对齐', '✓')
            this.triggerSilentBackgroundSync()
        })

        // Disable Sync Button
        const btnDisable = this.dom.btnSyncDisable || document.getElementById('btn-sync-disable')
        btnDisable?.addEventListener('click', async () => {
            const cfg = this.getSyncConfigFromUI()
            cfg.enabled = false
            this.syncConfig = cfg
            await this.saveSyncConfig()
            this.renderSyncUI()
            this.closeWebdavSyncModal()
            this.showToast('已关闭云端同步', '✓')
        })

        // Action buttons inside modal
        const btnTest = this.dom.btnSyncTestConn || document.getElementById('btn-sync-test-conn')
        btnTest?.addEventListener('click', () => this.testSyncConnection())
        const btnTrigger = this.dom.btnSyncTriggerNow || document.getElementById('btn-sync-trigger-now')
        btnTrigger?.addEventListener('click', () => this.triggerManualSync())
    }

    renderSyncUI() {
        if (!this.syncConfig) return
        const c = this.syncConfig

        // Update sidebar status badge
        const badge = this.dom.syncStatusBadgeSidebar || document.getElementById('sync-status-badge-sidebar')
        if (badge) {
            if (c.enabled && c.username) {
                const typeName = c.serverType === 'jianguoyun' ? '坚果云' : 'WebDAV'
                badge.innerText = `已开启 (${typeName})`
                badge.style.background = 'rgba(16, 185, 129, 0.12)'
                badge.style.color = '#059669'
            } else {
                badge.innerText = '未配置'
                badge.style.background = 'var(--bg-tertiary)'
                badge.style.color = 'var(--text-muted)'
            }
        }

        // Form fields inside modal
        const serverInput = this.dom.syncInputServer || document.getElementById('sync-input-server')
        if (serverInput) serverInput.value = c.serverUrl || 'https://dav.jianguoyun.com/dav/'
        const userInput = this.dom.syncInputUsername || document.getElementById('sync-input-username')
        if (userInput) userInput.value = c.username || ''
        const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
        if (pwdInput) {
            pwdInput.value = c.password || ''
            if (c.hasPassword && !c.password) {
                pwdInput.placeholder = '•••••••••••••••• (已保存密码)'
            } else {
                pwdInput.placeholder = '16 位第三方应用专用授权密码'
            }
        }
        const dirInput = this.dom.syncInputDir || document.getElementById('sync-input-dir')
        if (dirInput) dirInput.value = c.remoteDir || 'LindenLeaf'

        // Update preset active button
        document.querySelectorAll('.btn-sync-preset')?.forEach(btn => {
            const isMatch = btn.dataset.preset === (c.serverType || 'jianguoyun')
            btn.classList.toggle('active', isMatch)
        })

        // Update status card
        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')

        if (c.lastSyncTime) {
            const timeStr = new Date(c.lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            const dateStr = new Date(c.lastSyncTime).toLocaleDateString('zh-CN')
            const isOk = c.lastSyncStatus === 'success'
            if (dot) dot.innerText = isOk ? '🟢' : '🔴'
            if (title) {
                title.innerText = isOk ? '云同步正常' : '同步异常'
                title.style.color = isOk ? '#059669' : '#dc2626'
            }
            if (desc) desc.innerText = `上次同步: ${dateStr} ${timeStr} ${c.lastSyncSummary || ''}`
        } else {
            if (dot) dot.innerText = '⚪'
            if (title) {
                title.innerText = '尚未同步'
                title.style.color = 'var(--text-secondary)'
            }
            if (desc) desc.innerText = '点击「立即同步」开始备份与多端对齐'
        }
    }

    getSyncConfigFromUI() {
        const serverType = document.querySelector('.btn-sync-preset.active')?.dataset.preset || 'jianguoyun'
        const serverInput = this.dom.syncInputServer || document.getElementById('sync-input-server')
        const userInput = this.dom.syncInputUsername || document.getElementById('sync-input-username')
        const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
        const dirInput = this.dom.syncInputDir || document.getElementById('sync-input-dir')
        return {
            enabled: this.syncConfig?.enabled || false,
            serverType,
            serverUrl: serverInput?.value.trim() || 'https://dav.jianguoyun.com/dav/',
            username: userInput?.value.trim() || '',
            password: pwdInput?.value || '',
            hasPassword: this.syncConfig?.hasPassword || false,
            remoteDir: dirInput?.value.trim() || 'LindenLeaf',
            autoSyncOnStartup: true,
            autoSyncOnBookClose: true,
            lastSyncTime: this.syncConfig?.lastSyncTime || null,
            lastSyncStatus: this.syncConfig?.lastSyncStatus || null,
            lastSyncSummary: this.syncConfig?.lastSyncSummary || null
        }
    }

    async saveSyncConfig() {
        this.syncConfig = this.getSyncConfigFromUI()
        if (window.electronAPI?.syncSaveConfig) {
            await window.electronAPI.syncSaveConfig(this.syncConfig)
        }
    }

    async testSyncConnection() {
        await this.saveSyncConfig()
        const config = this.syncConfig
        if (!config.username || (!config.password && !config.hasPassword)) {
            this.showToast('请先输入坚果云账号（邮箱）和应用授权密码', '⚠️')
            return
        }

        const btnTest = this.dom.btnSyncTestConn || document.getElementById('btn-sync-test-conn')
        if (btnTest) {
            btnTest.disabled = true
            btnTest.innerHTML = '<span class="syncing-spin">⚡</span> <span>正在测试...</span>'
        }

        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')

        try {
            const res = await window.electronAPI.syncTestConnection(config)
            if (res.success) {
                this.showToast('🎉 ' + res.message, '🟢')
                if (dot) dot.innerText = '🟢'
                if (title) {
                    title.innerText = '连接测试通过'
                    title.style.color = '#059669'
                }
                if (desc) desc.innerText = '远程应用目录已就绪'
            } else {
                this.showToast(res.error || '连接失败', '🔴')
                if (dot) dot.innerText = '🔴'
                if (title) {
                    title.innerText = '连接失败'
                    title.style.color = '#dc2626'
                }
                if (desc) desc.innerText = res.error || '请检查账号密码'
            }
        } catch (e) {
            this.showToast(`测试出错: ${e.message}`, '🔴')
        } finally {
            if (btnTest) {
                btnTest.disabled = false
                btnTest.innerHTML = '<span>⚡ 测试连接</span>'
            }
        }
    }

    async triggerManualSync() {
        await this.saveSyncConfig()
        const config = this.syncConfig
        if (!config.username || (!config.password && !config.hasPassword)) {
            this.showToast('请先输入坚果云账号与应用授权密码', '⚠️')
            return
        }

        const btnTrigger = this.dom.btnSyncTriggerNow || document.getElementById('btn-sync-trigger-now')
        if (btnTrigger) {
            btnTrigger.disabled = true
            btnTrigger.innerHTML = '<span class="syncing-spin">🔄</span> <span>正在同步...</span>'
        }
        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        if (dot) dot.innerText = '🟡'
        if (title) {
            title.innerText = '正在同步中...'
            title.style.color = '#d97706'
        }

        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')
        try {
            const res = await syncEngine.executeSyncLifecycle(config, {
                onProgress: (msg) => {
                    if (desc) desc.innerText = msg
                }
            })

            const stats = res.stats || {}
            let summaryParts = []
            if (stats.booksUpdated) summaryParts.push(`对齐 ${stats.booksUpdated} 本进度`)
            if (stats.highlightsAdded) summaryParts.push(`合并 ${stats.highlightsAdded} 条划线`)
            if (stats.sessionsAdded) summaryParts.push(`合并 ${stats.sessionsAdded} 条阅读记录`)
            if (stats.listsAdded) summaryParts.push(`合并 ${stats.listsAdded} 个书单`)
            const summaryStr = summaryParts.length > 0 ? `(${summaryParts.join(', ')})` : '(数据已是对齐状态)'

            this.syncConfig.lastSyncTime = Date.now()
            this.syncConfig.lastSyncStatus = 'success'
            this.syncConfig.lastSyncSummary = summaryStr
            await this.saveSyncConfig()
            this.renderSyncUI()

            this.showToast(`🎉 云同步成功！${summaryStr}`, '☁️')
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
        } catch (err) {
            console.error('Manual sync error:', err)
            this.syncConfig.lastSyncTime = Date.now()
            this.syncConfig.lastSyncStatus = 'error'
            this.syncConfig.lastSyncSummary = err.message
            await this.saveSyncConfig()
            this.renderSyncUI()
            this.showToast(`同步失败: ${err.message}`, '🔴')
        } finally {
            if (btnTrigger) {
                btnTrigger.disabled = false
                btnTrigger.innerHTML = '<span>🔄 立即双向同步</span>'
            }
        }
    }

    async triggerSilentBackgroundSync() {
        if (!this.syncConfig?.enabled || !this.syncConfig?.username || (!this.syncConfig?.password && !this.syncConfig?.hasPassword)) return
        try {
            console.log('[CloudSync] Starting silent background sync...')
            const res = await syncEngine.executeSyncLifecycle(this.syncConfig)
            this.syncConfig.lastSyncTime = Date.now()
            this.syncConfig.lastSyncStatus = 'success'
            await this.saveSyncConfig()
            this.renderSyncUI()
            console.log('[CloudSync] Silent background sync completed successfully:', res.stats)
        } catch (e) {
            console.warn('[CloudSync] Silent background sync error (ignored):', e.message)
        }
    }

    // ==========================================================
    // GitHub Releases Update Checker & Notification Controller
    // ==========================================================
    setupUpdateEventListeners() {
        this.dom.btnCheckUpdates?.addEventListener('click', () => this.handleCheckForUpdates(false))
        this.dom.btnOpenGithubRepo?.addEventListener('click', () => {
            const repoUrl = localStorage.getItem('linden_custom_github_repo_url') || 'https://github.com/j7sz2jpnb2-rgb/linden-leaf'
            if (window.electronAPI?.openExternal) {
                window.electronAPI.openExternal(repoUrl)
            } else {
                window.open(repoUrl, '_blank')
            }
        })
        this.dom.btnCloseUpdateModal?.addEventListener('click', () => this.closeUpdateModal())
        this.dom.btnUpdateLater?.addEventListener('click', () => this.closeUpdateModal())
        this.dom.modalUpdateDialog?.addEventListener('click', e => {
            if (e.target === this.dom.modalUpdateDialog) this.closeUpdateModal()
        })
        this.dom.btnUpdateDownload?.addEventListener('click', () => {
            if (this._latestUpdateInfo?.downloadUrl) {
                if (window.electronAPI?.openExternal) {
                    window.electronAPI.openExternal(this._latestUpdateInfo.downloadUrl)
                } else {
                    window.open(this._latestUpdateInfo.downloadUrl, '_blank')
                }
            }
            this.closeUpdateModal()
        })
    }

    async initUpdateService() {
        await updater.init()
        if (this.dom.appVersionBadgeSidebar) {
            this.dom.appVersionBadgeSidebar.innerText = `v${updater.currentVersion}`
        }
        if (this.dom.updateCurrentVersion) {
            this.dom.updateCurrentVersion.innerText = `v${updater.currentVersion}`
        }

        // Silent background check after 8s on startup
        setTimeout(async () => {
            await this.handleCheckForUpdates(true)
        }, 8000)
    }

    openUpdateModal(info) {
        if (!this.dom.modalUpdateDialog) return
        this._latestUpdateInfo = info
        if (this.dom.updateModalTitle) {
            this.dom.updateModalTitle.innerText = info.releaseTitle || '发现新版本'
        }
        const cleanCurrent = (info.currentVersion || '').replace(/^[vV]/, '')
        const cleanLatest = (info.latestVersion || '').replace(/^[vV]/, '')
        if (this.dom.updateCurrentVersion) {
            this.dom.updateCurrentVersion.innerText = `v${cleanCurrent}`
        }
        if (this.dom.updateLatestVersion) {
            this.dom.updateLatestVersion.innerText = `v${cleanLatest}`
        }
        if (this.dom.updatePublishedDate) {
            this.dom.updatePublishedDate.innerText = info.publishedAt || new Date().toLocaleDateString()
        }
        if (this.dom.updateReleaseNotes) {
            this.dom.updateReleaseNotes.innerText = info.releaseNotes || '包含常规性能优化与问题修复。'
        }

        this.dom.modalUpdateDialog.style.display = 'flex'
        requestAnimationFrame(() => {
            this.dom.modalUpdateDialog.classList.add('show')
        })
    }

    closeUpdateModal() {
        if (!this.dom.modalUpdateDialog) return
        this.dom.modalUpdateDialog.classList.remove('show')
        setTimeout(() => {
            this.dom.modalUpdateDialog.style.display = 'none'
        }, 200)
    }

    async handleCheckForUpdates(silent = false) {
        if (!silent && this.dom.btnCheckUpdates) {
            this.dom.btnCheckUpdates.disabled = true
            if (this.dom.btnCheckUpdatesText) this.dom.btnCheckUpdatesText.innerText = '正在检查更新...'
        }

        try {
            const res = await updater.checkForUpdates()
            if (res.success) {
                if (res.hasUpdate) {
                    this.openUpdateModal(res)
                } else if (!silent) {
                    this.showToast(`🎉 当前已是最新版本 (v${res.currentVersion})`, '✓')
                }
            } else if (!silent) {
                this.showToast(res.error || '检查更新失败', '⚠️')
            }
        } catch (err) {
            if (!silent) {
                this.showToast(`检查更新出错: ${err.message}`, '⚠️')
            }
        } finally {
            if (!silent && this.dom.btnCheckUpdates) {
                this.dom.btnCheckUpdates.disabled = false
                if (this.dom.btnCheckUpdatesText) this.dom.btnCheckUpdatesText.innerText = '检查更新'
            }
        }
    }
}

// Expose modules to global window for accessibility and diagnostics
window.db = db
window.tracker = tracker
window.quoteCard = quoteCard

// Initialize Application on DOM Ready or immediately if DOMContentLoaded already fired
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
        window.app = new UniversalReaderApp()
        window.readerApp = window.app
    })
} else {
    window.app = new UniversalReaderApp()
    window.readerApp = window.app
}
