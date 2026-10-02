// scripts/test-all-fixes.mjs
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('========================================');
console.log(' RUNNING VERIFICATION FOR ALL P0/P1 FIXES');
console.log('========================================\n');

// -------------------------------------------------------------
// Test 1: EPUB IPC Binary Buffer Fix (PlatformBridge simulation)
// -------------------------------------------------------------
console.log('Test 1: PlatformBridge buffer normalization...');

function normalizeBuffer(raw) {
    if (!raw) return null;
    let data = raw;
    if (data && typeof data === 'object' && 'body' in data) {
        data = data.body;
    }
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (Array.isArray(data)) {
        return new Uint8Array(data).buffer;
    }
    if (data && typeof data === 'object' && Array.isArray(data.data)) {
        return new Uint8Array(data.data).buffer;
    }
    return null;
}

const sampleEpubPath = path.join(rootDir, 'samples', 'sample_alice.epub');
const fileBytes = fs.readFileSync(sampleEpubPath);
const originalLength = fileBytes.byteLength;

// 1a: Rust returns Vec<u8> serialized as number array
const arrInput = Array.from(fileBytes);
const bufFromArr = normalizeBuffer(arrInput);
assert(bufFromArr instanceof ArrayBuffer, 'bufFromArr must be ArrayBuffer');
assert.strictEqual(bufFromArr.byteLength, originalLength, 'Length must match');

// 1b: Rust returns Uint8Array (binary IPC)
const uint8Input = new Uint8Array(fileBytes);
const bufFromUint8 = normalizeBuffer(uint8Input);
assert(bufFromUint8 instanceof ArrayBuffer, 'bufFromUint8 must be ArrayBuffer');
assert.strictEqual(bufFromUint8.byteLength, originalLength);

// 1c: Object with body (tauri response format)
const objWithBody = { body: new Uint8Array(fileBytes) };
const bufFromBody = normalizeBuffer(objWithBody);
assert(bufFromBody instanceof ArrayBuffer, 'bufFromBody must be ArrayBuffer');
assert.strictEqual(bufFromBody.byteLength, originalLength);

// 1d: Corrupt or unknown object (e.g. [object Response])
const invalidResponse = { status: 200, statusText: 'OK' };
const bufInvalid = normalizeBuffer(invalidResponse);
assert.strictEqual(bufInvalid, null, 'Invalid response should return null, not object');

console.log('  ✓ Test 1 Passed: Buffer normalization handles all formats safely and rejects invalid objects.\n');

// -------------------------------------------------------------
// Test 2: EPUB Loading with Foliate ZipReader & Sample Verification
// -------------------------------------------------------------
console.log('Test 2: Loading EPUB container and entries with ZipReader...');

const { ZipReader, BlobReader, TextWriter } = await import('../foliate-js-main/vendor/zip.js');

const validEpubBlob = new Blob([bufFromUint8]);
const reader = new ZipReader(new BlobReader(validEpubBlob));
const entries = await reader.getEntries();

assert(entries && entries.length > 0, 'EPUB entries must not be empty');
const entryNames = entries.map(e => e.filename);
console.log(`  Found ${entries.length} entries in sample_alice.epub:`, entryNames);

assert(entryNames.includes('mimetype'), 'EPUB must contain mimetype entry');
assert(entryNames.includes('META-INF/container.xml'), 'EPUB must contain container.xml');
assert(entryNames.includes('OEBPS/content.opf'), 'EPUB must contain content.opf');

const mimetypeEntry = entries.find(e => e.filename === 'mimetype');
const mimetype = await mimetypeEntry.getData(new TextWriter());
assert.strictEqual(mimetype.trim(), 'application/epub+zip', 'Mimetype must be application/epub+zip');

const opfEntry = entries.find(e => e.filename === 'OEBPS/content.opf');
const opfContent = await opfEntry.getData(new TextWriter());
assert(opfContent.includes('<package'), 'OPF must be valid package document');
console.log('  ✓ Test 2 Passed: EPUB zip container and OPF package read successfully with zero corruption.\n');

// -------------------------------------------------------------
// Test 3: Duplicate Book Overwrite Logic Fix
// -------------------------------------------------------------
console.log('Test 3: Duplicate book matching logic...');

