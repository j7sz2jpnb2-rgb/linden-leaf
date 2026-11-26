/**
 * pdf-color-filter.js
 * Engine-agnostic Rec. 709 SVG <feColorMatrix> theme tinting for PDF pages.
 * Maps paper luma linearly onto theme background -> foreground while preserving
 * damped color chroma so diagrams and links remain distinguishable without
 * dark-mode channel blowout. Applies strictly to raster/canvas media layers,
 * never to highlight or drawing overlays.
 */

const LUMA = Object.freeze([0.2126, 0.7152, 0.0722])

export const PDF_THEME_PALETTES = Object.freeze({
    sepia: Object.freeze({ background: '#f5eedc', foreground: '#3b2e1e', chromaScale: 0.95 }),
    warm: Object.freeze({ background: '#faf6ec', foreground: '#292524', chromaScale: 0.96 }),
    green: Object.freeze({ background: '#e8f5e9', foreground: '#1b4d1d', chromaScale: 0.95 }),
    dark: Object.freeze({ background: '#262624', foreground: '#e8e6df', chromaScale: 0.85 }),
    black: Object.freeze({ background: '#0e0e0e', foreground: '#d4d4d0', chromaScale: 0.85 }),
})

export function parseHexRgbUnit(color) {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color || '').trim())?.[1]
    if (!hex) return null
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
}

/**
 * Compute a 4x5 (20-element) SVG feColorMatrix linear ramp mapping black->foreground
 * and white->background while scaling off-gray chroma by chromaScale.
 */
export function computePdfThemeColorMatrix({ foreground, background, chromaScale = 1.0 } = {}) {
    const fg = parseHexRgbUnit(foreground)
    const bg = parseHexRgbUnit(background)
    if (!fg || !bg) return null
    if (fg.every(v => v === 0) && bg.every(v => v === 1)) return null
    const cScale = Number.isFinite(Number(chromaScale)) ? Math.max(0.4, Math.min(1.0, Number(chromaScale))) : 1.0
    const matrix = []
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const diag = i === j ? cScale : 0
            const ramp = (bg[i] - fg[i] - cScale) * LUMA[j]
            matrix.push(Number((diag + ramp).toFixed(6)))
        }
        matrix.push(0)
        matrix.push(Number(fg[i].toFixed(6)))
    }
    return matrix.concat([0, 0, 0, 1, 0])
}

export function resolvePdfThemeTargets({
    appearance = 'auto',
    theme = 'light',
    customBackground = null,
    customForeground = null,
} = {}) {
    const normalizedAppearance = ['auto', 'original', 'night'].includes(appearance) ? appearance : 'auto'
    if (normalizedAppearance === 'original') return null

    if (normalizedAppearance === 'night') {
        const darkPreset = theme === 'black' ? PDF_THEME_PALETTES.black : PDF_THEME_PALETTES.dark
        return darkPreset
    }

    const activeTheme = String(theme || 'light').toLowerCase()
    if (activeTheme === 'light' || activeTheme === 'eink') return null
    if (customBackground && customForeground) {
        const isDarkTheme = activeTheme === 'dark' || activeTheme === 'black'
        return {
            background: customBackground,
            foreground: customForeground,
            chromaScale: isDarkTheme ? 0.85 : 0.95,
        }
    }
    return PDF_THEME_PALETTES[activeTheme] || null
}

export function ensurePdfColorFilterSvg(matrix, filterId = 'linden-pdf-theme-filter') {
    if (!matrix || typeof document === 'undefined' || !document.body) return null
    const values = matrix.join(' ')
    let host = document.getElementById('linden-pdf-theme-filters')
    if (!host) {
        host = document.createElement('div')
        host.id = 'linden-pdf-theme-filters'
        host.setAttribute('aria-hidden', 'true')
        host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict;'
        const ns = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(ns, 'svg')
        svg.setAttribute('width', '0')
        svg.setAttribute('height', '0')
        const filter = document.createElementNS(ns, 'filter')
        filter.id = filterId
        filter.setAttribute('color-interpolation-filters', 'sRGB')
        const feMatrix = document.createElementNS(ns, 'feColorMatrix')
        feMatrix.setAttribute('type', 'matrix')
        feMatrix.setAttribute('values', values)
        filter.appendChild(feMatrix)
        svg.appendChild(filter)
        host.appendChild(svg)
        document.body.appendChild(host)
    } else {
        const feMatrix = host.querySelector(`#${filterId} feColorMatrix`)
        if (feMatrix && feMatrix.getAttribute('values') !== values) {
            feMatrix.setAttribute('values', values)
        }
    }
    return `url(#${filterId})`
}

export function resolvePdfPageFilter(options = {}) {
    const target = resolvePdfThemeTargets(options)
    if (!target) return null
    const matrix = computePdfThemeColorMatrix(target)
    if (!matrix) return null
    if (typeof document === 'undefined' || !document.body) {
        return `svg-matrix(${matrix.slice(0, 5).join(',')})`
    }
    return ensurePdfColorFilterSvg(matrix)
}
