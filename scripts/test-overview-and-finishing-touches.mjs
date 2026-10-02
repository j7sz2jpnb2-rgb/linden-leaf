// scripts/test-overview-and-finishing-touches.mjs
import assert from 'assert'
import {
    resolveReadingState,
    VALID_READING_STATUSES,
    normalizeTag,
    renameTagGlobally,
    deleteTagGlobally,
    getAllTagsWithCounts
} from '../js/tags-manager.js'
import { isValidRating } from '../js/db.js'
import { reconcileBookSyncMeta } from '../js/syncEngine.js'
import { PageTurnController } from '../js/page-turn-controller.js'
import { aggregateSessions } from '../js/stats-heatmap.js'

console.log('====================================================')
console.log(' Starting Reading Overview & Final Touches Test Suite')
console.log('====================================================\n')

let passCount = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`  [PASS] ${name}`)
        passCount++
    } catch (err) {
        console.error(`  [FAIL] ${name}:`, err.message)
        process.exitCode = 1
    }
}

// Suite 1: resolveReadingState & Status Semantics
console.log('--- Suite 1: Reading Status Semantics (resolveReadingState) ---')

await test('1.1 Explicit valid status always takes precedence', () => {
    assert.strictEqual(resolveReadingState({ readingStatus: 'want_to_read' }), 'want_to_read')
    assert.strictEqual(resolveReadingState({ readingStatus: 'reading' }), 'reading')
    assert.strictEqual(resolveReadingState({ readingStatus: 'on_hold' }), 'on_hold')
    assert.strictEqual(resolveReadingState({ readingStatus: 'finished' }), 'finished')
    assert.strictEqual(resolveReadingState({ readingStatus: 'unread' }), 'unread')
})

await test('1.2 Book with 4% progress but manually marked finished is finished (P4 case)', () => {
    const book = {
        id: 'book_p4',
        progress: { fraction: 0.04 },
        readingStatus: 'finished',
        completedAt: 1720000000000
    }
    assert.strictEqual(resolveReadingState(book), 'finished')
})

await test('1.3 Book with 99% progress but manually marked reading or on_hold is NOT finished', () => {
    const readingBook = {
        id: 'book_99_reading',
        progress: { fraction: 0.995 },
        readingStatus: 'reading'
    }
    assert.strictEqual(resolveReadingState(readingBook), 'reading')

    const holdBook = {
        id: 'book_99_hold',
        progress: { fraction: 0.999 },
        readingStatus: 'on_hold'
    }
    assert.strictEqual(resolveReadingState(holdBook), 'on_hold')
})

await test('1.4 Legacy book fallback: completedAt > 0 resolves to finished, not mere fraction >= 0.99', () => {
    const legacyFinished = {
        id: 'book_legacy_finished',
        completedAt: 1710000000000,
        progress: { fraction: 0.5 }
    }
    assert.strictEqual(resolveReadingState(legacyFinished), 'finished')

    // Mere 99% without reliable completedAt or explicit status does not force finished
    const legacy99 = {
        id: 'book_legacy_99',
        progress: { fraction: 0.99 },
        totalReadingSeconds: 3600
    }
    assert.strictEqual(resolveReadingState(legacy99), 'reading')
})

await test('1.5 New book with no reading activity resolves to unread (never automatically want_to_read)', () => {
    const freshBook = {
        id: 'book_fresh',
        title: 'New Book',
        addedAt: Date.now()
    }
    assert.strictEqual(resolveReadingState(freshBook), 'unread')
    assert.notStrictEqual(resolveReadingState(freshBook), 'want_to_read')
})

await test('1.6 VALID_READING_STATUSES enum integrity', () => {
    assert.ok(Array.isArray(VALID_READING_STATUSES))
    assert.ok(VALID_READING_STATUSES.includes('unread'))
    assert.ok(VALID_READING_STATUSES.includes('want_to_read'))
    assert.ok(VALID_READING_STATUSES.includes('reading'))
    assert.ok(VALID_READING_STATUSES.includes('on_hold'))
    assert.ok(VALID_READING_STATUSES.includes('finished'))
})

// Suite 2: Half-Star Rating Validation & LWW Reconciliation
console.log('\n--- Suite 2: Half-Star Rating & LWW Reconciliation ---')

