// js/page-turn-controller.js - Unified Page Turn Controller for Linden Leaf
// Architecture:
// - Coordinates 5 distinct page turn modes:
//     1. 'none'       - Instant jump (e-ink / performance / reduced motion)
//     2. 'slide'      - Horizontal smooth sliding translation (recommended default)
//     3. 'cover'      - Overlapping sheet page flip with edge drop shadow
//     4. 'scroll'     - Continuous vertical/horizontal stream reading flow
// - State Machine: 'idle' -> 'preparing' -> 'dragging' -> 'settling' -> 'idle'
// - Generation Counter: Cancels stale textures/animations immediately on resize, font, theme, or book changes
// - Interaction Priority: Drawing tool, text selection, zoomed PDF panning strictly supersede page turns
// - Respects 'prefers-reduced-motion' automatically

export const FEATURE_CURL_PAGE_TURN_ENABLED = false
export const PAGE_TURN_MODES = ['none', 'slide', 'cover', 'scroll']
export const PAGE_TURN_STATES = ['idle', 'preparing', 'dragging', 'settling']

const safeRaf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)

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

/**
 * Base Adapter Contract for Reader Viewports
 */
export class PageTurnAdapter {
    canTurnPrev() { return true }
    canTurnNext() { return true }
    async turnPrev() {}
    async turnNext() {}
    isBusy() { return false }
    isContinuousScroll() { return false }
    getViewElement() { return null }
    getVisuals() { return null } // { currentCanvas, nextCanvas, bgColor }
}

/**
 * Accurately renders a text node's wrapped lines to canvas without column leakage or text overlapping
 */
function renderTextNodeToCanvas(doc, textNode, ctx, width, height, textColor, arg1 = 0, arg2 = 0, arg3 = null, arg4 = null) {
    let offsetX = 0
    let offsetY = 0
    let colMinX = 0
    let colMaxX = width

    if (arg3 != null && typeof arg2 === 'number') {
        // Called with (doc, textNode, ctx, width, height, textColor, colMinX, colMaxX, offsetY)
        colMinX = arg1
        colMaxX = arg2
        offsetY = arg3 || 0
        offsetX = -colMinX
    } else {
        // Called with (doc, textNode, ctx, width, height, textColor, offsetX, offsetY)
        offsetX = arg1 || 0
        offsetY = arg2 || 0
        colMinX = -offsetX
        colMaxX = -offsetX + width
    }

    const parent = textNode.parentElement
    if (!parent) return false
    const tagName = parent.tagName?.toLowerCase()
    if (tagName === 'script' || tagName === 'style' || tagName === 'noscript' || tagName === 'svg') return false
    if (parent.closest('script, style, noscript, svg, [hidden]')) return false

    const fullText = textNode.textContent
    if (!fullText || !fullText.trim()) return false

    const style = doc.defaultView?.getComputedStyle(parent)
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false

    const fontSize = parseFloat(style.fontSize) || 16
    const fontFamily = style.fontFamily || 'serif'
    const fontWeight = style.fontWeight || 'normal'
    const fontStyle = style.fontStyle || 'normal'
    const color = (style.color && style.color !== 'rgba(0, 0, 0, 0)' && style.color !== 'transparent') ? style.color : textColor

    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
    ctx.fillStyle = color
    ctx.textBaseline = 'top'

    const range = doc.createRange()
    range.selectNodeContents(textNode)
    const rects = range.getClientRects()
    if (!rects || rects.length === 0) return false

    // Quick rejection: check if any rect intersects this column slice [colMinX - 8, colMaxX + 8]
    let inCol = false
    for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r.right >= colMinX - 8 && r.left < colMaxX + 8) {
            inCol = true
            break
        }
    }
    if (!inCol) return false

    let renderedAny = false

    // Single rect: if within this column slice, draw directly
    if (rects.length === 1) {
        const r = rects[0]
        const x = r.left - colMinX
        const y = r.top + offsetY
        if (y + r.height >= 0 && y <= height && x + r.width >= 0 && x <= width && x >= -8) {
            const trimmed = fullText.trim()
            if (trimmed) {
                ctx.fillText(trimmed, x, y)
                return true
            }
        }
        return false
    }

    // Multiple characters/lines: Group characters strictly within [colMinX - 8, colMaxX - 8]
    try {
        const charRange = doc.createRange()
        let currentLine = ''
        let currentTop = -999
        let currentLeft = 0
        const lineHeight = parseFloat(style.lineHeight) || (fontSize * 1.4)

        for (let c = 0; c < fullText.length; c++) {
            charRange.setStart(textNode, c)
            charRange.setEnd(textNode, c + 1)
            const cr = charRange.getBoundingClientRect()
            if (!cr || cr.width === 0) {
                if (currentLine) currentLine += fullText[c]
                continue
            }

            // Check if this character is within this column's horizontal slice
            if (cr.left >= colMinX - 8 && cr.left < colMaxX - 8) {
                // If baseline moved vertically by more than half line height, emit line
                if (currentLine && Math.abs(cr.top - currentTop) > 6) {
                    const lineStr = currentLine.trim()
                    const x = currentLeft - colMinX
                    const y = currentTop + offsetY
                    if (lineStr && y + lineHeight >= 0 && y <= height && x + width >= 0 && x <= width && x >= -8) {
                        ctx.fillText(lineStr, x, y)
                        renderedAny = true
                    }
                    currentLine = ''
                }
                if (!currentLine) {
                    currentTop = cr.top
                    currentLeft = cr.left
                }
                currentLine += fullText[c]
            } else {
                if (currentLine) {
                    const lineStr = currentLine.trim()
                    const x = currentLeft - colMinX
                    const y = currentTop + offsetY
                    if (lineStr && y + lineHeight >= 0 && y <= height && x + width >= 0 && x <= width && x >= -8) {
                        ctx.fillText(lineStr, x, y)
                        renderedAny = true
                    }
                    currentLine = ''
                    currentTop = -999
                }
            }
        }
        if (currentLine) {
            const lineStr = currentLine.trim()
            const x = currentLeft - colMinX
            const y = currentTop + offsetY
            if (lineStr && y + lineHeight >= 0 && y <= height && x + width >= 0 && x <= width && x >= -8) {
                ctx.fillText(lineStr, x, y)
                renderedAny = true
            }
        }
    } catch (_) {
        // Fallback for mocked/headless environments without per-character bounding client rects
        const r0 = rects[0]
        const x0 = r0.left - colMinX
        const y0 = r0.top + offsetY
        if (x0 >= -8 && x0 <= width && y0 <= height) {
            ctx.fillText(fullText.trim(), x0, y0)
            renderedAny = true
        }
    }

    return renderedAny
}

