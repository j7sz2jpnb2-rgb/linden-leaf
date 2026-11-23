// js/stats-heatmap.js - Clean Reading Statistics Bar Chart & Calendar Heatmap
// Features: trackless independent bars, honest 0-duration, non-ambiguous time labels,
// touch/focus accessible tooltips, and local-date aggregated reading heatmap.

import * as db from './db.js'
import { t, isEnglish, getLocale } from './i18n.js'
import { getReadingChartScale } from './stats-chart-scale.js'
import { getSessionDur, computeActiveSessionSeconds } from './reading-data.js'

const heatmapRenders = new WeakMap()

const EN_SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format minutes into clean, unambiguous duration string (e.g., 90m -> '1h 30m', not '2h')
 * @param {number} totalMinutes
 * @returns {string}
 */
export function formatMinutesClean(totalMinutes) {
    const mins = Math.max(0, Math.round(totalMinutes || 0))
    if (mins === 0) return t('time.minutes', { count: 0 })
    if (mins < 60) return t('time.minutes', { count: mins })
    const hours = Math.floor(mins / 60)
    const remMins = mins % 60
    if (remMins === 0) return t('time.hours', { hours })
    return t('time.hoursMinutes', { hours, mins: remMins })
}

/**
 * Format axis scale value (e.g. 90m -> '1.5h' or '90m')
 * @param {number} minutes
 * @returns {string}
 */
export function formatAxisLabel(minutes, unit = minutes >= 60 ? 'hours' : 'minutes') {
    if (unit === 'hours') return t('time.hours', { hours: Number((minutes / 60).toFixed(2)) })
    return t('time.minutes', { count: Math.round(minutes) })
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
    container.classList.toggle('is-compact-cols', Array.isArray(data) && data.length > 0 && data.length <= 12)

    if (!data || data.length === 0) {
        container.innerHTML = `<div class="stats-empty-notice">${t('statsHeatmap.empty')}</div>`
        return
    }

    const { maxMinutes: maxMins } = getReadingChartScale(data)

    data.forEach(item => {
        const col = document.createElement('div')
        col.className = 'chart-clean-col'
        col.setAttribute('tabindex', '0') // Keyboard accessible focus

        const value = Number(item.minutes)
        const mins = Number.isFinite(value) ? Math.max(0, value) : 0
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
                     aria-label="${t('statsHeatmap.barAria', { date: dateStr, duration: durationStr })}"></div>
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

    // Auto-scroll to current day only when horizontal scrolling is actually needed (>12 columns, e.g. Month view)
    container.scrollLeft = 0
    const currentDayCol = container.querySelector('.chart-clean-col .chart-clean-bar.today')?.closest('.chart-clean-col')
    if (data.length > 12 && currentDayCol && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            if (container.scrollWidth > container.clientWidth) {
                const targetScroll = currentDayCol.offsetLeft - (container.clientWidth / 2) + (currentDayCol.clientWidth / 2)
                container.scrollTo({ left: Math.max(0, targetScroll), behavior: 'smooth' })
            }
        })
    }
}

/**
 * Safely extract duration in seconds from any reading session record format.
 * Prioritizes explicit activeDurationSeconds (including zero), then durationSeconds,
 * with backward-compatible fallback to readingSeconds or seconds.
 * @param {object} session
 * @returns {number}
 */
export function getSessionDurationSeconds(session) {
    return getSessionDur(session)
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
    const daySessions = new Map()
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

        if (!daySessions.has(dateStr)) daySessions.set(dateStr, [])
        daySessions.get(dateStr).push(session)

        if (!dayMap.has(dateStr)) {
            dayMap.set(dateStr, { seconds: 0, minutes: 0, bookIds: new Set(), sessionCount: 0, bookDurationMap: new Map(), bookMetaMap: new Map() })
        }
        const item = dayMap.get(dateStr)
        if (!item.bookDurationMap) item.bookDurationMap = new Map()
        if (!item.bookMetaMap) item.bookMetaMap = new Map()
        item.sessionCount++
        if (session.bookId) {
            item.bookIds.add(session.bookId)
            item.bookDurationMap.set(session.bookId, 0)
            if (!item.bookMetaMap.has(session.bookId) || session.bookTitle) {
                const prev = item.bookMetaMap.get(session.bookId) || {}
                item.bookMetaMap.set(session.bookId, {
                    title: session.bookTitle || prev.title || '',
                    author: session.bookAuthor || prev.author || ''
                })
            }
        }
    }

    let maxMinutes = 0
    let peakDay = null
    let peakMinutes = 0
    let activeDaysCount = 0

    for (const [dateStr, item] of dayMap.entries()) {
        const rows = daySessions.get(dateStr)
        item.seconds = computeActiveSessionSeconds(rows)
        totalSeconds += item.seconds
        for (const id of item.bookIds) {
            item.bookDurationMap.set(id, computeActiveSessionSeconds(rows.filter(session => session.bookId === id)))
        }
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
    const { sessions } = await db.getReadingStatsSnapshot()
    return aggregateSessions(sessions, { targetYear })
}

