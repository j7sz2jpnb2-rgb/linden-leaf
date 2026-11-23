// txt.js - Intelligent TXT/Markdown book parser with Poetry & Chapter detection for foliate-js
import { runTxtRulesWorker } from '../js/txt-toc-worker.js'
import { getLocale, t } from '../js/i18n.js'
import { resolveBookTitle } from '../js/book-title.js'

export const TXT_LAYOUT_VERSION = 2

let mergeSoftBreaks = true
export const setTxtMergeSoftBreaks = enabled => { mergeSoftBreaks = enabled !== false }

const MIME = {
    XHTML: 'application/xhtml+xml',
    SVG: 'image/svg+xml',
}

const escapeHTML = str => (str != null ? String(str) : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

const TEXT_SAMPLE_BYTES = 64 * 1024
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const LATIN = /\p{Script=Latin}/u

const CONTENT_LABELS = {
    zh: { contents: '扉页 / 目录', front: '扉页 / 题记', end: '终章', continued: n => '（续 ' + n + '）' },
    en: { contents: 'Front Matter / Contents', front: 'Front Matter', end: 'Final Chapter', continued: n => 'Continued ' + n },
}

const contentLabels = language =>
    CONTENT_LABELS[language === 'zh-CN' || (language === 'und' && getLocale().startsWith('zh')) ? 'zh' : 'en']

const detectAndDecode = (buffer, partial = false) => {
    const bytes = new Uint8Array(buffer)
    const bomEncoding = bytes[0] === 0xFE && bytes[1] === 0xFF ? 'utf-16be'
        : bytes[0] === 0xFF && bytes[1] === 0xFE ? 'utf-16le'
        : bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 'utf-8' : null
    if (bomEncoding) return new TextDecoder(bomEncoding).decode(bytes, { stream: partial })
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial })
    } catch {
        // A GB18030 decoder can consume a Western smart quote plus the next
        // Latin letter. Require evidence of Chinese prose before choosing it.
        const start = bytes.findIndex(byte => byte >= 0x80)
        const end = Math.min(bytes.length, start + TEXT_SAMPLE_BYTES)
        const chinese = new TextDecoder('gb18030').decode(bytes.subarray(start, end), { stream: partial || end < bytes.length })
        const han = (chinese.match(/\p{Script=Han}/gu) || []).length
        const latin = (chinese.match(/\p{Script=Latin}/gu) || []).length
        const useChinese = /\p{Script=Han}[\p{Script=Han}，。！？、]/u.test(chinese)
            || (han > 0 && han * 4 >= latin && !chinese.includes('\uFFFD'))
        return new TextDecoder(useChinese ? 'gb18030' : 'windows-1252').decode(bytes, { stream: partial })
    }
}

const detectLanguage = text => {
    const sample = text.slice(0, 16000)
    let cjk = 0
    let latin = 0
    for (const ch of sample) {
        if (CJK.test(ch)) cjk++
        else if (LATIN.test(ch)) latin++
    }
    if (cjk > 0 && cjk * 8 >= latin) return 'zh-CN'
    return latin > 0 ? 'en' : 'und'
}

const txtMetadata = (name, text) => {
    const stem = String(name || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '').trim()
    const authorParts = stem.match(/^(.+?)\s*[（(]?\s*作者[：:]\s*(.+?)\s*[）)]?$/)
        || stem.match(/^(《[^》]+》)\s*[-–—]\s*(.+)$/)
        || stem.match(/^(.+?)\s+(?:--?|[–—])\s+(.+)$/)
        || stem.match(/^(.+?)\s+(?:by|By)\s+((?!(?:Me|You|Us|Him|Her|Them|It)$)\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*)*)$/u)
    return {
        title: resolveBookTitle(authorParts?.[1] || stem),
        author: authorParts?.[2].trim() || t('book.unknownAuthor'),
        language: detectLanguage(text),
    }
}

export const readTxtMetadata = async file => {
    const sample = file.slice(0, TEXT_SAMPLE_BYTES)
    return txtMetadata(file.name, detectAndDecode(await sample.arrayBuffer(), sample.size < file.size))
}