/**
 * Adapter for Foliate EPUB / TXT / DOCX Paginated View
 */
export class FoliatePageTurnAdapter extends PageTurnAdapter {
    constructor(foliateView) {
        super()
        this.view = foliateView
    }

    canTurnPrev() {
        return Boolean(this.view)
    }

    canTurnNext() {
        return Boolean(this.view)
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

    isBusy() {
        return Boolean(this.view?.renderer?.locked)
    }

    isContinuousScroll() {
        const flow = this.view?.renderer?.getAttribute?.('flow')
        return Boolean(this.view?.renderer?.scrolled || flow === 'scrolled')
    }

    getViewElement() {
        return this.view?.renderer || this.view?.element || null
    }

    clearVisualCache() {
        this._cachedCanvas = null
        this._cachedNextCanvas = null
    }

    capturePageCanvas(targetPageIndex, bgColor, textColor) {
        if (typeof document === 'undefined') return null
        const viewEl = this.getViewElement()
        if (!viewEl) return null

        const width = viewEl.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800)
        const height = viewEl.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1200)
        if (width <= 0 || height <= 0) return null

        const contents = (typeof this.view?.renderer?.getContents === 'function')
            ? this.view.renderer.getContents()
            : []
        const doc = contents?.[0]?.doc
        if (!doc || !doc.body) return null

        const pageSize = this.view?.renderer?.size || width
        const curPage = this.view?.renderer?.page ?? 0
        const totalPages = this.view?.renderer?.pages ?? 1

        if (targetPageIndex < 0 || targetPageIndex >= totalPages) {
            return null
        }

