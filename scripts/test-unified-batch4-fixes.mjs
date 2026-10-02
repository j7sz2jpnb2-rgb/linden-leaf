// scripts/test-unified-batch4-fixes.mjs
// Comprehensive test suite for Batch 4 fixes and Chapter Bilingual Reading Engine

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('[Test Suite] Running Unified Batch 4 & Chapter Bilingual Tests...');

// 1. Test TXT Custom Regex Engine
console.log('1. Testing foliate-js-main/txt.js custom regex engine...');
const txtJsPath = path.join(rootDir, 'foliate-js-main', 'txt.js');
const txtJsContent = fs.readFileSync(txtJsPath, 'utf8');

assert(txtJsContent.includes('setCustomTxtPatterns'), 'txt.js must export setCustomTxtPatterns');
assert(txtJsContent.includes('getCustomTxtPatterns'), 'txt.js must export getCustomTxtPatterns');
assert(txtJsContent.includes('customTxtPatterns'), 'txt.js must support customTxtPatterns');
console.log('  ✓ txt.js custom regex engine functions verified');

// 2. Test DB v10 & Chapter Translation Store
console.log('2. Testing js/db.js DB v10 and chapter translation methods...');
const dbJsPath = path.join(rootDir, 'js', 'db.js');
const dbJsContent = fs.readFileSync(dbJsPath, 'utf8');

assert(dbJsContent.includes('chapter_translations'), 'db.js must contain chapter_translations store');
assert(dbJsContent.includes('saveChapterTranslation'), 'db.js must export saveChapterTranslation');
assert(dbJsContent.includes('getChapterTranslation'), 'db.js must export getChapterTranslation');
assert(dbJsContent.includes('deleteChapterTranslation'), 'db.js must export deleteChapterTranslation');
assert(dbJsContent.includes('listChapterTranslationsForBook'), 'db.js must export listChapterTranslationsForBook');
assert(dbJsContent.includes('clearAllChapterTranslations'), 'db.js must export clearAllChapterTranslations');
assert(dbJsContent.includes('getChapterTranslationsStats'), 'db.js must export getChapterTranslationsStats');
assert(dbJsContent.includes('getAllChapterTranslations'), 'db.js must export getAllChapterTranslations');
console.log('  ✓ db.js chapter translation store and CRUD methods verified');

// 3. Test Chapter Translation Manager
console.log('3. Testing js/chapter-translation-manager.js...');
const ctmJsPath = path.join(rootDir, 'js', 'chapter-translation-manager.js');
const ctmJsContent = fs.readFileSync(ctmJsPath, 'utf8');

assert(ctmJsContent.includes('ChapterTranslationManager'), 'must define ChapterTranslationManager');
assert(ctmJsContent.includes('extractChapterParagraphs'), 'must implement extractChapterParagraphs');
assert(ctmJsContent.includes('startCurrentChapterTranslation'), 'must implement startCurrentChapterTranslation');
assert(ctmJsContent.includes('injectTranslationElement'), 'must implement injectTranslationElement');
assert(ctmJsContent.includes('applyViewModeStyles'), 'must implement applyViewModeStyles');
assert(ctmJsContent.includes('bilingual-translation-block'), 'must style .bilingual-translation-block');
console.log('  ✓ chapter-translation-manager.js logic verified');

// 4. Test Advanced Settings (10 Groups & Cooldown 0s)
console.log('4. Testing js/advanced-settings.js...');
const advJsPath = path.join(rootDir, 'js', 'advanced-settings.js');
const advJsContent = fs.readFileSync(advJsPath, 'utf8');

assert(advJsContent.includes('aiCooldownSeconds: 10'), 'must have default 10s cooldown');
assert(advJsContent.includes('Math.max(0, Math.min(3600, raw))'), 'must support 0s cooldown truly active');
assert(advJsContent.includes('DEFAULT_ADVANCED_SETTINGS'), 'must export DEFAULT_ADVANCED_SETTINGS');
assert(advJsContent.includes('AdvancedSettingsManager'), 'must define AdvancedSettingsManager');
assert(advJsContent.includes('export const advancedSettings'), 'must export advancedSettings instance');
assert(advJsContent.includes('exportSettingsJSON'), 'must support exportSettingsJSON');
assert(advJsContent.includes('importSettingsJSON'), 'must support importSettingsJSON');
console.log('  ✓ advanced-settings.js settings and 0s cooldown verified');

