// scripts/test-astra-review-s1-s5.mjs
// Comprehensive Verification Suite for Astra S1-S5 & 60s Threshold Revision

import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const ROOT = 'D:/LindenLeaf-Dev/linden-next-dev'

console.log('====================================================')
console.log('Starting S1-S5 Verification Suite for Linden Leaf')
console.log('====================================================\n')

let passedCount = 0
let failedCount = 0

async function test(name, fn) {
    try {
        await fn()
        console.log(`  [PASS] ${name}`)
        passedCount++
    } catch (err) {
        console.error(`  [FAIL] ${name}`)
        console.error('    Error:', err.message || err)
        if (err.stack) {
            console.error('    ' + err.stack.split('\n').slice(1, 4).join('\n    '))
        }
        failedCount++
    }
}

// ============================================================================
// Helper: Create Sandbox with Mock IDB & localStorage
// ============================================================================
function createTestEnv() {
    const storage = new Map()
    const localStorage = {
        getItem: k => storage.get(k) || null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: k => storage.delete(k),
        clear: () => storage.clear()
    }

    const booksDB = new Map()
    const sessionsDB = new Map()
    let recordSessionCalls = 0
    let injectedSessionError = null
    let injectedProgressError = null

    const dbMock = {
        toLocalDateKey: (ts = Date.now()) => {
            const d = new Date(ts)
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        },
        recordReadingSession: async (record) => {
            recordSessionCalls++
            if (injectedSessionError) throw injectedSessionError
            const prev = sessionsDB.get(record.id)
            const prevDuration = prev?.durationSeconds || 0
            const delta = Math.max(0, (record.durationSeconds || 0) - prevDuration)
            sessionsDB.set(record.id, { ...record })

            if (record.bookId && delta > 0) {
                const b = booksDB.get(record.bookId) || { id: record.bookId, totalReadingSeconds: 0 }
                b.totalReadingSeconds = (b.totalReadingSeconds || 0) + delta
                b.lastReadAt = Date.now()
                booksDB.set(record.bookId, b)
            }
            return record.id
        },
        updateBookProgress: async (bookId, progress) => {
            if (injectedProgressError) throw injectedProgressError
            const b = booksDB.get(bookId) || { id: bookId }
            b.progress = progress
            booksDB.set(bookId, b)
            return true
        },
        getBook: async (bookId) => booksDB.get(bookId) || null,
        getBookFileSnapshot: async (bookId) => {
            const b = booksDB.get(bookId)
            if (!b) return null
            return {
                bookId,
                blobRevision: b.blobRevision || 'rev-1',
                revisionOrigin: b.revisionOrigin || 'orig-1',
                documentHash: b.documentHash || 'hash-1',
                blob: b.blob || { size: 1024, type: 'application/epub+zip' }
            }
        },
        backupPendingProgress: (bookId, progress) => true,
        clearPendingProgressBackup: (bookId) => {},
        isContentIdentityMatching: (a, b) => {
            if (!a || !b) return { matches: false }
            if (a.blobRevision && b.blobRevision) {
                return { matches: a.blobRevision === b.blobRevision }
            }
            return { matches: false }
        }
    }

    return {
        storage,
        localStorage,
        booksDB,
        sessionsDB,
        dbMock,
        getRecordSessionCalls: () => recordSessionCalls,
        setInjectedSessionError: (err) => { injectedSessionError = err },
        setInjectedProgressError: (err) => { injectedProgressError = err }
    }
}

// Helper: load ReadingTracker class from file
function loadTrackerClass(env) {
    const src = fs.readFileSync(ROOT + '/js/tracker.js', 'utf8')
    const ctx = vm.createContext({
        db: env.dbMock,
        console,
        localStorage: env.localStorage,
        setInterval: () => 1,
        clearInterval: () => {},
        Date,
        Math,
        MIN_PAGE_TIME_SECS: 3,
        MAX_PAGE_FOREGROUND_SECS: 300,
        MAX_PAGE_BACKGROUND_SECS: 0,
        ROLLING_WINDOW_CAPACITY: 12
    })
    const klass = src.slice(src.indexOf('export class ReadingTracker'), src.indexOf('export const tracker')).replace('export class', 'class')
    return vm.runInContext(klass + ';ReadingTracker', ctx)
}

