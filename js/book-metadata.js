// Shared book metadata wire format. No DB, UI, or platform side effects.

export const MAX_AUTO_SYNC_BYTES = 15 * 1024 * 1024

export const SUPPORTED_IMPORT_FORMATS = Object.freeze(['epub', 'pdf', 'docx', 'txt', 'md', 'mobi', 'azw', 'azw3', 'fb2', 'cbz'])

export const ALLOWED_BOOK_FORMATS = new Set([...SUPPORTED_IMPORT_FORMATS, 'djvu'])

export const sanitizeSyncFormat = (raw) => {
    if (typeof raw !== 'string') return 'epub'
    const clean = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    return ALLOWED_BOOK_FORMATS.has(clean) ? clean : 'epub'
}

export const sanitizeCloudFileName = (raw) => {
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.includes('%') || trimmed.startsWith('.')) {
        return null
    }
    return trimmed
}

export const isAutoDownloadEligible = (bookMeta) => {
    if (!bookMeta) return false
    const hasCloud = !!(bookMeta.cloudBackup?.hasBackup || bookMeta.hasCloudBackup)
    if (!hasCloud) return false
    const fmt = (bookMeta.format || '').toLowerCase()
    const size = bookMeta.size || bookMeta.cloudBackup?.size || 0
    // High-risk large formats (PDF, CBZ) require explicit user confirmation to protect 3GB monthly quota
    if (fmt === 'pdf' || fmt === 'cbz') return false
    if (size >= MAX_AUTO_SYNC_BYTES) return false
    return true
}

export const isAutoUploadEligible = (bookMeta) => {
    if (!bookMeta) return false
    const fmt = (bookMeta.format || '').toLowerCase()
    const size = bookMeta.size || 0
    // Never auto-upload PDF or CBZ or files >= 15MB to protect 1GB monthly quota
    if (fmt === 'pdf' || fmt === 'cbz') return false
    if (size >= MAX_AUTO_SYNC_BYTES) return false
    return true
}

export const VALID_READING_STATUSES = ['unread', 'want_to_read', 'reading', 'on_hold', 'finished']

export const ALL_READING_STATUSES = VALID_READING_STATUSES

/**
 * Resolves reading state for a book deterministically without importing DB or UI modules.
 * @param {object} book
 * @returns {'unread' | 'want_to_read' | 'reading' | 'on_hold' | 'finished'}
 */
export function resolveReadingState(book) {
    if (!book || typeof book !== 'object') return 'unread'
    if (book.readingStatus && VALID_READING_STATUSES.includes(book.readingStatus)) {
        return book.readingStatus
    }
    if (typeof book.completedAt === 'number' && book.completedAt > 0) {
        return 'finished'
    }
    const frac = (book.progress && typeof book.progress.fraction === 'number') ? book.progress.fraction : 0
    const lastRead = typeof book.lastReadAt === 'number' ? book.lastReadAt : 0
    const totalSecs = typeof book.totalReadingSeconds === 'number' ? book.totalReadingSeconds
        : (typeof book.readingTimeSeconds === 'number' ? book.readingTimeSeconds : 0)
    if (frac > 0 || lastRead > 0 || totalSecs > 0) {
        return 'reading'
    }
    return 'unread'
}

export function getSafeCloudFileName(book) {
    if (!book) return 'book.epub'
    if (book.cloudBackup?.fileName) {
        const savedName = String(book.cloudBackup.fileName).trim()
        if (savedName && !/[\\/%?#\0:*"><|]/.test(savedName) && !savedName.startsWith('.')) {
            return savedName
        }
    }
    const fmt = (book.format || 'epub').toLowerCase().replace(/[^a-z0-9]/g, '') || 'epub'
    const safeId = (book.id || 'book').replace(/[^a-zA-Z0-9_-]/g, '_')
    let rawKey = (book.stableKey || '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_').trim()
    if (rawKey.startsWith('.')) rawKey = rawKey.replace(/^\.+/, '')
    if (rawKey.length > 50) rawKey = rawKey.slice(0, 50)
    const baseName = (rawKey && rawKey !== safeId) ? `${rawKey}_${safeId}` : safeId
    return `${baseName}.${fmt}`
}

export const buildBookSyncMeta = (b) => {
    const rawIdent = b.identifier
    const isEphemeral = typeof rawIdent === 'string' && /^(txt|docx|pdf)-\d{10,}$/.test(rawIdent)
    const validIdent = isEphemeral ? null : rawIdent
    const stableKey = b.stableKey || validIdent || `${b.title || ''}_${b.size || 0}_${b.format || ''}`.replace(/\s+/g, '').toLowerCase()
    return {
        id: b.id,
        documentHash: b.documentHash || null,
        documentHashAliases: b.documentHashAliases || [],
        blobRevision: b.blobRevision || null,
        revisionOrigin: b.revisionOrigin || null,
        cropSettings: b.cropSettings || null,
        stableKey,
        identifier: validIdent,
        title: b.title,
        author: b.author,
        customTitle: b.customTitle || null,
        customAuthor: b.customAuthor || null,
        format: b.format,
        ...(['txt', 'md'].includes(b.format) ? {
            language: b.language || null,
            txtLayoutVersion: b.txtLayoutVersion || null,
        } : {}),
        size: b.size,
        cover: b.cover || null,
        isFavorite: !!b.isFavorite,
        favoriteUpdatedAt: b.favoriteUpdatedAt || b.updatedAt || 0,
        customListIds: b.customListIds || [],
        listsUpdatedAt: b.listsUpdatedAt || b.updatedAt || 0,
        progress: b.progress || { fraction: 0 },
        tags: Array.isArray(b.tags) ? b.tags : [],
        tagsUpdatedAt: b.tagsUpdatedAt || 0,
        readingStatus: b.readingStatus || (b.lastReadAt > 0 ? 'reading' : 'unread'),
        statusUpdatedAt: b.statusUpdatedAt || 0,
        completedAt: b.completedAt || null,
        rating: b.rating !== undefined ? b.rating : null,
        ratingUpdatedAt: b.ratingUpdatedAt || 0,
        isArchived: !!b.isArchived,
        archivedAt: b.archivedAt || null,
        archivedUpdatedAt: b.archivedUpdatedAt || 0,
        lastReadAt: b.lastReadAt || 0,
        totalReadingSeconds: b.totalReadingSeconds || 0,
        totalListeningSeconds: b.totalListeningSeconds || 0,
        addedAt: b.addedAt || Date.now(),
        updatedAt: b.updatedAt || b.lastReadAt || b.addedAt || Date.now(),
        cloudBackup: b.cloudBackup || (b.cloudBackupState === 'synced' ? {
            hasBackup: true,
            fileName: b.cloudBackupFileName || `${b.stableKey || b.id}.${b.format}`,
            size: b.size,
            format: b.format,
            uploadedAt: b.cloudBackupUploadedAt || Date.now()
        } : null)
    }
}

