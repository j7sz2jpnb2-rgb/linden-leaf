// tracker.js - High-Precision Reading Time Tracker with Dual-State Time Window & Adaptive Pacing

import * as db from './db.js'

// Reading Time Window & Pacing constants (Classic statistical trimming)
export const MIN_PAGE_TIME_SECS = 3         // < 3s = fast skimming/jumping, discard from pace model
export const MAX_PAGE_FOREGROUND_SECS = 300 // > 300s = idle/walk away without interaction, excess is clamped
export const MAX_PAGE_BACKGROUND_SECS = 0   // Backgrounded or blurred = timer pauses immediately
export const ROLLING_WINDOW_CAPACITY = 12   // Maintain rolling window of last 12 valid page durations

export class ReadingTracker {
    constructor() {
        this._clock = null
        this.currentBookId = null
        this.currentBookTitle = null
        this.currentSessionId = null
        this.sessionStartTime = null
        this.sessionStartFraction = 0
        this.sessionCumulativeSeconds = 0
        this.lastFlushTime = 0
        this.lastFlushAttemptTime = 0
        this.lastCommittedTime = 0
        this.lastCommittedVersion = 0
        this._activeFlushPromise = null
        this._committedHistoricalSeconds = 0
        this.lastActivityTime = Date.now()
        
        this.isTracking = false
        this.isIdle = false
        this.idleThresholdMs = 180 * 1000 // 180 seconds of no interaction = idle

        this.tickerInterval = null
        this.onTickCallback = null
        this.sessionToken = 0 // Monotonic token to prevent session race conditions
        this._backupVersion = 0 // Monotonic backup version to isolate session backup state

        // Adaptive Pacing & Time Window State
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = Date.now()
        this.rollingPagePaces = [] // stores last valid page durations (seconds)
        this.userBaselinePagePace = 65 // default ~65s/page (~400 Chinese chars/min)
        this.loadUserBaseline()

        this.initGlobalListeners()
    }

    _now() {
        return (typeof this._clock === 'function') ? this._clock() : Date.now()
    }

    loadUserBaseline() {
        try {
            const saved = localStorage.getItem('linden_user_baseline_pace')
            if (saved) {
                const val = parseFloat(saved)
                if (val >= 15 && val <= 180) this.userBaselinePagePace = val
            }
        } catch (e) {}
    }

    saveUserBaseline(newPace) {
        try {
            if (newPace >= 15 && newPace <= 180) {
                this.userBaselinePagePace = Math.round(newPace)
                localStorage.setItem('linden_user_baseline_pace', String(this.userBaselinePagePace))
            }
        } catch (e) {}
    }

