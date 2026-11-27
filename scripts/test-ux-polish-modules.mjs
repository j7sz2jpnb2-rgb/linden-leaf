import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    transformChineseQuotes,
    isPredominantlyCjkDocument,
    applyChineseQuotesToDocument,
} from '../js/chinese-quotes.js'
import {
    parseColorToRgb,
    computePulseDeepenedColor,
    HIGHLIGHT_LOCATE_PULSE_DURATION_MS,
    HIGHLIGHT_LOCATE_PULSE_CLEANUP_MS,
    HIGHLIGHT_LOCATE_PULSE_CSS,
} from '../js/highlight-pulse.js'
import {
    READER_TOOLBAR_ITEMS,
    READER_TOOLBAR_PRESETS,
    getDefaultReaderToolbarVisibility,
    normalizeReaderToolbarVisibility,
    resolveReaderToolbarLayout,
} from '../js/reader-toolbar-config.js'
import { resolveExcerptSource } from '../js/excerpt-source-resolver.js'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ============================================================================
// 1. Live Reversible Chinese Corner Quotes (chinese-quotes.js)
// ============================================================================

test('transformChineseQuotes converts CJK curly quotes while preserving English apostrophes', () => {
    assert.equal(transformChineseQuotes('他说：“这是‘诗’。”'), '他说：「这是『诗』。」')
    assert.equal(transformChineseQuotes("It’s students’ book, “你好”."), 'It’s students’ book, 「你好」.')
    assert.equal(transformChineseQuotes('纯文本无引号'), '纯文本无引号')
})

test('applyChineseQuotesToDocument toggles ON and OFF reversibly without mutating code blocks', () => {
    const createMockNode = (value, tagName = 'P') => {
        const parentElement = { tagName, parentElement: null }
        return { nodeValue: value, parentElement }
    }

    const p1 = createMockNode('她轻声说：“第一章的结尾就写到这里。”', 'P')
    const p2 = createMockNode('注释里写着‘示例’二字。', 'P')
    const codeNode = createMockNode('const s = “keep_in_code”;', 'CODE')
    const allNodes = [p1, p2, codeNode]

    const mockDoc = {
        body: {
            textContent: allNodes.map(n => n.nodeValue).join('\n'),
        },
        createTreeWalker() {
            let idx = 0
            return {
                nextNode() {
                    return idx < allNodes.length ? allNodes[idx++] : null
                },
            }
        },
    }

    assert.equal(isPredominantlyCjkDocument(mockDoc, 'zh-CN'), true)
    assert.equal(isPredominantlyCjkDocument(mockDoc, 'en-US'), false)

    // Turn ON live
    const onRes = applyChineseQuotesToDocument(mockDoc, true, { bookLang: 'zh' })
    assert.equal(onRes.skipped, false)
    assert.equal(onRes.changedCount, 2)
    assert.equal(p1.nodeValue, '她轻声说：「第一章的结尾就写到这里。」')
    assert.equal(p2.nodeValue, '注释里写着『示例』二字。')
    assert.equal(codeNode.nodeValue, 'const s = “keep_in_code”;')

    // Idempotent second ON call
    const onAgain = applyChineseQuotesToDocument(mockDoc, true, { bookLang: 'zh' })
    assert.equal(onAgain.changedCount, 0)

    // Turn OFF live -> exact original restoration
    const offRes = applyChineseQuotesToDocument(mockDoc, false, { bookLang: 'zh' })
    assert.equal(offRes.changedCount, 2)
    assert.equal(p1.nodeValue, '她轻声说：“第一章的结尾就写到这里。”')
    assert.equal(p2.nodeValue, '注释里写着‘示例’二字。')
})

// ============================================================================
// 2. 2-Round Deepened Original-Hue Highlight Locate Pulse (highlight-pulse.js)
// ============================================================================

test('parseColorToRgb parses hex and rgb(a) formats and falls back safely', () => {
    assert.deepEqual(parseColorToRgb('#facc15'), { r: 250, g: 204, b: 21 })
    assert.deepEqual(parseColorToRgb('#0af'), { r: 0, g: 170, b: 255 })
    assert.deepEqual(parseColorToRgb('rgba(96, 165, 250, 0.35)'), { r: 96, g: 165, b: 250 })
    assert.deepEqual(parseColorToRgb('invalid'), { r: 250, g: 204, b: 21 })
})

