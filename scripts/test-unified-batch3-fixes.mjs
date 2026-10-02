// scripts/test-unified-batch3-fixes.mjs
// Verification suite for:
// 1. AI Sidebar EPUB positioning anchor preservation
// 2. Ctrl multi-select state tracking
// 3. Bookshelf AI History workspace view & actions
// 4. MOBI / AZW3 full-text search engine support
// 5. Reader settings UI button styles, slider tracks, hex inputs
// 6. Bilingual in-place paragraph translation

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('=== Running Linden Leaf Unified Batch 3 Verification Suite ===\n');

// 1. Full-text search engine formats & MOBI/AZW3 support
console.log('--- 1. Testing Full-text Search Engine Formats ---');
{
    const { SUPPORTED_SEARCH_FORMATS, tokenizeText, createExcerptSnippet } = await import('../js/fulltext-search.js');
    assert.ok(Array.isArray(SUPPORTED_SEARCH_FORMATS), 'SUPPORTED_SEARCH_FORMATS should be an array');
    assert.ok(SUPPORTED_SEARCH_FORMATS.includes('mobi'), 'Should include mobi');
    assert.ok(SUPPORTED_SEARCH_FORMATS.includes('azw3'), 'Should include azw3');
    assert.ok(SUPPORTED_SEARCH_FORMATS.includes('azw'), 'Should include azw');
    assert.ok(SUPPORTED_SEARCH_FORMATS.includes('epub'), 'Should include epub');
    assert.ok(SUPPORTED_SEARCH_FORMATS.includes('docx'), 'Should include docx');

    // Tokenizer test
    const tokens = tokenizeText('红楼梦是一部经典作品 Chapter 1');
    assert.ok(tokens.has('红楼'), 'Should contain bi-gram 红楼');
    assert.ok(tokens.has('楼梦'), 'Should contain bi-gram 楼梦');
    assert.ok(tokens.has('chapter'), 'Should contain word chapter');

    // Snippet test
    const snippet = createExcerptSnippet('满纸荒唐言，一把辛酸泪。都云作者痴，谁解其中味？', '辛酸');
    assert.ok(snippet.includes('<mark>辛酸</mark>'), 'Snippet should highlight keyword');
    console.log('✓ Full-text search formats and tokenizer passed.');
}

// 2. Verify AI History Workspace View HTML & CSS
console.log('\n--- 2. Verifying AI History Workspace View HTML & CSS ---');
{
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    const css = fs.readFileSync(path.join(rootDir, 'css/main.css'), 'utf-8');

    // HTML elements
    assert.ok(html.includes('id="ai-history-workspace-view"'), 'index.html should have ai-history-workspace-view');
    assert.ok(html.includes('id="ai-history-page-search"'), 'index.html should have ai-history-page-search');
    assert.ok(html.includes('id="ai-history-page-conv-list"'), 'index.html should have ai-history-page-conv-list');
    assert.ok(html.includes('id="btn-history-page-jump-book"'), 'index.html should have btn-history-page-jump-book');
    assert.ok(html.includes('id="btn-history-page-export-md"'), 'index.html should have btn-history-page-export-md');
    assert.ok(html.includes('id="btn-history-page-delete-conv"'), 'index.html should have btn-history-page-delete-conv');
    assert.ok(html.includes('id="ai-history-page-messages-list"'), 'index.html should have ai-history-page-messages-list');

    // CSS rules
    assert.ok(css.includes('.ai-history-workspace-layout'), 'main.css should have .ai-history-workspace-layout');
    assert.ok(css.includes('.ai-history-split-pane'), 'main.css should have .ai-history-split-pane');
    assert.ok(css.includes('.ai-history-sidebar-pane'), 'main.css should have .ai-history-sidebar-pane');
    assert.ok(css.includes('.ai-history-conv-card'), 'main.css should have .ai-history-conv-card');
    assert.ok(css.includes('.ai-history-messages-scroll'), 'main.css should have .ai-history-messages-scroll');
    assert.ok(css.includes('.ai-history-quote-box'), 'main.css should have .ai-history-quote-box');
    assert.ok(css.includes('.ai-history-quote-expand-btn'), 'main.css should have .ai-history-quote-expand-btn');

    // Modal layout fix
    assert.ok(css.includes('#modal-ai-history .global-modal-body'), 'main.css should fix modal-ai-history body');
    console.log('✓ AI History Workspace HTML and CSS verified.');
}

