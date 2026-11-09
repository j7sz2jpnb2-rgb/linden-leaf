// js/fulltext-search.js - Local Cross-Book Full-Text Search Engine
// Supports EPUB, TXT, MD, DOCX with CJK Bi-Gram + Word tokenization,
// snippet extraction, location mapping, and incremental index persistence.

import * as db from './db.js'

export const EXTRACTOR_VERSION = 'v1.1'
export const SUPPORTED_SEARCH_FORMATS = ['epub', 'txt', 'md', 'docx', 'mobi', 'azw3', 'azw']

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

    // 2. Extract CJK unigrams and bi-grams within contiguous CJK runs
    const cjkRuns = clean.match(/[\u4e00-\u9fa5\u3040-\u30ff]+/g) || []
    for (const run of cjkRuns) {
        for (let i = 0; i < run.length; i++) {
            tokens.add(run[i])
            if (i < run.length - 1) {
                tokens.add(run[i] + run[i + 1])
            }
        }
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

    // If <body> tag is present, extract its content to match Foliate's body-only search walker
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
    if (bodyMatch) {
        cleaned = bodyMatch[1]
    } else {
        // Otherwise strip <head>...</head> so titles and metadata do not pollute index ordinals
        cleaned = cleaned.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, ' ')
    }

    // Strip injected bilingual translation blocks
    cleaned = cleaned.replace(/<([a-z0-9]+)\b[^>]*(?:class="[^"]*(?:linden-bilingual-target|bilingual-translation-block)[^"]*"|data-injected-translation)[^>]*>[\s\S]*?<\/\1>/gi, ' ')

    cleaned = cleaned
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
        .replace(/&#(\d+);/g, (_, dec) => {
            try {
                const code = parseInt(dec, 10)
                return (code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) ? String.fromCodePoint(code) : ''
            } catch (_) {
                return ''
            }
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try {
                const code = parseInt(hex, 16)
                return (code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) ? String.fromCodePoint(code) : ''
            } catch (_) {
                return ''
            }
        })
    return cleaned.replace(/\r\n|\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim()
}

export function extractCleanTextFromDoc(doc) {
    if (!doc || !doc.body) return ''
    try {
        const clone = doc.body.cloneNode(true)
        clone.querySelectorAll?.('.linden-bilingual-target, .bilingual-translation-block, .bilingual-derived-view, .linden-inline-translation, [data-injected-translation]').forEach(n => n.remove())
        return (clone.innerText || clone.textContent || '').trim()
    } catch (_) {
        return (doc.body.innerText || doc.body.textContent || '').trim()
    }
}

export class FullTextSearchEngine {
    constructor(options = {}) {
        this.db = options.db || db
        this.index = new Map() // bookId -> { meta, sections: Array<{ id, sectionIndex, sectionTitle, location, text, tokens }> }
        this.maxConcurrent = 2
        this.maxCacheEntries = 25
        this.indexingState = {
            isIndexing: false,
            currentBookId: null,
            progress: 0
        }
    }

    /**
     * Configure runtime resource budget (concurrency, bounded cache entries)
     * @param {object} [budget]
     */
    setResourceBudget(budget = {}) {
        this.maxConcurrent = budget.maxConcurrent || (budget.isLowMemoryDevice ? 1 : 2)
        this.maxCacheEntries = Number(budget.maxCacheEntries) || (budget.isLowMemoryDevice ? 10 : 25)
        this._trimCache()
    }

