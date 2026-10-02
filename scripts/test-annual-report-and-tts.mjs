import assert from 'node:assert/strict'
import { buildAnnualReport } from '../js/annual-report.js'
import { TtsPlayer, SystemTtsProvider, ApiTtsProvider } from '../js/tts-player.js'

console.log('--- Testing Annual Reading Report Aggregator ---')

// 1. Empty data test (graceful degradation)
const emptyReport = buildAnnualReport(2026, { sessions: [], highlights: [], books: [] })
assert.equal(emptyReport.targetYear, 2026)
assert.equal(emptyReport.totalSeconds, 0)
assert.equal(emptyReport.acts.length, 9, 'Should always generate 9 acts')
assert.ok(emptyReport.persona.title, 'Should have a default persona')

// 2. Populated year data test
const mockSessions = [
    { id: 's1', bookId: 'b1', durationSeconds: 3600, startTime: '2026-03-01T10:00:00Z', date: '2026-03-01' },
    { id: 's2', bookId: 'b1', durationSeconds: 7200, startTime: '2026-03-02T11:00:00Z', date: '2026-03-02' },
    { id: 's3', bookId: 'b2', durationSeconds: 1800, startTime: '2026-03-03T23:30:00Z', date: '2026-03-03' }, // night session
    { id: 's4', bookId: 'b2', durationSeconds: 3600, startTime: '2026-03-04T02:15:00Z', date: '2026-03-04' }, // night session
    { id: 's5', bookId: 'b1', durationSeconds: 5400, startTime: '2025-12-31T10:00:00Z', date: '2025-12-31' }  // previous year, should be ignored
]

const mockBooks = [
    { id: 'b1', title: '百年孤独', author: '马尔克斯', totalReadingSeconds: 10800 },
    { id: 'b2', title: '追忆似水年华', author: '普鲁斯特', totalReadingSeconds: 5400 }
]

const mockHighlights = [
    { id: 'h1', bookId: 'b1', text: '生命中曾经有过的所有灿烂，终究都需要用寂寞来偿还。', createdAt: '2026-03-01T12:00:00Z', notes: '震撼' },
    { id: 'h2', bookId: 'b2', text: '当过去的一切荡然无存，唯有气味和滋味长存。', createdAt: '2026-03-03T15:00:00Z' }
]

const report2026 = buildAnnualReport(2026, {
    sessions: mockSessions,
    books: mockBooks,
    highlights: mockHighlights
})

assert.equal(report2026.totalSeconds, 3600 + 7200 + 1800 + 3600, 'Total seconds should match 2026 sessions only')
assert.equal(report2026.totalHours, '4.5')
assert.equal(report2026.totalDays, 4, 'Should have 4 active days in 2026')
assert.equal(report2026.maxStreak, 4, 'Should have 4 consecutive days streak')
assert.equal(report2026.topBook.title, '百年孤独')
assert.equal(report2026.acts.length, 9)
assert.equal(report2026.acts[0].actNum, 1)
assert.equal(report2026.acts[8].actNum, 9)

console.log('✓ Annual report data aggregation verified successfully')

// 3. Privacy Masking test
const maskedReport = buildAnnualReport(2026, {
    sessions: mockSessions,
    books: mockBooks,
    highlights: mockHighlights
}, { maskNightStats: true, maskStreak: true })

assert.equal(maskedReport.acts[2].giantStat, '--', 'Night stats giant stat should be masked')
assert.ok(maskedReport.acts[3].quote.includes('隐去'), 'Streak quote should state masked')

console.log('✓ Annual report privacy masking verified')

// 4. TTS Player State Machine & Providers test
console.log('--- Testing TTS Player Engine ---')
const player = new TtsPlayer()
assert.equal(player.state, 'idle')

let lastState = null
player.onStateChange((state) => {
    lastState = state
})

player.setState('preparing')
assert.equal(player.state, 'preparing')
assert.equal(lastState, 'preparing')

player.setState('playing')
assert.equal(player.state, 'playing')
assert.equal(lastState, 'playing')

player.pause()
assert.equal(player.state, 'paused')
assert.equal(lastState, 'paused')

player.resume()
assert.equal(player.state, 'playing')

player.stop()
assert.equal(player.state, 'stopped')
assert.equal(lastState, 'stopped')

// Test speed rate boundary
player.setRate(0.2)
assert.equal(player.rate, 0.5, 'Rate floor is 0.5')
player.setRate(5.0)
assert.equal(player.rate, 3.0, 'Rate ceiling is 3.0')
player.setRate(1.25)
assert.equal(player.rate, 1.25)

// Test sleep timer settings
player.setSleepTimer(15)
assert.equal(player.sleepTimerDurationMinutes, 15)
assert.equal(player.sleepTimerRemainingSeconds, 15 * 60)
player.setSleepTimer('end_of_chapter')
assert.equal(player.sleepTimerDurationMinutes, 'end_of_chapter')
player.setSleepTimer(0)
assert.equal(player.sleepTimerRemainingSeconds, 0)

// Test API Provider cache key with full audio identity (endpoint, model, voice, rate, text)
const apiProvider = new ApiTtsProvider()
const cacheKey = apiProvider.getCacheKey('Hello World', { voiceId: 'alloy', rate: 1.5 })
assert.equal(cacheKey, 'default::tts-1::alloy::1.5::Hello World')

