// js/ocr-layout.js
// Pure PP-OCRv6 pre/post-processing, CTC decoding, per-character box projection,
// and horizontal / vertical / two-column reading-order layout engine.
// Zero DOM or Worker runtime dependencies so it can be unit-tested directly in Node.

const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u30ff]/

function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v)
}

function unquoteYamlScalar(raw) {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/''/g, "'")
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        try {
            return JSON.parse(trimmed)
        } catch (_) {
            return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        }
    }
    return trimmed
}

/**
 * Parse character dictionary from either PaddleX `inference.yml` (`PostProcess.character_dict`)
 * or plain newline-separated `ppocrv6_dict.txt` into a CTC lookup table:
 * index 0 = '' (CTC blank), 1..N = characters, N+1 = ' ' (space char).
 *
 * @param {string} rawText
 * @param {{ useSpaceChar?: boolean }} [options]
 * @returns {string[]}
 */
export function parsePaddleInferenceYmlDict(rawText, options = {}) {
    if (typeof rawText !== 'string' || !rawText) return ['', ' ']
    const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.split('\n')
    const dictHeaderIdx = lines.findIndex(line => /^\s*character_dict\s*:\s*$/.test(line))

    let useSpaceChar = options.useSpaceChar
    if (useSpaceChar === undefined) {
        const spaceLine = lines.find(line => /^\s*use_space_char\s*:\s*(true|false)\s*$/i.test(line))
        if (spaceLine) {
            useSpaceChar = /true/i.test(spaceLine)
        } else {
            useSpaceChar = true
        }
    }

    const tokens = []
    if (dictHeaderIdx >= 0) {
        const headerIndent = lines[dictHeaderIdx].search(/\S/)
        for (let i = dictHeaderIdx + 1; i < lines.length; i++) {
            const line = lines[i]
            if (!line.trim()) continue
            const indent = line.search(/\S/)
            if (indent <= headerIndent && !/^\s*-/.test(line)) break
            const listMatch = line.match(/^\s*-\s?(.*)$/)
            if (!listMatch) {
                if (/^[A-Za-z0-9_]+\s*:/.test(line.trim())) break
                continue
            }
            const token = unquoteYamlScalar(listMatch[1])
            if (token === '' && listMatch[1] === ' ') {
                tokens.push(' ')
            } else if (token.length > 0) {
                tokens.push(token)
            }
        }
    } else {
        for (const line of lines) {
            if (line === '') continue
            tokens.push(line)
        }
    }

    const vocab = ['']
    for (const tok of tokens) vocab.push(tok)
    if (useSpaceChar) {
        vocab.push(' ')
    }
    return vocab
}

/**
 * DBNet post-processing on a probability map [mapW x mapH].
 * Extracts 8-connected components above `thresh`, filters by `boxThresh` & `minSide`,
 * applies DBNet unclip expansion, and rescales boxes back into [srcW x srcH] image coordinates.
 *
 * @param {Float32Array | number[]} probMap
 * @param {number} mapW
 * @param {number} mapH
 * @param {number} srcW
 * @param {number} srcH
 * @param {object} [options]
 * @returns {Array<{ x0: number, y0: number, x1: number, y1: number, w: number, h: number, score: number }>}
 */