// Generate an artistic clean SVG book cover
const generateCoverSVG = (title, author) => {
    const safeTitle = escapeHTML(title.length > 24 ? title.slice(0, 22) + '...' : title)
    const safeAuthor = escapeHTML(author)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <rect x="36" y="36" width="528" height="828" fill="none" stroke="#334155" stroke-width="1.5"/>
  <line x1="60" y1="120" x2="540" y2="120" stroke="#475569" stroke-width="1"/>
  <text x="300" y="320" font-family="'Source Han Serif SC', 'Songti SC', 'SimSun', serif" font-size="44" font-weight="700" fill="#f8fafc" text-anchor="middle" letter-spacing="1.5">
    ${safeTitle}
  </text>
  <line x1="260" y1="380" x2="340" y2="380" stroke="#64748b" stroke-width="1.5"/>
  <text x="300" y="440" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif" font-size="24" fill="#94a3b8" text-anchor="middle">
    ${safeAuthor}
  </text>
  <line x1="60" y1="780" x2="540" y2="780" stroke="#475569" stroke-width="1"/>
</svg>`
}

export const isTXT = file => {
    const name = file.name ? file.name.toLowerCase() : ''
    const type = file.type || ''
    return type === 'text/plain' || type === 'text/markdown' || name.endsWith('.txt') || name.endsWith('.md')
}

// Chapter Heading Detector
const CHAPTER_PATTERNS = [
    // 第X首/章/回/节/卷/集/部/篇/幕/话/诗/曲/折/出/段/讲/场/辑/案 (e.g. 第一首哀歌, 第一章, 第二回, 第一卷)
    /^(?:第\s*[0-9一二三四五六七八九十百千万零两]+\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案])(?:[：:\s\-—_]+.*)?$/i,
    /^(?:第\s*[0-9一二三四五六七八九十百千万零两]+\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案][\u4e00-\u9fa5a-zA-Z0-9\s（）()《》·]{0,30})$/i,
    // Chapter 1, Section 1, Act I, Book 1, Canto 1, Sonnet 1, Elegie 1, Elegy 1
    /^(?:Chapter|Section|Book|Part|Act|Scene|Canto|Sonnet|Elegie|Elegy)\s+[0-9IVXLCDMivxlcdm]+(?:[：:\s\-—_]+.*)?$/i,
    // 序言/前言/引子/楔子/尾声/后记/跋/附录/自序/译者序/导言
    /^(?:引子|序言|前言|序|后记|尾声|番外(?:篇)?|楔子|跋|附录|正文|终章|上篇|中篇|下篇|总序|自序|译者序|译者后记|导言|题记|写在前面|写在最后)(?:[：:\s\-—_].*)?$/i,
    // 卷一, 卷1, 卷上, 卷下, 部一, 篇一
    /^(?:卷|部|篇)\s*[0-9一二三四五六七八九十上下IVXLCDMivxlcdm]+(?:[：:\s\-—_].*)?$/i,
    // 中文数字章节：一、标题, （一）标题, 1. 标题 (必须有明确点/顿号且标题较短 <= 20字)
    /^(?:[一二三四五六七八九十]{1,3}|[0-9]{1,3})[、.．]\s*[\u4e00-\u9fa5a-zA-Z0-9（）()《》·\s]{1,20}$/,
    // 括号章节：【第一章】, （第一首）, [Chapter 1]
    /^[【\[（(](?:第\s*[0-9一二三四五六七八九十百千万零两]+\s*[首章节回卷集部篇幕话]|[0-9一二三四五六七八九十]{1,3}|(?:Chapter|Book|Canto)\s+[0-9IVXLCDMivxlcdm]+)[】\]）)](?:[\u4e00-\u9fa5a-zA-Z0-9\s]{0,25})?$/i
]

let customTxtPatterns = null

export const setCustomTxtPatterns = (patterns) => {
    if (!patterns || !Array.isArray(patterns) || patterns.length === 0) {
        customTxtPatterns = null
        return
    }
    customTxtPatterns = patterns
}

export const getCustomTxtPatterns = () => customTxtPatterns

const isLegacyChapterHeading = line => {
    const trimmed = (line || '').trim()
    if (!trimmed) return false

    // Built-in heuristics with safety constraints (never run unbounded user regex on main thread)
    if (trimmed.length > 35) return false
    // If it contains typical sentence punctuation, it's content/poem, not a chapter heading
    if (/[,，;；!！?？"“”'‘’]/.test(trimmed)) return false
    // Pure Arabic number + space + sentence is a numbered verse line, NOT a chapter heading!
    if (/^\d{1,5}\s+/.test(trimmed)) return false
    return CHAPTER_PATTERNS.some(re => re.test(trimmed))
}

const EN_NUMBER_WORD = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth'
const EN_NUMBERED_HEADING = new RegExp(
    '^(Chapter|Section|Book|Part|Act|Scene|Canto|Sonnet|Elegie|Elegy)\\s+(\\d{1,4}|[IVXLCDM]+|' + EN_NUMBER_WORD + ')(?=$|[\\s.:：—–-])',
    'i'
)
const EN_STRUCTURE = /^(Prologue|Epilogue|Preface|Foreword|Introduction|Afterword|Appendix|Interlude|Notes|Acknowledg(?:e)?ments|Bibliography)(?:$|\s*[:：—–-]\s*.+$)/i
const ROMAN = /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/
const ROMAN_HEADING = /^([IVXLCDM]+)(?:\.|\.\s+.+|\s*[:—–-]\s*.+)?$/
const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }

const modernHeading = (line, markdown = false) => {
    const trimmed = (line || '').trim()
    if (!trimmed || trimmed.length > 120) return null
    const markdownTitle = markdown && trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/)?.[1]
    const title = markdownTitle || trimmed
    const numbered = title.match(EN_NUMBERED_HEADING)
    if (numbered) {
        const number = numbered[2].toUpperCase()
        if (!/^[IVXLCDM]+$/.test(number) || ROMAN.test(number)) {
            return { title, key: numbered[1].toLowerCase() + ' ' + numbered[2].toLowerCase().replace(/-/g, ' ') }
        }
    }
    const structure = title.match(EN_STRUCTURE)
    if (structure) return { title, key: structure[1].toLowerCase() }
    const roman = title.match(ROMAN_HEADING)
    if (roman && ROMAN.test(roman[1])) {
        const letters = roman[1]
        const value = [...letters].reduce((sum, letter, i) =>
            sum + ROMAN_VALUES[letter] * (ROMAN_VALUES[letter] < ROMAN_VALUES[letters[i + 1]] ? -1 : 1), 0)
        return { title, key: 'roman ' + value, roman: value, bareRoman: !markdownTitle && title === letters }
    }
    if (markdownTitle || isLegacyChapterHeading(title)) return { title, key: extractChapterKey(title) }
    return null
}

export const isChapterHeading = line => Boolean(modernHeading(line))

const isLegacyTOCMarker = line => {
    const trimmed = (line || '').trim()
    if (!trimmed || trimmed.length > 25) return false
    return /^(?:目\s*录|目\s*次|Contents|Table\s+of\s+Contents|Index)\b/i.test(trimmed) ||
           /^[【\[（(]\s*(?:目\s*录|目\s*次|Contents)\s*[】\]）)]$/i.test(trimmed)
}

const extractChapterKey = title => {
    const trimmed = (title || '').trim().replace(/[\s\t\u3000\u00A0]+/g, ' ')
    const engMatch = trimmed.match(/^(?:Chapter|Section|Book|Part|Act|Scene|Canto|Sonnet|Elegie|Elegy)\s+[0-9IVXLCDMivxlcdm]+/i)
    if (engMatch) return engMatch[0].toLowerCase()
    const zhMatch = trimmed.match(/^第\s*[0-9一二三四五六七八九十百千万零两]+\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案]/)
    if (zhMatch) return zhMatch[0].replace(/\s+/g, '')
    const numMatch = trimmed.match(/^(?:[一二三四五六七八九十]{1,3}|[0-9]{1,3})[、.．]/)
    if (numMatch) return numMatch[0]
    return trimmed.toLowerCase().replace(/^[【\[（(]+|[】\]）)]+$/g, '')
}

// Render content lines with Poetry / Prose / TOC intelligence
const isTOCMarker = line => {
    const trimmed = (line || '').trim()
    return trimmed.length <= 32 && /^(?:目\s*录|目\s*次|Contents|Table\s+of\s+Contents|Index)\s*[:：]?$/i
        .test(normalizeChapterTitle(trimmed.replace(/^#{1,6}[ \t]+/, '')))
}

const looksLikeEnglishVerse = blocks => {
    const stanzas = blocks.filter(block => block.length >= 2 && block.length <= 12)
    if (stanzas.length < 2 || stanzas.length * 2 < blocks.length) return false
    let lines = 0, shortLines = 0, continued = 0, uppercase = 0
    let shortest = Infinity, longest = 0
    for (const stanza of stanzas) {
        stanza.forEach(({ text }, index) => {
            const line = text.trim()
            lines++
            if (line.length <= 68 && line.split(/\s+/).length <= 12) shortLines++
            if (index > 0) {
                continued++
                if (/^\p{Lu}/u.test(line)) uppercase++
            }
            if (index < stanza.length - 1) {
                shortest = Math.min(shortest, line.length)
                longest = Math.max(longest, line.length)
            }
        })
    }
    return shortLines >= lines * 0.8 && (longest - shortest >= 12 || uppercase >= continued * 0.75)
}

const renderContentToHTML = (linesWithMeta, { isPoetryMode, tocLinkMap, language, legacyLayout }) => {
    const tocMarker = legacyLayout ? isLegacyTOCMarker : isTOCMarker
    const joinSoftBreaks = legacyLayout || mergeSoftBreaks
    // Group into stanzas / paragraphs by blank lines
    const blocks = []
    let curBlock = []

    for (const item of linesWithMeta) {
        const text = typeof item === 'string' ? item : (item?.text ?? '')
        const trimmed = text.trim()
        if (!trimmed || (!legacyLayout && (item.isTOC || tocMarker(text)))) {
            if (curBlock.length > 0) {
                blocks.push(curBlock)
                curBlock = []
            }
            if (trimmed) blocks.push([item])
        } else {
            curBlock.push(item)
        }
    }
    if (curBlock.length > 0) blocks.push(curBlock)

    // Detect if this section is poetry (short line length or poetry keywords)
    let totalLen = 0
    let lineCount = 0
    for (const blk of blocks) {
        for (const item of blk) {
            totalLen += item.text.trim().length
            lineCount++
        }
    }
    const avgLen = lineCount > 0 ? (totalLen / lineCount) : 50
    // Poetry requires short average line length and genuine multi-stanza structure
    const isPoetry = isPoetryMode || (!legacyLayout && language === 'en'
        ? looksLikeEnglishVerse(blocks)
        : (avgLen < 26 && lineCount >= 4 && blocks.length >= 2))

    const htmlParts = []
    let inTOCBlock = false

    const closeTOCBlock = () => {
        if (inTOCBlock) {
            htmlParts.push('</div>')
            inTOCBlock = false
        }
    }

    for (const blk of blocks) {
        // If explicit TOC title marker (e.g. "目录" or "Contents")
        if (blk.length === 1 && tocMarker(blk[0].text)) {
            closeTOCBlock()
            htmlParts.push(`<h2 class="toc-marker">${escapeHTML(blk[0].text.trim())}</h2>`)
            continue
        }

        // If block is a TOC entry
        if (blk.length === 1 && blk[0].isTOC) {
            if (!inTOCBlock) {
                htmlParts.push('<div class="book-toc-block">')
                inTOCBlock = true
            }
            const linkInfo = tocLinkMap?.get(blk[0].lineIndex)
            const itemText = escapeHTML(blk[0].text.trim())
            if (linkInfo?.href) {
                htmlParts.push(`<p class="toc-line"><a href="${escapeHTML(linkInfo.href)}">${itemText}</a></p>`)
            } else {
                htmlParts.push(`<p class="toc-line">${itemText}</p>`)
            }
            continue
        }

        // Normal content block: ensure TOC block is closed
        closeTOCBlock()

        if (isPoetry) {
            // Render as poetic stanza with natural line breaks
            const verseText = blk.map(item => escapeHTML(item.text.trim())).join('<br/>\n')
            htmlParts.push(`<p class="verse-stanza">\n${verseText}\n</p>`)
        } else if (!joinSoftBreaks) {
            for (const item of blk) htmlParts.push(`<p class="prose-p">${escapeHTML(item.text.trim())}</p>`)
        } else {
            // Render as prose paragraph with smart spacing for English/Latin words
            let paraText = ''
            for (let i = 0; i < blk.length; i++) {
                const line = blk[i].text.trim()
                if (!line) continue
                if (!paraText) {
                    paraText = line
                } else {
                    const prevChar = paraText.slice(-1)
                    const nextChar = line.charAt(0)
                    const needsSpace = !legacyLayout && language === 'en'
                        ? !/[-\u00ad]$/.test(prevChar)
                        : /[a-zA-Z0-9,.:;!?)]/.test(prevChar) && /[a-zA-Z0-9(]/.test(nextChar)
                    paraText += (needsSpace ? ' ' : '') + line
                }
            }
            htmlParts.push(`<p class="prose-p">${escapeHTML(paraText)}</p>`)
        }
    }
    closeTOCBlock()

    return htmlParts.join('\n')
}

const normalizeChapterTitle = str => (str || '')
    .trim()
    .replace(/[\s\t\u3000\u00A0]+/g, ' ')
    .replace(/^[【\[（(]+|[】\]）)]+$/g, '')

const isDecorativeDividerOnly = line => {
    const trimmed = (typeof line === 'string' ? line : (line?.text ?? '')).trim()
    return trimmed.length > 0 && /^[-=_*#~`^/\\+|—\s]+$/.test(trimmed)
}

