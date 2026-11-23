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
