// scripts/verify-all-p1-repairs.mjs
// Regression test suite verifying that all 10 P1 defects from audit-2026-09-26.mjs are completely resolved.
// Run: node --experimental-vm-modules scripts/verify-all-p1-repairs.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = 'D:/LindenLeaf-Dev/astra-mupdf-core/';
const read = p => fs.readFileSync(root + p, 'utf8');
const ctxFns = await import('file:///' + root + 'js/ai-context.js');
const ft = await import('file:///' + root + 'js/fulltext-search.js');
const foliateSearch = await import('file:///' + root + 'foliate-js-main/search.js');

const noop = () => {};
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};

async function loadInjected(path, dependencies) {
  const source = read(path);
  const mod = new vm.SourceTextModule(source, { identifier: root + path });
  await mod.link(async specifier => {
    const obj = dependencies[specifier] || (specifier.includes('translation-job-core') ? await import('file:///' + root + 'js/translation-job-core.js') : null);
    if (!obj) throw new Error('Unexpected dependency: ' + specifier);
    const names = Object.keys(obj);
    return new vm.SyntheticModule(names, function() {
      for (const n of names) this.setExport(n, obj[n]);
    });
  });
  await mod.evaluate();
  return mod.namespace;
}

console.log('--- STARTING VERIFICATION OF ALL P1 REPAIRS ---');

// =========================================================================
// 1. AI_ZERO_BUDGET_STILL_SENDS & AI_CHAT_NO_HISTORY
// =========================================================================
const aiSource = read('js/ai-sidebar-controller.js');
const deps = {};
for (const match of aiSource.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)) {
  deps[match[2]] = Object.fromEntries(match[1].split(',').map(x => x.trim()).filter(Boolean).map(n => [n, noop]));
}
const payloads = [];
const savedMessages = [];
Object.assign(deps['./ai-context.js'], ctxFns);
Object.assign(deps['./reading-ai-assistant.js'], {
  isAiReady: async () => true,
  getAiConfig: () => ({ maxTokens: 2048 }),
  requestAiCompletion: async p => {
    payloads.push(structuredClone(p.messages));
    return 'FAKE ANSWER: prior-answer-marker';
  },
  renderSafeMarkdown: s => s,
  escapeUntrustedHtml: s => s
});
Object.assign(deps['./db.js'], {
  saveAiMessage: async m => {
    savedMessages.push(structuredClone(m));
    return true;
  },
  getAiMessages: async () => savedMessages
});

const { AiSidebarController } = await loadInjected('js/ai-sidebar-controller.js', deps);
const controller = () => Object.assign(Object.create(AiSidebarController.prototype), {
  app: { advancedSettings: { aiContextTokenBudget: 1000 }, showToast: noop },
  dom: { aiChkIncludeContext: { checked: true } },
  currentConversation: { id: 'audit-conv', bookId: 'A' },
  isGenerating: false,
  remainingCooldown: 0,
  ensureActiveConversation: async () => {},
  appendMessageToUI: () => null,
  renderPendingReference: noop,
  renderContextPreview: noop,
  scrollToBottom: noop,
  startCooldownCountdown: noop,
  clearCooldown: noop
});

const c = controller();
c.currentReference = { bookId: 'A', selectedText: 'QUOTE' };
c.currentContext = { contextText: 'EXTRA_CONTEXT_SHOULD_NOT_LEAVE_DEVICE', tokenCount: 10, tokenBudget: 1000 };
c.app.advancedSettings.aiContextTokenBudget = 0;

await c.dispatchAiTurn({ promptText: 'translate', actionName: 'translation' });

// VERIFY P1-08: Zero budget must NOT leak context into payload
assert.equal(
  payloads[0][0].content.includes('EXTRA_CONTEXT_SHOULD_NOT_LEAVE_DEVICE'),
  false,
  'P1-08 FAIL: Context text leaked into payload even when aiContextTokenBudget = 0'
);
assert.equal(savedMessages[0].contextReason, '预算为 0');
console.log('PASS: P1-08 AI_ZERO_BUDGET_STILL_SENDS resolved (zero budget suppresses context)');

// VERIFY P1-05: Multi-turn history must be loaded into second dispatch
await c.dispatchAiTurn({ promptText: 'Explain your previous answer', actionName: 'followup' });
assert.ok(payloads[1].length > 1, 'P1-05 FAIL: Second turn has no conversation history');
assert.ok(
  payloads[1].some(m => m.role === 'assistant' && m.content.includes('prior-answer-marker')),
  'P1-05 FAIL: Prior assistant answer was not passed into second turn payload'
);
console.log('PASS: P1-05 AI_CHAT_NO_HISTORY resolved (multi-turn conversation history included)');

