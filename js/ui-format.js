

import { t, isEnglish, getIntlLocale } from './i18n.js'

export const DEFAULT_READER_NAME = 'Op. 1'

/** Map a local Date to one of the 7 bookshelf greeting period keys. */
export function getGreetingPeriodKey(date = new Date()) {
    const timeVal = date.getHours() + date.getMinutes() / 60
    if (timeVal >= 5.0 && timeVal < 7.5) return 'dawn'
    if (timeVal >= 7.5 && timeVal < 11.5) return 'morning'
    if (timeVal >= 11.5 && timeVal < 13.5) return 'noon'
    if (timeVal >= 13.5 && timeVal < 17.5) return 'afternoon'
    if (timeVal >= 17.5 && timeVal < 19.5) return 'evening'
    if (timeVal >= 19.5 && timeVal < 23.5) return 'night'
    return 'lateNight'
}

export const uiSymbol = (name = 'book') => {
    const paths = {
        book: '<path d="M4 19a2 2 0 0 1 2-2h14M6 3h14v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>',
        note: '<path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/>',
        edit: '<path d="m15 5 4 4M4 20l4-1L20 7a3 3 0 0 0-4-4L4 15Z"/>',
        trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
        award: '<circle cx="12" cy="8" r="5"/><path d="m8 12-2 9 6-3 6 3-2-9"/>'
    }
    return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.book}</svg>`
}

export const escapeHTML = str => {
    if (str == null || str === '') return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]] || ''
}

export const formatContributor = contributor => {
    if (!contributor) return t('book.unknownAuthor')
    if (typeof contributor === 'string') return contributor
    if (Array.isArray(contributor)) {
        return contributor.map(c => typeof c === 'string' ? c : formatLanguageMap(c?.name)).join(', ')
    }
    return formatLanguageMap(contributor?.name) || t('book.unknownAuthor')
}

export const formatFileSize = bytes => {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'kB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export const formatDateTime = ts => {
    if (!ts || ts === 0) return '-'
    const now = Date.now()
    const diff = (now - ts) / 1000 // seconds
    if (diff < 60) return t('time.justNow')
    if (diff < 3600) return t('time.minutesAgo', { count: Math.floor(diff / 60) })
    if (diff < 86400) return t('time.hoursAgo', { count: Math.floor(diff / 3600) })
    if (diff < 86400 * 3) return t('time.daysAgo', { count: Math.floor(diff / 86400) })

    const d = new Date(ts)
    if (isEnglish()) {
        return d.toLocaleString(getIntlLocale(), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
        })
    }
    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const date = d.getDate()
    const hours = d.getHours()
    const minutes = String(d.getMinutes()).padStart(2, '0')
    const seconds = String(d.getSeconds()).padStart(2, '0')
    const period = hours < 12 ? t('time.am') : t('time.pm')
    const h12 = hours % 12 || 12
    return t('time.fullDateTime', { year, month, date, period, h12, minutes, seconds })
}

export const BOOK_COVER_PALETTES = Object.freeze([
    'cov-ochre',
    'cov-slate',
    'cov-sage',
    'cov-oat',
    'cov-ink',
    'cov-terracotta',
    'cov-moss',
    'cov-plum',
])

export function getBookCoverPaletteClass(seedStr = '') {
    let hash = 2166136261
    const str = String(seedStr || '')
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return BOOK_COVER_PALETTES[(hash >>> 0) % BOOK_COVER_PALETTES.length]
}

/**
 * Shared Warm Paper Bookcloth fallback cover HTML used consistently
 * across Desktop shelf, Hero lounge, Details modal, Stats leaderboard, and Mobile views.
 */
export function renderEditorialCoverHTML(book = {}, options = {}) {
    const { micro = false, thumb = false, extraClass = '', displayTitle = '' } = options
    const rawTitle = String(displayTitle || book?.title || t('book.untitled') || '').trim()
    const rawAuthor = String(book?.author || t('book.unknownAuthor') || '').trim()
    const fmt = escapeHTML((book?.format || 'BOOK').toUpperCase())
    const seed = String(book?.id || rawTitle || 'book')
    const paletteClass = getBookCoverPaletteClass(seed)

    let monoChar = 'L'
    const stripped = rawTitle.replace(/^[《「『【(\["'\s]+/, '')
    if (stripped) {
        const firstCh = Array.from(stripped)[0] || ''
        if (/[\u4e00-\u9fffA-Za-z0-9]/.test(firstCh)) {
            monoChar = firstCh.toUpperCase()
        }
    }

    if (micro) {
        return `
            <div class="editorial-cover-fallback is-micro ${paletteClass} ${extraClass}">
                <span class="cover-fallback-mono">${escapeHTML(monoChar)}</span>
            </div>
        `
    }

    return `
        <div class="editorial-cover-fallback ${thumb ? 'is-thumb' : ''} ${paletteClass} ${extraClass}">
            <div class="cover-fallback-header">
                <span class="cover-fallback-author-top">${escapeHTML(rawAuthor)}</span>
                <span class="cover-fallback-format">${fmt}</span>
            </div>
            <div class="cover-fallback-body">
                <div class="cover-fallback-title">${escapeHTML(rawTitle)}</div>
                <span class="cover-fallback-mono" aria-hidden="true">${escapeHTML(monoChar)}</span>
            </div>
        </div>
    `
}

const WARM_HIGHLIGHT_DISPLAY_MAP = Object.freeze({
    '#facc15': '#c89b3c',
    '#4ade80': '#5f8c6c',
    '#60a5fa': '#5f85a8',
    '#c084fc': '#8d74a8',
    '#f87171': '#9e4c5a',
})

/** Map vivid highlighter ink hexes to calm Warm Annotated Paper display tones. */
export function mapHighlightDisplayColor(rawColor) {
    const key = String(rawColor || '').trim().toLowerCase()
    return WARM_HIGHLIGHT_DISPLAY_MAP[key] || rawColor || '#c89b3c'
}