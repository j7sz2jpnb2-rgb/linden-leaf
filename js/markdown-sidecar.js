/**
 * markdown-sidecar.js
 * Non-destructive incremental Markdown Sidecar generator and merger.
 * Updates only Linden Leaf marker blocks while preserving user YAML frontmatter,
 * external #tags, personal summaries, and prose commentary outside markers.
 */

const META_START = '<!-- linden-leaf:meta:start -->'
const META_END = '<!-- linden-leaf:meta:end -->'

function escapeMarkerComment(text) {
    return String(text || '').replace(/-->/g, '--\\>')
}

export function sanitizeSidecarFilename(title) {
    const raw = String(title || 'untitled_book')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 110)
    return `${raw || 'untitled_book'}.md`
}

function getHighlightStableId(h, fallbackIndex = 0) {
    if (h?.id) return String(h.id).replace(/[^a-zA-Z0-9_.:-]/g, '_')
    const page = h?.pdfTarget?.page ?? h?.page ?? 'p'
    return `hl_${page}_${h?.createdAt || fallbackIndex}`
}

function formatLocationLabel(h) {
    if (h?.chapterTitle) return String(h.chapterTitle).trim()
    if (h?.chapter) return String(h.chapter).trim()
    const p = h?.pdfTarget?.page ?? h?.page
    if (Number.isInteger(p) && p >= 0) return `P.${p + 1}`
    return ''
}

export function formatSidecarHighlightBlock(h, opts = {}) {
    const id = getHighlightStableId(h, opts.index || 0)
    const startTag = `<!-- linden-leaf:hl:${id}:start -->`
    const endTag = `<!-- linden-leaf:hl:${id}:end -->`
    const quoteRaw = escapeMarkerComment(h?.text || '').trim()
    const quoteLines = quoteRaw
        ? quoteRaw.split(/\r?\n/).map(line => `> ${line}`).join('\n')
        : '> (Empty selection)'
    const noteRaw = escapeMarkerComment(h?.note || '').trim()
    const loc = formatLocationLabel(h)
    const ts = h?.createdAt ? new Date(h.createdAt).toISOString().slice(0, 10) : ''
    const metaParts = [loc, ts, h?.color ? `color:${h.color}` : ''].filter(Boolean)
    const lines = [startTag, quoteLines]
    if (noteRaw) {
        lines.push('', `- **Note**: ${noteRaw.replace(/\r?\n/g, '\n  ')}`)
    }
    if (metaParts.length > 0) {
        lines.push('', `<sub>${metaParts.join(' · ')}</sub>`)
    }
    lines.push(endTag)
    return lines.join('\n')
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMetaBlock(book, highlights) {
    const title = escapeMarkerComment(book?.customTitle || book?.title || 'Untitled Book')
    const author = escapeMarkerComment(book?.customAuthor || book?.author || '')
    const lines = [
        META_START,
        `# ${title}`,
        '',
        author ? `- **Author**: ${author}` : null,
        book?.format ? `- **Format**: ${String(book.format).toUpperCase()}` : null,
        `- **Highlights**: ${highlights.length}`,
        `- **Synced At**: ${new Date().toISOString()}`,
        META_END,
    ].filter(line => line !== null)
    return lines.join('\n')
}

function splitLeadingFrontmatter(markdown) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown)
    if (!m) return { frontmatter: '', body: markdown }
    return { frontmatter: m[0], body: markdown.slice(m[0].length) }
}

/**
 * Merges Linden Leaf highlights incrementally into an existing Markdown file.
 * Preserves YAML frontmatter, external commentary, tags, and formatting outside marker spans.
 * @param {string} existingMd
 * @param {object} book
 * @param {Array<object>} highlights
 * @returns {{ content: string, added: number, updated: number }}
 */
export function mergeMarkdownSidecar(existingMd = '', book = {}, highlights = []) {
    const cleanExisting = String(existingMd || '')
    const sorted = [...(Array.isArray(highlights) ? highlights : [])]
        .filter(h => h && !h._deleted)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

    const metaBlock = buildMetaBlock(book, sorted)
    const { frontmatter, body: initialBody } = splitLeadingFrontmatter(cleanExisting)
    let body = initialBody

    const metaRe = new RegExp(`${escapeRegExp(META_START)}[\\s\\S]*?${escapeRegExp(META_END)}`)
    if (metaRe.test(body)) {
        body = body.replace(metaRe, metaBlock)
    } else if (!body.trim()) {
        body = `${metaBlock}\n`
    } else {
        body = `${metaBlock}\n\n${body.replace(/^\r?\n+/, '')}`
    }

    let added = 0
    let updated = 0
    const toAppend = []

    sorted.forEach((h, idx) => {
        const id = getHighlightStableId(h, idx)
        const block = formatSidecarHighlightBlock(h, { index: idx })
        const hlRe = new RegExp(
            `<!-- linden-leaf:hl:${escapeRegExp(id)}:start -->[\\s\\S]*?<!-- linden-leaf:hl:${escapeRegExp(id)}:end -->`
        )
        if (hlRe.test(body)) {
            const match = body.match(hlRe)?.[0] || ''
            if (match !== block) updated++
            body = body.replace(hlRe, block)
        } else {
            added++
            toAppend.push(block)
        }
    })

    if (toAppend.length > 0) {
        const trimmedBody = body.replace(/\s+$/, '')
        const sectionHeader = /\n##\s+Highlights\b/i.test(body) || /^##\s+Highlights\b/im.test(body)
            ? ''
            : '\n\n## Highlights'
        body = `${trimmedBody}${sectionHeader}\n\n${toAppend.join('\n\n')}\n`
    } else if (body && !body.endsWith('\n')) {
        body += '\n'
    }

    const content = frontmatter ? `${frontmatter}${body}` : body
    return { content, added, updated }
}