test('computePulseDeepenedColor deepens each highlight along its own hue without muddy brown', () => {
    const yellow = computePulseDeepenedColor('#facc15', false)
    const blue = computePulseDeepenedColor('#60a5fa', false)
    const green = computePulseDeepenedColor('#4ade80', false)
    const pink = computePulseDeepenedColor('#f472b6', false)

    // Must preserve dominant channel of original hue
    const yRgb = parseColorToRgb(yellow.solidHex)
    assert.ok(yRgb.r > 180 && yRgb.g > 130 && yRgb.b < 60, `yellow deepened should stay golden, got ${yellow.solidHex}`)

    const bRgb = parseColorToRgb(blue.solidHex)
    assert.ok(bRgb.b > bRgb.r + 80, `blue deepened should stay clearly blue, got ${blue.solidHex}`)

    const gRgb = parseColorToRgb(green.solidHex)
    assert.ok(gRgb.g > gRgb.r + 50 && gRgb.g > gRgb.b + 40, `green deepened should stay clearly green, got ${green.solidHex}`)

    const pRgb = parseColorToRgb(pink.solidHex)
    assert.ok(pRgb.r > pRgb.g + 60 && pRgb.b > pRgb.g + 20, `pink deepened should stay rose/pink, got ${pink.solidHex}`)

    // Dark theme should remain bright enough to read cleanly on dark background
    const darkBlue = computePulseDeepenedColor('#60a5fa', true)
    assert.match(darkBlue.fill, /^rgba\(/)
    assert.ok(darkBlue.opacity > 0.4)
})

test('HIGHLIGHT_LOCATE_PULSE_CSS defines an exact 2-round hold-fade-hold-fade animation', () => {
    assert.equal(HIGHLIGHT_LOCATE_PULSE_DURATION_MS, 2200)
    assert.ok(HIGHLIGHT_LOCATE_PULSE_CLEANUP_MS > HIGHLIGHT_LOCATE_PULSE_DURATION_MS)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /@keyframes llHighlightLocatePulse/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /animation:\s*llHighlightLocatePulse 2200ms ease-in-out 1 forwards/)
    // Verify 2 opacity: 1 plateaus (Round 1: 8%..32%, Round 2: 60%..84%) and 0% / 44%-52% / 100% fade valleys
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /8%\s*\{\s*opacity:\s*1;\s*\}/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /32%\s*\{\s*opacity:\s*1;\s*\}/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /44%\s*\{\s*opacity:\s*0;\s*\}/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /60%\s*\{\s*opacity:\s*1;\s*\}/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /84%\s*\{\s*opacity:\s*1;\s*\}/)
    assert.match(HIGHLIGHT_LOCATE_PULSE_CSS, /100%\s*\{\s*opacity:\s*0;\s*\}/)
})

// ============================================================================
// 3. Customizable Reader Topbar Registry (reader-toolbar-config.js)
// ============================================================================

test('resolveReaderToolbarLayout routes hidden applicable items into overflow menu and filters by format', () => {
    const defaults = getDefaultReaderToolbarVisibility()
    assert.equal(Object.keys(defaults).length, READER_TOOLBAR_ITEMS.length)
    assert.equal(defaults.aiSidebar, true)

    const norm = normalizeReaderToolbarVisibility({
        aiSidebar: false,
        tts: false,
        ocrPage: false,
        chapterTranslate: false,
        unknownKey: false,
    })
    assert.equal(norm.aiSidebar, false)
    assert.equal(norm.unknownKey, undefined)

    // In EPUB desktop mode: ocrPage is PDF-only so should NOT appear in EPUB overflow menu,
    // whereas aiSidebar, tts, and chapterTranslate SHOULD appear in overflow.
    const epubLayout = resolveReaderToolbarLayout(norm, { isPdf: false, isDesktop: true })
    assert.ok(epubLayout.overflowKeys.includes('aiSidebar'))
    assert.ok(epubLayout.overflowKeys.includes('tts'))
    assert.ok(epubLayout.overflowKeys.includes('chapterTranslate'))
    assert.ok(!epubLayout.overflowKeys.includes('ocrPage'))
    assert.ok(epubLayout.hiddenIds.has('btn-toggle-ai-sidebar'))

    // In PDF desktop mode: ocrPage appears in overflow, chapterTranslate (EPUB-only) does NOT.
    const pdfLayout = resolveReaderToolbarLayout(norm, { isPdf: true, isDesktop: true })
    assert.ok(pdfLayout.overflowKeys.includes('ocrPage'))
    assert.ok(!pdfLayout.overflowKeys.includes('chapterTranslate'))

    // Presets exist cleanly and only reference valid READER_TOOLBAR_ITEMS keys
    assert.ok(READER_TOOLBAR_PRESETS.full && READER_TOOLBAR_PRESETS.study && READER_TOOLBAR_PRESETS.minimal)
    const validKeys = new Set(READER_TOOLBAR_ITEMS.map(item => item.key))
    for (const preset of Object.values(READER_TOOLBAR_PRESETS)) {
        for (const k of Object.keys(preset.visibility)) {
            assert.ok(validKeys.has(k), `Preset "${preset.key}" references valid toolbar key "${k}"`)
        }
    }
})

