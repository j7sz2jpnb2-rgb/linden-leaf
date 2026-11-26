import { DomEvents } from './dom-events.js'
import * as db from './db.js'
import { t } from './i18n.js'

export class PdfDrawingMutationQueue {
    constructor() {
        this._queues = new Map()
    }
    enqueue(bookId, pageIndex, task) {
        const key = `${bookId}:${pageIndex}`
        const prev = this._queues.get(key) || Promise.resolve()
        const next = prev.then(() => task(), () => task())
        this._queues.set(key, next)
        const cleanup = () => {
            if (this._queues.get(key) === next) {
                this._queues.delete(key)
            }
        }
        next.then(cleanup, cleanup)
        return next
    }
    waitForPage(bookId, pageIndex) {
        return this._queues.get(`${bookId}:${pageIndex}`) || Promise.resolve()
    }
    async drainAll(timeoutMs = 5000) {
        const promises = Array.from(this._queues.values())
        if (promises.length === 0) return
        const drainPromise = Promise.allSettled(promises)
        if (!timeoutMs || timeoutMs <= 0) {
            await drainPromise
            return
        }
        let timer = null
        const timeoutPromise = new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs)
        })
        await Promise.race([drainPromise, timeoutPromise])
        if (timer) clearTimeout(timer)
    }
}

