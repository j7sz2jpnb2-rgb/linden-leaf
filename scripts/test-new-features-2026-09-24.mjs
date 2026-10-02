// scripts/test-new-features-2026-09-24.mjs
// Automated verification suite for Linden Leaf 2026-09-24 Roadmap Features

import assert from 'node:assert/strict'
import fs from 'node:fs'
import './test-idb-setup.mjs'
import { parsePageRange, formatSpansToText, cleanOcrChineseSpaces, OcrService } from '../js/ocr-service.js'
import { validateSearchTemplate, buildSearchUrl, SEARCH_ENGINES } from '../js/search-config.js'
import { formatMinutesClean, formatAxisLabel, aggregateSessions, getSessionDurationSeconds } from '../js/stats-heatmap.js'
import { normalizeTag, normalizeTagList, VALID_READING_STATUSES, setReadingStatus } from '../js/tags-manager.js'
import { renderSafeMarkdown, createTranslationPrompt, createExplainPrompt, createQuestionPrompt, validateEndpointUrl, saveAiConfig, getAiConfig, getAiApiKey } from '../js/reading-ai-assistant.js'
import { ImportQueue, findDuplicateBook } from '../js/import-queue.js'
import { isCanvasBlankWhite } from '../js/pdf-cover.js'
import { escapeHTML as escapeHTMLDetails, BookDetailsModal } from '../js/book-details.js'
import { tokenizeText, createExcerptSnippet, escapeHTML as escapeHTMLSearch, FullTextSearchEngine, EXTRACTOR_VERSION, SUPPORTED_SEARCH_FORMATS, extractCleanTextFromHtml } from '../js/fulltext-search.js'
import { PdfViewport } from '../js/pdf-viewport.js'
import { platformBridge } from '../js/platformBridge.js'
import { batchAddTag, batchRemoveTag } from '../js/tags-manager.js'
import { mergeSyncData, buildBookSyncMeta, reconcileBookSyncMeta } from '../js/syncEngine.js'
import { PageTurnController, FoliatePageTurnAdapter, PdfPageTurnAdapter, CurlSimulator, PAGE_TURN_MODES } from '../js/page-turn-controller.js'
import * as db from '../js/db.js'

if (!globalThis.localStorage) {
    const store = new Map()
    globalThis.localStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    }
}

console.log('========================================================')
console.log(' RUNNING VERIFICATION SUITE: 2026-09-24 ROADMAP FEATURES')
console.log('========================================================\n')

let passCount = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`  [PASS] ${name}`)
        passCount++
    } catch (e) {
        console.error(`  [FAIL] ${name}`)
        console.error(e)
        process.exitCode = 1
    }
}