// ============================================================================
// 4. Excerpt Chapter Attribution (excerpt-source-resolver.js)
// ============================================================================

test('resolveExcerptSource attributes end of Section A correctly even when Section B starts on the same blob: page', () => {
    // Minimal ordered DOM simulation with compareDocumentPosition (4 = FOLLOWING, 2 = PRECEDING)
    const nodesInOrder = []
    const makeEl = (tagName, { id = '', textContent = '' } = {}) => {
        const el = {
            nodeType: 1,
            tagName,
            id,
            textContent,
            parentElement: null,
            ownerDocument: null,
            classList: { contains: () => false },
            getAttribute: () => null,
            closest: () => null,
            contains(other) {
                return other === this
            },
            compareDocumentPosition(other) {
                const a = nodesInOrder.indexOf(this)
                const b = nodesInOrder.indexOf(other)
                if (a < b) return 4 // other follows this
                if (a > b) return 2 // other precedes this
                return 0
            },
        }
        nodesInOrder.push(el)
        return el
    }

    const hSectionA = makeEl('H2', { id: 'sec-alpha', textContent: '第一章 序曲' })
    const pSectionALastLine = makeEl('P', { textContent: '这是第一章的最后一段示例正文。' })
    const hSectionB = makeEl('H2', { id: 'sec-beta', textContent: '第二章 尾声（合集）' })
    const pSectionBFirstLine = makeEl('P', { textContent: '一、开篇句。' })

    const mockDoc = {
        URL: 'blob:http://localhost/550e8400-e29b-41d4-a716-446655440000',
        defaultView: { location: { href: 'blob:http://localhost/550e8400-e29b-41d4-a716-446655440000' } },
        getElementById(id) {
            return nodesInOrder.find(n => n.id === id) || null
        },
        querySelector() {
            return null
        },
        querySelectorAll(sel) {
            if (sel.includes('h2')) return [hSectionA, hSectionB]
            return []
        },
    }
    nodesInOrder.forEach(n => { n.ownerDocument = mockDoc })

    const toc = [
        { label: '第一章 序曲', href: 'OEBPS/Text/sections.xhtml#sec-alpha' },
        { label: '第二章 尾声（合集）', href: 'OEBPS/Text/sections.xhtml#sec-beta' },
    ]

    // Current reader screen already reports Section B because Section B started lower on the same page,
    // yet the user's selection is on Section A's final paragraph.
    const resultA = resolveExcerptSource(
        {
            format: 'epub',
            range: { startContainer: pSectionALastLine },
            sectionHref: 'OEBPS/Text/sections.xhtml',
            currentLocation: {
                href: 'OEBPS/Text/sections.xhtml#sec-beta',
                tocItem: toc[1],
            },
        },
        toc
    )
    assert.equal(resultA.chapterTitle, '第一章 序曲')

    // And selecting inside Section B resolves to Section B.
    const resultB = resolveExcerptSource(
        {
            format: 'epub',
            range: { startContainer: pSectionBFirstLine },
            sectionHref: 'OEBPS/Text/sections.xhtml',
            currentLocation: {
                href: 'OEBPS/Text/sections.xhtml#sec-beta',
                tocItem: toc[1],
            },
        },
        toc
    )
    assert.equal(resultB.chapterTitle, '第二章 尾声（合集）')
})

