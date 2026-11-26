// Independent PDF viewport shared by PDF.js and native Rust PDF engine.
// Rendering is virtualized/cancellable; PDF.js owns its TextLayer, while
// native selection is based on engine character geometry in page coordinates.

import { isContentIdentityMatching } from './db.js'
import { t } from './i18n.js'
import {
    computePulseDeepenedColor,
    HIGHLIGHT_LOCATE_PULSE_CSS,
    HIGHLIGHT_LOCATE_PULSE_CLEANUP_MS
} from './highlight-pulse.js'
import {
    getHighlightInkColor,
    getHighlightStrokeHex,
} from './highlight-palette.js'
import { resolvePdfPageFilter } from './pdf-color-filter.js'

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
            onScrollPositionChange: null,
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
        this._layoutRows = []
        this._layoutRowsSource = null
        this._layoutRowsLength = 0
        this.totalHeight = 0
        this.activeSlots = new Map()
        this.currentPage = 0
        this.highlights = []
        this.highlightsByPage = new Map()
        this.interactionMode = 'select' // 'select' | 'draw'
        this._nativeGestureEpoch = 0

        this._destroyed = false
        this._geometryAbort = null
        this._geometryRequest = null
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
        this._budgetRenderConcurrency = null
        this._prefetchTimer = null
        this._zoomRefineTimer = null
        this._scrollPositionTimer = null
        this._navigationBurstCount = 0
        this._lastNavigationDirection = 1
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
        this._multiSelections = []
        this._lastSingleSelection = null
        this._ctrlSelectHeld = false
        this._domSelectionDragId = 0
        this._locatePulseTimer = null
        this._locatePulseEls = []
        this._suppressSelectionClick = false
        this._nativeClickOnText = false
        this._isClearingSelection = false
        this._pageReadyWaiters = new Map()
        this._navIdleWaiters = new Set()
        this._lastVisualStateKey = null

        this._initDOM()
        this._bindEvents()
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._destroyed || !this.pageSizes.length || this._pinch) return
                if (this._layoutViewportWidth === this.scrollArea.clientWidth && this._layoutViewportHeight === this.scrollArea.clientHeight) return
                this.setZoom(this.zoomMode || this.scale)
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
            this._budgetRenderConcurrency = budget.renderConcurrency
            this._updateRenderConcurrency()
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
            this._budgetRenderConcurrency = 1
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
        .pdf-viewport-spacer{position:relative;margin:0 auto;box-sizing:border-box;padding:0;min-width:100%}
        .pdf-page-slot{position:absolute;left:50%;transform:translateX(-50%);background:var(--book-bg,#fff);box-shadow:0 4px 16px rgba(20,18,15,0.16),0 1px 4px rgba(20,18,15,0.08);border-radius:3px;overflow:hidden;box-sizing:border-box;touch-action:pan-x pan-y}
        .pdf-page-slot[data-spread-role="left"]{border-radius:3px 0 0 3px;box-shadow:-6px 5px 18px -2px rgba(20,18,15,0.16),0 2px 6px rgba(20,18,15,0.07)}
        .pdf-page-slot[data-spread-role="right"]{border-radius:0 3px 3px 0;box-shadow:6px 5px 18px -2px rgba(20,18,15,0.16),0 2px 6px rgba(20,18,15,0.07)}
        .pdf-page-slot[data-spread-role="left"]::after{content:"";position:absolute;top:0;right:0;bottom:0;width:clamp(6px,2.4%,18px);background:linear-gradient(to left,rgba(0,0,0,0.11) 0%,rgba(0,0,0,0.035) 38%,transparent 100%);pointer-events:none;z-index:3}
        .pdf-page-slot[data-spread-role="right"]::before{content:"";position:absolute;top:0;left:0;bottom:0;width:clamp(4px,1.5%,12px);background:linear-gradient(to right,rgba(0,0,0,0.07) 0%,rgba(0,0,0,0.02) 42%,transparent 100%);pointer-events:none;z-index:3}
        [data-theme="dark"] .pdf-page-slot[data-spread-role="left"],[data-theme="black"] .pdf-page-slot[data-spread-role="left"]{box-shadow:-6px 5px 18px -2px rgba(0,0,0,0.52),0 2px 6px rgba(0,0,0,0.32)}
        [data-theme="dark"] .pdf-page-slot[data-spread-role="right"],[data-theme="black"] .pdf-page-slot[data-spread-role="right"]{box-shadow:6px 5px 18px -2px rgba(0,0,0,0.52),0 2px 6px rgba(0,0,0,0.32)}
        [data-theme="dark"] .pdf-page-slot[data-spread-role="left"]::after,[data-theme="black"] .pdf-page-slot[data-spread-role="left"]::after{background:linear-gradient(to left,rgba(0,0,0,0.28) 0%,rgba(0,0,0,0.09) 42%,transparent 100%)}
        [data-theme="dark"] .pdf-page-slot[data-spread-role="right"]::before,[data-theme="black"] .pdf-page-slot[data-spread-role="right"]::before{background:linear-gradient(to right,rgba(255,255,255,0.06) 0%,rgba(255,255,255,0.015) 42%,transparent 100%)}
        .pdf-img-wrapper{position:absolute;inset:0;overflow:hidden;pointer-events:none}
        .pdf-page-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;font:13px/1.5 system-ui,sans-serif;pointer-events:none}
        .pdf-page-canvas,.pdf-page-img{position:absolute;inset:0;width:100%;height:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none}
        .pdf-page-preview{position:absolute;inset:0;width:100%;height:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none;z-index:1}
        .pdf-clip-canvas{position:absolute;left:0;width:100%;filter:var(--pdf-page-filter,var(--reader-img-filter,none));pointer-events:none;z-index:2}
        .pdf-text-layer{position:absolute;inset:0;overflow:clip;z-index:4;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0;user-select:text;-webkit-user-select:text;pointer-events:auto}
        .pdf-text-layer .textLayer{position:absolute;inset:0;transform-origin:0 0;--scale-round-x:1px;--scale-round-y:1px;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size))}
        .pdf-text-layer .textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
        .pdf-text-layer .textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
        .pdf-text-layer .textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
        .pdf-text-layer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}
        .pdf-text-layer .textLayer>:not(.markedContent),.pdf-text-layer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
        .pdf-text-layer .markedContent{display:contents}.pdf-text-layer span[role=img]{user-select:none;cursor:default}
        .pdf-text-layer ::selection{background:rgba(37,99,235,.32)!important;color:transparent!important}.pdf-text-layer br::selection{background:transparent}
        .pdf-highlight-layer,.pdf-native-selection-layer,.pdf-multi-select-layer,.pdf-locate-pulse-layer{position:absolute;inset:0;pointer-events:none}
        .pdf-highlight-layer{z-index:3}.pdf-multi-select-layer{z-index:4}.pdf-native-selection-layer{z-index:5}.pdf-locate-pulse-layer{z-index:9}
        .pdf-native-selection-layer svg,.pdf-multi-select-layer svg,.pdf-locate-pulse-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
        .pdf-native-selection-layer polygon{fill:rgba(37,99,235,.28)}
        .pdf-multi-select-layer polygon{fill:rgba(37,99,235,.26)}
        .pdf-multi-select-rect{position:absolute;background:rgba(37,99,235,.26);border-radius:2px;pointer-events:none}
        .pdf-locate-pulse-item{position:absolute;border-radius:2px;pointer-events:none;mix-blend-mode:multiply}
        .pdf-locate-pulse-layer svg polygon{mix-blend-mode:multiply}
        [data-theme="dark"] .pdf-locate-pulse-item,[data-theme="black"] .pdf-locate-pulse-item,
        [data-theme="dark"] .pdf-locate-pulse-layer svg polygon,[data-theme="black"] .pdf-locate-pulse-layer svg polygon{mix-blend-mode:screen}
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
        ${HIGHLIGHT_LOCATE_PULSE_CSS}
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
                    this._schedulePdfTextLayers()
                    if (this._hasPendingVisibleZoomRefine()) {
                        this._scheduleZoomRefine()
                    }
                })
            }

            clearTimeout(this._scrollPositionTimer)
            this._scrollPositionTimer = setTimeout(() => {
                this._scrollPositionTimer = null
                if (this._destroyed || !this.numPages) return
                this.options.onScrollPositionChange?.(this.getReadingLocation())
            }, 350)

        }, { passive: true })

        this.scrollArea.addEventListener('mouseup', e => {
            if (this.interactionMode === 'draw') return
            const isAdditive = Boolean(e.ctrlKey || e.metaKey || this._ctrlSelectHeld)
            if (this.driver?.kind !== 'mupdf' && !this._onPdfDomSelectionChange) {
                if (this._handleDomSelection(isAdditive)) this._hasPdfDomSelection = true
            }
        })
        const captureDismissalState = (e) => {
            if (this.interactionMode === 'draw') return
            if (e && (e.ctrlKey || e.metaKey)) this._ctrlSelectHeld = true
            const now = performance.now()
            const sel = window.getSelection?.()
            const hasLocal = Boolean(
                this._hasPdfDomSelection ||
                this._nativePreview?.length ||
                this._multiSelections.length ||
                (sel && !sel.isCollapsed && sel.toString().trim())
            )
            if (now - (this._lastGestureCaptureAt || 0) >= 80) {
                this._lastGestureCaptureAt = now
                if (!(e?.ctrlKey || e?.metaKey || this._ctrlSelectHeld)) {
                    globalThis.app?.captureSelectionAndPopupStateOnGestureStart?.()
                }
                this._gestureHadPdfSelection = hasLocal
            } else {
                this._gestureHadPdfSelection = Boolean(this._gestureHadPdfSelection || hasLocal)
            }
        }
        this.scrollArea.addEventListener('pointerdown', captureDismissalState, { capture: true, passive: true })
        this.scrollArea.addEventListener('touchstart', captureDismissalState, { capture: true, passive: true })
        this._modifierKeyDown = e => {
            if (e.key === 'Control' || e.key === 'Meta' || e.ctrlKey || e.metaKey) {
                this._ctrlSelectHeld = true
            }
        }
        this._navigationKeyUp = e => {
            if (e.key === 'Control' || e.key === 'Meta') {
                this._ctrlSelectHeld = Boolean(e.ctrlKey || e.metaKey)
            }
            if (['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','PageDown','PageUp',' ','Enter','j','k','h','l','J','K','H','L'].includes(e.key)) this._flushNavigationRender()
        }
        this._modifierBlur = () => { this._ctrlSelectHeld = false }
        window.addEventListener('keydown', this._modifierKeyDown)
        window.addEventListener('keyup', this._navigationKeyUp)
        window.addEventListener('blur', this._modifierBlur)
        this.scrollArea.addEventListener('pointerdown', e => {
            if (this.driver?.kind !== 'mupdf') {
                this._domSelectionDragId = (this._domSelectionDragId || 0) + 1
                if (e.ctrlKey || e.metaKey) this._ctrlSelectHeld = true
            }
            this._nativePointerDown(e)
            if (this.options.deferPdfTextLayer && e.pointerType !== 'touch' && e.isPrimary && this.interactionMode !== 'draw') {
                const page = e.target.closest?.('.pdf-page-slot')?.dataset.page
                if (page != null) this._renderDeferredPdfTextLayer(Number(page))
            }
        })
        this.scrollArea.addEventListener('pointermove', e => this._nativePointerMove(e))
        this.scrollArea.addEventListener('pointerup', e => this._nativePointerUp(e))
        this.scrollArea.addEventListener('pointercancel', () => {
            // Android cancels the page pointer when WebView begins a text selection.
            if (this._nativeDrag) this.clearSelection()
        })
        if (this.options.deferPdfTextLayer) {
            this._onPdfDomSelectionChange = () => {
                if (this.driver?.kind !== 'pdfjs') return
                if (this._handleDomSelection(this._ctrlSelectHeld)) {
                    this._hasPdfDomSelection = true
                } else if (this._hasPdfDomSelection) {
                    this._hasPdfDomSelection = false
                    if (!this._ctrlSelectHeld && this._multiSelections.length === 0) {
                        this.options.onSelectionClear?.()
                    }
                }
            }
            document.addEventListener('selectionchange', this._onPdfDomSelectionChange)
        }
        this.scrollArea.addEventListener('dblclick', e => this._nativeDoubleClick(e))
        this.scrollArea.addEventListener('touchstart', e => this._handleTouchStart(e), { passive: false })
        this.scrollArea.addEventListener('touchmove', e => this._handleTouchMove(e), { passive: false })
        this.scrollArea.addEventListener('touchend', e => this._handleTouchEnd(e), { passive: false })
        this.scrollArea.addEventListener('touchcancel', () => this._handleTouchCancel())

        this.scrollArea.addEventListener('click', async e => {
            // pointerup is followed by click, even after a captured drag. Consume
            // that gesture's click; the next pointerdown arms normal dismissal.
            if (this._suppressSelectionClick) {
                this._suppressSelectionClick = false
                this._gestureHadPdfSelection = false
                return
            }
            if (e.ctrlKey || e.metaKey) {
                return
            }
            const pendingDrag = this._nativeDrag
            if (this.interactionMode === 'draw' || this.shouldIgnoreContentClick() ||
                (pendingDrag && (!pendingDrag.released || pendingDrag.hasMoved))) {
                this._gestureHadPdfSelection = false
                return
            }
            if (this._ignoreClickUntil && performance.now() < this._ignoreClickUntil) {
                this._gestureHadPdfSelection = false
                return
            }
            const sel = window.getSelection?.()
            if (sel && !sel.isCollapsed && sel.toString().trim()) {
                this._consumeDismissalLock()
                try { sel.removeAllRanges?.() } catch {}
                this._hasPdfDomSelection = false
                if (this._multiSelections.length) this.clearSelection()
                return
            }
            if (this._nativePreview?.length || this._multiSelections.length) {
                this._consumeDismissalLock()
                this.clearSelection()
                return
            }
            const slot = e.target.closest?.('.pdf-page-slot')
            if (!slot) {
                if (this._consumeDismissalLock()) {
                    this.clearSelection()
                    return
                }
                if (!this._lastTapHandledTime || (performance.now() - this._lastTapHandledTime > 800)) {
                    this.options.onTap?.()
                }
                return
            }
            const hlHit = this._hitTestHighlightAtPoint(e.target, e.clientX, e.clientY)
            if (hlHit) {
                this._consumeDismissalLock()
                clearTimeout(this._singleTapTimer)
                globalThis.app?.cancelPendingReaderUIToggle?.()
                e.stopPropagation()
                this.options.onHighlightClick?.(hlHit.hl, e, hlHit.rect)
                return
            }
            if (this._consumeDismissalLock()) {
                this.clearSelection()
                return
            }
            if (this._nativeClickOnText && e.pointerType !== 'touch') return
            if (pendingDrag?.ready) {
                const hitText = await pendingDrag.ready.catch(() => false)
                if (this._destroyed || this._suppressSelectionClick || this.shouldIgnoreContentClick() ||
                    hitText || (this._nativeClickOnText && e.pointerType !== 'touch')) {
                    return
                }
            }
            if (!this._lastTapHandledTime || (performance.now() - this._lastTapHandledTime > 800)) {
                this.options.onTap?.()
            }
        })
    }

    _consumeDismissalLock() {
        const hadLocal = Boolean(this._gestureHadPdfSelection)
        this._gestureHadPdfSelection = false
        const appConsumed = globalThis.app?.consumeDismissalGesture?.()
        return Boolean(appConsumed || hadLocal)
    }

    _hitTestHighlightAtPoint(target, clientX, clientY) {
        const slot = target?.closest?.('.pdf-page-slot')
        if (!slot) return null
        const page = Number(slot.dataset.page)
        const hlLayer = slot.querySelector?.('.pdf-highlight-layer')
        const layerRect = hlLayer?.getBoundingClientRect?.()
        const rect = (layerRect && layerRect.width > 0 && layerRect.height > 0)
            ? layerRect
            : slot.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        const x = (clientX - rect.left) / rect.width
        const y = (clientY - rect.top) / rect.height
        for (const hl of [...(this.highlightsByPage.get(page) || [])].reverse()) {
            const segment = this._highlightSegment(hl, page)
            for (const [x1, y1, x2, y2] of segment?.rects || []) {
                if (x >= x1 - 6 / rect.width && x <= x2 + 6 / rect.width && y >= y1 - 6 / rect.height && y <= y2 + 6 / rect.height) {
                    return {
                        hl,
                        rect: {
                            left: rect.left + x1 * rect.width,
                            top: rect.top + y1 * rect.height,
                            width: (x2 - x1) * rect.width,
                            height: (y2 - y1) * rect.height,
                        },
                    }
                }
            }
        }
        return null
    }

    async load(engineDriver, source, { initialPage = 0, initialYRatio = 0, snapshot = null } = {}) {
        if (this._destroyed) return { numPages: 0, title: '', author: '', toc: [] }
        this._loadGeneration = (this._loadGeneration || 0) + 1
        const currentGen = this._loadGeneration

        this.driver = engineDriver
        this._outlineRequested = false
        clearTimeout(this._prefetchTimer)
        this._prefetchTimer = null
        clearTimeout(this._zoomRefineTimer)
        this._zoomRefineTimer = null
        clearTimeout(this._scrollPositionTimer)
        this._scrollPositionTimer = null
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        this._navigationRenderPending = null
        this._navigationBurstCount = 0
        this._lastNavigationDirection = 1
        this._geometryAbort?.abort()
        this._geometryInFlight = null
        this._geometryQueue.length = 0
        this._geometryQueued.clear()
        this._knownPageGeometry.clear()
        for (const [page, slot] of [...this.activeSlots]) this._unmountSlot(page, slot)
        for (const inflight of this._inFlightRenders.values()) inflight.abortController?.abort()
        this._inFlightRenders.clear()
        this._renderQueue.length = 0
        this._cancelAllPageReadyWaiters(false)
        this._notifyNavIdle(false)
        this._clearBitmapCache()
        this._lastScrollTop = 0
        this.visualVersion = (this.visualVersion || 0) + 1
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
        this._loadPageLabelsAsync(currentGen)
        this._geometryAbort = new AbortController()
        if (!info.allPageSizesKnown && !this.driver?.allPageSizesKnown) {
            this._enqueueGeometry(targetPage)
        }
        return { numPages: this.numPages, title: info.title || t('book.pdfDocumentTitle'), author: info.author || t('book.unknownAuthor'), toc: info.toc || [] }
    }

    async attachOpenedDriver(engineDriver, { initialPage = 0, initialYRatio = 0, snapshot = null } = {}) {
        if (this._destroyed) return { numPages: 0 }
        const generation = this._loadGeneration = (this._loadGeneration || 0) + 1
        this.driver = engineDriver
        this._outlineRequested = false
        clearTimeout(this._prefetchTimer)
        this._prefetchTimer = null
        clearTimeout(this._zoomRefineTimer)
        this._zoomRefineTimer = null
        clearTimeout(this._scrollPositionTimer)
        this._scrollPositionTimer = null
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        this._navigationRenderPending = null
        this._navigationBurstCount = 0
        this._lastNavigationDirection = 1
        this._geometryAbort?.abort()
        this._geometryInFlight = null
        this._geometryQueue.length = 0
        this._geometryQueued.clear()
        this._knownPageGeometry.clear()
        for (const [page, slot] of [...this.activeSlots]) this._unmountSlot(page, slot)
        for (const inflight of this._inFlightRenders.values()) inflight.abortController?.abort()
        this._inFlightRenders.clear()
        this._renderQueue.length = 0
        this._cancelAllPageReadyWaiters(false)
        this._notifyNavIdle(false)
        this._clearBitmapCache()
        this._lastScrollTop = 0
        this.visualVersion = (this.visualVersion || 0) + 1
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
        this._loadPageLabelsAsync(generation)
        if (!engineDriver.allPageSizesKnown) {
            this._enqueueGeometry(targetPage)
        }
        return { numPages: this.numPages }
    }

    async _loadPageLabelsAsync(generation) {
        this.pageLabels = null
        if (typeof this.driver?.getPageLabels !== 'function') return
        try {
            const labels = await this.driver.getPageLabels()
            if (this._destroyed || generation !== this._loadGeneration) return
            this.pageLabels = Array.isArray(labels) ? labels : null
            this.options.onPageLabelsReady?.(this.pageLabels)
        } catch {
            // Keep null pageLabels when document defines none
        }
    }

    getPageLabel(pageIndex) {
        if (!Array.isArray(this.pageLabels)) return null
        const raw = this.pageLabels[pageIndex]
        const trimmed = typeof raw === 'string' ? raw.trim() : ''
        return trimmed || null
    }

    findPageByLabel(input) {
        const query = String(input || '').trim()
        if (!query) return null
        if (Array.isArray(this.pageLabels)) {
            const exactIdx = this.pageLabels.findIndex(lbl => typeof lbl === 'string' && lbl.trim() === query)
            if (exactIdx >= 0) return exactIdx
            const ciIdx = this.pageLabels.findIndex(lbl => typeof lbl === 'string' && lbl.trim().toLowerCase() === query.toLowerCase())
            if (ciIdx >= 0) return ciIdx
        }
        if (/^\d+$/.test(query)) {
            const pageNum = parseInt(query, 10)
            const total = this.pageOffsets?.length || this.pageSizes?.length || this.numPages || 0
            if (pageNum >= 1 && pageNum <= total) return pageNum - 1
        }
        return null
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
                let values, pending
                try {
                    const end = Math.min(start + 8, this.numPages)
                    const request = driver.getPageSizes(start, end - start, signal)
                    pending = this._geometryRequest = { start, end, request, signal }
                    values = await request
                } catch (err) {
                    if (!signal.aborted) console.warn('[PDF] page geometry batch failed:', err)
                    continue
                } finally {
                    if (this._geometryRequest === pending) this._geometryRequest = null
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
                    this._renderVisibleSlots()
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
            this._layoutRows = []
            this._layoutRowsSource = this.pageOffsets
            this._layoutRowsLength = 0
            this.totalHeight = 0
            this._layoutWidth = 0
            return
        }
        this.pageOffsets = []
        const rows = []
        const safeScale = Number.isFinite(Number(this.scale)) && Number(this.scale) > 0 ? Number(this.scale) : 1
        // Row gap scales smoothly with zoom while spread pages touch at a zero-gap spine.
        const rowGap = Math.round(clamp(20 * safeScale, 8, 28))
        let y = rowGap
        let maxWidth = 0

        if (this.spreadMode === 'dual') {
            // Page 0 (cover) sits centered on its own row
            if (this.pageSizes.length > 0) {
                const m0 = this._getPageBoxMetrics(0, { ignoreOffsets: true })
                const w0 = m0.slotWidth
                const h0 = m0.slotHeight
                this.pageOffsets.push({
                    top: y, width: w0, height: h0, left: null,
                    spreadRole: 'single', rowTop: y, rowBottom: y + h0,
                })
                rows.push({ top: y, bottom: y + h0, startPage: 0, endPage: 0 })
                maxWidth = Math.max(maxWidth, w0)
                y += h0 + rowGap
            }

            // Subsequent spreads join seamlessly at 0px gap with unequal heights vertically centered
            for (let i = 1; i < this.pageSizes.length; i += 2) {
                const mL = this._getPageBoxMetrics(i, { ignoreOffsets: true })
                const wL = mL.slotWidth
                const hL = mL.slotHeight

                if (i + 1 < this.pageSizes.length) {
                    const mR = this._getPageBoxMetrics(i + 1, { ignoreOffsets: true })
                    const wR = mR.slotWidth
                    const hR = mR.slotHeight
                    const rowH = Math.max(hL, hR)
                    const topL = y + Math.round((rowH - hL) / 2)
                    const topR = y + Math.round((rowH - hR) / 2)

                    this.pageOffsets.push({
                        top: topL, width: wL, height: hL, left: null,
                        spreadRole: 'left', rowTop: y, rowBottom: y + rowH,
                        _pairRight: i + 1, _wR: wR,
                    })
                    this.pageOffsets.push({
                        top: topR, width: wR, height: hR, left: null,
                        spreadRole: 'right', rowTop: y, rowBottom: y + rowH,
                    })
                    rows.push({ top: y, bottom: y + rowH, startPage: i, endPage: i + 1 })
                    maxWidth = Math.max(maxWidth, wL + wR)
                    y += rowH + rowGap
                } else {
                    this.pageOffsets.push({
                        top: y, width: wL, height: hL, left: null,
                        spreadRole: 'single', rowTop: y, rowBottom: y + hL,
                    })
                    rows.push({ top: y, bottom: y + hL, startPage: i, endPage: i })
                    maxWidth = Math.max(maxWidth, wL)
                    y += hL + rowGap
                }
            }
        } else {
            for (let i = 0; i < this.pageSizes.length; i++) {
                const m = this._getPageBoxMetrics(i, { ignoreOffsets: true })
                const width = m.slotWidth
                const height = m.slotHeight
                this.pageOffsets.push({
                    top: y, width, height, left: null,
                    spreadRole: 'single', rowTop: y, rowBottom: y + height,
                })
                rows.push({ top: y, bottom: y + height, startPage: i, endPage: i })
                y += height + rowGap
                maxWidth = Math.max(maxWidth, width)
            }
        }

        const lastPage = this.pageOffsets.at(-1)
        const viewportHeight = this.scrollArea.clientHeight || this.container.clientHeight || 0
        this._layoutViewportWidth = this.scrollArea.clientWidth
        this._layoutViewportHeight = this.scrollArea.clientHeight
        this.totalHeight = this.zoomMode && lastPage ? Math.max(y, lastPage.top + viewportHeight) : y
        this._layoutWidth = Math.max(maxWidth + 32, this.scrollArea.clientWidth || this.container.clientWidth || 0)

        const dpr = (typeof window !== 'undefined' && Number(window.devicePixelRatio) > 0)
            ? Number(window.devicePixelRatio)
            : 1
        const snapPx = v => Math.round(v * dpr) / dpr

        // Assign device-pixel-snapped horizontal left offsets
        if (this.spreadMode === 'dual') {
            if (this.pageOffsets.length > 0) {
                this.pageOffsets[0].left = snapPx((this._layoutWidth - this.pageOffsets[0].width) / 2)
            }
            for (let i = 1; i < this.pageOffsets.length; i++) {
                const p = this.pageOffsets[i]
                if (p._pairRight) {
                    const pairW = p.width + p._wR
                    const startX = snapPx(Math.max(16, (this._layoutWidth - pairW) / 2))
                    p.left = startX
                    const pR = this.pageOffsets[i + 1]
                    if (pR) {
                        pR.left = snapPx(startX + p.width)
                    }
                    delete p._pairRight
                    delete p._wR
                    i++
                } else if (p.left == null) {
                    p.left = snapPx((this._layoutWidth - p.width) / 2)
                }
            }
        } else {
            for (const p of this.pageOffsets) {
                p.left = null
            }
        }

        this._layoutRows = rows
        this._layoutRowsSource = this.pageOffsets
        this._layoutRowsLength = this.pageOffsets.length

        this.spacer.style.height = `${this.totalHeight}px`
        this.spacer.style.width = `${this._layoutWidth}px`
    }

    _syncActiveSlotGeometry() {
        for (const [page, slot] of this.activeSlots) {
            const p = this.pageOffsets[page]
            if (!p) continue
            slot.dataset.spreadRole = p.spreadRole || 'single'
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
            if (this._pageOcrSpans?.get(page)?.length) {
                this._renderOcrLayerForPage(page, slot.querySelector('.pdf-text-layer'))
            }
            this.options.onSlotGeometrySync?.(page, slot)
        }
    }

    _ensureLayoutRows() {
        if (!Array.isArray(this.pageOffsets) || !this.pageOffsets.length) {
            this._layoutRows = []
            this._layoutRowsSource = this.pageOffsets
            this._layoutRowsLength = 0
            return this._layoutRows
        }
        if (this._layoutRows && this._layoutRowsSource === this.pageOffsets && this._layoutRowsLength === this.pageOffsets.length) {
            return this._layoutRows
        }
        const rows = []
        for (let i = 0; i < this.pageOffsets.length; i++) {
            const p = this.pageOffsets[i]
            const pTop = p.rowTop != null ? p.rowTop : p.top
            const pBottom = p.rowBottom != null ? p.rowBottom : (p.top + p.height)
            const prevRow = rows[rows.length - 1]
            if (prevRow && prevRow.top === pTop) {
                prevRow.endPage = i
                if (pBottom > prevRow.bottom) prevRow.bottom = pBottom
            } else {
                rows.push({ top: pTop, bottom: pBottom, startPage: i, endPage: i })
            }
        }
        this._layoutRows = rows
        this._layoutRowsSource = this.pageOffsets
        this._layoutRowsLength = this.pageOffsets.length
        return rows
    }

    _firstRowAt(y) {
        const rows = this._ensureLayoutRows()
        let lo = 0, hi = rows.length
        while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (rows[mid].bottom < y) lo = mid + 1
            else hi = mid
        }
        return lo
    }

    _firstPageAt(y) {
        const rows = this._ensureLayoutRows()
        if (!rows.length) return 0
        const rowIdx = this._firstRowAt(y)
        if (rowIdx >= rows.length) return this.pageOffsets.length
        return rows[rowIdx].startPage
    }

    _findVisibleRange(bufferPages = this.options.bufferPages) {
        const rows = this._ensureLayoutRows()
        if (!this.pageOffsets.length || !rows.length) return { first: 0, last: 0, start: 0, end: 0 }
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const firstRow = Math.min(rows.length - 1, this._firstRowAt(top))
        let lastRow = firstRow
        while (lastRow + 1 < rows.length && rows[lastRow + 1].top <= bottom) {
            lastRow++
        }
        const first = rows[firstRow].startPage
        const last = rows[lastRow].endPage
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

    _schedulePrefetchRange() {
        if (this._destroyed || !this.pageOffsets.length || this._navigationRenderPending) return
        if (!this.options.bufferPages || this.options.bufferPages <= 0) return
        if (performance.now() - (this._lastNavigationRequestAt || 0) < 90 && (this._navigationBurstCount || 0) > 0) return

        const { first, last, start, end } = this._findVisibleRange()
        const isScrollingDown = this._lastNavigationDirection >= 0
        const forwardLimit = this.spreadMode === 'dual' ? 2 : 1
        const backwardLimit = this.spreadMode === 'dual' ? (isScrollingDown ? 1 : 2) : 1
        const prefStart = Math.max(start, first - backwardLimit)
        const prefEnd = Math.min(end, last + forwardLimit)

        let queuedAny = false
        for (let i = prefStart; i <= prefEnd; i++) {
            if (i >= first && i <= last) continue
            const slot = this.activeSlots.get(i)
            if (!slot) continue
            if (slot._renderedScale !== this.scale || slot._renderedToken !== slot._renderToken || slot._renderedIsPreview) {
                if (!this._isPageQueuedOrRendering(i, slot._renderToken)) {
                    let dist = i < first ? (first - i) : (i - last)
                    if (isScrollingDown && i < first) dist += 2
                    if (!isScrollingDown && i > last) dist += 2
                    this._scheduleRender({
                        page: i,
                        slot,
                        token: slot._renderToken,
                        tier: 1,
                        distance: dist,
                    })
                    queuedAny = true
                }
            }
        }
        if (queuedAny) this._pumpRenderQueue()
    }

    _schedulePrefetchDeferred(delayMs = 95) {
        clearTimeout(this._prefetchTimer)
        this._prefetchTimer = null
        if (this._destroyed || !this.options.bufferPages || this.options.bufferPages <= 0) return
        if (delayMs <= 0) {
            this._schedulePrefetchRange()
            return
        }
        this._prefetchTimer = setTimeout(() => {
            this._prefetchTimer = null
            this._schedulePrefetchRange()
        }, delayMs)
    }

    _renderVisibleSlots(force = false, { previewOnly = false } = {}) {
        if (!this.pageOffsets.length) return
        if (!force && !previewOnly && this._navigationRenderPending) { this._syncVisibleSlotsOnly(); return }
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const { first, last, start, end } = this._findVisibleRange()
        if (!previewOnly) {
            this._enqueueGeometry(first)
            if (last !== first) this._enqueueGeometry(last)
        }
        const needed = new Set()
        for (let i = start; i <= end; i++) needed.add(i)

        for (const [page, slot] of [...this.activeSlots]) {
            if (!needed.has(page)) this._unmountSlot(page, slot)
        }
        for (let i = start; i <= end; i++) if (!this.activeSlots.has(i)) this._mountSlot(i)

        if (force) {
            clearTimeout(this._prefetchTimer)
            this._prefetchTimer = null
            clearTimeout(this._zoomRefineTimer)
            this._zoomRefineTimer = null
            for (let i = start; i <= end; i++) {
                const slot = this.activeSlots.get(i)
                if (!slot) continue
                slot._renderToken = (slot._renderToken || 0) + 1
                slot.renderAbort?.abort()
                slot.renderAbort = new AbortController()
                slot._renderedIsPreview = false
                slot._needsClipRefine = false
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
            let needsRender = force || slot._renderedScale !== this.scale || slot._renderedToken !== slot._renderToken || (!previewOnly && slot._renderedIsPreview)
            if (!needsRender && slot._renderedClip) {
                const p = this.pageOffsets[i]
                const clipWin = p ? this._getVisibleClipWindow(i, p) : null
                if (clipWin) {
                    const outOfVertical = clipWin.imgVisTop < slot._renderedClip.top || clipWin.imgVisBottom > slot._renderedClip.bottom
                    const outOfHorizontal = slot._renderedClip.left != null && slot._renderedClip.right != null &&
                        (clipWin.imgVisLeft < slot._renderedClip.left || clipWin.imgVisRight > slot._renderedClip.right)
                    if (outOfVertical || outOfHorizontal) {
                        needsRender = true
                        slot._renderToken = (slot._renderToken || 0) + 1
                        slot.renderAbort?.abort()
                        slot.renderAbort = new AbortController()
                    }
                }
            }
            if (needsRender) {
                const inFlight = this._inFlightRenders.get(i)
                if (!previewOnly && inFlight?.previewOnly && !inFlight.abortController?.signal?.aborted) {
                    slot._renderToken = (slot._renderToken || 0) + 1
                    slot.renderAbort?.abort()
                    slot.renderAbort = new AbortController()
                    if (this._inFlightRenders.get(i) === inFlight) {
                        this._inFlightRenders.delete(i)
                    }
                }
                if (!previewOnly) {
                    for (const queued of this._renderQueue) {
                        if (queued.page === i &&
                            queued.slot === slot &&
                            queued.token === slot._renderToken &&
                            !queued.signal?.aborted &&
                            queued.previewOnly) {
                            queued.previewOnly = false
                        }
                    }
                }
                if (!this._isPageQueuedOrRendering(i, slot._renderToken)) {
                    toSchedule.push({
                        page: i,
                        slot,
                        token: slot._renderToken,
                        tier: 0,
                        distance: Math.abs(i - this.currentPage),
                        previewOnly: Boolean(previewOnly),
                    })
                }
            }
        }

        const scrollDelta = top - (this._lastScrollTop ?? top)
        this._lastScrollTop = top
        if (scrollDelta !== 0) {
            this._lastNavigationDirection = scrollDelta > 0 ? 1 : -1
        }

        for (const item of toSchedule) {
            this._scheduleRender(item)
        }

        this._pumpRenderQueue()

        if (!previewOnly && this._hasPendingVisibleZoomRefine()) {
            this._scheduleZoomRefine()
        }

        if (!previewOnly && this.options.bufferPages > 0) {
            // Defer offscreen prefetch briefly so visible page(s) finish first cleanly
            // without queue churn during active scrolling or single-page handoff.
            this._schedulePrefetchDeferred(toSchedule.length ? 95 : 20)
        }
    }

    _hasPendingVisibleZoomRefine() {
        if (this._destroyed || !this.pageOffsets.length || !this.activeSlots.size) return false
        const { first, last } = this._findVisibleRange(0)
        for (let i = first; i <= last; i++) {
            const slot = this.activeSlots.get(i)
            if (slot?._needsClipRefine && slot._renderedScale === this.scale) return true
        }
        return false
    }

    _scheduleZoomRefine(delayMs = 180) {
        if (this._destroyed) return
        clearTimeout(this._zoomRefineTimer)
        this._zoomRefineTimer = setTimeout(() => {
            this._zoomRefineTimer = null
            this._runZoomRefine()
        }, delayMs)
    }

    _runZoomRefine() {
        if (this._destroyed || !this.driver || !this.pageOffsets.length) return
        if (this._lastScrollEventTs && (performance.now() - this._lastScrollEventTs) < 140) {
            this._scheduleZoomRefine(120)
            return
        }
        const { first, last } = this._findVisibleRange(0)
        let promoted = false
        for (let i = first; i <= last; i++) {
            const slot = this.activeSlots.get(i)
            if (!slot || !slot._needsClipRefine || slot._renderedScale !== this.scale) continue
            if (this._isPageQueuedOrRendering(i, slot._renderToken)) continue
            slot._needsClipRefine = false
            slot._renderToken = (slot._renderToken || 0) + 1
            slot.renderAbort?.abort()
            slot.renderAbort = new AbortController()
            promoted = true
        }
        if (promoted) {
            this._renderVisibleSlots()
        }
    }

    _schedulePdfTextLayers() {
        if (!this.options.deferPdfTextLayer || this.driver?.kind !== 'pdfjs' ||
            this._destroyed || this._pdfTextTimer != null || this._pdfTextJob) return

        const quietMs = 250
        const elapsed = performance.now() - (this._lastScrollEventTs ?? -quietMs)
        this._pdfTextTimer = setTimeout(() => {
            this._pdfTextTimer = null
            if (performance.now() - (this._lastScrollEventTs ?? -quietMs) < quietMs) {
                this._schedulePdfTextLayers()
                return
            }
            this._renderDeferredPdfTextLayer()
        }, Math.max(0, quietMs - elapsed))
    }

    async _renderDeferredPdfTextLayer(preferredPage = null) {
        if (this.driver?.kind !== 'pdfjs' || this._destroyed || this._pdfTextJob || !this.pageOffsets.length) return
        const { first, last } = this._findVisibleRange()
        const ready = page => {
            const slot = this.activeSlots.get(page)
            return slot && slot._renderedScale === this.scale && slot._renderedToken === slot._renderToken &&
                slot._pdfTextToken !== slot._renderToken && !slot.renderAbort.signal.aborted
        }

        let page = preferredPage != null && ready(preferredPage) ? preferredPage : this.currentPage
        if (!ready(page)) {
            for (page = first; page <= last && !ready(page); page++) {}
            if (page > last) return
        }

        const slot = this.activeSlots.get(page)
        const { signal } = slot.renderAbort
        const token = slot._renderToken
        this._pdfTextJob = slot
        try {
            const textLayer = slot.querySelector('.pdf-text-layer')
            await this.driver.renderTextLayer(page, textLayer, this.scale, signal, { incremental: true })
            if (!signal.aborted && this._pageOcrSpans?.get(page)?.length) {
                this._renderOcrLayerForPage(page, textLayer, { appendOnly: true })
            }
        } catch (err) {
            if (!signal.aborted && err?.name !== 'AbortError') console.warn('[PDF] Text layer failed:', err)
        } finally {
            if (!signal.aborted) slot._pdfTextToken = token
            this._pdfTextJob = null
            this._schedulePdfTextLayers()
        }
    }

    _unmountSlot(page, slot, { remounting = false } = {}) {
        this.options.onSlotUnmount?.(page, slot)
        slot.renderAbort?.abort()
        if (slot.geometryIdleId != null) window.cancelIdleCallback?.(slot.geometryIdleId)
        if (slot.geometryTimer != null) clearTimeout(slot.geometryTimer)
        if (!remounting) this._parkPageCanvas(page, slot)
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
        if (!remounting) this._failPageReadyWaiters(page)
    }

    _remountPage(page) {
        const slot = this.activeSlots.get(page)
        if (!slot) return
        this._unmountSlot(page, slot, { remounting: true })
        this._mountSlot(page)
        if (!this.activeSlots.has(page)) this._failPageReadyWaiters(page)
    }

    _mountSlot(page) {
        const layout = this.pageOffsets[page]
        if (!layout) return
        const slot = document.createElement('div')
        slot.className = 'pdf-page-slot'
        slot.dataset.page = String(page)
        slot.dataset.spreadRole = layout.spreadRole || 'single'
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
        loading.textContent = t('pdf.showingPage')
        loading.setAttribute('role', 'status')
        pixels.append(loading)
        const highlights = document.createElement('div'); highlights.className = 'pdf-highlight-layer'
        const multiSel = document.createElement('div'); multiSel.className = 'pdf-multi-select-layer'
        const selection = document.createElement('div'); selection.className = 'pdf-native-selection-layer'
        const text = document.createElement('div'); text.className = 'pdf-text-layer'
        if (this.driver?.kind === 'mupdf') {
            text.style.display = 'none'
            text.style.pointerEvents = 'none'
        }
        slot.append(pixels, highlights, multiSel, selection, text)
        this._applyCropToSlot(page, slot)
        if (this._pageOcrSpans?.get(page)?.length) {
            this._renderOcrLayerForPage(page, text)
        }
        // DOM selection follows document order even when scrolling backwards
        // mounts an earlier page after its later neighbors.
        let nextPage = Infinity
        for (const index of this.activeSlots.keys()) {
            if (index > page && index < nextPage) nextPage = index
        }
        if (nextPage !== Infinity) this.spacer.insertBefore(slot, this.activeSlots.get(nextPage))
        else this.spacer.append(slot)
        this.activeSlots.set(page, slot)
        this._renderHighlightsForPage(page, highlights)
        this._renderMultiSelectionsForPage(page, multiSel)
        this._renderNativePreviewForPage(page, selection)

        if (this._pendingPulse?.pageIdx === page) {
            const p = this._pendingPulse; this._pendingPulse = null
            queueMicrotask(() => this.pulseRects(p.pageIdx, p.rects))
        }
        if (this._pendingHighlightPulse?.pageIdx === page) {
            const p = this._pendingHighlightPulse; this._pendingHighlightPulse = null
            queueMicrotask(() => this.pulseHighlight(p.pageIdx, p.highlightId, p.fallbackRects, p.color))
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
            previewOnly: Boolean(item.previewOnly),
            signal: item.slot.renderAbort.signal,
        })
    }

    _pumpRenderQueue() {
        if (this._destroyed || this._navigationRenderPending) return

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
        const { first, last } = this._findVisibleRange(0)

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

        // Sort: Tier 0 before Tier 1; explicit readiness requests ahead of prefetch; then distance; left-to-right page order
        this._renderQueue.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier
            const ep = (b.explicitPriority ? 1 : 0) - (a.explicitPriority ? 1 : 0)
            if (ep) return ep
            if (a.distance !== b.distance) return a.distance - b.distance
            return a.page - b.page
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

        // 4. Dispatch tasks up to concurrency limit of ACTUAL driver occupancy.
        // Strict Tier-0 Barrier: never launch offscreen Tier 1 prefetch while any Tier 0
        // visible page is still queued or in flight (prevents dual-spread starvation).
        while (Math.max(this._activeDriverTasks.size, this._inFlightRenders.size) < this._renderConcurrency && this._renderQueue.length) {
            const peek = this._renderQueue[0]
            if (peek.tier > 0) {
                if (this.driver?.parallelRendering && this._activeDriverTasks.size > 0) break
                let hasActiveTier0 = false
                for (const inflight of this._inFlightRenders.values()) {
                    if (inflight.tier === 0 && !inflight.abortController?.signal?.aborted) {
                        hasActiveTier0 = true
                        break
                    }
                }
                if (hasActiveTier0) break
            }
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
                previewOnly: Boolean(item.previewOnly),
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

    _cacheKey(page, scale) {
        return `${this._loadGeneration || 0}:${page}:${scale}`
    }

    _parkPageCanvas(page, slot) {
        const bitmap = slot._fullRaster
        slot._fullRaster = null
        if (!bitmap || this._destroyed || bitmap.generation !== this._loadGeneration) return
        const { canvas, scale } = bitmap
        const bytes = canvas.width * canvas.height * 4
        if (!bytes || bytes > Math.min(16 * 1024 * 1024, this._bitmapCacheLimitBytes)) return
        const key = this._cacheKey(page, scale)
        const replaced = this._takePageCanvas(key)
        if (replaced) replaced.width = replaced.height = 0
        this._pruneBitmapCache(bytes)
        // The slot and the cache take turns owning the same backing bitmap.
        canvas.remove()
        this._bitmapCache.set(key, { canvas, bytes, page })
        this._bitmapCacheBytes += bytes
    }

    _takePageCanvas(key) {
        const entry = this._bitmapCache.get(key)
        if (!entry) return null
        this._bitmapCache.delete(key)
        this._bitmapCacheBytes -= entry.bytes
        return entry.canvas
    }

    _clearBitmapCache() {
        for (const { canvas } of this._bitmapCache.values()) canvas.width = canvas.height = 0
        this._bitmapCache.clear()
        this._bitmapCacheBytes = 0
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
            const canvas = this._takePageCanvas(victimKey)
            canvas.width = canvas.height = 0
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
            const geometry = this._geometryRequest
            if (this.driver.kind === 'mupdf' && geometry && geometry.signal === this._geometryAbort?.signal &&
                page >= geometry.start && page < geometry.end && !this._knownPageGeometry.has(page)) {
                // The bounds request is already in the native worker. Let its
                // layout update invalidate the slot before starting an obsolete raster.
                try { await geometry.request } catch {}
                if (!isCurrent()) return
            }
            const fullPageScale = this._renderScale(page, false)
            const unthrottledScale = this._renderScale(page, true)
            let scale = fullPageScale
            const priority = renderEntry?.tier ?? 0
            const generation = token

            // V1-B: Bounded 2D Viewport High-Res Clip Calculation
            // Uses uncapped Retina scale (`unthrottledScale`) ONLY when clipping is needed
            // because fullPageScale was downscaled below unthrottledScale by pixel/edge caps.
            let clip = null
            let requestedClip = null
            const size = this.pageSizes[page] || { width: 595, height: 842 }
            const candDevW = Math.round(size.width * unthrottledScale)
            const candDevH = Math.round(size.height * unthrottledScale)
            const totalPixels = candDevW * candDevH
            const threshold = this.options.clipPixelThreshold || 2_000_000
            const pageOffset = this.pageOffsets[page]
            const isPreview = Boolean(renderEntry?.previewOnly) && this.driver.kind === 'mupdf' && totalPixels >= 1_500_000
            if (isPreview) {
                scale = fullPageScale * 0.55
            }

            if (!isPreview &&
                this.options.enableClip !== false &&
                this.driver.kind === 'mupdf' &&
                priority === 0 &&
                pageOffset &&
                totalPixels >= threshold) {

                const clipWin = this._getVisibleClipWindow(page, pageOffset)
                const visHeight = clipWin.visHeight
                const sWidth = clipWin.viewportWidth
                const visRatioX = clipWin.visWidth / Math.max(1, pageOffset.width)

                const needsClip = (unthrottledScale > fullPageScale * 1.02) && visHeight > 0
                if (needsClip) {
                    const bleedY = Math.round(this.scrollArea.clientHeight * 0.35)
                    const bleedX = Math.round(sWidth * 0.25)
                    let cssY0 = Math.max(0, clipWin.imgVisTop - bleedY)
                    let cssY1 = Math.min(clipWin.uncroppedHeight, clipWin.imgVisBottom + bleedY)
                    let cssX0 = visRatioX < 0.95 ? Math.max(0, clipWin.imgVisLeft - bleedX) : 0
                    let cssX1 = visRatioX < 0.95 ? Math.min(clipWin.uncroppedWidth, clipWin.imgVisRight + bleedX) : clipWin.uncroppedWidth

                    const GRID_STEP = 64
                    cssY0 = Math.floor(cssY0 / GRID_STEP) * GRID_STEP
                    cssY1 = Math.min(clipWin.uncroppedHeight, Math.ceil(cssY1 / GRID_STEP) * GRID_STEP)
                    cssX0 = Math.floor(cssX0 / GRID_STEP) * GRID_STEP
                    cssX1 = Math.min(clipWin.uncroppedWidth, Math.ceil(cssX1 / GRID_STEP) * GRID_STEP)

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
            // cover scrolling immediately; later idle ticks refine zoomed slots with a clip.
            const deferredClipRefine = Boolean(clip && !pixels.querySelector('.pdf-page-canvas, .pdf-page-preview'))
            if (deferredClipRefine) {
                clip = null
                requestedClip = null
                scale = fullPageScale
            }

            if (!isCurrent()) return

            let canvas = clip || isPreview ? null : this._takePageCanvas(this._cacheKey(page, scale))
            if (!canvas) {
                try {
                    canvas = await this.driver.renderPage(page, scale, signal, clip, priority, generation)
                } catch (err) {
                    if (clip && !signal.aborted && !/abort/i.test(String(err))) {
                        console.warn('[PdfViewport] clipped render failed, falling back to full-page render:', err)
                        clip = null
                        requestedClip = null
                        scale = fullPageScale
                        canvas = this._takePageCanvas(this._cacheKey(page, scale)) ||
                            await this.driver.renderPage(page, scale, signal, null, priority, generation)
                    } else {
                        throw err
                    }
                }
                if (!isCurrent()) {
                    if (canvas) canvas.width = canvas.height = 0
                    return
                }
            }

            if (!isCurrent()) return

            const cssToDev = scale / this.scale

            if (isPreview) {
                if (pixels.querySelector('.pdf-page-canvas')) {
                    canvas.width = canvas.height = 0
                    return
                }
                pixels.querySelector('.pdf-page-loading')?.remove()
                if (canvas.classList) canvas.classList.add('pdf-page-preview')
                else canvas.className = `${canvas.className || ''} pdf-page-preview`.trim()
                canvas.style.position = 'absolute'
                canvas.style.inset = '0'
                canvas.style.width = '100%'
                canvas.style.height = '100%'
                canvas.style.zIndex = '1'
                this._parkPageCanvas(page, slot)
                pixels.replaceChildren(canvas)
                slot._renderedClip = null
                slot._renderedScale = null
                slot._renderedToken = 0
                slot._renderedIsPreview = true
                slot._needsClipRefine = false
                return
            }

            if (!clip) {
                // Full page render
                pixels.querySelector('.pdf-page-loading')?.remove()
                canvas.className = 'pdf-page-canvas'
                canvas.style.position = 'absolute'
                canvas.style.inset = '0'
                canvas.style.width = '100%'
                canvas.style.height = '100%'
                canvas.style.zIndex = ''
                this._parkPageCanvas(page, slot)
                pixels.replaceChildren(canvas)
                slot._fullRaster = { canvas, scale, generation: this._loadGeneration }
                slot._renderedClip = null
                slot._renderedIsPreview = false
                slot._needsClipRefine = Boolean(
                    deferredClipRefine ||
                    (priority !== 0 &&
                        this.options.enableClip !== false &&
                        this.driver.kind === 'mupdf' &&
                        totalPixels >= threshold &&
                        unthrottledScale > fullPageScale * 1.02)
                )
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
                    if (existingPageCanvas.classList) existingPageCanvas.classList.add('pdf-page-preview')
                    else if (!String(existingPageCanvas.className || '').includes('pdf-page-preview')) {
                        existingPageCanvas.className = `${existingPageCanvas.className || ''} pdf-page-preview`.trim()
                    }
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
                        old.width = old.height = 0
                    }
                }

                // Keep at most 2 active clip canvases to prevent DOM buildup while maintaining scroll continuity
                const remainingClips = [...pixels.querySelectorAll('.pdf-clip-canvas')]
                while (remainingClips.length >= 2) {
                    const oldest = remainingClips.pop()
                    oldest.remove()
                    oldest.width = oldest.height = 0
                }

                if (typeof pixels.prepend === 'function') pixels.prepend(canvas)
                else if (pixels.children?.unshift) { pixels.children.unshift(canvas); canvas.parentElement = pixels }
                else pixels.append(canvas)

                slot._needsClipRefine = false
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
            slot._renderError = false
            slot._renderedIsPreview = false
            if (slot._needsClipRefine && isCurrent()) {
                const vis = this._findVisibleRange(0)
                if (page >= vis.first && page <= vis.last) {
                    this._scheduleZoomRefine()
                }
            }
            this.visualVersion = (this.visualVersion || 0) + 1
            this._notifyPageReadyWaiters(page)
            if (page === this._initialTargetPage && canvas?.width > 0 && canvas?.height > 0 && isCurrent()) {
                this.options.onInitialPageRendered?.({ page, canvas, slot })
            }

            // Remove retry badge if previously shown
            slot.querySelector('.pdf-render-retry-badge')?.remove()

            // Restore text layer visibility & pointer events
            if (text) {
                text.style.opacity = '1'
                text.style.pointerEvents = this.driver?.kind === 'mupdf' ? 'none' : 'auto'
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
                if (this.options.deferPdfTextLayer) this._schedulePdfTextLayers()
                else {
                    await this.driver.renderTextLayer(page, text, this.scale, signal)
                    if (!signal.aborted && this._pageOcrSpans?.get(page)?.length) {
                        this._renderOcrLayerForPage(page, text, { appendOnly: true })
                    }
                }
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
            slot._renderError = true
            this._failPageReadyWaiters(page)
            if (isCurrent()) {
                const hasExistingCanvas = pixels.querySelector('canvas')
                if (!hasExistingCanvas) {
                    const box = document.createElement('div')
                    box.className = 'pdf-render-error'
                    box.textContent = t('pdf.renderFailed', { page: page + 1 })
                    pixels.replaceChildren(box)
                } else {
                    let retryBadge = slot.querySelector('.pdf-render-retry-badge')
                    if (!retryBadge) {
                        retryBadge = document.createElement('div')
                        retryBadge.className = 'pdf-render-retry-badge'
                        retryBadge.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(220,38,38,0.85);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;z-index:6;cursor:pointer;'
                        retryBadge.textContent = t('pdf.retryHd')
                        retryBadge.onclick = () => {
                            retryBadge.remove()
                            slot._renderError = false
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
        let createdLinksLayer = false
        if (!linksLayer) {
            linksLayer = document.createElement('div')
            linksLayer.className = 'pdf-links-layer'
            linksLayer.style.position = 'absolute'
            linksLayer.style.left = '0'
            linksLayer.style.top = '0'
            linksLayer.style.pointerEvents = 'none'
            linksLayer.style.zIndex = '4'
            slot.append(linksLayer)
            createdLinksLayer = true
        }
        if (createdLinksLayer) {
            this._applyCropToSlot(page, slot)
        }
        linksLayer.replaceChildren()
        const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
        const originX = this.driver?.kind === 'pdfjs' ? 0 : (Number(size.x0) || 0)
        const originY = this.driver?.kind === 'pdfjs' ? 0 : (Number(size.y0) || 0)
        for (const link of links) {
            if (!link.rect) continue
            const [r0, r1, r2, r3] = link.rect
            const minX = Math.min(r0, r2), maxX = Math.max(r0, r2)
            const minY = Math.min(r1, r3), maxY = Math.max(r1, r3)
            let topNorm = (minY - originY) / size.height
            const heightNorm = (maxY - minY) / size.height
            if (this.driver?.kind === 'pdfjs') {
                topNorm = (size.height - maxY) / size.height
            }
            const a = document.createElement('a')
            a.className = 'pdf-link-annot'
            a.style.position = 'absolute'
            a.style.left = `${((minX - originX) / size.width) * 100}%`
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
                a.title = t('pdf.jumpToPage', { page: link.page + 1 })
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
        this.visualVersion = (this.visualVersion || 0) + 1
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

        const theme = typeof document !== 'undefined' ? (document.documentElement?.getAttribute?.('data-theme') || '') : ''
        const isDark = theme === 'dark' || theme === 'black'

        for (const hl of highlights) {
            const segment = this._highlightSegment(hl, page)
            if (!segment) continue
            const rawColor = hl.color || '#facc15'
            const style = hl.style || 'highlight'
            const strokeColor = getHighlightStrokeHex(rawColor, isDark)
            const inkFill = getHighlightInkColor(rawColor, isDark, 0.38)

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
                        line.setAttribute('stroke', strokeColor)
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
                        line.setAttribute('stroke', strokeColor)
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
                        line.setAttribute('stroke', strokeColor)
                        line.setAttribute('stroke-width', '2')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else if (style === 'squiggly') {
                        poly.setAttribute('fill', 'transparent')
                        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
                        line.setAttribute('x1', q[4]); line.setAttribute('y1', q[5])
                        line.setAttribute('x2', q[6]); line.setAttribute('y2', q[7])
                        line.setAttribute('stroke', strokeColor)
                        line.setAttribute('stroke-width', '2')
                        line.setAttribute('stroke-dasharray', '2,2')
                        line.setAttribute('vector-effect', 'non-scaling-stroke')
                        line.style.pointerEvents = 'none'
                        s.append(line)
                    } else {
                        poly.setAttribute('fill', inkFill)
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
                    if (style === 'underline') el.style.borderBottom = `2.5px solid ${strokeColor}`
                    else if (style === 'dashed') el.style.borderBottom = `2px dashed ${strokeColor}`
                    else if (style === 'strikethrough') { el.style.borderBottom = `2px solid ${strokeColor}`; el.style.height = `${Math.max(0, y2 - y1) * 50}%` }
                    else if (style === 'squiggly') { el.style.borderBottom = `2px dotted ${strokeColor}` }
                    else el.style.backgroundColor = inkFill
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

    _handleDomSelection(isAdditive = false) {
        if (this.interactionMode === 'draw') return
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || !selection.rangeCount) return
        const selectedText = selection.toString().trim()
        if (!selectedText) return
        const range = selection.getRangeAt(0)
        const layerOf = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('.pdf-text-layer')
        const start = layerOf(range.startContainer)
        const end = layerOf(range.endContainer)
        const pageOf = layer => Number(layer?.closest('.pdf-page-slot')?.dataset.page)
        const startPage = pageOf(start)
        const endPage = pageOf(end)
        if (!start || !end || !this.activeSlots.get(startPage)?.contains(start) ||
            !this.activeSlots.get(endPage)?.contains(end)) return

        const segments = []
        let clientRect
        for (let page = Math.min(startPage, endPage); page <= Math.max(startPage, endPage); page++) {
            const layer = this.activeSlots.get(page)?.querySelector('.pdf-text-layer')
            if (!layer || !range.intersectsNode(layer)) continue
            const root = layer.querySelector('.textLayer') || layer
            const pageRange = range.cloneRange()
            if (layer !== start) pageRange.setStart(root, 0)
            if (layer !== end) pageRange.setEnd(root, root.childNodes.length)
            const text = pageRange.toString().trim()
            if (!text) continue

            const { left, top, width, height } = layer.getBoundingClientRect()
            if (width <= 0 || height <= 0) continue
            const boxes = [...pageRange.getClientRects()].filter(rect => rect.width > .5 && rect.height > .5)
            if (!boxes.length) continue
            clientRect ??= boxes[0].toJSON()
            const rects = boxes.map(box => [
                clamp((box.left - left) / width, 0, 1),
                clamp((box.top - top) / height, 0, 1),
                clamp((box.right - left) / width, 0, 1),
                clamp((box.bottom - top) / height, 0, 1),
            ])
            segments.push({ page, text, rects })
        }
        if (!segments.length) return false
        const [first] = segments
        this._hasPdfDomSelection = true
        const payload = {
            page: first.page, text: selectedText, rects: first.rects,
            segments: segments.length > 1 ? segments : null, clientRect,
        }
        this._commitPdfSelection(payload, { isAdditive, dragId: this._domSelectionDragId, isDom: true })
        return true
    }

    _commitPdfSelection(payload, { isAdditive = false, dragId = null, isDom = false } = {}) {
        if (!payload?.text?.trim()) return
        if (!isAdditive) {
            this._multiSelections = []
            this._lastSingleSelection = { ...payload, _dragId: dragId }
            this._redrawMultiSelections()
            this.options.onSelection?.(payload)
            return
        }

        if (this._multiSelections.length === 0 && this._lastSingleSelection) {
            this._multiSelections.push(this._lastSingleSelection)
        }
        const nextEntry = { ...payload, _dragId: dragId }
        const last = this._multiSelections[this._multiSelections.length - 1]
        const isSameDragUpdate = dragId != null && last?._dragId === dragId
        const isExactDuplicate = last &&
            last.page === nextEntry.page &&
            last.text === nextEntry.text &&
            JSON.stringify(last.rects?.[0] || null) === JSON.stringify(nextEntry.rects?.[0] || null)
        if (isSameDragUpdate || isExactDuplicate) {
            this._multiSelections[this._multiSelections.length - 1] = nextEntry
        } else {
            this._multiSelections.push(nextEntry)
        }
        this._lastSingleSelection = nextEntry
        this._redrawMultiSelections({ excludeLast: isDom })

        const cleanList = this._multiSelections.map(({ _dragId, ...rest }) => rest)
        const combinedText = cleanList.map(item => item.text).filter(Boolean).join('\n')
        this.options.onSelection?.({
            ...payload,
            text: cleanList.length > 1 ? combinedText : payload.text,
            multiSelections: cleanList.length > 1 ? cleanList : null,
        })
    }

    _redrawMultiSelections({ excludeLast = false } = {}) {
        if (typeof document === 'undefined') return
        this._multiSelectExcludeLast = excludeLast
        for (const [page, slot] of this.activeSlots) {
            this._renderMultiSelectionsForPage(page, slot.querySelector('.pdf-multi-select-layer'))
        }
    }

    _renderMultiSelectionsForPage(page, layer) {
        if (!layer) return
        layer.replaceChildren()
        if (!this._multiSelections?.length) return
        const items = this._multiSelectExcludeLast
            ? this._multiSelections.slice(0, Math.max(0, this._multiSelections.length - 1))
            : this._multiSelections
        if (!items.length) return

        const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
        const x0 = size.x0 || 0, y0 = size.y0 || 0
        let svg = null

        for (const item of items) {
            const segs = Array.isArray(item.segments) && item.segments.length
                ? item.segments
                : [{ page: item.page, quads: item.quads, rects: item.rects }]
            for (const seg of segs) {
                if (seg.page !== page) continue
                if (seg.quads?.length) {
                    if (!svg) {
                        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
                        svg.setAttribute('viewBox', `${x0} ${y0} ${size.width} ${size.height}`)
                    }
                    for (const q of seg.quads) {
                        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
                        poly.setAttribute('points', `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`)
                        svg.append(poly)
                    }
                } else if (seg.rects?.length) {
                    for (const [rx1, ry1, rx2, ry2] of seg.rects) {
                        const el = document.createElement('div')
                        el.className = 'pdf-multi-select-rect'
                        Object.assign(el.style, {
                            left: `${rx1 * 100}%`,
                            top: `${ry1 * 100}%`,
                            width: `${Math.max(0, rx2 - rx1) * 100}%`,
                            height: `${Math.max(0, ry2 - ry1) * 100}%`,
                        })
                        layer.append(el)
                    }
                }
            }
        }
        if (svg) layer.append(svg)
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
                if (quadArea(ch.quad) < 1e-4) return box
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
        if (!this._pageOcrSpans) this._pageOcrSpans = new Map()
        const normalizedSpans = Array.isArray(ocrSpans) ? ocrSpans : []
        const chars = []
        let lineIdx = 0
        for (const span of normalizedSpans) {
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
        this._pageOcrSpans.set(page, normalizedSpans)
        this._nativeGeometry.delete(page)
        this._nativeGeometryUse.delete(page)

        const slot = this.activeSlots?.get(page)
        if (slot) {
            this._renderOcrLayerForPage(page, slot.querySelector('.pdf-text-layer'))
        }
    }

    _renderOcrLayerForPage(page, textLayer, { appendOnly = false } = {}) {
        if (!textLayer) return
        const spans = this._pageOcrSpans?.get(page)
        if (!spans?.length) return
        const size = this.pageSizes?.[page] || { x0: 0, y0: 0 }
        const originX = Number(size.x0) || 0
        const originY = Number(size.y0) || 0
        const rawScale = Number(this.scale)
        const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1
        if (appendOnly) {
            textLayer.querySelectorAll('.pdf-ocr-span').forEach(el => el.remove())
        } else {
            textLayer.replaceChildren()
        }
        const isNativeMupdf = this.driver?.kind === 'mupdf'
        textLayer.style.display = 'block'
        textLayer.style.pointerEvents = isNativeMupdf ? 'none' : 'auto'
        for (const span of spans) {
            if (!span?.text) continue
            const spanEl = document.createElement('span')
            spanEl.className = 'pdf-ocr-span'
            spanEl.dataset.ocr = '1'
            spanEl.textContent = span.text
            const [x0, y0, x1, y1] = span.rect || [span.x || 0, span.y || 0, (span.x || 0) + (span.w || 10), (span.y || 0) + (span.h || 10)]
            const cssW = Math.max(1, (x1 - x0) * scale)
            const cssH = Math.max(1, (y1 - y0) * scale)
            spanEl.style.position = 'absolute'
            spanEl.style.left = `${(x0 - originX) * scale}px`
            spanEl.style.top = `${(y0 - originY) * scale}px`
            spanEl.style.width = `${cssW}px`
            spanEl.style.height = `${cssH}px`
            spanEl.style.fontSize = `${Math.max(8, cssH)}px`
            spanEl.style.lineHeight = '1'
            spanEl.style.whiteSpace = 'pre'
            spanEl.style.color = 'transparent'
            spanEl.style.userSelect = isNativeMupdf ? 'none' : 'text'
            textLayer.appendChild(spanEl)
        }
    }

    clearPageOcrData(page = null) {
        if (!this._pageOcrData && !this._pageOcrSpans) return
        if (page !== null) {
            this._pageOcrData?.delete(page)
            this._pageOcrSpans?.delete(page)
            this._nativeGeometry.delete(page)
            this._nativeGeometryUse.delete(page)
            const slot = this.activeSlots?.get(page)
            slot?.querySelectorAll?.('.pdf-ocr-span')?.forEach(el => el.remove())
        } else {
            this._pageOcrData?.clear()
            this._pageOcrSpans?.clear()
            this._nativeGeometry.clear()
            this._nativeGeometryUse.clear()
            for (const slot of this.activeSlots?.values() || []) {
                slot?.querySelectorAll?.('.pdf-ocr-span')?.forEach(el => el.remove())
            }
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
        const [px, py] = point
        const x0 = Math.floor((px - effMaxDist) / cellSize), x1 = Math.floor((px + effMaxDist) / cellSize)
        const y0 = Math.floor((py - effMaxDist) / cellSize), y1 = Math.floor((py + effMaxDist) / cellSize)
        const seen = new Set()
        let best = null, dist = effMaxDist * effMaxDist
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const ids = grid.get(`${x}:${y}`)
                if (!ids) continue
                for (const id of ids) {
                    if (seen.has(id)) continue
                    seen.add(id)
                    const ch = chars[id]
                    const d = pointToQuadDistanceSq(px, py, ch.quad)
                    if (d === 0) return ch
                    if (d < dist || (!best && d === dist)) {
                        dist = d
                        best = ch
                    }
                }
            }
        }
        return best
    }

    async _nativePointerDown(e) {
        if (this.interactionMode === 'draw' || this.driver?.kind !== 'mupdf' || e.button !== 0 || e.pointerType === 'touch') return
        this._suppressSelectionClick = false
        this._nativeClickOnText = false
        const epoch = ++this._nativeGestureEpoch
        this._nativeDrag = null
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const isInsideSlot = e.clientX >= hit.rect.left && e.clientX <= hit.rect.right &&
            e.clientY >= hit.rect.top && e.clientY <= hit.rect.bottom
        if (!isInsideSlot) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        // Register the gesture before the first async hit test. A fast release
        // must await it, rather than leave a drag alive after the button is up.
        const drag = this._nativeDrag = {
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
            isAdditive: Boolean(e.ctrlKey || e.metaKey || this._ctrlSelectHeld),
            anchor: null,
            focus: null,
            released: false
        }
        drag.ready = this._hitNativeChar(hit.page, point, 16).then(ch => {
            if (this._nativeDrag !== drag || epoch !== this._nativeGestureEpoch || this._destroyed) return false
            if (!ch || this.interactionMode === 'draw') {
                this._nativeDrag = null
                return false
            }
            this._nativeClickOnText = true
            drag.anchor = { page: hit.page, index: ch.index, point }
            drag.focus = { ...drag.anchor }
            return true
        }).catch(() => {
            if (this._nativeDrag === drag) this._nativeDrag = null
            return false
        })
        await drag.ready
    }

    async _nativePointerMove(e) {
        if (this.interactionMode === 'draw' || e.pointerType === 'touch') return
        const drag = this._nativeDrag
        if (!drag || drag.released || e.pointerId !== drag.pointerId) return
        if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
            this.clearSelection()
            return
        }
        if (e.pointerType === 'mouse' && e.buttons !== 1) {
            this.clearSelection()
            return
        }
        if (!drag.hasMoved) {
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
                drag.hasMoved = true
                if (drag.isAdditive || e.ctrlKey || e.metaKey || this._ctrlSelectHeld) {
                    drag.isAdditive = true
                    if (this._multiSelections.length === 0 && this._lastSingleSelection) {
                        this._multiSelections.push(this._lastSingleSelection)
                        this._redrawMultiSelections({ excludeLast: false })
                    }
                    this._nativePreview = null
                    this._redrawNativePreview()
                } else {
                    this._multiSelections = []
                    this._lastSingleSelection = null
                    this._redrawMultiSelections()
                    this._clearNativePreview()
                }
                try { this.scrollArea.setPointerCapture?.(e.pointerId) } catch (_) {}
            } else {
                return
            }
        }
        drag.lastClientX = e.clientX
        drag.lastClientY = e.clientY
        const moveSeq = (drag.moveSeq = (drag.moveSeq || 0) + 1)
        if (drag.ready && !await drag.ready) return
        if (drag.released || this._nativeDrag !== drag || drag.epoch !== this._nativeGestureEpoch) return
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
        if (drag.focus.page === hit.page && drag.focus.index === ch.index) return
        drag.focus = { page: hit.page, index: ch.index, point }
        if (!drag.released) this._scheduleNativePreview()
    }

    async _nativePointerUp(e) {
        const drag = this._nativeDrag
        if (!drag || e.pointerId !== drag.pointerId) return
        drag.released = true
        if (drag.hasMoved) this._suppressSelectionClick = true
        try { this.scrollArea.releasePointerCapture?.(e.pointerId) } catch (_) {}

        if (drag.ready && !await drag.ready) {
            if (this._nativeDrag === drag) this._nativeDrag = null
            return
        }
        // Incorporate latest move sample if still pending
        if (drag.pendingHitPromise) {
            try { await drag.pendingHitPromise } catch (_) {}
        }
        // Sample final release position when coordinates moved OR no move hit was ever applied
        const finalX = e.clientX ?? drag.lastClientX
        const finalY = e.clientY ?? drag.lastClientY
        if (finalX != null && finalY != null &&
            (!drag.appliedMoveSeq || finalX !== drag.lastClientX || finalY !== drag.lastClientY)) {
            const hit = this._slotForPoint(finalX, finalY)
            if (hit) {
                const point = this._clientToPage(hit, finalX, finalY)
                const ch = await this._hitNativeChar(hit.page, point, 36).catch(() => null)
                if (ch && drag.epoch === this._nativeGestureEpoch) {
                    drag.focus = { page: hit.page, index: ch.index, point }
                }
            }
        }

        if (this._destroyed || this._nativeDrag !== drag || drag.epoch !== this._nativeGestureEpoch) return
        this._nativeDrag = null
        this._nativeGestureEpoch++
        const postReleaseEpoch = this._nativeGestureEpoch

        if (this.interactionMode === 'draw') {
            this._clearNativePreview()
            return
        }
        if (!drag.hasMoved) return
        const isSameChar = drag.anchor.page === drag.focus.page && drag.anchor.index === drag.focus.index
        if (isSameChar) {
            this._clearNativePreview()
            return
        }
        const selection = await this._finalizeNativeSelection(drag.anchor, drag.focus, 'char').catch(err => {
            console.warn('[PDF] native selection failed:', err); return null
        })
        if (selection && !this._destroyed && this.interactionMode !== 'draw' && postReleaseEpoch === this._nativeGestureEpoch) {
            const isAdditive = Boolean(e.ctrlKey || e.metaKey || drag.isAdditive || this._ctrlSelectHeld)
            this._emitNativeSelection(selection, 'char', isAdditive)
        }
    }

    clearSelection() {
        if (this._isClearingSelection) return
        this._nativeGestureEpoch++
        this._hasPdfDomSelection = false
        this._multiSelections = []
        this._lastSingleSelection = null
        this._redrawMultiSelections()
        const drag = this._nativeDrag
        this._nativeDrag = null
        if (drag?.pointerId != null) {
            try { this.scrollArea.releasePointerCapture?.(drag.pointerId) } catch (_) {}
        }
        this._clearNativePreview()
        globalThis.getSelection?.()?.removeAllRanges?.()
    }

    _clearNativePreview() {
        if (!this._nativePreview?.length) return
        this._nativePreview = null
        this._redrawNativePreview()
        this._isClearingSelection = true
        try {
            this.options.onSelectionClear?.()
        } finally {
            this._isClearingSelection = false
        }
    }

    async _nativeDoubleClick(e) {
        if (this.interactionMode === 'draw' || this.driver?.kind !== 'mupdf') return
        const isAdditive = Boolean(e.ctrlKey || e.metaKey || this._ctrlSelectHeld)
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
            this._emitNativeSelection(selection, 'word', isAdditive)
        }
    }

    _handleTouchStart(e) {
        if (!e.touches) return
        if (e.touches.length === 2) {
            clearTimeout(this._singleTapTimer)
            this._singleTouchStart = null
            this._ignoreClickUntil = performance.now() + 500
            globalThis.app?.pageTurnController?.cancelCurrent?.()
            // Cancel any pending native drag or text selection
            this.clearSelection()
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
            // A swipe also starts with a finger down. Prepare text early only
            // if the finger stays on the same spot for a potential long press.
            if (this.options.deferPdfTextLayer && this.driver?.kind === 'pdfjs' && this.interactionMode !== 'draw') {
                const page = e.target.closest?.('.pdf-page-slot')?.dataset.page
                if (page != null) {
                    const gesture = this._singleTouchStart
                    clearTimeout(this._pdfTextPressTimer)
                    this._pdfTextPressTimer = setTimeout(() => {
                        this._pdfTextPressTimer = null
                        if (this._singleTouchStart === gesture && !gesture.moved) {
                            this._renderDeferredPdfTextLayer(Number(page))
                        }
                    }, 160)
                }
            }
        } else {
            if (this._pinch) this._cancelPinch()
        }
    }

    _handleTouchMove(e) {
        if (!e.touches) return
        if (this._singleTouchStart && e.touches.length === 1) {
            const touch = e.touches[0]
            if (Math.hypot(touch.clientX - this._singleTouchStart.x, touch.clientY - this._singleTouchStart.y) > 8) {
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
                this._notifyNavIdle()
            }
        } else if (e.changedTouches && e.changedTouches.length === 1 && this._singleTouchStart) {
            const touch = e.changedTouches[0]
            const dur = performance.now() - this._singleTouchStart.time
            const dist = Math.hypot(touch.clientX - this._singleTouchStart.x, touch.clientY - this._singleTouchStart.y)
            const moved = this._singleTouchStart.moved
            this._singleTouchStart = null

            if (globalThis.app?.pageTurnController?.shouldSuppressTap?.()) {
                clearTimeout(this._singleTapTimer)
                this._ignoreClickUntil = performance.now() + 450
                return
            }

            // Detect clean tap (< 450ms and moved < 8px)
            if (!moved && dur < 450 && dist < 8) {
                const now = performance.now()
                const dismissedLock = this._consumeDismissalLock()
                const curSelection = window.getSelection?.()
                const hasDomSelection = Boolean(curSelection && !curSelection.isCollapsed && curSelection.toString().trim())
                if (this._nativePreview?.length || hasDomSelection) {
                    this._lastTapTime = 0
                    this._ignoreClickUntil = now + 800
                    clearTimeout(this._singleTapTimer)
                    globalThis.app?.cancelPendingReaderUIToggle?.()
                    this.clearSelection()
                    return
                }
                const hlHit = this.interactionMode !== 'draw'
                    ? this._hitTestHighlightAtPoint(e.target, touch.clientX, touch.clientY)
                    : null
                if (hlHit) {
                    this._lastTapTime = 0
                    clearTimeout(this._singleTapTimer)
                    this._lastTapHandledTime = now
                    this._ignoreClickUntil = now + 800
                    globalThis.app?.cancelPendingReaderUIToggle?.()
                    this.options.onHighlightClick?.(hlHit.hl, e, hlHit.rect)
                    return
                }
                if (dismissedLock) {
                    this._lastTapTime = 0
                    this._ignoreClickUntil = now + 800
                    clearTimeout(this._singleTapTimer)
                    globalThis.app?.cancelPendingReaderUIToggle?.()
                    this.clearSelection()
                    return
                }
                if (this._lastTapTime && (now - this._lastTapTime < 320)) {
                    // Double tap detected!
                    const lastDist = Math.hypot(touch.clientX - this._lastTapPos.x, touch.clientY - this._lastTapPos.y)
                    if (lastDist < 30) {
                        this._lastTapTime = 0
                        clearTimeout(this._singleTapTimer)
                        globalThis.app?.cancelPendingReaderUIToggle?.()
                        this._ignoreClickUntil = now + 450
                        if (e.cancelable) e.preventDefault()
                        this._handleDoubleTapToggle(touch.clientX, touch.clientY)
                        return
                    }
                }
                this._lastTapTime = now
                this._lastTapPos = { x: touch.clientX, y: touch.clientY }
                if (this.options.onTap) {
                    this._lastTapHandledTime = now
                    this._ignoreClickUntil = now + 800
                    clearTimeout(this._singleTapTimer)
                    this._singleTapTimer = setTimeout(() => {
                        if (this._destroyed || this._pinch || this.interactionMode === 'draw') return
                        if (this._consumeDismissalLock()) {
                            this.clearSelection()
                            return
                        }
                        const selection = window.getSelection?.()
                        if (selection && !selection.isCollapsed && selection.toString().trim()) {
                            this.clearSelection()
                            return
                        }
                        if (this._nativePreview?.length) {
                            this.clearSelection()
                            return
                        }
                        this.options.onTap()
                    }, 330)
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
            this._notifyNavIdle()
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
        return { text:output.map(x=>x.text).filter(Boolean).join('\n'), segments:output }
    }

    async _updateNativePreview() {
        const drag = this._nativeDrag
        if (!drag || drag.released) return
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
            this._redrawNativePreview()
        } catch (err) {
            if (this._nativeDrag === drag && drag.epoch === epoch) console.warn('[PDF] native selection preview failed:', err)
        }
    }

    _scheduleNativePreview() {
        if (this._previewRaf) return
        if (typeof requestAnimationFrame !== 'function') {
            this._updateNativePreview()
            return
        }
        this._previewRaf = requestAnimationFrame(() => {
            this._previewRaf = null
            this._updateNativePreview()
        })
    }

    _redrawNativePreview() {
        if (typeof document === 'undefined') return
        for (const [page, slot] of this.activeSlots) this._renderNativePreviewForPage(page, slot.querySelector('.pdf-native-selection-layer'))
    }

    _renderNativePreviewForPage(page, layer) {
        if (!layer) return
        const segment = this._nativePreview?.find(x => x.page === page)
        if (!segment?.quads?.length) {
            if (layer.firstChild) layer.replaceChildren()
            return
        }
        const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
        const x0 = size.x0 || 0, y0 = size.y0 || 0
        const svg = document.createElementNS('http://www.w3.org/2000/svg','svg')
        svg.setAttribute('viewBox', `${x0} ${y0} ${size.width} ${size.height}`)
        for (const q of segment.quads) {
            const poly = document.createElementNS('http://www.w3.org/2000/svg','polygon')
            poly.setAttribute('points', `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`)
            svg.append(poly)
        }
        layer.replaceChildren(svg)
    }

    _quadToNormalizedRect(q, bounds) {
        const [x0,y0,x1,y1] = bounds, w = Math.max(.001,x1-x0), h = Math.max(.001,y1-y0)
        const b = quadBounds(q)
        return [clamp((b[0]-x0)/w,0,1),clamp((b[1]-y0)/h,0,1),clamp((b[2]-x0)/w,0,1),clamp((b[3]-y0)/h,0,1)]
    }

    _emitNativeSelection(selection, selectionMode = 'char', isAdditive = false) {
        if (!selection?.text?.trim() || !selection.segments?.length) return
        this._nativePreview = selection.segments.map(s => ({ page:s.page, quads:s.quads }))
        this._redrawNativePreview()
        const first = selection.segments[0]
        const firstRect = first.rects[0] || [0,0,0,0]
        const slot = this.activeSlots.get(first.page)
        const r = (slot?.querySelector?.('.pdf-native-selection-layer') || slot)?.getBoundingClientRect()
        const clientRect = r ? {
            left:r.left+firstRect[0]*r.width, top:r.top+firstRect[1]*r.height,
            width:(firstRect[2]-firstRect[0])*r.width, height:(firstRect[3]-firstRect[1])*r.height,
        } : { left:innerWidth/2,top:innerHeight/2,width:1,height:1 }
        const payload = {
            page:first.page, text:selection.text, rects:first.rects, quads:first.quads,
            pageBounds:first.pageBounds, segments:selection.segments, coordinateVersion:'mupdf-page-v1', clientRect,
            selectionMode,
        }
        this._commitPdfSelection(payload, { isAdditive, isDom: false })
    }

    _updateRenderConcurrency() {
        if (this.options?.isLowMemoryDevice) {
            this._renderConcurrency = 1
            return
        }
        const maxBudget = this._budgetRenderConcurrency || 2
        if (this.driver?.kind === 'mupdf') {
            const canSubmitTwo = this.spreadMode === 'dual' || this.driver.parallelRendering
            this._renderConcurrency = Math.min(maxBudget, canSubmitTwo ? 2 : 1)
        } else {
            this._renderConcurrency = Math.min(maxBudget, 2)
        }
    }

    setSpreadMode(mode) {
        const nextMode = (mode === 'dual' || mode === '2' || mode === 'two') ? 'dual' : 'none'
        if (this.spreadMode === nextMode) return
        const curPage = this.currentPage
        this.spreadMode = nextMode
        this.visualVersion = (this.visualVersion || 0) + 1
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
        const rows = this._ensureLayoutRows()
        if (!rows.length) return 0
        const top = this.scrollArea.scrollTop, centerY = top + this.scrollArea.clientHeight / 2
        const left = this.scrollArea.scrollLeft, centerX = left + this.scrollArea.clientWidth / 2
        const fallbackWidth = this._layoutWidth || this.scrollArea.clientWidth || 0

        const rowIdx = Math.min(rows.length - 1, this._firstRowAt(centerY))
        const minRow = Math.max(0, rowIdx - 1)
        const maxRow = Math.min(rows.length - 1, rowIdx + 1)

        let best = clamp(this.currentPage || 0, 0, this.pageOffsets.length - 1)
        let minDistanceSq = Infinity

        for (let r = minRow; r <= maxRow; r++) {
            const row = rows[r]
            for (let i = row.startPage; i <= row.endPage; i++) {
                const p = this.pageOffsets[i]
                if (!p) continue
                const pLeft = p.left != null ? p.left : (fallbackWidth - p.width) / 2
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
        const spreadFactor = (this.spreadMode === 'dual' && page > 0) ? 2.0 : 1
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
        return Boolean(
            this._pinch ||
            this.interactionMode === 'draw' ||
            this.canPanHorizontally() ||
            this._nativePreview?.length ||
            this._nativeDrag?.hasMoved ||
            (selection && !selection.isCollapsed && selection.toString().trim())
        )
    }

    shouldIgnoreContentClick() {
        return Boolean(this._pinch || this.interactionMode === 'draw' || (performance.now() < this._ignoreClickUntil))
    }

    _getPageLeftOffset(p) {
        if (!p) return 0
        return (this.spreadMode === 'dual' && p.left != null)
            ? p.left
            : (this._layoutWidth - p.width) / 2
    }

    _captureZoomAnchor(clientX = null, clientY = null, page = this.currentPage) {
        const rect = this.scrollArea.getBoundingClientRect?.() || { left: 0, top: 0 }
        const viewX = clientX == null ? (this.scrollArea.clientWidth || this.container.clientWidth) / 2 : clientX - rect.left
        const viewY = clientY == null ? 0 : clientY - rect.top
        const p = this.pageOffsets[page]
        const left = this._getPageLeftOffset(p)
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
            this._getPageLeftOffset(p) + anchor.normX * p.width - anchor.viewX
        this.scrollArea.scrollLeft = clamp(x, 0, Math.max(0, this._layoutWidth - width))
        this.scrollArea.scrollTop = clamp(p.top + anchor.normY * p.height - anchor.viewY, 0, Math.max(0, this.totalHeight - height))
    }

    setPageAppearance(appearanceOrOpts = 'original', themeInfo = null) {
        const opts = (typeof appearanceOrOpts === 'object' && appearanceOrOpts !== null)
            ? appearanceOrOpts
            : {
                appearance: appearanceOrOpts === 'night' ? 'night' : (appearanceOrOpts === 'auto' ? 'auto' : 'original'),
                ...(themeInfo || {}),
            }
        this.pageAppearance = opts.appearance === 'night' ? 'night' : (opts.appearance === 'auto' ? 'auto' : 'original')
        const activeTheme = opts.theme || (typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('data-theme') : 'light') || 'light'
        const filterVal = resolvePdfPageFilter({
            appearance: this.pageAppearance,
            theme: activeTheme,
            customBackground: opts.customBackground,
            customForeground: opts.customForeground,
        })
        if (this.container?.style) {
            if (filterVal) this.container.style.setProperty('--pdf-page-filter', filterVal)
            else this.container.style.removeProperty('--pdf-page-filter')
        }
        this.visualVersion = (this.visualVersion || 0) + 1
    }

    setZoom(value, { anchor = null, render = true } = {}) {
        this.zoomMode = value === 'fit-width' || value === 'fit-page' ? value : null
        const next = clamp(this.zoomMode ? this.getFitScale(value) : Number(value), this.options.minScale, this.options.maxScale)
        if (!Number.isFinite(next)) return
        const scaleChanged = Math.abs(next - this.scale) > 1e-6
        const layoutChanged = scaleChanged || this._layoutViewportWidth !== this.scrollArea.clientWidth || this._layoutViewportHeight !== this.scrollArea.clientHeight
        if (!layoutChanged) { this.options.onZoomChange?.(this.scale); return }
        const viewAnchor = anchor || this._captureZoomAnchor()
        this.scale = next
        this._recomputeLayout()
        this._restoreZoomAnchor(viewAnchor)
        this._syncActiveSlotGeometry()
        this.visualVersion = (this.visualVersion || 0) + 1
        this.options.onZoomChange?.(this.scale)
        if (scaleChanged) {
            clearTimeout(this._zoomRefineTimer)
            this._zoomRefineTimer = null
            for (const slot of this.activeSlots.values()) {
                slot._renderedClip = null
                slot._needsClipRefine = false
                // Old tile positions are CSS pixels at the previous zoom. The full
                // page preview scales with its wrapper while a fresh raster is made.
                slot.querySelectorAll('.pdf-clip-canvas').forEach(canvas => {
                    canvas.remove()
                    canvas.width = canvas.height = 0
                })
            }
        }
        if (render) this._renderVisibleSlots(scaleChanged)
        this._redrawNativePreview()
        this._redrawMultiSelections({ excludeLast: Boolean(this._multiSelectExcludeLast) })
    }

    setInteractionMode(mode) {
        const next = mode === 'draw' ? 'draw' : 'select'
        if (this.interactionMode === next) return
        this.interactionMode = next
        if (next === 'draw') {
            this.clearSelection()
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

    _getPageBoxMetrics(pageIndex, { ignoreOffsets = false } = {}) {
        const size = this.pageSizes?.[pageIndex] || { width: 595, height: 842, x0: 0, y0: 0 }
        const rawScale = Number(this.scale)
        const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1
        const pageWidth = Number(size.width) > 0 ? Number(size.width) : 595
        const pageHeight = Number(size.height) > 0 ? Number(size.height) : 842
        const x0 = Number(size.x0) || 0
        const y0 = Number(size.y0) || 0
        const margins = this._getCropMarginsForPage(pageIndex)
        const uncroppedWidth = Math.max(1, Math.round(pageWidth * scale))
        const uncroppedHeight = Math.max(1, Math.round(pageHeight * scale))
        const cropLeftPx = Math.round((margins.left / 100) * uncroppedWidth)
        const cropRightPx = Math.round((margins.right / 100) * uncroppedWidth)
        const cropTopPx = Math.round((margins.top / 100) * uncroppedHeight)
        const cropBottomPx = Math.round((margins.bottom / 100) * uncroppedHeight)
        const croppedWidth = Math.max(1, uncroppedWidth - cropLeftPx - cropRightPx)
        const croppedHeight = Math.max(1, uncroppedHeight - cropTopPx - cropBottomPx)
        const offset = !ignoreOffsets ? this.pageOffsets?.[pageIndex] : null
        const slotWidth = offset?.width > 0 ? offset.width : croppedWidth
        const slotHeight = offset?.height > 0 ? offset.height : croppedHeight
        return {
            size,
            x0,
            y0,
            pageWidth,
            pageHeight,
            scale,
            margins,
            uncroppedWidth,
            uncroppedHeight,
            cropLeftPx,
            cropRightPx,
            cropTopPx,
            cropBottomPx,
            croppedWidth,
            croppedHeight,
            slotWidth,
            slotHeight,
            contentOffsetX: -cropLeftPx,
            contentOffsetY: -cropTopPx,
        }
    }

    getPageViewportTransform(pageIndex, options = {}) {
        const offset = this.pageOffsets?.[pageIndex]
        const metrics = this._getPageBoxMetrics(pageIndex, { ignoreOffsets: !offset })
        const vw = Math.max(1, this.scrollArea?.clientWidth || this.container?.clientWidth || 1)
        const vh = Math.max(1, this.scrollArea?.clientHeight || this.container?.clientHeight || 1)
        const layoutW = this._layoutWidth || vw
        const totalH = this.totalHeight || vh
        const maxScrollLeft = Math.max(0, layoutW - vw)
        const maxScrollTop = Math.max(0, totalH - vh)
        const topPx = offset?.top ?? 16
        const useTarget = options.useTargetScrollForNonCurrent !== false
        const isCurrent = pageIndex === this.currentPage
        const scrollX = options.scrollLeft != null
            ? (Number(options.scrollLeft) || 0)
            : (isCurrent || !useTarget
                ? (this.scrollArea?.scrollLeft || 0)
                : clamp((layoutW - vw) / 2, 0, maxScrollLeft))
        const scrollY = options.scrollTop != null
            ? (Number(options.scrollTop) || 0)
            : (isCurrent || !useTarget
                ? (this.scrollArea?.scrollTop || 0)
                : clamp(Math.max(0, topPx - 8), 0, maxScrollTop))

        const slotWidth = offset?.width > 0 ? offset.width : metrics.slotWidth
        const slotHeight = offset?.height > 0 ? offset.height : metrics.slotHeight
        const slotX = (this.spreadMode === 'dual' && offset?.left != null)
            ? (offset.left - scrollX)
            : ((layoutW - slotWidth) / 2 - scrollX)
        const slotY = topPx - scrollY

        // Uncropped inner wrapper (.pdf-img-wrapper / .pdf-highlight-layer) origin in viewport CSS px
        const contentX = slotX + metrics.contentOffsetX
        const contentY = slotY + metrics.contentOffsetY
        const sx = metrics.uncroppedWidth / metrics.pageWidth
        const sy = metrics.uncroppedHeight / metrics.pageHeight

        return {
            pageIndex,
            viewportWidth: vw,
            viewportHeight: vh,
            scrollX,
            scrollY,
            slotX,
            slotY,
            slotWidth,
            slotHeight,
            contentX,
            contentY,
            contentWidth: metrics.uncroppedWidth,
            contentHeight: metrics.uncroppedHeight,
            cropLeftPx: metrics.cropLeftPx,
            cropTopPx: metrics.cropTopPx,
            cropRightPx: metrics.cropRightPx,
            cropBottomPx: metrics.cropBottomPx,
            x0: metrics.x0,
            y0: metrics.y0,
            pageWidth: metrics.pageWidth,
            pageHeight: metrics.pageHeight,
            scale: metrics.scale,
            margins: metrics.margins,
            pageToViewportPoint(px, py) {
                return {
                    x: contentX + ((Number(px) || 0) - metrics.x0) * sx,
                    y: contentY + ((Number(py) || 0) - metrics.y0) * sy,
                }
            },
            pageToContentPoint(px, py) {
                return {
                    x: ((Number(px) || 0) - metrics.x0) * sx,
                    y: ((Number(py) || 0) - metrics.y0) * sy,
                }
            },
            normalizedToViewportRect(rx1, ry1, rx2, ry2) {
                const x1 = contentX + (Number(rx1) || 0) * metrics.uncroppedWidth
                const y1 = contentY + (Number(ry1) || 0) * metrics.uncroppedHeight
                const x2 = contentX + (Number(rx2) || 0) * metrics.uncroppedWidth
                const y2 = contentY + (Number(ry2) || 0) * metrics.uncroppedHeight
                return {
                    x: x1,
                    y: y1,
                    width: Math.max(0, x2 - x1),
                    height: Math.max(0, y2 - y1),
                }
            },
            viewportToSlotPoint(vx, vy) {
                return { x: vx - slotX, y: vy - slotY }
            },
        }
    }

    _getVisibleClipWindow(pageIndex, pageOffset, options = {}) {
        const t = this.getPageViewportTransform(pageIndex, {
            useTargetScrollForNonCurrent: Boolean(options.useTargetScrollForNonCurrent),
            scrollLeft: options.scrollLeft,
            scrollTop: options.scrollTop,
        })
        const slotW = pageOffset?.width > 0 ? pageOffset.width : t.slotWidth
        const slotH = pageOffset?.height > 0 ? pageOffset.height : t.slotHeight
        const slotVisLeft = clamp(-t.slotX, 0, slotW)
        const slotVisRight = clamp(t.viewportWidth - t.slotX, 0, slotW)
        const slotVisTop = clamp(-t.slotY, 0, slotH)
        const slotVisBottom = clamp(t.viewportHeight - t.slotY, 0, slotH)
        const visWidth = Math.max(0, slotVisRight - slotVisLeft)
        const visHeight = Math.max(0, slotVisBottom - slotVisTop)
        const imgVisLeft = clamp(t.cropLeftPx + slotVisLeft, 0, t.contentWidth)
        const imgVisRight = clamp(t.cropLeftPx + slotVisRight, 0, t.contentWidth)
        const imgVisTop = clamp(t.cropTopPx + slotVisTop, 0, t.contentHeight)
        const imgVisBottom = clamp(t.cropTopPx + slotVisBottom, 0, t.contentHeight)
        return {
            viewportWidth: t.viewportWidth,
            viewportHeight: t.viewportHeight,
            uncroppedWidth: t.contentWidth,
            uncroppedHeight: t.contentHeight,
            visWidth,
            visHeight,
            imgVisLeft,
            imgVisRight,
            imgVisTop,
            imgVisBottom,
        }
    }

    _isClipCompleteForPage(pageIndex, slot) {
        const clip = slot?._renderedClip
        if (!clip) return false
        const clipScale = clip.scale ?? slot._renderedScale
        if (Number.isFinite(this.scale) && clipScale != null && Math.abs(clipScale - this.scale) > 1e-4) {
            return false
        }
        const clipCanvases = typeof slot.querySelectorAll === 'function'
            ? [...slot.querySelectorAll('.pdf-clip-canvas')]
            : []
        if (!clipCanvases.some(c => c && c.width > 0 && c.height > 0)) return false
        const p = this.pageOffsets?.[pageIndex]
        if (!p) return true
        const actualWin = this._getVisibleClipWindow(pageIndex, p, { useTargetScrollForNonCurrent: false })
        const clipWin = (actualWin.visHeight > 0 && actualWin.visWidth > 0)
            ? actualWin
            : this._getVisibleClipWindow(pageIndex, p, { useTargetScrollForNonCurrent: true })
        if (clipWin.visHeight <= 0 || clipWin.visWidth <= 0) return true
        const outOfV = clipWin.imgVisTop < (clip.top - 1) || clipWin.imgVisBottom > (clip.bottom + 1)
        const outOfH = clip.left != null && clip.right != null &&
            (clipWin.imgVisLeft < (clip.left - 1) || clipWin.imgVisRight > (clip.right + 1))
        return !outOfV && !outOfH
    }

    _notifyPageReadyWaiters(pageIndex) {
        const set = this._pageReadyWaiters?.get(pageIndex)
        if (!set || !set.size) return
        if (!this.isPageCanvasReady(pageIndex)) return
        this._pageReadyWaiters.delete(pageIndex)
        for (const entry of [...set]) {
            entry.cleanup?.()
            entry.resolve(true)
        }
    }

    _failPageReadyWaiters(pageIndex) {
        const set = this._pageReadyWaiters?.get(pageIndex)
        if (!set || !set.size) return
        this._pageReadyWaiters.delete(pageIndex)
        for (const entry of [...set]) {
            entry.cleanup?.()
            entry.resolve(false)
        }
    }

    _cancelAllPageReadyWaiters(ok = false) {
        if (!this._pageReadyWaiters?.size) return
        for (const [, set] of [...this._pageReadyWaiters.entries()]) {
            for (const entry of [...set]) {
                entry.cleanup?.()
                entry.resolve(Boolean(ok))
            }
        }
        this._pageReadyWaiters.clear()
    }

    isNavBusy() {
        if (this._destroyed) return false
        return Boolean(this._pinch || this._navigationRenderPending)
    }

    _notifyNavIdle(ok = true) {
        if (ok && this.isNavBusy()) return
        if (!this._navIdleWaiters?.size) return
        const waiters = [...this._navIdleWaiters]
        this._navIdleWaiters.clear()
        for (const entry of waiters) {
            entry.cleanup?.()
            entry.resolve(Boolean(ok && !this._destroyed))
        }
    }

    whenNavIdle({ signal = null, timeoutMs = 0 } = {}) {
        if (this._destroyed || signal?.aborted) return Promise.resolve(false)
        if (!this.isNavBusy()) return Promise.resolve(true)
        return new Promise(resolve => {
            let settled = false
            let timer = null
            const entry = {
                cleanup() {
                    if (timer != null) {
                        clearTimeout(timer)
                        timer = null
                    }
                    if (signal && onAbort) {
                        signal.removeEventListener('abort', onAbort)
                    }
                },
                resolve(val) {
                    if (settled) return
                    settled = true
                    entry.cleanup()
                    resolve(Boolean(val))
                },
            }
            const onAbort = () => {
                this._navIdleWaiters?.delete(entry)
                entry.resolve(false)
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true })
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this._navIdleWaiters?.delete(entry)
                    entry.resolve(false)
                }, timeoutMs)
            }
            if (!this._navIdleWaiters) this._navIdleWaiters = new Set()
            this._navIdleWaiters.add(entry)
        })
    }

    _computeVisualStateKey() {
        const scaleKey = Number.isFinite(this.scale) ? this.scale.toFixed(4) : '1.0000'
        let cropKey = 'none'
        if (this.cropSettings) {
            try { cropKey = JSON.stringify(this.cropSettings) } catch (_) { cropKey = String(this.cropSettings.mode || 'custom') }
        }
        const enhanceKey = this._scanEnhanceConfig?.preset || 'none'
        const theme = typeof document !== 'undefined' ? (document.documentElement?.getAttribute?.('data-theme') || '') : ''
        let containerFilter = ''
        let containerBg = ''
        let rootFilter = ''
        let rootBg = ''
        if (typeof getComputedStyle === 'function') {
            if (this.container && typeof Element !== 'undefined' && this.container instanceof Element) {
                const cs = getComputedStyle(this.container)
                containerFilter = (cs.getPropertyValue('--pdf-page-filter') || cs.getPropertyValue('--reader-img-filter') || '').trim()
                containerBg = (cs.backgroundColor || '').trim()
            }
            if (typeof document !== 'undefined' && document.documentElement) {
                const rs = getComputedStyle(document.documentElement)
                rootFilter = (rs.getPropertyValue('--pdf-page-filter') || rs.getPropertyValue('--reader-img-filter') || '').trim()
                rootBg = (rs.getPropertyValue('--book-bg') || '').trim()
            }
        }
        return `${this._loadGeneration || 0}|${this.spreadMode}|${scaleKey}|${cropKey}|${enhanceKey}|${this.pageAppearance}|${theme}|${containerFilter}|${rootFilter}|${containerBg}|${rootBg}|${this.highlights?.length || 0}`
    }

    getVisualVersion() {
        const stateKey = this._computeVisualStateKey()
        if (this._lastVisualStateKey !== null && this._lastVisualStateKey !== stateKey) {
            this.visualVersion = (this.visualVersion || 0) + 1
        }
        this._lastVisualStateKey = stateKey
        return this.visualVersion || 0
    }

    isPageCanvasReady(pageIndex) {
        if (this._destroyed || pageIndex == null || pageIndex < 0) return false
        const slot = this.activeSlots?.get(pageIndex)
        if (!slot || typeof slot.querySelector !== 'function') return false
        if (slot._renderError || slot._renderedIsPreview) return false
        if (Number.isFinite(this.scale) && slot._renderedScale != null && Math.abs(slot._renderedScale - this.scale) > 1e-4) {
            return false
        }
        if (slot._renderedToken != null && slot._renderToken != null && slot._renderedToken !== slot._renderToken) {
            return false
        }
        const mainCanvas = slot.querySelector('.pdf-page-canvas')
        if (mainCanvas && mainCanvas.width > 0 && mainCanvas.height > 0 && !slot._renderedClip) {
            return true
        }
        if (slot._renderedClip) {
            return this._isClipCompleteForPage(pageIndex, slot)
        }
        return false
    }

    ensurePageRendered(pageIndex) {
        if (this._destroyed || pageIndex == null || pageIndex < 0 || pageIndex >= (this.pageOffsets?.length || 0)) {
            return false
        }
        if (this.isPageCanvasReady(pageIndex)) {
            this._notifyPageReadyWaiters(pageIndex)
            return true
        }
        let slot = this.activeSlots?.get(pageIndex)
        if (!slot) {
            this._mountSlot?.(pageIndex)
            slot = this.activeSlots?.get(pageIndex)
        }
        if (!slot) return false
        slot._renderError = false

        if (this._navigationRenderPending && performance.now() >= (this._navigationRenderPending.due || 0)) {
            clearTimeout(this._navigationRenderTimer)
            this._navigationRenderTimer = null
            this._navigationRenderPending = null
            this._navigationBurstCount = 0
            this._notifyNavIdle(true)
        }

        const inFlight = this._inFlightRenders?.get(pageIndex)
        if (inFlight?.previewOnly && !inFlight.abortController?.signal?.aborted) {
            slot._renderToken = (slot._renderToken || 0) + 1
            slot.renderAbort?.abort()
            slot.renderAbort = new AbortController()
            if (this._inFlightRenders.get(pageIndex) === inFlight) {
                this._inFlightRenders.delete(pageIndex)
            }
        }

        let promotedQueued = false
        if (Array.isArray(this._renderQueue)) {
            for (const queued of this._renderQueue) {
                if (queued.page === pageIndex && queued.slot === slot && queued.token === slot._renderToken) {
                    queued.previewOnly = false
                    queued.tier = 0
                    queued.explicitPriority = true
                    queued.distance = Math.abs(pageIndex - (this.currentPage || 0))
                    promotedQueued = true
                }
            }
        }

        if (!promotedQueued && !this._isPageQueuedOrRendering(pageIndex, slot._renderToken)) {
            slot._renderToken = (slot._renderToken || 0) + 1
            this._scheduleRender({
                page: pageIndex,
                slot,
                token: slot._renderToken,
                tier: 0,
                explicitPriority: true,
                distance: Math.abs(pageIndex - (this.currentPage || 0)),
                previewOnly: false,
            })
        }
        this._pumpRenderQueue()
        return false
    }

    whenPageReady(pageIndex, { signal = null, timeoutMs = 0 } = {}) {
        if (this._destroyed || signal?.aborted || pageIndex == null || pageIndex < 0 || pageIndex >= (this.pageOffsets?.length || 0)) {
            return Promise.resolve(false)
        }
        if (this.isPageCanvasReady(pageIndex)) return Promise.resolve(true)
        if (this.ensurePageRendered(pageIndex)) return Promise.resolve(true)
        if (!this.activeSlots?.get(pageIndex)) return Promise.resolve(false)

        return new Promise(resolve => {
            let settled = false
            let timer = null
            let set = this._pageReadyWaiters?.get(pageIndex)
            if (!set) {
                set = new Set()
                if (!this._pageReadyWaiters) this._pageReadyWaiters = new Map()
                this._pageReadyWaiters.set(pageIndex, set)
            }
            const entry = {
                cleanup() {
                    if (timer != null) {
                        clearTimeout(timer)
                        timer = null
                    }
                    if (signal && onAbort) {
                        signal.removeEventListener('abort', onAbort)
                    }
                },
                resolve(val) {
                    if (settled) return
                    settled = true
                    entry.cleanup()
                    resolve(Boolean(val))
                },
            }
            const onAbort = () => {
                set.delete(entry)
                if (!set.size) this._pageReadyWaiters?.delete(pageIndex)
                entry.resolve(false)
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true })
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    set.delete(entry)
                    if (!set.size) this._pageReadyWaiters?.delete(pageIndex)
                    entry.resolve(false)
                }, timeoutMs)
            }
            set.add(entry)
        })
    }

    captureCompositedPageSnapshot(pageIndex, options = {}) {
        if (this._destroyed || pageIndex == null || pageIndex < 0) return null
        if (typeof document === 'undefined') return null
        const slot = this.activeSlots?.get(pageIndex)
        const offset = this.pageOffsets?.[pageIndex]
        if (!slot || !offset) return null

        const mainCanvas = slot.querySelector('.pdf-page-canvas')
        const previewCanvas = slot.querySelector('.pdf-page-preview')
        const clipCanvases = [...slot.querySelectorAll('.pdf-clip-canvas')].reverse()
        const hasMain = Boolean(mainCanvas && mainCanvas.width > 0 && mainCanvas.height > 0 && !slot._renderedIsPreview)
        const hasClip = clipCanvases.some(c => c.width > 0 && c.height > 0)
        const hasPreview = Boolean(options.allowPreview && previewCanvas && previewCanvas.width > 0 && previewCanvas.height > 0)
        if (!hasMain && !hasClip && !hasPreview) return null

        const visualVersion = this.getVisualVersion()
        const t = this.getPageViewportTransform(pageIndex, options)
        const vw = t.viewportWidth
        const vh = t.viewportHeight
        const deviceDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1
        const dpr = clamp(
            deviceDpr,
            1,
            options.maxDpr || Math.min(Math.max(deviceDpr, 2), 3)
        )

        const outCanvas = document.createElement('canvas')
        outCanvas.width = Math.max(1, Math.round(vw * dpr))
        outCanvas.height = Math.max(1, Math.round(vh * dpr))
        const ctx = outCanvas.getContext?.('2d')
        if (!ctx) return null
        ctx.scale(dpr, dpr)

        const containerStyle = (typeof Element !== 'undefined' && this.container instanceof Element && typeof getComputedStyle === 'function')
            ? getComputedStyle(this.container)
            : null
        const rootStyle = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null
        const bgColor = (containerStyle?.backgroundColor && containerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && containerStyle.backgroundColor !== 'transparent')
            ? containerStyle.backgroundColor
            : (rootStyle?.getPropertyValue('--book-bg')?.trim() || '#ffffff')
        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, vw, vh)

        const slotStyle = (typeof Element !== 'undefined' && slot instanceof Element && typeof getComputedStyle === 'function')
            ? getComputedStyle(slot)
            : null
        const slotBg = (slotStyle?.backgroundColor && slotStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && slotStyle.backgroundColor !== 'transparent')
            ? slotStyle.backgroundColor
            : '#ffffff'
        ctx.fillStyle = slotBg
        ctx.fillRect(t.slotX, t.slotY, t.slotWidth, t.slotHeight)

        const rawFilter = (
            containerStyle?.getPropertyValue('--pdf-page-filter') ||
            rootStyle?.getPropertyValue('--pdf-page-filter') ||
            containerStyle?.getPropertyValue('--reader-img-filter') ||
            rootStyle?.getPropertyValue('--reader-img-filter') ||
            ''
        ).trim()

        // Clip everything rendered inside this slot to its cropped viewport bounds
        ctx.save()
        ctx.beginPath()
        ctx.rect(t.slotX, t.slotY, t.slotWidth, t.slotHeight)
        ctx.clip()

        ctx.save()
        if (rawFilter && rawFilter !== 'none') {
            ctx.filter = rawFilter
        }
        if (previewCanvas && previewCanvas.width > 0 && previewCanvas.height > 0) {
            ctx.drawImage(previewCanvas, t.contentX, t.contentY, t.contentWidth, t.contentHeight)
        }
        if (mainCanvas && mainCanvas.width > 0 && mainCanvas.height > 0) {
            ctx.drawImage(mainCanvas, t.contentX, t.contentY, t.contentWidth, t.contentHeight)
        }
        for (const clip of clipCanvases) {
            if (!clip.width || !clip.height) continue
            const cx = t.contentX + (parseFloat(clip.style.left) || 0)
            const cy = t.contentY + (parseFloat(clip.style.top) || 0)
            const cw = parseFloat(clip.style.width) || t.contentWidth
            const ch = parseFloat(clip.style.height) || t.contentHeight
            ctx.drawImage(clip, cx, cy, cw, ch)
        }
        ctx.restore()

        // Composite highlight quads/rects in shared uncropped content space (clipped to slot)
        const pageHighlights = this.highlightsByPage?.get(pageIndex)
        if (pageHighlights?.length && t.pageWidth > 0 && t.pageHeight > 0) {
            const theme = document.documentElement?.getAttribute?.('data-theme') || ''
            const hlBlend = (theme === 'dark' || theme === 'black' || this.pageAppearance === 'night')
                ? 'screen'
                : 'multiply'
            ctx.save()
            for (const hl of pageHighlights) {
                const seg = this._highlightSegment?.(hl, pageIndex)
                const color = hl.color || '#facc15'
                const style = hl.style || 'highlight'
                if (seg?.quads?.length) {
                    for (const q of seg.quads) {
                        const p0 = t.pageToViewportPoint(q[0], q[1])
                        const p1 = t.pageToViewportPoint(q[2], q[3])
                        const p2 = t.pageToViewportPoint(q[6], q[7])
                        const p3 = t.pageToViewportPoint(q[4], q[5])
                        if (style === 'highlight') {
                            ctx.globalCompositeOperation = hlBlend
                            ctx.fillStyle = this._toRgba(color, 0.38)
                            ctx.beginPath()
                            ctx.moveTo(p0.x, p0.y)
                            ctx.lineTo(p1.x, p1.y)
                            ctx.lineTo(p2.x, p2.y)
                            ctx.lineTo(p3.x, p3.y)
                            ctx.closePath()
                            ctx.fill()
                        } else {
                            ctx.globalCompositeOperation = 'source-over'
                            ctx.strokeStyle = style === 'dashed' && color === '#facc15' ? '#64748b' : color
                            ctx.lineWidth = style === 'underline' ? 2.5 : 2
                            ctx.setLineDash(style === 'dashed' ? [4, 3] : style === 'squiggly' ? [2, 2] : [])
                            ctx.beginPath()
                            if (style === 'strikethrough') {
                                ctx.moveTo((p0.x + p3.x) / 2, (p0.y + p3.y) / 2)
                                ctx.lineTo((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
                            } else {
                                ctx.moveTo(p3.x, p3.y)
                                ctx.lineTo(p2.x, p2.y)
                            }
                            ctx.stroke()
                            ctx.setLineDash([])
                        }
                    }
                } else if (seg?.rects?.length) {
                    for (const rect of seg.rects) {
                        const box = t.normalizedToViewportRect(rect[0], rect[1], rect[2], rect[3])
                        if (style === 'highlight') {
                            ctx.globalCompositeOperation = hlBlend
                            ctx.fillStyle = this._toRgba(color, 0.38)
                            ctx.fillRect(box.x, box.y, box.width, box.height)
                        } else {
                            ctx.globalCompositeOperation = 'source-over'
                            ctx.strokeStyle = style === 'dashed' && color === '#facc15' ? '#64748b' : color
                            ctx.lineWidth = style === 'underline' ? 2.5 : 2
                            ctx.setLineDash(style === 'dashed' ? [4, 3] : style === 'squiggly' ? [2, 2] : [])
                            ctx.beginPath()
                            const ly = style === 'strikethrough' ? (box.y + box.height * 0.5) : (box.y + box.height)
                            ctx.moveTo(box.x, ly)
                            ctx.lineTo(box.x + box.width, ly)
                            ctx.stroke()
                            ctx.setLineDash([])
                        }
                    }
                }
            }
            ctx.restore()
        }

        // Composite ink drawing layers (aligned to uncropped page content space)
        const drawCanvases = new Set(slot.querySelectorAll('.pdf-draw-base-canvas, .pdf-draw-overlay-canvas, .pdf-draw-active-canvas'))
        for (const drawCvs of drawCanvases) {
            if (drawCvs && drawCvs.width > 0 && drawCvs.height > 0) {
                ctx.drawImage(drawCvs, t.contentX, t.contentY, t.contentWidth, t.contentHeight)
            }
        }
        ctx.restore()

        return {
            canvas: outCanvas,
            width: vw,
            height: vh,
            bgColor,
            pageIndex,
            visualVersion,
        }
    }

    _noteNavigationRequest() {
        const now = performance.now()
        const dt = now - (this._lastNavigationRequestAt ?? -Infinity)
        this._lastNavigationRequestAt = now
        clearTimeout(this._prefetchTimer)
        this._prefetchTimer = null
        if (dt >= 0 && dt < 85) {
            this._navigationBurstCount = (this._navigationBurstCount || 0) + 1
            const pending = this._navigationRenderPending
            const started = pending?.started ?? now
            const elapsedBurst = now - started
            const shouldEmitPreview = elapsedBurst >= 110
            const due = shouldEmitPreview ? now : (now + clamp(dt + 16, 42, 72))
            this._navigationRenderPending = { started, due }
            clearTimeout(this._navigationRenderTimer)
            this._navigationRenderTimer = setTimeout(() => {
                if (shouldEmitPreview) this._flushNavigationPreview()
                else this._flushNavigationRender()
            }, Math.max(0, due - now))
            return
        }
        this._navigationBurstCount = 0
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        this._navigationRenderPending = null
        this._notifyNavIdle(true)
    }

    _flushNavigationPreview() {
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        if (this._destroyed) return
        const started = performance.now()
        this._navigationRenderPending = null
        this._renderVisibleSlots(false, { previewOnly: true })
        // Arm final full-res settle in case the burst stops without a synthetic keyup
        const settleDelay = 75
        this._navigationRenderPending = { started, due: started + settleDelay }
        this._navigationRenderTimer = setTimeout(() => this._flushNavigationRender(), settleDelay)
    }

    _flushNavigationRender() {
        this._navigationBurstCount = 0
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        if (!this._navigationRenderPending) return
        this._navigationRenderPending = null
        if (!this._destroyed) this._renderVisibleSlots()
        this._notifyNavIdle(!this._destroyed)
    }

    getReadingLocation() {
        const page = this.currentPage
        const offset = this.pageOffsets[page]
        const scrollTop = this.scrollArea.scrollTop
        const yRatio = offset?.height && scrollTop > Math.max(0, offset.top - 8)
            ? clamp((scrollTop - offset.top + this.scrollArea.clientHeight / 3) / offset.height, 0, 1)
            : 0
        return { page: page + 1, yRatio }
    }

    goToPage(page, yRatio = 0, { preserveHorizontal = true } = {}) {
        if (page < 0 || page >= this.pageOffsets.length) return
        this.clearLocatePulse()
        if (page !== this.currentPage) {
            this._lastNavigationDirection = page > this.currentPage ? 1 : -1
        }
        this._noteNavigationRequest()
        const viewWidth = this.scrollArea.clientWidth || this.container?.clientWidth || 0
        const prevScrollLeft = this.scrollArea.scrollLeft || 0
        this.currentPage = page
        if (this.zoomMode) this.setZoom(this.zoomMode, { render: false })
        const p = this.pageOffsets[page]
        const targetTop = Math.max(0, p.top + p.height * clamp(yRatio, 0, 1) - (yRatio ? this.scrollArea.clientHeight / 3 : 8))
        this.scrollArea.scrollTop = targetTop
        const maxScrollLeft = Math.max(0, (this._layoutWidth || 0) - viewWidth)
        if (!this.zoomMode && preserveHorizontal && maxScrollLeft > 0) {
            this.scrollArea.scrollLeft = clamp(prevScrollLeft, 0, maxScrollLeft)
        } else if (preserveHorizontal === false) {
            this.scrollArea.scrollLeft = maxScrollLeft > 0 ? Math.round(maxScrollLeft / 2) : 0
        }
        this._renderVisibleSlots()
        this.options.onPageChange?.(page, this.numPages)
    }

    pulseRects(page, rects) {
        if (!rects?.length) return
        const slot = this.activeSlots.get(page)
        if (!slot) { this._pendingPulse = { pageIdx:page, rects }; return }
        const targetLayer = slot.querySelector('.pdf-highlight-layer') || slot
        slot.querySelectorAll('.pdf-search-pulse').forEach(x=>x.remove())
        for (const [x1,y1,x2,y2] of rects) {
            const el = document.createElement('div'); el.className='pdf-search-pulse'
            Object.assign(el.style,{left:`${x1*100}%`,top:`${y1*100}%`,width:`${Math.max((x2-x1)*100,2)}%`,height:`${Math.max((y2-y1)*100,1.5)}%`})
            targetLayer.append(el); setTimeout(()=>el.remove(),2400)
        }
    }

    clearLocatePulse() {
        if (this._locatePulseTimer) {
            clearTimeout(this._locatePulseTimer)
            this._locatePulseTimer = null
        }
        this._pendingHighlightPulse = null
        for (const el of this._locatePulseEls || []) {
            try { el.remove() } catch (_) {}
        }
        this._locatePulseEls = []
        for (const slot of this.activeSlots?.values() || []) {
            slot.querySelectorAll('.pdf-locate-pulse-layer').forEach(el => el.remove())
        }
    }

    pulseHighlight(page, id, fallbackRects, color = null) {
        this.clearLocatePulse()
        const slot = this.activeSlots.get(page)
        if (!slot) {
            this._pendingHighlightPulse = { pageIdx: page, highlightId: id, fallbackRects, color }
            return
        }

        const hl = this.highlights?.find(h => String(h.id) === String(id)) || null
        const resolvedColor = color || hl?.color || '#facc15'
        const theme = typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('data-theme') : ''
        const isDark = theme === 'dark' || theme === 'black'
        const pulsePalette = computePulseDeepenedColor(resolvedColor, isDark)

        // Collect target quads or normalized rects for this page
        let quads = null
        let rects = null
        if (hl?.pdfTarget) {
            const segs = Array.isArray(hl.pdfTarget.segments) && hl.pdfTarget.segments.length
                ? hl.pdfTarget.segments
                : [{ page: hl.pdfTarget.page, quads: hl.pdfTarget.quads, rects: hl.pdfTarget.rects }]
            const seg = segs.find(s => s.page === page)
            if (seg?.quads?.length) quads = seg.quads
            if (seg?.rects?.length) rects = seg.rects
        }
        if (!quads?.length && !rects?.length && fallbackRects?.length) {
            rects = fallbackRects
        }
        if (!quads?.length && !rects?.length) return

        const pulseLayer = document.createElement('div')
        pulseLayer.className = 'pdf-locate-pulse-layer ll-highlight-locate-pulse'

        if (quads?.length) {
            const size = this.pageSizes[page] || { width: 595, height: 842, x0: 0, y0: 0 }
            const x0 = size.x0 || 0, y0 = size.y0 || 0
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
            svg.setAttribute('viewBox', `${x0} ${y0} ${size.width} ${size.height}`)
            for (const q of quads) {
                const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
                poly.setAttribute('points', `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`)
                poly.setAttribute('fill', pulsePalette.solidHex)
                poly.setAttribute('fill-opacity', String(pulsePalette.opacity))
                svg.append(poly)
            }
            pulseLayer.append(svg)
        } else if (rects?.length) {
            for (const [x1, y1, x2, y2] of rects) {
                const item = document.createElement('div')
                item.className = 'pdf-locate-pulse-item'
                Object.assign(item.style, {
                    left: `${x1 * 100}%`,
                    top: `${y1 * 100}%`,
                    width: `${Math.max((x2 - x1) * 100, 1.5)}%`,
                    height: `${Math.max((y2 - y1) * 100, 1.2)}%`,
                    backgroundColor: pulsePalette.fill,
                })
                pulseLayer.append(item)
            }
        }

        slot.append(pulseLayer)
        this._locatePulseEls.push(pulseLayer)
        this._locatePulseTimer = setTimeout(() => {
            this.clearLocatePulse()
        }, HIGHLIGHT_LOCATE_PULSE_CLEANUP_MS)
    }

    _detectCurrentPage() {
        if (!this.pageOffsets.length) return
        const best = this.getPageAtViewportCenter()
        if (best !== this.currentPage) {
            this.clearLocatePulse()
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
        const m = this._getPageBoxMetrics(page)
        if (slot.style) {
            if (this.pageOffsets?.[page]) {
                slot.style.width = `${m.slotWidth}px`
                slot.style.height = `${m.slotHeight}px`
            }
            slot.style.overflow = 'hidden'
        }

        let hasInnerLayers = false
        if (typeof slot.querySelectorAll === 'function') {
            const innerLayers = slot.querySelectorAll('.pdf-img-wrapper, .pdf-highlight-layer, .pdf-native-selection-layer, .pdf-text-layer, .pdf-links-layer, .pdf-draw-overlay-wrapper')
            if (innerLayers.length > 0) {
                hasInnerLayers = true
                innerLayers.forEach(layer => {
                    layer.style.width = `${m.uncroppedWidth}px`
                    layer.style.height = `${m.uncroppedHeight}px`
                    layer.style.transform = (m.contentOffsetX !== 0 || m.contentOffsetY !== 0)
                        ? `translate(${m.contentOffsetX}px, ${m.contentOffsetY}px)`
                        : ''
                    layer.style.transformOrigin = '0 0'
                })
            }
        }

        if (slot.style) {
            if (hasInnerLayers) {
                slot.style.clipPath = ''
            } else {
                const { margins } = m
                const hasMargins = (margins.top > 0 || margins.right > 0 || margins.bottom > 0 || margins.left > 0)
                slot.style.clipPath = hasMargins ? `inset(${margins.top}% ${margins.right}% ${margins.bottom}% ${margins.left}%)` : ''
            }
        }
    }

    setCropSettings(settings) {
        const page = this.currentPage
        const previousBox = this.pageOffsets?.[page]
        const centerY = (this.scrollArea?.clientHeight || 0) / 2
        let pageY = null
        if (previousBox?.height > 0) {
            const { top, bottom } = this._getCropMarginsForPage(page)
            const fraction = clamp((this.scrollArea.scrollTop + centerY - previousBox.top) / previousBox.height, 0, 1)
            pageY = top / 100 + fraction * (1 - (top + bottom) / 100)
        }
        this.cropSettings = settings || { mode: 'none' }
        this.visualVersion = (this.visualVersion || 0) + 1
        if (this.activeSlots) {
            for (const slot of this.activeSlots.values()) {
                if (!slot) continue
                if (slot._renderedClip) {
                    slot._renderedClip = null
                    slot._renderToken = (slot._renderToken || 0) + 1
                    slot.renderAbort?.abort()
                    slot.renderAbort = new AbortController()
                    slot.querySelectorAll?.('.pdf-clip-canvas')?.forEach?.(c => {
                        c.remove?.()
                        c.width = c.height = 0
                    })
                }
            }
        }
        if (Array.isArray(this.pageSizes) && this.pageSizes.length > 0) {
            this._recomputeLayout()
            if (pageY !== null && this.pageOffsets[page]) {
                const { top, bottom } = this._getCropMarginsForPage(page)
                const fraction = clamp((pageY - top / 100) / (1 - (top + bottom) / 100), 0, 1)
                const box = this.pageOffsets[page]
                this.scrollArea.scrollTop = box.top + fraction * box.height - centerY
            }
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
    }

    getCropSettings() {
        return this.cropSettings || { mode: 'none' }
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
            'paper-boost': 'gray-boost',
            '灰底增强': 'gray-boost',
            '字迹加深': 'text-darken',
            'Paper Boost': 'gray-boost',
            'Darken Text': 'text-darken'
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
        this.visualVersion = (this.visualVersion || 0) + 1
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
    // S04: Controlled Auto-Scroll
    // ==========================================================
    getAutoScrollState() {
        return { active: Boolean(this._autoScrollActive), paused: Boolean(this._autoScrollPaused), speed: this._autoScrollSpeed || 30 }
    }

    _emitAutoScrollState() {
        this.options?.onAutoScrollStateChange?.(this.getAutoScrollState())
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
        this._emitAutoScrollState()
        this._autoScrollRaf = raf(loop)
    }

    pauseAutoScroll() {
        if (!this._autoScrollActive || this._autoScrollPaused) return
        this._autoScrollPaused = true
        this._emitAutoScrollState()
    }

    resumeAutoScroll() {
        if (!this._autoScrollActive || !this._autoScrollPaused) return
        this._autoScrollPaused = false
        this._emitAutoScrollState()
    }

    toggleAutoScrollPause() {
        if (this._autoScrollPaused) this.resumeAutoScroll()
        else this.pauseAutoScroll()
        return this._autoScrollPaused
    }

    stopAutoScroll() {
        const wasActive = this._autoScrollActive
        clearTimeout(this._autoScrollResumeTimer)
        this._autoScrollActive = false
        this._autoScrollPaused = false
        if (this._autoScrollRaf) {
            const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
            caf(this._autoScrollRaf)
            this._autoScrollRaf = null
        }
        if (wasActive) this._emitAutoScrollState()
    }

    destroy() {
        if (this._destroyed) return
        this._destroyed = true
        if (this._onPdfDomSelectionChange) document.removeEventListener('selectionchange', this._onPdfDomSelectionChange)
        clearTimeout(this._pdfTextTimer)
        this._pdfTextTimer = null
        clearTimeout(this._pdfTextPressTimer)
        this._pdfTextPressTimer = null
        clearTimeout(this._prefetchTimer)
        this._prefetchTimer = null
        clearTimeout(this._zoomRefineTimer)
        this._zoomRefineTimer = null
        clearTimeout(this._scrollPositionTimer)
        this._scrollPositionTimer = null
        clearTimeout(this._navigationRenderTimer)
        this._navigationRenderTimer = null
        this._navigationRenderPending = null
        this._navigationBurstCount = 0
        this._cancelAllPageReadyWaiters(false)
        this._notifyNavIdle(false)
        this.clearLocatePulse()
        if (this._modifierKeyDown) window.removeEventListener('keydown', this._modifierKeyDown)
        if (this._navigationKeyUp) window.removeEventListener('keyup', this._navigationKeyUp)
        if (this._modifierBlur) window.removeEventListener('blur', this._modifierBlur)
        this.stopAutoScroll?.()
        this._resizeObserver?.disconnect()
        clearTimeout(this._singleTapTimer)
        this._cancelPinch?.()
        this._nativeGestureEpoch++
        this._loadGeneration = (this._loadGeneration || 0) + 1
        this.visualVersion = (this.visualVersion || 0) + 1
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
        this._clearBitmapCache()
        this._nativeGeometry.clear()
        this._nativeGeometryUse.clear()
        this._pageOcrData?.clear()
        this._pageOcrSpans?.clear()
        this._hasPdfDomSelection = false
        this._gestureHadPdfSelection = false
        this._multiSelections = []
        this._lastSingleSelection = null
        this._ctrlSelectHeld = false
        this._nativeDrag = null
        this._nativePreview = null
        if (this._previewRaf) cancelAnimationFrame(this._previewRaf)
        this._previewRaf = null
        this._isClearingSelection = false
        this.driver?.destroy?.()
        this.driver = null
        this.container.innerHTML = ''
    }
}
