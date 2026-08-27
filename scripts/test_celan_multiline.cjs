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

server.listen(9097, async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.toString()}`))

    await page.goto('http://localhost:9097/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    await new Promise(r => setTimeout(r, 2000))

    await page.evaluate(() => {
        const book = document.querySelector('.skeuo-book') || document.querySelector('.jane-book-card') || document.querySelector('.jane-table-row')
        if (book) book.click()
    })

    await new Promise(r => setTimeout(r, 4000))

    const diag = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No fv' }

        // Go to section 2 (which is text00003.html)
        await fv.goTo(2)
        await new Promise(r => setTimeout(r, 1500))

        const contents = fv.renderer?.getContents?.() || []
        console.log('Contents:', contents.map(c => ({ index: c.index, hasDoc: !!c.doc })))

        const item = contents.find(c => c.index === 2) || contents[0]
        if (!item || !item.doc) return { error: 'No item doc' }

        const doc = item.doc

        // Find all p elements
        const ps = Array.from(doc.querySelectorAll('p'))
        const p1 = ps.find(p => p.textContent.includes('没人替我照应'))
        const p3 = ps.find(p => p.textContent.includes('像荆棘开了花'))

        console.log('p1 found:', !!p1, 'p3 found:', !!p3)

        if (!p1 || !p3) return { error: 'Paragraphs not found' }

        // Create cross-paragraph range
        const range = doc.createRange()
        range.setStart(p1.firstChild, 0)
        range.setEnd(p3.lastChild, p3.lastChild.nodeValue ? p3.lastChild.nodeValue.length : 0)

        console.log('Cross range text:', range.toString())

        // Test getCFI
        let cfi = null
        let cfiErr = null
        try {
            cfi = fv.getCFI(item.index, range)
            console.log('CFI generated:', cfi)
        } catch (e) {
            cfiErr = e.stack || e.toString()
            console.error('getCFI failed:', e)
        }

        // Test rects
        const rects = Array.from(range.getClientRects())
        console.log('ClientRects count:', rects.length, 'BoundingRect:', range.getBoundingClientRect())

        // Test draw annotation with Overlayer
        let drawErr = null
        try {
            const { Overlayer } = await import('./foliate-js-main/overlayer.js')
            const svgGroup = Overlayer.highlight(rects, { color: '#f43f5e', realisticPen: true })
            console.log('Overlayer.highlight children:', svgGroup.children.length)
        } catch (e) {
            drawErr = e.stack || e.toString()
            console.error('Overlayer.highlight error:', e)
        }

        // Test addAnnotation in foliateView
        let addErr = null
        if (cfi) {
            try {
                await fv.addAnnotation({
                    value: `${cfi}::highlight`,
                    id: 'hl_test_1',
                    color: '#f43f5e',
                    style: 'highlight'
                })
                console.log('addAnnotation success!')
            } catch (e) {
                addErr = e.stack || e.toString()
                console.error('addAnnotation error:', e)
            }
        }

        return {
            cfi,
            cfiErr,
            rectsCount: rects.length,
            drawErr,
            addErr
        }
    })

    console.log('Diagnostic result:\n', JSON.stringify(diag, null, 2))
    console.log('Browser logs:\n', logs.join('\n'))

    await browser.close()
    server.close()
    process.exit(0)
})
