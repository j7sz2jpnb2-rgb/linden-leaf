import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { PageTurnController, PdfPageTurnAdapter, FoliatePageTurnAdapter } from '../js/page-turn-controller.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

console.log('=== Verifying Comprehensive Mobile Audit & Aesthetic Polish Fixes ===')

const readUtf8 = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
const mainCss = readUtf8('css/main.css')
const mobileShellCss = readUtf8('css/mobile-shell.css')
const mobilePrefsCss = readUtf8('css/mobile-preferences.css')
const appJs = readUtf8('js/app.js')
const mobileShellJs = readUtf8('js/mobile-shell.js')
const bookDetailsJs = readUtf8('js/book-details.js')
const paginatorJs = readUtf8('foliate-js-main/paginator.js')
const distPaginatorJs = readUtf8('dist-tauri/foliate-js-main/paginator.js')

// 1. Reading Stats Chart Y-axis grid alignment, flex-start horizontal scroll, and centered tooltips
assert.ok(
    mainCss.includes('left: 2.5rem;') && mainCss.includes('top: calc(0.5rem + 34px);'),
    'main.css .stats-grid-lines must align with 2.5rem left gutter and 120px bar track height'
)
assert.ok(
    mainCss.includes('.stats-chart-wrapper .stats-distribution-chart {\n  justify-content: flex-start;\n  padding-top: 26px;\n  box-sizing: content-box;\n}'),
    'main.css must left-align scrollable bar columns and reserve 26px top padding for tooltips'
)
assert.ok(
    mainCss.includes('transform: translateX(-50%) translateY(-2px);'),
    'main.css must preserve horizontal translateX(-50%) centering on active/hovered chart tooltips'
)
console.log('✓ [1/7] Reading Stats chart Y-axis gutter, 31-day horizontal scroll start, and tooltip unclipped centering verified')

