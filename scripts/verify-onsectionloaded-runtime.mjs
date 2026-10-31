import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Deep Verification: onSectionLoaded Runtime Execution & Blank Space Click ===\n');

const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

// -----------------------------------------------------------------------------
// Test 1: Static Scope Invariant
// -----------------------------------------------------------------------------
console.log('1. Checking static lexical scoping of isPointerDirectlyOnText...');
const normDocIdx = appJs.indexOf('normalizeEpubDocument(doc) {');
const onSecIdx = appJs.indexOf('onSectionLoaded({ doc, index }) {');
const isPtrIdx = appJs.indexOf('const isPointerDirectlyOnText = (e) => {');

assert.ok(onSecIdx !== -1, 'onSectionLoaded must exist in js/app.js');
assert.ok(normDocIdx !== -1, 'normalizeEpubDocument must exist in js/app.js');
assert.ok(isPtrIdx !== -1, 'isPointerDirectlyOnText must exist in js/app.js');

assert.ok(isPtrIdx > onSecIdx, 'isPointerDirectlyOnText must be defined AFTER onSectionLoaded header');
assert.ok(isPtrIdx < onSecIdx + 200, 'isPointerDirectlyOnText must be near the top of onSectionLoaded');

const normDocContent = appJs.slice(normDocIdx, onSecIdx);
assert.ok(!normDocContent.includes('isPointerDirectlyOnText'), 'isPointerDirectlyOnText must NOT exist inside normalizeEpubDocument');
console.log('  [PASS] isPointerDirectlyOnText is scoped inside onSectionLoaded and absent from normalizeEpubDocument.');

// -----------------------------------------------------------------------------
// Test 2: Runtime Execution Simulation
// -----------------------------------------------------------------------------
console.log('\n2. Testing runtime execution of onSectionLoaded and event handlers...');

const startMarker = '    onSectionLoaded({ doc, index }) {';
const startIdx = appJs.indexOf(startMarker);
let endIdx = appJs.indexOf('\r\n    renderVirtualMultiSelections() {');
if (endIdx === -1) endIdx = appJs.indexOf('\n    renderVirtualMultiSelections() {');
assert.ok(startIdx !== -1 && endIdx !== -1, 'Must locate onSectionLoaded method boundaries');

const methodSource = appJs.slice(startIdx, endIdx);

const Node = {
    ELEMENT_NODE: 1,
    TEXT_NODE: 3
};
const NodeFilter = {
    SHOW_TEXT: 4
};

const factory = vm.runInNewContext(`
(function(context) {
    const { Node, NodeFilter, markReaderPaperBackgrounds, FEATURE_CHAPTER_TRANSLATION_ENABLED, tracker, platformBridge, window } = context;
    return {
        ${methodSource}
    };
})
`, { console });

const mockContext = {
    Node,
    NodeFilter,
    markReaderPaperBackgrounds: () => {},
    FEATURE_CHAPTER_TRANSLATION_ENABLED: false,
    tracker: { resetActivity: () => {} },
    platformBridge: { isAndroid: false },
    window: {
        mobileShell: { isMobileViewport: () => false },
        getSelection: () => ({ isCollapsed: true, toString: () => '', removeAllRanges: () => {} })
    }
};

const obj = factory(mockContext);

// Create mock document and app instance
const listeners = new Map();
const mockBody = {
    nodeType: Node.ELEMENT_NODE,
    tagName: 'BODY',
    matches: (sel) => false,
    closest: (sel) => null,
    firstElementChild: null,
    querySelectorAll: () => []
};
const mockDoc = {
    _readerInitDone: false,
    body: mockBody,
    documentElement: { nodeType: Node.ELEMENT_NODE, tagName: 'HTML', matches: () => false, closest: () => null },
    addEventListener: (type, handler, opts) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
    },
    getSelection: () => ({ isCollapsed: true, toString: () => '', removeAllRanges: () => {} }),
    createRange: () => ({
        selectNodeContents: () => {},
        getClientRects: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        setStart: () => {},
        setEnd: () => {}
    }),
    createTreeWalker: () => ({ nextNode: () => null })
};

let toggleCalls = [];
let cancelCalls = 0;

const mockAppInstance = {
    settings: { chineseQuotes: false },
    normalizeEpubDocument: () => {},
    multiSelectedRanges: [],
    requestToggleReaderUI: (delay) => {
        toggleCalls.push(delay);
    },
    cancelPendingReaderUIToggle: () => {
        cancelCalls++;
    },
    hideHighlightActionPopup: () => {},
    clearVirtualMultiSelections: () => {},
    hideSelectionPopup: () => {},
    hideDictionaryCard: () => {},
    hideFootnotePopup: () => {},
    showFootnotePopup: () => {},
    dom: {
        readerDictionaryCard: { style: { display: 'none' }, classList: { contains: () => false } },
        selectionPopup: { style: { display: 'none' }, classList: { contains: () => false } },
        highlightActionPopup: { style: { display: 'none' }, classList: { contains: () => false } },
        footnotePopup: { style: { display: 'none' }, classList: { contains: () => false } }
    },
    handleGlobalKeydown: () => {}
};

// Bind onSectionLoaded to mockAppInstance
obj.onSectionLoaded.call(mockAppInstance, { doc: mockDoc, index: 0 });

