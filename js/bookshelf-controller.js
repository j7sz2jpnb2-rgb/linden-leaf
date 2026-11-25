import { ensureAiSidebarLoaded } from './app-modules.js'
import { DomEvents } from './dom-events.js'
import * as db from './db.js'
import { tracker } from './tracker.js'
import { normalizeCoverBlob } from './pdf-cover.js'
import { fullTextSearchEngine } from './fulltext-search.js'
import { batchAddTag, batchRemoveTag, normalizeTag, resolveReadingState, getAllTagsWithCounts, renameTagGlobally, deleteTagGlobally } from './tags-manager.js'
import { resolveBookTitle } from './book-title.js'
import { coverUrlPool } from './cover-url-pool.js'
import { uiSymbol, escapeHTML, formatFileSize, DEFAULT_READER_NAME, getGreetingPeriodKey, renderEditorialCoverHTML } from './ui-format.js'
import { getIntlLocale, getLocale, t, tList } from './i18n.js'

const DESKTOP_GRID_CARD_BUDGET = 100

/** Resolve normalized [0, 1] reading progress fraction with percentage & finished fallbacks. */
function resolveBookProgressFraction(book) {
    if (!book) return 0
    if (typeof book.progress?.fraction === 'number' && Number.isFinite(book.progress.fraction)) {
        return Math.min(1, Math.max(0, Number(book.progress.fraction)))
    }
    if (typeof book.progressPercentage === 'number' && Number.isFinite(book.progressPercentage)) {
        return Math.min(1, Math.max(0, Number(book.progressPercentage) / 100))
    }
    if (resolveReadingState(book) === 'finished') {
        return 1
    }
    return 0
}

