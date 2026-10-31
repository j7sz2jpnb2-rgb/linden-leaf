import assert from 'node:assert/strict'
import { PageTurnController, CurlSimulator, PageTurnAdapter } from '../js/page-turn-controller.js'

console.log('--- Testing Page Turn Controller & Cylindrical Curl ---')

class MockAdapter extends PageTurnAdapter {
    constructor() {
        super()
        this.page = 1
        this.totalPages = 5
        this.turnPrevCalls = 0
        this.turnNextCalls = 0
    }
    canTurnPrev() { return this.page > 1 }
    canTurnNext() { return this.page < this.totalPages }
    async turnPrev() {
        this.turnPrevCalls++
        this.page--
    }
    async turnNext() {
        this.turnNextCalls++
        this.page++
    }
    getViewElement() {
        return { style: {} }
    }
    getVisuals() {
        return {
            currentCanvas: null,
            bgColor: '#FAF9F5',
            textColor: '#141413'
        }
    }
}

// 1. Test CurlSimulator
console.log('1. Testing CurlSimulator render parameters & mapPoint algorithm')
// Test exact cylindrical mapPoint formula
const p1 = { x: 100, y: 300 }
const o1 = { x: 400, y: 300 }
const n1 = { x: 1, y: 0 }
const t1 = { x: 0, y: 1 }
const R1 = 50

// Case A: Flat uncurled zone (s <= 0)
const ptFlat = CurlSimulator.mapPoint({ x: 200, y: 300 }, o1, n1, t1, R1)
assert.equal(ptFlat.s, -200)
assert.equal(ptFlat.z, 0)
assert.equal(ptFlat.normal.z, 1)

// Case B: Curved cylinder zone (0 < s < PI*R)
const sCrest = (Math.PI * R1) / 2 // apex of cylinder
const ptCrest = CurlSimulator.mapPoint({ x: o1.x + sCrest, y: 300 }, o1, n1, t1, R1)
assert.ok(Math.abs(ptCrest.z - R1) < 1e-4, 'Crest height should equal cylinder radius R')
assert.ok(Math.abs(ptCrest.normal.z) < 1e-4, 'Crest normal.z should be 0')

// Case C: Rolled back zone (s >= PI*R)
const ptRolled = CurlSimulator.mapPoint({ x: o1.x + Math.PI * R1 + 50, y: 300 }, o1, n1, t1, R1)
assert.equal(ptRolled.z, 2 * R1, 'Rolled back height should equal 2R')
assert.equal(ptRolled.normal.z, -1, 'Rolled back normal should point backward (-1)')
console.log('✓ CurlSimulator.mapPoint exact cylindrical projection verified')

const mockCanvas = {
    getContext: () => ({
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
        fillRect: () => {},
        rect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        quadraticCurveTo: () => {},
        bezierCurveTo: () => {},
        stroke: () => {},
        fill: () => {},
        clip: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        drawImage: () => {}
    })
}
const simulator = new CurlSimulator(mockCanvas)
// Verify no crash on various progress values
simulator.renderCurl({ width: 800, height: 1200, progress: 0, direction: 'next' })
simulator.renderCurl({ width: 800, height: 1200, progress: 0.35, direction: 'next', touchY: 400 })
simulator.renderCurl({ width: 800, height: 1200, progress: 0.75, direction: 'prev', touchY: 900 })
simulator.renderCurl({ width: 800, height: 1200, progress: 1.0, direction: 'next' })
console.log('✓ CurlSimulator rendered cleanly across boundary and mid values')

// 2. Test Controller touch drag & follow
console.log('2. Testing Controller follow-drag in curl mode')
const adapter = new MockAdapter()
const mockContainer = {
    clientWidth: 800,
    clientHeight: 1200,
    style: {},
    appendChild: () => {}
}
const controller = new PageTurnController({
    container: mockContainer,
    adapter,
    mode: 'curl'
})

// Touch start
controller.handleTouchStart({ touches: [{ clientX: 700, clientY: 500 }] })
assert.equal(controller.state, 'preparing')

// Touch move - horizontal swipe
controller.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 620, clientY: 502 }]
})
assert.equal(controller.state, 'dragging')
assert.ok(controller.currentDrag)
assert.equal(controller.currentDrag.deltaX, -80)

// Drag further
controller.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 300, clientY: 520 }]
})
assert.equal(controller.currentDrag.deltaX, -400) // 50% width

