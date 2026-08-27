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

server.listen(9099, async () => {
    console.log('Test server listening on 9099')

    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.toString()}`))

    await page.goto('http://localhost:9099/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    // Wait for import
    await new Promise(r => setTimeout(r, 2000))

    // Click on book to open
    await page.evaluate(() => {
        const book = document.querySelector('.skeuo-book') || document.querySelector('.jane-book-card') || document.querySelector('.jane-table-row')
        if (book) book.click()
    })

    // Wait for reader to open and load
    await new Promise(r => setTimeout(r, 4000))

    const testResult = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No foliate-view' }

        const contents = fv.renderer?.getContents?.() || []
        console.log('Renderer contents count:', contents.length)

        let targetItem = null
        for (const item of contents) {
            if (item?.doc) {
                targetItem = item
                break
            }
        }

        if (!targetItem) return { error: 'No content item found' }

        const doc = targetItem.doc
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
        let textNode = walker.nextNode()
        while (textNode && (!textNode.nodeValue || textNode.nodeValue.trim().length < 4)) {
            textNode = walker.nextNode()
        }

        if (!textNode) return { error: 'No text node in doc.body' }

        console.log('Selected text node:', textNode.nodeValue.trim().slice(0, 30))

        const range = doc.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(10, textNode.nodeValue.length))

        const sel = doc.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        // Trigger mouseup / selectionchange manually
        doc.dispatchEvent(new Event('selectionchange'))
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

        await new Promise(r => setTimeout(r, 300))

        // Check getCFI
        let cfi = null
        let cfiError = null
        try {
            cfi = fv.getCFI(targetItem.index, range)
            console.log('CFI success:', cfi)
        } catch (e) {
            cfiError = e.toString()
            console.error('CFI error caught:', e)
        }

        const popup = document.getElementById('selection-popup')
        return {
            bookTitle: fv.book?.metadata?.title,
            targetIndex: targetItem.index,
            cfi,
            cfiError,
            popupDisplay: popup ? window.getComputedStyle(popup).display : 'none',
            popupVisibility: popup ? window.getComputedStyle(popup).visibility : 'hidden',
            popupTop: popup ? popup.style.top : null,
            popupLeft: popup ? popup.style.left : null
        }
    })

    console.log('Result:\n', JSON.stringify(testResult, null, 2))
    console.log('Logs:\n', logs.join('\n'))

    await browser.close()
    server.close()
    process.exit(0)
})
