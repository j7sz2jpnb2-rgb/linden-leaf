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
    return text.replace(/[，。、；：！？“”‘’《》〈〉（）【】〔〕…—]/g, char => VERTICAL_PUNCT_MAP[char] || char)
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
     * Measure and wrap text for canvas with paragraph support
     */
    wrapText(ctx, text, maxWidth) {
        const lines = []
        const paragraphs = text.split('\n')

        for (const para of paragraphs) {
            if (!para.trim()) {
                lines.push('')
                continue
            }
            let currentLine = ''
            for (let i = 0; i < para.length; i++) {
                const char = para[i]
                const testLine = currentLine + char
                const metrics = ctx.measureText(testLine)
                if (metrics.width > maxWidth && currentLine.length > 0) {
                    lines.push(currentLine)
                    currentLine = char
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
        const scale = 2.5 // WeChat Read Ultra-HD 2.5x HiDPI scale (1600px width output)

        // Create measurement context
        const measureCanvas = document.createElement('canvas')
        const mctx = measureCanvas.getContext('2d')

        // Font settings - Classical literary serif
        const serifFont = "'Noto Serif SC', 'Source Han Serif SC', '思源宋体', 'Songti SC', 'STSong', 'SimSun', serif"

        // 1. Measure Header Height
        let headerHeight = 0
        const rawTitle = this.bookTitle || '未命名'
        const titleChars = (rawTitle.length > 12 ? rawTitle.slice(0, 11) + '…' : rawTitle).split('')
        const authorChars = ((this.author || '').length > 12 ? (this.author || '').slice(0, 11) + '…' : (this.author || '')).split('')
        const titleCharGap = 44
        const authorCharGap = 24

        if (this.titleLayout === 'vertical') {
            const displayTitle = rawTitle.length > 16 ? rawTitle.slice(0, 15) + '…' : rawTitle
            const displayAuthor = (this.author || '').length > 14 ? (this.author || '').slice(0, 13) + '…' : (this.author || '')
            const mappedTitle = mapVerticalPunctuation(displayTitle)
            const mappedAuthor = mapVerticalPunctuation(displayAuthor)
            const titleH = mappedTitle.length * titleCharGap
            const authorH = mappedAuthor.length * authorCharGap
            headerHeight = Math.max(titleH, authorH, 130)
        } else {
            mctx.font = `bold 30px ${serifFont}`
            const titleLines = this.wrapText(mctx, this.bookTitle, contentWidth)
            headerHeight = titleLines.length * 38 + (this.author ? 40 : 16)
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

        if (this.titleLayout === 'vertical') {
            // Vertical Layout (WeChat Read Classic)
            ctx.font = `bold 36px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'

            const titleX = padding + 22
            const vTitleChars = mapVerticalPunctuation(rawTitle.length > 16 ? rawTitle.slice(0, 15) + '…' : rawTitle).split('')
            for (let i = 0; i < vTitleChars.length; i++) {
                ctx.fillText(vTitleChars[i], titleX, currentY + i * titleCharGap + 18)
            }

            // Author Vertically adjacent
            if (this.author) {
                ctx.font = `16px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                const authorX = titleX + 42
                const vAuthorChars = mapVerticalPunctuation((this.author || '').length > 14 ? (this.author || '').slice(0, 13) + '…' : (this.author || '')).split('')
                for (let i = 0; i < vAuthorChars.length; i++) {
                    ctx.fillText(vAuthorChars[i], authorX, currentY + i * authorCharGap + 12)
                }
            }

            currentY += headerHeight + headerToQuoteGap
        } else {
            // Horizontal Layout with auto-wrapping for long titles
            ctx.font = `bold 30px ${serifFont}`
            ctx.fillStyle = theme.titleColor
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            const titleLines = this.wrapText(ctx, this.bookTitle, contentWidth)
            titleLines.forEach((tLine, tIdx) => {
                ctx.fillText(tLine, padding, currentY + 28 + tIdx * 38)
            })

            if (this.author) {
                ctx.font = `17px ${serifFont}`
                ctx.fillStyle = theme.authorColor
                ctx.fillText(this.author, padding, currentY + 28 + titleLines.length * 38)
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
        a.download = filename || `书摘_${this.bookTitle || 'LindenLeaf'}_${Date.now()}.png`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 2000)
    }
}

export const quoteCard = new QuoteCardGenerator()
if (typeof window !== 'undefined') window.quoteCard = quoteCard
