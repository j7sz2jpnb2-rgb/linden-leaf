// Independent PDF viewport shared by PDF.js and native Rust PDF engine.
// Rendering is virtualized/cancellable; PDF.js owns its TextLayer, while
// native selection is based on engine character geometry in page coordinates.

import { isContentIdentityMatching } from './db.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const sleepFrame = () => new Promise(requestAnimationFrame)

const quadBounds = q => {
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function pointToSegmentDistanceSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return (px - x1) * (px - x1) + (py - y1) * (py - y1)
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
    t = Math.max(0, Math.min(1, t))
    const nx = x1 + t * dx, ny = y1 + t * dy
    return (px - nx) * (px - nx) + (py - ny) * (py - ny)
}

function quadArea(q) {
    if (!q || q.length < 8) return 0
    for (let i = 0; i < 8; i++) {
        if (!Number.isFinite(q[i])) return 0
    }
    const x0 = q[0], y0 = q[1]
    const x1 = q[2], y1 = q[3]
    const x2 = q[6], y2 = q[7]
    const x3 = q[4], y3 = q[5]
    return 0.5 * Math.abs((x0*y1 - y0*x1) + (x1*y2 - y1*x2) + (x2*y3 - y2*x3) + (x3*y0 - y3*x0))
}

function isPointInQuad(px, py, q) {
    if (!q || q.length < 8) return false
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false
    if (quadArea(q) < 1e-4) return false

    const x0 = q[0], y0 = q[1]
    const x1 = q[2], y1 = q[3]
    const x2 = q[6], y2 = q[7]
    const x3 = q[4], y3 = q[5]

    const c0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)
    const c1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
    const c2 = (x3 - x2) * (py - y2) - (y3 - y2) * (px - x2)
    const c3 = (x0 - x3) * (py - y3) - (y0 - y3) * (px - x3)
    const hasNeg = (c0 < -1e-5 || c1 < -1e-5 || c2 < -1e-5 || c3 < -1e-5)
    const hasPos = (c0 > 1e-5 || c1 > 1e-5 || c2 > 1e-5 || c3 > 1e-5)
    return !(hasNeg && hasPos)
}

function pointToQuadDistanceSq(px, py, q) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return Infinity
    if (quadArea(q) < 1e-4) return Infinity
    if (isPointInQuad(px, py, q)) return 0
    const d0 = pointToSegmentDistanceSq(px, py, q[0], q[1], q[2], q[3])
    const d1 = pointToSegmentDistanceSq(px, py, q[2], q[3], q[6], q[7])
    const d2 = pointToSegmentDistanceSq(px, py, q[6], q[7], q[4], q[5])
    const d3 = pointToSegmentDistanceSq(px, py, q[4], q[5], q[0], q[1])
    return Math.min(d0, d1, d2, d3)
}


