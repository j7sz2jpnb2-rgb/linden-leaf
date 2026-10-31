import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { PdfViewport } from '../js/pdf-viewport.js'

globalThis.window = { innerWidth: 390, getSelection: () => null }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }

function viewport() {
    const view = Object.create(PdfViewport.prototype)
    Object.assign(view, {
        container: { clientWidth: 390, clientHeight: 720 },
        scrollArea: { clientWidth: 390, clientHeight: 720, scrollLeft: 0, scrollTop: 0,
            getBoundingClientRect: () => ({ left: 10, top: 54 }) },
        spacer: { style: {} },
        scale: 1, zoomMode: null, currentPage: 0, numPages: 5,
        pageSizes: [595, 842, 595, 595, 595].map((width, i) => ({ width, height: i === 1 ? 595 : 842 })),
        activeSlots: new Map(), options: { minScale: .1, maxScale: 3.5 },
        _syncActiveSlotGeometry() {}, _renderVisibleSlots() {}, _redrawNativePreview() {},
        _cancelNativeDrag() {}, _slotForPoint() { return null },
    })
    view._recomputeLayout()
    return view
}

const fit = viewport()
fit.setZoom('fit-width')
const pageLeft = (fit._layoutWidth - fit.pageOffsets[0].width) / 2 - fit.scrollArea.scrollLeft
assert.equal(pageLeft, 12, 'A later landscape page must not push the portrait page off screen')
assert.equal(fit.canPanHorizontally(), false)
fit.setZoom(.8)
assert.equal(fit.ownsTouchGesture(), true, 'An overflowing page below absolute scale 1.05 belongs to PDF panning')
fit.goToPage(1)
fit.setZoom('fit-page')
assert.ok(fit.pageOffsets[1].width <= 366 && fit.pageOffsets[1].height <= 688, 'Fit-page must fit both dimensions')
fit.goToPage(2)
assert.ok(fit.pageOffsets[2].width <= 366 && fit.pageOffsets[2].height <= 688)
const shortDocument = viewport()
shortDocument.pageSizes = [{ width: 360, height: 540 }, { width: 600, height: 400 }]
shortDocument.numPages = 2
let realScrollTop = 0
Object.defineProperty(shortDocument.scrollArea, 'scrollTop', {
    get: () => realScrollTop,
    set: value => { realScrollTop = Math.min(Math.max(0, value), Math.max(0, shortDocument.totalHeight - shortDocument.scrollArea.clientHeight)) }
})
shortDocument.setZoom('fit-page')
shortDocument.goToPage(1)
shortDocument._detectCurrentPage()
assert.equal(shortDocument.currentPage, 1, 'A short landscape final page must not jump back to the portrait page after a real clamped scroll')
assert.ok(shortDocument.scrollArea.scrollTop >= shortDocument.pageOffsets[1].top - 8)
console.log('PASS: mixed page sizes, fit-page, short final-page jump and horizontal gesture ownership')

const pinch = viewport()
pinch.currentPage = 2
pinch.scrollArea.scrollTop = pinch.pageOffsets[2].top + 100
pinch.scrollArea.scrollLeft = 80
const event = touches => ({ touches, cancelable: true, preventDefault() {} })
pinch._handleTouchStart(event([{ clientX: 110, clientY: 204 }, { clientX: 210, clientY: 204 }]))
const anchor = { ...pinch._pinch }
pinch._handleTouchMove(event([{ clientX: 90, clientY: 224 }, { clientX: 290, clientY: 224 }]))
assert.equal(pinch.spacer.style.transformOrigin, `${anchor.originX}px ${anchor.originY}px`)
assert.equal(pinch.spacer.style.transform, 'translate(30px, 20px) scale(2)')
await pinch._handleTouchEnd(event([]))
const p = pinch.pageOffsets[2]
const anchoredX = (pinch._layoutWidth - p.width) / 2 + anchor.normX * p.width - pinch.scrollArea.scrollLeft
const anchoredY = p.top + anchor.normY * p.height - pinch.scrollArea.scrollTop
assert.ok(Math.abs(anchoredX - 180) < 1 && Math.abs(anchoredY - 170) < 1, 'Preview and committed zoom must keep the same point under the fingers')
assert.equal(pinch.shouldIgnoreContentClick(), true)
console.log('PASS: scrolled pinch preview, translated center and committed page anchor')