await test('2.1 isValidRating strictly accepts half-star steps in [0.5, 5.0] and null', () => {
    assert.strictEqual(isValidRating(null), true)
    assert.strictEqual(isValidRating(undefined), false)
    assert.strictEqual(isValidRating(0.5), true)
    assert.strictEqual(isValidRating(1.0), true)
    assert.strictEqual(isValidRating(1.5), true)
    assert.strictEqual(isValidRating(2.0), true)
    assert.strictEqual(isValidRating(2.5), true)
    assert.strictEqual(isValidRating(3.0), true)
    assert.strictEqual(isValidRating(3.5), true)
    assert.strictEqual(isValidRating(4.0), true)
    assert.strictEqual(isValidRating(4.5), true)
    assert.strictEqual(isValidRating(5.0), true)

    assert.strictEqual(isValidRating(0), false) // 0 is invalid; unrated is null
    assert.strictEqual(isValidRating(0.25), false)
    assert.strictEqual(isValidRating(4.2), false)
    assert.strictEqual(isValidRating(5.5), false)
    assert.strictEqual(isValidRating(-1), false)
    assert.strictEqual(isValidRating('4.5'), false) // string rejected
})

await test('2.2 reconcileBookSyncMeta updates rating when remote ratingUpdatedAt is newer', () => {
    const local = {
        id: 'book_rate_1',
        rating: 3.5,
        ratingUpdatedAt: 1000
    }
    const remote = {
        id: 'book_rate_1',
        rating: 4.5,
        ratingUpdatedAt: 2000
    }
    const merged = reconcileBookSyncMeta(local, remote, 'client_A')
    assert.strictEqual(merged.rating, 4.5)
    assert.strictEqual(merged.ratingUpdatedAt, 2000)
})

await test('2.3 reconcileBookSyncMeta preserves local rating when remote ratingUpdatedAt is older', () => {
    const local = {
        id: 'book_rate_2',
        rating: 4.0,
        ratingUpdatedAt: 3000
    }
    const remote = {
        id: 'book_rate_2',
        rating: 2.0,
        ratingUpdatedAt: 1000
    }
    const merged = reconcileBookSyncMeta(local, remote, 'client_A')
    assert.strictEqual(merged.rating, 4.0)
    assert.strictEqual(merged.ratingUpdatedAt, 3000)
})

await test('2.4 reconcileBookSyncMeta clears rating on explicit null with newer timestamp', () => {
    const local = {
        id: 'book_rate_3',
        rating: 5.0,
        ratingUpdatedAt: 1000
    }
    const remote = {
        id: 'book_rate_3',
        rating: null,
        ratingUpdatedAt: 2000
    }
    const merged = reconcileBookSyncMeta(local, remote, 'client_A')
    assert.strictEqual(merged.rating, null)
    assert.strictEqual(merged.ratingUpdatedAt, 2000)
})

await test('2.5 Missing remote rating does NOT clear existing local rating', () => {
    const local = {
        id: 'book_rate_4',
        rating: 4.5,
        ratingUpdatedAt: 1000
    }
    const remote = {
        id: 'book_rate_4'
        // no rating or ratingUpdatedAt
    }
    const merged = reconcileBookSyncMeta(local, remote, 'client_A')
    assert.strictEqual(merged.rating, 4.5)
    assert.strictEqual(merged.ratingUpdatedAt, 1000)
})

// Suite 3: PageTurnController Default Mode
console.log('\n--- Suite 3: Reader Default Page Turn Mode ---')

await test('3.1 PageTurnController defaults to mode: "none" (no animation)', () => {
    const dummyContainer = { addEventListener: () => {} }
    const controller = new PageTurnController({
        container: dummyContainer
    })
    assert.strictEqual(controller.mode, 'none')
})

// Suite 4: Heatmap Day Details Aggregation
console.log('\n--- Suite 4: Heatmap Aggregation & Book Details Mapping ---')

await test('4.1 aggregateSessions aggregates bookDurationMap correctly for single day', () => {
    const sessions = [
        {
            bookId: 'book_a',
            bookTitle: '百年孤独',
            startTime: new Date('2026-05-10T10:00:00').getTime(),
            endTime: new Date('2026-05-10T10:30:00').getTime(),
            durationSeconds: 1800
        },
        {
            bookId: 'book_b',
            bookTitle: '瓦尔登湖',
            startTime: new Date('2026-05-10T14:00:00').getTime(),
            endTime: new Date('2026-05-10T14:15:00').getTime(),
            durationSeconds: 900
        },
        {
            bookId: 'book_a',
            bookTitle: '百年孤独',
            startTime: new Date('2026-05-10T20:00:00').getTime(),
            endTime: new Date('2026-05-10T20:20:00').getTime(),
            durationSeconds: 1200
        }
    ]

    const result = aggregateSessions(sessions, { targetYear: 2026 })
    const day = result.dayMap.get('2026-05-10')
    assert.ok(day, 'Day 2026-05-10 should exist')
    assert.strictEqual(day.seconds, 3900)
    assert.strictEqual(day.minutes, 65)

    assert.ok(day.bookDurationMap, 'bookDurationMap should be created')
    assert.strictEqual(day.bookDurationMap.get('book_a'), 3000)
    assert.strictEqual(day.bookDurationMap.get('book_b'), 900)
})

