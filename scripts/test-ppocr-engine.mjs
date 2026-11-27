// scripts/test-ppocr-engine.mjs
// Unit & structural tests for PP-OCRv6 layout/post-processing, CTC timestep projection,
// vertical/two-column reading order, PDF viewport vertical OCR layer, schema validation,
// and ONNX Runtime asset wiring.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    parsePaddleInferenceYmlDict,
    dbPostProcess,
    ctcGreedyDecode,
    projectCharRects,
    detectPageDirection,
    sortOcrSpansByReadingOrder,
    formatOcrSpansToText
} from '../js/ocr-layout.js'
import { DEFAULT_ADVANCED_SETTINGS, sanitizeAdvancedSettings } from '../js/advanced-settings-schema.js'
import { classifyLocalOcrAssetFile } from '../js/ocr-model-manager.js'
import { OcrService } from '../js/ocr-service.js'
import { buildOcrCharEntries } from '../js/pdf-viewport.js'
import { PdfToolsController } from '../js/pdf-tools-controller.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('parsePaddleInferenceYmlDict parses PaddleX YAML quotes and aligns CTC +2 slots', () => {
    const sampleYml = [
        'Global:',
        '  model_name: PP-OCRv6_small_rec',
        'PostProcess:',
        '  name: CTCLabelDecode',
        '  character_dict:',
        "  - '!'",
        "  - '\"'",
        '  - $',
        "  - ''''",
        '  - \\',
        '  - 你',
        '  - 好',
        '  - 🛃'
    ].join('\n')

    const vocab = parsePaddleInferenceYmlDict(sampleYml)
    assert.equal(vocab.length, 10, '8 dict entries + blank[0] + space[N+1] = 10')
    assert.equal(vocab[0], '')
    assert.equal(vocab[1], '!')
    assert.equal(vocab[2], '"')
    assert.equal(vocab[3], '$')
    assert.equal(vocab[4], "'")
    assert.equal(vocab[5], '\\')
    assert.equal(vocab[6], '你')
    assert.equal(vocab[7], '好')
    assert.equal(vocab[8], '🛃')
    assert.equal(vocab[9], ' ')
})

test('parsePaddleInferenceYmlDict also accepts plain dict.txt format', () => {
    const plainDict = '0\n1\nA\n中\n文\n'
    const vocab = parsePaddleInferenceYmlDict(plainDict)
    assert.deepEqual(vocab, ['', '0', '1', 'A', '中', '文', ' '])
})

test('dbPostProcess extracts connected components, filters boxThresh, unclips, and rescales', () => {
    const mapW = 40
    const mapH = 30
    const srcW = 400
    const srcH = 300
    const prob = new Float32Array(mapW * mapH)

    // Strong box at [5..14, 4..8] -> w=10, h=5
    for (let y = 4; y <= 8; y++) {
        for (let x = 5; x <= 14; x++) {
            prob[y * mapW + x] = 0.85
        }
    }
    // Weak box (mean 0.25 < boxThresh 0.45) at [20..28, 15..19]
    for (let y = 15; y <= 19; y++) {
        for (let x = 20; x <= 28; x++) {
            prob[y * mapW + x] = 0.25
        }
    }

    const boxes = dbPostProcess(prob, mapW, mapH, srcW, srcH, {
        thresh: 0.2,
        boxThresh: 0.45,
        unclipRatio: 1.4,
        minSide: 3
    })

    assert.equal(boxes.length, 1)
    assert.ok(boxes[0].score > 0.8)
    // Scaled by 10x and unclipped beyond [50, 40, 150, 90]
    assert.ok(boxes[0].x0 < 50 && boxes[0].y0 < 40)
    assert.ok(boxes[0].x1 > 150 && boxes[0].y1 > 90)
    assert.ok(boxes[0].x0 >= 0 && boxes[0].x1 <= srcW)
})

test('ctcGreedyDecode collapses repeats, separates identical chars across blank, and handles logits', () => {
    const vocab = ['', '2', '0', '8', ' ']
    const C = vocab.length
    const T = 10
    // Sequence: '2' (t=1,2), blank (t=3), '0' (t=4), blank (t=5), '0' (t=6), '8' (t=7), pad blank (t=8,9)
    const seq = [0, 1, 1, 0, 2, 0, 2, 3, 1, 1]
    const logits = new Float32Array(T * C).fill(-5)
    for (let t = 0; t < T; t++) {
        logits[t * C + seq[t]] = 6
    }

    // validRatio = 0.8 ignores t=8,9 padding
    const decoded = ctcGreedyDecode(logits, T, C, vocab, 0.8)
    assert.equal(decoded.text, '2008')
    assert.equal(decoded.effectiveTimesteps, 8)
    assert.equal(decoded.charTimesteps.length, 4)
    assert.deepEqual(decoded.charTimesteps[0], { char: '2', startT: 1, endT: 2, score: decoded.charTimesteps[0].score })
    assert.equal(decoded.charTimesteps[1].startT, 4)
    assert.equal(decoded.charTimesteps[2].startT, 6)
    assert.equal(decoded.charTimesteps[3].startT, 7)
    assert.ok(decoded.confidence > 0.99)
})

