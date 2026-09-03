// Polyfill Response.bytes, Uint8Array toHex/toBase64, Promise.try, Promise.withResolvers and Object.groupBy for PDF.js v5 compatibility
if (typeof Response !== 'undefined' && typeof Response.prototype.bytes !== 'function') {
    Response.prototype.bytes = async function () {
        const buffer = await this.arrayBuffer()
        return new Uint8Array(buffer)
    }
}
if (typeof Uint8Array.prototype.toHex !== 'function') {
    Uint8Array.prototype.toHex = function () {
        let hex = ''
        for (let i = 0; i < this.length; i++) {
            hex += this[i].toString(16).padStart(2, '0')
        }
        return hex
    }
}
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
    Uint8Array.prototype.toBase64 = function () {
        let binary = ''
        const len = this.byteLength
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(this[i])
        }
        return btoa(binary)
    }
}
if (typeof Uint8Array.fromBase64 !== 'function') {
    Uint8Array.fromBase64 = function (base64) {
        const binary = atob(base64)
        const len = binary.length
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i)
        }
        return bytes
    }
}
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
    Map.prototype.getOrInsertComputed = function (key, callbackFunction) {
        if (this.has(key)) return this.get(key)
        const value = callbackFunction(key)
        this.set(key, value)
        return value
    }
}
if (typeof Map.prototype.getOrInsert !== 'function') {
    Map.prototype.getOrInsert = function (key, defaultValue) {
        if (this.has(key)) return this.get(key)
        this.set(key, defaultValue)
        return defaultValue
    }
}
if (typeof Set.prototype.intersection !== 'function') {
    Set.prototype.intersection = function (other) {
        const result = new Set()
        for (const elem of this) {
            if (other && typeof other.has === 'function' ? other.has(elem) : false) {
                result.add(elem)
            }
        }
        return result
    }
}
if (typeof Set.prototype.union !== 'function') {
    Set.prototype.union = function (other) {
        const result = new Set(this)
        if (other && typeof other[Symbol.iterator] === 'function') {
            for (const elem of other) {
                result.add(elem)
            }
        }
        return result
    }
}
if (typeof Set.prototype.difference !== 'function') {
    Set.prototype.difference = function (other) {
        const result = new Set(this)
        if (other && typeof other.has === 'function') {
            for (const elem of this) {
                if (other.has(elem)) result.delete(elem)
            }
        }
        return result
    }
}
if (typeof Promise.try !== 'function') {
    Promise.try = function (fn, ...args) {
        return new Promise(resolve => resolve(fn(...args)))
    }
}
if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
        let resolve, reject
        const promise = new Promise((res, rej) => {
            resolve = res
            reject = rej
        })
        return { promise, resolve, reject }
    }
}
if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function (items, callback) {
        const result = Object.create(null)
        let i = 0
        for (const item of items) {
            const key = callback(item, i++)
            if (key in result) result[key].push(item)
            else result[key] = [item]
        }
        return result
    }
}

const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import * as pdfjsLib from './vendor/pdfjs/pdf.js'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.js')

let cachedTextLayerCSS = ''
let cachedAnnotationLayerCSS = ''

const getStyles = async () => {
    if (!cachedTextLayerCSS) {
        try {
            cachedTextLayerCSS = await (await fetch(pdfjsPath('text_layer_builder.css'))).text()
        } catch (e) {
            cachedTextLayerCSS = ''
        }
    }
    if (!cachedAnnotationLayerCSS) {
        try {
            cachedAnnotationLayerCSS = await (await fetch(pdfjsPath('annotation_layer_builder.css'))).text()
        } catch (e) {
            cachedAnnotationLayerCSS = ''
        }
    }
    return { textLayerCSS: cachedTextLayerCSS, annotationLayerCSS: cachedAnnotationLayerCSS }
}