// Helper: load app methods from file
function loadAppMethods(env, trackerInstance) {
    const src = fs.readFileSync(ROOT + '/js/app.js', 'utf8')
    const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))
    const acknowledgements = []
    const platformBridge = {
        flushComplete: (id) => acknowledgements.push(id)
    }

    const ctx = vm.createContext({
        db: env.dbMock,
        tracker: trackerInstance,
        platformBridge,
        AbortController,
        clearTimeout,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        console,
        Date,
        Math
    })

    const code = '({' +
        between('    makeProgressSnapshot(session) {', '    async openBook(bookOrId) {') + ',' +
        between('    async openBook(bookOrId) {', '    // Flush pending progress') + ',' +
        between('    async flushReaderStateOnExit(requestId = null) {', '    async closeReader() {') + ',' +
        between('    async closeReader() {', '    onReaderRelocate(') +
        '})'

    const methods = vm.runInContext(code, ctx)
    return {
        methods,
        acknowledgements,
        platformBridge
    }
}

// Helper: load db progress methods from file
function loadDbProgressMethods(env) {
    const src = fs.readFileSync(ROOT + '/js/db.js', 'utf8')
    const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))
    const ctx = vm.createContext({
        localStorage: env.localStorage,
        console,
        Date,
        Math,
        getBook: env.dbMock.getBook,
        getBookFileSnapshot: env.dbMock.getBookFileSnapshot,
        isContentIdentityMatching: env.dbMock.isContentIdentityMatching,
        updateBookProgress: env.dbMock.updateBookProgress
    })
    const code = `
        ${between('// Progress crash recovery backup', 'export const updateBookReadingTime =')}
        ;({ backupPendingProgress, clearPendingProgressBackup, recoverPendingProgressBackup })
    `.replace(/export const /g, 'const ')
    return vm.runInContext(code, ctx)
}

// ============================================================================
// SUITE 1: S1 - 计时保存队列卡死修复与迟到计时启动所有权守卫
// ============================================================================
console.log('Suite 1: S1 - Tracker Queue Unstuck & Ownership Guard')

await test('S1.1: First session write reject does not block subsequent session from writing to DB', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Session A: inject failure
    await t.startSession('A', 'Book A', 0.1)
    t.sessionCumulativeSeconds = 90
    env.setInjectedSessionError(new Error('Injected DB write failure for A'))

    await assert.rejects(t.endSession(0.2), /Injected DB write failure for A/)
    assert.equal(env.getRecordSessionCalls(), 1, 'Session A attempted 1 write')

    // Session B: clear error -> must successfully call DB and commit
    env.setInjectedSessionError(null)
    await t.startSession('B', 'Book B', 0.3)
    t.sessionCumulativeSeconds = 90
    const resB = await t.endSession(0.4)

    assert.equal(resB.status, 'committed', 'Session B committed successfully')
    assert.equal(env.getRecordSessionCalls(), 2, 'Session B actually called DB and succeeded')
    assert.equal(env.sessionsDB.size, 1, 'Session B was recorded in DB')
})

await test('S1.2: Delayed startSession(B) does not overwrite active startSession(C)', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const u = new Tracker()

    await u.startSession('A', 'Book A', 0.1)
    u.sessionCumulativeSeconds = 90

    // Delay flush of A
    let releaseA
    const flushPromise = new Promise(r => releaseA = r)
    const origFlush = u.flush.bind(u)
    u.flush = async (...args) => {
        await flushPromise
        return origFlush(...args)
    }

    // Start B while A is still active; B awaits A's endSession
    const pendingB = u.startSession('B', 'Book B', 0.2)
    await Promise.resolve()

    // Meanwhile, start C
    await u.startSession('C', 'Book C', 0.3)
    assert.equal(u.currentBookId, 'C', 'C became active book')

    // Release A's flush -> pendingB resumes
    releaseA()
    await pendingB

    // u.currentBookId MUST remain C!
    assert.equal(u.currentBookId, 'C', 'Late start(B) was discarded and did not overwrite C')
})

