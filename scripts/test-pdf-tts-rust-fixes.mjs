import assert from 'node:assert/strict'
import { PdfViewport } from '../js/pdf-viewport.js'
import { PdfDrawingController, PdfDrawingMutationQueue } from '../js/pdf-drawing-controller.js'
import { PdfToolsController } from '../js/pdf-tools-controller.js'
import { OcrService } from '../js/ocr-service.js'
import { TtsPlayer } from '../js/tts-player.js'
import { platformBridge } from '../js/platformBridge.js'
import { requestAiCompletion } from '../js/reading-ai-assistant.js'

let passed = 0
async function test(name, fn) {
    await fn()
    passed++
    console.log(`[PASS] ${name}`)
}

function makeFakeElement(tag = 'div') {
    const classes = new Set()
    const attrs = new Map()
    const listeners = new Map()
    const el = {
        tagName: tag.toUpperCase(),
        style: { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] } },
        dataset: {},
        children: [],
        parentElement: null,
        isConnected: true,
        textContent: '',
        innerText: '',
        innerHTML: '',
        value: '',
        className: '',
        _rect: { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 },
        getBoundingClientRect() { return { ...this._rect } },
        classList: {
            add(...names) { names.forEach(n => classes.add(n)); el.className = [...classes].join(' ') },
            remove(...names) { names.forEach(n => classes.delete(n)); el.className = [...classes].join(' ') },
            contains(name) { return classes.has(name) },
            toggle(name, force) {
                const next = force === undefined ? !classes.has(name) : Boolean(force)
                if (next) classes.add(name); else classes.delete(name)
                el.className = [...classes].join(' ')
                return next
            }
        },
        setAttribute(k, v) { attrs.set(k, String(v)) },
        getAttribute(k) { return attrs.get(k) ?? null },
        removeAttribute(k) { attrs.delete(k) },
        appendChild(child) {
            if (child && typeof child === 'object') {
                child.parentElement = el
                el.children.push(child)
            }
            return child
        },
        append(...nodes) {
            for (const n of nodes) el.appendChild(n)
        },
        replaceChildren(...nodes) {
            for (const c of el.children) c.parentElement = null
            el.children = []
            for (const n of nodes) el.appendChild(n)
        },
        contains(target) {
            if (!target) return false
            if (target === el) return true
            return el.children.some(c => c === target || c.contains?.(target))
        },
        scrollTo() {},
        get clientWidth() { return el._rect.width },
        get clientHeight() { return el._rect.height },
        get scrollWidth() { return el._rect.width },
        get scrollHeight() { return el._rect.height },
        removeChild(child) {
            el.children = el.children.filter(c => c !== child)
            if (child.parentElement === el) child.parentElement = null
        },
        remove() {
            if (el.parentElement) el.parentElement.removeChild(el)
        },
        addEventListener(type, fn, opts) {
            const key = `${type}:${Boolean(opts?.capture || opts === true)}`
            if (!listeners.has(key)) listeners.set(key, [])
            listeners.get(key).push(fn)
        },
        removeEventListener(type, fn, opts) {
            const key = `${type}:${Boolean(opts?.capture || opts === true)}`
            if (!listeners.has(key)) return
            listeners.set(key, listeners.get(key).filter(f => f !== fn))
        },
        dispatchEvent(ev) {
            for (const capture of [true, false]) {
                const list = listeners.get(`${ev.type}:${capture}`) || []
                for (const fn of [...list]) fn(ev)
            }
        },
        querySelector(sel) {
            return el.querySelectorAll(sel)[0] || null
        },
        querySelectorAll(sel) {
            const parts = sel.split(',').map(s => s.trim()).filter(Boolean)
            const out = []
            const hasClass = (c, name) => c.classList?.contains(name) || String(c.className || '').split(/\s+/).includes(name)
            const matchesPart = (c, part) => {
                if (part.startsWith('.')) return hasClass(c, part.slice(1))
                return c.tagName?.toLowerCase() === part.toLowerCase()
            }
            const walk = (node) => {
                for (const c of node.children || []) {
                    if (parts.some(p => matchesPart(c, p))) out.push(c)
                    walk(c)
                }
            }
            walk(el)
            return out
        },
        closest(sel) {
            const cls = sel.startsWith('.') ? sel.slice(1) : null
            const hasClass = (c, name) => c.classList?.contains(name) || String(c.className || '').split(/\s+/).includes(name)
            let cur = el
            while (cur) {
                if (cls && hasClass(cur, cls)) return cur
                cur = cur.parentElement
            }
            return null
        }
    }
    return el
}

