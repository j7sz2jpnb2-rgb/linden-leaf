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

    getVisuals() {
        // Retrieve current page canvas if available
        const curPage = this.getCurrentPage()
        const curCanvas = this.viewport?.renderedCanvases?.get?.(curPage) || null
        return {
            currentCanvas: curCanvas,
            nextCanvas: null,
            bgColor: '#ffffff'
        }
    }
}

/**
 * Lightweight 2D Canvas Paper Curl Renderer
 * Computes curved page geometry, dynamic soft shadows, and light reflection
 */
export class CurlSimulator {
    constructor(canvas) {
        this.canvas = canvas
        this.ctx = canvas?.getContext('2d') || null
    }

    renderCurl({ width, height, progress, direction = 'next', bgColor = '#fbf0d9', textColor = '#2b2b2b' }) {
        if (!this.ctx || width <= 0 || height <= 0) return
        const ctx = this.ctx
        ctx.clearRect(0, 0, width, height)

        const clampedProgress = Math.min(1, Math.max(0, progress))
        if (clampedProgress <= 0 || clampedProgress >= 1) return

        const isNext = direction === 'next'
        // Curl origin and fold point
        const curlWidth = width * (1 - clampedProgress)
        const foldX = isNext ? curlWidth : width * clampedProgress
        const foldAngle = Math.PI / 18

        ctx.save()

        // 1. Transparent page base: keep underlying reader page content visible, only overlaying the curled flap & shadows
        // (Do not draw an opaque solid rect over the whole screen)

        // 2. Draw soft drop shadow under the curled flap
        const shadowWidth = Math.min(80, width * 0.15)
        const shadowGrad = isNext
            ? ctx.createLinearGradient(foldX - shadowWidth, 0, foldX, 0)
            : ctx.createLinearGradient(foldX, 0, foldX + shadowWidth, 0)

        if (isNext) {
            shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
            shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
            ctx.fillStyle = shadowGrad
            ctx.fillRect(foldX - shadowWidth, 0, shadowWidth, height)
        } else {
            shadowGrad.addColorStop(0, 'rgba(0, 0, 0, 0.28)')
            shadowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')
            ctx.fillStyle = shadowGrad
            ctx.fillRect(foldX, 0, shadowWidth, height)
        }

        // 3. Draw curved fold flap (Paper reverse side)
        const flapWidth = Math.min(width - foldX, foldX) * 0.6
        ctx.beginPath()
        if (isNext) {
            ctx.moveTo(foldX, 0)
            ctx.quadraticCurveTo(foldX + flapWidth * 0.4, height * 0.5, foldX, height)
            ctx.lineTo(width, height)
            ctx.lineTo(width, 0)
        } else {
            ctx.moveTo(foldX, 0)
            ctx.quadraticCurveTo(foldX - flapWidth * 0.4, height * 0.5, foldX, height)
            ctx.lineTo(0, height)
            ctx.lineTo(0, 0)
        }
        ctx.closePath()

        // Reverse side color: slightly darker/warmer tint to simulate paper texture
        const paperBackGrad = ctx.createLinearGradient(foldX, 0, isNext ? foldX + flapWidth : foldX - flapWidth, 0)
        paperBackGrad.addColorStop(0, 'rgba(235, 225, 205, 0.95)')
        paperBackGrad.addColorStop(0.5, 'rgba(248, 243, 230, 0.98)')
        paperBackGrad.addColorStop(1, 'rgba(220, 210, 190, 0.9)')
        ctx.fillStyle = paperBackGrad
        ctx.fill()

        // 4. Subtle spine & ridge highlight along fold line
        ctx.beginPath()
        ctx.moveTo(foldX, 0)
        ctx.quadraticCurveTo(isNext ? foldX + flapWidth * 0.4 : foldX - flapWidth * 0.4, height * 0.5, foldX, height)
        ctx.lineWidth = 2
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
        ctx.stroke()

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
        if (this.prefersReducedMotion) return 'none'
        if (this.adapter?.isContinuousScroll?.()) return 'scroll'
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
        this.isGestureActive = false

        if (this._overlayEl) {
            this._overlayEl.style.display = 'none'
            this._overlayEl.innerHTML = ''
        }

        const viewEl = this.adapter?.getViewElement?.()
        if (viewEl) {
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
                if (!this._curlCanvas) {
                    this._curlCanvas = document.createElement('canvas')
                    this._curlCanvas.className = 'page-turn-curl-canvas'
                    this._curlSimulator = new CurlSimulator(this._curlCanvas)
                }

                this._curlCanvas.width = width
                this._curlCanvas.height = height
                this._curlCanvas.style.cssText = 'position: absolute; inset: 0; pointer-events: none;'

                if (this._overlayEl) {
                    this._overlayEl.innerHTML = ''
                    this._overlayEl.appendChild(this._curlCanvas)
                    this._overlayEl.style.display = 'block'
                }

                const startTime = performance.now()
                const dur = this.animationDuration * 1.2
                let pageTurnCommitted = false
                let turnPromise = null

                await new Promise((resolve) => {
                    const animateCurl = (now) => {
                        if (curGen !== this.generation) {
                            resolve()
                            return
                        }
                        const elapsed = now - startTime
                        const progress = Math.min(1, elapsed / dur)

                        this._curlSimulator.renderCurl({
                            width,
                            height,
                            progress,
                            direction
                        })

                        // Trigger page turn halfway through curl without stalling the animation loop
                        if (progress >= 0.5 && !pageTurnCommitted) {
                            pageTurnCommitted = true
                            turnPromise = (isNext ? this.adapter.turnNext() : this.adapter.turnPrev()).catch(() => {})
                        }

                        if (progress < 1 && curGen === this.generation) {
                            requestAnimationFrame(animateCurl)
                        } else {
                            resolve()
                        }
                    }
                    requestAnimationFrame(animateCurl)
                })

                if (turnPromise) {
                    await turnPromise
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
        this.touchStart = {
            x: touch.clientX,
            y: touch.clientY,
            time: Date.now()
        }
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
        const deltaX = touch.clientX - this.touchStart.x
        const deltaY = touch.clientY - this.touchStart.y

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
        const elapsed = Date.now() - (this.touchStart.time || Date.now())
        const velocity = Math.abs(deltaX) / Math.max(1, elapsed)
        const width = this.container?.clientWidth || 800

        const shouldTurn = Math.abs(deltaX) > width * 0.18 || (velocity > 0.35 && Math.abs(deltaX) > 40)
        const direction = deltaX < 0 ? 'next' : 'prev'

        this.touchStart = null
        this.currentDrag = null
        this.isGestureActive = false

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