await test('S1.3: Old failed session backup is preserved and can be recovered', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    await t.startSession('A', 'Book A', 0.1)
    t.sessionCumulativeSeconds = 90
    env.setInjectedSessionError(new Error('DB failure'))

    await assert.rejects(t.endSession(0.2))

    // Backup for A should still exist in localStorage
    const rawMap = env.localStorage.getItem('linden_pending_session_backups')
    assert.ok(rawMap, 'Pending backups map exists')
    const backups = JSON.parse(rawMap)
    assert.ok(Object.values(backups).some(b => b.bookId === 'A' && b.durationSeconds === 90), 'Backup for A is preserved')

    // Now clear error and recover
    env.setInjectedSessionError(null)
    await t.recoverPendingBackup()

    assert.equal(env.sessionsDB.size, 1, 'Recovered session A is now in DB')
    const remaining = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
    assert.equal(Object.keys(remaining).length, 0, 'Backup cleared after successful recovery')
})

await test('S1.4: ReadingTracker._backupVersion is initialized, increments as integer, and never produces NaN', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    assert.equal(t._backupVersion, 0, '_backupVersion initialized to 0 in constructor')

    await t.startSession('book-ver', 'Book Version', 0.1)
    t.sessionCumulativeSeconds = 30 // short session

    // End session directly without prior backup
    const res = await t.endSession(0.2)
    assert.equal(typeof t._backupVersion, 'number')
    assert.equal(Number.isNaN(t._backupVersion), false, '_backupVersion is not NaN')
    assert.equal(t._backupVersion, 1, '_backupVersion incremented to 1')
})

// ============================================================================
// SUITE 2: S2 - 进度与计时备份恢复隔离与边界防护
// ============================================================================
console.log('\nSuite 2: S2 - Backup Recovery Isolation & Barrier Protection')

await test('S2.1: Recovery barrier deduplication: Concurrent recovery calls return same in-flight promise', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Store backup for session 1
    const backupData = {
        sessionId: 'sess_1',
        bookId: 'book_1',
        bookTitle: 'Book 1',
        durationSeconds: 90,
        startTime: Date.now() - 90000,
        version: 1
    }
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({ sess_1: backupData }))

    // Trigger two concurrent recoverPendingBackup calls
    const p1 = t.recoverPendingBackup()
    const p2 = t.recoverPendingBackup()
    assert.equal(p1, p2, 'Concurrent calls share the same Promise instance')

    await Promise.all([p1, p2])
    assert.equal(env.getRecordSessionCalls(), 1, 'Only 1 DB write was executed')
    assert.equal(env.sessionsDB.get('sess_1')?.durationSeconds, 90)
})

await test('S2.2: Backup isolation: Recovery of A does not clear newer backup B created in between', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Backup A exists
    const backupA = { sessionId: 'sess_A', bookId: 'A', bookTitle: 'Book A', durationSeconds: 90, startTime: Date.now(), version: 1 }
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({ sess_A: backupA }))

    // Intercept DB write to inject backup B while A is recovering
    const origRecord = env.dbMock.recordReadingSession
    env.dbMock.recordReadingSession = async (rec) => {
        // While A is committing, B gets backed up
        const backupB = { sessionId: 'sess_B', bookId: 'B', bookTitle: 'Book B', durationSeconds: 120, startTime: Date.now(), version: 1 }
        const map = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
        map['sess_B'] = backupB
        env.localStorage.setItem('linden_pending_session_backups', JSON.stringify(map))
        return origRecord(rec)
    }

    await t.recoverPendingBackup()

    // Check localStorage: A should be removed, B MUST remain!
    const map = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
    assert.equal(map['sess_A'], undefined, 'Session A backup was cleared')
    assert.ok(map['sess_B'], 'Session B backup was NOT cleared and remains preserved')
    assert.equal(map['sess_B'].durationSeconds, 120)
})