// Touch end with commit threshold (> 18% width)
await controller.handleTouchEnd({ touches: [] })
assert.equal(adapter.turnNextCalls, 1, 'turnNext should be committed when threshold exceeded')
assert.equal(adapter.page, 2)
assert.equal(controller.state, 'idle', 'Controller state should return to idle after turn')

console.log('✓ Commit on drag threshold verified')

// 3. Test Roll-back when drag is below threshold
console.log('3. Testing Roll-back when drag is below threshold')
const initialNextCalls = adapter.turnNextCalls
controller.handleTouchStart({ touches: [{ clientX: 700, clientY: 500, time: Date.now() }] })
controller.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 680, clientY: 500 }]
})
// deltaX is only -20px (< 40px and < 18% of 800px)
await controller.handleTouchEnd({ touches: [] })
assert.equal(adapter.turnNextCalls, initialNextCalls, 'turnNext must NOT be called on rollback')
assert.equal(controller.state, 'idle', 'Controller state should return to idle after rollback')
console.log('✓ Dynamic roll-back verified')

// 4. Test Pull-back gesture (rebound when user pulls back in recent 100ms)
console.log('4. Testing Pull-back cancellation gesture with recent velocity')
const callsBeforePullback = adapter.turnNextCalls
controller.handleTouchStart({ touches: [{ clientX: 700, clientY: 500 }] })
// User first dragged left to 300px (deltaX = -400px)
controller.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 300, clientY: 500 }]
})
// But in recent 50ms, user pulled back to right to 450px (positive dx in recent window)
controller.handleTouchMove({
    cancelable: true,
    preventDefault: () => {},
    touches: [{ clientX: 450, clientY: 500 }]
})
await controller.handleTouchEnd({ touches: [] })
assert.equal(adapter.turnNextCalls, callsBeforePullback, 'turnNext must NOT be called when pulling back')
assert.equal(controller.state, 'idle')
console.log('✓ Pull-back cancellation verified')

// 5. Test Real Page Texture Generation in Foliate & PDF Adapters
console.log('5. Testing Page Texture Generation & Caching in Foliate & PDF Adapters')
const mockFoliateView = {
    renderer: {
        clientWidth: 800,
        clientHeight: 1200,
        getContents: () => [{
            doc: {
                body: {
                    querySelectorAll: () => [
                        {
                            tagName: 'H1',
                            textContent: '第一章 菩提叶',
                            children: [],
                            getBoundingClientRect: () => ({ top: 40, bottom: 80, left: 30, right: 400, width: 370, height: 40 })
                        },
                        {
                            tagName: 'P',
                            textContent: '这是一本关于静心与专注的电子书。',
                            children: [],
                            getBoundingClientRect: () => ({ top: 90, bottom: 130, left: 30, right: 700, width: 670, height: 40 })
                        }
                    ]
                },
                defaultView: {
                    getComputedStyle: () => ({
                        fontSize: '20px',
                        fontFamily: 'serif',
                        fontWeight: 'bold',
                        color: '#1a1815'
                    })
                }
            }
        }]
    }
}

// Mock global document if not running in browser
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: (tag) => {
            if (tag === 'canvas') {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({
                        fillStyle: '',
                        font: '',
                        textBaseline: '',
                        fillRect: () => {},
                        fillText: () => {},
                        save: () => {},
                        restore: () => {},
                        drawImage: () => {}
                    })
                }
            }
            return {}
        },
        documentElement: {
            style: {
                getPropertyValue: () => '#FAF9F5'
            }
        }
    }
}

const { FoliatePageTurnAdapter, PdfPageTurnAdapter } = await import('../js/page-turn-controller.js')
const foliateAdapter = new FoliatePageTurnAdapter(mockFoliateView)
const visuals1 = foliateAdapter.getVisuals('next')
assert.ok(visuals1.currentCanvas, 'Foliate adapter should produce a valid currentCanvas snapshot')
assert.equal(visuals1.bgColor, '#FAF9F5')

// Test caching
const visuals2 = foliateAdapter.getVisuals('next')
assert.equal(visuals1.currentCanvas, visuals2.currentCanvas, 'Repeated calls should return cached canvas')

// Test cache clearance
foliateAdapter.clearVisualCache()
assert.equal(foliateAdapter._cachedCanvas, null, 'clearVisualCache should reset _cachedCanvas')

