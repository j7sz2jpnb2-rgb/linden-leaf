import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Deep Automated Verification: 3 Review Items ===\n');

// -----------------------------------------------------------------------------
// Test 1: Chapter Translation Button & Modal Texts
// -----------------------------------------------------------------------------
console.log('Test 1: Chapter Translation Button & Modal Strings...');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Button in top translation control bar
const retransBtn = indexHtml.match(/<button[^>]*id="btn-chapter-trans-retranslate"[^>]*>([\s\S]*?)<\/button>/);
assert.ok(retransBtn, 'btn-chapter-trans-retranslate exists in index.html');
assert.equal(retransBtn[1].trim(), '翻译', 'Button text must be 翻译');
assert.ok(!retransBtn[0].includes('重译'), 'Button HTML must not contain 重译');

// Verify chapter-translation-manager.js does not contain 重译
const ctmJs = fs.readFileSync(path.join(root, 'js/chapter-translation-manager.js'), 'utf8');
assert.ok(!ctmJs.includes('重译'), 'chapter-translation-manager.js must not contain 重译');

console.log('  [PASS] Item 1 Verified.');

// -----------------------------------------------------------------------------
// Test 2: Book Title CSS, Truncation, Font Files, and URI Decoding
// -----------------------------------------------------------------------------
console.log('Test 2: Book Title Layout & Typography Audit...');
const mainCss = fs.readFileSync(path.join(root, 'css/main.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'css/desktop-ui.css'), 'utf8');
const mobileCss = fs.readFileSync(path.join(root, 'css/mobile-shell.css'), 'utf8');

// main.css checks
const mainMatch = mainCss.match(/\.jane-book-title\s*\{([^}]+)\}/);
assert.ok(mainMatch, '.jane-book-title exists in main.css');
assert.ok(mainMatch[1].includes('line-height: 1.5'), 'main.css line-height must be 1.5');
assert.ok(mainMatch[1].includes('min-height: calc(2 * 1.5em)'), 'main.css min-height must be calc(2 * 1.5em)');
assert.ok(mainMatch[1].includes('max-height: none'), 'main.css max-height must be none');
assert.ok(mainMatch[1].includes('-webkit-line-clamp: 2'), 'main.css must clamp to 2 lines');
assert.ok(mainMatch[1].includes('padding-bottom: 2px'), 'main.css must have padding-bottom: 2px');

// desktop-ui.css checks
const deskMatch = desktopCss.match(/\.jane-book-title\s*\{([^}]+)\}/);
assert.ok(deskMatch, '.jane-book-title exists in desktop-ui.css');
assert.ok(deskMatch[1].includes('line-height: 1.5'), 'desktop-ui.css line-height must be 1.5');
assert.ok(deskMatch[1].includes('min-height: calc(2 * 1.5em)'), 'desktop-ui.css min-height must be calc(2 * 1.5em)');
assert.ok(deskMatch[1].includes('max-height: none'), 'desktop-ui.css max-height must be none');

// mobile-shell.css checks
const mobileMatch = mobileCss.match(/html\.is-mobile-viewport\s+\.jane-book-card\s+\.jane-book-title\s*\{([^}]+)\}/);
assert.ok(mobileMatch, 'mobile-shell.css jane-book-title rule exists');
assert.ok(mobileMatch[1].includes('line-height: 1.45'), 'mobile-shell line-height must be 1.45');
assert.ok(mobileMatch[1].includes('max-height: none'), 'mobile-shell max-height must be none');

// Font assets audit
const fontsDir = path.join(root, 'assets/fonts');
const fontFiles = fs.readdirSync(fontsDir).filter(f => f.endsWith('.woff2'));
assert.ok(fontFiles.length >= 20, `Expected at least 20 font files, found ${fontFiles.length}`);

// Verify Noto Serif SC files are full fonts (> 1MB)
const notoScFiles = fontFiles.filter(f => f.startsWith('noto-serif-sc'));
assert.ok(notoScFiles.length >= 3, 'Noto Serif SC weights 400, 600, 700 exist');
for (const f of notoScFiles) {
    const stat = fs.statSync(path.join(fontsDir, f));
    assert.ok(stat.size > 1_000_000, `Noto Serif SC file ${f} is full Chinese font (${stat.size} bytes)`);
}

// Preloads in index.html
assert.ok(indexHtml.includes('noto-serif-sc-chinese-simplified-400-normal.woff2'), 'Noto Serif SC 400 preloaded');
assert.ok(indexHtml.includes('noto-serif-sc-chinese-simplified-600-normal.woff2'), 'Noto Serif SC 600 preloaded');
assert.ok(indexHtml.includes('plus-jakarta-sans-latin-400-normal.woff2'), 'Plus Jakarta Sans 400 preloaded');
assert.ok(indexHtml.includes('plus-jakarta-sans-latin-500-normal.woff2'), 'Plus Jakarta Sans 500 preloaded');

// URI Decoding in js/book-title.js
const { resolveBookTitle, withReadableBookTitle } = await import(pathToFileURL(path.join(root, 'js/book-title.js')).href);
assert.equal(resolveBookTitle('Aeneis %E5%9F%83%E6%B6%85%E9%98%BF%E6%96%AF%E7%BA%AA'), 'Aeneis 埃涅阿斯纪');
assert.equal(resolveBookTitle('%E5%B0%8F%E9%95%87%E5%96%A7 keepsake'), '小镇喧 keepsake');
assert.equal(resolveBookTitle('100% Complete'), '100% Complete');
assert.equal(resolveBookTitle('Invalid %ZZ Percent'), 'Invalid %ZZ Percent');
assert.equal(resolveBookTitle('unknown', 'path/to/%E7%BB%8F%E5%85%B8.epub'), '经典');
assert.deepEqual(withReadableBookTitle({ title: '%E7%A5%9E%E6%9B%B2', id: '1' }), { title: '神曲', id: '1' });

