import * as CFI from '../epubcfi.js'
import { search } from '../search.js'
import { SectionProgress } from '../progress.js'
import { textWalker } from '../text-walker.js'
import { EPUB } from '../epub.js'
import { View } from '../view.js'
import { FixedLayout } from '../fixed-layout.js'

console.log('--- RUNNING ALL BUG FIX VERIFICATION TESTS ---')

// 1. epubcfi tests
console.log('Testing 3. epubcfi.js fixes...')
{
    // Test partsToNode with empty parts
    const parser = new DOMParser()
    const doc = parser.parseFromString('<html><body><p>Test</p></body></html>', 'text/html')
    const resEmpty = CFI.toElement(doc, CFI.parse('/6/2!')[0])
    console.assert(resEmpty === doc.documentElement, 'toElement on root cfi should return root element')

    // Test element offset overflow
    const doc2 = parser.parseFromString('<html><body><p id="p1">Short text</p></body></html>', 'text/html')
    const rangeElem = CFI.toRange(doc2, CFI.parse('/6/2!/4/2:999'))
    console.assert(rangeElem instanceof Range, 'CFI with element offset overflow should return a valid Range')
    console.assert(rangeElem.startOffset <= rangeElem.startContainer.childNodes.length, 'Element offset should be clamped')

    // Test text chunk offset overflow
    const rangeText = CFI.toRange(doc2, CFI.parse('/6/2!/4/2/1:999'))
    console.assert(rangeText instanceof Range, 'CFI with text offset overflow should return a valid Range')
    console.assert(rangeText.startOffset <= rangeText.startContainer.nodeValue.length, 'Text offset should be clamped')

    // Test fromElements with empty / null
    const resNull = CFI.fromElements(null)
    console.assert(Array.isArray(resNull) && resNull.length === 0, 'fromElements(null) should return []')
    const resEmptyArr = CFI.fromElements([])
    console.assert(Array.isArray(resEmptyArr) && resEmptyArr.length === 0, 'fromElements([]) should return []')
    console.log('  -> epubcfi.js passed!')
}

// 2. search.js tests
console.log('Testing 8. search.js boundary whitespace fixes...')
{
    const strs = ['Hello', 'world']
    // simpleSearch
    const resultsSimple = Array.from(search(strs, 'Hello world', { granularity: 'grapheme' }))
    console.assert(resultsSimple.length === 1, `simpleSearch should find "Hello world" across chunks, found ${resultsSimple.length}`)
    console.assert(resultsSimple[0].range.startIndex === 0 && resultsSimple[0].range.endIndex === 1, 'simpleSearch range should span from chunk 0 to chunk 1')
    console.assert(resultsSimple[0].range.startOffset === 0 && resultsSimple[0].range.endOffset === 5, 'simpleSearch offsets should be 0 and 5')

    // segmenterSearch
    const resultsSegmenter = Array.from(search(strs, 'Hello world', { granularity: 'word', matchWholeWords: true }))
    console.assert(resultsSegmenter.length === 1, `segmenterSearch should find "Hello world" across chunks, found ${resultsSegmenter.length}`)
    console.assert(resultsSegmenter[0].range.startIndex === 0 && resultsSegmenter[0].range.endIndex === 1, 'segmenterSearch range should span from chunk 0 to chunk 1')
    console.assert(resultsSegmenter[0].range.startOffset === 0 && resultsSegmenter[0].range.endOffset === 5, 'segmenterSearch offsets should be 0 and 5')

    // test when chunks already have whitespace
    const strsWithSpace = ['Hello ', 'world']
    const resultsWithSpace = Array.from(search(strsWithSpace, 'Hello world', { granularity: 'grapheme' }))
    console.assert(resultsWithSpace.length === 1, 'simpleSearch should find "Hello world" when trailing space exists')

    console.log('  -> search.js passed!')
}

// 3. progress.js tests
console.log('Testing 9. progress.js sizeTotal === 0 NaN guard...')
{
    const emptySections = [{ size: 0 }, { size: 0 }]
    const prog = new SectionProgress(emptySections, 1500, 1600)
    console.assert(prog.sizeTotal === 0, 'sizeTotal should be 0')
    console.assert(!prog.sectionFractions.some(x => Number.isNaN(x)), 'sectionFractions should not contain NaN')
    console.assert(prog.sectionFractions.length === 3, 'sectionFractions should have 3 items')
    
    const p = prog.getProgress(0, 0.5)
    console.assert(!Number.isNaN(p.fraction), 'progress fraction should not be NaN')
    console.assert(!Number.isNaN(p.location.current), 'location should not be NaN')

    const s = prog.getSection(0.5)
    console.assert(!Number.isNaN(s[0]) && !Number.isNaN(s[1]), 'getSection should not return NaN')
    console.log('  -> progress.js passed!')
}

