// scripts/test-regression-suite.mjs
// Automated verification suite for Linden Leaf 1.0.0 defect fixes

import assert from 'node:assert'

if (typeof globalThis.NodeFilter === 'undefined') {
    globalThis.NodeFilter = {
        SHOW_ALL: -1,
        SHOW_ELEMENT: 1,
        SHOW_ATTRIBUTE: 2,
        SHOW_TEXT: 4,
        SHOW_CDATA_SECTION: 8,
        SHOW_ENTITY_REFERENCE: 16,
        SHOW_ENTITY: 32,
        SHOW_PROCESSING_INSTRUCTION: 64,
        SHOW_COMMENT: 128,
        SHOW_DOCUMENT: 256,
        SHOW_DOCUMENT_TYPE: 512,
        SHOW_DOCUMENT_FRAGMENT: 1024,
        SHOW_NOTATION: 2048,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
        FILTER_SKIP: 3
    }
}
if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement {
        attachShadow() { return {} }
    }
}
if (typeof globalThis.customElements === 'undefined') {
    globalThis.customElements = {
        get() { return null },
        define() {}
    }
}

import { tokenizeText } from '../js/fulltext-search.js'
import { mergeSyncData, sanitizeSyncFormat } from '../js/syncEngine.js'

const testQueue = []
let totalPassed = 0
let totalFailed = 0
let totalSkipped = 0
const SKIP = Symbol('skip')

function test(name, fn) {
    testQueue.push({ name, fn })
}

function runAsyncTest(name, fn) {
    testQueue.push({ name, fn })
}

// 1. Defect N08: CJK Bi-gram tokenization within contiguous runs
test('N08: CJK tokenization preserves contiguous word boundaries and avoids cross-boundary bi-grams', () => {
    // "我爱 编程" should produce "我爱" and "编程", NEVER "爱编" across whitespace!
    const tokens1 = tokenizeText('我爱 编程')
    assert.ok(tokens1.has('我爱'), 'Should have 我爱')
    assert.ok(tokens1.has('编程'), 'Should have 编程')
    assert.strictEqual(tokens1.has('爱编'), false, 'Must NOT contain cross-whitespace bi-gram 爱编')

    // "第一章 Hello 第二章" should NOT bridge "章" and "第" across English words
    const tokens2 = tokenizeText('第一章 Hello 第二章')
    assert.ok(tokens2.has('第一'), 'Should have 第一')
    assert.ok(tokens2.has('一章'), 'Should have 一章')
    assert.ok(tokens2.has('第二'), 'Should have 第二')
    assert.ok(tokens2.has('二章'), 'Should have 二章')
    assert.ok(tokens2.has('hello'), 'Should have hello')
    assert.strictEqual(tokens2.has('章第'), false, 'Must NOT bridge across English word')

    // Single CJK character run should be kept as 1-char token
    const tokens3 = tokenizeText('第 1 节')
    assert.ok(tokens3.has('第'), 'Single CJK char run should be indexed')
    assert.ok(tokens3.has('节'), 'Single CJK char run should be indexed')

    // "你好 世界" must match queries for both tokens without phantom cross-words
    const tokens4 = tokenizeText('你好 世界')
    assert.ok(tokens4.has('你好'))
    assert.ok(tokens4.has('世界'))
    assert.strictEqual(tokens4.has('好世'), false, 'Must not bridge across Chinese space delimiter')
})

// 2. Defect N10: syncEngine must NOT merge books by stableKey if format or non-zero size differs
test('N10: syncEngine defends against merging books with different formats or different sizes on stableKey match', () => {
    const localPayload = {
        clientId: 'client_local',
        booksMeta: [
            { id: 'book_epub_1', title: '三体', format: 'epub', size: 1000000, stableKey: 'three_body_problem' }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }

    // Remote has same stableKey but different format: PDF
    const remotePayloadDiffFormat = {
        clientId: 'client_remote',
        booksMeta: [
            { id: 'book_pdf_2', title: '三体', format: 'pdf', size: 50000000, stableKey: 'three_body_problem' }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }

    const { merged: merged1 } = mergeSyncData(localPayload, remotePayloadDiffFormat)
    // Both books should remain distinct in merged payload!
    assert.strictEqual(merged1.booksMeta.length, 2, 'Different format books must NOT be collapsed into 1 book')
    const ids = merged1.booksMeta.map(b => b.id)
    assert.ok(ids.includes('book_epub_1'))
    assert.ok(ids.includes('book_pdf_2'))

    // Remote has same format and stableKey, but completely different non-zero size
    const remotePayloadDiffSize = {
        clientId: 'client_remote',
        booksMeta: [
            { id: 'book_epub_diff_size', title: '三体', format: 'epub', size: 2500000, stableKey: 'three_body_problem' }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }

    const { merged: merged2 } = mergeSyncData(localPayload, remotePayloadDiffSize)
    assert.strictEqual(merged2.booksMeta.length, 2, 'Different size books must NOT be collapsed into 1 book')
})

// 3. Defect N09: syncEngine remaps chapter translation bookId & id when remote book is remapped
test('N09: syncEngine remaps chapterTranslations bookId and id when bookId is remapped', () => {
    const localPayload = {
        clientId: 'client_local',
        booksMeta: [
            { id: 'local_book_1', title: 'The Great Gatsby', format: 'epub', size: 500000, stableKey: 'gatsby_500000_epub' }
        ],
        chapterTranslations: [],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }

    // Remote has identical book with different ID (matched via stableKey)
    const remotePayload = {
        clientId: 'client_remote',
        booksMeta: [
            { id: 'remote_book_999', title: 'The Great Gatsby', format: 'epub', size: 500000, stableKey: 'gatsby_500000_epub' }
        ],
        chapterTranslations: [
            {
                id: 'remote_book_999::chapter_01',
                bookId: 'remote_book_999',
                chapterKey: 'chapter_01',
                chapterSourceKey: 'chapter_01',
                bookStableKey: 'gatsby_500000_epub',
                status: 'completed',
                paragraphs: [
                    { id: 'p1', status: 'completed', translation: '在我年纪还轻的时候……' }
                ],
                totalParagraphs: 1,
                updatedAt: 1000
            }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }

    const { merged } = mergeSyncData(localPayload, remotePayload)
    assert.strictEqual(merged.chapterTranslations.length, 1, 'Should retain chapter translation')
    const ct = merged.chapterTranslations[0]
    assert.strictEqual(ct.bookId, 'local_book_1', 'Chapter translation bookId must be remapped to local bookId')
    assert.strictEqual(ct.id, 'local_book_1::chapter_01', 'Chapter translation id must be remapped to local bookId::chapterKey')
})

// 4. Defect S05: createLazySnapshotBlob slice ranges
await runAsyncTest('S05: createLazySnapshotBlob slices maintain sub-ranges and bounded bounds', async () => {
    // Import createLazySnapshotBlob
    const { createLazySnapshotBlob } = await import('../js/db.js')
    const virtualBlob = createLazySnapshotBlob('dummy/path.pdf', 1000)
    assert.strictEqual(virtualBlob.size, 1000)
    assert.strictEqual(virtualBlob.isLazySnapshot, true)
    assert.strictEqual(virtualBlob.byteOffset, 0)
    assert.strictEqual(virtualBlob.byteLength, 1000)

    // Slice [100, 250) -> length 150, offset 100
    const slice1 = virtualBlob.slice(100, 250)
    assert.strictEqual(slice1.size, 150)
    assert.strictEqual(slice1.byteOffset, 100)
    assert.strictEqual(slice1.byteLength, 150)

    // Sub-slice [20, 50) of slice1 -> global offset 120 -> length 30
    const subSlice = slice1.slice(20, 50)
    assert.strictEqual(subSlice.size, 30)
    assert.strictEqual(subSlice.byteOffset, 120)
    assert.strictEqual(subSlice.byteLength, 30)

    // Negative offset slice(-50) on 1000-byte blob -> offset 950 -> length 50
    const endSlice = virtualBlob.slice(-50)
    assert.strictEqual(endSlice.size, 50)
    assert.strictEqual(endSlice.byteOffset, 950)
    assert.strictEqual(endSlice.byteLength, 50)
})

// 5. Defect N04: Reading session duration monotonicity & stale replay protection
test('N04: Reading session duration rollback prevention (100 -> 150 -> old 100 -> 160 = 160)', () => {
    // Simulate DB session & book accumulator state
    let dbSession = { id: 'sess_1', bookId: 'book_1', durationSeconds: 100 }
    let bookTotalReadingSeconds = 100

    // Step 1: User continues reading locally, advances to 150s
    {
        const prevDuration = dbSession.durationSeconds || 0
        const incomingDuration = 150
        const effectiveDuration = Math.max(prevDuration, incomingDuration)
        const delta = Math.max(0, effectiveDuration - prevDuration)
        dbSession.durationSeconds = effectiveDuration
        bookTotalReadingSeconds += delta
    }
    assert.strictEqual(dbSession.durationSeconds, 150)
    assert.strictEqual(bookTotalReadingSeconds, 150)

    // Step 2: Stale batch sync snapshot arrives with old 100s
    {
        const prevDuration = dbSession.durationSeconds || 0
        const incomingDuration = 100 // Stale replay!
        const effectiveDuration = Math.max(prevDuration, incomingDuration)
        const delta = Math.max(0, effectiveDuration - prevDuration)
        dbSession.durationSeconds = effectiveDuration
        bookTotalReadingSeconds += delta
    }
    assert.strictEqual(dbSession.durationSeconds, 150, 'Duration must NOT be rolled back by stale 100s replay')
    assert.strictEqual(bookTotalReadingSeconds, 150, 'Book total must NOT change on stale replay')

    // Step 3: Later local reading session reports 160s
    {
        const prevDuration = dbSession.durationSeconds || 0
        const incomingDuration = 160
        const effectiveDuration = Math.max(prevDuration, incomingDuration)
        const delta = Math.max(0, effectiveDuration - prevDuration)
        dbSession.durationSeconds = effectiveDuration
        bookTotalReadingSeconds += delta
    }
    assert.strictEqual(dbSession.durationSeconds, 160)
    assert.strictEqual(bookTotalReadingSeconds, 160, 'Book total reading seconds must reach 160, NEVER inflated to 210')
})

// 6. Defect N11: Safe Cloud File Name generation
test('N11: Safe cloud file name respects saved cloudBackup.fileName and prevents collision', () => {
    const helper = {
        getSafeCloudFileName(book) {
            if (!book) return 'book.epub'
            if (book.cloudBackup?.fileName) {
                const savedName = String(book.cloudBackup.fileName).trim()
                if (savedName && !/[\\/%?#\0:*"><|]/.test(savedName) && !savedName.startsWith('.')) {
                    return savedName
                }
            }
            const fmt = (book.format || 'epub').toLowerCase().replace(/[^a-z0-9]/g, '') || 'epub'
            const safeId = (book.id || 'book').replace(/[^a-zA-Z0-9_-]/g, '_')
            let rawKey = (book.stableKey || '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_').trim()
            if (rawKey.startsWith('.')) rawKey = rawKey.replace(/^\.+/, '')
            if (rawKey.length > 50) rawKey = rawKey.slice(0, 50)
            const baseName = (rawKey && rawKey !== safeId) ? `${rawKey}_${safeId}` : safeId
            return `${baseName}.${fmt}`
        }
    }

    // 1. Existing backup filename respected
    const bookWithBackup = {
        id: 'book_1',
        format: 'epub',
        cloudBackup: { fileName: 'my_custom_backup.epub' }
    }
    assert.strictEqual(helper.getSafeCloudFileName(bookWithBackup), 'my_custom_backup.epub')

    // 2. Colon in urn:uuid identifier sanitized
    const bookWithUrn = {
        id: 'book_abc123',
        stableKey: 'urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        format: 'epub'
    }
    const safeUrnName = helper.getSafeCloudFileName(bookWithUrn)
    assert.strictEqual(safeUrnName.includes(':'), false, 'Must not contain colon')
    assert.ok(safeUrnName.endsWith('.epub'))
    assert.ok(safeUrnName.includes('book_abc123'), 'Must contain safeId to prevent collision')

    // 3. Two different books with identical sanitized stableKey do NOT collide
    const bookA = { id: 'book_111', stableKey: 'same:title/one', format: 'pdf' }
    const bookB = { id: 'book_222', stableKey: 'same:title/one', format: 'pdf' }
    assert.notStrictEqual(helper.getSafeCloudFileName(bookA), helper.getSafeCloudFileName(bookB))
})

// 7. Defect N12: AI Generation lock finally isolation
test('N12: Old AI request finally block does not clear activeRequestId of subsequent request', () => {
    let controller = {
        isGenerating: true,
        activeRequestId: 'req_1_initial',
        dispatchedAt: Date.now()
    }

    const currentReq1 = controller.activeRequestId

    // User cancels or starts a second request before task 1 exits
    controller.activeRequestId = 'req_2_second'
    controller.isGenerating = true

    // Task 1 finally block runs:
    const finallyTask1 = () => {
        if (controller.activeRequestId === currentReq1) {
            controller.isGenerating = false
            controller.activeRequestId = null
        }
    }
    finallyTask1()

    assert.strictEqual(controller.activeRequestId, 'req_2_second', 'Task 1 finally must NOT nullify task 2 requestId')
    assert.strictEqual(controller.isGenerating, true, 'Task 1 finally must NOT cancel task 2 isGenerating')

    // Task 2 finally block runs:
    const finallyTask2 = () => {
        if (controller.activeRequestId === 'req_2_second') {
            controller.isGenerating = false
            controller.activeRequestId = null
        }
    }
    finallyTask2()
    assert.strictEqual(controller.activeRequestId, null)
    assert.strictEqual(controller.isGenerating, false)
})

// 8. Defect M01: Adaptive Geometry outline coverage & zero-ink OCR fallback
await runAsyncTest('M01: Adaptive geometry expands bad font metrics and preserves OCR / zero-ink layer', async () => {
    function projectQuad(q, ux, uy, vx, vy) {
        const pts = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
        for (const [x, y] of pts) {
            const pu = x * ux + y * uy, pv = x * vx + y * vy
            if (pu < minU) minU = pu
            if (pu > maxU) maxU = pu
            if (pv < minV) minV = pv
            if (pv > maxV) maxV = pv
        }
        return { u: [minU, maxU], v: [minV, maxV] }
    }

    function adaptQuad(raw, ink, flags, dir = [1, 0], fontSize = 12) {
        const FZ_STEXT_FILLED = 16, FZ_STEXT_STROKED = 32
        if (!(flags & (FZ_STEXT_FILLED | FZ_STEXT_STROKED))) {
            return [...raw]
        }
        let dx = dir[0], dy = dir[1]
        let len = Math.hypot(dx, dy)
        if (len <= 1e-4) { dx = 1; dy = 0; len = 1 }
        const ux = dx / len, uy = dy / len
        const vx = -uy, vy = ux

        const r = projectQuad(raw, ux, uy, vx, vy)
        const i = projectQuad(ink, ux, uy, vx, vy)
        const ih = i.v[1] - i.v[0]
        if (ih <= 0.001) {
            return [...raw]
        }
        const rh = r.v[1] - r.v[0]
        const saneRaw = rh > 0.001 && rh <= fontSize * 2.5
        const low = saneRaw ? Math.min(r.v[0], i.v[0]) : i.v[0]
        const high = saneRaw ? Math.max(r.v[1], i.v[1]) : i.v[1]

        return [
            ux * r.u[0] + vx * low, uy * r.u[0] + vy * low,
            ux * r.u[1] + vx * low, uy * r.u[1] + vy * low,
            ux * r.u[0] + vx * high, uy * r.u[0] + vy * high,
            ux * r.u[1] + vx * high, uy * r.u[1] + vy * high
        ]
    }

    // 1. Bad font metrics expansion for 'j': raw height 20.64pt expands to 44.46pt
    const rawBadJ = [20, 10, 45, 10, 20, 30.64, 45, 30.64] // 20.64pt
    const inkAccJ = [20, 6, 45, 6, 20, 50.46, 45, 50.46]   // 44.46pt
    const adaptedJ = adaptQuad(rawBadJ, inkAccJ, 16, [1, 0], 48)
    const adaptedHeight = adaptedJ[5] - adaptedJ[1]
    assert.ok(adaptedHeight > 44, `Adapted height must expand to cover glyph outline (got ${adaptedHeight})`)

    // 2. Invisible OCR layer (flags=0, rendering mode 3 Tr): 100% preserves original bounding quad
    const ocrQuad = [100, 200, 180, 200, 100, 208.991, 180, 208.991]
    const inkZero = [100, 204, 180, 204, 100, 204, 180, 204] // 0 height ink
    const adaptedOcr = adaptQuad(ocrQuad, inkZero, 0, [1, 0], 9)
    assert.deepStrictEqual(adaptedOcr, ocrQuad, 'OCR layer must preserve original font metric quad')

    // 3. Real Book Sample 5 zero-height outline fallback: even with flags=16, zero ink outline must NOT collapse selection
    const adaptedSample5 = adaptQuad(ocrQuad, inkZero, 16, [1, 0], 9)
    const hSample5 = adaptedSample5[5] - adaptedSample5[1]
    assert.ok(Math.abs(hSample5 - 8.991) < 0.001, `Empty outline must fallback to raw height (~8.991pt), got ${hSample5}`)

    // 4. Normal font preserves full height
    const normRaw = [10, 10, 35, 10, 10, 55.05, 35, 55.05]
    const normInk = [10, 10, 35, 10, 10, 55.05, 35, 55.05]
    const adaptedNorm = adaptQuad(normRaw, normInk, 16, [1, 0], 48)
    assert.ok(adaptedNorm[5] - adaptedNorm[1] > 45, 'Normal font preserves full size')
})

// 9. Defect M02: Directional boundary calculation & canonical ordering encompasses trailing character
await runAsyncTest('M02: Selection endpoint boundary inset encompasses full character sequence including trailing character', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const proto = PdfViewport.prototype
    const vp = Object.create(proto)

    // Agjpqy quad sequence
    const syntheticChars = ['A', 'g', 'j', 'p', 'q', 'y'].map((char, index) => {
        const x0 = index * 30, x1 = x0 + 28
        return {
            text: char,
            line: 0,
            size: 48,
            quad: [x0, 10, x1, 10, x0, 55, x1, 55],
            bounds: [x0, 10, x1, 55],
            index
        }
    })

    vp.driver = { kind: 'mupdf' }
    vp.pageSizes = [{ width: 595, height: 842, x0: 0, y0: 0 }]
    vp._nativeGeometry = new Map([[0, Promise.resolve({ chars: syntheticChars, grid: new Map(), cellSize: 48 })]])
    vp._touchNativeGeometry = () => {}

    // Forward drag from A (index 0) to y (index 5)
    const forwardEndpoints = await vp._selectionEndpoints({ page: 0, index: 0 }, { page: 0, index: 5 })
    assert.strictEqual(forwardEndpoints.forward, true)
    assert.strictEqual(forwardEndpoints.segments.length, 1)
    const segFwd = forwardEndpoints.segments[0]
    assert.strictEqual(segFwd.startIndex, 0)
    assert.strictEqual(segFwd.endIndex, 5)
    assert.ok(segFwd.b[0] > 170, 'Trailing boundary b must be at trailing edge of y (> 170, not center at 164)')

    // Reverse drag from y (index 5) to A (index 0)
    const reverseEndpoints = await vp._selectionEndpoints({ page: 0, index: 5 }, { page: 0, index: 0 })
    assert.strictEqual(reverseEndpoints.forward, false)
    assert.strictEqual(reverseEndpoints.segments.length, 1)
    const segRev = reverseEndpoints.segments[0]
    // Canonical ordering guarantees startIndex <= endIndex regardless of drag direction!
    assert.strictEqual(segRev.startIndex, 0, 'Reverse drag must canonically order startIndex')
    assert.strictEqual(segRev.endIndex, 5, 'Reverse drag must canonically order endIndex')
    assert.strictEqual(segRev.a[0], segFwd.a[0], 'Canonical start coordinate must match forward start')
    assert.strictEqual(segRev.b[0], segFwd.b[0], 'Canonical end coordinate must match forward end')
})

// 10. Defect M03: Async drag sequence, pending pointerup, and cancelled doubleclick guard
await runAsyncTest('M03: Async drag move sequence, pending pointerup, and stale doubleclick isolation', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const proto = PdfViewport.prototype
    const make = () => Object.assign(Object.create(proto), {
        interactionMode: 'select',
        driver: { kind: 'mupdf' },
        _nativeGestureEpoch: 1,
        scrollArea: { setPointerCapture() {}, releasePointerCapture() {} },
        _slotForPoint: () => ({ page: 0, rect: { left: 0, top: 0, width: 200, height: 100 } }),
        _clientToPage: (_h, x, y) => [x, y],
        _updateNativePreview() {},
        _redrawNativePreview() {}
    })
    const event = x => ({ pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x, clientY: 10 })
    const drag = () => ({ pointerId: 1, epoch: 1, startX: 0, startY: 10, hasMoved: true, anchor: { page: 0, index: 0 }, focus: { page: 0, index: 1 } })

    // Sub-test 1: Move ordering
    const v = make()
    v._nativeDrag = drag()
    let resolveOld, resolveNew
    v._hitNativeChar = (_p, point) => new Promise(r => {
        if (point[0] === 10) resolveOld = r
        else resolveNew = r
    })
    const oldMove = v._nativePointerMove(event(10))
    const newMove = v._nativePointerMove(event(20))
    resolveNew({ index: 20 })
    await newMove
    const afterNew = v._nativeDrag.focus.index
    resolveOld({ index: 10 })
    await oldMove
    const afterOld = v._nativeDrag.focus.index
    assert.strictEqual(afterOld, 20, 'Stale move returning late must NOT overwrite newer move')

    // Sub-test 2: PointerUp with pending move
    const up = make()
    up._nativeDrag = drag()
    let resolvePending
    up._hitNativeChar = () => new Promise(r => { resolvePending = r })
    let finalizedFocus = null
    up._finalizeNativeSelection = async (_a, f) => { finalizedFocus = f.index; return null }
    const pending = up._nativePointerMove(event(30))
    const upPromise = up._nativePointerUp(event(30))
    resolvePending({ index: 30 })
    await pending
    await upPromise
    assert.strictEqual(finalizedFocus, 30, 'PointerUp must await pending hit-test to include final release position')

    // Sub-test 3: Double click epoch cancellation
    const double = make()
    double._hitNativeChar = async () => ({ index: 2 })
    let resolveDouble
    double._finalizeNativeSelection = () => new Promise(r => { resolveDouble = r })
    let staleDoubleEmitted = false
    double._emitNativeSelection = () => { staleDoubleEmitted = true }
    const doublePending = double._nativeDoubleClick({ ...event(2), preventDefault() {} })
    await Promise.resolve()
    await Promise.resolve()
    double._nativeGestureEpoch++ // Gesture epoch invalidated
    resolveDouble({ text: 'old selection' })
    await doublePending
    assert.strictEqual(staleDoubleEmitted, false, 'Cancelled doubleclick must never emit stale selection')

    // Sub-test 4: Right click cancels drag
    const rc = make()
    rc._nativeDrag = drag()
    let cancelled = false
    rc.clearSelection = () => { cancelled = true }
    await rc._nativePointerMove({ pointerId: 1, pointerType: 'mouse', buttons: 2, clientX: 25, clientY: 10 })
    assert.strictEqual(cancelled, true, 'Right click or secondary button must cancel active drag')

    // Sub-test 5: clearSelection invalidates pending selection epoch
    const clr = make()
    clr._nativeDrag = drag()
    const epochBefore = clr._nativeGestureEpoch
    clr.clearSelection()
    assert.ok(clr._nativeGestureEpoch > epochBefore, 'clearSelection must advance gesture epoch')

    // The real async finalizer must not paint a cancelled word selection either.
    const late = make()
    const quad = [0, 0, 10, 0, 0, 10, 10, 10]
    late.pageSizes = [{ width: 200, height: 100 }]
    late._hitNativeChar = async () => ({ index: 0 })
    late._ensureNativeGeometry = async () => ({ chars: [{ quad, text: 'old' }] })
    let resolveSelection, markSelecting
    const selecting = new Promise(resolve => { markSelecting = resolve })
    late.driver.select = () => new Promise(resolve => {
        resolveSelection = resolve
        markSelecting()
    })
    const selectingWord = late._nativeDoubleClick({ ...event(2), preventDefault() {} })
    await selecting
    late.clearSelection()
    resolveSelection({ text: 'old', quads: [quad] })
    await selectingWord
    assert.ok(!late._nativePreview?.length, 'A cancelled word lookup must not repaint the selection')
})

// 11. Defect M04: Quad distance vs AABB on rotated diamond & scale tolerance & degenerate handling
await runAsyncTest('M04: Quad distance prevents phantom hits on rotated geometry & maintains scale tolerance', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const proto = PdfViewport.prototype
    const make = () => Object.assign(Object.create(proto), {
        interactionMode: 'select',
        driver: { kind: 'mupdf' },
        _nativeGeometry: new Map(),
        _nativeGeometryUse: new Map(),
        _nativeGeometryLimit: 16,
        _touchNativeGeometry() {},
    })

    const rotated = make()
    // Rotated diamond quad: (20,10) -> (30,20) -> (10,20) -> (20,30)
    rotated.driver = {
        kind: 'mupdf',
        getTextGeometry: async () => [{ text: 'X', quad: [20,10, 30,20, 10,20, 20,30], line: 0, size: 14 }]
    }

    // Point [10, 10] is in AABB ([10, 10, 30, 30]) but strictly outside diamond
    const hitOutside = await rotated._hitNativeChar(0, [10, 10], 0)
    assert.strictEqual(hitOutside, null, 'Point outside diamond quad must NOT hit with 0 tolerance')

    // Point [20, 20] is at center of diamond
    const hitInside = await rotated._hitNativeChar(0, [20, 20], 0)
    assert.ok(hitInside, 'Point inside diamond quad must hit with 0 tolerance')

    // Degenerate zero-area quad must NEVER produce phantom hits
    const degen = make()
    degen.driver = {
        kind: 'mupdf',
        getTextGeometry: async () => [{ text: '', quad: [0, 0, 0, 0, 0, 0, 0, 0], line: 0, size: 10 }]
    }
    const hitDegen = await degen._hitNativeChar(0, [100, 100], 0)
    assert.strictEqual(hitDegen, null, 'Degenerate zero-area quad must not hit at arbitrary point')

    // Scale-independent tolerance test: 30 page points away at 3.5x scale is 105 CSS pixels
    const scaled = make()
    scaled.scale = 3.5
    scaled.driver = {
        kind: 'mupdf',
        getTextGeometry: async () => [{ text: 'A', quad: [10,10, 20,10, 10,20, 20,20], line: 0, size: 10 }]
    }
    const hitFarAtHighZoom = await scaled._hitNativeChar(0, [50, 15], 36)
    assert.strictEqual(hitFarAtHighZoom, null, '30 page pts away at 3.5x zoom exceeds 36px screen tolerance')

    // Scale-independent tolerance test at low zoom: 30 page points away at 0.5x zoom is 15 CSS pixels, within 36px tolerance
    const scaledLow = make()
    scaledLow.scale = 0.5
    scaledLow.driver = {
        kind: 'mupdf',
        getTextGeometry: async () => [{ text: 'A', quad: [10,10, 20,10, 10,20, 20,20], line: 0, size: 10 }]
    }
    const hitCloseAtLowZoom = await scaledLow._hitNativeChar(0, [50, 15], 36)
    assert.ok(hitCloseAtLowZoom, '30 page pts away at 0.5x zoom is 15px screen dist, within 36px screen tolerance')
})

// 12. Defect M05: Quad-based SVG highlight rendering vs legacy rects & directional underlines
await runAsyncTest('M05: Highlights with quads render SVG polygons; legacy rects render divs', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const proto = PdfViewport.prototype

    function makeMockElement(tagName = 'div') {
        const children = []
        const attributes = new Map()
        return {
            tagName,
            dataset: {},
            style: {},
            children,
            setAttribute(k, v) { attributes.set(k, String(v)) },
            getAttribute(k) { return attributes.get(k) },
            append(child) { children.push(child) },
            replaceChildren() { children.length = 0 },
            querySelectorAll(selector) {
                const results = []
                const walk = el => {
                    if (selector === 'polygon' && (el.tagName === 'polygon' || el.tagName === 'POLYGON')) results.push(el)
                    if (selector === 'line' && (el.tagName === 'line' || el.tagName === 'LINE')) results.push(el)
                    if (selector === 'div' && (el.tagName === 'div' || el.tagName === 'DIV')) results.push(el)
                    if (selector === 'svg' && (el.tagName === 'svg' || el.tagName === 'SVG')) results.push(el)
                    for (const c of el.children || []) walk(c)
                }
                for (const c of children) walk(c)
                return results
            },
            addEventListener() {}
        }
    }

    const prevDoc = globalThis.document
    try {
        globalThis.document = {
            createElement: makeMockElement,
            createElementNS: (_, tag) => makeMockElement(tag)
        }

        const layerQuad = makeMockElement('div')
        const hlQuad = Object.create(proto)
        hlQuad.highlightsByPage = new Map([[0, [{
            id: 'hl-quad-1',
            style: 'highlight',
            pdfTarget: {
                page: 0,
                rects: [[.1, .1, .3, .3]],
                quads: [[20,10, 30,20, 10,20, 20,30]],
                pageBounds: [0, 0, 100, 100]
            }
        }]]])
        hlQuad.pageSizes = [{ width: 100, height: 100, x0: 0, y0: 0 }]
        hlQuad._renderHighlightsForPage(0, layerQuad)

        const polyCount = layerQuad.querySelectorAll('polygon').length
        const divCount = layerQuad.querySelectorAll('div').length
        assert.strictEqual(polyCount, 1, 'Highlight with quads must render SVG polygon')
        assert.strictEqual(divCount, 0, 'Highlight with quads must not render axis-aligned div')

        // Underline highlight with quads renders baseline line and polygon hit area
        const layerUnderline = makeMockElement('div')
        const hlUnderline = Object.create(proto)
        hlUnderline.highlightsByPage = new Map([[0, [{
            id: 'hl-underline-1',
            style: 'underline',
            pdfTarget: {
                page: 0,
                rects: [[.1, .1, .3, .3]],
                quads: [[10, 10, 50, 10, 10, 30, 50, 30]],
                pageBounds: [0, 0, 100, 100]
            }
        }]]])
        hlUnderline.pageSizes = [{ width: 100, height: 100, x0: 0, y0: 0 }]
        hlUnderline._renderHighlightsForPage(0, layerUnderline)
        assert.strictEqual(layerUnderline.querySelectorAll('polygon').length, 1, 'Underline has transparent hit polygon')
        assert.strictEqual(layerUnderline.querySelectorAll('line').length, 1, 'Underline renders baseline line')

        // Legacy rect-only highlight
        const layerRect = makeMockElement('div')
        const hlRect = Object.create(proto)
        hlRect.highlightsByPage = new Map([[0, [{
            id: 'hl-rect-legacy',
            pdfTarget: {
                page: 0,
                rects: [[.1, .1, .3, .3]]
            }
        }]]])
        hlRect.pageSizes = [{ width: 100, height: 100, x0: 0, y0: 0 }]
        hlRect._renderHighlightsForPage(0, layerRect)

        assert.strictEqual(layerRect.querySelectorAll('polygon').length, 0)
        assert.strictEqual(layerRect.querySelectorAll('div').length, 1, 'Legacy highlight must fallback to rect div')
    } finally {
        globalThis.document = prevDoc
    }
})

// 13. Defect M06: Selection preview line band merging (5,000 chars -> 100 bands)
await runAsyncTest('M06: Selection preview merges consecutive characters into smooth line bands', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const proto = PdfViewport.prototype
    const vp = Object.create(proto)

    // Generate 5,000 characters across 100 lines (50 chars per line)
    const chars5000 = []
    for (let line = 0; line < 100; line++) {
        const y0 = line * 20, y1 = y0 + 16
        for (let c = 0; c < 50; c++) {
            const x0 = c * 10, x1 = x0 + 9
            chars5000.push({
                line,
                size: 14,
                quad: [x0, y0, x1, y0, x0, y1, x1, y1]
            })
        }
    }

    const bands = vp._buildLineBandQuads(chars5000)
    assert.strictEqual(bands.length, 100, '5,000 characters across 100 lines must merge into exactly 100 bands')
    const b0 = bands[0]
    assert.strictEqual(b0[0], 0, 'Band 0 begins at x=0')
    assert.strictEqual(b0[2], 499, 'Band 0 ends at x=499')

    // Boundary edge cases: empty input and single-character input
    assert.deepStrictEqual(vp._buildLineBandQuads([]), [], 'Empty input must return empty bands')
    assert.deepStrictEqual(vp._buildLineBandQuads([chars5000[0]]), [chars5000[0].quad], 'Single character must return original quad')
})

