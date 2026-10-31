import assert from 'node:assert/strict'
import * as syncEngine from '../js/syncEngine.js'
import { aggregateSessions } from '../js/stats-heatmap.js'

console.log('=== Running Automated Verification for Task 1: WebDAV & Stats Coverage ===')

// 1. Test aggregateSessions with bookTitle and bookAuthor without local books table
console.log('\n[TEST 1] Verifying daily reading session detail aggregation without local books...')
const mockSessions = [
    {
        id: 'sess_1',
        bookId: 'book_remote_deleted',
        bookTitle: '红楼梦（脂砚斋重评本）',
        bookAuthor: '曹雪芹',
        date: '2026-10-31',
        startTime: 1761910000000,
        endTime: 1761913600000,
        durationSeconds: 3600,
        activeIntervals: [[1761910000000, 1761913600000]]
    },
    {
        id: 'sess_2',
        bookId: 'book_synced_another',
        bookTitle: '百年孤独',
        bookAuthor: '加西亚·马尔克斯',
        date: '2026-10-31',
        startTime: 1761915000000,
        endTime: 1761916800000,
        durationSeconds: 1800,
        activeIntervals: [[1761915000000, 1761916800000]]
    }
]

const { dayMap, totalSeconds, activeDaysCount } = aggregateSessions(mockSessions)
assert.equal(totalSeconds, 5400, 'Total seconds should match sum of session durations')
assert.equal(activeDaysCount, 1, 'Should have 1 active reading day')

const dayItem = dayMap.get('2026-10-31')
assert(dayItem, 'Day map should contain entry for 2026-10-31')
assert.equal(dayItem.seconds, 5400)
assert.equal(dayItem.minutes, 90)
assert.equal(dayItem.bookIds.size, 2)

// Check bookMetaMap
assert(dayItem.bookMetaMap instanceof Map, 'dayItem should contain bookMetaMap')
const meta1 = dayItem.bookMetaMap.get('book_remote_deleted')
assert.equal(meta1.title, '红楼梦（脂砚斋重评本）')
assert.equal(meta1.author, '曹雪芹')

const meta2 = dayItem.bookMetaMap.get('book_synced_another')
assert.equal(meta2.title, '百年孤独')
assert.equal(meta2.author, '加西亚·马尔克斯')

console.log('[PASS] Daily reading sessions preserve bookTitle and bookAuthor in heatmap aggregation!')

// 2. Test buildBookSyncMeta and reconcileBookSyncMeta
console.log('\n[TEST 2] Verifying book sync metadata build and reconciliation...')
const sampleBook = {
    id: 'book_101',
    title: '三体全集',
    author: '刘慈欣',
    customTitle: '三体：地球往事三部曲',
    customAuthor: '大刘',
    format: 'epub',
    size: 2048000,
    isFavorite: true,
    favoriteUpdatedAt: 1761900000000,
    tags: ['科幻', '雨果奖'],
    tagsUpdatedAt: 1761900000000,
    readingStatus: 'reading',
    statusUpdatedAt: 1761900000000,
    rating: 4.8,
    ratingUpdatedAt: 1761900000000,
    progress: { fraction: 0.45, timestamp: 1761900000000 },
    totalReadingSeconds: 7200,
    totalListeningSeconds: 1800,
    addedAt: 1761800000000,
    updatedAt: 1761900000000
}

const syncMeta = syncEngine.buildBookSyncMeta(sampleBook)
assert.equal(syncMeta.customTitle, '三体：地球往事三部曲')
assert.equal(syncMeta.customAuthor, '大刘')
assert.equal(syncMeta.isFavorite, true)
assert.equal(syncMeta.rating, 4.8)
assert.deepEqual(syncMeta.tags, ['科幻', '雨果奖'])
assert.equal(syncMeta.readingStatus, 'reading')

