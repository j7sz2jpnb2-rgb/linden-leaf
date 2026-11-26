/**
 * chapter-translation-manager.js - Chapter-Level Bilingual Reading Engine
 * Manages full chapter extraction, serialized AI translation, paragraph-by-paragraph alternating layout,
 * mode toggling (Source / Bilingual / Target), and persistent storage in IndexedDB.
 * Chapter translation and bilingual reading view.
 */

import {
    saveChapterTranslation,
    getChapterTranslation,
    deleteChapterTranslation,
    listChapterTranslationsForBook
} from './db.js'

import {
    TranslationJobCoordinator,
    translationIdentity,
    validateTranslationResponse,
    buildTranslationRevisionArchive,
    translationError,
    requestTranslationWithRecovery
} from './translation-job-core.js'

import {
    requestAiCompletion,
    getAiConfig,
    getAiApiKey,
    recordTranslationDiagnostic
} from './reading-ai-assistant.js'
import { escapeHTML as escapeHtml } from './ui-format.js'
import { t } from './i18n.js'

function simpleTextHash(str) {
    if (!str) return '0'
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i)
        hash |= 0
    }
    return String(Math.abs(hash))
}

function formatArchiveRecord(rec) {
    try {
        if (typeof buildTranslationRevisionArchive === 'function') {
            return buildTranslationRevisionArchive(rec)
        }
        if (typeof globalThis.buildTranslationRevisionArchive === 'function') {
            return globalThis.buildTranslationRevisionArchive(rec)
        }
    } catch (_) {}
    return rec
}

export const FEATURE_CHAPTER_TRANSLATION_ENABLED = true

export class ChapterTranslationManager {
    constructor(app = null) {
        this.app = app
        this.currentBookId = null
        this.currentChapterKey = null
        this.currentChapterTitle = ''
        this.activeTaskId = null
        this.abortController = null
        this.taskOwner = null
        this.sessionRecords = new Map()
        this._starting = false
        this.coordinator = new TranslationJobCoordinator()
        this._sectionLoadGen = 0
        this.viewMode = 'bilingual' // 'source' | 'bilingual' | 'target'
        this.cachedRecord = null

        // Display-layer registries: keep DOM references strictly separated from serializable coordinator chunks
        this.displayElementMap = new Map() // paraId -> original DOM element
        this.derivedToSourceAnchorMap = new Map() // paraId -> { paraId, sourceHash, sourceText, sourceElement, tag }

        this.dom = {}
    }

    get isTranslating() {
        return this.coordinator.busy
    }
    set isTranslating(val) {
        // Compatibility: managed via coordinator
    }

    get isPaused() {
        return this.coordinator.state === 'paused'
    }
    set isPaused(val) {
        if (val) this.coordinator.pause()
        else this.coordinator.resume()
    }

    init(dom = {}) {
        this.dom = dom
        if (!FEATURE_CHAPTER_TRANSLATION_ENABLED) {
            if (this.dom.btnChapterTranslate) {
                this.dom.btnChapterTranslate.style.display = 'none'
            }
            return
        }
        this.attachEventListeners()
    }

    attachEventListeners() {
        this.dom.btnChapterTranslate?.addEventListener('click', () => {
            this.handleToolbarClick()
        })
        this.dom.btnCancelChapterTransModal?.addEventListener('click', () => {
            this.closeConfirmModal()
        })
        this.dom.btnConfirmChapterTransStart?.addEventListener('click', () => {
            this.startCurrentChapterTranslation({ retryUnavailable: document.getElementById('chapter-trans-retry-unavailable')?.checked === true })
        })
        this.dom.btnChapterTransStop?.addEventListener('click', () => {
            this.stopTranslation()
        })
        document.getElementById('btn-cancel-chapter-trans')?.addEventListener('click', () => this.closeConfirmModal())
        document.getElementById('btn-chapter-trans-retranslate')?.addEventListener('click', () => this.openConfirmModal())
        document.getElementById('btn-chapter-trans-restart')?.addEventListener('click', () => this.startCurrentChapterTranslation({ restart: true, retryUnavailable: document.getElementById('chapter-trans-retry-unavailable')?.checked === true }))
        this.dom.btnChapterTransClear?.addEventListener('click', () => {
            this.clearCurrentChapterTranslation()
        })

        // Mode toggles in bilingual bar
        this.dom.btnTransModeSource?.addEventListener('click', () => this.setViewMode('source'))
        this.dom.btnTransModeBilingual?.addEventListener('click', () => this.setViewMode('bilingual'))
        this.dom.btnTransModeTarget?.addEventListener('click', () => this.setViewMode('target'))
    }

    getCurrentSectionIndex() {
        if (this.currentChapterKey) {
            const m = String(this.currentChapterKey).match(/sec_(\d+)/)
            if (m) return parseInt(m[1], 10)
        }
        return null
    }

    /**
     * Called whenever a new book or chapter is opened or relocated.
     */
    async onSectionChanged(bookId, sectionIndex, sectionDoc = null) {
        if (!FEATURE_CHAPTER_TRANSLATION_ENABLED) return
        if (!bookId) return

        // Contract: 切书停止、切章暂停，返回后由用户继续，避免隐形付费
        if (this.coordinator.busy) {
            if (this.taskOwner && this.taskOwner.bookId !== bookId) {
                this.coordinator.stop()
                this.app?.showToast?.(t('chapterTrans.toast.switchedBook'), 'info')
            } else if (this.taskOwner && this.taskOwner.chapterKey !== `sec_${sectionIndex}`) {
                this.coordinator.pause()
                this.app?.showToast?.(t('chapterTrans.toast.switchedChapter'), 'info')
            }
        }

        const loadGen = ++this._sectionLoadGen
        this.currentBookId = bookId
        this.currentChapterKey = `sec_${sectionIndex}`

        // Derive chapter title
        this.currentChapterTitle = this.resolveChapterTitle(sectionIndex, sectionDoc)

        // Check if this chapter already has translation in local DB
        const saved = await getChapterTranslation(bookId, this.currentChapterKey)

        // Guard against stale asynchronous chapter loading race
        if (this._sectionLoadGen !== loadGen || this.currentBookId !== bookId || this.currentChapterKey !== `sec_${sectionIndex}`) {
            return
        }

        this.cachedRecord = this.sessionRecords.get(`${bookId}::sec_${sectionIndex}`) || saved
        const currentRecord = this.cachedRecord

        const autoRestore = this.app?.advancedSettings?.config?.chapterTransAutoRestore !== false

        if (currentRecord && currentRecord.paragraphs?.length > 0) {
            this.updateToolbarState(true)
            const completed = currentRecord.paragraphs.filter(p => p.status === 'completed' && p.translation?.trim()).length
            this.updateProgressUI(completed, currentRecord.totalParagraphs || completed,
                this.isPaused && this.ownsCurrentChapter() ? t('chapterTrans.status.paused') : this.sessionRecords.has(currentRecord.id) ? t('chapterTrans.status.sessionUnsaved') : currentRecord.status === 'completed' ? t('chapterTrans.status.completedSaved') : t('chapterTrans.status.partialSaved'))
            // Auto restore if enabled and viewMode is bilingual or target
            if (this.viewMode !== 'source' && autoRestore) {
                const doc = sectionDoc || this.getSectionDocument(sectionIndex)
                if (doc) {
                    this.renderBilingualView(currentRecord, doc)
                }
            }
        } else {
            this.updateToolbarState(false)
            this.hideBilingualBar()
            const doc = sectionDoc || this.getSectionDocument(sectionIndex)
            if (doc) {
                this.removeInjectedElements(doc)
            }
        }
    }

