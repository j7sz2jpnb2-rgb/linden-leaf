// js/ocr-service.js - Managed, Cancellable OCR & Page Range Text Extraction
// Unifies offline PP-OCRv6 (ONNX Runtime WebGPU / WASM SIMD Worker) with built-in Tesseract.js fallback,
// reading-order layout reconstruction (horizontal, vertical right-to-left, two-column), and abort isolation.

import { t } from './i18n.js'
import { ocrModelManager } from './ocr-model-manager.js'

export const MAX_OCR_PAGES = 100

function createCancelledError() {
    return Object.assign(new Error(t('ocr.error.cancelled')), { code: 'OCR_CANCELLED' })
}

function isCancelledError(err) {
    return Boolean(err && (err.code === 'OCR_CANCELLED' || err.message === '任务已取消' || err.message === t('ocr.error.cancelled')))
}

/** Extracts line objects from Tesseract v4/v5 (`data.lines`) or v7+ (`data.blocks[].paragraphs[].lines[]`) results. */
export function extractOcrLines(data) {
    if (!data) return []
    if (Array.isArray(data.lines) && data.lines.length) return data.lines
    if (!Array.isArray(data.blocks) || !data.blocks.length) return []
    const collected = []
    for (const block of data.blocks) {
        if (Array.isArray(block?.paragraphs) && block.paragraphs.length) {
            for (const para of block.paragraphs) {
                if (Array.isArray(para?.lines) && para.lines.length) {
                    collected.push(...para.lines)
                } else if (para?.words?.length || para?.text?.trim()) {
                    collected.push(para)
                }
            }
        } else if (Array.isArray(block?.lines) && block.lines.length) {
            collected.push(...block.lines)
        }
    }
    return collected
}

/**
 * Validates and parses user-entered page range
 * @param {string} rangeStr e.g. "current", "12", "15-18"
 * @param {number} totalPages Total pages in PDF
 * @param {number} currentPage 1-based current page
 * @param {number} [maxPages=100] Maximum permitted pages per extraction
 * @returns {{ valid: boolean, pages: number[], error?: string }}
 */
export function parsePageRange(rangeStr, totalPages, currentPage, maxPages = MAX_OCR_PAGES) {
    const raw = (rangeStr || '').trim().toLowerCase()
    if (!raw || raw === 'current' || raw === '当前页' || raw === 'current page') {
        const cur = Math.max(1, Math.min(currentPage || 1, totalPages))
        return { valid: true, pages: [cur] }
    }

    const normalized = raw.replace(/\s*([–—~～至到\-])\s*/g, '$1')
    const tokens = normalized.split(/[,，、\s]+/).filter(Boolean)
    if (tokens.length === 0) {
        return { valid: false, pages: [], error: t('ocr.error.invalidRangeInput') }
    }

    const pagesSet = new Set()
    for (const token of tokens) {
        const rangeMatch = token.match(/^(\d+)[–—~～至到\-]+(\d+)$/)
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10)
            const end = parseInt(rangeMatch[2], 10)
            if (start < 1 || end > totalPages) {
                return { valid: false, pages: [], error: t('ocr.error.rangeOutOfBounds', { totalPages }) }
            }
            if (start > end) {
                return { valid: false, pages: [], error: t('ocr.error.startAfterEnd') }
            }
            for (let i = start; i <= end; i++) {
                pagesSet.add(i)
            }
        } else if (/^\d+$/.test(token)) {
            const p = parseInt(token, 10)
            if (p < 1 || p > totalPages) {
                return { valid: false, pages: [], error: t('ocr.error.pageOutOfBounds', { totalPages }) }
            }
            pagesSet.add(p)
        } else {
            return { valid: false, pages: [], error: t('ocr.error.invalidFormat', { token }) }
        }
    }

    const uniquePages = Array.from(pagesSet).sort((a, b) => a - b)
    if (uniquePages.length === 0) {
        return { valid: false, pages: [], error: t('ocr.error.noValidPages') }
    }
    if (uniquePages.length > maxPages) {
        return { valid: false, pages: [], error: t('ocr.error.tooManyPages', { maxPages }) }
    }
    return { valid: true, pages: uniquePages }
}

/**
 * Formats text spans into natural reading order without destroying CJK typography
 * @param {Array<{ text: string, rect?: number[] }>} spans
 * @returns {string}
 */
