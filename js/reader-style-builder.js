import { customFontManager } from './custom-font-manager.js'
import { themeCustomizer } from './theme-customizer.js'
import { t } from './i18n.js'

export const DEFAULT_DESKTOP_READER_SETTINGS = Object.freeze({
    theme: 'light',
    font: 'serif',
    fontSize: 18,
    fontWeight: 400,
    lineHeight: 1.6,
    letterSpacing: 0,
    margin: 48,
    maxWidth: 760,
    gap: 6,
    justify: true,
    hyphenate: true,
    writingMode: 'horizontal',
    columnCount: '2',
    layout: 'paginated',
    paperTexture: 'none',
    pageTurnMode: 'slide',
    preserveOriginalStyles: true,
    chineseQuotes: false,
    comicMode: false,
    firstParaIndent: true,
    paraMarginTop: 0.0,
    paraMarginBottom: 0.65,
    paraIndentSize: '2em',
})

export const DEFAULT_MOBILE_READER_SETTINGS = Object.freeze({
    ...DEFAULT_DESKTOP_READER_SETTINGS,
    margin: 20,
    columnCount: '1',
})

const clampNumber = (value, min, max, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}

/**
 * Resolve runtime viewport/platform capabilities safely in both browser and Node tests.
 */
export function detectReaderViewportEnv(env = {}) {
    const win = typeof window !== 'undefined' ? window : null
    const docEl = typeof document !== 'undefined' ? document.documentElement : null
    const viewportWidth = Number(env.viewportWidth) > 0
        ? Number(env.viewportWidth)
        : (win?.innerWidth || 1280)
    const viewportHeight = Number(env.viewportHeight) > 0
        ? Number(env.viewportHeight)
        : (win?.innerHeight || 800)
    const hasCoarsePointer = Boolean(
        win?.matchMedia?.('(pointer: coarse)')?.matches ||
        docEl?.classList?.contains('platform-android') ||
        docEl?.classList?.contains('is-mobile-ui')
    )
    const isAndroid = env.isAndroid !== undefined
        ? Boolean(env.isAndroid)
        : Boolean(docEl?.classList?.contains('platform-android'))
    const isMobile = env.isMobile !== undefined
        ? Boolean(env.isMobile)
        : Boolean(
            isAndroid ||
            docEl?.classList?.contains('is-mobile-ui') ||
            viewportWidth < 768 ||
            (hasCoarsePointer && Math.min(viewportWidth, viewportHeight) < 768)
        )
    const screenOrient = win?.screen?.orientation?.type || ''
    const isPortrait = env.isPortrait !== undefined
        ? Boolean(env.isPortrait)
        : (screenOrient.startsWith('portrait')
            ? true
            : screenOrient.startsWith('landscape')
                ? false
                : viewportHeight >= viewportWidth)
    // Keep narrow phones and portrait mobile in single column even when IME shrinks height.
    const isPhonePortrait = isMobile && (viewportWidth < 560 || (isPortrait && Math.min(viewportWidth, viewportHeight) < 768))
    return {
        isMobile,
        isAndroid,
        viewportWidth,
        viewportHeight,
        isPortrait,
        isPhonePortrait,
    }
}

/**
 * Canonical default readerSettings factory for desktop and mobile.
 */
export function getDefaultReaderSettings(env = {}) {
    const resolved = detectReaderViewportEnv(env)
    const base = resolved.isMobile
        ? DEFAULT_MOBILE_READER_SETTINGS
        : DEFAULT_DESKTOP_READER_SETTINGS
    return { ...base }
}

/**
 * Single source of truth for effective layout dimensions, column clamp, and UI values.
 */