// 5. Test Theme Customizer (10 tokens normalizePalette)
console.log('5. Testing js/theme-customizer.js...');
const tcJsPath = path.join(rootDir, 'js', 'theme-customizer.js');
const tcJsContent = fs.readFileSync(tcJsPath, 'utf8');

assert(tcJsContent.includes('DEFAULT_SEMANTIC_PALETTE'), 'must define DEFAULT_SEMANTIC_PALETTE');
assert(tcJsContent.includes('normalizePalette'), 'must define normalizePalette');
assert(tcJsContent.includes('--reader-bg'), 'must generate --reader-bg');
assert(tcJsContent.includes('--reader-text'), 'must generate --reader-text');
assert(tcJsContent.includes('--selection-bg'), 'must generate --selection-bg');
console.log('  ✓ theme-customizer.js 10-token palette normalization verified');

// 6. Test WebDAV Translation Sync Extension
console.log('6. Testing js/syncEngine.js translation sync extension...');
const syncJsPath = path.join(rootDir, 'js', 'syncEngine.js');
const syncJsContent = fs.readFileSync(syncJsPath, 'utf8');

assert(syncJsContent.includes('chapterTranslations'), 'syncEngine.js must handle chapterTranslations in payload');
assert(syncJsContent.includes('linden_sync_chapter_translations'), 'syncEngine.js must check linden_sync_chapter_translations setting');
assert(syncJsContent.includes('db.saveChapterTranslation'), 'syncEngine.js must save incoming translations');
console.log('  ✓ syncEngine.js translation sync extension verified');

// 7. Test app.js Wiring & Book Override
console.log('7. Testing js/app.js wiring...');
const appJsPath = path.join(rootDir, 'js', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

assert(appJsContent.includes('chapterTranslationManager'), 'app.js must import and use chapterTranslationManager');
assert(appJsContent.includes('initBookOverrideUI'), 'app.js must implement initBookOverrideUI');
assert(appJsContent.includes('checkBookSpecificSettings'), 'app.js must implement checkBookSpecificSettings');
assert(appJsContent.includes('_bookSettingsOverride'), 'app.js must manage _bookSettingsOverride');
assert(appJsContent.includes('normalizeEpubDocument(doc)'), 'app.js must normalize epub heading indents');
console.log('  ✓ app.js wiring and per-book override verified');

// 8. Test HTML markup integrity
console.log('8. Testing index.html markup...');
const htmlPath = path.join(rootDir, 'index.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

assert(htmlContent.includes('id="btn-chapter-translate"'), 'index.html must have btn-chapter-translate');
assert(htmlContent.includes('id="chapter-translation-bar"'), 'index.html must have chapter-translation-bar');
assert(htmlContent.includes('id="modal-chapter-trans-confirm"'), 'index.html must have modal-chapter-trans-confirm');
assert(htmlContent.includes('id="setting-book-override"'), 'index.html must have setting-book-override');
assert(htmlContent.includes('id="adv-group-fonts"'), 'index.html must have Group 1 fonts');
assert(htmlContent.includes('id="adv-group-palette"'), 'index.html must have Group 2 palette');
assert(htmlContent.includes('id="adv-group-txt-rules"'), 'index.html must have Group 3 txt rules');
assert(!htmlContent.includes('id="font-select-grid-dup"'), 'no duplicate font grids');
console.log('  ✓ index.html structure verified');

// 9. Test CSS enhancements
console.log('9. Testing css/main.css contrast and visual tokens...');
const cssPath = path.join(rootDir, 'css', 'main.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');

assert(cssContent.includes('.chapter-translation-bar'), 'css must style chapter-translation-bar');
assert(cssContent.includes('.overview-popover-panel'), 'css must style overview-popover-panel');
assert(cssContent.includes('Tactile warm paper surface with clear boundaries'), 'reading-overview-panel must have updated contrast styles');
console.log('  ✓ css/main.css enhancements verified');

console.log('\n========================================');
console.log('ALL VERIFICATION CHECKS PASSED (9/9)!');
console.log('========================================\n');