        const hasBoundaries = totalPages > 2 && curPage >= 1
        const colK = hasBoundaries ? (targetPageIndex - 1) : targetPageIndex
        const colMinX = Math.max(0, colK * pageSize)
        const colMaxX = (colK + 1) * pageSize
        const pageOffset = (targetPageIndex - curPage) * pageSize

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return null

        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, width, height)

        const viewRect = typeof viewEl.getBoundingClientRect === 'function'
            ? viewEl.getBoundingClientRect()
            : { left: 0, top: 0, width, height }
        const iframeEl = doc.defaultView?.frameElement
        const iframeRect = (iframeEl && typeof iframeEl.getBoundingClientRect === 'function')
            ? iframeEl.getBoundingClientRect()
            : null
        const offsetX = (iframeRect ? (iframeRect.left - viewRect.left) : 0) - pageOffset
        const offsetY = (iframeRect ? (iframeRect.top - viewRect.top) : 0)

        let hasContent = false

        try {
            ctx.save()

            // 1. Draw images
            if (typeof doc.body.querySelectorAll === 'function') {
                const images = doc.body.querySelectorAll('img, svg')
                for (const img of images) {
                    const rect = typeof img.getBoundingClientRect === 'function' ? img.getBoundingClientRect() : null
                    if (!rect) continue
                    if (rect.right < colMinX - 8 || rect.left >= colMaxX + 8) continue
                    const x = rect.left - colMinX
                    const y = rect.top + offsetY
                    if (rect.width <= 0 || rect.height <= 0) continue
                    if (y + rect.height < 0 || y > height || x + rect.width < 0 || x > width) continue

                    if (img.tagName === 'IMG') {
                        try {
                            ctx.drawImage(img, x, y, rect.width, rect.height)
                            hasContent = true
                        } catch (_) {}
                    }
                }
            }

            // 2. Draw text nodes with TreeWalker
            if (typeof doc.createTreeWalker === 'function' && typeof doc.createRange === 'function') {
                const showText = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4
                const walker = doc.createTreeWalker(doc.body, showText, null)
                let node = walker.nextNode()
                while (node) {
                    if (renderTextNodeToCanvas(doc, node, ctx, width, height, textColor, colMinX, colMaxX, offsetY)) {
                        hasContent = true
                    }
                    node = walker.nextNode()
                }
            } else if (typeof doc.body.querySelectorAll === 'function') {
                // Headless/test fallback when TreeWalker or Range is not mocked
                const elements = doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, li')
                for (const el of elements) {
                    const text = el.textContent?.trim()
                    if (!text) continue
                    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
                    if (!rect) continue
                    if (rect.right < colMinX - 8 || rect.left >= colMaxX + 8) continue
                    const x = rect.left - colMinX
                    const y = rect.top + offsetY
                    if (y + rect.height < 0 || y > height || x + rect.width < 0 || x > width || x < -8) continue

                    const style = doc.defaultView?.getComputedStyle?.(el)
                    const fontSize = parseFloat(style?.fontSize) || 18
                    const fontFamily = style?.fontFamily || 'serif'
                    const fontWeight = style?.fontWeight || 'normal'
                    const color = (style?.color && style.color !== 'rgba(0, 0, 0, 0)' && style.color !== 'transparent') ? style.color : textColor

                    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
                    ctx.fillStyle = color
                    ctx.textBaseline = 'top'
                    ctx.fillText(text, x, y)
                    hasContent = true
                }
            }

            ctx.restore()
        } catch (e) {
            console.warn('[FoliatePageTurnAdapter] capturePageCanvas failed:', e)
            return null
        }

        return hasContent ? canvas : null
    }

    captureCurrentPageCanvas(bgColor, textColor) {
        const curPage = this.view?.renderer?.page ?? 0
        return this.capturePageCanvas(curPage, bgColor, textColor)
    }

    getVisuals(direction = 'next') {
        const bgColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-bg') || getComputedStyle(document.documentElement).getPropertyValue('--book-bg'))) || '#FAF9F5'
        const textColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-color') || getComputedStyle(document.documentElement).getPropertyValue('--book-color'))) || '#141413'

        const curPage = this.view?.renderer?.page ?? 0
        if (!this._cachedCanvas) {
            this._cachedCanvas = this.capturePageCanvas(curPage, bgColor, textColor)
        }

        const targetPage = direction === 'next' ? curPage + 1 : curPage - 1
        if (!this._cachedNextCanvas) {
            this._cachedNextCanvas = this.capturePageCanvas(targetPage, bgColor, textColor)
        }

        return {
            currentCanvas: this._cachedCanvas,
            nextCanvas: this._cachedNextCanvas || null,
            bgColor,
            textColor
        }
    }
}

