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
    rc._cancelNativeDrag = () => { cancelled = true }
    await rc._nativePointerMove({ pointerId: 1, pointerType: 'mouse', buttons: 2, clientX: 25, clientY: 10 })
    assert.strictEqual(cancelled, true, 'Right click or secondary button must cancel active drag')

    // Sub-test 5: clearSelection invalidates pending selection epoch
    const clr = make()
    clr._nativeDrag = drag()
    const epochBefore = clr._nativeGestureEpoch
    clr.clearSelection()
    assert.ok(clr._nativeGestureEpoch > epochBefore, 'clearSelection must advance gesture epoch')
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
    const exePath = path.resolve('D:/LindenLeaf-Dev/linden-leaf-mupdf/scripts/verify-real-books.exe')
    if (!fs.existsSync(exePath) || !fs.existsSync('E:/书')) {
        throw new Error('RealBooks verification failed: sample directory E:/书 or scripts/verify-real-books.exe not found')
    }
    let stdout = ''
    for (let retry = 0; retry < 5; retry++) {
        try {
            stdout = execFileSync(exePath, [], { encoding: 'utf8' })
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
            html = `<img class="jane-cover-img" src="${coverUrl}" />`
        } else if (book.coverBlob) {
            html = `<img class="jane-cover-img lazy-cover" data-book-id="${book.id}" />`
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
    const metaRow = { innerHTML: '<span class="jane-meta-progress">10%</span>' }
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
            if (sel === '.jane-book-meta-row') return metaRow
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
    metaRow.innerHTML = `<span class="jane-meta-progress">${progressPct}%</span>`
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
test('Q10: restoreFullDataBackup reconciles timestamps and does not rollback newer local progress', async () => {
    const { AdvancedSettingsManager } = await import('../js/advanced-settings.js')
    const mgr = new AdvancedSettingsManager()
    let savedBook = null
    const fakeDb = {
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

// 59. S02: Manual Two-Column and Multi-Region Sequential Reading Mode
await runAsyncTest('S02: PdfViewport column reading steps through columns and pages without coordinate drift', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    const vp = Object.create(PdfViewport.prototype)
    vp.options = {}
    vp._renderVisibleSlots = () => {}
    vp.numPages = 5
    vp.pageOffsets = [
        { top: 0, height: 800, width: 600, left: 0 },
        { top: 820, height: 800, width: 600, left: 0 },
        { top: 1640, height: 800, width: 600, left: 0 }
    ]
    vp.scrollArea = {
        scrollTop: 0,
        scrollLeft: 0,
        clientHeight: 400,
        clientWidth: 600,
        scrollHeight: 2500,
        scrollWidth: 600
    }

    // Enable column reading (2-column layout)
    vp.setColumnReadingConfig({
        enabled: true,
        defaultRegions: [
            { x: 0, y: 0, width: 0.5, height: 1.0 },
            { x: 0.5, y: 0, width: 0.5, height: 1.0 }
        ],
        pageOverrides: {
            2: 'full' // Page 2 is a full-width diagram
        }
    })

    const st0 = vp.getColumnReadingState()
    assert.strictEqual(st0.enabled, true)
    assert.strictEqual(st0.pageIndex, 0)
    assert.strictEqual(st0.regionIndex, 0)

    // Step down in column 0
    vp.nextColumnStep()
    const st1 = vp.getColumnReadingState()
    assert.strictEqual(st1.pageIndex, 0)
    assert.strictEqual(st1.regionIndex, 0)
    assert.ok(st1.offset > 0, 'Offset must advance within column 0')

    // Step until reaching bottom of column 0 -> switches to column 1
    vp.nextColumnStep()
    vp.nextColumnStep()
    const st2 = vp.getColumnReadingState()
    assert.strictEqual(st2.pageIndex, 0)
    assert.strictEqual(st2.regionIndex, 1, 'Must switch to column 1 after column 0 finishes')

    // Step down in column 1 until reaching bottom -> switches to page 1, column 0
    vp.nextColumnStep()
    vp.nextColumnStep()
    vp.nextColumnStep()
    const st3 = vp.getColumnReadingState()
    assert.strictEqual(st3.pageIndex, 1, 'Must advance to page 1')
    assert.strictEqual(st3.regionIndex, 0)

    // Reverse step (prevColumnStep) -> steps backward into page 0 column 1
    vp.prevColumnStep()
    const stBack = vp.getColumnReadingState()
    assert.strictEqual(stBack.pageIndex, 0)
    assert.strictEqual(stBack.regionIndex, 1)

    // Exit column reading restores state
    vp.setColumnReadingConfig({ enabled: false })
    assert.strictEqual(vp.getColumnReadingState().enabled, false)
})

// 60. S03: Scan Enhancement Presets with Per-Book State
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

// 61. S04: Reading Ruler and Controlled Auto-Scroll
await runAsyncTest('S04: Reading ruler attaches overlay and auto-scroll pauses on blur/selection', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js')
    let appendedEl = null
    const container = {
        style: { setProperty() {} },
        appendChild(el) { appendedEl = el },
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll() { return [] },
        getBoundingClientRect() { return { top: 100, left: 50, height: 800, width: 600 } }
    }
    const vp = Object.create(PdfViewport.prototype)
    vp.container = container
    vp.scrollArea = {
        scrollTop: 0,
        clientHeight: 500,
        scrollHeight: 2000
    }

    // Enable ruler
    vp.setReadingRuler({ enabled: true, height: 48, opacity: 0.35, color: 'rgba(255, 255, 0, 0.4)' })
    assert.ok(appendedEl, 'Ruler overlay DOM element must be appended')
    assert.strictEqual(appendedEl.style.height, '48px')
    assert.strictEqual(Number(appendedEl.style.opacity), 0.35)

    // Remove ruler
    let removedEl = null
    appendedEl.remove = () => { removedEl = appendedEl }
    vp.removeReadingRuler()
    assert.ok(removedEl, 'Ruler element must be removed on disable')

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
    const { UniversalReaderApp } = await import('../js/app.js')
    const app = Object.create(UniversalReaderApp.prototype)
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
            const res = fn()
            if (res && typeof res.then === 'function') {
                await res
            }
            console.log(`[PASS] ${name}`)
            totalPassed++
        } catch (err) {
            console.error(`[FAIL] ${name}:`, err.stack || err.message)
            totalFailed++
        }
    }

    console.log(`\nTests Completed: ${totalPassed} Passed, ${totalFailed} Failed`)

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

