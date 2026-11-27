// js/ocr-onnx-worker.js
// Dedicated Web Worker running PP-OCRv6 detection (DBNet) and batched recognition (SVTR/CTC)
// via onnxruntime-web (WebGPU or WASM SIMD) completely offline inside Linden Leaf.

import * as ort from '../vendor/onnxruntime/ort.webgpu.min.mjs'
import {
    parsePaddleInferenceYmlDict,
    dbPostProcess,
    ctcGreedyDecode,
    projectCharRects,
    sortOcrSpansByReadingOrder,
    formatOcrSpansToText
} from './ocr-layout.js'

const DET_LIMIT_SIDE_LEN = 960
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]
const REC_IMG_HEIGHT = 48
const REC_MAX_WIDTH = 3200
const REC_BATCH_SIZE = 6
const REC_MIN_CONFIDENCE = 0.32

function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v)
}

const state = {
    modelId: null,
    backendPref: 'auto',
    executionProvider: 'wasm',
    detSession: null,
    recSession: null,
    vocab: ['', ' '],
    wasmConfigured: false
}

async function releaseSessions() {
    const det = state.detSession
    const rec = state.recSession
    state.detSession = null
    state.recSession = null
    try { await det?.release?.() } catch (_) {}
    try { await rec?.release?.() } catch (_) {}
}