// 1. Single-Gesture Dismissal Lock in PdfViewport
await test('PdfViewport single-gesture dismissal lock blocks tap toggle after selection/popup clear', async () => {
    const prevDoc = globalThis.document
    const prevWin = globalThis.window
    const prevApp = globalThis.app
    const prevRO = globalThis.ResizeObserver
    const prevRAF = globalThis.requestAnimationFrame
    try {
        const docListeners = new Map()
        globalThis.ResizeObserver = class { observe() {} disconnect() {} }
        globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
        globalThis.document = {
            createElement: (tag) => makeFakeElement(tag),
            addEventListener: (t, fn) => {
                if (!docListeners.has(t)) docListeners.set(t, [])
                docListeners.get(t).push(fn)
            },
            removeEventListener: (t, fn) => {
                if (!docListeners.has(t)) return
                docListeners.set(t, docListeners.get(t).filter(f => f !== fn))
            },
            head: makeFakeElement('head'),
            getElementById: () => null
        }
        globalThis.window = {
            getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' }),
            addEventListener: () => {},
            removeEventListener: () => {}
        }

        let appActivePopup = true
        let captured = false
        globalThis.app = {
            captureSelectionAndPopupStateOnGestureStart() {
                captured = appActivePopup
                return captured
            },
            consumeDismissalGesture() {
                const res = captured
                captured = false
                appActivePopup = false
                return res
            }
        }

        let tapCount = 0
        const container = makeFakeElement('div')
        const vp = new PdfViewport(container, { onTap: () => { tapCount++ } })
        const scrollArea = vp.scrollArea

        // First gesture: popup/selection active on pointerdown, cleared before click -> tap suppressed
        scrollArea.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: scrollArea, clientX: 50, clientY: 50 })
        scrollArea.dispatchEvent({ type: 'click', target: scrollArea, clientX: 50, clientY: 50 })
        assert.strictEqual(tapCount, 0, 'Dismissing active popup/selection on click must NOT toggle toolbar')

        // Second gesture with nothing active -> click toggles toolbar
        scrollArea.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: scrollArea, clientX: 50, clientY: 50 })
        scrollArea.dispatchEvent({ type: 'click', target: scrollArea, clientX: 50, clientY: 50 })
        assert.strictEqual(tapCount, 1, 'Subsequent blank click with no active popup/selection must trigger onTap')

        // Fallback when globalThis.app lacks dismissal helpers and selectionchange clears _hasPdfDomSelection before click
        globalThis.app = {}
        vp._hasPdfDomSelection = true
        scrollArea.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: scrollArea, clientX: 50, clientY: 50 })
        vp._hasPdfDomSelection = false
        scrollArea.dispatchEvent({ type: 'click', target: scrollArea, clientX: 50, clientY: 50 })
        assert.strictEqual(tapCount, 1, 'Local PDF selection fallback lock must survive selectionchange clearing before click')
        vp.destroy?.()

        // Cold-start sub-80ms regression: performance.now() < 80 must still capture initial gesture
        const prevPerfNow = performance.now
        try {
            performance.now = () => 15
            appActivePopup = true
            captured = false
            globalThis.app = {
                captureSelectionAndPopupStateOnGestureStart() {
                    captured = appActivePopup
                    return captured
                },
                consumeDismissalGesture() {
                    const res = captured
                    captured = false
                    appActivePopup = false
                    return res
                }
            }
            let coldTapCount = 0
            const coldContainer = makeFakeElement('div')
            const coldVp = new PdfViewport(coldContainer, { onTap: () => { coldTapCount++ } })
            coldVp.scrollArea.dispatchEvent({ type: 'pointerdown', button: 0, pointerType: 'mouse', target: coldVp.scrollArea, clientX: 40, clientY: 40 })
            coldVp.scrollArea.dispatchEvent({ type: 'click', target: coldVp.scrollArea, clientX: 40, clientY: 40 })
            assert.strictEqual(coldTapCount, 0, 'Cold-start gesture (<80ms uptime) must still suppress toolbar toggle on popup dismissal')
            coldVp.destroy?.()
        } finally {
            performance.now = prevPerfNow
        }
    } finally {
        globalThis.document = prevDoc
        globalThis.window = prevWin
        globalThis.app = prevApp
        if (prevRO === undefined) delete globalThis.ResizeObserver
        else globalThis.ResizeObserver = prevRO
        if (prevRAF === undefined) delete globalThis.requestAnimationFrame
        else globalThis.requestAnimationFrame = prevRAF
    }
})

