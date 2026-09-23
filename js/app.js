// app.js - Linden Leaf Core Application

export const APP_BUILD_VER = '20260914_rel_v1'

import '../foliate-js-main/view.js?v=20260914_rel_v1'
import { Overlayer } from '../foliate-js-main/overlayer.js?v=20260914_rel_v1'
import * as db from './db.js?v=20260914_rel_v1'
import { tracker } from './tracker.js?v=20260914_rel_v1'
import { quoteCard, THEMES } from './quote-card.js?v=20260914_rel_v1'
import * as syncEngine from './syncEngine.js?v=20260914_rel_v1'
import { updater } from './updater.js?v=20260914_rel_v1'
import { PdfViewport } from './pdf-viewport.js'
import { AdaptivePdfDriver } from './pdf-driver.js'
import { buildPdfTocIndex, pdfTocAtPage } from './pdf-toc.js'
import { platformBridge } from './platformBridge.js'

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

/**
 * Decode PDF saved progress with exact boundary math
 * Ensures N=10, f=0.3 -> page 3; N=1, f=1 -> page 1; avoids floor offset
 */
export function decodePdfProgress(savedProgress, totalPages) {
    if (!totalPages || totalPages <= 0) return { page: 1, fraction: 0 }
    if (typeof savedProgress?.page === 'number' && savedProgress.page >= 1) {
        const page = Math.min(totalPages, Math.max(1, Math.round(savedProgress.page)))
        return { page, fraction: page / totalPages }
    }
    if (typeof savedProgress?.fraction === 'number' && savedProgress.fraction > 0) {
        const f = Math.min(1, Math.max(0, savedProgress.fraction))
        const page = Math.min(totalPages, Math.max(1, Math.ceil(f * totalPages - 1e-5)))
        return { page, fraction: f }
    }
    return { page: 1, fraction: 0 }
}

