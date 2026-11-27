/**
 * txt-purifier.js
 * Clean offline TXT/Novel text purification: strips piracy site banners/watermarks,
 * collapses excessive blank lines, and runs bounded safe custom replacement rules.
 */

export const DEFAULT_TXT_AD_PATTERNS = Object.freeze([
    /(?:https?:\/\/)?(?:www\.|m\.)?[a-z0-9-]+\.(?:com|net|org|cc|la|tw|co|io|xyz)(?:\/\S*)?/i,
    /记住本站网址|天才一秒记住|笔趣阁|新笔趣阁|顶点小说|飘天文学|八一中文网|手机版阅读网址|最快更新.*最新章节/,
    /^\s*[（(【\[]?\s*(?:本章未完|未完待续|请点击下一页继续阅读|求收藏|求推荐票?|求月票|求订阅|求打赏|第\s*\d+\s*\/\s*\d+\s*页)(?:[，,、；;！!\s]*(?:本章未完|未完待续|请点击下一页继续阅读|求收藏|求推荐票?|求月票|求订阅|求打赏))*\s*[）)】\]]?\s*$/,
])

const CHAPTER_SAFEGUARD_RE = /^\s*(?:第\s*[零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9]+\s*[章回节卷集部篇幕话折]|Chapter\s+[0-9IVXLCDM]+)/i

/**
 * Checks whether a user regex pattern avoids nested-quantifier ReDoS patterns.
 */
export function isSafeCustomRegex(pattern) {
    const s = String(pattern || '')
    if (!s || s.length > 200) return false
    if (/(\([^)]*[+*][^)]*\)|\[[^\]]*[+*][^\]]*\])[+*?{]/.test(s)) return false
    try {
        // eslint-disable-next-line no-new
        new RegExp(s)
        return true
    } catch (_) {
        return false
    }
}

export function parseCustomPurifyRules(rawText = '') {
    const lines = String(rawText || '').split(/\r?\n/)
    const rules = []
    for (const raw of lines) {
        const line = raw.trim()
        if (!line || line.startsWith('//') || line.startsWith('#')) continue
        const sepIdx = line.indexOf('=>')
        const pattern = (sepIdx >= 0 ? line.slice(0, sepIdx) : line).trim()
        const replace = sepIdx >= 0 ? line.slice(sepIdx + 2) : ''
        if (!pattern || pattern.length > 200) continue
        if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 1) {
            const last = pattern.lastIndexOf('/')
            const body = pattern.slice(1, last)
            const flags = pattern.slice(last + 1).replace(/[^gimsuy]/g, '')
            if (!isSafeCustomRegex(body)) continue
            rules.push({ regex: new RegExp(body, flags.includes('g') ? flags : `${flags}g`), replace })
        } else {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            rules.push({ regex: new RegExp(escaped, 'g'), replace })
        }
        if (rules.length >= 30) break
    }
    return rules
}

/**
 * Purify TXT chapter text synchronously in bounded O(N) time.
 * @param {string} text
 * @param {{ enabled?: boolean, stripAds?: boolean, collapseBlankLines?: boolean, customRulesText?: string }} [config]
 * @returns {string}
 */
export function purifyTxtContent(text, config = {}) {
    const src = String(text || '')
    if (!config || config.enabled === false) return src

    const stripAds = config.stripAds !== false
    const collapseBlankLines = config.collapseBlankLines !== false
    const customRules = config.customRulesText ? parseCustomPurifyRules(config.customRulesText) : []

    let lines = src.replace(/\r\n?/g, '\n').split('\n')

    if (stripAds) {
        lines = lines.filter(line => {
            const trimmed = line.trim()
            if (!trimmed) return true
            if (CHAPTER_SAFEGUARD_RE.test(trimmed)) return true
            if (trimmed.length > 180) return true // Avoid filtering long narrative prose paragraphs
            return !DEFAULT_TXT_AD_PATTERNS.some(re => re.test(trimmed))
        })
    }

    let out = lines.join('\n')

    for (const rule of customRules) {
        out = out.replace(rule.regex, rule.replace)
    }

    if (collapseBlankLines) {
        out = out
            .replace(/[ \t]+$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    }

    return out
}
