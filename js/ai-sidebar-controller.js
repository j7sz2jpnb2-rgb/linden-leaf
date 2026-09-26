/**
 * ai-sidebar-controller.js - Right AI Reading Sidebar, Context & History Controller
 * Part of Linden Leaf AI Reading Assistant (Gemini 2026-09-25)
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

        // Left nav history button
        this.dom.navCatAiHistory?.addEventListener('click', () => this.openHistoryModal())
        this.dom.btnCloseAiHistory?.addEventListener('click', () => this.closeHistoryModal())
        this.dom.btnClearAllAiHistory?.addEventListener('click', () => this.handleClearAllHistory())
        this.dom.inputAiHistorySearch?.addEventListener('input', () => this.filterHistoryList())

        // History modal actions
        this.dom.btnHistoryJumpBook?.addEventListener('click', () => this.handleHistoryJumpToBook())
        this.dom.btnHistoryExportMd?.addEventListener('click', () => this.handleHistoryExportMarkdown())
        this.dom.btnHistoryDeleteConv?.addEventListener('click', () => this.handleHistoryDeleteActive())

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

        const onMouseUp = () => {
            if (this.resizing) {
                this.resizing = false
                resizer.classList.remove('resizing')
                document.body.style.cursor = ''
                window.removeEventListener('mousemove', onMouseMove)
                window.removeEventListener('mouseup', onMouseUp)
                this.relayoutReader()
            }
        }

        resizer.addEventListener('mousedown', (e) => {
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

    openSidebar() {
        if (this.isOpen) return
        this.isOpen = true

        if (this.dom.readerAiSidebar) this.dom.readerAiSidebar.style.display = 'flex'
        if (this.dom.aiSidebarResizer) this.dom.aiSidebarResizer.style.display = 'block'
        if (this.dom.readerView) this.dom.readerView.classList.add('ai-sidebar-open')
        if (this.dom.btnToggleAiSidebar) this.dom.btnToggleAiSidebar.classList.add('active')

        // Ensure we have an active conversation for the current book
        this.ensureActiveConversation()

        // Relayout reader keeping current CFI / PDF page position
        this.relayoutReader()

        // Check native status & cooldown
        this.syncCooldownStatus()
    }

    closeSidebar() {
        if (!this.isOpen) return
        this.isOpen = false

        if (this.dom.readerAiSidebar) this.dom.readerAiSidebar.style.display = 'none'
        if (this.dom.aiSidebarResizer) this.dom.aiSidebarResizer.style.display = 'none'
        if (this.dom.readerView) this.dom.readerView.classList.remove('ai-sidebar-open')
        if (this.dom.btnToggleAiSidebar) this.dom.btnToggleAiSidebar.classList.remove('active')

        // Relayout reader restoring full width
        this.relayoutReader()
    }

    toggleSidebar() {
        if (this.isOpen) {
            this.closeSidebar()
        } else {
            this.openSidebar()
        }
    }

    relayoutReader() {
        // Trigger smooth reflow of Foliate / PDF viewer without losing reading position
        try {
            if (this.app?.foliateView?.renderer) {
                const renderer = this.app.foliateView.renderer
                if (typeof renderer.settle === 'function') {
                    renderer.settle()
                }
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
    openWithSelection(selectionInfo) {
        if (!selectionInfo || !selectionInfo.text) return

        // 1. Create stable, immutable reference snapshot
        const currentBook = this.app?.currentBookData || this.app?.currentBook
        const snapshot = createReferenceSnapshot(currentBook, selectionInfo)
        this.currentReference = snapshot

        // 2. Extract surrounding context within <= 1000 tokens hard budget
        this.currentContext = this.extractContextForSelection(selectionInfo)

        // 3. Open sidebar (no modal, no background blur)
        this.openSidebar()

        // 4. Update pending quote box in sidebar
        this.renderPendingReference()

        // 5. Update context preview
        this.renderContextPreview()

        // 6. Focus input without erasing user draft
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
            maxTokens: budget
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
                    .filter(m => m.status === 'completed' && (m.role === 'user' || m.role === 'assistant'))
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
            const resultText = await requestAiCompletion({
                requestId: this.activeRequestId,
                messages,
                maxTokens: configuredMaxTokens,
                onChunk: (delta, fullText) => {
                    assistantMsg.content = fullText
                    if (contentDiv) {
                        contentDiv.innerHTML = renderSafeMarkdown(fullText)
                    }
                    this.scrollToBottom()
                }
            })

            // Finalize message on success
            assistantMsg.content = resultText
            assistantMsg.status = 'completed'
            await saveAiMessage(assistantMsg)

            if (contentDiv) {
                contentDiv.innerHTML = renderSafeMarkdown(resultText)
            }
            if (metaDiv) {
                const usageLabel = assistantMsg.usage?.total_tokens ? ` · ${assistantMsg.usage.total_tokens} tokens` : ' · Token: 未知'
                metaDiv.innerHTML = `<span>生成完成${usageLabel}</span><div class="ai-msg-actions"><button type="button" class="ai-msg-action-btn btn-msg-copy" title="复制回答">复制</button><button type="button" class="ai-msg-action-btn btn-msg-save-note" title="保存为划线批注">保存为笔记</button></div>`
                this.bindMessageActionButtons(msgElement, assistantMsg)
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = '生成完成'
        } catch (err) {
            const errStr = err?.message || String(err)
            assistantMsg.status = 'failed'
            assistantMsg.errorMessage = errStr
            await saveAiMessage(assistantMsg)

            if (contentDiv) {
                contentDiv.innerHTML = `<span style="color: #ef4444; font-weight: 500;">❌ ${escapeUntrustedHtml(errStr)}</span>`
            }
            if (metaDiv) {
                metaDiv.innerHTML = `<span>请求失败 (草稿已保留)</span>`
            }
            if (this.dom.aiStatusSummary) this.dom.aiStatusSummary.innerText = '请求失败'
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
            const configuredCooldown = this.app?.advancedSettings?.aiCooldownSeconds || this.app?.advancedSettings?.config?.aiCooldownSeconds || 10
            const remaining = Math.max(0, configuredCooldown - elapsedSecs)

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
        if (!isUser && msg.status === 'completed') {
            actionsHtml = `
                <div class="ai-msg-actions">
                    <button type="button" class="ai-msg-action-btn btn-msg-copy" title="复制回答">复制</button>
                    <button type="button" class="ai-msg-action-btn btn-msg-save-note" title="保存为划线批注">保存为笔记</button>
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
                <span>${timeStr} ${usageText ? `· ${usageText}` : ''}</span>
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

    async handleHistoryJumpToBook() {
        const conv = await getAiConversation(this._selectedHistoryConvId)
        if (!conv || !conv.bookId) return

        this.closeHistoryModal()
        if (this.app?.openBook) {
            this.app.openBook(conv.bookId)
        }
    }

    async handleHistoryExportMarkdown() {
        const conv = await getAiConversation(this._selectedHistoryConvId)
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

    async handleHistoryDeleteActive() {
        if (!this._selectedHistoryConvId) return
        if (confirm('确定要删除此会话记录吗？')) {
            await deleteAiConversation(this._selectedHistoryConvId)
            this.app?.showToast?.('会话已删除', 'info')
            await this.loadAllHistoryConversations()
        }
    }

    async handleClearAllHistory() {
        if (confirm('确定要清空本机所有 AI 阅读历史记录吗？此操作无法撤销。')) {
            await clearAllAiHistory()
            this.app?.showToast?.('已清空全部 AI 阅读历史', 'info')
            await this.loadAllHistoryConversations()
        }
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