// 2. Mobile Subviews (Reading Stats & AI History) sticky header, single scroll container, and bottom tab exit
assert.ok(
    /\.mobile-subview-active\s+\.jane-content-workspace\s*\{\s*padding-top:\s*0\s*!important;/.test(mobileShellCss),
    'mobile-shell.css must eliminate double top padding on .jane-content-workspace in mobile subviews'
)
assert.ok(
    mobileShellCss.includes('#mobile-subview-header {') && mobileShellJs.includes('ensureSubviewHeader('),
    'mobile-shell.js and mobile-shell.css must provide a sticky subview back header for Reading Stats & AI History'
)
assert.ok(
    mobileShellJs.includes("if (document.body.classList.contains('mobile-subview-active')) {") &&
    !mobileShellJs.includes("if (targetTab !== 'shelf' && targetTab !== 'search')"),
    'mobile-shell.js switchTab must always exit mobile-subview-active when tapping any bottom tab including Bookshelf'
)
assert.ok(
    appJs.includes("window.mobileShell.shelfFilter = 'finished'") &&
    appJs.includes("window.mobileShell.switchTab?.('shelf')"),
    'app.js openStatsDetailModal(finished_books) must route to mobile Bookshelf finished filter on mobile viewports'
)
console.log('✓ [2/7] Mobile Subviews sticky header, single scroll container, and bottom tab navigation verified')

// 3. Mobile Settings & Me Tab Typography + Control Row Layout (Screenshots 151, 152, 153)
assert.ok(
    mobilePrefsCss.includes('font: 600 32px/1.25 var(--mobile-font-editorial);') &&
    mobilePrefsCss.includes('html.is-mobile-viewport .mobile-group-title { margin: 0 0 8px 16px; font: 13px/1.5 var(--mobile-font-editorial);'),
    'mobile-preferences.css must use harmonized editorial typography across Me tab headers, profile name, stats numbers, and group titles'
)
assert.ok(
    mobilePrefsCss.includes('flex-wrap: nowrap;') &&
    mobilePrefsCss.includes('#mobile-settings-page .control-row > div:first-child { min-width: 0; flex: 1 1 auto; }') &&
    mobilePrefsCss.includes('#mobile-settings-page .control-row > input[type="number"] { flex: 0 0 88px; width: 88px !important; min-width: 72px; text-align: center; }') &&
    mobilePrefsCss.includes('#mobile-settings-page #setting-user-name { text-align: left !important; }'),
    'mobile-preferences.css must keep toggle switches and number inputs on a single row and left-align stacked nickname input'
)
assert.ok(
    mobilePrefsCss.includes('html.is-mobile-viewport #modal-book-details .book-details-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));') &&
    mobilePrefsCss.includes('html.is-mobile-viewport #modal-book-details #btn-details-read { grid-column: 1 / -1; }'),
    'mobile-preferences.css must span primary CTA full-width and arrange 3 secondary actions in a 3-column row in Book Details'
)
console.log('✓ [3/7] Mobile Preferences & Book Details layout and typography verified')

// 4. Note Input Modal vs Floating Reader Popups on Android (Screenshot 162) & Desktop Modal Centering
assert.ok(
    appJs.includes('this.hideSelectionPopup?.(true)') &&
    appJs.includes("if (this.dom.globalModalBackdrop?.classList.contains('show')) return"),
    'app.js must dismiss floating reader popups when opening showInputDialog and block selection popup re-entry while modal is open'
)
assert.ok(
    mobileShellCss.includes('html:not(.is-mobile-viewport) #global-modal-backdrop {\n    align-items: center !important;'),
    'mobile-shell.css must keep desktop global modals vertically centered while keeping mobile modals top-aligned above soft keyboard'
)
console.log('✓ [4/7] Note Input Modal popup suppression and desktop/mobile modal alignment verified')

// 5. Custom Cover Upload Cache Invalidation
assert.ok(
    appJs.includes('this.blobMeta = new Map()') &&
    bookDetailsJs.includes('window.coverUrlPool?.revoke?.(bookId)'),
    'ObjectUrlPool and BookDetailsModal must invalidate cached cover object URLs when a book cover is updated'
)
console.log('✓ [5/7] Custom cover upload cache invalidation verified')

// 6. PDF & EPUB Page Turn Adapters (activeSlots lookup, chapter-boundary curl, cover peel snapshot)
const mockSlotCanvas = { id: 'slot_canvas_p0', width: 600, height: 800 }
const mockPdfViewportWithSlots = {
    currentPage: 0,
    pageOffsets: [0, 800],
    activeSlots: new Map([
        [0, {
            querySelector: (sel) => sel.includes('.pdf-page-canvas') ? mockSlotCanvas : null
        }]
    ])
}
const pdfAdapter = new PdfPageTurnAdapter(mockPdfViewportWithSlots)
const pdfVisuals = pdfAdapter.getVisuals('next')
assert.equal(pdfVisuals.currentCanvas, mockSlotCanvas, 'PdfPageTurnAdapter must resolve canvas from activeSlots when renderedCanvases is absent')

// Verify chapter-boundary curl where currentCanvas is non-null and nextCanvas is null
let curlRendered = false
const boundaryAdapter = {
    canTurnPrev: () => true,
    canTurnNext: () => true,
    turnPrev: async () => {},
    turnNext: async () => {},
    isBusy: () => false,
    isContinuousScroll: () => false,
    getViewElement: () => ({ style: {} }),
    getVisuals: () => ({
        currentCanvas: mockSlotCanvas,
        nextCanvas: null,
        bgColor: '#FAF9F5',
        textColor: '#141413'
    })
}
const ctrl = new PageTurnController({
    container: { clientWidth: 400, clientHeight: 700, style: {}, appendChild: () => {} },
    adapter: boundaryAdapter,
    mode: 'curl'
})
ctrl._curlCanvas = { width: 400, height: 700, style: {} }
ctrl._curlSimulator = {
    renderCurl: (opts) => {
        if (opts.currentTexture === mockSlotCanvas && opts.nextTexture === null) {
            curlRendered = true
        }
    }
}
ctrl.handleTouchStart({ touches: [{ clientX: 350, clientY: 350 }] })
ctrl.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 220, clientY: 352 }]
})
assert.ok(curlRendered, 'Curl mode must render 3D curl during drag even at chapter boundaries where nextCanvas is null')
console.log('✓ [6/7] PDF activeSlots texture lookup and chapter-boundary 3D curl verified')

// 7. Paginator touch delegation to PageTurnController
assert.ok(
    paginatorJs.includes('#getCustomTouchController()') &&
    distPaginatorJs.includes('#getCustomTouchController()'),
    'Both foliate-js-main/paginator.js and dist-tauri/foliate-js-main/paginator.js must delegate touch events to PageTurnController in curl/cover/none modes'
)
console.log('✓ [7/7] EPUB paginator touch delegation verified across source and dist-tauri')

console.log('\nALL MOBILE AUDIT & AESTHETIC POLISH VERIFICATIONS PASSED!')
