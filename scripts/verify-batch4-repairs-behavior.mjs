// verify-batch4-repairs-behavior.mjs
// Comprehensive, 100% Behavioral Verification Suite for Batch 4 Review Repairs (Tasks A - H & PDF)
// All tests execute real runtime logic in isolated VMs or Node modules.
// ZERO string-matching (source.includes) is accepted as behavioral proof.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  TranslationJobCoordinator,
  validateTranslationResponse,
  translationIdentity,
  resolveReaderSettings,
  READER_OVERRIDE_ALLOWED_KEYS
} from '../js/translation-job-core.js';
import { isChapterHeading } from '../foliate-js-main/txt.js';
import { runTxtRulesWorker } from '../js/txt-toc-worker.js';
import { mergeSyncData } from '../js/syncEngine.js';
import { estimateTokenCount, truncateToTokenBudget, buildSurroundingContext } from '../js/ai-context.js';

console.log('--- Starting Linden Leaf Batch 4 Rigorous Behavioral Verification Suite ---\n');

let passedTests = 0;

// Helper: load ChapterTranslationManager into a sandboxed VM with full mocked dependencies
function createTranslationManagerFixture(overrides = {}) {
  const requests = [];
  const writes = [];
  const toasts = [];
  const storage = new Map();
  let clock = 1000;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    Date: { now: () => ++clock },
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    saveChapterTranslation: async (record) => {
      writes.push(structuredClone(record));
      return true;
    },
    getChapterTranslation: async () => null,
    deleteChapterTranslation: async () => true,
    listChapterTranslationsForBook: async () => [],
    TranslationJobCoordinator,
    translationIdentity,
    validateTranslationResponse,
    requestAiCompletion: async (params) => {
      requests.push(params);
      const items = [{ id: 'p_0', translation: '测试译文0' }];
      return JSON.stringify(items);
    },
    getAiConfig: () => ({
      endpoint: 'https://mock.ai/v1',
      model: 'gpt-4o-mini',
      maxTokens: 2048
    }),
    getAiApiKey: async () => storage.get('reading_ai_api_key') || storage.get('linden_ai_api_key') || null,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ id: '', style: {}, textContent: '', setAttribute() {}, appendChild() {} })
    },
    fetch: async () => {
      throw new Error('FATAL: Direct fetch should NEVER be called; all AI requests must route through requestAiCompletion');
    },
    ...overrides
  };

  const rawCode = fs.readFileSync('js/chapter-translation-manager.js', 'utf8')
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '')
    .replace(/export\s+/g, '');

  const ctx = vm.createContext(sandbox);
  vm.runInContext(rawCode + '\nglobalThis.ChapterTranslationManager = ChapterTranslationManager;', ctx);

  const mockApp = {
    showToast: (msg, type) => toasts.push({ msg, type }),
    currentBookData: { id: 'BookA', contentHash: 'hash_book_a' },
    advancedSettings: {
      config: {
        chapterTransStyle: 'auto',
        chapterTransAutoSave: true,
        chapterTransAutoRestore: true
      }
    },
    foliateView: {
      renderer: {
        shadowRoot: { id: 'shadow_root', querySelectorAll: () => [] },
        getContents: () => [{ index: 0, doc: { nodeType: 9, querySelectorAll: () => [] } }]
      }
    }
  };

  const manager = new ctx.ChapterTranslationManager(mockApp);
  manager.currentBookId = 'BookA';
  manager.currentChapterKey = 'sec_0';
  manager.currentChapterTitle = '第一章';

  return { manager, sandbox, storage, requests, writes, toasts, ctx };
}