export class PdfViewport {
    constructor(container, options = {}) {

        this.container = container
        this.options = Object.assign({
            scale: 1.25,
            minScale: 0.1,
            maxScale: 3.5,
            bufferPages: 2,
            maxCanvasEdge: 4096,
            maxCanvasPixels: 10_000_000,
            enableClip: true,
            clipPixelThreshold: 2_000_000,
            bitmapCacheLimitBytes: 64 * 1024 * 1024,
            snapshot: null,
            onPageChange: null,
            onOutline: null,
            onSelection: null,
            onSelectionClear: null,
            onHighlightCreate: null,
            onHighlightClick: null,
            onLinkClick: null,
            onSlotMount: null,
            onSlotUnmount: null,
            onSlotGeometrySync: null,
            onInteractionModeChange: null,
            onZoomChange: null,
            onTap: null,
        }, options)

        this.spreadMode = this.options.spreadMode || 'none'
        this.scale = this.options.scale
        this.zoomMode = null
        this.driver = null
        this.currentSnapshot = this.options.snapshot || null
        this.numPages = 0
        this.pageSizes = []
        this.pageOffsets = []
        this.totalHeight = 0
        this.activeSlots = new Map()
        this.currentPage = 0
        this.highlights = []
        this.highlightsByPage = new Map()
        this.interactionMode = 'select' // 'select' | 'draw'
        this._nativeGestureEpoch = 0

        this._destroyed = false
        this._geometryAbort = null
        this._knownPageGeometry = new Set()
        this._geometryQueue = []
        this._geometryQueued = new Set()
        this._geometryInFlight = null
        this._renderQueue = []
        this._inFlightRenders = new Map()
        this._activeDriverTasks = new Set()
        this._renderReqSeq = 0
        this._activeRenders = 0
        this._renderConcurrency = 2
        this._bitmapCache = new Map()
        this._bitmapCacheBytes = 0
        this._bitmapCacheLimitBytes = this.options.bitmapCacheLimitBytes || (64 * 1024 * 1024)
        this._lastScrollTop = 0
        this._outlineRequested = false
        this._outlineTimer = null
        this._nativeGeometry = new Map()
        this._nativeGeometryUse = new Map()
        this._nativeGeometryLimit = 16
        this._nativeDrag = null
        this._nativePreview = null
        this._selectionDismissedTime = 0
        this._isClearingSelection = false

        this._initDOM()
        this._bindEvents()
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._destroyed || !this.pageSizes.length || this._pinch) return
                if (this._layoutViewportWidth === this.scrollArea.clientWidth && this._layoutViewportHeight === this.scrollArea.clientHeight) return
                if (this._columnReadingEnabled) this._applyColumnFocus()
                else this.setZoom(this.zoomMode || this.scale)
            })
            this._resizeObserver.observe(this.scrollArea)
        }

        if (this.options.driver) {
            this.attachOpenedDriver(this.options.driver, { initialPage: this.options.initialPage ?? 0 })
        }
    }

    /**
     * Configure runtime resource budget (concurrency, pixel limit, cache memory)
     * @param {object} [budget]
     * @param {number} [budget.renderConcurrency]
     * @param {number} [budget.maxCanvasPixels]
     * @param {number} [budget.bitmapCacheLimitBytes]
     * @param {number} [budget.bufferPages]
     * @param {boolean} [budget.isLowMemoryDevice]
     */
    setResourceBudget(budget = {}) {
        if (typeof budget.renderConcurrency === 'number' && budget.renderConcurrency > 0) {
            this._renderConcurrency = budget.renderConcurrency
        }
        if (typeof budget.maxCanvasPixels === 'number' && budget.maxCanvasPixels > 0) {
            this.options.maxCanvasPixels = budget.maxCanvasPixels
        }
        if (typeof budget.bitmapCacheLimitBytes === 'number' && budget.bitmapCacheLimitBytes > 0) {
            this._bitmapCacheLimitBytes = budget.bitmapCacheLimitBytes
            this.options.bitmapCacheLimitBytes = budget.bitmapCacheLimitBytes
            this._pruneBitmapCache(0)
        }
        if (typeof budget.bufferPages === 'number' && budget.bufferPages >= 0) {
            this.options.bufferPages = budget.bufferPages
        }
        if (budget.isLowMemoryDevice) {
            this._renderConcurrency = 1
            this.options.bufferPages = 1
            this._bitmapCacheLimitBytes = 16 * 1024 * 1024
            this.options.bitmapCacheLimitBytes = 16 * 1024 * 1024
            this.options.maxCanvasPixels = 4_000_000
            this._pruneBitmapCache(0)
        }
    }

    _initDOM() {
        this.container.innerHTML = ''
        this.container.classList.add('pdf-viewport-container')
        this.scrollArea = document.createElement('div')
        this.scrollArea.className = 'pdf-viewport-scroll-area'
        this.spacer = document.createElement('div')
        this.spacer.className = 'pdf-viewport-spacer'
        this.scrollArea.append(this.spacer)
        this.container.append(this.scrollArea)

        if (document.getElementById('pdf-viewport-style')) return
        const style = document.createElement('style')
        style.id = 'pdf-viewport-style'
        style.textContent = `
        .pdf-viewport-container{position:relative;width:100%;height:100%;overflow:hidden;background:var(--bg-app,#525659);user-select:none}
        .pdf-viewport-scroll-area{position:absolute;inset:0;overflow:auto;scroll-behavior:auto;-webkit-overflow-scrolling:touch}
        .pdf-viewport-spacer{position:relative;margin:0 auto;box-sizing:border-box;padding:16px 0;min-width:100%}
        .pdf-page-slot{position:absolute;left:50%;transform:translateX(-50%);background:var(--book-bg,#fff);box-shadow:0 4px 18px #00000047;border-radius:2px;overflow:hidden;box-sizing:border-box;touch-action: pan-x pan-y}
        .pdf-img-wrapper{position:absolute;inset:0;overflow:hidden;pointer-events:none}
        .pdf-page-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;font:13px/1.5 system-ui,sans-serif;pointer-events:none}
        .pdf-page-canvas{position:absolute;inset:0;width:100%;height:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none}
        .pdf-page-preview{position:absolute;inset:0;width:100%;height:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none;z-index:1}
        .pdf-clip-canvas{position:absolute;left:0;width:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none;z-index:2}
        .pdf-text-layer{position:absolute;inset:0;overflow:clip;z-index:4;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0;user-select:text;-webkit-user-select:text;pointer-events:auto;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size))}
        .pdf-text-layer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
        .pdf-text-layer>:not(.markedContent),.pdf-text-layer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
        .pdf-text-layer .markedContent{display:contents}.pdf-text-layer span[role=img]{user-select:none;cursor:default}
        .pdf-text-layer ::selection{background:rgba(37,99,235,.32)!important;color:transparent!important}.pdf-text-layer br::selection{background:transparent}
        .pdf-highlight-layer,.pdf-native-selection-layer{position:absolute;inset:0;pointer-events:none}
        .pdf-highlight-layer{z-index:3}.pdf-native-selection-layer{z-index:5}
        .pdf-native-selection-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
        .pdf-native-selection-layer polygon{fill:rgba(37,99,235,.28)}
        .pdf-highlight-rect{position:absolute;mix-blend-mode:multiply;border-radius:2px;pointer-events:auto;cursor:pointer;box-sizing:border-box;transition:filter .1s ease}
        .pdf-highlight-rect:hover{filter:brightness(.92)}
        .pdf-highlight-rect.pdf-style-underline,.pdf-highlight-rect.pdf-style-dashed,.pdf-highlight-rect.pdf-style-strikethrough,.pdf-highlight-rect.pdf-style-squiggly{mix-blend-mode:normal!important;background-color:transparent!important}
        .pdf-highlight-poly{mix-blend-mode:multiply;pointer-events:auto;cursor:pointer;transition:filter .1s ease}
        .pdf-highlight-poly:hover{filter:brightness(.92)}
        .pdf-highlight-poly.pdf-style-underline,.pdf-highlight-poly.pdf-style-dashed,.pdf-highlight-poly.pdf-style-strikethrough,.pdf-highlight-poly.pdf-style-squiggly{mix-blend-mode:normal!important}
        [data-theme="dark"] .pdf-highlight-rect,[data-theme="black"] .pdf-highlight-rect,
        [data-theme="dark"] .pdf-highlight-poly,[data-theme="black"] .pdf-highlight-poly{mix-blend-mode:screen}
        .pdf-render-error{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#64748b;font:13px/1.5 system-ui;z-index:2}
        @keyframes pdfSearchPulse{0%{box-shadow:0 0 0 0 #f97316cc;background:#f97316d9;transform:scale(1)}40%{box-shadow:0 0 0 9px #f9731644;background:#facc15d9;transform:scale(1.03)}100%{box-shadow:none;background:#facc1566;transform:scale(1)}}
        .pdf-search-pulse{position:absolute;pointer-events:none;z-index:10;border-radius:2px;animation:pdfSearchPulse 2.2s cubic-bezier(.25,1,.5,1) forwards}
        @keyframes pdfHighlightPulse{0%{box-shadow:0 0 0 0 #3b82f6cc;filter:brightness(1.4)}40%{box-shadow:0 0 0 8px #3b82f659;filter:brightness(1.6)}100%{box-shadow:none;filter:none}}
        .pdf-highlight-pulse{animation:pdfHighlightPulse 2s cubic-bezier(.25,1,.5,1) forwards!important}
        `
        document.head.append(style)
    }

    _bindEvents() {
        let ticking = false
        this.scrollArea.addEventListener('scroll', () => {
            const now = performance.now()
            const curTop = this.scrollArea.scrollTop
            const dt = now - (this._lastScrollEventTs || 0)
            const dy = Math.abs(curTop - (this._lastScrollEventTop ?? curTop))
            this._lastScrollEventTs = now
            this._lastScrollEventTop = curTop
            if (!ticking) {
                ticking = true
                requestAnimationFrame(() => {
                    ticking = false
                    if (this._destroyed) return
                    this._detectCurrentPage()
                    // Always schedule the page under the reader on the next frame.
                    // Holding a key must not postpone its raster until scrolling stops.
                    this._renderVisibleSlots()
                })
            }

        }, { passive: true })

        this.scrollArea.addEventListener('mouseup', e => {
            if (this.interactionMode === 'draw') return
            if (this.driver?.kind !== 'mupdf') this._handleDomSelection(e)
        })
        this.scrollArea.addEventListener('pointerdown', e => this._nativePointerDown(e))
        this.scrollArea.addEventListener('pointermove', e => this._nativePointerMove(e))
        this.scrollArea.addEventListener('pointerup', e => this._nativePointerUp(e))
        this.scrollArea.addEventListener('pointercancel', () => this._cancelNativeDrag())
        this.scrollArea.addEventListener('dblclick', e => this._nativeDoubleClick(e))
        this.scrollArea.addEventListener('touchstart', e => this._handleTouchStart(e), { passive: false })
        this.scrollArea.addEventListener('touchmove', e => this._handleTouchMove(e), { passive: false })
        this.scrollArea.addEventListener('touchend', e => this._handleTouchEnd(e), { passive: false })
        this.scrollArea.addEventListener('touchcancel', () => this._handleTouchCancel())

        this.scrollArea.addEventListener('click', e => {
            if (this.interactionMode === 'draw' || this._nativeDrag || this.shouldIgnoreContentClick()) return
            if (this._ignoreClickUntil && performance.now() < this._ignoreClickUntil) return
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim()) return
            if (this._selectionDismissedTime && performance.now() - this._selectionDismissedTime < 600) {
                this._selectionDismissedTime = 0
                return
            }
            if (this._nativePreview?.length) {
                this.clearSelection()
                return
            }
            const slot = e.target.closest?.('.pdf-page-slot')
            if (!slot) {
                if (!this._lastTapHandledTime || (performance.now() - this._lastTapHandledTime > 800)) {
                    this.options.onTap?.()
                }
                return
            }
            const page = Number(slot.dataset.page)
            const rect = slot.getBoundingClientRect()
            const x = (e.clientX - rect.left) / rect.width
            const y = (e.clientY - rect.top) / rect.height
            for (const hl of [...(this.highlightsByPage.get(page) || [])].reverse()) {
                const segment = this._highlightSegment(hl, page)
                for (const [x1, y1, x2, y2] of segment?.rects || []) {
                    if (x >= x1 - 6 / rect.width && x <= x2 + 6 / rect.width && y >= y1 - 6 / rect.height && y <= y2 + 6 / rect.height) {
                        clearTimeout(this._singleTapTimer)
                        e.stopPropagation()
                        this.options.onHighlightClick?.(hl, e, {
                            left: rect.left + x1 * rect.width,
                            top: rect.top + y1 * rect.height,
                            width: (x2 - x1) * rect.width,
                            height: (y2 - y1) * rect.height,
                        })
                        return
                    }
                }
            }
            if (!this._lastTapHandledTime || (performance.now() - this._lastTapHandledTime > 800)) {
                this.options.onTap?.()
            }
        })
    }

    async load(engineDriver, source, { initialPage = 0, initialYRatio = 0, snapshot = null } = {}) {
        if (this._destroyed) return { numPages: 0, title: '', author: '', toc: [] }
        this._loadGeneration = (this._loadGeneration || 0) + 1
        const currentGen = this._loadGeneration

        this.driver = engineDriver
        this._outlineRequested = false
        this._geometryAbort?.abort()
        this._geometryInFlight = null
        this._geometryQueue.length = 0
        this._geometryQueued.clear()
        this._knownPageGeometry.clear()
        for (const [page, slot] of [...this.activeSlots]) this._unmountSlot(page, slot)
        for (const inflight of this._inFlightRenders.values()) inflight.abortController?.abort()
        this._inFlightRenders.clear()
        this._renderQueue.length = 0
        this._bitmapCache.clear()
        this._bitmapCacheBytes = 0
        this._lastScrollTop = 0
        if (snapshot) this.currentSnapshot = snapshot
        const info = await this.driver.open(source)
        if (this._destroyed || this._loadGeneration !== currentGen) {
            try { engineDriver?.destroy?.() } catch {}
            return { numPages: 0, title: '', author: '', toc: [] }
        }
        this.numPages = info.numPages || 1
        this.pageSizes = info.pageSizes?.length
            ? info.pageSizes.map(x => ({ x0: 0, y0: 0, ...x }))
            : Array.from({ length: this.numPages }, () => ({ x0: 0, y0: 0, width: 595, height: 842 }))
        this._knownPageGeometry.add(0)
        if (info.allPageSizesKnown || this.driver?.allPageSizesKnown) {
            for (let i = 0; i < this.numPages; i++) this._knownPageGeometry.add(i)
        }
        this._updateRenderConcurrency()
        this._recomputeLayout()

        // Contract 1D: Initial target page set before first render is queued
        const resolvedInitialPage = typeof initialPage === 'function' ? initialPage(this.numPages) : initialPage
        const targetPage = clamp(resolvedInitialPage, 0, this.numPages - 1)
        this.currentPage = targetPage
        this._initialTargetPage = targetPage
        const targetOffset = this.pageOffsets[targetPage]
        if (targetOffset) {
            this.scrollArea.scrollTop = Math.max(0, targetOffset.top + targetOffset.height * clamp(initialYRatio, 0, 1) - (initialYRatio ? this.scrollArea.clientHeight / 3 : 8))
        }

        this._renderVisibleSlots(true)
        this._geometryAbort = new AbortController()
        if (!info.allPageSizesKnown && !this.driver?.allPageSizesKnown) {
            this._enqueueGeometry(targetPage)
        }
        return { numPages: this.numPages, title: info.title || 'PDF 文档', author: info.author || '未知作者', toc: info.toc || [] }
    }

    async attachOpenedDriver(engineDriver, { initialPage = 0, initialYRatio = 0, snapshot = null } = {}) {
        if (this._destroyed) return { numPages: 0 }
        const generation = this._loadGeneration = (this._loadGeneration || 0) + 1
        this.driver = engineDriver
        this._outlineRequested = false
        this._geometryAbort?.abort()
        this._geometryInFlight = null
        this._geometryQueue.length = 0
        this._geometryQueued.clear()
        this._knownPageGeometry.clear()
        for (const [page, slot] of [...this.activeSlots]) this._unmountSlot(page, slot)
        for (const inflight of this._inFlightRenders.values()) inflight.abortController?.abort()
        this._inFlightRenders.clear()
        this._renderQueue.length = 0
        this._bitmapCache.clear()
        this._bitmapCacheBytes = 0
        this._lastScrollTop = 0
        if (snapshot) this.currentSnapshot = snapshot

        this.numPages = engineDriver.numPages || 1
        this.pageSizes = Array.from({ length: this.numPages }, () => ({ x0: 0, y0: 0, width: 595, height: 842 }))

        // Reuse any existing known page sizes from real driver
        const existingSizes = engineDriver.realDriver?.pageSizes || engineDriver.pageSizes
        if (Array.isArray(existingSizes)) {
            existingSizes.forEach((sz, idx) => {
                if (sz && idx < this.numPages) {
                    this.pageSizes[idx] = { x0: 0, y0: 0, ...sz }
                    this._knownPageGeometry.add(idx)
                }
            })
        }

        const resolvedInitialPage = typeof initialPage === 'function' ? initialPage(this.numPages) : initialPage
        const targetPage = clamp(resolvedInitialPage, 0, this.numPages - 1)
        this.currentPage = targetPage

        this._geometryAbort = new AbortController()
        const batchStart = Math.floor(targetPage / 8) * 8
        const batchCount = Math.min(8, this.numPages - batchStart)
        if (typeof engineDriver.getPageSizes === 'function' && !this._knownPageGeometry.has(targetPage)) {
            try {
                const res = await engineDriver.getPageSizes(batchStart, batchCount, this._geometryAbort.signal)
                if (this._destroyed || generation !== this._loadGeneration || this.driver !== engineDriver) return { numPages: 0 }
                if (Array.isArray(res)) {
                    for (let i = 0; i < res.length; i++) {
                        const pIdx = batchStart + i
                        if (pIdx < this.numPages && res[i]) {
                            this.pageSizes[pIdx] = { x0: 0, y0: 0, ...res[i] }
                            this._knownPageGeometry.add(pIdx)
                        }
                    }
                }
            } catch (err) {
                console.warn('[PDF] Failed to fetch initial secondary page sizes:', err)
            }
        }

        if (this._destroyed || generation !== this._loadGeneration || this.driver !== engineDriver) return { numPages: 0 }
        if (this._knownPageGeometry.size === 0) {
            this._knownPageGeometry.add(0)
        }

        this._updateRenderConcurrency()
        this._recomputeLayout()

        const targetOffset = this.pageOffsets[targetPage]
        if (targetOffset && this.scrollArea) {
            this.scrollArea.scrollTop = Math.max(0, targetOffset.top + targetOffset.height * clamp(initialYRatio, 0, 1) - (initialYRatio ? this.scrollArea.clientHeight / 3 : 8))
        }

        this._renderVisibleSlots(true)
        if (!engineDriver.allPageSizesKnown) {
            this._enqueueGeometry(targetPage)
        }
        return { numPages: this.numPages }
    }

    _enqueueGeometry(page) {
        if (!this.driver?.getPageSizes || !this._geometryAbort || this._geometryAbort.signal.aborted) return
        if (!Number.isInteger(page) || page < 0 || page >= this.numPages) return
        const start = Math.floor(page / 8) * 8
        const end = Math.min(this.numPages, start + 8)
        if (this._geometryQueued.has(start) ||
            Array.from({ length: end - start }, (_, i) => start + i).every(i => this._knownPageGeometry.has(i))) return
        this._geometryQueued.add(start)
        this._geometryQueue.push(start)
        // A rapid scrollbar drag must not leave hundreds of obsolete batches.
        this._geometryQueue.sort((a, b) => Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage))
        while (this._geometryQueue.length > 4) this._geometryQueued.delete(this._geometryQueue.pop())
        this._drainGeometryQueue().catch(err => console.warn('[PDF] page geometry unavailable:', err))
    }

    async _drainGeometryQueue() {
        const signal = this._geometryAbort.signal
        if (this._geometryInFlight === signal) return
        this._geometryInFlight = signal
        const driver = this.driver
        try {
            while (this._geometryQueue.length && !signal.aborted && !this._destroyed) {
                this._geometryQueue.sort((a, b) => Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage))
                const start = this._geometryQueue.shift()
                let values
                try {
                    values = await driver.getPageSizes(start, Math.min(8, this.numPages - start), signal)
                } catch (err) {
                    if (!signal.aborted) console.warn('[PDF] page geometry batch failed:', err)
                    continue
                } finally {
                    this._geometryQueued.delete(start)
                }
                if (signal.aborted || this._destroyed || driver !== this.driver || !values?.length) continue
                const anchorPage = clamp(this.currentPage, 0, this.pageOffsets.length - 1)
                const anchor = this._captureZoomAnchor(null, null, anchorPage)
                const changedActive = []
                let changed = false
                values.forEach((size, j) => {
                    const i = start + j
                    if (!this.pageSizes[i]) return
                    this._knownPageGeometry.add(i)
                    const prev = this.pageSizes[i]
                    const next = { ...prev, ...size }
                    if (Math.abs(prev.width - next.width) > .01 || Math.abs(prev.height - next.height) > .01 || prev.x0 !== next.x0 || prev.y0 !== next.y0) {
                        this.pageSizes[i] = next
                        changed = true
                        if (this.activeSlots.has(i)) changedActive.push(i)
                    }
                })
                if (changed) {
                    if (this.zoomMode) this.scale = this.getFitScale(this.zoomMode)
                    this._recomputeLayout()
                    this._restoreZoomAnchor(anchor)
                    this._syncActiveSlotGeometry()
                    for (const page of changedActive) this._remountPage(page)
                    if (this._columnReadingEnabled) this._applyColumnFocus()
                    this._renderVisibleSlots(true)
                }
                await sleepFrame()
            }
        } finally {
            if (this._geometryInFlight === signal) this._geometryInFlight = null
            if (this._geometryQueue.length && !this._geometryAbort.signal.aborted && !this._destroyed && !this._geometryInFlight) {
                this._drainGeometryQueue().catch(err => console.warn('[PDF] page geometry unavailable:', err))
            }
        }
    }

    _recalculateLayout() {
        return this._recomputeLayout()
    }

    _recomputeLayout() {
        if (!Array.isArray(this.pageSizes) || !this.pageSizes.length) {
            this.pageOffsets = []
            this.totalHeight = 0
            this._layoutWidth = 0
            return
        }
        this.pageOffsets = []
        const gap = 16
        let y = 16
        let maxWidth = 0

        if (this.spreadMode === 'dual') {
            // Page 0 (Page 1 in 1-based indexing, cover) occupies its own row centered horizontally
            if (this.pageSizes.length > 0) {
                const s0 = this.pageSizes[0]
                const w0 = Math.max(1, Math.round(s0.width * this.scale))
                const h0 = Math.max(1, Math.round(s0.height * this.scale))
                this.pageOffsets.push({ top: y, width: w0, height: h0, left: null })
                maxWidth = Math.max(maxWidth, w0)
                y += h0 + gap
            }

            // Subsequent pages (2 & 3, 4 & 5, ...) are placed side-by-side on the same row
            for (let i = 1; i < this.pageSizes.length; i += 2) {
                const sL = this.pageSizes[i]
                const wL = Math.max(1, Math.round(sL.width * this.scale))
                const hL = Math.max(1, Math.round(sL.height * this.scale))

                if (i + 1 < this.pageSizes.length) {
                    const sR = this.pageSizes[i + 1]
                    const wR = Math.max(1, Math.round(sR.width * this.scale))
                    const hR = Math.max(1, Math.round(sR.height * this.scale))
                    const rowH = Math.max(hL, hR)

                    this.pageOffsets.push({ top: y, width: wL, height: hL, left: null, _pairRight: i + 1, _wR: wR })
                    this.pageOffsets.push({ top: y, width: wR, height: hR, left: null })
                    maxWidth = Math.max(maxWidth, wL + gap + wR)
                    y += rowH + gap
                } else {
                    // Trailing single page
                    this.pageOffsets.push({ top: y, width: wL, height: hL, left: null })
                    maxWidth = Math.max(maxWidth, wL)
                    y += hL + gap
                }
            }
        } else {
            for (let i = 0; i < this.pageSizes.length; i++) {
                const size = this.pageSizes[i]
                const margins = this._getCropMarginsForPage(i)
                const cropW = Math.max(1, (1 - (margins.left + margins.right) / 100) * size.width)
                const cropH = Math.max(1, (1 - (margins.top + margins.bottom) / 100) * size.height)
                const width = Math.max(1, Math.round(cropW * this.scale))
                const height = Math.max(1, Math.round(cropH * this.scale))
                this.pageOffsets.push({ top: y, width, height, left: null })
                y += height + gap
                maxWidth = Math.max(maxWidth, width)
            }
        }

        const lastPage = this.pageOffsets.at(-1)
        const viewportHeight = this.scrollArea.clientHeight || this.container.clientHeight || 0
        this._layoutViewportWidth = this.scrollArea.clientWidth
        this._layoutViewportHeight = this.scrollArea.clientHeight
        this.totalHeight = this.zoomMode && lastPage ? Math.max(y, lastPage.top + viewportHeight) : y
        this._layoutWidth = Math.max(maxWidth + 32, this.scrollArea.clientWidth || this.container.clientWidth || 0)

        // Assign horizontal left offsets
        if (this.spreadMode === 'dual') {
            if (this.pageOffsets.length > 0) {
                this.pageOffsets[0].left = Math.round((this._layoutWidth - this.pageOffsets[0].width) / 2)
            }
            for (let i = 1; i < this.pageOffsets.length; i++) {
                const p = this.pageOffsets[i]
                if (p._pairRight) {
                    const pairW = p.width + gap + p._wR
                    const startX = Math.max(16, Math.round((this._layoutWidth - pairW) / 2))
                    p.left = startX
                    const pR = this.pageOffsets[i + 1]
                    if (pR) {
                        pR.left = startX + p.width + gap
                    }
                    delete p._pairRight
                    delete p._wR
                    i++
                } else if (p.left == null) {
                    p.left = Math.round((this._layoutWidth - p.width) / 2)
                }
            }
        } else {
            for (const p of this.pageOffsets) {
                p.left = null
            }
        }

        this.spacer.style.height = `${this.totalHeight}px`
        this.spacer.style.width = `${this._layoutWidth}px`
    }

    _syncActiveSlotGeometry() {
        for (const [page, slot] of this.activeSlots) {
            const p = this.pageOffsets[page]
            if (!p) continue
            slot.style.top = `${p.top}px`
            if (this.spreadMode === 'dual' && p.left != null) {
                slot.style.left = `${p.left}px`
                slot.style.transform = 'none'
            } else {
                slot.style.left = '50%'
                slot.style.transform = 'translateX(-50%)'
            }
            slot.style.width = `${p.width}px`
            slot.style.height = `${p.height}px`
            this._applyCropToSlot(page, slot)
            this.options.onSlotGeometrySync?.(page, slot)
        }
    }

    _firstPageAt(y) {
        let lo = 0, hi = this.pageOffsets.length
        while (lo < hi) {
            const mid = (lo + hi) >>> 1, p = this.pageOffsets[mid]
            if (p.top + p.height < y) lo = mid + 1
            else hi = mid
        }
        if (lo > 0 && this.pageOffsets[lo] && this.pageOffsets[lo - 1] && this.pageOffsets[lo].top === this.pageOffsets[lo - 1].top) {
            lo--
        }
        return lo
    }

    _findVisibleRange(bufferPages = this.options.bufferPages) {
        if (!this.pageOffsets.length) return { first: 0, last: 0, start: 0, end: 0 }
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        let first = this._firstPageAt(top)
        if (first > 0 && this.pageOffsets[first] && this.pageOffsets[first - 1] && this.pageOffsets[first].top === this.pageOffsets[first - 1].top) {
            first--
        }
        let last = first
        for (let i = first; i < this.pageOffsets.length && this.pageOffsets[i].top <= bottom; i++) {
            last = i
        }
        if (last + 1 < this.pageOffsets.length && this.pageOffsets[last + 1].top === this.pageOffsets[last].top) {
            last++
        }
        const buf = bufferPages * (this.spreadMode === 'dual' ? 2 : 1)
        const start = Math.max(0, first - buf)
        const end = Math.min(this.pageOffsets.length - 1, last + buf)
        return { first, last, start, end }
    }

    _isPageQueuedOrRendering(page, token) {
        const inQueue = this._renderQueue.some(x => x.page === page && x.token === token)
        if (inQueue) return true
        const inFlight = this._inFlightRenders.get(page)
        if (inFlight && inFlight.token === token && !inFlight.abortController?.signal?.aborted) return true
        return false
    }

    _syncVisibleSlotsOnly() {
        if (!this.pageOffsets.length) return
        const { first, last, start, end } = this._findVisibleRange()
        const needed = new Set()
        for (let i = start; i <= end; i++) needed.add(i)

        for (const [page, slot] of [...this.activeSlots]) {
            if (!needed.has(page)) {
                this._unmountSlot(page, slot)
            } else if (page < first || page > last) {
                const inFlight = this._inFlightRenders.get(page)
                if (inFlight) {
                    inFlight.abortController?.abort()
                    this._inFlightRenders.delete(page)
                }
            }
        }
        this._renderQueue = this._renderQueue.filter(item => item.page >= first && item.page <= last)
        for (let i = start; i <= end; i++) {
            if (!this.activeSlots.has(i)) this._mountSlot(i)
        }
    }

    _renderVisibleSlots(force = false) {
        if (!this.pageOffsets.length) return
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const { first, last, start, end } = this._findVisibleRange()
        this._enqueueGeometry(first)
        if (last !== first) this._enqueueGeometry(last)
        const needed = new Set()
        for (let i = start; i <= end; i++) needed.add(i)

        for (const [page, slot] of [...this.activeSlots]) {
            if (!needed.has(page)) this._unmountSlot(page, slot)
        }
        for (let i = start; i <= end; i++) if (!this.activeSlots.has(i)) this._mountSlot(i)

        if (force) {
            for (let i = start; i <= end; i++) {
                const slot = this.activeSlots.get(i)
                if (!slot) continue
                slot._renderToken = (slot._renderToken || 0) + 1
                slot.renderAbort?.abort()
                slot.renderAbort = new AbortController()
                const text = slot.querySelector('.pdf-text-layer')
                if (text) {
                    text.style.opacity = '0'
                    text.style.pointerEvents = 'none'
                }
            }
        }

        const toSchedule = []
        for (let i = first; i <= last; i++) {
            const slot = this.activeSlots.get(i)
            if (!slot) continue
            let needsRender = force || slot._renderedScale !== this.scale || !slot._renderedToken
            if (!needsRender && slot._renderedClip) {
                const p = this.pageOffsets[i]
                if (p) {
                    const vTop = Math.max(0, top - p.top)
                    const vBottom = Math.min(p.height, bottom - p.top)
                    const sLeft = this.scrollArea.scrollLeft || 0
                    const sRight = sLeft + (this.scrollArea.clientWidth || p.width)
                    const pageLeft = p.left != null ? p.left : Math.max(0, ((this.scrollArea.scrollWidth || p.width) - p.width) * 0.5)
                    const vLeft = Math.max(0, sLeft - pageLeft)
                    const vRight = Math.min(p.width, sRight - pageLeft)
                    const outOfVertical = vTop < slot._renderedClip.top || vBottom > slot._renderedClip.bottom
                    const outOfHorizontal = slot._renderedClip.left != null && slot._renderedClip.right != null &&
                        (vLeft < slot._renderedClip.left || vRight > slot._renderedClip.right)
                    if (outOfVertical || outOfHorizontal) {
                        needsRender = true
                        slot._renderToken = (slot._renderToken || 0) + 1
                        slot.renderAbort?.abort()
                        slot.renderAbort = new AbortController()
                    }
                }
            }
            if (needsRender) {
                if (!this._isPageQueuedOrRendering(i, slot._renderToken)) {
                    toSchedule.push({
                        page: i,
                        slot,
                        token: slot._renderToken,
                        tier: 0,
                        distance: Math.abs(i - this.currentPage),
                    })
                }
            }
        }

        const scrollDelta = top - (this._lastScrollTop ?? top)
        this._lastScrollTop = top
        const isScrollingDown = scrollDelta >= 0

        for (let i = start; i <= end; i++) {
            if (i >= first && i <= last) continue
            const slot = this.activeSlots.get(i)
            if (!slot) continue
            if (force || slot._renderedScale !== this.scale || !slot._renderedToken) {
                if (!this._isPageQueuedOrRendering(i, slot._renderToken)) {
                    let dist = i < first ? (first - i) : (i - last)
                    if (isScrollingDown && i < first) dist += 2
                    if (!isScrollingDown && i > last) dist += 2
                    toSchedule.push({
                        page: i,
                        slot,
                        token: slot._renderToken,
                        tier: 1,
                        distance: dist,
                    })
                }
            }
        }

        for (const item of toSchedule) {
            this._scheduleRender(item)
        }

        this._pumpRenderQueue()
    }

    _unmountSlot(page, slot) {
        this.options.onSlotUnmount?.(page, slot)
        slot.renderAbort?.abort()
        if (slot.geometryIdleId != null) window.cancelIdleCallback?.(slot.geometryIdleId)
        if (slot.geometryTimer != null) clearTimeout(slot.geometryTimer)
        try {
            const canvases = slot.querySelectorAll('canvas')
            for (const cvs of canvases) {
                cvs.width = 0
                cvs.height = 0
            }
        } catch (e) {}
        slot.remove()
        this.activeSlots.delete(page)
        const inFlight = this._inFlightRenders.get(page)
        if (inFlight && inFlight.slot === slot) {
            this._inFlightRenders.delete(page)
        }
        this._renderQueue = this._renderQueue.filter(x => x.page !== page || x.slot !== slot)
        this._activeRenders = Math.max(this._activeDriverTasks.size, this._inFlightRenders.size)
    }

    _remountPage(page) {
        const slot = this.activeSlots.get(page)
        if (!slot) return
        this._unmountSlot(page, slot)
        this._mountSlot(page)
        this._renderVisibleSlots()
    }

    _mountSlot(page) {
        const layout = this.pageOffsets[page]
        if (!layout) return
        const slot = document.createElement('div')
        slot.className = 'pdf-page-slot'
        slot.dataset.page = String(page)
        slot._renderToken = 1
        slot.renderAbort = new AbortController()
        const slotStyle = {
            top: `${layout.top}px`,
            width: `${layout.width}px`,
            height: `${layout.height}px`,
        }
        if (this.spreadMode === 'dual' && layout.left != null) {
            slotStyle.left = `${layout.left}px`
            slotStyle.transform = 'none'
        } else {
            slotStyle.left = '50%'
            slotStyle.transform = 'translateX(-50%)'
        }
        Object.assign(slot.style, slotStyle)

        const pixels = document.createElement('div'); pixels.className = 'pdf-img-wrapper'
        const loading = document.createElement('div')
        loading.className = 'pdf-page-loading'
        loading.textContent = '正在显示页面…'
        loading.setAttribute('role', 'status')
        pixels.append(loading)
        const highlights = document.createElement('div'); highlights.className = 'pdf-highlight-layer'
        const selection = document.createElement('div'); selection.className = 'pdf-native-selection-layer'
        const text = document.createElement('div'); text.className = 'pdf-text-layer'
        if (this.driver?.kind === 'mupdf') text.style.display = 'none'
        slot.append(pixels, highlights, selection, text)
        this._applyCropToSlot(page, slot)
        this.spacer.append(slot)
        this.activeSlots.set(page, slot)
        this._renderHighlightsForPage(page, highlights)
        this._renderNativePreviewForPage(page, selection)

        if (this._pendingPulse?.pageIdx === page) {
            const p = this._pendingPulse; this._pendingPulse = null
            queueMicrotask(() => this.pulseRects(p.pageIdx, p.rects))
        }
        if (this._pendingHighlightPulse?.pageIdx === page) {
            const p = this._pendingHighlightPulse; this._pendingHighlightPulse = null
            queueMicrotask(() => this.pulseHighlight(p.pageIdx, p.highlightId, p.fallbackRects))
        }

        this.options.onSlotMount?.(page, slot)
    }

    _scheduleRender(item) {
        this._renderQueue.push({
            page: item.page,
            slot: item.slot,
            token: item.token,
            tier: item.tier,
            distance: item.distance,
            signal: item.slot.renderAbort.signal,
        })
    }

    _pumpRenderQueue() {
        if (this._destroyed) return

        // 1. Filter out obsolete entries
        this._renderQueue = this._renderQueue.filter(x => {
            if (x.signal.aborted) return false
            const active = this.activeSlots.get(x.page)
            if (active !== x.slot) return false
            if (x.token !== x.slot._renderToken) return false
            return true
        })

        const totalActive = Math.max(this._activeDriverTasks.size, this._inFlightRenders.size)
        if (!this._renderQueue.length && totalActive === 0) return

        // 2. Re-compute visible boundaries to update tiers and distances dynamically
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const first = this._firstPageAt(top)
        let last = first
        for (let i = first; i < this.pageOffsets.length && this.pageOffsets[i].top <= bottom; i++) last = i

        for (const item of this._renderQueue) {
            if (item.page >= first && item.page <= last) {
                item.tier = 0
                item.distance = Math.abs(item.page - this.currentPage)
            } else {
                item.tier = 1
                item.distance = item.page < first ? (first - item.page) : (item.page - last)
            }
        }

        // An old visible render can become offscreen while the key is held.
        // Refresh its priority too, so it can yield to the newly visible page.
        for (const entry of this._inFlightRenders.values()) {
            entry.tier = entry.page >= first && entry.page <= last ? 0 : 1
            entry.distance = Math.abs(entry.page - this.currentPage)
        }

        // Sort: Tier 0 before Tier 1; then by distance ascending
        this._renderQueue.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier
            return a.distance - b.distance
        })

        // 2.5 Abort obsolete in-flight renders if newer token for the same page is queued
        for (const item of this._renderQueue) {
            const inflight = this._inFlightRenders.get(item.page)
            if (inflight && inflight.token < item.token && !inflight.abortController?.signal?.aborted) {
                inflight.abortController?.abort()
            }
        }

        // 3. Preemption: If capacity is full and a Tier 0 (visible) task is waiting,
        // abort an active Tier 1 (buffer) task so the visible page can start immediately
        // as soon as the driver yields.
        // NOTE: Cancellation signals request cooperative termination at the driver/C boundary.
        // The worker is not marked free until the driver task actually finishes or rejects,
        // preventing buffer overload and maintaining strict concurrency budgeting.
        if (totalActive >= this._renderConcurrency) {
            const hasWaitingTier0 = this._renderQueue.some(x => x.tier === 0)
            if (hasWaitingTier0) {
                let bufferToPreempt = null
                let maxDist = -1
                for (const inflight of this._inFlightRenders.values()) {
                    if (inflight.tier === 1 && inflight.distance > maxDist && !inflight.abortController?.signal?.aborted) {
                        maxDist = inflight.distance
                        bufferToPreempt = inflight
                    }
                }
                if (bufferToPreempt) {
                    const { page, slot, token, abortController } = bufferToPreempt
                    abortController?.abort()
                    if (this._inFlightRenders.get(page) === bufferToPreempt) {
                        this._inFlightRenders.delete(page)
                    }
                    slot.renderAbort = new AbortController()
                    this._renderQueue.push({
                        page, slot, token,
                        tier: 1,
                        distance: page < first ? (first - page) : (page - last),
                        signal: slot.renderAbort.signal,
                    })
                    this._renderQueue.sort((a, b) => (a.tier - b.tier) || (a.distance - b.distance))
                }
            }
        }

        // 4. Dispatch tasks up to concurrency limit of ACTUAL driver occupancy
        while (Math.max(this._activeDriverTasks.size, this._inFlightRenders.size) < this._renderConcurrency && this._renderQueue.length) {
            const item = this._renderQueue.shift()
            if (item.signal.aborted || this.activeSlots.get(item.page) !== item.slot || item.token !== item.slot._renderToken) {
                continue
            }

            const reqId = ++this._renderReqSeq
            const renderEntry = {
                id: reqId,
                page: item.page,
                slot: item.slot,
                token: item.token,
                tier: item.tier,
                distance: item.distance,
                abortController: item.slot.renderAbort,
            }

            this._inFlightRenders.set(item.page, renderEntry)
            this._activeDriverTasks.add(renderEntry)
            this._activeRenders = Math.max(this._activeDriverTasks.size, this._inFlightRenders.size)

            this._renderPageContent(item.page, item.slot, item.token, item.slot.renderAbort.signal, renderEntry).catch(() => {})
        }
    }

    _renderScale(page, forClippedViewport = false) {
        const size = this.pageSizes[page] || { width: 595, height: 842 }
        let scale = this.scale * Math.min(window.devicePixelRatio || 1, 2)
        if (forClippedViewport && this.driver?.kind === 'mupdf') {
            return scale
        }
        let w = size.width * scale, h = size.height * scale
        // Leave a rounding pixel for both PDF.js Canvas and MuPDF's rounded bbox.
        const edgeFactor = Math.min(1, (this.options.maxCanvasEdge - 2) / Math.max(w, h))
        const pixelFactor = Math.min(1, Math.sqrt((this.options.maxCanvasPixels * .99) / Math.max(1, w * h)))
        scale *= Math.min(edgeFactor, pixelFactor)
        return scale
    }

    _cacheKey(page, scale, clip) {
        const clipStr = clip ? `${clip[0]}_${clip[1]}_${clip[2]}_${clip[3]}` : 'full'
        return `${this._loadGeneration || 0}:${page}:${Math.round(scale * 100)}:${clipStr}`
    }

    _cacheCanvas(page, scale, clip, canvas) {
        if (!canvas || !canvas.width || !canvas.height) return
        const bytes = canvas.width * canvas.height * 4
        if (bytes > 16 * 1024 * 1024) return

        let cachedCanvas = null
        try {
            cachedCanvas = document.createElement('canvas')
            cachedCanvas.width = canvas.width
            cachedCanvas.height = canvas.height
            cachedCanvas.offsetX = canvas.offsetX || 0
            cachedCanvas.offsetY = canvas.offsetY || 0
            const ctx = cachedCanvas.getContext ? cachedCanvas.getContext('2d', { alpha: false }) : null
            if (ctx && ctx.drawImage) {
                ctx.drawImage(canvas, 0, 0)
            }
        } catch (_) {
            return
        }

        const key = this._cacheKey(page, scale, clip)
        if (this._bitmapCache.has(key)) {
            const old = this._bitmapCache.get(key)
            this._bitmapCacheBytes = Math.max(0, this._bitmapCacheBytes - (old.bytes || 0))
            if (old?.canvas) {
                try { old.canvas.width = 0; old.canvas.height = 0 } catch (e) {}
            }
            this._bitmapCache.delete(key)
        }
        while (this._bitmapCacheBytes + bytes > this._bitmapCacheLimitBytes && this._bitmapCache.size > 0) {
            let victimKey = null
            // Priority 1: Evict pages that are not current and not currently mounted in DOM
            for (const [k, entry] of this._bitmapCache) {
                if (entry.page === this.currentPage || this.activeSlots.has(entry.page)) continue
                victimKey = k
                break
            }
            // Priority 2: Evict mounted pages other than currentPage if needed
            if (!victimKey) {
                for (const [k, entry] of this._bitmapCache) {
                    if (entry.page === this.currentPage) continue
                    victimKey = k
                    break
                }
            }
            if (!victimKey) victimKey = this._bitmapCache.keys().next().value
            const victim = this._bitmapCache.get(victimKey)
            this._bitmapCacheBytes = Math.max(0, this._bitmapCacheBytes - (victim.bytes || 0))
            if (victim?.canvas) {
                try {
                    victim.canvas.width = 0
                    victim.canvas.height = 0
                } catch (e) {}
            }
            this._bitmapCache.delete(victimKey)
        }
        this._bitmapCache.set(key, { canvas: cachedCanvas, bytes, page, scale, clip, time: performance.now() })
        this._bitmapCacheBytes += bytes
    }

    _pruneBitmapCache(slackBytes = 0) {
        const target = Math.max(0, this._bitmapCacheLimitBytes - slackBytes)
        while (this._bitmapCacheBytes > target && this._bitmapCache.size > 0) {
            let victimKey = null
            for (const [k, entry] of this._bitmapCache) {
                if (entry.page === this.currentPage || this.activeSlots.has(entry.page)) continue
                victimKey = k
                break
            }
            if (!victimKey) {
                for (const [k, entry] of this._bitmapCache) {
                    if (entry.page === this.currentPage) continue
                    victimKey = k
                    break
                }
            }
            if (!victimKey) victimKey = this._bitmapCache.keys().next().value
            const victim = this._bitmapCache.get(victimKey)
            this._bitmapCacheBytes = Math.max(0, this._bitmapCacheBytes - (victim.bytes || 0))
            if (victim?.canvas) {
                try {
                    victim.canvas.width = 0
                    victim.canvas.height = 0
                } catch (e) {}
            }
            this._bitmapCache.delete(victimKey)
        }
    }

    async _renderPageContent(page, slot, token, signal, renderEntry = null) {
        if (!this.driver || signal.aborted || this._destroyed) return
        const activeRecord = renderEntry || { page, slot, token, abortController: slot.renderAbort }
        this._activeDriverTasks.add(activeRecord)
        this._activeRenders = Math.max(this._activeDriverTasks.size, this._inFlightRenders.size)
        const pixels = slot.querySelector('.pdf-img-wrapper')
        const text = slot.querySelector('.pdf-text-layer')
        const isCurrent = () => (
            !this._destroyed &&
            this.activeSlots.get(page) === slot &&
            !signal.aborted &&
            slot._renderToken === token &&
            Boolean(pixels)
        )

        try {
            const fullPageScale = this._renderScale(page, false)
            const unthrottledScale = this._renderScale(page, true)
            let scale = fullPageScale
            const priority = renderEntry?.tier ?? 0
            const generation = token

            // V1-B: Bounded 2D Viewport High-Res Clip Calculation
            // Uses uncapped Retina scale (`unthrottledScale`) when clipping is active so zoomed pages
            // (> 150% ~ 400%) render at full native sharpness without being downscaled by the full-page cap.
            let clip = null
            let requestedClip = null
            const size = this.pageSizes[page] || { width: 595, height: 842 }
            const candDevW = Math.round(size.width * unthrottledScale)
            const candDevH = Math.round(size.height * unthrottledScale)
            const totalPixels = candDevW * candDevH
            const threshold = this.options.clipPixelThreshold || 2_000_000
            const pageOffset = this.pageOffsets[page]

            if (this.options.enableClip !== false &&
                this.driver.kind === 'mupdf' &&
                priority === 0 &&
                pageOffset &&
                totalPixels >= threshold) {

                const vTop = this.scrollArea.scrollTop
                const vBottom = vTop + this.scrollArea.clientHeight
                const visTop = Math.max(0, vTop - pageOffset.top)
                const visBottom = Math.min(pageOffset.height, vBottom - pageOffset.top)
                const visHeight = visBottom - visTop
                const visRatioY = visHeight / Math.max(1, pageOffset.height)

                const sLeft = this.scrollArea.scrollLeft || 0
                const sWidth = this.scrollArea.clientWidth || pageOffset.width
                const pageLeft = pageOffset.left != null
                    ? pageOffset.left
                    : Math.max(0, ((this.scrollArea.scrollWidth || pageOffset.width) - pageOffset.width) * 0.5)
                const visLeft = Math.max(0, sLeft - pageLeft)
                const visRight = Math.min(pageOffset.width, sLeft + sWidth - pageLeft)
                const visWidth = Math.max(0, visRight - visLeft)
                const visRatioX = visWidth / Math.max(1, pageOffset.width)

                const needsClip = (visRatioY < 0.85 || visRatioX < 0.90 || unthrottledScale > fullPageScale * 1.02) && visHeight > 0
                if (needsClip) {
                    const bleedY = Math.round(this.scrollArea.clientHeight * 0.35)
                    const bleedX = Math.round(sWidth * 0.25)
                    let cssY0 = Math.max(0, visTop - bleedY)
                    let cssY1 = Math.min(pageOffset.height, visBottom + bleedY)
                    let cssX0 = visRatioX < 0.95 ? Math.max(0, visLeft - bleedX) : 0
                    let cssX1 = visRatioX < 0.95 ? Math.min(pageOffset.width, visRight + bleedX) : pageOffset.width

                    const GRID_STEP = 64
                    cssY0 = Math.floor(cssY0 / GRID_STEP) * GRID_STEP
                    cssY1 = Math.min(pageOffset.height, Math.ceil(cssY1 / GRID_STEP) * GRID_STEP)
                    cssX0 = Math.floor(cssX0 / GRID_STEP) * GRID_STEP
                    cssX1 = Math.min(pageOffset.width, Math.ceil(cssX1 / GRID_STEP) * GRID_STEP)

                    // Clamp scale only if the clipped 2D window itself would exceed maxCanvasEdge / maxCanvasPixels
                    const clipCssW = Math.max(1, cssX1 - cssX0)
                    const clipCssH = Math.max(1, cssY1 - cssY0)
                    let clipScale = unthrottledScale
                    const rawClipDevW = clipCssW * (clipScale / this.scale)
                    const rawClipDevH = clipCssH * (clipScale / this.scale)
                    const edgeFactor = Math.min(1, (this.options.maxCanvasEdge - 2) / Math.max(1, rawClipDevW, rawClipDevH))
                    const pixelFactor = Math.min(1, Math.sqrt((this.options.maxCanvasPixels * 0.98) / Math.max(1, rawClipDevW * rawClipDevH)))
                    clipScale *= Math.min(edgeFactor, pixelFactor)

                    const fullDevW = Math.round(size.width * clipScale)
                    const fullDevH = Math.round(size.height * clipScale)
                    const cssToDev = clipScale / this.scale
                    const devX0 = Math.max(0, Math.floor(cssX0 * cssToDev))
                    const devY0 = Math.max(0, Math.floor(cssY0 * cssToDev))
                    const devX1 = Math.min(fullDevW, Math.ceil(cssX1 * cssToDev))
                    const devY1 = Math.min(fullDevH, Math.ceil(cssY1 * cssToDev))

                    if (devY1 - devY0 >= 64 && devX1 - devX0 >= 64 && devY1 <= fullDevH && devX1 <= fullDevW) {
                        scale = clipScale
                        clip = [devX0, devY0, devX1, devY1]
                        requestedClip = { left: cssX0, right: cssX1, top: cssY0, bottom: cssY1, devX0, devY0, devX1, devY1 }
                    }
                }
            }

            // A new slot needs one complete raster, rather than a serial preview
            // plus a second high-resolution request. Retained full-page canvases
            // cover scrolling immediately; later zooms may refine with a clip.
            if (clip && !pixels.querySelector('.pdf-page-canvas, .pdf-page-preview')) {
                clip = null
                requestedClip = null
                scale = fullPageScale
            }

            if (!isCurrent()) return

            let canvas = null
            const cacheKey = this._cacheKey(page, scale, clip)
            const cached = this._bitmapCache.get(cacheKey)
            if (cached && cached.canvas && cached.canvas.width > 0 && cached.canvas.height > 0 && !clip) {
                canvas = document.createElement('canvas')
                canvas.width = cached.canvas.width
                canvas.height = cached.canvas.height
                canvas.offsetX = cached.canvas.offsetX || 0
                canvas.offsetY = cached.canvas.offsetY || 0
                canvas.dataset.offsetX = String(canvas.offsetX)
                canvas.dataset.offsetY = String(canvas.offsetY)
                const ctx = canvas.getContext ? canvas.getContext('2d', { alpha: false }) : null
                if (ctx && ctx.drawImage) {
                    ctx.drawImage(cached.canvas, 0, 0)
                }
                cached.time = performance.now()
                this._bitmapCache.delete(cacheKey)
                this._bitmapCache.set(cacheKey, cached)
            } else {
                if (cached) {
                    this._bitmapCache.delete(cacheKey)
                    this._bitmapCacheBytes = Math.max(0, this._bitmapCacheBytes - (cached.bytes || 0))
                }
                try {
                    canvas = await this.driver.renderPage(page, scale, signal, clip, priority, generation)
                } catch (err) {
                    if (clip && !signal.aborted && !/abort/i.test(String(err))) {
                        console.warn('[PdfViewport] clipped render failed, falling back to full-page render:', err)
                        clip = null
                        requestedClip = null
                        canvas = await this.driver.renderPage(page, scale, signal, null, priority, generation)
                    } else {
                        throw err
                    }
                }
                if (!clip && canvas) {
                    this._cacheCanvas(page, scale, clip, canvas)
                }
            }

            if (!isCurrent()) return

            const cssToDev = scale / this.scale

            if (!clip) {
                // Full page render
                pixels.querySelector('.pdf-page-loading')?.remove()
                canvas.classList.add('pdf-page-canvas')
                canvas.style.position = 'absolute'
                canvas.style.inset = '0'
                canvas.style.width = '100%'
                canvas.style.height = '100%'
                pixels.replaceChildren(canvas)
                slot._renderedClip = null
            } else {
                // Clipped render with 2D preview handover
                pixels.querySelector('.pdf-page-loading')?.remove()
                canvas.classList.add('pdf-clip-canvas')
                const cssLeft = (canvas.offsetX ?? 0) / cssToDev
                const cssTop = (canvas.offsetY ?? 0) / cssToDev
                const cssWidth = canvas.width / cssToDev
                const cssHeight = canvas.height / cssToDev
                canvas.style.position = 'absolute'
                canvas.style.left = `${cssLeft}px`
                canvas.style.top = `${cssTop}px`
                canvas.style.width = `${cssWidth}px`
                canvas.style.height = `${cssHeight}px`
                canvas.style.filter = 'var(--pdf-page-filter,var(--reader-img-filter,none))'
                canvas.style.pointerEvents = 'none'
                canvas.style.zIndex = '3'

                const existingPageCanvas = pixels.querySelector('.pdf-page-canvas, .pdf-page-preview')
                if (existingPageCanvas) {
                    existingPageCanvas.className = 'pdf-page-preview'
                    existingPageCanvas.style.zIndex = '1'
                }

                // Any older retained clips get zIndex = 2 so newest clip (zIndex = 3) always renders on top
                const existingClips = [...pixels.querySelectorAll('.pdf-clip-canvas')]
                for (const old of existingClips) {
                    old.style.zIndex = '2'
                    const oldLeft = parseFloat(old.style.left) || 0
                    const oldTop = parseFloat(old.style.top) || 0
                    const oldWidth = parseFloat(old.style.width) || 0
                    const oldHeight = parseFloat(old.style.height) || 0
                    const oldRight = oldLeft + oldWidth
                    const oldBottom = oldTop + oldHeight
                    const newRight = cssLeft + cssWidth
                    const newBottom = cssTop + cssHeight
                    if (oldLeft >= cssLeft && oldRight <= newRight && oldTop >= cssTop && oldBottom <= newBottom) {
                        old.remove()
                    }
                }

                // Keep at most 2 active clip canvases to prevent DOM buildup while maintaining scroll continuity
                const remainingClips = [...pixels.querySelectorAll('.pdf-clip-canvas')]
                while (remainingClips.length >= 2) {
                    remainingClips.shift()?.remove()
                }

                if (typeof pixels.prepend === 'function') pixels.prepend(canvas)
                else if (pixels.children?.unshift) { pixels.children.unshift(canvas); canvas.parentElement = pixels }
                else pixels.append(canvas)

                slot._renderedClip = {
                    left: requestedClip ? requestedClip.left : cssLeft,
                    right: requestedClip ? requestedClip.right : (cssLeft + cssWidth),
                    top: requestedClip ? requestedClip.top : cssTop,
                    bottom: requestedClip ? requestedClip.bottom : (cssTop + cssHeight),
                    scale: this.scale
                }
            }

            slot._renderedScale = this.scale
            slot._renderedToken = token
            if (page === this._initialTargetPage && canvas?.width > 0 && canvas?.height > 0 && isCurrent()) {
                this.options.onInitialPageRendered?.({ page, canvas, slot })
            }

            // Remove retry badge if previously shown
            slot.querySelector('.pdf-render-retry-badge')?.remove()

            // Restore text layer visibility & pointer events
            if (text) {
                text.style.opacity = '1'
                text.style.pointerEvents = 'auto'
            }

            // Raster gets the document worker first. Selection still requests
            // geometry immediately on pointerdown; this merely warms it later.
            if (this.driver.kind === 'mupdf' && page === this.currentPage) {
                const warm = () => { if (isCurrent()) this._ensureNativeGeometry(page).catch(() => {}) }
                clearTimeout(slot.geometryTimer)
                slot.geometryTimer = setTimeout(() => {
                    if (performance.now() - (this._lastScrollEventTs || 0) < 160) return
                    warm()
                }, 180)
            }

            if (this.driver.kind === 'pdfjs' && this.driver.renderTextLayer) {
                await this.driver.renderTextLayer(page, text, this.scale, signal)
            }
            if (this.driver.getLinks) {
                this.driver.getLinks(page).then(links => {
                    if (!isCurrent() || !links?.length) return
                    this._renderLinksForPage(page, slot, links)
                }).catch(() => {})
            }
            if (isCurrent() && page === this.currentPage && !this._outlineRequested && this.options.loadOutline !== false && this.driver.getOutline) {
                this._outlineRequested = true
                const generation = this._loadGeneration
                this._outlineTimer = setTimeout(() => {
                    this._outlineTimer = null
                    if (this._destroyed || generation !== this._loadGeneration) return
                    this.driver.getOutline().then(toc => {
                        if (!this._destroyed && generation === this._loadGeneration) this.options.onOutline?.(toc || [])
                    }).catch(err => console.warn('[PDF] outline unavailable:', err))
                }, 0)
            }
        } catch (err) {
            if (signal.aborted || err?.name === 'AbortError') return
            console.warn(`[PdfViewport] render failed page=${page} backend=${this.driver?.kind}:`, err)
            if (isCurrent()) {
                const hasExistingCanvas = pixels.querySelector('canvas')
                if (!hasExistingCanvas) {
                    const box = document.createElement('div')
                    box.className = 'pdf-render-error'
                    box.textContent = `第 ${page + 1} 页渲染失败。滚动离开后返回将自动重试。`
                    pixels.replaceChildren(box)
                } else {
                    let retryBadge = slot.querySelector('.pdf-render-retry-badge')
                    if (!retryBadge) {
                        retryBadge = document.createElement('div')
                        retryBadge.className = 'pdf-render-retry-badge'
                        retryBadge.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(220,38,38,0.85);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;z-index:6;cursor:pointer;'
                        retryBadge.textContent = '重试高清渲染'
                        retryBadge.onclick = () => {
                            retryBadge.remove()
                            slot._renderToken = (slot._renderToken || 0) + 1
                            this._scheduleRender({
                                page, slot, token: slot._renderToken, tier: 0, distance: 0
                            })
                            this._pumpRenderQueue()
                        }
                        slot.append(retryBadge)
                    }
                }
            }
        } finally {
            this._activeDriverTasks.delete(activeRecord)
            if (this._inFlightRenders.get(page) === activeRecord) {
                this._inFlightRenders.delete(page)
            }
            this._activeRenders = Math.max(this._activeDriverTasks.size, this._inFlightRenders.size)
            this._pumpRenderQueue()
        }
    }

    async getPageLinks(page) {
        if (!this.driver?.getLinks || this._destroyed) return []
        try {
            return await this.driver.getLinks(page)
        } catch {
            return []
        }
    }

    _renderLinksForPage(page, slot, links) {
        let linksLayer = slot.querySelector('.pdf-links-layer')
        if (!linksLayer) {
            linksLayer = document.createElement('div')
            linksLayer.className = 'pdf-links-layer'
            linksLayer.style.position = 'absolute'
            linksLayer.style.inset = '0'
            linksLayer.style.pointerEvents = 'none'
            linksLayer.style.zIndex = '4'
            slot.append(linksLayer)
        }
        linksLayer.replaceChildren()
        const size = this.pageSizes[page] || { width: 595, height: 842 }
        for (const link of links) {
            if (!link.rect) continue
            const [r0, r1, r2, r3] = link.rect
            const minX = Math.min(r0, r2), maxX = Math.max(r0, r2)
            let minY = Math.min(r1, r3), maxY = Math.max(r1, r3)
            let topNorm = minY / size.height
            let heightNorm = (maxY - minY) / size.height
            if (this.driver?.kind === 'pdfjs') {
                topNorm = (size.height - maxY) / size.height
            }
            const a = document.createElement('a')
            a.className = 'pdf-link-annot'
            a.style.position = 'absolute'
            a.style.left = `${(minX / size.width) * 100}%`
            a.style.top = `${topNorm * 100}%`
            a.style.width = `${((maxX - minX) / size.width) * 100}%`
            a.style.height = `${heightNorm * 100}%`
            a.style.cursor = 'pointer'
            a.style.pointerEvents = 'auto'
            if (link.uri) {
                a.href = link.uri
                a.title = link.uri
            } else if (link.page != null) {
                a.href = `#page=${link.page + 1}`
                a.title = `跳转至第 ${link.page + 1} 页`
            }
            a.addEventListener('click', e => {
                e.preventDefault()
                e.stopPropagation()
                if (link.page != null) {
                    this.scrollToPage(link.page)
                } else if (link.uri) {
                    if (this.options.onLinkClick) {
                        this.options.onLinkClick(link.uri)
                    } else if (typeof platformBridge !== 'undefined' && platformBridge.openExternal) {
                        platformBridge.openExternal(link.uri)
                    } else {
                        window.open(link.uri, '_blank')
                    }
                }
            })
            linksLayer.append(a)
        }
    }

    _highlightSegment(hl, page) {
        const target = hl?.pdfTarget
        if (!target) return null
        if (Array.isArray(target.segments)) return target.segments.find(x => x.page === page) || null
        return target.page === page ? target : null
    }

    _renderHighlightsForPage(page, layer) {
        layer.replaceChildren()
        const highlights = this.highlightsByPage.get(page) || []
        if (!highlights.length) return

        const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
        let svg = null
        const ensureSvg = () => {
            if (svg) return svg
            svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            const x0 = size.x0 || 0, y0 = size.y0 || 0
            svg.setAttribute('viewBox', `${x0} ${y0} ${size.width} ${size.height}`)
            svg.setAttribute('class', 'pdf-highlight-svg')
            Object.assign(svg.style, {
                position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none'
            })
            layer.append(svg)
            return svg
        }

        for (const hl of highlights) {
            const segment = this._highlightSegment(hl, page)
            if (!segment) continue
            const color = hl.color || '#facc15'
            const style = hl.style || 'highlight'

            // Prefer accurate page-space quads when present
            if (segment.quads && segment.quads.length > 0) {
                const s = ensureSvg()
                for (const q of segment.quads) {
                    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
                    poly.setAttribute('points', `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`)
                    poly.setAttribute('class', `pdf-highlight-poly pdf-style-${style}`)
                    poly.dataset.id = hl.id
                    poly.style.pointerEvents = 'auto'
                    poly.style.cursor = 'pointer'

                    if (style === 'underline') {
                        poly.setAttribute('fill', 'transparent')
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
                        line.setAttribute('x1', q[4]); line.setAttribute('y1', q[5])
                        line.setAttribute('x2', q[6]); line.setAttribute('y2', q[7])
                        line.setAttribute('stroke', color)
                        line.setAttribute('stroke-width', '2.5')
                        line.setAttribute('stroke-linecap', 'round')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else if (style === 'dashed') {
                        poly.setAttribute('fill', 'transparent')
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
                        line.setAttribute('x1', q[4]); line.setAttribute('y1', q[5])
                        line.setAttribute('x2', q[6]); line.setAttribute('y2', q[7])
                        line.setAttribute('stroke', color === '#facc15' ? '#64748b' : color)
                        line.setAttribute('stroke-width', '2')
                        line.setAttribute('stroke-dasharray', '4,3')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else if (style === 'strikethrough') {
                        poly.setAttribute('fill', 'transparent')
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
                        const mx1 = (q[0] + q[4]) / 2, my1 = (q[1] + q[5]) / 2
                        const mx2 = (q[2] + q[6]) / 2, my2 = (q[3] + q[7]) / 2
                        line.setAttribute('x1', mx1); line.setAttribute('y1', my1)
                        line.setAttribute('x2', mx2); line.setAttribute('y2', my2)
                        line.setAttribute('stroke', color)
                        line.setAttribute('stroke-width', '2')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else if (style === 'squiggly') {
                        poly.setAttribute('fill', 'transparent')
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
                        line.setAttribute('x1', q[4]); line.setAttribute('y1', q[5])
                        line.setAttribute('x2', q[6]); line.setAttribute('y2', q[7])
                        line.setAttribute('stroke', color)
                        line.setAttribute('stroke-width', '2')
                        line.setAttribute('stroke-dasharray', '2,2')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else {
                        poly.setAttribute('fill', this._toRgba(color, 0.38))
                    }

                    poly.addEventListener('click', e => {
                        e.stopPropagation()
                        this.options.onHighlightClick?.(hl, e, poly.getBoundingClientRect())
                    })
                    s.append(poly)
                }
            } else if (segment.rects && segment.rects.length > 0) {
                // Backwards compatibility for legacy rect-only annotations
                for (const rect of segment.rects) {
                    const [x1, y1, x2, y2] = rect
                    const el = document.createElement('div')
                    el.className = `pdf-highlight-rect pdf-style-${style}`
                    el.dataset.id = hl.id
                    Object.assign(el.style, {
                        left: `${x1 * 100}%`, top: `${y1 * 100}%`,
                        width: `${Math.max(0, x2 - x1) * 100}%`, height: `${Math.max(0, y2 - y1) * 100}%`,
                    })
                    if (style === 'underline') el.style.borderBottom = `2.5px solid ${color}`
                    else if (style === 'dashed') el.style.borderBottom = `2px dashed ${color === '#facc15' ? '#64748b' : color}`
                    else if (style === 'strikethrough') { el.style.borderBottom = `2px solid ${color}`; el.style.height = `${Math.max(0, y2 - y1) * 50}%` }
                    else if (style === 'squiggly') { el.style.borderBottom = `2px dotted ${color}` }
                    else el.style.backgroundColor = this._toRgba(color, .38)
                    el.addEventListener('click', e => { e.stopPropagation(); this.options.onHighlightClick?.(hl, e, el.getBoundingClientRect()) })
                    layer.append(el)
                }
            }
        }
    }

    _toRgba(color, alpha = .38) {
        if (!color) return `rgba(250, 204, 21, ${alpha})`
        if (color.startsWith('rgba')) return color
        if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
        const named = { yellow:[250, 204, 21], green:[34, 197, 94], blue:[59, 130, 246], pink:[236, 72, 153], purple:[168, 85, 247], red:[239, 68, 68], orange:[249, 115, 22], gray:[148, 163, 184] }
        if (named[color.toLowerCase?.()]) return `rgba(${named[color.toLowerCase()].join(', ')}, ${alpha})`
        if (/^#[0-9a-f]{3,6}$/i.test(color)) {
            let c = color.slice(1); if (c.length === 3) c = c.split('').map(x => x + x).join('')
            const n = parseInt(c, 16); return `rgba(${n>>16&255}, ${n>>8&255}, ${n&255}, ${alpha})`
        }
        return color
    }

    _handleDomSelection() {
        if (this.interactionMode === 'draw') return
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) return
        const range = sel.getRangeAt(0), text = sel.toString().trim()
        if (!text) return
        const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
        const slot = node?.closest?.('.pdf-page-slot')
        if (!slot) return
        const page = Number(slot.dataset.page), slotRect = slot.getBoundingClientRect()
        const clientRects = [...range.getClientRects()].filter(r => r.width > .5 && r.height > .5)
        if (!clientRects.length) return
        const rects = clientRects.map(r => [
            clamp((r.left - slotRect.left) / slotRect.width, 0, 1),
            clamp((r.top - slotRect.top) / slotRect.height, 0, 1),
            clamp((r.right - slotRect.left) / slotRect.width, 0, 1),
            clamp((r.bottom - slotRect.top) / slotRect.height, 0, 1),
        ])
        const first = clientRects[0]
        this.options.onSelection?.({ page, text, rects, clientRect: { top:first.top,left:first.left,width:first.width,height:first.height } })
    }

    _touchNativeGeometry(page) {
        this._nativeGeometryUse.set(page, performance.now())
        if (this._nativeGeometry.size <= this._nativeGeometryLimit) return
        const protectedPages = new Set([this.currentPage])
        for (const p of this.activeSlots.keys()) protectedPages.add(p)
        const candidates = [...this._nativeGeometryUse.entries()]
            .filter(([p]) => !protectedPages.has(p))
            .sort((a, b) => a[1] - b[1])
        while (this._nativeGeometry.size > this._nativeGeometryLimit && candidates.length) {
            const [victim] = candidates.shift()
            this._nativeGeometry.delete(victim)
            this._nativeGeometryUse.delete(victim)
        }
    }

    async _ensureNativeGeometry(page) {
        if (this.driver?.kind !== 'mupdf') return null
        if (this._nativeGeometry.has(page)) {
            this._touchNativeGeometry(page)
            return this._nativeGeometry.get(page)
        }
        const promise = this.driver.getTextGeometry(page).then(chars => {
            if ((!chars || chars.length === 0) && this._pageOcrData?.has(page)) {
                chars = this._pageOcrData.get(page) || []
            }
            const cellSize = 48, grid = new Map()
            const boxes = chars.map((ch, index) => {
                const b = quadBounds(ch.quad), box = { ...ch, index, bounds: b }
                const x0 = Math.floor(b[0] / cellSize), x1 = Math.floor(b[2] / cellSize)
                const y0 = Math.floor(b[1] / cellSize), y1 = Math.floor(b[3] / cellSize)
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const key = `${x}:${y}`
                    if (!grid.has(key)) grid.set(key, [])
                    grid.get(key).push(index)
                }
                return box
            })
            return { chars: boxes, grid, cellSize }
        }).catch(err => {
            this._nativeGeometry.delete(page)
            this._nativeGeometryUse.delete(page)
            throw err
        })
        this._nativeGeometry.set(page, promise)
        this._touchNativeGeometry(page)
        return promise
    }

    /**
     * F11 & M08: Attach OCR synthesized character layer for scanned PDF page
     * @param {number} page 0-based page index
     * @param {Array<{ text: string, rect?: number[], x?: number, y?: number, w?: number, h?: number, line?: number }>} ocrSpans
     */
    setPageOcrData(page, ocrSpans) {
        if (!this._pageOcrData) this._pageOcrData = new Map()
        const chars = []
        let lineIdx = 0
        for (const span of ocrSpans || []) {
            const text = span.text || ''
            if (!text) continue
            const [x0, y0, x1, y1] = span.rect || [span.x || 0, span.y || 0, (span.x || 0) + (span.w || 10), (span.y || 0) + (span.h || 10)]
            const totalW = Math.max(1, x1 - x0)
            const charW = totalW / Math.max(1, text.length)
            for (let i = 0; i < text.length; i++) {
                const cx0 = x0 + i * charW
                const cx1 = cx0 + charW
                chars.push({
                    text: text[i],
                    line: span.line ?? lineIdx,
                    size: y1 - y0,
                    quad: [cx0, y0, cx1, y0, cx0, y1, cx1, y1]
                })
            }
            lineIdx++
        }
        this._pageOcrData.set(page, chars)
        this._nativeGeometry.delete(page)
        this._nativeGeometryUse.delete(page)

        const slot = this.activeSlots?.get(page)
        if (slot) {
            const textLayer = slot.querySelector('.pdf-text-layer')
            if (textLayer) {
                textLayer.replaceChildren()
                textLayer.style.display = 'block'
                for (const span of ocrSpans || []) {
                    const spanEl = document.createElement('span')
                    spanEl.textContent = span.text || ''
                    const [x0, y0, x1, y1] = span.rect || [span.x || 0, span.y || 0, (span.x || 0) + (span.w || 10), (span.y || 0) + (span.h || 10)]
                    spanEl.style.position = 'absolute'
                    spanEl.style.left = `${x0}px`
                    spanEl.style.top = `${y0}px`
                    spanEl.style.width = `${Math.max(1, x1 - x0)}px`
                    spanEl.style.height = `${Math.max(1, y1 - y0)}px`
                    spanEl.style.fontSize = `${Math.max(8, y1 - y0)}px`
                    spanEl.style.color = 'transparent'
                    spanEl.style.userSelect = 'text'
                    textLayer.appendChild(spanEl)
                }
            }
        }
    }

    clearPageOcrData(page = null) {
        if (!this._pageOcrData) return
        if (page !== null) {
            this._pageOcrData.delete(page)
            this._nativeGeometry.delete(page)
            this._nativeGeometryUse.delete(page)
        } else {
            this._pageOcrData.clear()
            this._nativeGeometry.clear()
            this._nativeGeometryUse.clear()
        }
    }

    _slotForPoint(x, y) {
        let nearest = null, best = Infinity
        for (const [page, slot] of this.activeSlots) {
            const r = slot.getBoundingClientRect()
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { page, slot, rect: r }
            const d = Math.max(r.top - y, y - r.bottom, 0) + Math.max(r.left - x, x - r.right, 0)
            if (d < best) { best = d; nearest = { page, slot, rect: r } }
        }
        return best < 80 ? nearest : null
    }

    _clientToPage(hit, x, y) {
        const size = this.pageSizes[hit.page] || { width: 595, height: 842, x0: 0, y0: 0 }
        const margins = this._getCropMarginsForPage(hit.page)
        const normX = clamp((x - hit.rect.left) / hit.rect.width, 0, 1)
        const normY = clamp((y - hit.rect.top) / hit.rect.height, 0, 1)
        const origXFraction = margins.left / 100 + normX * (1 - (margins.left + margins.right) / 100)
        const origYFraction = margins.top / 100 + normY * (1 - (margins.top + margins.bottom) / 100)
        return [
            (size.x0 || 0) + origXFraction * size.width,
            (size.y0 || 0) + origYFraction * size.height,
        ]
    }

    async _hitNativeChar(page, point, maxDist = 16) {
        const geom = await this._ensureNativeGeometry(page)
        if (!geom?.chars?.length) return null
        const { chars, grid, cellSize } = geom
        const effMaxDist = (this.scale && this.scale > 0 && maxDist > 0) ? (maxDist / this.scale) : maxDist
        const gx = Math.floor(point[0] / cellSize), gy = Math.floor(point[1] / cellSize)
        const cellRadius = Math.ceil(effMaxDist / cellSize) + 1
        const ids = new Set()
        for (let dy = -cellRadius; dy <= cellRadius; dy++) {
            for (let dx = -cellRadius; dx <= cellRadius; dx++) {
                for (const id of grid.get(`${gx+dx}:${gy+dy}`) || []) ids.add(id)
            }
        }
        if (!ids.size) return null
        const candidates = [...ids].map(i => chars[i]).filter(ch => ch && ch.quad && quadArea(ch.quad) >= 1e-4)
        let best = null, dist = Infinity
        const maxDistSq = effMaxDist * effMaxDist
        for (const ch of candidates) {
            const d = pointToQuadDistanceSq(point[0], point[1], ch.quad)
            if (d <= maxDistSq && d < dist) {
                dist = d
                best = ch
            }
        }
        return best
    }

    async _nativePointerDown(e) {
        if (this.interactionMode === 'draw' || this.driver?.kind !== 'mupdf' || e.button !== 0) return
        const epoch = ++this._nativeGestureEpoch
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) {
            if (this._nativePreview?.length) this.clearSelection()
            return
        }
        const isInsideSlot = e.clientX >= hit.rect.left && e.clientX <= hit.rect.right &&
            e.clientY >= hit.rect.top && e.clientY <= hit.rect.bottom
        if (!isInsideSlot) {
            if (this._nativePreview?.length) this.clearSelection()
            return
        }
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const ch = await this._hitNativeChar(hit.page, point, 16)
        if (!ch || epoch !== this._nativeGestureEpoch || this.interactionMode === 'draw') {
            if (this._nativePreview?.length) this.clearSelection()
            return
        }
        this._nativeDrag = {
            pointerId: e.pointerId,
            epoch,
            startX: e.clientX,
            startY: e.clientY,
            lastClientX: e.clientX,
            lastClientY: e.clientY,
            moveSeq: 0,
            appliedMoveSeq: 0,
            pendingHitPromise: null,
            hasMoved: false,
            anchor: { page: hit.page, index: ch.index, point },
            focus: { page: hit.page, index: ch.index, point }
        }
    }

    async _nativePointerMove(e) {
        if (this.interactionMode === 'draw') return
        const drag = this._nativeDrag
        if (!drag || e.pointerId !== drag.pointerId) return
        if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
            this._cancelNativeDrag()
            return
        }
        if (e.pointerType === 'mouse' && e.buttons !== 1) {
            this._cancelNativeDrag()
            return
        }
        if (!drag.hasMoved) {
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
                drag.hasMoved = true
                try { this.scrollArea.setPointerCapture?.(e.pointerId) } catch (_) {}
            } else {
                return
            }
        }
        drag.lastClientX = e.clientX
        drag.lastClientY = e.clientY
        const moveSeq = (drag.moveSeq = (drag.moveSeq || 0) + 1)
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const hitPromise = this._hitNativeChar(hit.page, point, 36)
        drag.pendingHitPromise = hitPromise
        let ch = null
        try {
            ch = await hitPromise
        } finally {
            if (drag.pendingHitPromise === hitPromise) drag.pendingHitPromise = null
        }
        if (!ch || this._nativeDrag !== drag || drag.epoch !== this._nativeGestureEpoch || this.interactionMode === 'draw') return
        if (drag.appliedMoveSeq && moveSeq <= drag.appliedMoveSeq) return
        drag.appliedMoveSeq = moveSeq
        drag.focus = { page: hit.page, index: ch.index, point }
        this._updateNativePreview()
    }

    async _nativePointerUp(e) {
        const drag = this._nativeDrag
        if (!drag || e.pointerId !== drag.pointerId) return
        const gestureEpoch = drag.epoch
        try { this.scrollArea.releasePointerCapture?.(e.pointerId) } catch (_) {}

        // Incorporate latest move sample if still pending
        if (drag.pendingHitPromise) {
            try { await drag.pendingHitPromise } catch (_) {}
        }
        // Always sample final release position if coordinates provided
        if (e.clientX != null && e.clientY != null && (e.clientX !== drag.lastClientX || e.clientY !== drag.lastClientY)) {
            const hit = this._slotForPoint(e.clientX, e.clientY)
            if (hit) {
                const point = this._clientToPage(hit, e.clientX, e.clientY)
                const ch = await this._hitNativeChar(hit.page, point, 36).catch(() => null)
                if (ch && drag.epoch === this._nativeGestureEpoch) {
                    drag.focus = { page: hit.page, index: ch.index, point }
                }
            }
        }

        if (this._destroyed || this._nativeDrag !== drag || drag.epoch !== this._nativeGestureEpoch) return
        this._nativeDrag = null
        this._nativeGestureEpoch++

        if (this.interactionMode === 'draw') {
            this._nativePreview = null
            this._redrawNativePreview()
            return
        }
        const isSameChar = drag.anchor.page === drag.focus.page && drag.anchor.index === drag.focus.index
        if (!drag.hasMoved || isSameChar) {
            if (this._nativePreview?.length) this.clearSelection()
            return
        }
        const selection = await this._finalizeNativeSelection(drag.anchor, drag.focus, 'char').catch(err => {
            console.warn('[PDF] native selection failed:', err); return null
        })
        if (selection && !this._destroyed && this.interactionMode !== 'draw' && gestureEpoch === this._nativeGestureEpoch - 1) {
            this._emitNativeSelection(selection)
        }
    }

    _cancelNativeDrag() {
        this._nativeGestureEpoch++
        if (this._nativeDrag?.pointerId != null) {
            try { this.scrollArea.releasePointerCapture?.(this._nativeDrag.pointerId) } catch (_) {}
        }
        this._nativeDrag = null
        this.clearSelection()
    }

    clearSelection() {
        if (this._isClearingSelection) return
        this._isClearingSelection = true
        this._nativeGestureEpoch++
        try {
            const hadSelection = Boolean(this._nativePreview?.length)
            if (hadSelection) {
                this._selectionDismissedTime = performance.now()
            }
            this._nativePreview = null
            this._redrawNativePreview()
            try { window.getSelection()?.removeAllRanges?.() } catch (_) {}
            if (hadSelection) {
                this.options.onSelectionClear?.()
            }
        } finally {
            this._isClearingSelection = false
        }
    }

    async _nativeDoubleClick(e) {
        if (this.interactionMode === 'draw' || this.driver?.kind !== 'mupdf') return
        const epoch = ++this._nativeGestureEpoch
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const ch = await this._hitNativeChar(hit.page, point, 16)
        if (!ch || epoch !== this._nativeGestureEpoch || this.interactionMode === 'draw') return
        e.preventDefault()
        const selection = await this._finalizeNativeSelection(
            { page: hit.page, index: ch.index, point }, { page: hit.page, index: ch.index, point }, 'word')
        if (selection && epoch === this._nativeGestureEpoch && this.interactionMode !== 'draw') {
            this._emitNativeSelection(selection)
        }
    }

    _handleTouchStart(e) {
        if (!e.touches) return
        if (e.touches.length === 2) {
            clearTimeout(this._singleTapTimer)
            this._singleTouchStart = null
            this._ignoreClickUntil = performance.now() + 500
            // Cancel any pending native drag or text selection
            this._cancelNativeDrag()
            try { window.getSelection()?.removeAllRanges?.() } catch (_) {}
            const t0 = e.touches[0], t1 = e.touches[1]
            const d0 = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
            const C0 = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }
            const s0 = this.scale

            // Anchor point relative to current page slot
            const hit = this._slotForPoint(C0.x, C0.y) || {
                page: this.currentPage,
                slot: this.activeSlots.get(this.currentPage)
            }
            const anchor = this._captureZoomAnchor(C0.x, C0.y, hit.page ?? this.currentPage)

            this._pinch = {
                d0: Math.max(10, d0),
                s0,
                C0,
                currentCenter: C0,
                currentScale: s0,
                ...anchor,
                originX: this.scrollArea.scrollLeft + anchor.viewX,
                originY: this.scrollArea.scrollTop + anchor.viewY,
                rafPending: false
            }
            if (e.cancelable) e.preventDefault()
        } else if (e.touches.length === 1) {
            if (this._pinch) {
                this._cancelPinch()
            }
            const touch = e.touches[0]
            this._singleTouchStart = {
                time: performance.now(),
                x: touch.clientX,
                y: touch.clientY,
                moved: false
            }
        } else {
            if (this._pinch) this._cancelPinch()
        }
    }

    _handleTouchMove(e) {
        if (!e.touches) return
        if (this._singleTouchStart && e.touches.length === 1) {
            const touch = e.touches[0]
            if (Math.hypot(touch.clientX - this._singleTouchStart.x, touch.clientY - this._singleTouchStart.y) > 24) {
                this._singleTouchStart.moved = true
                this._ignoreClickUntil = performance.now() + 450
            }
        }
        if (this._pinch && e.touches.length === 2) {
            if (e.cancelable) e.preventDefault()
            const t0 = e.touches[0], t1 = e.touches[1]
            const d = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
            const C = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }
            const scaleFactor = d / this._pinch.d0
            const nextScale = clamp(this._pinch.s0 * scaleFactor, this.options.minScale, this.options.maxScale)
            this._pinch.currentScale = nextScale
            this._pinch.currentCenter = C

            // Throttle visual preview to 1 animation frame
            if (!this._pinch.rafPending) {
                this._pinch.rafPending = true
                requestAnimationFrame(() => {
                    if (!this._pinch) return
                    this._pinch.rafPending = false
                    const ratio = this._pinch.currentScale / this._pinch.s0
                    if (this.spacer) {
                        const dx = this._pinch.currentCenter.x - this._pinch.C0.x
                        const dy = this._pinch.currentCenter.y - this._pinch.C0.y
                        this.spacer.style.transformOrigin = `${this._pinch.originX}px ${this._pinch.originY}px`
                        this.spacer.style.transform = `translate(${dx}px, ${dy}px) scale(${ratio})`
                    }
                })
            }
        }
    }

    async _handleTouchEnd(e) {
        if (this._pinch) {
            if (!e.touches || e.touches.length < 2) {
                const pinch = this._pinch
                this._pinch = null
                if (this.spacer) {
                    this.spacer.style.transform = ''
                    this.spacer.style.transformOrigin = ''
                }
                const finalScale = pinch.currentScale
                this._ignoreClickUntil = performance.now() + 500
                this._commitPinchZoom(finalScale, pinch)
            }
        } else if (e.changedTouches && e.changedTouches.length === 1 && this._singleTouchStart) {
            const touch = e.changedTouches[0]
            const dur = performance.now() - this._singleTouchStart.time
            const dist = Math.hypot(touch.clientX - this._singleTouchStart.x, touch.clientY - this._singleTouchStart.y)
            const moved = this._singleTouchStart.moved
            this._singleTouchStart = null

            // Detect clean tap (< 450ms and moved < 24px)
            if (!moved && dur < 450 && dist < 24) {
                const now = performance.now()
                if (this._lastTapTime && (now - this._lastTapTime < 320)) {
                    // Double tap detected!
                    const lastDist = Math.hypot(touch.clientX - this._lastTapPos.x, touch.clientY - this._lastTapPos.y)
                    if (lastDist < 30) {
                        this._lastTapTime = 0
                        clearTimeout(this._singleTapTimer)
                        this._ignoreClickUntil = now + 450
                        if (e.cancelable) e.preventDefault()
                        this._handleDoubleTapToggle(touch.clientX, touch.clientY)
                        return
                    }
                }
                this._lastTapTime = now
                this._lastTapPos = { x: touch.clientX, y: touch.clientY }
                if (this._selectionDismissedTime && performance.now() - this._selectionDismissedTime < 600) {
                    this._selectionDismissedTime = 0
                    clearTimeout(this._singleTapTimer)
                    return
                }
                if (this._nativePreview?.length) {
                    this.clearSelection()
                    clearTimeout(this._singleTapTimer)
                    return
                }
                if (this.options.onTap) {
                    this._lastTapHandledTime = now
                    this._ignoreClickUntil = now + 800
                    clearTimeout(this._singleTapTimer)
                    this._singleTapTimer = setTimeout(() => {
                        if (this._destroyed || this._pinch || this.interactionMode === 'draw') return
                        const selection = window.getSelection?.()
                        if (selection && !selection.isCollapsed && selection.toString().trim()) {
                            try { selection.removeAllRanges?.() } catch {}
                            return
                        }
                        if (this._nativePreview?.length) {
                            this.clearSelection()
                            return
                        }
                        this.options.onTap()
                    }, 60)
                }
            }
        }
    }

    _handleTouchCancel() {
        clearTimeout(this._singleTapTimer)
        this._ignoreClickUntil = performance.now() + 450
        this._cancelPinch()
        this._singleTouchStart = null
    }

    _cancelPinch() {
        if (this._pinch) {
            this._pinch = null
            if (this.spacer) {
                this.spacer.style.transform = ''
                this.spacer.style.transformOrigin = ''
            }
        }
    }

    _commitPinchZoom(finalScale, pinch) {
        const center = pinch.currentCenter || pinch.C0
        const cRect = this.scrollArea.getBoundingClientRect?.() || { left: 0, top: 0 }
        this.setZoom(finalScale, { anchor: { ...pinch, viewX: center.x - cRect.left, viewY: center.y - cRect.top } })
    }

    _handleDoubleTapToggle(clientX, clientY) {
        const fit = this.getFitScale('fit-width')
        if (this.scale > fit * 1.15) this.setZoom('fit-width')
        else this.setZoom(fit * 2, { anchor: this._captureZoomAnchor(clientX, clientY) })
    }

    async _selectionEndpoints(anchor, focus) {
        const forward = anchor.page < focus.page || (anchor.page === focus.page && anchor.index <= focus.index)
        const first = forward ? anchor : focus, last = forward ? focus : anchor
        const segments = []
        for (let page = first.page; page <= last.page; page++) {
            const geom = await this._ensureNativeGeometry(page)
            if (!geom?.chars?.length) continue
            const startIndex = page === first.page ? first.index : 0
            const endIndex = page === last.page ? last.index : geom.chars.length - 1
            const aIdx = clamp(Math.min(startIndex, endIndex), 0, geom.chars.length - 1)
            const bIdx = clamp(Math.max(startIndex, endIndex), 0, geom.chars.length - 1)
            const aChar = geom.chars[aIdx]
            const bChar = geom.chars[bIdx]

            // Directional boundary calculation (5% inset from leading/trailing edge along advance)
            const boundary = (ch, side) => {
                const q = ch.quad
                const lx = (q[0] + q[4]) / 2, ly = (q[1] + q[5]) / 2
                const tx = (q[2] + q[6]) / 2, ty = (q[3] + q[7]) / 2
                const frac = (side === 'leading') ? 0.05 : 0.95
                return [lx + frac * (tx - lx), ly + frac * (ty - ly)]
            }

            segments.push({
                page,
                a: boundary(aChar, 'leading'),
                b: boundary(bChar, 'trailing'),
                startIndex: aIdx,
                endIndex: bIdx,
            })
        }
        return { forward, segments }
    }

    _buildLineBandQuads(chars) {
        if (!chars || !chars.length) return []
        const bands = []
        let currentRun = []

        const flushRun = () => {
            if (!currentRun.length) return
            const first = currentRun[0], last = currentRun[currentRun.length - 1]
            if (currentRun.length === 1) {
                bands.push(first.quad)
                currentRun = []
                return
            }
            const qFirst = first.quad, qLast = last.quad
            const dx = ((qLast[2] + qLast[6]) - (qFirst[0] + qFirst[4])) / 2
            const dy = ((qLast[3] + qLast[7]) - (qFirst[1] + qFirst[5])) / 2
            const len = Math.hypot(dx, dy)
            if (len <= 1e-4) {
                for (const c of currentRun) bands.push(c.quad)
                currentRun = []
                return
            }
            const ux = dx / len, uy = dy / len
            const vx = -uy, vy = ux

            let low = Infinity, high = -Infinity
            for (const c of currentRun) {
                const q = c.quad
                for (let i = 0; i < 8; i += 2) {
                    const v = q[i] * vx + q[i + 1] * vy
                    if (v < low) low = v
                    if (v > high) high = v
                }
            }

            const uStart = Math.min(qFirst[0] * ux + qFirst[1] * uy, qFirst[4] * ux + qFirst[5] * uy)
            const uEnd = Math.max(qLast[2] * ux + qLast[3] * uy, qLast[6] * ux + qLast[7] * uy)

            const point = (u, v) => [ux * u + vx * v, uy * u + vy * v]
            const ul = point(uStart, low)
            const ur = point(uEnd, low)
            const ll = point(uStart, high)
            const lr = point(uEnd, high)
            bands.push([ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]])
            currentRun = []
        }

        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i]
            if (!currentRun.length) {
                currentRun.push(ch)
                continue
            }
            const prev = currentRun[currentRun.length - 1]
            const sameLine = (ch.line != null && prev.line != null && ch.line === prev.line)
            const gap = Math.hypot(ch.quad[0] - prev.quad[2], ch.quad[1] - prev.quad[3])
            const maxGap = Math.max(12, (ch.size || 12) * 2.5)
            if (sameLine && gap <= maxGap) {
                currentRun.push(ch)
            } else {
                flushRun()
                currentRun.push(ch)
            }
        }
        flushRun()
        return bands
    }

    async _finalizeNativeSelection(anchor, focus, mode) {
        if (this._destroyed) return null
        const { segments } = await this._selectionEndpoints(anchor, focus)
        if (!segments.length || this._destroyed) return null
        const output = []
        for (const seg of segments) {
            const result = await this.driver.select(seg.page, seg.a, seg.b, mode)
            if (this._destroyed) return null
            const size = this.pageSizes[seg.page] || { width: 595, height: 842, x0: 0, y0: 0 }
            const pageBounds = [size.x0 || 0, size.y0 || 0, (size.x0 || 0)+size.width, (size.y0 || 0)+size.height]
            const geom = await this._ensureNativeGeometry(seg.page)
            let quads = []
            let text = result.text || ''
            if (mode !== 'char' && result.quads && result.quads.length > 0) {
                quads = result.quads
            } else {
                const a = Math.min(seg.startIndex, seg.endIndex), b = Math.max(seg.startIndex, seg.endIndex)
                const slice = geom?.chars?.slice(a, b + 1) || []
                const lineBandQuads = slice.length > 0 ? this._buildLineBandQuads(slice) : []
                quads = lineBandQuads.length > 0 ? lineBandQuads : ((result.quads && result.quads.length > 0) ? result.quads : [])
                if (!text && slice.length > 0) {
                    text = slice.map(c => c.text || '').join('')
                }
            }
            const rects = quads.map(q => this._quadToNormalizedRect(q, pageBounds))
            output.push({ page:seg.page, text, quads, rects, pageBounds })
        }
        if (mode !== 'char') {
            this._nativePreview = output.map(x => ({ page: x.page, quads: x.quads }))
            this._scheduleRedrawNativePreview()
        }
        return { text:output.map(x=>x.text).filter(Boolean).join('\n'), segments:output }
    }

    async _updateNativePreview() {
        const drag = this._nativeDrag
        if (!drag) return
        const previewSeq = (drag.previewSeq = (drag.previewSeq || 0) + 1)
        const epoch = drag.epoch
        try {
            const { segments } = await this._selectionEndpoints(drag.anchor, drag.focus)
            if (this._destroyed || this._nativeDrag !== drag || drag.epoch !== epoch || this._nativeGestureEpoch !== epoch) return
            if (drag.latestRenderedPreviewSeq && previewSeq < drag.latestRenderedPreviewSeq) return

            const preview = await Promise.all(segments.map(async seg => {
                const geom = await this._ensureNativeGeometry(seg.page)
                if (!geom) return null
                const a = Math.min(seg.startIndex, seg.endIndex), b = Math.max(seg.startIndex, seg.endIndex)
                const slice = geom.chars.slice(a, b + 1)
                return { page: seg.page, quads: this._buildLineBandQuads(slice) }
            }))
            if (this._destroyed || this._nativeDrag !== drag || drag.epoch !== epoch || this._nativeGestureEpoch !== epoch) return
            if (drag.latestRenderedPreviewSeq && previewSeq < drag.latestRenderedPreviewSeq) return
            drag.latestRenderedPreviewSeq = previewSeq
            this._nativePreview = preview.filter(Boolean)
            this._scheduleRedrawNativePreview()
        } catch (err) {
            if (this._nativeDrag === drag && drag.epoch === epoch) console.warn('[PDF] native selection preview failed:', err)
        }
    }

    _scheduleRedrawNativePreview() {
        if (this._previewRaf) return
        if (typeof requestAnimationFrame !== 'function') {
            this._redrawNativePreview()
            return
        }
        this._previewRaf = requestAnimationFrame(() => {
            this._previewRaf = null
            this._redrawNativePreview()
        })
    }

    _redrawNativePreview() {
        if (typeof document === 'undefined') return
        for (const [page, slot] of this.activeSlots) this._renderNativePreviewForPage(page, slot.querySelector('.pdf-native-selection-layer'))
    }

    _renderNativePreviewForPage(page, layer) {
        if (!layer) return
        layer.replaceChildren()
        const segment = this._nativePreview?.find(x => x.page === page)
        if (!segment?.quads?.length) return
        const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
        const x0 = size.x0 || 0, y0 = size.y0 || 0
        const svg = document.createElementNS('http://www.w3.org/2000/svg','svg')
        svg.setAttribute('viewBox', `${x0} ${y0} ${size.width} ${size.height}`)
        for (const q of segment.quads) {
            const poly = document.createElementNS('http://www.w3.org/2000/svg','polygon')
            poly.setAttribute('points', `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`)
            svg.append(poly)
        }
        layer.append(svg)
    }

    _quadToNormalizedRect(q, bounds) {
        const [x0,y0,x1,y1] = bounds, w = Math.max(.001,x1-x0), h = Math.max(.001,y1-y0)
        const b = quadBounds(q)
        return [clamp((b[0]-x0)/w,0,1),clamp((b[1]-y0)/h,0,1),clamp((b[2]-x0)/w,0,1),clamp((b[3]-y0)/h,0,1)]
    }

    _emitNativeSelection(selection) {
        if (!selection?.text?.trim() || !selection.segments?.length) return
        this._nativePreview = selection.segments.map(s => ({ page:s.page, quads:s.quads }))
        this._redrawNativePreview()
        const first = selection.segments[0]
        const firstRect = first.rects[0] || [0,0,0,0]
        const slot = this.activeSlots.get(first.page), r = slot?.getBoundingClientRect()
        const clientRect = r ? {
            left:r.left+firstRect[0]*r.width, top:r.top+firstRect[1]*r.height,
            width:(firstRect[2]-firstRect[0])*r.width, height:(firstRect[3]-firstRect[1])*r.height,
        } : { left:innerWidth/2,top:innerHeight/2,width:1,height:1 }
        this.options.onSelection?.({
            page:first.page, text:selection.text, rects:first.rects, quads:first.quads,
            pageBounds:first.pageBounds, segments:selection.segments, coordinateVersion:'mupdf-page-v1', clientRect,
        })
    }

    _updateRenderConcurrency() {
        if (this.options?.isLowMemoryDevice) {
            this._renderConcurrency = 1
            return
        }
        if (this.driver?.kind === 'mupdf') {
            // Adaptive concurrency:
            // Single-page mode uses 1 concurrency to guarantee zero wasted CPU/memory and instant preemption.
            // Dual-spread mode uses 2 concurrency so left and right visible pages render simultaneously in parallel.
            this._renderConcurrency = (this.spreadMode === 'dual') ? 2 : 1
        } else {
            this._renderConcurrency = 2
        }
    }

    setSpreadMode(mode) {
        if (this._columnReadingEnabled) this.setColumnReadingConfig({ enabled: false })
        const nextMode = (mode === 'dual' || mode === '2' || mode === 'two') ? 'dual' : 'none'
        if (this.spreadMode === nextMode) return
        const curPage = this.currentPage
        this.spreadMode = nextMode
        this._updateRenderConcurrency()
        this._recomputeLayout()
        this._syncActiveSlotGeometry()
        this.scrollToPage(curPage)
        this._renderVisibleSlots(true)
    }

    getSpreadMode() {
        return this.spreadMode || 'none'
    }

    scrollToPage(page, yRatio = 0) {
        return this.goToPage(page, yRatio)
    }

    _createPageSlot(page) {
        return this._mountSlot(page)
    }

    getPageAtViewportCenter() {
        if (!this.pageOffsets.length) return 0
        const top = this.scrollArea.scrollTop, centerY = top + this.scrollArea.clientHeight / 2
        const left = this.scrollArea.scrollLeft, centerX = left + this.scrollArea.clientWidth / 2

        let best = this.currentPage
        let minDistanceSq = Infinity

        for (let i = 0; i < this.pageOffsets.length; i++) {
            const p = this.pageOffsets[i]
            const pLeft = p.left != null ? p.left : (this._layoutWidth - p.width) / 2
            const pRight = pLeft + p.width
            const pBottom = p.top + p.height

            if (centerX >= pLeft && centerX <= pRight && centerY >= p.top && centerY <= pBottom) {
                return i
            }

            const pCenterX = pLeft + p.width / 2
            const pCenterY = p.top + p.height / 2
            const distSq = (centerX - pCenterX) ** 2 + (centerY - pCenterY) ** 2
            if (distSq < minDistanceSq) {
                minDistanceSq = distSq
                best = i
            }
        }
        return best
    }

    getFitScale(mode = 'fit-width', page = this.currentPage) {
        const size = this.pageSizes[page] || { width: 595, height: 842 }
        const margins = this._getCropMarginsForPage(page)
        const cropW = Math.max(1, (1 - (margins.left + margins.right) / 100) * size.width)
        const cropH = Math.max(1, (1 - (margins.top + margins.bottom) / 100) * size.height)
        const width = this.scrollArea.clientWidth || this.container.clientWidth
        const height = this.scrollArea.clientHeight || this.container.clientHeight
        const isMobile = window.innerWidth < 768 || window.mobileShell?.isMobileViewport?.() || window.platformBridge?.isAndroid
        const margin = isMobile ? 24 : 48
        const spreadFactor = (this.spreadMode === 'dual' && page > 0) ? 2.05 : 1
        const fitWidth = Math.max(1, width - margin) / (cropW * spreadFactor)
        const fitHeight = Math.max(1, height - 32) / cropH
        return clamp(mode === 'fit-page' ? Math.min(fitWidth, fitHeight) : fitWidth, this.options.minScale, this.options.maxScale)
    }

    canPanHorizontally() {
        const page = this.pageOffsets[this.currentPage]
        const width = this.scrollArea.clientWidth || this.container.clientWidth
        return Boolean(page && page.width > width - 8)
    }

    ownsTouchGesture() {
        const selection = window.getSelection?.()
        return Boolean(this._pinch || this.interactionMode === 'draw' || this.canPanHorizontally() ||
            (selection && !selection.isCollapsed && selection.toString().trim()))
    }

    shouldIgnoreContentClick() {
        return Boolean(this._pinch || this.interactionMode === 'draw' || (performance.now() < this._ignoreClickUntil))
    }

    _captureZoomAnchor(clientX = null, clientY = null, page = this.currentPage) {
        const rect = this.scrollArea.getBoundingClientRect?.() || { left: 0, top: 0 }
        const viewX = clientX == null ? (this.scrollArea.clientWidth || this.container.clientWidth) / 2 : clientX - rect.left
        const viewY = clientY == null ? 0 : clientY - rect.top
        const p = this.pageOffsets[page]
        const left = p ? (this._layoutWidth - p.width) / 2 : 0
        return {
            page, viewX, viewY,
            normX: p ? clamp(((this.scrollArea.scrollLeft || 0) + viewX - left) / p.width, 0, 1) : .5,
            normY: p ? clamp((this.scrollArea.scrollTop + viewY - p.top) / p.height, 0, 1) : 0,
        }
    }

    _restoreZoomAnchor(anchor, centerHorizontally = Boolean(this.zoomMode)) {
        const p = this.pageOffsets[anchor.page]
        if (!p) return
        const width = this.scrollArea.clientWidth || this.container.clientWidth
        const height = this.scrollArea.clientHeight || this.container.clientHeight
        const x = centerHorizontally ? (this._layoutWidth - width) / 2 :
            (this._layoutWidth - p.width) / 2 + anchor.normX * p.width - anchor.viewX
        this.scrollArea.scrollLeft = clamp(x, 0, Math.max(0, this._layoutWidth - width))
        this.scrollArea.scrollTop = clamp(p.top + anchor.normY * p.height - anchor.viewY, 0, Math.max(0, this.totalHeight - height))
    }

    setPageAppearance(mode) {
        this.pageAppearance = mode === 'night' ? 'night' : 'original'
        if (this.pageAppearance === 'night') this.container.style.setProperty('--pdf-page-filter', 'invert(0.9) hue-rotate(180deg)')
        else this.container.style.removeProperty('--pdf-page-filter')
    }

    setZoom(value, { anchor = null, columnFocus = false } = {}) {
        if (this._columnReadingEnabled && !columnFocus) this.setColumnReadingConfig({ enabled: false })
        this.zoomMode = value === 'fit-width' || value === 'fit-page' ? value : null
        const next = clamp(this.zoomMode ? this.getFitScale(value) : Number(value), this.options.minScale, columnFocus ? Math.max(this.options.maxScale, this.options.maxColumnScale || 8) : this.options.maxScale)
        if (!Number.isFinite(next)) return
        const scaleChanged = Math.abs(next - this.scale) > 1e-6
        const viewAnchor = anchor || this._captureZoomAnchor()
        this.scale = next
        this._recomputeLayout()
        this._restoreZoomAnchor(viewAnchor)
        this._syncActiveSlotGeometry()
        this.options.onZoomChange?.(this.scale)
        if (scaleChanged) for (const slot of this.activeSlots.values()) {
            slot._renderedClip = null
            // Old tile positions are CSS pixels at the previous zoom. The full
            // page preview scales with its wrapper while a fresh raster is made.
            slot.querySelectorAll('.pdf-clip-canvas').forEach(canvas => {
                canvas.remove()
                canvas.width = canvas.height = 0
            })
        }
        this._renderVisibleSlots(scaleChanged)
        this._redrawNativePreview()
    }

    setInteractionMode(mode) {
        const next = mode === 'draw' ? 'draw' : 'select'
        if (this.interactionMode === next) return
        this.interactionMode = next
        this._nativeGestureEpoch++
        if (next === 'draw') {
            this._cancelNativeDrag()
            try {
                window.getSelection()?.removeAllRanges?.()
            } catch (_) {}
        }
        this.options.onInteractionModeChange?.(next)
    }

    getAdjacentPage(direction) {
        const count = this.pageOffsets.length || this.pageSizes.length || this.numPages || 0
        if (!count) return null
        const current = Math.max(0, Math.min(count - 1, this.currentPage || 0))
        const forward = direction === 'next' || direction === 1
        let target
        if (this.spreadMode !== 'dual') target = current + (forward ? 1 : -1)
        else if (current === 0) target = forward ? 1 : -1
        else {
            // The cover is single; physical spreads are [1,2], [3,4], ... (zero based).
            const firstInSpread = 1 + 2 * Math.floor((current - 1) / 2)
            target = forward ? firstInSpread + 2 : Math.max(0, firstInSpread - 2)
        }
        return target >= 0 && target < count ? target : null
    }

    goToPage(page, yRatio = 0) {
        if (page < 0 || page >= this.pageOffsets.length) return
        if (this._columnReadingEnabled && this._columnState) {
            if (!this._getRegionsForPage(page).length) {
                this.setColumnReadingConfig({ enabled: false })
                this.goToPage(page, yRatio)
                return
            }
            this._columnState = { pageIndex: page, regionIndex: 0, offset: 0 }
            const metrics = this._getColumnMetrics(page, 0)
            this._columnState.offset = Math.min(metrics.maxOffset, Math.max(0, (this.pageSizes[page].height * yRatio - metrics.top) * metrics.fitScale))
            this._applyColumnFocus()
            return
        }
        this.currentPage = page
        if (this.zoomMode) this.setZoom(this.zoomMode)
        const p = this.pageOffsets[page]
        this.scrollArea.scrollTop = Math.max(0, p.top + p.height * clamp(yRatio,0,1) - (yRatio ? this.scrollArea.clientHeight/3 : 8))
        this._renderVisibleSlots()
        this.options.onPageChange?.(page, this.numPages)
    }

    pulseRects(page, rects) {
        if (!rects?.length) return
        const slot = this.activeSlots.get(page)
        if (!slot) { this._pendingPulse = { pageIdx:page, rects }; return }
        slot.querySelectorAll('.pdf-search-pulse').forEach(x=>x.remove())
        for (const [x1,y1,x2,y2] of rects) {
            const el = document.createElement('div'); el.className='pdf-search-pulse'
            Object.assign(el.style,{left:`${x1*100}%`,top:`${y1*100}%`,width:`${Math.max((x2-x1)*100,2)}%`,height:`${Math.max((y2-y1)*100,1.5)}%`})
            slot.append(el); setTimeout(()=>el.remove(),2400)
        }
    }

    pulseHighlight(page, id, fallbackRects) {
        const slot = this.activeSlots.get(page)
        if (!slot) { this._pendingHighlightPulse={pageIdx:page,highlightId:id,fallbackRects}; return }
        const els = slot.querySelectorAll(`.pdf-highlight-rect[data-id="${CSS.escape(String(id))}"]`)
        if (!els.length) return this.pulseRects(page, fallbackRects)
        els.forEach(el=>{ el.classList.remove('pdf-highlight-pulse'); void el.offsetWidth; el.classList.add('pdf-highlight-pulse'); setTimeout(()=>el.classList.remove('pdf-highlight-pulse'),2100) })
    }

    _detectCurrentPage() {
        if (!this.pageOffsets.length) return
        if (this._columnReadingEnabled && this._columnState) {
            const expected = this._columnScrollTarget
            if (expected && Math.abs(this.scrollArea.scrollTop - expected.top) < 2 && Math.abs(this.scrollArea.scrollLeft - expected.left) < 2) return
            const page = this._firstPageAt(this.scrollArea.scrollTop + 16)
            if (page >= this.numPages || !this.pageOffsets[page] || !this._getRegionsForPage(page).length) return
            const p = this.pageOffsets[page], scale = this.scale || 1
            const pageLeft = p.left ?? Math.max(0, (this._layoutWidth - p.width) / 2)
            const center = this.scrollArea.scrollLeft + this.scrollArea.clientWidth / 2
            let index = 0, distance = Infinity
            this._getRegionsForPage(page).forEach((region, i) => {
                const m = this._getColumnMetrics(page, i), d = Math.abs(center - (pageLeft + (m.left + m.width / 2) * scale))
                if (d < distance) { distance = d; index = i }
            })
            const m = this._getColumnMetrics(page, index)
            this._columnState = { pageIndex: page, regionIndex: index, offset: clamp(((this.scrollArea.scrollTop + 12 - p.top) / scale - m.top) * m.fitScale, 0, m.maxOffset) }
            this._applyColumnFocus()
            return
        }
        const best = this.getPageAtViewportCenter()
        if (best !== this.currentPage) {
            this.currentPage = best
            if (this.zoomMode && Math.abs(this.getFitScale(this.zoomMode) - this.scale) > .01) {
                const rect = this.scrollArea.getBoundingClientRect?.() || { left: 0, top: 0 }
                const viewY = Math.max(0, this.pageOffsets[best].top - this.scrollArea.scrollTop)
                this.setZoom(this.zoomMode, { anchor: this._captureZoomAnchor(null, rect.top + viewY, best) })
            }
            this.options.onPageChange?.(best, this.numPages)
        }
    }

    setHighlights(highlights, snapshot = null) {
        if (snapshot) this.currentSnapshot = snapshot
        this.highlights = highlights || []
        this.highlightsByPage.clear()
        for (const hl of this.highlights) {
            if (this.currentSnapshot) {
                const match = isContentIdentityMatching(hl, this.currentSnapshot)
                if (!match.matches) {
                    // Do not silently paint unconfirmed or conflicting highlights
                    continue
                }
            }
            const target = hl.pdfTarget
            if (!target) continue
            const pages = Array.isArray(target.segments) ? target.segments.map(x=>x.page) : [target.page]
            for (const page of new Set(pages)) {
                if (!this.highlightsByPage.has(page)) this.highlightsByPage.set(page, [])
                this.highlightsByPage.get(page).push(hl)
            }
        }
        for (const [page, slot] of this.activeSlots) this._renderHighlightsForPage(page, slot.querySelector('.pdf-highlight-layer'))
    }

    _getCropMarginsForPage(page) {
        if (!this.cropSettings || this.cropSettings.mode === 'none') {
            return { top: 0, right: 0, bottom: 0, left: 0 }
        }
        const mode = this.cropSettings.mode
        let margins = this.cropSettings.margins || { top: 0, right: 0, bottom: 0, left: 0 }
        if (mode === 'odd-even') {
            // page is 0-indexed: page 0 is physical page 1 (odd)
            const isOdd = ((page + 1) % 2 === 1)
            const odd = this.cropSettings.oddMargins || this.cropSettings.odd
            const even = this.cropSettings.evenMargins || this.cropSettings.even
            margins = isOdd ? (odd || margins) : (even || margins)
        }
        const clampMargin = (v) => Math.max(0, Math.min(49, Number(v) || 0))
        return {
            top: clampMargin(margins.top),
            right: clampMargin(margins.right),
            bottom: clampMargin(margins.bottom),
            left: clampMargin(margins.left)
        }
    }

    _applyCropToSlot(page, slot) {
        if (!slot) return
        const margins = this._getCropMarginsForPage(page)
        const size = (this.pageSizes && this.pageSizes[page]) || { width: 595, height: 842 }
        const scale = this.scale || 1
        const uncroppedWidth = Math.max(1, Math.round(size.width * scale))
        const uncroppedHeight = Math.max(1, Math.round(size.height * scale))
        const pOffset = this.pageOffsets && this.pageOffsets[page]
        if (pOffset && slot.style) {
            slot.style.width = `${pOffset.width}px`
            slot.style.height = `${pOffset.height}px`
        }
        if (slot.style) slot.style.overflow = 'hidden'

        let hasInnerLayers = false
        if (typeof slot.querySelectorAll === 'function') {
            const innerLayers = slot.querySelectorAll('.pdf-img-wrapper, .pdf-highlight-layer, .pdf-native-selection-layer, .pdf-text-layer')
            if (innerLayers.length > 0) {
                hasInnerLayers = true
                const offsetX = -Math.round((margins.left / 100) * uncroppedWidth)
                const offsetY = -Math.round((margins.top / 100) * uncroppedHeight)

                innerLayers.forEach(layer => {
                    layer.style.width = `${uncroppedWidth}px`
                    layer.style.height = `${uncroppedHeight}px`
                    layer.style.transform = (offsetX !== 0 || offsetY !== 0) ? `translate(${offsetX}px, ${offsetY}px)` : ''
                    layer.style.transformOrigin = '0 0'
                })
            }
        }

        if (slot.style) {
            if (hasInnerLayers) {
                slot.style.clipPath = ''
            } else {
                const hasMargins = (margins.top > 0 || margins.right > 0 || margins.bottom > 0 || margins.left > 0)
                slot.style.clipPath = hasMargins ? `inset(${margins.top}% ${margins.right}% ${margins.bottom}% ${margins.left}%)` : ''
            }
        }
    }

    setCropSettings(settings) {
        this.cropSettings = settings || { mode: 'none' }
        if (Array.isArray(this.pageSizes) && this.pageSizes.length > 0) {
            this._recomputeLayout()
            this._syncActiveSlotGeometry()
            if (typeof this._renderVisibleSlots === 'function' && Array.isArray(this.pageOffsets) && this.pageOffsets.length > 0) {
                this._renderVisibleSlots()
            }
        }
        if (this.activeSlots) {
            for (const [page, slot] of this.activeSlots.entries()) {
                this._applyCropToSlot(page, slot)
            }
        }
        if (this._columnReadingEnabled) this._applyColumnFocus()
    }

    getCropSettings() {
        return this.cropSettings || { mode: 'none' }
    }

    // ==========================================================
    // S02: Manual Two-Column / Multi-Region Sequential Reading Mode
    // ==========================================================
    setColumnReadingConfig({ enabled = false, defaultRegions = null, pageOverrides = null } = {}) {
        const wasEnabled = Boolean(this._columnReadingEnabled)
        if (enabled && !wasEnabled) {
            this._columnRestoreState = { scale: this.scale || 1, zoomMode: this.zoomMode || null, spreadMode: this.spreadMode || 'none' }
        }
        this._columnReadingEnabled = Boolean(enabled)
        this._columnWheelHandler ||= event => this._handleColumnWheel(event)
        if (enabled) this.scrollArea?.addEventListener?.('wheel', this._columnWheelHandler, { passive: false })
        else this.scrollArea?.removeEventListener?.('wheel', this._columnWheelHandler)
        this._columnDefaultRegions = this._normalizeColumnRegions(defaultRegions || this._columnDefaultRegions || [
            { x: .04, y: .04, width: .44, height: .92 },
            { x: .52, y: .04, width: .44, height: .92 }
        ])
        this._columnPageOverrides = pageOverrides || this._columnPageOverrides || {}
        if (enabled) {
            this._columnLayoutNeedsUpdate = this.spreadMode !== 'none'
            this.spreadMode = 'none'
            let page = Math.max(0, Math.min((this.numPages || 1) - 1, this.currentPage || 0))
            while (page < this.numPages && !this._getRegionsForPage(page).length) page++
            if (page >= this.numPages) {
                page = Math.max(0, Math.min((this.numPages || 1) - 1, this.currentPage || 0))
                while (page > 0 && !this._getRegionsForPage(page).length) page--
            }
            if (!this._getRegionsForPage(page).length) {
                this.setColumnReadingConfig({ enabled: false })
                return
            }
            this._columnState = { pageIndex: page, regionIndex: 0, offset: 0 }
            this._columnWheelRemainder = 0
            this._columnBoundaryAt = -Infinity
            this._applyColumnFocus()
        } else {
            const anchor = this.pageSizes?.length ? this._captureZoomAnchor() : null
            this._columnState = null
            this._columnLastFit = null
            this._columnScrollTarget = null
            const saved = this._columnRestoreState
            this._columnRestoreState = null
            if (wasEnabled && saved && this.pageSizes?.length) {
                this.spreadMode = saved.spreadMode
                this._updateRenderConcurrency()
                this.setZoom(saved.zoomMode || saved.scale, { anchor })
            }
            this.options?.onColumnReadingChange?.(this.getColumnReadingState())
        }
    }

    _normalizeColumnRegions(regions) {
        const normalized = (Array.isArray(regions) ? regions : []).map(r => {
            const x = clamp(Number(r?.x) || 0, 0, .99), y = clamp(Number(r?.y) || 0, 0, .99)
            return { x, y, width: clamp(Number(r?.width ?? r?.w) || 1, .01, 1 - x), height: clamp(Number(r?.height ?? r?.h) || 1, .01, 1 - y) }
        })
        return normalized.length ? normalized : [{ x: 0, y: 0, width: 1, height: 1 }]
    }

    getColumnReadingState() {
        const page = this._columnState?.pageIndex ?? (this.currentPage || 0)
        return { enabled: Boolean(this._columnReadingEnabled), pageIndex: page,
            regionIndex: this._columnState?.regionIndex ?? 0, offset: this._columnState?.offset ?? 0,
            regionCount: this._getRegionsForPage(page).length }
    }

    _getRegionsForPage(page) {
        const override = this._columnPageOverrides?.[page]
        if (override === 'skip') return []
        if (override === 'full') return [{ x: 0, y: 0, width: 1, height: 1 }]
        return this._normalizeColumnRegions(Array.isArray(override) && override.length ? override : this._columnDefaultRegions || [
            { x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: 1 }
        ])
    }

    _getColumnMetrics(page, index) {
        const p = this.pageOffsets[page], region = this._getRegionsForPage(page)[index] || { x: 0, y: 0, width: 1, height: 1 }
        const currentScale = this.scale || 1
        const size = this.pageSizes?.[page] || { width: (p?.width || 600) / currentScale, height: (p?.height || 800) / currentScale }
        const m = this.pageSizes?.[page] ? this._getCropMarginsForPage(page) : { left: 0, right: 0, top: 0, bottom: 0 }
        const cropLeft = size.width * m.left / 100, cropTop = size.height * m.top / 100
        const cropRight = size.width * (1 - m.right / 100), cropBottom = size.height * (1 - m.bottom / 100)
        let x0 = Math.max(cropLeft, size.width * region.x), y0 = Math.max(cropTop, size.height * region.y)
        let x1 = Math.min(cropRight, size.width * (region.x + region.width)), y1 = Math.min(cropBottom, size.height * (region.y + region.height))
        if (x1 <= x0 || y1 <= y0) { x0 = cropLeft; y0 = cropTop; x1 = cropRight; y1 = cropBottom }
        const fitScale = this.pageSizes?.[page]
            ? clamp(Math.max(1, (this.scrollArea.clientWidth || 600) - 32) / Math.max(1, x1 - x0), this.options?.minScale || .1, Math.max(this.options?.maxScale || 3.5, this.options?.maxColumnScale || 8))
            : currentScale
        const viewHeight = Math.max(1, (this.scrollArea.clientHeight || 600) - 24)
        return { left: x0 - cropLeft, top: y0 - cropTop, width: x1 - x0, height: y1 - y0,
            fitScale, maxOffset: Math.max(0, (y1 - y0) * fitScale - viewHeight) }
    }

    _moveColumnRegion(direction) {
        const state = this._columnState
        if (!state) return false
        const regions = this._getRegionsForPage(state.pageIndex)
        const nextIndex = state.regionIndex + direction
        if (nextIndex >= 0 && nextIndex < regions.length) state.regionIndex = nextIndex
        else {
            let page = state.pageIndex + direction
            while (page >= 0 && page < this.numPages && !this._getRegionsForPage(page).length) page += direction
            if (page < 0 || page >= this.numPages) return false
            state.pageIndex = page
            state.regionIndex = direction > 0 ? 0 : Math.max(0, this._getRegionsForPage(page).length - 1)
        }
        state.offset = direction > 0 ? 0 : this._getColumnMetrics(state.pageIndex, state.regionIndex).maxOffset
        return true
    }

    nextColumnStep() {
        if (!this._columnReadingEnabled || !this._columnState) return false
        const s = this._columnState, max = this._getColumnMetrics(s.pageIndex, s.regionIndex).maxOffset
        if (s.offset < max - .5) s.offset = Math.min(max, s.offset + Math.max(100, (this.scrollArea.clientHeight || 600) * .85))
        else if (!this._moveColumnRegion(1)) return false
        this._applyColumnFocus()
        return true
    }

    prevColumnStep() {
        if (!this._columnReadingEnabled || !this._columnState) return false
        const s = this._columnState
        if (s.offset > .5) s.offset = Math.max(0, s.offset - Math.max(100, (this.scrollArea.clientHeight || 600) * .85))
        else if (!this._moveColumnRegion(-1)) return false
        this._applyColumnFocus()
        return true
    }

    _handleColumnWheel(event) {
        if (!this._columnReadingEnabled || !this._columnState || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0)) return
        const delta = (event.deltaY || 0) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scrollArea.clientHeight : 1)
        if (!delta) return
        event.preventDefault()
        event.stopPropagation()
        const s = this._columnState, max = this._getColumnMetrics(s.pageIndex, s.regionIndex).maxOffset
        if (delta > 0 && s.offset < max - .5 || delta < 0 && s.offset > .5) {
            s.offset = clamp(s.offset + delta, 0, max)
            this._columnWheelRemainder = 0
        } else {
            const now = performance.now()
            if (now - (this._columnBoundaryAt ?? -Infinity) < 220) return
            if (Math.sign(this._columnWheelRemainder || 0) !== Math.sign(delta)) this._columnWheelRemainder = 0
            this._columnWheelRemainder = (this._columnWheelRemainder || 0) + delta
            if (Math.abs(this._columnWheelRemainder) < 40) return
            if (!this._moveColumnRegion(delta > 0 ? 1 : -1)) return
            this._columnBoundaryAt = now
            this._columnWheelRemainder = 0
        }
        this._applyColumnFocus()
    }

    _applyColumnFocus() {
        if (!this.scrollArea || !this._columnState || this._destroyed) return
        const state = this._columnState, beforePage = this.currentPage
        if (!this.pageOffsets[state.pageIndex]) return
        const metrics = this._getColumnMetrics(state.pageIndex, state.regionIndex)
        const previousFit = this._columnLastFit
        if (previousFit && previousFit.page === state.pageIndex && previousFit.index === state.regionIndex && previousFit.scale > 0) {
            state.offset *= metrics.fitScale / previousFit.scale
        }
        this.currentPage = state.pageIndex
        if (this.pageSizes?.length) {
            this.spreadMode = 'none'
            if (this._columnLayoutNeedsUpdate || Math.abs(metrics.fitScale - this.scale) > 1e-6 || this._layoutViewportWidth !== this.scrollArea.clientWidth || this._layoutViewportHeight !== this.scrollArea.clientHeight) {
                this.setZoom(metrics.fitScale, { columnFocus: true })
                this._columnLayoutNeedsUpdate = false
            }
        }
        const p = this.pageOffsets[state.pageIndex], scale = this.scale || 1
        const pageLeft = p.left ?? Math.max(0, ((this._layoutWidth || p.width) - p.width) / 2)
        state.offset = clamp(Number.isFinite(state.offset) ? state.offset : 0, 0, metrics.maxOffset)
        this.scrollArea.scrollTop = Math.max(0, p.top + metrics.top * scale + state.offset - 12)
        this.scrollArea.scrollLeft = Math.max(0, pageLeft + metrics.left * scale - 16)
        this._columnLastFit = { page: state.pageIndex, index: state.regionIndex, scale: metrics.fitScale }
        this._columnScrollTarget = { top: this.scrollArea.scrollTop, left: this.scrollArea.scrollLeft }
        if (beforePage !== state.pageIndex) this.options?.onPageChange?.(state.pageIndex, this.numPages)
        this.options?.onColumnReadingChange?.(this.getColumnReadingState())
        this._renderVisibleSlots()
    }

    // ==========================================================
    // S03: Scan Enhancement Presets
    // ==========================================================
    setScanEnhancementPreset(presetName = 'original', customParams = null) {
        const presets = {
            'original': { brightness: 100, contrast: 100, grayscale: false, invert: false, filterStr: 'none' },
            'gray-boost': { brightness: 115, contrast: 130, grayscale: true, invert: false, filterStr: 'brightness(115%) contrast(130%) grayscale(100%)' },
            'clean-bg': { brightness: 115, contrast: 130, grayscale: true, invert: false, filterStr: 'brightness(115%) contrast(130%) grayscale(100%)' },
            'text-darken': { brightness: 90, contrast: 160, grayscale: false, invert: false, filterStr: 'brightness(90%) contrast(160%)' },
            'deep-ink': { brightness: 90, contrast: 160, grayscale: false, invert: false, filterStr: 'brightness(90%) contrast(160%)' }
        }
        const aliases = {
            'clean_bg': 'clean-bg',
            'deep_ink': 'deep-ink',
            '灰底增强': 'gray-boost',
            '字迹加深': 'text-darken'
        }
        const resolvedName = aliases[presetName] || presetName
        let cfg = presets[resolvedName] || presets.original
        if (resolvedName === 'custom' && customParams) {
            const b = Math.max(50, Math.min(200, Number(customParams.brightness) || 100))
            const c = Math.max(50, Math.min(250, Number(customParams.contrast) || 100))
            const gray = !!customParams.grayscale
            const inv = !!customParams.invert
            let f = `brightness(${b}%) contrast(${c}%)`
            if (gray) f += ' grayscale(100%)'
            if (inv) f += ' invert(100%)'
            cfg = { brightness: b, contrast: c, grayscale: gray, invert: inv, filterStr: f }
        }

        this._scanEnhanceConfig = { preset: presetName, ...cfg }
        if (this.container) {
            this.container.style.setProperty('--reader-img-filter', cfg.filterStr)
            this.container.style.setProperty('--pdf-page-filter', cfg.filterStr)
        }
        return this._scanEnhanceConfig
    }

    getScanEnhancementState() {
        return this._scanEnhanceConfig || {
            preset: 'original',
            brightness: 100,
            contrast: 100,
            grayscale: false,
            invert: false,
            filterStr: 'none'
        }
    }

    // ==========================================================
    // S04: Reading Ruler & Controlled Auto-Scroll
    // ==========================================================
    setReadingRuler({ enabled = false, height = 40, opacity = 0.25, color = 'rgba(255, 230, 0, 0.3)' } = {}) {
        if (!enabled) {
            this.removeReadingRuler()
            return
        }
        if (!this._readingRulerEl) {
            const doc = typeof document !== 'undefined' ? document : null
            this._readingRulerEl = doc ? doc.createElement('div') : { style: {}, remove() {} }
            this._readingRulerEl.className = 'reading-ruler-overlay'
            this._readingRulerEl.style.cssText = 'position:absolute;left:0;right:0;pointer-events:none;z-index:45;box-shadow:0 -1px 0 rgba(0,0,0,0.15), 0 1px 0 rgba(0,0,0,0.15);transition:top 0.04s ease-out;'
            this.container?.appendChild(this._readingRulerEl)
        }
        this._rulerHeight = Math.max(16, Math.min(200, Number(height) || 40))
        this._readingRulerEl.style.height = `${this._rulerHeight}px`
        this._readingRulerEl.style.backgroundColor = color
        this._readingRulerEl.style.opacity = Math.max(0.05, Math.min(1, Number(opacity) || 0.25))

        if (!this._onRulerMouseMove) {
            this._onRulerMouseMove = (e) => {
                if (!this._readingRulerEl || !this.container) return
                const rect = this.container.getBoundingClientRect()
                const y = e.clientY - rect.top
                this._readingRulerEl.style.top = `${Math.max(0, y - this._rulerHeight / 2)}px`
            }
            this.container?.addEventListener('mousemove', this._onRulerMouseMove, { passive: true })
        }
    }

    removeReadingRuler() {
        if (this._onRulerMouseMove && this.container) {
            this.container.removeEventListener('mousemove', this._onRulerMouseMove)
            this._onRulerMouseMove = null
        }
        if (this._readingRulerEl) {
            this._readingRulerEl.remove()
            this._readingRulerEl = null
        }
    }

    startAutoScroll({ speed = 30 } = {}) {
        this.stopAutoScroll()
        this._autoScrollSpeed = Math.max(5, Math.min(200, Number(speed) || 30))
        this._autoScrollPaused = false
        let lastTime = performance.now()

        if (!this._autoScrollWheelBound && this.scrollArea && typeof this.scrollArea.addEventListener === 'function') {
            this._autoScrollWheelBound = true
            this.scrollArea.addEventListener('wheel', () => {
                if (this._autoScrollActive && !this._autoScrollPaused) {
                    this.pauseAutoScroll()
                    clearTimeout(this._autoScrollResumeTimer)
                    this._autoScrollResumeTimer = setTimeout(() => {
                        if (this._autoScrollActive && this._autoScrollPaused) {
                            this.resumeAutoScroll()
                        }
                    }, 2000)
                }
            }, { passive: true })
            this.scrollArea.addEventListener('touchstart', () => {
                if (this._autoScrollActive && !this._autoScrollPaused) {
                    this.pauseAutoScroll()
                }
            }, { passive: true })
        }

        const loop = (now) => {
            if (!this._autoScrollActive) return
            const deltaSec = Math.min((now - lastTime) / 1000, 0.1)
            lastTime = now

            const isHidden = typeof document !== 'undefined' && document.hidden
            const isBlur = typeof document !== 'undefined' && !document.hasFocus()
            const hasSelection = typeof window !== 'undefined' && (window.getSelection()?.toString().length || 0) > 0

            if (!this._autoScrollPaused && !isHidden && !isBlur && !hasSelection && this.scrollArea) {
                const maxScroll = this.scrollArea.scrollHeight - this.scrollArea.clientHeight
                if (this.scrollArea.scrollTop < maxScroll) {
                    this.scrollArea.scrollTop += this._autoScrollSpeed * deltaSec
                } else {
                    this.stopAutoScroll()
                    return
                }
            }
            const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(() => cb(Date.now()), 16)
            this._autoScrollRaf = raf(loop)
        }

        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(() => cb(Date.now()), 16)
        this._autoScrollActive = true
        this._autoScrollRaf = raf(loop)
    }

    pauseAutoScroll() {
        this._autoScrollPaused = true
    }

    resumeAutoScroll() {
        this._autoScrollPaused = false
    }

    toggleAutoScrollPause() {
        this._autoScrollPaused = !this._autoScrollPaused
        return this._autoScrollPaused
    }

    stopAutoScroll() {
        this._autoScrollActive = false
        this._autoScrollPaused = false
        if (this._autoScrollRaf) {
            const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
            caf(this._autoScrollRaf)
            this._autoScrollRaf = null
        }
    }

    destroy() {
        if (this._destroyed) return
        this._destroyed = true
        if (this._columnWheelHandler) this.scrollArea?.removeEventListener?.('wheel', this._columnWheelHandler)
        this.removeReadingRuler?.()
        this.stopAutoScroll?.()
        this._resizeObserver?.disconnect()
        clearTimeout(this._singleTapTimer)
        this._cancelPinch?.()
        this._nativeGestureEpoch++
        this._loadGeneration = (this._loadGeneration || 0) + 1
        this._geometryAbort?.abort()
        this._geometryQueue.length = 0
        this._geometryQueued.clear()
        if (this._outlineTimer != null) clearTimeout(this._outlineTimer)
        this._renderQueue.length = 0
        for (const inflight of this._inFlightRenders.values()) inflight.abortController?.abort()
        this._inFlightRenders.clear()
        this._activeDriverTasks.clear()
        this._activeRenders = 0
        for (const [page, slot] of Array.from(this.activeSlots.entries())) {
            this._unmountSlot(page, slot)
        }
        this.activeSlots.clear()
        this.highlightsByPage.clear()
        for (const entry of this._bitmapCache.values()) {
            if (entry?.canvas) {
                try { entry.canvas.width = 0; entry.canvas.height = 0 } catch (_) {}
            }
        }
        this._bitmapCache.clear()
        this._bitmapCacheBytes = 0
        this._nativeGeometry.clear()
        this._nativeGeometryUse.clear()
        this._nativeDrag = null
        this._nativePreview = null
        this._selectionDismissedTime = 0
        this._isClearingSelection = false
        this.driver?.destroy?.()
        this.driver = null
        this.container.innerHTML = ''
    }
}
