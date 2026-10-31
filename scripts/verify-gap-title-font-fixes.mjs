import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  [PASS] ${message}`);
    } else {
        console.error(`  [FAIL] ${message}`);
        failed++;
    }
}

console.log('====================================================');
console.log('Verifying Gap, Duplicate Title, & Noto Serif SC Font');
console.log('====================================================');

// Test 1: Cache-Buster in view.js
const viewJs = fs.readFileSync(path.join(projectRoot, 'foliate-js-main/view.js'), 'utf8');
assert(viewJs.includes("./paginator.js?v=20261029_rel_v2"), "1.1 view.js imports paginator.js with v=20261029_rel_v2");
assert(viewJs.includes("./fixed-layout.js?v=20261029_rel_v2"), "1.2 view.js imports fixed-layout.js with v=20261029_rel_v2");

// Test 2: setting-gap slider
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
assert(indexHtml.includes('id="setting-gap" class="control-input" min="2" max="25"'), "2.1 setting-gap slider max is 25%");

// Test 3: No duplicate "划线与笔记" title in shelf notes view
const shelfNotesViewSection = indexHtml.split('id="shelf-notes-view"')[1]?.split('<!-- /#shelf-notes-view -->')[0] || '';
assert(!shelfNotesViewSection.includes('<h2 class="shelf-notes-heading">划线与笔记</h2>'), "3.1 #shelf-notes-view does not contain duplicate h2 title");
assert(!shelfNotesViewSection.includes('class="shelf-notes-header-bar"'), "3.2 #shelf-notes-view omits redundant inner header bar");

// Test 4: Top shelf header has stats badge & export actions
assert(indexHtml.includes('id="shelf-notes-stats-badge"'), "4.1 index.html contains #shelf-notes-stats-badge in top header");
assert(indexHtml.includes('id="shelf-notes-header-actions"'), "4.2 index.html contains #shelf-notes-header-actions in top header");

// Test 5: Desktop CSS uses Noto Serif SC for .header-category-title
const desktopCss = fs.readFileSync(path.join(projectRoot, 'css/desktop-ui.css'), 'utf8');
assert(desktopCss.includes('font-family: "Noto Serif SC", var(--font-serif);'), "5.1 .header-category-title uses Noto Serif SC");
assert(desktopCss.includes('font-weight: 700;'), "5.2 .header-category-title uses 700 weight for literary prominence");

// Test 6: app.js handles notes header actions
const appJs = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');
assert(appJs.includes("notesHeaderActions.style.display = 'flex'"), "6.1 app.js displays #shelf-notes-header-actions on notes tab");
assert(appJs.includes("statsBadge.style.display = 'inline-flex'"), "6.2 app.js displays #shelf-notes-stats-badge on notes tab");
assert(appJs.includes("notesHeaderActions.style.display = 'none'"), "6.3 app.js hides #shelf-notes-header-actions on non-notes tab");
assert(appJs.includes("statsBadge.style.display = 'none'"), "6.4 app.js hides #shelf-notes-stats-badge on non-notes tab");

console.log('====================================================');
if (failed === 0) {
    console.log('All 12 verifications PASSED!');
    process.exit(0);
} else {
    console.error(`${failed} tests FAILED!`);
    process.exit(1);
}