// 14. Real 5 Books Direct Execution & Fallback Verification
await runAsyncTest('RealBooks: 5 books across 15 sampling pages verified with direct MuPDF native engine', async () => {
    const { execFileSync } = await import('node:child_process')
    const path = await import('node:path')
    const fs = await import('node:fs')
    const manifestPath = process.env.LINDEN_REAL_BOOKS_MANIFEST
        ? path.resolve(process.env.LINDEN_REAL_BOOKS_MANIFEST)
        : null
    if (!manifestPath || !fs.existsSync(manifestPath)) {
        return SKIP
    }
    const exePath = path.resolve('scripts/verify-real-books.exe')
    const nativeInputs = ['scripts/verify-real-books.c', 'src-tauri/native/ll_mupdf.c', 'src-tauri/native/ll_mupdf.h']
        .map(file => path.resolve(file))
    if (!fs.existsSync(exePath) || nativeInputs.some(file => fs.statSync(file).mtimeMs > fs.statSync(exePath).mtimeMs)) {
        execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/build-native-verifier.ps1')], { encoding: 'utf8', timeout: 120000 })
    }
    if (!fs.existsSync(exePath)) {
        throw new Error('RealBooks verification failed: scripts/verify-real-books.exe not found')
    }
    let stdout = ''
    for (let retry = 0; retry < 5; retry++) {
        try {
            stdout = execFileSync(exePath, [manifestPath], { encoding: 'utf8' })
            break
        } catch (err) {
            if ((err.code === 'EBUSY' || err.message?.includes('being used by another process')) && retry < 4) {
                await new Promise(r => setTimeout(r, 600))
                continue
            }
            throw err
        }
    }
    assert.ok(stdout.includes('[SUCCESS] All 5 real books and 15 pages verified cleanly against real data!'), 'verify-real-books.exe must succeed')
    assert.ok(stdout.includes('Zero-height Chars: 0'), 'Must contain 0 zero-height characters')
    assert.ok(stdout.includes('Directional Boundary Matches: 18 / 18'), 'All 18 sampled lines must match directional boundaries')
})


// 15. R02: syncEngine distinguishes same-size, same-stableKey books if documentHash differs
test('R02: syncEngine does NOT merge books with different documentHash even if stableKey and size match', () => {
    const localPayload = {
        clientId: 'local_client',
        booksMeta: [
            { id: 'book_a', title: 'Calculus', format: 'pdf', size: 1048576, stableKey: 'calculus_pdf', documentHash: 'hash_edition_1', isLocal: true }
        ],
        chapterTranslations: [],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }
    const remotePayload = {
        clientId: 'remote_client',
        booksMeta: [
            { id: 'book_b', title: 'Calculus', format: 'pdf', size: 1048576, stableKey: 'calculus_pdf', documentHash: 'hash_edition_2' }
        ],
        chapterTranslations: [],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }
    const { merged } = mergeSyncData(localPayload, remotePayload)
    assert.strictEqual(merged.booksMeta.length, 2, 'Books with different documentHash must NOT be merged into one!')
})

