// js/tags-manager.js - Tags & Reading Status Management for Linden Leaf
// Features: Unicode normalized tags, multi-select, batch add/remove, rename,
// distinct reading status (unread/reading/on_hold/finished), completedAt tracking,
// and safe LWW sync reconciliation.

import * as db from './db.js'

export const VALID_READING_STATUSES = ['unread', 'reading', 'on_hold', 'finished']

export const STATUS_LABELS = {
    unread: '未读',
    reading: '在读',
    on_hold: '搁置',
    finished: '读完'
}

/**
 * Normalizes and validates a tag string
 * @param {string} tag
 * @returns {string | null} Normalized string or null if invalid
 */
export function normalizeTag(tag) {
    if (!tag || typeof tag !== 'string') return null
    const cleaned = tag.normalize('NFC').trim()
    if (!cleaned) return null
    // Reject control characters or newlines
    if (/[\u0000-\u001F\u007F]/.test(cleaned)) return null
    // Limit single tag length to 24 characters
    const trimmed = cleaned.slice(0, 24).trim()
    return trimmed.length > 0 ? trimmed : null
}

/**
 * Normalizes a list of tags (deduplicates, removes empty)
 * @param {string[]} tags
 * @param {number} [maxTags=20]
 * @returns {string[]}
 */
export function normalizeTagList(tags, maxTags = 20) {
    if (!Array.isArray(tags)) return []
    const set = new Set()
    for (const t of tags) {
        const norm = normalizeTag(t)
        if (norm) set.add(norm)
        if (set.size >= maxTags) break
    }
    return Array.from(set)
}

/**
 * Retrieve all unique tags in use across all books, with counts
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
export async function getAllTagsWithCounts() {
    const books = await db.getAllBooks()
    const counts = new Map() // tag -> count

    for (const b of books) {
        const tags = Array.isArray(b.tags) ? b.tags : []
        for (const t of tags) {
            const norm = normalizeTag(t)
            if (norm) {
                counts.set(norm, (counts.get(norm) || 0) + 1)
            }
        }
    }

    const result = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))

    return result
}

/**
 * Update tags for a single book
 * @param {string} bookId
 * @param {string[]} newTags
 * @returns {Promise<boolean>}
 */
export async function updateBookTags(bookId, newTags) {
    if (!bookId) return false
    const book = await db.getBook(bookId)
    if (!book) return false

    const cleanTags = normalizeTagList(newTags)
    await db.saveBook({
        id: bookId,
        tags: cleanTags,
        tagsUpdatedAt: Date.now()
    })
    return true
}

/**
 * Add a tag to multiple books in batch
 * @param {string[]} bookIds
 * @param {string} tag
 * @returns {Promise<number>} Number of books updated
 */
export async function batchAddTag(bookIds, tag, dbAdapter = db) {
    const norm = normalizeTag(tag)
    if (!norm || !bookIds || !bookIds.length) return 0

    let updatedCount = 0
    for (const id of bookIds) {
        const book = await dbAdapter.getBook(id)
        if (book) {
            const existing = normalizeTagList(Array.isArray(book.tags) ? book.tags : [], 20)
            if (!existing.includes(norm) && existing.length < 20) {
                const newTags = normalizeTagList([...existing, norm], 20)
                await dbAdapter.saveBook({
                    id,
                    tags: newTags,
                    tagsUpdatedAt: Date.now()
                })
                updatedCount++
            }
        }
    }
    return updatedCount
}

/**
 * Remove a tag from multiple books in batch
 * @param {string[]} bookIds
 * @param {string} tag
 * @param {object} [dbAdapter=db]
 * @returns {Promise<number>} Number of books updated
 */
export async function batchRemoveTag(bookIds, tag, dbAdapter = db) {
    const norm = normalizeTag(tag)
    if (!norm || !bookIds || !bookIds.length) return 0

    let updatedCount = 0
    for (const id of bookIds) {
        const book = await dbAdapter.getBook(id)
        if (book) {
            const existing = new Set(Array.isArray(book.tags) ? book.tags : [])
            if (existing.has(norm)) {
                existing.delete(norm)
                await dbAdapter.saveBook({
                    id,
                    tags: Array.from(existing),
                    tagsUpdatedAt: Date.now()
                })
                updatedCount++
            }
        }
    }
    return updatedCount
}

/**
 * Rename a tag globally across all books
 * @param {string} oldTag
 * @param {string} newTag
 * @returns {Promise<{ success: boolean, updatedCount: number, error?: string }>}
 */
export async function renameTagGlobally(oldTag, newTag) {
    const normOld = normalizeTag(oldTag)
    const normNew = normalizeTag(newTag)
    if (!normOld || !normNew) {
        return { success: false, updatedCount: 0, error: '标签名称不能为空' }
    }
    if (normOld === normNew) {
        return { success: true, updatedCount: 0 }
    }

    const books = await db.getAllBooks()
    let updatedCount = 0

    for (const b of books) {
        const tags = Array.isArray(b.tags) ? b.tags : []
        if (tags.includes(normOld)) {
            const set = new Set(tags)
            set.delete(normOld)
            set.add(normNew)
            await db.saveBook({
                id: b.id,
                tags: Array.from(set),
                tagsUpdatedAt: Date.now()
            })
            updatedCount++
        }
    }

    return { success: true, updatedCount }
}

/**
 * Delete a tag globally from all books
 * @param {string} tag
 * @returns {Promise<{ success: boolean, updatedCount: number }>}
 */
export async function deleteTagGlobally(tag) {
    const norm = normalizeTag(tag)
    if (!norm) return { success: false, updatedCount: 0 }

    const books = await db.getAllBooks()
    let updatedCount = 0

    for (const b of books) {
        const tags = Array.isArray(b.tags) ? b.tags : []
        if (tags.includes(norm)) {
            const set = new Set(tags)
            set.delete(norm)
            await db.saveBook({
                id: b.id,
                tags: Array.from(set),
                tagsUpdatedAt: Date.now()
            })
            updatedCount++
        }
    }

    return { success: true, updatedCount }
}

/**
 * Set reading status for a book
 * @param {string} bookId
 * @param {'unread' | 'reading' | 'on_hold' | 'finished'} status
 * @param {number | null} [completedAt] Specific completion timestamp (optional)
 * @returns {Promise<boolean>}
 */
export async function setReadingStatus(bookId, status, completedAt = undefined) {
    if (!bookId || !VALID_READING_STATUSES.includes(status)) return false
    const book = await db.getBook(bookId)
    if (!book) return false

    const patch = {
        id: bookId,
        readingStatus: status,
        statusUpdatedAt: Date.now()
    }

    if (status === 'finished') {
        patch.completedAt = completedAt !== undefined ? completedAt : (book.completedAt || Date.now())
    } else {
        patch.completedAt = completedAt !== undefined ? completedAt : null
    }

    await db.saveBook(patch)
    return true
}
