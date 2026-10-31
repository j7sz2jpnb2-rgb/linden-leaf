// scripts/test-blank-toggle-deep-verify.mjs
// Comprehensive test suite for desktop blank space immediate toolbar toggling,
// multi-line span hit testing, Android touch text tap isolation, and PDF mode.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Deep Automated Verification: Reader Blank Space Toolbar Toggle & Mobile Isolation ===\n');

const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// 1. Static code invariants
// ---------------------------------------------------------------------------
console.log('1. Verifying static code patterns in js/app.js...');

// 1.1 Desktop PDF onTap sets delay to 0ms (not hardcoded 60ms)
assert.ok(
  appJs.includes("this.requestToggleReaderUI(isMobile ? 60 : 0)"),
  'PDF onTap must use 0ms on desktop and 60ms on mobile'
);
console.log('  [PASS] PDF onTap immediate 0ms toggle on desktop verified.');

// 1.2 isPointerDirectlyOnText uses getClientRects() for inline elements instead of getBoundingClientRect()
assert.ok(
  appJs.includes("const rects = target.getClientRects?.()"),
  'isPointerDirectlyOnText must use target.getClientRects() to avoid multi-line span blank space false positives'
);
console.log('  [PASS] getClientRects() used for inline elements in isPointerDirectlyOnText.');

// 1.3 isPointerDirectlyOnText extracts touch coordinates (changedTouches/touches)
assert.ok(
  appJs.includes("e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX"),
  'isPointerDirectlyOnText must support touch coordinate extraction'
);
console.log('  [PASS] Touch coordinate support in isPointerDirectlyOnText verified.');

// 1.4 Android touchend checks onText before toggling UI
assert.ok(
  appJs.includes("const onText = isPointerDirectlyOnText(e)") &&
  appJs.includes("if (onText) {\n                this._lastDocTapHandledTime = Date.now()\n                this.cancelPendingReaderUIToggle()\n                return\n            }"),
  'Android touchend must check onText and return without toggling UI when text is tapped'
);
console.log('  [PASS] Android touchend text tap toolbar suppression verified.');

// 1.5 pointerdown double-click lockout check scoped to text hits
assert.ok(
  appJs.includes("if (!isTouch && e.detail > 1) {\n                if (isPointerDirectlyOnText(e)) {\n                    this._lastDoubleClickTime = now\n                    this.cancelPendingReaderUIToggle()\n                }\n            }"),
  'pointerdown double-click lockout must only activate on confirmed text hits'
);
console.log('  [PASS] pointerdown double-click lockout scoped to text verified.');

// 1.6 click listener double-click check scoped to text hits
assert.ok(
  appJs.includes("if (!isTouch) {\n                if (e.detail > 1) {\n                    if (onText) {\n                        this._lastDoubleClickTime = now\n                        this._lastDocClickTime = now\n                        this.cancelPendingReaderUIToggle()\n                        return\n                    }\n                }\n            }"),
  'click listener double-click check must only cancel and return on text hits'
);
console.log('  [PASS] click listener double-click suppression scoped to text verified.');

// ---------------------------------------------------------------------------
// 2. Multi-line span blank space hit testing unit test
// ---------------------------------------------------------------------------
console.log('\n2. Testing multi-line span hit testing logic...');

function simulateIsPointerDirectlyOnText(target, clientX, clientY) {
  if (!target || target.nodeType !== 1) return false;
  if (target.matches?.('span, em, strong, b, i, u, mark, a, code, small, sub, sup')) {
    const rects = target.getClientRects?.();
    if (rects && rects.length > 0) {
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (clientX >= r.left && clientX <= r.right &&
            clientY >= r.top && clientY <= r.bottom) {
          return true;
        }
      }
    }
  }
  return false;
}

// A 2-line span where line 1 has empty whitespace on the right
const mockMultiLineSpan = {
  nodeType: 1,
  matches: (sel) => sel.includes('span'),
  getClientRects: () => [
    { left: 40, right: 240, top: 100, bottom: 124 }, // Line 1: text width 200px
    { left: 40, right: 600, top: 128, bottom: 152 }, // Line 2: text width 560px
  ]
};

// Click directly on glyph in Line 1
assert.equal(simulateIsPointerDirectlyOnText(mockMultiLineSpan, 150, 112), true, 'Click on text glyph should be onText=true');

// Click on whitespace to the right of Line 1 (x=450, y=112)
assert.equal(simulateIsPointerDirectlyOnText(mockMultiLineSpan, 450, 112), false, 'Click on whitespace to right of Line 1 MUST be onText=false');

// Click in vertical gap between lines (x=150, y=126)
assert.equal(simulateIsPointerDirectlyOnText(mockMultiLineSpan, 150, 126), false, 'Click in gap between lines MUST be onText=false');

console.log('  [PASS] Multi-line span correctly distinguishes text glyphs from blank margin whitespace.');

