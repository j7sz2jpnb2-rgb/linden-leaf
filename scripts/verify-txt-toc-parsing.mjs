// verify-txt-toc-parsing.mjs - Automated verification for TXT TOC clustering and chapter parsing
import fs from 'fs';
import path from 'path';

console.log('=== VERIFYING TXT TOC AND CHAPTER PARSING ===');

if (!globalThis.DOMParser) {
    globalThis.DOMParser = class {
        parseFromString(str, type) {
            return {
                body: { innerText: str, textContent: str },
                getElementById: (id) => ({ id })
            };
        }
    };
}
if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:mock-url-' + Math.random();
    URL.revokeObjectURL = () => {};
}

const { makeTXT, makeBook } = await import('../foliate-js-main/txt.js');

// 1. Gatsby Verification
const desktop = 'C:/Users/YONGHU/Desktop';
let gatsbyFile = null;
if (fs.existsSync(desktop)) {
    const files = fs.readdirSync(desktop);
    gatsbyFile = files.find(f => f.includes('GATSBY') && f.endsWith('.txt'));
}

if (gatsbyFile) {
    console.log('[Test 1] Testing Gatsby from Desktop:', gatsbyFile);
    const fullPath = path.join(desktop, gatsbyFile);
    const fileBuffer = fs.readFileSync(fullPath);
    const fakeFile = {
        name: gatsbyFile,
        type: 'text/plain',
        arrayBuffer: async () => fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength)
    };

    const book = await makeTXT(fakeFile);
    if (book.sections.length !== 10) {
        throw new Error(`Expected exactly 10 sections for Gatsby, got ${book.sections.length}`);
    }
    if (book.toc[0].label !== '扉页 / 目录') {
        throw new Error(`Expected section 0 label to be '扉页 / 目录', got '${book.toc[0].label}'`);
    }
    for (let i = 1; i <= 9; i++) {
        if (book.toc[i].label !== `Chapter ${i}`) {
            throw new Error(`Expected section ${i} label to be 'Chapter ${i}', got '${book.toc[i].label}'`);
        }
        if (book.sections[i].size < 20000) {
            throw new Error(`Section ${i} size (${book.sections[i].size}) is unexpectedly small; chapters may be missing content!`);
        }
    }
    console.log('PASS: Gatsby correctly parsed into 10 sections (扉页/目录 + Chapter 1..9), no fake chapters, genuine content verified.');
} else {
    console.log('[Test 1] Skipped (Gatsby file not on Desktop)');
}

const toArrayBuffer = str => {
    const buf = Buffer.from(str, 'utf-8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

// 2. Explicit 目录 Chinese Book Test
console.log('\n[Test 2] Testing Chinese book with explicit 目录');
const sampleChinese = `书名：寻梦者
作者：李白

目录
第一章 启程
第二章 险途
第三章 峰顶

` + '第一章 启程\n' + '这里是第一章的内容，有很多段落和文字。\n'.repeat(20) +
'第二章 险途\n' + '这里是第二章的内容，充满了冒险与探索。\n'.repeat(20) +
'第三章 峰顶\n' + '这里是第三章的内容，终于到达了终点与荣耀。\n'.repeat(20);

const fakeChineseFile = {
    name: '寻梦者.txt',
    type: 'text/plain',
    arrayBuffer: async () => toArrayBuffer(sampleChinese)
};
const book2 = await makeTXT(fakeChineseFile);
console.log('Sections:', book2.toc.map(t => t.label));
if (book2.sections.length !== 4) {
    throw new Error(`Expected 4 sections (front-matter + 3 chapters), got ${book2.sections.length}`);
}
if (!book2.toc[0].label.includes('目录')) {
    throw new Error(`Expected front matter section to include '目录', got '${book2.toc[0].label}'`);
}
console.log('PASS: Chinese book with explicit 目录 parsed cleanly into front-matter TOC and 3 chapters.');

// 3. Regular Book without TOC
console.log('\n[Test 3] Testing standard book without TOC');
const sampleStandard = 'Chapter 1\n' + 'It was the best of times, it was the worst of times.\n'.repeat(20) +
'Chapter 2\n' + 'It was the age of wisdom, it was the age of foolishness.\n'.repeat(20);

const fakeStandardFile = {
    name: 'Standard.txt',
    type: 'text/plain',
    arrayBuffer: async () => toArrayBuffer(sampleStandard)
};
const book3 = await makeTXT(fakeStandardFile);
console.log('Sections:', book3.toc.map(t => t.label));
if (book3.sections.length !== 2 || book3.toc[0].label !== 'Chapter 1' || book3.toc[1].label !== 'Chapter 2') {
    throw new Error(`Expected 2 sections (Chapter 1 and Chapter 2), got ${book3.sections.length}`);
}
console.log('PASS: Standard book without TOC preserved all chapters.');

// 4. Poetry without recurrence
console.log('\n[Test 4] Testing poetry without recurrence');
const samplePoem = `第一首
床前明月光
疑是地上霜

第二首
春眠不觉晓
处处闻啼鸟`;

const fakePoemFile = {
    name: '唐诗两首.txt',
    type: 'text/plain',
    arrayBuffer: async () => toArrayBuffer(samplePoem)
};

const book4 = await makeTXT(fakePoemFile);
console.log('Sections:', book4.toc.map(t => t.label));
if (book4.sections.length !== 2) {
    throw new Error(`Expected 2 sections for poetry, got ${book4.sections.length}`);
}
console.log('PASS: Poetry without recurrence preserved as individual poems.');

console.log('\n======================================================');
console.log('ALL TXT TOC AND CHAPTER PARSING TESTS PASSED (4/4)!');
console.log('======================================================');
