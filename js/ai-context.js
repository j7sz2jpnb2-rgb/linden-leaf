/**
 * ai-context.js - Selection Reference Snapshot and Context Extraction (<= 1000 Token Hard Budget)
 * Part of Linden Leaf AI Reading Assistant
 */

import { t } from './i18n.js'

/**
 * Heuristic Token Estimation (基于词法与字符统计的启发式估算系数，非本地真实 BPE 分词器，不作硬 Token 承诺):
 * - auto: 标准中英自适应估算系数 (CJK: ~1.25, Words: ~1.35)
 * - cjk_heuristic: CJK 偏高估算系数 (CJK: ~1.5, Words: ~1.35)
 * - cl100k_base: cl100k 启发式估算系数 (CJK: ~1.15, Words: ~1.25)
 * - gpt2: gpt2 启发式估算系数 (CJK: ~2.2, Words: ~1.3)
 *
 * @param {string} text
 * @param {'auto' | 'cjk_heuristic' | 'cl100k_base' | 'gpt2'} [tokenizer='auto']
 * @returns {number}
 */
export function estimateTokenCount(text, tokenizer = 'auto') {
    if (!text || typeof text !== 'string') return 0
    const str = text.trim()
    if (!str) return 0

    let cjkCount = 0

    // Match CJK Unified Ideographs, Symbols & Punctuation, Hiragana, Katakana, Hangul, Fullwidth punctuation
    const cjkRegex = /[\u4e00-\u9fa5\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff01-\uffee]/g
    const cjkMatches = str.match(cjkRegex)
    if (cjkMatches) {
        cjkCount = cjkMatches.length
    }

    const nonCjk = str.replace(cjkRegex, ' ')
    const words = nonCjk.split(/\s+/).filter(Boolean)
    const wordCount = words.length

    // Estimated token count rounded up
    let cjkMultiplier = 1.25
    let wordMultiplier = 1.35
    if (tokenizer === 'cjk_heuristic') {
        cjkMultiplier = 1.5
        wordMultiplier = 1.35
    } else if (tokenizer === 'cl100k_base') {
        cjkMultiplier = 1.15
        wordMultiplier = 1.25
    } else if (tokenizer === 'gpt2') {
        cjkMultiplier = 2.2
        wordMultiplier = 1.3
    }
    const estimate = Math.ceil(cjkCount * cjkMultiplier + wordCount * wordMultiplier)
    return Math.max(1, estimate)
}

/**
 * Truncates text so its estimated token count stays strictly <= maxTokens.
 * Truncates cleanly at sentence or paragraph boundaries when possible.
 *
 * @param {string} text
 * @param {number} maxTokens (default 1000)
 * @param {object} [options]
 * @param {boolean} [options.fromEnd=false] If true, keep the end of the text closest to the selection
 * @param {string} [options.tokenizer='auto']
 * @returns {{ text: string, tokenCount: number, isTruncated: boolean }}
 */
