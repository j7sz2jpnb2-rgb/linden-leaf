/**
 * custom-font-manager.js - Local Custom Font Storage & FontFace Management
 * Supports TTF, OTF, WOFF, WOFF2 with format & size validation, in-memory caching,
 * and scoped @font-face CSS injection for Foliate reading engine.
 * Local custom-font storage and loading.
 */

const DB_NAME = 'linden_fonts_db'
const DB_VERSION = 1
const STORE_NAME = 'fonts'
const MAX_FONT_SIZE_BYTES = 40 * 1024 * 1024 // 40MB limit per font
const MAX_TOTAL_FONT_BUDGET = 200 * 1024 * 1024 // 200MB total budget

class CustomFontManager {
    constructor() {
        this._dbPromise = null
        this._loadedFaces = new Map() // fontId -> FontFace
        this._blobUrls = new Map() // fontId -> blobUrl
        this._metadataCache = null
        this._cachedCSS = ''
        this._fontsList = []
    }

    async init(activeFontId = null) {
        try {
            this._metadataCache = null
            this._fontsList = await this.listFonts()
            // R9: Eagerly load only the active custom font if specified; defer other fonts until selected
            if (activeFontId && this._fontsList.some(f => f.id === activeFontId)) {
                await this.ensureFontLoadedInDocument(activeFontId)
                const css = await this.generateFontFaceCSS(activeFontId)
                this._cachedCSS = css
            }
        } catch (e) {
            console.warn('[CustomFontManager] Init error:', e)
        }
    }

    async updateCachedCSS() {
        this._metadataCache = null
        this._fontsList = await this.listFonts()
        let css = ''
        for (const f of this._fontsList) {
            css += (await this.generateFontFaceCSS(f.id)) + '\n'
        }
        this._cachedCSS = css
        return css
    }

    getCachedCSS() {
        return this._cachedCSS || ''
    }

    getFontsList() {
        return this._fontsList || []
    }

    getFontMeta(idOrFamily) {
        if (!idOrFamily) return null
        return (this._fontsList || []).find(f => f.id === idOrFamily || f.familyName === idOrFamily) || null
    }

