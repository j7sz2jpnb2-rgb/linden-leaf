// Independent PDF viewport shared by PDF.js and native MuPDF.
// Rendering is virtualized/cancellable; PDF.js owns its TextLayer, while
// MuPDF selection is based on engine character geometry in page coordinates.

import { isContentIdentityMatching } from './db.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const sleepFrame = () => new Promise(requestAnimationFrame)

const quadBounds = q => {
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export class PdfViewport {
    constructor(container, options = {}) {
        this.container = container
        this.options = Object.assign({
            scale: 1.25,
            minScale: 0.5,
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
            onHighlightCreate: null,
            onHighlightClick: null,
        }, options)

        this.scale = this.options.scale
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

        this._initDOM()
        this._bindEvents()
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
        .pdf-viewport-spacer{position:relative;margin:0 auto;box-sizing:border-box;padding:16px 0}
        .pdf-page-slot{position:absolute;left:50%;transform:translateX(-50%);background:var(--book-bg,#fff);box-shadow:0 4px 18px #00000047;border-radius:2px;overflow:hidden;box-sizing:border-box;touch-action:pan-y}
        .pdf-img-wrapper{position:absolute;inset:0;overflow:hidden;pointer-events:none}
        .pdf-page-canvas{position:absolute;inset:0;width:100%;height:100%;filter:var(--reader-img-filter,none);pointer-events:none}
        .pdf-page-preview{position:absolute;inset:0;width:100%;height:100%;filter:var(--reader-img-filter,none);pointer-events:none;z-index:1}
        .pdf-clip-canvas{position:absolute;left:0;width:100%;filter:var(--reader-img-filter,none);pointer-events:none;z-index:2}
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
            if (ticking) return
            ticking = true
            requestAnimationFrame(() => {
                ticking = false
                this._detectCurrentPage()
                this._renderVisibleSlots()
                this._pumpRenderQueue()
            })
        })

        this.scrollArea.addEventListener('mouseup', e => {
            if (this.driver?.kind !== 'mupdf') this._handleDomSelection(e)
        })
        this.scrollArea.addEventListener('pointerdown', e => this._nativePointerDown(e))
        this.scrollArea.addEventListener('pointermove', e => this._nativePointerMove(e))
        this.scrollArea.addEventListener('pointerup', e => this._nativePointerUp(e))
        this.scrollArea.addEventListener('pointercancel', () => this._cancelNativeDrag())
        this.scrollArea.addEventListener('dblclick', e => this._nativeDoubleClick(e))

        this.scrollArea.addEventListener('click', e => {
            if (this._nativeDrag) return
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim()) return
            const slot = e.target.closest?.('.pdf-page-slot')
            if (!slot) return
            const page = Number(slot.dataset.page)
            const rect = slot.getBoundingClientRect()
            const x = (e.clientX - rect.left) / rect.width
            const y = (e.clientY - rect.top) / rect.height
            for (const hl of [...(this.highlightsByPage.get(page) || [])].reverse()) {
                const segment = this._highlightSegment(hl, page)
                for (const [x1, y1, x2, y2] of segment?.rects || []) {
                    if (x >= x1 - 6 / rect.width && x <= x2 + 6 / rect.width && y >= y1 - 6 / rect.height && y <= y2 + 6 / rect.height) {
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
        this._renderConcurrency = this.driver.kind === 'mupdf' ? 1 : 2
        this._recomputeLayout()

        // Contract 1D: Initial target page set before first render is queued
        const resolvedInitialPage = typeof initialPage === 'function' ? initialPage(this.numPages) : initialPage
        const targetPage = clamp(resolvedInitialPage, 0, this.numPages - 1)
        this.currentPage = targetPage
        const targetOffset = this.pageOffsets[targetPage]
        if (targetOffset) {
            this.scrollArea.scrollTop = Math.max(0, targetOffset.top + targetOffset.height * clamp(initialYRatio, 0, 1) - (initialYRatio ? this.scrollArea.clientHeight / 3 : 8))
        }

        this._renderVisibleSlots(true)
        this._geometryAbort = new AbortController()
        this._enqueueGeometry(targetPage)
        return { numPages: this.numPages, title: info.title || 'PDF 文档', author: info.author || '未知作者', toc: info.toc || [] }
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
                const old = this.pageOffsets[anchorPage]
                const ratio = old?.height ? clamp((this.scrollArea.scrollTop - old.top) / old.height, 0, 1) : 0
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
                    this._recomputeLayout()
                    const now = this.pageOffsets[anchorPage]
                    if (now) this.scrollArea.scrollTop = Math.max(0, now.top + now.height * ratio)
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

    _recomputeLayout() {
        this.pageOffsets = []
        let y = 16, maxWidth = 0
        for (const size of this.pageSizes) {
            const width = Math.max(1, Math.round(size.width * this.scale))
            const height = Math.max(1, Math.round(size.height * this.scale))
            this.pageOffsets.push({ top: y, width, height })
            y += height + 16
            maxWidth = Math.max(maxWidth, width)
        }
        this.totalHeight = y
        this.spacer.style.height = `${y}px`
        this.spacer.style.width = `${maxWidth + 32}px`
    }

    _syncActiveSlotGeometry() {
        for (const [page, slot] of this.activeSlots) {
            const p = this.pageOffsets[page]
            if (!p) continue
            slot.style.top = `${p.top}px`
            slot.style.width = `${p.width}px`
            slot.style.height = `${p.height}px`
        }
    }

    _firstPageAt(y) {
        let lo = 0, hi = this.pageOffsets.length
        while (lo < hi) {
            const mid = (lo + hi) >>> 1, p = this.pageOffsets[mid]
            if (p.top + p.height < y) lo = mid + 1
            else hi = mid
        }
        return lo
    }

    _isPageQueuedOrRendering(page, token) {
        const inQueue = this._renderQueue.some(x => x.page === page && x.token === token)
        if (inQueue) return true
        const inFlight = this._inFlightRenders.get(page)
        if (inFlight && inFlight.token === token && !inFlight.abortController?.signal?.aborted) return true
        return false
    }

    _renderVisibleSlots(force = false) {
        if (!this.pageOffsets.length) return
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const first = this._firstPageAt(top)
        let last = first
        for (let i = first; i < this.pageOffsets.length && this.pageOffsets[i].top <= bottom; i++) last = i
        this._enqueueGeometry(first)
        if (last !== first) this._enqueueGeometry(last)
        const start = Math.max(0, first - this.options.bufferPages)
        const end = Math.min(this.pageOffsets.length - 1, last + this.options.bufferPages)
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
                    if (vTop < slot._renderedClip.top || vBottom > slot._renderedClip.bottom) {
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
        slot.renderAbort?.abort()
        if (slot.geometryIdleId != null) window.cancelIdleCallback?.(slot.geometryIdleId)
        if (slot.geometryTimer != null) clearTimeout(slot.geometryTimer)
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
        Object.assign(slot.style, { top: `${layout.top}px`, width: `${layout.width}px`, height: `${layout.height}px` })

        const pixels = document.createElement('div'); pixels.className = 'pdf-img-wrapper'
        const highlights = document.createElement('div'); highlights.className = 'pdf-highlight-layer'
        const selection = document.createElement('div'); selection.className = 'pdf-native-selection-layer'
        const text = document.createElement('div'); text.className = 'pdf-text-layer'
        if (this.driver?.kind === 'mupdf') text.style.display = 'none'
        slot.append(pixels, highlights, selection, text)
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

    _renderScale(page) {
        const size = this.pageSizes[page] || { width: 595, height: 842 }
        let scale = this.scale * Math.min(window.devicePixelRatio || 1, 2)
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
        const key = this._cacheKey(page, scale, clip)
        if (this._bitmapCache.has(key)) {
            this._bitmapCacheBytes -= this._bitmapCache.get(key).bytes
            this._bitmapCache.delete(key)
        }
        while (this._bitmapCacheBytes + bytes > this._bitmapCacheLimitBytes && this._bitmapCache.size > 0) {
            let victimKey = null
            for (const [k, entry] of this._bitmapCache) {
                if (entry.page === this.currentPage) continue
                victimKey = k
                break
            }
            if (!victimKey) victimKey = this._bitmapCache.keys().next().value
            const victim = this._bitmapCache.get(victimKey)
            this._bitmapCacheBytes -= victim.bytes
            this._bitmapCache.delete(victimKey)
        }
        this._bitmapCache.set(key, { canvas, bytes, page, scale, clip, time: performance.now() })
        this._bitmapCacheBytes += bytes
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
            const scale = this._renderScale(page)
            const priority = renderEntry?.tier ?? 0
            const generation = token

            // V1-B: Bounded Viewport High-Res Clip Calculation
            let clip = null
            let requestedClip = null
            const size = this.pageSizes[page] || { width: 595, height: 842 }
            const fullDevW = Math.round(size.width * scale)
            const fullDevH = Math.round(size.height * scale)
            const totalPixels = fullDevW * fullDevH
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
                const visRatio = visHeight / Math.max(1, pageOffset.height)

                // Only clip if page is partially visible (< 85% visible in scroll area)
                if (visRatio < 0.85 && visHeight > 0) {
                    const bleed = Math.round(this.scrollArea.clientHeight * 0.20)
                    let cssY0 = Math.max(0, visTop - bleed)
                    let cssY1 = Math.min(pageOffset.height, visBottom + bleed)

                    const GRID_STEP = 64
                    cssY0 = Math.floor(cssY0 / GRID_STEP) * GRID_STEP
                    cssY1 = Math.min(pageOffset.height, Math.ceil(cssY1 / GRID_STEP) * GRID_STEP)

                    const cssToDev = scale / this.scale
                    const devY0 = Math.max(0, Math.floor(cssY0 * cssToDev))
                    const devY1 = Math.min(fullDevH, Math.ceil(cssY1 * cssToDev))

                    if (devY1 - devY0 >= 64 && devY1 <= fullDevH) {
                        clip = [0, devY0, fullDevW, devY1]
                        requestedClip = { top: cssY0, bottom: cssY1, devY0, devY1 }
                    }
                }
            }

            let canvas = null
            const cacheKey = this._cacheKey(page, scale, clip)
            const cached = this._bitmapCache.get(cacheKey)
            if (cached && cached.canvas && !clip) {
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
                canvas.classList.add('pdf-page-canvas')
                canvas.style.position = 'absolute'
                canvas.style.inset = '0'
                canvas.style.width = '100%'
                canvas.style.height = '100%'
                pixels.replaceChildren(canvas)
                slot._renderedClip = null
            } else {
                // Clipped render with preview handover
                canvas.classList.add('pdf-clip-canvas')
                const cssTop = (canvas.offsetY ?? 0) / cssToDev
                const cssHeight = canvas.height / cssToDev
                canvas.style.position = 'absolute'
                canvas.style.left = '0'
                canvas.style.top = `${cssTop}px`
                canvas.style.width = '100%'
                canvas.style.height = `${cssHeight}px`
                canvas.style.filter = 'var(--reader-img-filter,none)'
                canvas.style.pointerEvents = 'none'
                canvas.style.zIndex = '2'

                const existingPageCanvas = pixels.querySelector('.pdf-page-canvas, .pdf-page-preview')
                pixels.querySelectorAll('.pdf-clip-canvas').forEach(c => c.remove())

                if (existingPageCanvas) {
                    existingPageCanvas.className = 'pdf-page-preview'
                    existingPageCanvas.style.zIndex = '1'
                    pixels.prepend(canvas)
                } else {
                    pixels.replaceChildren(canvas)
                }

                slot._renderedClip = {
                    top: requestedClip ? requestedClip.top : cssTop,
                    bottom: requestedClip ? requestedClip.bottom : (cssTop + cssHeight),
                    scale: this.scale
                }
            }

            slot._renderedScale = this.scale
            slot._renderedToken = token

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
                if (typeof window.requestIdleCallback === 'function') {
                    slot.geometryIdleId = window.requestIdleCallback(warm, { timeout: 500 })
                } else {
                    slot.geometryTimer = setTimeout(warm, 0)
                }
            }

            if (this.driver.kind === 'pdfjs' && this.driver.renderTextLayer) {
                await this.driver.renderTextLayer(page, text, this.scale, signal)
            }
            if (isCurrent() && page === this.currentPage && !this._outlineRequested && this.driver.getOutline) {
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

    _highlightSegment(hl, page) {
        const target = hl?.pdfTarget
        if (!target) return null
        if (Array.isArray(target.segments)) return target.segments.find(x => x.page === page) || null
        return target.page === page ? target : null
    }

    _renderHighlightsForPage(page, layer) {
        layer.replaceChildren()
        for (const hl of this.highlightsByPage.get(page) || []) {
            const segment = this._highlightSegment(hl, page)
            for (const rect of segment?.rects || []) {
                const [x1, y1, x2, y2] = rect
                const el = document.createElement('div')
                const style = hl.style || 'highlight'
                el.className = `pdf-highlight-rect pdf-style-${style}`
                el.dataset.id = hl.id
                Object.assign(el.style, {
                    left: `${x1 * 100}%`, top: `${y1 * 100}%`,
                    width: `${Math.max(0, x2 - x1) * 100}%`, height: `${Math.max(0, y2 - y1) * 100}%`,
                })
                const color = hl.color || '#facc15'
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

    _toRgba(color, alpha = .38) {
        if (!color) return `rgba(250,204,21,${alpha})`
        if (color.startsWith('rgba')) return color
        if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `,${alpha})`)
        const named = { yellow:[250,204,21],green:[34,197,94],blue:[59,130,246],pink:[236,72,153],purple:[168,85,247],red:[239,68,68],orange:[249,115,22],gray:[148,163,184] }
        if (named[color.toLowerCase?.()]) return `rgba(${named[color.toLowerCase()].join(',')},${alpha})`
        if (/^#[0-9a-f]{3,6}$/i.test(color)) {
            let c = color.slice(1); if (c.length === 3) c = c.split('').map(x => x + x).join('')
            const n = parseInt(c, 16); return `rgba(${n>>16&255},${n>>8&255},${n&255},${alpha})`
        }
        return color
    }

    _handleDomSelection() {
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
        const size = this.pageSizes[hit.page] || { width:595,height:842,x0:0,y0:0 }
        return [
            (size.x0 || 0) + clamp((x - hit.rect.left) / hit.rect.width, 0, 1) * size.width,
            (size.y0 || 0) + clamp((y - hit.rect.top) / hit.rect.height, 0, 1) * size.height,
        ]
    }

    async _hitNativeChar(page, point) {
        const geom = await this._ensureNativeGeometry(page)
        if (!geom?.chars?.length) return null
        const { chars, grid, cellSize } = geom
        const gx = Math.floor(point[0] / cellSize), gy = Math.floor(point[1] / cellSize)
        const ids = new Set()
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
            for (const id of grid.get(`${gx+dx}:${gy+dy}`) || []) ids.add(id)
        const candidates = ids.size ? [...ids].map(i => chars[i]) : chars
        let best = null, dist = Infinity
        for (const ch of candidates) {
            const [x0,y0,x1,y1] = ch.bounds
            const dx = point[0] < x0 ? x0-point[0] : point[0] > x1 ? point[0]-x1 : 0
            const dy = point[1] < y0 ? y0-point[1] : point[1] > y1 ? point[1]-y1 : 0
            const d = dx*dx + dy*dy
            if (d < dist) { dist = d; best = ch }
        }
        return best
    }

    async _nativePointerDown(e) {
        if (this.driver?.kind !== 'mupdf' || e.button !== 0) return
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const ch = await this._hitNativeChar(hit.page, point)
        if (!ch) return
        e.preventDefault()
        this.scrollArea.setPointerCapture?.(e.pointerId)
        this._nativeDrag = { pointerId:e.pointerId, anchor:{ page:hit.page,index:ch.index,point }, focus:{ page:hit.page,index:ch.index,point } }
        this._updateNativePreview()
    }

    async _nativePointerMove(e) {
        const drag = this._nativeDrag
        if (!drag || e.pointerId !== drag.pointerId) return
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const ch = await this._hitNativeChar(hit.page, point)
        if (!ch || this._nativeDrag !== drag) return
        drag.focus = { page:hit.page,index:ch.index,point }
        this._updateNativePreview()
    }

    async _nativePointerUp(e) {
        const drag = this._nativeDrag
        if (!drag || e.pointerId !== drag.pointerId) return
        this._nativeDrag = null
        this.scrollArea.releasePointerCapture?.(e.pointerId)
        const selection = await this._finalizeNativeSelection(drag.anchor, drag.focus, 'char').catch(err => {
            console.warn('[PDF] native selection failed:', err); return null
        })
        if (selection) this._emitNativeSelection(selection)
    }

    _cancelNativeDrag() {
        this._nativeDrag = null
        this._nativePreview = null
        this._redrawNativePreview()
    }

    async _nativeDoubleClick(e) {
        if (this.driver?.kind !== 'mupdf') return
        const hit = this._slotForPoint(e.clientX, e.clientY)
        if (!hit) return
        const point = this._clientToPage(hit, e.clientX, e.clientY)
        const ch = await this._hitNativeChar(hit.page, point)
        if (!ch) return
        e.preventDefault()
        const selection = await this._finalizeNativeSelection(
            { page:hit.page,index:ch.index,point }, { page:hit.page,index:ch.index,point }, 'word')
        if (selection) this._emitNativeSelection(selection)
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
            const aChar = geom.chars[clamp(startIndex,0,geom.chars.length-1)]
            const bChar = geom.chars[clamp(endIndex,0,geom.chars.length-1)]
            const center = ch => [(ch.bounds[0]+ch.bounds[2])/2,(ch.bounds[1]+ch.bounds[3])/2]
            segments.push({ page, a:center(aChar), b:center(bChar), startIndex, endIndex })
        }
        return { forward, segments }
    }

    async _finalizeNativeSelection(anchor, focus, mode) {
        const { segments } = await this._selectionEndpoints(anchor, focus)
        if (!segments.length) return null
        const output = []
        for (const seg of segments) {
            const result = await this.driver.select(seg.page, seg.a, seg.b, mode)
            const size = this.pageSizes[seg.page]
            const pageBounds = [size.x0 || 0, size.y0 || 0, (size.x0 || 0)+size.width, (size.y0 || 0)+size.height]
            const rects = (result.quads || []).map(q => this._quadToNormalizedRect(q, pageBounds))
            output.push({ page:seg.page, text:result.text || '', quads:result.quads || [], rects, pageBounds })
        }
        return { text:output.map(x=>x.text).filter(Boolean).join('\n'), segments:output }
    }

    async _updateNativePreview() {
        const drag = this._nativeDrag
        if (!drag) return
        try {
            const { segments } = await this._selectionEndpoints(drag.anchor, drag.focus)
            if (this._nativeDrag !== drag) return
            const preview = await Promise.all(segments.map(async seg => {
                const geom = await this._ensureNativeGeometry(seg.page)
                if (!geom) return null
                const a = Math.min(seg.startIndex, seg.endIndex), b = Math.max(seg.startIndex, seg.endIndex)
                return { page:seg.page, quads:geom.chars.slice(a,b+1).map(ch=>ch.quad) }
            }))
            if (this._nativeDrag !== drag) return
            this._nativePreview = preview.filter(Boolean)
            this._redrawNativePreview()
        } catch (err) {
            if (this._nativeDrag === drag) console.warn('[PDF] native selection preview failed:', err)
        }
    }

    _redrawNativePreview() {
        for (const [page, slot] of this.activeSlots) this._renderNativePreviewForPage(page, slot.querySelector('.pdf-native-selection-layer'))
    }

    _renderNativePreviewForPage(page, layer) {
        if (!layer) return
        layer.replaceChildren()
        const segment = this._nativePreview?.find(x => x.page === page)
        if (!segment?.quads?.length) return
        const size = this.pageSizes[page]
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

    setZoom(value) {
        let next = this.scale
        if (typeof value === 'number') next = clamp(value, this.options.minScale, this.options.maxScale)
        else if (value === 'fit-width') next = (this.container.clientWidth - 48) / (this.pageSizes[this.currentPage]?.width || 595)
        else if (value === 'fit-page') next = (this.container.clientHeight - 64) / (this.pageSizes[this.currentPage]?.height || 842)
        next = clamp(next, this.options.minScale, this.options.maxScale)
        if (Math.abs(next - this.scale) < .01) return
        const old = this.pageOffsets[this.currentPage], ratio = old?.height ? (this.scrollArea.scrollTop-old.top)/old.height : 0
        this.scale = next
        this._recomputeLayout()
        const now = this.pageOffsets[this.currentPage]
        if (now) this.scrollArea.scrollTop = Math.max(0, now.top + clamp(ratio,0,1)*now.height)
        this._syncActiveSlotGeometry()
        for (const slot of this.activeSlots.values()) {
            slot._renderedClip = null
        }
        this._renderVisibleSlots(true)
        this._redrawNativePreview()
    }

    goToPage(page, yRatio = 0) {
        if (page < 0 || page >= this.pageOffsets.length) return
        const p = this.pageOffsets[page]
        this.scrollArea.scrollTop = Math.max(0, p.top + p.height * clamp(yRatio,0,1) - (yRatio ? this.scrollArea.clientHeight/3 : 8))
        this.currentPage = page
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
        const top=this.scrollArea.scrollTop,bottom=top+this.scrollArea.clientHeight
        let best=this.currentPage,bestH=-1
        for(let i=this._firstPageAt(top);i<this.pageOffsets.length;i++){
            const p=this.pageOffsets[i]; if(p.top>bottom)break
            const h=Math.max(0,Math.min(bottom,p.top+p.height)-Math.max(top,p.top))
            if(h>bestH){bestH=h;best=i}
        }
        if(best!==this.currentPage){this.currentPage=best;this.options.onPageChange?.(best,this.numPages)}
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

    destroy() {
        if (this._destroyed) return
        this._destroyed = true
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
        for (const slot of this.activeSlots.values()) slot.renderAbort?.abort()
        this.activeSlots.clear()
        this.highlightsByPage.clear()
        this._bitmapCache.clear()
        this._bitmapCacheBytes = 0
        this._nativeGeometry.clear()
        this._nativeGeometryUse.clear()
        this.driver?.destroy?.()
        this.driver = null
        this.container.innerHTML = ''
    }
}
