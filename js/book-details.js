// js/book-details.js - Single Book Detail Drawer / Modal for Linden Leaf
// Cleanly organizes reading progress, duration, sessions, notes, tags, and reading status
// without fabricating unverified word counts or reading speeds.

import * as db from './db.js'
import { setReadingStatus, updateBookTags, resolveReadingState } from './tags-manager.js'
import { regenerateBookCover, normalizeCoverBlob } from './pdf-cover.js'
import { escapeHTML, renderEditorialCoverHTML } from './ui-format.js'
import { t } from './i18n.js'

const STATUS_I18N_KEYS = {
    unread: 'status.unread',
    want_to_read: 'status.wantToRead',
    reading: 'status.reading',
    on_hold: 'status.onHold',
    finished: 'status.finished',
}
function getLocalizedStatusLabel(status) {
    return t(STATUS_I18N_KEYS[status] || 'status.unread')
}

export { escapeHTML }

function renderStarIcons(rating) {
    const stars = []
    for (let i = 1; i <= 5; i++) {
        let fill = 'none'
        let stroke = 'var(--border-color, #d6d1c6)'
        if (rating != null) {
            if (rating >= i) {
                fill = 'var(--brand-terracotta, #da7756)'
                stroke = 'var(--brand-terracotta, #da7756)'
            } else if (rating >= i - 0.5) {
                fill = 'url(#half-star-fill)'
                stroke = 'var(--brand-terracotta, #da7756)'
            }
        }
        stars.push(`
            <svg class="star-svg" data-star-index="${i}" viewBox="0 0 24 24" width="20" height="20" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="${fill}" style="cursor: pointer; transition: transform 0.1s ease;">
                <defs>
                    <linearGradient id="half-star-fill" x1="0" y1="0" x2="100%" y2="0">
                        <stop offset="50%" stop-color="var(--brand-terracotta, #da7756)" />
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
    if (!ts) return t('bookDetails.unknownDate')
    const d = new Date(ts)
    if (isNaN(d.getTime())) return t('bookDetails.unknownDate')
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return t('bookDetails.unknownSize')
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

    /**
     * Compute reading metrics for a specific book using unified session aggregation
     * @param {string} bookId
     * @returns {Promise<object>}
     */
    async getBookStats(bookId) {
        const book = await db.getBook(bookId)
        if (!book) return null

        const allSessions = (await db.getAllReadingSessions?.()) || []
        const { aggregateSessions, getSessionDurationSeconds } = await import('./stats-heatmap.js')
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
        this._renderGeneration = (this._renderGeneration || 0) + 1
        const gen = this._renderGeneration
        if (this.currentBookId !== bookId) this.mobileDetailsTab = 'reading'
        this.currentBookId = bookId
        this.currentContainer = container
        container.innerHTML = `<div class="book-details-loading">${escapeHTML(t('bookDetails.loading'))}</div>`

        const stats = await this.getBookStats(bookId)
        if (this._renderGeneration !== gen || this.currentBookId !== bookId || this.currentContainer !== container) {
            return
        }
        if (!stats || !stats.book) {
            container.innerHTML = `<div class="book-details-error">${escapeHTML(t('bookDetails.notFound'))}</div>`
            return
        }

        const { formatMinutesClean } = await import('./stats-heatmap.js')
        const b = stats.book
        const hasFraction = typeof b.progress?.fraction === 'number' && !Number.isNaN(b.progress.fraction)
        const hasPct = typeof b.progressPercentage === 'number' && !Number.isNaN(b.progressPercentage) && b.progressPercentage > 0
        const progressDisplay = hasFraction
            ? `${Math.round(b.progress.fraction * 100)}%`
            : (hasPct ? `${Math.round(b.progressPercentage)}%` : ((stats.totalSeconds > 0 || stats.hasDetailedSessions) ? '—' : '0%'))
        // Respect explicit user reading status; never force finished solely on progress >= 99%
        const currentStatus = resolveReadingState(b)
        const tags = Array.isArray(b.tags) ? b.tags : []
        const isArchived = !!b.isArchived
        const hasLocalFile = !b.isCloudOnly && b.hasLocalFile !== false

        this._revokeCoverUrl()
        if (b.coverBlob) {
            try {
                this._activeCoverUrl = URL.createObjectURL(b.coverBlob)
            } catch (e) {
                this._activeCoverUrl = null
            }
        }

        const safeTitle = escapeHTML(b.title || t('book.untitled'))
        const safeAuthor = escapeHTML(b.author || t('book.unknownAuthor'))

        container.innerHTML = `
            <div class="book-details-content" data-details-view="${this.mobileDetailsTab || 'reading'}">
                <header class="book-details-header">
                    <div class="book-details-cover-box" id="details-cover-box">
                        ${this._activeCoverUrl ? `<img class="book-details-cover-img" src="${escapeHTML(this._activeCoverUrl)}" alt="Cover" />` : renderEditorialCoverHTML(b, { displayTitle: b.title || t('book.untitled') })}
                        <span class="book-details-cover-edit-hint" aria-hidden="true">${escapeHTML(t('bookDetails.changeCoverBtn'))}</span>
                    </div>
                    <div class="book-details-meta">
                        <h2 class="book-details-title" title="${safeTitle}">${safeTitle}</h2>
                        <div class="book-details-author">${safeAuthor}</div>
                        <div class="book-details-format-badge">${(b.format || 'txt').toUpperCase()} · ${formatFileSize(b.size)}${b.completedAt ? ` · ${escapeHTML(t('bookDetails.completedOn', { date: formatDate(b.completedAt) }))}` : ''}</div>
                        <div class="book-details-rating-row">
                            <div class="book-rating-stars" id="book-rating-stars-control" tabindex="0" role="slider" aria-label="${escapeHTML(t('bookDetails.ratingAria'))}" aria-valuemin="0.5" aria-valuemax="5.0" aria-valuenow="${b.rating || 0}" aria-valuetext="${b.rating ? escapeHTML(t('bookDetails.ratingValue', { rating: b.rating })) : escapeHTML(t('bookDetails.ratingUnrated'))}">
                                ${renderStarIcons(b.rating)}
                            </div>
                            <span class="rating-score-label" id="rating-score-label">${b.rating != null ? `${b.rating.toFixed(1)} / 5` : escapeHTML(t('bookDetails.ratingUnrated'))}</span>
                            ${b.rating != null ? `<button type="button" class="btn-clear-rating" id="btn-clear-rating" title="${escapeHTML(t('bookDetails.clearRating'))}">${escapeHTML(t('bookDetails.clearRatingShort'))}</button>` : ''}
                        </div>
                    </div>
                </header>

                <nav class="book-details-mobile-tabs" aria-label="${escapeHTML(t('bookDetails.mobileTabsAria'))}">
                    <button type="button" data-details-tab="reading" class="${this.mobileDetailsTab !== 'info' ? 'active' : ''}" aria-pressed="${this.mobileDetailsTab !== 'info'}">${escapeHTML(t('bookDetails.tabReading'))}</button>
                    <button type="button" data-details-tab="info" class="${this.mobileDetailsTab === 'info' ? 'active' : ''}" aria-pressed="${this.mobileDetailsTab === 'info'}">${escapeHTML(t('bookDetails.tabInfo'))}</button>
                </nav>
                <div class="book-details-stats-grid">
                    <div class="stat-card">
                        <div class="stat-num">${progressDisplay}</div>
                        <div class="stat-desc">${escapeHTML(t('bookDetails.statProgress'))}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${formatMinutesClean(stats.totalMinutes)}</div>
                        <div class="stat-desc">${escapeHTML(t('bookDetails.statTotalTime'))}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${escapeHTML(t('bookDetails.statDaysValue', { count: stats.readingDaysCount }))}</div>
                        <div class="stat-desc">${escapeHTML(t('bookDetails.statDays'))}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-num">${escapeHTML(t('bookDetails.statNotesValue', { count: stats.notesCount }))}</div>
                        <div class="stat-desc">${escapeHTML(t('bookDetails.statNotes'))}</div>
                    </div>
                </div>

                <section class="book-details-section book-details-reading">
                    <div class="book-details-group">
                        <h3 class="section-title">${escapeHTML(t('bookDetails.statusTitle'))}</h3>
                        <div class="status-selector-group">
                            <button type="button" class="status-btn ${currentStatus === 'unread' ? 'active' : ''}" data-status="unread">${escapeHTML(t('status.unread'))}</button>
                            <button type="button" class="status-btn ${currentStatus === 'want_to_read' ? 'active' : ''}" data-status="want_to_read">${escapeHTML(t('status.wantToRead'))}</button>
                            <button type="button" class="status-btn ${currentStatus === 'reading' ? 'active' : ''}" data-status="reading">${escapeHTML(t('status.reading'))}</button>
                            <button type="button" class="status-btn ${currentStatus === 'on_hold' ? 'active' : ''}" data-status="on_hold">${escapeHTML(t('status.onHold'))}</button>
                            <button type="button" class="status-btn ${currentStatus === 'finished' ? 'active' : ''}" data-status="finished">${escapeHTML(t('status.finished'))}</button>
                        </div>
                    </div>
                    <div class="book-details-group book-details-records-group">
                        <h3 class="section-title">${escapeHTML(t('bookDetails.recordsTitle'))}</h3>
                        <div class="timeline-meta-list">
                            <div class="timeline-row"><span>${escapeHTML(t('bookDetails.firstRead'))}</span> <strong>${formatDate(stats.firstReadAt)}</strong></div>
                            <div class="timeline-row"><span>${escapeHTML(t('bookDetails.lastRead'))}</span> <strong>${formatDate(stats.lastReadAt)}</strong></div>
                            ${stats.peakDay ? `<div class="timeline-row"><span>${escapeHTML(t('bookDetails.peakDay'))}</span> <strong>${stats.peakDay} (${formatMinutesClean(stats.peakMinutes)})</strong></div>` : (!stats.hasDetailedSessions && stats.totalSeconds > 0 ? `<div class="timeline-row"><span class="text-muted" style="font-size: 0.78rem;">${escapeHTML(t('bookDetails.legacyTotalHint'))}</span></div>` : '')}
                        </div>
                    </div>
                </section>

                <section class="book-details-section book-details-tags">
                    <h3 class="section-title">${escapeHTML(t('bookDetails.tagsTitle'))}</h3>
                    <div class="tags-badge-container" id="details-tags-list">
                        ${tags.length ? tags.map(tag => {
                            const safeTag = escapeHTML(tag)
                            return `<span class="tag-badge" data-tag="${safeTag}"><span class="tag-badge-text" style="cursor: pointer;" title="${escapeHTML(t('bookDetails.filterByTagTitle'))}">${safeTag}</span><button type="button" class="btn-remove-tag" data-tag="${safeTag}" title="${escapeHTML(t('bookDetails.removeTagTitle'))}">&times;</button></span>`
                        }).join('') : `<span class="text-muted" style="font-size: 0.8rem;">${escapeHTML(t('bookDetails.noTags'))}</span>`}
                        <button type="button" class="btn-inline-add-tag" id="btn-reveal-add-tag">${escapeHTML(t('bookDetails.addTagInlineBtn'))}</button>
                    </div>
                    <div class="add-tag-row" id="details-add-tag-row" hidden>
                        <input type="text" class="tag-input" id="input-new-tag" placeholder="${escapeHTML(t('bookDetails.tagPlaceholder'))}" maxlength="24" />
                        <button type="button" class="btn-secondary-action" id="btn-add-tag">${escapeHTML(t('bookDetails.addTagBtn'))}</button>
                    </div>
                </section>

                <footer class="book-details-actions">
                    <button type="button" class="btn-primary-action" id="btn-details-read">${escapeHTML(t('bookDetails.readBtn'))}</button>
                    <button type="button" class="btn-secondary-action" id="btn-details-read-new-window" title="${escapeHTML(t('bookDetails.readNewWindowTitle'))}">${escapeHTML(t('bookDetails.readNewWindowBtn'))}</button>
                    <div class="book-details-more-wrap">
                        <button type="button" class="btn-secondary-action btn-details-more" id="btn-details-more-actions" aria-haspopup="menu" aria-expanded="false" title="${escapeHTML(t('bookDetails.moreActionsAria'))}" aria-label="${escapeHTML(t('bookDetails.moreActionsAria'))}">···</button>
                        <div class="overview-popover-panel book-details-more-menu" id="book-details-more-menu" role="menu" hidden>
                            <button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-peek" title="${escapeHTML(t('bookshelf.actionPeekTitle'))}">${escapeHTML(t('bookshelf.actionPeek'))}</button>
                            <button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-manage-lists" title="${escapeHTML(t('bookDetails.manageListsTitle'))}">${escapeHTML(t('bookDetails.manageListsBtn'))}</button>
                            <button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-change-cover" title="${escapeHTML(t('bookDetails.changeCoverTitle'))}">${escapeHTML(t('bookDetails.changeCoverBtn'))}</button>
                            <button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-reset-cover" title="${escapeHTML(t('bookDetails.resetCoverTitle'))}">${escapeHTML(t('bookDetails.resetCoverBtn'))}</button>
                            <button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-toggle-archive" title="${escapeHTML(isArchived ? t('bookDetails.unarchiveTitle') : t('bookDetails.archiveTitle'))}">${escapeHTML(isArchived ? t('bookDetails.unarchiveBtn') : t('bookDetails.archiveBtn'))}</button>
                            ${hasLocalFile ? `<button type="button" class="book-details-menu-item" role="menuitem" id="btn-details-remove-local-file" title="${escapeHTML(t('bookDetails.removeLocalFileTitle'))}">${escapeHTML(t('bookDetails.removeLocalFileBtn'))}</button>` : ''}
                            <div class="book-details-menu-sep" aria-hidden="true"></div>
                            <button type="button" class="book-details-menu-item is-danger" role="menuitem" id="btn-details-delete" title="${escapeHTML(t('bookDetails.deleteTitle'))}">${escapeHTML(t('bookDetails.deleteBtn'))}</button>
                        </div>
                    </div>
                    <input type="file" id="input-details-custom-cover" accept="image/png,image/jpeg,image/webp,image/avif" style="display: none;" />
                </footer>
            </div>
        `

        container.querySelectorAll('[data-details-tab]').forEach(button => {
            button.addEventListener('click', () => {
                this.mobileDetailsTab = button.dataset.detailsTab
                container.querySelector('.book-details-content').dataset.detailsView = this.mobileDetailsTab
                container.querySelectorAll('[data-details-tab]').forEach(tab => {
                    const selected = tab === button
                    tab.classList.toggle('active', selected)
                    tab.setAttribute('aria-pressed', String(selected))
                })
            })
        })
        // Bind events
        container.querySelectorAll('.status-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const newStatus = btn.dataset.status
                await setReadingStatus(bookId, newStatus)
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
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
                    scoreLabel.style.color = 'var(--brand-terracotta-text, #b34d2b)'
                }
            })

            starsControl.addEventListener('mouseleave', () => {
                starsControl.innerHTML = renderStarIcons(b.rating)
                if (scoreLabel) {
                    scoreLabel.innerText = b.rating != null ? `${b.rating.toFixed(1)} / 5` : t('bookDetails.ratingUnrated')
                    scoreLabel.style.color = b.rating != null ? 'var(--brand-terracotta-text, #b34d2b)' : 'var(--text-muted)'
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
                    if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                        await this.render(container, bookId, callbacks)
                    }
                    callbacks.onShelfRefresh?.()
                } catch (err) {
                    if (scoreLabel) {
                        scoreLabel.innerText = t('bookDetails.ratingSaveFailed')
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
                        if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                            await this.render(container, bookId, callbacks)
                        }
                        callbacks.onShelfRefresh?.()
                    } catch (err) {
                        if (scoreLabel) {
                            scoreLabel.innerText = t('bookDetails.ratingSaveFailed')
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
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
                callbacks.onShelfRefresh?.()
            } catch (err) {
                if (scoreLabel) {
                    scoreLabel.innerText = t('bookDetails.ratingClearFailed')
                    scoreLabel.style.color = '#ef4444'
                }
            }
        })

        const inputTag = container.querySelector('#input-new-tag')
        const addTagRow = container.querySelector('#details-add-tag-row')
        const submitNewTag = async () => {
            const raw = inputTag?.value?.trim()
            if (raw) {
                const nextTags = [...tags, raw]
                await updateBookTags(bookId, nextTags)
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
                callbacks.onShelfRefresh?.()
            }
        }
        container.querySelector('#btn-reveal-add-tag')?.addEventListener('click', () => {
            if (addTagRow) addTagRow.hidden = !addTagRow.hidden
            if (addTagRow && !addTagRow.hidden) inputTag?.focus()
        })
        container.querySelector('#btn-add-tag')?.addEventListener('click', submitNewTag)
        inputTag?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                submitNewTag()
            }
        })

        const moreBtn = container.querySelector('#btn-details-more-actions')
        const moreMenu = container.querySelector('#book-details-more-menu')
        const closeMoreMenu = () => {
            if (moreMenu) moreMenu.hidden = true
            moreBtn?.setAttribute('aria-expanded', 'false')
        }
        moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation()
            if (!moreMenu) return
            const opening = moreMenu.hidden
            moreMenu.hidden = !opening
            moreBtn.setAttribute('aria-expanded', opening ? 'true' : 'false')
        })
        container.addEventListener?.('click', (e) => {
            if (!e.target?.closest?.('.book-details-more-wrap')) closeMoreMenu()
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
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
                callbacks.onShelfRefresh?.()
            })
        })

        container.querySelector('#btn-details-read')?.addEventListener('click', () => {
            callbacks.onOpenBook?.(bookId)
        })
        container.querySelector('#btn-details-peek')?.addEventListener('click', () => {
            closeMoreMenu()
            callbacks.onPeekBook?.(bookId)
        })
        container.querySelector('#btn-details-read-new-window')?.addEventListener('click', () => {
            callbacks.onOpenBookNewWindow?.(bookId)
        })

        container.querySelector('#btn-details-manage-lists')?.addEventListener('click', () => {
            closeMoreMenu()
            callbacks.onManageLists?.(bookId)
        })

        container.querySelector('#btn-details-toggle-archive')?.addEventListener('click', async () => {
            closeMoreMenu()
            await callbacks.onToggleArchive?.(bookId)
            if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                await this.render(container, bookId, callbacks)
            }
        })

        container.querySelector('#btn-details-remove-local-file')?.addEventListener('click', async () => {
            closeMoreMenu()
            await callbacks.onRemoveLocalFile?.(bookId)
            if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                await this.render(container, bookId, callbacks)
            }
        })

        container.querySelector('#btn-details-delete')?.addEventListener('click', () => {
            closeMoreMenu()
            callbacks.onDeleteBook?.(bookId)
        })

        const fileInput = container.querySelector('#input-details-custom-cover')
        const changeCoverBtn = container.querySelector('#btn-details-change-cover')
        const coverBox = container.querySelector('#details-cover-box')

        if (coverBox) {
            coverBox.style.cursor = 'pointer'
            coverBox.title = t('bookDetails.coverUploadHint')
            coverBox.addEventListener('click', () => fileInput?.click())
        }

        changeCoverBtn?.addEventListener('click', () => {
            closeMoreMenu()
            fileInput?.click()
        })

        const resetCoverBtn = container.querySelector('#btn-details-reset-cover')
        const doRestoreDefaultCover = async () => {
            closeMoreMenu()
            const res = await regenerateBookCover(bookId)
            if (res.success && res.hasCover) {
                window.coverUrlPool?.revoke?.(bookId)
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
                callbacks.onShelfRefresh?.()
                window.app?.showToast?.(t('bookDetails.coverRestored'), 'success')
            } else {
                window.app?.showToast?.(t('bookDetails.coverResetDefault'), 'info')
            }
        }
        resetCoverBtn?.addEventListener('click', doRestoreDefaultCover)

        // Also support contextmenu (right-click / long-press) to restore document original cover
        changeCoverBtn?.addEventListener('contextmenu', async (e) => {
            e.preventDefault()
            await doRestoreDefaultCover()
        })

        fileInput?.addEventListener('change', async (e) => {
            const rawFile = e.target.files?.[0]
            if (!rawFile) return
            const isImageMime = rawFile.type && rawFile.type.startsWith('image/')
            const isImageExt = /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(rawFile.name || '')
            if (!isImageMime && !isImageExt) {
                e.target.value = ''
                window.app?.showToast?.(t('bookDetails.coverPickImage'), 'warning')
                return
            }
            if (rawFile.size > 15 * 1024 * 1024) {
                e.target.value = ''
                window.app?.showToast?.(t('bookDetails.coverTooLarge'), 'warning')
                return
            }
            try {
                let file = rawFile
                if (typeof rawFile.arrayBuffer === 'function') {
                    const buf = await rawFile.arrayBuffer()
                    const inferredMime = isImageMime ? rawFile.type : (
                        /\.png$/i.test(rawFile.name) ? 'image/png' :
                        /\.webp$/i.test(rawFile.name) ? 'image/webp' :
                        /\.avif$/i.test(rawFile.name) ? 'image/avif' : 'image/jpeg'
                    )
                    file = new Blob([buf], { type: inferredMime })
                }
                const optimizedFile = (await normalizeCoverBlob(file)) || file
                await db.saveBook({ id: bookId, coverBlob: optimizedFile })
                window.coverUrlPool?.revoke?.(bookId)
                if (this._renderGeneration === gen && this.currentBookId === bookId && this.currentContainer === container) {
                    await this.render(container, bookId, callbacks)
                }
                callbacks.onShelfRefresh?.()
                window.app?.showToast?.(t('bookDetails.coverUpdated'), 'success')
            } catch (err) {
                console.error('[book-details] Failed to update custom cover:', err)
                window.app?.showToast?.(t('bookDetails.coverUpdateFailed', { detail: err.message || String(err) }), 'error')
            } finally {
                e.target.value = ''
            }
        })
    }

    cleanup() {
        this._renderGeneration = (this._renderGeneration || 0) + 1
        this.currentBookId = null
        this.currentContainer = null
        this._revokeCoverUrl()
    }

    close() {
        this.cleanup()
    }
}

export const bookDetailsModal = new BookDetailsModal()
