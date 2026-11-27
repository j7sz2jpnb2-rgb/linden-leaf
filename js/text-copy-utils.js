/**
 * text-copy-utils.js
 * Clean text normalization helpers for clipboard copy actions (e.g., PDF smart copy).
 */

const CJK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/
const CJK_JOIN_RE = /([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u30ff\uac00-\ud7af])\r?\n([\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u30ff\uac00-\ud7af])/g
const EN_HYPHEN_RE = /([A-Za-z]{2,})-\r?\n([a-z]{2,})/g
const HYPHENATED_COMPOUND_LEFT = new Set([
    'well', 'cost', 'self', 'non', 'cross', 'half', 'full', 'high', 'low',
    'long', 'short', 'real', 'open', 'free', 'mid', 'anti', 'pseudo', 'quasi',
    'all', 'ex', 'vice', 'two', 'three', 'four', 'five', 'multi', 'pre', 'post',
    'first', 'second', 'third', 'best', 'up', 'down', 'in', 'out', 'off', 'on',
])
const BULLET_OR_NUMBER_LINE_RE = /^\s*(?:[-•*·▪]|(?:\d{1,3}|[a-zA-Z])[.)、]|\[[0-9]+\])/
const SENTENCE_END_LINE_RE = /[。！？；.!?\u2026”’」』）】"']\s*$/

/**
 * Clean PDF copied text:
 * - Preserve explicit double-newline paragraph breaks.
 * - De-wrap soft English hyphenations across line breaks.
 * - Join accidental line wraps in prose (CJK directly, Latin or CJK-Latin with a space) while
 *   keeping intentional breaks in poetry, code blocks, and bulleted/numbered lists.
 */
export function smartCleanPdfCopyText(rawText) {
    if (typeof rawText !== 'string') return ''
    const normalized = rawText.replace(/\r\n?/g, '\n')
    if (!normalized.includes('\n')) return normalized

    const blocks = normalized.split(/\n{2,}/)
    const cleanedBlocks = blocks.map(block => {
        const lines = block.split('\n').map(line => line.replace(/[ \t]+$/g, ''))
        if (lines.length <= 1) return lines.join('')

        const nonEmptyLines = lines.filter(l => l.trim().length > 0)
        const bulletCount = nonEmptyLines.filter(l => BULLET_OR_NUMBER_LINE_RE.test(l)).length
        const shortCount = nonEmptyLines.filter(l => l.trim().length < 18).length
        const hasSoftHyphen = /[A-Za-z]{2,}-\n[a-z]{2,}/.test(block)
        const looksLikeCodeOrPoetry = !hasSoftHyphen && nonEmptyLines.length >= 3 && (
            bulletCount >= 2 ||
            (shortCount / nonEmptyLines.length) > 0.72
        )
        if (looksLikeCodeOrPoetry) {
            return lines.join('\n')
        }

        let joined = lines.join('\n')
        // De-wrap broken line-end hyphenations while preserving genuine hyphenated compounds (e.g. well-known)
        joined = joined.replace(EN_HYPHEN_RE, (full, left, right) => (
            HYPHENATED_COMPOUND_LEFT.has(left.toLowerCase()) ? `${left}-${right}` : `${left}${right}`
        ))

        // Walk line by line so list lines or clear paragraph-like short sentence endings aren't flattened
        const stepLines = joined.split('\n')
        let out = ''
        for (let i = 0; i < stepLines.length; i++) {
            const cur = stepLines[i].trimEnd()
            if (i === 0) {
                out = cur
                continue
            }
            const nextTrim = stepLines[i].trimStart()
            if (!nextTrim) {
                out += '\n'
                continue
            }
            if (BULLET_OR_NUMBER_LINE_RE.test(nextTrim)) {
                out += '\n' + nextTrim
                continue
            }
            const prevTrim = out.trimEnd()
            const prevLine = prevTrim.split('\n').pop() || ''
            const prevLen = prevLine.length
            const lastChar = prevTrim.slice(-1)
            const nextChar = nextTrim[0]
            if (SENTENCE_END_LINE_RE.test(prevTrim) && prevLen > 0 && prevLen < 26) {
                out += '\n' + nextTrim
                continue
            }
            if (prevLen > 0 && prevLen < 16 && CJK_CHAR_RE.test(lastChar) && /^[A-Z]/.test(nextChar)) {
                out += '\n' + nextTrim
                continue
            }
            const pair = `${lastChar}\n${nextChar}`
            if (CJK_JOIN_RE.test(pair)) {
                CJK_JOIN_RE.lastIndex = 0
                out += nextTrim
            } else {
                const cjkWordJoin = (CJK_CHAR_RE.test(lastChar) && /[A-Za-z0-9]/.test(nextChar)) ||
                    (/[A-Za-z0-9]/.test(lastChar) && CJK_CHAR_RE.test(nextChar))
                const latinJoin = /[A-Za-z0-9,.;:!?)]/.test(lastChar) && /[A-Za-z0-9(\["']/.test(nextChar)
                out += (cjkWordJoin || latinJoin ? ' ' : '') + nextTrim
            }
        }
        return out
    })

    return cleanedBlocks.join('\n\n')
}