test('resolveExcerptSource uses PDF selection Y coordinate when a new chapter starts mid-page', () => {
    const pdfToc = [
        { label: '第一章 序曲', page: 10 },
        { label: '第二章 尾声（合集）', page: 12 },
    ]

    // Selection near top of page 13 (0-based page 12, yRatio = 0.14) belongs to previous section
    const topRes = resolveExcerptSource(
        {
            format: 'pdf',
            page: 13,
            pdfTarget: { page: 13, rects: [[0.1, 0.14, 0.8, 0.04]] },
        },
        pdfToc
    )
    assert.equal(topRes.chapterTitle, '第一章 序曲')

    // Selection in lower half of page 13 (yRatio = 0.62) belongs to the new section starting on page 13
    const bottomRes = resolveExcerptSource(
        {
            format: 'pdf',
            page: 13,
            pdfTarget: { page: 13, rects: [[0.1, 0.62, 0.8, 0.04]] },
        },
        pdfToc
    )
    assert.equal(bottomRes.chapterTitle, '第二章 尾声（合集）')
})

// ============================================================================
// 5. Cross-OS Window Compatibility & PC / Android Isolation Contracts
// ============================================================================

test('window_set_titlebar_theme supports Win10/11/macOS/Linux and stays no-op on mobile', () => {
    const windowRs = fs.readFileSync(path.join(ROOT_DIR, 'src-tauri/src/commands/window.rs'), 'utf8')
    assert.match(windowRs, /window\.set_theme\(Some\(target_theme\)\)/)
    assert.match(windowRs, /DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1:\s*u32\s*=\s*19/)
    assert.match(windowRs, /DWMWA_USE_IMMERSIVE_DARK_MODE:\s*u32\s*=\s*20/)
    assert.match(windowRs, /DWMWA_CAPTION_COLOR:\s*u32\s*=\s*35/)
    assert.match(windowRs, /DWMWA_TEXT_COLOR:\s*u32\s*=\s*36/)
    assert.match(windowRs, /#\[cfg\(not\(desktop\)\)\]/)
})

test('PC-only settings stay strictly isolated from Android MobileSettings and mobile styles stay scoped', () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8')
    assert.match(html, /class="control-row settings-row-pair desktop-only">\s*<span class="control-label" data-i18n="settings\.directShelfLanding"/)
    assert.match(html, /class="control-row settings-row-pair desktop-only">\s*<span class="control-label" data-i18n="settings\.readerTopBarAutoHide"/)
    assert.match(html, /class="reader-toolbar-custom-block desktop-only"/)

    const mainCss = fs.readFileSync(path.join(ROOT_DIR, 'css/main.css'), 'utf8')
    assert.match(mainCss, /@media \(hover: hover\) and \(pointer: fine\)/)
    assert.match(mainCss, /html:not\(\.is-mobile-viewport\) #reader-view\.reader-topbar-autohide #reader-top-bar/)

    const mobileCss = fs.readFileSync(path.join(ROOT_DIR, 'css/mobile-shell.css'), 'utf8')
    assert.match(mobileCss, /html\.is-mobile-viewport \.reader-note-composer-card/)

    const mobileJs = fs.readFileSync(path.join(ROOT_DIR, 'js/mobile-shell.js'), 'utf8')
    assert.match(mobileJs, /highlightColor,\s*isHighlightJump:\s*true/)
    assert.match(mobileJs, /app\.foliateView\.pulseHighlight\?\.\(highlight\.cfi/)
    assert.match(mobileJs, /app\.pdfViewport\.pulseHighlight\?\.\(page, highlight\.id, rects, highlightColor\)/)
})

function makeMockElement(tagName, id = '') {
    const children = []
    const attrs = new Map()
    const listeners = new Map()
    const classes = new Set()
    const el = {
        tagName: String(tagName || 'div').toUpperCase(),
        id,
        children,
        parentNode: null,
        hidden: false,
        disabled: false,
        value: '',
        scrollTop: 0,
        scrollHeight: 90,
        style: {},
        className: '',
        dataset: {},
        isConnected: true,
        classList: {
            add: (...xs) => xs.forEach((x) => classes.add(x)),
            remove: (...xs) => xs.forEach((x) => classes.delete(x)),
            toggle: (x, force) => {
                if (force === undefined) {
                    if (classes.has(x)) { classes.delete(x); return false }
                    classes.add(x); return true
                }
                if (force) classes.add(x); else classes.delete(x)
                return Boolean(force)
            },
            contains: (x) => classes.has(x),
        },
        setAttribute: (k, v) => attrs.set(k, String(v)),
        getAttribute: (k) => attrs.get(k) ?? null,
        removeAttribute: (k) => attrs.delete(k),
        addEventListener: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, new Set())
            listeners.get(ev).add(fn)
        },
        removeEventListener: (ev, fn) => listeners.get(ev)?.delete(fn),
        dispatchEvent: (ev) => {
            for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev)
        },
        append: (...nodes) => {
            for (const n of nodes) {
                if (!n || typeof n === 'string') continue
                n.parentNode = el
                children.push(n)
            }
        },
        appendChild: (n) => {
            if (n) { n.parentNode = el; children.push(n) }
            return n
        },
        prepend: (n) => {
            if (n) { n.parentNode = el; children.unshift(n) }
        },
        replaceChildren: (...nodes) => {
            children.length = 0
            for (const n of nodes) {
                if (n) { n.parentNode = el; children.push(n) }
            }
        },
        remove: () => {
            if (!el.parentNode) return
            const idx = el.parentNode.children.indexOf(el)
            if (idx >= 0) el.parentNode.children.splice(idx, 1)
            el.parentNode = null
        },
        querySelector: (sel) => {
            const byId = sel.startsWith('#') ? sel.slice(1).split(/\s+/)[0] : null
            const byClass = sel.startsWith('.') ? sel.slice(1).split(/\s+/)[0] : null
            const byTag = (!byId && !byClass) ? sel.trim().toUpperCase() : null
            for (const ch of children) {
                if (byId && ch.id === byId) return ch
                if (byClass && String(ch.className || '').split(/\s+/).includes(byClass)) return ch
                if (byTag && ch.tagName === byTag) return ch
                const nested = ch.querySelector?.(sel)
                if (nested) return nested
            }
            return null
        },
        querySelectorAll: () => [],
        closest: () => null,
        focus: () => {},
        setSelectionRange: () => {},
        set innerHTML(val) {
            children.length = 0
            el._html = val
            if (String(val).includes('inline-composer-textarea')) {
                const ta = makeMockElement('textarea')
                ta.className = 'note-composer-textarea inline-composer-textarea'
                const saveBtn = makeMockElement('button')
                saveBtn.className = 'btn-primary-action inline-composer-save'
                const cancelBtn = makeMockElement('button')
                cancelBtn.className = 'btn-secondary-action inline-composer-cancel'
                el.append(ta, saveBtn, cancelBtn)
            }
        },
        get innerHTML() { return el._html || '' },
    }
    return el
}