export function dbPostProcess(probMap, mapW, mapH, srcW, srcH, options = {}) {
    if (!probMap || mapW <= 0 || mapH <= 0 || srcW <= 0 || srcH <= 0) return []
    const {
        thresh = 0.2,
        boxThresh = 0.45,
        unclipRatio = 1.4,
        minSide = 3,
        maxCandidates = 3000
    } = options

    const total = mapW * mapH
    if (probMap.length < total) return []

    const visited = new Uint8Array(total)
    const queue = new Int32Array(total)
    const scaleX = srcW / mapW
    const scaleY = srcH / mapH
    const candidates = []

    const dx = [-1, 0, 1, -1, 1, -1, 0, 1]
    const dy = [-1, -1, -1, 0, 0, 1, 1, 1]

    for (let y = 0; y < mapH; y++) {
        const rowOff = y * mapW
        for (let x = 0; x < mapW; x++) {
            const startIdx = rowOff + x
            if (visited[startIdx] || probMap[startIdx] <= thresh) continue

            visited[startIdx] = 1
            let head = 0
            let tail = 0
            queue[tail++] = startIdx

            let minX = x
            let maxX = x
            let minY = y
            let maxY = y
            let count = 0
            let sumProb = 0

            while (head < tail) {
                const cur = queue[head++]
                const cx = cur % mapW
                const cy = (cur - cx) / mapW
                const p = probMap[cur]
                count++
                sumProb += p

                if (cx < minX) minX = cx
                if (cx > maxX) maxX = cx
                if (cy < minY) minY = cy
                if (cy > maxY) maxY = cy

                for (let k = 0; k < 8; k++) {
                    const nx = cx + dx[k]
                    const ny = cy + dy[k]
                    if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) continue
                    const nIdx = ny * mapW + nx
                    if (!visited[nIdx] && probMap[nIdx] > thresh) {
                        visited[nIdx] = 1
                        queue[tail++] = nIdx
                    }
                }
            }

            if (count < 2) continue
            const bw = maxX - minX + 1
            const bh = maxY - minY + 1
            if (Math.min(bw, bh) < minSide) continue

            const meanScore = sumProb / count
            if (meanScore < boxThresh) continue

            const area = bw * bh
            const perimeter = 2 * (bw + bh)
            const expand = (area * unclipRatio) / Math.max(1, perimeter)

            const mx0 = clamp(minX - expand * 0.9, 0, mapW)
            const my0 = clamp(minY - expand * 0.9, 0, mapH)
            const mx1 = clamp(maxX + 1 + expand * 0.9, 0, mapW)
            const my1 = clamp(maxY + 1 + expand * 0.9, 0, mapH)

            const rx0 = clamp(mx0 * scaleX, 0, srcW)
            const ry0 = clamp(my0 * scaleY, 0, srcH)
            const rx1 = clamp(mx1 * scaleX, 0, srcW)
            const ry1 = clamp(my1 * scaleY, 0, srcH)
            const rw = rx1 - rx0
            const rh = ry1 - ry0
            if (rw < 4 || rh < 4) continue

            candidates.push({
                x0: rx0,
                y0: ry0,
                x1: rx1,
                y1: ry1,
                w: rw,
                h: rh,
                score: meanScore
            })
        }
    }

    if (candidates.length > maxCandidates) {
        candidates.sort((a, b) => b.score - a.score)
        candidates.length = maxCandidates
    }
    return candidates
}

/**
 * CTC greedy decode on [timesteps x numClasses] tensor slice with per-character
 * timestep intervals for sub-span bounding box projection.
 *
 * @param {Float32Array | number[]} data
 * @param {number} timesteps
 * @param {number} numClasses
 * @param {string[]} vocab
 * @param {number} [validRatio=1.0]
 * @param {number} [dataOffset=0]
 * @returns {{ text: string, confidence: number, charTimesteps: Array<{ char: string, startT: number, endT: number, score: number }>, effectiveTimesteps: number }}
 */
export function ctcGreedyDecode(data, timesteps, numClasses, vocab, validRatio = 1.0, dataOffset = 0) {
    if (!data || timesteps <= 0 || numClasses <= 0 || !Array.isArray(vocab) || vocab.length === 0) {
        return { text: '', confidence: 0, charTimesteps: [], effectiveTimesteps: 1 }
    }
    const effectiveTimesteps = Math.max(1, Math.min(timesteps, Math.ceil(timesteps * clamp(validRatio, 0.05, 1))))

    // Detect raw logits vs probabilities from the first timestep
    let minVal = Infinity
    let maxVal = -Infinity
    for (let c = 0; c < numClasses; c++) {
        const v = data[dataOffset + c]
        if (v < minVal) minVal = v
        if (v > maxVal) maxVal = v
    }
    const needsSoftmax = minVal < -0.001 || maxVal > 1.001

    const rawEntries = []
    let prevIdx = 0

    for (let t = 0; t < effectiveTimesteps; t++) {
        const rowStart = dataOffset + t * numClasses
        let bestIdx = 0
        let bestVal = -Infinity
        for (let c = 0; c < numClasses; c++) {
            const v = data[rowStart + c]
            if (v > bestVal) {
                bestVal = v
                bestIdx = c
            }
        }

        let prob = bestVal
        if (needsSoftmax) {
            let sumExp = 0
            for (let c = 0; c < numClasses; c++) {
                sumExp += Math.exp(data[rowStart + c] - bestVal)
            }
            prob = sumExp > 0 ? 1 / sumExp : 0
        } else {
            prob = clamp(prob, 0, 1)
        }

        if (bestIdx !== 0 && bestIdx < vocab.length) {
            if (bestIdx === prevIdx && rawEntries.length > 0) {
                const last = rawEntries[rawEntries.length - 1]
                last.endT = t
                if (prob > last.score) last.score = prob
            } else if (bestIdx !== prevIdx) {
                const ch = vocab[bestIdx]
                if (ch) {
                    rawEntries.push({ char: ch, startT: t, endT: t, score: prob })
                }
            }
        }
        prevIdx = bestIdx
    }

    // Trim leading/trailing whitespace tokens while keeping charTimesteps synchronized
    let start = 0
    let end = rawEntries.length
    while (start < end && rawEntries[start].char === ' ') start++
    while (end > start && rawEntries[end - 1].char === ' ') end--

    const trimmed = rawEntries.slice(start, end)
    const text = trimmed.map(e => e.char).join('')
    const confidence = trimmed.length
        ? trimmed.reduce((acc, e) => acc + e.score, 0) / trimmed.length
        : 0

    return {
        text,
        confidence,
        charTimesteps: trimmed,
        effectiveTimesteps
    }
}