    initGlobalListeners() {
        if (typeof document === 'undefined' || typeof window === 'undefined') return
        
        // Tab visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.isIdle = true
                this.backupPendingSession()
                this.flush().catch(() => {})
            } else {
                this.resetActivity()
            }
        })

        // Window blur / focus
        window.addEventListener('blur', () => {
            this.isIdle = true
            this.backupPendingSession()
            this.flush().catch(() => {})
        })
        window.addEventListener('focus', () => {
            this.resetActivity()
        })

        // Window unload / pagehide emergency backup & flush
        const handleEmergencyExit = () => {
            if (this.isTracking) {
                this.backupPendingSession()
                this.flush(true).catch(() => {})
            }
        }
        window.addEventListener('beforeunload', handleEmergencyExit)
        window.addEventListener('pagehide', handleEmergencyExit)
    }

    backupPendingSession(endProgress = null, sessionSnapshot = null) {
        const targetBookId = sessionSnapshot?.bookId || this.currentBookId
        const targetSessionId = sessionSnapshot?.sessionId || this.currentSessionId
        const targetTitle = sessionSnapshot?.bookTitle || this.currentBookTitle
        const targetDuration = sessionSnapshot?.durationSeconds != null ? sessionSnapshot.durationSeconds : this.sessionCumulativeSeconds
        const targetStartTime = sessionSnapshot?.startTime || this.sessionStartTime || this._now()
        const targetStartFrac = sessionSnapshot?.startFraction != null ? sessionSnapshot.startFraction : this.sessionStartFraction
        const targetSlices = sessionSnapshot?.slices || (this.sessionSlices ? [...this.sessionSlices] : [])
        const historicalCommitted = sessionSnapshot?._committedHistoricalSeconds != null ? sessionSnapshot._committedHistoricalSeconds : (this._committedHistoricalSeconds || 0)

        if (!targetBookId || !targetSessionId || typeof localStorage === 'undefined') return false
        try {
            const parsedVersion = typeof sessionSnapshot?.version === 'number' && !Number.isNaN(sessionSnapshot.version)
                ? sessionSnapshot.version
                : ((this._backupVersion = (this._backupVersion || 0) + 1))
            this._backupVersion = parsedVersion
            const backupData = {
                sessionId: targetSessionId,
                bookId: targetBookId,
                bookTitle: targetTitle,
                durationSeconds: targetDuration,
                startTime: targetStartTime,
                startProgress: targetStartFrac,
                endProgress: endProgress != null ? endProgress : targetStartFrac,
                slices: targetSlices.filter(s => !s.committed),
                committedHistoricalSeconds: historicalCommitted,
                version: this._backupVersion,
                timestamp: this._now()
            }

            // Map-based storage for isolation across books and sessions
            let allBackups = {}
            try {
                const rawMap = localStorage.getItem('linden_pending_session_backups')
                if (rawMap) allBackups = JSON.parse(rawMap) || {}
            } catch (e) {}
            allBackups[targetSessionId] = backupData
            localStorage.setItem('linden_pending_session_backups', JSON.stringify(allBackups))

            // Legacy single key mirror strictly paired with current session
            localStorage.setItem('linden_pending_session_backup', JSON.stringify(backupData))
            return true
        } catch (e) {
            return false
        }
    }

    clearPendingSessionBackup(sessionId, version = null) {
        if (!sessionId || typeof localStorage === 'undefined') return
        try {
            let shouldClearLegacy = false
            // 1. Remove from allBackups map
            const rawMap = localStorage.getItem('linden_pending_session_backups')
            if (rawMap) {
                const allBackups = JSON.parse(rawMap) || {}
                const existing = allBackups[sessionId]
                if (existing) {
                    if (version == null || existing.version == null || existing.version <= version) {
                        delete allBackups[sessionId]
                        localStorage.setItem('linden_pending_session_backups', JSON.stringify(allBackups))
                        shouldClearLegacy = true
                    }
                } else {
                    shouldClearLegacy = true
                }
            }

            // 2. Clear legacy single key if it matches this session or if it was removed from map
            const raw = localStorage.getItem('linden_pending_session_backup')
            if (raw) {
                const parsed = JSON.parse(raw)
                if (parsed?.sessionId === sessionId) {
                    if (version == null || parsed?.version == null || parsed?.version <= version || shouldClearLegacy) {
                        localStorage.removeItem('linden_pending_session_backup')
                    }
                }
            }
        } catch (e) {}
    }

    recoverPendingBackup() {
        if (this._recoveryPromise) return this._recoveryPromise
        this._recoveryPromise = (async () => {
            const result = {
                recovered: [],
                filtered: [],
                failed: [],
                deferred: []
            }
            if (typeof localStorage === 'undefined') return result
            try {
                let backupsToRecover = []
                let rawMapExists = false
                try {
                    const rawMap = localStorage.getItem('linden_pending_session_backups')
                    if (rawMap) {
                        rawMapExists = true
                        const parsedMap = JSON.parse(rawMap)
                        if (parsedMap && typeof parsedMap === 'object') {
                            backupsToRecover = Object.values(parsedMap)
                        }
                    }
                } catch (e) {}

                try {
                    const rawLegacy = localStorage.getItem('linden_pending_session_backup')
                    if (rawLegacy) {
                        const parsedLegacy = JSON.parse(rawLegacy)
                        if (parsedLegacy?.sessionId) {
                            const inMap = backupsToRecover.some(b => b.sessionId === parsedLegacy.sessionId)
                            if (!inMap && !rawMapExists) {
                                backupsToRecover.push(parsedLegacy)
                            } else if (!inMap && rawMapExists) {
                                // Stale legacy mirror: clean it up to prevent resurrection
                                localStorage.removeItem('linden_pending_session_backup')
                            }
                        }
                    }
                } catch (e) {}

                for (const data of backupsToRecover) {
                    if (!data || !data.bookId || !data.sessionId) {
                        if (data?.sessionId) this.clearPendingSessionBackup(data.sessionId)
                        result.filtered.push({ sessionId: data?.sessionId, reason: 'malformed_data' })
                        continue
                    }

                    // Compute total duration including slices and historical committed
                    const sliceTotal = (data.slices || []).reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
                    const historical = data.committedHistoricalSeconds || 0
                    const totalDuration = (data.durationSeconds || 0) + sliceTotal + historical

                    // 60-second threshold check for recovery (consistent with normal exit per 06 doc)
                    if (totalDuration < 60) {
                        console.log(`[Tracker] Filtered short session (${totalDuration}s < 60s) from crash backup.`)
                        this.clearPendingSessionBackup(data.sessionId, data.version)
                        result.filtered.push({ sessionId: data.sessionId, totalDuration, reason: 'under_60s' })
                        continue
                    }

                    try {
                        // If >= 60s, commit uncommitted slices if any
                        if (data.slices && data.slices.length > 0) {
                            for (const slice of data.slices) {
                                if (slice.durationSeconds > 0 && !slice.committed) {
                                    await db.recordReadingSession(slice)
                                }
                            }
                        }

                        // Commit main slice
                        if (data.durationSeconds > 0) {
                            const dateStr = db.toLocalDateKey(data.startTime || this._now())
                            const recoveredRecord = {
                                id: data.sessionId,
                                bookId: data.bookId,
                                bookTitle: data.bookTitle || '已恢复会话',
                                date: dateStr,
                                startTime: data.startTime || this._now(),
                                endTime: data.timestamp || this._now(),
                                durationSeconds: data.durationSeconds,
                                startProgress: data.startProgress || 0,
                                endProgress: data.endProgress != null ? data.endProgress : (data.startProgress || 0)
                            }
                            await db.recordReadingSession(recoveredRecord)
                        }

                        // Only remove backup after successful commit!
                        this.clearPendingSessionBackup(data.sessionId, data.version)
                        console.log(`[Tracker] Successfully recovered ${totalDuration}s reading session from crash backup.`)
                        result.recovered.push({ sessionId: data.sessionId, totalDuration })
                    } catch (itemErr) {
                        console.warn(`[Tracker] Failed to commit recovered session ${data.sessionId}:`, itemErr)
                        // Retain backup on abort / failure
                        result.failed.push({ sessionId: data.sessionId, error: itemErr, data })
                    }
                }
            } catch (e) {
                console.warn('[Tracker] Failed to recover backup session:', e)
            }
            return result
        })().finally(() => {
            this._recoveryPromise = null
        })
        return this._recoveryPromise
    }

    // Call this on user interactions (keydown, click, scroll, touch, wheel)
    resetActivity() {
        this.lastActivityTime = Date.now()
        if (this.isIdle) {
            this.isIdle = false
        }
        if (this.timeOnCurrentPageSecs >= MAX_PAGE_FOREGROUND_SECS) {
            this.timeOnCurrentPageSecs = Math.max(0, MAX_PAGE_FOREGROUND_SECS - 60)
        }
    }

    async startSession(bookId, bookTitle, startFraction = 0) {
        this._startTokenSequence = (this._startTokenSequence || 0) + 1
        const startToken = this._startTokenSequence

        // Wait for any active recovery barrier before starting new session
        if (this._recoveryPromise) {
            try {
                await this._recoveryPromise
            } catch (e) {}
        }

        // Safely end existing session if any before starting new (do not pass startFraction of new book!)
        if (this.isTracking) {
            try {
                await this.endSession()
            } catch (err) {
                console.warn('[Tracker] Previous session end failed in startSession:', err)
            }
        }

        // Validate that this startSession request is still the latest one (prevent late starts from overwriting newer books)
        if (startToken !== this._startTokenSequence) {
            return
        }

        this.sessionToken++
        const currentToken = this.sessionToken

        const now = this._now()
        this.currentBookId = bookId
        this.currentBookTitle = bookTitle
        this.currentSessionId = `sess_${now}_${Math.random().toString(36).slice(2, 7)}`
        this.sessionStartTime = now
        this.sessionStartFraction = startFraction
        this.sessionCumulativeSeconds = 0
        this.sessionSlices = []
        this._committedHistoricalSeconds = 0
        this.lastFlushTime = now
        this.lastFlushAttemptTime = now
        this.lastActivityTime = now
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = now
        this.rollingPagePaces = []

        this.isTracking = true
        this.isIdle = false

        if (this.tickerInterval) clearInterval(this.tickerInterval)
        this.tickerInterval = setInterval(() => {
            if (this.sessionToken === currentToken) {
                this.tick()
            }
        }, 1000)
    }

    tick() {
        if (!this.isTracking) return

        const now = this._now()
        // Check for overall session idle (> 180s without interaction)
        if (now - this.lastActivityTime > this.idleThresholdMs) {
            this.isIdle = true
        }

        if (!this.isIdle && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
            // Midnight rollover check: if calendar date crossed during active reading,
            // gracefully record yesterday's slice and start a new slice for today without resetting session accumulation.
            const todayStr = db.toLocalDateKey(now)
            const sessionDateStr = db.toLocalDateKey(this.sessionStartTime || now)
            if (todayStr !== sessionDateStr && this.sessionCumulativeSeconds > 0) {
                this.sessionSlices = this.sessionSlices || []
                this.sessionSlices.push({
                    id: this.currentSessionId,
                    bookId: this.currentBookId,
                    bookTitle: this.currentBookTitle,
                    date: sessionDateStr,
                    startTime: this.sessionStartTime || now,
                    endTime: now - 1,
                    durationSeconds: this.sessionCumulativeSeconds,
                    startProgress: this.sessionStartFraction,
                    endProgress: this.sessionStartFraction,
                    committed: false
                })
                this.currentSessionId = `sess_${now}_${Math.random().toString(36).slice(2, 7)}`
                this.sessionStartTime = now
                this.sessionCumulativeSeconds = 0
                this.lastFlushTime = now
            }

            // Check Foreground Single Page Clamping (> 300s)
            if (this.timeOnCurrentPageSecs < MAX_PAGE_FOREGROUND_SECS) {
                this.sessionCumulativeSeconds++
                this.timeOnCurrentPageSecs++
            }
            
            // Periodic flush every 20 seconds
            // Bounded throttle: only if 20s elapsed since last flush AND no in-flight flush AND at least 5s since last failed attempt
            if (now - this.lastFlushTime >= 20 * 1000) {
                const canRetry = !this.lastFlushAttemptTime || (now - this.lastFlushAttemptTime >= 5 * 1000)
                if (!this._activeFlushPromise && canRetry) {
                    this.backupPendingSession()
                    this.flush().catch(() => {})
                }
            }

            if (typeof this.onTickCallback === 'function') {
                const uncommittedSlicesTotal = (this.sessionSlices || []).reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
                const totalSessionSeconds = (this.sessionCumulativeSeconds || 0) + uncommittedSlicesTotal + (this._committedHistoricalSeconds || 0)
                const todayStats = this.getTodayStats()
                this.onTickCallback({
                    seconds: totalSessionSeconds,
                    sessionSeconds: totalSessionSeconds,
                    todaySeconds: todayStats.seconds,
                    isIdle: this.isIdle
                })
            }
        }
    }

    // Called on page turn / navigation relocation event
    recordPageTurn() {
        const deltaSecs = this.timeOnCurrentPageSecs
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = this._now()

        // 1. Filter out rapid flipping / skimming (< 3s)
        if (deltaSecs < MIN_PAGE_TIME_SECS) {
            return false // Skimmed, not counted in pacing model
        }

        // 2. Filter out walk-away idle (> 300s)
        let validPace = deltaSecs
        if (deltaSecs > MAX_PAGE_FOREGROUND_SECS) {
            // Drop anomaly from speed model or clamp
            return false
        }

        // 3. Add to rolling window
        this.rollingPagePaces.push(validPace)
        if (this.rollingPagePaces.length > ROLLING_WINDOW_CAPACITY) {
            this.rollingPagePaces.shift()
        }

        // 4. Update user's baseline progressively
        if (this.rollingPagePaces.length >= 4) {
            const sum = this.rollingPagePaces.reduce((a, b) => a + b, 0)
            const currentRollingAvg = sum / this.rollingPagePaces.length
            const newBaseline = (0.85 * this.userBaselinePagePace) + (0.15 * currentRollingAvg)
            this.saveUserBaseline(newBaseline)
        }
        return true
    }

    // Calculate current smoothed reading pace (seconds per screen/page)
    getCurrentPaceSecs() {
        if (this.rollingPagePaces.length >= 3) {
            const sum = this.rollingPagePaces.reduce((a, b) => a + b, 0)
            const avgRolling = sum / this.rollingPagePaces.length
            return Math.min(150, Math.max(20, Math.round(0.75 * avgRolling + 0.25 * this.userBaselinePagePace)))
        }
        return this.userBaselinePagePace
    }

    getTodayStats() {
        if (!this.isTracking) return { seconds: 0 }
        const now = this._now()
        const todayStr = db.toLocalDateKey(now)
        const currentSliceDate = db.toLocalDateKey(this.sessionStartTime || now)
        const todayActiveSeconds = (currentSliceDate === todayStr) ? (this.sessionCumulativeSeconds || 0) : 0
        const todaySliceSeconds = (this.sessionSlices || [])
            .filter(s => s.date === todayStr)
            .reduce((sum, s) => sum + (s.durationSeconds || 0), 0)
        return {
            seconds: todayActiveSeconds + todaySliceSeconds
        }
    }

    async flush(isFinal = false, finalFraction = null, sessionSnapshot = null) {
        if (this._activeFlushPromise && !isFinal && !sessionSnapshot) {
            return this._activeFlushPromise
        }

        const now = this._now()
        this.lastFlushAttemptTime = now

        const targetSessionId = sessionSnapshot?.sessionId || this.currentSessionId
        const targetBookId = sessionSnapshot?.bookId || this.currentBookId
        const targetTitle = sessionSnapshot?.bookTitle || this.currentBookTitle
        const targetDuration = sessionSnapshot?.durationSeconds != null ? sessionSnapshot.durationSeconds : this.sessionCumulativeSeconds
        const targetStartTime = sessionSnapshot?.startTime || this.sessionStartTime || now
        const targetStartFrac = sessionSnapshot?.startFraction != null ? sessionSnapshot.startFraction : this.sessionStartFraction
        const targetSlices = sessionSnapshot?.slices || (this.sessionSlices ? [...this.sessionSlices] : [])
        const historicalCommitted = sessionSnapshot?._committedHistoricalSeconds != null ? sessionSnapshot._committedHistoricalSeconds : (this._committedHistoricalSeconds || 0)

        const totalSessionDuration = targetDuration + targetSlices.reduce((sum, s) => sum + (s.durationSeconds || 0), 0) + historicalCommitted

        // Rule 1 & 5: Discard sessions under 1 minute (< 60 seconds) from formal statistics
        if (!targetBookId || totalSessionDuration < 60) {
            // Schedule must advance so periodic tick does not repeat every second!
            this.lastFlushTime = now
            if (isFinal && targetSessionId) {
                this.clearPendingSessionBackup(targetSessionId, sessionSnapshot?.version)
            }
            return { status: 'filtered_short_session', durationSeconds: totalSessionDuration }
        }

        const sliceStartTime = targetStartTime
        const dateStr = db.toLocalDateKey(sliceStartTime)
        const sessionRecord = {
            id: targetSessionId || `sess_${now}_${Math.random().toString(36).slice(2, 7)}`,
            bookId: targetBookId,
            bookTitle: targetTitle,
            date: dateStr,
            startTime: sliceStartTime,
            endTime: now,
            durationSeconds: targetDuration,
            startProgress: targetStartFrac,
            endProgress: finalFraction != null ? finalFraction : targetStartFrac
        }

        const flushOp = (async () => {
            try {
                // Commit previous uncommitted slices if any (e.g. cross-midnight)
                if (targetSlices.length > 0) {
                    for (const slice of targetSlices) {
                        if (slice.durationSeconds > 0 && !slice.committed) {
                            await db.recordReadingSession(slice)
                            slice.committed = true
                        }
                    }
                }

                if (targetDuration > 0) {
                    await db.recordReadingSession(sessionRecord)
                }

                // Advance schedule on success and record committed version
                this.lastFlushTime = now
                this.lastCommittedTime = now
                this.lastCommittedVersion = sessionSnapshot?.version || this._backupVersion

                // Clean up / aggregate committed slices to prevent unbounded linear growth
                if (!sessionSnapshot && this.sessionSlices) {
                    const uncommitted = []
                    for (const s of this.sessionSlices) {
                        if (s.committed) {
                            this._committedHistoricalSeconds = (this._committedHistoricalSeconds || 0) + (s.durationSeconds || 0)
                        } else {
                            uncommitted.push(s)
                        }
                    }
                    this.sessionSlices = uncommitted
                }

                if (isFinal && targetSessionId) {
                    this.clearPendingSessionBackup(targetSessionId, sessionSnapshot?.version)
                }
                return { status: 'committed', durationSeconds: totalSessionDuration }
            } catch (err) {
                console.warn('Failed to record reading session:', err)
                // On failure: do NOT update lastFlushTime (remains at last success),
                // while lastFlushAttemptTime was recorded to throttle retries.
                throw err
            }
        })()

        this._activeFlushPromise = flushOp.finally(() => {
            if (this._activeFlushPromise === flushOp) {
                this._activeFlushPromise = null
            }
        })

        return this._activeFlushPromise
    }

    async endSession(finalFraction = null, targetBookId = null) {
        if (!this.isTracking) {
            if (targetBookId && this._lastSessionSnapshot && this._lastSessionSnapshot.bookId !== targetBookId) {
                return Promise.resolve({ status: 'not_applicable' })
            }
            return this._lastEndSessionPromise || Promise.resolve({ status: 'not_applicable' })
        }
        if (targetBookId && this.currentBookId && this.currentBookId !== targetBookId) {
            return Promise.resolve({ status: 'not_applicable' })
        }
        const token = this.sessionToken
        
        if (this.tickerInterval) {
            clearInterval(this.tickerInterval)
            this.tickerInterval = null
        }

        const nextVersion = (this._backupVersion = (this._backupVersion || 0) + 1)
        // Synchronously capture session parameters so concurrent transitions cannot corrupt them
        const sessionSnapshot = {
            sessionId: this.currentSessionId,
            bookId: this.currentBookId,
            bookTitle: this.currentBookTitle,
            durationSeconds: this.sessionCumulativeSeconds,
            startTime: this.sessionStartTime,
            startFraction: this.sessionStartFraction,
            slices: this.sessionSlices ? [...this.sessionSlices] : [],
            _committedHistoricalSeconds: this._committedHistoricalSeconds || 0,
            version: nextVersion
        }
        this._lastSessionSnapshot = sessionSnapshot
        
        // Only clear state if no newer session has started in the meantime
        if (this.sessionToken === token) {
            this.isTracking = false
            this.currentBookId = null
            this.currentBookTitle = null
            this.currentSessionId = null
            this.sessionCumulativeSeconds = 0
            this.sessionSlices = []
            this._committedHistoricalSeconds = 0
            this.timeOnCurrentPageSecs = 0
            this.rollingPagePaces = []
            this.onTickCallback = null
        }

        // Save pre-await backup with captured version
        this.backupPendingSession(finalFraction, sessionSnapshot)

        // Decouple internal queue serialization from caller's promise:
        // Internal tail absorbs previous rejection so subsequent sessions can run,
        // while caller receives opPromise which will reject if this session's flush fails.
        const prevTail = this._sessionQueueTail || Promise.resolve()
        const opPromise = prevTail.catch(() => {}).then(async () => {
            return await this.flush(true, finalFraction, sessionSnapshot)
        })

        this._sessionQueueTail = opPromise.catch(() => {})
        this._sessionQueue = opPromise
        this._lastEndSessionPromise = opPromise

        return opPromise
    }

    formatDuration(totalSecs) {
        if (!totalSecs || totalSecs <= 0) return '0分钟'
        if (totalSecs < 60) return '不足1分钟'
        const hours = Math.floor(totalSecs / 3600)
        const mins = Math.floor((totalSecs % 3600) / 60)
        if (hours > 0) {
            return `${hours}小时${mins > 0 ? ` ${mins}分钟` : ''}`
        }
        return `${mins}分钟`
    }
}

export const tracker = new ReadingTracker()
