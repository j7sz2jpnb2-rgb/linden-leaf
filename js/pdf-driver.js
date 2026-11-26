import { identityAliases } from './document-identity.js'
import { t } from './i18n.js'
// PDF backend abstraction.
// PDF.js is fallback; native Rust PDF engine is default acceleration in Tauri
// path for local files. Both expose the same viewport-facing surface.

import { platformBridge } from './platformBridge.js'

const abortError = () => new DOMException('Render cancelled', 'AbortError')

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * Joins MuPDF character geometry entries into plain text while inserting spaces
 * across line boundaries when adjacent lines lack separating whitespace.
 * @param {Array<{ text?: string, line?: number }>} chars
 * @returns {string}
 */
export function joinMuPdfGeometryChars(chars) {
    if (!Array.isArray(chars) || !chars.length) return ''
    let result = ''
    let currentLine = null
    let lineText = ''
    const flush = () => {
        if (!lineText) return
        if (result && !/\s$/.test(result) && !/^\s/.test(lineText)) {
            result += ' '
        }
        result += lineText
        lineText = ''
    }
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]
        if (!ch) continue
        if (currentLine !== null && ch.line != null && ch.line !== currentLine) {
            flush()
        }
        if (ch.line != null) currentLine = ch.line
        lineText += (ch.text || '')
    }
    flush()
    return result
}

/**
 * Decodes an `LLP3` QOI-RGBA payload into a destination RGBA pixel array.
 * Matches `append_qoi_rgba` in `src-tauri/src/commands/mupdf.rs` byte-for-byte.
 * @param {Uint8Array} src
 * @param {number} pixelCount
 * @param {Uint8ClampedArray|Uint8Array} dstBytes
 */
export function decodeQoiRgbaPayload(src, pixelCount, dstBytes) {
    const srcLen = src.length
    if (dstBytes.length < pixelCount * 4) {
        throw new Error('Destination RGBA buffer too small for LLP3 packet')
    }
    const useU32 = IS_LITTLE_ENDIAN && (dstBytes.byteOffset % 4 === 0)
    const dst32 = useU32
        ? new Uint32Array(dstBytes.buffer, dstBytes.byteOffset, pixelCount)
        : null
    const index = new Uint32Array(64)
    let r = 255, g = 255, b = 255, a = 255
    let prev = 0xFFFFFFFF
    let p = 0
    let i = 0

    while (i < srcLen && p < pixelCount) {
        const b1 = src[i++]
        if (b1 === 0xFE) {
            if (i + 3 > srcLen) throw new Error('Truncated LLP3 RGB pixel')
            r = src[i++]; g = src[i++]; b = src[i++]
            prev = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
            index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = prev
            if (dst32) { dst32[p++] = prev } else {
                const o = p++ * 4
                dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
            }
        } else if (b1 === 0xFF) {
            if (i + 4 > srcLen) throw new Error('Truncated LLP3 RGBA pixel')
            r = src[i++]; g = src[i++]; b = src[i++]; a = src[i++]
            prev = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
            index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = prev
            if (dst32) { dst32[p++] = prev } else {
                const o = p++ * 4
                dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
            }
        } else {
            const tag = b1 & 0xC0
            if (tag === 0x00) {
                prev = index[b1]
                r = prev & 0xFF
                g = (prev >>> 8) & 0xFF
                b = (prev >>> 16) & 0xFF
                a = (prev >>> 24) & 0xFF
                if (dst32) { dst32[p++] = prev } else {
                    const o = p++ * 4
                    dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
                }
            } else if (tag === 0x40) {
                r = (r + ((b1 >>> 4) & 3) - 2) & 0xFF
                g = (g + ((b1 >>> 2) & 3) - 2) & 0xFF
                b = (b + (b1 & 3) - 2) & 0xFF
                prev = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
                index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = prev
                if (dst32) { dst32[p++] = prev } else {
                    const o = p++ * 4
                    dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
                }
            } else if (tag === 0x80) {
                if (i >= srcLen) throw new Error('Truncated LLP3 LUMA pixel')
                const b2 = src[i++]
                const vg = (b1 & 0x3F) - 32
                r = (r + vg + ((b2 >>> 4) & 0x0F) - 8) & 0xFF
                g = (g + vg) & 0xFF
                b = (b + vg + (b2 & 0x0F) - 8) & 0xFF
                prev = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
                index[(r * 3 + g * 5 + b * 7 + a * 11) & 63] = prev
                if (dst32) { dst32[p++] = prev } else {
                    const o = p++ * 4
                    dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
                }
            } else {
                const run = (b1 & 0x3F) + 1
                const end = Math.min(p + run, pixelCount)
                if (dst32) {
                    if (end - p >= 16) {
                        dst32.fill(prev, p, end)
                        p = end
                    } else {
                        while (p < end) dst32[p++] = prev
                    }
                } else {
                    while (p < end) {
                        const o = p++ * 4
                        dstBytes[o] = r; dstBytes[o + 1] = g; dstBytes[o + 2] = b; dstBytes[o + 3] = a
                    }
                }
            }
        }
    }
    if (p !== pixelCount || i !== srcLen) {
        throw new Error(`Invalid LLP3 payload length (${p}/${pixelCount} pixels, ${i}/${srcLen} bytes)`)
    }
    return dstBytes
}

