import assert from 'node:assert/strict'
globalThis.HTMLElement ??= class {}
globalThis.NodeFilter ??= { SHOW_ELEMENT:1, SHOW_TEXT:4, FILTER_ACCEPT:1, FILTER_REJECT:2, FILTER_SKIP:3 }
globalThis.customElements ??= { get(){},define(){} }
const {AiSidebarController} = await import('../js/ai-sidebar-controller.js')
const oldDocument=globalThis.document
globalThis.document={createElement(){return {className:'',dataset:{},innerHTML:'',querySelector(){return null}}}}
try {
    const controller=Object.create(AiSidebarController.prototype)
    const messages={querySelector(){return null},appendChild(){},scrollHeight:0}
    const audit={innerHTML:''}
    controller.dom={aiChatMessages:messages,aiAuditLogTableContainer:audit}
    const hostile='<svg onload="alert(1)"></svg>'
    const message=controller.appendMessageToUI({id:'probe',role:'assistant',content:'Normal answer',status:'completed',usage:{total_tokens:hostile}})
    assert.ok(!message.innerHTML.includes('<svg'))
    assert.ok(message.innerHTML.includes('&lt;svg'))
    const normal=controller.appendMessageToUI({id:'normal',role:'assistant',content:'Normal answer',status:'completed',usage:{total_tokens:123}})
    assert.ok(normal.innerHTML.includes('123 tokens'))
    controller.renderAuditTable([{timestamp:hostile,durationMs:hostile,totalTokens:hostile,status:'completed'}])
    assert.ok(!audit.innerHTML.includes('<svg'))
    console.log('[PASS] AI message usage and audit metadata stay text with hostile input; normal token display preserved')

    const makeMockElement = (tag = 'div') => {
        let htmlValue = ''
        const el = {
            tagName: tag.toUpperCase(),
            className: '',
            dataset: {},
            style: {},
            get innerHTML() { return htmlValue },
            set innerHTML(v) {
                htmlValue = String(v ?? '')
                this.children = []
            },
            innerText: '',
            textContent: '',
            value: '',
            children: [],
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
            setAttribute(k, v) { this[k] = v },
            addEventListener() {},
            removeEventListener() {},
            appendChild(child) {
                if (child?.tagName === 'FRAGMENT') {
                    this.children.push(...child.children)
                } else {
                    this.children.push(child)
                }
                return child
            },
            querySelector() { return null },
            querySelectorAll() { return [] },
        }
        return el
    }
    const collectDatasetDates = (root) => {
        const out = []
        const walk = (node) => {
            if (!node) return
            if (node.dataset?.date) out.push(node.dataset.date)
            if (Array.isArray(node.children)) node.children.forEach(walk)
        }
        walk(root)
        return out
    }

    const storeData = {
        books: [],
        highlights: [],
        reading_sessions: [],
        bookmarks: [],
        settings: [],
        custom_lists: [],
        deleted_records: [],
        pdf_drawings: [],
        book_files: [],
    }
    let readingSessionsHook = null
    const makeReq = (result) => {
        const req = { result, error: null, onsuccess: null, onerror: null }
        return req
    }
    const mockDb = {
        objectStoreNames: { contains: (name) => Object.prototype.hasOwnProperty.call(storeData, name) },
        createObjectStore: () => ({ createIndex() {} }),
        transaction(storeNames) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames]
            const tx = {
                error: null,
                oncomplete: null,
                onerror: null,
                onabort: null,
                objectStore(name) {
                    const rows = storeData[name] || []
                    return {
                        createIndex() {},
                        indexNames: { contains: () => true },
                        getAll() {
                            const req = makeReq(rows.map(item => ({ ...item })))
                            const fire = () => { if (typeof req.onsuccess === 'function') req.onsuccess({ target: req }) }
                            if (name === 'reading_sessions' && typeof readingSessionsHook === 'function') {
                                Promise.resolve(readingSessionsHook()).then(fire)
                            } else {
                                queueMicrotask(fire)
                            }
                            return req
                        },
                        get(id) {
                            const found = rows.find(item => item.id === id) || null
                            const req = makeReq(found ? { ...found } : null)
                            queueMicrotask(() => { if (typeof req.onsuccess === 'function') req.onsuccess({ target: req }) })
                            return req
                        },
                    }
                },
            }
            if (!names.length) throw new Error('Empty transaction')
            return tx
        },
    }

    const oldWindow = globalThis.window
    const oldLocalStorage = globalThis.localStorage
    const oldIndexedDB = globalThis.indexedDB
    const oldBroadcastChannel = globalThis.BroadcastChannel
    const byId = new Map()
    globalThis.document = {
        getElementById: (id) => byId.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createElement: makeMockElement,
        createDocumentFragment: () => makeMockElement('fragment'),
        body: makeMockElement('body'),
        documentElement: Object.assign(makeMockElement('html'), { dataset: {} }),
    }
    globalThis.window = globalThis
    globalThis.window.addEventListener ??= () => {}
    globalThis.window.removeEventListener ??= () => {}
    globalThis.window.innerWidth ??= 1200
    globalThis.window.innerHeight ??= 800
    globalThis.BroadcastChannel = class {
        addEventListener() {}
        postMessage() {}
        close() {}
    }
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
    globalThis.indexedDB = {
        open() {
            const req = { result: mockDb, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }
            queueMicrotask(() => { if (typeof req.onsuccess === 'function') req.onsuccess({ target: req }) })
            return req
        },
    }

    try {
        const db = await import('../js/db.js')
        const { AnnotationsDrawerController } = await import('../js/annotations-drawer-controller.js')
        const { mobileShell } = await import('../js/mobile-shell.js')
        const { renderCalendarHeatmap } = await import('../js/stats-heatmap.js')
        const { StatsViewController } = await import('../js/stats-view-controller.js')

        const hostileAttrId = 'book-evil" onfocus="alert(1)'
        const hostileSvg = '<svg onload="alert(1)"></svg>'
        const hostileImg = '<img src=x onerror=alert(1)>'
        storeData.books = [
            {
                id: hostileAttrId,
                title: hostileImg,
                author: hostileSvg,
                cover: 'javascript:alert(1)',
                lastReadAt: Date.now(),
                progress: { fraction: 0.4 },
            },
            {
                id: 'rec-evil" onclick="alert(2)',
                title: hostileSvg,
                author: 'Hostile Rec Author',
                cover: 'javascript:alert(2)',
                lastReadAt: Date.now() - 5000,
                progress: { fraction: 0.1 },
            },
            {
                id: '__proto__',
                title: 'Proto Book',
                author: 'Safe Author',
                cover: 'https://example.com/safe-cover.jpg',
                lastReadAt: Date.now() - 10000,
                progress: { fraction: 0.2 },
            },
        ]
        storeData.highlights = [
            {
                id: 'hl-hostile',
                bookId: hostileAttrId,
                text: hostileSvg,
                note: '<b>note</b>',
                chapterTitle: '<script>x</script>',
                color: 'yellow',
                createdAt: 2000,
            },
            {
                id: 'hl-proto',
                bookId: '__proto__',
                text: 'Proto note text',
                note: '',
                chapterTitle: 'Chapter 1',
                color: 'yellow',
                createdAt: 1000,
            },
        ]

        const shelfList = makeMockElement()
        const shelfBadge = makeMockElement('span')
        const shelfSelect = makeMockElement('select')
        byId.set('shelf-notes-list', shelfList)
        byId.set('shelf-notes-stats-badge', shelfBadge)
        byId.set('select-notes-book-filter', shelfSelect)

        const drawer = Object.create(AnnotationsDrawerController.prototype)
        drawer.shelfNotesFilter = { bookId: 'all', color: 'all', query: '' }
        drawer.dom = {}
        await drawer.renderShelfNotesList()

        assert.ok(shelfSelect.innerHTML.includes('value="book-evil&quot; onfocus=&quot;alert(1)"'))
        assert.ok(!shelfSelect.innerHTML.includes('onfocus="alert(1)"'))
        assert.ok(shelfSelect.innerHTML.includes('Proto Book (1)'))
        const renderedCardsHtml = shelfList.innerHTML + shelfList.children.map(c => c.innerHTML).join('\n')
        assert.ok(!renderedCardsHtml.includes('<svg onload='))
        assert.ok(!renderedCardsHtml.includes('<img src=x'))
        assert.ok(!renderedCardsHtml.includes('<script>x</script>'))
        assert.ok(renderedCardsHtml.includes('&lt;svg onload=&quot;alert(1)&quot;&gt;'))
        assert.ok(renderedCardsHtml.includes('&lt;img src=x onerror=alert(1)&gt;'))
        console.log('[PASS] Shelf notes dropdown & cards escape bookId/title/quote attributes and resist __proto__')

        const homeCards = makeMockElement()
        const homeGreeting = makeMockElement('h1')
        byId.set('mobile-home-cards-container', homeCards)
        byId.set('mobile-home-greeting', homeGreeting)
        await mobileShell.renderHomeTab()

        assert.ok(homeCards.innerHTML.includes('data-rec-id="rec-evil&quot; onclick=&quot;alert(2)"'))
        assert.ok(homeCards.innerHTML.includes('data-book-id="book-evil&quot; onfocus=&quot;alert(1)"'))
        assert.ok(!homeCards.innerHTML.includes('onfocus="alert(1)"'))
        assert.ok(!homeCards.innerHTML.includes('onclick="alert(2)"'))
        assert.ok(!homeCards.innerHTML.includes('javascript:alert(1)'))
        assert.ok(!homeCards.innerHTML.includes('javascript:alert(2)'))
        assert.ok(!homeCards.innerHTML.includes('<svg onload='))
        assert.ok(!homeCards.innerHTML.includes('<img src=x'))
        assert.ok(homeCards.innerHTML.includes('https://example.com/safe-cover.jpg'))
        console.log('[PASS] MobileShell home hero/recommendations escape IDs/titles and block javascript: covers')

        db.invalidateReadingStatsCache()
        const heatmapContainer = makeMockElement()
        storeData.reading_sessions = [
            { id: 's-2025', bookId: '__proto__', date: '2025-02-02', durationSeconds: 1800, activeDurationSeconds: 1800, startTime: Date.parse('2025-02-02T10:00:00Z') },
            { id: 's-2026', bookId: '__proto__', date: '2026-05-01', durationSeconds: 2400, activeDurationSeconds: 2400, startTime: Date.parse('2026-05-01T10:00:00Z') },
        ]
        let sessionCallIndex = 0
        readingSessionsHook = () => {
            sessionCallIndex += 1
            const idx = sessionCallIndex
            return idx === 1 ? new Promise(r => setTimeout(r, 60)) : new Promise(r => setTimeout(r, 5))
        }
        const p2025 = renderCalendarHeatmap(heatmapContainer, 2025)
        const p2026 = renderCalendarHeatmap(heatmapContainer, 2026)
        await Promise.all([p2025, p2026])
        const directDates = collectDatasetDates(heatmapContainer)
        assert.ok(directDates.includes('2026-05-01'))
        assert.ok(!directDates.includes('2025-02-02'))
        const renderedCalendar = heatmapContainer.children[0]
        await renderCalendarHeatmap(heatmapContainer, 2026)
        assert.equal(heatmapContainer.children[0], renderedCalendar, 'The current calendar should be reused')
        assert.equal(sessionCallIndex, 1, 'Concurrent and repeated renders share one session read')

        db.invalidateReadingStatsCache()
        sessionCallIndex = 0
        const statsSubtitle = makeMockElement('span')
        const statsHeatmapEl = makeMockElement()
        const statsDayDetails = makeMockElement()
        const statsSvc = Object.create(StatsViewController.prototype)
        statsSvc._statsReqId = 0
        statsSvc.statsViewMode = 'year'
        statsSvc.statsYear = 2025
        statsSvc.statsMonth = 1
        statsSvc._activeHeatmapDay = { dateStr: '2025-02-02', payload: { totalSeconds: 1800, formattedTime: '30m', books: [], noteCount: 0 } }
        statsSvc.app = { settings: { enableReadingGoals: false }, dom: {} }
        statsSvc.dom = {
            statsDashboardContainer: makeMockElement(),
            statsHeatmapYearSubtitle: statsSubtitle,
            statsCalendarHeatmap: statsHeatmapEl,
            statsHeatmapDayDetails: statsDayDetails,
        }
        const dash2025 = statsSvc.renderStatsDashboard()
        statsSvc.statsYear = 2026
        const dash2026 = statsSvc.renderStatsDashboard()
        await Promise.all([dash2025, dash2026])
        const dashDates = collectDatasetDates(statsHeatmapEl)
        assert.ok(statsSubtitle.innerText.includes('2026'), `Expected 2026 subtitle, got: ${statsSubtitle.innerText}`)
        assert.ok(dashDates.includes('2026-05-01'))
        assert.ok(!dashDates.includes('2025-02-02'))
        assert.equal(statsDayDetails.style.display, 'none')
        console.log('[PASS] Fast year switch 2025->2026 discards stale 2025 heatmap and keeps 2026 cleanly')
    } finally {
        if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow
        if (oldLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldLocalStorage
        if (oldIndexedDB === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = oldIndexedDB
        if (oldBroadcastChannel === undefined) delete globalThis.BroadcastChannel; else globalThis.BroadcastChannel = oldBroadcastChannel
    }
} finally {if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument}