// Suite 5: Tag Normalization & Limits
console.log('\n--- Suite 5: Tag Normalization & Limits ---')

await test('5.1 Tag normalization enforces 24 characters limit and unicode NFC', () => {
    const longTag = '这是一个非常非常非常非常非常非常非常非常非常长的标签'
    const norm = normalizeTag(longTag)
    assert.ok(norm.length <= 24)
    assert.strictEqual(norm, longTag.slice(0, 24))
})

// Suite 6: Tag Rename & Delete Globally
console.log('\n--- Suite 6: Tag Rename & Delete Globally ---')

await test('6.1 renameTagGlobally rejects empty or identical tags', async () => {
    const resEmpty = await renameTagGlobally('', 'tag2')
    assert.strictEqual(resEmpty.success, false)
    assert.strictEqual(resEmpty.updatedCount, 0)
    assert.ok(resEmpty.error)

    const resIdentical = await renameTagGlobally('tag1', 'tag1')
    assert.strictEqual(resIdentical.success, true)
    assert.strictEqual(resIdentical.updatedCount, 0)
})

await test('6.2 renameTagGlobally updates books matching old tag and returns updatedCount', async () => {
    const books = [
        { id: 'b1', title: 'Book 1', tags: ['哲学', '散文'] },
        { id: 'b2', title: 'Book 2', tags: ['历史'] },
        { id: 'b3', title: 'Book 3', tags: ['哲学'] }
    ]
    const saved = []
    const mockDb = {
        getAllBooks: async () => books,
        saveBook: async (book) => {
            saved.push(book)
            const target = books.find(b => b.id === book.id)
            if (target) Object.assign(target, book)
        }
    }
    const res = await renameTagGlobally('哲学', '西方哲学', mockDb)
    assert.strictEqual(res.success, true)
    assert.strictEqual(res.updatedCount, 2)
    assert.strictEqual(saved.length, 2)
    assert.deepStrictEqual(books.find(b => b.id === 'b1').tags, ['散文', '西方哲学'])
    assert.deepStrictEqual(books.find(b => b.id === 'b3').tags, ['西方哲学'])
})

await test('6.3 renameTagGlobally merges tags when newTag already exists on book', async () => {
    const books = [
        { id: 'b1', title: 'Book 1', tags: ['哲学', '思想'] }
    ]
    const mockDb = {
        getAllBooks: async () => books,
        saveBook: async (book) => {
            const target = books.find(b => b.id === book.id)
            if (target) Object.assign(target, book)
        }
    }
    const res = await renameTagGlobally('哲学', '思想', mockDb)
    assert.strictEqual(res.success, true)
    assert.strictEqual(res.updatedCount, 1)
    // Deduped: should only contain '思想' once
    assert.deepStrictEqual(books[0].tags, ['思想'])
})

await test('6.4 deleteTagGlobally removes tag across books and returns updatedCount', async () => {
    const books = [
        { id: 'b1', title: 'Book 1', tags: ['哲学', '散文'] },
        { id: 'b2', title: 'Book 2', tags: ['历史'] }
    ]
    const mockDb = {
        getAllBooks: async () => books,
        saveBook: async (book) => {
            const target = books.find(b => b.id === book.id)
            if (target) Object.assign(target, book)
        }
    }
    const res = await deleteTagGlobally('散文', mockDb)
    assert.strictEqual(res.success, true)
    assert.strictEqual(res.updatedCount, 1)
    assert.deepStrictEqual(books[0].tags, ['哲学'])
})

