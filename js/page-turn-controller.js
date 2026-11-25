// js/page-turn-controller.js - Unified Page Turn Controller for Linden Leaf
// Architecture:
// - Coordinates page turn modes on authentic rendered pages (no reflowed text approximation):
//     1. 'none'       - Instant jump (e-ink / performance / prefers-reduced-motion)
//     2. 'slide'      - Real-page horizontal sliding (live DOM scrollport or ready PDF canvas)
//     3. 'cover'      - WebGL 3D curl over a ready texture or the live destination page
//     4. 'scroll'     - Continuous vertical/horizontal stream reading flow
// - State Machine: 'idle' -> 'preparing' -> 'dragging' -> 'settling' -> 'idle'
// - Single Gesture Ownership: 8px + dx/dy>=1.2 lock, 24px OS edge-back exclusion,
//   rAF-batched touchmove, 60-100ms release velocity, ordered swipe commits,
//   and generation/lifecycle abort hooks.

import * as CurlGeom from './curl-geometry.js'
import { CurlRenderer, computeCurlThemeParams } from './curl-webgl.js'
import platformBridge from './platformBridge.js'

export const FEATURE_CURL_PAGE_TURN_ENABLED = true
export const PAGE_TURN_MODES = ['none', 'slide', 'cover', 'scroll']
export const PAGE_TURN_STATES = ['idle', 'preparing', 'dragging', 'settling']
let capturedPageVersion = 0

function normalizeTurnMode(mode) {
    if (mode === 'curl') {
        return FEATURE_CURL_PAGE_TURN_ENABLED ? 'cover' : 'slide'
    }
    return PAGE_TURN_MODES.includes(mode) ? mode : 'none'
}

const HORIZONTAL_LOCK_PX = 8
const HORIZONTAL_LOCK_RATIO = 1.2
const VERTICAL_YIELD_PX = 8
const EDGE_BACK_MARGIN_PX = 24
const VELOCITY_WINDOW_MS = 100
const FLICK_VELOCITY_PX_MS = 0.30
const FLICK_MIN_DISTANCE_PX = 24
const COMMIT_RATIO = 0.25
const REVERSE_CANCEL_VELOCITY = 0.15
const MAX_RESISTANCE_PX = 44
const TAP_SUPPRESS_WINDOW_MS = 320

const hasRaf = typeof requestAnimationFrame === 'function'
const safeRaf = hasRaf
    ? (cb) => requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)
const safeCancelRaf = (id) => {
    if (id == null) return
    if (hasRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    else clearTimeout(id)
}
const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now())
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

function abortableSleep(ms, signal) {
    if (signal?.aborted) return Promise.resolve(false)
    const delay = Math.max(0, ms)
    return new Promise((resolve) => {
        let timer = null
        const finish = (ok) => {
            if (timer != null) {
                clearTimeout(timer)
                timer = null
            }
            signal?.removeEventListener?.('abort', onAbort)
            resolve(ok)
        }
        const onAbort = () => finish(false)
        signal?.addEventListener?.('abort', onAbort, { once: true })
        timer = setTimeout(() => finish(true), delay)
    })
}

export function isDarkColor(color) {
    if (!color) return false
    const str = String(color).trim().toLowerCase()
    if (str === 'black' || str === '#000' || str === '#000000') return true
    if (str.startsWith('#')) {
        const hex = str.slice(1)
        let r = 0, g = 0, b = 0
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16)
            g = parseInt(hex[1] + hex[1], 16)
            b = parseInt(hex[2] + hex[2], 16)
        } else if (hex.length >= 6) {
            r = parseInt(hex.slice(0, 2), 16)
            g = parseInt(hex.slice(2, 4), 16)
            b = parseInt(hex.slice(4, 6), 16)
        }
        const lum = 0.299 * r + 0.587 * g + 0.114 * b
        return lum < 128
    }
    if (str.startsWith('rgb')) {
        const m = str.match(/\d+/g)
        if (m && m.length >= 3) {
            const lum = 0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])
            return lum < 128
        }
    }
    return false
}

function readThemeBgColor() {
    if (typeof document === 'undefined') return '#ffffff'
    const docEl = document.documentElement
    const inlineBg = docEl?.style?.getPropertyValue?.('--book-bg') || docEl?.style?.backgroundColor
    if (inlineBg && inlineBg.trim()) return inlineBg.trim()
    if (typeof getComputedStyle === 'function' && docEl) {
        const computed = getComputedStyle(docEl).getPropertyValue('--book-bg')?.trim()
        if (computed) return computed
    }
    return '#ffffff'
}

/**
 * Base Adapter Contract for Reader Viewports
 */
export class PageTurnAdapter {
    canTurnPrev() { return true }
    canTurnNext() { return true }
    async turnPrev() {}
    async turnNext() {}
    isBusy() { return false }
    whenNavIdle() { return null }
    cancelPendingWaits() {}
    isContinuousScroll() { return false }
    ownsTouchGesture() { return false }
    isSessionValid() { return true }
    getViewElement() { return null }
    getSlideContext() { return null }
    getVisuals() { return null }
    isCurlAvailable() { return false }
    getCurlSnapshot() { return null }
    clearVisualCache() {}
}

/**
 * Adapter for Foliate EPUB / TXT / DOCX / Fixed-Layout View
 */
export class FoliatePageTurnAdapter extends PageTurnAdapter {
    constructor(foliateView) {
        super()
        this.view = foliateView
        this._curlEnabled = false
        this._snapshots = null
    }

    isSessionValid() {
        return Boolean(this.view && this.view.isConnected !== false && this.view.renderer)
    }

    _getDragContext() {
        const renderer = this.view?.renderer
        return typeof renderer?.getSlideDragContext === 'function'
            ? renderer.getSlideDragContext()
            : null
    }

    canTurnPrev() {
        if (!this.view) return false
        const ctx = this._getDragContext()
        if (ctx) return Boolean(ctx.canVisualLeft)
        return true
    }

    canTurnNext() {
        if (!this.view) return false
        const ctx = this._getDragContext()
        if (ctx) return Boolean(ctx.canVisualRight)
        return true
    }

    async turnPrev() {
        if (!this.view) return
        if (typeof this.view.goLeft === 'function') {
            await this.view.goLeft()
        } else if (typeof this.view.prev === 'function') {
            await this.view.prev()
        }
    }

    async turnNext() {
        if (!this.view) return
        if (typeof this.view.goRight === 'function') {
            await this.view.goRight()
        } else if (typeof this.view.next === 'function') {
            await this.view.next()
        }
    }

    commitRenderedPage(direction) {
        return this.view?.renderer?.commitRenderedPage?.(direction === 'next' ? 1 : -1)
    }

    isBusy() {
        if (!this.isSessionValid()) return false
        const renderer = this.view?.renderer
        if (typeof renderer?.isNavBusy === 'function') {
            return Boolean(renderer.isNavBusy())
        }
        return Boolean(renderer?.locked || renderer?.isTransitionBusy)
    }

    whenNavIdle(options = {}) {
        if (!this.isSessionValid()) return Promise.resolve(false)
        const renderer = this.view?.renderer
        if (typeof renderer?.whenNavIdle === 'function') {
            return renderer.whenNavIdle(options)
        }
        return null
    }

    isContinuousScroll() {
        const flow = this.view?.renderer?.getAttribute?.('flow')
        return Boolean(this.view?.renderer?.scrolled || flow === 'scrolled')
    }

    ownsTouchGesture() {
        const contents = this.view?.renderer?.getContents?.()
        if (Array.isArray(contents)) {
            for (const entry of contents) {
                const sel = entry?.doc?.getSelection?.()
                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                    return true
                }
            }
        }
        return false
    }

    getViewElement() {
        return this.view?.renderer || this.view?.element || null
    }

    getSlideContext() {
        const renderer = this.view?.renderer
        if (!renderer || this.isContinuousScroll()) return null
        if (typeof renderer.beginSlideDrag !== 'function') return null
        return {
            kind: 'foliate-dom',
            renderer,
        }
    }

    getVisuals() {
        // Real DOM slide does not synthesize reflowed approximation canvases.
        return null
    }

    setCurlEnabled(enabled, viewport, canPrepare, onPrepared) {
        this._curlEnabled = enabled
        if (!enabled) {
            this._snapshots?.dispose()
            this._snapshots = null
            return
        }
        if (this._snapshots || !this.view?.renderer?.getPageSnapshotContext) return
        this._snapshotModule ??= import('./foliate-page-snapshot.js')
        this._snapshotModule.then(({ FoliatePageSnapshots }) => {
            if (this._curlEnabled && !this._snapshots && this.isSessionValid())
                this._snapshots = new FoliatePageSnapshots(this.view.renderer, viewport, canPrepare, onPrepared)
        }).catch(() => {}) // The live destination path can still use the displayed Android page.
    }

    isCurlAvailable() {
        return Boolean(FEATURE_CURL_PAGE_TURN_ENABLED && this.isSessionValid()
            && !this.ownsTouchGesture() && this._snapshots?.get('current')
            && CurlRenderer.isSupported())
    }

    getCurlSnapshot(direction) {
        const snapshot = this._snapshots?.get(direction)
        if (snapshot) snapshot.isDark = isDarkColor(snapshot.bgColor)
        return snapshot || null
    }

    prepareCurlSource() { return this._snapshots?.getCurrentForTurn() }

    prepareCurlDirection(direction) { this._snapshots?.prepareTurn(direction) }

    retainTurnVisuals() {
        if (!this._snapshots) return false
        this._snapshots.resume()
        return true
    }

    clearVisualCache() { this._snapshots?.invalidate() }

    dispose() { this.setCurlEnabled(false) }

}

/**
 * Adapter for PDF Viewport (uses real rendered PDF canvases only)
 */
export class PdfPageTurnAdapter extends PageTurnAdapter {
    constructor(pdfViewport) {
        super()
        this.viewport = pdfViewport
        this._snapshotCache = new Map()
        this._lastTargetPage = null
        this._pendingWaitAborts = new Set()
        this._lastTurnOutcome = null
    }

    isSessionValid() {
        return Boolean(this.viewport && !this.viewport._destroyed && this.viewport.scrollArea)
    }

    getTotalPages() {
        return this.viewport?.pageOffsets?.length || this.viewport?.pageSizes?.length || 1
    }

    getCurrentPage() {
        return this.viewport?.currentPage ?? 0
    }

    _getTargetPage(direction) {
        if (typeof this.viewport?.getAdjacentPage === 'function') {
            return this.viewport.getAdjacentPage(direction)
        }
        const target = this.getCurrentPage() + (direction === 'next' ? 1 : -1)
        return target >= 0 && target < this.getTotalPages() ? target : null
    }

    canTurnPrev() { return this._getTargetPage('prev') != null }

    canTurnNext() { return this._getTargetPage('next') != null }

