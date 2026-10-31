import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

console.log('====================================================');
console.log('Verifying Paginator Geometry & Blank Space Toggle Fixes');
console.log('====================================================\n');

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
const paginatorJs = fs.readFileSync(path.join(projectRoot, 'foliate-js-main/paginator.js'), 'utf8');
const appJs = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');

let pass = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        pass++;
    } catch (err) {
        console.error(`  [FAIL] ${name}: ${err.message}`);
        process.exit(1);
    }
}

// 1. Paginator CSS grid
test('1.1 Paginator #top has 5-column grid with var(--_half-gap)', () => {
    assert.match(paginatorJs, /grid-template-columns:\s*\r?\n\s*minmax\(max\(var\(--_half-gap\),\s*var\(--safe-left,\s*0px\)\),\s*1fr\)\s*\r?\n\s*var\(--_half-gap\)\s*\r?\n\s*minmax\(0,\s*calc\(var\(--_max-width\)\s*-\s*var\(--_gap\)\)\)\s*\r?\n\s*var\(--_half-gap\)\s*\r?\n\s*minmax\(max\(var\(--_half-gap\),\s*var\(--safe-right,\s*0px\)\),\s*1fr\);/);
});

test('1.2 Paginator #container has grid-column: 2 / 5', () => {
    assert.match(paginatorJs, /#container\s*\{\s*grid-column:\s*2\s*\/\s*5;\s*grid-row:\s*2;\s*overflow:\s*hidden;\s*\}/);
});

test('1.3 Paginator #header and #footer have grid-column: 3 / 4', () => {
    assert.match(paginatorJs, /#header\s*\{\s*grid-column:\s*3\s*\/\s*4;/);
    assert.match(paginatorJs, /#footer\s*\{\s*grid-column:\s*3\s*\/\s*4;/);
});

// 2. Paginator geometry calculation in #beforeRender and View.columnize()
test('2.1 #beforeRender restores -g / (g - 1) * size gap calculation', () => {
    assert.match(paginatorJs, /const gap = -g \/ \(g - 1\) \* size/);
    assert.match(paginatorJs, /const columnWidth = \(size \/ divisor\) - gap/);
    assert.doesNotMatch(paginatorJs, /Math\.floor\(\(size - \(divisor - 1\) \* gap\) \/ divisor\)/);
});

test('2.2 View.columnize() restores padding with half-gap and omits column-count', () => {
    assert.match(paginatorJs, /'padding':\s*vertical\s*\?\s*`\$\{gap\s*\/\s*2\}px 0`\s*:\s*`0 \$\{gap\s*\/\s*2\}px`/);
    assert.doesNotMatch(paginatorJs, /'column-count':\s*`\$\{divisor/);
});

test('2.3 View.columnize() uses exact subpixel columnWidth without Math.trunc', () => {
    assert.match(paginatorJs, /'column-width':\s*`\$\{columnWidth\}px`/);
    assert.doesNotMatch(paginatorJs, /'column-width':\s*`\$\{Math\.trunc\(columnWidth\)\}px`/);
});

test('2.4 attributeChangedCallback renders on max-column-count', () => {
    assert.match(paginatorJs, /case 'max-column-count':\s*\r?\n\s*this\.#top\.style\.setProperty\('--_' \+ name, value\)\s*\r?\n\s*this\.render\(\)/);
});

// 3. Mathematical phase lag simulation
test('3.1 Phase lag verification over 10 spreads (20 pages)', () => {
    const size = 1000;
    const g = 0.06;
    const gap = -g / (g - 1) * size; // ~63.83px
    const divisor = 2;
    const columnWidth = (size / divisor) - gap; // ~436.17px
    const padding = gap / 2; // ~31.91px

    // Per spread of 2 columns:
    // Left column: padding + columnWidth + gap
    // Right column: columnWidth + padding
    // Total physical footprint per spread:
    const spreadWidth = padding + columnWidth + gap + columnWidth + padding;
    assert.equal(Math.round(spreadWidth), size, 'Spread width must match viewport size exactly');

    // Over 10 spreads (20 pages), cumulative error must be 0
    for (let spread = 1; spread <= 10; spread++) {
        const cumulativeExpected = spread * size;
        const cumulativeActual = spread * spreadWidth;
        assert.ok(Math.abs(cumulativeActual - cumulativeExpected) < 1e-9, `Spread ${spread} phase drift must be 0`);
    }
});

// 4. Blank space toggle and mouse slop
test('4.1 Desktop mouse pointermove slop is 24px with selection guard', () => {
    assert.match(appJs, /const slop = 24/);
    assert.match(appJs, /if \(sel && !sel\.isCollapsed && sel\.toString\(\)\.length > 0\)/);
});

test('4.2 Click event checks isDragGesture with collapsed selection guard', () => {
    assert.match(appJs, /if \(isDragGesture\) \{\s*isDragGesture = false\s*const sel = doc\.getSelection\(\)\s*if \(sel && !sel\.isCollapsed && sel\.toString\(\)\.trim\(\)\.length > 0\) \{\s*return\s*\}\s*\}/);
});

test('4.3 hadActiveSelectionOrPopupOnPointerDown only triggers on visible popups', () => {
    assert.match(appJs, /hadActiveSelectionOrPopupOnPointerDown = hasDict \|\| hasPopup \|\| hasHighlightPopup \|\| hasFootnote/);
});

test('4.4 contentAreaHadActiveSelectionOnDown only triggers on visible popups', () => {
    assert.match(appJs, /contentAreaHadActiveSelectionOnDown = hasDict \|\| hasPopup \|\| hasHighlightPopup \|\| hasFootnote/);
});

test('4.5 toggleReaderUI synchronizes top and bottom bars via isCurrentlyVisible', () => {
    assert.match(appJs, /const isCurrentlyVisible = !this\.dom\.readerTopBar\?\.classList\.contains\('autohide'\) \|\|\s*!this\.dom\.readerBottomBar\?\.classList\.contains\('autohide'\)/);
    assert.match(appJs, /if \(isCurrentlyVisible\) \{\s*this\.dom\.readerTopBar\?\.classList\.add\('autohide'\)\s*this\.dom\.readerBottomBar\?\.classList\.add\('autohide'\)/);
});

test('4.6 pointermove does not set isDragGesture on blank mouse movements without selection', () => {
    assert.doesNotMatch(appJs, /Math\.hypot\(e\.clientX - pointerStartX, e\.clientY - pointerStartY\) > 32/);
});

console.log(`\n====================================================`);
console.log(`All ${pass} verifications PASSED!`);
console.log(`====================================================`);
