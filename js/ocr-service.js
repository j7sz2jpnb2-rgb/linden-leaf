// js/ocr-service.js - Managed, Cancellable OCR & Page Range Text Extraction
// Features: embedded vs forced image OCR, page range validation, memory-capped rendering,
// progress stages, worker lifecycle management, and clear error classification.

/**
 * Validates and parses user-entered page range
 * @param {string} rangeStr e.g. "current", "12", "15-18"
 * @param {number} totalPages Total pages in PDF
 * @param {number} currentPage 1-based current page
 * @param {number} [maxPages=5] Maximum permitted pages per extraction
 * @returns {{ valid: boolean, pages: number[], error?: string }}
 */
export function parsePageRange(rangeStr, totalPages, currentPage, maxPages = 5) {
    const raw = (rangeStr || '').trim().toLowerCase()
    if (!raw || raw === 'current' || raw === '当前页') {
        const cur = Math.max(1, Math.min(currentPage || 1, totalPages))
        return { valid: true, pages: [cur] }
    }

    // Check comma or whitespace separated list (e.g. "1, 3, 5" or "12")
    if (/^[\d\s,，、]+$/.test(raw)) {
        const parts = raw.split(/[,，、\s]+/).filter(Boolean).map(n => parseInt(n, 10))
        if (parts.length > 0) {
            const outOfBounds = parts.some(p => p < 1 || p > totalPages)
            if (outOfBounds) {
                return { valid: false, pages: [], error: `页码超出范围，请输入 1 ~ ${totalPages} 之间的页码` }
            }
            const uniquePages = Array.from(new Set(parts)).sort((a, b) => a - b)
            if (uniquePages.length > maxPages) {
                return { valid: false, pages: [], error: `单次识别最多支持 ${maxPages} 页，请缩小识别范围` }
            }
            return { valid: true, pages: uniquePages }
        }
    }

    // Check range "start-end"
    const match = raw.match(/^(\d+)\s*[-~至到]\s*(\d+)$/)
    if (match) {
        const start = parseInt(match[1], 10)
        const end = parseInt(match[2], 10)
        if (start < 1 || end > totalPages) {
            return { valid: false, pages: [], error: `页码范围超出书籍范围 (1 ~ ${totalPages})` }
        }
        if (start > end) {
            return { valid: false, pages: [], error: '起始页码不能大于结束页码' }
        }
        const count = end - start + 1
        if (count > maxPages) {
            return { valid: false, pages: [], error: `单次识别最多支持 ${maxPages} 页，请缩小识别范围` }
        }
        const pages = []
        for (let i = start; i <= end; i++) {
            pages.push(i)
        }
        return { valid: true, pages }
    }

    return { valid: false, pages: [], error: '页码格式不正确，支持输入如 "12" 或 "12-15"' }
}

/**
 * Formats text spans into natural reading order without destroying CJK typography
 * @param {Array<{ text: string, rect?: number[] }>} spans
 * @returns {string}
 */
export function formatSpansToText(spans) {
    if (!spans || !spans.length) return ''
    
    // Sort spans by vertical position (y), then horizontal (x) if rect exists
    const hasRect = spans.some(s => Array.isArray(s.rect) && s.rect.length >= 4)
    let sorted = spans
    if (hasRect) {
        sorted = [...spans].sort((a, b) => {
            const ay = a.rect ? a.rect[1] : 0
            const by = b.rect ? b.rect[1] : 0
            const dy = ay - by
            if (Math.abs(dy) > 4) return dy
            const ax = a.rect ? a.rect[0] : 0
            const bx = b.rect ? b.rect[0] : 0
            return ax - bx
        })
    }

    let result = ''
    let prevY = null
    let prevText = ''

    for (const span of sorted) {
        const text = span.text || ''
        if (!text) continue

        const curY = span.rect ? span.rect[1] : null
        const isNewLine = hasRect && curY !== null && prevY !== null && Math.abs(curY - prevY) > 8

        if (isNewLine) {
            result += '\n'
            prevText = ''
        } else if (result.length > 0 && !result.endsWith('\n')) {
            const lastChar = prevText ? prevText.slice(-1) : result.slice(-1)
            const firstChar = text.charAt(0)
            const needSpace = /[a-zA-Z0-9]/.test(lastChar) && /[a-zA-Z0-9]/.test(firstChar)
            if (needSpace) {
                result += ' '
            }
        }

        result += text
        prevText = text
        if (curY !== null) prevY = curY
    }

    return result.trim()
}

/**
 * Remove artificial spaces between CJK characters introduced by OCR
 * @param {string} text
 * @returns {string}
 */