/**
 * Project decoded CTC character timestep spans onto page-space per-character rects.
 * Guarantees returned array length equals `charTimesteps.length`.
 *
 * @param {[number, number, number, number]} rect [x0, y0, x1, y1]
 * @param {Array<{ char: string, startT: number, endT: number }>} charTimesteps
 * @param {number} effectiveTimesteps
 * @param {boolean} [isVertical=false]
 * @returns {Array<[number, number, number, number]>}
 */
export function projectCharRects(rect, charTimesteps, effectiveTimesteps, isVertical = false) {
    if (!Array.isArray(rect) || rect.length < 4 || !Array.isArray(charTimesteps) || !charTimesteps.length) {
        return []
    }
    const [x0, y0, x1, y1] = rect
    const denom = Math.max(1, effectiveTimesteps)
    const out = []

    if (isVertical) {
        const spanH = Math.max(1, y1 - y0)
        const minCharH = Math.max(0.5, (spanH / Math.max(1, charTimesteps.length)) * 0.35)
        for (let i = 0; i < charTimesteps.length; i++) {
            const item = charTimesteps[i]
            const f0 = clamp(item.startT / denom, 0, 1)
            const f1 = clamp((item.endT + 1) / denom, f0, 1)
            let cy0 = y0 + f0 * spanH
            let cy1 = Math.max(cy0 + minCharH, y0 + f1 * spanH)
            if (cy1 > y1) {
                cy1 = y1
                cy0 = Math.max(y0, Math.min(cy0, y1 - Math.min(minCharH, spanH * 0.1)))
            }
            out.push([x0, cy0, x1, cy1])
        }
        return out
    }

    const spanW = Math.max(1, x1 - x0)
    const minCharW = Math.max(0.5, (spanW / Math.max(1, charTimesteps.length)) * 0.35)
    for (let i = 0; i < charTimesteps.length; i++) {
        const item = charTimesteps[i]
        const f0 = clamp(item.startT / denom, 0, 1)
        const f1 = clamp((item.endT + 1) / denom, f0, 1)
        let cx0 = x0 + f0 * spanW
        let cx1 = Math.max(cx0 + minCharW, x0 + f1 * spanW)
        if (cx1 > x1) {
            cx1 = x1
            cx0 = Math.max(x0, Math.min(cx0, x1 - Math.min(minCharW, spanW * 0.1)))
        }
        out.push([cx0, y0, cx1, y1])
    }
    return out
}

function spanBounds(span) {
    if (Array.isArray(span?.rect) && span.rect.length >= 4) {
        const [x0, y0, x1, y1] = span.rect
        const lx = Math.min(x0, x1)
        const rx = Math.max(x0, x1)
        const ty = Math.min(y0, y1)
        const by = Math.max(y0, y1)
        return { x0: lx, y0: ty, x1: rx, y1: by, w: Math.max(1, rx - lx), h: Math.max(1, by - ty) }
    }
    const x0 = Number(span?.x) || 0
    const y0 = Number(span?.y) || 0
    const w = Math.max(1, Number(span?.w) || 1)
    const h = Math.max(1, Number(span?.h) || 1)
    return { x0, y0, x1: x0 + w, y1: y0 + h, w, h }
}

/**
 * Determine whether page spans represent predominantly vertical or horizontal writing.
 *
 * @param {Array<object>} spans
 * @param {'auto' | 'horizontal' | 'vertical'} [requestedDirection='auto']
 * @returns {'horizontal' | 'vertical'}
 */