// 2. Crop-margin highlight hit-test, dual-spread zoom anchor, OCR overlay scale/remount, compositing
await test('PdfViewport aligns cropped highlight hits, dual-spread zoom anchor, OCR spans, and snapshot compositing', async () => {
    const vp = Object.assign(Object.create(PdfViewport.prototype), {
        pageOffsets: [
            { index: 0, width: 400, height: 600, top: 10, left: 20 },
            { index: 1, width: 400, height: 600, top: 10, left: 432 }
        ],
        totalHeight: 1200,
        _layoutWidth: 900,
        spreadMode: 'dual',
        zoomMode: null,
        scale: 2,
        rotation: 0,
        cropMargins: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
        _pageOcrSpans: new Map([[0, [{ text: 'Hello', x: 100, y: 120, w: 60, h: 20 }]]]),
        pageSizes: [{ width: 400, height: 600, x0: 10, y0: 20 }, { width: 400, height: 600, x0: 0, y0: 0 }],
        scrollArea: {
            clientWidth: 900,
            clientHeight: 700,
            scrollLeft: 0,
            scrollTop: 0,
            scrollWidth: 1200,
            scrollHeight: 1200,
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 700, right: 900, bottom: 700 })
        },
        container: { clientWidth: 900, clientHeight: 700 },
        activeSlots: new Map(),
        highlightsByPage: new Map([
            [0, [{ id: 'hl-crop', page: 0, rects: [{ x: 0.25, y: 0.25, w: 0.2, h: 0.05 }] }]]
        ]),
        _highlightSegment(hl) {
            return { rects: hl.rects.map(r => [r.x, r.y, r.x + r.w, r.y + r.h]) }
        }
    })

    // Dual-spread left offset must use pageOffset.left
    assert.strictEqual(vp._getPageLeftOffset(vp.pageOffsets[1]), 432)
    vp.scrollArea.scrollLeft = 100
    const anchor = vp._captureZoomAnchor(532, 210, 1)
    assert.strictEqual(anchor.page, 1)
    assert.ok(Math.abs(anchor.normX - ((100 + 532 - 432) / 400)) < 1e-6)
    vp.pageOffsets[1] = { index: 1, width: 800, height: 1200, top: 20, left: 864 }
    vp._layoutWidth = 1800
    vp._restoreZoomAnchor(anchor, false)
    assert.ok(Math.abs(vp.scrollArea.scrollLeft - (864 + anchor.normX * 800 - anchor.viewX)) < 1, 'Dual spread anchor must preserve horizontal position relative to page left offset')

    // Highlight hit test must use .pdf-highlight-layer uncropped rect rather than cropped wrapper rect
    const slot = makeFakeElement('div')
    slot.classList.add('pdf-page-slot')
    slot.dataset.page = '0'
    slot._rect = { left: 40, top: 60, width: 320, height: 480, right: 360, bottom: 540 }
    const hlLayer = makeFakeElement('div')
    hlLayer.classList.add('pdf-highlight-layer')
    hlLayer._rect = { left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600 }
    slot.appendChild(hlLayer)
    const hit = vp._hitTestHighlightAtPoint(slot, 120, 160) // norm (0.3, 0.266) inside rect x:0.25..0.45, y:0.25..0.30
    assert.strictEqual(hit?.hl?.id, 'hl-crop', 'Highlight hit test must map client coords against uncropped .pdf-highlight-layer')

    // OCR span restoration scales to scale and subtracts page x0/y0 CropBox origin
    const prevDoc = globalThis.document
    try {
        globalThis.document = { createElement: (t) => makeFakeElement(t) }
        const textLayer = makeFakeElement('div')
        vp._renderOcrLayerForPage(0, textLayer)
        const spans = textLayer.querySelectorAll('.pdf-ocr-span')
        assert.strictEqual(spans.length, 1)
        assert.strictEqual(spans[0].style.left, `${(100 - 10) * 2}px`)
        assert.strictEqual(spans[0].style.top, `${(120 - 20) * 2}px`)
    } finally {
        globalThis.document = prevDoc
    }

    // Composited snapshot places drawing layer at uncropped contentX/contentY/contentWidth/contentHeight
    const drawCalls = []
    vp.highlightsByPage = new Map()
    vp.getVisualVersion = () => 1
    vp.getPageViewportTransform = () => ({
        viewportWidth: 320, viewportHeight: 480,
        slotX: 0, slotY: 0, slotWidth: 320, slotHeight: 480,
        contentX: -40, contentY: -60, contentWidth: 400, contentHeight: 600
    })
    const fakeBitmapCanvas = { width: 320, height: 480 }
    const fakeDrawCanvas = { width: 400, height: 600 }
    const fakeSlot = makeFakeElement('div')
    const mainCanvasWrap = Object.assign(makeFakeElement('canvas'), fakeBitmapCanvas)
    mainCanvasWrap.classList.add('pdf-page-canvas')
    const drawCanvasWrap = Object.assign(makeFakeElement('canvas'), fakeDrawCanvas)
    drawCanvasWrap.classList.add('pdf-draw-base-canvas')
    fakeSlot.appendChild(mainCanvasWrap)
    fakeSlot.appendChild(drawCanvasWrap)
    vp.activeSlots.set(0, fakeSlot)
    const fakeCtx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalCompositeOperation: 'source-over',
        filter: 'none',
        fillRect() {},
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        rect() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        fill() {},
        stroke() {},
        setLineDash() {},
        scale() {},
        drawImage(img, x, y, w, h) { drawCalls.push({ img, x, y, w, h }) }
    }
    const prevDocCanvas = globalThis.document
    try {
        globalThis.document = {
            documentElement: makeFakeElement('html'),
            createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx })
        }
        vp.captureCompositedPageSnapshot(0)
        assert.strictEqual(drawCalls.length, 2)
        assert.deepStrictEqual(
            { x: drawCalls[1].x, y: drawCalls[1].y, w: drawCalls[1].w, h: drawCalls[1].h },
            { x: -40, y: -60, w: 400, h: 600 }
        )
    } finally {
        globalThis.document = prevDocCanvas
    }
})

