// Optional page textures for the existing curl renderer. The browser paints the
// actual laid-out XHTML/CSS; no text measurement/reconstruction or navigation.
const XHTML = 'http://www.w3.org/1999/xhtml'
const SVG = 'http://www.w3.org/2000/svg'
const LOW_MEMORY_TEXTURE_PIXELS = 2 * 1024 * 1024
const HIGH_MEMORY_TEXTURE_PIXELS = 6_000_000
const isLowMemoryDevice = () => {
    const mem = globalThis.navigator?.deviceMemory
    return typeof mem === 'number' && Number.isFinite(mem) && mem > 0 && mem <= 2
}
const hasHighTextureBudget = () => !isLowMemoryDevice()
let snapshotVersion = 0
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024
const TRANSIENT_ATTR_RE = /^(?:aria-|data-tts|data-speaking|data-reading|data-search|data-highlight-pulse|tabindex$)/i
const RENDERER_LAYOUT_ATTRS = new Set(['flow', 'dir', 'style', 'class', 'gap', 'margin', 'max-inline-size', 'max-block-size', 'max-column-count'])

function check(signal) {
    if (signal.aborted) throw new DOMException('Snapshot cancelled', 'AbortError')
}

function waitFor(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Snapshot cancelled', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
    })
}

function loadImage(src, signal) {
    return new Promise((resolve, reject) => {
        const img = new Image()
        const finish = (error) => {
            signal.removeEventListener('abort', abort)
            img.onload = img.onerror = null
            if (error) { img.src = ''; reject(error) } else resolve(img)
        }
        const abort = () => finish(new DOMException('Snapshot cancelled', 'AbortError'))
        img.onload = () => finish()
        img.onerror = () => finish(new Error('Page snapshot image unavailable'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        else img.src = src
    })
}

// SVG images cannot load external subresources. Inline only the same resources
// the reader already loaded (blob/data/same origin), with a per-document budget.
async function serializeDocument(doc, signal) {
    const win = doc.defaultView
    const root = doc.documentElement
    if (!root || root.localName !== 'html' || doc.querySelector('canvas,video,audio,iframe,object,embed'))
        throw new Error('This page needs live DOM rendering')
    if (doc.getElementsByTagName('*').length > 12000)
        throw new Error('Chapter exceeds snapshot budget')
    const clone = root.cloneNode(true)
    const resources = new Map()
    let bytes = 0
    const dataUrl = async (raw, base = doc.baseURI) => {
        if (!raw || raw.startsWith('#') || raw.startsWith('data:')) return raw
        const url = new URL(raw, base)
        if (url.protocol !== 'blob:' && (!['http:', 'https:'].includes(url.protocol) || url.origin !== win.location.origin))
            throw new Error('External page resource needs live DOM')
        if (!resources.has(url.href)) resources.set(url.href, (async () => {
            const response = await fetch(url, { signal, credentials: 'same-origin' })
            if (!response.ok) throw new Error('Page resource unavailable')
            const blob = await response.blob()
            bytes += blob.size
            if (bytes > MAX_RESOURCE_BYTES) throw new Error('Page resources exceed snapshot budget')
            return new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result)
                reader.onerror = () => reject(reader.error)
                reader.readAsDataURL(blob)
            })
        })())
        return resources.get(url.href)
    }
    const css = async (source, base) => {
        // rem and viewport units in an SVG image refer to its outer SVG, not
        // the embedded HTML document. Keep the reader's original reference size.
        const rootSize = parseFloat(win.getComputedStyle(root).fontSize) || 16
        const urls = []
        // Keep URI payloads out of CSS unit/selector substitutions (including
        // an EPUB that already embeds a font as a base64 data URI).
        let text = source.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/g, (match, a, b, c) => {
            urls.push(a ?? b ?? c)
            return `url(__linden_resource_${urls.length - 1}__)`
        }).replace(/(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(-?\d*\.?\d+)(rem|vw|vh|vmin|vmax)\b|(:root\b)/g, (match, literal, n, unit, rootSelector) => {
            if (literal) return literal
            if (rootSelector) return 'html'
            const factor = { rem: rootSize, vw: win.innerWidth / 100, vh: win.innerHeight / 100,
                vmin: Math.min(win.innerWidth, win.innerHeight) / 100,
                vmax: Math.max(win.innerWidth, win.innerHeight) / 100 }[unit]
            return `${Number(n) * factor}px`
        })
        if (/^@font-face\b/.test(source)) text = text.replace(/font-display\s*:[^;}]+/g, 'font-display: block')
        for (let i = 0; i < urls.length; i++) {
            const value = await dataUrl(urls[i], base)
            text = text.replace(`url(__linden_resource_${i}__)`, `url("${value}")`)
        }
        return text
    }
    const rules = async (list, base) => {
        const result = []
        for (const rule of list) {
            check(signal)
            if (rule.type === 10) result.push(rule.cssText) // Namespace URIs are identifiers, not fetched resources.
            else if (rule.type === 3) result.push(await rules(rule.styleSheet.cssRules, rule.href))
            else if (rule.type === 4) {
                if (win.matchMedia(rule.conditionText).matches) result.push(await rules(rule.cssRules, base))
            } else result.push(await css(rule.cssText, base))
        }
        return result.join('\n')
    }
    const originals = [...root.querySelectorAll('*')]
    const copies = [...clone.querySelectorAll('*')]
    const fontUses = new Map()
    let sliceStart = performance.now()
    for (let i = 0; i < originals.length; i++) {
        check(signal)
        if (i % 128 === 0 && performance.now() - sliceStart > 6) {
            await new Promise(resolve => setTimeout(resolve, 0))
            sliceStart = performance.now()
        }
        const el = originals[i], copy = copies[i]
        const name = el.localName
        if (name === 'body' || [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) {
            const computed = win.getComputedStyle(el)
            for (const family of computed.fontFamily.split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''))) {
                if (!fontUses.has(family)) fontUses.set(family, [])
                fontUses.get(family).push({ weight: Number(computed.fontWeight) || 400, style: computed.fontStyle })
            }
        }
        if (name === 'script' || name === 'base' || name === 'meta') { copy.remove(); continue }
        if (el.sheet) {
            if (el.sheet.disabled || (el.media && !win.matchMedia(el.media).matches)) { copy.remove(); continue }
            const style = doc.createElementNS(XHTML, 'style')
            style.textContent = await rules(el.sheet.cssRules, el.sheet.href || doc.baseURI)
            copy.replaceWith(style)
            continue
        }
        if (el.hasAttribute('style')) copy.setAttribute('style', await css(el.getAttribute('style'), doc.baseURI))
        if (name === 'img') {
            if (!el.complete || !el.naturalWidth) throw new Error('Page image not ready')
            copy.removeAttribute('srcset')
            copy.removeAttribute('loading')
            copy.setAttribute('src', await dataUrl(el.currentSrc || el.src))
        } else if (name === 'image' || name === 'use') {
            for (const attr of ['href', 'xlink:href']) if (el.hasAttribute(attr))
                copy.setAttribute(attr, await dataUrl(el.getAttribute(attr)))
        }
        // Images in <picture> are frozen to the resource actually selected above.
        if (name === 'source') { copy.removeAttribute('srcset'); copy.removeAttribute('src') }
    }
    // Foliate also copies the app's FontFaceSet into the iframe. Those bundled
    // faces are not in the chapter stylesheets, so serialize their CSS sources
    // too, limited to families/weights actually used by this document.
    const appFonts = []
    const collectFonts = async (list, base) => {
        for (const rule of list) {
            if (rule.type === 5) {
                const family = rule.style.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '')
                const uses = fontUses.get(family)
                const weights = (rule.style.getPropertyValue('font-weight') || '400').split(/\s+/).map(Number)
                const min = weights[0] || 400, max = weights[1] || min
                const style = rule.style.getPropertyValue('font-style') || 'normal'
                if (uses?.some(u => u.weight >= min && u.weight <= max && u.style === style))
                    appFonts.push(await css(rule.cssText, base))
            } else if (rule.type === 3) await collectFonts(rule.styleSheet.cssRules, rule.href)
            else if (rule.cssRules) await collectFonts(rule.cssRules, base)
        }
    }
    if (win.parent !== win) {
        for (const sheet of win.parent.document.styleSheets) {
            // App sheets are local; inaccessible third-party UI sheets are not reader fonts.
            let list
            try { list = sheet.cssRules } catch { continue }
            await collectFonts(list, sheet.href || win.parent.document.baseURI)
        }
    }
    if (appFonts.length) {
        const style = doc.createElementNS(XHTML, 'style')
        style.textContent = appFonts.join('\n')
        clone.querySelector('head')?.prepend(style)
    }
    for (const property of ['font-size', 'font-family', 'color', 'line-height'])
        clone.style.setProperty(property, win.getComputedStyle(root).getPropertyValue(property), 'important')
    // In a document the root overflow clips the iframe viewport, not the root
    // column box. In foreignObject it would incorrectly hide every later column.
    clone.style.setProperty('overflow', 'visible', 'important')
    clone.setAttribute('xmlns', XHTML)
    check(signal)
    return new XMLSerializer().serializeToString(clone)
}