export function formatSpansToText(spans) {
    if (!spans || !spans.length) return ''

    if (spans.every(s => Number.isFinite(s.line))) {
        const lines = new Map()
        for (const span of spans) {
            if (!lines.has(span.line)) lines.set(span.line, [])
            lines.get(span.line).push(span)
        }
        return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => {
            row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
            let text = ''
            for (let i = 0; i < row.length; i++) {
                const current = row[i], previous = row[i - 1]
                const gap = previous ? current.x - (previous.x + previous.w) : 0
                if (previous && /[\w]$/.test(previous.text) && /^[\w]/.test(current.text) &&
                    gap > (current.size || current.h || 10) * 0.25) text += ' '
                text += current.text || ''
            }
            return text.trim()
        }).filter(Boolean).join('\n')
    }
    spans = spans.map(s => ({ ...s, rect: s.rect || (Number.isFinite(s.x) && Number.isFinite(s.y)
        ? [s.x, s.y, s.x + (s.w || 0), s.y + (s.h || 0)] : undefined) }))

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
    return text.replace(/([\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e])[ \t\u00a0]+(?=[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e])/g, '$1')
}

export function getOcrAssetOptions(baseUrl = document.baseURI) {
    const simdProbe = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])
    const simd = typeof WebAssembly !== 'undefined' && WebAssembly.validate(simdProbe)
    const asset = name => new URL(`./vendor/tesseract/${name}`, baseUrl).href
    return {
        workerPath: asset('worker.min.js'),
        corePath: asset(simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
        langPath: asset('tessdata'),
        workerBlobURL: false
    }
}

function recognizeWithCancellation(worker, canvas, signal) {
    if (signal.aborted) return Promise.reject(createCancelledError())
    let cancel
    const stopped = new Promise((_, reject) => {
        cancel = () => reject(createCancelledError())
        signal.addEventListener('abort', cancel, { once: true })
    })
    return Promise.race([worker.recognize(canvas, {}, { text: true, blocks: true }), stopped])
        .finally(() => signal.removeEventListener('abort', cancel))
}

function extractRgbaForOnnx(canvas, rotation = 0) {
    const w = canvas.width || 0
    const h = canvas.height || 0
    if (w <= 0 || h <= 0) throw new Error('Invalid canvas dimensions for OCR')

    if (!rotation || rotation === 0 || (rotation !== 90 && rotation !== 180 && rotation !== 270)) {
        const ctx = canvas.getContext?.('2d', { willReadFrequently: true }) || canvas.getContext?.('2d')
        if (!ctx) throw new Error('Canvas 2D context unavailable')
        const img = ctx.getImageData(0, 0, w, h)
        return { rgbaBuffer: img.data.buffer.slice(0), width: w, height: h }
    }

    const outW = (rotation === 90 || rotation === 270) ? h : w
    const outH = (rotation === 90 || rotation === 270) ? w : h
    const tmp = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(outW, outH)
        : document.createElement('canvas')
    tmp.width = outW
    tmp.height = outH
    try {
        const ctx = tmp.getContext('2d', { willReadFrequently: true })
        ctx.save()
        if (rotation === 90) {
            ctx.translate(outW, 0)
            ctx.rotate(Math.PI / 2)
        } else if (rotation === 180) {
            ctx.translate(outW, outH)
            ctx.rotate(Math.PI)
        } else if (rotation === 270) {
            ctx.translate(0, outH)
            ctx.rotate(-Math.PI / 2)
        }
        ctx.drawImage(canvas, 0, 0)
        ctx.restore()
        const img = ctx.getImageData(0, 0, outW, outH)
        return { rgbaBuffer: img.data.buffer.slice(0), width: outW, height: outH }
    } finally {
        tmp.width = 0
        tmp.height = 0
    }
}

export class OcrService {
    constructor() {
        this._worker = null
        this._workerInitializing = false
        this._workerInitToken = 0
        this._workerInitPromise = null
        this._abortEpoch = 0
        this._currentJobId = 0
        this._batchJobId = 0
        this._activeAbortController = null
        this._onStageChange = null
        this._cancelWorkerInit = null
        this._recognizeChain = Promise.resolve()

        this._config = {
            engine: 'auto',
            backend: 'auto',
            direction: 'auto'
        }
        this._onnxWorker = null
        this._onnxInitPromise = null
        this._onnxModelId = null
        this._onnxBackendPref = null
        this._onnxExecutionProvider = null
        this._onnxMsgSeq = 0
        this._onnxPending = new Map()
    }

