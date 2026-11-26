import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.NodeFilter ??= { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.HTMLElement ??= class {
    attachShadow() { return {}; }
    addEventListener() {}
    removeEventListener() {}
    hasAttribute() { return false; }
};
globalThis.customElements ??= { get() {}, define() {} };
globalThis.CSS ??= { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };

const { UniversalReaderApp } = await import('../js/app.js');
const { AnnotationsDrawerController } = await import('../js/annotations-drawer-controller.js');
const { buildContentCSS, resolveEffectiveReaderLayout } = await import('../js/reader-style-builder.js');
const { ThemeCustomizer } = await import('../js/theme-customizer.js');
const { ChapterTranslationManager } = await import('../js/chapter-translation-manager.js');
const { StatsViewController } = await import('../js/stats-view-controller.js');
const { platformBridge } = await import('../js/platformBridge.js');
const { View } = await import('../foliate-js-main/view.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let passed = 0;
const test = async (name, fn) => {
    await fn();
    passed++;
    console.log('[PASS]', name);
};

function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...cls) => cls.forEach((c) => set.add(c)),
        remove: (...cls) => cls.forEach((c) => set.delete(c)),
        toggle: (c, force) => (force === undefined ? (set.has(c) ? (set.delete(c), false) : (set.add(c), true)) : (force ? (set.add(c), true) : (set.delete(c), false))),
        contains: (c) => set.has(c)
    };
}

await test('1A: clearActiveTextSelection clears Foliate view, iframe selections, PDF selection, and ranges cleanly', () => {
    let deselectCalls = 0;
    let frame1Removed = 0;
    let frame2Removed = 0;
    let pdfClearCalls = 0;
    let windowRemoved = 0;
    let multiBadgeDisplay = 'inline-flex';
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    globalThis.window = {
        ...prevWin,
        getSelection: () => ({ removeAllRanges() { windowRemoved++; } })
    };
    globalThis.document = {
        ...prevDoc,
        getElementById: (id) => (id === 'popup-multi-badge' ? { style: { display: multiBadgeDisplay }, setAttribute() {}, get hidden() { return false; } } : null),
        querySelectorAll: () => []
    };
    try {
        const badgeEl = { style: { display: 'inline-flex' } };
        globalThis.document.getElementById = (id) => (id === 'popup-multi-badge' ? badgeEl : null);
        const app = {
            dom: {
                selectionPopup: { classList: makeClassList() },
                highlightActionPopup: { classList: makeClassList() },
                readerContentArea: { querySelectorAll: () => [] }
            },
            foliateView: {
                deselect() { deselectCalls++; },
                renderer: {
                    getContents: () => [
                        { doc: { getSelection: () => ({ removeAllRanges() { frame1Removed++; } }) } },
                        { doc: { defaultView: { getSelection: () => ({ removeAllRanges() { frame2Removed++; } }) } } }
                    ]
                }
            },
            pdfViewport: { clearSelection() { pdfClearCalls++; } }
        };
        const ctrl = new AnnotationsDrawerController(app);
        ctrl.selectedTextInfo = { text: 'hello' };
        ctrl._frozenSelectionSnapshot = { text: 'hello' };
        ctrl.multiSelectedRanges = [{ cfi: 'c1', text: 'a' }, { cfi: 'c2', text: 'b' }];

        ctrl.clearActiveTextSelection({ preserveRanges: true });
        assert.equal(deselectCalls, 1);
        assert.equal(frame1Removed, 1);
        assert.equal(frame2Removed, 1);
        assert.equal(pdfClearCalls, 1);
        assert.equal(windowRemoved, 1);
        assert.equal(ctrl.multiSelectedRanges.length, 2);

        ctrl.clearActiveTextSelection();
        assert.equal(deselectCalls, 2);
        assert.equal(ctrl.selectedTextInfo, null);
        assert.equal(ctrl._frozenSelectionSnapshot, null);
        assert.deepEqual(ctrl.multiSelectedRanges, []);
        assert.equal(badgeEl.style.display, 'none');
    } finally {
        globalThis.window = prevWin;
        globalThis.document = prevDoc;
    }
});