const normalizeSource = async source => {
    let blob = source?.blob || source?.file || source
    if (blob?.materialize && !blob.isLazySnapshot) {
        blob = await blob.materialize()
    }
    if (blob instanceof Uint8Array) return blob
    if (blob instanceof ArrayBuffer) return new Uint8Array(blob)
    if (blob?.arrayBuffer) return new Uint8Array(await blob.arrayBuffer())
    throw new Error('Unsupported PDF source type')
}

export class PdfJsDriver {
    constructor() {
        this.kind = 'pdfjs'
        this.pdfDoc = null
        this.pdfjsLib = null
        this.numPages = 0
        this.loadingTask = null
        this._destroyed = false
    }

    async init() {
        if (this.pdfjsLib) return
        this.pdfjsLib = await import('../foliate-js-main/vendor/pdfjs/pdf.mjs')
        if (this.pdfjsLib.GlobalWorkerOptions && !this.pdfjsLib.GlobalWorkerOptions.workerSrc) {
            this.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../foliate-js-main/vendor/pdfjs/pdf.worker.mjs', import.meta.url).toString()
        }
    }

    async open(source) {
        if (this._destroyed) throw new Error('Driver is destroyed')
        await this.init()
        if (this._destroyed) throw new Error('Driver is destroyed')
        const data = await normalizeSource(source)
        if (this._destroyed) throw new Error('Driver is destroyed')
        const loadingTask = this.pdfjsLib.getDocument({
            data,
            password: (source?.password !== undefined && source?.password !== null) ? source.password : undefined,
            cMapUrl: new URL('../foliate-js-main/vendor/pdfjs/cmaps/', import.meta.url).toString(),
            cMapPacked: true,
            standardFontDataUrl: new URL('../foliate-js-main/vendor/pdfjs/standard_fonts/', import.meta.url).toString(),
            // PDF.js 5 uses external decoders for JPX/JBIG2 and color profiles.
            // Without this local bundle a JPEG 2000 scan may disappear while
            // the PDF's text continues to render, producing a false text-only page.
            wasmUrl: new URL('../foliate-js-main/vendor/pdfjs/wasm/', import.meta.url).toString(),
            // Let PDF.js use its own image/canvas heuristics, while the viewport
            // separately caps output backing pixels.
            canvasMaxAreaInBytes: 64 * 1024 * 1024,
        })
        this.loadingTask = loadingTask
        let doc = null
        try {
            doc = await loadingTask.promise
        } catch (err) {
            if (this._destroyed) {
                try { loadingTask.destroy?.() } catch {}
            }
            throw err
        }
        if (this._destroyed) {
            try { doc?.destroy?.() } catch {}
            try { loadingTask?.destroy?.() } catch {}
            this.pdfDoc = null
            this.loadingTask = null
            throw new Error('Driver was destroyed while opening document')
        }
        this.pdfDoc = doc
        this.numPages = this.pdfDoc.numPages

        // First page is enough to construct the initial virtual layout. Other
        // geometry is refined in background batches by PdfViewport.
        let first = null
        try {
            first = await this.pdfDoc.getPage(1)
        } catch (err) {
            if (this._destroyed) {
                try { doc?.destroy?.() } catch {}
                throw new Error('Driver was destroyed while opening document')
            }
            throw err
        }
        if (this._destroyed) {
            try { first?.cleanup?.() } catch {}
            try { doc?.destroy?.() } catch {}
            this.pdfDoc = null
            throw new Error('Driver was destroyed while opening document')
        }
        const firstVp = first.getViewport({ scale: 1 })
        const firstSize = { width: firstVp.width, height: firstVp.height }
        first.cleanup()
        const pageSizes = Array.from({ length: this.numPages }, () => ({ ...firstSize }))

        // The outline can contain thousands of destinations. It is loaded
        // after the first visible page instead of delaying its first paint.
        let meta = {}
        try {
            meta = this.pdfDoc ? await this.pdfDoc.getMetadata().catch(() => ({})) : {}
        } catch (err) {
            if (this._destroyed) {
                try { doc?.destroy?.() } catch {}
                throw new Error('Driver was destroyed while opening document')
            }
            throw err
        }
        if (this._destroyed) {
            try { doc?.destroy?.() } catch {}
            this.pdfDoc = null
            throw new Error('Driver was destroyed while opening document')
        }
        return {
            numPages: this.numPages,
            pageSizes,
            toc: [],
            title: meta?.info?.Title || t('book.pdfDocumentTitle'),
            author: meta?.info?.Author || t('book.unknownAuthor'),
        }
    }

    async _loadOutline() {
        if (!this.pdfDoc || this._destroyed) return []
        const outline = await this.pdfDoc.getOutline()
        if (!outline || this._destroyed) return []
        const format = async items => {
            const result = []
            for (const item of items) {
                let page = 0
                try {
                    const dest = typeof item.dest === 'string'
                        ? await this.pdfDoc.getDestination(item.dest)
                        : item.dest
                    if (dest?.[0]) page = await this.pdfDoc.getPageIndex(dest[0])
                } catch {}
                result.push({
                    label: item.title,
                    page,
                    href: `#page=${page + 1}`,
                    subitems: item.items?.length ? await format(item.items) : [],
                })
            }
            return result
        }
        return format(outline)
    }