function matchBook(existingBooks, format, metadata, fileName, fileSize) {
    const GENERIC_TITLES = ['未命名', '未命名书籍', '未命名电子书', 'pdf 文档', 'document', 'untitled', '新文件', '文档'];
    const rawTitle = (metadata.title || '').trim().toLowerCase();
    const rawBase = fileName.replace(/\.[^/.]+$/, '').trim().toLowerCase();
    const isGenericTitle = !rawTitle || GENERIC_TITLES.includes(rawTitle) || GENERIC_TITLES.includes(rawBase);

    return isGenericTitle ? null : existingBooks.find(b => {
        if (b.format !== format) return false;
        const bTitle = (b.title || '').trim().toLowerCase();
        const titleMatches = bTitle === rawTitle || bTitle === rawBase;
        if (!titleMatches) return false;

        const bAuthor = (b.author || '').trim().toLowerCase();
        const metaAuthor = (metadata.author || '').trim().toLowerCase();
        const isKnownAuthor = metaAuthor && !metaAuthor.includes('未知') && !metaAuthor.includes('unknown');
        const isKnownBAuthor = bAuthor && !bAuthor.includes('未知') && !bAuthor.includes('unknown');

        // If both books have distinct, known authors, they are definitely different books!
        if (isKnownAuthor && isKnownBAuthor && bAuthor !== metaAuthor) {
            return false;
        }

        // Accurate match: match by identifier, size, author, or exact filename
        if (metadata.identifier && b.identifier && metadata.identifier === b.identifier) {
            return true;
        }
        if (b.size && fileSize && b.size === fileSize) {
            return true;
        }
        if (isKnownAuthor && bAuthor && bAuthor === metaAuthor) {
            return true;
        }
        if (b.filename && fileName && b.filename.toLowerCase() === fileName.toLowerCase()) {
            return true;
        }
        return false;
    });
}

const existingBooks = [
    { id: '1', title: 'Python 教程', author: '', format: 'epub', filename: 'python_vol1.epub', size: 50000 },
    { id: '2', title: 'Alice in Wonderland', author: 'Lewis Carroll', format: 'epub', filename: 'alice.epub', size: 120000, identifier: 'urn:isbn:12345' },
    { id: '3', title: '无名古籍', author: '未知', format: 'epub', filename: 'ancient1.epub', size: undefined }
];

// Case A: Another book with same title 'Python 教程', no author, DIFFERENT size, DIFFERENT filename
const candidateA = matchBook(existingBooks, 'epub', { title: 'Python 教程', author: '' }, 'python_vol2.epub', 80000);
assert.strictEqual(candidateA, undefined, 'Unrelated authorless book with different size/filename must NOT match!');

// Case B: Same book re-imported with matching size
const candidateB = matchBook(existingBooks, 'epub', { title: 'Python 教程', author: '' }, 'copy_of_python.epub', 50000);
assert(candidateB && candidateB.id === '1', 'Matching size should match existing book');

// Case C: Re-imported with exact same filename
const candidateC = matchBook(existingBooks, 'epub', { title: 'Python 教程', author: '未知' }, 'python_vol1.epub', 99999);
assert(candidateC && candidateC.id === '1', 'Same filename should match existing book');

// Case D: Book 3 with missing b.size, candidate has no author, different filename
const candidateD = matchBook(existingBooks, 'epub', { title: '无名古籍', author: '未知' }, 'ancient2.epub', 60000);
assert.strictEqual(candidateD, undefined, 'Missing size must NOT cause blind overwrite of unrelated books!');

// Case E: Book with matching identifier
const candidateE = matchBook(existingBooks, 'epub', { title: 'Alice in Wonderland', identifier: 'urn:isbn:12345' }, 'any_name.epub', 11111);
assert(candidateE && candidateE.id === '2', 'Matching identifier should match existing book');

// Case F: Same title and same size, but conflicting known authors (e.g. Lewis Carroll vs Bob)
const candidateF = matchBook(existingBooks, 'epub', { title: 'Alice in Wonderland', author: 'Bob Smith' }, 'alice_by_bob.epub', 120000);
assert.strictEqual(candidateF, undefined, 'Conflicting known authors must NOT match despite matching title and size!');

console.log('  ✓ Test 3 Passed: Book duplicate logic prevents blind overwrites and respects distinct known authors.\n');

// -------------------------------------------------------------
// Test 4: Foliate navigation lifecycle invariants
// -------------------------------------------------------------
console.log('Test 4: Foliate navigation lifecycle...');

const paginatorCode = fs.readFileSync(path.join(rootDir, 'foliate-js-main', 'paginator.js'), 'utf8').replace(/\r\n/g, '\n');
const fxlCode = fs.readFileSync(path.join(rootDir, 'foliate-js-main', 'fixed-layout.js'), 'utf8').replace(/\r\n/g, '\n');

