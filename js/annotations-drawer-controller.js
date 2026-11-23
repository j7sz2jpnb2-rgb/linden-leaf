import { DomEvents } from './dom-events.js'
import { getLocale, t } from './i18n.js'
import * as db from './db.js'
import { platformBridge } from './platformBridge.js'
import { performWebSearch } from './search-config.js'
import { resolveExcerptSource } from './excerpt-source-resolver.js'
import { uiSymbol, escapeHTML, mapHighlightDisplayColor } from './ui-format.js'

/** Owns annotations UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class AnnotationsDrawerController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this.activeDrawer = null
        this.activeTab = 'toc'
        this.selectedTextInfo = null
        this.clickedHighlightInfo = null
        this.shelfNotesFilter = { bookId: 'all', color: 'all', query: '' }
        this._shelfNotesInitialized = false
    }

    initDOM() {
        this.dom = {
            navCatNotes: document.getElementById('nav-cat-notes'),
            sidebarNotesCount: document.getElementById('sidebar-notes-count'),
            shelfNotesView: document.getElementById('shelf-notes-view'),
            shelfNotesStatsBadge: document.getElementById('shelf-notes-stats-badge'),
            shelfNotesHeaderActions: document.getElementById('shelf-notes-header-actions'),
            selectNotesBookFilter: document.getElementById('select-notes-book-filter'),
            inputShelfNotesSearch: document.getElementById('input-shelf-notes-search'),
            btnClearShelfNotesSearch: document.getElementById('btn-clear-shelf-notes-search'),
            shelfNotesColorFilters: document.getElementById('shelf-notes-color-filters'),
            shelfNotesList: document.getElementById('shelf-notes-list'),
            btnExportShelfNotes: document.getElementById('btn-export-shelf-notes'),
            btnToggleTOC: document.getElementById('btn-toggle-toc'),
            btnToggleSearch: document.getElementById('btn-toggle-search'),
            btnToggleNotes: document.getElementById('btn-toggle-notes'),
            btnToggleSettings: document.getElementById('btn-toggle-settings'),
            sidebarDrawer: document.getElementById('sidebar-drawer'),
            drawerBackdrop: document.getElementById('drawer-backdrop'),
            drawerCloseBtn: document.getElementById('drawer-close-btn'),
            tabButtons: document.querySelectorAll('.tab-btn'),
            tabPanels: {
                toc: document.getElementById('panel-toc'),
                notes: document.getElementById('panel-notes'),
                search: document.getElementById('panel-search'),
                settings: document.getElementById('panel-settings')
            },
            tocContainer: document.getElementById('toc-tree-container'),
            notesContainer: document.getElementById('notes-list-container'),
            btnExportNotes: document.getElementById('btn-export-notes'),
            selectionPopup: document.getElementById('selection-popup'),
            popupMultiBadge: document.getElementById('popup-multi-badge'),
            btnPopupUnderline: document.getElementById('popup-underline'),
            btnPopupDashed: document.getElementById('popup-dashed'),
            btnPopupCopy: document.getElementById('popup-copy'),
            btnPopupSearch: document.getElementById('popup-search'),
            btnPopupNote: document.getElementById('popup-note'),
            btnPopupShare: document.getElementById('popup-share'),
            popupColorDots: document.querySelectorAll('#selection-popup .color-dot'),
            highlightActionPopup: document.getElementById('highlight-action-popup'),
            hlActionNote: document.getElementById('hl-action-note'),
            hlActionCopy: document.getElementById('hl-action-copy'),
            hlActionShare: document.getElementById('hl-action-share'),
            hlActionDel: document.getElementById('hl-action-del'),
            hlActionColorDots: document.querySelectorAll('#highlight-action-popup .color-dot'),
            popupAi: document.getElementById('popup-ai'),
            popupDict: document.getElementById('popup-dict'),
            popupTranslatePara: document.getElementById('popup-translate-para')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(this.dom.btnToggleTOC, 'click', () => this.openDrawer('toc'));
        this.events.on(this.dom.btnToggleSearch, 'click', () => this.openDrawer('search'));
        this.events.on(this.dom.btnToggleNotes, 'click', () => this.openDrawer('notes'));
        this.events.on(this.dom.btnToggleSettings, 'click', () => this.openDrawer('settings'));
        this.events.on(this.dom.drawerCloseBtn, 'click', () => this.closeDrawer());
        this.events.on(this.dom.drawerBackdrop, 'click', () => this.closeDrawer());
        this.dom.tabButtons.forEach(btn => {
            this.events.on(btn, 'click', () => this.switchTab(btn.dataset.tab))
        });
        [this.dom.selectionPopup, this.dom.highlightActionPopup].forEach(p => {
            if (p) {
                this.events.on(p, 'mousedown', e => e.preventDefault())
                this.events.on(p, 'click', e => e.stopPropagation())
            }
        });
        this.dom.popupColorDots.forEach(dot => {
            this.events.on(dot, 'click', () => this.createHighlight(dot.dataset.color, 'highlight'))
        });
        this.events.on(this.dom.btnPopupUnderline, 'click', () => {
            this.createHighlight('#2563eb', 'underline')
        });
        this.events.on(this.dom.btnPopupDashed, 'click', () => {
            this.createHighlight('#64748b', 'dashed')
        });
        this.events.on(this.dom.btnPopupNote, 'click', async () => {
            this.hideSelectionPopup(true)
            const noteText = await this.app.dialogs.showInputDialog({
                title: t('annotations.addNoteTitle'),
                placeholder: t('annotations.addNotePlaceholder'),
                isMultiline: true
            })
            if (noteText !== null) {
                await this.createHighlight('#facc15', 'highlight', noteText)
            }
        });
        this.events.on(this.dom.btnPopupCopy, 'click', async () => {
            await this.app.copyMultiSelectionOrSingle()
        });
        this.events.on(this.dom.btnPopupSearch, 'click', () => {
            const text = (this.multiSelectedRanges && this.multiSelectedRanges.length > 0)
                ? this.multiSelectedRanges.map(r => r.text).filter(Boolean).join(' ')
                : (this.selectedTextInfo?.text || this._frozenSelectionSnapshot?.text || '')
            if (text) {
                performWebSearch(this.app.settings, text, (msg, icon) => this.app.dialogs.showToast(msg, icon))
                this.hideSelectionPopup()
            }
        });
        this.events.on(this.dom.popupDict, 'click', () => {
            const selInfo = this.selectedTextInfo ? { ...this.selectedTextInfo } : (this._frozenSelectionSnapshot ? { ...this._frozenSelectionSnapshot } : null)
            this.hideSelectionPopup()
            if (selInfo && selInfo.text) {
                this.app.cards.showDictionaryCard(selInfo)
            }
        });
        this.events.on(this.dom.popupTranslatePara, 'click', async () => {
            const selInfo = this.selectedTextInfo ? { ...this.selectedTextInfo } : (this._frozenSelectionSnapshot ? { ...this._frozenSelectionSnapshot } : null)
            this.hideSelectionPopup()
            if (selInfo && selInfo.text) {
                await this.app.cards.handleInPlaceParagraphTranslation(selInfo)
            }
        });
        this.events.on(this.dom.popupAi, 'click', () => {
            // Snapshot selectedTextInfo or frozen selection snapshot BEFORE hideSelectionPopup clears it!
            const selInfo = this.selectedTextInfo ? { ...this.selectedTextInfo } : (this._frozenSelectionSnapshot ? { ...this._frozenSelectionSnapshot } : null)
            this.hideSelectionPopup()
            if (this.app.aiSidebar && selInfo) {
                this.app.aiSidebar.openWithSelection(selInfo)
            } else if (this.app.aiSidebar) {
                this.app.aiSidebar.openSidebar()
            } else {
                this.app.cards.openAiAssistantModal(selInfo)
            }
        });
        this.dom.hlActionColorDots.forEach(dot => {
            this.events.on(dot, 'click', async () => {
                if (this.clickedHighlightInfo) {
                    await this.updateHighlightColor(this.clickedHighlightInfo.value, dot.dataset.color)
                }
            })
        });
        this.events.on(this.dom.hlActionNote, 'click', async () => {
            if (this.clickedHighlightInfo) {
                const targetValue = this.clickedHighlightInfo.value
                const hl = await this.findHighlightByCFI(targetValue)
                const currentNote = hl?.note || ''
                this.hideHighlightActionPopup()
                const noteText = await this.app.dialogs.showInputDialog({
                    title: t('annotations.editNoteTitle'),
                    value: currentNote,
                    placeholder: t('annotations.editNotePlaceholder'),
                    isMultiline: true
                })
                if (noteText !== null) {
                    await this.updateHighlightNote(targetValue, noteText)
                }
            }
        });
        this.events.on(this.dom.hlActionCopy, 'click', async () => {
            if (this.clickedHighlightInfo) {
                const hl = await this.findHighlightByCFI(this.clickedHighlightInfo.value)
                if (hl?.text) navigator.clipboard.writeText(hl.text)
                this.hideHighlightActionPopup()
            }
        });
        this.events.on(this.dom.hlActionDel, 'click', async () => {
            if (this.clickedHighlightInfo) {
                await this.deleteHighlightByCFI(this.clickedHighlightInfo.value)
                this.hideHighlightActionPopup()
            }
        });
        this.events.on(this.dom.btnPopupShare, 'click', () => {
            const format = this.app.currentBookData?.format || (this.app.pdfViewport ? 'pdf' : 'epub')
            const sourceToc = this.app.currentPdfTOC || this.app.toc || this.app._activeSession?.toc || []
            const resolved = resolveExcerptSource({
                range: this.selectedTextInfo?.range,
                currentLocation: this.app.currentLocation,
                reader: this.app.foliateView || this.app.pdfViewport,
                format,
                pdfViewport: this.app.pdfViewport
            }, sourceToc)

            if (this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
                const joinedQuote = this.multiSelectedRanges.map(r => r.text).join('\n\n……\n\n')
                this.app.cards.openQuoteCardModal(joinedQuote, resolved.chapterTitle, resolved.locationInfo)
                this.hideSelectionPopup()
            } else if (this.selectedTextInfo?.text) {
                this.app.cards.openQuoteCardModal(this.selectedTextInfo.text, resolved.chapterTitle, resolved.locationInfo)
                this.hideSelectionPopup()
            }
        });
        this.events.on(this.dom.hlActionShare, 'click', async () => {
            if (this.clickedHighlightInfo) {
                const hl = await this.findHighlightByCFI(this.clickedHighlightInfo.value)
                if (hl?.text) {
                    const format = hl.formatType || this.app.currentBookData?.format || (this.app.pdfViewport ? 'pdf' : 'epub')
                    const sourceToc = this.app.currentPdfTOC || this.app.toc || this.app._activeSession?.toc || []
                    const resolved = resolveExcerptSource({
                        highlight: hl,
                        chapterTitle: hl.chapterTitle,
                        currentLocation: this.app.currentLocation,
                        reader: this.app.foliateView || this.app.pdfViewport,
                        format,
                        pdfViewport: this.app.pdfViewport
                    }, sourceToc)
                    this.app.cards.openQuoteCardModal(hl.text, resolved.chapterTitle, resolved.locationInfo)
                }
            }
        });
    }

    resetSessionState() {
        this.hideSelectionPopup()
        this.hideHighlightActionPopup()
        this.multiSelectedRanges = []
        this.clickedHighlightInfo = null
    }

    dispose() { this.resetSessionState(); this.events.dispose(); this._bound = false }

    renderVirtualMultiSelections() {
        if (!this.app.foliateView || !this.multiSelectedRanges || this.multiSelectedRanges.length <= 1) {
            this.clearVirtualMultiSelections()
            return
        }
        this.clearVirtualMultiSelections()
        // Only render virtual annotations for accumulated historical selections
        // The latest selection is natively highlighted by the browser
        const historical = this.multiSelectedRanges.slice(0, this.multiSelectedRanges.length - 1)
        historical.forEach((item, idx) => {
            if (item.cfi) {
                try {
                    this.app.foliateView.addAnnotation({
                        value: item.cfi,
                        id: `__vsel_${idx}__`,
                        color: 'rgba(59, 130, 246, 0.38)',
                        style: 'highlight'
                    })
                } catch (e) {
                    console.warn('renderVirtualMultiSelections error:', e)
                }
            }
        })
    }

    clearVirtualMultiSelections() {
        if (!this.app.foliateView) return
        if (this.multiSelectedRanges && this.multiSelectedRanges.length > 0) {
            this.multiSelectedRanges.forEach((item, idx) => {
                if (item.cfi) {
                    try {
                        this.app.foliateView.deleteAnnotation({
                            value: item.cfi,
                            id: `__vsel_${idx}__`
                        })
                    } catch (e) {}
                }
            })
        }
        for (let i = 0; i < 20; i++) {
            try {
                this.app.foliateView.deleteAnnotation({ id: `__vsel_${i}__` })
            } catch (e) {}
        }
    }

    showSelectionPopup(rect) {
        if (this.app.dialogs.dom.globalModalBackdrop?.classList.contains('show')) return
        const popup = this.dom.selectionPopup
        if (!popup) return
        this.app.cancelPendingReaderUIToggle()
        popup.style.display = 'flex'
        popup.scrollLeft = 0 // Ensure primary tools (highlight colors, underline, note) are scrolled into view
        const popupWidth = popup.offsetWidth || 280
        const popupHeight = popup.offsetHeight || 44
        let top = rect.top - popupHeight - 10
        if (top < 10) top = rect.top + rect.height + 10
        top = Math.max(10, Math.min(window.innerHeight - popupHeight - 10, top))
        let left = rect.left + (rect.width / 2) - (popupWidth / 2)
        const isMobile = window.innerWidth <= 768 || document.documentElement.classList.contains('is-mobile-viewport')
        const sideMargin = isMobile ? 8 : 12
        left = Math.max(sideMargin, Math.min(window.innerWidth - popupWidth - sideMargin, left))
        
        popup.style.top = `${top}px`
        popup.style.left = `${left}px`
        popup.classList.add('active')

        if (this.dom.btnPopupSearch) {
            const engine = this.app.settings?.searchEngine || 'baidu'
            const engineNames = {
                baidu: t('annotations.engine.baidu'),
                bing: t('annotations.engine.bing'),
                google: 'Google',
                duckduckgo: 'DuckDuckGo',
                custom: t('annotations.engine.custom')
            }
            const name = engineNames[engine] || t('annotations.engine.webFallback')
            this.dom.btnPopupSearch.title = t('annotations.searchSelectedTitle', { engine: name })
        }
    }

    hideSelectionPopup(preserveSelection = false) {
        if (this.dom.selectionPopup) {
            this.dom.selectionPopup.classList.remove('active')
            this.dom.selectionPopup.style.display = 'none'
        }
        if (!preserveSelection) {
            this.selectedTextInfo = null
            this._frozenSelectionSnapshot = null
            this.app.pdfViewport?.clearSelection?.()
        }
    }

    showHighlightActionPopup(rect) {
        const popup = this.dom.highlightActionPopup
        if (!popup) return
        this.app.cancelPendingReaderUIToggle()
        popup.style.display = 'flex'
        const popupWidth = popup.offsetWidth || 220
        const popupHeight = popup.offsetHeight || 44
        let top = rect.top - popupHeight - 10
        if (top < 10) top = rect.top + rect.height + 10
        let left = rect.left + (rect.width / 2) - (popupWidth / 2)
        left = Math.max(12, Math.min(window.innerWidth - popupWidth - 12, left))

        popup.style.top = `${top}px`
        popup.style.left = `${left}px`
        popup.classList.add('active')
    }

    hideHighlightActionPopup() {
        if (this.dom.highlightActionPopup) {
            this.dom.highlightActionPopup.classList.remove('active')
            this.dom.highlightActionPopup.style.display = 'none'
        }
        this.clickedHighlightInfo = null
    }

    async onHighlightClicked(value, range) {
        this.app.cancelPendingReaderUIToggle()
        this.hideSelectionPopup()
        if (!range) return
        try {
            const rect = range.getBoundingClientRect()
            const doc = range.startContainer?.ownerDocument
            const iframe = doc?.defaultView?.frameElement || this.app.foliateView?.shadowRoot?.querySelector('iframe') || this.app.foliateView
            const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
            const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
            const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
            const absRect = {
                top: iframeRect.top + ((rect.top || 0) * scaleY),
                left: iframeRect.left + ((rect.left || 0) * scaleX),
                width: (rect.width || 80) * scaleX,
                height: (rect.height || 24) * scaleY
            }
            this.clickedHighlightInfo = { value, range, rect: absRect }
            this.showHighlightActionPopup(absRect)
        } catch (e) {
            console.warn('onHighlightClicked error:', e)
        }
    }

    async createHighlight(color, style = 'highlight', note = '', targetRef = null) {
        const activeSession = this.app._activeSession
        const snapshot = this.app._currentSnapshot || {}
        const bookId = targetRef?.bookId || activeSession?.bookId || this.app.currentBookId
        if (!bookId || (activeSession && !activeSession.isCurrent())) return
        const target = targetRef || this.selectedTextInfo || this._frozenSelectionSnapshot
        if (!target && (!this.multiSelectedRanges || this.multiSelectedRanges.length === 0)) return
        
        const colorVal = color || '#facc15'
        const targetBlobRevision = targetRef ? (targetRef.blobRevision || (targetRef.bookId === this.app.currentBookId ? snapshot.blobRevision : null)) : snapshot.blobRevision
        const targetRevisionOrigin = targetRef ? (targetRef.revisionOrigin || (targetRef.bookId === this.app.currentBookId ? snapshot.revisionOrigin : null)) : snapshot.revisionOrigin
        const targetDocHash = targetRef ? (targetRef.documentHash || (targetRef.bookId === this.app.currentBookId ? snapshot.documentHash : null)) : snapshot.documentHash

        // Multi-range batch creation
        if (!targetRef && this.multiSelectedRanges && this.multiSelectedRanges.length > 1) {
            const rangesToProcess = [...this.multiSelectedRanges]
            this.clearVirtualMultiSelections()
            for (const item of rangesToProcess) {
                if (activeSession && !activeSession.isCurrent()) return
                const cfi = item.cfi
                const text = item.text.trim()
                if (!text || !cfi) continue
                const hl = {
                    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    bookId: bookId,
                    cfi: cfi,
                    text: text,
                    color: colorVal,
                    style: style,
                    note: note,
                    chapterTitle: this.app.currentLocation?.tocItem?.label || t('annotations.bodyFallback'),
                    createdAt: Date.now(),
                    blobRevision: targetBlobRevision,
                    revisionOrigin: targetRevisionOrigin,
                    documentHash: targetDocHash
                }
                await db.saveHighlight(hl)
                if (activeSession && !activeSession.isCurrent()) return
                if (this.app.foliateView && cfi) {
                    try {
                        await this.app.foliateView.addAnnotation({
                            value: `${cfi}::${style}`,
                            id: hl.id,
                            color: hl.color,
                            style: hl.style
                        })
                    } catch (e) {}
                }
            }
            if (activeSession && !activeSession.isCurrent()) return
            this.app.dialogs.showToast(t('annotations.addedMulti', { count: rangesToProcess.length }), 'success')
            this.updateSidebarNotesCount()
            this.multiSelectedRanges = []
            const iframe = this.app.foliateView?.shadowRoot?.querySelector('iframe') || this.app.foliateView?.querySelector('iframe')
            iframe?.contentDocument?.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
            this.loadNotesList()
            return
        }

        const text = (target.text || target.selectedText || targetRef?.selectedText || targetRef?.text || '').trim()

        if (this.app.pdfViewport && (target?.formatType === 'pdf' || target?.pdfTarget)) {
            const hl = {
                id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId: bookId,
                formatType: 'pdf',
                text: text,
                color: colorVal,
                style: style,
                note: note,
                chapterTitle: targetRef?.chapterTitle || this.app.currentLocation?.tocItem?.label || t('annotations.bodyFallback'),
                createdAt: Date.now(),
                blobRevision: targetBlobRevision,
                revisionOrigin: targetRevisionOrigin,
                documentHash: targetDocHash,
                pdfTarget: target.pdfTarget
            }
            await db.saveHighlight(hl)
            if (activeSession && !activeSession.isCurrent()) return
            const allHls = await db.getHighlightsByBook(bookId)
            if (activeSession && !activeSession.isCurrent()) return
            this.app.pdfViewport.setHighlights(allHls, snapshot)
            if (!targetRef) {
                window.getSelection()?.removeAllRanges()
                this.hideSelectionPopup()
            }
            this.loadNotesList()
            this.app.dialogs.showToast(t('annotations.addedHighlight'), 'success')
            return
        }

        const cfi = target.cfi

        // 1. Check if an annotation of the EXACT SAME style already exists on this CFI for current content identity
        const existingNotes = await db.getHighlightsByBook(bookId)
        if (activeSession && !activeSession.isCurrent()) return
        const matched = existingNotes.find(n => n.cfi === cfi && (n.style || 'highlight') === style && db.isContentIdentityMatching(n, snapshot).matches)

        if (matched) {
            // If user clicked the same color/style with no new note -> TOGGLE OFF / CANCEL THIS STYLE!
            if (!note && matched.color === colorVal) {
                await db.deleteHighlight(matched.id)
                if (activeSession && !activeSession.isCurrent()) return
                if (this.app.foliateView && matched.cfi) {
                    await this.app.foliateView.deleteAnnotation({ value: `${matched.cfi}::${style}`, id: matched.id })
                }
                const iframe = this.app.foliateView?.shadowRoot?.querySelector('iframe') || this.app.foliateView?.querySelector('iframe')
                iframe?.contentDocument?.getSelection()?.removeAllRanges()
                this.hideSelectionPopup()
                this.loadNotesList()
                return
            }

            // Update color or note of existing annotation of this style
            matched.color = colorVal
            if (note) matched.note = note
            if (cfi) matched.cfi = cfi
            await db.saveHighlight(matched)
            if (activeSession && !activeSession.isCurrent()) return

            if (this.app.foliateView && matched.cfi) {
                try {
                    await this.app.foliateView.addAnnotation({
                        value: `${matched.cfi}::${style}`,
                        id: matched.id,
                        color: matched.color,
                        style: matched.style
                    })
                } catch (err) {}
            }

            if (!targetRef) {
                const iframe = this.app.foliateView?.shadowRoot?.querySelector('iframe') || this.app.foliateView?.querySelector('iframe')
                iframe?.contentDocument?.getSelection()?.removeAllRanges()
                this.hideSelectionPopup()
            }
            this.loadNotesList()
            return
        }

        // 2. New Highlight Record (coexists with other styles like highlight + underline!)
        const hl = {
            id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: bookId,
            cfi: cfi,
            text: text,
            color: colorVal,
            style: style,
            note: note,
            chapterTitle: targetRef?.chapterTitle || this.app.currentLocation?.tocItem?.label || t('annotations.bodyFallback'),
            createdAt: Date.now(),
            blobRevision: targetBlobRevision,
            revisionOrigin: targetRevisionOrigin,
            documentHash: targetDocHash
        }

        await db.saveHighlight(hl)
        if (activeSession && !activeSession.isCurrent()) return

        // Draw annotation immediately onto foliate-view
        if (this.app.foliateView && cfi) {
            try {
                await this.app.foliateView.addAnnotation({
                    value: `${cfi}::${style}`,
                    id: hl.id,
                    color: hl.color,
                    style: hl.style
                })
            } catch (err) {
                console.warn('Failed to draw annotation:', err)
            }
        }

        if (!targetRef) {
            // Clear text selection
            const iframe = this.app.foliateView?.shadowRoot?.querySelector('iframe') || this.app.foliateView?.querySelector('iframe')
            iframe?.contentDocument?.getSelection()?.removeAllRanges()
            this.hideSelectionPopup()
        }

        this.loadNotesList()
        this.app.dialogs.showToast(t('annotations.addedHighlight'), 'success')
    }

    async updateHighlightColor(value, newColor) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            // If user clicked the SAME color again -> TOGGLE OFF / CANCEL HIGHLIGHT!
            if (hl.color === newColor) {
                await this.deleteHighlightByCFI(value)
                this.hideHighlightActionPopup()
                return
            }

            hl.color = newColor
            await db.saveHighlight(hl)
            // Re-add to redraw color
            if (this.app.foliateView) {
                await this.app.foliateView.addAnnotation({
                    value: `${hl.cfi}::${hl.style || 'highlight'}`,
                    id: hl.id,
                    color: newColor,
                    style: hl.style || 'highlight'
                })
            }
            if (this.app.pdfViewport) {
                const allHls = await db.getHighlightsByBook(this.app.currentBookId)
                this.app.pdfViewport.setHighlights(allHls, this.app._currentSnapshot)
            }
            this.loadNotesList()
            this.hideHighlightActionPopup()
        }
    }

    async updateHighlightNote(value, newNote) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            hl.note = newNote
            await db.saveHighlight(hl)
            this.loadNotesList()
            this.hideHighlightActionPopup()
        }
    }

    async deleteHighlightByCFI(value) {
        const hl = await this.findHighlightByCFI(value)
        if (hl) {
            await db.deleteHighlight(hl.id)
        this.updateSidebarNotesCount()
            if (this.app.foliateView) {
                await this.app.foliateView.deleteAnnotation({ value: `${hl.cfi}::${hl.style || 'highlight'}`, id: hl.id })
            }
            if (this.app.pdfViewport) {
                const allHls = await db.getHighlightsByBook(this.app.currentBookId)
                this.app.pdfViewport.setHighlights(allHls, this.app._currentSnapshot)
            }
            this.loadNotesList()
        }
    }

    async findHighlightByCFI(value) {
        if (!this.app.currentBookId || !value) return null
        const rawCFI = value.includes('::') ? value.split('::')[0] : value
        const notes = await db.getHighlightsByBook(this.app.currentBookId)
        // 1. Exact ID or exact CFI+style match
        const exactMatch = notes.find(n => n.id === value || `${n.cfi}::${n.style}` === value || n.cfi === value)
        if (exactMatch) return exactMatch
        // 2. Fallback to raw CFI
        return notes.find(n => n.cfi === rawCFI) || null
    }

    openDrawer(tab) {
        const isShelfMode = !this.app.currentBookId
        if (isShelfMode) {
            this.dom.sidebarDrawer?.classList.add('drawer-shelf-mode')
            if (tab === 'toc' || tab === 'search') tab = 'settings'
            if (tab !== 'notes') tab = 'settings'
        } else {
            this.dom.sidebarDrawer?.classList.remove('drawer-shelf-mode')
        }
        this.updateSettingsPanelAvailability()
        this.app.appearance.updateSettingsUI()
        const panel = this.dom.tabPanels?.settings || document.getElementById('panel-settings')
        if (panel && !panel.getAttribute('data-active-domain')) {
            this.app.appearance.switchSettingsDomain('reading')
        }
        const btnTestTxt = document.getElementById('btn-test-txt-rules')
        const btnApplyTxt = document.getElementById('btn-apply-txt-rules')
        if (btnTestTxt) btnTestTxt.disabled = isShelfMode
        if (btnApplyTxt) btnApplyTxt.disabled = isShelfMode

        this.switchTab(tab)
        if (this.dom.sidebarDrawer) {
            this.dom.sidebarDrawer.style.display = 'flex'
            void this.dom.sidebarDrawer.offsetWidth
            this.dom.sidebarDrawer.classList.add('open')
        }
        this.dom.drawerBackdrop?.classList.add('active')
        this.activeDrawer = true
    }

    updateSettingsPanelAvailability() {
        const panel = this.dom.tabPanels?.settings || document.getElementById('panel-settings')
        if (!panel) return
        const formatStr = String(this.app.currentBookData?.format || this.app.currentBook?.format || '').toLowerCase()
        const isPdf = !!(this.app.pdfViewport || formatStr.includes('pdf'))
        const fixed = !!(isPdf || (this.app.foliateView && this.app.foliateView.isFixedLayout))

        panel.querySelectorAll('[data-ll-fixed-note]').forEach(el => el.remove())
        panel.querySelectorAll('.ll-fixed-disabled').forEach(el => {
            el.classList.remove('ll-fixed-disabled')
            el.removeAttribute('title')
        })
        panel.querySelectorAll('[data-ll-fixed-disabled]').forEach(el => {
            el.disabled = el.dataset.llFixedDisabled === 'true'
            delete el.dataset.llFixedDisabled
        })

        const paperSection = document.getElementById('pdf-paper-settings-section')
        if (paperSection) paperSection.style.display = isPdf ? 'block' : 'none'
        this.app.pdfTools.applyPdfPageAppearance()

        const txtRulesGroup = document.getElementById('adv-group-txt-rules')
        if (txtRulesGroup) {
            txtRulesGroup.style.display = fixed ? 'none' : ''
        }

        if (!fixed) return

        const ineffectiveSelectors = [
            '.font-select-grid',
            '#setting-font-size', '#setting-font-weight', '#setting-line-height',
            '#setting-margin', '#setting-max-width', '#setting-gap', '#setting-letter-spacing',
            '#setting-chinese-quotes', '#setting-writing-mode', '#setting-layout-mode',
            '#reading-presets-section', '#adv-group-typography', '#btn-reset-typography',
            ...(isPdf ? ['#setting-column-count'] : [])
        ]
        ineffectiveSelectors.forEach(sel => {
            panel.querySelectorAll(sel).forEach(el => {
                const row = (el.id === 'reading-presets-section' || el.id === 'adv-group-typography')
                    ? el
                    : (el.closest('.control-row') || el.closest('.setting-section'))
                if (row) {
                    row.classList.add('ll-fixed-disabled')
                    row.title = t('annotations.fixedLayoutHint')
                }
                if ('disabled' in el) { el.dataset.llFixedDisabled = String(el.disabled); el.disabled = true }
            })
        })

        if (isPdf) {
            const typoSection = document.getElementById('typography-settings-section')
            if (typoSection) {
                typoSection.classList.add('ll-fixed-disabled')
                typoSection.title = t('annotations.fixedLayoutHint')
            }
        }
    }

    closeDrawer() {
        this.dom.sidebarDrawer?.classList.remove('open')
        this.dom.drawerBackdrop?.classList.remove('active')
        this.activeDrawer = false
        clearTimeout(this._drawerCloseTimer)
        this._drawerCloseTimer = setTimeout(() => {
            if (!this.activeDrawer && this.dom.sidebarDrawer) {
                this.dom.sidebarDrawer.style.display = 'none'
            }
        }, 450)
    }

    switchTab(tabName) {
        if (!this.app.currentBookId && (tabName === 'toc' || tabName === 'search')) return
        this.activeTab = tabName
        if (tabName === 'settings') {
            this.updateSettingsPanelAvailability()
            this.app.appearance.updateSettingsUI()
            this.app.advancedSettings?.updateDictResourceStatus?.()
            const panel = this.dom.tabPanels?.settings || document.getElementById('panel-settings')
            if (panel && !panel.getAttribute('data-active-domain')) {
                this.app.appearance.switchSettingsDomain('reading')
            }
        }
        this.dom.tabButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName)
        })
        Object.keys(this.dom.tabPanels).forEach(key => {
            const panel = this.dom.tabPanels[key]
            if (!panel) return
            if (key === tabName) {
                panel.style.display = (key === 'settings') ? 'flex' : 'block'
                panel.classList.remove('drawer-panel-active')
                void panel.offsetWidth
                panel.classList.add('drawer-panel-active')
            } else {
                panel.style.display = 'none'
                panel.classList.remove('drawer-panel-active')
            }
        })

        const titles = {
            toc: t('annotations.drawer.toc'),
            notes: t('annotations.drawer.notes'),
            search: t('annotations.drawer.search'),
            settings: t('annotations.drawer.settings')
        }
        if (this.app.dom.drawerTitle) {
            this.app.dom.drawerTitle.innerText = titles[tabName] || t('annotations.drawer.menuFallback')
        }

        if (tabName === 'notes') this.loadNotesList()
        if (tabName === 'toc' && this.app.currentLocation?.tocItem?.href) {
            setTimeout(() => this.highlightActiveTOCItem(this.app.currentLocation.tocItem.href), 50)
        }
        if (tabName === 'search') {
            setTimeout(() => {
                this.app.search.dom.searchQueryInput?.focus()
                this.app.search.dom.searchQueryInput?.select()
            }, 80)
        }
    }

    _buildManualTocTree(manualItems) {
        if (!manualItems || !manualItems.length) return []
        const map = new Map()
        const roots = []
        for (const it of manualItems) {
            map.set(it.id, {
                id: it.id,
                isManual: true,
                parentId: it.parentId,
                order: it.order || 0,
                page: it.pageIndex ?? 0,
                label: (it.title || it.label || t('annotations.toc.pageFallback', { page: (it.pageIndex ?? 0) + 1 })).trim(),
                href: `#page=${(it.pageIndex ?? 0) + 1}`,
                subitems: []
            })
        }
        for (const node of map.values()) {
            if (node.parentId && map.has(node.parentId)) {
                map.get(node.parentId).subitems.push(node)
            } else {
                roots.push(node)
            }
        }
        const sortTree = (list) => {
            list.sort((a, b) => (a.order - b.order) || (a.page - b.page))
            for (const it of list) {
                if (it.subitems.length) sortTree(it.subitems)
            }
        }
        sortTree(roots)
        return roots
    }

    renderTOC(toc) {
        const container = this.dom.tocContainer
        if (!container) return
        container.innerHTML = ''

        let effectiveToc = Array.isArray(toc) ? [...toc] : []
        if (this.app.pdfTools._currentManualToc && this.app.pdfTools._currentManualToc.length > 0) {
            const manualTree = this._buildManualTocTree(this.app.pdfTools._currentManualToc)
            effectiveToc = effectiveToc.length > 0 ? [...effectiveToc, ...manualTree] : manualTree
        }

        if (!effectiveToc || effectiveToc.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.85rem; padding: 1rem 0;">${escapeHTML(t('annotations.toc.empty'))}</div>`
            return
        }

        const buildTree = items => {
            const ul = document.createElement('ul')
            ul.className = 'toc-list'
            let lastKey = ''

            items.forEach(item => {
                const label = (item.label || t('annotations.toc.untitledChapter')).trim().replace(/[\s\t\u3000\u00A0]+/g, ' ')
                const href = item.href || ''
                const key = `${label}:::${href}`
                // Only deduplicate if BOTH the label AND target destination (href/anchor) are identical
                if (key && key === lastKey && (!item.subitems || item.subitems.length === 0)) {
                    return
                }
                lastKey = key

                const li = document.createElement('li')
                li.className = 'toc-item'
                li.dataset.href = item.href
                if (item.isManual && item.id) {
                    li.dataset.manualId = item.id
                    li.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px;'
                    const titleSpan = document.createElement('span')
                    titleSpan.textContent = label
                    titleSpan.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;'
                    const actionsWrap = document.createElement('span')
                    actionsWrap.className = 'manual-toc-actions'
                    actionsWrap.style.cssText = 'display: inline-flex; gap: 4px; flex-shrink: 0;'

                    const mkBtn = (text, cls, title, onClick) => {
                        const b = document.createElement('button')
                        b.type = 'button'
                        b.className = `btn-manual-toc-action ${cls}`
                        b.textContent = text
                        b.title = title
                        b.style.cssText = 'padding: 1px 5px; font-size: 0.72rem; border-radius: 4px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer;'
                        b.addEventListener('click', async (ev) => {
                            ev.stopPropagation()
                            await onClick(ev)
                        })
                        return b
                    }

                    actionsWrap.appendChild(mkBtn(t('annotations.toc.editBtn'), 'btn-manual-toc-edit', t('annotations.toc.editTitle'), async () => {
                        await this.app.pdfTools.editManualTocItemUI(item)
                    }))
                    actionsWrap.appendChild(mkBtn(t('annotations.toc.upBtn'), 'btn-manual-toc-up', t('annotations.toc.upTitle'), async () => {
                        const ids = (this.app.pdfTools._currentManualToc || []).map(x => x.id)
                        const idx = ids.indexOf(item.id)
                        if (idx > 0) {
                            ;[ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]
                            await this.app.pdfTools.reorderManualToc(ids)
                        }
                    }))
                    actionsWrap.appendChild(mkBtn(t('annotations.toc.downBtn'), 'btn-manual-toc-down', t('annotations.toc.downTitle'), async () => {
                        const ids = (this.app.pdfTools._currentManualToc || []).map(x => x.id)
                        const idx = ids.indexOf(item.id)
                        if (idx >= 0 && idx < ids.length - 1) {
                            ;[ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]]
                            await this.app.pdfTools.reorderManualToc(ids)
                        }
                    }))
                    actionsWrap.appendChild(mkBtn(t('common.delete'), 'btn-manual-toc-delete', t('annotations.toc.deleteTitle'), async () => {
                        await this.app.pdfTools.deleteManualTocItem(item.id)
                    }))

                    li.appendChild(titleSpan)
                    li.appendChild(actionsWrap)
                } else {
                    li.innerText = label
                }
                li.addEventListener('click', e => {
                    e.stopPropagation()
                    this.app.navHistory?.pushLocation()
                    if (this.app.pdfViewport) {
                        const pageIdx = typeof item.page === 'number' ? item.page : (parseInt(item.href?.replace(/[^0-9]/g, ''), 10) - 1 || 0)
                        this.app.pdfViewport.goToPage(pageIdx)
                    } else {
                        this.app.foliateView?.goTo(item.href)
                    }
                    this.closeDrawer()
                })
                ul.appendChild(li)

                if (item.subitems && item.subitems.length > 0) {
                    const subUl = buildTree(item.subitems)
                    subUl.style.paddingLeft = '1.2rem'
                    ul.appendChild(subUl)
                }
            })
            return ul
        }

        container.appendChild(buildTree(effectiveToc))
    }

    highlightActiveTOCItem(href) {
        if (!href || !this.dom.tocContainer) return
        const items = Array.from(this.dom.tocContainer.querySelectorAll('.toc-item'))
        if (items.length === 0) return

        // 1. Primary: Exact destination match (including fragment #anchor or JSON dest)
        let matched = items.find(el => (el.dataset.href || '') === href)

        // 2. Fallback: If no exact anchor matched, match the first item sharing the base file
        if (!matched) {
            const hrefBase = href.split('#')[0]
            if (hrefBase) {
                matched = items.find(el => (el.dataset.href || '').split('#')[0] === hrefBase)
            }
        }

        // 3. Mark ONLY the single matched item as active, remove active from all others
        items.forEach(el => {
            el.classList.toggle('active', el === matched)
        })

        if (matched) {
            matched.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
    }

    async loadNotesList() {
        if (!this.app.currentBookId) {
            if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'none'
            if (this.dom.notesContainer) {
                this.dom.notesContainer.innerHTML = `
                    <div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem 1rem; text-align: center; line-height: 1.6;">
                        <div class="ui-empty-icon">${uiSymbol('note')}</div>
                        <div style="font-weight: 600; color: var(--text-main); margin-bottom: 0.3rem;">${escapeHTML(t('annotations.notes.noBookTitle'))}</div>
                        <div style="font-size: 0.78rem;">${escapeHTML(t('annotations.notes.noBookDesc'))}</div>
                    </div>
                `
            }
            return
        }
        const activeSession = this.app._activeSession
        const snapshot = this.app._currentSnapshot
        const bookId = this.app.currentBookId
        const allNotes = await db.getHighlightsByBook(bookId)
        if (activeSession && !activeSession.isCurrent()) return
        const container = this.dom.notesContainer
        container.innerHTML = ''

        const notes = [...allNotes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

        if (notes.length === 0) {
            if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'none'
            container.innerHTML = `
                <div style="color: var(--text-muted); font-size: 0.85rem; padding: 2rem 1rem; text-align: center; line-height: 1.6;">
                    <div class="ui-empty-icon">${uiSymbol('note')}</div>
                    <div style="font-weight: 600; color: var(--text-main); margin-bottom: 0.3rem;">${escapeHTML(t('annotations.notes.emptyTitle'))}</div>
                    <div style="font-size: 0.78rem;">${escapeHTML(t('annotations.notes.emptyBookDesc'))}</div>
                </div>
            `
            return
        }

        if (this.dom.btnExportNotes) this.dom.btnExportNotes.style.display = 'inline-flex'

        notes.forEach(note => {
            const match = snapshot ? db.isContentIdentityMatching(note, snapshot) : { matches: true }
            const isUnconfirmed = !match.matches

            const card = document.createElement('div')
            card.className = 'highlight-card'
            card.style.borderLeftColor = mapHighlightDisplayColor(note.color || '#facc15')

            card.innerHTML = `
                <div class="highlight-text">“${escapeHTML(note.text)}”</div>
                ${note.note ? `<div class="highlight-note">${escapeHTML(note.note)}</div>` : ''}
                <div class="highlight-meta">
                    <span class="highlight-meta-info">${escapeHTML(note.chapterTitle || t('annotations.bodyFallback'))} • ${new Date(note.createdAt).toLocaleDateString(getLocale())}</span>
                    <div class="highlight-meta-actions">
                        <button class="btn-note-share" title="${escapeHTML(t('annotations.notes.shareTitle'))}">${escapeHTML(t('annotations.notes.shareBtn'))}</button>
                        <button class="btn-note-del" title="${escapeHTML(t('annotations.notes.deleteTitle'))}">${escapeHTML(t('common.delete'))}</button>
                    </div>
                </div>
            `

            card.addEventListener('click', e => {
                if (e.target.classList.contains('btn-note-del') || e.target.classList.contains('btn-note-share')) return
                if (isUnconfirmed) {
                    this.app.dialogs.showToast(t('annotations.notes.versionMismatch'), 'warning')
                    return
                }
                if (this.app.pdfViewport && (note.formatType === 'pdf' || note.pdfTarget)) {
                    const target = note.pdfTarget || {}
                    const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                    const page = firstSegment?.page ?? target.page ?? 0
                    const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                    const firstRect = rects?.[0]
                    const yRatio = firstRect ? firstRect[1] : 0
                    this.app.pdfViewport.goToPage(page, yRatio)
                    this.app.pdfViewport.pulseHighlight(page, note.id, rects)
                    this.closeDrawer()
                } else if (note.cfi && this.app.foliateView) {
                    this.app.foliateView.goTo(note.cfi)
                    this.closeDrawer()
                }
            })

            card.querySelector('.btn-note-share')?.addEventListener('click', async e => {
                e.stopPropagation()
                let bookMeta = null
                if (note.bookId) {
                    try {
                        bookMeta = await db.getBook(note.bookId)
                    } catch (_) {}
                }
                const isCurrentBook = this.app.currentBookId && note.bookId && String(this.app.currentBookId) === String(note.bookId)
                const format = note.formatType || bookMeta?.format || (isCurrentBook ? this.app.currentBookData?.format : null) || 'epub'
                const sourceToc = isCurrentBook ? (this.app.currentPdfTOC || this.app.toc || this.app._activeSession?.toc || []) : []
                const resolved = resolveExcerptSource({
                    highlight: note,
                    chapterTitle: note.chapterTitle,
                    currentLocation: isCurrentBook ? this.app.currentLocation : null,
                    reader: isCurrentBook ? (this.app.foliateView || this.app.pdfViewport) : null,
                    format,
                    pdfViewport: isCurrentBook ? this.app.pdfViewport : null
                }, sourceToc)

                const customBook = {
                    bookId: note.bookId,
                    bookTitle: note.bookTitle || bookMeta?.title || (isCurrentBook ? this.app.currentBookData?.title : '') || t('book.untitled'),
                    author: note.bookAuthor || bookMeta?.author || (isCurrentBook ? this.app.currentBookData?.author : '') || t('book.unknownAuthor'),
                    format
                }
                this.app.cards.openQuoteCardModal(note.text, resolved.chapterTitle, resolved.locationInfo, customBook)
            })

            card.querySelector('.btn-note-del')?.addEventListener('click', async e => {
                e.stopPropagation()
                await db.deleteHighlight(note.id)
                if (activeSession && !activeSession.isCurrent()) return
                if (this.app.pdfViewport) {
                    const allHls = await db.getHighlightsByBook(bookId)
                    if (activeSession && !activeSession.isCurrent()) return
                    this.app.pdfViewport.setHighlights(allHls, snapshot)
                }
                if (this.app.foliateView && note.cfi) {
                    await this.app.foliateView.deleteAnnotation({ value: note.cfi, id: note.id })
                }
                this.loadNotesList()
            })

            container.appendChild(card)
        })
    }

    async exportNotesToMarkdown() {
        const bookId = this.app.currentBookId || this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId
        if (!bookId) {
            return this.app.dialogs.showToast(t('annotations.export.openBookFirst'), 'info')
        }

        let bookData = this.app.currentBookData || this.app.currentBook
        if (!bookData && db.getBook) {
            try {
                bookData = await db.getBook(bookId)
            } catch (_) {}
        }
        const bookTitle = bookData?.title || t('annotations.export.defaultTitle')
        const bookAuthor = bookData?.author || t('book.unknownAuthor')

        const notes = await db.getHighlightsByBook(bookId)
        if (!notes || notes.length === 0) {
            return this.app.dialogs.showToast(t('annotations.export.empty'), 'info')
        }

        const locale = getLocale()
        let md = t('annotations.export.mdTitle', { title: bookTitle })
        md += t('annotations.export.mdAuthor', { author: bookAuthor })
        md += t('annotations.export.mdTime', { time: new Date().toLocaleString(locale) })
        md += t('annotations.export.mdCount', { count: notes.length })

        notes.forEach((n, idx) => {
            const chap = n.chapterTitle && n.chapterTitle !== 'undefined' ? n.chapterTitle : t('annotations.export.excerptFallback')
            md += `### ${idx + 1}. ${chap}\n\n`
            const quoteText = (n.text || '').split('\n').map(l => `> ${l}`).join('\n')
            md += `${quoteText}\n\n`
            if (n.note) md += t('annotations.export.mdNote', { note: n.note })
            md += t('annotations.export.mdItemTime', { time: new Date(n.createdAt).toLocaleString(locale) })
        })

        const safeTitle = bookTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || t('annotations.export.safeNameFallback')
        const filename = t('annotations.export.bookFilename', { title: safeTitle })
        const res = await platformBridge.exportTextFile(filename, md, 'text/markdown;charset=utf-8')
        if (res?.cancelled) {
            return
        }
        if (res.success) {
            if (res.filePath) {
                this.app.dialogs.showToast(t('annotations.export.savedPath', { path: res.filePath }), 'success', 4500)
            } else {
                this.app.dialogs.showToast(t('annotations.export.savedHint', { hint: res.directoryHint, filename: res.filename }), 'success', 4500)
            }
        } else {
            this.app.dialogs.showToast(t('annotations.export.failed', { error: res.error || t('annotations.unknownError') }), 'warning')
        }
    }

    async updateSidebarNotesCount(count = null) {
        try {
            if (count == null) {
                const hls = await db.getAllHighlights()
                count = hls ? hls.length : 0
            }
            const badge = document.getElementById('sidebar-notes-count')
            if (badge) {
                badge.innerText = `${count}`
                badge.style.display = count > 0 ? 'inline-block' : 'none'
            }
        } catch (_) {}
    }

    async renderShelfNotesView() {
        const view = document.getElementById('shelf-notes-view')
        if (!view) return

        if (!this.shelfNotesFilter) {
            this.shelfNotesFilter = {
                bookId: 'all',
                color: 'all',
                query: ''
            }
        }

        if (!this._shelfNotesInitialized) {
            this._shelfNotesInitialized = true

            const bookSelect = document.getElementById('select-notes-book-filter')
            bookSelect?.addEventListener('change', (e) => {
                this.shelfNotesFilter.bookId = e.target.value
                this.renderShelfNotesList()
            })

            const bookTrigger = document.getElementById('btn-notes-book-trigger')
            const bookPopover = document.getElementById('notes-book-popover')
            const closeBookPopover = () => {
                if (bookPopover) bookPopover.style.display = 'none'
                bookTrigger?.setAttribute('aria-expanded', 'false')
                bookTrigger?.closest?.('.shelf-notes-book-dropdown')?.classList?.remove('open')
            }
            bookTrigger?.addEventListener('click', (e) => {
                e.stopPropagation()
                if (!bookPopover) return
                const opening = bookPopover.style.display === 'none' || !bookPopover.style.display
                bookPopover.style.display = opening ? 'block' : 'none'
                bookTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false')
                bookTrigger.closest?.('.shelf-notes-book-dropdown')?.classList?.toggle('open', opening)
            })
            bookPopover?.addEventListener('click', (e) => {
                const opt = e.target.closest('[data-book-id]')
                if (!opt) return
                e.stopPropagation()
                const nextBookId = opt.dataset.bookId || 'all'
                this.shelfNotesFilter.bookId = nextBookId
                if (bookSelect) bookSelect.value = nextBookId
                closeBookPopover()
                this.renderShelfNotesList()
            })
            this.events.on(document, 'click', (e) => {
                if (!e.target?.closest?.('#shelf-notes-book-dropdown')) {
                    closeBookPopover()
                }
            })
            this.events.on(document, 'keydown', (e) => {
                if (e.key === 'Escape') closeBookPopover()
            })

            const searchInput = document.getElementById('input-shelf-notes-search')
            const clearBtn = document.getElementById('btn-clear-shelf-notes-search')

            let searchDebounceTimer = null
            searchInput?.addEventListener('input', (e) => {
                clearTimeout(searchDebounceTimer)
                const val = e.target.value.trim()
                if (clearBtn) clearBtn.style.display = val ? 'block' : 'none'
                searchDebounceTimer = setTimeout(() => {
                    this.shelfNotesFilter.query = val
                    this.renderShelfNotesList()
                }, 200)
            })

            clearBtn?.addEventListener('click', () => {
                if (searchInput) searchInput.value = ''
                clearBtn.style.display = 'none'
                this.shelfNotesFilter.query = ''
                this.renderShelfNotesList()
            })

            const filterButtons = document.querySelectorAll('#shelf-notes-mode-tabs .notes-color-pill, #shelf-notes-color-filters .notes-color-pill')
            const syncFilterPillsUI = () => {
                const activeColor = this.shelfNotesFilter.color || 'all'
                const colorTray = document.getElementById('shelf-notes-color-filters')
                const isSpecificColor = activeColor !== 'all' && activeColor !== 'has-note'
                colorTray?.classList?.toggle('has-active-color', isSpecificColor)
                filterButtons.forEach(p => {
                    const c = p.dataset.color || 'all'
                    const isActive = c === activeColor || (c === 'all' && activeColor === 'all')
                    p.classList.toggle('active', isActive)
                    p.setAttribute('aria-pressed', isActive ? 'true' : 'false')
                })
            }
            filterButtons.forEach(pill => {
                pill.addEventListener('click', () => {
                    const nextVal = pill.dataset.color || 'all'
                    const isColorDot = pill.classList.contains('color-dot-pill')
                    if (isColorDot && this.shelfNotesFilter.color === nextVal) {
                        this.shelfNotesFilter.color = 'all'
                    } else {
                        this.shelfNotesFilter.color = nextVal
                    }
                    syncFilterPillsUI()
                    this.renderShelfNotesList()
                })
            })
            syncFilterPillsUI()

            const exportBtn = document.getElementById('btn-export-shelf-notes')
            exportBtn?.addEventListener('click', () => {
                this.exportShelfNotesToMarkdown()
            })
        }

        await this.renderShelfNotesList()
    }

    async renderShelfNotesList() {
        const listContainer = document.getElementById('shelf-notes-list')
        const badge = document.getElementById('shelf-notes-stats-badge')
        const bookSelect = document.getElementById('select-notes-book-filter')
        if (!listContainer) return

        let allHighlights = []
        let allBooks = []
        try {
            allHighlights = (await db.getAllHighlights()) || []
            allBooks = (await db.getAllBooks()) || []
        } catch (err) {
            console.warn('Failed to load highlights or books:', err)
        }

        this._shelfAllNotes = allHighlights
        this._shelfAllBooks = allBooks
        this.updateSidebarNotesCount(allHighlights.length)

        const bookMap = new Map(allBooks.map(b => [b.id, b]))
        this._shelfBookMap = bookMap

        // Update book select dropdown options
        if (bookSelect) {
            const countsByBook = Object.create(null)
            allHighlights.forEach(h => {
                if (h.bookId) countsByBook[h.bookId] = (countsByBook[h.bookId] || 0) + 1
            })

            const currentVal = this.shelfNotesFilter.bookId
            let optionsHtml = `<option value="all">${escapeHTML(t('annotations.allBooksCount', { count: allHighlights.length }))}</option>`
            const booksWithNotes = allBooks.filter(b => countsByBook[b.id] > 0)
            booksWithNotes.sort((a, b) => (countsByBook[b.id] || 0) - (countsByBook[a.id] || 0))
            booksWithNotes.forEach(b => {
                const count = countsByBook[b.id] || 0
                const selected = String(b.id) === String(currentVal) ? 'selected' : ''
                optionsHtml += `<option value="${escapeHTML(String(b.id))}" ${selected}>${escapeHTML(b.title)} (${count})</option>`
            })
            bookSelect.innerHTML = optionsHtml
            if (currentVal !== 'all' && !countsByBook[currentVal]) {
                this.shelfNotesFilter.bookId = 'all'
                bookSelect.value = 'all'
            } else {
                bookSelect.value = this.shelfNotesFilter.bookId
            }

            const triggerLabel = document.getElementById('notes-book-trigger-label')
            const bookPopover = document.getElementById('notes-book-popover')
            const activeBookId = String(this.shelfNotesFilter.bookId || 'all')
            if (triggerLabel) {
                const activeBook = activeBookId === 'all' ? null : booksWithNotes.find(b => String(b.id) === activeBookId)
                triggerLabel.textContent = activeBook ? activeBook.title : t('notes.filterAllBooks')
            }
            if (bookPopover) {
                let popHtml = `
                    <button type="button" class="overview-tag-option ${activeBookId === 'all' ? 'active' : ''}" data-book-id="all" role="option" aria-selected="${activeBookId === 'all'}">
                        <span class="tag-opt-name">${escapeHTML(t('notes.filterAllBooks'))}</span>
                        <span class="tag-opt-count">${allHighlights.length}</span>
                    </button>
                `
                booksWithNotes.forEach(b => {
                    const count = countsByBook[b.id] || 0
                    const isSel = String(b.id) === activeBookId
                    popHtml += `
                        <button type="button" class="overview-tag-option ${isSel ? 'active' : ''}" data-book-id="${escapeHTML(String(b.id))}" role="option" aria-selected="${isSel}">
                            <span class="tag-opt-name">${escapeHTML(b.title)}</span>
                            <span class="tag-opt-count">${count}</span>
                        </button>
                    `
                })
                bookPopover.innerHTML = popHtml
            }
        }

        // Apply filters
        const q = (this.shelfNotesFilter.query || '').toLowerCase()
        const selectedBookId = this.shelfNotesFilter.bookId
        const selectedColor = this.shelfNotesFilter.color

        const filtered = allHighlights.filter(hl => {
            if (selectedBookId !== 'all' && String(hl.bookId) !== String(selectedBookId)) {
                return false
            }
            if (selectedColor === 'has-note') {
                if (!hl.note || !hl.note.trim()) return false
            } else if (selectedColor !== 'all') {
                if (hl.color !== selectedColor) return false
            }
            if (q) {
                const book = bookMap.get(hl.bookId)
                const bookTitle = (book?.title || hl.bookTitle || '').toLowerCase()
                const chapter = (hl.chapterTitle || '').toLowerCase()
                const text = (hl.text || '').toLowerCase()
                const note = (hl.note || '').toLowerCase()
                if (!text.includes(q) && !note.includes(q) && !chapter.includes(q) && !bookTitle.includes(q)) {
                    return false
                }
            }
            return true
        })

        // Sort: newest first
        filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        this._shelfFilteredNotes = filtered

        if (badge) {
            badge.innerText = t('annotations.badgeTotal', { count: filtered.length }) + (filtered.length !== allHighlights.length ? t('annotations.badgeFilteredSuffix', { total: allHighlights.length }) : '')
        }

        if (filtered.length === 0) {
            listContainer.innerHTML = `
                <div class="shelf-notes-empty-state">
                    <svg class="icon icon-xl" viewBox="0 0 24 24" style="color: var(--text-muted); opacity: 0.5;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    <div class="empty-title">${escapeHTML(allHighlights.length === 0 ? t('annotations.notes.emptyTitle') : t('annotations.noMatchingNotes'))}</div>
                    <div class="empty-desc">${escapeHTML(allHighlights.length === 0 ? t('annotations.emptyShelfNotesDesc') : t('annotations.filterNotesDesc'))}</div>
                </div>
            `
            return
        }

        listContainer.innerHTML = ''
        const frag = document.createDocumentFragment()

        filtered.forEach(note => {
            const book = bookMap.get(note.bookId)
            const bookTitle = book?.title || note.bookTitle || t('annotations.unknownBook')
            const chapterTitle = note.chapterTitle && note.chapterTitle !== 'undefined' ? note.chapterTitle : t('annotations.bodyFallback')
            const dateStr = note.createdAt ? new Date(note.createdAt).toLocaleDateString(getLocale()) : ''
            const rawColor = note.color || '#facc15'
            const displayColor = mapHighlightDisplayColor(rawColor)

            const card = document.createElement('div')
            card.className = 'shelf-note-card'
            card.setAttribute('role', 'button')
            card.setAttribute('tabindex', '0')
            card.setAttribute('aria-label', `${bookTitle} · ${chapterTitle}`)
            if (typeof card.style?.setProperty === 'function') {
                card.style.setProperty('--note-hl-color', displayColor)
            } else if (card.style) {
                card.style['--note-hl-color'] = displayColor
            }
            const metaLine = [bookTitle, chapterTitle, dateStr].filter(Boolean).join(' · ')

            card.innerHTML = `
                <div class="shelf-note-meta-col">
                    <div class="shelf-note-book-title">${escapeHTML(bookTitle)}</div>
                    <div class="shelf-note-chapter" title="${escapeHTML(chapterTitle)}">${escapeHTML(chapterTitle)}</div>
                    ${dateStr ? `<div class="shelf-note-date">${escapeHTML(dateStr)}</div>` : ''}
                </div>
                <div class="shelf-note-content-col">
                    <div class="shelf-note-annotated-block" style="border-left-color: ${escapeHTML(displayColor)};" title="${escapeHTML(t('annotations.jumpTitle'))}">
                        ${note.text ? `<div class="shelf-note-card-quote">“${escapeHTML(note.text)}”</div>` : ''}
                        ${note.note ? `
                            <div class="shelf-note-card-thought">
                                <span class="thought-label">${escapeHTML(t('annotations.thoughtBadge'))}</span>
                                <div class="thought-body">${escapeHTML(note.note)}</div>
                            </div>
                        ` : ''}
                    </div>
                    <span class="shelf-note-card-meta-line">${escapeHTML(metaLine)}</span>
                </div>
                <div class="shelf-note-actions-col">
                    <button type="button" class="btn-note-item-act act-copy" title="${escapeHTML(t('annotations.copyTitle'))}" aria-label="${escapeHTML(t('annotations.copyTitle'))}">
                        <svg class="icon icon-xs" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button type="button" class="btn-note-item-act act-share" title="${escapeHTML(t('annotations.shareCardTitle'))}" aria-label="${escapeHTML(t('annotations.shareCardTitle'))}">
                        <svg class="icon icon-xs" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="13" y2="13"/></svg>
                    </button>
                    <button type="button" class="btn-note-item-act act-delete" title="${escapeHTML(t('annotations.deleteNoteTitle'))}" aria-label="${escapeHTML(t('annotations.deleteNoteTitle'))}">
                        <svg class="icon icon-xs" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            `

            const jumpHandler = async () => {
                if (!note.bookId) return this.app.dialogs.showToast(t('annotations.missingBookLink'), 'warning')
                const target = note.pdfTarget || {}
                const firstSegment = Array.isArray(target.segments) ? target.segments[0] : null
                const page = firstSegment?.page ?? target.page ?? 0
                const rects = firstSegment?.rects?.length ? firstSegment.rects : target.rects
                const firstRect = rects?.[0]
                const yRatio = firstRect ? firstRect[1] : 0
                const loc = note.cfi
                    ? { cfi: note.cfi }
                    : ((note.pdfTarget || note.formatType === 'pdf')
                        ? { page: page + 1, yRatio, highlightId: note.id, rects }
                        : null)

                if (this.app.currentBookId && String(this.app.currentBookId) === String(note.bookId)) {
                    this.app.navHistory?.pushLocation()
                    if (this.app.dom.readerView) {
                        this.app.dom.readerView.style.display = 'block'
                        this.app.dom.readerView.classList.add('active')
                    }
                    if (this.app.dom.bookshelfView) this.app.dom.bookshelfView.style.display = 'none'
                    if (this.app.pdfViewport && (note.pdfTarget || note.formatType === 'pdf')) {
                        this.app.pdfViewport.goToPage(page, yRatio)
                        this.app.pdfViewport.pulseHighlight?.(page, note.id, rects)
                    } else if (note.cfi && this.app.foliateView) {
                        this.app.foliateView.goTo(note.cfi)
                    }
                } else {
                    await this.app.openBook(note.bookId, loc)
                }
            }

            card.addEventListener('click', (e) => {
                if (e.target.closest('.btn-note-item-act')) return
                jumpHandler()
            })

            card.addEventListener('keydown', (e) => {
                if (e.target !== card) return
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    jumpHandler()
                }
            })

            card.querySelector('.act-copy')?.addEventListener('click', async (e) => {
                e.stopPropagation()
                let copyText = note.text ? `“${note.text}”` : ''
                if (note.note) {
                    copyText += (copyText ? `\n\n${t('annotations.copyThoughtPrefix', { note: note.note })}` : note.note)
                }
                copyText += t('annotations.copyAttribution', { title: bookTitle, chapter: chapterTitle })
                try {
                    await navigator.clipboard.writeText(copyText)
                    this.app.dialogs.showToast(t('annotations.copiedToast'), 'success')
                } catch (_) {
                    this.app.dialogs.showToast(t('annotations.copyFailedToast'), 'warning')
                }
            })

            card.querySelector('.act-share')?.addEventListener('click', (e) => {
                e.stopPropagation()
                const format = note.formatType || book?.format || 'epub'
                const customBook = {
                    bookId: note.bookId,
                    bookTitle: bookTitle,
                    author: note.bookAuthor || book?.author || t('book.unknownAuthor'),
                    format
                }
                this.app.cards.openQuoteCardModal(note.text, chapterTitle, null, customBook)
            })

            card.querySelector('.act-delete')?.addEventListener('click', async (e) => {
                e.stopPropagation()
                if (confirm(t('annotations.confirmDelete'))) {
                    await db.deleteHighlight(note.id)
                    this.app.dialogs.showToast(t('annotations.deletedToast'), 'delete')
                    await this.renderShelfNotesList()
                }
            })

            frag.appendChild(card)
        })

        listContainer.appendChild(frag)
    }

    async exportShelfNotesToMarkdown() {
        const notesToExport = this._shelfFilteredNotes || this._shelfAllNotes || []
        const bookMap = this._shelfBookMap || new Map()

        if (!notesToExport || notesToExport.length === 0) {
            return this.app.dialogs.showToast(t('annotations.exportAll.empty'), 'info')
        }

        let md = t('annotations.exportAll.mdTitle')
        md += t('annotations.export.mdTime', { time: new Date().toLocaleString(getLocale()) })
        md += t('annotations.exportAll.mdCount', { count: notesToExport.length })

        const grouped = new Map()
        for (const n of notesToExport) {
            const b = bookMap.get(n.bookId)
            const bTitle = b?.title || n.bookTitle || t('annotations.unknownBook')
            if (!grouped.has(bTitle)) grouped.set(bTitle, [])
            grouped.get(bTitle).push(n)
        }

        for (const [title, bookNotes] of grouped.entries()) {
            md += `## ${title}\n\n`
            bookNotes.forEach((n, idx) => {
                const chap = n.chapterTitle && n.chapterTitle !== 'undefined' ? n.chapterTitle : t('annotations.bodyFallback')
                md += `### ${idx + 1}. ${chap}\n\n`
                if (n.text) {
                    const quoteText = n.text.split('\n').map(l => `> ${l}`).join('\n')
                    md += `${quoteText}\n\n`
                }
                if (n.note) {
                    md += t('annotations.exportAll.mdThought', { note: n.note })
                }
                const dateStr = n.createdAt ? new Date(n.createdAt).toLocaleString(getLocale()) : ''
                if (dateStr && dateStr !== 'Invalid Date') {
                    md += t('annotations.export.mdItemTime', { time: dateStr })
                }
            })
            md += `---\n\n`
        }

        const filename = t('annotations.exportAll.filename', { date: new Date().toISOString().slice(0, 10) })
        const res = await platformBridge.exportTextFile(filename, md, 'text/markdown;charset=utf-8')
        if (res?.cancelled) {
            return
        }
        if (res.success) {
            if (res.filePath) {
                this.app.dialogs.showToast(t('annotations.export.savedPath', { path: res.filePath }), 'success', 4500)
            } else {
                this.app.dialogs.showToast(t('annotations.exportAll.savedHint', { hint: res.directoryHint, filename: res.filename }), 'success', 4500)
            }
        } else {
            this.app.dialogs.showToast(t('annotations.export.failed', { error: res.error || t('annotations.unknownError') }), 'warning')
        }
    }

    async redrawAllAnnotations() {
        return this.reloadAnnotations()
    }

    async reloadAnnotations() {
        const bookId = this.app.currentBookId, epoch = this.app._currentBookEpoch
        const viewport = this.app.pdfViewport, view = this.app.foliateView, snapshot = this.app._currentSnapshot
        if (!bookId || (!viewport && !view)) return
        const isCurrent = () => this.app.currentBookId === bookId && this.app._currentBookEpoch === epoch &&
            this.app.pdfViewport === viewport && this.app.foliateView === view
        try {
            const highlights = await db.getHighlightsByBook(bookId)
            if (!isCurrent()) return
            if (viewport) {
                viewport.setHighlights(highlights, snapshot)
                return
            }
            for (const content of view.renderer?.getContents?.() || []) {
                if (content.overlayer?.clear) content.overlayer.clear()
                else content.overlayer?.element?.replaceChildren()
            }
            for (const hl of highlights) {
                if (!isCurrent()) return
                try {
                    await view.addAnnotation({ value: `${hl.cfi}::${hl.style || 'highlight'}`, id: hl.id, color: hl.color, style: hl.style || 'highlight' })
                } catch (error) { console.warn('Failed to reload annotation:', hl.id, error) }
            }
        } catch (error) {
            if (isCurrent()) console.warn('Failed to reload annotations:', error)
        }
    }
}
