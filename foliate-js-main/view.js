import * as CFI from './epubcfi.js'
import { TOCProgress, SectionProgress } from './progress.js'
import { Overlayer } from './overlayer.js?v=20260914_rel_v1'
import { textWalker } from './text-walker.js'

const SEARCH_PREFIX = 'foliate-search:'

const isZip = async file => {
    const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04
}

const isPDF = async file => {
    if (file?.name?.toLowerCase().endsWith('.pdf') || file?.type?.toLowerCase().includes('pdf') || file?.format === 'pdf') return true
    try {
        const sliceLen = Math.min(file.size || 8192, 8192)
        const buf = await file.slice(0, sliceLen).arrayBuffer()
        const arr = new Uint8Array(buf)
        let str = ''
        for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i])
        return str.includes('%PDF-')
    } catch {
        return false
    }
}

const isDjVu = async file => {
    if (file?.name?.toLowerCase().endsWith('.djvu') || file?.type?.toLowerCase().includes('djvu') || file?.format === 'djvu') return true
    try {
        const arr = new Uint8Array(await file.slice(0, 4).arrayBuffer())
        return arr[0] === 0x41 && arr[1] === 0x54 && arr[2] === 0x26 && arr[3] === 0x54
    } catch {
        return false
    }
}

const isCBZ = file =>
    file?.type === 'application/vnd.comicbook+zip' || (typeof file?.name === 'string' && file.name.toLowerCase().endsWith('.cbz'))

const isFB2 = file =>
    file?.type === 'application/x-fictionbook+xml' || (typeof file?.name === 'string' && file.name.toLowerCase().endsWith('.fb2'))

const isFBZ = file =>
    file?.type === 'application/x-zip-compressed-fb2'
    || (typeof file?.name === 'string' && (file.name.toLowerCase().endsWith('.fb2.zip') || file.name.toLowerCase().endsWith('.fbz')))

class SimpleLRU {
    constructor(maxSize = 50) {
        this.maxSize = maxSize
        this.cache = new Map()
    }
    get(key) {
        if (!this.cache.has(key)) return undefined
        const val = this.cache.get(key)
        this.cache.delete(key)
        this.cache.set(key, val)
        return val
    }
    set(key, val) {
        if (this.cache.has(key)) {
            this.cache.delete(key)
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value
            this.cache.delete(firstKey)
        }
        this.cache.set(key, val)
    }
    clear() {
        this.cache.clear()
    }
    get size() {
        return this.cache.size
    }
}

export const makeZipLoader = async file => {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } =
        await import('./vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()

    // Multi-key indexed map for O(1) resilient lookup
    const map = new Map()
    const lowerMap = new Map()

    const registerKey = (k, entry) => {
        if (!k) return
        if (!map.has(k)) map.set(k, entry)
        const lk = k.toLowerCase()
        if (!lowerMap.has(lk)) lowerMap.set(lk, entry)
    }

    for (const entry of entries) {
        const raw = entry.filename
        registerKey(raw, entry)
        const norm = raw.replace(/\\/g, '/')
        registerKey(norm, entry)
        const noLeading = norm.replace(/^\/+/, '')
        registerKey(noLeading, entry)
        try {
            const dec = decodeURIComponent(norm)
            registerKey(dec, entry)
            registerKey(dec.replace(/^\/+/, ''), entry)
        } catch {}
        try {
            const decURI = decodeURI(norm)
            registerKey(decURI, entry)
            registerKey(decURI.replace(/^\/+/, ''), entry)
        } catch {}
    }

    const findEntry = name => {
        if (!name) return null
        if (map.has(name)) return map.get(name)
        const noLeading = name.replace(/^\/+/, '')
        if (map.has(noLeading)) return map.get(noLeading)
        const norm = name.replace(/\\/g, '/')
        if (map.has(norm)) return map.get(norm)
        if (map.has(norm.replace(/^\/+/, ''))) return map.get(norm.replace(/^\/+/, ''))
        try {
            const dec = decodeURIComponent(name)
            if (map.has(dec)) return map.get(dec)
            if (map.has(dec.replace(/^\/+/, ''))) return map.get(dec.replace(/^\/+/, ''))
        } catch {}
        try {
            const decURI = decodeURI(name)
            if (map.has(decURI)) return map.get(decURI)
            if (map.has(decURI.replace(/^\/+/, ''))) return map.get(decURI.replace(/^\/+/, ''))
        } catch {}
        try {
            const enc = encodeURI(name)
            if (map.has(enc)) return map.get(enc)
        } catch {}
        // Case-insensitive fallback
        const lower = name.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '')
        if (lowerMap.has(lower)) return lowerMap.get(lower)
        try {
            const decLower = decodeURIComponent(name).toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '')
            if (lowerMap.has(decLower)) return lowerMap.get(decLower)
        } catch {}
        return null
    }

    // In-memory Section & Asset LRU caches for instant rendering & zero-CPU flip-backs
    const textCache = new SimpleLRU(64)
    const blobCache = new SimpleLRU(32)

    const loadText = async name => {
        const entry = findEntry(name)
        if (!entry) return null
        const cached = textCache.get(entry.filename)
        if (cached !== undefined) return cached
        let text = await entry.getData(new TextWriter())
        // Strip UTF-8 BOM if present
        if (typeof text === 'string' && text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1)
        }
        textCache.set(entry.filename, text)
        return text
    }
    const loadBlob = async (name, type) => {
        const entry = findEntry(name)
        if (!entry) return null
        const cacheKey = `${entry.filename}::${type || ''}`
        const cached = blobCache.get(cacheKey)
        if (cached !== undefined) return cached
        const blob = await entry.getData(new BlobWriter(type))
        blobCache.set(cacheKey, blob)
        return blob
    }
    const getSize = name => findEntry(name)?.uncompressedSize ?? 0
    const destroy = () => {
        textCache.clear()
        blobCache.clear()
        try { reader.close?.() } catch (e) {}
    }
    return { entries, loadText, loadBlob, getSize, destroy, close: destroy, textCache, blobCache }
}

