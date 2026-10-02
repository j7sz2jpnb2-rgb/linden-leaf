const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    const debounced = (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
    debounced.cancel = () => {
        if (timeout) {
            clearTimeout(timeout)
            timeout = null
        }
    }
    return debounced
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    if (!doc?.body) return null
    // Reuse a single Range for text node bounding measurement to prevent Range instantiation GC thrashing
    const measureRange = doc.createRange()
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // reuse range to get rect
            measureRange.selectNodeContents(node)
            const { left, right } = mapRect(measureRange.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    if (!doc || !doc.body) return ''
    const bodyStyle = doc.defaultView?.getComputedStyle(doc.body)
    if (!bodyStyle) return ''
    let bg = bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView?.getComputedStyle(doc.documentElement)?.background
        : bodyStyle.background
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
        const theme = document.documentElement.getAttribute('data-theme')
        if (theme === 'black') return '#000000'
        if (theme === 'dark') return '#1f1f1d'
        if (theme === 'sepia') return '#f5eedc'
        if (theme === 'green') return '#e8f5e9'
        if (theme === 'eink') return '#ffffff'
        return '#FAF9F5'
    }
    return bg
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    if (!el) return
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => {
        const doc = this.#activeDocument
        if (this.#isCurrent(doc)) this.expand()
    })
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    #generation = 0
    #activeDocument = null
    #observedNode = null
    #scrollWindow = null
    #scrollHandler = null

    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        this.#iframe.setAttribute('sandbox', 'allow-same-origin')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    setDirection(vertical, rtl) {
        this.#vertical = vertical
        this.#rtl = rtl
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#activeDocument ?? this.#iframe.contentDocument
    }
    #renderRoot(doc) {
        const root = doc?.documentElement
        if (!root) return null
        return root.localName?.toLowerCase() === 'html' ? doc.body : (doc.body ?? root)
    }
    #isCurrent(doc, generation = this.#generation) {
        return Boolean(doc && generation === this.#generation
            && doc === this.#activeDocument
            && doc === this.#iframe.contentDocument
            && this.#renderRoot(doc))
    }
    #detachDocument() {
        this.#observer.disconnect()
        this.#observedNode = null
        if (this.#scrollWindow && this.#scrollHandler) {
            this.#scrollWindow.removeEventListener('scroll', this.#scrollHandler)
        }
        this.#scrollWindow = null
        this.#scrollHandler = null
        this.#activeDocument = null
    }
    async #waitForRenderRoot(doc, generation) {
        const current = () => generation === this.#generation && doc === this.#iframe.contentDocument
        let root = this.#renderRoot(doc)
        if (root) return root
        if (!current()) throw new DOMException('Section load superseded', 'AbortError')

        return new Promise((resolve, reject) => {
            let done = false
            const finish = (fn, value) => {
                if (done) return
                done = true
                clearTimeout(timer)
                observer.disconnect()
                fn(value)
            }
            const check = () => {
                if (!current()) return finish(reject, new DOMException('Section load superseded', 'AbortError'))
                root = this.#renderRoot(doc)
                if (root) finish(resolve, root)
            }
            const observer = new MutationObserver(check)
            observer.observe(doc, { childList: true, subtree: true })
            const timer = setTimeout(() => finish(reject,
                new Error('Timed out waiting for iframe document body')), 3000)
            queueMicrotask(check)
        })
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        const generation = ++this.#generation
        this.#detachDocument()
        this.#iframe.style.display = 'none'

        return new Promise((resolve, reject) => {
            const onLoad = async () => {
                try {
                    const doc = this.#iframe.contentDocument
                    if (!doc) throw new Error('iframe contentDocument is unavailable')
                    const root = await this.#waitForRenderRoot(doc, generation)
                    if (generation !== this.#generation || doc !== this.#iframe.contentDocument)
                        throw new DOMException('Section load superseded', 'AbortError')

                    this.#activeDocument = doc
                    afterLoad?.(doc)

                    // Computed style needs a laid-out iframe in Chromium/WebKit.
                    this.#iframe.style.display = 'block'
                    const { vertical, rtl } = getDirection(doc)
                    const background = getBackground(doc)
                    this.#iframe.style.display = 'none'
                    this.#vertical = vertical
                    this.#rtl = rtl

                    this.#contentRange.selectNodeContents(root)
                    const layout = beforeRender?.({ vertical, rtl, background })
                    this.#iframe.style.display = 'block'
                    this.render(layout)

                    if (!this.#isCurrent(doc, generation))
                        throw new DOMException('Section load superseded', 'AbortError')
                    this.#observer.observe(root)
                    this.#observedNode = root

                    const win = doc.defaultView
                    if (win) {
                        const onScroll = () => {
                            if (!this.#isCurrent(doc, generation)) return
                            if (this.#column && (win.scrollX !== 0 || win.scrollY !== 0)) win.scrollTo(0, 0)
                        }
                        win.addEventListener('scroll', onScroll, { passive: true })
                        this.#scrollWindow = win
                        this.#scrollHandler = onScroll
                    }

                    Promise.resolve(doc.fonts?.ready).then(() => {
                        if (this.#isCurrent(doc, generation)) this.expand()
                    }).catch(() => {})
                    resolve()
                } catch (err) {
                    if (generation === this.#generation) this.#detachDocument()
                    reject(err)
                }
            }
            this.#iframe.addEventListener('load', onLoad, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        const doc = this.#activeDocument
        if (!layout || !this.#isCurrent(doc)) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const doc = this.#activeDocument
        if (!this.#isCurrent(doc)) return
        const vertical = this.#vertical
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const doc = this.#activeDocument
        if (!this.#isCurrent(doc)) return
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical ? { 'width': `${width}px` } : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            'overflow-wrap': 'break-word',
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const doc = this.#activeDocument
        const root = this.#renderRoot(doc)
        if (!this.#isCurrent(doc) || !root) return
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        for (const el of root.querySelectorAll('img, svg, video')) {
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        const doc = this.#activeDocument
        const documentElement = doc?.documentElement
        if (!this.#isCurrent(doc) || !documentElement) return
        if (this.#column) {
            if (!this.#size) return
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.max(1, Math.ceil(contentSize / this.#size))
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const expandedSize = documentElement.getBoundingClientRect()[side]
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        ++this.#generation
        this.#detachDocument()
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'open' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #pendingNav = null // coalesced pending navigation request
    #displayGeneration = 0
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    #relocateTimeout = null
    #lockedAnchor = null
    #isPointerSelecting = false
    #checkPointerSelection = null
    #lastResizeTime = 0
    #globalPointerUpListener = null
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(max(var(--_half-gap), var(--safe-left, 0px)), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(max(var(--_half-gap), var(--safe-right, 0px)), 1fr);
            grid-template-rows:
                minmax(max(var(--_margin), var(--safe-top, 0px)), 1fr)
                minmax(0, var(--_max-height))
                minmax(max(var(--_margin), var(--safe-bottom, 0px)), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            } else if (this.pages > 0 && this.size > 0) {
                // Ensure the container never rests at an unaligned fractional page offset
                const expectedOffset = this.page * this.size * (this.#rtl ? -1 : 1)
                if (Math.abs(this.#container[this.scrollProp] - expectedOffset) > 2) {
                    this.#scrollToPage(this.page, 'snap')
                }
            }
        }, 200))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        this.#checkPointerSelection = debounce((range, sel) => {
            if (Date.now() - this.#lastResizeTime < 1000) return
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.#globalPointerUpListener = () => this.#clearPointerSelecting()
        window.addEventListener('pointerup', this.#globalPointerUpListener)
        window.addEventListener('pointercancel', this.#globalPointerUpListener)
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('pointerdown', () => {
                if (Date.now() - this.#lastResizeTime >= 300) {
                    this.#isPointerSelecting = true
                }
            })
            doc.addEventListener('pointerup', this.#globalPointerUpListener)
            doc.addEventListener('pointercancel', this.#globalPointerUpListener)
            doc.defaultView?.addEventListener('pointerup', this.#globalPointerUpListener)
            doc.defaultView?.addEventListener('pointercancel', this.#globalPointerUpListener)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                if (Date.now() - this.#lastResizeTime < 1000) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (this.#isPointerSelecting && sel.type === 'Range')
                    this.#checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => {
                if (this.scrolled) return
                if (e.target?.matches?.('a[href], input, button, select, textarea, [tabindex]')) {
                    requestAnimationFrame(() => this.#scrollToAnchor(e.target))
                }
            })
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView({ pending = false } = {}) {
        let view
        view = new View({
            container: this,
            onExpand: () => {
                if (this.#view === view) this.#scrollToAnchor(this.#anchor)
            },
        })
        if (pending) Object.assign(view.element.style, {
            visibility: 'hidden',
            position: 'absolute',
            inset: '0',
            pointerEvents: 'none',
        })
        this.#container.append(view.element)
        return view
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.#background.style.background = background

        const width = this.#container.clientWidth || this.#container.getBoundingClientRect().width
        const height = this.#container.clientHeight || this.#container.getBoundingClientRect().height
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    #clearPointerSelecting() {
        this.#isPointerSelecting = false
        this.#checkPointerSelection?.cancel?.()
    }
    setAnchor(anchor, isLocked = true) {
        if (this.#relocateTimeout) {
            clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = null
        }
        if (anchor) {
            this.#anchor = anchor
            if (isLocked) this.#lockedAnchor = anchor
        }
    }
    setLockedAnchor(anchor) {
        this.setAnchor(anchor, true)
    }
    render() {
        this.#clearPointerSelecting()
        this.#lastResizeTime = Date.now()
        if (this.#lockedAnchor) {
            this.#anchor = this.#lockedAnchor
            this.#lockedAnchor = null
            if (this.#relocateTimeout) {
                clearTimeout(this.#relocateTimeout)
                this.#relocateTimeout = null
            }
        } else if (this.#relocateTimeout) {
            clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = null
            // Pending fast-path flip: calculate actual visible range of the current page
            const range = this.#getVisibleRange()
            if (range) {
                this.#lastVisibleRange = range
                this.#anchor = range
            }
        }
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        const prop = this.sideProp
        if (prop === 'width') return this.#container.clientWidth || this.#container.getBoundingClientRect().width
        if (prop === 'height') return this.#container.clientHeight || this.#container.getBoundingClientRect().height
        return this.#container.getBoundingClientRect()[prop]
    }
    get viewSize() {
        const prop = this.sideProp
        const el = this.#view?.element
        if (!el) return 0
        if (prop === 'width') return el.offsetWidth || el.getBoundingClientRect().width
        if (prop === 'height') return el.offsetHeight || el.getBoundingClientRect().height
        return el.getBoundingClientRect()[prop]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const element = this.#container
        const { scrollProp, size } = this
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, 300, easeOutQuad,
            x => element[scrollProp] = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = Math.max(1, pages - 2)
        const safeAnchor = Number.isFinite(anchor) ? Math.max(0, Math.min(1, anchor)) : 0
        const newPage = textPages > 1 ? Math.round(safeAnchor * (textPages - 1)) : 0
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    settle() {
        if (!this.#relocateTimeout) return
        clearTimeout(this.#relocateTimeout)
        this.#relocateTimeout = null

        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        this.#anchor = range

        const index = this.#index
        const detail = { reason: 'page', index, range, isSettled: true }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            const textPages = Math.max(1, pages - 2)
            detail.fraction = textPages > 1 ? Math.max(0, Math.min(1, (page - 1) / (pages - 2))) : 0
            detail.size = 1 / textPages
            detail.page = Math.max(1, Math.min(textPages, page))
            detail.totalPages = textPages
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    #afterScroll(reason) {
        const isFastPath = (reason === 'page' || reason === 'snap') && !this.scrolled && this.pages > 0

        const index = this.#index
        const detail = { reason, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            const textPages = Math.max(1, pages - 2)
            detail.fraction = textPages > 1 ? Math.max(0, Math.min(1, (page - 1) / (pages - 2))) : 0
            detail.size = 1 / textPages
            detail.page = Math.max(1, Math.min(textPages, page))
            detail.totalPages = textPages
        }

        if (isFastPath) {
            // Fast-path: dispatch relocate immediately without heavy DOM bisecting for 60/120fps UI updates
            detail.range = null
            detail.isFastPath = true
            this.dispatchEvent(new CustomEvent('relocate', { detail }))

            // Debounce the heavy DOM bisecting calculation when the user pauses/stops flipping
            if (this.#relocateTimeout) clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = setTimeout(() => {
                this.settle()
            }, 160)
            return
        }

        if (this.#relocateTimeout) {
            clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = null
        }

        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        detail.range = range
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const generation = ++this.#displayGeneration
        const { index, src, anchor, onLoad, select } = await promise
        if (!Number.isInteger(index)) return
        const hasFocus = this.#view?.document?.hasFocus()

        if (src) {
            const previous = this.#view
            const view = this.#createView({ pending: true })
            const afterLoad = doc => {
                if (doc.fonts && document.fonts) {
                    try {
                        for (const f of document.fonts) doc.fonts.add(f)
                    } catch {}
                }
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                    if (this.#styles) {
                        if (Array.isArray(this.#styles)) {
                            const [beforeStyle, style] = this.#styles
                            $styleBefore.textContent = beforeStyle
                            $style.textContent = style
                        } else $style.textContent = this.#styles
                    }
                }
            }
            try {
                await view.load(src, afterLoad, this.#beforeRender.bind(this))
                if (generation !== this.#displayGeneration) {
                    view.destroy()
                    view.element.remove()
                    return
                }

                previous?.destroy()
                previous?.element?.remove()
                Object.assign(view.element.style, {
                    visibility: '',
                    position: 'relative',
                    inset: '',
                    pointerEvents: '',
                })
                this.#view = view
                this.#index = index
                onLoad?.({ doc: view.document, index })
                this.dispatchEvent(new CustomEvent('create-overlayer', {
                    detail: {
                        doc: view.document, index,
                        attach: overlayer => view.overlayer = overlayer,
                    },
                }))
            } catch (err) {
                view.destroy()
                view.element.remove()
                throw err
            }
        } else {
            this.#index = index
        }

        if (!this.#view?.document) return
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select}) {
        if (index === this.#index) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select }))
                .catch(error => {
                    try { error.sectionIndex = index } catch {}
                    throw error
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) {
            return new Promise((resolve, reject) => {
                if (this.#pendingNav) {
                    this.#pendingNav.resolve(false)
                }
                this.#pendingNav = { target, resolve, reject }
            })
        }
        this.#locked = true
        try {
            const resolved = await target
            if (resolved && this.#canGoToIndex(resolved.index)) {
                await this.#goTo(resolved)
                return true
            }
            return false
        } catch (err) {
            console.warn('Paginator goTo error:', err)
            if (err?.name !== 'AbortError') {
                this.dispatchEvent(new CustomEvent('section-load-error', {
                    detail: { error: err, index: Number.isInteger(err?.sectionIndex) ? err.sectionIndex : this.#index },
                }))
            }
            throw err
        } finally {
            this.#locked = false
            if (this.#pendingNav) {
                const next = this.#pendingNav
                this.#pendingNav = null
                this.goTo(next.target).then(next.resolve, next.reject)
            }
        }
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        try {
            const prev = dir === -1
            const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
            if (shouldGo) {
                const adjIndex = this.#adjacentIndex(dir)
                if (adjIndex != null && this.#canGoToIndex(adjIndex)) {
                    await this.#goTo({
                        index: adjIndex,
                        anchor: prev ? () => 1 : () => 0,
                    })
                }
            }
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } catch (err) {
            console.warn('Paginator #turnPage error:', err)
        } finally {
            this.#locked = false
            if (this.#pendingNav) {
                const next = this.#pendingNav
                this.#pendingNav = null
                this.goTo(next.target).then(next.resolve, next.reject)
            }
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        const doc = this.#view?.document
        if (doc?.fonts && document.fonts) {
            try {
                for (const f of document.fonts) {
                    doc.fonts.add(f)
                }
            } catch {}
        }
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        const view = this.#view
        const viewDoc = view?.document
        // NOTE: needs `requestAnimationFrame` in Chromium. Do not let an old
        // document's callback restyle a newly committed section.
        requestAnimationFrame(() => {
            if (this.#view === view && view?.document === viewDoc && viewDoc)
                this.#background.style.background = getBackground(viewDoc)
        })

        if (viewDoc) {
            const { vertical, rtl } = getDirection(viewDoc)
            if (this.#vertical !== vertical || this.#rtl !== rtl) {
                view.setDirection?.(vertical, rtl)
                const layout = this.#beforeRender({ vertical, rtl, background: getBackground(viewDoc) })
                view.render(layout)
            }
        }

        // needed because the resize observer doesn't work in Firefox
        viewDoc?.fonts?.ready?.then(() => {
            if (this.#view === view && view?.document === viewDoc) view.expand()
        })
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        ++this.#displayGeneration
        this.settle()
        if (this.#globalPointerUpListener) {
            window.removeEventListener('pointerup', this.#globalPointerUpListener)
            window.removeEventListener('pointercancel', this.#globalPointerUpListener)
            this.#globalPointerUpListener = null
        }
        this.#clearPointerSelecting()
        this.#observer?.disconnect?.() ?? this.#observer?.unobserve?.(this.#container)
        this.#view?.destroy?.()
        this.#view = null
        this.sections?.[this.#index]?.unload?.()
        this.#mediaQuery?.removeEventListener?.('change', this.#mediaQueryListener)
    }
}

if (!customElements.get('foliate-paginator')) {
    customElements.define('foliate-paginator', Paginator)
}
