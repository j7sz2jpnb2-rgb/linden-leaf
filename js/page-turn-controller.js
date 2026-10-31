// js/page-turn-controller.js - Unified Page Turn Controller for Linden Leaf
// Architecture:
// - Coordinates 5 distinct page turn modes:
//     1. 'none'       - Instant jump (e-ink / performance / reduced motion)
//     2. 'slide'      - Horizontal smooth sliding translation (recommended default)
//     3. 'cover'      - Overlapping sheet page flip with edge drop shadow
//     4. 'scroll'     - Continuous vertical/horizontal stream reading flow
//     5. 'curl'       - Realistic 2D Canvas simulation turn with paper deformation & shadow gradients
// - State Machine: 'idle' -> 'preparing' -> 'dragging' -> 'settling' -> 'idle'
// - Generation Counter: Cancels stale textures/animations immediately on resize, font, theme, or book changes
// - Interaction Priority: Drawing tool, text selection, zoomed PDF panning strictly supersede page turns
// - Respects 'prefers-reduced-motion' automatically

export const PAGE_TURN_MODES = ['none', 'slide', 'cover', 'scroll', 'curl']
export const PAGE_TURN_STATES = ['idle', 'preparing', 'dragging', 'settling']
export const FEATURE_CURL_PAGE_TURN_ENABLED = true

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

    canTurnPrev() {
        return this.getCurrentPage() > 0
    }

    canTurnNext() {
        return this.getCurrentPage() < this.getTotalPages() - 1
    }

    async turnPrev() {
        if (this.canTurnPrev()) {
            await this.viewport.goToPage(this.getCurrentPage() - 1)
        }
    }

    async turnNext() {
        if (this.canTurnNext()) {
            await this.viewport.goToPage(this.getCurrentPage() + 1)
        }
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
        // Retrieve current and target page canvases for realistic curl projection
        const curPage = this.getCurrentPage()
        const curCanvas = this._getCanvasForPage(curPage)
        const targetPage = direction === 'next' ? curPage + 1 : curPage - 1
        const nextCanvas = this._getCanvasForPage(targetPage)
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
 * Cylindrical 2D Canvas Paper Curl Renderer
 * Computes curved page geometry, dynamic soft shadows, light reflection, and texture mapping
 */
/**
 * Cylindrical 2D Canvas Paper Curl Renderer
 * Computes curved page geometry, dynamic soft shadows, light reflection, and texture mapping
 * using exact cylindrical projection formulas:
 *   s = dot(p - o, n),  q = dot(p - o, t),  t = (-n.y, n.x),  R > 0
 *   s <= 0:         Pxy = o + q*t + s*n;               z = 0;              N = (0, 0, 1)
 *   0 < s < π*R:    θ = s/R;
 *                   Pxy = o + q*t + R*sin(θ)*n;        z = R*(1 - cos(θ)); N = (-sinθ*nx, -sinθ*ny, cosθ)
 *   s >= π*R:       Pxy = o + q*t - (s - π*R)*n;       z = 2*R;            N = (0, 0, -1)
 */
export class CurlSimulator {
    constructor(canvas) {
        this.canvas = canvas
        this.ctx = canvas?.getContext('2d') || null
    }

    /**
     * Exact Cylindrical Surface Mapping
     */
    static mapPoint(p, o, n, t, R) {
        const po_x = p.x - o.x
        const po_y = p.y - o.y
        const s = po_x * n.x + po_y * n.y
        const q = po_x * t.x + po_y * t.y

        if (s <= 0) {
            return {
                x: o.x + q * t.x + s * n.x,
                y: o.y + q * t.y + s * n.y,
                z: 0,
                s,
                q,
                normal: { x: 0, y: 0, z: 1 }
            }
        } else if (s < Math.PI * R) {
            const theta = s / R
            const sinTheta = Math.sin(theta)
            const cosTheta = Math.cos(theta)
            return {
                x: o.x + q * t.x + R * sinTheta * n.x,
                y: o.y + q * t.y + R * sinTheta * n.y,
                z: R * (1 - cosTheta),
                s,
                q,
                normal: { x: -sinTheta * n.x, y: -sinTheta * n.y, z: cosTheta }
            }
        } else {
            const rolledS = s - Math.PI * R
            return {
                x: o.x + q * t.x - rolledS * n.x,
                y: o.y + q * t.y - rolledS * n.y,
                z: 2 * R,
                s,
                q,
                normal: { x: 0, y: 0, z: -1 }
            }
        }
    }

    renderCurl({
        width,
        height,
        progress,
        direction = 'next',
        touchX = null,
        touchY = null,
        currentTexture = null,
        nextTexture = null,
        bgColor = '#FAF9F5',
        textColor = '#141413'
    }) {
        if (!this.ctx || width <= 0 || height <= 0) return
        const ctx = this.ctx
        ctx.clearRect(0, 0, width, height)

        const clampedProgress = Math.min(1, Math.max(0, progress))
        if (clampedProgress <= 0 || clampedProgress >= 1) return

        const isNext = direction === 'next'
        const isDark = isDarkColor(bgColor)

        // Ergonomic corner slant (Authentic WeChat Reading conical corner curl):
        // Pulling near top corner causes top to lead with steep angle; mid swipe maintains natural ergonomic lead
        const targetY = touchY != null ? Math.max(0, Math.min(height, touchY)) : height * 0.25
        const normY = (targetY - height * 0.5) / (height * 0.5) // -1 top, +1 bottom
        const cornerLead = -normY * 0.75 + 0.35

        const slantTop = isNext
            ? (1 - clampedProgress * (1 + 0.75 * cornerLead))
            : (clampedProgress * (1 + 0.75 * cornerLead))
        const slantBottom = isNext
            ? (1 - clampedProgress * (1 - 0.55 * cornerLead))
            : (clampedProgress * (1 - 0.55 * cornerLead))

        const foldTopX = width * Math.min(1.05, Math.max(-0.25, slantTop))
        const foldBottomX = width * Math.min(1.05, Math.max(-0.25, slantBottom))

        const dx = foldBottomX - foldTopX
        const dy = height
        const lineLen = Math.hypot(dx, dy) || 1
        const foldAngle = Math.atan2(dy, dx)

        // Normal pointing towards revealed page:
        // isNext: revealed page on right -> nx > 0
        // isPrev: revealed page on left  -> nx < 0
        const nx = isNext ? (dy / lineLen) : (-dy / lineLen)
        const ny = isNext ? (-dx / lineLen) : (dx / lineLen)

        // Conical curl radii: larger at leading corner, smoothly tapered
        const baseR = Math.max(12, Math.min(width * 0.12, 16 + 20 * Math.sin(clampedProgress * Math.PI)))
        const taper = Math.max(0, Math.min(0.5, Math.abs(dx) / width))
        const R_top = isNext ? baseR * (1 + taper) : baseR * (1 - taper)
        const R_bottom = isNext ? baseR * (1 - taper * 0.7) : baseR * (1 + taper * 0.7)

        // Flap reach: Conical curl width (Slender natural strip matching WeChat Reading)
        const peelDistTop = isNext ? Math.max(0, width - foldTopX) : Math.max(0, foldTopX)
        const peelDistBottom = isNext ? Math.max(0, width - foldBottomX) : Math.max(0, foldBottomX)

        const flapWidthTop = Math.min(peelDistTop * 0.52, width * 0.36)
        const flapWidthBottom = Math.min(peelDistBottom * 0.38, width * 0.24)

        const flapCornerTopX = foldTopX - nx * flapWidthTop
        const flapCornerBottomX = foldBottomX - nx * flapWidthBottom

        const midX = (foldTopX + foldBottomX) / 2
        const midY = height / 2

        // Shadow color palettes (Warm ambient falloff for light theme, deep charcoal for dark)
        const shadowBase = isDark ? '0, 0, 0' : '40, 30, 20'

        ctx.save()

        // =========================================================================
        // LAYER 1: Stationary Revealed Page (Next Page for isNext, Prev for isPrev)
        // =========================================================================
        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, width, height)

        if (nextTexture) {
            try {
                ctx.drawImage(nextTexture, 0, 0, width, height)
            } catch (_) {}
        }

        // Spine shadow on revealed page binding edge
        const spineSide = isNext ? 0 : width - 24
        const spineGradNext = ctx.createLinearGradient(spineSide, 0, isNext ? 24 : width, 0)
        spineGradNext.addColorStop(isNext ? 0 : 1, 'rgba(' + shadowBase + ', 0.10)')
        spineGradNext.addColorStop(isNext ? 1 : 0, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = spineGradNext
        ctx.fillRect(spineSide, 0, 24, height)

        // =========================================================================
        // LAYER 2: Warm Diffuse Crease Drop Shadow cast onto revealed page
        // =========================================================================
        ctx.save()
        ctx.beginPath()
        if (isNext) {
            ctx.moveTo(foldTopX, 0)
            ctx.lineTo(width, 0)
            ctx.lineTo(width, height)
            ctx.lineTo(foldBottomX, height)
        } else {
            ctx.moveTo(0, 0)
            ctx.lineTo(foldTopX, 0)
            ctx.lineTo(foldBottomX, height)
            ctx.lineTo(0, height)
        }
        ctx.closePath()
        ctx.clip()

        // Smooth 45px falloff drop shadow cast by the crease
        const shadowDist = 48
        const shadG = ctx.createLinearGradient(midX, midY, midX + nx * shadowDist, midY + ny * shadowDist)
        shadG.addColorStop(0, 'rgba(' + shadowBase + ', ' + (isDark ? 0.40 : 0.35) + ')')
        shadG.addColorStop(0.20, 'rgba(' + shadowBase + ', ' + (isDark ? 0.22 : 0.18) + ')')
        shadG.addColorStop(0.55, 'rgba(' + shadowBase + ', ' + (isDark ? 0.08 : 0.05) + ')')
        shadG.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = shadG
        ctx.fillRect(0, 0, width, height)
        ctx.restore()

        // =========================================================================
        // LAYER 3: Flat Unpeeled Current Page
        // =========================================================================
        ctx.save()
        ctx.beginPath()
        if (isNext) {
            ctx.moveTo(0, 0)
            ctx.lineTo(foldTopX, 0)
            ctx.lineTo(foldBottomX, height)
            ctx.lineTo(0, height)
        } else {
            ctx.moveTo(foldTopX, 0)
            ctx.lineTo(width, 0)
            ctx.lineTo(width, height)
            ctx.lineTo(foldBottomX, height)
        }
        ctx.closePath()
        ctx.clip()

        // 100% OPAQUE background fill prevents any bleed-through from underneath
        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, width, height)

        if (currentTexture) {
            try {
                ctx.drawImage(currentTexture, 0, 0, width, height)
            } catch (_) {}
        }

        // Spine shadow on current page
        const spineSideCur = isNext ? 0 : width - 24
        const spineGradCur = ctx.createLinearGradient(spineSideCur, 0, isNext ? 24 : width, 0)
        spineGradCur.addColorStop(isNext ? 0 : 1, 'rgba(' + shadowBase + ', 0.10)')
        spineGradCur.addColorStop(isNext ? 1 : 0, 'rgba(0, 0, 0, 0)')
        ctx.fillStyle = spineGradCur
        ctx.fillRect(spineSideCur, 0, 24, height)

        ctx.restore()

        // =========================================================================
        // LAYER 4: Curled Flap with Organic Paper Lighting & Translucent Show-Through
        // =========================================================================
        // 4a. Ambient drop shadow cast by flap edge onto flat current page
        ctx.save()
        const edgeShadW = 28
        ctx.beginPath()
        if (isNext) {
            ctx.moveTo(flapCornerTopX - edgeShadW, 40)
            if (typeof ctx.quadraticCurveTo === 'function') {
                ctx.quadraticCurveTo(
                    (flapCornerTopX + flapCornerBottomX) / 2 - edgeShadW, height * 0.5,
                    flapCornerBottomX - edgeShadW, height
                )
            } else {
                ctx.lineTo(flapCornerBottomX - edgeShadW, height)
            }
            ctx.lineTo(flapCornerBottomX + 2, height)
            if (typeof ctx.quadraticCurveTo === 'function') {
                ctx.quadraticCurveTo(
                    (flapCornerTopX + flapCornerBottomX) / 2 + 2, height * 0.5,
                    flapCornerTopX + 2, 40
                )
            } else {
                ctx.lineTo(flapCornerTopX + 2, 40)
            }
        } else {
            ctx.moveTo(flapCornerTopX + edgeShadW, 40)
            if (typeof ctx.quadraticCurveTo === 'function') {
                ctx.quadraticCurveTo(
                    (flapCornerTopX + flapCornerBottomX) / 2 + edgeShadW, height * 0.5,
                    flapCornerBottomX + edgeShadW, height
                )
            } else {
                ctx.lineTo(flapCornerBottomX + edgeShadW, height)
            }
            ctx.lineTo(flapCornerBottomX - 2, height)
            if (typeof ctx.quadraticCurveTo === 'function') {
                ctx.quadraticCurveTo(
                    (flapCornerTopX + flapCornerBottomX) / 2 - 2, height * 0.5,
                    flapCornerTopX - 2, 40
                )
            } else {
                ctx.lineTo(flapCornerTopX - 2, 40)
            }
        }
        ctx.closePath()

        const fEdgeG = isNext
            ? ctx.createLinearGradient(flapCornerTopX - edgeShadW, 0, flapCornerTopX, 0)
            : ctx.createLinearGradient(flapCornerTopX, 0, flapCornerTopX + edgeShadW, 0)
        fEdgeG.addColorStop(isNext ? 0 : 1, 'rgba(' + shadowBase + ', 0)')
        fEdgeG.addColorStop(isNext ? 0.6 : 0.4, 'rgba(' + shadowBase + ', ' + (isDark ? 0.10 : 0.08) + ')')
        fEdgeG.addColorStop(isNext ? 1 : 0, 'rgba(' + shadowBase + ', ' + (isDark ? 0.32 : 0.26) + ')')
        ctx.fillStyle = fEdgeG
        ctx.fill()
        ctx.restore()

        // 4b. Flap Paper Body
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(foldTopX, 0)

        // Graceful curled arch at the top corner
        const archTopX = foldTopX - (isNext ? 45 : -45)
        if (typeof ctx.bezierCurveTo === 'function') {
            ctx.bezierCurveTo(
                archTopX, -12,
                flapCornerTopX + (isNext ? 20 : -20), 5,
                flapCornerTopX, 55
            )
        } else if (typeof ctx.quadraticCurveTo === 'function') {
            ctx.quadraticCurveTo(
                archTopX, 0,
                flapCornerTopX, 55
            )
        } else {
            ctx.lineTo(flapCornerTopX, 55)
        }

        // Organic curved outer peeling edge
        const midEdgeX = (flapCornerTopX + flapCornerBottomX) / 2 - (isNext ? 8 : -8)
        if (typeof ctx.quadraticCurveTo === 'function') {
            ctx.quadraticCurveTo(
                midEdgeX, height * 0.5,
                flapCornerBottomX, height
            )
        } else {
            ctx.lineTo(flapCornerBottomX, height)
        }

        ctx.lineTo(foldBottomX, height)
        ctx.closePath()
        ctx.clip()

        // 100% OPAQUE base paper fill (pure matte paper, identical to book theme)
        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, width, height)

        // 4c. Mirrored Translucent Show-Through Text across crease line
        if (currentTexture) {
            try {
                ctx.save()
                // Reflected coordinate system across crease line (aligned with normal vector)
                const theta = foldAngle - Math.PI / 2
                ctx.translate(foldTopX, 0)
                if (typeof ctx.rotate === 'function') ctx.rotate(theta)
                ctx.scale(-1, 1) // Invert across normal to reflect back of page
                if (typeof ctx.rotate === 'function') ctx.rotate(-theta)
                ctx.translate(-foldTopX, 0)

                // Strictly clip to the peeled region to guarantee zero ghosting / overlap
                ctx.beginPath()
                if (isNext) {
                    ctx.moveTo(foldTopX, 0)
                    ctx.lineTo(width + 20, 0)
                    ctx.lineTo(width + 20, height + 20)
                    ctx.lineTo(foldBottomX, height + 20)
                } else {
                    ctx.moveTo(-20, 0)
                    ctx.lineTo(foldTopX, 0)
                    ctx.lineTo(foldBottomX, height + 20)
                    ctx.lineTo(-20, height + 20)
                }
                ctx.closePath()
                ctx.clip()

                // Subtle paper fiber show-through (matching WeChat Reading)
                ctx.globalAlpha = isDark ? 0.15 : 0.20
                ctx.drawImage(currentTexture, 0, 0, width, height)
                ctx.restore()
            } catch (_) {}
        }

        // 4d. Matte Paper Crease Shading (Warm ambient AO, ABSOLUTELY NO metallic highlight)
        const flapGradLen = Math.min(110, Math.max(50, flapWidthTop))
        const fShadG = ctx.createLinearGradient(midX, midY, midX - nx * flapGradLen, midY - ny * flapGradLen)
        fShadG.addColorStop(0, 'rgba(' + shadowBase + ', ' + (isDark ? 0.32 : 0.28) + ')') // Crease shadow
        fShadG.addColorStop(0.20, 'rgba(' + shadowBase + ', ' + (isDark ? 0.12 : 0.10) + ')')
        fShadG.addColorStop(0.50, 'rgba(' + shadowBase + ', 0)') // Pure paper body in middle
        fShadG.addColorStop(0.85, 'rgba(' + shadowBase + ', 0)')
        fShadG.addColorStop(1, 'rgba(' + shadowBase + ', ' + (isDark ? 0.14 : 0.10) + ')') // Subtle rim darkening
        ctx.fillStyle = fShadG
        ctx.fillRect(0, 0, width, height)

        // 4e. Top curl inner depth shadow (gives 3D depth to the rolled top arch)
        if (typeof ctx.createRadialGradient === 'function') {
            const topCurlG = ctx.createRadialGradient(foldTopX - (isNext ? 40 : -40), 20, 5, foldTopX - (isNext ? 40 : -40), 20, 75)
            topCurlG.addColorStop(0, 'rgba(' + shadowBase + ', ' + (isDark ? 0.26 : 0.22) + ')')
            topCurlG.addColorStop(0.60, 'rgba(' + shadowBase + ', ' + (isDark ? 0.08 : 0.06) + ')')
            topCurlG.addColorStop(1, 'rgba(' + shadowBase + ', 0)')
            ctx.fillStyle = topCurlG
            ctx.fillRect(0, 0, width, 120)
        }

        // 4f. Delicate paper fiber rim outline along top rolled arch & outer edge
        ctx.beginPath()
        ctx.moveTo(foldTopX, 0)
        if (typeof ctx.bezierCurveTo === 'function') {
            ctx.bezierCurveTo(
                archTopX, -12,
                flapCornerTopX + (isNext ? 20 : -20), 5,
                flapCornerTopX, 55
            )
        } else if (typeof ctx.quadraticCurveTo === 'function') {
            ctx.quadraticCurveTo(
                archTopX, 0,
                flapCornerTopX, 55
            )
        } else {
            ctx.lineTo(flapCornerTopX, 55)
        }
        if (typeof ctx.quadraticCurveTo === 'function') {
            ctx.quadraticCurveTo(
                midEdgeX, height * 0.5,
                flapCornerBottomX, height
            )
        } else {
            ctx.lineTo(flapCornerBottomX, height)
        }
        ctx.lineWidth = 0.8
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(' + shadowBase + ', 0.12)'
        ctx.stroke()

        ctx.restore() // Restore from Flap clip
        ctx.restore() // Restore outer

        ctx.restore()
    }
}

