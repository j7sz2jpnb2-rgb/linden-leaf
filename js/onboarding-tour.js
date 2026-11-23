import { DomEvents } from './dom-events.js'
import { escapeHTML } from './ui-format.js'
import { t } from './i18n.js'

export const ONBOARDING_TOUR_STORAGE_KEY = 'linden_tour_completed'

export const ONBOARDING_STEPS = [
    {
        id: 'library-import',
        get eyebrow() { return t('tour.step1.eyebrow') },
        get title() { return t('tour.step1.title') },
        get body() { return t('tour.step1.body') },
        targetSelectors: ['#btn-import', '#btn-link-folder'],
        spotlightPad: { top: 6, right: 8, bottom: 6, left: 8 },
        requiresExpandedSidebar: false,
        placement: 'bottom'
    },
    {
        id: 'shelf-sidebar',
        get eyebrow() { return t('tour.step2.eyebrow') },
        get title() { return t('tour.step2.title') },
        get body() { return t('tour.step2.body') },
        targetSelectors: ['#sidebar-custom-lists-group', '#nav-cat-notes', '#nav-cat-stats', '#nav-cat-ai-history'],
        spotlightPad: { top: 6, right: 8, bottom: 6, left: 8 },
        requiresExpandedSidebar: true,
        placement: 'right'
    },
    {
        id: 'reader-tools',
        get eyebrow() { return t('tour.step3.eyebrow') },
        get title() { return t('tour.step3.title') },
        get body() { return t('tour.step3.body') },
        highlights: [
            { get label() { return t('tour.step3.feature1Label') }, get desc() { return t('tour.step3.feature1Desc') } },
            { get label() { return t('tour.step3.feature2Label') }, get desc() { return t('tour.step3.feature2Desc') } },
            { get label() { return t('tour.step3.feature3Label') }, get desc() { return t('tour.step3.feature3Desc') } }
        ],
        targetSelectors: null,
        requiresExpandedSidebar: false,
        placement: 'center'
    },
    {
        id: 'settings-and-safety',
        get eyebrow() { return t('tour.step4.eyebrow') },
        get title() { return t('tour.step4.title') },
        get body() { return t('tour.step4.body') },
        targetSelectors: ['#sidebar-user-section'],
        spotlightPad: { top: 4, right: 6, bottom: 4, left: 6 },
        requiresExpandedSidebar: true,
        placement: 'right-end'
    }
]

/** Owns the lightweight skippable desktop/adaptive onboarding tour overlay. */
export class OnboardingTourController {
    constructor(app, steps = ONBOARDING_STEPS) {
        this.app = app
        this.steps = steps
        this.events = new DomEvents()
        this._tourKeyEvents = new DomEvents()
        this.dom = {}
        this.active = false
        this.stepIndex = 0
        this._savedSidebarCollapsed = null
        this._previousFocus = null
        this._repositionTimer = null
        this._closeTimer = null
    }