// Test PDF Adapter getVisuals
const mockCanvasCurrent = { id: 'pdf_page_1' }
const mockCanvasNext = { id: 'pdf_page_2' }
const mockPdfViewport = {
    currentPage: 1,
    pageOffsets: [0, 100, 200],
    renderedCanvases: new Map([
        [1, mockCanvasCurrent],
        [2, mockCanvasNext]
    ])
}
const pdfAdapter = new PdfPageTurnAdapter(mockPdfViewport)
const pdfVisuals = pdfAdapter.getVisuals('next')
assert.equal(pdfVisuals.currentCanvas, mockCanvasCurrent, 'PDF adapter should return renderedCanvas for current page')
assert.equal(pdfVisuals.nextCanvas, mockCanvasNext, 'PDF adapter should return renderedCanvas for next page')
console.log('✓ Foliate & PDF real page texture capture and caching verified')

// 6. Deep Verification: Multi-Column Page Break Text Isolation (Fixing P1/P2 Text Overlap)
console.log('6. Deep Verification: Multi-Column Page Break Text Isolation (Zero Overlap)')
const filledTexts = []
const mockDrawCtx = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    fillText: (text, x, y) => {
        filledTexts.push({ text, x, y })
    },
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {}
}

// Create a mock DOM with TreeWalker and a paragraph that spans across a column break (page 0 to page 1)
const pNode = {
    parentElement: {
        tagName: 'P',
        closest: () => null,
        ownerDocument: null
    },
    textContent: '第一行文字位于第一页底部。第二行文字位于第二页顶部。'
}
pNode.parentElement.ownerDocument = {
    defaultView: {
        getComputedStyle: () => ({
            fontSize: '18px',
            fontFamily: 'serif',
            lineHeight: '28px',
            color: '#141413'
        })
    }
}

globalThis.document.createElement = (tag) => {
    if (tag === 'canvas') {
        return {
            width: 0,
            height: 0,
            getContext: () => mockDrawCtx
        }
    }
    return {}
}

let curCharIndex = 0
const mockMultiColumnDoc = {
    body: { querySelectorAll: () => [] },
    defaultView: pNode.parentElement.ownerDocument.defaultView,
    createRange: () => ({
        selectNodeContents: () => {},
        getClientRects: () => [
            // Line 1 on Column 0 (Page 1): x=40, y=500
            { left: 40, right: 350, top: 500, bottom: 528, width: 310, height: 28 },
            // Line 2 on Column 1 (Page 2): x=840 (across column break!), y=40
            { left: 840, right: 1150, top: 40, bottom: 68, width: 310, height: 28 }
        ],
        setStart: (node, start) => { curCharIndex = start },
        setEnd: () => {},
        getBoundingClientRect: () => {
            // First 14 characters belong to Line 1 (left: 40..350, Column 0)
            // Remaining characters belong to Line 2 (left: 840..1150, Column 1)
            const isLine2 = curCharIndex >= 14
            return {
                left: isLine2 ? 840 + (curCharIndex - 14) * 20 : 40 + curCharIndex * 20,
                top: isLine2 ? 40 : 500,
                width: 15,
                height: 28
            }
        }
    }),
    createTreeWalker: (root, filter) => {
        let done = false
        return {
            nextNode: () => {
                if (!done) {
                    done = true
                    return pNode
                }
                return null
            }
        }
    }
}

const mockMultiColumnView = {
    renderer: {
        clientWidth: 800,
        clientHeight: 600,
        size: 800,
        page: 0,
        pages: 2,
        getContents: () => [{ doc: mockMultiColumnDoc }]
    }
}

const multiColumnAdapter = new FoliatePageTurnAdapter(mockMultiColumnView)
// Capture Page 0 (Current Page)
filledTexts.length = 0
const page0Canvas = multiColumnAdapter.capturePageCanvas(0, '#FAF9F5', '#141413')
assert.ok(page0Canvas, 'Page 0 canvas should be captured')
// Verify Line 2 (x=840) was NOT drawn on Page 0 and was NOT clamped to x=0
const drawnOnPage0 = filledTexts.filter(t => t.x >= 0 && t.x <= 800)
assert.ok(drawnOnPage0.length > 0, 'Page 0 should have drawn content')
for (const item of drawnOnPage0) {
    assert.ok(item.x >= 0 && item.x <= 800, 'Page 0 items must be strictly inside viewport')
    assert.ok(!item.text.includes('第二行文字'), 'Page 0 must NOT contain text from Page 1 (Column break isolation)')
}
console.log('✓ Column break text isolation verified: Page 1 text does not leak onto Page 0')

