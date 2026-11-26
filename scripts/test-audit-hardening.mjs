// scripts/test-audit-hardening.mjs
// Comprehensive node:test verification suite for security, sync determinism,
// book/knowledge lifecycle separation, TXT rules, and reliability hardening.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mergeSyncData,
  mergeDrawingStrokes,
  reconcileBookSyncMeta,
  TOMBSTONE_TTL_MS,
} from '../js/sync-model.js';
import {
  validateSyncPayload,
  parseAndValidateSyncPayload,
} from '../js/syncEngine.js';
import { SUPPORTED_IMPORT_FORMATS, buildBookSyncMeta } from '../js/book-metadata.js';
import { restoreFullDataBackup } from '../js/backup-service.js';
import {
  ensureStatsHeatmapModule,
  ensureAdvancedSettingsLoaded,
  ensureAiSidebarLoaded,
  ensureChapterTranslationLoaded,
} from '../js/app-modules.js';
import { makeTXT } from '../foliate-js-main/txt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Sync merge is strictly commutative across tied timestamps and collections', () => {
  const fixedNow = 1_750_000_000_000;
  const payloadA = {
    version: 3,
    lastSyncedAt: fixedNow - 60_000,
    booksMeta: [
      {
        id: 'b1',
        title: 'Book One',
        format: 'epub',
        isArchived: true,
        archivedAt: fixedNow - 10_000,
        archivedUpdatedAt: fixedNow - 5_000,
        progress: { fraction: 0.4, cfi: 'cfi-a', timestamp: 1000 },
        updatedAt: 1000,
      },
    ],
    highlights: [{ id: 'h1', bookId: 'b1', text: 'Alpha', updatedAt: 2000 }],
    bookmarks: [{ id: 'bm1', bookId: 'b1', label: 'Start', updatedAt: 2000 }],
    settings: { fontSize: 18, theme: 'sepia' },
    settingsUpdatedAt: 3000,
    readingPresets: Array.from({ length: 8 }, (_, i) => ({
      id: `p-a-${i}`,
      name: `Preset A${i}`,
      updatedAt: 4000,
    })),
    customPalette: { accent: '#2f6f4e' },
    customPaletteUpdatedAt: 5000,
    userName: 'Alice',
    userNameUpdatedAt: 6000,
    pdfDrawings: [
      {
        id: 'b1_p1',
        bookId: 'b1',
        pageIndex: 1,
        strokes: [{ id: 's1', color: '#111', points: [[1, 2], [3, 4]] }],
        updatedAt: 7000,
      },
    ],
    deletedRecords: [{ id: 'del1', type: 'highlight', deletedAt: fixedNow - 1000 }],
  };

  const payloadB = {
    version: 3,
    lastSyncedAt: fixedNow - 30_000,
    booksMeta: [
      {
        id: 'b1',
        title: 'Book One',
        format: 'epub',
        isArchived: false,
        archivedAt: null,
        archivedUpdatedAt: fixedNow - 5_000,
        progress: { fraction: 0.4, cfi: 'cfi-b', timestamp: 1000 },
        updatedAt: 1000,
      },
    ],
    highlights: [{ id: 'h1', bookId: 'b1', text: 'Beta', updatedAt: 2000 }],
    bookmarks: [{ id: 'bm1', bookId: 'b1', label: 'Middle', updatedAt: 2000 }],
    settings: { fontSize: 20, theme: 'night' },
    settingsUpdatedAt: 3000,
    readingPresets: Array.from({ length: 8 }, (_, i) => ({
      id: `p-b-${i}`,
      name: `Preset B${i}`,
      updatedAt: 4000,
    })),
    customPalette: { accent: '#993322' },
    customPaletteUpdatedAt: 5000,
    userName: 'Bob',
    userNameUpdatedAt: 6000,
    pdfDrawings: [
      {
        id: 'b1_p1',
        bookId: 'b1',
        pageIndex: 1,
        strokes: [{ id: 's2', color: '#222', points: [[5, 6], [7, 8]] }],
        updatedAt: 7000,
      },
    ],
    deletedRecords: [{ id: 'del2', type: 'bookmark', deletedAt: fixedNow - 500 }],
  };

  // Same clientId ('') on both sides exercises pure canonical content tie-breaking
  const ab = mergeSyncData(payloadA, payloadB, { nowMs: fixedNow, localClientId: '' });
  const ba = mergeSyncData(payloadB, payloadA, { nowMs: fixedNow, localClientId: '' });

  assert.deepEqual(ab.merged, ba.merged);
  assert.equal(ab.merged.lastSyncedAt, fixedNow);
  assert.equal(ab.merged.tombstoneHorizonAt, fixedNow - TOMBSTONE_TTL_MS);
  assert.equal(ab.merged.readingPresets.length, 10);
  assert.equal(ab.merged.pdfDrawings[0].strokes.length, 2);
});