// Test reconcileBookSyncMeta
const incomingNewer = {
    ...syncMeta,
    customTitle: '三体珍藏典藏版',
    rating: 5.0,
    ratingUpdatedAt: 1761950000000,
    readingStatus: 'finished',
    statusUpdatedAt: 1761950000000,
    updatedAt: 1761950000000
}
const reconciled = syncEngine.reconcileBookSyncMeta(sampleBook, incomingNewer)
assert.equal(reconciled.customTitle, '三体珍藏典藏版')
assert.equal(reconciled.rating, 5.0)
assert.equal(reconciled.readingStatus, 'finished')

console.log('[PASS] Book sync meta building and deterministic reconciliation verified!')

// 3. Test mergeSyncData with all 7 categories of valid information
console.log('\n[TEST 3] Verifying mergeSyncData with all 7 information categories...')
const localPayload = {
    version: 2,
    clientId: 'client_A',
    deviceName: 'Windows Desktop',
    updatedAt: 1761900000000,
    settings: { fontSize: 18, theme: 'parchment', enableReadingGoals: true, readingGoalToday: 60 },
    readingPresets: [
        { id: 'preset_1', name: '沉浸纸书', settings: { fontSize: 19 }, updatedAt: 1761900000000 }
    ],
    customPalette: { bgPrimary: '#fbf0d9', textMain: '#2b2319', updatedAt: 1761900000000 },
    userName: '叶语者',
    bookSettingsOverrides: {
        'book_1': { fontScale: 1.1, columns: 2 }
    },
    advancedSettings: { ttsSpeed: 1.2, pageTurnStyle: 'curl' },
    customLists: [
        { id: 'list_sci', name: '硬科幻必读', bookIds: ['book_1', 'book_remoted_stable'] }
    ],
    booksMeta: [
        {
            id: 'book_1',
            stableKey: 'book_key_1',
            title: '银河帝国',
            author: '阿西莫夫',
            format: 'epub',
            isFavorite: true,
            readingStatus: 'reading',
            lastReadAt: 1761850000000,
            totalReadingSeconds: 3000,
            updatedAt: 1761850000000
        }
    ],
    highlights: [
        { id: 'hl_1', bookId: 'book_1', text: '人类的悲欢并不相通', createdAt: 1761800000000, updatedAt: 1761800000000 }
    ],
    bookmarks: [],
    readingSessions: [
        {
            id: 'sess_loc_1',
            bookId: 'book_1',
            bookTitle: '银河帝国',
            bookAuthor: '阿西莫夫',
            date: '2026-10-30',
            durationSeconds: 1500,
            startTime: 1761850000000,
            endTime: 1761851500000
        }
    ],
    pdfDrawings: [],
    chapterTranslations: [],
    deletedRecords: []
}

const remotePayload = {
    version: 2,
    clientId: 'client_B',
    deviceName: 'Android Mobile',
    updatedAt: 1761950000000,
    settings: { fontSize: 18, theme: 'parchment', enableReadingGoals: true, readingGoalToday: 90, updatedAt: 1761950000000 },
    readingPresets: [
        { id: 'preset_1', name: '沉浸纸书 (夜间调优)', settings: { fontSize: 19, theme: 'dark' }, updatedAt: 1761950000000 },
        { id: 'preset_2', name: '地铁速读', settings: { fontSize: 22 }, updatedAt: 1761950000000 }
    ],
    customPalette: { bgPrimary: '#000000', textMain: '#e5e7eb', updatedAt: 1761950000000 },
    userName: '菩提清风',
    bookSettingsOverrides: {
        'book_remoted_id_different': { fontScale: 1.25 }
    },
    advancedSettings: { ttsSpeed: 1.25, pageTurnStyle: 'curl' },
    customLists: [
        { id: 'list_sci', name: '硬科幻必读', bookIds: ['book_remoted_id_different'], updatedAt: 1761950000000 },
        { id: 'list_hist', name: '历史风云', bookIds: [], updatedAt: 1761950000000 }
    ],
    booksMeta: [
        {
            id: 'book_remoted_id_different',
            stableKey: 'book_key_1',
            title: '银河帝国',
            author: '阿西莫夫',
            format: 'epub',
            isFavorite: true,
            readingStatus: 'finished',
            statusUpdatedAt: 1761950000000,
            completedAt: 1761950000000,
            rating: 5.0,
            ratingUpdatedAt: 1761950000000,
            lastReadAt: 1761950000000,
            totalReadingSeconds: 4500,
            updatedAt: 1761950000000
        }
    ],
    highlights: [
        { id: 'hl_2', bookId: 'book_remoted_id_different', text: '基地建立于端点星', createdAt: 1761950000000, updatedAt: 1761950000000 }
    ],
    bookmarks: [],
    readingSessions: [
        {
            id: 'sess_rem_1',
            bookId: 'book_remoted_id_different',
            bookTitle: '银河帝国',
            bookAuthor: '阿西莫夫',
            date: '2026-10-31',
            durationSeconds: 3000,
            startTime: 1761940000000,
            endTime: 1761943000000
        }
    ],
    pdfDrawings: [],
    chapterTranslations: [],
    deletedRecords: []
}