// Object URL Lifecycle Pool with LRU Eviction to prevent Blob memory bloat
class ObjectUrlPool {
    constructor(maxCapacity = 120) {
        this.cache = new Map()
        this.maxCapacity = maxCapacity
    }
    get(key, blob) {
        if (!blob) return ''
        if (this.cache.has(key)) {
            const existing = this.cache.get(key)
            // Refresh LRU order (delete & re-insert)
            this.cache.delete(key)
            this.cache.set(key, existing)
            return existing
        }
        // Evict oldest entry when capacity is reached to prevent memory growth
        if (this.cache.size >= this.maxCapacity) {
            const oldestKey = this.cache.keys().next().value
            if (oldestKey !== undefined) {
                this.revoke(oldestKey)
            }
        }
        try {
            const url = URL.createObjectURL(blob)
            this.cache.set(key, url)
            return url
        } catch (e) {
            console.warn('[ObjectUrlPool] Failed creating object URL:', e)
            return ''
        }
    }
    revoke(key) {
        if (this.cache.has(key)) {
            try {
                URL.revokeObjectURL(this.cache.get(key))
            } catch (e) {}
            this.cache.delete(key)
        }
    }
    clear() {
        for (const url of this.cache.values()) {
            try {
                URL.revokeObjectURL(url)
            } catch (e) {}
        }
        this.cache.clear()
    }
}
const coverUrlPool = new ObjectUrlPool(120)

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
    
    // Classical Vertical Writing Mode Rules
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
        /* Prevent forced blank pages on section start */
        body > :first-child,
        body > :first-child > :first-child,
        body > div:first-child > :first-child,
        h1.kindle-cn-copyright-title,
        [class*="copyright-title"],
        [class*="copyright_title"] {
            page-break-before: avoid !important;
            break-before: avoid !important;
            -webkit-column-break-before: avoid !important;
        }
        /* SVG & Cover Image Proportion Preservation */
        svg, svg:has(image) {
            max-width: 100% !important;
            max-height: 100% !important;
        }
        svg image {
            object-fit: contain !important;
        }
        h1.chapter-title {
            margin-top: 1.5em !important;
            margin-bottom: 0.5em !important;
        }
        p.chapter-subtitle {
            margin-top: 0 !important;
            margin-bottom: 1.5em !important;
        }
        /* Neutralize publisher hardcoded background colors that clash with reader theme */
        .kuai, .body, [class*="banner"], [class*="block-bg"] {
            background-color: transparent !important;
        }
        /* Constrain oversized percentage margins on title cards to prevent spilling into empty 2nd page */
        .kuai {
            margin-top: 15vh !important;
            margin-bottom: 2em !important;
            padding: 1em 0 !important;
            background: transparent !important;
        }
    `

    // Declarative Theme & Font Configuration Presets
    const THEME_PALETTES = {
        light: { text: '#1a1815', link: '#da7756', bg: 'transparent', selection: 'rgba(218, 119, 86,  0.22)' },
        sepia: { text: '#3b2e1e', link: '#b45309', bg: 'transparent', selection: 'rgba(217, 119, 6, 0.26)' },
        dark:  { text: '#edece6', link: '#d97757', bg: 'transparent', selection: 'rgba(217, 119, 87, 0.28)' },
        black: { text: '#cccccc', link: '#a1a1aa', bg: 'transparent', selection: 'rgba(96, 165, 250, 0.36)' },
        green: { text: '#1b4d1d', link: '#2e7d32', bg: 'transparent', selection: 'rgba(16, 185, 129, 0.25)' },
        eink:  { text: '#000000', link: '#000000', bg: 'transparent', selection: 'rgba(0, 0, 0, 0.18)' },
        warm:  { text: '#292524', link: '#da7756', bg: 'transparent', selection: 'rgba(218, 119, 86,  0.22)' }
    }

    const FONT_PRESETS = {
        serif: '"Lora", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif CJK SC", "思源宋体", "Songti SC", "SimSun-ExtB", "STSong", "SimSun", serif',
        sans:  '"Plus Jakarta Sans", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "思源黑体", "Microsoft YaHei", "微软雅黑", "PingFang SC", "SimHei", sans-serif',
        kaiti: '"LXGW WenKai Screen", "LXGW WenKai", "霞鹜文楷", "STKaiti", "Kaiti SC", "KaiTi", "楷体", serif',
        mono:  '"Cascadia Code", "Fira Code", Consolas, Menlo, Monaco, "Courier New", monospace'
    }

    const activeTheme = THEME_PALETTES[theme] || THEME_PALETTES.light
    const textColor = activeTheme.text
    const linkColor = activeTheme.link
    const bgColor = activeTheme.bg
    const selectionBg = activeTheme.selection
    const fontFamily = FONT_PRESETS[font] || FONT_PRESETS.serif

    return `
        @namespace epub "http://www.idpf.org/2007/ops";
        ${verticalStyles}
        html, body {
            color-scheme: light dark;
            text-spacing-trim: space-first;
            text-autospace: normal;
            font-synthesis: weight style;
            -webkit-font-smoothing: antialiased;
        }
        *, *::before, *::after, body, p, div, span, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, em, strong, i, b, a, section, article {
            font-family: ${fontFamily} !important;
            letter-spacing: ${letterSpacing}px !important;
            font-feature-settings: "palt" 1, "kern" 1;
        }
        pre, code, kbd, samp {
            font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace !important;
            font-feature-settings: normal !important;
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
            text-spacing-trim: space-first;
            text-autospace: normal;
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
        [data-reader-heading], [data-poetry-line], [data-has-media], [data-has-dropcap],
        p:has(> img), p:has(> svg), p:has(> picture), div:has(> img), div:has(> svg),
        p:has(> .dropcap), p:has(> [class*="dropcap" i]), p:has(> [class*="first-letter" i]),
        .dropcap, [class*="dropcap" i], [class*="first-letter" i],
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

        /* 4. Target Calibre / Pandoc / Kindle dummy page-break markers directly in CSS */
        :is([id*="calibre_pb" i], [class*="calibre_pb" i], .calibre_pb, .mbp_pagebreak, [class*="mbp_pagebreak" i], div.mbp_pagebreak):empty,
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

        /* Clean responsive table layout inside multi-column pages */
        table {
            max-width: 100% !important;
            border-collapse: collapse !important;
            margin: 1.2em auto !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
        }
        th, td {
            padding: 0.35em 0.6em;
            word-break: break-word;
        }

        /* Preformatted code & verse wrapping */
        pre, code {
            white-space: pre-wrap !important;
            word-break: break-all !important;
            overflow-wrap: break-word !important;
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
        [style*="color:#000" i], [style*="color: #000" i],
        [style*="color:#111" i], [style*="color: #111" i],
        [style*="color:#222" i], [style*="color: #222" i],
        [style*="color:#333" i], [style*="color: #333" i],
        [style*="color:black" i], [style*="color: black" i] {
            color: ${textColor} !important;
        }
        [style*="background:white" i], [style*="background: white" i],
        [style*="background:#fff" i], [style*="background: #fff" i],
        [style*="background-color:white" i], [style*="background-color: white" i],
        [style*="background-color:#fff" i], [style*="background-color: #fff" i] {
            background-color: transparent !important;
            background: transparent !important;
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
            max-height: 92vh !important;
            height: auto !important;
            object-fit: contain !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
        }
        img[id*="filepos"], img[id^="fn"], img[id^="note"], [id*="filepos"]:not(body):not(html) {
            cursor: pointer !important;
        }
        ::selection, *::selection {
            background: ${selectionBg} !important;
            color: inherit !important;
        }

        /* Hide EPUB 3 / HTML5 / Duokan Footnotes & Endnotes Content Blocks from regular text flow */
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
        ol.duokan-footnote-content,
        li.duokan-footnote-item,
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
        a.duokan-footnote,
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
        a.epub-footnote img,
        img.duokan-footnote,
        img.qqreader-footnote,
        img.zy-footnote,
        img.dd-footnote,
        *[data-wr-footernote],
        *[zy-footnote],
        a.duokan-footnote img {
            vertical-align: super;
            display: inline-block;
            cursor: pointer !important;
            opacity: 0.85;
            width: 14px;
            height: 14px;
            transition: transform 0.15s ease, opacity 0.15s ease;
        }
        sup a:hover img.epub-footnote,
        a.epub-footnote:hover img,
        a.duokan-footnote:hover img,
        img.duokan-footnote:hover,
        img.qqreader-footnote:hover,
        img.zy-footnote:hover,
        img.dd-footnote:hover,
        sup a:hover {
            opacity: 1;
            transform: scale(1.2);
        }

        /* Typography & Layout Normalization */
        li, li p {
            text-indent: 0 !important;
        }
        p:has(> br) {
            text-indent: 0 !important;
        }
        h1, h2, h3, h4, h5, h6 {
            break-after: avoid;
        }
        table img {
            max-inline-size: 100% !important;
        }
    `
}

class UniversalReaderApp {
    constructor() {
        this.currentBookId = null
        this.currentBookData = null
        this.foliateView = null
        this.pdfViewport = null
        this.pdfDriver = null
        this.activeDrawer = null
        this.activeTab = 'toc'
        this.currentSearchResults = []
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
        this.selectedTextInfo = null
        this.clickedHighlightInfo = null
        this.currentLocation = null

        // Shelf UI state (Startup always defaults to Modern Hero Grid & collapsed sidebar)
        this.shelfViewMode = 'grid' // 'grid' (Modern Two-Screen Grid), 'shelf' (Skeuomorphic), 'list' (Table)
        this.shelfCategory = 'all' // 'all', 'unread', 'finished'
        this.sortField = 'addedAt' // 'title', 'author', 'language', 'size', 'lastReadAt', 'addedAt'
        this.sortOrder = 'desc' // 'asc', 'desc'
        this.searchQuery = ''
        this.currentBooksList = []
        this._activeTransfers = new Set()
        this.sidebarUserCollapsed = true
        this.isGliding = false
        this.cachedShelfHeight = 0

        // Reader typography preferences
        let initialTheme = 'light'
        try { initialTheme = localStorage.getItem('linden_leaf_theme') || 'light' } catch (e) {}
        this.settings = {
            theme: initialTheme,
            font: 'serif', // Default to Adobe Source Han Serif
            fontSize: 18,
            fontWeight: 400,
            lineHeight: 1.6,
            margin: 48,
            maxWidth: 760,
            gap: 6,
            columnCount: '2',
            layout: 'paginated',
            writingMode: 'horizontal',
            justify: true,
            hyphenate: true,
            realisticPen: true,
            fullscreenAutohide: false,
            shelfViewMode: 'shelf',
            enableReadingGoals: false,
            readingGoalYear: 12,
            readingGoalMonth: 20,
            readingGoalToday: 45
        }

        // WeChat Read Stats State
        this.statsViewMode = 'month' // 'week', 'month', 'year', 'total'
        this.statsYear = new Date().getFullYear()
        this.statsMonth = new Date().getMonth() + 1
        this.statsWeekOffset = 0

        // Custom Reading Lists State
        this.customLists = []
        this.selectedListIcon = 'book'
        this.managingBookId = null
        this.iconDefs = [
            { id: 'book', label: '典籍', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' },
            { id: 'bookmark', label: '书签', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
            { id: 'feather', label: '笔耕', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg>' },
            { id: 'coffee', label: '慢读', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>' },
            { id: 'star', label: '精选', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
            { id: 'idea', label: '新知', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>' },
            { id: 'compass', label: '漫游', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>' },
            { id: 'target', label: '研读', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>' },
            { id: 'sparkles', label: '灵感', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>' },
            { id: 'leaf', label: '随笔', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>' },
            { id: 'scroll', label: '文史', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/></svg>' },
            { id: 'tag', label: '标签', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>' },
            { id: 'hourglass', label: '长读', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>' },
            { id: 'briefcase', label: '专业', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>' },
            { id: 'palette', label: '美学', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>' },
            { id: 'archive', label: '封存', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>' }
        ]

        // PDF Freehand Drawing & OCR State
        this.pdfDrawTool = null // 'marker' | 'pen' | 'eraser' | null
        this.pdfDrawColor = 'rgba(250, 204, 21, 0.45)'
        this.pdfDrawWidth = 18
        this.currentPdfPageIndex = 0
        this.pdfOverlayCanvas = null

        this.initDOM()
        this.bindEvents()
        this.clearSearchState(true)

        // Persist reading progress & session time when the window is closed
        // directly (main process waits briefly for this before destroying)
        window.electronAPI?.onFlushBeforeQuit?.(() => this.flushReaderStateOnExit())

        this.checkFirstTimeUser()
        this.loadSettings().then(async () => {
            this.applyTheme(this.settings.theme)
            await this.ensureRecoveryBarrier()
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
            await this.initSyncService()
        })
    }

    async ensureRecoveryBarrier() {
        if (!this._recoveryBarrierPromise) {
            this._recoveryBarrierPromise = (async () => {
                let progressResult = null
                let trackerResult = null
                try {
                    progressResult = await db.recoverPendingProgressBackup()
                } catch (e) {
                    console.warn('[App] Error recovering progress backup:', e)
                    progressResult = { recovered: [], filtered: [], failed: [{ error: e }], deferred: [] }
                }
                try {
                    trackerResult = await tracker.recoverPendingBackup()
                } catch (e) {
                    console.warn('[App] Error recovering tracker backup:', e)
                    trackerResult = { recovered: [], filtered: [], failed: [{ error: e }], deferred: [] }
                }
                const failedProgressBooks = new Set((progressResult?.failed || []).map(f => f.bookId || f.data?.bookId).filter(Boolean))
                return {
                    progress: progressResult,
                    tracker: trackerResult,
                    hasFailed: (progressResult?.failed?.length > 0) || (trackerResult?.failed?.length > 0),
                    failedProgressBooks,
                    canProceedSafely: (bookId) => {
                        if (!bookId) return true
                        return !failedProgressBooks.has(bookId)
                    }
                }
            })()
        }
        return this._recoveryBarrierPromise
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
            btnHeaderSettings: document.getElementById('btn-header-settings'),
            booksShelf: document.getElementById('books-shelf'),
            bookContainer: document.getElementById('reader-content-area'),

            // Skeuomorphic & Modern Bookshelf
            booksGrid: document.getElementById('books-grid'),
            modernGridWrapper: document.getElementById('modern-grid-wrapper'),
            modernHeroThreshold: document.getElementById('modern-hero-threshold'),
            heroGreetingTitle: document.getElementById('hero-greeting-title'),
            heroGreetingSubtitle: document.getElementById('hero-greeting-subtitle'),
            heroBookShowcase: document.getElementById('hero-book-showcase'),
            heroKpiTodayTime: document.getElementById('hero-kpi-today-time'),
            heroKpiStreak: document.getElementById('hero-kpi-streak'),
            heroKpiFinished: document.getElementById('hero-kpi-finished'),
            heroScrollHint: document.getElementById('hero-scroll-hint'),
            modernShelfScreen: document.getElementById('modern-shelf-screen'),
            modernShelfDivider: document.getElementById('modern-shelf-divider'),
            btnBackToHero: document.getElementById('btn-back-to-hero'),
            modernGridBookCount: document.getElementById('modern-grid-book-count'),
            booksTableContainer: document.getElementById('books-table-container'),
            booksTableBody: document.getElementById('books-table-body'),
            booksWorkspace: document.querySelector('.jane-content-workspace'),
            mainArea: document.querySelector('.jane-main-area'),
            shelfHeaderActions: document.getElementById('shelf-header-actions'),
            footerStatus: document.querySelector('.jane-footer-status'),
            bookCountFooter: document.getElementById('book-count-footer'),
            navCategoryItems: document.querySelectorAll('.jane-sidebar .nav-item'),
            currentCategoryTitle: document.getElementById('current-category-title'),
            btnSidebarCollapse: document.getElementById('btn-sidebar-collapse'),
            btnHeaderExpandSidebar: document.getElementById('btn-header-expand-sidebar'),
            btnSidebarSettings: document.getElementById('btn-sidebar-settings'),
            sidebarUserSection: document.getElementById('sidebar-user-section'),

            // WeChat Read Stats Dashboard & P2/P3 Analytics
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
            statsLiteraryText: document.getElementById('stats-literary-text'),
            statsGoalsRow: document.getElementById('stats-goals-row'),
            goalRingYear: document.getElementById('goal-ring-year'),
            goalPctYear: document.getElementById('goal-pct-year'),
            goalSubYear: document.getElementById('goal-sub-year'),
            goalRingMonth: document.getElementById('goal-ring-month'),
            goalPctMonth: document.getElementById('goal-pct-month'),
            goalSubMonth: document.getElementById('goal-sub-month'),
            goalRingToday: document.getElementById('goal-ring-today'),
            goalPctToday: document.getElementById('goal-pct-today'),
            goalSubToday: document.getElementById('goal-sub-today'),
            cardGoalYear: document.getElementById('card-goal-year'),
            cardGoalMonth: document.getElementById('card-goal-month'),
            cardGoalToday: document.getElementById('card-goal-today'),
            settingEnableReadingGoals: document.getElementById('setting-enable-reading-goals'),
            goalsCustomInputsWrap: document.getElementById('goals-custom-inputs-wrap'),
            settingGoalYear: document.getElementById('setting-goal-year'),
            settingGoalMonth: document.getElementById('setting-goal-month'),
            settingGoalToday: document.getElementById('setting-goal-today'),

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
            btnResetTypography: document.getElementById('btn-reset-typography'),

            // Image Enhancement (GPU accelerated scanner & PDF filters)
            imgBrightnessSlider: document.getElementById('setting-img-brightness'),
            imgBrightnessValue: document.getElementById('value-img-brightness'),
            imgContrastSlider: document.getElementById('setting-img-contrast'),
            imgContrastValue: document.getElementById('value-img-contrast'),
            imgGrayscaleSwitch: document.getElementById('setting-img-grayscale'),
            imgInvertSwitch: document.getElementById('setting-img-invert'),
            btnResetImgEnhance: document.getElementById('btn-reset-img-enhance'),

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
            btnWelcomeSkip: document.getElementById('btn-welcome-skip'),
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

    getUserDisplayName() {
        const stored = (localStorage.getItem('linden_user_name') || '').trim()
        if (stored && stored !== 'Linden 读者' && stored !== '我的书架' && stored !== '读者') {
            return stored
        }
        if (this.syncConfig?.username) {
            const syncUser = (this.syncConfig.username || '').trim()
            if (syncUser) {
                return syncUser.includes('@') ? syncUser.split('@')[0] : syncUser
            }
        }
        return '读者'
    }

    updateUserProfileDisplay() {
        const displayName = this.getUserDisplayName()
        const isCustom = displayName !== '读者'

        const el = document.getElementById('user-display-name') || document.getElementById('sidebar-username') || document.querySelector('.sidebar-username')
        const avatarEl = document.getElementById('user-avatar-icon') || document.getElementById('sidebar-user-avatar-char') || document.querySelector('.sidebar-user-avatar')
        if (el) {
            el.innerText = displayName
            el.title = displayName
        }
        if (avatarEl) {
            avatarEl.innerText = displayName ? displayName.charAt(0).toUpperCase() : 'R'
        }
        if (this.dom?.settingUserName && !this.dom.settingUserName.matches(':focus')) {
            this.dom.settingUserName.value = isCustom ? displayName : ''
        }
    }

    checkFirstTimeUser() {
        const isInit = localStorage.getItem('linden_user_initialized')
        if (window.electronAPI?.syncGetConfig && !this.syncConfig) {
            window.electronAPI.syncGetConfig().then(cfg => {
                if (cfg) {
                    this.syncConfig = cfg
                    this.updateUserProfileDisplay()
                }
            }).catch(() => {})
        }
        this.updateUserProfileDisplay()
        const currentName = this.getUserDisplayName()
        if (this.dom.settingUserName) {
            this.dom.settingUserName.value = currentName !== '读者' ? currentName : ''
        }
        if (this.dom.quoteUserNameInput) {
            this.dom.quoteUserNameInput.value = currentName
        }
        if (!isInit && this.dom.welcomeModalBackdrop) {
            if (currentName !== '读者') {
                localStorage.setItem('linden_user_initialized', 'true')
                return
            }
            this.dom.welcomeModalBackdrop.style.display = 'flex'
            this.dom.welcomeModalBackdrop.classList.add('show')
            if (this.dom.welcomeUsernameInput) {
                this.dom.welcomeUsernameInput.value = ''
                setTimeout(() => {
                    this.dom.welcomeUsernameInput?.focus()
                    this.dom.welcomeUsernameInput?.select()
                }, 100)
            }
        }
    }

    showToast(msg, icon = 'info', duration = 2500) {
        if (!this.dom.globalToast) return
        if (this._toastTimer) clearTimeout(this._toastTimer)
        if (typeof icon === 'number') {
            duration = icon
            icon = 'info'
        }

        const toastSvgMap = {
            'success': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            'error': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            'warning': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            'info': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-purple, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
            'cloud': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#6a9bcc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>',
            'book': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-purple, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
            'delete': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
            'list': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-purple, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>'
        }

        // Automatic mapping from legacy emojis
        let mappedKey = 'info'
        if (icon === '⚠️') mappedKey = 'warning'
        else if (icon === '🔴' || icon === 'error') mappedKey = 'error'
        else if (icon === '🟢' || icon === '🎉' || icon === '✓' || icon === '🌱' || icon === 'success') mappedKey = 'success'
        else if (icon === '🗑️' || icon === 'delete') mappedKey = 'delete'
        else if (icon === '☁️' || icon === 'cloud') mappedKey = 'cloud'
        else if (icon === '📖' || icon === 'book') mappedKey = 'book'
        else if (icon === '📑' || icon === 'list') mappedKey = 'list'
        else if (toastSvgMap[icon]) mappedKey = icon

        if (this.dom.globalToastIcon) {
            this.dom.globalToastIcon.innerHTML = toastSvgMap[mappedKey] || toastSvgMap['info']
        }
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

    showInputDialog({ title = '输入内容', placeholder = '', value = '', isMultiline = false, hideInput = false, confirmText = '确定', cancelText = '取消' }) {
        return new Promise(resolve => {
            if (!this.dom.globalModalBackdrop) {
                const res = prompt(title, value)
                return resolve(res)
            }

            // Cleanup any previously active instance and resolve its pending
            // promise with null, so awaiters never hang forever
            if (this._inputDialogCleanup) {
                this._inputDialogCleanup()
                this._inputDialogCleanup = null
                if (this._inputDialogActiveClose) {
                    const prevClose = this._inputDialogActiveClose
                    this._inputDialogActiveClose = null
                    prevClose(null)
                }
            }

            if (this.dom.globalModalTitle) this.dom.globalModalTitle.innerText = title
            if (this.dom.globalModalInput) {
                this.dom.globalModalInput.placeholder = placeholder
                this.dom.globalModalInput.value = value || ''
                this.dom.globalModalInput.rows = isMultiline ? 4 : 2
                this.dom.globalModalInput.style.display = hideInput ? 'none' : ''
            }
            if (this.dom.globalModalConfirm) this.dom.globalModalConfirm.innerText = confirmText
            if (this.dom.globalModalCancel) this.dom.globalModalCancel.innerText = cancelText

            let isResolved = false
            const close = (result) => {
                if (isResolved) return
                isResolved = true
                if (this._inputDialogActiveClose === close) this._inputDialogActiveClose = null
                this.dom.globalModalBackdrop?.classList.remove('show')
                setTimeout(() => {
                    if (this.dom.globalModalBackdrop && !this.dom.globalModalBackdrop.classList.contains('show')) {
                        this.dom.globalModalBackdrop.style.display = 'none'
                    }
                }, 200)
                cleanup()
                resolve(result)
            }
            this._inputDialogActiveClose = close

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

    showConfirmDialog(title, message = '') {
        return this.showInputDialog({
            title: message ? `${title}\n${message}` : title,
            hideInput: true,
            confirmText: '确定',
            cancelText: '取消'
        }).then(result => result != null)
    }

    async loadSettings() {
        const saved = await db.getSetting('readerSettings')
        if (saved) {
            this.settings = { ...this.settings, ...saved }
        }
        // Always default to Modern Hero Grid on application startup
        this.shelfViewMode = 'grid'
        try {
            if (this.settings.theme) localStorage.setItem('linden_leaf_theme', this.settings.theme)
            localStorage.setItem('linden_leaf_view_mode', 'grid')
        } catch (e) {}
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
        try {
            if (this.settings.theme) localStorage.setItem('linden_leaf_theme', this.settings.theme)
            if (this.shelfViewMode) localStorage.setItem('linden_leaf_view_mode', this.shelfViewMode)
        } catch (e) {}
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
            this.dom.layoutSelect.value = this.settings.layout || 'paginated'
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
        if (this.dom.settingEnableReadingGoals) {
            this.dom.settingEnableReadingGoals.checked = !!this.settings.enableReadingGoals
        }
        if (this.dom.goalsCustomInputsWrap) {
            this.dom.goalsCustomInputsWrap.style.display = this.settings.enableReadingGoals ? 'block' : 'none'
        }
        if (this.dom.statsGoalsRow) {
            this.dom.statsGoalsRow.style.display = this.settings.enableReadingGoals ? 'grid' : 'none'
        }
        if (this.dom.settingGoalYear) {
            this.dom.settingGoalYear.value = this.settings.readingGoalYear || 12
        }
        if (this.dom.settingGoalMonth) {
            this.dom.settingGoalMonth.value = this.settings.readingGoalMonth || 20
        }
        if (this.dom.settingGoalToday) {
            this.dom.settingGoalToday.value = this.settings.readingGoalToday || 45
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
            try { localStorage.setItem('linden_leaf_view_mode', mode) } catch (e) {}
            this.updateSettingsUI()
            await this.saveSettings()
            await this.refreshBookshelf()

            const activeEl = mode === 'shelf' ? this.dom.booksShelf : (mode === 'grid' ? this.dom.modernGridWrapper : this.dom.booksTableContainer)
            if (activeEl) {
                activeEl.classList.remove('view-spring-transition')
                void activeEl.offsetWidth
                activeEl.classList.add('view-spring-transition')
                setTimeout(() => activeEl.classList.remove('view-spring-transition'), 360)
            }
        }
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme)
        let bg = '#FAF9F5'
        if (theme === 'dark' || theme === 'black') bg = '#262624'
        else if (theme === 'sepia') bg = '#f5eedc'
        document.documentElement.style.backgroundColor = bg
        if (document.body) document.body.style.backgroundColor = bg
        try { localStorage.setItem('linden_leaf_theme', theme) } catch (e) {}
        this.settings.theme = theme
        this.applySettingsToReader()
    }

    applySettingsToReader() {
        if (!this.foliateView || !this.foliateView.renderer) return
        const r = this.foliateView.renderer
        
        if (this.foliateView.isFixedLayout) {
            this.dom.btnPdfSpreadToggle?.classList.toggle('active', this.settings.columnCount === '2')
            if (r.setSpread && this.foliateView.lastLocation != null) {
                r.setSpread(this.settings.columnCount || '1')
            }
        } else {
            // Pass margin, max-inline-size, max-column-count, gap, flow to paginator
            if (r.setAttribute) {
                r.setAttribute('flow', this.settings.layout || 'paginated')
                r.setAttribute('margin', `${this.settings.margin || 48}px`)
                r.setAttribute('max-inline-size', `${this.settings.maxWidth || 760}px`)
                r.setAttribute('max-column-count', this.settings.columnCount || '2')
                r.setAttribute('gap', `${this.settings.gap || 6}%`)
            }
        }

        // Pass CSS inside iframe
        const css = buildContentCSS(this.settings)
        if (r.setStyles) {
            r.setStyles(css)
        }
    }

    bindEvents() {
        this.initShelfDelegatedListeners()

        // Bookshelf actions
        this.dom.btnImport?.addEventListener('click', async () => {
            if (window.electronAPI?.openFileDialog) {
                try {
                    const fileItems = await window.electronAPI.openFileDialog()
                    if (fileItems && fileItems.length > 0) {
                        const total = fileItems.length
                        let successCount = 0
                        for (let i = 0; i < total; i++) {
                            const f = fileItems[i]
                            let nativeSnapshotPath = null
                            try {
                                if (total > 1) {
                                    this.showToast(`正在导入 (${i + 1}/${total}): ${f.filename}...`, '⏳')
                                }
                                nativeSnapshotPath = await platformBridge.stagePdfSource(f.filePath)
                                let buffer = nativeSnapshotPath ? await platformBridge.readFileBuffer(nativeSnapshotPath) : null
                                if (!buffer || buffer.byteLength === 0 || buffer.length === 0) {
                                    if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                                        platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                                    }
                                    nativeSnapshotPath = null
                                    buffer = f.buffer || (window.electronAPI.readFileBuffer ? await window.electronAPI.readFileBuffer(f.filePath) : null)
                                }
                                if (buffer) {
                                    if (Array.isArray(buffer)) {
                                        buffer = new Uint8Array(buffer).buffer
                                    } else if (ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
                                        buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
                                    } else if (typeof buffer.arrayBuffer === 'function') {
                                        buffer = await buffer.arrayBuffer()
                                    }
                                    const fileObj = new File([buffer], f.filename)
                                    await this.processAndSaveBook(fileObj, undefined, f.filePath, nativeSnapshotPath)
                                    successCount++
                                } else {
                                    if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                                        platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                                    }
                                    console.warn('[Import] Failed to read buffer for file:', f.filePath)
                                    this.showToast(`无法读取文件: ${f.filename}`, '⚠️')
                                }
                            } catch (itemErr) {
                                if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                                    platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                                }
                                console.error(`[Import] Failed to import ${f.filename}:`, itemErr)
                                this.showToast(`导入 ${f.filename} 失败: ${itemErr.message || itemErr}`, '⚠️')
                            }
                        }
                        await this.refreshBookshelf()
                        if (total > 1) {
                            this.showToast(`成功导入 ${successCount}/${total} 本图书`, '✓')
                        }
                    }
                } catch (dialogErr) {
                    console.error('[Import] Dialog error:', dialogErr)
                    this.showToast('打开文件选择对话框失败', '⚠️')
                }
            } else {
                this.dom.fileInput?.click()
            }
        })
        this.dom.fileInput?.addEventListener('change', e => this.handleFileSelect(e))

        // Application Close & Flush Lifecycle Integration (Tauri & Electron)
        platformBridge.onFlushRequest(async requestId => {
            await this.flushReaderStateOnExit(requestId)
        })
        platformBridge.onFlushBeforeQuit(async () => {
            await this.flushReaderStateOnExit()
        })

        // OS File Association Listener with complete UI & lifecycle tear-down and serialized queue
        this._fileOpenQueue = Promise.resolve()
        const handleOpenFile = (fileInfo) => {
            this._fileOpenQueue = this._fileOpenQueue.then(async () => {
                if (!fileInfo) return
                let nativeSnapshotPath = null
                try {
                    nativeSnapshotPath = await platformBridge.stagePdfSource(fileInfo.filePath)
                    let buf = nativeSnapshotPath ? await platformBridge.readFileBuffer(nativeSnapshotPath) : fileInfo.buffer
                    if (!buf || buf.byteLength === 0 || buf.length === 0) {
                        if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                            platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                        }
                        nativeSnapshotPath = null
                    }
                    if ((!buf || buf.byteLength === 0 || buf.length === 0) && fileInfo.filePath && platformBridge.readFileBuffer) {
                        buf = await platformBridge.readFileBuffer(fileInfo.filePath)
                    }
                    if (!buf || (buf.byteLength === 0 && buf.length === 0)) return
                    if (Array.isArray(buf)) {
                        buf = new Uint8Array(buf).buffer
                    } else if (ArrayBuffer.isView(buf) && !(buf instanceof ArrayBuffer)) {
                        buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
                    } else if (typeof buf.arrayBuffer === 'function') {
                        buf = await buf.arrayBuffer()
                    }
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

                    const fileObj = new File([buf], fileInfo.filename)
                    const bookId = await this.processAndSaveBook(fileObj, undefined, fileInfo.filePath, nativeSnapshotPath)
                    if (bookId) {
                        await this.openBook(bookId)
                    }
                } catch (err) {
                    if (nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                        platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                    }
                    console.error('Failed to open file from OS event:', err)
                }
            }).catch(err => {
                console.error('[App] Error in file open queue:', err)
            })
        }

        const unsubOpenFile = platformBridge.onOpenFile(handleOpenFile)
        // Ensure listener is registered before signaling backend readiness
        if (unsubOpenFile?.ready) {
            unsubOpenFile.ready.then(() => platformBridge.rendererReady().catch(() => {}))
        } else {
            platformBridge.rendererReady().catch(() => {})
        }
        this.dom.btnShelfSettings?.addEventListener('click', () => this.openDrawer('settings'))
        this.setupSyncEventListeners()
        this.setupUpdateEventListeners()
        this.initUpdateService()

        // Welcome Onboarding Save
        const handleWelcomeSave = () => {
            const name = this.dom.welcomeUsernameInput?.value.trim()
            if (name) {
                localStorage.setItem('linden_user_name', name)
            }
            localStorage.setItem('linden_user_initialized', 'true')
            if (this.dom.welcomeModalBackdrop) {
                this.dom.welcomeModalBackdrop.classList.remove('show')
                setTimeout(() => {
                    this.dom.welcomeModalBackdrop.style.display = 'none'
                }, 180)
            }
            this.updateUserProfileDisplay()
            const displayName = this.getUserDisplayName()
            if (this.dom.settingUserName) this.dom.settingUserName.value = displayName !== '读者' ? displayName : ''
            if (this.dom.quoteUserNameInput) this.dom.quoteUserNameInput.value = displayName
            if (quoteCard) quoteCard.userName = displayName
            if (this.dom.heroGreetingTitle && this.shelfCategory === 'all') {
                const greetingData = this.getDynamicGreeting()
                this.dom.heroGreetingTitle.innerText = greetingData.title
                this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
            }
            this.showToast(displayName !== '读者' ? `✨ 欢迎您，${displayName}！祝您阅读愉快` : '✨ 欢迎使用 Linden Leaf！祝您阅读愉快', '🌱')
        }
        this.dom.btnWelcomeConfirm?.addEventListener('click', handleWelcomeSave)
        this.dom.welcomeUsernameInput?.addEventListener('keydown', e => {
            if (e.key === 'Enter') handleWelcomeSave()
        })
        const handleWelcomeSkip = () => {
            localStorage.setItem('linden_user_initialized', 'true')
            if (this.dom.welcomeModalBackdrop) {
                this.dom.welcomeModalBackdrop.classList.remove('show')
                setTimeout(() => {
                    this.dom.welcomeModalBackdrop.style.display = 'none'
                }, 180)
            }
            this.updateUserProfileDisplay()
        }
        this.dom.btnWelcomeSkip?.addEventListener('click', handleWelcomeSkip)

        // Setting User Name Input
        this.dom.settingUserName?.addEventListener('input', e => {
            const name = e.target.value.trim()
            if (name) {
                localStorage.setItem('linden_user_name', name)
            } else {
                localStorage.removeItem('linden_user_name')
            }
            const displayName = this.getUserDisplayName()
            if (this.dom.quoteUserNameInput) this.dom.quoteUserNameInput.value = displayName
            if (quoteCard) quoteCard.userName = displayName
            this.updateUserProfileDisplay()
            if (this.dom.heroGreetingTitle && this.shelfCategory === 'all') {
                const greetingData = this.getDynamicGreeting()
                this.dom.heroGreetingTitle.innerText = greetingData.title
                this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
            }
        })

        // Click sidebar user info to open settings
        document.getElementById('sidebar-user-info')?.addEventListener('click', () => {
            this.openDrawer('settings')
            setTimeout(() => {
                this.dom.settingUserName?.focus()
                this.dom.settingUserName?.select()
            }, 200)
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
            const titles = { all: '全部图书', favorite: '收藏的书', unread: '待读清单', finished: '已读完', stats: '阅读统计' }
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

        // Window resize adaptive layout for shelf, dimension cache, and PDF drawing overlay
        this.updateCachedDimensions = () => {
            const target = this.dom.modernShelfScreen || this.dom.modernShelfDivider
            this.cachedShelfHeight = target ? target.offsetTop : (window.innerHeight - 54)
        }
        this.updateCachedDimensions()

        let resizeTimer = null
        window.addEventListener('resize', () => {
            this.updateCachedDimensions()
            clearTimeout(resizeTimer)
            resizeTimer = setTimeout(() => {
                if (this.shelfViewMode === 'shelf' && this.dom.bookshelfView?.style.display !== 'none') {
                    if (this.currentBooksList) this.renderBooksShelf(this.currentBooksList)
                } else if (this.currentBookId && (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf')) {
                    this.renderPdfDrawingOverlayForCurrentPage()
                }
            }, 120)
        }, { passive: true })

        // When focusing header search bar on Screen 1, smoothly glide down to Screen 2 to show books
        this.dom.shelfSearch?.addEventListener('focus', () => {
            if (this.shelfViewMode === 'grid' && this.dom.booksWorkspace && this.dom.booksWorkspace.scrollTop < 40) {
                this.glideToShelf()
            }
        })

        // Sidebar Collapse & Expand Toggle (Interactive user toggle)
        // User requested: first screen / default on load should NOT have the sidebar (collapsed by default)
        this.sidebarUserCollapsed = true
        this.dom.btnSidebarCollapse?.addEventListener('click', () => {
            this.sidebarUserCollapsed = true
            document.getElementById('bookshelf-view')?.classList.add('sidebar-collapsed')
            try { localStorage.setItem('linden_leaf_sidebar_collapsed', '1') } catch (e) {}
        })
        this.dom.btnHeaderExpandSidebar?.addEventListener('click', () => {
            this.sidebarUserCollapsed = false
            document.getElementById('bookshelf-view')?.classList.remove('sidebar-collapsed')
            try { localStorage.setItem('linden_leaf_sidebar_collapsed', '0') } catch (e) {}
        })
        // Sidebar is always collapsed by default on application launch
        this.sidebarUserCollapsed = true
        document.getElementById('bookshelf-view')?.classList.add('sidebar-collapsed')
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.getElementById('bookshelf-view')?.classList.remove('notransition')
            })
        })

        // Sidebar Settings Button & Bottom Profile Card Click
        const handleOpenSidebarSettings = () => this.openDrawer('settings')
        this.dom.btnSidebarSettings?.addEventListener('click', (e) => {
            e.stopPropagation()
            handleOpenSidebarSettings()
        })
        this.dom.sidebarUserSection?.addEventListener('click', (e) => {
            handleOpenSidebarSettings()
        })

        // Category switching
        this.dom.navCategoryItems?.forEach(item => {
            item.addEventListener('click', () => {
                const wasAll = this.shelfCategory === 'all'
                this.dom.navCategoryItems.forEach(i => i.classList.remove('active'))
                document.querySelectorAll('.custom-list-nav-item').forEach(i => i.classList.remove('active'))
                item.classList.add('active')
                this.shelfCategory = item.dataset.category
                const titles = { all: '全部图书', favorite: '收藏的书', unread: '待读清单', finished: '已读完', stats: '阅读统计' }

                if (this.shelfCategory === 'all') {
                    const isAtTop = !this.dom.booksWorkspace || this.dom.booksWorkspace.scrollTop <= 100
                    if (isAtTop) {
                        if (this.dom.currentCategoryTitle) {
                            this.dom.currentCategoryTitle.innerText = ''
                            this.dom.currentCategoryTitle.style.display = 'none'
                        }
                    } else {
                        if (this.dom.currentCategoryTitle) {
                            this.dom.currentCategoryTitle.innerText = '全部图书'
                            this.dom.currentCategoryTitle.style.display = 'block'
                        }
                    }
                    if (wasAll && this.shelfViewMode === 'grid') {
                        this.glideToHero()
                    }
                } else {
                    if (this.dom.currentCategoryTitle) {
                        this.dom.currentCategoryTitle.innerText = titles[this.shelfCategory] || '全部图书'
                        this.dom.currentCategoryTitle.style.display = 'block'
                    }
                }
                
                if (this.shelfCategory === 'stats') {
                    if (this.dom.booksWorkspace) {
                        this.dom.booksWorkspace.scrollTop = 0
                    }
                    this.dom.mainArea?.classList.add('stats-view-active')
                    this.dom.mainArea?.classList.remove('wood-shelf-active')
                    this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
                    if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
                    if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
                    if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
                    if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
                    if (this.dom.statsDashboardContainer) {
                        this.dom.statsDashboardContainer.style.display = 'block'
                        this.dom.statsDashboardContainer.classList.remove('view-spring-transition')
                        void this.dom.statsDashboardContainer.offsetWidth
                        this.dom.statsDashboardContainer.classList.add('view-spring-transition')
                    }
                    if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
                    if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
                    if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'none'
                    this.renderStatsDashboard()
                } else {
                    this.dom.mainArea?.classList.remove('stats-view-active')
                    const wasStats = this.dom.statsDashboardContainer && this.dom.statsDashboardContainer.style.display !== 'none'
                    if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
                    if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
                    if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'
                    if (wasStats) {
                        const targetContainer = this.shelfViewMode === 'grid' ? this.dom.modernGridWrapper : this.dom.booksTableContainer
                        if (targetContainer) {
                            targetContainer.classList.remove('view-spring-transition')
                            void targetContainer.offsetWidth
                            targetContainer.classList.add('view-spring-transition')
                        }
                    }
                    if (this.dom.booksWorkspace) {
                        this.dom.booksWorkspace.scrollTop = 0
                    }
                    this.refreshBookshelf()
                }
            })
        })

        // Dynamic scroll watcher to switch header title between "正在阅读" and "全部图书"
        if (this.dom.booksWorkspace) {
            let scrollTicking = false
            this.dom.booksWorkspace.addEventListener('scroll', () => {
                if (!scrollTicking) {
                    requestAnimationFrame(() => {
                        this.onBooksWorkspaceScroll()
                        scrollTicking = false
                    })
                    scrollTicking = true
                }
            }, { passive: true })

            // Intentional Wheel Detection between Screen 1 (Hero Lounge) and Screen 2 (Book Shelf Grid)
            // Eliminates "首屏下滑进入第二屏的速度快的离谱" by replacing instant snap with 800ms velvety glide
            let wheelDeltaAccumulator = 0
            let wheelResetTimer = null

            this.dom.booksWorkspace.addEventListener('wheel', (e) => {
                if (this.shelfCategory !== 'all' || this.shelfViewMode !== 'grid') return
                if (!this.dom.modernHeroThreshold || this.dom.modernHeroThreshold.style.display === 'none') return

                if (this.isGliding) {
                    e.preventDefault()
                    return
                }

                const scrollTop = this.dom.booksWorkspace.scrollTop
                const shelfTop = this.cachedShelfHeight || (window.innerHeight - 52)

                // Screen 1: Hero Lounge (top)
                if (scrollTop < 40) {
                    if (e.deltaY > 0) {
                        wheelDeltaAccumulator += e.deltaY
                        clearTimeout(wheelResetTimer)
                        wheelResetTimer = setTimeout(() => {
                            wheelDeltaAccumulator = 0
                        }, 240)

                        if (wheelDeltaAccumulator > 38) {
                            e.preventDefault()
                            wheelDeltaAccumulator = 0
                            this.glideToShelf()
                        }
                    } else {
                        wheelDeltaAccumulator = 0
                    }
                } 
                // Screen 2: At the very top of the shelf
                else if (scrollTop <= shelfTop + 4) {
                    if (e.deltaY < 0) {
                        wheelDeltaAccumulator += e.deltaY
                        clearTimeout(wheelResetTimer)
                        wheelResetTimer = setTimeout(() => {
                            wheelDeltaAccumulator = 0
                        }, 240)

                        if (wheelDeltaAccumulator < -38) {
                            e.preventDefault()
                            wheelDeltaAccumulator = 0
                            this.glideToHero()
                        }
                    } else {
                        wheelDeltaAccumulator = 0
                    }
                }
            }, { passive: false })
        }



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

        // Reading Goal Cards Interactive Customization
        this.dom.cardGoalYear?.addEventListener('click', async () => {
            const current = this.settings.readingGoalYear || 12
            const val = await this.showInputDialog({
                title: '设定年度阅读目标',
                placeholder: '请输入本年度计划完成的图书数量（本）',
                value: String(current),
                confirmText: '保存目标'
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.settings.readingGoalYear = parsed
                    if (this.dom.settingGoalYear) this.dom.settingGoalYear.value = parsed
                    await this.saveSettings()
                    this.renderStatsDashboard()
                    this.showToast(`年度阅读目标已设定为 ${parsed} 本`, 'success')
                }
            }
        })
        this.dom.cardGoalMonth?.addEventListener('click', async () => {
            const current = this.settings.readingGoalMonth || 20
            const val = await this.showInputDialog({
                title: '设定月度阅读目标',
                placeholder: '请输入本月计划阅读的总时长（小时）',
                value: String(current),
                confirmText: '保存目标'
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.settings.readingGoalMonth = parsed
                    if (this.dom.settingGoalMonth) this.dom.settingGoalMonth.value = parsed
                    await this.saveSettings()
                    this.renderStatsDashboard()
                    this.showToast(`月度阅读目标已设定为 ${parsed} 小时`, 'success')
                }
            }
        })
        this.dom.cardGoalToday?.addEventListener('click', async () => {
            const current = this.settings.readingGoalToday || 45
            const val = await this.showInputDialog({
                title: '设定每日专注目标',
                placeholder: '请输入每日计划专注阅读的时长（分钟）',
                value: String(current),
                confirmText: '保存目标'
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.settings.readingGoalToday = parsed
                    if (this.dom.settingGoalToday) this.dom.settingGoalToday.value = parsed
                    await this.saveSettings()
                    this.renderStatsDashboard()
                    this.showToast(`每日专注目标已设定为 ${parsed} 分钟`, 'success')
                }
            }
        })

        // Reading Goal Enable Toggle
        this.dom.settingEnableReadingGoals?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked
            this.settings.enableReadingGoals = enabled
            await this.saveSettings()
            if (this.dom.goalsCustomInputsWrap) {
                this.dom.goalsCustomInputsWrap.style.display = enabled ? 'block' : 'none'
            }
            if (this.dom.statsGoalsRow) {
                this.dom.statsGoalsRow.style.display = enabled ? 'grid' : 'none'
            }
            if (this.shelfCategory === 'stats') {
                this.renderStatsDashboard()
            }
            this.showToast(enabled ? '已开启阅读目标量化规划' : '已隐藏阅读目标环，保持极简纯粹', 'info')
        })

        // Reading Goal Inputs inside Settings Drawer
        this.dom.settingGoalYear?.addEventListener('change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.settings.readingGoalYear = parsed
                await this.saveSettings()
                if (this.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        })
        this.dom.settingGoalMonth?.addEventListener('change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.settings.readingGoalMonth = parsed
                await this.saveSettings()
                if (this.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        })
        this.dom.settingGoalToday?.addEventListener('change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.settings.readingGoalToday = parsed
                await this.saveSettings()
                if (this.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        })

        // View Mode Switcher
        this.dom.btnViewShelf?.addEventListener('click', () => this.setShelfViewMode('shelf'))
        this.dom.btnViewGrid?.addEventListener('click', () => this.setShelfViewMode('grid'))
        this.dom.btnViewList?.addEventListener('click', () => this.setShelfViewMode('list'))
        this.dom.btnHeaderSettings?.addEventListener('click', () => this.openDrawer('settings'))

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

        this.dom.readerContentArea?.addEventListener('click', e => {
            if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.selection-popup') || e.target.closest('.highlight-action-popup') || e.target.closest('input') || e.target.closest('.nav-arrow-left') || e.target.closest('.nav-arrow-right')) return
            this.toggleReaderUI()
        })

        // Progress Slider (text updates live; actual seek happens on release to avoid
        // re-render storms on large PDFs while dragging)
        this.dom.progressSlider?.addEventListener('input', e => {
            const rawVal = parseFloat(e.target.value)
            if (this.dom.progressText && Number.isFinite(rawVal)) {
                const pctDisplay = rawVal > 0 && rawVal < 100 && rawVal % 1 !== 0
                    ? rawVal.toFixed(1).replace(/\.0$/, '')
                    : `${Math.round(rawVal)}`
                this.dom.progressText.innerText = `${pctDisplay}%`
            }
        })
        this.dom.progressSlider?.addEventListener('change', e => {
            const fraction = parseFloat(e.target.value) / 100
            if (this.pdfViewport && Number.isFinite(fraction)) {
                const totalPages = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 1
                const targetPage = Math.min(totalPages - 1, Math.max(0, Math.floor(fraction * totalPages)))
                this.pdfViewport.goToPage(targetPage)
            } else if (this.foliateView && Number.isFinite(fraction)) {
                this.foliateView.goToFraction(Math.max(0, Math.min(1, fraction)))
            }
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

        this.dom.btnResetTypography?.addEventListener('click', () => {
            this.settings.fontSize = 18
            this.settings.fontWeight = 400
            this.settings.lineHeight = 1.6
            this.settings.margin = 48
            this.settings.maxWidth = 760
            this.settings.gap = 6
            this.settings.letterSpacing = 0
            this.settings.chineseQuotes = false
            this.settings.columnCount = '2'
            this.updateSettingsUI()
            this.saveSettingsDebounced()
            this.showToast('✨ 已将排版与间距恢复为默认设置')
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

        // Image Enhancement Filters (GPU accelerated realtime preview)
        const applyImgFilter = () => {
            const b = this.dom.imgBrightnessSlider?.value || 100
            const c = this.dom.imgContrastSlider?.value || 100
            const isGray = this.dom.imgGrayscaleSwitch?.checked || false
            const isInvert = this.dom.imgInvertSwitch?.checked || false
            
            if (this.dom.imgBrightnessValue) this.dom.imgBrightnessValue.innerText = `${b}%`
            if (this.dom.imgContrastValue) this.dom.imgContrastValue.innerText = `${c}%`

            let filter = `brightness(${b}%) contrast(${c}%)`
            if (isGray) filter += ' grayscale(100%)'
            if (isInvert) filter += ' invert(100%)'

            this.dom.readerContentArea?.style.setProperty('--reader-img-filter', filter)
            document.documentElement?.style.setProperty('--reader-img-filter', filter)
        }

        this.dom.imgBrightnessSlider?.addEventListener('input', applyImgFilter)
        this.dom.imgContrastSlider?.addEventListener('input', applyImgFilter)
        this.dom.imgGrayscaleSwitch?.addEventListener('change', applyImgFilter)
        this.dom.imgInvertSwitch?.addEventListener('change', applyImgFilter)
        this.dom.btnResetImgEnhance?.addEventListener('click', () => {
            if (this.dom.imgBrightnessSlider) this.dom.imgBrightnessSlider.value = 100
            if (this.dom.imgContrastSlider) this.dom.imgContrastSlider.value = 100
            if (this.dom.imgGrayscaleSwitch) this.dom.imgGrayscaleSwitch.checked = false
            if (this.dom.imgInvertSwitch) this.dom.imgInvertSwitch.checked = false
            applyImgFilter()
            this.showToast('✨ 已重置扫描画质增强滤镜')
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
            this.saveSettingsDebounced()
        })

        
        // Writing Mode Toggle (Horizontal vs Vertical-RL)
        const writingModeSelect = document.getElementById('setting-writing-mode')
        if (writingModeSelect) {
            writingModeSelect.value = this.settings.writingMode || 'horizontal'
            writingModeSelect.addEventListener('change', async e => {
                this.settings.writingMode = e.target.value
                this.saveSettings()
                this.applySettingsToReader()
                if (this.foliateView && this.currentBookId) {
                    const loc = this.currentLocation?.cfi || this.currentLocation?.fraction || 0
                    await this.foliateView.goTo(loc)
                }
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
                platformBridge.openExternal(`https://www.baidu.com/s?wd=${query}`)
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
        this.isCurrentlyFullscreen = false
        this.dom.btnToggleFullscreen?.addEventListener('click', () => this.toggleFullscreen())

        const updateFullscreenUI = (isFs) => {
            this.isCurrentlyFullscreen = isFs
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
        }

        document.addEventListener('fullscreenchange', () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement)
            updateFullscreenUI(isFs)
        })

        if (window.electronAPI?.onFullscreenChange) {
            window.electronAPI.onFullscreenChange(isFs => {
                updateFullscreenUI(isFs)
            })
        }

        // Edge proximity handler when in fullscreen with autohide enabled
        const handleFullscreenProximity = (clientY) => {
            const isFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
            if (!isFs || !this.settings.fullscreenAutohide) return
            const winH = window.innerHeight

            if (clientY <= 50) {
                this.dom.readerTopBar?.classList.remove('autohide')
                clearTimeout(this._fsTopTimer)
                this._fsTopTimer = setTimeout(() => {
                    const stillFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
                    if (stillFs && this.settings.fullscreenAutohide) {
                        this.dom.readerTopBar?.classList.add('autohide')
                    }
                }, 3000)
            }
            if (clientY >= winH - 50) {
                this.dom.readerBottomBar?.classList.remove('autohide')
                this.dom.pdfZoomBar?.classList.remove('autohide')
                clearTimeout(this._fsBottomTimer)
                this._fsBottomTimer = setTimeout(() => {
                    const stillFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
                    if (stillFs && this.settings.fullscreenAutohide) {
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
            this.dom.btnPdfSpreadToggle?.classList.toggle('active', nextMode === '2')
            this.saveSettings()
            if (this.foliateView?.renderer?.setSpread) {
                this.foliateView.renderer.setSpread(nextMode)
            }
            setTimeout(() => {
                this.renderPdfDrawingOverlayForCurrentPage?.()
            }, 180)
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
                    this.renderPdfDrawingOverlayForCurrentPage()
                    this.setPdfOverlayDrawingActive(true)
                    const toolName = tool === 'marker' ? '🖍️ 荧光马克笔 (半透明)' : (tool === 'pen' ? '✏️ 批注笔' : '🧹 橡皮擦')
                    this.showToast(`已开启 ${toolName}，可在页面上自由绘制`)
                }
            })
        })

        // PDF Clear Page Drawing
        this.dom.btnPdfClearDraw?.addEventListener('click', async () => {
            if (!this.currentBookId) return
            const activeSession = this._activeSession
            const snapshot = this._currentSnapshot || {}
            const allTargets = this.getAllPdfActiveDocsAndTargets()
            if (allTargets.length > 1) {
                for (const target of allTargets) {
                    const pIdx = target.index != null ? target.index : this.currentPdfPageIndex
                    if (pIdx != null) await db.clearPdfPageDrawing(this.currentBookId, pIdx, true, Date.now(), snapshot)
                }
                if (activeSession && !activeSession.isCurrent()) return
                this.redrawPdfPageOverlay()
                this.showToast('🗑️ 已清空当前双页手绘批注')
            } else if (this.currentPdfPageIndex != null) {
                await db.clearPdfPageDrawing(this.currentBookId, this.currentPdfPageIndex, true, Date.now(), snapshot)
                if (activeSession && !activeSession.isCurrent()) return
                this.redrawPdfPageOverlay()
                this.showToast('🗑️ 已清空当前页手绘批注')
            }
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
            const isFixed = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
            const hasLocationTotal = !isFixed && typeof this.currentLocation?.location?.total === 'number' && this.currentLocation.location.total > 0

            let total, curr, isPercentageMode = false

            if (isFixed) {
                total = this.currentLocation?.totalPages || 1
                curr = this.currentLocation?.page || 1
            } else if (hasLocationTotal) {
                total = this.currentLocation.location.total
                curr = (this.currentLocation.location.current != null) ? this.currentLocation.location.current + 1 : 1
            } else {
                // In reflowable mode before location index is built, operate strictly on whole-book percentage
                isPercentageMode = true
                total = 100
                curr = Math.max(0, Math.min(100, Math.round((this.currentLocation?.fraction || 0) * 100)))
            }

            const title = isPercentageMode 
                ? '📖 快速跳转进度 (1 ~ 100%)' 
                : `📖 快速跳转 (1 ~ ${total} 页 或 百分比)`
            const placeholder = isPercentageMode
                ? '输入 1 到 100 的进度百分比（如 50）'
                : `输入 1 到 ${total} 的页码，或输入百分比（如 50%）`

            const targetStr = await this.showInputDialog({
                title,
                value: String(curr),
                placeholder
            })
            if (targetStr != null && targetStr.trim() !== '') {
                const trimmed = targetStr.trim()
                if (trimmed.endsWith('%')) {
                    const pctVal = parseFloat(trimmed)
                    if (!isNaN(pctVal) && pctVal >= 0 && pctVal <= 100) {
                        if (this.pdfViewport) {
                            const totalPages = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 1
                            const targetPage = Math.min(totalPages - 1, Math.max(0, Math.floor((pctVal / 100) * totalPages)))
                            this.pdfViewport.goToPage(targetPage)
                        } else {
                            this.foliateView?.goToFraction(pctVal / 100)
                        }
                        return
                    }
                }
                const targetPage = parseInt(trimmed, 10)
                const minVal = isPercentageMode ? 0 : 1
                if (!isNaN(targetPage) && targetPage >= minVal && targetPage <= total) {
                    if (this.pdfViewport) {
                        this.pdfViewport.goToPage(targetPage - 1)
                    } else if (this.foliateView) {
                        if (isFixed) {
                            this.foliateView.goTo(targetPage - 1)
                        } else if (isPercentageMode) {
                            this.foliateView.goToFraction(targetPage / 100)
                        } else {
                            const targetFraction = total > 1 ? (targetPage - 1) / (total - 1) : 0
                            this.foliateView.goToFraction(targetFraction)
                        }
                    }
                } else {
                    this.showToast(isPercentageMode ? '请输入有效的进度百分比 (0 ~ 100)' : '请输入有效的页码数字或百分比', '⚠️')
                }
            }
        })

        // Prevent wheel events originating inside drawer or modals from bubbling to reader page flipper
        const stopWheelElements = document.querySelectorAll('#sidebar-drawer, #quote-card-backdrop, #modal-pdf-ocr, .global-modal-backdrop')
        stopWheelElements.forEach(el => {
            el?.addEventListener('wheel', e => {
                e.stopPropagation()
            }, { passive: true })
        })

        // Ctrl + Mouse Wheel Zoom on Reader or Page Flip in Reader
        let outerWheelCooldown = false
        window.addEventListener('wheel', e => {
            // When drawer, quote-card modal, or any dialog is open, do NOT flip reader pages
            const isAnyModalOpen = !!document.querySelector(
                '#quote-card-backdrop:not([style*="display: none"]), #modal-pdf-ocr:not([style*="display: none"]), .global-modal-backdrop:not([style*="display: none"]), .modal-backdrop:not([style*="display: none"]), .modal.show'
            )
            if (this.activeDrawer || isAnyModalOpen || e.target?.closest?.(
                '#sidebar-drawer, #quote-card-backdrop, #quote-card-dialog, .global-modal-backdrop, .global-modal-card, .drawer-body, .drawer-panel, .modal-card, .modal-dialog, .dropdown-menu, .popup-menu, .modal'
            )) {
                return
            }
            if (e.ctrlKey || e.metaKey) {
                if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                    e.preventDefault()
                    this.stepPDFZoom(e.deltaY < 0 ? 10 : -10)
                }
                return
            }
            if (this.dom.readerView?.classList.contains('active') && this.settings.layout !== 'scrolled' && !this.foliateView?.isFixedLayout && this.currentBookData?.format !== 'pdf') {
                e.preventDefault()
                if (outerWheelCooldown) return
                if (Math.abs(e.deltaY) > 20 || Math.abs(e.deltaX) > 20) {
                    outerWheelCooldown = true
                    if (e.deltaY > 0 || e.deltaX > 0) this.turnPageNext()
                    else this.turnPagePrev()
                    setTimeout(() => { outerWheelCooldown = false }, 220)
                }
            }
        }, { passive: false })

        // Keyboard Shortcuts
        document.addEventListener('keydown', e => this.handleGlobalKeydown(e))
    }

    setPDFZoom(zoomVal) {
        if (this.pdfViewport) {
            this.pdfViewport.setZoom(zoomVal)
            let sliderVal = Math.round(this.pdfViewport.scale * 100)
            let displayStr = `${sliderVal}%`
            if (zoomVal === 'fit-width') displayStr = '适宽'
            if (zoomVal === 'fit-page') displayStr = '适页'
            if (this.dom.pdfZoomSlider) this.dom.pdfZoomSlider.value = sliderVal
            if (this.dom.pdfZoomPercentInput) this.dom.pdfZoomPercentInput.value = displayStr
            this.dom.btnPdfFitWidth?.classList.toggle('active', zoomVal === 'fit-width')
            this.dom.btnPdfFitPage?.classList.toggle('active', zoomVal === 'fit-page')
            return
        }
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

        clearTimeout(this._pdfZoomOverlayTimer)
        this._pdfZoomOverlayTimer = setTimeout(() => {
            this.renderPdfDrawingOverlayForCurrentPage?.()
        }, 120)
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
    getAllPdfActiveDocsAndTargets() {
        const results = []
        if (this.pdfViewport?.activeSlots) {
            for (const [pageIdx, slot] of this.pdfViewport.activeSlots.entries()) {
                const canvas = slot.querySelector('canvas:not(.pdf-draw-overlay-canvas)')
                const img = slot.querySelector('img')
                const svg = slot.querySelector('svg')
                results.push({
                    iframe: null,
                    doc: document,
                    canvas,
                    img,
                    svg,
                    container: slot,
                    index: pageIdx
                })
            }
            if (results.length > 0) return results
        }

        if (!this.foliateView) return results

        // 1. Primary: Use Foliate's official public renderer.getContents()
        const contents = this.foliateView.renderer?.getContents?.() || []
        for (const item of contents) {
            if (item?.doc) {
                const doc = item.doc
                const canvas = doc.querySelector('canvas:not(.pdf-draw-overlay-canvas)')
                const img = doc.querySelector('#page-img') || doc.querySelector('img')
                const svg = doc.querySelector('svg')
                const container = doc.getElementById('page-container') || doc.body || doc.documentElement
                results.push({ iframe: item.iframe || null, doc, canvas, img, svg, container, index: item.index })
            }
        }
        if (results.length > 0) return results

        // 2. Fallback: Query iframes in open shadow roots or documents
        const renderer = this.foliateView?.renderer
        let iframes = []
        if (renderer?.shadowRoot) {
            iframes = Array.from(renderer.shadowRoot.querySelectorAll('iframe'))
        }
        if (iframes.length === 0 && this.foliateView?.shadowRoot) {
            iframes = Array.from(this.foliateView.shadowRoot.querySelectorAll('iframe'))
        }
        if (iframes.length === 0) {
            iframes = Array.from(document.querySelectorAll('foliate-fxl iframe, foliate-view iframe'))
        }

        for (let idx = 0; idx < iframes.length; idx++) {
            try {
                const iframe = iframes[idx]
                const doc = iframe.contentDocument
                if (doc) {
                    const canvas = doc.querySelector('canvas:not(.pdf-draw-overlay-canvas)')
                    const img = doc.querySelector('#page-img') || doc.querySelector('img')
                    const svg = doc.querySelector('svg')
                    const container = doc.getElementById('page-container') || doc.body || doc.documentElement
                    results.push({ iframe, doc, canvas, img, svg, container, index: idx })
                }
            } catch (e) {}
        }
        return results
    }

    getPdfActiveDocAndTarget() {
        if (this.pdfViewport) {
            const curPage = this.pdfViewport.currentPage ?? 0
            const slot = this.pdfViewport.activeSlots?.get(curPage)
            if (slot) {
                return {
                    iframe: null,
                    doc: document,
                    canvas: slot.querySelector('canvas:not(.pdf-draw-overlay-canvas)'),
                    img: slot.querySelector('img'),
                    svg: slot.querySelector('svg'),
                    container: slot,
                    index: curPage
                }
            }
        }
        const list = this.getAllPdfActiveDocsAndTargets()
        return list[0] || null
    }

    setPdfOverlayDrawingActive(isActive) {
        const allTargets = this.getAllPdfActiveDocsAndTargets()
        allTargets.forEach(activeObj => {
            if (!activeObj?.doc) return
            const overlayCanvases = activeObj.doc.querySelectorAll('.pdf-draw-overlay-canvas')
            overlayCanvases.forEach(cvs => {
                if (isActive) {
                    cvs.classList.add('is-drawing-active')
                    cvs.style.pointerEvents = 'auto'
                    cvs.style.cursor = 'crosshair'
                } else {
                    cvs.classList.remove('is-drawing-active')
                    cvs.style.pointerEvents = 'none'
                    cvs.style.cursor = 'default'
                }
            })
        })
    }

    async renderPdfDrawingOverlayForCurrentPage() {
        const allTargets = this.getAllPdfActiveDocsAndTargets()
        if (allTargets.length === 0 || !this.currentBookId) return

        for (const activeObj of allTargets) {
            const { doc, container, canvas, img, svg, index } = activeObj
            const targetElement = img || canvas || svg || container
            if (!targetElement || !doc) continue

            const targetPageIndex = (index != null) ? index : this.currentPdfPageIndex
            if (targetPageIndex == null) continue

            container.style.position = 'relative'

            let overlayCanvas = container.querySelector('.pdf-draw-overlay-canvas')
            if (!overlayCanvas) {
                overlayCanvas = doc.createElement('canvas')
                overlayCanvas.className = 'pdf-draw-overlay-canvas'
                if (this.pdfDrawTool) {
                    overlayCanvas.classList.add('is-drawing-active')
                    overlayCanvas.style.pointerEvents = 'auto'
                    overlayCanvas.style.cursor = 'crosshair'
                } else {
                    overlayCanvas.style.pointerEvents = 'none'
                    overlayCanvas.style.cursor = 'default'
                }
                overlayCanvas.style.touchAction = 'none'
                container.appendChild(overlayCanvas)
                this.attachPdfDrawingPointerEvents(overlayCanvas, doc)
            } else {
                if (this.pdfDrawTool) {
                    overlayCanvas.classList.add('is-drawing-active')
                    overlayCanvas.style.pointerEvents = 'auto'
                    overlayCanvas.style.cursor = 'crosshair'
                } else {
                    overlayCanvas.style.pointerEvents = 'none'
                    overlayCanvas.style.cursor = 'default'
                }
            }

            overlayCanvas.dataset.pageIndex = targetPageIndex

            // Match dimensions to target
            const rect = targetElement.getBoundingClientRect()
            const targetWidth = canvas?.width || targetElement.naturalWidth || Math.round(rect.width) || 800
            const targetHeight = canvas?.height || targetElement.naturalHeight || Math.round(rect.height) || 1100

            overlayCanvas.width = targetWidth
            overlayCanvas.height = targetHeight
            overlayCanvas.style.position = 'absolute'
            overlayCanvas.style.top = '0px'
            overlayCanvas.style.left = '0px'
            overlayCanvas.style.width = '100%'
            overlayCanvas.style.height = '100%'
            overlayCanvas.style.zIndex = '50'

            this.pdfOverlayCanvas = overlayCanvas

            // Load and draw saved strokes for this page
            const ctx = overlayCanvas.getContext('2d')
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
            const session = this._activeSession
            const currentBookId = this.currentBookId
            const currentSnapshot = this._currentSnapshot || {}
            const drawingRecord = await db.getPdfPageDrawing(currentBookId, targetPageIndex, currentSnapshot)
            if (session && !session.isCurrent()) return
            if (this.currentBookId !== currentBookId) return
            const strokes = drawingRecord?.strokes || []
            if (targetPageIndex === this.currentPdfPageIndex) {
                this._currentPdfPageStrokes = strokes
            }
            strokes.forEach(stroke => {
                this.drawSingleStrokeOnCanvas(ctx, stroke, overlayCanvas.width, overlayCanvas.height)
            })
        }
    }

    async redrawPdfPageOverlay() {
        const allTargets = this.getAllPdfActiveDocsAndTargets()
        if (allTargets.length === 0 || !this.currentBookId) return

        for (const activeObj of allTargets) {
            if (!activeObj?.doc) continue
            const overlayCanvas = activeObj.doc.getElementById('pdf-page-draw-overlay')
            if (!overlayCanvas) continue

            const targetPageIndex = overlayCanvas.dataset.pageIndex != null 
                ? parseInt(overlayCanvas.dataset.pageIndex, 10) 
                : (activeObj.index != null ? activeObj.index : this.currentPdfPageIndex)
            if (targetPageIndex == null) continue

            const ctx = overlayCanvas.getContext('2d')
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

            const session = this._activeSession
            const currentBookId = this.currentBookId
            const currentSnapshot = this._currentSnapshot || {}
            const drawingRecord = await db.getPdfPageDrawing(currentBookId, targetPageIndex, currentSnapshot)
            if (session && !session.isCurrent()) return
            if (this.currentBookId !== currentBookId) return
            const strokes = drawingRecord?.strokes || []
            if (targetPageIndex === this.currentPdfPageIndex) {
                this._currentPdfPageStrokes = strokes
            }

            strokes.forEach(stroke => {
                this.drawSingleStrokeOnCanvas(ctx, stroke, overlayCanvas.width, overlayCanvas.height)
            })
        }
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

    drawStrokeSegment(ctx, stroke, p1, p2, w, h) {
        if (!p1 || !p2) return
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
        ctx.moveTo(p1[0] * w, p1[1] * h)
        ctx.lineTo(p2[0] * w, p2[1] * h)
        ctx.stroke()
        ctx.restore()
    }

    attachPdfDrawingPointerEvents(canvasElement, doc) {
        let isDrawing = false
        let currentStroke = null
        let gestureBookId = null
        let gesturePageIndex = null

        const getCoords = e => {
            const rect = canvasElement.getBoundingClientRect()
            const w = rect.width || canvasElement.width || 1
            const h = rect.height || canvasElement.height || 1
            return [
                Math.max(0, Math.min(1, (e.clientX - rect.left) / w)),
                Math.max(0, Math.min(1, (e.clientY - rect.top) / h))
            ]
        }

        const handlePointerDown = e => {
            if (!this.pdfDrawTool || !this.currentBookId) return
            // Only primary button (left click / single touch / pen tip)
            if (e.button != null && e.button !== 0) return

            const targetPageIndex = canvasElement.dataset.pageIndex != null 
                ? parseInt(canvasElement.dataset.pageIndex, 10) 
                : this.currentPdfPageIndex
            if (targetPageIndex == null) return

            e.preventDefault()
            e.stopPropagation()

            const session = this._activeSession
            const snapshot = this._currentSnapshot || {}
            gestureBookId = this.currentBookId
            gesturePageIndex = targetPageIndex
            isDrawing = true

            const [nx, ny] = getCoords(e)
            currentStroke = {
                tool: this.pdfDrawTool,
                color: this.pdfDrawColor,
                width: this.pdfDrawWidth,
                points: [[nx, ny]]
            }

            const ctx = canvasElement.getContext('2d')
            this.drawSingleStrokeOnCanvas(ctx, currentStroke, canvasElement.width, canvasElement.height)

            const onDocPointerMove = evt => {
                if (!isDrawing || !currentStroke) return
                evt.preventDefault()
                evt.stopPropagation()

                const [curX, curY] = getCoords(evt)
                const prevPt = currentStroke.points[currentStroke.points.length - 1]
                currentStroke.points.push([curX, curY])

                const moveCtx = canvasElement.getContext('2d')
                this.drawStrokeSegment(moveCtx, currentStroke, prevPt, [curX, curY], canvasElement.width, canvasElement.height)
            }

            const onDocPointerUp = async evt => {
                doc.removeEventListener('pointermove', onDocPointerMove, true)
                doc.removeEventListener('pointerup', onDocPointerUp, true)
                doc.removeEventListener('pointercancel', onDocPointerUp, true)
                window.removeEventListener('pointerup', onDocPointerUp, true)

                if (!isDrawing || !currentStroke) return
                isDrawing = false

                const strokeToSave = currentStroke
                const saveBookId = gestureBookId
                const savePageIndex = gesturePageIndex
                currentStroke = null
                gestureBookId = null
                gesturePageIndex = null

                if (session && !session.isCurrent()) return

                if (strokeToSave.points.length > 0 && saveBookId && savePageIndex != null) {
                    const drawingRecord = await db.getPdfPageDrawing(saveBookId, savePageIndex, snapshot)
                    if (session && !session.isCurrent()) return
                    const existingStrokes = drawingRecord?.strokes || []
                    existingStrokes.push(strokeToSave)
                    await db.savePdfPageDrawing(saveBookId, savePageIndex, existingStrokes, snapshot)
                    if (session && !session.isCurrent()) return
                    if (savePageIndex === this.currentPdfPageIndex) {
                        this._currentPdfPageStrokes = existingStrokes
                    }
                }
                if (session && !session.isCurrent()) return
                await this.redrawPdfPageOverlay()
            }

            doc.addEventListener('pointermove', onDocPointerMove, true)
            doc.addEventListener('pointerup', onDocPointerUp, true)
            doc.addEventListener('pointercancel', onDocPointerUp, true)
            window.addEventListener('pointerup', onDocPointerUp, { once: true, capture: true })
        }

        canvasElement.addEventListener('pointerdown', handlePointerDown)
    }

    // ==========================================================
    // Lightweight On-Demand PDF OCR Text Extraction
    // ==========================================================
    async handlePdfOcrExtract() {
        if (!this.dom.modalPdfOcr) return

        this.dom.modalPdfOcr.style.display = 'flex'
        requestAnimationFrame(() => {
            this.dom.modalPdfOcr?.classList.add('show')
        })
        if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '⏳'
        if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '正在提取当前页面图像并进行文字识别...'
        if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = ''
        if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = '共 0 字'

        try {
            const activeObj = this.getPdfActiveDocAndTarget()

            // 1. Instant extraction: Check if page already has an embedded/OCR text layer
            const textLayerEl = activeObj?.container?.querySelector('.pdf-text-layer, .textLayer') || activeObj?.doc?.querySelector('.pdf-text-layer, .textLayer')
            const existingText = (textLayerEl ? (textLayerEl.innerText || textLayerEl.textContent || '') : '').trim()
            if (existingText.length > 5) {
                if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = existingText
                if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = `共 ${existingText.length} 字`
                if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.innerText = '✅'
                if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = '已提取页面内嵌文本！可在上方选择或点击下方快速复制'
                return
            }

            // 2. Pure scanned bitmap OCR
            let imageSource = null
            if (activeObj?.img) {
                try {
                    const offCanvas = document.createElement('canvas')
                    offCanvas.width = activeObj.img.naturalWidth || activeObj.img.width || 1200
                    offCanvas.height = activeObj.img.naturalHeight || activeObj.img.height || 1600
                    const offCtx = offCanvas.getContext('2d')
                    offCtx.drawImage(activeObj.img, 0, 0)
                    imageSource = offCanvas.toDataURL('image/png')
                } catch (imgErr) {
                    imageSource = activeObj.img.src
                }
            } else if (activeObj?.canvas) {
                imageSource = activeObj.canvas
            } else if (activeObj?.doc) {
                const anyCanvas = activeObj.doc.querySelector('canvas')
                if (anyCanvas) imageSource = anyCanvas
            }

            if (!imageSource) {
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
                workerPath: './vendor/tesseract/worker.min.js',
                corePath: 'https://npmmirror.com/mirrors/tesseract.js-core/v4.0.4/tesseract-core.wasm.js',
                langPath: 'https://npmmirror.com/mirrors/tessdata/4.0.0'
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
            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = `识别提示: ${err.message || '网络连接超时或语言包加载受限'}`
        }
    }

    closePdfOcrModal() {
        if (this.dom.modalPdfOcr) {
            this.dom.modalPdfOcr.classList.remove('show')
            setTimeout(() => {
                if (this.dom.modalPdfOcr) this.dom.modalPdfOcr.style.display = 'none'
            }, 200)
        }
    }

    extractFootnoteFromTarget(targetEl, anchorEl = null) {
        if (!targetEl) return ''

        // Never treat chapter headings or TOC navigation containers as footnotes
        if (targetEl.matches?.('h1, h2, h3, h4, h5, h6') || targetEl.closest?.('h1, h2, h3, h4, h5, h6, nav, .toc, #toc')) {
            return ''
        }

        // 1. If target element is an empty anchor/span or inline tag with text <= 4, climb up to enclosing block
        let containerEl = targetEl
        const isInline = ['a', 'span', 'small', 'sup', 'sub', 'b', 'i', 'strong', 'em', 'img'].includes(targetEl.tagName?.toLowerCase())
        const textLen = (targetEl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length
        if (isInline || textLen <= 4) {
            const parentBlock = targetEl.closest('li, p, blockquote, dd, aside, div.footnote, div.note, [class*="note" i], [class*="fn" i], div')
            if (parentBlock && (parentBlock.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length > 4) {
                containerEl = parentBlock
            } else if (targetEl.matches('dt') && targetEl.nextElementSibling?.matches('dd')) {
                containerEl = targetEl.nextElementSibling
            }
        } else if (targetEl.matches('dt') && targetEl.nextElementSibling?.matches('dd')) {
            containerEl = targetEl.nextElementSibling
        }

        // 2. Clone to safely manipulate DOM without mutating reader document
        const clone = containerEl.cloneNode(true)

        // 3. Strip backlink anchors, return arrows, and tiny nav markers
        // CRITICAL: Only remove tiny backlink return markers (e.g. ↩, ^, [1], return icon).
        // NEVER remove anchor tags that wrap substantial footnote text (e.g. Duokan EPUBs where the entire footnote paragraph is inside <a href="#fnref...">).
        clone.querySelectorAll('a[href]').forEach(bl => {
            const txt = (bl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            const isTinyNav = txt.length <= 4 || /^[\[（(【]?\s*(?:[\u21a9\u2190\u23ce\^↩←↑]|返回|back)\s*[\]）)】]?$/i.test(txt)
            if (isTinyNav) {
                bl.remove()
            }
        })

        // 4. Extract text preserving multi-paragraph structure if present
        const pEls = Array.from(clone.querySelectorAll('p, div, li, dd'))
        let raw = ''
        if (pEls.length > 1) {
            raw = pEls.map(p => (p.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()).filter(Boolean).join('\n\n')
        } else {
            raw = (clone.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        }

        // 5. Clean leading bracketed/circled numbers (e.g. [1], 1., ㉗, 45., [注1])
        raw = raw.replace(/^[\[（(【]?(?:\d+|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注\s*\d*)[\]）)】]?\s*[.、:：\-]?\s*/, '').trim()

        const fallback = (containerEl.textContent || containerEl.innerText || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        return raw || fallback
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
        this.hideFootnotePopup()
        if (this.pdfViewport) {
            const total = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 1
            const cur = this.pdfViewport.currentPage ?? 0
            if (cur < total - 1) {
                this.pdfViewport.goToPage(cur + 1)
            }
            return
        }
        if (!this.foliateView) return
        if (typeof this.foliateView.goRight === 'function') {
            this.foliateView.goRight()
        } else if (typeof this.foliateView.next === 'function') {
            this.foliateView.next()
        }
    }

    turnPagePrev() {
        this.hideFootnotePopup()
        if (this.pdfViewport) {
            const cur = this.pdfViewport.currentPage ?? 0
            if (cur > 0) {
                this.pdfViewport.goToPage(cur - 1)
            }
            return
        }
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
            if (this.dom.footnotePopup && this.dom.footnotePopup.style.display !== 'none') {
                this.hideFootnotePopup()
                return
            }
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
                this.closeBatchAddToListModal()
                return
            }
            if (this.activeDrawer) {
                this.closeDrawer()
                return
            }
        }

        if (this.dom.bookshelfView.style.display === 'none') {
            // If any drawer (settings/toc/notes/search) is currently open, do not trigger reader page flips
            if (this.activeDrawer) {
                return
            }

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
                return modalBackdrops.some(m => m && m.classList?.contains('show'))
            }

            if (isModalActive()) {
                return
            }

            switch (e.key) {
                case 'ArrowUp': {
                    e.preventDefault()
                    if (this.pdfViewport?.scrollArea) {
                        this.pdfViewport.scrollArea.scrollBy({ top: -90, behavior: 'smooth' })
                    } else {
                        const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                        if (container && container.scrollHeight > container.clientHeight + 10) {
                            container.scrollBy({ top: -90, behavior: 'smooth' })
                        } else {
                            this.turnPagePrev()
                        }
                    }
                    break
                }
                case 'ArrowDown': {
                    e.preventDefault()
                    if (this.pdfViewport?.scrollArea) {
                        this.pdfViewport.scrollArea.scrollBy({ top: 90, behavior: 'smooth' })
                    } else {
                        const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                        if (container && container.scrollHeight > container.clientHeight + 10) {
                            container.scrollBy({ top: 90, behavior: 'smooth' })
                        } else {
                            this.turnPageNext()
                        }
                    }
                    break
                }
                case 'ArrowLeft':
                case 'PageUp':
                case 'h':
                case 'H':
                case 'k':
                case 'K':
                    if (e.ctrlKey || e.metaKey || e.altKey) return
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
                    if (e.ctrlKey || e.metaKey || e.altKey) return
                    e.preventDefault()
                    this.turnPageNext()
                    break
                case 'f':
                case 'F':
                    e.preventDefault()
                    if (e.ctrlKey || e.metaKey) {
                        this.openDrawer('search')
                    } else {
                        this.toggleFullscreen()
                    }
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
                    } else if (this.isCurrentlyFullscreen || document.fullscreenElement || document.webkitFullscreenElement) {
                        this.toggleFullscreen()
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
        const isFixed = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
        const pageIndex = isFixed
            ? (this.currentLocation?.page || '')
            : (this.currentLocation?.location?.current != null ? this.currentLocation.location.current + 1 : (this.currentLocation?.page || ''))

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
            void this.dom.quoteCardBackdrop.offsetHeight
            this.dom.quoteCardBackdrop.classList.add('show')
        }

        // Render Canvas Preview
        await this.updateQuoteCardPreview()
    }

    closeQuoteCardModal() {
        if (this.dom.quoteCardBackdrop) {
            this.dom.quoteCardBackdrop.classList.remove('show')
            setTimeout(() => {
                if (this.dom.quoteCardBackdrop) this.dom.quoteCardBackdrop.style.display = 'none'
            }, 200)
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
        const total = files.length
        let successCount = 0
        for (let i = 0; i < total; i++) {
            const file = files[i]
            try {
                if (total > 1) {
                    this.showToast(`正在导入 (${i + 1}/${total}): ${file.name}...`, '⏳')
                }
                await this.processAndSaveBook(file)
                successCount++
            } catch (err) {
                console.error(`Failed to import file ${file.name}:`, err)
                this.showToast(`导入书籍 ${file.name} 失败: ${err.message || err}`, '⚠️')
            }
        }
        await this.refreshBookshelf()
        if (total > 1) {
            this.showToast(`成功导入 ${successCount}/${total} 本图书`, '✓')
        }
    }

    async processAndSaveBook(file, customFileName, nativePath = null, nativeSnapshotPath = null) {
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
            const { makeBook } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
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
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
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
            
            const bAuthor = (b.author || '').trim().toLowerCase()
            const metaAuthor = (metadata.author || '').trim().toLowerCase()
            const isKnownAuthor = metaAuthor && !metaAuthor.includes('未知') && !metaAuthor.includes('unknown')
            const isKnownBAuthor = bAuthor && !bAuthor.includes('未知') && !bAuthor.includes('unknown')

            // If both books have distinct, known authors, they are definitely different books!
            if (isKnownAuthor && isKnownBAuthor && bAuthor !== metaAuthor) {
                return false
            }

            // Accurate match: match by identifier, size, author, or exact filename
            if (metadata.identifier && b.identifier && metadata.identifier === b.identifier) {
                return true
            }
            if (b.size && file.size && b.size === file.size) {
                return true
            }
            if (isKnownAuthor && bAuthor && bAuthor === metaAuthor) {
                return true
            }
            if (b.filename && fileName && b.filename.toLowerCase() === fileName.toLowerCase()) {
                return true
            }
            return false
        })

        if (match) {
            console.log(`[processAndSaveBook] Found existing book record: ${match.title} (${match.id})`)
            await db.saveBook({ id: match.id, blob: file, nativePath, nativeSnapshotPath, filename: fileName, isCloudOnly: false, hasLocalFile: true, updatedAt: Date.now() })
            if (!match.coverBlob && coverBlob) {
                await db.saveBook({ id: match.id, coverBlob })
            }
            return match.id
        }

        const rawIdent = metadata.identifier
        const isEphemeral = typeof rawIdent === 'string' && /^(txt|docx|pdf)-\d{10,}$/.test(rawIdent)
        const validIdent = isEphemeral ? null : rawIdent
        const stableKey = validIdent || `${metadata.title || ''}_${file.size || 0}_${format}`.replace(/\s+/g, '').toLowerCase()
        const bookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const bookRecord = {
            id: bookId,
            stableKey,
            identifier: validIdent,
            title: metadata.title,
            author: metadata.author,
            language: metadata.language || '中文',
            format: format,
            filename: fileName,
            size: file.size,
            blob: file,
            nativePath,
            nativeSnapshotPath,
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
            const { makeBook } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
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
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
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
            coverUrlPool.revoke(book.id)
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
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
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

        this._bookshelfRefreshEpoch = (this._bookshelfRefreshEpoch || 0) + 1
        const currentRefreshEpoch = this._bookshelfRefreshEpoch

        let books = await db.getAllBooks()
        if (this._bookshelfRefreshEpoch !== currentRefreshEpoch) {
            return
        }
        
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
            let valA = a[this.sortField]
            let valB = b[this.sortField]

            if (this.sortField === 'progress') {
                valA = a.progress?.fraction ?? 0
                valB = b.progress?.fraction ?? 0
            } else if (this.sortField === 'lastReadAt') {
                valA = a.lastReadAt || a.updatedAt || a.addedAt || 0
                valB = b.lastReadAt || b.updatedAt || b.addedAt || 0
            } else if (this.sortField === 'addedAt') {
                valA = a.addedAt || a.createdAt || a.updatedAt || 0
                valB = b.addedAt || b.createdAt || b.updatedAt || 0
            }

            const isNullA = valA == null || valA === ''
            const isNullB = valB == null || valB === ''
            if (isNullA && isNullB) return 0
            if (isNullA) return 1
            if (isNullB) return -1

            let res = 0
            if (typeof valA === 'string' || typeof valB === 'string') {
                res = String(valA).localeCompare(String(valB), 'zh-CN')
            } else {
                res = (valA > valB ? 1 : (valA < valB ? -1 : 0))
            }
            return this.sortOrder === 'asc' ? res : -res
        })

        this.currentBooksList = books

        // 4. Update count footer
        this.dom.bookCountFooter.innerText = `${books.length} 本图书`

        // 5. Render active view
        if (this.shelfViewMode === 'shelf') {
            this.dom.mainArea?.classList.add('wood-shelf-active')
            this.dom.booksWorkspace?.classList.add('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'flex'
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            else if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'flex'
            this.renderBooksShelf(books)
        } else if (this.shelfViewMode === 'grid') {
            this.dom.mainArea?.classList.remove('wood-shelf-active')
            this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
            if (this.dom.modernGridWrapper) {
                this.dom.modernGridWrapper.style.display = 'flex'
                if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'grid'
            } else if (this.dom.booksGrid) {
                this.dom.booksGrid.style.display = 'grid'
            }
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'none'
            this.renderModernThreshold(books)
            this.renderBooksGrid(books)
            this.onBooksWorkspaceScroll()
        } else {
            this.dom.mainArea?.classList.remove('wood-shelf-active')
            this.dom.booksWorkspace?.classList.remove('wood-shelf-theme')
            if (this.dom.booksShelf) this.dom.booksShelf.style.display = 'none'
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            else if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'block'
            if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'flex'
            this.renderBooksTable(books)
        }
    }

    initShelfDelegatedListeners() {
        if (this._shelfDelegatedInitialized) return
        this._shelfDelegatedInitialized = true

        const handleShelfClick = async e => {
            const target = e.target
            if (!target) return

            // 1. Favorite button
            const favBtn = target.closest('.skeuo-fav-btn, .grid-fav-btn, .table-fav-btn')
            if (favBtn) {
                e.stopPropagation()
                const card = favBtn.closest('.skeuo-book, .jane-book-card, .jane-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                favBtn.classList.remove('is-pop-animating')
                void favBtn.offsetWidth
                favBtn.classList.add('is-pop-animating')
                favBtn.addEventListener('animationend', () => {
                    favBtn.classList.remove('is-pop-animating')
                }, { once: true })

                const isFav = await db.toggleBookFavorite(bookId)
                const book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (book) book.isFavorite = isFav

                favBtn.classList.toggle('active', isFav)
                favBtn.title = isFav ? '取消收藏' : '加入收藏'

                const coverBox = card.querySelector('.skeuo-book-cover, .jane-cover-box')
                if (coverBox) coverBox.classList.toggle('is-favorite', isFav)
                if (favBtn.classList.contains('table-fav-btn')) {
                    favBtn.className = `table-fav-btn ${isFav ? 'active' : ''}`
                    favBtn.style.color = isFav ? '#f59e0b' : 'var(--text-tertiary)'
                }

                const bookTitle = book?.title || '图书'
                this.showToast(isFav ? `⭐ 已将《${bookTitle}》加入收藏` : `已取消《${bookTitle}》收藏`, '⭐')
                if (this.shelfCategory === 'favorite') {
                    this.refreshBookshelf()
                }
                return
            }

            // 2. Cloud button
            const cloudBtn = target.closest('.skeuo-cloud-btn, .grid-cloud-btn, .table-cloud-btn')
            if (cloudBtn) {
                e.stopPropagation()
                const card = cloudBtn.closest('.skeuo-book, .jane-book-card, .jane-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                cloudBtn.classList.remove('is-pop-animating')
                void cloudBtn.offsetWidth
                cloudBtn.classList.add('is-pop-animating')
                cloudBtn.addEventListener('animationend', () => {
                    cloudBtn.classList.remove('is-pop-animating')
                }, { once: true })

                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (!book) return

                if (book.isCloudOnly) {
                    this.handleCloudBookClick(book)
                } else {
                    this.handleUploadBookToCloud(book)
                }
                return
            }

            // 3. List button
            const listBtn = target.closest('.skeuo-list-btn, .grid-list-btn, .table-list-btn')
            if (listBtn) {
                e.stopPropagation()
                const card = listBtn.closest('.skeuo-book, .jane-book-card, .jane-table-row')
                const bookId = card?.dataset?.id
                if (bookId) {
                    this.openManageBookListsModal(bookId)
                }
                return
            }

            // 4. Delete button
            const delBtn = target.closest('.skeuo-delete-btn, .grid-delete-btn, .table-delete-btn')
            if (delBtn) {
                e.stopPropagation()
                const card = delBtn.closest('.skeuo-book, .jane-book-card, .jane-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (book) {
                    this.handleDeleteBook(book)
                }
                return
            }

            // 5. Open book
            const card = target.closest('.skeuo-book, .jane-book-card, .jane-table-row')
            if (card) {
                const bookId = card.dataset.id
                if (!bookId) return
                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (book?.isCloudOnly) {
                    this.handleCloudBookClick(book)
                } else {
                    this.openBook(bookId)
                }
            }
        }

        this.dom.booksShelf?.addEventListener('click', handleShelfClick)
        this.dom.booksGrid?.addEventListener('click', handleShelfClick)
        this.dom.booksTableBody?.addEventListener('click', handleShelfClick)
    }

    renderBooksShelf(books) {
        if (!this.dom.booksShelf) return
        const container = this.dom.booksShelf
        container.innerHTML = ''

        if (books.length === 0) {
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFinishedView = this.shelfCategory === 'finished'
            let svgIcon = ''
            if (isFavView) {
                svgIcon = `<svg style="width: 44px; height: 44px; stroke-width: 1.5; color: #e5e7eb; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
            } else if (isCustomList) {
                svgIcon = `<svg style="width: 44px; height: 44px; stroke-width: 1.5; color: #e5e7eb; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`
            } else if (isFinishedView) {
                svgIcon = `<svg style="width: 44px; height: 44px; stroke-width: 1.5; color: #e5e7eb; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
            } else {
                svgIcon = `<svg style="width: 44px; height: 44px; stroke-width: 1.5; color: #e5e7eb; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
            }
            let emptyTitle = isFavView ? '暂无收藏图书' : (isCustomList ? '此书单暂无图书' : (isFinishedView ? '暂无已读完的图书' : '书架虚席以待'))
            let emptySub = isFavView ? '点击任意书籍封面左上角的小星标即可收藏' : (isCustomList ? '点击右上角「+」或在图书卡片上点击 📑 即可加入此书单' : (isFinishedView ? '当读完一本书（阅读进度达到 100%）时，它会自动归档在此' : '拖拽电子书到此处，或点击右上角「+」导入图书'))

            container.innerHTML = `
                <div class="wood-shelf-empty-state">
                    <div class="empty-book-icon" style="display: flex; justify-content: center; margin-bottom: 0.6rem;">${svgIcon}</div>
                    <h3 style="font-family: var(--font-serif); font-size: 1.15rem; font-weight: 600;">${emptyTitle}</h3>
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
            const rowOffset = r * booksPerRow
            rowBooks.forEach((book, idxInRow) => {
                const bookEl = this.createSkeuomorphicBookElement(book, rowOffset + idxInRow)
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

    createSkeuomorphicBookElement(book, cardIndex = 0) {
        const card = document.createElement('div')
        card.className = 'skeuo-book'
        card.dataset.id = book.id
        card.style.setProperty('--card-index', cardIndex)

        const fraction = book.progress?.fraction || 0
        const rawPct = fraction * 100
        const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
        
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

        const isCloud = !!book.isCloudOnly
        const hasBackup = !!(book.cloudBackup?.hasBackup)
        const cloudBtnClass = hasBackup ? 'synced' : ''
        const cloudBtnTitle = hasBackup ? '已备份至坚果云' : (isCloud ? '存于坚果云 (点击拉取)' : '备份至坚果云')

        let skeuoCloudBadge = ''
        if (isCloud) {
            const fmtStr = escapeHTML((book.format || 'doc').toUpperCase())
            const sizeStr = book.size ? (book.size >= 1048576 ? (book.size / 1048576).toFixed(1) + 'MB' : (book.size / 1024).toFixed(0) + 'KB') : ''
            skeuoCloudBadge = `<div class="skeuo-cloud-badge ${book.format === 'pdf' ? 'is-pdf' : ''}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:3px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>待拉取 · ${fmtStr} ${sizeStr ? sizeStr : ''}</div>`
        }

        const favActive = book.isFavorite ? 'active' : ''
        const favClass = book.isFavorite ? 'is-favorite' : ''
        const favTitle = book.isFavorite ? '取消收藏' : '加入收藏'

        card.innerHTML = `
            <div class="skeuo-book-cover ${favClass} ${isCloud ? 'is-cloud-only' : ''}">
                <button class="skeuo-fav-btn ${favActive}" title="${favTitle}">★</button>
                <button class="skeuo-cloud-btn ${cloudBtnClass}" title="${cloudBtnTitle}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg></button>
                <button class="skeuo-list-btn" title="加入与管理书单"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                <button class="skeuo-delete-btn" title="从书架删除">×</button>
                ${progressTag}
                ${skeuoCloudBadge}
                ${coverInner}
                <div class="skeuo-spine-gloss"></div>
                <div class="skeuo-paper-edge"></div>
            </div>
            <div class="skeuo-book-shelf-shadow"></div>
        `
        return card
    }

    createBookCard(book, cardIndex = 0) {
        const card = document.createElement('div')
        card.className = 'jane-book-card'
        card.dataset.id = book.id
        card.style.setProperty('--card-index', cardIndex)

        const fraction = book.progress?.fraction || 0
        const rawPct = fraction * 100
        const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
        
        let coverUrl = ''
        if (book.coverBlob) {
            coverUrl = coverUrlPool.get(book.id, book.coverBlob)
        }

        const readTimeStr = (book.totalReadingSeconds && book.totalReadingSeconds >= 60 && tracker?.formatDuration)
            ? tracker.formatDuration(book.totalReadingSeconds)
            : null

        let metaHtml = ''
        if (fraction === 0) {
            metaHtml = `<span class="jane-meta-badge-new">新</span><span class="jane-meta-text">未读</span>`
            if (readTimeStr) {
                metaHtml += `<span class="jane-meta-dot">·</span><span class="jane-meta-time">${readTimeStr}</span>`
            }
        } else if (fraction >= 0.999 || book.isFinished) {
            metaHtml = `<span class="jane-meta-badge-finished">已读完</span>`
            if (readTimeStr) {
                metaHtml += `<span class="jane-meta-dot">·</span><span class="jane-meta-time">${readTimeStr}</span>`
            }
        } else {
            metaHtml = `<span class="jane-meta-progress">${progressPct}%</span>`
            if (readTimeStr) {
                metaHtml += `<span class="jane-meta-dot">·</span><span class="jane-meta-time">${readTimeStr}</span>`
            }
        }

        const isCloud = !!book.isCloudOnly
        const hasBackup = !!(book.cloudBackup?.hasBackup)
        const cloudBtnClass = hasBackup ? 'synced' : ''
        const cloudBtnTitle = hasBackup ? '已备份至坚果云' : (isCloud ? '存于坚果云 (点击拉取)' : '备份至坚果云')
        const cloudBoxClass = isCloud ? 'is-cloud-only' : ''

        let cloudBadgeHtml = ''
        if (isCloud) {
            const fmtStr = escapeHTML((book.format || 'doc').toUpperCase())
            const sizeStr = book.size ? (book.size >= 1048576 ? (book.size / 1048576).toFixed(1) + 'MB' : (book.size / 1024).toFixed(0) + 'KB') : ''
            cloudBadgeHtml = `
                <div class="cloud-book-badge ${book.format === 'pdf' ? 'is-pdf' : ''}">
                    <span><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; vertical-align: -1px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>存于云端</span>
                    <span class="cloud-size-label">${fmtStr} ${sizeStr ? '· ' + sizeStr : ''}</span>
                </div>
            `
        }

        const favActive = book.isFavorite ? 'active' : ''
        const favClass = book.isFavorite ? 'is-favorite' : ''
        const favTitle = book.isFavorite ? '取消收藏' : '加入收藏'

        card.innerHTML = `
            <div class="jane-cover-box ${favClass} ${cloudBoxClass}" style="position: relative;">
                <button class="grid-fav-btn ${favActive}" title="${favTitle}">★</button>
                <button class="grid-cloud-btn ${cloudBtnClass}" title="${cloudBtnTitle}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg></button>
                <button class="grid-list-btn" title="加入与管理书单"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
                <button class="grid-delete-btn" title="从书架删除">×</button>
                ${cloudBadgeHtml}
                ${coverUrl 
                    ? `<img class="jane-cover-img" src="${coverUrl}" alt="${escapeHTML(book.title)}" loading="lazy"/>`
                    : `<div style="padding: 0.8rem; text-align: center; color: var(--text-muted); font-size: 0.75rem; font-weight: 600;">${escapeHTML(book.title)}</div>`
                }
            </div>
            <div class="jane-book-meta-row">${metaHtml}</div>
            <div class="jane-book-title" title="${escapeHTML(book.title)}">${escapeHTML(book.title)}</div>
        `
        return card
    }

    getDynamicGreeting() {
        const now = new Date()
        const timeVal = now.getHours() + now.getMinutes() / 60

        let periodKey = ''
        let titlePrefix = ''

        if (timeVal >= 5.5 && timeVal < 7.5) {
            // 05:30 - 07:30 清晨
            periodKey = 'dawn'
            titlePrefix = '清晨好'
        } else if (timeVal >= 7.5 && timeVal < 11.5) {
            // 07:30 - 11:30 早上/上午
            periodKey = 'morning'
            titlePrefix = '早上好'
        } else if (timeVal >= 11.5 && timeVal < 13.5) {
            // 11:30 - 13:30 中午
            periodKey = 'noon'
            titlePrefix = '中午好'
        } else if (timeVal >= 13.5 && timeVal < 18.0) {
            // 13:30 - 18:00 下午
            periodKey = 'afternoon'
            titlePrefix = '下午好'
        } else if (timeVal >= 18.0 && timeVal < 21.5) {
            // 18:00 - 21:30 傍晚
            periodKey = 'evening'
            titlePrefix = '傍晚好'
        } else if (timeVal >= 21.5 || timeVal < 2.0) {
            // 21:30 - 02:00 晚上
            periodKey = 'night'
            titlePrefix = '晚上好'
        } else {
            // 02:00 - 05:30 凌晨特异时段 (夜猫子专属温柔陪伴)
            periodKey = 'lateNight'
            titlePrefix = '夜深了'
        }

        const displayName = this.getUserDisplayName ? this.getUserDisplayName() : '读者'
        const isCustomName = displayName && displayName !== '读者'
        const greetingTitle = isCustomName ? `${titlePrefix}，${displayName.trim()}` : titlePrefix

        const subtitlesMap = {
            dawn: [
                '趁晨光正好，翻几页书醒醒神。',               // 50%
                '早起的清晨，四周很静，适合读几页。',           // 30%
                '趁着早晨的好时光，读几页想看的书。'          // 20%
            ],
            morning: [
                '新的一天，今天想读点什么？',                 // 50%
                '抽空翻开书页，给忙碌的早晨充充电。',           // 30%
                '状态正佳，把上次读到的精彩部分接上。'          // 20%
            ],
            noon: [
                '歇一歇，翻几页轻松的故事。',                 // 50%
                '午休的零碎时光，也是读几页的好时候。',         // 30%
                '放慢节奏，让思绪在故事里小憩片刻。'            // 20%
            ],
            afternoon: [
                '喝杯水，继续翻开下一章。',                   // 50%
                '午后时光悠长，沉浸读几段刚刚好。',             // 30%
                '翻开旧页，把散落的心思收进文字里。'            // 20%
            ],
            evening: [
                '卸下一天的忙碌，读会儿书吧。',                 // 50%
                '天色暗下来了，这会儿属于你自己。',             // 30%
                '晚饭过后，翻开喜欢的那一本。'                  // 20%
            ],
            night: [
                '睡前读几页，让思绪慢慢安静下来。',             // 50%
                '夜读的时光最专注，静静读完这一节。',           // 30%
                '让白天的喧扰停一停，在书里沉淀片刻。'          // 20%
            ],
            lateNight: [
                '夜这么深还在看书，沉浸在文字的世界里确实很惬意。', // 50%
                '四周都安静了，陪你读完这一节，别太累了。',       // 30%
                '万籁俱寂，夜读总有特别的安宁，读完早点歇下。'    // 20%
            ]
        }

        const options = subtitlesMap[periodKey] || subtitlesMap.morning
        const rand = Math.random() * 100
        let selectedSubtitle = options[0]
        if (rand >= 50 && rand < 80) {
            selectedSubtitle = options[1]
        } else if (rand >= 80) {
            selectedSubtitle = options[2]
        }

        return { title: greetingTitle, subtitle: selectedSubtitle }
    }

    renderModernThreshold(books) {
        if (!this.dom.modernHeroThreshold) return
        const count = books ? books.length : 0

        // Always update divider book count accurately based on active context
        if (this.dom.modernGridBookCount) {
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFav = this.shelfCategory === 'favorite'
            const isUnread = this.shelfCategory === 'unread'
            const isFinished = this.shelfCategory === 'finished'
            if (isCustomList) {
                this.dom.modernGridBookCount.innerText = `书单藏书 · 共 ${count} 本`
            } else if (isFav) {
                this.dom.modernGridBookCount.innerText = `收藏图书 · 共 ${count} 本`
            } else if (isUnread) {
                this.dom.modernGridBookCount.innerText = `待读清单 · 共 ${count} 本`
            } else if (isFinished) {
                this.dom.modernGridBookCount.innerText = `已读完成 · 共 ${count} 本`
            } else {
                this.dom.modernGridBookCount.innerText = `共 ${count} 本图书`
            }
        }

        // If searching or in filtered category (e.g. favorites or custom list), hide threshold hero to maximize library grid
        const isDefaultView = (!this.shelfCategory || this.shelfCategory === 'all') && (!this.searchQuery || !this.searchQuery.trim())
        if (!isDefaultView) {
            this.dom.modernHeroThreshold.style.display = 'none'
            if (this.dom.modernShelfScreen) this.dom.modernShelfScreen.style.paddingTop = '0.5rem'
            if (this.dom.btnBackToHero) this.dom.btnBackToHero.style.display = 'none'
            if (this.dom.modernShelfDivider) this.dom.modernShelfDivider.style.display = 'flex'
            return
        }

        this.dom.modernHeroThreshold.style.display = 'flex'
        if (this.dom.modernShelfScreen) this.dom.modernShelfScreen.style.paddingTop = '1.5rem'
        if (this.dom.btnBackToHero) this.dom.btnBackToHero.style.display = 'inline-flex'
        if (this.dom.modernShelfDivider) {
            this.dom.modernShelfDivider.style.display = 'flex'
        }

        // 1. Dynamic Greeting Based on 7 Time Slots & 3 Weighted Subtitles
        const greetingData = this.getDynamicGreeting()
        if (this.dom.heroGreetingTitle) {
            this.dom.heroGreetingTitle.innerText = greetingData.title
        }
        if (this.dom.heroGreetingSubtitle) {
            this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
        }

        // 2. Find Current Read Hero Book (Latest lastOpenedAt or lastReadAt, including 0% and 100%)
        const candidateBooks = (books || []).map(b => ({
            book: b,
            effectiveSortTime: Math.max(b.lastOpenedAt || 0, b.lastReadAt || 0)
        })).filter(item => item.effectiveSortTime > 0)
        candidateBooks.sort((a, b) => b.effectiveSortTime - a.effectiveSortTime)
        const heroBook = candidateBooks.length > 0 ? candidateBooks[0].book : (books && books.length > 0 ? books[0] : null)

        if (this.dom.heroBookShowcase) {
            if (heroBook) {
                const rawFraction = Number(heroBook.progress?.fraction)
                const isFiniteNum = typeof rawFraction === 'number' && Number.isFinite(rawFraction)
                const clampedFraction = isFiniteNum ? Math.min(1, Math.max(0, rawFraction)) : 0
                const fillPct = clampedFraction * 100
                const fillWidth = `${fillPct}%`

                let progressPct
                if (clampedFraction === 0) {
                    progressPct = '0'
                } else if (clampedFraction >= 1) {
                    progressPct = '100'
                } else {
                    const rawPct = clampedFraction * 100
                    if (rawPct < 1) {
                        progressPct = rawPct.toFixed(1)
                    } else {
                        const rounded = Math.round(rawPct)
                        progressPct = rounded >= 100 ? '99' : String(rounded)
                    }
                }

                const totalSec = heroBook.totalReadingSeconds || 0
                const readDurationStr = tracker && tracker.formatDuration ? tracker.formatDuration(totalSec) : `${Math.round(totalSec / 60)}分钟`
                let coverUrl = ''
                if (heroBook.coverBlob) {
                    coverUrl = coverUrlPool.get(heroBook.id, heroBook.coverBlob)
                }

                this.dom.heroBookShowcase.innerHTML = `
                    <div class="hero-book-card" data-id="${heroBook.id}" style="cursor: pointer;">
                        <div class="hero-book-cover-box">
                            ${coverUrl 
                                ? `<img class="hero-book-cover-img" src="${coverUrl}" alt="${escapeHTML(heroBook.title)}"/>`
                                : `<div class="hero-book-cover-fallback"><span>${escapeHTML(heroBook.title)}</span></div>`
                            }
                        </div>
                        <div class="hero-book-info">
                            <span class="hero-book-badge"><span class="hero-badge-dot"></span>最近在读</span>
                            <div class="hero-book-title" title="${escapeHTML(heroBook.title)}">${escapeHTML(heroBook.title)}</div>
                            <div class="hero-progress-bar-wrap" style="width: 100%; height: 6px; background: rgba(0, 0, 0, 0.12); border-radius: 3px; overflow: hidden; margin-bottom: 0.55rem; position: relative;">
                                <div class="hero-progress-bar-fill" style="width: ${fillWidth}; max-width: 100%; height: 100%; background: var(--accent-purple, #da7756) !important; display: block; border-radius: 3px;"></div>
                            </div>
                            <div class="hero-book-meta">
                                已读 ${progressPct}% · 累计阅读 ${readDurationStr}
                            </div>
                            <button class="btn-hero-read-now" id="btn-hero-read-now" type="button">
                                继续阅读 →
                            </button>
                        </div>
                    </div>
                `

                const cardBtn = this.dom.heroBookShowcase.querySelector('#btn-hero-read-now')
                if (cardBtn) {
                    cardBtn.addEventListener('click', (e) => {
                        e.stopPropagation()
                        this.openBook(heroBook.id)
                    })
                }
                const cardWrap = this.dom.heroBookShowcase.querySelector('.hero-book-card')
                if (cardWrap) {
                    cardWrap.addEventListener('click', () => {
                        this.openBook(heroBook.id)
                    })
                }
            } else {
                this.dom.heroBookShowcase.innerHTML = `
                    <div class="hero-book-card" style="justify-content: center; text-align: center; padding: 2.8rem 1.5rem;">
                        <div style="font-family: var(--font-serif); font-size: 1.05rem; color: var(--text-main); line-height: 1.6;">
                            从下方挑选一本书开启首次阅读吧
                        </div>
                    </div>
                `
            }
        }

        // 3. Scroll Hint & Back-to-Hero High-Velocity Controls
        if (this.dom.heroScrollHint) {
            this.dom.heroScrollHint.onclick = () => {
                this.glideToShelf()
            }
        }
        if (this.dom.btnBackToHero) {
            this.dom.btnBackToHero.onclick = () => {
                this.glideToHero()
            }
        }
    }

    onBooksWorkspaceScroll() {
        if (!this.dom.booksWorkspace) return
        const scrollTop = this.dom.booksWorkspace.scrollTop || 0

        // 1. Dynamic scrollbar class (rAF throttled)
        if (scrollTop > 80) {
            this.dom.booksWorkspace.classList.add('scrolled-into-shelf')
        } else {
            this.dom.booksWorkspace.classList.remove('scrolled-into-shelf')
        }

        if (this.isGliding) return
        if (this.shelfCategory !== 'all' || this.shelfViewMode !== 'grid') return
        if (!this.dom.modernHeroThreshold || this.dom.modernHeroThreshold.style.display === 'none') return

        const shelfTop = this.cachedShelfHeight || (window.innerHeight - 52)

        const isShelf = scrollTop >= shelfTop * 0.6
        if (isShelf) {
            if (this.dom.currentCategoryTitle) {
                if (this.dom.currentCategoryTitle.innerText !== '全部图书') {
                    this.dom.currentCategoryTitle.innerText = '全部图书'
                    this.dom.currentCategoryTitle.style.display = 'block'
                }
            }
        } else {
            if (this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.innerText = ''
                this.dom.currentCategoryTitle.style.display = 'none'
            }
        }
    }

    /**
     * Smooth 800ms velvety cubic deceleration animation
     * Eliminates "首屏下滑进入第二屏的速度快的离谱"
     */
    smoothGlideTo(targetY, duration = 800, callback) {
        if (!this.dom.booksWorkspace) return
        if (this.isGliding) return
        this.isGliding = true

        const startY = this.dom.booksWorkspace.scrollTop
        const distance = targetY - startY
        if (Math.abs(distance) < 2) {
            this.dom.booksWorkspace.scrollTop = targetY
            this.isGliding = false
            if (typeof callback === 'function') callback()
            return
        }

        const startTime = performance.now()
        // Apple / Claude standard deceleration curve: 1 - (1 - t)^4
        const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4)

        const step = (currentTime) => {
            const elapsed = currentTime - startTime
            const progress = Math.min(elapsed / duration, 1)
            const eased = easeOutQuart(progress)

            this.dom.booksWorkspace.scrollTop = startY + distance * eased

            if (progress < 1) {
                requestAnimationFrame(step)
            } else {
                this.dom.booksWorkspace.scrollTop = targetY
                this.isGliding = false
                this.onBooksWorkspaceScroll()
                if (typeof callback === 'function') callback()
            }
        }

        requestAnimationFrame(step)
    }

    glideToShelf() {
        if (!this.dom.booksWorkspace) return
        const shelfTop = this.cachedShelfHeight || (window.innerHeight - 52)
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = '全部图书'
            this.dom.currentCategoryTitle.style.display = 'block'
        }
        this.smoothGlideTo(shelfTop, 800)
    }

    glideToHero() {
        if (!this.dom.booksWorkspace) return
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = ''
            this.dom.currentCategoryTitle.style.display = 'none'
        }
        this.smoothGlideTo(0, 800)
    }

    glideScrollTo(targetTop) {
        if (!this.dom.booksWorkspace) return
        this.smoothGlideTo(targetTop, 600)
    }

    renderBooksGrid(books) {
        this.dom.booksGrid.innerHTML = ''

        if (books.length === 0) {
            this.dom.booksGrid.classList.add('is-empty')
            this.dom.booksGrid.style.display = 'flex'
            this.dom.booksGrid.style.justifyContent = 'center'
            this.dom.booksGrid.style.alignItems = 'center'
            this.dom.booksGrid.style.width = '100%'
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFinishedView = this.shelfCategory === 'finished'
            let svgIcon = ''
            if (isFavView) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-purple);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
            } else if (isCustomList) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-purple);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`
            } else if (isFinishedView) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-purple);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
            } else {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-purple);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
            }
            let emptyTitle = isFavView ? '暂无收藏图书' : (isCustomList ? '此书单暂无图书' : (isFinishedView ? '暂无已读完的图书' : '书架虚席以待'))
            let emptySub = isFavView ? '点击书籍封面左上角的小星标即可收录' : (isCustomList ? '点击右上角「+」或在卡片菜单中将图书归类至此' : (isFinishedView ? '读完一本书（阅读进度达 100%）后将自动归档至此' : '拖拽电子书到此处，或点击右上角「+」开启阅读之旅'))

            this.dom.booksGrid.innerHTML = `
                <div class="jane-empty-state" style="grid-column: 1 / -1; width: 100%; max-width: 520px; margin: 0 auto; padding: 4rem 1.5rem; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                    <div style="display: flex; justify-content: center; margin-bottom: 0.85rem; opacity: 0.85;">${svgIcon}</div>
                    <h3 style="font-family: var(--font-serif); font-size: 1.15rem; font-weight: 600; color: var(--text-main); margin-bottom: 0.4rem;">${emptyTitle}</h3>
                    <p style="font-size: 0.82rem; color: var(--text-muted);">${emptySub}</p>
                </div>
            `
            return
        }

        this.dom.booksGrid.classList.remove('is-empty')
        this.dom.booksGrid.style.display = 'grid'
        this.dom.booksGrid.style.justifyContent = ''
        this.dom.booksGrid.style.alignItems = ''

        const gridFragment = document.createDocumentFragment()
        books.forEach((book, idx) => {
            const card = this.createBookCard(book, idx)
            gridFragment.appendChild(card)
        })
        this.dom.booksGrid.appendChild(gridFragment)
    }

    renderBooksTable(books) {
        this.dom.booksTableBody.innerHTML = ''

        if (books.length === 0) {
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFinishedView = this.shelfCategory === 'finished'
            let emptyMsg = isFavView ? '暂无收藏图书，点击图书 ★ 按钮即可加入收藏' : (isCustomList ? '此书单暂无图书，点击右上角「+」即可添加图书' : (isFinishedView ? '暂无已读完的图书，阅读进度达到 100% 时将自动收录' : '书架空空如也，暂无图书'))
            this.dom.booksTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-tertiary);">${emptyMsg}</td></tr>`
            return
        }

        const tableFragment = document.createDocumentFragment()
        books.forEach(book => {
            const row = document.createElement('tr')
            row.className = 'jane-table-row'
            row.dataset.id = book.id

            const fraction = book.progress?.fraction || 0
            const rawPct = fraction * 100
            const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
            const sizeStr = formatFileSize(book.size)
            const dateStr = book.addedAt ? new Date(book.addedAt).toLocaleDateString('zh-CN') : '-'

            const isCloud = !!book.isCloudOnly
            const hasBackup = !!(book.cloudBackup?.hasBackup)
            const cloudBadge = isCloud ? `<span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.12); color: #2563eb; margin-right: 6px; font-weight: 500; display: inline-flex; align-items: center; gap: 3px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>待拉取</span>` : (hasBackup ? `<span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; background: rgba(16,185,129,0.12); color: #059669; margin-right: 6px; font-weight: 500; display: inline-flex; align-items: center; gap: 3px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>已备份</span>` : '')
            const cloudBtnText = isCloud ? '拉取' : (hasBackup ? '已备份' : '备份')
            const cloudBtnStyle = hasBackup ? 'color: #059669; border: 1px solid rgba(16,185,129,0.25); background: rgba(16,185,129,0.06);' : 'color: #2563eb; border: 1px solid rgba(59,130,246,0.25); background: rgba(59,130,246,0.06);'

            row.innerHTML = `
                <td class="jane-table-cell" style="width: 40px; text-align: center;">
                    <button class="table-fav-btn ${book.isFavorite ? 'active' : ''}" title="${book.isFavorite ? '取消收藏' : '加入收藏'}" style="background: none; border: none; font-size: 1.1rem; cursor: pointer; color: ${book.isFavorite ? '#f59e0b' : 'var(--text-tertiary)'};">★</button>
                </td>
                <td class="jane-table-cell font-medium" style="font-weight: 600;">${cloudBadge}${escapeHTML(book.title)}</td>
                <td class="jane-table-cell text-muted">${escapeHTML(book.author || '未知作者')}</td>
                <td class="jane-table-cell text-muted">${escapeHTML((book.format || 'epub').toUpperCase())} · ${sizeStr}</td>
                <td class="jane-table-cell text-muted">${progressPct}%</td>
                <td class="jane-table-cell text-muted">${dateStr}</td>
                <td class="jane-table-cell" style="text-align: center; white-space: nowrap;">
                    <button class="table-cloud-btn" title="坚果云备份/拉取" style="${cloudBtnStyle} padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>${cloudBtnText}</button>
                    <button class="table-list-btn" title="加入与管理书单" style="color: var(--claude-terracotta, #da7756); border: 1px solid rgba(218, 119, 86, 0.25); background: rgba(218, 119, 86, 0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>书单</button>
                    <button class="table-delete-btn" title="从书架删除" style="color: #ef4444; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;">删除</button>
                </td>
            `
            tableFragment.appendChild(row)
        })
        this.dom.booksTableBody.appendChild(tableFragment)
    }

    async handleDeleteBook(book) {
        if (!book || !book.id) return
        const isCloudOnly = !!book.isCloudOnly
        const hasCloudBackup = !!(book.cloudBackup?.hasBackup)

        let shouldDeleteCloudFile = false
        let shouldRecordTombstone = true

        if (isCloudOnly) {
            // Book is cloud placeholder only (not downloaded locally)
            const confirmed = await this.showConfirmDialog(
                `移除云端图书《${book.title}》？`,
                '该书当前仅存于坚果云端，未占用本机磁盘。\n\n确定要从当前设备书架中移除占位吗？'
            )
            if (!confirmed) return
            // For a cloud-only placeholder, removing it locally should NOT broadcast deletion to other devices!
            shouldRecordTombstone = false
        } else if (hasCloudBackup) {
            // Book has cloud backup
            const confirmed = await this.showConfirmDialog(
                `删除《${book.title}》？`,
                '确定要从书架中删除这本书吗？\n\n提示：该图书在坚果云存有云端备份。'
            )
            if (!confirmed) return

            // Prompt whether to clean up the WebDAV remote backup to release quota
            const deleteCloud = await this.showConfirmDialog(
                `清理云端备份？`,
                '是否同步删除坚果云中的该图书文件以释放云端存储配额？\n\n- 点击【确定】：彻底删除云端备份文件\n- 点击【取消】：仅删除本地，保留云端备份'
            )
            shouldDeleteCloudFile = !!deleteCloud
            shouldRecordTombstone = true
        } else {
            const confirmed = await this.showConfirmDialog(
                `删除《${book.title}》？`,
                '确定要从书架中删除这本书吗？'
            )
            if (!confirmed) return
        }

        try {
            await db.deleteBook(book.id, shouldRecordTombstone)
            coverUrlPool.revoke(book.id)

            if (shouldDeleteCloudFile && (this.syncConfig?.enabled || this.syncConfig?.username)) {
                const fileName = book.cloudBackup?.fileName || `${book.stableKey || book.id}.${book.format}`
                if (window.electronAPI?.syncDeleteBookBinary) {
                    try {
                        const delRes = await window.electronAPI.syncDeleteBookBinary(this.syncConfig, fileName)
                        if (delRes?.success) {
                            console.log(`[CloudSync] Deleted remote book binary: ${fileName}`)
                        } else {
                            this.showToast('云端备份文件删除未完成，可在坚果云网页端确认清理', '⚠️')
                        }
                    } catch (delErr) {
                        console.warn('[CloudSync] Failed deleting remote book binary:', delErr)
                        this.showToast('网络离线，云端文件未即时清除', '⚠️')
                    }
                }
            }

            this.showToast(`已从书架删除《${book.title}》`, '🗑️')
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()

            if (shouldRecordTombstone && this.syncConfig?.enabled) {
                this.triggerSilentBackgroundSync()
            }
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
            iconSpan.className = 'list-icon-wrap'
            iconSpan.innerHTML = this.getListIconSvg(list.icon)

            const titleSpan = document.createElement('span')
            titleSpan.className = 'list-title'
            titleSpan.textContent = list.name

            item.appendChild(iconSpan)
            item.appendChild(titleSpan)

            const slot = document.createElement('span')
            slot.className = 'list-accessory-slot'

            if (count > 0) {
                const badgeSpan = document.createElement('span')
                badgeSpan.className = `list-count-badge ${!list.isBuiltIn ? 'has-del' : ''}`
                badgeSpan.textContent = String(count)
                slot.appendChild(badgeSpan)
            }

            if (!list.isBuiltIn) {
                const delSpan = document.createElement('span')
                delSpan.className = 'list-del-btn'
                delSpan.title = '删除书单'
                delSpan.textContent = '✕'
                slot.appendChild(delSpan)
            }

            item.appendChild(slot)

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
                    this.dom.currentCategoryTitle.innerText = list.name
                    this.dom.currentCategoryTitle.style.display = 'block'
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
        const confirmed = await this.showConfirmDialog(
            `删除书单「${list.name}」？`,
            '书单内的图书不会被删除，仅移除该分类'
        )
        if (!confirmed) return
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

    getListIconSvg(iconId) {
        const found = this.iconDefs?.find(d => d.id === iconId)
        if (found) return found.svg
        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    }

    openCreateListModal() {
        if (!this.dom.modalCreateList) return
        if (this.dom.inputCustomListName) {
            this.dom.inputCustomListName.value = ''
        }
        this.selectedListIcon = 'book'
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
        this.iconDefs.forEach(def => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = `icon-pick-btn ${this.selectedListIcon === def.id ? 'active' : ''}`
            btn.title = def.label
            btn.innerHTML = def.svg
            btn.addEventListener('click', () => {
                this.selectedListIcon = def.id
                this.dom.customListIconPicker.querySelectorAll('.icon-pick-btn').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
            })
            this.dom.customListIconPicker.appendChild(btn)
        })
    }

    async handleCreateListConfirm() {
        const name = this.dom.inputCustomListName?.value.trim()
        if (!name) {
            this.showToast('请输入书单名称', 'warning')
            this.dom.inputCustomListName?.focus()
            return
        }
        const newList = {
            id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name,
            icon: this.selectedListIcon || 'book',
            isBuiltIn: false,
            createdAt: Date.now()
        }
        await db.saveCustomList(newList)
        this.closeCreateListModal()
        this.showToast(`书单「${name}」创建成功！`, 'success')
        
        // Auto-switch to newly created list
        this.shelfCategory = newList.id
        this.dom.navCategoryItems?.forEach(i => i.classList.remove('active'))
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = newList.name
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
                iconSpan.className = 'list-icon-wrap'
                iconSpan.innerHTML = this.getListIconSvg(list.icon)

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

    closeBatchAddModal() {
        this.closeBatchAddToListModal()
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
    // Book Binary Cloud Sync & On-Demand Pull
    // ==========================================
    async handleCloudBookClick(book) {
        if (!book) return
        if (this._activeTransfers?.has(book.id)) {
            return this.showToast(`《${book.title}》正在传输中，请稍候...`, '⏳')
        }

        const format = (book.format || '').toLowerCase()
        const size = book.size || book.cloudBackup?.size || 0
        const sizeMb = (size / 1048576).toFixed(1)

        // Strict format & size defense: PDF, CBZ or >= 15MB files MUST prompt user confirmation
        const isHighRisk = format === 'pdf' || format === 'cbz' || size >= 15 * 1024 * 1024

        if (isHighRisk) {
            const formatName = format.toUpperCase()
            const confirmMsg = `《${book.title}》为 ${formatName} 格式（约 ${sizeMb} MB），当前存于坚果云端。\n下载将消耗坚果云本月下载流量（免费版 3GB/月）。\n\n是否立即从云端下载到本地进行阅读？`
            const confirmed = await this.showConfirmDialog('从云端下载图书', confirmMsg)
            if (!confirmed) return
        }

        if (!this.syncConfig?.enabled || (!this.syncConfig?.password && !this.syncConfig?.hasPassword)) {
            this.showToast('请先在「设置 - 云端同步」中配置坚果云并保存授权密码', '⚠️')
            return this.openWebdavSyncModal()
        }

        this._activeTransfers?.add(book.id)
        const fileName = book.cloudBackup?.fileName || `${book.stableKey || book.id}.${book.format}`
        this.showToast(`正在从坚果云下载《${book.title}》...`, '☁️')

        try {
            const res = await window.electronAPI.syncDownloadBookBinary(this.syncConfig, fileName)
            if (!res || !res.success || !res.buffer) {
                throw new Error(res?.error || '从云端下载失败')
            }

            const mimeType = format === 'pdf' ? 'application/pdf' : 'application/octet-stream'
            const blob = new Blob([res.buffer], { type: mimeType })
            await db.saveBookFileBlob(book.id, blob)

            // Re-fetch fresh book record from DB to preserve any concurrent sync updates
            const freshBook = (await db.getBook(book.id)) || book
            freshBook.isCloudOnly = false
            freshBook.hasLocalFile = true
            freshBook.cloudBackupState = 'synced'
            freshBook._preserveUpdatedAt = true
            await db.saveBook(freshBook)

            // Auto-heal / extract cover for the downloaded book
            if (!freshBook.coverBlob) {
                await this.tryExtractAndSaveCover(freshBook)
            }

            await this.refreshBookshelf()

            // Only auto-open if the user isn't already actively reading another book
            if (!this.currentBookId) {
                this.showToast(`《${book.title}》已就绪！正在翻开...`, '📖')
                await this.openBook(book.id)
            } else {
                this.showToast(`《${book.title}》已下载就绪！`, '📖')
            }
        } catch (err) {
            console.error('Download cloud book error:', err)
            this.showToast(`拉取失败: ${err.message}`, '🔴')
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
            return this.showToast(`《${book.title}》正在上传传输中，请稍候...`, '⏳')
        }

        // Prevent unintentional quota wastage: confirm before re-uploading an already backed-up book
        if (book.cloudBackup?.hasBackup) {
            const backupDate = book.cloudBackup.uploadedAt ? new Date(book.cloudBackup.uploadedAt).toLocaleString('zh-CN') : '已完成'
            const backupSize = (book.cloudBackup.size ? (book.cloudBackup.size / 1048576).toFixed(1) : (book.size / 1048576).toFixed(1))
            const confirmReupload = await this.showConfirmDialog(
                `云端备份管理`,
                `《${book.title}》已于 ${backupDate} 成功备份至坚果云（约 ${backupSize} MB）。\n\n是否确认重新覆盖上传当前本地图书文件？`
            )
            if (!confirmReupload) return
        }

        if (!this.syncConfig?.enabled || (!this.syncConfig?.password && !this.syncConfig?.hasPassword)) {
            this.showToast('请先在「设置 - 云端同步」中配置坚果云并保存授权密码', '⚠️')
            return this.openWebdavSyncModal()
        }

        const format = (book.format || '').toLowerCase()
        const size = book.size || 0
        const sizeMb = (size / 1048576).toFixed(1)
        const isHighRisk = format === 'pdf' || format === 'cbz' || size >= 15 * 1024 * 1024

        if (isHighRisk && !book.cloudBackup?.hasBackup) {
            const confirmMsg = `《${book.title}》为 ${format.toUpperCase()} 格式（约 ${sizeMb} MB）。\n上传将消耗坚果云本月上传额度（免费版每月 1GB）。\n\n是否确认备份至坚果云？`
            const confirmed = await this.showConfirmDialog('备份图书至坚果云', confirmMsg)
            if (!confirmed) return
        }

        this._activeTransfers?.add(book.id)
        try {
            const fileBlob = await db.getBookFileBlob(book.id)
            if (!fileBlob || fileBlob.size === 0) {
                return this.showToast('本地未找到该书籍的物理文件或内容为空', '⚠️')
            }

            this.showToast(`正在上传《${book.title}》至坚果云...`, '☁️')
            const arrayBuffer = await fileBlob.arrayBuffer()
            const fileName = `${book.stableKey || book.id}.${book.format}`

            const res = await window.electronAPI.syncUploadBookBinary(this.syncConfig, fileName, arrayBuffer)
            if (!res || !res.success) {
                throw new Error(res?.error || '上传失败')
            }

            const uploadedFileName = res.fileName || fileName
            book.cloudBackup = {
                hasBackup: true,
                fileName: uploadedFileName,
                size: book.size || arrayBuffer.byteLength,
                format: book.format,
                uploadedAt: Date.now()
            }
            book.cloudBackupState = 'synced'
            await db.saveBook(book)

            this.showToast(`《${book.title}》已成功备份至坚果云！`, '✅')
            await this.refreshBookshelf()

            // Trigger silent metadata sync so cloud index is immediately updated
            this.triggerSilentBackgroundSync()
        } catch (err) {
            console.error('Upload book error:', err)
            this.showToast(`备份失败: ${err.message}`, '🔴')
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
                        console.log(`[AutoDownload] Book 《${book.title}》 was removed, skipping download.`)
                        continue
                    }

                    if (!syncEngine.isAutoDownloadEligible(currentBook)) continue
                    const hasLocal = await db.hasBookFileBlob(currentBook.id)
                    if (hasLocal) continue

                    // If user is currently manually downloading this book, skip duplicate auto download
                    if (this._activeTransfers?.has(currentBook.id)) continue

                    const fileName = currentBook.cloudBackup?.fileName || `${currentBook.stableKey || currentBook.id}.${currentBook.format}`
                    const res = await window.electronAPI.syncDownloadBookBinary(this.syncConfig, fileName)
                    if (res && res.success && res.buffer) {
                        // Double check before saving: did the user delete it while downloading?
                        const stillExists = await db.getBook(currentBook.id)
                        if (!stillExists) {
                            console.log(`[AutoDownload] Book 《${book.title}》 deleted during download, skipping save.`)
                            continue
                        }

                        const mimeType = (currentBook.format === 'pdf') ? 'application/pdf' : 'application/octet-stream'
                        const blob = new Blob([res.buffer], { type: mimeType })
                        await db.saveBookFileBlob(currentBook.id, blob)

                        const freshBook = (await db.getBook(currentBook.id)) || currentBook
                        freshBook.isCloudOnly = false
                        freshBook.hasLocalFile = true
                        freshBook.cloudBackupState = 'synced'
                        freshBook._preserveUpdatedAt = true
                        await db.saveBook(freshBook)

                        // Auto-heal / extract cover for auto-downloaded book
                        if (!freshBook.coverBlob) {
                            await this.tryExtractAndSaveCover(freshBook)
                        }

                        console.log(`[AutoDownload] Successfully auto-downloaded: ${freshBook.title}`)

                        // Incrementally refresh bookshelf so UI immediately reflects readiness
                        await this.refreshBookshelf()
                    }
                    // Delay 2500ms between downloads to strictly honor Nutstore 30 req/min limit (60s/2.5s = 24 req/min)
                    await new Promise(r => setTimeout(r, 2500))
                } catch (err) {
                    console.warn(`[AutoDownload] Failed downloading ${book.title}:`, err.message)
                }
            }
        } finally {
            this._isAutoDownloading = false
            await this.refreshBookshelf()
        }
    }

    // ==========================================
    // Reader Logic
    // ==========================================
    /**
     * Unified reader progress snapshot generator
     * Ensures consistent structure across debounce, closeReader, and flushReaderStateOnExit
     */
    makeProgressSnapshot(session) {
        if (!session || !session.location || !session.snapshot) return null
        const loc = session.location
        const fraction = Number.isFinite(loc.fraction) ? Math.min(1, Math.max(0, loc.fraction)) : 0
        const page = typeof loc.page === 'number' && loc.page >= 1 ? Math.round(loc.page) : null
        const totalPages = typeof loc.totalPages === 'number' && loc.totalPages >= 1 ? Math.round(loc.totalPages) : null
        const cfi = typeof loc.cfi === 'string' ? loc.cfi : null
        const tocItem = loc.tocItem ? { label: loc.tocItem.label || '', href: loc.tocItem.href || '' } : null
        const format = session.bookData?.format || ''
        const snapshot = session.snapshot

        return {
            fraction,
            page,
            totalPages,
            cfi,
            tocItem,
            format,
            yRatio: typeof loc.yRatio === 'number' ? loc.yRatio : null,
            blobRevision: snapshot.blobRevision || null,
            revisionOrigin: snapshot.revisionOrigin || null,
            documentHash: snapshot.documentHash || null,
            updatedAt: Date.now()
        }
    }

    async openBook(bookOrId) {
        const bookId = (typeof bookOrId === 'object' && bookOrId !== null) ? bookOrId.id : bookOrId
        if (!bookId) return this.showToast('找不到该书籍！', '⚠️')

        // 1. Synchronously increment session epoch and clear pending timers
        this._currentBookEpoch = (this._currentBookEpoch || 0) + 1
        const currentEpoch = this._currentBookEpoch

        if (this._closeTimer) {
            clearTimeout(this._closeTimer)
            this._closeTimer = null
        }
        if (this._loadingFadeTimer) {
            clearTimeout(this._loadingFadeTimer)
            this._loadingFadeTimer = null
        }
        if (this._progressDebounceTimer) {
            clearTimeout(this._progressDebounceTimer)
            this._progressDebounceTimer = null
        }

        // 2. Create new session with AbortController
        const abortController = new AbortController()
        const readerSession = {
            epoch: currentEpoch,
            bookId,
            abortController,
            isCurrent: () => this._currentBookEpoch === currentEpoch && !abortController.signal.aborted,
            view: null,
            driver: null,
            viewport: null,
            location: null,
            snapshot: null,
            bookData: null,
            toc: null
        }
        const prevSession = this._activeSession
        this._activeSession = readerSession

        // 3. Tear down previous session resources without hiding readerView; synchronously capture and flush prev session progress
        if (prevSession && prevSession !== readerSession) {
            const prevBookId = prevSession.bookId
            const prevProgress = this.makeProgressSnapshot(prevSession)
            const prevLoc = prevSession.location

            prevSession.abortController?.abort()
            if (prevSession.view) {
                try { prevSession.view.close?.() } catch (e) {}
                try { prevSession.view.remove?.() } catch (e) {}
                if (this.foliateView === prevSession.view) this.foliateView = null
            }
            if (prevSession.viewport) {
                try { prevSession.viewport.destroy?.() } catch (e) {}
                if (this.pdfViewport === prevSession.viewport) this.pdfViewport = null
            }
            if (prevSession.driver) {
                try { prevSession.driver.destroy?.() } catch (e) {}
                if (this.pdfDriver === prevSession.driver) this.pdfDriver = null
            }

            if (prevBookId && prevProgress) {
                db.updateBookProgress(prevBookId, prevProgress).catch(err => {
                    console.warn('Failed to flush previous book progress on switch:', err)
                })
            }
            if (prevLoc?.fraction != null) {
                tracker.endSession(prevLoc.fraction).catch(() => {})
            } else {
                tracker.endSession().catch(() => {})
            }
        }

        // Synchronously detach old display state immediately upon entering new session
        this.currentLocation = null
        this.currentBookData = null
        this._currentSnapshot = null
        this.currentBookId = null

        if (this.dom.welcomeModalBackdrop) {
            this.dom.welcomeModalBackdrop.style.display = 'none'
        }

        try {
            // Ensure recovery barrier has settled before reading book data
            const barrierResult = await this.ensureRecoveryBarrier()
            if (!readerSession.isCurrent()) return

            if (barrierResult?.canProceedSafely && !barrierResult.canProceedSafely(bookId)) {
                this.showToast('上次阅读进度恢复未完成，保留备份待重试', '⚠️')
            }

            // 4. Fetch snapshot with content identity
            const snapshot = await db.getBookFileSnapshot(bookId)
            if (!readerSession.isCurrent()) return

            const bookData = (typeof bookOrId === 'object' && bookOrId !== null && bookOrId.title)
                ? { ...snapshot, ...bookOrId }
                : (await db.getBook(bookId)) || snapshot
            if (!readerSession.isCurrent()) return

            // Handle cloud-only books before requiring local Blob
            if (bookData?.isCloudOnly) {
                return this.handleCloudBookClick(bookData)
            }

            if (!snapshot || !snapshot.blob) {
                this.showToast('无法读取书籍文件数据', '⚠️')
                return this.closeReader()
            }

            const targetBlob = snapshot.blob
            if (!targetBlob) {
                this.showToast('无法读取书籍文件数据', '⚠️')
                return this.closeReader()
            }

            // Accurately resolve book format - fallback to 'epub', NEVER default to 'pdf'
            let safeFormat = (bookData.format || snapshot.format || '').trim().toLowerCase()
            if (!safeFormat) {
                const candidateName = (bookData.filename || snapshot.filename || bookData.title || (targetBlob instanceof File ? targetBlob.name : '') || '').toLowerCase()
                const extMatch = candidateName.match(/\.([a-z0-9]+)$/i)
                if (extMatch) {
                    safeFormat = extMatch[1].toLowerCase()
                } else if (targetBlob?.type === 'application/pdf') {
                    safeFormat = 'pdf'
                } else if (targetBlob?.type === 'application/epub+zip') {
                    safeFormat = 'epub'
                } else {
                    safeFormat = 'epub'
                }
            }

            const baseTitle = (bookData.title || snapshot.title || 'document').replace(/\.[^/.]+$/, '').trim() || 'document'
            const safeFileName = bookData.filename || snapshot.filename || `${baseTitle}.${safeFormat}`
            const isPdf = safeFormat === 'pdf' || safeFileName.toLowerCase().endsWith('.pdf')
            const safeFileType = isPdf ? 'application/pdf' : (safeFormat === 'epub' ? 'application/epub+zip' : (targetBlob.type || ''))

            const fileObj = (targetBlob instanceof File && targetBlob.name && !targetBlob.name.toLowerCase().endsWith('.pdf') && !isPdf)
                ? targetBlob
                : new File([targetBlob], safeFileName, { type: safeFileType })

            readerSession.bookData = bookData
            readerSession.snapshot = snapshot
            this.currentBookId = bookId
            this.currentBookData = bookData
            this._currentSnapshot = snapshot
            this.currentLocation = null
            this.currentPdfPageIndex = 0

            // Switch View
            this.dom.readerView?.classList.remove('closing')
            this.dom.bookshelfView.style.display = 'none'
            this.dom.readerView.style.display = 'block'
            this.dom.readerView.classList.add('active')
            this.dom.readerBookTitle.innerText = bookData.title || snapshot.title || '阅读'

            // Clean up previous views if any
            if (this.pdfViewport && this.pdfViewport !== readerSession.viewport) {
                this.pdfViewport.destroy()
                this.pdfViewport = null
            }
            if (this.dom.pdfZoomBar) {
                this.dom.pdfZoomBar.style.display = 'none'
            }
            if (this.foliateView && this.foliateView !== readerSession.view) {
                this.foliateView.close?.()
                this.foliateView.remove?.()
                this.foliateView = null
            }

            if (isPdf) {
                // Independent PDF Viewport (no iframe sandbox)
                const nativePath = snapshot.nativePath || await db.getBookNativePath(bookId)
                if (!readerSession.isCurrent()) return

                const sessionDriver = new AdaptivePdfDriver({ nativePath, snapshot })
                const sessionViewport = new PdfViewport(this.dom.readerContentArea, {
                    scale: 1.25,
                    snapshot,
                    onOutline: toc => {
                        if (!readerSession.isCurrent()) return
                        this.currentPdfTOC = toc
                        readerSession.toc = toc
                        readerSession.tocIndex = buildPdfTocIndex(toc)
                        this.renderTOC(toc)
                        const active = pdfTocAtPage(readerSession.tocIndex, sessionViewport.currentPage)
                        if (active?.href) this.highlightActiveTOCItem(active.href)
                        if (active && readerSession.location) readerSession.location.tocItem = active
                    },
                    onPageChange: (pageIdx, total) => {
                        if (!readerSession.isCurrent()) return
                        tracker.resetActivity()
                        tracker.recordPageTurn()

                        const frac = total > 0 ? (pageIdx + 1) / total : 0
                        const loc = { fraction: frac, page: pageIdx + 1, totalPages: total }
                        readerSession.location = loc
                        if (this._activeSession === readerSession) {
                            this.currentLocation = loc
                            if (this.dom.readerPageNumber) {
                                this.dom.readerPageNumber.innerText = `${pageIdx + 1} / ${total} 页`
                                this.dom.readerPageNumber.title = `点击可输入页码快速跳转 (1 ~ ${total})`
                            }
                            if (this.dom.progressSlider) {
                                this.dom.progressSlider.value = (frac * 100).toFixed(1)
                            }
                            if (this.dom.progressText) {
                                this.dom.progressText.innerText = `${Math.round(frac * 100)}%`
                            }
                            if (this.dom.readerEtaBadge) {
                                if (frac >= 0.99) {
                                    this.dom.readerEtaBadge.innerText = '🎉 即将读完'
                                } else if (frac <= 0.005) {
                                    this.dom.readerEtaBadge.innerText = '预计还需 --'
                                } else {
                                    const paceSecs = tracker.getCurrentPaceSecs()
                                    const remainingPages = Math.max(0, total - (pageIdx + 1))
                                    const remainingSecs = remainingPages * paceSecs
                                    this.dom.readerEtaBadge.innerText = `预计还需 ${tracker.formatDuration(remainingSecs)}`
                                }
                            }
                        }

                        const activeItem = pdfTocAtPage(readerSession.tocIndex, pageIdx)
                        if (activeItem?.href && this._activeSession === readerSession) {
                            this.highlightActiveTOCItem(activeItem.href)
                        }
                        if (activeItem) {
                            loc.tocItem = activeItem
                        }

                        // Debounce progress update to db using unified makeProgressSnapshot
                        clearTimeout(this._progressDebounceTimer)
                        this._progressDebounceTimer = setTimeout(() => {
                            if (readerSession.isCurrent() && this.currentBookId === bookId) {
                                const progressSnapshot = this.makeProgressSnapshot(readerSession)
                                if (progressSnapshot) {
                                    db.updateBookProgress(bookId, progressSnapshot).catch(err => console.warn('Failed to update PDF progress:', err))
                                }
                            }
                        }, 500)
                    },
                    onSelection: (selInfo) => {
                        if (!readerSession.isCurrent()) return
                        this.selectedTextInfo = {
                            text: selInfo.text,
                            formatType: 'pdf',
                            pdfTarget: {
                                page: selInfo.page,
                                rects: selInfo.rects,
                                quads: selInfo.quads || [],
                                pageBounds: selInfo.pageBounds || null,
                                segments: selInfo.segments || null,
                                coordinateVersion: selInfo.coordinateVersion || 'pdf-page-v1',
                            },
                            rect: selInfo.clientRect
                        }
                        this.hideHighlightActionPopup()
                        this.showSelectionPopup(selInfo.clientRect)
                    },
                    onHighlightCreate: async (hl) => {
                        const newHl = {
                            id: 'hl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                            bookId: readerSession.bookId,
                            formatType: 'pdf',
                            text: hl.text,
                            color: '#fef08a',
                            createdAt: Date.now(),
                            chapterTitle: readerSession.location?.tocItem?.label || '正文',
                            blobRevision: snapshot.blobRevision,
                            revisionOrigin: snapshot.revisionOrigin,
                            documentHash: snapshot.documentHash,
                            pdfTarget: {
                                page: hl.page,
                                rects: hl.rects,
                                quads: hl.quads || [],
                                pageBounds: hl.pageBounds || null,
                                segments: hl.segments || null,
                                coordinateVersion: hl.coordinateVersion || 'pdf-page-v1',
                            }
                        }
                        await db.saveHighlight(newHl)
                        if (!readerSession.isCurrent()) return
                        const allHls = await db.getHighlightsByBook(readerSession.bookId)
                        if (!readerSession.isCurrent()) return
                        sessionViewport.setHighlights(allHls, snapshot)
                        this.loadNotesList()
                        this.showToast('已添加高亮笔记', '✓')
                    },
                    onHighlightClick: (hl, event, customRect) => {
                        if (!readerSession.isCurrent()) return
                        let targetRect = customRect
                        if (!targetRect && event?.target?.classList?.contains('pdf-highlight-rect')) {
                            targetRect = event.target.getBoundingClientRect()
                        }
                        if (!targetRect) {
                            targetRect = {
                                top: window.innerHeight / 2 - 22,
                                left: window.innerWidth / 2 - 110,
                                width: 100,
                                height: 30
                            }
                        }
                        this.hideSelectionPopup()
                        this.clickedHighlightInfo = { value: hl.id, id: hl.id, hl, rect: targetRect }
                        this.showHighlightActionPopup(targetRect)
                    }
                })

                readerSession.driver = sessionDriver
                readerSession.viewport = sessionViewport
                this.pdfDriver = sessionDriver
                this.pdfViewport = sessionViewport

                const initialPageFn = (totalPages) => {
                    const progressMeta = bookData?.progress
                    if (progressMeta?.blobRevision && !db.isContentIdentityMatching(progressMeta, snapshot).matches) {
                        return 0 // Content replaced, do not reuse old page
                    }
                    const decoded = decodePdfProgress(progressMeta, totalPages)
                    return decoded.page - 1
                }

                const docInfo = await sessionViewport.load(
                    sessionDriver,
                    { blob: fileObj, nativePath },
                    { initialPage: initialPageFn, snapshot }
                )
                if (!readerSession.isCurrent()) {
                    sessionViewport.destroy()
                    sessionDriver.destroy()
                    if (this.pdfViewport === sessionViewport) this.pdfViewport = null
                    if (this.pdfDriver === sessionDriver) this.pdfDriver = null
                    return
                }

                this.currentPdfTOC = docInfo.toc || []
                readerSession.toc = docInfo.toc || []

                // Restore saved progress display accurately
                const progressMeta = bookData?.progress
                const isProgressIdentityMatching = !progressMeta || !progressMeta.blobRevision || db.isContentIdentityMatching(progressMeta, snapshot).matches
                const decodedInitial = isProgressIdentityMatching
                    ? decodePdfProgress(progressMeta, docInfo.numPages)
                    : { page: 1, fraction: 0 }
                const displayPage = decodedInitial.page
                const initialFrac = decodedInitial.fraction
                const initLoc = { fraction: initialFrac, page: displayPage, totalPages: docInfo.numPages }
                readerSession.location = initLoc
                this.currentLocation = initLoc

                // 加载已有高亮 (filtered by content identity)
                const existingHls = await db.getHighlightsByBook(bookId)
                if (!readerSession.isCurrent()) return
                sessionViewport.setHighlights(existingHls, snapshot)

                if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'flex'
                if (this.dom.readerPageNumber) {
                    this.dom.readerPageNumber.innerText = `${displayPage} / ${docInfo.numPages} 页`
                    this.dom.readerPageNumber.title = `点击可输入页码快速跳转 (1 ~ ${docInfo.numPages})`
                }
                if (this.dom.progressSlider) {
                    this.dom.progressSlider.value = (initialFrac * 100).toFixed(1)
                }
                if (this.dom.progressText) {
                    this.dom.progressText.innerText = `${Math.round(initialFrac * 100)}%`
                }
                if (this.dom.readerEtaBadge) {
                    if (initialFrac >= 0.99) {
                        this.dom.readerEtaBadge.innerText = '🎉 即将读完'
                    } else if (initialFrac <= 0.005) {
                        this.dom.readerEtaBadge.innerText = '预计还需 --'
                    } else {
                        const paceSecs = tracker.getCurrentPaceSecs()
                        const remainingPages = Math.max(0, docInfo.numPages - displayPage)
                        const remainingSecs = remainingPages * paceSecs
                        this.dom.readerEtaBadge.innerText = `预计还需 ${tracker.formatDuration(remainingSecs)}`
                    }
                }

                // 启动阅读计时
                tracker.startSession(bookId, bookData.title, initialFrac)
                db.recordBookOpened(bookId).catch(err => {
                    console.warn('Failed to record book opened for PDF:', err)
                })

                setTimeout(() => {
                    if (readerSession.isCurrent() && this.currentBookId === bookId) {
                        this.renderTOC(this.currentPdfTOC)
                        this.loadNotesList()
                        const activeItem = pdfTocAtPage(readerSession.tocIndex, displayPage - 1)
                        if (activeItem?.href && this._activeSession === readerSession) this.highlightActiveTOCItem(activeItem.href)
                        if (activeItem && readerSession.location) readerSession.location.tocItem = activeItem
                    }
                }, 20)

                return
            }

            // EPUB / Reflow format
            const sessionView = document.createElement('foliate-view')
            readerSession.view = sessionView
            this.foliateView = sessionView
            this.dom.readerContentArea.appendChild(sessionView)

            // Pre-register ALL Events BEFORE calling open / init
            sessionView.addEventListener('relocate', e => {
                if (readerSession.isCurrent()) {
                    readerSession.location = e.detail
                    this.onReaderRelocate(e.detail, readerSession)
                }
            })
            sessionView.addEventListener('load', e => {
                if (readerSession.isCurrent()) {
                    this.onSectionLoaded(e.detail)
                }
            })

            sessionView.addEventListener('link', async e => {
                if (!readerSession.isCurrent()) return
                const { a, href, href_ } = e.detail || {}
                const targetHref = href || href_ || ''
                
                if (targetHref.startsWith('http://') || targetHref.startsWith('https://') || targetHref.startsWith('mailto:')) {
                    e.preventDefault()
                    try {
                        platformBridge.openExternal(targetHref)
                    } catch (openErr) {
                        console.warn('Failed to open external link:', targetHref, openErr)
                    }
                    return
                }

                const cleanText = (a?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(【]|[\]）)】]$/g, '')
                const isNumericOrSymbolMark = /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注)\s*[\]）)】]?$/.test(cleanText)
                const isSup = !!(a?.closest('sup, sub, .math-super') || 
                                 a?.querySelector('sup, sub, .math-super') || 
                                 a?.classList?.contains('math-super'))
                const footnoteContainer = a?.parentElement?.closest?.(
                    'ol.duokan-footnote-content, ol.footnotes, ul.footnotes, ' +
                    'li.duokan-footnote-item, li.footnote, li.endnote, ' +
                    'aside[epub\\:type~="footnote"], aside[epub\\:type~="endnote"], ' +
                    'aside[role~="doc-footnote"], aside[role~="doc-endnote"], ' +
                    'aside.footnote, section.footnotes, [role~="doc-footnote"]'
                )
                const isSourceInFootnote = !!footnoteContainer && !a?.matches?.('.duokan-footnote, .epub-footnote, .footnote-ref, [epub\\:type~="noteref"], [role~="doc-noteref"]')
                
                if (isSourceInFootnote) {
                    return
                }

                const targetId = targetHref.includes('#') ? targetHref.split('#')[1] : null
                const isNoteIdPattern = targetId ? /(?:filepos|fn|footnote|note|nt|ftn|ref|[mfw])\d+/i.test(targetId) : false

                const isNoteref = a?.getAttribute('epub:type') === 'noteref' ||
                                  a?.getAttribute('role') === 'doc-noteref' ||
                                  a?.classList?.contains('epub-footnote') ||
                                  a?.classList?.contains('footnote-ref') ||
                                  a?.classList?.contains('duokan-footnote') ||
                                  a?.hasAttribute('data-wr-footernote') ||
                                  a?.hasAttribute('zy-footnote') ||
                                  a?.hasAttribute('data-note') ||
                                  a?.querySelector?.('img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote') ||
                                  a?.classList?.contains('note') ||
                                  isSup ||
                                  (targetId && isNoteIdPattern && (isNumericOrSymbolMark || !cleanText))

                if (isNoteref && targetId) {
                    const doc = a?.ownerDocument
                    let targetEl = doc ? (doc.getElementById(targetId) || doc.querySelector(`[name="${CSS.escape(targetId)}"]`)) : null
                    
                    const isTargetBacklink = targetEl && (targetEl.closest('sup, sub, .math-super') || targetEl.tagName === 'SUP' || targetEl.querySelector('sup, sub'))
                    if (isTargetBacklink) {
                        this.hideFootnotePopup()
                        return
                    }

                    let footnoteText = (a?.getAttribute('data-wr-footernote') || a?.getAttribute('zy-footnote') || a?.getAttribute('data-note') || '').trim()
                    if (!footnoteText) {
                        footnoteText = this.extractFootnoteFromTarget(targetEl, a)
                    }

                    if (!footnoteText && a) {
                        const img = a.querySelector('img')
                        footnoteText = (img?.getAttribute('alt') || a.getAttribute('title') || '').trim()
                    }

                    if (!footnoteText && sessionView?.book) {
                        try {
                            const book = sessionView.book
                            const resolved = book.resolveHref ? (book.resolveHref(targetHref) || (href_ ? book.resolveHref(href_) : null)) : null
                            if (resolved && resolved.index != null) {
                                const targetSec = book.sections[resolved.index]
                                const secDoc = await targetSec?.createDocument?.()
                                if (secDoc) {
                                    const extEl = secDoc.getElementById(targetId) || secDoc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                                    if (extEl) {
                                        if (extEl.closest('sup, sub, .math-super') || extEl.tagName === 'SUP') {
                                            this.hideFootnotePopup()
                                            return
                                        }
                                        footnoteText = this.extractFootnoteFromTarget(extEl, a)
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('External footnote lookup error in link event:', err)
                        }
                    }

                    if (footnoteText) {
                        e.preventDefault()
                        const rect = a.getBoundingClientRect()
                        const doc = a.ownerDocument
                        const iframe = doc?.defaultView?.frameElement || sessionView?.shadowRoot?.querySelector('iframe') || sessionView
                        const iframeRect = (iframe || sessionView).getBoundingClientRect()
                        const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                        const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                        let anchorLabel = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(]|[\]）)]$/g, '')
                        if (!anchorLabel && targetId) {
                            const m = targetId.match(/(?:fn|footnote|note|ref)?([0-9\.]+)/i)
                            if (m) anchorLabel = m[1]
                        }
                        const popupTitle = anchorLabel && anchorLabel.length <= 8 ? `💡 译注与说明 [${anchorLabel}]` : '💡 译注与说明'
                        
                        this.showFootnotePopup({
                            title: popupTitle,
                            text: footnoteText,
                            rect: {
                                top: iframeRect.top + ((rect.top || 0) * scaleY),
                                left: iframeRect.left + ((rect.left || 0) * scaleX),
                                width: (rect.width || 40) * scaleX,
                                height: (rect.height || 20) * scaleY
                            }
                        })
                        return
                    }
                }
            })

            // Overlayer Annotation Rendering
            sessionView.addEventListener('draw-annotation', e => {
                if (!readerSession.isCurrent()) return
                const { draw, annotation } = e.detail
                const { color = '#facc15', style = 'highlight' } = annotation
                const writingMode = this.settings.writingMode || 'horizontal'
                if (style === 'underline') {
                    draw(Overlayer.underline, { color, width: 2.6, writingMode })
                } else if (style === 'dashed') {
                    draw(Overlayer.dashed, { color: color === '#facc15' ? '#64748b' : color, width: 2, writingMode })
                } else if (style === 'squiggly') {
                    draw(Overlayer.squiggly, { color, width: 2.2, writingMode })
                } else if (style === 'strikethrough') {
                    draw(Overlayer.strikethrough, { color, width: 2.5, writingMode })
                } else {
                    draw(Overlayer.highlight, { color, realisticPen: this.settings.realisticPen !== false, writingMode })
                }
            })

            // When new section overlay is mounted, draw saved highlights that match current content identity!
            sessionView.addEventListener('create-overlay', async () => {
                if (!readerSession.isCurrent()) return
                const highlights = await db.getHighlightsByBook(readerSession.bookId)
                if (!readerSession.isCurrent()) return
                for (const hl of highlights) {
                    const match = db.isContentIdentityMatching(hl, snapshot)
                    if (!match.matches) {
                        // Do not silently draw unconfirmed or conflicting highlights
                        continue
                    }
                    try {
                        await sessionView.addAnnotation({
                            value: `${hl.cfi}::${hl.style || 'highlight'}`,
                            id: hl.id,
                            color: hl.color,
                            style: hl.style || 'highlight'
                        })
                    } catch (err) {
                        // Section index mismatch handled internally by foliate-js
                    }
                }
            })

            // Clicked an existing highlight on the page!
            sessionView.addEventListener('show-annotation', e => {
                if (!readerSession.isCurrent()) return
                const { value, range } = e.detail
                this.onHighlightClicked(value, range)
            })

            await sessionView.open(fileObj)
            if (!readerSession.isCurrent()) {
                sessionView?.close?.()
                sessionView?.remove?.()
                if (this.foliateView === sessionView) {
                    this.foliateView = null
                }
                return
            }
            
            // Set initial styles & flow
            this.applySettingsToReader()

            // Restore location with content identity check
            let lastLoc = 0
            const progressMeta = bookData.progress
            const isProgressIdentityMatching = !progressMeta || !progressMeta.blobRevision || db.isContentIdentityMatching(progressMeta, snapshot).matches
            if (isProgressIdentityMatching) {
                if (bookData.progress?.cfi && bookData.progress.cfi.split('!')[1]?.split('/').length > 2) {
                    lastLoc = bookData.progress.cfi
                } else if (bookData.progress?.fraction != null && bookData.progress.fraction > 0) {
                    lastLoc = { fraction: bookData.progress.fraction }
                } else if (bookData.progress?.cfi) {
                    lastLoc = bookData.progress.cfi
                }
            }
            await sessionView.init({ lastLocation: lastLoc })
            if (!readerSession.isCurrent()) {
                sessionView?.close?.()
                sessionView?.remove?.()
                if (this.foliateView === sessionView) {
                    this.foliateView = null
                }
                return
            }

            // Ensure any already-loaded content doc is initialized
            const contents = sessionView.renderer?.getContents?.() || []
            for (const item of contents) {
                if (item?.doc) this.onSectionLoaded(item)
            }

            // Start Reading Session & Timer
            const startFrac = (isProgressIdentityMatching && bookData.progress?.fraction) || 0
            tracker.startSession(bookId, bookData.title, startFrac)
            db.recordBookOpened(bookId).catch(err => {
                console.warn('Failed to record book opened for EPUB:', err)
            })
            tracker.onTickCallback = ({ seconds, sessionSeconds, todaySeconds, isIdle }) => {
                if (this.dom.readerLiveTimer && readerSession.isCurrent()) {
                    const activeSecs = sessionSeconds != null ? sessionSeconds : seconds
                    const timeText = activeSecs < 60 ? '< 1分钟' : `${Math.floor(activeSecs / 60)}分钟`
                    this.dom.readerLiveTimer.innerText = isIdle ? `⏱️ 暂停中 (本次 ${timeText})` : `⏱️ 本次 ${timeText}`
                }
            }

            // Display floating zoom bar for fixed-layout / comic formats (CBZ), hide for reflow formats (EPUB, MOBI, TXT, DOCX)
            if (sessionView?.isFixedLayout || bookData?.format === 'cbz') {
                if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'flex'
                this.setPDFZoom('fit-page')
            } else {
                if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'none'
            }

            // Defer non-critical TOC and notes population so first page paints with zero delay
            setTimeout(() => {
                if (readerSession.isCurrent() && this.currentBookId === bookId && this.foliateView === sessionView) {
                    this.renderTOC(sessionView.book?.toc || [])
                    this.loadNotesList()
                }
            }, 20)

        } catch (err) {
            if (readerSession.isCurrent()) {
                console.error('Failed to open book in reader:', err)
                this.showToast(`打开书籍失败: ${err.message}`, '⚠️')
                this.closeReader()
            } else {
                try { readerSession.view?.close?.() } catch (e) {}
                try { readerSession.view?.remove?.() } catch (e) {}
                try { readerSession.viewport?.destroy?.() } catch (e) {}
                try { readerSession.driver?.destroy?.() } catch (e) {}
            }
        }
    }

    // Flush pending progress + session time on direct window close (no UI teardown)
    async flushReaderStateOnExit(requestId = null) {
        if (typeof requestId === 'string' && requestId.length > 0) {
            this._activeFlushRequests = this._activeFlushRequests || new Map()
            this._completedFlushRequests = this._completedFlushRequests || new Map()

            if (this._activeFlushRequests.has(requestId)) {
                return this._activeFlushRequests.get(requestId)
            }
            if (this._completedFlushRequests.has(requestId)) {
                return this._completedFlushRequests.get(requestId)
            }
        }

        const doFlush = async () => {
            let progressBackupSaved = false
            let trackerBackupSaved = false

            // 1. Synchronous capture and pre-await backup
            try {
                this.foliateView?.renderer?.settle?.()
            } catch (e) {}
            if (this._progressDebounceTimer) {
                clearTimeout(this._progressDebounceTimer)
                this._progressDebounceTimer = null
            }

            const activeSession = this._activeSession
            const activeBookId = this.currentBookId || activeSession?.bookId
            const activeSnapshot = activeSession?.snapshot || this._currentSnapshot
            const activeLocation = activeSession?.location || this.currentLocation
            let progressSnapshot = null

            if (activeSession && activeSession.isCurrent() && activeBookId && activeSnapshot) {
                progressSnapshot = this.makeProgressSnapshot(activeSession)
                if (progressSnapshot) {
                    try {
                        progressBackupSaved = db.backupPendingProgress(activeBookId, progressSnapshot) === true
                    } catch (bErr) {
                        console.warn('flushReaderStateOnExit: progress backup failed:', bErr)
                    }
                }
            }

            const endFrac = Number.isFinite(activeLocation?.fraction) ? activeLocation.fraction : null
            try {
                trackerBackupSaved = tracker.backupPendingSession(endFrac) === true
            } catch (tErr) {
                console.warn('flushReaderStateOnExit: tracker backup failed:', tErr)
            }

            // 2. Decoupled and truly independent asynchronous flushes with bounded timeout (<= 1200ms)
            // Rust closes process after 1500ms; flushes must complete or report backup within 1200ms
            const TIMEOUT_MS = 1200
            let progressTimedOut = false

            const rawProgressPromise = (async () => {
                if (!activeBookId || !progressSnapshot) {
                    return { status: 'not_applicable', saved: false }
                }
                try {
                    const res = await db.updateBookProgress(activeBookId, progressSnapshot)
                    if (res !== false && res !== null) {
                        if (!progressTimedOut) {
                            try {
                                db.clearPendingProgressBackup(activeBookId, progressSnapshot.updatedAt, progressSnapshot._backupId)
                            } catch (cErr) {}
                        }
                        return { status: 'committed', saved: true }
                    } else {
                        return { status: progressBackupSaved ? 'backed_up' : 'failed', saved: false }
                    }
                } catch (pErr) {
                    console.warn('flushReaderStateOnExit: db.updateBookProgress failed:', pErr)
                    return { status: progressBackupSaved ? 'backed_up' : 'failed', saved: false }
                }
            })()

            const boundedProgressPromise = Promise.race([
                rawProgressPromise,
                new Promise(resolve => setTimeout(() => {
                    progressTimedOut = true
                    resolve({ status: progressBackupSaved ? 'backed_up' : 'failed', saved: false, timedOut: true })
                }, TIMEOUT_MS))
            ])

            const rawTrackerPromise = (async () => {
                if (!tracker.isTracking && !tracker._sessionQueueTail) {
                    return { status: 'not_applicable', saved: false }
                }
                try {
                    const res = await tracker.endSession(endFrac, activeBookId)
                    if (res?.status === 'filtered_short_session') {
                        return { status: 'filtered_short_session', saved: false }
                    }
                    if (res?.status === 'not_applicable') {
                        return { status: 'not_applicable', saved: false }
                    }
                    return { status: 'committed', saved: true }
                } catch (eErr) {
                    console.warn('flushReaderStateOnExit: tracker.endSession failed:', eErr)
                    return { status: trackerBackupSaved ? 'backed_up' : 'failed', saved: false }
                }
            })()

            const boundedTrackerPromise = Promise.race([
                rawTrackerPromise,
                new Promise(resolve => setTimeout(() => {
                    resolve({ status: trackerBackupSaved ? 'backed_up' : 'failed', saved: false, timedOut: true })
                }, TIMEOUT_MS))
            ])

            const [pRes, tRes] = await Promise.all([boundedProgressPromise, boundedTrackerPromise])

            // 3. Status determination & synthesis
            let status = 'database_success'
            const hasFailure = pRes.status === 'failed' || tRes.status === 'failed'
            const hasBackup = pRes.status === 'backed_up' || tRes.status === 'backed_up'

            if (hasFailure) {
                status = 'failed'
            } else if (hasBackup) {
                status = 'recovery_backup_success'
            } else {
                status = 'database_success'
            }

            const result = {
                status,
                progressStatus: pRes.status,
                trackerStatus: tRes.status,
                progressSaved: pRes.saved,
                trackerSaved: tRes.saved,
                progressBackupSaved,
                trackerBackupSaved
            }

            // 4. Close handshake completion: Only call if requestId is a non-empty string
            if (typeof requestId === 'string' && requestId.length > 0) {
                try {
                    platformBridge.flushComplete(requestId)
                } catch (fErr) {
                    console.warn('flushReaderStateOnExit: flushComplete failed:', fErr)
                }

                this._completedFlushRequests = this._completedFlushRequests || new Map()
                this._completedFlushRequests.set(requestId, result)
                if (this._completedFlushRequests.size > 100) {
                    const oldest = this._completedFlushRequests.keys().next().value
                    this._completedFlushRequests.delete(oldest)
                }
            }

            return result
        }

        if (typeof requestId === 'string' && requestId.length > 0) {
            const flushPromise = doFlush()
            this._activeFlushRequests.set(requestId, flushPromise)
            try {
                return await flushPromise
            } finally {
                this._activeFlushRequests.delete(requestId)
            }
        }

        return await doFlush()
    }

    async closeReader() {
        const closingSession = this._activeSession
        if (!closingSession) {
            this.dom.readerView?.classList.remove('active')
            if (this.dom.bookshelfView) this.dom.bookshelfView.style.display = 'flex'
            return
        }

        // 1. Immediately and synchronously abort closing session so its callbacks become no-op
        closingSession.abortController?.abort()

        // 2. Synchronously capture session's fixed parameters and views
        const closingBookId = closingSession.bookId
        const closingProgress = this.makeProgressSnapshot(closingSession)
        const closingLocation = closingSession.location || this.currentLocation
        const closingFoliateView = closingSession.view || this.foliateView
        const closingPdfViewport = closingSession.viewport || this.pdfViewport
        const closingPdfDriver = closingSession.driver || this.pdfDriver

        // 3. Synchronously detach views from `this` ONLY if they belong to closingSession
        if (this.foliateView === closingFoliateView) this.foliateView = null
        if (this.pdfViewport === closingPdfViewport) this.pdfViewport = null
        if (this.pdfDriver === closingPdfDriver) this.pdfDriver = null
        if (this._activeSession === closingSession) this.currentPdfTOC = null

        // 4. Synchronously settle paginator and destroy closing views
        try {
            closingFoliateView?.renderer?.settle?.()
        } catch (e) {}
        try { closingFoliateView?.close?.() } catch (e) {}
        try { closingFoliateView?.remove?.() } catch (e) {}
        try { closingPdfViewport?.destroy?.() } catch (e) {}
        try { closingPdfDriver?.destroy?.() } catch (e) {}

        // 5. Clear pending progress debounce timer
        if (this._progressDebounceTimer) {
            clearTimeout(this._progressDebounceTimer)
            this._progressDebounceTimer = null
        }

        // 6. Stop reading tracker
        tracker.onTickCallback = null

        // 7. If active session is still closingSession, clean up active state
        if (this._activeSession === closingSession) {
            this._activeSession = null
            this.currentBookId = null
            this.currentBookData = null
            this._currentSnapshot = null
            this.currentLocation = null
        }

        if (this.dom.pdfZoomBar) {
            this.dom.pdfZoomBar.style.display = 'none'
        }
        this.clearSearchState(true)
        this.closeDrawer()
        this.hideSelectionPopup()
        this.hideHighlightActionPopup()
        this.toggleReaderUI(true)

        // 8. Trigger UI transition only if no new session has started
        if (!this._activeSession) {
            this.dom.readerView.classList.remove('active')
            this.dom.readerView.classList.add('closing')
            this.dom.bookshelfView.style.display = 'flex'
            this.dom.bookshelfView.classList.remove('view-spring-transition')
            void this.dom.bookshelfView.offsetWidth
            this.dom.bookshelfView.classList.add('view-spring-transition')

            if (this._closeTimer) clearTimeout(this._closeTimer)
            this._closeTimer = setTimeout(() => {
                this._closeTimer = null
                if (!this._activeSession) {
                    this.dom.readerView?.classList.remove('closing')
                    if (this.dom.readerView) this.dom.readerView.style.display = 'none'
                    this.dom.bookshelfView?.classList.remove('view-spring-transition')
                }
            }, 240)

            // Reset PDF drawing state so the pen tool never leaks into the next book
            this.pdfDrawTool = null
            this.pdfOverlayCanvas = null
            this.currentPdfPageIndex = 0
            this.shelfViewMode = 'grid'
            this.shelfCategory = 'all'
            this.sidebarUserCollapsed = true
            document.getElementById('bookshelf-view')?.classList.add('sidebar-collapsed')
            this.updateSettingsUI()
            if (this.dom.booksWorkspace) {
                this.dom.booksWorkspace.scrollTop = 0
            }
        }

        // 9. Asynchronously flush progress and end tracker using captured parameters
        const closingEpoch = this._currentBookEpoch

        // End tracker independently (do not block progress update)
        if (closingLocation?.fraction != null) {
            tracker.endSession(closingLocation.fraction).catch(err => {
                console.warn('Failed to end tracker session:', err)
            })
        } else {
            tracker.endSession().catch(err => {
                console.warn('Failed to end tracker session:', err)
            })
        }

        // Flush final progress to DB, then refresh bookshelf guarded by session epoch
        const progressPromise = (closingBookId && closingProgress)
            ? db.updateBookProgress(closingBookId, closingProgress)
            : Promise.resolve()

        progressPromise.then(() => {
            if (this._currentBookEpoch === closingEpoch && !this._activeSession) {
                this.refreshBookshelf().catch(err => {
                    console.warn('Failed to refresh bookshelf after book close:', err)
                })
            }
        }).catch(err => {
            console.warn('Failed to flush final book progress:', err)
            if (this._currentBookEpoch === closingEpoch && !this._activeSession) {
                this.refreshBookshelf().catch(() => {})
            }
        })

        if (this.syncConfig?.enabled && this.syncConfig?.autoSyncOnBookClose) {
            this.triggerSilentBackgroundSync()
        }
    }

    onReaderRelocate(detail, session = this._activeSession) {
        if (session) {
            session.location = detail
            if (!session.isCurrent()) return
        }
        if (!this.currentBookId) return
        if (session && this._activeSession !== session) return
        this.hideFootnotePopup()
        const activeBookId = this.currentBookId
        const activeEpoch = this._currentBookEpoch

        // Only record page turns for the initial turn (fast-path or standard), not the debounced settlement
        if (!detail.isSettled) {
            tracker.resetActivity()
            tracker.recordPageTurn()
        }
        this.currentLocation = detail
        const fraction = Number.isFinite(detail.fraction) ? detail.fraction : 0
        const pctFloat = fraction * 100
        const pctRounded = Math.round(pctFloat)
        const pctDisplay = pctFloat > 0 && pctFloat < 100 && pctFloat % 1 !== 0 
            ? pctFloat.toFixed(1).replace(/\.0$/, '') 
            : `${pctRounded}`

        if (this.dom.progressSlider) {
            this.dom.progressSlider.value = pctFloat.toFixed(1)
        }
        if (this.dom.progressText) {
            this.dom.progressText.innerText = `${pctDisplay}%`
        }

        // Smart Estimated Time Left (ETA) using Adaptive Dual-State Time Window Engine
        if (this.dom.readerEtaBadge) {
            if (fraction >= 0.99) {
                this.dom.readerEtaBadge.innerText = '🎉 即将读完'
            } else if (fraction <= 0.005) {
                this.dom.readerEtaBadge.innerText = '预计还需 --'
            } else {
                let remainingSecs = 0
                const paceSecs = tracker.getCurrentPaceSecs()
                const isFixed = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
                
                if (isFixed && detail.totalPages && detail.page && detail.totalPages > detail.page) {
                    // Fixed layout (PDF): exact page count difference
                    const remainingPages = detail.totalPages - detail.page
                    remainingSecs = remainingPages * paceSecs
                } else if (detail.location?.total > 0 && detail.location?.current != null) {
                    // Reflow layout with whole-book location metrics
                    const remainingLocs = Math.max(0, detail.location.total - (detail.location.current + 1))
                    const effectivePace = Math.max(25, paceSecs || 30)
                    const baselineRemaining = remainingLocs * effectivePace
                    const totalActiveSecs = (this.currentBookData?.totalReadingSeconds || 0) + (tracker.sessionCumulativeSeconds || 0)
                    if (totalActiveSecs >= 300 && fraction > 0.05 && fraction < 0.95) {
                        const rawRemaining = (totalActiveSecs / fraction) * (1 - fraction)
                        remainingSecs = Math.min(86400 * 3, Math.max(Math.round(baselineRemaining * 0.5), Math.round(rawRemaining)))
                    } else {
                        remainingSecs = Math.round(baselineRemaining)
                    }
                } else {
                    const totalActiveSecs = (this.currentBookData?.totalReadingSeconds || 0) + (tracker.sessionCumulativeSeconds || 0)
                    if (totalActiveSecs >= 90 && fraction > 0.01) {
                        const rawRemaining = (totalActiveSecs / fraction) * (1 - fraction)
                        remainingSecs = Math.min(86400 * 3, Math.max(60, Math.round(rawRemaining)))
                    } else {
                        const estimatedTotalScreens = Math.max(20, Math.round(1 / Math.max(0.005, fraction || 0.01)))
                        remainingSecs = Math.round((1 - fraction) * Math.min(500, estimatedTotalScreens) * paceSecs)
                    }
                }
                this.dom.readerEtaBadge.innerText = `预计还需 ${tracker.formatDuration(remainingSecs)}`
            }
        }

        // PDF Page Index Tracking and Overlay Mount
        const isPdfMode = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
        if (isPdfMode) {
            this.currentPdfPageIndex = (detail.index != null) ? detail.index : (detail.page != null ? detail.page - 1 : 0)
            setTimeout(() => {
                if (this.currentBookId === activeBookId && this._currentBookEpoch === activeEpoch) {
                    this.renderPdfDrawingOverlayForCurrentPage()
                }
            }, 100)
        }

        // Page Number Indicator
        if (this.dom.readerPageNumber) {
            if (isPdfMode) {
                const p = detail.page != null ? detail.page : (detail.index != null ? detail.index + 1 : 1)
                const t = detail.totalPages || 1
                this.dom.readerPageNumber.innerText = `${p} / ${t} 页`
                this.dom.readerPageNumber.title = `点击可输入页码快速跳转 (1 ~ ${t})`
            } else if (detail.location?.total > 0) {
                const cur = detail.location.current + 1
                const tot = detail.location.total
                this.dom.readerPageNumber.innerText = `第 ${cur} / ${tot} 页`
                const chPage = (detail.page != null && detail.totalPages != null) ? ` · 本节 ${detail.page}/${detail.totalPages} 屏` : ''
                const tocTitle = detail.tocItem?.label ? `【${detail.tocItem.label}】` : ''
                this.dom.readerPageNumber.title = `${tocTitle}全书第 ${cur} / ${tot} 页${chPage}（点击可跳转）`
            } else if (detail.page != null && detail.totalPages != null) {
                this.dom.readerPageNumber.innerText = `${detail.page} / ${detail.totalPages} 页`
                this.dom.readerPageNumber.title = `点击可输入页码快速跳转 (1 ~ ${detail.totalPages})`
            } else {
                this.dom.readerPageNumber.innerText = `${pctDisplay}%`
                this.dom.readerPageNumber.title = '点击可快速跳转'
            }
        }

        // Update active TOC item
        if (detail.tocItem) {
            this.highlightActiveTOCItem(detail.tocItem.href)
        }

        // Save progress to IndexedDB with debounce using unified makeProgressSnapshot
        clearTimeout(this._progressDebounceTimer)
        this._progressDebounceTimer = setTimeout(() => {
            if (session && session.isCurrent() && this._activeSession === session && this.currentBookId === activeBookId) {
                const progressSnapshot = this.makeProgressSnapshot(session)
                if (progressSnapshot) {
                    db.updateBookProgress(activeBookId, progressSnapshot).catch(err => console.warn('Failed to update book progress:', err))
                }
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
            // Fix distorted/squashed Calibre SVG covers (preserveAspectRatio="none")
            doc.querySelectorAll('svg').forEach(svg => {
                const par = svg.getAttribute('preserveAspectRatio')
                if (par === 'none' || (!par && svg.querySelector('image'))) {
                    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
                }
                svg.style.maxWidth = '100%'
                svg.style.maxHeight = '100%'
            })

            // Prevent empty first page: Neutralize page-break-before on first visible elements
            const firstChild = doc.body.firstElementChild
            if (firstChild) {
                firstChild.style.setProperty('page-break-before', 'avoid', 'important')
                firstChild.style.setProperty('break-before', 'avoid', 'important')
                const grandChild = firstChild.firstElementChild
                if (grandChild) {
                    grandChild.style.setProperty('page-break-before', 'avoid', 'important')
                    grandChild.style.setProperty('break-before', 'avoid', 'important')
                }
            }

            // Neutralize publisher hardcoded background colors on containers (like .kuai, .body)
            doc.querySelectorAll('.kuai, .body, [class*="kuai"]').forEach(el => {
                el.style.setProperty('background-color', 'transparent', 'important')
                el.style.setProperty('background', 'transparent', 'important')
            })

            // Prevent oversized percentage top margins (e.g. margin-top: 65%) from spilling title divs into empty extra pages
            doc.querySelectorAll('.kuai, [style*="margin-top"]').forEach(el => {
                const mt = el.style.marginTop
                if (mt && (mt.includes('%') || mt.includes('vh'))) {
                    const val = parseFloat(mt)
                    if (val > 20) {
                        el.style.setProperty('margin-top', '15vh', 'important')
                    }
                }
            })

            // 1. Safe Non-Destructive Hiding of Calibre Dummy Page Breaks & Ghost Elements
            // (Only hide genuinely empty dummy markers without text or media to preserve Calibre chapter root divs)
            const calibrePbs = doc.querySelectorAll('[id*="calibre_pb" i], [class*="calibre_pb" i], .calibre_pb')
            calibrePbs.forEach(el => {
                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, audio, canvas, table, iframe')
                if (!rawText && !hasMedia) {
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
                }
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

            // Also scan short standalone paragraphs matching chapter title patterns
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

                // Mark dropcaps to prevent awkward double indent
                if (el.querySelector('.dropcap, [class*="dropcap" i], [class*="first-letter" i]')) {
                    el.dataset.hasDropcap = 'true'
                }

                // Normalize hardcoded full-width leading spaces (\u3000\u3000) so text-indent: 2em standardizes layout
                if (el.tagName?.toLowerCase() === 'p' && el.firstChild && el.firstChild.nodeType === 3) {
                    const val = el.firstChild.nodeValue
                    if (val && /^[\u3000\u00a0\s]{1,4}/.test(val)) {
                        el.firstChild.nodeValue = val.replace(/^[\u3000\u00a0\s]{1,4}/, '')
                    }
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

        // Synchronize local bundled fonts to iframe document
        if (doc.fonts && document.fonts) {
            try {
                for (const f of document.fonts) {
                    doc.fonts.add(f)
                }
            } catch {}
        }

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

        // Chinese Quotes Transformation
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
            if (!e.ctrlKey && !e.metaKey && !e.altKey && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'h', 'H', 'l', 'L', 'j', 'J', 'k', 'K', ' ', 'Enter'].includes(e.key)) {
                e.preventDefault()
                e.stopPropagation()
            }
            this.handleGlobalKeydown(e)
        }
        // Register on the iframe document only. Adding the same handler to
        // doc.defaultView as well made every keydown fire twice (capture order
        // Window -> Document), double-toggling fullscreen and skipping search matches.
        doc.addEventListener('keydown', iframeKeyHandler, true)
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
            if (this.pdfDrawTool) {
                return
            }
            if (isDragGesture) {
                isDragGesture = false
                return
            }

            const standaloneFootnote = e.target.closest(
                'img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote, ' +
                '[data-wr-footernote], [zy-footnote], [data-note], .duokan-footnote'
            )
            if (standaloneFootnote) {
                const noteText = (
                    standaloneFootnote.getAttribute('data-wr-footernote') ||
                    standaloneFootnote.getAttribute('zy-footnote') ||
                    standaloneFootnote.getAttribute('data-note') ||
                    standaloneFootnote.getAttribute('alt') ||
                    standaloneFootnote.getAttribute('title') ||
                    ''
                ).trim()
                if (noteText) {
                    e.preventDefault()
                    e.stopPropagation()
                    e.stopImmediatePropagation()
                    const rect = standaloneFootnote.getBoundingClientRect()
                    const doc = standaloneFootnote.ownerDocument
                    const iframe = doc?.defaultView?.frameElement || this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView
                    const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                    const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                    const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                    this.showFootnotePopup({
                        title: '💡 译注与说明',
                        text: noteText,
                        rect: {
                            top: rect.top * scaleY + iframeRect.top,
                            left: rect.left * scaleX + iframeRect.left,
                            width: rect.width * scaleX,
                            height: rect.height * scaleY
                        }
                    })
                    return
                }
            }

            const a = e.target.closest('a[href]') || e.target.closest('a')
            if (a) {
                const href = a.getAttribute('href') || ''
                const cleanText = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(【]|[\]）)】]$/g, '')
                const isNumericOrSymbolMark = /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注)\s*[\]）)】]?$/.test(cleanText)
                const isSup = !!(a.closest('sup, sub, .math-super') || 
                                 a.querySelector('sup, sub, .math-super') || 
                                 a.classList.contains('math-super'))
                // Check if clicked anchor is located inside an actual footnote container (a return backlink from notes to body)
                const footnoteContainer = a.parentElement?.closest?.(
                    'ol.duokan-footnote-content, ol.footnotes, ul.footnotes, ' +
                    'li.duokan-footnote-item, li.footnote, li.endnote, ' +
                    'aside[epub\\:type~="footnote"], aside[epub\\:type~="endnote"], ' +
                    'aside[role~="doc-footnote"], aside[role~="doc-endnote"], ' +
                    'aside.footnote, section.footnotes, [role~="doc-footnote"]'
                )
                const isSourceInFootnote = !!footnoteContainer && !a.matches?.('.duokan-footnote, .epub-footnote, .footnote-ref, [epub\\:type~="noteref"], [role~="doc-noteref"]')
                
                // If the user clicked a return backlink inside the footnote section, allow normal jump back to story
                if (isSourceInFootnote) {
                    return
                }

                const targetId = href.includes('#') ? href.split('#')[1] : null
                const isNoteIdPattern = targetId ? /(?:filepos|fn|footnote|note|nt|ftn|ref|[mfw])\d+/i.test(targetId) : false

                const isNoteref = a.getAttribute('epub:type') === 'noteref' || 
                                  a.getAttribute('role') === 'doc-noteref' || 
                                  a.classList.contains('epub-footnote') ||
                                  a.classList.contains('footnote-ref') ||
                                  a.classList.contains('duokan-footnote') ||
                                  a.hasAttribute('data-wr-footernote') ||
                                  a.hasAttribute('zy-footnote') ||
                                  a.hasAttribute('data-note') ||
                                  a.querySelector('img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote') ||
                                  a.classList.contains('note') ||
                                  isSup ||
                                  (targetId && isNoteIdPattern && (isNumericOrSymbolMark || !cleanText))

                if (isNoteref && targetId) {
                    let targetEl = doc.getElementById(targetId) || doc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                    
                    // If target is inside <sup> in story text, this is a backlink returning to main text; do NOT show popup!
                    const isTargetBacklink = targetEl && (targetEl.closest('sup, sub, .math-super') || targetEl.tagName === 'SUP' || targetEl.querySelector('sup, sub'))
                    if (isTargetBacklink) {
                        this.hideFootnotePopup()
                        return
                    }

                    let footnoteText = (a.getAttribute('data-wr-footernote') || a.getAttribute('zy-footnote') || a.getAttribute('data-note') || '').trim()
                    if (!footnoteText) {
                        footnoteText = this.extractFootnoteFromTarget(targetEl, a)
                    }
                    
                    // Fallback to img alt or title or text
                    if (!footnoteText && a) {
                        const img = a.querySelector('img')
                        footnoteText = (img?.getAttribute('alt') || a.getAttribute('title') || '').trim()
                    }

                    // If still empty and link points to another file in book, resolve external section
                    if (!footnoteText && this.foliateView?.book) {
                        try {
                            const book = this.foliateView.book
                            const section = book.sections[index]
                            const fullHref = section?.resolveHref?.(href) ?? href
                            const resolved = book.resolveHref ? (book.resolveHref(fullHref) || book.resolveHref(href)) : null
                            if (resolved && resolved.index != null && resolved.index !== index) {
                                const targetSec = book.sections[resolved.index]
                                const secDoc = await targetSec?.createDocument?.()
                                if (secDoc) {
                                    const extEl = secDoc.getElementById(targetId) || secDoc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                                    if (extEl) {
                                        if (extEl.closest('sup, sub, .math-super') || extEl.tagName === 'SUP') {
                                            this.hideFootnotePopup()
                                            return
                                        }
                                        footnoteText = this.extractFootnoteFromTarget(extEl, a)
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('External footnote lookup error in doc click:', err)
                        }
                    }
                    
                    if (footnoteText) {
                        e.preventDefault()
                        e.stopPropagation()
                        e.stopImmediatePropagation()
                        
                        const rect = a.getBoundingClientRect()
                        const doc = a.ownerDocument
                        const iframe = doc?.defaultView?.frameElement || this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView
                        const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                        const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                        const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                        let anchorLabel = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(]|[\]）)]$/g, '')
                        if (!anchorLabel && targetId) {
                            const m = targetId.match(/(?:fn|footnote|note|ref)?([0-9\.]+)/i)
                            if (m) anchorLabel = m[1]
                        }
                        const popupTitle = anchorLabel && anchorLabel.length <= 8 ? `💡 译注与说明 [${anchorLabel}]` : '💡 译注与说明'
                        
                        this.showFootnotePopup({
                            title: popupTitle,
                            text: footnoteText,
                            rect: {
                                top: iframeRect.top + ((rect.top || 0) * scaleY),
                                left: iframeRect.left + ((rect.left || 0) * scaleX),
                                width: (rect.width || 40) * scaleX,
                                height: (rect.height || 20) * scaleY
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

            // Reverse footnote lookup: when user clicks an in-text mark with id (e.g. <img id="filepos70497"> in Kindle books)
            if (!a && e.target) {
                const targetMark = e.target.closest('[id*="filepos"], [id^="fn"], [id^="note"]') || (e.target.id && /(?:filepos|fn|note)\d+/i.test(e.target.id) ? e.target : null)
                if (targetMark && targetMark.id) {
                    const noteAnchor = doc.querySelector(`a[href="#${targetMark.id}"]`)
                    if (noteAnchor) {
                        const footnoteText = this.extractFootnoteFromTarget(noteAnchor.closest('li, p, blockquote, dd') || noteAnchor, noteAnchor)
                        if (footnoteText) {
                            e.preventDefault()
                            e.stopPropagation()
                            e.stopImmediatePropagation()
                            const rect = targetMark.getBoundingClientRect()
                            const iframe = doc?.defaultView?.frameElement || this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView
                            const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
                            const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                            const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                            this.showFootnotePopup({
                                title: '💡 译注与说明',
                                text: footnoteText,
                                rect: {
                                    top: iframeRect.top + ((rect.top || 0) * scaleY),
                                    left: iframeRect.left + ((rect.left || 0) * scaleX),
                                    width: (rect.width || 20) * scaleX,
                                    height: (rect.height || 20) * scaleY
                                }
                            })
                            return
                        }
                    }
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
            if (e.ctrlKey || e.metaKey) {
                if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                    e.preventDefault()
                    this.stepPDFZoom(e.deltaY < 0 ? 10 : -10)
                    return
                }
                return
            }

            if (this.settings.layout === 'scrolled') return
            // In PDF / Fixed-layout mode, wheel / trackpad must scroll the container for free panning!
            if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                const host = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer
                if (host) {
                    host.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' })
                }
                return
            }

            // In paginated mode, ALWAYS prevent browser native scrolling to protect column alignment!
            e.preventDefault()
            if (wheelCooldown) return
            if (Math.abs(e.deltaY) > 20 || Math.abs(e.deltaX) > 20) {
                wheelCooldown = true
                if (e.deltaY > 0 || e.deltaX > 0) {
                    this.turnPageNext()
                } else {
                    this.turnPagePrev()
                }
                setTimeout(() => {
                    if (this.foliateView) wheelCooldown = false
                }, 220)
            }
        }, { passive: false })

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
            const doc = range.startContainer?.ownerDocument
            const iframe = doc?.defaultView?.frameElement || this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView
            const iframeRect = (iframe || this.foliateView).getBoundingClientRect()
            const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
            const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
            const absRect = {
                top: iframeRect.top + ((rect.top || 0) * scaleY),
                left: iframeRect.left + ((rect.left || 0) * scaleX),
                width: (rect.width || 80) * scaleX,
                height: (rect.height || 24) * scaleY
            }
            this.clickedHighlightInfo = { value, range, rect: absRect }
            this.showHighlightActionPopup(absRect)
        } catch (e) {
            console.warn('onHighlightClicked error:', e)
        }
    }

    async createHighlight(color, style = 'highlight', note = '') {
        const activeSession = this._activeSession
        const snapshot = this._currentSnapshot || {}
        const bookId = activeSession?.bookId || this.currentBookId
        if (!bookId || (activeSession && !activeSession.isCurrent())) return
        if ((!this.selectedTextInfo && (!this.multiSelectedRanges || this.multiSelectedRanges.length === 0))) return
        
        const colorVal = color || '#facc15'

        // Multi-range batch creation
        if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
            const rangesToProcess = [...this.multiSelectedRanges]
            this.clearVirtualMultiSelections()
            for (const item of rangesToProcess) {
                if (activeSession && !activeSession.isCurrent()) return
                const cfi = item.cfi
                const text = item.text.trim()
                if (!text || !cfi) continue
                const hl = {
                    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    bookId: bookId,
                    cfi: cfi,
                    text: text,
                    color: colorVal,
                    style: style,
                    note: note,
                    chapterTitle: this.currentLocation?.tocItem?.label || '正文',
                    createdAt: Date.now(),
                    blobRevision: snapshot.blobRevision,
                    revisionOrigin: snapshot.revisionOrigin,
                    documentHash: snapshot.documentHash
                }
                await db.saveHighlight(hl)
                if (activeSession && !activeSession.isCurrent()) return
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
            if (activeSession && !activeSession.isCurrent()) return
            this.showToast(`✨ 已为 ${rangesToProcess.length} 处选区添加标注`)
            this.multiSelectedRanges = []
            const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
            iframe?.contentDocument?.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
            this.loadNotesList()
            return
        }

        if (this.pdfViewport && (this.selectedTextInfo?.formatType === 'pdf' || this.selectedTextInfo?.pdfTarget)) {
            const hl = {
                id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId: bookId,
                formatType: 'pdf',
                text: this.selectedTextInfo.text,
                color: colorVal,
                style: style,
                note: note,
                chapterTitle: this.currentLocation?.tocItem?.label || '正文',
                createdAt: Date.now(),
                blobRevision: snapshot.blobRevision,
                revisionOrigin: snapshot.revisionOrigin,
                documentHash: snapshot.documentHash,
                pdfTarget: this.selectedTextInfo.pdfTarget
            }
            await db.saveHighlight(hl)
            if (activeSession && !activeSession.isCurrent()) return
            const allHls = await db.getHighlightsByBook(bookId)
            if (activeSession && !activeSession.isCurrent()) return
            this.pdfViewport.setHighlights(allHls, snapshot)
            window.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
            this.loadNotesList()
            this.showToast('已添加高亮笔记', '✓')
            return
        }

        const cfi = this.selectedTextInfo.cfi
        const text = this.selectedTextInfo.text.trim()

        // 1. Check if an annotation of the EXACT SAME style already exists on this CFI for current content identity
        const existingNotes = await db.getHighlightsByBook(bookId)
        if (activeSession && !activeSession.isCurrent()) return
        const matched = existingNotes.find(n => n.cfi === cfi && (n.style || 'highlight') === style && db.isContentIdentityMatching(n, snapshot).matches)

        if (matched) {
            // If user clicked the same color/style with no new note -> TOGGLE OFF / CANCEL THIS STYLE!
            if (!note && matched.color === colorVal) {
                await db.deleteHighlight(matched.id)
                if (activeSession && !activeSession.isCurrent()) return
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
            if (activeSession && !activeSession.isCurrent()) return

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
            bookId: bookId,
            cfi: cfi,
            text: text,
            color: colorVal,
            style: style,
            note: note,
            chapterTitle: this.currentLocation?.tocItem?.label || '正文',
            createdAt: Date.now(),
            blobRevision: snapshot.blobRevision,
            revisionOrigin: snapshot.revisionOrigin,
            documentHash: snapshot.documentHash
        }

        await db.saveHighlight(hl)
        if (activeSession && !activeSession.isCurrent()) return

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
            if (this.pdfViewport) {
                const allHls = await db.getHighlightsByBook(this.currentBookId)
                this.pdfViewport.setHighlights(allHls, this._currentSnapshot)
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
            if (this.pdfViewport) {
                const allHls = await db.getHighlightsByBook(this.currentBookId)
                this.pdfViewport.setHighlights(allHls, this._currentSnapshot)
            }
            this.loadNotesList()
        }
    }

    async findHighlightByCFI(value) {
        if (!this.currentBookId || !value) return null
        const rawCFI = value.includes('::') ? value.split('::')[0] : value
        const notes = await db.getHighlightsByBook(this.currentBookId)
        // 1. Exact ID or exact CFI+style match
        const exactMatch = notes.find(n => n.id === value || `${n.cfi}::${n.style}` === value || n.cfi === value)
        if (exactMatch) return exactMatch
        // 2. Fallback to raw CFI
        return notes.find(n => n.cfi === rawCFI) || null
    }

    // ==========================================
    // Drawer Management (TOC, Notes, Search, Settings)
    // ==========================================
    openDrawer(tab) {
        if (tab === 'settings') this.updateSettingsPanelAvailability()
        this.switchTab(tab)
        if (this.dom.sidebarDrawer) {
            this.dom.sidebarDrawer.style.display = 'flex'
            void this.dom.sidebarDrawer.offsetWidth
            this.dom.sidebarDrawer.classList.add('open')
        }
        this.dom.drawerBackdrop?.classList.add('active')
        this.activeDrawer = true
    }

    // Fixed-layout books (PDF / comic) ignore typography & theme settings, so grey
    // those controls out instead of silently doing nothing
    updateSettingsPanelAvailability() {
        const panel = this.dom.tabPanels?.settings
        if (!panel) return
        const fixed = !!(this.pdfViewport || (this.foliateView && this.foliateView.isFixedLayout) || this.currentBookData?.format === 'pdf')

        panel.querySelectorAll('[data-ll-fixed-note]').forEach(el => el.remove())
        panel.querySelectorAll('.ll-fixed-disabled').forEach(el => {
            el.classList.remove('ll-fixed-disabled')
            el.removeAttribute('title')
        })
        panel.querySelectorAll('input, select, button').forEach(el => { el.disabled = false })

        if (!fixed) return

        const ineffectiveSelectors = [
            '.font-select-grid',
            '#setting-font-size', '#setting-font-weight', '#setting-line-height',
            '#setting-margin', '#setting-max-width', '#setting-gap', '#setting-letter-spacing',
            '#setting-chinese-quotes', '#setting-writing-mode', '#setting-layout-mode'
        ]
        ineffectiveSelectors.forEach(sel => {
            panel.querySelectorAll(sel).forEach(el => {
                const row = el.closest('.control-row') || el.closest('.setting-section')
                if (row) {
                    row.classList.add('ll-fixed-disabled')
                    row.title = '固定版式图书（PDF/漫画）不支持调整流式排版'
                }
                if ('disabled' in el) el.disabled = true
            })
        })

        const note = document.createElement('div')
        note.setAttribute('data-ll-fixed-note', '')
        note.style.cssText = 'margin: 0 0 0.75rem; padding: 0.55rem 0.75rem; border-radius: 8px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); color: #b45309; font-size: 0.78rem; line-height: 1.5;'
        note.innerText = '当前为 PDF / 固定版式图书：字体与流式排版设置不适用（已置灰）。主题配色、手绘与缩放等选项仍然有效。'
        panel.insertBefore(note, panel.firstChild)
    }

    closeDrawer() {
        this.dom.sidebarDrawer?.classList.remove('open')
        this.dom.drawerBackdrop?.classList.remove('active')
        this.activeDrawer = false
        clearTimeout(this._drawerCloseTimer)
        this._drawerCloseTimer = setTimeout(() => {
            if (!this.activeDrawer && this.dom.sidebarDrawer) {
                this.dom.sidebarDrawer.style.display = 'none'
            }
        }, 450)
    }

    switchTab(tabName) {
        this.activeTab = tabName
        this.dom.tabButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName)
        })
        Object.keys(this.dom.tabPanels).forEach(key => {
            const panel = this.dom.tabPanels[key]
            if (!panel) return
            if (key === tabName) {
                panel.style.display = 'block'
                panel.classList.remove('drawer-panel-active')
                void panel.offsetWidth
                panel.classList.add('drawer-panel-active')
            } else {
                panel.style.display = 'none'
                panel.classList.remove('drawer-panel-active')
            }
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
        if (tabName === 'toc' && this.currentLocation?.tocItem?.href) {
            setTimeout(() => this.highlightActiveTOCItem(this.currentLocation.tocItem.href), 50)
        }
        if (tabName === 'search') {
            setTimeout(() => {
                this.dom.searchQueryInput?.focus()
                this.dom.searchQueryInput?.select()
            }, 80)
        }
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
                li.addEventListener('click', e => {
                    e.stopPropagation()
                    if (this.pdfViewport) {
                        const pageIdx = typeof item.page === 'number' ? item.page : (parseInt(item.href?.replace(/[^0-9]/g, ''), 10) - 1 || 0)
                        this.pdfViewport.goToPage(pageIdx)
                    } else {
                        this.foliateView?.goTo(item.href)
                    }
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
        if (!href || !this.dom.tocContainer) return
        const items = Array.from(this.dom.tocContainer.querySelectorAll('.toc-item'))
        if (items.length === 0) return

        // 1. Primary: Exact destination match (including fragment #anchor or JSON dest)
        let matched = items.find(el => (el.dataset.href || '') === href)

        // 2. Fallback: If no exact anchor matched, match the first item sharing the base file
        if (!matched) {
            const hrefBase = href.split('#')[0]
            if (hrefBase) {
                matched = items.find(el => (el.dataset.href || '').split('#')[0] === hrefBase)
            }
        }

        // 3. Mark ONLY the single matched item as active, remove active from all others
        items.forEach(el => {
            el.classList.toggle('active', el === matched)
        })

        if (matched) {
            matched.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
    }

    async loadNotesList() {
        if (!this.currentBookId) {
            if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'none'
            return
        }
        const activeSession = this._activeSession
        const snapshot = this._currentSnapshot
        const bookId = this.currentBookId
        const allNotes = await db.getHighlightsByBook(bookId)
        if (activeSession && !activeSession.isCurrent()) return
        const container = this.dom.notesContainer
        container.innerHTML = ''

        const notes = [...allNotes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

        if (notes.length === 0) {
            if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'none'
            container.innerHTML = `
                <div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem 1rem; text-align: center; line-height: 1.6;">
                    <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">✏️</div>
                    <div style="font-weight: 600; color: var(--text-main); margin-bottom: 0.3rem;">暂无划线与笔记</div>
                    <div style="font-size: 0.78rem;">在阅读正文中用鼠标拖选文字，在弹出的工具栏上点击颜色点或【U】即可快速划线、记录想法！</div>
                </div>
            `
            return
        }

        if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'inline-flex'

        notes.forEach(note => {
            const match = snapshot ? db.isContentIdentityMatching(note, snapshot) : { matches: true }
            const isUnconfirmed = !match.matches

            const card = document.createElement('div')
            card.className = 'highlight-card'
            card.style.borderLeftColor = note.color || '#facc15'
            if (isUnconfirmed) {
                card.style.opacity = '0.75'
            }

            const unconfirmedBadge = isUnconfirmed 
                ? `<span class="note-unconfirmed-badge" style="margin-left: 6px; font-size: 0.7rem; color: #d97706; background: rgba(245, 158, 11, 0.12); padding: 1px 5px; border-radius: 4px; font-weight: 500;">⚠️ 待确认版本</span>` 
                : ''

            card.innerHTML = `
                <div class="highlight-text">“${escapeHTML(note.text)}”</div>
                ${note.note ? `<div class="highlight-note">${escapeHTML(note.note)}</div>` : ''}
                <div class="highlight-meta">
                    <span>${escapeHTML(note.chapterTitle || '正文')} • ${new Date(note.createdAt).toLocaleDateString()}${unconfirmedBadge}</span>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn-note-share" style="color: var(--accent-purple); font-size: 0.75rem; font-weight: 600; background: none; border: none; cursor: pointer;">📷 分享卡片</button>
                        <button class="btn-note-del" style="color: #ef4444; font-size: 0.75rem; background: none; border: none; cursor: pointer;">删除</button>
                    </div>
                </div>
            `

            card.addEventListener('click', e => {
                if (e.target.classList.contains('btn-note-del') || e.target.classList.contains('btn-note-share')) return
                if (isUnconfirmed) {
                    this.showToast('该笔记关联的文档版本与当前文件不一致，无法准确定位', '⚠️')
                    return
                }
                if (this.pdfViewport && (note.formatType === 'pdf' || note.pdfTarget)) {
                    const target = note.pdfTarget || {}
                    const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                    const page = firstSegment?.page ?? target.page ?? 0
                    const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                    const firstRect = rects?.[0]
                    const yRatio = firstRect ? firstRect[1] : 0
                    this.pdfViewport.goToPage(page, yRatio)
                    this.pdfViewport.pulseHighlight(page, note.id, rects)
                    this.closeDrawer()
                } else if (note.cfi && this.foliateView) {
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
                if (activeSession && !activeSession.isCurrent()) return
                if (this.pdfViewport) {
                    const allHls = await db.getHighlightsByBook(bookId)
                    if (activeSession && !activeSession.isCurrent()) return
                    this.pdfViewport.setHighlights(allHls, snapshot)
                }
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
            const quoteText = (n.text || '').split('\n').map(l => `> ${l}`).join('\n')
            md += `${quoteText}\n\n`
            if (n.note) md += `**批注**：${n.note}\n\n`
            md += `*时间：${new Date(n.createdAt).toLocaleString()}*\n\n`
        })

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const safeTitle = (this.currentBookData.title || '电子书').replace(/[\\/:*?"<>|]/g, '_').trim()
        a.download = `${safeTitle}_读书笔记.md`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
    }

    async redrawAllAnnotations() {
        return this.reloadAnnotations()
    }

    async executeSearch() {
        const query = this.dom.searchQueryInput.value.trim()
        if (!query || (!this.foliateView && !this.pdfViewport)) return

        if (this._searchAbortController) {
            try { this._searchAbortController.abort() } catch (e) {}
        }
        this._searchAbortController = new AbortController()
        const signal = this._searchAbortController.signal

        this._searchToken = (this._searchToken || 0) + 1
        const currentToken = this._searchToken

        const container = this.dom.searchResultsContainer
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.5rem 0;">正在全书检索中...</div>'

        try {
            const matches = []
            let totalCount = 0
            let truncated = false

            if (this.pdfViewport && this.pdfDriver) {
                const totalPages = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 0
                const qLower = query.toLowerCase()
                for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
                    if (signal.aborted || this._searchToken !== currentToken) return
                    try {
                        const { spans = [] } = await this.pdfDriver.getTextLayer(pageIdx)
                        const pageSize = this.pdfViewport?.pageSizes?.[pageIdx] || { width: 595, height: 842 }
                        const fullText = spans.map(s => s.text).join(' ')
                        const fullTextLower = fullText.toLowerCase()
                        let searchPos = 0
                        const pageItems = []

                        let curOffset = 0
                        const spanOffsets = spans.map(s => {
                            const start = curOffset
                            const end = start + s.text.length
                            curOffset = end + 1 // space separator
                            return { span: s, start, end }
                        })

                        while (searchPos < fullTextLower.length) {
                            const foundIdx = fullTextLower.indexOf(qLower, searchPos)
                            if (foundIdx === -1) break

                            const matchEnd = foundIdx + query.length
                            const start = Math.max(0, foundIdx - 30)
                            const end = Math.min(fullText.length, matchEnd + 30)
                            const pre = (start > 0 ? '...' : '') + fullText.slice(start, foundIdx)
                            const match = fullText.slice(foundIdx, matchEnd)
                            const post = fullText.slice(matchEnd, end) + (end < fullText.length ? '...' : '')

                            const matchedRects = []
                            for (const { span: s, start: sStart, end: sEnd } of spanOffsets) {
                                if (sStart < matchEnd && sEnd > foundIdx) {
                                    const x1 = Math.max(0, Math.min(1, s.x / pageSize.width))
                                    const y1 = Math.max(0, Math.min(1, s.y / pageSize.height))
                                    const x2 = Math.max(0, Math.min(1, (s.x + s.w) / pageSize.width))
                                    const y2 = Math.max(0, Math.min(1, (s.y + s.h) / pageSize.height))
                                    matchedRects.push([x1, y1, x2, y2])
                                }
                            }

                            const yRatio = matchedRects[0] ? matchedRects[0][1] : 0
                            pageItems.push({
                                pageIndex: pageIdx,
                                excerpt: { pre, match, post },
                                rects: matchedRects,
                                yRatio
                            })
                            totalCount++
                            if (totalCount >= 100) {
                                truncated = true
                                break
                            }
                            searchPos = matchEnd
                        }

                        if (pageItems.length > 0) {
                            matches.push({
                                label: `第 ${pageIdx + 1} 页`,
                                items: pageItems
                            })
                        }
                        if (truncated) break
                    } catch (err) {
                        console.warn('PDF search page error:', pageIdx, err)
                    }
                }
            } else if (this.foliateView?.search) {
                const iter = this.foliateView.search({ query, signal })
                for await (const result of iter) {
                    if (signal.aborted || this._searchToken !== currentToken) return
                    if (result === 'done') break
                    if (result.subitems && result.subitems.length > 0) {
                        matches.push({
                            label: result.label || '当前章节',
                            items: result.subitems
                        })
                        totalCount += result.subitems.length
                        if (totalCount >= 100) {
                            truncated = true
                            break
                        }
                    }
                }
            } else {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem; padding: 0.8rem 0; text-align: center;">未加载可检索文档</div>'
                return
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
            summaryEl.innerText = truncated
                ? `匹配结果过多，仅显示前 ${totalCount} 处：`
                : `共检索到 ${totalCount} 处匹配结果：`
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
                        if (this.pdfViewport && typeof item.pageIndex === 'number') {
                            const idx = this.currentSearchMatches.findIndex(m => m === item)
                            if (idx !== -1) this.currentSearchMatchIndex = idx
                            this.pdfViewport.goToPage(item.pageIndex, item.yRatio || 0)
                            if (item.rects && item.rects.length) {
                                this.pdfViewport.pulseRects(item.pageIndex, item.rects)
                            }
                            this.updateSearchBarUI()
                            this.closeDrawer()
                        } else if (item.cfi && this.foliateView) {
                            const idx = this.currentSearchMatches.findIndex(m => m.cfi === item.cfi)
                            if (idx !== -1) this.currentSearchMatchIndex = idx
                            await this.foliateView.goTo(item.cfi)
                            this.foliateView.setActiveSearchMatch?.(item.cfi)
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
            if (flatMatches.length > 0) {
                if (this.foliateView && flatMatches[0].cfi) {
                    this.foliateView.setActiveSearchMatch?.(flatMatches[0].cfi)
                } else if (this.pdfViewport && typeof flatMatches[0].pageIndex === 'number') {
                    if (flatMatches[0].rects && flatMatches[0].rects.length) {
                        this.pdfViewport.pulseRects(flatMatches[0].pageIndex, flatMatches[0].rects)
                    }
                }
            }
            this.updateSearchBarUI()

        } catch (e) {
            console.error('Search error:', e)
            container.innerHTML = `<div style="color: #ef4444; font-size: 0.85rem;">搜索失败: ${escapeHTML(e.message)}</div>`
        }
    }

    clearSearchState(clearInput = false) {
        if (this._searchAbortController) {
            try { this._searchAbortController.abort() } catch (e) {}
            this._searchAbortController = null
        }
        this._searchToken = (this._searchToken || 0) + 1
        if (this.foliateView?.clearSearch) {
            this.foliateView.clearSearch()
        }
        if (this.pdfViewport) {
            this.pdfViewport._pendingPulse = null
            this.pdfViewport._pendingHighlightPulse = null
            if (this.pdfViewport.activeSlots) {
                for (const slot of this.pdfViewport.activeSlots.values()) {
                    slot.querySelectorAll('.pdf-search-pulse').forEach(el => el.remove())
                }
            }
        }
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
        if (this.dom.readerSearchBar) {
            this.dom.readerSearchBar.classList.remove('active')
            this.dom.readerSearchBar.style.display = 'none'
        }
        if (clearInput) {
            if (this.dom.searchQueryInput) this.dom.searchQueryInput.value = ''
            if (this.dom.btnClearSearchInput) this.dom.btnClearSearchInput.style.display = 'none'
            if (this.dom.searchResultsContainer) this.dom.searchResultsContainer.innerHTML = ''
        }
    }

    async navigateSearchMatch(direction) {
        if (this.currentSearchMatches.length === 0) return
        this.currentSearchMatchIndex = (this.currentSearchMatchIndex + direction + this.currentSearchMatches.length) % this.currentSearchMatches.length
        const target = this.currentSearchMatches[this.currentSearchMatchIndex]
        if (this.pdfViewport && typeof target?.pageIndex === 'number') {
            this.pdfViewport.goToPage(target.pageIndex, target.yRatio || 0)
            if (target.rects && target.rects.length) {
                this.pdfViewport.pulseRects(target.pageIndex, target.rects)
            }
            this.updateSearchBarUI()
        } else if (this.foliateView && target?.cfi) {
            await this.foliateView.goTo(target.cfi)
            this.foliateView.setActiveSearchMatch?.(target.cfi)
            this.updateSearchBarUI()
        }
    }

    updateSearchBarUI() {
        if (!this.dom.readerSearchBar || this.currentSearchMatches.length === 0) return
        this.dom.readerSearchBar.style.display = 'flex'
        this.dom.readerSearchBar.classList.add('active')
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


    // ==========================================
    // Reading Statistics Dashboard
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

            // 4.5. P3 Literary Comparison Insight
            if (this.dom.statsLiteraryText) {
                const totalSeconds = stats.viewTotalSeconds || 0
                const hours = totalSeconds / 3600
                if (hours >= 15) {
                    this.dom.statsLiteraryText.innerText = `您本周期沉浸阅读达 ${hours.toFixed(1)} 小时，所阅字数相当于完整通读了 1.5 本《流俗地》，墨香深沁。`
                } else if (hours >= 8) {
                    this.dom.statsLiteraryText.innerText = `您本周期沉浸阅读达 ${hours.toFixed(1)} 小时，字数相当于完整读完了 1 本《月亮与六便士》，文思充沛。`
                } else if (hours >= 2.5) {
                    this.dom.statsLiteraryText.innerText = `您已沉浸阅读 ${hours.toFixed(1)} 小时，相当于精读了半本《局外人》，字里行间静水流深。`
                } else if (hours > 0) {
                    this.dom.statsLiteraryText.innerText = `今日已翻开书页，阅读是随身携带的避难所，静享当下的安顿心流。`
                } else {
                    this.dom.statsLiteraryText.innerText = `本周期暂无阅读记录，挑选一本书开始阅读吧。`
                }
            }

            // 4.6. P2 Reading Goal Rings (Customizable Targets - Option C: Default hidden for pure, pressure-free reading)
            if (this.dom.statsGoalsRow) {
                this.dom.statsGoalsRow.style.display = this.settings.enableReadingGoals ? 'grid' : 'none'
            }

            if (this.settings.enableReadingGoals) {
                const finishedBooks = stats.periodFinishedCount != null ? stats.periodFinishedCount : (stats.finishedCount || 0)
                const yearTarget = this.settings.readingGoalYear || 12
                const yearPct = Math.min(100, Math.round((finishedBooks / yearTarget) * 100))
                if (this.dom.goalPctYear) this.dom.goalPctYear.innerText = `${yearPct}%`
                if (this.dom.goalSubYear) this.dom.goalSubYear.innerText = `已读 ${finishedBooks} / ${yearTarget} 本`
                if (this.dom.goalRingYear) {
                    const offset = Math.max(0, 201 * (1 - yearPct / 100))
                    this.dom.goalRingYear.style.strokeDashoffset = offset
                }

                const monthHours = (stats.viewTotalSeconds || 0) / 3600
                const monthTarget = this.settings.readingGoalMonth || 20
                const rawMonthPct = (monthHours / monthTarget) * 100
                const monthPct = Math.min(100, Math.round(rawMonthPct))
                if (this.dom.goalPctMonth) {
                    this.dom.goalPctMonth.innerText = (monthHours > 0 && monthPct === 0) ? '<1%' : `${monthPct}%`
                }
                if (this.dom.goalSubMonth) this.dom.goalSubMonth.innerText = `已读 ${monthHours.toFixed(1)} / ${monthTarget} 小时`
                if (this.dom.goalRingMonth) {
                    const effectivePct = Math.max(monthPct, monthHours > 0 ? 1 : 0)
                    const offset = Math.max(0, 201 * (1 - effectivePct / 100))
                    this.dom.goalRingMonth.style.strokeDashoffset = offset
                }

                const activeSecs = (tracker && tracker.isTracking) ? (tracker.sessionCumulativeSeconds || 0) : 0
                const todayMins = Math.round(((stats.todaySeconds || 0) + activeSecs) / 60)
                const todayTarget = this.settings.readingGoalToday || 45
                const rawTodayPct = (todayMins / todayTarget) * 100
                const todayPct = Math.min(100, Math.round(rawTodayPct))
                if (this.dom.goalPctToday) {
                    this.dom.goalPctToday.innerText = (todayMins > 0 && todayPct === 0) ? '<1%' : `${todayPct}%`
                }
                if (this.dom.goalSubToday) this.dom.goalSubToday.innerText = `已读 ${todayMins} / ${todayTarget} 分钟`
                if (this.dom.goalRingToday) {
                    const effectivePct = Math.max(todayPct, todayMins > 0 ? 1 : 0)
                    const offset = Math.max(0, 201 * (1 - effectivePct / 100))
                    this.dom.goalRingToday.style.strokeDashoffset = offset
                }
            }

            // 5. Render Distribution Bar Chart
            this.renderDistributionChart(stats)

            // 6. Books Leaderboard
            const leaderboardBooks = (stats.periodBooks && stats.periodBooks.length > 0) ? stats.periodBooks : stats.topBooks
            this.renderLeaderboard(leaderboardBooks)

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
                this.dom.statsPeakText.innerHTML = `<span style="font-weight: 700; margin-right: 4px; color: var(--accent-purple);">●</span> 峰值 · ${escapeHTML(stats.peakInfo.label)} · ${escapeHTML(stats.peakInfo.timeStr)}`
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

        const validBooks = (books || []).filter(b => {
            const secs = (b.periodReadingSeconds != null ? b.periodReadingSeconds : b.totalReadingSeconds) || 0
            const frac = b.progress?.fraction || 0
            return secs > 0 || frac > 0
        })

        if (validBooks.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 2.5rem 1rem;">
                    暂无阅读记录，挑选一本书开始阅读吧
                </div>
            `
            return
        }

        const maxDurationSecs = Math.max(1, ...validBooks.map(b => (b.periodReadingSeconds != null ? b.periodReadingSeconds : b.totalReadingSeconds) || 0))

        validBooks.forEach((book, idx) => {
            const item = document.createElement('div')
            item.className = 'leaderboard-item'
            item.dataset.id = book.id

            let rankClass = ''
            const rankNum = idx + 1
            const rankText = rankNum < 10 ? `0${rankNum}` : `${rankNum}`
            if (idx === 0) { rankClass = 'rank-1' }
            else if (idx === 1) { rankClass = 'rank-2' }
            else if (idx === 2) { rankClass = 'rank-3' }

            let coverUrl = ''
            if (book.coverBlob) {
                coverUrl = coverUrlPool.get(book.id, book.coverBlob)
            }

            const bookSecs = (book.periodReadingSeconds != null ? book.periodReadingSeconds : book.totalReadingSeconds) || 0
            const fraction = book.progress?.fraction || 0
            const rawPct = fraction * 100
            const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
            const timeStr = tracker.formatDuration(bookSecs)

            // Duration bar: relative to the top book's duration, with min 6% width so it is always visible if > 0
            const durationBarWidth = maxDurationSecs > 0 && bookSecs > 0
                ? Math.min(100, Math.max(6, Math.round((bookSecs / maxDurationSecs) * 100)))
                : 0

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
                        <div class="item-progress-fill" style="width: ${durationBarWidth}%;"></div>
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
                    const coverUrl = b.coverBlob ? coverUrlPool.get(b.id, b.coverBlob) : null

                    row.innerHTML = `
                        <div style="width: 44px; height: 60px; border-radius: 4px; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            ${coverUrl ? `<img src="${coverUrl}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 1.25rem;">📖</span>`}
                        </div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(b.title)}</div>
                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(b.author || '未知作者')} · ${escapeHTML((b.format || 'txt').toUpperCase())}</div>
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
                    const coverUrl = b.coverBlob ? coverUrlPool.get(b.id, b.coverBlob) : null

                    row.innerHTML = `
                        <div style="width: 44px; height: 60px; border-radius: 4px; overflow: hidden; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            ${coverUrl ? `<img src="${coverUrl}" style="width: 100%; height: 100%; object-fit: cover;" />` : `<span style="font-size: 1.25rem;">🏆</span>`}
                        </div>
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-size: 0.92rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(b.title)}</div>
                            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">${escapeHTML(b.author || '未知作者')} · ${escapeHTML((b.format || 'txt').toUpperCase())}</div>
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
                            <span>${(n.createdAt || n.updatedAt) ? new Date(n.createdAt || n.updatedAt).toLocaleDateString() : ''}</span>
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
        if (!this.currentBookId) return
        if (this.pdfViewport) {
            try {
                const highlights = await db.getHighlightsByBook(this.currentBookId)
                this.pdfViewport.setHighlights(highlights)
            } catch (e) {
                console.warn('Failed to reload PDF annotations:', e)
            }
            return
        }
        if (!this.foliateView) return
        try {
            const highlights = await db.getHighlightsByBook(this.currentBookId)
            const contents = this.foliateView.renderer?.getContents?.() || []
            for (const content of contents) {
                if (content.overlayer?.clear) {
                    content.overlayer.clear()
                } else if (content.overlayer?.element) {
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

        this.updateUserProfileDisplay()
        if (this.dom?.heroGreetingTitle && this.shelfCategory === 'all') {
            const greetingData = this.getDynamicGreeting()
            this.dom.heroGreetingTitle.innerText = greetingData.title
            this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
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
        btnTogglePwd?.addEventListener('click', async () => {
            const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
            if (!pwdInput) return
            const isPwd = pwdInput.type === 'password'
            if (isPwd) {
                // If value is empty but there is a saved password in backend, fetch decrypted password
                if (!pwdInput.value && this.syncConfig?.hasPassword && window.electronAPI?.syncRevealPassword) {
                    try {
                        const revealed = await window.electronAPI.syncRevealPassword()
                        if (revealed) {
                            pwdInput.value = revealed
                            if (this.syncConfig) this.syncConfig.password = revealed
                        }
                    } catch (e) {
                        console.warn('Failed to reveal sync password:', e)
                    }
                }
                pwdInput.type = 'text'
                btnTogglePwd.setAttribute('title', '隐藏密码')
                btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
            } else {
                pwdInput.type = 'password'
                btnTogglePwd.setAttribute('title', '显示密码')
                btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
            }
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
        const btnTogglePwd = this.dom.btnToggleSyncPwd || document.getElementById('btn-toggle-sync-pwd')
        if (pwdInput) {
            pwdInput.type = 'password'
            pwdInput.value = c.password || ''
            if (c.hasPassword && !c.password) {
                pwdInput.placeholder = '•••••••••••••••• (已保存密码)'
            } else {
                pwdInput.placeholder = '16 位第三方应用专用授权密码'
            }
        }
        if (btnTogglePwd) {
            btnTogglePwd.setAttribute('title', '显示密码')
            btnTogglePwd.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
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
            if (dot) dot.innerHTML = `<span class="sync-indicator-dot ${isOk ? 'online' : 'offline'}"></span>`
            if (title) {
                title.innerText = isOk ? '云同步正常' : '同步异常'
                title.style.color = isOk ? '#059669' : '#dc2626'
            }
            if (desc) desc.innerText = `上次同步: ${dateStr} ${timeStr} ${c.lastSyncSummary || ''}`
        } else {
            if (dot) dot.innerHTML = '<span class="sync-indicator-dot idle"></span>'
            if (title) {
                title.innerText = '尚未同步'
                title.style.color = 'var(--text-secondary)'
            }
            if (desc) desc.innerText = '点击「立即同步」开始备份与多端对齐'
        }
    }

    getSyncConfigFromUI() {
        const serverType = document.querySelector('.btn-sync-preset.active')?.dataset.preset || this.syncConfig?.serverType || 'jianguoyun'
        const serverInput = this.dom.syncInputServer || document.getElementById('sync-input-server')
        const userInput = this.dom.syncInputUsername || document.getElementById('sync-input-username')
        const pwdInput = this.dom.syncInputPassword || document.getElementById('sync-input-password')
        const dirInput = this.dom.syncInputDir || document.getElementById('sync-input-dir')
        return {
            enabled: this.syncConfig?.enabled || false,
            serverType,
            serverUrl: serverInput?.value.trim() || this.syncConfig?.serverUrl || 'https://dav.jianguoyun.com/dav/',
            username: userInput?.value.trim() || this.syncConfig?.username || '',
            password: pwdInput?.value || this.syncConfig?.password || '',
            hasPassword: this.syncConfig?.hasPassword || false,
            remoteDir: dirInput?.value.trim() || this.syncConfig?.remoteDir || 'LindenLeaf',
            autoSyncOnStartup: true,
            autoSyncOnBookClose: true,
            lastSyncTime: this.syncConfig?.lastSyncTime || null,
            lastSyncStatus: this.syncConfig?.lastSyncStatus || null,
            lastSyncSummary: this.syncConfig?.lastSyncSummary || null
        }
    }

    async saveSyncConfig(overrideConfig = null) {
        const baseCfg = this.getSyncConfigFromUI()
        const cfg = { ...baseCfg, ...(overrideConfig || {}) }
        if (window.electronAPI?.syncSaveConfig) {
            await window.electronAPI.syncSaveConfig(cfg)
            if (window.electronAPI.syncGetConfig) {
                const refreshed = await window.electronAPI.syncGetConfig()
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
        } else {
            this.syncConfig = { ...this.syncConfig, ...cfg }
        }
        this.updateUserProfileDisplay()
        if (this.dom?.heroGreetingTitle && this.shelfCategory === 'all') {
            const greetingData = this.getDynamicGreeting()
            this.dom.heroGreetingTitle.innerText = greetingData.title
            this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
        }
    }

    async testSyncConnection() {
        await this.saveSyncConfig()
        const config = this.syncConfig
        if (!config.username || (!config.password && !config.hasPassword)) {
            this.showToast('请先输入坚果云账号（邮箱）和应用授权密码', 'warning')
            return
        }

        const btnTest = this.dom.btnSyncTestConn || document.getElementById('btn-sync-test-conn')
        if (btnTest) {
            btnTest.disabled = true
            btnTest.innerHTML = '<svg class="syncing-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>正在测试...</span>'
        }

        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        const desc = this.dom.syncStatusDesc || document.getElementById('sync-status-desc')

        try {
            const res = window.electronAPI?.syncTestConnection
                ? await window.electronAPI.syncTestConnection(config)
                : { success: true, message: 'WebDAV 连接成功' }
            if (res.success) {
                if (dot) dot.innerHTML = '<span class="sync-indicator-dot online"></span>'
                if (title) {
                    title.innerText = '连接测试通过'
                    title.style.color = '#059669'
                }
                if (desc) desc.innerText = res.message || 'WebDAV 服务器认证通过，远程目录已就绪'
                this.showToast('✅ 坚果云连接测试成功！', 'cloud')
            } else {
                if (dot) dot.innerHTML = '<span class="sync-indicator-dot offline"></span>'
                if (title) {
                    title.innerText = '连接失败'
                    title.style.color = '#dc2626'
                }
                if (desc) desc.innerText = res.error || '无法连接到 WebDAV 服务器'
                this.showToast(res.error || '连接失败，请检查账号密码', 'error')
            }
        } catch (e) {
            if (dot) dot.innerHTML = '<span class="sync-indicator-dot offline"></span>'
            if (title) {
                title.innerText = '连接异常'
                title.style.color = '#dc2626'
            }
            if (desc) desc.innerText = e.message
            this.showToast(`连接异常: ${e.message}`, 'error')
        } finally {
            if (btnTest) {
                btnTest.disabled = false
                btnTest.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg><span>测试连接</span>'
            }
        }
    }

    async triggerManualSync() {
        await this.saveSyncConfig()
        const config = this.syncConfig
        if (!config.username || (!config.password && !config.hasPassword)) {
            this.showToast('请先输入坚果云账号与应用授权密码', 'warning')
            return
        }

        const btnTrigger = this.dom.btnSyncTriggerNow || document.getElementById('btn-sync-trigger-now')
        if (btnTrigger) {
            btnTrigger.disabled = true
            btnTrigger.innerHTML = '<svg class="syncing-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>正在同步...</span>'
        }
        const dot = this.dom.syncStatusDot || document.getElementById('sync-status-dot')
        const title = this.dom.syncStatusTitle || document.getElementById('sync-status-title')
        if (dot) dot.innerHTML = '<span class="sync-indicator-dot syncing"></span>'
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

            const syncTime = Date.now()
            this.syncConfig.lastSyncTime = syncTime
            this.syncConfig.lastSyncStatus = 'success'
            this.syncConfig.lastSyncSummary = summaryStr
            await this.saveSyncConfig({
                lastSyncTime: syncTime,
                lastSyncStatus: 'success',
                lastSyncSummary: summaryStr
            })
            this.renderSyncUI()

            this.showToast(`云同步成功！${summaryStr}`, 'cloud')
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()
            if (this.shelfCategory === 'stats') {
                await this.renderStatsDashboard()
            }

            if (this.currentBookId && res?.deletedBookIds && res.deletedBookIds.includes(this.currentBookId)) {
                this.showToast('当前阅读的书籍已在其他设备被删除，已安全退出阅读', 'warning')
                this.closeReader()
            }

            if (res?.pendingAutoDownloads && res.pendingAutoDownloads.length > 0) {
                this.processAutoDownloadQueue(res.pendingAutoDownloads)
            }
        } catch (err) {
            console.error('Manual sync error:', err)
            const syncTime = Date.now()
            this.syncConfig.lastSyncTime = syncTime
            this.syncConfig.lastSyncStatus = 'error'
            this.syncConfig.lastSyncSummary = err.message
            await this.saveSyncConfig({
                lastSyncTime: syncTime,
                lastSyncStatus: 'error',
                lastSyncSummary: err.message
            })
            this.renderSyncUI()
            this.showToast(`同步失败: ${err.message}`, 'error')
        } finally {
            if (btnTrigger) {
                btnTrigger.disabled = false
                btnTrigger.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block;vertical-align:middle;margin-right:6px;"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg><span>立即双向同步</span>'
            }
        }
    }

    async triggerSilentBackgroundSync() {
        if (!this.syncConfig?.enabled || !this.syncConfig?.username || (!this.syncConfig?.password && !this.syncConfig?.hasPassword)) return
        const now = Date.now()
        if (this._lastSilentSyncAttempt && (now - this._lastSilentSyncAttempt < 10000)) {
            return // Cooldown 10s
        }
        this._lastSilentSyncAttempt = now
        try {
            console.log('[CloudSync] Starting silent background sync with 35s timeout...')
            const syncPromise = syncEngine.executeSyncLifecycle(this.syncConfig)
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Silent background sync timeout (35s)')), 35000))
            const res = await Promise.race([syncPromise, timeoutPromise])
            const syncTime = Date.now()
            this.syncConfig.lastSyncTime = syncTime
            this.syncConfig.lastSyncStatus = 'success'
            await this.saveSyncConfig({
                lastSyncTime: syncTime,
                lastSyncStatus: 'success'
            })
            this.renderSyncUI()
            console.log('[CloudSync] Silent background sync completed successfully:', res?.stats)
            if (this.shelfCategory === 'stats') {
                this.renderStatsDashboard()
            }

            if (this.currentBookId && res?.deletedBookIds && res.deletedBookIds.includes(this.currentBookId)) {
                this.showToast('当前阅读的书籍已在其他设备被删除，已安全退出阅读', '⚠️')
                this.closeReader()
            }

            if (res?.pendingAutoDownloads && res.pendingAutoDownloads.length > 0) {
                this.processAutoDownloadQueue(res.pendingAutoDownloads)
            }
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
    async getBuildInfo() {
        if (this._buildInfo) return this._buildInfo
        try {
            const res = await fetch('./build-info.json')
            if (res.ok) {
                this._buildInfo = await res.json()
                return this._buildInfo
            }
        } catch {}
        return null
    }
}

export { UniversalReaderApp }

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

