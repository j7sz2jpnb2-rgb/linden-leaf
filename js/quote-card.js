/**
 * quote-card.js - WeChat Read Style Quote Share Card Generator
 * Supports High-DPI Canvas Rendering, Vertical/Horizontal Typography, Multi-Theme Palettes & Direct Clipboard Copying
 */

export const THEMES = [
    {
        id: 'dark',
        name: '深邃黑',
        bg: '#191b22',
        titleColor: '#e0d5c1',
        textColor: '#e8dfcc',
        authorColor: '#a69986',
        metaColor: '#7a7164',
        dividerColor: 'rgba(224, 213, 193, 0.12)',
        previewBorder: '#2d3139'
    },
    {
        id: 'beige',
        name: '复古米黄',
        bg: '#f6eee3',
        titleColor: '#2b231d',
        textColor: '#2b231d',
        authorColor: '#7a6c5e',
        metaColor: '#9c8e80',
        dividerColor: 'rgba(43, 35, 29, 0.08)',
        previewBorder: '#dcd3c5'
    },
    {
        id: 'white',
        name: '淡雅白',
        bg: '#ffffff',
        titleColor: '#18181b',
        textColor: '#18181b',
        authorColor: '#52525b',
        metaColor: '#a1a1aa',
        dividerColor: 'rgba(0, 0, 0, 0.06)',
        previewBorder: '#e4e4e7'
    },
    {
        id: 'celadon',
        name: '青瓷绿',
        bg: '#edf3ed',
        titleColor: '#163f2d',
        textColor: '#163f2d',
        authorColor: '#3d6653',
        metaColor: '#6a8e7e',
        dividerColor: 'rgba(22, 63, 45, 0.1)',
        previewBorder: '#c2d6c7'
    },
    {
        id: 'navy',
        name: '夜空蓝',
        bg: '#0f172a',
        titleColor: '#f1f5f9',
        textColor: '#f8fafc',
        authorColor: '#94a3b8',
        metaColor: '#64748b',
        dividerColor: 'rgba(241, 245, 249, 0.1)',
        previewBorder: '#1e293b'
    }
]


// Classical Chinese Vertical Punctuation & Quotes Mapper
const VERTICAL_PUNCT_MAP = {
    '，': '︐', '。': '︒', '、': '︑', '；': '︔', '：': '︓',
    '！': '︕', '？': '︖', '“': '『', '”': '』', '‘': '「',
    '’': '」', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀',
    '（': '︵', '）': '︶', '【': '︻', '】': '︼', '〔': '︹',
    '〕': '︺', '……': '︙︙', '…': '︙', '——': '︱︱'
}

function mapVerticalPunctuation(text) {
    if (!text) return ''
    const preprocessed = text
        .replace(/——/g, '︱︱')
        .replace(/……/g, '︙︙')
        .replace(/—/g, '︱')
        .replace(/…/g, '︙')
    return preprocessed.replace(/[，。、；：！？“”‘’《》〈〉（）【】〔〕]/g, char => VERTICAL_PUNCT_MAP[char] || char)
}

/**
 * Intelligent Vertical Title Column Splitter (WeChat Read Proportions)
 * - Preserves brackets and punctuation pairs (no orphan brackets)
 * - Natural semantic splits (colon, dash, bracket boundaries)
 * - Balanced column lengths with orphan punctuation protection
 * - Latin / English titles: automatic horizontal fallback
 */