    _openDB() {
        if (this._dbPromise) return this._dbPromise
        this._dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                return reject(new Error('IndexedDB not supported in current environment'))
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION)
            request.onupgradeneeded = (e) => {
                const db = e.target.result
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' })
                }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        return this._dbPromise
    }

    /**
     * Inspect file header magic bytes to verify font format
     * @param {ArrayBuffer} buffer
     * @returns {"truetype" | "opentype" | "woff" | "woff2" | null}
     */
    sniffFontFormat(buffer) {
        if (!buffer || buffer.byteLength < 4) return null
        const view = new DataView(buffer)
        const magic = view.getUint32(0, false)

        // 0x00010000 -> TrueType
        if (magic === 0x00010000) return 'truetype'
        // 'true' -> TrueType
        if (magic === 0x74727565) return 'truetype'
        // 'OTTO' -> OpenType with PostScript outlines
        if (magic === 0x4F54544F) return 'opentype'
        // 'wOFF' -> WOFF
        if (magic === 0x774F4646) return 'woff'
        // 'wOF2' -> WOFF2
        if (magic === 0x774F4632) return 'woff2'

        return null
    }

    /**
     * Validates font buffer and attempts FontFace loading
     * @param {string} familyName
     * @param {ArrayBuffer} buffer
     * @returns {Promise<boolean>}
     */
    async validateFontFace(familyName, buffer) {
        if (typeof FontFace === 'undefined') return true
        try {
            const face = new FontFace(familyName, buffer)
            const loaded = await face.load()
            if (loaded.status === 'loaded') return true
            return false
        } catch (e) {
            console.warn('[CustomFontManager] Font validation failed:', e)
            return false
        }
    }

    /**
     * Import a font from a File or ArrayBuffer
     * @param {File | { name: string, buffer: ArrayBuffer }} fileOrData
     * @returns {Promise<{ id: string, name: string, familyName: string, format: string, size: number }>}
     */
    async importFont(fileOrData) {
        let buffer
        let fileName = 'custom_font.ttf'
        if (fileOrData instanceof File || fileOrData instanceof Blob) {
            fileName = fileOrData.name || fileName
            buffer = await fileOrData.arrayBuffer()
        } else if (fileOrData.buffer) {
            fileName = fileOrData.name || fileName
            buffer = fileOrData.buffer
        } else {
            throw new Error('无效的字体输入数据')
        }

        if (buffer.byteLength > MAX_FONT_SIZE_BYTES) {
            throw new Error(`字体文件过大 (${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB)，单文件上限为 40MB`)
        }

        // Validate format
        const format = this.sniffFontFormat(buffer)
        if (!format) {
            throw new Error('不支持的字体格式。仅支持经过验证的 TTF、OTF、WOFF、WOFF2 字体文件。')
        }

        // Generate sanitized name & safe internal family name
        const cleanName = fileName.replace(/\.[^/.]+$/, '').trim().slice(0, 30) || '自定义字体'
        const fontId = 'font_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
        const familyName = `LindenCustomFont_${fontId}`

        // Validate readability with FontFace
        const isValid = await this.validateFontFace(familyName, buffer)
        if (!isValid) {
            throw new Error('字体数据解析失败，文件可能已损坏或编码异常')
        }

        // Check total budget
        const existing = await this.listFonts()
        const totalSize = existing.reduce((acc, f) => acc + (f.size || 0), 0) + buffer.byteLength
        if (totalSize > MAX_TOTAL_FONT_BUDGET) {
            throw new Error(`已超出自定义字体存储总量预算 (${Math.round(totalSize / 1024 / 1024)}MB / 200MB)，请先删除不再使用的字体。`)
        }

        // Save to IndexedDB
        const db = await this._openDB()
        const record = {
            id: fontId,
            name: cleanName,
            familyName,
            format,
            size: buffer.byteLength,
            createdAt: Date.now(),
            data: buffer
        }

        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite')
            const store = tx.objectStore(STORE_NAME)
            store.put(record)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })

        await this.updateCachedCSS()
        await this.ensureFontLoadedInDocument(fontId)
        return {
            id: fontId,
            name: cleanName,
            familyName,
            format,
            size: buffer.byteLength
        }
    }

    /**
     * List all installed custom fonts (metadata only)
     * @returns {Promise<Array<{ id: string, name: string, familyName: string, format: string, size: number, createdAt: number }>>}
     */
    async listFonts() {
        if (this._metadataCache) return this._metadataCache
        const db = await this._openDB()
        const list = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly')
            const store = tx.objectStore(STORE_NAME)
            const req = store.getAll()
            req.onsuccess = () => {
                const results = (req.result || []).map(r => ({
                    id: r.id,
                    name: r.name,
                    familyName: r.familyName,
                    format: r.format,
                    size: r.size,
                    createdAt: r.createdAt
                }))
                resolve(results)
            }
            req.onerror = () => reject(req.error)
        })
        this._metadataCache = list
        return list
    }

    /**
     * Get font data buffer by ID
     * @param {string} fontId
     * @returns {Promise<ArrayBuffer | null>}
     */
    async getFontBuffer(fontId) {
        const db = await this._openDB()
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly')
            const store = tx.objectStore(STORE_NAME)
            const req = store.get(fontId)
            req.onsuccess = () => resolve(req.result?.data || null)
            req.onerror = () => reject(req.error)
        })
    }

    /**
     * Get or create object URL for font by ID
     * @param {string} fontId
     * @returns {Promise<string | null>}
     */
    async getFontBlobUrl(fontId) {
        if (this._blobUrls.has(fontId)) {
            return this._blobUrls.get(fontId)
        }
        const buffer = await this.getFontBuffer(fontId)
        if (!buffer) return null

        const mimeMap = {
            truetype: 'font/ttf',
            opentype: 'font/otf',
            woff: 'font/woff',
            woff2: 'font/woff2'
        }
        const fonts = await this.listFonts()
        const meta = fonts.find(f => f.id === fontId)
        const mime = (meta && mimeMap[meta.format]) || 'application/octet-stream'

        const blob = new Blob([buffer], { type: mime })
        const url = URL.createObjectURL(blob)
        this._blobUrls.set(fontId, url)
        return url
    }

    /**
     * Ensures custom font is registered with document.fonts for preview
     * @param {string} fontId
     * @returns {Promise<boolean>}
     */
    async ensureFontLoadedInDocument(fontId) {
        if (this._loadedFaces.has(fontId)) return true
        const buffer = await this.getFontBuffer(fontId)
        if (!buffer) return false

        const fonts = await this.listFonts()
        const meta = fonts.find(f => f.id === fontId)
        if (!meta) return false

        try {
            const face = new FontFace(meta.familyName, buffer)
            const loaded = await face.load()
            document.fonts.add(loaded)
            this._loadedFaces.set(fontId, loaded)
            return true
        } catch (e) {
            console.warn('[CustomFontManager] Failed to register font in document:', e)
            return false
        }
    }

    /**
     * Generate @font-face CSS rule for injection into Foliate iframe / reader
     * @param {string} fontId
     * @returns {Promise<string>}
     */
    async generateFontFaceCSS(fontId) {
        const fonts = await this.listFonts()
        const meta = fonts.find(f => f.id === fontId)
        if (!meta) return ''

        const blobUrl = await this.getFontBlobUrl(fontId)
        if (!blobUrl) return ''

        const formatSpec = meta.format === 'truetype' ? 'truetype'
            : meta.format === 'opentype' ? 'opentype'
            : meta.format === 'woff2' ? 'woff2' : 'woff'

        return `
            @font-face {
                font-family: "${meta.familyName}";
                src: url("${blobUrl}") format("${formatSpec}");
                font-display: swap;
                font-weight: normal;
                font-style: normal;
            }
        `
    }

    /**
     * Delete a custom font by ID
     * @param {string} fontId
     * @returns {Promise<boolean>}
     */
    async deleteFont(fontId) {
        const db = await this._openDB()
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite')
            const store = tx.objectStore(STORE_NAME)
            store.delete(fontId)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })

        if (this._blobUrls.has(fontId)) {
            try { URL.revokeObjectURL(this._blobUrls.get(fontId)) } catch (e) {}
            this._blobUrls.delete(fontId)
        }
        if (this._loadedFaces.has(fontId)) {
            try { document.fonts.delete(this._loadedFaces.get(fontId)) } catch (e) {}
            this._loadedFaces.delete(fontId)
        }
        this._metadataCache = null
        await this.updateCachedCSS()
        return true
    }
}

export const customFontManager = new CustomFontManager()