    async turnPrev() {
        const target = this._getTargetPage('prev')
        if (target != null) await this.viewport.goToPage(target)
    }

    async turnNext() {
        const target = this._getTargetPage('next')
        if (target != null) await this.viewport.goToPage(target)
    }

    isBusy() {
        if (!this.isSessionValid()) return false
        if (typeof this.viewport?.isNavBusy === 'function') {
            return Boolean(this.viewport.isNavBusy())
        }
        return Boolean(this.viewport?._pinch || this.viewport?._navigationRenderPending)
    }

    whenNavIdle(options = {}) {
        if (!this.isSessionValid()) return Promise.resolve(false)
        if (typeof this.viewport?.whenNavIdle === 'function') {
            return this.viewport.whenNavIdle(options)
        }
        return null
    }

    cancelPendingWaits() {
        if (!this._pendingWaitAborts?.size) return
        for (const ctrl of [...this._pendingWaitAborts]) {
            try { ctrl.abort() } catch {}
        }
        this._pendingWaitAborts.clear()
    }

    isContinuousScroll() {
        return false
    }

    ownsTouchGesture() {
        return Boolean(this.viewport?.ownsTouchGesture?.())
    }

    getViewElement() {
        return this.viewport?.scrollArea || this.viewport?.container || null
    }

    _getCanvasForPage(pageIndex) {
        const slot = this.viewport?.activeSlots?.get?.(pageIndex)
        if (slot && typeof slot.querySelector === 'function') {
            const mainCanvas = slot.querySelector('.pdf-page-canvas')
            if (mainCanvas && mainCanvas.width > 0 && !slot._renderedIsPreview) return mainCanvas
            const clipCanvas = slot.querySelector('.pdf-clip-canvas')
            if (clipCanvas && clipCanvas.width > 0) return clipCanvas
            const previewCanvas = slot.querySelector('.pdf-page-preview')
            if (previewCanvas && previewCanvas.width > 0) return previewCanvas
        }
        return null
    }

    isTargetReady(direction) {
        const target = this._getTargetPage(direction)
        if (target == null) return false
        return Boolean(this.viewport?.isPageCanvasReady?.(target))
    }

    ensureTargetWarm(direction) {
        const target = this._getTargetPage(direction)
        if (target == null) return false
        return Boolean(this.viewport?.ensurePageRendered?.(target))
    }

    _isTargetRenderError(pageIndex) {
        const slot = this.viewport?.activeSlots?.get?.(pageIndex)
        return Boolean(slot?._renderError)
    }

    async _waitForTargetReadyState(direction, target, isCurrentFn, timeoutMs = 420, signal = null) {
        const startViewport = this.viewport
        const startLoadGen = this._getLoadGeneration()
        const isStillSameTargetSession = () => {
            if (signal?.aborted) return false
            if (typeof isCurrentFn === 'function' && !isCurrentFn()) return false
            if (!this.isSessionValid()) return false
            if (this.viewport !== startViewport) return false
            if (this._getLoadGeneration() !== startLoadGen) return false
            return this._getTargetPage(direction) === target
        }

        if (!isStillSameTargetSession()) {
            return { ok: false, reason: 'cancelled', retryable: false }
        }
        if (typeof this.viewport?.isPageCanvasReady !== 'function') {
            return { ok: true, reason: 'ready', retryable: false }
        }
        if (this.viewport.isPageCanvasReady(target)) {
            return { ok: true, reason: 'ready', retryable: false }
        }
        if (this._isTargetRenderError(target)) {
            return { ok: false, reason: 'render-error', retryable: false }
        }

        const localCtrl = new AbortController()
        this._pendingWaitAborts.add(localCtrl)
        const onExternalAbort = () => localCtrl.abort()
        signal?.addEventListener?.('abort', onExternalAbort, { once: true })

        let genWatchTimer = null
        if (typeof isCurrentFn === 'function') {
            genWatchTimer = setInterval(() => {
                if (!isStillSameTargetSession()) localCtrl.abort()
            }, 24)
        }

        const waitStartedAt = nowMs()
        const hasWhenPageReady = typeof this.viewport?.whenPageReady === 'function'
        let ready = false

        try {
            if (hasWhenPageReady) {
                ready = await this.viewport.whenPageReady(target, {
                    signal: localCtrl.signal,
                    timeoutMs: Math.max(0, timeoutMs),
                })
            } else {
                const syncReady = this.viewport?.ensurePageRendered?.(target)
                if (syncReady && this.viewport.isPageCanvasReady(target)) {
                    ready = true
                } else {
                    const deadline = nowMs() + Math.max(0, timeoutMs)
                    while (nowMs() < deadline && !localCtrl.signal.aborted && isStillSameTargetSession()) {
                        if (this.viewport.isPageCanvasReady(target)) {
                            ready = true
                            break
                        }
                        if (this._isTargetRenderError(target)) {
                            ready = false
                            break
                        }
                        const stepMs = Math.max(1, Math.min(20, deadline - nowMs()))
                        await abortableSleep(stepMs, localCtrl.signal)
                    }
                    if (!ready && !localCtrl.signal.aborted && isStillSameTargetSession()) {
                        ready = Boolean(this.viewport.isPageCanvasReady(target))
                    }
                }
            }

            if (localCtrl.signal.aborted || !isStillSameTargetSession()) {
                return { ok: false, reason: 'cancelled', retryable: false }
            }
            if (this._isTargetRenderError(target)) {
                return { ok: false, reason: 'render-error', retryable: false }
            }
            if (!ready || !this.viewport.isPageCanvasReady(target)) {
                const elapsed = nowMs() - waitStartedAt
                const failedEarly = hasWhenPageReady && timeoutMs > 40 && elapsed < (timeoutMs - 30)
                const canRetrySlow = !failedEarly && timeoutMs > 0 && Boolean(
                    this.viewport.activeSlots?.get?.(target) ||
                    hasWhenPageReady ||
                    typeof this.viewport?.ensurePageRendered === 'function'
                )
                return {
                    ok: false,
                    reason: failedEarly ? 'render-error' : 'timeout',
                    retryable: canRetrySlow,
                }
            }
            return { ok: true, reason: 'ready', retryable: false }
        } catch {
            return { ok: false, reason: 'render-error', retryable: false }
        } finally {
            if (genWatchTimer != null) clearInterval(genWatchTimer)
            signal?.removeEventListener?.('abort', onExternalAbort)
            this._pendingWaitAborts.delete(localCtrl)
        }
    }

    async whenTargetReady(direction, { signal = null, timeoutMs = 420 } = {}) {
        if (!this.isSessionValid() || signal?.aborted) return false
        const target = this._getTargetPage(direction)
        if (target == null) return false
        const res = await this._waitForTargetReadyState(direction, target, null, timeoutMs, signal)
        return Boolean(res.ok)
    }

    async waitForTargetReadyAndTurn(direction, isCurrentFn, timeoutMs = 420, options = {}) {
        const { signal = null } = options || {}
        const recordOutcome = (ok, reason = 'failed', target = null, retryable = false) => {
            this._lastTurnOutcome = { ok, reason, target, direction, retryable }
            return ok
        }
        if (signal?.aborted || (typeof isCurrentFn === 'function' && !isCurrentFn()) || !this.isSessionValid()) {
            return recordOutcome(false, signal?.aborted ? 'cancelled' : 'invalid-session')
        }
        const target = this._getTargetPage(direction)
        if (target == null) {
            return recordOutcome(false, 'invalid-target')
        }

        const startViewport = this.viewport
        const startLoadGen = this._getLoadGeneration()
        const state = await this._waitForTargetReadyState(direction, target, isCurrentFn, timeoutMs, signal)
        if (!state.ok) {
            // Strict R2 guard: NEVER call goToPage(target) on timeout, cancel, or render failure.
            return recordOutcome(false, state.reason, target, state.retryable)
        }

        if (
            signal?.aborted ||
            (typeof isCurrentFn === 'function' && !isCurrentFn()) ||
            !this.isSessionValid() ||
            this.viewport !== startViewport ||
            this._getLoadGeneration() !== startLoadGen ||
            this._getTargetPage(direction) !== target
        ) {
            return recordOutcome(false, 'cancelled', target, false)
        }
        if (typeof this.viewport?.isPageCanvasReady === 'function' && !this.viewport.isPageCanvasReady(target)) {
            return recordOutcome(false, 'not-ready', target, false)
        }

        await this.viewport.goToPage(target)
        return recordOutcome(true, 'ready', target, false)
    }

    _getLoadGeneration() {
        return this.viewport?._loadGeneration ?? 0
    }

    _pruneSnapshotCache(curPage, activePage) {
        const keep = new Set()
        if (curPage != null) keep.add(curPage)
        if (activePage != null) keep.add(activePage)
        if (this._lastTargetPage != null && activePage === curPage) {
            keep.add(this._lastTargetPage)
        }
        for (const [k, snap] of this._snapshotCache.entries()) {
            if (keep.has(k)) continue
            if (snap?.canvas) {
                try { snap.canvas.width = 0; snap.canvas.height = 0 } catch {}
            }
            this._snapshotCache.delete(k)
        }
    }

    _getCachedSnapshot(pageIndex, allowPreview = false) {
        if (pageIndex == null || !this.viewport) return null
        const version = this.viewport.getVisualVersion?.() ?? 0
        const loadGeneration = this._getLoadGeneration()
        const vw = Math.max(0, this.viewport.scrollArea?.clientWidth || this.viewport.container?.clientWidth || 0)
        const vh = Math.max(0, this.viewport.scrollArea?.clientHeight || this.viewport.container?.clientHeight || 0)
        const ready = Boolean(this.viewport.isPageCanvasReady?.(pageIndex))
        const cached = this._snapshotCache.get(pageIndex)
        if (
            cached &&
            cached.visualVersion === version &&
            cached.loadGeneration === loadGeneration &&
            (!vw || !vh || (cached.width === vw && cached.height === vh)) &&
            (!cached.fromPreview || (allowPreview && !ready))
        ) {
            return cached
        }
        if (!ready && !allowPreview) {
            this.viewport.ensurePageRendered?.(pageIndex)
            return null
        }
        const snap = this.viewport.captureCompositedPageSnapshot?.(pageIndex, { allowPreview })
        if (!snap?.canvas) return null
        snap.fromPreview = !ready
        snap.loadGeneration = loadGeneration
        snap.isDark = (this.viewport.pageAppearance === 'night') || isDarkColor(snap.bgColor || readThemeBgColor())
        snap.closeBitmapOnUpload = false
        if (cached?.canvas && cached.canvas !== snap.canvas) {
            try { cached.canvas.width = 0; cached.canvas.height = 0 } catch {}
        }
        this._snapshotCache.set(pageIndex, snap)
        const curPage = this.getCurrentPage()
        if (pageIndex !== curPage) {
            this._lastTargetPage = pageIndex
        }
        this._pruneSnapshotCache(curPage, pageIndex)
        return snap
    }

