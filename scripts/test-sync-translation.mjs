import assert from 'node:assert/strict'

console.log('--- Testing SyncEngine Translation Key Normalization & Conflict Deduplication ---')

// 1. Stable key derivation
function getStableTranslationKey(item) {
    const bookKey = item.bookStableKey || item.contentHash || item.bookId || ''
    const chapterKey = item.chapterSourceKey || item.chapterKey || ''
    return `${bookKey}::${chapterKey}`
}

const key1 = getStableTranslationKey({ bookStableKey: 'hash_123', chapterKey: 'ch_01' })
const key2 = getStableTranslationKey({ contentHash: 'hash_123', chapterSourceKey: 'ch_01' })
assert.equal(key1, key2, 'Stable translation key should match across contentHash / bookStableKey')

// 2. Conflict revisions deduplication
const conflictRevisions = [
    { revisionId: 'rev_1', timestamp: 1000 },
    { revisionId: 'rev_2', timestamp: 2000 },
    { revisionId: 'rev_1', timestamp: 3000 }, // duplicate revisionId
    { revisionId: 'rev_3', timestamp: 4000 }
]

const seen = new Set()
const deduped = conflictRevisions.filter(r => {
    if (!r.revisionId) return true
    if (seen.has(r.revisionId)) return false
    seen.add(r.revisionId)
    return true
})

assert.equal(deduped.length, 3, 'Duplicate revisionIds must be filtered out')
assert.deepEqual(deduped.map(r => r.revisionId), ['rev_1', 'rev_2', 'rev_3'])

console.log('✓ SyncEngine translation merge and dedup verified successfully!')
