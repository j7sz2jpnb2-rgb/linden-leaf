/**
 * epub-range-editor.js
 * Interactive EPUB/TXT highlight range editing:
 * - Start/end teardrop SVG drag handles inside Foliate section documents
 * - Live translucent range preview while dragging without intermediate DB writes
 * - CJK & English sentence boundary snapping (double-click handle or action button)
 * - Keyboard single-character boundary nudging (Shift+ArrowLeft/Right, Alt+Shift+ArrowLeft/Right)
 *
 * Pure DOM/Foliate geometry module: persistence is delegated via callbacks.
 */

const BLOCK_SELECTOR = 'p, li, blockquote, dd, dt, pre, h1, h2, h3, h4, h5, h6, div, section, article'
const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '；', '.', '!', '?', '\n'])
const TRAILING_CLOSERS = new Set(['”', '’', '」', '』', '）', '】', '"', "'", ')', ']', '》', '〉'])
const LEADING_OPENERS_SKIP = new Set([' ', '\t', '\r', '\n', '　'])

/**
 * Pure string offset expansion to surrounding CJK/English sentence boundaries.
 * Exported directly for unit testing without DOM dependencies.
 */
export function expandTextRangeOffsetsToSentence(fullText, startOffset, endOffset) {
    const text = String(fullText || '')
    const len = text.length
    if (!len) return { start: 0, end: 0 }

    let s = Math.max(0, Math.min(len, Number(startOffset) || 0))
    let e = Math.max(s, Math.min(len, Number(endOffset) || s))

    // Walk backward until after the previous sentence terminator (skip leading closers right next to it)
    while (s > 0) {
        const ch = text[s - 1]
        if (SENTENCE_TERMINATORS.has(ch)) break
        // Stop before paragraph boundary whitespace after sentence end
        if (ch === '\n') break
        s--
    }
    while (s < e && LEADING_OPENERS_SKIP.has(text[s])) {
        s++
    }

    // Walk forward until inclusive of the next sentence terminator and any closing quote/bracket
    while (e < len) {
        const ch = text[e]
        if (ch === '\n') break
        e++
        if (SENTENCE_TERMINATORS.has(ch)) {
            while (e < len && TRAILING_CLOSERS.has(text[e])) {
                e++
            }
            break
        }
    }
    while (e > s && LEADING_OPENERS_SKIP.has(text[e - 1])) {
        e--
    }

    return { start: s, end: e }
}

function collectBlockTextSegments(blockEl) {
    const doc = blockEl?.ownerDocument
    if (!doc) return { segments: [], totalText: '' }
    const segments = []
    let cursor = 0
    const walker = doc.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
        acceptNode: node => {
            if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_SKIP
            const parent = node.parentElement
            if (parent?.closest?.('[data-linden-range-editor], .linden-bilingual-target, .linden-inline-translation, [data-injected-translation]')) {
                return NodeFilter.FILTER_REJECT
            }
            return NodeFilter.FILTER_ACCEPT
        }
    })
    let n = walker.nextNode()
    while (n) {
        const len = n.nodeValue.length
        segments.push({ node: n, start: cursor, end: cursor + len })
        cursor += len
        n = walker.nextNode()
    }
    return {
        segments,
        totalText: segments.map(seg => seg.node.nodeValue).join('')
    }
}

function resolveDomPointFromOffset(segments, targetOffset) {
    if (!segments.length) return null
    const clamped = Math.max(0, targetOffset)
    for (const seg of segments) {
        if (clamped >= seg.start && clamped <= seg.end) {
            return { node: seg.node, offset: clamped - seg.start }
        }
    }
    const last = segments[segments.length - 1]
    return { node: last.node, offset: last.node.nodeValue.length }
}

function findOffsetFromDomPoint(segments, node, offset) {
    if (!segments.length) return null
    for (const seg of segments) {
        if (seg.node === node) {
            return seg.start + Math.max(0, Math.min(seg.node.nodeValue.length, offset))
        }
    }
    return null
}

