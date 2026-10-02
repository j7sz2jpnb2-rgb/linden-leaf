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
    buildTranslationRevisionArchive
} from './translation-job-core.js'

import {
    requestAiCompletion,
    getAiConfig,
    getAiApiKey
} from './reading-ai-assistant.js'

function simpleTextHash(str) {
    if (!str) return '0'
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i)
        hash |= 0
    }
    return String(Math.abs(hash))
}

function escapeHtml(str) {
    if (!str) return ''
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
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

export const FEATURE_CHAPTER_TRANSLATION_ENABLED = false

export class ChapterTranslationManager {
    constructor(app = null) {
        this.app = app
        this.currentBookId = null
        this.currentChapterKey = null
        this.currentChapterTitle = ''
        this.activeTaskId = null
        this.abortController = null
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
            this.startCurrentChapterTranslation()
        })
        this.dom.btnChapterTransStop?.addEventListener('click', () => {
            this.stopTranslation()
        })
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
            if (this.currentBookId && this.currentBookId !== bookId) {
                this.coordinator.stop()
                this.app?.showToast?.('已切换书籍，前一本书的章节翻译已停止', 'info')
            } else if (this.currentChapterKey && this.currentChapterKey !== `sec_${sectionIndex}`) {
                this.coordinator.pause()
                this.app?.showToast?.('已切换章节，当前翻译任务已暂停，返回后可继续', 'info')
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

        this.cachedRecord = saved

        const autoRestore = this.app?.advancedSettings?.config?.chapterTransAutoRestore !== false

        if (saved && saved.paragraphs && saved.paragraphs.length > 0) {
            this.updateToolbarState(true)
            const completed = saved.paragraphs.filter(p => p.status === 'completed' && p.translation?.trim()).length
            this.updateProgressUI(completed, saved.totalParagraphs || completed,
                saved.status === 'completed' ? '本章译文已保存' : '部分译文已保存，可继续翻译')
            // Auto restore if enabled and viewMode is bilingual or target
            if (this.viewMode !== 'source' && autoRestore) {
                const doc = sectionDoc || this.getSectionDocument(sectionIndex)
                if (doc) {
                    this.renderBilingualView(saved, doc)
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
        return `第 ${Number(sectionIndex) + 1} 章节`
    }

    updateToolbarState(isTranslated) {
        const btn = this.dom.btnChapterTranslate
        if (!btn) return
        if (isTranslated) {
            btn.classList.add('active-translated')
            const partial = this.cachedRecord?.status !== 'completed'
            btn.setAttribute('title', `${partial ? '继续翻译' : '查看本章双语译文'} (${this.currentChapterTitle})`)
            const span = btn.querySelector('.btn-label')
            if (span) span.innerText = partial ? '继续翻译' : '查看双语'
        } else {
            btn.classList.remove('active-translated')
            btn.setAttribute('title', `翻译当前章节 (${this.currentChapterTitle})`)
            const span = btn.querySelector('.btn-label')
            if (span) span.innerText = '翻译本章'
        }
    }

    handleToolbarClick() {
        if (!FEATURE_CHAPTER_TRANSLATION_ENABLED) return
        if (this.isTranslating) {
            this.showBilingualBar()
            return
        }

        if (this.cachedRecord?.paragraphs?.length > 0 && this.cachedRecord.status !== 'completed') {
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
            .filter(p => p.status === 'completed' && p.translation?.trim())
            .map(p => p.id))
        const pending = paras.filter(p => !completedIds.has(p.id))

        const titleEl = document.getElementById('chapter-trans-confirm-title')
        const countEl = document.getElementById('chapter-trans-confirm-count')
        const tokensEl = document.getElementById('chapter-trans-confirm-tokens')

        if (titleEl) titleEl.innerText = this.currentChapterTitle
        if (countEl) countEl.innerText = `${pending.length} 个待翻译段落（全章 ${paras.length} 段）`
        if (tokensEl) {
            const estimatedTokens = Math.round(pending.reduce((acc, p) => acc + p.text.length * 1.5, 0))
            tokensEl.innerText = `约 ${estimatedTokens.toLocaleString()} 词元`
        }

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

    /**
     * Extract paragraphs safely from current section DOM.
     * Extracts only leaf semantic blocks to prevent duplicating containers and children.
     * Strictly returns pure serializable data (zero DOM element references).
     * Keeps DOM element references in display-layer maps to prevent DataCloneError.
     */
    extractChapterParagraphs(doc) {
        if (!doc || typeof doc.querySelectorAll !== 'function') return []
        const candidates = doc.querySelectorAll('p, blockquote, h1, h2, h3, h4, h5, h6, li')
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
            if (el.querySelector('p, blockquote, h1, h2, h3, h4, h5, h6, li')) return

            const rawText = el.textContent ? el.textContent.trim() : ''
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
    async startCurrentChapterTranslation() {
        this.closeConfirmModal()
        if (this.coordinator.busy) {
            this.app?.showToast?.('当前已有正在执行的翻译任务', 'warn')
            return
        }

        const secIdx = this.getCurrentSectionIndex()
        const doc = this.getSectionDocument(secIdx)
        if (!doc) {
            this.app?.showToast?.('未检测到有效的正文档案', 'warn')
            return
        }

        const paragraphs = this.extractChapterParagraphs(doc)
        if (paragraphs.length === 0) {
            this.app?.showToast?.('当前章节未提取到可翻译的有效段落', 'warn')
            return
        }

        const taskId = `task_${Date.now()}`
        this.activeTaskId = taskId

        this.showBilingualBar()
        this.updateProgressUI(0, paragraphs.length)

        const bookId = this.currentBookId
        const chapterKey = this.currentChapterKey
        const chapterTitle = this.currentChapterTitle

        const record = this.cachedRecord && this.cachedRecord.bookId === bookId && this.cachedRecord.chapterKey === chapterKey
            ? structuredClone(this.cachedRecord)
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

        const existingMap = new Map((record.paragraphs || []).map(p => [p.id, p]))

        // Split paragraphs into sub-chunks, skipping already completed sub-chunks
        const pendingSubChunks = []
        for (const p of paragraphs) {
            const prev = existingMap.get(p.id)
            if (prev && prev.translation && prev.sourceHash === p.sourceHash && prev.status === 'completed') {
                continue
            }
            const subChunks = this.splitParagraphIntoSubChunks(p, 320)
            const completedSubs = new Map(
                (prev?.subChunks || [])
                    .filter(sc => sc.status === 'completed' && sc.translation)
                    .map(sc => [sc.subChunkIndex, sc])
            )

            for (const sc of subChunks) {
                if (completedSubs.has(sc.subChunkIndex)) {
                    continue
                }
                pendingSubChunks.push(sc)
            }
        }

        // Group sub-chunks into chunks respecting token budget (approx. 500 tokens per chunk)
        const chunks = []
        let currentChunk = []
        let currentTokens = 0
        const MAX_CHUNK_TOKENS = 500

        for (const sc of pendingSubChunks) {
            const est = Math.ceil((sc.text.length || 0) * 1.5)
            if (currentChunk.length > 0 && currentTokens + est > MAX_CHUNK_TOKENS) {
                chunks.push(currentChunk)
                currentChunk = [sc]
                currentTokens = est
            } else {
                currentChunk.push(sc)
                currentTokens += est
            }
        }
        if (currentChunk.length > 0) {
            chunks.push(currentChunk)
        }

        const identity = {
            bookContentHash: String(this.app?.currentBookData?.contentHash || bookId),
            chapterSourceKey: String(chapterKey),
            sourceHash: simpleTextHash(paragraphs.map(p => p.sourceHash).join(';')),
            parserVersion: 'foliate-txt-epub-v1',
            targetLanguage: 'zh-CN',
            promptVersion: `translation-v1-${this.app?.advancedSettings?.config?.chapterTransStyle || 'auto'}`
        }

        record.sourceHash = identity.sourceHash
        record.bookStableKey = identity.bookContentHash
        record.contentHash = identity.bookContentHash
        record.chapterSourceKey = identity.chapterSourceKey
        record.parserVersion = identity.parserVersion
        record.targetLanguage = identity.targetLanguage
        record.promptVersion = identity.promptVersion
        record.totalParagraphs = paragraphs.length
        record.model = String(this.app?.advancedSettings?.config?.model || 'gpt-4o-mini')
        if (!record.revisionId) {
            record.revisionId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }

        if (chunks.length === 0) {
            record.status = 'completed'
            record.totalParagraphs = paragraphs.length
            const archive = formatArchiveRecord(record)
            await saveChapterTranslation(archive)
            this.cachedRecord = archive
            this.updateToolbarState(true)
            this.updateProgressUI(paragraphs.length, paragraphs.length, '本章此前已全部翻译完成')
            this.activeTaskId = null
            if (doc && this.viewMode !== 'source') {
                this.renderDerivedBilingualView(archive, doc)
            }
            return
        }

        const autoSave = this.app?.advancedSettings?.config?.chapterTransAutoSave !== false
        let completedCount = record.paragraphs.filter(p => p.status === 'completed' && p.translation?.trim()).length

        // Cooldown between batches (0 to 3600 seconds, default 10)
        const configuredCooldown = Number(this.app?.advancedSettings?.config?.aiCooldownSeconds ?? 10)
        const cooldownMs = Number.isFinite(configuredCooldown) && configuredCooldown > 0 ? configuredCooldown * 1000 : 0

        try {
            const result = await this.coordinator.run({
                identity,
                chunks,
                cooldownMs,
                request: async ({ chunk, signal }) => {
                    return await this.translateChunk(chunk, signal)
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
                    if (autoSave) {
                        const saved = await saveChapterTranslation(archive)
                        if (saved !== true) return false
                    }
                    if (this.currentBookId === bookId && this.currentChapterKey === chapterKey) {
                        this.cachedRecord = archive
                        if (doc && this.viewMode !== 'source') {
                            try {
                                this.renderDerivedBilingualView(archive, doc)
                            } catch (renderError) {
                                console.warn('[ChapterTrans] Could not refresh bilingual view:', renderError)
                                this.app?.showToast?.('译文已保存，但双语视图刷新失败；重新进入章节可恢复', 'warn')
                            }
                        }
                    }
                    return true
                },
                onProgress: () => {
                    this.updateProgressUI(completedCount, paragraphs.length, `正在翻译 ${completedCount} / ${paragraphs.length} 段...`)
                }
            })

            const allParagraphsCompleted = record.paragraphs.length >= paragraphs.length &&
                record.paragraphs.every(p => p.status === 'completed' && p.translation?.trim())

            if (result.status === 'completed' && allParagraphsCompleted) {
                record.status = 'completed'
                const archive = formatArchiveRecord(record)
                if (autoSave) await saveChapterTranslation(archive)
                this.cachedRecord = archive
                this.updateToolbarState(true)
                this.updateProgressUI(paragraphs.length, paragraphs.length, '翻译已全部完成')
                this.app?.showToast?.(`《${chapterTitle}》双语翻译已全部完成`, 'success')
            } else {
                record.status = 'partial'
                const archive = formatArchiveRecord(record)
                if (autoSave) await saveChapterTranslation(archive)
                this.cachedRecord = archive
                this.updateToolbarState(true)
                this.updateProgressUI(completedCount, paragraphs.length, '部分段落未完成或已取消')
            }
        } catch (e) {
            console.error('[ChapterTrans] Translation failed:', e)
            record.status = 'partial'
            const archive = formatArchiveRecord(record)
            if (autoSave) {
                try { await saveChapterTranslation(archive) } catch (_) {}
            }
            this.cachedRecord = archive
            this.updateToolbarState(true)
            const reason = /输出长度|length|token/i.test(e?.message || '')
                ? '模型输出达到长度上限'
                : /JSON|translation response|paragraph translation/i.test(e?.message || '')
                    ? '模型返回格式不完整'
                    : /durably saved/i.test(e?.message || '')
                        ? '本地保存未完成'
                        : '请求或处理失败'
            this.app?.showToast?.(`翻译中断：${reason}。已保存完成的段落，可再次点击“翻译本章”继续。`, 'warn')
            this.updateProgressUI(completedCount, paragraphs.length, `翻译中断：${reason}；可继续`)
        } finally {
            if (this.activeTaskId === taskId) {
                this.activeTaskId = null
            }
        }
    }

    /**
     * Request translation for a paragraph chunk using protected AI broker.
     * Strictly verifies credentials, max_tokens, concurrency lock, and JSON structure.
     * Returns raw string response for TranslationJobCoordinator schema validation.
     */
    async translateChunk(chunk, signal) {
        if (!Array.isArray(chunk) || chunk.length === 0) return '[]'

        const payloadItems = chunk.map(p => ({ id: p.id, text: p.text }))

        let apiKey = ''
        if (typeof getAiApiKey === 'function') {
            apiKey = await getAiApiKey()
        } else if (typeof globalThis.getAiApiKey === 'function') {
            apiKey = await globalThis.getAiApiKey()
        } else if (typeof localStorage !== 'undefined') {
            apiKey = (localStorage.getItem('reading_ai_api_key') || localStorage.getItem('linden_ai_api_key') || '').trim()
        }

        if (!apiKey) {
            throw new Error('未配置 AI API Key，请在排版设置中填写 API 密钥')
        }

        const aiCfg = typeof getAiConfig === 'function' ? getAiConfig() : (globalThis.getAiConfig?.() || {})
        const endpoint = aiCfg.endpoint || (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_ai_endpoint') : null) || 'https://api.openai.com/v1'
        const cleanEndpoint = endpoint.replace(/\/+$/, '')
        const model = aiCfg.model || (typeof localStorage !== 'undefined' ? localStorage.getItem('linden_ai_model') : null) || 'gpt-4o-mini'
        const maxTokens = this.app?.advancedSettings?.aiMaxTokens || aiCfg.maxTokens || 2048

        const style = this.app?.advancedSettings?.config?.chapterTransStyle || 'auto'
        let styleInstruction = ''
        if (style === 'literal') {
            styleInstruction = '严格忠实原意，字句精准对应，避免过度润色。'
        } else if (style === 'literary') {
            styleInstruction = '在忠实原意基础上追求文学优美与文采润色，行文自然流畅，但不增减事实情节。'
        } else if (style === 'academic') {
            styleInstruction = '学术专业严谨风格，专有名词与术语准确统一，逻辑严密清晰。'
        } else {
            styleInstruction = '文学文本可自然润色，但不增添情节、事实或观点；论文与专业文本须术语准确、逻辑清楚、表达自然。'
        }

        const systemPrompt = `将各段原文译成简体中文，保留段落对应关系和全部原意。${styleInstruction}统一专名与术语，不擅自补全不确定内容。只返回包含 id 和 translation 字段的 JSON 数组。`
        const userPrompt = `请翻译以下段落：\n${JSON.stringify(payloadItems, null, 2)}`

        const reqFn = typeof requestAiCompletion === 'function' ? requestAiCompletion : globalThis.requestAiCompletion
        if (!reqFn) {
            throw new Error('受保护的原生 AI 适配器不可用')
        }

        const response = await reqFn({
            endpoint: cleanEndpoint,
            model,
            apiKey,
            systemPrompt,
            prompt: userPrompt,
            maxTokens,
            returnMetadata: true,
            signal
        })
        if (response?.status === 'cancelled') throw new Error('翻译已停止')
        const rawText = typeof response === 'string' ? response : (response?.fullText || response?.text || '')
        const finishReason = typeof response === 'string' ? null : response?.finishReason
        if (finishReason === 'length' || finishReason === 'max_tokens') {
            try {
                const salvaged = validateTranslationResponse(rawText, chunk.map(p => p.id))
                if (salvaged && salvaged.length > 0) {
                    return rawText
                }
            } catch (_) {}
            throw new Error('模型输出长度达到上限，请提高单次回答长度或换用支持更长输出的模型')
        }
        return rawText
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
            style.textContent = `
                .linden-bilingual-target {
                    display: block;
                    line-height: 1.6;
                    color: var(--text-secondary, #475569);
                    font-size: 0.95em;
                    border-left: 2.5px solid var(--accent, #d97706);
                    padding-left: 8px;
                    margin: 0.35em 0 0.85em 0;
                    opacity: 0.92;
                    box-sizing: border-box;
                    break-inside: avoid !important;
                    -webkit-column-break-inside: avoid !important;
                    break-before: avoid !important;
                }
                .linden-bilingual-source {
                    break-after: avoid !important;
                }
                .linden-bilingual-target:empty {
                    display: none;
                }
                .linden-bilingual-target.pending {
                    color: var(--text-muted, #94a3b8);
                    font-style: italic;
                    border-left-color: var(--border-color, #cbd5e1);
                }
                body.linden-trans-mode-target .linden-bilingual-source {
                    display: none !important;
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
            doc.head ? doc.head.appendChild(style) : (doc.body ? doc.body.appendChild(style) : null)
        }
    }

    /**
     * Renders or updates inline bilingual reading view without mutating or flattening original document structure.
     * Retains all parent containers, articles, sections, images, tables, formulas, and footnote anchors.
     */
    renderDerivedBilingualView(record, doc) {
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

        paras.forEach(p => {
            const entry = transMap.get(p.id)
            const transText = (entry && entry.sourceHash === p.sourceHash && (entry.status === 'completed' || entry.translation))
                ? (entry.translation || '')
                : ''

            const sourceEl = this.displayElementMap.get(p.id)
            if (!sourceEl || !sourceEl.parentNode) return

            sourceEl.classList.add('linden-bilingual-source')
            sourceEl.setAttribute('data-linden-source-id', p.id)

            let targetEl = sourceEl.nextElementSibling
            if (!targetEl || !targetEl.classList.contains('linden-bilingual-target') || targetEl.getAttribute('data-target-anchor') !== p.id) {
                targetEl = doc.querySelector?.(`.linden-bilingual-target[data-target-anchor="${p.id}"]`)
            }

            if (!targetEl) {
                const tag = sourceEl.tagName ? sourceEl.tagName.toLowerCase() : 'div'
                if (tag === 'li') {
                    targetEl = doc.createElement('li')
                    targetEl.style.listStyle = 'none'
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
                targetEl.setAttribute('aria-label', '译文')
                sourceEl.insertAdjacentElement('afterend', targetEl)
            }

            const textTarget = targetEl.tagName === 'TR' ? (targetEl.firstElementChild || targetEl) : targetEl
            if (transText) {
                textTarget.textContent = transText
                targetEl.classList.remove('pending')
            } else if (entry && entry.status === 'in_progress') {
                targetEl.classList.add('pending')
                textTarget.textContent = '(正在翻译此段...)'
            } else {
                textTarget.textContent = ''
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
        doc.querySelectorAll?.('.linden-bilingual-source')?.forEach(el => {
            el.classList.remove('linden-bilingual-source')
            el.removeAttribute('data-linden-source-id')
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
        const targetEl = doc.querySelector?.(`.linden-bilingual-target[data-target-anchor="${paraId}"]`)
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
        this.activeTaskId = null
        this.updateToolbarState(false)
    }

    stopTranslation() {
        this.stop()
        this.updateProgressUI(0, 0, '已停止翻译任务')
        this.app?.showToast?.('已停止翻译本章任务，已完成段落已妥善保存在本地', 'info')
    }

    async onCloseBook() {
        this.stop()
        try {
            await this.coordinator.finalizePromise
        } catch (_) {}
        this.activeTaskId = null
        this.cachedRecord = null
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
        this.app?.showToast?.('已清空本章双语译文缓存', 'info')
    }

    showBilingualBar() {
        const bar = this.dom.chapterTransBar
        if (bar) bar.style.display = 'flex'
    }

    hideBilingualBar() {
        const bar = this.dom.chapterTransBar
        if (bar) bar.style.display = 'none'
    }

    updateProgressUI(completed, total, note = '') {
        if (typeof document === 'undefined') return
        const progLabel = document.getElementById('chapter-trans-progress-label')
        const progFill = document.getElementById('chapter-trans-progress-fill')
        const noteEl = document.getElementById('chapter-trans-status-note')

        if (progLabel) {
            progLabel.innerText = `${completed} / ${total} 段`
        }
        if (progFill && total > 0) {
            const pct = Math.min(100, Math.round((completed / total) * 100))
            progFill.style.width = `${pct}%`
        }
        if (noteEl && note) {
            noteEl.innerText = note
        }
    }

    /**
     * Synchronously stop translation coordinator and clear active in-memory cached record
     */
    stop() {
        if (this.coordinator) {
            this.coordinator.stop()
        }
        this.cachedRecord = null
    }

    /**
     * Called when active book is closed or switched
     */
    async onCloseBook() {
        this.stop()
        this.currentBookId = null
        this.currentChapterKey = null
        this.currentChapterTitle = null
        this.hideBilingualBar()
        this.updateToolbarState(false)
        if (this.coordinator?.busy) {
            try {
                await this.coordinator.finalizePromise
            } catch (_) {}
        }
    }
}

export const chapterTranslationManager = new ChapterTranslationManager()