await test('S2.3: Same session newer version backup is preserved if recovery was for older version', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Backup version 1
    const backupV1 = { sessionId: 'sess_A', bookId: 'A', bookTitle: 'Book A', durationSeconds: 90, startTime: Date.now(), version: 1 }
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({ sess_A: backupV1 }))

    // Intercept DB write: while v1 recovers, update backup to version 2
    const origRecord = env.dbMock.recordReadingSession
    env.dbMock.recordReadingSession = async (rec) => {
        const backupV2 = { sessionId: 'sess_A', bookId: 'A', bookTitle: 'Book A', durationSeconds: 150, startTime: Date.now(), version: 2 }
        const map = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
        map['sess_A'] = backupV2
        env.localStorage.setItem('linden_pending_session_backups', JSON.stringify(map))
        return origRecord(rec)
    }

    await t.recoverPendingBackup()

    // sess_A should still exist with version 2!
    const map = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
    assert.ok(map['sess_A'], 'sess_A was not cleared because newer version 2 exists')
    assert.equal(map['sess_A'].version, 2)
})

await test('S2.4: Duplicate recovery does not double-count duration in book total', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    const backup = { sessionId: 'sess_A', bookId: 'A', bookTitle: 'Book A', durationSeconds: 100, startTime: Date.now(), version: 1 }
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({ sess_A: backup }))

    // First recovery
    await t.recoverPendingBackup()
    assert.equal(env.booksDB.get('A')?.totalReadingSeconds, 100)

    // Artificially re-insert backup (simulating retry or legacy key)
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({ sess_A: backup }))
    await t.recoverPendingBackup()

    // Book total MUST still be 100, not 200!
    assert.equal(env.booksDB.get('A')?.totalReadingSeconds, 100, 'Duplicate recovery did not accumulate duplicate seconds')
})

await test('S2.5: db.recoverPendingProgressBackup discards backup when book is deleted', async () => {
    const env = createTestEnv()
    const { recoverPendingProgressBackup, backupPendingProgress } = loadDbProgressMethods(env)

    // Book does NOT exist in booksDB
    backupPendingProgress('deleted-book', { fraction: 0.5, updatedAt: 1000 })
    assert.ok(env.localStorage.getItem('linden_pending_progress_backups'), 'Backup was created')

    await recoverPendingProgressBackup()

    const rawMap = env.localStorage.getItem('linden_pending_progress_backups')
    const parsed = JSON.parse(rawMap || '{}')
    assert.equal(parsed['deleted-book'], undefined, 'Backup for deleted book was discarded')
})

await test('S2.6: db.recoverPendingProgressBackup discards backup when content identity mismatches', async () => {
    const env = createTestEnv()
    const { recoverPendingProgressBackup, backupPendingProgress } = loadDbProgressMethods(env)

    // Book exists with revision rev-1
    env.booksDB.set('book-diff', { id: 'book-diff', blobRevision: 'rev-1' })

    // Backup is for replaced book with revision rev-2
    backupPendingProgress('book-diff', { fraction: 0.8, blobRevision: 'rev-2', updatedAt: 1000 })

    await recoverPendingProgressBackup()

    const rawMap = env.localStorage.getItem('linden_pending_progress_backups')
    const parsed = JSON.parse(rawMap || '{}')
    assert.equal(parsed['book-diff'], undefined, 'Mismatched backup was discarded')
    assert.equal(env.booksDB.get('book-diff').progress, undefined, 'Mismatched progress was not applied')
})

await test('S2.7: db.recoverPendingProgressBackup discards obsolete backup when newer progress exists', async () => {
    const env = createTestEnv()
    const { recoverPendingProgressBackup, backupPendingProgress } = loadDbProgressMethods(env)

    // Book exists with newer progress at t=2000
    env.booksDB.set('book-obs', {
        id: 'book-obs',
        progress: { fraction: 0.7, updatedAt: 2000 }
    })

    // Backup has older progress at t=1000
    backupPendingProgress('book-obs', { fraction: 0.3, updatedAt: 1000 })

    await recoverPendingProgressBackup()

    const rawMap = env.localStorage.getItem('linden_pending_progress_backups')
    const parsed = JSON.parse(rawMap || '{}')
    assert.equal(parsed['book-obs'], undefined, 'Obsolete backup was discarded')
    assert.equal(env.booksDB.get('book-obs').progress.fraction, 0.7, 'Newer progress was preserved')
})