    getOutline() { return this._loadOutline() }

    async getPageLabels() {
        if (!this.pdfDoc || this._destroyed || typeof this.pdfDoc.getPageLabels !== 'function') return null
        try {
            const labels = await this.pdfDoc.getPageLabels()
            return Array.isArray(labels) ? labels : null
        } catch {
            return null
        }
    }

    async getLinks(pageIndex) {
        if (!this.pdfDoc || this._destroyed) return []
        let page = null
        try {
            page = await this.pdfDoc.getPage(pageIndex + 1)
            const annotations = await page.getAnnotations()
            const links = []
            for (const annot of annotations || []) {
                if (annot.subtype !== 'Link') continue
                let targetPage = null
                if (annot.dest) {
                    try {
                        const dest = typeof annot.dest === 'string'
                            ? await this.pdfDoc.getDestination(annot.dest)
                            : annot.dest
                        if (dest?.[0]) targetPage = await this.pdfDoc.getPageIndex(dest[0])
                    } catch {}
                }
                links.push({
                    rect: annot.rect || null,
                    uri: annot.url || annot.unsafeUrl || null,
                    page: targetPage,
                })
            }
            return links
        } catch {
            return []
        } finally {
            try { page?.cleanup?.() } catch {}
        }
    }

    async getPageSizes(start, count, signal) {
        const out = []
        const end = Math.min(this.numPages, start + count)
        for (let i = start; i < end; i++) {
            if (signal?.aborted) throw abortError()
            const page = await this.pdfDoc.getPage(i + 1)
            const vp = page.getViewport({ scale: 1 })
            out.push({ width: vp.width, height: vp.height })
            page.cleanup()
            // Yield between pages so geometry work never monopolizes the UI.
            if ((i - start + 1) % 8 === 0) await new Promise(requestAnimationFrame)
        }
        return out
    }

    async renderPage(pageIndex, scale, signal) {
        if (!this.pdfDoc) throw new Error('Document not loaded')
        const t0_page = performance.now()
        const page = await this.pdfDoc.getPage(pageIndex + 1)
        const t1_page = performance.now()
        if (signal?.aborted) { page.cleanup(); throw abortError() }
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height))
        const ctx = canvas.getContext('2d', { alpha: false })
        const task = page.render({ canvasContext: ctx, viewport })
        const cancel = () => task.cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        const t0_render = performance.now()
        try {
            await task.promise
            const t1_render = performance.now()
            if (signal?.aborted) throw abortError()
            canvas._renderTimings = {
                getPageMs: Math.round((t1_page - t0_page) * 100) / 100,
                renderMs: Math.round((t1_render - t0_render) * 100) / 100,
                totalMs: Math.round((t1_render - t0_page) * 100) / 100,
            }
            return canvas
        } finally {
            signal?.removeEventListener('abort', cancel)
            page.cleanup()
        }
    }

    async renderTextLayer(pageIndex, container, scale, signal, { incremental = false } = {}) {
        if (!this.pdfDoc || !container || signal?.aborted) return
        const page = await this.pdfDoc.getPage(pageIndex + 1)
        let layer
        const cancel = () => layer?.cancel()
        try {
            if (signal?.aborted) throw abortError()
            // A dense page can spend hundreds of milliseconds creating and sizing
            // its text spans. Keep the PDF.js layout and yield between small batches.
            const stream = incremental && !this.pdfDoc.isPureXfa && typeof page.streamTextContent === 'function'
            const textContentSource = stream ? page.streamTextContent().pipeThrough(new TransformStream({
                async transform(chunk, output) {
                    const batchSize = 16
                    for (let offset = 0; offset < chunk.items.length || offset === 0; offset += batchSize) {
                        await new Promise(resolve => setTimeout(resolve, 0))
                        if (signal?.aborted) {
                            output.terminate()
                            return
                        }
                        output.enqueue({ ...chunk, items: chunk.items.slice(offset, offset + batchSize) })
                    }
                }
            })) : await page.getTextContent()
            if (signal?.aborted) throw abortError()
            const viewport = page.getViewport({ scale })
            // Keep PDF.js layout on a child so the page slot can crop and
            // position the outer layer together with the raster.
            const textLayer = document.createElement('div')
            textLayer.className = 'textLayer'
            textLayer.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
            container.replaceChildren(textLayer)
            layer = new this.pdfjsLib.TextLayer({ textContentSource, container: textLayer, viewport })
            signal?.addEventListener('abort', cancel, { once: true })
            await layer.render()
        } finally {
            signal?.removeEventListener('abort', cancel)
            page.cleanup()
        }
    }

    // Search compatibility: use PDF.js text items, but not this simplified
    // geometry for browser selection. Actual selection uses renderTextLayer().
    async getTextLayer(pageIndex) {
        if (!this.pdfDoc) return { spans: [] }
        const page = await this.pdfDoc.getPage(pageIndex + 1)
        try {
            const textContent = await page.getTextContent()
            const vp = page.getViewport({ scale: 1 })
            const spans = []
            for (const item of textContent.items) {
                if (!item.str || !item.transform) continue
                const [, , , sy, tx, ty] = item.transform
                const h = item.height || Math.abs(sy) || 12
                spans.push({
                    text: item.str,
                    x: tx,
                    y: vp.height - ty - Math.abs(sy),
                    w: item.width || 1,
                    h,
                    size: Math.abs(sy) || h,
                })
            }
            return { spans }
        } finally { page.cleanup() }
    }

    async getPagePlainText(pageIndex) {
        if (!this.pdfDoc) return ''
        if (this._plainTextCache?.has(pageIndex)) return this._plainTextCache.get(pageIndex)
        if (!this._plainTextCache) this._plainTextCache = new Map()
        const page = await this.pdfDoc.getPage(pageIndex + 1)
        try {
            const textContent = await page.getTextContent()
            const text = (textContent.items || []).map(i => i.str || '').join(' ')
            this._plainTextCache.set(pageIndex, text)
            if (this._plainTextCache.size > 200) {
                this._plainTextCache.delete(this._plainTextCache.keys().next().value)
            }
            return text
        } finally { page.cleanup() }
    }

    destroy() {
        this._destroyed = true
        if (this.loadingTask) {
            try { this.loadingTask.destroy?.() } catch {}
            this.loadingTask = null
        }
        if (this.pdfDoc) {
            try { this.pdfDoc.destroy?.() } catch {}
            this.pdfDoc = null
        }
        this.numPages = 0
    }
}

