import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import { getAiResponseState } from '../js/ai-response-state.js'
import { TranslationJobCoordinator, validateTranslationResponse } from '../js/translation-job-core.js'
import { FullTextSearchEngine, tokenizeText } from '../js/fulltext-search.js'
import { computeActiveSessionSeconds } from '../js/db.js'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const test = async (name, run) => { await run(); results.push(name); console.log('PASS ' + name) }
const identity = { bookContentHash: 'fixture', chapterSourceKey: 'sec_0', sourceHash: 'fixture-text', parserVersion: 'fixture', targetLanguage: 'zh-CN', promptVersion: 'translation-v1-auto' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const memoryStorage = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (k,v) => data.set(k,String(v)), removeItem: k => data.delete(k) } }

// Link the actual modules to isolated in-memory dependencies. No application database or credentials.
async function loadModule(relative, stubs, globals = {}) {
    const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, Date, structuredClone, AbortController, Blob, URL, DOMException, TextDecoder, TextEncoder, ...globals })
    const modules = new Map()
    const load = async absolute => {
        if (modules.has(absolute)) return modules.get(absolute)
        const source = await fs.readFile(absolute, 'utf8')
        const module = new vm.SourceTextModule(source, { context, identifier: absolute })
        modules.set(absolute, module)
        await module.link(async (specifier, parent) => {
            const absolute = path.resolve(path.dirname(parent.identifier), specifier)
            const stub = stubs[path.basename(absolute)]
            if (stub) {
                if (!modules.has(absolute)) {
                    const synthetic = new vm.SyntheticModule(Object.keys(stub), function () { for (const [name, value] of Object.entries(stub)) this.setExport(name, value) }, { context, identifier: absolute })
                    modules.set(absolute, synthetic)
                }
                return modules.get(absolute)
            }
            return load(absolute)
        })
        return module
    }
    const module = await load(path.join(root, relative))
    await module.evaluate()
    return module.namespace
}