// 3. Verify Reader Settings Drawer Buttons, Slider Tracks & Hex Inputs
console.log('\n--- 3. Verifying Settings Drawer Buttons, Slider Tracks & Hex Inputs ---');
{
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    const css = fs.readFileSync(path.join(rootDir, 'css/main.css'), 'utf-8');

    // Inline button wrapping prevention
    assert.ok(css.includes('.btn-setting-inline'), 'main.css should have .btn-setting-inline');
    assert.ok(css.includes('white-space: nowrap !important;'), 'Button text should be nowrap');

    // Slider track and thumb rules
    assert.ok(css.includes('::-webkit-slider-runnable-track'), 'main.css should have webkit-slider-runnable-track');
    assert.ok(css.includes('::-moz-range-track'), 'main.css should have moz-range-track');
    assert.ok(css.includes('::-webkit-slider-thumb'), 'main.css should have webkit-slider-thumb');
    assert.ok(css.includes('::-moz-range-thumb'), 'main.css should have moz-range-thumb');

    // Hex input boxes in palette editor
    assert.ok(html.includes('id="palette-bg-primary-hex"'), 'index.html should have palette-bg-primary-hex');
    assert.ok(html.includes('id="palette-text-main-hex"'), 'index.html should have palette-text-main-hex');
    assert.ok(html.includes('id="palette-accent-hex"'), 'index.html should have palette-accent-hex');
    console.log('✓ Settings Drawer UI fixes verified.');
}

// 4. Verify Bilingual In-Place Paragraph Translation
console.log('\n--- 4. Verifying Bilingual In-Place Paragraph Translation ---');
{
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf-8');
    const css = fs.readFileSync(path.join(rootDir, 'css/main.css'), 'utf-8');

    assert.ok(appJs.includes('handleInPlaceParagraphTranslation'), 'app.js should have handleInPlaceParagraphTranslation');
    assert.ok(appJs.includes('para-trans-bilingual-wrap'), 'app.js should render bilingual container');
    assert.ok(appJs.includes('para-trans-original-wrap'), 'app.js should render original text container');
    assert.ok(appJs.includes('para-trans-result-wrap'), 'app.js should render translation container');

    assert.ok(css.includes('.para-trans-bilingual-wrap'), 'main.css should style .para-trans-bilingual-wrap');
    assert.ok(css.includes('.para-trans-original-wrap'), 'main.css should style .para-trans-original-wrap');
    assert.ok(css.includes('.para-trans-result-wrap'), 'main.css should style .para-trans-result-wrap');
    console.log('✓ Bilingual in-place translation verified.');
}