// =========================================================================
// 2. AI_NESTED_READER_CONTEXT_NOT_READ
// =========================================================================
let rendererReadCount = 0;
const nested = controller();
nested.app.foliateView = {
  shadowRoot: { querySelector: () => null },
  querySelector: () => null,
  renderer: {
    getContents: () => {
      rendererReadCount++;
      return [{ index: 0, doc: { body: { innerText: 'before QUOTE after' } } }];
    }
  }
};
const contextResult = nested.extractContextForSelection({ text: 'QUOTE', cfi: 'epubcfi(test)' });
assert.ok(rendererReadCount > 0, 'FAIL: extractContextForSelection did not read renderer.getContents()');
assert.ok(contextResult.tokenCount > 0, 'FAIL: contextResult tokenCount is 0');
assert.ok(
  contextResult.contextText.includes('before') || contextResult.contextText.includes('after'),
  'FAIL: contextResult does not contain extracted text from nested renderer'
);
console.log('PASS: AI_NESTED_READER_CONTEXT_NOT_READ resolved (nested renderer getContents extracted)');

// =========================================================================
// 3. SYNC_CONCURRENT_EDIT and SYNC_CONCURRENT_DELETE
// =========================================================================
await import('file:///' + root + 'scripts/test-idb-setup.mjs');
const realDb = await import('file:///' + root + 'js/db.js');

for (const mode of ['edit', 'delete']) {
  const id = 'sync-verify-' + mode;
  await realDb.saveBook({ id, title: 'A', tags: ['old'], tagsUpdatedAt: 100, totalReadingSeconds: 0 });
  const db = {
    ...realDb,
    getAllBooks: async () => structuredClone(await realDb.getAllBooks()),
    saveCustomList: async () => {
      if (mode === 'edit') {
        await realDb.saveBook({ id, tags: ['USER_LATEST'], tagsUpdatedAt: 300 });
      } else {
        await realDb.deleteBook(id, true, 300);
        assert.equal(await realDb.getBook(id), null);
        assert.ok((await realDb.getAllDeletedRecords()).some(x => x.id === id));
      }
    }
  };
  const sync = await loadInjected('js/syncEngine.js', { './db.js': db });
  await sync.applyMergedPayload({
    customLists: [{ id: 'barrier' }],
    booksMeta: [{ id, title: 'A', tags: ['REMOTE_OLDER'], tagsUpdatedAt: 200 }],
    clientId: 'remote'
  });

  const live = await realDb.getBook(id);
  const tombstone = (await realDb.getAllDeletedRecords()).some(x => x.id === id);

  if (mode === 'edit') {
    assert.deepEqual(live.tags, ['USER_LATEST'], 'P1-01 FAIL: Local edit tags were clobbered by remote older payload');
    console.log('PASS: P1-01 SYNC_CONCURRENT_EDIT resolved (local user edit 300 beats remote 200)');
  } else {
    assert.equal(live, null, 'P1-01 FAIL: Deleted book was resurrected by sync');
    assert.equal(tombstone, true, 'P1-01 FAIL: Tombstone was wiped by sync');
    console.log('PASS: P1-01 SYNC_CONCURRENT_DELETE resolved (deleted book not resurrected, tombstone kept)');
  }
}

// =========================================================================
// 4. AI_NOTE_WRONG_CONTENT_IDENTITY
// =========================================================================
const appSource = read('js/app.js');
const method = appSource.slice(appSource.indexOf('    async createHighlight('), appSource.indexOf('    async updateHighlightColor('));
const highlights = [];
const createHighlight = new Function('db', 'return ({' + method + '}).createHighlight')({
  getHighlightsByBook: async () => [],
  saveHighlight: async h => highlights.push(h)
});
const testApp = {
  _activeSession: { bookId: 'B', isCurrent: () => true },
  _currentSnapshot: { blobRevision: 'B-revision', revisionOrigin: 'B-origin' },
  currentBookId: 'B',
  loadNotesList: noop,
  showToast: noop,
  hideSelectionPopup: noop
};
await createHighlight.call(testApp, '#3b82f6', 'highlight', 'AI answer', {
  bookId: 'A',
  cfi: 'CFI_FROM_A',
  selectedText: 'ORIGINAL_A'
});

assert.equal(highlights[0].bookId, 'A');
assert.equal(highlights[0].text, 'ORIGINAL_A', 'P1-04 FAIL: Original quote text became blank');
assert.notEqual(highlights[0].blobRevision, 'B-revision', 'P1-04 FAIL: Highlight borrowed foreign book blobRevision');
console.log('PASS: P1-04 AI_NOTE_WRONG_CONTENT_IDENTITY resolved (quote text and book identity preserved)');

// =========================================================================
// 5. SEARCH_ORDINAL_MISMATCH
// =========================================================================
const body = '惨痛 FIRST BODY MATCH。惨痛 SECOND BODY MATCH。';
const clean = ft.extractCleanTextFromHtml('<html><head><title>惨痛</title></head><body><p>' + body + '</p></body></html>');
const engine = new ft.FullTextSearchEngine({ db: {} });
engine.index.set('A', {
  meta: { title: 'A', format: 'epub' },
  sections: [{ sectionTitle: 'test', text: clean, location: { sectionIndex: 0 }, tokens: ft.tokenizeText(clean) }]
});
const hits = engine.search('惨痛');
const actual = [...foliateSearch.search([body], '惨痛')];