export const makeTXT = async (file, { filename = file.name, legacyLayout = false } = {}) => {
    const rawText = detectAndDecode(await file.arrayBuffer())
    const { title, author, language } = txtMetadata(filename, rawText)
    const labels = contentLabels(language)
    const lines = rawText.split(legacyLayout ? /\r?\n/ : /\r\n?|\n/)
    const markdown = !legacyLayout && (file.type === 'text/markdown' || /\.md$/i.test(filename || ''))
    const tocMarker = legacyLayout ? isLegacyTOCMarker : isTOCMarker

    const poetryTitle = legacyLayout
        ? /哀歌|诗选|诗集|诗篇|诗歌|十四行诗|商籁|sonnet|elegy|poem/i
        : /哀歌|诗选|诗集|诗篇|诗歌|十四行诗|商籁|\b(?:sonnets?|elegy|elegies|poems?|poetry)\b/i
    const isBookPoetry = poetryTitle.test(title) || /哀歌|诗选|诗集/.test(rawText.slice(0, 200))

    // Legacy layout retains the section and paragraph coordinates of older CFI anchors.
    const activeRules = legacyLayout ? null : customTxtPatterns
    const customLineMatches = new Map()
    if (activeRules?.length) {
        try {
            const workerRes = await runTxtRulesWorker({
                lines,
                rules: activeRules,
                timeoutMs: 2500
            })
            for (const m of (workerRes.matches || [])) {
                customLineMatches.set(m.lineIndex, m)
            }
        } catch (err) {
            console.warn('[TXT] Custom TOC regex worker failed or timed out, preserving built-in heuristics:', err)
        }
    }

    const isStrictOnly = activeRules?.strictOnly && customLineMatches.size > 0
    let candidates = []
    let fence = null
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const custom = customLineMatches.get(i)
        if (custom) {
            const title = custom.title || line.trim()
            candidates.push({ lineIndex: i, title, key: extractChapterKey(title) })
            continue
        }
        if (isStrictOnly) continue
        if (markdown) {
            const marker = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/)
            if (marker) {
                if (!fence) fence = marker[1]
                else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
                continue
            }
            if (fence) continue
        }
        const heading = legacyLayout
            ? (isLegacyChapterHeading(line) && { title: line.trim(), key: extractChapterKey(line) })
            : modernHeading(line, markdown)
        if (heading) candidates.push({ ...heading, lineIndex: i })
    }
    const romanNumbers = new Set(candidates.filter(c => c.roman).map(c => c.roman))
    candidates = candidates.filter(c => !c.bareRoman ||
        ((!lines[c.lineIndex - 1]?.trim() || !lines[c.lineIndex + 1]?.trim()) &&
            (romanNumbers.has(c.roman - 1) || romanNumbers.has(c.roman + 1))))
    const headings = new Map(candidates.map(c => [c.lineIndex, c]))

    // Compute body size and line counts between consecutive heading candidates
    for (let i = 0; i < candidates.length; i++) {
        const cur = candidates[i]
        const next = candidates[i + 1]
        const endLine = next ? next.lineIndex : lines.length
        let charCount = 0
        let nonBlankLines = 0
        for (let l = cur.lineIndex + 1; l < endLine; l++) {
            const text = lines[l].trim()
            if (text.length > 0) {
                charCount += text.length
                nonBlankLines++
            }
        }
        cur.bodyCharCount = charCount
        cur.bodyLineCount = nonBlankLines
    }

    // Detect explicit TOC marker near the start of the book (within first 300 lines)
    let explicitTOCLine = -1
    for (let i = 0; i < Math.min(lines.length, 300); i++) {
        if (tocMarker(lines[i])) {
            explicitTOCLine = i
            break
        }
    }

    // Group candidates into clusters where distance between consecutive headings is small (< 120 chars)
    const clusters = []
    let curCluster = []
    const clusterKeys = new Set()

    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        const isRepeatedInCluster = clusterKeys.has(c.key)
        const isMainBodyMarker = /^正文$/i.test(c.title.trim())

        if (curCluster.length === 0) {
            if (!isMainBodyMarker) {
                curCluster.push(c)
                clusterKeys.add(c.key)
            }
        } else {
            const prev = curCluster[curCluster.length - 1]
            if (!isRepeatedInCluster && !isMainBodyMarker && prev.bodyCharCount < 120 && prev.bodyLineCount <= 3) {
                curCluster.push(c)
                clusterKeys.add(c.key)
            } else {
                if (curCluster.length > 0) clusters.push(curCluster)
                curCluster = isMainBodyMarker ? [] : [c]
                clusterKeys.clear()
                if (!isMainBodyMarker) clusterKeys.add(c.key)
            }
        }
    }
    if (curCluster.length > 0) clusters.push(curCluster)

    // Identify TOC candidates
    const tocCandidateIndices = new Set()
    for (const cluster of clusters) {
        if (cluster.length >= 1 && cluster[0].lineIndex < 800) {
            const nearTOC = explicitTOCLine >= 0 && cluster[0].lineIndex > explicitTOCLine && cluster[0].lineIndex < explicitTOCLine + 50
            const isAfterExplicitTOC = nearTOC && (legacyLayout ||
                (cluster.length >= 2 && cluster.slice(0, -1).every(c => c.bodyLineCount === 0) &&
                    lines.slice(explicitTOCLine + 1, cluster[0].lineIndex).every(line => !line.trim() || isDecorativeDividerOnly(line))))
            let repeatCount = 0
            for (const c of cluster) {
                const laterMatch = candidates.find(other => other.lineIndex > c.lineIndex && other.key === c.key && other.bodyCharCount >= 150 && other.bodyCharCount > c.bodyCharCount * 1.5)
                if (laterMatch) repeatCount++
            }
            if (isAfterExplicitTOC || (cluster.length >= 2 && repeatCount >= 1) || repeatCount >= 2) {
                for (const c of cluster) {
                    tocCandidateIndices.add(c.lineIndex)
                }
            }
        }
    }

    // Parse chapters with precise TOC preservation and heading deduplication
    const chapters = []
    let currentChapter = {
        title: '',
        isHeaderExplicit: false,
        lines: [],
        startLine: 0
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const isTOC = tocCandidateIndices.has(i)
        const heading = headings.get(i)

        if (heading && !isTOC) {
            const rawTitle = heading.title.trim().replace(/\s+/g, ' ')
            const hasStory = currentChapter.lines.some(l => {
                const t = (typeof l === 'string' ? l : l.text).trim()
                return t.length > 0 && !isDecorativeDividerOnly(t)
            })

            // If current chapter has no story text and was already an explicit header (e.g. "卷一" directly above "第一章"),
            // merge the titles to avoid creating an empty blank section.
            if (!hasStory && currentChapter.isHeaderExplicit) {
                currentChapter.title = currentChapter.title ? `${currentChapter.title} ${rawTitle}` : rawTitle
                continue
            }

            if (hasStory || currentChapter.isHeaderExplicit) {
                if (!currentChapter.title) {
                    const containsTOC = currentChapter.lines.some(l => typeof l === 'object' && l.isTOC)
                    currentChapter.title = containsTOC ? labels.contents : (title || labels.front)
                }
                chapters.push(currentChapter)
            }

            currentChapter = {
                title: rawTitle,
                isHeaderExplicit: true,
                lines: [],
                startLine: i,
                key: heading.key
            }
        } else {
            currentChapter.lines.push({
                text: line,
                lineIndex: i,
                isTOC: isTOC
            })
        }
    }

    if (currentChapter.lines.some(l => {
        const t = (typeof l === 'string' ? l : l.text).trim()
        return t.length > 0
    }) || currentChapter.isHeaderExplicit) {
        if (!currentChapter.title) {
            const containsTOC = currentChapter.lines.some(l => typeof l === 'object' && l.isTOC)
            currentChapter.title = chapters.length === 0 ? (containsTOC ? labels.contents : title) : labels.end
        }
        chapters.push(currentChapter)
    }

    // If no chapters detected at all
    if (legacyLayout ? chapters.length <= 1 : !chapters.some(chapter => chapter.isHeaderExplicit)) {
        chapters.length = 0
        if (lines.length > 2500) {
            // For huge files > 2500 lines with zero headings, split seamlessly without injecting ugly fake headers
            const chunkSize = 1000
            for (let i = 0; i < lines.length; i += chunkSize) {
                const chunkNum = Math.floor(i / chunkSize) + 1
                chapters.push({
                    title: chunkNum === 1 ? title : labels.continued(chunkNum),
                    isHeaderExplicit: false,
                    lines: lines.slice(i, i + chunkSize).map((l, offset) => ({ text: l, lineIndex: i + offset, isTOC: false })),
                    startLine: i
                })
            }
        } else {
            chapters.push({
                title: title,
                isHeaderExplicit: false,
                lines: lines.map((l, idx) => ({ text: l, lineIndex: idx, isTOC: false })),
                startLine: 0
            })
        }
    }

    // Build TOC link map for in-text TOC navigation
    const tocLinkMap = new Map()
    for (const lineIdx of tocCandidateIndices) {
        const rawLine = lines[lineIdx].trim()
        const key = headings.get(lineIdx).key
        const targetIdx = chapters.findIndex((ch, idx) => idx > 0 && (legacyLayout ? extractChapterKey(ch.title) : ch.key) === key)
        if (targetIdx > 0) {
            tocLinkMap.set(lineIdx, { targetIdx, href: `${targetIdx}#heading`, title: rawLine })
        }
    }

    // Wrap section in elegant HTML
    const template = (chapterTitle, isHeaderExplicit, contentHtml) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="${language}" xml:lang="${language}">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHTML(chapterTitle)}</title>
  <style type="text/css">
    body {
      font-family: inherit;
      line-height: inherit;
      color: inherit;
      background-color: transparent;
      margin: 0;
      padding: 0 1rem;
      word-wrap: break-word;
    }
    .chapter-heading {
      font-size: 1.5em;
      font-weight: 700;
      margin: 1.6em 0 1.2em 0;
      text-align: center;
      line-height: 1.35;
      letter-spacing: 0.05em;
    }
    .book-toc-block {
      margin: 1.5em auto;
      max-width: 90%;
      padding: 0.8em 1.2em;
      border-top: 1px dashed rgba(128, 128, 128, 0.25);
      border-bottom: 1px dashed rgba(128, 128, 128, 0.25);
    }
    .toc-marker {
      font-size: 1.25em;
      font-weight: 700;
      margin: 1.2em 0 0.6em 0;
      text-align: center;
      letter-spacing: 0.05em;
    }
    .toc-line {
      text-indent: 0 !important;
      margin: 0.45em 0;
      line-height: 1.6;
      font-size: 1.05em;
    }
    .toc-line a {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px dashed rgba(128, 128, 128, 0.35);
      transition: color 0.15s ease, border-color 0.15s ease;
    }
    .toc-line a:hover {
      color: #6366f1;
      border-bottom-color: #6366f1;
    }
    .prose-p {
      text-indent: ${!legacyLayout && language === 'en' ? '0' : '2em'};
      margin: 0.85em 0;
      text-align: justify;
      line-height: inherit;
    }
    .verse-stanza {
      margin: 1.4em 0;
      text-indent: 0 !important;
      text-align: left;
      line-height: 1.75;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="chapter-content">
    ${isHeaderExplicit ? `<h1 class="chapter-heading" id="heading">${escapeHTML(chapterTitle)}</h1>` : '<div id="heading"></div>'}
    ${contentHtml}
  </div>
</body>
</html>`

    const urls = []
    const sectionData = chapters.map((chapter, index) => {
        const htmlBody = renderContentToHTML(chapter.lines, { isPoetryMode: isBookPoetry, tocLinkMap, language, legacyLayout })
        const htmlStr = template(chapter.title, chapter.isHeaderExplicit, htmlBody)
        const blob = new Blob([htmlStr], { type: MIME.XHTML })
        const url = URL.createObjectURL(blob)
        urls.push(url)

        return {
            id: index,
            title: chapter.title,
            size: blob.size,
            load: () => url,
            createDocument: () => new DOMParser().parseFromString(htmlStr, MIME.XHTML)
        }
    })

    const coverSvg = generateCoverSVG(title, author)
    const coverBlob = new Blob([coverSvg], { type: MIME.SVG })

    const book = {
        metadata: {
            title,
            author,
            language,
            identifier: null
        },
        txtLayoutVersion: legacyLayout ? 1 : TXT_LAYOUT_VERSION,
        tocPreviewLines: lines.slice(0, 1000),
        sections: sectionData.map(s => ({
            id: s.id,
            load: s.load,
            createDocument: s.createDocument,
            size: s.size
        })),
        toc: sectionData.map((s, idx) => ({
            label: s.title,
            href: `${idx}#heading`
        })),
        resolveHref: href => {
            if (!href) return { index: 0 }
            const [sectionIdx, anchorId] = href.split('#')
            return {
                index: parseInt(sectionIdx, 10) || 0,
                anchor: doc => (anchorId ? doc.getElementById(anchorId) : null) || doc.body
            }
        },
        splitTOCHref: href => {
            if (!href) return []
            const parts = href.split('#')
            return [parseInt(parts[0], 10) || 0, parts[1] || '']
        },
        getTOCFragment: (doc, id) => id ? doc.getElementById(id) : null,
        isExternal: uri => /^\w+:/i.test(uri),
        getCover: () => coverBlob,
        destroy: () => {
            for (const u of urls) URL.revokeObjectURL(u)
        }
    }

    return book
}

export const makeBook = makeTXT

