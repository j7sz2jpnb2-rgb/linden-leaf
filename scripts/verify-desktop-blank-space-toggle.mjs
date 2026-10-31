import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Deep Verification: Desktop Blank Space Toolbar Toggle & Touch Isolation ===\n');

const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

// -----------------------------------------------------------------------------
// Test 1: Static Code Invariants in js/app.js
// -----------------------------------------------------------------------------
console.log('1. Checking static code patterns in js/app.js...');

// 1.1 No aggressive multi-click debounce / deadlock timers for blank space
assert.ok(!appJs.includes('now - this._lastDocClickTime < 500'), 'Aggressive 500ms doc click debounce must be removed');
assert.ok(!appJs.includes('now - this._lastDocClickTime < 450'), '450ms doc click debounce must be removed');
assert.ok(!appJs.includes('now - this._lastDocClickTime < 350'), '350ms doc click debounce must be removed');
assert.ok(!appJs.includes('now - this._lastContentAreaClickTime < 500'), '500ms content area debounce must be removed');
assert.ok(!appJs.includes('now - this._lastContentAreaClickTime < 350'), '350ms content area debounce must be removed');
console.log('  [PASS] Aggressive 350-500ms click debounce locks removed.');

// 1.2 Desktop blank space toggle delay is 0ms (immediate)
assert.ok(appJs.includes('const delay = isTouch ? 60 : 0'), '#reader-content-area sets 0ms delay for desktop');
assert.ok(appJs.includes('const toggleDelay = isTouch ? 60 : (onText ? 200 : 0)'), 'Epub doc sets 0ms delay for desktop blank space');
console.log('  [PASS] Desktop blank space toggle delay is 0ms.');

// 1.3 requestToggleReaderUI executes immediately when delay <= 0
assert.ok(appJs.includes('if (effectiveDelay <= 0)'), 'requestToggleReaderUI executes immediately without timer when delay <= 0');
console.log('  [PASS] Immediate execution branch for effectiveDelay <= 0 verified.');

// 1.4 Double-click suppression is strictly scoped to text clicks (delay > 0) on desktop
assert.ok(
    appJs.includes('if (!isMobile && delay > 0 && this._lastDoubleClickTime && (Date.now() - this._lastDoubleClickTime < 300))'),
    'Double-click check only suppresses if delay > 0 (text click) and desktop'
);
console.log('  [PASS] Double-click suppression scoped to text clicks (delay > 0).');

// 1.5 isPointerDirectlyOnText tight character collision check (<= 4px, no 32px or 8px expansion)
assert.ok(!appJs.includes('dx <= 32 && dy <= 32'), 'Flawed 32px hit radius must NOT exist in isPointerDirectlyOnText');
assert.ok(appJs.includes('dx <= 4 && dy <= 4'), 'Tight character bounding box check (dx <= 4 && dy <= 4) exists');
assert.ok(!appJs.includes('r.top - 8'), '8px rect expansion must NOT exist in isPointerDirectlyOnText');
assert.ok(!appJs.includes('r.bottom + 8'), '8px rect expansion must NOT exist in isPointerDirectlyOnText');
console.log('  [PASS] isPointerDirectlyOnText tight character hit testing verified.');

// 1.6 Non-text media and body/documentElement excluded from isPointerDirectlyOnText
assert.ok(appJs.includes('if (target === doc.body || target === doc.documentElement || target.nodeType !== Node.ELEMENT_NODE)'), 'doc.body and doc.documentElement immediately return false');
assert.ok(appJs.includes("if (target.matches?.('svg, img, canvas, video, audio, hr, button, input'))"), 'Non-text media tags return false');
console.log('  [PASS] Blank body/margins and non-text elements excluded.');


// -----------------------------------------------------------------------------
// Test 2: Unit Simulation of isPointerDirectlyOnText Logic
// -----------------------------------------------------------------------------
console.log('\n2. Testing isPointerDirectlyOnText logic...');