    _trimCache() {
        const limit = this.maxCacheEntries || 25
        while (this.index.size > limit) {
            const firstKey = this.index.keys().next().value
            if (firstKey) this.index.delete(firstKey)
            else break
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
        if (!book) {
            await this.removeBookIndex(bookId)
            return false
        }
        const format = (book.format || '').toLowerCase()
        if (!this.isFormatSupported(format)) return false

        // 1. Fast-path in-memory index check before opening heavy book_files Blob snapshot transaction
        const existing = this.index.get(bookId)
        if (existing?.meta?.extractorVersion === EXTRACTOR_VERSION &&
            existing?.meta?.blobRevision &&
            book.blobRevision &&
            existing.meta.blobRevision === book.blobRevision) {
            this.index.delete(bookId)
            this.index.set(bookId, existing)
            return true
        }

        const snapshot = await this.db.getBookFileSnapshot(bookId)
        if (!snapshot?.blob) return false

        const authRevision = snapshot.blobRevision || snapshot.nativeSnapshotRevision || book.blobRevision || null

        if (existing?.meta?.extractorVersion === EXTRACTOR_VERSION &&
            existing?.meta?.blobRevision &&
            authRevision &&
            existing.meta.blobRevision === authRevision) {
            this.index.delete(bookId)
            this.index.set(bookId, existing)
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
                    this._trimCache()
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
            let epub = null
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js')
                const loader = await makeZipLoader(snapshot.blob)
                const { EPUB } = await import('../foliate-js-main/epub.js')
                epub = await new EPUB(loader).init()

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
                    if (i % 3 === 0) {
                        await new Promise(r => setTimeout(r, 0))
                    }
                }
            } catch (err) {
                console.warn('[FullTextSearch] EPUB spine index extract warning:', err)
            } finally {
                epub?.destroy?.()
            }
        } else if (format === 'txt' || format === 'md') {
            let txtBook = null
            try {
                const { makeBook } = await import('../foliate-js-main/txt.js')
                txtBook = await makeBook(snapshot.blob)
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
                                rawText = extractCleanTextFromDoc(doc)
                            }
                        } catch (e) {}
                        if (!rawText && sec.load) {
                            let url = null
                            try {
                                url = await sec.load()
                                if (url) {
                                    const res = await fetch(url)
                                    rawText = extractCleanTextFromHtml(await res.text())
                                }
                            } catch (e) {}
                            finally {
                                if (url && typeof url === 'string' && url.startsWith('blob:')) {
                                    try { URL.revokeObjectURL(url) } catch {}
                                }
                            }
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
            } finally {
                txtBook?.destroy?.()
            }
        } else if (format === 'docx') {
            let docxBook = null
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js')
                const loader = await makeZipLoader(snapshot.blob)
                const { makeDOCX } = await import('../foliate-js-main/docx.js')
                docxBook = await makeDOCX(loader, snapshot.blob)
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
                                rawText = extractCleanTextFromDoc(doc)
                            }
                        } catch (e) {}
                        if (!rawText && sec.load) {
                            let url = null
                            try {
                                url = await sec.load()
                                if (url) {
                                    const res = await fetch(url)
                                    rawText = extractCleanTextFromHtml(await res.text())
                                }
                            } catch (e) {}
                            finally {
                                if (url && typeof url === 'string' && url.startsWith('blob:')) {
                                    try { URL.revokeObjectURL(url) } catch {}
                                }
                            }
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
            } finally {
                docxBook?.destroy?.()
            }
        } else if (format === 'mobi' || format === 'azw' || format === 'azw3') {
            let mobiBook = null
            try {
                const { MOBI } = await import('../foliate-js-main/mobi.js')
                const fflate = await import('../foliate-js-main/vendor/fflate.js')
                mobiBook = await new MOBI({ unzlib: fflate.unzlibSync }).open(snapshot.blob)
                if (mobiBook?.sections?.length) {
                    for (let i = 0; i < mobiBook.sections.length; i++) {
                        if (signal?.aborted) return false
                        const sec = mobiBook.sections[i]
                        const tocItem = mobiBook.toc?.[i]
                        const title = tocItem?.label || `第 ${i + 1} 节`
                        let rawText = ''
                        try {
                            const doc = sec.createDocument ? await sec.createDocument() : null
                            if (doc) {
                                rawText = extractCleanTextFromDoc(doc)
                            }
                        } catch (e) {}
                        if (!rawText && sec.load) {
                            let url = null
                            try {
                                url = await sec.load()
                                if (url) {
                                    const res = await fetch(url)
                                    rawText = extractCleanTextFromHtml(await res.text())
                                }
                            } catch (e) {}
                            finally {
                                if (url && typeof url === 'string' && url.startsWith('blob:')) {
                                    try { URL.revokeObjectURL(url) } catch {}
                                }
                            }
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
            } catch (mobiErr) {
                console.warn('[FullTextSearch] MOBI/AZW3 extract warning:', mobiErr)
            } finally {
                if (mobiBook && typeof mobiBook.destroy === 'function') {
                    try { mobiBook.destroy() } catch {}
                }
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
                documentHash: snapshot.documentHash || book.documentHash || null,
                size: snapshot.blob?.size || book.size || null,
                indexedAt: Date.now()
            }

            // In-memory cache
            this.index.set(bookId, {
                meta,
                sections
            })
            this._trimCache()

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
        const { limit = 40, bookIds = null, previewLimit = null } = options
        const rawQ = (query || '').trim()
        if (!rawQ || rawQ.length < 1) return []

        const isExactPhrase = (rawQ.startsWith('"') && rawQ.endsWith('"') && rawQ.length >= 2) ||
                              (rawQ.startsWith('“') && rawQ.endsWith('”') && rawQ.length >= 2)
        const q = (isExactPhrase ? rawQ.slice(1, -1) : rawQ).trim().toLowerCase()
        if (!q) return []

        const results = []
        let totalHits = 0
        const queryTokens = isExactPhrase ? null : tokenizeText(q)
        const maxSnippetsToKeep = (previewLimit !== null && previewLimit !== undefined) ? Math.max(1, previewLimit) : ((limit === Infinity) ? Infinity : Math.max(1, limit))

        for (const [bookId, entry] of this.index.entries()) {
            if (bookIds && !bookIds.includes(bookId)) continue
            const bookTitle = entry.meta.title

            for (const section of entry.sections) {
                // Item 1: Token Inverted-Set Pre-filtering
                // When query has extracted tokens and section has tokens, verify all query tokens exist in section
                if (queryTokens && queryTokens.size > 0 && section.tokens?.size > 0) {
                    let hasAll = true
                    for (const tok of queryTokens) {
                        if (section.tokens.has(tok)) continue
                        const isAlpha = /^[a-z0-9_]+$/.test(tok)
                        if (isAlpha) {
                            let matchAlpha = false
                            for (const sTok of section.tokens) {
                                if (sTok.includes(tok)) {
                                    matchAlpha = true
                                    break
                                }
                            }
                            if (matchAlpha) continue
                        }
                        const isCjk = /[\u4e00-\u9fa5\u3040-\u30ff]/.test(tok)
                        if (isCjk) {
                            // Support legacy indexes that only stored bi-grams without unigrams
                            let matchCjk = false
                            for (const sTok of section.tokens) {
                                if (sTok.includes(tok)) {
                                    matchCjk = true
                                    break
                                }
                            }
                            if (matchCjk) continue
                        }
                        hasAll = false
                        break
                    }
                    if (!hasAll) continue
                }

                const secLower = (section.text || '').toLowerCase()
                let sectionMatchCount = 0
                const neededSnippets = []

                let searchIdx = 0
                while (searchIdx <= secLower.length - q.length) {
                    const pos = secLower.indexOf(q, searchIdx)
                    if (pos === -1) break
                    sectionMatchCount++
                    if (neededSnippets.length < maxSnippetsToKeep) {
                        neededSnippets.push({ pos, len: q.length, query: q })
                    }
                    searchIdx = pos + Math.max(1, q.length)
                }

                // If not found and not an exact quote, and query contains whitespace-separated words:
                if (sectionMatchCount === 0 && !isExactPhrase && q.includes(' ')) {
                    const words = q.split(/\s+/).filter(Boolean)
                    if (words.length > 1 && words.every(w => secLower.includes(w))) {
                        const firstPos = secLower.indexOf(words[0])
                        if (firstPos !== -1) {
                            sectionMatchCount++
                            neededSnippets.push({ pos: firstPos, len: words[0].length, query: words[0] })
                        }
                    }
                }

                if (sectionMatchCount > 0) {
                    totalHits += sectionMatchCount
                    const snippetsNeededForThisSection = Math.max(0, maxSnippetsToKeep - results.length)
                    for (let mIdx = 0; mIdx < Math.min(neededSnippets.length, snippetsNeededForThisSection); mIdx++) {
                        const m = neededSnippets[mIdx]
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
                            matchCount: sectionMatchCount
                        })
                    }

                    if (previewLimit === null && results.length >= limit) {
                        results.totalHits = totalHits
                        return results
                    }
                }
            }
        }

        results.totalHits = totalHits
        return results
    }

    // Search all supported books with 100% full traversal and streaming callbacks
    async searchBooks(query, books, { signal, limit = Infinity, concurrency = this.maxConcurrent, onProgress = () => {}, onBookResult = null } = {}) {
        const supported = books.filter(book => this.isFormatSupported(book.format))
        const results = []
        const bookGroups = []
        let visited = 0
        let searched = 0
        let failed = 0
        const workers = Math.max(1, Math.min(6, Number(concurrency) || 1))
        const visit = async () => {
            while (!signal?.aborted && visited < supported.length) {
                const book = supported[visited++]
                if (!book) break
                try {
                    if (await this.indexBook(book.id, signal)) {
                        if (signal?.aborted) return
                        const matches = this.search(query, { bookIds: [book.id], previewLimit: 3 })
                        const totalHits = matches.totalHits != null ? matches.totalHits : matches.length
                        if (totalHits > 0) {
                            for (let i = 0; i < matches.length; i++) {
                                results.push(matches[i])
                            }
                            const bookResult = {
                                bookId: book.id,
                                bookTitle: book.title || matches[0]?.bookTitle || '未命名书籍',
                                cover: book.cover || null,
                                format: book.format || '',
                                totalHits: totalHits,
                                previewMatches: matches.slice(0, 3)
                            }
                            bookGroups.push(bookResult)
                            onBookResult?.(bookResult)
                        }
                        searched++
                    } else {
                        failed++
                    }
                } catch (error) {
                    if (signal?.aborted) return
                    failed++
                    console.warn('[FullTextSearch] Unable to search book:', book.id, error)
                }
                onProgress({ visited: searched + failed, total: supported.length, matches: results.length, searched, failed })
            }
        }
        await Promise.all(Array.from({ length: workers }, () => visit()))
        return { results, bookGroups, searched, failed, supported: supported.length, unsupported: books.length - supported.length, limited: false }
    }

    async _ensureBookIndexFresh(bookId, expectedRevision = null) {
        if (!bookId) return false
        if (this.index.has(bookId)) {
            try {
                const book = await this.db?.getBook?.(bookId)
                if (!book) {
                    await this.invalidate(bookId)
                    return false
                }
                const snapshot = await this.db?.getBookFileSnapshot?.(bookId)
                if (!snapshot?.blob) {
                    await this.invalidate(bookId)
                    return false
                }
                const currentRev = expectedRevision || snapshot?.blobRevision || snapshot?.nativeSnapshotRevision || book?.blobRevision || null
                const currentHash = snapshot?.documentHash || book?.documentHash || null
                const currentSize = snapshot?.blob?.size != null ? snapshot.blob.size : book?.size
                const cachedMeta = this.index.get(bookId)?.meta
                const cachedRev = cachedMeta?.blobRevision || null
                const cachedHash = cachedMeta?.documentHash || null
                const cachedSize = cachedMeta?.size || null

                const isStale = (currentRev && cachedRev !== currentRev) ||
                                (currentHash && cachedHash !== currentHash) ||
                                (currentSize != null && cachedSize != null && currentSize !== cachedSize)
                if (isStale) {
                    await this.invalidate(bookId)
                }
            } catch (_) {}
        }
        if (!this.index.has(bookId)) {
            let hydrated = false
            try {
                if (this.db?.getBookSearchIndex) {
                    const persisted = await this.db.getBookSearchIndex(bookId)
                    if (persisted && persisted.sections && persisted.extractorVersion === EXTRACTOR_VERSION) {
                        const book = await this.db?.getBook?.(bookId)
                        const snapshot = await this.db?.getBookFileSnapshot?.(bookId)
                        const currentRev = expectedRevision || snapshot?.blobRevision || snapshot?.nativeSnapshotRevision || book?.blobRevision || null
                        const currentHash = snapshot?.documentHash || book?.documentHash || null
                        const revMatch = !currentRev || persisted.blobRevision === currentRev
                        const hashMatch = !currentHash || !persisted.documentHash || persisted.documentHash === currentHash
                        if (revMatch && hashMatch) {
                            const sections = persisted.sections.map(s => ({
                                id: s.id,
                                sectionIndex: s.sectionIndex,
                                sectionTitle: s.sectionTitle,
                                granularity: s.granularity || 'chapter',
                                location: s.location,
                                text: s.text,
                                tokens: Array.isArray(s.tokens) ? new Set(s.tokens) : (s.tokens instanceof Set ? s.tokens : tokenizeText(s.text))
                            }))
                            this.index.set(bookId, {
                                meta: persisted,
                                sections
                            })
                            this._trimCache()
                            hydrated = true
                        }
                    }
                }
            } catch (err) {
                console.warn('[FullTextSearch] index rehydration notice:', err)
            }
            if (!hydrated) {
                await this.indexBook(bookId)
            }
        }
        return this.index.has(bookId)
    }

    /**
     * Paged search API returning bounded snippet items with cursor support
     * @param {string} bookId
     * @param {string} query
     * @param {object} [options]
     * @param {object|null} [options.cursor]
     * @param {number} [options.pageSize=30]
     * @param {AbortSignal} [options.signal]
     * @param {string} [options.expectedRevision]
     * @returns {Promise<{ totalHits: number, items: Array<object>, nextCursor: object|null, indexRevision: string|null }>}
     */
    async searchBookPage(bookId, query, { cursor = null, pageSize = 30, signal = null, expectedRevision = null } = {}) {
        if (!bookId || !query) return { totalHits: 0, items: [], nextCursor: null, indexRevision: null }
        await this._ensureBookIndexFresh(bookId, expectedRevision)
        const entry = this.index.get(bookId)
        if (!entry || !entry.sections) return { totalHits: 0, items: [], nextCursor: null, indexRevision: null }

        const indexRevision = entry.meta?.blobRevision || entry.meta?.documentHash || 'v1'
        const rawQ = (query || '').trim()
        if (!rawQ) return { totalHits: 0, items: [], nextCursor: null, indexRevision }

        const isExactPhrase = (rawQ.startsWith('"') && rawQ.endsWith('"') && rawQ.length >= 2) ||
                              (rawQ.startsWith('“') && rawQ.endsWith('”') && rawQ.length >= 2)
        const q = (isExactPhrase ? rawQ.slice(1, -1) : rawQ).trim().toLowerCase()
        if (!q) return { totalHits: 0, items: [], nextCursor: null, indexRevision }

        const queryTokens = isExactPhrase ? null : tokenizeText(q)
        const mode = isExactPhrase ? 'exact' : 'fuzzy'

        let targetSecIdx = 0
        let targetMatchOffset = 0
        let targetCharOffset = 0
        let isCursorValid = true
        if (cursor && typeof cursor === 'object') {
            const isRevMatch = !cursor.revision || cursor.revision === indexRevision
            const isQueryMatch = cursor.query === q
            const isBookMatch = cursor.bookId === bookId
            const isModeMatch = !cursor.mode || cursor.mode === mode
            if (isRevMatch && isQueryMatch && isBookMatch && isModeMatch) {
                targetSecIdx = Math.max(0, Number(cursor.sectionIndex) || 0)
                targetMatchOffset = Math.max(0, Number(cursor.matchOffset) || 0)
                targetCharOffset = Math.max(0, Number(cursor.charOffset) || 0)
            } else {
                isCursorValid = false
            }
        }

        if (cursor && !isCursorValid) {
            return {
                totalHits: 0,
                items: [],
                nextCursor: null,
                cursorInvalid: true,
                indexRevision
            }
        }

        // Cache total hits count per (bookId, q, mode, revision)
        const countCacheKey = `${bookId}:${q}:${mode}:${indexRevision}`
        if (!this._matchCountCache) this._matchCountCache = new Map()
        let totalHits = 0
        let countCached = false
        if (this._matchCountCache.has(countCacheKey)) {
            totalHits = this._matchCountCache.get(countCacheKey)
            countCached = true
        }

        const items = []
        let nextCursor = null
        const bookTitle = entry.meta?.title || '未命名书籍'

        // Helper to check token pre-filtering
        const passesFilter = (section) => {
            if (queryTokens && queryTokens.size > 0 && section.tokens?.size > 0) {
                for (const tok of queryTokens) {
                    if (section.tokens.has(tok)) continue
                    const isAlpha = /^[a-z0-9_]+$/.test(tok)
                    if (isAlpha) {
                        let matchAlpha = false
                        for (const sTok of section.tokens) {
                            if (sTok.includes(tok)) { matchAlpha = true; break }
                        }
                        if (matchAlpha) continue
                    }
                    const isCjk = /[\u4e00-\u9fa5\u3040-\u30ff]/.test(tok)
                    if (isCjk) {
                        let matchCjk = false
                        for (const sTok of section.tokens) {
                            if (sTok.includes(tok)) { matchCjk = true; break }
                        }
                        if (matchCjk) continue
                    }
                    return false
                }
            }
            return true
        }

        let lastYield = Date.now()

        if (!countCached) {
            let computedTotal = 0
            for (let sIdx = 0; sIdx < entry.sections.length; sIdx++) {
                if (signal?.aborted) break
                const section = entry.sections[sIdx]
                if (!passesFilter(section)) continue
                const secLower = (section.text || '').toLowerCase()
                let searchIdx = 0
                let secCount = 0
                while (searchIdx <= secLower.length - q.length) {
                    if (signal?.aborted) break
                    const pos = secLower.indexOf(q, searchIdx)
                    if (pos === -1) break
                    secCount++
                    searchIdx = pos + Math.max(1, q.length)
                    if (Date.now() - lastYield >= 6) {
                        await new Promise(r => setTimeout(r, 0))
                        lastYield = Date.now()
                        if (signal?.aborted) break
                    }
                }
                computedTotal += secCount
                if (signal?.aborted) break
            }
            if (signal?.aborted) {
                return { totalHits: computedTotal, items: [], nextCursor: null, indexRevision, aborted: true }
            }
            totalHits = computedTotal
            if (this._matchCountCache.size > 200) {
                const oldest = this._matchCountCache.keys().next().value
                this._matchCountCache.delete(oldest)
            }
            this._matchCountCache.set(countCacheKey, totalHits)
        }

        // Incremental paging: only collect needed page matches without building unbounded arrays
        for (let sIdx = targetSecIdx; sIdx < entry.sections.length; sIdx++) {
            if (signal?.aborted || items.length >= pageSize) break
            const section = entry.sections[sIdx]
            if (!passesFilter(section)) continue

            const secLower = (section.text || '').toLowerCase()
            const isTargetSec = (sIdx === targetSecIdx)
            const startOffset = isTargetSec ? targetMatchOffset : 0
            let currentOffset = isTargetSec && targetCharOffset > 0 ? targetMatchOffset : 0
            let searchIdx = isTargetSec && targetCharOffset > 0 ? targetCharOffset : 0

            while (searchIdx <= secLower.length - q.length) {
                if (signal?.aborted) break
                if (Date.now() - lastYield >= 6) {
                    await new Promise(r => setTimeout(r, 0))
                    lastYield = Date.now()
                }
                const pos = secLower.indexOf(q, searchIdx)
                if (pos === -1) break
                const matchPos = pos
                searchIdx = pos + Math.max(1, q.length)

                if (currentOffset >= startOffset) {
                    if (items.length < pageSize) {
                        const snippet = createExcerptSnippet(section.text, q, 36, matchPos)
                        items.push({
                            bookId,
                            bookTitle,
                            sectionTitle: section.sectionTitle,
                            granularity: section.granularity || 'chapter',
                            location: {
                                ...section.location,
                                matchIndex: currentOffset,
                                matchPos,
                                query: q
                            },
                            query: q,
                            snippet,
                            excerpt: snippet,
                            matchCount: totalHits
                        })
                    } else {
                        // We found the next item after this page: set nextCursor with character checkpoint
                        nextCursor = { sectionIndex: sIdx, matchOffset: currentOffset, charOffset: matchPos, query: q, bookId, revision: indexRevision, mode }
                        break
                    }
                }
                currentOffset++
            }

            if (items.length >= pageSize && !nextCursor) {
                // If section had no more matches but items filled, nextCursor starts at next section
                if (sIdx + 1 < entry.sections.length) {
                    nextCursor = { sectionIndex: sIdx + 1, matchOffset: 0, charOffset: 0, query: q, bookId, revision: indexRevision, mode }
                }
            }

            if (Date.now() - lastYield >= 6) {
                await new Promise(r => setTimeout(r, 0))
                lastYield = Date.now()
            }
        }

        return {
            totalHits,
            items,
            nextCursor,
            indexRevision
        }
    }

    async searchBookFull(bookId, query, options = {}) {
        if (!bookId || !query) return []
        await this._ensureBookIndexFresh(bookId, options?.expectedRevision)
        if (options && (options.cursor || (options.pageSize && options.pageSize !== Infinity))) {
            const pageRes = await this.searchBookPage(bookId, query, {
                cursor: options.cursor,
                pageSize: options.pageSize,
                signal: options.signal,
                expectedRevision: options.expectedRevision
            })
            const arr = pageRes.items || []
            arr.totalHits = pageRes.totalHits
            arr.nextCursor = pageRes.nextCursor
            arr.indexRevision = pageRes.indexRevision
            return arr
        }
        const res = this.search(query, { bookIds: [bookId], limit: options?.limit ?? Infinity })
        res.totalHits = res.totalHits != null ? res.totalHits : res.length
        res.nextCursor = (res.length < res.totalHits) ? { sectionIndex: 0, matchOffset: res.length, query, bookId } : null
        return res
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
                this._trimCache()
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
            if (this.db.deleteBookSearchIndex) {
                const ids = this.db.getBookSearchIndexIds ? await this.db.getBookSearchIndexIds() : (await this.db.getAllBookSearchIndexes?.() || []).map(item => item.bookId)
                for (const id of ids) {
                    if (id && !validSet.has(id)) {
                        await this.db.deleteBookSearchIndex(id)
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
    /**
     * Invalidate cached index in-memory and in persistent storage
     * @param {string} bookId
     */
    async invalidate(bookId) {
        if (!bookId) return
        this.index.delete(bookId)
        try {
            if (this.db?.deleteBookSearchIndex) {
                await this.db.deleteBookSearchIndex(bookId)
            }
        } catch (e) {
            console.warn('[FullTextSearch] Invalidate index error:', e)
        }
    }

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