    resolveChapterTitle(sectionIndex, sectionDoc) {
        try {
            if (this.app?.currentToc) {
                const item = this.app.currentToc.find(t => t.sectionIndex === sectionIndex || t.index === sectionIndex)
                if (item?.label) return item.label.trim()
            }
            if (sectionDoc) {
                const heading = sectionDoc.querySelector('h1, h2, h3, [data-reader-heading]')
                if (heading?.textContent) {
                    return heading.textContent.trim().slice(0, 40)
                }
            }
        } catch (e) {}
        return t('chapterTrans.chapterFallback', { num: Number(sectionIndex) + 1 })
    }

    updateToolbarState(isTranslated) {
        const btn = this.dom.btnChapterTranslate
        if (!btn) return
        btn.classList.toggle('active-translated', isTranslated)
        const partial = isTranslated && this.cachedRecord?.status !== 'completed'
        const action = isTranslated ? (partial ? t('chapterTrans.action.resume') : t('chapterTrans.action.viewBilingual')) : t('chapterTrans.action.translate')
        const label = this.currentChapterTitle ? `${action} (${this.currentChapterTitle})` : action
        btn.setAttribute('title', label)
        btn.setAttribute('aria-label', label)
    }

    ownsCurrentChapter() {
        return this.taskOwner?.bookId === this.currentBookId && this.taskOwner?.chapterKey === this.currentChapterKey
    }

    resumeCurrentTask() {
        if (!this.isPaused) return false
        if (!this.ownsCurrentChapter()) {
            this.app?.showToast?.(t('chapterTrans.toast.otherChapterPaused'), 'info')
            return true
        }
        this.coordinator.resume()
        this.showBilingualBar()
        this.updateProgressUI(this.taskOwner.completed || 0, this.taskOwner.total, t('chapterTrans.status.resuming'))
        return true
    }

    handleToolbarClick() {
        if (!FEATURE_CHAPTER_TRANSLATION_ENABLED && this.app && !this.enabled) return
        const format = this.app?.currentBookData?.format || ''
        if (format && format !== 'epub' && format !== 'txt') {
            this.app?.showToast?.(t('chapterTrans.toast.unsupportedFormat'), 'info')
            return
        }
        if (this.isTranslating) {
            if (this.resumeCurrentTask()) return
            this.showBilingualBar()
            return
        }

        const currentParagraphs = this.extractChapterParagraphs(this.getSectionDocument())
        const sourceChanged = this.cachedRecord && currentParagraphs.some(p => !this.cachedRecord.paragraphs?.some(old => old.id === p.id && old.sourceHash === p.sourceHash))
        if (this.cachedRecord?.paragraphs?.length > 0 && (this.cachedRecord.status !== 'completed' || sourceChanged || this.sessionRecords.has(this.cachedRecord.id))) {
            this.openConfirmModal()
            return
        }

        if (this.cachedRecord && this.cachedRecord.paragraphs?.length > 0) {
            if (this.viewMode === 'source') {
                this.setViewMode('bilingual')
            } else {
                this.showBilingualBar()
            }
            const doc = this.getSectionDocument()
            if (doc) {
                this.renderBilingualView(this.cachedRecord, doc)
            }
            return
        }

        this.openConfirmModal()
    }

    openConfirmModal() {
        const modal = this.dom.modalChapterTransConfirm
        if (!modal) return

        const secIdx = this.getCurrentSectionIndex()
        const doc = this.getSectionDocument(secIdx)
        const paras = this.extractChapterParagraphs(doc)
        const completedIds = new Set((this.cachedRecord?.paragraphs || [])
            .filter(p => p.status === 'completed' && p.translation?.trim() && paras.some(current => current.id === p.id && current.sourceHash === p.sourceHash))
            .map(p => p.id))
        const pending = paras.filter(p => !completedIds.has(p.id))

        const titleEl = document.getElementById('chapter-trans-confirm-title')
        const countEl = document.getElementById('chapter-trans-confirm-count')
        const tokensEl = document.getElementById('chapter-trans-confirm-tokens')

        if (titleEl) titleEl.innerText = this.currentChapterTitle
        if (countEl) countEl.innerText = t('chapterTrans.modal.pendingCount', { pending: pending.length, total: paras.length })
        if (tokensEl) {
            const estimatedTokens = Math.round(pending.reduce((acc, p) => acc + p.text.length * 1.5, 0))
            tokensEl.innerText = t('chapterTrans.modal.approxTokens', { tokens: estimatedTokens.toLocaleString() })
        }

        const hasPrevious = (this.cachedRecord?.paragraphs || []).some(p => p.translation || p.subChunks?.some(sc => sc.translation))
        const restart = document.getElementById('btn-chapter-trans-restart')
        if (restart) restart.style.display = hasPrevious ? '' : 'none'
        const start = this.dom.btnConfirmChapterTransStart
        if (start) { start.innerText = this.sessionRecords.has(this.cachedRecord?.id) && pending.length === 0 ? t('chapterTrans.modal.saveAction') : hasPrevious ? t('chapterTrans.modal.resumeAction') : t('chapterTrans.startConfirmBtn'); start.disabled = pending.length === 0 && !this.sessionRecords.has(this.cachedRecord?.id) }
        const styleNote = document.getElementById('chapter-trans-config-note')
        if (styleNote) styleNote.innerText = hasPrevious ? t('chapterTrans.modal.styleNoteResume') : t('chapterTrans.modal.styleNoteNew')
        modal.style.display = 'flex'
        modal.classList.add('show')
    }

    closeConfirmModal() {
        const modal = this.dom.modalChapterTransConfirm
        if (modal) {
            modal.classList.remove('show')
            modal.style.display = 'none'
        }
    }