await test('S2.8: db.recoverPendingProgressBackup retains backup when progress update aborts/fails', async () => {
    const env = createTestEnv()
    const { recoverPendingProgressBackup, backupPendingProgress } = loadDbProgressMethods(env)

    env.booksDB.set('book-fail', { id: 'book-fail' })
    backupPendingProgress('book-fail', { fraction: 0.5, updatedAt: 1000 })

    // Inject failure
    env.setInjectedProgressError(new Error('Progress DB abort'))

    await recoverPendingProgressBackup()

    // Backup MUST still exist!
    const rawMap = env.localStorage.getItem('linden_pending_progress_backups')
    const parsed = JSON.parse(rawMap || '{}')
    assert.ok(parsed['book-fail'], 'Backup was retained after failed recovery')
})

await test('S2.9: db.clearPendingProgressBackup does not delete newer backup created in between', async () => {
    const env = createTestEnv()
    const { backupPendingProgress, clearPendingProgressBackup } = loadDbProgressMethods(env)

    // Old backup created at t=1000
    backupPendingProgress('book-race', { fraction: 0.2, updatedAt: 1000 })

    // While old backup was in flight, a newer backup is created at t=2000
    backupPendingProgress('book-race', { fraction: 0.5, updatedAt: 2000 })

    // Old clear attempt tries to clear t=1000
    clearPendingProgressBackup('book-race', 1000)

    // Newer backup MUST still remain!
    const rawMap = env.localStorage.getItem('linden_pending_progress_backups')
    const parsed = JSON.parse(rawMap || '{}')
    assert.ok(parsed['book-race'], 'Newer backup was NOT deleted by stale clear call')
    assert.equal(parsed['book-race'].progress.fraction, 0.5)
})

// ============================================================================
// SUITE 3: S3 - 退出保存独立执行与状态准确汇报
// ============================================================================
console.log('\nSuite 3: S3 - Independent Exit Flush & Accurate Status')

await test('S3.1: Progress permanently pending does not block tracker from attempting save', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    let trackerSaveAttempted = false
    t.isTracking = true
    t.endSession = async () => {
        trackerSaveAttempted = true
        return { status: 'committed', durationSeconds: 80 }
    }

    // Progress hangs forever
    env.dbMock.updateBookProgress = () => new Promise(() => {}) // never resolves

    const { methods, platformBridge } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'book-1',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-1' },
            location: { fraction: 0.5 }
        },
        currentBookId: 'book-1',
        makeProgressSnapshot: () => ({ fraction: 0.5, updatedAt: Date.now() })
    }

    // Call flushReaderStateOnExit
    const exitPromise = app.flushReaderStateOnExit('req-hang')

    // Yield macro task to allow async IIFE to start
    await new Promise(r => setTimeout(r, 10))

    assert.equal(trackerSaveAttempted, true, 'Tracker save was launched immediately despite progress being pending')
})

await test('S3.2: Progress succeeds but tracker and its backup fail -> reports failed', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    t.isTracking = true
    t.backupPendingSession = () => false // backup fails
    t.endSession = async () => { throw new Error('Tracker DB crashed') } // save fails

    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'book-1',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-1' },
            location: { fraction: 0.5 }
        },
        currentBookId: 'book-1',
        makeProgressSnapshot: () => ({ fraction: 0.5, updatedAt: Date.now() })
    }

    const res = await app.flushReaderStateOnExit('req-fail-tracker')
    assert.equal(res.status, 'failed', 'Overall status is failed because tracker failed and had no backup')
    assert.equal(res.progressStatus, 'committed')
    assert.equal(res.trackerStatus, 'failed')
})

