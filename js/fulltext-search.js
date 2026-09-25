// js/fulltext-search.js - Local Cross-Book Full-Text Search Engine
// Supports EPUB, TXT, MD, DOCX with CJK Bi-Gram + Word tokenization,
// snippet extraction, location mapping, and incremental index persistence.

import * as db from './db.js'

export const EXTRACTOR_VERSION = 'v1.0'
export const SUPPORTED_SEARCH_FORMATS = ['epub', 'txt', 'md', 'docx']

/**
 * Tokenize text into searchable CJK bi-grams and alphanumeric terms
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenizeText(text) {
    if (!text || typeof text !== 'string') return new Set()
    const tokens = new Set()
    const clean = text.toLowerCase()

    // 1. Extract alphanumeric words
    const words = clean.match(/[a-z0-9_]+/g) || []
    for (const w of words) {
        if (w.length >= 2) tokens.add(w)
    }

    // 2. Extract CJK bi-grams
    const cjkChars = clean.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []
    for (let i = 0; i < cjkChars.length - 1; i++) {
        tokens.add(cjkChars[i] + cjkChars[i + 1])
    }

    return tokens
}

/**
 * Creates clean excerpt snippet with highlighted keyword
 * @param {string} text
 * @param {string} keyword
 * @param {number} [padding=36]
 * @returns {string} HTML snippet with <mark> tags
 */
export function createExcerptSnippet(text, keyword, padding = 36, matchPos = -1) {
    if (!text || !keyword) return ''
    const cleanKw = keyword.trim().toLowerCase()
    let idx = (matchPos >= 0 && matchPos < text.length) ? matchPos : text.toLowerCase().indexOf(cleanKw)
    let matchLen = cleanKw.length

    if (idx === -1) {
        // Fallback: search for individual query tokens/words
        const tokens = Array.from(tokenizeText(cleanKw)).filter(t => t.length >= 2)
        for (const tok of tokens) {
            const tokIdx = text.toLowerCase().indexOf(tok)
            if (tokIdx !== -1) {
                idx = tokIdx
                matchLen = tok.length
                break
            }
        }
    }

    if (idx === -1) {
        return escapeHTML(text.slice(0, 80)) + (text.length > 80 ? '...' : '')
    }

    const start = Math.max(0, idx - padding)
    const end = Math.min(text.length, idx + matchLen + padding)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < text.length ? '...' : ''

    const matchPart = text.slice(idx, idx + matchLen)
    const beforePart = escapeHTML(text.slice(start, idx))
    const afterPart = escapeHTML(text.slice(idx + matchLen, end))

    return `${prefix}${beforePart}<mark>${escapeHTML(matchPart)}</mark>${afterPart}${suffix}`
}