    configure(opts = {}) {
        if (!opts || typeof opts !== 'object') return
        const nextEngine = ['auto', 'ppocrv6-small', 'ppocrv6-tiny', 'tesseract'].includes(opts.engine)
            ? opts.engine
            : this._config.engine
        const nextBackend = ['auto', 'webgpu', 'wasm'].includes(opts.backend)
            ? opts.backend
            : this._config.backend
        const nextDirection = ['auto', 'horizontal', 'vertical'].includes(opts.direction)
            ? opts.direction
            : this._config.direction

        const backendChanged = nextBackend !== this._config.backend
        const explicitModelChanged = (nextEngine === 'ppocrv6-small' || nextEngine === 'ppocrv6-tiny')
            && this._onnxModelId && this._onnxModelId !== nextEngine
        this._config = { engine: nextEngine, backend: nextBackend, direction: nextDirection }

        if (backendChanged || explicitModelChanged || nextEngine === 'tesseract') {
            this._terminateOnnxWorker()
        }
    }

    getConfig() {
        return { ...this._config }
    }

    _terminateOnnxWorker() {
        this._onnxInitPromise = null
        this._onnxModelId = null
        this._onnxBackendPref = null
        this._onnxExecutionProvider = null
        for (const [, pending] of this._onnxPending) {
            pending.reject?.(createCancelledError())
        }
        this._onnxPending.clear()
        if (this._onnxWorker) {
            const w = this._onnxWorker
            this._onnxWorker = null
            try { w.postMessage({ type: 'dispose', id: ++this._onnxMsgSeq }) } catch (_) {}
            try { w.terminate() } catch (_) {}
        }
    }

    /**
     * Terminate active workers and cancel any running job
     */
    async abort() {
        this._abortEpoch++
        this._currentJobId++
        this._batchJobId++
        this._workerInitToken++
        this._workerInitPromise = null
        this._workerInitializing = false
        this._onStageChange = null
        this._cancelWorkerInit?.()
        this._cancelWorkerInit = null
        if (this._activeAbortController) {
            this._activeAbortController.abort()
            this._activeAbortController = null
        }
        this._terminateOnnxWorker()
        if (this._worker) {
            const w = this._worker
            this._worker = null
            this._workerInitializing = false
            try {
                await w.terminate()
            } catch (e) {}
        }
    }

