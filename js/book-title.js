import { t } from './i18n.js'

const PLACEHOLDER_TITLES = new Set(['unknown', 'unknown title', 'untitled', 'untitled book', '未命名', '未命名书籍', '未命名电子书', '未知', '未知书名'])

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
    return fallback || value || t('book.untitled')
}

// Repair display on read without migrating existing IDs, stable keys, or stored records.
export const withReadableBookTitle = book => {
    if (!book) return book
    const title = resolveBookTitle(book.title, book.filename)
    return title === book.title ? book : { ...book, title }
}

/**
 * Split long marketing/catalog subtitles out of display titles (e.g. Hero showcase)
 * while leaving compact titles untouched.
 */
export function splitDisplayTitleAndSubtitle(rawTitle) {
    const title = String(rawTitle || '').trim()
    if (!title) return { mainTitle: '', subtitle: '' }

    // 1. Trailing full-width or ASCII parenthesized subtitle on long titles
    const parenMatch = title.match(/^(.{2,}?)\s*[（(]([^）)]{4,})[）)]\s*$/)
    if (parenMatch && title.length >= 16) {
        return {
            mainTitle: parenMatch[1].trim(),
            subtitle: parenMatch[2].trim(),
        }
    }

    // 2. Colon or em-dash subtitle when subtitle is substantive
    const sepMatch = title.match(/^(.{2,}?)\s*(?:：|:|——|—)\s*(.{4,})$/)
    if (sepMatch && title.length >= 14 && sepMatch[1].trim().length >= 2) {
        return {
            mainTitle: sepMatch[1].trim(),
            subtitle: sepMatch[2].trim(),
        }
    }

    return { mainTitle: title, subtitle: '' }
}

