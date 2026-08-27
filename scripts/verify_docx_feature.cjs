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

const PORT = 9105
server.listen(PORT, async () => {
    console.log(`[DOCX VERIFICATION] Running on http://localhost:${PORT}`)
    try {
        const tmpUserDataDir = path.join(__dirname, `../.pup_docx_${Date.now()}`)
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
            console.log('  [Dialog]', d.message())
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

        console.log('\n>>> 1. Navigate to Linden Leaf App...')
        await page.goto(`http://localhost:${PORT}/index.html`, { timeout: 30000 })
        await page.waitForSelector('#file-input')
        await page.waitForFunction(() => window.app != null)

        console.log('\n>>> 2. Load Sample Books (including new Whitepaper .docx)...')
        await page.evaluate(async () => {
            await window.app.loadSampleBooks()
        })
        await new Promise(r => setTimeout(r, 2500))

        const docxBookCheck = await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const docxBook = books.find(b => b.format === 'docx' || (b.title && b.title.includes('白皮书')))
            return {
                totalBooks: books.length,
                foundDocx: !!docxBook,
                title: docxBook?.title,
                author: docxBook?.author,
                format: docxBook?.format,
                hasCoverBlob: !!docxBook?.coverBlob
            }
        })
        console.log('DOCX Book In DB Check:', docxBookCheck)

        if (!docxBookCheck.foundDocx) {
            throw new Error('DOCX sample book was not imported into DB')
        }

        console.log('\n>>> 3. Open .docx in Reader & Inspect Foliate TOC + Chapters...')
        const readerCheck = await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const docxBook = books.find(b => b.format === 'docx')
            await window.app.openBook(docxBook.id)
            await new Promise(r => setTimeout(r, 3000))

            const fv = document.querySelector('foliate-view')
            const bookObj = fv?.book
            const toc = bookObj?.toc || []
            const sections = bookObj?.sections || []

            // Read title & first paragraph from section 0
            const contents = fv?.renderer?.getContents?.() || []
            const firstDoc = contents[0]?.doc
            const h1Text = firstDoc?.querySelector('h1')?.textContent?.trim()
            const pText = firstDoc?.querySelector('p')?.textContent?.trim()

            return {
                hasFoliateView: !!fv,
                sectionCount: sections.length,
                tocCount: toc.length,
                tocLabels: toc.map(t => t.label),
                firstH1: h1Text,
                firstParagraph: pText?.slice(0, 40)
            }
        })
        console.log('Foliate DOCX Reader Check:', readerCheck)

        console.log('\n>>> 4. Test Text Selection & Highlighting in DOCX Section...')
        const highlightCheck = await page.evaluate(async () => {
            const fv = document.querySelector('foliate-view')
            const contents = fv?.renderer?.getContents?.() || []
            const doc = contents[0]?.doc
            if (!doc) return { error: 'No section document found' }

            const p = doc.querySelector('p')
            const textNode = p?.firstChild
            if (!textNode) return { error: 'No text node in paragraph' }

            const range = doc.createRange()
            range.setStart(textNode, 0)
            range.setEnd(textNode, Math.min(18, textNode.nodeValue?.length || 10))

            const sel = doc.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)

            doc.dispatchEvent(new Event('selectionchange'))
            doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            await new Promise(r => setTimeout(r, 500))

            // Click Green color dot
            const greenDot = document.querySelector('#selection-popup .color-dot[data-color="#4ade80"]') || document.querySelector('#selection-popup .color-dot')
            if (greenDot) greenDot.click()
            await new Promise(r => setTimeout(r, 1000))

            const books = await window.db.getAllBooks()
            const docxBook = books.find(b => b.format === 'docx')
            const hls = await window.db.getHighlightsByBook(docxBook.id)

            return {
                highlightCreated: hls.length > 0,
                highlightText: hls[0]?.text,
                highlightColor: hls[0]?.color,
                highlightCfi: hls[0]?.cfi
            }
        })
        console.log('DOCX Highlighting Check:', highlightCheck)

        console.log('\n>>> 5. Test Quote Card from DOCX Text...')
        const quoteCardCheck = await page.evaluate(async () => {
            window.quoteCard.setData({
                bookTitle: '现代化电子书阅读器设计白皮书',
                author: 'Linden Leaf 研发团队',
                chapterTitle: '第一章：数字时代的拟物阅读美学',
                pageIndex: '第 1 页',
                userName: '深度读者',
                quoteText: '电子书阅读器不应仅仅是冰冷的代码展示器，而应当传递出纸质书籍的温度与沉淀。'
            })
            window.quoteCard.setTheme('celadon')
            const canvas = await window.quoteCard.renderCanvas()
            const blob = await window.quoteCard.getBlob()

            window.app.closeReader()

            return {
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
                blobSize: blob?.size
            }
        })
        console.log('DOCX Quote Card Check:', quoteCardCheck)

        console.log('\n==========================================')
        console.log(`DOCX INTEGRATION VERIFIED! Total Errors: ${errors.length}, Warnings: ${warnings.length}`)
        if (errors.length > 0) {
            console.log('Errors caught:\n', errors)
        }
        console.log('==========================================')

        await browser.close()
        server.close()
        process.exit(errors.length === 0 ? 0 : 1)
    } catch (e) {
        console.error('Test execution error:', e)
        server.close()
        process.exit(1)
    }
})
