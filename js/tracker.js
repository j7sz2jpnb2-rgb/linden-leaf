// tracker.js - High-Precision Reading Time Tracker with Dual-State Time Window & Adaptive Pacing

import * as db from './db.js'

// Reading Time Window & Pacing constants (Classic statistical trimming)
export const MIN_PAGE_TIME_SECS = 3         // < 3s = fast skimming/jumping, discard from pace model
export const MAX_PAGE_FOREGROUND_SECS = 300 // > 300s = idle/walk away without interaction, excess is clamped
export const MAX_PAGE_BACKGROUND_SECS = 0   // Backgrounded or blurred = timer pauses immediately
export const ROLLING_WINDOW_CAPACITY = 12   // Maintain rolling window of last 12 valid page durations

export class ReadingTracker {
    constructor() {
        this.currentBookId = null
        this.currentBookTitle = null
        this.currentSessionId = null
        this.sessionStartTime = null
        this.sessionStartFraction = 0
        this.sessionCumulativeSeconds = 0
        this.lastFlushTime = 0
        this.lastActivityTime = Date.now()
        
        this.isTracking = false
        this.isIdle = false
        this.idleThresholdMs = 180 * 1000 // 180 seconds of no interaction = idle

        this.tickerInterval = null
        this.onTickCallback = null
        this.sessionToken = 0 // Monotonic token to prevent session race conditions

        // Adaptive Pacing & Time Window State
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = Date.now()
        this.rollingPagePaces = [] // stores last valid page durations (seconds)
        this.userBaselinePagePace = 65 // default ~65s/page (~400 Chinese chars/min)
        this.loadUserBaseline()

        this.initGlobalListeners()
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

        // Recover any pending session from previous abrupt close
        this.recoverPendingBackup()
    }

    backupPendingSession() {
        if (!this.isTracking || !this.currentBookId || this.sessionCumulativeSeconds <= 0) return
        try {
            const backupData = {
                sessionId: this.currentSessionId,
                bookId: this.currentBookId,
                bookTitle: this.currentBookTitle,
                durationSeconds: this.sessionCumulativeSeconds,
                startTime: this.sessionStartTime || Date.now(),
                timestamp: Date.now()
            }
            localStorage.setItem('linden_pending_session_backup', JSON.stringify(backupData))
        } catch (e) {}
    }