export function splitVerticalTitle(title) {
    const raw = (title || '未命名书籍').trim()
    const chars = Array.from(raw)
    const cjkCount = (raw.match(/[\u4e00-\u9fa5]/g) || []).length
    const latinCount = (raw.match(/[a-zA-Z]/g) || []).length
    const isMainlyLatin = latinCount > 0 && cjkCount === 0

    if (isMainlyLatin) {
        return { isLatin: true, columns: [raw] }
    }

    // Up to 6 characters can comfortably remain a single stately column (e.g. 《百年孤独》, 活着, 围城)
    if (chars.length <= 6 && !/[:：\s\-—_]/.test(raw)) {
        return { isLatin: false, columns: [raw] }
    }

    // 1. Check natural semantic delimiter: colon, space, dash
    const delimMatch = raw.match(/[:：\s\-—_]+/)
    if (delimMatch && delimMatch.index > 0 && delimMatch.index < raw.length - 1) {
        const p1 = raw.slice(0, delimMatch.index).trim()
        const p2 = raw.slice(delimMatch.index + delimMatch[0].length).trim()
        if (p1 && p2) {
            let col1 = p1
            let col2 = p2
            if (Array.from(col1).length > 9) col1 = Array.from(col1).slice(0, 8).join('') + '…'
            if (Array.from(col2).length > 9) col2 = Array.from(col2).slice(0, 8).join('') + '…'
            return { isLatin: false, columns: [col1, col2] }
        }
    }

    // 2. Check closing bracket boundary (e.g. 《堂吉诃德》讲稿 -> 《堂吉诃德》 + 讲稿)
    const bracketCloseMatch = raw.match(/[》）】」』〉〕]/)
    if (bracketCloseMatch && bracketCloseMatch.index >= 2 && bracketCloseMatch.index < raw.length - 1) {
        const splitIdx = bracketCloseMatch.index + 1
        const p1 = raw.slice(0, splitIdx).trim()
        const p2 = raw.slice(splitIdx).trim()
        if (p1 && p2 && Array.from(p1).length <= 9 && Array.from(p2).length <= 9) {
            return { isLatin: false, columns: [p1, p2] }
        }
    }

    // 3. Fallback midpoint split with orphan punctuation protection
    const maxChars = 18
    const truncated = chars.length > maxChars ? chars.slice(0, maxChars - 1).concat(['…']) : chars
    let mid = Math.ceil(truncated.length / 2)

    // Ensure Column 2 does not start with closing punctuation
    const NO_START_PUNCT = '，。、；：？！…—）》〉】｝〕’”·,.!?:;)]}︾︶︒︑︔︓︕︖』」﹀︼︺'
    const NO_END_PUNCT = '（《〈【〔“‘([{︽︵︻︹『「'
    if (mid < truncated.length && NO_START_PUNCT.includes(truncated[mid])) {
        mid = Math.min(truncated.length, mid + 1)
    } else if (mid > 0 && NO_END_PUNCT.includes(truncated[mid - 1])) {
        mid = Math.max(1, mid - 1)
    }

    const col1 = truncated.slice(0, mid).join('')
    const col2 = truncated.slice(mid).join('')

    return { isLatin: false, columns: col2 ? [col1, col2] : [col1] }
}

export class QuoteCardGenerator {
    constructor() {
        this.currentThemeId = 'dark'
        this.titleLayout = 'vertical' // 'vertical' | 'horizontal'
        this.userName = (typeof localStorage !== 'undefined' && localStorage.getItem('linden_user_name')) || 'Linden 读者'
        this.bookTitle = ''
        this.author = ''
        this.quoteText = ''
        this.chapterTitle = ''
        this.locationInfo = ''
        this.pageIndex = ''
    }

    setData({ bookTitle, author, quoteText, chapterTitle, locationInfo, pageIndex, userName }) {
        this.bookTitle = bookTitle || '未命名书籍'
        this.author = author || '未知作者'
        this.quoteText = quoteText || ''
        this.chapterTitle = chapterTitle || ''
        this.locationInfo = locationInfo || (pageIndex ? (String(pageIndex).startsWith('第') ? pageIndex : `第 ${pageIndex} 页`) : '')
        this.pageIndex = this.locationInfo
        const savedUserName = (typeof localStorage !== 'undefined' && localStorage.getItem('linden_user_name')) || 'Linden 读者'
        this.userName = userName || savedUserName
    }

    formatSourceMeta() {
        const parts = []
        const cleanChapter = (this.chapterTitle || '').trim()
        const cleanLocation = (this.locationInfo || '').trim()
        if (cleanChapter) parts.push(cleanChapter)
        if (cleanLocation) parts.push(cleanLocation)
        return parts.join(' · ')
    }

    setTheme(themeId) {
        if (THEMES.some(t => t.id === themeId)) {
            this.currentThemeId = themeId
        }
    }

    setTitleLayout(layout) {
        if (['vertical', 'horizontal'].includes(layout)) {
            this.titleLayout = layout
        }
    }

    getTheme() {
        return THEMES.find(t => t.id === this.currentThemeId) || THEMES[0]
    }