await test('S3.3: Opening Book B during exit wait does not end Book B', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Start tracking Book A
    await t.startSession('book-A', 'Book A', 0.1)
    t.sessionCumulativeSeconds = 90

    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'book-A',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-A' },
            location: { fraction: 0.5 }
        },
        currentBookId: 'book-A',
        makeProgressSnapshot: () => ({ fraction: 0.5, updatedAt: Date.now() })
    }

    // Now user switches to Book B
    await t.startSession('book-B', 'Book B', 0.1)
    assert.equal(t.currentBookId, 'book-B', 'Book B is now actively tracked')

    // Exit flush for Book A arrives (with activeBookId = 'book-A')
    const res = await t.endSession(0.5, 'book-A')

    // Tracker should NOT end Book B!
    assert.equal(t.currentBookId, 'book-B', 'Book B is still tracking!')
    assert.equal(t.isTracking, true, 'Book B is still active')
})

await test('S3.4: Duplicate requestId returns cached result without re-executing DB writes', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    let dbWrites = 0
    env.dbMock.updateBookProgress = async () => { dbWrites++; return true }
    t.endSession = async () => ({ status: 'committed', durationSeconds: 70 })

    const { methods, acknowledgements } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'book-1',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-1' },
            location: { fraction: 0.5 }
        },
        currentBookId: 'book-1',
        makeProgressSnapshot: () => ({ fraction: 0.5, updatedAt: Date.now() })
    }

    // First call
    const res1 = await app.flushReaderStateOnExit('req-dedup')
    assert.equal(res1.status, 'database_success')
    assert.equal(dbWrites, 1)
    assert.deepEqual(acknowledgements, ['req-dedup'])

    // Second call with same requestId
    const res2 = await app.flushReaderStateOnExit('req-dedup')
    assert.equal(res2.status, 'database_success')
    assert.equal(dbWrites, 1, 'DB write was NOT executed again')
    assert.deepEqual(acknowledgements, ['req-dedup'], 'flushComplete was NOT called again')
})

await test('S3.5: flushReaderStateOnExit accurately reports trackerStatus as not_applicable when tracker returns not_applicable', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Tracker returns not_applicable (e.g. no active tracking)
    t.isTracking = false
    t.endSession = async () => ({ status: 'not_applicable' })

    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'book-na',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-1' },
            location: { fraction: 0.5 }
        },
        currentBookId: 'book-na',
        makeProgressSnapshot: () => ({ fraction: 0.5, updatedAt: Date.now() })
    }

    const res = await app.flushReaderStateOnExit('req-na')
    assert.equal(res.trackerStatus, 'not_applicable', 'trackerStatus must be not_applicable, NOT committed')
    assert.equal(res.trackerSaved, false, 'trackerSaved must be false')
    assert.equal(res.progressStatus, 'committed')
    assert.equal(res.status, 'database_success')
})

await test('S3.6: tracker.endSession with mismatched targetBookId returns not_applicable without returning previous session promise', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // Start tracking Book A
    await t.startSession('book-A', 'Book A', 0.1)
    t.sessionCumulativeSeconds = 90

    // End session for Book A
    await t.endSession(0.5, 'book-A')

    // Now call endSession with unrelated book-Z
    const res = await t.endSession(0.5, 'book-Z')
    assert.equal(res.status, 'not_applicable', 'Mismatched targetBookId returns not_applicable')
})

// ============================================================================
// SUITE 4: S4 - 60 秒门槛口径一致性 (按 06 号文档执行)
// ============================================================================
console.log('\nSuite 4: S4 - 60-Second Reading Session Threshold Consistency')

