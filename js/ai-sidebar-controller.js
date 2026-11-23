import { getAiResponseState } from './ai-response-state.js'
import { platformBridge } from './platformBridge.js'
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
import { getLocale, isEnglish, SUPPORTED_LOCALES, t } from './i18n.js'

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
        this.currentWidth = Number(app?.advancedSettings?.config?.sidebarDefaultWidth) || 380

        this.dom = {}
        this.cacheElements()
        this.bindEvents()
        this._historyLayoutQuery = window.matchMedia('(max-width: 767px)')
        this._historyLayoutQuery.addEventListener('change', () => {
            if (this._workspaceConversation) this.renderWorkspaceMessages(this._workspaceMessages, this._workspaceConversation)
            if (this._cachedWorkspaceList) this.filterWorkspaceHistoryList()
            this.syncMobileHistoryNavigation()
        })
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
        this.dom.btnAiCollapseSidebar?.addEventListener('click', () => this.closeSidebar())

        // Resizer drag
        this.setupResizer()

        // New Conversation & History
        this.dom.btnAiNewConv?.addEventListener('click', () => this.startNewConversation())
        this.dom.btnAiViewHistory?.addEventListener('click', () => this.openHistoryModal())

        // Reference controls
        this.dom.btnAiExpandRef?.addEventListener('click', () => {
            const isExp = this.dom.aiPendingRefText.classList.toggle('expanded')
            this.dom.btnAiExpandRef.innerText = isExp ? t('aiSidebar.collapseRefBtn') : t('aiSidebar.quoteExpandBtn')
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
                this.dom.btnAiPreviewContext.innerText = isHidden ? t('aiSidebar.hidePreviewBtn') : t('aiSidebar.contextPreviewBtn')
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
        this.dom.inputAiHistoryPageSearch?.addEventListener('input', () => {
            this._workspaceFilterGeneration = (this._workspaceFilterGeneration || 0) + 1
            clearTimeout(this._workspaceSearchTimer)
            this._workspaceSearchTimer = setTimeout(() => this.filterWorkspaceHistoryList(), 180)
        })
        this.dom.btnClearAllAiHistoryPage?.addEventListener('click', () => this.handleClearAllHistory(true))
        this.dom.btnHistoryPageJumpBook?.addEventListener('click', () => this.handleHistoryJumpToBook(this._selectedWorkspaceConvId))
        this.dom.btnHistoryPageExportMd?.addEventListener('click', () => this.handleHistoryExportMarkdown(this._selectedWorkspaceConvId))
        this.dom.btnHistoryPageDeleteConv?.addEventListener('click', () => this.handleHistoryDeleteActive(this._selectedWorkspaceConvId, true))
        document.getElementById('btn-history-page-mobile-back')?.addEventListener('click', () => {
            document.querySelector('.ai-history-split-pane')?.classList.remove('show-detail')
        })

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
        // The PDF viewport preserves its own scroll anchor on resize.
        if (this.app.pdfViewport) return null
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
                try {
                    await this.app.foliateView.goTo(anchor.cfi)
                } finally {
                    if (typeof this.app.foliateView.renderer?.clearLockedAnchor === 'function') {
                        this.app.foliateView.renderer.clearLockedAnchor()
                    } else if (typeof this.app.foliateView.renderer?.setAnchor === 'function') {
                        this.app.foliateView.renderer.setAnchor(null, false)
                    }
                }
                return
            }
            if (anchor.range && this.app?.foliateView?.renderer?.scrollToAnchor) {
                try {
                    await this.app.foliateView.renderer.scrollToAnchor(anchor.range)
                } finally {
                    if (typeof this.app.foliateView.renderer?.clearLockedAnchor === 'function') {
                        this.app.foliateView.renderer.clearLockedAnchor()
                    } else if (typeof this.app.foliateView.renderer?.setAnchor === 'function') {
                        this.app.foliateView.renderer.setAnchor(null, false)
                    }
                }
                return
            }
            if (anchor.pageIndex != null) {
                if (this.app?.pdfViewport?.goToPage) {
                    if (this.app.pdfViewport.currentPage !== anchor.pageIndex) {
                        this.app.pdfViewport.goToPage(anchor.pageIndex, anchor.yRatio)
                    }
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
            this.dom.btnAiExpandRef.innerText = t('aiSidebar.quoteExpandBtn')
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
            bar.innerText = t('aiSidebar.contextUserOff')
        } else if (budget === 0) {
            bar.innerText = t('aiSidebar.contextBudgetZero')
        } else if (!this.currentReference) {
            bar.innerText = t('aiSidebar.contextNoRef')
        } else if (this.currentContext && this.currentContext.tokenCount > 0) {
            bar.innerText = t('aiSidebar.contextTokensPending', { count: this.currentContext.tokenCount })
        } else {
            bar.innerText = t('aiSidebar.contextNoText')
        }

        if (content) {
            if (!isChecked) {
                content.innerText = t('aiSidebar.contextPreviewOffHint')
            } else if (budget === 0) {
                content.innerText = t('aiSidebar.contextPreviewBudgetZeroHint')
            } else if (!this.currentReference) {
                content.innerText = t('aiSidebar.contextPreviewNoRefHint')
            } else {
                content.innerText = this.currentContext?.contextText || t('aiSidebar.contextPreviewEmptyHint')
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
            this.app?.showToast?.(t('aiSidebar.toastBusy'), 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(t('aiSidebar.toastCooldown', { seconds: this.remainingCooldown }), 'warning')
            return
        }

        if (preset.requiresReference && (!this.currentReference || !this.currentReference.selectedText)) {
            this.app?.showToast?.(t('aiSidebar.toastNeedSelection'), 'warning')
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
            this.app?.showToast?.(t('aiSidebar.toastBusy'), 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(t('aiSidebar.toastCooldown', { seconds: this.remainingCooldown }), 'warning')
            return
        }

        const text = (this.dom.aiChatInput?.value || '').trim()
        if (!text) return

        this.dispatchAiTurn({
            promptText: text,
            userSupplement: '',
            presetId: null,
            actionName: t('aiSidebar.actionQa')
        })

        if (this.dom.aiChatInput) {
            this.dom.aiChatInput.value = ''
        }
    }

    async dispatchAiTurn({ promptText, userSupplement, presetId, actionName }) {
        if (this.isGenerating) {
            this.app?.showToast?.(t('aiSidebar.toastBusy'), 'warning')
            return
        }

        if (this.remainingCooldown > 0) {
            this.app?.showToast?.(t('aiSidebar.toastCooldown', { seconds: this.remainingCooldown }), 'warning')
            return
        }

        // Synchronously acquire generation lock and requestId BEFORE any async calls (N12)
        this.isGenerating = true
        this.activeRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        const currentRequestId = this.activeRequestId
        if (this.dom.btnAiStopGeneration) {
            this.dom.btnAiStopGeneration.disabled = false
            this.dom.btnAiStopGeneration.classList.add('active')
        }
        if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = true
        if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = t('aiSidebar.statusPreparing')

        const releaseLockOnPreflightError = () => {
            if (this.activeRequestId === currentRequestId) {
                this.isGenerating = false
                this.activeRequestId = null
                if (this.dom.btnAiStopGeneration) {
                    this.dom.btnAiStopGeneration.disabled = true
                    this.dom.btnAiStopGeneration.classList.remove('active')
                }
                if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = false
                if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = ''
            }
        }

        // Check if AI is configured
        let ready = false
        try {
            ready = await isAiReady()
        } catch (e) {
            releaseLockOnPreflightError()
            throw e
        }
        if (!ready) {
            releaseLockOnPreflightError()
            this.app?.showToast?.(t('aiSidebar.toastNeedApiKey'), 'warning')
            return
        }

        // Record dispatch timestamp for accurate elapsed-based cooldown calculation
        this.dispatchedAt = Date.now()

        // 1. Ensure conversation exists
        try {
            if (await this.ensureActiveConversation() === false) {
                releaseLockOnPreflightError()
                return
            }
        } catch (e) {
            releaseLockOnPreflightError()
            throw e
        }

        const refSnapshot = this.currentReference
        const rawBudget = this.app?.advancedSettings?.aiContextTokenBudget ?? this.app?.advancedSettings?.config?.aiContextTokenBudget
        const budget = Number.isFinite(Number(rawBudget)) ? Math.max(0, Math.min(10000, Number(rawBudget))) : 1000
        const isChecked = this.dom.aiChkIncludeContext ? this.dom.aiChkIncludeContext.checked : true
        const ctxSnapshot = (isChecked && budget > 0 && this.currentContext) ? this.currentContext : null

        let ctxReason = ''
        if (!isChecked) {
            ctxReason = t('aiSidebar.ctxReasonUserOff')
        } else if (budget === 0) {
            ctxReason = t('aiSidebar.ctxReasonBudgetZero')
        } else if (!refSnapshot) {
            ctxReason = t('aiSidebar.ctxReasonNoRef')
        } else if (this.currentContext && this.currentContext.tokenCount > 0) {
            ctxReason = t('aiSidebar.ctxReasonAttached', { count: this.currentContext.tokenCount })
        } else {
            ctxReason = t('aiSidebar.ctxReasonNoText')
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
            content: userSupplement ? `${promptText}\n\n${t('aiSidebar.supplementPrefix')}: ${userSupplement}` : promptText,
            actionName: actionName || t('aiSidebar.actionAsk'),
            referenceSnapshot: refSnapshot,
            contextSnapshot: ctxSnapshot,
            contextReason: ctxReason,
            presetId: presetId || null,
            createdAt: Date.now(),
            status: 'completed'
        }

        const userSaved = await saveAiMessage(userMsg).catch(() => false)
        if (userSaved === false) {
            releaseLockOnPreflightError()
            this.app?.showToast?.(t('aiSidebar.toastMsgSaveFailed'), 'warning')
            return
        }
        this.appendMessageToUI(userMsg)
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
            model: getAiConfig().model || null,
            usage: null
        }

        const assistantSaved = await saveAiMessage(assistantMsg).catch(() => false)
        if (assistantSaved === false) {
            releaseLockOnPreflightError()
            this.app?.showToast?.(t('aiSidebar.toastConvInitFailed'), 'warning')
            return
        }
        const msgElement = this.appendMessageToUI(assistantMsg)
        this._activeAssistantMsg = assistantMsg

        // 4. Update UI State to Generating using the locked currentRequestId
        this.isGenerating = true
        this.activeRequestId = currentRequestId
        if (this.dom.btnAiStopGeneration) {
            this.dom.btnAiStopGeneration.disabled = false
            this.dom.btnAiStopGeneration.classList.add('active')
        }
        if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = true
        if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = t('aiSidebar.statusThinking')

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
            const configuredMaxTokens = this.app?.advancedSettings?.aiMaxTokens || this.app?.advancedSettings?.config?.aiMaxTokens || getAiConfig().maxTokens || 20000
            let lastSaveTime = Date.now()
            let pendingSave = false
            const throttleSaveChunk = (text) => {
                const now = Date.now()
                if (now - lastSaveTime > 500 && !pendingSave) {
                    lastSaveTime = now
                    pendingSave = true
                    saveAiMessage({ ...assistantMsg, content: text, status: 'streaming', updatedAt: Date.now() })
                        .catch(() => {})
                        .finally(() => { pendingSave = false })
                }
            }
            let renderRafId = null
            let renderTimer = null
            let pendingText = ''
            let lastRenderTime = 0
            const FLUSH_INTERVAL_MS = 60

            const flushContent = (text, forceScroll = false) => {
                if (!contentDiv || !text) return
                const chatEl = this.dom.aiChatMessages
                const wasNearBottom = forceScroll || (chatEl ? (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight) < 60 : true)
                contentDiv.innerHTML = renderSafeMarkdown(text)
                if (wasNearBottom) {
                    this.scrollToBottom()
                }
            }

            const scheduleChunkRender = (fullText) => {
                pendingText = fullText
                const now = performance.now()
                const elapsed = now - lastRenderTime
                if (elapsed >= FLUSH_INTERVAL_MS) {
                    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
                    if (!renderRafId) {
                        renderRafId = requestAnimationFrame(() => {
                            renderRafId = null
                            lastRenderTime = performance.now()
                            if (this.activeRequestId !== currentRequestId) return
                            flushContent(pendingText)
                        })
                    }
                } else if (!renderTimer && !renderRafId) {
                    renderTimer = setTimeout(() => {
                        renderTimer = null
                        if (!renderRafId) {
                            renderRafId = requestAnimationFrame(() => {
                                renderRafId = null
                                lastRenderTime = performance.now()
                                if (this.activeRequestId !== currentRequestId) return
                                flushContent(pendingText)
                            })
                        }
                    }, FLUSH_INTERVAL_MS - elapsed)
                }
            }

            const response = await requestAiCompletion({
                requestId: currentRequestId,
                messages,
                maxTokens: configuredMaxTokens,
                returnMetadata: true,
                onChunk: (delta, fullText) => {
                    if (this.activeRequestId !== currentRequestId) return
                    assistantMsg.content = fullText
                    scheduleChunkRender(fullText)
                    throttleSaveChunk(fullText)
                }
            })
            if (this.activeRequestId !== currentRequestId) return

            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null }
            if (renderRafId) { cancelAnimationFrame(renderRafId); renderRafId = null }

            const resultText = typeof response === 'string' ? response : (response?.fullText || '')
            const finishReason = typeof response === 'string' ? null : response?.finishReason

            // Finalize message on success
            const wasCutOff = finishReason === 'length' || finishReason === 'max_tokens'
            assistantMsg.content = resultText
            assistantMsg.status = getAiResponseState(response)
            assistantMsg.finishReason = finishReason || null
            assistantMsg.usage = response?.usage || null
            await saveAiMessage(assistantMsg)

            flushContent(resultText, true)
            if (metaDiv) {
                const usageLabel = assistantMsg.usage?.total_tokens ? t('aiSidebar.usageTokensSuffix', { count: assistantMsg.usage.total_tokens }) : t('aiSidebar.usageUnknownSuffix')
                const isPartial = assistantMsg.status === 'partial'
                const stateText = assistantMsg.status === 'cancelled' ? t('aiSidebar.stateCancelled') : isPartial ? (wasCutOff ? t('aiSidebar.stateCutOff') : t('aiSidebar.stateInterrupted')) : assistantMsg.status === 'failed' ? t('aiSidebar.stateFailedDraft') : t('aiSidebar.stateCompleted')
                const continueAction = (isPartial || assistantMsg.status === 'failed') && resultText.trim() ? `<button type="button" class="ai-msg-action-btn btn-msg-continue" title="${t('aiSidebar.continueTitle')}">${t('aiSidebar.continueBtn')}</button>` : ''
                const saveAction = assistantMsg.status === 'completed' ? `<button type="button" class="ai-msg-action-btn btn-msg-save-note" title="${t('aiSidebar.saveNoteTitle')}">${t('aiSidebar.saveNoteBtn')}</button>` : ''
                metaDiv.innerHTML = `<span>${escapeUntrustedHtml(stateText)}${escapeUntrustedHtml(usageLabel)}</span><div class="ai-msg-actions"><button type="button" class="ai-msg-action-btn btn-msg-copy" title="${t('aiSidebar.copyTitle')}">${t('common.copy')}</button>${saveAction}${continueAction}</div>`
                this.bindMessageActionButtons(msgElement, assistantMsg)
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = assistantMsg.status === 'partial' ? t('aiSidebar.statusPartial') : assistantMsg.status === 'cancelled' ? t('aiSidebar.stateCancelled') : assistantMsg.status === 'failed' ? t('aiSidebar.statusFailed') : t('aiSidebar.stateCompleted')
        } catch (err) {
            if (this.activeRequestId !== currentRequestId) return
            const errStr = err?.message || String(err)
            const hasPartialAnswer = Boolean(assistantMsg.content?.trim())
            assistantMsg.status = hasPartialAnswer ? 'partial' : 'failed'
            assistantMsg.errorMessage = errStr
            await saveAiMessage(assistantMsg)

            if (contentDiv) {
                contentDiv.innerHTML = hasPartialAnswer
                    ? `${renderSafeMarkdown(assistantMsg.content)}<p style="color: var(--text-muted); font-size: 0.78rem; margin-top: 6px;">${t('aiSidebar.interruptedNote')}</p>`
                    : `<span style="color: #ef4444; font-weight: 500;">${escapeUntrustedHtml(errStr)}</span>`
            }
            if (metaDiv) {
                metaDiv.innerHTML = hasPartialAnswer
                    ? `<span>${t('aiSidebar.interruptedMeta')}</span><div class="ai-msg-actions"><button type="button" class="ai-msg-action-btn btn-msg-copy">${t('common.copy')}</button><button type="button" class="ai-msg-action-btn btn-msg-continue">${t('aiSidebar.continueBtn')}</button></div>`
                    : `<span>${t('aiSidebar.failedMeta')}</span>`
                if (hasPartialAnswer) this.bindMessageActionButtons(msgElement, assistantMsg)
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = hasPartialAnswer ? t('aiSidebar.statusInterruptedPartial') : t('aiSidebar.statusFailed')
        } finally {
            if (this._activeAssistantMsg === assistantMsg) {
                this._activeAssistantMsg = null
            }
            if (this.activeRequestId === currentRequestId) {
                this.isGenerating = false
                this.activeRequestId = null
                if (this.dom.btnAiStopGeneration) {
                    this.dom.btnAiStopGeneration.disabled = true
                    this.dom.btnAiStopGeneration.classList.remove('active')
                }
                if (this.dom.btnAiSendMessage) this.dom.btnAiSendMessage.disabled = false

                // Calculate actual remaining cooldown since dispatch time:
                const elapsedSecs = Math.floor((Date.now() - (this.dispatchedAt || 0)) / 1000)
                const configuredCooldown = this.app?.advancedSettings?.config?.aiCooldownSeconds ?? this.app?.advancedSettings?.aiCooldownSeconds ?? 10
                const remaining = configuredCooldown > 0 ? Math.max(0, configuredCooldown - elapsedSecs) : 0

                if (remaining > 0) {
                    this.startCooldownCountdown(remaining)
                } else {
                    this.clearCooldown()
                }
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

        if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = t('aiSidebar.statusStopRequested')
        this.app?.showToast?.(t('aiSidebar.toastStoppedPartial'), 'info')
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
        indicator.innerText = t('aiSidebar.cooldownIndicator', { seconds: this.remainingCooldown })

        this.cooldownTimer = setInterval(() => {
            this.remainingCooldown--
            if (this.remainingCooldown <= 0) {
                this.clearCooldown()
            } else {
                indicator.innerText = t('aiSidebar.cooldownIndicator', { seconds: this.remainingCooldown })
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

    formatLocalizedConversationBookTitle(rawBookTitle, emptyFallbackKey = 'aiSidebar.fallbackBookTitle') {
        if (!rawBookTitle) return t(emptyFallbackKey)
        const isDefaultFallback = SUPPORTED_LOCALES.some(loc => rawBookTitle === t('aiSidebar.fallbackBookTitle', {}, loc))
        return isDefaultFallback ? t('aiSidebar.fallbackBookTitle') : rawBookTitle
    }

    formatLocalizedConversationTitle(conv, emptyTitleFallback = '') {
        if (!conv) return t('aiSidebar.subTitle')
        if (!conv.title) return emptyTitleFallback || t('aiSidebar.defaultConvTitle')
        const rawBookTitle = conv.bookTitle || this.app?.currentBookData?.title || this.app?.currentBook?.title || ''
        const displayBookTitle = this.formatLocalizedConversationBookTitle(rawBookTitle)
        const candidateBookTitles = Array.from(new Set([
            rawBookTitle,
            displayBookTitle,
            ...SUPPORTED_LOCALES.map(loc => t('aiSidebar.fallbackBookTitle', {}, loc))
        ].filter(Boolean)))

        for (const formatKey of ['aiSidebar.convTitleFormat', 'aiSidebar.newConvTitleFormat']) {
            const matchedDefault = SUPPORTED_LOCALES.some(loc =>
                candidateBookTitles.some(book => conv.title === t(formatKey, { title: book }, loc))
            )
            if (matchedDefault) {
                return t(formatKey, { title: displayBookTitle })
            }
        }
        return conv.title
    }

    async ensureActiveConversation() {
        const bookId = this.app?.currentBookId || 'general'
        const bookTitle = this.app?.currentBookData?.title || t('aiSidebar.fallbackBookTitle')
        const epoch = this.app?._currentBookEpoch
        let expectedConversation = this.currentConversation
        const isCurrent = () => (this.app?.currentBookId || 'general') === bookId && this.app?._currentBookEpoch === epoch && this.currentConversation === expectedConversation
        if (!this.currentConversation || this.currentConversation.bookId !== bookId) {
            const existing = await getAiConversationsByBook(bookId)
            if (!isCurrent()) return false
            const conversation = existing[0] || {
                id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                bookId, bookTitle, title: t('aiSidebar.convTitleFormat', { title: bookTitle }),
                createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1
            }
            if (!existing.length) await saveAiConversation(conversation)
            if (!isCurrent()) return false
            this.currentConversation = expectedConversation = conversation
            await this.loadConversationMessages(conversation.id)
            if (!isCurrent() || this.currentConversation !== conversation) return false
        }
        if (this.dom.aiSidebarConvTitle) this.dom.aiSidebarConvTitle.innerText = this.formatLocalizedConversationTitle(this.currentConversation, bookTitle)
        return true
    }

    async startNewConversation() {
        const bookId = this.app?.currentBook?.id || 'general'
        const bookTitle = this.app?.currentBook?.title || t('aiSidebar.fallbackBookTitle')

        this.currentConversation = {
            id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            bookId,
            bookTitle,
            title: t('aiSidebar.newConvTitleFormat', { title: bookTitle }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            schemaVersion: 1
        }

        await saveAiConversation(this.currentConversation)
        if (this.dom.aiSidebarConvTitle) {
            this.dom.aiSidebarConvTitle.innerText = this.currentConversation.title
        }

        this.clearMessagesUI()
        this.app?.showToast?.(t('aiSidebar.toastNewSession'), 'success')
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
                <div style="font-weight: 600; color: var(--text-main); margin-bottom: 4px;">${t('aiSidebar.welcomeHeading')}</div>
                <div>${t('aiSidebar.welcomeDesc')}</div>
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
                contextLabel = t('aiSidebar.msgContextAttached', { count: msg.contextSnapshot.tokenCount })
            } else if (msg.contextReason) {
                contextLabel = t('aiSidebar.msgContextPrefix', { reason: msg.contextReason })
            } else if (isUser) {
                contextLabel = t('aiSidebar.msgContextNone')
            }
            const contextInfo = contextLabel
                ? `<div style="font-size: 0.68rem; color: ${msg.contextSnapshot?.tokenCount > 0 ? 'var(--accent-primary, #da7756)' : 'var(--text-muted)'}; margin-top: 3px;">${escapeUntrustedHtml(contextLabel)}</div>`
                : ''
            refHtml = `
                <div class="ai-message-ref-card" title="${t('aiSidebar.refCardLocateTitle')}">
                    <div style="font-size: 0.7rem; font-weight: 600; color: var(--accent-primary, #da7756);">${t('aiSidebar.refCardLabel')}${chapterMeta}</div>
                    <div>“${escapeUntrustedHtml(shortText)}”</div>
                    ${contextInfo}
                </div>
            `
        }

        const formattedContent = msg.content ? renderSafeMarkdown(msg.content) : (isUser ? '' : `<span style="color: var(--text-muted);">${t('aiSidebar.statusThinking')}</span>`)

        let actionsHtml = ''
        if (!isUser && (msg.status === 'completed' || (msg.status === 'partial' && msg.content))) {
            const continueAction = msg.status === 'partial' || msg.finishReason === 'length' || msg.finishReason === 'max_tokens'
                ? `<button type="button" class="ai-msg-action-btn btn-msg-continue" title="${t('aiSidebar.continueTitle')}">${t('aiSidebar.continueBtn')}</button>`
                : ''
            actionsHtml = `
                <div class="ai-msg-actions">
                    <button type="button" class="ai-msg-action-btn btn-msg-copy" title="${t('aiSidebar.copyTitle')}">${t('common.copy')}</button>
                    ${msg.status === 'completed' ? `<button type="button" class="ai-msg-action-btn btn-msg-save-note" title="${t('aiSidebar.saveNoteTitle')}">${t('aiSidebar.saveNoteBtn')}</button>` : ''}
                    ${continueAction}
                </div>
            `
        }

        const usageText = msg.usage?.total_tokens ? `${msg.usage.total_tokens} tokens` : ''
        const timeStr = new Date(msg.createdAt || Date.now()).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })

        el.innerHTML = `
            ${refHtml}
            <div class="ai-msg-bubble">
                <div class="ai-msg-content">${formattedContent}</div>
            </div>
            <div class="ai-msg-meta-bar">
                <span>${timeStr} ${usageText ? `· ${escapeUntrustedHtml(usageText)}` : ''}${msg.status === 'partial' || msg.finishReason === 'length' || msg.finishReason === 'max_tokens' ? t('aiSidebar.partialTag') : ''}</span>
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
            this.dom.aiChatInput.value = t('aiSidebar.continueDraftPrompt')
            this.dom.aiChatInput.focus()
        })

        const btnCopy = msgElement.querySelector('.btn-msg-copy')
        btnCopy?.addEventListener('click', () => {
            if (msg.content) {
                navigator.clipboard.writeText(msg.content).then(() => {
                    this.app?.showToast?.(t('aiSidebar.toastCopied'), 'success')
                })
            }
        })

        const btnSaveNote = msgElement.querySelector('.btn-msg-save-note')
        btnSaveNote?.addEventListener('click', async () => {
            if (msg.status !== 'completed' || !msg.content) {
                this.app?.showToast?.(t('aiSidebar.toastNothingToSave'), 'warning')
                return
            }

            const ref = msg.referenceSnapshot
            if (!ref || (!ref.cfi && !ref.pdfTarget)) {
                navigator.clipboard.writeText(msg.content).then(() => {
                    this.app?.showToast?.(t('aiSidebar.toastNoAnchorCopied'), 'info')
                })
                return
            }

            try {
                if (this.app?.createHighlight) {
                    await this.app.createHighlight('#3b82f6', 'highlight', `${t('aiSidebar.noteAiPrefix')}: ${msg.content}`, ref)
                    this.app?.showToast?.(t('aiSidebar.toastSavedAsNote'), 'success')
                }
            } catch (e) {
                this.app?.showToast?.(t('aiSidebar.toastSaveNoteFailed', { error: e.message }), 'warning')
            }
        })
    }

    async jumpToReference(ref) {
        if (!ref) return
        try {
            // Support cross-book navigation if reference belongs to another book
            if (ref.bookId && this.app?.currentBookId && ref.bookId !== this.app.currentBookId) {
                if (typeof this.app.openBook === 'function') {
                    const initLoc = ref.cfi ? { cfi: ref.cfi } : (typeof ref.pageIndex === 'number' ? { type: 'pdf', page: ref.pageIndex + 1, pageIndex: ref.pageIndex, yRatio: typeof ref.yRatio === 'number' ? ref.yRatio : 0 } : null)
                    await this.app.openBook(ref.bookId, initLoc)
                    // Wait briefly for book renderer to mount
                    await new Promise(r => setTimeout(r, 450))
                }
            }
            if (ref.cfi && this.app?.foliateView?.goTo) {
                await this.app.foliateView.goTo(ref.cfi)
                this.app?.showToast?.(t('aiSidebar.toastLocatedRef'), 'info')
                return
            }
            if (typeof ref.pageIndex === 'number') {
                if (this.app?.pdfViewport?.goToPage) {
                    this.app.pdfViewport.goToPage(ref.pageIndex)
                    this.app?.showToast?.(t('aiSidebar.toastLocatedPage', { page: ref.pageIndex + 1 }), 'info')
                    return
                }
                if (typeof this.app?.goToPdfPage === 'function') {
                    this.app.goToPdfPage(ref.pageIndex)
                    this.app?.showToast?.(t('aiSidebar.toastLocatedPage', { page: ref.pageIndex + 1 }), 'info')
                    return
                }
            }
            if (ref.cfi && this.app?.rendition?.display) {
                this.app.rendition.display(ref.cfi)
                this.app?.showToast?.(t('aiSidebar.toastLocatedRef'), 'info')
                return
            }
            this.app?.showToast?.(t('aiSidebar.toastRefUnavailable'), 'warning')
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
        this.dom.modalAiPresets.classList.add('show')
    }

    closePresetsModal() {
        if (!this.dom.modalAiPresets) return
        this.dom.modalAiPresets.classList.remove('show')
        setTimeout(() => {
            if (!this.dom.modalAiPresets.classList.contains('show')) this.dom.modalAiPresets.style.display = 'none'
            this.renderQuickPresets()
        }, 200)
    }

    renderPresetsManagerList() {
        const listContainer = this.dom.aiPresetsList
        if (!listContainer) return

        const maxNameLen = isEnglish() ? 24 : 12
        if (this.dom.inputNewPresetName) {
            this.dom.inputNewPresetName.maxLength = maxNameLen
        }

        const all = getAiPresets()
        const enabledCount = all.filter(p => p.enabled).length
        if (this.dom.aiPresetsQuotaBadge) {
            this.dom.aiPresetsQuotaBadge.innerText = t('aiSidebar.presetsQuota', { enabled: enabledCount, max: MAX_ENABLED_PRESETS })
        }

        listContainer.innerHTML = ''

        all.forEach(preset => {
            const card = document.createElement('div')
            card.className = `ai-preset-item-card ${preset.enabled ? 'is-active' : ''}`

            const switchHtml = `
                <label class="toggle-switch" title="${t('aiSidebar.toggleEnableTitle')}">
                    <input type="checkbox" class="chk-preset-enable" ${preset.enabled ? 'checked' : ''} />
                    <span class="toggle-slider"></span>
                </label>
            `

            const deleteHtml = preset.builtIn
                ? `<button type="button" class="btn-ai-text-action btn-restore-default">${t('aiSidebar.restoreDefaultBtn')}</button>`
                : `<button type="button" class="btn-ai-text-action btn-ai-danger btn-delete-preset">${t('common.delete')}</button>`

            card.innerHTML = `
                <div class="ai-preset-card-inner">
                    <div class="ai-preset-card-top">
                        <div class="ai-preset-card-title-group">
                            <input type="text" class="global-modal-input input-preset-name" value="${escapeUntrustedHtml(preset.name)}" maxlength="${maxNameLen}" />
                            ${preset.builtIn ? `<span class="ai-preset-built-in">${t('aiSidebar.builtInBadge')}</span>` : ''}
                        </div>
                        <div class="ai-preset-card-controls">
                            ${deleteHtml}
                            ${switchHtml}
                        </div>
                    </div>
                    <textarea class="global-modal-input input-preset-prompt ai-preset-prompt-input" rows="2">${escapeUntrustedHtml(preset.prompt)}</textarea>
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
            this.app?.showToast?.(res.message || t('aiSidebar.toastCreatePresetFailed'), 'warning')
        }
    }

    openReplacePresetModal(targetToEnable) {
        if (!this.dom.modalAiReplacePreset || !targetToEnable) return
        const freshTarget = getAiPresets().find(p => p.id === targetToEnable.id) || targetToEnable
        this._pendingReplacePresetId = freshTarget.id
        this._pendingReplacePreset = freshTarget

        const container = this.dom.aiReplaceOptionsList
        if (container) {
            container.innerHTML = ''
            const enabled = getEnabledPresets()
            enabled.forEach(p => {
                const optBtn = document.createElement('button')
                optBtn.type = 'button'
                optBtn.className = 'btn-replace-preset-option'
                optBtn.innerHTML = `<span class="replace-preset-option-copy">${t('aiSidebar.replaceOptionHtml', { disableName: escapeUntrustedHtml(p.name), enableName: escapeUntrustedHtml(freshTarget.name) })}</span><span class="replace-preset-option-arrow" aria-hidden="true">→</span>`

                optBtn.addEventListener('click', () => {
                    replaceEnabledPreset(p.id, freshTarget.id)
                    this.closeReplacePresetModal()
                    this.renderPresetsManagerList()
                    this.app?.showToast?.(t('aiSidebar.toastPresetReplaced', { name: freshTarget.name }), 'success')
                })

                container.appendChild(optBtn)
            })
        }

        this.dom.modalAiReplacePreset.style.display = 'flex'
        this.dom.modalAiReplacePreset.classList.add('show')
    }

    closeReplacePresetModal() {
        this._pendingReplacePresetId = null
        this._pendingReplacePreset = null
        if (!this.dom.modalAiReplacePreset) return
        this.dom.modalAiReplacePreset.classList.remove('show')
        setTimeout(() => {
            if (!this.dom.modalAiReplacePreset.classList.contains('show')) this.dom.modalAiReplacePreset.style.display = 'none'
        }, 200)
    }

    // =========================================================================
    // History Modal & Persistence Navigation
    // =========================================================================

    async openHistoryModal() {
        if (!this.dom.modalAiHistory) return
        this.dom.modalAiHistory.style.display = 'flex'
        this.dom.modalAiHistory.classList.add('show')

        await this.loadAllHistoryConversations()
    }

    closeHistoryModal() {
        if (!this.dom.modalAiHistory) return
        this.dom.modalAiHistory.classList.remove('show')
        setTimeout(() => {
            if (!this.dom.modalAiHistory.classList.contains('show')) this.dom.modalAiHistory.style.display = 'none'
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
            container.innerHTML = `<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; margin-top: 30px;">${t('aiSidebar.historyModalEmpty')}</div>`
            return
        }

        conversations.forEach(conv => {
            const item = document.createElement('button')
            item.type = 'button'
            item.className = 'ai-history-conv-card ai-history-item'
            if (conv.id === this._selectedHistoryConvId) item.classList.add('active')
            item.dataset.convId = conv.id

            const dateStr = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString(getLocale())
            item.innerHTML = `
                <div class="ai-history-card-title">${escapeUntrustedHtml(this.formatLocalizedConversationTitle(conv))}</div>
                <div class="ai-history-card-meta">
                    <span class="ai-history-card-book">${escapeUntrustedHtml(this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.unspecifiedBook'))}</span>
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

        if (this.dom.aiHistoryActiveTitle) this.dom.aiHistoryActiveTitle.innerText = this.formatLocalizedConversationTitle(conv)
        if (this.dom.aiHistoryActiveMeta) {
            const dateStr = new Date(conv.createdAt || Date.now()).toLocaleString(getLocale())
            const bookLabel = conv.bookTitle ? this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.unspecifiedBook') : ''
            this.dom.aiHistoryActiveMeta.innerText = t('aiSidebar.createdAtMeta', { book: bookLabel, date: dateStr })
        }

        if (this.dom.btnHistoryJumpBook) this.dom.btnHistoryJumpBook.style.display = conv.bookId && conv.bookId !== 'general' ? 'inline-flex' : 'none'
        if (this.dom.btnHistoryExportMd) this.dom.btnHistoryExportMd.style.display = 'inline-flex'
        if (this.dom.btnHistoryDeleteConv) this.dom.btnHistoryDeleteConv.style.display = 'inline-flex'

        // Highlight selected
        const items = this.dom.aiHistoryConversationsList?.querySelectorAll('.ai-history-item')
        items?.forEach(el => {
            el.classList.toggle('active', el.dataset.convId === convId)
        })

        // Render messages with unified annotated-paper renderer
        const msgs = await getAiMessages(convId)
        this.renderDesktopAnnotatedMessages(this.dom.aiHistoryMessagesView, msgs, conv, 'none')
    }

    async flushActiveStreamingMessage() {
        if (!this.isGenerating || !this._activeAssistantMsg) return
        const msg = this._activeAssistantMsg
        if (msg.content && msg.content.trim()) {
            msg.status = 'partial'
            try {
                await saveAiMessage(msg)
            } catch (e) {
                console.warn('[AiSidebar] Error flushing active streaming message:', e)
            }
        }
    }

    async handleHistoryJumpToBook(convId, referenceOverride = null) {
        const targetId = convId || this._selectedHistoryConvId || this._selectedWorkspaceConvId
        const conv = await getAiConversation(targetId)
        if (!conv || !conv.bookId || conv.bookId === 'general') {
            this.app?.showToast?.(t('aiSidebar.toastNoLinkedBook'), 'info')
            return
        }

        this.closeHistoryModal()

        // Get messages to find the first referenceSnapshot if available
        const msgs = await getAiMessages(conv.id)
        const refWithAnchor = msgs?.find(m => m.referenceSnapshot && (m.referenceSnapshot.cfi || m.referenceSnapshot.pageIndex != null))?.referenceSnapshot
        const refToUse = referenceOverride || refWithAnchor || { bookId: conv.bookId, cfi: conv.cfi }
        refToUse.bookId = conv.bookId

        const initialLoc = refToUse.cfi || (typeof refToUse.pageIndex === 'number' ? refToUse.pageIndex : null)
        if (typeof this.app?.openBook === 'function') {
            await this.app.openBook(conv.bookId, initialLoc)
            // If the book was opened in-place in the current window:
            if (this.app.currentBookId === conv.bookId) {
                let attempts = 0
                while (attempts < 10 && (!this.app.foliateView && !this.app.pdfViewport)) {
                    await new Promise(r => setTimeout(r, 100))
                    attempts++
                }
                if (refToUse.cfi || refToUse.pageIndex != null) {
                    await this.jumpToReference(refToUse)
                } else {
                    this.app?.showToast?.(t('aiSidebar.toastOpenedBook', { title: conv.bookTitle || '' }), 'success')
                }
            } else {
                // Book was opened or focused in satellite window; initialLoc already dispatched via openBook
                this.app?.showToast?.(t('aiSidebar.toastFocusedBook', { title: conv.bookTitle || '' }), 'book')
            }
        }
    }

    async handleHistoryExportMarkdown(convId) {
        const targetId = convId || this._selectedHistoryConvId || this._selectedWorkspaceConvId
        const conv = await getAiConversation(targetId)
        if (!conv) return

        const msgs = await getAiMessages(conv.id)
        let md = `# ${conv.title || t('aiSidebar.exportDefaultHeading')}\n\n`
        md += `- ${t('aiSidebar.exportBookLabel')}: ${conv.bookTitle || t('aiSidebar.auditStatusUnknown')}\n`
        md += `- ${t('aiSidebar.exportTimeLabel')}: ${new Date().toLocaleString(getLocale())}\n\n---\n\n`

        msgs.forEach((m, idx) => {
            if (m.role === 'user') {
                md += `### Q${Math.floor(idx / 2) + 1}: ${m.content}\n\n`
                if (m.referenceSnapshot?.selectedText) {
                    md += `> ${t('aiSidebar.exportQuoteLabel')}: ${m.referenceSnapshot.selectedText}\n\n`
                }
            } else {
                md += `${m.content}\n\n`
            }
        })

        // Download markdown file
        const filename = `${t('aiSidebar.exportFilePrefix')}_${(conv.title || 'conversation').replace(/[\\/:*?"<>|]/g, '_')}.md`
        const res = await platformBridge.exportTextFile(filename, md, 'text/markdown;charset=utf-8')
        if (res?.cancelled) {
            return
        }
        if (res.success) {
            if (res.filePath) {
                this.app?.showToast?.(t('aiSidebar.toastExportedPath', { path: res.filePath }), 'success', 4500)
            } else {
                this.app?.showToast?.(t('aiSidebar.toastExportedDir', { dir: res.directoryHint, filename: res.filename }), 'success', 4500)
            }
        } else {
            this.app?.showToast?.(t('aiSidebar.toastExportFailed', { error: res.error || t('aiSidebar.unknownError') }), 'warning')
        }
    }

    async handleHistoryDeleteActive(convId, isWorkspace = false) {
        const targetId = convId || (isWorkspace ? this._selectedWorkspaceConvId : this._selectedHistoryConvId)
        if (!targetId) return
        const conv = await getAiConversation(targetId)
        const titleStr = conv?.title ? `"${conv.title}"` : t('aiSidebar.thisSession')
        if (confirm(t('aiSidebar.confirmDeleteConv', { title: titleStr }))) {
            await deleteAiConversation(targetId)
            this.app?.showToast?.(t('aiSidebar.toastConvDeleted'), 'info')
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
        if (confirm(t('aiSidebar.confirmClearAllHistory'))) {
            await clearAllAiHistory()
            this.app?.showToast?.(t('aiSidebar.toastClearedAllHistory'), 'info')
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
                this.dom.aiHistoryTotalCount.innerText = t('aiSidebar.workspaceTotalCount', { count: this._cachedWorkspaceList.length })
            }

            this.renderWorkspaceConversationsList(this._cachedWorkspaceList)

            this.syncMobileHistoryNavigation()
            if (this.isMobileHistoryWorkspace()) {
                const inDetail = document.querySelector('.ai-history-split-pane')?.classList.contains('show-detail')
                if (inDetail && this._cachedWorkspaceList.some(c => c.id === this._selectedWorkspaceConvId)) {
                    await this.selectWorkspaceConversation(this._selectedWorkspaceConvId)
                } else {
                    document.querySelector('.ai-history-split-pane')?.classList.remove('show-detail')
                }
                return
            }
            if (this._cachedWorkspaceList.length > 0) {
                const stillExists = this._selectedWorkspaceConvId && this._cachedWorkspaceList.some(c => c.id === this._selectedWorkspaceConvId)
                const targetId = stillExists ? this._selectedWorkspaceConvId : this._cachedWorkspaceList[0].id
                await this.selectWorkspaceConversation(targetId)
            } else {
                this._selectedWorkspaceConvId = null
                if (this.dom.aiHistoryPageTitle) this.dom.aiHistoryPageTitle.innerText = t('aiSidebar.workspaceEmptyTitle')
                if (this.dom.aiHistoryPageMeta) this.dom.aiHistoryPageMeta.innerText = ''
                if (this.dom.btnHistoryPageJumpBook) this.dom.btnHistoryPageJumpBook.style.display = 'none'
                if (this.dom.btnHistoryPageExportMd) this.dom.btnHistoryPageExportMd.style.display = 'none'
                if (this.dom.btnHistoryPageDeleteConv) this.dom.btnHistoryPageDeleteConv.style.display = 'none'
                if (this.dom.aiHistoryPageMessagesList) {
                    this.dom.aiHistoryPageMessagesList.innerHTML = `
                        <div class="ai-history-empty-placeholder">
                            <svg class="icon icon-lg" viewBox="0 0 24 24" style="color: var(--text-muted); opacity: 0.5;"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                            <p style="color: var(--text-muted); font-size: 0.88rem; margin-top: 10px;">${t('aiSidebar.workspaceEmptyDesc')}</p>
                        </div>
                    `
                }
            }
        } catch (err) {
            console.error('[AI History] Failed to load history conversations:', err)
            this._cachedWorkspaceList = []
            if (this.dom.aiHistoryTotalCount) {
                this.dom.aiHistoryTotalCount.innerText = t('aiSidebar.workspaceLoadFailedTitle')
            }
            if (this.dom.aiHistoryPageConvList) {
                this.dom.aiHistoryPageConvList.innerHTML = `<div style="padding: 20px; font-size: 0.85rem; color: #ef4444; text-align: center;">${t('aiSidebar.workspaceLoadFailedMsg', { error: escapeUntrustedHtml(err?.message || t('aiSidebar.unknownError')) })}</div>`
            }
            if (this.dom.aiHistoryPageMessagesList) {
                this.dom.aiHistoryPageMessagesList.innerHTML = `<div class="ai-history-empty-placeholder"><p style="color: #ef4444; font-size: 0.88rem;">${t('aiSidebar.workspaceMessagesError')}</p></div>`
            }
        }
    }

    async filterWorkspaceHistoryList() {
        const generation = this._workspaceFilterGeneration = (this._workspaceFilterGeneration || 0) + 1
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

        // P07: Cache searchable text for conversations to prevent N database reads on each keystroke
        if (!this._convSearchTextCache) {
            this._convSearchTextCache = new Map()
        }
        const candidates = this._cachedWorkspaceList.filter(c => !directMatches.has(c.id))
        const deepMatches = []
        const missing = []

        for (const conv of candidates) {
            const cached = this._convSearchTextCache.get(conv.id)
            const curTime = conv.updatedAt || conv.createdAt || 0
            if (cached && cached.updatedAt === curTime) {
                if (cached.text.includes(query)) {
                    deepMatches.push(conv)
                }
            } else {
                missing.push(conv)
            }
        }

        for (let i = 0; i < missing.length; i += 4) {
            if (generation !== this._workspaceFilterGeneration) return
            const matches = await Promise.all(missing.slice(i, i + 4).map(async conv => {
                try {
                    const msgs = await getAiMessages(conv.id)
                    const fullText = msgs.map(m => `${m.content || ''} ${m.quoteText || ''} ${m.referenceSnapshot?.selectedText || ''}`).join(' ').toLowerCase()
                    if (this._convSearchTextCache.size > 500) {
                        const firstKey = this._convSearchTextCache.keys().next().value
                        this._convSearchTextCache.delete(firstKey)
                    }
                    this._convSearchTextCache.set(conv.id, {
                        text: fullText,
                        updatedAt: conv.updatedAt || conv.createdAt || 0
                    })
                    return fullText.includes(query) ? conv : null
                } catch { return null }
            }))
            deepMatches.push(...matches.filter(Boolean))
        }
        if (generation !== this._workspaceFilterGeneration) return
        const combined = [...filtered, ...deepMatches]
        this.renderWorkspaceConversationsList(combined)
    }

    renderWorkspaceConversationsList(conversations) {
        const container = this.dom.aiHistoryPageConvList
        if (!container) return

        container.innerHTML = ''
        if (!conversations || conversations.length === 0) {
            container.innerHTML = `<div style="font-size: 0.82rem; color: var(--text-muted); text-align: center; margin-top: 30px;">${t('aiSidebar.workspaceNoMatch')}</div>`
            return
        }

        if (this.isMobileHistoryWorkspace()) {
            this.renderMobileWorkspaceConversations(conversations, container)
            return
        }
        conversations.forEach(conv => {
            const card = document.createElement('div')
            card.className = 'ai-history-conv-card'
            if (conv.id === this._selectedWorkspaceConvId) {
                card.classList.add('active')
            }
            card.dataset.convId = conv.id

            const dateStr = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleDateString(getLocale())
            card.innerHTML = `
                <div class="ai-history-card-title">${escapeUntrustedHtml(this.formatLocalizedConversationTitle(conv))}</div>
                <div class="ai-history-card-meta">
                    <span class="ai-history-card-book">${escapeUntrustedHtml(this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.unspecifiedBook'))}</span>
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
        document.querySelector('.ai-history-split-pane')?.classList.add('show-detail')

        const msgs = await getAiMessages(convId)
        if (generation !== this._selectWorkspaceConvGeneration) return

        if (this.dom.aiHistoryPageTitle) {
            this.dom.aiHistoryPageTitle.innerText = this.formatLocalizedConversationTitle(conv)
        }
        if (this.dom.aiHistoryPageMeta) {
            const dateStr = new Date(conv.createdAt || Date.now()).toLocaleString(getLocale())
            this.dom.aiHistoryPageMeta.innerText = t('aiSidebar.workspaceActiveMeta', { book: this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.workspaceUnlinkedBook'), count: msgs?.length || 0, date: dateStr })
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
        this.syncMobileHistoryNavigation()
    }

    renderWorkspaceMessages(msgs, conv) {
        this._workspaceMessages = msgs
        this._workspaceConversation = conv
        if (this.isMobileHistoryWorkspace()) {
            this.renderMobileWorkspaceMessages(msgs, conv)
            return
        }
        this.renderDesktopAnnotatedMessages(this.dom.aiHistoryPageMessagesList, msgs, conv, '640px')
    }

    renderDesktopAnnotatedMessages(view, msgs, conv, maxRowWidth = '640px') {
        if (!view) return

        view.innerHTML = ''
        if (!msgs || msgs.length === 0) {
            view.innerHTML = `<div style="color: var(--text-muted); font-size: 0.84rem; text-align: center; margin-top: 40px;">${t('aiSidebar.sessionNoMessages')}</div>`
            return
        }

        // Group source excerpt once cleanly at top of the reading sheet (accepting both selectedText & quote)
        const getRefText = m => m?.referenceSnapshot?.selectedText || m?.referenceSnapshot?.quote || ''
        const getRefChapter = m => m?.referenceSnapshot?.chapterOrPage || m?.referenceSnapshot?.chapterTitle || m?.referenceSnapshot?.locationLabel || ''
        const primaryRefMsg = msgs.find(m => getRefText(m))
        let turnNum = 0
        const renderedQuotes = new Set()

        if (primaryRefMsg) {
            const text = getRefText(primaryRefMsg)
            renderedQuotes.add(text)
            const isLong = text.length > 140
            const chapterLabel = getRefChapter(primaryRefMsg)
            const sourceEl = document.createElement('div')
            sourceEl.className = `ai-history-source-passage`
            sourceEl.innerHTML = `
                <div class="ai-history-quote-box ${isLong ? 'collapsed' : ''}">
                    <div class="ai-history-quote-text">${escapeUntrustedHtml(text)}</div>
                    ${chapterLabel ? `<div class="ai-history-quote-cite">—— ${escapeUntrustedHtml(this.formatLocalizedConversationBookTitle(conv?.bookTitle, 'aiSidebar.unspecifiedBook'))} · ${escapeUntrustedHtml(chapterLabel)}</div>` : ''}
                    ${isLong ? `<button type="button" class="ai-history-quote-expand-btn">${escapeUntrustedHtml(t('aiSidebar.expandFullTextBtn'))}</button>` : ''}
                </div>
            `
            const expandBtn = sourceEl.querySelector('.ai-history-quote-expand-btn')
            if (expandBtn) {
                const quoteBox = sourceEl.querySelector('.ai-history-quote-box')
                expandBtn.addEventListener('click', e => {
                    e.stopPropagation()
                    const collapsed = quoteBox.classList.toggle('collapsed')
                    expandBtn.innerText = collapsed ? t('aiSidebar.expandFullTextBtn') : t('aiSidebar.collapseRefBtn')
                })
            }
            view.appendChild(sourceEl)
        }

        msgs.forEach(msg => {
            const isUser = msg.role === 'user'
            if (isUser) turnNum++

            const msgQuote = getRefText(msg)
            if (msgQuote && !renderedQuotes.has(msgQuote)) {
                renderedQuotes.add(msgQuote)
                const ch = getRefChapter(msg)
                const subRef = document.createElement('div')
                subRef.className = 'ai-history-quote-box is-inline-ref'
                subRef.innerHTML = `<div class="ai-history-quote-text">${escapeUntrustedHtml(msgQuote)}</div>${ch ? `<div class="ai-history-quote-cite">—— ${escapeUntrustedHtml(ch)}</div>` : ''}`
                view.appendChild(subRef)
            }

            const msgEl = document.createElement('div')
            msgEl.className = `ai-message desktop-history-turn-row ${isUser ? 'ai-message-user' : 'ai-message-assistant'}`
            if (maxRowWidth) msgEl.style.maxWidth = maxRowWidth

            const roleLabel = escapeUntrustedHtml(t(isUser ? 'aiHistory.mobileQuestion' : 'aiHistory.mobileAnswer'))
            const modelLine = !isUser && msg.model
                ? `<div class="desktop-history-answer-meta"><span>${escapeUntrustedHtml(msg.model)}${msg.usage?.total_tokens ? ` · ${msg.usage.total_tokens} tokens` : ''}</span><button type="button" class="desktop-history-copy-btn">${escapeUntrustedHtml(t('common.copy'))}</button></div>`
                : ''
            const roundBadge = isUser ? `<span class="desktop-history-round-label">${escapeUntrustedHtml(isEnglish() ? `Round ${turnNum}` : `第 ${turnNum} 轮`)}</span>` : ''

            msgEl.innerHTML = `
                <span class="desktop-history-role ${isUser ? 'is-q' : 'is-a'}">${roleLabel}</span>
                <div class="desktop-history-body">
                    ${roundBadge}
                    <div class="ai-msg-bubble">
                        <div class="ai-msg-content">${renderSafeMarkdown(msg.content)}</div>
                    </div>
                    ${modelLine}
                </div>
            `

            const copyBtn = msgEl.querySelector('.desktop-history-copy-btn')
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard?.writeText?.(msg.content || '').catch(() => {})
                    this.app?.showToast?.(t('common.copied'), 'success')
                })
            }

            view.appendChild(msgEl)
        })
    }

    isMobileHistoryWorkspace() {
        return document.documentElement.classList.contains('is-mobile-viewport')
    }

    syncMobileHistoryNavigation() {
        const header = document.getElementById('mobile-subview-header')
        if (!header || !this.isMobileHistoryWorkspace()) return
        let more = document.getElementById('btn-mobile-history-options')
        if (!more) {
            more = document.createElement('button')
            more.type = 'button'
            more.id = 'btn-mobile-history-options'
            more.className = 'mobile-history-icon-button'
            more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
            more.addEventListener('click', () => this.openMobileHistoryActions())
            header.appendChild(more)
        }
        more.setAttribute('aria-label', t('aiHistory.mobileRecordMenu'))
        more.title = t('aiHistory.mobileRecordMenu')
        this.dom.inputAiHistoryPageSearch?.setAttribute('placeholder', t('aiHistory.mobileSearch'))
        this.dom.inputAiHistoryPageSearch?.setAttribute('aria-label', t('aiHistory.mobileSearch'))
    }

    renderMobileWorkspaceConversations(conversations, container) {
        const today = new Date()
        const yesterday = new Date(today)
        yesterday.setDate(yesterday.getDate() - 1)
        const groups = []
        let currentDay = ''
        for (const conv of conversations) {
            const when = new Date(conv.updatedAt || conv.createdAt || Date.now())
            const day = when.toDateString()
            if (day !== currentDay) {
                const label = day === today.toDateString() ? t('aiHistory.mobileToday')
                    : day === yesterday.toDateString() ? t('aiHistory.mobileYesterday')
                    : when.toLocaleDateString(getLocale(), { year: when.getFullYear() !== today.getFullYear() ? 'numeric' : undefined, month: 'long', day: 'numeric' })
                groups.push({ label, items: [] })
                currentDay = day
            }
            groups[groups.length - 1].items.push({ conv, when })
        }

        for (const grp of groups) {
            const header = document.createElement('h2')
            header.className = 'mobile-history-day'
            header.innerHTML = `<span class="mobile-history-day-label">${escapeUntrustedHtml(grp.label)}</span><span class="mobile-history-day-count">${grp.items.length}</span>`
            container.appendChild(header)

            for (const { conv, when } of grp.items) {
                const card = document.createElement('button')
                card.type = 'button'
                card.className = 'ai-history-conv-card mobile-history-record'
                card.dataset.convId = conv.id
                const bookLabel = this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.unspecifiedBook')
                const timeText = when.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
                card.innerHTML = `
                    <span class="mobile-history-record-top">
                        <span class="mobile-history-record-book"><span class="mobile-history-rec-dot" aria-hidden="true"></span>${escapeUntrustedHtml(bookLabel)}</span>
                        <time class="mobile-history-record-time" datetime="${escapeUntrustedHtml(when.toISOString())}">${escapeUntrustedHtml(timeText)}</time>
                    </span>
                    <span class="ai-history-card-title">${escapeUntrustedHtml(this.formatLocalizedConversationTitle(conv))}</span>`
                card.addEventListener('click', () => this.selectWorkspaceConversation(conv.id))
                container.appendChild(card)
            }
        }
    }

    renderMobileWorkspaceMessages(msgs, conv) {
        const view = this.dom.aiHistoryPageMessagesList
        if (!view) return
        view.replaceChildren()
        const messages = msgs || []
        const firstRef = messages.find(m => m.referenceSnapshot?.selectedText)?.referenceSnapshot

        const heading = document.createElement('header')
        heading.className = 'mobile-history-intro'
        heading.innerHTML = `
            <h1 class="mobile-history-book-heading">${escapeUntrustedHtml(this.formatLocalizedConversationBookTitle(conv.bookTitle, 'aiSidebar.workspaceUnlinkedBook'))}</h1>
            <div class="mobile-history-book-label">${firstRef?.chapterOrPage ? escapeUntrustedHtml(firstRef.chapterOrPage) : escapeUntrustedHtml(new Date(conv.createdAt || Date.now()).toLocaleDateString(getLocale()))}</div>`
        view.appendChild(heading)

        const totalRounds = Math.max(messages.filter(m => m.role === 'user').length, 1)
        let roundNum = 0
        let lastReference = ''
        let dialogueSectionCreated = false

        for (const msg of messages) {
            const ref = msg.referenceSnapshot
            const signature = ref?.selectedText ? JSON.stringify([ref.selectedText, ref.chapterOrPage || '', ref.cfi || '', ref.pageIndex ?? null]) : ''
            if (signature && signature !== lastReference) {
                const source = this.createMobileHistorySource(ref, conv)
                view.appendChild(source)
                lastReference = signature
            }
            if (!dialogueSectionCreated) {
                const secHead = document.createElement('div')
                secHead.className = 'mobile-history-sec-bar'
                secHead.innerHTML = `<span class="mobile-history-sec-label">${escapeUntrustedHtml(t('aiHistory.mobileRounds', { count: totalRounds }))}</span>`
                view.appendChild(secHead)
                dialogueSectionCreated = true
            }

            const isUser = msg.role === 'user'
            if (isUser) roundNum += 1
            const article = document.createElement('article')
            article.className = `mobile-history-message ${isUser ? 'is-question' : 'is-answer'}`
            article.dataset.msgId = msg.id

            if (isUser) {
                article.innerHTML = `
                    <div class="mobile-history-turn-head">
                        <span class="mobile-history-role is-q">${escapeUntrustedHtml(t('aiHistory.mobileQuestion'))}</span>
                        <span class="mobile-history-turn-no">${roundNum} / ${totalRounds}</span>
                    </div>
                    <div class="mobile-history-message-body"><div class="ai-msg-content">${renderSafeMarkdown(msg.content)}</div></div>`
            } else {
                const model = msg.model || msg.modelName || conv.model || t('aiHistory.mobileModelUnknown')
                const state = msg.status === 'partial' ? t('aiSidebar.auditStatusPartial')
                    : msg.status === 'cancelled' ? t('aiSidebar.stateCancelled')
                    : msg.status === 'failed' ? t('aiSidebar.auditStatusFailed') : ''
                article.innerHTML = `
                    <div class="mobile-history-message-body">
                        <div class="ai-msg-content">${renderSafeMarkdown(msg.content)}</div>
                        ${state ? `<div class="mobile-history-answer-state">${escapeUntrustedHtml(state)}</div>` : ''}
                        <footer class="mobile-history-answer-meta">
                            <span class="mobile-history-attr"><span class="mobile-history-role is-a">${escapeUntrustedHtml(t('aiHistory.mobileAnswer'))}</span><span>${escapeUntrustedHtml(model)}</span></span>
                            <button type="button" class="mobile-history-copy" aria-label="${t('aiSidebar.copyTitle')}" title="${t('aiSidebar.copyTitle')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
                        </footer>
                    </div>`
                article.querySelector('.mobile-history-copy')?.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(msg.content || '')
                        this.app?.showToast?.(t('aiSidebar.toastCopied'), 'success')
                    } catch {
                        this.app?.showToast?.(t('app.copyFailedToast'), 'warning')
                    }
                })
            }
            view.appendChild(article)
        }
        if (!messages.length) {
            const empty = document.createElement('p')
            empty.className = 'mobile-history-no-messages'
            empty.textContent = t('aiSidebar.sessionNoMessages')
            view.appendChild(empty)
        }
        view.scrollTop = 0
    }

    createMobileHistorySource(ref, conv) {
        const source = document.createElement('section')
        const isLong = ref.selectedText.length > 140
        source.className = `mobile-history-source${isLong ? ' is-collapsed' : ''}`
        const jumpBtn = (conv.bookId && conv.bookId !== 'general')
            ? `<button type="button" class="mobile-history-jump">${escapeUntrustedHtml(t('aiHistory.mobileBackToText'))} ↗</button>`
            : ''
        source.innerHTML = `
            <div class="mobile-history-sec-bar">
                <span class="mobile-history-sec-label">${escapeUntrustedHtml(t('aiHistory.mobileSource'))}${ref.chapterOrPage ? ` · ${escapeUntrustedHtml(ref.chapterOrPage)}` : ''}</span>
                ${jumpBtn}
            </div>
            <div class="mobile-history-source-body"><blockquote>${escapeUntrustedHtml(ref.selectedText)}</blockquote></div>
            ${isLong ? `<button type="button" class="mobile-history-expand" aria-expanded="false">${escapeUntrustedHtml(t('aiHistory.mobileSourceExpand'))} ↓</button>` : ''}`
        source.querySelector('.mobile-history-jump')?.addEventListener('click', () => this.handleHistoryJumpToBook(conv.id, ref))
        source.querySelector('.mobile-history-expand')?.addEventListener('click', e => {
            const collapsed = source.classList.toggle('is-collapsed')
            e.currentTarget.setAttribute('aria-expanded', String(!collapsed))
            e.currentTarget.textContent = `${t(collapsed ? 'aiHistory.mobileSourceExpand' : 'aiHistory.mobileSourceCollapse')} ${collapsed ? '↓' : '↑'}`
        })
        return source
    }

    openMobileHistoryActions() {
        let dialog = document.getElementById('mobile-history-actions-dialog')
        if (!dialog) {
            dialog = document.createElement('dialog')
            dialog.id = 'mobile-history-actions-dialog'
            dialog.setAttribute('aria-labelledby', 'mobile-history-actions-title')
            dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() })
            document.body.appendChild(dialog)
        }
        const inDetail = document.querySelector('.ai-history-split-pane')?.classList.contains('show-detail')
        dialog.innerHTML = `<div class="mobile-history-sheet-handle" aria-hidden="true"></div><div class="mobile-history-sheet-head"><h2 id="mobile-history-actions-title">${t(inDetail ? 'aiHistory.mobileRecordMenu' : 'aiHistory.mobileListMenu')}</h2><button type="button" data-history-action="close" aria-label="${t('aiHistory.mobileCloseMenu')}">×</button></div>
            ${inDetail ? `<button type="button" data-history-action="export">${t('common.exportMarkdown')}<span aria-hidden="true">↗</span></button><button type="button" class="is-destructive" data-history-action="delete">${t('aiHistory.deleteConvBtn')}</button>` : `<button type="button" class="is-destructive" data-history-action="clear">${t('aiHistory.clearAllBtn')}</button>`}`
        dialog.querySelectorAll('[data-history-action]').forEach(button => button.addEventListener('click', () => {
            const action = button.dataset.historyAction
            dialog.close()
            if (action === 'export') this.handleHistoryExportMarkdown(this._selectedWorkspaceConvId)
            if (action === 'delete') this.handleHistoryDeleteActive(this._selectedWorkspaceConvId, true)
            if (action === 'clear') this.handleClearAllHistory(true)
        }))
        dialog.showModal()
    }


    // =========================================================================
    // Audit Log Modal
    // =========================================================================

    async openAuditModal() {
        if (!this.dom.modalAiAudit) return
        this.dom.modalAiAudit.style.display = 'flex'
        this.dom.modalAiAudit.classList.add('show')

        const entries = await getAiAuditLog(100)
        this.renderAuditTable(entries)
    }

    closeAuditModal() {
        if (!this.dom.modalAiAudit) return
        this.dom.modalAiAudit.classList.remove('show')
        setTimeout(() => {
            if (!this.dom.modalAiAudit.classList.contains('show')) this.dom.modalAiAudit.style.display = 'none'
        }, 200)
    }

    renderAuditTable(entries) {
        const container = this.dom.aiAuditLogTableContainer
        if (!container) return

        if (!entries || entries.length === 0) {
            container.innerHTML = `<div style="font-size: 0.82rem; color: var(--text-muted); text-align: center; padding: 20px;">${t('aiSidebar.auditEmpty')}</div>`
            return
        }

        let rows = ''
        entries.forEach(e => {
            const time = e.timestamp ? e.timestamp.replace('T', ' ').replace('Z', '') : ''
            const localWait = e.status === 'cooldown_blocked' || e.status === 'concurrency_blocked'
            const statusLabels = { completed: t('aiSidebar.auditStatusCompleted'), partial: t('aiSidebar.auditStatusPartial'), cancelled: t('aiSidebar.auditStatusCancelled'), failed: t('aiSidebar.auditStatusFailed'), cooldown_blocked: t('aiSidebar.auditStatusCooldown'), concurrency_blocked: t('aiSidebar.auditStatusConcurrency') }
            const statusLabel = statusLabels[e.status] || e.status || t('aiSidebar.auditStatusUnknown')
            const statusTone = e.status === 'completed' ? 'is-ok' : ((e.status === 'cancelled' || localWait) ? 'is-warn' : 'is-err')
            const totalTok = localWait ? t('aiSidebar.auditNotSent') : (e.totalTokens !== null && e.totalTokens !== undefined ? escapeUntrustedHtml(String(e.totalTokens)) : `<span class="audit-muted-cell">${t('aiSidebar.auditTokenUnknown')}</span>`)

            rows += `
                <tr>
                    <td class="audit-col-time">${escapeUntrustedHtml(time)}</td>
                    <td class="audit-col-model" title="${escapeUntrustedHtml(e.model || '-')}">${escapeUntrustedHtml(e.model || '-')}</td>
                    <td class="audit-col-host" title="${escapeUntrustedHtml(e.endpointHost || '-')}">${escapeUntrustedHtml(e.endpointHost || '-')}</td>
                    <td class="audit-col-status" title="${escapeUntrustedHtml(e.errorMessage || '')}"><span class="audit-status-pill ${statusTone}"><span class="audit-status-dot" aria-hidden="true"></span>${escapeUntrustedHtml(statusLabel)}</span></td>
                    <td class="audit-col-tokens">${totalTok}</td>
                    <td class="audit-col-latency">${escapeUntrustedHtml(String(e.durationMs ?? 0))}ms</td>
                </tr>
            `
        })

        container.innerHTML = `
            <table class="ai-audit-table">
                <thead>
                    <tr>
                        <th class="audit-col-time">${t('aiSidebar.auditColTime')}</th>
                        <th class="audit-col-model">${t('aiSidebar.auditColModel')}</th>
                        <th class="audit-col-host">${t('aiSidebar.auditColHost')}</th>
                        <th class="audit-col-status">${t('aiSidebar.auditColStatus')}</th>
                        <th class="audit-col-tokens">${t('aiSidebar.auditColTokens')}</th>
                        <th class="audit-col-latency">${t('aiSidebar.auditColLatency')}</th>
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
        this.app?.showToast?.(t('aiSidebar.toastAuditCleared'), 'info')
        this.renderAuditTable([])
    }

    refreshLocale() {
        try {
            this.renderQuickPresets()
            if (this.dom.aiSidebarConvTitle) {
                const fallbackBookTitle = this.currentConversation
                    ? this.formatLocalizedConversationBookTitle(this.currentConversation.bookTitle)
                    : ''
                this.dom.aiSidebarConvTitle.innerText = this.currentConversation
                    ? this.formatLocalizedConversationTitle(this.currentConversation, fallbackBookTitle)
                    : t('aiSidebar.subTitle')
            }
            if (this.dom.btnAiExpandRef && this.dom.aiPendingRefText) {
                const isExp = this.dom.aiPendingRefText.classList.contains('expanded')
                this.dom.btnAiExpandRef.innerText = isExp ? t('aiSidebar.collapseRefBtn') : t('aiSidebar.quoteExpandBtn')
            }
            if (this.dom.btnAiPreviewContext && this.dom.aiContextPreviewDrawer) {
                const isDrawerHidden = this.dom.aiContextPreviewDrawer.style.display === 'none' || !this.dom.aiContextPreviewDrawer.style.display
                this.dom.btnAiPreviewContext.innerText = isDrawerHidden ? t('aiSidebar.contextPreviewBtn') : t('aiSidebar.hidePreviewBtn')
            }
            this.renderContextPreview()
            if (this.remainingCooldown > 0 && this.dom.aiCooldownIndicator) {
                this.dom.aiCooldownIndicator.innerText = t('aiSidebar.cooldownIndicator', { seconds: this.remainingCooldown })
            }
            if (this.dom.aiChatMessages?.querySelector?.('.ai-welcome-empty')) {
                this.showEmptyWelcome()
            }
            if (this.dom.modalAiPresets && (this.dom.modalAiPresets.classList.contains('show') || this.dom.modalAiPresets.style.display === 'flex')) {
                this.renderPresetsManagerList()
            }
            if (this.dom.modalAiReplacePreset && (this.dom.modalAiReplacePreset.classList.contains('show') || this.dom.modalAiReplacePreset.style.display === 'flex')) {
                const pendingTarget = this._pendingReplacePresetId
                    ? getAiPresets().find(p => p.id === this._pendingReplacePresetId)
                    : this._pendingReplacePreset
                if (pendingTarget) {
                    this.openReplacePresetModal(pendingTarget)
                } else {
                    this.closeReplacePresetModal()
                }
            }
            if (this.dom.modalAiHistory && (this.dom.modalAiHistory.classList.contains('show') || this.dom.modalAiHistory.style.display === 'flex')) {
                this.filterHistoryList()
                const activeConv = this._selectedHistoryConvId && Array.isArray(this._cachedHistoryList)
                    ? this._cachedHistoryList.find(c => c.id === this._selectedHistoryConvId)
                    : null
                if (activeConv) {
                    if (this.dom.aiHistoryActiveTitle) {
                        this.dom.aiHistoryActiveTitle.innerText = this.formatLocalizedConversationTitle(activeConv)
                    }
                    if (this.dom.aiHistoryActiveMeta) {
                        const dateStr = new Date(activeConv.createdAt || Date.now()).toLocaleString(getLocale())
                        const bookLabel = activeConv.bookTitle ? this.formatLocalizedConversationBookTitle(activeConv.bookTitle, 'aiSidebar.unspecifiedBook') : ''
                        this.dom.aiHistoryActiveMeta.innerText = t('aiSidebar.createdAtMeta', { book: bookLabel, date: dateStr })
                    }
                }
            }
            if (this.app?.bookshelf?.shelfCategory === 'ai-history') {
                this.renderHistoryWorkspace()
            }
        } catch (_) {}
    }
}