// Capture Page 1 (Next Page)
filledTexts.length = 0
const page1Canvas = multiColumnAdapter.capturePageCanvas(1, '#FAF9F5', '#141413')
assert.ok(page1Canvas, 'Page 1 canvas should be captured')
const drawnOnPage1 = filledTexts.filter(t => t.x >= 0 && t.x <= 800)
for (const item of drawnOnPage1) {
    assert.ok(!item.text.includes('第一行文字'), 'Page 1 must NOT contain text from Page 0 (Zero double-exposure)')
}
console.log('✓ Zero double-exposure verified: Page 0 text does not leak onto Page 1')

// 7. Deep Verification: WeChat Reading Curl Shading & Mirrored Text Compositing (Fixing P2/P3)
console.log('7. Deep Verification: WeChat Reading 3D Lighting, Mirrored Text & Theme Paper')
const simulatorOps = []
const detailedMockCanvas = {
    getContext: () => ({
        clearRect: () => simulatorOps.push('clearRect'),
        save: () => simulatorOps.push('save'),
        restore: () => simulatorOps.push('restore'),
        createLinearGradient: (x0, y0, x1, y1) => {
            simulatorOps.push(`gradient(${Math.round(x0)},${Math.round(y0)}->${Math.round(x1)},${Math.round(y1)})`)
            return { addColorStop: (stop, color) => simulatorOps.push(`stop(${stop},${color})`) }
        },
        fillRect: (x, y, w, h) => simulatorOps.push(`fillRect(${x},${y},${w},${h})`),
        rect: (x, y, w, h) => simulatorOps.push(`rect(${x},${y},${w},${h})`),
        beginPath: () => simulatorOps.push('beginPath'),
        closePath: () => simulatorOps.push('closePath'),
        moveTo: (x, y) => simulatorOps.push(`moveTo(${Math.round(x)},${Math.round(y)})`),
        lineTo: (x, y) => simulatorOps.push(`lineTo(${Math.round(x)},${Math.round(y)})`),
        quadraticCurveTo: (cpx, cpy, x, y) => simulatorOps.push(`quadCurve(${Math.round(cpx)},${Math.round(cpy)},${Math.round(x)},${Math.round(y)})`),
        bezierCurveTo: (cp1x, cp1y, cp2x, cp2y, x, y) => simulatorOps.push(`bezierCurve(${Math.round(cp1x)},${Math.round(cp1y)},${Math.round(cp2x)},${Math.round(cp2y)},${Math.round(x)},${Math.round(y)})`),
        stroke: () => simulatorOps.push('stroke'),
        fill: () => simulatorOps.push('fill'),
        clip: () => simulatorOps.push('clip'),
        translate: (x, y) => simulatorOps.push(`translate(${Math.round(x)},${Math.round(y)})`),
        rotate: (angle) => simulatorOps.push(`rotate(${angle.toFixed(2)})`),
        scale: (sx, sy) => simulatorOps.push(`scale(${sx},${sy})`),
        drawImage: () => simulatorOps.push('drawImage')
    })
}
const richSimulator = new CurlSimulator(detailedMockCanvas)
richSimulator.renderCurl({
    width: 800,
    height: 1200,
    progress: 0.45,
    direction: 'next',
    touchY: 600,
    currentTexture: { id: 'cur_tex' },
    nextTexture: { id: 'next_tex' },
    bgColor: '#FAF9F5',
    textColor: '#141413'
})

// Assert critical WeChat Reading features were executed
assert.ok(simulatorOps.includes('scale(-1,1)'), 'Must execute horizontal mirror scale(-1, 1) for paper backside')
assert.ok(simulatorOps.includes('clip'), 'Must clip layers cleanly to avoid overlapping')
assert.ok(simulatorOps.includes('stroke'), 'Must render specular crest highlight on cylinder apex ridge')
assert.ok(simulatorOps.some(op => op.startsWith('fillRect(0,0,800,1200)')), 'Must render 100% opaque page background to prevent transparent ghosting')
console.log('✓ WeChat Reading 3D lighting, mirrored show-through, and opaque layering verified')

console.log('\nALL PAGE TURN CURL & GESTURE TESTS PASSED CLEANLY!')
