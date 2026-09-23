// PDF backend abstraction.
// PDF.js is always available; native MuPDF is an optional Tauri acceleration
// path for local files. Both expose the same viewport-facing surface.

import { platformBridge } from './platformBridge.js'

const abortError = () => new DOMException('Render cancelled', 'AbortError')

const normalizeSource = async source => {
    const blob = source?.blob || source?.file || source
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
            cMapUrl: new URL('../foliate-js-main/vendor/pdfjs/cmaps/', import.meta.url).toString(),
            cMapPacked: true,
            standardFontDataUrl: new URL('../foliate-js-main/vendor/pdfjs/standard_fonts/', import.meta.url).toString(),
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
            title: meta?.info?.Title || 'PDF 文档',
            author: meta?.info?.Author || '未知作者',
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

    async renderTextLayer(pageIndex, container, scale, signal) {
        if (!this.pdfDoc || !container) return
        const page = await this.pdfDoc.getPage(pageIndex + 1)
        const viewport = page.getViewport({ scale })
        const textContent = await page.getTextContent()
        if (signal?.aborted) { page.cleanup(); throw abortError() }
        container.replaceChildren()
        container.classList.add('textLayer')
        const layer = new this.pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport })
        const cancel = () => layer.cancel()
        signal?.addEventListener('abort', cancel, { once: true })
        try {
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
        if (!platformBridge.isTauri) return false
        try { return Boolean(await platformBridge._invokeTauri('mupdf_is_available')) }
        catch { return false }
    }

    async open(source) {
        if (this._destroyed) throw new Error('Driver is destroyed')
        const nativePath = source?.nativePath || source?.path
        if (!nativePath) throw new Error('Native MuPDF requires a local file path')
        const meta = await platformBridge._invokeTauri('mupdf_open_document', {
            filePath: nativePath,
            password: null,
            expectedSize: source?.expectedSize ?? null,
        })
        if (this._destroyed) {
            platformBridge._invokeTauri('mupdf_close_document', { docId: meta.docId }).catch(() => {})
            throw new Error('Driver was destroyed while opening document')
        }
        this.docId = meta.docId
        this.numPages = meta.numPages || 0
        const first = { width: meta.defaultWidth || 595, height: meta.defaultHeight || 842 }
        const pageSizes = Array.from({ length: this.numPages }, () => ({ ...first }))

        return { numPages: this.numPages, pageSizes, toc: [], title: meta.title || 'PDF 文档', author: meta.author || '未知作者' }
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
        if (String.fromCharCode(...bytes) !== 'LLP2') throw new Error('Unknown MuPDF render packet')
        const view = new DataView(buffer, byteOffset, byteLength)
        const width = view.getUint32(4, true)
        const height = view.getUint32(8, true)
        const stride = view.getUint32(12, true)
        const offsetX = view.getInt32(16, true)
        const offsetY = view.getInt32(20, true)
        const length = view.getUint32(48, true)
        if (!width || !height || stride !== width * 4 || length !== width * height * 4 || 52 + length > byteLength) {
            throw new Error('Invalid MuPDF RGBA packet geometry')
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.dataset.offsetX = String(offsetX)
        canvas.dataset.offsetY = String(offsetY)
        canvas.offsetX = offsetX
        canvas.offsetY = offsetY
        const rgba = new Uint8ClampedArray(buffer, byteOffset + 52, length)
        canvas.getContext('2d', { alpha: false }).putImageData(new ImageData(rgba, width, height), 0, 0)
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

    async getTextLayer(pageIndex) {
        const chars = await this.getTextGeometry(pageIndex)
        return { spans: chars.map(ch => {
            const q = ch.quad
            const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
            const x = Math.min(...xs), y = Math.min(...ys)
            return { text: ch.text, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, size: ch.size, line: ch.line, quad: q }
        }) }
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

export class AdaptivePdfDriver {
    constructor({ nativePath = null, snapshot = null } = {}) {
        this.nativePath = nativePath
        this.snapshot = snapshot
        this.backend = null
        this.kind = 'adaptive'
    }

    async open(source) {
        if (this._destroyed) throw new Error('Driver is destroyed')
        // A staged native file and the IndexedDB Blob must have been created
        // from the same immutable import snapshot and bound in one DB write.
        const snap = this.snapshot
        const nativeReady = snap?.nativeSnapshotPath && snap.blob &&
            snap.nativeSnapshotRevision === snap.blobRevision &&
            snap.nativeSnapshotOrigin === snap.revisionOrigin &&
            snap.nativeSnapshotSize === snap.blob.size
        if (nativeReady && await MuPdfTauriDriver.isAvailable()) {
            if (this._destroyed) throw new Error('Driver is destroyed')
            const native = new MuPdfTauriDriver()
            this.backend = native
            this.kind = native.kind
            try {
                return await native.open({ nativePath: snap.nativeSnapshotPath, expectedSize: snap.blob.size })
            } catch (err) {
                native.destroy()
                if (this._destroyed) throw err
                console.warn('[PDF] Native snapshot open failed; using PDF.js:', err)
            }
        }
        const blobToOpen = this.snapshot?.blob || source?.blob || source?.file || source
        const fallback = new PdfJsDriver()
        this.backend = fallback
        this.kind = fallback.kind
        return fallback.open(blobToOpen)
    }

    getPageSizes(...args) { return this.backend.getPageSizes(...args) }
    renderPage(...args) { return this.backend.renderPage(...args) }
    renderTextLayer(...args) { return this.backend.renderTextLayer?.(...args) }
    getTextLayer(...args) { return this.backend.getTextLayer(...args) }
    getTextGeometry(...args) { return this.backend.getTextGeometry?.(...args) }
    select(...args) { return this.backend.select?.(...args) }
    getOutline(...args) { return this.backend.getOutline?.(...args) }
    destroy() {
        this._destroyed = true
        this.backend?.destroy?.()
        this.backend = null
    }
}