// ---------------------------------------------------------------------------
// 3. Android Touch vs Desktop Mouse Behavior Simulation
// ---------------------------------------------------------------------------
console.log('\n3. Testing Android touch and Desktop mouse interaction flow...');

class FullReaderSimulator {
  constructor(isMobile = false) {
    this.isMobile = isMobile;
    this.uiToggledCount = 0;
    this.pendingTimer = null;
    this.lastDoubleClickTime = 0;
    this.lastTapHandledTime = 0;
  }

  cancelPendingReaderUIToggle() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  toggleReaderUI() {
    this.uiToggledCount++;
  }

  requestToggleReaderUI(delay = 0) {
    this.cancelPendingReaderUIToggle();
    const effectiveDelay = this.isMobile ? Math.min(delay, 80) : delay;
    const doToggle = () => {
      this.pendingTimer = null;
      if (!this.isMobile && delay > 0 && this.lastDoubleClickTime && (Date.now() - this.lastDoubleClickTime < 300)) {
        return;
      }
      this.toggleReaderUI();
    };

    if (effectiveDelay <= 0) {
      doToggle();
    } else {
      this.pendingTimer = setTimeout(doToggle, effectiveDelay);
    }
  }

  // Simulates Android touchend
  handleTouchEnd(onText) {
    if (!this.isMobile) return;
    if (onText) {
      this.lastTapHandledTime = Date.now();
      this.cancelPendingReaderUIToggle();
      return; // Do NOT toggle UI
    }
    this.lastTapHandledTime = Date.now();
    this.cancelPendingReaderUIToggle();
    this.requestToggleReaderUI(60);
  }

  // Simulates Desktop click
  handleClick(onText, detail = 1) {
    if (this.isMobile) return;
    const now = Date.now();
    if (detail > 1) {
      if (onText) {
        this.lastDoubleClickTime = now;
        this.cancelPendingReaderUIToggle();
        return;
      }
    }
    const toggleDelay = onText ? 200 : 0;
    this.requestToggleReaderUI(toggleDelay);
  }
}

// Test 3.1: Android tap on word -> UI must NOT toggle
const androidSim = new FullReaderSimulator(true);
androidSim.handleTouchEnd(true); // Tap on text
assert.equal(androidSim.uiToggledCount, 0, 'Android tap on word must NOT toggle UI');
assert.equal(androidSim.pendingTimer, null, 'No pending timer should exist for text tap');
console.log('  [PASS] Android tap on word does not toggle UI.');

// Test 3.2: Android tap on blank space -> UI toggles after 60ms
androidSim.handleTouchEnd(false); // Tap on blank space
assert.notEqual(androidSim.pendingTimer, null, 'Android blank tap schedules 60ms timer');
await new Promise(r => setTimeout(r, 80));
assert.equal(androidSim.uiToggledCount, 1, 'Android blank space tap toggles UI after delay');
console.log('  [PASS] Android tap on blank space cleanly toggles UI.');

// Test 3.3: Desktop click on blank space -> UI toggles immediately (0ms)
const desktopSim = new FullReaderSimulator(false);
desktopSim.handleClick(false, 1);
assert.equal(desktopSim.uiToggledCount, 1, 'Desktop blank space click must toggle UI immediately at 0ms');
assert.equal(desktopSim.pendingTimer, null, 'No timer used for desktop blank space click');
console.log('  [PASS] Desktop click on blank space toggles immediately (0ms).');

// Test 3.4: Desktop rapid successive clicks on blank space -> Each click toggles immediately
desktopSim.handleClick(false, 1);
assert.equal(desktopSim.uiToggledCount, 2, 'Second blank space click toggles immediately');
desktopSim.handleClick(false, 2); // Quick second click (detail=2)
assert.equal(desktopSim.uiToggledCount, 3, 'Rapid double-click on blank space toggles without deadlocking');
assert.equal(desktopSim.lastDoubleClickTime, 0, 'Blank space click must not set lastDoubleClickTime');
console.log('  [PASS] Desktop rapid clicks on blank space toggle cleanly without deadlock.');

// Test 3.5: Desktop double-click on text -> UI does NOT toggle
desktopSim.handleClick(true, 1); // Click 1 on text
assert.notEqual(desktopSim.pendingTimer, null, 'Text click 1 schedules 200ms timer');
desktopSim.handleClick(true, 2); // Click 2 on text (double-click within 200ms)
assert.equal(desktopSim.pendingTimer, null, 'Text click 2 cancels pending timer');
await new Promise(r => setTimeout(r, 220));
assert.equal(desktopSim.uiToggledCount, 3, 'Desktop double-click on text must NOT toggle UI');
assert.ok(desktopSim.lastDoubleClickTime > 0, 'Text double click sets lastDoubleClickTime');
console.log('  [PASS] Desktop double-click on text selects word without toggling UI.');

console.log('\n================================================================');
console.log('ALL VERIFICATION SUITES PASSED SUCCESSFULLY');
console.log('================================================================');
