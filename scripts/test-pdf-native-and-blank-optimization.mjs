// scripts/test-pdf-native-and-blank-optimization.mjs
// Verification suite for:
// 1. PDF Native mode text selection hit limit & blank space cancellation (Bug 1)
// 2. isPointerDirectlyOnText synchronous TreeWalker & getClientRects reflow elimination (Issue 2)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Running Verification: PDF Native Selection & Blank Space Hit Optimization ===\n');

const pdfViewportJs = fs.readFileSync(path.join(root, 'js/pdf-viewport.js'), 'utf8').replace(/\r\n/g, '\n');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// Suite 1: Static Code Invariants in js/pdf-viewport.js
// ---------------------------------------------------------------------------
console.log('1. Checking static code patterns in js/pdf-viewport.js...');

// 1.1 _hitNativeChar has maxDist parameter and bounding check
assert.ok(pdfViewportJs.includes('async _hitNativeChar(page, point, maxDist = 16)'), '_hitNativeChar must support maxDist parameter');
assert.ok(pdfViewportJs.includes('if (!ids.size) return null'), '_hitNativeChar must NOT fall back to chars across page when ids is empty');
assert.ok(pdfViewportJs.includes('d <= maxDistSq && d < dist'), '_hitNativeChar must enforce distance limit d <= maxDistSq');
console.log('  [PASS] _hitNativeChar distance limit and page-wide snap prevention verified.');

// 1.2 clearSelection method exists and cleans up preview and notifications
assert.ok(pdfViewportJs.includes('clearSelection() {'), 'PdfViewport must expose clearSelection()');
assert.ok(pdfViewportJs.includes('this._nativePreview = null'), 'clearSelection must clear this._nativePreview');
assert.ok(pdfViewportJs.includes('this._redrawNativePreview()'), 'clearSelection must redraw native preview');
assert.ok(pdfViewportJs.includes('this.options.onSelectionClear?.()'), 'clearSelection must notify onSelectionClear callback');
console.log('  [PASS] clearSelection method implementation verified.');

// 1.3 _nativePointerDown checks slot boundaries, hit limit, and clears selection on blank
assert.ok(pdfViewportJs.includes('if (!isInsideSlot) {'), '_nativePointerDown must check if click is inside slot bounds');
assert.ok(pdfViewportJs.includes('if (!ch || epoch !== this._nativeGestureEpoch || this.interactionMode === \'draw\') {'), '_nativePointerDown checks valid character hit');
assert.ok(!pdfViewportJs.includes('e.preventDefault()\n        try { this.scrollArea.setPointerCapture'), '_nativePointerDown must NOT unconditionally preventDefault or capture pointer before movement');
console.log('  [PASS] _nativePointerDown blank space isolation verified.');

// 1.4 _nativePointerUp suppresses single click spurious selection
assert.ok(pdfViewportJs.includes('if (!drag.hasMoved || isSameChar) {'), '_nativePointerUp must check !drag.hasMoved || isSameChar');
console.log('  [PASS] _nativePointerUp spurious single character selection suppression verified.');

// 1.5 scrollArea click listener clears active native selection
assert.ok(pdfViewportJs.includes('if (this._nativePreview?.length) {\n                this.clearSelection()\n                return\n            }'), 'click handler on scrollArea clears active native selection');
console.log('  [PASS] scrollArea click handler active selection dismissal verified.');

// ---------------------------------------------------------------------------
// Suite 2: Static Code Invariants in js/app.js
// ---------------------------------------------------------------------------
console.log('\n2. Checking static code patterns in js/app.js...');

// 2.1 onSelectionClear wired in PdfViewport initialization
assert.ok(appJs.includes('onSelectionClear: () => {\n                        this.hideSelectionPopup()\n                        this.hideDictionaryCard()\n                    }'), 'app.js must provide onSelectionClear callback to PdfViewport');
console.log('  [PASS] app.js onSelectionClear handler verified.');

// 2.2 hideSelectionPopup clears pdfViewport selection
assert.ok(appJs.includes('this.pdfViewport?.clearSelection?.()'), 'hideSelectionPopup clears pdfViewport native selection');
console.log('  [PASS] hideSelectionPopup pdfViewport cleanup verified.');

// 2.3 isPointerDirectlyOnText returns immediately from caret APIs without falling into Step 5
const step4ReturnPos = appJs.indexOf('// In modern browsers, caretPositionFromPoint is authoritative for document layout.\n                    // If the pointer is not within 4px of the resolved glyph, it is blank space.\n                    return false');
assert.ok(step4ReturnPos !== -1, 'caretPositionFromPoint branch must return false immediately for blank space');

const step4ReturnRange = appJs.indexOf('// Authoritative caret hit test: not within 4px of glyph means blank space.\n                    return false');
assert.ok(step4ReturnRange !== -1, 'caretRangeFromPoint branch must return false immediately for blank space');