const normalizeBinaryResponse = async value => {
    if (value instanceof ArrayBuffer) return { buffer: value, byteOffset: 0, byteLength: value.byteLength }
    if (ArrayBuffer.isView(value)) return { buffer: value.buffer, byteOffset: value.byteOffset, byteLength: value.byteLength }
    if (value?.body instanceof ArrayBuffer) return { buffer: value.body, byteOffset: 0, byteLength: value.body.byteLength }
    if (ArrayBuffer.isView(value?.body)) return { buffer: value.body.buffer, byteOffset: value.body.byteOffset, byteLength: value.body.byteLength }
    if (value?.arrayBuffer) {
        const ab = await value.arrayBuffer()
        return { buffer: ab, byteOffset: 0, byteLength: ab.byteLength }
    }
    if (Array.isArray(value)) {
        const u8 = new Uint8Array(value)
        return { buffer: u8.buffer, byteOffset: 0, byteLength: u8.byteLength }
    }
    throw new Error('Unexpected native binary response')
}

export class MuPdfTauriDriver {
    constructor() {
        this.kind = 'mupdf'
        this.docId = null
        this.numPages = 0
        this._seq = 0
        this._destroyed = false
        this.geometryCache = new Map()
        this.geometryCacheLimit = 8
    }

    static async isAvailable() {
        return platformBridge.isNativePdfAvailable()
    }

    async open(source) {
        if (this._destroyed) throw new Error('Driver is destroyed')
        const nativePath = source?.nativePath || source?.path
        if (!nativePath) throw new Error('Native MuPDF requires a local file path')
        const savedStoreMb = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('linden_pdf_store_mb')) : null
        const maxStoreMb = platformBridge.isAndroid
            ? (globalThis.navigator?.deviceMemory > 4 ? 64 : 48)
            : ((savedStoreMb && savedStoreMb >= 32 && savedStoreMb <= 1024) ? savedStoreMb : (source?.maxStoreMb ?? null))
        const windowLabel = platformBridge.getCurrentWindowLabel ? platformBridge.getCurrentWindowLabel() : null
        const meta = await platformBridge._invokeTauri('mupdf_open_document', {
            filePath: nativePath,
            password: (source?.password !== undefined && source?.password !== null) ? source.password : null,
            expectedSize: source?.expectedSize ?? null,
            maxStoreMb,
            parallelRendering: platformBridge.getPdfParallelRendering(),
            windowLabel: windowLabel || null,
        })
        if (this._destroyed) {
            platformBridge._invokeTauri('mupdf_close_document', { docId: meta.docId }).catch(() => {})
            throw new Error('Driver was destroyed while opening document')
        }
        this.docId = meta.docId
        this.parallelRendering = meta.parallelRendering === true
        this.numPages = meta.numPages || 0
        const first = { width: meta.defaultWidth || 595, height: meta.defaultHeight || 842 }
        let pageSizes
        if (Array.isArray(meta.pageSizes) && meta.pageSizes.length >= this.numPages * 2) {
            pageSizes = Array.from({ length: this.numPages }, (_, i) => ({
                width: meta.pageSizes[i * 2] || first.width,
                height: meta.pageSizes[i * 2 + 1] || first.height,
            }))
            this.allPageSizesKnown = true
        } else {
            pageSizes = Array.from({ length: this.numPages }, () => ({ ...first }))
            this.allPageSizesKnown = false
        }

