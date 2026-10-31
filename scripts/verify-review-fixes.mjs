import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('=== Running Verification for Code Review Fixes ===\n');

// 1. Verify Item 1: Chapter translation button label
console.log('1. Verifying Chapter Translation Button...');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const btnMatch = indexHtml.match(/<button[^>]*id="btn-chapter-trans-retranslate"[^>]*>([^<]+)<\/button>/);
assert.ok(btnMatch, 'btn-chapter-trans-retranslate exists in index.html');
assert.equal(btnMatch[1].trim(), '翻译', 'Button text must be 翻译');
assert.ok(!btnMatch[0].includes('重译'), 'Button must not contain 重译');
console.log('  [PASS] Button label is "翻译"');

// 2. Verify Item 2: Book Title CSS & Font Audit
console.log('2. Verifying Book Title CSS & Font Loading Audit...');
const mainCss = fs.readFileSync(path.join(root, 'css/main.css'), 'utf8');
const desktopCss = fs.readFileSync(path.join(root, 'css/desktop-ui.css'), 'utf8');

// Check main.css .jane-book-title
const mainTitleMatch = mainCss.match(/\.jane-book-title\s*\{([^}]+)\}/);
assert.ok(mainTitleMatch, '.jane-book-title rule found in main.css');
const mainTitleCss = mainTitleMatch[1];
assert.ok(mainTitleCss.includes('line-height: 1.5'), 'main.css must have line-height: 1.5');
assert.ok(mainTitleCss.includes('min-height: calc(2 * 1.5em)'), 'main.css must have min-height: calc(2 * 1.5em)');
assert.ok(mainTitleCss.includes('max-height: none'), 'main.css must have max-height: none to eliminate vertical clipping');
assert.ok(mainTitleCss.includes('-webkit-line-clamp: 2'), 'main.css must have -webkit-line-clamp: 2');
assert.ok(mainTitleCss.includes('padding-bottom: 2px'), 'main.css must have padding-bottom: 2px');

// Check desktop-ui.css .jane-book-title
const deskTitleMatch = desktopCss.match(/\.jane-book-title\s*\{([^}]+)\}/);
assert.ok(deskTitleMatch, '.jane-book-title rule found in desktop-ui.css');
const deskTitleCss = deskTitleMatch[1];
assert.ok(deskTitleCss.includes('line-height: 1.5'), 'desktop-ui.css must have line-height: 1.5');
assert.ok(deskTitleCss.includes('min-height: calc(2 * 1.5em)'), 'desktop-ui.css must have min-height: calc(2 * 1.5em)');
assert.ok(deskTitleCss.includes('max-height: none'), 'desktop-ui.css must have max-height: none to eliminate vertical clipping');

// Font files audit
const fontsDir = path.join(root, 'assets/fonts');
const fontsCss = fs.readFileSync(path.join(fontsDir, 'fonts.css'), 'utf8');
const fontFiles = fs.readdirSync(fontsDir).filter(f => f.endsWith('.woff2'));
assert.ok(fontFiles.length >= 13, `Expected at least 13 woff2 font files, found ${fontFiles.length}`);
for (const f of fontFiles) {
    const stat = fs.statSync(path.join(fontsDir, f));
    assert.ok(stat.size > 10000, `Font file ${f} is unexpectedly small (${stat.size} bytes)`);
}

// Preload links in index.html
assert.ok(indexHtml.includes('rel="preload" href="./assets/fonts/noto-serif-sc-chinese-simplified-400-normal.woff2"'), 'Noto Serif SC preloaded');
assert.ok(indexHtml.includes('rel="preload" href="./assets/fonts/plus-jakarta-sans-latin-400-normal.woff2"'), 'Plus Jakarta Sans preloaded');
assert.ok(indexHtml.includes('rel="preload" href="./assets/fonts/lora-latin-400-normal.woff2"'), 'Lora preloaded');
console.log('  [PASS] Book title CSS rules and font assets verified');

// 3. Verify Item 3: Double Click Toolbar Suppression
console.log('3. Verifying Double Click Toolbar Toggle Suppression in js/app.js...');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

// Check requestToggleReaderUI safeguards
assert.ok(appJs.includes('this._lastDoubleClickTime && (Date.now() - this._lastDoubleClickTime < 300)'), 'Double-click suppression check exists');
assert.ok(appJs.includes('this.dom.readerDictionaryCard && this.dom.readerDictionaryCard.style.display !== \'none\''), 'Active dictionary card suppression check exists');
assert.ok(appJs.includes('this.dom.selectionPopup && this.dom.selectionPopup.style.display !== \'none\''), 'Active selection popup suppression check exists');
assert.ok(appJs.includes('this.foliateView?.renderer?.getContents?.()'), 'Multi-section document selection check exists');

// Check isPointerDirectlyOnText disambiguates text clicks vs blank space clicks
assert.ok(appJs.includes('const isPointerDirectlyOnText = (e) =>'), 'isPointerDirectlyOnText helper exists');
assert.ok(appJs.includes('const onText = isPointerDirectlyOnText(e)'), 'onText disambiguation check exists in click handler');
assert.ok(appJs.includes('const toggleDelay = isTouch ? 60 : (onText ? 200 : 0)'), 'toggleDelay uses 0ms immediate toggle for desktop blank area');

import { pathToFileURL } from 'node:url';

// 4. Verify Item 2 bonus: URI decoding for book titles in js/book-title.js
console.log('4. Verifying URI decoding in js/book-title.js...');
const { resolveBookTitle, withReadableBookTitle } = await import(pathToFileURL(path.join(root, 'js/book-title.js')).href);
const decodedTitle = resolveBookTitle('Aeneis %E5%9F%83%E6%B6%85%E9%98%BF%E6%96%AF%E7%BA%AA');
assert.equal(decodedTitle, 'Aeneis 埃涅阿斯纪', 'Percent-encoded title should decode to readable text');
const normalTitle = resolveBookTitle('100% Cotton');
assert.equal(normalTitle, '100% Cotton', 'Titles with raw percent should survive intact');
console.log('  [PASS] Book title URL decoding verified');

console.log('  [PASS] Double-click and selection guards in app.js verified');

console.log('\n=== All Verification Checks Passed Successfully! ===');