function configureOrtWasmEnv(wasmBuffer) {
    ort.env.wasm.wasmPaths = {
        mjs: new URL('../vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href
    }
    if (wasmBuffer) {
        ort.env.wasm.wasmBinary = wasmBuffer instanceof Uint8Array ? wasmBuffer : new Uint8Array(wasmBuffer)
    }
    const isolated = typeof self !== 'undefined' && Boolean(self.crossOriginIsolated)
    ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1
    ort.env.wasm.simd = true
    ort.env.wasm.proxy = false
    state.wasmConfigured = true
}

async function shouldTryWebGpu(modelId, backendPref, isAndroid) {
    if (backendPref === 'wasm') return false
    if (typeof navigator === 'undefined' || !navigator.gpu) return false
    if (backendPref === 'auto' && (isAndroid || modelId === 'ppocrv6-tiny')) return false
    try {
        const adapter = await navigator.gpu.requestAdapter()
        return Boolean(adapter)
    } catch (_) {
        return false
    }
}

async function createSessionPair(detBytes, recBytes, ep) {
    const opts = {
        executionProviders: [ep],
        graphOptimizationLevel: 'all'
    }
    const detSession = await ort.InferenceSession.create(detBytes, opts)
    try {
        const recSession = await ort.InferenceSession.create(recBytes, opts)
        return { detSession, recSession }
    } catch (err) {
        try { await detSession.release?.() } catch (_) {}
        throw err
    }
}

async function warmupSessions(detSession, recSession) {
    const detName = detSession.inputNames[0]
    const detOut = await detSession.run({
        [detName]: new ort.Tensor('float32', new Float32Array(1 * 3 * 64 * 64), [1, 3, 64, 64])
    })
    const recName = recSession.inputNames[0]
    const recOut = await recSession.run({
        [recName]: new ort.Tensor('float32', new Float32Array(1 * 3 * REC_IMG_HEIGHT * 160), [1, 3, REC_IMG_HEIGHT, 160])
    })
    for (const tensor of [...Object.values(detOut), ...Object.values(recOut)]) {
        try { tensor?.dispose?.() } catch (_) {}
    }
}

async function handleInit(payload) {
    await releaseSessions()
    const {
        modelId,
        detBuffer,
        recBuffer,
        dictText,
        wasmBuffer,
        backendPref = 'auto',
        isAndroid = false
    } = payload

    configureOrtWasmEnv(wasmBuffer)

    const detBytes = detBuffer instanceof Uint8Array ? detBuffer : new Uint8Array(detBuffer)
    const recBytes = recBuffer instanceof Uint8Array ? recBuffer : new Uint8Array(recBuffer)
    const tryWebGpu = await shouldTryWebGpu(modelId, backendPref, isAndroid)

    let detSession = null
    let recSession = null
    let activeEp = 'wasm'

    if (tryWebGpu) {
        try {
            const pair = await createSessionPair(detBytes, recBytes, 'webgpu')
            await warmupSessions(pair.detSession, pair.recSession)
            detSession = pair.detSession
            recSession = pair.recSession
            activeEp = 'webgpu'
        } catch (gpuErr) {
            try { await detSession?.release?.() } catch (_) {}
            try { await recSession?.release?.() } catch (_) {}
            detSession = null
            recSession = null
        }
    }

    if (!detSession || !recSession) {
        const pair = await createSessionPair(detBytes, recBytes, 'wasm')
        detSession = pair.detSession
        recSession = pair.recSession
        activeEp = 'wasm'
    }

    state.modelId = modelId
    state.backendPref = backendPref
    state.executionProvider = activeEp
    state.detSession = detSession
    state.recSession = recSession
    state.vocab = parsePaddleInferenceYmlDict(dictText || '')

    return {
        modelId,
        executionProvider: activeEp,
        vocabSize: state.vocab.length
    }
}

function packDetBgrTensor(rgba, width, height) {
    const planeSize = width * height
    const out = new Float32Array(3 * planeSize)
    const inv255 = 1 / 255
    const [m0, m1, m2] = DET_MEAN
    const [s0, s1, s2] = DET_STD

    for (let i = 0; i < planeSize; i++) {
        const p = i * 4
        const r = rgba[p] * inv255
        const g = rgba[p + 1] * inv255
        const b = rgba[p + 2] * inv255
        // PP-OCRv6 inference.yml specifies DecodeImage img_mode=BGR, NormalizeImage in channel order
        out[i] = (b - m0) / s0
        out[planeSize + i] = (g - m1) / s1
        out[2 * planeSize + i] = (r - m2) / s2
    }
    return new ort.Tensor('float32', out, [1, 3, height, width])
}

function packRecBgrIntoBatch(rgba, cropW, cropH, batchBuf, batchOffset, batchW) {
    const planeSize = batchW * REC_IMG_HEIGHT
    const inv127_5 = 1 / 127.5
    const drawW = Math.min(cropW, batchW)
    for (let y = 0; y < REC_IMG_HEIGHT; y++) {
        const srcRow = y * cropW
        const dstRow = y * batchW
        for (let x = 0; x < drawW; x++) {
            const p = (srcRow + x) * 4
            const r = rgba[p] * inv127_5 - 1
            const g = rgba[p + 1] * inv127_5 - 1
            const b = rgba[p + 2] * inv127_5 - 1
            batchBuf[batchOffset + dstRow + x] = b
            batchBuf[batchOffset + planeSize + dstRow + x] = g
            batchBuf[batchOffset + 2 * planeSize + dstRow + x] = r
        }
    }
}

async function handleRecognize(payload) {
    if (!state.detSession || !state.recSession) {
        throw new Error('PP-OCRv6 worker sessions are not initialized')
    }
    const tStart = performance.now()
    const {
        rgbaBuffer,
        width,
        height,
        direction = 'auto',
        scale = 1.0,
        originX = 0,
        originY = 0
    } = payload

    const safeScale = scale > 0 ? scale : 1.0
    const srcCanvas = new OffscreenCanvas(width, height)
    const detCanvas = new OffscreenCanvas(32, 32)
    const cropCanvas = new OffscreenCanvas(320, REC_IMG_HEIGHT)
    try {
    const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
    const imgData = new ImageData(new Uint8ClampedArray(rgbaBuffer), width, height)
    srcCtx.putImageData(imgData, 0, 0)

    // 1. Dynamic Det resize (max side 960, multiple of 32)
    const maxSide = Math.max(width, height)
    const detRatio = maxSide > DET_LIMIT_SIDE_LEN ? DET_LIMIT_SIDE_LEN / maxSide : 1
    const resizeW = Math.max(32, Math.round((width * detRatio) / 32) * 32)
    const resizeH = Math.max(32, Math.round((height * detRatio) / 32) * 32)

    detCanvas.width = resizeW
    detCanvas.height = resizeH
    const detCtx = detCanvas.getContext('2d', { willReadFrequently: true })
    detCtx.fillStyle = '#ffffff'
    detCtx.fillRect(0, 0, resizeW, resizeH)
    detCtx.drawImage(srcCanvas, 0, 0, width, height, 0, 0, resizeW, resizeH)

    const detRgba = detCtx.getImageData(0, 0, resizeW, resizeH).data
    const detTensor = packDetBgrTensor(detRgba, resizeW, resizeH)

    let detOutputs = null
    let rawBoxes = []
    try {
        detOutputs = await state.detSession.run({ [state.detSession.inputNames[0]]: detTensor })
        const outTensor = detOutputs[state.detSession.outputNames[0]]
        const probMap = await outTensor.getData()
        const dims = outTensor.dims || [1, 1, resizeH, resizeW]
        const mapH = dims[dims.length - 2] || resizeH
        const mapW = dims[dims.length - 1] || resizeW
        rawBoxes = dbPostProcess(probMap, mapW, mapH, width, height, {
            thresh: 0.2,
            boxThresh: state.modelId === 'ppocrv6-tiny' ? 0.4 : 0.45,
            unclipRatio: 1.4,
            minSide: 3,
            maxCandidates: 3000
        })
    } finally {
        try { detTensor?.dispose?.() } catch (_) {}
        if (detOutputs) {
            for (const val of Object.values(detOutputs)) {
                try { val?.dispose?.() } catch (_) {}
            }
        }
    }

    if (!rawBoxes.length) {
        return {
            text: '',
            spans: [],
            direction: direction === 'vertical' ? 'vertical' : 'horizontal',
            engine: 'ppocrv6',
            modelId: state.modelId,
            executionProvider: state.executionProvider,
            elapsedMs: Math.round(performance.now() - tStart)
        }
    }

    // 2. Prepare crop metadata & sort by aspect ratio so batch right-padding stays minimal
    const jobs = rawBoxes.map(box => {
        const isVertical = direction === 'horizontal'
            ? false
            : (direction === 'vertical' ? box.h >= box.w * 1.3 : box.h >= box.w * 1.5)
        const aspect = isVertical
            ? box.h / Math.max(1, box.w)
            : box.w / Math.max(1, box.h)
        const targetW = clamp(Math.ceil(REC_IMG_HEIGHT * aspect), 16, REC_MAX_WIDTH)
        return { box, isVertical, aspect, targetW }
    })
    jobs.sort((a, b) => a.targetW - b.targetW)

    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
    const rawSpans = []

    // 3. Batched Rec inference
    for (let start = 0; start < jobs.length; start += REC_BATCH_SIZE) {
        const batch = jobs.slice(start, start + REC_BATCH_SIZE)
        const bCount = batch.length
        const maxCropW = batch[bCount - 1].targetW
        const batchW = clamp(Math.ceil(maxCropW / 8) * 8, 320, REC_MAX_WIDTH)
        const singleVolume = 3 * REC_IMG_HEIGHT * batchW
        const batchBuf = new Float32Array(bCount * singleVolume)

        for (let bi = 0; bi < bCount; bi++) {
            const job = batch[bi]
            const cw = job.targetW
            if (cropCanvas.width !== cw) cropCanvas.width = cw
            cropCtx.setTransform(1, 0, 0, 1, 0, 0)
            cropCtx.fillStyle = '#ffffff'
            cropCtx.fillRect(0, 0, cw, REC_IMG_HEIGHT)

            const sx = Math.max(0, Math.floor(job.box.x0))
            const sy = Math.max(0, Math.floor(job.box.y0))
            const sw = Math.max(1, Math.min(width - sx, Math.ceil(job.box.w)))
            const sh = Math.max(1, Math.min(height - sy, Math.ceil(job.box.h)))

            if (job.isVertical) {
                // Match PaddleOCR np.rot90(img, k=1): top maps to x=0, bottom maps to x=cw
                cropCtx.translate(0, REC_IMG_HEIGHT)
                cropCtx.rotate(-Math.PI / 2)
                cropCtx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, REC_IMG_HEIGHT, cw)
                cropCtx.setTransform(1, 0, 0, 1, 0, 0)
            } else {
                cropCtx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, cw, REC_IMG_HEIGHT)
            }

            const cropRgba = cropCtx.getImageData(0, 0, cw, REC_IMG_HEIGHT).data
            packRecBgrIntoBatch(cropRgba, cw, REC_IMG_HEIGHT, batchBuf, bi * singleVolume, batchW)
        }

        const recTensor = new ort.Tensor('float32', batchBuf, [bCount, 3, REC_IMG_HEIGHT, batchW])
        let recOutputs = null
        try {
            recOutputs = await state.recSession.run({ [state.recSession.inputNames[0]]: recTensor })
            const outTensor = recOutputs[state.recSession.outputNames[0]]
            const probs = await outTensor.getData()
            const dims = outTensor.dims || [bCount, 40, state.vocab.length]
            const timesteps = dims[1] || 1
            const numClasses = dims[2] || state.vocab.length

            for (let bi = 0; bi < bCount; bi++) {
                const job = batch[bi]
                const validRatio = job.targetW / batchW
                const decoded = ctcGreedyDecode(
                    probs,
                    timesteps,
                    numClasses,
                    state.vocab,
                    validRatio,
                    bi * timesteps * numClasses
                )
                if (!decoded.text || decoded.confidence < REC_MIN_CONFIDENCE) continue

                const pageRect = [
                    job.box.x0 / safeScale + originX,
                    job.box.y0 / safeScale + originY,
                    job.box.x1 / safeScale + originX,
                    job.box.y1 / safeScale + originY
                ]
                const charRects = projectCharRects(
                    pageRect,
                    decoded.charTimesteps,
                    decoded.effectiveTimesteps,
                    job.isVertical
                )
                rawSpans.push({
                    text: decoded.text,
                    rect: pageRect,
                    charRects,
                    vertical: job.isVertical,
                    confidence: Number(decoded.confidence.toFixed(4))
                })
            }
        } finally {
            try { recTensor?.dispose?.() } catch (_) {}
            if (recOutputs) {
                for (const val of Object.values(recOutputs)) {
                    try { val?.dispose?.() } catch (_) {}
                }
            }
        }
    }

    const ordered = sortOcrSpansByReadingOrder(rawSpans, { direction })
    const text = formatOcrSpansToText(ordered.spans, { direction: ordered.direction })

    return {
        text,
        spans: ordered.spans,
        direction: ordered.direction,
        engine: 'ppocrv6',
        modelId: state.modelId,
        executionProvider: state.executionProvider,
        elapsedMs: Math.round(performance.now() - tStart)
    }
    } finally {
        srcCanvas.width = 0
        srcCanvas.height = 0
        detCanvas.width = 0
        detCanvas.height = 0
        cropCanvas.width = 0
        cropCanvas.height = 0
    }
}

self.addEventListener('message', async (event) => {
    const msg = event?.data
    if (!msg || typeof msg !== 'object') return
    const { type, id, payload } = msg
    try {
        if (type === 'init') {
            const info = await handleInit(payload || {})
            self.postMessage({ type: 'init_ok', id, result: info })
        } else if (type === 'recognize') {
            const result = await handleRecognize(payload || {})
            self.postMessage({ type: 'recognize_ok', id, result })
        } else if (type === 'dispose') {
            await releaseSessions()
            self.postMessage({ type: 'dispose_ok', id })
        }
    } catch (err) {
        self.postMessage({
            type: `${type}_err`,
            id,
            error: err?.message || String(err)
        })
    }
})
