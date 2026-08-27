const http = require('http')
const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const ROOT = 'C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader'

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url.split('?')[0])
    if (filePath.endsWith('/') || filePath === ROOT) filePath = path.join(ROOT, 'index.html')

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404)
            return res.end('Not found')
        }
        const ext = path.extname(filePath)
        const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime })
        res.end(data)
    })
})

const PORT = 9091
server.listen(PORT, async () => {
    console.log(`Auditor test server running on ${PORT}`)

    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })

    const errors = []
    const warnings = []
    page.on('dialog', async dialog => {
        console.log('Dialog dismissed:', dialog.message())
        await dialog.accept()
    })
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text())
        if (msg.type() === 'warn') warnings.push(msg.text())
    })
    page.on('pageerror', err => errors.push(err.toString()))

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.app != null && typeof window.app.loadSampleBooks === 'function')

    console.log('--- TEST 1: Load Samples & Bookshelf Views ---')
    await page.evaluate(async () => {
        const app = window.app
        await app.loadSampleBooks()
    })
    await new Promise(r => setTimeout(r, 2500))

    const test1 = await page.evaluate(async () => {
        const app = window.app
        const shelfBtn = document.getElementById('btn-view-shelf')
        const gridBtn = document.getElementById('btn-view-grid')
        const listBtn = document.getElementById('btn-view-list')

        gridBtn?.click()
        await app.refreshBookshelf()
        const gridCount = document.querySelectorAll('.jane-book-card').length

        listBtn?.click()
        await app.refreshBookshelf()
        const listCount = document.querySelectorAll('.jane-table-row').length

        shelfBtn?.click()
        await app.refreshBookshelf()
        const shelfBooks = document.querySelectorAll('.skeuo-book').length

        return {
            shelfBooks,
            gridCount,
            listCount
        }
    })
    console.log('Test 1 Bookshelf result:', test1)

    console.log('--- TEST 2: WeChat Read Stats Dashboard ---')
    const test2 = await page.evaluate(async () => {
        const statsTab = document.querySelector('.jane-sidebar .nav-item[data-category="stats"]')
        statsTab?.click()
        await new Promise(r => setTimeout(r, 600))

        const container = document.getElementById('stats-dashboard-container')
        const isVisible = container && window.getComputedStyle(container).display !== 'none'
        const heroTime = document.getElementById('stats-hero-time')?.innerText

        // Test week / month / year tabs
        const weekBtn = document.querySelector('.stats-tab-btn[data-mode="week"]')
        weekBtn?.click()
        await new Promise(r => setTimeout(r, 300))
        const weekBars = document.querySelectorAll('#stats-distribution-chart .chart-col').length

        const allTab = document.querySelector('.jane-sidebar .nav-item[data-category="all"]')
        allTab?.click()

        return {
            isVisible,
            heroTime,
            weekBars
        }
    })
    console.log('Test 2 Stats Dashboard result:', test2)

    console.log('--- TEST 3: Open Celan Book & Test Selection Toolbar ---')
    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)
    await new Promise(r => setTimeout(r, 2000))

    // Open Celan book
    await page.evaluate(async () => {
        const books = await window.db.getAllBooks()
        const celan = books.find(b => b.title && b.title.includes('策兰'))
        if (celan) await window.app.openBook(celan.id)
    })
    await new Promise(r => setTimeout(r, 4000))

    const test3 = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No foliate-view' }

        await fv.goTo(3) // Jump to poem section
        await new Promise(r => setTimeout(r, 1800))

        const contents = fv.renderer?.getContents?.() || []
        const item = contents.find(c => c.index === 3) || contents[0]
        if (!item || !item.doc) return { error: 'No doc loaded' }

        const doc = item.doc
        const ps = Array.from(doc.querySelectorAll('p'))
        const p1 = ps.find(p => p.textContent.includes('没人替我照应'))

        if (!p1) return { error: 'p1 not found in doc' }

        const range = doc.createRange()
        range.setStart(p1.firstChild, 0)
        range.setEnd(p1.firstChild, p1.firstChild.nodeValue.length)

        const sel = doc.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        // Trigger mouseup event
        doc.dispatchEvent(new Event('selectionchange'))
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

        await new Promise(r => setTimeout(r, 300))

        const popup = document.getElementById('selection-popup')
        const popupDisplay = popup ? window.getComputedStyle(popup).display : 'none'
        const popupActive = popup?.classList.contains('active')

        // Test creating highlight by clicking pink color dot
        const colorDot = document.querySelector('#selection-popup .color-dot[data-color="#f43f5e"]') || document.querySelector('#selection-popup .color-dot')
        if (colorDot) colorDot.click()

        await new Promise(r => setTimeout(r, 600))

        // Check if highlight was saved to db
        const highlights = await window.db.getHighlightsByBook(window.app.currentBookId)

        return {
            bookTitle: window.app.currentBookData?.title,
            popupDisplay,
            popupActive,
            highlightCount: highlights.length,
            latestHighlightText: highlights[0]?.text
        }
    })
    console.log('Test 3 Celan Highlighting result:', test3)

    console.log('--- TEST 4: Quote Card Generator ---')
    const test4 = await page.evaluate(async () => {
        await window.app.openQuoteCardModal('那些戴着锈指环的手，像荆棘开了花。', '保罗·策兰诗全集')
        const backdrop = document.getElementById('quote-card-backdrop')
        const isVisible = backdrop && window.getComputedStyle(backdrop).display !== 'none'
        const canvas = document.querySelector('#quote-card-canvas-wrap canvas')
        const hasCanvas = !!canvas && canvas.width > 0
        window.app.closeQuoteCardModal()
        return { isVisible, hasCanvas, canvasWidth: canvas?.width, canvasHeight: canvas?.height }
    })
    console.log('Test 4 Quote Card result:', test4)

    console.log('--- TEST 5: PDF File Loading & Spread/Zoom Check ---')
    const pdfPath = 'C:\\Users\\Administrator\\.gemini\\antigravity\\scratch\\universal-reader\\samples\\sample_doc.pdf'
    if (fs.existsSync(pdfPath)) {
        await fileInput.uploadFile(pdfPath)
        await new Promise(r => setTimeout(r, 2000))
        await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const pdf = books.find(b => b.format === 'pdf' || (b.title && b.title.includes('PDF')))
            if (pdf) await window.app.openBook(pdf.id)
        })
        await new Promise(r => setTimeout(r, 3000))

        const test5 = await page.evaluate(() => {
            const fv = document.querySelector('foliate-view')
            const zoomBar = document.getElementById('pdf-zoom-control-bar')
            return {
                isFixedLayout: fv?.isFixedLayout,
                zoomBarDisplay: zoomBar ? window.getComputedStyle(zoomBar).display : 'none',
                rendererTag: fv?.renderer?.tagName
            }
        })
        console.log('Test 5 PDF result:', test5)
    }

    console.log('\n--- AUDIT SUMMARY ---')
    console.log('Errors caught:', errors.length)
    if (errors.length > 0) console.log('Errors:\n', errors)
    console.log('Warnings caught:', warnings.length)

    await browser.close()
    server.close()
    process.exit(0)
})
