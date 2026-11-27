/**
 * clippings-importer.js
 * Parses Kindle `My Clippings.txt` (English & Chinese formats), deduplicates
 * incremental overlapping selections, pairs Notes onto Highlights, and matches books.
 */

const CLIPPING_DIVIDER_RE = /\r?\n?==========\r?\n?/

function parseTitleAndAuthor(headerLine) {
    const clean = String(headerLine || '').replace(/^\uFEFF/, '').trim()
    const match = /^(.*)\(([^()]+)\)\s*$/.exec(clean)
    if (match) {
        return { title: match[1].trim(), author: match[2].trim() }
    }
    return { title: clean, author: '' }
}

function parseMetaLine(metaLine) {
    const line = String(metaLine || '').trim()
    let type = 'highlight'
    if (/(?:Your Note|您的笔记|的笔记)/i.test(line)) type = 'note'
    else if (/(?:Your Bookmark|您的书签|的书签)/i.test(line)) type = 'bookmark'

    let locationStart = null
    let locationEnd = null
    const locMatch = /(?:Location|位置)\s*#?\s*(\d+)(?:\s*-\s*(\d+))?/i.exec(line)
    if (locMatch) {
        locationStart = parseInt(locMatch[1], 10)
        locationEnd = locMatch[2] ? parseInt(locMatch[2], 10) : locationStart
    }

    let page = null
    const pageMatch = /(?:on page\s*(\d+)|第\s*(\d+)\s*页)/i.exec(line)
    if (pageMatch) {
        page = parseInt(pageMatch[1] || pageMatch[2], 10)
    }

    return { type, locationStart, locationEnd, page }
}

function normalizeMatchText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\-_.:,;'"“”‘’()（）[\]【】《》!?！？/\\]+/g, '')
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (aStart == null || bStart == null) return false
    const a1 = aEnd ?? aStart
    const b1 = bEnd ?? bStart
    return Math.max(aStart, bStart) <= Math.min(a1, b1) + 2
}

/**
 * Parse raw Kindle `My Clippings.txt` into grouped per-book records.
 * @param {string} rawText
 * @returns {Array<{ key: string, title: string, author: string, highlights: Array<object>, bookmarks: number }>}
 */
export function parseKindleClippings(rawText = '') {
    const blocks = String(rawText || '').split(CLIPPING_DIVIDER_RE)
    const booksMap = new Map()

    for (const block of blocks) {
        const lines = block.replace(/^\uFEFF/, '').split(/\r?\n/)
        while (lines.length && !lines[0].trim()) lines.shift()
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
        if (lines.length < 2) continue

        const { title, author } = parseTitleAndAuthor(lines[0])
        if (!title) continue
        const meta = parseMetaLine(lines[1])
        const bodyStart = lines.length > 2 && !lines[2].trim() ? 3 : 2
        const content = lines.slice(bodyStart).join('\n').trim()

        const key = `${normalizeMatchText(title)}::${normalizeMatchText(author)}`
        if (!booksMap.has(key)) {
            booksMap.set(key, { key, title, author, rawItems: [], bookmarks: 0 })
        }
        const group = booksMap.get(key)
        if (meta.type === 'bookmark') {
            group.bookmarks++
            continue
        }
        if (!content) continue
        group.rawItems.push({ ...meta, content })
    }

    const result = []
    for (const group of booksMap.values()) {
        const highlights = []
        for (const item of group.rawItems) {
            if (item.type === 'highlight') {
                const dupIdx = highlights.findIndex(h =>
                    h.text === item.content ||
                    (item.locationStart != null && rangesOverlap(h.locationStart, h.locationEnd, item.locationStart, item.locationEnd) &&
                        (item.content.includes(h.text) || h.text.includes(item.content)))
                )
                if (dupIdx >= 0) {
                    if (item.content.length >= highlights[dupIdx].text.length) {
                        highlights[dupIdx].text = item.content
                        highlights[dupIdx].locationStart = item.locationStart ?? highlights[dupIdx].locationStart
                        highlights[dupIdx].locationEnd = item.locationEnd ?? highlights[dupIdx].locationEnd
                        highlights[dupIdx].page = item.page ?? highlights[dupIdx].page
                    }
                } else {
                    highlights.push({
                        text: item.content,
                        note: '',
                        locationStart: item.locationStart,
                        locationEnd: item.locationEnd,
                        page: item.page,
                    })
                }
            } else if (item.type === 'note') {
                let target = null
                if (item.locationStart != null) {
                    target = [...highlights].reverse().find(h =>
                        rangesOverlap(h.locationStart, h.locationEnd, item.locationStart, item.locationEnd)
                    )
                }
                if (!target && item.page != null) {
                    target = [...highlights].reverse().find(h => h.page === item.page)
                }
                if (target) {
                    target.note = target.note ? `${target.note}\n${item.content}` : item.content
                } else {
                    highlights.push({
                        text: `[Note @ ${item.locationStart != null ? `Loc ${item.locationStart}` : (item.page != null ? `P.${item.page}` : 'Kindle')}]`,
                        note: item.content,
                        locationStart: item.locationStart,
                        locationEnd: item.locationEnd,
                        page: item.page,
                    })
                }
            }
        }
        if (highlights.length > 0 || group.bookmarks > 0) {
            result.push({
                key: group.key,
                title: group.title,
                author: group.author,
                highlights,
                bookmarks: group.bookmarks,
            })
        }
    }

    return result
}

export function matchClippingsToLibrary(groups = [], books = []) {
    const library = Array.isArray(books) ? books : []
    return groups.map(group => {
        const gTitle = normalizeMatchText(group.title)
        const gAuthor = normalizeMatchText(group.author)
        let best = null
        let bestScore = 0
        for (const b of library) {
            const bTitle = normalizeMatchText(b.customTitle || b.title || '')
            const bAuthor = normalizeMatchText(b.customAuthor || b.author || '')
            if (!bTitle || !gTitle) continue
            let score = 0
            if (bTitle === gTitle) score += 10
            else if (bTitle.includes(gTitle) || gTitle.includes(bTitle)) score += 6
            if (score > 0 && gAuthor && bAuthor) {
                if (bAuthor === gAuthor || bAuthor.includes(gAuthor) || gAuthor.includes(bAuthor)) score += 4
            }
            if (score > bestScore) {
                bestScore = score
                best = b
            }
        }
        return {
            ...group,
            matchedBookId: bestScore >= 6 ? best.id : null,
            matchedBookTitle: bestScore >= 6 ? (best.customTitle || best.title) : null,
            confidence: bestScore,
        }
    })
}
