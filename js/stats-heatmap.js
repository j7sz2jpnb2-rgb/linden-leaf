// js/stats-heatmap.js - Clean Reading Statistics Bar Chart & Calendar Heatmap
// Features: trackless independent bars, honest 0-duration, non-ambiguous time labels,
// touch/focus accessible tooltips, and local-date aggregated reading heatmap.

import * as db from './db.js'

/**
 * Format minutes into clean, unambiguous duration string (e.g., 90m -> '1h 30m', not '2h')
 * @param {number} totalMinutes
 * @returns {string}
 */
export function formatMinutesClean(totalMinutes) {
    const mins = Math.max(0, Math.round(totalMinutes || 0))
    if (mins === 0) return '0 分钟'
    if (mins < 60) return `${mins} 分钟`
    const hours = Math.floor(mins / 60)
    const remMins = mins % 60
    if (remMins === 0) return `${hours} 小时`
    return `${hours} 小时 ${remMins} 分钟`
}

/**
 * Format axis scale value (e.g. 90m -> '1.5h' or '90m')
 * @param {number} minutes
 * @returns {string}
 */
export function formatAxisLabel(minutes) {
    if (minutes <= 0) return '0m'
    if (minutes < 60) return `${minutes}m`
    const hours = minutes / 60
    if (Number.isInteger(hours)) return `${hours}h`
    return `${hours.toFixed(1)}h`
}

/**
 * Render clean, trackless bar chart
 * @param {HTMLElement} container
 * @param {Array<{ label: string, minutes: number, fullDate?: string, isCurrent?: boolean }>} data
 * @param {object} [options]
 */
export function renderCleanBarChart(container, data, options = {}) {
    if (!container) return
    container.innerHTML = ''

    if (!data || data.length === 0) {
        container.innerHTML = '<div class="stats-empty-notice">暂无统计数据</div>'
        return
    }

    // Determine max minutes with a 15% headroom so bars do not clip to the top
    const rawMax = Math.max(...data.map(d => d.minutes || 0), 10)
    const maxMins = Math.ceil(rawMax * 1.15)

    data.forEach(item => {
        const col = document.createElement('div')
        col.className = 'chart-clean-col'
        col.setAttribute('tabindex', '0') // Keyboard accessible focus

        const mins = item.minutes || 0
        const isZero = mins === 0
        // Calculate true linear height proportion. No fake 8% floor!
        // If mins > 0 but tiny, give a 3px visible baseline notch so user sees activity.
        const heightPct = isZero ? 0 : Math.max(3, Math.round((mins / maxMins) * 100))

        const durationStr = formatMinutesClean(mins)
        const dateStr = item.fullDate || item.label

        col.innerHTML = `
            <div class="chart-tooltip" role="tooltip">${dateStr}: ${durationStr}</div>
            <div class="chart-bar-area">
                <div class="chart-clean-bar ${item.isCurrent ? 'today' : ''} ${isZero ? 'zero' : ''}"
                     style="height: ${heightPct}%;"
                     aria-label="${dateStr} 阅读 ${durationStr}"></div>
            </div>
            <div class="chart-day-label ${item.isCurrent ? 'today' : ''}">${item.label}</div>
        `

        // Click / touch to toggle tooltip on mobile
        col.addEventListener('click', (e) => {
            const allActive = container.querySelectorAll('.chart-clean-col.active')
            allActive.forEach(el => { if (el !== col) el.classList.remove('active') })
            col.classList.toggle('active')
            e.stopPropagation()
        })

        container.appendChild(col)
    })
}

/**
 * Safely extract duration in seconds from any reading session record format.
 * Prioritizes durationSeconds (standard Linden tracker & db format),
 * with backward-compatible fallback to readingSeconds or seconds.
 * @param {object} session
 * @returns {number}
 */
export function getSessionDurationSeconds(session) {
    if (!session) return 0
    const val = session.durationSeconds != null ? session.durationSeconds
        : session.readingSeconds != null ? session.readingSeconds
        : session.seconds != null ? session.seconds : 0
    return typeof val === 'number' && !isNaN(val) && val > 0 ? val : 0
}

/**
 * Safely extract local calendar date string 'YYYY-MM-DD' from session
 * @param {object} session
 * @returns {string}
 */