export function detectPageDirection(spans, requestedDirection = 'auto') {
    if (requestedDirection === 'horizontal' || requestedDirection === 'vertical') {
        return requestedDirection
    }
    if (!Array.isArray(spans) || !spans.length) return 'horizontal'
    let verticalWeight = 0
    let horizontalWeight = 0
    for (const span of spans) {
        const text = String(span?.text || '').trim()
        if (!text) continue
        const b = spanBounds(span)
        const area = b.w * b.h
        const looksVertical = Boolean(span.vertical) || (b.h >= b.w * 1.45 && text.length >= 2)
        if (looksVertical) verticalWeight += area
        else horizontalWeight += area
    }
    const total = verticalWeight + horizontalWeight
    if (total <= 0) return 'horizontal'
    return (verticalWeight / total) >= 0.5 ? 'vertical' : 'horizontal'
}

function clusterHorizontalLines(items) {
    if (!items.length) return []
    const byY = [...items].sort((a, b) => a._b.cy - b._b.cy || a._b.x0 - b._b.x0)
    const lines = []
    for (const item of byY) {
        const lastLine = lines[lines.length - 1]
        if (lastLine) {
            const tol = Math.max(4, Math.min(item._b.h, lastLine.avgH) * 0.55)
            if (Math.abs(item._b.cy - lastLine.avgCy) <= tol) {
                lastLine.items.push(item)
                const n = lastLine.items.length
                lastLine.avgCy = lastLine.items.reduce((s, x) => s + x._b.cy, 0) / n
                lastLine.avgH = lastLine.items.reduce((s, x) => s + x._b.h, 0) / n
                continue
            }
        }
        lines.push({ avgCy: item._b.cy, avgH: item._b.h, items: [item] })
    }
    lines.sort((a, b) => a.avgCy - b.avgCy)
    for (const line of lines) {
        line.items.sort((a, b) => a._b.x0 - b._b.x0)
    }
    return lines
}

function clusterVerticalColumns(items) {
    if (!items.length) return []
    // Sort right-to-left first so column seeding starts cleanly from the rightmost column
    const byXDesc = [...items].sort((a, b) => b._b.cx - a._b.cx || a._b.y0 - b._b.y0)
    const columns = []
    for (const item of byXDesc) {
        let matched = null
        let bestDist = Infinity
        for (const col of columns) {
            const tol = Math.max(6, Math.max(item._b.w, col.avgW) * 0.65)
            const dist = Math.abs(item._b.cx - col.avgCx)
            if (dist <= tol && dist < bestDist) {
                bestDist = dist
                matched = col
            }
        }
        if (matched) {
            matched.items.push(item)
            const n = matched.items.length
            matched.avgCx = matched.items.reduce((s, x) => s + x._b.cx, 0) / n
            matched.avgW = matched.items.reduce((s, x) => s + x._b.w, 0) / n
        } else {
            columns.push({ avgCx: item._b.cx, avgW: item._b.w, items: [item] })
        }
    }
    // Traditional Chinese vertical reading order: right-to-left columns, top-to-bottom within column
    columns.sort((a, b) => b.avgCx - a.avgCx)
    for (const col of columns) {
        col.items.sort((a, b) => a._b.y0 - b._b.y0)
    }
    return columns
}

function splitTwoColumnHorizontal(wrapped) {
    if (wrapped.length < 6) return null
    let minX = Infinity
    let maxX = -Infinity
    for (const item of wrapped) {
        if (item._b.x0 < minX) minX = item._b.x0
        if (item._b.x1 > maxX) maxX = item._b.x1
    }
    const contentW = maxX - minX
    if (contentW <= 40) return null
    const midX = (minX + maxX) / 2
    const tol = contentW * 0.04
    const maxColW = contentW * 0.52

    const left = []
    const right = []
    const full = []
    for (const item of wrapped) {
        if (item._b.w < maxColW && item._b.x1 <= midX + tol) {
            left.push(item)
        } else if (item._b.w < maxColW && item._b.x0 >= midX - tol) {
            right.push(item)
        } else {
            full.push(item)
        }
    }

    if (left.length < 3 || right.length < 3) return null
    if ((left.length + right.length) < wrapped.length * 0.65) return null

    const leftMinY = Math.min(...left.map(i => i._b.y0))
    const leftMaxY = Math.max(...left.map(i => i._b.y1))
    const rightMinY = Math.min(...right.map(i => i._b.y0))
    const rightMaxY = Math.max(...right.map(i => i._b.y1))
    // True side-by-side columns must share vertical territory
    if (Math.min(leftMaxY, rightMaxY) <= Math.max(leftMinY, rightMinY)) return null

    const colsTop = Math.min(leftMinY, rightMinY)
    const colsBottom = Math.max(leftMaxY, rightMaxY)
    const headers = full.filter(i => i._b.y1 <= colsTop + 12)
    const footers = full.filter(i => i._b.y0 >= colsBottom - 12)
    const midFull = full.filter(i => i._b.y1 > colsTop + 12 && i._b.y0 < colsBottom - 12)

    return [
        ...clusterHorizontalLines(headers),
        ...clusterHorizontalLines(left),
        ...clusterHorizontalLines(right),
        ...clusterHorizontalLines(midFull),
        ...clusterHorizontalLines(footers)
    ]
}