function normalizeBoundaryTextPoint(range, which) {
    const isStart = which === 'start'
    const rawNode = isStart ? range.startContainer : range.endContainer
    const rawOffset = isStart ? range.startOffset : range.endOffset
    if (rawNode?.nodeType === 3) {
        return { node: rawNode, offset: rawOffset }
    }
    const doc = range.startContainer?.ownerDocument || document
    const root = range.commonAncestorContainer?.nodeType === 3
        ? range.commonAncestorContainer.parentElement
        : (rawNode || doc.body)
    const { segments } = collectBlockTextSegments(root || doc.body)
    if (!segments.length) return null
    for (const seg of segments) {
        if (range.intersectsNode(seg.node)) {
            if (isStart) return { node: seg.node, offset: 0 }
        }
    }
    const last = segments[segments.length - 1]
    return { node: last.node, offset: last.node.nodeValue.length }
}

export function expandDomRangeToSentenceBoundary(range) {
    if (!range) return null
    const doc = range.startContainer?.ownerDocument
    if (!doc) return null
    const commonEl = range.commonAncestorContainer?.nodeType === 3
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer
    const blockEl = commonEl?.closest?.(BLOCK_SELECTOR) || commonEl || doc.body
    const { segments, totalText } = collectBlockTextSegments(blockEl)
    if (!segments.length || !totalText.trim()) return null

    const startPt = normalizeBoundaryTextPoint(range, 'start')
    const endPt = normalizeBoundaryTextPoint(range, 'end')
    if (!startPt || !endPt) return null

    const sOff = findOffsetFromDomPoint(segments, startPt.node, startPt.offset)
    const eOff = findOffsetFromDomPoint(segments, endPt.node, endPt.offset)
    if (sOff == null || eOff == null) return null

    const expanded = expandTextRangeOffsetsToSentence(totalText, Math.min(sOff, eOff), Math.max(sOff, eOff))
    if (expanded.end <= expanded.start) return null

    const nextStart = resolveDomPointFromOffset(segments, expanded.start)
    const nextEnd = resolveDomPointFromOffset(segments, expanded.end)
    if (!nextStart || !nextEnd) return null

    const nextRange = doc.createRange()
    nextRange.setStart(nextStart.node, nextStart.offset)
    nextRange.setEnd(nextEnd.node, nextEnd.offset)
    return nextRange
}

export function nudgeDomRangeBoundary(range, which = 'end', delta = 1) {
    if (!range) return null
    const doc = range.startContainer?.ownerDocument
    if (!doc) return null
    const root = doc.body || doc.documentElement
    const { segments, totalText } = collectBlockTextSegments(root)
    if (!segments.length || !totalText.length) return null

    const startPt = normalizeBoundaryTextPoint(range, 'start')
    const endPt = normalizeBoundaryTextPoint(range, 'end')
    if (!startPt || !endPt) return null

    let sOff = findOffsetFromDomPoint(segments, startPt.node, startPt.offset)
    let eOff = findOffsetFromDomPoint(segments, endPt.node, endPt.offset)
    if (sOff == null || eOff == null) return null
    if (sOff > eOff) [sOff, eOff] = [eOff, sOff]

    const chars = Array.from(totalText)
    // Convert UTF-16 code unit offset -> codepoint index -> UTF-16 code unit offset
    const utf16ToCp = target => {
        let cu = 0
        for (let i = 0; i < chars.length; i++) {
            if (cu >= target) return i
            cu += chars[i].length
        }
        return chars.length
    }
    const cpToUtf16 = cpIdx => {
        let cu = 0
        const limit = Math.max(0, Math.min(chars.length, cpIdx))
        for (let i = 0; i < limit; i++) cu += chars[i].length
        return cu
    }

    let sCp = utf16ToCp(sOff)
    let eCp = utf16ToCp(eOff)
    if (which === 'start') {
        sCp = Math.max(0, Math.min(eCp - 1, sCp + delta))
    } else {
        eCp = Math.max(sCp + 1, Math.min(chars.length, eCp + delta))
    }

    const nextStart = resolveDomPointFromOffset(segments, cpToUtf16(sCp))
    const nextEnd = resolveDomPointFromOffset(segments, cpToUtf16(eCp))
    if (!nextStart || !nextEnd) return null

    const nextRange = doc.createRange()
    nextRange.setStart(nextStart.node, nextStart.offset)
    nextRange.setEnd(nextEnd.node, nextEnd.offset)
    return nextRange
}