async function paintPage(context, encodedXhtml, signal) {
    const { width, height, frame, offsetX, background, overlay } = context
    const highMemory = hasHighTextureBudget()
    const pixelLimit = highMemory ? HIGH_MEMORY_TEXTURE_PIXELS : LOW_MEMORY_TEXTURE_PIXELS
    const nativeDpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1
    const maxDpr = highMemory ? Math.min(nativeDpr, 3) : Math.min(nativeDpr, 2)
    const ratio = Math.min(maxDpr, Math.sqrt(pixelLimit / Math.max(1, width * height)))
    const pixelWidth = Math.max(1, Math.round(width * ratio))
    const pixelHeight = Math.max(1, Math.round(height * ratio))
    const doc = document.implementation.createDocument(SVG, 'svg')
    const svg = doc.documentElement
    svg.setAttribute('width', pixelWidth)
    svg.setAttribute('height', pixelHeight)
    svg.setAttribute('viewBox', ['0', '0', width, height].join(' '))
    const bg = doc.createElementNS(SVG, 'rect')
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%')
    bg.setAttribute('fill', background)
    svg.append(bg)
    const foreign = doc.createElementNS(SVG, 'foreignObject')
    foreign.setAttribute('x', frame.x + offsetX)
    foreign.setAttribute('y', frame.y)
    foreign.setAttribute('width', frame.width)
    foreign.setAttribute('height', frame.height)
    foreign.setAttribute('direction', context.direction)
    const contentMarker = doc.createComment('folio-page-xhtml')
    foreign.append(contentMarker)
    svg.append(foreign)
    if (overlay?.element?.childElementCount) {
        const el = overlay.element, rect = context.overlayRect
        const layer = doc.importNode(el, true)
        layer.setAttribute('x', rect.x + offsetX); layer.setAttribute('y', rect.y)
        layer.setAttribute('width', rect.width); layer.setAttribute('height', rect.height)
        layer.removeAttribute('style')
        svg.append(layer)
    }
    // Only the viewport and annotation wrapper change between columns.
    const source = new XMLSerializer().serializeToString(svg)
    const marker = '<!--folio-page-xhtml-->'
    const offset = source.indexOf(marker)
    const prefix = encodeURIComponent(source.slice(0, offset))
    const suffix = encodeURIComponent(source.slice(offset + marker.length))
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + prefix + encodedXhtml + suffix, signal)
    check(signal)
    const canvas = document.createElement('canvas')
    canvas.width = pixelWidth
    canvas.height = pixelHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    img.src = ''
    return { canvas, width, height, bgColor: background, textureDpr: ratio,
        pageIndex: context.page, visualVersion: ++snapshotVersion, closeBitmapOnUpload: false }
}

