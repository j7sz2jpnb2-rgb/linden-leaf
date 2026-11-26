/**
 * chinese-quotes.js
 * Reversible, idempotent CJK corner-quote (「」 / 『』) transformer.
 * Preserves original text node values in a WeakMap so toggling the setting ON or OFF
 * applies instantaneously to already-mounted reader documents without reloading or
 * breaking CFI anchors.
 */

const originalNodeTextCache = new WeakMap()

const SKIPPED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SVG', 'MATH', 'KBD', 'SAMP'
])

/**
 * Convert curly quotation marks in a single string into CJK corner quotes
 * while preserving English apostrophes inside Latin words and plural possessives.
 * @param {string} input
 * @returns {string}
 */
export function transformChineseQuotes(input) {
    if (typeof input !== 'string' || !input) return input
    if (!/[“”‘’]/.test(input)) return input

    let text = input
    // 1. Chinese double quotes “ and ” -> 「 and 」
    text = text.replace(/“/g, '「').replace(/”/g, '」')
    // 2. Chinese single opening quote ‘ -> 『
    text = text.replace(/‘/g, '『')
    // 3. Replace ’ with 』 ONLY when it is NOT an English apostrophe
    text = text.replace(/(?<![a-zA-Z0-9])’|’(?![a-zA-Z0-9])/g, (match, offset, fullStr) => {
        const before = fullStr.slice(Math.max(0, offset - 10), offset)
        if (/[a-zA-Z]+s$/i.test(before)) {
            return '’'
        }
        return '』'
    })
    return text
}

/**
 * Determine whether a document contains predominantly CJK text and is eligible
 * for Chinese corner-quote conversion.
 * @param {Document} doc
 * @param {string} [bookLang]
 * @returns {boolean}
 */
export function isPredominantlyCjkDocument(doc, bookLang = '') {
    if (!doc?.body) return false
    const normalizedLang = String(bookLang || '').trim().toLowerCase()
    if (normalizedLang.startsWith('en')) return false

    const sampleText = (doc.body.innerText || doc.body.textContent || '').slice(0, 3000)
    const cjkCount = (sampleText.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length
    const latinCount = (sampleText.match(/[a-zA-Z]/g) || []).length

    return (
        (cjkCount > 0 && latinCount === 0) ||
        (cjkCount >= 10 && cjkCount >= latinCount * 0.2)
    )
}

function isInsideSkippedElement(textNode) {
    let el = textNode?.parentElement
    while (el) {
        if (SKIPPED_TAGS.has(el.tagName)) return true
        el = el.parentElement
    }
    return false
}

/**
 * Apply or revert Chinese corner quotes on an active reader Document in place.
 * Safe to invoke repeatedly when the user toggles the setting live.
 * @param {Document} doc
 * @param {boolean} enabled
 * @param {{ bookLang?: string }} [options]
 * @returns {{ changedCount: number, skipped: boolean }}
 */
export function applyChineseQuotesToDocument(doc, enabled, options = {}) {
    if (!doc?.body || typeof doc.createTreeWalker !== 'function') {
        return { changedCount: 0, skipped: true }
    }

    const filterShowText = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4

    if (!enabled) {
        let restored = 0
        const walker = doc.createTreeWalker(doc.body, filterShowText)
        let node = walker.nextNode()
        while (node) {
            if (originalNodeTextCache.has(node)) {
                const orig = originalNodeTextCache.get(node)
                if (node.nodeValue !== orig) {
                    node.nodeValue = orig
                    restored++
                }
            }
            node = walker.nextNode()
        }
        return { changedCount: restored, skipped: false }
    }

    if (!isPredominantlyCjkDocument(doc, options.bookLang)) {
        return { changedCount: 0, skipped: true }
    }

    let transformed = 0
    const walker = doc.createTreeWalker(doc.body, filterShowText)
    let node = walker.nextNode()
    while (node) {
        if (node.nodeValue && !isInsideSkippedElement(node)) {
            const baseline = originalNodeTextCache.has(node)
                ? originalNodeTextCache.get(node)
                : node.nodeValue
            if (/[“”‘’]/.test(baseline)) {
                if (!originalNodeTextCache.has(node)) {
                    originalNodeTextCache.set(node, baseline)
                }
                const converted = transformChineseQuotes(baseline)
                if (node.nodeValue !== converted) {
                    node.nodeValue = converted
                    transformed++
                }
            }
        }
        node = walker.nextNode()
    }

    return { changedCount: transformed, skipped: false }
}