function getCaretFromClientPoint(doc, clientX, clientY) {
    if (!doc) return null
    if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(clientX, clientY)
        if (pos?.offsetNode) {
            return { node: pos.offsetNode, offset: pos.offset }
        }
    }
    if (typeof doc.caretRangeFromPoint === 'function') {
        const r = doc.caretRangeFromPoint(clientX, clientY)
        if (r?.startContainer) {
            return { node: r.startContainer, offset: r.startOffset }
        }
    }
    return null
}

function comparePoints(aNode, aOffset, bNode, bOffset, doc) {
    try {
        const rA = doc.createRange()
        rA.setStart(aNode, aOffset)
        rA.collapse(true)
        const rB = doc.createRange()
        rB.setStart(bNode, bOffset)
        rB.collapse(true)
        return rA.compareBoundaryPoints(Range.START_TO_START, rB)
    } catch {
        return 0
    }
}

function isVerticalMode(writingMode) {
    return writingMode === 'vertical-rl' || writingMode === 'vertical-lr'
}

export class EpubRangeEditor {
    constructor({ onCommit, onCancel, getWritingMode } = {}) {
        this.onCommit = onCommit
        this.onCancel = onCancel
        this.getWritingMode = getWritingMode || (() => 'horizontal')
        this._session = null
        this._overlayHost = null
        this._dragState = null
        this._nudgeTimer = null
        this._nudgePendingRange = null
        this._docListeners = []
    }

    get isActive() {
        return Boolean(this._session)
    }

    get activeHighlight() {
        return this._session?.highlight || null
    }

    attach({ highlight, range, sectionIndex, foliateView, color = '#d4a644' }) {
        this.hide({ commitPending: false })
        if (!highlight || !range || !range.startContainer?.ownerDocument) return
        const doc = range.startContainer.ownerDocument
        this._session = {
            highlight: { ...highlight },
            originalRange: range.cloneRange(),
            currentRange: range.cloneRange(),
            sectionIndex,
            foliateView,
            doc,
            color,
        }
        this._renderHandlesAndPreview(this._session.currentRange, false)
        this._bindDocListeners(doc)
    }

    hide({ commitPending = false } = {}) {
        clearTimeout(this._nudgeTimer)
        if (commitPending && this._nudgePendingRange && this._session) {
            const pending = this._nudgePendingRange
            this._nudgePendingRange = null
            this._commitRange(pending)
        }
        this._nudgePendingRange = null
        this._dragState = null
        this._unbindDocListeners()
        if (this._overlayHost) {
            this._overlayHost.remove()
            this._overlayHost = null
        }
        this._session = null
    }

    snapToSentence() {
        if (!this._session) return false
        const nextRange = expandDomRangeToSentenceBoundary(this._session.currentRange)
        if (!nextRange || !nextRange.toString().trim()) return false
        this._session.currentRange = nextRange
        this._renderHandlesAndPreview(nextRange, false)
        this._commitRange(nextRange)
        return true
    }