assert.ok(mockDoc._readerInitDone === true, 'doc._readerInitDone must be set to true');
assert.ok(listeners.has('click'), 'doc must have click listener attached');
assert.ok(listeners.has('pointerdown'), 'doc must have pointerdown listener attached');
assert.ok(listeners.has('dblclick'), 'doc must have dblclick listener attached');
assert.ok(listeners.has('touchend'), 'doc must have touchend listener attached');
console.log('  [PASS] onSectionLoaded executed cleanly and registered event listeners.');

// -----------------------------------------------------------------------------
// Test 3: Click event execution without ReferenceError
// -----------------------------------------------------------------------------
console.log('\n3. Testing click event execution (desktop blank space vs text)...');

const clickHandlers = listeners.get('click');
assert.ok(clickHandlers.length >= 1, 'At least one click handler registered');
const clickHandler = clickHandlers[0];

// Case 3.1: Blank space click (e.g. click on body margin)
toggleCalls = [];
const blankClickEvent = {
    target: mockDoc.body,
    clientX: 200,
    clientY: 200,
    pointerType: 'mouse',
    button: 0,
    ctrlKey: false,
    detail: 1,
    defaultPrevented: false
};

// This call previously threw `ReferenceError: isPointerDirectlyOnText is not defined`
await assert.doesNotReject(async () => {
    await clickHandler(blankClickEvent);
}, 'Click handler must not throw ReferenceError');

assert.equal(toggleCalls.length, 1, 'requestToggleReaderUI must be invoked once for blank space click');
assert.equal(toggleCalls[0], 0, 'Blank space click must invoke requestToggleReaderUI with 0ms delay (immediate)');
console.log('  [PASS] Desktop blank space click cleanly calls requestToggleReaderUI(0) with NO exceptions.');

// Case 3.2: Mobile touch blank space click
toggleCalls = [];
const touchClickEvent = {
    target: mockDoc.body,
    clientX: 200,
    clientY: 200,
    pointerType: 'touch',
    button: 0,
    ctrlKey: false,
    detail: 1,
    defaultPrevented: false
};
await clickHandler(touchClickEvent);
assert.equal(toggleCalls.length, 1, 'requestToggleReaderUI must be invoked once for touch click');
assert.equal(toggleCalls[0], 60, 'Touch click must invoke requestToggleReaderUI with 60ms delay');
console.log('  [PASS] Mobile/touch blank space click invokes requestToggleReaderUI(60).');

// Case 3.3: Pointer directly on inline text element
toggleCalls = [];
const mockSpan = {
    nodeType: Node.ELEMENT_NODE,
    tagName: 'SPAN',
    matches: (sel) => sel.includes('span'),
    closest: (sel) => null,
    getClientRects: () => [{ left: 50, right: 150, top: 50, bottom: 80 }]
};
const textClickEvent = {
    target: mockSpan,
    clientX: 100,
    clientY: 60,
    pointerType: 'mouse',
    button: 0,
    ctrlKey: false,
    detail: 1,
    defaultPrevented: false
};
await clickHandler(textClickEvent);
assert.equal(toggleCalls.length, 1, 'requestToggleReaderUI invoked for text click');
assert.equal(toggleCalls[0], 200, 'Text click must invoke requestToggleReaderUI with 200ms delay to allow double-click');
console.log('  [PASS] Desktop text click invokes requestToggleReaderUI(200).');

// Case 3.4: Pointerdown and dblclick handlers execution without ReferenceError
console.log('\n4. Testing pointerdown, dblclick, and touchend handlers...');
const pointerdownHandler = listeners.get('pointerdown')[1] || listeners.get('pointerdown')[0];
assert.doesNotThrow(() => {
    pointerdownHandler({
        target: mockSpan,
        clientX: 100,
        clientY: 60,
        pointerType: 'mouse',
        detail: 2,
        button: 0,
        ctrlKey: false
    });
}, 'pointerdown handler must execute without ReferenceError');
console.log('  [PASS] pointerdown double-click handler executed cleanly.');

const dblclickHandler = listeners.get('dblclick')[0];
assert.doesNotThrow(() => {
    dblclickHandler({
        target: mockSpan,
        clientX: 100,
        clientY: 60,
        detail: 2
    });
}, 'dblclick handler must execute without ReferenceError');
console.log('  [PASS] dblclick handler executed cleanly.');

const touchendHandlers = listeners.get('touchend');
const readerTouchendHandler = touchendHandlers.find(h => h.toString().includes('isPointerDirectlyOnText'));
if (readerTouchendHandler) {
    toggleCalls = [];
    // Enable mobile viewport for touchend test
    mockContext.window.mobileShell.isMobileViewport = () => true;
    
    // First trigger touchstart so docTouchStartTime is initialized
    const touchstartHandler = listeners.get('touchstart')[0];
    if (touchstartHandler) {
        touchstartHandler({
            touches: [{ clientX: 200, clientY: 200 }]
        });
    }

    assert.doesNotThrow(() => {
        readerTouchendHandler({
            target: mockDoc.body,
            clientX: 200,
            clientY: 200,
            touches: [],
            changedTouches: [{ clientX: 200, clientY: 200 }]
        });
    }, 'touchend handler must execute without ReferenceError');
    assert.equal(toggleCalls.length, 1, 'touchend on blank space triggers requestToggleReaderUI(60)');
    assert.equal(toggleCalls[0], 60);
    console.log('  [PASS] touchend blank space handler executed cleanly.');
}

console.log('\n====================================================');
console.log('ALL RUNTIME EXECUTION & SCOPE TESTS PASSED!');
console.log('====================================================');
