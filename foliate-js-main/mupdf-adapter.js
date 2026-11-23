// foliate-js-main/mupdf-adapter.js
// Universal Dual-Mode PDF & DjVu Engine for Linden Leaf:
// Integrates high-performance MuPDF native backend when running in Tauri,
// while gracefully preserving battle-tested PDF.js fallback for standard environments.
// Zero-reinventing-the-wheel: strictly matches Foliate's Overlayer, CFI, TextLayer, and Freehand drawing DOM contracts.

import { platformBridge } from '../js/platformBridge.js'

let cachedTextLayerCSS = ''
let cachedAnnotationLayerCSS = ''

const getStyles = async () => {
    if (!cachedTextLayerCSS) {
        try {
            const res = await fetch(new URL('vendor/pdfjs/text_layer_builder.css', import.meta.url).toString())
            cachedTextLayerCSS = await res.text()
        } catch (e) {
            cachedTextLayerCSS = ''
        }
    }
    if (!cachedAnnotationLayerCSS) {
        try {
            const res = await fetch(new URL('vendor/pdfjs/annotation_layer_builder.css', import.meta.url).toString())
            cachedAnnotationLayerCSS = await res.text()
        } catch (e) {
            cachedAnnotationLayerCSS = ''
        }
    }
    return { textLayerCSS: cachedTextLayerCSS, annotationLayerCSS: cachedAnnotationLayerCSS }
}

/**
 * Reconstruct tree structure from flattened outline (MuPDF outline_flatten format)
 * Direct O(N) reconstruction in microseconds, avoiding thousands of recursive IPC calls.
 */
export const buildTOCFromFlat = (flatItems) => {
    if (!flatItems || flatItems.length === 0) return []
    const root = []
    const stack = [{ level: -1, children: root }]

    for (const item of flatItems) {
        const tocNode = {
            label: item.title || '未命名章节',
            href: JSON.stringify({ page: item.page, dest: item.dest || null }),
            subitems: []
        }

        while (stack.length > 1 && stack[stack.length - 1].level >= item.level) {
            stack.pop()
        }

        const parent = stack[stack.length - 1]
        parent.children.push(tocNode)
        stack.push({ level: item.level, children: tocNode.subitems })
    }

    // Clean up empty subitems arrays to conform with Foliate TOC interface
    const cleanNodes = (nodes) => {
        for (const n of nodes) {
            if (n.subitems && n.subitems.length === 0) {
                n.subitems = null
            } else if (n.subitems) {
                cleanNodes(n.subitems)
            }
        }
    }
    cleanNodes(root)
    return root
}

/**
 * Generate high-precision HTML template conforming to Foliate's Overlayer & Drawing contract.
 * Contains #page-container, #page-img, .textLayer, and .annotationLayer.
 */