    _bindDocListeners(doc) {
        this._unbindDocListeners()
        const onKeydown = e => {
            if (!this._session) return
            const activeEl = doc.activeElement || (typeof document !== 'undefined' ? document.activeElement : null)
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                const orig = this._session.originalRange
                this._renderHandlesAndPreview(orig, false)
                this.hide({ commitPending: false })
                this.onCancel?.()
                return
            }
            if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
            e.preventDefault()
            e.stopPropagation()
            const which = e.altKey ? 'start' : 'end'
            const delta = e.key === 'ArrowRight' ? 1 : -1
            const base = this._nudgePendingRange || this._session.currentRange
            const nudged = nudgeDomRangeBoundary(base, which, delta)
            if (!nudged || !nudged.toString().trim()) return
            this._session.currentRange = nudged
            this._nudgePendingRange = nudged
            this._renderHandlesAndPreview(nudged, true)
            clearTimeout(this._nudgeTimer)
            this._nudgeTimer = setTimeout(() => {
                if (!this._session || !this._nudgePendingRange) return
                const toCommit = this._nudgePendingRange
                this._nudgePendingRange = null
                this._commitRange(toCommit)
            }, 260)
        }
        doc.addEventListener('keydown', onKeydown, true)
        this._docListeners.push([doc, 'keydown', onKeydown, true])
        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', onKeydown, true)
            this._docListeners.push([window, 'keydown', onKeydown, true])
        }
    }

    _unbindDocListeners() {
        for (const [target, type, fn, capture] of this._docListeners) {
            try { target.removeEventListener(type, fn, capture) } catch {}
        }
        this._docListeners = []
    }

    _ensureOverlayHost(doc) {
        if (this._overlayHost && this._overlayHost.ownerDocument === doc && doc.body?.contains(this._overlayHost)) {
            return this._overlayHost
        }
        const host = doc.createElement('div')
        host.setAttribute('data-linden-range-editor', 'true')
        host.className = 'linden-range-editor-overlay'
        Object.assign(host.style, {
            position: 'fixed',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '2147483000',
        })
        doc.body.appendChild(host)
        this._overlayHost = host
        return host
    }

    _renderHandlesAndPreview(range, showPreview = false) {
        if (!this._session || !range) return
        const { doc, color } = this._session
        const host = this._ensureOverlayHost(doc)
        host.replaceChildren()

        const rects = Array.from(range.getClientRects()).filter(r => r.width >= 1 && r.height >= 1)
        if (!rects.length) return

        if (showPreview) {
            for (const r of rects) {
                const band = doc.createElement('div')
                Object.assign(band.style, {
                    position: 'fixed',
                    left: `${r.left}px`,
                    top: `${r.top}px`,
                    width: `${r.width}px`,
                    height: `${r.height}px`,
                    background: color || '#d4a644',
                    opacity: '0.26',
                    borderRadius: '3px',
                    pointerEvents: 'none',
                })
                host.appendChild(band)
            }
        }

        const first = rects[0]
        const last = rects[rects.length - 1]
        const vertical = isVerticalMode(this.getWritingMode())

        const startX = vertical ? (first.left + first.width / 2) : first.left
        const startY = vertical ? first.top : first.top
        const endX = vertical ? (last.left + last.width / 2) : last.right
        const endY = vertical ? last.bottom : last.bottom

        host.appendChild(this._createHandleEl('start', startX, startY, first.height, vertical, color))
        host.appendChild(this._createHandleEl('end', endX, endY, last.height, vertical, color))
    }

    _createHandleEl(role, x, y, lineH, vertical, color) {
        const doc = this._session.doc
        const handle = doc.createElement('div')
        handle.dataset.handleRole = role
        const accent = color || '#d4a644'
        const size = 14
        const stemH = Math.max(12, Math.min(26, Math.round(lineH || 18)))

        Object.assign(handle.style, {
            position: 'fixed',
            left: `${Math.round(x - 14)}px`,
            top: role === 'start'
                ? `${Math.round(y - size - 2)}px`
                : `${Math.round(y - stemH)}px`,
            width: '28px',
            height: `${size + stemH + 8}px`,
            pointerEvents: 'auto',
            cursor: vertical ? 'ns-resize' : 'ew-resize',
            touchAction: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: role === 'start' ? 'flex-start' : 'flex-end',
            userSelect: 'none',
        })

        const svgNs = 'http://www.w3.org/2000/svg'
        const svg = doc.createElementNS(svgNs, 'svg')
        svg.setAttribute('width', '20')
        svg.setAttribute('height', String(size + stemH + 4))
        svg.setAttribute('viewBox', `0 0 20 ${size + stemH + 4}`)
        svg.style.overflow = 'visible'

        const stem = doc.createElementNS(svgNs, 'line')
        stem.setAttribute('x1', '10')
        stem.setAttribute('x2', '10')
        stem.setAttribute('stroke', accent)
        stem.setAttribute('stroke-width', '2.2')
        stem.setAttribute('stroke-linecap', 'round')

        const knob = doc.createElementNS(svgNs, 'circle')
        knob.setAttribute('cx', '10')
        knob.setAttribute('r', '6')
        knob.setAttribute('fill', accent)
        knob.setAttribute('stroke', '#ffffff')
        knob.setAttribute('stroke-width', '1.8')

        if (role === 'start') {
            knob.setAttribute('cy', '7')
            stem.setAttribute('y1', '12')
            stem.setAttribute('y2', String(size + stemH))
        } else {
            stem.setAttribute('y1', '2')
            stem.setAttribute('y2', String(stemH + 2))
            knob.setAttribute('cy', String(stemH + 9))
        }

        svg.append(stem, knob)
        handle.appendChild(svg)

        handle.addEventListener('dblclick', e => {
            e.preventDefault()
            e.stopPropagation()
            this.snapToSentence()
        })

        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 && e.pointerType === 'mouse') return
            e.preventDefault()
            e.stopPropagation()
            try { handle.setPointerCapture(e.pointerId) } catch {}
            const fixed = role === 'start'
                ? { node: this._session.currentRange.endContainer, offset: this._session.currentRange.endOffset }
                : { node: this._session.currentRange.startContainer, offset: this._session.currentRange.startOffset }
            this._dragState = {
                role,
                pointerId: e.pointerId,
                fixed,
                previewRange: this._session.currentRange.cloneRange(),
            }
        })

        handle.addEventListener('pointermove', e => {
            if (!this._dragState || this._dragState.pointerId !== e.pointerId) return
            e.preventDefault()
            e.stopPropagation()
            const caret = getCaretFromClientPoint(doc, e.clientX, e.clientY)
            if (!caret) return
            const { fixed } = this._dragState
            if (caret.node === fixed.node && caret.offset === fixed.offset) return
            const cmp = comparePoints(caret.node, caret.offset, fixed.node, fixed.offset, doc)
            const r = doc.createRange()
            try {
                if (cmp <= 0) {
                    r.setStart(caret.node, caret.offset)
                    r.setEnd(fixed.node, fixed.offset)
                } else {
                    r.setStart(fixed.node, fixed.offset)
                    r.setEnd(caret.node, caret.offset)
                }
                if (r.toString().trim().length === 0) return
                this._dragState.previewRange = r
                this._renderHandlesAndPreview(r, true)
            } catch {
                // Ignore cross-boundary transient points during drag
            }
        })

        const finishDrag = e => {
            if (!this._dragState || this._dragState.pointerId !== e.pointerId) return
            e.preventDefault()
            e.stopPropagation()
            try { handle.releasePointerCapture(e.pointerId) } catch {}
            const nextRange = this._dragState.previewRange
            this._dragState = null
            if (nextRange && nextRange.toString().trim()) {
                this._session.currentRange = nextRange
                this._renderHandlesAndPreview(nextRange, false)
                this._commitRange(nextRange)
            } else if (this._session?.originalRange) {
                this._renderHandlesAndPreview(this._session.originalRange, false)
            }
        }
        handle.addEventListener('pointerup', finishDrag)
        handle.addEventListener('pointercancel', finishDrag)

        return handle
    }

    _commitRange(nextRange) {
        if (!this._session || !nextRange) return
        const { highlight, sectionIndex, foliateView } = this._session
        const newText = nextRange.toString().trim()
        if (!newText || !foliateView?.getCFI) return
        let newCfi = null
        try {
            newCfi = foliateView.getCFI(sectionIndex, nextRange)
        } catch (err) {
            console.warn('[EpubRangeEditor] Failed to compute CFI:', err)
            return
        }
        if (!newCfi || (newCfi === highlight.cfi && newText === highlight.text)) return
        const prevHighlight = { ...highlight }
        this._session.highlight = { ...highlight, cfi: newCfi, text: newText }
        this._session.originalRange = nextRange.cloneRange()
        this.onCommit?.({
            oldHighlight: prevHighlight,
            newCfi,
            newText,
            newRange: nextRange,
        })
    }
}
