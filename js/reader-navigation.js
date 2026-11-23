

export class ReaderLocationHistory {
    constructor(app) {
        this.app = app
        this.undoStack = []
        this.redoStack = []
        this.currentLocation = null
        this.isNavigating = false
        this._navigationGeneration = 0
    }

    reset() {
        this._navigationGeneration++
        clearTimeout(this._settleTimer)
        this.undoStack = []
        this.redoStack = []
        this.currentLocation = null
        this.isNavigating = false
        this.updateUI()
    }

    getCurrentLocation() {
        const fmt = this.app?.currentBookFormat || this.app?.currentBookData?.format || this.app?.currentFormat
        if (fmt === 'pdf') {
            const page = (this.app?.pdfViewport?.currentPage ?? 0) + 1
            return { type: 'pdf', page }
        } else if (fmt === 'epub' || this.app.foliateView) {
            const cfi = this.app.currentCfi || this.app.currentLocation?.cfi || null
            return { type: fmt || 'epub', cfi }
        } else {
            const charOffset = this.app?.currentLocation?.charOffset || 0
            return { type: fmt || 'txt', charOffset }
        }
    }

    isEqual(locA, locB) {
        if (!locA || !locB || locA.type !== locB.type) return false
        if (locA.type === 'pdf') return locA.page === locB.page
        if (locA.cfi != null || locB.cfi != null) return locA.cfi === locB.cfi
        return locA.charOffset === locB.charOffset
    }

    pushLocation(loc = null) {
        if (this.isNavigating) return
        // UI callers record the departure immediately before jumping elsewhere.
        if (loc == null) {
            const origin = this.getCurrentLocation()
            if (!origin) return
            if (!this.isEqual(this.undoStack.at(-1), origin)) this.undoStack.push(origin)
            if (this.undoStack.length > 50) this.undoStack.shift()
            this.currentLocation = null
            this.redoStack = []
            this.updateUI()
            return
        }
        const newLoc = loc || this.getCurrentLocation()
        if (!newLoc) return
        if (this.currentLocation && this.isEqual(this.currentLocation, newLoc)) return
        if (this.currentLocation) {
            this.undoStack.push(this.currentLocation)
            if (this.undoStack.length > 50) this.undoStack.shift()
        }
        this.currentLocation = newLoc
        this.redoStack = []
        this.updateUI()
    }

    canGoBack() {
        return this.undoStack.length > 0
    }

    canGoForward() {
        return this.redoStack.length > 0
    }

    async back() {
        if (!this.canGoBack()) return false
        const target = this.undoStack.pop()
        const departure = this.currentLocation || this.getCurrentLocation()
        if (departure) this.redoStack.push(departure)
        this.currentLocation = target
        this.updateUI()
        await this._goToLocation(target)
        return true
    }

    async forward() {
        if (!this.canGoForward()) return false
        const target = this.redoStack.pop()
        if (this.currentLocation) this.undoStack.push(this.currentLocation)
        this.currentLocation = target
        this.updateUI()
        await this._goToLocation(target)
        return true
    }

    async _goToLocation(loc) {
        if (!loc) return
        const generation = ++this._navigationGeneration
        this.isNavigating = true
        try {
            await this.app?.navigateReaderToLocation?.(loc)
        } catch (e) {
            console.warn('[LocationHistory] Navigation error:', e)
        } finally {
            if (generation === this._navigationGeneration) {
                clearTimeout(this._settleTimer)
                this._settleTimer = setTimeout(() => {
                    if (generation === this._navigationGeneration) this.isNavigating = false
                }, 250)
            }
        }
    }

    updateUI() {
        if (typeof document === 'undefined') return
        const btnBack = document.getElementById('btn-nav-history-back')
        const btnForward = document.getElementById('btn-nav-history-forward')
        if (btnBack) btnBack.disabled = !this.canGoBack()
        if (btnForward) btnForward.disabled = !this.canGoForward()
    }
}

export function normalizeNavigationTarget(target) {
    if (target == null) return null
    if (typeof target === 'number') {
        const pageIndex = Math.max(0, Math.floor(target))
        return {
            type: 'pdf',
            page: pageIndex + 1,
            pageIndex: pageIndex,
            yRatio: 0
        }
    }
    if (typeof target === 'string') {
        if (/^\d+$/.test(target.trim())) {
            const pageNum = Math.max(1, parseInt(target.trim(), 10))
            return {
                type: 'pdf',
                page: pageNum,
                pageIndex: pageNum - 1,
                yRatio: 0
            }
        }
        return {
            type: 'epub',
            cfi: target
        }
    }
    if (typeof target === 'object') {
        const res = { ...target }
        if (res.cfi) {
            res.type = 'epub'
            return res
        }
        if (res.charOffset !== undefined) {
            res.type = res.type || 'txt'
            return res
        }
        if (res.page !== undefined || res.pageIndex !== undefined) {
            res.type = 'pdf'
            if (res.page !== undefined && res.pageIndex === undefined) {
                res.page = Math.max(1, Math.floor(res.page))
                res.pageIndex = res.page - 1
            } else if (res.pageIndex !== undefined && res.page === undefined) {
                res.pageIndex = Math.max(0, Math.floor(res.pageIndex))
                res.page = res.pageIndex + 1
            } else if (res.page !== undefined && res.pageIndex !== undefined) {
                res.page = Math.max(1, Math.floor(res.page))
                res.pageIndex = Math.max(0, Math.floor(res.pageIndex))
            }
            if (res.yRatio !== undefined && typeof res.yRatio === 'number') {
                res.yRatio = Math.max(0, Math.min(1, res.yRatio))
            } else {
                res.yRatio = 0
            }
            return res
        }
        return res
    }
    return null
}

export function decodePdfProgress(savedProgress, totalPages) {
    if (!totalPages || totalPages <= 0) return { page: 1, fraction: 0 }
    if (typeof savedProgress?.page === 'number' && savedProgress.page >= 1) {
        const page = Math.min(totalPages, Math.max(1, Math.round(savedProgress.page)))
        return { page, fraction: page / totalPages }
    }
    if (typeof savedProgress?.fraction === 'number' && savedProgress.fraction > 0) {
        const f = Math.min(1, Math.max(0, savedProgress.fraction))
        const page = Math.min(totalPages, Math.max(1, Math.ceil(f * totalPages - 1e-5)))
        return { page, fraction: f }
    }
    return { page: 1, fraction: 0 }
}
