/**
 * ai-sidebar-controller.js - Right AI Reading Sidebar, Context & History Controller
 * AI reading assistant sidebar and conversation history.
 */

import {
    createReferenceSnapshot,
    estimateTokenCount,
    buildSurroundingContext,
    buildChatPayloadMessages
} from './ai-context.js'

import {
    getAiPresets,
    getEnabledPresets,
    setPresetEnabled,
    replaceEnabledPreset,
    createCustomPreset,
    updatePreset,
    deletePreset,
    resetBuiltinPreset,
    MAX_ENABLED_PRESETS
} from './ai-presets.js'

import {
    isAiReady,
    getAiConfig,
    requestAiCompletion,
    abortAiRequest,
    getAiStatus,
    getAiAuditLog,
    clearAiAuditLog,
    renderSafeMarkdown,
    escapeUntrustedHtml
} from './reading-ai-assistant.js'

import {
    saveAiConversation,
    getAiConversation,
    getAiConversationsByBook,
    getAllAiConversations,
    deleteAiConversation,
    saveAiMessage,
    getAiMessages,
    clearAllAiHistory
} from './db.js'

export class AiSidebarController {
    constructor(app) {
        this.app = app
        this.isOpen = false
        this._layoutGeneration = 0
        this.currentConversation = null
        this.currentReference = null
        this.currentContext = null
        this.activeRequestId = null
        this.isGenerating = false
        this.cooldownTimer = null
        this.remainingCooldown = 0
        this.resizing = false
        this.currentWidth = 380

        this.dom = {}
        this.cacheElements()
        this.bindEvents()
    }

    cacheElements() {
        this.dom = {
            readerView: document.getElementById('reader-view'),
            readerContentArea: document.getElementById('reader-content-area'),
            readerAiSidebar: document.getElementById('reader-ai-sidebar'),
            aiSidebarResizer: document.getElementById('ai-sidebar-resizer'),
            btnToggleAiSidebar: document.getElementById('btn-toggle-ai-sidebar'),
            aiSidebarConvTitle: document.getElementById('ai-sidebar-conv-title'),
            btnAiNewConv: document.getElementById('btn-ai-new-conv'),
            btnAiViewHistory: document.getElementById('btn-ai-view-history'),
            btnAiCollapseSidebar: document.getElementById('btn-ai-collapse-sidebar'),
            aiChatMessages: document.getElementById('ai-chat-messages'),

            // Pending quote reference
            aiPendingRefBox: document.getElementById('ai-pending-reference-box'),
            aiPendingRefChapter: document.getElementById('ai-pending-ref-chapter'),
            aiPendingRefText: document.getElementById('ai-pending-ref-text'),
            btnAiExpandRef: document.getElementById('btn-ai-expand-ref'),
            btnAiRemoveRef: document.getElementById('btn-ai-remove-ref'),

            // Context toggle & preview
            aiChkIncludeContext: document.getElementById('ai-chk-include-context'),
            aiContextTokenPill: document.getElementById('ai-context-token-pill'),
            btnAiPreviewContext: document.getElementById('btn-ai-preview-context'),
            aiContextPreviewDrawer: document.getElementById('ai-context-preview-drawer'),
            aiContextPreviewContent: document.getElementById('ai-context-preview-content'),

            // Quick Presets
            aiQuickPresetsContainer: document.getElementById('ai-quick-presets-container'),
            btnAiManagePresets: document.getElementById('btn-ai-manage-presets'),

            // Input & Control
            aiChatInput: document.getElementById('ai-chat-input'),
            aiCooldownIndicator: document.getElementById('ai-cooldown-indicator'),
            aiStatusSummary: document.getElementById('ai-status-summary'),
            btnAiStopGeneration: document.getElementById('btn-ai-stop-generation'),
            btnAiSendMessage: document.getElementById('btn-ai-send-message'),

            // Left nav & Modals
            navCatAiHistory: document.getElementById('nav-cat-ai-history'),
            modalAiPresets: document.getElementById('modal-ai-presets'),
            btnCloseAiPresets: document.getElementById('btn-close-ai-presets'),
            btnSaveAiPresetsClose: document.getElementById('btn-save-ai-presets-close'),
            aiPresetsList: document.getElementById('ai-presets-list'),
            aiPresetsQuotaBadge: document.getElementById('ai-presets-quota-badge'),
            inputNewPresetName: document.getElementById('input-new-preset-name'),
            inputNewPresetPrompt: document.getElementById('input-new-preset-prompt'),
            btnAddNewPreset: document.getElementById('btn-add-new-preset'),

            // Replace preset modal
            modalAiReplacePreset: document.getElementById('modal-ai-replace-preset'),
            btnCloseReplacePreset: document.getElementById('btn-close-replace-preset'),
            btnCancelReplacePreset: document.getElementById('btn-cancel-replace-preset'),
            aiReplaceOptionsList: document.getElementById('ai-replace-options-list'),

            // History modal
            modalAiHistory: document.getElementById('modal-ai-history'),
            btnCloseAiHistory: document.getElementById('btn-close-ai-history'),
            inputAiHistorySearch: document.getElementById('input-ai-history-search'),
            aiHistoryConversationsList: document.getElementById('ai-history-conversations-list'),
            aiHistoryActiveTitle: document.getElementById('ai-history-active-title'),
            aiHistoryActiveMeta: document.getElementById('ai-history-active-meta'),
            aiHistoryMessagesView: document.getElementById('ai-history-messages-view'),
            btnHistoryJumpBook: document.getElementById('btn-history-jump-book'),
            btnHistoryExportMd: document.getElementById('btn-history-export-md'),
            btnHistoryDeleteConv: document.getElementById('btn-history-delete-conv'),
            btnClearAllAiHistory: document.getElementById('btn-clear-all-ai-history'),

            // AI History Bookshelf Workspace View (First-Class Page)
            aiHistoryWorkspaceView: document.getElementById('ai-history-workspace-view'),
            inputAiHistoryPageSearch: document.getElementById('ai-history-page-search'),
            aiHistoryPageConvList: document.getElementById('ai-history-page-conv-list'),
            aiHistoryTotalCount: document.getElementById('ai-history-total-count'),
            btnClearAllAiHistoryPage: document.getElementById('btn-clear-all-ai-history-page'),
            aiHistoryPageTitle: document.getElementById('ai-history-page-title'),
            aiHistoryPageMeta: document.getElementById('ai-history-page-meta'),
            btnHistoryPageJumpBook: document.getElementById('btn-history-page-jump-book'),
            btnHistoryPageExportMd: document.getElementById('btn-history-page-export-md'),
            btnHistoryPageDeleteConv: document.getElementById('btn-history-page-delete-conv'),
            aiHistoryPageMessagesList: document.getElementById('ai-history-page-messages-list'),

            // Audit Log Modal
            modalAiAudit: document.getElementById('modal-ai-audit'),
            btnCloseAiAudit: document.getElementById('btn-close-ai-audit'),
            btnCloseAiAuditAction: document.getElementById('btn-close-ai-audit-action'),
            btnClearAiAudit: document.getElementById('btn-clear-ai-audit'),
            aiAuditLogTableContainer: document.getElementById('ai-audit-log-table-container')
        }
    }