export function cleanOcrChineseSpaces(text) {
    if (!text) return ''
    return text.replace(/([\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e])\s+([\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e])/g, '$1$2')
               .replace(/([\u4e00-\u9fa5])\s+([，。！？；：、“”‘’（）《》【】])/g, '$1$2')
               .replace(/([，。！？；：、“”‘’（）《》【】])\s+([\u4e00-\u9fa5])/g, '$1$2')
}

export class OcrService {
    constructor() {
        this._worker = null
        this._workerInitializing = false
        this._workerInitToken = 0
        this._workerInitPromise = null
        this._currentJobId = 0
        this._activeAbortController = null
    }

    /**
     * Terminate active worker and cancel any running job
     */
    async abort() {
        this._currentJobId++
        this._workerInitToken++
        this._workerInitPromise = null
        if (this._activeAbortController) {
            this._activeAbortController.abort()
            this._activeAbortController = null
        }
        if (this._worker) {
            const w = this._worker
            this._worker = null
            this._workerInitializing = false
            try {
                await w.terminate()
            } catch (e) {}
        }
    }

    /**
     * Lazily get or create Tesseract worker with tokenized abort protection
     */
    async _getWorker(onStageChange, jobId) {
        if (this._worker) return this._worker
        if (this._workerInitPromise) return this._workerInitPromise
        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract OCR 引擎未加载，请检查本地脚本或网络连接')
        }

        onStageChange?.('正在初始化 OCR 引擎与语言模型...')
        this._workerInitializing = true
        const initToken = ++this._workerInitToken

        this._workerInitPromise = (async () => {
            let worker = null
            try {
                worker = await Tesseract.createWorker({
                    workerPath: './vendor/tesseract/worker.min.js',
                    corePath: 'https://npmmirror.com/mirrors/tesseract.js-core/v4.0.4/tesseract-core.wasm.js',
                    langPath: 'https://npmmirror.com/mirrors/tessdata/4.0.0',
                    logger: (m) => {
                        if (m.status === 'recognizing text') {
                            const pct = Math.round((m.progress || 0) * 100)
                            onStageChange?.(`文字识别计算中 (${pct}%)...`)
                        } else if (m.status === 'loading tesseract core') {
                            onStageChange?.('正在加载 OCR 计算核心...')
                        } else if (m.status === 'loading language traineddata') {
                            onStageChange?.('正在加载中英文字库模型...')
                        }
                    }
                })

                if (initToken !== this._workerInitToken || (jobId !== undefined && jobId !== this._currentJobId)) {
                    await worker.terminate().catch(() => {})
                    throw new Error('任务已取消')
                }

                await worker.loadLanguage('chi_sim+eng')

                if (initToken !== this._workerInitToken || (jobId !== undefined && jobId !== this._currentJobId)) {
                    await worker.terminate().catch(() => {})
                    throw new Error('任务已取消')
                }

                await worker.initialize('chi_sim+eng')
                await worker.setParameters({
                    tessedit_pageseg_mode: Tesseract.PSM.AUTO
                })

                if (initToken !== this._workerInitToken || (jobId !== undefined && jobId !== this._currentJobId)) {
                    await worker.terminate().catch(() => {})
                    throw new Error('任务已取消')
                }

                this._worker = worker
                return worker
            } catch (err) {
                if (worker && this._worker !== worker) {
                    await worker.terminate().catch(() => {})
                }
                if (err.message === '任务已取消') throw err
                throw new Error(`OCR 引擎初始化失败: ${err.message || '语言包加载或环境受限'}`)
            } finally {
                this._workerInitializing = false
                this._workerInitPromise = null
            }
        })()

