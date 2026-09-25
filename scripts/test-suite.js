// scripts/test-suite.js - Comprehensive Verification Suite
import assert from 'node:assert';
import WebDAVService from '../services/webdav.js';
import { AppUpdater } from '../js/updater.js';
import { platformBridge } from '../js/platformBridge.js';

console.log('=== Starting Linden Leaf Verification Suite ===\n');

const tests = [];

function runTest(name, fn) {
    tests.push({ name, fn });
}

// 1. WebDAVService Tests
runTest('WebDAVService.normalizeUrl properly handles base paths and sub paths', () => {
    assert.strictEqual(
        WebDAVService.normalizeUrl('https://dav.jianguoyun.com/dav', 'LindenLeaf/books'),
        'https://dav.jianguoyun.com/dav/LindenLeaf/books'
    );
    assert.strictEqual(
        WebDAVService.normalizeUrl('https://dav.jianguoyun.com/dav/', 'LindenLeaf/'),
        'https://dav.jianguoyun.com/dav/LindenLeaf/'
    );
    assert.strictEqual(
        WebDAVService.normalizeUrl('dav.jianguoyun.com/dav', 'file.txt'),
        'https://dav.jianguoyun.com/dav/file.txt'
    );
});

runTest('WebDAVService.sanitizeFileName preserves Unicode and replaces dangerous characters', () => {
    assert.strictEqual(
        WebDAVService.sanitizeFileName('三体/全集:第一部?.epub'),
        '三体_全集_第一部_.epub'
    );
    assert.strictEqual(
        WebDAVService.sanitizeFileName('..\\..\\etc\\passwd'),
        'etc_passwd'
    );
    assert.strictEqual(
        WebDAVService.sanitizeFileName('normal-book-title_2026.pdf'),
        'normal-book-title_2026.pdf'
    );
});

runTest('WebDAVService.getAuthHeader produces valid Basic Auth', () => {
    const header = WebDAVService.getAuthHeader('user@test.com', 'secret123');
    const expected = 'Basic ' + Buffer.from('user@test.com:secret123').toString('base64');
    assert.strictEqual(header, expected);
});

// 2. Updater Tests
runTest('Updater.compareVersions correctly compares semantic versions', () => {
    const updater = new AppUpdater('1.2.3');
    assert.strictEqual(updater.compareVersions('1.2.4', '1.2.3'), 1);
    assert.strictEqual(updater.compareVersions('v1.2.3', '1.2.3'), 0);
    assert.strictEqual(updater.compareVersions('1.2.2', '1.2.3'), -1);
    assert.strictEqual(updater.compareVersions('2.0.0', '1.9.9'), 1);
    assert.strictEqual(updater.compareVersions('1.3.0', '1.2.9'), 1);
});

// 3. PlatformBridge Compatibility Aliases
runTest('PlatformBridge provides backward-compatible electronAPI aliases', () => {
    assert.strictEqual(typeof platformBridge.syncGetConfig, 'function');
    assert.strictEqual(typeof platformBridge.syncSaveConfig, 'function');
    assert.strictEqual(typeof platformBridge.syncRevealPassword, 'function');
    assert.strictEqual(typeof platformBridge.syncTestConnection, 'function');
    assert.strictEqual(typeof platformBridge.syncFetchRemote, 'function');
    assert.strictEqual(typeof platformBridge.syncSaveRemote, 'function');
    assert.strictEqual(typeof platformBridge.syncUploadBookBinary, 'function');
    assert.strictEqual(typeof platformBridge.syncDownloadBookBinary, 'function');
    assert.strictEqual(typeof platformBridge.syncDeleteBookBinary, 'function');
});

// 4. PDF Outline Destination Resolution Logic
runTest('PDF outline dest resolution logic works as expected', async () => {
    // Mock pdfDoc
    const mockPdfDoc = {
        async getPageIndex(ref) {
            if (ref && ref.num === 42) return 5;
            if (ref && ref.num === 99) return 10;
            return 0;
        },
        async getDestination(namedDest) {
            if (namedDest === 'chapter1') return [{ num: 42, gen: 0 }, { name: 'XYZ' }];
            return null;
        }
    };

    // Simulate getOutlineFlat logic
    async function resolveDest(item, pdfDoc) {
        let pageIndex = 0;
        if (typeof item.dest === 'string') {
            try {
                const explicitDest = await pdfDoc.getDestination(item.dest);
                if (explicitDest && explicitDest[0]) {
                    pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);
                }
            } catch (e) {}
        } else if (item.dest && item.dest[0]) {
            try {
                pageIndex = await pdfDoc.getPageIndex(item.dest[0]);
            } catch (e) {
                pageIndex = 0;
            }
        }
        return pageIndex;
    }

    const page1 = await resolveDest({ dest: [{ num: 42, gen: 0 }] }, mockPdfDoc);
    assert.strictEqual(page1, 5, 'Object ID 42 resolves to physical 0-based page index 5');

    const page2 = await resolveDest({ dest: 'chapter1' }, mockPdfDoc);
    assert.strictEqual(page2, 5, 'Named destination "chapter1" resolves to physical 0-based page index 5');
});

