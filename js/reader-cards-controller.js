import { DomEvents } from './dom-events.js'
import { t } from './i18n.js'
import { createReferenceSnapshot } from './ai-context.js'
import * as db from './db.js'
import { quoteCard, THEMES } from './quote-card.js'
import { performWebSearch } from './search-config.js'
import { isAiReady, getAiConfig, getAiApiKey, requestAiCompletion, createTranslationPrompt, createExplainPrompt, createQuestionPrompt, renderSafeMarkdown, SYSTEM_PROMPTS } from './reading-ai-assistant.js'
import { resolveExcerptSource } from './excerpt-source-resolver.js'
import { DEFAULT_READER_NAME, escapeHTML } from './ui-format.js'

/** Owns cards UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
const FOOTNOTE_ALLOWED_TAGS = new Set([
    'p', 'br', 'em', 'i', 'strong', 'b', 'sup', 'sub', 'code', 'span', 'blockquote', 'ul', 'ol', 'li', 'a'
])

/**
 * Sanitize an untrusted book footnote DOM subtree into safe rich HTML + plain text.
 * Strips script/iframe/style/event attributes and unsafe javascript:/data: hrefs.
 */
export function sanitizeFootnoteHtml(rootEl) {
    if (!rootEl) return ''
    const doc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null)
    if (!doc) return ''
    const sanitizeNode = (node) => {
        if (!node) return null
        if (node.nodeType === 3) {
            return doc.createTextNode(node.nodeValue || '')
        }
        if (node.nodeType !== 1) return null
        const tag = String(node.tagName || '').toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'svg') {
            return null
        }
        if (!FOOTNOTE_ALLOWED_TAGS.has(tag)) {
            const frag = doc.createDocumentFragment()
            for (const child of Array.from(node.childNodes || [])) {
                const clean = sanitizeNode(child)
                if (clean) frag.appendChild(clean)
            }
            return frag
        }
        if (tag === 'br') return doc.createElement('br')
        const out = doc.createElement(tag)
        if (tag === 'a') {
            const rawHref = (node.getAttribute('href') || '').trim()
            if (/^https?:\/\//i.test(rawHref)) {
                out.setAttribute('href', rawHref)
                out.setAttribute('target', '_blank')
                out.setAttribute('rel', 'noopener noreferrer')
            } else if (rawHref.startsWith('#')) {
                out.setAttribute('href', rawHref)
            }
        }
        for (const child of Array.from(node.childNodes || [])) {
            const clean = sanitizeNode(child)
            if (clean) out.appendChild(clean)
        }
        if (tag === 'p' || tag === 'li' || tag === 'blockquote') {
            if (!out.textContent.trim() && !out.querySelector('br')) return null
        }
        return out
    }
    const wrapper = doc.createElement('div')
    for (const child of Array.from(rootEl.childNodes || [])) {
        const clean = sanitizeNode(child)
        if (clean) wrapper.appendChild(clean)
    }
    return wrapper.innerHTML.trim()
}

