/**
 * reading-ergonomics.js
 * Desktop & wide-screen visual comfort helpers:
 *   1. Horizontal Reading Ruler overlay tracking pointer or keyboard nudges
 *   2. EPUB/TXT active-paragraph Focus Dimming via lightweight stylesheet injection
 *   3. Privacy veil on window unfocus + instant boss-key veil (Alt+Shift+H)
 */

const FOCUS_DIM_STYLE_ID = 'll-focus-dim-style'

/**
 * Injects or toggles active-paragraph focus dimming inside a Foliate document.
 * Purely visual CSS/class state; preserves CFI anchors and DOM text completely.
 * @param {Document} doc
 * @param {boolean} enabled
 */
export function applyFocusDimmingToDocument(doc, enabled = false) {
    if (!doc?.head || !doc?.body) return false
    let styleEl = doc.getElementById(FOCUS_DIM_STYLE_ID)
    if (enabled && !styleEl) {
        styleEl = doc.createElement('style')
        styleEl.id = FOCUS_DIM_STYLE_ID
        styleEl.textContent = `
body.ll-focus-dim-active p,
body.ll-focus-dim-active li,
body.ll-focus-dim-active blockquote {
  opacity: 0.42;
  transition: opacity 0.16s ease;
}
body.ll-focus-dim-active p:hover,
body.ll-focus-dim-active p.ll-focus-current,
body.ll-focus-dim-active li:hover,
body.ll-focus-dim-active li.ll-focus-current,
body.ll-focus-dim-active blockquote:hover,
body.ll-focus-dim-active blockquote.ll-focus-current {
  opacity: 1;
}
`
        doc.head.appendChild(styleEl)
    }

    doc.body.classList.toggle('ll-focus-dim-active', Boolean(enabled))

    if (enabled && !doc.body.dataset.llFocusBound) {
        doc.body.dataset.llFocusBound = '1'
        doc.addEventListener('pointerover', (e) => {
            const target = e.target?.closest?.('p, li, blockquote')
            if (!target || !doc.body.classList.contains('ll-focus-dim-active')) return
            doc.body.querySelectorAll('.ll-focus-current').forEach(el => {
                if (el !== target) el.classList.remove('ll-focus-current')
            })
            target.classList.add('ll-focus-current')
        }, { passive: true })
    }
    return true
}

export class ReaderErgonomicsController {
    constructor(app) {
        this.app = app
        this.rulerEnabled = false
        this.focusDimEnabled = false
        this.privacyBlurOnUnfocus = false
        this.privacyVeiled = false
        this.rulerY = 260
        this._bound = false
    }

    init() {
        if (this._bound || typeof document === 'undefined' || typeof window === 'undefined') return
        this._bound = true

        this.rulerEl = document.getElementById('reader-reading-ruler')
        this.veilEl = document.getElementById('reader-privacy-veil')

        const onPointerMove = (e) => {
            if (!this.rulerEnabled || !this.app?.dom?.readerView || this.app.dom.readerView.style.display === 'none') return
            this.setRulerY(e.clientY)
        }
        window.addEventListener('pointermove', onPointerMove, { passive: true })

        window.addEventListener('blur', () => {
            if (!this.privacyBlurOnUnfocus) return
            if (this.app?.dom?.readerView?.style.display === 'none') return
            if (this.app?.externalCompanion?.isActive) return
            this.setPrivacyVeil(true)
        })
        window.addEventListener('focus', () => {
            if (this.privacyBlurOnUnfocus && this.privacyVeiled && !this._manualVeilLocked) {
                this.setPrivacyVeil(false)
            }
        })

        this.veilEl?.addEventListener('click', () => {
            this._manualVeilLocked = false
            this.setPrivacyVeil(false)
        })
    }

    setReadingRuler(enabled) {
        this.rulerEnabled = Boolean(enabled)
        if (!this.rulerEl) this.rulerEl = document.getElementById('reader-reading-ruler')
        if (!this.rulerEl) return
        const isInReader = Boolean(this.app?.dom?.readerView && this.app.dom.readerView.style.display !== 'none')
        this.rulerEl.hidden = !(this.rulerEnabled && isInReader)
        if (!this.rulerEl.hidden) this.setRulerY(this.rulerY)
    }

    setRulerY(clientY) {
        const vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 800
        this.rulerY = Math.max(54, Math.min(vh - 42, Number(clientY) || 260))
        if (this.rulerEl) {
            this.rulerEl.style.top = `${Math.round(this.rulerY)}px`
        }
    }

    nudgeRuler(deltaY) {
        if (!this.rulerEnabled) return
        this.setRulerY(this.rulerY + deltaY)
    }

    setFocusDimming(enabled) {
        this.focusDimEnabled = Boolean(enabled)
        const docs = this.app?.foliateView?.renderer?.getContents?.() || []
        for (const item of docs) {
            if (item?.doc) applyFocusDimmingToDocument(item.doc, this.focusDimEnabled)
        }
    }

    setPrivacyBlurOnUnfocus(enabled) {
        this.privacyBlurOnUnfocus = Boolean(enabled)
        if (!this.privacyBlurOnUnfocus && !this._manualVeilLocked) {
            this.setPrivacyVeil(false)
        }
    }

    toggleManualPrivacyVeil() {
        const next = !this.privacyVeiled
        this._manualVeilLocked = next
        this.setPrivacyVeil(next)
    }

    setPrivacyVeil(visible) {
        this.privacyVeiled = Boolean(visible)
        if (!this.veilEl) this.veilEl = document.getElementById('reader-privacy-veil')
        if (!this.veilEl) return
        const isInReader = Boolean(this.app?.dom?.readerView && this.app.dom.readerView.style.display !== 'none')
        this.veilEl.hidden = !(this.privacyVeiled && isInReader)
    }

    syncReaderState({ isInReader = true } = {}) {
        if (!isInReader) {
            this._manualVeilLocked = false
            this.setPrivacyVeil(false)
            if (this.rulerEl) this.rulerEl.hidden = true
            return
        }
        this.setReadingRuler(this.rulerEnabled)
        this.setFocusDimming(this.focusDimEnabled)
    }
}
