import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
let allPassed = true;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
  } else {
    console.error(`[FAIL] ${message}`);
    allPassed = false;
  }
}

// 1. Verify index.html
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
assert(
  indexHtml.includes('<option value="cover">仿真覆盖</option>') &&
  indexHtml.includes('<option value="curl">仿真纸张卷曲</option>'),
  'index.html contains cover and curl page turn options'
);

const noteIdx = indexHtml.indexOf('id="popup-note"');
const underIdx = indexHtml.indexOf('id="popup-underline"');
const copyIdx = indexHtml.indexOf('id="popup-copy"');
assert(
  noteIdx > underIdx && noteIdx < copyIdx,
  'index.html has popup-note right after popup-underline (before copy & dict)'
);

// 2. Verify css/mobile-preferences.css
const prefCss = fs.readFileSync(path.join(projectRoot, 'css/mobile-preferences.css'), 'utf8');
assert(
  prefCss.includes('#mobile-settings-page .control-row.settings-row-stacked') &&
  prefCss.includes('flex-direction: column !important;'),
  'css/mobile-preferences.css stops AI settings stacked slider from collapsing label'
);

// 3. Verify css/mobile-shell.css
const shellCss = fs.readFileSync(path.join(projectRoot, 'css/mobile-shell.css'), 'utf8');
assert(
  shellCss.includes('max-width: calc(100vw - 20px) !important') &&
  shellCss.includes('overflow-x: auto !important'),
  'css/mobile-shell.css styles selection popup responsively with overflow-x auto'
);
assert(
  shellCss.includes('#mobile-me-view .mobile-header-title') &&
  shellCss.includes('font-family: var(--mobile-font-editorial) !important'),
  'css/mobile-shell.css gives "Me" view literary editorial typography matching other tabs'
);
assert(
  shellCss.includes('.mobile-option-pill') &&
  shellCss.includes('.mobile-sheet-link-btn'),
  'css/mobile-shell.css includes quick option pills and link button styles'
);

// 4. Verify js/mobile-shell.js
const mobileShellJs = fs.readFileSync(path.join(projectRoot, 'js/mobile-shell.js'), 'utf8');
assert(
  !mobileShellJs.includes('id="btn-home-refresh"'),
  'js/mobile-shell.js removed redundant btn-home-refresh'
);
assert(
  mobileShellJs.includes('id="mobile-font-family-row"') &&
  mobileShellJs.includes('id="mobile-page-turn-row"') &&
  mobileShellJs.includes('id="btn-mobile-more-reading-settings"'),
  'js/mobile-shell.js has font, page turn, and more reading settings options in display sheet'
);
assert(
  mobileShellJs.includes('Quick Font Selection (Feedback 3 & 150)') &&
  mobileShellJs.includes('Quick Page Turn Animation Selection (Feedback 3, 5 & 152)'),
  'js/mobile-shell.js wires up quick font and turn animation selection listeners'
);

// 5. Verify js/app.js
const appJs = fs.readFileSync(path.join(projectRoot, 'js/app.js'), 'utf8');
assert(
  appJs.includes('popup.scrollLeft = 0') &&
  appJs.includes('Math.min(window.innerWidth - popupWidth - sideMargin, left)'),
  'js/app.js clamps selection popup within screen edges and resets scrollLeft'
);

// 6. Verify js/book-details.js
const bookDetailsJs = fs.readFileSync(path.join(projectRoot, 'js/book-details.js'), 'utf8');
assert(
  bookDetailsJs.includes('id="btn-details-change-cover"') &&
  bookDetailsJs.includes('id="input-details-custom-cover"'),
  'js/book-details.js replaces regen cover with change cover and file input'
);
assert(
  bookDetailsJs.includes('coverBlob: file') &&
  bookDetailsJs.includes('db.saveBook'),
  'js/book-details.js saves custom cover image blob to IndexedDB via db.saveBook'
);

if (allPassed) {
  console.log('\n>>> ALL 7 FEEDBACK VERIFICATION CHECKS PASSED PERFECTLY! <<<');
  process.exit(0);
} else {
  console.error('\n>>> SOME CHECKS FAILED! <<<');
  process.exit(1);
}
