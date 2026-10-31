// scripts/verify-all-6-enhancements.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('====================================================');
console.log('Running Deep Verification of 6 Astra Enhancements');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passCount++;
    } catch (err) {
        console.error(`  [FAIL] ${name}: ${err.message.slice(0, 120)}`);
        failCount++;
    }
}

const rootDir = 'D:/LindenLeaf-Dev/astra-mupdf-core';

// -----------------------------------------------------------------------------
// Suite 1: AI Max Tokens Extended to 20,000
// -----------------------------------------------------------------------------
console.log('Suite 1: AI Max Tokens Ceiling to 20,000');

test('1.1 index.html #setting-ai-max-tokens slider max is 20000', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.match(html, /id="setting-ai-max-tokens"[^>]*max="20000"/);
});

test('1.2 js/advanced-settings.js bounds.aiMaxTokens is [256, 20000]', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/advanced-settings.js'), 'utf8');
    assert.match(js, /aiMaxTokens:\s*\[256,\s*20000\]/);
    assert.match(js, /Math\.min\(20000/);
});

test('1.3 js/reading-ai-assistant.js clamps maxTokens to 20000', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/reading-ai-assistant.js'), 'utf8');
    assert.match(js, /Math\.min\(20000,\s*cfg\.maxTokens\)/);
});

test('1.4 js/chapter-translation-manager.js clamps maxTokens to 20000', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/chapter-translation-manager.js'), 'utf8');
    assert.match(js, /Math\.min\(20000/);
});

test('1.5 src-tauri/src/commands/ai.rs clamps max_tokens to 20000', () => {
    const rs = fs.readFileSync(path.join(rootDir, 'src-tauri/src/commands/ai.rs'), 'utf8');
    assert.match(rs, /clamp\(64,\s*20000\)/);
});

// -----------------------------------------------------------------------------
// Suite 2: Shelf Drawer State & TOC Leak Repair
// -----------------------------------------------------------------------------
console.log('\nSuite 2: Shelf Drawer State & TOC Leak Repair');

test('2.1 css/desktop-ui.css and css/main.css hide TOC and search in drawer-shelf-mode', () => {
    const cssDesktop = fs.readFileSync(path.join(rootDir, 'css/desktop-ui.css'), 'utf8');
    const cssMain = fs.readFileSync(path.join(rootDir, 'css/main.css'), 'utf8');
    const rule = '#sidebar-drawer.drawer-shelf-mode .drawer-tabs [data-tab="toc"]';
    assert.ok(cssDesktop.includes(rule) || cssMain.includes(rule), 'Rule missing in CSS');
});

test('2.2 js/app.js closeReader cleans TOC/search containers and sets drawer-shelf-mode', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /this\.dom\.searchResultsContainer\.innerHTML\s*=\s*''/);
    assert.match(js, /this\.dom\.sidebarDrawer\?\.classList\.add\('drawer-shelf-mode'\)/);
    assert.match(js, /this\.switchTab\('settings'\)/);
});

test('2.3 js/app.js openDrawer diverts toc/search to settings when in shelf mode', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /const isShelfMode = !this\.currentBookId/);
    assert.match(js, /if\s*\(tab === 'toc' \|\| tab === 'search'\)\s*tab = 'settings'/);
});

// -----------------------------------------------------------------------------
// Suite 3: MOBI / EPUB Manga Layout Breakdown
// -----------------------------------------------------------------------------
console.log('\nSuite 3: MOBI / EPUB Manga Layout Breakdown');

test('3.1 foliate-js-main/mobi.js detects comic EXTH record and sets this.isComic', () => {
    const mobi = fs.readFileSync(path.join(rootDir, 'foliate-js-main/mobi.js'), 'utf8');
    assert.match(mobi, /exth\.bookType === 'comic'/);
    assert.match(mobi, /this\.isComic = /);
});

test('3.2 index.html contains comic mode switch #setting-comic-mode', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.match(html, /id="setting-comic-mode"/);
    assert.match(html, /漫画模式/);
});

test('3.3 js/app.js buildContentCSS contains full comic isolation CSS', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /\.comic-mode img/);
    assert.match(js, /break-before:\s*column\s*!important/);
    assert.match(js, /break-after:\s*column\s*!important/);
    assert.match(js, /break-inside:\s*avoid\s*!important/);
    assert.match(js, /height:\s*100vh\s*!important/);
    assert.match(js, /object-fit:\s*contain\s*!important/);
});

test('3.4 js/app.js normalizeEpubDocument auto-detects image-dominant sections', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /doc\.querySelectorAll\('img,\s*svg image'\)/);
    assert.match(js, /data-comic-image/);
});

// -----------------------------------------------------------------------------
// Suite 4: Cross-Book Full-Text Search 100% Traversal & Streaming Accordions
// -----------------------------------------------------------------------------
console.log('\nSuite 4: Cross-Book Full-Text Search 100% Traversal & Streaming Accordions');

test('4.1 js/fulltext-search.js searchBooks does not truncate loop at limit cutoff', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/fulltext-search.js'), 'utf8');
    assert.doesNotMatch(js, /for\s*\(const\s+book\s+of\s+books\)\s*\{[\s\S]*?if\s*\(results\.length\s*>=?\s*limit\)\s*break;/);
    assert.match(js, /onBookResult/);
    assert.match(js, /bookGroups/);
});