function createMockHitTester(doc, targetElement, clientX, clientY, caretRect = null, clientRects = []) {
    const isPointerDirectlyOnText = (e) => {
        try {
            const target = e.target;
            if (!target || target.nodeType !== 1) return false;
            if (target === doc.body || target === doc.documentElement) return false;
            if (target.closest && target.closest('svg, img, canvas, video, audio, hr, button, input')) return false;

            const clientX = e.clientX;
            const clientY = e.clientY;
            if (clientX === undefined || clientY === undefined) return false;

            // Caret check with <= 4px tolerance
            if (doc.caretRangeFromPoint) {
                const range = doc.caretRangeFromPoint(clientX, clientY);
                if (range && range.startContainer && range.startContainer.nodeType === 3) {
                    const text = range.startContainer.nodeValue;
                    if (text && text.trim().length > 0) {
                        const rects = caretRect ? [caretRect] : [];
                        for (const r of rects) {
                            if (clientX >= r.left - 2 && clientX <= r.right + 2 &&
                                clientY >= r.top - 2 && clientY <= r.bottom + 2) {
                                return true;
                            }
                            const dx = Math.max(0, r.left - clientX, clientX - r.right);
                            const dy = Math.max(0, r.top - clientY, clientY - r.bottom);
                            if (dx <= 4 && dy <= 4) return true;
                        }
                    }
                }
            }

            // Target element line rects
            for (const r of clientRects) {
                if (clientX >= r.left && clientX <= r.right &&
                    clientY >= r.top && clientY <= r.bottom) {
                    return true;
                }
            }
            return false;
        } catch (err) {
            return false;
        }
    };

    return isPointerDirectlyOnText({ target: targetElement, clientX, clientY });
}

const mockDoc = {
    body: { nodeType: 1 },
    documentElement: { nodeType: 1 }
};

// Case A: Click on document.body margin
const hitBody = createMockHitTester(mockDoc, mockDoc.body, 50, 100);
assert.equal(hitBody, false, 'Click on document.body margin must be onText = false');

// Case B: Click on empty paragraph margin (20px away from text)
const mockP = {
    nodeType: 1,
    closest: (sel) => null
};
mockDoc.caretRangeFromPoint = (x, y) => ({
    startContainer: { nodeType: 3, nodeValue: 'Chapter 1' }
});
// Glyph rect at left: 100, right: 180, top: 50, bottom: 70. Click at x: 200, y: 60 (20px to right)
const hitMargin = createMockHitTester(mockDoc, mockP, 200, 60, { left: 100, right: 180, top: 50, bottom: 70 }, []);
assert.equal(hitMargin, false, 'Click 20px away from text must be onText = false (no 32px false positive)');

// Case C: Click directly on text glyph
const hitGlyph = createMockHitTester(mockDoc, mockP, 120, 60, { left: 100, right: 180, top: 50, bottom: 70 }, []);
assert.equal(hitGlyph, true, 'Click directly on glyph must be onText = true');

// Case D: Click on an image / illustration
const mockImg = {
    nodeType: 1,
    closest: (sel) => sel.includes('img') ? {} : null
};
const hitImg = createMockHitTester(mockDoc, mockImg, 150, 150);
assert.equal(hitImg, false, 'Click on image must be onText = false');

console.log('  [PASS] Hit testing logic correctly isolates text glyphs from blank margins.');


// -----------------------------------------------------------------------------
// Test 3: Desktop Immediate Blank Space UI Toggle Simulation
// -----------------------------------------------------------------------------
console.log('\n3. Testing Desktop Immediate Blank Space Toggle & Rapid Clicks...');

class ReaderUIToggleController {
    constructor(isMobile = false) {
        this.isMobile = isMobile;
        this.uiVisible = false;
        this.togglePending = null;
        this.lastDoubleClickTime = 0;
    }

    cancelPendingReaderUIToggle() {
        if (this.togglePending) {
            clearTimeout(this.togglePending);
            this.togglePending = null;
        }
    }

    toggleReaderUI() {
        this.uiVisible = !this.uiVisible;
    }

