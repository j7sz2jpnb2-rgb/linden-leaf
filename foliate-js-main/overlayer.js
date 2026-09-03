const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

// Extract ONLY pure TextNode client rects, strictly discarding full-width block element (<p>, <div>, <h*>) rects
const getTextRects = range => {
    if (!range) return []
    try {
        const doc = range.startContainer?.ownerDocument || document
        const pageContainer = doc.getElementById('page-container')
        const cRect = pageContainer?.getBoundingClientRect ? pageContainer.getBoundingClientRect() : null
        const offsetX = cRect ? cRect.left : 0
        const offsetY = cRect ? cRect.top : 0

        const extractFromList = list => {
            const res = []
            for (const r of list) {
                if (r.width >= 2 && r.height >= 2) {
                    res.push({
                        left: r.left - offsetX,
                        top: r.top - offsetY,
                        right: r.right - offsetX,
                        bottom: r.bottom - offsetY,
                        width: r.width,
                        height: r.height
                    })
                }
            }
            return res
        }

        if (range.startContainer.nodeType === Node.TEXT_NODE && range.startContainer === range.endContainer) {
            return mergeLineRects(extractFromList(Array.from(range.getClientRects())))
        }

        const commonAncestor = range.commonAncestorContainer
        const root = commonAncestor.nodeType === Node.TEXT_NODE ? commonAncestor.parentNode : commonAncestor
        const treeWalker = doc.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: node => {
                    if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_SKIP
                    if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
                    return NodeFilter.FILTER_ACCEPT
                }
            }
        )

        const textRects = []
        let node = treeWalker.nextNode()
        while (node) {
            const nodeRange = doc.createRange()
            const start = (node === range.startContainer) ? range.startOffset : 0
            const end = (node === range.endContainer) ? range.endOffset : node.nodeValue.length
            if (start < end) {
                nodeRange.setStart(node, start)
                nodeRange.setEnd(node, end)
                textRects.push(...extractFromList(Array.from(nodeRange.getClientRects())))
            }
            node = treeWalker.nextNode()
        }

        if (textRects.length > 0) return mergeLineRects(textRects, writingMode)
    } catch (e) {
        console.warn('getTextRects error:', e)
    }

    return mergeLineRects(extractFromList(Array.from(range.getClientRects())), writingMode)
}

const mergeLineRects = (rects, writingMode) => {
    if (!rects || rects.length <= 1) return rects || []
    const isVertical = writingMode === 'vertical-rl' || writingMode === 'vertical-lr'

    if (isVertical) {
        const sorted = [...rects].sort((a, b) => {
            const colDiff = writingMode === 'vertical-rl' ? b.right - a.right : a.left - b.left
            return Math.abs(colDiff) > 6 ? colDiff : a.top - b.top
        })
        const merged = []
        let current = null
        for (const r of sorted) {
            if (!current) {
                current = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
                continue
            }
            const sameColumn = Math.abs(r.left - current.left) < Math.max(r.width, current.width) * 0.55
            const contiguous = r.top <= current.bottom + 6 && r.bottom >= current.top
            if (sameColumn && contiguous) {
                current.left = Math.min(current.left, r.left)
                current.right = Math.max(current.right, r.right)
                current.top = Math.min(current.top, r.top)
                current.bottom = Math.max(current.bottom, r.bottom)
                current.width = current.right - current.left
                current.height = current.bottom - current.top
            } else {
                merged.push(current)
                current = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
            }
        }
        if (current) merged.push(current)
        return merged
    }
    
    // Sort in natural reading order
    const sorted = [...rects].sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left))
    const merged = []
    let current = null

    for (const r of sorted) {
        if (!current) {
            current = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
            continue
        }

        const sameLine = Math.abs(r.top - current.top) < Math.max(r.height, current.height) * 0.55
        const contiguous = r.left <= current.right + 6 && r.right >= current.left

        if (sameLine && contiguous) {
            current.left = Math.min(current.left, r.left)
            current.right = Math.max(current.right, r.right)
            current.top = Math.min(current.top, r.top)
            current.bottom = Math.max(current.bottom, r.bottom)
            current.width = current.right - current.left
            current.height = current.bottom - current.top
        } else {
            merged.push(current)
            current = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        }
    }
    if (current) merged.push(current)
    return merged
}