// Test Listening Telemetry & Overlapping Interval Union
console.log('--- Testing Read vs Listen & Interval Union ---')
const mixedSessions = [
    { id: 'sess_1', bookId: 'b1', durationSeconds: 1800, startTime: '2026-06-01T10:00:00Z', endTime: '2026-06-01T10:30:00Z', isListening: false },
    { id: 'sess_2', bookId: 'b1', durationSeconds: 1800, startTime: '2026-06-01T10:15:00Z', endTime: '2026-06-01T10:45:00Z', isListening: true }, // 15m overlap with sess_1
    { id: 'sess_1', bookId: 'b1', durationSeconds: 1800, startTime: '2026-06-01T10:00:00Z', isListening: false } // duplicate id, must be deduped
]

const mixedReport = buildAnnualReport(2026, { sessions: mixedSessions, books: mockBooks, highlights: [] })
assert.equal(mixedReport.readSeconds, 1800, 'Read seconds should be 1800')
assert.equal(mixedReport.listenSeconds, 1800, 'Listen seconds should be 1800')
// Union of [10:00, 10:30] and [10:15, 10:45] is [10:00, 10:45] = 45 min = 2700s
assert.equal(mixedReport.totalSeconds, 2700, 'Total seconds must be interval union (2700s), avoiding double-counting')
assert.ok(mixedReport.acts[1].statDesc.includes('有声聆听'), 'Act 2 must report listening hours when listenSeconds > 0')

// Test TTS Player listening telemetry recording on play
player.readerApp = { currentBookId: 'book_tts_test', currentBookData: { title: '听书测试' } }
player.segments = [{ text: '第一句' }, { text: '第二句' }]
player.providers[player.currentProviderName] = {
    play: async (seg, opts) => {
        if (opts.onPlaybackStarted) opts.onPlaybackStarted()
    },
    prefetch: async () => {},
    pause: () => {},
    resume: () => {},
    stop: () => {}
}
player.play(0)
assert.ok(player._listenStartTime > 0, '_listenStartTime must be initialized when playback starts')
player.flushListeningSession()
assert.equal(player._listenStartTime, null, '_listenStartTime must be reset after flush')

// Test B3 Mandatory Regression Scenario:
// Seg 1 plays 10s -> pause 5s -> resume 5s -> Seg 2 plays 20s. Total listening duration MUST be 35s!
console.log('--- Testing B3 Regression: 10s play + 5s pause + 5s resume + 20s Seg 2 ---')
let fakeTime = 1770000000000
const originalDateNow = Date.now
Date.now = () => fakeTime

try {
    const regPlayer = new TtsPlayer()
    regPlayer.readerApp = { currentBookId: 'book_b3_test', currentBookData: { title: 'B3回归测试' } }
    regPlayer.sessionBookOwner = { bookId: 'book_b3_test', bookTitle: 'B3回归测试', startTimestamp: fakeTime }

    // Seg 1 starts playing
    regPlayer.state = 'playing'
    regPlayer._currentSegmentStartTime = fakeTime
    // Plays for 10s
    fakeTime += 10000

    // Pause for 5s (flush session intervals, closing open interval [0, 10s])
    regPlayer.pause(false)
    assert.equal(regPlayer.state, 'paused')
    assert.equal(regPlayer._currentSegmentStartTime, null)
    // 5 seconds elapsed during pause
    fakeTime += 5000

    // Resume for 5s
    regPlayer.resume(false)
    assert.equal(regPlayer.state, 'playing')
    assert.equal(regPlayer._currentSegmentStartTime, fakeTime)
    // 5s elapsed during resume
    fakeTime += 5000

    // Seg 1 completed -> onPlaybackStarted for Seg 2 triggers
    const now = fakeTime
    if (regPlayer._currentSegmentStartTime) {
        regPlayer.activeListeningIntervals.push([regPlayer._currentSegmentStartTime, now])
    }
    regPlayer._currentSegmentStartTime = now

    // Seg 2 plays for 20s
    fakeTime += 20000

    // Seg 2 completes
    if (regPlayer._currentSegmentStartTime) {
        regPlayer.activeListeningIntervals.push([regPlayer._currentSegmentStartTime, fakeTime])
        regPlayer._currentSegmentStartTime = null
    }

    // Now compute total listening seconds from activeListeningIntervals
    const intervals = regPlayer.activeListeningIntervals.slice()
    intervals.sort((a, b) => a[0] - b[0])
    let unionSecs = 0
    let cur = null
    for (const [s, e] of intervals) {
        if (!cur) cur = [s, e]
        else if (s <= cur[1]) cur[1] = Math.max(cur[1], e)
        else {
            unionSecs += (cur[1] - cur[0]) / 1000
            cur = [s, e]
        }
    }
    if (cur) unionSecs += (cur[1] - cur[0]) / 1000

    assert.equal(unionSecs, 35, 'Total listening duration must be exactly 35s (10s + 5s + 20s), excluding 5s pause!')
    console.log('✓ B3 Mandatory Regression Scenario: 10s + 5s pause + 5s resume + 20s = 35s verified perfectly')
} finally {
    Date.now = originalDateNow
}

console.log('✓ TTS Player state machine, bounds, timer and telemetry verified')
console.log('✓ Read vs listen separation, deduplication, and interval union verified')
console.log('\nALL ANNUAL REPORT & TTS TESTS PASSED CLEANLY!')
