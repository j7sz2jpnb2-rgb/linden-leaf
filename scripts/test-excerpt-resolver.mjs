import assert from 'node:assert/strict'
import { resolveExcerptSource, flattenToc, findTocItem } from '../js/excerpt-source-resolver.js'

console.log('Testing Excerpt Source Resolver...')

// Test 1: TOC Flattening and Searching
const sampleToc = [
    { label: '第一卷', href: 'ch1.xhtml', subitems: [
        { label: '第 1 章 [1] 序幕', href: 'ch1.xhtml#sec1' },
        { label: '第 2 章 ① 启程', href: 'ch1.xhtml#sec2' }
    ]},
    { label: '第二卷', href: 'ch2.xhtml' }
]

const flattened = flattenToc(sampleToc)
assert.equal(flattened.length, 4, 'Flattened TOC should have 4 items')
assert.equal(flattened[1].label, '第 1 章 [1] 序幕')

// Test 2: EPUB with explicit chapter containing [1] / ① (Footnote markers preserved!)
const res1 = resolveExcerptSource({
    format: 'epub',
    chapterTitle: '第 1 章 [1] 序幕',
    currentLocation: { location: { current: 42, total: 100 } }
}, sampleToc)

assert.equal(res1.chapterTitle, '第 1 章 [1] 序幕', 'Footnote marker [1] must NOT be stripped from chapter title')
assert.equal(res1.locationInfo, '', 'EPUB locationInfo must be empty by default (no 42%!)')
assert.equal(res1.source, '第 1 章 [1] 序幕')

// Test 3: EPUB with no chapter and no TOC (Must NOT inject reading percentage!)
const res2 = resolveExcerptSource({
    format: 'epub',
    currentLocation: {
        location: { current: 55, total: 100 },
        fraction: 0.55
    }
}, [])

assert.equal(res2.chapterTitle, '', 'EPUB chapterTitle must be empty when no TOC item found')
assert.equal(res2.locationInfo, '', 'EPUB locationInfo must be empty (must NEVER be 55%)')
assert.equal(res2.source, '', 'EPUB combined source must be empty')

// Test 4: Discard percentage if mistakenly passed as chapterTitle
const res3 = resolveExcerptSource({
    format: 'epub',
    chapterTitle: '42%'
}, sampleToc)

assert.equal(res3.chapterTitle, '', 'Percentage passed as chapter title must be sanitized away')

// Test 5: PDF with page number and TOC
const pdfToc = [
    { label: '绪论', href: '#page=1', page: 0 },
    { label: '第一章 基础', href: '#page=10', page: 9 }
]

const resPdf1 = resolveExcerptSource({
    format: 'pdf',
    page: 12,
    currentLocation: { page: 12 }
}, pdfToc)

assert.equal(resPdf1.chapterTitle, '第一章 基础', 'PDF should match preceding outline entry')
assert.equal(resPdf1.locationInfo, '第 12 页', 'PDF location should default to page number')
assert.equal(resPdf1.source, '第一章 基础 · 第 12 页')

// Test 6: PDF without TOC
const resPdf2 = resolveExcerptSource({
    format: 'pdf',
    page: 5,
    currentLocation: { page: 5 }
}, [])

assert.equal(resPdf2.chapterTitle, '', 'PDF without TOC has empty chapter title')
assert.equal(resPdf2.locationInfo, '第 5 页', 'PDF without TOC retains page number')
assert.equal(resPdf2.source, '第 5 页')

// Test 7: Selection DOM node heading resolution
const mockHeading = { tagName: 'H2', textContent: '第 3 章 · 风暴来袭' }
const mockParent = {
    nodeType: 1,
    tagName: 'DIV',
    previousElementSibling: mockHeading,
    parentElement: null,
    closest: () => null
}
const mockTextNode = {
    nodeType: 3,
    parentElement: mockParent
}

const resDom = resolveExcerptSource({
    format: 'epub',
    range: { startContainer: mockTextNode },
    currentLocation: { location: { current: 10, total: 100 } }
}, sampleToc)

assert.equal(resDom.chapterTitle, '第 3 章 · 风暴来袭', 'Should resolve chapter from preceding heading element')
assert.equal(resDom.locationInfo, '', 'Location info remains empty for EPUB')

console.log('All Excerpt Source Resolver tests PASSED successfully!')