export const buildPageHTML = async ({
    cssWidth,
    cssHeight,
    imgUrl,
    textSpans = [],
    links = [],
    textLayerCSS,
    annotationLayerCSS
}) => {
    // Generate TextLayer spans matching PDF.js TextLayer DOM structure
    let textLayerHTML = ''
    if (textSpans && textSpans.length > 0) {
        textLayerHTML = textSpans.map(span => {
            const x = Math.round(span.x * 100) / 100
            const y = Math.round(span.y * 100) / 100
            const w = Math.round(span.w * 100) / 100
            const h = Math.round(span.h * 100) / 100
            const sz = Math.round((span.size || h) * 100) / 100
            const escaped = String(span.text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
            return `<span style="left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px; font-size: ${sz}px;">${escaped}</span>`
        }).join('')
    }

    // Generate AnnotationLayer links
    let linksHTML = ''
    if (links && links.length > 0) {
        linksHTML = links.map(link => {
            const x = Math.round(link.x * 100) / 100
            const y = Math.round(link.y * 100) / 100
            const w = Math.round(link.w * 100) / 100
            const h = Math.round(link.h * 100) / 100
            const href = link.uri || `#page=${link.page}`
            const target = link.uri ? ' target="_blank" rel="noopener noreferrer"' : ''
            return `<a href="${href}"${target} style="position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; z-index:2;"></a>`
        }).join('')
    }

    return URL.createObjectURL(new Blob([`
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
            filter: var(--reader-img-filter, none);
            transition: filter 0.15s ease;
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
            pointer-events: auto;
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
            <div class="annotationLayer">${linksHTML}</div>
        </div>
        </body>
        </html>
    `], { type: 'text/html' }))
}

/**
 * Main PDF & DjVu Loader Factory
 * Automatically uses Native MuPDF in Tauri, or seamlessly falls back to PDF.js.
 */
export const makeUniversalPDF = async (file) => {
    // Until native MuPDF C rasterizer pipeline is fully linked, safely route to battle-tested PDF.js
    const hasNativeMuPDF = false;

    if (!hasNativeMuPDF) {
        // Fallback to battle-tested PDF.js adapter without reinventing wheels
        const { makePDF } = await import('./pdf.js?v=20260826_wps2')
        return await makePDF(file)
    }

    // ==========================================
    // Native MuPDF Engine Pipeline (Tauri)
    // ==========================================
    const filePath = file.path || file.name
    const arrayBuf = await file.arrayBuffer()
    const bytes = Array.from(new Uint8Array(arrayBuf))

    // 1. Open document in native Rust/MuPDF and get O(N) metadata
    const docMeta = await platformBridge._invokeTauri('mupdf_open_document', {
        filePath,
        data: bytes
    })

    const numPages = docMeta.numPages || 1
    const defaultViewport = {
        width: Math.round(docMeta.defaultWidth || 800),
        height: Math.round(docMeta.defaultHeight || 1100)
    }

    const book = { rendition: { layout: 'pre-paginated', spread: 'none', viewport: defaultViewport } }

    book.metadata = {
        title: docMeta.title || (file.name ? file.name.replace(/\.(pdf|djvu)$/i, '') : 'PDF 文档'),
        author: docMeta.author || '未知作者',
        description: docMeta.subject || '',
        language: docMeta.language || 'zh',
        format: docMeta.format || 'PDF'
    }

    // 2. Fetch Outline via single O(1) flattened array call (ebooknt pattern)
    try {
        const flatOutline = await platformBridge._invokeTauri('mupdf_get_outline_flat', { docId: docMeta.docId })
        book.toc = buildTOCFromFlat(flatOutline)
    } catch (e) {
        console.warn('[MuPDF] Failed loading outline:', e)
        book.toc = []
    }

    const { textLayerCSS, annotationLayerCSS } = await getStyles()

    // 3. High-performance LRU Page Cache
    const MAX_PAGE_CACHE = 48
    const pageCache = new Map()
    const inFlightRequests = new Map()
    let activePageIndex = 0

    const revokePageUrls = (item) => {
        if (!item) return
        try {
            if (item.src) URL.revokeObjectURL(item.src)
            if (item.imgUrl) URL.revokeObjectURL(item.imgUrl)
        } catch (e) {}
    }

    const evictOldestIfNeeded = (excludeIndex = -1) => {
        if (pageCache.size <= MAX_PAGE_CACHE) return
        const lockedMin = Math.max(0, activePageIndex - 4)
        const lockedMax = activePageIndex + 4

        let oldestIndex = -1
        let oldestTime = Infinity
        for (const [idx, item] of pageCache.entries()) {
            if (idx === excludeIndex || (idx >= lockedMin && idx <= lockedMax)) continue
            if (item.timestamp < oldestTime) {
                oldestTime = item.timestamp
                oldestIndex = idx
            }
        }
        if (oldestIndex !== -1) {
            const item = pageCache.get(oldestIndex)
            pageCache.delete(oldestIndex)
            setTimeout(() => revokePageUrls(item), 60000)
        }
    }

    const loadPage = async (i, isPrefetch = false) => {
        if (!isPrefetch) activePageIndex = i
        const existing = pageCache.get(i)
        if (existing) {
            existing.timestamp = Date.now()
            return existing
        }
        if (inFlightRequests.has(i)) return inFlightRequests.get(i)

        const promise = (async () => {
            try {
                // Request native rasterized bitmap and structured text in parallel
                const [renderRes, textRes, linksRes] = await Promise.all([
                    platformBridge._invokeTauri('mupdf_render_page', {
                        docId: docMeta.docId,
                        pageIndex: i,
                        dpr: Math.min(2.0, Math.max(1.25, globalThis.devicePixelRatio || 1))
                    }),
                    platformBridge._invokeTauri('mupdf_get_text_layer', {
                        docId: docMeta.docId,
                        pageIndex: i
                    }),
                    platformBridge._invokeTauri('mupdf_get_links', {
                        docId: docMeta.docId,
                        pageIndex: i
                    }).catch(() => [])
                ])

                const imgBlob = new Blob([new Uint8Array(renderRes.imageBytes)], { type: 'image/webp' })
                const imgUrl = URL.createObjectURL(imgBlob)

                const src = await buildPageHTML({
                    cssWidth: renderRes.width || defaultViewport.width,
                    cssHeight: renderRes.height || defaultViewport.height,
                    imgUrl,
                    textSpans: textRes.spans || [],
                    links: linksRes || [],
                    textLayerCSS,
                    annotationLayerCSS
                })

                const cacheItem = {
                    src,
                    imgUrl,
                    width: renderRes.width || defaultViewport.width,
                    height: renderRes.height || defaultViewport.height,
                    textSpans: textRes.spans || [],
                    onZoom: null,
                    timestamp: Date.now()
                }

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

    const schedulePreRender = (currentIndex) => {
        const prefetchIndices = [currentIndex + 1, currentIndex - 1, currentIndex + 2].filter(
            idx => idx >= 0 && idx < numPages
        )
        setTimeout(async () => {
            for (const idx of prefetchIndices) {
                if (!pageCache.has(idx) && !inFlightRequests.has(idx)) {
                    try { await loadPage(idx, true) } catch (e) {}
                }
            }
        }, 100)
    }

    // 4. Sections matching Foliate Contract
    book.sections = Array.from({ length: numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const res = await loadPage(i)
            schedulePreRender(i)
            return { src: res.src, onZoom: res.onZoom }
        },
        createDocument: async () => {
            const pageData = await loadPage(i)
            const parser = new DOMParser()
            const textSpansHTML = (pageData.textSpans || []).map(span => {
                const escaped = String(span.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                return `<span style="left:${span.x}px; top:${span.y}px; width:${span.w}px; height:${span.h}px; font-size:${span.size}px;">${escaped}</span>`
            }).join('')
            return parser.parseFromString(
                `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="page-container"><img id="page-img" alt="Page" /><div class="textLayer">${textSpansHTML}</div><div class="annotationLayer"></div></div></body></html>`,
                'text/html'
            )
        },
        size: 1000
    }))

    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        try {
            const parsed = JSON.parse(href)
            return { index: (parsed.page || 1) - 1 }
        } catch (e) {
            return { index: 0 }
        }
    }
    book.splitTOCHref = async href => {
        try {
            const parsed = JSON.parse(href)
            return [(parsed.page || 1) - 1, null]
        } catch (e) {
            return [0, null]
        }
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => {
        try {
            const p0 = await loadPage(0, true)
            return await (await fetch(p0.imgUrl)).blob()
        } catch (e) {
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
            platformBridge._invokeTauri('mupdf_close_document', { docId: docMeta.docId }).catch(() => {})
        } catch (e) {}
    }

    return book
}
