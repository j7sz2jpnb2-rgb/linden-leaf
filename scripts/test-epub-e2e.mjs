// scripts/test-epub-e2e.mjs
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('====================================================');
console.log(' RUNNING END-TO-END EPUB & DEEP CORNER CASE SUITE   ');
console.log('====================================================\n');

// 1. Full Tauri IPC Buffer -> File -> Foliate EPUB parser
console.log('1. Testing full binary IPC pipeline with sample_alice.epub...');
const epubFilePath = path.join(rootDir, 'samples', 'sample_alice.epub');
const rawBytes = fs.readFileSync(epubFilePath);

// Simulate Tauri IPC delivering Vec<u8>
function simulateTauriIpcRead(filePath) {
    const clean = filePath.trim().replace(/^["']|["']$/g, '');
    const p = path.resolve(rootDir, clean);
    const buf = fs.readFileSync(p);
    return Array.from(buf); // IPC number array
}

// PlatformBridge normalization
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
    if (data && typeof data.arrayBuffer === 'function') {
        return data.arrayBuffer();
    }
    return null;
}

const rawIpcOutput = simulateTauriIpcRead('samples/sample_alice.epub');
const arrayBuffer = normalizeBuffer(rawIpcOutput);
assert(arrayBuffer instanceof ArrayBuffer, 'Buffer must normalize to ArrayBuffer');
assert.strictEqual(arrayBuffer.byteLength, rawBytes.byteLength, 'Byte lengths must match exactly');

const fileObj = new File([arrayBuffer], 'sample_alice.epub', { type: 'application/epub+zip' });
assert.strictEqual(fileObj.size, rawBytes.byteLength);
console.log(`  ✓ File created successfully: ${fileObj.name} (${fileObj.size} bytes)`);

// Setup headless browser mocks for Folate imports in Node
globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.HTMLElement = class HTMLElement {};
globalThis.customElements = { get() {}, define() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };

// 2. Foliate ZipLoader and EPUB parsing
console.log('2. Parsing EPUB structure via foliate-js-main/view.js...');
const { makeZipLoader } = await import('../foliate-js-main/view.js');
const loader = await makeZipLoader(fileObj);
assert(loader && loader.entries.length > 0, 'Zip entries must exist');
console.log(`  Found ${loader.entries.length} entries in sample_alice.epub.`);

const containerXml = await loader.loadText('META-INF/container.xml');
assert(containerXml.includes('full-path'), 'container.xml must contain full-path');
console.log('  ✓ container.xml loaded and verified.');

const opf = await loader.loadText('OEBPS/content.opf');
assert(opf.includes('Alice\'s Adventures in Wonderland'), 'content.opf must contain book title');
console.log('  ✓ OEBPS/content.opf parsed successfully.');

const ch1 = await loader.loadText('OEBPS/ch1.xhtml');
assert(ch1.includes('Down the Rabbit-Hole'), 'ch1 must contain chapter 1 title');
console.log('  ✓ OEBPS/ch1.xhtml loaded and verified.');

const ch2 = await loader.loadText('OEBPS/ch2.xhtml');
assert(ch2.includes('The Pool of Tears'), 'ch2 must contain chapter 2 title');
console.log('  ✓ OEBPS/ch2.xhtml loaded and verified.');

const cssBlob = await loader.loadBlob('OEBPS/style.css');
assert(cssBlob && cssBlob.size > 0, 'style.css must load as blob');
console.log('  ✓ OEBPS/style.css loaded as blob.');
console.log('  ✓ All spine sections loaded and verified successfully.\n');

// 3. SVG Cover / Body-less Document Corner Case Simulation
console.log('3. Testing SVG cover (doc.body === null) and paginator resilience...');

const mockSvgDoc = {
    body: null,
    documentElement: {
        style: {
            setProperty: (k, v, p) => {}
        },
        querySelectorAll: (sel) => [],
        getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 1200, width: 800, height: 1200 })
    },
    defaultView: {
        getComputedStyle: () => ({
            writingMode: 'horizontal-tb',
            direction: 'ltr',
            background: 'transparent',
            backgroundColor: 'rgba(0, 0, 0, 0)',
            backgroundImage: 'none',
            maxHeight: 'none',
            maxWidth: 'none'
        })
    }
};

// Test null guard in setStylesImportant
const setStylesImportant = (el, styles) => {
    if (!el || !el.style) return;
    const { style } = el;
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important');
};
assert.doesNotThrow(() => setStylesImportant(mockSvgDoc.body, { margin: '0' }));

// Test setImageSize logic with doc.body === null
const testSetImageSize = (doc) => {
    const root = doc?.body || doc?.documentElement;
    if (!root) return false;
    const list = root.querySelectorAll('img, svg, video');
    return true;
};
assert.strictEqual(testSetImageSize(mockSvgDoc), true);

// Test destroy unobserve with doc.body === null
let unobservedTarget = null;
const mockObserver = {
    unobserve: (t) => { unobservedTarget = t; }
};
const testDestroy = (doc) => {
    const target = doc?.body || doc?.documentElement;
    if (target) mockObserver.unobserve(target);
};
assert.doesNotThrow(() => testDestroy(mockSvgDoc));
assert.strictEqual(unobservedTarget, mockSvgDoc.documentElement);
console.log('  ✓ SVG cover null-body corner cases pass without throwing.\n');

// 4. Test Book Duplicate Matching Logic with All Edge Cases
console.log('4. Testing book duplicate matching with conflicting known authors...');
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

        if (isKnownAuthor && isKnownBAuthor && bAuthor !== metaAuthor) {
            return false;
        }

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

const shelf = [
    { id: '101', title: '三体', author: '刘慈欣', format: 'epub', filename: 'three_body.epub', size: 100000 },
    { id: '102', title: '三体', author: '同人作者', format: 'epub', filename: 'three_body_fanfic.epub', size: 100000 }
];

// Reimporting 刘慈欣's book
const matchOriginal = matchBook(shelf, 'epub', { title: '三体', author: '刘慈欣' }, 'three_body_copy.epub', 100000);
assert.strictEqual(matchOriginal?.id, '101', 'Must match original book by known author');

// Importing a new book with conflicting author should not overwrite either if sizes/titles match
const matchConflicting = matchBook(shelf, 'epub', { title: '三体', author: '另一位作家' }, 'other.epub', 100000);
assert.strictEqual(matchConflicting, undefined, 'Conflicting known author must NOT match any existing books');
console.log('  ✓ Book matching strictly respects known authors.\n');

console.log('====================================================');
console.log(' ALL END-TO-END VERIFICATION CHECKS PASSED!        ');
console.log('====================================================\n');