/** One active section and a bounded window of nearby page textures.
 * Page moves reuse the section source and already painted neighbors.
 * Content or layout changes invalidate all snapshots from that section.
 */
export class FoliatePageSnapshots {
    constructor(renderer, viewport, canPrepare = () => true) {
        this.renderer = renderer
        this.viewport = viewport
        this.canPrepare = canPrepare
        this.cache = new Map()
        this.events = new AbortController()
        this.onChange = () => this.invalidate()
        this.onMutations = (records) => {
            if (!Array.isArray(records) || !records.length) {
                this.invalidate()
                return
            }
            const needsInvalidate = records.some(record => {
                if (record.target === this.renderer) {
                    return record.type !== 'attributes' || RENDERER_LAYOUT_ATTRS.has(record.attributeName)
                }
                if (record.type === 'attributes') {
                    const attr = record.attributeName || ''
                    if (TRANSIENT_ATTR_RE.test(attr)) return false
                    if (attr === 'class' && record.target?.className != null && typeof record.oldValue === 'string') {
                        const prev = new Set(record.oldValue.trim().split(/\s+/).filter(Boolean))
                        const next = new Set(String(record.target.className).trim().split(/\s+/).filter(Boolean))
                        const changed = [...prev].filter(c => !next.has(c)).concat([...next].filter(c => !prev.has(c)))
                        if (changed.length > 0 && changed.every(c => /^(?:tts-|ll-tts|reading-active|highlight-pulse|search-active)/i.test(c))) {
                            return false
                        }
                    }
                    return true
                }
                return true
            })
            if (needsInvalidate) this.invalidate()
        }
        this.observer = new MutationObserver(this.onMutations)
        for (const name of ['relocate', 'nav-idle']) {
            renderer.addEventListener(name, () => this.refresh(), { signal: this.events.signal })
        }
        renderer.addEventListener('load', this.onChange, { signal: this.events.signal })
        document.addEventListener('visibilitychange', this.onChange, { signal: this.events.signal })
        this.refresh()
    }