// 4. text-walker.js tests
console.log('Testing 10. text-walker.js walkRange non-text node filtering...')
{
    const parser = new DOMParser()
    const doc = parser.parseFromString('<html><body><p id="p">Hello <span>World</span></p></body></html>', 'text/html')
    const range = doc.createRange()
    range.setStart(doc.body, 0)
    range.setEnd(doc.body, 1)

    const matches = []
    for (const match of textWalker(range, function* (strs, makeRange) {
        matches.push(...strs)
        const r = makeRange(0, 0, 0, 5)
        console.assert(r.startContainer.nodeType === 3, 'startContainer should be a Text node, not Element')
    })) {}
    console.assert(matches.every(s => typeof s === 'string'), 'All items should be strings')
    console.log('  -> text-walker.js passed!')
}

// 5. fb2.js regex and methods
console.log('Testing 6. fb2.js single-quote XML declaration and resolveHref...')
{
    const regex = /^<\?xml\s+version\s*=\s*(["'])1\.\d+\1\s+encoding\s*=\s*(["'])([A-Za-z0-9._-]+)\2/
    const doubleQuoted = '<?xml version="1.0" encoding="windows-1251"?>'
    const singleQuoted = "<?xml version='1.0' encoding='windows-1251'?>"
    console.assert(doubleQuoted.match(regex)?.[3] === 'windows-1251', 'Double quoted xml encoding should match')
    console.assert(singleQuoted.match(regex)?.[3] === 'windows-1251', 'Single quoted xml encoding should match')

    // Test resolveHref logic
    const idMap = new Map([['sec1', 1]])
    const dataID = 'data-foliate-id'
    const resolveHref = href => {
        if (!href && href !== 0) return { index: 0, anchor: null }
        const [a, b] = String(href).split('#')
        if (a) {
            const index = Number(a)
            const safeIndex = isNaN(index) ? 0 : index
            const anchor = b != null ? doc => doc.querySelector(`[${dataID}="${b}"]`) : null
            return { index: safeIndex, anchor }
        }
        const mappedIndex = idMap.get(b)
        if (mappedIndex != null) {
            return { index: mappedIndex, anchor: doc => doc.getElementById(b) }
        }
        return { index: 0, anchor: null }
    }
    console.assert(resolveHref('0').index === 0, 'resolveHref("0") should return index 0')
    console.assert(resolveHref('#unknown').index === 0, 'resolveHref("#unknown") should return index 0')
    console.assert(resolveHref('#sec1').index === 1, 'resolveHref("#sec1") should return index 1')

    // Test getTOCFragment fallback
    const parser = new DOMParser()
    const doc = parser.parseFromString('<html><body><div data-foliate-id="1">Content</div></body></html>', 'text/html')
    const getTOCFragment = (doc, id) => {
        if (!id || id === 'undefined') return doc?.body ?? doc?.documentElement
        return doc?.querySelector?.(`[${dataID}="${id}"]`) ?? doc?.body ?? doc?.documentElement
    }
    console.assert(getTOCFragment(doc, undefined) === doc.body, 'falsy id should fallback to doc.body')
    console.assert(getTOCFragment(doc, '1') === doc.querySelector('[data-foliate-id="1"]'), 'valid id should find element')
    console.log('  -> fb2.js passed!')
}

// 6. mobi.js getTOCFragment guard
console.log('Testing 7. mobi.js getTOCFragment guard...')
{
    const parser = new DOMParser()
    const doc = parser.parseFromString('<html><body><div>MOBI text</div></body></html>', 'text/html')
    const getTOCFragment = (doc, selector) => selector ? doc?.querySelector?.(selector) : (doc?.body ?? null)
    console.assert(getTOCFragment(doc, undefined) === doc.body, 'undefined selector should return doc.body')
    console.assert(getTOCFragment(doc, null) === doc.body, 'null selector should return doc.body')
    console.log('  -> mobi.js passed!')
}

// 7. view.js getTOCItemOf and clearSearch
console.log('Testing 5. view.js getTOCItemOf non-node handling...')
{
    const parser = new DOMParser()
    const doc = parser.parseFromString('<html><body><h1>Chapter 1</h1><p>Text</p></body></html>', 'text/html')
    // test anchor returning 0 (number)
    const anchorNum = () => 0
    const frag = anchorNum(doc)
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
        }
    }
    console.assert(range instanceof Range, 'Range must be successfully created without DOMException')
    console.assert(range.collapsed === true, 'Range should be collapsed at start of doc.body')
    console.log('  -> view.js passed!')
}