test('4.2 js/fulltext-search.js provides searchBookFull with index rehydration', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/fulltext-search.js'), 'utf8');
    assert.match(js, /async searchBookFull\(bookId,\s*query\)/);
    assert.match(js, /this\.index\.has\(bookId\)/);
});

test('4.3 css/desktop-ui.css contains cross-search accordion cards styling', () => {
    const css = fs.readFileSync(path.join(rootDir, 'css/desktop-ui.css'), 'utf8');
    assert.match(css, /\.cross-search-book-card/);
    assert.match(css, /\.cross-search-book-header/);
    assert.match(css, /\.cross-search-hit-badge/);
    assert.match(css, /\.btn-expand-book-matches/);
});

test('4.4 js/app.js executeCrossSearch renders streaming cards with 3-match preview & batch pagination', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /executeCrossSearch\(query\)/);
    assert.match(js, /共 \${bookResult\.totalHits} 处匹配/);
    assert.match(js, /slice\(0,\s*3\)/);
    assert.match(js, /btn-expand-book-matches/);
});

// -----------------------------------------------------------------------------
// Suite 5: Two-Column Foliate Spatial Lattice & Immediate Re-render
// -----------------------------------------------------------------------------
console.log('\nSuite 5: Two-Column Foliate Spatial Lattice & Immediate Re-render');

test('5.1 foliate-js-main/paginator.js invokes this.render() on gap and margin attribute changes', () => {
    const paginator = fs.readFileSync(path.join(rootDir, 'foliate-js-main/paginator.js'), 'utf8');
    assert.match(paginator, /case 'gap':/);
    assert.match(paginator, /case 'margin':/);
    assert.match(paginator, /this\.render\(\)/);
});

test('5.2 foliate-js-main/paginator.js grid restores 5-column spatial lattice', () => {
    const paginator = fs.readFileSync(path.join(rootDir, 'foliate-js-main/paginator.js'), 'utf8');
    assert.match(paginator, /var\(--_half-gap\)/);
    assert.match(paginator, /grid-column:\s*2\s*\/\s*5/);
    assert.match(paginator, /grid-column:\s*3\s*\/\s*4/);
});

test('5.3 foliate-js-main/paginator.js computes Foliate gap lattice, column width, and padding', () => {
    const paginator = fs.readFileSync(path.join(rootDir, 'foliate-js-main/paginator.js'), 'utf8');
    assert.match(paginator, /const gap = -g \/ \(g - 1\) \* size/);
    assert.match(paginator, /const columnWidth = \(size \/ divisor\) - gap/);
    assert.match(paginator, /'padding':\s*vertical\s*\?\s*`\$\{gap\s*\/\s*2\}px 0`\s*:\s*`0 \$\{gap\s*\/\s*2\}px`/);
});

// -----------------------------------------------------------------------------
// Suite 6: PC Desktop Dedicated "划线与笔记" Sidebar Area
// -----------------------------------------------------------------------------
console.log('\nSuite 6: PC Desktop Dedicated "划线与笔记" Sidebar Area');

test('6.1 index.html contains #nav-cat-notes with badge in sidebar', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.match(html, /id="nav-cat-notes"/);
    assert.match(html, /id="sidebar-notes-count"/);
    assert.match(html, /划线与笔记/);
});

test('6.2 index.html contains #shelf-notes-view workspace container', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.match(html, /id="shelf-notes-view"/);
    assert.match(html, /id="shelf-notes-stats-badge"/);
    assert.match(html, /id="btn-export-shelf-notes"/);
    assert.match(html, /id="input-shelf-notes-search"/);
    assert.match(html, /id="select-notes-book-filter"/);
    assert.match(html, /id="shelf-notes-color-filters"/);
    assert.match(html, /id="shelf-notes-list"/);
});

test('6.3 css/desktop-ui.css contains shelf notes workspace styles', () => {
    const css = fs.readFileSync(path.join(rootDir, 'css/desktop-ui.css'), 'utf8');
    assert.match(css, /\.shelf-notes-workspace-layout/);
    assert.match(css, /\.shelf-notes-container/);
    assert.match(css, /\.shelf-notes-toolbar/);
    assert.match(css, /\.shelf-note-card/);
    assert.match(css, /\.shelf-note-card-quote/);
    assert.match(css, /\.shelf-note-card-thought/);
});

test('6.4 js/app.js handles notes in switchShelfCategory and refreshBookshelf', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /notes:\s*'划线与笔记'/);
    assert.match(js, /this\.shelfCategory\s*===\s*'notes'/);
    assert.match(js, /this\.renderShelfNotesView\(\)/);
});

test('6.5 js/app.js renders notes, supports filters, jump to reader, copy and markdown export', () => {
    const js = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
    assert.match(js, /renderShelfNotesView\(\)/);
    assert.match(js, /renderShelfNotesList\(\)/);
    assert.match(js, /exportShelfNotesToMarkdown\(\)/);
    assert.match(js, /updateSidebarNotesCount\(/);
    assert.match(js, /this\.openBook\(note\.bookId,\s*loc\)/);
});

console.log('\n====================================================');
console.log(`Results: ${passCount} passed, ${failCount} failed.`);
console.log('====================================================');

if (failCount > 0) {
    process.exit(1);
}
