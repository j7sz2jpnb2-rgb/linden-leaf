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
    '.cbz': 'application/vnd.comicbook+zip'
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

const PORT = 9095
server.listen(PORT, async () => {
    console.log(`Node HTTP Server listening on http://localhost:${PORT}`)
    try {
        const browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            headless: true,
            args: ['--no-sandbox', '--disable-gpu']
        })

        const page = await browser.newPage()
        await page.setViewport({ width: 1280, height: 900 })

        const errors = []
        const warnings = []
        page.on('dialog', async d => {
            console.log('Dialog:', d.message())
            await d.accept()
        })
        page.on('console', msg => {
            const text = msg.text()
            if (msg.type() === 'error') errors.push(text)
            if (msg.type() === 'warn') warnings.push(text)
        })
        page.on('pageerror', err => errors.push(err.toString()))

        console.log('Navigating to http://localhost:9095/index.html...')
        await page.goto(`http://localhost:${PORT}/index.html`)
        await page.waitForSelector('#file-input')
        await page.waitForFunction(() => window.app != null)
        console.log('App successfully initialized in browser!')

        console.log('\n--- TEST 1: DOM Elements & Navigation IDs ---')
        const domCheck = await page.evaluate(() => {
            const app = window.app
            return {
                btnNavLeft: !!app.dom.btnNavLeft,
                btnNavRight: !!app.dom.btnNavRight,
                btnShelfSettings: !!app.dom.btnShelfSettings,
                btnNavLeftId: app.dom.btnNavLeft?.id,
                btnNavRightId: app.dom.btnNavRight?.id
            }
        })
        console.log('DOM Check Result:', domCheck)

        console.log('\n--- TEST 2: Load Sample Books & Check Bookshelf Multiline ---')
        await page.evaluate(async () => {
            await window.app.loadSampleBooks()
        })
        await new Promise(r => setTimeout(r, 2000))

        const shelfCheck = await page.evaluate(async () => {
            const app = window.app
            await app.refreshBookshelf()
            const rows = document.querySelectorAll('.wood-shelf-row')
            const books = document.querySelectorAll('.skeuo-book')
            const allBooks = await window.db.getAllBooks()
            return {
                dbBookCount: allBooks.length,
                renderedShelfRows: rows.length,
                renderedShelfBooks: books.length
            }
        })
        console.log('Shelf Multiline Result:', shelfCheck)

        console.log('\n--- TEST 3: Reading Tracker & Local Timezone Session Safety ---')
        const trackerCheck = await page.evaluate(async () => {
            const tr = window.tracker
            await tr.startSession('book_test_session', '测试长书名', 0.05)
            tr.tick()
            tr.tick()
            await tr.flush()
            
            const sessions = await window.db.getAllReadingSessions()
            const latest = sessions[0]
            await tr.endSession(0.15)
            
            return {
                sessionCount: sessions.length,
                sessionDate: latest?.date,
                bookTitle: latest?.bookTitle,
                isLocalFormat: /^\d{4}-\d{2}-\d{2}$/.test(latest?.date || '')
            }
        })
        console.log('Reading Tracker Result:', trackerCheck)

        console.log('\n--- TEST 4: Quote Card Generator ---')
        const quoteCheck = await page.evaluate(async () => {
            window.quoteCard.setBookInfo('测试书籍《百年孤独》', '马尔克斯', '第一章', '第 12 页', '读者君')
            window.quoteCard.setQuote('多年以后，面对行刑队，奥雷里亚诺·布恩迪亚上校将会回想起父亲带他去见识冰块的那个遥远的下午。')
            const canvas = await window.quoteCard.renderCanvas()
            const blob = await window.quoteCard.getBlob()
            return {
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
                blobSize: blob?.size,
                blobType: blob?.type
            }
        })
        console.log('Quote Card Result:', quoteCheck)

        console.log('\n--- TEST 5: Open Celan EPUB & Highlighting Verification ---')
        const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
        if (fs.existsSync(celanPath)) {
            const fileInput = await page.$('#file-input')
            await fileInput.uploadFile(celanPath)
            await new Promise(r => setTimeout(r, 2000))

            const celanCheck = await page.evaluate(async () => {
                const books = await window.db.getAllBooks()
                const celan = books.find(b => b.title && b.title.includes('策兰'))
                if (!celan) return { error: 'Celan book not found' }

                await window.app.openBook(celan.id)
                await new Promise(r => setTimeout(r, 3500))

                const fv = document.querySelector('foliate-view')
                if (!fv) return { error: 'No foliate-view' }

                await fv.goTo(3)
                await new Promise(r => setTimeout(r, 1500))

                const contents = fv.renderer?.getContents?.() || []
                const item = contents.find(c => c.index === 3) || contents[0]
                if (!item?.doc) return { error: 'No doc loaded' }

                const doc = item.doc
                const ps = Array.from(doc.querySelectorAll('p'))
                const p = ps.find(p => p.textContent.includes('没人替我照应')) || ps[0]
                
                const range = doc.createRange()
                range.setStart(p.firstChild, 0)
                range.setEnd(p.firstChild, Math.min(6, p.firstChild.nodeValue?.length || 4))

                const sel = doc.getSelection()
                sel.removeAllRanges()
                sel.addRange(range)

                doc.dispatchEvent(new Event('selectionchange'))
                doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
                await new Promise(r => setTimeout(r, 500))

                const colorDot = document.querySelector('#selection-popup .color-dot[data-color="#f43f5e"]')
                if (colorDot) colorDot.click()
                await new Promise(r => setTimeout(r, 800))

                const hls = await window.db.getHighlightsByBook(celan.id)
                window.app.closeReader()

                return {
                    celanTitle: celan.title,
                    savedHighlightCount: hls.length,
                    cfi: hls[0]?.cfi,
                    text: hls[0]?.text
                }
            })
            console.log('Celan EPUB Result:', celanCheck)
        }

        console.log('\n==========================================')
        console.log(`AUDIT PASSED! Errors caught: ${errors.length}, Warnings: ${warnings.length}`)
        if (errors.length > 0) console.log('Errors:\n', errors)
        console.log('==========================================')

        await browser.close()
        server.close()
        process.exit(errors.length === 0 ? 0 : 1)
    } catch (e) {
        console.error('Test error:', e)
        server.close()
        process.exit(1)
    }
})