        return {
            numPages: this.numPages,
            pageSizes,
            allPageSizesKnown: this.allPageSizesKnown,
            toc: [],
            title: meta.title || t('book.pdfDocumentTitle'),
            author: meta.author || t('book.unknownAuthor'),
        }
    }

    async getOutline() {
        if (this._destroyed || !this.docId) return []
        let toc = []
        try {
            const flat = await platformBridge._invokeTauri('mupdf_get_outline_flat', { docId: this.docId })
            const root = [], stack = [{ level: -1, children: root }]
            for (const item of flat || []) {
                const page = Number.isInteger(item.page) && item.page >= 0 ? item.page : null
                const node = { label: item.title, page, href: page == null ? null : `#page=${page + 1}`, subitems: [] }
                while (stack.length > 1 && stack.at(-1).level >= item.level) stack.pop()
                stack.at(-1).children.push(node)
                stack.push({ level: item.level, children: node.subitems })
            }
            toc = root
        } catch {}
        return this._destroyed ? [] : toc
    }

    async getLinks(pageIndex) {
        if (this._destroyed || !this.docId) return []
        try {
            const rawLinks = await platformBridge._invokeTauri('mupdf_get_links', {
                docId: this.docId,
                pageIndex,
            })
            if (!Array.isArray(rawLinks)) return []
            return rawLinks.map(link => {
                let rect = null
                if (Array.isArray(link.rect)) {
                    rect = link.rect
                } else if (link.x != null || link.x0 != null) {
                    const x0 = link.x0 ?? link.x ?? 0
                    const y0 = link.y0 ?? link.y ?? 0
                    const x1 = link.x1 ?? (x0 + (link.w ?? link.width ?? 0))
                    const y1 = link.y1 ?? (y0 + (link.h ?? link.height ?? 0))
                    rect = [x0, y0, x1, y1]
                }
                return {
                    rect,
                    uri: link.uri || link.url || null,
                    page: Number.isInteger(link.page) ? link.page : (Number.isInteger(link.pageIndex) ? link.pageIndex : null),
                }
            })
        } catch {
            return []
        }
    }

    async getPageSizes(start, count, signal) {
        if (signal?.aborted) throw abortError()
        const raw = await platformBridge._invokeTauri('mupdf_get_page_bounds_range', {
            docId: this.docId, startPage: start, count,
        })
        if (signal?.aborted) throw abortError()
        const out = []
        for (let i = 0; i + 3 < raw.length; i += 4) {
            out.push({
                x0: raw[i], y0: raw[i + 1], x1: raw[i + 2], y1: raw[i + 3],
                width: Math.abs(raw[i + 2] - raw[i]),
                height: Math.abs(raw[i + 3] - raw[i + 1]),
            })
        }
        return out
    }

    async renderPage(pageIndex, scale, signal, clip = null, priority = 0, generation = 0) {
        if (!this.docId) throw new Error('Document not loaded')
        if (signal?.aborted) throw abortError()
        const docId = this.docId
        const requestId = `${docId}:${pageIndex}:${++this._seq}`
        const cancel = () => {
            platformBridge._invokeTauri('mupdf_cancel_render', { docId, requestId }).catch(() => {})
        }
        signal?.addEventListener('abort', cancel, { once: true })
        const t0_ipc = performance.now()
        try {
            const response = await platformBridge._invokeTauri('mupdf_render_page', {
                docId,
                pageIndex,
                scale,
                rotation: 0,
                clip,
                requestId,
                priority,
                generation,
            })
            const t1_ipc = performance.now()
            if (signal?.aborted) throw abortError()
            const t0_norm = performance.now()
            const buffer = await normalizeBinaryResponse(response)
            const t1_norm = performance.now()
            const t0_draw = performance.now()
            const canvas = this._packetToCanvas(buffer)
            const t1_draw = performance.now()
            canvas._renderTimings = {
                requestId,
                ipcMs: Math.round((t1_ipc - t0_ipc) * 100) / 100,
                normalizeMs: Math.round((t1_norm - t0_norm) * 100) / 100,
                canvasDrawMs: Math.round((t1_draw - t0_draw) * 100) / 100,
                totalJsMs: Math.round((t1_draw - t0_ipc) * 100) / 100,
            }
            return canvas
        } catch (err) {
            if (signal?.aborted || /render cancelled/i.test(String(err))) throw abortError()
            throw err
        } finally {
            signal?.removeEventListener('abort', cancel)
        }
    }

    _packetToCanvas(packet) {
        let buffer, byteOffset = 0, byteLength = 0
        if (packet instanceof ArrayBuffer) {
            buffer = packet
            byteOffset = 0
            byteLength = packet.byteLength
        } else if (ArrayBuffer.isView(packet)) {
            buffer = packet.buffer
            byteOffset = packet.byteOffset
            byteLength = packet.byteLength
        } else if (packet && packet.buffer instanceof ArrayBuffer) {
            buffer = packet.buffer
            byteOffset = packet.byteOffset || 0
            byteLength = packet.byteLength || buffer.byteLength
        } else {
            throw new Error('Unexpected packet buffer')
        }

        if (byteLength < 52) throw new Error('MuPDF render packet is truncated')
        const bytes = new Uint8Array(buffer, byteOffset, Math.min(byteLength, 4))
        const magic = String.fromCharCode(...bytes)
        if (magic !== 'LLP2' && magic !== 'LLP3') throw new Error('Unknown MuPDF render packet')
        const view = new DataView(buffer, byteOffset, byteLength)
        const width = view.getUint32(4, true)
        const height = view.getUint32(8, true)
        const stride = view.getUint32(12, true)
        const offsetX = view.getInt32(16, true)
        const offsetY = view.getInt32(20, true)
        const length = view.getUint32(48, true)
        const rawLength = width * height * 4
        if (!width || !height || stride !== width * 4 || 52 + length > byteLength) {
            throw new Error('Invalid MuPDF RGBA packet geometry')
        }
        if (magic === 'LLP2' && length !== rawLength) {
            throw new Error('Invalid MuPDF RGBA packet geometry')
        }
        if (magic === 'LLP3' && length === 0) {
            throw new Error('Invalid MuPDF LLP3 packet length')
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.dataset.offsetX = String(offsetX)
        canvas.dataset.offsetY = String(offsetY)
        canvas.offsetX = offsetX
        canvas.offsetY = offsetY
        const ctx = canvas.getContext('2d', { alpha: false })
        if (magic === 'LLP2') {
            const rgba = new Uint8ClampedArray(buffer, byteOffset + 52, length)
            ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
        } else {
            const imgData = new ImageData(width, height)
            decodeQoiRgbaPayload(new Uint8Array(buffer, byteOffset + 52, length), width * height, imgData.data)
            ctx.putImageData(imgData, 0, 0)
        }
        return canvas
    }

    async getTextGeometry(pageIndex) {
        if (this.geometryCache.has(pageIndex)) {
            const cached = this.geometryCache.get(pageIndex)
            this.geometryCache.delete(pageIndex)
            this.geometryCache.set(pageIndex, cached)
            return cached
        }
        const promise = platformBridge._invokeTauri('mupdf_get_text_layer', { docId: this.docId, pageIndex })
            .then(x => x?.chars || [])
            .catch(err => {
                if (this.geometryCache.get(pageIndex) === promise) this.geometryCache.delete(pageIndex)
                throw err
            })
        this.geometryCache.set(pageIndex, promise)
        while (this.geometryCache.size > this.geometryCacheLimit) {
            this.geometryCache.delete(this.geometryCache.keys().next().value)
        }
        return promise
    }

    async getPagePlainText(pageIndex) {
        if (this._plainTextCache?.has(pageIndex)) {
            return this._plainTextCache.get(pageIndex)
        }
        if (!this._plainTextCache) {
            this._plainTextCache = new Map()
        }
        if (this.geometryCache?.has(pageIndex)) {
            const chars = await this.geometryCache.get(pageIndex)
            const text = joinMuPdfGeometryChars(chars)
            this._plainTextCache.set(pageIndex, text)
            if (this._plainTextCache.size > 200) {
                this._plainTextCache.delete(this._plainTextCache.keys().next().value)
            }
            return text
        }
        let text = ''
        try {
            const raw = await platformBridge._invokeTauri('mupdf_get_plain_text', {
                docId: this.docId,
                pageIndex
            })
            if (typeof raw === 'string') {
                text = raw
            } else if (raw && typeof raw.text === 'string') {
                text = raw.text
            }
        } catch (_) {
            const chars = await this.getTextGeometry(pageIndex)
            text = joinMuPdfGeometryChars(chars)
        }
        this._plainTextCache.set(pageIndex, text)
        if (this._plainTextCache.size > 200) {
            this._plainTextCache.delete(this._plainTextCache.keys().next().value)
        }
        return text
    }

    async getTextLayer(pageIndex) {
        const chars = await this.getTextGeometry(pageIndex)
        if (!chars || !chars.length) return { spans: [], chars: [] }

        // Group consecutive characters on the same line into line-level spans so full-text search
        // (`span.text.toLowerCase().indexOf(query)` in `app.js`) matches multi-character words and phrases,
        // while preserving per-character `charOffsets` and `charBoxes` for exact substring highlight rectangles!
        const spans = []
        let current = null

        const flushLine = () => {
            if (!current) return
            const w = Math.max(0, current.maxX - current.minX)
            const h = Math.max(0, current.maxY - current.minY)
            spans.push({
                text: current.text,
                x: current.minX,
                y: current.minY,
                w,
                h,
                size: current.sizeSum / Math.max(1, current.count),
                line: current.line,
                quad: [
                    current.minX, current.minY,
                    current.maxX, current.minY,
                    current.minX, current.maxY,
                    current.maxX, current.maxY,
                ],
                charOffsets: current.charOffsets,
                charBoxes: current.charBoxes,
            })
            current = null
        }

        for (const ch of chars) {
            const q = ch.quad
            const xs = [q[0], q[2], q[4], q[6]]
            const ys = [q[1], q[3], q[5], q[7]]
            const x0 = Math.min(...xs), x1 = Math.max(...xs)
            const y0 = Math.min(...ys), y1 = Math.max(...ys)
            const chText = ch.text || ''

            if (!current || current.line !== ch.line) {
                flushLine()
                current = {
                    line: ch.line,
                    text: '',
                    minX: x0,
                    minY: y0,
                    maxX: x1,
                    maxY: y1,
                    sizeSum: 0,
                    count: 0,
                    charOffsets: [],
                    charBoxes: [],
                }
            } else {
                current.minX = Math.min(current.minX, x0)
                current.minY = Math.min(current.minY, y0)
                current.maxX = Math.max(current.maxX, x1)
                current.maxY = Math.max(current.maxY, y1)
            }

            const startOffset = current.text.length
            current.text += chText
            current.sizeSum += (ch.size || 12)
            current.count += 1
            current.charOffsets.push({ start: startOffset, end: current.text.length })
            current.charBoxes.push({ x0, y0, x1, y1, quad: q })
        }
        flushLine()

        return { spans, chars }
    }

    async select(pageIndex, a, b, mode = 'char') {
        return platformBridge._invokeTauri('mupdf_select', {
            docId: this.docId, pageIndex, a, b, mode,
        })
    }

    destroy() {
        this._destroyed = true
        if (this.docId) platformBridge._invokeTauri('mupdf_close_document', { docId: this.docId }).catch(() => {})
        this.docId = null
        this.geometryCache.clear()
    }
}