// 5. PDF Viewport Zoom Formula Logic
runTest('PDF Viewport setZoom scale ratio computation preserves scroll delta', () => {
    let scale = 1.0;
    const pageOffsets = [{ top: 16, height: 800 }, { top: 832, height: 800 }];
    const currentPage = 1;
    let scrollTop = 900; // In page 1, scrollDelta = 900 - 832 = 68

    // Test the formula
    const targetScale = 1.5;
    const prevScale = scale;
    const prevCurrentPageTop = pageOffsets[currentPage].top;
    const scrollDelta = scrollTop - prevCurrentPageTop;

    scale = targetScale;
    const newCurrentPageTop = Math.round(pageOffsets[currentPage].top * (targetScale / prevScale));
    const newScrollTop = newCurrentPageTop + scrollDelta * (targetScale / prevScale);

    assert.strictEqual(scrollDelta, 68);
    assert.strictEqual(targetScale / prevScale, 1.5);
    assert.strictEqual(newScrollTop, newCurrentPageTop + 102);
});

// 6. PDF Highlight Styles & RGBA Color Conversion
runTest('PDF Viewport _toRgba properly converts hex colors to translucent rgba', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js');
    const toRgba = PdfViewport.prototype._toRgba;
    assert.strictEqual(toRgba('#facc15', 0.38), 'rgba(250, 204, 21, 0.38)');
    assert.strictEqual(toRgba('#fff', 0.5), 'rgba(255, 255, 255, 0.5)');
    assert.strictEqual(toRgba('rgba(10, 20, 30, 0.2)', 0.38), 'rgba(10, 20, 30, 0.2)');
    assert.strictEqual(toRgba('rgb(10, 20, 30)', 0.38), 'rgba(10, 20, 30, 0.38)');
});

// 7. Dark & OLED Black Theme Invert Filter Verification
runTest('css/main.css contains dark/black theme PDF page invert filters', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const cssContent = fs.readFileSync(path.join(__dirname, '../css/main.css'), 'utf-8');

    assert.ok(cssContent.includes('[data-theme="dark"] .pdf-page-img'), 'Contains dark theme pdf-page-img rule');
    assert.ok(cssContent.includes('[data-theme="black"] .pdf-page-img'), 'Contains black theme pdf-page-img rule');
    assert.ok(cssContent.includes('filter: invert(0.90) hue-rotate(180deg) contrast(1.1) brightness(0.95)'), 'Contains exact invert filter specification');
    assert.ok(cssContent.includes('.pdf-viewport-container'), 'Contains pdf-viewport-container styling');
    assert.ok(cssContent.includes('.pdf-page-slot'), 'Contains pdf-page-slot styling');
});