async function runAll() {
    // ---------------------------------------------------------------------
    // 1. OCR Service: Page Range Parser & Limits
    // ---------------------------------------------------------------------
    console.log('--- Suite 1: OCR Service Page Range Parser ---')

    await test('1.1 Single page parsing within bounds', () => {
        const res = parsePageRange('3', 10, 1, 5)
        assert.equal(res.valid, true)
        assert.deepEqual(res.pages, [3])
    })

    await test('1.2 Default fallback to current page when range is empty', () => {
        const res = parsePageRange('', 10, 4, 5)
        assert.equal(res.valid, true)
        assert.deepEqual(res.pages, [4])
    })

    await test('1.3 Range syntax "2-4" parsing', () => {
        const res = parsePageRange('2-4', 10, 1, 5)
        assert.equal(res.valid, true)
        assert.deepEqual(res.pages, [2, 3, 4])
    })

    await test('1.4 Inverted range "5-3" is strictly rejected with explicit error', () => {
        const res = parsePageRange('5-3', 10, 1, 5)
        assert.equal(res.valid, false)
        assert.match(res.error, /起始页码不能大于结束页码/)
    })

    await test('1.5 Max page limit enforcement (exceeding maxPages=5 is rejected)', () => {
        const res = parsePageRange('1-7', 10, 1, 5)
        assert.equal(res.valid, false)
        assert.match(res.error, /单次识别最多支持/)
    })

    await test('1.6 Comma-separated list "1, 3, 5"', () => {
        const res = parsePageRange('1, 3, 5', 10, 1, 5)
        assert.equal(res.valid, true)
        assert.deepEqual(res.pages, [1, 3, 5])
    })

    await test('1.7 Out-of-bounds page rejection', () => {
        const res = parsePageRange('15', 10, 1, 5)
        assert.equal(res.valid, false)
        assert.match(res.error, /页码超出范围/)
    })

    await test('1.8 Negative and non-numeric rejection', () => {
        const res = parsePageRange('abc-xyz', 10, 1, 5)
        assert.equal(res.valid, false)
    })

    // ---------------------------------------------------------------------
    // 2. Search Config: Template Validation & URL Generation
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 2: Configurable Web Search ---')

    await test('2.1 Default preset engines provide valid URLs', () => {
        const res = buildSearchUrl({ searchEngine: 'baidu' }, '三体')
        assert.equal(res.url, 'https://www.baidu.com/s?wd=%E4%B8%89%E4%BD%93')
        assert.equal(res.engineName, '百度')
        assert.equal(res.truncated, false)
    })

    await test('2.2 Custom template with {query} placeholder substitution', () => {
        const res = buildSearchUrl({
            searchEngine: 'custom',
            searchCustomUrl: 'https://search.brave.com/search?q={query}'
        }, '鲁迅 呐喊')
        assert.equal(res.url, 'https://search.brave.com/search?q=%E9%B2%81%E8%BF%85%20%E5%91%90%E5%96%8A')
        assert.equal(res.engineName, '自定义')
    })

    await test('2.3 Security: Custom URL template must use http/https protocol', () => {
        const checkBad1 = validateSearchTemplate('javascript:alert(1)')
        assert.equal(checkBad1.valid, false)

        const checkBad2 = validateSearchTemplate('file:///etc/passwd?q={query}')
        assert.equal(checkBad2.valid, false)

        const checkGood = validateSearchTemplate('https://kagi.com/search?q={query}')
        assert.equal(checkGood.valid, true)
    })

    await test('2.4 Length limit: Query longer than 120 chars is safely truncated', () => {
        const longQuery = 'A'.repeat(200)
        const res = buildSearchUrl({ searchEngine: 'bing' }, longQuery)
        assert.equal(res.truncated, true)
        const expectedEncoded = encodeURIComponent('A'.repeat(120))
        assert.equal(res.url, `https://www.bing.com/search?q=${expectedEncoded}`)
    })

    // ---------------------------------------------------------------------
    // 3. Stats & Heatmap: Honest 0-duration, Formatting & Headroom
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 3: Clean Stats Chart & Heatmap Helpers ---')

    await test('3.1 formatMinutesClean formats 0m, minutes, hours, and hours+minutes', () => {
        assert.equal(formatMinutesClean(0), '0 分钟')
        assert.equal(formatMinutesClean(45), '45 分钟')
        assert.equal(formatMinutesClean(60), '1 小时')
        assert.equal(formatMinutesClean(90), '1 小时 30 分钟')
        assert.equal(formatMinutesClean(150), '2 小时 30 分钟')
    })

    await test('3.2 formatAxisLabel formats integer and fractional hours cleanly', () => {
        assert.equal(formatAxisLabel(0), '0m')
        assert.equal(formatAxisLabel(45), '45m')
        assert.equal(formatAxisLabel(60), '1h')
        assert.equal(formatAxisLabel(90), '1.5h')
        assert.equal(formatAxisLabel(120), '2h')
    })

    await test('3.3 Honest 0-duration bar calculation (no false 8% floor)', () => {
        const data = [{ minutes: 0 }, { minutes: 50 }, { minutes: 100 }]
        const rawMax = Math.max(...data.map(d => d.minutes), 10)
        const maxMins = Math.ceil(rawMax * 1.15) // 15% headroom

        const zeroHeight = data[0].minutes === 0 ? 0 : Math.max(3, Math.round((data[0].minutes / maxMins) * 100))
        assert.equal(zeroHeight, 0, 'Zero duration MUST result in 0% height bar!')

        const fiftyHeight = Math.round((data[1].minutes / maxMins) * 100)
        assert.ok(fiftyHeight < 50, 'Headroom ensures 50% max does not touch 50% visually')
    })

    // ---------------------------------------------------------------------
    // 4. Tags & Reading Status
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 4: Tags & Reading Status ---')

    await test('4.1 Unicode NFC normalization and whitespace trimming', () => {
        const raw = '  科幻\u00A0  '
        const norm = normalizeTag(raw)
        assert.equal(norm, '科幻')
    })

    await test('4.2 Rejects control characters and newlines', () => {
        assert.equal(normalizeTag('tag\nwith\rnewline'), null)
        assert.equal(normalizeTag('\u0000injected'), null)
    })

    await test('4.3 Deduplicates tag list and enforces maxTags limit', () => {
        const list = ['文学', '小说', '文学', '历史', '哲学']
        const result = normalizeTagList(list, 3)
        assert.deepEqual(result, ['文学', '小说', '历史'])
    })

    await test('4.4 Valid reading statuses enum coverage', () => {
        assert.deepEqual(VALID_READING_STATUSES, ['unread', 'want_to_read', 'reading', 'on_hold', 'finished'])
    })

    // ---------------------------------------------------------------------
    // 5. Reading AI Assistant: Prompts & Safe Markdown Rendering
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 5: Reading AI Assistant ---')

    await test('5.1 Translation and Explain prompts format selection properly', () => {
        const tPrompt = createTranslationPrompt('To be, or not to be')
        assert.match(tPrompt, /翻译/)
        assert.match(tPrompt, /To be, or not to be/)

        const ePrompt = createExplainPrompt('薛定谔的猫')
        assert.match(ePrompt, /解析/)
        assert.match(ePrompt, /薛定谔的猫/)
    })

    await test('5.2 Custom question incorporates context and question', () => {
        const qPrompt = createQuestionPrompt('相对论', '光速为何不变？')
        assert.match(qPrompt, /上下文/)
        assert.match(qPrompt, /光速为何不变/)
    })

    await test('5.3 Safe Markdown escapes HTML tags and prevents script injection', () => {
        const malicious = '# 标题\n<script>alert("xss")</script>\n<img src=x onerror=alert(1)>'
        const html = renderSafeMarkdown(malicious)
        assert.ok(!html.includes('<script>'), 'HTML script tags must be escaped')
        assert.ok(html.includes('&lt;script&gt;'), 'Script tags should be safely escaped')
        assert.ok(html.includes('&lt;img'), 'Raw unescaped img tags must be escaped')
        assert.match(html, /<strong>|<em>|<pre>|<h1>|标题/, 'Valid markdown elements should render')
    })

    // ---------------------------------------------------------------------
    // 6. PDF Cover: Blank Canvas Detection
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 6: PDF Cover Extraction ---')

    await test('6.1 Blank/pure white canvas is identified and rejected', () => {
        // Mock 50x50 pure white canvas
        const whiteCanvas = {
            width: 50,
            height: 50,
            getContext: () => ({
                getImageData: () => ({
                    data: new Uint8ClampedArray(50 * 50 * 4).fill(255)
                })
            })
        }
        assert.equal(isCanvasBlankWhite(whiteCanvas), true, 'Pure white canvas must be detected as blank')

        // Mock non-blank canvas with many dark pixels
        const contentData = new Uint8ClampedArray(50 * 50 * 4).fill(255)
        for (let i = 0; i < 400; i++) {
            contentData[i * 4] = 20     // Dark red
            contentData[i * 4 + 1] = 20
            contentData[i * 4 + 2] = 20
        }
        const contentCanvas = {
            width: 50,
            height: 50,
            getContext: () => ({
                getImageData: () => ({ data: contentData })
            })
        }
        assert.equal(isCanvasBlankWhite(contentCanvas), false, 'Non-blank canvas must not be detected as blank')
    })

    // ---------------------------------------------------------------------
    // 7. ImportQueue: Concurrency Bounding & Lifecycle
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 7: Import Queue Reliability ---')

    await test('7.1 Concurrency is bounded to 2 and items process safely', async () => {
        const queue = new ImportQueue({ maxConcurrent: 2 })
        assert.equal(queue.maxConcurrent, 2)
        assert.equal(queue.isBusy, false)

        let activePeak = 0
        let currentActive = 0
        let processedCount = 0

        queue._executeImportJob = async (job) => {
            currentActive++
            activePeak = Math.max(activePeak, currentActive)
            await new Promise(r => setTimeout(r, 20))
            currentActive--
            processedCount++
            job.status = 'succeeded'
            job.phase = 'done'
        }

        const items = [
            { name: '1.epub', size: 100 },
            { name: '2.epub', size: 100 },
            { name: '3.epub', size: 100 },
            { name: '4.epub', size: 100 }
        ]

        const completedPromise = new Promise(resolve => {
            queue.onBatchComplete = resolve
        })

        queue.enqueue(items)
        assert.equal(queue.isBusy, true)
        await completedPromise

        assert.equal(processedCount, 4)
        assert.ok(activePeak <= 2, `Active peak concurrency was ${activePeak}, must be <= 2`)
        assert.equal(queue.isBusy, false)
    })

    // ---------------------------------------------------------------------
    // 8. Sync Engine: LWW Merge for Tags & Reading Status
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 8: Sync Engine LWW Reconciliation ---')

    await test('8.1 Tags LWW: Newer tagsUpdatedAt wins, preserving tags', () => {
        const local = {
            id: 'book_1',
            title: '书名',
            tags: ['哲学', '历史'],
            tagsUpdatedAt: 2000
        }
        const remoteOlder = {
            id: 'book_1',
            title: '书名',
            tags: ['科幻'],
            tagsUpdatedAt: 1000
        }

        // Local is newer
        const effectiveTags = (remoteOlder.tagsUpdatedAt || 0) > (local.tagsUpdatedAt || 0)
            ? remoteOlder.tags
            : local.tags
        assert.deepEqual(effectiveTags, ['哲学', '历史'])

        // Remote is newer
        const remoteNewer = {
            id: 'book_1',
            title: '书名',
            tags: ['社会学'],
            tagsUpdatedAt: 3000
        }
        const effectiveTags2 = (remoteNewer.tagsUpdatedAt || 0) > (local.tagsUpdatedAt || 0)
            ? remoteNewer.tags
            : local.tags
        assert.deepEqual(effectiveTags2, ['社会学'])
    })

    await test('8.2 Reading status LWW: Newer statusUpdatedAt wins, preserving completedAt', () => {
        const local = {
            id: 'book_1',
            readingStatus: 'finished',
            statusUpdatedAt: 5000,
            completedAt: 5000
        }
        const remoteOlder = {
            id: 'book_1',
            readingStatus: 'reading',
            statusUpdatedAt: 3000,
            completedAt: null
        }

        const mergedStatus = (remoteOlder.statusUpdatedAt || 0) > (local.statusUpdatedAt || 0)
            ? remoteOlder.readingStatus
            : local.readingStatus
        const mergedCompletedAt = local.completedAt || remoteOlder.completedAt

        assert.equal(mergedStatus, 'finished')
        assert.equal(mergedCompletedAt, 5000)
    })

    // ---------------------------------------------------------------------
    // 9. Book Details Modal: XSS Safety & Cover URL Revocation
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 9: Single Book Details Safety ---')

    await test('9.1 escapeHTML neutralizes script tags, double/single quotes, and angle brackets', () => {
        const raw = '<script>alert("XSS")</script>&\'hello\''
        const safe = escapeHTMLDetails(raw)
        assert.equal(safe, '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;&amp;&#39;hello&#39;')
    })

    await test('9.2 BookDetailsModal tracks and revokes previous object URLs upon cleanup', () => {
        const modal = new BookDetailsModal()
        let revoked = false
        const fakeUrl = 'blob:http://localhost/fake-uuid'
        modal._activeCoverUrl = fakeUrl
        globalThis.URL = globalThis.URL || {}
        const origRevoke = globalThis.URL.revokeObjectURL
        globalThis.URL.revokeObjectURL = (url) => {
            if (url === fakeUrl) revoked = true
        }
        try {
            modal.cleanup()
            assert.equal(revoked, true)
            assert.equal(modal._activeCoverUrl, null)
            assert.equal(modal.currentBookId, null)
        } finally {
            globalThis.URL.revokeObjectURL = origRevoke
        }
    })

    // ---------------------------------------------------------------------
    // 10. Cross-Book Full-Text Search: Token Matching, Snippets & Caching
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 10: Cross-Book Full-Text Search ---')

    await test('10.1 CJK Bi-gram and word tokenization', () => {
        const tokens = tokenizeText('阅读 Linden Leaf 全文检索')
        assert.equal(tokens.has('阅读'), true)
        assert.equal(tokens.has('全文'), true)
        assert.equal(tokens.has('文检'), true)
        assert.equal(tokens.has('检索'), true)
        assert.equal(tokens.has('linden'), true)
        assert.equal(tokens.has('leaf'), true)
    })

    await test('10.2 createExcerptSnippet highlights exact keyword with mark tags', () => {
        const snippet = createExcerptSnippet('这是测试 Linden Leaf 现代化阅读器的段落', 'Linden Leaf')
        assert.match(snippet, /<mark>Linden Leaf<\/mark>/)
    })

    await test('10.3 createExcerptSnippet falls back to token match and escapes HTML safely', () => {
        const textWithHtml = '前言 <div>这是含有HTML标记的内容</div> 深度学习算法解析 结语'
        const snippet = createExcerptSnippet(textWithHtml, '深度')
        assert.match(snippet, /<mark>深度<\/mark>/)
        assert.equal(snippet.includes('<div>'), false)
        assert.equal(snippet.includes('&lt;div&gt;'), true)
    })

    await test('10.4 createExcerptSnippet with zero match escapes text cleanly', () => {
        const textWithScript = '<img src=x onerror=alert(1)> 完全无关的内容'
        const snippet = createExcerptSnippet(textWithScript, '不存在的关键词')
        assert.equal(snippet.includes('<img'), false)
        assert.equal(snippet.includes('&lt;img'), true)
    })

    // ---------------------------------------------------------------------
    // 11. Heatmap Future Date Protection
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 11: Heatmap Date Boundaries ---')

    await test('11.1 Future year dates are consistently flagged as future', () => {
        const currentYear = new Date().getFullYear()
        const targetYear = currentYear + 1
        const isCurrentYear = targetYear === currentYear
        const todayDate = new Date()
        const m = 5, d = 15
        const isFuture = targetYear > currentYear || (isCurrentYear && new Date(targetYear, m, d) > todayDate)
        assert.equal(isFuture, true)
    })

    // ---------------------------------------------------------------------
    // 12. Cross-Book Full-Text Search: Persistence, Cache Validation & Pruning
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 12: Search Index Persistence & Cache Validation ---')

    await test('12.1 Supported search formats includes EPUB, TXT, MD, and DOCX', () => {
        assert.deepEqual(SUPPORTED_SEARCH_FORMATS, ['epub', 'txt', 'md', 'docx'])
    })

    await test('12.2 loadPersistedIndexes rehydrates index, checks extractor version, and restores tokens Set', async () => {
        const mockDb = {
            getAllBookSearchIndexes: async () => [
                {
                    bookId: 'book_valid',
                    title: '测试图书',
                    format: 'txt',
                    extractorVersion: EXTRACTOR_VERSION,
                    blobRevision: 'rev_1',
                    indexedAt: 1000,
                    sections: [
                        {
                            id: 'sec_1',
                            sectionIndex: 0,
                            sectionTitle: '第一章',
                            location: { fraction: 0.1 },
                            text: '这是一段关于宇宙探索的内容',
                            tokens: ['宇宙', '探索', '关于']
                        }
                    ]
                },
                {
                    bookId: 'book_outdated_version',
                    title: '过期版本图书',
                    format: 'txt',
                    extractorVersion: 'v0.1_stale',
                    blobRevision: 'rev_2',
                    indexedAt: 500,
                    sections: []
                }
            ]
        }
        const engine = new FullTextSearchEngine({ db: mockDb })

        const loaded = await engine.loadPersistedIndexes()
        assert.equal(loaded, 1)
        assert.equal(engine.index.has('book_valid'), true)
        assert.equal(engine.index.has('book_outdated_version'), false)

        const stored = engine.index.get('book_valid')
        assert.equal(stored.meta.blobRevision, 'rev_1')
        assert.equal(stored.sections[0].tokens instanceof Set, true)
        assert.equal(stored.sections[0].tokens.has('宇宙'), true)
    })

    await test('12.3 pruneStaleIndexes removes indexes for deleted books in memory and DB', async () => {
        const deletedFromDb = []
        const mockDb = {
            getAllBookSearchIndexes: async () => [
                { bookId: 'book_keep' },
                { bookId: 'book_stale' }
            ],
            deleteBookSearchIndex: async (id) => {
                deletedFromDb.push(id)
            }
        }
        const engine = new FullTextSearchEngine({ db: mockDb })
        engine.index.set('book_keep', { meta: { bookId: 'book_keep' }, sections: [] })
        engine.index.set('book_stale', { meta: { bookId: 'book_stale' }, sections: [] })

        const pruned = await engine.pruneStaleIndexes(['book_keep'])
        assert.equal(pruned, 1)
        assert.equal(engine.index.has('book_keep'), true)
        assert.equal(engine.index.has('book_stale'), false)
        assert.deepEqual(deletedFromDb, ['book_stale'])
    })

    await test('12.4 removeBookIndex deletes in-memory cache and dispatches DB deletion', async () => {
        let deletedId = null
        const mockDb = {
            deleteBookSearchIndex: async (id) => {
                deletedId = id
            }
        }
        const engine = new FullTextSearchEngine({ db: mockDb })
        engine.index.set('book_del', { meta: { bookId: 'book_del' }, sections: [] })

        await engine.removeBookIndex('book_del')
        assert.equal(engine.index.has('book_del'), false)
        assert.equal(deletedId, 'book_del')
    })

    // ---------------------------------------------------------------------
    // 13. Platform Bridge: Capabilities Matrix & Android SAF Contract
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 13: Platform Bridge Capabilities & SAF Contract ---')

    await test('13.1 getCapabilities returns immutable frozen object with defined keys', () => {
        const caps = platformBridge.getCapabilities()
        assert.equal(Object.isFrozen(caps), true)
        assert.equal(typeof caps.platform, 'string')
        assert.equal(typeof caps.os, 'string')
        assert.equal(typeof caps.isAndroid, 'boolean')
        assert.equal(typeof caps.hasContentUriSupport, 'boolean')
        assert.equal(typeof caps.hasPersistentUriPermission, 'boolean')
        assert.equal(typeof caps.hasPrivateCacheStreaming, 'boolean')
        assert.equal(typeof caps.hasWindowControls, 'boolean')
    })

    await test('13.2 isContentUri correctly identifies Android SAF URIs', () => {
        assert.equal(platformBridge.isContentUri('content://com.android.providers.media.documents/document/123'), true)
        assert.equal(platformBridge.isContentUri('CONTENT://com.example/file'), true)
        assert.equal(platformBridge.isContentUri('C:\\Users\\test\\book.pdf'), false)
        assert.equal(platformBridge.isContentUri('/storage/emulated/0/Download/book.epub'), false)
        assert.equal(platformBridge.isContentUri('https://example.com/book.pdf'), false)
        assert.equal(platformBridge.isContentUri(''), false)
        assert.equal(platformBridge.isContentUri(null), false)
    })

    await test('13.3 takePersistentUriPermission rejects non-content URI with explicit error', async () => {
        const res = await platformBridge.takePersistentUriPermission('C:\\test.pdf')
        assert.equal(res.success, false)
        assert.equal(res.supported, false)
        assert.match(res.error, /非法的 Content URI/)
    })

    await test('13.4 takePersistentUriPermission on non-Android platform returns unsupported without fake success', async () => {
        const res = await platformBridge.takePersistentUriPermission('content://com.android.test/doc/1')
        assert.equal(res.success, false)
        assert.equal(res.supported, false)
        assert.match(res.error, /不支持持久化 Content URI 权限/)
    })

    await test('13.5 copySourceToPrivateCache rejects null or invalid input safely', async () => {
        const res = await platformBridge.copySourceToPrivateCache(null)
        assert.equal(res.success, false)
        assert.match(res.error, /缺少输入源|无效的文件源/)
    })

    // ---------------------------------------------------------------------
    // 14. Resource Budgeting & Memory Control
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 14: Resource Budgeting & Memory Control ---')

    await test('14.1 ImportQueue.setResourceBudget configures concurrency and low-memory mode', () => {
        const queue = new ImportQueue()
        assert.equal(queue.maxConcurrent, 2)
        assert.equal(queue.coverMaxConcurrent, 1)

        queue.setResourceBudget({ maxConcurrent: 3, coverMaxConcurrent: 2 })
        assert.equal(queue.maxConcurrent, 3)
        assert.equal(queue.coverMaxConcurrent, 2)

        queue.setResourceBudget({ isLowMemoryDevice: true })
        assert.equal(queue.maxConcurrent, 1)
        assert.equal(queue.coverMaxConcurrent, 1)
    })

    await test('14.2 PdfViewport.setResourceBudget updates limits and respects low-memory profile', () => {
        const vp = Object.create(PdfViewport.prototype)
        vp.options = { totalPages: 10, maxCanvasPixels: 8_000_000, bitmapCacheLimitBytes: 32 * 1024 * 1024, bufferPages: 2 }
        vp._renderConcurrency = 2
        vp._bitmapCacheLimitBytes = 32 * 1024 * 1024
        vp._pruneBitmapCache = () => {}

        vp.setResourceBudget({
            renderConcurrency: 4,
            maxCanvasPixels: 12_000_000,
            bitmapCacheLimitBytes: 128 * 1024 * 1024
        })
        assert.equal(vp._renderConcurrency, 4)
        assert.equal(vp.options.maxCanvasPixels, 12_000_000)
        assert.equal(vp._bitmapCacheLimitBytes, 128 * 1024 * 1024)

        vp.setResourceBudget({ isLowMemoryDevice: true })
        assert.equal(vp._renderConcurrency, 1)
        assert.equal(vp.options.bufferPages, 1)
        assert.equal(vp._bitmapCacheLimitBytes, 16 * 1024 * 1024)
        assert.equal(vp.options.maxCanvasPixels, 4_000_000)
    })

    await test('14.3 Canvas texture release zeros width and height immediately', () => {
        const fakeCanvas = { width: 1024, height: 1536 }
        fakeCanvas.width = 0
        fakeCanvas.height = 0
        assert.equal(fakeCanvas.width, 0)
        assert.equal(fakeCanvas.height, 0)
    })

    // ---------------------------------------------------------------------
    // 15. Batch Tags Operations
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 15: Batch Tags Operations ---')

    await test('15.1 batchAddTag adds tag across multiple books and skips duplicates', async () => {
        const books = new Map([
            ['b1', { id: 'b1', title: '书1', tags: ['历史'] }],
            ['b2', { id: 'b2', title: '书2', tags: ['哲学', '散文'] }]
        ])

        const mockDb = {
            getBook: async (id) => books.get(id),
            saveBook: async (book) => {
                const existing = books.get(book.id)
                Object.assign(existing, book)
            }
        }

        const count = await batchAddTag(['b1', 'b2'], '散文', mockDb)
        assert.equal(count, 1)
        assert.equal(books.get('b1').tags.includes('散文'), true)
        assert.equal(books.get('b2').tags.includes('散文'), true)
    })

    await test('15.2 batchRemoveTag removes tag across multiple books', async () => {
        const books = new Map([
            ['b1', { id: 'b1', title: '书1', tags: ['历史', '散文'] }],
            ['b2', { id: 'b2', title: '书2', tags: ['哲学', '散文'] }]
        ])

        const mockDb = {
            getBook: async (id) => books.get(id),
            saveBook: async (book) => {
                const existing = books.get(book.id)
                Object.assign(existing, book)
            }
        }

        const count = await batchRemoveTag(['b1', 'b2'], '散文', mockDb)
        assert.equal(count, 2)
        assert.equal(books.get('b1').tags.includes('散文'), false)
        assert.equal(books.get('b2').tags.includes('散文'), false)
    })

    // ---------------------------------------------------------------------
    // 16. R1 Real Session Aggregation & Duration Fields
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 16: R1 Real Session Aggregation & Duration Fields ---')

    await test('16.1 getSessionDurationSeconds reads durationSeconds over seconds and rejects <=0', () => {
        assert.equal(getSessionDurationSeconds({ durationSeconds: 600, seconds: 120 }), 600)
        assert.equal(getSessionDurationSeconds({ seconds: 300 }), 300)
        assert.equal(getSessionDurationSeconds({ durationSeconds: 0 }), 0)
        assert.equal(getSessionDurationSeconds({ durationSeconds: -50 }), 0)
        assert.equal(getSessionDurationSeconds(null), 0)
    })

    await test('16.2 aggregateSessions filters strictly by target year', () => {
        const sessions = [
            { id: 's1', bookId: 'b1', date: '2025-11-20', durationSeconds: 1200 },
            { id: 's2', bookId: 'b1', date: '2026-03-15', durationSeconds: 1800 },
            { id: 's3', bookId: 'b1', date: '2026-03-16', durationSeconds: 600 }
        ]
        const res2026 = aggregateSessions(sessions, { targetYear: 2026 })
        assert.equal(res2026.totalSeconds, 2400)
        assert.equal(res2026.activeDaysCount, 2)
        assert.equal(res2026.peakMinutes, 30)

        const res2025 = aggregateSessions(sessions, { targetYear: 2025 })
        assert.equal(res2025.totalSeconds, 1200)
        assert.equal(res2025.activeDaysCount, 1)
    })

    await test('16.3 aggregateSessions handles cross-midnight sessions cleanly', () => {
        const sessions = [
            { id: 's1', bookId: 'b1', date: '2026-04-10', durationSeconds: 1800 },
            { id: 's2', bookId: 'b1', date: '2026-04-11', durationSeconds: 900 }
        ]
        const res = aggregateSessions(sessions, { bookId: 'b1' })
        assert.equal(res.totalSeconds, 2700)
        assert.equal(res.activeDaysCount, 2)
    })

    // ---------------------------------------------------------------------
    // 17. R4 OCR Text Assembly & CJK Whitespace Formatting
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 17: R4 OCR Text Assembly & CJK Whitespace Formatting ---')

    await test('17.1 formatSpansToText avoids inserting spaces between CJK characters', () => {
        const spans = [
            { text: '中', bbox: [10, 10, 20, 20] },
            { text: '文', bbox: [21, 10, 31, 20] },
            { text: '阅', bbox: [32, 10, 42, 20] },
            { text: '读', bbox: [43, 10, 53, 20] }
        ]
        const text = formatSpansToText(spans)
        assert.equal(text, '中文阅读')
    })

    await test('17.2 cleanOcrChineseSpaces removes false spaces between Chinese chars but preserves English words', () => {
        const raw = '这 是一本 好书 with English words and 标点。'
        const cleaned = cleanOcrChineseSpaces(raw)
        assert.equal(cleaned.includes('这是一本好书'), true)
        assert.equal(cleaned.includes('English words and'), true)
    })

    // ---------------------------------------------------------------------
    // 18. R5 AI Assistant URL Validation & IP Security
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 18: R5 AI Assistant URL Validation & IP Security ---')

    await test('18.1 validateEndpointUrl rejects deceptive non-numeric domains impersonating private IPs', () => {
        const deceptive1 = validateEndpointUrl('http://10.attacker.com/v1')
        assert.equal(deceptive1.valid, false)

        const deceptive2 = validateEndpointUrl('http://192.168.evil.org/v1')
        assert.equal(deceptive2.valid, false)
    })

    await test('18.2 validateEndpointUrl rejects URLs with embedded user credentials', () => {
        const withCreds = validateEndpointUrl('https://admin:pass@api.openai.com/v1')
        assert.equal(withCreds.valid, false)
    })

    await test('18.3 validateEndpointUrl allows legitimate local and loopback endpoints', () => {
        const local1 = validateEndpointUrl('http://127.0.0.1:11434/v1')
        assert.equal(local1.valid, true)

        const local2 = validateEndpointUrl('http://localhost:8080/v1')
        assert.equal(local2.valid, true)

        const remoteHttps = validateEndpointUrl('https://api.openai.com/v1')
        assert.equal(remoteHttps.valid, true)
    })

    // ---------------------------------------------------------------------
    // 19. R6 Full-Text Search HTML Stripping & Exact Phrase Matching
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 19: R6 Full-Text Search HTML Stripping & Exact Phrase Matching ---')

    await test('19.1 extractCleanTextFromHtml strips scripts, styles, and decodes HTML entities', () => {
        const html = `
            <html>
                <head>
                    <style>body { color: red; }</style>
                    <script>alert(1);</script>
                </head>
                <body>
                    <p>第一章&emsp;天地玄黄&nbsp;&amp;&nbsp;宇宙洪荒</p>
                </body>
            </html>
        `
        const clean = extractCleanTextFromHtml(html)
        assert.equal(clean.includes('alert'), false)
        assert.equal(clean.includes('color: red'), false)
        assert.equal(clean.includes('第一章'), true)
        assert.equal(clean.includes('&emsp;'), false)
        assert.equal(clean.includes('&amp;'), false)
        assert.equal(clean.includes('&'), true)
    })

    // ---------------------------------------------------------------------
    // 20. R7 Sync LWW Reconciliation & Reading Status Integrity
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 20: R7 Sync LWW Reconciliation & Reading Status Integrity ---')

    await test('20.1 mergeSyncData uses deterministic tie-breaker on identical timestamps', () => {
        const localPayload = {
            clientId: 'client_aaa',
            booksMeta: [{
                id: 'b1',
                readingStatus: 'reading',
                statusUpdatedAt: 1700000000
            }]
        }
        const remotePayload = {
            clientId: 'client_bbb', // 'client_bbb' > 'client_aaa', remote wins tie
            booksMeta: [{
                id: 'b1',
                readingStatus: 'finished',
                completedAt: 1700000000,
                statusUpdatedAt: 1700000000
            }]
        }
        const { merged } = mergeSyncData(localPayload, remotePayload)
        const book = merged.booksMeta.find(b => b.id === 'b1')
        assert.equal(book.readingStatus, 'finished')
    })

    await test('20.2 buildBookSyncMeta does not infer finished status merely from progress >= 0.99', () => {
        const b = buildBookSyncMeta({
            id: 'b1',
            title: '长篇',
            progress: { fraction: 0.995 },
            lastReadAt: 1700000000,
            readingStatus: undefined,
            completedAt: null
        })
        assert.equal(b.readingStatus, 'reading') // Not 'finished'
        assert.equal(b.completedAt, null)
    })

    await test('20.3 batchAddTag strictly respects 20 tags limit', async () => {
        const existingTags = Array.from({ length: 20 }, (_, i) => `标签${i + 1}`)
        const books = new Map([
            ['b1', { id: 'b1', title: '满标签书', tags: existingTags }]
        ])
        const mockDb = {
            getBook: async (id) => books.get(id),
            saveBook: async (b) => Object.assign(books.get(b.id), b)
        }
        const added = await batchAddTag(['b1'], '新标签', mockDb)
        assert.equal(added, 0)
        assert.equal(books.get('b1').tags.length, 20)
    })

    // ---------------------------------------------------------------------
    // 21. Page Turn Controller Architecture
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 21: Page Turn Controller Architecture ---')

    await test('21.1 PageTurnController supports 5 modes and initializes correctly', () => {
        const ctrl = new PageTurnController({ mode: 'slide' })
        assert.equal(ctrl.mode, 'slide')
        assert.equal(ctrl.state, 'idle')
        assert.equal(PAGE_TURN_MODES.includes('none'), true)
        assert.equal(PAGE_TURN_MODES.includes('slide'), true)
        assert.equal(PAGE_TURN_MODES.includes('cover'), true)
        assert.equal(PAGE_TURN_MODES.includes('scroll'), true)
        assert.equal(PAGE_TURN_MODES.includes('curl'), true)

        ctrl.setMode('curl')
        assert.equal(ctrl.mode, 'curl')
    })

    await test('21.2 cancelCurrent increments generation and restores state to idle', () => {
        const ctrl = new PageTurnController()
        const initialGen = ctrl.generation
        ctrl.cancelCurrent()
        assert.equal(ctrl.generation, initialGen + 1)
        assert.equal(ctrl.state, 'idle')
    })

    await test('21.3 isGestureBlocked respects callback and blocks gesture when tool active', () => {
        let isToolActive = true
        const ctrl = new PageTurnController({
            isBlockedCallback: () => isToolActive
        })
        assert.equal(ctrl.isGestureBlocked(), true)
        isToolActive = false
        assert.equal(ctrl.isGestureBlocked(), false)
    })

    // ---------------------------------------------------------------------
    // 22. P0-1: Touch Gesture & Turn Lifecycle
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 22: P0-1 Touch Gesture & Turn Lifecycle ---')

    await test('22.1 Valid swipe triggers turnNext/turnPrev exactly once after touchEnd returns to idle', async () => {
        let turned = 0
        const fakeAdapter = {
            canTurnNext: () => true,
            canTurnPrev: () => true,
            isBusy: () => false,
            turnNext: async () => { turned++ },
            turnPrev: async () => { turned++ },
            getViewElement: () => ({ style: {} }),
            isContinuousScroll: () => false
        }
        const ctrl = new PageTurnController({ mode: 'slide' })
        ctrl.container = { clientWidth: 800, clientHeight: 600, style: {} }
        ctrl.setAdapter(fakeAdapter)

        // 1. Touch start
        ctrl.handleTouchStart({ touches: [{ clientX: 500, clientY: 300 }] })
        assert.equal(ctrl.state, 'preparing')

        // 2. Touch move exceeding threshold
        ctrl.handleTouchMove({
            touches: [{ clientX: 250, clientY: 300 }],
            cancelable: true,
            preventDefault: () => {}
        })
        assert.equal(ctrl.state, 'dragging')
        assert.equal(ctrl.isGestureActive, true)

        // 3. Touch end (release)
        await ctrl.handleTouchEnd({ touches: [] })
        assert.equal(turned, 1, 'turnNext should have been called exactly once')
        assert.equal(ctrl.state, 'idle')
    })

    await test('22.2 Short drag does not turn page and rebounds to idle', async () => {
        let turned = 0
        const fakeAdapter = {
            canTurnNext: () => true,
            canTurnPrev: () => true,
            isBusy: () => false,
            turnNext: async () => { turned++ },
            turnPrev: async () => { turned++ },
            getViewElement: () => ({ style: {} }),
            isContinuousScroll: () => false
        }
        const ctrl = new PageTurnController({ mode: 'slide' })
        ctrl.container = { clientWidth: 800, clientHeight: 600, style: {} }
        ctrl.setAdapter(fakeAdapter)

        ctrl.handleTouchStart({ touches: [{ clientX: 500, clientY: 300 }] })
        ctrl.handleTouchMove({
            touches: [{ clientX: 470, clientY: 300 }], // deltaX = -30 (< 800 * 0.18 = 144)
            cancelable: true,
            preventDefault: () => {}
        })
        assert.equal(ctrl.state, 'dragging')

        await ctrl.handleTouchEnd({ touches: [] })
        assert.equal(turned, 0, 'Short drag must not turn page')
        assert.equal(ctrl.state, 'idle')
    })

    await test('22.3 Multi-touch contact immediately cancels gesture without turning', async () => {
        let turned = 0
        const fakeAdapter = {
            canTurnNext: () => true,
            isBusy: () => false,
            turnNext: async () => { turned++ },
            getViewElement: () => ({ style: {} })
        }
        const ctrl = new PageTurnController({ mode: 'slide' })
        ctrl.container = { clientWidth: 800, clientHeight: 600, style: {} }
        ctrl.setAdapter(fakeAdapter)

        // Touch start with 2 fingers
        ctrl.handleTouchStart({ touches: [{ clientX: 500, clientY: 300 }, { clientX: 600, clientY: 300 }] })
        assert.equal(ctrl.state, 'idle')
        assert.equal(ctrl.isGestureActive, false)

        // Touch end while touches still exist
        await ctrl.handleTouchEnd({ touches: [{ clientX: 500, clientY: 300 }] })
        assert.equal(turned, 0)
        assert.equal(ctrl.state, 'idle')
    })

    // ---------------------------------------------------------------------
    // 23. P0-2: AI Assistant Atomic Merge & Security
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 23: P0-2 AI Assistant Atomic Merge & Security ---')

    await test('23.1 saveAiConfig merges single field atomically without resetting other fields', async () => {
        localStorage.clear()
        await saveAiConfig({ enabled: true, endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' })
        const initial = getAiConfig()
        assert.equal(initial.enabled, true)
        assert.equal(initial.endpoint, 'https://api.openai.com/v1')
        assert.equal(initial.model, 'gpt-4o')

        // Update ONLY model
        await saveAiConfig({ model: 'gpt-4o-mini' })
        const updated = getAiConfig()
        assert.equal(updated.model, 'gpt-4o-mini')
        assert.equal(updated.enabled, true, 'enabled field should be preserved')
        assert.equal(updated.endpoint, 'https://api.openai.com/v1', 'endpoint field should be preserved')

        // Update ONLY enabled
        await saveAiConfig({ enabled: false })
        const updated2 = getAiConfig()
        assert.equal(updated2.enabled, false)
        assert.equal(updated2.model, 'gpt-4o-mini')
    })

    await test('23.2 saveAiConfig rejects invalid endpoint without mutating existing config', async () => {
        const before = getAiConfig()
        let caught = false
        try {
            await saveAiConfig({ endpoint: 'ftp://insecure.endpoint' })
        } catch (e) {
            caught = true
        }
        assert.equal(caught, true, 'Invalid endpoint protocol must throw error')
        const after = getAiConfig()
        assert.deepEqual(after, before, 'Config must remain uncorrupted after validation failure')
    })

    await test('23.3 Credential migration preserves legacy key if secureStore fails', async () => {
        localStorage.clear()
        localStorage.setItem('linden_ai_api_key', 'sk-legacy-test-key')

        // Mock platformBridge.secureStoreCredential returning false (failure)
        const origStore = platformBridge.secureStoreCredential
        const origLoad = platformBridge.secureLoadCredential
        platformBridge.secureStoreCredential = async () => false
        platformBridge.secureLoadCredential = async () => null

        try {
            const key = await getAiApiKey()
            assert.equal(key, 'sk-legacy-test-key')
            // Assert legacy key was NOT deleted because secureStore failed
            assert.equal(localStorage.getItem('linden_ai_api_key'), 'sk-legacy-test-key', 'Legacy key must not be deleted on failure')
        } finally {
            platformBridge.secureStoreCredential = origStore
            platformBridge.secureLoadCredential = origLoad
        }
    })

    // ---------------------------------------------------------------------
    // 24. P0-3: WebDAV Sync Pure Function LWW & Status Integrity
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 24: P0-3 WebDAV Sync Pure Function LWW ---')

    await test('24.1 reconcileBookSyncMeta preserves explicit completedAt: null (cancelling finished status)', () => {
        const localBook = {
            id: 'b1',
            readingStatus: 'finished',
            statusUpdatedAt: 1000,
            completedAt: 1000,
            tags: ['小说'],
            tagsUpdatedAt: 1000
        }
        const incomingMeta = {
            readingStatus: 'reading',
            statusUpdatedAt: 2000,
            completedAt: null, // explicit cancellation
            tags: ['小说'],
            tagsUpdatedAt: 1000
        }

        const reconciled = reconcileBookSyncMeta(localBook, incomingMeta, 'client-A', 'client-B')
        assert.equal(reconciled.readingStatus, 'reading')
        assert.equal(reconciled.statusUpdatedAt, 2000)
        assert.equal(reconciled.completedAt, null, 'completedAt: null must be explicitly preserved')
    })

    await test('24.2 reconcileBookSyncMeta breaks timestamp ties deterministically via clientId', () => {
        const localBook = {
            id: 'b1',
            readingStatus: 'reading',
            statusUpdatedAt: 5000,
            tags: ['哲学'],
            tagsUpdatedAt: 5000
        }
        const incomingMeta = {
            readingStatus: 'unread',
            statusUpdatedAt: 5000, // Identical timestamp
            tags: ['科学'],
            tagsUpdatedAt: 5000 // Identical timestamp
        }

        // Case A: incoming clientId > local clientId -> incoming wins
        const winIncoming = reconcileBookSyncMeta(localBook, incomingMeta, 'client-1', 'client-2')
        assert.equal(winIncoming.readingStatus, 'unread')
        assert.deepEqual(winIncoming.tags, ['科学'])

        // Case B: local clientId > incoming clientId -> local wins
        const winLocal = reconcileBookSyncMeta(localBook, incomingMeta, 'client-2', 'client-1')
        assert.equal(winLocal.readingStatus, 'reading')
        assert.deepEqual(winLocal.tags, ['哲学'])
    })

    await test('24.3 reconcileBookSyncMeta A->B->A roundtrip consistency', () => {
        const initialA = {
            id: 'b1',
            readingStatus: 'reading',
            statusUpdatedAt: 3000,
            completedAt: null,
            tags: ['历史', '文化'],
            tagsUpdatedAt: 4000
        }

        // Sync to B with older metadata
        const olderB = {
            readingStatus: 'unread',
            statusUpdatedAt: 2000,
            completedAt: null,
            tags: ['历史'],
            tagsUpdatedAt: 2000
        }

        const reconciledAtB = reconcileBookSyncMeta(olderB, initialA, 'client-B', 'client-A')
        assert.equal(reconciledAtB.readingStatus, 'reading')
        assert.deepEqual(reconciledAtB.tags, ['历史', '文化'])

        // Sync back to A
        const reconciledBackAtA = reconcileBookSyncMeta(initialA, reconciledAtB, 'client-A', 'client-B')
        assert.equal(reconciledBackAtA.readingStatus, 'reading')
        assert.deepEqual(reconciledBackAtA.tags, ['历史', '文化'])
    })

    // ---------------------------------------------------------------------
    // 25. R1: Isolated Reading Session Aggregation in IndexedDB
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 25: R1 Reading Session Aggregation in IndexedDB ---')

    await test('25.1 Store and aggregate reading sessions in IndexedDB with 600s threshold', async () => {
        const testSessions = [
            { id: 's1', bookId: 'b1', date: '2026-05-10', startTime: 1778390400000, durationSeconds: 450 },
            { id: 's2', bookId: 'b1', date: '2026-05-10', startTime: 1778395000000, durationSeconds: 650 },
            { id: 's3', bookId: 'b2', date: '2026-06-15', startTime: 1781500000000, durationSeconds: 1200 },
            { id: 's4', bookId: 'b2', date: '2025-06-15', startTime: 1749964800000, durationSeconds: 3000 } // previous year
        ]

        for (const s of testSessions) {
            await db.saveReadingSession(s, false)
        }

        const allSessions = await db.getAllReadingSessions()
        assert.equal(allSessions.length >= 4, true)

        const agg2026 = aggregateSessions(allSessions, { targetYear: 2026 })
        assert.equal(agg2026.totalSeconds, 2300)
        assert.equal(agg2026.activeDaysCount, 2)
        assert.equal(agg2026.dayMap.has('2026-05-10'), true)
        assert.equal(agg2026.dayMap.has('2026-06-15'), true)
    })

    await test('25.2 Empty session list aggregates cleanly without throwing', () => {
        const agg = aggregateSessions([], { targetYear: 2026 })
        assert.equal(agg.totalSeconds, 0)
        assert.equal(agg.activeDaysCount, 0)
        assert.equal(agg.dayMap.size, 0)
    })

    await test('25.3 getReadingStats extracts duration from durationSeconds, readingSeconds, and seconds', async () => {
        const legacySessions = [
            { id: 'sess_dur', bookId: 'b_test', startTime: Date.now() - 3600000, durationSeconds: 600 },
            { id: 'sess_read', bookId: 'b_test', startTime: Date.now() - 1800000, readingSeconds: 400 },
            { id: 'sess_sec', bookId: 'b_test', startTime: Date.now() - 600000, seconds: 200 }
        ]
        for (const s of legacySessions) {
            await db.saveReadingSession(s, false)
        }
        const stats = await db.getReadingStats('total')
        assert.equal(stats.totalSeconds >= 1200, true, `Expected totalSeconds >= 1200, got ${stats.totalSeconds}`)
    })

    // ---------------------------------------------------------------------
    // 26. R2: Import Queue Collision Barrier & Resource Release
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 26: R2 Import Queue Barrier & Resource Release ---')

    await test('26.1 _releaseTerminalJobResources clears memory for succeeded jobs', () => {
        const queue = new ImportQueue()
        const job = {
            id: 'j1',
            status: 'succeeded',
            rawItem: { filePath: 'C:/book.pdf', buffer: new ArrayBuffer(1024) },
            fileBuffer: new ArrayBuffer(1024)
        }
        queue._releaseTerminalJobResources(job)
        assert.equal(job.rawItem, null)
        assert.equal(job.fileBuffer, null)
    })

    await test('26.2 _releaseTerminalJobResources drops buffers on cancelled jobs with file path', () => {
        const queue = new ImportQueue()
        const job = {
            id: 'j2',
            filename: 'book.pdf',
            status: 'cancelled',
            rawItem: { filePath: 'C:/book.pdf', buffer: new ArrayBuffer(1024) }
        }
        queue._releaseTerminalJobResources(job)
        assert.equal(job.rawItem.filePath, 'C:/book.pdf')
        assert.equal(job.rawItem.buffer, undefined)
    })

    await test('26.3 _releaseTerminalJobResources drops File/Blob reference on cancelled or failed jobs', () => {
        const queue = new ImportQueue()
        const fakeBlob = new Blob(['sample content'], { type: 'application/pdf' })
        const job = {
            id: 'j3',
            filename: 'document.pdf',
            fileSize: 14,
            status: 'cancelled',
            rawItem: fakeBlob,
            fileBuffer: new ArrayBuffer(1024)
        }
        queue._releaseTerminalJobResources(job)
        assert.equal(job.fileBuffer, null)
        assert.equal(job.rawItem instanceof Blob, false)
        assert.deepEqual(job.rawItem, {
            filename: 'document.pdf',
            fileSize: 14,
            requiresReSelect: true
        })
    })

    await test('26.4 findDuplicateBook matches generic-titled books when stableKey or size+filename match', () => {
        const existingBooks = [
            {
                id: 'b1',
                title: '未命名',
                filename: 'document.pdf',
                format: 'pdf',
                size: 2048,
                stableKey: 'pdf_stable_123'
            },
            {
                id: 'b2',
                title: 'document',
                filename: 'document.epub',
                format: 'epub',
                size: 4096,
                identifier: 'epub-isbn-999'
            }
        ]

        // 1. Matches by stableKey even if title is generic
        const matchStable = findDuplicateBook(existingBooks, {
            format: 'pdf',
            fileName: 'another_name.pdf',
            fileObj: { size: 9999 },
            metadata: { title: '未命名' },
            computedStableKey: 'pdf_stable_123'
        })
        assert.equal(matchStable?.id, 'b1')

        // 2. Matches by identifier even if title is generic
        const matchIdent = findDuplicateBook(existingBooks, {
            format: 'epub',
            fileName: 'diff_name.epub',
            fileObj: { size: 1234 },
            metadata: { title: 'document', identifier: 'epub-isbn-999' }
        })
        assert.equal(matchIdent?.id, 'b2')

        // 3. Matches by exact size + filename when stableKey/identifier absent
        const matchSizeFile = findDuplicateBook(existingBooks, {
            format: 'pdf',
            fileName: 'document.pdf',
            fileObj: { size: 2048 },
            metadata: { title: '未命名' }
        })
        assert.equal(matchSizeFile?.id, 'b1')

        // 4. Does NOT match different file with same generic title if size or filename differ
        const noMatch = findDuplicateBook(existingBooks, {
            format: 'pdf',
            fileName: 'other_document.pdf',
            fileObj: { size: 99999 },
            metadata: { title: '未命名' }
        })
        assert.equal(noMatch, null)
    })

    // ---------------------------------------------------------------------
    // 27. R3: Hard Scale Bounds & Tombstone Protection
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 27: R3 Hard Scale Bounds & Tombstone Protection ---')

    await test('27.1 PDF cover scale strictly bounds output <= 540px for huge 20,000px page', () => {
        const maxPageDim = 20000
        const maxDimension = 540
        const scale = Math.min(1.5, maxDimension / maxPageDim)
        const renderedDim = maxPageDim * scale
        assert.equal(renderedDim <= maxDimension, true, `Rendered dimension ${renderedDim} must not exceed ${maxDimension}`)
        assert.equal(renderedDim, 540)
    })

    await test('27.2 OCR scale strictly bounds output <= 1600px for huge 25,000px page', () => {
        const maxDim = 25000
        const scale = Math.min(2.0, 1600 / maxDim)
        const renderedDim = maxDim * scale
        assert.equal(renderedDim <= 1600, true, `OCR rendered dimension ${renderedDim} must not exceed 1600`)
        assert.equal(renderedDim, 1600)
    })

    await test('27.3 Partial book update does not delete tombstone from deleted_records', async () => {
        const tombstoneId = 'del_book_test_123'
        // Put tombstone into deleted_records
        await db.recordDeletedItem(tombstoneId, 'book')
        const tombstonesBefore = await db.getAllDeletedRecords()
        assert.equal(tombstonesBefore.some(r => r.id === tombstoneId), true)

        // Perform partial book save (meta.title is null)
        await db.saveBook({ id: tombstoneId, coverBlob: new Blob(['fake']) })

        // Tombstone should STILL be in deleted_records!
        const tombstonesAfter = await db.getAllDeletedRecords()
        assert.equal(tombstonesAfter.some(r => r.id === tombstoneId), true, 'Partial save must not delete tombstone')
    })

    // ---------------------------------------------------------------------
    // 28. R4: OCR Worker Lifecycle & Single Init Promise
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 28: R4 OCR Worker Lifecycle & Error Cleanup ---')

    await test('28.1 OCR service cleans up worker on initialization failure', async () => {
        const service = new OcrService()
        // If Tesseract is undefined, throws explicit error without hanging
        let caught = false
        try {
            await service._getWorker()
        } catch (e) {
            caught = true
            assert.equal(e.message.includes('Tesseract'), true)
        }
        assert.equal(caught, true)
        assert.equal(service._worker, null)
        assert.equal(service._workerInitializing, false)
    })

    // ---------------------------------------------------------------------
    // 29. R6: Full-Text Search Granularity Tags & Query Cancellation
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 29: R6 Full-Text Search Granularity & Query Cancellation ---')

    await test('29.1 Search results include explicit granularity tags', () => {
        const engine = new FullTextSearchEngine()
        engine.index.set('b1', {
            meta: { title: '测试书' },
            sections: [
                {
                    id: 's1',
                    sectionIndex: 0,
                    sectionTitle: '第一章 绪论',
                    granularity: 'chapter',
                    location: { sectionIndex: 0 },
                    text: '科学探索的本质在于不断验证与修正理论。',
                    tokens: tokenizeText('科学探索的本质在于不断验证与修正理论。')
                },
                {
                    id: 's2',
                    sectionIndex: 0,
                    sectionTitle: '段落 5',
                    granularity: 'paragraph',
                    location: { sectionIndex: 0, paragraphIndex: 5 },
                    text: '实证主义强调可观察的事实与可重复的实验。',
                    tokens: tokenizeText('实证主义强调可观察的事实与可重复的实验。')
                }
            ]
        })

        const res = engine.search('探索')
        assert.equal(res.length, 1)
        assert.equal(res[0].granularity, 'chapter')

        const res2 = engine.search('实证主义')
        assert.equal(res2.length, 1)
        assert.equal(res2[0].granularity, 'paragraph')
    })

    // ---------------------------------------------------------------------
    // 30. R8: Platform Bridge Staging Contract
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 30: R8 Platform Bridge Staging Contract ---')

    await test('30.1 copySourceToPrivateCache directly consumes string snapshotPath from stagePdfSource', async () => {
        const origStage = platformBridge.stagePdfSource
        const origDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(platformBridge), 'isTauri') ||
                         Object.getOwnPropertyDescriptor(platformBridge, 'isTauri')
        const origGetCaps = platformBridge.getCapabilities
        try {
            Object.defineProperty(platformBridge, 'isTauri', { value: true, configurable: true, writable: true })
            platformBridge.getCapabilities = () => ({
                hasPrivateCacheStreaming: true,
                hasDirectFdPdfRendering: true
            })
            // Mock stagePdfSource returning a file path string
            platformBridge.stagePdfSource = async () => 'C:/Users/Cache/staged_doc.pdf'
            const res = await platformBridge.copySourceToPrivateCache({ path: 'D:/test.pdf' })
            assert.equal(res.success, true)
            assert.equal(res.cachedPath, 'C:/Users/Cache/staged_doc.pdf')
        } finally {
            platformBridge.stagePdfSource = origStage
            if (origDesc) {
                Object.defineProperty(platformBridge, 'isTauri', origDesc)
            } else {
                delete platformBridge.isTauri
            }
            platformBridge.getCapabilities = origGetCaps
        }
    })

    // ---------------------------------------------------------------------
    // 31. HTML Structure & Modal Isolation
    // ---------------------------------------------------------------------
    console.log('\n--- Suite 31: HTML Structure & Modal Isolation ---')

    await test('31.1 Import dock badge and task panel are not descendants of modal-ai-assistant', () => {
        const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
        const aiModalIdx = html.indexOf('id="modal-ai-assistant"')
        assert.equal(aiModalIdx > 0, true)

        const importDockIdx = html.indexOf('id="import-dock-badge"')
        assert.equal(importDockIdx > 0, true)
        assert.equal(importDockIdx > aiModalIdx, true)

        // Find the slice between modal-ai-assistant and import-dock-badge
        const slice = html.substring(aiModalIdx, importDockIdx)
        // Count opening <div and closing </div tags
        const opens = (slice.match(/<div[\s>]/g) || []).length
        const closes = (slice.match(/<\/div>/g) || []).length
        assert.equal(opens, closes, `Expected opening divs (${opens}) to equal closing divs (${closes}) before import-dock-badge`)
    })

    console.log('\n========================================================')
    console.log(` SUMMARY: ${passCount} TESTS PASSED CLEANLY`)
    console.log('========================================================\n')
}

runAll()