test('projectCharRects generates non-overlapping directional boxes for horizontal & vertical text', () => {
    const steps = [
        { char: '道', startT: 1, endT: 2 },
        { char: '德', startT: 4, endT: 5 },
        { char: '經', startT: 7, endT: 8 }
    ]

    const hRects = projectCharRects([100, 50, 220, 80], steps, 10, false)
    assert.equal(hRects.length, 3)
    assert.ok(hRects[0][0] < hRects[1][0] && hRects[1][0] < hRects[2][0])
    assert.equal(hRects[0][1], 50)
    assert.equal(hRects[0][3], 80)

    const vRects = projectCharRects([300, 100, 324, 300], steps, 10, true)
    assert.equal(vRects.length, 3)
    assert.ok(vRects[0][1] < vRects[1][1] && vRects[1][1] < vRects[2][1])
    assert.equal(vRects[0][0], 300)
    assert.equal(vRects[0][2], 324)
})

test('sortOcrSpansByReadingOrder & formatOcrSpansToText handle Traditional vertical right-to-left columns', () => {
    // Classic vertical Chinese book: Col1 on right (x=420..448), Col2 on middle (x=360..388), Col3 on left (x=300..328)
    const verticalSpans = [
        { text: '名', rect: [300, 260, 328, 390], vertical: true },
        { text: '之', rect: [360, 100, 388, 230], vertical: true },
        { text: '道可道', rect: [420, 100, 448, 250], vertical: true },
        { text: '非恆名', rect: [300, 400, 328, 540], vertical: true },
        { text: '非常道', rect: [420, 270, 448, 420], vertical: true },
        { text: '可名', rect: [360, 250, 388, 390], vertical: true }
    ]

    assert.equal(detectPageDirection(verticalSpans, 'auto'), 'vertical')
    const ordered = sortOcrSpansByReadingOrder(verticalSpans, { direction: 'auto' })
    assert.equal(ordered.direction, 'vertical')
    const txt = formatOcrSpansToText(verticalSpans, { direction: 'auto' })
    assert.equal(txt, '道可道非常道\n之可名\n名非恆名')
})

test('sortOcrSpansByReadingOrder handles two-column academic pages cleanly', () => {
    const spans = [
        { text: 'Paper Header Title', rect: [60, 30, 540, 55] },
        { text: 'Left A1', rect: [60, 100, 260, 120] },
        { text: 'Right B1', rect: [330, 100, 530, 120] },
        { text: 'Left A2', rect: [60, 130, 260, 150] },
        { text: 'Right B2', rect: [330, 130, 530, 150] },
        { text: 'Left A3', rect: [60, 160, 260, 180] },
        { text: 'Right B3', rect: [330, 160, 530, 180] },
        { text: 'Page Footer 1', rect: [240, 740, 350, 760] }
    ]
    const text = formatOcrSpansToText(spans, { direction: 'horizontal' })
    assert.deepEqual(
        text.split('\n'),
        ['Paper Header Title', 'Left A1', 'Left A2', 'Left A3', 'Right B1', 'Right B2', 'Right B3', 'Page Footer 1']
    )
})

test('buildOcrCharEntries builds vertical & explicit charRects quads accurately', () => {
    const chars = buildOcrCharEntries([
        {
            text: '天地',
            rect: [100, 40, 120, 120],
            vertical: true,
            charRects: [[100, 42, 120, 75], [100, 82, 120, 118]],
            line: 0
        },
        {
            text: 'AB',
            rect: [50, 140, 90, 160],
            vertical: false,
            line: 1
        }
    ])
    assert.equal(chars.length, 4)
    assert.deepEqual(chars[0], { text: '天', line: 0, size: 20, quad: [100, 42, 120, 42, 100, 75, 120, 75] })
    assert.deepEqual(chars[1], { text: '地', line: 0, size: 20, quad: [100, 82, 120, 82, 100, 118, 120, 118] })
    assert.deepEqual(chars[2], { text: 'A', line: 1, size: 20, quad: [50, 140, 70, 140, 50, 160, 70, 160] })
    assert.deepEqual(chars[3], { text: 'B', line: 1, size: 20, quad: [70, 140, 90, 140, 70, 160, 90, 160] })
})