// 3. PdfDrawingController queue ordering & uncropped overlay metrics
await test('PdfDrawingController waits for pending mutations and aligns overlay wrapper to page box metrics', async () => {
    const prevIndexedDB = globalThis.indexedDB
    const queue = new PdfDrawingMutationQueue()
    let flushedStroke = null
    const pendingTask = queue.enqueue('book1', 0, async () => {
        await new Promise(r => setTimeout(r, 15))
        flushedStroke = { id: 's2', points: [[0.2, 0.2], [0.3, 0.3]] }
    })
    const loadedStrokes = [{ id: 's1', points: [[0.1, 0.1], [0.15, 0.15]] }]
    globalThis.indexedDB = {
        open() {
            const req = {}
            const fakeDb = {
                objectStoreNames: { contains: () => true },
                transaction() {
                    return {
                        objectStore() {
                            return {
                                get() {
                                    const gReq = {}
                                    queueMicrotask(() => {
                                        gReq.result = { strokes: flushedStroke ? [...loadedStrokes, flushedStroke] : loadedStrokes }
                                        gReq.onsuccess?.({ target: gReq })
                                    })
                                    return gReq
                                },
                                getAll() {
                                    const gReq = {}
                                    queueMicrotask(() => { gReq.result = []; gReq.onsuccess?.({ target: gReq }) })
                                    return gReq
                                }
                            }
                        }
                    }
                }
            }
            queueMicrotask(() => {
                req.result = fakeDb
                req.onsuccess?.({ target: req })
            })
            return req
        }
    }
    const prevWin = globalThis.window
    globalThis.window = { ...(prevWin || {}), devicePixelRatio: 1 }
    try {
        const readerSession = { bookId: 'book1', epoch: 1, isCurrent: () => true }
        const ctrl = new PdfDrawingController({
            currentBookId: 'book1',
            currentBookData: { format: 'pdf' },
            activeReaderSession: readerSession,
            pdfViewport: {
                _getPageBoxMetrics: () => ({
                    slotWidth: 320, slotHeight: 480,
                    uncroppedWidth: 400, uncroppedHeight: 600,
                    contentOffsetX: -40, contentOffsetY: -60
                })
            }
        })
        ctrl._pdfMutationQueue = queue
        ctrl._getCurrentPdfSnapshotIdentity = () => ({})
        const loadPromise = ctrl.loadPdfPageStrokes(0, readerSession)
        await pendingTask
        const strokes = await loadPromise
        assert.deepStrictEqual(strokes.map(s => s.id), ['s1', 's2'], 'loadPdfPageStrokes must wait on in-flight mutations')

        const slot = makeFakeElement('div')
        const wrapper = makeFakeElement('div')
        wrapper.classList.add('pdf-draw-overlay-wrapper')
        const baseCvs = makeFakeElement('canvas'); baseCvs.classList.add('pdf-draw-base-canvas'); baseCvs.getContext = () => null
        const activeCvs = makeFakeElement('canvas'); activeCvs.classList.add('pdf-draw-active-canvas'); activeCvs.getContext = () => null
        wrapper.appendChild(baseCvs)
        wrapper.appendChild(activeCvs)
        slot.appendChild(wrapper)
        ctrl.syncPdfOverlayGeometryForSlot(0, slot)
        assert.strictEqual(wrapper.style.width, '400px')
        assert.strictEqual(wrapper.style.height, '600px')
        assert.strictEqual(wrapper.style.transform, 'translate(-40px, -60px)')
    } finally {
        if (prevIndexedDB === undefined) delete globalThis.indexedDB
        else globalThis.indexedDB = prevIndexedDB
        if (prevWin === undefined) delete globalThis.window
        else globalThis.window = prevWin
    }
})