function buildDayPayload(dateStr, info, bookTitleMap) {
    const mins = info?.minutes || 0
    const bookList = []
    if (info && info.bookDurationMap) {
        for (const [bId, bSecs] of info.bookDurationMap.entries()) {
            const meta = info.bookMetaMap?.get(bId)
            bookList.push({
                bookId: bId,
                title: bookTitleMap.get(bId) || meta?.title || t('statsHeatmap.readBookFallback'),
                author: meta?.author || '',
                seconds: bSecs,
                minutes: Math.round(bSecs / 60)
            })
        }
        bookList.sort((a, b) => b.seconds - a.seconds)
    }
    return {
        dateStr,
        minutes: mins,
        seconds: info?.seconds || 0,
        books: bookList,
        bookNames: bookList.map(b => b.title)
    }
}

/**
 * Render Calendar Heatmap for reading activity
 * @param {HTMLElement} container
 * @param {number} [targetYear]
 * @param {function(string, object): void} [onDayClick] Callback when clicking a day
 */
export async function renderCalendarHeatmap(container, targetYear = new Date().getFullYear(), onDayClick) {
    if (!container) return { getDayPayload: () => null }
    const render = heatmapRenders.get(container) || {}
    const token = {}
    render.token = token
    heatmapRenders.set(container, render)

    const { sessions, bookTitles } = await db.getReadingStatsSnapshot()
    if (render.token !== token) return
    const today = db.toLocalDateKey(new Date())
    const locale = getLocale()
    render.onDayClick = onDayClick
    if (render.bookTitles === bookTitles && render.year === targetYear && render.locale === locale && render.today === today) {
        return render.result
    }

    const { dayMap, maxMinutes, todayStr } = aggregateSessions(sessions, { targetYear })
    const bookTitleMap = bookTitles

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
        monthLabel.innerText = isEnglish() ? EN_SHORT_MONTHS[m] : `${m + 1}月`
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
                if (isCurrentYear && m === todayDate.getMonth() && d === todayDate.getDate()) {
                    cell.classList.add('today')
                }
                const info = dayMap.get(dateStr)
                const mins = info?.minutes || 0

                let level = 0
                if (mins > 0 && mins < 30) level = 1
                else if (mins >= 30 && mins < 60) level = 2
                else if (mins >= 60 && mins < 120) level = 3
                else if (mins >= 120) level = 4

                cell.classList.add(`level-${level}`)
                const durationStr = formatMinutesClean(mins)
                const bookNames = info ? Array.from(info.bookIds).map(id => {
                    const meta = info.bookMetaMap?.get(id)
                    return bookTitleMap.get(id) || meta?.title || t('statsHeatmap.readBookFallback')
                }).filter(Boolean).join(isEnglish() ? ', ' : '、') : ''
                const booksSuffix = bookNames ? t('statsHeatmap.booksSuffix', { books: bookNames }) : ''
                const tipText = mins > 0
                    ? t('statsHeatmap.dayTipRead', { date: dateStr, duration: durationStr, booksSuffix })
                    : t('statsHeatmap.dayTipUnread', { date: dateStr })
                cell.title = tipText

                const handleCellClick = () => {
                    const allActive = container.querySelectorAll('.heatmap-cell.active')
                    allActive.forEach(c => c.classList.remove('active'))
                    cell.classList.add('active')
                    render.onDayClick?.(dateStr, buildDayPayload(dateStr, info, bookTitleMap))
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
        <span class="legend-text">${t('statsHeatmap.legendLess')}</span>
        <span class="heatmap-cell level-0"></span>
        <span class="heatmap-cell level-1"></span>
        <span class="heatmap-cell level-2"></span>
        <span class="heatmap-cell level-3"></span>
        <span class="heatmap-cell level-4"></span>
        <span class="legend-text">${t('statsHeatmap.legendMore')}</span>
    `
    wrapper.appendChild(legend)
    container.appendChild(wrapper)

    const result = {
        getDayPayload: (dateStr) => buildDayPayload(dateStr, dayMap.get(dateStr), bookTitleMap)
    }
    Object.assign(render, { bookTitles, year: targetYear, locale, today, result })
    return result
}