    async recoverPendingBackup() {
        try {
            const raw = localStorage.getItem('linden_pending_session_backup')
            if (!raw) return
            const data = JSON.parse(raw)
            if (data && data.bookId && data.durationSeconds > 0) {
                const dateStr = db.toLocalDateKey(data.startTime || Date.now())
                const recoveredRecord = {
                    id: data.sessionId || `sess_rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    bookId: data.bookId,
                    bookTitle: data.bookTitle || '已恢复会话',
                    date: dateStr,
                    startTime: data.startTime || Date.now(),
                    endTime: data.timestamp || Date.now(),
                    durationSeconds: data.durationSeconds,
                    startProgress: 0,
                    endProgress: 0
                }
                await db.recordReadingSession(recoveredRecord)
                localStorage.removeItem('linden_pending_session_backup')
                console.log(`[Tracker] Successfully recovered ${data.durationSeconds}s reading session from crash backup.`)
            } else {
                localStorage.removeItem('linden_pending_session_backup')
            }
        } catch (e) {
            console.warn('[Tracker] Failed to recover backup session:', e)
        }
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
        // Safely end existing session if any before starting new
        if (this.isTracking) {
            await this.endSession(startFraction)
        }

        this.sessionToken++
        const currentToken = this.sessionToken

        this.currentBookId = bookId
        this.currentBookTitle = bookTitle
        this.currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        this.sessionStartTime = Date.now()
        this.sessionStartFraction = startFraction
        this.sessionCumulativeSeconds = 0
        this.lastFlushTime = Date.now()
        this.lastActivityTime = Date.now()
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = Date.now()
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

        const now = Date.now()
        // Check for overall session idle (> 120s without interaction)
        if (now - this.lastActivityTime > this.idleThresholdMs) {
            this.isIdle = true
        }

        if (!this.isIdle && document.visibilityState === 'visible') {
            // Midnight rollover check: if calendar date crossed during active reading,
            // gracefully commit yesterday's slice and start a new slice for today.
            const todayStr = db.toLocalDateKey(now)
            const sessionDateStr = db.toLocalDateKey(this.sessionStartTime || now)
            if (todayStr !== sessionDateStr && this.sessionCumulativeSeconds > 0) {
                const prevFinalRecord = {
                    id: this.currentSessionId,
                    bookId: this.currentBookId,
                    bookTitle: this.currentBookTitle,
                    date: sessionDateStr,
                    startTime: this.sessionStartTime || now,
                    endTime: now - 1,
                    durationSeconds: this.sessionCumulativeSeconds,
                    startProgress: this.sessionStartFraction,
                    endProgress: this.sessionStartFraction
                }
                if (this.sessionCumulativeSeconds >= 60) {
                    db.recordReadingSession(prevFinalRecord).catch(err => console.warn('[Tracker] Midnight flush error:', err))
                }
                this.currentSessionId = `sess_${now}_${Math.random().toString(36).slice(2, 7)}`
                this.sessionStartTime = now
                this.sessionCumulativeSeconds = 0
                this.lastFlushTime = now
            }

            // Check Foreground Single Page Clamping (> 130s)
            if (this.timeOnCurrentPageSecs < MAX_PAGE_FOREGROUND_SECS) {
                this.sessionCumulativeSeconds++
                this.timeOnCurrentPageSecs++
            }
            
            // Periodic flush every 20 seconds
            if (now - this.lastFlushTime >= 20 * 1000) {
                this.backupPendingSession()
                this.flush().catch(() => {})
            }

            if (typeof this.onTickCallback === 'function') {
                this.onTickCallback({
                    seconds: this.sessionCumulativeSeconds,
                    isIdle: this.isIdle
                })
            }
        }
    }

    // Called on page turn / navigation relocation event
    recordPageTurn() {
        const deltaSecs = this.timeOnCurrentPageSecs
        this.timeOnCurrentPageSecs = 0
        this.pageStartTime = Date.now()

        // 1. Filter out rapid flipping / skimming (< 3s)
        if (deltaSecs < MIN_PAGE_TIME_SECS) {
            return false // Skimmed, not counted in pacing model
        }

        // 2. Filter out walk-away idle (> 130s)
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

    async flush(isFinal = false, finalFraction = null) {
        // Discard sessions under 1 minute (< 60 seconds)
        if (!this.isTracking || !this.currentBookId || this.sessionCumulativeSeconds < 60) return

        const currentToken = this.sessionToken
        const now = Date.now()
        this.lastFlushTime = now

        const sliceStartTime = this.sessionStartTime || now
        const dateStr = db.toLocalDateKey(sliceStartTime)
        const sessionRecord = {
            id: this.currentSessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            bookId: this.currentBookId,
            bookTitle: this.currentBookTitle,
            date: dateStr,
            startTime: sliceStartTime,
            endTime: now,
            durationSeconds: this.sessionCumulativeSeconds,
            startProgress: this.sessionStartFraction,
            endProgress: finalFraction != null ? finalFraction : this.sessionStartFraction
        }

        try {
            await db.recordReadingSession(sessionRecord)
            if (isFinal) {
                try { localStorage.removeItem('linden_pending_session_backup') } catch (e) {}
            }
        } catch (err) {
            console.warn('Failed to record reading session:', err)
        }
    }

    async endSession(finalFraction = null) {
        if (!this.isTracking) return
        const token = this.sessionToken
        
        if (this.tickerInterval) {
            clearInterval(this.tickerInterval)
            this.tickerInterval = null
        }
        
        await this.flush(true, finalFraction)
        try {
            localStorage.removeItem('linden_pending_session_backup')
        } catch (e) {}
        
        // Only clear state if no newer session has started in the meantime
        if (this.sessionToken === token) {
            this.isTracking = false
            this.currentBookId = null
            this.currentBookTitle = null
            this.currentSessionId = null
            this.sessionCumulativeSeconds = 0
            this.timeOnCurrentPageSecs = 0
            this.rollingPagePaces = []
        }
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