const savedPdfPreparations = new Map()

async function prepareSavedPdfNativeSnapshot(snapshot) {
    if (!snapshot?.bookId || !(snapshot.blob instanceof Blob) || snapshot.blob.isLazySnapshot || !snapshot.blob.size) return snapshot
    const key = JSON.stringify([snapshot.bookId, snapshot.revisionOrigin, snapshot.blobRevision])
    if (savedPdfPreparations.has(key)) return savedPdfPreparations.get(key)
    const task = (async () => {
        let staged = null, committed = false
        try {
            staged = await platformBridge.stageSavedPdfBlob(snapshot.blob)
            if (!staged) return snapshot
            const { bindSavedPdfNativeSnapshot } = await import('./db.js')
            committed = await bindSavedPdfNativeSnapshot(snapshot, staged)
            if (!committed) return snapshot
            return Object.freeze({ ...snapshot, nativeSnapshotPath: staged.path,
                nativeSnapshotRevision: snapshot.blobRevision, nativeSnapshotOrigin: snapshot.revisionOrigin,
                nativeSnapshotSize: staged.size,
                documentHashAliases: identityAliases(snapshot.documentHash, snapshot, staged) })
        } catch (error) {
            console.warn('[PDF] Saved PDF native cache unavailable; keeping saved Blob:', error)
            return snapshot
        } finally {
            if (staged?.path && !committed) await platformBridge.reclaimSnapshot?.(staged.path).catch(() => {})
        }
    })()
    savedPdfPreparations.set(key, task)
    try { return await task } finally { if (savedPdfPreparations.get(key) === task) savedPdfPreparations.delete(key) }
}