/**
 * Universal Page Turn Controller
 */
export class PageTurnController {
    constructor(options = {}) {
        this.container = options.container || null
        this.adapter = options.adapter || null
        this.mode = options.mode || 'none' // 'none' | 'slide' | 'cover' | 'scroll' | 'curl'
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
        this._curlCanvas = null
        this._curlSimulator = null

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
        if (!FEATURE_CURL_PAGE_TURN_ENABLED && this.mode === 'curl') {
            return 'slide' // Gracefully fallback to stable slide animation while preserving user preference
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

            } else if (mode === 'curl') {
                const visuals = this.adapter?.getVisuals?.(direction) || {}
                if (!visuals.currentCanvas) {
                    // Fallback gracefully to slide mode when current page texture cannot be captured
                    return this._performTransition(direction, 'slide')
                }

                // Realistic Canvas 2D Curl Simulation (Experimental decorative simulation)
                if (!this._curlCanvas && typeof document !== 'undefined') {
                    this._curlCanvas = document.createElement('canvas')
                    this._curlCanvas.className = 'page-turn-curl-canvas'
                    this._curlSimulator = new CurlSimulator(this._curlCanvas)
                }

                if (this._curlCanvas) {
                    this._curlCanvas.width = width
                    this._curlCanvas.height = height
                    this._curlCanvas.style.cssText = 'position: absolute; inset: 0; pointer-events: none;'
                }

                if (this._overlayEl && this._curlCanvas) {
                    this._overlayEl.innerHTML = ''
                    this._overlayEl.appendChild(this._curlCanvas)
                    this._overlayEl.style.display = 'block'
                }

                const startTime = performance.now()
                const dur = this.animationDuration * 1.2

                await new Promise((resolve) => {
                    const animateCurl = (now) => {
                        if (curGen !== this.generation) {
                            resolve()
                            return
                        }
                        const elapsed = now - startTime
                        const progress = Math.min(1, elapsed / dur)

                        const visuals = this.adapter.getVisuals?.(direction) || {}
                        if (this._curlSimulator) {
                            this._curlSimulator.renderCurl({
                                width,
                                height,
                                progress,
                                direction,
                                currentTexture: visuals.currentCanvas,
                                nextTexture: visuals.nextCanvas,
                                bgColor: visuals.bgColor,
                                textColor: visuals.textColor
                            })
                        }

                        if (progress < 1 && curGen === this.generation) {
                            safeRaf(animateCurl)
                        } else {
                            resolve()
                        }
                    }
                    safeRaf(animateCurl)
                })

                // Atomically commit page turn upon animation completion
                if (curGen === this.generation) {
                    await (isNext ? this.adapter.turnNext() : this.adapter.turnPrev())
                }
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
            } else if (mode === 'curl') {
                const direction = deltaX < 0 ? 'next' : 'prev'
                const canTurn = direction === 'next' ? this.adapter?.canTurnNext() : this.adapter?.canTurnPrev()
                if (canTurn) {
                    const visuals = this.adapter?.getVisuals?.(direction) || {}
                    if (!visuals.currentCanvas) {
                        const viewEl = this.adapter?.getViewElement?.()
                        if (viewEl) {
                            viewEl.style.transition = 'none'
                            viewEl.style.transform = `translate3d(${deltaX * 0.4}px, 0, 0)`
                        }
                        return
                    }

                    if (!this._curlCanvas && typeof document !== 'undefined') {
                        this._curlCanvas = document.createElement('canvas')
                        this._curlCanvas.className = 'page-turn-curl-canvas'
                        this._curlSimulator = new CurlSimulator(this._curlCanvas)
                    }
                    if (this._curlCanvas) {
                        if (this._curlCanvas.width !== width || this._curlCanvas.height !== height) {
                            this._curlCanvas.width = width
                            this._curlCanvas.height = height
                        }
                    }
                    if (this._overlayEl && this._curlCanvas) {
                        if (this._overlayEl.firstChild !== this._curlCanvas) {
                            this._overlayEl.innerHTML = ''
                            this._overlayEl.appendChild(this._curlCanvas)
                        }
                        this._overlayEl.style.display = 'block'
                    }

                    if (this._curlSimulator) {
                        const curlProgress = Math.min(1, Math.max(0, Math.abs(deltaX) / width))
                        const visuals = this.adapter?.getVisuals?.(direction) || {}
                        this._curlSimulator.renderCurl({
                            width,
                            height,
                            progress: curlProgress,
                            direction,
                            touchX: touch.clientX,
                            touchY: touch.clientY,
                            currentTexture: visuals.currentCanvas,
                            nextTexture: visuals.nextCanvas,
                            bgColor: visuals.bgColor,
                            textColor: visuals.textColor
                        })
                    }

                    const viewEl = this.adapter?.getViewElement?.()
                    if (viewEl) {
                        viewEl.style.transition = 'none'
                        viewEl.style.transform = 'translate3d(0, 0, 0)'
                    }
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

        const curlVisuals = (mode === 'curl') ? (this.adapter?.getVisuals?.(direction) || {}) : {}
        if (mode === 'curl' && curlVisuals.currentCanvas && this._curlSimulator && this._curlCanvas) {
            const currentProgress = Math.min(1, Math.max(0, Math.abs(deltaX) / width))
            const curGen = ++this.generation
            this.state = 'settling'

            const canTurn = direction === 'next' ? this.adapter?.canTurnNext() : this.adapter?.canTurnPrev()

            if (shouldTurn && canTurn) {
                // Smoothly finish turning (progress -> 1.0)
                const startTime = performance.now()
                const dur = Math.max(120, (1 - currentProgress) * this.animationDuration)

                await new Promise((resolve) => {
                    const animateCommit = (now) => {
                        if (curGen !== this.generation) {
                            resolve()
                            return
                        }
                        const elapsed = now - startTime
                        const t = Math.min(1, elapsed / dur)
                        const easeOut = 1 - Math.pow(1 - t, 2)
                        const p = currentProgress + (1 - currentProgress) * easeOut

                        const visuals = this.adapter?.getVisuals?.(direction) || {}
                        if (this._curlSimulator) {
                            this._curlSimulator.renderCurl({
                                width,
                                height,
                                progress: p,
                                direction,
                                currentTexture: visuals.currentCanvas,
                                nextTexture: visuals.nextCanvas,
                                bgColor: visuals.bgColor,
                                textColor: visuals.textColor
                            })
                        }

                        if (t < 1 && curGen === this.generation) {
                            safeRaf(animateCommit)
                        } else {
                            resolve()
                        }
                    }
                    safeRaf(animateCommit)
                })

                // Atomically commit page turn upon reaching 1.0
                if (curGen === this.generation) {
                    await (direction === 'next' ? this.adapter.turnNext() : this.adapter.turnPrev())
                }
            } else {
                // Dynamic roll-back to 0
                const startTime = performance.now()
                const dur = Math.max(100, currentProgress * this.animationDuration * 0.8)

                await new Promise((resolve) => {
                    const animateRollback = (now) => {
                        if (curGen !== this.generation) {
                            resolve()
                            return
                        }
                        const elapsed = now - startTime
                        const t = Math.min(1, elapsed / dur)
                        const easeOut = 1 - Math.pow(1 - t, 2)
                        const p = currentProgress * (1 - easeOut)

                        const visuals = this.adapter?.getVisuals?.() || {}
                        if (this._curlSimulator) {
                            this._curlSimulator.renderCurl({
                                width,
                                height,
                                progress: p,
                                direction,
                                currentTexture: visuals.currentCanvas,
                                bgColor: visuals.bgColor,
                                textColor: visuals.textColor
                            })
                        }

                        if (t < 1 && curGen === this.generation) {
                            safeRaf(animateRollback)
                        } else {
                            resolve()
                        }
                    }
                    safeRaf(animateRollback)
                })
            }

            this.cancelCurrent()
            return
        }

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