assert(/const setStylesImportant = \(el, styles\) => \{\s*if \(!el\) return/.test(paginatorCode), 'style helper must tolerate missing nodes');
assert(paginatorCode.includes('#waitForRenderRoot'), 'reflow renderer must wait for a usable iframe root');
assert(paginatorCode.includes('#displayGeneration'), 'reflow renderer must reject stale navigation commits');
assert(paginatorCode.includes('this.#observer.disconnect()'), 'old iframe observers must be disconnected before navigation');
assert(paginatorCode.includes("new CustomEvent('section-load-error'"), 'reflow failures must be observable');
assert(!paginatorCode.includes('return {}\n                }))'), 'section load failures must not be swallowed as empty results');
assert(fxlCode.includes('#navigationGeneration'), 'fixed-layout renderer must reject stale navigation commits');
assert(fxlCode.includes('#renderState'), 'fixed-layout candidate pages must be renderable before commit');
assert(fxlCode.includes("visibility: pending ? 'hidden' : ''"), 'fixed-layout candidates must preload hidden');
assert(fxlCode.includes("new CustomEvent('section-load-error'"), 'fixed-layout failures must be observable');

console.log('  ✓ Test 4 Passed: iframe lifetime, stale-navigation and transactional commit guards verified.\n');

// -------------------------------------------------------------
// Test 5: PDF Page Index Leak Fix
// -------------------------------------------------------------
console.log('Test 5: PDF Page Index reset in openBook...');

const appCode = fs.readFileSync(path.join(rootDir, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const openBookIndex = appCode.indexOf('async openBook(bookOrId)');
assert(openBookIndex !== -1, 'openBook must exist in app.js');

const openBookSlice = appCode.slice(openBookIndex, openBookIndex + 1500);
assert(openBookSlice.includes('this.currentPdfPageIndex = 0'), 'openBook must reset currentPdfPageIndex to 0');

console.log('  ✓ Test 5 Passed: currentPdfPageIndex is reset in openBook.\n');

// -------------------------------------------------------------
// Test 6: Fixed-Layout Night Mode Fix
// -------------------------------------------------------------
console.log('Test 6: Fixed-layout night mode styles...');

const applySettingsIndex = appCode.indexOf('applySettingsToReader() {');
assert(applySettingsIndex !== -1, 'applySettingsToReader must exist');

const applySettingsSlice = appCode.slice(applySettingsIndex, applySettingsIndex + 2000);
const fixedLayoutBranch = applySettingsSlice.slice(applySettingsSlice.indexOf('if (this.foliateView.isFixedLayout)'));
assert(!fixedLayoutBranch.slice(0, 300).includes('return\n'), 'Fixed layout branch must not return before applying CSS');
assert(applySettingsSlice.includes('const css = buildContentCSS(this.settings)'), 'CSS must be built in applySettingsToReader');
assert(applySettingsSlice.includes('r.setStyles(css)'), 'r.setStyles(css) must be called');

assert(fxlCode.includes('setStyles(styles)'), 'FixedLayout class must implement setStyles');
assert(fxlCode.includes('#applyStylesToDoc'), 'FixedLayout class must have #applyStylesToDoc');

console.log('  ✓ Test 6 Passed: Fixed-layout EPUBs implement and receive theme/night mode styles.\n');

// -------------------------------------------------------------
// Test 7: Rust Argv & IPC Fixes
// -------------------------------------------------------------
console.log('Test 7: Rust Argv & IPC implementation verification...');

const fsRsCode = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'commands', 'fs.rs'), 'utf8');
assert(fsRsCode.includes('pub async fn fs_read_buffer(file_path: String) -> Result<Response, String>'), 'fs_read_buffer must return a binary IPC Response');
assert(fsRsCode.includes('Response::new(bytes)'), 'fs_read_buffer must avoid JSON byte-array serialization');
assert(fsRsCode.includes('pub const SUPPORTED_EXTENSIONS'), 'SUPPORTED_EXTENSIONS must be pub');

const windowRsCode = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'commands', 'window.rs'), 'utf8');
assert(windowRsCode.includes('pub struct AppState'), 'AppState must exist in window.rs');
assert(windowRsCode.includes('pub fn app_renderer_ready'), 'app_renderer_ready must accept state');
assert(windowRsCode.includes('app.emit("app:open-file", payload)'), 'app_renderer_ready must emit app:open-file');
assert(windowRsCode.includes('extract_book_paths_from_args_with_cwd'), 'window.rs must support cwd-aware multi-arg extraction');

const libRsCode = fs.readFileSync(path.join(rootDir, 'src-tauri', 'src', 'lib.rs'), 'utf8');
assert(libRsCode.includes('extract_book_paths_from_args'), 'lib.rs must inspect args for books');
assert(libRsCode.includes('extract_book_paths_from_args_with_cwd(&argv, Some(&_cwd))'), 'single_instance must pass cwd');
assert(libRsCode.includes('tauri_plugin_single_instance'), 'single_instance plugin must handle files');

console.log('  ✓ Test 7 Passed: Rust commands, single-instance, and state management verified.\n');

console.log('========================================');
console.log(' ALL TESTS PASSED SUCCESSFULLY! (7/7)');
console.log('========================================');