    async resolveEffectiveEngine(preferred = this._config.engine) {
        const pref = ['auto', 'ppocrv6-small', 'ppocrv6-tiny', 'tesseract'].includes(preferred) ? preferred : 'auto'
        if (pref === 'tesseract') {
            return { engine: 'tesseract', fallbackReason: null, status: null }
        }
        // Without Worker + OffscreenCanvas, fall back gracefully to Tesseract
        if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
            return { engine: 'tesseract', fallbackReason: 'unsupported_env', status: null }
        }
        let status = null
        try {
            status = await ocrModelManager.getStatus()
        } catch (_) {
            status = null
        }
        const byId = new Map((status?.models || []).map(m => [m.id, m]))
        if (pref === 'ppocrv6-small' || pref === 'ppocrv6-tiny') {
            if (byId.get(pref)?.ready) {
                return { engine: pref, fallbackReason: null, status }
            }
            return { engine: 'tesseract', fallbackReason: 'model_not_installed', status }
        }
        if (byId.get('ppocrv6-small')?.ready) {
            return { engine: 'ppocrv6-small', fallbackReason: null, status }
        }
        if (byId.get('ppocrv6-tiny')?.ready) {
            return { engine: 'ppocrv6-tiny', fallbackReason: null, status }
        }
        return { engine: 'tesseract', fallbackReason: 'no_ppocr_installed', status }
    }

    async getActiveEngineInfo() {
        const resolved = await this.resolveEffectiveEngine(this._config.engine)
        return {
            configuredEngine: this._config.engine,
            configuredBackend: this._config.backend,
            configuredDirection: this._config.direction,
            effectiveEngine: resolved.engine,
            executionProvider: resolved.engine === 'tesseract'
                ? 'wasm'
                : (this._onnxModelId === resolved.engine && this._onnxExecutionProvider
                    ? this._onnxExecutionProvider
                    : this._config.backend),
            fallbackReason: resolved.fallbackReason,
            status: resolved.status
        }
    }

    _sendOnnxWorkerRpc(worker, type, payload, transfer = [], signal = null) {
        if (signal?.aborted) return Promise.reject(createCancelledError())
        const id = ++this._onnxMsgSeq
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this._onnxPending.delete(id)
                this._terminateOnnxWorker()
                reject(createCancelledError())
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true })
            this._onnxPending.set(id, {
                resolve: (res) => {
                    signal?.removeEventListener('abort', onAbort)
                    resolve(res)
                },
                reject: (err) => {
                    signal?.removeEventListener('abort', onAbort)
                    reject(err)
                }
            })
            try {
                worker.postMessage({ type, id, payload }, transfer)
            } catch (err) {
                signal?.removeEventListener('abort', onAbort)
                this._onnxPending.delete(id)
                reject(err)
            }
        })
    }

    async _ensureOnnxWorker(modelId, backendPref = this._config.backend, onStageChange = null, abortEpoch = this._abortEpoch, signal = null) {
        if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
        if (this._onnxWorker && !this._onnxInitPromise && this._onnxModelId === modelId && this._onnxBackendPref === backendPref) {
            return this._onnxWorker
        }
        if (this._onnxInitPromise && this._onnxModelId === modelId && this._onnxBackendPref === backendPref) {
            const w = await this._onnxInitPromise
            if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
            return w
        }

        this._terminateOnnxWorker()
        this._onnxModelId = modelId
        this._onnxBackendPref = backendPref

        const initTask = (async () => {
            onStageChange?.(t('ocr.stage.loadingOnnxModel', { model: modelId }))
            const assets = await ocrModelManager.loadModelAssets(modelId)
            if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()

            const workerUrl = new URL('./ocr-onnx-worker.js', import.meta.url)
            const worker = new Worker(workerUrl, { type: 'module' })
            worker.addEventListener('message', (event) => {
                const msg = event?.data
                if (!msg || typeof msg.id !== 'number') return
                const pending = this._onnxPending.get(msg.id)
                if (!pending) return
                this._onnxPending.delete(msg.id)
                if (String(msg.type).endsWith('_err')) {
                    pending.reject(new Error(msg.error || 'ONNX OCR worker error'))
                } else {
                    pending.resolve(msg.result)
                }
            })
            worker.addEventListener('error', (errEvent) => {
                const msg = errEvent?.message || 'ONNX OCR worker crashed'
                for (const [, p] of this._onnxPending) p.reject(new Error(msg))
                this._onnxPending.clear()
                if (this._onnxWorker === worker) this._terminateOnnxWorker()
            })

            this._onnxWorker = worker
            const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')
            const transfers = [assets.detBuffer, assets.recBuffer, assets.wasmBuffer]
                .filter(buf => buf instanceof ArrayBuffer)
            const info = await this._sendOnnxWorkerRpc(
                worker,
                'init',
                {
                    modelId,
                    detBuffer: assets.detBuffer,
                    recBuffer: assets.recBuffer,
                    dictText: assets.dictText,
                    wasmBuffer: assets.wasmBuffer,
                    backendPref,
                    isAndroid
                },
                transfers,
                signal
            )
            if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
            this._onnxExecutionProvider = info?.executionProvider || 'wasm'
            return worker
        })()

        this._onnxInitPromise = initTask
        try {
            return await initTask
        } catch (err) {
            if (this._onnxInitPromise === initTask) {
                this._terminateOnnxWorker()
            }
            throw err
        } finally {
            if (this._onnxInitPromise === initTask) {
                this._onnxInitPromise = null
            }
        }
    }

    async _recognizeCanvasWithOnnx(modelId, canvas, signal, opts = {}) {
        const abortEpoch = this._abortEpoch
        const worker = await this._ensureOnnxWorker(
            modelId,
            this._config.backend,
            opts.onStageChange,
            abortEpoch,
            signal
        )
        if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()

        const scale = opts.scale || 1.0
        const rotation = opts.rotation || 0
        const originX = opts.originX || 0
        const originY = opts.originY || 0
        const direction = opts.direction || this._config.direction || 'auto'

        const { rgbaBuffer, width, height } = extractRgbaForOnnx(canvas, rotation)
        const activeSignal = signal || new AbortController().signal

        const run = async () => {
            if (activeSignal.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
            return await this._sendOnnxWorkerRpc(
                worker,
                'recognize',
                { rgbaBuffer, width, height, direction, scale, originX, originY },
                [rgbaBuffer],
                activeSignal
            )
        }
        const next = this._recognizeChain.then(run, run)
        this._recognizeChain = next.catch(() => {})
        const res = await next
        if (activeSignal.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
        return {
            text: cleanOcrChineseSpaces(res?.text || ''),
            spans: Array.isArray(res?.spans) ? res.spans : [],
            direction: res?.direction || direction,
            engine: res?.modelId || modelId,
            executionProvider: res?.executionProvider || this._onnxExecutionProvider || 'wasm',
            elapsedMs: res?.elapsedMs || 0
        }
    }

    _enqueueRecognize(worker, canvas, signal) {
        const run = async () => {
            if (signal?.aborted) throw createCancelledError()
            return await recognizeWithCancellation(worker, canvas, signal)
        }
        const next = this._recognizeChain.then(run, run)
        this._recognizeChain = next.catch(() => {})
        return next
    }

    /**
     * Lazily get or create Tesseract worker with tokenized abort protection
     */
    async _getWorker(onStageChange, abortEpoch = this._abortEpoch, signal = null) {
        if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
        this._onStageChange = onStageChange
        if (this._worker) return this._worker
        if (this._workerInitPromise) {
            const worker = await this._workerInitPromise
            if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
            return worker
        }
        if (typeof Tesseract === 'undefined') {
            if (typeof document !== 'undefined') {
                try {
                    await new Promise((resolve, reject) => {
                        const s = document.createElement('script')
                        s.src = './vendor/tesseract/tesseract.min.js'
                        s.onload = () => resolve()
                        s.onerror = (e) => reject(new Error(t('ocr.error.scriptLoadFailed', { detail: e })))
                        document.head.appendChild(s)
                    })
                } catch (_) {}
            }
            if (typeof Tesseract === 'undefined') {
                throw new Error(t('ocr.error.engineNotLoaded'))
            }
        }

        onStageChange?.(t('ocr.stage.initWorker'))
        this._workerInitializing = true
        const initToken = ++this._workerInitToken

        this._workerInitPromise = (async () => {
            let worker = null
            let timer
            try {
                let rejectInitialization
                const interrupted = new Promise((_, reject) => { rejectInitialization = reject })
                this._cancelWorkerInit = () => rejectInitialization(createCancelledError())
                timer = setTimeout(() => rejectInitialization(new Error(t('ocr.error.initTimeout'))), 45000)
                const creation = Tesseract.createWorker(['chi_sim', 'eng'], 1, {
                    ...getOcrAssetOptions(),
                    errorHandler: error => rejectInitialization(new Error(String(error))),
                    logger: (m) => {
                        if (initToken !== this._workerInitToken || abortEpoch !== this._abortEpoch) return
                        if (m.status === 'recognizing text') {
                            const pct = Math.round((m.progress || 0) * 100)
                            this._onStageChange?.(t('ocr.stage.recognizingPct', { pct }))
                        } else if (m.status === 'loading tesseract core') {
                            this._onStageChange?.(t('ocr.stage.loadingCore'))
                        } else if (m.status === 'loading language traineddata') {
                            this._onStageChange?.(t('ocr.stage.loadingLangData'))
                        } else if (m.status === 'initializing tesseract') {
                            this._onStageChange?.(t('ocr.stage.initializingEngine'))
                        }
                    }
                })
                creation.then(created => {
                    if (initToken !== this._workerInitToken || abortEpoch !== this._abortEpoch) created.terminate().catch(() => {})
                }, () => {})
                worker = await Promise.race([creation, interrupted])
                clearTimeout(timer)

                if (initToken !== this._workerInitToken || abortEpoch !== this._abortEpoch) {
                    await worker.terminate().catch(() => {})
                    throw createCancelledError()
                }

                await worker.setParameters({
                    tessedit_pageseg_mode: Tesseract.PSM.AUTO
                })

                if (initToken !== this._workerInitToken || abortEpoch !== this._abortEpoch) {
                    await worker.terminate().catch(() => {})
                    throw createCancelledError()
                }

                this._worker = worker
                return worker
            } catch (err) {
                if (worker && this._worker !== worker) {
                    await worker.terminate().catch(() => {})
                }
                if (isCancelledError(err)) throw err
                let msg = err.message || t('ocr.error.resourceLoad')
                if (/NetworkError|Failed to fetch|failed to load/i.test(msg)) {
                    msg = t('ocr.error.missingAssets', { detail: msg })
                }
                throw new Error(t('ocr.error.initFailed', { detail: msg }))
            } finally {
                clearTimeout(timer)
                if (initToken === this._workerInitToken) {
                    this._workerInitializing = false
                    this._workerInitPromise = null
                    this._cancelWorkerInit = null
                }
            }
        })()

        const worker = await this._workerInitPromise
        if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
        return worker
    }

    async _recognizeCanvasWithTesseract(canvas, signal = null, scaleOrOptions = 1.0) {
        const abortEpoch = this._abortEpoch
        const onStageChange = (scaleOrOptions && typeof scaleOrOptions === 'object') ? scaleOrOptions.onStageChange : null
        const worker = await this._getWorker(onStageChange || null, abortEpoch, signal)
        if (signal?.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()
        const activeSignal = signal || new AbortController().signal
        const ocrRes = await this._enqueueRecognize(worker, canvas, activeSignal)
        if (activeSignal.aborted || abortEpoch !== this._abortEpoch) throw createCancelledError()

        let scale = 1.0
        let rotation = 0
        let originX = 0
        let originY = 0
        if (typeof scaleOrOptions === 'number') {
            scale = scaleOrOptions
        } else if (scaleOrOptions && typeof scaleOrOptions === 'object') {
            scale = scaleOrOptions.scale || 1.0
            rotation = scaleOrOptions.rotation || 0
            originX = scaleOrOptions.originX || 0
            originY = scaleOrOptions.originY || 0
        }
        const safeScale = scale > 0 ? scale : 1.0

        const mapPoint = (px, py) => {
            let x = px / safeScale
            let y = py / safeScale
            if (rotation === 90) {
                const ch = (canvas.height || 0) / safeScale
                const nx = y
                const ny = ch - x
                x = nx
                y = ny
            } else if (rotation === 180) {
                const cw = (canvas.width || 0) / safeScale
                const ch = (canvas.height || 0) / safeScale
                x = cw - x
                y = ch - y
            } else if (rotation === 270) {
                const cw = (canvas.width || 0) / safeScale
                const nx = cw - y
                const ny = x
                x = nx
                y = ny
            }
            return [x + originX, y + originY]
        }

        const mapBbox = (b) => {
            const [x0, y0] = mapPoint(b.x0 ?? 0, b.y0 ?? 0)
            const [x1, y1] = mapPoint(b.x1 ?? 0, b.y1 ?? 0)
            return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
        }

        const spans = []
        const lines = extractOcrLines(ocrRes?.data)
        if (lines.length) {
            lines.forEach((line, lineIdx) => {
                if (line.words?.length) {
                    line.words.forEach(w => {
                        const text = w.text?.trim()
                        if (!text) return
                        if (Array.isArray(w.symbols) && w.symbols.length > 0) {
                            for (const sym of w.symbols) {
                                const st = sym.text?.trim()
                                if (!st) continue
                                const sb = sym.bbox || w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 }
                                spans.push({
                                    text: st,
                                    rect: mapBbox(sb),
                                    line: lineIdx
                                })
                            }
                        } else {
                            const b = w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 }
                            spans.push({
                                text,
                                rect: mapBbox(b),
                                line: lineIdx
                            })
                        }
                    })
                } else {
                    const text = line.text?.trim()
                    if (!text) return
                    const b = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 }
                    spans.push({
                        text,
                        rect: mapBbox(b),
                        line: lineIdx
                    })
                }
            })
        } else if (ocrRes?.data?.words?.length) {
            ocrRes.data.words.forEach((word, wordIdx) => {
                const text = word.text?.trim()
                if (!text) return
                const b = word.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 }
                spans.push({
                    text,
                    rect: mapBbox(b),
                    line: wordIdx
                })
            })
        } else if (ocrRes?.data?.spans?.length) {
            ocrRes.data.spans.forEach((s, idx) => {
                const text = s.text?.trim()
                if (!text) return
                const r = s.rect || [0, 0, 0, 0]
                const [x0, y0] = mapPoint(r[0], r[1])
                const [x1, y1] = mapPoint(r[2], r[3])
                spans.push({
                    text,
                    rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)],
                    line: s.line ?? idx
                })
            })
        }

        const rawText = (ocrRes?.data?.text || spans.map(s => s.text).join('\n')).trim()
        const text = cleanOcrChineseSpaces(rawText)
        return { text, spans, engine: 'tesseract', executionProvider: 'wasm' }
    }

    /**
     * Recognize text from a single canvas with geometry spans mapped back to page points.
     * Routes automatically to PP-OCRv6 Small/Tiny ONNX Worker when installed, falling back safely to Tesseract.js.
     * @param {HTMLCanvasElement} canvas
     * @param {AbortSignal} [signal]
     * @param {number|object} [scaleOrOptions=1.0] Rendering scale or options of canvas relative to page points
     * @returns {Promise<{ text: string, spans: Array<{ text: string, rect: number[], line: number }> }>}
     */
    async recognizeCanvas(canvas, signal = null, scaleOrOptions = 1.0) {
        if (!canvas) throw new Error('Canvas is required for OCR')
        if (signal?.aborted) throw createCancelledError()

        const opts = (scaleOrOptions && typeof scaleOrOptions === 'object') ? scaleOrOptions : null
        const hasInjectedTesseract = Boolean(this._worker) || (this._getWorker !== OcrService.prototype._getWorker)
        if (hasInjectedTesseract || opts?.forceTesseract) {
            return await this._recognizeCanvasWithTesseract(canvas, signal, scaleOrOptions)
        }

        const resolved = await this.resolveEffectiveEngine(opts?.engine || this._config.engine)
        if (signal?.aborted) throw createCancelledError()

        if (resolved.engine === 'ppocrv6-small' || resolved.engine === 'ppocrv6-tiny') {
            try {
                return await this._recognizeCanvasWithOnnx(resolved.engine, canvas, signal, opts || { scale: scaleOrOptions })
            } catch (err) {
                if (signal?.aborted || isCancelledError(err)) throw err
                console.warn(`[OCR] ${resolved.engine} failed, falling back to Tesseract:`, err)
                this._terminateOnnxWorker()
            }
        }

        return await this._recognizeCanvasWithTesseract(canvas, signal, scaleOrOptions)
    }

    /**
     * Execute text extraction across specified pages
     * @param {object} params
     * @param {object} params.driver PDF driver
     * @param {number[]} params.pages 1-based page numbers
     * @param {'auto' | 'text_only' | 'force_image'} [params.mode='auto']
     * @param {'auto' | 'horizontal' | 'vertical'} [params.direction]
     * @param {function(string, number): void} [params.onProgress] (statusText, overallPercent)
     * @returns {Promise<{ success: boolean, results: Array<{ page: number, text: string, isImageOcr: boolean }>, fullText: string, error?: string }>}
     */
    async extractText({ driver, pages, mode = 'auto', direction, onProgress, onPageResult }) {
        if (!driver) throw new Error(t('ocr.error.driverUnavailable'))
        if (!pages || !pages.length) throw new Error(t('ocr.error.selectPages'))
        if (pages.length > MAX_OCR_PAGES) throw new Error(t('ocr.error.maxPages', { maxPages: MAX_OCR_PAGES }))
        if (!['auto', 'text_only', 'force_image'].includes(mode)) throw new Error(t('ocr.error.unsupportedMode'))

        const myBatchSeq = (this._batchSeq = (this._batchSeq || 0) + 1)
        await this.abort()
        if (myBatchSeq !== this._batchSeq) {
            return { success: false, results: [], fullText: '', error: t('ocr.error.cancelled') }
        }
        const batchJobId = this._batchJobId
        const abortEpoch = this._abortEpoch
        const controller = this._activeAbortController = new AbortController()
        const signal = controller.signal

        const results = []
        const total = pages.length
        const formatPage = result => {
            const body = result.error ? t('ocr.page.extractError', { detail: result.error })
                : result.text || (mode === 'text_only' ? t('ocr.page.noTextLayer') : t('ocr.page.noVisibleText'))
            return total > 1 ? `${t('ocr.page.header', { page: result.page })}\n${body}` : body
        }
        const fullTextSoFar = () => results.map(formatPage).join('\n\n')
        const commitPage = result => {
            results.push(result)
            onPageResult?.(result, formatPage(result))
        }

        try {
            for (let i = 0; i < total; i++) {
                if (signal.aborted || batchJobId !== this._batchJobId || abortEpoch !== this._abortEpoch) {
                    return { success: false, results, fullText: fullTextSoFar(), error: t('ocr.error.cancelled') }
                }

                const pageNum = pages[i]
                const pageIndex = pageNum - 1
                const baseProgress = Math.round((i / total) * 100)

                let pageText = ''
                let isImageOcr = false

                try {
                    if (mode !== 'force_image' && driver.getTextLayer) {
                        onProgress?.(t('ocr.stage.checkingEmbedded', { page: pageNum, index: i + 1, total }), baseProgress + 5 / total)
                        try {
                            const layer = await driver.getTextLayer(pageIndex)
                            if (layer?.spans?.length) {
                                const formatted = formatSpansToText(layer.spans)
                                if (formatted.trim().length > 0) {
                                    pageText = formatted
                                }
                            }
                        } catch (e) {
                            if (mode === 'text_only') throw e
                            onProgress?.(t('ocr.stage.layerFallback', { page: pageNum }), baseProgress + 5 / total)
                            console.warn(`[OCR] getTextLayer error for page ${pageNum}:`, e)
                        }
                    }

                    if (mode === 'text_only' && !driver.getTextLayer) throw new Error(t('ocr.error.noTextLayerSupport'))
                    if (mode !== 'text_only' && (!pageText || mode === 'force_image')) {
                        isImageOcr = true
                        if (mode === 'auto') onProgress?.(t('ocr.stage.noLayerSwitch', { page: pageNum }), baseProgress + 5 / total)
                        onProgress?.(t('ocr.stage.renderingPage', { page: pageNum, index: i + 1, total }), baseProgress + 10 / total)

                        let canvas = null
                        let renderScale = 1.5
                        try {
                            const pageSizes = await driver.getPageSizes(pageIndex, 1, signal)
                            const size = pageSizes?.[0] || { width: 800, height: 1100 }
                            const maxDim = Math.max(size.width, size.height, 1)
                            renderScale = Math.min(3.0, 2400 / maxDim)
                            canvas = await driver.renderPage(pageIndex, renderScale, signal)
                        } catch (renderErr) {
                            if (signal.aborted) throw createCancelledError()
                            console.warn(`[OCR] Page ${pageNum} renderPage failed:`, renderErr)
                            throw new Error(t('ocr.error.renderFailed', { page: pageNum, detail: renderErr.message || renderErr }))
                        }

                        if (!canvas || canvas.width === 0 || canvas.height === 0) {
                            throw new Error(t('ocr.error.invalidCanvas', { page: pageNum }))
                        }

                        try {
                            onProgress?.(t('ocr.stage.recognizingPage', { page: pageNum }), baseProgress + 30 / total)
                            const recognized = await this.recognizeCanvas(canvas, signal, {
                                scale: renderScale,
                                direction: direction || this._config.direction || 'auto',
                                onStageChange: (stageMsg) => {
                                    onProgress?.(t('ocr.stage.pageStagePrefix', { page: pageNum, stage: stageMsg }), baseProgress + 20 / total)
                                }
                            })
                            if (signal.aborted || batchJobId !== this._batchJobId || abortEpoch !== this._abortEpoch) throw createCancelledError()
                            pageText = cleanOcrChineseSpaces((recognized?.text || '').trim())
                        } finally {
                            canvas.width = 0
                            canvas.height = 0
                        }
                    }
                } catch (pageErr) {
                    if (signal.aborted || isCancelledError(pageErr)) {
                        return { success: false, results, fullText: fullTextSoFar(), error: t('ocr.error.cancelled') }
                    }
                    console.warn(`[OCR Service] Page ${pageNum} failed:`, pageErr)
                    commitPage({
                        page: pageNum,
                        text: '',
                        isImageOcr,
                        error: pageErr.message || String(pageErr)
                    })
                    continue
                }

                if (signal.aborted || batchJobId !== this._batchJobId || abortEpoch !== this._abortEpoch) {
                    return { success: false, results, fullText: fullTextSoFar(), error: t('ocr.error.cancelled') }
                }
                commitPage({
                    page: pageNum,
                    text: pageText,
                    isImageOcr,
                    source: isImageOcr ? 'image_ocr' : 'embedded_text',
                    error: null
                })

                onProgress?.(t('ocr.stage.pageDone', { page: pageNum, index: i + 1, total }), Math.round(((i + 1) / total) * 100))
            }

            const fullText = fullTextSoFar()
            const allFailed = results.length > 0 && results.every(r => r.error)

            return {
                success: !allFailed,
                results,
                fullText,
                error: allFailed ? (results[0]?.error || t('ocr.error.allPagesFailed')) : undefined
            }
        } catch (err) {
            if (signal.aborted || isCancelledError(err)) {
                return { success: false, results, fullText: fullTextSoFar(), error: t('ocr.error.cancelled') }
            }
            console.error('[OCR Service] Error:', err)
            return {
                success: false,
                results,
                fullText: '',
                error: err.message || String(err)
            }
        } finally {
            if (batchJobId === this._batchJobId && abortEpoch === this._abortEpoch) {
                await this.abort()
            }
        }
    }
}

export const ocrService = new OcrService()