test('chapterTranslations incompatible version conflicts and equal-timestamp merges stay commutative', () => {
  const fixedNow = 1_760_000_000_000;
  const ctPayloadA = {
    version: 3,
    chapterTranslations: [
      {
        id: 'b1::ch1',
        bookId: 'b1',
        chapterKey: 'ch1',
        sourceHash: 'hash-a',
        parserVersion: 1,
        targetLanguage: 'zh',
        promptVersion: 1,
        status: 'completed',
        updatedAt: 5000,
        paragraphs: [{ id: 'p1', status: 'completed', translation: '译文 A' }],
      },
      {
        id: 'b1::ch2',
        bookId: 'b1',
        chapterKey: 'ch2',
        sourceHash: 'same-hash',
        parserVersion: 1,
        targetLanguage: 'zh',
        promptVersion: 1,
        status: 'partial',
        updatedAt: 5000,
        paragraphs: [
          { id: 'p1', status: 'completed', translation: '一段 A' },
          { id: 'p2', status: 'partial', translation: '' },
        ],
      },
    ],
  };
  const ctPayloadB = {
    version: 3,
    chapterTranslations: [
      {
        id: 'b1::ch1',
        bookId: 'b1',
        chapterKey: 'ch1',
        sourceHash: 'hash-b',
        parserVersion: 2,
        targetLanguage: 'zh',
        promptVersion: 1,
        status: 'completed',
        updatedAt: 5000,
        paragraphs: [{ id: 'p1', status: 'completed', translation: '译文 B' }],
      },
      {
        id: 'b1::ch2',
        bookId: 'b1',
        chapterKey: 'ch2',
        sourceHash: 'same-hash',
        parserVersion: 1,
        targetLanguage: 'zh',
        promptVersion: 1,
        status: 'completed',
        updatedAt: 5000,
        paragraphs: [
          { id: 'p2', status: 'completed', translation: '二段 B' },
          { id: 'p1', status: 'completed', translation: '一段 B' },
        ],
      },
    ],
  };

  const ab = mergeSyncData(ctPayloadA, ctPayloadB, { nowMs: fixedNow, localClientId: '' });
  const ba = mergeSyncData(ctPayloadB, ctPayloadA, { nowMs: fixedNow, localClientId: '' });
  assert.deepEqual(ab.merged, ba.merged);
  const ch1 = ab.merged.chapterTranslations.find((c) => c.id === 'b1::ch1');
  assert.equal(ch1.conflictRevisions.length, 1);
  const ch2 = ab.merged.chapterTranslations.find((c) => c.id === 'b1::ch2');
  assert.equal(ch2.status, 'completed');
});

test('mergeDrawingStrokes is commutative and deduplicates by id and content', () => {
  const a = [
    { id: 's2', points: [[2, 2]] },
    { id: 's1', points: [[1, 1]] },
  ];
  const b = [
    { id: 's1', points: [[1, 1]] },
    { id: 's3', points: [[3, 3]] },
  ];
  assert.deepEqual(mergeDrawingStrokes(a, b), mergeDrawingStrokes(b, a));
  assert.deepEqual(mergeDrawingStrokes(a, b).map((s) => s.id), ['s1', 's2', 's3']);
});