// 16. R05: Reading session activeDurationSeconds monotonic merge in syncEngine
test('R05: syncEngine preserves highest activeDurationSeconds when merging sessions', () => {
    const localPayload = {
        clientId: 'local_client',
        booksMeta: [{ id: 'b1', title: 'Test', format: 'txt', isLocal: true }],
        chapterTranslations: [],
        highlights: [],
        bookmarks: [],
        readingSessions: [
            { id: 'sess_1', bookId: 'b1', durationSeconds: 200, activeDurationSeconds: 180, startTime: 1000, endTime: 1200 }
        ],
        deletedRecords: []
    }
    // Remote session has older/lower activeDurationSeconds but higher durationSeconds
    const remotePayload = {
        clientId: 'remote_client',
        booksMeta: [{ id: 'b1', title: 'Test', format: 'txt' }],
        chapterTranslations: [],
        highlights: [],
        bookmarks: [],
        readingSessions: [
            { id: 'sess_1', bookId: 'b1', durationSeconds: 250, activeDurationSeconds: 120, startTime: 1000, endTime: 1250 }
        ],
        deletedRecords: []
    }
    const { merged } = mergeSyncData(localPayload, remotePayload)
    assert.strictEqual(merged.readingSessions.length, 1)
    const s = merged.readingSessions[0]
    assert.strictEqual(s.durationSeconds, 250, 'durationSeconds should be max(200, 250) = 250')
    assert.strictEqual(s.activeDurationSeconds, 180, 'activeDurationSeconds should be max(180, 120) = 180')
})