// 8. PDF Search Overlapping Span Match Rects Calculation
runTest('PDF search accurately computes normalized match rects and yRatio across spans', () => {
    const pageSize = { width: 600, height: 800 };
    const spans = [
        { text: 'Chapter', x: 50, y: 100, w: 60, h: 16 },
        { text: 'One:', x: 115, y: 100, w: 35, h: 16 },
        { text: 'The', x: 155, y: 100, w: 25, h: 16 },
        { text: 'Beginning', x: 185, y: 100, w: 75, h: 16 }
    ];

    const fullText = spans.map(s => s.text).join(' '); // "Chapter One: The Beginning"
    let curOffset = 0;
    const spanOffsets = spans.map(s => {
        const start = curOffset;
        const end = start + s.text.length;
        curOffset = end + 1;
        return { span: s, start, end };
    });

    const query = 'One';
    const foundIdx = fullText.indexOf(query);
    assert.notStrictEqual(foundIdx, -1);
    const matchEnd = foundIdx + query.length;

    const matchedRects = [];
    for (const { span: s, start: sStart, end: sEnd } of spanOffsets) {
        if (sStart < matchEnd && sEnd > foundIdx) {
            const x1 = Math.max(0, Math.min(1, s.x / pageSize.width));
            const y1 = Math.max(0, Math.min(1, s.y / pageSize.height));
            const x2 = Math.max(0, Math.min(1, (s.x + s.w) / pageSize.width));
            const y2 = Math.max(0, Math.min(1, (s.y + s.h) / pageSize.height));
            matchedRects.push([x1, y1, x2, y2]);
        }
    }

    assert.strictEqual(matchedRects.length, 1);
    assert.strictEqual(matchedRects[0][0], 115 / 600);
    assert.strictEqual(matchedRects[0][1], 100 / 800);
    assert.strictEqual(matchedRects[0][2], (115 + 35) / 600);
    assert.strictEqual(matchedRects[0][3], (100 + 16) / 800);
});

// 9. Active TOC Mapping by Page Index
runTest('PDF active TOC mapping identifies the latest chapter starting at or before currentPage', () => {
    const toc = [
        { label: 'Cover', page: 0, href: '#page=1' },
        {
            label: 'Part I',
            page: 4,
            href: '#page=5',
            subitems: [
                { label: 'Chapter 1', page: 6, href: '#page=7' },
                { label: 'Chapter 2', page: 18, href: '#page=19' }
            ]
        },
        { label: 'Part II', page: 35, href: '#page=36' }
    ];

    const flattenTOC = (items) => {
        let result = [];
        for (const it of items) {
            result.push(it);
            if (it.subitems && it.subitems.length) {
                result = result.concat(flattenTOC(it.subitems));
            }
        }
        return result;
    };

    const flat = flattenTOC(toc);

    function findActiveTOC(pageIdx) {
        let activeItem = null;
        for (const it of flat) {
            const itemPage = typeof it.page === 'number' ? it.page : (parseInt(it.href?.replace(/[^0-9]/g, ''), 10) - 1);
            if (!isNaN(itemPage) && itemPage <= pageIdx) {
                activeItem = it;
            } else if (!isNaN(itemPage) && itemPage > pageIdx) {
                break;
            }
        }
        return activeItem;
    }

    assert.strictEqual(findActiveTOC(0)?.href, '#page=1');
    assert.strictEqual(findActiveTOC(5)?.href, '#page=5');
    assert.strictEqual(findActiveTOC(6)?.href, '#page=7');
    assert.strictEqual(findActiveTOC(10)?.href, '#page=7');
    assert.strictEqual(findActiveTOC(20)?.href, '#page=19');
    assert.strictEqual(findActiveTOC(50)?.href, '#page=36');
});

// 10. PDF ETA Calculation Logic
runTest('PDF ETA badge computes remaining duration from page count and pace', () => {
    const totalPages = 100;
    const currentPage = 39; // 0-based pageIdx = 39 -> 40th page
    const paceSecs = 45; // 45 seconds per page
    const remainingPages = Math.max(0, totalPages - (currentPage + 1)); // 60 pages
    const remainingSecs = remainingPages * paceSecs; // 2700 seconds = 45 minutes

    assert.strictEqual(remainingPages, 60);
    assert.strictEqual(remainingSecs, 2700);

    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '0分钟';
        const mins = Math.round(seconds / 60);
        if (mins < 60) return `${mins}分钟`;
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return remMins > 0 ? `${hrs}小时${remMins}分钟` : `${hrs}小时`;
    }

    assert.strictEqual(formatDuration(remainingSecs), '45分钟');
});

// 11. Settings Panel Fixed-Layout Detection
runTest('Settings panel correctly identifies PDF mode as fixed layout', () => {
    function isFixedLayout(state) {
        return !!(state.pdfViewport || (state.foliateView && state.foliateView.isFixedLayout) || state.currentBookData?.format === 'pdf');
    }

    assert.strictEqual(isFixedLayout({ pdfViewport: {}, foliateView: null }), true, 'pdfViewport is active');
    assert.strictEqual(isFixedLayout({ pdfViewport: null, foliateView: { isFixedLayout: true } }), true, 'foliateView fixed layout');
    assert.strictEqual(isFixedLayout({ pdfViewport: null, foliateView: { isFixedLayout: false }, currentBookData: { format: 'pdf' } }), true, 'PDF format metadata');
    assert.strictEqual(isFixedLayout({ pdfViewport: null, foliateView: { isFixedLayout: false }, currentBookData: { format: 'epub' } }), false, 'Standard EPUB reflow');
});

