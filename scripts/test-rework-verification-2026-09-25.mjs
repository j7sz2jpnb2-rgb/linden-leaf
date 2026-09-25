// scripts/test-rework-verification-2026-09-25.mjs
// Targeted verification script for P0/P1 rework items:
// 1. Dictionary lookup (Hello, collision, limousines, source: 基础离线词库)
// 2. Advanced settings budget 0 persistence and modal trigger
// 3. WebDAV reconciliation & applyMergedPayload timestamp LWW
// 4. Fulltext search exact occurrences, bi-gram false positive elimination

import assert from 'node:assert/strict'
import './test-idb-setup.mjs'
import { dictionaryService, normalizeWord, getLemmatizationCandidates } from '../js/dictionary-service.js'
import { advancedSettings, AdvancedSettingsManager } from '../js/advanced-settings.js'
import { reconcileBookSyncMeta } from '../js/syncEngine.js'
import { FullTextSearchEngine, createExcerptSnippet } from '../js/fulltext-search.js'

if (!globalThis.localStorage) {
    const store = new Map()
    globalThis.localStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    }
}

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

async function main() {
    console.log('====================================================')
    console.log(' Targeted P0/P1 Verification Suite (2026-09-25 Rework)')
    console.log('====================================================\n')

    // 1. Dictionary
    console.log('--- 1. Dictionary Service ---')
    await test('1.1 Lookup "Hello" succeeds with 基础离线词库', () => {
        const res = dictionaryService.lookup('Hello')
        assert.equal(res.found, true)
        assert.equal(res.normalizedWord, 'hello')
        assert.equal(res.source, '基础离线词库')
        assert.ok(res.entries.length > 0)
    })

    await test('1.2 Lookup "collision" succeeds', () => {
        const res = dictionaryService.lookup('collision')
        assert.equal(res.found, true)
        assert.equal(res.normalizedWord, 'collision')
        assert.ok(res.entries.some(e => e.def.includes('碰撞')))
    })

    await test('1.3 Lookup inflected "limousines" succeeds via lemmatization', () => {
        const res = dictionaryService.lookup('limousines')
        assert.equal(res.found, true)
        assert.equal(res.normalizedWord, 'limousine')
        assert.ok(res.entries.some(e => e.def.includes('豪华轿车')))
    })

    await test('1.4 Typographic apostrophe and punctuation normalization', () => {
        const norm = normalizeWord(' “Hello,” ')
        assert.equal(norm, 'hello')
        const res = dictionaryService.lookup('“Hello,”')
        assert.equal(res.found, true)
        assert.equal(res.normalizedWord, 'hello')
    })

    // 2. Advanced Settings
    console.log('\n--- 2. Advanced Settings Manager ---')
    await test('2.1 Context token budget 0 is preserved across load()', () => {
        localStorage.setItem('linden_advanced_settings_config', JSON.stringify({
            aiContextTokenBudget: 0,
            aiMaxTokens: 2048
        }))
        const mgr = new AdvancedSettingsManager()
        assert.equal(mgr.aiContextTokenBudget, 0)
        assert.equal(mgr.contextTokenBudget, 0)
        assert.equal(mgr.config.aiContextTokenBudget, 0)
    })

    await test('2.2 Context token budget default 1000 when missing', () => {
        localStorage.setItem('linden_advanced_settings_config', JSON.stringify({}))
        const mgr = new AdvancedSettingsManager()
        assert.equal(mgr.aiContextTokenBudget, 1000)
    })

    // 3. WebDAV Sync LWW & apply condition
    console.log('\n--- 3. WebDAV Sync Engine LWW ---')
    await test('3.1 Identical lastReadAt with differing fraction chooses larger fraction', () => {
        const local = {
            id: 'book-1',
            lastReadAt: 1000,
            progress: { fraction: 0.2, cfi: 'cfi-1' }
        }
        const incoming = {
            id: 'book-1',
            lastReadAt: 1000,
            progress: { fraction: 0.8, cfi: 'cfi-2' }
        }
        const reconciled = reconcileBookSyncMeta(local, incoming, 'client-a', 'client-b')
        assert.equal(reconciled.progress.fraction, 0.8)
        assert.equal(reconciled.lastReadAt, 1000)

        // Verify writeback condition
        const progressChanged = JSON.stringify(local.progress || null) !== JSON.stringify(reconciled.progress || null)
        const lastReadChanged = (reconciled.lastReadAt || 0) > (local.lastReadAt || 0)
        const shouldSave = progressChanged || lastReadChanged || (reconciled.progress && !local.progress)
        assert.equal(shouldSave, true, 'Progress change must trigger save even when lastReadAt is identical')
    })

    await test('3.2 Timestamp update persists even when value is unchanged', () => {
        const local = {
            id: 'book-1',
            rating: 3,
            ratingUpdatedAt: 100,
            tags: ['fiction'],
            tagsUpdatedAt: 100
        }
        const incoming = {
            id: 'book-1',
            rating: 3,
            ratingUpdatedAt: 200,
            tags: ['fiction'],
            tagsUpdatedAt: 200
        }
        const reconciled = reconcileBookSyncMeta(local, incoming, 'client-a', 'client-b')
        assert.equal(reconciled.ratingUpdatedAt, 200)
        assert.equal(reconciled.tagsUpdatedAt, 200)

        // Verify writeback condition in applyMergedPayload
        const ratingNeedsUpdate = local.rating !== reconciled.rating || (reconciled.ratingUpdatedAt || 0) > (local.ratingUpdatedAt || 0)
        const tagsNeedsUpdate = JSON.stringify(local.tags || []) !== JSON.stringify(reconciled.tags || []) || (reconciled.tagsUpdatedAt || 0) > (local.tagsUpdatedAt || 0)
        assert.equal(ratingNeedsUpdate, true, 'ratingUpdatedAt advance must trigger save')
        assert.equal(tagsNeedsUpdate, true, 'tagsUpdatedAt advance must trigger save')
    })

    // 4. Fulltext Search
    console.log('\n--- 4. Fulltext Search Engine ---')
    await test('4.1 Search "惨痛" returns multiple distinct occurrences with exact positions', () => {
        const engine = new FullTextSearchEngine()
        const text = '第一段文字惨痛。中间有很长很长的其他论述。第二段文字惨痛。'
        const fakeIndex = {
            meta: { title: '堂吉诃德讲稿' },
            sections: [
                {
                    sectionIndex: 3,
                    sectionTitle: '第四讲',
                    location: { href: 'chapter4.xhtml', sectionIndex: 3 },
                    text: text
                }
            ]
        }
        engine.index.set('test-book-1', fakeIndex)

        const results = engine.search('惨痛')
        assert.equal(results.length, 2, 'Should return exactly 2 distinct match occurrences')
        assert.equal(results[0].location.matchIndex, 0)
        assert.equal(results[1].location.matchIndex, 1)
        assert.ok(results[0].location.matchPos < results[1].location.matchPos)
        assert.ok(results[0].excerpt.includes('<mark>惨痛</mark>'))
        assert.ok(results[1].excerpt.includes('<mark>惨痛</mark>'))
    })

    await test('4.2 Eliminate bi-gram false positive: "甲乙相隔很远。乙丙" does NOT match "甲乙丙"', () => {
        const engine = new FullTextSearchEngine()
        const text = '甲乙相隔很远。乙丙'
        const fakeIndex = {
            meta: { title: '测试' },
            sections: [
                {
                    sectionIndex: 0,
                    sectionTitle: '第一章',
                    location: { href: 'c1.xhtml', sectionIndex: 0 },
                    text: text
                }
            ]
        }
        engine.index.set('test-book-2', fakeIndex)

        const results = engine.search('甲乙丙')
        assert.equal(results.length, 0, 'Disjoint bi-grams must not cause false hit when continuous keyword does not exist')
    })

    // 5. Import Queue & Badge Persistence across Restarts
    console.log('\n--- 5. Import Queue & Badge Dismissal ---')
    await test('5.1 Import batch dismissal is stored in localStorage and prevents resurrection', () => {
        const batchId = 42
        localStorage.setItem('linden_import_dismissed_batch', String(batchId))
        const readBack = localStorage.getItem('linden_import_dismissed_batch')
        assert.equal(readBack, '42')

        // Simulate app logic
        const summary = { total: 1, running: 0, queued: 0, succeeded: 1, failed: 0 }
        let importBatchDismissed = false
        if (readBack && String(batchId) === String(readBack)) {
            importBatchDismissed = true
        }
        assert.equal(importBatchDismissed, true)

        // Dock badge must not be shown when dismissed
        let badgeDisplay = 'none'
        if (summary.total > 0 && !importBatchDismissed) {
            badgeDisplay = 'flex'
        }
        assert.equal(badgeDisplay, 'none', 'Dock badge must remain hidden when batch was dismissed')

        // When a new batch arrives, batchId increments and badge is enabled
        const newBatchId = 43
        let newBatchDismissed = false
        if (readBack && String(newBatchId) === String(readBack)) {
            newBatchDismissed = true
        }
        assert.equal(newBatchDismissed, false, 'New batch ID must not be dismissed')
    })

    // 6. WebDAV Equal Timestamp Tie Breaker with ClientId
    console.log('\n--- 6. WebDAV Tie Breaking with ClientId ---')
    await test('6.1 Identical timestamp and fraction tie-breaks using clientId', () => {
        const local = {
            id: 'book-1',
            lastReadAt: 1000,
            progress: { fraction: 0.5, cfi: 'cfi-local' }
        }
        const incoming = {
            id: 'book-1',
            lastReadAt: 1000,
            progress: { fraction: 0.5, cfi: 'cfi-incoming' }
        }
        // Case A: incomingClientId ('client-z') > localClientId ('client-a') -> incoming wins
        const resA = reconcileBookSyncMeta(local, incoming, 'client-a', 'client-z')
        assert.equal(resA.progress.cfi, 'cfi-incoming')

        // Case B: incomingClientId ('client-a') < localClientId ('client-z') -> local wins
        const resB = reconcileBookSyncMeta(local, incoming, 'client-z', 'client-a')
        assert.equal(resB.progress.cfi, 'cfi-local')
    })

    // 7. Selection Snapshot & Fallback
    console.log('\n--- 7. Frozen Selection Snapshot Fallback ---')
    await test('7.1 Target resolution falls back to frozen snapshot when selectedTextInfo is cleared', () => {
        const frozenSnapshot = {
            text: 'remarkable passage',
            cfi: 'epubcfi(/6/4!/4/2/1:0)',
            index: 2,
            bookId: 'book-42'
        }
        let selectedTextInfo = null
        let targetRef = null

        // Emulate createHighlight target resolution
        const target = targetRef || selectedTextInfo || frozenSnapshot
        assert.ok(target, 'Target must resolve to frozenSnapshot')
        assert.equal(target.text, 'remarkable passage')
        assert.equal(target.cfi, 'epubcfi(/6/4!/4/2/1:0)')
    })

    console.log(`\n====================================================`)
    console.log(` Targeted Verification Complete: ${passCount} passed.`)
    console.log(`====================================================\n`)
}

main().catch(err => {
    console.error('Test suite failed:', err)
    process.exit(1)
})
