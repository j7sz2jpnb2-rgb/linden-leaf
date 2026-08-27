// tracker.js - High-Precision Reading Time Tracker with Anti-Idle, Auto-Flush & Session Token Safety

import * as db from './db.js'

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
        this.idleThresholdMs = 120 * 1000 // 120 seconds of no interaction = idle

        this.tickerInterval = null
        this.onTickCallback = null
        this.sessionToken = 0 // Monotonic token to prevent session race conditions

        this.initGlobalListeners()
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
            localStorage.removeItem('linden_pending_session_backup')
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
                console.log(`[Tracker] Successfully recovered ${data.durationSeconds}s reading session from crash backup.`)
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
        // Check for idle
        if (now - this.lastActivityTime > this.idleThresholdMs) {
            this.isIdle = true
        }

        if (!this.isIdle && document.visibilityState === 'visible') {
            this.sessionCumulativeSeconds++
            
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
        }
    }

    formatDuration(totalSecs) {
        if (!totalSecs || totalSecs < 60) return '0分钟'
        const hours = Math.floor(totalSecs / 3600)
        const mins = Math.floor((totalSecs % 3600) / 60)
        if (hours > 0) {
            return `${hours}小时${mins > 0 ? ` ${mins}分钟` : ''}`
        }
        return `${mins}分钟`
    }
}

export const tracker = new ReadingTracker()