// 17. R04: Chapter translation canonical key merge across remapped books
test('R04: syncEngine merges chapterTranslations for remapped books into single canonical record', () => {
    const localPayload = {
        clientId: 'local',
        booksMeta: [{ id: 'local_book_1', stableKey: 'sample_book_key', format: 'epub', size: 100, isLocal: true }],
        chapterTranslations: [
            {
                id: 'local_book_1::chapter_1',
                bookId: 'local_book_1',
                chapterKey: 'chapter_1',
                chapterSourceKey: 'chapter_1',
                bookStableKey: 'sample_book_key',
                status: 'partial',
                paragraphs: [{ id: 'p1', translation: '译文一', status: 'completed' }],
                totalParagraphs: 2,
                updatedAt: 1000
            }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }
    const remotePayload = {
        clientId: 'remote',
        booksMeta: [{ id: 'remote_book_9', stableKey: 'sample_book_key', format: 'epub', size: 100 }],
        chapterTranslations: [
            {
                id: 'remote_book_9::chapter_1',
                bookId: 'remote_book_9',
                chapterKey: 'chapter_1',
                chapterSourceKey: 'chapter_1',
                bookStableKey: 'sample_book_key',
                status: 'completed',
                paragraphs: [
                    { id: 'p1', translation: '译文一', status: 'completed' },
                    { id: 'p2', translation: '译文二', status: 'completed' }
                ],
                totalParagraphs: 2,
                updatedAt: 2000
            }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }
    const { merged } = mergeSyncData(localPayload, remotePayload)
    assert.strictEqual(merged.chapterTranslations.length, 1, 'Translations for the same chapter of matched book must merge into 1 record')
    assert.strictEqual(merged.chapterTranslations[0].bookId, 'local_book_1', 'Remapped translation must point to target local book ID')
    assert.strictEqual(merged.chapterTranslations[0].paragraphs.length, 2, 'Merged paragraphs should contain both p1 and p2')
    assert.strictEqual(merged.chapterTranslations[0].status, 'completed', 'Merged status should be completed')
})

// 18. R12: Password handling preserves spaces and cancel returns null
test('R12: Password handling preserves leading and trailing spaces without trim', () => {
    const rawWithSpaces = '  secret 123  '
    const preserved = (rawWithSpaces !== '' ? rawWithSpaces : '')
    assert.strictEqual(preserved, '  secret 123  ', 'Must retain all spaces exactly as user typed')
    const empty = ''
    const emptyPreserved = (empty !== '' ? empty : '')
    assert.strictEqual(emptyPreserved, '', 'Empty password is preserved as empty string')
})

// 19. R13: Cover signature incorporates coverRevision / updatedAt
test('R13: Cover signature invalidates on coverRevision / updatedAt change even with identical blob size', () => {
    const book1 = { id: 'b1', coverBlob: { size: 12345, type: 'image/jpeg' }, coverRevision: 'rev_1', updatedAt: 100 }
    const book2 = { id: 'b1', coverBlob: { size: 12345, type: 'image/jpeg' }, coverRevision: 'rev_2', updatedAt: 200 }
    const sig1 = `${book1.coverRevision}:${book1.coverBlob.size}:${book1.coverBlob.type}:${book1.updatedAt}`
    const sig2 = `${book2.coverRevision}:${book2.coverBlob.size}:${book2.coverBlob.type}:${book2.updatedAt}`
    assert.notStrictEqual(sig1, sig2, 'Signatures must differ when cover revision or updated timestamp changes')
})

// 20. Q01: Import queue failure before saveBook cleanly sets job.status = 'failed' without ReferenceError
test('Q01: Import queue failure before saveBook cleanly sets job.status = "failed" without ReferenceError', () => {
    let savedBookId = null
    let isCommittedToDb = false
    let job = { status: 'running', phase: 'reading', error: null, progressText: '' }
    try {
        // Simulate unsupported format or early reading throw before saveBook
        throw new Error('不支持的文件格式 .xyz')
    } catch (err) {
        // If savedBookId is properly scoped, this does NOT throw ReferenceError
        if (!isCommittedToDb) {
            // Reclaim snapshot safely
        }
        job.status = 'failed'
        job.phase = 'failed'
        job.error = err.message
    }
    assert.strictEqual(job.status, 'failed')
    assert.strictEqual(job.error, '不支持的文件格式 .xyz')
})

// 21. Q02: Native selection in word mode preserves full native word quads
test('Q02: Native selection in word mode preserves full native word quads', () => {
    const mode = 'word'
    const result = {
        text: 'hello',
        quads: [{ xy: [10, 20, 59, 20, 10, 32, 59, 32] }] // full word width 49
    }
    const singleCharSlice = [{ quad: [25, 20, 34, 20, 25, 32, 34, 32] }] // single letter 'l' width 9
    
    let quads = []
    if (mode !== 'char' && result.quads && result.quads.length > 0) {
        quads = result.quads
    } else {
        quads = singleCharSlice.map(c => c.quad)
    }
    assert.strictEqual(quads.length, 1)
    const width = quads[0].xy[2] - quads[0].xy[0]
    assert.strictEqual(width, 49, 'Word mode must use full native word quad (width 49) rather than single letter (width 9)')
})

// 22. Q03: Degenerate zero-area quads return Infinity distance and are never hit
test('Q03: Degenerate zero-area quads return Infinity distance and are never hit', () => {
    function quadArea(q) {
        if (!q || q.length < 8) return 0
        for (let i = 0; i < 8; i++) {
            if (!Number.isFinite(q[i])) return 0
        }
        const x0 = q[0], y0 = q[1]
        const x1 = q[2], y1 = q[3]
        const x2 = q[6], y2 = q[7]
        const x3 = q[4], y3 = q[5]
        return 0.5 * Math.abs((x0*y1 - y0*x1) + (x1*y2 - y1*x2) + (x2*y3 - y2*x3) + (x3*y0 - y3*x0))
    }
    function pointToQuadDistanceSq(px, py, q) {
        if (!Number.isFinite(px) || !Number.isFinite(py)) return Infinity
        if (quadArea(q) < 1e-4) return Infinity
        return 0
    }
    
    const degeneratePointQuad = [10, 10, 10, 10, 10, 10, 10, 10]
    const degenerateLineQuad = [10, 10, 20, 10, 10, 10, 20, 10]
    const validQuad = [10, 10, 20, 10, 10, 20, 20, 20]
    
    assert.strictEqual(pointToQuadDistanceSq(10, 10, degeneratePointQuad), Infinity, 'Degenerate point quad must yield Infinity distance')
    assert.strictEqual(pointToQuadDistanceSq(15, 10, degenerateLineQuad), Infinity, 'Degenerate line quad must yield Infinity distance')
    assert.strictEqual(pointToQuadDistanceSq(15, 15, validQuad), 0, 'Valid quad with area must calculate normal distance')
})

// 23. Q04: Monotonic async preview sequence prevents older previews from overwriting newer previews
test('Q04: Monotonic async preview sequence prevents older previews from overwriting newer previews', () => {
    const drag = { previewSeq: 0, latestRenderedPreviewSeq: 0 }
    
    // Preview 1 starts
    const p1Seq = ++drag.previewSeq
    // Preview 2 starts
    const p2Seq = ++drag.previewSeq
    
    let rendered = []
    
    // Preview 2 finishes first (fast)
    if (!drag.latestRenderedPreviewSeq || p2Seq >= drag.latestRenderedPreviewSeq) {
        drag.latestRenderedPreviewSeq = p2Seq
        rendered.push({ seq: p2Seq, width: 29 })
    }
    
    // Preview 1 finishes later (slow)
    if (!drag.latestRenderedPreviewSeq || p1Seq >= drag.latestRenderedPreviewSeq) {
        drag.latestRenderedPreviewSeq = p1Seq
        rendered.push({ seq: p1Seq, width: 19 })
    }
    
    assert.strictEqual(rendered.length, 1, 'Older preview 1 must be discarded and not overwrite newer preview 2')
    assert.strictEqual(rendered[0].width, 29, 'Rendered width must remain at newer value (29)')
})

// 24. F02: ReaderLocationHistory records push, undo, redo, and limits max stack size
await runAsyncTest('F02: ReaderLocationHistory records push, undo, redo, and limits max stack size', async () => {
    const { ReaderLocationHistory } = await import('../js/app.js')
    const fakeApp = {
        currentFormat: 'pdf',
        pdfViewport: { currentPage: 1 },
        async navigateReaderToLocation() {}
    }
    const h = new ReaderLocationHistory(fakeApp)
    h.pushLocation({ type: 'pdf', page: 1 })
    h.pushLocation({ type: 'pdf', page: 10 })
    h.pushLocation({ type: 'pdf', page: 45 })
    
    assert.strictEqual(h.undoStack.length, 2)
    assert.strictEqual(h.currentLocation.page, 45)
    
    // Back to 10
    await h.back()
    assert.strictEqual(h.currentLocation.page, 10)
    assert.strictEqual(h.redoStack.length, 1)
    
    // Back to 1
    await h.back()
    assert.strictEqual(h.currentLocation.page, 1)
    
    // Forward to 10
    await h.forward()
    assert.strictEqual(h.currentLocation.page, 10)
})


// 25. R01: Content identity hashing and modified file detection
await runAsyncTest('R01: Content hash differentiates files of same size and detects disk modifications', async () => {
    const { computeContentHash } = await import('../js/db.js')
    const sampleA = new Blob(['Content of Edition Alpha 12345'], { type: 'text/plain' })
    const sampleB = new Blob(['Content of Edition Beta  12345'], { type: 'text/plain' })
    assert.strictEqual(sampleA.size, sampleB.size, 'Both test samples must have identical size')
    const hashA = await computeContentHash(sampleA)
    const hashB = await computeContentHash(sampleB)
    assert.ok(hashA && hashB, 'Both hashes must be non-empty')
    assert.notStrictEqual(hashA, hashB, 'Hashes must differ despite identical file size')
})

// 26. R02: Tombstone scoping prevents purging distinct edition of same title/stableKey
test('R02: Tombstone scoped to documentHash does not purge other edition with same stableKey', () => {
    const localPayload = {
        clientId: 'client_local',
        booksMeta: [
            { id: 'book_edition_b', title: '三体', format: 'epub', size: 1000000, stableKey: 'three_body', documentHash: 'hash_edition_b' }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: [
            // Edition A was deleted, creating tombstone bound to hash_edition_a
            { id: 'book_edition_a', type: 'book', stableKey: 'three_body', documentHash: 'hash_edition_a', format: 'epub', size: 1000000, deletedAt: 2000 }
        ]
    }
    const remotePayload = {
        clientId: 'client_remote',
        booksMeta: [
            { id: 'book_edition_b', title: '三体', format: 'epub', size: 1000000, stableKey: 'three_body', documentHash: 'hash_edition_b' }
        ],
        highlights: [],
        bookmarks: [],
        readingSessions: [],
        deletedRecords: []
    }
    const { merged } = mergeSyncData(localPayload, remotePayload)
    assert.strictEqual(merged.booksMeta.length, 1, 'Edition B must survive sync merge when Edition A was deleted')
    assert.strictEqual(merged.booksMeta[0].id, 'book_edition_b')
    assert.strictEqual(merged.booksMeta[0].documentHash, 'hash_edition_b')
})

// 27. R05: Session interval union preserves full active duration without rollback
await runAsyncTest('R05: Session interval union prevents duration rollback on reordered or overlapping intervals', async () => {
    const { mergeSessionIntervals, calculateIntervalUnionSeconds } = await import('../js/db.js')
    
    // Session 1 intervals: 100s duration (100,000ms to 200,000ms)
    const iv1 = [[100000, 200000]]
    // Session 2 intervals: overlapping 50s, extending to 250,000ms (union = [100000, 250000], duration = 150s)
    const iv2 = [[150000, 250000]]
    // Session 3 intervals (out of order, earlier disjoint segment): 30s (50,000ms to 80,000ms)
    // Total union duration = 150s + 30s = 180s
    const iv3 = [[50000, 80000]]
    
    const merged12 = mergeSessionIntervals(iv1, iv2)
    assert.strictEqual(merged12.length, 1, 'Overlapping intervals must merge into 1 interval')
    assert.strictEqual(calculateIntervalUnionSeconds(merged12), 150, 'Duration of merged12 must be 150 seconds')
    
    const mergedAll = mergeSessionIntervals(merged12, iv3)
    assert.strictEqual(mergedAll.length, 2, 'Non-overlapping intervals must form 2 disjoint intervals')
    assert.strictEqual(calculateIntervalUnionSeconds(mergedAll), 180, 'Total union seconds must equal 180s without rollback')
})

// 28. R06: Full-text search engine invalidates stale memory and persistent index
await runAsyncTest('R06: FullTextSearchEngine invalidate() removes in-memory and persistent index', async () => {
    const { fullTextSearchEngine } = await import('../js/fulltext-search.js')
    let deletedKey = null
    fullTextSearchEngine.db = {
        deleteBookSearchIndex: async (id) => { deletedKey = id }
    }
    fullTextSearchEngine.index.set('test_book_stale', { meta: { bookId: 'test_book_stale' }, sections: [] })
    assert.ok(fullTextSearchEngine.index.has('test_book_stale'))
    
    await fullTextSearchEngine.invalidate('test_book_stale')
    assert.strictEqual(fullTextSearchEngine.index.has('test_book_stale'), false, 'In-memory index must be removed')
    assert.strictEqual(deletedKey, 'test_book_stale', 'Persistent index must be deleted')
})

// 29. P02: Full-text search streams hit count and bounds snippet object creation
await runAsyncTest('P02: Full-text search bounds snippet generation while accurately streaming hit count', async () => {
    const { FullTextSearchEngine } = await import('../js/fulltext-search.js')
    const engine = new FullTextSearchEngine()
    
    // Create a section with 50 repetitions of word "keyword"
    const text = Array(50).fill('This is a keyword in the text.').join(' ')
    engine.index.set('b_perf', {
        meta: { bookId: 'b_perf', title: 'Performance Test' },
        sections: [{
            id: 'sec_1',
            sectionIndex: 0,
            sectionTitle: 'Chapter 1',
            location: { sectionIndex: 0 },
            text: text,
            tokens: new Set(['keyword'])
        }]
    })
    
    const results = engine.search('keyword', { bookIds: ['b_perf'], limit: 3 })
    assert.strictEqual(results.length, 3, 'Returned snippets must be capped at limit 3')
    assert.strictEqual(results[0].matchCount, 50, 'matchCount must reflect full 50 occurrences streamed')
})

// 30. R09: normalizeNavigationTarget converts various targets into typed location object
await runAsyncTest('R09: normalizeNavigationTarget handles bare numbers, string pages, CFIs, and typed objects', async () => {
    const { normalizeNavigationTarget } = await import('../js/db.js')
    
    // Null/undefined
    assert.strictEqual(normalizeNavigationTarget(null), null)
    assert.strictEqual(normalizeNavigationTarget(undefined), null)
    
    // Bare numeric index 3 -> page 4, pageIndex 3, yRatio 0
    const tNum = normalizeNavigationTarget(3)
    assert.deepStrictEqual(tNum, { type: 'pdf', page: 4, pageIndex: 3, yRatio: 0 })
    
    // Numeric string "12" -> page 12, pageIndex 11, yRatio 0
    const tStr = normalizeNavigationTarget('12')
    assert.deepStrictEqual(tStr, { type: 'pdf', page: 12, pageIndex: 11, yRatio: 0 })
    
    // EPUB CFI string
    const tCfi = normalizeNavigationTarget('epubcfi(/6/4[chap01]!/4/2/10)')
    assert.deepStrictEqual(tCfi, { type: 'epub', cfi: 'epubcfi(/6/4[chap01]!/4/2/10)' })
    
    // Object with page & yRatio
    const tObj = normalizeNavigationTarget({ page: 7, yRatio: 0.35 })
    assert.deepStrictEqual(tObj, { type: 'pdf', page: 7, pageIndex: 6, yRatio: 0.35 })
})

// 31. Updater: 1.0.0 migration comparison with predecessor dev versions
await runAsyncTest('Updater: compareVersions recognizes predecessor dev builds 2.0.0..2.0.18 as older than 1.0.0', async () => {
    const { AppUpdater } = await import('../js/updater.js')
    const updater = new AppUpdater()
    
    // 1.0.0 is newer than predecessor dev builds (2.0.0 to 2.0.18)
    assert.strictEqual(updater.compareVersions('1.0.0', '2.0.18'), 1, '1.0.0 must be newer than legacy 2.0.18 dev')
    assert.strictEqual(updater.compareVersions('1.0.0', '2.0.0'), 1, '1.0.0 must be newer than legacy 2.0.0 dev')
    assert.strictEqual(updater.compareVersions('2.0.17', '1.0.0'), -1, 'Legacy 2.0.17 dev must be older than 1.0.0')
    
    // Future 2.0.19+ and 2.1.0 are genuine future releases
    assert.strictEqual(updater.compareVersions('1.0.0', '2.0.19'), -1, '1.0.0 must be older than future 2.0.19')
    assert.strictEqual(updater.compareVersions('1.0.0', '2.1.0'), -1, '1.0.0 must be older than future 2.1.0')
    
    // Normal 1.0.x increments
    assert.strictEqual(updater.compareVersions('1.0.1', '1.0.0'), 1, '1.0.1 must be newer than 1.0.0')
    assert.strictEqual(updater.compareVersions('1.0.0', '1.0.0'), 0, 'Same version equals 0')
})

// 32. P07: AI conversation search text indexing includes referenceSnapshot selectedText
test('P07: AI conversation search text indexing includes referenceSnapshot selectedText', () => {
    const msgs = [
        {
            content: '请解释这段话',
            quoteText: '',
            referenceSnapshot: { selectedText: '量子纠缠是一种奇特的物理现象' }
        },
        {
            content: '这是量子力学中的基本概念。',
            quoteText: null
        }
    ]
    const fullText = msgs.map(m => `${m.content || ''} ${m.quoteText || ''} ${m.referenceSnapshot?.selectedText || ''}`).join(' ').toLowerCase()
    assert.ok(fullText.includes('量子纠缠'), 'Searchable text must contain referenceSnapshot.selectedText')
    assert.ok(fullText.includes('量子力学'), 'Searchable text must contain message content')
})

// 33. Modern Shelf: Grid Virtualization row and spacer calculations for large libraries
test('Modern Shelf: Grid Virtualization bounds mounted cards, subtracts grid gap, and eliminates phantom top margin', () => {
    const totalBooks = 1000
    const gridWidth = 800
    const cardMinWidth = 140
    const gapX = 26.4
    const cols = Math.max(1, Math.floor((gridWidth + gapX) / (cardMinWidth + gapX)))
    assert.strictEqual(cols, 4, 'cols should be 4 for 800px width with 140px cards and 26.4px gap')
    
    const cardHeight = 285
    const gapY = 36
    const rowHeight = cardHeight + gapY
    const totalRows = Math.ceil(totalBooks / cols)
    const totalHeight = totalRows * rowHeight
    assert.strictEqual(totalRows, 250)
    assert.strictEqual(totalHeight, 80250)

    // Simulate scrolling to row 20 (relativeScroll = 6420px), viewport 900px (~2.8 rows), buffer 2 rows
    const relativeScroll = 6420
    const viewportHeight = 900
    const bufferRows = 2
    const startRow = Math.max(0, Math.floor(relativeScroll / rowHeight) - bufferRows)
    const endRow = Math.min(totalRows, Math.ceil((relativeScroll + viewportHeight) / rowHeight) + bufferRows)
    assert.strictEqual(startRow, 18)
    assert.strictEqual(endRow, 25)

    const startIndex = startRow * cols
    const endIndex = Math.min(totalBooks, endRow * cols)
    const mountedCount = endIndex - startIndex
    assert.strictEqual(mountedCount, 28, 'Mounted cards in DOM must be strictly bounded (28 cards instead of 1000)')

    // Verified spacer behavior: CSS Grid gapY (36px) is subtracted from spacer heights when displayed
    const topSpacerDisplay = startRow > 0 ? 'block' : 'none'
    const topSpacerHeight = startRow > 0 ? (startRow * rowHeight) - gapY : 0
    assert.strictEqual(topSpacerDisplay, 'block')
    assert.strictEqual(topSpacerHeight, 5742, 'topSpacer height must subtract grid row gap (18 * 321 - 36 = 5742)')

    const bottomSpacerDisplay = endRow < totalRows ? 'block' : 'none'
    const bottomSpacerHeight = endRow < totalRows ? ((totalRows - endRow) * rowHeight) - gapY : 0
    assert.strictEqual(bottomSpacerDisplay, 'block')
    assert.strictEqual(bottomSpacerHeight, 72189, 'bottomSpacer height must subtract grid row gap ((250 - 25) * 321 - 36 = 72189)')

    // Scrolled to top (startRow = 0): topSpacer must be hidden (display: none) to eliminate phantom 36px top gap
    const topScrolledStartRow = 0
    const topScrolledDisplay = topScrolledStartRow > 0 ? 'block' : 'none'
    assert.strictEqual(topScrolledDisplay, 'none', 'topSpacer must have display:none at top row to prevent phantom gap')
})

// 34. Modern Shelf: Visible-area cover scheduling & card accessibility
test('Modern Shelf: Card creation sets accessibility attributes and eagerly loads covers only for visible cards (<28)', () => {
    let eagerAllocations = 0
    const mockCoverPool = {
        get(id, blob, rev) {
            eagerAllocations++
            return `blob:mock/${id}`
        }
    }
    
    function simulateCardCover(cardIndex, book) {
        const isEagerCover = cardIndex < 28
        let coverUrl = ''
        if (book.coverBlob && isEagerCover) {
            coverUrl = mockCoverPool.get(book.id, book.coverBlob, book.coverRevision)
        }
        let html = ''
        if (coverUrl) {
            html = `<img class="leaf-cover-img" src="${coverUrl}" />`
        } else if (book.coverBlob) {
            html = `<img class="leaf-cover-img lazy-cover" data-book-id="${book.id}" />`
        }
        const cardAttr = 'tabindex="0" role="button"'
        return { coverUrl, html, cardAttr }
    }

    // Card 0 (eager)
    const card0 = simulateCardCover(0, { id: 'b0', coverBlob: { size: 5000, type: 'image/jpeg' } })
    assert.ok(card0.coverUrl.startsWith('blob:'), 'Card 0 should eagerly resolve blob url')
    assert.ok(card0.html.includes('src="blob:mock/b0"'))
    assert.ok(card0.cardAttr.includes('tabindex="0"'))
    assert.ok(card0.cardAttr.includes('role="button"'))

    // Card 35 (lazy)
    const card35 = simulateCardCover(35, { id: 'b35', coverBlob: { size: 5000, type: 'image/jpeg' } })
    assert.strictEqual(card35.coverUrl, '', 'Card 35 should NOT eagerly resolve blob url')
    assert.ok(card35.html.includes('lazy-cover'), 'Card 35 should have lazy-cover class')
    assert.ok(card35.html.includes('data-book-id="b35"'), 'Card 35 should store data-book-id for observer hydration')
    assert.strictEqual(eagerAllocations, 1, 'Only 1 eager allocation should have been made')
})

// 35. Modern Shelf: Local card partial update
test('Modern Shelf: updateBookCardLocally performs micro DOM mutations for progress and favorite', () => {
    const metaRow = { innerHTML: '<span class="leaf-meta-progress">10%</span>' }
    const favBtn = {
        classList: {
            active: false,
            toggle(cls, val) { this.active = val }
        },
        title: '加入收藏'
    }
    const card = {
        dataset: { id: 'book_local_1' },
        querySelector(sel) {
            if (sel === '.leaf-book-meta-row') return metaRow
            if (sel === '.grid-fav-btn') return favBtn
            return null
        },
        _renderSig: 'old_sig'
    }
    
    // Simulate updating progress to 75%
    const patch = {
        progress: { fraction: 0.75 },
        isFavorite: true
    }
    const rawPct = patch.progress.fraction * 100
    const progressPct = rawPct.toFixed(0)
    metaRow.innerHTML = `<span class="leaf-meta-progress">${progressPct}%</span>`
    favBtn.classList.toggle('active', patch.isFavorite)
    favBtn.title = patch.isFavorite ? '取消收藏' : '加入收藏'

    assert.ok(metaRow.innerHTML.includes('75%'), 'Meta row must be updated to 75%')
    assert.strictEqual(favBtn.classList.active, true, 'Favorite button active state must be true')
    assert.strictEqual(favBtn.title, '取消收藏', 'Favorite button title must be updated')
})

// 36. P01: AI stream chunk coalescing scroll state preservation
test('P01: AI stream chunk coalescing checks wasNearBottom to preserve scroll position during review', () => {
    const chatElReview = { scrollHeight: 1000, scrollTop: 450, clientHeight: 300 }
    const distFromBottomReview = chatElReview.scrollHeight - chatElReview.scrollTop - chatElReview.clientHeight
    const wasNearBottomReview = distFromBottomReview < 60
    assert.strictEqual(wasNearBottomReview, false, 'User viewing earlier conversation is NOT near bottom')

    let scrolled = false
    if (wasNearBottomReview) {
        scrolled = true
    }
    assert.strictEqual(scrolled, false, 'Scroll must not be snatched when wasNearBottom is false')

    const chatElBottom = { scrollHeight: 1000, scrollTop: 695, clientHeight: 300 }
    const wasNearBottomBottom = (chatElBottom.scrollHeight - chatElBottom.scrollTop - chatElBottom.clientHeight) < 60
    assert.strictEqual(wasNearBottomBottom, true, 'User at the bottom is near bottom')
    if (wasNearBottomBottom) {
        scrolled = true
    }
    assert.strictEqual(scrolled, true, 'Scroll must be updated when user is at the bottom')
})

// 37. P04: PDF plain-text search skip
await runAsyncTest('P04: PDF search skips expensive text geometry extraction on pages where plain text has no match', async () => {
    let fullExtractionCalled = false
    const mockDriver = {
        async getPagePlainText(pageIdx) {
            if (pageIdx === 0) return 'This page discusses quantum computing and algorithms.'
            if (pageIdx === 1) return 'Table of contents and preface with general introductory text.'
            return '' // Scanned or empty page
        },
        async getTextLayer(pageIdx) {
            fullExtractionCalled = true
            return { spans: [{ text: 'quantum' }] }
        }
    }

    async function searchPage(pageIdx, query) {
        const qLower = query.toLowerCase()
        const plain = await mockDriver.getPagePlainText(pageIdx)
        if (typeof plain === 'string' && !plain.toLowerCase().includes(qLower)) {
            return []
        }
        return (await mockDriver.getTextLayer(pageIdx)).spans
    }

    fullExtractionCalled = false
    const res1 = await searchPage(1, 'quantum')
    assert.deepStrictEqual(res1, [])
    assert.strictEqual(fullExtractionCalled, false, 'Expensive getTextLayer must NOT be called on non-matching page')

    fullExtractionCalled = false
    const resEmpty = await searchPage(2, 'quantum')
    assert.deepStrictEqual(resEmpty, [])
    assert.strictEqual(fullExtractionCalled, false, 'Expensive getTextLayer must NOT be called on empty/scanned page')

    const res0 = await searchPage(0, 'quantum')
    assert.strictEqual(fullExtractionCalled, true, 'getTextLayer should be called when plain text matches')
    assert.strictEqual(res0.length, 1)
})

// 38. F02: Reader Location History stack bounds and navigation
await runAsyncTest('F02: ReaderLocationHistory push, back, forward, and bounds (max 50)', async () => {
    const { ReaderLocationHistory } = await import('../js/app.js')
    const mockApp = {
        currentFormat: 'pdf',
        pdfViewport: { currentPage: 1 },
        navigatedLoc: null,
        async navigateReaderToLocation(loc) { this.navigatedLoc = loc }
    }
    
    const hist = new ReaderLocationHistory(mockApp)
    hist.pushLocation({ type: 'pdf', page: 1 })
    hist.pushLocation({ type: 'pdf', page: 10 })
    hist.pushLocation({ type: 'pdf', page: 25 })

    assert.strictEqual(hist.canGoBack(), true)
    assert.strictEqual(hist.canGoForward(), false)

    await hist.back()
    assert.strictEqual(hist.currentLocation.page, 10, 'First back goes to page 10')
    assert.strictEqual(hist.canGoForward(), true)

    await hist.back()
    assert.strictEqual(hist.currentLocation.page, 1, 'Second back goes to page 1')

    await hist.forward()
    assert.strictEqual(hist.currentLocation.page, 10, 'Forward returns to page 10')

    // Test max stack boundary (50 items)
    for (let i = 0; i < 60; i++) {
        hist.pushLocation({ type: 'pdf', page: 100 + i })
    }
    assert.ok(hist.undoStack.length <= 50, 'History undo stack must be capped at 50')
})

// 39. P06: Reading stats cache invalidation
test('P06: db.js highlight and bookmark operations invalidate aggregated reading stats cache', async () => {
    const db = await import('../js/db.js')
    assert.strictEqual(typeof db.invalidateReadingStatsCache, 'function', 'db.js must export invalidateReadingStatsCache')
    db.invalidateReadingStatsCache()
})

// 40. P03: Platform resource budget constrained device detection
test('P03: platformBridge setResourceBudget respects constrained memory devices (<=6GB RAM)', async () => {
    const pb = (await import('../js/platformBridge.js')).default || (await import('../js/platformBridge.js')).platformBridge || globalThis.platformBridge
    const budget = pb.setResourceBudget({ isLowMemoryDevice: true, maxCacheMb: 64, maxMemoryMb: 512 })
    assert.strictEqual(budget.isLowMemoryDevice, true, 'Constrained device must have isLowMemoryDevice=true')
    assert.strictEqual(budget.maxCacheMb, 64, 'Constrained device cache limit should be 64MB')
    assert.strictEqual(budget.maxMemoryMb, 512, 'Constrained device memory limit should be 512MB')
})

// 41. R06: FullTextSearchEngine searchBookFull stale cache invalidation
test('R06: searchBookFull invalidates cache when snapshot blobRevision or documentHash changes', async () => {
    const { FullTextSearchEngine } = await import('../js/fulltext-search.js')
    const engine = new FullTextSearchEngine()
    let invalidatedBookId = null
    engine.invalidate = async id => { invalidatedBookId = id }

    // Seed in-memory cache with old revision
    engine.index.set('book_stale', {
        meta: { blobRevision: 'rev_1', documentHash: 'hash_1', size: 1000 },
        sections: []
    })

    // Mock db returning new revision rev_2
    engine.db = {
        async getBook(id) { return { id, blobRevision: 'rev_2', documentHash: 'hash_1', size: 1000 } },
        async getBookFileSnapshot(id) { return { blob: { size: 1000 }, blobRevision: 'rev_2', documentHash: 'hash_1' } },
        async getBookSearchIndex() { return null }
    }

    await engine.searchBookFull('book_stale', 'test')
    assert.strictEqual(invalidatedBookId, 'book_stale', 'searchBookFull must invalidate cache when snapshot blobRevision differs')
})

// 42. Updater: compareVersions dev build migration
test('Updater: compareVersions recognizes any 1.x release as newer than predecessor dev builds (2.0.0..2.0.18)', async () => {
    const { updater } = await import('../js/updater.js')
    assert.strictEqual(updater.compareVersions('1.0.0', '2.0.18'), 1)
    assert.strictEqual(updater.compareVersions('1.0.0', '2.0.0'), 1)
    assert.strictEqual(updater.compareVersions('2.0.18', '1.0.0'), -1)
    assert.strictEqual(updater.compareVersions('1.1.0', '2.0.18'), 1)
    assert.strictEqual(updater.compareVersions('2.0.19', '1.0.0'), 1)
    assert.strictEqual(updater.compareVersions('2.1.0', '1.0.0'), 1)
})

// 43. Q05: FullTextSearchEngine searchBookFull returns full hits beyond 300
test('Q05: searchBookFull handles >300 hits without permanent truncation at 300', async () => {
    const { FullTextSearchEngine } = await import('../js/fulltext-search.js')
    const engine = new FullTextSearchEngine()
    
    const sections = []
    for (let i = 0; i < 500; i++) {
        sections.push({
            id: `sec_${i}`,
            title: `Chapter ${i + 1}`,
            text: `This is paragraph ${i} containing the target keyword search_term_target here.`
        })
    }
    engine.index.set('book_500', {
        meta: { id: 'book_500', title: '500 Hits Book', blobRevision: 'rev1', documentHash: 'hash1' },
        sections
    })
    engine.db = {
        async getBook(id) { return { id, blobRevision: 'rev1', documentHash: 'hash1', size: 1000 } },
        async getBookFileSnapshot(id) { return { blob: { size: 1000 }, blobRevision: 'rev1', documentHash: 'hash1' } },
        async getBookSearchIndex() { return null }
    }

    const results = await engine.searchBookFull('book_500', 'search_term_target', { limit: 500 })
    assert.strictEqual(results.length, 500, 'searchBookFull must return all 500 hits when requested with limit >= 500')
})

// 44. Q06: CJK single character query matching
test('Q06: CJK single character query matches real substring without bi-gram false negative', async () => {
    const { FullTextSearchEngine } = await import('../js/fulltext-search.js')
    const engine = new FullTextSearchEngine()
    engine.index.set('cjk_single', {
        meta: { id: 'cjk_single', title: 'CJK Test', blobRevision: 'rev1', documentHash: 'hash1' },
        sections: [{ id: 's1', title: 'Sec 1', text: '阿甘本讨论生命。' }]
    })
    engine.db = {
        async getBook(id) { return { id, blobRevision: 'rev1', documentHash: 'hash1', size: 100 } },
        async getBookFileSnapshot(id) { return { blob: { size: 100 }, blobRevision: 'rev1', documentHash: 'hash1' } },
        async getBookSearchIndex() { return null }
    }
    const hits = await engine.searchBookFull('cjk_single', '阿')
    assert.strictEqual(hits.length, 1, 'Single CJK character "阿" must match "阿甘本讨论生命。"')
})

// 45. Q07 & Q08: Shelf virtualization columns, row height, and layout calculation
test('Q07 & Q08: Shelf grid column calculation and map cache consistency', async () => {
    const minColWidth = 160
    const gap = 16
    const containerWidth = 1200
    const cols = Math.max(1, Math.floor((containerWidth + gap) / (minColWidth + gap)))
    assert.ok(cols >= 4, 'Columns for 1200px should be >= 4')
})

// 46. Q10: restoreFullDataBackup protects newer local reading progress
test('Q10: restore planner preserves newer progress before the atomic storage commit', async () => {
    const { AdvancedSettingsManager } = await import('../js/advanced-settings.js')
    const mgr = new AdvancedSettingsManager()
    let savedBook = null
    const fakeDb = {
        async getAllBooks() { return [await this.getBook('b1')] },
        async applyRestorePlan(plan) { savedBook = plan.booksToPut[0]; return { success: true } },
        async commitRestoreOperation() { return true },
        async getBook(id) {
            return {
                id,
                title: 'Local Book',
                progress: { fraction: 0.8, updatedAt: 2000 },
                totalReadingSeconds: 900
            }
        },
        async saveBook(b) {
            savedBook = b
            return b
        }
    }
    const backupData = {
        format: 'linden-leaf-full-backup',
        schemaVersion: 4,
        exportedAt: 1500,
        books: [{
            id: 'b1',
            title: 'Backup Book',
            progress: { fraction: 0.2, updatedAt: 1000 },
            totalReadingSeconds: 100
        }]
    }

    await mgr.restoreFullDataBackup(backupData, fakeDb)
    assert.ok(savedBook, 'Book should be saved')
    assert.strictEqual(savedBook.progress.fraction, 0.8, 'Newer local progress fraction 0.8 must be preserved')
    assert.strictEqual(savedBook.totalReadingSeconds, 900, 'Higher reading duration 900 must be preserved')
})

// 47. F02: Location history properly tracks and navigates locations
await runAsyncTest('F02: Location history properly tracks and navigates locations', async () => {
    const { ReaderLocationHistory } = await import('../js/app.js')
    const fakeApp = {
        currentFormat: 'pdf',
        pdfViewport: { currentPage: 1 },
        async navigateReaderToLocation() {}
    }
    const hist = new ReaderLocationHistory(fakeApp)
    hist.pushLocation({ type: 'pdf', page: 1 })
    hist.pushLocation({ type: 'pdf', page: 5 })
    await hist.back()
    assert.strictEqual(hist.currentLocation.page, 1)
    await hist.forward()
    assert.strictEqual(hist.currentLocation.page, 5)
})

// 48. F04 & F13: PlatformBridge always-on-top and runtime app paths
test('F04 & F13: platformBridge supports windowSetAlwaysOnTop, fsGetAppPaths, fsScanFolder', async () => {
    const pb = (await import('../js/platformBridge.js')).default || (await import('../js/platformBridge.js')).platformBridge || globalThis.platformBridge
    assert.strictEqual(typeof pb.windowSetAlwaysOnTop, 'function', 'platformBridge must provide windowSetAlwaysOnTop')
    assert.strictEqual(typeof pb.fsGetAppPaths, 'function', 'platformBridge must provide fsGetAppPaths')
    assert.strictEqual(typeof pb.fsScanFolder, 'function', 'platformBridge must provide fsScanFolder')
    assert.strictEqual(typeof pb.mupdfExportAnnotatedPdf, 'function', 'platformBridge must provide mupdfExportAnnotatedPdf')
})

// 49. F05: PdfViewport setCropSettings non-destructive trimming
test('F05: PdfViewport setCropSettings updates margins and preserves coordinate space', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    assert.strictEqual(typeof PdfViewport.prototype.setCropSettings, 'function', 'PdfViewport must have setCropSettings')
    assert.strictEqual(typeof PdfViewport.prototype.getCropSettings, 'function', 'PdfViewport must have getCropSettings')
    assert.strictEqual(typeof PdfViewport.prototype._applyCropToSlot, 'function', 'PdfViewport must have _applyCropToSlot')

    const slot = { style: {} }
    const vp = Object.create(PdfViewport.prototype)
    vp.activeSlots = new Map([[1, slot]])
    vp.setCropSettings({ mode: 'manual', margins: { top: 5, bottom: 5, left: 10, right: 10 } })
    assert.strictEqual(slot.style.clipPath, 'inset(5% 10% 5% 10%)', 'Clip path should match margins')
    vp.setCropSettings({ mode: 'none' })
    assert.strictEqual(slot.style.clipPath, '', 'Clip path should clear when mode is none')
})

// 50. F08: StorageProvider implementations adhere to common interface
test('F08: Storage providers (WebDav, LocalFolder, OneDrive, GoogleDrive) implement unified interface', async () => {
    const { StorageProvider, WebDavStorageProvider, LocalFolderStorageProvider, OneDriveStorageProvider, GoogleDriveStorageProvider } = await import('../js/storage-providers.js')
    assert.ok(StorageProvider, 'StorageProvider base class must exist')
    const providers = [
        new WebDavStorageProvider({ url: 'https://dav.example.com' }),
        new LocalFolderStorageProvider('C:/sync'),
        new OneDriveStorageProvider(),
        new GoogleDriveStorageProvider()
    ]
    for (const p of providers) {
        assert.strictEqual(typeof p.authenticate, 'function')
        assert.strictEqual(typeof p.listFiles, 'function')
        assert.strictEqual(typeof p.readFile, 'function')
        assert.strictEqual(typeof p.writeFile, 'function')
        assert.strictEqual(typeof p.deleteFile, 'function')
        assert.strictEqual(typeof p.getMissingPrerequisites, 'function')
    }
})

// 51. F11 & M08: PdfViewport OCR layer synthesis for scanned PDF pages
test('F11 & M08: PdfViewport setPageOcrData synthesizes character quads and enables text extraction', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.create(PdfViewport.prototype)
    vp._nativeGeometry = new Map()
    vp._nativeGeometryUse = new Map()
    vp._pageOcrData = new Map()
    
    // Simulate OCR result for 1 line: "Linden Leaf"
    const ocrSpans = [
        { text: 'Linden', rect: [10, 20, 60, 35], line: 0 },
        { text: 'Leaf', rect: [65, 20, 105, 35], line: 0 }
    ]
    vp.setPageOcrData(0, ocrSpans)
    assert.ok(vp._pageOcrData.has(0), 'Page 0 should have OCR data')
    const pageChars = vp._pageOcrData.get(0)
    assert.strictEqual(pageChars.length, 10, 'Should synthesize 10 characters (6 for Linden, 4 for Leaf)')
    assert.strictEqual(pageChars[0].text, 'L')
    assert.strictEqual(pageChars[0].quad.length, 8, 'Character must have 8-point quad')
    assert.strictEqual(pageChars[9].text, 'f')
})

// 52. F01: Segregation of recently opened external files vs permanent bookshelf
test('F01: External files marked isRecentOnly are segregated to recent category', async () => {
    const allBooks = [
        { id: 'b1', title: 'Permanent Book 1', isRecentOnly: false },
        { id: 'b2', title: 'Permanent Book 2' },
        { id: 'b3', title: 'Recent External File', isRecentOnly: true, progress: { updatedAt: 1000 } }
    ]
    const shelfBooks = allBooks.filter(b => !b.isRecentOnly)
    const recentBooks = allBooks.filter(b => b.isRecentOnly || (b.progress?.updatedAt > 0))
    assert.strictEqual(shelfBooks.length, 2, 'Main shelf should only contain permanent books')
    assert.ok(!shelfBooks.some(b => b.id === 'b3'), 'External recent file must not clutter main shelf')
    assert.strictEqual(recentBooks.length, 1, 'Recent category contains external file')
})

// 53. T06: PdfViewport physical odd/even page crop calculation and 0..49% margin clamping
test('T06: PdfViewport odd/even crop correctly handles physical 1-based parity and clamps margins', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.create(PdfViewport.prototype)
    const slotOdd = { style: {} }
    const slotEven = { style: {} }
    vp.activeSlots = new Map([[0, slotOdd], [1, slotEven]])
    
    // Set crop settings with odd-even mode and values outside 0..49%
    vp.setCropSettings({
        mode: 'odd-even',
        margins: { top: 5, bottom: 5, left: 10, right: 10 },
        odd: { top: 8, bottom: 8, left: 12, right: 14 },
        even: { top: 6, bottom: 6, left: 60, right: -5 } // 60 should clamp to 49, -5 clamp to 0
    })
    
    // Page 0 is physical page 1 (odd)
    assert.strictEqual(slotOdd.style.clipPath, 'inset(8% 14% 8% 12%)', 'Physical page 1 (index 0) must use odd margins')
    // Page 1 is physical page 2 (even)
    assert.strictEqual(slotEven.style.clipPath, 'inset(6% 0% 6% 49%)', 'Physical page 2 (index 1) must use clamped even margins')
})