await test('1B: Single-gesture dismissal lock captures active popups/selections and consumes tap without toggling reader UI', () => {
    const makePopupEl = (visible = false, useActive = false) => ({
        classList: makeClassList(visible && useActive ? ['active'] : []),
        style: { display: visible && !useActive ? 'block' : 'none' }
    });
    const prevDoc = globalThis.document;
    globalThis.document = {
        ...prevDoc,
        getElementById: () => null,
        querySelectorAll: () => []
    };
    try {
        const app = Object.create(UniversalReaderApp.prototype);
        const selectionPopup = makePopupEl(false, true);
        const footnotePopup = makePopupEl(true, false);
        let clearedSelections = 0;
        let cancelledToggle = 0;
        let cardCloses = 0;
        app.dom = {};
        app.annotations = {
            dom: {
                selectionPopup,
                highlightActionPopup: makePopupEl(false, false)
            },
            multiSelectedRanges: [],
            clearActiveTextSelection() { clearedSelections++; },
            hideSelectionPopup() { selectionPopup.classList.remove('active'); selectionPopup.style.display = 'none'; },
            hideHighlightActionPopup() {}
        };
        app.cards = {
            dom: {
                readerDictionaryCard: makePopupEl(false, false),
                footnotePopup,
                readerParaTranslationCard: makePopupEl(false, false)
            },
            hideDictionaryCard() { cardCloses++; },
            hideFootnotePopup() { footnotePopup.style.display = 'none'; cardCloses++; },
            hideParaTranslationCard() { cardCloses++; }
        };
        app.foliateView = { renderer: { getContents: () => [] } };
        app.pdfViewport = {};
        app.cancelPendingReaderUIToggle = () => { cancelledToggle++; };

        assert.equal(app.captureSelectionAndPopupStateOnGestureStart(), true);
        assert.equal(Boolean(app._dismissSelectionGesture), true);

        const consumed = app.consumeDismissalGesture({ clearSelection: true });
        assert.equal(consumed, true);
        assert.equal(footnotePopup.style.display, 'none');
        assert.equal(clearedSelections, 1);
        assert.equal(cancelledToggle, 1);
        assert.ok(cardCloses >= 1);

        // Once footnote popup is hidden and lock cleared cleanly, a fresh gesture reports false
        app._clearDismissSelectionGesture?.();
        assert.equal(app.captureSelectionAndPopupStateOnGestureStart(), false);
        assert.equal(app.consumeDismissalGesture({ clearSelection: true }), false);
    } finally {
        globalThis.document = prevDoc;
    }
});

await test('1C & 2A: resolveEffectiveReaderLayout enforces desktop paginated vertical safe margins and buildContentCSS includes TTS highlight', () => {
    const prevDoc = globalThis.document;
    globalThis.document = {
        ...prevDoc,
        documentElement: { classList: makeClassList([]) }
    };
    try {
        const paginatedLayout = resolveEffectiveReaderLayout({
            margin: 24,
            readingWidth: 800,
            layout: 'paginated'
        }, { isMobile: false, viewportWidth: 1280, viewportHeight: 800 });
        assert.ok(paginatedLayout.marginTop >= 58, `expected marginTop >= 58, got ${paginatedLayout.marginTop}`);
        assert.ok(paginatedLayout.marginBottom >= 54, `expected marginBottom >= 54, got ${paginatedLayout.marginBottom}`);

        const scrolledLayout = resolveEffectiveReaderLayout({
            margin: 24,
            layout: 'scrolled'
        }, { isMobile: false, viewportWidth: 1280, viewportHeight: 800 });
        assert.equal(scrolledLayout.marginTop, 24);
        assert.equal(scrolledLayout.marginBottom, 24);

        const pubCss = buildContentCSS({ theme: 'light', preserveOriginalStyles: true });
        const customCss = buildContentCSS({ theme: 'light', preserveOriginalStyles: false });
        assert.ok(pubCss.includes('.tts-active-reading-segment'), 'publisher CSS must contain .tts-active-reading-segment');
        assert.ok(customCss.includes('.tts-active-reading-segment'), 'custom CSS must contain .tts-active-reading-segment');
    } finally {
        globalThis.document = prevDoc;
    }
});

await test('3-Theme: ThemeCustomizer exposes isDarkPalette luminance and emits all CSS variable aliases', () => {
    const customizer = new ThemeCustomizer();
    const darkPalette = {
        bgPrimary: '#181a1f',
        bgSecondary: '#22252b',
        bgSidebar: '#14161a',
        textMain: '#f3f4f6',
        textSecondary: '#9ca3af',
        borderColor: '#2e323b',
        accent: '#60a5fa',
        readerBg: '#121316',
        readerText: '#e5e7eb',
        selectionBg: 'rgba(96,165,250,0.35)'
    };
    customizer.currentPalette = { ...darkPalette };
    assert.equal(customizer.isDarkPalette, true);
    const rules = customizer.buildStyleRules(darkPalette);
    for (const token of ['--bg-app', '--bg-card', '--text-muted', '--accent-primary', '--book-bg', '--book-color']) {
        assert.ok(rules.includes(token), `Missing token ${token} in ThemeCustomizer rules`);
    }

    customizer.currentPalette = { ...darkPalette, readerBg: '#faf7f2' };
    assert.equal(customizer.isDarkPalette, false);
});