/**
 * Reconstruct natural reading order (horizontal single/two-column or right-to-left vertical)
 * and assign normalized sequential `line` indices to each span.
 *
 * @param {Array<object>} spans
 * @param {{ direction?: 'auto' | 'horizontal' | 'vertical' }} [options]
 * @returns {{ spans: Array<object>, direction: 'horizontal' | 'vertical' }}
 */
export function sortOcrSpansByReadingOrder(spans, options = {}) {
    if (!Array.isArray(spans) || !spans.length) {
        return { spans: [], direction: options.direction === 'vertical' ? 'vertical' : 'horizontal' }
    }
    const effectiveDirection = detectPageDirection(spans, options.direction || 'auto')
    const wrapped = spans
        .filter(s => s && String(s.text || '').trim().length > 0)
        .map(span => {
            const b = spanBounds(span)
            return {
                span,
                _b: { ...b, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 }
            }
        })

    if (!wrapped.length) return { spans: [], direction: effectiveDirection }

    const groups = effectiveDirection === 'vertical'
        ? clusterVerticalColumns(wrapped)
        : (splitTwoColumnHorizontal(wrapped) || clusterHorizontalLines(wrapped))

    const orderedSpans = []
    groups.forEach((group, lineIdx) => {
        for (const item of group.items) {
            const nextSpan = { ...item.span, line: lineIdx }
            if (effectiveDirection === 'vertical' && nextSpan.vertical == null) {
                const b = item._b
                if (b.h >= b.w * 1.35 && String(nextSpan.text || '').trim().length >= 2) {
                    nextSpan.vertical = true
                }
            }
            orderedSpans.push(nextSpan)
        }
    })

    return { spans: orderedSpans, direction: effectiveDirection }
}

/**
 * Format ordered OCR spans into clean multi-line text, avoiding spurious spaces between CJK glyphs
 * while preserving Latin word spacing.
 *
 * @param {Array<object>} spans
 * @param {{ direction?: 'auto' | 'horizontal' | 'vertical' }} [options]
 * @returns {string}
 */
export function formatOcrSpansToText(spans, options = {}) {
    const { spans: ordered, direction } = sortOcrSpansByReadingOrder(spans, options)
    if (!ordered.length) return ''

    const lines = new Map()
    for (const span of ordered) {
        const key = Number.isFinite(span.line) ? span.line : 0
        if (!lines.has(key)) lines.set(key, [])
        lines.get(key).push(span)
    }

    const lineTexts = []
    for (const [, group] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
        if (direction === 'vertical') {
            lineTexts.push(group.map(s => String(s.text || '').trim()).filter(Boolean).join(''))
            continue
        }
        let lineOut = ''
        for (const span of group) {
            const part = String(span.text || '').trim()
            if (!part) continue
            if (!lineOut) {
                lineOut = part
            } else {
                const prevLast = lineOut.slice(-1)
                const curFirst = part.charAt(0)
                const bothAsciiWord = /[A-Za-z0-9]/.test(prevLast) && /[A-Za-z0-9]/.test(curFirst)
                const latinJoin = (!CJK_CHAR_RE.test(prevLast) && !CJK_CHAR_RE.test(curFirst)) && /[A-Za-z0-9.,;:!?)]/.test(prevLast) && /[A-Za-z0-9([]/.test(curFirst)
                lineOut += (bothAsciiWord || latinJoin) ? ` ${part}` : part
            }
        }
        if (lineOut) lineTexts.push(lineOut)
    }

    return lineTexts.join('\n')
}
