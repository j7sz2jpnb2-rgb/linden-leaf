/**
 * highlight-palette.js
 * Single source of truth for Linden Leaf's 5-color Warm Annotated Paper
 * ("Morandi Reform") dual-tone palette.
 *
 * Canonical storage hex keys (#facc15, #4ade80, #60a5fa, #f472b6, #a855f7)
 * map cleanly to Morandi display swatches, translucent ink fills, and stroke tones.
 */

export const HIGHLIGHT_PALETTE = Object.freeze([
    Object.freeze({
        id: 'amber',
        storageHex: '#facc15',
        aliases: Object.freeze(['yellow']),
        uiHex: '#d4a644',
        uiHexDark: '#deb255',
        inkHexLight: '#facc15',
        inkHexDark: '#f5c242',
        inkLight: 'rgba(250, 204, 21, 0.36)',
        inkDark: 'rgba(245, 194, 66, 0.30)',
        strokeLight: '#c8921e',
        strokeDark: '#e5b84b',
        labelKey: 'highlight.color.yellow',
        fallbackLabel: 'Amber',
    }),
    Object.freeze({
        id: 'bamboo',
        storageHex: '#4ade80',
        aliases: Object.freeze(['green']),
        uiHex: '#63a67b',
        uiHexDark: '#72b88b',
        inkHexLight: '#63b880',
        inkHexDark: '#68c48a',
        inkLight: 'rgba(99, 184, 128, 0.32)',
        inkDark: 'rgba(104, 196, 138, 0.28)',
        strokeLight: '#498e63',
        strokeDark: '#72c28e',
        labelKey: 'highlight.color.green',
        fallbackLabel: 'Bamboo',
    }),
    Object.freeze({
        id: 'sky',
        storageHex: '#60a5fa',
        aliases: Object.freeze(['blue']),
        uiHex: '#6390bf',
        uiHexDark: '#77a4d4',
        inkHexLight: '#6aa2e0',
        inkHexDark: '#74aeee',
        inkLight: 'rgba(106, 162, 224, 0.32)',
        inkDark: 'rgba(116, 174, 238, 0.28)',
        strokeLight: '#4a7bb0',
        strokeDark: '#7db0e8',
        labelKey: 'highlight.color.blue',
        fallbackLabel: 'Sky',
    }),
    Object.freeze({
        id: 'coral',
        storageHex: '#f472b6',
        aliases: Object.freeze(['pink']),
        uiHex: '#c96f7b',
        uiHexDark: '#d98490',
        inkHexLight: '#e87a94',
        inkHexDark: '#ec869e',
        inkLight: 'rgba(232, 122, 148, 0.32)',
        inkDark: 'rgba(236, 134, 158, 0.28)',
        strokeLight: '#b85666',
        strokeDark: '#e08594',
        labelKey: 'highlight.color.pink',
        fallbackLabel: 'Coral',
    }),
    Object.freeze({
        id: 'lilac',
        storageHex: '#a855f7',
        aliases: Object.freeze(['purple']),
        uiHex: '#9276b8',
        uiHexDark: '#a88ecf',
        inkHexLight: '#a67ce0',
        inkHexDark: '#b08ae8',
        inkLight: 'rgba(166, 124, 224, 0.30)',
        inkDark: 'rgba(176, 138, 232, 0.28)',
        strokeLight: '#7d5ea8',
        strokeDark: '#b396db',
        labelKey: 'highlight.color.purple',
        fallbackLabel: 'Lilac',
    }),
])

export const DEFAULT_HIGHLIGHT_COLOR = '#facc15'

const ALIAS_TO_ENTRY = new Map()
for (const entry of HIGHLIGHT_PALETTE) {
    ALIAS_TO_ENTRY.set(entry.storageHex, entry)
    ALIAS_TO_ENTRY.set(entry.id, entry)
    ALIAS_TO_ENTRY.set(entry.uiHex.toLowerCase(), entry)
    ALIAS_TO_ENTRY.set(entry.uiHexDark.toLowerCase(), entry)
    for (const alias of entry.aliases) {
        ALIAS_TO_ENTRY.set(String(alias).toLowerCase(), entry)
    }
}

export function getHighlightColorEntry(color) {
    const key = String(color || '').trim().toLowerCase()
    if (!key) return HIGHLIGHT_PALETTE[0]
    return ALIAS_TO_ENTRY.get(key) || null
}

export function normalizeHighlightColor(color) {
    const entry = getHighlightColorEntry(color)
    if (entry) return entry.storageHex
    const raw = String(color || '').trim()
    return raw || DEFAULT_HIGHLIGHT_COLOR
}

export function getHighlightUiHex(color, isDark = false) {
    const entry = getHighlightColorEntry(color)
    if (entry) return isDark ? entry.uiHexDark : entry.uiHex
    const raw = String(color || '').trim()
    return raw || (isDark ? HIGHLIGHT_PALETTE[0].uiHexDark : HIGHLIGHT_PALETTE[0].uiHex)
}

export function getHighlightInkColor(color, isDark = false, opacityOverride = null) {
    const entry = getHighlightColorEntry(color)
    const fallbackAlpha = isDark ? 0.28 : 0.34
    const alpha = Number.isFinite(Number(opacityOverride))
        ? Math.min(0.85, Math.max(0.08, Number(opacityOverride)))
        : null
    if (entry) {
        const base = isDark ? entry.inkDark : entry.inkLight
        if (alpha === null) return base
        return base.replace(/[\d.]+\)\s*$/, `${alpha})`)
    }
    const raw = String(color || '').trim()
    if (!raw) return HIGHLIGHT_PALETTE[0].inkLight
    if (raw.startsWith('rgba(')) {
        return alpha === null ? raw : raw.replace(/[\d.]+\)\s*$/, `${alpha})`)
    }
    if (raw.startsWith('rgb(')) {
        return raw.replace('rgb(', 'rgba(').replace(')', `, ${alpha ?? fallbackAlpha})`)
    }
    if (/^#[0-9a-f]{3,6}$/i.test(raw)) {
        let hex = raw.slice(1)
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
        const n = parseInt(hex, 16)
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha ?? fallbackAlpha})`
    }
    return raw
}

export function getHighlightInkSolidHex(color, isDark = false) {
    const entry = getHighlightColorEntry(color)
    if (entry) return isDark ? entry.inkHexDark : entry.inkHexLight
    const raw = String(color || '').trim()
    return raw || (isDark ? HIGHLIGHT_PALETTE[0].inkHexDark : HIGHLIGHT_PALETTE[0].inkHexLight)
}

export function getHighlightStrokeHex(color, isDark = false) {
    const entry = getHighlightColorEntry(color)
    if (entry) return isDark ? entry.strokeDark : entry.strokeLight
    const raw = String(color || '').trim()
    return raw || (isDark ? HIGHLIGHT_PALETTE[0].strokeDark : HIGHLIGHT_PALETTE[0].strokeLight)
}

export function matchesHighlightColorFilter(highlightColor, filterColor) {
    const target = String(filterColor || '').trim().toLowerCase()
    if (!target || target === 'all') return true
    return normalizeHighlightColor(highlightColor).toLowerCase() === normalizeHighlightColor(filterColor).toLowerCase()
}