    refresh(delay = 100) {
        clearTimeout(this.timer)
        if (!this.events.signal.aborted && !document.hidden) this.timer = setTimeout(() => this.prepare(), delay)
    }

    pause() {
        this.controller?.abort()
        this.refresh()
    }

    invalidate() {
        this.controller?.abort()
        this.controller = null
        this.source = null
        this.observer.disconnect()
        this.documentEvents?.abort()
        for (const value of this.cache.values()) value.canvas.width = value.canvas.height = 0
        this.cache.clear()
        this.refresh()
    }

    get(direction) {
        const source = this.source
        if (!source || this.renderer.isNavBusy?.() || this.renderer.getContents?.()[0]?.doc !== source.doc) return null
        const visual = direction === 'next' ? 1 : direction === 'prev' ? -1 : 0
        const page = this.renderer.page + (source.direction === 'rtl' ? -visual : visual)
        return this.cache.get(page) || null
    }

    async getCurrentForTurn() {
        const current = this.get('current')
        if (current) return current
        await this.prepare(true)
        return this.get('current')
    }

    async prepare(onlyCurrent = false) {
        if (this.events.signal.aborted || document.hidden || this.renderer.isNavBusy?.()) return
        if (!onlyCurrent && !this.canPrepare()) {
            this.refresh()
            return
        }
        const context = this.renderer.getPageSnapshotContext?.('current', this.viewport)
        if (!context) return
        const layout = JSON.stringify([context.width, context.height, context.frame.width, context.frame.height,
            context.frame.y, context.background, context.direction])
        const source = this.source
        if (source && (source.doc !== context.doc || source.layout !== layout)) {
            this.invalidate()
            return
        }

        this.controller?.abort()
        const controller = this.controller = new AbortController()
        const { signal } = controller
        const timeout = setTimeout(() => controller.abort(), 2500)
        try {
            if (!source) {
                await waitFor(context.doc.fonts?.ready, signal)
                check(signal)
                const xhtml = await serializeDocument(context.doc, signal)
                check(signal)
                this.source = { doc: context.doc, direction: context.direction, layout, encodedXhtml: encodeURIComponent(xhtml) }
            }
            const prepared = this.source
            const movement = context.page - (prepared.page ?? context.page)
            if (movement) prepared.visualDirection = Math.sign(movement) * (context.direction === 'rtl' ? -1 : 1)
            prepared.page = context.page
            const forward = prepared.visualDirection ?? (context.direction === 'rtl' ? -1 : 1)
            const offsets = onlyCurrent ? [0]
                : hasHighTextureBudget() ? [0, forward, 2 * forward, -forward] : [0, forward, -forward]
            const wanted = offsets
                .map(offset => this.renderer.getPageSnapshotContext(offset, this.viewport))
                .filter(page => page?.doc === context.doc)
            const pages = new Set(wanted.map(page => page.page))
            for (const [key, value] of this.cache) {
                if (onlyCurrent || pages.has(key)) continue
                value.canvas.width = value.canvas.height = 0
                this.cache.delete(key)
            }

            for (const page of wanted) {
                if (this.cache.has(page.page)) continue
                if (!onlyCurrent && !this.canPrepare()) {
                    this.refresh()
                    break
                }
                const snapshot = await paintPage(page, prepared.encodedXhtml, signal)
                if (signal.aborted) {
                    snapshot.canvas.width = snapshot.canvas.height = 0
                    break
                }
                this.cache.set(page.page, snapshot)
            }
            if (!signal.aborted) this.lastError = null
        } catch (error) {
            if (!signal.aborted && this.controller === controller) this.lastError = error.message
        } finally {
            clearTimeout(timeout)
            if (this.controller === controller) {
                this.controller = null
                if (!this.events.signal.aborted && (!this.documentEvents || this.documentEvents.signal.aborted)) this.observe(context)
            }
        }
    }

    observe(context) {
        this.observer.observe(context.doc.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true })
        if (context.overlay?.element) this.observer.observe(context.overlay.element, { childList: true })
        this.observer.observe(this.renderer, { attributes: true })
        this.documentEvents = new AbortController()
        context.doc.addEventListener('load', this.onChange, { capture: true, signal: this.documentEvents.signal })
        context.doc.fonts?.addEventListener('loadingdone', this.onChange, { signal: this.documentEvents.signal })
    }

    dispose() {
        this.events.abort()
        this.invalidate()
    }
}