await test('S4.1: Normal exit at 59s is filtered; 60s is committed as 60; 65s is committed as 65', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // 59s -> filtered
    await t.startSession('book-1', 'Book 1', 0.1)
    t.sessionCumulativeSeconds = 59
    const res59 = await t.endSession(0.2)
    assert.equal(res59.status, 'filtered_short_session')
    assert.equal(env.sessionsDB.size, 0, '59s not recorded in DB')

    // 60s -> committed as 60s
    await t.startSession('book-1', 'Book 1', 0.2)
    t.sessionCumulativeSeconds = 60
    const res60 = await t.endSession(0.3)
    assert.equal(res60.status, 'committed')
    assert.equal(env.sessionsDB.size, 1)
    const sess60 = Array.from(env.sessionsDB.values())[0]
    assert.equal(sess60.durationSeconds, 60, 'Full 60s recorded')

    // 65s -> committed as 65s
    await t.startSession('book-1', 'Book 1', 0.3)
    t.sessionCumulativeSeconds = 65
    const res65 = await t.endSession(0.4)
    assert.equal(res65.status, 'committed')
    const sess65 = Array.from(env.sessionsDB.values()).find(s => s.durationSeconds === 65)
    assert.ok(sess65, 'Full 65s recorded, not just excess (5s)')
})

await test('S4.2: Two independent 40s sessions are both filtered (not combined into 80s)', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // First 40s
    await t.startSession('book-1', 'Book 1', 0.1)
    t.sessionCumulativeSeconds = 40
    const r1 = await t.endSession(0.2)
    assert.equal(r1.status, 'filtered_short_session')

    // Second 40s
    await t.startSession('book-1', 'Book 1', 0.2)
    t.sessionCumulativeSeconds = 40
    const r2 = await t.endSession(0.3)
    assert.equal(r2.status, 'filtered_short_session')

    assert.equal(env.sessionsDB.size, 0, 'Neither session recorded')
    assert.equal(env.booksDB.get('book-1')?.totalReadingSeconds || 0, 0)
})

await test('S4.3: Same session 40s + pause + 30s counts as 70s', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    await t.startSession('book-1', 'Book 1', 0.1)
    t.sessionCumulativeSeconds = 40

    // Pause (blur / idle)
    t.isIdle = true
    // Resume
    t.resetActivity()
    t.sessionCumulativeSeconds += 30 // now 70s

    const res = await t.endSession(0.4)
    assert.equal(res.status, 'committed')
    assert.equal(res.durationSeconds, 70)
    assert.equal(env.booksDB.get('book-1')?.totalReadingSeconds, 70)
})

await test('S4.4: 20s periodic save does not reset threshold or clear backup', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    await t.startSession('book-1', 'Book 1', 0.1)
    t.sessionCumulativeSeconds = 20

    // Simulate 20s periodic flush (isFinal = false)
    t.backupPendingSession()
    const periodicRes = await t.flush(false)
    assert.equal(periodicRes.status, 'filtered_short_session')

    // Backup MUST still exist!
    const map = JSON.parse(env.localStorage.getItem('linden_pending_session_backups') || '{}')
    assert.ok(map[t.currentSessionId], 'Pending backup preserved during periodic flush')

    // Continue reading to 65s and end
    t.sessionCumulativeSeconds = 65
    const finalRes = await t.endSession(0.5)
    assert.equal(finalRes.status, 'committed')
    assert.equal(finalRes.durationSeconds, 65)
})

await test('S4.5: Cross-midnight 40s yesterday + 30s today commits both slices (total 70s)', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    await t.startSession('book-1', 'Book 1', 0.1)
    t.sessionCumulativeSeconds = 40

    // Simulate midnight slice split
    t.sessionSlices = [{
        id: 'slice-yesterday',
        bookId: 'book-1',
        bookTitle: 'Book 1',
        date: '2026-09-21',
        startTime: Date.now() - 70000,
        endTime: Date.now() - 30000,
        durationSeconds: 40,
        startProgress: 0.1,
        endProgress: 0.2
    }]
    t.sessionCumulativeSeconds = 30 // today's portion

    const res = await t.endSession(0.3)
    assert.equal(res.status, 'committed')
    assert.equal(res.durationSeconds, 70)

    // Both slices should be in DB!
    assert.equal(env.sessionsDB.size, 2, 'Both yesterday and today slices recorded')
    assert.equal(env.sessionsDB.get('slice-yesterday')?.durationSeconds, 40)
    assert.equal(env.booksDB.get('book-1')?.totalReadingSeconds, 70, 'Book total accumulated both slices')
})