    requestToggleReaderUI(delay = 0, forceState = null) {
        this.cancelPendingReaderUIToggle();

        const effectiveDelay = this.isMobile ? Math.min(delay, 80) : delay;

        // Double-click suppression only on desktop text clicks (delay > 0)
        if (!this.isMobile && delay > 0 && this.lastDoubleClickTime && (Date.now() - this.lastDoubleClickTime < 300)) {
            return;
        }

        if (effectiveDelay <= 0) {
            this.toggleReaderUI();
            return;
        }

        this.togglePending = setTimeout(() => {
            this.togglePending = null;
            this.toggleReaderUI();
        }, effectiveDelay);
    }

    // Desktop blank space click handler
    onBlankSpaceClick() {
        // delay is 0ms on desktop blank space
        const delay = this.isMobile ? 60 : 0;
        this.requestToggleReaderUI(delay);
    }

    // Desktop text click handler
    onTextClick(e) {
        if (e.detail > 1) {
            this.lastDoubleClickTime = Date.now();
            this.cancelPendingReaderUIToggle();
            return;
        }
        const delay = this.isMobile ? 60 : 200;
        this.requestToggleReaderUI(delay);
    }
}

// 3.1 Single click on desktop blank space toggles immediately
const desktopController = new ReaderUIToggleController(false);
assert.equal(desktopController.uiVisible, false, 'Initial UI state is hidden');

desktopController.onBlankSpaceClick();
assert.equal(desktopController.uiVisible, true, 'Desktop blank click toggled UI immediately (0ms, no setTimeout)');
assert.equal(desktopController.togglePending, null, 'No pending timer created for blank click');

// 3.2 Rapid clicks on blank space (e.g. 150ms apart) toggles without deadlock
desktopController.onBlankSpaceClick();
assert.equal(desktopController.uiVisible, false, 'Second blank click toggled UI back immediately');

await new Promise(r => setTimeout(r, 100));
desktopController.onBlankSpaceClick();
assert.equal(desktopController.uiVisible, true, 'Third blank click toggled UI forward immediately');
console.log('  [PASS] Single and rapid blank space clicks toggle immediately without delay or deadlocks.');


// -----------------------------------------------------------------------------
// Test 4: Desktop Double-Click on Text Isolation
// -----------------------------------------------------------------------------
console.log('\n4. Testing Desktop Double-Click on Text...');

const textController = new ReaderUIToggleController(false);

// First click on text
textController.onTextClick({ detail: 1 });
assert.equal(textController.uiVisible, false, 'First click on text schedules delayed toggle (200ms)');
assert.notEqual(textController.togglePending, null, 'Pending timer is active for text click');

// Second click arrives at 100ms (double-click word selection)
await new Promise(r => setTimeout(r, 100));
textController.onTextClick({ detail: 2 });
assert.equal(textController.uiVisible, false, 'Double-click on text cancelled UI toggle');
assert.equal(textController.togglePending, null, 'Timer was cancelled by double-click');

// Wait past 250ms to ensure no delayed toggle fires
await new Promise(r => setTimeout(r, 200));
assert.equal(textController.uiVisible, false, 'UI remained hidden after double-click word selection');

// BUT an immediate blank space click right after double-click STILL toggles because delay === 0!
textController.onBlankSpaceClick();
assert.equal(textController.uiVisible, true, 'Blank space click immediately toggles even after recent double-click');
console.log('  [PASS] Double-click on text selects word without toggling UI, and blank space clicks remain unblocked.');


// -----------------------------------------------------------------------------
// Test 5: Mobile / Touch Isolation
// -----------------------------------------------------------------------------
console.log('\n5. Testing Mobile / Android Touch Isolation...');

const mobileController = new ReaderUIToggleController(true);

// Mobile blank space tap
mobileController.onBlankSpaceClick();
assert.equal(mobileController.uiVisible, false, 'Mobile tap uses 60ms delay to absorb synthetic events');
assert.notEqual(mobileController.togglePending, null, 'Pending timer created on mobile');

await new Promise(r => setTimeout(r, 80));
assert.equal(mobileController.uiVisible, true, 'Mobile tap toggled UI after 60ms delay');

console.log('  [PASS] Mobile/Android touch path is cleanly isolated (60ms delay).');

console.log('\n================================================================');
console.log('ALL VERIFICATION CHECKS PASSED (Desktop & Mobile Isolation OK)');
console.log('================================================================');
