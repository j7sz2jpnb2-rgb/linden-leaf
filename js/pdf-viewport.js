// Independent PDF viewport shared by PDF.js and native MuPDF.
// Rendering is virtualized/cancellable; PDF.js owns its TextLayer, while
// MuPDF selection is based on engine character geometry in page coordinates.

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
            onPageChange: null,
            onSelection: null,
            onHighlightCreate: null,
            onHighlightClick: null,
        }, options)

        this.scale = this.options.scale
        this.driver = null
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
        this._renderQueue = []
        this._activeRenders = 0
        this._renderConcurrency = 2
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

    async load(engineDriver, source) {
        this.driver = engineDriver
        const info = await this.driver.open(source)
        this.numPages = info.numPages || 1
        this.pageSizes = info.pageSizes?.length
            ? info.pageSizes.map(x => ({ x0: 0, y0: 0, ...x }))
            : Array.from({ length: this.numPages }, () => ({ x0: 0, y0: 0, width: 595, height: 842 }))
        this._renderConcurrency = this.driver.kind === 'mupdf' ? 1 : 2
        this._recomputeLayout()
        this._renderVisibleSlots(true)
        this._geometryAbort = new AbortController()
        this._refineGeometry(this._geometryAbort.signal).catch(err => {
            if (!this._geometryAbort?.signal.aborted) console.warn('[PDF] background page geometry failed:', err)
        })
        return { numPages: this.numPages, title: info.title || 'PDF 文档', author: info.author || '未知作者', toc: info.toc || [] }
    }

    async _refineGeometry(signal) {
        if (!this.driver?.getPageSizes || this.numPages <= 1) return
        const batch = this.driver.kind === 'mupdf' ? 64 : 12
        for (let start = 0; start < this.numPages; start += batch) {
            if (signal.aborted || this._destroyed) return
            const values = await this.driver.getPageSizes(start, Math.min(batch, this.numPages - start), signal)
            if (!values?.length) continue

            const anchorPage = clamp(this.currentPage, 0, this.pageOffsets.length - 1)
            const old = this.pageOffsets[anchorPage]
            const ratio = old?.height ? clamp((this.scrollArea.scrollTop - old.top) / old.height, 0, 1) : 0
            const changedActive = []
            values.forEach((size, j) => {
                const i = start + j
                if (!this.pageSizes[i]) return
                const prev = this.pageSizes[i]
                const next = { ...prev, ...size }
                if (Math.abs(prev.width - next.width) > .01 || Math.abs(prev.height - next.height) > .01 || prev.x0 !== next.x0 || prev.y0 !== next.y0) {
                    this.pageSizes[i] = next
                    if (this.activeSlots.has(i)) changedActive.push(i)
                }
            })
            this._recomputeLayout()
            const now = this.pageOffsets[anchorPage]
            if (now) this.scrollArea.scrollTop = Math.max(0, now.top + now.height * ratio)
            this._syncActiveSlotGeometry()
            for (const page of changedActive) this._remountPage(page)
            await sleepFrame()
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

    _renderVisibleSlots(force = false) {
        if (!this.pageOffsets.length) return
        const top = this.scrollArea.scrollTop, bottom = top + this.scrollArea.clientHeight
        const first = this._firstPageAt(top)
        let last = first
        for (let i = first; i < this.pageOffsets.length && this.pageOffsets[i].top <= bottom; i++) last = i
        const start = Math.max(0, first - this.options.bufferPages)
        const end = Math.min(this.pageOffsets.length - 1, last + this.options.bufferPages)
        const needed = new Set()
        for (let i = start; i <= end; i++) needed.add(i)

        for (const [page, slot] of [...this.activeSlots]) {
            if (force || !needed.has(page)) this._unmountSlot(page, slot)
        }
        for (let i = start; i <= end; i++) if (!this.activeSlots.has(i)) this._mountSlot(i)
    }

    _unmountSlot(page, slot) {
        slot.renderAbort?.abort()
        slot.remove()
        this.activeSlots.delete(page)
    }

    _remountPage(page) {
        const slot = this.activeSlots.get(page)
        if (!slot) return
        this._unmountSlot(page, slot)
        this._mountSlot(page)
    }

    _mountSlot(page) {
        const layout = this.pageOffsets[page]
        if (!layout) return
        const slot = document.createElement('div')
        slot.className = 'pdf-page-slot'
        slot.dataset.page = String(page)
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

        if (this.driver?.kind === 'mupdf') this._ensureNativeGeometry(page).catch(() => {})
        this._scheduleRender(page, slot)
    }

    _scheduleRender(page, slot) {
        const item = {
            page, slot,
            signal: slot.renderAbort.signal,
            priority: () => Math.abs(page - this.currentPage),
        }
        this._renderQueue.push(item)
        this._pumpRenderQueue()
    }

    _pumpRenderQueue() {
        if (this._destroyed) return
        this._renderQueue = this._renderQueue.filter(x => !x.signal.aborted && this.activeSlots.get(x.page) === x.slot)
        this._renderQueue.sort((a, b) => a.priority() - b.priority())
        while (this._activeRenders < this._renderConcurrency && this._renderQueue.length) {
            const item = this._renderQueue.shift()
            if (item.signal.aborted) continue
            this._activeRenders++
            this._renderPageContent(item.page, item.slot).finally(() => {
                this._activeRenders--
                this._pumpRenderQueue()
            })
        }
    }

    _renderScale(page) {
        const size = this.pageSizes[page] || { width: 595, height: 842 }
        let scale = this.scale * Math.min(window.devicePixelRatio || 1, 2)
        let w = size.width * scale, h = size.height * scale
        const edgeFactor = Math.min(1, this.options.maxCanvasEdge / Math.max(w, h))
        const pixelFactor = Math.min(1, Math.sqrt(this.options.maxCanvasPixels / Math.max(1, w * h)))
        scale *= Math.min(edgeFactor, pixelFactor)
        return Math.max(.25, scale)
    }

    async _renderPageContent(page, slot) {
        if (!this.driver || slot.renderAbort.signal.aborted) return
        const pixels = slot.querySelector('.pdf-img-wrapper')
        const text = slot.querySelector('.pdf-text-layer')
        const isCurrent = () => this.activeSlots.get(page) === slot && !slot.renderAbort.signal.aborted
        try {
            const canvas = await this.driver.renderPage(page, this._renderScale(page), slot.renderAbort.signal)
            if (!isCurrent()) return
            canvas.classList.add('pdf-page-canvas')
            pixels.replaceChildren(canvas)

            if (this.driver.kind === 'pdfjs' && this.driver.renderTextLayer) {
                await this.driver.renderTextLayer(page, text, this.scale, slot.renderAbort.signal)
            }
        } catch (err) {
            if (slot.renderAbort.signal.aborted || err?.name === 'AbortError') return
            console.warn(`[PdfViewport] render failed page=${page} backend=${this.driver?.kind}:`, err)
            if (isCurrent()) {
                const box = document.createElement('div')
                box.className = 'pdf-render-error'
                box.textContent = `第 ${page + 1} 页渲染失败。滚动离开后返回将自动重试。`
                pixels.replaceChildren(box)
            }
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

    setHighlights(highlights) {
        this.highlights = highlights || []
        this.highlightsByPage.clear()
        for (const hl of this.highlights) {
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
        this._destroyed = true
        this._geometryAbort?.abort()
        this._renderQueue.length = 0
        for (const slot of this.activeSlots.values()) slot.renderAbort?.abort()
        this.activeSlots.clear()
        this.highlightsByPage.clear()
        this._nativeGeometry.clear()
        this._nativeGeometryUse.clear()
        this.driver?.destroy?.()
        this.driver = null
        this.container.innerHTML = ''
    }
}
