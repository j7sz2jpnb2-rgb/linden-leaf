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
 * - <= 4 chars: single column
 * - 5 chars: single column (or split if punctuation)
 * - 6-12 chars: split into double columns (by punctuation or mid-point)
 * - Latin / English titles: automatic horizontal fallback
 */
function splitVerticalTitle(title) {
    const raw = (title || '未命名书籍').trim()
    const cjkCount = (raw.match(/[\u4e00-\u9fa5]/g) || []).length
    const latinCount = (raw.match(/[a-zA-Z]/g) || []).length
    const isMainlyLatin = latinCount > 0 && cjkCount === 0

    if (isMainlyLatin) {
        return { isLatin: true, columns: [raw] }
    }

    const cleanTitle = raw.replace(/^《+|》+$/g, '').trim()

    if (cleanTitle.length <= 4) {
        return { isLatin: false, columns: [cleanTitle] }
    }

    if (cleanTitle.length === 5) {
        if (/[:：\s\-—_]/.test(cleanTitle)) {
            const parts = cleanTitle.split(/[:：\s\-—_]+/).filter(Boolean)
            if (parts.length >= 2) return { isLatin: false, columns: parts.slice(0, 2) }
        }
        return { isLatin: false, columns: [cleanTitle] }
    }

    if (/[:：\s\-—_]/.test(cleanTitle)) {
        const parts = cleanTitle.split(/[:：\s\-—_]+/).filter(Boolean)
        if (parts.length >= 2) {
            let col1 = parts[0]
            let col2 = parts.slice(1).join(' ')
            if (col1.length > 7) col1 = col1.slice(0, 6) + '…'
            if (col2.length > 7) col2 = col2.slice(0, 6) + '…'
            return { isLatin: false, columns: [col1, col2] }
        }
    }

    const len = Math.min(cleanTitle.length, 12)
    const mid = Math.ceil(len / 2)
    const col1 = cleanTitle.slice(0, mid)
    let col2 = cleanTitle.slice(mid, 12)
    if (cleanTitle.length > 12) col2 += '…'

    return { isLatin: false, columns: [col1, col2] }
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
        this.pageIndex = ''
    }

    setData({ bookTitle, author, quoteText, chapterTitle, pageIndex, userName }) {
        this.bookTitle = bookTitle || '未命名书籍'
        this.author = author || '未知作者'
        this.quoteText = quoteText || ''
        this.chapterTitle = chapterTitle || ''
        this.pageIndex = pageIndex || ''
        const savedUserName = (typeof localStorage !== 'undefined' && localStorage.getItem('linden_user_name')) || 'Linden 读者'
        this.userName = userName || savedUserName
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

        // 1. Measure Header Height
        let headerHeight = 0
        const rawTitle = this.bookTitle || '未命名'
        const titleInfo = splitVerticalTitle(rawTitle)
        const isVerticalActive = this.titleLayout === 'vertical' && !titleInfo.isLatin
        const titleCharGap = 40
        const authorCharGap = 22

        if (isVerticalActive) {
            const maxColChars = Math.max(...titleInfo.columns.map(c => c.length))
            const titleH = maxColChars * titleCharGap
            const authorLen = Math.min((this.author || '').length, 10)
            const authorH = authorLen * authorCharGap
            headerHeight = Math.max(titleH, authorH, 110)
        } else {
            mctx.font = `bold 28px ${serifFont}`
            const titleLines = this.wrapText(mctx, this.bookTitle, contentWidth)
            headerHeight = titleLines.length * 36 + (this.author ? 36 : 14)
        }

        // 2. Measure Quote Body Text
        mctx.font = `26px ${serifFont}`
        const quoteLines = this.wrapText(mctx, this.quoteText, contentWidth)
        const quoteLineHeight = 48
        const quoteTextHeight = quoteLines.length * quoteLineHeight

        // 3. Measure SubMeta
        const subMeta = this.pageIndex ? `/ ${this.pageIndex}` : (this.chapterTitle ? `${this.chapterTitle}` : '')
        const subMetaHeight = subMeta ? 24 : 0

        // 4. Calculate Compact Total Height (WeChat Read Proportions)
        const topPadding = 56
        const headerToQuoteGap = 42
        const quoteToMetaGap = subMeta ? 28 : 0
        const metaToDividerGap = 28
        const dividerHeight = 1
        const dividerToFooterGap = 22
        const footerLine1Height = 18
        const footerLineGap = 16
        const footerLine2Height = 16
        const bottomPadding = 36

        const calculatedHeight = topPadding + headerHeight + headerToQuoteGap + quoteTextHeight
            + quoteToMetaGap + subMetaHeight + metaToDividerGap + dividerHeight
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

        // 1. Draw Background (Clean, full bleed, no ugly borders)
        ctx.fillStyle = theme.bg
        ctx.fillRect(0, 0, logicalWidth, totalHeight)

        // 2. Draw Header Section (Book Title & Author)
        let currentY = topPadding

        if (isVerticalActive) {
            // Vertical Layout (Double-column aware, classical right-to-left progression)
            ctx.font = `bold 32px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'

            const colWidth = 42
            const numCols = titleInfo.columns.length
            const titleBlockWidth = (numCols - 1) * colWidth
            const authorGap = this.author ? 26 : 0
            const rightmostColX = padding + 20 + titleBlockWidth + authorGap

            titleInfo.columns.forEach((colText, colIdx) => {
                const colX = rightmostColX - colIdx * colWidth
                const vChars = mapVerticalPunctuation(colText).split('')
                for (let i = 0; i < vChars.length; i++) {
                    ctx.fillText(vChars[i], colX, currentY + i * titleCharGap + 18)
                }
            })

            // Author Vertically adjacent on the left side of the title
            if (this.author) {
                ctx.font = `15px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                const authorX = rightmostColX - numCols * colWidth + 14
                const vAuthorChars = mapVerticalPunctuation((this.author || '').slice(0, 10)).split('')
                for (let i = 0; i < vAuthorChars.length; i++) {
                    ctx.fillText(vAuthorChars[i], authorX, currentY + i * authorCharGap + 12)
                }
            }

            currentY += headerHeight + headerToQuoteGap
        } else {
            // Horizontal Layout with auto-wrapping for long titles / Latin books
            ctx.font = `bold 28px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            const titleLines = this.wrapText(ctx, this.bookTitle, contentWidth)
            titleLines.forEach((tLine, tIdx) => {
                ctx.fillText(tLine, padding, currentY + 28 + tIdx * 36)
            })

            if (this.author) {
                ctx.font = `16px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                ctx.fillText(this.author, padding, currentY + 26 + titleLines.length * 36)
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

        // 4. Draw Index / Chapter tag (e.g. "/ 2" or Chapter title)
        if (subMeta) {
            ctx.font = `16px ${serifFont}`
            ctx.fillStyle = theme.metaColor
            ctx.textAlign = 'left'
            ctx.fillText(subMeta, padding, currentY + 16)
            currentY += subMetaHeight
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
        const currentUserName = this.userName || (typeof localStorage !== 'undefined' && localStorage.getItem('linden_user_name')) || 'Linden 读者'
        ctx.fillText(`${currentUserName} · 摘录于 ${dateStr}`, padding, currentY + 14)

        // Line 2: Brand (with plenty of breathing room)
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
if (typeof window !== 'undefined') window.quoteCard = quoteCard