export function truncateToTokenBudget(text, maxTokens = 1000, { fromEnd = false, tokenizer = 'auto' } = {}) {
    if (!text) return { text: '', tokenCount: 0, isTruncated: false }
    const budget = Math.max(0, Math.min(10000, Number(maxTokens) ?? 1000))
    if (budget === 0) return { text: '', tokenCount: 0, isTruncated: false }
    const currentTokens = estimateTokenCount(text, tokenizer)
    if (currentTokens <= budget) {
        return { text, tokenCount: currentTokens, isTruncated: false }
    }

    if (fromEnd) {
        // Truncate from the beginning, keeping the tail end immediately before the quote
        let low = 0
        let high = text.length
        let bestCut = 0

        while (low <= high) {
            const mid = Math.floor((low + high) / 2)
            const slice = text.slice(text.length - mid)
            const tokens = estimateTokenCount(slice, tokenizer)
            if (tokens <= budget) {
                bestCut = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }

        // Try finding sentence start punctuation near the cut boundary
        const startIndex = text.length - bestCut
        const sub = text.slice(startIndex, startIndex + Math.floor(bestCut * 0.3))
        const sentenceEndings = ['。', '！', '？', '；', '\n', '.', '!', '?', ';']
        let cleanCutIndex = -1
        for (const p of sentenceEndings) {
            const idx = sub.indexOf(p)
            if (idx !== -1 && (cleanCutIndex === -1 || idx < cleanCutIndex)) {
                cleanCutIndex = idx + 1
            }
        }

        const finalStart = cleanCutIndex > 0 ? (startIndex + cleanCutIndex) : startIndex
        let truncatedText = '... ' + text.slice(finalStart).trim()
        while (estimateTokenCount(truncatedText, tokenizer) > budget && truncatedText.length > 5) {
            const firstSpace = truncatedText.indexOf(' ', 4)
            if (firstSpace > 0) {
                truncatedText = '... ' + truncatedText.slice(firstSpace + 1).trim()
            } else {
                truncatedText = '... ' + truncatedText.slice(5).trim()
            }
        }
        return {
            text: truncatedText,
            tokenCount: estimateTokenCount(truncatedText, tokenizer),
            isTruncated: true
        }
    }

    // Binary search for optimal character cutoff from the start
    let low = 0
    let high = text.length
    let bestCut = 0

    while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const slice = text.slice(0, mid)
        const tokens = estimateTokenCount(slice, tokenizer)
        if (tokens <= budget) {
            bestCut = mid
            low = mid + 1
        } else {
            high = mid - 1
        }
    }

    // Try finding the last sentence ending punctuation near bestCut
    const sub = text.slice(0, bestCut)
    const sentenceEndings = ['。', '！', '？', '；', '\n', '.', '!', '?', ';']
    let cleanCut = -1
    for (const p of sentenceEndings) {
        const idx = sub.lastIndexOf(p)
        if (idx > cleanCut && idx > bestCut * 0.7) {
            cleanCut = idx + 1
        }
    }

    const finalCut = cleanCut > 0 ? cleanCut : bestCut
    let truncatedText = text.slice(0, finalCut).trim() + ' ...'
    // Ensure appending ellipsis never pushes tokenCount above budget
    while (estimateTokenCount(truncatedText, tokenizer) > budget && truncatedText.length > 5) {
        const lastSpace = truncatedText.lastIndexOf(' ', truncatedText.length - 5)
        if (lastSpace > 0) {
            truncatedText = truncatedText.slice(0, lastSpace).trim() + ' ...'
        } else {
            truncatedText = truncatedText.slice(0, truncatedText.length - 5).trim() + ' ...'
        }
    }
    return {
        text: truncatedText,
        tokenCount: estimateTokenCount(truncatedText, tokenizer),
        isTruncated: true
    }
}

/**
 * Creates a stable, immutable selection reference snapshot (ReadingReference v2)
 * before popups close or selection collapses.
 *
 * @param {object} book
 * @param {object} selectionInfo
 * @returns {object} ReadingReference
 */
export function createReferenceSnapshot(book, selectionInfo) {
    const rawText = (selectionInfo?.text || '').trim()
    const pdfTarget = selectionInfo?.pdfTarget || null
    const cfi = selectionInfo?.cfi || null
    const pageIndex = selectionInfo?.pageIndex ?? (typeof pdfTarget?.page === 'number' ? pdfTarget.page : null)
    const chapter = (selectionInfo?.chapterTitle || selectionInfo?.chapterOrPage || (pageIndex !== undefined && pageIndex !== null ? t('common.pageNumber', { page: pageIndex + 1 }) : '')).trim()
    const anchor = pdfTarget
        ? { type: 'pdf_target', pageIndex, pdfTarget }
        : (cfi ? { type: 'epub_cfi', cfi } : { type: 'location', pageIndex })
    return {
        schemaVersion: 2,
        referenceId: 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        bookId: book?.id || selectionInfo?.bookId || null,
        documentVersion: book?.documentHash || selectionInfo?.documentHash || null,
        blobRevision: book?.blobRevision || selectionInfo?.blobRevision || null,
        revisionOrigin: book?.revisionOrigin || selectionInfo?.revisionOrigin || null,
        bookTitle: book?.title || t('book.defaultTitleCurrent'),
        bookAuthor: book?.customAuthor || book?.author || '',
        selectedText: rawText,
        context: (selectionInfo?.sentenceContext || selectionInfo?.context || '').trim(),
        kind: selectionInfo?.kind || (selectionInfo?.isWordContext ? 'word_context' : 'passage'),
        highlightId: selectionInfo?.highlightId || null,
        cfi,
        pdfTarget,
        pageIndex,
        chapter,
        chapterOrPage: chapter,
        anchor,
        sourceType: selectionInfo?.sourceType || 'native',
        createdAt: Date.now()
    }
}