const renderPage = async (page, getImageBlob) => {
    // Dynamic DPR: 1.25x ~ 2.0x for crisp text without 10-Megapixel RAM blowup
    const baseDpr = globalThis.devicePixelRatio || 1
    const dpr = getImageBlob ? Math.min(1.5, Math.max(1.0, baseDpr)) : Math.min(2.0, Math.max(1.25, baseDpr))
    const viewport = page.getViewport({ scale: dpr })
    const baseViewport = page.getViewport({ scale: 1 })
    const cssWidth = Math.round(baseViewport.width)
    const cssHeight = Math.round(baseViewport.height)

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const canvasContext = canvas.getContext('2d')
    canvasContext.imageSmoothingEnabled = true
    canvasContext.imageSmoothingQuality = 'high'
    canvasContext.fillStyle = '#ffffff'
    canvasContext.fillRect(0, 0, viewport.width, viewport.height)
    
    try {
        await page.render({ canvasContext, viewport }).promise
    } catch (err) {
        console.warn('PDF renderPage error:', err)
    }

    // Fast image encoding (WebP has hardware acceleration and is 10x faster than single-thread PNG deflate)
    const encodeBlob = async () => {
        return new Promise(resolve => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob)
                else canvas.toBlob(resolve, 'image/jpeg', 0.92)
            }, 'image/webp', 0.92)
        })
    }

    if (getImageBlob) {
        return encodeBlob()
    }

    const imgBlob = await encodeBlob()
    const imgUrl = URL.createObjectURL(imgBlob)

    // Pre-render standard textLayer at 1.0 unscaled coordinates
    const textLayerDiv = document.createElement('div')
    textLayerDiv.className = 'textLayer'
    try {
        const textLayer = new pdfjsLib.TextLayer({
            textContentSource: await page.streamTextContent(),
            container: textLayerDiv,
            viewport: baseViewport,
        })
        await textLayer.render()
    } catch (err) {
        console.warn('PDF textLayer render error:', err)
    }
    const textLayerHTML = textLayerDiv.innerHTML

    const { textLayerCSS, annotationLayerCSS } = await getStyles()
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=${cssWidth}, height=${cssHeight}">
        <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
            margin: 0;
            padding: 0;
            width: ${cssWidth}px;
            height: ${cssHeight}px;
            overflow: hidden;
            background: transparent;
        }
        #page-container {
            position: relative;
            width: ${cssWidth}px;
            height: ${cssHeight}px;
            margin: 0;
            overflow: hidden;
            background: #ffffff;
            box-shadow: 0 4px 18px rgba(0,0,0,0.12);
            border-radius: 2px;
        }
        #page-img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: fill;
            image-rendering: high-quality;
            pointer-events: none;
            user-select: none;
        }
        .textLayer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            opacity: 1;
            line-height: 1.0;
            user-select: text;
            -webkit-user-select: text;
        }
        .textLayer span, .textLayer br {
            color: transparent !important;
            position: absolute;
            white-space: pre;
            cursor: text;
            transform-origin: 0% 0%;
        }
        .textLayer ::selection,
        .textLayer *::selection,
        ::selection {
            background: rgba(37, 99, 235, 0.28) !important;
            color: transparent !important;
        }
        .annotationLayer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        :root {
          --user-unit: 1;
          --total-scale-factor: 1;
          --scale-round-x: 1px;
          --scale-round-y: 1px;
          --scale-factor: 1;
        }
        ${textLayerCSS}
        ${annotationLayerCSS}
        </style>
        </head>
        <body>
        <div id="page-container">
            <img id="page-img" src="${imgUrl}" alt="Page" />
            <div class="textLayer">${textLayerHTML}</div>
            <div class="annotationLayer"></div>
        </div>
        </body>
        </html>
    `], { type: 'text/html' }))

    let currentImgUrl = imgUrl
    let currentScale = dpr
    let zoomTimer = null
    let zoomInFlight = false

    const onZoom = (newScale, doc) => {
        if (!doc || typeof newScale !== 'number' || isNaN(newScale) || newScale <= 0) return
        const targetDpr = Math.min(4.0, Math.max(1.0, (globalThis.devicePixelRatio || 1) * newScale))
        if (Math.abs(targetDpr - currentScale) < 0.25) return // avoid unnecessary re-render for minor changes

        if (zoomTimer) clearTimeout(zoomTimer)
        zoomTimer = setTimeout(async () => {
            if (zoomInFlight) return
            zoomInFlight = true
            try {
                const vp = page.getViewport({ scale: targetDpr })
                const cvs = document.createElement('canvas')
                cvs.width = vp.width
                cvs.height = vp.height
                const ctx = cvs.getContext('2d')
                ctx.imageSmoothingEnabled = true
                ctx.imageSmoothingQuality = 'high'
                ctx.fillStyle = '#ffffff'
                ctx.fillRect(0, 0, vp.width, vp.height)
                await page.render({ canvasContext: ctx, viewport: vp }).promise
                
                const blob = await new Promise(res => {
                    cvs.toBlob(b => {
                        if (b) res(b)
                        else cvs.toBlob(res, 'image/jpeg', 0.92)
                    }, 'image/webp', 0.92)
                })
                
                if (blob && doc) {
                    const oldUrl = currentImgUrl
                    const newUrl = URL.createObjectURL(blob)
                    currentImgUrl = newUrl
                    currentScale = targetDpr
                    const imgEl = doc.getElementById('page-img')
                    if (imgEl) {
                        imgEl.src = newUrl
                    }
                    if (oldUrl && oldUrl !== imgUrl) {
                        try { URL.revokeObjectURL(oldUrl) } catch (e) {}
                    }
                }
            } catch (err) {
                console.warn('onZoom re-render failed:', err)
            } finally {
                zoomInFlight = false
            }
        }, 120)
    }

    return { src, imgUrl, getCurrentImgUrl: () => currentImgUrl, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items?.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const data = new Uint8Array(await file.arrayBuffer())
    const pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: pdfjsPath('cmaps/'),
        cMapPacked: true,
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    let defaultViewport = { width: 800, height: 1100 }
    try {
        const firstPage = await pdf.getPage(1)
        const p1vp = firstPage.getViewport({ scale: 1 })
        defaultViewport = { width: Math.round(p1vp.width), height: Math.round(p1vp.height) }
    } catch (e) {
        console.warn('PDF getPage 1 viewport fallback:', e)
    }

    const book = { rendition: { layout: 'pre-paginated', spread: 'none', viewport: defaultViewport } }

    const { metadata, info } = (await pdf.getMetadata().catch(() => ({}))) ?? {}
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title ?? (file.name ? file.name.replace(/\.pdf$/i, '') : 'PDF 文档'),
        author: metadata?.get('dc:creator') ?? info?.Author ?? '未知作者',
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language') ?? 'zh',
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    try {
        const outline = await pdf.getOutline()
        book.toc = outline?.map(makeTOCItem) || []
    } catch (e) {
        book.toc = []
    }

    // High-performance LRU Cache for PDF Pages (capacity 24) with Active Viewport Lock
    const MAX_PAGE_CACHE = 24
    const MAX_DOC_CACHE = 30
    const pageCache = new Map() // index -> { src, imgUrl, getCurrentImgUrl, onZoom, timestamp }
    const inFlightRequests = new Map() // index -> Promise
    const docCache = new Map()
    let activePageIndex = 0

    const revokePageUrls = (item) => {
        if (!item) return
        try {
            if (item.src) URL.revokeObjectURL(item.src)
            if (item.imgUrl) URL.revokeObjectURL(item.imgUrl)
            if (typeof item.getCurrentImgUrl === 'function') {
                const cur = item.getCurrentImgUrl()
                if (cur && cur !== item.imgUrl && cur !== item.src) {
                    URL.revokeObjectURL(cur)
                }
            }
        } catch (e) {}
    }

    const evictOldestIfNeeded = (excludeIndex = -1) => {
        if (pageCache.size <= MAX_PAGE_CACHE) return
        // Active Viewport Lock: Never evict pages within [activePageIndex - 2, activePageIndex + 2]
        const lockedMin = Math.max(0, activePageIndex - 2)
        const lockedMax = activePageIndex + 2

        let oldestIndex = -1
        let oldestTime = Infinity
        for (const [idx, item] of pageCache.entries()) {
            if (idx === excludeIndex) continue
            if (idx >= lockedMin && idx <= lockedMax) continue // Protected from eviction
            if (item.timestamp < oldestTime) {
                oldestTime = item.timestamp
                oldestIndex = idx
            }
        }
        if (oldestIndex === -1) {
            for (const [idx, item] of pageCache.entries()) {
                if (idx === excludeIndex || idx === activePageIndex) continue
                if (item.timestamp < oldestTime) {
                    oldestTime = item.timestamp
                    oldestIndex = idx
                }
            }
        }
        if (oldestIndex !== -1) {
            const item = pageCache.get(oldestIndex)
            pageCache.delete(oldestIndex)
            // Graceful delayed revocation: allow 20 seconds for pending browser paints
            setTimeout(() => revokePageUrls(item), 20000)
        }
    }

    const evictDocCacheIfNeeded = () => {
        if (docCache.size > MAX_DOC_CACHE) {
            const oldestDocKey = docCache.keys().next().value
            if (oldestDocKey !== undefined) {
                docCache.delete(oldestDocKey)
            }
        }
    }

    const loadPage = async (i) => {
        activePageIndex = i
        const existing = pageCache.get(i)
        if (existing) {
            existing.timestamp = Date.now()
            return existing
        }
        if (inFlightRequests.has(i)) {
            return inFlightRequests.get(i)
        }

        const promise = (async () => {
            try {
                const page = await pdf.getPage(i + 1)
                const res = await renderPage(page)
                const cacheItem = { src: res.src, imgUrl: res.imgUrl, onZoom: res.onZoom, timestamp: Date.now() }
                pageCache.set(i, cacheItem)
                evictOldestIfNeeded(i)
                return cacheItem
            } finally {
                inFlightRequests.delete(i)
            }
        })()

        inFlightRequests.set(i, promise)
        return promise
    }

    // Predictive pre-rendering in background
    const schedulePreRender = (currentIndex) => {
        activePageIndex = currentIndex
        const prefetchIndices = [currentIndex + 1, currentIndex + 2, currentIndex - 1].filter(
            idx => idx >= 0 && idx < pdf.numPages
        )
        // Fire in next tick to avoid competing with current page display
        setTimeout(() => {
            for (const idx of prefetchIndices) {
                if (!pageCache.has(idx) && !inFlightRequests.has(idx)) {
                    loadPage(idx).catch(() => {})
                }
            }
        }, 30)
    }

    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const result = await loadPage(i)
            // Trigger pre-rendering of adjacent pages immediately
            schedulePreRender(i)
            return { src: result.src, onZoom: result.onZoom }
        },
        createDocument: async () => {
            const cached = docCache.get(i)
            if (cached) return cached
            const page = await pdf.getPage(i + 1)
            const baseViewport = page.getViewport({ scale: 1 })
            const textLayerDiv = document.createElement('div')
            textLayerDiv.className = 'textLayer'
            try {
                const textLayer = new pdfjsLib.TextLayer({
                    textContentSource: await page.streamTextContent(),
                    container: textLayerDiv,
                    viewport: baseViewport,
                })
                await textLayer.render()
            } catch (err) {
                console.warn('PDF createDocument textLayer error:', err)
            }
            const parser = new DOMParser()
            const doc = parser.parseFromString(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="page-container"><img id="page-img" alt="Page" /><div class="textLayer">${textLayerDiv.innerHTML}</div><div class="annotationLayer"></div></div></body></html>`, 'text/html')
            docCache.set(i, doc)
            evictDocCacheIfNeeded()
            return doc
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        try {
            const parsed = JSON.parse(href)
            const dest = typeof parsed === 'string'
                ? await pdf.getDestination(parsed) : parsed
            const index = await pdf.getPageIndex(dest[0])
            return { index }
        } catch (e) {
            return { index: 0 }
        }
    }
    book.splitTOCHref = async href => {
        try {
            const parsed = JSON.parse(href)
            const dest = typeof parsed === 'string'
                ? await pdf.getDestination(parsed) : parsed
            const index = await pdf.getPageIndex(dest[0])
            return [index, null]
        } catch (e) {
            return [0, null]
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => {
        try {
            const p1 = await pdf.getPage(1)
            const blob1 = await renderPage(p1, true)
            // If page 1 is small (< 15KB for WebP, typically a blank white lining paper/flyleaf),
            // and PDF has multiple pages, check page 2 for the true graphical book cover
            if (pdf.numPages > 1 && blob1 && blob1.size < 15000) {
                try {
                    const p2 = await pdf.getPage(2)
                    const blob2 = await renderPage(p2, true)
                    if (blob2 && blob2.size > blob1.size) return blob2
                } catch (err2) {
                    console.warn('PDF getCover page 2 fallback error:', err2)
                }
            }
            return blob1
        } catch (e) {
            console.warn('PDF getCover error:', e)
            return null
        }
    }
    book.destroy = () => {
        try {
            for (const item of pageCache.values()) {
                revokePageUrls(item)
            }
            pageCache.clear()
            inFlightRequests.clear()
            docCache.clear()
        } catch (e) {}
        try {
            pdf.destroy()
        } catch (e) {}
    }
    return book
}
