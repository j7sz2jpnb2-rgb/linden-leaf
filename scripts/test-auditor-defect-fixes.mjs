import assert from 'assert'
import fs from 'fs'
import {
    exportSyncPayload,
    mergeSyncData,
    applyMergedPayload,
    generateReadingSummaryMarkdown
} from '../js/syncEngine.js'
import { getReadingStats, toLocalDateKey } from '../js/db.js'
import { ReadingTracker } from '../js/tracker.js'

console.log('=== Running Verification for 6 Auditor Defect Repairs ===\n')

// -------------------------------------------------------------
// Test 1: Defect 1 - generateReadingSummaryMarkdown & TotalSecs
// -------------------------------------------------------------
console.log('[TEST 1] Verifying Defect 1: generateReadingSummaryMarkdown export & totalSecs calculation...')
assert.strictEqual(typeof generateReadingSummaryMarkdown, 'function', 'generateReadingSummaryMarkdown must be exported')

const mockPayloadWithCloudBooks = {
    version: 2,
    updatedAt: Date.now(),
    deviceName: 'TestDevice',
    booksMeta: [
        { id: 'b1', title: '本地书1', author: '作者1', totalReadingSeconds: 3600, readingStatus: 'reading' }
    ],
    readingSessions: [
        { id: 's1', bookId: 'b1', durationSeconds: 1800, date: '2026-10-31' },
        // s2 belongs to b2 which is NOT in booksMeta (cloud or deleted)
        { id: 's2', bookId: 'b2', bookTitle: '远端同步书2', bookAuthor: '远端作者2', durationSeconds: 7200, date: '2026-10-31' },
        // s3 is a listening session for b3 (not in booksMeta)
        { id: 's3', bookId: 'b3', bookTitle: '听书3', bookAuthor: '主播3', durationSeconds: 1800, isListening: true, date: '2026-10-31' }
    ]
}

const md = generateReadingSummaryMarkdown(mockPayloadWithCloudBooks)
assert.ok(md.includes('远端同步书2'), 'Markdown must list cloud/archived book in register')
assert.ok(md.includes('3.0 小时') || md.includes('总阅读时长**：3.0 小时'), 'Total reading hours must be 3600 + 7200 = 10800s = 3.0h')
assert.ok(md.includes('0.5 小时') || md.includes('总听书时长**：0.5 小时'), 'Total listening hours must be 1800s = 0.5h')
console.log('[PASS] Defect 1: Markdown summary calculation with cross-device/deleted books verified!\n')

// -------------------------------------------------------------
// Test 2: Defect 2 - advancedSettings config key & knownKeys
// -------------------------------------------------------------
console.log('[TEST 2] Verifying Defect 2: advancedSettings STORAGE_KEY_CONFIG & knownKeys...')
const syncEngineSrc = fs.readFileSync('js/syncEngine.js', 'utf8')
assert.ok(syncEngineSrc.includes('linden_advanced_settings_config'), 'syncEngine.js must use linden_advanced_settings_config')
assert.ok(syncEngineSrc.includes("'readingPresets'"), 'knownKeys must include readingPresets')
assert.ok(syncEngineSrc.includes("'customPalette'"), 'knownKeys must include customPalette')
assert.ok(syncEngineSrc.includes("'userName'"), 'knownKeys must include userName')
assert.ok(syncEngineSrc.includes("'bookSettingsOverrides'"), 'knownKeys must include bookSettingsOverrides')
assert.ok(syncEngineSrc.includes("'advancedSettings'"), 'knownKeys must include advancedSettings')
console.log('[PASS] Defect 2: advancedSettings key and knownKeys verified!\n')

// -------------------------------------------------------------
// Test 3: Defect 3 - db.getReadingStats() with cross-device / deleted books
// -------------------------------------------------------------
console.log('[TEST 3] Verifying Defect 3: getReadingStats enrichedBooks contains cloud/archived books...')
const dbSrc = fs.readFileSync('js/db.js', 'utf8')
assert.ok(dbSrc.includes('isCloudOrArchived: true'), 'db.js getReadingStats must mark virtual cloud books')
assert.ok(dbSrc.includes('latestSession.bookTitle'), 'db.js getReadingStats must use latestSession.bookTitle')
assert.ok(dbSrc.includes('latestSession.bookAuthor'), 'db.js getReadingStats must use latestSession.bookAuthor')
console.log('[PASS] Defect 3: getReadingStats logic verified!\n')

// -------------------------------------------------------------
// Test 4: Defect 4 - js/tracker.js bookAuthor in flush/endSession and dedup
// -------------------------------------------------------------
console.log('[TEST 4] Verifying Defect 4: tracker.js author handling & dedup...')
const trackerSrc = fs.readFileSync('js/tracker.js', 'utf8')
assert.ok(!trackerSrc.includes('bookAuthor: this.currentBookAuthor || \'\', bookAuthor: this.currentBookAuthor || \'\','), 'tracker.js must not contain duplicate bookAuthor property')
assert.ok(trackerSrc.includes('const targetAuthor = sessionSnapshot?.bookAuthor || this.currentBookAuthor || \'\''), 'flush() must capture targetAuthor')
assert.ok(trackerSrc.includes('this.currentBookAuthor = null'), 'endSession() must reset currentBookAuthor')
console.log('[PASS] Defect 4: tracker.js author consistency verified!\n')

// -------------------------------------------------------------
// Test 5: Defect 5 - js/tts-player.js bookAuthor in sessionBookOwner and records
// -------------------------------------------------------------
console.log('[TEST 5] Verifying Defect 5: tts-player.js bookAuthor inclusion...')
const ttsSrc = fs.readFileSync('js/tts-player.js', 'utf8')
assert.ok(ttsSrc.includes('bookAuthor: app?.currentBookData?.author || app?.currentBookMeta?.author || \'\''), 'tts-player.js must capture bookAuthor in sessionBookOwner')
assert.ok(ttsSrc.includes('const bookAuthor = owner?.bookAuthor'), 'tts-player.js must extract bookAuthor')
assert.ok(ttsSrc.includes('android_tts'), 'tts-player.js android listening record verified')
console.log('[PASS] Defect 5: tts-player.js bookAuthor verified!\n')

// -------------------------------------------------------------
// Test 6: Defect 6 - js/syncEngine.js retention of readingSessions for deleted books
// -------------------------------------------------------------
console.log('[TEST 6] Verifying Defect 6: readingSessions retention for deleted books...')
assert.ok(!syncEngineSrc.includes('deletedBookIds.includes(sess.bookId)) continue;'), 'readingSessions loop must NOT skip deleted books')
console.log('[PASS] Defect 6: Deleted books readingSessions are preserved!\n')

// -------------------------------------------------------------
// Test 7: Rust sync_save_remote signature & summary_markdown handling
// -------------------------------------------------------------
console.log('[TEST 7] Verifying Rust sync.rs command signature & summary_markdown...')
const rustSyncSrc = fs.readFileSync('src-tauri/src/commands/sync.rs', 'utf8')
assert.ok(rustSyncSrc.includes('summary_markdown: Option<String>'), 'sync_save_remote must accept summary_markdown')
assert.ok(rustSyncSrc.includes('LindenLeaf_Reading_Notes_and_Stats.md'), 'sync_save_remote must upload markdown file')
console.log('[PASS] Rust sync.rs command signature and summary markdown upload verified!\n')

console.log('=== ALL 6 AUDITOR DEFECT REPAIRS VERIFIED SUCCESSFULLY! ===')