/**
 * Extracts a concise enclosing sentence/clause right around a DOM Range or plain text snippet.
 * Strictly local (O(1) bounded slice), safe for word-level "Explain in Context" lookups.
 *
 * @param {object} params
 * @param {Document|null} [params.doc]
 * @param {Range|null} [params.range]
 * @param {string} [params.pageText]
 * @param {string} params.selectedText
 * @param {number} [params.maxChars=360]
 * @returns {string}
 */
export function extractEnclosingSentenceContext({ doc = null, range = null, pageText = '', selectedText = '', maxChars = 360 } = {}) {
    const cleanSel = String(selectedText || '').trim()
    if (!cleanSel) return ''
    try {
        let blockText = ''
        if (range && range.startContainer) {
            let node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
            while (node && node !== doc?.body && node.tagName && !/^(P|DIV|LI|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|TD)$/i.test(node.tagName)) {
                node = node.parentElement
            }
            if (node && (node.innerText || node.textContent)) {
                blockText = String(node.innerText || node.textContent || '')
            }
        }
        if (!blockText && pageText) {
            blockText = String(pageText)
        }
        if (!blockText && doc?.body) {
            blockText = String(doc.body.innerText || doc.body.textContent || '')
        }
        const normalized = blockText.replace(/\s+/g, ' ').trim()
        if (!normalized) return ''
        const idx = normalized.indexOf(cleanSel)
        if (idx < 0) return ''

        const boundaryRe = /[.!?。！？；;\n]/
        let left = idx
        while (left > 0 && idx - left < maxChars / 2) {
            if (boundaryRe.test(normalized[left - 1])) break
            left--
        }
        let right = idx + cleanSel.length
        while (right < normalized.length && right - (idx + cleanSel.length) < maxChars / 2) {
            right++
            if (boundaryRe.test(normalized[right - 1])) break
        }
        return normalized.slice(left, right).trim().slice(0, maxChars)
    } catch (_) {
        return ''
    }
}

/**
 * Formats a portable plain-text provenance quote ready to paste or insert into any external AI chat.
 * Leaves trailing spacing for the user to add/keep their own question and press Send manually.
 *
 * @param {object} reference
 * @param {object} [options]
 * @param {string} [options.surroundingContext]
 * @param {string} [options.userQuestion]
 * @returns {string}
 */
export function formatExternalAiReferencePrompt(reference, { surroundingContext = '', userQuestion = '' } = {}) {
    if (!reference || !reference.selectedText) return ''
    const title = (reference.bookTitle || t('book.defaultTitleCurrent')).trim()
    const author = (reference.bookAuthor || '').trim()
    const loc = (reference.chapter || reference.chapterOrPage || '').trim()
    const headerParts = [title, author, loc].filter(Boolean)
    const provenance = headerParts.join(' · ')
    const extraCtx = (surroundingContext || reference.context || '').trim()

    if (reference.kind === 'word_context') {
        const lines = [
            t('companion.promptWordHeader', { provenance }),
            t('companion.promptWordLine', { word: reference.selectedText.trim() })
        ]
        if (extraCtx && extraCtx !== reference.selectedText.trim()) {
            lines.push(t('companion.promptSentenceLine', { sentence: extraCtx }))
        }
        lines.push(t('companion.promptWordAsk'))
        if (userQuestion?.trim()) lines.push(userQuestion.trim())
        return lines.join('\n')
    }

    const lines = [
        t('companion.promptQuoteHeader', { provenance }),
        '<<<',
        reference.selectedText.trim(),
        '>>>'
    ]
    if (extraCtx && extraCtx !== reference.selectedText.trim()) {
        lines.push('', t('companion.promptContextHeader'), extraCtx)
    }
    if (userQuestion?.trim()) {
        lines.push('', userQuestion.trim())
    }
    return lines.join('\n')
}

/**
 * Extracts surrounding text around the selection with a strict <= 1000 token limit.
 *
 * @param {object} options
 * @param {string} options.beforeText
 * @param {string} options.afterText
 * @param {number} [options.maxTokens=1000]
 * @param {string} [options.tokenizer='auto']
 * @returns {{ contextText: string, tokenCount: number, isTruncated: boolean }}
 */