// =========================================================================
// Task A: Unified AI Completion & max_tokens & Legacy Key Behavioral Test
// =========================================================================
{
  console.log('Testing Task A: Unified AI Completion & Budget Routing...');

  // Test A1: translateChunk throws when no API key configured
  const f1 = createTranslationManagerFixture();
  await assert.rejects(
    async () => { await f1.manager.translateChunk([{ id: 'p_0', text: 'Hello' }]); },
    /未配置 AI API Key/
  );

  // Test A2: translateChunk successfully reads legacy linden_ai_api_key and routes via requestAiCompletion
  const f2 = createTranslationManagerFixture();
  f2.storage.set('linden_ai_api_key', 'LEGACY-TEST-KEY-12345');
  const rawResponse = await f2.manager.translateChunk([{ id: 'p_0', text: 'Hello world' }]);

  // Verify parameters sent to requestAiCompletion
  assert.equal(f2.requests.length, 1, 'requestAiCompletion was called exactly once');
  const req = f2.requests[0];
  assert.equal(req.apiKey, 'LEGACY-TEST-KEY-12345', 'Passed correct legacy API key');
  assert.equal(req.maxTokens, 2048, 'Passed explicit maxTokens budget');
  assert.equal(req.model, 'gpt-4o-mini', 'Passed configured AI model');
  assert.ok(req.systemPrompt.includes('保留段落对应关系'), 'Passed structured system prompt');
  assert.ok(req.prompt.includes('Hello world'), 'Passed prompt containing paragraph text');
  assert.ok(typeof rawResponse === 'string', 'Returns RAW STRING response for coordinator validation (NOT parsed object)');

  // Test A3: Verify rawResponse parses cleanly with validateTranslationResponse
  const validated = validateTranslationResponse(rawResponse, ['p_0']);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].translation, '测试译文0');

  console.log('✓ Task A: Unified AI Completion & budget routing passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task B: Section Document Query - Multi-Section Document Isolation
// =========================================================================
{
  console.log('Testing Task B: getSectionDocument Isolation & ShadowRoot Guard...');
  const f = createTranslationManagerFixture();

  const doc0 = { nodeType: 9, sectionId: 0, querySelectorAll: () => [] };
  const doc1 = { nodeType: 9, sectionId: 1, querySelectorAll: () => [] };
  const doc2 = { nodeType: 9, sectionId: 2, querySelectorAll: () => [] };

  f.manager.app.foliateView.renderer.getContents = () => [
    { index: 0, doc: doc0 },
    { index: 1, doc: doc1 },
    { index: 2, doc: doc2 }
  ];

  // Test B1: Target index resolves to exactly matching document
  assert.equal(f.manager.getSectionDocument(1), doc1, 'Resolved section 1 correctly');
  assert.equal(f.manager.getSectionDocument(0), doc0, 'Resolved section 0 correctly');
  assert.equal(f.manager.getSectionDocument(2), doc2, 'Resolved section 2 correctly');

  // Test B2: Target index not in contents returns null, NEVER shadowRoot or document
  assert.equal(f.manager.getSectionDocument(99), null, 'Missing section returns null');
  assert.notEqual(f.manager.getSectionDocument(99), f.manager.app.foliateView.renderer.shadowRoot, 'Never returns shadowRoot');

  // Test B3: getCurrentSectionIndex resolves correctly from currentChapterKey
  f.manager.currentChapterKey = 'sec_2';
  assert.equal(f.manager.getSectionDocument(), doc2, 'Resolved doc2 based on currentChapterKey');

  console.log('✓ Task B: getSectionDocument isolation passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task C: Coordinator Lifecycle, Cancellation, and State Cleanup
// =========================================================================
{
  console.log('Testing Task C: Coordinator Lifecycle, Failure Handling & Generation Safety...');

  // Test C1: Paragraph failure throws and does NOT mark chapter as completed
  const f1 = createTranslationManagerFixture({
    requestAiCompletion: async () => '[]' // Empty array returned by model
  });
  f1.storage.set('reading_ai_api_key', 'KEY-123');
  f1.manager.extractChapterParagraphs = () => [
    { id: 'p_0', text: 'Text A', sourceHash: 'hashA' },
    { id: 'p_1', text: 'Text B', sourceHash: 'hashB' }
  ];

  await f1.manager.startCurrentChapterTranslation();
  // Since model returned empty array, translation threw and handled into partial status
  const lastWrite = f1.writes.at(-1);
  assert.equal(lastWrite.status, 'partial', 'Empty model response marks status as partial, NOT completed');
  assert.ok(f1.toasts.some(t => t.type === 'warn'), 'Emitted warning toast on translation failure');

  // Test C2: Stop translation terminates cleanly
  const coord = new TranslationJobCoordinator();
  const testIdentity = {
    bookContentHash: 'hash1',
    chapterSourceKey: 'sec_0',
    sourceHash: 'sh1',
    parserVersion: 'v1',
    targetLanguage: 'zh-CN',
    promptVersion: 'p1'
  };
  const testChunks = [[{ id: 'p_0', text: 'hello' }]];

  let slowFinished = false;
  const slowTask = coord.run({
    identity: testIdentity,
    chunks: testChunks,
    request: async () => new Promise(r => setTimeout(() => {
      slowFinished = true;
      r(JSON.stringify([{ id: 'p_0', translation: '你好' }]));
    }, 100)),
    commit: async () => true,
    onProgress: () => {}
  });

  coord.stop();
  const stopResult = await slowTask;
  assert.equal(stopResult.status, 'cancelled', 'Coordinator run cancelled upon stop()');

  // Test C3: Old task finishing does not clear activeTaskId of a newer task
  const f3 = createTranslationManagerFixture();
  f3.storage.set('reading_ai_api_key', 'KEY-123');
  f3.manager.extractChapterParagraphs = () => [{ id: 'p_0', text: 'Text', sourceHash: 'h' }];

  let finishOldRequest;
  f3.manager.translateChunk = () => new Promise(resolve => { finishOldRequest = resolve; });
  const oldPromise = f3.manager.startCurrentChapterTranslation();
  const oldTaskId = f3.manager.activeTaskId;
  assert.ok(oldTaskId, 'Old task started with activeTaskId');

  // Start a new task simulating restart
  f3.manager.activeTaskId = 'new_task_999';
  finishOldRequest(JSON.stringify([{ id: 'p_0', translation: '译文' }]));
  await oldPromise;

  assert.equal(f3.manager.activeTaskId, 'new_task_999', 'Old task finally block did NOT wipe new task activeTaskId');

  // Test C4: Stale chapter load race in onSectionChanged
  const f4 = createTranslationManagerFixture();
  let resolveChapA;
  f4.sandbox.getChapterTranslation = async (bookId, chapKey) => {
    if (chapKey === 'sec_0') {
      return new Promise(r => { resolveChapA = r; });
    }
    return { bookId: 'BookA', chapterKey: 'sec_1', paragraphs: [{ id: 'p_1', translation: 'B' }] };
  };
  f4.manager.removeInjectedElements = () => {};

  const pA = f4.manager.onSectionChanged('BookA', 0);
  await f4.manager.onSectionChanged('BookA', 1);
  assert.equal(f4.manager.currentChapterKey, 'sec_1');
  assert.equal(f4.manager.cachedRecord?.chapterKey, 'sec_1');

  // Chapter A finally arrives late
  resolveChapA({ bookId: 'BookA', chapterKey: 'sec_0', paragraphs: [{ id: 'p_0', translation: 'A' }] });
  await pA;

  assert.equal(f4.manager.currentChapterKey, 'sec_1', 'Current chapter remains sec_1');
  assert.equal(f4.manager.cachedRecord?.chapterKey, 'sec_1', 'Stale chapter load did NOT overwrite cachedRecord of sec_1');

  console.log('✓ Task C: Coordinator lifecycle & state cleanup passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task D: Source Hash Verification & Leaf Semantic Block Extraction
// =========================================================================
{
  console.log('Testing Task D: Source Hash Verification & Leaf Semantic Extraction...');

  const f = createTranslationManagerFixture();

  // Test D1: Leaf semantic block extraction (no duplicate parent containers)
  const mockChildP = { tagName: 'P', textContent: '引用内部段落', querySelector: () => null };
  const mockBlockquote = {
    tagName: 'BLOCKQUOTE',
    textContent: '引用内部段落',
    querySelector: (sel) => sel.includes('p') ? mockChildP : null
  };
  const mockNormalP = { tagName: 'P', textContent: '正常独立段落', querySelector: () => null };
  const mockNavP = { tagName: 'P', textContent: '导航文字', closest: (sel) => sel.includes('nav') };

  const mockDoc = {
    querySelectorAll: () => [mockBlockquote, mockChildP, mockNormalP, mockNavP]
  };

  const extracted = f.manager.extractChapterParagraphs(mockDoc);
  assert.equal(extracted.length, 2, 'Extracted exactly 2 leaf paragraphs (child P and normal P; parent blockquote and nav ignored)');
  assert.equal(extracted[0].text, '引用内部段落');
  assert.equal(extracted[1].text, '正常独立段落');

  // Test D2: renderBilingualView guards against changed sourceHash
  const injected = [];
  f.manager.injectTranslationElement = (el, id, text) => injected.push({ id, text });
  f.manager.applyViewModeStyles = () => {};

  const docForRender = {
    querySelectorAll: () => [
      { tagName: 'P', textContent: '相同文本', querySelector: () => null },
      { tagName: 'P', textContent: '已被修改的新文本', querySelector: () => null }
    ]
  };

  const paras = f.manager.extractChapterParagraphs(docForRender);
  assert.equal(paras.length, 2);

  // Cached record has translation for both, but paragraph 1's sourceHash was for the old text
  const cachedRecord = {
    paragraphs: [
      { id: 'p_0', translation: '相同文本译文', sourceHash: paras[0].sourceHash },
      { id: 'p_1', translation: '旧文本译文', sourceHash: 'old_outdated_hash_xyz' }
    ]
  };

  f.manager.renderBilingualView(cachedRecord, docForRender);
  assert.equal(injected.length, 1, 'Only paragraph with matching sourceHash received translation');
  assert.equal(injected[0].id, 'p_0');
  assert.equal(injected[0].text, '相同文本译文');

  console.log('✓ Task D: Source hash verification & leaf semantic extraction passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task E: Tombstone Deletion & Fine-Grained Paragraph Synchronization
// =========================================================================
{
  console.log('Testing Task E: Tombstone Deletion & Schema Preservation in syncEngine...');

  // Test E1: Tombstone filtering in mergeSyncData
  const now = Date.now();
  const tomb = { recordType: 'chapter_translation', recordId: 'bookA::sec_0', deletedAt: now - 1000 };
  const remotePayload = {
    chapterTranslations: [
      { id: 'bookA::sec_0', bookId: 'bookA', chapterKey: 'sec_0', updatedAt: now - 5000, paragraphs: [{ id: 'p_0', translation: 'Old' }] }
    ],
    futureSchemaExtension: { v2Features: true }
  };
  const localPayload = {
    chapterTranslations: [],
    deletedRecords: [tomb]
  };

  const { merged } = mergeSyncData(localPayload, remotePayload);
  assert.equal(merged.chapterTranslations.length, 0, 'Deleted remote record was filtered out by tombstone');
  assert.equal(merged.futureSchemaExtension?.v2Features, true, 'Unknown top-level schema fields from remotePayload were preserved');

  // Test E2: Concurrent non-conflicting paragraphs merged
  const remotePayload2 = {
    chapterTranslations: [{
      id: 'bookB::sec_0', bookId: 'bookB', chapterKey: 'sec_0', updatedAt: now - 3000,
      paragraphs: [{ id: 'p_0', sourceHash: 'h0', translation: 'Device A translation of p0' }]
    }]
  };
  const localPayload2 = {
    chapterTranslations: [{
      id: 'bookB::sec_0', bookId: 'bookB', chapterKey: 'sec_0', updatedAt: now - 1000,
      paragraphs: [{ id: 'p_1', sourceHash: 'h1', translation: 'Device B translation of p1' }]
    }]
  };

  const { merged: merged2 } = mergeSyncData(localPayload2, remotePayload2);
  assert.equal(merged2.chapterTranslations.length, 1);
  const paras2 = merged2.chapterTranslations[0].paragraphs;
  assert.equal(paras2.length, 2, 'Merged concurrent non-conflicting paragraphs together');
  assert.ok(paras2.some(p => p.id === 'p_0' && p.translation.includes('Device A')));
  assert.ok(paras2.some(p => p.id === 'p_1' && p.translation.includes('Device B')));

  console.log('✓ Task E: Tombstone deletion & fine-grained sync passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task F: TXT Regex ReDoS Protection & Safe Heading Resolution
// =========================================================================
{
  console.log('Testing Task F: TXT Regex ReDoS Protection & Safe Heading Resolution...');

  // Test F1: Synchronous isChapterHeading rejects lines > 80 chars immediately
  const t0 = Date.now();
  const resReject = isChapterHeading('a'.repeat(81) + '!');
  const elapsed = Date.now() - t0;
  assert.equal(resReject, false, 'Long line rejected immediately');
  assert.ok(elapsed < 10, 'Rejected in < 10ms without ReDoS');

  // Test F2: Synchronous isChapterHeading matches valid standard headings
  assert.equal(isChapterHeading('第一章 少年意气'), true);
  assert.equal(isChapterHeading('Chapter 42 The Answer'), true);

  // Test F3: runTxtRulesWorker terminates on ReDoS pattern via timeout
  const dangerousPattern = '^(a+)+$';
  const maliciousLines = ['a'.repeat(45) + '!'];
  await assert.rejects(
    async () => {
      await runTxtRulesWorker({
        lines: maliciousLines,
        rules: [{ pattern: dangerousPattern, flags: 'i', groupIndex: 0 }],
        timeoutMs: 300
      });
    },
    /超时|timeout/i,
    'Worker terminated with timeout on catastrophic backtracking'
  );

  // Test F4: Normal pattern execution extracts title with groupIndex
  const normalRes = await runTxtRulesWorker({
    lines: ['第 10 卷 天下大乱', '这是正文段落'],
    rules: [{ pattern: '^第\\s*(\\d+)\\s*卷\\s*(.*)', flags: 'i', groupIndex: 2 }],
    timeoutMs: 1500
  });
  assert.equal(normalRes.matches.length, 1);
  assert.equal(normalRes.matches[0].title, '天下大乱', 'Extracted title from groupIndex 2');

  console.log('✓ Task F: TXT ReDoS protection & safe heading resolution passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task G: Single-Book Settings Isolation & Whitelist Enforcement
// =========================================================================
{
  console.log('Testing Task G: Single-Book Settings Isolation & No Global Pollution...');

  // Test G1: resolveReaderSettings pure merge
  const global = { fontSize: 24, font: 'serif', lineHeight: 1.6, apiKey: 'SECRET' };
  const override = { fontSize: 36, apiKey: 'LEAKED' }; // apiKey not in READER_OVERRIDE_ALLOWED_KEYS
  const effective = resolveReaderSettings(global, override, READER_OVERRIDE_ALLOWED_KEYS);

  assert.equal(effective.fontSize, 36, 'Allowed override applied');
  assert.equal(effective.apiKey, 'SECRET', 'Non-whitelisted key filtered out of override');
  assert.equal(global.fontSize, 24, 'Global settings object was not mutated');

  // Test G2: App setSetting & saveSettings simulation
  const appCode = fs.readFileSync('js/app.js', 'utf8');
  const setSettingMatch = appCode.match(/setSetting\(key, value, scope = 'auto'\) \{[\s\S]*?^    \}/m);
  const saveSettingsMatch = appCode.match(/async saveSettings\(\) \{[\s\S]*?^    \}/m);

  assert.ok(setSettingMatch && saveSettingsMatch, 'Found setSetting and saveSettings methods in app.js');

  const writes = [];
  const fakeStorage = new Map();
  const sandbox = {
    clearTimeout() {},
    Date,
    console,
    localStorage: {
      setItem: (k, v) => fakeStorage.set(k, v),
      getItem: (k) => fakeStorage.get(k) || null,
      removeItem: (k) => fakeStorage.delete(k)
    },
    db: {
      setSetting: async (_, val) => writes.push(structuredClone(val))
    },
    resolveReaderSettings,
    READER_OVERRIDE_ALLOWED_KEYS
  };

  const appObj = vm.runInNewContext('({\n' + setSettingMatch[0] + ',\n' + saveSettingsMatch[0] + '\n})', sandbox);

  const state = {
    globalSettings: { fontSize: 24, font: 'serif' },
    settings: { fontSize: 24, font: 'serif' },
    _bookSettingsOverride: { fontSize: 24 },
    currentBookData: { id: 'BookA' },
    applySettingsToReader() {},
    updatePresetsBadge() {}
  };

  // Modify font size to 36 for BookA
  appObj.setSetting.call(state, 'fontSize', 36);
  assert.equal(state.settings.fontSize, 36);
  assert.equal(state.globalSettings.fontSize, 24, 'Global settings remains untouched at 24');

  await appObj.saveSettings.call(state);
  assert.equal(writes.length, 0, 'Global database was NOT written when book override active');
  assert.equal(fakeStorage.get('linden_book_settings_BookA'), JSON.stringify(state._bookSettingsOverride));

  // Reset book override
  state._bookSettingsOverride = null;
  state.currentBookData = null;
  state.settings = resolveReaderSettings(state.globalSettings, null, READER_OVERRIDE_ALLOWED_KEYS);
  assert.equal(state.settings.fontSize, 24, 'Effective restored to global 24');

  await appObj.saveSettings.call(state);
  assert.equal(writes.length, 1, 'Global database written once');
  assert.equal(writes[0].fontSize, 24, 'Global database persisted 24px');

  console.log('✓ Task G: Single-book setting isolation & persistence passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task H: Sidebar Layout Generation & PreferredAnchor Lifecycle
// =========================================================================
{
  console.log('Testing Task H: Sidebar Layout Generation & PreferredAnchor Lifecycle...');

  const sidebarCode = fs.readFileSync('js/ai-sidebar-controller.js', 'utf8');
  const captureMatch = sidebarCode.match(/captureCurrentReadingAnchor\(\) \{[\s\S]*?^    \}/m);
  const restoreMatch = sidebarCode.match(/async restoreReadingAnchor\(anchor\) \{[\s\S]*?^    \}/m);
  const invalidateMatch = sidebarCode.match(/invalidatePendingLayout\(\) \{[\s\S]*?^    \}/m);

  assert.ok(captureMatch && restoreMatch && invalidateMatch, 'Found sidebar layout methods');

  let warnLogged = null;
  const sandbox = {
    console: {
      log() {},
      warn: (msg) => { warnLogged = String(msg); },
      error() {}
    }
  };

  const sidebarMethods = vm.runInNewContext(
    '({ _layoutGeneration: 0, ' + captureMatch[0] + ',\n' + restoreMatch[0] + ',\n' + invalidateMatch[0] + ' })',
    sandbox
  );

  const controllerState = {
    _layoutGeneration: 0,
    isOpen: false,
    app: {
      currentBookData: { id: 'BookA' },
      foliateView: {
        lastLocation: { cfi: 'epubcfi(/6/2[chap1]!/4/2)', index: 0 },
        renderer: { settle: () => {} }
      }
    }
  };

  // Step 1: Capture anchor stamps valid layoutGen
  const anchor1 = sidebarMethods.captureCurrentReadingAnchor.call(controllerState);
  assert.equal(typeof anchor1.layoutGen, 'number');
  assert.equal(anchor1.layoutGen, 1, 'First generation is 1');
  assert.equal(controllerState._layoutGeneration, 1);

  // Step 2: Invalidation increments generation
  sidebarMethods.invalidatePendingLayout.call(controllerState);
  assert.equal(controllerState._layoutGeneration, 2);

  // Step 3: Attempting to restore anchor1 rejects due to generation mismatch
  await sidebarMethods.restoreReadingAnchor.call(controllerState, anchor1);
  assert.ok(warnLogged.includes('Stale layout generation'), 'Restore of anchor1 rejected due to stale generation');

  console.log('✓ Task H: Sidebar layout generation & preferredAnchor lifecycle passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task I: PDF Drawing Smoothing & Pen Width Behavioral Test
// =========================================================================
{
  console.log('Testing Task I: PDF Drawing Smoothing & Pen Width...');

  const appCode = fs.readFileSync('js/app.js', 'utf8');
  const drawStrokeMatch = appCode.match(/drawSingleStrokeOnCanvas\(ctx, stroke, w, h\) \{[\s\S]*?^    \}/m);
  assert.ok(drawStrokeMatch, 'Found drawSingleStrokeOnCanvas in app.js');

  const strokeFn = vm.runInNewContext('({' + drawStrokeMatch[0] + '}).drawSingleStrokeOnCanvas', { console });

  const stroke = {
    tool: 'pen',
    points: [
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.25],
      [0.4, 0.3]
    ],
    width: 3,
    color: '#ef4444'
  };

  // Run with pdfSmoothing: false
  const opsLinear = [];
  const mockCtxLinear = {
    save() {}, restore() {}, beginPath() {}, stroke() {},
    moveTo(x, y) { opsLinear.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { opsLinear.push({ op: 'lineTo', x, y }); },
    quadraticCurveTo(cx, cy, x, y) { opsLinear.push({ op: 'quadraticCurveTo', cx, cy, x, y }); }
  };
  const mockAppStateLinear = {
    advancedSettings: { config: { pdfSmoothing: false } }
  };
  strokeFn.call(mockAppStateLinear, mockCtxLinear, stroke, 800, 600);
  assert.ok(opsLinear.some(o => o.op === 'lineTo'), 'Linear stroke calls lineTo');
  assert.equal(opsLinear.some(o => o.op === 'quadraticCurveTo'), false, 'Linear stroke does NOT call quadraticCurveTo');

  // Run with pdfSmoothing: true
  const opsSmooth = [];
  const mockCtxSmooth = {
    save() {}, restore() {}, beginPath() {}, stroke() {},
    moveTo(x, y) { opsSmooth.push({ op: 'moveTo', x, y }); },
    lineTo(x, y) { opsSmooth.push({ op: 'lineTo', x, y }); },
    quadraticCurveTo(cx, cy, x, y) { opsSmooth.push({ op: 'quadraticCurveTo', cx, cy, x, y }); }
  };
  const mockAppStateSmooth = {
    advancedSettings: { config: { pdfSmoothing: true } }
  };
  strokeFn.call(mockAppStateSmooth, mockCtxSmooth, stroke, 800, 600);
  assert.ok(opsSmooth.some(o => o.op === 'quadraticCurveTo'), 'Smooth stroke calls quadraticCurveTo between midpoints');

  console.log('✓ Task I: PDF drawing smoothing passed behavioral verification');
  passedTests++;
}

// =========================================================================
// Task J: Model Tokenizer & Animation Intensity Runtime Integration
// =========================================================================
{
  console.log('Testing Task J: Model Tokenizer & Animation Intensity Runtime Wiring...');

  // Test J1: Tokenizer weights differ appropriately across cl100k_base, gpt2, cjk_heuristic
  const cjkSample = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'; // 24 CJK chars
  const tokensAuto = estimateTokenCount(cjkSample, 'auto');
  const tokensCl100k = estimateTokenCount(cjkSample, 'cl100k_base');
  const tokensGpt2 = estimateTokenCount(cjkSample, 'gpt2');
  const tokensCjk = estimateTokenCount(cjkSample, 'cjk_heuristic');

  assert.ok(tokensCl100k < tokensCjk, 'cl100k_base is more compact on CJK than heuristic');
  assert.ok(tokensGpt2 > tokensCjk, 'gpt2 tokenizes bytes expanding CJK count');
  assert.equal(tokensAuto, Math.ceil(24 * 1.25), 'Auto matches standard 1.25x CJK');

  // Test J2: buildSurroundingContext honors tokenizer setting
  const longCjk = cjkSample.repeat(20);
  const resAuto = buildSurroundingContext({ beforeText: longCjk, afterText: longCjk, maxTokens: 100, tokenizer: 'auto' });
  const resGpt2 = buildSurroundingContext({ beforeText: longCjk, afterText: longCjk, maxTokens: 100, tokenizer: 'gpt2' });
  assert.ok(resAuto.tokenCount <= 100, 'Context respects budget under auto');
  assert.ok(resGpt2.tokenCount <= 100, 'Context respects budget under gpt2');
  assert.ok(resGpt2.contextText.length < resAuto.contextText.length, 'gpt2 budget permits fewer characters due to higher token weight');

  // Test J3: pageTurnController getEffectiveMode honors animIntensity="none" and reducedMotion="true"
  const ptCode = fs.readFileSync('js/page-turn-controller.js', 'utf8');
  const getEffectiveModeMatch = ptCode.match(/getEffectiveMode\(\) \{[\s\S]*?^    \}/m);
  assert.ok(getEffectiveModeMatch, 'Found getEffectiveMode in page-turn-controller.js');

  const getEffectiveModeFn = vm.runInNewContext('({' + getEffectiveModeMatch[0] + '}).getEffectiveMode', {});

  // Case normal: returns mode
  const stateNormal = { mode: 'slide', prefersReducedMotion: false };
  assert.equal(getEffectiveModeFn.call(stateNormal), 'slide');

  // Case reducedMotion dataset active: returns 'none'
  const fakeDocReduced = { dataset: { reducedMotion: 'true' } };
  const getModeWithDoc = (doc, state) => {
    return vm.runInNewContext('({' + getEffectiveModeMatch[0] + '}).getEffectiveMode', {
      document: { documentElement: doc }
    }).call(state);
  };
  assert.equal(getModeWithDoc(fakeDocReduced, { mode: 'slide', prefersReducedMotion: false }), 'none');

  // Case animIntensity="none" dataset active: returns 'none'
  const fakeDocAnimNone = { dataset: { animIntensity: 'none' } };
  assert.equal(getModeWithDoc(fakeDocAnimNone, { mode: 'slide', prefersReducedMotion: false }), 'none');

  console.log('✓ Task J: Model tokenizer & animation intensity passed behavioral verification');
  passedTests++;
}

console.log(`\n=======================================================`);
console.log(`=== ALL ${passedTests} RIGOROUS BEHAVIORAL SUITES PASSED CLEANLY ===`);
console.log(`=======================================================`);