/**
 * Adapter for PDF Viewport
 */
export class PdfPageTurnAdapter extends PageTurnAdapter {
    constructor(pdfViewport) {
        super()
        this.viewport = pdfViewport
    }

    getTotalPages() {
        return this.viewport?.pageOffsets?.length || this.viewport?.pageSizes?.length || 1
    }

    getCurrentPage() {
        return this.viewport?.currentPage ?? 0
    }

    _getTargetPage(direction) {
        if (typeof this.viewport?.getAdjacentPage === 'function') return this.viewport.getAdjacentPage(direction)
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
        return Boolean(this.viewport?._isRendering)
    }

    isContinuousScroll() {
        return false // PDF Viewport handles layout internally
    }

    getViewElement() {
        return this.viewport?.scrollArea || this.viewport?.container || null
    }

    _getCanvasForPage(pageIndex) {
        const fromMap = this.viewport?.renderedCanvases?.get?.(pageIndex)
        if (fromMap) return fromMap
        const slot = this.viewport?.activeSlots?.get?.(pageIndex)
        if (slot && typeof slot.querySelector === 'function') {
            const mainCanvas = slot.querySelector('.pdf-page-canvas')
            if (mainCanvas && mainCanvas.width > 0) return mainCanvas
            const previewCanvas = slot.querySelector('.pdf-page-preview, canvas')
            if (previewCanvas && previewCanvas.width > 0) return previewCanvas
        }
        return null
    }

    getVisuals(direction = 'next') {
        // Retrieve current and target page canvases for realistic page-turn projection
        const curPage = this.getCurrentPage()
        const curCanvas = this._getCanvasForPage(curPage)
        const targetPage = this._getTargetPage(direction)
        const nextCanvas = targetPage == null ? null : this._getCanvasForPage(targetPage)
        const bgColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-bg') || (typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--book-bg') : ''))) || '#ffffff'
        const textColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-color') || (typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--book-color') : ''))) || '#141413'
        return {
            currentCanvas: curCanvas,
            nextCanvas: nextCanvas,
            bgColor: bgColor.trim() || '#ffffff',
            textColor: textColor.trim() || '#141413'
        }
    }
}


/**
 * Universal Page Turn Controller
 */
export class PageTurnController {
    constructor(options = {}) {
        this.container = options.container || null
        this.adapter = options.adapter || null
        let initialMode = options.mode || 'none'
        if (initialMode === 'curl') {
            initialMode = 'slide'
        }
        if (!PAGE_TURN_MODES.includes(initialMode)) {
            initialMode = 'none'
        }
        this.mode = initialMode
        this.state = 'idle'
        this.generation = 0
        this.animationDuration = options.animationDuration || 220 // ms

        // Gesture tracking
        this.touchStart = null
        this.currentDrag = null
        this.isGestureActive = false
        this._isBlockedCallback = options.isBlockedCallback || (() => false)

        // Overlay elements
        this._overlayEl = null

        this._checkReducedMotion()
        this._initOverlay()
    }

    _checkReducedMotion() {
        try {
            if (typeof window !== 'undefined' && window.matchMedia) {
                const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
                this.prefersReducedMotion = mq.matches
                mq.addEventListener?.('change', (e) => {
                    this.prefersReducedMotion = e.matches
                })
            }
        } catch (e) {
            this.prefersReducedMotion = false
        }
    }