test('Sync merge flags staleDeviceWarning when lastSyncedAt predates tombstone TTL', () => {
  const nowMs = 1_800_000_000_000;
  const ancientSync = nowMs - TOMBSTONE_TTL_MS - 86_400_000;
  const result = mergeSyncData(
    { version: 3, lastSyncedAt: ancientSync, booksMeta: [] },
    { version: 3, lastSyncedAt: nowMs - 1000, booksMeta: [] },
    { nowMs, localClientId: 'dev-stale' }
  );
  assert.equal(result.stats.staleDeviceWarning, true);
});

test('reconcileBookSyncMeta preserves and reconciles archive state via LWW', () => {
  const base = buildBookSyncMeta({
    id: 'bk1',
    title: 'Archive Test',
    format: 'epub',
    isArchived: false,
    archivedAt: null,
    archivedUpdatedAt: 1000,
  });
  const archivedRemote = buildBookSyncMeta({
    id: 'bk1',
    title: 'Archive Test',
    format: 'epub',
    isArchived: true,
    archivedAt: 5000,
    archivedUpdatedAt: 5000,
  });
  const merged = reconcileBookSyncMeta(base, archivedRemote, '', '', { nowMs: 9000 });
  assert.equal(merged.isArchived, true);
  assert.equal(merged.archivedAt, 5000);
  assert.equal(merged.archivedUpdatedAt, 5000);
});

test('validateSyncPayload and parseAndValidateSyncPayload reject malformed payloads and huge sizes', () => {
  const schemaErr = /schema|格式|版本|payload|version|size|limit|large|bytes/i;
  assert.throws(() => validateSyncPayload({ version: NaN }), schemaErr);
  assert.throws(() => validateSyncPayload({ version: 2.5 }), schemaErr);
  assert.throws(() => validateSyncPayload({ version: 3, booksMeta: [null] }), schemaErr);
  assert.throws(
    () => validateSyncPayload({ version: 3, booksMeta: [{ id: 'b1', progress: { fraction: 1.5 } }] }),
    schemaErr
  );
  assert.throws(() => validateSyncPayload({ version: 3, highlights: [{ id: '' }] }), schemaErr);
  assert.throws(
    () =>
      validateSyncPayload({
        version: 3,
        pdfDrawings: [{ id: 'd1', strokes: [{ points: [[NaN, 1]] }] }],
      }),
    schemaErr
  );

  // Use a small limit to exercise real UTF-8 byte length without a large allocation.
  const compact = JSON.stringify({ version: 3, booksMeta: [{ id: "b1", title: "中文" }] });
  assert.throws(() => parseAndValidateSyncPayload(compact, { maxBytes: compact.length }), schemaErr);
  const utf8Bytes = new TextEncoder().encode(compact).byteLength;
  assert.equal(parseAndValidateSyncPayload(compact, { maxBytes: utf8Bytes }).booksMeta.length, 1);

  const valid = parseAndValidateSyncPayload(
    JSON.stringify({
      version: 3,
      booksMeta: [{ id: 'b1', title: 'Valid', progress: { fraction: 0.5 } }],
      highlights: [{ id: 'h1', bookId: 'b1', text: 'Note' }],
    })
  );
  assert.equal(valid.booksMeta.length, 1);
});

test('backup-service validates schemaVersion and array item shapes before restore', async () => {
  const mockDb = {
    applyRestorePlan: async () => true,
  };
  await assert.rejects(
    restoreFullDataBackup({ format: 'linden-leaf-full-backup', schemaVersion: 'bad', books: [] }, mockDb),
    /format|schema|version|格式|版本|不支持/i
  );
  await assert.rejects(
    restoreFullDataBackup({ format: 'linden-leaf-full-backup', schemaVersion: 1, books: [null] }, mockDb),
    /invalid|data|损坏|无效/i
  );
});