const getFileEntries = async entry => entry.isFile ? entry
    : (await Promise.all(Array.from(
        await new Promise((resolve, reject) => entry.createReader()
            .readEntries(entries => resolve(entries), error => reject(error))),
        getFileEntries))).flat()

const makeDirectoryLoader = async entry => {
    const entries = await getFileEntries(entry)
    const files = await Promise.all(
        entries.map(entry => new Promise((resolve, reject) =>
            entry.file(file => resolve([file, entry.fullPath]),
                error => reject(error)))))
    const map = new Map(files.map(([file, path]) =>
        [path.replace(entry.fullPath + '/', ''), file]))
    const decoder = new TextDecoder()
    const decode = x => x ? decoder.decode(x) : null
    const getBuffer = name => map.get(name)?.arrayBuffer() ?? null
    const loadText = async name => decode(await getBuffer(name))
    const loadBlob = name => map.get(name)
    const getSize = name => map.get(name)?.size ?? 0
    return { loadText, loadBlob, getSize }
}

export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}

const fetchFile = async url => {
    const res = await fetch(url)
    if (!res.ok) throw new ResponseError(
        `${res.status} ${res.statusText}`, { cause: res })
    return new File([await res.blob()], new URL(res.url).pathname)
}

export const makeBook = async file => {
    if (typeof file === 'string') file = await fetchFile(file)
    let book
    if (file.isDirectory) {
        const loader = await makeDirectoryLoader(file)
        const { EPUB } = await import('./epub.js')
        book = await new EPUB(loader).init()
    }
    else if (!file.size) throw new NotFoundError('File not found')
    else if (await isPDF(file) || await isDjVu(file)) {
        const { makeUniversalPDF } = await import('./mupdf-adapter.js?v=20260909_v1')
        book = await makeUniversalPDF(file)
    }
    else if (await isZip(file)) {
        const loader = await makeZipLoader(file)
        if (isCBZ(file)) {
            const { makeComicBook } = await import('./comic-book.js')
            book = makeComicBook(loader, file)
        }
        else if (isFBZ(file)) {
            const { makeFB2 } = await import('./fb2.js')
            const { entries } = loader
            const entry = entries.find(entry => entry.filename.endsWith('.fb2'))
            const blob = await loader.loadBlob((entry ?? entries[0]).filename)
            book = await makeFB2(blob)
        }
        else if (loader.entries?.some(entry => entry.filename === 'word/document.xml') || file.name?.toLowerCase().endsWith('.docx')) {
            const { makeDOCX } = await import('./docx.js?v=20260826_w1')
            book = await makeDOCX(loader, file)
        }
        else {
            const { EPUB } = await import('./epub.js')
            book = await new EPUB(loader).init()
        }
        if (book && loader) book.loader = loader
    }
    else {
        const { isTXT, makeTXT } = await import('./txt.js?v=20260826_20')
        const { isMOBI, MOBI } = await import('./mobi.js')
        if (isTXT(file)) {
            book = await makeTXT(file)
        }
        else if (await isMOBI(file)) {
            const fflate = await import('./vendor/fflate.js')
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        }
        else if (isFB2(file)) {
            const { makeFB2 } = await import('./fb2.js')
            book = await makeFB2(file)
        }
    }
    if (!book) throw new UnsupportedTypeError('File type not supported')
    return book
}

