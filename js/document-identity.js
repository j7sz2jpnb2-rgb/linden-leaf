import { t } from './i18n.js'

// Content identity is independent of file path, title, ISBN and local snapshot revision.
const algorithm = hash => /^[a-f0-9]{64}$/i.test(hash) ? 'sha256'
    : hash.startsWith('hash_') ? 'legacy-native' : hash.startsWith('s_') ? 'sample' : 'legacy';
export const identityHashes = item => [...new Set([
    typeof item === 'string' ? item : item?.documentHash,
    ...(Array.isArray(item?.documentHashAliases) ? item.documentHashAliases : []), item?.legacyDocumentHash
].filter(h => typeof h === 'string' && h))];

export const identityAliases = (primary, ...items) => [...new Set(items.flatMap(identityHashes))].filter(h => h !== primary)

export function contentIdentityRelation(a, b) {
    const left = identityHashes(a), right = identityHashes(b)
    const leftSha = left.filter(h => algorithm(h) === 'sha256')
    const rightSha = right.filter(h => algorithm(h) === 'sha256')
    // Verified SHA-256 mismatch is authoritative; legacy aliases must never bridge two different files.
    if (leftSha.length && rightSha.length) {
        return leftSha.some(h => rightSha.includes(h)) ? 'same' : 'different'
    }
    if (left.some(h => algorithm(h) !== 'sample' && right.includes(h))) return 'same'
    const comparable = left.some(x => algorithm(x) !== 'sample' && right.some(y => algorithm(x) === algorithm(y)))
    return comparable ? 'different' : 'unknown'
}

export const normalizeBookPath = path => String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
export const isSameBookPath = (book, path) => Boolean(path && [book.nativePath, book.filePath].some(p => p && normalizeBookPath(p) === normalizeBookPath(path)))

export async function computeContentHash(blob) {
    if (!blob?.size) return blob ? 'e_empty' : null
    if (typeof blob.materialize === 'function') blob = await blob.materialize()
    if (!globalThis.crypto?.subtle) throw new Error(t('error.cryptoUnavailable'))
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// Older sampled hashes are verified against their saved bytes before reusing a book.
export async function findSameContentBook(books, source, getSnapshot) {
    const compatible = books.filter(b => (!b.format || b.format === source.format) && (!b.size || !source.size || b.size === source.size))
    const exact = compatible.find(b => contentIdentityRelation(b, source) === 'same')
    if (exact) return exact
    for (const book of compatible) {
        if (contentIdentityRelation(book, source) === 'different') continue
        if (!isSameBookPath(book, source.nativePath) && book.filename !== source.filename && book.stableKey !== source.stableKey) continue
        const snapshot = await getSnapshot(book.id)
        if (snapshot?.blob instanceof Blob && await computeContentHash(snapshot.blob) === source.documentHash) return book
    }
    return null
}

function fnv1a32(str) {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
}

// Extract a compact bottom-k 5-gram shingle fingerprint from normalized document text
// for content relinking when a file's bytes or container changed (e.g. re-saved PDF/EPUB).
export function computeTextSampleFingerprint(rawText = '') {
    const clean = String(rawText || '')
        .replace(/[\s\p{P}\p{S}]+/gu, '')
        .toLowerCase()
    if (!clean) return null

    let sampled = clean
    if (clean.length > 9000) {
        const midStart = Math.max(0, Math.floor((clean.length - 3000) / 2))
        sampled = clean.slice(0, 3000) + clean.slice(midStart, midStart + 3000) + clean.slice(clean.length - 3000)
    }

    const shingleSet = new Set()
    if (sampled.length < 5) {
        shingleSet.add(fnv1a32(sampled))
    } else {
        const stride = sampled.length > 3200 ? 2 : 1
        for (let i = 0; i <= sampled.length - 5; i += stride) {
            shingleSet.add(fnv1a32(sampled.slice(i, i + 5)))
        }
    }

    const bottomK = Array.from(shingleSet)
        .sort((a, b) => a - b)
        .slice(0, 48)
        .map(n => n.toString(16).padStart(8, '0'))

    return {
        v: 1,
        length: clean.length,
        head: clean.slice(0, 120),
        shingles: bottomK
    }
}

function normalizeMetaText(val) {
    return String(val || '')
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function diceBigrams(a, b) {
    if (!a || !b) return 0
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0
    const counts = new Map()
    for (let i = 0; i < a.length - 1; i++) {
        const bg = a.slice(i, i + 2)
        counts.set(bg, (counts.get(bg) || 0) + 1)
    }
    let matches = 0
    for (let i = 0; i < b.length - 1; i++) {
        const bg = b.slice(i, i + 2)
        const c = counts.get(bg) || 0
        if (c > 0) {
            matches++
            counts.set(bg, c - 1)
        }
    }
    return (2 * matches) / ((a.length - 1) + (b.length - 1))
}

export function scoreRelinkCandidate(targetBook, candidateBook, knowledgeSummary = null) {
    if (!targetBook || !candidateBook || String(targetBook.id) === String(candidateBook.id)) {
        return { score: 0, similarity: 0, reasons: [] }
    }
    let rawScore = 0
    let similarity = 0
    const reasons = []

    if (contentIdentityRelation(targetBook, candidateBook) === 'same') {
        rawScore += 70
        similarity = 1
        reasons.push('exact_hash')
    }

    const fpA = targetBook.textFingerprint?.shingles
    const fpB = candidateBook.textFingerprint?.shingles
    if (Array.isArray(fpA) && Array.isArray(fpB) && fpA.length && fpB.length) {
        const setB = new Set(fpB)
        let inter = 0
        for (const s of fpA) {
            if (setB.has(s)) inter++
        }
        const union = new Set([...fpA, ...fpB]).size
        const jaccard = union > 0 ? inter / union : 0
        similarity = Math.max(similarity, jaccard)
        if (jaccard >= 0.15) {
            rawScore += Math.round(jaccard * 60)
            reasons.push('text_fingerprint')
        }
    }

    const titleA = normalizeMetaText(targetBook.customTitle || targetBook.title)
    const titleB = normalizeMetaText(candidateBook.customTitle || candidateBook.title)
    if (titleA && titleB) {
        if (titleA === titleB) {
            rawScore += 25
            reasons.push('title_exact')
        } else {
            const titleSim = diceBigrams(titleA, titleB)
            if (titleA.includes(titleB) || titleB.includes(titleA) || titleSim >= 0.55) {
                rawScore += Math.round(15 * Math.max(0.7, titleSim))
                reasons.push('title_similar')
            }
        }
    }

    const authorA = normalizeMetaText(targetBook.customAuthor || targetBook.author)
    const authorB = normalizeMetaText(candidateBook.customAuthor || candidateBook.author)
    if (authorA && authorB && (authorA === authorB || authorA.includes(authorB) || authorB.includes(authorA))) {
        rawScore += 10
        reasons.push('author_match')
    }

    if (targetBook.format && candidateBook.format && targetBook.format === candidateBook.format) {
        rawScore += 5
        reasons.push('same_format')
    }

    const noteCount = knowledgeSummary
        ? ((knowledgeSummary.highlights || 0) + (knowledgeSummary.bookmarks || 0) + (knowledgeSummary.pdfDrawings || 0))
        : 0
    if (noteCount > 0) {
        rawScore += Math.min(8, noteCount)
        reasons.push('has_annotations')
    }

    return {
        score: Math.min(100, rawScore),
        similarity: Number(similarity.toFixed(3)),
        noteCount,
        reasons
    }
}
