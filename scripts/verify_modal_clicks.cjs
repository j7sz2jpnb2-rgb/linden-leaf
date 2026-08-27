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

const PORT = 9133
server.listen(PORT, async () => {
    console.log(`[MODAL CLICK TEST] Running on http://localhost:${PORT}`)
    try {
        const tmpUserDataDir = path.join(__dirname, `../.pup_modal_${Date.now()}`)
        const browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            headless: true,
            userDataDir: tmpUserDataDir,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        })

        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 860 })

        const errors = []
        page.on('dialog', async d => {
            console.log('  [Dialog]', d.message())
            await d.accept()
        })
        page.on('console', msg => {
            if (msg.type() === 'error' && !msg.text().includes('favicon')) {
                errors.push(msg.text())
            }
        })
        page.on('pageerror', err => errors.push(err.toString()))

        console.log('\n>>> 1. Navigate & Load Sample Books...')
        await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => window.app != null)
        await page.evaluate(async () => {
            await window.app.loadSampleBooks()
        })
        await new Promise(r => setTimeout(r, 1500))

        console.log('\n>>> 2. Physical DOM Click on "+ " (#btn-create-list)...')
        await page.click('#btn-create-list')
        await new Promise(r => setTimeout(r, 400))

        const createModalState = await page.evaluate(() => {
            const el = document.getElementById('modal-create-list')
            const style = window.getComputedStyle(el)
            return {
                display: style.display,
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                hasShowClass: el.classList.contains('show')
            }
        })
        console.log('Create List Modal State after click:', createModalState)
        if (createModalState.display === 'none' || createModalState.opacity !== '1' || !createModalState.hasShowClass) {
            throw new Error('Create List Modal failed to show properly!')
        }

        // Close modal
        await page.click('#btn-cancel-create-list')
        await new Promise(r => setTimeout(r, 400))

        console.log('\n>>> 3. Switch to Grid View and Physical Click on Card "📑" (.grid-list-btn)...')
        await page.click('#btn-view-grid')
        await new Promise(r => setTimeout(r, 400))

        // Hover over first book card cover to make buttons visible and click .grid-list-btn
        await page.hover('.jane-book-card .jane-cover-box')
        await new Promise(r => setTimeout(r, 200))
        await page.click('.jane-book-card .grid-list-btn')
        await new Promise(r => setTimeout(r, 400))

        const manageModalState = await page.evaluate(() => {
            const el = document.getElementById('modal-manage-book-lists')
            const style = window.getComputedStyle(el)
            const cbs = document.querySelectorAll('#book-lists-checkbox-container input[type="checkbox"]')
            return {
                display: style.display,
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                hasShowClass: el.classList.contains('show'),
                checkboxCount: cbs.length
            }
        })
        console.log('Manage Book Lists Modal State after click:', manageModalState)
        if (manageModalState.display === 'none' || manageModalState.opacity !== '1' || !manageModalState.hasShowClass || manageModalState.checkboxCount === 0) {
            throw new Error('Manage Book Lists Modal failed to show properly!')
        }

        // Close modal
        await page.click('#btn-cancel-book-lists')
        await new Promise(r => setTimeout(r, 400))

        console.log('\n>>> 4. Switch to Skeuo Wood Shelf and Click "📑" (.skeuo-list-btn)...')
        await page.click('#btn-view-shelf')
        await new Promise(r => setTimeout(r, 400))

        await page.hover('.skeuo-book .skeuo-book-cover')
        await new Promise(r => setTimeout(r, 200))
        await page.click('.skeuo-book .skeuo-list-btn')
        await new Promise(r => setTimeout(r, 400))

        const skeuoManageModalState = await page.evaluate(() => {
            const el = document.getElementById('modal-manage-book-lists')
            const style = window.getComputedStyle(el)
            return {
                display: style.display,
                opacity: style.opacity,
                hasShowClass: el.classList.contains('show')
            }
        })
        console.log('Skeuo Card List Button Click State:', skeuoManageModalState)
        if (skeuoManageModalState.display === 'none' || skeuoManageModalState.opacity !== '1') {
            throw new Error('Skeuo Card List Button failed!')
        }

        console.log('\n==========================================')
        console.log(`ALL BUTTON CLICKS VERIFIED! Total Errors: ${errors.length}`)
        console.log('==========================================')

        await browser.close()
        server.close()
        process.exit(errors.length === 0 ? 0 : 1)
    } catch (e) {
        console.error('Modal click test failed:', e)
        server.close()
        process.exit(1)
    }
})