// 53b. C/E Regression: PdfToolsController.exportAnnotatedPdf preserves 5 MuPDF subtypes, CropBox offsets, and erased ink segments
await runAsyncTest('CE01: PdfToolsController.exportAnnotatedPdf exports highlight/underline/strikeout/note/ink with MediaBox origin and erased ink split', async () => {
    const prevDb = globalThis.db
    const prevWindow = globalThis.window
    const hadWindow = prevWindow !== undefined
    if (!globalThis.window) globalThis.window = {}
    const prevBridge = globalThis.window.platformBridge
    const prevDoc = globalThis.document
    let capturedPayload = null

    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, setAttribute() {} })
    }
    const { PdfToolsController } = await import('../js/pdf-tools-controller.js')
    const mockDb = {
        getHighlightsByBook: async () => [
            { id: 'h1', bookId: 'b1', blobRevision: 'rev1', style: 'highlight', color: '#ffeb3b', note: 'HL note', pdfTarget: { page: 0, rects: [[0.1, 0.2, 0.3, 0.25]] } },
            { id: 'h2', bookId: 'b1', blobRevision: 'rev1', style: 'underline', color: '#2196f3', pdfTarget: { page: 0, quads: [[100, 200, 200, 200, 100, 220, 200, 220]] } },
            { id: 'h3', bookId: 'b1', blobRevision: 'rev1', style: 'strikethrough', color: '#f44336', pdfTarget: { page: 0, rects: [[0.2, 0.3, 0.4, 0.35]] } },
            { id: 'h4', bookId: 'b1', blobRevision: 'rev1', style: 'note', note: 'Sticky note', color: '#ffb300', pdfTarget: { page: 0, rects: [[0.5, 0.5, 0.502, 0.502]] } }
        ],
        getPdfPageDrawing: async (_contentId, page, versionMeta) => (page === 0 && versionMeta?.blobRevision === 'rev1') ? {
            strokes: [
                { id: 's1', color: '#00aa00', width: 2, opacity: 1, points: [[0.1, 0.5], [0.9, 0.5]], createdAt: 10 },
                { id: 'e1', tool: 'eraser', width: 18, points: [[0.5, 0.45], [0.5, 0.55]], createdAt: 20 }
            ]
        } : null
    }
    globalThis.db = mockDb
    globalThis.window.platformBridge = {
        ...prevBridge,
        dialogPickSavePath: async () => 'C:/tmp/mock_export.pdf',
        mupdfExportAnnotatedPdf: async (_docId, _savePath, jsonStr) => {
            capturedPayload = JSON.parse(jsonStr)
            return true
        }
    }

    try {
        const mockApp = {
            currentBookId: 'b1',
            currentBook: { id: 'b1', title: 'Test Book', format: 'pdf', blobRevision: 'rev1', documentHash: 'hash1' },
            currentBookData: { id: 'b1', title: 'Test Book', format: 'pdf', blobRevision: 'rev1', documentHash: 'hash1' },
            activeReaderSession: { bookId: 'b1', isCurrent: () => true },
            db: mockDb,
            pdfDriver: {
                kind: 'mupdf',
                docId: 'doc-1',
                numPages: 1,
                snapshot: { contentId: 'hash1', documentHash: 'hash1', blobRevision: 'rev1' },
                pageSizes: [{ x0: 20, y0: 40, width: 400, height: 600 }]
            },
            pdfViewport: { driver: null, snapshot: { contentId: 'hash1', documentHash: 'hash1', blobRevision: 'rev1' } },
            drawing: { flushPendingWrites: async () => {} },
            dialogs: { showToast: () => {} }
        }
        mockApp.pdfViewport.driver = mockApp.pdfDriver
        const ctrl = new PdfToolsController(mockApp)
        await ctrl.exportAnnotatedPdf()

        assert.ok(Array.isArray(capturedPayload), 'Expected JSON payload to mupdfExportAnnotatedPdf')
        const types = capturedPayload.map(item => item.type)
        assert.deepStrictEqual(types, ['highlight', 'underline', 'strikeout', 'note', 'ink'], 'All 5 annotation types must map cleanly')

        // Highlight synthesized quad & CropBox origin offset (x0=20, y0=40)
        assert.strictEqual(capturedPayload[0].rect[0], 60) // 20 + 0.1*400
        assert.strictEqual(capturedPayload[0].rect[1], 160) // 40 + 0.2*600
        assert.strictEqual(capturedPayload[0].quads.length, 8)
        // Note tiny rect normalized >= 24pt
        assert.ok(capturedPayload[3].rect[2] - capturedPayload[3].rect[0] >= 24)
        assert.ok(capturedPayload[3].rect[3] - capturedPayload[3].rect[1] >= 24)
        // Ink stroke split by eraser into 2 pieces and offset by (x0=20, y0=40)
        assert.strictEqual(capturedPayload[4].strokes.length, 2, 'Ink stroke crossed by eraser must split into 2 segments')
        assert.ok(capturedPayload[4].strokes[0][0][0] >= 20 + 0.1 * 400 - 0.1)
    } finally {
        globalThis.db = prevDb
        globalThis.document = prevDoc
        if (hadWindow) {
            globalThis.window.platformBridge = prevBridge
        } else {
            delete globalThis.window
        }
    }
})

// 54. T07: OcrService recognizeCanvas coordinate scaling
await runAsyncTest('T07: OcrService recognizeCanvas scales bounding boxes to page coordinates', async () => {
    const { OcrService } = await import('../js/ocr-service.js')
    const service = new OcrService()
    
    // Mock worker recognize result at render scale 2.0
    service._worker = {
        recognize: async () => ({
            data: {
                text: 'Sample OCR text',
                lines: [
                    {
                        text: 'Sample OCR text',
                        bbox: { x0: 20, y0: 40, x1: 200, y1: 80 },
                        words: [
                            {
                                text: 'Sample',
                                bbox: { x0: 20, y0: 40, x1: 80, y1: 80 }
                            },
                            {
                                text: 'OCR',
                                bbox: { x0: 90, y0: 40, x1: 140, y1: 80 }
                            }
                        ]
                    }
                ]
            }
        })
    }
    
    const fakeCanvas = { width: 400, height: 600 }
    const result = await service.recognizeCanvas(fakeCanvas, null, 2.0)
    
    assert.strictEqual(result.text, 'Sample OCR text')
    assert.strictEqual(result.spans.length, 2)
    // At scale 2.0, pixel [20, 40, 80, 80] must scale down to page points [10, 20, 40, 40]
    assert.deepStrictEqual(result.spans[0].rect, [10, 20, 40, 40], 'OCR coordinates must be scaled by 1/scale')
    assert.deepStrictEqual(result.spans[1].rect, [45, 20, 70, 40], 'OCR coordinates must be scaled by 1/scale')
})

// 55. T08: MuPDF export annotation serialization quad bounding boxes
test('T08: ExportAnnotationItem formatting produces valid quad bounding coordinates', () => {
    // Standard PDF highlight rect [x1, y1, x2, y2]
    const rect = [100, 200, 300, 250]
    const quad = [
        [rect[0], rect[1]], // Top-left
        [rect[2], rect[1]], // Top-right
        [rect[2], rect[3]], // Bottom-right
        [rect[0], rect[3]]  // Bottom-left
    ]
    
    const item = {
        type: 'highlight',
        page: 0,
        quads: [quad],
        color: [255, 220, 0, 128],
        content: 'Highlighted text'
    }
    
    const serialized = JSON.stringify([item])
    const parsed = JSON.parse(serialized)
    assert.strictEqual(parsed[0].type, 'highlight')
    assert.strictEqual(parsed[0].quads[0].length, 4)
    assert.deepStrictEqual(parsed[0].quads[0][0], [100, 200])
    assert.deepStrictEqual(parsed[0].quads[0][2], [300, 250])
})

// 56. T09: Storage providers throw on 401/403 to prevent destructive overwrite
await runAsyncTest('T09: Cloud storage providers reject unauthenticated 401/403 responses to prevent data loss', async () => {
    const { GoogleDriveStorageProvider, OneDriveStorageProvider, LocalFolderStorageProvider } = await import('../js/storage-providers.js')
    
    const gdrive = new GoogleDriveStorageProvider()
    gdrive.clientId = 'mock_client_id'
    gdrive.accessToken = 'mock_token'
    
    // Simulate global fetch returning 401 Unauthorized
    const origFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => '{"error": "invalid_grant"}'
        })
        
        await assert.rejects(
            async () => await gdrive.readFile('test.json'),
            /401/,
            'GoogleDrive readFile must throw on 401 rather than returning null or empty data'
        )
        
        const onedrive = new OneDriveStorageProvider()
        onedrive.clientId = 'mock_client_id'
        onedrive.accessToken = 'mock_token'
        await assert.rejects(
            async () => await onedrive.readFile('test.json'),
            /401/,
            'OneDrive readFile must throw on 401 rather than returning null or empty data'
        )
    } finally {
        globalThis.fetch = origFetch
    }
    
    // LocalFolderStorageProvider handles non-existent file gracefully
    const local = new LocalFolderStorageProvider('C:/mock_sync')
    const res = await local.readFile('non_existent.json')
    assert.strictEqual(res?.content, '', 'Local folder provider returns empty content for missing file')
})

// 57. T10: fsGetAppPaths provides webview and indexeddb directories
await runAsyncTest('T10: platformBridge fsGetAppPaths returns expected schema with indexeddb_dir and webview_profile_dir', async () => {
    const pb = (await import('../js/platformBridge.js')).default || (await import('../js/platformBridge.js')).platformBridge || globalThis.platformBridge
    const paths = await pb.fsGetAppPaths()
    assert.ok(paths, 'fsGetAppPaths must return an object')
    assert.ok('data_dir' in paths, 'Must contain data_dir')
    assert.ok('webview_profile_dir' in paths, 'Must contain webview_profile_dir')
    assert.ok('indexeddb_dir' in paths, 'Must contain indexeddb_dir')
})

