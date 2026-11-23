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
    #pendingLoadCancel = null

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
    get size() {
        return this.#size
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
        if (this.#pendingLoadCancel) {
            try { this.#pendingLoadCancel(new DOMException('Section load superseded', 'AbortError')) } catch {}
            this.#pendingLoadCancel = null
        }
        const generation = ++this.#generation
        this.#detachDocument()
        this.#iframe.style.display = 'none'

        return new Promise((resolve, reject) => {
            let done = false
            const cleanup = () => {
                clearTimeout(loadTimer)
                this.#iframe.removeEventListener('load', onLoad)
                this.#iframe.removeEventListener('error', onError)
                if (this.#pendingLoadCancel === cancel) this.#pendingLoadCancel = null
            }
            const finishResolve = () => {
                if (done) return
                done = true
                cleanup()
                resolve()
            }
            const finishReject = err => {
                if (done) return
                done = true
                cleanup()
                if (generation === this.#generation) this.#detachDocument()
                reject(err)
            }
            const cancel = err => finishReject(err || new DOMException('Section load superseded', 'AbortError'))
            const onError = () => finishReject(new Error('Failed to load section frame'))
            const loadTimer = setTimeout(() => finishReject(new Error('Timed out waiting for section frame load')), 15000)
            this.#pendingLoadCancel = cancel

            const onLoad = async () => {
                if (done) return
                try {
                    const doc = this.#iframe.contentDocument
                    if (!doc) throw new Error('iframe contentDocument is unavailable')
                    const root = await this.#waitForRenderRoot(doc, generation)
                    if (generation !== this.#generation || doc !== this.#iframe.contentDocument)
                        throw new DOMException('Section load superseded', 'AbortError')

                    this.#activeDocument = doc
                    const media = [...root.querySelectorAll('img, svg, video')]
                        .filter(el => !el.parentElement?.closest('svg'))
                    // Image-only chapters include covers and full-page illustrations.
                    // Give them one centered page, independent of text column settings.
                    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
                    let text = '', node
                    while ((node = walker.nextNode())) {
                        if (!node.parentElement?.closest('svg, style, script')) text += node.nodeValue
                    }
                    if (media.length === 1 && !text.trim()) {
                        const single = media[0]
                        const isTinyOrnament = single.localName === 'img'
                            && single.naturalWidth > 0 && single.naturalWidth < 48
                            && single.naturalHeight > 0 && single.naturalHeight < 48
                        if (!isTinyOrnament) doc.documentElement.setAttribute('data-reader-image-page', '')
                    }
                    afterLoad?.(doc)

                    // Computed style needs a laid-out iframe in Chromium/WebKit.
                    this.#iframe.style.display = 'block'
                    const { vertical, rtl } = getDirection(doc)
                    const background = getBackground(doc)
                    this.#iframe.style.display = 'none'
                    this.#vertical = vertical
                    this.#rtl = rtl

                    this.#contentRange.selectNodeContents(root)
                    const layout = beforeRender?.({
                        vertical,
                        rtl,
                        background,
                        imagePage: doc.documentElement.hasAttribute('data-reader-image-page'),
                    })
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
                    finishResolve()
                } catch (err) {
                    finishReject(err)
                }
            }
            this.#iframe.addEventListener('load', onLoad, { once: true })
            this.#iframe.addEventListener('error', onError, { once: true })
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
    scrolled({ gap, columnWidth, inlineLeft = gap, inlineRight = gap, safeTop = 0, safeBottom = 0 }) {
        const doc = this.#activeDocument
        if (!this.#isCurrent(doc)) return
        const vertical = this.#vertical
        const padTop = Math.max(gap, safeTop)
        const padBottom = Math.max(gap, safeBottom)
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${padTop}px 0 ${padBottom}px 0` : `0 ${inlineRight}px 0 ${inlineLeft}px`,
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
            'column-width': `${columnWidth}px`,
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
        const { width, height, gap, columnWidth } = this.#layout
        const vertical = this.#vertical
        for (const el of root.querySelectorAll('img, svg, video')) {
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height}px`,
                'max-width': vertical
                    ? `${width}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
        if (doc.documentElement.hasAttribute('data-reader-image-page')) {
            const media = root.querySelector('img, svg, video')
            const availableWidth = Math.max(1, this.#column
                ? (vertical ? width : columnWidth)
                : Math.min(columnWidth || width, Math.max(1, width - (gap || 0) * 2)))
            const rawAvailableHeight = this.#column
                ? (vertical ? columnWidth : height)
                : Math.max(1, height)
            const availableHeight = Math.max(1, Math.floor(rawAvailableHeight) - (vertical ? 0 : 1))
            const parsePxAttr = (el, attr) => {
                const raw = el?.getAttribute?.(attr)?.trim()
                if (!raw || raw.endsWith('%')) return 0
                const m = /^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i.exec(raw)
                return m ? parseFloat(m[1]) : 0
            }
            const box = media?.viewBox?.baseVal
            const innerImg = media?.localName === 'svg' ? media.querySelector('image') : null
            const intrinsicWidth = (box?.width > 0 ? box.width : 0)
                || media?.naturalWidth || media?.videoWidth
                || parsePxAttr(media, 'width') || parsePxAttr(innerImg, 'width')
            const intrinsicHeight = (box?.height > 0 ? box.height : 0)
                || media?.naturalHeight || media?.videoHeight
                || parsePxAttr(media, 'height') || parsePxAttr(innerImg, 'height')
            const hasRatio = intrinsicWidth > 0 && intrinsicHeight > 0
            const scale = hasRatio
                ? Math.min(availableWidth / intrinsicWidth, availableHeight / intrinsicHeight) : 1
            for (let el = media?.parentElement; el && el !== doc.documentElement; el = el.parentElement) {
                setStylesImportant(el, this.#column ? {
                    display: 'flex', 'align-items': 'center', 'justify-content': 'center',
                    width: `${availableWidth}px`, height: `${availableHeight}px`,
                    'min-height': '0', 'max-width': 'none',
                    margin: '0', padding: '0', 'box-sizing': 'border-box',
                    'break-before': 'auto', 'break-after': 'auto', 'text-indent': '0',
                } : {
                    display: 'flex', 'align-items': 'center', 'justify-content': 'center',
                    width: '100%', 'max-width': `${availableWidth}px`, height: 'auto', 'min-height': `${availableHeight}px`,
                    margin: '0 auto', padding: '0', 'box-sizing': 'border-box',
                    'break-before': 'auto', 'break-after': 'auto', 'text-indent': '0',
                })
            }
            if (media) {
                if (media.localName === 'svg') {
                    media.setAttribute('preserveAspectRatio', 'xMidYMid meet')
                    if (innerImg) innerImg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
                } else if (media.localName === 'img' && !media.complete && !media.dataset.readerImageBound) {
                    media.dataset.readerImageBound = '1'
                    media.addEventListener('load', () => {
                        if (this.#isCurrent(doc)) {
                            this.setImageSize()
                            this.expand()
                        }
                    }, { once: true })
                }
                setStylesImportant(media, {
                    display: 'block',
                    width: `${hasRatio ? intrinsicWidth * scale : availableWidth}px`,
                    height: `${hasRatio ? intrinsicHeight * scale : availableHeight}px`,
                    'max-width': `${availableWidth}px`,
                    'max-height': `${availableHeight}px`,
                    margin: '0',
                    'break-before': 'auto',
                    'break-after': 'auto',
                    'object-fit': 'contain',
                })
            }
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
            // Tolerate minor subpixel rounding / fractional DPR glyph spill without losing real pages.
            const tolerance = Math.min(2, this.#size * 0.01)
            const pageCount = Math.max(1, Math.ceil((contentSize - tolerance) / this.#size))
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
            const { margin, marginTop = margin, marginBottom = margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${marginTop}px 0 ${marginBottom}px 0`
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
        if (this.#pendingLoadCancel) {
            try { this.#pendingLoadCancel(new DOMException('Section load superseded', 'AbortError')) } catch {}
            this.#pendingLoadCancel = null
        }
        this.#detachDocument()
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'margin-inline', 'margin-top', 'margin-bottom',
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
    #navIdleWaiters = new Set()
    #destroyed = false
    #displayGeneration = 0
    #pendingViews = new Set()
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #isCustomSliding = false
    #slideDragState = null
    #lastVisibleRange
    #relocateTimeout = null
    #lockedAnchor = null
    #isPointerSelecting = false
    #isKeyboardSelecting = false
    #checkPointerSelection = null
    #lastResizeTime = 0
    #globalPointerUpListener = null
    #globalPointerDownListener = null
    #globalBlurListener = null
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
            --_gap: 6%;
            --_margin: 48px;
            --_margin-top: var(--_margin);
            --_margin-bottom: var(--_margin);
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_inline-outer: var(--_half-gap);
            --_inline-inner: var(--_half-gap);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(max(var(--_inline-outer), var(--safe-left, 0px)), 1fr)
                var(--_inline-inner)
                minmax(0, calc(var(--_max-width) - var(--_inline-inner) * 2))
                var(--_inline-inner)
                minmax(max(var(--_inline-outer), var(--safe-right, 0px)), 1fr);
            grid-template-rows:
                minmax(calc(var(--safe-top, 0px) + var(--_margin-top)), 1fr)
                minmax(0, var(--_max-height))
                minmax(calc(var(--safe-bottom, 0px) + var(--_margin-bottom)), 1fr);
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
            @container (max-width: 559px) {
                &:not(.vertical) {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
            }
        }
        :host([margin-inline]) #top:not(.vertical) {
            --_inline-outer: 0px;
            --_inline-inner: var(--_margin-inline);
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
            padding-top: var(--safe-top, 0px);
            height: calc(var(--safe-top, 0px) + var(--_margin-top));
            box-sizing: border-box;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
            padding-bottom: var(--safe-bottom, 0px);
            height: calc(var(--safe-bottom, 0px) + var(--_margin-bottom));
            box-sizing: border-box;
        }
        #header, #footer {
            display: grid;
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
            } else if (!this.#isCustomSliding && this.pages > 0 && this.size > 0) {
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
        this.addEventListener('touchcancel', this.#onTouchCancel.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
            doc.addEventListener('touchcancel', this.#onTouchCancel.bind(this))
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
        this.#globalPointerDownListener = () => this.#clearPointerSelecting()
        this.#globalBlurListener = () => this.#clearPointerSelecting()
        window.addEventListener('pointerup', this.#globalPointerUpListener)
        window.addEventListener('pointercancel', this.#globalPointerUpListener)
        window.addEventListener('pointerdown', this.#globalPointerDownListener)
        window.addEventListener('blur', this.#globalBlurListener)
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('pointerdown', () => {
                this.#clearPointerSelecting()
                if (Date.now() - this.#lastResizeTime >= 300) {
                    this.#isPointerSelecting = true
                }
            })
            doc.addEventListener('mousedown', () => {
                this.#isKeyboardSelecting = false
            })
            doc.addEventListener('pointerup', this.#globalPointerUpListener)
            doc.addEventListener('pointercancel', this.#globalPointerUpListener)
            doc.defaultView?.addEventListener('pointerup', this.#globalPointerUpListener)
            doc.defaultView?.addEventListener('pointercancel', this.#globalPointerUpListener)
            doc.defaultView?.addEventListener('blur', () => this.#clearPointerSelecting())
            doc.addEventListener('blur', () => this.#clearPointerSelecting())
            doc.addEventListener('keydown', e => {
                if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                    this.#isKeyboardSelecting = true
                } else {
                    this.#isKeyboardSelecting = false
                }
            })
            doc.addEventListener('keyup', () => {
                this.#isKeyboardSelecting = false
            })
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                if (Date.now() - this.#lastResizeTime < 1000) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (this.#isPointerSelecting && sel.type === 'Range')
                    this.#checkPointerSelection(range, sel)
                else if (this.#isKeyboardSelecting) {
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
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'margin-inline':
            case 'margin-top':
            case 'margin-bottom':
                if (value != null && String(value).trim() !== '')
                    this.#top.style.setProperty('--_' + name, value)
                else
                    this.#top.style.removeProperty('--_' + name)
                this.render()
                break
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.#destroyed = false
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
    #measureContainerSide(prop) {
        const container = this.#container
        if (!container) return 0
        const rectVal = container.getBoundingClientRect?.()?.[prop] || 0
        const clientVal = prop === 'width' ? container.clientWidth
            : prop === 'height' ? container.clientHeight : rectVal
        if (rectVal > 0 && clientVal > 0) return Math.floor(Math.min(clientVal, rectVal))
        return Math.floor(clientVal || rectVal || 0)
    }
    #beforeRender({ vertical, rtl, background, imagePage = this.#view?.document?.documentElement.hasAttribute('data-reader-image-page') }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.#background.style.background = background

        const width = this.#measureContainerSide('width')
        const height = this.#measureContainerSide('height')
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin')) || 0
        const marginTopRaw = parseFloat(style.getPropertyValue('--_margin-top'))
        const marginBottomRaw = parseFloat(style.getPropertyValue('--_margin-bottom'))
        const marginTop = Number.isFinite(marginTopRaw) ? marginTopRaw : margin
        const marginBottom = Number.isFinite(marginBottomRaw) ? marginBottomRaw : margin
        const safeTop = parseFloat(style.getPropertyValue('--safe-top')) || 0
        const safeBottom = parseFloat(style.getPropertyValue('--safe-bottom')) || 0
        const safeLeft = parseFloat(style.getPropertyValue('--safe-left')) || 0
        const safeRight = parseFloat(style.getPropertyValue('--safe-right')) || 0
        const marginInlineRaw = this.hasAttribute('margin-inline')
            ? parseFloat(style.getPropertyValue('--_margin-inline'))
            : NaN
        const useExplicitInlineMargin = !vertical && Number.isFinite(marginInlineRaw) && marginInlineRaw >= 0

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
        const defaultGap = -g / (g - 1) * size
        const gap = useExplicitInlineMargin
            ? Math.min(marginInlineRaw * 2, Math.max(0, size * 0.45))
            : defaultGap

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize
            const scrolledMarginTop = vertical ? marginTop : Math.max(0, marginTop + safeTop)
            const scrolledMarginBottom = vertical ? marginBottom : Math.max(0, marginBottom + safeBottom)
            const inlineLeft = useExplicitInlineMargin
                ? marginInlineRaw + safeLeft
                : Math.max(defaultGap, safeLeft)
            const inlineRight = useExplicitInlineMargin
                ? marginInlineRaw + safeRight
                : Math.max(defaultGap, safeRight)
            this.#margin = vertical ? margin : scrolledMarginTop

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return {
                flow,
                margin,
                marginTop: scrolledMarginTop,
                marginBottom: scrolledMarginBottom,
                gap,
                inlineLeft,
                inlineRight,
                safeTop,
                safeBottom,
                columnWidth,
                width,
                height,
            }
        }

        this.#margin = margin
        const divisor = imagePage ? 1 : Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
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
        this.#isKeyboardSelecting = false
        this.#checkPointerSelection?.cancel?.()
    }
    clearLockedAnchor() {
        this.#lockedAnchor = null
    }
    setAnchor(anchor, isLocked = true) {
        if (this.#relocateTimeout) {
            clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = null
        }
        if (anchor) {
            this.#anchor = anchor
            if (isLocked) this.#lockedAnchor = anchor
            else this.#lockedAnchor = null
        } else {
            this.#lockedAnchor = null
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
            // Fast-path flip was pending (< 160ms).
            // Only recalculate visible range if container column size didn't change (e.g. blank area click
            // toggling reader UI bars changes height only, not width).
            // If width did change, calculating getVisibleRange() before view.render() would use mismatched
            // dimensions against the old columns.
            const sizeChanged = this.#view?.size && Math.abs(this.size - this.#view.size) > 1
            if (!sizeChanged) {
                const range = this.#getVisibleRange()
                if (range) {
                    this.#lastVisibleRange = range
                    this.#anchor = range
                }
            } else if (!this.#anchor && this.#lastVisibleRange) {
                this.#anchor = this.#lastVisibleRange
            }
        } else if (this.scrolled) {
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
        return this.#measureContainerSide(this.sideProp)
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
        this.#lockedAnchor = null
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
    getSlideDragContext() {
        if (this.scrolled || !this.#view || this.#vertical) return null
        const stride = this.size
        const pages = this.pages
        const page = this.page
        if (!(stride > 0) || pages <= 0) return null
        const canPrevPage = page > 1
        const canNextPage = page < pages - 2
        const hasPrevSec = this.#adjacentIndex(-1) != null
        const hasNextSec = this.#adjacentIndex(1) != null
        return {
            stride,
            page,
            pages,
            isRtl: Boolean(this.#rtl),
            isVertical: Boolean(this.#vertical),
            canVisualLeftInSection: this.#rtl ? canNextPage : canPrevPage,
            canVisualRightInSection: this.#rtl ? canPrevPage : canNextPage,
            canVisualLeft: this.#rtl ? (canNextPage || hasNextSec) : (canPrevPage || hasPrevSec),
            canVisualRight: this.#rtl ? (canPrevPage || hasPrevSec) : (canNextPage || hasNextSec),
        }
    }
    // Snapshot geometry belongs to the paginator that owns column layout. Reading
    // these contexts never scrolls, changes section/CFI, or fires relocate.
    getPageSnapshotContext(direction = 'current', viewport = this) {
        const ctx = this.getSlideDragContext()
        const doc = this.#view?.document
        if (!ctx || !doc || this.isNavBusy() || ctx.isVertical) return null
        const visualDir = Number.isInteger(direction) ? direction
            : direction === 'next' ? 1 : direction === 'prev' ? -1 : 0
        const target = ctx.page + (ctx.isRtl ? -visualDir : visualDir)
        // A different section is still shown by the established DOM slide path.
        if (target < 1 || target > ctx.pages - 2) return null
        const frameElement = doc.defaultView?.frameElement
        const frame = frameElement?.getBoundingClientRect()
        const bounds = viewport.getBoundingClientRect()
        if (!frame || !(bounds.width > 0 && bounds.height > 0)) return null
        const relative = rect => ({ x: rect.left - bounds.left, y: rect.top - bounds.top,
            width: rect.width, height: rect.height })
        const overlay = this.#view.overlayer
        const paper = getComputedStyle(this.#background)
        // The live DOM retains textured paper / external part filters verbatim.
        if (paper.backgroundImage !== 'none' || getComputedStyle(frameElement).filter !== 'none') return null
        const bg = paper.backgroundColor
        const fallback = getComputedStyle(document.documentElement).getPropertyValue('--book-bg').trim() || '#ffffff'
        return { doc, index: this.#index, page: target, direction: ctx.isRtl ? 'rtl' : 'ltr', width: bounds.width, height: bounds.height,
            frame: relative(frame), offsetX: -visualDir * ctx.stride,
            background: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : fallback,
            overlay, overlayRect: overlay?.element ? relative(overlay.element.getBoundingClientRect()) : null }
    }
    // The outer animation already showed the destination. Use the paginator's
    // normal relocation path without taking the native gesture debounce lock.
    async commitRenderedPage(visualDir) {
        const ctx = this.getSlideDragContext()
        if (!ctx || this.isNavBusy() || this.#isCustomSliding) return false
        const page = ctx.page + (ctx.isRtl ? -visualDir : visualDir)
        if (page < 1 || page > ctx.pages - 2) return false
        this.#isKeyboardSelecting = false
        await this.#scrollToPage(page, 'page', false)
        return true
    }
    beginSlideDrag() {
        const ctx = this.getSlideDragContext()
        if (!ctx) return null
        if (this.#relocateTimeout) {
            clearTimeout(this.#relocateTimeout)
            this.#relocateTimeout = null
        }
        const maxPage = Math.max(1, ctx.pages - 2)
        const basePage = Math.max(1, Math.min(maxPage, ctx.page))
        const baseOffset = ctx.stride * (this.#rtl ? -basePage : basePage)
        const offA = ctx.stride * (this.#rtl ? -1 : 1)
        const offB = ctx.stride * (this.#rtl ? -maxPage : maxPage)
        this.#isCustomSliding = true
        this.#slideDragState = {
            ...ctx,
            basePage,
            baseOffset,
            minOffset: Math.min(offA, offB),
            maxOffset: Math.max(offA, offB),
        }
        return this.#slideDragState
    }
    setSlideDragOffset(screenDx) {
        const s = this.#slideDragState
        if (!this.#isCustomSliding || !s || this.scrolled || this.#vertical) return
        const rawTarget = s.baseOffset - screenDx
        const clamped = Math.max(s.minOffset, Math.min(s.maxOffset, rawTarget))
        this.#container[this.scrollProp] = clamped
    }
    async endSlideDrag({ commitVisualDir = 0 } = {}) {
        const s = this.#slideDragState
        this.#isCustomSliding = false
        this.#slideDragState = null
        if (!s || this.scrolled || this.#vertical) return
        this.#lockedAnchor = null
        const maxPage = Math.max(1, this.pages - 2)
        const logicalDir = commitVisualDir ? (this.#rtl ? -commitVisualDir : commitVisualDir) : 0
        const targetPage = Math.max(1, Math.min(maxPage, s.basePage + logicalDir))
        if (commitVisualDir !== 0 && targetPage !== s.basePage) {
            await this.#scrollToPage(targetPage, 'page', false)
            if (!this.#pendingNav && this.#relocateTimeout) this.settle()
        } else {
            const restoreOffset = s.baseOffset
            this.#container[this.scrollProp] = restoreOffset
            this.#scrollBounds = [restoreOffset, this.atStart ? 0 : this.size, this.atEnd ? 0 : this.size]
        }
    }
    #getCustomTouchController() {
        if (this.scrolled) return null
        const ctrl = globalThis.app?.pageTurnController
        if (!ctrl) return null
        if (typeof ctrl.shouldHandlePaginatorTouch === 'function') {
            return ctrl.shouldHandlePaginatorTouch() ? ctrl : null
        }
        if (typeof ctrl.getEffectiveMode !== 'function') return null
        const mode = ctrl.getEffectiveMode()
        return (mode === 'slide' || mode === 'cover' || mode === 'none') ? ctrl : null
    }
    #releaseTouchState() {
        const state = this.#touchState
        this.#touchState = null
        state?.releaseSectionSwap?.()
        return state
    }
    #onTouchStart(e) {
        const previousTouch = this.#releaseTouchState()
        const ctrl = this.#getCustomTouchController()
        if (!e.touches || e.touches.length !== 1) {
            if (previousTouch?.delegatedToController) {
                ctrl?.handleTouchCancel?.({ sourceEvent: e })
            }
            return
        }
        const touch = e.changedTouches[0] || e.touches[0]
        const frameEl = e.currentTarget && e.currentTarget !== this
            ? e.currentTarget.defaultView?.frameElement
            : null
        const frameRect = frameEl?.getBoundingClientRect?.()
        const hasFrameOffset = Boolean(frameRect)
        const frameOffsetLeft = frameRect ? frameRect.left : 0
        const frameOffsetTop = frameRect ? frameRect.top : 0
        const startScrollLeft = this.#container?.scrollLeft || 0
        const startScrollTop = this.#container?.scrollTop || 0
        const startViewportX = touch ? (hasFrameOffset ? frameOffsetLeft + touch.clientX : touch.clientX) : 0
        const startViewportY = touch ? (hasFrameOffset ? frameOffsetTop + touch.clientY : touch.clientY) : 0
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            startScreenX: touch?.screenX ?? 0,
            startScreenY: touch?.screenY ?? 0,
            hasFrameOffset,
            frameOffsetLeft,
            frameOffsetTop,
            startScrollLeft,
            startScrollTop,
            startViewportX,
            startViewportY,
            delegatedToController: Boolean(ctrl),
            document: hasFrameOffset ? e.currentTarget : null,
            t: e.timeStamp,
            vx: 0, vy: 0,
        }
        if (ctrl && touch) {
            ctrl.handleTouchStart({
                sourceEvent: e,
                target: e.target,
                touches: [{ clientX: startViewportX, clientY: startViewportY }],
            })
        }
    }
    #getTouchViewportPoint(touch, state) {
        const { clientX, clientY } = touch
        if (!state.hasFrameOffset) return { clientX, clientY }
        const scrollLeft = this.#container.scrollLeft - state.startScrollLeft
        const scrollTop = this.#container.scrollTop - state.startScrollTop
        return { clientX: state.frameOffsetLeft - scrollLeft + clientX,
            clientY: state.frameOffsetTop - scrollTop + clientY }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (!state || state.pinched) return
        state.pinched = (globalThis.visualViewport?.scale ?? 1) > 1.02
        if (this.scrolled || state.pinched) {
            if (state.delegatedToController) {
                globalThis.app?.pageTurnController?.handleTouchCancel?.({ sourceEvent: e })
                state.delegatedToController = false
                state.releaseSectionSwap?.()
            }
            return
        }
        if (state.delegatedToController) {
            const ctrl = this.#getCustomTouchController()
            if (ctrl) {
                if (e.touches.length > 1) {
                    ctrl.handleTouchCancel?.({ sourceEvent: e })
                    state.delegatedToController = false
                    state.releaseSectionSwap?.()
                    return
                }
                const touch = e.changedTouches[0] || e.touches[0]
                if (touch) {
                    ctrl.handleTouchMove({
                        sourceEvent: e,
                        target: e.target,
                        cancelable: e.cancelable,
                        preventDefault: () => { if (e.cancelable) e.preventDefault() },
                        touches: [this.#getTouchViewportPoint(touch, state)],
                    })
                    this.#touchScrolled = Boolean(ctrl.isGestureActive)
                }
                return
            }
            state.delegatedToController = false
            state.releaseSectionSwap?.()
        }
        if (e.touches.length > 1) {
            if (this.#touchScrolled && e.cancelable) e.preventDefault()
            return
        }
        const touch = e.changedTouches[0] || e.touches[0]
        if (!touch) return
        const x = touch.screenX, y = touch.screenY
        const adx = Math.abs(x - (state.startScreenX ?? x))
        const ady = Math.abs(y - (state.startScreenY ?? y))
        if (!this.#touchScrolled) {
            if (adx < 8 && ady < 8) return
            if (ady > adx && adx < ady * 1.2) {
                this.#releaseTouchState()
                return
            }
        }
        if (e.cancelable) e.preventDefault()
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dt > 0 ? dx / dt : 0
        state.vy = dt > 0 ? dy / dt : 0
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchCancel(e) {
        const state = this.#releaseTouchState()
        this.#touchScrolled = false
        if (state?.delegatedToController) {
            const ctrl = this.#getCustomTouchController()
            ctrl?.handleTouchCancel?.({ sourceEvent: e })
        }
    }
    #onTouchEnd(e) {
        const state = this.#releaseTouchState()
        this.#touchScrolled = false
        if (this.scrolled) return
        if (state?.delegatedToController) {
            const ctrl = this.#getCustomTouchController()
            if (ctrl) {
                const touch = e.changedTouches?.[0]
                ctrl.handleTouchEnd({ sourceEvent: e, touches: e.touches,
                    changedTouches: touch ? [this.#getTouchViewportPoint(touch, state)] : [] })
                return
            }
        }
        if (!state) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if ((globalThis.visualViewport?.scale ?? 1) === 1)
                this.snap(state.vx, state.vy)
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
            this.#justAnchored = false
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
        this.#lockedAnchor = null
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
        this.#lockedAnchor = null
        if (!this.#relocateTimeout) return
        clearTimeout(this.#relocateTimeout)
        this.#relocateTimeout = null
        if (!this.#view?.document) return

        const range = this.#getVisibleRange()
        if (range) {
            this.#lastVisibleRange = range
            this.#anchor = range
        }

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
        if (reason === 'page' || reason === 'snap' || reason === 'scroll') {
            this.#lockedAnchor = null
        }
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
        else if (this.scrolled) this.#justAnchored = true
        else this.#justAnchored = false

        detail.range = range
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const generation = ++this.#displayGeneration
        const { index, src, anchor, onLoad, select } = await promise
        if (generation !== this.#displayGeneration) return
        if (!Number.isInteger(index)) return
        const hasFocus = this.#view?.document?.hasFocus()

        if (src) {
            const previous = this.#view
            const view = this.#createView({ pending: true })
            this.#pendingViews.add(view)
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
            const prevIndex = this.#index
            try {
                await view.load(src, afterLoad, this.#beforeRender.bind(this))
                // Touch events belong to the original iframe for their whole
                // sequence. Keep it attached through release or cancellation,
                // bounded by a safety timeout so a dropped touchend can never deadlock #locked.
                let touch = this.#touchState
                while (generation === this.#displayGeneration && touch?.delegatedToController &&
                    touch.document === previous?.document) {
                    let timedOut = false
                    await new Promise(resolve => {
                        const timer = setTimeout(() => {
                            timedOut = true
                            resolve()
                        }, 1500)
                        touch.releaseSectionSwap = () => {
                            clearTimeout(timer)
                            resolve()
                        }
                    })
                    if (timedOut && this.#touchState === touch) {
                        this.#releaseTouchState()
                        break
                    }
                    touch = this.#touchState
                }
                if (generation !== this.#displayGeneration) {
                    view.destroy()
                    view.element.remove()
                    return
                }

                // Keep previous view visible while styles, DOM normalization, and overlayer attach
                // to the hidden pending view, then swap and scroll atomically to prevent blank flashes.
                this.#view = view
                this.#index = index
                onLoad?.({ doc: view.document, index })
                this.dispatchEvent(new CustomEvent('create-overlayer', {
                    detail: {
                        doc: view.document, index,
                        attach: overlayer => view.overlayer = overlayer,
                    },
                }))

                previous?.destroy()
                previous?.element?.remove()
                Object.assign(view.element.style, {
                    visibility: '',
                    position: 'relative',
                    inset: '',
                    pointerEvents: '',
                })
            } catch (err) {
                if (this.#view === view) {
                    this.#view = previous || null
                    this.#index = prevIndex
                }
                view.destroy()
                view.element.remove()
                throw err
            } finally {
                this.#pendingViews.delete(view)
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
    async #goTo({ index, anchor, select, reload = false }) {
        if (index === this.#index && !reload) await this.#display({ index, anchor, select })
        else {
            const oldIndex = this.#index
            let settled = false
            const onLoad = detail => {
                settled = true
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            const section = this.sections[index]
            if (!section || typeof section.load !== 'function') {
                const err = new Error(`Section ${index} is missing or unloaded`)
                try { err.sectionIndex = index } catch {}
                throw err
            }
            const loadedPromise = Promise.resolve(section.load())
                .then(src => {
                    if (typeof src !== 'string' || !src) {
                        throw new Error(`Section ${index} returned empty content`)
                    }
                    return { index, src, anchor, onLoad, select }
                })
                .catch(error => {
                    try { error.sectionIndex = index } catch {}
                    throw error
                })
            try {
                await this.#display(loadedPromise)
            } finally {
                if (!settled) {
                    loadedPromise.then(d => {
                        if (d?.src) this.sections[index]?.unload?.()
                    }, () => {})
                }
            }
        }
    }
    async goTo(target) {
        this.#lockedAnchor = null
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
            } else {
                this.#notifyNavIdle(true)
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
        if (page <= 0) return true
        return this.#scrollToPage(page, 'page', true).then(() => false)
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
        if (page >= pages - 1) return true
        return this.#scrollToPage(page, 'page', true).then(() => false)
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
        this.#lockedAnchor = null
        this.#isKeyboardSelecting = false
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
            if (!this.#pendingNav && this.#relocateTimeout) this.settle()
        } catch (err) {
            console.warn('Paginator #turnPage error:', err)
            if (err?.name !== 'AbortError') {
                this.dispatchEvent(new CustomEvent('section-load-error', {
                    detail: { error: err, index: Number.isInteger(err?.sectionIndex) ? err.sectionIndex : this.#index },
                }))
            }
        } finally {
            this.#locked = false
            if (this.#pendingNav) {
                const next = this.#pendingNav
                this.#pendingNav = null
                this.goTo(next.target).then(next.resolve, next.reject)
            } else {
                this.#notifyNavIdle(true)
            }
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    get locked() {
        return Boolean(this.#locked)
    }
    get isTransitionBusy() {
        if (this.#destroyed) return false
        return Boolean(this.#locked || this.#pendingNav || this.#pendingViews.size > 0)
    }
    isNavBusy() {
        if (this.#destroyed) return false
        return Boolean(this.#locked || this.#pendingNav || this.#pendingViews.size > 0)
    }
    #notifyNavIdle(ok = true) {
        if (ok && this.isNavBusy()) return
        if (this.#navIdleWaiters.size > 0) {
            const waiters = [...this.#navIdleWaiters]
            this.#navIdleWaiters.clear()
            for (const waiter of waiters) {
                waiter.cleanup()
                waiter.resolve(Boolean(ok))
            }
        }
        try {
            this.dispatchEvent(new CustomEvent('nav-idle', { detail: { ok: Boolean(ok) } }))
        } catch {}
    }
    whenNavIdle({ signal, timeoutMs = 0 } = {}) {
        if (this.#destroyed || signal?.aborted) return Promise.resolve(false)
        if (!this.isNavBusy()) return Promise.resolve(true)
        return new Promise((resolve) => {
            let timer = null
            const onAbort = () => {
                this.#navIdleWaiters.delete(waiter)
                waiter.cleanup()
                resolve(false)
            }
            const waiter = {
                resolve,
                cleanup: () => {
                    if (timer != null) {
                        clearTimeout(timer)
                        timer = null
                    }
                    signal?.removeEventListener?.('abort', onAbort)
                },
            }
            this.#navIdleWaiters.add(waiter)
            signal?.addEventListener?.('abort', onAbort, { once: true })
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this.#navIdleWaiters.delete(waiter)
                    waiter.cleanup()
                    resolve(!this.isNavBusy())
                }, timeoutMs)
            }
        })
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
        this.#destroyed = true
        ++this.#displayGeneration
        this.#releaseTouchState()
        this.#locked = false
        this.#isCustomSliding = false
        this.#slideDragState = null
        if (this.#pendingNav) {
            try { this.#pendingNav.resolve(false) } catch {}
            this.#pendingNav = null
        }
        this.#notifyNavIdle(false)
        for (const pendingView of this.#pendingViews) {
            try { pendingView?.destroy?.() } catch {}
            try { pendingView?.element?.remove?.() } catch {}
        }
        this.#pendingViews.clear()
        this.settle()
        if (this.#globalPointerUpListener) {
            window.removeEventListener('pointerup', this.#globalPointerUpListener)
            window.removeEventListener('pointercancel', this.#globalPointerUpListener)
            this.#globalPointerUpListener = null
        }
        if (this.#globalPointerDownListener) {
            window.removeEventListener('pointerdown', this.#globalPointerDownListener)
            this.#globalPointerDownListener = null
        }
        if (this.#globalBlurListener) {
            window.removeEventListener('blur', this.#globalBlurListener)
            this.#globalBlurListener = null
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