    _initOverlay() {
        if (typeof document === 'undefined') return
        let overlay = document.getElementById('page-turn-overlay')
        if (!overlay && this.container) {
            overlay = document.createElement('div')
            overlay.id = 'page-turn-overlay'
            overlay.className = 'page-turn-overlay'
            overlay.style.cssText = `
                position: absolute;
                inset: 0;
                pointer-events: none;
                z-index: 40;
                display: none;
                overflow: hidden;
            `
            // An absolutely positioned reader already anchors the overlay.
            // Overriding it with relative breaks top/bottom viewport insets.
            const position = this.container.ownerDocument?.defaultView?.getComputedStyle(this.container)?.position || this.container.style.position
            if (!position || position === 'static') this.container.style.position = 'relative'
            this.container.appendChild(overlay)
        }
        this._overlayEl = overlay
    }

    setAdapter(adapter) {
        this.cancelCurrent()
        this.adapter = adapter
    }

    setMode(mode) {
        if (mode === 'curl') {
            mode = 'slide'
        }
        if (!PAGE_TURN_MODES.includes(mode)) return
        this.cancelCurrent()
        this.mode = mode
    }

    getEffectiveMode() {
        if (this.prefersReducedMotion || (typeof document !== 'undefined' && (document.documentElement?.dataset?.reducedMotion === 'true' || document.documentElement?.dataset?.animIntensity === 'none'))) return 'none'
        if (this.adapter?.isContinuousScroll?.()) return 'scroll'
        if (typeof window !== 'undefined') {
            const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(window.platformBridge?.isAndroid)
            if (!isMobile) return 'none'
        }
        if (this.mode === 'curl') {
            return 'slide'
        }
        if (!PAGE_TURN_MODES.includes(this.mode)) {
            return 'none'
        }
        return this.mode
    }

