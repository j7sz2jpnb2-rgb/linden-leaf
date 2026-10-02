// length for context in excerpts
const CONTEXT_LENGTH = 50

const normalizeWhitespace = str => str.replace(/\s+/g, ' ')

const makeExcerpt = (strs, { startIndex, startOffset, endIndex, endOffset }) => {
    const start = strs[startIndex]
    const end = strs[endIndex]
    const match = startIndex === endIndex
        ? start.slice(startOffset, endOffset)
        : start.slice(startOffset)
            + strs.slice(startIndex + 1, endIndex).join('')
            + end.slice(0, endOffset)
    const trimmedStart = normalizeWhitespace(start.slice(0, startOffset)).trimStart()
    const trimmedEnd = normalizeWhitespace(end.slice(endOffset)).trimEnd()
    const ellipsisPre = trimmedStart.length < CONTEXT_LENGTH ? '' : '…'
    const ellipsisPost = trimmedEnd.length < CONTEXT_LENGTH ? '' : '…'
    const pre = `${ellipsisPre}${trimmedStart.slice(-CONTEXT_LENGTH)}`
    const post = `${trimmedEnd.slice(0, CONTEXT_LENGTH)}${ellipsisPost}`
    return { pre, match, post }
}

const simpleSearch = function* (strs, query, options = {}) {
    if (!strs || strs.length === 0 || !query) return
    const { locales = 'en', sensitivity } = options
    const matchCase = sensitivity === 'variant'

    const chunks = []
    let totalLen = 0
    for (let i = 0; i < strs.length; i++) {
        const str = strs[i] ?? ''
        const sep = (i + 1 < strs.length && !/\s$/u.test(str) && !/^\s/u.test(strs[i + 1] ?? '')) ? ' ' : ''
        const start = totalLen
        const textEnd = start + str.length
        totalLen = textEnd + sep.length
        chunks.push({ index: i, str, sep, start, textEnd, totalEnd: totalLen })
    }

    const haystack = chunks.map(c => c.str + c.sep).join('')
    const lowerHaystack = matchCase ? haystack : haystack.toLocaleLowerCase(locales)
    const needle = matchCase ? query : query.toLocaleLowerCase(locales)
    const needleLength = needle.length
    if (needleLength === 0) return

    const mapOffset = (pos, isEnd = false) => {
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i]
            if (pos < c.totalEnd || (isEnd && pos === c.totalEnd && i === chunks.length - 1)) {
                if (pos <= c.textEnd) {
                    return { strIndex: c.index, offset: pos - c.start }
                }
                if (isEnd) {
                    return { strIndex: c.index, offset: c.str.length }
                } else {
                    const next = chunks[i + 1]
                    return next ? { strIndex: next.index, offset: 0 } : { strIndex: c.index, offset: c.str.length }
                }
            }
        }
        const last = chunks[chunks.length - 1]
        return { strIndex: last.index, offset: last.str.length }
    }

    let index = -1
    do {
        index = lowerHaystack.indexOf(needle, index + 1)
        if (index > -1) {
            const start = mapOffset(index, false)
            const end = mapOffset(index + needleLength, true)
            const range = {
                startIndex: start.strIndex,
                startOffset: start.offset,
                endIndex: end.strIndex,
                endOffset: end.offset,
            }
            yield { range, excerpt: makeExcerpt(strs, range) }
        }
    } while (index > -1)
}

const segmenterSearch = function* (strs, query, options = {}) {
    if (!strs || strs.length === 0 || !query) return
    const { locales = 'en', granularity = 'word', sensitivity = 'base' } = options
    let segmenter, collator
    try {
        segmenter = new Intl.Segmenter(locales, { usage: 'search', granularity })
        collator = new Intl.Collator(locales, { sensitivity })
    } catch (e) {
        console.warn(e)
        segmenter = new Intl.Segmenter('en', { usage: 'search', granularity })
        collator = new Intl.Collator('en', { sensitivity })
    }
    const queryLength = Array.from(segmenter.segment(query)).length

    const substrArr = []
    let strIndex = 0
    let segments = segmenter.segment(strs[strIndex])[Symbol.iterator]()
    main: while (strIndex < strs.length) {
        while (substrArr.length < queryLength) {
            const { done, value } = segments.next()
            if (done) {
                // the current string is exhausted
                // move on to the next string
                const prevStr = strs[strIndex]
                strIndex++
                if (strIndex < strs.length) {
                    const nextStr = strs[strIndex]
                    if (!/\s$/u.test(prevStr) && !/^\s/u.test(nextStr)) {
                        if (!/\s/u.test(substrArr[substrArr.length - 1]?.segment))
                            substrArr.push({ strIndex: strIndex - 1, index: prevStr.length, segment: ' ', isBoundary: true })
                    }
                    segments = segmenter.segment(strs[strIndex])[Symbol.iterator]()
                    continue
                } else break main
            }
            const { index, segment } = value
            // ignore formatting characters
            if (!/[^\p{Format}]/u.test(segment)) continue
            // normalize whitespace
            if (/\s/u.test(segment)) {
                if (!/\s/u.test(substrArr[substrArr.length - 1]?.segment))
                    substrArr.push({ strIndex, index, segment: ' ' })
                continue
            }
            value.strIndex = strIndex
            substrArr.push(value)
        }
        const substr = substrArr.map(x => x.segment).join('')
        if (collator.compare(query, substr) === 0) {
            const firstSeg = substrArr[0]
            const lastSeg = substrArr[substrArr.length - 1]
            const startIndex = firstSeg.isBoundary ? firstSeg.strIndex + 1 : firstSeg.strIndex
            const startOffset = firstSeg.isBoundary ? 0 : firstSeg.index
            const endIndex = lastSeg.isBoundary ? lastSeg.strIndex : lastSeg.strIndex
            const endOffset = lastSeg.isBoundary ? (strs[lastSeg.strIndex]?.length ?? 0) : (lastSeg.index + lastSeg.segment.length)
            const range = { startIndex, startOffset, endIndex, endOffset }
            yield { range, excerpt: makeExcerpt(strs, range) }
        }
        substrArr.shift()
    }
}

export const search = (strs, query, options = {}) => {
    const { granularity = 'grapheme', sensitivity = 'base' } = options
    if (!options.matchWholeWords || !Intl?.Segmenter || granularity === 'grapheme')
        return simpleSearch(strs, query, options)
    return segmenterSearch(strs, query, options)
}

export const searchMatcher = (textWalker, opts) => {
    const { defaultLocale, matchCase, matchDiacritics, matchWholeWords, acceptNode } = opts
    return function* (doc, query) {
        const iter = textWalker(doc, function* (strs, makeRange) {
            for (const result of search(strs, query, {
                locales: doc?.body?.lang || doc?.documentElement?.lang || defaultLocale || 'en',
                granularity: matchWholeWords ? 'word' : 'grapheme',
                sensitivity: matchDiacritics && matchCase ? 'variant'
                : matchDiacritics && !matchCase ? 'accent'
                : !matchDiacritics && matchCase ? 'case'
                : 'base',
            })) {
                const { startIndex, startOffset, endIndex, endOffset } = result.range
                result.range = makeRange(startIndex, startOffset, endIndex, endOffset)
                yield result
            }
        }, acceptNode)
        for (const result of iter) yield result
    }
}