await test('26 books: early and late matches survive bounded-cache eviction through searchBooks', async () => {
    const books = Array.from({ length: 26 }, (_, i) => ({ id: `book-${i}`, format: 'txt', title: `Book ${i}` }))
    const engine = new FullTextSearchEngine({ db: {
        getBook: async id => books.find(b => b.id === id),
        getBookFileSnapshot: async () => ({ blob: new Blob(['fixture']), blobRevision: 'r' }),
        getBookSearchIndex: async id => ({ extractorVersion: 'placeholder', blobRevision: 'r', title: id, sections: [] })
    } })
    // Invoke real indexing's persistence-rehydration path with its actual extractor version.
    const source = await fs.readFile(path.join(root, 'js/fulltext-search.js'), 'utf8')
    const version = source.match(/const EXTRACTOR_VERSION = ['"]([^'"]+)/)[1]
    engine.db.getBookSearchIndex = async id => {
        const text = id === 'book-0' || id === 'book-25' ? 'uniqueneedle' : 'another word'
        return { extractorVersion: version, blobRevision: 'r', title: id, sections: [{ id: 's', sectionIndex: 0, text, tokens: Array.from(tokenizeText(text)), location: { sectionIndex: 0 } }] }
    }
    const found = await engine.searchBooks('uniqueneedle', books, { concurrency: 2 })
    assert.deepEqual(found.results.map(r => r.bookId).sort(), ['book-0', 'book-25'])
    assert.equal(found.searched, 26)
    assert.ok(engine.index.size <= 25)
    const controller = new AbortController(); controller.abort()
    assert.equal((await engine.searchBooks('uniqueneedle', books, { signal: controller.signal })).results.length, 0)
})

await test('AI EOF / length / cancelled states are preserved by actual sidebar finalization', async () => {
    const source = await fs.readFile(path.join(root, 'js/ai-sidebar-controller.js'), 'utf8')
    const block = source.match(/const resultText = typeof response === 'string'[\s\S]*?await saveAiMessage\(assistantMsg\)/)[0]
    const finish = new Function('response', 'assistantMsg', 'saveAiMessage', 'getAiResponseState', `return (async () => { ${block}; return assistantMsg; })()`)
    for (const [status, finishReason, expected] of [['partial', null, 'partial'], ['completed', 'length', 'partial'], ['cancelled', null, 'cancelled'], ['failed', null, 'failed'], ['completed', 'stop', 'completed']]) {
        const message = await finish({ status, finishReason, fullText: 'answer' }, {}, async () => {}, getAiResponseState)
        assert.equal(message.status, expected)
        assert.equal(message.content, 'answer')
    }
})

await test('Translation: 153 paragraphs, CRLF fences and translations envelope complete without retries', async () => {
    const paragraphs = Array.from({ length: 153 }, (_, i) => ({ id: `p_${i}`, text: `Paragraph ${i}` }))
    const chunks = Array.from({ length: 51 }, (_, i) => paragraphs.slice(i * 3, i * 3 + 3))
    let requests = 0; let saved = 0
    const result = await new TranslationJobCoordinator().run({ identity, chunks, request: async ({ chunk }) => {
        requests++
        const values = chunk.map(p => ({ id: p.id, translation: '译文' }))
        return { status: 'completed', finishReason: 'stop', fullText: requests === 2 ? JSON.stringify({ translations: values }) : requests % 3 === 0 ? '以下是对应译文：\n' + JSON.stringify(values) : '```json\r\n' + JSON.stringify(values) + '\r\n```' }
    }, commit: async ({ translated }) => { saved += translated.length; return true } })
    assert.equal(result.status, 'completed'); assert.equal(saved, 153); assert.equal(requests, 51)
})

await test('Translation: valid returned paragraphs are saved before interrupted EOF stops further dispatch', async () => {
    let requests = 0; let saved = 0
    await assert.rejects(new TranslationJobCoordinator().run({ identity, chunks: [[{ id: 'p0', text: 'a' }], [{ id: 'p1', text: 'b' }]],
        request: async () => { requests++; return { status: 'partial', finishReason: null, fullText: '[{"id":"p0","translation":"译文"}]' } },
        commit: async ({ translated }) => { saved += translated.length; return true }
    }), e => e.code === 'interrupted' && e.diagnostic.status === 'partial')
    assert.equal(requests, 1); assert.equal(saved, 1)
    assert.throws(() => validateTranslationResponse('[{"id":"other","translation":"x"}]', ['p0']), e => e.code === 'id_mismatch')
})

const makeManager = async ({ save = async () => true, request = async () => '', globals = {} } = {}) => {
    const module = await loadModule('js/chapter-translation-manager.js', {
        'db.js': { saveChapterTranslation: save, getChapterTranslation: async () => null, deleteChapterTranslation: async () => true, listChapterTranslationsForBook: async () => [] },
        'reading-ai-assistant.js': { getAiConfig: () => ({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-model' }), getAiApiKey: async () => 'fixture', requestAiCompletion: request, recordTranslationDiagnostic: async () => true }
    }, globals)
    const app = { currentBookData: { format: 'epub', contentHash: 'fixture' }, advancedSettings: { config: { chapterTransStyle: 'literary', chapterTransAutoSave: true, aiCooldownSeconds: 0 }, aiMaxTokens: 512 }, showToast() {} }
    const manager = new module.ChapterTranslationManager(app)
    manager.currentBookId = 'book'; manager.currentChapterKey = 'sec_0'
    manager.getSectionDocument = () => ({})
    manager.extractChapterParagraphs = () => [{ id: 'p0', text: 'One sentence.', sourceHash: 's0' }, { id: 'p1', text: 'Second sentence.', sourceHash: 's1' }]
    manager.renderDerivedBilingualView = () => {}
    return manager
}

await test('Translation toolbar resumes only its owning chapter and commits the next batch', async () => {
    const manager = await makeManager()
    manager.taskOwner = { bookId: 'book', chapterKey: 'sec_0', total: 2 }
    let requests = 0
    const pending = manager.coordinator.run({ identity, chunks: [[{ id: 'p0', text: 'a' }], [{ id: 'p1', text: 'b' }]],
        request: async ({ chunk }) => { requests++; if (requests === 1) manager.coordinator.pause(); return JSON.stringify(chunk.map(p => ({ id: p.id, translation: 'x' }))) }, commit: async () => true })
    await tick()
    manager.currentChapterKey = 'sec_1'; manager.handleToolbarClick()
    assert.equal(manager.coordinator.state, 'paused'); assert.equal(requests, 1)
    manager.currentChapterKey = 'sec_0'; manager.handleToolbarClick()
    await pending
    assert.equal(requests, 2); assert.equal(manager.coordinator.state, 'idle')
})

await test('Translation freezes request settings, resumes matching saved style, and reports ephemeral storage', async () => {
    const sent = []; const saved = []
    const manager = await makeManager({ save: async r => { saved.push(structuredClone(r)); return true }, request: async r => {
        sent.push(r)
        manager.app.advancedSettings.config.chapterTransStyle = 'academic'
        return { status: 'completed', finishReason: 'stop', fullText: '译文' }
    } })
    // Force two sizeable paragraphs into separate requests using the real batching code.
    manager.extractChapterParagraphs = () => [{ id: 'p0', text: '一'.repeat(140), sourceHash: 's0' }, { id: 'p1', text: '二'.repeat(140), sourceHash: 's1' }]
    await manager.startCurrentChapterTranslation()
    assert.ok(sent.length >= 2)
    assert.ok(sent.every(r => r.systemPrompt.includes('文学优美')))
    assert.equal(saved.at(-1).model, 'fixture-model')
    assert.equal(saved.at(-1).promptVersion, 'translation-v1-literary')
    const before = sent.length
    manager.app.advancedSettings.config.chapterTransAutoSave = false
    await manager.startCurrentChapterTranslation({ restart: true })
    assert.ok(sent.length > before); assert.ok(manager.sessionRecords.has('book::sec_0'))
    assert.equal(manager.cachedRecord.promptVersion, 'translation-v1-academic')
    assert.equal(manager.cachedRecord.conflictRevisions.at(-1).promptVersion, 'translation-v1-literary')
})

await test('Translation save failure can be retried locally without sending the paragraph again', async () => {
    let allowSave = false; let requests = 0; const prompts = []
    const manager = await makeManager({ save: async () => allowSave, request: async r => {
        requests++; prompts.push(r.prompt)
        return { status: 'completed', finishReason: 'stop', fullText: '译文' }
    } })
    await manager.startCurrentChapterTranslation()
    assert.equal(requests, 1); assert.ok(manager.sessionRecords.has('book::sec_0'))
    allowSave = true
    await manager.startCurrentChapterTranslation()
    assert.equal(requests, 2); assert.equal(prompts.filter(p => p.includes('One sentence.')).length, 1); assert.equal(manager.cachedRecord.status, 'completed'); assert.equal(manager.sessionRecords.size, 0)
})

await test('Legacy translation cache cannot replace the configured API model during manual continuation', async () => {
    const requests = []
    const manager = await makeManager({ request: async r => {
        requests.push(r)
        return { status: 'completed', finishReason: 'stop', fullText: '译文' }
    } })
    manager.cachedRecord = { id: 'book::sec_0', bookId: 'book', chapterKey: 'sec_0', model: 'legacy-default-placeholder', promptVersion: 'translation-v1-literal', status: 'partial', paragraphs: [{ id: 'p0', sourceHash: 's0', status: 'completed', translation: '已有译文' }] }
    await manager.startCurrentChapterTranslation()
    assert.equal(requests[0].model, 'fixture-model'); assert.ok(requests[0].systemPrompt.includes('字句精准'))
    assert.equal(manager.cachedRecord.paragraphs.find(p => p.id === 'p0').translation, '已有译文')
})

await test('Real read/listen writers store intervals; overlap and midnight are counted once', async () => {
    const records = new Map()
    const store = { toLocalDateKey: value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}` }, recordReadingSession: async r => { records.set(r.id, structuredClone(r)); return r.id } }
    const trackerModule = await loadModule('js/tracker.js', { 'db.js': store }, { localStorage: memoryStorage() })
    const ttsModule = await loadModule('js/tts-player.js', { 'db.js': store, 'platformBridge.js': { platformBridge: { isAndroid: false } } })
    const tracker = new trackerModule.ReadingTracker()
    const begin = new Date(2026, 9, 14, 12, 0, 0).getTime()
    let now = begin; tracker._clock = () => now
    await tracker.startSession('book', 'Fixture', 0)
    clearInterval(tracker.tickerInterval); tracker.tickerInterval = null
    for (let i = 0; i < 60; i++) { now += 1000; tracker.tick() }
    await tracker.endSession()
    const player = new ttsModule.TtsPlayer()
    player.activeListeningIntervals = [[begin + 10000, begin + 25000], [begin + 35000, begin + 50000]]
    player.sessionBookOwner = { bookId: 'book', bookTitle: 'Fixture' }
    await player.flushListeningSession()
    assert.equal(records.size, 2)
    assert.ok([...records.values()].every(r => r.activeIntervals?.length))
    assert.equal(computeActiveSessionSeconds([...records.values()]), 60)
    assert.equal([...records.values()].filter(r => r.isListening)[0].durationSeconds, 30)
    records.clear()
    now = new Date(2026, 9, 14, 23, 59, 30).getTime()
    await tracker.startSession('book', 'Fixture', 0); clearInterval(tracker.tickerInterval); tracker.tickerInterval = null
    for (let i = 0; i < 60; i++) { now += 1000; tracker.lastActivityTime = now; tracker.tick() }
    await tracker.endSession()
    assert.equal(records.size, 2)
    assert.equal(computeActiveSessionSeconds([...records.values()]), 60)
    assert.ok([...records.values()].every(r => Math.round(r.activeIntervals.reduce((n,[a,b]) => n+(b-a)/1000,0)) === Math.round(r.durationSeconds)))
})

const fakeDom = () => {
    const items = new Map()
    const get = id => { if (!items.has(id)) items.set(id, { id, style: {}, value: '', checked: false, innerText: '', disabled: false, handlers: {}, handlerCounts: {}, querySelectorAll() { return [] }, addEventListener(name, fn) { this.handlers[name] = fn; this.handlerCounts[name] = (this.handlerCounts[name] || 0) + 1 }, classList: { add() {}, remove() {}, toggle() {} } }); return items.get(id) }
    return { getElementById: get, documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {} } } }
}

await test('Settings import/reset applies typography and WebDAV flag, and invalid values are bounded', async () => {
    const storage = memoryStorage(); const applied = new Map(); const doc = fakeDom()
    const tts = { loadSettings() {} }
    const module = await loadModule('js/advanced-settings.js', {
        'txt.js': { setCustomTxtPatterns() {}, setTxtMergeSoftBreaks() {} }, 'db.js': { getChapterTranslationsStats: async () => ({}), clearAllChapterTranslations() {} },
        'txt-toc-worker.js': { runTxtRulesWorker() {} }, 'dictionary-service.js': { dictionaryService: {} }, 'tts-player.js': { ttsPlayer: tts }, 'platformBridge.js': { platformBridge: {} }
    }, { document: doc, localStorage: storage })
    const app = { setSetting: (k,v) => applied.set(k,v), saveSettingsDebounced() {}, applySettingsToReader() {}, showToast() {} }
    const manager = new module.AdvancedSettingsManager(app)
    await manager.importSettingsJSON(new Blob([JSON.stringify({ advancedSettings: { paraMarginTop: 1.5, paraIndentSize: '1em', webdavSyncTranslations: true, ttsRate: -999, aiMaxTokens: 999999 } })]))
    assert.equal(applied.get('paraMarginTop'), 1.5); assert.equal(applied.get('paraIndentSize'), '1em')
    assert.equal(storage.getItem('linden_sync_chapter_translations'), 'true')
    assert.equal(manager.config.ttsRate, 0.5); assert.equal(manager.config.aiMaxTokens, 20000)
    manager.resetAndLock()
    assert.equal(applied.get('paraMarginTop'), 0); assert.equal(storage.getItem('linden_sync_chapter_translations'), 'false')
    assert.equal(module.sanitizeAdvancedSettings({ webdavSyncTranslations: 'false' }).webdavSyncTranslations, false)
    manager.attachEventListeners(); manager.renderUIState(); manager.renderUIState()
    const width = doc.getElementById('setting-sidebar-default-width')
    assert.equal(width.handlerCounts.change, 1)
    width.handlers.change({ target: { value: '440' } })
    assert.equal(manager.config.sidebarDefaultWidth, 440)
    const rows = ['offline', 'api'].map(kind => ({ dataset: { ttsFor: kind }, hidden: false, value: 'saved-' + kind }))
    doc.getElementById('adv-group-tts').querySelectorAll = () => rows
    for (const provider of ['system', 'offline', 'api']) {
        manager.config.ttsProvider = provider
        manager.renderUIState()
        assert.ok(rows.every(row => row.hidden === (row.dataset.ttsFor !== provider)))
        assert.ok(rows.every(row => row.value === 'saved-' + row.dataset.ttsFor))
    }

})

await test('Custom TTS sends selected model/voice, supports explicit no-auth, and clears the real cache', async () => {
    const sent = []
    const bridge = { isAndroid: false, secureLoadCredential: async () => null }
    const module = await loadModule('js/tts-player.js', { 'db.js': { toLocalDateKey() {} }, 'platformBridge.js': { platformBridge: bridge } }, {
        fetch: async (url, options) => { sent.push({ url, options }); return { ok: true, blob: async () => new Blob(['audio']) } }
    })
    const provider = new module.ApiTtsProvider()
    await provider.fetchAudioBlob('短句', { apiEndpoint: 'http://127.0.0.1/speech', model: 'local-model', voiceId: 'speaker-123', allowUnauthenticated: true })
    assert.deepEqual(JSON.parse(sent[0].options.body), { model: 'local-model', input: '短句', voice: 'speaker-123', speed: 1 })
    assert.equal(sent[0].options.headers.Authorization, undefined)
    assert.equal((await provider.getVoices({ apiEndpoint: 'http://127.0.0.1/speech', voiceId: 'speaker-123' }))[0].id, 'speaker-123')
    const cleared = provider.clearCache(); assert.equal(cleared.count, 1); assert.ok(cleared.bytes > 0); assert.equal(provider.cache.size, 0)
    let stored
    const player = new module.TtsPlayer()
    player.attachReaderApp({ advancedSettings: { config: {}, save() { stored = { ...this.config } }, renderUIState() {} } })
    player.setProvider('api'); player.setVoice('speaker-456'); player.setRate(1.3)
    assert.equal(stored.ttsApiVoiceId, 'speaker-456'); assert.equal(stored.ttsRate, 1.3)
    const other = new module.TtsPlayer(); other.loadSettings(stored)
    assert.equal(other.getProviderOptions().voiceId, 'speaker-456'); assert.equal(other.rate, 1.3)
})

await test('TXT merge switch changes actual paragraph HTML while retaining poetry line breaks', async () => {
    const module = await loadModule('foliate-js-main/txt.js', { 'txt-toc-worker.js': { runTxtRulesWorker: async () => ({ matches: [] }) } })
    const make = async () => { const file = new Blob(['A long first line with enough words to be ordinary prose.\nAnother fairly long line belonging to the same prose paragraph.']); file.name = 'fixture.txt'; return module.makeTXT(file) }
    module.setTxtMergeSoftBreaks(true)
    let book = await make(); let html = await (await fetch(await book.sections[0].load())).text(); book.destroy()
    assert.equal((html.match(/<p class="prose-p">/g) || []).length, 1)
    module.setTxtMergeSoftBreaks(false)
    book = await make(); html = await (await fetch(await book.sections[0].load())).text(); book.destroy()
    assert.equal((html.match(/<p class="prose-p">/g) || []).length, 2)
})

await test('Re-link replaces old blob and snapshot with one coherent content revision', async () => {
    const source = await fs.readFile(path.join(root, 'js/db.js'), 'utf8')
    const start = source.indexOf('export const relinkBookFile =')
    const end = source.indexOf('\nexport const ', start + 1)
    const tables = { books: new Map([['book', { id: 'book', progress: { fraction: 0.5, blobRevision: 'old' } }]]), book_files: new Map([['book', { id: 'book', blob: new Blob(['old']), nativeSnapshotPath: 'obsolete-snapshot', blobRevision: 'old' }]]) }
    let tx
    const fakeDb = { objectStoreNames: { contains: name => Object.hasOwn(tables, name) }, transaction() {
        tx = { objectStore(name) { return { get(id) { const request = {}; queueMicrotask(() => { request.result = tables[name].get(id); request.onsuccess?.() }); return request }, put(value) { tables[name].set(value.id, value) } } } }
        setImmediate(() => tx.oncomplete?.())
        return tx
    } }
    const link = new Function('openDB', 'getRevisionOrigin', 'generateRevision', source.slice(start, end).replace('export const', 'const') + '\nreturn relinkBookFile')(async () => fakeDb, async () => 'fixture-origin', () => 'new-revision')
    await link('book', { blob: new Blob(['new']), nativePath: 'selected-file.txt' })
    const book = tables.books.get('book'); const file = tables.book_files.get('book')
    assert.equal(await file.blob.text(), 'new'); assert.equal(file.nativeSnapshotPath, null)
    assert.equal(book.blobRevision, file.blobRevision); assert.equal(book.progress.blobRevision, file.blobRevision)
    assert.equal(book.progress.fraction, 0.5)
})

console.log(`Completed ${results.length} functional regression scenarios.`)