// 4. PdfToolsController zoom input blur/Enter, <30% step-down, and exportAnnotatedPdf
await test('PdfToolsController preserves fit mode on unchanged blur, steps below 30%, and exports RGBA/pt-width/multi-rect annotations', async () => {
    const prevBridge = globalThis.window?.platformBridge
    const prevWin = globalThis.window
    const prevDoc = globalThis.document
    try {
        let exportedCall = null
        let flushed = false
        globalThis.document = {
            getElementById: () => null
        }
        globalThis.window = {
            ...(prevWin || {}),
            platformBridge: {
                async dialogPickSavePath() { return 'C:\\tmp\\annotated.pdf' },
                async mupdfExportAnnotatedPdf(docId, savePath, json) {
                    exportedCall = { docId, savePath, items: JSON.parse(json) }
                    return { success: true }
                }
            }
        }
        const events = {}
        const zoomInput = {
            value: '100%',
            blur() {},
            select() {},
            addEventListener(t, fn) { events[t] = fn }
        }
        const slider = { min: '30', max: '500', value: '100', addEventListener() {} }
        const setZoomCalls = []
        const vp = {
            driver: { docId: 'doc_1', numPages: 1, async getPageSizes() { return [{ width: 800, height: 1000 }] } },
            numPages: 1,
            pageSizes: [null],
            pages: [{ width: 800, height: 1000 }],
            scale: 0.3,
            zoomMode: 'fit-width',
            options: { minScale: 0.1, maxScale: 5.0 },
            setZoom(z) {
                setZoomCalls.push(z)
                if (typeof z === 'number') { this.scale = z; this.zoomMode = null }
                else { this.zoomMode = z }
            }
        }
        const ctrl = new PdfToolsController({
            currentBookId: 'b1',
            currentBookData: { format: 'pdf' },
            activeReaderSession: { bookId: 'b1', epoch: 1 },
            pdfViewport: vp,
            drawing: {
                color: '#ef4444',
                width: 3,
                opacity: 1,
                async flushPendingWrites() { flushed = true }
            },
            db: {
                async getHighlightsByBook() {
                    return [{
                        id: 'h1',
                        page: 0,
                        color: 'rgba(16, 185, 129, 0.6)',
                        rects: [
                            [0.1, 0.2, 0.4, 0.25],
                            [0.1, 0.26, 0.3, 0.31]
                        ]
                    }]
                },
                async getPdfPageDrawing() {
                    return {
                        strokes: [{
                            tool: 'pen',
                            color: '#123',
                            width: 8,
                            points: [[0.5, 0.5]] // 1-point stroke
                        }]
                    }
                }
            },
            dialogs: { showToast() {} }
        })
        ctrl.dom = { pdfZoomPercentInput: zoomInput, pdfZoomSlider: slider }
        ctrl.bindEvents()

        // Focus + unchanged blur must NOT clobber fit-width mode
        events.focus({ target: zoomInput })
        zoomInput.value = '100%'
        events.blur({ target: zoomInput })
        assert.strictEqual(vp.zoomMode, 'fit-width', 'Unchanged zoom input blur must preserve fit-width mode')

        // Typing a custom value and pressing Enter commits numeric zoom
        events.focus({ target: zoomInput })
        zoomInput.value = '125%'
        events.keydown({ key: 'Enter', preventDefault() {}, target: zoomInput })
        assert.strictEqual(vp.scale, 1.25)
        assert.strictEqual(vp.zoomMode, null)
        vp.scale = 0.3
        vp.zoomMode = 'fit-width'

        // Step down below 30%
        ctrl.stepPDFZoom(-10)
        assert.ok(setZoomCalls[setZoomCalls.length - 1] < 0.3 && Math.abs(setZoomCalls[setZoomCalls.length - 1] - 0.2) < 1e-6, 'stepPDFZoom must support stepping below 30% down to minScale')

        await ctrl.exportAnnotatedPdf()
        assert.strictEqual(flushed, true, 'exportAnnotatedPdf must await pending drawing writes')
        assert.ok(exportedCall && exportedCall.items.length === 2)
        const hl = exportedCall.items.find(x => x.type === 'highlight')
        const ink = exportedCall.items.find(x => x.type === 'ink')
        assert.strictEqual(hl.color, '#10b981')
        assert.ok(Math.abs(hl.opacity - 0.6) < 1e-3)
        assert.strictEqual(hl.quads.length, 16, 'Multi-rect highlight must preserve all rects as 2x8 quad coordinates')
        assert.strictEqual(ink.color, '#112233')
        assert.strictEqual(ink.width, 8 * (800 / 800))
        assert.strictEqual(ink.strokes[0].length, 2, '1-pt ink polyline must duplicate endpoint so MuPDF preserves dot')
    } finally {
        if (prevWin === undefined) delete globalThis.window
        else globalThis.window = prevWin
        if (prevDoc === undefined) delete globalThis.document
        else globalThis.document = prevDoc
    }
})