export function resolveEffectiveReaderLayout(settings = {}, env = {}) {
    const resolvedEnv = detectReaderViewportEnv(env)
    const defaults = resolvedEnv.isMobile
        ? DEFAULT_MOBILE_READER_SETTINGS
        : DEFAULT_DESKTOP_READER_SETTINGS
    const bookFormat = String(env.bookFormat ?? settings?.bookFormat ?? '').toLowerCase()
    const isTxtBook = bookFormat === 'txt'
    const preserveOriginalStyles = isTxtBook ? false : Boolean(settings?.preserveOriginalStyles)
    const writingMode = settings?.writingMode || defaults.writingMode
    const isVertical = writingMode === 'vertical-rl'

    const fontSize = clampNumber(settings?.fontSize, 12, 48, defaults.fontSize)
    const margin = Math.round(clampNumber(settings?.margin, 0, 120, defaults.margin))
    const gapPercent = clampNumber(settings?.gap, 0, 20, defaults.gap)
    const maxInlineSize = Math.round(clampNumber(settings?.maxWidth, 360, 1400, defaults.maxWidth))

    const requestedColumns = String(settings?.columnCount || defaults.columnCount) === '2' ? '2' : '1'
    const twoColumnAllowed = !isVertical && !(resolvedEnv.isPhonePortrait || resolvedEnv.viewportWidth < 680)
    const columnCount = twoColumnAllowed ? requestedColumns : '1'

    // On mobile, `margin` drives real horizontal content margins (18-24 CSS px default window)
    // plus reserved vertical breathing room clear of status/progress chrome and safe-area insets.
    const marginInline = resolvedEnv.isMobile && !isVertical ? margin : null
    const marginTop = resolvedEnv.isMobile
        ? Math.max(12, Math.min(28, Math.round(margin * 0.85)))
        : margin
    const marginBottom = resolvedEnv.isMobile
        ? Math.max(24, Math.min(44, margin + 8))
        : margin
    const paginatorMargin = resolvedEnv.isMobile
        ? Math.max(marginTop, marginBottom)
        : margin

    return {
        env: resolvedEnv,
        isMobile: resolvedEnv.isMobile,
        isPhonePortrait: resolvedEnv.isPhonePortrait,
        isTxtBook,
        preserveOriginalStyles,
        writingMode,
        isVertical,
        fontSize,
        margin,
        marginInline,
        marginTop,
        marginBottom,
        paginatorMargin,
        gapPercent,
        maxInlineSize,
        requestedColumns,
        twoColumnAllowed,
        columnCount,
        layout: settings?.layout === 'scrolled' ? 'scrolled' : 'paginated',
    }
}

/**
 * Hydrate persisted reader settings with platform defaults while never clobbering
 * explicit user preferences (including numeric values that match desktop defaults).
 */
export function migrateLegacyReaderSettings(saved, env = {}) {
    const resolvedEnv = detectReaderViewportEnv(env)
    const defaults = getDefaultReaderSettings(resolvedEnv)
    if (!saved || typeof saved !== 'object') {
        return { settings: defaults, migrated: false }
    }
    const next = { ...defaults }
    for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined && value !== null) {
            next[key] = value
        }
    }
    return { settings: next, migrated: false }
}

export const formatFontWeight = w => {
    const num = parseInt(w, 10) || 400
    if (num <= 300) return t('fontWeight.light')
    if (num === 400) return t('fontWeight.regular')
    if (num === 500) return t('fontWeight.medium')
    if (num === 600) return t('fontWeight.semibold')
    if (num === 700) return t('fontWeight.bold')
    return t('fontWeight.black')
}

