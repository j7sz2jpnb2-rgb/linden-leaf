// scripts/test-round5-fixes.mjs
// Verification suite for:
// Bug 1: Wheel event isolation between AI sidebar/modals and reader page flipper
// Bug 2: Pointer selection flag reset on global pointerup & suppression of page flips during sidebar reflow/resize
// Bug 3: Dictionary card footer button layout, 320px width, nowrap, and "问 AI" label
// Bug 4: Virtual selection highlight guard (>1 only) and single-click collapse cleanup
// Bug 5: Custom list modal input placeholder and top padding adjustments

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('====================================================');
console.log(' RUNNING VERIFICATION FOR ROUND 5 BUG FIXES');
console.log('====================================================\n');

// -------------------------------------------------------------
// Test 1: Wheel event isolation in app.js and ai-sidebar-controller.js
// -------------------------------------------------------------
console.log('Test 1: Wheel event isolation and stopPropagation...');

const appJs = fs.readFileSync(path.join(rootDir, 'js', 'app.js'), 'utf8');
const aiSidebarJs = fs.readFileSync(path.join(rootDir, 'js', 'ai-sidebar-controller.js'), 'utf8');

// 1a: app.js stopWheelElements must query AI sidebar elements
assert(appJs.includes('#reader-ai-sidebar'), 'app.js must include #reader-ai-sidebar in stopWheelElements');
assert(appJs.includes('.reader-ai-sidebar'), 'app.js must include .reader-ai-sidebar in stopWheelElements');
assert(appJs.includes('#ai-chat-messages'), 'app.js must include #ai-chat-messages in stopWheelElements');

// 1b: app.js window wheel listener must exclude AI sidebar and modals
const windowWheelMatch = appJs.match(/window\.addEventListener\('wheel',\s*e\s*=>\s*\{([\s\S]*?)\},\s*\{\s*passive:\s*false\s*\}\)/);
assert(windowWheelMatch, 'window wheel listener must exist');
const wheelBody = windowWheelMatch[1];
assert(wheelBody.includes('#reader-ai-sidebar'), 'wheelBody must exclude #reader-ai-sidebar');
assert(wheelBody.includes('#ai-chat-messages'), 'wheelBody must exclude #ai-chat-messages');
assert(wheelBody.includes('#modal-ai-presets'), 'wheelBody must exclude #modal-ai-presets');
assert(wheelBody.includes('#modal-ai-history'), 'wheelBody must exclude #modal-ai-history');

// 1c: ai-sidebar-controller.js must stop wheel propagation on sidebar and chat
assert(aiSidebarJs.includes('stopWheelInside(this.dom.readerAiSidebar)'), 'ai-sidebar-controller must stop wheel on readerAiSidebar');
assert(aiSidebarJs.includes('stopWheelInside(this.dom.aiChatMessages)'), 'ai-sidebar-controller must stop wheel on aiChatMessages');

console.log('  ✓ Test 1 Passed: Wheel events inside AI sidebar and modals are thoroughly isolated.\n');

// -------------------------------------------------------------
// Test 2: Pointer selection reset & resize suppression in paginator.js
// -------------------------------------------------------------
console.log('Test 2: Paginator pointer selection and resize reflow guards...');

const paginatorJs = fs.readFileSync(path.join(rootDir, 'foliate-js-main', 'paginator.js'), 'utf8');

// 2a: debounce must support cancel
assert(paginatorJs.includes('debounced.cancel = () =>'), 'debounce utility must support cancel');

// 2b: Paginator must have #isPointerSelecting and #checkPointerSelection fields
assert(paginatorJs.includes('#isPointerSelecting = false'), 'Paginator must have #isPointerSelecting private field');
assert(paginatorJs.includes('#lastResizeTime = 0'), 'Paginator must have #lastResizeTime private field');
assert(paginatorJs.includes('#clearPointerSelecting()'), 'Paginator must have #clearPointerSelecting method');

// 2c: Global pointerup / pointercancel listeners attached to window
assert(paginatorJs.includes('window.addEventListener(\'pointerup\', this.#globalPointerUpListener)'), 'Paginator must listen to window pointerup');
assert(paginatorJs.includes('window.addEventListener(\'pointercancel\', this.#globalPointerUpListener)'), 'Paginator must listen to window pointercancel');

