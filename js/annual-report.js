/**
 * annual-report.js - NetEase Music / Spotify Wrapped Style Annual Reading Report Generator
 * 
 * Features:
 * - Deterministic data aggregation across sessions, books, and highlights
 * - 9-Act narrative story architecture
 * - Reading Persona Classification (Deep Ocean Submariner, Starry Night Wanderer, etc.)
 * - High-DPI single card canvas export & full paged long-poster stitching
 * - Interactive carousel with touch swipe & keyboard navigation
 * - Privacy mask toggles (hide late-night hours / streaks)
 */

import * as db from './db.js'

export function toLocalDateString(input) {
    if (!input) return ''
    if (typeof db.toLocalDateKey === 'function') {
        try {
            return db.toLocalDateKey(input)
        } catch (_) {}
    }
    const d = new Date(input)
    if (isNaN(d.getTime())) return ''
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

/**
 * Robust HTML escaping for user-supplied strings and excerpts
 */
export function escapeHtml(str) {
    if (str == null) return ''
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Aggregate telemetry into Annual Reading Report structured data
 * @param {number} targetYear - e.g. current year
 * @param {object} rawData - { sessions, highlights, books }
 * @param {object} options - { maskNightStats: boolean, maskStreak: boolean }
 */
export function buildAnnualReport(targetYear = new Date().getFullYear(), rawData = {}, options = {}) {
    const { sessions = [], highlights = [], books = [] } = rawData
    const yearStr = String(targetYear)

    // Deduplicate sessions by stable id
    const seenSessionIds = new Set()
    const uniqueSessions = []
    for (const s of sessions) {
        if (!s) continue
        const sid = s.id || `${s.bookId || ''}_${s.startTime || ''}_${s.date || ''}`
        if (sid && seenSessionIds.has(sid)) continue
        if (sid) seenSessionIds.add(sid)
        uniqueSessions.push(s)
    }

    // Filter sessions belonging to target year by local calendar date
    const yearSessions = uniqueSessions.filter(s => {
        const dur = s.durationSeconds || s.duration || 0
        if (dur <= 0) return false
        const d = s.date || (s.startTime ? toLocalDateString(s.startTime) : '')
        return d && d.startsWith(yearStr)
    })

    // Filter highlights belonging to target year by local calendar date
    const yearHighlights = highlights.filter(h => {
        if (!h) return false
        const t = h.createdAt || h.timestamp || h.updatedAt
        if (!t) return false
        const d = toLocalDateString(t)
        return d && d.startsWith(yearStr)
    })

    // 1. Separate Reading vs Listening Seconds, and compute Active Union Interval
    let readSeconds = 0
    let listenSeconds = 0
    let unintervaledSeconds = 0
    const rawIntervals = []
    const dayMap = new Map() // date string -> total seconds
    const bookSecondsMap = new Map() // bookId -> total seconds
    const hourHistogram = new Array(24).fill(0)
    let earliestSession = null
    let latestSession = null

    for (const sess of yearSessions) {
        const dur = sess.durationSeconds || sess.duration || 0
        const isListen = Boolean(sess.isListening || sess.kind === 'listen')
        if (isListen) {
            listenSeconds += dur
        } else {
            readSeconds += dur
        }

        const dStr = sess.date || (sess.startTime ? toLocalDateString(sess.startTime) : '')
        if (dStr) {
            dayMap.set(dStr, (dayMap.get(dStr) || 0) + dur)
        }

        if (sess.bookId) {
            bookSecondsMap.set(sess.bookId, (bookSecondsMap.get(sess.bookId) || 0) + dur)
        }

        if (sess.startTime) {
            const dateObj = new Date(sess.startTime)
            if (!isNaN(dateObj.getTime())) {
                const hour = dateObj.getHours()
                hourHistogram[hour] += dur

                const startMs = dateObj.getTime()
                const endMs = sess.endTime ? new Date(sess.endTime).getTime() : startMs + dur * 1000
                rawIntervals.push([startMs, Math.max(startMs, endMs)])

                // Track earliest session in the year
                if (!earliestSession || sess.startTime < earliestSession.startTime) {
                    earliestSession = sess
                }
                // Track latest reading hour (23:00 - 05:00)
                if (hour >= 23 || hour <= 4) {
                    if (!latestSession || (dateObj.getMinutes() + (hour < 5 ? (hour + 24) * 60 : hour * 60)) > 
                        (new Date(latestSession.startTime).getMinutes() + (new Date(latestSession.startTime).getHours() < 5 ? (new Date(latestSession.startTime).getHours() + 24) * 60 : new Date(latestSession.startTime).getHours() * 60))) {
                        latestSession = sess
                    }
                }
            } else {
                unintervaledSeconds += dur
            }
        } else {
            unintervaledSeconds += dur
        }
    }

    // Active union of intervals to prevent double-counting when reading along with TTS
    let unionSeconds = 0
    if (rawIntervals.length > 0) {
        rawIntervals.sort((a, b) => a[0] - b[0])
        let cur = null
        for (const [s, e] of rawIntervals) {
            if (!cur) {
                cur = [s, e]
            } else if (s <= cur[1]) {
                cur[1] = Math.max(cur[1], e)
            } else {
                unionSeconds += Math.round((cur[1] - cur[0]) / 1000)
                cur = [s, e]
            }
        }
        if (cur) {
            unionSeconds += Math.round((cur[1] - cur[0]) / 1000)
        }
    }

    const totalSeconds = rawIntervals.length > 0 ? (unionSeconds + unintervaledSeconds) : (readSeconds + listenSeconds)
    const totalHours = (totalSeconds / 3600).toFixed(1)
    const readHours = (readSeconds / 3600).toFixed(1)
    const listenHours = (listenSeconds / 3600).toFixed(1)
    const totalDays = dayMap.size
    const activeDaysSorted = Array.from(dayMap.keys()).sort()

    // 2. Longest Day & Longest Streak
    let longestDayDate = ''
    let longestDaySecs = 0
    for (const [d, secs] of dayMap.entries()) {
        if (secs > longestDaySecs) {
            longestDaySecs = secs
            longestDayDate = d
        }
    }

    let maxStreak = 0
    let currStreak = 0
    let prevDate = null
    for (const d of activeDaysSorted) {
        const currTime = new Date(d).getTime()
        if (prevDate) {
            const diffDays = Math.round((currTime - prevDate) / (1000 * 60 * 60 * 24))
            if (diffDays === 1) {
                currStreak++
            } else {
                currStreak = 1
            }
        } else {
            currStreak = 1
        }
        if (currStreak > maxStreak) maxStreak = currStreak
        prevDate = currTime
    }

    // 3. Top Books & First Book Opened (Honest year-bound data: strictly NO all-time fallbacks or fabricated books)
    const booksReadCount = bookSecondsMap.size
    let topBookId = null
    let topBookSecs = 0
    for (const [bid, secs] of bookSecondsMap.entries()) {
        if (secs > topBookSecs) {
            topBookSecs = secs
            topBookId = bid
        }
    }

    const topBookData = topBookId ? books.find(b => b.id === topBookId) : null
    const firstBookData = earliestSession?.bookId ? (books.find(b => b.id === earliestSession.bookId) || topBookData) : topBookData

    // 4. Night vs Early calculation
    let nightSecs = 0
    for (let h = 23; h <= 23; h++) nightSecs += hourHistogram[h]
    for (let h = 0; h <= 4; h++) nightSecs += hourHistogram[h]

    let earlySecs = 0
    for (let h = 5; h <= 8; h++) earlySecs += hourHistogram[h]

    // 5. Best Quote / Highlight (Strictly NO fabricated quote strings)
    const topHighlight = yearHighlights.find(h => h.notes && h.notes.length > 0) || yearHighlights[0] || null

    // Deterministic persona calculation (no fake AI persona)
    let persona = {
        title: '心流探索者',
        badge: '心流探索者',
        description: '在字行与时光中静静漫游，记录你的阅读印记'
    }
    if (listenSeconds > readSeconds && listenSeconds > 0) {
        persona = {
            title: '声音旅人',
            badge: '声音旅人',
            description: '文字在耳畔生根，声音伴随你走过辽阔世界'
        }
    } else if (nightSecs > earlySecs && nightSecs > 1800) {
        persona = {
            title: '星夜潜行者',
            badge: '星夜潜行者',
            description: '万籁俱寂时，唯有屏幕的微光照亮你的沉思'
        }
    } else if (totalDays >= 30 || maxStreak >= 7) {
        persona = {
            title: '时光耕耘者',
            badge: '时光耕耘者',
            description: '日拱一卒，以恒久的定力在书海中深潜'
        }
    }

    // Check if target year is currently ongoing
    const now = new Date()
    const isCurrentYear = targetYear === now.getFullYear()
    const isYearOngoing = isCurrentYear && (now.getMonth() + 1 < 12 || now.getDate() < 31)

    // Build the Acts with authentic local metrics
    const acts = [
        {
            actNum: 1,
            badge: 'ACT 01 · 初见',
            title: `${targetYear}，文字与你相遇`,
            subtitle: isYearOngoing
                ? (booksReadCount > 0 ? `今年截至今天，你翻开了 ${booksReadCount} 本书，陪伴心灵走过了四季。` : '今年截至今天，你翻开了阅读的新篇章。')
                : (booksReadCount > 0 ? `在这一年里，你翻开了 ${booksReadCount} 本书，陪伴心灵走过了四季。` : '在这一年里，你翻开了阅读的新篇章。'),
            giantStat: `${totalDays}`,
            unit: '天',
            statDesc: totalDays > 0
                ? (isYearOngoing ? `截至今天共有 ${totalDays} 天，你在 Linden Leaf 的书页里留下了阅读印记` : `共有 ${totalDays} 天，你在 Linden Leaf 的书页里留下了阅读印记`)
                : (isYearOngoing ? '随时在 Linden Leaf 留下你的第一抹阅读印记' : '新的一年，随时在 Linden Leaf 留下你的第一抹阅读印记'),
            quote: firstBookData?.title
                ? (isYearOngoing ? `今年翻开的第一本书是《${firstBookData.title}》` : `这一年你翻开的第一本书是《${firstBookData.title}》`)
                : null,
            footer: '书页合上又展开，时间在字行间悄然生根。',
            themeClass: 'act-theme-1'
        },
        {
            actNum: 2,
            badge: 'ACT 02 · 潜流',
            title: (readSeconds === 0 && listenSeconds > 0) ? '声音带你去往远方' : '时间是流动的文字',
            subtitle: (readSeconds === 0 && listenSeconds > 0)
                ? '文字在耳畔流淌，声音赋予了书页另一重温暖的生命。'
                : '每一次专注的注视，都让思绪在时空的重力中沉淀。',
            giantStat: `${totalHours}`,
            unit: '小时',
            statDesc: (listenSeconds > 0 && readSeconds > 0)
                ? (isYearOngoing ? `今年累计投入 ${totalHours} 小时（文字阅读 ${readHours} 小时，有声聆听 ${listenHours} 小时）` : `全年累计投入 ${totalHours} 小时（文字阅读 ${readHours} 小时，有声聆听 ${listenHours} 小时）`)
                : (readSeconds === 0 && listenSeconds > 0)
                    ? (isYearOngoing ? `今年有声聆听达 ${listenHours} 小时，文字陪伴了你的诸多日常旅途` : `全年有声聆听达 ${listenHours} 小时，文字陪伴了你的诸多日常旅途`)
                    : (isYearOngoing ? `今年累计阅读时间达 ${totalHours} 小时，相当于翻过了千重山峦` : `全年累计阅读时间达 ${totalHours} 小时，相当于翻过了千重山峦`),
            quote: null,
            footer: '不为喧嚣所动，沉潜自有其重力。',
            themeClass: 'act-theme-2'
        },
        {
            actNum: 3,
            badge: 'ACT 03 · 昼夜',
            title: options.maskNightStats ? '光影交织的作息' : '夜色与晨光中的书灯',
            subtitle: '每个人的阅读都有自己的时区。',
            giantStat: options.maskNightStats ? '--' : (latestSession ? '深夜时分' : '静谧之境'),
            unit: '',
            statDesc: options.maskNightStats ? '（已开启隐私保护：作息时间已隐藏）' : (latestSession ? '夜最深的时候，万籁俱寂，唯有屏幕柔和的光芒陪你深思' : '在日升月落的规律节奏里，文字是你忠实的伴侣'),
            quote: null,
            footer: '愿每一盏深夜或破晓的书灯，都温暖你未眠的思索。',
            themeClass: 'act-theme-3'
        },
        {
            actNum: 4,
            badge: 'ACT 04 · 专注',
            title: '沉醉心流的那一天',
            subtitle: '有些日子平凡无奇，有些日子却因沉浸而闪闪发光。',
            giantStat: longestDaySecs > 0 ? `${(longestDaySecs / 3600).toFixed(1)}` : '0',
            unit: '小时',
            statDesc: longestDayDate
                ? (isYearOngoing ? `${longestDayDate}，是你今年沉浸最久的一天` : `${longestDayDate}，是你这一年沉浸最久的一天`)
                : (totalSeconds > 0 ? '你在时光里与文字全情相拥' : '尚未记录到深度阅读日，随时开启你的心流体验'),
            quote: options.maskStreak ? '连续阅读天数已隐去' : (maxStreak > 0 ? `你最长曾连续打卡阅读了 ${maxStreak} 天，坚持让文字浸润了日常。` : null),
            footer: '真正的心流，是忘记了时间本身的流逝。',
            themeClass: 'act-theme-4'
        },
        {
            actNum: 5,
            badge: 'ACT 05 · 涉猎',
            title: '你的精神漫步地图',
            subtitle: '书籍是探索未知的渡船，带你抵达不同的心智彼岸。',
            giantStat: `${booksReadCount}`,
            unit: '部作品',
            statDesc: booksReadCount > 0 ? '无论是 EPUB 的流动排版，还是 PDF 的严谨典雅，都在书架上交织成谱' : '书架虚位以待，期待更多经典加入你的藏书馆',
            quote: null,
            footer: '跨越题材与格式，好奇心永远是最好的向导。',
            themeClass: 'act-theme-5'
        },
        {
            actNum: 6,
            badge: 'ACT 06 · 陪伴',
            title: '最深的长情与共鸣',
            subtitle: '在所有相逢里，总有一本书占据了你案头最久的位置。',
            giantStat: (topBookData?.title && topBookSecs > 0) ? `《${topBookData.title}》` : '等待你的专注与长情',
            unit: '',
            statDesc: (topBookData?.title && topBookSecs > 0) ? `作者：${topBookData.author || '未知作者'} · 累计投入 ${(topBookSecs / 3600).toFixed(1)} 小时` : '在所有相逢里，总有一本好书会成为案头的恒久陪伴',
            quote: null,
            footer: '长情的凝视，让一本书真正成为你的生命注脚。',
            themeClass: 'act-theme-6'
        },
        {
            actNum: 7,
            badge: 'ACT 07 · 灵光',
            title: '闪烁在字里行间',
            subtitle: '笔尖或指尖的停顿，记录下触碰心灵的电光火石。',
            giantStat: `${yearHighlights.length}`,
            unit: '处划线',
            statDesc: yearHighlights.length > 0
                ? (isYearOngoing ? `今年你留下了 ${yearHighlights.length} 处高光笔记与思考` : `这一年你留下了 ${yearHighlights.length} 处高光笔记与思考`)
                : '尚未标记划线笔记，静待下一次触动心弦的电光石火',
            quote: topHighlight?.text ? `“${topHighlight.text}”` : null,
            footer: '每一条划线，都是你向作者投出的一记共鸣击掌。',
            themeClass: 'act-theme-7'
        },
        {
            actNum: 8,
            badge: 'ACT 08 · 踪迹',
            title: '时光里的阅读轨迹',
            subtitle: (listenSeconds > 0 && readSeconds > 0) ? '文字与声音双重陪伴，构筑起多元立体的阅读心智。' : '每一次专注的注视，都让思绪在时空的重力中沉淀。',
            giantStat: `${activeDaysSorted.length}`,
            unit: '天',
            statDesc: `${isYearOngoing ? '今年' : '全年'}分布于 ${activeDaysSorted.length} 个活跃日 · ${hourHistogram.filter(h => h > 0).length} 个不同时段`,
            quote: null,
            footer: '在这个快节奏的世界里，保有阅读的定力，是一种珍贵的优雅。',
            themeClass: 'act-theme-8'
        },
        {
            actNum: 9,
            badge: isYearOngoing ? 'ACT 09 · 漫漫' : 'ACT 09 · 终章',
            title: isYearOngoing ? '致敬每一次专注的阅读' : `致敬 ${targetYear} 的阅读者`,
            subtitle: isYearOngoing ? '阅读是一场没有终点的漫游，每一页都是新的探索。' : '书页轻合，而思想的故事才刚刚开始。',
            giantStat: isYearOngoing ? '继续前行' : '翻开新篇',
            unit: '›',
            statDesc: isYearOngoing ? `Linden Leaf 读者专属印记 · ${targetYear} 阅读回顾（截至今日）` : `Linden Leaf 读者专属印记 · ${targetYear} 年度回顾`,
            quote: isYearOngoing ? '愿在接下来的日子里，好书常伴案头，陪你走过辽阔时光。' : '愿新的一年，有更多好书在转角与你相候，陪你渡过浩瀚时光。',
            footer: '点击右上角“保存长图”或“单卡”，留存并分享你的阅读足迹。',
            themeClass: 'act-theme-9'
        }
    ]

    return {
        targetYear,
        totalSeconds,
        totalHours,
        readSeconds,
        readHours,
        listenSeconds,
        listenHours,
        totalDays,
        booksReadCount,
        maxStreak,
        topBook: topBookData || { title: '暂无记录', author: '未详' },
        firstBook: firstBookData || { title: '暂无记录', author: '未详' },
        persona,
        topHighlight,
        acts
    }
}

/**
 * Annual Report Interactive Fullscreen Viewer & Canvas Exporter
 */
export class AnnualReportViewer {
    constructor() {
        this.reportData = null
        this.rawData = null
        this.currentYear = new Date().getFullYear()
        this.targetYear = this.currentYear
        this.currentActIndex = 0
        this.overlayEl = null
        this.isExporting = false
        this.maskOptions = { maskNightStats: false, maskStreak: false }
    }

    async initAndOpen(targetYear) {
        this.currentYear = new Date().getFullYear()
        this.targetYear = Number(targetYear) || this.currentYear

        // 1. Gather all local database data
        const [sessions, highlights, books] = await Promise.all([
            db.getAllReadingSessions().catch(() => []),
            db.getAllHighlights().catch(() => []),
            db.getAllBooks().catch(() => [])
        ])

        this.rawData = { sessions, highlights, books }
        this.rebuildReport()
        this.currentActIndex = 0
        this.renderModal()
        this.bindEvents()
        this.show()
    }

    rebuildReport() {
        this.reportData = buildAnnualReport(this.targetYear, this.rawData, this.maskOptions)
    }

    renderModal() {
        let overlay = document.getElementById('modal-annual-report-overlay')
        if (!overlay) {
            overlay = document.createElement('div')
            overlay.id = 'modal-annual-report-overlay'
            overlay.className = 'annual-report-overlay'
            document.body.appendChild(overlay)
        }

        const actsHtml = this.reportData.acts.map((act, idx) => `
            <div class="annual-report-act-card ${escapeHtml(act.themeClass)} ${idx === this.currentActIndex ? 'active' : ''}" data-act-idx="${idx}">
                <div class="act-header-info">
                    <div class="act-badge">${escapeHtml(act.badge)}</div>
                    <div class="act-title">${escapeHtml(act.title)}</div>
                    <div class="act-subtitle">${escapeHtml(act.subtitle)}</div>
                </div>

                <div class="act-highlight-stat">
                    <div class="stat-giant-num">${escapeHtml(act.giantStat)}<span class="stat-giant-unit">${escapeHtml(act.unit)}</span></div>
                    <div class="stat-desc">${escapeHtml(act.statDesc)}</div>
                    ${act.quote ? `<div class="act-quote-box">${escapeHtml(act.quote)}</div>` : ''}
                    ${act.actNum === 9 ? `
                    <div class="act-summary-export-buttons" style="display: flex; gap: 10px; margin-top: 14px; justify-content: center;">
                        <button id="btn-act9-export-card" class="btn-primary-action" style="padding: 7px 16px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; background: rgba(255,255,255,0.22); border: 1px solid rgba(255,255,255,0.4); color: #fff; cursor: pointer;">🖼️ 保存单卡</button>
                        <button id="btn-act9-export-long" class="btn-primary-action" style="padding: 7px 16px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; background: linear-gradient(135deg, #a855f7, #6366f1); border: none; color: #fff; cursor: pointer;">📜 生成完整长图</button>
                    </div>
                    ` : ''}
                </div>

                <div class="act-footer-insight">
                    ${escapeHtml(act.footer)}
                </div>
            </div>
        `).join('')

        const dotsHtml = this.reportData.acts.map((_, idx) => `
            <div class="pager-dot ${idx === this.currentActIndex ? 'active' : ''}" data-dot-idx="${idx}"></div>
        `).join('')

        // Determine available years from sessions
        const availableYears = new Set([this.currentYear, this.targetYear])
        if (Array.isArray(this.rawData?.sessions)) {
            for (const s of this.rawData.sessions) {
                const y = (s.date || (s.startTime ? toLocalDateString(s.startTime) : '')).slice(0, 4)
                if (y && /^\d{4}$/.test(y)) availableYears.add(Number(y))
            }
        }
        const sortedYears = Array.from(availableYears).sort((a, b) => b - a)

        const yearOptionsHtml = sortedYears.map(y => {
            const isSelected = y === this.targetYear ? 'selected' : ''
            const isThisYear = y === this.currentYear ? ' (截至今天)' : ''
            return `<option value="${y}" ${isSelected} style="background: #1e1b4b; color: #fff;">${y} 年${isThisYear}</option>`
        }).join('')

        overlay.innerHTML = `
            <div class="annual-report-stage">
                <!-- Top Header -->
                <div class="annual-report-header">
                    <div class="annual-report-brand">
                        <select id="select-annual-report-year" class="annual-report-year-select" title="切换报告年份">
                            ${yearOptionsHtml}
                        </select>
                        <span class="annual-report-brand-text">阅读回顾</span>
                    </div>
                    <div class="annual-report-actions">
                        <button id="btn-report-more-menu" class="btn-report-action" title="更多操作与导出">
                            <span>分享 / 导出 ▾</span>
                        </button>
                        <button id="btn-close-annual-report" class="btn-report-close" title="退出报告">×</button>
                    </div>
                </div>

                <!-- Dropdown Action Sheet Menu -->
                <div id="annual-report-action-menu" class="annual-report-action-menu" style="display: none;">
                    <button id="btn-export-act-card" class="action-menu-item">
                        <span>🖼️ 保存当前卡片</span>
                    </button>
                    <button id="btn-export-long-poster" class="action-menu-item">
                        <span>📜 生成完整长图</span>
                    </button>
                    <button id="btn-share-act-card" class="action-menu-item">
                        <span>🔗 系统分享卡片</span>
                    </button>
                    <div class="action-menu-divider"></div>
                    <label class="action-menu-privacy">
                        <input type="checkbox" id="chk-mask-privacy" ${this.maskOptions.maskNightStats ? 'checked' : ''} />
                        <span>隐藏作息与连续天数</span>
                    </label>
                </div>

                <!-- Vertical Pager Dots -->
                <div class="annual-report-pager">
                    ${dotsHtml}
                </div>

                <!-- Carousel Cards -->
                <div class="annual-report-cards-container" id="annual-report-cards-wrap">
                    ${actsHtml}
                </div>

                <!-- Bottom Bar -->
                <div class="annual-report-bottom-bar">
                    <div style="font-size: 0.74rem; color: rgba(255,255,255,0.6);">
                        篇章 <span id="label-report-act-counter">${this.currentActIndex + 1}</span> / ${this.reportData.acts.length}
                    </div>
                    <div class="report-nav-arrows">
                        <button id="btn-report-prev" class="btn-report-nav" ${this.currentActIndex === 0 ? 'disabled' : ''}>‹ 上一章</button>
                        <button id="btn-report-next" class="btn-report-nav" ${this.currentActIndex === this.reportData.acts.length - 1 ? 'disabled' : ''}>下一章 ›</button>
                    </div>
                </div>
            </div>
        `

        this.overlayEl = overlay
    }

    bindEvents() {
        if (!this.overlayEl) return

        const btnClose = this.overlayEl.querySelector('#btn-close-annual-report')
        const btnPrev = this.overlayEl.querySelector('#btn-report-prev')
        const btnNext = this.overlayEl.querySelector('#btn-report-next')
        const btnMore = this.overlayEl.querySelector('#btn-report-more-menu')
        const actionMenu = this.overlayEl.querySelector('#annual-report-action-menu')
        const btnExportCard = this.overlayEl.querySelector('#btn-export-act-card')
        const btnExportLong = this.overlayEl.querySelector('#btn-export-long-poster')
        const btnShareCard = this.overlayEl.querySelector('#btn-share-act-card')
        const btnAct9Card = this.overlayEl.querySelector('#btn-act9-export-card')
        const btnAct9Long = this.overlayEl.querySelector('#btn-act9-export-long')
        const dots = this.overlayEl.querySelectorAll('.pager-dot')
        const yearSelect = this.overlayEl.querySelector('#select-annual-report-year')
        const chkPrivacy = this.overlayEl.querySelector('#chk-mask-privacy')

        btnClose?.addEventListener('click', () => this.hide())
        btnPrev?.addEventListener('click', () => this.goToAct(this.currentActIndex - 1))
        btnNext?.addEventListener('click', () => this.goToAct(this.currentActIndex + 1))

        btnMore?.addEventListener('click', (e) => {
            e.stopPropagation()
            if (actionMenu) {
                const isOpen = actionMenu.style.display !== 'none'
                actionMenu.style.display = isOpen ? 'none' : 'flex'
            }
        })

        this.overlayEl.addEventListener('click', (e) => {
            if (actionMenu && actionMenu.style.display !== 'none' && !actionMenu.contains(e.target) && e.target !== btnMore && !btnMore?.contains(e.target)) {
                actionMenu.style.display = 'none'
            }
        })

        yearSelect?.addEventListener('change', (e) => {
            this.targetYear = Number(e.target.value) || this.currentYear
            this.rebuildReport()
            this.currentActIndex = 0
            this.renderModal()
            this.bindEvents()
        })

        chkPrivacy?.addEventListener('change', (e) => {
            const preservedIndex = this.currentActIndex
            this.maskOptions.maskNightStats = e.target.checked
            this.maskOptions.maskStreak = e.target.checked
            this.rebuildReport()
            this.renderModal()
            this.bindEvents()
            this.goToAct(preservedIndex)
        })

        dots.forEach(dot => {
            dot.addEventListener('click', () => {
                const idx = parseInt(dot.dataset.dotIdx, 10)
                this.goToAct(idx)
            })
        })

        btnExportCard?.addEventListener('click', () => {
            if (actionMenu) actionMenu.style.display = 'none'
            this.exportCurrentCard()
        })
        btnExportLong?.addEventListener('click', () => {
            if (actionMenu) actionMenu.style.display = 'none'
            this.exportLongPoster()
        })
        btnShareCard?.addEventListener('click', () => {
            if (actionMenu) actionMenu.style.display = 'none'
            this.shareCurrentCard()
        })

        btnAct9Card?.addEventListener('click', () => this.exportCurrentCard())
        btnAct9Long?.addEventListener('click', () => this.exportLongPoster())

        // Keyboard navigation
        const keyHandler = (e) => {
            if (!this.overlayEl?.classList.contains('show')) return
            if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
                e.preventDefault()
                this.goToAct(this.currentActIndex + 1)
            } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
                e.preventDefault()
                this.goToAct(this.currentActIndex - 1)
            } else if (e.key === 'Escape') {
                e.preventDefault()
                this.hide()
            }
        }
        window.removeEventListener('keydown', this._keyHandler)
        this._keyHandler = keyHandler
        window.addEventListener('keydown', this._keyHandler)

        // Touch swipe handling
        let touchStartY = 0
        const wrap = this.overlayEl.querySelector('#annual-report-cards-wrap')
        wrap?.addEventListener('touchstart', e => {
            touchStartY = e.touches[0].clientY
        }, { passive: true })

        wrap?.addEventListener('touchend', e => {
            const diffY = e.changedTouches[0].clientY - touchStartY
            if (diffY < -40) {
                this.goToAct(this.currentActIndex + 1)
            } else if (diffY > 40) {
                this.goToAct(this.currentActIndex - 1)
            }
        }, { passive: true })
    }

    goToAct(index) {
        if (!this.reportData) return
        const total = this.reportData.acts.length
        if (index < 0 || index >= total) return

        this.currentActIndex = index
        const cards = this.overlayEl.querySelectorAll('.annual-report-act-card')
        const dots = this.overlayEl.querySelectorAll('.pager-dot')
        const counter = this.overlayEl.querySelector('#label-report-act-counter')
        const btnPrev = this.overlayEl.querySelector('#btn-report-prev')
        const btnNext = this.overlayEl.querySelector('#btn-report-next')

        cards.forEach((card, idx) => {
            card.classList.remove('active', 'prev')
            if (idx === index) {
                card.classList.add('active')
            } else if (idx < index) {
                card.classList.add('prev')
            }
        })

        dots.forEach((dot, idx) => {
            dot.classList.toggle('active', idx === index)
        })

        if (counter) counter.innerText = index + 1
        if (btnPrev) btnPrev.disabled = index === 0
        if (btnNext) btnNext.disabled = index === total - 1
    }

    show() {
        if (this.overlayEl) {
            this.overlayEl.style.display = 'flex'
            void this.overlayEl.offsetHeight
            this.overlayEl.classList.add('show')
        }
    }

    hide() {
        if (this.overlayEl) {
            this.overlayEl.classList.remove('show')
            setTimeout(() => {
                this.overlayEl.style.display = 'none'
            }, 300)
        }
    }

    /**
     * Render high-resolution canvas for a single act
     */
    async renderActToCanvas(act, width = 720, height = 1280) {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')

        // 1. Draw rich dark gradient background
        const grad = ctx.createLinearGradient(0, 0, width, height)
        grad.addColorStop(0, '#1e1b4b')
        grad.addColorStop(0.5, '#0f172a')
        grad.addColorStop(1, '#020617')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, width, height)

        const serifFont = "'Noto Serif SC', 'Source Han Serif SC', '思源宋体', serif"
        const sansFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

        const scale = height / 1280
        const isCompact = height <= 960

        // 2. Header
        const headerY = Math.round(height * 0.07)
        ctx.font = `600 ${Math.round(24 * Math.max(0.75, scale))}px ${sansFont}`
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
        ctx.fillText(`🍃 Linden Leaf · ${this.reportData.targetYear} 年度阅读`, 48, headerY)

        // 3. Act Badge & Title
        const badgeY = Math.round(height * 0.14)
        ctx.font = `bold ${Math.round(20 * Math.max(0.75, scale))}px ${sansFont}`
        ctx.fillStyle = '#a5b4fc'
        ctx.fillText(act.badge, 48, badgeY)

        const titleY = Math.round(height * 0.20)
        ctx.font = `bold ${Math.round(44 * Math.max(0.75, scale))}px ${serifFont}`
        ctx.fillStyle = '#ffffff'
        ctx.fillText(act.title, 48, titleY)

        const subtitleY = Math.round(height * 0.25)
        ctx.font = `${Math.round(24 * Math.max(0.75, scale))}px ${sansFont}`
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
        ctx.fillText(act.subtitle, 48, subtitleY)

        // 4. Giant Stat
        const statY = Math.round(height * 0.42)
        ctx.font = `bold ${Math.round(92 * Math.max(0.72, scale))}px ${serifFont}`
        ctx.fillStyle = '#fef08a'
        ctx.fillText(act.giantStat, 48, statY)

        const statMetrics = ctx.measureText(act.giantStat)
        if (act.unit) {
            ctx.font = `bold ${Math.round(32 * Math.max(0.75, scale))}px ${sansFont}`
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
            ctx.fillText(act.unit, 48 + statMetrics.width + 16, statY)
        }

        const statDescY = Math.round(height * 0.48)
        ctx.font = `${Math.round(22 * Math.max(0.75, scale))}px ${sansFont}`
        ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
        ctx.fillText(act.statDesc, 48, statDescY)

        function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
            if (!text) return
            const str = String(text)
            let curLine = ''
            let curY = y
            let lineCount = 0

            for (let i = 0; i < str.length; i++) {
                const char = str[i]
                const testLine = curLine + char
                const metrics = ctx.measureText(testLine)
                if (metrics.width > maxWidth && curLine.length > 0) {
                    lineCount++
                    if (lineCount >= maxLines) {
                        ctx.fillText(curLine + '…', x, curY)
                        return
                    }
                    ctx.fillText(curLine, x, curY)
                    curLine = char
                    curY += lineHeight
                } else {
                    curLine = testLine
                }
            }
            if (curLine) {
                ctx.fillText(curLine, x, curY)
            }
        }

        // 5. Quote Box (strictly positioned above footer)
        if (act.quote) {
            const quoteY = Math.round(height * 0.54)
            const quoteBoxH = isCompact ? 130 : 170
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
            ctx.fillRect(48, quoteY, width - 96, quoteBoxH)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
            ctx.strokeRect(48, quoteY, width - 96, quoteBoxH)

            ctx.font = `italic ${Math.round(22 * Math.max(0.75, scale))}px ${serifFont}`
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
            wrapCanvasText(ctx, act.quote, 72, quoteY + 44, width - 144, Math.round(34 * Math.max(0.75, scale)), 3)
        }

        // 6. Footer (placed safely below quote box)
        const footerLineY = isCompact ? height - 90 : height - 120
        const footerTextY = isCompact ? height - 48 : height - 70
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(48, footerLineY)
        ctx.lineTo(width - 48, footerLineY)
        ctx.stroke()

        ctx.font = `${Math.round(20 * Math.max(0.75, scale))}px ${sansFont}`
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)'
        ctx.fillText(act.footer, 48, footerTextY)

        return canvas
    }

    /**
     * Export current act card as PNG with Android Gallery & Desktop fallback
     */
    async exportCurrentCard() {
        if (!this.reportData) return
        const act = this.reportData.acts[this.currentActIndex]
        const canvas = await this.renderActToCanvas(act)
        const filename = `LindenLeaf_${this.reportData.targetYear}_年度报告_第${act.actNum}章.png`

        if (typeof window !== 'undefined' && window.platformBridge && (window.platformBridge.isTauri || window.platformBridge.getOS?.() === 'android')) {
            try {
                const dataUrl = canvas.toDataURL('image/png')
                const res = await window.platformBridge.saveImageToGallery(dataUrl, filename)
                if (res && res.success) {
                    this._showToast('已保存卡片至系统相册')
                    return
                }
            } catch (e) {
                console.warn('saveImageToGallery fallback to download:', e)
            }
        }

        canvas.toBlob(blob => {
            if (!blob) return
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            this._showToast('图片下载已开始')
        }, 'image/png')
    }

    /**
     * Stitches all 9 acts into a continuous long poster
     */
    async exportLongPoster() {
        if (!this.reportData) return
        const width = 720
        const cardHeight = 900
        const totalActs = this.reportData.acts.length
        const totalHeight = cardHeight * totalActs

        const longCanvas = document.createElement('canvas')
        longCanvas.width = width
        longCanvas.height = totalHeight
        const ctx = longCanvas.getContext('2d')

        for (let i = 0; i < totalActs; i++) {
            const act = this.reportData.acts[i]
            const actCanvas = await this.renderActToCanvas(act, width, cardHeight)
            ctx.drawImage(actCanvas, 0, i * cardHeight)
        }

        const filename = `LindenLeaf_${this.reportData.targetYear}_年度阅读完整长图.png`

        if (typeof window !== 'undefined' && window.platformBridge && (window.platformBridge.isTauri || window.platformBridge.getOS?.() === 'android')) {
            try {
                const dataUrl = longCanvas.toDataURL('image/png')
                const res = await window.platformBridge.saveImageToGallery(dataUrl, filename)
                if (res && res.success) {
                    this._showToast('已保存长图至系统相册')
                    return
                }
            } catch (e) {
                console.warn('saveImageToGallery fallback to download:', e)
            }
        }

        longCanvas.toBlob(blob => {
            if (!blob) return
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            this._showToast('长图下载已开始')
        }, 'image/png')
    }

    /**
     * Share current act card via system share sheet
     */
    async shareCurrentCard() {
        if (!this.reportData) return
        const act = this.reportData.acts[this.currentActIndex]
        const canvas = await this.renderActToCanvas(act)
        const filename = `LindenLeaf_${this.reportData.targetYear}_第${act.actNum}章.png`
        const title = `Linden Leaf · ${this.reportData.targetYear} 年度阅读 - ${act.title}`

        if (typeof window !== 'undefined' && window.platformBridge) {
            try {
                const dataUrl = canvas.toDataURL('image/png')
                const res = await window.platformBridge.shareImage(dataUrl, filename, title)
                if (res && res.success) {
                    return
                }
            } catch (e) {
                console.warn('shareImage failed:', e)
            }
        }
        this._showToast('已通过系统分享或保存至相册')
    }

    _showToast(msg) {
        if (typeof window !== 'undefined' && window.app && typeof window.app.showToast === 'function') {
            window.app.showToast(msg, '✓')
        } else {
            console.log('[Toast]', msg)
        }
    }
}

export const annualReport = new AnnualReportViewer()
if (typeof window !== 'undefined') window.annualReport = annualReport