/** Owns bookshelf UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class BookshelfController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this.shelfViewMode = 'grid'
        this.shelfCategory = 'all'
        this.overviewStatus = 'all'
        this.overviewSelectedTags = new Set()
        this.overviewRatingFilter = 'all'
        this.overviewSearchQuery = ''
        this.overviewGroupByYearMonth = false
        this.tagManagementMode = false
        this._bookshelfRefreshEpoch = 0
        this.sortField = 'addedAt'
        this.sortOrder = 'desc'
        this.searchQuery = ''
        this.currentBooksList = []
        this.sidebarUserCollapsed = true
        this.isGliding = false
        this.cachedShelfHeight = 0
        this.customLists = []
        this.selectedListIcon = 'book'
        this.managingBookId = null
        this.iconDefs = [
            { id: 'book', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>' },
            { id: 'bookmark', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
            { id: 'feather', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/></svg>' },
            { id: 'coffee', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>' },
            { id: 'star', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
            { id: 'idea', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>' },
            { id: 'compass', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>' },
            { id: 'target', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>' },
            { id: 'sparkles', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>' },
            { id: 'leaf', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>' },
            { id: 'scroll', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/></svg>' },
            { id: 'tag', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>' },
            { id: 'hourglass', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>' },
            { id: 'briefcase', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>' },
            { id: 'palette', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>' },
            { id: 'archive', svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>' }
        ]
        this.isBatchMode = false
        this.selectedBookIds = new Set()
    }

    initDOM() {
        this.dom = {
            headerSearchBar: document.getElementById('header-search-bar'),
            shelfSearch: document.getElementById('shelf-search'),
            btnClearShelfSearch: document.getElementById('btn-clear-shelf-search'),
            btnOpenCrossSearch: document.getElementById('btn-open-cross-search'),
            btnHeaderFavorite: document.getElementById('btn-header-favorite'),
            btnSortToggle: document.getElementById('btn-sort-toggle'),
            sortDropdownMenu: document.getElementById('sort-dropdown-menu'),
            sortMenuItems: document.querySelectorAll('#sort-dropdown-menu .sort-menu-item'),
            btnViewGrid: document.getElementById('btn-view-grid'),
            btnViewList: document.getElementById('btn-view-list'),
            btnHeaderSettings: document.getElementById('btn-header-settings'),
            booksGrid: document.getElementById('books-grid'),
            modernGridWrapper: document.getElementById('modern-grid-wrapper'),
            modernHeroThreshold: document.getElementById('modern-hero-threshold'),
            heroGreetingTitle: document.getElementById('hero-greeting-title'),
            heroGreetingSubtitle: document.getElementById('hero-greeting-subtitle'),
            heroBookShowcase: document.getElementById('hero-book-showcase'),
            heroScrollHint: document.getElementById('hero-scroll-hint'),
            modernShelfScreen: document.getElementById('modern-shelf-screen'),
            modernShelfDivider: document.getElementById('modern-shelf-divider'),
            btnBackToHero: document.getElementById('btn-back-to-hero'),
            modernGridBookCount: document.getElementById('modern-grid-book-count'),
            booksTableContainer: document.getElementById('books-table-container'),
            booksTableBody: document.getElementById('books-table-body'),
            booksWorkspace: document.querySelector('.leaf-content-workspace'),
            mainArea: document.querySelector('.leaf-main-area'),
            shelfHeaderActions: document.getElementById('shelf-header-actions'),
            bookshelfControlsBar: document.getElementById('bookshelf-controls-bar'),
            bookshelfView: document.getElementById('bookshelf-view'),
            shelfSubbarCount: document.getElementById('shelf-subbar-count'),
            footerStatus: document.querySelector('.leaf-footer-status'),
            bookCountFooter: document.getElementById('book-count-footer'),
            navCategoryItems: document.querySelectorAll('.leaf-sidebar .nav-item'),
            currentCategoryTitle: document.getElementById('current-category-title'),
            btnSidebarCollapse: document.getElementById('btn-sidebar-collapse'),
            btnHeaderExpandSidebar: document.getElementById('btn-header-expand-sidebar'),
            btnSidebarSettings: document.getElementById('btn-sidebar-settings'),
            sidebarUserSection: document.getElementById('sidebar-user-section'),
            customListsContainer: document.getElementById('custom-lists-container'),
            btnCreateList: document.getElementById('btn-create-list'),
            btnListAddBooks: document.getElementById('btn-list-add-books'),
            modalCreateList: document.getElementById('modal-create-list'),
            createListPreview: document.getElementById('create-list-preview'),
            createListPreviewIcon: document.getElementById('create-list-preview-icon'),
            createListPreviewName: document.getElementById('create-list-preview-name'),
            createListNameField: document.getElementById('create-list-name-field'),
            inputCustomListName: document.getElementById('input-custom-list-name'),
            createListNameError: document.getElementById('create-list-name-error'),
            customListIconPicker: document.getElementById('custom-list-icon-picker'),
            btnConfirmCreateList: document.getElementById('btn-confirm-create-list'),
            btnCancelCreateList: document.getElementById('btn-cancel-create-list'),
            btnCloseCreateList: document.getElementById('btn-close-create-list'),
            modalManageBookLists: document.getElementById('modal-manage-book-lists'),
            manageBookTargetTitle: document.getElementById('manage-book-target-title'),
            bookListsCheckboxContainer: document.getElementById('book-lists-checkbox-container'),
            btnSaveBookLists: document.getElementById('btn-save-book-lists'),
            btnCancelBookLists: document.getElementById('btn-cancel-book-lists'),
            btnCloseBookLists: document.getElementById('btn-close-book-lists'),
            btnQuickNewListInModal: document.getElementById('btn-quick-new-list-in-modal'),
            modalBatchAddToList: document.getElementById('modal-batch-add-to-list'),
            batchAddListModalTitle: document.getElementById('batch-add-list-modal-title'),
            batchAddBooksContainer: document.getElementById('batch-add-books-container'),
            btnConfirmBatchAddList: document.getElementById('btn-confirm-batch-add-list'),
            btnCancelBatchAddList: document.getElementById('btn-cancel-batch-add-list'),
            btnCloseBatchAddList: document.getElementById('btn-close-batch-add-list'),
            readingOverviewPanel: document.getElementById('reading-overview-panel'),
            overviewStatusTabs: document.getElementById('overview-status-tabs'),
            overviewSearchInput: document.getElementById('overview-search-input'),
            btnOverviewOpenTags: document.getElementById('btn-overview-open-tags'),
            overviewTagsBtnText: document.getElementById('overview-tags-btn-text'),
            overviewTagsPopover: document.getElementById('overview-tags-popover'),
            overviewTagsPopoverList: document.getElementById('overview-tags-popover-list'),
            btnPopoverManageTags: document.getElementById('btn-popover-manage-tags'),
            btnOverviewRatingTrigger: document.getElementById('btn-overview-rating-trigger'),
            overviewRatingTriggerText: document.getElementById('overview-rating-trigger-text'),
            overviewRatingPopover: document.getElementById('overview-rating-popover'),
            overviewRatingSliderMin: document.getElementById('overview-rating-slider-min'),
            overviewRatingSliderMax: document.getElementById('overview-rating-slider-max'),
            overviewRatingTrackHighlight: document.getElementById('overview-rating-track-highlight'),
            overviewRatingValDisplay: document.getElementById('overview-rating-val-display'),
            overviewUnratedCheckbox: document.getElementById('overview-unrated-checkbox'),
            btnResetRating: document.getElementById('btn-reset-rating'),
            overviewRatingFilterSelect: document.getElementById('overview-rating-filter'),
            btnOverviewToggleGrouping: document.getElementById('btn-overview-toggle-grouping'),
            overviewGroupingText: document.getElementById('overview-grouping-text'),
            overviewActiveFiltersBar: document.getElementById('overview-active-filters-bar'),
            overviewActiveFiltersPills: document.getElementById('overview-active-filters-pills'),
            btnClearOverviewFilters: document.getElementById('btn-clear-overview-filters'),
            modalGlobalTags: document.getElementById('modal-global-tags'),
            inputGlobalTagSearch: document.getElementById('input-global-tag-search'),
            globalTagsListContainer: document.getElementById('global-tags-list-container'),
            globalTagsEmptyHint: document.getElementById('global-tags-empty-hint'),
            btnToggleTagManagement: document.getElementById('btn-toggle-tag-management'),
            btnCloseGlobalTags: document.getElementById('btn-close-global-tags'),
            btnConfirmGlobalTags: document.getElementById('btn-confirm-global-tags'),
            btnBatchMode: document.getElementById('btn-batch-mode'),
            batchActionsBar: document.getElementById('batch-actions-bar'),
            batchSelectedCount: document.getElementById('batch-selected-count'),
            btnBatchSelectAll: document.getElementById('btn-batch-select-all'),
            btnBatchTags: document.getElementById('btn-batch-tags'),
            btnBatchDelete: document.getElementById('btn-batch-delete'),
            btnBatchExit: document.getElementById('btn-batch-exit'),
            modalBatchTags: document.getElementById('modal-batch-tags'),
            btnCloseBatchTags: document.getElementById('btn-close-batch-tags'),
            batchTagsPrompt: document.getElementById('batch-tags-prompt'),
            inputBatchTag: document.getElementById('input-batch-tag'),
            btnBatchAddTagAction: document.getElementById('btn-batch-add-tag-action'),
            batchExistingTagsList: document.getElementById('batch-existing-tags-list')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.initShelfDelegatedListeners();
        this.events.on(this.dom.btnHeaderFavorite, 'click', () => {
            if (this.shelfCategory === 'favorite') {
                this.switchShelfCategory('all', { landOnShelf: true })
            } else {
                this.switchShelfCategory('favorite')
            }
        });
        this._shelfSearchTimer = null
        this._shelfSearchComposing = false
        this._hadActiveSearchQuery = false
        this._pendingLandOnShelfAfterSearchClear = false
        this._syncHeaderSearchState()
        this.events.on(this.dom.shelfSearch, 'compositionstart', () => {
            this._shelfSearchComposing = true
        })
        this.events.on(this.dom.shelfSearch, 'compositionend', e => {
            this._shelfSearchComposing = false
            const val = e?.target?.value ?? this.dom.shelfSearch?.value ?? ''
            this._syncHeaderSearchState(val)
            this._scheduleShelfSearchFilter(val, { immediate: true })
        })
        this.events.on(this.dom.shelfSearch, 'input', e => {
            const val = e?.target?.value ?? ''
            this._syncHeaderSearchState(val)
            if (e?.isComposing || this._shelfSearchComposing) return
            this._scheduleShelfSearchFilter(val)
        });
        this.events.on(this.dom.shelfSearch, 'keydown', e => {
            if (e.isComposing || e.keyCode === 229 || this._shelfSearchComposing) return
            if (e.key === 'Enter' && e.shiftKey) {
                const q = (this.dom.shelfSearch?.value ?? '').trim()
                if (q) {
                    e.preventDefault()
                    this.app?.search?.openCrossSearchModal?.(q)
                }
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                if (this.dom.shelfSearch?.value) {
                    this.clearShelfSearch({ focusInput: true })
                } else {
                    this.dom.shelfSearch?.blur?.()
                }
            }
        })
        this.events.on(this.dom.btnClearShelfSearch, 'click', () => {
            this.clearShelfSearch({ focusInput: true })
        })
        this.events.on(this.dom.shelfSearch, 'focus', () => {
            if (this._suppressNextSearchFocusGlide) {
                this._suppressNextSearchFocusGlide = false
                return
            }
            if (this.shelfViewMode === 'grid' && this.dom.booksWorkspace && this.dom.booksWorkspace.scrollTop < 40) {
                this.glideToShelf()
            }
        });
        this.events.on(document, 'keydown', e => this._handleGlobalSearchShortcut(e));
        this.initShelfSidebar();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.getElementById('bookshelf-view')?.classList.remove('notransition')
            })
        });
        const handleOpenSidebarSettings = () => this.app.annotations.openDrawer('settings');
        this.events.on(this.dom.btnSidebarSettings, 'click', (e) => {
            e.stopPropagation()
            handleOpenSidebarSettings()
        });
        this.events.on(this.dom.sidebarUserSection, 'click', (e) => {
            handleOpenSidebarSettings()
        });
        this.dom.navCategoryItems?.forEach(item => {
            this.events.on(item, 'click', () => {
                const targetCat = item.dataset.category
                this.switchShelfCategory(targetCat, targetCat === 'all' ? { landOnShelf: true } : {})
            })
        });
        if (this.dom.booksWorkspace) {
            this.events.on(this.dom.booksWorkspace, 'scroll', () => {
                this.onBooksWorkspaceScroll(true)
            }, { passive: true })

        }
        if (this.dom.booksGrid && typeof ResizeObserver === 'function') {
            this._virtualLayoutObserver = new ResizeObserver(([entry]) => {
                if (!this._isGridVirtualized || !entry.contentRect.width ||
                    Math.abs(entry.contentRect.width - this._virtualLayoutWidth) < 1) return
                clearTimeout(this._virtualLayoutTimer)
                this._virtualLayoutTimer = setTimeout(() => {
                    if (this._isGridVirtualized && this.dom.modernGridWrapper?.style.display !== 'none' &&
                        this.dom.booksWorkspace?.clientWidth) {
                        this._renderVirtualizedBooksGrid(this._virtualBooks)
                    }
                }, 150)
            })
            this._virtualLayoutObserver.observe(this.dom.booksGrid)
        }
        this.events.on(this.dom.btnCreateList, 'click', () => this.openCreateListModal());
        this.events.on(this.dom.btnCloseCreateList, 'click', () => this.closeCreateListModal());
        this.events.on(this.dom.btnCancelCreateList, 'click', () => this.closeCreateListModal());
        this.events.on(this.dom.btnConfirmCreateList, 'click', () => this.handleCreateListConfirm());
        this.events.on(this.dom.inputCustomListName, 'input', () => {
            this._setCreateListNameError(false)
            this._updateCreateListPreview()
        });
        this.events.on(this.dom.inputCustomListName, 'keydown', e => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                this.handleCreateListConfirm()
            }
        });
        this.events.on(this.dom.modalCreateList, 'keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                this.closeCreateListModal()
            }
        });
        this.events.on(this.dom.modalCreateList, 'click', e => {
            if (e.target === this.dom.modalCreateList) this.closeCreateListModal()
        });
        this.events.on(this.dom.btnCloseBookLists, 'click', () => this.closeManageBookListsModal());
        this.events.on(this.dom.btnCancelBookLists, 'click', () => this.closeManageBookListsModal());
        this.events.on(this.dom.btnSaveBookLists, 'click', () => this.handleSaveBookLists());
        this.events.on(this.dom.btnQuickNewListInModal, 'click', () => {
            this.closeManageBookListsModal()
            this.openCreateListModal()
        });
        this.events.on(this.dom.modalManageBookLists, 'click', e => {
            if (e.target === this.dom.modalManageBookLists) this.closeManageBookListsModal()
        });
        this.events.on(this.dom.btnListAddBooks, 'click', () => this.openBatchAddToListModal());
        this.events.on(this.dom.btnCloseBatchAddList, 'click', () => this.closeBatchAddToListModal());
        this.events.on(this.dom.btnCancelBatchAddList, 'click', () => this.closeBatchAddToListModal());
        this.events.on(this.dom.btnConfirmBatchAddList, 'click', () => this.handleConfirmBatchAddList());
        this.events.on(this.dom.modalBatchAddToList, 'click', e => {
            if (e.target === this.dom.modalBatchAddToList) this.closeBatchAddToListModal()
        });
        this.events.on(this.dom.btnViewGrid, 'click', () => this.setShelfViewMode('grid'));
        this.events.on(this.dom.btnViewList, 'click', () => this.setShelfViewMode('list'));
        this.events.on(this.dom.btnHeaderSettings, 'click', () => this.app.annotations.openDrawer('settings'));
        this.events.on(this.dom.btnSortToggle, 'click', e => {
            e.stopPropagation()
            this.dom.sortDropdownMenu?.classList.toggle('active')
        });
        this.events.on(document, 'click', e => {
            if (this.dom.sortDropdownMenu && !this.dom.sortDropdownMenu.contains(e.target) && e.target !== this.dom.btnSortToggle) {
                this.dom.sortDropdownMenu.classList.remove('active')
            }
        });
        this.dom.sortMenuItems?.forEach(item => {
            this.events.on(item, 'click', () => {
                if (item.dataset.sort) {
                    this.sortField = item.dataset.sort
                    this.dom.sortMenuItems.forEach(i => {
                        if (i.dataset.sort) {
                            i.classList.toggle('active', i.dataset.sort === this.sortField)
                            const chk = i.querySelector('.sort-check')
                            if (chk) chk.innerText = i.dataset.sort === this.sortField ? '✓' : ''
                        }
                    })
                }
                if (item.dataset.order) {
                    this.sortOrder = item.dataset.order
                    this.dom.sortMenuItems.forEach(i => {
                        if (i.dataset.order) {
                            i.classList.toggle('active', i.dataset.order === this.sortOrder)
                            const chk = i.querySelector('.order-check')
                            if (chk) chk.innerText = i.dataset.order === this.sortOrder ? '✓' : ''
                        }
                    })
                }
                this.refreshBookshelf()
            })
        });
        this.events.on(this.dom.btnBatchMode, 'click', () => {
            this.toggleBatchMode()
        });
        this.events.on(this.dom.btnBatchSelectAll, 'click', () => {
            this.handleBatchSelectAll()
        });
        this.events.on(this.dom.btnBatchTags, 'click', () => {
            this.openBatchTagsModal()
        });
        this.events.on(this.dom.btnBatchDelete, 'click', () => {
            this.handleBatchDelete()
        });
        this.events.on(this.dom.btnBatchExit, 'click', () => {
            this.toggleBatchMode(false)
        });
        this.events.on(this.dom.btnCloseBatchTags, 'click', () => {
            this.closeBatchTagsModal()
        });
        this.events.on(document.getElementById('btn-done-batch-tags'), 'click', () => {
            this.closeBatchTagsModal()
        });
        this.events.on(this.dom.modalBatchTags, 'click', e => {
            if (e.target === this.dom.modalBatchTags) this.closeBatchTagsModal()
        });
        this.events.on(this.dom.btnBatchAddTagAction, 'click', () => {
            this.handleBatchAddTag()
        });
        this.events.on(this.dom.inputBatchTag, 'keydown', e => {
            if (e.key === 'Enter') this.handleBatchAddTag()
        });
            this.bindOverviewEvents();
    }

    dispose() {
        this.events.dispose()
        this._shelfSidebarController?.abort()
        this._shelfCoverObserver?.disconnect()
        clearTimeout(this._shelfSearchTimer)
        clearTimeout(this._scrollEndTimer)
        clearTimeout(this._coverOptTimer)
        clearTimeout(this._virtualLayoutTimer)
        this._virtualLayoutObserver?.disconnect()
        this._virtualLayoutObserver = null
        this._coverOptResume = null
        this._coverOptRunning = false
        this._isScrolling = false
        this._shelfDelegatedInitialized = false
        this._bound = false
    }

    _syncHeaderSearchState(valueOverride = null) {
        const raw = valueOverride !== null
            ? String(valueOverride)
            : (this.dom?.shelfSearch?.value ?? this.searchQuery ?? '')
        const hasRaw = Boolean(raw)
        const hasNonEmpty = Boolean(raw && raw.trim())
        this.dom?.headerSearchBar?.classList?.toggle('has-value', hasNonEmpty)
        if (this.dom?.btnClearShelfSearch) {
            this.dom.btnClearShelfSearch.hidden = !hasRaw
        }
        if (this.dom?.btnOpenCrossSearch) {
            const labelKey = hasNonEmpty ? 'shelf.crossSearchAction' : 'shelf.crossSearchShort'
            if (this.dom.btnOpenCrossSearch.dataset) {
                this.dom.btnOpenCrossSearch.dataset.i18n = labelKey
            }
            this.dom.btnOpenCrossSearch.textContent = t(labelKey)
        }
    }

    _scheduleShelfSearchFilter(rawValue, { immediate = false } = {}) {
        this.searchQuery = rawValue
        const nextHasQuery = Boolean(this.searchQuery && this.searchQuery.trim())
        if (this._hadActiveSearchQuery && !nextHasQuery) {
            this._pendingLandOnShelfAfterSearchClear = true
        } else if (nextHasQuery) {
            this._hadActiveSearchQuery = true
            this._pendingLandOnShelfAfterSearchClear = false
        }
        clearTimeout(this._shelfSearchTimer)
        const runFilter = () => {
            const landOnShelf = Boolean(this._pendingLandOnShelfAfterSearchClear)
            this._pendingLandOnShelfAfterSearchClear = false
            this._hadActiveSearchQuery = Boolean(this.searchQuery && this.searchQuery.trim())
            this.refreshBookshelf({ landOnShelf })
        }
        if (immediate) {
            runFilter()
        } else {
            this._shelfSearchTimer = setTimeout(runFilter, 150)
        }
    }

    clearShelfSearch({ focusInput = true } = {}) {
        clearTimeout(this._shelfSearchTimer)
        this._shelfSearchComposing = false
        this._pendingLandOnShelfAfterSearchClear = false
        this._hadActiveSearchQuery = false
        this.searchQuery = ''
        if (this.dom?.shelfSearch) {
            this.dom.shelfSearch.value = ''
        }
        this._syncHeaderSearchState('')
        if (focusInput) {
            this._suppressNextSearchFocusGlide = true
            this.dom?.shelfSearch?.focus?.()
        }
        return this.refreshBookshelf({ landOnShelf: true })
    }

    _isShelfSearchShortcutContext(e) {
        const isEditable = el => Boolean(
            el && (
                el.isContentEditable ||
                el.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ||
                el.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
            )
        )
        if (isEditable(e?.target) || isEditable(document.activeElement)) return false
        if (globalThis.window?.mobileShell?.isInReader) return false
        if (this.app?.annotations?.activeDrawer) return false
        const shelfView = this.dom?.bookshelfView || document.getElementById('bookshelf-view')
        if (!shelfView || shelfView.style?.display === 'none') return false
        const headerActions = this.dom?.shelfHeaderActions || document.getElementById('shelf-header-actions')
        if (headerActions && headerActions.style?.display === 'none') return false
        const readerView = document.getElementById('reader-view')
        if (readerView && readerView.style?.display && readerView.style.display !== 'none') return false
        if (typeof document.querySelectorAll === 'function') {
            const modals = Array.from(document.querySelectorAll('.global-modal-backdrop, #quote-card-backdrop'))
            const hasOpenModal = modals.some(el => {
                if (el.classList?.contains('show')) return true
                if (el.style?.display && el.style.display !== 'none') return true
                if (typeof getComputedStyle === 'function') {
                    try { return getComputedStyle(el).display !== 'none' } catch (_) {}
                }
                return false
            })
            if (hasOpenModal) return false
        }
        return true
    }

    _handleGlobalSearchShortcut(e) {
        if (!e || e.isComposing || e.keyCode === 229) return
        const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey
        const isCtrlK = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key || '').toLowerCase() === 'k'
        if (!isSlash && !isCtrlK) return
        if (!this._isShelfSearchShortcutContext(e)) return
        if (!this.dom?.shelfSearch) return
        e.preventDefault()
        this.dom.shelfSearch.focus()
        if (isCtrlK && typeof this.dom.shelfSearch.select === 'function') {
            this.dom.shelfSearch.select()
        }
    }

    async setShelfViewMode(mode) {
        const normalizedMode = mode === 'list' ? 'list' : (mode === 'grid' || mode === 'shelf' ? 'grid' : null)
        if (!normalizedMode) return
        const prevMode = this.shelfViewMode
        this.shelfViewMode = normalizedMode
        try { localStorage.setItem('linden_leaf_view_mode', normalizedMode) } catch (e) {}
        this.app.appearance.updateSettingsUI()
        await this.app.saveSettings()
        await this.refreshBookshelf({ landOnShelf: normalizedMode === 'grid' && prevMode !== 'grid' })

        const activeEl = normalizedMode === 'grid' ? this.dom.modernGridWrapper : this.dom.booksTableContainer
        if (activeEl) {
            activeEl.classList.remove('view-spring-transition')
            void activeEl.offsetWidth
            activeEl.classList.add('view-spring-transition')
            setTimeout(() => activeEl.classList.remove('view-spring-transition'), 360)
        }
    }

    bindOverviewEvents() {
        // Status filter tabs
        this.events.on(this.dom.overviewStatusTabs, 'click', (e) => {
            const btn = e.target.closest('.overview-tab-btn')
            if (!btn) return
            const status = btn.dataset.status || 'all'
            this.overviewStatus = status
            this.updateOverviewControlsUI()
            this.updateOverviewActiveFiltersBar()
            this.refreshBookshelf()
        })

        // In-place search input
        let ovSearchTimer = null
        this.events.on(this.dom.overviewSearchInput, 'input', (e) => {
            this.overviewSearchQuery = e.target.value
            clearTimeout(ovSearchTimer)
            ovSearchTimer = setTimeout(() => {
                this.updateOverviewActiveFiltersBar()
                this.refreshBookshelf()
            }, 150)
        })

        // Rating filter popover trigger
        this.events.on(this.dom.btnOverviewRatingTrigger, 'click', (e) => {
            e.stopPropagation()
            const isOpen = this.dom.overviewRatingPopover && this.dom.overviewRatingPopover.style.display !== 'none'
            this.closeOverviewPopovers()
            if (!isOpen && this.dom.overviewRatingPopover) {
                this.dom.overviewRatingPopover.style.display = 'block'
                this.dom.btnOverviewRatingTrigger.closest('.overview-popover-wrap')?.classList.add('open')
                this.syncRatingPopoverUI()
                this.adjustOverviewPopoverPosition(this.dom.overviewRatingPopover, this.dom.btnOverviewRatingTrigger)
            }
        })

        this.events.on(this.dom.overviewRatingPopover, 'click', (e) => {
            e.stopPropagation()
        })
        this.events.on(this.dom.overviewRatingPopover, 'keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                this.closeOverviewPopovers()
                this.dom.btnOverviewRatingTrigger?.focus()
            }
        })

        let ratingSliderTimer = null
        const handleDualSliderInput = (e) => {
            if (this.dom.overviewUnratedCheckbox) this.dom.overviewUnratedCheckbox.checked = false
            let minVal = parseFloat(this.dom.overviewRatingSliderMin?.value ?? 0)
            let maxVal = parseFloat(this.dom.overviewRatingSliderMax?.value ?? 5.0)

            if (e.target === this.dom.overviewRatingSliderMin) {
                if (minVal > maxVal) {
                    maxVal = minVal
                    if (this.dom.overviewRatingSliderMax) this.dom.overviewRatingSliderMax.value = maxVal
                }
            } else if (e.target === this.dom.overviewRatingSliderMax) {
                if (maxVal < minVal) {
                    minVal = maxVal
                    if (this.dom.overviewRatingSliderMin) this.dom.overviewRatingSliderMin.value = minVal
                }
            }

            this.setOverviewRatingRange(minVal, maxVal, false)
            this.syncRatingPopoverUI(false)
            clearTimeout(ratingSliderTimer)
            ratingSliderTimer = setTimeout(() => {
                this.updateOverviewActiveFiltersBar()
                this.refreshBookshelf()
            }, 120)
        }

        this.events.on(this.dom.overviewRatingSliderMin, 'input', handleDualSliderInput)
        this.events.on(this.dom.overviewRatingSliderMax, 'input', handleDualSliderInput)

        // Elevate clicked handle to front
        this.events.on(this.dom.overviewRatingSliderMin, 'mousedown', () => {
            if (this.dom.overviewRatingSliderMin) this.dom.overviewRatingSliderMin.style.zIndex = '5'
            if (this.dom.overviewRatingSliderMax) this.dom.overviewRatingSliderMax.style.zIndex = '4'
        })
        this.events.on(this.dom.overviewRatingSliderMax, 'mousedown', () => {
            if (this.dom.overviewRatingSliderMax) this.dom.overviewRatingSliderMax.style.zIndex = '5'
            if (this.dom.overviewRatingSliderMin) this.dom.overviewRatingSliderMin.style.zIndex = '4'
        })
        this.events.on(this.dom.overviewRatingSliderMin, 'touchstart', () => {
            if (this.dom.overviewRatingSliderMin) this.dom.overviewRatingSliderMin.style.zIndex = '5'
            if (this.dom.overviewRatingSliderMax) this.dom.overviewRatingSliderMax.style.zIndex = '4'
        }, { passive: true })
        this.events.on(this.dom.overviewRatingSliderMax, 'touchstart', () => {
            if (this.dom.overviewRatingSliderMax) this.dom.overviewRatingSliderMax.style.zIndex = '5'
            if (this.dom.overviewRatingSliderMin) this.dom.overviewRatingSliderMin.style.zIndex = '4'
        }, { passive: true })

        this.events.on(this.dom.overviewUnratedCheckbox, 'change', (e) => {
            if (e.target.checked) {
                this.setOverviewRatingRange(0, 5.0, true)
            } else {
                this.setOverviewRatingRange(0, 5.0, false)
            }
            this.syncRatingPopoverUI(true)
            this.updateOverviewActiveFiltersBar()
            this.refreshBookshelf()
        })

        this.events.on(this.dom.btnResetRating, 'click', (e) => {
            e.stopPropagation()
            this.setOverviewRatingRange(0, 5.0, false)
            this.syncRatingPopoverUI(true)
            this.updateOverviewActiveFiltersBar()
            this.refreshBookshelf()
        })

        // Tags dropdown popover trigger
        this.events.on(this.dom.btnOverviewOpenTags, 'click', async (e) => {
            e.stopPropagation()
            const isOpen = this.dom.overviewTagsPopover && this.dom.overviewTagsPopover.style.display !== 'none'
            this.closeOverviewPopovers()
            if (!isOpen && this.dom.overviewTagsPopover) {
                this.dom.overviewTagsPopover.style.display = 'block'
                this.dom.btnOverviewOpenTags.closest('.overview-popover-wrap')?.classList.add('open')
                await this.renderOverviewTagsPopoverList()
                this.adjustOverviewPopoverPosition(this.dom.overviewTagsPopover, this.dom.btnOverviewOpenTags)
            }
        })

        this.events.on(this.dom.overviewTagsPopover, 'click', (e) => {
            e.stopPropagation()
        })
        this.events.on(this.dom.overviewTagsPopover, 'keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation()
                this.closeOverviewPopovers()
                this.dom.btnOverviewOpenTags?.focus()
            }
        })

        this.events.on(this.dom.btnPopoverManageTags, 'click', (e) => {
            e.stopPropagation()
            this.closeOverviewPopovers()
            this.openGlobalTagsModal()
        })

        // Global dismiss for overview popovers
        this.events.on(document, 'click', () => {
            this.closeOverviewPopovers()
        })

        // Rating filter fallback select change
        this.events.on(this.dom.overviewRatingFilterSelect, 'change', (e) => {
            this.overviewRatingFilter = e.target.value
            this.syncRatingPopoverUI()
            this.updateOverviewActiveFiltersBar()
            this.refreshBookshelf()
        })

        // Toggle Year-Month Grouping for finished books
        this.events.on(this.dom.btnOverviewToggleGrouping, 'click', () => {
            this.overviewGroupByYearMonth = !this.overviewGroupByYearMonth
            this.updateOverviewControlsUI()
            this.refreshBookshelf()
        })

        // Clear active filters button
        this.events.on(this.dom.btnClearOverviewFilters, 'click', () => {
            this.clearOverviewFilters()
        })

        // Global tags modal events
        this.events.on(this.dom.inputGlobalTagSearch, 'input', () => {
            this.renderGlobalTagsList()
        })

        this.events.on(this.dom.btnToggleTagManagement, 'click', () => {
            this.tagManagementMode = !this.tagManagementMode
            if (this.dom.btnToggleTagManagement) {
                this.dom.btnToggleTagManagement.innerText = this.tagManagementMode ? t('bookshelf.exitTagManageMode') : t('modal.tagLibManageMode')
            }
            this.renderGlobalTagsList()
        })

        this.events.on(this.dom.btnCloseGlobalTags, 'click', () => {
            this.closeGlobalTagsModal()
        })

        this.events.on(this.dom.btnConfirmGlobalTags, 'click', () => {
            this.closeGlobalTagsModal()
        })

        this.events.on(this.dom.modalGlobalTags, 'click', (e) => {
            if (e.target === this.dom.modalGlobalTags) {
                this.closeGlobalTagsModal()
            }
        })

        // Heatmap day details close button
        
    }

    initShelfSidebar() {
        // Each launch starts collapsed, including profiles with a legacy '0'.
        this.sidebarUserCollapsed = true
        const view = document.getElementById('bookshelf-view')
        view?.classList.add('sidebar-collapsed')
        this._shelfSidebarController?.abort()
        const controller = new AbortController()
        this._shelfSidebarController = controller
        const setCollapsed = collapsed => {
            this.sidebarUserCollapsed = collapsed
            view?.classList.toggle('sidebar-collapsed', collapsed)
        }
        this.dom.btnSidebarCollapse?.addEventListener('click', () => setCollapsed(true), { signal: controller.signal })
        this.dom.btnHeaderExpandSidebar?.addEventListener('click', () => setCollapsed(false), { signal: controller.signal })
    }

    _resolveCategoryTitle(cat = this.shelfCategory) {
        const titles = {
            all: t('nav.allBooks'),
            recent: t('nav.recentOpened'),
            favorite: t('nav.favorites'),
            overview: t('nav.readingOverview'),
            stats: t('nav.readingStats'),
            'ai-history': t('nav.aiHistory'),
            notes: t('nav.highlightsAndNotes')
        }
        let title = titles[cat]
        if (!title && cat && cat.startsWith('list_')) {
            const custom = this.customLists?.find(l => l.id === cat)
            title = custom ? custom.name : t('bookshelf.listFallbackTitle')
        }
        return title || t('nav.allBooks')
    }

    async switchShelfCategory(cat, options = {}) {
        // Support 'finished' navigation alias -> map to overview with finished status
        if (cat === 'finished') {
            cat = 'overview'
            options.status = 'finished'
        }

        const prevCategory = this.shelfCategory
        const categoryChanged = prevCategory !== cat
        this.shelfCategory = cat

        // Update overview filter state without mutating layout before books load
        if (cat === 'overview') {
            if (options.status) {
                this.overviewStatus = options.status
            }
            if (options.tags) {
                this.overviewSelectedTags = new Set(options.tags)
            }
            if (options.rating != null) {
                this.overviewRatingFilter = options.rating
            }
            if (options.search != null) {
                this.overviewSearchQuery = options.search
            }
        }

        // Update nav items active class immediately for responsive click feedback
        this.dom.navCategoryItems?.forEach(item => {
            const isTarget = item.dataset.category === cat || (cat === 'overview' && item.dataset.category === 'overview')
            item.classList.toggle('active', isTarget)
        })
        document.querySelectorAll('.custom-list-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.id === cat)
        })

        const returningToAllBooks = cat === 'all' && Boolean(prevCategory && prevCategory !== 'all')
        const shouldLandOnShelf = Boolean(options.landOnShelf || (returningToAllBooks && !options.allowHero))

        await this.refreshBookshelf({
            resetScroll: categoryChanged && !options.preserveScroll && !shouldLandOnShelf,
            landOnShelf: shouldLandOnShelf
        })
    }

    normalizeRatingFilter(filterVal) {
        if (!filterVal || filterVal === 'all') return 'all'
        if (filterVal === 'unrated') return 'unrated'
        if (typeof filterVal === 'string' && filterVal.includes('-')) {
            const parts = filterVal.split('-')
            const p0 = parseFloat(parts[0])
            const p1 = parseFloat(parts[1])
            const num0 = Number.isFinite(p0) ? p0 : 0.0
            const num1 = Number.isFinite(p1) ? p1 : 5.0
            const min = Math.min(5.0, Math.max(0.0, Math.round(num0 * 2) / 2))
            const max = Math.min(5.0, Math.max(0.0, Math.round(num1 * 2) / 2))
            const actualMin = Math.min(min, max)
            const actualMax = Math.max(min, max)
            if (actualMin === 0.0 && actualMax === 5.0) return 'all'
            return `${actualMin.toFixed(1)}-${actualMax.toFixed(1)}`
        }
        const num = parseFloat(filterVal)
        if (isNaN(num) || num <= 0) return 'all'
        const stepped = Math.min(5.0, Math.max(0.5, Math.ceil(num * 2) / 2))
        return stepped.toFixed(1)
    }

    getOverviewRatingRange() {
        if (!this.overviewRatingFilter || this.overviewRatingFilter === 'all') {
            return { isAll: true, isUnrated: false, min: 0.0, max: 5.0 }
        }
        if (this.overviewRatingFilter === 'unrated') {
            return { isAll: false, isUnrated: true, min: 0.0, max: 5.0 }
        }
        if (typeof this.overviewRatingFilter === 'string' && this.overviewRatingFilter.includes('-')) {
            const parts = this.overviewRatingFilter.split('-')
            const p0 = parseFloat(parts[0])
            const p1 = parseFloat(parts[1])
            const num0 = Number.isFinite(p0) ? p0 : 0.0
            const num1 = Number.isFinite(p1) ? p1 : 5.0
            const min = Math.min(5.0, Math.max(0.0, num0))
            const max = Math.min(5.0, Math.max(0.0, num1))
            const actualMin = Math.min(min, max)
            const actualMax = Math.max(min, max)
            return {
                isAll: actualMin === 0.0 && actualMax === 5.0,
                isUnrated: false,
                min: actualMin,
                max: actualMax
            }
        }
        const num = parseFloat(this.overviewRatingFilter)
        if (!isNaN(num) && num > 0) {
            return { isAll: false, isUnrated: false, min: num, max: 5.0 }
        }
        return { isAll: true, isUnrated: false, min: 0.0, max: 5.0 }
    }

    setOverviewRatingRange(min, max, isUnrated = false) {
        if (isUnrated) {
            this.overviewRatingFilter = 'unrated'
            return
        }
        const stepMin = Math.min(5.0, Math.max(0.0, Math.round(min * 2) / 2))
        const stepMax = Math.min(5.0, Math.max(0.0, Math.round(max * 2) / 2))
        const actualMin = Math.min(stepMin, stepMax)
        const actualMax = Math.max(stepMin, stepMax)
        if (actualMin === 0.0 && actualMax === 5.0) {
            this.overviewRatingFilter = 'all'
        } else {
            this.overviewRatingFilter = `${actualMin.toFixed(1)}-${actualMax.toFixed(1)}`
        }
    }

    adjustOverviewPopoverPosition(popoverEl, triggerEl) {
        if (!popoverEl || !triggerEl || popoverEl.style.display === 'none') return
        popoverEl.style.transform = ''
        const rect = popoverEl.getBoundingClientRect()
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth
        const minMargin = 12

        let shiftX = 0
        if (rect.right > viewportWidth - minMargin) {
            shiftX = (viewportWidth - minMargin) - rect.right
        }
        if (rect.left + shiftX < minMargin) {
            shiftX = minMargin - rect.left
        }

        if (Math.abs(shiftX) > 0.5) {
            popoverEl.style.transform = `translateX(${Math.round(shiftX)}px)`
        }
    }

    closeOverviewPopovers() {
        if (this.dom.overviewRatingPopover) this.dom.overviewRatingPopover.style.display = 'none'
        if (this.dom.overviewTagsPopover) this.dom.overviewTagsPopover.style.display = 'none'
        document.querySelectorAll('.overview-popover-wrap.open').forEach(w => w.classList.remove('open'))
    }

    syncRatingPopoverUI(syncSliders = true) {
        this.overviewRatingFilter = this.normalizeRatingFilter(this.overviewRatingFilter)
        const range = this.getOverviewRatingRange()
        const isUnrated = range.isUnrated
        const isAll = range.isAll

        if (this.dom.overviewUnratedCheckbox) {
            this.dom.overviewUnratedCheckbox.checked = isUnrated
        }

        if (syncSliders) {
            if (this.dom.overviewRatingSliderMin) {
                this.dom.overviewRatingSliderMin.value = isUnrated ? 0 : range.min
            }
            if (this.dom.overviewRatingSliderMax) {
                this.dom.overviewRatingSliderMax.value = isUnrated ? 5.0 : range.max
            }
        }

        // Update track highlight
        const trackHighlight = this.dom.overviewRatingTrackHighlight || document.getElementById('overview-rating-track-highlight')
        if (trackHighlight) {
            if (isUnrated) {
                trackHighlight.style.left = '0%'
                trackHighlight.style.right = '100%'
            } else {
                const minPct = (range.min / 5.0) * 100
                const maxPct = (range.max / 5.0) * 100
                trackHighlight.style.left = `${minPct}%`
                trackHighlight.style.right = `${100 - maxPct}%`
            }
        }

        if (this.dom.overviewRatingValDisplay) {
            if (isUnrated) {
                this.dom.overviewRatingValDisplay.innerText = t('overview.ratingOnlyUnrated')
            } else if (isAll) {
                this.dom.overviewRatingValDisplay.innerText = t('overview.ratingRangeAll')
            } else if (range.min === range.max) {
                this.dom.overviewRatingValDisplay.innerText = t('bookshelf.ratingExactDisplay', { score: range.min.toFixed(1) })
            } else if (range.min === 0.0) {
                this.dom.overviewRatingValDisplay.innerText = t('bookshelf.ratingMaxDisplay', { score: range.max.toFixed(1) })
            } else if (range.max === 5.0) {
                this.dom.overviewRatingValDisplay.innerText = t('bookshelf.ratingMinDisplay', { score: range.min.toFixed(1) })
            } else {
                this.dom.overviewRatingValDisplay.innerText = t('bookshelf.ratingRangeDisplay', { min: range.min.toFixed(1), max: range.max.toFixed(1) })
            }
        }

        if (this.dom.overviewRatingTriggerText) {
            if (isUnrated) {
                this.dom.overviewRatingTriggerText.innerText = t('bookshelf.ratingTriggerUnrated')
            } else if (isAll) {
                this.dom.overviewRatingTriggerText.innerText = t('overview.ratingBtnAll')
            } else if (range.min === range.max) {
                this.dom.overviewRatingTriggerText.innerText = t('bookshelf.ratingTriggerExact', { score: range.min.toFixed(1) })
            } else if (range.min === 0.0) {
                this.dom.overviewRatingTriggerText.innerText = t('bookshelf.ratingTriggerMax', { score: range.max.toFixed(1) })
            } else if (range.max === 5.0) {
                this.dom.overviewRatingTriggerText.innerText = t('bookshelf.ratingTriggerMin', { score: range.min.toFixed(1) })
            } else {
                this.dom.overviewRatingTriggerText.innerText = t('bookshelf.ratingTriggerRange', { min: range.min.toFixed(1), max: range.max.toFixed(1) })
            }
        }

        if (this.dom.btnOverviewRatingTrigger) {
            this.dom.btnOverviewRatingTrigger.classList.toggle('active', !isAll)
        }

        if (this.dom.overviewRatingFilterSelect) {
            this.dom.overviewRatingFilterSelect.value = this.overviewRatingFilter
        }
    }

    async renderOverviewTagsPopoverList() {
        if (!this.dom.overviewTagsPopoverList) return
        const container = this.dom.overviewTagsPopoverList
        container.innerHTML = `<div style="padding: 8px; color: var(--text-muted); font-size: 0.78rem;">${escapeHTML(t('bookshelf.loadingTags'))}</div>`

        const tagsWithCounts = await getAllTagsWithCounts()
        container.innerHTML = ''

        // All tags (clear filter) option
        const allItem = document.createElement('div')
        const isAllActive = (!this.overviewSelectedTags || this.overviewSelectedTags.size === 0)
        allItem.className = `overview-tag-popover-item ${isAllActive ? 'active' : ''}`
        allItem.innerHTML = `<span>${escapeHTML(t('bookshelf.allBooksNoTagFilter'))}</span>`
        allItem.addEventListener('click', () => {
            this.overviewSelectedTags.clear()
            this.updateOverviewControlsUI()
            this.updateOverviewActiveFiltersBar()
            this.refreshBookshelf()
            this.closeOverviewPopovers()
        })
        container.appendChild(allItem)

        if (tagsWithCounts.length === 0) {
            const emptyHint = document.createElement('div')
            emptyHint.style.cssText = 'padding: 8px; color: var(--text-muted); font-size: 0.75rem;'
            emptyHint.innerText = t('bookshelf.noTagsYetHint')
            container.appendChild(emptyHint)
            return
        }

        tagsWithCounts.forEach(tagItem => {
            const item = document.createElement('div')
            const isSelected = this.overviewSelectedTags && this.overviewSelectedTags.has(tagItem.name)
            const countText = t(tagItem.count === 1 ? 'bookshelf.countBooksOne' : 'bookshelf.countBooksMany', { count: tagItem.count })
            item.className = `overview-tag-popover-item ${isSelected ? 'active' : ''}`
            item.innerHTML = `
                <span class="overview-tag-popover-name">${escapeHTML(tagItem.name)}</span>
                <span class="overview-tag-popover-count">${escapeHTML(countText)}</span>
            `
            item.addEventListener('click', () => {
                if (this.overviewSelectedTags.has(tagItem.name)) {
                    this.overviewSelectedTags.delete(tagItem.name)
                } else {
                    this.overviewSelectedTags.clear()
                    this.overviewSelectedTags.add(tagItem.name)
                }
                this.updateOverviewControlsUI()
                this.updateOverviewActiveFiltersBar()
                this.refreshBookshelf()
                this.closeOverviewPopovers()
            })
            container.appendChild(item)
        })
    }

    updateOverviewControlsUI() {
        this.dom.overviewStatusTabs?.querySelectorAll('.overview-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.status === this.overviewStatus)
        })
        this.syncRatingPopoverUI()
        if (this.dom.overviewTagsBtnText && this.dom.btnOverviewOpenTags) {
            if (this.overviewSelectedTags && this.overviewSelectedTags.size > 0) {
                const tagArr = Array.from(this.overviewSelectedTags)
                this.dom.overviewTagsBtnText.innerText = tagArr.length === 1
                    ? t('bookshelf.tagsBtnSingle', { tag: tagArr[0] })
                    : t('bookshelf.tagsBtnMulti', { count: tagArr.length })
                this.dom.btnOverviewOpenTags.classList.add('active')
            } else {
                this.dom.overviewTagsBtnText.innerText = t('overview.filterTagBtn')
                this.dom.btnOverviewOpenTags.classList.remove('active')
            }
        }
        if (this.dom.overviewSearchInput && this.dom.overviewSearchInput.value !== this.overviewSearchQuery) {
            this.dom.overviewSearchInput.value = this.overviewSearchQuery
        }
        if (this.dom.btnOverviewToggleGrouping) {
            const isFinished = this.overviewStatus === 'finished'
            this.dom.btnOverviewToggleGrouping.style.display = isFinished ? 'inline-flex' : 'none'
            this.dom.btnOverviewToggleGrouping.classList.toggle('active', this.overviewGroupByYearMonth)
            if (this.dom.overviewGroupingText) {
                this.dom.overviewGroupingText.innerText = this.overviewGroupByYearMonth
                    ? t('bookshelf.ungroupBtn')
                    : t('overview.groupByMonthBtn')
            }
        }
    }

    updateOverviewActiveFiltersBar() {
        if (!this.dom.overviewActiveFiltersBar || !this.dom.overviewActiveFiltersPills) return

        const pills = []
        if (this.overviewSelectedTags && this.overviewSelectedTags.size > 0) {
            for (const tag of this.overviewSelectedTags) {
                pills.push({ type: 'tag', value: tag, label: t('bookshelf.pillTag', { tag }) })
            }
        }
        if (this.overviewRatingFilter && this.overviewRatingFilter !== 'all') {
            let ratingLabel = ''
            if (this.overviewRatingFilter === 'unrated') {
                ratingLabel = t('bookshelf.pillRatingUnrated')
            } else {
                const range = this.getOverviewRatingRange()
                if (range.min === range.max) {
                    ratingLabel = t('bookshelf.pillRatingExact', { score: range.min.toFixed(1) })
                } else if (range.min === 0.0) {
                    ratingLabel = t('bookshelf.pillRatingMax', { score: range.max.toFixed(1) })
                } else if (range.max === 5.0) {
                    ratingLabel = t('bookshelf.pillRatingMin', { score: range.min.toFixed(1) })
                } else {
                    ratingLabel = t('bookshelf.pillRatingRange', { min: range.min.toFixed(1), max: range.max.toFixed(1) })
                }
            }
            pills.push({ type: 'rating', value: this.overviewRatingFilter, label: ratingLabel })
        }
        if (this.overviewSearchQuery && this.overviewSearchQuery.trim()) {
            pills.push({ type: 'search', value: this.overviewSearchQuery.trim(), label: t('bookshelf.pillSearch', { query: this.overviewSearchQuery.trim() }) })
        }

        if (pills.length === 0) {
            this.dom.overviewActiveFiltersBar.style.display = 'none'
            this.dom.overviewActiveFiltersPills.innerHTML = ''
            return
        }

        this.dom.overviewActiveFiltersBar.style.display = 'flex'
        this.dom.overviewActiveFiltersPills.innerHTML = ''

        pills.forEach(p => {
            const el = document.createElement('span')
            el.className = 'active-filter-pill'
            el.innerHTML = `${escapeHTML(p.label)} <span class="pill-remove" title="${escapeHTML(t('bookshelf.removeFilterTitle'))}">×</span>`
            el.querySelector('.pill-remove')?.addEventListener('click', (e) => {
                e.stopPropagation()
                if (p.type === 'tag') {
                    this.overviewSelectedTags.delete(p.value)
                } else if (p.type === 'rating') {
                    this.overviewRatingFilter = 'all'
                    this.syncRatingPopoverUI()
                } else if (p.type === 'search') {
                    this.overviewSearchQuery = ''
                    if (this.dom.overviewSearchInput) this.dom.overviewSearchInput.value = ''
                }
                this.updateOverviewActiveFiltersBar()
                this.refreshBookshelf()
            })
            this.dom.overviewActiveFiltersPills.appendChild(el)
        })
    }

    clearOverviewFilters(resetStatus = false) {
        const hadFilters = (this.overviewSelectedTags && this.overviewSelectedTags.size > 0) ||
                           (this.overviewRatingFilter && this.overviewRatingFilter !== 'all') ||
                           (this.overviewSearchQuery && this.overviewSearchQuery.trim() !== '')

        this.overviewSelectedTags.clear()
        this.overviewRatingFilter = 'all'
        this.overviewSearchQuery = ''
        if (this.dom.overviewSearchInput) this.dom.overviewSearchInput.value = ''
        this.syncRatingPopoverUI()

        if (resetStatus || (!hadFilters && this.overviewStatus !== 'all')) {
            this.overviewStatus = 'all'
        }

        this.updateOverviewControlsUI()
        this.updateOverviewActiveFiltersBar()
        this.refreshBookshelf()
    }

    async openGlobalTagsModal() {
        if (!this.dom.modalGlobalTags) return
        this.dom.modalGlobalTags.style.display = 'flex'
        this.dom.modalGlobalTags.classList.add('show')
        this.tagManagementMode = false
        if (this.dom.btnToggleTagManagement) {
            this.dom.btnToggleTagManagement.innerText = t('modal.tagLibManageMode')
        }
        if (this.dom.inputGlobalTagSearch) {
            this.dom.inputGlobalTagSearch.value = ''
        }
        await this.renderGlobalTagsList()
    }

    closeGlobalTagsModal() {
        if (this.dom.modalGlobalTags) {
            this.dom.modalGlobalTags.classList.remove('show')
            this.dom.modalGlobalTags.style.display = 'none'
        }
    }

    async renderGlobalTagsList() {
        if (!this.dom.globalTagsListContainer) return
        const filterQuery = (this.dom.inputGlobalTagSearch?.value || '').trim().toLowerCase()

        let tagsWithCounts = await getAllTagsWithCounts()
        if (filterQuery) {
            tagsWithCounts = tagsWithCounts.filter(tagItem => tagItem.name.toLowerCase().includes(filterQuery))
        }

        this.dom.globalTagsListContainer.innerHTML = ''
        if (tagsWithCounts.length === 0) {
            if (this.dom.globalTagsEmptyHint) this.dom.globalTagsEmptyHint.style.display = 'block'
            return
        }
        if (this.dom.globalTagsEmptyHint) this.dom.globalTagsEmptyHint.style.display = 'none'

        tagsWithCounts.forEach(tagItem => {
            const chip = document.createElement('div')
            const isSelected = this.overviewSelectedTags.has(tagItem.name)
            chip.className = `global-tag-chip ${isSelected ? 'active' : ''}`

            let manageActionsHtml = ''
            if (this.tagManagementMode) {
                manageActionsHtml = `
                    <div class="global-tag-manage-actions">
                        <button type="button" class="btn-tag-action btn-rename" title="${escapeHTML(t('bookshelf.tagRenameOrMergeTitle'))}">${uiSymbol('edit')}</button>
                        <button type="button" class="btn-tag-action btn-delete" title="${escapeHTML(t('bookshelf.tagDeleteGlobalTitle'))}">${uiSymbol('trash')}</button>
                    </div>
                `
            }

            chip.innerHTML = `
                <span class="global-tag-name">${escapeHTML(tagItem.name)}</span>
                <span class="global-tag-count">(${tagItem.count})</span>
                ${manageActionsHtml}
            `

            if (this.tagManagementMode) {
                chip.querySelector('.btn-rename')?.addEventListener('click', async (e) => {
                    e.stopPropagation()
                    const newName = await this.app.dialogs.showInputDialog({
                        title: t('bookshelf.renameTagTitle'),
                        label: t('bookshelf.renameTagPrompt', { name: tagItem.name, count: tagItem.count }),
                        defaultValue: tagItem.name
                    })
                    if (newName && newName.trim() && newName.trim() !== tagItem.name) {
                        const res = await renameTagGlobally(tagItem.name, newName.trim())
                        if (res && res.success) {
                            this.app.dialogs.showToast(t('bookshelf.renameTagSuccess', { count: res.updatedCount }), 'success')
                            if (this.overviewSelectedTags.has(tagItem.name)) {
                                this.overviewSelectedTags.delete(tagItem.name)
                                this.overviewSelectedTags.add(normalizeTag(newName.trim()))
                                this.updateOverviewActiveFiltersBar()
                            }
                            await this.renderGlobalTagsList()
                            await this.refreshBookshelf()
                        } else {
                            this.app.dialogs.showToast(res?.error || t('bookshelf.renameTagFailed'), '!')
                        }
                    }
                })

                chip.querySelector('.btn-delete')?.addEventListener('click', async (e) => {
                    e.stopPropagation()
                    const confirmed = await this.app.dialogs.showConfirmDialog(
                        t('bookshelf.deleteTagConfirm', { name: tagItem.name, count: tagItem.count })
                    )
                    if (confirmed) {
                        const res = await deleteTagGlobally(tagItem.name)
                        if (res && res.success) {
                            this.app.dialogs.showToast(t('bookshelf.deleteTagSuccess', { name: tagItem.name, count: res.updatedCount }), 'success')
                            if (this.overviewSelectedTags.has(tagItem.name)) {
                                this.overviewSelectedTags.delete(tagItem.name)
                                this.updateOverviewActiveFiltersBar()
                            }
                            await this.renderGlobalTagsList()
                            await this.refreshBookshelf()
                        } else {
                            this.app.dialogs.showToast(res?.error || t('bookshelf.deleteTagFailed'), '!')
                        }
                    }
                })
            } else {
                chip.addEventListener('click', () => {
                    if (this.overviewSelectedTags.has(tagItem.name)) {
                        this.overviewSelectedTags.delete(tagItem.name)
                        chip.classList.remove('active')
                    } else {
                        this.overviewSelectedTags.add(tagItem.name)
                        chip.classList.add('active')
                    }
                    this.updateOverviewActiveFiltersBar()
                    if (this.shelfCategory === 'overview') {
                        this.refreshBookshelf()
                    }
                })
            }

            this.dom.globalTagsListContainer.appendChild(chip)
        })
    }

    toggleBatchMode(enable) {
        this.isBatchMode = typeof enable === 'boolean' ? enable : !this.isBatchMode
        if (!this.isBatchMode) {
            this.selectedBookIds.clear()
        }
        if (this.app.dom.bookshelfView) {
            this.app.dom.bookshelfView.classList.toggle('is-batch-mode', this.isBatchMode)
        }
        if (this.dom.btnBatchMode) {
            this.dom.btnBatchMode.classList.toggle('active', this.isBatchMode)
        }
        if (this.dom.batchActionsBar) {
            this.dom.batchActionsBar.style.display = this.isBatchMode ? 'flex' : 'none'
        }
        this.updateBatchSelectionUI()
        this.refreshBookshelf()
    }

    toggleBookSelection(bookId) {
        if (!bookId) return
        if (this.selectedBookIds.has(bookId)) {
            this.selectedBookIds.delete(bookId)
        } else {
            this.selectedBookIds.add(bookId)
        }
        this.updateBatchSelectionUI()
    }

    updateBatchSelectionUI() {
        const count = this.selectedBookIds.size
        if (this.dom.batchSelectedCount) {
            this.dom.batchSelectedCount.innerText = t('bookshelf.batchSelectedCount', { count })
        }
        if (this.dom.btnBatchTags) {
            this.dom.btnBatchTags.disabled = count === 0
        }
        if (this.dom.btnBatchDelete) {
            this.dom.btnBatchDelete.disabled = count === 0
        }
        if (this.dom.btnBatchSelectAll) {
            const total = (this.currentBooksList || []).length
            this.dom.btnBatchSelectAll.innerText = (total > 0 && count === total)
                ? t('bookshelf.batchDeselectAll')
                : t('modal.batchSelectAll')
        }

        const shelfCards = document.querySelectorAll('.leaf-book-card, .leaf-table-row')
        shelfCards.forEach(card => {
            const id = card.dataset.id
            if (!id) return
            const isSel = this.selectedBookIds.has(id)
            card.classList.toggle('selected', isSel)
            const checkbox = card.querySelector('.card-batch-checkbox')
            if (checkbox) {
                checkbox.classList.toggle('selected', isSel)
                checkbox.title = isSel ? t('bookshelf.deselect') : t('bookshelf.select')
            }
        })
    }

    handleBatchSelectAll() {
        const total = (this.currentBooksList || []).length
        if (total === 0) return
        if (this.selectedBookIds.size === total) {
            this.selectedBookIds.clear()
        } else {
            for (const b of this.currentBooksList) {
                if (b.id) this.selectedBookIds.add(b.id)
            }
        }
        this.updateBatchSelectionUI()
    }

    openBatchTagsModal() {
        if (this.selectedBookIds.size === 0) {
            this.app.dialogs.showToast(t('bookshelf.batchSelectBooksFirst'), 'warning')
            return
        }
        if (!this.dom.modalBatchTags) return

        if (this.dom.batchTagsPrompt) {
            this.dom.batchTagsPrompt.innerText = t('bookshelf.batchTagsSelectedPrompt', { count: this.selectedBookIds.size })
        }
        if (this.dom.inputBatchTag) {
            this.dom.inputBatchTag.value = ''
        }

        const selectedBooks = (this.currentBooksList || []).filter(b => this.selectedBookIds.has(b.id))
        const tagCounts = new Map()
        for (const book of selectedBooks) {
            const tags = Array.isArray(book.tags) ? book.tags : []
            for (const tagName of tags) {
                tagCounts.set(tagName, (tagCounts.get(tagName) || 0) + 1)
            }
        }

        if (this.dom.batchExistingTagsList) {
            this.dom.batchExistingTagsList.innerHTML = ''
            if (tagCounts.size === 0) {
                this.dom.batchExistingTagsList.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(t('bookshelf.batchTagsEmpty'))}</span>`
            } else {
                for (const [tag, count] of tagCounts.entries()) {
                    const badge = document.createElement('button')
                    badge.type = 'button'
                    badge.className = 'tags-badge batch-tag-removable-chip'
                    badge.title = t('bookshelf.batchTagRemoveTooltip', { tag })
                    badge.innerHTML = `<span class="batch-tag-name">${escapeHTML(tag)}</span><span class="batch-tag-count">${count}/${selectedBooks.length}</span><span class="batch-tag-remove-x" aria-hidden="true">×</span>`
                    badge.addEventListener('click', async () => {
                        await this.handleBatchRemoveTag(tag)
                    })
                    this.dom.batchExistingTagsList.appendChild(badge)
                }
            }
        }

        this.dom.modalBatchTags.style.display = 'flex'
        this.dom.modalBatchTags.classList.add('show')
        this.dom.inputBatchTag?.focus()
    }

    closeBatchTagsModal() {
        if (!this.dom.modalBatchTags) return
        this.dom.modalBatchTags.classList.remove('show')
        setTimeout(() => {
            if (this.dom.modalBatchTags && !this.dom.modalBatchTags.classList.contains('show')) this.dom.modalBatchTags.style.display = 'none'
        }, 200)
    }

    async handleBatchAddTag() {
        const rawTag = this.dom.inputBatchTag?.value
        const norm = normalizeTag(rawTag)
        if (!norm) {
            this.app.dialogs.showToast(t('bookshelf.tagInvalidControlChars'), 'warning')
            return
        }
        const ids = Array.from(this.selectedBookIds)
        if (ids.length === 0) return

        try {
            const updated = await batchAddTag(ids, norm)
            this.app.dialogs.showToast(t('bookshelf.batchTagAddSuccess', { count: updated, tag: norm }), 'success')
            this.closeBatchTagsModal()
            await this.refreshBookshelf()
        } catch (err) {
            console.error('[BatchTags] Add tag failed:', err)
            this.app.dialogs.showToast(t('bookshelf.batchTagAddFailed'), 'error')
        }
    }

    async handleBatchRemoveTag(tag) {
        if (!tag) return
        const ids = Array.from(this.selectedBookIds)
        if (ids.length === 0) return

        try {
            const updated = await batchRemoveTag(ids, tag)
            this.app.dialogs.showToast(t('bookshelf.batchTagRemoveSuccess', { count: updated, tag }), 'success')
            this.openBatchTagsModal()
            await this.refreshBookshelf()
        } catch (err) {
            console.error('[BatchTags] Remove tag failed:', err)
            this.app.dialogs.showToast(t('bookshelf.batchTagRemoveFailed'), 'error')
        }
    }

    async handleBatchDelete() {
        const count = this.selectedBookIds.size
        if (count === 0) return

        const confirmed = await this.app.dialogs.showConfirmDialog(
            t('bookshelf.batchDeleteTitle', { count }),
            t('bookshelf.batchDeleteMessage', { count })
        )
        if (!confirmed) return

        const ids = Array.from(this.selectedBookIds)
        let deletedCount = 0
        for (const id of ids) {
            try {
                await db.deleteBook(id, true)
                coverUrlPool.revoke(id)
                fullTextSearchEngine.removeBookIndex(id)
                deletedCount++
            } catch (err) {
                console.error(`[BatchDelete] Failed to delete book ${id}:`, err)
            }
        }

        this.app.dialogs.showToast(t('bookshelf.batchDeleteSuccess', { count: deletedCount }), 'success')
        this.selectedBookIds.clear()
        this.toggleBatchMode(false)
        await this.refreshBookshelf()
    }

    _commitCategoryChrome() {
        const isOverview = this.shelfCategory === 'overview'
        if (this.dom.readingOverviewPanel) {
            this.dom.readingOverviewPanel.style.display = isOverview && this.shelfViewMode === 'grid' ? 'block' : 'none'
        }
        if (isOverview) {
            this.updateOverviewControlsUI()
            this.updateOverviewActiveFiltersBar()
        }
        if (this.dom.currentCategoryTitle) {
            const isHeroDefault = this.shelfCategory === 'all' && this.shelfViewMode === 'grid' && !(this.searchQuery && this.searchQuery.trim())
            if (!isHeroDefault) {
                this.dom.currentCategoryTitle.innerText = this._resolveCategoryTitle()
                this.dom.currentCategoryTitle.style.display = 'block'
            }
        }
    }

    async refreshBookshelf(options = {}) {
        const resetScroll = Boolean(options?.resetScroll)
        const landOnShelf = Boolean(options?.landOnShelf)
        const refreshEpoch = ++this._bookshelfRefreshEpoch
        if (this.shelfCategory === 'stats') {
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.dom.readingOverviewPanel) this.dom.readingOverviewPanel.style.display = 'none'
            const wsView = document.getElementById('ai-history-workspace-view')
            if (wsView) wsView.style.display = 'none'
            const notesWsView = document.getElementById('shelf-notes-view')
            if (notesWsView) notesWsView.style.display = 'none'
            const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
            if (notesHeaderActions) notesHeaderActions.style.display = 'none'
            const statsBadge = document.getElementById('shelf-notes-stats-badge')
            if (statsBadge) statsBadge.style.display = 'none'
            if (this.app.stats.dom.statsDashboardContainer) this.app.stats.dom.statsDashboardContainer.style.display = 'block'
            if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
            if (this.dom.bookshelfControlsBar) this.dom.bookshelfControlsBar.style.display = 'none'
            this.dom.bookshelfView?.classList.remove('is-hero-at-top')
            if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
            if (this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.innerText = t('nav.readingStats')
                this.dom.currentCategoryTitle.style.display = 'block'
            }
            if (resetScroll && this.dom.booksWorkspace) this.dom.booksWorkspace.scrollTop = 0
            return this.app.stats.renderStatsDashboard()
        }

        if (this.shelfCategory === 'ai-history') {
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.app.stats.dom.statsDashboardContainer) this.app.stats.dom.statsDashboardContainer.style.display = 'none'
            if (this.dom.readingOverviewPanel) this.dom.readingOverviewPanel.style.display = 'none'
            const notesWsView = document.getElementById('shelf-notes-view')
            if (notesWsView) notesWsView.style.display = 'none'
            const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
            if (notesHeaderActions) notesHeaderActions.style.display = 'none'
            const statsBadge = document.getElementById('shelf-notes-stats-badge')
            if (statsBadge) statsBadge.style.display = 'none'
            if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
            if (this.dom.bookshelfControlsBar) this.dom.bookshelfControlsBar.style.display = 'none'
            this.dom.bookshelfView?.classList.remove('is-hero-at-top')
            if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
            if (this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.innerText = t('nav.aiHistory')
                this.dom.currentCategoryTitle.style.display = 'block'
            }
            const wsView = document.getElementById('ai-history-workspace-view')
            if (wsView) wsView.style.display = 'flex'
            if (resetScroll && this.dom.booksWorkspace) this.dom.booksWorkspace.scrollTop = 0
            const aiSidebar = await ensureAiSidebarLoaded(this.app)
            if (refreshEpoch !== this._bookshelfRefreshEpoch) return
            return aiSidebar?.renderHistoryWorkspace()
        }

        if (this.shelfCategory === 'notes') {
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.app.stats.dom.statsDashboardContainer) this.app.stats.dom.statsDashboardContainer.style.display = 'none'
            if (this.dom.readingOverviewPanel) this.dom.readingOverviewPanel.style.display = 'none'
            const wsView = document.getElementById('ai-history-workspace-view')
            if (wsView) wsView.style.display = 'none'
            if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'none'
            if (this.dom.bookshelfControlsBar) this.dom.bookshelfControlsBar.style.display = 'none'
            this.dom.bookshelfView?.classList.remove('is-hero-at-top')
            if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'none'
            if (this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.innerText = t('nav.highlightsAndNotes')
                this.dom.currentCategoryTitle.style.display = 'block'
            }
            const notesWsView = document.getElementById('shelf-notes-view')
            if (notesWsView) notesWsView.style.display = 'flex'
            const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
            if (notesHeaderActions) notesHeaderActions.style.display = 'flex'
            const statsBadge = document.getElementById('shelf-notes-stats-badge')
            if (statsBadge) statsBadge.style.display = 'inline-flex'
            if (resetScroll && this.dom.booksWorkspace) this.dom.booksWorkspace.scrollTop = 0
            this.app.annotations.updateSidebarNotesCount()
            return this.app.annotations.renderShelfNotesView()
        }

        let books = await db.getAllBooks()
        if (refreshEpoch !== this._bookshelfRefreshEpoch) return
        this.app.annotations.updateSidebarNotesCount()

        // Commit non-shelf workspace teardowns + header chrome atomically after async DB load
        const notesWsView = document.getElementById('shelf-notes-view')
        if (notesWsView) notesWsView.style.display = 'none'
        const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
        if (notesHeaderActions) notesHeaderActions.style.display = 'none'
        const statsBadge = document.getElementById('shelf-notes-stats-badge')
        if (statsBadge) statsBadge.style.display = 'none'
        const wsView = document.getElementById('ai-history-workspace-view')
        if (wsView) wsView.style.display = 'none'
        if (this.app.stats.dom.statsDashboardContainer) this.app.stats.dom.statsDashboardContainer.style.display = 'none'
        if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
        if (this.dom.bookshelfControlsBar) this.dom.bookshelfControlsBar.style.display = 'flex'
        if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'
        this._commitCategoryChrome()
        
        const mobileShell = window.mobileShell?.isMobileViewport() ? window.mobileShell : null
        const isMobileShelf = mobileShell && this.shelfCategory === 'all'
        if (this.shelfCategory === 'all') books = books.filter(book => !book.isRecentOnly)

        // Update reading status counts across all library books
        const statusCounts = {
            all: books.length,
            unread: 0,
            want_to_read: 0,
            reading: 0,
            on_hold: 0,
            finished: 0
        }
        for (const b of books) {
            const state = resolveReadingState(b)
            if (statusCounts[state] != null) {
                statusCounts[state]++
            }
        }
        if (this.shelfCategory === 'overview' && this.dom.overviewStatusTabs) {
            for (const [s, cnt] of Object.entries(statusCounts)) {
                const badge = document.getElementById(`overview-count-${s}`)
                if (badge) badge.innerText = String(cnt)
            }
        }

        // 1. Filter by category
        if (this.shelfCategory === 'overview') {
            if (this.overviewStatus !== 'all') {
                books = books.filter(b => resolveReadingState(b) === this.overviewStatus)
            }
            if (this.overviewSelectedTags && this.overviewSelectedTags.size > 0) {
                const reqTags = Array.from(this.overviewSelectedTags)
                    .map(t => normalizeTag(t))
                    .filter(Boolean)
                    .map(t => t.toLowerCase())
                if (reqTags.length > 0) {
                    books = books.filter(b => {
                        const bTags = (b.tags || [])
                            .map(t => normalizeTag(t))
                            .filter(Boolean)
                            .map(t => t.toLowerCase())
                        return reqTags.every(rt => bTags.includes(rt))
                    })
                }
            }
            if (this.overviewRatingFilter && this.overviewRatingFilter !== 'all') {
                if (this.overviewRatingFilter === 'unrated') {
                    books = books.filter(b => b.rating == null || b.rating === 0)
                } else {
                    const range = this.getOverviewRatingRange()
                    books = books.filter(b => typeof b.rating === 'number' && b.rating > 0 && b.rating >= range.min && b.rating <= range.max)
                }
            }
            if (this.overviewSearchQuery && this.overviewSearchQuery.trim()) {
                const oq = this.overviewSearchQuery.trim().toLowerCase()
                books = books.filter(b => (b.title && b.title.toLowerCase().includes(oq)) || (b.author && b.author.toLowerCase().includes(oq)))
            }
        } else if (this.shelfCategory === 'recent') {
            books = books.filter(b => b.isRecentOnly)
        } else if (this.shelfCategory === 'favorite') {
            books = books.filter(b => b.isFavorite)
        } else if (this.shelfCategory === 'unread' || this.shelfCategory === 'list_unread') {
            books = books.filter(b => resolveReadingState(b) === 'unread')
        } else if (this.shelfCategory === 'finished') {
            books = books.filter(b => resolveReadingState(b) === 'finished')
        } else if (this.shelfCategory.startsWith('list_')) {
            const listId = this.shelfCategory
            books = books.filter(b => b.customListIds && b.customListIds.includes(listId))
        }

        // Toggle header favorite button active state
        this.dom.btnHeaderFavorite?.classList.toggle('active', this.shelfCategory === 'favorite')

        // Toggle header Add Books To List button
        if (this.dom.btnListAddBooks) {
            this.dom.btnListAddBooks.style.display = this.shelfCategory.startsWith('list_') ? 'inline-flex' : 'none'
        }

        // 2. Filter by search query
        if (!isMobileShelf && this.searchQuery.trim()) {
            const q = this.searchQuery.trim().toLowerCase()
            books = books.filter(b => (b.title && b.title.toLowerCase().includes(q)) || (b.author && b.author.toLowerCase().includes(q)))
        }

        const recentNote = document.getElementById('recent-files-note')
        if (recentNote) recentNote.hidden = this.shelfCategory !== 'recent'
        if (this.shelfCategory === 'recent' && this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = t('nav.recentOpened')
            this.dom.currentCategoryTitle.style.display = 'block'
        }

        if (isMobileShelf && mobileShell.shelfFilter !== 'all') {
            books = books.filter(book => resolveReadingState(book) === mobileShell.shelfFilter)
        }

        // 3. Sort books. Quick-open records always follow most recently opened order.
        books.sort((a, b) => {
            if (this.shelfCategory === 'recent') {
                const openedAt = book => book.lastReadAt || book.progress?.updatedAt || book.addedAt || book.createdAt || 0
                return openedAt(b) - openedAt(a)
            }
            let valA = a[this.sortField]
            let valB = b[this.sortField]

            if (this.sortField === 'progress') {
                valA = resolveBookProgressFraction(a)
                valB = resolveBookProgressFraction(b)
            } else if (this.sortField === 'rating') {
                valA = typeof a.rating === 'number' ? a.rating : null
                valB = typeof b.rating === 'number' ? b.rating : null
            } else if (this.sortField === 'lastReadAt') {
                valA = a.lastReadAt || a.updatedAt || a.addedAt || 0
                valB = b.lastReadAt || b.updatedAt || b.addedAt || 0
            } else if (this.sortField === 'addedAt') {
                valA = a.addedAt || a.createdAt || a.updatedAt || 0
                valB = b.addedAt || b.createdAt || b.updatedAt || 0
            }

            const isNullA = valA == null || valA === ''
            const isNullB = valB == null || valB === ''
            if (isNullA && isNullB) return 0
            if (isNullA) return 1
            if (isNullB) return -1

            let res = 0
            if (typeof valA === 'string' || typeof valB === 'string') {
                res = String(valA).localeCompare(String(valB), getLocale())
            } else {
                res = (valA > valB ? 1 : (valA < valB ? -1 : 0))
            }
            return this.sortOrder === 'asc' ? res : -res
        })

        const shelfViewMode = mobileShell ? 'grid' : (this.shelfViewMode === 'list' ? 'list' : 'grid')
        mobileShell?.syncShelfLayout()
        if (isMobileShelf) mobileShell.syncShelfControls(statusCounts, books.length)
        this.currentBooksList = books

        // 4. Update count footer
        this.dom.bookCountFooter.innerText = books.length === 0
            ? t('shelf.zeroBooks')
            : t(books.length === 1 ? 'bookshelf.footerBookCountOne' : 'bookshelf.footerBookCount', { count: books.length })

        // 5. Render active view
        const isHeroEligibleMode = (!this.shelfCategory || this.shelfCategory === 'all') && shelfViewMode === 'grid' && (!this.searchQuery || !this.searchQuery.trim())
        if (!isHeroEligibleMode) {
            this.dom.bookshelfView?.classList.remove('is-hero-at-top')
        }
        if (this.dom.shelfSubbarCount && shelfViewMode !== 'grid') {
            this.dom.shelfSubbarCount.innerText = t('bookshelf.dividerAllCount', { count: books.length })
        }
        if (this.dom.btnBackToHero && shelfViewMode !== 'grid') {
            this.dom.btnBackToHero.style.display = 'none'
        }
        if (shelfViewMode === 'grid') {
            if (this.dom.modernGridWrapper) {
                this.dom.modernGridWrapper.style.display = 'flex'
                if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'grid'
            } else if (this.dom.booksGrid) {
                this.dom.booksGrid.style.display = 'grid'
            }
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'none'
            if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'none'
            this.renderModernThreshold(books)
            if (landOnShelf && !mobileShell && isHeroEligibleMode && this.dom.booksWorkspace) {
                this.dom.booksWorkspace.scrollTop = this._getShelfScreenTop()
            } else if (resetScroll && this.dom.booksWorkspace) {
                this.dom.booksWorkspace.scrollTop = 0
            }
            this._heroScrollState = null
            this.renderBooksGrid(books)
            this.onBooksWorkspaceScroll()
        } else {
            if (this.dom.modernGridWrapper) this.dom.modernGridWrapper.style.display = 'none'
            else if (this.dom.booksGrid) this.dom.booksGrid.style.display = 'none'
            if (this.dom.booksTableContainer) this.dom.booksTableContainer.style.display = 'block'
            if (this.dom.footerStatus) this.dom.footerStatus.style.display = 'flex'
            if (resetScroll && this.dom.booksWorkspace) this.dom.booksWorkspace.scrollTop = 0
            this.renderBooksTable(books)
        }

        if (mobileShell?.currentTab === 'home') mobileShell.refreshContinueReadingCard()
        if (typeof coverUrlPool !== 'undefined') {
            coverUrlPool.pruneUnused()
        }
        this.scheduleIdleCoverOptimization(books)
    }

    scheduleIdleCoverOptimization(books) {
        if (this._coverOptRunning || !books?.length) return
        if (!this._optimizedCoverIds) this._optimizedCoverIds = new Set()
        const candidates = books.filter(book => book.coverBlob instanceof Blob &&
            book.coverBlob.type !== 'image/svg+xml' &&
            (book.coverBlob.size > 140 * 1024 || book._coverNeedsOptimization ||
                (book.coverRevision === undefined && book.coverBlob.size > 10 * 1024)) &&
            !this._optimizedCoverIds.has(book.id))
        if (!candidates.length) return

        this._coverOptRunning = true
        const runNext = async idx => {
            if (!this._bound || idx >= candidates.length || this.app._activeSession) {
                this._coverOptRunning = false
                return
            }
            if (this._isScrolling) {
                this._coverOptResume = () => runNext(idx)
                return
            }
            const item = candidates[idx]
            this._optimizedCoverIds.add(item.id)
            try {
                const compressed = await normalizeCoverBlob(item.coverBlob)
                if (compressed && compressed !== item.coverBlob) {
                    const newRev = (item.coverRevision || 0) + 1
                    item.coverBlob = compressed
                    item.coverRevision = newRev
                    await db.saveBook({ id: item.id, coverBlob: compressed, coverRevision: newRev })
                }
            } catch (_) {}
            if (this._bound) this._coverOptTimer = setTimeout(() => runNext(idx + 1), 120)
        }
        this._coverOptTimer = setTimeout(() => runNext(0), 2000)
    }

    _getBookRenderSignature(book) {
        if (!book) return ''
        const frac = Math.round(resolveBookProgressFraction(book) * 1000)
        const state = resolveReadingState(book)
        const fav = book.isFavorite ? 1 : 0
        const cloud = book.isCloudOnly ? 1 : 0
        const backup = book.cloudBackup?.hasBackup ? 1 : 0
        const sel = (this.isBatchMode && this.selectedBookIds.has(book.id)) ? 1 : 0
        const batch = this.isBatchMode ? 1 : 0
        const coverSig = book.coverBlob ? `${book.coverRevision || book.coverBlob._revision || ''}:${book.coverBlob.size}:${book.coverBlob.type}:${book.updatedAt || 0}` : 'none'
        return `${book.id}|${book.title || ''}|${book.author || ''}|${frac}|${state}|${fav}|${cloud}|${backup}|${ batch }|${sel}|${coverSig}|${book.rating || 0}|${book.totalReadingSeconds || 0}|${getLocale()}|${book.format || ''}|${window.mobileShell?.isMobileViewport() || false}`
    }

    initShelfDelegatedListeners() {
        if (this._shelfDelegatedInitialized) return
        this._shelfDelegatedInitialized = true

        const handleShelfClick = async e => {
            const target = e.target
            if (!target) return

            // If in batch mode, any card click or checkbox click toggles selection
            if (this.isBatchMode) {
                const card = target.closest('.leaf-book-card, .leaf-table-row')
                if (card) {
                    const bookId = card.dataset?.id
                    if (bookId) {
                        e.stopPropagation()
                        e.preventDefault()
                        this.toggleBookSelection(bookId)
                    }
                }
                return
            }

            // 1. Favorite button
            const favBtn = target.closest('.grid-fav-btn, .table-fav-btn')
            if (favBtn) {
                e.stopPropagation()
                const card = favBtn.closest('.leaf-book-card, .leaf-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                favBtn.classList.remove('is-pop-animating')
                void favBtn.offsetWidth
                favBtn.classList.add('is-pop-animating')
                this.events.on(favBtn, 'animationend', () => {
                    favBtn.classList.remove('is-pop-animating')
                }, { once: true })

                const isFav = await db.toggleBookFavorite(bookId)
                const book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (book) book.isFavorite = isFav

                favBtn.classList.toggle('active', isFav)
                favBtn.title = isFav ? t('bookshelf.favRemoveTitle') : t('bookshelf.favAddTitle')

                const coverBox = card.querySelector('.leaf-cover-box')
                if (coverBox) coverBox.classList.toggle('is-favorite', isFav)
                if (favBtn.classList.contains('table-fav-btn')) {
                    favBtn.className = `table-fav-btn ${isFav ? 'active' : ''}`
                    favBtn.style.color = isFav ? '#f59e0b' : 'var(--text-tertiary)'
                }

                const bookTitle = book?.title || t('book.untitled')
                this.app.dialogs.showToast(t(isFav ? 'bookshelf.favAddedToast' : 'bookshelf.favRemovedToast', { title: bookTitle }), 'success')
                if (this.shelfCategory === 'favorite') {
                    this.refreshBookshelf()
                }
                return
            }

            // 2. Cloud button
            const cloudBtn = target.closest('.grid-cloud-btn, .table-cloud-btn')
            if (cloudBtn) {
                e.stopPropagation()
                const card = cloudBtn.closest('.leaf-book-card, .leaf-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                cloudBtn.classList.remove('is-pop-animating')
                void cloudBtn.offsetWidth
                cloudBtn.classList.add('is-pop-animating')
                this.events.on(cloudBtn, 'animationend', () => {
                    cloudBtn.classList.remove('is-pop-animating')
                }, { once: true })

                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (!book) return

                if (book.isCloudOnly) {
                    this.app.sync.handleCloudBookClick(book)
                } else {
                    this.app.sync.handleUploadBookToCloud(book)
                }
                return
            }

            // 3. List button
            const listBtn = target.closest('.grid-list-btn, .table-list-btn')
            if (listBtn) {
                e.stopPropagation()
                const card = listBtn.closest('.leaf-book-card, .leaf-table-row')
                const bookId = card?.dataset?.id
                if (bookId) {
                    this.openManageBookListsModal(bookId)
                }
                return
            }

            // 4. Delete button
            const delBtn = target.closest('.grid-delete-btn, .table-delete-btn')
            if (delBtn) {
                e.stopPropagation()
                const card = delBtn.closest('.leaf-book-card, .leaf-table-row')
                const bookId = card?.dataset?.id
                if (!bookId) return

                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (book) {
                    this.handleDeleteBook(book)
                }
                return
            }

            // 4.5. Book details button
            const detailsBtn = target.closest('.grid-details-btn, .table-details-btn')
            if (detailsBtn) {
                e.stopPropagation()
                const card = detailsBtn.closest('.leaf-book-card, .leaf-table-row')
                const bookId = card?.dataset?.id
                if (bookId) {
                    this.app.openBookDetailsModal(bookId)
                }
                return
            }

            const mobileMore = target.closest('.mobile-book-more-btn')
            if (mobileMore) {
                window.mobileShell.openBookActionSheet(mobileMore.closest('.leaf-book-card').dataset.id, mobileMore)
                return
            }

            // 5. Open book (Ctrl/Cmd/Shift + Click opens in a new independent window)
            const card = target.closest('.leaf-book-card, .leaf-table-row')
            if (card) {
                const bookId = card.dataset.id
                if (!bookId) return
                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (book?.isCloudOnly) {
                    this.app.sync.handleCloudBookClick(book)
                } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    this.app.openBookInNewWindow(bookId)
                } else {
                    this.app.openBook(bookId)
                }
            }
        }

        const handleShelfContextMenu = e => {
            const card = e.target?.closest?.('.leaf-book-card, .leaf-table-row')
            if (card && card.dataset?.id) {
                e.preventDefault()
                this.app.openBookDetailsModal(card.dataset.id)
            }
        }

        this.events.on(this.dom.booksGrid, 'click', handleShelfClick)
        this.events.on(this.dom.booksTableBody, 'click', handleShelfClick)

        const handleShelfAuxClick = e => {
            if (e.button === 1) {
                const card = e.target?.closest?.('.leaf-book-card, .leaf-table-row')
                if (card && card.dataset?.id) {
                    e.preventDefault()
                    this.app.openBookInNewWindow(card.dataset.id)
                }
            }
        }

        this.events.on(this.dom.booksGrid, 'auxclick', handleShelfAuxClick)
        this.events.on(this.dom.booksTableBody, 'auxclick', handleShelfAuxClick)

        this.events.on(this.dom.booksGrid, 'contextmenu', handleShelfContextMenu)
        this.events.on(this.dom.booksTableBody, 'contextmenu', handleShelfContextMenu)

        const handleShelfKeydown = async e => {
            const card = e.target?.closest?.('.leaf-book-card')
            if (!card) return
            const bookId = card.dataset?.id
            if (!bookId) return

            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault()
                if (!this.isBatchMode) {
                    this.toggleBatchMode(true)
                }
                this.toggleBookSelection(bookId)
                return
            }

            if (e.key === 'Enter') {
                e.preventDefault()
                let book = (this.currentBooksList || []).find(b => b.id === bookId)
                if (!book) book = await db.getBook(bookId)
                if (book?.isCloudOnly) {
                    this.app.sync.handleCloudBookClick(book)
                } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    this.app.openBookInNewWindow(bookId)
                } else {
                    this.app.openBook(bookId)
                }
                return
            }

            const cards = Array.from(this.dom.booksGrid?.querySelectorAll('.leaf-book-card') || [])
            const curIdx = cards.indexOf(card)
            if (curIdx === -1) return
            const cols = this._virtualCols || 4

            let nextIdx = -1
            if (e.key === 'ArrowRight') {
                nextIdx = curIdx + 1
            } else if (e.key === 'ArrowLeft') {
                nextIdx = curIdx - 1
            } else if (e.key === 'ArrowDown') {
                nextIdx = curIdx + cols
            } else if (e.key === 'ArrowUp') {
                nextIdx = curIdx - cols
            }

            if (nextIdx >= 0 && nextIdx < cards.length) {
                e.preventDefault()
                cards[nextIdx].focus()
            }
        }
        this.events.on(this.dom.booksGrid, 'keydown', handleShelfKeydown)
    }

    createBookCard(book, cardIndex = 0) {
        const card = document.createElement('div')
        card.className = 'leaf-book-card'
        card.dataset.id = book.id
        card.style.setProperty('--card-index', cardIndex)
        card.setAttribute('tabindex', '0')
        card.setAttribute('role', 'button')
        card.setAttribute('aria-label', t('bookshelf.openBookAria', { title: book.title || t('book.untitled') }))

        const fraction = resolveBookProgressFraction(book)
        const rawPct = fraction * 100
        const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
        
        let coverUrl = ''
        if (book.coverBlob && typeof coverUrlPool !== 'undefined') {
            // Object URLs are cheap; native lazy loading controls actual image
            // decode. Do not leave all cards after #28 dependent on a second map.
            coverUrl = coverUrlPool.getForBook(book)
        } else if (book.cover && typeof book.cover === 'string' && !book.cover.includes('icon.png')) {
            coverUrl = book.cover
        }

        const readTimeStr = (book.totalReadingSeconds && book.totalReadingSeconds >= 60 && tracker?.formatDuration)
            ? tracker.formatDuration(book.totalReadingSeconds)
            : null

        const readingState = resolveReadingState(book)
        let metaHtml = ''
        if (readingState === 'finished') {
            metaHtml = `<span class="leaf-meta-badge-finished">${escapeHTML(t('bookshelf.badgeFinished'))}</span>`
            if (readTimeStr) {
                metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
            }
        } else if (readingState === 'want_to_read') {
            metaHtml = `<span class="leaf-meta-badge-want">${escapeHTML(t('status.wantToRead'))}</span>`
            if (readTimeStr) {
                metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
            }
        } else if (readingState === 'on_hold') {
            metaHtml = `<span class="leaf-meta-badge-hold">${escapeHTML(t('status.onHold'))}</span>`
            if (readTimeStr) {
                metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
            }
        } else if (readingState === 'unread') {
            metaHtml = `<span class="leaf-meta-badge-new">${escapeHTML(t('bookshelf.badgeNewShort'))}</span><span class="leaf-meta-text">${escapeHTML(t('status.unread'))}</span>`
            if (readTimeStr) {
                metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
            }
        } else {
            metaHtml = `<span class="leaf-meta-progress">${progressPct}%</span>`
            if (readTimeStr) {
                metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
            }
        }
        if (typeof book.rating === 'number' && book.rating > 0) {
            metaHtml += `<span class="leaf-meta-dot">·</span><span class="leaf-meta-rating">★${Number(book.rating).toFixed(1)}</span>`
        }

        const isCloud = !!book.isCloudOnly
        const hasBackup = !!(book.cloudBackup?.hasBackup)
        const cloudBtnClass = hasBackup ? 'synced' : ''
        const cloudBtnTitle = hasBackup
            ? t('bookshelf.cloudBackedUpTitle')
            : (isCloud ? t('bookshelf.cloudNutstorePullTitle') : t('bookshelf.cloudBackupActionTitle'))
        const cloudBoxClass = isCloud ? 'is-cloud-only' : ''

        let cloudBadgeHtml = ''
        if (isCloud) {
            const fmtStr = escapeHTML((book.format || 'doc').toUpperCase())
            const sizeStr = book.size ? (book.size >= 1048576 ? (book.size / 1048576).toFixed(1) + 'MB' : (book.size / 1024).toFixed(0) + 'KB') : ''
            cloudBadgeHtml = `
                <div class="cloud-book-badge ${book.format === 'pdf' ? 'is-pdf' : ''}">
                    <span><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 3px; vertical-align: -1px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>${escapeHTML(t('bookshelf.cloudStored'))}</span>
                    <span class="cloud-size-label">${fmtStr} ${sizeStr ? '· ' + sizeStr : ''}</span>
                </div>
            `
        }

        const favActive = book.isFavorite ? 'active' : ''
        const favClass = book.isFavorite ? 'is-favorite' : ''
        const favTitle = book.isFavorite ? t('bookshelf.favRemoveTitle') : t('bookshelf.favAddTitle')

        const isSelected = this.isBatchMode && this.selectedBookIds.has(book.id)
        if (isSelected) {
            card.classList.add('selected')
        }
        const batchCheckboxHtml = this.isBatchMode
            ? `<div class="card-batch-checkbox ${isSelected ? 'selected' : ''}" title="${escapeHTML(isSelected ? t('bookshelf.deselect') : t('bookshelf.select'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>`
            : ''

        const displayTitle = resolveBookTitle(book.title || '', book.filename || '')
        let coverInnerHtml = ''
        if (coverUrl) {
            coverInnerHtml = `<img class="leaf-cover-img" src="${escapeHTML(coverUrl)}" alt="${escapeHTML(displayTitle)}" decoding="async" loading="lazy"/>`
        } else if (book.coverBlob) {
            coverInnerHtml = `<img class="leaf-cover-img lazy-cover" data-book-id="${escapeHTML(book.id)}" alt="${escapeHTML(displayTitle)}" decoding="async" loading="lazy" style="opacity: 0; transition: opacity 0.2s;"/>`
        } else if (typeof window !== 'undefined' && typeof window.renderBookCoverHTML === 'function') {
            coverInnerHtml = window.renderBookCoverHTML(book, '', true)
        } else {
            coverInnerHtml = renderEditorialCoverHTML(book, { thumb: true, displayTitle })
        }

        card.innerHTML = `
            <div class="leaf-cover-box ${favClass} ${cloudBoxClass}" style="position: relative;">
                ${batchCheckboxHtml}
                <button class="grid-fav-btn ${favActive}" title="${escapeHTML(favTitle)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.4l6.3-.9Z"/></svg></button>
                <button class="grid-details-btn" title="${escapeHTML(t('bookshelf.viewDetailsSettingsTitle'))}" aria-label="${escapeHTML(t('bookshelf.viewDetailsAria'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="12" r="2"/></svg></button>
                ${cloudBadgeHtml}
                ${coverInnerHtml}
            </div>
            <div class="leaf-book-meta-row">${metaHtml}</div>
            <div class="leaf-book-title" title="${escapeHTML(displayTitle)}">${escapeHTML(displayTitle)}</div>
            ${window.mobileShell?.isMobileViewport() ? window.mobileShell.renderShelfCardDetails(book, readingState) : ''}
        `
        card._renderSig = this._getBookRenderSignature(book)
        card._coverUrl = coverUrl
        if (!coverUrl && book.coverBlob) {
            this._observeLazyCover(card)
        }
        return card
    }

    _observeLazyCover(card) {
        if (!card) return
        if (!this._shelfCoverObserver && typeof IntersectionObserver !== 'undefined') {
            this._shelfCoverObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const target = entry.target
                        const img = target.querySelector('img.lazy-cover')
                        if (img) {
                            const bookId = img.dataset?.bookId || target.dataset?.id
                            if (bookId) {
                                const book = this._booksMap?.get(bookId) || this.currentBooksList?.find(b => b.id === bookId)
                                if (book?.coverBlob) {
                                    const url = coverUrlPool.getForBook(book)
                                    if (url) {
                                        img.src = url
                                        img.onload = () => { img.style.opacity = '1' }
                                        img.onerror = () => { img.style.opacity = '1' }
                                    }
                                }
                            }
                            img.classList.remove('lazy-cover')
                        }
                        this._shelfCoverObserver.unobserve(target)
                    }
                }
            }, {
                root: this.dom.booksWorkspace || null,
                rootMargin: '400px 0px 400px 0px'
            })
        }
        if (this._shelfCoverObserver) {
            this._shelfCoverObserver.observe(card)
        }
    }

    updateBookCardLocally(bookId, patch = {}) {
        if (!bookId) return false
        const book = this._booksMap?.get(bookId) || this.currentBooksList?.find(b => b.id === bookId)
        if (book) {
            Object.assign(book, patch)
        }
        const card = document.querySelector(`.leaf-book-card[data-id="${bookId}"]`)
        if (card && book) {
            const nextSig = this._getBookRenderSignature(book)
            if (card._renderSig === nextSig) return true
            const metaRow = card.querySelector('.leaf-book-meta-row')
            if (metaRow) {
                const fraction = resolveBookProgressFraction(book)
                const rawPct = fraction * 100
                const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
                const readTimeStr = (book.totalReadingSeconds && book.totalReadingSeconds >= 60 && tracker?.formatDuration)
                    ? tracker.formatDuration(book.totalReadingSeconds)
                    : null
                const readingState = resolveReadingState(book)
                let metaHtml = ''
                if (readingState === 'finished') {
                    metaHtml = `<span class="leaf-meta-badge-finished">${escapeHTML(t('bookshelf.badgeFinished'))}</span>`
                    if (readTimeStr) metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
                } else if (readingState === 'want_to_read') {
                    metaHtml = `<span class="leaf-meta-badge-want">${escapeHTML(t('status.wantToRead'))}</span>`
                    if (readTimeStr) metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
                } else if (readingState === 'on_hold') {
                    metaHtml = `<span class="leaf-meta-badge-hold">${escapeHTML(t('status.onHold'))}</span>`
                    if (readTimeStr) metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
                } else if (readingState === 'unread') {
                    metaHtml = `<span class="leaf-meta-badge-new">${escapeHTML(t('bookshelf.badgeNewShort'))}</span><span class="leaf-meta-text">${escapeHTML(t('status.unread'))}</span>`
                    if (readTimeStr) metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
                } else {
                    metaHtml = `<span class="leaf-meta-progress">${progressPct}%</span>`
                    if (readTimeStr) metaHtml += `<span class="leaf-meta-dot leaf-meta-time-dot">·</span><span class="leaf-meta-time">${readTimeStr}</span>`
                }
                if (typeof book.rating === 'number' && book.rating > 0) {
                    metaHtml += `<span class="leaf-meta-dot">·</span><span class="leaf-meta-rating">★${Number(book.rating).toFixed(1)}</span>`
                }
                metaRow.innerHTML = metaHtml
            }
            if (patch.isFavorite !== undefined) {
                const favBtn = card.querySelector('.grid-fav-btn')
                const coverBox = card.querySelector('.leaf-cover-box')
                if (favBtn) {
                    favBtn.classList.toggle('active', !!book.isFavorite)
                    favBtn.title = book.isFavorite ? t('bookshelf.favRemoveTitle') : t('bookshelf.favAddTitle')
                }
                if (coverBox) {
                    coverBox.classList.toggle('is-favorite', !!book.isFavorite)
                }
            }
            card._renderSig = nextSig
            return true
        }
        return false
    }

    getDynamicGreeting({ reroll = false } = {}) {
        const periodKey = getGreetingPeriodKey()
        const locale = getLocale()

        const titlePrefix = t(`greeting.${periodKey}.title`)
        const rawName = this.app.getUserDisplayName ? this.app.getUserDisplayName() : DEFAULT_READER_NAME
        const resolvedName = (typeof rawName === 'string' ? rawName.trim() : '') || DEFAULT_READER_NAME
        const greetingTitle = t('greeting.titleFormat', { prefix: titlePrefix, name: resolvedName })

        const cached = this._activeGreetingSelection
        if (!reroll && cached && cached.periodKey === periodKey && cached.locale === locale && cached.subtitle) {
            return { title: greetingTitle, subtitle: cached.subtitle }
        }

        const rawOptions = tList(`greeting.${periodKey}.subtitles`)
        const options = rawOptions.length > 0 ? rawOptions : [t('greeting.defaultSubtitle')]
        if (!this._lastGreetingSubtitles) this._lastGreetingSubtitles = new Map()
        const prevSubtitle = this._lastGreetingSubtitles.get(periodKey)
        const pool = options.length > 1 && prevSubtitle
            ? options.filter(item => item !== prevSubtitle)
            : options
        const selectedSubtitle = pool[Math.floor(Math.random() * pool.length)] || options[0]
        this._lastGreetingSubtitles.set(periodKey, selectedSubtitle)
        this._activeGreetingSelection = { periodKey, locale, subtitle: selectedSubtitle }

        return { title: greetingTitle, subtitle: selectedSubtitle }
    }

    renderModernThreshold(books) {
        if (!this.dom.modernHeroThreshold) return
        const count = books ? books.length : 0

        // Always update divider & sub-bar book count accurately based on active context
        const countLabelTarget = this.dom.modernGridBookCount || this.dom.shelfSubbarCount
        if (countLabelTarget) {
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFav = this.shelfCategory === 'favorite'
            const isUnread = this.shelfCategory === 'unread'
            const isFinished = this.shelfCategory === 'finished'
            const isOverview = this.shelfCategory === 'overview'
            let countText = ''
            if (isCustomList) {
                countText = t('bookshelf.dividerListCount', { count })
            } else if (isFav) {
                countText = t('bookshelf.dividerFavCount', { count })
            } else if (isUnread) {
                countText = t('bookshelf.dividerUnreadCount', { count })
            } else if (isFinished) {
                countText = t('bookshelf.dividerFinishedCount', { count })
            } else if (isOverview) {
                const hasFilters = this.overviewSelectedTags.size > 0 || this.overviewRatingFilter !== 'all' || (this.overviewSearchQuery && this.overviewSearchQuery.trim()) || this.overviewStatus !== 'all'
                countText = t(hasFilters ? 'bookshelf.dividerOverviewFilteredCount' : 'bookshelf.dividerOverviewCount', { count })
            } else {
                countText = t('bookshelf.dividerAllCount', { count })
            }
            if (this.dom.modernGridBookCount) this.dom.modernGridBookCount.innerText = countText
            if (this.dom.shelfSubbarCount) this.dom.shelfSubbarCount.innerText = countText
        }

        // If searching or in filtered category (e.g. favorites or custom list), hide threshold hero to maximize library grid
        const isDefaultView = (!this.shelfCategory || this.shelfCategory === 'all') && (!this.searchQuery || !this.searchQuery.trim())
        if (!isDefaultView) {
            this.dom.modernHeroThreshold.style.display = 'none'
            if (this.dom.modernShelfScreen) this.dom.modernShelfScreen.style.paddingTop = '0.5rem'
            if (this.dom.btnBackToHero) this.dom.btnBackToHero.style.display = 'none'
            if (this.dom.modernShelfDivider) this.dom.modernShelfDivider.style.display = 'flex'
            return
        }

        this.dom.modernHeroThreshold.style.display = 'flex'
        this.cachedShelfHeight = this.dom.modernHeroThreshold.offsetHeight || (window.innerHeight - 52)
        if (this.dom.modernShelfScreen) this.dom.modernShelfScreen.style.paddingTop = '1.5rem'
        if (this.dom.btnBackToHero) this.dom.btnBackToHero.style.display = 'inline-flex'
        if (this.dom.modernShelfDivider) {
            this.dom.modernShelfDivider.style.display = 'flex'
        }

        // 1. Dynamic Greeting Based on 7 Time Slots & 3 Weighted Subtitles
        const greetingData = this.getDynamicGreeting()
        if (this.dom.heroGreetingTitle) {
            this.dom.heroGreetingTitle.innerText = greetingData.title
        }
        if (this.dom.heroGreetingSubtitle) {
            this.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
        }

        // 2. Find Current Read Hero Book (Latest lastOpenedAt or lastReadAt, including 0% and 100%)
        const candidateBooks = (books || []).map(b => ({
            book: b,
            effectiveSortTime: Math.max(b.lastOpenedAt || 0, b.lastReadAt || 0)
        })).filter(item => item.effectiveSortTime > 0)
        candidateBooks.sort((a, b) => b.effectiveSortTime - a.effectiveSortTime)
        const heroBook = candidateBooks.length > 0 ? candidateBooks[0].book : (books && books.length > 0 ? books[0] : null)

        if (this.dom.heroBookShowcase) {
            if (heroBook) {
                const clampedFraction = resolveBookProgressFraction(heroBook)
                const fillPct = clampedFraction * 100
                const fillWidth = `${fillPct}%`

                let progressPct
                if (clampedFraction === 0) {
                    progressPct = '0'
                } else if (clampedFraction >= 1) {
                    progressPct = '100'
                } else {
                    const rawPct = clampedFraction * 100
                    if (rawPct < 1) {
                        progressPct = rawPct.toFixed(1)
                    } else {
                        const rounded = Math.round(rawPct)
                        progressPct = rounded >= 100 ? '99' : String(rounded)
                    }
                }

                const totalSec = heroBook.totalReadingSeconds || 0
                const readDurationStr = tracker && tracker.formatDuration
                    ? tracker.formatDuration(totalSec)
                    : t('time.minutesCompact', { mins: Math.round(totalSec / 60) })
                let coverUrl = ''
                if (heroBook.coverBlob) {
                    coverUrl = coverUrlPool.getForBook(heroBook)
                }

                const heroAuthor = String(heroBook.author || '').trim()
                const heroSig = `${heroBook.id}|${heroBook.title}|${heroAuthor}|${fillWidth}|${progressPct}|${readDurationStr}|${coverUrl}|${getLocale()}`
                if (this.dom.heroBookShowcase._heroSig === heroSig && this.dom.heroBookShowcase.querySelector('.hero-book-card')) {
                    return
                }
                this.dom.heroBookShowcase._heroSig = heroSig

                this.dom.heroBookShowcase.innerHTML = `
                    <div class="hero-book-card" data-id="${escapeHTML(String(heroBook.id || ''))}" style="cursor: pointer;">
                        <div class="hero-book-cover-box">
                            ${coverUrl 
                                ? `<img class="hero-book-cover-img" src="${escapeHTML(coverUrl)}" alt="${escapeHTML(heroBook.title)}"/>`
                                : renderEditorialCoverHTML(heroBook, { displayTitle: resolveBookTitle(heroBook.title, heroBook.filename) })
                            }
                        </div>
                        <div class="hero-book-info">
                            <div class="hero-book-head">
                                <span class="hero-book-badge"><span class="hero-badge-dot"></span>${escapeHTML(t('bookshelf.heroRecentBadge'))}</span>
                                <div class="hero-book-title" title="${escapeHTML(heroBook.title)}">${escapeHTML(heroBook.title)}</div>
                                ${heroAuthor ? `<div class="hero-book-author">${escapeHTML(heroAuthor)}</div>` : ''}
                            </div>
                            <div class="hero-book-foot">
                                <div class="hero-progress-bar-wrap">
                                    <div class="hero-progress-bar-fill" style="width: ${fillWidth};"></div>
                                </div>
                                <div class="hero-book-footer-row">
                                    <div class="hero-book-meta">
                                        ${escapeHTML(t('bookshelf.heroMeta', { pct: progressPct, duration: readDurationStr }))}
                                    </div>
                                    <button class="btn-hero-read-now" id="btn-hero-read-now" type="button">
                                        ${escapeHTML(t('bookshelf.heroContinueBtn'))}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `

                const cardBtn = this.dom.heroBookShowcase.querySelector('#btn-hero-read-now')
                if (cardBtn) {
                    cardBtn.addEventListener('click', (e) => {
                        e.stopPropagation()
                        this.app.openBook(heroBook.id)
                    })
                }
                const cardWrap = this.dom.heroBookShowcase.querySelector('.hero-book-card')
                if (cardWrap) {
                    cardWrap.addEventListener('click', () => {
                        this.app.openBook(heroBook.id)
                    })
                }
            } else {
                this.dom.heroBookShowcase._heroSig = `empty|${getLocale()}`
                this.dom.heroBookShowcase.innerHTML = `
                    <div class="hero-book-card" style="flex-direction: column; justify-content: center; gap: 16px; text-align: center; padding: 2rem 1.5rem;">
                        <div style="font-family: var(--font-serif); font-size: 1.15rem; color: var(--text-main);">${escapeHTML(t('bookshelf.heroEmptyTitle'))}</div>
                        <button type="button" id="btn-hero-first-import" class="btn-primary-action" style="padding: 10px 18px;">${escapeHTML(t('bookshelf.heroEmptyBtn'))}</button>
                        <div style="font-size: 12px; color: var(--text-muted);">${escapeHTML(t('bookshelf.heroEmptyHint'))}</div>
                    </div>
                `
            }
        }

        document.getElementById('btn-hero-first-import')?.addEventListener('click', () => this.app.imports.dom.btnImport?.click())

        // 3. Scroll Hint & Back-to-Hero High-Velocity Controls
        if (this.dom.heroScrollHint) {
            this.dom.heroScrollHint.onclick = () => {
                this.glideToShelf()
            }
        }
        if (this.dom.btnBackToHero) {
            this.dom.btnBackToHero.onclick = () => {
                this.glideToHero()
            }
        }
    }

    onBooksWorkspaceScroll(isScroll = false) {
        const ws = this.dom.booksWorkspace
        if (!ws) return
        if (isScroll) {
            this._lastShelfScrollAt = performance.now()
            if (!this._isScrolling) {
                this._isScrolling = true
                ws.classList.add('shelf-is-scrolling')
                const settle = () => {
                    const remaining = 150 - (performance.now() - this._lastShelfScrollAt)
                    if (remaining > 0) {
                        this._scrollEndTimer = setTimeout(settle, remaining)
                        return
                    }
                    this._isScrolling = false
                    ws.classList.remove('shelf-is-scrolling')
                    if (this._coverOptResume) {
                        this._coverOptTimer = setTimeout(this._coverOptResume, 1000)
                        this._coverOptResume = null
                    }
                }
                this._scrollEndTimer = setTimeout(settle, 150)
            }
        }

        const scrollTop = ws.scrollTop
        const showScrollbar = scrollTop > 80
        if (this._scrolledIntoShelfState !== showScrollbar) {
            this._scrolledIntoShelfState = showScrollbar
            ws.classList.toggle('scrolled-into-shelf', showScrollbar)
        }

        const showHero = this.shelfCategory === 'all' && this.shelfViewMode === 'grid' &&
            !this.searchQuery?.trim() && this.dom.modernHeroThreshold && this.dom.modernHeroThreshold.style.display !== 'none'
        const mode = showHero ? (scrollTop < this.cachedShelfHeight * 0.45 ? 'hero'
            : (!this.isGliding && scrollTop >= this.cachedShelfHeight * 0.6 ? 'shelf' : 'transition')) : 'other'
        if (mode !== this._heroScrollState) {
            this._heroScrollState = mode
            this.dom.bookshelfView?.classList.toggle('is-hero-at-top', mode === 'hero')
            if (showHero && this.dom.currentCategoryTitle) {
                this.dom.currentCategoryTitle.textContent = mode === 'shelf' ? this._resolveCategoryTitle('all') : ''
                this.dom.currentCategoryTitle.style.display = mode === 'shelf' ? 'block' : 'none'
            }
            if (this._isGridVirtualized) this._measureVirtualViewport()
        }

        if (!this._isGridVirtualized || !this._virtualBooks || this.dom.modernGridWrapper?.style.display === 'none') return
        const relative = Math.max(0, scrollTop - this._virtualGridTop)
        const first = Math.floor(relative / this._virtualRowHeight)
        const end = Math.ceil((relative + this._virtualViewportHeight) / this._virtualRowHeight)
        if ((this._virtualStartRow > 0 && first <= this._virtualStartRow) ||
            (this._virtualEndRow < this._virtualTotalRows && end >= this._virtualEndRow)) {
            this._renderVirtualizedSlice(false, scrollTop)
        }
    }

    smoothGlideTo(targetY, duration = 800, callback) {
        if (!this.dom.booksWorkspace) return
        if (this.isGliding) return
        this.isGliding = true

        const startY = this.dom.booksWorkspace.scrollTop
        const distance = targetY - startY
        if (Math.abs(distance) < 2) {
            this.dom.booksWorkspace.scrollTop = targetY
            this.isGliding = false
            if (typeof callback === 'function') callback()
            return
        }

        const startTime = performance.now()
        // Ease-out curve: 1 - (1 - t)^4
        const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4)

        const step = (currentTime) => {
            const elapsed = currentTime - startTime
            const progress = Math.min(elapsed / duration, 1)
            const eased = easeOutQuart(progress)

            this.dom.booksWorkspace.scrollTop = startY + distance * eased

            if (progress < 1) {
                requestAnimationFrame(step)
            } else {
                this.dom.booksWorkspace.scrollTop = targetY
                this.isGliding = false
                this.onBooksWorkspaceScroll()
                if (typeof callback === 'function') callback()
            }
        }

        requestAnimationFrame(step)
    }

    _getShelfScreenTop() {
        const heroEl = this.dom.modernHeroThreshold
        if (!heroEl || heroEl.style.display === 'none') return 0
        const measured = heroEl.offsetHeight || this.cachedShelfHeight || Math.max(0, window.innerHeight - 52)
        this.cachedShelfHeight = measured
        return measured
    }

    glideToShelf() {
        if (!this.dom.booksWorkspace) return
        const shelfTop = this._getShelfScreenTop() || (window.innerHeight - 52)
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = this._resolveCategoryTitle('all')
            this.dom.currentCategoryTitle.style.display = 'block'
        }
        this.dom.booksWorkspace.scrollTo({ top: shelfTop, behavior: 'smooth' })
    }

    glideToHero() {
        if (!this.dom.booksWorkspace) return
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = ''
            this.dom.currentCategoryTitle.style.display = 'none'
        }
        this.dom.booksWorkspace.scrollTo({ top: 0, behavior: 'smooth' })
    }

    glideScrollTo(targetTop) {
        if (!this.dom.booksWorkspace) return
        this.smoothGlideTo(targetTop, 600)
    }

    renderBooksGrid(books) {
        if (books.length === 0) {
            this._isGridVirtualized = false
            this._virtualBooks = null
            this._booksMap = new Map()
            this.dom.booksGrid.innerHTML = ''
            this.dom.booksGrid.classList.add('is-empty')
            this.dom.booksGrid.style.display = 'flex'
            this.dom.booksGrid.style.justifyContent = 'center'
            this.dom.booksGrid.style.alignItems = 'center'
            this.dom.booksGrid.style.width = '100%'
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFinishedView = this.shelfCategory === 'finished'
            const isOverview = this.shelfCategory === 'overview'
            let svgIcon = ''
            if (isFavView) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-primary, #da7756);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
            } else if (isCustomList) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-primary, #da7756);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`
            } else if (isFinishedView) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-primary, #da7756);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
            } else if (isOverview) {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-primary, #da7756);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`
            } else {
                svgIcon = `<svg style="width: 42px; height: 42px; stroke-width: 1.5; color: var(--accent-primary, #da7756);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`
            }

            const isMobileShelf = Boolean(globalThis.window?.mobileShell?.isMobileViewport() && this.shelfCategory === 'all')
            const mobileFilter = isMobileShelf ? globalThis.window.mobileShell.shelfFilter : 'all'
            const emptyFilterKeys = {
                reading: 'mobile.shelf.emptyReading',
                on_hold: 'mobile.shelf.emptyOnHold',
                finished: 'mobile.shelf.emptyFinished'
            }

            const activeShelfSearch = (!isMobileShelf && this.searchQuery && this.searchQuery.trim())
                ? this.searchQuery.trim()
                : ''
            const hasActiveOverviewFilters = isOverview && (this.overviewSelectedTags.size > 0 || this.overviewRatingFilter !== 'all' || (this.overviewSearchQuery && this.overviewSearchQuery.trim()) || this.overviewStatus !== 'all')

            let emptyTitle = activeShelfSearch
                ? t('bookshelf.emptySearchTitle', { query: activeShelfSearch })
                : (isFavView ? t('bookshelf.emptyShelf.favTitle')
                : (isCustomList ? t('bookshelf.emptyShelf.listTitle')
                : (isFinishedView ? t('bookshelf.emptyShelf.finishedTitle')
                : (hasActiveOverviewFilters ? t('bookshelf.emptyGrid.filteredTitle')
                : (isOverview ? t('bookshelf.emptyGrid.overviewTitle') : t('bookshelf.emptyShelf.allTitle'))))))
            let emptySub = activeShelfSearch
                ? t('bookshelf.emptySearchSub')
                : (isFavView ? t('bookshelf.emptyGrid.favSub')
                : (isCustomList ? t('bookshelf.emptyGrid.listSub')
                : (isFinishedView ? t('bookshelf.emptyShelf.finishedSub')
                : (hasActiveOverviewFilters ? t('bookshelf.emptyGrid.filteredSub')
                : (isOverview ? t('bookshelf.emptyGrid.overviewSub') : t('bookshelf.emptyGrid.allSub'))))))

            let clearBtnHtml = ''
            if (activeShelfSearch) {
                clearBtnHtml = `<button type="button" id="btn-empty-search-fulltext" class="btn-secondary-action">${escapeHTML(t('bookshelf.emptySearchFullTextBtn', { query: activeShelfSearch }))}</button>`
            } else if (hasActiveOverviewFilters) {
                clearBtnHtml = `<button type="button" id="btn-grid-empty-clear" class="btn-clear-overview-filters" style="margin-top: 14px; padding: 5px 16px; font-size: 0.82rem; cursor: pointer; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-main);">${escapeHTML(t('bookshelf.clearFilterConditionBtn'))}</button>`
            }

            this.dom.booksGrid.innerHTML = `
                <div class="leaf-empty-state" style="grid-column: 1 / -1; width: 100%; max-width: 520px; margin: 0 auto; padding: 4rem 1.5rem; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
                    <div style="display: flex; justify-content: center; margin-bottom: 0.85rem; opacity: 0.85;">${svgIcon}</div>
                    <h3 style="font-family: var(--font-serif); font-size: 1.15rem; font-weight: 600; color: var(--text-main); margin-bottom: 0.4rem;">${escapeHTML(emptyFilterKeys[mobileFilter] ? t(emptyFilterKeys[mobileFilter]) : emptyTitle)}</h3>
                    <p style="font-size: 0.82rem; color: var(--text-muted);">${escapeHTML(emptySub)}</p>
                    ${clearBtnHtml}
                </div>
            `
            if (activeShelfSearch) {
                document.getElementById('btn-empty-search-fulltext')?.addEventListener('click', () => {
                    this.app?.search?.openCrossSearchModal?.(activeShelfSearch)
                })
            }
            document.getElementById('btn-grid-empty-clear')?.addEventListener('click', () => {
                this.clearOverviewFilters()
            })
            return
        }

        this.dom.booksGrid.classList.remove('is-empty')
        this.dom.booksGrid.style.display = 'grid'
        this.dom.booksGrid.style.justifyContent = ''
        this.dom.booksGrid.style.alignItems = ''

        // Group by completed year-month if in overview finished status with grouping enabled
        if (this.shelfCategory === 'overview' && this.overviewStatus === 'finished' && this.overviewGroupByYearMonth) {
            this._isGridVirtualized = false
            this._virtualBooks = null
            this.dom.booksGrid.innerHTML = ''
            const groupMap = new Map()
            books.forEach(b => {
                let key = t('bookshelf.unknownDate')
                let sortKey = -1
                if (b.completedAt && typeof b.completedAt === 'number' && b.completedAt > 0) {
                    const d = new Date(b.completedAt)
                    key = d.toLocaleDateString(getIntlLocale(), { year: 'numeric', month: 'long' })
                    sortKey = d.getFullYear() * 100 + (d.getMonth() + 1)
                }
                if (!groupMap.has(key)) {
                    groupMap.set(key, { sortKey, books: [] })
                }
                groupMap.get(key).books.push(b)
            })

            const sortedGroups = Array.from(groupMap.entries()).sort((a, b) => b[1].sortKey - a[1].sortKey)

            const gridFragment = document.createDocumentFragment()
            const unregisterGrid = coverUrlPool.registerPendingRoot(gridFragment)
            try {
                let gIdx = 0
                for (const [groupName, groupData] of sortedGroups) {
                    const header = document.createElement('div')
                    header.className = 'overview-group-header'
                    const countLabel = t(groupData.books.length === 1 ? 'bookshelf.countBooksOne' : 'bookshelf.countBooksMany', { count: groupData.books.length })
                    header.innerHTML = `<span>${escapeHTML(groupName)}</span> <span style="font-size: 0.78rem; font-weight: normal; color: var(--text-muted); margin-left: 8px;">${escapeHTML(countLabel)}</span>`
                    gridFragment.appendChild(header)

                    groupData.books.forEach(book => {
                        const card = this.createBookCard(book, gIdx++)
                        gridFragment.appendChild(card)
                    })
                }
                this.dom.booksGrid.appendChild(gridFragment)
            } finally {
                unregisterGrid()
            }
            return
        }

        this._booksMap = new Map(books.map(b => [b.id, b]))
        const largeLibraryThreshold = window.mobileShell?.isMobileViewport() ? 80 : DESKTOP_GRID_CARD_BUDGET
        if (books.length > largeLibraryThreshold) return this._renderVirtualizedBooksGrid(books)

        // If not virtualized, clean up any virtual spacers
        const topSpacer = this.dom.booksGrid.querySelector('.grid-virtual-spacer-top')
        if (topSpacer) topSpacer.remove()
        const bottomSpacer = this.dom.booksGrid.querySelector('.grid-virtual-spacer-bottom')
        if (bottomSpacer) bottomSpacer.remove()
        this._isGridVirtualized = false
        this._virtualBooks = null

        // Collect existing card elements by book.id so we can reuse them in-place
        // without destroying decoded <img> bitmaps or re-triggering entrance animations
        const existingCards = new Map()
        for (const child of Array.from(this.dom.booksGrid.children)) {
            if (child.classList?.contains('leaf-book-card') && child.dataset?.id) {
                existingCards.set(child.dataset.id, child)
            } else {
                child.remove()
            }
        }

        const nextIds = new Set(books.map(b => b.id))
        for (const [id, el] of existingCards.entries()) {
            if (!nextIds.has(id)) {
                el.remove()
                existingCards.delete(id)
            }
        }

        const isFresh = existingCards.size === 0
        const gridFragment = document.createDocumentFragment()
        const unregisterGrid = coverUrlPool.registerPendingRoot(gridFragment)
        try {
            books.forEach((book, idx) => {
                const nextSig = this._getBookRenderSignature(book)
                let card = existingCards.get(book.id)
                if (card) {
                    card.classList.add('card-settled')
                    card.style.setProperty('--card-index', idx)
                    if (card._renderSig !== nextSig) {
                        const existingImg = card.querySelector('img.leaf-cover-img')
                        const freshCard = this.createBookCard(book, idx)
                        freshCard.classList.add('card-settled')
                        const freshImg = freshCard.querySelector('img.leaf-cover-img')
                        if (existingImg && freshImg && existingImg.src === freshImg.src) {
                            freshImg.replaceWith(existingImg)
                        }
                        card.replaceWith(freshCard)
                        card = freshCard
                    }
                } else {
                    card = this.createBookCard(book, idx)
                }
                if (isFresh) {
                    gridFragment.append(card)
                    return
                }
                const currentAtIdx = this.dom.booksGrid.children[idx]
                if (currentAtIdx !== card) {
                    this.dom.booksGrid.insertBefore(card, currentAtIdx || null)
                }
            })
            if (isFresh) this.dom.booksGrid.append(gridFragment)
        } finally {
            unregisterGrid()
        }
    }

    _measureVirtualViewport() {
        const ws = this.dom.booksWorkspace, grid = this.dom.booksGrid
        if (!ws || !grid) return
        this._virtualGridTop = grid.getBoundingClientRect().top - ws.getBoundingClientRect().top + ws.scrollTop
        this._virtualViewportHeight = ws.clientHeight
    }

    _renderVirtualizedBooksGrid(books) {
        const ws = this.dom.booksWorkspace, grid = this.dom.booksGrid
        const previousCols = this._isGridVirtualized ? this._virtualCols : 0
        const previousStride = this._virtualRowHeight
        const previousTop = this._virtualGridTop
        const scrollTop = ws.scrollTop
        this._isGridVirtualized = true
        this._virtualBooks = books
        this._booksMap = new Map(books.map(book => [book.id, book]))

        const style = getComputedStyle(grid)
        const template = style.gridTemplateColumns
        const tracks = template.trim().split(/\s+/).filter(value => /^\d+(?:\.\d+)?px$/.test(value)).map(parseFloat)
        const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
        const width = Math.max(0, grid.clientWidth - horizontalPadding)
        const columnGap = parseFloat(style.columnGap) || 0
        const listMode = grid.classList.contains('is-list-mode')
        const gap = parseFloat(style.rowGap) || 0
        const listHeight = parseFloat(style.getPropertyValue('--mobile-shelf-list-row-height'))
        const minWidth = Number(template.match(/minmax\((\d+)px/)?.[1]) || 140
        const cols = listMode ? 1 : Math.max(1, tracks.length || Math.floor((width + columnGap) / (minWidth + columnGap)))
        const firstWidth = tracks[0] || Math.max(minWidth, (width - (cols - 1) * columnGap) / cols)
        const isMobile = window.mobileShell?.isMobileViewport()
        const coverWidth = isMobile ? firstWidth : Math.min(170, firstWidth)
        const rowHeight = ((listMode && listHeight) || coverWidth * 1.414 + 66) + gap
        this._virtualLayoutWidth = width

        this._virtualCols = cols
        this._virtualRowHeight = rowHeight
        this._virtualRowGap = gap
        this._virtualTotalRows = Math.ceil(books.length / cols)
        this._virtualRowBudget = isMobile ? 0 : Math.floor(DESKTOP_GRID_CARD_BUDGET / cols)
        this._measureVirtualViewport()

        const previousRelative = Math.max(0, scrollTop - (previousTop ?? this._virtualGridTop))
        const anchor = previousCols && previousStride && previousRelative > 0
            ? Math.min(books.length - 1, Math.floor(previousRelative / previousStride) * previousCols) : null
        const anchorOffset = anchor === null ? 0 : previousRelative % previousStride
        this._renderVirtualizedSlice()
        const firstCard = grid.querySelector('.leaf-book-card')
        const measuredHeight = firstCard?.getBoundingClientRect().height
        if (measuredHeight > 0) this._virtualRowHeight = measuredHeight + gap
        if (anchor !== null && previousCols !== cols) {
            ws.scrollTop = this._virtualGridTop + Math.floor(anchor / cols) * this._virtualRowHeight + anchorOffset
        }
        this._renderVirtualizedSlice(false)
    }

    _renderVirtualizedSlice(refresh = true, scrollTop = this.dom.booksWorkspace?.scrollTop || 0) {
        if (!this._isGridVirtualized || !this._virtualBooks) return
        const grid = this.dom.booksGrid
        const books = this._virtualBooks
        const cols = this._virtualCols
        const rowHeight = this._virtualRowHeight
        const totalRows = this._virtualTotalRows
        const relative = Math.max(0, scrollTop - this._virtualGridTop)
        const visibleRows = Math.ceil(this._virtualViewportHeight / rowHeight) + 1
        const windowRows = Math.min(totalRows, Math.max(visibleRows + 4, this._virtualRowBudget))
        const buffer = Math.floor((windowRows - visibleRows) / 2)
        const startRow = Math.max(0, Math.min(totalRows - windowRows, Math.floor(relative / rowHeight) - buffer))
        const endRow = startRow + windowRows
        if (!refresh && startRow === this._virtualStartRow && endRow === this._virtualEndRow &&
            rowHeight === this._mountedVirtualRowHeight) return
        this._virtualStartRow = startRow
        this._virtualEndRow = endRow
        this._mountedVirtualRowHeight = rowHeight

        const startIndex = startRow * cols
        const sliceBooks = books.slice(startIndex, endRow * cols)
        const sliceIds = new Set(sliceBooks.map(book => book.id))
        const gap = this._virtualRowGap
        let topSpacer = grid.firstElementChild
        if (!topSpacer?.classList.contains('grid-virtual-spacer-top')) {
            topSpacer = document.createElement('div')
            topSpacer.className = 'grid-virtual-spacer-top'
            grid.prepend(topSpacer)
        }
        let bottomSpacer = grid.lastElementChild
        if (!bottomSpacer?.classList.contains('grid-virtual-spacer-bottom')) {
            bottomSpacer = document.createElement('div')
            bottomSpacer.className = 'grid-virtual-spacer-bottom'
            grid.append(bottomSpacer)
        }
        const updateSpacer = (spacer, count) => {
            const height = count > 0 ? (count * rowHeight - gap) + 'px' : ''
            if (spacer.style.height !== height) spacer.style.height = height
            spacer.hidden = count === 0
        }
        updateSpacer(topSpacer, startRow)
        updateSpacer(bottomSpacer, totalRows - endRow)

        const existingCards = new Map()
        for (const child of Array.from(grid.children)) {
            if (child === topSpacer || child === bottomSpacer) continue
            if (child.classList?.contains('leaf-book-card') && child.dataset?.id) {
                if (!sliceIds.has(child.dataset.id)) {
                    child.remove()
                } else {
                    existingCards.set(child.dataset.id, child)
                }
            } else {
                child.remove()
            }
        }

        if (!refresh) {
            // Moving the window changes only its leading and trailing cards.
            const before = document.createDocumentFragment()
            const after = document.createDocumentFragment()
            let retained = false
            for (const [i, book] of sliceBooks.entries()) {
                if (existingCards.has(book.id)) {
                    retained = true
                    continue
                }
                const card = this.createBookCard(book, startIndex + i)
                card.classList.add('card-settled')
                const fragment = retained ? after : before
                fragment.append(card)
            }
            if (before.firstChild) grid.insertBefore(before, topSpacer.nextSibling)
            if (after.firstChild) grid.insertBefore(after, bottomSpacer)
            return
        }

        const fragment = existingCards.size ? null : document.createDocumentFragment()
        const unregisterGrid = coverUrlPool.registerPendingRoot(fragment || grid)
        try {
            sliceBooks.forEach((book, i) => {
                const globalIdx = startIndex + i
                let card = existingCards.get(book.id)
                if (card) {
                    if (card._renderSig !== this._getBookRenderSignature(book)) {
                        const existingImg = card.querySelector('img.leaf-cover-img')
                        const freshCard = this.createBookCard(book, globalIdx)
                        freshCard.classList.add('card-settled')
                        const freshImg = freshCard.querySelector('img.leaf-cover-img')
                        if (existingImg && freshImg && existingImg.src === freshImg.src) {
                            freshImg.replaceWith(existingImg)
                        }
                        card.replaceWith(freshCard)
                        card = freshCard
                    }
                } else {
                    card = this.createBookCard(book, globalIdx)
                    card.classList.add('card-settled')
                }
                if (fragment) {
                    fragment.append(card)
                } else {
                    const atPosition = grid.children[i + 1] || bottomSpacer
                    if (atPosition !== card) grid.insertBefore(card, atPosition)
                }
            })
            if (fragment) grid.insertBefore(fragment, bottomSpacer)
        } finally {
            unregisterGrid()
        }
    }

    renderBooksTable(books) {
        this.dom.booksTableBody.innerHTML = ''

        if (books.length === 0) {
            const activeShelfSearch = (this.searchQuery && this.searchQuery.trim()) ? this.searchQuery.trim() : ''
            const isFavView = this.shelfCategory === 'favorite'
            const isCustomList = this.shelfCategory && this.shelfCategory.startsWith('list_')
            const isFinishedView = this.shelfCategory === 'finished'
            const isOverview = this.shelfCategory === 'overview'
            let emptyMsg = activeShelfSearch
                ? t('bookshelf.emptySearchTitle', { query: activeShelfSearch })
                : (isFavView ? t('bookshelf.emptyTable.fav')
                : (isCustomList ? t('bookshelf.emptyTable.list')
                : (isFinishedView ? t('bookshelf.emptyTable.finished')
                : (isOverview ? t('bookshelf.emptyTable.overview')
                : t('bookshelf.emptyTable.all')))))
            this.dom.booksTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 40px; color: var(--text-tertiary);">${escapeHTML(emptyMsg)}</td></tr>`
            return
        }

        const tableFragment = document.createDocumentFragment()
        const unregisterTable = coverUrlPool.registerPendingRoot(tableFragment)
        try {
            books.forEach(book => {
                const row = document.createElement('tr')
                row.className = 'leaf-table-row'
                row.dataset.id = book.id
                if (this.isBatchMode && this.selectedBookIds.has(book.id)) {
                    row.classList.add('selected')
                    row.style.background = 'var(--accent-primary-subtle, rgba(218, 119, 86, 0.1))'
                }

                const fraction = resolveBookProgressFraction(book)
                const rawPct = fraction * 100
                const progressPct = rawPct % 1 === 0 ? rawPct.toFixed(0) : (rawPct < 1 ? rawPct.toFixed(1) : rawPct.toFixed(0))
                const sizeStr = formatFileSize(book.size)
                const dateStr = book.addedAt ? new Date(book.addedAt).toLocaleDateString(getIntlLocale()) : '-'

                const isCloud = !!book.isCloudOnly
                const hasBackup = !!(book.cloudBackup?.hasBackup)
                const cloudBadge = isCloud
                    ? `<span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 5px; background: var(--accent-primary-subtle, rgba(218, 119, 86, 0.12)); color: var(--accent-primary, #da7756); margin-right: 6px; font-weight: 500; display: inline-flex; align-items: center; gap: 3px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>${escapeHTML(t('bookshelf.cloudPendingPull'))}</span>`
                    : (hasBackup ? `<span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 5px; background: rgba(95, 148, 83, 0.12); color: #4d7c43; margin-right: 6px; font-weight: 500; display: inline-flex; align-items: center; gap: 3px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>${escapeHTML(t('bookshelf.tableCloudBackedUp'))}</span>` : '')
                const cloudBtnText = isCloud
                    ? t('bookshelf.tableCloudPull')
                    : (hasBackup ? t('bookshelf.tableCloudBackedUp') : t('bookshelf.tableCloudBackup'))
                const cloudBtnStyle = hasBackup ? 'color: #4d7c43; border: 1px solid rgba(95,148,83,0.28); background: rgba(95,148,83,0.08);' : 'color: var(--accent-primary, #da7756); border: 1px solid rgba(218,119,86,0.28); background: rgba(218,119,86,0.07);'

                row.innerHTML = `
                    <td class="leaf-table-cell" style="width: 40px; text-align: center;">
                        <button class="table-fav-btn ${book.isFavorite ? 'active' : ''}" title="${escapeHTML(book.isFavorite ? t('bookshelf.favRemoveTitle') : t('bookshelf.favAddTitle'))}" style="background: none; border: none; font-size: 1.1rem; cursor: pointer; color: ${book.isFavorite ? '#f59e0b' : 'var(--text-tertiary)'};"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.4l6.3-.9Z"/></svg></button>
                    </td>
                    <td class="leaf-table-cell font-medium" style="font-weight: 600;">${cloudBadge}${escapeHTML(resolveBookTitle(book.title, book.filename))}</td>
                    <td class="leaf-table-cell text-muted">${escapeHTML(book.author || t('book.unknownAuthor'))}</td>
                    <td class="leaf-table-cell text-muted">${escapeHTML((book.format || 'epub').toUpperCase())} · ${sizeStr}</td>
                    <td class="leaf-table-cell text-muted">${progressPct}%</td>
                    <td class="leaf-table-cell text-muted">${dateStr}</td>
                    <td class="leaf-table-cell" style="text-align: center; white-space: nowrap;">
                        <button class="table-cloud-btn" title="${escapeHTML(t('bookshelf.tableCloudBtnTitle'))}" style="${cloudBtnStyle} padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>${escapeHTML(cloudBtnText)}</button>
                        <button class="table-list-btn" title="${escapeHTML(t('bookshelf.tableListBtnTitle'))}" style="color: var(--brand-terracotta, #da7756); border: 1px solid rgba(218, 119, 86, 0.25); background: rgba(218, 119, 86, 0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>${escapeHTML(t('bookshelf.tableListBtn'))}</button>
                        <button class="table-details-btn" title="${escapeHTML(t('bookshelf.tableDetailsBtnTitle'))}" style="color: var(--accent-primary, #da7756); border: 1px solid rgba(218, 119, 86, 0.25); background: rgba(218, 119, 86, 0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; margin-right: 4px; display: inline-flex; align-items: center; gap: 4px;">${escapeHTML(t('bookshelf.tableDetailsBtn'))}</button>
                        <button class="table-delete-btn" title="${escapeHTML(t('bookshelf.tableDeleteBtnTitle'))}" style="color: #ef4444; border: 1px solid rgba(239,68,68,0.25); background: rgba(239,68,68,0.06); padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;">${escapeHTML(t('bookshelf.tableDeleteBtn'))}</button>
                    </td>
                `
                tableFragment.appendChild(row)
            })
            this.dom.booksTableBody.appendChild(tableFragment)
        } finally {
            unregisterTable()
        }
    }

    async handleDeleteBook(book) {
        if (!book || !book.id) return
        const isCloudOnly = !!book.isCloudOnly
        const hasCloudBackup = !!(book.cloudBackup?.hasBackup)
        const displayTitle = book.title || t('book.untitled')

        let shouldDeleteCloudFile = false
        let shouldRecordTombstone = true

        if (isCloudOnly) {
            // Book is cloud placeholder only (not downloaded locally)
            const confirmed = await this.app.dialogs.showConfirmDialog(
                t('bookshelf.deleteCloudPlaceholderTitle', { title: displayTitle }),
                t('bookshelf.deleteCloudPlaceholderMsg')
            )
            if (!confirmed) return
            // For a cloud-only placeholder, removing it locally should NOT broadcast deletion to other devices!
            shouldRecordTombstone = false
        } else if (hasCloudBackup) {
            // Book has cloud backup
            const confirmed = await this.app.dialogs.showConfirmDialog(
                t('bookshelf.deleteBookTitle', { title: displayTitle }),
                t('bookshelf.deleteBookWithCloudMsg')
            )
            if (!confirmed) return

            // Prompt whether to clean up the WebDAV remote backup to release quota
            const deleteCloud = await this.app.dialogs.showConfirmDialog(
                t('bookshelf.deleteCloudBackupTitle'),
                t('bookshelf.deleteCloudBackupMsg')
            )
            shouldDeleteCloudFile = !!deleteCloud
            shouldRecordTombstone = true
        } else {
            const confirmed = await this.app.dialogs.showConfirmDialog(
                t('bookshelf.deleteBookTitle', { title: displayTitle }),
                t('bookshelf.deleteBookMsg')
            )
            if (!confirmed) return
        }

        try {
            await db.deleteBook(book.id, shouldRecordTombstone)
            coverUrlPool.revoke(book.id)
            fullTextSearchEngine.removeBookIndex(book.id)

            if (shouldDeleteCloudFile && (this.app.sync.syncConfig?.enabled || this.app.sync.syncConfig?.username)) {
                const fileName = book.cloudBackup?.fileName || `${book.stableKey || book.id}.${book.format}`
                if (this.app.sync.syncConfig?.enabled) {
                    try {
                        const delRes = await (await this.app.sync.getBookStorage()).deleteBookBinary(fileName)
                        if (delRes?.success) {
                            console.log(`[CloudSync] Deleted remote book binary: ${fileName}`)
                        } else {
                            this.app.dialogs.showToast(t('bookshelf.deleteCloudIncompleteToast'), 'warning')
                        }
                    } catch (delErr) {
                        console.warn('[CloudSync] Failed deleting remote book binary:', delErr)
                        this.app.dialogs.showToast(t('bookshelf.deleteCloudOfflineToast'), 'warning')
                    }
                }
            }

            this.app.dialogs.showToast(t('bookshelf.deleteBookSuccessToast', { title: displayTitle }), 'delete')
            this.app.closeBookDetailsModal?.()
            if (window.mobileShell?.closeAllSheets) {
                window.mobileShell.closeAllSheets()
            }
            await this.renderCustomListsSidebar()
            await this.refreshBookshelf()

            if (shouldRecordTombstone && this.app.sync.syncConfig?.enabled) {
                this.app.sync.triggerSilentBackgroundSync()
            }
        } catch (err) {
            console.error('Delete book error:', err)
            this.app.dialogs.showToast(t('bookshelf.deleteBookFailedToast', { detail: err.message }), 'warning')
            await this.refreshBookshelf()
        }
    }

    async renderCustomListsSidebar() {
        if (!this.dom.customListsContainer) return
        this.customLists = await db.getAllCustomLists()
        const allBooks = await db.getAllBooks()

        this.dom.customListsContainer.innerHTML = ''
        this.customLists.forEach(list => {
            let count = 0
            if (list.id === 'list_unread') {
                count = allBooks.filter(b => b.customListIds?.includes('list_unread') || resolveBookProgressFraction(b) === 0).length
            } else {
                count = allBooks.filter(b => b.customListIds && b.customListIds.includes(list.id)).length
            }

            const item = document.createElement('button')
            item.className = `custom-list-nav-item ${this.shelfCategory === list.id ? 'active' : ''}`
            item.dataset.listId = list.id
            item.title = list.name

            const iconSpan = document.createElement('span')
            iconSpan.className = 'list-icon-wrap'
            iconSpan.innerHTML = this.getListIconSvg(list.icon)

            const titleSpan = document.createElement('span')
            titleSpan.className = 'list-title'
            titleSpan.textContent = list.name

            item.appendChild(iconSpan)
            item.appendChild(titleSpan)

            const slot = document.createElement('span')
            slot.className = 'list-accessory-slot'

            if (count > 0) {
                const badgeSpan = document.createElement('span')
                badgeSpan.className = `list-count-badge ${!list.isBuiltIn ? 'has-del' : ''}`
                badgeSpan.textContent = String(count)
                slot.appendChild(badgeSpan)
            }

            if (!list.isBuiltIn) {
                const delSpan = document.createElement('span')
                delSpan.className = 'list-del-btn'
                delSpan.title = t('bookshelf.deleteListTitle')
                delSpan.textContent = '✕'
                slot.appendChild(delSpan)
            }

            item.appendChild(slot)

            item.addEventListener('click', e => {
                if (e.target.classList.contains('list-del-btn')) {
                    e.stopPropagation()
                    this.handleDeleteCustomList(list)
                    return
                }

                // Switch to custom list
                this.switchShelfCategory(list.id)
            })

            this.dom.customListsContainer.appendChild(item)
        })
    }

    async handleDeleteCustomList(list) {
        const confirmed = await this.app.dialogs.showConfirmDialog(
            t('bookshelf.deleteListConfirmTitle', { name: list.name }),
            t('bookshelf.deleteListConfirmMsg')
        )
        if (!confirmed) return
        await db.deleteCustomList(list.id)
        this.app.dialogs.showToast(t('bookshelf.deleteListSuccessToast', { name: list.name }), 'delete')
        if (this.shelfCategory === list.id) {
            this.shelfCategory = 'all'
            document.getElementById('nav-cat-all')?.classList.add('active')
            if (this.dom.currentCategoryTitle) this.dom.currentCategoryTitle.innerText = this._resolveCategoryTitle('all')
        }
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    getListIconSvg(iconId) {
        const found = this.iconDefs?.find(d => d.id === iconId)
        if (found) return found.svg
        return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
    }

    _setCreateListNameError(hasError) {
        const active = Boolean(hasError)
        this.dom?.createListNameField?.classList?.toggle('is-error', active)
        if (this.dom?.inputCustomListName) {
            if (active) {
                this.dom.inputCustomListName.setAttribute('aria-invalid', 'true')
            } else {
                this.dom.inputCustomListName.removeAttribute?.('aria-invalid')
            }
        }
        if (this.dom?.createListNameError) {
            this.dom.createListNameError.hidden = !active
        }
    }

    _updateCreateListPreview() {
        const rawName = (this.dom?.inputCustomListName?.value || '').trim()
        if (this.dom?.createListPreviewName) {
            if (rawName) {
                this.dom.createListPreviewName.textContent = rawName
                this.dom.createListPreviewName.classList?.remove('is-placeholder')
            } else {
                this.dom.createListPreviewName.textContent = t('modal.listUntitledPreview')
                this.dom.createListPreviewName.classList?.add('is-placeholder')
            }
        }
        if (this.dom?.createListPreviewIcon) {
            this.dom.createListPreviewIcon.innerHTML = this.getListIconSvg(this.selectedListIcon || 'book')
        }
    }

    _selectCreateListIcon(iconId, { focusButton = false } = {}) {
        this.selectedListIcon = iconId
        const buttons = Array.from(this.dom?.customListIconPicker?.querySelectorAll('.icon-pick-btn') || [])
        buttons.forEach(b => {
            const isSelected = b.dataset.iconId === iconId
            b.classList.toggle('active', isSelected)
            b.setAttribute('aria-checked', isSelected ? 'true' : 'false')
            b.setAttribute('tabindex', isSelected ? '0' : '-1')
            if (isSelected && focusButton) {
                b.focus()
            }
        })
        this._updateCreateListPreview()
    }

    _getIconPickerColumnCount(buttons) {
        if (buttons.length > 1 && typeof buttons[0]?.getBoundingClientRect === 'function') {
            const firstRect = buttons[0].getBoundingClientRect()
            if (firstRect && firstRect.width > 0) {
                const sameRow = buttons.filter(b => Math.abs(b.getBoundingClientRect().top - firstRect.top) < 4).length
                if (sameRow > 0) return sameRow
            }
        }
        return Math.min(8, Math.max(1, buttons.length))
    }

    openCreateListModal() {
        if (!this.dom.modalCreateList) return
        if (this.dom.inputCustomListName) {
            this.dom.inputCustomListName.value = ''
            this.dom.inputCustomListName.placeholder = ''
        }
        this._setCreateListNameError(false)
        this.selectedListIcon = 'book'
        this.renderIconPicker()
        this._updateCreateListPreview()
        this.dom.modalCreateList.style.display = 'flex'
        this.dom.modalCreateList.classList.add('show')
        requestAnimationFrame(() => {
            this.dom.inputCustomListName?.focus()
        })
    }

    closeCreateListModal() {
        this._setCreateListNameError(false)
        if (this.dom.modalCreateList) {
            this.dom.modalCreateList.classList.remove('show')
            setTimeout(() => {
                if (!this.dom.modalCreateList.classList.contains('show')) this.dom.modalCreateList.style.display = 'none'
            }, 180)
        }
    }

    renderIconPicker() {
        if (!this.dom.customListIconPicker) return
        this.dom.customListIconPicker.setAttribute?.('role', 'radiogroup')
        this.dom.customListIconPicker.innerHTML = ''
        this.iconDefs.forEach((def, idx) => {
            const isSelected = this.selectedListIcon === def.id
            const iconLabel = t('bookshelf.icon.' + def.id)
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = `icon-pick-btn ${isSelected ? 'active' : ''}`
            btn.dataset.iconId = def.id
            btn.setAttribute('role', 'radio')
            btn.setAttribute('aria-checked', isSelected ? 'true' : 'false')
            btn.setAttribute('tabindex', isSelected ? '0' : '-1')
            btn.title = iconLabel
            btn.setAttribute('aria-label', iconLabel)
            btn.innerHTML = def.svg
            btn.addEventListener('click', () => {
                this._selectCreateListIcon(def.id)
            })
            btn.addEventListener('keydown', e => {
                const buttons = Array.from(this.dom.customListIconPicker?.querySelectorAll('.icon-pick-btn') || [])
                const total = buttons.length || this.iconDefs.length
                if (!total) return
                const cols = this._getIconPickerColumnCount(buttons)
                let nextIdx = null
                if (e.key === 'ArrowRight') nextIdx = (idx + 1) % total
                else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + total) % total
                else if (e.key === 'ArrowDown') nextIdx = (idx + cols < total) ? idx + cols : (idx % cols)
                else if (e.key === 'ArrowUp') {
                    if (idx - cols >= 0) nextIdx = idx - cols
                    else {
                        const col = idx % cols
                        const lastRowStart = Math.floor((total - 1) / cols) * cols
                        nextIdx = lastRowStart + col < total ? lastRowStart + col : lastRowStart + col - cols
                    }
                } else if (e.key === 'Home') nextIdx = 0
                else if (e.key === 'End') nextIdx = total - 1
                else if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault()
                    this._selectCreateListIcon(def.id, { focusButton: true })
                    return
                }
                if (nextIdx !== null && nextIdx >= 0 && nextIdx < this.iconDefs.length) {
                    e.preventDefault()
                    this._selectCreateListIcon(this.iconDefs[nextIdx].id, { focusButton: true })
                }
            })
            this.dom.customListIconPicker.appendChild(btn)
        })
    }

    async handleCreateListConfirm() {
        const name = this.dom.inputCustomListName?.value.trim()
        if (!name) {
            this._setCreateListNameError(true)
            this.dom.inputCustomListName?.focus()
            return
        }
        this._setCreateListNameError(false)
        const newList = {
            id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name,
            icon: this.selectedListIcon || 'book',
            isBuiltIn: false,
            createdAt: Date.now()
        }
        await db.saveCustomList(newList)
        this.closeCreateListModal()
        this.app.dialogs.showToast(t('bookshelf.createListSuccessToast', { name }), 'success')
        
        // Auto-switch to newly created list
        this.shelfCategory = newList.id
        this.dom.navCategoryItems?.forEach(i => i.classList.remove('active'))
        if (this.dom.currentCategoryTitle) {
            this.dom.currentCategoryTitle.innerText = newList.name
        }
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    async openManageBookListsModal(bookId) {
        this.managingBookId = bookId
        const book = await db.getBook(bookId)
        if (!book) return

        if (this.dom.manageBookTargetTitle) {
            this.dom.manageBookTargetTitle.innerText = t('bookshelf.quotedBookTitle', { title: book.title || t('book.untitled') })
        }

        this.customLists = await db.getAllCustomLists()
        const currentListIds = book.customListIds || []

        if (this.dom.bookListsCheckboxContainer) {
            this.dom.bookListsCheckboxContainer.innerHTML = this.customLists.length ? '' : `<p class="empty-list-hint">${escapeHTML(t('bookshelf.manageListsEmptyHint'))}</p>`
            this.customLists.forEach(list => {
                const isChecked = currentListIds.includes(list.id)
                const row = document.createElement('label')
                row.className = 'book-list-check-row'

                const input = document.createElement('input')
                input.type = 'checkbox'
                input.dataset.listId = list.id
                input.checked = isChecked

                const iconSpan = document.createElement('span')
                iconSpan.className = 'list-icon-wrap'
                iconSpan.innerHTML = this.getListIconSvg(list.icon)

                const nameSpan = document.createElement('span')
                nameSpan.style.cssText = 'flex: 1; font-size: 0.88rem; font-weight: 500; color: var(--text-main);'
                nameSpan.textContent = list.name

                row.appendChild(input)
                row.appendChild(iconSpan)
                row.appendChild(nameSpan)
                this.dom.bookListsCheckboxContainer.appendChild(row)
            })
        }

        if (this.dom.modalManageBookLists) {
            this.dom.modalManageBookLists.style.display = 'flex'
            this.dom.modalManageBookLists?.classList.add('show')
        }
    }

    closeManageBookListsModal() {
        if (this.dom.modalManageBookLists) {
            this.dom.modalManageBookLists.classList.remove('show')
            setTimeout(() => {
                if (!this.dom.modalManageBookLists.classList.contains('show')) this.dom.modalManageBookLists.style.display = 'none'
            }, 180)
        }
        this.managingBookId = null
    }

    async handleSaveBookLists() {
        if (!this.managingBookId) return
        const checked = []
        this.dom.bookListsCheckboxContainer?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            if (cb.dataset.listId) checked.push(cb.dataset.listId)
        })

        await db.setBookLists(this.managingBookId, checked)
        const book = await db.getBook(this.managingBookId)
        this.closeManageBookListsModal()
        this.app.dialogs.showToast(t('bookshelf.saveBookListsSuccessToast', { title: book?.title || t('book.untitled') }), 'success')
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    async openBatchAddToListModal() {
        if (!this.shelfCategory.startsWith('list_')) return
        const listId = this.shelfCategory
        const currentList = this.customLists.find(l => l.id === listId)
        if (!currentList) return

        const batchAddIconEl = document.getElementById('batch-add-list-modal-icon')
        if (batchAddIconEl) {
            batchAddIconEl.innerHTML = this.getListIconSvg(currentList.icon)
        }
        if (this.dom.batchAddListModalTitle) {
            this.dom.batchAddListModalTitle.innerText = t('bookshelf.batchAddToListTitle', { name: currentList.name })
        }

        const allBooks = await db.getAllBooks()
        if (this.dom.batchAddBooksContainer) {
            this.dom.batchAddBooksContainer.innerHTML = ''
            allBooks.forEach(b => {
                const inList = b.customListIds && b.customListIds.includes(listId)
                const row = document.createElement('label')
                row.className = 'book-list-check-row'
                const bTitle = resolveBookTitle(b.title, b.filename)
                row.innerHTML = `
                    <input type="checkbox" data-book-id="${escapeHTML(String(b.id || ''))}" ${inList ? 'checked' : ''} />
                    <span class="book-list-row-title">${escapeHTML(bTitle)}</span>
                    <span class="book-list-row-author">${escapeHTML(b.author || '')}</span>
                `
                this.dom.batchAddBooksContainer.appendChild(row)
            })
        }

        if (this.dom.modalBatchAddToList) {
            this.dom.modalBatchAddToList.style.display = 'flex'
            this.dom.modalBatchAddToList?.classList.add('show')
        }
    }

    closeBatchAddToListModal() {
        if (this.dom.modalBatchAddToList) {
            this.dom.modalBatchAddToList.classList.remove('show')
            setTimeout(() => {
                if (!this.dom.modalBatchAddToList.classList.contains('show')) this.dom.modalBatchAddToList.style.display = 'none'
            }, 180)
        }
    }

    closeBatchAddModal() {
        this.closeBatchAddToListModal()
    }

    async handleConfirmBatchAddList() {
        if (!this.shelfCategory.startsWith('list_')) return
        const listId = this.shelfCategory
        const checkedBookIds = new Set()
        this.dom.batchAddBooksContainer?.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            if (cb.dataset.bookId) checkedBookIds.add(cb.dataset.bookId)
        })

        const allBooks = await db.getAllBooks()
        for (const b of allBooks) {
            if (!b.customListIds) b.customListIds = []
            const isChecked = checkedBookIds.has(b.id)
            const wasInList = b.customListIds.includes(listId)

            if (isChecked && !wasInList) {
                b.customListIds.push(listId)
                await db.saveBook(b)
            } else if (!isChecked && wasInList) {
                b.customListIds = b.customListIds.filter(id => id !== listId)
                await db.saveBook(b)
            }
        }

        this.closeBatchAddToListModal()
        this.app.dialogs.showToast(t('bookshelf.batchAddToListSuccessToast'), 'list')
        await this.renderCustomListsSidebar()
        await this.refreshBookshelf()
    }

    async refreshLocale() {
        this.updateOverviewControlsUI()
        this.updateOverviewActiveFiltersBar()
        if (this.dom.overviewTagsPopover && this.dom.overviewTagsPopover.style.display !== 'none') {
            await this.renderOverviewTagsPopoverList()
        }

        if (this.dom.btnToggleTagManagement) {
            this.dom.btnToggleTagManagement.innerText = this.tagManagementMode
                ? t('bookshelf.exitTagManageMode')
                : t('modal.tagLibManageMode')
        }
        if (this.dom.modalGlobalTags && this.dom.modalGlobalTags.style.display !== 'none') {
            await this.renderGlobalTagsList()
        }

        if (this.isBatchMode) {
            this.updateBatchSelectionUI()
            if (this.dom.modalBatchTags && (this.dom.modalBatchTags.classList.contains('show') || this.dom.modalBatchTags.style.display === 'flex')) {
                const draftTag = this.dom.inputBatchTag?.value ?? ''
                if (this.dom.batchTagsPrompt) {
                    this.dom.batchTagsPrompt.innerText = t('bookshelf.batchTagsSelectedPrompt', { count: this.selectedBookIds.size })
                }
                if (this.dom.batchExistingTagsList && this.dom.batchExistingTagsList.querySelector('.tags-badge') === null && this.selectedBookIds.size > 0) {
                    this.dom.batchExistingTagsList.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(t('bookshelf.batchTagsEmpty'))}</span>`
                } else {
                    this.dom.batchExistingTagsList?.querySelectorAll('.tags-badge').forEach(badge => {
                        const tagLabel = badge.firstElementChild?.textContent?.replace(/\s*\(\d+\/\d+\)$/, '')
                        if (tagLabel) badge.title = t('bookshelf.batchTagRemoveTooltip', { tag: tagLabel })
                    })
                }
                if (this.dom.inputBatchTag) this.dom.inputBatchTag.value = draftTag
            }
        }

        this._syncHeaderSearchState()
        await this.renderCustomListsSidebar()
        if (this.dom.modalCreateList && (this.dom.modalCreateList.classList.contains('show') || this.dom.modalCreateList.style.display === 'flex')) {
            if (this.dom.inputCustomListName) {
                this.dom.inputCustomListName.placeholder = ''
            }
            this.renderIconPicker()
            this._updateCreateListPreview()
        }
        if (this.dom.modalManageBookLists && (this.dom.modalManageBookLists.classList.contains('show') || this.dom.modalManageBookLists.style.display === 'flex') && this.managingBookId) {
            const book = await db.getBook(this.managingBookId)
            if (book && this.dom.manageBookTargetTitle) {
                this.dom.manageBookTargetTitle.innerText = t('bookshelf.quotedBookTitle', { title: book.title || t('book.untitled') })
            }
            const emptyHintEl = this.dom.bookListsCheckboxContainer?.querySelector('.empty-list-hint')
            if (emptyHintEl) emptyHintEl.innerText = t('bookshelf.manageListsEmptyHint')
        }
        if (this.dom.modalBatchAddToList && (this.dom.modalBatchAddToList.classList.contains('show') || this.dom.modalBatchAddToList.style.display === 'flex') && this.shelfCategory.startsWith('list_')) {
            const currentList = this.customLists.find(l => l.id === this.shelfCategory)
            if (currentList && this.dom.batchAddListModalTitle) {
                this.dom.batchAddListModalTitle.innerText = t('bookshelf.batchAddToListTitle', { icon: currentList.icon, name: currentList.name })
            }
        }

        await this.refreshBookshelf({ resetScroll: false })
        this.onBooksWorkspaceScroll()
    }

    _scrollToBookAnchor(bookId) {
        if (!bookId) return
        if (this._isGridVirtualized && this.dom.modernGridWrapper?.style.display !== 'none') {
            const idx = this._virtualBooks?.findIndex(b => b.id === bookId) ?? -1
            if (idx === -1) return
            const cols = this._virtualCols || 4
            const rowHeight = this._virtualRowHeight || 321
            const row = Math.floor(idx / cols)
            this._measureVirtualViewport()
            const targetScrollTop = this._virtualGridTop + row * rowHeight
            if (this.dom.booksWorkspace) {
                this.dom.booksWorkspace.scrollTop = targetScrollTop
                this._renderVirtualizedSlice()
            }
        } else {
            const selector = `[data-id="${CSS.escape(bookId)}"]`
            const gridVisible = this.dom.modernGridWrapper?.style.display !== 'none' && this.dom.booksGrid?.style.display !== 'none'
            const container = gridVisible ? this.dom.booksGrid : this.dom.booksTableBody
            const card = container?.querySelector(selector)
            card?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
            card?.focus?.()
        }
    }
}