await test('3-Translation: ChapterTranslationManager injects target inside td/th/li without breaking structure, preserves source hash on re-extract, and cleans up safely', () => {
    function makeEl(tag, text = '') {
        const classes = new Set();
        const attrs = new Map();
        const children = [];
        const childNodes = text ? [{ nodeType: 3, nodeValue: text, textContent: text }] : [];
        const el = {
            tagName: tag.toUpperCase(),
            nodeType: 1,
            get textContent() {
                return childNodes.map((n) => n.textContent || '').join('');
            },
            set textContent(v) {
                childNodes.length = 0;
                if (v) childNodes.push({ nodeType: 3, nodeValue: String(v), textContent: String(v) });
            },
            get className() {
                return [...classes].join(' ');
            },
            set className(v) {
                classes.clear();
                String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
            },
            children,
            childNodes,
            parentElement: null,
            get parentNode() { return el.parentElement; },
            style: {},
            classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c)
            },
            setAttribute: (k, v) => attrs.set(k, String(v)),
            getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
            hasAttribute: (k) => attrs.has(k),
            removeAttribute: (k) => attrs.delete(k),
            appendChild(child) {
                child.parentElement = el;
                children.push(child);
                childNodes.push(child);
                return child;
            },
            insertAdjacentElement(pos, child) {
                if (pos === 'afterend' && el.parentElement) {
                    child.parentElement = el.parentElement;
                    const idx = el.parentElement.children.indexOf(el);
                    el.parentElement.children.splice(idx + 1, 0, child);
                    el.parentElement.childNodes.splice(idx + 1, 0, child);
                }
            },
            remove() {
                if (el.parentElement) {
                    const idx = el.parentElement.children.indexOf(el);
                    if (idx >= 0) el.parentElement.children.splice(idx, 1);
                    const nIdx = el.parentElement.childNodes.indexOf(el);
                    if (nIdx >= 0) el.parentElement.childNodes.splice(nIdx, 1);
                    el.parentElement = null;
                }
            },
            matches: () => false,
            closest(sel) {
                const sels = sel.split(',').map((s) => s.trim());
                let cur = el;
                while (cur) {
                    for (const s of sels) {
                        if (s.startsWith('.') && cur.classList?.contains(s.slice(1))) return cur;
                        if (s.startsWith('#') && cur.getAttribute?.('id') === s.slice(1)) return cur;
                        if (s.startsWith('[') && s.includes('=')) {
                            const m = s.match(/^\[([^=\]]+)="([^"]*)"\]$/);
                            if (m && cur.getAttribute?.(m[1]) === m[2]) return cur;
                        }
                        if (/^[a-z0-9]+$/i.test(s) && cur.tagName === s.toUpperCase()) return cur;
                    }
                    cur = cur.parentElement;
                }
                return null;
            },
            querySelector(sel) {
                return el.querySelectorAll(sel)[0] || null;
            },
            querySelectorAll(sel) {
                const out = [];
                const parts = sel.split(',').map((s) => s.trim());
                const matchNode = (ch) => {
                    for (const s of parts) {
                        if (s.startsWith('.') && ch.classList?.contains(s.slice(1))) return true;
                        if (s === '[data-linden-container-source="true"]' && ch.getAttribute?.('data-linden-container-source') === 'true') return true;
                        if (s.startsWith('.linden-bilingual-target[data-target-anchor=')) {
                            const m = s.match(/data-target-anchor="([^"]*)"/);
                            const wantAnchor = m ? m[1].replace(/\\/g, '') : '';
                            if (ch.classList?.contains('linden-bilingual-target') && ch.getAttribute?.('data-target-anchor') === wantAnchor) return true;
                        }
                        if (/^[a-z0-9]+$/i.test(s) && ch.tagName === s.toUpperCase()) return true;
                    }
                    return false;
                };
                const walk = (node) => {
                    for (const ch of node.children) {
                        if (matchNode(ch)) out.push(ch);
                        walk(ch);
                    }
                };
                walk(el);
                return out;
            }
        };
        return el;
    }

    const head = makeEl('head');
    const body = makeEl('body');
    const doc = {
        head,
        body,
        defaultView: { getComputedStyle: () => ({ textAlign: 'left' }) },
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => [head, body].flatMap((root) => root.querySelectorAll('.linden-style-el')).find((n) => n.getAttribute('id') === id) || null,
        querySelector: (sel) => doc.body.querySelector(sel),
        querySelectorAll: (sel) => doc.body.querySelectorAll(sel)
    };
    const originalGetById = doc.getElementById;
    doc.getElementById = (id) => {
        for (const root of [head, body]) {
            const stack = [...root.children];
            while (stack.length) {
                const n = stack.shift();
                if (n.getAttribute?.('id') === id) return n;
                stack.push(...n.children);
            }
        }
        return originalGetById ? null : null;
    };

    const ol = makeEl('ol');
    const li = makeEl('li', 'First list item with enough characters');
    const tr = makeEl('tr');
    const td = makeEl('td', 'Table cell content with enough characters');
    ol.appendChild(li);
    tr.appendChild(td);
    doc.body.appendChild(ol);
    doc.body.appendChild(tr);

    const mgr = new ChapterTranslationManager({ dom: {}, settings: {} });
    mgr.viewMode = 'bilingual';
    mgr.showBilingualBar = () => {};
    const parasBefore = mgr.extractChapterParagraphs(doc, true);
    assert.equal(parasBefore.length, 2);

    const record = {
        paragraphs: [
            { id: parasBefore[0].id, sourceHash: parasBefore[0].sourceHash, translation: '第一条翻译', status: 'completed' },
            { id: parasBefore[1].id, sourceHash: parasBefore[1].sourceHash, translation: '单元格翻译', status: 'completed' }
        ]
    };
    mgr.renderDerivedBilingualView(record, doc);

    assert.equal(ol.children.length, 1, 'ol must still have only the original li child');
    assert.equal(tr.children.length, 1, 'tr must still have only the original td child');
    assert.equal(li.getAttribute('data-linden-container-source'), 'true');
    assert.equal(td.getAttribute('data-linden-container-source'), 'true');
    assert.equal(li.querySelectorAll('.linden-bilingual-target').length, 1);
    assert.equal(td.querySelectorAll('.linden-bilingual-target').length, 1);

    // Re-extracting while inline targets sit inside td/li must preserve source text and hashes
    const parasAfter = mgr.extractChapterParagraphs(doc, true);
    assert.equal(parasAfter.length, 2);
    assert.equal(parasAfter[0].sourceHash, parasBefore[0].sourceHash);
    assert.equal(parasAfter[1].sourceHash, parasBefore[1].sourceHash);

    mgr.removeDerivedBilingualView(doc);
    assert.equal(li.querySelectorAll('.linden-bilingual-target').length, 0);
    assert.equal(td.querySelectorAll('.linden-bilingual-target').length, 0);
    assert.equal(li.getAttribute('data-linden-container-source'), null);
});