    /**
     * Retrieves genuine section document inside book iframe/contents.
     * Strictly NEVER returns ShadowRoot or top-level window.document.
     * When targetIndex is specified, only returns matching document, never unrelated chapters.
     */
    getSectionDocument(targetIndex = null) {
        try {
            const resolvedIndex = targetIndex != null ? targetIndex : this.getCurrentSectionIndex()
            const renderer = this.app?.foliateView?.renderer
            if (renderer) {
                if (typeof renderer.getContents === 'function') {
                    const contents = renderer.getContents() || []
                    if (resolvedIndex != null) {
                        const match = contents.find(c => c && c.index === resolvedIndex && c.doc)
                        if (match?.doc) return match.doc
                        return null
                    }
                }
                if (typeof renderer.getSection === 'function' && resolvedIndex != null) {
                    const sec = renderer.getSection(resolvedIndex)
                    if (sec?.doc) return sec.doc
                    return null
                }
            }
        } catch (e) {
            console.warn('[ChapterTrans] getSectionDocument error:', e)
        }
        return null
    }

    /** Extract visible source text while excluding any injected inline bilingual target containers. */
    _getOwnSourceText(el) {
        if (!el) return ''
        if (!el.querySelector?.('.linden-bilingual-target') || !el.childNodes) {
            return el.textContent ? el.textContent.trim() : ''
        }
        let out = ''
        const walk = (node) => {
            for (const ch of node.childNodes || []) {
                if (ch.nodeType === 3) {
                    out += ch.nodeValue ?? ch.textContent ?? ''
                } else if (ch.nodeType === 1 && !ch.classList?.contains('linden-bilingual-target') && !ch.closest?.('.linden-bilingual-target')) {
                    walk(ch)
                }
            }
        }
        walk(el)
        return out.trim()
    }

    /**
     * Extract paragraphs safely from current section DOM.
     * Extracts only leaf semantic blocks to prevent duplicating containers and children.
     * Strictly returns pure serializable data (zero DOM element references).
     * Keeps DOM element references in display-layer maps to prevent DataCloneError.
     */
    extractChapterParagraphs(doc, force = false) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return []
        if (!force && this._cachedDoc === doc && this._cachedChapterKey === this.currentChapterKey && this._cachedParas) {
            return this._cachedParas
        }
        const candidates = doc.querySelectorAll('p, blockquote, h1, h2, h3, h4, h5, h6, li, div, td, th')
        const results = []
        let pIndex = 0

        this.displayElementMap.clear()
        this.derivedToSourceAnchorMap.clear()

        candidates.forEach(el => {
            if (el.classList?.contains('bilingual-translation-block') || el.closest?.('.bilingual-translation-block')) return
            if (el.classList?.contains('linden-derived-block') || el.closest?.('#linden-derived-bilingual-view')) return
            if (el.classList?.contains('linden-bilingual-target') || el.closest?.('.linden-bilingual-target')) return
            if (el.closest?.('script, style, nav, [aria-hidden="true"], .footnote-popup')) return

            // Leaf semantic block check: avoid duplicating parent container and its child paragraphs
            // Ignore injected .linden-bilingual-target blocks inside container elements (td/th/li).
            const nestedBlocks = el.querySelectorAll('p, blockquote, h1, h2, h3, h4, h5, h6, li, div, td, th')
            for (const child of nestedBlocks) {
                if (!child.classList?.contains('linden-bilingual-target') && !child.closest?.('.linden-bilingual-target')) {
                    return
                }
            }

            const rawText = this._getOwnSourceText(el)
            if (!rawText || rawText.length < 2) return

            const paraId = `p_${pIndex++}`
            const hash = simpleTextHash(rawText)
            const tag = (el.tagName || 'p').toLowerCase()

            // Register in display layer maps
            this.displayElementMap.set(paraId, el)
            this.derivedToSourceAnchorMap.set(paraId, {
                paraId,
                sourceHash: hash,
                sourceText: rawText,
                sourceElement: el,
                tag
            })

            // Pure serializable object: strictly NO DOM elements
            results.push({
                id: paraId,
                text: rawText,
                sourceHash: hash,
                tag
            })
        })