export class Overlayer {
    #svg = createSVGElement('svg')
    #map = new Map()
    constructor() {
        Object.assign(this.#svg.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none',
        })
    }
    get element() {
        return this.#svg
    }
    add(key, range, draw, options = {}) {
        if (this.#map.has(key)) this.remove(key)
        if (typeof range === 'function') range = range(this.#svg.getRootNode())
        const rects = getTextRects(range, options?.writingMode)
        const element = draw(rects, options)
        this.#svg.append(element)
        this.#map.set(key, { range, draw, options, element, rects })
    }
    remove(key) {
        if (!this.#map.has(key)) return
        const el = this.#map.get(key)?.element
        if (el && el.parentNode === this.#svg) {
            this.#svg.removeChild(el)
        }
        this.#map.delete(key)
    }
    clear() {
        while (this.#svg.firstChild) this.#svg.removeChild(this.#svg.firstChild)
        this.#map.clear()
    }
    redraw() {
        for (const obj of this.#map.values()) {
            const { range, draw, options, element } = obj
            if (element && element.parentNode === this.#svg) {
                this.#svg.removeChild(element)
            }
            const r = typeof range === 'function' ? range(this.#svg.getRootNode()) : range
            const rects = getTextRects(r, options?.writingMode)
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
    }
    hitTest(e) {
        const doc = this.#svg.ownerDocument || document
        const pageContainer = doc.getElementById('page-container')
        const cRect = pageContainer?.getBoundingClientRect ? pageContainer.getBoundingClientRect() : null
        const offsetX = cRect ? cRect.left : 0
        const offsetY = cRect ? cRect.top : 0
        const x = (e?.clientX ?? e?.x ?? 0) - offsetX
        const y = (e?.clientY ?? e?.y ?? 0) - offsetY
        const arr = Array.from(this.#map.entries())
        // loop in reverse to hit more recently added items first
        for (let i = arr.length - 1; i >= 0; i--) {
            const [key, obj] = arr[i]
            for (const { left, top, right, bottom } of obj.rects) {
                if (top - 3 <= y && left - 3 <= x && bottom + 3 >= y && right + 3 >= x) {
                    return [key, obj.range]
                }
            }
        }
        return []
    }
    static underline(rects, options = {}) {
        const { color = '#2563eb', width: strokeWidth = 2.6, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
            for (const { right, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', right - strokeWidth)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        } else {
            for (const { left, bottom, width } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', left)
                el.setAttribute('y', bottom - strokeWidth + 0.5)
                el.setAttribute('height', strokeWidth)
                el.setAttribute('width', width)
                el.setAttribute('rx', 1)
                g.append(el)
            }
        }
        return g
    }
    static dashed(rects, options = {}) {
        const { color = '#64748b', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        g.setAttribute('stroke-dasharray', '4,3')
        g.setAttribute('stroke-linecap', 'round')
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
            for (const { right, top, height } of rects) {
                const el = createSVGElement('line')
                el.setAttribute('x1', right - 1)
                el.setAttribute('y1', top)
                el.setAttribute('x2', right - 1)
                el.setAttribute('y2', top + height)
                g.append(el)
            }
        } else {
            for (const { left, bottom, width } of rects) {
                const el = createSVGElement('line')
                el.setAttribute('x1', left)
                el.setAttribute('y1', bottom - 1)
                el.setAttribute('x2', left + width)
                el.setAttribute('y2', bottom - 1)
                g.append(el)
            }
        }
        return g
    }
    static strikethrough(rects, options = {}) {
        const { color = '#ef4444', width: strokeWidth = 2.5, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
            for (const { right, left, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', (right + left) / 2)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        } else {
            for (const { left, top, bottom, width } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', left)
                el.setAttribute('y', (top + bottom) / 2)
                el.setAttribute('height', strokeWidth)
                el.setAttribute('width', width)
                g.append(el)
            }
        }
        return g
    }
    static squiggly(rects, options = {}) {
        const { color = '#f97316', width: strokeWidth = 2.2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        const block = strokeWidth * 1.5
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
            for (const { right, top, height } of rects) {
                const el = createSVGElement('path')
                const n = Math.round(height / block / 1.5)
                const inline = height / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
                el.setAttribute('d', `M${right} ${top}${ls}`)
                g.append(el)
            }
        } else {
            for (const { left, bottom, width } of rects) {
                const el = createSVGElement('path')
                const n = Math.round(width / block / 1.5)
                const inline = width / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
                el.setAttribute('d', `M${left} ${bottom}${ls}`)
                g.append(el)
            }
        }
        return g
    }
    static highlight(rects, options = {}) {
        const { color = '#f43f5e', realisticPen = true } = options
        const g = createSVGElement('g')
        g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, multiply)'

        const filterId = 'wechat-subtle-soak'
        if (g.getRootNode) {
            const root = g.getRootNode()
            const svgEl = root?.querySelector ? root.querySelector('svg') : null
            if (svgEl && !svgEl.querySelector('#' + filterId)) {
                const defs = createSVGElement('defs')
                defs.innerHTML = `
                    <filter id="${filterId}" x="-3%" y="-8%" width="106%" height="116%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="0.4" result="soak"/>
                        <feMerge>
                            <feMergeNode in="soak" opacity="0.32"/>
                            <feMergeNode in="SourceGraphic"/>
                        </feMerge>
                    </filter>
                `
                svgEl.prepend(defs)
            }
        }

        const total = rects.length
        for (let i = 0; i < total; i++) {
            const rect = rects[i]
            const prevRect = i > 0 ? rects[i - 1] : null
            const nextRect = i < total - 1 ? rects[i + 1] : null

            // Physical line start / end detection
            const isLineStart = !prevRect || (rect.top > prevRect.bottom - 4) || (rect.top > prevRect.top + prevRect.height * 0.6)
            const isLineEnd = !nextRect || (nextRect.top > rect.bottom - 4) || (nextRect.top > rect.top + rect.height * 0.6)

            const left = rect.left
            const top = rect.top + 1
            const bottom = rect.bottom - 1
            const right = rect.right
            const width = right - left
            const height = bottom - top
            const midY = (top + bottom) * 0.5

            if (realisticPen) {
                // Deterministic pseudo-random seed based on line position and index
                const seedVal = Math.abs(Math.sin(rect.left * 17.13 + rect.top * 83.47 + i * 43.19 + rect.width * 7.31) * 43758.5453)
                const v = Math.floor((seedVal % 1) * 12) % 12

                let d = ''

                if (isLineStart && isLineEnd) {
                    // Full standalone line (poetry line, short paragraph, heading):
                    // 12 Authentic WeChat Read Profiles with Soft Filleted Corners & Micro-curves
                    switch (v) {
                        case 0: // 1. WeChat Line 1 classic: Soft rounded entry, top micro-wave, delicate vertical soft cap on right
                            d = `M ${left + 3.5},${top + 0.5}
                                 Q ${left + width * 0.5},${top - 0.5} ${right - 3.5},${top}
                                 Q ${right},${top} ${right},${top + 3.5}
                                 L ${right},${bottom - 3.5}
                                 Q ${right},${bottom} ${right - 3.5},${bottom}
                                 Q ${left + width * 0.5},${bottom + 0.5} ${left + 3.5},${bottom}
                                 Q ${left},${bottom} ${left},${bottom - 3.5}
                                 L ${left},${top + 3.5}
                                 Q ${left},${top} ${left + 3.5},${top + 0.5} Z`
                            break

                        case 1: // 2. WeChat Line 2 classic: Soft chisel entry, right side gentle forward tilt with water-meniscus curve
                            d = `M ${left + 4.5},${top}
                                 Q ${left + width * 0.5},${top + 0.3} ${right - 2},${top}
                                 Q ${right + 1.2},${top + 1.8} ${right + 1.5},${midY}
                                 Q ${right + 1.2},${bottom - 1.8} ${right - 1},${bottom}
                                 Q ${left + width * 0.5},${bottom - 0.3} ${left + 2},${bottom}
                                 Q ${left - 0.2},${bottom} ${left + 0.5},${bottom - 2.5}
                                 Q ${left + 2.0},${midY} ${left + 3.5},${top + 1.5}
                                 Q ${left + 4.0},${top} ${left + 4.5},${top} Z`
                            break

                        case 2: // 3. WeChat Line 3 classic: Soft vertical entry, right side gentle tilt with rounded corners
                            d = `M ${left + 3.5},${top + 0.5}
                                 Q ${left + width * 0.5},${top - 0.3} ${right + 0.5},${top}
                                 Q ${right + 1.8},${top + 1} ${right + 1.5},${top + 3}
                                 Q ${right + 0.2},${midY} ${right - 1.5},${bottom - 2.5}
                                 Q ${right - 2.5},${bottom} ${right - 4},${bottom}
                                 Q ${left + width * 0.5},${bottom + 0.4} ${left + 3.5},${bottom}
                                 Q ${left},${bottom} ${left},${bottom - 3.5}
                                 L ${left},${top + 3.5}
                                 Q ${left},${top} ${left + 3.5},${top + 0.5} Z`
                            break

                        case 3: // 4. Line 4: Clean horizontal with subtle hand-glide arc on right
                            d = `M ${left + 3.5},${top}
                                 Q ${left + width * 0.5},${top + 0.4} ${right - 3},${top}
                                 Q ${right + 2},${midY} ${right - 3},${bottom}
                                 Q ${left + width * 0.5},${bottom - 0.4} ${left + 3.5},${bottom}
                                 Q ${left},${midY} ${left + 3.5},${top} Z`
                            break

                        case 4: // 5. Line 5: Reverse Chisel Tilt with smooth round tip
                            d = `M ${left + 2},${top + 1}
                                 Q ${left + width * 0.5},${top - 0.4} ${right - 2},${top}
                                 Q ${right + 0.8},${top} ${right + 1.0},${top + 2.5}
                                 Q ${right + 0.5},${midY} ${right - 1.5},${bottom - 2}
                                 Q ${right - 2.5},${bottom} ${right - 4.5},${bottom}
                                 Q ${left + width * 0.5},${bottom + 0.3} ${left + 3},${bottom}
                                 Q ${left},${bottom} ${left + 0.5},${bottom - 3}
                                 L ${left + 1},${top + 3}
                                 Q ${left + 1},${top} ${left + 2},${top + 1} Z`
                            break

                        case 5: // 6. Line 6: Dual Parallel Soft Stroke with smooth water tension
                            d = `M ${left + 4.5},${top}
                                 Q ${left + width * 0.5},${top + 0.2} ${right + 0.5},${top}
                                 Q ${right + 1.8},${top + 1.5} ${right + 1.5},${top + 3.5}
                                 Q ${right + 0.5},${midY} ${right - 1.5},${bottom - 2}
                                 Q ${right - 2.5},${bottom} ${right - 4.5},${bottom}
                                 Q ${left + width * 0.5},${bottom - 0.2} ${left},${bottom}
                                 Q ${left - 1.0},${bottom} ${left - 0.5},${bottom - 3}
                                 Q ${left + 1.5},${midY} ${left + 3},${top + 2}
                                 Q ${left + 3.5},${top} ${left + 4.5},${top} Z`
                            break

                        case 6: // 7. Line 7: Subtle S-Curve Waist Squeeze
                            d = `M ${left + 3.5},${top + 0.5}
                                 Q ${left + width * 0.3},${top - 0.5} ${left + width * 0.7},${top + 0.5}
                                 Q ${right},${top} ${right - 1},${top + 3.5}
                                 L ${right - 1.5},${bottom - 3.5}
                                 Q ${right - 1},${bottom} ${right - 3.5},${bottom}
                                 Q ${left + width * 0.7},${bottom - 0.5} ${left + width * 0.3},${bottom + 0.5}
                                 Q ${left},${bottom} ${left},${bottom - 3.5}
                                 L ${left},${top + 3.5}
                                 Q ${left},${top} ${left + 3.5},${top + 0.5} Z`
                            break

                        case 7: // 8. Line 8: Droplet soft entry with vertical flat chisel release
                            d = `M ${left + 4},${top}
                                 Q ${left + width * 0.5},${top - 0.3} ${right - 3.5},${top}
                                 Q ${right},${top} ${right},${top + 3.5}
                                 L ${right},${bottom - 3.5}
                                 Q ${right},${bottom} ${right - 3.5},${bottom}
                                 Q ${left + width * 0.5},${bottom + 0.3} ${left + 4},${bottom}
                                 Q ${left - 1},${midY} ${left + 4},${top} Z`
                            break

                        case 8: // 9. Line 9: Fast Stroke with smooth tapered lift-off
                            d = `M ${left + 3},${top + 0.8}
                                 Q ${left + width * 0.5},${top} ${right - 2},${top}
                                 Q ${right + 1},${midY} ${right - 4.5},${bottom}
                                 Q ${left + width * 0.5},${bottom} ${left + 2},${bottom}
                                 Q ${left},${midY} ${left + 3},${top + 0.8} Z`
                            break

                        case 9: // 10. Line 10: Heavy solid stroke with soft rounded corners
                            d = `M ${left + 4},${top}
                                 L ${right - 4},${top}
                                 Q ${right},${top} ${right},${top + 4}
                                 L ${right},${bottom - 4}
                                 Q ${right},${bottom} ${right - 4},${bottom}
                                 L ${left + 4},${bottom}
                                 Q ${left},${bottom} ${left},${bottom - 4}
                                 L ${left},${top + 4}
                                 Q ${left},${top} ${left + 4},${top} Z`
                            break

                        case 10: // 11. Line 11: Upward gentle tilt with rounded tip
                            d = `M ${left + 3},${top + 1}
                                 Q ${left + width * 0.5},${top - 0.6} ${right - 1},${top - 0.5}
                                 Q ${right + 1.5},${top + 1} ${right + 1},${top + 3}
                                 L ${right - 1},${bottom - 2}
                                 Q ${right - 2},${bottom} ${right - 4},${bottom}
                                 Q ${left + width * 0.5},${bottom + 0.4} ${left + 2},${bottom}
                                 Q ${left},${midY} ${left + 3},${top + 1} Z`
                            break

                        case 11:
                        default: // 12. Line 12: Standard Organic Highlighter
                            d = `M ${left + 3.5},${top + 0.3}
                                 Q ${left + width * 0.5},${top - 0.3} ${right - 3.5},${top + 0.2}
                                 Q ${right + 0.5},${midY} ${right - 3.5},${bottom - 0.2}
                                 Q ${left + width * 0.5},${bottom + 0.3} ${left + 3.5},${bottom - 0.3}
                                 Q ${left - 0.5},${midY} ${left + 3.5},${top + 0.3} Z`
                            break
                    }
                } else if (isLineStart) {
                    if (v % 2 === 0) {
                        d = `M ${left + 5},${top} Q ${left + width * 0.5},${top - 0.2} ${right},${top} L ${right},${bottom} Q ${left + width * 0.5},${bottom + 0.2} ${left},${bottom} L ${left + 5},${top} Z`
                    } else {
                        d = `M ${left + 3.5},${top} Q ${left + width * 0.5},${top + 0.2} ${right},${top} L ${right},${bottom} Q ${left + width * 0.5},${bottom - 0.2} ${left + 3.5},${bottom} Q ${left},${midY} ${left + 3.5},${top} Z`
                    }
                } else if (isLineEnd) {
                    if (v % 3 === 0) {
                        d = `M ${left},${top} Q ${left + width * 0.5},${top - 0.2} ${right + 0.5},${top} Q ${right + 2.5},${top + 2} ${right - 2.5},${bottom - 2} Q ${right - 4},${bottom} ${right - 6},${bottom} Q ${left + width * 0.5},${bottom + 0.2} ${left},${bottom} Z`
                    } else if (v % 3 === 1) {
                        d = `M ${left},${top} Q ${left + width * 0.5},${top + 0.2} ${right - 2},${top} Q ${right + 1.5},${top + 3} ${right + 2.5},${bottom - 3} Q ${right + 2.5},${bottom} ${right - 1},${bottom} Q ${left + width * 0.5},${bottom - 0.2} ${left},${bottom} Z`
                    } else {
                        d = `M ${left},${top} Q ${left + width * 0.5},${top - 0.2} ${right - 3.5},${top} Q ${right},${top} ${right},${top + 3.5} L ${right},${bottom - 3.5} Q ${right},${bottom} ${right - 3.5},${bottom} Q ${left + width * 0.5},${bottom + 0.2} ${left},${bottom} Z`
                    }
                } else {
                    d = `M ${left},${top} Q ${left + width * 0.5},${top + (v % 2 === 0 ? 0.3 : -0.3)} ${right},${top} L ${right},${bottom} Q ${left + width * 0.5},${bottom + (v % 2 === 0 ? -0.3 : 0.3)} ${left},${bottom} Z`
                }

                const path = createSVGElement('path')
                path.setAttribute('d', d)
                path.setAttribute('fill', color)
                path.setAttribute('filter', `url(#${filterId})`)
                path.style.opacity = 'var(--overlayer-highlight-opacity, .26)'
                g.append(path)

                // Line 1 WeChat Read detail: Delicate soft lift-off mark
                if (v === 0 && (isLineEnd || (isLineStart && isLineEnd))) {
                    const tail = createSVGElement('path')
                    tail.setAttribute('d', `M ${right - 2.5},${top + 1} Q ${right + 1},${midY} ${right - 1.5},${bottom - 1} L ${right - 3.5},${bottom - 1} Q ${right - 1},${midY} ${right - 3.5},${top + 1} Z`)
                    tail.setAttribute('fill', color)
                    tail.style.opacity = '0.16'
                    g.append(tail)
                }
            } else {
                const el = createSVGElement('rect')
                el.setAttribute('x', rect.left)
                el.setAttribute('y', rect.top)
                el.setAttribute('height', rect.height)
                el.setAttribute('width', rect.width)
                el.setAttribute('rx', 3.5)
                el.setAttribute('ry', 3.5)
                el.setAttribute('fill', color)
                el.style.opacity = 'var(--overlayer-highlight-opacity, .28)'
                g.append(el)
            }
        }
        return g
    }
    static outline(rects, options = {}) {
        return Overlayer.searchMatch(rects, options)
    }
    static searchMatch(rects, options = {}) {
        const { color = '#f59e0b', active = false } = options
        const g = createSVGElement('g')
        g.setAttribute('class', 'search-match-highlight')
        for (const { left, top, height, width } of rects) {
            // Luminous background highlight
            const bg = createSVGElement('rect')
            bg.setAttribute('x', left - 1)
            bg.setAttribute('y', top - 1)
            bg.setAttribute('height', height + 2)
            bg.setAttribute('width', width + 2)
            bg.setAttribute('rx', 2.5)
            bg.setAttribute('fill', active ? '#ff6d00' : '#facc15')
            bg.setAttribute('opacity', active ? '0.75' : '0.42')
            bg.style.mixBlendMode = 'multiply'
            g.append(bg)

            // Crisp highlight border
            const border = createSVGElement('rect')
            border.setAttribute('x', left - 1)
            border.setAttribute('y', top - 1)
            border.setAttribute('height', height + 2)
            border.setAttribute('width', width + 2)
            border.setAttribute('rx', 2.5)
            border.setAttribute('fill', 'none')
            border.setAttribute('stroke', active ? '#ea580c' : '#d97706')
            border.setAttribute('stroke-width', active ? '2.2' : '1.2')
            g.append(border)
        }
        return g
    }
    static copyImage([rect], options = {}) {
        const { src } = options
        const image = createSVGElement('image')
        const { left, top, height, width } = rect
        image.setAttribute('href', src)
        image.setAttribute('x', left)
        image.setAttribute('y', top)
        image.setAttribute('height', height)
        image.setAttribute('width', width)
        return image
    }
}
