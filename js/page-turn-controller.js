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
export const FEATURE_CURL_PAGE_TURN_ENABLED = false

const safeRaf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(() => cb(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)

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

    captureCurrentPageCanvas(bgColor, textColor) {
        if (typeof document === 'undefined') return null
        const viewEl = this.getViewElement()
        if (!viewEl) return null

        const width = viewEl.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800)
        const height = viewEl.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1200)
        if (width <= 0 || height <= 0) return null

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return null

        // 1. Fill base paper background
        ctx.fillStyle = bgColor
        ctx.fillRect(0, 0, width, height)

        // 2. Extract DOM contents from active chapter iframe
        const contents = (typeof this.view?.renderer?.getContents === 'function')
            ? this.view.renderer.getContents()
            : []
        const doc = contents?.[0]?.doc
        if (!doc || !doc.body) return canvas

        try {
            ctx.save()
            const elements = doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, span, blockquote, img, li')
            for (const el of elements) {
                // If it has children other than text or img, let child elements render instead
                if (el.tagName !== 'IMG' && el.children && el.children.length > 0) continue

                const rect = el.getBoundingClientRect()
                if (rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) {
                    continue
                }

                if (el.tagName === 'IMG') {
                    try {
                        ctx.drawImage(el, rect.left, rect.top, rect.width, rect.height)
                    } catch (_) {}
                    continue
                }

                const text = el.textContent?.trim()
                if (!text) continue

                const style = doc.defaultView?.getComputedStyle(el)
                const fontSize = parseFloat(style?.fontSize) || 18
                const fontFamily = style?.fontFamily || 'serif'
                const fontWeight = style?.fontWeight || 'normal'
                const color = (style?.color && style.color !== 'rgba(0, 0, 0, 0)') ? style.color : textColor

                ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
                ctx.fillStyle = color
                ctx.textBaseline = 'top'

                const x = Math.max(0, rect.left)
                const y = Math.max(0, rect.top)
                const maxWidth = Math.max(10, Math.min(width - x, rect.width || width))
                ctx.fillText(text, x, y, maxWidth)
            }
            ctx.restore()
        } catch (_) {}

        return canvas
    }

    getVisuals(direction = 'next') {
        const bgColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-bg') || getComputedStyle(document.documentElement).getPropertyValue('--book-bg'))) || '#FAF9F5'
        const textColor = (typeof document !== 'undefined' && (document.documentElement?.style?.getPropertyValue('--book-color') || getComputedStyle(document.documentElement).getPropertyValue('--book-color'))) || '#141413'
        
        if (!this._cachedCanvas) {
            this._cachedCanvas = this.captureCurrentPageCanvas(bgColor, textColor)
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

    getVisuals(direction = 'next') {
        // Retrieve current and target page canvases for realistic curl projection
        const curPage = this.getCurrentPage()
        const curCanvas = this.viewport?.renderedCanvases?.get?.(curPage) || null
        const targetPage = direction === 'next' ? curPage + 1 : curPage - 1
        const nextCanvas = this.viewport?.renderedCanvases?.get?.(targetPage) || null
        return {
            currentCanvas: curCanvas,
            nextCanvas: nextCanvas,
            bgColor: '#ffffff',
            textColor: '#141413'
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
        // Fold progress from 1 to 0 (next) or 0 to 1 (prev)
        const foldProgress = isNext ? (1 - clampedProgress) : clampedProgress
        const foldX = width * foldProgress

        // Radius R smoothly scales with progress for natural paper elasticity
        const R = Math.max(16, Math.min(width * 0.14, 50 * Math.sin(clampedProgress * Math.PI) + 14))

        // Tilt angle from touch position
        const targetY = touchY != null ? Math.max(height * 0.1, Math.min(height * 0.9, touchY)) : height * 0.5
        const tiltAngle = ((targetY - height * 0.5) / height) * 0.3 * (1 - clampedProgress)

        // Normal n (pointing toward the curled side) and Tangent t
        const nx = isNext ? Math.cos(tiltAngle) : -Math.cos(tiltAngle)
        const ny = Math.sin(tiltAngle)
        const n = { x: nx, y: ny }
        const t = { x: -ny, y: nx }
        const o = { x: foldX, y: targetY }

        ctx.save()

        // 1. LAYER 1: Stationary Underlying Target Page (Revealed under curl)
        if (nextTexture) {
            try {
                ctx.drawImage(nextTexture, 0, 0, width, height)
            } catch (_) {}
        }

        // 2. LAYER 2: Soft Drop Shadow cast onto the stationary underlying page
        const shadowWidth = Math.min(120, Math.max(36, R * 2.4))
        ctx.save()
        const shadowGrad = isNext
            ? ctx.createLinearGradient(foldX - shadowWidth, 0, foldX, 0)
            : ctx.createLinearGradient(foldX, 0, foldX + shadowWidth, 0)

        if (isNext) {
            shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
            shadowGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.14)')
            shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0.38)')
            ctx.fillStyle = shadowGrad
            ctx.fillRect(Math.max(0, foldX - shadowWidth), 0, shadowWidth, height)
        } else {
            shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.38)')
            shadowGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.14)')
            shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
            ctx.fillStyle = shadowGrad
            ctx.fillRect(foldX, 0, Math.min(width - foldX, shadowWidth), height)
        }
        ctx.restore()

        // 3. LAYER 3: Flat Uncurled portion of current page (s <= 0)
        ctx.save()
        ctx.beginPath()
        if (isNext) {
            ctx.rect(0, 0, foldX, height)
        } else {
            ctx.rect(foldX, 0, width - foldX, height)
        }
        ctx.clip()

        if (currentTexture) {
            try {
                ctx.drawImage(currentTexture, 0, 0, width, height)
            } catch (_) {}
        } else {
            ctx.fillStyle = bgColor
            ctx.fillRect(0, 0, width, height)
            // Subtle book spine shadow on the binding side
            const spineGrad = ctx.createLinearGradient(isNext ? 0 : width, 0, isNext ? 32 : width - 32, 0)
            spineGrad.addColorStop(0, 'rgba(0, 0, 0, 0.15)')
            spineGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
            ctx.fillStyle = spineGrad
            ctx.fillRect(isNext ? 0 : width - 32, 0, 32, height)
        }
        ctx.restore()

        // 4. LAYER 4: Curled Cylinder & Paper Backside Flap
        // Compute cylindrical roll path
        const flapWidth = Math.min(width - foldX, foldX) * 0.72 + R * 1.5
        const drawFlapPath = () => {
            ctx.beginPath()
            if (isNext) {
                ctx.moveTo(foldX, 0)
                ctx.quadraticCurveTo(foldX + flapWidth * 0.45, targetY, foldX, height)
                ctx.lineTo(width, height)
                ctx.lineTo(width, 0)
            } else {
                ctx.moveTo(foldX, 0)
                ctx.quadraticCurveTo(foldX - flapWidth * 0.45, targetY, foldX, height)
                ctx.lineTo(0, height)
                ctx.lineTo(0, 0)
            }
            ctx.closePath()
        }

        ctx.save()
        drawFlapPath()
        ctx.clip()

        // If current texture exists, render mirrored text show-through on paper back
        if (currentTexture) {
            try {
                ctx.save()
                ctx.translate(foldX * 2, 0)
                ctx.scale(-1, 1)
                ctx.globalAlpha = 0.12 // Subtle authentic paper show-through
                ctx.drawImage(currentTexture, 0, 0, width, height)
                ctx.restore()
            } catch (_) {}
        }

        // Paper Backside Gradient Shading (Cylindrical roll illumination)
        const paperBackGrad = ctx.createLinearGradient(foldX, 0, isNext ? foldX + flapWidth : foldX - flapWidth, 0)
        paperBackGrad.addColorStop(0, 'rgba(235, 228, 215, 0.96)')
        paperBackGrad.addColorStop(0.2, 'rgba(255, 255, 255, 0.98)')
        paperBackGrad.addColorStop(0.55, 'rgba(240, 233, 218, 0.95)')
        paperBackGrad.addColorStop(1, 'rgba(215, 205, 185, 0.92)')

        drawFlapPath()
        ctx.fillStyle = paperBackGrad
        ctx.fill()

        // Cylindrical inner shadow inside the roll
        const rollShadowGrad = isNext
            ? ctx.createLinearGradient(foldX, 0, foldX + R * 1.8, 0)
            : ctx.createLinearGradient(foldX, 0, foldX - R * 1.8, 0)
        rollShadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.28)')
        rollShadowGrad.addColorStop(0.45, 'rgba(0, 0, 0, 0.08)')
        rollShadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
        drawFlapPath()
        ctx.fillStyle = rollShadowGrad
        ctx.fill()

        ctx.restore() // restore flap clip

        // 5. Specular Crest Highlight along the cylindrical ridge (z = R)
        ctx.save()
        ctx.beginPath()
        if (isNext) {
            ctx.moveTo(foldX + 1, 0)
            ctx.quadraticCurveTo(foldX + flapWidth * 0.45, targetY, foldX + 1, height)
        } else {
            ctx.moveTo(foldX - 1, 0)
            ctx.quadraticCurveTo(foldX - flapWidth * 0.45, targetY, foldX - 1, height)
        }
        ctx.lineWidth = Math.max(1.5, R * 0.07)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)'
        ctx.stroke()
        ctx.restore()

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
            this.container.style.position = 'relative'
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
                // Cover Page Peel Animation with themed sheet & edge shadow
                if (this._overlayEl) {
                    const bg = (typeof document !== 'undefined' && document.documentElement?.style?.backgroundColor) || '#FAF9F5'
                    this._overlayEl.style.display = 'block'
                    this._overlayEl.innerHTML = `
                        <div class="cover-peel-sheet" style="
                            position: absolute;
                            inset: 0;
                            background: ${bg};
                            box-shadow: ${isNext ? '-12px 0 28px rgba(0,0,0,0.18)' : '12px 0 28px rgba(0,0,0,0.18)'};
                            transform: translate3d(0, 0, 0);
                            transition: transform ${this.animationDuration}ms cubic-bezier(0.25, 1, 0.5, 1);
                        "></div>
                    `
                    const sheet = this._overlayEl.querySelector('.cover-peel-sheet')
                    sheet.offsetHeight // reflow
                    sheet.style.transform = `translate3d(${isNext ? -width : width}px, 0, 0)`
                }

                await (isNext ? this.adapter.turnNext() : this.adapter.turnPrev())
                await new Promise(r => setTimeout(r, this.animationDuration))

            } else if (mode === 'curl') {
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
            if (mode === 'slide') {
                const viewEl = this.adapter?.getViewElement?.()
                if (viewEl) {
                    viewEl.style.transition = 'none'
                    viewEl.style.transform = `translate3d(${deltaX * 0.4}px, 0, 0)`
                }
            } else if (mode === 'curl') {
                const direction = deltaX < 0 ? 'next' : 'prev'
                const canTurn = direction === 'next' ? this.adapter?.canTurnNext() : this.adapter?.canTurnPrev()
                if (canTurn) {
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
                        viewEl.style.transform = `translate3d(${deltaX * 0.06}px, 0, 0)`
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

        if (mode === 'curl' && this._curlSimulator && this._curlCanvas) {
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
