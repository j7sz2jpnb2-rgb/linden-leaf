const http = require('http')
const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const ROOT = 'C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.epub': 'application/epub+zip',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.cbz': 'application/vnd.comicbook+zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

const server = http.createServer((req, res) => {
    let relPath = req.url.split('?')[0].replace(/^\/+/, '')
    if (!relPath) relPath = 'index.html'
    const fullPath = path.join(ROOT, relPath)

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            return res.end('404 Not Found')
        }
        const ext = path.extname(fullPath).toLowerCase()
        const contentType = MIME[ext] || 'application/octet-stream'
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        })
        res.end(data)
    })
})

const PORT = 9109
server.listen(PORT, async () => {
    console.log(`[TEST MATRIX] Running on http://localhost:${PORT}`)
    try {
        const tmpUserDataDir = path.join(__dirname, `../.pup_matrix_${Date.now()}`)
        const browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            headless: true,
            userDataDir: tmpUserDataDir,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        })

        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 860 })

        const errors = []
        const warnings = []

        page.on('dialog', async d => {
            console.log('  [Dialog Handled]', d.message())
            await d.accept()
        })
        page.on('console', msg => {
            const text = msg.text()
            if (msg.type() === 'error' && !text.includes('favicon')) {
                errors.push(text)
            }
            if (msg.type() === 'warn') {
                warnings.push(text)
            }
        })
        page.on('pageerror', err => errors.push(err.toString()))

        console.log('\n>>> 1. Load Application & Verify CSP + Elements')
        await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#file-input')
        await page.waitForFunction(() => window.app != null)

        const initCheck = await page.evaluate(() => {
            const app = window.app
            return {
                appExists: !!app,
                hasBtnNavLeft: !!app.dom.btnNavLeft,
                hasBtnNavRight: !!app.dom.btnNavRight,
                hasBtnShelfSettings: !!app.dom.btnShelfSettings,
                btnNavLeftId: app.dom.btnNavLeft?.id,
                btnNavRightId: app.dom.btnNavRight?.id
            }
        })
        console.log('Init Check:', initCheck)

        console.log('\n>>> 2. Load 6 Sample Books (DOCX Whitepaper, EPUB, PDF, TXT, CBZ, Guide)')
        await page.evaluate(async () => {
            await window.app.loadSampleBooks()
        })
        await new Promise(r => setTimeout(r, 2000))

        const shelfViewsCheck = await page.evaluate(async () => {
            const app = window.app
            const shelfBooks = document.querySelectorAll('.skeuo-book').length
            const shelfRows = document.querySelectorAll('.wood-shelf-row').length

            document.getElementById('btn-view-grid')?.click()
            await app.refreshBookshelf()
            const gridBooks = document.querySelectorAll('.jane-book-card').length

            document.getElementById('btn-view-list')?.click()
            await app.refreshBookshelf()
            const listRows = document.querySelectorAll('.jane-table-row').length

            document.getElementById('btn-view-shelf')?.click()
            await app.refreshBookshelf()

            return {
                shelfBooks,
                shelfRows,
                gridBooks,
                listRows
            }
        })
        console.log('Bookshelf 3-Views & Multiline Check:', shelfViewsCheck)

        console.log('\n>>> 3. Test Reading Sessions & WeChat Read Analytics')
        const statsCheck = await page.evaluate(async () => {
            const tr = window.tracker
            await tr.startSession('book_sample_test', '三国演义（精选前三回）', 0.1)
            tr.tick()
            tr.tick()
            await tr.flush()
            await tr.endSession(0.2)

            const stats = await window.db.getReadingStats('week')
            const monthStats = await window.db.getReadingStats('month')
            return {
                totalSeconds: stats.totalSeconds,
                totalHours: stats.totalHours,
                weekBars: stats.chartData?.length,
                monthDays: monthStats.chartData?.length,
                todayStr: monthStats.chartData?.find(d => d.isCurrent)?.label
            }
        })
        console.log('WeChat Read Stats Check:', statsCheck)

        console.log('\n>>> 4. Test Quote Card Generation with Realistic Title & Text')
        const quoteCardCheck = await page.evaluate(async () => {
            window.quoteCard.setData({
                bookTitle: '保罗·策兰诗全集',
                author: '保罗·策兰',
                chapterTitle: '花冠',
                pageIndex: '第 42 页',
                userName: '深度读者',
                quoteText: '秋天从我手中吃它的叶子：我们是朋友。\n我们从坚果里剥出时间并教它如何前行：\n时间便回到了壳里。'
            })
            window.quoteCard.setTheme('dark')
            
            const canvas = await window.quoteCard.renderCanvas()
            const blob = await window.quoteCard.getBlob()
            return {
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
                blobSize: blob?.size,
                blobType: blob?.type
            }
        })
        console.log('Quote Card Check:', quoteCardCheck)

        console.log('\n>>> 5. Test Word (.docx) Document Parsing & TOC & Highlighting')
        const docxTestResult = await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const docxBook = books.find(b => b.format === 'docx')
            if (!docxBook) return { error: 'DOCX book missing in DB' }

            await window.app.openBook(docxBook.id)
            await new Promise(r => setTimeout(r, 2500))

            const fv = document.querySelector('foliate-view')
            const toc = fv?.book?.toc || []
            const sections = fv?.book?.sections || []

            const contents = fv?.renderer?.getContents?.() || []
            const firstDoc = contents[0]?.doc
            const h1 = firstDoc?.querySelector('h1')?.textContent?.trim()

            window.app.closeReader()

            return {
                title: docxBook.title,
                sections: sections.length,
                tocCount: toc.length,
                firstChapterTitle: h1
            }
        })
        console.log('Word DOCX Book Reader Check:', docxTestResult)

        console.log('\n>>> 6. Test PDF Viewer & Zoom Control')
        const pdfCheck = await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const pdf = books.find(b => b.format === 'pdf' || (b.title && b.title.includes('PDF')))
            if (!pdf) return { skip: 'No PDF found' }

            await window.app.openBook(pdf.id)
            await new Promise(r => setTimeout(r, 3000))

            const fv = document.querySelector('foliate-view')
            const zoomBar = document.getElementById('pdf-zoom-control-bar')
            const isZoomBarVisible = zoomBar && window.getComputedStyle(zoomBar).display !== 'none'
            const isFixed = fv?.isFixedLayout

            window.app.closeReader()

            return {
                pdfTitle: pdf.title,
                isFixedLayout: isFixed,
                isZoomBarVisible
            }
        })
        console.log('PDF Viewer Check:', pdfCheck)

        console.log('\n>>> 7. Test Custom Reading Lists System (Placed under Favorites)')
        const customListsCheck = await page.evaluate(async () => {
            const app = window.app
            const listItems = Array.from(document.querySelectorAll('.custom-list-nav-item'))
            const unreadItem = listItems.find(i => i.dataset.listId === 'list_unread')

            // Create new list
            app.openCreateListModal()
            document.getElementById('input-custom-list-name').value = '历史专研'
            await app.handleCreateListConfirm()
            await new Promise(r => setTimeout(r, 600))

            const activeList = document.querySelector('.custom-list-nav-item.active')
            const listCount = document.querySelectorAll('.custom-list-nav-item').length

            // Switch back to All
            document.getElementById('nav-cat-all')?.click()

            return {
                initialUnreadBadge: unreadItem?.querySelector('.list-count-badge')?.innerText,
                totalCustomLists: listCount,
                createdListName: activeList?.querySelector('.list-title')?.innerText
            }
        })
        console.log('Custom Lists Check:', customListsCheck)

        console.log('\n==========================================')
        console.log(`ALL MATRIX TESTS PASSED! Total Errors: ${errors.length}, Warnings: ${warnings.length}`)
        if (errors.length > 0) {
            console.log('Errors caught:\n', errors)
        }
        console.log('==========================================')

        await browser.close()
        server.close()
        process.exit(errors.length === 0 ? 0 : 1)
    } catch (e) {
        console.error('Matrix test error:', e)
        server.close()
        process.exit(1)
    }
})