    /**
     * Measure and wrap text for canvas with paragraph and word boundary support
     */
    wrapText(ctx, text, maxWidth) {
        const lines = []
        const paragraphs = text.split('\n')

        for (const para of paragraphs) {
            if (!para.trim()) {
                lines.push('')
                continue
            }

            // Segment by word boundaries for Latin words and characters for CJK
            const tokens = []
            if (typeof Intl !== 'undefined' && Intl.Segmenter) {
                const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
                for (const seg of segmenter.segment(para)) {
                    tokens.push(seg.segment)
                }
            } else {
                const re = /[\u4e00-\u9fff]|[a-zA-Z0-9]+(?:'[a-zA-Z0-9]+)?|\s+|[^\s\w\u4e00-\u9fff]/g
                let match
                while ((match = re.exec(para)) !== null) {
                    tokens.push(match[0])
                }
            }

            const NO_START_PUNCT = '，。、；：？！…—）》〉】｝〕’”·,.!?:;)]}'
            let currentLine = ''
            for (const token of tokens) {
                const testLine = currentLine ? currentLine + token : token
                const metrics = ctx.measureText(testLine)
                if (metrics.width > maxWidth && currentLine.length > 0) {
                    const firstChar = token.trimStart()[0]
                    if (firstChar && NO_START_PUNCT.includes(firstChar)) {
                        const trimmed = currentLine.trimEnd()
                        const latinMatch = trimmed.match(/[a-zA-Z0-9]+$/)
                        if (latinMatch) {
                            const word = latinMatch[0]
                            const remainder = trimmed.slice(0, -word.length).trimEnd()
                            if (remainder.length > 0) {
                                lines.push(remainder)
                                currentLine = word + token
                                continue
                            }
                        } else if (trimmed.length > 1) {
                            const lastChar = trimmed.slice(-1)
                            const remainder = trimmed.slice(0, -1)
                            lines.push(remainder)
                            currentLine = lastChar + token
                            continue
                        }
                    }

                    lines.push(currentLine)
                    if (ctx.measureText(token).width > maxWidth) {
                        let chunk = ''
                        for (const ch of token) {
                            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
                                lines.push(chunk)
                                chunk = ch
                            } else {
                                chunk += ch
                            }
                        }
                        currentLine = chunk
                    } else {
                        currentLine = token.trimStart()
                    }
                } else {
                    currentLine = testLine
                }
            }
            if (currentLine) lines.push(currentLine)
        }
        return lines
    }