// 5. OcrService worker lifecycle & serialized queue isolation
await test('OcrService serializes recognize calls and prevents abort from killing newer OCR initialization', async () => {
    const svc = new OcrService()
    const order = []
    let activeWorkers = 0
    const fakeWorker = {
        async recognize() {
            order.push(`start:${++activeWorkers}`)
            await new Promise(r => setTimeout(r, 10))
            order.push(`end:${activeWorkers--}`)
            return { data: { text: 'ok', blocks: [] } }
        },
        async terminate() {}
    }
    svc._getWorker = async () => fakeWorker
    await Promise.all([svc.recognizeCanvas({}), svc.recognizeCanvas({})])
    assert.deepStrictEqual(order, ['start:1', 'end:1', 'start:1', 'end:1'], 'Concurrent recognize calls must never run simultaneously on shared worker')

    // Abort from old epoch does not break newer active epoch
    await svc.abort()
    const epochAfterAbort = svc._abortEpoch
    assert.ok(epochAfterAbort > 0)
    const res = await svc.recognizeCanvas({})
    assert.strictEqual(res.text, 'ok')
})

// 6. TtsPlayer stop/complete cleanup, stopped restart, Kana/Hangul/punctuation, EPUB scrollToAnchor, Android mediaSession suppression
await test('TtsPlayer clears segments on stop/completion, restarts from stopped, detects Kana/Hangul, uses scrollToAnchor, and suppresses WebView MediaSession on Android', async () => {
    const prevNav = globalThis.navigator
    const prevWin = globalThis.window
    const prevDoc = globalThis.document
    try {
        globalThis.window = new EventTarget()
        globalThis.document = Object.assign(new EventTarget(), { hidden: false })
        const mediaActions = new Map()
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            value: {
                mediaSession: {
                    metadata: null,
                    setActionHandler(action, fn) {
                        if (fn) mediaActions.set(action, fn); else mediaActions.delete(action)
                    }
                }
            }
        })

        // Desktop: MediaSession registered and play from stopped restarts playback
        const pDesktop = new TtsPlayer()
        pDesktop.isAndroid = false
        pDesktop.readerApp = { currentBookId: 'b1' }
        let playTriggered = 0
        pDesktop.play = () => { playTriggered++; return Promise.resolve() }
        pDesktop.initMediaSession()
        assert.ok(mediaActions.has('play'))
        pDesktop.state = 'stopped'
        mediaActions.get('play')()
        assert.strictEqual(playTriggered, 1, 'MediaSession play from stopped state must trigger play()')
        pDesktop.resume()
        assert.strictEqual(playTriggered, 2, 'TtsPlayer.resume() from stopped state must trigger play()')

        // Cleanup on stop(true)
        pDesktop.segments = [{ text: 'hello' }]
        pDesktop._segmentOwner = { bookId: 'b1', chapterKey: 'c1' }
        pDesktop.currentIndex = 0
        pDesktop.stop(true)
        assert.deepStrictEqual(pDesktop.segments, [])
        assert.strictEqual(pDesktop._segmentOwner, null)

        // EPUB scrollToAnchor called when segment element is connected, and PDF segment turns page
        let anchored = null
        let wentToPage = null
        pDesktop.readerApp = {
            foliateView: { renderer: { scrollToAnchor: async (el) => { anchored = el } } },
            pdfViewport: { currentPage: 1, goToPage(p) { wentToPage = p } }
        }
        const fakeSegEl = Object.assign(makeFakeElement('p'), { isConnected: true, scrollIntoView() {} })
        const epubSeg = { text: 'text', element: fakeSegEl }
        pDesktop.segments = [epubSeg]
        pDesktop.currentIndex = 0
        pDesktop.highlightSegment(epubSeg)
        assert.strictEqual(anchored, fakeSegEl)
        pDesktop.highlightSegment({ format: 'pdf', page: 3 })
        assert.strictEqual(wentToPage, 3)

        // Android native TTS clears WebView mediaSession handlers
        const prevIsAndroidDesc = Object.getOwnPropertyDescriptor(platformBridge, 'isAndroid')
        const prevIsTauriDesc = Object.getOwnPropertyDescriptor(platformBridge, 'isTauri')
        Object.defineProperty(platformBridge, 'isAndroid', { value: true, configurable: true, writable: true })
        Object.defineProperty(platformBridge, 'isTauri', { value: true, configurable: true, writable: true })
        try {
            const pAndroid = new TtsPlayer()
            pAndroid.currentProviderName = 'system'
            pAndroid.initMediaSession()
            assert.strictEqual(mediaActions.size, 0, 'Android WebView MediaSession handlers must be cleared when native service owns lockscreen')
        } finally {
            if (prevIsAndroidDesc) Object.defineProperty(platformBridge, 'isAndroid', prevIsAndroidDesc)
            else delete platformBridge.isAndroid
            if (prevIsTauriDesc) Object.defineProperty(platformBridge, 'isTauri', prevIsTauriDesc)
            else delete platformBridge.isTauri
        }

        // Language detection for Kana (ja-JP), Hangul (ko-KR), Han (zh-CN) & pure punctuation skip via WebSpeechProvider
        const spokenUtterances = []
        const prevUtt = globalThis.SpeechSynthesisUtterance
        globalThis.SpeechSynthesisUtterance = class {
            constructor(text) {
                this.text = text
                this.lang = ''
                this.rate = 1
                this.pitch = 1
                this.volume = 1
                this.voice = null
                this.onstart = null
                this.onend = null
                this.onerror = null
            }
        }
        globalThis.window.speechSynthesis = {
            cancel() {},
            speak(u) { spokenUtterances.push(u); setTimeout(() => u.onend?.(), 0) },
            getVoices() { return [] }
        }
        try {
            const pWeb = new TtsPlayer()
            const sysProv = pWeb.providers.system
            await sysProv.play({ text: '... --- !!!' })
            assert.strictEqual(spokenUtterances.length, 0, 'Pure punctuation must be skipped without synthesizing speech')
            await sysProv.play({ text: 'こんにちは世界' })
            await sysProv.play({ text: '안녕하세요 여러분' })
            assert.strictEqual(spokenUtterances[0].lang, 'ja-JP', 'Japanese Kana must detect as ja-JP')
            assert.strictEqual(spokenUtterances[1].lang, 'ko-KR', 'Korean Hangul must detect as ko-KR')
        } finally {
            if (prevUtt === undefined) delete globalThis.SpeechSynthesisUtterance
            else globalThis.SpeechSynthesisUtterance = prevUtt
            delete globalThis.window.speechSynthesis
        }
    } finally {
        if (prevNav === undefined) delete globalThis.navigator
        else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav })
        globalThis.window = prevWin
        globalThis.document = prevDoc
    }
})