export class AdaptivePdfDriver {
    constructor({ nativePath = null, snapshot = null } = {}) {
        this.nativePath = nativePath
        this.snapshot = snapshot
        this.backend = null
        this.kind = 'adaptive'
    }

    async open(source) {
        if (this._destroyed) throw new Error('Driver is destroyed')
        const password = source?.password || null
        // A staged native file and the IndexedDB Blob must have been created
        // from the same immutable import snapshot and bound in one DB write.
        let snap = this.snapshot
        let nativeReady = Boolean(
            snap?.nativeSnapshotPath && (
                snap.nativeSnapshotOnly ||
                !snap.blob ||
                (snap.blob &&
                 snap.nativeSnapshotRevision === snap.blobRevision &&
                 snap.nativeSnapshotOrigin === snap.revisionOrigin &&
                 (snap.nativeSnapshotSize == null || snap.nativeSnapshotSize === 0 || snap.nativeSnapshotSize === snap.blob.size))
            )
        )
        const useNative = await MuPdfTauriDriver.isAvailable()
        if (useNative) {
            if (nativeReady && snap.blob instanceof Blob && !snap.blob.isLazySnapshot &&
                !await platformBridge.validatePdfSnapshot(snap.nativeSnapshotPath, snap.nativeSnapshotSize || snap.blob.size)) {
                nativeReady = false
                snap = { ...snap, nativeSnapshotPath: null }
            }
            if (!nativeReady) {
                snap = await prepareSavedPdfNativeSnapshot(snap)
                this.snapshot = snap
                nativeReady = Boolean(snap?.nativeSnapshotPath && snap.nativeSnapshotRevision === snap.blobRevision && snap.nativeSnapshotOrigin === snap.revisionOrigin)
            }
        }
        if (this._destroyed) throw abortError()
        if (nativeReady && useNative) {
            const native = new MuPdfTauriDriver()
            this.backend = native
            this.kind = native.kind
            try {
                const expectedSize = (snap.nativeSnapshotSize && snap.nativeSnapshotSize > 0)
                    ? snap.nativeSnapshotSize
                    : (snap.blob?.size && snap.blob.size > 0 ? snap.blob.size : null)
                return await native.open({ nativePath: snap.nativeSnapshotPath, expectedSize, password })
            } catch (err) {
                native.destroy()
                if (this._destroyed) throw err
                const msg = String(err?.message || err).toLowerCase()
                if (err?.name === 'PasswordException' || msg.includes('password') || msg.includes('needs_password')) {
                    throw err
                }
                console.warn('[PDF] Native snapshot open failed; using PDF.js:', err)
            }
        }
        let blobToOpen = this.snapshot?.blob || source?.blob || source?.file || source
        if ((!blobToOpen || blobToOpen.size === 0 ||
            (blobToOpen.nativeSnapshotOnly && !blobToOpen.isLazySnapshot && !blobToOpen.materialize)) &&
            snap?.nativeSnapshotPath) {
            try {
                const buf = await platformBridge.readFileBuffer(snap.nativeSnapshotPath)
                if (buf) blobToOpen = new Blob([buf], { type: 'application/pdf' })
            } catch (e) {
                console.warn('[PDF] Native fallback buffer read notice:', e)
            }
        }
        const fallback = new PdfJsDriver()
        this.backend = fallback
        this.kind = fallback.kind
        return fallback.open({ blob: blobToOpen, password })
    }