    initDOM() {
        this.dom = {
            root: document.getElementById('onboarding-tour-root'),
            backdrop: document.getElementById('onboarding-tour-backdrop'),
            spotlightExit: document.getElementById('onboarding-tour-spotlight-exit'),
            spotlight: document.getElementById('onboarding-tour-spotlight'),
            maskHolePrev: document.getElementById('tour-mask-hole-prev'),
            maskHoleCurr: document.getElementById('tour-mask-hole-curr'),
            card: document.getElementById('onboarding-tour-card'),
            arrow: document.getElementById('tour-card-arrow'),
            eyebrow: document.getElementById('tour-step-eyebrow'),
            stepCount: document.getElementById('tour-step-count'),
            title: document.getElementById('tour-step-title'),
            body: document.getElementById('tour-step-body'),
            highlights: document.getElementById('tour-step-highlights'),
            dots: document.getElementById('tour-step-dots'),
            btnSkip: document.getElementById('btn-tour-skip'),
            btnClose: document.getElementById('btn-tour-close'),
            btnPrev: document.getElementById('btn-tour-prev'),
            btnNext: document.getElementById('btn-tour-next')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true
        this.events.on(this.dom.btnSkip, 'click', () => this.skip())
        this.events.on(this.dom.btnClose, 'click', () => this.skip())
        this.events.on(this.dom.btnPrev, 'click', () => this.prev())
        this.events.on(this.dom.btnNext, 'click', () => this.next())
        this.events.on(this.dom.backdrop, 'click', () => this.skip())
        this.events.on(this.dom.dots, 'click', (e) => {
            const btn = e.target?.closest?.('[data-tour-step]')
            if (!btn) return
            const targetIdx = Number(btn.dataset.tourStep)
            if (Number.isInteger(targetIdx)) this.goTo(targetIdx)
        })
    }

    shouldAutoStart() {
        try {
            return localStorage.getItem(ONBOARDING_TOUR_STORAGE_KEY) !== 'true'
        } catch {
            return false
        }
    }

    markCompleted() {
        try {
            localStorage.setItem(ONBOARDING_TOUR_STORAGE_KEY, 'true')
        } catch {}
    }

    start({ force = false, startIndex = 0 } = {}) {
        if (!this.dom.root) this.initDOM()
        if (!this.dom.root) return false
        this.bindEvents()
        if (!force && !this.shouldAutoStart()) return false
        if (this._closeTimer) {
            clearTimeout(this._closeTimer)
            this._closeTimer = null
        }

        const bookshelfView = document.getElementById('bookshelf-view')
        if (!this.active) {
            this._previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
            this._savedSidebarCollapsed = bookshelfView ? bookshelfView.classList.contains('sidebar-collapsed') : true
        }
        this.active = true
        this.stepIndex = Math.max(0, Math.min(this.steps.length - 1, startIndex))

        this._tourKeyEvents.dispose()
        this._tourKeyEvents.on(window, 'keydown', (e) => this._handleKeydown(e), true)
        this._tourKeyEvents.on(window, 'resize', () => this._positionCurrentStep({ instant: true }))
        const sidebarEl = document.querySelector('#bookshelf-view .leaf-sidebar')
        if (sidebarEl) {
            this._tourKeyEvents.on(sidebarEl, 'transitionend', (e) => {
                if (this.active && (!e.propertyName || e.propertyName === 'width' || e.propertyName === 'margin-left' || e.propertyName === 'transform')) {
                    this._positionCurrentStep({ silent: true })
                }
            })
        }

        this._activeSpotRect = null
        this._resetSpotlightArtifacts()

        this.dom.root.classList.remove('show')
        this.dom.root.hidden = false
        this.dom.root.style.display = 'block'
        if (this.dom.card) this.dom.card.style.transition = 'none'
        if (this.dom.spotlight) {
            this.dom.spotlight.style.transition = 'none'
            this.dom.spotlight.classList.remove('has-target', 'is-delayed-reveal')
        }
        this.goTo(this.stepIndex, { instant: true })
        const shouldOpenSpotWithLockOn = Boolean(this._activeSpotRect && this.dom.spotlight)
        if (shouldOpenSpotWithLockOn) {
            this.dom.spotlight.style.transition = 'none'
            this.dom.spotlight.classList.remove('has-target', 'is-delayed-reveal')
        }
        void this.dom.card?.offsetWidth
        void this.dom.spotlight?.offsetWidth

        requestAnimationFrame(() => {
            if (!this.active) return
            if (this.dom.card) this.dom.card.style.transition = ''
            if (this.dom.spotlight) this.dom.spotlight.style.transition = ''
            this.dom.root?.classList.add('show')
            if (shouldOpenSpotWithLockOn) {
                this.dom.spotlight?.classList.add('has-target')
            }
            this.dom.card?.focus({ preventScroll: true })
        })

        return true
    }

    goTo(index, { instant = false } = {}) {
        if (!this.active || !this.steps.length) return
        const bounded = Math.max(0, Math.min(this.steps.length - 1, index))
        this.stepIndex = bounded
        const step = this.steps[bounded]

        this._syncSidebarForStep(step)
        this._renderStepContent(step, bounded, { animateContent: !instant })
        this._positionCurrentStep({ instant })

        if (this._repositionTimer) clearTimeout(this._repositionTimer)
        this._repositionTimer = setTimeout(() => {
            if (this.active) this._positionCurrentStep({ silent: true })
        }, 290)
    }

    next() {
        if (!this.active) return
        if (this.stepIndex >= this.steps.length - 1) {
            this.finish()
            return
        }
        this.goTo(this.stepIndex + 1)
    }

    prev() {
        if (!this.active || this.stepIndex <= 0) return
        this.goTo(this.stepIndex - 1)
    }

    skip() {
        if (!this.active) return
        this.markCompleted()
        this._teardown()
    }

    finish() {
        if (!this.active) return
        this.markCompleted()
        this._teardown()
    }

    _handleKeydown(e) {
        if (!this.active) return
        const topDialogOpen = [...document.querySelectorAll('.global-modal-backdrop.show')]
            .some((el) => getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).zIndex || 0) >= 100050)
        if (topDialogOpen) return