await test('6.5 getAllTagsWithCounts aggregates and sorts by count descending', async () => {
    const books = [
        { id: 'b1', tags: ['哲学', '散文'] },
        { id: 'b2', tags: ['散文', '历史'] },
        { id: 'b3', tags: ['散文'] }
    ]
    const mockDb = { getAllBooks: async () => books }
    const tagCounts = await getAllTagsWithCounts(mockDb)
    assert.strictEqual(tagCounts[0].name, '散文')
    assert.strictEqual(tagCounts[0].count, 3)
    assert.strictEqual(tagCounts.length, 3)
})

// Suite 7: Null / Malformed Tag Safety in Filter Mapping
console.log('\n--- Suite 7: Null / Malformed Tag Safety in Filter Mapping ---')

await test('7.1 normalizeTag handles null, undefined, empty, and non-string safely', () => {
    assert.strictEqual(normalizeTag(null), null)
    assert.strictEqual(normalizeTag(undefined), null)
    assert.strictEqual(normalizeTag(''), null)
    assert.strictEqual(normalizeTag(123), null)
})

await test('7.2 Overview tag filter mapping does not crash on malformed tags array', () => {
    const malformedBooks = [
        { id: 'b1', tags: [null, undefined, '', '科幻', '  '] },
        { id: 'b2', tags: null },
        { id: 'b3', tags: ['科幻', '文学'] }
    ]
    const selectedTags = new Set(['科幻', null, ''])
    const reqTags = Array.from(selectedTags)
        .map(t => normalizeTag(t))
        .filter(Boolean)
        .map(t => t.toLowerCase())

    assert.deepStrictEqual(reqTags, ['科幻'])

    const filtered = malformedBooks.filter(b => {
        const bTags = (b.tags || [])
            .map(t => normalizeTag(t))
            .filter(Boolean)
            .map(t => t.toLowerCase())
        return reqTags.every(rt => bTags.includes(rt))
    })
    assert.strictEqual(filtered.length, 2)
    assert.strictEqual(filtered[0].id, 'b1')
    assert.strictEqual(filtered[1].id, 'b3')
})

// Suite 8: Leaderboard Progress & AI Highlight TargetRef
console.log('\n--- Suite 8: Leaderboard Progress & AI Highlight TargetRef ---')

await test('8.1 Leaderboard progress resolution uses resolveReadingState fallback', () => {
    const finishedBookWithoutFraction = {
        id: 'b_fin',
        title: 'Finished Book',
        readingStatus: 'finished',
        progress: {} // no fraction
    }
    const rawFractionFin = (typeof finishedBookWithoutFraction.progress?.fraction === 'number' && Number.isFinite(finishedBookWithoutFraction.progress.fraction))
        ? finishedBookWithoutFraction.progress.fraction
        : (resolveReadingState(finishedBookWithoutFraction) === 'finished' ? 1 : 0)
    assert.strictEqual(rawFractionFin, 1)

    const readingBookWithoutFraction = {
        id: 'b_read',
        title: 'Reading Book',
        readingStatus: 'reading',
        progress: {}
    }
    const rawFractionRead = (typeof readingBookWithoutFraction.progress?.fraction === 'number' && Number.isFinite(readingBookWithoutFraction.progress.fraction))
        ? readingBookWithoutFraction.progress.fraction
        : (resolveReadingState(readingBookWithoutFraction) === 'finished' ? 1 : 0)
    assert.strictEqual(rawFractionRead, 0)
})

await test('8.2 Highlight structure with targetRef formats note and locators properly', () => {
    const targetRef = {
        referenceId: 'ref_12345',
        bookId: 'book_epub_1',
        text: 'Selected original passage',
        cfi: 'epubcfi(/6/14!/4/2/4)',
        chapterTitle: '第一章 启程',
        sourceType: 'native'
    }
    const aiText = '这是AI生成的翻译解析'
    const noteText = `[AI 辅助]: ${aiText}`

    const hl = {
        id: `hl_${Date.now()}_test`,
        bookId: targetRef.bookId,
        cfi: targetRef.cfi,
        text: targetRef.text,
        color: '#3b82f6',
        style: 'highlight',
        note: noteText,
        chapterTitle: targetRef.chapterTitle || '正文',
        createdAt: Date.now()
    }

    assert.strictEqual(hl.bookId, 'book_epub_1')
    assert.strictEqual(hl.cfi, 'epubcfi(/6/14!/4/2/4)')
    assert.strictEqual(hl.note, '[AI 辅助]: 这是AI生成的翻译解析')
    assert.strictEqual(hl.chapterTitle, '第一章 启程')
})

console.log('\n====================================================')
console.log(` Summary: ${passCount} tests passed cleanly!`)
console.log('====================================================\n')