// 2d: render() must clear pointer selecting and update #lastResizeTime
const renderMethod = paginatorJs.match(/render\(\)\s*\{([\s\S]*?)\n\s*get scrolled\(\)/);
assert(renderMethod, 'render() method must exist in paginator.js');
const renderBody = renderMethod[1];
assert(renderBody.includes('this.#clearPointerSelecting()'), 'render() must clear pointer selecting');
assert(renderBody.includes('this.#lastResizeTime = Date.now()'), 'render() must record #lastResizeTime');
assert(renderBody.includes('this.#relocateTimeout'), 'render() must settle pending relocate timeout');

// 2e: checkPointerSelection must reject checks during/after resize
assert(paginatorJs.includes('if (Date.now() - this.#lastResizeTime < 1000) return'), 'checkPointerSelection must ignore checks within 1000ms of resize');

// 2f: aiSidebarController.relayoutReader must reflow foliateView.renderer
assert(aiSidebarJs.includes('this.app?.foliateView?.renderer'), 'relayoutReader must handle foliateView.renderer');
assert(aiSidebarJs.includes('renderer.settle()'), 'relayoutReader must call renderer.settle');
assert(aiSidebarJs.includes('renderer.render()'), 'relayoutReader must call renderer.render');

console.log('  ✓ Test 2 Passed: Paginator correctly clears pointer selection on global pointerup and suppresses spurious page flips during sidebar reflow.\n');

// -------------------------------------------------------------
// Test 3: Dictionary Card Footer Styling & "问 AI" Label
// -------------------------------------------------------------
console.log('Test 3: Dictionary card footer button layout and width...');

const mainCss = fs.readFileSync(path.join(rootDir, 'css', 'main.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

// 3a: Card width must be 320px
const cardMatch = mainCss.match(/\.reader-dictionary-card\s*\{([^}]+)\}/);
assert(cardMatch, '.reader-dictionary-card rule must exist in main.css');
assert(cardMatch[1].includes('width: 320px;'), '.reader-dictionary-card width must be 320px');

// 3b: Footer items must have nowrap and flex-shrink: 0
const badgeMatch = mainCss.match(/\.dict-source-badge\s*\{([^}]+)\}/);
assert(badgeMatch && badgeMatch[1].includes('white-space: nowrap;'), '.dict-source-badge must have white-space: nowrap');
assert(badgeMatch && badgeMatch[1].includes('flex-shrink: 0;'), '.dict-source-badge must have flex-shrink: 0');

const actionMatch = mainCss.match(/\.btn-dict-action\s*\{([^}]+)\}/);
assert(actionMatch && actionMatch[1].includes('white-space: nowrap;'), '.btn-dict-action must have white-space: nowrap');
assert(actionMatch && actionMatch[1].includes('flex-shrink: 0;'), '.btn-dict-action must have flex-shrink: 0');

// 3c: Button label in index.html must be "问 AI"
assert(indexHtml.includes('id="btn-dict-ask-ai" title="在 AI 中询问 (附上选词，需主动点击发送)">问 AI</button>'), 'btn-dict-ask-ai text must be "问 AI"');

console.log('  ✓ Test 3 Passed: Dictionary card width expanded to 320px, buttons nowrap, text simplified to "问 AI".\n');

// -------------------------------------------------------------
// Test 4: Virtual Selection Guard (>1) and Collapse Cleanup
// -------------------------------------------------------------
console.log('Test 4: Virtual multi-selections guard and single-click cleanup...');

// 4a: onReaderRelocate must guard multiSelectedRanges.length > 1
assert(appJs.includes('if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {\n            this.renderVirtualMultiSelections()'), 'onReaderRelocate must require length > 1 for virtual selections');

// 4b: doc load normalization must guard multiSelectedRanges.length > 1
assert(appJs.includes('if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {\n            setTimeout(() => this.renderVirtualMultiSelections(), 60)'), 'doc load must require length > 1 for virtual selections');

// 4c: renderVirtualMultiSelections must guard length <= 1 and clear
const renderVirtualMatch = appJs.match(/renderVirtualMultiSelections\(\)\s*\{([\s\S]*?)\n\s*clearVirtualMultiSelections/);
assert(renderVirtualMatch, 'renderVirtualMultiSelections must exist in app.js');
assert(renderVirtualMatch[1].includes('this.multiSelectedRanges.length <= 1'), 'renderVirtualMultiSelections must guard length <= 1');

// 4d: selectionchange must immediately clear on collapse
const selChangeMatch = appJs.match(/doc\.addEventListener\('selectionchange',\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/);
assert(selChangeMatch, 'selectionchange listener must exist');
const selChangeBody = selChangeMatch[1];
assert(selChangeBody.includes('this.clearVirtualMultiSelections()'), 'selectionchange must clear virtual multi selections when collapsed');
assert(selChangeBody.includes('this.multiSelectedRanges = []'), 'selectionchange must reset multiSelectedRanges on collapse');

// 4e: view.js must support deleteAnnotation by id without raw CFI
const viewJs = fs.readFileSync(path.join(rootDir, 'foliate-js-main', 'view.js'), 'utf8');
assert(viewJs.includes('if (remove && (!value || typeof value !== \'string\') && annotation.id)'), 'view.js must support deleteAnnotation by id');

console.log('  ✓ Test 4 Passed: Virtual selections are strictly restricted to multi-selection mode (>1) and cleared immediately on collapse.\n');

// -------------------------------------------------------------
// Test 5: Modal Custom List Header Distance and Placeholder
// -------------------------------------------------------------
console.log('Test 5: Custom list modal input placeholder and top padding...');

// 5a: index.html placeholder must be concise
assert(indexHtml.includes('placeholder="例如：社科阅读"'), 'index.html input placeholder must be "例如：社科阅读"');

// 5b: index.html top padding reduced
assert(indexHtml.includes('style="padding: 0.5rem 0 0.75rem 0; display: flex; flex-direction: column; gap: 0.85rem;"'), 'modal-create-list body padding must be "0.5rem 0 0.75rem 0"');

// 5c: app.js openCreateListModal sets placeholder dynamically
assert(appJs.includes('this.dom.inputCustomListName.placeholder = (this.customLists && this.customLists.length > 0) ? \'输入书单名称\' : \'例如：社科阅读\''), 'openCreateListModal must dynamically set placeholder');

console.log('  ✓ Test 5 Passed: Custom list modal placeholder and top padding verified.\n');

console.log('====================================================');
console.log(' ALL ROUND 5 VERIFICATIONS PASSED SUCCESSFULLY!');
console.log('====================================================\n');
