const parseViewport = str => str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter(x => x)
    ?.map(x => x.split('=').map(x => x.trim()))

const getViewport = (doc, viewport) => {
    // use `viewBox` for SVG
    if (doc.documentElement.localName === 'svg') {
        const [, , width, height] = doc.documentElement
            .getAttribute('viewBox')?.split(/\s/) ?? []
        return { width, height }
    }

    // get `viewport` `meta` element
    const meta = parseViewport(doc.querySelector('meta[name="viewport"]')
        ?.getAttribute('content'))
    if (meta) return Object.fromEntries(meta)

    // fallback to book's viewport
    if (typeof viewport === 'string') return parseViewport(viewport)
    if (viewport?.width && viewport.height) return viewport

    // if no viewport (possibly with image directly in spine), get image size
    const img = doc.querySelector('img')
    if (img && img.naturalWidth && img.naturalHeight) return { width: img.naturalWidth, height: img.naturalHeight }

    // just show *something*, i guess...
    console.warn(new Error('Missing viewport properties'))
    return { width: 1000, height: 2000 }
}

export class FixedLayout extends HTMLElement {
    static observedAttributes = ['zoom']
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => this.#render())
    #spreads
    #index = -1
    defaultViewport
    spread
    #portrait = false
    #left
    #right
    #center
    #side
    #zoom
    #themeObserver
    #navigationGeneration = 0
    #styles = null
    constructor() {
        super()

        const sheet = new CSSStyleSheet()
        this.#root.adoptedStyleSheets = [sheet]
        sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: auto;
            scroll-behavior: smooth;
        }
        :host([data-theme="dark"]) iframe,
        :host([data-theme="black"]) iframe {
            filter: invert(0.90) hue-rotate(180deg) contrast(1.1) brightness(0.95);
        }
        :host([data-theme="sepia"]) iframe {
            filter: sepia(0.38) contrast(0.95) brightness(0.98);
        }
        :host([data-theme="green"]) iframe {
            filter: sepia(0.20) hue-rotate(60deg) contrast(0.92) brightness(0.96);
        }
        :host([data-theme="warm"]) iframe {
            filter: sepia(0.25) contrast(0.95) brightness(0.98);
        }
        :host([data-theme="eink"]) iframe {
            filter: grayscale(1) contrast(1.25) brightness(1.05);
        }`)

        this.#observer.observe(this)
    }
    connectedCallback() {
        this.#updateTheme()
        this.#themeObserver = new MutationObserver(() => this.#updateTheme())
        this.#themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }
    disconnectedCallback() {
        this.#themeObserver?.disconnect()
    }
    #updateTheme() {
        const theme = document.documentElement.getAttribute('data-theme') || 'light'
        this.setAttribute('data-theme', theme)
    }
    #applyStylesToDoc(doc) {
        if (!doc?.head) return
        let style = doc.head.querySelector('style[data-linden-reader-style]')
        if (!style) {
            style = doc.createElement('style')
            style.dataset.lindenReaderStyle = '1'
            doc.head.append(style)
        }
        style.textContent = Array.isArray(this.#styles) ? this.#styles.join('\n') : (this.#styles || '')
    }
    setStyles(styles) {
        this.#styles = styles
        for (const frame of [this.#center, this.#left, this.#right]) {
            if (frame?.doc) this.#applyStylesToDoc(frame.doc)
        }
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'zoom':
                this.#zoom = value !== 'fit-width' && value !== 'fit-page'
                    ? parseFloat(value) : value
                this.#render()
                break
        }
    }
    async #createFrame({ index, src: srcOption }, pending = false) {
        const srcOptionIsString = typeof srcOption === 'string'
        const src = srcOptionIsString ? srcOption : srcOption?.src
        const onZoom = srcOptionIsString ? null : srcOption?.onZoom
        const element = document.createElement('div')
        element.setAttribute('dir', 'ltr')
        Object.assign(element.style, {
            position: pending ? 'absolute' : 'relative',
            inset: pending ? '0' : '',
            visibility: pending ? 'hidden' : '',
            pointerEvents: pending ? 'none' : '',
        })
        const iframe = document.createElement('iframe')
        element.append(iframe)
        Object.assign(iframe.style, { border: '0', overflow: 'hidden' })
        iframe.setAttribute('sandbox', 'allow-same-origin')
        iframe.setAttribute('scrolling', 'no')
        iframe.setAttribute('part', 'filter')

        if (!src) {
            this.#root.append(element)
            return { blank: true, element, iframe, index }
        }

        // Register the target navigation before insertion. Appending an iframe
        // without src can otherwise race its initial about:blank load against
        // the real section load in Chromium/WebView2.
        return new Promise((resolve, reject) => {
            let settled = false
            const cleanup = () => {
                clearTimeout(timer)
                iframe.removeEventListener('load', onLoad)
                iframe.removeEventListener('error', onError)
            }
            const fail = error => {
                if (settled) return
                settled = true
                cleanup()
                element.remove()
                reject(error instanceof Error ? error : new Error(String(error)))
            }
            const onError = () => fail(new Error(`Fixed-layout iframe failed to load section ${index}`))
            const onLoad = async () => {
                if (settled) return
                try {
                    const doc = iframe.contentDocument
                    if (!doc?.documentElement) throw new Error(`Fixed-layout section ${index} loaded without a document`)
                    const img = doc.querySelector('img')
                    if (img) {
                        if (!img.complete) {
                            await Promise.race([
                                new Promise(res => {
                                    img.addEventListener('load', res, { once: true })
                                    img.addEventListener('error', res, { once: true })
                                }),
                                new Promise(res => setTimeout(res, 5000)),
                            ])
                        }
                        if (img.decode) {
                            try { await img.decode() } catch {}
                        }
                    }
                    this.#applyStylesToDoc(doc)
                    const { width, height } = getViewport(doc, this.defaultViewport)
                    const frameObj = {
                        element, iframe, index, doc,
                        width: parseFloat(width) || 800,
                        height: parseFloat(height) || 1100,
                        onZoom, overlayer: null,
                    }
                    if (settled) return
                    settled = true
                    cleanup()
                    this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
                    this.dispatchEvent(new CustomEvent('create-overlayer', {
                        detail: {
                            doc, index,
                            attach: overlayer => {
                                frameObj.overlayer = overlayer
                                Object.assign(overlayer.element.style, {
                                    position: 'absolute', top: '0', left: '0',
                                    width: '100%', height: '100%', pointerEvents: 'none', zIndex: '20',
                                })
                                const pageContainer = doc.getElementById('page-container') || doc.body || doc.documentElement || element
                                pageContainer.append(overlayer.element)
                            },
                        },
                    }))
                    resolve(frameObj)
                } catch (error) {
                    fail(error)
                }
            }
            const timer = setTimeout(() => fail(new Error(`Fixed-layout section ${index} timed out`)), 15000)
            iframe.addEventListener('load', onLoad)
            iframe.addEventListener('error', onError)
            iframe.src = src
            this.#root.append(element)
        })
    }
    async #renderState({ left = this.#left, right = this.#right, center = this.#center, side = this.#side } = {}, pending = false) {
        if (center) side = 'center'
        if (!side) return
        const leftFrame = left ?? {}
        const rightFrame = center ?? right ?? {}
        const target = center ? center : (side === 'left' ? leftFrame : rightFrame)
        const rect = this.getBoundingClientRect()
        let hostWidth = rect.width || this.parentElement?.clientWidth || window.innerWidth || 800
        let hostHeight = rect.height || this.parentElement?.clientHeight || window.innerHeight || 1000
        if (hostWidth <= 50) hostWidth = window.innerWidth || 800
        if (hostHeight <= 50) hostHeight = window.innerHeight || 1000

        const portrait = this.spread !== 'both' && this.spread !== 'portrait'
            && hostHeight > hostWidth
        const blankWidth = leftFrame.width ?? rightFrame.width ?? 612
        const blankHeight = leftFrame.height ?? rightFrame.height ?? 792
        const targetW = (target.width ?? blankWidth) || 612
        const targetH = (target.height ?? blankHeight) || 792

        let calculatedScale = typeof this.#zoom === 'number' && !isNaN(this.#zoom)
            ? this.#zoom
            : (this.#zoom === 'fit-width'
                ? (portrait || center
                    ? hostWidth / targetW
                    : hostWidth / ((leftFrame.width ?? blankWidth) + (rightFrame.width ?? blankWidth)))
                : (portrait || center
                    ? Math.min(hostWidth / targetW, hostHeight / targetH)
                    : Math.min(
                        hostWidth / ((leftFrame.width ?? blankWidth) + (rightFrame.width ?? blankWidth)),
                        hostHeight / Math.max(leftFrame.height ?? blankHeight, rightFrame.height ?? blankHeight)))
            )

        const scale = (!calculatedScale || isNaN(calculatedScale) || calculatedScale <= 0.05) ? 1 : calculatedScale

        const transform = async frame => {
            if (!frame?.iframe) return
            const { element, iframe, width, height, blank, overlayer, onZoom, doc } = frame
            Object.assign(iframe.style, {
                width: `${width}px`,
                height: `${height}px`,
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                display: blank ? 'none' : 'block',
            })
            Object.assign(element.style, {
                width: `${(width ?? blankWidth) * scale}px`,
                height: `${(height ?? blankHeight) * scale}px`,
                overflow: 'hidden',
                display: 'block',
                flexShrink: '0',
                marginBlock: 'auto',
                position: pending ? 'absolute' : 'relative',
                inset: pending ? '0' : '',
                visibility: pending ? 'hidden' : '',
                pointerEvents: pending ? 'none' : '',
            })
            if (portrait && !center && frame !== target && this.spread !== 'both') {
                element.style.display = 'none'
            }
            if (overlayer) {
                overlayer.element.style.width = `${width}px`
                overlayer.element.style.height = `${height}px`
                overlayer.element.style.transform = 'none'
                overlayer.element.style.transformOrigin = 'top left'
                overlayer.redraw()
            }
            if (onZoom && doc) {
                try { onZoom(scale, doc) }
                catch (e) { console.warn('onZoom error:', e) }
            }
        }
        if (center) await transform(center)
        else {
            await transform(leftFrame)
            await transform(rightFrame)
        }
        return { portrait, side, scale }
    }
    async #render(side = this.#side) {
        const result = await this.#renderState({ side }, false)
        if (result) {
            this.#portrait = result.portrait
            if (!this.#center) this.#side = result.side
        }
    }
    #discardFrames(...frames) {
        for (const frame of frames) frame?.element?.remove?.()
    }
    async #showSpread({ left, right, center, side }, generation) {
        const candidate = { left: null, right: null, center: null, side }
        try {
            if (center) {
                candidate.center = await this.#createFrame(center, true)
                candidate.side = 'center'
            } else {
                ;[candidate.left, candidate.right] = await Promise.all([
                    this.#createFrame(left, true),
                    this.#createFrame(right, true),
                ])
                candidate.side = candidate.left.blank ? 'right'
                    : candidate.right.blank ? 'left' : side
            }

            if (generation !== this.#navigationGeneration) {
                this.#discardFrames(candidate.left, candidate.right, candidate.center)
                return false
            }

            const rendered = await this.#renderState(candidate, true)
            if (generation !== this.#navigationGeneration) {
                this.#discardFrames(candidate.left, candidate.right, candidate.center)
                return false
            }

            const old = [this.#left, this.#right, this.#center]
            this.#left = candidate.left
            this.#right = candidate.right
            this.#center = candidate.center
            this.#side = candidate.side
            this.#portrait = rendered?.portrait ?? this.#portrait

            for (const frame of [this.#left, this.#right, this.#center]) {
                if (!frame?.element) continue
                Object.assign(frame.element.style, {
                    position: 'relative', inset: '', visibility: '', pointerEvents: '',
                })
            }
            this.#discardFrames(...old)
            requestAnimationFrame(() => {
                if (generation === this.#navigationGeneration) this.#render()
            })
            return true
        } catch (error) {
            this.#discardFrames(candidate.left, candidate.right, candidate.center)
            throw error
        }
    }
    #goLeft() {
        if (this.#center || this.#left?.blank) return
        if (this.#portrait && this.#left?.element?.style?.display === 'none') {
            this.#side = 'left'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    #goRight() {
        if (this.#center || this.#right?.blank) return
        if (this.#portrait && this.#right?.element?.style?.display === 'none') {
            this.#side = 'right'
            this.#render()
            this.#reportLocation('page')
            return true
        }
    }
    async setSpread(mode) {
        const newSpread = (mode === '1' || mode === 'single' || mode === 'none') ? 'none' : 'both'
        if (this.spread === newSpread && this.#spreads?.length) return
        this.spread = newSpread
        const currentSecIndex = this.sectionIndex ?? (this.index ?? 0)
        this.rebuildSpreads()
        this.#index = -1 // Force reload and layout of spread
        if (this.book?.sections && (this.#center || this.#left || this.#right)) {
            await this.goTo(currentSecIndex)
        }
    }
    rebuildSpreads() {
        if (!this.book?.sections) return
        if (this.spread === 'none') {
            this.#spreads = this.book.sections.map(section => ({ center: section }))
        } else {
            this.#spreads = []
            const sections = this.book.sections
            for (let i = 0; i < sections.length; i += 2) {
                this.#spreads.push({
                    left: sections[i],
                    right: sections[i + 1] || null
                })
            }
        }
    }
    open(book) {
        this.book = book
        const { rendition } = book
        this.spread = this.spread || rendition?.spread || 'none'
        this.defaultViewport = rendition?.viewport

        const rtl = book.dir === 'rtl'
        this.rtl = rtl
        this.rebuildSpreads()
    }
    get zoom() {
        return this.#zoom || 'fit-page'
    }
    set zoom(val) {
        this.setAttribute('zoom', val)
    }
    get index() {
        const spread = this.#spreads?.[this.#index]
        if (!spread) return 0
        const section = spread.center ?? (this.#side === 'left'
            ? spread.left ?? spread.right : spread.right ?? spread.left)
        return this.book?.sections ? Math.max(0, this.book.sections.indexOf(section)) : 0
    }
    #reportLocation(reason) {
        const total = this.book?.sections?.length || this.#spreads?.length || 1
        const current = (this.index ?? 0) + 1
        const fraction = total > 1 ? (current - 1) / (total - 1) : 0
        this.dispatchEvent(new CustomEvent('relocate', { detail:
            { reason, range: null, index: this.index, fraction, size: 1, page: current, totalPages: total } }))
    }
    getSpreadOf(section) {
        const spreads = this.#spreads
        if (!spreads) return null
        for (let index = 0; index < spreads.length; index++) {
            const spread = spreads[index]
            if (!spread) continue
            const { left, right, center } = spread
            if (left === section) return { index, side: 'left' }
            if (right === section) return { index, side: 'right' }
            if (center === section) return { index, side: 'center' }
        }
        return null
    }
    async goToSpread(index, side, reason) {
        if (!this.#spreads || index < 0 || index > this.#spreads.length - 1) return
        if (index === this.#index && (this.#center || this.#left || this.#right)) {
            await this.#render(side)
            return
        }
        const generation = ++this.#navigationGeneration
        const oldIndex = this.#index
        const spread = this.#spreads[index]
        if (!spread) return

        try {
            let committed = false
            if (spread.center) {
                const idx = this.book.sections.indexOf(spread.center)
                const src = await spread.center?.load?.()
                if (generation !== this.#navigationGeneration) return
                committed = await this.#showSpread({ center: { index: idx, src } }, generation)
            } else {
                const indexL = this.book.sections.indexOf(spread.left)
                const indexR = spread.right ? this.book.sections.indexOf(spread.right) : -1
                const [srcL, srcR] = await Promise.all([
                    spread.left?.load?.(),
                    spread.right ? spread.right.load?.() : Promise.resolve(null),
                ])
                if (generation !== this.#navigationGeneration) return
                const left = { index: indexL, src: srcL }
                const right = { index: indexR, src: srcR }
                committed = await this.#showSpread({ left, right, side }, generation)
            }
            if (!committed || generation !== this.#navigationGeneration) return

            this.#index = index
            if (oldIndex >= 0 && oldIndex !== index && this.#spreads[oldIndex]) {
                const oldSpread = this.#spreads[oldIndex]
                if (oldSpread.center && oldSpread.center !== spread.center) oldSpread.center?.unload?.()
                if (oldSpread.left && oldSpread.left !== spread.left && oldSpread.left !== spread.right) oldSpread.left?.unload?.()
                if (oldSpread.right && oldSpread.right !== spread.left && oldSpread.right !== spread.right) oldSpread.right?.unload?.()
            }
            this.#reportLocation(reason)
        } catch (error) {
            if (generation === this.#navigationGeneration) {
                this.dispatchEvent(new CustomEvent('section-load-error', {
                    detail: { error, index },
                }))
                console.warn(`Fixed-layout section ${index} failed to load:`, error)
            }
        }
    }
    async select(target) {
        await this.goTo(target)
    }
    async goTo(target) {
        const { book } = this
        if (!book?.sections) return
        const resolved = await target
        const secIndex = typeof resolved === 'number' ? resolved : (resolved?.index ?? 0)
        const section = book.sections[secIndex]
        if (!section) return
        const spreadObj = this.getSpreadOf(section)
        if (!spreadObj) return
        const { index, side } = spreadObj
        await this.goToSpread(index, side)
    }
    async next() {
        const s = this.rtl ? this.#goLeft() : this.#goRight()
        if (!s) return this.goToSpread(this.#index + 1, this.rtl ? 'right' : 'left', 'page')
    }
    async prev() {
        const s = this.rtl ? this.#goRight() : this.#goLeft()
        if (!s) return this.goToSpread(this.#index - 1, this.rtl ? 'left' : 'right', 'page')
    }
    getContents() {
        const frames = [this.#center, this.#left, this.#right].filter(f => f && f.iframe && f.element && f.element.style.display !== 'none' && !f.blank)
        return frames.map(f => ({
            index: f.index,
            doc: f.iframe.contentDocument,
            overlayer: f.overlayer,
        }))
    }
    destroy() {
        ++this.#navigationGeneration
        this.#observer?.disconnect?.()
        this.#themeObserver?.disconnect?.()
        if (this.#index >= 0 && this.#spreads?.[this.#index]) {
            const spread = this.#spreads[this.#index]
            spread.center?.unload?.()
            spread.left?.unload?.()
            spread.right?.unload?.()
        }
        this.#root.replaceChildren()
    }
}

if (!customElements.get('foliate-fxl')) {
    customElements.define('foliate-fxl', FixedLayout)
}