    bindEvents() {
        // Toggle & Collapse
        this.dom.btnToggleAiSidebar?.addEventListener('click', () => this.toggleSidebar())
        this.dom.btnAiCollapseSidebar?.addEventListener('click', () => this.closeSidebar())

        // Resizer drag
        this.setupResizer()

        // New Conversation & History
        this.dom.btnAiNewConv?.addEventListener('click', () => this.startNewConversation())
        this.dom.btnAiViewHistory?.addEventListener('click', () => this.openHistoryModal())

        // Reference controls
        this.dom.btnAiExpandRef?.addEventListener('click', () => {
            const isExp = this.dom.aiPendingRefText.classList.toggle('expanded')
            this.dom.btnAiExpandRef.innerText = isExp ? '收起' : '展开'
        })
        this.dom.btnAiRemoveRef?.addEventListener('click', () => {
            this.clearPendingReference()
        })

        // Context preview drawer toggle
        this.dom.btnAiPreviewContext?.addEventListener('click', () => {
            const drawer = this.dom.aiContextPreviewDrawer
            if (drawer) {
                const isHidden = drawer.style.display === 'none'
                drawer.style.display = isHidden ? 'block' : 'none'
                this.dom.btnAiPreviewContext.innerText = isHidden ? '收起预览' : '预览'
            }
        })

        // Input & Keys
        this.dom.aiChatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                this.handleSendMessage()
            }
        })

        // Send & Stop (Distinct non-overlapping buttons to prevent double-click accidents!)
        this.dom.btnAiSendMessage?.addEventListener('click', () => this.handleSendMessage())
        this.dom.btnAiStopGeneration?.addEventListener('click', () => this.handleStopGeneration())

        // Manage Presets
        this.dom.btnAiManagePresets?.addEventListener('click', () => this.openPresetsModal())
        this.dom.btnCloseAiPresets?.addEventListener('click', () => this.closePresetsModal())
        this.dom.btnSaveAiPresetsClose?.addEventListener('click', () => this.closePresetsModal())
        this.dom.btnAddNewPreset?.addEventListener('click', () => this.handleCreateCustomPreset())

        // Replace preset modal
        this.dom.btnCloseReplacePreset?.addEventListener('click', () => this.closeReplacePresetModal())
        this.dom.btnCancelReplacePreset?.addEventListener('click', () => this.closeReplacePresetModal())

        // Left nav history button -> Switches bookshelf category to 'ai-history'
        this.dom.navCatAiHistory?.addEventListener('click', () => {
            if (this.app?.switchShelfCategory) {
                this.app.switchShelfCategory('ai-history')
            }
        })
        this.dom.btnCloseAiHistory?.addEventListener('click', () => this.closeHistoryModal())
        this.dom.btnClearAllAiHistory?.addEventListener('click', () => this.handleClearAllHistory(false))
        this.dom.inputAiHistorySearch?.addEventListener('input', () => this.filterHistoryList())

        // History modal actions
        this.dom.btnHistoryJumpBook?.addEventListener('click', () => this.handleHistoryJumpToBook())
        this.dom.btnHistoryExportMd?.addEventListener('click', () => this.handleHistoryExportMarkdown())
        this.dom.btnHistoryDeleteConv?.addEventListener('click', () => this.handleHistoryDeleteActive())

        // Bookshelf AI History Workspace Actions
        this.dom.inputAiHistoryPageSearch?.addEventListener('input', () => this.filterWorkspaceHistoryList())
        this.dom.btnClearAllAiHistoryPage?.addEventListener('click', () => this.handleClearAllHistory(true))
        this.dom.btnHistoryPageJumpBook?.addEventListener('click', () => this.handleHistoryJumpToBook(this._selectedWorkspaceConvId))
        this.dom.btnHistoryPageExportMd?.addEventListener('click', () => this.handleHistoryExportMarkdown(this._selectedWorkspaceConvId))
        this.dom.btnHistoryPageDeleteConv?.addEventListener('click', () => this.handleHistoryDeleteActive(this._selectedWorkspaceConvId, true))

        // Audit Log Modal
        this.dom.btnCloseAiAudit?.addEventListener('click', () => this.closeAuditModal())
        this.dom.btnCloseAiAuditAction?.addEventListener('click', () => this.closeAuditModal())
        this.dom.btnClearAiAudit?.addEventListener('click', () => this.handleClearAuditLog())

        // Render presets strip initially
        this.renderQuickPresets()

        // Prevent mouse wheel inside AI sidebar and AI modals from bubbling to window reader page flipper
        const stopWheelInside = (el) => {
            el?.addEventListener('wheel', (e) => {
                e.stopPropagation()
            }, { passive: true })
        }
        stopWheelInside(this.dom.readerAiSidebar)
        stopWheelInside(this.dom.aiHistoryPageConvList)
        stopWheelInside(this.dom.aiHistoryPageMessagesList)
        stopWheelInside(this.dom.aiChatMessages)
        stopWheelInside(this.dom.modalAiPresets)
        stopWheelInside(this.dom.modalAiHistory)
        stopWheelInside(this.dom.modalAiAudit)
        stopWheelInside(this.dom.aiContextPreviewDrawer)
    }

    setupResizer() {
        const resizer = this.dom.aiSidebarResizer
        if (!resizer) return

        let startX = 0
        let startWidth = 380

        const onMouseMove = (e) => {
            if (!this.resizing) return
            const deltaX = startX - e.clientX
            const nextWidth = Math.max(320, Math.min(640, startWidth + deltaX))
            this.currentWidth = nextWidth
            document.documentElement.style.setProperty('--ai-sidebar-width', `${nextWidth}px`)
        }

        let savedAnchor = null
        const onMouseUp = async () => {
            if (this.resizing) {
                this.resizing = false
                resizer.classList.remove('resizing')
                document.body.style.cursor = ''
                window.removeEventListener('mousemove', onMouseMove)
                window.removeEventListener('mouseup', onMouseUp)
                await this.relayoutReader(savedAnchor)
            }
        }

        resizer.addEventListener('mousedown', (e) => {
            savedAnchor = this.captureCurrentReadingAnchor()
            this.resizing = true
            startX = e.clientX
            startWidth = this.currentWidth
            resizer.classList.add('resizing')
            document.body.style.cursor = 'col-resize'
            window.addEventListener('mousemove', onMouseMove)
            window.addEventListener('mouseup', onMouseUp)
        })
    }

    // =========================================================================
    // Sidebar Visibility & Reader Layout
    // =========================================================================

    invalidatePendingLayout() {
        if (typeof this._layoutGeneration !== 'number' || isNaN(this._layoutGeneration)) {
            this._layoutGeneration = 0
        }
        this._layoutGeneration++
    }

    captureCurrentReadingAnchor() {
        try {
            const bookId = this.app?.currentBookData?.id || this.app?.currentBook?.id || null
            const view = this.app?.foliateView || null
            if (typeof this._layoutGeneration !== 'number' || isNaN(this._layoutGeneration)) {
                this._layoutGeneration = 0
            }
            const layoutGen = ++this._layoutGeneration
            if (this.app?.foliateView) {
                const fv = this.app.foliateView
                if (typeof fv.renderer?.settle === 'function') {
                    fv.renderer.settle()
                }
                const loc = fv.lastLocation
                if (loc?.cfi) {
                    return { bookId, view, layoutGen, cfi: loc.cfi, range: loc.range, index: loc.index }
                }
                if (loc?.range && loc?.index != null) {
                    const cfi = fv.getCFI?.(loc.index, loc.range)
                    return { bookId, view, layoutGen, cfi, range: loc.range, index: loc.index }
                }
            }
            if (this.app?.pdfViewport?.currentPageIndex != null) {
                return { bookId, view, layoutGen, pageIndex: this.app.pdfViewport.currentPageIndex }
            }
            if (this.app?.currentPdfPageIndex != null) {
                return { bookId, view, layoutGen, pageIndex: this.app.currentPdfPageIndex }
            }
        } catch (e) {
            console.warn('[AI Sidebar] Failed to capture reading anchor:', e)
        }
        return null
    }

    async restoreReadingAnchor(anchor) {
        if (!anchor) return
        try {
            // Guard against stale anchor across different books or replaced view instances
            const curBookId = this.app?.currentBookData?.id || this.app?.currentBook?.id || null
            if (anchor.bookId && curBookId && anchor.bookId !== curBookId) {
                console.warn('[AI Sidebar] Reading anchor book mismatch, aborting restore')
                return
            }
            if (anchor.view && this.app?.foliateView && anchor.view !== this.app.foliateView) {
                console.warn('[AI Sidebar] Reading anchor view instance mismatch, aborting restore')
                return
            }
            if (typeof anchor.layoutGen === 'number' && typeof this._layoutGeneration === 'number' && anchor.layoutGen !== this._layoutGeneration) {
                console.warn('[AI Sidebar] Stale layout generation, aborting restore')
                return
            }

            if (anchor.cfi && this.app?.foliateView?.goTo) {
                if (anchor.range) {
                    if (typeof this.app.foliateView.renderer?.setLockedAnchor === 'function') {
                        this.app.foliateView.renderer.setLockedAnchor(anchor.range)
                    } else if (typeof this.app.foliateView.renderer?.setAnchor === 'function') {
                        this.app.foliateView.renderer.setAnchor(anchor.range, true)
                    }
                }
                await this.app.foliateView.goTo(anchor.cfi)
                return
            }
            if (anchor.range && this.app?.foliateView?.renderer?.scrollToAnchor) {
                await this.app.foliateView.renderer.scrollToAnchor(anchor.range)
                return
            }
            if (anchor.pageIndex != null) {
                if (this.app?.pdfViewport?.goToPage) {
                    this.app.pdfViewport.goToPage(anchor.pageIndex)
                } else if (typeof this.app?.goToPdfPage === 'function') {
                    this.app.goToPdfPage(anchor.pageIndex)
                }
            }
        } catch (e) {
            console.warn('[AI Sidebar] Failed to restore reading anchor:', e)
        }
    }

    async openSidebar(preferredAnchor = null) {
        if (this.isOpen) return

        if (typeof this._layoutGeneration !== 'number' || isNaN(this._layoutGeneration)) {
            this._layoutGeneration = 0
        }

        // 1. Capture anchor BEFORE changing container width
        let anchor = preferredAnchor
        if (anchor) {
            anchor.layoutGen = ++this._layoutGeneration
            if (!anchor.bookId) anchor.bookId = this.app?.currentBookData?.id || this.app?.currentBook?.id || null
            if (!anchor.view) anchor.view = this.app?.foliateView || null
        } else {
            anchor = this.captureCurrentReadingAnchor()
        }

        this.isOpen = true

        if (this.dom.readerAiSidebar) this.dom.readerAiSidebar.style.display = 'flex'
        if (this.dom.aiSidebarResizer) this.dom.aiSidebarResizer.style.display = 'block'
        if (this.dom.readerView) this.dom.readerView.classList.add('ai-sidebar-open')
        if (this.dom.btnToggleAiSidebar) this.dom.btnToggleAiSidebar.classList.add('active')

        // Ensure we have an active conversation for the current book
        this.ensureActiveConversation()

        // Relayout reader restoring to the exact captured anchor
        await this.relayoutReader(anchor)

        // Check native status & cooldown
        this.syncCooldownStatus()
    }

    async closeSidebar() {
        if (!this.isOpen) return

        // 1. Capture anchor BEFORE restoring full width
        const anchor = this.captureCurrentReadingAnchor()

        this.isOpen = false

        if (this.dom.readerAiSidebar) this.dom.readerAiSidebar.style.display = 'none'
        if (this.dom.aiSidebarResizer) this.dom.aiSidebarResizer.style.display = 'none'
        if (this.dom.readerView) this.dom.readerView.classList.remove('ai-sidebar-open')
        if (this.dom.btnToggleAiSidebar) this.dom.btnToggleAiSidebar.classList.remove('active')

        // Relayout reader restoring to the exact captured anchor
        await this.relayoutReader(anchor)
    }

    async toggleSidebar() {
        if (this.isOpen) {
            await this.closeSidebar()
        } else {
            await this.openSidebar()
        }
    }

    async relayoutReader(anchor = null) {
        try {
            const capturedView = anchor?.view || this.app?.foliateView || null
            const capturedBookId = anchor?.bookId || this.app?.currentBookData?.id || this.app?.currentBook?.id || null
            // Give DOM a frame to compute new container dimensions
            await new Promise(r => requestAnimationFrame(r))
            if (capturedView && this.app?.foliateView && capturedView !== this.app.foliateView) {
                console.warn('[AI Sidebar] foliateView changed during relayout frame, aborting stale relayout')
                return
            }
            if (capturedBookId) {
                const currentBookId = this.app?.currentBookData?.id || this.app?.currentBook?.id || null
                if (currentBookId && capturedBookId !== currentBookId) {
                    console.warn('[AI Sidebar] Book changed during relayout frame, aborting stale relayout')
                    return
                }
            }
            if (anchor) {
                if (!anchor.view && capturedView) anchor.view = capturedView
                if (!anchor.bookId && capturedBookId) anchor.bookId = capturedBookId
                await this.restoreReadingAnchor(anchor)
                return
            }
            if (this.app?.foliateView?.renderer) {
                const renderer = this.app.foliateView.renderer
                if (typeof renderer.render === 'function') {
                    renderer.render()
                }
            }
            if (this.app?.currentBookData?.format === 'pdf' || this.app?.foliateView?.isFixedLayout) {
                if (typeof this.app.renderPdfDrawingOverlayForCurrentPage === 'function') {
                    this.app.renderPdfDrawingOverlayForCurrentPage()
                }
            }
            if (this.app?.rendition?.resize) {
                this.app.rendition.resize()
            }
            if (this.app?.pdfRenderer?.relayout) {
                this.app.pdfRenderer.relayout()
            }
        } catch (e) {
            console.warn('[AI Sidebar] Relayout warning:', e)
        }
    }

    // =========================================================================
    // Selection Reference & Context Pipeline
    // =========================================================================

    /**
     * Called when user clicks "AI" in selection bubble.
     * Takes stable snapshot BEFORE popup is closed or selection collapsed!
     */
    async openWithSelection(selectionInfo) {
        if (!selectionInfo || !selectionInfo.text) return

        // 1. Create stable, immutable reference snapshot
        const currentBook = this.app?.currentBookData || this.app?.currentBook
        const snapshot = createReferenceSnapshot(currentBook, selectionInfo)
        this.currentReference = snapshot

        // 2. Extract surrounding context within <= 1000 tokens hard budget
        this.currentContext = this.extractContextForSelection(selectionInfo)

        // 3. Resolve selection anchor explicitly from selectionInfo
        let anchor = null
        if (selectionInfo.cfi) {
            anchor = { cfi: selectionInfo.cfi, range: selectionInfo.range, index: selectionInfo.index }
        } else if (selectionInfo.range && this.app?.foliateView) {
            const index = selectionInfo.index ?? this.app.foliateView.lastLocation?.index ?? 0
            const cfi = this.app.foliateView.getCFI?.(index, selectionInfo.range)
            anchor = { cfi, range: selectionInfo.range, index }
        } else if (selectionInfo.pageIndex != null) {
            anchor = { pageIndex: selectionInfo.pageIndex }
        }

        // 4. Open sidebar with explicit selection anchor
        await this.openSidebar(anchor)

        // 5. Update pending quote box in sidebar
        this.renderPendingReference()

        // 6. Update context preview
        this.renderContextPreview()

        // 7. Focus input without erasing user draft
        if (this.dom.aiChatInput) {
            this.dom.aiChatInput.focus()
        }
    }

    extractContextForSelection(selectionInfo) {
        const rawBudget = this.app?.advancedSettings?.aiContextTokenBudget ?? this.app?.advancedSettings?.config?.aiContextTokenBudget
        const budget = Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.min(10000, Number(rawBudget))) : 1000

        if (budget === 0) {
            return { beforeText: '', afterText: '', contextText: '', tokenCount: 0 }
        }

        let beforeText = ''
        let afterText = ''

        try {
            // 1. Attempt extracting from Foliate iframe (EPUB/TXT/HTML)
            const iframe = this.app?.foliateView?.shadowRoot?.querySelector('iframe') || this.app?.foliateView?.querySelector('iframe')
            const doc = iframe?.contentDocument || this.app?.foliateView?.renderer?.getContents?.()?.[0]?.doc
            if (doc?.body) {
                let domRange = selectionInfo.range
                if ((!domRange || !domRange.startContainer) && selectionInfo.cfi && this.app?.foliateView && doc) {
                    try {
                        const resolved = this.app.foliateView.resolveCFI(selectionInfo.cfi)
                        if (resolved && typeof resolved.anchor === 'function') {
                            domRange = resolved.anchor(doc)
                        }
                    } catch (cfiErr) {
                        console.warn('[AI Sidebar] Failed to resolve CFI to Range:', cfiErr)
                    }
                }

                // If Range is available, extract precise DOM boundaries without indexOf collisions
                if (domRange && domRange.startContainer) {
                    try {
                        const preRange = doc.createRange()
                        preRange.selectNodeContents(doc.body)
                        preRange.setEnd(domRange.startContainer, domRange.startOffset)
                        beforeText = preRange.toString()

                        const postRange = doc.createRange()
                        postRange.selectNodeContents(doc.body)
                        postRange.setStart(domRange.endContainer, domRange.endOffset)
                        afterText = postRange.toString()
                    } catch (rErr) {
                        console.warn('[AI Sidebar] Range context extraction fallback:', rErr)
                    }
                }

                // Fallback if beforeText/afterText couldn't be extracted via Range
                if (!beforeText && !afterText) {
                    const text = doc.body.innerText || ''
                    const selText = (selectionInfo.text || '').trim()
                    if (selText) {
                        const pos = text.indexOf(selText)
                        if (pos >= 0) {
                            beforeText = text.slice(Math.max(0, pos - 2500), pos)
                            afterText = text.slice(pos + selText.length, pos + selText.length + 2500)
                        }
                    }
                }
            } else if (this.app?.pdfViewport || this.app?.pdfRenderer || document.querySelector('.pdf-page-slot') || document.querySelector('.pdf-page-container')) {
                // 2. Attempt extracting from PDF page container / slot
                const pIdx = selectionInfo.pageIndex != null ? selectionInfo.pageIndex : this.app?.currentPdfPageIndex
                const pageEl = (pIdx != null ? document.querySelector(`.pdf-page-slot[data-page-index="${pIdx}"], .pdf-page-container[data-page-index="${pIdx}"]`) : null)
                    || document.querySelector('.pdf-page-slot.active, .pdf-page-slot, .pdf-page-container')
                if (pageEl) {
                    const text = pageEl.innerText || ''
                    const selText = (selectionInfo.text || '').trim()
                    if (selText) {
                        const pos = text.indexOf(selText)
                        if (pos >= 0) {
                            beforeText = text.slice(Math.max(0, pos - 2500), pos)
                            afterText = text.slice(pos + selText.length, pos + selText.length + 2500)
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[AI Sidebar] Context extraction exception:', e)
        }

        return buildSurroundingContext({
            beforeText,
            afterText,
            maxTokens: budget,
            tokenizer: this.app?.advancedSettings?.config?.modelTokenizer || 'auto'
        })
    }

    renderPendingReference() {
        const box = this.dom.aiPendingRefBox
        if (!box) return

        if (!this.currentReference || !this.currentReference.selectedText) {
            box.style.display = 'none'
            return
        }

        box.style.display = 'block'
        if (this.dom.aiPendingRefChapter) {
            this.dom.aiPendingRefChapter.innerText = this.currentReference.chapterOrPage || ''
        }
        if (this.dom.aiPendingRefText) {
            this.dom.aiPendingRefText.innerText = this.currentReference.selectedText
            this.dom.aiPendingRefText.classList.remove('expanded')
        }
        if (this.dom.btnAiExpandRef) {
            this.dom.btnAiExpandRef.innerText = '展开'
        }
    }

    clearPendingReference() {
        this.currentReference = null
        this.currentContext = null
        this.renderPendingReference()
        this.renderContextPreview()
    }

    renderContextPreview() {
        const bar = this.dom.aiContextTokenPill
        const content = this.dom.aiContextPreviewContent
        if (!bar) return

        const rawBudget = this.app?.advancedSettings?.aiContextTokenBudget ?? this.app?.advancedSettings?.config?.aiContextTokenBudget
        const budget = Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.min(10000, Number(rawBudget))) : 1000
        const isChecked = this.dom.aiChkIncludeContext ? this.dom.aiChkIncludeContext.checked : true

        if (!isChecked) {
            bar.innerText = '用户已关闭'
        } else if (budget === 0) {
            bar.innerText = '预算为 0'
        } else if (!this.currentReference) {
            bar.innerText = '无选文引用'
        } else if (this.currentContext && this.currentContext.tokenCount > 0) {
            bar.innerText = `待发约 ${this.currentContext.tokenCount} token`
        } else {
            bar.innerText = '未取得正文'
        }

        if (content) {
            if (!isChecked) {
                content.innerText = '（已在上方复选框中取消附带附近正文）'
            } else if (budget === 0) {
                content.innerText = '（高级设置中附近正文上限设为 0，不附带额外正文）'
            } else if (!this.currentReference) {
                content.innerText = '（当前未选取引文字段）'
            } else {
                content.innerText = this.currentContext?.contextText || '（正文提取失败或当前章节无额外正文）'
            }
        }
    }

    // =========================================================================
    // Quick Presets Interaction
    // =========================================================================

    renderQuickPresets() {
        const container = this.dom.aiQuickPresetsContainer
        if (!container) return

        const enabled = getEnabledPresets()
        container.innerHTML = ''

        enabled.forEach(preset => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ai-preset-pill-btn'
            btn.innerText = preset.name
            btn.title = preset.prompt

            btn.addEventListener('click', () => {
                this.executePreset(preset)
            })

            container.appendChild(btn)
        })
    }

    executePreset(preset) {
        if (!preset) return

        if (this.isGenerating) {
            this.app?.showToast?.('当前已有正在生成的请求，请等待完成或点击停止', 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(`防误触保护：请等待 ${this.remainingCooldown} 秒后再发送新请求`, 'warning')
            return
        }

        if (preset.requiresReference && (!this.currentReference || !this.currentReference.selectedText)) {
            this.app?.showToast?.('请先在书籍中划词选取一段文字作为引用', 'warning')
            return
        }

        const draft = (this.dom.aiChatInput?.value || '').trim()
        this.dispatchAiTurn({
            promptText: preset.prompt,
            userSupplement: draft,
            presetId: preset.id,
            actionName: preset.name
        })

        // Clear input draft only after successful dispatch
        if (this.dom.aiChatInput) {
            this.dom.aiChatInput.value = ''
        }
    }

    // =========================================================================
    // Chat Dispatch & Generation Lifecycle
    // =========================================================================

    async handleSendMessage() {
        if (this.isGenerating) {
            this.app?.showToast?.('当前已有正在生成的请求，请等待完成或点击停止', 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(`防误触保护：请等待 ${this.remainingCooldown} 秒后再发送新请求`, 'warning')
            return
        }

        const text = (this.dom.aiChatInput?.value || '').trim()
        if (!text) return

        this.dispatchAiTurn({
            promptText: text,
            userSupplement: '',
            presetId: null,
            actionName: '问答'
        })

        if (this.dom.aiChatInput) {
            this.dom.aiChatInput.value = ''
        }
    }

    async dispatchAiTurn({ promptText, userSupplement, presetId, actionName }) {
        if (this.isGenerating) {
            this.app?.showToast?.('当前已有正在生成的请求，请等待完成或点击停止', 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(`防误触保护：请等待 ${this.remainingCooldown} 秒后再发送新请求`, 'warning')
            return
        }

        // Check if AI is configured
        const ready = await isAiReady()
        if (!ready) {
            this.app?.showToast?.('请先在「设置 - 排版与主题设置」中配置大模型 API Key', 'warning')
            return
        }

        // Record dispatch timestamp for accurate elapsed-based cooldown calculation
        this.dispatchedAt = Date.now()

        // 1. Ensure conversation exists
        await this.ensureActiveConversation()

        const refSnapshot = this.currentReference
        const rawBudget = this.app?.advancedSettings?.aiContextTokenBudget ?? this.app?.advancedSettings?.config?.aiContextTokenBudget
        const budget = Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.min(10000, Number(rawBudget))) : 1000
        const isChecked = this.dom.aiChkIncludeContext ? this.dom.aiChkIncludeContext.checked : true
        const ctxSnapshot = (isChecked && budget > 0 && this.currentContext) ? this.currentContext : null

        let ctxReason = ''
        if (!isChecked) {
            ctxReason = '用户关闭'
        } else if (budget === 0) {
            ctxReason = '预算为 0'
        } else if (!refSnapshot) {
            ctxReason = '无选文引用'
        } else if (this.currentContext && this.currentContext.tokenCount > 0) {
            ctxReason = `已附带约 ${this.currentContext.tokenCount} token`
        } else {
            ctxReason = '未取得正文'
        }

        console.log('[AI Context Debug]', {
            hasReference: Boolean(refSnapshot),
            anchorType: refSnapshot?.cfi ? 'cfi' : (refSnapshot?.pageIndex != null ? 'pdf-page' : 'text'),
            includeContext: Boolean(ctxSnapshot),
            contextLength: ctxSnapshot?.contextText?.length || 0,
            estimatedTokens: ctxSnapshot?.tokenCount || 0,
            budget,
            ctxReason
        })

        // Retrieve prior messages in this conversation for multi-turn chat context
        let priorMessages = []
        try {
            const allConvMsgs = await getAiMessages(this.currentConversation.id)
            if (Array.isArray(allConvMsgs)) {
                priorMessages = allConvMsgs
                    .filter(m => (m.status === 'completed' || (m.status === 'partial' && m.content?.trim())) && (m.role === 'user' || m.role === 'assistant'))
                    .map(m => ({
                        role: m.role,
                        content: m.content || ''
                    }))
            }
        } catch (e) {
            console.warn('[AI Sidebar] Failed to load prior conversation history:', e)
        }

        // 2. Build User Message Record
        const userMsg = {
            id: 'msg_user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            conversationId: this.currentConversation.id,
            role: 'user',
            content: userSupplement ? `${promptText}\n\n补充要求: ${userSupplement}` : promptText,
            actionName: actionName || '提问',
            referenceSnapshot: refSnapshot,
            contextSnapshot: ctxSnapshot,
            contextReason: ctxReason,
            presetId: presetId || null,
            createdAt: Date.now(),
            status: 'completed'
        }

        await saveAiMessage(userMsg)
        this.appendMessageToUI(userMsg)

        // Clear pending quote after it has been frozen into this message!
        this.clearPendingReference()

        // 3. Create Assistant Placeholder Record in DB & UI
        const assistantMsgId = 'msg_asst_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        const assistantMsg = {
            id: assistantMsgId,
            conversationId: this.currentConversation.id,
            role: 'assistant',
            content: '',
            referenceSnapshot: refSnapshot,
            createdAt: Date.now(),
            status: 'streaming',
            usage: null
        }

        await saveAiMessage(assistantMsg)
        const msgElement = this.appendMessageToUI(assistantMsg)

        // 4. Update UI State to Generating
        this.isGenerating = true
        this.activeRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        if (this.dom.btnAiStopGeneration) {
            this.dom.btnAiStopGeneration.disabled = false
            this.dom.btnAiStopGeneration.classList.add('active')
        }
        if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = true
        if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = '正在思考生成中...'

        // Build Payload
        const messages = buildChatPayloadMessages({
            promptText,
            systemPrompt: '',
            userSupplement,
            referenceSnapshot: refSnapshot,
            contextSnapshot: ctxSnapshot,
            includeContext: Boolean(ctxSnapshot),
            historyMessages: priorMessages
        })

        const contentDiv = msgElement?.querySelector('.ai-msg-content')
        const metaDiv = msgElement?.querySelector('.ai-msg-meta-bar')

        try {
            const configuredMaxTokens = this.app?.advancedSettings?.aiMaxTokens || this.app?.advancedSettings?.config?.aiMaxTokens || getAiConfig().maxTokens || 2048
            const response = await requestAiCompletion({
                requestId: this.activeRequestId,
                messages,
                maxTokens: configuredMaxTokens,
                returnMetadata: true,
                onChunk: (delta, fullText) => {
                    assistantMsg.content = fullText
                    if (contentDiv) {
                        contentDiv.innerHTML = renderSafeMarkdown(fullText)
                    }
                    this.scrollToBottom()
                }
            })
            const resultText = typeof response === 'string' ? response : (response?.fullText || '')
            const finishReason = typeof response === 'string' ? null : response?.finishReason

            // Finalize message on success
            const wasCutOff = finishReason === 'length' || finishReason === 'max_tokens'
            assistantMsg.content = resultText
            assistantMsg.status = response?.status === 'cancelled' ? 'cancelled' : (wasCutOff ? 'partial' : 'completed')
            assistantMsg.finishReason = finishReason || null
            assistantMsg.usage = response?.usage || null
            await saveAiMessage(assistantMsg)

            if (contentDiv) {
                contentDiv.innerHTML = renderSafeMarkdown(resultText)
            }
            if (metaDiv) {
                const usageLabel = assistantMsg.usage?.total_tokens ? ` · ${assistantMsg.usage.total_tokens} tokens` : ' · Token: 未知'
                const stateText = assistantMsg.status === 'cancelled' ? '已停止' : (wasCutOff ? '回答未完：达到模型输出上限' : '生成完成')
                const continueAction = wasCutOff ? '<button type="button" class="ai-msg-action-btn btn-msg-continue" title="先检查草稿，再手动发送继续请求">继续回答</button>' : ''
                const saveAction = assistantMsg.status === 'completed' ? '<button type="button" class="ai-msg-action-btn btn-msg-save-note" title="保存为划线批注">保存为笔记</button>' : ''
                metaDiv.innerHTML = `<span>${stateText}${usageLabel}</span><div class="ai-msg-actions"><button type="button" class="ai-msg-action-btn btn-msg-copy" title="复制回答">复制</button>${saveAction}${continueAction}</div>`
                this.bindMessageActionButtons(msgElement, assistantMsg)
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = wasCutOff ? '回答未完，可继续' : (assistantMsg.status === 'cancelled' ? '已停止' : '生成完成')
        } catch (err) {
            const errStr = err?.message || String(err)
            const hasPartialAnswer = Boolean(assistantMsg.content?.trim())
            assistantMsg.status = hasPartialAnswer ? 'partial' : 'failed'
            assistantMsg.errorMessage = errStr
            await saveAiMessage(assistantMsg)

            if (contentDiv) {
                contentDiv.innerHTML = hasPartialAnswer
                    ? `${renderSafeMarkdown(assistantMsg.content)}<p style="color: var(--text-muted); font-size: 0.78rem; margin-top: 6px;">回答中断（网络或请求异常）；以上是已收到的内容，可手动继续。</p>`
                    : `<span style="color: #ef4444; font-weight: 500;">${escapeUntrustedHtml(errStr)}</span>`
            }
            if (metaDiv) {
                metaDiv.innerHTML = hasPartialAnswer
                    ? '<span>回答未完（请求中断，已保留部分内容）</span><div class="ai-msg-actions"><button type="button" class="ai-msg-action-btn btn-msg-copy">复制</button><button type="button" class="ai-msg-action-btn btn-msg-continue">继续回答</button></div>'
                    : '<span>请求失败（草稿已保留）</span>'
                if (hasPartialAnswer) this.bindMessageActionButtons(msgElement, assistantMsg)
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = hasPartialAnswer ? '回答中断，已保留部分内容' : '请求失败'
        } finally {
            this.isGenerating = false
            this.activeRequestId = null
            if (this.dom.btnAiStopGeneration) {
                this.dom.btnAiStopGeneration.disabled = true
                this.dom.btnAiStopGeneration.classList.remove('active')
            }
            if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = false

            // Calculate actual remaining cooldown since dispatch time:
            // "第一条立即发送；若 3 秒就完成，还需等 7 秒才能再发。若 15 秒完成，可立即发送下一条。"
            const elapsedSecs = Math.floor((Date.now() - (this.dispatchedAt || 0)) / 1000)
            const configuredCooldown = this.app?.advancedSettings?.config?.aiCooldownSeconds ?? this.app?.advancedSettings?.aiCooldownSeconds ?? 10
            const remaining = configuredCooldown > 0 ? Math.max(0, configuredCooldown - elapsedSecs) : 0

            if (remaining > 0) {
                this.startCooldownCountdown(remaining)
            } else {
                this.clearCooldown()
            }
            this.scrollToBottom()
        }
    }

    async handleStopGeneration() {
        if (!this.isGenerating) return

        const reqId = this.activeRequestId
        if (reqId) {
            await abortAiRequest(reqId)
        }

        if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = '已请求停止生成'
        this.app?.showToast?.('已停止生成（已保留部分回答）', 'info')
    }

    clearCooldown() {
        if (this.cooldownTimer) {
            clearInterval(this.cooldownTimer)
            this.cooldownTimer = null
        }
        this.remainingCooldown = 0
        if (this.dom.aiCooldownIndicator) {
            this.dom.aiCooldownIndicator.style.display = 'none'
            this.dom.aiCooldownIndicator.innerText = ''
        }
    }

    startCooldownCountdown(seconds = 10) {
        if (this.cooldownTimer) clearInterval(this.cooldownTimer)
        this.remainingCooldown = seconds

        const indicator = this.dom.aiCooldownIndicator
        if (!indicator) return

        indicator.style.display = 'inline-block'
        indicator.innerText = `⏳ 请等待 ${this.remainingCooldown}s 后再发`

        this.cooldownTimer = setInterval(() => {
            this.remainingCooldown--
            if (this.remainingCooldown <= 0) {
                this.clearCooldown()
            } else {
                indicator.innerText = `⏳ 请等待 ${this.remainingCooldown}s 后再发`
            }
        }, 1000)
    }

    async syncCooldownStatus() {
        const status = await getAiStatus()
        if (status.remainingCooldownSeconds > 0) {
            this.startCooldownCountdown(status.remainingCooldownSeconds)
        }
    }

    // =========================================================================
    // Conversation & Message View
    // =========================================================================

    async ensureActiveConversation() {
        const bookId = this.app?.currentBook?.id || 'general'
        const bookTitle = this.app?.currentBook?.title || '图书阅读辅导'

        if (!this.currentConversation || this.currentConversation.bookId !== bookId) {
            // Check existing conversations for this book
            const existing = await getAiConversationsByBook(bookId)
            if (existing && existing.length > 0) {
                this.currentConversation = existing[0]
            } else {
                this.currentConversation = {
                    id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    bookId,
                    bookTitle,
                    title: `${bookTitle} · 阅读对话`,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    schemaVersion: 1
                }
                await saveAiConversation(this.currentConversation)
            }
            await this.loadConversationMessages(this.currentConversation.id)
        }

        if (this.dom.aiSidebarConvTitle) {
            this.dom.aiSidebarConvTitle.innerText = this.currentConversation.title || bookTitle
        }
    }

    async startNewConversation() {
        const bookId = this.app?.currentBook?.id || 'general'
        const bookTitle = this.app?.currentBook?.title || '图书阅读辅导'

        this.currentConversation = {
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            bookId,
            bookTitle,
            title: `${bookTitle} · 新对话`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            schemaVersion: 1
        }

        await saveAiConversation(this.currentConversation)
        if (this.dom.aiSidebarConvTitle) {
            this.dom.aiSidebarConvTitle.innerText = this.currentConversation.title
        }

        this.clearMessagesUI()
        this.app?.showToast?.('已开启新对话', 'success')
    }

    async loadConversationMessages(convId) {
        this.clearMessagesUI()
        if (!convId) return

        const messages = await getAiMessages(convId)
        if (!messages || messages.length === 0) {
            this.showEmptyWelcome()
            return
        }

        messages.forEach(msg => {
            this.appendMessageToUI(msg)
        })
        this.scrollToBottom()
    }

    clearMessagesUI() {
        if (this.dom.aiChatMessages) {
            this.dom.aiChatMessages.innerHTML = ''
        }
    }

    showEmptyWelcome() {
        if (!this.dom.aiChatMessages) return
        this.dom.aiChatMessages.innerHTML = `
            <div class="ai-chat-welcome">
                <div style="font-size: 1.8rem; margin-bottom: 6px;">📖✨</div>
                <div style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">开启 AI 辅助阅读</div>
                <div>划词后点击气泡上的 AI 按钮附上选文引用，或在下方直接提问。选文与解答将自动保存在本机。</div>
            </div>
        `
    }

    appendMessageToUI(msg) {
        const container = this.dom.aiChatMessages
        if (!container) return null

        // Remove welcome if present
        const welcome = container.querySelector('.ai-chat-welcome')
        if (welcome) welcome.remove()

        const isUser = msg.role === 'user'
        const el = document.createElement('div')
        el.className = `ai-message ${isUser ? 'ai-message-user' : 'ai-message-assistant'}`
        el.dataset.msgId = msg.id

        // Quote reference card if present
        let refHtml = ''
        if (msg.referenceSnapshot && msg.referenceSnapshot.selectedText) {
            const shortText = msg.referenceSnapshot.selectedText.slice(0, 100) + (msg.referenceSnapshot.selectedText.length > 100 ? '...' : '')
            const chapterMeta = msg.referenceSnapshot.chapterOrPage ? ` · ${escapeUntrustedHtml(msg.referenceSnapshot.chapterOrPage)}` : ''
            let contextLabel = ''
            if (msg.contextSnapshot?.tokenCount > 0) {
                contextLabel = `📖 已附带约 ${msg.contextSnapshot.tokenCount} token 附近正文`
            } else if (msg.contextReason) {
                contextLabel = `附近正文: ${msg.contextReason}`
            } else if (isUser) {
                contextLabel = '未附带附近正文'
            }
            const contextInfo = contextLabel
                ? `<div style="font-size: 0.68rem; color: ${msg.contextSnapshot?.tokenCount > 0 ? 'var(--accent-purple, #8b5cf6)' : 'var(--text-muted)'}; margin-top: 3px;">${escapeUntrustedHtml(contextLabel)}</div>`
                : ''
            refHtml = `
                <div class="ai-message-ref-card" title="点击定位到原文段落">
                    <div style="font-size: 0.7rem; font-weight: 600; color: var(--accent-purple, #8b5cf6);">引用原文${chapterMeta}</div>
                    <div>“${escapeUntrustedHtml(shortText)}”</div>
                    ${contextInfo}
                </div>
            `
        }

        const formattedContent = msg.content ? renderSafeMarkdown(msg.content) : (isUser ? '' : '<span style="color: var(--text-muted);">正在思考生成中...</span>')

        let actionsHtml = ''
        if (!isUser && (msg.status === 'completed' || (msg.status === 'partial' && msg.content))) {
            const continueAction = msg.status === 'partial' || msg.finishReason === 'length' || msg.finishReason === 'max_tokens'
                ? '<button type="button" class="ai-msg-action-btn btn-msg-continue" title="先检查草稿，再手动发送继续请求">继续回答</button>'
                : ''
            actionsHtml = `
                <div class="ai-msg-actions">
                    <button type="button" class="ai-msg-action-btn btn-msg-copy" title="复制回答">复制</button>
                    ${msg.status === 'completed' ? '<button type="button" class="ai-msg-action-btn btn-msg-save-note" title="保存为划线批注">保存为笔记</button>' : ''}
                    ${continueAction}
                </div>
            `
        }

        const usageText = msg.usage?.total_tokens ? `${msg.usage.total_tokens} tokens` : ''
        const timeStr = new Date(msg.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

        el.innerHTML = `
            ${refHtml}
            <div class="ai-msg-bubble">
                <div class="ai-msg-content">${formattedContent}</div>
            </div>
            <div class="ai-msg-meta-bar">
                <span>${timeStr} ${usageText ? `· ${usageText}` : ''}${msg.status === 'partial' || msg.finishReason === 'length' || msg.finishReason === 'max_tokens' ? ' · 回答未完' : ''}</span>
                ${actionsHtml}
            </div>
        `

        // Bind quote card click to jump to passage
        const refCard = el.querySelector('.ai-message-ref-card')
        if (refCard && msg.referenceSnapshot) {
            refCard.addEventListener('click', () => {
                this.jumpToReference(msg.referenceSnapshot)
            })
        }

        // Bind copy & save note actions
        this.bindMessageActionButtons(el, msg)

        container.appendChild(el)
        this.scrollToBottom()
        return el
    }

    bindMessageActionButtons(msgElement, msg) {
        if (!msgElement) return

        msgElement.querySelector('.btn-msg-continue')?.addEventListener('click', () => {
            if (!this.dom.aiChatInput) return
            this.dom.aiChatInput.value = '请从刚才未完的地方继续，不要重复前文。'
            this.dom.aiChatInput.focus()
        })

        const btnCopy = msgElement.querySelector('.btn-msg-copy')
        btnCopy?.addEventListener('click', () => {
            if (msg.content) {
                navigator.clipboard.writeText(msg.content).then(() => {
                    this.app?.showToast?.('回答已复制到剪贴板', 'success')
                })
            }
        })

        const btnSaveNote = msgElement.querySelector('.btn-msg-save-note')
        btnSaveNote?.addEventListener('click', async () => {
            if (msg.status !== 'completed' || !msg.content) {
                this.app?.showToast?.('暂无可保存的完整回答', 'warning')
                return
            }

            const ref = msg.referenceSnapshot
            if (!ref || (!ref.cfi && !ref.pdfTarget)) {
                navigator.clipboard.writeText(msg.content).then(() => {
                    this.app?.showToast?.('无原文锚点，已复制回答到剪贴板', 'info')
                })
                return
            }

            try {
                if (this.app?.createHighlight) {
                    await this.app.createHighlight('#3b82f6', 'highlight', `[AI 辅助]: ${msg.content}`, ref)
                    this.app?.showToast?.('已将 AI 解读保存为原文划线批注', 'success')
                }
            } catch (e) {
                this.app?.showToast?.('保存批注失败: ' + e.message, 'warning')
            }
        })
    }

    async jumpToReference(ref) {
        if (!ref) return
        try {
            // Support cross-book navigation if reference belongs to another book
            if (ref.bookId && this.app?.currentBookId && ref.bookId !== this.app.currentBookId) {
                if (typeof this.app.openBook === 'function') {
                    await this.app.openBook(ref.bookId)
                    // Wait briefly for book renderer to mount
                    await new Promise(r => setTimeout(r, 450))
                }
            }
            if (ref.cfi && this.app?.foliateView?.goTo) {
                await this.app.foliateView.goTo(ref.cfi)
                this.app?.showToast?.('已定位至引用原文', 'info')
                return
            }
            if (typeof ref.pageIndex === 'number') {
                if (this.app?.pdfViewport?.goToPage) {
                    this.app.pdfViewport.goToPage(ref.pageIndex)
                    this.app?.showToast?.(`已定位至第 ${ref.pageIndex + 1} 页`, 'info')
                    return
                }
                if (typeof this.app?.goToPdfPage === 'function') {
                    this.app.goToPdfPage(ref.pageIndex)
                    this.app?.showToast?.(`已定位至第 ${ref.pageIndex + 1} 页`, 'info')
                    return
                }
            }
            if (ref.cfi && this.app?.rendition?.display) {
                this.app.rendition.display(ref.cfi)
                this.app?.showToast?.('已定位至引用原文', 'info')
                return
            }
            this.app?.showToast?.('原书锚点已不可用', 'warning')
        } catch (e) {
            console.warn('[AI Sidebar] Jump error:', e)
        }
    }

    scrollToBottom() {
        const el = this.dom.aiChatMessages
        if (el) {
            el.scrollTop = el.scrollHeight
        }
    }

    // =========================================================================
    // Presets Manager Modal & Replacement Flow
    // =========================================================================

    openPresetsModal() {
        if (!this.dom.modalAiPresets) return
        this.renderPresetsManagerList()
        this.dom.modalAiPresets.style.display = 'flex'
        requestAnimationFrame(() => this.dom.modalAiPresets.classList.add('show'))
    }

    closePresetsModal() {
        if (!this.dom.modalAiPresets) return
        this.dom.modalAiPresets.classList.remove('show')
        setTimeout(() => {
            this.dom.modalAiPresets.style.display = 'none'
            this.renderQuickPresets()
        }, 200)
    }

    renderPresetsManagerList() {
        const listContainer = this.dom.aiPresetsList
        if (!listContainer) return

        const all = getAiPresets()
        const enabledCount = all.filter(p => p.enabled).length
        if (this.dom.aiPresetsQuotaBadge) {
            this.dom.aiPresetsQuotaBadge.innerText = `已启用 ${enabledCount} / ${MAX_ENABLED_PRESETS} 个`
        }

        listContainer.innerHTML = ''

        all.forEach(preset => {
            const card = document.createElement('div')
            card.className = `ai-preset-item-card ${preset.enabled ? 'is-active' : ''}`

            const switchHtml = `
                <label class="toggle-switch" title="切换启用状态">
                    <input type="checkbox" class="chk-preset-enable" ${preset.enabled ? 'checked' : ''} />
                    <span class="toggle-slider"></span>
                </label>
            `

            const deleteHtml = preset.builtIn
                ? `<button type="button" class="btn-ai-text-action btn-restore-default" style="font-size: 0.74rem;">恢复默认</button>`
                : `<button type="button" class="btn-ai-text-action btn-ai-danger btn-delete-preset" style="font-size: 0.74rem;">删除</button>`

            card.innerHTML = `
                <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <input type="text" class="global-modal-input input-preset-name" value="${escapeUntrustedHtml(preset.name)}" maxlength="12" style="font-weight: 700; width: 130px; font-size: 0.82rem; padding: 2px 6px;" />
                            ${preset.builtIn ? '<span style="font-size: 0.68rem; background: var(--bg-tertiary); padding: 1px 4px; border-radius: 3px; color: var(--text-muted);">内置</span>' : ''}
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            ${deleteHtml}
                            ${switchHtml}
                        </div>
                    </div>
                    <textarea class="global-modal-input input-preset-prompt" rows="2" style="font-size: 0.78rem; padding: 4px 6px; resize: vertical;">${escapeUntrustedHtml(preset.prompt)}</textarea>
                </div>
            `

            // Event bindings
            const chk = card.querySelector('.chk-preset-enable')
            chk?.addEventListener('change', () => {
                if (chk.checked) {
                    const res = setPresetEnabled(preset.id, true)
                    if (!res.success && res.reason === 'MAX_LIMIT_REACHED') {
                        chk.checked = false
                        this.openReplacePresetModal(preset)
                    } else {
                        this.renderPresetsManagerList()
                    }
                } else {
                    setPresetEnabled(preset.id, false)
                    this.renderPresetsManagerList()
                }
            })

            const nameInput = card.querySelector('.input-preset-name')
            nameInput?.addEventListener('change', () => {
                updatePreset(preset.id, { name: nameInput.value })
            })

            const promptInput = card.querySelector('.input-preset-prompt')
            promptInput?.addEventListener('change', () => {
                updatePreset(preset.id, { prompt: promptInput.value })
            })

            const btnDelete = card.querySelector('.btn-delete-preset')
            btnDelete?.addEventListener('click', () => {
                deletePreset(preset.id)
                this.renderPresetsManagerList()
            })

            const btnRestore = card.querySelector('.btn-restore-default')
            btnRestore?.addEventListener('click', () => {
                resetBuiltinPreset(preset.id)
                this.renderPresetsManagerList()
            })

            listContainer.appendChild(card)
        })
    }

    handleCreateCustomPreset() {
        const name = (this.dom.inputNewPresetName?.value || '').trim()
        const prompt = (this.dom.inputNewPresetPrompt?.value || '').trim()

        const res = createCustomPreset({ name, prompt })
        if (res.success) {
            this.app?.showToast?.(res.message, 'success')
            if (this.dom.inputNewPresetName) this.dom.inputNewPresetName.value = ''
            if (this.dom.inputNewPresetPrompt) this.dom.inputNewPresetPrompt.value = ''
            this.renderPresetsManagerList()
        } else {
            this.app?.showToast?.(res.message || '创建预设失败', 'warning')
        }
    }

    openReplacePresetModal(targetToEnable) {
        if (!this.dom.modalAiReplacePreset) return

        const container = this.dom.aiReplaceOptionsList
        if (container) {
            container.innerHTML = ''
            const enabled = getEnabledPresets()
            enabled.forEach(p => {
                const optBtn = document.createElement('button')
                optBtn.type = 'button'
                optBtn.className = 'btn-secondary-action'
                optBtn.style.textAlign = 'left'
                optBtn.style.padding = '8px 12px'
                optBtn.innerHTML = `<strong>停用「${escapeUntrustedHtml(p.name)}」</strong>，替换为「${escapeUntrustedHtml(targetToEnable.name)}」`

                optBtn.addEventListener('click', () => {
                    replaceEnabledPreset(p.id, targetToEnable.id)
                    this.closeReplacePresetModal()
                    this.renderPresetsManagerList()
                    this.app?.showToast?.(`已将快捷按钮替换为「${targetToEnable.name}」`, 'success')
                })

                container.appendChild(optBtn)
            })
        }

        this.dom.modalAiReplacePreset.style.display = 'flex'
        requestAnimationFrame(() => this.dom.modalAiReplacePreset.classList.add('show'))
    }

    closeReplacePresetModal() {
        if (!this.dom.modalAiReplacePreset) return
        this.dom.modalAiReplacePreset.classList.remove('show')
        setTimeout(() => {
            this.dom.modalAiReplacePreset.style.display = 'none'
        }, 200)
    }

    // =========================================================================
    // History Modal & Persistence Navigation
    // =========================================================================

    async openHistoryModal() {
        if (!this.dom.modalAiHistory) return
        this.dom.modalAiHistory.style.display = 'flex'
        requestAnimationFrame(() => this.dom.modalAiHistory.classList.add('show'))

        await this.loadAllHistoryConversations()
    }

    closeHistoryModal() {
        if (!this.dom.modalAiHistory) return
        this.dom.modalAiHistory.classList.remove('show')
        setTimeout(() => {
            this.dom.modalAiHistory.style.display = 'none'
        }, 200)
    }

    async loadAllHistoryConversations() {
        const list = await getAllAiConversations()
        this._cachedHistoryList = list || []
        this.renderHistoryList(this._cachedHistoryList)

        if (this._cachedHistoryList.length > 0) {
            this.selectHistoryConversation(this._cachedHistoryList[0].id)
        }
    }

    filterHistoryList() {
        const query = (this.dom.inputAiHistorySearch?.value || '').trim().toLowerCase()
        if (!this._cachedHistoryList) return

        if (!query) {
            this.renderHistoryList(this._cachedHistoryList)
            return
        }

        const filtered = this._cachedHistoryList.filter(c =>
            (c.title || '').toLowerCase().includes(query) ||
            (c.bookTitle || '').toLowerCase().includes(query)
        )
        this.renderHistoryList(filtered)
    }

    renderHistoryList(conversations) {
        const container = this.dom.aiHistoryConversationsList
        if (!container) return

        container.innerHTML = ''
        if (!conversations || conversations.length === 0) {
            container.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; margin-top: 30px;">暂无历史问答记录</div>'
            return
        }

        conversations.forEach(conv => {
            const item = document.createElement('div')
            item.className = 'ai-history-item'
            item.dataset.convId = conv.id
            item.style.padding = '8px 10px'
            item.style.borderRadius = '6px'
            item.style.cursor = 'pointer'
            item.style.background = 'var(--bg-card)'
            item.style.border = '1px solid var(--border-color)'

            const dateStr = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString()
            item.innerHTML = `
                <div style="font-size: 0.84rem; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeUntrustedHtml(conv.title || '阅读对话')}</div>
                <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--text-muted); margin-top: 3px;">
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;">${escapeUntrustedHtml(conv.bookTitle || '未指定书籍')}</span>
                    <span>${dateStr}</span>
                </div>
            `

            item.addEventListener('click', () => {
                this.selectHistoryConversation(conv.id)
            })

            container.appendChild(item)
        })
    }

    async selectHistoryConversation(convId) {
        this._selectedHistoryConvId = convId
        const conv = await getAiConversation(convId)
        if (!conv) return

        if (this.dom.aiHistoryActiveTitle) this.dom.aiHistoryActiveTitle.innerText = conv.title || '阅读对话'
        if (this.dom.aiHistoryActiveMeta) {
            const dateStr = new Date(conv.createdAt || Date.now()).toLocaleString()
            this.dom.aiHistoryActiveMeta.innerText = `${conv.bookTitle || ''} · 创建于 ${dateStr}`
        }

        if (this.dom.btnHistoryJumpBook) this.dom.btnHistoryJumpBook.style.display = conv.bookId && conv.bookId !== 'general' ? 'inline-block' : 'none'
        if (this.dom.btnHistoryExportMd) this.dom.btnHistoryExportMd.style.display = 'inline-block'
        if (this.dom.btnHistoryDeleteConv) this.dom.btnHistoryDeleteConv.style.display = 'inline-block'

        // Highlight selected
        const items = this.dom.aiHistoryConversationsList?.querySelectorAll('.ai-history-item')
        items?.forEach(el => {
            el.style.borderColor = el.dataset.convId === convId ? 'var(--accent-purple, #8b5cf6)' : 'var(--border-color)'
            el.style.background = el.dataset.convId === convId ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)'
        })

        // Render messages
        const msgs = await getAiMessages(convId)
        const view = this.dom.aiHistoryMessagesView
        if (!view) return

        view.innerHTML = ''
        if (!msgs || msgs.length === 0) {
            view.innerHTML = '<div style="color: var(--text-muted); font-size: 0.84rem; text-align: center; margin-top: 40px;">该会话暂无消息</div>'
            return
        }

        msgs.forEach(msg => {
            const isUser = msg.role === 'user'
            const msgEl = document.createElement('div')
            msgEl.className = `ai-message ${isUser ? 'ai-message-user' : 'ai-message-assistant'}`

            let refHtml = ''
            if (msg.referenceSnapshot?.selectedText) {
                refHtml = `
                    <div class="ai-message-ref-card">
                        <div style="font-size: 0.7rem; font-weight: 600; color: var(--accent-purple, #8b5cf6);">引用原文</div>
                        <div>“${escapeUntrustedHtml(msg.referenceSnapshot.selectedText)}”</div>
                    </div>
                `
            }

            msgEl.innerHTML = `
                ${refHtml}
                <div class="ai-msg-bubble">
                    <div class="ai-msg-content">${renderSafeMarkdown(msg.content)}</div>
                </div>
            `
            view.appendChild(msgEl)
        })
    }

    async handleHistoryJumpToBook(convId) {
        const targetId = convId || this._selectedHistoryConvId || this._selectedWorkspaceConvId
        const conv = await getAiConversation(targetId)
        if (!conv || !conv.bookId || conv.bookId === 'general') {
            this.app?.showToast?.('该对话未关联具体书籍', 'info')
            return
        }

        this.closeHistoryModal()

        // Get messages to find the first referenceSnapshot if available
        const msgs = await getAiMessages(conv.id)
        const refWithAnchor = msgs?.find(m => m.referenceSnapshot && (m.referenceSnapshot.cfi || m.referenceSnapshot.pageIndex != null))?.referenceSnapshot
        const refToUse = refWithAnchor || { bookId: conv.bookId, cfi: conv.cfi }
        refToUse.bookId = conv.bookId

        if (typeof this.app?.openBook === 'function') {
            await this.app.openBook(conv.bookId)
            // Wait for book renderer to be mounted
            let attempts = 0
            while (attempts < 25 && (!this.app.foliateView && !this.app.pdfViewport)) {
                await new Promise(r => setTimeout(r, 100))
                attempts++
            }
            await new Promise(r => setTimeout(r, 200))

            if (refToUse.cfi || refToUse.pageIndex != null) {
                await this.jumpToReference(refToUse)
            } else {
                this.app?.showToast?.(`已打开图书《${conv.bookTitle || ''}》`, 'success')
            }
        }
    }

    async handleHistoryExportMarkdown(convId) {
        const targetId = convId || this._selectedHistoryConvId || this._selectedWorkspaceConvId
        const conv = await getAiConversation(targetId)
        if (!conv) return

        const msgs = await getAiMessages(conv.id)
        let md = `# ${conv.title || 'AI 阅读对话记录'}\n\n`
        md += `- 书籍: ${conv.bookTitle || '未知'}\n`
        md += `- 导出时间: ${new Date().toLocaleString()}\n\n---\n\n`

        msgs.forEach((m, idx) => {
            if (m.role === 'user') {
                md += `### Q${Math.floor(idx / 2) + 1}: ${m.content}\n\n`
                if (m.referenceSnapshot?.selectedText) {
                    md += `> 引用原文: ${m.referenceSnapshot.selectedText}\n\n`
                }
            } else {
                md += `${m.content}\n\n`
            }
        })

        // Download markdown file
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `AI阅读记录_${(conv.title || 'conversation').replace(/[\\/:*?"<>|]/g, '_')}.md`
        a.click()
        URL.revokeObjectURL(url)
        this.app?.showToast?.('已导出 Markdown 文件', 'success')
    }

    async handleHistoryDeleteActive(convId, isWorkspace = false) {
        const targetId = convId || (isWorkspace ? this._selectedWorkspaceConvId : this._selectedHistoryConvId)
        if (!targetId) return
        const conv = await getAiConversation(targetId)
        const titleStr = conv?.title ? `“${conv.title}”` : '此会话'
        if (confirm(`确定要删除${titleStr}记录吗？删除后不可恢复。`)) {
            await deleteAiConversation(targetId)
            this.app?.showToast?.('会话已删除', 'info')
            if (isWorkspace) {
                if (this._selectedWorkspaceConvId === targetId) {
                    this._selectedWorkspaceConvId = null
                }
                await this.renderHistoryWorkspace()
            } else {
                await this.loadAllHistoryConversations()
            }
        }
    }

    async handleClearAllHistory(isWorkspace = false) {
        if (confirm('确定要清空本机所有 AI 阅读历史记录吗？此操作无法撤销。')) {
            await clearAllAiHistory()
            this.app?.showToast?.('已清空全部 AI 阅读历史', 'info')
            if (isWorkspace) {
                await this.renderHistoryWorkspace()
            } else {
                await this.loadAllHistoryConversations()
            }
        }
    }

    // =========================================================================
    // Bookshelf AI History Workspace View (First-Class Page)
    // =========================================================================

    async renderHistoryWorkspace() {
        try {
            const list = await getAllAiConversations()
            this._cachedWorkspaceList = list || []

            if (this.dom.aiHistoryTotalCount) {
                this.dom.aiHistoryTotalCount.innerText = `共 ${this._cachedWorkspaceList.length} 条对话`
            }

            this.renderWorkspaceConversationsList(this._cachedWorkspaceList)

            if (this._cachedWorkspaceList.length > 0) {
                const stillExists = this._selectedWorkspaceConvId && this._cachedWorkspaceList.some(c => c.id === this._selectedWorkspaceConvId)
                const targetId = stillExists ? this._selectedWorkspaceConvId : this._cachedWorkspaceList[0].id
                await this.selectWorkspaceConversation(targetId)
            } else {
                this._selectedWorkspaceConvId = null
                if (this.dom.aiHistoryPageTitle) this.dom.aiHistoryPageTitle.innerText = '暂无历史问答'
                if (this.dom.aiHistoryPageMeta) this.dom.aiHistoryPageMeta.innerText = ''
                if (this.dom.btnHistoryPageJumpBook) this.dom.btnHistoryPageJumpBook.style.display = 'none'
                if (this.dom.btnHistoryPageExportMd) this.dom.btnHistoryPageExportMd.style.display = 'none'
                if (this.dom.btnHistoryPageDeleteConv) this.dom.btnHistoryPageDeleteConv.style.display = 'none'
                if (this.dom.aiHistoryPageMessagesList) {
                    this.dom.aiHistoryPageMessagesList.innerHTML = `
                        <div class="ai-history-empty-placeholder">
                            <svg class="icon icon-lg" viewBox="0 0 24 24" style="color: var(--text-muted); opacity: 0.5;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                            <p style="color: var(--text-muted); font-size: 0.88rem; margin-top: 10px;">在阅读时选文中开启 AI 提问与深度探讨，历史记录将自动汇总于此</p>
                        </div>
                    `
                }
            }
        } catch (err) {
            console.error('[AI History] Failed to load history conversations:', err)
            this._cachedWorkspaceList = []
            if (this.dom.aiHistoryTotalCount) {
                this.dom.aiHistoryTotalCount.innerText = '加载历史失败'
            }
            if (this.dom.aiHistoryPageConvList) {
                this.dom.aiHistoryPageConvList.innerHTML = `<div style="padding: 20px; font-size: 0.85rem; color: #ef4444; text-align: center;">加载 AI 历史记录失败：${escapeUntrustedHtml(err?.message || '未知错误')}</div>`
            }
            if (this.dom.aiHistoryPageMessagesList) {
                this.dom.aiHistoryPageMessagesList.innerHTML = `<div class="ai-history-empty-placeholder"><p style="color: #ef4444; font-size: 0.88rem;">读取历史问答遇到异常，请重试或检查数据库状态</p></div>`
            }
        }
    }

    async filterWorkspaceHistoryList() {
        const query = (this.dom.inputAiHistoryPageSearch?.value || '').trim().toLowerCase()
        if (!this._cachedWorkspaceList) return

        if (!query) {
            this.renderWorkspaceConversationsList(this._cachedWorkspaceList)
            return
        }

        const directMatches = new Set()
        const filtered = this._cachedWorkspaceList.filter(c => {
            const match = (c.title || '').toLowerCase().includes(query) ||
                          (c.bookTitle || '').toLowerCase().includes(query)
            if (match) directMatches.add(c.id)
            return match
        })

        // Also search in message content and quote text
        const deepSearchPromises = this._cachedWorkspaceList
            .filter(c => !directMatches.has(c.id))
            .map(async conv => {
                try {
                    const msgs = await getAiMessages(conv.id)
                    const hasMatch = msgs.some(m =>
                        (m.content || '').toLowerCase().includes(query) ||
                        (m.quoteText || '').toLowerCase().includes(query)
                    )
                    return hasMatch ? conv : null
                } catch {
                    return null
                }
            })

        const deepMatches = (await Promise.all(deepSearchPromises)).filter(Boolean)
        const combined = [...filtered, ...deepMatches]
        this.renderWorkspaceConversationsList(combined)
    }

    renderWorkspaceConversationsList(conversations) {
        const container = this.dom.aiHistoryPageConvList
        if (!container) return

        container.innerHTML = ''
        if (!conversations || conversations.length === 0) {
            container.innerHTML = '<div style="font-size: 0.82rem; color: var(--text-muted); text-align: center; margin-top: 30px;">未找到匹配对话</div>'
            return
        }

        conversations.forEach(conv => {
            const card = document.createElement('div')
            card.className = 'ai-history-conv-card'
            if (conv.id === this._selectedWorkspaceConvId) {
                card.classList.add('active')
            }
            card.dataset.convId = conv.id

            const dateStr = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString()
            card.innerHTML = `
                <div class="ai-history-card-title">${escapeUntrustedHtml(conv.title || '阅读对话')}</div>
                <div class="ai-history-card-meta">
                    <span class="ai-history-card-book">${escapeUntrustedHtml(conv.bookTitle || '未指定书籍')}</span>
                    <span>${dateStr}</span>
                </div>
            `

            card.addEventListener('click', () => {
                this.selectWorkspaceConversation(conv.id)
            })

            container.appendChild(card)
        })
    }

    async selectWorkspaceConversation(convId) {
        this._selectWorkspaceConvGeneration = (this._selectWorkspaceConvGeneration || 0) + 1
        const generation = this._selectWorkspaceConvGeneration
        this._selectedWorkspaceConvId = convId

        const conv = await getAiConversation(convId)
        if (generation !== this._selectWorkspaceConvGeneration) return
        if (!conv) return

        // Update active card styling
        const cards = this.dom.aiHistoryPageConvList?.querySelectorAll('.ai-history-conv-card')
        cards?.forEach(c => {
            c.classList.toggle('active', c.dataset.convId === convId)
        })

        const msgs = await getAiMessages(convId)
        if (generation !== this._selectWorkspaceConvGeneration) return

        if (this.dom.aiHistoryPageTitle) {
            this.dom.aiHistoryPageTitle.innerText = conv.title || '阅读对话'
        }
        if (this.dom.aiHistoryPageMeta) {
            const dateStr = new Date(conv.createdAt || Date.now()).toLocaleString()
            this.dom.aiHistoryPageMeta.innerText = `${conv.bookTitle || '未关联图书'} · 共 ${msgs?.length || 0} 条消息 · 创建于 ${dateStr}`
        }

        // Show/hide buttons
        if (this.dom.btnHistoryPageJumpBook) {
            this.dom.btnHistoryPageJumpBook.style.display = (conv.bookId && conv.bookId !== 'general') ? 'inline-flex' : 'none'
        }
        if (this.dom.btnHistoryPageExportMd) {
            this.dom.btnHistoryPageExportMd.style.display = 'inline-flex'
        }
        if (this.dom.btnHistoryPageDeleteConv) {
            this.dom.btnHistoryPageDeleteConv.style.display = 'inline-flex'
        }

        this.renderWorkspaceMessages(msgs, conv)
    }

    renderWorkspaceMessages(msgs, conv) {
        const view = this.dom.aiHistoryPageMessagesList
        if (!view) return

        view.innerHTML = ''
        if (!msgs || msgs.length === 0) {
            view.innerHTML = '<div style="color: var(--text-muted); font-size: 0.84rem; text-align: center; margin-top: 40px;">该会话暂无消息</div>'
            return
        }

        msgs.forEach(msg => {
            const isUser = msg.role === 'user'
            const msgEl = document.createElement('div')
            msgEl.className = `ai-message ${isUser ? 'ai-message-user' : 'ai-message-assistant'}`
            msgEl.style.maxWidth = '88%'

            let refHtml = ''
            if (msg.referenceSnapshot?.selectedText) {
                const text = msg.referenceSnapshot.selectedText
                const isLong = text.length > 80
                const chapterLabel = msg.referenceSnapshot.chapterOrPage ? ` · ${escapeUntrustedHtml(msg.referenceSnapshot.chapterOrPage)}` : ''
                refHtml = `
                    <div class="ai-history-quote-box ${isLong ? 'collapsed' : ''}">
                        <div style="font-size: 0.72rem; font-weight: 600; color: var(--accent-purple, #8b5cf6); margin-bottom: 4px;">引用原文${chapterLabel}</div>
                        <div class="ai-history-quote-text">“${escapeUntrustedHtml(text)}”</div>
                        ${isLong ? '<button type="button" class="ai-history-quote-expand-btn">展开全文</button>' : ''}
                    </div>
                `
            }

            msgEl.innerHTML = `
                ${refHtml}
                <div class="ai-msg-bubble">
                    <div class="ai-msg-content">${renderSafeMarkdown(msg.content)}</div>
                </div>
            `

            // Handle collapsible quote toggle
            const expandBtn = msgEl.querySelector('.ai-history-quote-expand-btn')
            if (expandBtn) {
                const quoteBox = msgEl.querySelector('.ai-history-quote-box')
                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    const isCollapsed = quoteBox.classList.toggle('collapsed')
                    expandBtn.innerText = isCollapsed ? '展开全文' : '收起'
                })
            }

            view.appendChild(msgEl)
        })
    }

    // =========================================================================
    // Audit Log Modal
    // =========================================================================

    async openAuditModal() {
        if (!this.dom.modalAiAudit) return
        this.dom.modalAiAudit.style.display = 'flex'
        requestAnimationFrame(() => this.dom.modalAiAudit.classList.add('show'))

        const entries = await getAiAuditLog(100)
        this.renderAuditTable(entries)
    }

    closeAuditModal() {
        if (!this.dom.modalAiAudit) return
        this.dom.modalAiAudit.classList.remove('show')
        setTimeout(() => {
            this.dom.modalAiAudit.style.display = 'none'
        }, 200)
    }

    renderAuditTable(entries) {
        const container = this.dom.aiAuditLogTableContainer
        if (!container) return

        if (!entries || entries.length === 0) {
            container.innerHTML = '<div style="font-size: 0.82rem; color: var(--text-muted); text-align: center; padding: 20px;">暂无调用记录</div>'
            return
        }

        let rows = ''
        entries.forEach(e => {
            const time = e.timestamp ? e.timestamp.replace('T', ' ').replace('Z', '') : ''
            const statusColor = e.status === 'completed' ? '#10b981' : (e.status === 'cancelled' ? '#f59e0b' : '#ef4444')
            const totalTok = e.totalTokens !== null && e.totalTokens !== undefined ? `${e.totalTokens}` : '<span style="color: var(--text-muted);">未知</span>'

            rows += `
                <tr>
                    <td style="white-space: nowrap;">${time}</td>
                    <td>${escapeUntrustedHtml(e.model || '-')}</td>
                    <td>${escapeUntrustedHtml(e.endpointHost || '-')}</td>
                    <td style="color: ${statusColor}; font-weight: 600;">${e.status}</td>
                    <td>${totalTok}</td>
                    <td>${e.durationMs}ms</td>
                </tr>
            `
        })

        container.innerHTML = `
            <table class="ai-audit-table">
                <thead>
                    <tr>
                        <th>时间 (UTC)</th>
                        <th>模型</th>
                        <th>服务器主机</th>
                        <th>状态</th>
                        <th>Token 用量</th>
                        <th>耗时</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `
    }

    async handleClearAuditLog() {
        await clearAiAuditLog()
        this.app?.showToast?.('已清空审计日志', 'info')
        this.renderAuditTable([])
    }
}