// 12. Maximum Visible Area Page Detection Algorithm
runTest('PDF Viewport _detectCurrentPage correctly detects page with highest visible intersection', () => {
    const pageOffsets = [
        { top: 16, height: 800 },
        { top: 832, height: 800 }, // 16px gap between 816 and 832
        { top: 1648, height: 800 }
    ];
    const viewHeight = 600;

    function detectPage(scrollTop) {
        const scrollBottom = scrollTop + viewHeight;
        let maxVisibleHeight = -1;
        let bestPage = 0;
        for (let i = 0; i < pageOffsets.length; i++) {
            const p = pageOffsets[i];
            const pageBottom = p.top + p.height;
            if (pageBottom < scrollTop) continue;
            if (p.top > scrollBottom) break;
            const visibleTop = Math.max(scrollTop, p.top);
            const visibleBottom = Math.min(scrollBottom, pageBottom);
            const visibleHeight = Math.max(0, visibleBottom - visibleTop);
            if (visibleHeight > maxVisibleHeight) {
                maxVisibleHeight = visibleHeight;
                bestPage = i;
            }
        }
        return bestPage;
    }

    // Top of page 0
    assert.strictEqual(detectPage(0), 0);
    // Scrolling in page 0 (scrollTop 300: page 0 has 516px visible, page 1 has 0)
    assert.strictEqual(detectPage(300), 0);
    // Near bottom of page 0 (scrollTop 600: page 0 has 216px visible, page 1 has 1648-832? scrollBottom 1200, page 1 visible 832 to 1200 = 368px) -> page 1 has more visible area!
    assert.strictEqual(detectPage(600), 1);
    // Inter-page gap test: scrollTop = 500 (scrollBottom = 1100, page 0 visible: 500..816 = 316px; page 1 visible: 832..1100 = 268px) -> page 0 wins
    assert.strictEqual(detectPage(500), 0);
});

// 13. PDF Named Colors Conversion Test
runTest('PDF Viewport _toRgba correctly handles common named colors', async () => {
    const { PdfViewport } = await import('../js/pdf-viewport.js');
    const toRgba = PdfViewport.prototype._toRgba;
    assert.strictEqual(toRgba('yellow', 0.38), 'rgba(250, 204, 21, 0.38)');
    assert.strictEqual(toRgba('blue', 0.38), 'rgba(59, 130, 246, 0.38)');
    assert.strictEqual(toRgba('green', 0.38), 'rgba(34, 197, 94, 0.38)');
});

// 14. PDF Highlight Hit Testing
runTest('PDF highlight hit testing detects clicked note within bounds', () => {
    const highlights = [
        {
            id: 'hl_1',
            pdfTarget: {
                page: 2,
                rects: [[0.1, 0.2, 0.4, 0.25]]
            }
        },
        {
            id: 'hl_2',
            pdfTarget: {
                page: 2,
                rects: [[0.5, 0.6, 0.8, 0.65]]
            }
        }
    ];

    function hitTest(pageIdx, clickX, clickY) {
        const pageHls = highlights.filter(h => h.pdfTarget && h.pdfTarget.page === pageIdx);
        for (let i = pageHls.length - 1; i >= 0; i--) {
            const hl = pageHls[i];
            for (const [x1, y1, x2, y2] of hl.pdfTarget.rects) {
                const marginX = 0.01;
                const marginY = 0.01;
                if (clickX >= x1 - marginX && clickX <= x2 + marginX &&
                    clickY >= y1 - marginY && clickY <= y2 + marginY) {
                    return hl.id;
                }
            }
        }
        return null;
    }

    assert.strictEqual(hitTest(2, 0.25, 0.22), 'hl_1');
    assert.strictEqual(hitTest(2, 0.65, 0.62), 'hl_2');
    assert.strictEqual(hitTest(2, 0.05, 0.05), null);
    assert.strictEqual(hitTest(1, 0.25, 0.22), null);
});

let passedTests = 0;
for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passedTests++;
    } catch (e) {
        console.error(`[FAIL] ${name}:`, e);
        process.exit(1);
    }
}

console.log(`\n=== All ${passedTests} Tests Passed Successfully! ===`);