export const buildContentCSS = (settings) => {
    const {
        theme, font, fontSize, fontWeight = 400, letterSpacing = 0, lineHeight, justify, hyphenate, writingMode = 'horizontal',
        firstParaIndent = true,
        paraMarginTop = 0.0,
        paraMarginBottom = 0.65,
        paraIndentSize = '2em'
    } = settings || {}
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
        /* Decorative chapter title boxes (e.g. Shibusawa .k, .k1, .k2, .k3, .k4, .k5) */
        .k, .k1, .k2, .k3, .k4, .k5 {
            page-break-inside: avoid !important;
            break-inside: avoid !important;
            -webkit-column-break-inside: avoid !important;
            box-sizing: border-box !important;
        }
        .k2, .k4, .k5 {
            padding-top: clamp(1em, 6vh, 2.5em) !important;
            padding-bottom: clamp(1em, 6vh, 2.5em) !important;
        }
        /* Decorative chapter title card: .k > .k1 > .k2 (e.g. Shibusawa part0004.html) */
        html:has(body > .k:only-child) body,
        body:has(> .k:only-child) {
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            min-height: 100% !important;
            height: 100% !important;
            box-sizing: border-box !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
        }
        .k:has(> .k1 > .k2),
        body > .k:only-child {
            display: block !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
            -webkit-column-break-inside: avoid !important;
            background-color: #231815 !important;
            padding: 0.5em !important;
            margin: auto auto !important;
            box-sizing: border-box !important;
            width: 100% !important;
            max-width: 540px !important;
        }
        .k:has(> .k1 > .k2) > .k1,
        body > .k:only-child > .k1 {
            background-color: #231815 !important;
            color: #fff !important;
            border: 3px solid #fff !important;
            padding: 0.5em !important;
            margin: 0 !important;
            box-sizing: border-box !important;
        }
        .k:has(> .k1 > .k2) > .k1 > .k2,
        body > .k:only-child > .k1 > .k2 {
            background-color: #231815 !important;
            color: #fff !important;
            border: 1px solid #fff !important;
            padding: clamp(2.2em, 5vh, 4.2em) 1.5em !important;
            margin: 0 !important;
            box-sizing: border-box !important;
        }
        .k:has(> .k1 > .k2) .center {
            margin-top: 0.8em !important;
            margin-bottom: 0.8em !important;
            line-height: 1.3 !important;
        }
        .k:has(> .k1 > .k2) .center1 {
            margin-top: 0.6em !important;
            margin-bottom: 0.6em !important;
        }
        .k:has(> .k1 > .k2) img {
            display: inline-block !important;
            max-width: 70% !important;
            height: auto !important;
            max-height: 3.2em !important;
        }
    `

    // Declarative Theme & Font Configuration Presets
    const THEME_PALETTES = {
        light: { text: '#1a1815', link: '#da7756', bg: '#FAF9F5', selection: 'rgba(218, 119, 86,  0.22)' },
        sepia: { text: '#3b2e1e', link: '#b45309', bg: '#f5eedc', selection: 'rgba(217, 119, 6, 0.26)' },
        dark:  { text: '#edece6', link: '#d97757', bg: '#1f1f1d', selection: 'rgba(217, 119, 87, 0.28)' },
        black: { text: '#cccccc', link: '#a1a1aa', bg: '#000000', selection: 'rgba(96, 165, 250, 0.36)' },
        green: { text: '#1b4d1d', link: '#2e7d32', bg: '#e8f5e9', selection: 'rgba(16, 185, 129, 0.25)' },
        eink:  { text: '#000000', link: '#000000', bg: '#ffffff', selection: 'rgba(0, 0, 0, 0.18)' },
        warm:  { text: '#292524', link: '#da7756', bg: '#FAF9F5', selection: 'rgba(218, 119, 86,  0.22)' }
    }

    const FONT_PRESETS = {
        serif: '"Lora", "Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif CJK SC", "思源宋体", "Songti SC", "SimSun-ExtB", "STSong", "SimSun", serif',
        sans:  '"Plus Jakarta Sans", "Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "思源黑体", "Microsoft YaHei", "微软雅黑", "PingFang SC", "SimHei", sans-serif',
        kaiti: '"LXGW WenKai Screen", "LXGW WenKai", "霞鹜文楷", "STKaiti", "Kaiti SC", "KaiTi", "楷体", serif',
        mono:  '"Cascadia Code", "Fira Code", Consolas, Menlo, Monaco, "Courier New", monospace'
    }

    const isDark = (theme === 'dark' || theme === 'black' || (themeCustomizer?.isCustomActive && themeCustomizer?.isDarkPalette))
    const colorScheme = isDark ? 'dark' : 'light'

    const activeTheme = themeCustomizer.isCustomActive
        ? {
            text: themeCustomizer.currentPalette.readerText || '#1a1815',
            link: themeCustomizer.currentPalette.accent || '#da7756',
            bg: themeCustomizer.currentPalette.readerBg || (isDark ? '#000000' : '#FAF9F5'),
            selection: themeCustomizer.currentPalette.selectionBg || 'rgba(217, 119, 6, 0.22)'
          }
        : (THEME_PALETTES[theme] || THEME_PALETTES.light)
    const textColor = activeTheme.text
    const linkColor = activeTheme.link
    const bgColor = activeTheme.bg
    const selectionBg = activeTheme.selection

    let fontFamily = FONT_PRESETS[font]
    if (!fontFamily) {
        const customFont = customFontManager.getFontMeta(font)
        if (customFont) {
            fontFamily = `"${customFont.familyName}", ${FONT_PRESETS.serif}`
        } else {
            fontFamily = FONT_PRESETS.serif
        }
    }
    // Publisher mode leaves the book's font faces, paragraph geometry, emphasis,
    // ornaments and writing direction intact. The paginator still owns pagination
    // and full-page media scaling.
    if (settings?.preserveOriginalStyles) return `
        @namespace epub "http://www.idpf.org/2007/ops";
        html {
            font-size: ${Number(fontSize) || 18}px;
            -webkit-text-size-adjust: 100%;
            text-size-adjust: 100%;
        }
        html, body { background-color: ${bgColor} !important; color: ${textColor}; color-scheme: ${colorScheme}; }
        ::selection { background: ${selectionBg} !important; color: inherit !important; }
        ${isDark ? `
        body, body :is(p, div, span, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, figcaption, td, th, caption) {
            color: ${textColor} !important;
        }
        body [data-reader-paper-background] { background-color: transparent !important; }
        a:link, a:visited { color: ${linkColor} !important; }
        ` : ''}
    `
    const customFontFaceCSS = customFontManager.getCachedCSS()
    const safeFontSize = Number(fontSize) || 18

    return `
        @namespace epub "http://www.idpf.org/2007/ops";
        ${customFontFaceCSS}
        ${verticalStyles}
        html {
            -webkit-text-size-adjust: 100%;
            text-size-adjust: 100%;
            font-size: ${safeFontSize}px !important;
        }
        html, body {
            color-scheme: ${colorScheme} !important;
            background-color: ${bgColor} !important;
            color: ${textColor} !important;
            font-family: ${fontFamily};
            letter-spacing: ${letterSpacing}px;
            font-feature-settings: "palt" 1, "kern" 1;
            text-spacing-trim: space-first;
            text-autospace: normal;
            font-synthesis: weight style;
            -webkit-font-smoothing: antialiased;
        }
        body :is(p, div, span, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, em, strong, i, b, a, section, article, figcaption, td, th, caption):not(code):not(pre):not(kbd):not(samp):not(math):not(math *):not(svg):not(svg *):not([class*="icon" i]):not([class*="math" i]):not([style*="font-family" i]) {
            font-family: ${fontFamily};
            letter-spacing: ${letterSpacing}px;
            font-feature-settings: "palt" 1, "kern" 1;
        }
        body, p, li, blockquote, dd, dt, section, article {
            font-family: ${fontFamily} !important;
            letter-spacing: ${letterSpacing}px !important;
        }
        pre, code, kbd, samp {
            font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace !important;
            font-feature-settings: normal !important;
        }
        em, i, cite, dfn, var {
            font-style: italic;
        }
        sup, sub {
            line-height: 0;
        }
        body, p, div, li, blockquote, dd, dt, section, article {
            font-weight: ${safeWeight};
        }
        h1, h2, h3, h4, h5, h6, strong, b {
            font-weight: ${headingWeight} !important;
        }
        body {
            color: ${textColor} !important;
            background-color: ${bgColor} !important;
            font-size: ${safeFontSize}px !important;
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            text-spacing-trim: space-first;
            text-autospace: normal;
        }
        p, li, blockquote, dd, div:not([data-reader-image-page] *) {
            line-height: ${lineHeight} !important;
            text-align: ${justify ? 'justify' : 'start'};
            -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
            hyphens: ${hyphenate ? 'auto' : 'manual'};
        }
        p {
            text-indent: ${paraIndentSize || '2em'};
            margin-top: ${paraMarginTop != null ? paraMarginTop : 0}em !important;
            margin-bottom: ${paraMarginBottom != null ? paraMarginBottom : 0.65}em !important;
            orphans: 2 !important;
            widows: 2 !important;
        }
        ${firstParaIndent === false ? `
        [data-first-para="true"],
        h1 + p, h2 + p, h3 + p,
        [data-chapter-heading="true"] + p {
            text-indent: 0 !important;
        }
        ` : ''}
        [data-poetry-line], .poetry, .verse {
            white-space: pre-wrap !important;
            text-indent: 0 !important;
        }
        .txt-content, [data-format="txt"] {
            white-space: pre-wrap !important;
            word-break: break-word !important;
            overflow-wrap: break-word !important;
        }
        li, dd {
            margin-top: 0.4em;
            margin-bottom: 0.4em;
        }

        /* Elements that must NEVER have 2em text-indent (Center, Right, Headings, Verse/Short Lines, Captions) */
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

        /* 3. In-document Subsections & Section Titles (Generous 3.2em respiratory margin & avoid orphan headings) */
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
        :is(h1, h2, h3, [data-reader-heading]) + :is(
            p[data-align="center"],
            p.subtitle, p.author, p.center,
            [class*="subtitle" i], [class*="author" i],
            .contenttitle1, [class*="subheading" i]
        ) {
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

        ${isDark ? `
        /* Comprehensive dark mode text color enforcement against publisher styles */
        body, p, div, span, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, em, strong, i, b, section, article, aside, table, thead, tbody, tfoot, tr, th, td, caption {
            color: ${textColor} !important;
        }
        font[color] {
            color: ${textColor} !important;
            filter: none !important;
        }
        [style*="color:#0" i], [style*="color: #0" i],
        [style*="color:#1" i], [style*="color: #1" i],
        [style*="color:#2" i], [style*="color: #2" i],
        [style*="color:#3" i], [style*="color: #3" i],
        [style*="color:black" i], [style*="color: black" i],
        [style*="color:rgb(0" i], [style*="color: rgb(0" i],
        [style*="color:rgb(1" i], [style*="color: rgb(1" i],
        [style*="color:rgb(2" i], [style*="color: rgb(2" i],
        [style*="color:rgb(3" i], [style*="color: rgb(3" i] {
            color: ${textColor} !important;
        }
        /* Preserve links and references */
        a:link, a:visited, a[href] {
            color: ${linkColor} !important;
        }
        /* Text-bearing publisher paper surfaces are marked once when the chapter loads.
           Restrict this override to dark themes so original light-theme artwork can return. */
        html body [data-reader-paper-background] {
            background-color: transparent !important;
        }
        /* Neutralize publisher hardcoded light backgrounds */
        [style*="background:white" i], [style*="background: white" i],
        [style*="background:#fff" i], [style*="background: #fff" i],
        [style*="background-color:white" i], [style*="background-color: white" i],
        [style*="background-color:#fff" i], [style*="background-color: #fff" i],
        [style*="background-color: rgb(255, 255, 255)" i],
        [style*="background-color:rgb(255,255,255)" i],
        [style*="background-color: #f" i], [style*="background:#f" i],
        .bg-white, [class*="bg-white" i],
        .note, .footnote, .callout, .sidebar, .box, [class*="note" i], [class*="footnote" i] {
            background-color: transparent !important;
            background: transparent !important;
        }
        table, thead, tbody, tfoot, tr, th, td, caption {
            background-color: transparent !important;
        }
        pre, code, kbd, samp {
            color: inherit !important;
            background-color: rgba(255, 255, 255, 0.08) !important;
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

        /* Comic Mode & Standalone Manga Illustration Column Separation Rules */
        .comic-mode img:not(figcaption img):not(figure:has(figcaption) img),
        .comic-mode svg:not(figcaption svg):not(figure:has(figcaption) svg),
        .comic-mode svg:not(figure:has(figcaption) svg) image,
        .comic-mode svg:not(figure:has(figcaption) svg):has(image),
        .comic-mode figure:not(:has(figcaption)):has(img),
        .comic-mode figure:not(:has(figcaption)):has(svg),
        .comic-mode .comic-container,
        img.comic-img,
        [data-comic-image="true"]${settings?.comicMode ? `,
        img:not(figcaption img):not(figure:has(figcaption) img):not(.epub-footnote img):not(.duokan-footnote img),
        svg:not(figcaption svg):not(figure:has(figcaption) svg),
        svg:not(figure:has(figcaption) svg) image,
        svg:not(figure:has(figcaption) svg):has(image),
        figure:not(:has(figcaption)):has(img),
        figure:not(:has(figcaption)):has(svg)` : ''} {
            break-before: column !important;
            break-after: column !important;
            break-inside: avoid !important;
            page-break-before: always !important;
            page-break-after: always !important;
            page-break-inside: avoid !important;
            width: 100% !important;
            max-width: 100% !important;
            height: 100vh !important;
            max-height: 100vh !important;
            object-fit: contain !important;
            margin: 0 auto !important;
            display: block !important;
            box-sizing: border-box !important;
        }

        .comic-mode p,
        .comic-mode div:has(> img),
        .comic-mode div:has(> svg),
        .comic-container,
        p:has(> img.comic-img),
        div:has(> img.comic-img),
        div:has(> [data-comic-image="true"])${settings?.comicMode ? `,
        p:has(> img),
        p:has(> svg),
        div:has(> img),
        div:has(> svg)` : ''} {
            margin: 0 !important;
            padding: 0 !important;
            text-indent: 0 !important;
            break-inside: avoid !important;
            display: block !important;
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

        /* Footnote references styling (unselectable so drag selection ignores footnote markers) */
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
            color: var(--accent-primary, #da7756) !important;
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