await test('S4.6: 30s crash backup is filtered on recovery; 90s crash backup commits and is idempotent', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    // 30s crashed session
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({
        sess_30: { sessionId: 'sess_30', bookId: 'b-1', durationSeconds: 30, startTime: Date.now() }
    }))
    await t.recoverPendingBackup()
    assert.equal(env.sessionsDB.size, 0, '30s crash backup was filtered and not recorded')

    // 90s crashed session
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({
        sess_90: { sessionId: 'sess_90', bookId: 'b-1', durationSeconds: 90, startTime: Date.now() }
    }))
    await t.recoverPendingBackup()
    assert.equal(env.sessionsDB.size, 1, '90s crash backup was committed')
    assert.equal(env.booksDB.get('b-1')?.totalReadingSeconds, 90)

    // Idempotent recovery
    env.localStorage.setItem('linden_pending_session_backups', JSON.stringify({
        sess_90: { sessionId: 'sess_90', bookId: 'b-1', durationSeconds: 90, startTime: Date.now() }
    }))
    await t.recoverPendingBackup()
    assert.equal(env.booksDB.get('b-1')?.totalReadingSeconds, 90, 'Total reading seconds did not double')
})

await test('S4.7: 20s exit still saves reading progress and position', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    await t.startSession('b-pos', 'Book Position', 0.1)
    t.sessionCumulativeSeconds = 20

    let savedProgress = null
    env.dbMock.updateBookProgress = async (id, prog) => {
        savedProgress = prog
        return true
    }

    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        _activeSession: {
            bookId: 'b-pos',
            isCurrent: () => true,
            snapshot: { blobRevision: 'rev-1' },
            location: { fraction: 0.35, page: 35 }
        },
        currentBookId: 'b-pos',
        makeProgressSnapshot: () => ({ fraction: 0.35, page: 35, updatedAt: Date.now() })
    }

    const res = await app.flushReaderStateOnExit('req-pos')
    assert.equal(res.progressStatus, 'committed')
    assert.equal(res.trackerStatus, 'filtered_short_session')
    assert.equal(savedProgress?.fraction, 0.35, 'Progress was saved despite 20s duration')
})

// ============================================================================
// SUITE 5: S5 - openBook 容错与云书下载分支前置
// ============================================================================
console.log('\nSuite 5: S5 - openBook Error Handling & Cloud Book Branch')

await test('S5.1: Cloud-only book triggers handleCloudBookClick before requiring local blob', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    let cloudClicked = false
    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        ensureRecoveryBarrier: async () => {},
        handleCloudBookClick: async (book) => { cloudClicked = true },
        closeReader: () => {}
    }

    // Book is cloud-only, has NO blob
    env.booksDB.set('cloud-1', {
        id: 'cloud-1',
        title: 'Cloud Book',
        isCloudOnly: true,
        blob: null
    })

    await app.openBook('cloud-1')
    assert.equal(cloudClicked, true, 'handleCloudBookClick was called without erroring on missing blob')
})

await test('S5.2: openBook failure cleanly closes reader and does not leave unhandled rejection', async () => {
    const env = createTestEnv()
    const Tracker = loadTrackerClass(env)
    const t = new Tracker()

    let readerClosed = false
    let toastMessage = ''
    const { methods } = loadAppMethods(env, t)
    const app = {
        ...methods,
        dom: {},
        ensureRecoveryBarrier: async () => { throw new Error('Recovery DB corrupt') },
        closeReader: () => { readerClosed = true },
        showToast: (msg) => { toastMessage = msg }
    }

    // Should NOT throw unhandled rejection
    await app.openBook('bad-book')
    assert.equal(readerClosed, true, 'closeReader was called on failure')
    assert.ok(toastMessage.includes('Recovery DB corrupt'), 'Toast displayed error')
})

console.log('\n====================================================')
console.log(`Verification Complete: ${passedCount} / ${passedCount + failedCount} tests passed.`)
console.log('====================================================')

if (failedCount > 0) {
    process.exit(1)
} else {
    process.exit(0)
}