await test('3-Search & 2A-TTS: App closeReader unconditionally stops TTS and navigateReaderToLocation handles query/sectionIndex payloads', async () => {
    const appPath = path.join(rootDir, 'js', 'app.js');
    const appSource = fs.readFileSync(appPath, 'utf8');
    assert.ok(!appSource.includes("ttsPlayer.state !== 'playing' && ttsPlayer.state !== 'paused'"), 'Inverted TTS stop check must not exist');

    const app = Object.create(UniversalReaderApp.prototype);
    let stopped = 0;
    let wentSection = null;
    app.ttsPlayer = { state: 'loading', stop() { stopped++; this.state = 'idle'; } };
    app.foliateView = {
        goTo(target) { wentSection = target; return Promise.resolve(); },
        renderer: { goTo: () => Promise.resolve() }
    };
    app.bookLocationHistory = null;
    app.currentBookId = null;
    app.currentBookFormat = 'epub';
    app.dom = { readerView: { classList: makeClassList(['is-pdf-mode']), removeAttribute() {} }, bookshelfView: { style: {} } };
    app.closeBookViewCommonCleanup?.();
    await app.navigateReaderToLocation({ sectionIndex: 4, href: 'ch4.xhtml', query: 'needle' });
    assert.equal(wentSection !== null, true);
});