    get docId() { return this.backend?.docId || this._docId || null }
    get numPages() { return this.backend?.numPages || 0 }
    get allPageSizesKnown() { return Boolean(this.backend?.allPageSizesKnown) }
    get parallelRendering() { return this.backend?.parallelRendering === true }
    getPageSizes(...args) { return this.backend?.getPageSizes?.(...args) }
    renderPage(...args) { return this.backend?.renderPage?.(...args) }
    async renderPageBitmap(pageIndex, scale = 1.0, signal = null) {
        if (!this.backend) return null
        if (typeof this.backend.renderPageBitmap === 'function') {
            return this.backend.renderPageBitmap(pageIndex, scale, signal)
        }
        if (typeof this.backend.renderPage === 'function') {
            const result = await this.backend.renderPage(pageIndex, scale, signal)
            const canvas = (result && result.tagName === 'CANVAS') ? result : (result?.canvas || result)
            return { canvas, width: canvas?.width || 0, height: canvas?.height || 0 }
        }
        return null
    }
    renderTextLayer(...args) { return this.backend.renderTextLayer?.(...args) }
    getTextLayer(...args) { return this.backend.getTextLayer(...args) }
    getPagePlainText(...args) { return this.backend?.getPagePlainText?.(...args) || Promise.resolve('') }
    getTextGeometry(...args) { return this.backend.getTextGeometry?.(...args) }
    select(...args) { return this.backend.select?.(...args) }
    getOutline(...args) { return this.backend.getOutline?.(...args) }
    getPageLabels(...args) { return this.backend?.getPageLabels?.(...args) || Promise.resolve(null) }
    getLinks(...args) { return this.backend?.getLinks?.(...args) || Promise.resolve([]) }
    destroy() {
        this._destroyed = true
        this.backend?.destroy?.()
        this.backend = null
    }
}

export class AdaptivePdfDriverLease {
    constructor(realDriver, viewId = 'primary') {
        this.realDriver = realDriver;
        this.viewId = viewId;
        this._destroyed = false;
    }

    get kind() { return this.realDriver?.kind || 'lease' }
    get parallelRendering() { return this.realDriver?.parallelRendering === true }
    get docId() { return this.realDriver?.docId || null }
    get numPages() { return this.realDriver?.numPages || 0 }
    get pageSize() { return this.realDriver?.pageSize }
    getPageSize(...args) { return this.realDriver?.getPageSize?.(...args) }
    getPageSizes(...args) { return this.realDriver?.getPageSizes?.(...args) }
    async open(source) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        if (this.realDriver?.open && (!this.realDriver.numPages || this.realDriver.numPages === 0)) {
            return await this.realDriver.open(source)
        }
        return {
            numPages: this.numPages,
            pageSizes: this.getPageSizes?.() || [],
            allPageSizesKnown: true,
            docId: this.docId
        }
    }
    renderPage(...args) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        return this.realDriver?.renderPage?.(...args)
    }
    renderPageBitmap(...args) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        return this.realDriver?.renderPageBitmap?.(...args)
    }
    renderTextLayer(...args) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        return this.realDriver?.renderTextLayer?.(...args)
    }
    getTextLayer(...args) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        return this.realDriver?.getTextLayer?.(...args)
    }
    getPagePlainText(...args) {
        if (this._destroyed) return Promise.resolve('')
        return this.realDriver?.getPagePlainText?.(...args) || Promise.resolve('')
    }
    getTextGeometry(...args) {
        if (this._destroyed) throw new Error('Driver lease is destroyed')
        return this.realDriver?.getTextGeometry?.(...args)
    }
    select(...args) {
        if (this._destroyed) return null
        return this.realDriver?.select?.(...args)
    }
    getOutline(...args) {
        if (this._destroyed) return Promise.resolve([])
        return this.realDriver?.getOutline?.(...args) || Promise.resolve([])
    }
    getPageLabels(...args) {
        if (this._destroyed) return Promise.resolve(null)
        return this.realDriver?.getPageLabels?.(...args) || Promise.resolve(null)
    }
    getLinks(...args) {
        if (this._destroyed) return Promise.resolve([])
        return this.realDriver?.getLinks?.(...args) || Promise.resolve([])
    }
    destroy() {
        this._destroyed = true;
        // Do NOT destroy realDriver; only release this lease
    }
}

export function setMuPdfStoreLimit(maxMb) {
    const val = Math.max(32, Math.min(1024, Number(maxMb) || 256))
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('linden_pdf_store_mb', String(val))
    }
    platformBridge?._invokeTauri?.('mupdf_set_store_limit', { maxMb: val }).catch(() => {})
    return val
}

export function getMuPdfStoreLimit() {
    if (typeof localStorage !== 'undefined') {
        const v = Number(localStorage.getItem('linden_pdf_store_mb'))
        if (v && v >= 32 && v <= 1024) return v
    }
    return 256
}
