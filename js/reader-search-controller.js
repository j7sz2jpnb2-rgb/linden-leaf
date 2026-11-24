import { DomEvents } from './dom-events.js'
import * as db from './db.js'
import { platformBridge } from './platformBridge.js'
import { fullTextSearchEngine } from './fulltext-search.js'
import { escapeHTML } from './ui-format.js'
import { t } from './i18n.js'

/** Owns search UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class ReaderSearchController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this.currentSearchResults = []
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
    }

    initDOM() {
        this.dom = {
            searchQueryInput: document.getElementById('search-query-input'),
            btnClearSearchInput: document.getElementById('btn-clear-search-input'),
            btnExecSearch: document.getElementById('btn-exec-search'),
            btnClearSearchHighlights: document.getElementById('btn-clear-search-highlights'),
            searchResultsContainer: document.getElementById('search-results-container'),
            readerSearchBar: document.getElementById('reader-search-bar'),
            searchBarTitle: document.getElementById('search-bar-title'),
            btnSearchBarPrev: document.getElementById('btn-search-bar-prev'),
            btnSearchBarNext: document.getElementById('btn-search-bar-next'),
            btnSearchBarClose: document.getElementById('btn-search-bar-close'),
            modalCrossSearch: document.getElementById('modal-cross-book-search'),
            btnCloseCrossSearch: document.getElementById('btn-close-cross-search'),
            btnBackCrossSearchMob: document.getElementById('btn-back-cross-search-mob'),
            btnOpenCrossSearch: document.getElementById('btn-open-cross-search'),
            crossSearchForm: document.getElementById('cross-search-form'),
            inputCrossSearch: document.getElementById('input-cross-search'),
            btnClearCrossSearchInput: document.getElementById('btn-clear-cross-search-input'),
            btnExecCrossSearch: document.getElementById('btn-exec-cross-search'),
            crossSearchResults: document.getElementById('cross-search-results'),
            crossSearchStatus: document.getElementById('cross-search-status'),
            btnCrossSearchSkipped: document.getElementById('btn-cross-search-skipped'),
            crossSearchSkippedPanel: document.getElementById('cross-search-skipped-panel')
        }
    }

    _syncCrossSearchClearBtn() {
        const hasVal = Boolean(this.dom.inputCrossSearch?.value)
        if (this.dom.btnClearCrossSearchInput) {
            this.dom.btnClearCrossSearchInput.hidden = !hasVal
        }
    }

    _resetSkippedBooks() {
        if (this.dom.btnCrossSearchSkipped) {
            this.dom.btnCrossSearchSkipped.hidden = true
            this.dom.btnCrossSearchSkipped.setAttribute('aria-expanded', 'false')
        }
        if (this.dom.crossSearchSkippedPanel) {
            this.dom.crossSearchSkippedPanel.hidden = true
            this.dom.crossSearchSkippedPanel.innerHTML = ''
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(this.dom.btnExecSearch, 'click', () => this.executeSearch());
        this.events.on(this.dom.searchQueryInput, 'keydown', e => {
            if (e.key === 'Enter') this.executeSearch()
        });
        this.events.on(this.dom.searchQueryInput, 'input', e => {
            if (this.dom.btnClearSearchInput) {
                this.dom.btnClearSearchInput.style.display = e.target.value.trim() ? 'block' : 'none'
            }
        });
        this.events.on(this.dom.btnClearSearchInput, 'click', () => {
            if (this.dom.searchQueryInput) this.dom.searchQueryInput.value = ''
            if (this.dom.btnClearSearchInput) this.dom.btnClearSearchInput.style.display = 'none'
            this.clearSearchState(true)
        });
        this.events.on(this.dom.btnClearSearchHighlights, 'click', () => {
            this.clearSearchState(true)
        });
        this.events.on(this.dom.btnSearchBarPrev, 'click', () => this.navigateSearchMatch(-1));
        this.events.on(this.dom.btnSearchBarNext, 'click', () => this.navigateSearchMatch(1));
        this.events.on(this.dom.btnSearchBarClose, 'click', () => this.clearSearchState(false));
        this.events.on(this.app.annotations.dom.btnExportNotes, 'click', () => this.app.annotations.exportNotesToMarkdown());
        this.events.on(this.dom.btnOpenCrossSearch, 'click', () => this.openCrossSearchModal());
        this.events.on(this.dom.btnCloseCrossSearch, 'click', () => this.closeCrossSearchModal());
        this.events.on(this.dom.btnBackCrossSearchMob, 'click', () => this.closeCrossSearchModal());
        this.events.on(this.dom.modalCrossSearch, 'click', e => {
            if (e.target === this.dom.modalCrossSearch) this.closeCrossSearchModal()
        });
        if (this.dom.crossSearchForm) {
            this.events.on(this.dom.crossSearchForm, 'submit', e => {
                e.preventDefault()
                this.executeCrossSearch(this.dom.inputCrossSearch?.value)
            })
        } else {
            this.events.on(this.dom.btnExecCrossSearch, 'click', () => {
                this.executeCrossSearch(this.dom.inputCrossSearch?.value)
            });
            this.events.on(this.dom.inputCrossSearch, 'keydown', e => {
                if (e.key === 'Enter') {
                    this.executeCrossSearch(this.dom.inputCrossSearch?.value)
                }
            });
        }
        this.events.on(this.dom.inputCrossSearch, 'input', () => this._syncCrossSearchClearBtn());
        this.events.on(this.dom.btnClearCrossSearchInput, 'click', () => {
            this._searchQueryGeneration = (this._searchQueryGeneration || 0) + 1
            if (this._crossSearchAbortController) {
                this._crossSearchAbortController.abort()
                this._crossSearchAbortController = null
            }
            if (this.dom.inputCrossSearch) this.dom.inputCrossSearch.value = ''
            this._syncCrossSearchClearBtn()
            this._resetSkippedBooks()
            if (this.dom.crossSearchResults) this.dom.crossSearchResults.innerHTML = ''
            if (this.dom.crossSearchStatus) this.dom.crossSearchStatus.innerText = t('modal.crossSearchHint')
            this.dom.inputCrossSearch?.focus()
        });
        this.events.on(this.dom.btnCrossSearchSkipped, 'click', () => {
            const panel = this.dom.crossSearchSkippedPanel
            const btn = this.dom.btnCrossSearchSkipped
            if (!panel || !btn) return
            const opening = panel.hidden
            panel.hidden = !opening
            btn.setAttribute('aria-expanded', opening ? 'true' : 'false')
        });
        this.events.on(this.dom.modalCrossSearch, 'keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault()
                this.closeCrossSearchModal()
                return
            }
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            const items = Array.from(this.dom.crossSearchResults?.querySelectorAll('.cross-search-item') || [])
                .filter(el => !el.closest('.cross-search-book-section.collapsed'))
            if (!items.length) return
            e.preventDefault()
            const activeIdx = items.indexOf(document.activeElement)
            if (e.key === 'ArrowDown') {
                const next = activeIdx < 0 ? items[0] : items[Math.min(items.length - 1, activeIdx + 1)]
                next?.focus()
                next?.scrollIntoView?.({ block: 'nearest' })
            } else {
                if (activeIdx <= 0) {
                    this.dom.inputCrossSearch?.focus()
                } else {
                    const prev = items[activeIdx - 1]
                    prev?.focus()
                    prev?.scrollIntoView?.({ block: 'nearest' })
                }
            }
        });
    }

    dispose() { this.closeCrossSearchModal(); this.clearSearchState(true); this.events.dispose(); this._bound = false }

    openCrossSearchModal() {
        if (!this.dom.modalCrossSearch) return
        this.dom.modalCrossSearch.style.display = 'flex'
        this.dom.modalCrossSearch.classList.add('show')
        this._syncCrossSearchClearBtn()
        this.dom.inputCrossSearch?.focus()
    }

    closeCrossSearchModal() {
        this._searchQueryGeneration = (this._searchQueryGeneration || 0) + 1
        if (this._crossSearchAbortController) {
            this._crossSearchAbortController.abort()
            this._crossSearchAbortController = null
        }
        if (!this.dom.modalCrossSearch) return
        this.dom.modalCrossSearch.classList.remove('show')
        setTimeout(() => {
            if (this.dom.modalCrossSearch && !this.dom.modalCrossSearch.classList.contains('show')) this.dom.modalCrossSearch.style.display = 'none'
        }, 200)
    }

    async executeCrossSearch(query) {
        if (!query || !query.trim()) return
        const container = this.dom.crossSearchResults
        const status = this.dom.crossSearchStatus
        if (!container) return

        this._searchQueryGeneration = (this._searchQueryGeneration || 0) + 1
        const currentGen = this._searchQueryGeneration
        if (this._crossSearchAbortController) {
            this._crossSearchAbortController.abort()
        }
        this._crossSearchAbortController = new AbortController()
        const signal = this._crossSearchAbortController.signal

        this._syncCrossSearchClearBtn()
        this._resetSkippedBooks()
        container.innerHTML = `<div id="cross-search-loading" style="color: var(--text-muted); padding: 1.5rem; text-align: center;">${escapeHTML(t('search.crossLoading'))}</div>`
        if (status) status.innerText = t('search.crossIndexing')

        const books = (await db.getAllBooks()) || []
        const validBookIds = books.map(b => b.id)
        await fullTextSearchEngine.pruneStaleIndexes(validBookIds)

        const defaultConcurrency = platformBridge.isAndroid ? 1 : 2
        const configuredConcurrency = Number(this.app.advancedSettings?.config?.bgIndexConcurrency)
        const concurrency = Math.max(1, Math.min(6, (configuredConcurrency > 0 ? configuredConcurrency : defaultConcurrency)))

        const renderedBookCards = new Map()
        let totalHitsCount = 0

        const renderSnippetItem = (res) => {
            const item = document.createElement('div')
            item.className = 'cross-search-item'
            item.setAttribute('role', 'button')
            item.setAttribute('tabindex', '0')
            item.innerHTML = `
                <div class="cross-search-chapter-link">
                    <span>${escapeHTML(res.sectionTitle || res.bookTitle)}</span>
                    <span class="cross-search-jump-arrow" aria-hidden="true">→</span>
                </div>
                <div class="cross-search-snippet">${res.snippet}</div>
            `
            const openHit = (e) => {
                e.stopPropagation()
                this.closeCrossSearchModal()
                this.app.openBook(res.bookId, res.location)
            }
            item.addEventListener('click', openHit)
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openHit(e)
                }
            })
            return item
        }

        const handleBookResult = (bookResult) => {
            if (this._searchQueryGeneration !== currentGen || signal.aborted) return
            const loadingEl = document.getElementById('cross-search-loading')
            if (loadingEl) loadingEl.remove()

            if (renderedBookCards.has(bookResult.bookId)) return
            totalHitsCount += bookResult.totalHits

            const card = document.createElement('div')
            card.className = 'cross-search-book-section'
            card.dataset.bookId = bookResult.bookId
            const remainingHits = Math.max(0, (bookResult.totalHits || 0) - 3)

            card.innerHTML = `
                <div class="cross-search-book-header" role="button" tabindex="0">
                    <span class="cross-search-book-name">${escapeHTML(bookResult.bookTitle)}</span>
                    <span class="cross-search-hit-count">${escapeHTML(t('search.crossHitCount', { count: bookResult.totalHits }))}</span>
                </div>
                <div class="cross-search-snippets-list"></div>
                ${remainingHits > 0 ? `
                <div class="cross-search-expand-footer">
                    <button type="button" class="btn-expand-book-matches">${escapeHTML(t('search.crossExpandAll', { remaining: remainingHits }))}</button>
                </div>` : ''}
            `

            const header = card.querySelector('.cross-search-book-header')
            const listEl = card.querySelector('.cross-search-snippets-list')
            const footerEl = card.querySelector('.cross-search-expand-footer')
            const expandBtn = card.querySelector('.btn-expand-book-matches')

            // Render first 3 matches
            const initialMatches = (bookResult.previewMatches || bookResult.allMatches || []).slice(0, 3)
            initialMatches.forEach(res => listEl.appendChild(renderSnippetItem(res)))

            // Collapse / Expand toggle
            header.addEventListener('click', () => {
                card.classList.toggle('collapsed')
            })

            // Expand all matches incrementally (30 at a time)
            if (expandBtn) {
                let renderedCount = initialMatches.length
                const totalHits = bookResult.totalHits || initialMatches.length
                let searchCursor = null
                let isFirstExpansion = true

                const loadAndRenderMore = async () => {
                    expandBtn.disabled = true
                    expandBtn.innerText = t('search.crossLoadingMore')
                    try {
                        const pageSize = 30
                        let newItems = []
                        let pageRes = await fullTextSearchEngine.searchBookPage(bookResult.bookId, query.trim(), {
                            cursor: searchCursor,
                            pageSize: isFirstExpansion ? (pageSize + renderedCount) : pageSize,
                            signal
                        })
                        if (pageRes?.cursorInvalid) {
                            // Stale cursor detected: clear old results and restart from page 1
                            listEl.innerHTML = ''
                            renderedCount = 0
                            searchCursor = null
                            isFirstExpansion = false
                            pageRes = await fullTextSearchEngine.searchBookPage(bookResult.bookId, query.trim(), {
                                cursor: null,
                                pageSize: pageSize,
                                signal
                            })
                        }
                        searchCursor = pageRes.nextCursor
                        const fetchedItems = pageRes.items || []
                        if (isFirstExpansion) {
                            newItems = fetchedItems.slice(renderedCount)
                            isFirstExpansion = false
                        } else {
                            newItems = fetchedItems
                        }

                        newItems.forEach(res => listEl.appendChild(renderSnippetItem(res)))
                        renderedCount += newItems.length

                        if (searchCursor && renderedCount < totalHits) {
                            expandBtn.disabled = false
                            const remaining = Math.max(0, totalHits - renderedCount)
                            expandBtn.innerText = t('search.crossLoadMore', { rendered: renderedCount, total: totalHits, remaining })
                        } else {
                            footerEl.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 6px;">${escapeHTML(t('search.crossShownAll', { count: renderedCount }))}</div>`
                        }
                    } catch (err) {
                        console.warn('Failed to load more matches for book:', bookResult.bookId, err)
                        expandBtn.disabled = false
                        expandBtn.innerText = t('search.crossRetryLoad')
                    }
                }

                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    loadAndRenderMore()
                })
            }

            renderedBookCards.set(bookResult.bookId, card)
            container.appendChild(card)
        }

        const searchResult = await fullTextSearchEngine.searchBooks(query.trim(), books, {
            signal, concurrency,
            onBookResult: handleBookResult,
            onProgress: ({ visited, total, matches }) => {
                if (status && this._searchQueryGeneration === currentGen) {
                    status.innerText = t('search.crossProgress', { visited, total, matches })
                }
            }
        })
        if (signal.aborted || this._searchQueryGeneration !== currentGen) return
        const { failed, unsupported, skippedBooks = [], searched } = searchResult

        const loadingEl = document.getElementById('cross-search-loading')
        if (loadingEl) loadingEl.remove()

        const skippedCount = skippedBooks.length || (unsupported + failed)
        if (renderedBookCards.size === 0) {
            const emptyMsg = skippedCount > 0
                ? t('search.crossEmptyWithSkipped', { count: skippedCount })
                : t('search.empty')
            container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 2rem;">${escapeHTML(emptyMsg)}</div>`
        }

        if (status) {
            status.innerText = t('search.crossSummaryDone', { searched, hits: totalHitsCount })
        }

        // Only surface unindexed/skipped details quietly when zero matches were found so results aren't cluttered by noisy warnings
        if (renderedBookCards.size === 0 && skippedCount > 0 && this.dom.btnCrossSearchSkipped && this.dom.crossSearchSkippedPanel) {
            this.dom.btnCrossSearchSkipped.textContent = `${t('search.crossSkippedSummary', { count: skippedCount })} ▾`
            this.dom.btnCrossSearchSkipped.hidden = false
            this.dom.btnCrossSearchSkipped.setAttribute('aria-expanded', 'false')
            this.dom.crossSearchSkippedPanel.innerHTML = skippedBooks.map(item => {
                const reasonText = item.reason === 'unsupported_format'
                    ? t('search.crossSkippedUnsupportedReason', { format: item.format || '?' })
                    : t('search.crossSkippedUnreadableReason')
                return `
                    <div class="cross-search-skipped-item">
                        <span class="cross-search-skipped-title">${escapeHTML(item.bookTitle)}</span>
                        <span class="cross-search-skipped-reason">${escapeHTML(reasonText)}</span>
                    </div>
                `
            }).join('')
        } else {
            this._resetSkippedBooks()
        }
    }

    async executeSearch() {
        const query = this.dom.searchQueryInput.value.trim()
        if (!query || (!this.app.foliateView && !this.app.pdfViewport)) return
        this.clearSearchState(false)
        const controller = this._bookSearchAbortController = new AbortController()
        const state = {
            query, signal: controller.signal, bookId: this.app.currentBookId,
            view: this.app.foliateView, viewport: this.app.pdfViewport, driver: this.app.pdfDriver,
            pages: new Map(), pageIndex: 0, nextPage: 0, pending: null, total: null,
            pageSize: 50, failedPages: 0, busy: false
        }
        state.iterator = this._iterateBookSearchMatches(state)
        this._bookSearchState = state
        this.currentSearchQuery = query
        await this.loadBookSearchPage(0)
    }

    _isBookSearchCurrent(state) {
        return this._bookSearchState === state && !state.signal.aborted &&
            this.app.currentBookId === state.bookId && this.app.pdfViewport === state.viewport &&
            this.app.foliateView === state.view && this.app.pdfDriver === state.driver
    }

    async *_iterateBookSearchMatches(state) {
        const { query, signal, driver, viewport, view } = state
        if (viewport && driver) {
            const total = viewport.numPages || viewport.pageSizes?.length || 0
            const needle = query.toLowerCase()
            const normalizedNeedle = needle.replace(/\s+/g, ' ').trim()
            const searchNeedle = normalizedNeedle || needle
            for (let pageIndex = 0; pageIndex < total; pageIndex++) {
                if (signal.aborted) return
                try {
                    const plain = await driver.getPagePlainText?.(pageIndex)
                    if (signal.aborted) return
                    if (typeof plain === 'string') {
                        const plainLower = plain.toLowerCase()
                        const hasMatch = plainLower.includes(needle) ||
                            (normalizedNeedle.length > 0 && plainLower.replace(/\s+/g, ' ').includes(normalizedNeedle))
                        if (!hasMatch) continue
                    }
                    const { spans = [] } = await driver.getTextLayer(pageIndex)
                    if (signal.aborted) return
                    const size = viewport.pageSizes?.[pageIndex] || { width: 595, height: 842 }
                    let text = ''
                    const offsets = []
                    for (let i = 0; i < spans.length; i++) {
                        const span = spans[i]
                        const spanText = span.text || ''
                        if (i > 0 && text.length > 0 && spanText.length > 0 && !/\s$/.test(text) && !/^\s/.test(spanText)) {
                            text += ' '
                        }
                        const start = text.length
                        text += spanText
                        offsets.push({ span, start })
                    }
                    const lower = text.toLowerCase()
                    let position = 0, sliceStart = performance.now()
                    while (position < text.length) {
                        if (signal.aborted) return
                        if (performance.now() - sliceStart > 6) {
                            await new Promise(resolve => setTimeout(resolve, 0))
                            sliceStart = performance.now()
                            if (signal.aborted) return
                        }
                        const found = lower.indexOf(searchNeedle, position)
                        if (found < 0) break
                        const end = found + searchNeedle.length
                        const rects = this._pdfSearchRects(offsets, found, end, size)
                        yield {
                            label: t('common.pageNumber', { page: pageIndex + 1 }), pageIndex, rects, yRatio: rects[0]?.[1] || 0,
                            excerpt: { pre: (found > 30 ? '…' : '') + text.slice(Math.max(0, found - 30), found),
                                match: text.slice(found, end), post: text.slice(end, end + 30) + (end + 30 < text.length ? '…' : '') }
                        }
                        position = end
                    }
                } catch (error) {
                    if (signal.aborted) return
                    state.failedPages++
                    console.warn('PDF search page error:', pageIndex, error)
                }
                await new Promise(resolve => setTimeout(resolve, 0))
            }
        } else if (view?.search) {
            for await (const group of view.search({ query, signal, batchSize: 50, retainHighlights: false })) {
                if (signal.aborted || group === 'done') return
                if (group.subitems) for (const item of group.subitems) yield { ...item, label: group.label || t('search.currentChapter') }
                else if (group.cfi) yield { ...group, label: t('search.currentChapter') }
            }
        }
    }

    _pdfSearchRects(offsets, start, end, size) {
        const rects = []
        for (const { span, start: spanStart } of offsets) {
            if (spanStart >= end || spanStart + span.text.length <= start) continue
            let x0 = span.x, y0 = span.y, x1 = span.x + span.w, y1 = span.y + span.h
            if (span.charOffsets?.length && span.charOffsets.length === span.charBoxes?.length) {
                const boxes = span.charBoxes.filter((_, i) => span.charOffsets[i].end > start - spanStart && span.charOffsets[i].start < end - spanStart)
                if (boxes.length) {
                    x0 = Math.min(...boxes.map(box => box.x0)); y0 = Math.min(...boxes.map(box => box.y0))
                    x1 = Math.max(...boxes.map(box => box.x1)); y1 = Math.max(...boxes.map(box => box.y1))
                }
            }
            if (![x0,y0,x1,y1,size.width,size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) continue
            rects.push([x0/size.width,y0/size.height,x1/size.width,y1/size.height].map(value => Math.max(0, Math.min(1, value))))
        }
        return rects
    }

    async loadBookSearchPage(index) {
        const state = this._bookSearchState
        if (!state || state.busy || !this._isBookSearchCurrent(state)) return false
        state.busy = true
        const container = this.dom?.searchResultsContainer
        container?.querySelectorAll?.('button')?.forEach?.(button => button.disabled = true)
        if (!state.pages.size && container) container.innerText = t('search.inBookSearching')
        let firstPulsed = false
        try {
            let page = state.pages.get(index)
            if (!page && index < state.nextPage) {
                // Keep only three result pages. Older pages can be replayed lazily.
                await state.iterator.return?.()
                if (!this._isBookSearchCurrent(state)) return false
                state.iterator = this._iterateBookSearchMatches(state)
                state.nextPage = 0
                state.pending = null
                state.failedPages = 0
            }
            while (!page && state.nextPage <= index) {
                const isTargetPage = state.nextPage === index
                const items = []
                let lastProgressiveRender = 0
                while (items.length < state.pageSize) {
                    const step = state.pending || await state.iterator.next()
                    state.pending = null
                    if (!this._isBookSearchCurrent(state)) return false
                    if (step.done) break
                    items.push(step.value)
                    if (isTargetPage) {
                        const now = performance.now()
                        if (items.length === 1 || (now - lastProgressiveRender >= 120)) {
                            lastProgressiveRender = now
                            state.pageIndex = index
                            state.page = { items: items.slice(), hasMore: true, searching: true }
                            this.currentSearchMatches = state.page.items
                            this.currentSearchMatchIndex = 0
                            this._renderBookSearchPage(state)
                            this.updateSearchBarUI?.()
                            if (!firstPulsed) {
                                firstPulsed = true
                                const first = state.page.items[0]
                                if (first?.cfi) state.view?.setActiveSearchMatch?.(first.cfi)
                                else if (first?.rects?.length) state.viewport?.pulseRects?.(first.pageIndex, first.rects)
                            }
                        }
                    }
                }
                const lookahead = items.length === state.pageSize ? await state.iterator.next() : { done: true }
                if (!this._isBookSearchCurrent(state)) return false
                state.pending = lookahead.done ? null : lookahead
                page = { items, hasMore: !lookahead.done, searching: false }
                if (!page.hasMore) state.total = state.nextPage * state.pageSize + items.length
                state.pages.set(state.nextPage, page)
                state.nextPage++
                if (state.pages.size > 3) state.pages.delete(state.pages.keys().next().value)
                if (state.nextPage <= index && page.hasMore) page = null
                else if (state.nextPage <= index) return false
            }
            if (!page || !this._isBookSearchCurrent(state)) return false
            state.pageIndex = index
            state.page = page
            this.currentSearchMatches = page.items
            this.currentSearchMatchIndex = 0
            this._renderBookSearchPage(state)
            if (!firstPulsed) {
                const first = page.items[0]
                if (first?.cfi) state.view?.setActiveSearchMatch?.(first.cfi)
                else if (first?.rects?.length) state.viewport?.pulseRects?.(first.pageIndex, first.rects)
            }
            this.updateSearchBarUI?.()
            return true
        } catch (error) {
            if (this._isBookSearchCurrent(state) && container) container.innerText = t('search.inBookFailed', { error: error.message || error })
            return false
        } finally {
            if (this._isBookSearchCurrent(state)) state.busy = false
        }
    }

    _renderBookSearchPage(state) {
        const container = this.dom?.searchResultsContainer
        if (!container) return
        const { page, pageIndex, pageSize } = state
        container.replaceChildren()
        const summary = document.createElement('div')
        summary.className = 'search-page-summary'
        summary.setAttribute('role', 'status')
        summary.style.cssText = 'font-size:.78rem;color:var(--text-muted);margin-bottom:.75rem'
        const first = page.items.length ? pageIndex * pageSize + 1 : 0, last = pageIndex * pageSize + page.items.length
        summary.textContent = !last
            ? t('search.inBookSummaryEmpty')
            : `${t('search.inBookSummaryRange', { first, last })}${state.total != null ? t('search.inBookSummaryTotal', { total: state.total }) : t('search.inBookSummaryMore')}`
        if (state.failedPages) summary.textContent += t('search.inBookFailedPages', { count: state.failedPages })
        container.append(summary)
        let previousLabel
        for (const [index, item] of page.items.entries()) {
            if (item.label !== previousLabel) {
                const header = document.createElement('div')
                header.textContent = item.label
                header.style.cssText = 'font-size:.78rem;font-weight:700;margin:.6rem 0 .3rem;color:var(--accent-primary)'
                container.append(header)
                previousLabel = item.label
            }
            const row = document.createElement('div'), { pre = '', match = state.query, post = '' } = item.excerpt || {}
            row.className = 'search-result-item'
            row.innerHTML = `${escapeHTML(pre)}<mark>${escapeHTML(match)}</mark>${escapeHTML(post)}`
            row.addEventListener('click', () => {
                if (!this._isBookSearchCurrent(state)) return
                this.app.navHistory?.pushLocation()
                this.currentSearchMatchIndex = index
                this._showBookSearchMatch(state, item).catch(error => console.warn('Search navigation:', error))
                this.app.annotations.closeDrawer()
            })
            container.append(row)
        }
        if (pageIndex || page.hasMore) {
            const pager = document.createElement('div')
            pager.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px'
            for (const [label, direction, disabled] of [[t('search.prevPage'), -1, Boolean(page.searching) || !pageIndex], [t('search.nextPage'), 1, Boolean(page.searching) || !page.hasMore]]) {
                const button = document.createElement('button')
                button.type = 'button'; button.className = 'btn-secondary'; button.textContent = label; button.disabled = disabled
                button.dataset.searchPage = direction < 0 ? 'previous' : 'next'
                button.addEventListener('click', () => this.loadBookSearchPage(pageIndex + direction))
                pager.append(button)
            }
            container.append(pager)
        }
    }

    async _showBookSearchMatch(state, target) {
        if (!this._isBookSearchCurrent(state)) return
        if (state.viewport && typeof target?.pageIndex === 'number') {
            state.viewport.goToPage(target.pageIndex, target.yRatio || 0)
            if (target.rects?.length) state.viewport.pulseRects(target.pageIndex, target.rects)
        } else if (target?.cfi && state.view) {
            await state.view.goTo(target.cfi)
            if (!this._isBookSearchCurrent(state)) return
            state.view.setActiveSearchMatch?.(target.cfi)
        }
        this.updateSearchBarUI()
    }

    clearSearchState(clearInput = false) {
        if (this._bookSearchAbortController) {
            try { this._bookSearchAbortController.abort() } catch (e) {}
            this._bookSearchAbortController = null
        }
        this._bookSearchState = null
        if (this.app.foliateView?.clearSearch) {
            this.app.foliateView.clearSearch()
        }
        if (this.app.pdfViewport) {
            this.app.pdfViewport._pendingPulse = null
            this.app.pdfViewport._pendingHighlightPulse = null
            if (this.app.pdfViewport.activeSlots) {
                for (const slot of this.app.pdfViewport.activeSlots.values()) {
                    slot.querySelectorAll('.pdf-search-pulse').forEach(el => el.remove())
                }
            }
        }
        this.currentSearchMatches = []
        this.currentSearchMatchIndex = 0
        this.currentSearchQuery = ''
        if (this.dom.readerSearchBar) {
            this.dom.readerSearchBar.classList.remove('active')
            this.dom.readerSearchBar.style.display = 'none'
        }
        if (clearInput) {
            if (this.dom.searchQueryInput) this.dom.searchQueryInput.value = ''
            if (this.dom.btnClearSearchInput) this.dom.btnClearSearchInput.style.display = 'none'
            if (this.dom.searchResultsContainer) this.dom.searchResultsContainer.innerHTML = ''
        }
    }

    async navigateSearchMatch(direction) {
        const state = this._bookSearchState
        if (!state || state.busy || !this.currentSearchMatches.length) return
        let index = this.currentSearchMatchIndex + direction
        if (index < 0) {
            if (!state.pageIndex || !await this.loadBookSearchPage(state.pageIndex - 1)) return
            index = this.currentSearchMatches.length - 1
        } else if (index >= this.currentSearchMatches.length) {
            if (!state.page.hasMore || !await this.loadBookSearchPage(state.pageIndex + 1)) return
            index = 0
        }
        if (!this._isBookSearchCurrent(state)) return
        this.currentSearchMatchIndex = index
        await this._showBookSearchMatch(state, this.currentSearchMatches[index])
    }

    updateSearchBarUI() {
        if (!this.dom.readerSearchBar || this.currentSearchMatches.length === 0) return
        this.dom.readerSearchBar.style.display = 'flex'
        this.dom.readerSearchBar.classList.add('active')
        const state = this._bookSearchState
        const curr = (state ? state.pageIndex * state.pageSize : 0) + this.currentSearchMatchIndex + 1
        const total = state?.total ?? ((state?.pageIndex || 0) * (state?.pageSize || 0) + this.currentSearchMatches.length + '+')
        if (this.dom.searchBarTitle) {
            this.dom.searchBarTitle.innerText = `“${this.currentSearchQuery}” · ${curr}/${total}`
        }
    }
}