        if (e.key === 'Tab' && this.dom.card) {
            const focusables = [...this.dom.card.querySelectorAll('button:not([hidden]):not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
                .filter((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
            if (focusables.length > 0) {
                const first = focusables[0]
                const last = focusables[focusables.length - 1]
                const active = document.activeElement
                if (e.shiftKey) {
                    if (active === first || active === this.dom.card || !this.dom.card.contains(active)) {
                        e.preventDefault()
                        e.stopPropagation()
                        last.focus()
                    }
                } else if (active === last || !this.dom.card.contains(active)) {
                    e.preventDefault()
                    e.stopPropagation()
                    first.focus()
                }
            }
            return
        }

        if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            this.skip()
        } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            this.next()
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            e.stopPropagation()
            this.prev()
        }
    }

    _syncSidebarForStep(step) {
        const bookshelfView = document.getElementById('bookshelf-view')
        if (!bookshelfView || getComputedStyle(bookshelfView).display === 'none') return
        if (window.innerWidth < 768) return
        const shouldCollapse = !step.requiresExpandedSidebar
        bookshelfView.classList.toggle('sidebar-collapsed', shouldCollapse)
        if (this.app?.bookshelf) {
            this.app.bookshelf.sidebarUserCollapsed = shouldCollapse
        }
    }

    _renderStepContent(step, idx, { animateContent = true } = {}) {
        const total = this.steps.length
        if (this.dom.eyebrow) this.dom.eyebrow.textContent = step.eyebrow || ''
        if (this.dom.stepCount) this.dom.stepCount.textContent = `${idx + 1} / ${total}`
        if (this.dom.title) this.dom.title.textContent = step.title || ''
        if (this.dom.body) {
            this.dom.body.textContent = step.body || ''
            this.dom.body.hidden = !step.body
        }
        if (this.dom.highlights) {
            if (Array.isArray(step.highlights) && step.highlights.length > 0) {
                this.dom.highlights.hidden = false
                this.dom.highlights.innerHTML = step.highlights.map((item) => `
                    <li class="tour-highlight-item">
                        <span class="tour-highlight-label">${escapeHTML(item.label)}</span>
                        <span class="tour-highlight-desc">${escapeHTML(item.desc)}</span>
                    </li>
                `).join('')
            } else {
                this.dom.highlights.hidden = true
                this.dom.highlights.innerHTML = ''
            }
        }
        if (this.dom.dots) {
            this.dom.dots.innerHTML = this.steps.map((_, i) =>
                `<button type="button" class="tour-dot${i === idx ? ' active' : ''}" data-tour-step="${i}" aria-label="${escapeHTML(t('tour.dotAria', { step: i + 1 }))}" aria-current="${i === idx ? 'step' : 'false'}"></button>`
            ).join('')
        }
        if (this.dom.btnPrev) {
            this.dom.btnPrev.hidden = idx === 0
        }
        if (this.dom.btnNext) {
            this.dom.btnNext.textContent = idx >= total - 1 ? t('tour.finish') : t('tour.next')
        }
        if (this.dom.card) {
            this.dom.card.classList.remove('is-step-entering')
            if (animateContent) {
                void this.dom.card.offsetWidth
                this.dom.card.classList.add('is-step-entering')
            }
        }
    }

    refreshLocale() {
        if (!this.active) return
        const step = this.steps[this.stepIndex]
        if (!step) return
        this._renderStepContent(step, this.stepIndex, { animateContent: false })
        this._positionCurrentStep({ instant: true, silent: true })
    }

    _resolveVisibleTargetRect(selectors, step = null) {
        if (!Array.isArray(selectors) || selectors.length === 0) return null
        const bookshelfView = document.getElementById('bookshelf-view')
        if (!bookshelfView || getComputedStyle(bookshelfView).display === 'none') return null

        const vw = window.innerWidth
        const vh = window.innerHeight
        const sidebarEl = bookshelfView.querySelector('.leaf-sidebar')
        let settledSidebarShiftX = 0
        if (step?.requiresExpandedSidebar && vw >= 768 && sidebarEl && !bookshelfView.classList.contains('sidebar-collapsed')) {
            const viewRect = bookshelfView.getBoundingClientRect()
            const sbRect = sidebarEl.getBoundingClientRect()
            settledSidebarShiftX = viewRect.left - sbRect.left
            if (!Number.isFinite(settledSidebarShiftX)) settledSidebarShiftX = 0
        }

        const rects = []
        let sidebarSliding = false
        for (const selector of selectors) {
            const el = document.querySelector(selector)
            if (!el) continue
            const style = getComputedStyle(el)
            if (style.display === 'none') continue
            const inExpandingSidebar = Boolean(step?.requiresExpandedSidebar && sidebarEl && sidebarEl.contains(el) && !bookshelfView.classList.contains('sidebar-collapsed'))
            if (!inExpandingSidebar && style.visibility === 'hidden') continue
            const rawRect = el.getBoundingClientRect()
            if (rawRect.width <= 0 || rawRect.height <= 0) continue
            const shiftX = inExpandingSidebar ? settledSidebarShiftX : 0
            if (Math.abs(shiftX) > 24) sidebarSliding = true
            const left = rawRect.left + shiftX
            const right = rawRect.right + shiftX
            if (right <= 0 || left >= vw || rawRect.bottom <= 0 || rawRect.top >= vh) continue
            rects.push({ left, top: rawRect.top, right, bottom: rawRect.bottom })
        }
        if (!rects.length) return null

        const left = Math.min(...rects.map((r) => r.left))
        const top = Math.min(...rects.map((r) => r.top))
        const right = Math.max(...rects.map((r) => r.right))
        const bottom = Math.max(...rects.map((r) => r.bottom))
        return { left, top, right, bottom, width: right - left, height: bottom - top, sidebarSliding }
    }

    _positionCurrentStep({ instant = false, silent = false } = {}) {
        const card = this.dom.card
        const spotlight = this.dom.spotlight
        const backdrop = this.dom.backdrop
        const maskHoleCurr = this.dom.maskHoleCurr
        const arrow = this.dom.arrow
        if (!card || !spotlight || !backdrop) return

        const step = this.steps[this.stepIndex]
        const rect = this._resolveVisibleTargetRect(step?.targetSelectors, step)
        const vw = window.innerWidth
        const vh = window.innerHeight
        const margin = 16
        const gap = 12
        const rootStyle = getComputedStyle(document.documentElement)
        const safeTop = parseFloat(rootStyle.getPropertyValue('--safe-top')) || 0
        const safeBottom = parseFloat(rootStyle.getPropertyValue('--safe-bottom')) || 0
        const safeLeft = parseFloat(rootStyle.getPropertyValue('--safe-left')) || 0
        const safeRight = parseFloat(rootStyle.getPropertyValue('--safe-right')) || 0
        const minX = margin + safeLeft
        const minY = margin + safeTop
        const useSpotlight = Boolean(rect && vw >= 768)
        const hadTarget = spotlight.classList.contains('has-target')

        card.classList.toggle('is-centered', !useSpotlight)
        card.style.display = 'flex'
        card.style.visibility = 'visible'

        const cw = card.offsetWidth || (useSpotlight ? 388 : 444)
        const ch = card.offsetHeight || 230
        const maxX = Math.max(minX, vw - cw - margin - safeRight)
        const maxY = Math.max(minY, vh - ch - margin - safeBottom)

        let cx = safeLeft + (vw - safeLeft - safeRight - cw) / 2
        let cy = safeTop + (vh - safeTop - safeBottom - ch) / 2

        if (useSpotlight) {
            const rawPad = step?.spotlightPad
            const padTop = typeof rawPad === 'number' ? rawPad : (rawPad?.top ?? 8)
            const padRight = typeof rawPad === 'number' ? rawPad : (rawPad?.right ?? 8)
            const padBottom = typeof rawPad === 'number' ? rawPad : (rawPad?.bottom ?? 8)
            const padLeft = typeof rawPad === 'number' ? rawPad : (rawPad?.left ?? 8)
            const sx = Math.max(4, rect.left - padLeft)
            const sy = Math.max(4, rect.top - padTop)
            const sw = Math.min(vw - sx - 4, rect.width + padLeft + padRight)
            const sh = Math.min(vh - sy - 4, rect.height + padTop + padBottom)
            const nextBox = {
                left: Math.round(sx),
                top: Math.round(sy),
                width: Math.round(sw),
                height: Math.round(sh)
            }
            const targetChanged = !this._sameSpotBox(this._activeSpotRect, nextBox)

            if (instant) {
                this._resetSpotlightArtifacts({ keepCurr: true })
                if (maskHoleCurr) {
                    maskHoleCurr.style.transition = 'none'
                    maskHoleCurr.classList.remove('is-delayed-reveal')
                    this._setSvgBox(maskHoleCurr, nextBox)
                    maskHoleCurr.classList.add('is-open')
                    void window.getComputedStyle(maskHoleCurr).opacity
                    maskHoleCurr.style.transition = ''
                }
                spotlight.style.transition = 'none'
                spotlight.classList.remove('is-delayed-reveal')
                this._applyBoxStyle(spotlight, nextBox)
                spotlight.classList.add('has-target')
                void spotlight.offsetWidth
                spotlight.style.transition = ''
            } else if (silent) {
                if (targetChanged) {
                    if (maskHoleCurr) this._setSvgBox(maskHoleCurr, nextBox)
                    this._applyBoxStyle(spotlight, nextBox)
                    spotlight.classList.add('has-target')
                }
            } else if (targetChanged || !hadTarget) {
                if (this._activeSpotRect) {
                    this._triggerExitSpotlight(this._activeSpotRect)
                }
                if (maskHoleCurr) {
                    maskHoleCurr.style.transition = 'none'
                    maskHoleCurr.classList.remove('is-open', 'is-delayed-reveal')
                    this._setSvgBox(maskHoleCurr, nextBox)
                    void window.getComputedStyle(maskHoleCurr).opacity
                    maskHoleCurr.style.transition = ''
                    if (rect.sidebarSliding) {
                        maskHoleCurr.classList.add('is-delayed-reveal')
                    }
                    maskHoleCurr.classList.add('is-open')
                }
                spotlight.style.transition = 'none'
                spotlight.classList.remove('has-target', 'is-delayed-reveal')
                this._applyBoxStyle(spotlight, nextBox)
                void spotlight.offsetWidth
                spotlight.style.transition = ''
                if (rect.sidebarSliding) {
                    spotlight.classList.add('is-delayed-reveal')
                }
                spotlight.classList.add('has-target')
            } else {
                spotlight.classList.add('has-target')
            }

            this._activeSpotRect = nextBox
            backdrop.classList.add('spotlight-active')

            let arrowSide = 'left'
            if (step.placement === 'bottom' || step.placement === 'bottom-end') {
                cx = step.placement === 'bottom' ? (sx + sw / 2 - cw / 2) : (rect.right - cw)
                if (sy + sh + gap + ch <= vh - margin) {
                    cy = sy + sh + gap
                    arrowSide = 'top'
                } else {
                    cy = sy - ch - gap
                    arrowSide = 'bottom'
                }
            } else if (step.placement === 'right') {
                if (sx + sw + gap + cw <= vw - margin) {
                    cx = sx + sw + gap
                    arrowSide = 'left'
                } else {
                    cx = sx - cw - gap
                    arrowSide = 'right'
                }
                cy = sy + (sh - ch) / 2
            } else if (step.placement === 'right-end') {
                if (sx + sw + gap + cw <= vw - margin) {
                    cx = sx + sw + gap
                    arrowSide = 'left'
                } else {
                    cx = sx - cw - gap
                    arrowSide = 'right'
                }
                cy = sy + sh - ch
            }

            cx = Math.max(minX, Math.min(maxX, cx))
            cy = Math.max(minY, Math.min(maxY, cy))

            if (arrow) {
                arrow.dataset.arrowSide = arrowSide
                if (arrowSide === 'top' || arrowSide === 'bottom') {
                    const targetCenterX = sx + sw / 2
                    const offsetX = Math.max(22, Math.min(cw - 22, targetCenterX - cx))
                    arrow.style.left = `${Math.round(offsetX)}px`
                    arrow.style.top = ''
                } else {
                    const targetCenterY = sy + sh / 2
                    const offsetY = Math.max(22, Math.min(ch - 22, targetCenterY - cy))
                    arrow.style.top = `${Math.round(offsetY)}px`
                    arrow.style.left = ''
                }
                arrow.hidden = false
            }
        } else {
            if (!instant && !silent && this._activeSpotRect) {
                this._triggerExitSpotlight(this._activeSpotRect)
            } else if (instant) {
                this._resetSpotlightArtifacts({ keepCurr: true })
            }
            if (maskHoleCurr) {
                maskHoleCurr.classList.remove('is-open', 'is-delayed-reveal')
                this._setSvgBox(maskHoleCurr, null)
            }
            this._activeSpotRect = null
            spotlight.classList.remove('has-target', 'is-delayed-reveal')
            backdrop.classList.remove('spotlight-active')
            if (arrow) {
                arrow.hidden = true
                delete arrow.dataset.arrowSide
            }
            cx = Math.max(minX, Math.min(maxX, cx))
            cy = Math.max(minY, Math.min(maxY, cy))
        }

        if (instant && card.style.transition !== 'none') {
            card.style.transition = 'none'
            card.style.left = `${Math.round(cx)}px`
            card.style.top = `${Math.round(cy)}px`
            void card.offsetWidth
            card.style.transition = ''
        } else {
            card.style.left = `${Math.round(cx)}px`
            card.style.top = `${Math.round(cy)}px`
        }
    }

    _sameSpotBox(a, b) {
        if (!a || !b) return false
        return Math.abs(a.left - b.left) <= 1 &&
            Math.abs(a.top - b.top) <= 1 &&
            Math.abs(a.width - b.width) <= 1 &&
            Math.abs(a.height - b.height) <= 1
    }

    _applyBoxStyle(el, box) {
        if (!el || !box) return
        el.style.left = `${box.left}px`
        el.style.top = `${box.top}px`
        el.style.width = `${box.width}px`
        el.style.height = `${box.height}px`
    }

    _setSvgBox(el, box) {
        if (!el) return
        if (box) {
            el.setAttribute('x', String(box.left))
            el.setAttribute('y', String(box.top))
            el.setAttribute('width', String(box.width))
            el.setAttribute('height', String(box.height))
        } else {
            el.setAttribute('x', '0')
            el.setAttribute('y', '0')
            el.setAttribute('width', '0')
            el.setAttribute('height', '0')
        }
    }

    _triggerExitSpotlight(prevBox) {
        const maskHolePrev = this.dom?.maskHolePrev
        const spotlightExit = this.dom?.spotlightExit

        if (maskHolePrev && prevBox) {
            maskHolePrev.style.transition = 'none'
            this._setSvgBox(maskHolePrev, prevBox)
            maskHolePrev.classList.add('is-open')
            void window.getComputedStyle(maskHolePrev).opacity
            maskHolePrev.style.transition = ''
            maskHolePrev.classList.remove('is-open')
        }

        if (spotlightExit && prevBox) {
            if (this._exitTimer) {
                clearTimeout(this._exitTimer)
                this._exitTimer = null
            }
            spotlightExit.style.transition = 'none'
            spotlightExit.classList.remove('is-exiting')
            this._applyBoxStyle(spotlightExit, prevBox)
            spotlightExit.style.opacity = '1'
            spotlightExit.style.transform = 'scale(1)'
            void spotlightExit.offsetWidth
            spotlightExit.style.transition = ''
            spotlightExit.style.opacity = ''
            spotlightExit.style.transform = ''
            spotlightExit.classList.add('is-exiting')
            this._exitTimer = setTimeout(() => {
                spotlightExit.classList.remove('is-exiting')
                this._exitTimer = null
            }, 180)
        }
    }

    _resetSpotlightArtifacts({ keepCurr = false } = {}) {
        if (this._exitTimer) {
            clearTimeout(this._exitTimer)
            this._exitTimer = null
        }
        const maskHolePrev = this.dom?.maskHolePrev
        const maskHoleCurr = this.dom?.maskHoleCurr
        const spotlightExit = this.dom?.spotlightExit

        if (maskHolePrev) {
            maskHolePrev.style.transition = 'none'
            maskHolePrev.classList.remove('is-open', 'is-delayed-reveal')
            this._setSvgBox(maskHolePrev, null)
            void window.getComputedStyle(maskHolePrev).opacity
            maskHolePrev.style.transition = ''
        }
        if (!keepCurr && maskHoleCurr) {
            maskHoleCurr.style.transition = 'none'
            maskHoleCurr.classList.remove('is-open', 'is-delayed-reveal')
            this._setSvgBox(maskHoleCurr, null)
            void window.getComputedStyle(maskHoleCurr).opacity
            maskHoleCurr.style.transition = ''
        }
        if (spotlightExit) {
            spotlightExit.style.transition = 'none'
            spotlightExit.classList.remove('is-exiting')
            spotlightExit.style.opacity = ''
            spotlightExit.style.transform = ''
            void spotlightExit.offsetWidth
            spotlightExit.style.transition = ''
        }
    }

    _teardown() {
        this.active = false
        if (this._repositionTimer) {
            clearTimeout(this._repositionTimer)
            this._repositionTimer = null
        }
        if (this._exitTimer) {
            clearTimeout(this._exitTimer)
            this._exitTimer = null
        }
        this._tourKeyEvents.dispose()

        const bookshelfView = document.getElementById('bookshelf-view')
        if (bookshelfView && this._savedSidebarCollapsed !== null) {
            bookshelfView.classList.toggle('sidebar-collapsed', this._savedSidebarCollapsed)
            if (this.app?.bookshelf) {
                this.app.bookshelf.sidebarUserCollapsed = this._savedSidebarCollapsed
            }
        }
        this._savedSidebarCollapsed = null
        this._activeSpotRect = null

        const root = this.dom.root
        if (root) {
            root.classList.remove('show')
            this._closeTimer = setTimeout(() => {
                if (!this.active && this.dom.root) {
                    this.dom.root.style.display = 'none'
                    this.dom.root.hidden = true
                    this._resetSpotlightArtifacts()
                    this.dom.spotlight?.classList.remove('has-target', 'is-delayed-reveal')
                    this.dom.backdrop?.classList.remove('spotlight-active')
                    if (this.dom.arrow) {
                        this.dom.arrow.hidden = true
                        delete this.dom.arrow.dataset.arrowSide
                    }
                    if (this.dom.card) {
                        this.dom.card.classList.remove('is-centered', 'is-step-entering')
                        this.dom.card.style.left = ''
                        this.dom.card.style.top = ''
                        this.dom.card.style.transform = ''
                        this.dom.card.style.transition = ''
                    }
                    if (this.dom.spotlight) {
                        this.dom.spotlight.style.transition = ''
                    }
                }
                this._closeTimer = null
            }, 220)
        }

        if (this._previousFocus && typeof this._previousFocus.focus === 'function') {
            try { this._previousFocus.focus({ preventScroll: true }) } catch {}
        }
        this._previousFocus = null
    }

    dispose() {
        if (this._repositionTimer) clearTimeout(this._repositionTimer)
        if (this._closeTimer) clearTimeout(this._closeTimer)
        this._tourKeyEvents.dispose()
        this.events.dispose()
        this.active = false
        this._bound = false
    }
}