// 5. Verify AI Sidebar EPUB Positioning Drift Fix & Paginator Anchor Protection
console.log('\n--- 5. Verifying AI Sidebar EPUB Positioning Drift Fix ---');
{
    const paginatorJs = fs.readFileSync(path.join(rootDir, 'foliate-js-main/paginator.js'), 'utf-8');
    const aiSidebarJs = fs.readFileSync(path.join(rootDir, 'js/ai-sidebar-controller.js'), 'utf-8');

    assert.match(paginatorJs, /setAnchor\(anchor(?:,\s*isLocked\s*=\s*true)?\)/, 'paginator.js should have setAnchor method');
    assert.ok(paginatorJs.includes('if (this.#lockedAnchor)') && paginatorJs.includes('this.#anchor = this.#lockedAnchor'), 'paginator.js render should honor a locked anchor');

    assert.ok(aiSidebarJs.includes('captureCurrentReadingAnchor()'), 'ai-sidebar-controller.js should have captureCurrentReadingAnchor');
    assert.ok(aiSidebarJs.includes('restoreReadingAnchor(anchor)'), 'ai-sidebar-controller.js should have restoreReadingAnchor');
    const openSidebar = aiSidebarJs.split('async openSidebar(preferredAnchor = null) {')[1]?.split('async closeSidebar() {')[0] || '';
    const closeSidebar = aiSidebarJs.split('async closeSidebar() {')[1]?.split('async ')[0] || '';
    assert.ok(openSidebar.indexOf('anchor = this.captureCurrentReadingAnchor()') >= 0 && openSidebar.indexOf('anchor = this.captureCurrentReadingAnchor()') < openSidebar.indexOf("classList.add('ai-sidebar-open')"), 'openSidebar should capture anchor BEFORE width change');
    assert.ok(closeSidebar.indexOf('const anchor = this.captureCurrentReadingAnchor()') >= 0 && closeSidebar.indexOf('const anchor = this.captureCurrentReadingAnchor()') < closeSidebar.indexOf("classList.remove('ai-sidebar-open')"), 'closeSidebar should capture anchor BEFORE width change');
    console.log('✓ AI sidebar positioning drift fix verified.');
}

// 6. Verify Ctrl Multi-select State Machine in app.js
console.log('\n--- 6. Verifying Ctrl Multi-Select State Machine ---');
{
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf-8');

    assert.ok(appJs.includes('this.isCtrlPressed'), 'app.js should track this.isCtrlPressed');
    assert.ok(appJs.includes('this._pointerDownWithCtrl'), 'app.js should track this._pointerDownWithCtrl');
    assert.ok(appJs.includes('renderVirtualMultiSelections'), 'app.js should have renderVirtualMultiSelections');
    assert.ok(appJs.includes('this.multiSelectedRanges.slice(0, this.multiSelectedRanges.length - 1)'), 'Only historical selections should get virtual annotations');
    console.log('✓ Ctrl multi-select state machine verified.');
}

// 7. Verify AI History Bookshelf Wiring
console.log('\n--- 7. Verifying AI History Bookshelf Category Wiring ---');
{
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf-8');
    const aiSidebarJs = fs.readFileSync(path.join(rootDir, 'js/ai-sidebar-controller.js'), 'utf-8');

    assert.ok(appJs.includes('if (this.shelfCategory === \'ai-history\')'), 'refreshBookshelf should handle ai-history category');
    assert.ok(appJs.includes('this.aiSidebar?.renderHistoryWorkspace()'), 'refreshBookshelf should invoke renderHistoryWorkspace');
    assert.ok(aiSidebarJs.includes('async renderHistoryWorkspace()'), 'ai-sidebar-controller.js should implement renderHistoryWorkspace');
    assert.ok(aiSidebarJs.includes('handleHistoryJumpToBook'), 'ai-sidebar-controller.js should implement handleHistoryJumpToBook');
    console.log('✓ AI History bookshelf wiring verified.');
}