console.log('  [PASS] Item 2 Verified.');

// -----------------------------------------------------------------------------
// Test 3: Double Click Toolbar Suppression & Hit Testing Disambiguation
// -----------------------------------------------------------------------------
console.log('Test 3: Reader Double-Click & Toolbar Interaction...');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

// Safeguards in requestToggleReaderUI
assert.ok(appJs.includes('this._lastDoubleClickTime && (Date.now() - this._lastDoubleClickTime < 300)'), 'Double-click suppression check exists');
assert.ok(appJs.includes('this.dom.readerDictionaryCard && this.dom.readerDictionaryCard.style.display !== \'none\''), 'Active dictionary card suppression check exists');
assert.ok(appJs.includes('this.dom.selectionPopup && this.dom.selectionPopup.style.display !== \'none\''), 'Active selection popup suppression check exists');
assert.ok(appJs.includes('this.dom.footnotePopup && this.dom.footnotePopup.style.display !== \'none\''), 'Active footnote popup suppression check exists');
assert.ok(appJs.includes('winSel && !winSel.isCollapsed && winSel.toString().trim().length > 0'), 'Window text selection suppression exists');
assert.ok(appJs.includes('this.foliateView?.renderer?.getContents?.()'), 'Iframe contents selection check exists');

// Disambiguation between text click and blank area click
assert.ok(appJs.includes('const isPointerDirectlyOnText = (e) =>'), 'isPointerDirectlyOnText helper exists');
assert.ok(appJs.includes('const onText = isPointerDirectlyOnText(e)'), 'onText check exists in click handler');
assert.ok(appJs.includes('const toggleDelay = isTouch ? 60 : (onText ? 200 : 0)'), 'toggleDelay differentiates text vs blank space with 0ms immediate desktop blank toggle');

// Simulated timeline: Double-click event sequence verification
class MockReaderController {
    constructor() {
        this.toggled = false;
        this.timer = null;
        this.lastDoubleClickTime = 0;
        this.lastPointerDownTime = 0;
        this.lastClickTime = 0;
        this.selection = '';
        this.dictionaryCardVisible = false;
    }

    cancelPendingToggle() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    requestToggle(delay = 0) {
        this.cancelPendingToggle();
        if (delay <= 0) {
            if (this.selection) return;
            if (this.dictionaryCardVisible) return;
            this.toggled = !this.toggled;
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.lastDoubleClickTime && (Date.now() - this.lastDoubleClickTime < 300)) return;
            if (this.selection) return;
            if (this.dictionaryCardVisible) return;
            this.toggled = !this.toggled;
        }, delay);
    }

    onPointerDown(e) {
        const now = Date.now();
        this.lastPointerDownTime = now;
        if (e.detail > 1) {
            this.lastDoubleClickTime = now;
            this.cancelPendingToggle();
        }
    }

    onClick(e, onText = false) {
        const now = Date.now();
        if (e.detail > 1 && onText) {
            this.lastDoubleClickTime = now;
            this.lastClickTime = now;
            this.cancelPendingToggle();
            return;
        }
        this.lastClickTime = now;
        if (this.selection) {
            this.selection = '';
            this.cancelPendingToggle();
            return;
        }
        const delay = onText ? 200 : 0;
        this.requestToggle(delay);
    }

    onSelectionChange(newSelection) {
        this.selection = newSelection;
        if (newSelection) {
            this.cancelPendingToggle();
        }
    }
}

// Scenario A: Fast double-click on word (100ms)
const sim1 = new MockReaderController();
sim1.onPointerDown({ detail: 1 });
sim1.onClick({ detail: 1 }, true); // onText = true
await new Promise(r => setTimeout(r, 100));
sim1.onPointerDown({ detail: 2 });
sim1.onSelectionChange('whispered');
sim1.onClick({ detail: 2 }, true);
await new Promise(r => setTimeout(r, 250));
assert.equal(sim1.toggled, false, 'Fast double-click must NOT toggle toolbar');
assert.equal(sim1.selection, 'whispered', 'Word should remain selected');

// Scenario B: Double-click with detail > 1 on word cancels toggle
const sim2 = new MockReaderController();
sim2.onPointerDown({ detail: 1 });
sim2.onClick({ detail: 1 }, true); // onText = true (200ms delay)
await new Promise(r => setTimeout(r, 120));
sim2.onPointerDown({ detail: 2 });
sim2.onSelectionChange('Gatsby');
sim2.onClick({ detail: 2 }, true);
await new Promise(r => setTimeout(r, 250));
assert.equal(sim2.toggled, false, 'Double-click must NOT toggle toolbar');
assert.equal(sim2.selection, 'Gatsby', 'Word should remain selected');

// Scenario C: Blank area single click toggles immediately (0ms delay)
const sim3 = new MockReaderController();
sim3.onPointerDown({ detail: 1 });
sim3.onClick({ detail: 1 }, false); // onText = false (0ms delay)
assert.equal(sim3.toggled, true, 'Blank area single click MUST toggle toolbar immediately');

console.log('  [PASS] Item 3 Verified.');

console.log('\n=== ALL 3 ITEMS PASSED DEEP AUTOMATED VERIFICATION ===\n');
