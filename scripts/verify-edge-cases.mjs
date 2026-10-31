// scripts/verify-edge-cases.mjs
import assert from 'node:assert/strict';

console.log('Testing Edge Cases...');

// Edge case 1: Token clamping boundary values
const clampAiTokens = (val) => Math.max(256, Math.min(20000, Number(val) || 2048));
assert.equal(clampAiTokens(0), 2048); // 0 or falsy fallback to 2048 default in settings
assert.equal(clampAiTokens(-50), 256);
assert.equal(clampAiTokens(256), 256);
assert.equal(clampAiTokens(20000), 20000);
assert.equal(clampAiTokens(20001), 20000);
assert.equal(clampAiTokens(999999), 20000);
assert.equal(clampAiTokens(NaN), 2048);
assert.equal(clampAiTokens(undefined), 2048);
assert.equal(clampAiTokens('12000'), 12000);
console.log('  [PASS] Edge Case 1: Token Clamping');

// Edge case 2: Paginator geometry boundary calculations
function computeGeometry(size, g, maxInlineSize, maxColumnCount = 2) {
    const gap = Math.round(size * (Number.isFinite(g) ? g : 0.06));
    if (size <= maxInlineSize) {
        return { gap, columnWidth: maxInlineSize, divisor: 1 };
    }
    const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize));
    const columnWidth = divisor > 1
        ? Math.floor((size - (divisor - 1) * gap) / divisor)
        : divisor;
    return { gap, columnWidth, divisor };
}

// 1 Column
const g1 = computeGeometry(600, 0.06, 720, 2);
assert.equal(g1.divisor, 1);
assert.equal(g1.columnWidth, 720);

// 2 Columns standard 1400px width with 0.06 gap
const g2 = computeGeometry(1400, 0.06, 720, 2);
assert.equal(g2.divisor, 2);
assert.equal(g2.gap, 84);
// Total column width * 2 + gap = 658 * 2 + 84 = 1316 <= 1400, centered seam is exact
assert.equal(g2.columnWidth, Math.floor((1400 - 84) / 2));
assert.ok(g2.columnWidth > 0);

// Zero / negative size
const gZero = computeGeometry(0, 0.06, 720, 2);
assert.equal(gZero.divisor, 1);
console.log('  [PASS] Edge Case 2: Symmetrical Geometry Calculations');

// Edge case 3: Cross search snippet formatting & empty string
function formatHits(hits) {
    if (!hits || hits <= 0) return '0 处匹配';
    return `${hits} 处匹配`;
}
assert.equal(formatHits(0), '0 处匹配');
assert.equal(formatHits(1), '1 处匹配');
assert.equal(formatHits(328), '328 处匹配');
console.log('  [PASS] Edge Case 3: Hit Count Badging');

// Edge case 4: Note markdown export grouping
function buildMarkdownNotes(notes, bookMap) {
    if (!notes || notes.length === 0) return null;
    let md = `# 划线与笔记汇总\n\n`;
    const grouped = new Map();
    for (const n of notes) {
        const b = bookMap.get(n.bookId);
        const bTitle = b?.title || n.bookTitle || '未知书籍';
        if (!grouped.has(bTitle)) grouped.set(bTitle, []);
        grouped.get(bTitle).push(n);
    }
    for (const [title, bookNotes] of grouped.entries()) {
        md += `## 《${title}》\n\n`;
        bookNotes.forEach((n, idx) => {
            const chap = n.chapterTitle || '正文';
            md += `### ${idx + 1}. ${chap}\n\n`;
            if (n.text) md += `> ${n.text}\n\n`;
            if (n.note) md += `**💭 想法**：${n.note}\n\n`;
        });
    }
    return md;
}

const mockBookMap = new Map([['b1', { title: '三体' }]]);
const emptyMd = buildMarkdownNotes([], mockBookMap);
assert.equal(emptyMd, null);

const populatedMd = buildMarkdownNotes([
    { bookId: 'b1', text: '给岁月以文明', note: '震撼的话', chapterTitle: '第1章' },
    { bookId: 'b2', text: '孤立的引文', note: '', chapterTitle: '' }
], mockBookMap);
assert.ok(populatedMd.includes('《三体》'));
assert.ok(populatedMd.includes('> 给岁月以文明'));
assert.ok(populatedMd.includes('**💭 想法**：震撼的话'));
assert.ok(populatedMd.includes('《未知书籍》'));
console.log('  [PASS] Edge Case 4: Note Markdown Formatter');

console.log('\nAll Edge Cases Verified Successfully!');