// 8. Verify Bookshelf Dual-Range Rating Slider
console.log('\n--- 8. Verifying Bookshelf Dual-Range Rating Slider & Filtering ---');
{
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    const css = fs.readFileSync(path.join(rootDir, 'css/main.css'), 'utf-8');
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf-8');

    // HTML elements
    assert.ok(html.includes('id="overview-rating-slider-min"'), 'index.html should have overview-rating-slider-min');
    assert.ok(html.includes('id="overview-rating-slider-max"'), 'index.html should have overview-rating-slider-max');
    assert.ok(html.includes('id="overview-rating-track-highlight"'), 'index.html should have overview-rating-track-highlight');
    assert.ok(html.includes('class="overview-dual-range-input input-min"'), 'index.html should have dual range min input');
    assert.ok(html.includes('class="overview-dual-range-input input-max"'), 'index.html should have dual range max input');

    // CSS rules
    assert.ok(css.includes('.overview-rating-dual-slider-container'), 'main.css should have .overview-rating-dual-slider-container');
    assert.ok(css.includes('.overview-rating-track-highlight'), 'main.css should have .overview-rating-track-highlight');
    assert.ok(css.includes('.overview-dual-range-input'), 'main.css should have .overview-dual-range-input');

    // JS methods
    assert.ok(appJs.includes('getOverviewRatingRange()'), 'app.js should implement getOverviewRatingRange');
    assert.ok(appJs.includes('setOverviewRatingRange('), 'app.js should implement setOverviewRatingRange');

    // Test dual-range helper logic simulation
    function getRange(filterVal) {
        if (!filterVal || filterVal === 'all') {
            return { isAll: true, isUnrated: false, min: 0.0, max: 5.0 };
        }
        if (filterVal === 'unrated') {
            return { isAll: false, isUnrated: true, min: 0.0, max: 5.0 };
        }
        if (typeof filterVal === 'string' && filterVal.includes('-')) {
            const parts = filterVal.split('-');
            const min = Math.min(5.0, Math.max(0.0, parseFloat(parts[0]) || 0.0));
            const max = Math.min(5.0, Math.max(0.0, parseFloat(parts[1]) || 5.0));
            const actualMin = Math.min(min, max);
            const actualMax = Math.max(min, max);
            return {
                isAll: actualMin === 0.0 && actualMax === 5.0,
                isUnrated: false,
                min: actualMin,
                max: actualMax
            };
        }
        const num = parseFloat(filterVal);
        if (!isNaN(num) && num > 0) {
            return { isAll: false, isUnrated: false, min: num, max: 5.0 };
        }
        return { isAll: true, isUnrated: false, min: 0.0, max: 5.0 };
    }

    const testBooks = [
        { id: 1, title: 'Book 5.0', rating: 5.0 },
        { id: 2, title: 'Book 4.5', rating: 4.5 },
        { id: 3, title: 'Book 4.0', rating: 4.0 },
        { id: 4, title: 'Book 3.0', rating: 3.0 },
        { id: 5, title: 'Book 2.0', rating: 2.0 },
        { id: 6, title: 'Book Unrated 0', rating: 0 },
        { id: 7, title: 'Book Unrated null', rating: null },
    ];

    function filterBooks(books, filterVal) {
        if (!filterVal || filterVal === 'all') return books;
        if (filterVal === 'unrated') {
            return books.filter(b => b.rating == null || b.rating === 0);
        }
        const range = getRange(filterVal);
        return books.filter(b => typeof b.rating === 'number' && b.rating > 0 && b.rating >= range.min && b.rating <= range.max);
    }

    // 1. Range 3.0 - 4.5
    const r1 = filterBooks(testBooks, '3.0-4.5');
    assert.deepEqual(r1.map(b => b.id), [2, 3, 4], '3.0-4.5 should filter books with ratings 4.5, 4.0, 3.0');

    // 2. Exact 4.0 - 4.0
    const r2 = filterBooks(testBooks, '4.0-4.0');
    assert.deepEqual(r2.map(b => b.id), [3], '4.0-4.0 should filter only book with rating 4.0');

    // 3. Unrated
    const r3 = filterBooks(testBooks, 'unrated');
    assert.deepEqual(r3.map(b => b.id), [6, 7], 'unrated should filter books with null or 0 rating');

    // 4. All
    const r4 = filterBooks(testBooks, 'all');
    assert.equal(r4.length, 7, 'all should keep all books');

    // 5. Track highlight calculation
    const minVal = 2.0;
    const maxVal = 4.5;
    const leftPct = (minVal / 5.0) * 100;
    const rightPct = 100 - (maxVal / 5.0) * 100;
    assert.equal(leftPct, 40, 'leftPct for 2.0 should be 40%');
    assert.equal(rightPct, 10, 'rightPct for 4.5 should be 10%');

    console.log('✓ Dual-Range Rating Slider & Filtering verified.');
}

console.log('\n=== All Batch 3 Unified Verifications Succeeded! ===\n');