// 7. PlatformBridge fallback & URL safety & chunked Base64 + AI failed status rejection
await test('PlatformBridge handles always-on-top fallback, external URL validation/fallback, chunked Base64, and AI stream failure rejection', async () => {
    const prevWin = globalThis.window
    const prevTauri = globalThis.__TAURI__
    try {
        const invoked = []
        const bridge = Object.create(platformBridge, {
            isTauri: { value: true },
            isAndroid: { value: false }
        })
        bridge._invokeTauri = async (cmd, args) => {
            invoked.push({ cmd, args })
            if (cmd === 'window_is_always_on_top') return true
            if (cmd === 'shell_open_external') return false
            return true
        }
        let openCalls = 0
        globalThis.window = {
            __TAURI__: {
                window: {
                    getCurrentWindow: () => ({
                        async setAlwaysOnTop() { throw new Error('ACL denied') },
                        async isAlwaysOnTop() { throw new Error('ACL denied') }
                    })
                }
            },
            open: (url) => { openCalls++; return { closed: false, url } }
        }

        const pinOk = await bridge.windowSetAlwaysOnTop(true)
        const isPinned = await bridge.windowIsAlwaysOnTop()
        assert.strictEqual(pinOk, true)
        assert.strictEqual(isPinned, true)
        assert.deepStrictEqual(invoked.slice(0, 2).map(x => x.cmd), ['window_set_always_on_top', 'window_is_always_on_top'])

        assert.strictEqual(await bridge.openExternal('javascript:alert(1)'), false)
        assert.strictEqual(await bridge.openExternal('file:///etc/passwd'), false)
        assert.strictEqual(await bridge.openExternal('https://example.com/oauth'), true)
        assert.strictEqual(openCalls, 1, 'When shell_open_external returns false, openExternal must fall back to window.open')

        // Multi-chunk Base64 exact match across 0x6000 boundary
        for (const len of [24575, 24576, 24577, 49153]) {
            const u8 = new Uint8Array(len)
            for (let i = 0; i < len; i++) u8[i] = (i * 37 + 11) & 0xff
            assert.strictEqual(bridge._bytesToBase64(u8), Buffer.from(u8).toString('base64'))
        }

        // reading-ai-assistant rejects on { status: 'failed' } and settles once
        globalThis.__TAURI__ = {
            event: { async listen() { return () => {} } },
            core: {
                async invoke(cmd) {
                    if (cmd === 'ai_get_status') return { isBusy: false, remainingCooldownMs: 0 }
                    return { requestId: 'r1', status: 'failed', error: 'Stream interrupted' }
                }
            }
        }
        await assert.rejects(
            requestAiCompletion({ endpoint: 'https://api.example.com/v1', model: 'gpt-4o', prompt: 'hi' }),
            /Stream interrupted/
        )
    } finally {
        if (prevWin === undefined) delete globalThis.window
        else globalThis.window = prevWin
        if (prevTauri === undefined) delete globalThis.__TAURI__
        else globalThis.__TAURI__ = prevTauri
    }
})

console.log(`All ${passed} pdf-tts-rust fix checks passed.`)