/** Owns drawing UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class PdfDrawingController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this.pdfDrawTool = null
        this.pdfDrawColor = 'rgba(250, 204, 21, 0.45)'
        this.pdfDrawWidth = 18
        this._pdfMutationQueue = new PdfDrawingMutationQueue()
        this._inFlightDrawingLoads = new Map()
        this._pdfPageStrokesCache = new Map()
        this._drawingPageGenerations = new Map()
        this._sessionGeneration = 0
    }

    initDOM() {
        this.dom = {
            btnPdfMarkerYellow: document.getElementById('btn-pdf-marker-yellow'),
            btnPdfMarkerGreen: document.getElementById('btn-pdf-marker-green'),
            btnPdfPenRed: document.getElementById('btn-pdf-pen-red'),
            btnPdfEraser: document.getElementById('btn-pdf-eraser'),
            btnPdfClearDraw: document.getElementById('btn-pdf-clear-draw')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        const pdfToolBtns = [
            this.dom.btnPdfMarkerYellow,
            this.dom.btnPdfMarkerGreen,
            this.dom.btnPdfPenRed,
            this.dom.btnPdfEraser
        ];
        pdfToolBtns.forEach(btn => {
            this.events.on(btn, 'click', () => {
                const tool = btn.dataset.tool
                const color = btn.dataset.color || '#ef4444'
                if (this.pdfDrawTool === tool && (tool === 'eraser' || this.pdfDrawColor === color)) {
                    // Toggle off
                    this.pdfDrawTool = null
                    pdfToolBtns.forEach(b => b?.classList.remove('active'))
                    this.setPdfOverlayDrawingActive(false)
                    this.app.pdfViewport?.setInteractionMode('select')
                    this.app.dialogs.showToast(t('pdfInk.exited'), 'info')
                } else {
                    // Activate tool
                    this.pdfDrawTool = tool
                    this.pdfDrawColor = color
                    const configuredPenWidth = Number(this.app.advancedSettings?.config?.pdfPenWidth) || 2.5
                    this.pdfDrawWidth = tool === 'marker' ? 18 : (tool === 'pen' ? configuredPenWidth : 26)
                    pdfToolBtns.forEach(b => b?.classList.remove('active'))
                    btn.classList.add('active')
                    this.app.annotations.hideSelectionPopup()
                    this.app.annotations.hideHighlightActionPopup()
                    this.app.pdfViewport?.setInteractionMode('draw')
                    this.renderPdfDrawingOverlayForCurrentPage().then(() => this.setPdfOverlayDrawingActive(Boolean(this.pdfDrawTool))).catch(error => console.warn('[PDF] Drawing tool:', error))
                    const toolName = tool === 'marker' ? t('pdfInk.toolMarker') : (tool === 'pen' ? t('pdfInk.toolPen') : t('pdfInk.toolEraser'))
                    this.app.dialogs.showToast(t('pdfInk.enabledTool', { tool: toolName }), 'info')
                }
            })
        });
        this.events.on(this.dom.btnPdfClearDraw, 'click', async () => {
            if (!this.app.currentBookId) return
            const activeSession = this.app._activeSession
            const snapshot = this.app._currentSnapshot || {}
            const allTargets = this.getAllPdfActiveDocsAndTargets()
            const isTwoPage = allTargets.length >= 2
            const targetPageIndices = allTargets.length > 0
                ? [...new Set(allTargets.map(t => t.index != null ? t.index : this.app.currentPdfPageIndex).filter(idx => idx != null))]
                : (this.app.currentPdfPageIndex != null ? [this.app.currentPdfPageIndex] : [])
            const bookId = this.app.currentBookId
            const now = Date.now()
            for (const pIdx of targetPageIndices) {
                this._clearPdfPageStrokesCache(bookId, pIdx)
                const prefix = `${bookId}:${pIdx}`
                const clearGen = this._drawingPageGenerations?.get(prefix) || 0
                this._clearPageOverlayCanvases(pIdx)
                this._enqueuePdfDrawingMutation(bookId, pIdx, snapshot, async () => {
                    await db.clearPdfPageDrawing(bookId, pIdx, true, now, snapshot)
                    if (this.app.currentBookId === bookId &&
                        (this._drawingPageGenerations?.get(prefix) || 0) === clearGen) {
                        const key = this._getPdfDrawingCacheKey(bookId, pIdx, snapshot)
                        if (!this._pdfPageStrokesCache.has(key)) {
                            this._pdfPageStrokesCache.set(key, [])
                        }
                        if (this.app.currentPdfPageIndex === pIdx) {
                            this._currentPdfPageStrokes = this._pdfPageStrokesCache.get(key)
                        }
                    }
                }).catch(err => console.warn('[PdfDrawing] Clear mutation error:', err))
            }
            if (activeSession && !activeSession.isCurrent()) return
            this.app.dialogs.showToast(isTwoPage ? t('pdfInk.clearedSpread') : t('pdfInk.clearedPage'), 'delete')
        });
    }

    flushPendingWrites(timeoutMs = 5000) { return this._pdfMutationQueue.drainAll(timeoutMs) }

    resetSessionState() {
        this._sessionGeneration++
        this.pdfDrawTool = null
        this._currentPdfPageStrokes = null
        this._pdfPageStrokesCache.clear()
        this._drawingPageGenerations.clear()
        this._inFlightDrawingLoads.clear()
        this.setPdfOverlayDrawingActive(false)
        this.app.pdfViewport?.setInteractionMode('select')
        for (const button of [this.dom.btnPdfMarkerYellow, this.dom.btnPdfMarkerGreen, this.dom.btnPdfPenRed, this.dom.btnPdfEraser]) {
            button?.classList.remove('active')
        }
        // Submitted mutations retain their captured book/snapshot and must still finish.
        this.flushPendingWrites(3000).catch(() => {})
    }

    dispose() { this.resetSessionState(); this.events.dispose(); this._bound = false }

    getAllPdfActiveDocsAndTargets() {
        const results = []
        if (this.app.pdfViewport?.activeSlots) {
            const vp = this.app.pdfViewport
            const scrollArea = vp.scrollArea
            const top = scrollArea ? scrollArea.scrollTop : 0
            const bottom = scrollArea ? top + scrollArea.clientHeight : 0
            const visiblePages = []
            if (scrollArea && vp.pageOffsets && vp.pageOffsets.length > 0) {
                for (const [pageIdx, slot] of vp.activeSlots.entries()) {
                    const p = vp.pageOffsets[pageIdx]
                    if (!p) continue
                    // Page is truly visible if it has substantial visible height (> 20px) in scrollArea
                    const visibleH = Math.max(0, Math.min(bottom, p.top + p.height) - Math.max(top, p.top))
                    if (visibleH > 20) {
                        visiblePages.push({ pageIdx, slot })
                    }
                }
            }
            if (visiblePages.length === 0) {
                const curPage = vp.currentPage != null ? vp.currentPage : this.app.currentPdfPageIndex
                if (curPage != null && vp.activeSlots.has(curPage)) {
                    visiblePages.push({ pageIdx: curPage, slot: vp.activeSlots.get(curPage) })
                }
            }
            visiblePages.sort((a, b) => a.pageIdx - b.pageIdx)
            for (const { pageIdx, slot } of visiblePages) {
                const canvas = slot.querySelector('.pdf-page-canvas, .pdf-page-preview')
                const img = slot.querySelector('img')
                const svg = slot.querySelector('svg')
                results.push({
                    iframe: null,
                    doc: document,
                    canvas,
                    img,
                    svg,
                    container: slot,
                    index: pageIdx
                })
            }
            if (results.length > 0) return results
        }

        return results
    }

    getPdfActiveDocAndTarget() {
        if (this.app.pdfViewport) {
            const curPage = this.app.pdfViewport.currentPage ?? 0
            const slot = this.app.pdfViewport.activeSlots?.get(curPage)
            if (slot) {
                return {
                    iframe: null,
                    doc: document,
                    canvas: slot.querySelector('canvas:not(.pdf-draw-overlay-canvas)'),
                    img: slot.querySelector('img'),
                    svg: slot.querySelector('svg'),
                    container: slot,
                    index: curPage
                }
            }
        }
        const list = this.getAllPdfActiveDocsAndTargets()
        return list[0] || null
    }

    _getPdfDrawingCacheKey(bookId, pageIdx, snapshot = null) {
        const snap = snapshot || this.app._currentSnapshot || {}
        const rev = snap.blobRevision || ''
        const origin = snap.revisionOrigin || ''
        return `${bookId}:${pageIdx}:${rev}:${origin}`
    }

    _getOrInitPageStrokes(bookId, pageIdx, snapshot = null) {
        if (!bookId || pageIdx == null) return []
        const key = this._getPdfDrawingCacheKey(bookId, pageIdx, snapshot)
        if (!this._pdfPageStrokesCache.has(key)) {
            this._pdfPageStrokesCache.set(key, [])
        }
        return this._pdfPageStrokesCache.get(key)
    }

    _clearPdfPageStrokesCache(bookId, pageIdx) {
        if (!bookId || pageIdx == null) return
        const prefix = `${bookId}:${pageIdx}`
        if (this._drawingPageGenerations) {
            this._drawingPageGenerations.set(prefix, (this._drawingPageGenerations.get(prefix) || 0) + 1)
        }
        for (const k of Array.from(this._pdfPageStrokesCache.keys())) {
            if (k === prefix || k.startsWith(`${prefix}:`)) {
                this._pdfPageStrokesCache.delete(k)
            }
        }
    }

    _enqueuePdfDrawingMutation(bookId, pageIdx, snapshot, task) {
        if (!this._pdfMutationQueue) this._pdfMutationQueue = new PdfDrawingMutationQueue()
        return this._pdfMutationQueue.enqueue(bookId, pageIdx, task)
    }

    _clearPageOverlayCanvases(pageIdx) {
        if (this.app.pdfViewport) {
            const slot = this.app.pdfViewport.activeSlots?.get(pageIdx)
            if (slot) {
                const baseCanvas = slot.querySelector('.pdf-draw-base-canvas, .pdf-draw-overlay-canvas')
                const activeCanvas = slot.querySelector('.pdf-draw-active-canvas')
                if (baseCanvas) {
                    const ctx = baseCanvas.getContext('2d')
                    ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
                }
                if (activeCanvas) {
                    const ctx = activeCanvas.getContext('2d')
                    ctx.clearRect(0, 0, activeCanvas.width, activeCanvas.height)
                }
            }
            return
        }
        const activeObj = this.getPdfActiveDocAndTarget()
        if (activeObj?.container) {
            const canvases = activeObj.container.querySelectorAll('.pdf-draw-overlay-canvas, .pdf-draw-base-canvas, .pdf-draw-active-canvas')
            canvases.forEach(c => {
                const ctx = c.getContext('2d')
                ctx.clearRect(0, 0, c.width, c.height)
            })
        }
    }

    setPdfOverlayDrawingActive(isActive) {
        for (const slot of this.app.pdfViewport?.activeSlots.values() || []) {
            const canvas = slot.querySelector('.pdf-draw-active-canvas')
            if (!canvas) continue
            canvas.classList.toggle('is-drawing-active', Boolean(isActive))
            canvas.style.pointerEvents = isActive ? 'auto' : 'none'
            canvas.style.cursor = isActive ? 'crosshair' : 'default'
        }
    }

    async renderStrokesForPage(pageIdx, baseCanvas, readerSession) {
        const strokes = await this.loadPdfPageStrokes(pageIdx, readerSession)
        if (!baseCanvas || !strokes || (readerSession && !readerSession.isCurrent())) return
        const ctx = baseCanvas.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
        strokes.forEach(stroke => this.drawSingleStrokeOnCanvas(ctx, stroke, baseCanvas.width, baseCanvas.height))
    }

    async loadPdfPageStrokes(pageIdx, readerSession) {
        if (!this.app.currentBookId) return
        const bookId = this.app.currentBookId
        const snapshot = this.app._currentSnapshot || {}
        const session = readerSession || this.app._activeSession
        const key = this._getPdfDrawingCacheKey(bookId, pageIdx, snapshot)
        const prefix = `${bookId}:${pageIdx}`
        const startGen = this._drawingPageGenerations.get(prefix) || 0
        const sessionGeneration = this._sessionGeneration

        let strokes
        if (this._pdfPageStrokesCache.has(key)) {
            strokes = this._pdfPageStrokesCache.get(key)
        } else {
            await this._pdfMutationQueue?.waitForPage?.(bookId, pageIdx)
            if (sessionGeneration !== this._sessionGeneration) return
            if (session && !session.isCurrent()) return
            if (this.app.currentBookId !== bookId) return
            if ((this._drawingPageGenerations?.get(prefix) || 0) !== startGen) return

            if (this._pdfPageStrokesCache.has(key)) {
                strokes = this._pdfPageStrokesCache.get(key)
            } else {
                if (!this._inFlightDrawingLoads) this._inFlightDrawingLoads = new Map()
                let loadPromise = this._inFlightDrawingLoads.get(key)
                if (!loadPromise) {
                    loadPromise = db.getPdfPageDrawing(bookId, pageIdx, snapshot).finally(() => {
                        if (this._inFlightDrawingLoads.get(key) === loadPromise) this._inFlightDrawingLoads.delete(key)
                    })
                    this._inFlightDrawingLoads.set(key, loadPromise)
                }
                const drawingRecord = await loadPromise
                if (sessionGeneration !== this._sessionGeneration) return
                if (session && !session.isCurrent()) return
                if (this.app.currentBookId !== bookId) return

                const curGen = this._drawingPageGenerations?.get(prefix) || 0
                if (curGen !== startGen) {
                    return
                }

                if (this._pdfPageStrokesCache.has(key)) {
                    const currentCache = this._pdfPageStrokesCache.get(key) || []
                    const diskStrokes = drawingRecord?.strokes || []
                    const existingKeys = new Set(currentCache.map(s => s.id || JSON.stringify(s.points?.[0])))
                    const missing = []
                    for (const ds of diskStrokes) {
                        const dKey = ds.id || JSON.stringify(ds.points?.[0])
                        if (!existingKeys.has(dKey)) {
                            missing.push(ds)
                        }
                    }
                    if (missing.length) currentCache.unshift(...missing)
                    strokes = currentCache
                } else {
                    strokes = drawingRecord?.strokes || []
                    this._pdfPageStrokesCache.set(key, strokes)
                }
            }
        }

        if (this.app.currentBookId !== bookId) return
        if (pageIdx === this.app.currentPdfPageIndex) {
            this._currentPdfPageStrokes = strokes
        }

        return strokes
    }

    async mountPdfOverlayForSlot(pageIdx, slot, readerSession) {
        if (!slot || pageIdx == null) return

        let overlayWrapper = slot.querySelector('.pdf-draw-overlay-wrapper')
        if (!overlayWrapper && !this.pdfDrawTool) {
            const strokes = await this.loadPdfPageStrokes(pageIdx, readerSession)
            if (!strokes?.length || !readerSession?.isCurrent() || this.app.pdfViewport?.activeSlots.get(pageIdx) !== slot) return
        }
        if (!overlayWrapper) {
            overlayWrapper = document.createElement('div')
            overlayWrapper.className = 'pdf-draw-overlay-wrapper'
            overlayWrapper.dataset.pageIndex = String(pageIdx)
            const metrics = this.app.pdfViewport?._getPageBoxMetrics?.(pageIdx)
            Object.assign(overlayWrapper.style, {
                position: 'absolute',
                top: '0px',
                left: '0px',
                width: metrics ? `${metrics.uncroppedWidth}px` : '100%',
                height: metrics ? `${metrics.uncroppedHeight}px` : '100%',
                transform: (metrics && (metrics.contentOffsetX !== 0 || metrics.contentOffsetY !== 0))
                    ? `translate(${metrics.contentOffsetX}px, ${metrics.contentOffsetY}px)`
                    : '',
                transformOrigin: '0 0',
                zIndex: '50',
                pointerEvents: 'none'
            })
            slot.append(overlayWrapper)
        }

        let baseCanvas = overlayWrapper.querySelector('.pdf-draw-base-canvas')
        if (!baseCanvas) {
            baseCanvas = document.createElement('canvas')
            baseCanvas.className = 'pdf-draw-base-canvas pdf-draw-overlay-canvas'
            baseCanvas.dataset.pageIndex = String(pageIdx)
            Object.assign(baseCanvas.style, {
                position: 'absolute',
                top: '0px',
                left: '0px',
                width: '100%',
                height: '100%',
                zIndex: '1',
                pointerEvents: 'none'
            })
            overlayWrapper.append(baseCanvas)
        }

        let activeCanvas = overlayWrapper.querySelector('.pdf-draw-active-canvas')
        if (!activeCanvas) {
            activeCanvas = document.createElement('canvas')
            activeCanvas.className = 'pdf-draw-active-canvas'
            activeCanvas.dataset.pageIndex = String(pageIdx)
            Object.assign(activeCanvas.style, {
                position: 'absolute',
                top: '0px',
                left: '0px',
                width: '100%',
                height: '100%',
                zIndex: '2',
                touchAction: 'none'
            })
            overlayWrapper.append(activeCanvas)
            this.attachPdfDrawingPointerEvents(activeCanvas, baseCanvas, pageIdx, slot, readerSession)
        }

        if (this.pdfDrawTool) {
            activeCanvas.classList.add('is-drawing-active')
            activeCanvas.style.pointerEvents = 'auto'
            activeCanvas.style.cursor = 'crosshair'
        } else {
            activeCanvas.classList.remove('is-drawing-active')
            activeCanvas.style.pointerEvents = 'none'
            activeCanvas.style.cursor = 'default'
        }

        const resized = this.syncPdfOverlayGeometryForSlot(pageIdx, slot)
        if (!resized) await this.renderStrokesForPage(pageIdx, baseCanvas, readerSession)
    }

    unmountPdfOverlayForSlot(pageIdx, slot) {
        if (!slot) return
        if (typeof slot._pdfOverlayCleanup === 'function') {
            slot._pdfOverlayCleanup()
            delete slot._pdfOverlayCleanup
        }
    }

    syncPdfOverlayGeometryForSlot(pageIdx, slot) {
        if (!slot) return
        const overlayWrapper = slot.querySelector('.pdf-draw-overlay-wrapper')
        if (!overlayWrapper) return

        const baseCanvas = overlayWrapper.querySelector('.pdf-draw-base-canvas')
        const activeCanvas = overlayWrapper.querySelector('.pdf-draw-active-canvas')
        if (!baseCanvas || !activeCanvas) return

        const metrics = this.app.pdfViewport?._getPageBoxMetrics?.(pageIdx)
        const p = this.app.pdfViewport?.pageOffsets?.[pageIdx]
        const cssW = metrics?.uncroppedWidth || p?.width || slot.offsetWidth || 800
        const cssH = metrics?.uncroppedHeight || p?.height || slot.offsetHeight || 1100
        overlayWrapper.style.width = `${cssW}px`
        overlayWrapper.style.height = `${cssH}px`
        overlayWrapper.style.transform = (metrics && (metrics.contentOffsetX !== 0 || metrics.contentOffsetY !== 0))
            ? `translate(${metrics.contentOffsetX}px, ${metrics.contentOffsetY}px)`
            : ''
        overlayWrapper.style.transformOrigin = '0 0'
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        let backingW = Math.max(1, Math.round(cssW * dpr))
        let backingH = Math.max(1, Math.round(cssH * dpr))

        const MAX_DIM = 4096
        const MAX_PIXELS = 16 * 1024 * 1024
        if (backingW > MAX_DIM || backingH > MAX_DIM || (backingW * backingH) > MAX_PIXELS) {
            const scale = Math.min(
                MAX_DIM / backingW,
                MAX_DIM / backingH,
                Math.sqrt(MAX_PIXELS / (backingW * backingH))
            )
            backingW = Math.max(1, Math.round(backingW * scale))
            backingH = Math.max(1, Math.round(backingH * scale))
        }

        let resized = false
        if (baseCanvas.width !== backingW || baseCanvas.height !== backingH) {
            baseCanvas.width = backingW
            baseCanvas.height = backingH
            resized = true
        }
        if (activeCanvas.width !== backingW || activeCanvas.height !== backingH) {
            activeCanvas.width = backingW
            activeCanvas.height = backingH
        }

        if (resized) {
            this.renderStrokesForPage(pageIdx, baseCanvas, this.app._activeSession)
        }
        return resized
    }

    syncAllPdfOverlays() {
        if (this.app.pdfViewport) {
            for (const [pageIdx, slot] of this.app.pdfViewport.activeSlots.entries()) {
                this.syncPdfOverlayGeometryForSlot(pageIdx, slot)
            }
        }
    }

    async renderPdfDrawingOverlayForCurrentPage() {
        if (!this.app.pdfViewport) return
        await Promise.all([...this.app.pdfViewport.activeSlots].map(([page, slot]) =>
            this.mountPdfOverlayForSlot(page, slot, this.app._activeSession)))
    }

    async redrawPdfPageOverlay() {
        if (this.app.pdfViewport) {
            for (const [pageIdx, slot] of this.app.pdfViewport.activeSlots.entries()) {
                const baseCanvas = slot.querySelector('.pdf-draw-base-canvas, .pdf-draw-overlay-canvas')
                if (baseCanvas) {
                    this.renderStrokesForPage(pageIdx, baseCanvas, this.app._activeSession)
                }
            }
            return
        }

        const allTargets = this.getAllPdfActiveDocsAndTargets()
        if (allTargets.length === 0 || !this.app.currentBookId) return

        for (const activeObj of allTargets) {
            if (!activeObj?.doc) continue
            const overlayCanvas = activeObj.container?.querySelector?.('.pdf-draw-overlay-canvas') || 
                                  activeObj.doc.querySelector?.('.pdf-draw-overlay-canvas')
            if (!overlayCanvas) continue

            const targetPageIndex = overlayCanvas.dataset.pageIndex != null 
                ? parseInt(overlayCanvas.dataset.pageIndex, 10) 
                : (activeObj.index != null ? activeObj.index : this.app.currentPdfPageIndex)
            if (targetPageIndex == null) continue

            this.renderStrokesForPage(targetPageIndex, overlayCanvas, this.app._activeSession)
        }
    }

    drawSingleStrokeOnCanvas(ctx, stroke, w, h) {
        if (!stroke.points || stroke.points.length === 0) return
        ctx.save()
        if (stroke.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out'
            ctx.strokeStyle = 'rgba(0,0,0,1)'
            ctx.lineWidth = (stroke.width || 24) * (w / 800)
        } else if (stroke.tool === 'marker') {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || 'rgba(250, 204, 21, 0.45)'
            ctx.lineWidth = (stroke.width || 18) * (w / 800)
        } else {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || '#ef4444'
            ctx.lineWidth = (stroke.width || 3) * (w / 800)
        }
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        ctx.beginPath()
        const p0 = stroke.points[0]
        ctx.moveTo(p0[0] * w, p0[1] * h)

        const useSmoothing = stroke.smoothingMode
            ? (stroke.smoothingMode !== 'none')
            : (this.app.advancedSettings?.config?.pdfSmoothing !== false)
        if (stroke.points.length === 1) {
            ctx.lineTo(p0[0] * w + 0.5, p0[1] * h + 0.5)
        } else if (!useSmoothing || stroke.points.length < 3) {
            for (let i = 1; i < stroke.points.length; i++) {
                const pt = stroke.points[i]
                ctx.lineTo(pt[0] * w, pt[1] * h)
            }
        } else {
            let i = 1
            for (; i < stroke.points.length - 1; i++) {
                const xc = ((stroke.points[i][0] + stroke.points[i + 1][0]) / 2) * w
                const yc = ((stroke.points[i][1] + stroke.points[i + 1][1]) / 2) * h
                ctx.quadraticCurveTo(stroke.points[i][0] * w, stroke.points[i][1] * h, xc, yc)
            }
            const last = stroke.points[stroke.points.length - 1]
            ctx.lineTo(last[0] * w, last[1] * h)
        }
        ctx.stroke()
        ctx.restore()
    }

    drawStrokeSegment(ctx, stroke, p1, p2, w, h) {
        if (!p1 || !p2) return
        ctx.save()
        if (stroke.tool === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out'
            ctx.strokeStyle = 'rgba(0,0,0,1)'
            ctx.lineWidth = (stroke.width || 24) * (w / 800)
        } else if (stroke.tool === 'marker') {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || 'rgba(250, 204, 21, 0.45)'
            ctx.lineWidth = (stroke.width || 18) * (w / 800)
        } else {
            ctx.globalCompositeOperation = 'source-over'
            ctx.strokeStyle = stroke.color || '#ef4444'
            ctx.lineWidth = (stroke.width || 3) * (w / 800)
        }
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        ctx.moveTo(p1[0] * w, p1[1] * h)
        ctx.lineTo(p2[0] * w, p2[1] * h)
        ctx.stroke()
        ctx.restore()
    }

    attachPdfDrawingPointerEvents(activeCanvas, baseCanvas, pageIdx, slot, readerSession) {
        let activePointerId = null
        let isDrawing = false
        let currentStroke = null
        let strokeOwner = null
        let rafId = null
        let lastDrawnPointIndex = 0

        const getCoords = e => {
            const rect = activeCanvas.getBoundingClientRect()
            const w = rect.width || activeCanvas.width || 1
            const h = rect.height || activeCanvas.height || 1
            return [
                Math.max(0, Math.min(1, (e.clientX - rect.left) / w)),
                Math.max(0, Math.min(1, (e.clientY - rect.top) / h))
            ]
        }

        const cancelPendingRaf = () => {
            if (rafId != null) {
                cancelAnimationFrame(rafId)
                rafId = null
            }
        }

        const finishGesture = (commit = true) => {
            if (!isDrawing) return
            isDrawing = false
            cancelPendingRaf()
            lastDrawnPointIndex = 0

            if (activePointerId != null) {
                try {
                    activeCanvas.releasePointerCapture?.(activePointerId)
                } catch (_) {}
                activePointerId = null
            }

            const strokeToSave = currentStroke
            const owner = strokeOwner
            currentStroke = null
            strokeOwner = null
            const session = owner?.session || readerSession || this.app._activeSession
            const bookId = owner?.bookId || this.app.currentBookId
            const snapshot = owner?.snapshot || this.app._currentSnapshot || {}
            const isSameActiveSession = Boolean(bookId && (!session || session.isCurrent()) && this.app.currentBookId === bookId)

            if (commit && strokeToSave && strokeToSave.points.length > 0 && isSameActiveSession) {
                const strokes = this._getOrInitPageStrokes(bookId, pageIdx, snapshot)
                const isNoOpEraser = strokeToSave.tool === 'eraser' && strokes.every(s => !s || s.tool === 'eraser')
                if (!isNoOpEraser) {
                    strokes.push(strokeToSave)
                    this._enqueuePdfDrawingMutation(bookId, pageIdx, snapshot, async () => {
                        const drawingRecord = await db.getPdfPageDrawing(bookId, pageIdx, snapshot)
                        const existingStrokes = drawingRecord?.strokes || []
                        existingStrokes.push(strokeToSave)
                        await db.savePdfPageDrawing(bookId, pageIdx, existingStrokes, snapshot)
                        if (session && !session.isCurrent()) return
                        if (this.app.currentBookId === bookId && this.app.currentPdfPageIndex === pageIdx) {
                            this._currentPdfPageStrokes = existingStrokes
                        }
                    }).catch(err => console.warn('[PdfDrawing] Save mutation error:', err))
                }

                const baseCtx = baseCanvas.getContext('2d')
                baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
                strokes.forEach(s => {
                    this.drawSingleStrokeOnCanvas(baseCtx, s, baseCanvas.width, baseCanvas.height)
                })

                if (activeCanvas !== baseCanvas) {
                    const activeCtx = activeCanvas.getContext('2d')
                    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height)
                }
            } else {
                if (activeCanvas !== baseCanvas) {
                    const activeCtx = activeCanvas.getContext('2d')
                    activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height)
                }
                if (isSameActiveSession) {
                    const strokes = this._getOrInitPageStrokes(bookId, pageIdx, snapshot)
                    const baseCtx = baseCanvas.getContext('2d')
                    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
                    strokes.forEach(s => {
                        this.drawSingleStrokeOnCanvas(baseCtx, s, baseCanvas.width, baseCanvas.height)
                    })
                }
            }
        }

        const onPointerDown = e => {
            if (!this.pdfDrawTool || !this.app.currentBookId) return
            if (e.pointerType === 'mouse' && e.button !== 0) return
            if (activePointerId != null) return

            e.preventDefault()
            e.stopPropagation()

            activePointerId = e.pointerId
            try {
                activeCanvas.setPointerCapture?.(e.pointerId)
            } catch (_) {}

            lastDrawnPointIndex = 0
            isDrawing = true
            strokeOwner = {
                bookId: this.app.currentBookId,
                snapshot: this.app._currentSnapshot || {},
                session: readerSession || this.app._activeSession
            }
            const [nx, ny] = getCoords(e)
            currentStroke = {
                id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                tool: this.pdfDrawTool,
                color: this.pdfDrawColor,
                width: this.pdfDrawWidth,
                smoothingMode: (this.app.advancedSettings?.config?.pdfSmoothing === false) ? 'none' : 'bezier',
                points: [[nx, ny]]
            }

            if (currentStroke.tool === 'eraser') {
                const baseCtx = baseCanvas.getContext('2d')
                this.drawSingleStrokeOnCanvas(baseCtx, currentStroke, baseCanvas.width, baseCanvas.height)
            } else {
                const targetCanvas = (activeCanvas !== baseCanvas) ? activeCanvas : baseCanvas
                const ctx = targetCanvas.getContext('2d')
                if (activeCanvas !== baseCanvas) {
                    ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
                }
                this.drawSingleStrokeOnCanvas(ctx, currentStroke, targetCanvas.width, targetCanvas.height)
            }
        }

        const onPointerMove = e => {
            if (!isDrawing || e.pointerId !== activePointerId) return
            if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
                finishGesture(true)
                return
            }

            e.preventDefault()
            e.stopPropagation()

            const [nx, ny] = getCoords(e)
            const pts = currentStroke.points
            const last = pts[pts.length - 1]
            if (!last || Math.abs(nx - last[0]) > 0.0003 || Math.abs(ny - last[1]) > 0.0003) {
                pts.push([nx, ny])
            }

            if (rafId == null) {
                rafId = requestAnimationFrame(() => {
                    rafId = null
                    if (!isDrawing || !currentStroke) return
                    if (currentStroke.tool === 'eraser') {
                        const baseCtx = baseCanvas.getContext('2d')
                        baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height)
                        const strokes = this._getOrInitPageStrokes(this.app.currentBookId, pageIdx, this.app._currentSnapshot)
                        strokes.forEach(s => {
                            this.drawSingleStrokeOnCanvas(baseCtx, s, baseCanvas.width, baseCanvas.height)
                        })
                        this.drawSingleStrokeOnCanvas(baseCtx, currentStroke, baseCanvas.width, baseCanvas.height)
                    } else if (activeCanvas !== baseCanvas) {
                        const activeCtx = activeCanvas.getContext('2d')
                        activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height)
                        this.drawSingleStrokeOnCanvas(activeCtx, currentStroke, activeCanvas.width, activeCanvas.height)
                    } else {
                        const ctx = baseCanvas.getContext('2d')
                        const pts = currentStroke.points
                        while (lastDrawnPointIndex < pts.length - 1) {
                            const p1 = pts[lastDrawnPointIndex]
                            const p2 = pts[lastDrawnPointIndex + 1]
                            this.drawStrokeSegment(ctx, currentStroke, p1, p2, baseCanvas.width, baseCanvas.height)
                            lastDrawnPointIndex++
                        }
                    }
                })
            }
        }

        const onPointerUp = e => {
            if (e.pointerId !== activePointerId) return
            if (isDrawing && currentStroke) {
                const [nx, ny] = getCoords(e)
                const pts = currentStroke.points
                const last = pts[pts.length - 1]
                if (!last || Math.abs(nx - last[0]) > 0.0003 || Math.abs(ny - last[1]) > 0.0003) {
                    pts.push([nx, ny])
                }
            }
            finishGesture(true)
        }

        const onPointerCancel = e => {
            if (e.pointerId !== activePointerId) return
            finishGesture(false)
        }

        const onLostPointerCapture = e => {
            if (e.pointerId !== activePointerId) return
            finishGesture(true)
        }

        const onWindowBlur = () => {
            if (isDrawing) finishGesture(true)
        }

        activeCanvas.addEventListener('pointerdown', onPointerDown)
        activeCanvas.addEventListener('pointermove', onPointerMove)
        activeCanvas.addEventListener('pointerup', onPointerUp)
        activeCanvas.addEventListener('pointercancel', onPointerCancel)
        activeCanvas.addEventListener('lostpointercapture', onLostPointerCapture)
        window.addEventListener('blur', onWindowBlur)

        slot._pdfOverlayCleanup = () => {
            finishGesture(false)
            activeCanvas.removeEventListener('pointerdown', onPointerDown)
            activeCanvas.removeEventListener('pointermove', onPointerMove)
            activeCanvas.removeEventListener('pointerup', onPointerUp)
            activeCanvas.removeEventListener('pointercancel', onPointerCancel)
            activeCanvas.removeEventListener('lostpointercapture', onLostPointerCapture)
            window.removeEventListener('blur', onWindowBlur)
        }
    }
}