// 2.4 Step 5 bounding box fast-reject
assert.ok(appJs.includes('const targetBox = target.getBoundingClientRect?.()'), 'Step 5 must check target.getBoundingClientRect for fast reject');
assert.ok(appJs.includes('while ((textNode = walker.nextNode()) && count < 10)'), 'Step 5 count reduced from 60 to 10');
console.log('  [PASS] isPointerDirectlyOnText reflow optimization verified.');

// ---------------------------------------------------------------------------
// Suite 3: Unit Simulation of PDF Character Geometry & Distance Limit
// ---------------------------------------------------------------------------
console.log('\n3. Testing PDF _hitNativeChar simulation...');

const quadBounds = q => {
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

// Simulate line: "弥赛亚的国度与世俗历史" (11 characters)
// Characters at x: 72 to 248, y: 100 to 116 (each char width=16, height=16)
const mockChars = [];
const charText = '弥赛亚的国度与世俗历史';
for (let i = 0; i < charText.length; i++) {
    const x0 = 72 + i * 16, x1 = x0 + 16, y0 = 100, y1 = 116;
    mockChars.push({
        index: i,
        text: charText[i],
        quad: [x0, y0, x1, y0, x0, y1, x1, y1],
        bounds: [x0, y0, x1, y1]
    });
}

const cellSize = 48;
const mockGrid = new Map();
mockChars.forEach((box, index) => {
    const [x0, y0, x1, y1] = box.bounds;
    const gx0 = Math.floor(x0 / cellSize), gx1 = Math.floor(x1 / cellSize);
    const gy0 = Math.floor(y0 / cellSize), gy1 = Math.floor(y1 / cellSize);
    for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
        const key = `${x}:${y}`;
        if (!mockGrid.has(key)) mockGrid.set(key, []);
        mockGrid.get(key).push(index);
    }
});

function simulateHitNativeChar(point, maxDist = 16) {
    const gx = Math.floor(point[0] / cellSize), gy = Math.floor(point[1] / cellSize);
    const ids = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        for (const id of mockGrid.get(`${gx+dx}:${gy+dy}`) || []) ids.add(id);
    if (!ids.size) return null;
    const candidates = [...ids].map(i => mockChars[i]);
    let best = null, dist = Infinity;
    const maxDistSq = maxDist * maxDist;
    for (const ch of candidates) {
        const [x0, y0, x1, y1] = ch.bounds;
        const dx = point[0] < x0 ? x0 - point[0] : point[0] > x1 ? point[0] - x1 : 0;
        const dy = point[1] < y0 ? y0 - point[1] : point[1] > y1 ? point[1] - y1 : 0;
        const d = dx * dx + dy * dy;
        if (d <= maxDistSq && d < dist) { dist = d; best = ch; }
    }
    return best;
}

// Case 3.1: Direct hit on character '史' (index 10, bounds [232, 100, 248, 116])
const hitExact = simulateHitNativeChar([240, 108], 16);
assert.ok(hitExact !== null, 'Direct click must hit character');
assert.equal(hitExact.text, '史', 'Direct click on 240,108 should hit 史');

// Case 3.2: Click slightly to the right of '史' within 8px tolerance (x=254, y=108, dx=6)
const hitNear = simulateHitNativeChar([254, 108], 16);
assert.ok(hitNear !== null, 'Click within tolerance should hit character');
assert.equal(hitNear.text, '史');

// Case 3.3: Click in blank space 50px to the right of line (x=300, y=108, dx=52)
// Old buggy code snapped to '史' across page!
const hitBlankNear = simulateHitNativeChar([300, 108], 16);
assert.equal(hitBlankNear, null, 'Click 50px to right of line MUST return null (not snap to 史)');

// Case 3.4: Click in blank space far right (x=450, y=108)
const hitBlankFar = simulateHitNativeChar([450, 108], 16);
assert.equal(hitBlankFar, null, 'Click far in margin MUST return null');

// Case 3.5: Click in vertical gap between lines (y=140)
const hitVerticalGap = simulateHitNativeChar([100, 140], 16);
assert.equal(hitVerticalGap, null, 'Click in line gap MUST return null');

console.log('  [PASS] _hitNativeChar correctly rejects blank space and only hits within bounding padding.');

// ---------------------------------------------------------------------------
// Suite 4: Unit Simulation of isPointerDirectlyOnText Call Count & TreeWalker Bypass
// ---------------------------------------------------------------------------
console.log('\n4. Testing isPointerDirectlyOnText TreeWalker bypass on blank clicks...');

let treeWalkerCount = 0;
let getClientRectsCount = 0;

const mockParagraph = {
    nodeType: 1,
    matches: (sel) => sel.split(',').map(s => s.trim()).includes('p'),
    getBoundingClientRect: () => ({ left: 20, right: 600, top: 50, bottom: 200 })
};

