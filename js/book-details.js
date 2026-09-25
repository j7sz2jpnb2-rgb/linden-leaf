// js/book-details.js - Single Book Detail Drawer / Modal for Linden Leaf
// Cleanly organizes reading progress, duration, sessions, notes, tags, and reading status
// without fabricating unverified word counts or reading speeds.

import * as db from './db.js'
import { formatMinutesClean, aggregateSessions, getSessionDurationSeconds } from './stats-heatmap.js'
import { STATUS_LABELS, setReadingStatus, updateBookTags } from './tags-manager.js'
import { regenerateBookCover } from './pdf-cover.js'

function formatDate(ts) {
    if (!ts) return '未知'
    const d = new Date(ts)
    if (isNaN(d.getTime())) return '未知'
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '未知大小'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export class BookDetailsModal {
    constructor() {
        this.currentBookId = null
        this._activeCoverUrl = null
    }

    _revokeCoverUrl() {
        if (this._activeCoverUrl) {
            try {
                URL.revokeObjectURL(this._activeCoverUrl)
            } catch (e) {}
            this._activeCoverUrl = null
        }
    }

    cleanup() {
        this._revokeCoverUrl()
        this.currentBookId = null
    }

    /**
     * Compute reading metrics for a specific book using unified session aggregation
     * @param {string} bookId
     * @returns {Promise<object>}
     */
    async getBookStats(bookId) {
        const book = await db.getBook(bookId)
        if (!book) return null

        const allSessions = (await db.getAllReadingSessions?.()) || []
        const aggregated = aggregateSessions(allSessions, { bookId })
        const bookSessions = allSessions.filter(s => s && s.bookId === bookId && getSessionDurationSeconds(s) > 0)

        const totalSecs = Math.max(book.totalReadingSeconds || 0, aggregated.totalSeconds)
        const notes = (await db.getHighlightsByBook?.(bookId)) || []

        const firstReadAtCandidates = bookSessions
            .map(s => s.startTime || s.timestamp || s.endTime || 0)
            .filter(t => typeof t === 'number' && t > 0)

        const firstReadAt = firstReadAtCandidates.length > 0
            ? Math.min(...firstReadAtCandidates)
            : (book.lastReadAt || null)

        const hasDetailedSessions = aggregated.activeDaysCount > 0 || aggregated.totalSeconds > 0

        return {
            book,
            totalSeconds: totalSecs,
            totalMinutes: Math.round(totalSecs / 60),
            readingDaysCount: aggregated.activeDaysCount,
            peakDay: aggregated.peakDay,
            peakMinutes: aggregated.peakMinutes,
            notesCount: notes.length,
            firstReadAt,
            lastReadAt: book.lastReadAt || null,
            hasDetailedSessions
        }
    }

    /**
     * Render details inside a container element
     * @param {HTMLElement} container
     * @param {string} bookId
     * @param {object} callbacks { onOpenBook, onShelfRefresh }
     */
    async render(container, bookId, callbacks = {}) {
        if (!container || !bookId) return
        this.currentBookId = bookId
        container.innerHTML = '<div class="book-details-loading">正在载入书籍信息...</div>'

        const stats = await this.getBookStats(bookId)
        if (!stats || !stats.book) {
            container.innerHTML = '<div class="book-details-error">书籍不存在或已被移除</div>'
            return
        }

        const b = stats.book
        const progressPct = b.progress?.fraction != null ? Math.round(b.progress.fraction * 100) : 0
        // Respect explicit user reading status; never force finished solely on progress >= 99%
        const currentStatus = b.readingStatus || (b.completedAt ? 'finished' : (b.lastReadAt > 0 || (b.progress?.fraction > 0) ? 'reading' : 'unread'))
        const tags = Array.isArray(b.tags) ? b.tags : []

        this._revokeCoverUrl()
        if (b.coverBlob) {
            try {
                this._activeCoverUrl = URL.createObjectURL(b.coverBlob)
            } catch (e) {
                this._activeCoverUrl = null
            }
        }

        const safeTitle = escapeHTML(b.title || '未知书名')
        const safeAuthor = escapeHTML(b.author || '未知作者')

        container.innerHTML = `
            <div class="book-details-content">
                <header class="book-details-header">
                    <div class="book-details-cover-box" id="details-cover-box">
                        ${this._activeCoverUrl ? `<img class="book-details-cover-img" src="${this._activeCoverUrl}" alt="Cover" />` : `<div class="book-details-cover-fallback"><span>${safeTitle}</span></div>`}
                    </div>
                    <div class="book-details-meta">
                        <h2 class="book-details-title" title="${safeTitle}">${safeTitle}</h2>
                        <div class="book-details-author">${safeAuthor}</div>
                        <div class="book-details-format-badge">${(b.format || 'txt').toUpperCase()} · ${formatFileSize(b.size)}</div>
                        <div class="book-details-status-row">
                            <span class="status-pill status-${currentStatus}">${STATUS_LABELS[currentStatus] || '未读'}</span>
                            ${b.completedAt ? `<span class="completed-date-text">读完于 ${formatDate(b.completedAt)}</span>` : ''}
                        </div>
                    </div>
                </header>

                <div class="book-details-stats-grid">
                    <div class="stat-card">
                        <div class="stat-num">${progressPct}%</div>
                        <div class="stat-desc">阅读进度</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${formatMinutesClean(stats.totalMinutes)}</div>
                        <div class="stat-desc">累计时长</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${stats.readingDaysCount} 天</div>
                        <div class="stat-desc">阅读天数</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${stats.notesCount} 处</div>
                        <div class="stat-desc">划线笔记</div>
                    </div>
                </div>

                <section class="book-details-section">
                    <h3 class="section-title">阅读状态与时间线</h3>
                    <div class="status-selector-group">
                        <button class="status-btn ${currentStatus === 'unread' ? 'active' : ''}" data-status="unread">未读</button>
                        <button class="status-btn ${currentStatus === 'reading' ? 'active' : ''}" data-status="reading">在读</button>
                        <button class="status-btn ${currentStatus === 'on_hold' ? 'active' : ''}" data-status="on_hold">搁置</button>
                        <button class="status-btn ${currentStatus === 'finished' ? 'active' : ''}" data-status="finished">读完</button>
                    </div>
                    <div class="timeline-meta-list">
                        <div class="timeline-row"><span>首次开卷:</span> <strong>${formatDate(stats.firstReadAt)}</strong></div>
                        <div class="timeline-row"><span>最近翻阅:</span> <strong>${formatDate(stats.lastReadAt)}</strong></div>
                        ${stats.peakDay ? `<div class="timeline-row"><span>单日峰值:</span> <strong>${stats.peakDay} (${formatMinutesClean(stats.peakMinutes)})</strong></div>` : (!stats.hasDetailedSessions && stats.totalSeconds > 0 ? `<div class="timeline-row"><span class="text-muted" style="font-size: 0.78rem;">（历史总时长已累计，早期记录无每日明细）</span></div>` : '')}
                    </div>
                </section>

                <section class="book-details-section">
                    <h3 class="section-title">专属标签</h3>
                    <div class="tags-badge-container" id="details-tags-list">
                        ${tags.length ? tags.map(t => {
                            const safeTag = escapeHTML(t)
                            return `<span class="tag-badge">${safeTag} <button class="btn-remove-tag" data-tag="${safeTag}">&times;</button></span>`
                        }).join('') : '<span class="text-muted">暂无标签</span>'}
                    </div>
                    <div class="add-tag-row">
                        <input type="text" class="tag-input" id="input-new-tag" placeholder="输入标签名..." maxlength="20" />
                        <button class="btn-secondary" id="btn-add-tag">添加标签</button>
                    </div>
                </section>

                <footer class="book-details-actions">
                    <button class="btn-primary" id="btn-details-read">开始阅读</button>
                    <button class="btn-secondary" id="btn-details-regen-cover">重新生成封面</button>
                </footer>
            </div>
        `

        // Bind events
        container.querySelectorAll('.status-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const newStatus = btn.dataset.status
                await setReadingStatus(bookId, newStatus)
                await this.render(container, bookId, callbacks)
                callbacks.onShelfRefresh?.()
            })
        })

        const inputTag = container.querySelector('#input-new-tag')
        container.querySelector('#btn-add-tag')?.addEventListener('click', async () => {
            const raw = inputTag?.value?.trim()
            if (raw) {
                const nextTags = [...tags, raw]
                await updateBookTags(bookId, nextTags)
                await this.render(container, bookId, callbacks)
                callbacks.onShelfRefresh?.()
            }
        })

        container.querySelectorAll('.btn-remove-tag').forEach(bTag => {
            bTag.addEventListener('click', async () => {
                const target = bTag.dataset.tag
                const nextTags = tags.filter(t => t !== target)
                await updateBookTags(bookId, nextTags)
                await this.render(container, bookId, callbacks)
                callbacks.onShelfRefresh?.()
            })
        })

        container.querySelector('#btn-details-read')?.addEventListener('click', () => {
            callbacks.onOpenBook?.(bookId)
        })

        container.querySelector('#btn-details-regen-cover')?.addEventListener('click', async () => {
            const res = await regenerateBookCover(bookId)
            if (res.success && res.hasCover) {
                await this.render(container, bookId, callbacks)
                callbacks.onShelfRefresh?.()
            }
        })
    }
}

export const bookDetailsModal = new BookDetailsModal()
