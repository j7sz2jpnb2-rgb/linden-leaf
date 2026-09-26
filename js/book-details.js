// js/book-details.js - Single Book Detail Drawer / Modal for Linden Leaf
// Cleanly organizes reading progress, duration, sessions, notes, tags, and reading status
// without fabricating unverified word counts or reading speeds.

import * as db from './db.js'
import { formatMinutesClean, aggregateSessions, getSessionDurationSeconds } from './stats-heatmap.js'
import { STATUS_LABELS, setReadingStatus, updateBookTags, resolveReadingState } from './tags-manager.js'
import { regenerateBookCover } from './pdf-cover.js'

function renderStarIcons(rating) {
    const stars = []
    for (let i = 1; i <= 5; i++) {
        let fill = 'none'
        let stroke = 'var(--border-color, #cbd5e1)'
        if (rating != null) {
            if (rating >= i) {
                fill = '#f59e0b'
                stroke = '#f59e0b'
            } else if (rating >= i - 0.5) {
                fill = 'url(#half-star-fill)'
                stroke = '#f59e0b'
            }
        }
        stars.push(`
            <svg class="star-svg" data-star-index="${i}" viewBox="0 0 24 24" width="22" height="22" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="${fill}" style="cursor: pointer; transition: transform 0.1s ease;">
                <defs>
                    <linearGradient id="half-star-fill" x1="0" y1="0" x2="100%" y2="0">
                        <stop offset="50%" stop-color="#f59e0b" />
                        <stop offset="50%" stop-color="transparent" />
                    </linearGradient>
                </defs>
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
        `)
    }
    return stars.join('')
}

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
        const currentStatus = resolveReadingState(b)
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
                        <div class="book-details-rating-row" style="margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <div class="book-rating-stars" id="book-rating-stars-control" tabindex="0" role="slider" aria-label="评分" aria-valuemin="0.5" aria-valuemax="5.0" aria-valuenow="${b.rating || 0}" aria-valuetext="${b.rating ? `${b.rating} 分` : '未评分'}" style="display: flex; gap: 3px; align-items: center; outline: none; padding: 2px 4px; border-radius: 4px;">
                                ${renderStarIcons(b.rating)}
                            </div>
                            <span class="rating-score-label" id="rating-score-label" style="font-size: 0.88rem; font-weight: 600; color: ${b.rating != null ? '#f59e0b' : 'var(--text-muted)'};">${b.rating != null ? `${b.rating.toFixed(1)} / 5` : '未评分'}</span>
                            ${b.rating != null ? `<button class="btn-clear-rating" id="btn-clear-rating" title="清除评分" style="padding: 2px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted); cursor: pointer;">清除评分</button>` : ''}
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
                        <button class="status-btn ${currentStatus === 'want_to_read' ? 'active' : ''}" data-status="want_to_read">想读</button>
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
                            return `<span class="tag-badge" data-tag="${safeTag}" style="display: inline-flex; align-items: center; gap: 4px;"><span class="tag-badge-text" style="cursor: pointer;" title="查看包含此标签的图书">${safeTag}</span><button class="btn-remove-tag" data-tag="${safeTag}" title="删除标签" style="background: none; border: none; cursor: pointer; color: inherit; font-size: 1rem; line-height: 1; padding: 0 2px;">&times;</button></span>`
                        }).join('') : '<span class="text-muted">暂无标签</span>'}
                    </div>
                    <div class="add-tag-row">
                        <input type="text" class="tag-input" id="input-new-tag" placeholder="输入标签名..." maxlength="24" />
                        <button class="btn-secondary" id="btn-add-tag">添加标签</button>
                    </div>
                </section>

                <footer class="book-details-actions">
                    <button class="btn-primary" id="btn-details-read">开始阅读</button>
                    <button class="btn-secondary" id="btn-details-manage-lists" title="将此书加入或移出自定义书单">加入书单</button>
                    <button class="btn-secondary" id="btn-details-regen-cover">重新生成封面</button>
                    <button class="btn-danger" id="btn-details-delete" title="从书架中移除此书">移出书架</button>
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

        // Star Rating events
        const starsControl = container.querySelector('#book-rating-stars-control')
        const scoreLabel = container.querySelector('#rating-score-label')

        if (starsControl) {
            starsControl.addEventListener('mousemove', (e) => {
                const svg = e.target.closest('.star-svg')
                if (!svg) return
                const starIndex = parseInt(svg.dataset.starIndex, 10)
                const rect = svg.getBoundingClientRect()
                const isLeft = (e.clientX - rect.left) < rect.width / 2
                const previewVal = isLeft ? starIndex - 0.5 : starIndex
                starsControl.innerHTML = renderStarIcons(previewVal)
                if (scoreLabel) {
                    scoreLabel.innerText = `${previewVal.toFixed(1)} / 5`
                    scoreLabel.style.color = '#f59e0b'
                }
            })

            starsControl.addEventListener('mouseleave', () => {
                starsControl.innerHTML = renderStarIcons(b.rating)
                if (scoreLabel) {
                    scoreLabel.innerText = b.rating != null ? `${b.rating.toFixed(1)} / 5` : '未评分'
                    scoreLabel.style.color = b.rating != null ? '#f59e0b' : 'var(--text-muted)'
                }
            })

            starsControl.addEventListener('click', async (e) => {
                const svg = e.target.closest('.star-svg')
                if (!svg) return
                e.stopPropagation()
                const starIndex = parseInt(svg.dataset.starIndex, 10)
                const rect = svg.getBoundingClientRect()
                const isLeft = (e.clientX - rect.left) < rect.width / 2
                const newRating = isLeft ? starIndex - 0.5 : starIndex
                try {
                    await db.saveBookRating(bookId, newRating)
                    await this.render(container, bookId, callbacks)
                    callbacks.onShelfRefresh?.()
                } catch (err) {
                    if (scoreLabel) {
                        scoreLabel.innerText = '保存失败'
                        scoreLabel.style.color = '#ef4444'
                    }
                }
            })

            starsControl.addEventListener('keydown', async (e) => {
                let nextRating = undefined
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    const curr = b.rating != null ? b.rating : 0
                    nextRating = Math.min(5.0, curr + 0.5)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    if (b.rating != null) {
                        nextRating = b.rating <= 0.5 ? null : b.rating - 0.5
                    }
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault()
                    nextRating = null
                }

                if (nextRating !== undefined) {
                    try {
                        await db.saveBookRating(bookId, nextRating)
                        await this.render(container, bookId, callbacks)
                        callbacks.onShelfRefresh?.()
                    } catch (err) {
                        if (scoreLabel) {
                            scoreLabel.innerText = '保存失败'
                            scoreLabel.style.color = '#ef4444'
                        }
                    }
                }
            })
        }

        container.querySelector('#btn-clear-rating')?.addEventListener('click', async (e) => {
            e.stopPropagation()
            try {
                await db.saveBookRating(bookId, null)
                await this.render(container, bookId, callbacks)
                callbacks.onShelfRefresh?.()
            } catch (err) {
                if (scoreLabel) {
                    scoreLabel.innerText = '清除失败'
                    scoreLabel.style.color = '#ef4444'
                }
            }
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

        container.querySelectorAll('.tag-badge-text').forEach(tEl => {
            tEl.addEventListener('click', (e) => {
                e.stopPropagation()
                const targetTag = tEl.closest('.tag-badge')?.dataset.tag
                if (targetTag) {
                    callbacks.onFilterByTag?.(targetTag)
                }
            })
        })

        container.querySelectorAll('.btn-remove-tag').forEach(bTag => {
            bTag.addEventListener('click', async (e) => {
                e.stopPropagation()
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

        container.querySelector('#btn-details-manage-lists')?.addEventListener('click', () => {
            callbacks.onManageLists?.(bookId)
        })

        container.querySelector('#btn-details-delete')?.addEventListener('click', () => {
            callbacks.onDeleteBook?.(bookId)
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
