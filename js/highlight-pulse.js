/**
 * highlight-pulse.js
 * Unified highlight-jump locate animation & original-hue deepening palette
 * shared by EPUB (Foliate Overlayer) and PDF (PDFViewport).
 *
 * Design intent:
 * - Never paint a muddy brown/orange search-match stain on top of highlights.
 * - Deepen the highlight's OWN hue clearly so it stays harmonious with the paper.
 * - Run a calm, unmistakable 2-round "hold -> fade -> hold -> fade" pulse (2.2s total),
 *   then disappear completely with zero residue; also cancel immediately on page turn.
 */

import { normalizeHighlightColor, getHighlightInkSolidHex } from './highlight-palette.js'

export const HIGHLIGHT_LOCATE_PULSE_DURATION_MS = 2200
export const HIGHLIGHT_LOCATE_PULSE_CLEANUP_MS = 2320

const NAMED_FALLBACK_HEX = '#facc15'

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v))
}

/**
 * Parse hex (#rgb, #rrggbb) or rgb()/rgba() CSS color strings into { r, g, b } (0..255).
 * @param {string} color
 * @returns {{ r: number, g: number, b: number }}
 */
export function parseColorToRgb(color) {
    const raw = String(color || '').trim()
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
        return {
            r: parseInt(raw[1] + raw[1], 16),
            g: parseInt(raw[2] + raw[2], 16),
            b: parseInt(raw[3] + raw[3], 16),
        }
    }
    if (/^#[0-9a-f]{6}$/i.test(raw)) {
        return {
            r: parseInt(raw.slice(1, 3), 16),
            g: parseInt(raw.slice(3, 5), 16),
            b: parseInt(raw.slice(5, 7), 16),
        }
    }
    const rgbMatch = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
    if (rgbMatch) {
        return {
            r: clamp(Math.round(Number(rgbMatch[1])), 0, 255),
            g: clamp(Math.round(Number(rgbMatch[2])), 0, 255),
            b: clamp(Math.round(Number(rgbMatch[3])), 0, 255),
        }
    }
    return parseColorToRgb(NAMED_FALLBACK_HEX)
}

function rgbToHsl(r, g, b) {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const d = max - min
    let h = 0
    const l = (max + min) / 2
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))

    if (d !== 0) {
        if (max === rn) h = ((gn - bn) / d) % 6
        else if (max === gn) h = (bn - rn) / d + 2
        else h = (rn - gn) / d + 4
        h = (h * 60 + 360) % 360
    }
    return { h, s, l }
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = l - c / 2
    let r1 = 0, g1 = 0, b1 = 0
    if (h < 60) { r1 = c; g1 = x; b1 = 0 }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0 }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c }
    else { r1 = c; g1 = 0; b1 = x }
    return {
        r: clamp(Math.round((r1 + m) * 255), 0, 255),
        g: clamp(Math.round((g1 + m) * 255), 0, 255),
        b: clamp(Math.round((b1 + m) * 255), 0, 255),
    }
}

/**
 * Compute a noticeably deepened, same-hue pulse palette from a highlight's base color.
 * - On light/sepia/green paper: shifts lightness deeper along the same hue (never muddy brown).
 * - On dark/black paper: enriches saturation & lifts luminance slightly so it reads clearly on dark ink.
 * @param {string} baseColor
 * @param {boolean} [isDark=false]
 * @returns {{ fill: string, solidHex: string, border: string, opacity: number }}
 */
export function computePulseDeepenedColor(baseColor, isDark = false) {
    const canonical = normalizeHighlightColor(baseColor)
    const paletteHex = getHighlightInkSolidHex(canonical, isDark)
    const { r, g, b } = parseColorToRgb(paletteHex || canonical)
    const { h, s, l } = rgbToHsl(r, g, b)

    let targetS
    let targetL
    let fillAlpha
    let borderAlpha

    if (isDark) {
        targetS = clamp(s < 0.08 ? s : Math.max(s, 0.72), 0, 0.94)
        targetL = clamp(l < 0.45 ? l + 0.14 : l * 0.92, 0.44, 0.68)
        fillAlpha = 0.46
        borderAlpha = 0.72
    } else {
        targetS = clamp(s < 0.08 ? s : Math.min(0.95, s + 0.14), 0, 0.96)
        // Yellow/lime hues turn muddy if darkened too aggressively; clamp them higher than blues/reds.
        const isWarmYellow = h >= 38 && h <= 72
        const minLightness = isWarmYellow ? 0.43 : 0.34
        targetL = clamp(l - (isWarmYellow ? 0.13 : 0.19), minLightness, 0.56)
        fillAlpha = 0.54
        borderAlpha = 0.72
    }

    const deep = hslToRgb(h, targetS, targetL)
    const toHex = n => n.toString(16).padStart(2, '0')
    const solidHex = `#${toHex(deep.r)}${toHex(deep.g)}${toHex(deep.b)}`

    return {
        fill: `rgba(${deep.r}, ${deep.g}, ${deep.b}, ${fillAlpha})`,
        border: `rgba(${deep.r}, ${deep.g}, ${deep.b}, ${borderAlpha})`,
        solidHex,
        opacity: fillAlpha,
    }
}

/**
 * Shared 2-round "hold -> fade -> hold -> fade" locate pulse CSS.
 * Total 2.2s (two unhurried ~1.1s cycles):
 *   Round 1: 0-8% ease-in, 8-32% calm hold (~530ms), 32-44% fade-out
 *   Breath : 44-52% transparent pause (~175ms)
 *   Round 2: 52-60% ease-in, 60-84% calm hold (~530ms), 84-100% clean fade-out
 */
export const HIGHLIGHT_LOCATE_PULSE_CSS = `
@keyframes llHighlightLocatePulse {
  0%   { opacity: 0; }
  8%   { opacity: 1; }
  32%  { opacity: 1; }
  44%  { opacity: 0; }
  52%  { opacity: 0; }
  60%  { opacity: 1; }
  84%  { opacity: 1; }
  100% { opacity: 0; }
}
.ll-highlight-locate-pulse {
  pointer-events: none !important;
  opacity: 0;
  animation: llHighlightLocatePulse ${HIGHLIGHT_LOCATE_PULSE_DURATION_MS}ms ease-in-out 1 forwards !important;
  will-change: opacity;
}
@media (prefers-reduced-motion: reduce) {
  .ll-highlight-locate-pulse {
    animation-duration: 1400ms !important;
  }
}
`

export function ensureLocatePulseStyleInRoot(rootNode, styleId = 'll-highlight-locate-pulse-style') {
    if (!rootNode) return
    const existing = rootNode.getElementById
        ? rootNode.getElementById(styleId)
        : rootNode.querySelector?.(`#${styleId}`)
    if (existing) return
    const ownerDoc = rootNode.ownerDocument || (rootNode.nodeType === 9 ? rootNode : document)
    if (!ownerDoc?.createElement) return
    const style = ownerDoc.createElement('style')
    style.id = styleId
    style.textContent = HIGHLIGHT_LOCATE_PULSE_CSS
    if (rootNode.head) rootNode.head.appendChild(style)
    else if (rootNode.appendChild) rootNode.appendChild(style)
}