const tap = viewport()
tap.setZoom('fit-width')
const baseline = tap.scale
tap._handleDoubleTapToggle(160, 220)
assert.ok(Math.abs(tap.scale - baseline * 2) < 1e-6, 'Double tap should zoom relative to fit width')
tap._handleDoubleTapToggle(160, 220)
assert.equal(tap.zoomMode, 'fit-width')
let taps = 0
tap.options.onTap = () => taps++
const single = { clientX: 160, clientY: 220 }
tap._handleTouchStart(event([single]))
await tap._handleTouchEnd({ ...event([]), changedTouches: [single] })
tap._handleTouchCancel()
await new Promise(resolve => setTimeout(resolve, 340))
assert.equal(taps, 0, 'Cancelled touches must not open controls later')
console.log('PASS: relative double-tap zoom and cancelled tap cleanup')

// Exercise the real shell event handlers without launching an app or opening a user database.
const context = vm.createContext({ console, setTimeout, clearTimeout })
const source = await fs.readFile(new URL('../js/mobile-shell.js', import.meta.url), 'utf8')
const module = new vm.SourceTextModule(source, { context })
await module.link(specifier => {
    const names = specifier.endsWith('tts-player.js') ? ['ttsPlayer'] :
        specifier.endsWith('platformBridge.js') ? ['platformBridge'] :
        specifier.endsWith('advanced-settings.js') ? ['advancedSettings'] :
        specifier.endsWith('mobile-settings.js') ? ['MobileSettings'] :
        specifier.endsWith('tags-manager.js') ? ['resolveReadingState', 'setReadingStatus', 'updateBookTags'] : []
    return new vm.SyntheticModule(names, function() {
        for (const name of names) this.setExport(name, name === 'resolveReadingState' ? () => 'reading' : name === 'MobileSettings' ? class { close() {} } : {})
    }, { context })
})
await module.evaluate()
const elements = new Map()
function element(id) {
    const events = new Map()
    const node = { id, hidden: false, style: {}, value: '', dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {}, addEventListener(name, callback) { events.set(name, callback) },
        focus() {}, blur() {}, select() {}, fire(name) { events.get(name)?.({ preventDefault() {} }) } }
    elements.set(id, node)
    return node
}
for (const id of ['mobile-pdf-page-slider', 'btn-mobile-pdf-page', 'mobile-pdf-page-badge', 'mobile-pdf-reset-zoom',
    'mobile-pdf-display-controls', 'mobile-pdf-progress', 'btn-mobile-reader-ai', 'btn-mobile-pdf-more', 'btn-tool-pdf-search',
    'mobile-pdf-page-form', 'mobile-pdf-page-input', 'mobile-pdf-page-range', 'mobile-pdf-page-sheet', 'mobile-pdf-zoom-value']) element(id)
context.document = { getElementById: id => elements.get(id), querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { toggle() {}, remove() {} } } }
let seeks = 0
const pdf = viewport()
pdf.currentPage = 2
pdf.options.onPageChange = () => seeks++
context.window = { app: { pdfViewport: pdf, currentBookId: 'test-book', currentBookData: { format: 'pdf' } } }
const shell = module.namespace.mobileShell
shell.isInReader = true
shell.setupReaderToolListeners()
shell.syncPdfControls()
assert.equal(elements.get('mobile-pdf-page-badge').textContent, '3 / 5')
const slider = elements.get('mobile-pdf-page-slider')
slider.fire('pointerdown')
for (const value of [1, 4, 5]) { slider.value = value; slider.fire('input') }
assert.equal(seeks, 0, 'Scrubbing previews the target page without rendering each intermediate page')
slider.fire('change')
assert.equal(seeks, 1)
assert.equal(pdf.currentPage, 4)
slider.fire('pointerdown'); slider.value = 1; slider.fire('input'); slider.fire('pointercancel')
assert.equal(seeks, 1)
slider.fire('pointerdown'); slider.fire('pointerup')
assert.equal(shell._pdfScrubbing, false, 'A tap without changing the range must not freeze future page labels')
shell.openSheet('pdf-page')
elements.get('mobile-pdf-page-input').value = 2
elements.get('mobile-pdf-page-form').fire('submit')
assert.equal(pdf.currentPage, 1)
assert.equal(shell.activeSheet, null)
shell.isInReader = false
shell.syncPdfControls()
assert.equal(elements.get('mobile-pdf-page-badge').hidden, true)
console.log('PASS: live page labels, release-only seek, cancellation, page jump and reader exit')