test('sanitizeAdvancedSettings validates OCR settings & classifyLocalOcrAssetFile maps file names', () => {
    assert.equal(DEFAULT_ADVANCED_SETTINGS.ocrEngine, 'auto')
    assert.equal(DEFAULT_ADVANCED_SETTINGS.ocrBackend, 'auto')
    assert.equal(DEFAULT_ADVANCED_SETTINGS.ocrDirection, 'auto')

    const sanitized = sanitizeAdvancedSettings({
        ocrEngine: 'ppocrv6-small',
        ocrBackend: 'webgpu',
        ocrDirection: 'vertical',
        ocrUseMirror: true,
        ocrIdlePrefetch: false
    })
    assert.equal(sanitized.ocrEngine, 'ppocrv6-small')
    assert.equal(sanitized.ocrBackend, 'webgpu')
    assert.equal(sanitized.ocrDirection, 'vertical')
    assert.equal(sanitized.ocrUseMirror, true)
    assert.equal(sanitized.ocrIdlePrefetch, false)

    const fallbackSanitized = sanitizeAdvancedSettings({
        ocrEngine: 'invalid_engine',
        ocrBackend: 'cuda',
        ocrDirection: 'diagonal'
    })
    assert.equal(fallbackSanitized.ocrEngine, 'auto')
    assert.equal(fallbackSanitized.ocrBackend, 'auto')
    assert.equal(fallbackSanitized.ocrDirection, 'auto')

    assert.deepEqual(classifyLocalOcrAssetFile('PP-OCRv6_small_det.onnx'), { target: 'model', assetName: 'det.onnx' })
    assert.deepEqual(classifyLocalOcrAssetFile('PP-OCRv6_small_rec.onnx'), { target: 'model', assetName: 'rec.onnx' })
    assert.deepEqual(classifyLocalOcrAssetFile('inference.yml'), { target: 'model', assetName: 'rec.yml' })
    assert.deepEqual(classifyLocalOcrAssetFile('ppocrv6_dict.txt'), { target: 'model', assetName: 'rec.yml' })
    assert.deepEqual(classifyLocalOcrAssetFile('ort-wasm-simd-threaded.jsep.wasm'), {
        target: 'runtime',
        assetName: 'ort-wasm-simd-threaded.jsep.wasm'
    })
    assert.equal(classifyLocalOcrAssetFile('random.json'), null)
})

test('OcrService resolves to tesseract fallback cleanly when ONNX environment or models are absent', async () => {
    const svc = new OcrService()
    svc.configure({ engine: 'auto', backend: 'auto', direction: 'vertical' })
    assert.deepEqual(svc.getConfig(), { engine: 'auto', backend: 'auto', direction: 'vertical' })
    const resolved = await svc.resolveEffectiveEngine('ppocrv6-small')
    assert.equal(resolved.engine, 'tesseract')
    assert.ok(resolved.fallbackReason)
})

test('PdfToolsController _scheduleOcrIdlePrefetch registers timer only when active flags are clear', () => {
    const mockApp = {
        currentBookId: 'book-1',
        currentBookData: { format: 'pdf', documentHash: 'hash1' },
        _currentBookEpoch: 1,
        pdfViewport: { currentPage: 0, numPages: 5, _destroyed: false },
        pdfDriver: { numPages: 5 },
        advancedSettings: { config: { ocrIdlePrefetch: true } }
    }
    const ctrl = new PdfToolsController(mockApp)
    ctrl._isPageOcrRunning = true
    ctrl._scheduleOcrIdlePrefetch(0, 'ppocrv6-small', 'auto')
    assert.equal(ctrl._ocrPrefetchTimer, null, 'Should not arm prefetch while _isPageOcrRunning is true')

    ctrl._isPageOcrRunning = false
    ctrl._scheduleOcrIdlePrefetch(0, 'ppocrv6-small', 'auto')
    assert.ok(ctrl._ocrPrefetchTimer != null, 'Should arm idle prefetch timer once active OCR finishes')
    ctrl._cancelOcrIdlePrefetch()
    assert.equal(ctrl._ocrPrefetchTimer, null)
})

test('Vendored ONNX Runtime glue and Rust command wiring exist', () => {
    const ortJs = path.join(ROOT, 'vendor', 'onnxruntime', 'ort.webgpu.min.mjs')
    const jsepJs = path.join(ROOT, 'vendor', 'onnxruntime', 'ort-wasm-simd-threaded.jsep.mjs')
    assert.ok(fs.existsSync(ortJs) && fs.statSync(ortJs).size > 20000)
    assert.ok(fs.existsSync(jsepJs) && fs.statSync(jsepJs).size > 20000)

    const libRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8')
    for (const cmd of [
        'ocr_model_list_status',
        'ocr_model_download',
        'ocr_model_cancel_download',
        'ocr_model_get_download_progress',
        'ocr_model_read_asset',
        'ocr_model_write_asset',
        'ocr_model_delete'
    ]) {
        assert.ok(libRs.includes(cmd), `Missing Rust command ${cmd} in src-tauri/src/lib.rs`)
    }
})