class CursorAutohider {
    #timeout
    #el
    #check
    #state
    constructor(el, check, state = {}) {
        this.#el = el
        this.#check = check
        this.#state = state
        if (this.#state.hidden) this.hide()
        this.#el.addEventListener('mousemove', ({ screenX, screenY }) => {
            // check if it actually moved
            if (screenX === this.#state.x && screenY === this.#state.y) return
            this.#state.x = screenX, this.#state.y = screenY
            this.show()
            if (this.#timeout) clearTimeout(this.#timeout)
            if (check()) this.#timeout = setTimeout(this.hide.bind(this), 1000)
        }, false)
    }
    cloneFor(el) {
        return new CursorAutohider(el, this.#check, this.#state)
    }
    hide() {
        this.#el.style.cursor = 'none'
        this.#state.hidden = true
    }
    show() {
        this.#el.style.removeProperty('cursor')
        this.#state.hidden = false
    }
}

class History extends EventTarget {
    #arr = []
    #index = -1
    pushState(x) {
        const last = this.#arr[this.#index]
        if (last === x || last?.fraction && last.fraction === x.fraction) return
        this.#arr[++this.#index] = x
        this.#arr.length = this.#index + 1
        this.dispatchEvent(new Event('index-change'))
    }
    replaceState(x) {
        const index = this.#index
        this.#arr[index] = x
    }
    back() {
        const index = this.#index
        if (index <= 0) return
        const detail = { state: this.#arr[index - 1] }
        this.#index = index - 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    forward() {
        const index = this.#index
        if (index >= this.#arr.length - 1) return
        const detail = { state: this.#arr[index + 1] }
        this.#index = index + 1
        this.dispatchEvent(new CustomEvent('popstate', { detail }))
        this.dispatchEvent(new Event('index-change'))
    }
    get canGoBack() {
        return this.#index > 0
    }
    get canGoForward() {
        return this.#index < this.#arr.length - 1
    }
    clear() {
        this.#arr = []
        this.#index = -1
    }
}

const languageInfo = lang => {
    if (!lang) return {}
    try {
        const canonical = Intl.getCanonicalLocales(lang)[0]
        const locale = new Intl.Locale(canonical)
        const isCJK = ['zh', 'ja', 'ko'].includes(locale.language)
        const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction
        return { canonical, locale, isCJK, direction }
    } catch (e) {
        console.warn(e)
        return {}
    }
}

export class View extends HTMLElement {
    #root = this.attachShadow({ mode: 'open' })
    #sectionProgress
    #tocProgress
    #pageProgress
    #searchResults = new Map()
    #searchHighlights = new Map()
    #searchDraw
    #searchDrawOptions
    #cursorAutohider = new CursorAutohider(this, () =>
        this.hasAttribute('autohide-cursor'))
    isFixedLayout = false
    lastLocation
    history = new History()
    constructor() {
        super()
        this.history.addEventListener('popstate', ({ detail }) => {
            const resolved = this.resolveNavigation(detail.state)
            this.renderer.goTo(resolved)
        })
    }
    async open(book) {
        if (typeof book === 'string'
        || typeof book.arrayBuffer === 'function'
        || book.isDirectory) book = await makeBook(book)
        this.book = book
        this.language = languageInfo(book.metadata?.language)

        if (book.splitTOCHref && book.getTOCFragment) {
            const ids = book.sections.map(s => s.id)
            this.#sectionProgress = new SectionProgress(book.sections, 1500, 1600)
            const splitHref = book.splitTOCHref.bind(book)
            const getFragment = book.getTOCFragment.bind(book)
            this.#tocProgress = new TOCProgress()
            await this.#tocProgress.init({
                toc: book.toc ?? [], ids, splitHref, getFragment })
            this.#pageProgress = new TOCProgress()
            await this.#pageProgress.init({
                toc: book.pageList ?? [], ids, splitHref, getFragment })
        }

        this.isFixedLayout = this.book.rendition?.layout === 'pre-paginated'
        if (this.isFixedLayout) {
            await import('./fixed-layout.js?v=20260914_rel_v1')
            this.renderer = document.createElement('foliate-fxl')
        } else {
            await import('./paginator.js?v=20260914_rel_v1')
            this.renderer = document.createElement('foliate-paginator')
        }
        this.renderer.setAttribute('exportparts', 'head,foot,filter')
        this.renderer.addEventListener('load', e => this.#onLoad(e.detail))
        this.renderer.addEventListener('relocate', e => this.#onRelocate(e.detail))
        this.renderer.addEventListener('create-overlayer', e =>
            e.detail.attach(this.#createOverlayer(e.detail)))
        this.renderer.open(book)
        this.#root.append(this.renderer)

        if (book.sections.some(section => section.mediaOverlay)) {
            const activeClass = book.media.activeClass
            const playbackActiveClass = book.media.playbackActiveClass
            this.mediaOverlay = book.getMediaOverlay()
            let lastActive
            this.mediaOverlay.addEventListener('highlight', e => {
                const resolved = this.resolveNavigation(e.detail.text)
                this.renderer.goTo(resolved)
                    .then(() => {
                        const item = this.renderer.getContents()
                            .find(x => x.index === resolved.index)
                        if (!item?.doc) return
                        const el = resolved.anchor(item.doc)
                        el.classList.add(activeClass)
                        if (playbackActiveClass) el.ownerDocument
                            .documentElement.classList.add(playbackActiveClass)
                        lastActive = new WeakRef(el)
                    })
            })
            this.mediaOverlay.addEventListener('unhighlight', () => {
                const el = lastActive?.deref()
                if (el) {
                    el.classList.remove(activeClass)
                    if (playbackActiveClass) el.ownerDocument
                        .documentElement.classList.remove(playbackActiveClass)
                }
            })
        }
    }
    close() {
        try {
            this.renderer?.settle?.()
        } catch (e) {}
        this.clearSearch()
        try {
            this.book?.destroy?.()
        } catch (e) {
            console.warn('Error destroying book instance:', e)
        }
        try {
            this.book?.loader?.destroy?.() ?? this.book?.loader?.close?.()
        } catch (e) {
            console.warn('Error destroying book loader:', e)
        }
        this.renderer?.destroy()
        this.renderer?.remove()
        this.#sectionProgress = null
        this.#tocProgress = null
        this.#pageProgress = null
        this.#searchResults = new Map()
        this.lastLocation = null
        this.history.clear()
        this.tts = null
        this.mediaOverlay = null
        this.book = null
    }
    goToTextStart() {
        return this.goTo(this.book.landmarks
            ?.find(m => m.type.includes('bodymatter') || m.type.includes('text'))
            ?.href ?? this.book.sections.findIndex(s => s.linear !== 'no'))
    }
    async init({ lastLocation, showTextStart }) {
        const resolved = lastLocation != null ? this.resolveNavigation(lastLocation) : null
        if (resolved) {
            await this.renderer.goTo(resolved)
            this.history.pushState(lastLocation)
        }
        else if (showTextStart) await this.goToTextStart()
        else {
            this.history.pushState(0)
            await this.goTo({ index: 0 })
        }
    }
    #emit(name, detail, cancelable) {
        return this.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
    }
    #onRelocate({ reason, range, index, fraction, size, page, totalPages, isFastPath, isSettled }) {
        const progress = this.#sectionProgress?.getProgress(index, fraction, size) ?? {}
        const tocItem = range ? this.#tocProgress?.getProgress(index, range) : null
        const pageItem = range ? this.#pageProgress?.getProgress(index, range) : null
        const cfi = range ? this.getCFI(index, range) : null
        this.lastLocation = {
            ...progress,
            tocItem,
            pageItem,
            cfi: cfi || (!range && this.lastLocation?.index === index ? this.lastLocation?.cfi : null),
            range,
            page,
            totalPages,
            isFastPath: !!isFastPath,
            isSettled: !!isSettled
        }
        if (cfi && (reason === 'snap' || reason === 'page' || reason === 'scroll')) {
            this.history.replaceState(cfi)
        }
        this.#emit('relocate', this.lastLocation)

        // Intelligent section preloading: pre-warm adjacent next section into LRU cache during idle time without leaking Blob URLs
        if (this.book?.sections && index != null) {
            const nextIdx = index + 1
            if (page != null && totalPages != null && page >= totalPages - 1 && nextIdx < this.book.sections.length) {
                const nextSec = this.book.sections[nextIdx]
                if (nextSec && !nextSec._preloaded) {
                    nextSec._preloaded = true
                    const idleFn = globalThis.requestIdleCallback || (cb => setTimeout(cb, 120))
                    idleFn(() => {
                        try {
                            if (this.book?.loadText && nextSec.id) {
                                Promise.resolve(this.book.loadText(nextSec.id)).catch(() => {})
                            } else if (typeof nextSec.createDocument === 'function') {
                                Promise.resolve(nextSec.createDocument()).catch(() => {})
                            }
                        } catch (e) {}
                    })
                }
            }
        }
    }
    #onLoad({ doc, index }) {
        // set language and dir if not already set
        doc.documentElement.lang ||= this.language.canonical ?? ''
        if (!this.language.isCJK)
            doc.documentElement.dir ||= this.language.direction ?? ''

        this.#handleLinks(doc, index)
        this.#cursorAutohider.cloneFor(doc.documentElement)

        this.#emit('load', { doc, index })
    }
    #handleLinks(doc, index) {
        const { book } = this
        const section = book.sections[index]
        doc.addEventListener('click', e => {
            const a = e.target.closest('a[href]')
            if (!a) return
            e.preventDefault()
            const href_ = a.getAttribute('href')
            const href = section?.resolveHref?.(href_) ?? href_
            if (book?.isExternal?.(href))
                Promise.resolve(this.#emit('external-link', { a, href_ }, true))
                    .then(x => x ? globalThis.open(href_, '_blank') : null)
                    .catch(e => console.error(e))
            else Promise.resolve(this.#emit('link', { a, href }, true))
                .then(x => x ? this.goTo(href) : null)
                .catch(e => console.error(e))
        })
    }
    #ensureSearchHighlightStyle(doc) {
        if (!doc || doc.getElementById('foliate-css-highlight-style')) return
        try {
            const style = doc.createElement('style')
            style.id = 'foliate-css-highlight-style'
            style.textContent = `
                ::highlight(foliate-search) {
                    background-color: rgba(250, 204, 21, 0.45) !important;
                    color: inherit !important;
                }
                ::highlight(foliate-search-active) {
                    background-color: rgba(249, 115, 22, 0.75) !important;
                    color: inherit !important;
                }
            `
            doc.head?.append(style)
        } catch (e) {}
    }
    async addAnnotation(annotation, remove) {
        const { value } = annotation
        if (value.startsWith(SEARCH_PREFIX)) {
            if (remove) {
                if (this.#searchHighlights.has(value)) {
                    const { doc, range } = this.#searchHighlights.get(value)
                    this.#searchHighlights.delete(value)
                    if (doc?.defaultView?.CSS?.highlights?.has('foliate-search') && range) {
                        doc.defaultView.CSS.highlights.get('foliate-search').delete(range)
                    }
                }
                const cfi = value.replace(SEARCH_PREFIX, '')
                const resolved = await this.resolveNavigation(cfi)
                if (resolved) {
                    const obj = this.#getOverlayer(resolved.index)
                    obj?.overlayer?.remove(value)
                }
                return
            }
            const cfi = value.replace(SEARCH_PREFIX, '')
            const resolved = await this.resolveNavigation(cfi)
            if (!resolved) return
            const { index, anchor } = resolved
            const obj = this.#getOverlayer(index)
            if (obj) {
                const { overlayer, doc } = obj
                const range = doc ? anchor(doc) : anchor
                // Fast-path: Native Chromium CSS Custom Highlight API (zero DOM nodes, zero SVG pollution)
                if (doc?.defaultView?.CSS?.highlights && range) {
                    this.#ensureSearchHighlightStyle(doc)
                    let hl = doc.defaultView.CSS.highlights.get('foliate-search')
                    if (!hl) {
                        hl = new doc.defaultView.Highlight()
                        doc.defaultView.CSS.highlights.set('foliate-search', hl)
                    }
                    hl.add(range)
                    this.#searchHighlights.set(value, { doc, range })
                    return
                }
                overlayer.add(value, range, this.#searchDraw, this.#searchDrawOptions)
            }
            return
        }
        const rawCFI = value.includes('::') ? value.split('::')[0] : value
        const annotKey = annotation.id || value
        const resolved = await this.resolveNavigation(rawCFI)
        if (!resolved) return null
        const { index, anchor } = resolved
        const obj = this.#getOverlayer(index)
        if (obj) {
            const { overlayer, doc } = obj
            overlayer.remove(annotKey)
            if (!remove) {
                const range = doc ? anchor(doc) : anchor
                const draw = (func, opts) => overlayer.add(annotKey, range, func, opts)
                this.#emit('draw-annotation', { draw, annotation, doc, range })
            }
        }
        const label = this.#tocProgress?.getProgress(index)?.label ?? ''
        return { index, label }
    }
    deleteAnnotation(annotation) {
        return this.addAnnotation(annotation, true)
    }
    #getOverlayer(index) {
        return this.renderer.getContents()
            .find(x => x.index === index && x.overlayer)
    }
    #createOverlayer({ doc, index }) {
        const overlayer = new Overlayer()
        doc.addEventListener('click', e => {
            const [value, range] = overlayer.hitTest(e)
            if (value && !value.startsWith(SEARCH_PREFIX)) {
                this.#emit('show-annotation', { value, index, range })
            }
        }, false)

        const list = this.#searchResults.get(index)
        if (list) for (const item of list) this.addAnnotation(item)

        this.#emit('create-overlay', { index })
        if (this._pendingActiveSearchCfi) {
            setTimeout(() => this.setActiveSearchMatch(this._pendingActiveSearchCfi), 10)
        }
        return overlayer
    }
    async showAnnotation(annotation) {
        const { value } = annotation
        const resolved = await this.goTo(value)
        if (resolved) {
            const { index, anchor } = resolved
            const { doc } =  this.#getOverlayer(index)
            const range = anchor(doc)
            this.#emit('show-annotation', { value, index, range })
        }
    }
    getCFI(index, range) {
        const baseCFI = this.book.sections[index].cfi ?? CFI.fake.fromIndex(index)
        if (!range) return baseCFI
        return CFI.joinIndir(baseCFI, CFI.fromRange(range))
    }
    resolveCFI(cfi) {
        if (this.book.resolveCFI)
            return this.book.resolveCFI(cfi)
        else {
            const parts = CFI.parse(cfi)
            const index = CFI.fake.toIndex((parts.parent ?? parts).shift())
            const anchor = doc => CFI.toRange(doc, parts)
            return { index, anchor }
        }
    }
    resolveNavigation(target) {
        try {
            if (target == null) return { index: 0 }
            if (typeof target === 'number') {
                if (target > 0 && target < 1) return this.resolveNavigation({ fraction: target })
                return { index: Math.max(0, Math.min(this.book.sections.length - 1, Math.floor(target))) }
            }
            if (typeof target?.index === 'number') {
                const index = Math.max(0, Math.min(this.book.sections.length - 1, Math.floor(target.index)))
                return target.anchor ? { index, anchor: target.anchor } : { index }
            }
            if (typeof target.fraction === 'number') {
                if (this.#sectionProgress) {
                    const [index, anchor] = this.#sectionProgress.getSection(target.fraction)
                    return { index, anchor }
                }
                const index = Math.min(this.book.sections.length - 1, Math.max(0, Math.floor(target.fraction * this.book.sections.length)))
                return { index }
            }
            if (typeof target === 'string' && CFI.isCFI.test(target)) return this.resolveCFI(target)
            return this.book.resolveHref ? this.book.resolveHref(target) : { index: 0 }
        } catch (e) {
            console.warn(`Could not resolve target ${target}:`, e)
            return { index: 0 }
        }
    }
    async goTo(target) {
        const resolved = this.resolveNavigation(target)
        try {
            const success = await this.renderer.goTo(resolved)
            if (success) {
                this.history.pushState(target)
                return resolved
            }
            return null
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
            throw e
        }
    }
    async goToFraction(frac) {
        try {
            if (this.#sectionProgress) {
                const [index, anchor] = this.#sectionProgress.getSection(frac)
                await this.renderer.goTo({ index, anchor })
            } else if (this.book?.sections?.length) {
                const index = Math.min(this.book.sections.length - 1, Math.max(0, Math.floor(frac * this.book.sections.length)))
                await this.renderer.goTo({ index })
            }
            this.history.pushState({ fraction: frac })
        } catch (e) {
            console.warn('Failed to goToFraction:', frac, e)
        }
    }
    async select(target) {
        try {
            const obj = await this.resolveNavigation(target)
            await this.renderer.goTo({ ...obj, select: true })
            this.history.pushState(target)
        } catch(e) {
            console.error(e)
            console.error(`Could not go to ${target}`)
        }
    }
    deselect() {
        for (const { doc } of this.renderer.getContents())
            doc.defaultView.getSelection().removeAllRanges()
    }
    getSectionFractions() {
        return (this.#sectionProgress?.sectionFractions ?? [])
            .map(x => x + Number.EPSILON)
    }
    getProgressOf(index, range) {
        const tocItem = this.#tocProgress?.getProgress(index, range)
        const pageItem = this.#pageProgress?.getProgress(index, range)
        return { tocItem, pageItem }
    }
    async getTOCItemOf(target) {
        try {
            const resolved = await this.resolveNavigation(target)
            if (!resolved) return null
            const { index, anchor } = resolved
            const doc = await this.book.sections[index]?.createDocument?.()
            if (!doc) return null
            const frag = typeof anchor === 'function' ? anchor(doc) : null
            let range
            if (frag instanceof Range) {
                range = frag
            } else {
                range = doc.createRange()
                const isNode = frag && typeof frag === 'object' && ('nodeType' in frag)
                if (isNode) {
                    range.selectNodeContents(frag)
                } else if (doc.body) {
                    range.selectNodeContents(doc.body)
                    range.collapse(true)
                } else if (doc.documentElement) {
                    range.selectNodeContents(doc.documentElement)
                    range.collapse(true)
                }
            }
            return this.#tocProgress?.getProgress(index, range) || null
        } catch(e) {
            console.error(e)
            console.error(`Could not get ${target}`)
        }
    }
    async prev(distance) {
        await this.renderer.prev(distance)
    }
    async next(distance) {
        await this.renderer.next(distance)
    }
    goLeft() {
        return this.book.dir === 'rtl' ? this.next() : this.prev()
    }
    goRight() {
        return this.book.dir === 'rtl' ? this.prev() : this.next()
    }
    async * #searchSection(matcher, query, index, signal) {
        if (signal?.aborted) return
        let doc
        try {
            doc = await this.book.sections[index]?.createDocument?.()
        } catch (e) {
            console.warn(`Failed to createDocument for section ${index}:`, e)
            return
        }
        if (signal?.aborted || !doc) return
        try {
            for (const { range, excerpt } of matcher(doc, query)) {
                if (signal?.aborted) return
                try {
                    const cfi = this.getCFI(index, range)
                    if (cfi) yield { cfi, excerpt }
                } catch (cfiErr) {
                    console.warn('Failed to calculate CFI for match:', cfiErr)
                }
            }
        } catch (e) {
            console.warn(`Search matcher error in section ${index}:`, e)
        }
    }
    async * #searchBook(matcher, query, signal) {
        const { sections } = this.book
        for (const [index, { createDocument }] of sections.entries()) {
            if (signal?.aborted) break
            if (!createDocument) continue
            try {
                const doc = await createDocument()
                if (signal?.aborted || !doc) continue
                const subitems = []
                for (const { range, excerpt } of matcher(doc, query)) {
                    if (signal?.aborted) break
                    try {
                        const cfi = this.getCFI(index, range)
                        if (cfi) subitems.push({ cfi, excerpt })
                    } catch (cfiErr) {
                        console.warn('Failed to calculate CFI for match:', cfiErr)
                    }
                }
                const progress = (index + 1) / sections.length
                yield { progress }
                if (subitems.length) yield { index, subitems }
            } catch (secErr) {
                console.warn(`Search error in section ${index}:`, secErr)
            }
            // Cooperative multitasking: yield to browser event loop so UI and animations remain 60fps smooth
            await new Promise(r => setTimeout(r, 0))
        }
    }
    async * search(opts) {
        this.clearSearch()
        this.#searchDraw = opts.draw ?? Overlayer.searchMatch ?? Overlayer.outline
        this.#searchDrawOptions = opts.drawOptions
        const { searchMatcher } = await import('./search.js')
        const { query, index, signal } = opts
        const matcher = searchMatcher(textWalker,
            { defaultLocale: this.language, ...opts })
        const iter = index != null
            ? this.#searchSection(matcher, query, index, signal)
            : this.#searchBook(matcher, query, signal)

        const list = []
        this.#searchResults.set(index, list)

        for await (const result of iter) {
            if (signal?.aborted) break
            if (result.subitems){
                const list = result.subitems
                    .map(({ cfi }) => ({ value: SEARCH_PREFIX + cfi }))
                this.#searchResults.set(result.index, list)
                for (const item of list) {
                    try { this.addAnnotation(item) } catch (e) {}
                }
                yield {
                    index: result.index,
                    label: this.#tocProgress?.getProgress(result.index)?.label || `第 ${result.index + 1} 页`,
                    subitems: result.subitems,
                }
            }
            else {
                if (result.cfi) {
                    const item = { value: SEARCH_PREFIX + result.cfi }
                    list.push(item)
                    try { this.addAnnotation(item) } catch (e) {}
                }
                yield result
            }
        }
        if (!signal?.aborted) yield 'done'
    }
    setActiveSearchMatch(cfi) {
        if (!cfi) return
        this._pendingActiveSearchCfi = cfi
        const contents = this.renderer?.getContents?.() || []
        for (const { doc } of contents) {
            if (doc?.defaultView?.CSS?.highlights) {
                let activeHl = doc.defaultView.CSS.highlights.get('foliate-search-active')
                if (!activeHl) {
                    activeHl = new doc.defaultView.Highlight()
                    doc.defaultView.CSS.highlights.set('foliate-search-active', activeHl)
                }
                activeHl.clear()
            }
        }
        const resolved = this.resolveNavigation(cfi)
        if (!resolved) return
        const { index, anchor } = resolved
        const obj = this.#getOverlayer(index)
        if (obj?.doc) {
            try {
                const range = typeof anchor === 'function' ? anchor(obj.doc) : anchor
                if (obj.doc.defaultView?.CSS?.highlights && range) {
                    this.#ensureSearchHighlightStyle(obj.doc)
                    let activeHl = obj.doc.defaultView.CSS.highlights.get('foliate-search-active')
                    if (!activeHl) {
                        activeHl = new obj.doc.defaultView.Highlight()
                        obj.doc.defaultView.CSS.highlights.set('foliate-search-active', activeHl)
                    }
                    activeHl.clear()
                    activeHl.add(range)
                }
            } catch (e) {
                console.warn('Failed to set active search highlight:', e)
            }
        }
    }
    clearSearch() {
        this._pendingActiveSearchCfi = null
        this.#searchHighlights.clear()
        for (const list of this.#searchResults.values())
            for (const item of list) this.deleteAnnotation(item)
        this.#searchResults.clear()
        // Clear native CSS highlights across all active content documents
        const contents = this.renderer?.getContents?.() || []
        for (const { doc } of contents) {
            if (doc?.defaultView?.CSS?.highlights) {
                doc.defaultView.CSS.highlights.get('foliate-search')?.clear?.()
                doc.defaultView.CSS.highlights.get('foliate-search-active')?.clear?.()
                doc.defaultView.CSS.highlights.delete('foliate-search')
                doc.defaultView.CSS.highlights.delete('foliate-search-active')
            }
        }
    }
    async initTTS(granularity = 'word', highlight) {
        const doc = this.renderer?.getContents?.()?.[0]?.doc
        if (!doc) return
        if (this.tts && this.tts.doc === doc) return
        const { TTS } = await import('./tts.js')
        this.tts = new TTS(doc, textWalker, highlight || (range =>
            this.renderer.scrollToAnchor(range, true)), granularity)
    }
    startMediaOverlay() {
        const item = this.renderer?.getContents?.()?.[0]
        if (!item) return
        return this.mediaOverlay?.start?.(item.index)
    }
}

if (!customElements.get('foliate-view')) {
    customElements.define('foliate-view', View)
}