        return this._workerInitPromise
    }

    /**
     * Execute text extraction across specified pages
     * @param {object} params
     * @param {object} params.driver PDF driver
     * @param {number[]} params.pages 1-based page numbers
     * @param {'auto' | 'force_image'} [params.mode='auto']
     * @param {function(string, number): void} [params.onProgress] (statusText, overallPercent)
     * @returns {Promise<{ success: boolean, results: Array<{ page: number, text: string, isImageOcr: boolean }>, fullText: string, error?: string }>}
     */
    async extractText({ driver, pages, mode = 'auto', onProgress }) {
        if (!driver) throw new Error('PDF 驱动不可用')
        if (!pages || !pages.length) throw new Error('请选择需要提取文字的页码')

        await this.abort()
        const jobId = ++this._currentJobId
        this._activeAbortController = new AbortController()
        const signal = this._activeAbortController.signal

        const results = []
        const total = pages.length

        try {
            for (let i = 0; i < total; i++) {
                if (signal.aborted || jobId !== this._currentJobId) {
                    return { success: false, results: [], fullText: '', error: '任务已取消' }
                }

                const pageNum = pages[i]
                const pageIndex = pageNum - 1
                const baseProgress = Math.round((i / total) * 100)

                let pageText = ''
                let isImageOcr = false

                try {
                    // 1. In 'auto' mode, check for embedded text layer first
                    if (mode === 'auto' && driver.getTextLayer) {
                        onProgress?.(`正在检查第 ${pageNum} 页内嵌文本 (${i + 1}/${total})...`, baseProgress + 5)
                        try {
                            const layer = await driver.getTextLayer(pageIndex)
                            if (layer?.spans?.length) {
                                const formatted = formatSpansToText(layer.spans)
                                if (formatted.length > 5) {
                                    pageText = formatted
                                }
                            }
                        } catch (e) {
                            console.warn(`[OCR] getTextLayer error for page ${pageNum}:`, e)
                        }
                    }

                    // 2. If no embedded text or forced image OCR, render high-fidelity page image
                    if (!pageText || mode === 'force_image') {
                        isImageOcr = true
                        onProgress?.(`正在高精度渲染第 ${pageNum} 页画面 (${i + 1}/${total})...`, baseProgress + 10)

                        let canvas = null
                        try {
                            // Cap dimensions to 1600px max dimension for memory safety (count is 1)
                            const pageSizes = await driver.getPageSizes(pageIndex, 1, signal)
                            const size = pageSizes?.[0] || { width: 800, height: 1100 }
                            const maxDim = Math.max(size.width, size.height, 1)
                            const scale = Math.min(2.0, 1600 / maxDim)

                            canvas = await driver.renderPage(pageIndex, scale, signal)
                        } catch (renderErr) {
                            if (signal.aborted) throw new Error('任务已取消')
                            console.warn(`[OCR] Page ${pageNum} renderPage failed:`, renderErr)
                            throw new Error(`第 ${pageNum} 页画面渲染失败: ${renderErr.message || renderErr}`)
                        }

                        if (!canvas || canvas.width === 0 || canvas.height === 0) {
                            throw new Error(`第 ${pageNum} 页无法获取有效画面`)
                        }

                        // 3. Run OCR on canvas
                        const worker = await this._getWorker((stageMsg) => {
                            onProgress?.(`[第 ${pageNum} 页] ${stageMsg}`, baseProgress + 20)
                        }, jobId)

                        if (signal.aborted || jobId !== this._currentJobId) throw new Error('任务已取消')

                        onProgress?.(`正在进行深度文字识别 (第 ${pageNum} 页)...`, baseProgress + 30)
                        const ocrRes = await worker.recognize(canvas)
                        const rawOcrText = (ocrRes?.data?.text || '').trim()
                        pageText = cleanOcrChineseSpaces(rawOcrText)
                    }
                } catch (pageErr) {
                    if (signal.aborted || pageErr.message === '任务已取消') {
                        return { success: false, results, fullText: '', error: '任务已取消' }
                    }
                    console.warn(`[OCR Service] Page ${pageNum} failed:`, pageErr)
                    results.push({
                        page: pageNum,
                        text: '',
                        isImageOcr,
                        error: pageErr.message || String(pageErr)
                    })
                    continue
                }

                results.push({
                    page: pageNum,
                    text: pageText,
                    isImageOcr,
                    error: null
                })

                onProgress?.(`已完成第 ${pageNum} 页处理 (${i + 1}/${total})`, Math.round(((i + 1) / total) * 100))
            }

            // Build grouped full text
            const fullText = results.map(r => {
                const header = total > 1 ? `【第 ${r.page} 页】` : ''
                let body = ''
                if (r.error) {
                    body = `（本页识别异常: ${r.error}）`
                } else {
                    body = r.text || '（本页未检测到明显文字）'
                }
                return header ? `${header}\n${body}` : body
            }).join('\n\n')

            const allFailed = results.length > 0 && results.every(r => r.error)

            return {
                success: !allFailed,
                results,
                fullText,
                error: allFailed ? (results[0]?.error || '全部所选页面提取失败') : undefined
            }
        } catch (err) {
            if (signal.aborted || err.message === '任务已取消') {
                return { success: false, results, fullText: '', error: '任务已取消' }
            }
            console.error('[OCR Service] Error:', err)
            return {
                success: false,
                results,
                fullText: '',
                error: err.message || String(err)
            }
        }
    }
}

export const ocrService = new OcrService()
