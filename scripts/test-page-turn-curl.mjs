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
        stroke: () => {},
        fill: () => {},
        clip: () => {},
        translate: () => {},
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

console.log('\nALL PAGE TURN CURL & GESTURE TESTS PASSED CLEANLY!')