export function escapeHTML(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Strips script, style, tags, and decodes HTML entities into clean textual content
 * @param {string} html
 * @returns {string}
 */
export function extractCleanTextFromHtml(html) {
    if (!html || typeof html !== 'string') return ''
    let cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
        .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    cleaned = cleaned.replace(/<[^>]+>/g, ' ')
    cleaned = cleaned
        .replace(/&nbsp;/g, ' ')
        .replace(/&emsp;/g, ' ')
        .replace(/&ensp;/g, ' ')
        .replace(/&thinsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&hellip;/g, '…')
        .replace(/&copy;/g, '©')
        .replace(/&reg;/g, '®')
        .replace(/&trade;/g, '™')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    return cleaned.replace(/\r\n|\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim()
}

export class FullTextSearchEngine {
    constructor(options = {}) {
        this.db = options.db || db
        this.index = new Map() // bookId -> { meta, sections: Array<{ id, sectionIndex, sectionTitle, location, text, tokens }> }
        this.indexingState = {
            isIndexing: false,
            currentBookId: null,
            progress: 0
        }
    }

    /**
     * Check if a book format supports full-text search
     * @param {string} format
     * @returns {boolean}
     */
    isFormatSupported(format) {
        return SUPPORTED_SEARCH_FORMATS.includes((format || '').toLowerCase())
    }

    /**
     * Extract sections and build searchable index for a book, with authoritative snapshot validation and IndexedDB persistence
     * @param {string} bookId
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>}
     */
    async indexBook(bookId, signal) {
        if (!bookId) return false
        const book = await this.db.getBook(bookId)
        if (!book) return false
        const format = (book.format || '').toLowerCase()
        if (!this.isFormatSupported(format)) return false

        const snapshot = await this.db.getBookFileSnapshot(bookId)
        if (!snapshot?.blob) return false

        const authRevision = snapshot.blobRevision || snapshot.nativeSnapshotRevision || book.blobRevision || null

        // 1. Check in-memory index
        const existing = this.index.get(bookId)
        if (existing?.meta?.extractorVersion === EXTRACTOR_VERSION &&
            existing?.meta?.blobRevision &&
            authRevision &&
            existing.meta.blobRevision === authRevision) {
            return true
        }

        // 2. Check persistent IndexedDB index
        try {
            if (this.db.getBookSearchIndex) {
                const persisted = await this.db.getBookSearchIndex(bookId)
                if (persisted &&
                    persisted.extractorVersion === EXTRACTOR_VERSION &&
                    persisted.blobRevision &&
                    authRevision &&
                    persisted.blobRevision === authRevision) {
                    // Rehydrate tokens
                    const sections = (persisted.sections || []).map(s => ({
                        id: s.id,
                        sectionIndex: s.sectionIndex,
                        sectionTitle: s.sectionTitle,
                        location: s.location,
                        text: s.text,
                        tokens: Array.isArray(s.tokens) ? new Set(s.tokens) : (s.tokens instanceof Set ? s.tokens : tokenizeText(s.text))
                    }))
                    this.index.set(bookId, {
                        meta: {
                            bookId,
                            title: persisted.title || book.title,
                            format: persisted.format || format,
                            extractorVersion: persisted.extractorVersion,
                            blobRevision: persisted.blobRevision,
                            indexedAt: persisted.indexedAt || Date.now()
                        },
                        sections
                    })
                    return true
                } else if (persisted && this.db.deleteBookSearchIndex) {
                    await this.db.deleteBookSearchIndex(bookId).catch(() => {})
                }
            }
        } catch (e) {
            console.warn('[FullTextSearch] Persistent index check notice:', e)
        }

        const sections = []

        if (format === 'epub') {
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
                const loader = await makeZipLoader(snapshot.blob)
                const { EPUB } = await import('../foliate-js-main/epub.js')
                const epub = await new EPUB(loader).init()

                const tocMap = new Map()
                const walkToc = (items) => {
                    if (!items) return
                    for (const item of items) {
                        if (item.href) {
                            const cleanHref = item.href.split('#')[0]
                            if (!tocMap.has(cleanHref)) tocMap.set(cleanHref, item.label)
                        }
                        if (item.subitems) walkToc(item.subitems)
                    }
                }
                walkToc(epub.toc)

                const spineSections = epub.sections || []
                for (let i = 0; i < spineSections.length; i++) {
                    if (signal?.aborted) return false
                    const sec = spineSections[i]
                    if (!sec || sec.linear === 'no') continue
                    const href = sec.id
                    try {
                        const rawHtml = await loader.loadText(href)
                        const cleanText = extractCleanTextFromHtml(rawHtml)
                        if (cleanText.length >= 6) {
                            const chapterTitle = tocMap.get(href) || href.split('/').pop().replace(/\.[^/.]+$/, '')
                            sections.push({
                                id: `${bookId}_spine_${i}`,
                                sectionIndex: i,
                                sectionTitle: chapterTitle,
                                granularity: 'chapter',
                                location: { href, sectionIndex: i },
                                text: cleanText,
                                tokens: tokenizeText(cleanText)
                            })
                        }
                    } catch (e) {}
                }
                epub?.destroy?.()
            } catch (err) {
                console.warn('[FullTextSearch] EPUB spine index extract warning:', err)
            }
        } else if (format === 'txt' || format === 'md') {
            try {
                const { makeBook } = await import('../foliate-js-main/txt.js')
                const txtBook = await makeBook(snapshot.blob)
                if (txtBook?.sections?.length) {
                    for (let i = 0; i < txtBook.sections.length; i++) {
                        if (signal?.aborted) return false
                        const sec = txtBook.sections[i]
                        const tocItem = txtBook.toc?.[i]
                        const title = tocItem?.label || `第 ${i + 1} 节`
                        let rawText = ''
                        try {
                            const doc = sec.createDocument ? sec.createDocument() : null
                            if (doc) {
                                rawText = doc.body?.innerText || doc.body?.textContent || ''
                            }
                        } catch (e) {}
                        if (!rawText && sec.load) {
                            try {
                                const url = sec.load()
                                const res = await fetch(url)
                                rawText = extractCleanTextFromHtml(await res.text())
                            } catch (e) {}
                        }
                        const cleanText = (rawText || '').trim()
                        if (cleanText.length >= 4) {
                            sections.push({
                                id: `${bookId}_sec_${i}`,
                                sectionIndex: i,
                                sectionTitle: title,
                                granularity: 'chapter',
                                location: { sectionIndex: i, href: `${i}#heading` },
                                text: cleanText,
                                tokens: tokenizeText(cleanText)
                            })
                        }
                    }
                }
            } catch (txtErr) {
                console.warn('[FullTextSearch] TXT structured extract fallback:', txtErr)
                const text = await snapshot.blob.text()
                const paras = text.split(/\n\s*\n/)
                paras.forEach((para, idx) => {
                    const trimmed = para.trim()
                    if (trimmed.length >= 4) {
                        sections.push({
                            id: `${bookId}_sec_${idx}`,
                            sectionIndex: 0,
                            sectionTitle: `段落 ${idx + 1}`,
                            granularity: 'paragraph',
                            location: { sectionIndex: 0, paragraphIndex: idx },
                            text: trimmed,
                            tokens: tokenizeText(trimmed)
                        })
                    }
                })
            }
        } else if (format === 'docx') {
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
                const loader = await makeZipLoader(snapshot.blob)
                const { makeDOCX } = await import('../foliate-js-main/docx.js')
                const docxBook = await makeDOCX(loader, snapshot.blob)
                if (docxBook?.sections?.length) {
                    for (let i = 0; i < docxBook.sections.length; i++) {
                        if (signal?.aborted) return false
                        const sec = docxBook.sections[i]
                        const tocItem = docxBook.toc?.[i]
                        const title = tocItem?.label || `第 ${i + 1} 节`
                        let rawText = ''
                        try {
                            const doc = sec.createDocument ? sec.createDocument() : null
                            if (doc) {
                                rawText = doc.body?.innerText || doc.body?.textContent || ''
                            }
                        } catch (e) {}
                        if (!rawText && sec.load) {
                            try {
                                const url = sec.load()
                                const res = await fetch(url)
                                rawText = extractCleanTextFromHtml(await res.text())
                            } catch (e) {}
                        }
                        const cleanText = (rawText || '').trim()
                        if (cleanText.length >= 4) {
                            sections.push({
                                id: `${bookId}_sec_${i}`,
                                sectionIndex: i,
                                sectionTitle: title,
                                granularity: 'chapter',
                                location: { sectionIndex: i, href: `${i}#heading` },
                                text: cleanText,
                                tokens: tokenizeText(cleanText)
                            })
                        }
                    }
                }
            } catch (docxErr) {
                console.warn('[FullTextSearch] DOCX structured extract fallback:', docxErr)
            }
        }

        if (sections.length > 0) {
            const meta = {
                bookId,
                stableKey: book.stableKey || bookId,
                title: book.title,
                format,
                extractorVersion: EXTRACTOR_VERSION,
                blobRevision: authRevision,
                indexedAt: Date.now()
            }

            // In-memory cache
            this.index.set(bookId, {
                meta,
                sections
            })

            // Persist to IndexedDB
            try {
                if (this.db.saveBookSearchIndex) {
                    const serializedSections = sections.map(s => ({
                        id: s.id,
                        sectionIndex: s.sectionIndex,
                        sectionTitle: s.sectionTitle,
                        granularity: s.granularity || 'chapter',
                        location: s.location,
                        text: s.text,
                        tokens: Array.from(s.tokens)
                    }))
                    await this.db.saveBookSearchIndex(bookId, {
                        ...meta,
                        sections: serializedSections
                    })
                }
            } catch (persistErr) {
                console.warn('[FullTextSearch] Index persistence warning:', persistErr)
            }

            return true
        }

        return false
    }

    /**
     * Search across all indexed books with exact phrase support
     * @param {string} query
     * @param {object} [options]
     * @param {number} [options.limit=40]
     * @returns {Array<{ bookId: string, bookTitle: string, sectionTitle: string, granularity: string, location: object, snippet: string, matchCount: number }>}
     */
    search(query, options = {}) {
        const { limit = 40 } = options
        const rawQ = (query || '').trim()
        if (!rawQ || rawQ.length < 1) return []

        const isExactPhrase = (rawQ.startsWith('"') && rawQ.endsWith('"') && rawQ.length >= 2) ||
                              (rawQ.startsWith('“') && rawQ.endsWith('”') && rawQ.length >= 2)
        const q = (isExactPhrase ? rawQ.slice(1, -1) : rawQ).trim().toLowerCase()
        if (!q) return []

        const results = []
        const queryTokens = isExactPhrase ? null : tokenizeText(q)

        for (const [bookId, entry] of this.index.entries()) {
            const bookTitle = entry.meta.title

            for (const section of entry.sections) {
                const secLower = (section.text || '').toLowerCase()
                const matchPositions = []

                let searchIdx = 0
                while (searchIdx <= secLower.length - q.length) {
                    const pos = secLower.indexOf(q, searchIdx)
                    if (pos === -1) break
                    matchPositions.push({ pos, len: q.length, query: q })
                    searchIdx = pos + Math.max(1, q.length)
                }

                // If not found and not an exact quote, and query contains whitespace-separated words:
                if (matchPositions.length === 0 && !isExactPhrase && q.includes(' ')) {
                    const words = q.split(/\s+/).filter(Boolean)
                    if (words.length > 1 && words.every(w => secLower.includes(w))) {
                        const firstPos = secLower.indexOf(words[0])
                        if (firstPos !== -1) {
                            matchPositions.push({ pos: firstPos, len: words[0].length, query: words[0] })
                        }
                    }
                }

                if (matchPositions.length > 0) {
                    for (let mIdx = 0; mIdx < matchPositions.length; mIdx++) {
                        const m = matchPositions[mIdx]
                        const snippet = createExcerptSnippet(section.text, m.query, 36, m.pos)
                        results.push({
                            bookId,
                            bookTitle,
                            sectionTitle: section.sectionTitle,
                            granularity: section.granularity || 'chapter',
                            location: {
                                ...section.location,
                                matchIndex: mIdx,
                                matchPos: m.pos,
                                query: q
                            },
                            query: q,
                            snippet,
                            excerpt: snippet,
                            matchCount: matchPositions.length
                        })

                        if (results.length >= limit) return results
                    }
                }
            }
        }

        return results
    }

    /**
     * Load all valid persisted indexes from IndexedDB into memory cache
     * @returns {Promise<number>} count of loaded indexes
     */
    async loadPersistedIndexes() {
        try {
            if (!this.db.getAllBookSearchIndexes) return 0
            const allPersisted = await this.db.getAllBookSearchIndexes()
            let loaded = 0
            for (const item of allPersisted) {
                if (!item || !item.bookId || item.extractorVersion !== EXTRACTOR_VERSION) continue
                const sections = (item.sections || []).map(s => ({
                    id: s.id,
                    sectionIndex: s.sectionIndex,
                    sectionTitle: s.sectionTitle,
                    granularity: s.granularity || 'chapter',
                    location: s.location,
                    text: s.text,
                    tokens: Array.isArray(s.tokens) ? new Set(s.tokens) : (s.tokens instanceof Set ? s.tokens : tokenizeText(s.text))
                }))
                this.index.set(item.bookId, {
                    meta: {
                        bookId: item.bookId,
                        title: item.title,
                        format: item.format,
                        extractorVersion: item.extractorVersion,
                        blobRevision: item.blobRevision,
                        indexedAt: item.indexedAt
                    },
                    sections
                })
                loaded++
            }
            return loaded
        } catch (e) {
            console.warn('[FullTextSearch] loadPersistedIndexes notice:', e)
            return 0
        }
    }

    /**
     * Prune stale indexes for books that have been deleted
     * @param {Array<string>} validBookIds
     * @returns {Promise<number>} count of removed indexes
     */
    async pruneStaleIndexes(validBookIds = []) {
        const validSet = new Set(validBookIds)
        let pruned = 0

        // In-memory prune
        for (const bookId of Array.from(this.index.keys())) {
            if (!validSet.has(bookId)) {
                this.index.delete(bookId)
                pruned++
            }
        }

        // IndexedDB prune
        try {
            if (this.db.getAllBookSearchIndexes && this.db.deleteBookSearchIndex) {
                const allPersisted = await this.db.getAllBookSearchIndexes()
                for (const item of allPersisted) {
                    if (item?.bookId && !validSet.has(item.bookId)) {
                        await this.db.deleteBookSearchIndex(item.bookId)
                    }
                }
            }
        } catch (e) {}

        return pruned
    }

    /**
     * Remove index for a deleted book
     * @param {string} bookId
     */
    async removeBookIndex(bookId) {
        if (!bookId) return
        this.index.delete(bookId)
        try {
            if (this.db.deleteBookSearchIndex) {
                await this.db.deleteBookSearchIndex(bookId)
            }
        } catch (e) {}
    }
}

export const fullTextSearchEngine = new FullTextSearchEngine()