export class ReaderCardsController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this._aiReqGeneration = 0
        this._isAiRunning = false
        this._aiAbortController = null
        this._activeAiSnapshot = null
        this._lastCompletedAiText = ''
        this._paraTransAbortController = null
        this._quoteCardToken = 0
        this._quoteCardDebounceTimer = null
        this._quoteCardCloseTimer = null
    }

    initDOM() {
        this.dom = {
            
            quoteCardBackdrop: document.getElementById('quote-card-backdrop'),
            quoteCardDialog: document.getElementById('quote-card-dialog'),
            btnQuoteClose: document.getElementById('btn-quote-close'),
            quoteCanvasWrap: document.getElementById('quote-card-canvas-wrap'),
            quoteThemePicker: document.getElementById('quote-theme-picker'),
            quoteTitleLayoutControl: document.getElementById('quote-title-layout-control'),
            quoteUserNameInput: document.getElementById('quote-user-name-input'),
            quoteTextEditor: document.getElementById('quote-text-editor'),
            btnQuoteResetText: document.getElementById('btn-quote-reset-text'),
            btnQuoteToggleDetails: document.getElementById('btn-quote-toggle-details'),
            quoteDetailsPanel: document.getElementById('quote-details-panel'),
            quoteDetailsChevron: document.getElementById('quote-details-chevron'),
            quoteBookTitleInput: document.getElementById('quote-book-title-input'),
            quoteBookAuthorInput: document.getElementById('quote-book-author-input'),
            quoteChapterTitleInput: document.getElementById('quote-chapter-title-input'),
            quoteLocationInput: document.getElementById('quote-location-input'),
            btnQuoteSaveToShelf: document.getElementById('btn-quote-save-to-shelf'),
            btnQuoteCopyClipboard: document.getElementById('btn-quote-copy-clipboard'),
            btnQuoteDownload: document.getElementById('btn-quote-download'),
            quoteCopyToast: document.getElementById('quote-copy-toast'),
            footnotePopup: document.getElementById('footnote-popup'),
            footnotePopupTitle: document.getElementById('footnote-popup-title'),
            footnotePopupContent: document.getElementById('footnote-popup-content'),
            btnCloseFootnote: document.getElementById('btn-close-footnote'),
            readerDictionaryCard: document.getElementById('reader-dictionary-card'),
            dictCardWord: document.getElementById('dict-card-word'),
            dictCardPhonetic: document.getElementById('dict-card-phonetic'),
            dictCardBody: document.getElementById('dict-card-body'),
            dictCardSource: document.getElementById('dict-card-source'),
            btnCloseDictCard: document.getElementById('btn-close-dict-card'),
            btnDictCopy: document.getElementById('btn-dict-copy'),
            btnDictSearch: document.getElementById('btn-dict-search'),
            btnDictAskAi: document.getElementById('btn-dict-ask-ai'),
            btnDictUnderline: document.getElementById('btn-dict-underline'),
            btnDictNote: document.getElementById('btn-dict-note'),
            btnDictCopyWord: document.getElementById('btn-dict-copy-word'),
            dictColorDots: document.querySelectorAll('.dict-color-dot'),
            readerParaTranslationCard: document.getElementById('reader-para-translation-card'),
            paraTransContent: document.getElementById('para-trans-content'),
            btnParaTransCopy: document.getElementById('btn-para-trans-copy'),
            btnParaTransToAi: document.getElementById('btn-para-trans-to-ai'),
            btnCloseParaTrans: document.getElementById('btn-close-para-trans'),
            modalAiAssistant: document.getElementById('modal-ai-assistant'),
            btnCloseAiAssistant: document.getElementById('btn-close-ai-assistant'),
            aiSelectedPreview: document.getElementById('ai-selected-preview'),
            btnAiTranslate: document.getElementById('btn-ai-translate'),
            btnAiExplain: document.getElementById('btn-ai-explain'),
            inputAiPrompt: document.getElementById('input-ai-prompt'),
            btnAiAsk: document.getElementById('btn-ai-ask'),
            aiResponseArea: document.getElementById('ai-response-area'),
            aiStatusHint: document.getElementById('ai-status-hint'),
            btnAiSaveNote: document.getElementById('btn-ai-save-note'),
            btnAiCopy: document.getElementById('btn-ai-copy')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(this.dom.btnCloseDictCard, 'click', () => {
            this.hideDictionaryCard()
            this.app.annotations?.clearActiveTextSelection?.()
            this.app.annotations?.hideSelectionPopup?.()
        });
        this.dom.dictColorDots?.forEach(dot => {
            this.events.on(dot, 'click', async (e) => {
                e.stopPropagation()
                const color = dot.dataset.color || '#facc15'
                await this.app.annotations.createHighlight(color, 'highlight')
                this.hideDictionaryCard()
            })
        });
        this.events.on(this.dom.btnDictUnderline, 'click', async (e) => {
            e.stopPropagation()
            await this.app.annotations.createHighlight('#2563eb', 'underline')
            this.hideDictionaryCard()
        });
        this.events.on(this.dom.btnDictNote, 'click', (e) => {
            e.stopPropagation()
            this.hideDictionaryCard()
            this.app.annotations?.openNoteComposerForSelection?.({
                title: t('cards.dict.noteTitle')
            })
        });
        this.events.on(this.dom.btnDictCopyWord, 'click', async (e) => {
            e.stopPropagation()
            await this.app.copyMultiSelectionOrSingle()
            this.hideDictionaryCard()
        });
        this.events.on(this.dom.btnDictCopy, 'click', () => {
            if (this._currentDictResult) {
                const text = `${this._currentDictResult.word} ${this._currentDictResult.phonetic || ''}\n` +
                    this._currentDictResult.entries.map(e => `${e.pos} ${e.def}`).join('\n')
                navigator.clipboard?.writeText(text).then(() => {
                    this.app.dialogs.showToast(t('cards.dict.copied'), 'success')
                })
            }
        });
        this.events.on(this.dom.btnDictSearch, 'click', () => {
            const word = this._currentDictResult?.word || this._currentDictResult?.normalizedWord
            this.hideDictionaryCard()
            this.app.annotations?.clearActiveTextSelection?.()
            this.app.annotations?.hideSelectionPopup?.()
            if (word) {
                performWebSearch(this.app.settings, word, (msg, icon) => this.app.dialogs.showToast(msg, icon))
            }
        });
        this.events.on(this.dom.btnDictAskAi, 'click', () => {
            const word = this._currentDictResult?.word || this._currentDictResult?.normalizedWord
            this.hideDictionaryCard()
            this.app.annotations?.clearActiveTextSelection?.()
            this.app.annotations?.hideSelectionPopup?.()
            if (word && this.app.aiSidebar) {
                this.app.aiSidebar.openWithSelection({ text: word, chapterOrPage: t('cards.dict.aiLabel') })
            }
        });
        this.events.on(this.app.appearance.dom.settingDictEnabled, 'change', (e) => {
            this.app.dictionaryService?.setEnabled(e.target.checked)
        });
        this.events.on(this.dom.btnCloseParaTrans, 'click', () => {
            this.hideParaTranslationCard()
            this.app.annotations?.clearActiveTextSelection?.()
            this.app.annotations?.hideSelectionPopup?.()
        });
        this.events.on(this.dom.btnParaTransCopy, 'click', () => {
            if (this._currentParaTranslation) {
                navigator.clipboard?.writeText(this._currentParaTranslation).then(() => {
                    this.app.dialogs.showToast(t('cards.para.copied'), 'success')
                })
            }
        });
        this.events.on(this.dom.btnParaTransToAi, 'click', () => {
            const original = this._currentParaOriginal || ''
            this.hideParaTranslationCard()
            this.app.annotations?.clearActiveTextSelection?.()
            this.app.annotations?.hideSelectionPopup?.()
            if (original && this.app.aiSidebar) {
                this.app.aiSidebar.openWithSelection({ text: original, chapterOrPage: t('cards.para.aiLabel') })
            }
        });
        if (this.dom.dictCardBody) {
            this.events.on(this.dom.dictCardBody, 'click', async (e) => {
                const installBtn = e.target?.closest?.('#btn-dict-install-action')
                if (installBtn) {
                    this.hideDictionaryCard()
                    this.app.annotations.openDrawer('settings')
                    this.app.appearance.switchSettingsDomain('assistant')
                    document.getElementById('adv-group-dictionary')?.scrollIntoView({ block: 'start', behavior: 'auto' })
                    return
                }
                const importBtn = e.target?.closest?.('#btn-dict-import-action, #btn-dict-repair-import')
                if (!importBtn) return
                const isRepair = importBtn.id === 'btn-dict-repair-import'
                try {
                    const status = await this.app.dictionaryService?.pickAndInstallFromFile?.()
                    if (status) {
                        const msg = isRepair
                            ? t('cards.dict.reimported')
                            : t('cards.dict.importedCount', { count: status.wordCount || 0 })
                        this.app.dialogs.showToast(msg, 'success')
                        if (this._lastDictSelectionInfo) this.showDictionaryCard(this._lastDictSelectionInfo)
                    }
                } catch (err) {
                    this.app.dialogs.showToast(
                        isRepair
                            ? t('cards.dict.repairFailed', { error: err.message })
                            : t('cards.dict.importFailed', { error: err.message }),
                        'warning'
                    )
                }
            })
        }
        this.events.on(this.dom.btnQuoteClose, 'click', () => this.closeQuoteCardModal());
        this.events.on(this.dom.quoteCardBackdrop, 'click', e => {
            if (e.target === this.dom.quoteCardBackdrop) this.closeQuoteCardModal()
        });
        this.dom.quoteTitleLayoutControl?.querySelectorAll('.seg-btn').forEach(btn => {
            this.events.on(btn, 'click', () => {
                this.dom.quoteTitleLayoutControl.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'))
                btn.classList.add('active')
                quoteCard.titleLayout = btn.dataset.layout
                this.updateQuoteCardPreview()
            })
        });
        this.events.on(this.dom.quoteUserNameInput, 'input', e => {
            quoteCard.userName = e.target.value.trim() || DEFAULT_READER_NAME
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.quoteTextEditor, 'input', e => {
            quoteCard.quoteText = e.target.value
            if (this.dom.btnQuoteResetText) {
                this.dom.btnQuoteResetText.hidden = e.target.value === (this._originalQuoteText || '')
            }
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.btnQuoteResetText, 'click', () => {
            const orig = this._originalQuoteText || ''
            if (this.dom.quoteTextEditor) this.dom.quoteTextEditor.value = orig
            if (this.dom.btnQuoteResetText) this.dom.btnQuoteResetText.hidden = true
            quoteCard.quoteText = orig
            this.updateQuoteCardPreview()
        });
        this.events.on(this.dom.btnQuoteToggleDetails, 'click', () => {
            const panel = this.dom.quoteDetailsPanel
            if (!panel) return
            const isHidden = panel.style.display === 'none'
            panel.style.display = isHidden ? 'flex' : 'none'
            this.dom.btnQuoteToggleDetails.classList.toggle('active', isHidden)
        });
        this.events.on(this.dom.quoteBookTitleInput, 'input', e => {
            quoteCard.bookTitle = e.target.value.trim()
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.quoteBookAuthorInput, 'input', e => {
            quoteCard.author = e.target.value.trim()
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.quoteChapterTitleInput, 'input', e => {
            quoteCard.chapterTitle = e.target.value.trim()
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.quoteLocationInput, 'input', e => {
            quoteCard.locationInfo = e.target.value.trim()
            this.updateQuoteCardPreview(false)
        });
        this.events.on(this.dom.btnQuoteSaveToShelf, 'click', async () => {
            const targetBookId = this._quoteSourceBookId
            if (!targetBookId) return
            const newTitle = this.dom.quoteBookTitleInput?.value.trim()
            const newAuthor = this.dom.quoteBookAuthorInput?.value.trim() || t('book.unknownAuthor')
            if (!newTitle) return this.app.dialogs.showToast(t('cards.quote.needTitle'), 'info')
            try {
                await db.updateBookMetadata(targetBookId, { title: newTitle, author: newAuthor })
                if (this.app.currentBookId === targetBookId && this.app.currentBookData) {
                    this.app.currentBookData.title = newTitle
                    this.app.currentBookData.author = newAuthor
                }
                if (this.app.currentBookId === targetBookId && this.app.dom.readerBookTitle) {
                    this.app.dom.readerBookTitle.innerText = newTitle
                }
                await this.app.bookshelf.refreshBookshelf()
                this.app.dialogs.showToast(t('cards.quote.bookMetaSaved'), 'success')
            } catch (err) {
                console.error('Failed to update book metadata:', err)
                this.app.dialogs.showToast(t('cards.quote.saveFailed', { error: err.message }), 'warning')
            }
        });
        this.events.on(this.dom.btnQuoteCopyClipboard, 'click', async () => {
            const res = await quoteCard.copyImageToClipboard()
            if (res.success) {
                this.app.dialogs.showToast(t('cards.quote.imgCopied'), 'success')
                if (this.dom.quoteCopyToast) {
                    this.dom.quoteCopyToast.style.display = 'block'
                    setTimeout(() => {
                        if (this.dom.quoteCopyToast) this.dom.quoteCopyToast.style.display = 'none'
                    }, 4000)
                }
            } else {
                this.app.dialogs.showToast(t('cards.quote.copyFailed', { reason: res.error || t('cards.quote.copyPermissionHint') }), 'warning')
            }
        });
        this.events.on(this.dom.btnQuoteDownload, 'click', async () => {
            try {
                const res = await quoteCard.downloadImage()
                if (res?.cancelled) return
                if (res?.saved) {
                    const toastKey = res.method === 'android-gallery'
                        ? 'cards.quote.savedGalleryToast'
                        : 'cards.quote.savedToast'
                    this.app.dialogs.showToast(t(toastKey), 'success')
                }
            } catch (error) {
                this.app.dialogs.showToast(t('cards.quote.exportFailed', { error: error.message || t('cards.quote.retryLater') }), 'warning')
            }
        });
        this.events.on(this.dom.btnCloseFootnote, 'click', () => this.hideFootnotePopup());
        this.events.on(document, 'click', e => {
            if (this.dom.footnotePopup && this.dom.footnotePopup.style.display !== 'none' && !this.dom.footnotePopup.contains(e.target)) {
                this.hideFootnotePopup()
            }
        });
        this.events.on(this.dom.btnCloseAiAssistant, 'click', () => this.closeAiAssistantModal());
        this.events.on(this.dom.modalAiAssistant, 'click', e => {
            if (e.target === this.dom.modalAiAssistant) this.closeAiAssistantModal()
        });
        this.events.on(this.dom.btnAiTranslate, 'click', () => {
            const text = (this._activeAiSnapshot?.selectedText || '').trim()
            if (text) {
                this.runAiRequest(createTranslationPrompt(text), SYSTEM_PROMPTS.translate)
            } else {
                this.app.dialogs.showToast(t('cards.selectTextToTranslate'), 'info')
            }
        });
        this.events.on(this.dom.btnAiExplain, 'click', () => {
            const text = (this._activeAiSnapshot?.selectedText || '').trim()
            if (text) {
                this.runAiRequest(createExplainPrompt(text), SYSTEM_PROMPTS.explain)
            } else {
                this.app.dialogs.showToast(t('cards.selectTextToExplain'), 'info')
            }
        });
        this.events.on(this.dom.btnAiAsk, 'click', () => {
            const q = (this.dom.inputAiPrompt?.value || '').trim()
            const text = (this._activeAiSnapshot?.selectedText || '').trim()
            if (q) {
                this.runAiRequest(createQuestionPrompt(text, q), SYSTEM_PROMPTS.qa)
            }
        });
        this.events.on(this.dom.inputAiPrompt, 'keydown', e => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                const q = (this.dom.inputAiPrompt?.value || '').trim()
                const text = (this._activeAiSnapshot?.selectedText || '').trim()
                if (q) {
                    this.runAiRequest(createQuestionPrompt(text, q), SYSTEM_PROMPTS.qa)
                }
            }
        });
        this.events.on(this.dom.btnAiCopy, 'click', () => {
            const text = this._lastCompletedAiText
            if (!text.trim()) {
                this.app.dialogs.showToast(t('cards.ai.noCopyContent'), 'warning')
                return
            }
            navigator.clipboard.writeText(text).then(() => {
                this.app.dialogs.showToast(t('cards.ai.copied'), 'success')
            }).catch(() => {
                this.app.dialogs.showToast(t('cards.ai.copyFailed'), 'warning')
            })
        });
        this.events.on(this.dom.btnAiSaveNote, 'click', async () => {
            if (!this._lastCompletedAiText) {
                this.app.dialogs.showToast(t('cards.ai.noSaveContent'), 'warning')
                return
            }
            const aiText = this._lastCompletedAiText.trim()
            const ref = this._activeAiSnapshot
            if (!ref || ref.bookId !== this.app.currentBookId) return
            if (ref.cfi || ref.pdfTarget) {
                try {
                    await this.app.annotations.createHighlight('#3b82f6', 'highlight', t('cards.ai.notePrefix', { text: aiText }), ref)
                    if (this._activeAiSnapshot !== ref) return
                    this.app.dialogs.showToast(t('cards.ai.savedHighlight'), 'success')
                    this.closeAiAssistantModal()
                } catch (error) {
                    this.app.dialogs.showToast(t('cards.ai.saveHighlightFailed', { error: error.message || error }), 'warning')
                }
            } else {
                navigator.clipboard.writeText(aiText).then(() => {
                    this.app.dialogs.showToast(t('cards.ai.noAnchorCopied'), 'info')
                })
            }
        });
    }

    resetSessionState() {
        this.hideDictionaryCard()
        this.hideParaTranslationCard()
        this.hideFootnotePopup()
        this.closeAiAssistantModal()
    }

    dispose() { this.resetSessionState(); this.events.dispose(); this._bound = false }

    async showDictionaryCard(selectionInfo) {
        if (!selectionInfo || !selectionInfo.text) return
        const card = this.dom.readerDictionaryCard
        if (!card) return
        this.app.cancelPendingReaderUIToggle()

        this.app.annotations._frozenSelectionSnapshot = { ...selectionInfo }
        this.app.annotations.selectedTextInfo = { ...selectionInfo }

        this._lastDictSelectionInfo = selectionInfo
        const word = selectionInfo.text.trim()
        const lookupGeneration = this._dictionaryLookupGeneration = (this._dictionaryLookupGeneration || 0) + 1
        const ownerBookId = this.app.currentBookId
        const result = this.app.dictionaryService ? await this.app.dictionaryService.lookup(word) : null
        if (lookupGeneration !== this._dictionaryLookupGeneration || ownerBookId !== this.app.currentBookId) return
        this._currentDictResult = result || { word, entries: [], source: t('dict.source.basic') }

        if (this.dom.dictCardWord) this.dom.dictCardWord.innerText = word
        if (this.dom.dictCardPhonetic) this.dom.dictCardPhonetic.innerText = result?.phonetic || ''
        const rawSource = result?.source || t('dict.source.ecdict')
        const cleanSource = rawSource.replace(/\s*[\(（][^）\)]*[\)）]/g, '').trim()
        if (this.dom.dictCardSource) this.dom.dictCardSource.innerText = cleanSource || t('dict.source.ecdict')

        if (this.dom.dictCardBody) {
            if (result && result.notInstalled) {
                this.dom.dictCardBody.innerHTML = `
                    <div class="dict-state-container dict-not-installed" style="padding:4px 0;">
                        <div class="dict-state-title" style="font-weight:600;font-size:13px;margin-bottom:4px;color:var(--text-primary,#111827);">${escapeHTML(t('dict.source.notInstalled'))}</div>
                        <div class="dict-state-desc" style="font-size:12px;color:var(--text-secondary,#6b7280);line-height:1.4;margin-bottom:8px;">${escapeHTML(t('cards.dict.installPromptDesc'))}</div>
                        <div class="dict-state-actions" style="display:flex;gap:6px;flex-wrap:wrap;">
                            <button type="button" class="dict-btn-install btn-primary-action" id="btn-dict-install-action">${escapeHTML(t('cards.dict.manageBtn'))}</button>
                            <button type="button" class="dict-btn-import" id="btn-dict-import-action" style="padding:5px 12px;font-size:12px;background:var(--bg-secondary,#f5f2eb);color:var(--text-primary,#1f1e1b);border:1px solid var(--border-color,#e6e3db);border-radius:8px;cursor:pointer;">${escapeHTML(t('cards.dict.importLocalBtn'))}</button>
                        </div>
                    </div>
                `
            } else if (result && result.corrupted) {
                this.dom.dictCardBody.innerHTML = `
                    <div class="dict-state-container dict-corrupted" style="padding:4px 0;">
                        <div class="dict-state-title" style="font-weight:600;font-size:13px;margin-bottom:4px;color:var(--danger-color,#b91c1c);">${escapeHTML(t('cards.dict.corruptedTitle'))}</div>
                        <div class="dict-state-desc" style="font-size:12px;color:var(--text-secondary,#6e6b65);line-height:1.4;margin-bottom:8px;">${escapeHTML(t('cards.dict.corruptedDesc'))}</div>
                        <div class="dict-state-actions" style="display:flex;gap:6px;margin-top:6px;">
                            <button type="button" class="dict-btn-import" id="btn-dict-repair-import" style="padding:5px 12px;font-size:12px;background:var(--accent-primary,#da7756);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;">${escapeHTML(t('cards.dict.reimportBtn'))}</button>
                        </div>
                    </div>
                `
            } else if (result && result.found && result.entries && result.entries.length > 0) {
                this.dom.dictCardBody.innerHTML = result.entries.map(e => `
                    <div class="dict-entry-row">
                        <span class="dict-pos-tag">${escapeHTML(e.pos || '')}</span>
                        <span class="dict-def-text">${escapeHTML(e.def || '')}</span>
                    </div>
                `).join('')
            } else {
                this.dom.dictCardBody.innerHTML = `<div class="dict-not-found" style="font-size:12px;color:var(--text-secondary,#6b7280);">${escapeHTML(t('cards.dict.notFound'))}</div>`
            }
        }

        // Position card near selection or center with collision flip
        const rect = selectionInfo.rect
        card.style.display = 'flex'
        if (rect && rect.top != null && rect.left != null) {
            const cardWidth = card.offsetWidth || Math.min(290, window.innerWidth - 24)
            const cardHeight = card.offsetHeight || 190
            const rectHeight = rect.height || 24
            const rectBottom = (rect.bottom != null && !isNaN(rect.bottom)) ? rect.bottom : (rect.top + rectHeight)
            const spaceAbove = rect.top

            let top
            // If there is enough room above the word, place card above; otherwise flip below
            if (spaceAbove >= cardHeight + 14) {
                top = rect.top - cardHeight - 10
            } else {
                top = rectBottom + 10
            }
            top = Math.max(10, Math.min(window.innerHeight - cardHeight - 10, top))

            let left = rect.left + ((rect.width || 0) / 2) - (cardWidth / 2)
            left = Math.max(12, Math.min(window.innerWidth - cardWidth - 12, left))

            card.style.transform = 'none'
            card.style.left = `${left}px`
            card.style.top = `${top}px`
        } else {
            card.style.left = '50%'
            card.style.top = '30%'
            card.style.transform = 'translate(-50%, -50%)'
        }
    }

    hideDictionaryCard() {
        this._dictionaryLookupGeneration = (this._dictionaryLookupGeneration || 0) + 1
        if (this.dom.readerDictionaryCard) {
            this.dom.readerDictionaryCard.classList.remove('active')
            this.dom.readerDictionaryCard.style.display = 'none'
        }
        this._currentDictResult = null
        this.app.annotations._frozenSelectionSnapshot = null
    }

    async handleInPlaceParagraphTranslation(selectionInfo) {
        if (!selectionInfo || !selectionInfo.text) return
        const card = this.dom.readerParaTranslationCard
        const content = this.dom.paraTransContent
        if (!card || !content) return

        this.hideParaTranslationCard()
        const controller = this._paraTransAbortController = new AbortController()
        const bookId = this.app.currentBookId, book = this.app.currentBookData
        const epoch = this.app._currentBookEpoch
        const reference = {
            ...createReferenceSnapshot({ ...book, id: bookId }, selectionInfo),
            pdfTarget: selectionInfo.pdfTarget ? structuredClone(selectionInfo.pdfTarget) : null,
            chapterTitle: selectionInfo.chapterTitle || this.app.currentLocation?.tocItem?.label || '',
            documentHash: this.app._currentSnapshot?.documentHash || null,
            blobRevision: this.app._currentSnapshot?.blobRevision || null,
            revisionOrigin: this.app._currentSnapshot?.revisionOrigin || null
        }
        const isCurrent = () => this._paraTransAbortController === controller && !controller.signal.aborted &&
            this.app.currentBookId === bookId && this.app._currentBookEpoch === epoch
        this._currentParaOriginal = selectionInfo.text
        this._currentParaTranslation = ''

        this._paraTransSelectionRect = selectionInfo.rect || null
        card.style.display = 'flex'
        content.innerHTML = `<span style="color: var(--text-muted); font-size: 0.82rem;">${escapeHTML(t('cards.para.preparing'))}</span>`

        this._repositionParaTranslationCard()

        const originalText = selectionInfo.text.trim()
        const renderBilingualContent = (translatedText, isStreaming = false) => {
            const streamIndicator = isStreaming ? ' <span style="display:inline-block;animation:pulse 1s infinite;color:var(--accent);">●</span>' : ''
            const resultHtml = translatedText ? (renderSafeMarkdown(translatedText) + streamIndicator) : `<span style="color: var(--text-muted); font-size: 0.82rem;">${escapeHTML(t('cards.para.streaming'))}</span>`
            return `
                <div class="para-trans-bilingual-wrap">
                  <div class="para-trans-original-wrap">
                    <div class="para-trans-lang-label">${escapeHTML(t('chapterTrans.showOriginalBtn'))}</div>
                    <div class="para-trans-original-text">${escapeHTML(originalText)}</div>
                  </div>
                  <div class="para-trans-divider"></div>
                  <div class="para-trans-result-wrap">
                    <div class="para-trans-lang-label">${escapeHTML(t('cards.para.targetLabel'))}</div>
                    <div class="para-trans-result-text">${resultHtml}</div>
                  </div>
                </div>
            `
        }

        content.innerHTML = renderBilingualContent('', true)

        const promptText = t('cards.para.prompt', { text: originalText })
        const reqId = 'req_para_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        try {
            const ready = await isAiReady()
            if (!isCurrent()) return
            if (!ready) {
                content.innerText = t('cards.ai.configureFirst')
                return
            }
            let conversation = this.app.aiSidebar?.currentConversation
            if (conversation?.bookId !== bookId) {
                const existing = await db.getAiConversationsByBook(bookId)
                if (!isCurrent()) return
                conversation = existing[0] || {
                    id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    bookId, bookTitle: book?.title || t('cards.ai.tutorDefaultTitle'),
                    title: t('cards.ai.sessionTitle', { title: book?.title || t('cards.ai.tutorDefaultTitle') }),
                    createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1
                }
                if (!existing.length) await db.saveAiConversation(conversation)
                if (!isCurrent()) return
            }
            const convId = conversation.id
            const appendToSidebar = message => {
                const sidebar = this.app.aiSidebar
                if (isCurrent() && sidebar?.isOpen && sidebar.currentConversation?.id === convId) sidebar.appendMessageToUI(message)
            }
            const userMsg = {
                id: 'msg_user_' + reqId, conversationId: convId, role: 'user',
                content: t('cards.ai.paraSessionContent', { text: originalText }), actionName: t('cards.para.aiLabel'),
                referenceSnapshot: reference, contextSnapshot: null, presetId: 'preset_translate',
                createdAt: Date.now(), status: 'completed'
            }
            await db.saveAiMessage(userMsg)
            if (!isCurrent()) return
            appendToSidebar(userMsg)
            const response = await requestAiCompletion({
                requestId: reqId, prompt: promptText, messages: [{ role: 'user', content: promptText }],
                signal: controller.signal, returnMetadata: true,
                onChunk: (delta, fullText) => {
                    if (!isCurrent()) return
                    this._currentParaTranslation = fullText
                    content.innerHTML = renderBilingualContent(fullText, true)
                    this._repositionParaTranslationCard()
                }
            })
            if (!isCurrent()) return
            this._currentParaTranslation = response.fullText
            content.innerHTML = renderBilingualContent(response.fullText, false)
            this._repositionParaTranslationCard()
            const message = {
                id: 'msg_asst_' + reqId, conversationId: convId, role: 'assistant', content: response.fullText,
                referenceSnapshot: reference, createdAt: Date.now(), status: response.status, usage: response.usage || null
            }
            await db.saveAiMessage(message)
            const stored = await db.getAiConversation(convId)
            if (stored) await db.saveAiConversation({ ...stored, updatedAt: Date.now() })
            appendToSidebar(message)
        } catch (error) {
            if (isCurrent()) content.innerHTML = `<span style="color: #ef4444; font-size: 0.82rem;">${escapeHTML(t('cards.para.failed', { error: error.message || String(error) }))}</span>`
        } finally {
            if (this._paraTransAbortController === controller) this._paraTransAbortController = null
        }
    }

    _repositionParaTranslationCard() {
        const card = this.dom.readerParaTranslationCard
        if (!card || card.style.display === 'none') return
        const rect = this._paraTransSelectionRect
        if (rect && rect.top != null && rect.left != null) {
            const cardWidth = card.offsetWidth || Math.min(380, window.innerWidth - 20)
            const cardHeight = card.offsetHeight || 160
            const rectHeight = rect.height || 24
            const rectBottom = (rect.bottom != null && !isNaN(rect.bottom)) ? rect.bottom : (rect.top + rectHeight)
            let left = rect.left + ((rect.width || 0) / 2) - (cardWidth / 2)
            left = Math.max(10, Math.min(window.innerWidth - cardWidth - 10, left))
            let top = rectBottom + 8
            if (top + cardHeight > window.innerHeight - 10) {
                const aboveTop = rect.top - cardHeight - 8
                top = aboveTop >= 10 ? aboveTop : Math.max(10, window.innerHeight - cardHeight - 10)
            }
            card.style.transform = 'none'
            card.style.left = `${left}px`
            card.style.top = `${top}px`
        } else {
            card.style.left = '50%'
            card.style.top = '50%'
            card.style.transform = 'translate(-50%, -50%)'
        }
    }

    hideParaTranslationCard() {
        this._paraTransAbortController?.abort()
        this._paraTransAbortController = null
        if (this.dom.readerParaTranslationCard) {
            this.dom.readerParaTranslationCard.style.display = 'none'
        }
        this._paraTransSelectionRect = null
        this._currentParaOriginal = null
        this._currentParaTranslation = null
    }

    openAiAssistantModal() {
        if (!this.dom.modalAiAssistant) return
        this.closeAiAssistantModal()
        const selection = this.app.annotations.selectedTextInfo || this.app.annotations._frozenSelectionSnapshot
        const snapshot = createReferenceSnapshot({ ...this.app.currentBookData, id: this.app.currentBookId }, selection)
        this._activeAiSnapshot = {
            ...snapshot,
            pdfTarget: snapshot.pdfTarget ? structuredClone(snapshot.pdfTarget) : null,
            blobRevision: this.app._currentSnapshot?.blobRevision || null,
            revisionOrigin: this.app._currentSnapshot?.revisionOrigin || null,
            documentHash: this.app._currentSnapshot?.documentHash || null
        }
        const selected = snapshot.selectedText
        const generation = this._aiReqGeneration
        this.dom.modalAiAssistant.style.display = 'flex'
        this.dom.modalAiAssistant.classList.add('show')
        if (this.dom.aiSelectedPreview) {
            this.dom.aiSelectedPreview.innerText = selected || t('cards.ai.noSelection')
        }
        if (this.dom.aiResponseArea) {
            this.dom.aiResponseArea.innerHTML = `<span style="color: var(--text-muted); font-size: 0.82rem;">${escapeHTML(t('cards.ai.welcomeHint'))}</span>`
        }
        if (this.dom.aiStatusHint) {
            isAiReady().then(ready => {
                if (generation === this._aiReqGeneration && this.dom.aiStatusHint) {
                    this.dom.aiStatusHint.innerText = ready ? t('cards.ai.ready') : t('cards.ai.missingKeyHint')
                    this.dom.aiStatusHint.style.color = ready ? 'var(--text-muted)' : '#f59e0b'
                }
            })
        }
    }

    closeAiAssistantModal() {
        this._aiReqGeneration = (this._aiReqGeneration || 0) + 1
        if (this._aiAbortController) {
            this._aiAbortController.abort()
            this._aiAbortController = null
        }
        this._isAiRunning = false
        this._activeAiSnapshot = null
        this._lastCompletedAiText = ''
        if (this.dom.btnAiAsk) this.dom.btnAiAsk.innerText = t('cards.ai.sendBtn')
        if (!this.dom.modalAiAssistant) return
        this.dom.modalAiAssistant.classList.remove('show')
        setTimeout(() => {
            if (this.dom.modalAiAssistant && !this.dom.modalAiAssistant.classList.contains('show')) this.dom.modalAiAssistant.style.display = 'none'
        }, 200)
    }

    async runAiRequest(promptText, systemPrompt = SYSTEM_PROMPTS.qa) {
        if (!promptText) return
        if (this._isAiRunning) {
            this._aiReqGeneration++
            this._aiAbortController?.abort()
            this._aiAbortController = null
            this._isAiRunning = false
            if (this.dom.btnAiAsk) this.dom.btnAiAsk.innerText = t('cards.ai.sendBtn')
            if (this.dom.aiStatusHint) this.dom.aiStatusHint.innerText = t('cards.ai.stopped')
            return
        }

        // Own the request before reading the credential asynchronously.
        const reqGen = ++this._aiReqGeneration
        const controller = this._aiAbortController = new AbortController()
        const signal = controller.signal
        const isCurrent = () => reqGen === this._aiReqGeneration && !signal.aborted
        this._isAiRunning = true
        this._lastCompletedAiText = ''
        const area = this.dom.aiResponseArea
        const hint = this.dom.aiStatusHint
        if (this.dom.btnAiAsk) this.dom.btnAiAsk.innerText = t('cards.ai.stopBtn')
        if (area) area.innerHTML = `<span style="color: var(--text-muted);">${escapeHTML(t('cards.ai.thinking'))}</span>`
        if (hint) hint.innerText = t('cards.ai.requestingModel')

        try {
            const cfg = getAiConfig()
            const apiKey = await getAiApiKey()
            if (!isCurrent()) return
            if (!cfg.enabled || !apiKey) {
                if (area) area.innerText = t('cards.ai.needConfig')
                if (hint) hint.innerText = t('cards.ai.missingKeyShort')
                this.app.dialogs.showToast(t('cards.ai.needKeyToast'), 'warning')
                return
            }
            const response = await requestAiCompletion({
                endpoint: cfg.endpoint, model: cfg.model, apiKey,
                prompt: promptText, systemPrompt, signal, returnMetadata: true,
                onChunk: (delta, fullText) => {
                    if (isCurrent() && area) area.innerHTML = renderSafeMarkdown(fullText)
                }
            })
            if (!isCurrent()) return
            if (area) area.innerHTML = renderSafeMarkdown(response.fullText)
            if (response.status === 'completed') {
                this._lastCompletedAiText = response.fullText.trim()
                if (hint) hint.innerText = t('cards.ai.done')
            } else if (hint) {
                hint.innerText = response.status === 'cancelled' ? t('cards.ai.stopped') : t('cards.ai.incomplete')
            }
        } catch (err) {
            if (!isCurrent()) return
            if (err.name === 'AbortError') {
                if (hint) hint.innerText = t('cards.ai.stopped')
            } else {
                if (area) area.innerHTML = `<span style="color: #ef4444;">${escapeHTML(t('cards.ai.requestError', { error: err.message || String(err) }))}</span>`
                if (hint) hint.innerText = t('cards.ai.requestFailed')
            }
        } finally {
            if (reqGen === this._aiReqGeneration) {
                this._isAiRunning = false
                this._aiAbortController = null
                if (this.dom.btnAiAsk) this.dom.btnAiAsk.innerText = t('cards.ai.sendBtn')
            }
        }
    }

    extractFootnoteRichFromTarget(targetEl, anchorEl = null) {
        const empty = { text: '', html: '' }
        if (!targetEl) return empty

        // Never treat chapter headings or TOC navigation containers as footnotes
        if (targetEl.matches?.('h1, h2, h3, h4, h5, h6') || targetEl.closest?.('h1, h2, h3, h4, h5, h6, nav, .toc, #toc')) {
            return empty
        }

        // 1. If target element is an empty anchor/span or inline tag with text <= 4, climb up to enclosing block
        let containerEl = targetEl
        if (targetEl.matches?.('dl') && targetEl.querySelector?.('dd')) {
            containerEl = targetEl.querySelector('dd') || targetEl
        } else {
            const dtParent = targetEl.matches?.('dt') ? targetEl : targetEl.closest?.('dt')
            if (dtParent && dtParent.nextElementSibling?.matches?.('dd')) {
                containerEl = dtParent.nextElementSibling
            } else {
                const isInline = ['a', 'span', 'small', 'sup', 'sub', 'b', 'i', 'strong', 'em', 'img'].includes(targetEl.tagName?.toLowerCase())
                const textLen = (targetEl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length
                if (isInline || textLen <= 4) {
                    const parentBlock = targetEl.closest('li, p, blockquote, dd, aside, div.footnote, div.note, [class*="note" i], [class*="fn" i], div')
                    if (parentBlock && (parentBlock.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length > 4) {
                        containerEl = parentBlock
                    }
                }
            }
        }

        // 2. Clone to safely manipulate DOM without mutating reader document
        const clone = containerEl.cloneNode(true)

        // 3. Strip ONLY real backlink return anchors (preserve short valid citations like DOI or external links)
        clone.querySelectorAll('a[href]').forEach(bl => {
            const href = (bl.getAttribute('href') || '').trim()
            const role = (bl.getAttribute('role') || '').toLowerCase()
            const epubType = (bl.getAttribute('epub:type') || '').toLowerCase()
            const txt = (bl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            const isExplicitBacklink = role.includes('doc-backlink') || epubType.includes('backlink')
            const isReturnSymbol = /^[\[（(【]?\s*(?:[\u21a9\u2190\u23ce\^↩←↑]|返回|back)\s*[\]）)】]?$/i.test(txt)
            const isInternalMarkerLink = (href.startsWith('#') || !/^https?:\/\//i.test(href)) && /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021])\s*[\]）)】]?$/.test(txt)
            if (isExplicitBacklink || isReturnSymbol || isInternalMarkerLink) {
                bl.remove()
            }
        })

        // 4. Extract text preserving multi-paragraph structure if present
        const pEls = Array.from(clone.querySelectorAll('p, div, li, dd'))
        let raw = ''
        if (pEls.length > 1) {
            raw = pEls.map(p => (p.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()).filter(Boolean).join('\n\n')
        } else {
            raw = (clone.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        }

        // 5. Clean leading bracketed/circled numbers (e.g. [1], 1., ㉗, 45., [注1])
        const leadingNumRe = /^[\[（(【]?(?:\d+|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注\s*\d*)[\]）)】]?\s*[.、:：\-]?\s*/
        raw = raw.replace(leadingNumRe, '').trim()

        const isTrivialMarker = s => !s || /^[\[（(【]?\s*(?:\d+|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注\s*\d*)\s*[\]）)】]?\s*[.、:：\-]?$/.test(s)
        const anchorLabel = anchorEl ? (anchorEl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(]|[\]）)]$/g, '') : ''
        if (raw === anchorLabel || isTrivialMarker(raw)) {
            const candidateP = containerEl.querySelector?.('p, dd, div')
            const candidateText = candidateP ? (candidateP.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : ''
            if (candidateText && candidateText !== anchorLabel && !isTrivialMarker(candidateText)) {
                raw = candidateText.replace(leadingNumRe, '').trim()
                return { text: raw, html: sanitizeFootnoteHtml(candidateP) }
            }
            return empty
        }

        // Strip leading trivial marker text node if present inside sanitized HTML clone
        const sanitizedHtml = sanitizeFootnoteHtml(clone).replace(/^(\s*<p>)?\s*[\[（(【]?(?:\d+|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注\s*\d*)[\]）)】]?\s*[.、:：\-]?\s*/, (_, pOpen) => pOpen || '').trim()

        const fallback = (containerEl.textContent || containerEl.innerText || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        const cleanFallback = fallback.replace(leadingNumRe, '').trim()
        if (!isTrivialMarker(raw)) return { text: raw, html: sanitizedHtml }
        if (!isTrivialMarker(cleanFallback) && cleanFallback !== anchorLabel) return { text: cleanFallback, html: '' }
        return empty
    }

    extractFootnoteFromTarget(targetEl, anchorEl = null) {
        return this.extractFootnoteRichFromTarget(targetEl, anchorEl).text
    }

    showFootnotePopup({ title, text, html = '', rect }) {
        if (!this.dom.footnotePopup) return
        if (this.dom.footnotePopupTitle) this.dom.footnotePopupTitle.innerText = title || t('cards.footnote.defaultTitle')
        if (this.dom.footnotePopupContent) {
            if (html && String(html).trim()) {
                this.dom.footnotePopupContent.innerHTML = html
            } else {
                this.dom.footnotePopupContent.innerText = text || ''
            }
        }

        this.dom.footnotePopup.style.display = 'block'
        this.dom.footnotePopup.style.opacity = '1'

        const popupWidth = this.dom.footnotePopup.offsetWidth || 340
        const popupHeight = this.dom.footnotePopup.offsetHeight || 120

        // Calculate best top/left position near rect
        let left = (rect?.left || (window.innerWidth / 2)) + ((rect?.width || 0) / 2) - (popupWidth / 2)
        let top = (rect?.top || (window.innerHeight / 2)) - popupHeight - 14 // above the anchor

        if (top < 70) {
            // If too close to top bar, place below anchor
            top = (rect?.top || 100) + (rect?.height || 20) + 14
        }

        // Clamp within viewport
        left = Math.max(16, Math.min(window.innerWidth - popupWidth - 16, left))
        top = Math.max(60, Math.min(window.innerHeight - popupHeight - 20, top))

        this.dom.footnotePopup.style.left = `${left}px`
        this.dom.footnotePopup.style.top = `${top}px`
    }

    hideFootnotePopup() {
        if (this.dom.footnotePopup) {
            this.dom.footnotePopup.style.display = 'none'
        }
    }

    cleanFootnoteMarkers(text) {
        if (!text) return ''
        return text
            // Remove bracketed footnote numbers like [10], [1], [注1], [ 12 ], [a], [note], etc.
            .replace(/\s*\[\s*(?:注|note|\d+|[a-zA-Z])\s*\]/gi, '')
            .replace(/\s*〔\s*\d+\s*〕/g, '')
            .replace(/\s*【\s*\d+\s*】/g, '')
            .replace(/\s*［\s*\d+\s*］/g, '')
            .replace(/\s*\(?(?:①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|⑪|⑫|⑬|⑭|⑮|⑯|⑰|⑱|⑲|⑳)\)?/g, '')
            .replace(/[ \t]+/g, ' ')
            .trim()
    }

    async openQuoteCardModal(text, chapterTitle = '', locationInfo = null, customBookInfo = null) {
        this.app.annotations.hideSelectionPopup()
        this.app.annotations.hideHighlightActionPopup()

        const cleanedText = this.cleanFootnoteMarkers(text)
        let resolvedChapter = (chapterTitle || '').trim()
        let resolvedLocation = locationInfo != null ? String(locationInfo).trim() : null

        if ((!resolvedChapter || resolvedLocation === null) && !customBookInfo) {
            const format = customBookInfo?.format || this.app.currentBookData?.format || (this.app.pdfViewport ? 'pdf' : 'epub')
            const sourceToc = this.app.currentPdfTOC || this.app.toc || this.app._activeSession?.toc || []
            const resolved = resolveExcerptSource({
                range: this.app.annotations.selectedTextInfo?.range,
                currentLocation: this.app.currentLocation,
                reader: this.app.foliateView || this.app.pdfViewport,
                format,
                pdfViewport: this.app.pdfViewport,
                chapterTitle: resolvedChapter,
                locationInfo: resolvedLocation
            }, sourceToc)

            if (!resolvedChapter) resolvedChapter = resolved.chapterTitle || ''
            if (resolvedLocation === null) resolvedLocation = resolved.locationInfo || ''
        }

        this._quoteSourceBookId = customBookInfo ? (customBookInfo.bookId || null) : this.app.currentBookId
        if (this.dom.btnQuoteSaveToShelf) this.dom.btnQuoteSaveToShelf.disabled = !this._quoteSourceBookId
        const rawBookTitle = (customBookInfo?.bookTitle || this.app.currentBookData?.title || '').trim()
        const rawAuthor = (customBookInfo?.author || this.app.currentBookData?.author || '').trim()
        const bookTitle = rawBookTitle === t('book.untitled') ? '' : rawBookTitle
        const author = rawAuthor === t('book.unknownAuthor') ? '' : rawAuthor
        this._originalQuoteText = cleanedText

        quoteCard.setData({
            bookTitle,
            author,
            quoteText: cleanedText,
            chapterTitle: resolvedChapter,
            locationInfo: resolvedLocation,
            userName: this.dom.quoteUserNameInput?.value || DEFAULT_READER_NAME
        })

        if (this.dom.quoteTextEditor) {
            this.dom.quoteTextEditor.value = cleanedText
        }
        if (this.dom.btnQuoteResetText) {
            this.dom.btnQuoteResetText.hidden = true
        }
        if (this.dom.quoteBookTitleInput) {
            this.dom.quoteBookTitleInput.value = bookTitle
        }
        if (this.dom.quoteBookAuthorInput) {
            this.dom.quoteBookAuthorInput.value = author
        }
        if (this.dom.quoteChapterTitleInput) {
            this.dom.quoteChapterTitleInput.value = resolvedChapter
        }
        if (this.dom.quoteLocationInput) {
            this.dom.quoteLocationInput.value = resolvedLocation
        }

        // Render Theme Pickers
        this.renderQuoteThemePicker()

        // Platform-accurate save button label: Gallery on Android vs Save As on Desktop
        const downloadLabel = this.dom.btnQuoteDownload?.querySelector?.('span')
        if (downloadLabel) {
            const labelKey = window.platformBridge?.isAndroid ? 'modal.quoteSaveGalleryBtn' : 'modal.quoteSaveBtn'
            downloadLabel.setAttribute('data-i18n', labelKey)
            downloadLabel.textContent = t(labelKey)
        }

        clearTimeout(this._quoteCardCloseTimer)
        // Show Modal
        if (this.dom.quoteCardBackdrop) {
            this.dom.quoteCardBackdrop.style.display = 'flex'
            void this.dom.quoteCardBackdrop.offsetHeight
            this.dom.quoteCardBackdrop.classList.add('show')
        }

        // Render Canvas Preview
        await this.updateQuoteCardPreview()
    }

    closeQuoteCardModal() {
        this._quoteCardToken++
        clearTimeout(this._quoteCardDebounceTimer)
        this._quoteCardDebounceTimer = null
        const preview = this.dom.quoteCanvasWrap
        const canvas = preview?.querySelector('canvas')
        if (canvas) canvas.width = canvas.height = 0
        preview?.replaceChildren()

        const backdrop = this.dom.quoteCardBackdrop
        if (backdrop?.classList.contains('show')) {
            backdrop.classList.remove('show')
            this._quoteCardCloseTimer = setTimeout(() => { backdrop.style.display = 'none' }, 200)
        }
        if (this.dom.quoteCopyToast) {
            this.dom.quoteCopyToast.style.display = 'none'
        }
    }

    renderQuoteThemePicker() {
        if (!this.dom.quoteThemePicker) return
        this.dom.quoteThemePicker.innerHTML = ''

        THEMES.forEach(themeObj => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = `quote-theme-pill quote-swatch-card ${themeObj.id === quoteCard.currentThemeId ? 'active' : ''}`
            btn.dataset.quoteTheme = themeObj.id
            btn.setAttribute('aria-pressed', themeObj.id === quoteCard.currentThemeId ? 'true' : 'false')
            btn.title = themeObj.name
            btn.innerHTML = `
                <span class="quote-swatch-paper" style="background: ${themeObj.bg}; color: ${themeObj.titleColor}; border-color: ${themeObj.previewBorder};">Aa</span>
                <span class="quote-swatch-name">${escapeHTML(themeObj.name)}</span>
            `
            btn.addEventListener('click', async () => {
                this.dom.quoteThemePicker.querySelectorAll('.quote-theme-pill').forEach(b => {
                    b.classList.remove('active')
                    b.setAttribute('aria-pressed', 'false')
                })
                btn.classList.add('active')
                btn.setAttribute('aria-pressed', 'true')
                quoteCard.setTheme(themeObj.id)
                await this.updateQuoteCardPreview()
            })
            this.dom.quoteThemePicker.appendChild(btn)
        })
    }

    async updateQuoteCardPreview(immediate = true) {
        if (!this.dom.quoteCanvasWrap) return
        if (this._quoteCardDebounceTimer) {
            clearTimeout(this._quoteCardDebounceTimer)
            this._quoteCardDebounceTimer = null
        }

        const currentToken = ++this._quoteCardToken
        const executeRender = async () => {
            this._quoteCardDebounceTimer = null
            try {
                const canvas = await quoteCard.renderCanvas()
                if (this._quoteCardToken !== currentToken) {
                    canvas.width = canvas.height = 0
                    return
                }
                const previous = this.dom.quoteCanvasWrap.querySelector('canvas')
                if (previous) previous.width = previous.height = 0
                this.dom.quoteCanvasWrap.replaceChildren(canvas)
                if (this.dom.btnQuoteCopyClipboard) this.dom.btnQuoteCopyClipboard.disabled = false
                if (this.dom.btnQuoteDownload) this.dom.btnQuoteDownload.disabled = false
            } catch (error) {
                if (this._quoteCardToken !== currentToken || !this.dom.quoteCanvasWrap) return
                const message = document.createElement('p')
                message.textContent = error?.message || t('cards.quote.renderFailed')
                message.setAttribute('role', 'status')
                message.style.cssText = 'margin:0;padding:24px;max-width:420px;font:13px/1.7 var(--font-ui);color:var(--text-muted)'
                this.dom.quoteCanvasWrap.replaceChildren(message)
                if (this.dom.btnQuoteCopyClipboard) this.dom.btnQuoteCopyClipboard.disabled = true
                if (this.dom.btnQuoteDownload) this.dom.btnQuoteDownload.disabled = true
            }
        }

        if (immediate) {
            await executeRender()
        } else {
            this._quoteCardDebounceTimer = setTimeout(executeRender, 200)
        }
    }
}