    /**
     * Check if page turn gestures should be blocked
     * Handled strictly: Drawing tool, text selection, zoomed PDF take precedence
     */
    isGestureBlocked() {
        if (this._isBlockedCallback()) return true
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
            const sel = window.getSelection()
            if (sel && sel.toString().trim().length > 0) return true
        }
        return false
    }

    /**
     * Invalidate and cancel in-flight animations/textures
     */
    cancelCurrent() {
        this.generation++
        this.state = 'idle'
        this.touchStart = null
        this.currentDrag = null
        this._peakDisplacement = 0
        this.isGestureActive = false

        if (this._overlayEl) {
            this._overlayEl.style.display = 'none'
            this._overlayEl.innerHTML = ''
        }

        this.adapter?.clearVisualCache?.()

        const viewEl = this.adapter?.getViewElement?.()
        if (viewEl?.style) {
            viewEl.style.transition = ''
            viewEl.style.transform = ''
            viewEl.style.opacity = ''
            viewEl.style.filter = ''
        }
    }

    /**
     * Turn to next page with configured animation
     */
    async turnNext() {
        if (this.state !== 'idle') return
        if (!this.adapter || !this.adapter.canTurnNext()) return
        if (this.adapter.isBusy()) return

        const mode = this.getEffectiveMode()
        if (mode === 'none' || mode === 'scroll') {
            await this.adapter.turnNext()
            return
        }

        await this._performTransition('next', mode)
    }

    /**
     * Turn to previous page with configured animation
     */
    async turnPrev() {
        if (this.state !== 'idle') return
        if (!this.adapter || !this.adapter.canTurnPrev()) return
        if (this.adapter.isBusy()) return

        const mode = this.getEffectiveMode()
        if (mode === 'none' || mode === 'scroll') {
            await this.adapter.turnPrev()
            return
        }

        await this._performTransition('prev', mode)
    }

    /**
     * Internal animation executor
     */
    async _performTransition(direction, mode) {
        const curGen = ++this.generation
        this.state = 'settling'
        const viewEl = this.adapter.getViewElement()

        if (!viewEl || !this.container) {
            // Fallback directly to adapter jump
            await (direction === 'next' ? this.adapter.turnNext() : this.adapter.turnPrev())
            this.state = 'idle'
            return
        }

        const isNext = direction === 'next'
        const width = this.container.clientWidth || 800
        const height = this.container.clientHeight || 600

        try {
            if (mode === 'slide') {
                // Horizontal Slide Animation
                viewEl.style.transition = `transform ${this.animationDuration}ms cubic-bezier(0.25, 1, 0.5, 1)`
                const offset = isNext ? -width * 0.25 : width * 0.25
                viewEl.style.transform = `translate3d(${offset}px, 0, 0)`

                await new Promise(r => setTimeout(r, this.animationDuration * 0.6))
                if (curGen !== this.generation) return

                // Commit reader navigation
                await (isNext ? this.adapter.turnNext() : this.adapter.turnPrev())
                if (curGen !== this.generation) return

                // Slide back from opposite side
                viewEl.style.transition = 'none'
                viewEl.style.transform = `translate3d(${-offset * 0.5}px, 0, 0)`
                viewEl.offsetHeight // Force layout reflow

                viewEl.style.transition = `transform ${this.animationDuration * 0.5}ms cubic-bezier(0, 0, 0.2, 1)`
                viewEl.style.transform = 'translate3d(0, 0, 0)'
                await new Promise(r => setTimeout(r, this.animationDuration * 0.5))

            } else if (mode === 'cover') {
                // Cover Page Peel Animation with themed sheet & current page snapshot
                const visuals = this.adapter?.getVisuals?.(direction) || {}
                const bg = visuals.bgColor
                    || (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue?.('--book-bg') || document.documentElement?.style?.backgroundColor))
                    || '#FAF9F5'
                if (this._overlayEl) {
                    this._overlayEl.style.display = 'block'
                    this._overlayEl.innerHTML = `
                        <div class="cover-peel-sheet" style="
                            position: absolute;
                            inset: 0;
                            overflow: hidden;
                            background: ${bg};
                            box-shadow: ${isNext ? '-12px 0 28px rgba(0,0,0,0.18)' : '12px 0 28px rgba(0,0,0,0.18)'};
                            transform: translate3d(0, 0, 0);
                            transition: transform ${this.animationDuration}ms cubic-bezier(0.25, 1, 0.5, 1);
                        "></div>
                    `
                    const sheet = this._overlayEl.querySelector('.cover-peel-sheet')
                    if (sheet && visuals.currentCanvas && typeof document !== 'undefined') {
                        try {
                            const snapshotCanvas = document.createElement('canvas')
                            snapshotCanvas.width = width
                            snapshotCanvas.height = height
                            snapshotCanvas.style.cssText = 'width: 100%; height: 100%; display: block; pointer-events: none;'
                            const sCtx = snapshotCanvas.getContext?.('2d')
                            sCtx?.drawImage?.(visuals.currentCanvas, 0, 0, width, height)
                            sheet.appendChild(snapshotCanvas)
                        } catch (_) {}
                    }
                    sheet.offsetHeight // reflow
                    sheet.style.transform = `translate3d(${isNext ? -width : width}px, 0, 0)`
                }

                await (isNext ? this.adapter.turnNext() : this.adapter.turnPrev())
                await new Promise(r => setTimeout(r, this.animationDuration))


            }
        } catch (err) {
            console.warn('[PageTurnController] Transition failed, fallback to jump:', err)
            await (isNext ? this.adapter.turnNext() : this.adapter.turnPrev())
        } finally {
            if (curGen === this.generation) {
                this.cancelCurrent()
            }
        }
    }

    /**
     * Touch Event Handlers for Interactive Dragging
     */
    handleTouchStart(e) {
        if (this.isGestureBlocked()) return
        if (this.state === 'settling') return // busy animating
        if (!e.touches || e.touches.length !== 1) {
            this.cancelCurrent()
            return
        }

        const touch = e.touches[0]
        const now = Date.now()
        this.touchStart = {
            x: touch.clientX,
            y: touch.clientY,
            time: now
        }
        this._peakDisplacement = 0
        this._recentTouches = [{ x: touch.clientX, y: touch.clientY, time: now }]
        this.state = 'preparing'
        this.isGestureActive = false
    }

    handleTouchMove(e) {
        if (!this.touchStart || this.state === 'settling') return
        if (this.isGestureBlocked() || (e.touches && e.touches.length !== 1)) {
            this.cancelCurrent()
            return
        }

        const touch = e.touches[0]
        const now = Date.now()
        if (!this._recentTouches) this._recentTouches = []
        this._recentTouches.push({ x: touch.clientX, y: touch.clientY, time: now })
        const recentCutoff = now - 120
        this._recentTouches = this._recentTouches.filter(t => t.time >= recentCutoff)

        const deltaX = touch.clientX - this.touchStart.x
        const deltaY = touch.clientY - this.touchStart.y

        if (Math.abs(deltaX) > Math.abs(this._peakDisplacement || 0)) {
            this._peakDisplacement = deltaX
        }

        // Check if horizontal swipe dominates vertical scroll
        if (this.state === 'preparing') {
            if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
                this.state = 'dragging'
                this.isGestureActive = true
            } else if (Math.abs(deltaY) > 12) {
                // Vertical dominant: cancel page turn gesture, let default scroll happen
                this.state = 'idle'
                this.touchStart = null
                return
            }
        }

        if (this.state === 'dragging') {
            if (e.cancelable) e.preventDefault() // Prevent page bouncing during drag
            const width = this.container?.clientWidth || 800
            const height = this.container?.clientHeight || 600
            const progress = Math.min(1, Math.max(-1, deltaX / width))
            this.currentDrag = {
                deltaX,
                deltaY,
                progress
            }

            const mode = this.getEffectiveMode()
            if (mode === 'slide' || mode === 'cover') {
                const viewEl = this.adapter?.getViewElement?.()
                if (viewEl) {
                    viewEl.style.transition = 'none'
                    viewEl.style.transform = `translate3d(${deltaX * (mode === 'cover' ? 0.55 : 0.4)}px, 0, 0)`
                }

            }
        }
    }

    async handleTouchEnd(e) {
        if (e.touches && e.touches.length > 0) {
            // Multi-touch still has remaining contact or lifted one of multiple fingers: cancel!
            this.cancelCurrent()
            return
        }
        if (!this.touchStart || this.state !== 'dragging') {
            this.cancelCurrent()
            return
        }

        const deltaX = this.currentDrag?.deltaX || 0
        const now = Date.now()
        const width = this.container?.clientWidth || 800
        const height = this.container?.clientHeight || 600

        // Compute signed velocity across recent ~60-100ms window (last 2-3 touches)
        let recentVelocityX = 0
        if (this._recentTouches && this._recentTouches.length >= 2) {
            const sample = this._recentTouches.slice(-3)
            const oldest = sample[0]
            const newest = sample[sample.length - 1]
            const dt = Math.max(16, newest.time - oldest.time)
            const dx = (newest.x - oldest.x)
            recentVelocityX = dx / dt // signed px/ms
        }

        const direction = deltaX < 0 ? 'next' : 'prev'
        const peak = this._peakDisplacement !== undefined ? this._peakDisplacement : deltaX
        const isPullingBack = direction === 'next'
            ? ((deltaX - peak) > 25 || recentVelocityX > 0.15)
            : ((peak - deltaX) > 25 || recentVelocityX < -0.15)

        let shouldTurn = false

        if (isPullingBack) {
            shouldTurn = false
        } else if (direction === 'next') {
            shouldTurn = Math.abs(deltaX) > width * 0.18 || (recentVelocityX < -0.32 && Math.abs(deltaX) > 40)
        } else {
            shouldTurn = Math.abs(deltaX) > width * 0.18 || (recentVelocityX > 0.32 && Math.abs(deltaX) > 40)
        }

        const mode = this.getEffectiveMode()

        this.touchStart = null
        this.currentDrag = null
        this.isGestureActive = false
        this._recentTouches = []

        // Crucial fix: return controller state to idle before invoking turnNext/turnPrev
        this.state = 'idle'

        if (shouldTurn) {
            if (direction === 'next' && this.adapter?.canTurnNext()) {
                await this.turnNext()
            } else if (direction === 'prev' && this.adapter?.canTurnPrev()) {
                await this.turnPrev()
            } else {
                this.cancelCurrent()
            }
        } else {
            // Rebound back to current page
            const viewEl = this.adapter?.getViewElement?.()
            if (viewEl) {
                viewEl.style.transition = 'transform 180ms ease-out'
                viewEl.style.transform = 'translate3d(0, 0, 0)'
                setTimeout(() => {
                    this.cancelCurrent()
                }, 180)
            } else {
                this.cancelCurrent()
            }
        }
    }
}