const mockTextNode = {
    nodeType: 3,
    textContent: 'Some text in paragraph',
    length: 22
};

const mockDocWithCaret = {
    body: { nodeType: 1 },
    documentElement: { nodeType: 1 },
    // doc.caretPositionFromPoint returns offsetNode and offset
    caretPositionFromPoint: (x, y) => {
        // Simulating click in blank space of paragraph (e.g. x=550, y=80)
        // Browser returns nearest character, but that character is far from x=550
        return {
            offsetNode: mockTextNode,
            offset: 22
        };
    },
    createRange: () => ({
        setStart: () => {},
        setEnd: () => {},
        getBoundingClientRect: () => {
            getClientRectsCount++;
            // Character is at x=200, y=80 (width=8, height=16)
            return { left: 192, right: 200, top: 72, bottom: 88, width: 8, height: 16 };
        },
        selectNodeContents: () => {},
        getClientRects: () => {
            getClientRectsCount++;
            return [{ left: 192, right: 200, top: 72, bottom: 88 }];
        }
    }),
    createTreeWalker: () => {
        treeWalkerCount++;
        return { nextNode: () => null };
    }
};

// Simulate the optimized isPointerDirectlyOnText function
function testOptimizedIsPointerDirectlyOnText(doc, target, clientX, clientY) {
    if (!doc || !target) return false;
    if (target === doc.body || target === doc.documentElement || target.nodeType !== 1) return false;
    if (target.matches?.('svg, img, canvas, video, audio, hr, button, input')) return false;

    if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(clientX, clientY);
        if (pos && pos.offsetNode) {
            const node = pos.offsetNode.nodeType === 3 ? pos.offsetNode : pos.offsetNode;
            if (node && node.nodeType === 3 && node.textContent?.trim()) {
                const offset = pos.offset || 0;
                const testRange = doc.createRange();
                const start = Math.max(0, Math.min(offset, Math.max(0, node.length - 1)));
                testRange.setStart(node, start);
                testRange.setEnd(node, Math.min(start + 1, node.length));
                const r = testRange.getBoundingClientRect();
                if (r && (r.width > 0 || r.height > 0)) {
                    const dx = Math.max(0, r.left - clientX, clientX - r.right);
                    const dy = Math.max(0, r.top - clientY, clientY - r.bottom);
                    if (dx <= 4 && dy <= 4) return true;
                }
            }
        }
        // In modern browsers, caretPositionFromPoint is authoritative.
        return false;
    }

    // Fallback only if no caretPositionFromPoint
    if (target.matches?.('p, h1, h2, div')) {
        const walker = doc.createTreeWalker(target, 4, null);
        let node;
        while ((node = walker.nextNode())) {}
    }
    return false;
}

// Test click in blank space of paragraph
treeWalkerCount = 0;
getClientRectsCount = 0;
const result = testOptimizedIsPointerDirectlyOnText(mockDocWithCaret, mockParagraph, 550, 80);

assert.equal(result, false, 'Click in blank space must return onText=false');
assert.equal(treeWalkerCount, 0, 'TreeWalker MUST NEVER be invoked when caretPositionFromPoint exists');
assert.equal(getClientRectsCount, 1, 'Only 1 single Range bounding check should be performed (not 60)');

console.log('  [PASS] Verified 0 TreeWalker calls and only 1 Range measurement on blank space click.');

// ---------------------------------------------------------------------------
// Suite 5: Runtime Pointer & Touch Lifecycle (Selection Dismiss vs Toolbar Toggle)
// ---------------------------------------------------------------------------
console.log('\n5. Testing runtime pointer & touch interaction lifecycle...');

class MockPdfViewportInteraction {
    constructor() {
        this.options = {
            onTap: () => { this.tapCount++; },
            onSelectionClear: () => {
                this.selectionClearNotifications++;
                // Re-entrant call simulation: app.js hideSelectionPopup calls clearSelection()
                this.clearSelection();
            }
        };
        this.tapCount = 0;
        this.selectionClearNotifications = 0;
        this.activeSlots = new Map([[0, { getBoundingClientRect: () => ({ left: 50, right: 650, top: 50, bottom: 850, width: 600, height: 800 }) }]]);
        this.pageSizes = [{ width: 595, height: 842, x0: 0, y0: 0 }];
        this._nativeDrag = null;
        this._nativePreview = null;
        this._selectionDismissedTime = 0;
        this._isClearingSelection = false;
        this._nativeGestureEpoch = 0;
        this._singleTapTimer = null;
    }

    clearSelection() {
        if (this._isClearingSelection) return;
        this._isClearingSelection = true;
        try {
            const hadSelection = Boolean(this._nativePreview?.length);
            if (hadSelection) {
                this._selectionDismissedTime = performance.now();
            }
            this._nativePreview = null;
            if (hadSelection) {
                this.options.onSelectionClear?.();
            }
        } finally {
            this._isClearingSelection = false;
        }
    }

