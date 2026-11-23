// Reading-data algorithms shared by persistence, sync, and backup.

export const normalizeTimestampMs = (t) => {
    if (!t) return 0
    if (typeof t === 'number') return isNaN(t) ? 0 : t
    if (t instanceof Date) return t.getTime()
    const ms = new Date(t).getTime()
    return isNaN(ms) ? 0 : ms
}

export const mergeSessionIntervals = (ivListA = [], ivListB = []) => {
    const combined = []
    const add = (list) => {
        if (!Array.isArray(list)) return
        for (const iv of list) {
            let s = 0, e = 0
            if (Array.isArray(iv) && iv.length >= 2) {
                s = normalizeTimestampMs(iv[0])
                e = normalizeTimestampMs(iv[1])
            } else if (iv && typeof iv === 'object') {
                s = normalizeTimestampMs(iv.start ?? iv.startMs)
                e = normalizeTimestampMs(iv.end ?? iv.endMs)
            }
            if (e > s) combined.push([s, e])
        }
    }
    add(ivListA)
    add(ivListB)
    if (combined.length === 0) return []
    combined.sort((a, b) => a[0] - b[0])
    const merged = [combined[0]]
    for (let i = 1; i < combined.length; i++) {
        const last = merged[merged.length - 1]
        const curr = combined[i]
        if (curr[0] <= last[1]) {
            last[1] = Math.max(last[1], curr[1])
        } else {
            merged.push(curr)
        }
    }
    return merged
}

export const calculateIntervalUnionSeconds = (intervals = []) => {
    if (!Array.isArray(intervals) || intervals.length === 0) return 0
    let totalMs = 0
    for (const iv of intervals) {
        if (Array.isArray(iv) && iv.length >= 2) {
            totalMs += Math.max(0, iv[1] - iv[0])
        } else if (iv && typeof iv === 'object') {
            const s = Number(iv.start ?? iv.startMs ?? 0)
            const e = Number(iv.end ?? iv.endMs ?? 0)
            totalMs += Math.max(0, e - s)
        }
    }
    return Math.round(totalMs / 1000)
}

export const buildPdfDrawingKey = (bookId, pageIndex, versionMeta = {}) => {
    if (!bookId || pageIndex == null) return null
    const blobRevision = versionMeta?.blobRevision || null
    const revisionOrigin = versionMeta?.revisionOrigin || null
    if (blobRevision) {
        return revisionOrigin
            ? `${bookId}_orig_${revisionOrigin}_rev_${blobRevision}_page_${pageIndex}`
            : `${bookId}_rev_${blobRevision}_page_${pageIndex}`
    }
    return `${bookId}_page_${pageIndex}`
}

export const remapPdfDrawingId = (drawing, targetBookId) => {
    if (!drawing || !targetBookId) return drawing?.id || null
    let pageIndex = drawing.pageIndex
    let blobRevision = drawing.blobRevision || null
    let revisionOrigin = drawing.revisionOrigin || null

    if (drawing.id && typeof drawing.id === 'string') {
        if (!blobRevision) {
            const revMatch = drawing.id.match(/_rev_(.+?)_page_(\d+)$/)
            if (revMatch) {
                blobRevision = revMatch[1]
                if (pageIndex == null) pageIndex = parseInt(revMatch[2], 10)
            }
        }
        if (!revisionOrigin) {
            const origMatch = drawing.id.match(/_orig_(.+?)_rev_/)
            if (origMatch) revisionOrigin = origMatch[1]
        }
        if (pageIndex == null) {
            const pageMatch = drawing.id.match(/_(?:page|drawing)_(\d+)$/)
            if (pageMatch) pageIndex = parseInt(pageMatch[1], 10)
        }
    }

    // Preserve and backfill structured identity fields
    if (pageIndex != null) drawing.pageIndex = pageIndex
    if (blobRevision) drawing.blobRevision = blobRevision
    if (revisionOrigin) drawing.revisionOrigin = revisionOrigin

    return buildPdfDrawingKey(targetBookId, pageIndex != null ? pageIndex : 0, { blobRevision, revisionOrigin })
}


export const getSessionDur = s => {
    if (!s) return 0
    const v = s.activeDurationSeconds != null ? s.activeDurationSeconds
        : s.durationSeconds != null ? s.durationSeconds
        : s.readingSeconds != null ? s.readingSeconds
        : s.seconds != null ? s.seconds : 0
    return typeof v === 'number' && !isNaN(v) && v > 0 ? Math.round(v) : 0
}

export const computeActiveSessionSeconds = (sessList) => {
    if (!sessList) return 0
    const rawIntervals = []
    let unintervaledSeconds = 0
    for (const s of sessList) {
        const dur = getSessionDur(s)
        if (dur <= 0) continue
        // Only construct intervals if activeIntervals was explicitly recorded (LL-28)
        if (Array.isArray(s.activeIntervals) && s.activeIntervals.length > 0) {
            const before = rawIntervals.length
            for (const iv of s.activeIntervals) {
                if (Array.isArray(iv) && iv.length >= 2) {
                    const st = normalizeTimestampMs(iv[0])
                    const et = normalizeTimestampMs(iv[1])
                    if (et > st) {
                        rawIntervals.push([st, et])
                    }
                }
            }
            if (rawIntervals.length === before) unintervaledSeconds += dur
        } else {
            unintervaledSeconds += dur
        }
    }
    if (rawIntervals.length === 0) return unintervaledSeconds
    rawIntervals.sort((a, b) => a[0] - b[0])
    let unionSecs = 0
    let cur = [rawIntervals[0][0], rawIntervals[0][1]]
    for (let i = 1; i < rawIntervals.length; i++) {
        const next = rawIntervals[i]
        if (next[0] <= cur[1]) {
            cur[1] = Math.max(cur[1], next[1])
        } else {
            unionSecs += (cur[1] - cur[0]) / 1000
            cur = [next[0], next[1]]
        }
    }
    unionSecs += (cur[1] - cur[0]) / 1000
    return Math.round(unionSecs) + unintervaledSeconds
}