        this._cachedDoc = doc
        this._cachedChapterKey = this.currentChapterKey
        this._cachedParas = results
        return results
    }

    /**
     * Splits excessively long single paragraphs along sentence/punctuation boundaries.
     * Preserves original parent paragraph ID and sub-chunk sequence indices.
     */
    splitParagraphIntoSubChunks(para, maxChars = 320) {
        if (!para || typeof para.text !== 'string') return []
        const text = para.text.trim()
        if (text.length <= maxChars) {
            return [{
                id: para.id,
                parentParaId: para.id,
                subChunkIndex: 0,
                totalSubChunks: 1,
                text,
                sourceHash: para.sourceHash
            }]
        }

        // Split along sentence punctuation boundaries: [。！？!?；;\n]
        const sentenceRegex = /[^。！？!?；;\n]+[。！？!?；;\n]*/g
        const rawSentences = text.match(sentenceRegex) || [text]
        const sentences = []

        // Break any individual sentence that exceeds maxChars into slices <= maxChars
        for (const s of rawSentences) {
            if (s.length <= maxChars) {
                sentences.push(s)
            } else {
                let remaining = s
                while (remaining.length > maxChars) {
                    let cutIndex = maxChars
                    // Search for a minor boundary (comma, colon, whitespace) within the window
                    const boundary = remaining.slice(0, maxChars).search(/[,，、：:\s][^,，、：:\s]*$/)
                    if (boundary > Math.floor(maxChars * 0.4)) {
                        cutIndex = boundary + 1
                    }
                    sentences.push(remaining.slice(0, cutIndex))
                    remaining = remaining.slice(cutIndex)
                }
                if (remaining.trim()) {
                    sentences.push(remaining)
                }
            }
        }

        const chunks = []
        let current = ''

        for (const s of sentences) {
            if (current && (current.length + s.length > maxChars)) {
                chunks.push(current.trim())
                current = s
            } else {
                current += s
            }
        }
        if (current && current.trim()) {
            chunks.push(current.trim())
        }

        const totalSubs = chunks.length
        return chunks.map((chunkText, idx) => ({
            id: `${para.id}_sub${idx}`,
            parentParaId: para.id,
            subChunkIndex: idx,
            totalSubChunks: totalSubs,
            text: chunkText,
            sourceHash: simpleTextHash(chunkText)
        }))
    }

    /**
     * Start the serialized translation task via TranslationJobCoordinator.
     * Respects cancellable cooldown between batches, sub-chunk recovery, and pure serializable batches.
     */
    async startCurrentChapterTranslation(options = {}) {
        if (this.resumeCurrentTask() || this._starting) return
        this._starting = true
        try { await this.runCurrentChapterTranslation(options) }
        finally { this._starting = false }
    }

    async runCurrentChapterTranslation({ restart = false, retryUnavailable = false } = {}) {
        this.closeConfirmModal()
        if (this.coordinator.busy) {
            this.app?.showToast?.(t('chapterTrans.toast.alreadyRunning'), 'warn')
            return
        }

        const secIdx = this.getCurrentSectionIndex()
        const doc = this.getSectionDocument(secIdx)
        if (!doc) {
            this.app?.showToast?.(t('chapterTrans.toast.noValidDocument'), 'warn')
            return
        }

        const paragraphs = this.extractChapterParagraphs(doc)
        if (paragraphs.length === 0) {
            this.app?.showToast?.(t('chapterTrans.toast.noTranslatableParas'), 'warn')
            return
        }

        const taskId = `task_${Date.now()}`
        this.activeTaskId = taskId

        this.showBilingualBar()
        this.updateProgressUI(0, paragraphs.length)

        const bookId = this.currentBookId
        const chapterKey = this.currentChapterKey
        const chapterTitle = this.currentChapterTitle

        const previous = this.cachedRecord
        const record = !restart && previous?.bookId === bookId && previous.chapterKey === chapterKey
            ? structuredClone(previous)
            : {
                id: `${bookId}::${chapterKey}`,
                bookId,
                chapterKey,
                title: chapterTitle,
                status: 'in_progress',
                targetLanguage: 'zh-CN',
                paragraphs: [],
                updatedAt: Date.now()
            }
        record.status = 'in_progress'
        if (restart && previous) {
            record.parentRevisionIds = previous.revisionId ? [previous.revisionId] : []
            const older = { ...previous, conflictRevisions: [] }
            record.conflictRevisions = [...(previous.conflictRevisions || []).slice(-2), older]
        }
        const aiCfg = getAiConfig()
        const style = !restart && record.promptVersion ? record.promptVersion.replace(/^translation-v1-/, '') : this.app?.advancedSettings?.config?.chapterTransStyle || 'auto'
        const requestConfig = Object.freeze({
            endpoint: (aiCfg.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, ''),
            model: aiCfg.model || 'gpt-4o-mini',
            maxTokens: Math.max(256, Math.min(20000, Number(this.app?.advancedSettings?.aiMaxTokens || aiCfg.maxTokens) || 2048)),
            transientRetries: retryUnavailable ? 2 : 0,
            sourceScope: [String(bookId), String(chapterKey), String(this.app?.currentBookData?.contentHash || bookId)],
            style
        })
        const existingMap = new Map((record.paragraphs || []).map(p => [p.id, p]))
        record.paragraphs = record.paragraphs.filter(old => paragraphs.some(p => p.id === old.id && p.sourceHash === old.sourceHash))

        // Split paragraphs into sub-chunks, skipping already completed sub-chunks
        const pendingSubChunks = []
        for (const p of paragraphs) {
            const candidate = existingMap.get(p.id)
            const prev = candidate?.sourceHash === p.sourceHash ? candidate : null
            if (candidate && !prev) record.paragraphs = record.paragraphs.filter(old => old.id !== p.id)
            if (prev && prev.translation && prev.sourceHash === p.sourceHash && prev.status === 'completed') {
                continue
            }
            const nonAscii = (p.text.match(/[^\x00-\x7f]/g) || []).length / Math.max(1, p.text.length)
            const outputDensity = nonAscii * 1.5 + (1 - nonAscii) * 0.65
            const maxChars = Math.max(48, Math.min(2400, Math.floor((requestConfig.maxTokens - 128) * 0.72 / outputDensity)))
            const hasAllBoundaries = Boolean(prev?.subChunks?.length && prev.subChunks.length === prev.subChunks[0].totalSubChunks)
            const subChunks = hasAllBoundaries
                ? prev.subChunks.map(sc => ({ ...sc, parentParaId: p.id }))
                : this.splitParagraphIntoSubChunks(p, prev?.subChunks?.length ? 320 : maxChars)
            const completedSubs = new Map(
                (prev?.subChunks || [])
                    .filter(sc => sc.status === 'completed' && sc.translation)
                    .map(sc => [sc.subChunkIndex, sc])
            )

            // Persist the full subdivision, including pending pieces, so a later resume keeps its IDs.
            const paraRecord = prev || { id: p.id, sourceText: p.text, sourceHash: p.sourceHash, translation: '', status: 'pending' }
            paraRecord.subChunks = subChunks.map(sc => {
                const old = completedSubs.get(sc.subChunkIndex)
                const translated = old?.text === sc.text ? old.translation : ''
                return { ...sc, translation: translated, status: translated ? 'completed' : 'pending' }
            })
            if (!prev) record.paragraphs.push(paraRecord)

            for (const sc of subChunks) {
                const existingSub = completedSubs.get(sc.subChunkIndex)
                if (existingSub && existingSub.text === sc.text && existingSub.translation) {
                    continue
                }
                pendingSubChunks.push(sc)
            }
        }

        // One source unit per response: a model cannot merge two units or omit an array item.
        const chunks = pendingSubChunks.map(sc => [sc])

        const identity = {
            bookContentHash: String(this.app?.currentBookData?.contentHash || bookId),
            chapterSourceKey: String(chapterKey),
            sourceHash: simpleTextHash(paragraphs.map(p => p.sourceHash).join(';')),
            parserVersion: 'foliate-txt-epub-v1',
            targetLanguage: 'zh-CN',
            promptVersion: `translation-v1-${style}`
        }

        record.sourceHash = identity.sourceHash
        record.bookStableKey = identity.bookContentHash
        record.contentHash = identity.bookContentHash
        record.chapterSourceKey = identity.chapterSourceKey
        record.parserVersion = identity.parserVersion
        record.targetLanguage = identity.targetLanguage
        record.promptVersion = identity.promptVersion
        record.totalParagraphs = paragraphs.length
        record.model = String(requestConfig.model)
        if (!record.revisionId) {
            record.revisionId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }

        const autoSave = this.app?.advancedSettings?.config?.chapterTransAutoSave !== false
        const remember = async (archive) => {
            this.sessionRecords.set(archive.id, archive)
            if (!autoSave) return { accepted: true, durable: false }
            const saved = await saveChapterTranslation(archive)
            if (saved === true) this.sessionRecords.delete(archive.id)
            return saved
        }
        if (chunks.length === 0) {
            record.status = 'completed'
            record.totalParagraphs = paragraphs.length
            const archive = formatArchiveRecord(record)
            const saved = await remember(archive)
            this.cachedRecord = archive
            if (saved === false) {
                this.app?.showToast?.(t('chapterTrans.toast.sessionSaveFailedRetry'), 'warn')
                this.activeTaskId = null
                return
            }
            this.updateToolbarState(true)
            this.updateProgressUI(paragraphs.length, paragraphs.length, autoSave ? t('chapterTrans.status.allDoneSaved') : t('chapterTrans.status.allDoneSession'))
            this.activeTaskId = null
            if (doc && this.viewMode !== 'source') {
                this.renderDerivedBilingualView(archive, doc)
            }
            return
        }

        let completedCount = record.paragraphs.filter(p => p.status === 'completed' && p.translation?.trim()).length

        // The broker queues against native admission state; do not estimate a second clock here.
        this.taskOwner = { bookId, chapterKey, total: paragraphs.length, completed: completedCount }
        try {
            const apiKey = await getAiApiKey()
            if (!apiKey) throw translationError('missing_key', t('chapterTrans.error.missingKeySettings'))
            if (this.currentBookId !== bookId || this.currentChapterKey !== chapterKey || this.activeTaskId !== taskId) return
            const frozenRequest = { ...requestConfig, apiKey }
            // Flush an earlier unsaved result locally before sending any further paid request.
            if (autoSave && this.sessionRecords.has(record.id) && await remember(formatArchiveRecord(record)) !== true) {
                throw translationError('save_failed', t('chapterTrans.error.saveFailedRetryFirst'))
            }
            const result = await this.coordinator.run({
                identity,
                chunks,
                request: async ({ chunk, signal, waitUntilRunnable }) => {
                    return await this.translateChunk(chunk, signal, frozenRequest, {
                        beforeDispatch: waitUntilRunnable,
                        onWait: ({ reason, remainingMs, retryIndex, maxRetries }) => {
                            if (this.activeTaskId !== taskId || this.currentBookId !== bookId || this.currentChapterKey !== chapterKey) return
                            const waitNote = reason === 'service'
                                ? t('chapterTrans.wait.serviceBusy', { seconds: Math.ceil(remainingMs / 1000), retry: retryIndex, max: maxRetries })
                                : reason === 'busy' ? t('chapterTrans.wait.busy') : t('chapterTrans.wait.cooldown', { seconds: Math.max(1, Math.ceil(remainingMs / 1000)) })
                            if (reason === 'service') this.app?.showToast?.(t('chapterTrans.toast.serviceRetryHint', { note: waitNote }), 'info')
                            this.updateProgressUI(completedCount, paragraphs.length, waitNote)
                        }
                    })
                },
                commit: async ({ chunk, translated, isCurrent }) => {
                    if (!isCurrent()) return false

                    for (const sc of chunk) {
                        const tr = (translated || []).find(t => t && t.id === sc.id)
                        const transText = tr?.translation || ''
                        const parentPara = paragraphs.find(p => p.id === sc.parentParaId)

                        let paraRecord = record.paragraphs.find(p => p.id === sc.parentParaId)
                        if (!paraRecord) {
                            paraRecord = {
                                id: sc.parentParaId,
                                sourceText: parentPara?.text || sc.text,
                                sourceHash: parentPara?.sourceHash || sc.sourceHash,
                                status: 'in_progress',
                                translation: '',
                                subChunks: []
                            }
                            record.paragraphs.push(paraRecord)
                        }
                        if (!Array.isArray(paraRecord.subChunks)) {
                            paraRecord.subChunks = []
                        }

                        const subRecord = {
                            id: sc.id,
                            subChunkIndex: sc.subChunkIndex,
                            totalSubChunks: sc.totalSubChunks,
                            text: sc.text,
                            sourceHash: sc.sourceHash,
                            translation: transText,
                            status: transText ? 'completed' : 'failed'
                        }
                        const existingSubIdx = paraRecord.subChunks.findIndex(s => s.id === sc.id)
                        if (existingSubIdx >= 0) {
                            paraRecord.subChunks[existingSubIdx] = subRecord
                        } else {
                            paraRecord.subChunks.push(subRecord)
                        }

                        // Complete parent paragraph only when all its sub-chunks succeed
                        const allSubsCompleted = paraRecord.subChunks.length === sc.totalSubChunks &&
                            paraRecord.subChunks.every(s => s.status === 'completed' && s.translation?.trim())

                        if (allSubsCompleted) {
                            paraRecord.subChunks.sort((a, b) => a.subChunkIndex - b.subChunkIndex)
                            paraRecord.translation = paraRecord.subChunks.map(s => s.translation.trim()).join(' ')
                            paraRecord.status = 'completed'
                        } else if (paraRecord.subChunks.some(s => s.status === 'failed')) {
                            paraRecord.status = 'partial'
                        }
                    }

                    completedCount = record.paragraphs.filter(p => p.status === 'completed' && p.translation?.trim()).length
                    record.updatedAt = Date.now()
                    record.totalParagraphs = paragraphs.length
                    const archive = formatArchiveRecord(record)
                    const saved = await remember(archive)
                    if (this.currentBookId === bookId && this.currentChapterKey === chapterKey) {
                        this.cachedRecord = archive
                        if (doc && this.viewMode !== 'source') {
                            try {
                                const changedParaIds = new Set(chunk.map(sc => sc.parentParaId).filter(Boolean))
                                this.renderDerivedBilingualView(archive, doc, changedParaIds)
                            } catch (renderError) {
                                console.warn('[ChapterTrans] Could not refresh bilingual view:', renderError)
                                this.app?.showToast?.(t('chapterTrans.toast.refreshFailed'), 'warn')
                            }
                        }
                    }
                    return saved
                },
                onProgress: (progress) => {
                    this.taskOwner.completed = completedCount
                    if (this.activeTaskId === taskId && this.currentBookId === bookId && this.currentChapterKey === chapterKey) {
                        this.updateProgressUI(completedCount, paragraphs.length, progress.waitingMs ? t('chapterTrans.status.waitingRecovery', { seconds: Math.ceil(progress.waitingMs / 1000) }) : t('chapterTrans.status.translating'))
                    }
                }
            })

            const allParagraphsCompleted = record.paragraphs.length >= paragraphs.length &&
                record.paragraphs.every(p => p.status === 'completed' && p.translation?.trim())

            record.status = result.status === 'completed' && allParagraphsCompleted ? 'completed' : 'partial'
            record.updatedAt = Date.now()
            const archive = formatArchiveRecord(record)
            if (await remember(archive) === false) throw translationError('save_failed', t('chapterTrans.error.saveFailed'))
            if (this.activeTaskId === taskId && this.currentBookId === bookId && this.currentChapterKey === chapterKey) {
                this.cachedRecord = archive
                this.updateToolbarState(true)
                const note = record.status === 'completed' ? (autoSave ? t('chapterTrans.status.allDoneSaved') : t('chapterTrans.status.completedSession')) : t('chapterTrans.status.stoppedKept')
                this.updateProgressUI(completedCount, paragraphs.length, note)
                this.app?.showToast?.(note, record.status === 'completed' ? 'success' : 'info')
            }
        } catch (e) {
            record.status = 'partial'
            record.updatedAt = Date.now()
            const archive = formatArchiveRecord(record)
            this._lastDiagnostic = e.diagnostic || { errorCode: e.code || 'request_failed' }
            // Keep structural failure evidence locally, without book text or credentials.
            void recordTranslationDiagnostic(this._lastDiagnostic).catch(() => {})
            let persisted = false
            const hasTranslations = record.paragraphs.some(p => p.translation || p.subChunks?.some(sc => sc.translation))
            if (hasTranslations) {
                try { persisted = await remember(archive) === true } catch (_) { this.sessionRecords.set(archive.id, archive) }
            }
            if (this.activeTaskId === taskId && this.currentBookId === bookId && this.currentChapterKey === chapterKey) {
                this.cachedRecord = archive
                this.updateToolbarState(record.paragraphs.length > 0)
                const reason = e.code ? e.message : t('chapterTrans.error.requestFailed', { detail: e.message || t('chapterTrans.error.unknown') })
                const storage = persisted ? t('chapterTrans.storage.persisted') : hasTranslations ? t('chapterTrans.storage.session') : t('chapterTrans.storage.none')
                this.app?.showToast?.(t('chapterTrans.toast.interrupted', { reason, storage }), 'warn')
                this.updateProgressUI(completedCount, paragraphs.length, t('chapterTrans.status.interrupted', { reason }))
                const note = typeof document === 'undefined' ? null : document.getElementById('chapter-trans-status-note')
                if (note && e.diagnostic) note.title = t('chapterTrans.diagnosticTitle', { batch: e.diagnostic.batchIndex || '?', matched: e.diagnostic.matched || 0, expected: e.diagnostic.expected || '?', code: e.code || 'request_failed' })
            }
        } finally {
            if (this.activeTaskId === taskId) {
                this.activeTaskId = null
                this.taskOwner = null
            }
        }
    }

    /**
     * Request translation for a paragraph chunk using protected AI broker.
     * Strictly verifies credentials, max_tokens, concurrency lock, and JSON structure.
     * Returns raw string response for TranslationJobCoordinator schema validation.
     */
    async translateChunk(chunk, signal, config = null, scheduling = {}) {
        if (!Array.isArray(chunk) || chunk.length !== 1) throw new Error(t('chapterTrans.error.singleUnitOnly'))
        const sourceText = chunk[0].text.trim()
        if (!/\p{L}/u.test(sourceText)) return { fullText: JSON.stringify({ translation: sourceText }), status: 'completed', finishReason: 'stop', translationProtocol: 'single-text-v1' }
        const aiCfg = config || getAiConfig()
        const apiKey = config?.apiKey || await getAiApiKey()
        if (!apiKey) throw translationError('missing_key', t('chapterTrans.error.missingKey'))
        const cleanEndpoint = (aiCfg.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '')
        const model = aiCfg.model || 'gpt-4o-mini'
        const maxTokens = config?.maxTokens || this.app?.advancedSettings?.aiMaxTokens || aiCfg.maxTokens || 2048
        const style = config?.style || this.app?.advancedSettings?.config?.chapterTransStyle || 'auto'
        let styleInstruction = ''
        if (style === 'literal') {
            styleInstruction = t('chapterTrans.prompt.styleFaithful')
        } else if (style === 'literary') {
            styleInstruction = t('chapterTrans.prompt.styleLiterary')
        } else if (style === 'academic') {
            styleInstruction = t('chapterTrans.prompt.styleAcademic')
        } else {
            styleInstruction = t('chapterTrans.prompt.styleAuto')
        }

        const systemPrompt = t('chapterTrans.prompt.system', { styleInstruction })
        const userPrompt = t('chapterTrans.prompt.user', { text: sourceText })

        const reqFn = typeof requestAiCompletion === 'function' ? requestAiCompletion : globalThis.requestAiCompletion
        if (!reqFn) {
            throw new Error(t('chapterTrans.error.nativeAdapterUnavailable'))
        }

        const response = await requestTranslationWithRecovery({
            signal,
            beforeDispatch: scheduling.beforeDispatch,
            onWait: scheduling.onWait,
            maxRetries: config?.transientRetries || 0,
            invoke: () => reqFn({
            purpose: 'chapterTranslation',
            endpoint: cleanEndpoint,
            model,
            apiKey,
            systemPrompt,
            prompt: userPrompt,
            maxTokens,
            requestScope: JSON.stringify([...(config?.sourceScope || [this.currentBookId, this.currentChapterKey]), chunk[0].id, chunk[0].sourceHash]),
            returnMetadata: true,
            queueIfBusy: true,
            beforeDispatch: scheduling.beforeDispatch,
            onWait: scheduling.onWait,
            signal
        })
        })
        return { ...(typeof response === 'string' ? { fullText: response, status: 'completed' } : response), translationProtocol: 'single-text-v1' }
    }

    /**
     * Injects or updates isolated styles for the derived bilingual reading view.
     * Original document content remains intact; when active, source nodes are hidden
     * while derived reading blocks (with source anchor mapping) are displayed.
     */
    ensureDerivedStyles(doc) {
        if (!doc || !doc.createElement) return
        let style = doc.getElementById('linden-derived-reader-styles')
        if (!style) {
            style = doc.createElement('style')
            style.id = 'linden-derived-reader-styles'
            doc.head ? doc.head.appendChild(style) : (doc.body ? doc.body.appendChild(style) : null)
        }
        const styles = `
            .linden-bilingual-target {
                display: block;
                color: inherit;
                font-size: 0.95em;
                line-height: inherit;
                text-indent: 0 !important;
                border: 0;
                border-inline-start: 2px solid color-mix(in srgb, currentColor 18%, transparent);
                padding-inline-start: 0.8em;
                margin-block: 0.5em 1.15em !important;
                opacity: 1;
                box-sizing: border-box;
                overflow-wrap: break-word;
                break-inside: avoid;
                -webkit-column-break-inside: avoid;
                break-before: avoid;
                box-decoration-break: clone;
                -webkit-box-decoration-break: clone;
            }
            .linden-bilingual-target.linden-long-paragraph {
                break-inside: auto;
                -webkit-column-break-inside: auto;
                break-before: auto;
            }
            .linden-bilingual-source { break-after: avoid; break-inside: avoid; -webkit-column-break-inside: avoid; }
            .linden-bilingual-source.linden-long-paragraph { break-after: auto; break-inside: auto; -webkit-column-break-inside: auto; }
            body.linden-trans-mode-bilingual .linden-bilingual-source[data-linden-script="latin"] {
                text-align: start !important;
                text-align-last: start !important;
                word-spacing: normal !important;
            }
            .linden-bilingual-target:empty { display: none; }
            .linden-bilingual-target.pending { color: inherit; opacity: .65; font-style: normal; }
            body.linden-trans-mode-target .linden-bilingual-source {
                display: none !important;
            }
            body.linden-trans-mode-target [data-linden-container-source="true"] {
                font-size: 0 !important;
                line-height: 0 !important;
            }
            body.linden-trans-mode-target [data-linden-container-source="true"]::marker {
                font-size: 1rem !important;
            }
            body.linden-trans-mode-target [data-linden-container-source="true"] > :not(.linden-bilingual-target) {
                display: none !important;
            }
            body.linden-trans-mode-target [data-linden-container-source="true"] > .linden-bilingual-target {
                font-size: 1rem !important;
                line-height: 1.6 !important;
                border-left: none;
                padding-left: 0;
                opacity: 1;
            }
            body.linden-trans-mode-target .linden-bilingual-target {
                border-left: none;
                padding-left: 0;
                color: inherit;
                font-size: inherit;
                line-height: inherit;
                opacity: 1;
            }
            body.linden-trans-mode-source .linden-bilingual-target {
                display: none !important;
            }
        `
        if (style.textContent !== styles) style.textContent = styles
    }

    /**
     * Renders or updates inline bilingual reading view without mutating or flattening original document structure.
     * Retains all parent containers, articles, sections, images, tables, formulas, and footnote anchors.
     */
    renderDerivedBilingualView(record, doc, changedParaIds = null) {
        if (!doc) return
        this.showBilingualBar()

        const paras = this.extractChapterParagraphs(doc)
        if (paras.length === 0) {
            this.removeDerivedBilingualView(doc)
            return
        }

        this.ensureDerivedStyles(doc)

        // Remove old deprecated derived container if present
        const oldContainer = doc.getElementById('linden-derived-bilingual-view')
        if (oldContainer) oldContainer.remove()

        if (doc.body) {
            doc.body.classList.remove('linden-trans-mode-source', 'linden-trans-mode-bilingual', 'linden-trans-mode-target', 'linden-derived-view-active')
            doc.body.classList.add(`linden-trans-mode-${this.viewMode}`)
        }

        const transMap = new Map((record?.paragraphs || []).map(p => [p.id, p]))
        const targetParas = (changedParaIds && (changedParaIds.size > 0 || (Array.isArray(changedParaIds) && changedParaIds.length > 0)))
            ? paras.filter(p => changedParaIds.has ? changedParaIds.has(p.id) : changedParaIds.includes(p.id))
            : paras

        targetParas.forEach(p => {
            const entry = transMap.get(p.id)
            const transText = (entry && entry.sourceHash === p.sourceHash && (entry.status === 'completed' || entry.translation))
                ? (entry.translation || '')
                : ''

            const sourceEl = this.displayElementMap.get(p.id)
            if (!sourceEl || !sourceEl.parentNode) return

            const tag = (p.tag || (sourceEl.tagName ? sourceEl.tagName.toLowerCase() : 'div'))
            const isContainedItem = tag === 'td' || tag === 'th' || tag === 'li'
            if (isContainedItem) {
                sourceEl.classList.remove('linden-bilingual-source')
                sourceEl.setAttribute('data-linden-container-source', 'true')
            } else {
                sourceEl.removeAttribute('data-linden-container-source')
                sourceEl.classList.add('linden-bilingual-source')
            }
            sourceEl.setAttribute('data-linden-source-id', p.id)
            if (!sourceEl.hasAttribute('data-linden-script')) {
                const letters = p.text.match(/\p{L}/gu) || []
                const latin = p.text.match(/[A-Za-z]/g) || []
                const aligned = doc.defaultView?.getComputedStyle?.(sourceEl)?.textAlign
                const isLatinProse = p.tag === 'p' && latin.length > letters.length * 0.7 && !['center', 'right', 'end'].includes(aligned) && !sourceEl.matches?.('.poetry, .verse, [data-poetry-line]')
                sourceEl.setAttribute('data-linden-script', isLatinProse ? 'latin' : 'other')
            }
            if ((p.text && p.text.length > 300) || (transText && transText.length > 300)) {
                sourceEl.classList.add('linden-long-paragraph')
            } else {
                sourceEl.classList.remove('linden-long-paragraph')
            }

            const escapedAnchor = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(p.id) : p.id
            let targetEl = isContainedItem
                ? Array.from(sourceEl.children || []).find(el => el.classList?.contains('linden-bilingual-target') && el.getAttribute('data-target-anchor') === p.id)
                : sourceEl.nextElementSibling
            if (!targetEl || !targetEl.classList.contains('linden-bilingual-target') || targetEl.getAttribute('data-target-anchor') !== p.id) {
                targetEl = doc.querySelector?.(`.linden-bilingual-target[data-target-anchor="${escapedAnchor}"]`)
            }

            if (!targetEl) {
                if (isContainedItem) {
                    targetEl = doc.createElement('div')
                } else if (tag === 'p') {
                    targetEl = doc.createElement('p')
                } else if (tag === 'tr') {
                    targetEl = doc.createElement('tr')
                    const td = doc.createElement('td')
                    td.colSpan = sourceEl.children?.length || 1
                    targetEl.appendChild(td)
                } else {
                    targetEl = doc.createElement('div')
                }
                targetEl.className = 'linden-bilingual-target'
                targetEl.setAttribute('data-target-anchor', p.id)
                targetEl.setAttribute('role', 'region')
                targetEl.setAttribute('aria-label', t('chapterTrans.ariaTranslated'))
                targetEl.setAttribute('lang', 'zh-Hans')
                if (isContainedItem) {
                    sourceEl.appendChild(targetEl)
                } else {
                    sourceEl.insertAdjacentElement('afterend', targetEl)
                }
            }

            const textTarget = targetEl.tagName === 'TR' ? (targetEl.firstElementChild || targetEl) : targetEl
            if ((p.text && p.text.length > 300) || (transText && transText.length > 300)) {
                targetEl.classList.add('linden-long-paragraph')
            } else {
                targetEl.classList.remove('linden-long-paragraph')
            }
            if (transText) {
                if (textTarget.textContent !== transText) textTarget.textContent = transText
                targetEl.classList.remove('pending')
            } else if (entry && entry.status === 'in_progress') {
                targetEl.classList.add('pending')
                const loadingLabel = t('chapterTrans.status.translatingEllipsis')
                if (textTarget.textContent !== loadingLabel) textTarget.textContent = loadingLabel
            } else {
                if (textTarget.textContent) textTarget.textContent = ''
                targetEl.classList.remove('pending')
            }
        })
    }

    /**
     * Resolves source document anchor from a derived node or paragraph ID.
     */
    resolveSourceAnchor(nodeOrParaId) {
        if (!nodeOrParaId) return null
        let id = null
        if (typeof nodeOrParaId === 'string') {
            id = nodeOrParaId
        } else {
            const el = nodeOrParaId.nodeType === 3 ? nodeOrParaId.parentElement : nodeOrParaId
            id = el?.closest?.('[data-linden-source-id]')?.getAttribute('data-linden-source-id') ||
                 el?.closest?.('[data-target-anchor]')?.getAttribute('data-target-anchor')
        }
        if (!id) return null
        return this.derivedToSourceAnchorMap.get(id) || null
    }

    /**
     * Navigates back to the original source anchor in the untampered source document.
     */
    navigateToSourceAnchor(paraId, doc = null) {
        const anchor = this.resolveSourceAnchor(paraId)
        if (!anchor?.sourceElement) return false
        this.setViewMode('source')
        try {
            anchor.sourceElement.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
            return true
        } catch (_) {
            return false
        }
    }

    /**
     * Removes the bilingual view elements and restores normal display of original DOM.
     * Strictly NEVER leaves behind mutated DOM elements in original chapter content.
     */
    removeDerivedBilingualView(doc) {
        if (!doc) return
        if (doc.body) {
            doc.body.classList.remove('linden-trans-mode-source', 'linden-trans-mode-bilingual', 'linden-trans-mode-target', 'linden-derived-view-active')
        }
        doc.querySelectorAll?.('.linden-bilingual-target')?.forEach(el => el.remove())
        doc.querySelectorAll?.('.linden-bilingual-source, [data-linden-container-source="true"]')?.forEach(el => {
            el.classList.remove('linden-bilingual-source', 'linden-long-paragraph')
            el.removeAttribute('data-linden-container-source')
            el.removeAttribute('data-linden-source-id')
            el.removeAttribute('data-linden-script')
        })
        const container = doc.getElementById('linden-derived-bilingual-view')
        if (container) container.remove()
        const style = doc.getElementById('linden-derived-reader-styles')
        if (style) style.remove()
        const oldStyle = doc.getElementById('bilingual-reader-styles')
        if (oldStyle) oldStyle.remove()
    }

    // Backward-compatibility aliases
    renderBilingualView(record, doc) {
        return this.renderDerivedBilingualView(record, doc)
    }

    removeInjectedElements(doc) {
        return this.removeDerivedBilingualView(doc)
    }

    injectTranslationElement(paraEl, paraId, transText) {
        if (!paraEl) return
        this.displayElementMap.set(paraId, paraEl)
        const doc = paraEl.ownerDocument || document
        const escapedAnchor = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(paraId) : paraId
        const targetEl = doc.querySelector?.(`.linden-bilingual-target[data-target-anchor="${escapedAnchor}"]`)
        if (targetEl) {
            targetEl.textContent = transText
            targetEl.classList.remove('pending')
        }
    }

    setViewMode(mode) {
        this.viewMode = mode // 'source' | 'bilingual' | 'target'
        const doc = this.getSectionDocument()
        if (doc) {
            this.renderDerivedBilingualView(this.cachedRecord, doc)
        }

        const modes = ['source', 'bilingual', 'target']
        modes.forEach(m => {
            const btn = this.dom[`btnTransMode${m.charAt(0).toUpperCase() + m.slice(1)}`]
            if (btn) {
                btn.setAttribute('aria-pressed', String(m === mode))
                if (m === mode) btn.classList.add('active')
                else btn.classList.remove('active')
            }
        })
    }

    applyViewModeStyles(doc = null) {
        const targetDoc = doc || this.getSectionDocument()
        if (targetDoc) {
            this.renderDerivedBilingualView(this.cachedRecord, targetDoc)
        }
    }

    stop() {
        this.coordinator.stop()
        if (this.abortController) {
            try { this.abortController.abort() } catch (_) {}
            this.abortController = null
        }
        this.updateToolbarState(Boolean(this.cachedRecord?.paragraphs?.length))
    }

    stopTranslation() {
        this.stop()
        this.app?.showToast?.(t('chapterTrans.toast.stopRequested'), 'info')
    }

    async onCloseBook() {
        this.stop()
        try {
            await this.coordinator.finalizePromise
        } catch (_) {}
        this.activeTaskId = null
        this.cachedRecord = null
        this.taskOwner = null
        this.sessionRecords.clear()
        this.currentBookId = null
        this.currentChapterKey = null
        this.hideBilingualBar()
        this.updateToolbarState(false)
    }

    async clearCurrentChapterTranslation() {
        const targetBookId = this.currentBookId
        const targetChapterKey = this.currentChapterKey
        if (!targetBookId || !targetChapterKey) return

        if (this.coordinator.busy) {
            this.coordinator.stop()
            try {
                await this.coordinator.finalizePromise
            } catch (_) {}
        }

        await deleteChapterTranslation(targetBookId, targetChapterKey)
        this.sessionRecords.delete(`${targetBookId}::${targetChapterKey}`)
        if (this.currentBookId === targetBookId && this.currentChapterKey === targetChapterKey) {
            this.cachedRecord = null
            const secIdx = this.getCurrentSectionIndex()
            const doc = this.getSectionDocument(secIdx)
            if (doc) {
                this.removeInjectedElements(doc)
            }
            this.hideBilingualBar()
            this.updateToolbarState(false)
        }
        this.app?.showToast?.(t('chapterTrans.toast.clearedCache'), 'info')
    }

    showBilingualBar() {
        const bar = this.dom.chapterTransBar
        if (bar) {
            bar.style.display = 'grid'
            bar.closest?.('#reader-view')?.classList.add('has-chapter-translation')
        }
    }

    hideBilingualBar() {
        const bar = this.dom.chapterTransBar
        if (bar) {
            bar.style.display = 'none'
            bar.closest?.('#reader-view')?.classList.remove('has-chapter-translation')
        }
    }

    updateProgressUI(completed, total, note = '') {
        if (typeof document === 'undefined') return
        const progLabel = document.getElementById('chapter-trans-progress-label')
        const progFill = document.getElementById('chapter-trans-progress-fill')
        const noteEl = document.getElementById('chapter-trans-status-note')

        if (progLabel) {
            progLabel.innerText = t('chapterTrans.progress.count', { completed, total })
        }
        if (progFill && total > 0) {
            const pct = Math.min(100, Math.round((completed / total) * 100))
            progFill.style.width = `${pct}%`
        }
        if (noteEl) {
            noteEl.innerText = note || t('chapterTrans.status.ready')
            noteEl.title = note || t('chapterTrans.status.ready')
        }
    }

}

export const chapterTranslationManager = new ChapterTranslationManager()