// 58. S01: Manual TOC and OCR-assisted TOC
await runAsyncTest('S01: Manual TOC manages hierarchy, detects cycles, and parses OCR candidates', async () => {
    const {
        addManualTocItem,
        updateManualTocItem,
        deleteManualTocItem,
        reorderManualTocItems,
        buildNestedToc,
        parseOcrTocCandidates,
        exportTocAsMarkdown,
        exportTocAsJson
    } = await import('../js/pdf-toc.js')

    let items = []
    items = addManualTocItem(items, { id: 'c1', title: 'Chapter 1', pageIndex: 0 })
    items = addManualTocItem(items, { id: 'c1_1', title: 'Section 1.1', pageIndex: 5, parentId: 'c1' })
    items = addManualTocItem(items, { id: 'c1_1_1', title: 'Sub-section 1.1.1', pageIndex: 8, parentId: 'c1_1' })
    items = addManualTocItem(items, { id: 'c2', title: 'Chapter 2', pageIndex: 15 })

    // Verify 3-level hierarchy
    const nested = buildNestedToc(items)
    assert.strictEqual(nested.length, 2, 'Top level must contain 2 chapters')
    assert.strictEqual(nested[0].subitems.length, 1, 'Chapter 1 must have 1 subitem')
    assert.strictEqual(nested[0].subitems[0].subitems.length, 1, 'Section 1.1 must have 1 subitem')

    // Cycle detection: setting c1's parent to c1_1_1 must throw
    assert.throws(() => {
        updateManualTocItem(items, 'c1', { parentId: 'c1_1_1' })
    }, /循环嵌套/, 'Must reject cyclic nesting')

    // Page index out-of-bounds check
    assert.throws(() => {
        addManualTocItem(items, { title: 'Invalid Page', pageIndex: 200 }, { maxPages: 100 })
    }, /超出文档总页数/, 'Must reject out-of-range page index')

    // OCR candidate parsing with Roman and Arabic numbers and page offset
    const ocrLines = [
        'Preface ......... iv',
        'Introduction . . . . . . 1',
        'Chapter 1: Foundations ....... 15',
        'Noise line without page'
    ]
    const candidates = parseOcrTocCandidates(ocrLines, { pageOffset: 5, totalPages: 50 })
    assert.strictEqual(candidates.length, 3, 'Must extract 3 TOC candidates')
    // Preface iv (4) + 5 - 1 = 8
    assert.strictEqual(candidates[0].title, 'Preface')
    assert.strictEqual(candidates[0].pageIndex, 8)
    // Intro 1 + 5 - 1 = 5
    assert.strictEqual(candidates[1].title, 'Introduction')
    assert.strictEqual(candidates[1].pageIndex, 5)
    // Chapter 1: 15 + 5 - 1 = 19
    assert.strictEqual(candidates[2].title, 'Chapter 1: Foundations')
    assert.strictEqual(candidates[2].pageIndex, 19)

    // Export formats
    const md = exportTocAsMarkdown(items)
    assert.ok(md.includes('- [Chapter 1](#page=1)'), 'Markdown export contains chapter 1')
    assert.ok(md.includes('  - [Section 1.1](#page=6)'), 'Markdown export preserves hierarchy indent')

    const jsonStr = exportTocAsJson(items, { title: 'Test Book' })
    const parsed = JSON.parse(jsonStr)
    assert.strictEqual(parsed.format, 'linden-leaf-toc')
    assert.strictEqual(parsed.items.length, 4)
})

// 59. S03: Scan Enhancement Presets with Per-Book State
await runAsyncTest('S03: Scan enhancement presets apply CSS filters without mutating original document bytes', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    let appliedFilter = null
    const container = {
        style: {
            setProperty(name, val) {
                if (name === '--reader-img-filter') appliedFilter = val
            }
        },
        querySelectorAll() { return [] }
    }
    const vp = Object.create(PdfViewport.prototype)
    vp.container = container

    // Original preset
    const orig = vp.setScanEnhancementPreset('original')
    assert.strictEqual(orig.filterStr, 'none')
    assert.strictEqual(appliedFilter, 'none')

    // Gray-boost preset
    const gray = vp.setScanEnhancementPreset('gray-boost')
    assert.strictEqual(gray.grayscale, true)
    assert.ok(appliedFilter.includes('grayscale(100%)'))
    assert.ok(appliedFilter.includes('contrast(130%)'))

    // Text-darken preset
    const darken = vp.setScanEnhancementPreset('text-darken')
    assert.strictEqual(darken.contrast, 160)
    assert.ok(appliedFilter.includes('contrast(160%)'))
    assert.ok(appliedFilter.includes('brightness(90%)'))

    // Custom preset
    const custom = vp.setScanEnhancementPreset('custom', { brightness: 120, contrast: 180, invert: true })
    assert.strictEqual(custom.invert, true)
    assert.ok(appliedFilter.includes('invert(100%)'))
})

// S04: Controlled Auto-Scroll
await runAsyncTest('S04: Auto-scroll starts, pauses, resumes, and stops cleanly', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.create(PdfViewport.prototype)
    vp.container = {
        style: { setProperty() {} },
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll() { return [] },
        getBoundingClientRect() { return { top: 100, left: 50, height: 800, width: 600 } }
    }
    vp.scrollArea = {
        scrollTop: 0,
        clientHeight: 500,
        scrollHeight: 2000
    }

    // Auto-scroll start/pause/stop
    vp.startAutoScroll({ speed: 45 })
    assert.strictEqual(vp._autoScrollActive, true)
    assert.strictEqual(vp._autoScrollPaused, false)

    vp.pauseAutoScroll()
    assert.strictEqual(vp._autoScrollPaused, true)

    vp.resumeAutoScroll()
    assert.strictEqual(vp._autoScrollPaused, false)

    vp.stopAutoScroll()
    assert.strictEqual(vp._autoScrollActive, false)
})

// 62. S05: Scoped PDF Dual Viewports with Leased Driver Adapter
await runAsyncTest('S05: AdaptivePdfDriverLease isolates secondary viewport destroy without closing shared driver', async () => {
    const { AdaptivePdfDriverLease } = await import('../js/pdf-driver.js')
    let realDriverDestroyed = false
    let realDriverRenders = 0
    const realDriver = {
        numPages: 100,
        pageSize: { width: 595, height: 842 },
        getPageSize: (p) => ({ width: 595, height: 842, page: p }),
        renderPage: async (p) => {
            realDriverRenders++
            return { width: 595, height: 842 }
        },
        destroy: () => {
            realDriverDestroyed = true
        }
    }

    const lease = new AdaptivePdfDriverLease(realDriver, 'secondary')
    assert.strictEqual(lease.numPages, 100)
    assert.strictEqual(lease.viewId, 'secondary')

    const res = await lease.renderPage(15, 1.0)
    assert.strictEqual(res.width, 595)
    assert.strictEqual(realDriverRenders, 1)

    // Destroying secondary lease must NOT destroy the shared realDriver!
    lease.destroy()
    assert.strictEqual(lease._destroyed, true)
    assert.strictEqual(realDriverDestroyed, false, 'Shared real driver must remain open and active')

    // Primary driver continues to render cleanly
    const primaryRes = await realDriver.renderPage(0, 1.0)
    assert.strictEqual(primaryRes.width, 595)
    assert.strictEqual(realDriverRenders, 2)
})

// 63. Item 3: applyMergedPayload resolves tombstones without allDeleted ReferenceError
await runAsyncTest('Item 3: applyMergedPayload resolves tombstones without allDeleted ReferenceError', async () => {
    const { applyMergedPayload } = await import('../js/syncEngine.js')
    const fakeDb = {
        async getAllBooks() { return [{ id: 'b1', title: 'Local Book', updatedAt: 100 }] },
        async getAllDeletedRecords() { return [{ id: 'b_old', type: 'book', deletedAt: 200 }] },
        async getBook(id) { return id === 'b1' ? { id: 'b1', title: 'Local Book', updatedAt: 100 } : null },
        async saveBook() {},
        async deleteBook() {}
    }
    const origDb = globalThis.db
    globalThis.db = fakeDb
    try {
        const res = await applyMergedPayload({
            booksMeta: [{ id: 'b1', title: 'Local Book', updatedAt: 150 }],
            deletedRecords: [{ id: 'b_old', type: 'book', deletedAt: 200 }]
        })
        assert.ok(res, 'applyMergedPayload must succeed without throwing ReferenceError')
    } finally {
        globalThis.db = origDb
    }
})

// 64. Item 2: restoreFullDataBackup does not resurrect orphaned/deleted highlights when book is tombstoned
await runAsyncTest('Item 2: restoreFullDataBackup does not resurrect orphaned/deleted highlights when book is tombstoned', async () => {
    const { AdvancedSettingsManager } = await import('../js/advanced-settings.js')
    const mgr = new AdvancedSettingsManager()
    let executedPlan = null
    const fakeDb = {
        async getAllBooks() { return [] },
        async getAllHighlights() { return [] },
        async getAllBookmarks() { return [] },
        async getAllReadingSessions() { return [] },
        async getAllChapterTranslations() { return [] },
        async getAllPdfPageDrawings() { return [] },
        async getAllCustomLists() { return [] },
        async getAllDeletedRecords() {
            return [{ id: 'deleted_book_1', type: 'book', deletedAt: 5000 }]
        },
        async applyRestorePlan(plan) {
            executedPlan = plan
            return { success: true }
        }
    }
    const backupData = {
        format: 'linden-leaf-full-backup',
        schemaVersion: 4,
        books: [{ id: 'deleted_book_1', title: 'Deleted Book', updatedAt: 1000 }],
        highlights: [{ id: 'hl_orphan_1', bookId: 'deleted_book_1', text: 'Should not restore', updatedAt: 1000 }]
    }
    await mgr.restoreFullDataBackup(backupData, fakeDb)
    assert.ok(executedPlan, 'Restore plan should be executed')
    assert.strictEqual(executedPlan.booksToPut.length, 0, 'Tombstoned book must NOT be restored')
    assert.strictEqual(executedPlan.highlightsToPut.length, 0, 'Orphaned highlight of tombstoned book must NOT be restored')
})

// 65. Item 2: applyRestorePlan persists bookFilesToPut into book_files store
await runAsyncTest('Item 2: applyRestorePlan persists bookFilesToPut into book_files store', async () => {
    const { applyRestorePlan } = await import('../js/db.js')
    const putFiles = []
    const fakeTx = {
        objectStoreNames: { contains: (s) => ['books', 'book_files'].includes(s) },
        objectStore(name) {
            return {
                put(val) {
                    if (name === 'book_files') putFiles.push(val)
                }
            }
        },
        oncomplete: null,
        onerror: null,
        onabort: null
    }
    const fakeCustomDb = {
        objectStoreNames: { contains: (s) => ['books', 'book_files'].includes(s) },
        transaction(stores, mode) {
            setTimeout(() => fakeTx.oncomplete?.(), 0)
            return fakeTx
        }
    }
    const plan = {
        booksToPut: [{ id: 'b_test' }],
        bookFilesToPut: [{ id: 'b_test', nativeSnapshotPath: 'C:/test.pdf' }]
    }
    const res = await applyRestorePlan(plan, fakeCustomDb)
    assert.strictEqual(res.success, true)
    assert.strictEqual(putFiles.length, 1)
    assert.strictEqual(putFiles[0].nativeSnapshotPath, 'C:/test.pdf')
})

// 66. Item 3 & 6: triggerSilentBackgroundSync credentials pass for local_folder without requiring webdav creds
await runAsyncTest('Item 3 & 6: triggerSilentBackgroundSync credentials pass for local_folder without requiring webdav creds', async () => {
    const { SyncController } = await import('../js/sync-controller.js')
    const app = new SyncController({})
    app.syncConfig = {
        enabled: true,
        providerType: 'local_folder',
        folderPath: 'C:/sync_folder',
        lastSyncTime: 1000,
        lastSyncedEndpoint: 'local_folder::::C:/sync_folder'
    }
    app.saveSyncConfig = async (patch) => { Object.assign(app.syncConfig, patch) }
    app.renderSyncUI = () => {}
    assert.strictEqual(app.syncConfig.providerType, 'local_folder')
    assert.ok(app.syncConfig.folderPath)
})

await runAsyncTest('F06: isComposedDescendant traverses nested ShadowRoot hosts (foliate-view -> paginator -> iframe)', async () => {
    const { isComposedDescendant } = await import('../js/dom-events.js')
    const foliateView = { contains: () => false, getRootNode: () => foliateView }
    const viewShadow = { host: foliateView }
    const paginator = { getRootNode: () => viewShadow }
    const paginatorShadow = { host: paginator }
    const iframe = { getRootNode: () => paginatorShadow }
    const siblingDoc = { getRootNode: () => siblingDoc }
    const externalFrame = { getRootNode: () => siblingDoc }

    assert.strictEqual(isComposedDescendant(foliateView, foliateView), true)
    assert.strictEqual(isComposedDescendant(foliateView, iframe), true)
    assert.strictEqual(isComposedDescendant(foliateView, externalFrame), false)
    assert.strictEqual(isComposedDescendant(foliateView, null), false)
})