test('PdfViewport.pulseHighlight emits valid hex/rgba CSS strings instead of [object Object]', async () => {
    const prevDoc = globalThis.document
    const prevWin = globalThis.window
    const prevRaf = globalThis.requestAnimationFrame
    globalThis.HTMLElement ??= class {}
    globalThis.customElements ??= { get() {}, define() {} }
    globalThis.requestAnimationFrame = (fn) => { fn(); return 1 }
    globalThis.window = { ...(prevWin || {}), setTimeout, clearTimeout }
    globalThis.document = {
        documentElement: { getAttribute: () => 'light' },
        createElement: (tag) => makeMockElement(tag),
        createElementNS: (_ns, tag) => makeMockElement(tag),
    }

    try {
        const { PdfViewport } = await import('../js/pdf-viewport.js')
        const pageDiv = makeMockElement('div')
        const mockViewport = {
            pageSizes: { 1: { width: 600, height: 800, x0: 0, y0: 0 } },
            highlights: [
                { id: 'hl-quad', color: '#60a5fa', pdfTarget: { page: 1, quads: [[10, 10, 100, 10, 10, 30, 100, 30]] } },
                { id: 'hl-rect', color: '#4ade80' },
            ],
            pageContainers: new Map([[1, pageDiv]]),
            activeSlots: new Map([[1, pageDiv]]),
            _locatePulseEls: [],
            _locatePulseTimer: null,
            clearLocatePulse() {
                if (this._locatePulseTimer) {
                    clearTimeout(this._locatePulseTimer)
                    this._locatePulseTimer = null
                }
                for (const el of this._locatePulseEls || []) el.remove?.()
                this._locatePulseEls = []
            },
        }

        try {
            PdfViewport.prototype.pulseHighlight.call(mockViewport, 1, 'hl-quad', null, '#60a5fa')
            const quadLayer = pageDiv.children.at(-1)
            const poly = quadLayer.querySelector('polygon')
            const fill = poly.getAttribute('fill')
            const fillOpacity = poly.getAttribute('fill-opacity')
            assert.match(fill, /^#[0-9a-f]{6}$/i)
            assert.ok(!fill.includes('[object'), `Unexpected polygon fill: ${fill}`)
            assert.ok(Number(fillOpacity) > 0 && Number(fillOpacity) <= 1)

            PdfViewport.prototype.pulseHighlight.call(mockViewport, 1, 'hl-rect', [[0.1, 0.2, 0.5, 0.05]], '#4ade80')
            const rectLayer = pageDiv.children.at(-1)
            const rectItem = rectLayer.querySelector('.pdf-locate-pulse-item')
            assert.match(rectItem.style.backgroundColor, /^rgba\(/)
            assert.ok(!rectItem.style.backgroundColor.includes('[object'))
        } finally {
            mockViewport.clearLocatePulse()
        }
    } finally {
        globalThis.document = prevDoc
        globalThis.window = prevWin
        globalThis.requestAnimationFrame = prevRaf
    }
})

test('NoteComposer isolates sidebar inline composer from notes list clear, keeps draft on error, and closes on Escape', async () => {
    const prevDoc = globalThis.document
    const prevWin = globalThis.window
    const prevRaf = globalThis.requestAnimationFrame

    const docListeners = new Map()
    const panelNotes = makeMockElement('div', 'panel-notes')
    panelNotes.classList.add('active')
    const composerHost = makeMockElement('div', 'sidebar-inline-note-composer-host')
    const notesList = makeMockElement('div', 'notes-list-container')
    panelNotes.append(composerHost, notesList)
    const ids = new Map([
        ['panel-notes', panelNotes],
        ['sidebar-inline-note-composer-host', composerHost],
        ['notes-list-container', notesList],
    ])
    const body = makeMockElement('body')

    globalThis.requestAnimationFrame = (fn) => { fn(); return 1 }
    globalThis.window = { innerWidth: 1280, innerHeight: 800, mobileShell: null }
    globalThis.document = {
        body,
        createElement: (tag) => makeMockElement(tag),
        getElementById: (id) => ids.get(id) || panelNotes.querySelector(`#${id}`),
        querySelector: (sel) => {
            if (sel === '#sidebar-inline-note-composer .inline-composer-textarea') {
                return composerHost.querySelector('#sidebar-inline-note-composer')?.querySelector('.inline-composer-textarea') || null
            }
            if (sel === '#sidebar-inline-note-composer .inline-composer-save') {
                return composerHost.querySelector('#sidebar-inline-note-composer')?.querySelector('.inline-composer-save') || null
            }
            if (sel === '#sidebar-inline-note-composer .inline-composer-cancel') {
                return composerHost.querySelector('#sidebar-inline-note-composer')?.querySelector('.inline-composer-cancel') || null
            }
            return null
        },
        addEventListener: (ev, fn) => {
            if (!docListeners.has(ev)) docListeners.set(ev, new Set())
            docListeners.get(ev).add(fn)
        },
        removeEventListener: (ev, fn) => docListeners.get(ev)?.delete(fn),
    }

    try {
        const { NoteComposer } = await import('../js/note-composer.js')
        const toasts = []
        let cancelled = 0
        const app = {
            dialogs: { showToast: (msg, type) => toasts.push({ msg, type }) },
            annotations: {
                openDrawer: () => {},
                closeDrawer: () => {},
                dom: { notesContainer: notesList, sidebarDrawer: { classList: { contains: () => true } } },
            },
        }
        const composer = new NoteComposer(app)
        composer.open({
            preferSidebar: true,
            initialNote: 'Draft idea',
            onSave: async () => { throw new Error('disk full') },
            onCancel: () => { cancelled++ },
        })

        // Simulating loadNotesList() wiping notesContainer must NOT remove the sidebar composer
        notesList.innerHTML = ''
        assert.ok(composerHost.querySelector('#sidebar-inline-note-composer'))

        // Failed save must preserve draft and keep composer open
        await composer._commit()
        assert.equal(composer.isOpen, true)
        assert.equal(toasts.length, 1)
        const ta = globalThis.document.querySelector('#sidebar-inline-note-composer .inline-composer-textarea')
        assert.equal(ta.value, 'Draft idea')

        // Escape cancels active sidebar composer
        for (const fn of [...(docListeners.get('keydown') || [])]) {
            fn({ key: 'Escape', defaultPrevented: false, preventDefault() {} })
        }
        assert.equal(composer.isOpen, false)
        assert.equal(cancelled, 1)
    } finally {
        globalThis.document = prevDoc
        globalThis.window = prevWin
        globalThis.requestAnimationFrame = prevRaf
    }
})

test('ReaderAppearanceController updates reader toolbar customization cleanly across EPUB to PDF transition and Wires Archived UI', async () => {
    const prevDoc = globalThis.document
    const prevWin = globalThis.window
    const readerView = makeMockElement('div', 'reader-view')
    const overflowWrap = makeMockElement('div', 'reader-toolbar-overflow-wrap')
    const ids = new Map([
        ['reader-view', readerView],
        ['reader-toolbar-overflow-wrap', overflowWrap],
    ])
    for (const item of READER_TOOLBAR_ITEMS) {
        for (const id of item.ids) {
            ids.set(id, makeMockElement('button', id))
        }
    }

    globalThis.HTMLElement ??= class {}
    globalThis.customElements ??= { get() {}, define() {} }
    globalThis.window = { innerWidth: 1280, platformBridge: null }
    globalThis.document = {
        documentElement: makeMockElement('html'),
        getElementById: (id) => ids.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
    }

    try {
        const { ReaderAppearanceController } = await import('../js/reader-appearance-controller.js')
        const mockApp = {
            dom: { readerView },
            currentBookData: { format: 'epub' },
            currentBookFormat: 'epub',
            pdfViewport: null,
            settings: {
                readerToolbarVisibility: {
                    pinWindow: false,
                    refPage: false,
                    chapterTranslate: false,
                },
            },
            mobile: { isMobileViewport: () => false },
        }
        const ctrl = new ReaderAppearanceController(mockApp)
        ctrl.dom = { readerToolbarOverflowMenu: null, btnReaderToolbarOverflow: null }

        // EPUB session: pdf-only refPage not in overflow, epub chapterTranslate & pinWindow are hidden
        ctrl.applyReaderToolbarCustomization()
        assert.equal(ids.get('btn-pin-ref-page').classList.contains('ll-toolbar-hidden'), true)
        assert.equal(ids.get('btn-chapter-translate').classList.contains('ll-toolbar-hidden'), true)
        assert.equal(overflowWrap.hidden, false)

        // Transition to PDF mode via class (even before pdfViewport finishes constructing)
        readerView.classList.add('is-pdf-mode')
        mockApp.currentBookData = { format: 'pdf' }
        mockApp.currentBookFormat = 'pdf'
        ctrl.applyReaderToolbarCustomization()
        assert.equal(ctrl._getToolbarContext().isPdf, true)
        assert.equal(ids.get('btn-pin-ref-page').classList.contains('ll-toolbar-hidden'), true)
        assert.equal(overflowWrap.hidden, false)
    } finally {
        globalThis.document = prevDoc
        globalThis.window = prevWin
    }

    const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8')
    assert.match(html, /data-category="archived"[^>]*id="nav-cat-archived"/)
    const detailsJs = fs.readFileSync(path.join(ROOT_DIR, 'js/book-details.js'), 'utf8')
    assert.match(detailsJs, /id="btn-details-toggle-archive"/)
    assert.match(detailsJs, /id="btn-details-remove-local-file"/)
    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'js/app.js'), 'utf8')
    assert.match(appJs, /onToggleArchive:/)
    assert.match(appJs, /onRemoveLocalFile:/)
    assert.match(appJs, /applyReaderToolbarCustomization\?\.\(\)/)
})
