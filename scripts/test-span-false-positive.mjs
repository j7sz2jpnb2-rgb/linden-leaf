// Test multi-line span false positive in isPointerDirectlyOnText
import assert from 'node:assert/strict';

// Simulate the logic in js/app.js:
function testIsPointerDirectlyOnText_Step3(target, clientX, clientY) {
  // Step 3 as written in app.js:
  if (target.matches?.('span, em, strong, b, i, u, mark, a, code, small, sub, sup')) {
    const rect = target.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      if (clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        return true;
      }
    }
  }
  return false;
}

// Suppose a multi-line span in an EPUB:
// Container width: 600px.
// Line 1: x: 50 to 300, y: 100 to 120. (right half of line 1, from x: 300 to 600, is blank space!)
// Line 2: x: 50 to 550, y: 120 to 140.
// getBoundingClientRect of target: left: 50, right: 550, top: 100, bottom: 140.
const target = {
  matches: (selector) => selector.includes('span'),
  getBoundingClientRect: () => ({ left: 50, right: 550, top: 100, bottom: 140, width: 500, height: 40 }),
  getClientRects: () => [
    { left: 50, right: 300, top: 100, bottom: 120, width: 250, height: 20 },
    { left: 50, right: 550, top: 120, bottom: 140, width: 500, height: 20 }
  ]
};

// User clicks in the blank space on Line 1 at x = 400, y = 110:
const clickX = 400;
const clickY = 110;

const resultStep3 = testIsPointerDirectlyOnText_Step3(target, clickX, clickY);
console.log('Click on blank space to the right of line 1 (x=400, y=110):');
console.log('Current Step 3 returns onText =', resultStep3);
assert.equal(resultStep3, true, 'Current Step 3 falsely claims blank space is onText!');
console.log('Confirmed: Step 3 falsely classifies blank space as onText = true!');