const { merged, stats } = syncEngine.mergeSyncData(localPayload, remotePayload)

// Verify version and settings
assert.equal(merged.version, 2)
assert.equal(merged.userName, '菩提清风')
assert.equal(merged.customPalette.bgPrimary, '#000000')

// Verify reading presets merge
assert.equal(merged.readingPresets.length, 2)
const p1 = merged.readingPresets.find(p => p.id === 'preset_1')
assert.equal(p1.name, '沉浸纸书 (夜间调优)')

// Verify book matching by stableKey and bookIdRemap
const book1 = merged.booksMeta.find(b => b.stableKey === 'book_key_1')
assert(book1, 'Merged books should retain book matched by stableKey')
assert.equal(book1.readingStatus, 'finished')
assert.equal(book1.rating, 5.0)

// Verify custom list bookId remapping
const sciList = merged.customLists.find(l => l.id === 'list_sci')
assert(sciList, 'Custom list should be retained')
assert(sciList.bookIds.includes('book_1'), 'Remote book ID should be remapped to local book ID')

// Verify reading sessions merge & bookId remapping
assert.equal(merged.readingSessions.length, 2)
const sessRem = merged.readingSessions.find(s => s.id === 'sess_rem_1')
assert.equal(sessRem.bookId, 'book_1', 'Remote session bookId should be remapped to local matching bookId')
assert.equal(sessRem.bookTitle, '银河帝国')
assert.equal(sessRem.bookAuthor, '阿西莫夫')

// Verify highlight bookId remapping
const hl2 = merged.highlights.find(h => h.id === 'hl_2')
assert.equal(hl2.bookId, 'book_1', 'Highlight bookId should be remapped')

console.log('[PASS] Full mergeSyncData algorithm with all 7 categories and remapping passed cleanly!')

// 4. Test generateReadingSummaryMarkdown
console.log('\n[TEST 4] Verifying generateReadingSummaryMarkdown generation...')
const markdown = syncEngine.generateReadingSummaryMarkdown(merged)
assert(markdown.includes('# Linden Leaf (菩提叶阅读) - 云端同步与阅读数据总览'), 'Markdown should have title')
assert(markdown.includes('## 📊 阅读总体概览'), 'Markdown should have stats overview')
assert(markdown.includes('## 📅 每日读书详细登记表'), 'Markdown should have daily reading book-by-book register table')
assert(markdown.includes('银河帝国'), 'Markdown register table should list 银河帝国')
assert(markdown.includes('阿西莫夫'), 'Markdown register table should list author 阿西莫夫')
assert(markdown.includes('2026-10-31'), 'Markdown should list date 2026-10-31')
assert(markdown.includes('2026-10-30'), 'Markdown should list date 2026-10-30')
assert(markdown.includes('## 📚 书架图书明细与状态'), 'Markdown should have bookshelf table')

console.log('[PASS] generateReadingSummaryMarkdown generated valid, elegant Markdown documentation!')

console.log('\n=== ALL AUTOMATED VERIFICATION TESTS PASSED SUCCESSFULLY! ===')