test('app-modules lazy loaders clear cached rejected promises and succeed on retry', async () => {
  let statsAttempts = 0;
  await assert.rejects(
    ensureStatsHeatmapModule(() => {
      statsAttempts++;
      return Promise.reject(new Error('transient stats chunk failure'));
    }),
    /transient stats/
  );
  const statsMod = await ensureStatsHeatmapModule(() => {
    statsAttempts++;
    return Promise.resolve({ formatMinutesClean: (m) => `${m}m` });
  });
  assert.equal(statsAttempts, 2);
  assert.equal(statsMod.formatMinutesClean(15), '15m');

  const fakeApp = { dom: null };
  let advAttempts = 0;
  await assert.rejects(
    ensureAdvancedSettingsLoaded(fakeApp, () => {
      advAttempts++;
      return Promise.reject(new Error('transient adv chunk failure'));
    }),
    /transient adv/
  );
  const advInst = await ensureAdvancedSettingsLoaded(fakeApp, () => {
    advAttempts++;
    return Promise.resolve({ advancedSettings: { bindUI() {} } });
  });
  assert.equal(advAttempts, 2);
  assert.equal(advInst._isRealInstance, true);

  let aiAttempts = 0;
  await assert.rejects(
    ensureAiSidebarLoaded(fakeApp, () => {
      aiAttempts++;
      return Promise.reject(new Error('transient ai chunk failure'));
    }),
    /transient ai/
  );
  const aiInst = await ensureAiSidebarLoaded(fakeApp, () => {
    aiAttempts++;
    return Promise.resolve({
      AiSidebarController: class FakeAi {
        constructor(app) {
          this.app = app;
        }
      },
    });
  });
  assert.equal(aiAttempts, 2);
  assert.equal(aiInst._isRealInstance, true);

  let ctAttempts = 0;
  await assert.rejects(
    ensureChapterTranslationLoaded(fakeApp, () => {
      ctAttempts++;
      return Promise.reject(new Error('transient ct chunk failure'));
    }),
    /transient ct/
  );
  const ctInst = await ensureChapterTranslationLoaded(fakeApp, () => {
    ctAttempts++;
    return Promise.resolve({ chapterTranslationManager: { init() {} } });
  });
  assert.equal(ctAttempts, 2);
  assert.equal(ctInst._isRealInstance, true);
});