    _isZoomedOrRestricted() {
        const vp = this.viewport
        if (!vp) return true
        if (vp._pinch || vp.interactionMode === 'draw' || vp.spreadMode === 'dual') {
            return true
        }
        if (vp.canPanHorizontally?.()) return true
        if (!vp.zoomMode) {
            const fitScale = vp.getFitScale?.('fit-width') || 0
            const relScale = fitScale > 0 ? (vp.scale || 1) / fitScale : (vp.scale || 1)
            if (relScale > 1.02) return true
        }
        return false
    }

    getSlideContext() {
        if (!this.isSessionValid()) return null
        return {
            kind: 'pdf-canvas',
            curPage: this.getCurrentPage(),
        }
    }

    getVisuals(direction = 'next') {
        const curPage = this.getCurrentPage()
        const targetPage = this._getTargetPage(direction)
        const curSnap = this._getCachedSnapshot(curPage, true)
        const targetSnap = targetPage == null ? null : this._getCachedSnapshot(targetPage, false)
        const bgColor = curSnap?.bgColor || readThemeBgColor()
        return {
            currentCanvas: curSnap?.canvas || this._getCanvasForPage(curPage),
            nextCanvas: targetSnap?.canvas || null,
            currentSnapshot: curSnap,
            nextSnapshot: targetSnap,
            targetPage,
            targetReady: Boolean(targetSnap?.canvas),
            bgColor,
        }
    }

    isCurlAvailable() {
        return Boolean(
            FEATURE_CURL_PAGE_TURN_ENABLED &&
            CurlRenderer.isSupported() &&
            this.isSessionValid() &&
            !this.ownsTouchGesture() &&
            !this._isZoomedOrRestricted()
        )
    }

    getCurlSnapshot(direction = 'next') {
        if (!this.isSessionValid()) return null
        const pageIndex = direction === 'current'
            ? this.getCurrentPage()
            : this._getTargetPage(direction)
        if (pageIndex == null) return null
        // Avoid curling a blurry preview canvas when crisp rendering is available or pending.
        return this._getCachedSnapshot(pageIndex, false)
    }

    clearVisualCache() {
        for (const snap of this._snapshotCache.values()) {
            if (snap?.canvas) {
                try { snap.canvas.width = 0; snap.canvas.height = 0 } catch {}
            }
        }
        this._snapshotCache.clear()
        this._lastTargetPage = null
    }
}

/**
 * Universal Page Turn Controller
 */
export class PageTurnController {
    constructor(options = {}) {
        this.container = options.container || null
        this.adapter = options.adapter || null
        this.mode = normalizeTurnMode(options.mode || 'none')
        this.state = 'idle'
        this.generation = 0
        this.animationDuration = options.animationDuration || 190 // ms

        // Gesture & animation tracking
        this.touchStart = null
        this.currentDrag = null
        this.isGestureActive = false
        this._samples = []
        this._dragRafId = null
        this._animRafId = null
        this._activeAnimResolve = null
        this._activeSlideSession = null
        this._activeSlideDir = null
        this._activeDragWidth = 0
        this._liveOffsetPx = 0
        this._activeCurl = null
        this._curlRenderer = null
        this._curlHostEl = null
        this._curlWebGLFailed = false
        this._curlPrewarmHandle = null
        this._destroyed = false
        this._pendingIntent = null
        this._queuedSwipes = []
        this._pendingFlushAbort = null
        this._slowTurnAbort = null
        this._slowTurnToken = 0
        this._lastConsumedTouchTs = 0
        this._seenEvents = new WeakSet()
        this._isBlockedCallback = options.isBlockedCallback || (() => false)
        this._onCurlUnavailable = options.onCurlUnavailable || (() => {})

        this._overlayEl = null
        this._overlayLayers = null

        this._checkReducedMotion()
        this._initOverlay()
        this._bindAbortListeners()
        this._updateCurlAvailability()
    }

    _checkReducedMotion() {
        try {
            if (typeof window !== 'undefined' && window.matchMedia) {
                const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
                this.prefersReducedMotion = mq.matches
                this._mqHandler = (e) => {
                    this.prefersReducedMotion = e.matches
                    this._updateCurlAvailability()
                    if (e.matches && (this.state === 'dragging' || this.state === 'settling')) {
                        this.cancelCurrent()
                    }
                }
                mq.addEventListener?.('change', this._mqHandler)
                this._reducedMotionMq = mq
            }
        } catch {
            this.prefersReducedMotion = false
        }
    }

    _initOverlay() {
        if (typeof document === 'undefined') return null
        let overlay = (this._overlayEl && this._overlayEl.isConnected)
            ? this._overlayEl
            : document.getElementById('page-turn-overlay')
        if (!overlay && this.container) {
            overlay = this._overlayEl || document.createElement('div')
            overlay.id = 'page-turn-overlay'
            overlay.className = 'page-turn-overlay'
            overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:40;display:none;overflow:hidden;contain:layout style paint;'
        }
        if (overlay && this.container) {
            const position = this.container.ownerDocument?.defaultView?.getComputedStyle(this.container)?.position || this.container.style.position
            if (!position || position === 'static') this.container.style.position = 'relative'
            if (overlay.parentElement !== this.container || !overlay.isConnected) {
                this.container.appendChild(overlay)
            }
        }
        this._overlayEl = overlay
        return overlay
    }