assert.equal(hits.length, 2, 'P1-06 FAIL: Search index polluted by title/head tag');
assert.equal(actual.length, 2);
assert.equal(hits.length, actual.length, 'P1-06 FAIL: Ordinal count mismatch between index and reader');
console.log('PASS: P1-06 SEARCH_ORDINAL_MISMATCH resolved (body-only indexing aligns with Foliate search)');

// =========================================================================
// 6. FIXED_LAYOUT_FALSE_FAILURE
// =========================================================================
const fxlSrc = read('foliate-js-main/fixed-layout.js');
const fxlMethod = fxlSrc.slice(fxlSrc.indexOf('    async goTo(target) {'), fxlSrc.indexOf('    async next() {'));
const fxlGoTo = new Function('return ({' + fxlMethod + '}).goTo')();
let reached = false;
const renderer = {
  book: { sections: [{}] },
  getSpreadOf: () => ({ index: 0, side: 'center' }),
  goToSpread: async () => { reached = true; },
  goTo: fxlGoTo
};
const viewSrc = read('foliate-js-main/view.js');
const viewMethod = viewSrc.slice(viewSrc.indexOf('    async goTo(target) {'), viewSrc.indexOf('    async goToFraction('));
const viewGoTo = new Function('return ({' + viewMethod + '}).goTo')();
let pushes = 0;
const nav = await viewGoTo.call({
  resolveNavigation: () => ({ index: 0 }),
  renderer,
  history: { pushState: () => pushes++ }
}, 0);

assert.equal(reached, true);
assert.notEqual(nav, null, 'P1-09 FAIL: view.goTo returned null on successful fixed-layout navigation');
assert.equal(pushes, 1, 'P1-09 FAIL: history.pushState was not called on successful fixed-layout navigation');
console.log('PASS: FIXED_LAYOUT_FALSE_FAILURE resolved (fixed-layout returns true, view records history)');

// =========================================================================
// 7. PDF_SINGLE_WORD_SELECTION_CLEARED
// =========================================================================
const callbackStart = appSource.indexOf('                    onSelection: (selInfo) => {');
const callbackEnd = appSource.indexOf('                    onHighlightCreate:', callbackStart);
const callbackSource = appSource.slice(callbackStart, callbackEnd);
const pdfApp = {
  dom: {},
  hideHighlightActionPopup: noop,
  showSelectionPopup: noop,
  hideDictionaryCard: noop
};
let forwarded = 'not-called';
pdfApp.showDictionaryCard = arg => { forwarded = arg; };
const hideMethod = appSource.slice(appSource.indexOf('    hideSelectionPopup('), appSource.indexOf('    showHighlightActionPopup('));
pdfApp.hideSelectionPopup = new Function('return ({' + hideMethod + '}).hideSelectionPopup')();
const cb = new Function('readerSession', 'return ({' + callbackSource + '}).onSelection').call(pdfApp, { isCurrent: () => true });
cb({ text: 'Hello', page: 0, rects: [], clientRect: {} });

assert.notEqual(forwarded, null, 'P1-07 FAIL: Word snapshot was cleared before dictionary received it');
assert.equal(forwarded.text, 'Hello', 'P1-07 FAIL: Word text not preserved');
console.log('PASS: P1-07 PDF_SINGLE_WORD_SELECTION_CLEARED resolved (word preserved for dictionary)');

// =========================================================================
// 8. AI_LIMIT_CONFIG_SPLIT
// =========================================================================
const { AdvancedSettingsManager } = await import('file:///' + root + 'js/advanced-settings.js');
const { saveAiConfig } = await import('file:///' + root + 'js/reading-ai-assistant.js');
store.set('linden_advanced_settings_config', JSON.stringify({ aiDailyLimit: 1, aiCooldownSeconds: 30 }));
const nativeCalls = [];
globalThis.__TAURI__ = {
  core: {
    invoke: async (name, args) => {
      nativeCalls.push({ name, args });
      return true;
    }
  }
};
const mgr = new AdvancedSettingsManager();
mgr.bindUI({});
assert.equal(mgr.config.aiDailyLimit, 1);
assert.ok(nativeCalls.length > 0, 'P1-03 FAIL: bindUI did not sync native limits on startup');
assert.equal(nativeCalls[0].args.dailyLimit, 1);
assert.equal(nativeCalls[0].args.cooldownSeconds, 30);

await saveAiConfig({ model: 'FAKE-NO-NETWORK' });
const lastCall = nativeCalls[nativeCalls.length - 1];
assert.equal(lastCall.args.dailyLimit, 1, 'P1-03 FAIL: saveAiConfig clobbered dailyLimit back to 100');
assert.equal(lastCall.args.cooldownSeconds, 30, 'P1-03 FAIL: saveAiConfig clobbered cooldownSeconds back to 10');
console.log('PASS: P1-03 AI_LIMIT_CONFIG_SPLIT resolved (single source of truth for AI limits)');
delete globalThis.__TAURI__;

console.log('\n======================================================');
console.log('ALL P1 DEFECT REGRESSION TESTS PASSED CLEANLY (10/10)!');
console.log('======================================================');