await test('4-Export: AnnotationsDrawerController.exportShelfNotesToMarkdown groups by bookId and omits invalid createdAt dates', async () => {
    const ctrl = new AnnotationsDrawerController({ dialogs: { showToast() {} } });
    ctrl._shelfBookMap = new Map([
        ['b1', { id: 'b1', title: 'Same Title' }],
        ['b2', { id: 'b2', title: 'Same Title' }]
    ]);
    ctrl._shelfFilteredNotes = [
        { bookId: 'b1', bookTitle: 'Same Title', text: 'First book quote', note: 'Note 1', createdAt: undefined },
        { bookId: 'b2', bookTitle: 'Same Title', text: 'Second book quote', note: '', createdAt: 'not-a-date' }
    ];
    let exportedMd = '';
    const origExport = platformBridge.exportTextFile;
    platformBridge.exportTextFile = async (_filename, content) => {
        exportedMd = content;
        return { cancelled: true };
    };
    try {
        await ctrl.exportShelfNotesToMarkdown();
    } finally {
        platformBridge.exportTextFile = origExport;
    }
    assert.ok(exportedMd.includes('First book quote'));
    assert.ok(exportedMd.includes('Second book quote'));
    assert.equal(exportedMd.match(/^## Same Title$/gm)?.length, 2, 'Two distinct bookIds sharing a title must remain separate sections');
    assert.ok(!exportedMd.includes('Invalid Date'), `Exported markdown must not contain Invalid Date:\n${exportedMd}`);
});

await test('3-View: View.setActiveSearchMatch uses Overlayer fallback and clearSearch cleans up marker', async () => {
    const view = new View();
    const added = [];
    const removed = [];
    const overlayer = {
        add(val, range, draw, opts) { added.push({ val, range, draw, opts }); },
        remove(val) { removed.push(val); }
    };
    const fakeDoc = { defaultView: {} };
    view.renderer = {
        getContents: () => [{ index: 0, doc: fakeDoc, overlayer }]
    };
    view.resolveNavigation = async () => ({
        index: 0,
        anchor: () => ({ collapsed: false })
    });

    await view.setActiveSearchMatch('epubcfi(/6/2!/4/2)');
    assert.equal(added.length, 1);
    assert.equal(added[0].val, 'foliate-search-active:epubcfi(/6/2!/4/2)');

    view.clearSearch();
    assert.ok(removed.includes('foliate-search-active:epubcfi(/6/2!/4/2)'), 'clearSearch must remove Overlayer active marker');
});

await test('4-Stats: StatsViewController segmented tab switch resets stale year/month/weekOffset', () => {
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
        const stats = new StatsViewController({ appearance: { dom: {} }, settings: {} });
        assert.equal(stats.statsViewMode, 'month');
        assert.equal(typeof stats.renderStatsDashboard, 'function');
        stats.renderStatsDashboard = () => {};
        const makeBtn = (mode) => {
            const listeners = {};
            return {
                dataset: { mode },
                classList: makeClassList(mode === 'month' ? ['active'] : []),
                addEventListener: (ev, fn) => { listeners[ev] = fn; },
                removeEventListener: (ev) => { delete listeners[ev]; },
                click: () => listeners.click?.({ target: null })
            };
        };
        const btnMonth = makeBtn('month');
        const btnWeek = makeBtn('week');
        stats.dom = { statsSegmentedTabs: [btnMonth, btnWeek] };
        stats.bindEvents();
        stats.statsYear = 2021;
        stats.statsMonth = 2;
        stats.statsWeekOffset = -3;
        btnWeek.click();
        assert.equal(stats.statsViewMode, 'week');
        assert.equal(stats.statsYear, new Date().getFullYear());
        assert.equal(stats.statsMonth, new Date().getMonth() + 1);
        assert.equal(stats.statsWeekOffset, 0);
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

await test('1C & 4-CSS: desktop-ui.css guards >=768px reader rules with html:not(.is-mobile-viewport) and locks zero-reflow vars; mobile-shell.css widens chart Y axis', () => {
    const desktopCss = fs.readFileSync(path.join(rootDir, 'css', 'desktop-ui.css'), 'utf8');
    assert.ok(desktopCss.includes('--reader-bar-top: 42px'), 'missing --reader-bar-top: 42px');
    assert.ok(desktopCss.includes('--reader-bar-bottom: 38px'), 'missing --reader-bar-bottom: 38px');
    assert.ok(desktopCss.includes('html:not(.is-mobile-viewport) #reader-view'), 'missing tablet isolation selector');
    assert.ok(!desktopCss.match(/^(?!.*not\(\.is-mobile-viewport\))\s*#reader-view\b/m), 'Found unguarded desktop #reader-view rule');

    const mobileCss = fs.readFileSync(path.join(rootDir, 'css', 'mobile-shell.css'), 'utf8');
    assert.ok(mobileCss.includes('3.45rem'), 'missing widened mobile chart Y axis gutter');
    assert.ok(mobileCss.includes('#quote-card-dialog'), 'missing mobile quote-card responsive styling');
});

console.log(`Reader UX fix tests: ${passed} passed.`);