export function buildSurroundingContext({ beforeText = '', afterText = '', maxTokens = 1000, tokenizer = 'auto' } = {}) {
    const budget = Math.max(0, Math.min(10000, Number(maxTokens) ?? 1000))
    if (budget === 0) {
        return { contextText: '', tokenCount: 0, isTruncated: false, tokenBudget: 0 }
    }

    const cleanBefore = (beforeText || '').trim()
    const cleanAfter = (afterText || '').trim()

    if (!cleanBefore && !cleanAfter) {
        return { contextText: '', tokenCount: 0, isTruncated: false, tokenBudget: budget }
    }

    const halfBudget = Math.floor(budget / 2)
    const beforeBudget = truncateToTokenBudget(cleanBefore, halfBudget, { fromEnd: true, tokenizer })
    const remainingBudgetForAfter = budget - beforeBudget.tokenCount
    const afterBudget = truncateToTokenBudget(cleanAfter, remainingBudgetForAfter, { fromEnd: false, tokenizer })

    let combined = ''
    if (beforeBudget.text && afterBudget.text) {
        combined = `${t('aiContext.beforeSelection')}\n${beforeBudget.text}\n\n${t('aiContext.afterSelection')}\n${afterBudget.text}`
    } else if (beforeBudget.text) {
        combined = beforeBudget.text
    } else {
        combined = afterBudget.text
    }

    // Safety check final combined text to ensure it strictly respects budget
    const finalResult = truncateToTokenBudget(combined, budget, { tokenizer })
    return {
        contextText: finalResult.text,
        tokenCount: finalResult.tokenCount,
        tokenBudget: budget,
        isTruncated: beforeBudget.isTruncated || afterBudget.isTruncated || finalResult.isTruncated
    }
}

/**
 * Builds chat messages for model generation.
 * NEVER secretly appends arbitrary long system rules.
 * Keeps system prompt concise, and includes user prompt, reference data, and allowed context.
 *
 * @param {object} params
 * @param {string} params.promptText
 * @param {string} [params.systemPrompt]
 * @param {string} [params.userSupplement]
 * @param {object} [params.referenceSnapshot]
 * @param {object} [params.contextSnapshot]
 * @param {boolean} [params.includeContext=true]
 * @param {Array<{ role: string, content: string }>} [params.historyMessages=[]]
 * @returns {Array<{ role: string, content: string }>}
 */
export function buildChatPayloadMessages({
    promptText,
    systemPrompt,
    userSupplement,
    referenceSnapshot,
    contextSnapshot,
    includeContext = true,
    historyMessages = []
}) {
    const messages = []

    if (systemPrompt && systemPrompt.trim()) {
        messages.push({
            role: 'system',
            content: systemPrompt.trim()
        })
    }

    if (Array.isArray(historyMessages) && historyMessages.length > 0) {
        for (const msg of historyMessages) {
            if (msg && msg.role && msg.content && (msg.role === 'user' || msg.role === 'assistant')) {
                messages.push({
                    role: msg.role,
                    content: msg.content
                })
            }
        }
    }

    let userContent = (promptText || '').trim()

    if (userSupplement && userSupplement.trim()) {
        userContent += `\n\n${t('aiContext.userSupplementHeader')}\n${userSupplement.trim()}`
    }

    if (referenceSnapshot && referenceSnapshot.selectedText) {
        const refMeta = referenceSnapshot.chapterOrPage ? ` (${referenceSnapshot.chapterOrPage})` : ''
        userContent += `\n\n${t('aiContext.excerptHeader', { meta: refMeta })}\n<<<\n${referenceSnapshot.selectedText.trim()}\n>>>`
    }

    if (includeContext && contextSnapshot && contextSnapshot.contextText && Number(contextSnapshot.tokenBudget) > 0) {
        const budgetLabel = `≤${contextSnapshot.tokenBudget} token`
        userContent += `\n\n${t('aiContext.contextHeader', { budget: budgetLabel })}\n<<<\n${contextSnapshot.contextText.trim()}\n>>>`
    }

    messages.push({
        role: 'user',
        content: userContent
    })

    return messages
}
