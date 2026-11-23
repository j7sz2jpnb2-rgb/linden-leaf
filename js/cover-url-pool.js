

export class ObjectUrlPool {
    constructor(maxCapacity = 2500, maxWarmImages = 180) {
        this.maxCapacity = Math.max(1, maxCapacity)
        this.maxWarmImages = Math.max(1, maxWarmImages)
        this.cache = new Map()        // key -> objectURL (insertion order = LRU order)
        this.blobMeta = new Map()     // key -> "${size}:${type}:${lastModified}"
        this.warmImages = new Map()   // key -> HTMLImageElement (pins decoded bitmap in Blink MemoryCache, LRU bounded)
        this.pendingRoots = new Set() // DocumentFragments or detached roots currently being built
        this.retiredUrls = new Set() // Superseded URLs still referenced by a mounted view
    }
    registerPendingRoot(root) {
        if (!root) return () => {}
        this.pendingRoots.add(root)
        return () => {
            this.pendingRoots.delete(root)
        }
    }
    _touchWarm(key) {
        if (this.warmImages.has(key)) {
            const img = this.warmImages.get(key)
            this.warmImages.delete(key)
            this.warmImages.set(key, img)
            return true
        }
        return false
    }
    _prewarmBitmap(key, url) {
        // Modern bookshelf: do NOT eagerly create offscreen Image instances to decode whole library
    }
    getForBook(book) {
        return this.get(book.id, book.coverBlob, book.coverRevision ?? book.coverBlob?._revision ?? 0)
    }
    get(key, blob, revision = null) {
        if (!blob) return ''
        const rev = revision ?? blob.coverRevision ?? blob._revision ?? blob.lastModified ?? 0
        const sig = `${blob.size ?? 0}:${blob.type ?? ''}:${rev}`
        if (this.cache.has(key)) {
            if (this.blobMeta.get(key) === sig) {
                const existing = this.cache.get(key)
                // Refresh LRU order (delete & re-insert)
                this.cache.delete(key)
                this.cache.set(key, existing)
                if (!this._touchWarm(key)) {
                    this._prewarmBitmap(key, existing)
                }
                return existing
            }
            this.revoke(key)
        }
        try {
            const url = URL.createObjectURL(blob)
            this.cache.set(key, url)
            this.blobMeta.set(key, sig)
            this._prewarmBitmap(key, url)
            return url
        } catch (e) {
            console.warn('[ObjectUrlPool] Failed creating object URL:', e)
            return ''
        }
    }
    pruneUnused(force = false) {
        if (!force && this.cache.size <= this.maxCapacity && this.retiredUrls.size === 0) return
        const activeUrls = new Set()
        try {
            const domImgs = document.querySelectorAll('img[src^="blob:"], [data-cover-url^="blob:"]')
            for (const el of domImgs) {
                if (el.src && el.src.startsWith('blob:')) activeUrls.add(el.src)
                const dUrl = el.getAttribute?.('data-cover-url')
                if (dUrl && dUrl.startsWith('blob:')) activeUrls.add(dUrl)
            }
        } catch (_) {}

        if (this.pendingRoots.size > 0) {
            for (const root of this.pendingRoots) {
                try {
                    const pendingImgs = root.querySelectorAll?.('img[src^="blob:"], [data-cover-url^="blob:"]') || []
                    for (const el of pendingImgs) {
                        if (el.src && el.src.startsWith('blob:')) activeUrls.add(el.src)
                        const dUrl = el.getAttribute?.('data-cover-url')
                        if (dUrl && dUrl.startsWith('blob:')) activeUrls.add(dUrl)
                    }
                } catch (_) {}
            }
        }

        const targetSize = force ? 0 : Math.floor(this.maxCapacity * 0.85)
        for (const url of this.retiredUrls) {
            if (!activeUrls.has(url)) {
                URL.revokeObjectURL(url)
                this.retiredUrls.delete(url)
            }
        }
        for (const [key, url] of [...this.cache.entries()]) {
            if (!force && this.cache.size <= targetSize) break
            if (!activeUrls.has(url)) {
                this.revoke(key)
            }
        }
    }
    revoke(key) {
        if (this.cache.has(key)) {
            try {
                const url = this.cache.get(key)
                const roots = [document, ...this.pendingRoots]
                const inUse = roots.some(root => Array.from(root.querySelectorAll?.('img[src^="blob:"]') || []).some(img => img.src === url))
                if (inUse) this.retiredUrls.add(url)
                else URL.revokeObjectURL(url)
            } catch (e) {}
            this.cache.delete(key)
        }
        this.blobMeta.delete(key)
        this.warmImages.delete(key)
    }
    clear() {
        for (const url of [...this.cache.values(), ...this.retiredUrls]) {
            try {
                URL.revokeObjectURL(url)
            } catch (e) {}
        }
        this.cache.clear()
        this.blobMeta.clear()
        this.warmImages.clear()
        this.pendingRoots.clear()
        this.retiredUrls.clear()
    }
}

export const coverUrlPool = new ObjectUrlPool(2500, 180)

if (typeof window !== 'undefined') { window.ObjectUrlPool = ObjectUrlPool; window.coverUrlPool = coverUrlPool }