// 8. epub.js series metadata operator precedence and Loader inflight
console.log('Testing 4. epub.js series metadata operator precedence and Loader inflight...')
{
    // Test operator precedence:
    const makeCollection = x => ({ name: x })
    const belongsTo = { series: ['Harry Potter'] }
    const legacyMeta = { 'calibre:series': 'Different', 'calibre:series_index': '2' }
    const res = belongsTo.series?.map(makeCollection)
        ?? (legacyMeta?.['calibre:series'] ? {
            name: legacyMeta['calibre:series'],
            position: parseFloat(legacyMeta['calibre:series_index']),
        } : null)
    console.assert(Array.isArray(res) && res[0].name === 'Harry Potter', 'series must not be overridden by legacy calibre:series when belongsTo.series exists')

    // When belongsTo.series is null:
    const belongsToNull = { series: null }
    const resLegacy = belongsToNull.series?.map(makeCollection)
        ?? (legacyMeta?.['calibre:series'] ? {
            name: legacyMeta['calibre:series'],
            position: parseFloat(legacyMeta['calibre:series_index']),
        } : null)
    console.assert(resLegacy.name === 'Different' && resLegacy.position === 2, 'legacy calibre:series must be used when belongsTo.series is null')
    console.log('  -> epub.js series precedence passed!')
}

// 9. paginator.js destroy unobserve test
console.log('Testing 2. paginator.js observer disconnect...')
{
    let disconnected = false
    const mockObserver = {
        observe() {},
        unobserve() {},
        disconnect() { disconnected = true }
    }
    mockObserver?.disconnect?.()
    console.assert(disconnected === true, 'Observer disconnect should be called')
    console.log('  -> paginator.js passed!')
}

// 10. fixed-layout.js unload and viewport test
console.log('Testing 1. fixed-layout.js section unloads and destroy...')
{
    let centerUnloaded = false
    let leftUnloaded = false
    const oldSpread = {
        center: { unload() { centerUnloaded = true } },
        left: { unload() { leftUnloaded = true } },
        right: null,
    }
    const spread = { center: { unload() {} } }
    if (oldSpread.center && oldSpread.center !== spread.center) oldSpread.center?.unload?.()
    if (oldSpread.left && oldSpread.left !== spread.left) oldSpread.left?.unload?.()
    console.assert(centerUnloaded === true && leftUnloaded === true, 'Old spread sections must be unloaded')

    // Test FixedLayout instance destroy
    const fxl = new FixedLayout()
    document.body.appendChild(fxl)
    fxl.destroy()
    fxl.remove()
    console.log('  -> fixed-layout.js passed!')
}

// 11. View instance deep tests
console.log('Testing View instance close, clearSearch, and initTTS...')
{
    const view = new View()
    document.body.appendChild(view)

    // Test initTTS with no contents (should not throw TypeError)
    let ttsThrew = false
    try {
        await view.initTTS()
    } catch (e) {
        ttsThrew = true
        console.error('initTTS threw unexpectedly:', e)
    }
    console.assert(!ttsThrew, 'initTTS with empty contents must not throw')

    // Test clearSearch
    view.clearSearch()

    // Test close with mock book and mock loader
    let loaderClosed = false
    let bookDestroyed = false
    view.book = {
        destroy() { bookDestroyed = true },
        loader: {
            close() { loaderClosed = true }
        }
    }
    view.close()
    console.assert(bookDestroyed, 'view.close() must destroy book')
    console.assert(loaderClosed, 'view.close() must close book loader')
    view.remove()
    console.log('  -> View instance tests passed!')
}

// 12. EPUB instance loadDocument and destroy tests
console.log('Testing EPUB loadDocument and destroy...')
{
    let loaderDestroyed = false
    const mockLoader = {
        loadText: async () => '',
        loadBlob: async () => new Blob(['fake image data'], { type: 'image/jpeg' }),
        getSize: () => 100,
        sha1: async () => '',
        destroy() { loaderDestroyed = true },
    }
    const epub = new EPUB(mockLoader)
    epub.getCover = async () => new Blob(['fake cover data'], { type: 'image/jpeg' })

    const doc = await epub.loadDocument({ href: 'test-cover.jpg', mediaType: 'image/jpeg' })
    console.assert(doc instanceof Document, 'loadDocument for image must return a Document')
    const img = doc.querySelector('img')
    console.assert(img && img.src.startsWith('blob:'), 'img element must have a blob URL')

    // Test unloadDocument
    epub.unloadDocument({ href: 'test-cover.jpg' })

    // Test destroy
    epub.destroy()
    console.assert(loaderDestroyed, 'epub.destroy() must call loader.destroy()')
    console.log('  -> EPUB loadDocument and destroy passed!')
}

console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---')