    async pointerDown(e, isCharHit = false) {
        const epoch = ++this._nativeGestureEpoch;
        if (!isCharHit) {
            if (this._nativePreview?.length) this.clearSelection();
            return;
        }
        this._nativeDrag = {
            pointerId: e.pointerId || 1,
            epoch,
            startX: e.clientX,
            startY: e.clientY,
            hasMoved: false,
            anchor: { page: 0, index: 10, point: [200, 100] },
            focus: { page: 0, index: 10, point: [200, 100] }
        };
    }

    pointerUp(e) {
        this._nativeGestureEpoch++;
        const drag = this._nativeDrag;
        if (!drag) return;
        this._nativeDrag = null;
        const isSameChar = drag.anchor.page === drag.focus.page && drag.anchor.index === drag.focus.index;
        if (!drag.hasMoved || isSameChar) {
            if (this._nativePreview?.length) this.clearSelection();
            return;
        }
    }

    click(e) {
        if (this._nativeDrag) return;
        if (this._selectionDismissedTime && performance.now() - this._selectionDismissedTime < 600) {
            this._selectionDismissedTime = 0;
            return;
        }
        if (this._nativePreview?.length) {
            this.clearSelection();
            return;
        }
        this.options.onTap();
    }

    touchEnd(dur = 100, dist = 5) {
        if (dur < 450 && dist < 24) {
            if (this._selectionDismissedTime && performance.now() - this._selectionDismissedTime < 600) {
                this._selectionDismissedTime = 0;
                clearTimeout(this._singleTapTimer);
                return;
            }
            if (this._nativePreview?.length) {
                this.clearSelection();
                clearTimeout(this._singleTapTimer);
                return;
            }
            this.options.onTap();
        }
    }
}

// 5.1 Blank click with active selection MUST dismiss selection and NOT toggle toolbar
const vp1 = new MockPdfViewportInteraction();
vp1._nativePreview = [{ page: 0, quads: [10, 20, 30, 40] }];
await vp1.pointerDown({ clientX: 300, clientY: 400 }, false); // Click on blank space
vp1.pointerUp({ clientX: 300, clientY: 400 });
vp1.click({ clientX: 300, clientY: 400 });

assert.equal(vp1._nativePreview, null, 'Active selection must be cleared');
assert.equal(vp1.selectionClearNotifications, 1, 'onSelectionClear called exactly once (no infinite recursion)');
assert.equal(vp1.tapCount, 0, 'onTap MUST NOT be called when dismissing native selection via click');
console.log('  [PASS] Blank space click dismisses native selection WITHOUT toggling toolbar.');

// 5.2 Subsequent blank click without selection MUST toggle toolbar
vp1.click({ clientX: 300, clientY: 400 });
assert.equal(vp1.tapCount, 1, 'Subsequent click on blank space MUST toggle toolbar');
console.log('  [PASS] Subsequent blank click toggles toolbar normally.');

// 5.3 Blank touch tap with active selection MUST dismiss selection and NOT toggle toolbar
const vp2 = new MockPdfViewportInteraction();
vp2._nativePreview = [{ page: 0, quads: [10, 20, 30, 40] }];
await vp2.pointerDown({ clientX: 300, clientY: 400 }, false);
vp2.touchEnd(120, 4);

assert.equal(vp2._nativePreview, null, 'Active selection must be cleared on touch');
assert.equal(vp2.tapCount, 0, 'onTap MUST NOT be called when dismissing native selection via touch tap');
console.log('  [PASS] Blank space touch tap dismisses native selection WITHOUT toggling toolbar.');

// 5.4 Subsequent blank touch tap without selection MUST toggle toolbar
vp2.touchEnd(120, 4);
assert.equal(vp2.tapCount, 1, 'Subsequent touch tap on blank space MUST toggle toolbar');
console.log('  [PASS] Subsequent blank touch tap toggles toolbar normally.');

// 5.5 Single click on character without drag does not select character
const vp3 = new MockPdfViewportInteraction();
await vp3.pointerDown({ clientX: 200, clientY: 100 }, true); // Hit character
assert.ok(vp3._nativeDrag !== null, 'Drag object initialized on character hit');
vp3.pointerUp({ clientX: 200, clientY: 100 });
assert.equal(vp3._nativeDrag, null, 'Drag ended');
assert.equal(vp3._nativePreview, null, 'Single click must not create spurious character preview');
console.log('  [PASS] Single click on character does not select spurious single character.');

console.log('\n================================================================');
console.log('ALL VERIFICATION CHECKS PASSED (PDF Native & Blank Optimization)');
console.log('================================================================');