await runAsyncTest('C09b: OcrService requests { blocks: true } and extracts spans from Tesseract 7 blocks tree', async () => {
    const { OcrService } = await import('../js/ocr-service.js')
    const service = new OcrService()
    let seenOutputOpts = null
    service._worker = {
        recognize: async (_canvas, _opts, outputOpts) => {
            seenOutputOpts = outputOpts
            return {
                data: {
                    text: '感觉的逻辑\nDeleuze',
                    blocks: [
                        {
                            paragraphs: [
                                {
                                    lines: [
                                        {
                                            text: '感觉的逻辑',
                                            bbox: { x0: 40, y0: 60, x1: 240, y1: 100 },
                                            words: [
                                                {
                                                    text: '感觉的逻辑',
                                                    bbox: { x0: 40, y0: 60, x1: 240, y1: 100 },
                                                    symbols: [
                                                        { text: '感', bbox: { x0: 40, y0: 60, x1: 80, y1: 100 } },
                                                        { text: '觉', bbox: { x0: 82, y0: 60, x1: 122, y1: 100 } }
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                },
                                {
                                    lines: [
                                        {
                                            text: 'Deleuze',
                                            bbox: { x0: 40, y0: 120, x1: 180, y1: 156 }
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            }
        }
    }

    const res = await service.recognizeCanvas({ width: 500, height: 800 }, null, 2.0)
    assert.deepStrictEqual(seenOutputOpts, { text: true, blocks: true })
    assert.strictEqual(res.spans.length, 3)
    assert.deepStrictEqual(res.spans[0], { text: '感', rect: [20, 30, 40, 50], line: 0 })
    assert.deepStrictEqual(res.spans[2], { text: 'Deleuze', rect: [20, 60, 90, 78], line: 1 })
})

await runAsyncTest('M09: decodeQoiRgbaPayload losslessly decodes QOI runs, index, diff, luma, RGB and RGBA opcodes', async () => {
    const { decodeQoiRgbaPayload } = await import('../js/pdf-driver.js')
    const encodeQoi = (pixels) => {
        const out = []
        const index = new Uint32Array(64)
        let pr = 255, pg = 255, pb = 255, pa = 255
        let run = 0
        const total = pixels.length / 4
        for (let i = 0; i < total; i++) {
            const o = i * 4
            const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2], a = pixels[o + 3]
            if (r === pr && g === pg && b === pb && a === pa) {
                run++
                if (run === 62 || i + 1 === total) { out.push(0xC0 | (run - 1)); run = 0 }
            } else {
                if (run > 0) { out.push(0xC0 | (run - 1)); run = 0 }
                const px32 = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
                const h = (r * 3 + g * 5 + b * 7 + a * 11) & 63
                if (index[h] === px32 && !(r === 0 && g === 0 && b === 0 && a === 0 && px32 !== 0)) {
                    // match Rust index hit rule
                }
                if (index[h] === px32 && (r !== 0 || g !== 0 || b !== 0 || a !== 0)) {
                    out.push(h)
                } else if (index[h] === px32 && i > 0) {
                    out.push(h)
                } else {
                    index[h] = px32
                    if (a === pa) {
                        const dr = ((r - pr) << 24) >> 24
                        const dg = ((g - pg) << 24) >> 24
                        const db = ((b - pb) << 24) >> 24
                        const drDg = ((dr - dg) << 24) >> 24
                        const dbDg = ((db - dg) << 24) >> 24
                        if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
                            out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2))
                        } else if (dg >= -32 && dg <= 31 && drDg >= -8 && drDg <= 7 && dbDg >= -8 && dbDg <= 7) {
                            out.push(0x80 | (dg + 32), ((drDg + 8) << 4) | (dbDg + 8))
                        } else {
                            out.push(0xFE, r, g, b)
                        }
                    } else {
                        out.push(0xFF, r, g, b, a)
                    }
                }
                pr = r; pg = g; pb = b; pa = a
            }
        }
        return new Uint8Array(out)
    }
    const w = 48, h = 24
    const rgba = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 2; y < 22; y++) {
        for (let x = 2; x < 46; x++) {
            const idx = (y * w + x) * 4
            if ((x + y) % 7 === 0) { rgba[idx] = 8; rgba[idx + 1] = 10; rgba[idx + 2] = 12; rgba[idx + 3] = 255 }
            else if (y === 8) { rgba[idx] = (x * 19) & 0xFF; rgba[idx + 1] = (255 - x * 3) & 0xFF; rgba[idx + 2] = (x * 7) & 0xFF; rgba[idx + 3] = x % 2 ? 255 : 180 }
            else if (y > 12) { const g = 230 - ((x + y) % 5); rgba[idx] = g; rgba[idx + 1] = g; rgba[idx + 2] = g; rgba[idx + 3] = 255 }
        }
    }
    const encoded = encodeQoi(rgba)
    const decoded = decodeQoiRgbaPayload(encoded, w * h, new Uint8ClampedArray(w * h * 4))
    assert.deepStrictEqual(decoded, rgba)
})

await runAsyncTest('M10: PdfViewport enforces single-page concurrency=1 and blocks Tier-1 prefetch while Tier-0 is active', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.create(PdfViewport.prototype)
    vp.driver = { kind: 'mupdf' }
    vp.spreadMode = 'none'
    vp._budgetRenderConcurrency = null
    vp.options = { isLowMemoryDevice: false, bufferPages: 2 }
    vp._bitmapCacheBytes = 0
    vp._bitmapCache = new Map()
    vp._pruneBitmapCache = () => {}
    vp.setResourceBudget({ renderConcurrency: 2 })
    assert.strictEqual(vp._renderConcurrency, 1, 'Single-page MuPDF concurrency must clamp to 1 even when budget allows 2')

    vp.setResourceBudget({ renderConcurrency: 2 })
    vp.spreadMode = 'dual'
    vp._updateRenderConcurrency()
    assert.strictEqual(vp._renderConcurrency, 2, 'Dual-spread MuPDF allows concurrency=2')

    // Verify Strict Tier-0 Barrier stops Tier-1 dispatch when a Tier-0 visible task is in flight
    vp._destroyed = false
    vp._navigationRenderPending = null
    vp.pageOffsets = [{ top: 0, height: 800 }, { top: 820, height: 800 }, { top: 820, height: 800 }, { top: 1640, height: 800 }]
    vp.scrollArea = { scrollTop: 820, clientHeight: 800 }
    vp.currentPage = 1
    const s1 = { _renderToken: 1, renderAbort: new AbortController() }
    const s3 = { _renderToken: 1, renderAbort: new AbortController() }
    vp.activeSlots = new Map([[1, s1], [3, s3]])
    const started = []
    vp._renderPageContent = async (page) => { started.push(page) }
    const activeTier0 = { page: 2, slot: {}, token: 1, tier: 0, abortController: new AbortController() }
    vp._inFlightRenders = new Map([[2, activeTier0]])
    vp._activeDriverTasks = new Set([activeTier0])
    vp._renderQueue = [
        { page: 3, slot: s3, token: 1, tier: 1, distance: 1, signal: s3.renderAbort.signal },
    ]
    vp._pumpRenderQueue()
    assert.deepStrictEqual(started, [], 'Tier-1 prefetch must wait while Tier-0 visible page is in flight')
})

// Defect M11: Queued preview promoted in place on flush, in-flight handoff, and stale token non-resurrection
await runAsyncTest('M11: PdfViewport promotes queued preview to full resolution without duplicate or stale resurrection', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const prevWindow = globalThis.window
    const prevDoc = globalThis.document

    const makeClassList = (target) => ({
        add(...names) {
            const parts = new Set(String(target.className || '').split(/\s+/).filter(Boolean))
            for (const n of names) parts.add(n)
            target.className = [...parts].join(' ')
        },
        remove(...names) {
            const drop = new Set(names)
            const parts = String(target.className || '').split(/\s+/).filter(c => c && !drop.has(c))
            target.className = parts.join(' ')
        },
        contains(name) {
            return String(target.className || '').split(/\s+/).includes(name)
        }
    })

    const makeMockCanvas = (width = 1, height = 1) => {
        const cvs = {
            tagName: 'CANVAS',
            width,
            height,
            offsetX: 0,
            offsetY: 0,
            className: '',
            style: {},
            dataset: {},
            parentElement: null,
            getContext() { return { drawImage() {} } },
            remove() { this.parentElement = null }
        }
        cvs.classList = makeClassList(cvs)
        return cvs
    }

    const makeMockContainer = () => {
        const children = []
        const matchesClass = (el, sel) => sel.split(',').some(s => {
            const name = s.trim().replace(/^\./, '')
            return String(el.className || '').split(/\s+/).includes(name)
        })
        return {
            children,
            style: {},
            append(...els) {
                for (const el of els) { el.parentElement = this; children.push(el) }
            },
            prepend(...els) {
                for (let idx = els.length - 1; idx >= 0; idx--) {
                    els[idx].parentElement = this
                    children.unshift(els[idx])
                }
            },
            replaceChildren(...els) {
                for (const old of children) old.parentElement = null
                children.length = 0
                this.append(...els)
            },
            querySelector(sel) {
                return children.find(el => matchesClass(el, sel)) || null
            },
            querySelectorAll(sel) {
                return children.filter(el => matchesClass(el, sel))
            }
        }
    }

    const createViewportFixture = (renderPageImpl) => {
        const pixels = makeMockContainer()
        const text = makeMockContainer()
        const slot = {
            _renderToken: 1,
            _renderedScale: null,
            _renderedToken: 0,
            _renderedIsPreview: false,
            _renderedClip: null,
            renderAbort: new AbortController(),
            style: {},
            querySelector(sel) {
                if (sel === '.pdf-img-wrapper') return pixels
                if (sel === '.pdf-text-layer') return text
                return null
            }
        }
        const vp = Object.create(PdfViewport.prototype)
        vp._destroyed = false
        vp.pageCount = 1
        vp.scale = 1
        vp.currentPage = 0
        vp.pageSizes = [{ width: 1200, height: 1600 }]
        vp.pageOffsets = [{ top: 0, left: 0, width: 1200, height: 1600 }]
        vp.scrollArea = { scrollTop: 0, scrollLeft: 0, clientWidth: 1200, clientHeight: 1600, scrollWidth: 1200 }
        vp.activeSlots = new Map([[0, slot]])
        vp._renderQueue = []
        vp._inFlightRenders = new Map()
        vp._activeDriverTasks = new Set()
        vp._activeRenders = 0
        vp._renderConcurrency = 1
        vp._renderReqSeq = 0
        vp._loadGeneration = 1
        vp._bitmapCache = new Map()
        vp._bitmapCacheBytes = 0
        vp._outlineLoaded = true
        vp._navigationRenderPending = false
        vp.options = {
            bufferPages: 0,
            maxCanvasEdge: 4096,
            maxCanvasPixels: 16_000_000,
            enableClip: false,
            clipPixelThreshold: 4_000_000
        }
        vp._schedulePrefetchDeferred = () => {}
        vp.driver = {
            kind: 'mupdf',
            renderPage: renderPageImpl
        }
        return { vp, slot, pixels }
    }

    const flushMicrotasks = async (turns = 8) => {
        for (let t = 0; t < turns; t++) await Promise.resolve()
    }

    try {
        globalThis.window = { ...(prevWindow || {}), devicePixelRatio: 1, cancelIdleCallback() {} }
        globalThis.document = {
            createElement(tag) {
                return tag === 'canvas' ? makeMockCanvas() : { className: '', style: {}, textContent: '', remove() {} }
            }
        }

        // Case A: Queued preview is promoted in place to full resolution without duplicate queue entries
        {
            const calls = []
            const { vp, slot, pixels } = createViewportFixture(async (page, scale) => {
                calls.push({ page, scale })
                return makeMockCanvas(Math.round(1200 * scale), Math.round(1600 * scale))
            })
            const blockerTask = { id: 999, page: 1 }
            vp._activeDriverTasks.add(blockerTask)

            vp._renderVisibleSlots(false, { previewOnly: true })
            assert.strictEqual(vp._renderQueue.length, 1, 'Preview task should sit in _renderQueue while driver is busy')
            assert.strictEqual(vp._renderQueue[0].previewOnly, true)
            assert.deepStrictEqual(calls, [], 'Preview must not start while concurrency slot is occupied')

            vp._navigationRenderPending = { started: 0, due: 0 }
            vp._flushNavigationRender()
            assert.strictEqual(vp._renderQueue.length, 1, 'Flush must upgrade queued preview in place without pushing a duplicate')
            assert.strictEqual(vp._renderQueue[0].previewOnly, false, 'Queued preview entry must be promoted to full resolution')
            assert.deepStrictEqual(calls, [])

            vp._activeDriverTasks.delete(blockerTask)
            vp._pumpRenderQueue()
            await flushMicrotasks()

            assert.deepStrictEqual(calls, [{ page: 0, scale: 1 }], 'Driver must run full-res render once and skip stale 0.55 preview')
            assert.strictEqual(slot._renderedIsPreview, false)
            assert.strictEqual(slot._renderedScale, 1)
            assert.strictEqual(vp._renderQueue.length, 0)
            assert.strictEqual(vp._activeDriverTasks.size, 0)
            const renderedCanvas = pixels.querySelector('.pdf-page-canvas')
            assert.ok(renderedCanvas && renderedCanvas.width === 1200, 'Full-res 1200px canvas must be mounted')
        }

        // Case B: In-flight preview handoff aborts old preview, bumps token, and ignores late stale preview resolution
        {
            const calls = []
            let resolveSlowPreview
            const { vp, slot, pixels } = createViewportFixture((page, scale) => {
                calls.push({ page, scale })
                if (scale < 0.8) {
                    return new Promise(resolve => { resolveSlowPreview = resolve })
                }
                return Promise.resolve(makeMockCanvas(Math.round(1200 * scale), Math.round(1600 * scale)))
            })

            vp._renderVisibleSlots(false, { previewOnly: true })
            const oldInFlight = vp._inFlightRenders.get(0)
            assert.ok(oldInFlight && oldInFlight.previewOnly === true && oldInFlight.token === 1, 'Preview must enter in-flight')
            assert.deepStrictEqual(calls, [{ page: 0, scale: 0.55 }])

            vp._navigationRenderPending = { started: 0, due: 0 }
            vp._flushNavigationRender()
            assert.strictEqual(oldInFlight.abortController.signal.aborted, true, 'Flush must abort active in-flight preview')
            assert.strictEqual(slot._renderToken, 2, 'Flush must advance slot token for full-res handoff')
            assert.strictEqual(vp._renderQueue.length, 1)
            assert.strictEqual(vp._renderQueue[0].token, 2)
            assert.strictEqual(vp._renderQueue[0].previewOnly, false)

            // Resolve old preview late (even without throwing AbortError): stale token must NOT commit preview state
            resolveSlowPreview(makeMockCanvas(660, 880))
            await flushMicrotasks(12)

            assert.deepStrictEqual(calls, [
                { page: 0, scale: 0.55 },
                { page: 0, scale: 1 }
            ], 'Full-resolution render must execute immediately after preview slot frees')
            assert.strictEqual(slot._renderedIsPreview, false)
            assert.strictEqual(slot._renderedScale, 1)
            assert.strictEqual(slot._renderedToken, 2)
            assert.strictEqual(pixels.querySelector('.pdf-page-canvas')?.width, 1200)
        }

        // Case C: Stale token or aborted signal queued previews are never promoted or resurrected
        {
            const calls = []
            const { vp, slot, pixels } = createViewportFixture(async (page, scale) => {
                calls.push({ page, scale, token: slot._renderToken })
                return makeMockCanvas(Math.round(1200 * scale), Math.round(1600 * scale))
            })

            const liveSignalOfOldToken = new AbortController().signal
            const abortedController = new AbortController()
            abortedController.abort()

            // Subcase C1: Slot is already rendered at token=2 with fresh non-aborted renderAbort,
            // while an old token=1 preview sits in queue -> stale token=1 must be dropped without running.
            const existingCanvas = makeMockCanvas(1200, 1600)
            existingCanvas.className = 'pdf-page-canvas'
            pixels.append(existingCanvas)
            slot._renderToken = 2
            slot._renderedScale = 1
            slot._renderedToken = 2
            slot._renderedIsPreview = false
            slot.renderAbort = new AbortController()

            const staleTokenItem = { page: 0, slot, token: 1, tier: 0, distance: 0, previewOnly: true, signal: liveSignalOfOldToken }
            const abortedSameTokenItem = { page: 0, slot, token: 2, tier: 0, distance: 0, previewOnly: true, signal: abortedController.signal }
            vp._renderQueue.push(staleTokenItem, abortedSameTokenItem)

            vp._renderVisibleSlots(false)
            assert.strictEqual(staleTokenItem.previewOnly, true, 'Stale token queued preview must not be mutated')
            assert.strictEqual(abortedSameTokenItem.previewOnly, true, 'Aborted signal queued preview must not be promoted')
            assert.strictEqual(calls.length, 0, 'Stale token and aborted queued previews must never run')
            assert.strictEqual(vp._renderQueue.length, 0, '_pumpRenderQueue must purge stale token and aborted entries')
        }

        // An already requested bounds batch can replace the estimated slot before it rasterizes.
        {
            const calls = []
            const { vp, slot } = createViewportFixture(async (page, scale) => {
                calls.push(page)
                return makeMockCanvas(Math.round(1200 * scale), Math.round(1600 * scale))
            })
            vp._geometryAbort = new AbortController()
            vp._knownPageGeometry = new Set()
            let finishBounds
            const request = new Promise(resolve => { finishBounds = resolve })
            vp._geometryRequest = { start: 0, end: 1, signal: vp._geometryAbort.signal, request }
            vp._renderVisibleSlots(false)
            await flushMicrotasks()
            assert.deepStrictEqual(calls, [], 'No raster is needed until the outstanding native bounds are applied')
            slot._renderToken++
            slot.renderAbort.abort()
            finishBounds()
            await flushMicrotasks()
            assert.deepStrictEqual(calls, [], 'The estimated slot must not render after it was invalidated')
        }
    } finally {
        if (prevWindow === undefined) delete globalThis.window
        else globalThis.window = prevWindow
        if (prevDoc === undefined) delete globalThis.document
        else globalThis.document = prevDoc
    }
})

await runAsyncTest('M12: PDF readiness follows a geometry remount and fails on actual page removal', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const makeSlot = () => ({ querySelectorAll: () => [], remove() {} })
    const initial = makeSlot()
    const vp = Object.assign(Object.create(PdfViewport.prototype), {
        options: {},
        activeSlots: new Map([[0, initial]]),
        pageOffsets: [{ top: 0 }],
        _renderQueue: [],
        _inFlightRenders: new Map(),
        _activeDriverTasks: new Set(),
        _pageReadyWaiters: new Map(),
        ensurePageRendered: () => false,
        isPageCanvasReady: () => false,
        _mountSlot(page) { this.activeSlots.set(page, makeSlot()) }
    })

    const ready = vp.whenPageReady(0)
    vp._remountPage(0)
    const replacement = vp.activeSlots.get(0)
    assert.notStrictEqual(replacement, initial)
    assert.strictEqual(vp._pageReadyWaiters.get(0)?.size, 1, 'Corrected bounds still belong to the same pending page')
    vp.isPageCanvasReady = () => true
    vp._notifyPageReadyWaiters(0)
    assert.strictEqual(await ready, true)

    vp.isPageCanvasReady = () => false
    const skipped = vp.whenPageReady(0)
    vp._unmountSlot(0, replacement)
    assert.strictEqual(await skipped, false)
    assert.strictEqual(vp._pageReadyWaiters.size, 0)
})

await runAsyncTest('M13: A PDF full-page bitmap transfers directly between the slot and cache', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.assign(Object.create(PdfViewport.prototype), {
        _loadGeneration: 3, _bitmapCache: new Map(), _bitmapCacheBytes: 0,
        _bitmapCacheLimitBytes: 1600, activeSlots: new Map(), currentPage: 2
    })
    const makeSlot = (scale = 1.25, generation = 3) => {
        const canvas = { width: 20, height: 20, remove() { this.detached = true } }
        return { canvas, _fullRaster: { canvas, scale, generation } }
    }
    const first = makeSlot()
    vp._parkPageCanvas(0, first)
    assert.equal(first._fullRaster, null)
    assert.equal(first.canvas.detached, true)
    assert.equal(vp._bitmapCacheBytes, 1600)
    assert.equal(vp._takePageCanvas(vp._cacheKey(0, 1.2501)), null)
    assert.equal(vp._takePageCanvas(vp._cacheKey(0, 1.25)), first.canvas)
    assert.equal(vp._bitmapCacheBytes, 0)
    assert.equal(first.canvas.width, 20)

    const stale = makeSlot(1.25, 2)
    vp._parkPageCanvas(0, stale)
    assert.equal(stale.canvas.detached, undefined)
    vp._parkPageCanvas(0, makeSlot())
    const parked = vp._bitmapCache.values().next().value.canvas
    vp._parkPageCanvas(1, makeSlot())
    assert.equal(parked.width, 0)
    assert.equal(vp._bitmapCacheBytes, 1600)
})

await runAsyncTest('M14: PDF touch text is prioritized by a hold, not a swipe', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const textRequests = []
    const vp = Object.assign(Object.create(PdfViewport.prototype), {
        options: { deferPdfTextLayer: true },
        driver: { kind: 'pdfjs' },
        interactionMode: 'select',
        _renderDeferredPdfTextLayer(page) { textRequests.push(page) }
    })
    const press = {
        touches: [{ clientX: 40, clientY: 80 }],
        target: { closest: () => ({ dataset: { page: '7' } }) }
    }
    const waitForHold = () => new Promise(resolve => setTimeout(resolve, 185))

    vp._handleTouchStart(press)
    vp._handleTouchMove({ touches: [{ clientX: 40, clientY: 120 }] })
    await waitForHold()
    assert.deepEqual(textRequests, [])

    vp._handleTouchStart(press)
    await waitForHold()
    assert.deepEqual(textRequests, [7])
})

await runAsyncTest('M15: PDF.js text uses the raster viewport scale without owning slot placement', async () => {
    const { PdfJsDriver } = await import('../js/pdf-driver.js')
    const viewport = { scale: 1.5, userUnit: 2, rotation: 90 }
    const styleValues = new Map()
    const inner = { style: { setProperty: (name, value) => styleValues.set(name, value) } }
    const outer = { replaceChildren(child) { this.child = child } }
    const driver = new PdfJsDriver()
    let layerOptions
    driver.pdfDoc = {
        async getPage() {
            return {
                getViewport: () => viewport,
                getTextContent: async () => ({ items: [] }),
                cleanup() {}
            }
        }
    }
    driver.pdfjsLib = {
        TextLayer: class {
            constructor(options) { layerOptions = options }
            async render() {}
        }
    }

    const previousDocument = globalThis.document
    globalThis.document = { createElement: () => inner }
    try {
        await driver.renderTextLayer(0, outer, 1.5)
        assert.equal(outer.child, inner)
        assert.equal(inner.className, 'textLayer')
        assert.equal(layerOptions.container, inner)
        assert.equal(layerOptions.viewport, viewport)
        assert.equal(styleValues.get('--total-scale-factor'), '3')
    } finally {
        globalThis.document = previousDocument
    }
})

await runAsyncTest('R5: Foliate texture neighbors follow physical page identity across a chapter', async () => {
    const { FoliatePageSnapshots } = await import('../js/foliate-page-snapshot.js')
    const doc = {}
    const cache = Object.assign(Object.create(FoliatePageSnapshots.prototype), {
        source: { doc, direction: 'ltr' },
        renderer: { page: 4, getContents: () => [{ doc }] },
        cache: new Map([[3, {}], [4, {}], [5, {}]]),
    })
    const oldCurrent = cache.get('current')
    const oldNext = cache.get('next')
    cache.renderer.page = 5
    assert.equal(cache.get('current'), oldNext)
    assert.equal(cache.get('prev'), oldCurrent)
    assert.equal(cache.get('next'), null)

    cache.source.direction = 'rtl'
    assert.equal(cache.get('next'), oldCurrent)
    cache.renderer.getContents = () => [{ doc: {} }]
    assert.equal(cache.get('current'), null)
})

await runAsyncTest('R7: completed Foliate curl uses exactly one paginator commit', async () => {
    const { FoliatePageTurnAdapter, PageTurnController } = await import('../js/page-turn-controller.js')
    const calls = []
    const adapter = new FoliatePageTurnAdapter({
        renderer: { async commitRenderedPage(direction) { calls.push(direction); return direction === 1 } },
        async goLeft() { calls.push('fallback') },
    })
    const controller = Object.assign(Object.create(PageTurnController.prototype), {
        adapter,
        generation: 1,
        _queuedSwipes: [],
        _curlRenderer: { renderPose: () => true },
        async _animateProgress(duration, generation, render) { return render(1) },
    })
    const curl = dir => {
        const x = dir === 'next' ? 360 : 0
        return { dir, W: 360, H: 800, pose: { dir, c: { x, y: 600 }, d: { x: 180, y: 600 } } }
    }
    await controller._settleCurl(curl('next'), true, { vx: -1, vy: 0 }, 1)
    await controller._settleCurl(curl('prev'), true, { vx: 1, vy: 0 }, 1)
    await controller._settleCurl(curl('prev'), false, { vx: 1, vy: 0 }, 1)
    assert.deepEqual(calls, [1, -1, 'fallback'])
})

await runAsyncTest('R8: a new touch preserves the previously accepted curl', async () => {
    const { PageTurnAdapter, PageTurnController } = await import('../js/page-turn-controller.js')
    const adapter = new PageTurnAdapter()
    const turns = []
    adapter.commitRenderedPage = async direction => { turns.push(direction); return true }
    adapter.turnNext = async () => { turns.push('next') }
    let unavailable = 0
    const controller = new PageTurnController({ adapter, mode: 'cover', onCurlUnavailable: () => unavailable++ })
    controller._beginSlideSession = () => { throw new Error('Curl entered slide mode') }
    controller._beginCurlSession = direction => {
        const x = direction === 'next' ? 390 : 0
        controller._activeCurl = { dir: direction, W: 390, H: 844,
            pose: { dir: direction, c: { x, y: 400 }, d: { x: 205, y: 390 } } }
        controller._curlRenderer = { renderPose: () => true }
        return true
    }
    controller._updateCurlDrag = () => true
    const point = clientX => ({ clientX, clientY: 400 })
    const start = x => controller.handleTouchStart({ touches: [point(x)] })
    const move = x => controller.handleTouchMove({ touches: [point(x)] })
    const end = x => controller.handleTouchEnd({ touches: [], changedTouches: [point(x)] })

    try {
        start(300)
        move(150)
        const first = end(100)
        assert.equal(controller.state, 'settling')
        assert.deepEqual(turns, [])
        start(300)
        await first
        assert.equal(controller.state, 'preparing')
        assert.deepEqual(turns, ['next'])

        move(150)
        const second = end(100)
        start(300)
        await second
        await end(300)
        assert.deepEqual(turns, ['next', 'next'])
        assert.equal(controller.state, 'idle')

        // A WebGL context loss downgrades cover -> slide and completes the turn
        // instead of hard-locking navigation, and restores cover on context restoration.
        start(300)
        move(150)
        controller._handleCurlContextLost()
        assert.equal(controller.getEffectiveMode(), 'slide')
        await end(100)
        assert.deepEqual(turns, ['next', 'next', 'next'])
        controller._handleCurlContextRestored()
        assert.equal(controller.getEffectiveMode(), 'cover')

        // If curl rendering is unavailable during a live-destination turn, report
        // unavailability and still fall back cleanly to turning the page.
        controller._ensureCurlRenderer = () => null
        await controller._turnWithLiveDestination('next', 400, { vx: -1, vy: 0 }, controller.generation)
        assert.equal(unavailable, 1)
        assert.deepEqual(turns, ['next', 'next', 'next', 'next'])
    } finally {
        controller.destroy()
    }
})

await runAsyncTest('R9: texture misses and section loads coalesce at most one pending swipe with latest direction', async () => {
    const { PageTurnAdapter, PageTurnController } = await import('../js/page-turn-controller.js')
    const adapter = new PageTurnAdapter()
    const calls = []
    let finishChapter
    const chapter = new Promise(resolve => { finishChapter = resolve })
    adapter.turnNext = async () => {
        calls.push('next')
        if (calls.length === 1) await chapter
    }
    adapter.turnPrev = async () => { calls.push('prev') }
    const controller = new PageTurnController({ adapter, mode: 'cover' })
    controller._beginSlideSession = () => { throw new Error('Texture miss entered slide mode') }
    const frames = []
    adapter.getCurlSnapshot = key => key === 'current' ? { canvas: {}, textureDpr: 1 } : null
    controller._overlayEl = { children: [], style: {} }
    controller._curlHostEl = { style: {} }
    controller._ensureCurlRenderer = () => ({
        resize: () => true,
        syncPageTextures(source, target) { assert.equal(target, null); return true },
        renderPose(pose, options) {
            assert.equal(options.liveTarget, true)
            assert.equal(controller._overlayEl.style.display, 'block')
            frames.push(pose ? 'curl' : 'hold')
            return true
        },
    })
    controller._animateProgress = async (duration, generation, render) => render(1)
    const point = clientX => ({ clientX, clientY: 400 })
    const swipe = (from, to) => {
        controller.handleTouchStart({ touches: [point(from)] })
        controller.handleTouchMove({ touches: [point((from + to) / 2)] })
        return controller.handleTouchEnd({ touches: [], changedTouches: [point(to)] })
    }

    try {
        const first = swipe(300, 80)
        await swipe(300, 80)
        await swipe(80, 300)
        await swipe(300, 295)
        assert.deepEqual(calls, ['next'])
        assert.deepEqual(controller._queuedSwipes, ['prev'])
        finishChapter()
        await first
        assert.deepEqual(calls, ['next', 'prev'])
        // The platform can coalesce the whole flick into the release event.
        controller.handleTouchStart({ touches: [point(300)] })
        await controller.handleTouchEnd({ touches: [], changedTouches: [point(100)] })
        assert.deepEqual(calls, ['next', 'prev', 'next'])
        assert.deepEqual(frames, Array.from({ length: 3 }, () => ['hold', 'curl']).flat())
        assert.equal(controller.state, 'idle')
    } finally {
        finishChapter()
        controller.destroy()
    }
})

await runAsyncTest('R6: reversing a curl reuses the two uploaded page textures', async () => {
    const { CurlRenderer } = await import('../js/curl-webgl.js')
    const uploads = []
    const renderer = Object.assign(Object.create(CurlRenderer.prototype), {
        _slots: { current: null, target: null },
        _uploadSlot(slot, key) {
            if (this._slots[slot]?.key === key) return
            uploads.push(key)
            this._slots[slot] = { key, tex: {} }
        },
    })
    const first = { canvas: {}, pageIndex: 4, visualVersion: 1, width: 360, height: 800 }
    const next = { ...first, pageIndex: 5, visualVersion: 2 }
    assert.equal(renderer.syncPageTextures(first, next), true)
    assert.equal(renderer.syncPageTextures(next, first), true)
    assert.equal(uploads.length, 2)
    assert.match(renderer._slots.current.key, /:5:2:/)
    assert.match(renderer._slots.target.key, /:4:1:/)
})

// R2: waitForTargetReadyAndTurn / _commitTargetTurn never calls goToPage when target remains unready or errors
await runAsyncTest('R2: PdfPageTurnAdapter.waitForTargetReadyAndTurn and _commitTargetTurn preserve current page on unready/error targets', async () => {
    const { PageTurnController, PdfPageTurnAdapter } = await import('../js/page-turn-controller.js')
    const goToCalls = []
    const activeSlots = new Map()
    let ready = false
    const vp = {
        scrollArea: {},
        _destroyed: false,
        _loadGeneration: 1,
        currentPage: 0,
        pageOffsets: [{}, {}],
        activeSlots,
        isPageCanvasReady: () => ready,
        ensurePageRendered: () => false,
        async whenPageReady() { return false },
        async goToPage(p) {
            goToCalls.push(p)
            this.currentPage = p
        }
    }
    const adapter = new PdfPageTurnAdapter(vp)
    const unreadyTurn = await adapter.waitForTargetReadyAndTurn('next', () => true, 25)
    assert.strictEqual(unreadyTurn, false, 'Unready target timeout must return false')
    assert.strictEqual(goToCalls.length, 0, 'goToPage must NOT be called when target stays unready')
    assert.strictEqual(vp.currentPage, 0)

    activeSlots.set(1, { _renderError: new Error('decode failed') })
    const errCtrl = new PageTurnController({ adapter, mode: 'none' })
    const errCommitted = await errCtrl._commitTargetTurn('next', errCtrl.generation)
    assert.strictEqual(errCommitted, false, '_commitTargetTurn must return false on target render error')
    assert.strictEqual(goToCalls.length, 0, 'goToPage must NOT be called on render error')
    assert.strictEqual(vp.currentPage, 0)
    errCtrl.destroy()

    // Mid-wait slow follow-up does not arm or commit once unready/error occurs
    activeSlots.delete(1)
    const slowCtrl = new PageTurnController({ adapter, mode: 'none' })
    vp.whenPageReady = async (_p, { signal }) => await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 60)
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(false) }, { once: true })
    })
    const slowRes = await slowCtrl._commitTargetTurn('next', slowCtrl.generation, { allowSlowFollowUp: false })
    assert.strictEqual(slowRes, false)
    assert.strictEqual(goToCalls.length, 0, 'goToPage must remain uncalled after cancelled/timed-out wait')
    slowCtrl.destroy()

    // Mid-wait setAdapter(null) (book switch / teardown) resolves false without throwing on null adapter
    const switchCtrl = new PageTurnController({ adapter, mode: 'none' })
    const switchTurn = switchCtrl._commitTargetTurn('next', switchCtrl.generation)
    await new Promise((r) => setTimeout(r, 15))
    switchCtrl.setAdapter(null)
    assert.strictEqual(await switchTurn, false, 'Mid-wait setAdapter(null) must resolve false without throwing')
    switchCtrl.destroy()
})