    _bindAbortListeners() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        this._onWindowBlur = () => this.cancelCurrent()
        this._onPageHide = () => this.cancelCurrent()
        this._onVisibilityChange = () => {
            if (document.hidden) this.cancelCurrent()
        }
        this._onResizeOrRotate = () => {
            const w = this.container?.clientWidth || window.innerWidth || 0
            const h = this.container?.clientHeight || window.innerHeight || 0
            if (this._lastBoundsW && (this._lastBoundsW === w && this._lastBoundsH === h)) return
            this._lastBoundsW = w
            this._lastBoundsH = h
            this.cancelCurrent()
            this._updateCurlAvailability()
        }
        this._onDocumentSelectionChange = () => {
            const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                this.handleExternalSelectionStart()
            }
        }
        window.addEventListener('blur', this._onWindowBlur, { passive: true })
        window.addEventListener('pagehide', this._onPageHide, { passive: true })
        window.addEventListener('orientationchange', this._onResizeOrRotate, { passive: true })
        window.addEventListener('resize', this._onResizeOrRotate, { passive: true })
        document.addEventListener('visibilitychange', this._onVisibilityChange, { passive: true })
        document.addEventListener('selectionchange', this._onDocumentSelectionChange, { passive: true })
    }

    destroy() {
        this._destroyed = true
        this._cancelCurlPrewarm()
        this.cancelCurrent()
        this.adapter?.dispose?.()
        if (typeof window !== 'undefined') {
            window.removeEventListener('blur', this._onWindowBlur)
            window.removeEventListener('pagehide', this._onPageHide)
            window.removeEventListener('orientationchange', this._onResizeOrRotate)
            window.removeEventListener('resize', this._onResizeOrRotate)
        }
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibilityChange)
            document.removeEventListener('selectionchange', this._onDocumentSelectionChange)
        }
        if (this._reducedMotionMq && this._mqHandler) {
            this._reducedMotionMq.removeEventListener?.('change', this._mqHandler)
        }
    }

    setAdapter(adapter) {
        this._cancelCurlPrewarm()
        this.cancelCurrent()
        if (this.adapter !== adapter) this.adapter?.dispose?.()
        this._curlWebGLFailed = false
        this.adapter = adapter
        this._initOverlay()
        this._updateCurlAvailability()
        this._scheduleCurlPrewarm()
    }

    setMode(mode) {
        const nextMode = normalizeTurnMode(mode)
        if (!PAGE_TURN_MODES.includes(nextMode)) return
        this._cancelCurlPrewarm()
        this.cancelCurrent()
        if (nextMode !== 'cover') {
            this._disposeCurlRenderer()
        } else {
            this._curlWebGLFailed = false
        }
        this.mode = nextMode
        this._updateCurlAvailability()
        this._scheduleCurlPrewarm()
    }

    _cancelCurlPrewarm() {
        const handle = this._curlPrewarmHandle
        if (!handle) return
        this._curlPrewarmHandle = null
        try {
            if (handle.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(handle.id)
            else clearTimeout(handle.id)
        } catch {}
    }

    _scheduleCurlPrewarm() {
        this._cancelCurlPrewarm()
        if (
            this._destroyed ||
            this._curlWebGLFailed ||
            !this.adapter ||
            !this.container ||
            typeof window === 'undefined' ||
            typeof document === 'undefined' ||
            this.getEffectiveMode() !== 'cover'
        ) {
            return
        }
        const run = () => {
            this._curlPrewarmHandle = null
            if (
                this._destroyed ||
                this._curlWebGLFailed ||
                this.state !== 'idle' ||
                this.touchStart ||
                this.getEffectiveMode() !== 'cover' ||
                !this.adapter?.isSessionValid?.()
            ) {
                return
            }
            const renderer = this._ensureCurlRenderer()
            if (!renderer) return
            const { W, H } = this._computeCurlSize()
            const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 3)
            const current = this.adapter instanceof FoliatePageTurnAdapter
                ? this.adapter.getCurlSnapshot('current') : null
            const neighbor = current && (this.adapter.getCurlSnapshot('next') || this.adapter.getCurlSnapshot('prev'))
            const textureDpr = Math.min(dpr, current?.textureDpr ?? dpr, neighbor?.textureDpr ?? dpr)
            if (renderer.resize(W, H, textureDpr) && neighbor) renderer.syncPageTextures(current, neighbor)
            if (!this._activeCurl) {
                if (this._curlHostEl) this._curlHostEl.style.display = 'none'
                if (this._overlayEl) this._overlayEl.style.display = 'none'
            }
        }
        if (typeof requestIdleCallback === 'function') {
            this._curlPrewarmHandle = { idle: true, id: requestIdleCallback(run, { timeout: 600 }) }
        } else {
            this._curlPrewarmHandle = { idle: false, id: setTimeout(run, 300) }
        }
    }

    _updateCurlAvailability() {
        this.adapter?.setCurlEnabled?.(
            !this._destroyed && !this._curlWebGLFailed && this.getEffectiveMode() === 'cover',
            this.container,
            () => (this.state === 'idle' && !this.touchStart) ||
                (this.state === 'dragging' && Boolean(this.touchStart) && !this._activeCurl),
            () => {
                if (this.state === 'idle' && !this.touchStart) this._scheduleCurlPrewarm()
            },
        )
    }

    isReducedMotion() {
        return Boolean(
            this.prefersReducedMotion ||
            (typeof document !== 'undefined' && (
                document.documentElement?.dataset?.reducedMotion === 'true' ||
                document.documentElement?.dataset?.animIntensity === 'none'
            ))
        )
    }

    getEffectiveMode() {
        if (this.isReducedMotion()) return 'none'
        if (this.adapter?.isContinuousScroll?.()) return 'scroll'
        if (typeof window !== 'undefined') {
            const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(window.platformBridge?.isAndroid)
            if (!isMobile) return 'none'
        }
        const normalized = normalizeTurnMode(this.mode)
        if (normalized === 'cover' && this._curlWebGLFailed) return 'slide'
        return normalized
    }

    shouldHandlePaginatorTouch() {
        return this.getEffectiveMode() !== 'scroll'
    }

    shouldSuppressTap() {
        if (this.state === 'dragging' || this.state === 'settling') return true
        return (nowMs() - this._lastConsumedTouchTs) < TAP_SUPPRESS_WINDOW_MS
    }

    handleExternalSelectionStart() {
        this._cancelTouch()
    }

    /**
     * Check if page turn gestures should be blocked
     * Handled strictly: Drawing tool, active text selection, zoomed PDF panning, open sheets/popups
     */
    isGestureBlocked() {
        if (this.adapter && this.adapter.isSessionValid?.() === false) return true
        if (this.adapter?.ownsTouchGesture?.()) return true
        if (this._isBlockedCallback()) return true
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return true
        }
        return false
    }

    _isInteractiveControlTarget(target) {
        return Boolean(target?.closest?.('input, textarea, select, option, [contenteditable="true"], .mobile-range-slider'))
    }

    _stopAnimationsAndRaf(finish = false) {
        safeCancelRaf(this._dragRafId)
        this._dragRafId = null
        safeCancelRaf(this._animRafId)
        this._animRafId = null
        if (this._activeAnimResolve) {
            const resolve = this._activeAnimResolve
            this._activeAnimResolve = null
            resolve(finish)
        }
    }

    _clearOverlay() {
        this._overlayLayers = null
        if (this._overlayEl) {
            const children = [...this._overlayEl.children]
            for (const ch of children) {
                if (ch === this._curlHostEl) continue
                const canvases = ch.querySelectorAll ? ch.querySelectorAll('canvas') : []
                for (const c of canvases) {
                    try { c.width = 0; c.height = 0 } catch {}
                }
                ch.remove()
            }
            if (!this._activeCurl) {
                if (this._curlHostEl) this._curlHostEl.style.display = 'none'
                this._overlayEl.style.display = 'none'
            }
        }
    }

    _disposeCurlRenderer() {
        this._activeCurl = null
        if (this._curlRenderer) {
            try { this._curlRenderer.dispose() } catch {}
            this._curlRenderer = null
        }
        if (this._curlHostEl) {
            try { this._curlHostEl.remove() } catch {}
            this._curlHostEl = null
        }
    }

    _ensureCurlRenderer() {
        if (this._curlWebGLFailed || !CurlRenderer.isSupported()) return null
        const overlay = this._initOverlay()
        if (!overlay) return null
        if (
            this._curlRenderer &&
            !this._curlRenderer._disposed &&
            !this._curlRenderer._contextLost &&
            this._curlHostEl?.isConnected &&
            this._curlHostEl.parentElement === overlay
        ) {
            return this._curlRenderer
        }
        if (
            this._curlRenderer &&
            !this._curlRenderer._disposed &&
            !this._curlRenderer._contextLost &&
            this._curlHostEl
        ) {
            overlay.appendChild(this._curlHostEl)
            return this._curlRenderer
        }
        this._disposeCurlRenderer()

        const host = document.createElement('div')
        host.className = 'page-turn-curl-host'
        host.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
        overlay.appendChild(host)
        this._curlHostEl = host

        try {
            this._curlRenderer = new CurlRenderer({
                container: host,
                onContextLost: () => this._handleCurlContextLost(),
                onContextRestored: () => this._handleCurlContextRestored(),
                maxDpr: 3,
            })
            return this._curlRenderer
        } catch (err) {
            console.warn('[PageTurnController] CurlRenderer init failed, falling back to slide:', err)
            this._curlWebGLFailed = true
            this._updateCurlAvailability()
            this._disposeCurlRenderer()
            return null
        }
    }

    _handleCurlContextLost() {
        this._curlWebGLFailed = true
        this._activeCurl = null
        this._updateCurlAvailability()
        if (this._curlHostEl) this._curlHostEl.style.display = 'none'
        this._clearOverlay()
    }

    _handleCurlContextRestored() {
        if (this._destroyed) return
        this._curlWebGLFailed = false
        this._updateCurlAvailability()
    }

    _cancelPendingFlush() {
        if (this._pendingFlushAbort) {
            try { this._pendingFlushAbort.abort() } catch {}
            this._pendingFlushAbort = null
        }
    }

    _cancelSlowTurnWait() {
        this._slowTurnToken++
        if (this._slowTurnAbort) {
            try { this._slowTurnAbort.abort() } catch {}
            this._slowTurnAbort = null
        }
    }

    _cancelAllPendingTurns() {
        this._pendingIntent = null
        this._queuedSwipes.length = 0
        this._cancelPendingFlush()
        this._cancelSlowTurnWait()
        this.adapter?.cancelPendingWaits?.()
    }

    /**
     * Invalidate and cancel in-flight animations/textures/drag state
     */
    cancelCurrent({ keepPreparedPages = false } = {}) {
        this._cancelAllPendingTurns()
        this.generation++
        this._stopAnimationsAndRaf()

        const session = this._activeSlideSession
        this._activeSlideSession = null
        this._activeSlideDir = null
        this._activeDragWidth = 0
        this._liveOffsetPx = 0
        this._activeCurl = null

        if (session?.kind === 'foliate-dom') {
            try { session.renderer?.endSlideDrag?.({ commitVisualDir: 0 }) } catch {}
        }

        const retained = keepPreparedPages && this.adapter?.retainTurnVisuals?.()
        if (!retained) this._disposeCurlRenderer()
        else if (this._curlHostEl) this._curlHostEl.style.display = 'none'
        this.state = 'idle'
        this._clearTouch()

        this._clearOverlay()
        if (!retained) this.adapter?.clearVisualCache?.()

        const viewEl = this.adapter?.getViewElement?.()
        if (viewEl?.style) {
            viewEl.style.transition = ''
            viewEl.style.transform = ''
            viewEl.style.opacity = ''
            viewEl.style.filter = ''
        }
    }

    /**
     * Turn to next/prev page (coalesces at most one pending turn during animation)
     */
    async turnNext() {
        return this._requestTurn('next')
    }

    async turnPrev() {
        return this._requestTurn('prev')
    }

    async _requestTurn(direction) {
        if (this._destroyed || !this.adapter || !this.adapter.isSessionValid?.()) return

        // A new explicit turn request supersedes any background slow-target retry.
        this._cancelSlowTurnWait()

        if (this.state === 'settling') {
            // Coalesce at most 1 pending rapid flick; evaluate boundary once settled.
            this._pendingIntent = direction
            return
        }
        if (this.state !== 'idle') return
        if (this.adapter.isBusy?.()) {
            this._pendingIntent = direction
            this._schedulePendingFlush(this.generation)
            return
        }

        const canTurn = direction === 'next' ? this.adapter.canTurnNext() : this.adapter.canTurnPrev()
        if (!canTurn) return
        this._cancelPendingFlush()
        this._pendingIntent = null

        const mode = this.getEffectiveMode()
        if (mode === 'none' || mode === 'scroll') {
            const curGen = ++this.generation
            this.state = 'settling'
            try {
                await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
            } finally {
                if (curGen === this.generation) {
                    this.state = 'idle'
                    await this._flushPendingIntent(curGen)
                }
            }
            return
        }

        await this._performTransition(direction, mode)
    }

    async _waitForAdapterIdle(adapter, signal, timeoutMs = 2500) {
        if (!adapter || signal?.aborted || this._destroyed) return false
        if (!adapter.isSessionValid?.()) return false
        if (!adapter.isBusy?.()) return true

        const maybePromise = typeof adapter.whenNavIdle === 'function'
            ? adapter.whenNavIdle({ signal, timeoutMs })
            : null
        if (maybePromise && typeof maybePromise.then === 'function') {
            const ok = await maybePromise
            return Boolean(ok && !signal?.aborted && !this._destroyed && adapter === this.adapter && adapter.isSessionValid?.() && !adapter.isBusy?.())
        }

        // Legacy adapters without an idle signal keep a bounded polling fallback.
        const deadline = nowMs() + (timeoutMs > 0 ? timeoutMs : 2500)
        while (!signal?.aborted && !this._destroyed && adapter === this.adapter && adapter.isSessionValid?.()) {
            if (!adapter.isBusy?.()) return true
            if (nowMs() >= deadline) return false
            const stepMs = Math.max(1, Math.min(12, deadline - nowMs()))
            await abortableSleep(stepMs, signal)
        }
        return false
    }

    _schedulePendingFlush(curGen = this.generation) {
        if (this._destroyed || curGen !== this.generation || (!this._queuedSwipes.length && !this._pendingIntent) || !this.adapter?.isSessionValid?.()) {
            return
        }
        if (this._pendingFlushAbort && !this._pendingFlushAbort.signal.aborted) {
            return
        }
        const ctrl = new AbortController()
        this._pendingFlushAbort = ctrl
        const capturedAdapter = this.adapter

        ;(async () => {
            try {
                const ready = await this._waitForAdapterIdle(capturedAdapter, ctrl.signal, 0)
                if (this._pendingFlushAbort === ctrl) {
                    this._pendingFlushAbort = null
                }
                if (!ready || ctrl.signal.aborted || this._destroyed) return
                if (curGen !== this.generation || this.adapter !== capturedAdapter || !capturedAdapter.isSessionValid?.()) {
                    return
                }
                await this._flushPendingIntent(curGen)
            } catch {
                if (this._pendingFlushAbort === ctrl) {
                    this._pendingFlushAbort = null
                }
            }
        })()
    }

    async _flushPendingIntent(curGen) {
        if (this._destroyed || curGen !== this.generation || this.state !== 'idle') return
        if (!this.adapter?.isSessionValid?.()) return
        if (this._queuedSwipes.length || this._pendingIntent) {
            if (this.adapter.isBusy?.()) {
                this._schedulePendingFlush(curGen)
                return
            }
            while (this._queuedSwipes.length || this._pendingIntent) {
                let direction = this._queuedSwipes.shift()
                if (!direction) {
                    direction = this._pendingIntent
                    this._pendingIntent = null
                }
                const canTurn = direction === 'next' ? this.adapter.canTurnNext() : this.adapter.canTurnPrev()
                if (canTurn) {
                    // Yield one turn so FoliatePageSnapshots.refresh(0) can begin preparing the
                    // next page instead of starving behind synchronous queued swipe draining.
                    if (this.getEffectiveMode() === 'cover' && !this.adapter.getCurlSnapshot?.(direction)) {
                        await new Promise(resolve => setTimeout(resolve, 0))
                        if (this._destroyed || curGen !== this.generation || this.state !== 'idle' || !this.adapter?.isSessionValid?.()) {
                            return
                        }
                    }
                    await this._requestTurn(direction)
                    return
                }
            }
        }
        if (this.touchStart) this.state = 'preparing'
    }

    async _commitCoverTurn(direction, curGen, options) {
        if (this.adapter?.commitRenderedPage && await this.adapter.commitRenderedPage(direction)) return true
        return this._commitTargetTurn(direction, curGen, options)
    }

    async _commitTargetTurn(direction, curGen, { allowSlowFollowUp = true } = {}) {
        const isNext = direction === 'next'
        const adapter = this.adapter
        if (this._destroyed || curGen !== this.generation || !adapter || !adapter.isSessionValid?.()) {
            return false
        }
        if (typeof adapter.waitForTargetReadyAndTurn !== 'function') {
            await (isNext ? adapter.turnNext() : adapter.turnPrev())
            return true
        }
        const ok = await adapter.waitForTargetReadyAndTurn(
            direction,
            () => !this._destroyed && curGen === this.generation && this.adapter === adapter
        )
        if (this._destroyed || curGen !== this.generation || this.adapter !== adapter || !adapter.isSessionValid?.()) {
            return false
        }
        if (ok) return true

        const outcome = adapter._lastTurnOutcome
        if (
            allowSlowFollowUp &&
            !this._pendingIntent &&
            outcome?.retryable &&
            outcome?.reason === 'timeout' &&
            outcome?.target != null
        ) {
            this._armSlowTargetFollowUp(direction, outcome.target, curGen)
        }
        return false
    }

    _armSlowTargetFollowUp(direction, expectedTarget, expectedGen) {
        this._cancelSlowTurnWait()
        const capturedAdapter = this.adapter
        if (!capturedAdapter || !capturedAdapter.isSessionValid?.()) return
        const capturedLoadGen = capturedAdapter._getLoadGeneration?.() ?? null
        const capturedStartPage = capturedAdapter.getCurrentPage?.() ?? null
        const token = ++this._slowTurnToken
        const ctrl = new AbortController()
        this._slowTurnAbort = ctrl

        ;(async () => {
            try {
                const stillValid = () => (
                    !this._destroyed &&
                    !ctrl.signal.aborted &&
                    token === this._slowTurnToken &&
                    expectedGen === this.generation &&
                    this.adapter === capturedAdapter &&
                    capturedAdapter.isSessionValid?.() &&
                    (capturedLoadGen == null || capturedAdapter._getLoadGeneration?.() === capturedLoadGen) &&
                    (capturedStartPage == null || capturedAdapter.getCurrentPage?.() === capturedStartPage) &&
                    capturedAdapter._getTargetPage?.(direction) === expectedTarget
                )

                const ready = typeof capturedAdapter.whenTargetReady === 'function'
                    // Keep the accepted intent subscribed until render completion,
                    // failure, or explicit cancellation, even on a slow device.
                    ? await capturedAdapter.whenTargetReady(direction, { signal: ctrl.signal, timeoutMs: 0 })
                    : false

                await Promise.resolve()
                if (!ready || !stillValid() || this.state !== 'idle') return
                if (capturedAdapter.isBusy?.()) {
                    const idleOk = await this._waitForAdapterIdle(capturedAdapter, ctrl.signal, 0)
                    if (!idleOk || !stillValid() || this.state !== 'idle') return
                }
                if (!capturedAdapter.isTargetReady?.(direction)) return

                await capturedAdapter.waitForTargetReadyAndTurn(
                    direction,
                    stillValid,
                    0,
                    { signal: ctrl.signal }
                )
            } catch {
                // Keep current page intact if slow render fails or is cancelled.
            } finally {
                if (this._slowTurnAbort === ctrl) {
                    this._slowTurnAbort = null
                }
            }
        })()
    }

    _computeDragWidth() {
        const slideCtx = this._activeSlideSession
        if (slideCtx?.kind === 'foliate-dom' && slideCtx.stride > 0) {
            return slideCtx.stride
        }
        return Math.max(1, this.container?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 390) || 390)
    }

    _beginSlideSession(initialDirection) {
        if (!this.adapter || this._activeSlideSession) return
        const slideCtx = this.adapter.getSlideContext?.()
        if (!slideCtx) return

        if (slideCtx.kind === 'foliate-dom') {
            const dragInfo = slideCtx.renderer.beginSlideDrag?.()
            if (!dragInfo) return
            this._activeSlideSession = {
                kind: 'foliate-dom',
                renderer: slideCtx.renderer,
                stride: dragInfo.stride || (this.container?.clientWidth || 390),
                canPrevInSection: Boolean(dragInfo.canVisualLeftInSection),
                canNextInSection: Boolean(dragInfo.canVisualRightInSection),
                canVisualLeft: Boolean(dragInfo.canVisualLeft),
                canVisualRight: Boolean(dragInfo.canVisualRight),
            }
            this._activeDragWidth = this._activeSlideSession.stride
            return
        }

        if (slideCtx.kind === 'pdf-canvas') {
            const visuals = this.adapter.getVisuals?.(initialDirection)
            const width = Math.max(1, this.container?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 390) || 390)
            this._activeDragWidth = width
            this._activeSlideDir = initialDirection
            this._activeSlideSession = {
                kind: 'pdf-canvas',
                width,
                bgColor: visuals?.bgColor || readThemeBgColor(),
                layers: new Map(), // direction -> { currentCanvas, nextCanvas, targetReady }
            }
            if (visuals) {
                this._activeSlideSession.layers.set(initialDirection, visuals)
            }
        }
    }

    _ensurePdfOverlayForDirection(direction) {
        const session = this._activeSlideSession
        const overlay = this._initOverlay()
        if (!session || session.kind !== 'pdf-canvas' || !overlay) return null

        let visuals = session.layers.get(direction)
        if (!visuals) {
            visuals = this.adapter?.getVisuals?.(direction)
            if (visuals) session.layers.set(direction, visuals)
        }
        if (!visuals?.currentCanvas || !visuals.targetReady || !visuals.nextCanvas) {
            return null
        }

        const key = `${direction}:${visuals.nextSnapshot?.pageIndex ?? ''}`
        if (this._overlayLayers?.key === key) {
            return this._overlayLayers
        }

        this._clearOverlay()
        const width = session.width
        const height = Math.max(1, this.container?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600) || 600)

        const wrapper = document.createElement('div')
        wrapper.style.cssText = `position:absolute;inset:0;background:${visuals.bgColor || '#ffffff'};overflow:hidden;`

        const makePanel = (sourceCanvas, xOffset, hasShadow) => {
            const panel = document.createElement('div')
            panel.style.cssText = `position:absolute;inset:0;will-change:transform;transform:translate3d(${xOffset}px,0,0);${hasShadow ? 'box-shadow:0 0 22px rgba(0,0,0,0.16);' : ''}`
            const cvs = document.createElement('canvas')
            cvs.width = sourceCanvas.width || width
            cvs.height = sourceCanvas.height || height
            cvs.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;'
            const cCtx = cvs.getContext?.('2d')
            cCtx?.drawImage?.(sourceCanvas, 0, 0, cvs.width, cvs.height)
            panel.appendChild(cvs)
            return panel
        }

        const isNext = direction === 'next'
        const mode = this.getEffectiveMode()
        const nextInitialX = mode === 'cover' ? 0 : (isNext ? width : -width)
        const curPanel = makePanel(visuals.currentCanvas, 0, mode === 'cover')
        const nextPanel = makePanel(visuals.nextCanvas, nextInitialX, false)

        if (mode === 'cover') {
            wrapper.appendChild(nextPanel)
            wrapper.appendChild(curPanel)
        } else {
            wrapper.appendChild(curPanel)
            wrapper.appendChild(nextPanel)
        }

        this._overlayEl.appendChild(wrapper)
        this._overlayEl.style.display = 'block'
        this._overlayLayers = {
            key,
            direction,
            mode,
            width,
            curPanel,
            nextPanel,
        }
        return this._overlayLayers
    }

    _computeCurlSize() {
        const winW = typeof window !== 'undefined' ? window.innerWidth : 390
        const winH = typeof window !== 'undefined' ? window.innerHeight : 844
        const rect = this.touchStart ? null : this.container?.getBoundingClientRect?.()
        const rectW = rect?.width > 0 ? rect.width : 0
        const rectH = rect?.height > 0 ? rect.height : 0
        const w = Math.max(1, this.touchStart?.width || rectW || this.container?.clientWidth || winW || 390)
        const h = Math.max(1, this.touchStart?.height || rectH || this.container?.clientHeight || winH || 844)
        return { W: w, H: h }
    }

    _beginCurlSession(initialDirection, customStartY = null) {
        if (this.getEffectiveMode() !== 'cover' || this._curlWebGLFailed) return false
        if (!this.adapter?.isCurlAvailable?.()) return false
        const canTurn = initialDirection === 'next' ? this.adapter.canTurnNext() : this.adapter.canTurnPrev()
        if (!canTurn) return false

        const currentSnap = this.adapter.getCurlSnapshot?.('current')
        const targetSnap = this.adapter.getCurlSnapshot?.(initialDirection)
        if (!(currentSnap?.canvas || currentSnap?.bitmap) || !(targetSnap?.canvas || targetSnap?.bitmap)) {
            return false
        }

        const renderer = this._ensureCurlRenderer()
        if (!renderer) return false

        const { W, H } = this._computeCurlSize()
        const deviceDpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1
        const dpr = Math.min(deviceDpr, currentSnap.textureDpr ?? 2, targetSnap.textureDpr ?? 2)
        if (!renderer.resize(W, H, dpr) || !renderer.syncPageTextures(currentSnap, targetSnap)) {
            this._disposeCurlRenderer()
            return false
        }

        const rawStartY = customStartY != null ? customStartY : (this.touchStart?.localY ?? (H * 0.5))
        const cY = CurlGeom.computeSmoothAnchorY(rawStartY, W, H)
        const startX = initialDirection === 'next' ? W : 0
        const c = { x: startX, y: cY }
        const pose = { dir: initialDirection, c: { ...c }, d: { ...c } }

        this._activeCurl = {
            dir: initialDirection,
            W,
            H,
            startY: rawStartY,
            c,
            baseD: { ...c },
            pose,
            geometry: CurlGeom.geometry(pose, W, H),
            currentSnap,
            targetSnap,
            themeParams: computeCurlThemeParams(
                currentSnap.bgColor || readThemeBgColor(),
                currentSnap.isDark
            ),
        }
        if (this._curlHostEl) this._curlHostEl.style.display = 'block'
        if (this._overlayEl) this._overlayEl.style.display = 'block'
        this._clearOverlay()
        return true
    }

    _updateCurlDrag(rawDx, rawDy = 0) {
        const curl = this._activeCurl
        const renderer = this._curlRenderer
        if (!curl || !renderer || renderer._disposed || renderer._contextLost) return false

        const canTurnNext = Boolean(this.adapter?.canTurnNext?.())
        const canTurnPrev = Boolean(this.adapter?.canTurnPrev?.())
        const nextState = CurlGeom.advanceDragControl(
            {
                dir: curl.dir,
                startY: curl.startY,
                c: curl.c,
                baseD: curl.baseD,
            },
            rawDx,
            rawDy,
            {
                W: curl.W,
                H: curl.H,
                canTurnNext,
                canTurnPrev,
            }
        )

        let poseToRender = nextState.pose
        if (nextState.dir !== curl.dir) {
            const reversedTarget = this.adapter?.getCurlSnapshot?.(nextState.dir)
            if (reversedTarget && (reversedTarget.canvas || reversedTarget.bitmap)) {
                if (!renderer.syncPageTextures(curl.currentSnap, reversedTarget)) {
                    return false
                }
                curl.targetSnap = reversedTarget
                curl.dir = nextState.dir
                curl.c = nextState.c
                curl.baseD = nextState.baseD
                curl.pose = nextState.pose
                curl.geometry = nextState.geometry
            } else {
                // Warm reverse neighbor silently without flashing stale/blank sheet
                this.adapter?.ensureTargetWarm?.(nextState.dir)
                const flatX = curl.dir === 'next' ? curl.W : 0
                poseToRender = {
                    dir: curl.dir,
                    c: { x: flatX, y: curl.c.y },
                    d: { x: flatX, y: curl.c.y },
                }
                curl.pose = poseToRender
                curl.geometry = CurlGeom.geometry(poseToRender, curl.W, curl.H)
            }
        } else {
            curl.dir = nextState.dir
            curl.c = nextState.c
            curl.baseD = nextState.baseD
            curl.pose = nextState.pose
            curl.geometry = nextState.geometry
        }

        const viewEl = this.adapter?.getViewElement?.()
        if (viewEl?.style?.transform) {
            viewEl.style.transition = ''
            viewEl.style.transform = ''
        }

        const renderedGeom = renderer.renderPose(poseToRender, { themeParams: curl.themeParams })
        if (!renderedGeom) return false
        curl.geometry = renderedGeom
        const progress = renderedGeom.progress || 0
        this._liveOffsetPx = curl.dir === 'next' ? -progress * curl.W : progress * curl.W
        return true
    }

    _applyLiveOffset(rawDx, rawDy = 0) {
        if (this.getEffectiveMode() === 'cover') {
            if (this._activeCurl && !this._updateCurlDrag(rawDx, rawDy)) {
                this._disposeCurlRenderer()
                this._clearOverlay()
            }
            return
        }

        const session = this._activeSlideSession
        const viewEl = this.adapter?.getViewElement?.()
        const mode = this.getEffectiveMode()
        const width = this._computeDragWidth()
        const isNext = rawDx < 0
        const dir = isNext ? 'next' : 'prev'
        const canTurn = isNext ? this.adapter?.canTurnNext?.() : this.adapter?.canTurnPrev?.()

        if (!canTurn) {
            const sign = rawDx < 0 ? -1 : 1
            const resisted = sign * Math.min(MAX_RESISTANCE_PX, Math.abs(rawDx) * 0.25)
            this._liveOffsetPx = resisted
            if (session?.kind === 'foliate-dom') {
                session.renderer.setSlideDragOffset?.(0)
            }
            this._clearOverlay()
            if (viewEl?.style) {
                viewEl.style.transition = 'none'
                viewEl.style.transform = `translate3d(${resisted}px, 0, 0)`
            }
            return { clampedOffset: resisted, readyForSlide: false, mode }
        }

        if (session?.kind === 'foliate-dom') {
            const inSectionReady = isNext ? session.canNextInSection : session.canPrevInSection
            if (inSectionReady) {
                const clamped = Math.max(-width, Math.min(width, rawDx))
                this._liveOffsetPx = clamped
                if (viewEl?.style?.transform) {
                    viewEl.style.transition = ''
                    viewEl.style.transform = ''
                }
                session.renderer.setSlideDragOffset?.(clamped)
                return { clampedOffset: clamped, readyForSlide: true, mode }
            }
            // Cross-chapter boundary: hold real current chapter visible with subtle resistance;
            // do NOT scroll into Paginator's blank filler margin column.
            session.renderer.setSlideDragOffset?.(0)
            const sign = rawDx < 0 ? -1 : 1
            const resisted = sign * Math.min(MAX_RESISTANCE_PX, Math.abs(rawDx) * 0.25)
            this._liveOffsetPx = resisted
            if (viewEl?.style) {
                viewEl.style.transition = 'none'
                viewEl.style.transform = `translate3d(${resisted}px, 0, 0)`
            }
            return { clampedOffset: resisted, readyForSlide: false, isBoundary: true, mode }
        }

        if (session?.kind === 'pdf-canvas') {
            const layerState = this._ensurePdfOverlayForDirection(dir)
            if (layerState) {
                const clamped = Math.max(-width, Math.min(width, rawDx))
                this._liveOffsetPx = clamped
                if (viewEl?.style?.transform) {
                    viewEl.style.transition = ''
                    viewEl.style.transform = ''
                }
                layerState.curPanel.style.transform = `translate3d(${clamped}px, 0, 0)`
                if (layerState.mode !== 'cover') {
                    const nextX = (isNext ? width : -width) + clamped
                    layerState.nextPanel.style.transform = `translate3d(${nextX}px, 0, 0)`
                }
                return { clampedOffset: clamped, readyForSlide: true, mode: layerState.mode }
            }
            // Target PDF page canvas not painted yet: keep real current page visible with gentle resistance.
            this._clearOverlay()
            this.adapter?.ensureTargetWarm?.(dir)
            const sign = rawDx < 0 ? -1 : 1
            const resisted = sign * Math.min(MAX_RESISTANCE_PX, Math.abs(rawDx) * 0.25)
            this._liveOffsetPx = resisted
            if (viewEl?.style) {
                viewEl.style.transition = 'none'
                viewEl.style.transform = `translate3d(${resisted}px, 0, 0)`
            }
            return { clampedOffset: resisted, readyForSlide: false, isBoundary: true, mode }
        }

        // Generic fallback (no slide session)
        const sign = rawDx < 0 ? -1 : 1
        const resisted = sign * Math.min(MAX_RESISTANCE_PX, Math.abs(rawDx) * 0.25)
        this._liveOffsetPx = resisted
        if (viewEl?.style) {
            viewEl.style.transition = 'none'
            viewEl.style.transform = `translate3d(${resisted}px, 0, 0)`
        }
        return { clampedOffset: resisted, readyForSlide: false, mode }
    }

    _animateProgress(durationMs, curGen, onProgress) {
        if (this._activeAnimResolve) {
            const prevResolve = this._activeAnimResolve
            this._activeAnimResolve = null
            prevResolve(false)
        }
        if (durationMs <= 0) {
            if (curGen === this.generation) {
                const cont = onProgress(1)
                return Promise.resolve(cont !== false && curGen === this.generation)
            }
            return Promise.resolve(false)
        }
        return new Promise((resolve) => {
            this._activeAnimResolve = resolve
            const start = nowMs()
            const finish = (ok) => {
                if (this._activeAnimResolve === resolve) {
                    this._activeAnimResolve = null
                }
                this._animRafId = null
                resolve(ok)
            }
            const step = (ts) => {
                if (curGen !== this.generation) {
                    finish(false)
                    return
                }
                const elapsed = Math.max(0, (ts || nowMs()) - start)
                const progress = Math.min(1, elapsed / durationMs)
                if (onProgress(progress) === false) {
                    finish(false)
                    return
                }
                if (progress < 1) {
                    this._animRafId = safeRaf(step)
                } else {
                    finish(true)
                }
            }
            this._animRafId = safeRaf(step)
        })
    }

    _animateOffset(fromPx, toPx, durationMs, curGen, onStep) {
        if (Math.abs(toPx - fromPx) < 0.5) {
            if (this._activeAnimResolve) {
                const prevResolve = this._activeAnimResolve
                this._activeAnimResolve = null
                prevResolve(false)
            }
            if (curGen === this.generation) onStep(toPx)
            return Promise.resolve(curGen === this.generation)
        }
        return this._animateProgress(durationMs, curGen, (p) => {
            onStep(fromPx + (toPx - fromPx) * easeOutCubic(p))
        })
    }

    async _fallbackTurnWithoutCurl(direction, curGen) {
        if (this._destroyed || curGen !== this.generation || !this.adapter?.isSessionValid?.()) return false
        if (this._curlHostEl) this._curlHostEl.style.display = 'none'
        this._clearOverlay()
        const canTurn = direction === 'next' ? this.adapter.canTurnNext() : this.adapter.canTurnPrev()
        if (!canTurn) return false
        return await this._commitCoverTurn(direction, curGen, { allowSlowFollowUp: true })
    }

    async _turnWithLiveDestination(direction, startY, velocity, curGen) {
        const adapter = this.adapter
        const current = () => curGen === this.generation && adapter === this.adapter && adapter?.isSessionValid?.()
        const { W, H } = this._computeCurlSize()
        const renderer = this._ensureCurlRenderer()
        if (!renderer) {
            this._onCurlUnavailable()
            await this._fallbackTurnWithoutCurl(direction, curGen)
            return
        }
        this._activeCurl = null
        this._clearOverlay()
        const drawOptions = { liveTarget: true }
        let source = adapter.getCurlSnapshot?.('current')
        const upload = value => renderer.resize(W, H, value.textureDpr ?? 2) && renderer.syncPageTextures(value, null)
        try {
            if (!source || !upload(source)) {
                // Let the live page replace the last compositor frame before copying.
                await new Promise(resolve => safeRaf(() => safeRaf(resolve)))
                if (!current()) return
                const prepared = adapter.getCurlSnapshot?.('current')
                const capture = prepared ? null : await platformBridge.captureAndroidReaderPage(this.container.getBoundingClientRect())
                    .catch(() => null)
                if (!current()) { capture?.bitmap.close(); return }
                if (capture) {
                    capture.loadGeneration = 'android-frame'
                    capture.visualVersion = ++capturedPageVersion
                    capture.closeBitmapOnUpload = false
                }
                try {
                    source = prepared || capture || await adapter.prepareCurlSource?.()
                    if (!current()) return
                    if (!source || !upload(source)) {
                        this._onCurlUnavailable()
                        await this._fallbackTurnWithoutCurl(direction, curGen)
                        return
                    }
                } finally {
                    capture?.bitmap.close()
                }
            }
            drawOptions.themeParams = computeCurlThemeParams(source.bgColor || readThemeBgColor(), source.isDark)
            this._overlayEl.style.display = 'block'
            this._curlHostEl.style.display = 'block'
            if (!renderer.renderPose(null, drawOptions)) {
                this._onCurlUnavailable()
                await this._fallbackTurnWithoutCurl(direction, curGen)
                return
            }
            if (!await this._commitCoverTurn(direction, curGen) || !current()) return

            const x = direction === 'next' ? W : 0
            const c = { x, y: CurlGeom.computeSmoothAnchorY(startY, W, H) }
            const pose = { dir: direction, c, d: { ...c } }
            const duration = this._queuedSwipes.length ? 145 : 210
            const plan = CurlGeom.createSettlePlan(pose, velocity, true, W, H, { duration })
            await this._animateProgress(plan.duration, curGen, progress =>
                Boolean(renderer.renderPose(CurlGeom.evaluateSettlePose(plan, progress), drawOptions)))
        } catch (error) {
            if (current()) {
                console.warn('[PageTurnController] Could not render live page curl, falling back to direct turn:', error)
                this._onCurlUnavailable()
                await this._fallbackTurnWithoutCurl(direction, curGen)
            }
        }
    }

    async _settleCurl(curl, commit, velocity, curGen, durationOverride = null) {
        const renderer = this._curlRenderer
        let animated = false
        if (renderer && !renderer._disposed && !renderer._contextLost) {
            if (!commit && CurlGeom.geometry(curl.pose, curl.W, curl.H).flat) return
            const duration = this._queuedSwipes.length ? Math.min(durationOverride ?? 145, 145) : durationOverride
            const options = duration == null ? { maxDuration: commit ? this.animationDuration : undefined } : { duration }
            const plan = CurlGeom.createSettlePlan(curl.pose, velocity, commit, curl.W, curl.H, options)
            animated = await this._animateProgress(plan.duration, curGen, (p) => {
                if (renderer._disposed || renderer._contextLost) return false
                const pose = CurlGeom.evaluateSettlePose(plan, p)
                return Boolean(renderer.renderPose(pose, { themeParams: curl.themeParams }))
            })
        }
        if (commit && curGen === this.generation && !this._destroyed && this.adapter?.isSessionValid?.()) {
            if (animated) await this._commitCoverTurn(curl.dir, curGen, { allowSlowFollowUp: false })
            else await this._turnWithLiveDestination(curl.dir, curl.startY ?? curl.H * 0.86, velocity, curGen)
        }
    }

    /**
     * Programmatic animated transition (tap / key / click)
     */
    async _performTransition(direction, mode) {
        const adapter = this.adapter
        if (this._destroyed || !adapter || !adapter.isSessionValid?.()) return
        if (this.isReducedMotion() || mode === 'none' || mode === 'scroll') {
            const fastGen = ++this.generation
            await this._commitTargetTurn(direction, fastGen, { allowSlowFollowUp: true })
            return
        }

        const curGen = ++this.generation
        this.state = 'settling'

        const isNext = direction === 'next'
        try {
            if (mode === 'cover') {
                const { H } = this._computeCurlSize()
                const velocity = { vx: isNext ? -0.95 : 0.95, vy: -0.22 }
                if (this._beginCurlSession(direction, H * 0.86)) {
                    const duration = Math.max(180, Math.round((this.animationDuration || 190) * 1.45))
                    await this._settleCurl(this._activeCurl, true, velocity, curGen, duration)
                } else {
                    await this._turnWithLiveDestination(direction, H * 0.86, velocity, curGen)
                }
                return
            }

            this._beginSlideSession(direction)
            const width = this._computeDragWidth()
            const session = this._activeSlideSession

            if (session?.kind === 'foliate-dom') {
                const inSectionReady = isNext ? session.canNextInSection : session.canPrevInSection
                if (inSectionReady) {
                    const targetPx = isNext ? -width : width
                    const finished = await this._animateOffset(0, targetPx, this.animationDuration, curGen, (px) => {
                        this._liveOffsetPx = px
                        session.renderer.setSlideDragOffset?.(px)
                    })
                    if (!finished || this._destroyed || curGen !== this.generation || this.adapter !== adapter) return
                    await session.renderer.endSlideDrag?.({ commitVisualDir: isNext ? 1 : -1 })
                } else {
                    // Cross-chapter: keep old real content visible until new chapter finishes loading & styling,
                    // then paginator reveals/slides cleanly with zero blank flash.
                    await session.renderer.endSlideDrag?.({ commitVisualDir: 0 })
                    if (this._destroyed || curGen !== this.generation || this.adapter !== adapter || !adapter.isSessionValid?.()) return
                    await (isNext ? adapter.turnNext() : adapter.turnPrev())
                }
                return
            }

            if (session?.kind === 'pdf-canvas') {
                const layerState = this._ensurePdfOverlayForDirection(direction)
                if (layerState) {
                    const targetPx = isNext ? -width : width
                    const finished = await this._animateOffset(0, targetPx, this.animationDuration, curGen, (px) => {
                        this._liveOffsetPx = px
                        layerState.curPanel.style.transform = `translate3d(${px}px, 0, 0)`
                        if (layerState.mode !== 'cover') {
                            const nextX = (isNext ? width : -width) + px
                            layerState.nextPanel.style.transform = `translate3d(${nextX}px, 0, 0)`
                        }
                    })
                    if (!finished || this._destroyed || curGen !== this.generation || this.adapter !== adapter || !adapter.isSessionValid?.()) return
                    await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
                    return
                }
                await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
                return
            }

            // Target adjacent page is not yet rasterized/ready: keep current real page visible and commit cleanly.
            await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
        } catch (err) {
            console.warn('[PageTurnController] Transition failed:', err)
        } finally {
            if (curGen === this.generation) {
                this._finalizeTransitionCleanup(curGen)
                await this._flushPendingIntent(curGen)
            }
        }
    }

    _finalizeTransitionCleanup(curGen) {
        if (curGen !== this.generation) return
        this._stopAnimationsAndRaf()
        const session = this._activeSlideSession
        this._activeSlideSession = null
        this._activeSlideDir = null
        this._activeDragWidth = 0
        this._liveOffsetPx = 0
        this._activeCurl = null
        if (session?.kind === 'foliate-dom') {
            try { session.renderer?.endSlideDrag?.({ commitVisualDir: 0 }) } catch {}
        }
        // Normal navigation within a Foliate chapter can reuse both the
        // visible neighbor canvas and its GPU texture on the next gesture.
        const retained = this.adapter?.retainTurnVisuals?.()
        if (!retained) this._curlRenderer?.releasePageTextures?.()
        if (this._curlHostEl) {
            this._curlHostEl.style.display = 'none'
        }
        this._clearOverlay()
        if (!retained) this.adapter?.clearVisualCache?.()
        const viewEl = this.adapter?.getViewElement?.()
        if (viewEl?.style) {
            viewEl.style.transition = ''
            viewEl.style.transform = ''
        }
        this.state = 'idle'
    }

    /**
     * Touch Event Handlers for Interactive Single-Owner Dragging
     */
    handleTouchStart(e) {
        const eventKey = e?.sourceEvent || e
        if (!eventKey || this._seenEvents.has(eventKey)) return
        this._seenEvents.add(eventKey)

        if (!this.adapter || !this.adapter.isSessionValid?.()) return
        if (this.getEffectiveMode() === 'scroll') return
        if (this._isInteractiveControlTarget(e.target)) return
        if (this.isGestureBlocked()) return
        if (!e.touches || e.touches.length !== 1) {
            this._cancelTouch()
            return
        }

        const touch = e.touches[0]
        const winW = (typeof window !== 'undefined' ? window.innerWidth : 390) || 390
        const winH = (typeof window !== 'undefined' ? window.innerHeight : 844) || 844
        const rect = this.container?.getBoundingClientRect?.() || {
            left: 0,
            top: 0,
            right: winW,
            bottom: winH,
            width: winW,
            height: winH,
        }
        const rectW = Math.max(1, rect.width || (rect.right - rect.left) || winW)
        const rectH = Math.max(1, rect.height || (rect.bottom - rect.top) || winH)
        if (
            touch.clientX - rect.left < EDGE_BACK_MARGIN_PX ||
            rect.right - touch.clientX < EDGE_BACK_MARGIN_PX
        ) {
            // Respect Android / OS left & right edge-back swipe gestures
            return
        }

        // Finish any active settle animation immediately so rapid swipes commit
        // the prior turn cleanly and hand off to the new gesture without stalling.
        if (this.state === 'settling') {
            this._stopAnimationsAndRaf(true)
        } else if (this.state !== 'idle') {
            this.cancelCurrent({ keepPreparedPages: true })
        }

        const now = nowMs()
        this.touchStart = {
            x: touch.clientX,
            y: touch.clientY,
            localX: CurlGeom.clamp(touch.clientX - (rect.left || 0), 0, rectW),
            localY: CurlGeom.clamp(touch.clientY - (rect.top || 0), 0, rectH),
            time: now,
            width: rectW,
            height: rectH,
        }
        this._samples = [{ x: touch.clientX, y: touch.clientY, t: now }]
        this.currentDrag = null
        if (this.state === 'idle' && !this.adapter.isBusy?.()) this.state = 'preparing'
        this.isGestureActive = false
    }

    _clearTouch() {
        this.touchStart = null
        this.currentDrag = null
        this._samples = []
        this.isGestureActive = false
    }

    _cancelTouch() {
        if (!this.touchStart) return
        if (this.state === 'preparing' || this.state === 'dragging') this.cancelCurrent()
        else this._clearTouch()
    }

    _recordTouchMotion(touch, now) {
        const { clientX: x, clientY: y } = touch
        const last = this._samples[this._samples.length - 1]
        if (last?.x !== x || last?.y !== y) this._samples.push({ x, y, t: now })
        const cutoff = now - VELOCITY_WINDOW_MS
        while (this._samples.length > 2 && this._samples[0].t < cutoff) this._samples.shift()
        return { deltaX: x - this.touchStart.x, deltaY: y - this.touchStart.y }
    }

    _isHorizontalMotion(deltaX, deltaY) {
        return Math.abs(deltaX) >= HORIZONTAL_LOCK_PX && Math.abs(deltaX) >= Math.abs(deltaY) * HORIZONTAL_LOCK_RATIO
    }

    handleTouchMove(e) {
        const eventKey = e?.sourceEvent || e
        if (!eventKey || this._seenEvents.has(eventKey)) return
        this._seenEvents.add(eventKey)

        if (!this.touchStart) return
        if (!e.touches || e.touches.length !== 1 || this.isGestureBlocked()) {
            this._cancelTouch()
            return
        }

        const { deltaX, deltaY } = this._recordTouchMotion(e.touches[0], nowMs())
        if (!this.isGestureActive && !this._isHorizontalMotion(deltaX, deltaY)) {
            if (Math.abs(deltaY) >= VERTICAL_YIELD_PX && Math.abs(deltaY) > Math.abs(deltaX)) {
                this._clearTouch()
                if (this.state === 'preparing') this.state = 'idle'
            }
            return
        }

        if (this.state === 'idle' && !this.adapter.isBusy?.()) this.state = 'preparing'
        this.isGestureActive = true
        const mode = this.getEffectiveMode()
        const direction = deltaX < 0 ? 'next' : 'prev'
        const starting = this.state === 'preparing'
        if (starting) {
            this._cancelSlowTurnWait()
            this.state = 'dragging'
            if (mode === 'slide') this._beginSlideSession(direction)
        }
        if (this.state === 'dragging' && mode === 'cover' && !this._activeCurl) {
            this.adapter?.prepareCurlDirection?.(direction)
            if (starting || (this.adapter?.getCurlSnapshot?.('current') && this.adapter?.getCurlSnapshot?.(direction))) {
                this._beginCurlSession(direction)
            }
        }

        if (e.cancelable) e.preventDefault()
        this.currentDrag = { deltaX, deltaY }

        if (this.state === 'dragging') {
            if (!this._activeCurl && !this._activeSlideSession && mode !== 'slide') return

            if (!this._dragRafId) {
                const curGen = this.generation
                this._dragRafId = safeRaf(() => {
                    this._dragRafId = null
                    if (curGen !== this.generation || this.state !== 'dragging' || !this.currentDrag) return
                    this._applyLiveOffset(this.currentDrag.deltaX, this.currentDrag.deltaY)
                })
            }
        }
    }

    handleTouchCancel(e) {
        const eventKey = e?.sourceEvent || e
        if (eventKey) {
            if (this._seenEvents.has(eventKey)) return
            this._seenEvents.add(eventKey)
        }
        this._cancelTouch()
    }

    _computeReleaseVelocity(now) {
        const cutoff = now - VELOCITY_WINDOW_MS
        const recent = this._samples.filter(s => s.t >= cutoff)
        if (recent.length < 2) return { vx: 0, vy: 0 }
        const first = recent[0]
        const last = recent[recent.length - 1]
        const dt = last.t - first.t
        if (dt <= 0) return { vx: 0, vy: 0 }
        const denom = Math.max(8, dt)
        return {
            vx: (last.x - first.x) / denom,
            vy: ((last.y ?? 0) - (first.y ?? 0)) / denom,
        }
    }

    _computeReleaseVelocityX(now) {
        return this._computeReleaseVelocity(now).vx
    }

    async handleTouchEnd(e) {
        const eventKey = e?.sourceEvent || e
        if (eventKey) {
            if (this._seenEvents.has(eventKey)) return
            this._seenEvents.add(eventKey)
        }

        if (!this.touchStart) return
        if (e?.touches?.length || this.isGestureBlocked()) {
            this._cancelTouch()
            return
        }

        const now = nowMs()
        const point = e?.changedTouches?.[0]
        const motion = point ? this._recordTouchMotion(point, now) : this.currentDrag
        if (!this.isGestureActive && (!motion || !this._isHorizontalMotion(motion.deltaX, motion.deltaY))) {
            this._clearTouch()
            if (this.state === 'preparing') this.state = 'idle'
            return
        }

        safeCancelRaf(this._dragRafId)
        this._dragRafId = null
        const { deltaX, deltaY } = motion
        const direction = deltaX < 0 ? 'next' : 'prev'
        const velocity = this._computeReleaseVelocity(now)
        const forwardSpeed = direction === 'next' ? -velocity.vx : velocity.vx
        const absDx = Math.abs(deltaX)
        const width = this.state === 'settling' ? this.touchStart.width : this._computeDragWidth()
        const flicked = forwardSpeed >= FLICK_VELOCITY_PX_MS && absDx >= FLICK_MIN_DISTANCE_PX
        const accepted = forwardSpeed >= -REVERSE_CANCEL_VELOCITY &&
            absDx >= HORIZONTAL_LOCK_PX && (absDx >= width * COMMIT_RATIO || flicked)
        const mode = this.getEffectiveMode()

        const startY = this.touchStart.localY
        if (this.state === 'dragging' && mode !== 'none') this._applyLiveOffset(deltaX, deltaY)
        this._lastConsumedTouchTs = now
        this._clearTouch()

        if (this.state === 'settling' || (this.adapter.isBusy?.() && !this._activeSlideSession)) {
            if (accepted) this._queuedSwipes.push(direction)
            if (this.state !== 'settling') {
                this.state = 'idle'
                await this._flushPendingIntent(this.generation)
            }
            return
        }

        const canTurn = direction === 'next' ? this.adapter.canTurnNext() : this.adapter.canTurnPrev()
        const shouldCommit = accepted && canTurn
        const activeCurl = this._activeCurl
        const curGen = ++this.generation
        this.state = 'settling'

        try {
            if (mode === 'cover') {
                if (activeCurl && (!shouldCommit || activeCurl.dir === direction)) {
                    await this._settleCurl(activeCurl, shouldCommit, velocity, curGen)
                } else if (shouldCommit) {
                    await this._turnWithLiveDestination(direction, startY, velocity, curGen)
                }
                return
            }

            if (!shouldCommit) {
                await this._settleSnapback(curGen)
                return
            }

            if (mode === 'none' || mode === 'scroll') {
                await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
                return
            }

            await this._settleCommit(direction, width, curGen)
        } catch (err) {
            console.warn('[PageTurnController] Touch settle failed:', err)
        } finally {
            if (curGen === this.generation) {
                this._finalizeTransitionCleanup(curGen)
                await this._flushPendingIntent(curGen)
            }
        }
    }

    async _settleSnapback(curGen) {
        const startPx = this._liveOffsetPx || 0
        if (Math.abs(startPx) < 0.5) return
        const duration = Math.min(170, Math.max(90, this.animationDuration * 0.85))
        const session = this._activeSlideSession
        const viewEl = this.adapter?.getViewElement?.()

        await this._animateOffset(startPx, 0, duration, curGen, (px) => {
            this._liveOffsetPx = px
            if (this._overlayLayers) {
                const { curPanel, nextPanel, mode, direction, width } = this._overlayLayers
                curPanel.style.transform = `translate3d(${px}px, 0, 0)`
                if (mode !== 'cover') {
                    const nextX = (direction === 'next' ? width : -width) + px
                    nextPanel.style.transform = `translate3d(${nextX}px, 0, 0)`
                }
            } else if (session?.kind === 'foliate-dom' && session.renderer) {
                if (viewEl?.style?.transform) {
                    viewEl.style.transform = `translate3d(${px}px, 0, 0)`
                } else {
                    session.renderer.setSlideDragOffset?.(px)
                }
            } else if (viewEl?.style) {
                viewEl.style.transform = `translate3d(${px}px, 0, 0)`
            }
        })
    }

    async _settleCommit(direction, width, curGen) {
        const isNext = direction === 'next'
        const adapter = this.adapter
        const session = this._activeSlideSession
        const viewEl = adapter?.getViewElement?.()

        if (session?.kind === 'foliate-dom') {
            const inSectionReady = isNext ? session.canNextInSection : session.canPrevInSection
            if (inSectionReady) {
                const startPx = this._liveOffsetPx || 0
                const targetPx = isNext ? -width : width
                const remainingFrac = Math.min(1, Math.abs(targetPx - startPx) / Math.max(1, width))
                const duration = Math.max(90, Math.round(this.animationDuration * (0.45 + 0.55 * remainingFrac)))
                const ok = await this._animateOffset(startPx, targetPx, duration, curGen, (px) => {
                    this._liveOffsetPx = px
                    session.renderer.setSlideDragOffset?.(px)
                })
                if (!ok || this._destroyed || curGen !== this.generation || this.adapter !== adapter) return
                await session.renderer.endSlideDrag?.({ commitVisualDir: isNext ? 1 : -1 })
                return
            }

            // Cross-chapter boundary: settle any slight rubber-band while keeping current view visible,
            // then invoke cross-chapter turn which keeps old content visible until new chapter loads.
            if (viewEl?.style?.transform) {
                await this._animateOffset(this._liveOffsetPx || 0, 0, 90, curGen, (px) => {
                    viewEl.style.transform = `translate3d(${px}px, 0, 0)`
                })
                if (this._destroyed || curGen !== this.generation || this.adapter !== adapter) return
                viewEl.style.transform = ''
            }
            await session.renderer.endSlideDrag?.({ commitVisualDir: 0 })
            if (this._destroyed || curGen !== this.generation || !adapter || this.adapter !== adapter || !adapter.isSessionValid?.()) return
            await (isNext ? adapter.turnNext() : adapter.turnPrev())
            return
        }

        if (session?.kind === 'pdf-canvas') {
            const layerState = this._ensurePdfOverlayForDirection(direction)
            if (layerState) {
                const startPx = this._liveOffsetPx || 0
                const targetPx = isNext ? -width : width
                const remainingFrac = Math.min(1, Math.abs(targetPx - startPx) / Math.max(1, width))
                const duration = Math.max(90, Math.round(this.animationDuration * (0.45 + 0.55 * remainingFrac)))
                const ok = await this._animateOffset(startPx, targetPx, duration, curGen, (px) => {
                    this._liveOffsetPx = px
                    layerState.curPanel.style.transform = `translate3d(${px}px, 0, 0)`
                    if (layerState.mode !== 'cover') {
                        const nextX = (isNext ? width : -width) + px
                        layerState.nextPanel.style.transform = `translate3d(${nextX}px, 0, 0)`
                    }
                })
                if (!ok || this._destroyed || curGen !== this.generation || !adapter || this.adapter !== adapter || !adapter.isSessionValid?.()) return
                await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
                return
            }
            if (viewEl?.style?.transform) {
                await this._animateOffset(this._liveOffsetPx || 0, 0, 90, curGen, (px) => {
                    viewEl.style.transform = `translate3d(${px}px, 0, 0)`
                })
                if (this._destroyed || curGen !== this.generation) return
                viewEl.style.transform = ''
            }
            await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
            return
        }

        // Adjacent page not ready: settle any edge pull back to 0 without blanking screen, then turn cleanly.
        if (viewEl?.style?.transform) {
            await this._animateOffset(this._liveOffsetPx || 0, 0, 90, curGen, (px) => {
                viewEl.style.transform = `translate3d(${px}px, 0, 0)`
            })
            if (this._destroyed || curGen !== this.generation) return
            viewEl.style.transform = ''
        }
        await this._commitTargetTurn(direction, curGen, { allowSlowFollowUp: true })
    }
}
