import { createLazySnapshotBlob } from '../js/db.js';
import { openLocalEpubSource } from '../js/book-source.js';
import { platformBridge } from '../js/platformBridge.js';
import assert from 'node:assert/strict';
import { computeContentHash, contentIdentityRelation, findSameContentBook } from '../js/document-identity.js';
import { buildBookSyncMeta } from '../js/book-metadata.js';
import { mergeSyncData, reconcileBookSyncMeta } from '../js/sync-model.js';
import { assembleFullBackupData, restoreFullDataBackup } from '../js/backup-service.js';
import { collectPdfPreferences } from '../js/pdf-preferences.js';
import { getBookStorage, GoogleDriveStorageProvider, OneDriveStorageProvider } from '../js/storage-providers.js';

let count = 0;
async function test(name, run) { await run(); console.log('[PASS]', name); count++; }
const payload = (books, extra = {}) => ({ booksMeta: books, highlights: [], bookmarks: [], readingSessions: [], deletedRecords: [], ...extra });

await test('full content hash detects changes outside the former sample regions', async () => {
    const a = new Uint8Array(3 * 1024 * 1024), b = a.slice(); b[256 * 1024] = 1;
    assert.notEqual(await computeContentHash(new Blob([a])), await computeContentHash(new Blob([b])));
    assert.equal(await computeContentHash(new Blob(['abc'])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
await test('legacy aliases preserve identity; sampled hashes cannot prove a duplicate', async () => {
    const hash = await computeContentHash(new Blob(['abc']));
    assert.equal(contentIdentityRelation({ documentHash: 'hash_old_3', documentHashAliases: [hash] }, { documentHash: hash }), 'same');
    assert.equal(contentIdentityRelation({ documentHash: 's_old' }, { documentHash: 's_old' }), 'unknown');
    const book = { id: 'legacy', format: 'txt', size: 3, filename: 'x.txt', documentHash: 's_old' };
    assert.equal((await findSameContentBook([book], { format: 'txt', size: 3, filename: 'x.txt', documentHash: hash }, async () => ({ blob: new Blob(['abc']) }))).id, 'legacy');
});
await test('real metadata export keeps identity before conflicting-book merge', () => {
    const local = buildBookSyncMeta({ id: 'b', format: 'pdf', size: 3, documentHash: 'hash-A', updatedAt: 100 });
    const remote = buildBookSyncMeta({ ...local, documentHash: 'hash-B', updatedAt: 200 });
    assert.equal(local.documentHash, 'hash-A');
    const merged = mergeSyncData(payload([local], { clientId: 'a', highlights: [{ id: 'local-note', bookId: 'b' }] }), payload([remote], { clientId: 'b', highlights: [{ id: 'remote-note', bookId: 'b' }] })).merged;
    assert.equal(merged.booksMeta.length, 2);
    assert.equal(merged.highlights.find(h => h.id === 'local-note').bookId, 'b');
    assert.notEqual(merged.highlights.find(h => h.id === 'remote-note').bookId, 'b');
    assert.equal(merged.booksMeta.find(b => b.id !== 'b').documentHash, 'hash-B');
});
await test('resolved custom metadata is the metadata actually applied by the merge', () => {
    const a = { id: 'a', format: 'epub', documentHash: 'same', customTitle: 'old', customAuthor: 'old', updatedAt: 100 };
    const b = { ...a, customTitle: 'new', customAuthor: 'new', updatedAt: 200 };
    const expected = reconcileBookSyncMeta(a, b, 'a', 'b');
    const result = mergeSyncData(payload([a], { clientId: 'a' }), payload([b], { clientId: 'b' })).merged.booksMeta[0];
    assert.equal(result.customTitle, expected.customTitle); assert.equal(result.customAuthor, expected.customAuthor);
});
await test('cross-device merge keeps the verified legacy binding as an alias', async () => {
    const digest = await computeContentHash(new Blob(['same content']));
    const local = { id: 'local-id', stableKey: 'work', format: 'pdf', size: 12, documentHash: digest };
    const remote = { ...local, id: 'remote-id', documentHash: 'hash_old_12', documentHashAliases: [digest] };
    const merged = mergeSyncData(payload([local]), payload([remote], { highlights: [{ id: 'old-note', bookId: remote.id, documentHash: remote.documentHash }] })).merged;
    assert.equal(merged.booksMeta.length, 1);
    assert.ok(merged.booksMeta[0].documentHashAliases.includes(remote.documentHash));
    assert.equal(merged.highlights[0].bookId, local.id);
});
await test('book tombstones use verified identity aliases without deleting a newer content version', async () => {
    const digest = await computeContentHash(new Blob(['same content']));
    const now = Date.now();
    const local = { id: 'old-id', format: 'pdf', size: 12, documentHash: 'hash_old_12', updatedAt: now - 1000 };
    const other = { ...local, id: 'other-id', documentHash: 'hash_other_12' };
    const merged = mergeSyncData(payload([local, other]), payload([], { deletedRecords: [{ id: 'remote-id', type: 'book', documentHash: digest, documentHashAliases: [local.documentHash], deletedAt: now }] })).merged;
    assert.deepEqual(merged.booksMeta.map(b => b.id), ['other-id']);
});
await test('backup uses shared metadata and includes per-book PDF tool settings without a UI', async () => {
    const values = new Map([['linden_scan_b', '{"preset":"deep-ink"}'], ['linden_col_cfg_b', '{"enabled":true}']]);
    globalThis.localStorage = { get length() { return values.size }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null };
    const books = [{ id: 'b', title: 'test', documentHash: 'hash-A', cropSettings: { mode: 'custom' } }];
    const backup = await assembleFullBackupData({
        getAllBooks: async () => books, getAllReadingSessions: async () => [], getAllHighlights: async () => [],
        getAllBookmarks: async () => [], getAllPdfDrawings: async () => [], getAllCustomLists: async () => [],
        getAllChapterTranslations: async () => [], getAllDeletedRecords: async () => [], getSetting: async () => null
    }, { apiKey: 'secret', ttsRate: 1 });
    assert.equal(backup.books[0].documentHash, 'hash-A');
    assert.deepEqual(backup.books[0].cropSettings, { mode: 'custom' });
    assert.deepEqual(backup.pdfToolPreferences, collectPdfPreferences(books));
    assert.equal(backup.pdfToolPreferences.b.scan.preset, 'deep-ink');
    assert.equal(backup.config.apiKey, undefined);
    delete globalThis.localStorage;
});
await test('restoring requires the actual atomic storage contract before any mutation', async () => {
    let writes = 0;
    await assert.rejects(restoreFullDataBackup({}, { saveBook() { writes++ } }), /原子事务|transactional storage/i);
    assert.equal(writes, 0);
});
await test('unsupported binary storage reports a capability limit without a WebDAV fallback', () => {
    assert.throws(() => getBookStorage({ providerType: 'local_folder', folderPath: 'test' }), /整本书籍|full book transfers/i);
});
await test('Google binary upload preserves typed-array slice and escapes quoted file names', async () => {
    const provider = new GoogleDriveStorageProvider({ clientId: 'test', accessToken: 'test' });
    const originalFetch = globalThis.fetch; const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (!options.method) return Response.json({ files: [] });
        return Response.json({ id: 'uploaded' });
    };
    try {
        const bytes = new Uint8Array([9, 1, 2, 8]).subarray(1, 3);
        const result = await provider.uploadBookBinary("O'Reilly.pdf", bytes);
        assert.equal(result.success, true);
        assert.ok(new URL(requests[0].url).searchParams.get('q').includes("O\\'Reilly.pdf"));
        const body = requests[1].options.body;
        assert.deepEqual([...new Uint8Array(await body.get('file').arrayBuffer())], [1, 2]);
        assert.equal(body.get('file').type, 'application/octet-stream');
    } finally { globalThis.fetch = originalFetch; }
});
await test('OneDrive binary storage creates its application book folder then uses Graph upload', async () => {
    const provider = new OneDriveStorageProvider({ clientId: 'test', accessToken: 'test' });
    const originalFetch = globalThis.fetch; const requests = [];
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (requests.length === 1) return new Response('', { status: 404 });
        return Response.json({ id: 'uploaded', eTag: 'etag' });
    };
    try {
        const result = await provider.uploadBookBinary('book.pdf', new Uint8Array([1, 2]));
        assert.equal(result.success, true);
        assert.equal(requests[1].options.method, 'POST'); assert.equal(requests[2].options.method, 'PUT');
        assert.ok(requests.every(r => r.url.startsWith('https://graph.microsoft.com/')));
    } finally { globalThis.fetch = originalFetch; }
});

await test('native EPUB slices preserve assets over 2 MiB and whole-book export', async () => {
    const originalRead = platformBridge.readFileBuffer
    const originalBridge = globalThis.platformBridge
    globalThis.platformBridge = platformBridge
    const budget = 2 * 1024 * 1024
    const source = Uint8Array.from({ length: budget + 32 }, (_, i) => i % 251)
    const reads = []
    Object.defineProperty(platformBridge, 'isTauri', { configurable: true, value: true })
    platformBridge.readFileBuffer = async (filePath, options) => {
        assert.equal(filePath, 'C:/test/snapshot.epub')
        reads.push(options)
        return options ? source.slice(options.offset, options.offset + options.length).buffer : source.slice().buffer
    }
    try {
        const blob = createLazySnapshotBlob('C:/test/snapshot.epub', source.length, 'application/epub+zip')
        const bytes = await blob.slice(12, budget + 24).arrayBuffer()
        assert.deepEqual(new Uint8Array(bytes), source.subarray(12, budget + 24))
        assert.deepEqual(reads, [{ offset: 12, length: budget }, { offset: budget + 12, length: 12 }])
        assert.equal((await blob.slice(10, 22).slice(24).arrayBuffer()).byteLength, 0)
        assert.equal(reads.length, 2)
        assert.deepEqual(new Uint8Array(await (await blob.materialize()).arrayBuffer()), source)
        assert.equal(reads.at(-1), undefined)
        platformBridge.readFileBuffer = async () => new ArrayBuffer(1)
        await assert.rejects(blob.slice(10, 22).arrayBuffer(), /EPUB range/)
    } finally {
        platformBridge.readFileBuffer = originalRead
        delete platformBridge.isTauri
        if (originalBridge) globalThis.platformBridge = originalBridge
        else delete globalThis.platformBridge
    }
});

await test('external EPUB only reuses a saved copy when its content and file still match', async () => {
    const file = { filePath: 'E:/test/book.epub', filename: 'book.epub' }
    const book = { id: 'old', nativePath: file.filePath, format: 'epub', documentHash: 'a'.repeat(64) }
    const snapshot = { blob: new Blob(['data']), documentHash: book.documentHash }
    const db = { getAllBooks: async () => [book], getBookFileSnapshot: async () => snapshot }
    let hash = book.documentHash
    let valid = true
    let imports = 0
    const bridge = { computeNativeFileHash: async () => hash, validateNativeSnapshot: async () => valid }
    const queue = { enqueueAndWait: async ([item]) => {
        assert.equal(item.filePath, file.filePath)
        assert.equal(item.isRecentOnly, true)
        imports++
        return [{ status: 'succeeded', bookId: 'imported' }]
    } }
    const open = () => openLocalEpubSource(file, { db, bridge, queue })
    assert.equal((await open()).bookId, book.id)
    snapshot.nativeSnapshotOnly = true
    snapshot.nativeSnapshotPath = 'C:/test/snapshot.epub'
    snapshot.nativeSnapshotSize = 4
    assert.equal((await open()).bookId, book.id)
    assert.equal(imports, 0)
    valid = false
    assert.equal((await open()).bookId, 'imported')
    valid = true
    hash = 'b'.repeat(64)
    assert.equal((await open()).bookId, 'imported')
    assert.equal(imports, 2)
});



console.log(`Data contract tests: ${count} passed.`);