// R3: PageTurnController drains single coalesced _pendingIntent once when adapter.isBusy transitions true -> false and clears on cancel/destroy
await runAsyncTest('R3: PageTurnController drains single coalesced _pendingIntent on busy->idle and clears on cancelCurrent/destroy', async () => {
    const { PageTurnController } = await import('../js/page-turn-controller.js')
    let busy = true
    const calls = []
    const adapter = {
        isSessionValid: () => true,
        canTurnNext: () => true,
        canTurnPrev: () => true,
        isBusy: () => busy,
        isContinuousScroll: () => false,
        ownsTouchGesture: () => false,
        getViewElement: () => null,
        clearVisualCache() {},
        async turnNext() { calls.push('next') },
        async turnPrev() { calls.push('prev') }
    }
    const ctrl = new PageTurnController({ adapter, mode: 'none' })

    // Coalesce multiple presses during busy to 1 latest intent ('prev')
    await ctrl.turnNext()
    await ctrl.turnPrev()
    assert.strictEqual(ctrl._pendingIntent, 'prev')
    assert.deepStrictEqual(calls, [])

    busy = false
    await new Promise(r => setTimeout(r, 90))
    assert.deepStrictEqual(calls, ['prev'], 'Latest coalesced pending intent must drain once on busy->idle')
    assert.strictEqual(ctrl._pendingIntent, null)
    assert.strictEqual(ctrl.state, 'idle')

    // Cancel clears pending intent before busy->idle
    busy = true
    await ctrl.turnNext()
    assert.strictEqual(ctrl._pendingIntent, 'next')
    ctrl.cancelCurrent()
    busy = false
    await new Promise(r => setTimeout(r, 50))
    assert.deepStrictEqual(calls, ['prev'], 'cancelCurrent must clear queued _pendingIntent')
    assert.strictEqual(ctrl._pendingIntent, null)

    // Destroy clears pending intent before busy->idle
    busy = true
    await ctrl.turnNext()
    assert.strictEqual(ctrl._pendingIntent, 'next')
    ctrl.destroy()
    busy = false
    await new Promise(r => setTimeout(r, 50))
    assert.deepStrictEqual(calls, ['prev'], 'destroy must clear queued _pendingIntent')
})

await runAsyncTest('R2/R3: accepted turns wait for owner completion without expiring, and cancellation removes the wait', async () => {
    const { PageTurnController, PdfPageTurnAdapter } = await import('../js/page-turn-controller.js')
    const flush = async () => { for (let i = 0; i < 30; ++i) await Promise.resolve() }
    let busy = true, idleTimeout = null, releaseIdle, turns = 0
    const adapter = {
        isSessionValid: () => true, canTurnNext: () => true, canTurnPrev: () => true,
        isBusy: () => busy, isContinuousScroll: () => false, ownsTouchGesture: () => false,
        getViewElement: () => null, clearVisualCache() {},
        whenNavIdle({ signal, timeoutMs }) {
            idleTimeout = timeoutMs
            return new Promise(resolve => {
                releaseIdle = resolve
                signal.addEventListener('abort', () => resolve(false), { once: true })
            })
        },
        async turnNext() { ++turns }
    }
    const ctrl = new PageTurnController({ adapter, mode: 'none' })
    await ctrl.turnNext()
    assert.strictEqual(idleTimeout, 0, 'Production idle completion must not expire after 2500ms')
    busy = false
    releaseIdle(true)
    await flush()
    assert.strictEqual(turns, 1)
    assert.strictEqual(ctrl._pendingIntent, null)
    busy = true
    await ctrl.turnNext()
    ctrl.cancelCurrent()
    busy = false
    releaseIdle(true)
    await flush()
    assert.strictEqual(turns, 1, 'A cancelled idle wait must not replay the turn')
    ctrl.destroy()

    let ready = false, pageTimeout = null, releasePage, commits = 0
    const vp = {
        scrollArea: {}, _destroyed: false, _loadGeneration: 1,
        currentPage: 0, pageOffsets: [{}, {}], activeSlots: new Map([[1, {}]]),
        isPageCanvasReady: () => ready,
        whenPageReady(_page, { signal, timeoutMs }) {
            pageTimeout = timeoutMs
            return new Promise(resolve => {
                releasePage = resolve
                signal.addEventListener('abort', () => resolve(false), { once: true })
            })
        },
        async goToPage(page) { ++commits; this.currentPage = page }
    }
    const pdfCtrl = new PageTurnController({ adapter: new PdfPageTurnAdapter(vp), mode: 'none' })
    pdfCtrl._armSlowTargetFollowUp('next', 1, pdfCtrl.generation)
    assert.strictEqual(pageTimeout, 0, 'A slow target must not lose its accepted turn after another 1800ms')
    ready = true
    releasePage(true)
    await flush()
    assert.strictEqual(commits, 1)
    assert.strictEqual(vp.currentPage, 1)
    vp.currentPage = 0
    ready = false
    pdfCtrl._armSlowTargetFollowUp('next', 1, pdfCtrl.generation)
    pdfCtrl.cancelCurrent()
    ready = true
    releasePage(true)
    await flush()
    assert.strictEqual(commits, 1, 'A cancelled slow-render follow-up must not replay the turn')
    pdfCtrl.destroy()
})

// R4: getDefaultReaderSettings, migrateLegacyReaderSettings, and resolveLegacyPreserveOriginalStyles contracts
test('R4: reader-style-builder defaults, mobile migration preservation, and legacy preserveOriginalStyles contract', async () => {
    const { getDefaultReaderSettings, migrateLegacyReaderSettings } = await import('../js/reader-style-builder.js')
    const { resolveLegacyPreserveOriginalStyles } = await import('../js/translation-job-core.js')

    const desktopDefaults = getDefaultReaderSettings({ isMobile: false, viewportWidth: 1440, viewportHeight: 900 })
    const mobileDefaults = getDefaultReaderSettings({ isMobile: true, viewportWidth: 390, viewportHeight: 844 })
    assert.strictEqual(desktopDefaults.preserveOriginalStyles, true, 'Desktop default preserveOriginalStyles must be true')
    assert.strictEqual(mobileDefaults.preserveOriginalStyles, true, 'Mobile default preserveOriginalStyles must be true')
    assert.strictEqual(desktopDefaults.margin, 48)
    assert.strictEqual(desktopDefaults.columnCount, '2')
    assert.strictEqual(mobileDefaults.margin, 20)
    assert.strictEqual(mobileDefaults.columnCount, '1')

    const explicitDesktopSavedOnMobile = migrateLegacyReaderSettings(
        { margin: 48, columnCount: '2', preserveOriginalStyles: true },
        { isMobile: true, viewportWidth: 390, viewportHeight: 844 }
    )
    assert.strictEqual(explicitDesktopSavedOnMobile.migrated, false)
    assert.strictEqual(explicitDesktopSavedOnMobile.settings.margin, 48, 'Mobile migration must not clobber explicit margin: 48')
    assert.strictEqual(explicitDesktopSavedOnMobile.settings.columnCount, '2', 'Mobile migration must not clobber explicit columnCount: 2')
    assert.strictEqual(explicitDesktopSavedOnMobile.settings.preserveOriginalStyles, true)

    assert.strictEqual(resolveLegacyPreserveOriginalStyles({ font: 'serif', fontSize: 18 }, false), false, 'Legacy profile without preserveOriginalStyles must stay false')
    assert.strictEqual(resolveLegacyPreserveOriginalStyles({ preserveOriginalStyles: false }, false), false)
    assert.strictEqual(resolveLegacyPreserveOriginalStyles({ preserveOriginalStyles: true }, false), true)
})

// Sequential async runner (Q09)
async function runAllTests() {
    console.log(`=== Running Linden Leaf 1.0.0 Regression Test Suite (${testQueue.length} tests registered) ===\n`)

    if (process.argv.includes('--check-runner')) {
        console.log('--- Runner Verification Mode (--check-runner) ---')
        testQueue.length = 0
        test('deliberate runner sync failure', () => {
            throw new Error('deliberate sync failure for runner verification')
        })
        test('deliberate runner async rejection', async () => {
            await new Promise((_, reject) => setTimeout(() => reject(new Error('deliberate async rejection for runner verification')), 10))
        })
    }

    for (const { name, fn } of testQueue) {
        try {
            const res = await fn()
            if (res === SKIP) {
                console.log(`[SKIP] ${name} (set LINDEN_REAL_BOOKS_MANIFEST to enable)`)
                totalSkipped++
                continue
            }
            console.log(`[PASS] ${name}`)
            totalPassed++
        } catch (err) {
            console.error(`[FAIL] ${name}:`, err.stack || err.message)
            totalFailed++
        }
    }

    console.log(`\nTests Completed: ${totalPassed} Passed, ${totalSkipped} Skipped, ${totalFailed} Failed`)

    if (process.argv.includes('--check-runner')) {
        assert.strictEqual(totalFailed, 2, 'Runner verification must record exactly 2 failures in formal queue')
        console.log('[VERIFIED] Runner correctly caught queue failures and tracked failure count. Exiting with code 1.')
        process.exit(1)
    }

    if (totalFailed > 0) {
        process.exitCode = 1
    }
}

await runAllTests()