export function getSessionDateKey(session) {
    if (session?.date && typeof session.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
        return session.date
    }
    const ts = session?.startTime || session?.timestamp || session?.endTime || 0
    if (ts) {
        if (typeof db.toLocalDateKey === 'function') {
            return db.toLocalDateKey(ts)
        }
        const d = new Date(ts)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    return ''
}

/**
 * Aggregate sessions into unified calendar day metrics.
 * Supports cross-midnight slices without double-filtering 60s per slice.
 * An active reading day is defined by daily aggregated total >= 60 seconds (consistent with db.js and tracker).
 * @param {Array<object>} sessions
 * @param {object} [options]
 * @param {string} [options.bookId] Filter by book ID
 * @param {number} [options.targetYear] Filter by target year for color scaling
 * @returns {{
 *   dayMap: Map<string, { seconds: number, minutes: number, bookIds: Set<string>, sessionCount: number }>,
 *   maxMinutes: number,
 *   totalSeconds: number,
 *   activeDaysCount: number,
 *   peakDay: string | null,
 *   peakMinutes: number,
 *   todayStr: string
 * }}
 */
export function aggregateSessions(sessions = [], options = {}) {
    const { bookId = null, targetYear = null } = options
    const dayMap = new Map() // 'YYYY-MM-DD' -> { seconds, minutes, bookIds, sessionCount }
    let totalSeconds = 0

    const now = new Date()
    const todayStr = typeof db.toLocalDateKey === 'function'
        ? db.toLocalDateKey(now)
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    for (const session of sessions) {
        if (!session) continue
        if (bookId && session.bookId !== bookId) continue

        const secs = getSessionDurationSeconds(session)
        if (secs <= 0) continue

        const dateStr = getSessionDateKey(session)
        if (!dateStr) continue

        // If target year is specified, only include dates in target year to avoid
        // older active years distorting the current year's heatmap color scale
        if (targetYear != null) {
            const yearOfDate = parseInt(dateStr.slice(0, 4), 10)
            if (yearOfDate !== targetYear) continue
        }

        totalSeconds += secs

        if (!dayMap.has(dateStr)) {
            dayMap.set(dateStr, { seconds: 0, minutes: 0, bookIds: new Set(), sessionCount: 0, bookDurationMap: new Map() })
        }
        const item = dayMap.get(dateStr)
        if (!item.bookDurationMap) item.bookDurationMap = new Map()
        item.seconds += secs
        item.sessionCount++
        if (session.bookId) {
            item.bookIds.add(session.bookId)
            item.bookDurationMap.set(session.bookId, (item.bookDurationMap.get(session.bookId) || 0) + secs)
        }
    }

    let maxMinutes = 0
    let peakDay = null
    let peakMinutes = 0
    let activeDaysCount = 0

    for (const [dateStr, item] of dayMap.entries()) {
        item.minutes = Math.round(item.seconds / 60)
        // Natural reading day: daily aggregated duration >= 60 seconds
        if (item.seconds >= 60) {
            activeDaysCount++
        }
        if (item.minutes > maxMinutes) {
            maxMinutes = item.minutes
        }
        if (item.minutes > peakMinutes) {
            peakMinutes = item.minutes
            peakDay = dateStr
        }
    }

    return {
        dayMap,
        maxMinutes,
        totalSeconds,
        activeDaysCount,
        peakDay,
        peakMinutes,
        todayStr
    }
}

/**
 * Fetch and aggregate sessions into local calendar day metrics
 * @param {number} [targetYear] Target year (defaults to current year)
 * @returns {Promise<{ dayMap: Map<string, { seconds: number, minutes: number, bookIds: Set<string> }>, maxMinutes: number, todayStr: string, activeDaysCount: number }>}
 */
export async function aggregateLocalHeatmapData(targetYear = new Date().getFullYear()) {
    const sessions = (await db.getAllReadingSessions?.()) || []
    return aggregateSessions(sessions, { targetYear })
}

/**
 * Render Calendar Heatmap for reading activity
 * @param {HTMLElement} container
 * @param {number} [targetYear]
 * @param {function(string, object): void} [onDayClick] Callback when clicking a day
 */
export async function renderCalendarHeatmap(container, targetYear = new Date().getFullYear(), onDayClick) {
    if (!container) return
    container.innerHTML = '<div class="heatmap-loading">正在统计每日阅读热力...</div>'

    const { dayMap, maxMinutes, todayStr } = await aggregateLocalHeatmapData(targetYear)
    const books = await db.getAllBooks()
    const bookTitleMap = new Map(books.map(b => [b.id, b.title]))

    const isCurrentYear = targetYear === new Date().getFullYear()
    const todayDate = new Date()

    container.innerHTML = ''
    const wrapper = document.createElement('div')
    wrapper.className = 'heatmap-wrapper'

    // Months container (12 months or rolling view)
    const grid = document.createElement('div')
    grid.className = 'heatmap-grid'

    for (let m = 0; m < 12; m++) {
        const monthBox = document.createElement('div')
        monthBox.className = 'heatmap-month'

        const monthLabel = document.createElement('div')
        monthLabel.className = 'heatmap-month-label'
        monthLabel.innerText = `${m + 1}月`
        monthBox.appendChild(monthLabel)

        const daysGrid = document.createElement('div')
        daysGrid.className = 'heatmap-days-grid'

        const daysInMonth = new Date(targetYear, m + 1, 0).getDate()
        const firstDayOfWeek = new Date(targetYear, m, 1).getDay() // 0 = Sun
        // Normalize Monday as first column (0 = Mon, 6 = Sun)
        const leadPad = (firstDayOfWeek + 6) % 7
        for (let p = 0; p < leadPad; p++) {
            const emptyCell = document.createElement('div')
            emptyCell.className = 'heatmap-cell empty'
            daysGrid.appendChild(emptyCell)
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${targetYear}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            const currentYear = todayDate.getFullYear()
            const isFuture = targetYear > currentYear || (isCurrentYear && new Date(targetYear, m, d) > todayDate)
            const cell = document.createElement('div')
            cell.className = 'heatmap-cell'
            cell.dataset.date = dateStr

            if (isFuture) {
                cell.classList.add('future')
            } else {
                const info = dayMap.get(dateStr)
                const mins = info?.minutes || 0

                let level = 0
                if (mins > 0 && mins < 30) level = 1
                else if (mins >= 30 && mins < 60) level = 2
                else if (mins >= 60 && mins < 120) level = 3
                else if (mins >= 120) level = 4

                cell.classList.add(`level-${level}`)
                const durationStr = formatMinutesClean(mins)
                const bookNames = info ? Array.from(info.bookIds).map(id => bookTitleMap.get(id) || '未知书籍').join('、') : ''
                const tipText = mins > 0 ? `${dateStr}: ${durationStr}${bookNames ? `\n阅读: ${bookNames}` : ''}` : `${dateStr}: 未阅读`
                cell.title = tipText

                const handleCellClick = () => {
                    const allActive = container.querySelectorAll('.heatmap-cell.active')
                    allActive.forEach(c => c.classList.remove('active'))
                    cell.classList.add('active')
                    if (onDayClick) {
                        const bookList = []
                        if (info && info.bookDurationMap) {
                            for (const [bId, bSecs] of info.bookDurationMap.entries()) {
                                bookList.push({
                                    bookId: bId,
                                    title: bookTitleMap.get(bId) || '未知书籍',
                                    seconds: bSecs,
                                    minutes: Math.round(bSecs / 60)
                                })
                            }
                            bookList.sort((a, b) => b.seconds - a.seconds)
                        }
                        const payload = {
                            dateStr,
                            minutes: mins,
                            seconds: info?.seconds || 0,
                            books: bookList,
                            bookNames: bookList.map(b => b.title)
                        }
                        onDayClick(dateStr, payload)
                    }
                }

                cell.tabIndex = 0
                cell.setAttribute('role', 'button')
                cell.setAttribute('aria-label', tipText)
                cell.addEventListener('click', handleCellClick)
                cell.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleCellClick()
                    }
                })
            }

            daysGrid.appendChild(cell)
        }

        monthBox.appendChild(daysGrid)
        grid.appendChild(monthBox)
    }

    wrapper.appendChild(grid)

    // Add clean Legend at bottom
    const legend = document.createElement('div')
    legend.className = 'heatmap-legend'
    legend.innerHTML = `
        <span class="legend-text">少</span>
        <span class="heatmap-cell level-0"></span>
        <span class="heatmap-cell level-1"></span>
        <span class="heatmap-cell level-2"></span>
        <span class="heatmap-cell level-3"></span>
        <span class="heatmap-cell level-4"></span>
        <span class="legend-text">多 (2h+)</span>
    `
    wrapper.appendChild(legend)
    container.appendChild(wrapper)
}