test('TXT chapter splitter recognizes Traditional and Formal Chinese numerals while rejecting numbered verse', async () => {
  const sample = [
    '第壹章 開篇',
    '這是第一章的正文內容，講述故事的開端。',
    '1 這是帶編號的詩句，不應被誤判為章節。',
    '第貳節 轉折',
    '這是第二節的正文內容，情節開始推進。',
    '叁、總論',
    '這是第三部分的總論內容。',
    '後記',
    '全書完結。',
  ].join('\n\n');

  const buf = new TextEncoder().encode(sample);
  const fakeFile = {
    name: 'traditional-sample.txt',
    type: 'text/plain',
    size: buf.byteLength,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => sample,
  };
  const book = await makeTXT(fakeFile);
  const labels = (book.toc || []).map((item) => item.label);
  assert.ok(labels.some((l) => l.includes('第壹章')), `Expected 第壹章 in TOC: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes('第貳節')), `Expected 第貳節 in TOC: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes('叁、總論')), `Expected 叁、總論 in TOC: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.includes('後記')), `Expected 後記 in TOC: ${JSON.stringify(labels)}`);
  assert.ok(!labels.some((l) => l.includes('帶編號的詩句')), `Must not treat numbered prose as chapter: ${JSON.stringify(labels)}`);
});

test('Security & format-consistency contracts hold across frontend, Rust, C, and Android sources', () => {
  // 1. CSP removes unsafe-eval and uses wasm-unsafe-eval
  const indexHtml = readRepoFile('index.html');
  const tauriConf = readRepoFile('src-tauri/tauri.conf.json');
  assert.ok(!indexHtml.includes("'unsafe-eval'"), 'index.html CSP must not allow unsafe-eval');
  assert.ok(indexHtml.includes("'wasm-unsafe-eval'"), 'index.html CSP must allow wasm-unsafe-eval');
  assert.ok(!tauriConf.includes("'unsafe-eval'"), 'tauri.conf.json CSP must not allow unsafe-eval');
  assert.ok(tauriConf.includes("'wasm-unsafe-eval'"), 'tauri.conf.json CSP must allow wasm-unsafe-eval');

  // 2. Format consistency: unrenderable djvu removed from import & native filters
  assert.ok(!SUPPORTED_IMPORT_FORMATS.includes('djvu'));
  const fsRs = readRepoFile('src-tauri/src/commands/fs.rs');
  assert.ok(!fsRs.includes('"djvu"'), 'fs.rs SUPPORTED_EXTENSIONS must not claim djvu support');
  const ktBridge = readRepoFile('src-tauri/gen/android/app/src/main/java/com/lindenleaf/reader/LindenNativeBridge.kt');
  assert.ok(!ktBridge.includes('"djvu"'), 'LindenNativeBridge.kt must not claim djvu support');

  // 3. Rust write boundary & sync boundary enforcement
  assert.ok(fsRs.includes('authorize_write_path'), 'fs.rs must enforce authorize_write_path');
  assert.ok(fsRs.includes('set_authorized_sync_dir'), 'fs.rs must track single active sync dir');
  assert.ok(fsRs.includes('MAX_TEXT_WRITE_BYTES'), 'fs.rs must enforce write byte cap');
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');
  assert.ok(syncRs.includes('authorize_write_path'), 'sync.rs must enforce authorize_write_path');
  assert.ok(syncRs.includes('set_authorized_sync_dir'), 'sync.rs must register configured sync folder securely');

  // 4. C MuPDF cancel flag uses atomic helpers
  const mupdfC = readRepoFile('src-tauri/native/ll_mupdf.c');
  assert.ok(mupdfC.includes('ll_atomic_store_abort'), 'll_mupdf.c must use atomic store for abort flag');
  assert.ok(mupdfC.includes('ll_atomic_load_abort'), 'll_mupdf.c must use atomic load for abort flag');
  const bareAbortRefs = mupdfC
    .split(/\r?\n/)
    .filter((line) => line.includes('cookie.abort') && !line.includes('ll_atomic_'));
  assert.deepEqual(bareAbortRefs, [], 'll_mupdf.c must only touch cookie.abort through ll_atomic_* helpers');

  // 5. Android bridge sniffs magic bytes / MIME for extensionless files
  assert.ok(ktBridge.includes('sniffExtensionFromMagic'), 'LindenNativeBridge.kt must sniff magic/MIME when ext is empty');

  // 6. Sync engine routes all preview/lifecycle/refetch reads through parseAndValidateSyncPayload
  const syncEngineJs = readRepoFile('js/syncEngine.js');
  const parseCallCount = (syncEngineJs.match(/parseAndValidateSyncPayload\(/g) || []).length;
  assert.ok(parseCallCount >= 6, `syncEngine.js should route remote/bridge payloads through parseAndValidateSyncPayload (found ${parseCallCount})`);

  // 7. Advanced settings surfaces storage write failure instead of empty catch
  const advJs = readRepoFile('js/advanced-settings.js');
  assert.ok(advJs.includes('this.lastSaveError'), 'advanced-settings.js must record lastSaveError');
  assert.ok(advJs.includes("t('advancedSettings.saveFailedToast')"), 'advanced-settings.js must notify user on save failure');

  // 8. db.js exports lifecycle separation APIs
  const dbJs = readRepoFile('js/db.js');
  assert.ok(dbJs.includes('export const getBookKnowledgeSummary'), 'db.js must export getBookKnowledgeSummary');
  assert.ok(dbJs.includes('export const removeBookLocalFile'), 'db.js must export removeBookLocalFile');
  assert.ok(dbJs.includes('export const archiveBook'), 'db.js must export archiveBook');
  assert.ok(dbJs.includes('preserveAnnotations'), 'db.js deleteBook must support preserveAnnotations option');
});