    /**
     * Render the ultra-high-resolution canvas (WeChat Read style, compact, crisp & retina sharp)
     */
    async renderCanvas() {
        if (typeof document !== 'undefined' && document.fonts?.ready) {
            try {
                await Promise.race([
                    document.fonts.ready,
                    new Promise(r => setTimeout(r, 600))
                ])
            } catch (e) {
                console.warn('fonts.ready error:', e)
            }
        }

        const theme = this.getTheme()
        const logicalWidth = 640
        const padding = 54
        const contentWidth = logicalWidth - padding * 2
        const scale = 3.0 // Ultra-HD 3.0x HiDPI integer pixel alignment scale (1920px Full HD width output)

        // Create measurement context
        const measureCanvas = document.createElement('canvas')
        const mctx = measureCanvas.getContext('2d')

        // Font settings - Classical literary serif
        const serifFont = "'Noto Serif SC', 'Source Han Serif SC', '思源宋体', 'Songti SC', 'STSong', 'SimSun', serif"

        // 1. Measure Header Height & Analyze Layout
        let headerHeight = 0
        const rawTitle = (this.bookTitle || '未命名书籍').trim()
        const titleInfo = splitVerticalTitle(rawTitle)
        const isVerticalActive = this.titleLayout === 'vertical' && !titleInfo.isLatin
        const titleCharGap = 40
        const authorCharGap = 22

        const authorStr = (this.author || '').trim()
        const authorChars = Array.from(authorStr)
        const isAuthorLatin = /[a-zA-Z]/.test(authorStr)
        const hasAuthorSlash = /[\/／]/.test(authorStr)
        // Short CJK author can be vertical: <= 8 characters, pure CJK (can have brackets like [法] 司汤达)
        const canAuthorBeVertical = isVerticalActive && authorStr.length > 0 && authorChars.length <= 8 && !isAuthorLatin && !hasAuthorSlash

        let authorLines = []
        if (authorStr && (!isVerticalActive || !canAuthorBeVertical)) {
            mctx.font = `15px ${serifFont}`
            authorLines = this.wrapText(mctx, authorStr, contentWidth)
        }

        if (isVerticalActive) {
            const maxColChars = Math.max(...titleInfo.columns.map(c => Array.from(c).length), 1)
            const titleH = maxColChars * titleCharGap
            if (canAuthorBeVertical) {
                const authorH = authorChars.length * authorCharGap
                headerHeight = Math.max(titleH, authorH, 110)
            } else {
                const authorH = authorLines.length > 0 ? (authorLines.length * 22 + 16) : 0
                headerHeight = titleH + authorH
            }
        } else {
            mctx.font = `bold 28px ${serifFont}`
            const titleLines = this.wrapText(mctx, rawTitle, contentWidth)
            const authorBlockHeight = authorLines.length > 0 ? (authorLines.length * 24 + 12) : 0
            headerHeight = titleLines.length * 36 + authorBlockHeight
        }

        // 2. Measure Quote Body Text
        mctx.font = `26px ${serifFont}`
        const quoteLines = this.wrapText(mctx, this.quoteText, contentWidth)
        const quoteLineHeight = 48
        const quoteTextHeight = quoteLines.length * quoteLineHeight

        // 3. Measure Source Meta (Chapter / Location)
        const sourceMeta = this.formatSourceMeta()
        let sourceMetaLines = []
        let sourceMetaHeight = 0
        if (sourceMeta) {
            mctx.font = `15px ${serifFont}`
            sourceMetaLines = this.wrapText(mctx, sourceMeta, contentWidth)
            sourceMetaHeight = sourceMetaLines.length * 24
        }

        // 4. Calculate Compact Total Height (WeChat Read Proportions)
        const topPadding = 56
        const headerToQuoteGap = 42
        const quoteToMetaGap = sourceMetaHeight > 0 ? 26 : 0
        const metaToDividerGap = 28
        const dividerHeight = 1
        const dividerToFooterGap = 22
        const footerLine1Height = 18
        const footerLineGap = 16
        const footerLine2Height = 16
        const bottomPadding = 36

        const calculatedHeight = topPadding + headerHeight + headerToQuoteGap + quoteTextHeight
            + quoteToMetaGap + sourceMetaHeight + metaToDividerGap + dividerHeight
            + dividerToFooterGap + footerLine1Height + footerLineGap + footerLine2Height + bottomPadding

        const totalHeight = Math.min(Math.max(Math.round(calculatedHeight), 320), 3200)

        // Create Target Canvas with HiDPI Scale
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(logicalWidth * scale)
        canvas.height = Math.round(totalHeight * scale)
        canvas.style.width = `${logicalWidth}px`
        canvas.style.height = `${totalHeight}px`

        const ctx = canvas.getContext('2d')
        ctx.scale(scale, scale)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'

        // 1. Draw Background
        ctx.fillStyle = theme.bg
        ctx.fillRect(0, 0, logicalWidth, totalHeight)

        // 2. Draw Header Section (Book Title & Author)
        let currentY = topPadding

        if (isVerticalActive) {
            // Classical Vertical Layout (Double-column aware, classical right-to-left progression)
            ctx.font = `bold 32px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'

            const colPitch = 44
            const numCols = titleInfo.columns.length
            const titleBlockWidth = (numCols - 1) * colPitch
            const authorExtraSpace = canAuthorBeVertical ? 50 : 0
            const rightmostColX = padding + 24 + titleBlockWidth + authorExtraSpace

            titleInfo.columns.forEach((colText, colIdx) => {
                const colX = rightmostColX - colIdx * colPitch
                const vChars = Array.from(mapVerticalPunctuation(colText))
                for (let i = 0; i < vChars.length; i++) {
                    ctx.fillText(vChars[i], colX, currentY + i * titleCharGap + 20)
                }
            })

            // If author is short CJK, draw it vertically to the left of the title block with generous net spacing
            if (canAuthorBeVertical) {
                ctx.font = `15px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                const leftmostTitleColX = rightmostColX - (numCols - 1) * colPitch
                const authorX = leftmostTitleColX - 44
                const vAuthorChars = Array.from(mapVerticalPunctuation(authorStr))
                for (let i = 0; i < vAuthorChars.length; i++) {
                    ctx.fillText(vAuthorChars[i], authorX, currentY + i * authorCharGap + 14)
                }
            } else if (authorLines.length > 0) {
                // If author is long / foreign / multi-author, draw it horizontally below the vertical title block
                ctx.font = `15px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                ctx.textAlign = 'left'
                ctx.textBaseline = 'alphabetic'
                const maxColChars = Math.max(...titleInfo.columns.map(c => Array.from(c).length), 1)
                const authorStartY = currentY + maxColChars * titleCharGap + 20
                for (let i = 0; i < authorLines.length; i++) {
                    ctx.fillText(authorLines[i], padding, authorStartY + i * 22)
                }
            }

            currentY += headerHeight + headerToQuoteGap
        } else {
            // Horizontal Layout with auto-wrapping for long titles and authors
            ctx.font = `bold 28px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            const titleLines = this.wrapText(ctx, rawTitle, contentWidth)
            titleLines.forEach((tLine, tIdx) => {
                ctx.fillText(tLine, padding, currentY + 28 + tIdx * 36)
            })

            if (authorLines.length > 0) {
                ctx.font = `15px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                const authorStartY = currentY + 28 + titleLines.length * 36 + 6
                authorLines.forEach((aLine, aIdx) => {
                    ctx.fillText(aLine, padding, authorStartY + aIdx * 24)
                })
            }

            currentY += headerHeight + headerToQuoteGap
        }

        // 3. Draw Quote Body
        ctx.font = `26px ${serifFont}`
        ctx.fillStyle = theme.textColor
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'

        for (let i = 0; i < quoteLines.length; i++) {
            ctx.fillText(quoteLines[i], padding, currentY + i * quoteLineHeight + 20)
        }

        currentY += quoteTextHeight + quoteToMetaGap

        // 4. Draw Source Meta (Chapter / Location)
        if (sourceMetaLines.length > 0) {
            ctx.font = `15px ${serifFont}`
            ctx.fillStyle = theme.metaColor
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            for (let i = 0; i < sourceMetaLines.length; i++) {
                ctx.fillText(sourceMetaLines[i], padding, currentY + 16 + i * 22)
            }
            currentY += sourceMetaHeight
        }

        currentY += metaToDividerGap

        // 5. Draw Subtle Divider Line
        ctx.strokeStyle = theme.dividerColor
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padding, currentY)
        ctx.lineTo(logicalWidth - padding, currentY)
        ctx.stroke()

        currentY += dividerToFooterGap

        // 6. Draw Footer Section (WeChat Read compact style)
        const today = new Date()
        const dateStr = `${today.getFullYear()}/${today.getMonth() + 1}/${today.getDate()}`
        
        // Line 1: User Excerpt Info
        ctx.font = `14px ${serifFont}`
        ctx.fillStyle = theme.metaColor
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        const currentUserName = this.userName || 'Linden 读者'
        ctx.fillText(`${currentUserName} · 摘录于 ${dateStr}`, padding, currentY + 14)

        // Line 2: Brand
        ctx.font = `13px ${serifFont}`
        ctx.fillStyle = theme.metaColor
        ctx.fillText('Linden Leaf 阅读器', padding, currentY + 14 + footerLine1Height + footerLineGap)

        return canvas
    }

    async getBlob() {
        const canvas = await this.renderCanvas()
        if (!canvas) return null
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob)
                else reject(new Error('Canvas 转换为图片 Blob 失败'))
            }, 'image/png')
        })
    }

    /**
     * Export canvas as Data URL
     */
    async getDataURL() {
        const canvas = await this.renderCanvas()
        return canvas.toDataURL('image/png')
    }

    /**
     * Directly copy generated image blob to system clipboard
     */
    async copyImageToClipboard() {
        try {
            const blob = await this.getBlob()
            if (!navigator.clipboard || !window.ClipboardItem) {
                throw new Error('当前浏览器环境暂未开放直接写入剪贴板图片权限')
            }
            const item = new ClipboardItem({ 'image/png': blob })
            await navigator.clipboard.write([item])
            return { success: true }
        } catch (err) {
            console.error('Clipboard copy failed:', err)
            return { success: false, error: err.message }
        }
    }

    /**
     * Trigger file download
     */
    async downloadImage(filename) {
        const blob = await this.getBlob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const cleanTitle = (this.bookTitle || 'LindenLeaf').replace(/[\\/:*?"<>|\uFF1A\uFF1F]/g, '_').trim()
        a.download = filename || `书摘_${cleanTitle}_${Date.now()}.png`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 2000)
    }
}

export const quoteCard = new QuoteCardGenerator()
quoteCard.splitVerticalTitle = splitVerticalTitle
if (typeof window !== 'undefined') window.quoteCard = quoteCard
