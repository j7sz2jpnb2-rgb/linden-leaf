const PLACEHOLDER_TITLES = new Set(['unknown', 'unknown title', 'untitled', '未命名', '未命名书籍', '未命名电子书', '未知', '未知书名'])

function safeDecodeURIComponent(str) {
    if (typeof str !== 'string' || !str.includes('%')) return str
    try {
        if (/%[0-9a-fA-F]{2}/.test(str)) {
            return decodeURIComponent(str)
        }
    } catch (_) {
        try {
            return str.replace(/(?:%[0-9a-fA-F]{2})+/g, chunk => {
                try {
                    return decodeURIComponent(chunk)
                } catch {
                    let cur = chunk
                    while (cur.length >= 3) {
                        cur = cur.slice(0, -3)
                        try {
                            return decodeURIComponent(cur)
                        } catch {}
                    }
                    return chunk
                }
            })
        } catch (_) {}
    }
    return str
}

export const resolveBookTitle = (title, filename = '') => {
    let value = typeof title === 'string' ? title.trim() : ''
    value = safeDecodeURIComponent(value)
    if (value && !PLACEHOLDER_TITLES.has(value.toLowerCase())) return value
    let fallback = String(filename || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '').trim()
    fallback = safeDecodeURIComponent(fallback)
    return fallback || value || '未命名书籍'
}

// Repair display on read without migrating existing IDs, stable keys, or stored records.
export const withReadableBookTitle = book => {
    if (!book) return book
    const title = resolveBookTitle(book.title, book.filename)
    return title === book.title ? book : { ...book, title }
}

