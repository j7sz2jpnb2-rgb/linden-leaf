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

server.listen(9095, async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.toString()}`))

    await page.goto('http://localhost:9095/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    await new Promise(r => setTimeout(r, 2000))

    await page.evaluate(() => {
        const book = document.querySelector('.skeuo-book') || document.querySelector('.jane-book-card')
        if (book) book.click()
    })

    await new Promise(r => setTimeout(r, 4000))

    const diag = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No fv' }

        // Go to section index 3 (EPUB/text00003.html)
        await fv.goTo(3)
        await new Promise(r => setTimeout(r, 2000))

        const contents = fv.renderer?.getContents?.() || []
        const item = contents.find(c => c.index === 3)
        if (!item || !item.doc) return { error: 'No item doc at index 3' }

        const doc = item.doc

        // Find paragraphs
        const ps = Array.from(doc.querySelectorAll('p'))
        const p1 = ps.find(p => p.textContent.includes('没人替我照应'))
        const p3 = ps.find(p => p.textContent.includes('像荆棘开了花'))

        console.log('p1 found:', !!p1, 'p3 found:', !!p3)

        // Case A: Select single line inside p1
        const range1 = doc.createRange()
        range1.setStart(p1.firstChild, 0)
        range1.setEnd(p1.firstChild, p1.firstChild.nodeValue.length)

        let cfi1 = null, cfiErr1 = null
        try {
            cfi1 = fv.getCFI(3, range1)
            console.log('Single line CFI:', cfi1)
        } catch (e) {
            cfiErr1 = e.stack || e.toString()
            console.error('Single line CFI error:', e)
        }

        // Case B: Select multi-line across p1 to p3 (exactly what user did in screenshot!)
        const rangeMulti = doc.createRange()
        rangeMulti.setStart(p1.firstChild, 0)
        rangeMulti.setEnd(p3.lastChild, p3.lastChild.nodeValue ? p3.lastChild.nodeValue.length : 0)

        let cfiMulti = null, cfiErrMulti = null
        try {
            cfiMulti = fv.getCFI(3, rangeMulti)
            console.log('Multi-paragraph CFI:', cfiMulti)
        } catch (e) {
            cfiErrMulti = e.stack || e.toString()
            console.error('Multi-paragraph CFI error:', e)
        }

        // Test Overlayer with rangeMulti getClientRects
        const rects = Array.from(rangeMulti.getClientRects())
        console.log('rangeMulti getClientRects count:', rects.length)

        // Test addAnnotation with cfiMulti
        let addErr = null
        if (cfiMulti) {
            try {
                await fv.addAnnotation({
                    value: `${cfiMulti}::highlight`,
                    id: 'hl_test_multi',
                    color: '#f43f5e',
                    style: 'highlight'
                })
                console.log('addAnnotation multi SUCCESS!')
            } catch (e) {
                addErr = e.stack || e.toString()
                console.error('addAnnotation multi error:', e)
            }
        }

        return {
            cfi1,
            cfiErr1,
            cfiMulti,
            cfiErrMulti,
            rectsCount: rects.length,
            addErr
        }
    })

    console.log('Diagnostic result:\n', JSON.stringify(diag, null, 2))
    console.log('Browser logs:\n', logs.join('\n'))

    await browser.close()
    server.close()
    process.exit(0)
})
