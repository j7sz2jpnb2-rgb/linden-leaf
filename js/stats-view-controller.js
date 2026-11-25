import { DomEvents } from './dom-events.js'
import { getLocale, isEnglish, t } from './i18n.js'
import * as db from './db.js'
import { tracker } from './tracker.js'
import { resolveReadingState } from './tags-manager.js'
import { resolveBookTitle } from './book-title.js'
import { coverUrlPool } from './cover-url-pool.js'
import { uiSymbol, escapeHTML, renderEditorialCoverHTML, mapHighlightDisplayColor } from './ui-format.js'
import { getReadingChartScale } from './stats-chart-scale.js'
import { formatMinutesClean, formatAxisLabel, renderCleanBarChart, renderCalendarHeatmap } from './app-modules.js'

/** Owns stats UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class StatsViewController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this.statsViewMode = 'month'
        this.statsYear = new Date().getFullYear()
        this.statsMonth = new Date().getMonth() + 1
        this.statsWeekOffset = 0
        this._activeHeatmapDay = null
        this._activeDetailModalType = null
        this._statsReqId = 0
    }

    initDOM() {
        this.dom = {
            statsDashboardContainer: document.getElementById('stats-dashboard-container'),
            statsSegmentedTabs: document.querySelectorAll('.stats-tab-btn'),
            statsDateNavigator: document.getElementById('stats-date-navigator'),
            statsDateLabel: document.getElementById('stats-date-label'),
            btnStatsPrevDate: document.getElementById('btn-stats-prev-date'),
            btnStatsNextDate: document.getElementById('btn-stats-next-date'),
            statsHeroTime: document.getElementById('stats-hero-time'),
            statsHeroSub: document.getElementById('stats-hero-sub'),
            quadReadBooks: document.getElementById('quad-read-books'),
            quadFinishedBooks: document.getElementById('quad-finished-books'),
            quadReadDays: document.getElementById('quad-read-days'),
            quadNoteCount: document.getElementById('quad-note-count'),
            quadReadBooksUnit: document.querySelector('#card-quad-read-books .stats-quad-unit'),
            quadFinishedBooksUnit: document.querySelector('#card-quad-finished-books .stats-quad-unit'),
            quadReadDaysUnit: document.querySelector('#card-quad-read-days .stats-quad-unit'),
            quadNoteCountUnit: document.querySelector('#card-quad-notes .stats-quad-unit'),
            statsDistributionChart: document.getElementById('stats-distribution-chart'),
            statsCardTitle: document.querySelector('.stats-card-title'),
            statsLeaderboardSub: document.querySelector('.stats-leaderboard-box .stats-section-subtitle'),
            statsPeakPill: document.getElementById('stats-peak-pill'),
            statsPeakText: document.getElementById('stats-peak-text'),
            statsYMax: document.getElementById('stats-y-max'),
            statsYMid: document.getElementById('stats-y-mid'),
            statsLeaderboardList: document.getElementById('stats-leaderboard-list'),
            statsRecentSessions: document.getElementById('stats-recent-sessions'),
            btnRefreshStats: document.getElementById('btn-refresh-stats'),
            statsLiteraryText: document.getElementById('stats-literary-text'),
            statsGoalsRow: document.getElementById('stats-goals-row'),
            goalRingYear: document.getElementById('goal-ring-year'),
            goalPctYear: document.getElementById('goal-pct-year'),
            goalSubYear: document.getElementById('goal-sub-year'),
            goalRingMonth: document.getElementById('goal-ring-month'),
            goalPctMonth: document.getElementById('goal-pct-month'),
            goalSubMonth: document.getElementById('goal-sub-month'),
            goalRingToday: document.getElementById('goal-ring-today'),
            goalPctToday: document.getElementById('goal-pct-today'),
            goalSubToday: document.getElementById('goal-sub-today'),
            cardGoalYear: document.getElementById('card-goal-year'),
            cardGoalMonth: document.getElementById('card-goal-month'),
            cardGoalToday: document.getElementById('card-goal-today'),
            goalsCustomInputsWrap: document.getElementById('goals-custom-inputs-wrap'),
            statsHeatmapYearSubtitle: document.getElementById('stats-heatmap-year-subtitle'),
            statsCalendarHeatmap: document.getElementById('stats-calendar-heatmap-container'),
            statsHeatmapDayDetails: document.getElementById('stats-heatmap-day-details'),
            heatmapDetailDate: document.getElementById('heatmap-detail-date'),
            heatmapDetailTotal: document.getElementById('heatmap-detail-total'),
            btnCloseHeatmapDetail: document.getElementById('btn-close-heatmap-detail'),
            heatmapDetailBooksList: document.getElementById('heatmap-detail-books-list')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.dom.statsSegmentedTabs?.forEach(btn => {
            this.events.on(btn, 'click', (e) => {
                this.dom.statsSegmentedTabs.forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                this.statsViewMode = btn.dataset.mode || 'month'
                if (this.statsViewMode === 'week') {
                    this.statsWeekOffset = 0
                }
                this.renderStatsDashboard()
            })
        });
        this.events.on(this.dom.btnStatsPrevDate, 'click', () => {
            if (this.statsViewMode === 'week') {
                this.statsWeekOffset--
            } else if (this.statsViewMode === 'month') {
                this.statsMonth--
                if (this.statsMonth < 1) { this.statsMonth = 12; this.statsYear-- }
            } else if (this.statsViewMode === 'year') {
                this.statsYear--
            }
            this.renderStatsDashboard()
        });
        this.events.on(this.dom.btnStatsNextDate, 'click', () => {
            if (this.dom.btnStatsNextDate.disabled) return
            const now = new Date()
            if (this.statsViewMode === 'week') {
                if ((this.statsWeekOffset || 0) >= 0) return
                this.statsWeekOffset++
            } else if (this.statsViewMode === 'month') {
                if (this.statsYear > now.getFullYear() || (this.statsYear === now.getFullYear() && this.statsMonth >= (now.getMonth() + 1))) return
                this.statsMonth++
                if (this.statsMonth > 12) { this.statsMonth = 1; this.statsYear++ }
            } else if (this.statsViewMode === 'year') {
                if (this.statsYear >= now.getFullYear()) return
                this.statsYear++
            }
            this.renderStatsDashboard()
        });
        this.events.on(this.dom.btnRefreshStats, 'click', () => this.renderStatsDashboard());
        this.events.on(document.getElementById('card-quad-read-books'), 'click', () => {
            this.openStatsDetailModal('read_books')
        });
        this.events.on(document.getElementById('card-quad-finished-books'), 'click', () => {
            this.openStatsDetailModal('finished_books')
        });
        this.events.on(document.getElementById('card-quad-read-days'), 'click', () => {
            const chartCard = document.querySelector('.stats-chart-card')
            if (chartCard) {
                chartCard.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
        });
        this.events.on(document.getElementById('card-quad-notes'), 'click', () => {
            this.openStatsDetailModal('notes')
        });
        this.events.on(document.getElementById('btn-close-stats-detail'), 'click', () => {
            this.closeStatsDetailModal()
        });
        this.events.on(document.getElementById('btn-stats-detail-confirm'), 'click', () => {
            this.closeStatsDetailModal()
        });
        this.events.on(document.getElementById('modal-stats-detail'), 'click', e => {
            if (e.target === document.getElementById('modal-stats-detail')) {
                this.closeStatsDetailModal()
            }
        });
        this.events.on(this.dom.cardGoalYear, 'click', async () => {
            const current = this.app.settings.readingGoalYear || 12
            const val = await this.app.dialogs.showInputDialog({
                title: t('statsView.goal.yearTitle'),
                placeholder: t('statsView.goal.yearPlaceholder'),
                value: String(current),
                confirmText: t('statsView.goal.confirmSave')
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.app.setSetting('readingGoalYear', parsed, 'global')
                    if (this.app.appearance.dom.settingGoalYear) this.app.appearance.dom.settingGoalYear.value = parsed
                    await this.app.saveSettings()
                    this.renderStatsDashboard()
                    this.app.dialogs.showToast(t('statsView.goal.yearSaved', { count: parsed }), 'success')
                }
            }
        });
        this.events.on(this.dom.cardGoalMonth, 'click', async () => {
            const current = this.app.settings.readingGoalMonth || 20
            const val = await this.app.dialogs.showInputDialog({
                title: t('statsView.goal.monthTitle'),
                placeholder: t('statsView.goal.monthPlaceholder'),
                value: String(current),
                confirmText: t('statsView.goal.confirmSave')
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.app.setSetting('readingGoalMonth', parsed, 'global')
                    if (this.app.appearance.dom.settingGoalMonth) this.app.appearance.dom.settingGoalMonth.value = parsed
                    await this.app.saveSettings()
                    this.renderStatsDashboard()
                    this.app.dialogs.showToast(t('statsView.goal.monthSaved', { hours: parsed }), 'success')
                }
            }
        });
        this.events.on(this.dom.cardGoalToday, 'click', async () => {
            const current = this.app.settings.readingGoalToday || 45
            const val = await this.app.dialogs.showInputDialog({
                title: t('statsView.goal.dayTitle'),
                placeholder: t('statsView.goal.dayPlaceholder'),
                value: String(current),
                confirmText: t('statsView.goal.confirmSave')
            })
            if (val !== null && val.trim() !== '') {
                const parsed = parseInt(val, 10)
                if (!isNaN(parsed) && parsed > 0) {
                    this.app.setSetting('readingGoalToday', parsed, 'global')
                    if (this.app.appearance.dom.settingGoalToday) this.app.appearance.dom.settingGoalToday.value = parsed
                    await this.app.saveSettings()
                    this.renderStatsDashboard()
                    this.app.dialogs.showToast(t('statsView.goal.daySaved', { minutes: parsed }), 'success')
                }
            }
        });
        this.events.on(this.app.appearance.dom.settingEnableReadingGoals, 'change', async (e) => {
            const enabled = !!e.target.checked
            this.app.setSetting('enableReadingGoals', enabled, 'global')
            await this.app.saveSettings()
            if (this.dom.goalsCustomInputsWrap) {
                this.dom.goalsCustomInputsWrap.style.display = enabled ? 'block' : 'none'
            }
            if (this.dom.statsGoalsRow) {
                this.dom.statsGoalsRow.style.display = enabled ? 'grid' : 'none'
            }
            if (this.app.bookshelf.shelfCategory === 'stats') {
                this.renderStatsDashboard()
            }
            this.app.dialogs.showToast(enabled ? t('statsView.goal.enabledToast') : t('statsView.goal.disabledToast'), 'info')
        });
        this.events.on(this.app.appearance.dom.settingGoalYear, 'change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.app.setSetting('readingGoalYear', parsed, 'global')
                await this.app.saveSettings()
                if (this.app.bookshelf.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        });
        this.events.on(this.app.appearance.dom.settingGoalMonth, 'change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.app.setSetting('readingGoalMonth', parsed, 'global')
                await this.app.saveSettings()
                if (this.app.bookshelf.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        });
        this.events.on(this.app.appearance.dom.settingGoalToday, 'change', async (e) => {
            const parsed = parseInt(e.target.value, 10)
            if (!isNaN(parsed) && parsed > 0) {
                this.app.setSetting('readingGoalToday', parsed, 'global')
                await this.app.saveSettings()
                if (this.app.bookshelf.shelfCategory === 'stats') this.renderStatsDashboard()
            }
        });
            this.events.on(this.dom.btnCloseHeatmapDetail, 'click', () => {
            this._activeHeatmapDay = null
            if (this.dom.statsHeatmapDayDetails) {
                this.dom.statsHeatmapDayDetails.style.display = 'none'
            }
            this.dom.statsCalendarHeatmap?.querySelectorAll('.heatmap-cell.active').forEach(c => c.classList.remove('active'))
        });
    }

    dispose() { this.events.dispose(); this._bound = false }

    _isStatsViewActive() {
        return this.app.bookshelf?.shelfCategory === 'stats'
            || window.mobileShell?.activeSubviewKey === 'stats'
    }

    async refreshLocale() {
        if (!this._isStatsViewActive()) return
        await this.renderStatsDashboard()
        if (this._activeDetailModalType) {
            const modal = document.getElementById('modal-stats-detail')
            if (modal?.classList.contains('show')) {
                this.openStatsDetailModal(this._activeDetailModalType)
            }
        }
    }

    _updateQuadUnit(el, count, pluralKey, singularKey) {
        if (!el) return
        el.innerText = t(Number(count) === 1 ? singularKey : pluralKey)
    }

    async openStatsView() {
        this.app.bookshelf.shelfCategory = 'stats'
        await this.app.bookshelf.refreshBookshelf()
    }

    renderHeatmapDayDetails(dateStr, payload) {
        if (!this.dom.statsHeatmapDayDetails) return
        this.dom.statsHeatmapDayDetails.style.display = 'block'
        if (this.dom.heatmapDetailDate) {
            this.dom.heatmapDetailDate.innerText = dateStr
        }
        if (this.dom.heatmapDetailTotal) {
            const durText = payload?.seconds > 0 
                ? t('statsView.heatmap.totalRead', { duration: formatMinutesClean(payload.minutes || Math.round(payload.seconds / 60)) })
                : t('statsView.heatmap.noTime')
            this.dom.heatmapDetailTotal.innerText = durText
        }
        if (this.dom.heatmapDetailBooksList) {
            this.dom.heatmapDetailBooksList.innerHTML = ''
            const books = payload?.books || []
            if (books.length === 0) {
                this.dom.heatmapDetailBooksList.innerHTML = `<div style="color: var(--text-muted); font-size: 0.82rem; padding: 6px 0;">${escapeHTML(t('statsView.heatmap.noDayRecords'))}</div>`
            } else {
                books.forEach(b => {
                    const item = document.createElement('div')
                    item.className = 'heatmap-detail-book-item'
                    const bDur = b.seconds > 0 ? tracker.formatDuration(b.seconds) : t('statsView.heatmap.minutes', { minutes: b.minutes || 0 })
                    item.innerHTML = `
                        <div style="flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px;">
                            <span style="font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(b.title)}</span>
                            ${b.author ? `<span style="font-size: 0.76rem; color: var(--text-muted); white-space: nowrap;">${escapeHTML(b.author)}</span>` : ''}
                            <span style="font-size: 0.76rem; color: var(--text-muted); white-space: nowrap;">${bDur}</span>
                        </div>
                        <div class="heatmap-detail-book-actions">
                            <button type="button" class="btn-heatmap-action btn-detail" title="${escapeHTML(t('statsView.heatmap.detailTitle'))}">${escapeHTML(t('statsView.heatmap.detailBtn'))}</button>
                            <button type="button" class="btn-heatmap-action btn-read" title="${escapeHTML(t('statsView.heatmap.readTitle'))}">${escapeHTML(t('statsView.heatmap.readBtn'))}</button>
                        </div>
                    `
                    item.querySelector('.btn-detail')?.addEventListener('click', async (e) => {
                        e.stopPropagation()
                        const book = await db.getBook(b.bookId)
                        if (book) {
                            this.app.openBookDetailsModal(b.bookId)
                        } else {
                            this.app.dialogs.showToast?.(t('statsView.heatmap.missingSourceInfo', { title: b.title }), 'info')
                        }
                    })
                    item.querySelector('.btn-read')?.addEventListener('click', async (e) => {
                        e.stopPropagation()
                        const book = await db.getBook(b.bookId)
                        if (book) {
                            this.app.openBook(b.bookId)
                        } else {
                            this.app.dialogs.showToast?.(t('statsView.heatmap.missingSourceWarn', { title: b.title }), 'warning')
                        }
                    })
                    this.dom.heatmapDetailBooksList.appendChild(item)
                })
            }
        }
    }

    async deduplicateBooks() {
        return 0
    }

    async renderStatsDashboard() {
        if (!this.dom.statsDashboardContainer) return
        this._statsReqId = (this._statsReqId || 0) + 1
        const currentReqId = this._statsReqId

        try {
            const mode = this.statsViewMode || 'month'
            const stats = await db.getReadingStats(mode, this.statsYear, this.statsMonth, this.statsWeekOffset || 0)
            if (currentReqId !== this._statsReqId) return // Drop stale response!

            // 1. Update Date Navigator Text
            if (this.dom.statsDateLabel) {
                if (this.dom.statsDateNavigator) this.dom.statsDateNavigator.style.visibility = 'visible'
                if (mode === 'week') {
                    if (this.statsWeekOffset === 0) {
                        this.dom.statsDateLabel.innerText = stats.weekDateRangeStr ? t('statsView.period.thisWeekRange', { range: stats.weekDateRangeStr }) : t('statsView.period.thisWeek')
                    } else {
                        this.dom.statsDateLabel.innerText = stats.weekDateRangeStr || t('statsView.period.weekOffset', { offset: this.statsWeekOffset })
                    }
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const isFutureOrCurrent = (this.statsWeekOffset || 0) >= 0
                        this.dom.btnStatsNextDate.disabled = isFutureOrCurrent
                        this.dom.btnStatsNextDate.style.opacity = isFutureOrCurrent ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isFutureOrCurrent ? 'default' : 'pointer'
                    }
                } else if (mode === 'month') {
                    this.dom.statsDateLabel.innerText = isEnglish()
                        ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(stats.targetYear, stats.targetMonth - 1, 1))
                        : t('statsView.period.yearMonth', { year: stats.targetYear, month: stats.targetMonth })
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const now = new Date()
                        const isCurrentOrFuture = this.statsYear > now.getFullYear() || (this.statsYear === now.getFullYear() && this.statsMonth >= (now.getMonth() + 1))
                        this.dom.btnStatsNextDate.disabled = isCurrentOrFuture
                        this.dom.btnStatsNextDate.style.opacity = isCurrentOrFuture ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isCurrentOrFuture ? 'default' : 'pointer'
                    }
                } else if (mode === 'year') {
                    this.dom.statsDateLabel.innerText = t('statsView.period.yearOnly', { year: stats.targetYear })
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'inline-flex'
                    if (this.dom.btnStatsNextDate) {
                        this.dom.btnStatsNextDate.style.display = 'inline-flex'
                        const now = new Date()
                        const isCurrentOrFuture = this.statsYear >= now.getFullYear()
                        this.dom.btnStatsNextDate.disabled = isCurrentOrFuture
                        this.dom.btnStatsNextDate.style.opacity = isCurrentOrFuture ? '0.35' : '1'
                        this.dom.btnStatsNextDate.style.cursor = isCurrentOrFuture ? 'default' : 'pointer'
                    }
                } else if (mode === 'total') {
                    this.dom.statsDateLabel.innerText = t('statsView.period.allTimeHeader')
                    if (this.dom.btnStatsPrevDate) this.dom.btnStatsPrevDate.style.display = 'none'
                    if (this.dom.btnStatsNextDate) this.dom.btnStatsNextDate.style.display = 'none'
                }
            }

            // 1.5. Annual Report Banner Visibility (Disabled for PC Candidate)
            if (this.app.dom.bannerAnnualReport) {
                this.app.dom.bannerAnnualReport.style.display = 'none'
            }

            // 2. Hero Big Duration Banner
            if (this.dom.statsHeroTime) {
                if (mode === 'total') {
                    const totalH = stats.totalHours || 0
                    this.dom.statsHeroTime.innerHTML = `${totalH}<span class="stats-unit">${escapeHTML(t('stats.unitHours'))}</span>`
                } else {
                    const h = stats.viewHours || 0
                    const m = stats.viewMins || 0
                    if (h > 0) {
                        this.dom.statsHeroTime.innerHTML = `${h}<span class="stats-unit">${escapeHTML(t('stats.unitHours'))}</span> ${m}<span class="stats-unit">${escapeHTML(t('stats.unitMinutes'))}</span>`
                    } else {
                        this.dom.statsHeroTime.innerHTML = `${m}<span class="stats-unit">${escapeHTML(t('stats.unitMinutes'))}</span>`
                    }
                }
            }

            // 3. Hero Sub Insight Text
            if (this.dom.statsHeroSub) {
                if (mode === 'total') {
                    this.dom.statsHeroSub.innerText = t('statsView.hero.companion', { startDate: stats.earliestDateStr, days: stats.companionDays })
                } else {
                    const now = new Date()
                    const targetYear = stats.targetYear || now.getFullYear()
                    const targetMonth = stats.targetMonth || (now.getMonth() + 1)
                    let divisor = 1
                    if (mode === 'week') {
                        const dayOfWeek = now.getDay() || 7
                        divisor = (this.statsWeekOffset === 0) ? dayOfWeek : 7
                    } else if (mode === 'month') {
                        const isCurrentMonth = targetYear === now.getFullYear() && targetMonth === (now.getMonth() + 1)
                        divisor = isCurrentMonth ? Math.max(1, now.getDate()) : (stats.chartData?.length || 30)
                    } else if (mode === 'year') {
                        const isCurrentYear = targetYear === now.getFullYear()
                        if (isCurrentYear) {
                            const startOfYear = new Date(now.getFullYear(), 0, 1)
                            divisor = Math.max(1, Math.floor((now.getTime() - startOfYear.getTime()) / (86400 * 1000)) + 1)
                        } else {
                            const isLeap = (targetYear % 4 === 0 && targetYear % 100 !== 0) || (targetYear % 400 === 0)
                            divisor = isLeap ? 366 : 365
                        }
                    } else {
                        divisor = Math.max(1, stats.companionDays || 1)
                    }

                    const avgSecondsPerDay = stats.viewTotalSeconds / divisor
                    let avgText = ''
                    if (avgSecondsPerDay >= 3600) {
                        const h = (avgSecondsPerDay / 3600).toFixed(1)
                        avgText = t('statsView.hero.avgHours', { hours: h })
                    } else if (avgSecondsPerDay >= 60) {
                        avgText = t('statsView.hero.avgMins', { minutes: Math.round(avgSecondsPerDay / 60) })
                    } else if (stats.viewTotalSeconds > 0) {
                        avgText = t('statsView.hero.avgLessThanOne')
                    } else {
                        avgText = t('statsView.hero.avgZero')
                    }
                    this.dom.statsHeroSub.innerText = t('statsView.hero.dailyAvg', { avg: avgText })
                }
            }

            // 4. Quad Micro KPIs (读过 / 读完 / 阅读天数 / 笔记)
            this.latestStats = stats
            const readBooksCount = stats.periodBooksCount != null ? stats.periodBooksCount : stats.totalBooksCount
            const finishedBooksCount = stats.periodFinishedCount != null ? stats.periodFinishedCount : stats.finishedCount
            const readDaysCount = stats.viewReadDays || 0
            const noteCount = stats.periodHighlightsCount != null ? stats.periodHighlightsCount : stats.totalHighlightsCount
            if (this.dom.quadReadBooks) this.dom.quadReadBooks.innerText = `${readBooksCount}`
            if (this.dom.quadFinishedBooks) this.dom.quadFinishedBooks.innerText = `${finishedBooksCount}`
            if (this.dom.quadReadDays) this.dom.quadReadDays.innerText = `${readDaysCount}`
            if (this.dom.quadNoteCount) this.dom.quadNoteCount.innerText = `${noteCount}`
            this._updateQuadUnit(this.dom.quadReadBooksUnit, readBooksCount, 'stats.tileReadUnit', 'stats.tileReadUnitSingular')
            this._updateQuadUnit(this.dom.quadFinishedBooksUnit, finishedBooksCount, 'stats.tileReadUnit', 'stats.tileReadUnitSingular')
            this._updateQuadUnit(this.dom.quadReadDaysUnit, readDaysCount, 'stats.tileDaysUnit', 'stats.tileDaysUnitSingular')
            this._updateQuadUnit(this.dom.quadNoteCountUnit, noteCount, 'stats.tileNotesUnit', 'stats.tileNotesUnitSingular')

            // 4.6. P2 Reading Goal Rings (Customizable Targets - Option C: Default hidden for pure, pressure-free reading)
            if (this.dom.statsGoalsRow) {
                this.dom.statsGoalsRow.style.display = this.app.settings.enableReadingGoals ? 'grid' : 'none'
            }

            if (this.app.settings.enableReadingGoals) {
                // Annual Reading Goal (年度阅读目标): tracks completed books in the current year
                const finishedBooks = (stats.currentYearFinishedCount != null)
                    ? stats.currentYearFinishedCount
                    : (stats.yearFinishedCount != null ? stats.yearFinishedCount : (stats.finishedCount || 0))
                const yearTarget = this.app.settings.readingGoalYear || 12
                const yearPct = Math.min(100, Math.round((finishedBooks / yearTarget) * 100))
                if (this.dom.goalPctYear) this.dom.goalPctYear.innerText = `${yearPct}%`
                if (this.dom.goalSubYear) this.dom.goalSubYear.innerText = t('statsView.goalSub.year', { done: finishedBooks, target: yearTarget })
                if (this.dom.goalRingYear) {
                    const offset = Math.max(0, 201 * (1 - yearPct / 100))
                    this.dom.goalRingYear.style.strokeDashoffset = offset
                }

                // Monthly Progress
                const monthSecs = (stats.currentMonthSeconds != null)
                    ? stats.currentMonthSeconds
                    : (stats.viewMode === 'month' ? (stats.viewTotalSeconds || 0) : 0)
                const monthHours = monthSecs / 3600
                const monthTarget = this.app.settings.readingGoalMonth || 20
                const rawMonthPct = (monthHours / monthTarget) * 100
                const monthPct = Math.min(100, Math.round(rawMonthPct))
                if (this.dom.goalPctMonth) {
                    this.dom.goalPctMonth.innerText = (monthHours > 0 && monthPct === 0) ? '<1%' : `${monthPct}%`
                }
                if (this.dom.goalSubMonth) this.dom.goalSubMonth.innerText = t('statsView.goalSub.month', { done: monthHours.toFixed(1), target: monthTarget })
                if (this.dom.goalRingMonth) {
                    const effectivePct = Math.max(monthPct, monthHours > 0 ? 1 : 0)
                    const offset = Math.max(0, 201 * (1 - effectivePct / 100))
                    this.dom.goalRingMonth.style.strokeDashoffset = offset
                }

                // Daily Focus
                const activeSecs = (tracker && tracker.isTracking) ? (tracker.sessionCumulativeSeconds || 0) : 0
                const todayMins = Math.round(((stats.todaySeconds || 0) + activeSecs) / 60)
                const todayTarget = this.app.settings.readingGoalToday || 45
                const rawTodayPct = (todayMins / todayTarget) * 100
                const todayPct = Math.min(100, Math.round(rawTodayPct))
                if (this.dom.goalPctToday) {
                    this.dom.goalPctToday.innerText = (todayMins > 0 && todayPct === 0) ? '<1%' : `${todayPct}%`
                }
                if (this.dom.goalSubToday) this.dom.goalSubToday.innerText = t('statsView.goalSub.day', { done: todayMins, target: todayTarget })
                if (this.dom.goalRingToday) {
                    const effectivePct = Math.max(todayPct, todayMins > 0 ? 1 : 0)
                    const offset = Math.max(0, 201 * (1 - effectivePct / 100))
                    this.dom.goalRingToday.style.strokeDashoffset = offset
                }
            }

            // 5. Render Distribution Bar Chart
            this.renderDistributionChart(stats)

            // 6. Books Leaderboard: in specific periods (week, month, year), do NOT fall back to historical topBooks!
            const isTotalMode = stats.viewMode === 'total'
            const leaderboardBooks = isTotalMode
                ? (stats.periodBooks && stats.periodBooks.length > 0 ? stats.periodBooks : (stats.topBooks || []))
                : (stats.periodBooks || [])

            // Update leaderboard subtitle to match current period
            const subTitleEl = this.dom.statsLeaderboardSub || document.querySelector('.stats-leaderboard-box .stats-section-subtitle')
            if (subTitleEl) {
                if (stats.viewMode === 'week') {
                    subTitleEl.innerText = stats.weekOffset === 0 ? t('statsView.topSub.thisWeek') : t('statsView.topSub.selectedWeek')
                } else if (stats.viewMode === 'month') {
                    const mLabel = isEnglish()
                        ? new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(2000, (stats.targetMonth || 1) - 1, 1))
                        : stats.targetMonth
                    subTitleEl.innerText = t('statsView.topSub.month', { month: mLabel })
                } else if (stats.viewMode === 'year') {
                    subTitleEl.innerText = t('statsView.topSub.year', { year: stats.targetYear })
                } else {
                    subTitleEl.innerText = t('statsView.topSub.total')
                }
            }

            this.renderLeaderboard(leaderboardBooks, stats.viewMode)

            // 7. Recent Sessions Timeline
            this.renderRecentSessions(stats.recentSessions)

            // 7.5. Reading Calendar Heatmap
            const heatmapYear = stats.targetYear || new Date().getFullYear()
            if (this.dom.statsHeatmapYearSubtitle) {
                this.dom.statsHeatmapYearSubtitle.innerText = t('statsView.period.yearOnly', { year: heatmapYear })
            }
            const restoredDate = this._activeHeatmapDay?.dateStr
            const canKeepHeatmapDetail = Boolean(restoredDate && restoredDate.startsWith(`${heatmapYear}-`))
            if (!canKeepHeatmapDetail && this.dom.statsHeatmapDayDetails) {
                this._activeHeatmapDay = null
                this.dom.statsHeatmapDayDetails.style.display = 'none'
            }
            if (this.dom.statsCalendarHeatmap) {
                const heatmapResult = await renderCalendarHeatmap(this.dom.statsCalendarHeatmap, heatmapYear, (dateStr, payload) => {
                    this._activeHeatmapDay = { dateStr, payload }
                    this.renderHeatmapDayDetails(dateStr, payload)
                })
                if (currentReqId !== this._statsReqId) return
                if (canKeepHeatmapDetail) {
                    const activeCell = this.dom.statsCalendarHeatmap.querySelector(`.heatmap-cell[data-date="${restoredDate}"]`)
                    activeCell?.classList.add('active')
                    const freshPayload = heatmapResult?.getDayPayload?.(restoredDate) || this._activeHeatmapDay.payload
                    this._activeHeatmapDay = { dateStr: restoredDate, payload: freshPayload }
                    this.renderHeatmapDayDetails(restoredDate, freshPayload)
                }
            }

        } catch (err) {
            console.error('Failed to render stats dashboard:', err)
        }
    }

    renderDistributionChart(stats) {
        const container = this.dom.statsDistributionChart
        if (!container) return
        container.innerHTML = ''

        const data = stats.chartData || []
        const scale = getReadingChartScale(data)
        if (this.dom.statsYMax) this.dom.statsYMax.innerText = scale.hasData ? formatAxisLabel(scale.maxMinutes, scale.unit) : ''
        if (this.dom.statsYMid) this.dom.statsYMid.innerText = scale.hasData ? formatAxisLabel(scale.midMinutes, scale.unit) : ''
        if (data.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem; width:100%; text-align:center;">${escapeHTML(t('statsView.emptyRecordsShort'))}</div>`
            return
        }

        // Update Chart Card Title
        const chartTitleEl = this.dom.statsCardTitle || document.querySelector('.stats-card-title')
        if (chartTitleEl) {
            if (stats.viewMode === 'week') {
                chartTitleEl.innerText = stats.weekOffset === 0 ? t('statsView.chart.thisWeek') : t('statsView.chart.rangeWeek', { range: stats.weekDateRangeStr })
            }
            else if (stats.viewMode === 'month') {
                const monthDisplay = isEnglish()
                    ? new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(stats.targetYear, (stats.targetMonth || 1) - 1, 1))
                    : stats.targetMonth
                chartTitleEl.innerText = t('statsView.chart.monthDaily', { year: stats.targetYear, month: monthDisplay })
            }
            else if (stats.viewMode === 'year') chartTitleEl.innerText = t('statsView.chart.yearMonthly', { year: stats.targetYear })
            else if (stats.viewMode === 'total') chartTitleEl.innerText = t('statsView.chart.allYears')
        }

        // Render clean, trackless bar chart without false 8% floor
        renderCleanBarChart(container, data)

        // Update Peak Pill
        if (this.dom.statsPeakPill && this.dom.statsPeakText) {
            if (stats.peakInfo && stats.peakInfo.seconds > 0) {
                this.dom.statsPeakText.innerHTML = `<span style="font-weight: 700; margin-right: 4px; color: var(--accent-primary, #da7756);">●</span> ${escapeHTML(t('statsView.peakLine', { label: stats.peakInfo.label, time: stats.peakInfo.timeStr }))}`
                this.dom.statsPeakPill.style.display = 'inline-flex'
            } else {
                this.dom.statsPeakPill.style.display = 'none'
            }
        }
    }

    renderLeaderboard(books, viewMode = 'total') {
        const container = this.dom.statsLeaderboardList
        if (!container) return
        container.innerHTML = ''

        const validBooks = (books || []).filter(b => {
            const secs = (b.periodReadingSeconds != null ? b.periodReadingSeconds : b.totalReadingSeconds) || 0
            const frac = b.progress?.fraction || 0
            return secs > 0 || frac > 0
        })

        if (validBooks.length === 0) {
            const emptyNotice = viewMode === 'total'
                ? t('statsView.emptyAll')
                : t('statsView.emptyPeriod')
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 2.5rem 1rem;">
                    ${emptyNotice}
                </div>
            `
            return
        }

        validBooks.forEach((book, idx) => {
            const item = document.createElement('div')
            item.className = 'leaderboard-item'
            item.dataset.id = book.id

            let rankClass = ''
            const rankNum = idx + 1
            const rankText = rankNum < 10 ? `0${rankNum}` : `${rankNum}`
            if (idx === 0) { rankClass = 'rank-1' }
            else if (idx === 1) { rankClass = 'rank-2' }
            else if (idx === 2) { rankClass = 'rank-3' }

            let coverUrl = ''
            if (book.coverBlob) {
                coverUrl = coverUrlPool.getForBook(book)
            }

            const bookSecs = (book.periodReadingSeconds != null ? book.periodReadingSeconds : book.totalReadingSeconds) || 0
            const timeStr = tracker.formatDuration(bookSecs)

            // Reading progress bar: fraction first, fallback to progressPercentage, finished state, or null when only reading duration exists.
            const fraction = this.resolveBookProgressRatio(book)
            const numericFraction = fraction ?? 0
            const rawPct = numericFraction * 100
            const progressPct = fraction === null
                ? '—'
                : (numericFraction === 0 ? '0' : (rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))))
            const progressBarWidth = Math.max(0, Math.min(100, Math.round(numericFraction * 1000) / 10))
            const progressLabel = fraction === null ? '—' : t('statsView.itemProgress', { pct: progressPct })

            const displayTitle = resolveBookTitle(book.title, book.filename)
            item.innerHTML = `
                <div class="rank-badge ${rankClass}">${rankText}</div>
                ${coverUrl 
                    ? `<img class="item-thumb" src="${escapeHTML(coverUrl)}" alt="${escapeHTML(displayTitle)}"/>`
                    : `<div class="item-thumb item-thumb-cloth">${renderEditorialCoverHTML({ ...book, title: displayTitle }, { micro: true, displayTitle })}</div>`
                }
                <div class="item-info">
                    <div class="item-title" title="${escapeHTML(displayTitle)}">${escapeHTML(displayTitle)}</div>
                    <div class="item-meta">
                        <span class="item-time">${escapeHTML(t('statsView.itemTime', { time: timeStr }))}</span>
                        <span>${escapeHTML(progressLabel)}</span>
                    </div>
                    <div class="item-progress-track">
                        <div class="item-progress-fill" style="width: ${progressBarWidth}%;"></div>
                    </div>
                </div>
            `

            item.addEventListener('click', () => this.app.openBook(book.id))
            container.appendChild(item)
        })
    }

    renderRecentSessions(sessions) {
        const container = this.dom.statsRecentSessions
        if (!container) return
        container.innerHTML = ''

        if (!sessions || sessions.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1.5rem;">
                    ${escapeHTML(t('statsView.noRecentSessions'))}
                </div>
            `
            return
        }

        sessions.forEach(sess => {
            const item = document.createElement('div')
            item.className = 'session-item'

            const timeFormatted = new Date(sess.startTime).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
            const durStr = tracker.formatDuration(sess.durationSeconds || 0)
            const sBookTitle = resolveBookTitle(sess.bookTitle, sess.bookFilename) || t('statsView.unknownBook')
            const coverUrl = sess.coverBlob
                ? coverUrlPool.getForBook({ id: sess.bookId || sBookTitle, coverBlob: sess.coverBlob, coverRevision: sess.coverRevision })
                : ''

            item.innerHTML = `
                <div class="session-item-left">
                    <div class="session-micro-cover">${
                        coverUrl
                            ? `<img src="${escapeHTML(coverUrl)}" alt="${escapeHTML(sBookTitle)}" />`
                            : renderEditorialCoverHTML({ id: sess.bookId || sBookTitle, title: sBookTitle, format: sess.format }, { micro: true, displayTitle: sBookTitle })
                    }</div>
                    <div class="session-info">
                        <div class="session-book-title" title="${escapeHTML(sBookTitle)}">${escapeHTML(sBookTitle)}</div>
                        <div class="session-time-range">${escapeHTML(sess.date)} ${timeFormatted}</div>
                    </div>
                </div>
                <div class="session-duration-pill">${durStr}</div>
            `
            if (sess.bookId) {
                item.style.cursor = 'pointer'
                item.addEventListener('click', () => this.app.openBook(sess.bookId))
            }
            container.appendChild(item)
        })
    }

    /** Resolve normalized [0, 1] progress ratio from fraction, percentage, or status; returns null if duration exists with no position yet. */
    resolveBookProgressRatio(book) {
        if (typeof book?.progress?.fraction === 'number' && Number.isFinite(book.progress.fraction)) {
            return Math.max(0, Math.min(1, book.progress.fraction))
        }
        if (typeof book?.progressPercentage === 'number' && Number.isFinite(book.progressPercentage)) {
            return Math.max(0, Math.min(1, book.progressPercentage / 100))
        }
        if (resolveReadingState(book) === 'finished') return 1
        const dur = book?.periodReadingSeconds ?? book?.totalReadingSeconds ?? 0
        return dur > 0 ? null : 0
    }

    openStatsDetailModal(type) {
        const modal = document.getElementById('modal-stats-detail')
        const iconEl = document.getElementById('stats-detail-modal-icon')
        const titleEl = document.getElementById('stats-detail-modal-title')
        const listEl = document.getElementById('stats-detail-modal-list')
        if (!modal || !listEl) return
        this._activeDetailModalType = type

        listEl.innerHTML = ''
        modal.classList.toggle('is-notes-detail', type === 'notes')
        listEl.classList.toggle('is-notes-list', type === 'notes')
        const stats = this.latestStats || {}
        let periodLabel = t('statsView.period.current')
        if (stats.viewMode === 'week') periodLabel = stats.weekDateRangeStr ? t('statsView.period.thisWeekRange', { range: stats.weekDateRangeStr }) : t('statsView.period.thisWeek')
        else if (stats.viewMode === 'month') periodLabel = isEnglish()
            ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(stats.targetYear, stats.targetMonth - 1, 1))
            : t('statsView.period.yearMonth', { year: stats.targetYear, month: stats.targetMonth })
        else if (stats.viewMode === 'year') periodLabel = t('statsView.period.yearOnly', { year: stats.targetYear })
        else if (stats.viewMode === 'total') periodLabel = t('statsView.period.allTimeShort')

        if (type === 'read_books') {
            if (iconEl) iconEl.innerHTML = uiSymbol('book')
            if (titleEl) titleEl.innerText = t('statsView.modal.booksTitle', { period: periodLabel, count: stats.periodBooks?.length || 0 })

            const books = stats.periodBooks || []
            if (books.length === 0) {
                listEl.innerHTML = `<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">${escapeHTML(t('statsView.modal.booksEmpty'))}</div>`
            } else {
                books.forEach(b => {
                    const row = document.createElement('div')
                    row.className = 'stats-detail-book-row'

                    const ratio = this.resolveBookProgressRatio(b)
                    const progressPct = ratio === null ? null : Math.round(ratio * 100)
                    const durStr = tracker.formatDuration(b.periodReadingSeconds || b.totalReadingSeconds || 0)
                    const coverUrl = b.coverBlob ? coverUrlPool.getForBook(b) : null
                    const bTitle = resolveBookTitle(b.title, b.filename)
                    const metaParts = [b.author || t('book.unknownAuthor'), (b.format || 'txt').toUpperCase()]
                    if (progressPct !== null) metaParts.push(t('statsView.itemProgress', { pct: progressPct }))

                    row.innerHTML = `
                        <div class="stats-detail-cover-wrap">
                            ${coverUrl ? `<img src="${escapeHTML(coverUrl)}" class="stats-detail-cover-img" />` : renderEditorialCoverHTML({ ...b, title: bTitle }, { micro: true, displayTitle: bTitle })}
                        </div>
                        <div class="stats-detail-main">
                            <div class="stats-detail-book-title" title="${escapeHTML(bTitle)}">${escapeHTML(bTitle)}</div>
                            <div class="stats-detail-book-sub">${escapeHTML(metaParts.join(' · '))}</div>
                        </div>
                        <div class="stats-detail-right">
                            <div class="stats-detail-dur">${escapeHTML(durStr)}</div>
                            <button type="button" class="stats-detail-jump-link">${escapeHTML(t('statsView.modal.openReadBtn'))}</button>
                        </div>
                    `
                    row.addEventListener('click', () => {
                        this.closeStatsDetailModal()
                        this.app.openBook(b.id)
                    })
                    listEl.appendChild(row)
                })
            }
        } else if (type === 'finished_books') {
            if (iconEl) iconEl.innerHTML = uiSymbol('award')
            if (titleEl) titleEl.innerText = t('statsView.modal.finishedTitle', { period: periodLabel, count: stats.periodFinishedBooks?.length || 0 })

            const topAction = document.createElement('div')
            topAction.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 4px;'
            topAction.innerHTML = `<button type="button" class="stats-detail-jump-link" style="font-size: 0.8rem;">${escapeHTML(t('statsView.modal.allFinishedLink'))}</button>`
            topAction.querySelector('button')?.addEventListener('click', () => {
                this.closeStatsDetailModal()
                if (window.mobileShell?.isMobileViewport?.()) {
                    window.mobileShell.shelfFilter = 'finished'
                    window.mobileShell.switchTab?.('shelf')
                } else {
                    this.app.bookshelf.switchShelfCategory('overview', { status: 'finished' })
                }
            })
            listEl.appendChild(topAction)

            const books = stats.periodFinishedBooks || []
            if (books.length === 0) {
                listEl.insertAdjacentHTML('beforeend', `<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">${escapeHTML(t('statsView.modal.finishedEmpty'))}</div>`)
            } else {
                books.forEach(b => {
                    const row = document.createElement('div')
                    row.className = 'stats-detail-book-row'

                    const durStr = tracker.formatDuration(b.periodReadingSeconds || b.totalReadingSeconds || 0)
                    const coverUrl = b.coverBlob ? coverUrlPool.getForBook(b) : null
                    const bTitle = resolveBookTitle(b.title, b.filename)

                    row.innerHTML = `
                        <div class="stats-detail-cover-wrap">
                            ${coverUrl ? `<img src="${escapeHTML(coverUrl)}" class="stats-detail-cover-img" />` : renderEditorialCoverHTML({ ...b, title: bTitle }, { micro: true, displayTitle: bTitle })}
                        </div>
                        <div class="stats-detail-main">
                            <div class="stats-detail-book-title" title="${escapeHTML(bTitle)}">${escapeHTML(bTitle)}</div>
                            <div class="stats-detail-book-sub">${escapeHTML(b.author || t('book.unknownAuthor'))} · ${escapeHTML((b.format || 'txt').toUpperCase())}</div>
                        </div>
                        <div class="stats-detail-right">
                            <div class="stats-detail-dur">${escapeHTML(t('statsView.modal.finishedBadge', { dur: durStr }))}</div>
                            <button type="button" class="stats-detail-jump-link">${escapeHTML(t('statsView.modal.rereadBtn'))}</button>
                        </div>
                    `
                    row.addEventListener('click', () => {
                        this.closeStatsDetailModal()
                        this.app.openBook(b.id)
                    })
                    listEl.appendChild(row)
                })
            }
        } else if (type === 'notes') {
            if (iconEl) iconEl.innerHTML = uiSymbol('note')
            if (titleEl) titleEl.innerText = t('statsView.modal.notesTitle', { period: periodLabel, count: stats.periodHighlights?.length || 0 })

            const notes = [...(stats.periodHighlights || [])].sort(
                (a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0)
            )
            if (notes.length === 0) {
                listEl.innerHTML = `<div style="text-align:center; padding: 2rem; color: var(--text-muted); font-size: 0.88rem;">${escapeHTML(t('statsView.modal.notesEmpty'))}</div>`
            } else {
                notes.forEach(n => {
                    const row = document.createElement('article')
                    row.className = 'stats-detail-note-row'

                    const bookTitle = resolveBookTitle(n.bookTitle, n.bookFilename) || t('book.untitled')
                    const chapterTitle = (n.chapterTitle && n.chapterTitle !== 'undefined') ? n.chapterTitle : ''
                    const dateStr = (n.createdAt || n.updatedAt) ? new Date(n.createdAt || n.updatedAt).toLocaleDateString(getLocale()) : ''
                    const sourceParts = [t('statsView.modal.noteSourceTitle', { title: bookTitle })]
                    if (chapterTitle) sourceParts.push(chapterTitle)
                    const sourceText = sourceParts.join(' · ')
                    const mappedColor = mapHighlightDisplayColor(n.color || '#D6A736')
                    const rawColor = String(mappedColor || '#c89b3c').trim()
                    const quoteColor = /^[#a-zA-Z0-9(),.%\s-]+$/.test(rawColor) ? rawColor : '#c89b3c'

                    row.innerHTML = `
                        ${n.title ? `<h4 class="stats-detail-note-title">${escapeHTML(n.title)}</h4>` : ''}
                        ${n.text ? `
                            <div class="stats-detail-note-quote-block" style="border-left-color: ${escapeHTML(quoteColor)};">
                                <div class="stats-detail-note-quote">${escapeHTML(n.text)}</div>
                            </div>
                        ` : ''}
                        ${n.note ? `
                            <div class="stats-detail-note-thought">
                                <span class="stats-detail-thought-badge">${escapeHTML(t('annotations.thoughtBadge'))}</span>
                                <span class="stats-detail-thought-body">${escapeHTML(n.note)}</span>
                            </div>
                        ` : ''}
                        <div class="stats-detail-note-meta">
                            <span class="stats-detail-note-source" title="${escapeHTML(sourceText)}">${escapeHTML(sourceText)}</span>
                            ${dateStr ? `<span class="stats-detail-note-date">${escapeHTML(dateStr)}</span>` : ''}
                        </div>
                    `

                    if (n.bookId) {
                        row.setAttribute('role', 'button')
                        row.setAttribute('tabindex', '0')
                        const jumpToNote = async () => {
                            this.closeStatsDetailModal()
                            const target = n.pdfTarget || {}
                            const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                            const page = firstSegment?.page ?? target.page ?? 0
                            const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                            const yRatio = rects?.[0]?.[1] ?? 0
                            const isPdf = Boolean(n.pdfTarget || n.formatType === 'pdf')
                            const loc = n.cfi
                                ? { cfi: n.cfi }
                                : (isPdf ? { page: page + 1, yRatio, highlightId: n.id, rects } : null)

                            if (window.mobileShell?.isMobileViewport?.() && typeof window.mobileShell.locateNote === 'function') {
                                await window.mobileShell.locateNote(n)
                                return
                            }
                            if (this.app.currentBookId && String(this.app.currentBookId) === String(n.bookId)) {
                                this.app.navHistory?.pushLocation?.()
                                if (this.app.dom.readerView) {
                                    this.app.dom.readerView.style.display = 'block'
                                    this.app.dom.readerView.classList.add('active')
                                }
                                if (this.app.dom.bookshelfView) this.app.dom.bookshelfView.style.display = 'none'
                                if (this.app.pdfViewport && isPdf) {
                                    this.app.pdfViewport.goToPage(page, yRatio)
                                    this.app.pdfViewport.pulseHighlight?.(page, n.id, rects)
                                } else if (n.cfi && this.app.foliateView) {
                                    this.app.foliateView.goTo(n.cfi)
                                }
                            } else {
                                await this.app.openBook(n.bookId, loc)
                            }
                        }
                        row.addEventListener('click', () => { jumpToNote().catch(err => console.warn('Jump to note failed:', err)) })
                        row.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                jumpToNote().catch(err => console.warn('Jump to note failed:', err))
                            }
                        })
                    }
                    listEl.appendChild(row)
                })
            }
        }

        modal.style.display = 'flex'
        modal.classList.add('show')
    }

    closeStatsDetailModal() {
        this._activeDetailModalType = null
        const modal = document.getElementById('modal-stats-detail')
        if (modal) {
            modal.classList.remove('show')
            setTimeout(() => { modal.style.display = 'none' }, 220)
        }
    }
}
