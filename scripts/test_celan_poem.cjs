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

server.listen(9098, async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.toString()}`))

    await page.goto('http://localhost:9098/index.html')
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

    // Search for "阿克拉" or navigate to find the section
    const poemResult = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No foliate-view' }

        // Find section containing "阿克拉" in book sections
        const sections = fv.book?.sections || []
        let targetSecIndex = -1

        for (let i = 0; i < sections.length; i++) {
            try {
                const sec = sections[i]
                const loaded = await sec.load()
                const text = typeof loaded === 'string' ? loaded : (loaded?.doc?.body?.innerText || '')
                if (text.includes('阿克拉') || text.includes('没人替我照应')) {
                    targetSecIndex = i
                    console.log('Poem found in section index:', i)
                    break
                }
            } catch (e) {}
        }

        if (targetSecIndex === -1) return { error: 'Poem section not found in book' }

        // Navigate foliateView to targetSecIndex
        await fv.goTo(targetSecIndex)
        await new Promise(r => setTimeout(r, 1500))

        const contents = fv.renderer?.getContents?.() || []
        const currentItem = contents.find(c => c.index === targetSecIndex) || contents[0]
        if (!currentItem || !currentItem.doc) return { error: 'Target section not loaded in renderer' }

        const doc = currentItem.doc
        console.log('Target section HTML:\n', doc.body.innerHTML.slice(0, 500))

        // Let's find the text node for "没人替我照应到此安息长眠的人"
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
        let n1 = null, n2 = null
        let cur = walker.nextNode()
        while (cur) {
            if (cur.nodeValue.includes('没人替我照应')) n1 = cur
            if (cur.nodeValue.includes('像荆棘开了花')) n2 = cur
            cur = walker.nextNode()
        }

        console.log('Found n1:', !!n1, 'n2:', !!n2)

        if (!n1) return { error: 'Text node n1 not found' }

        // Create range across multiple paragraphs or inside paragraph
        const range = doc.createRange()
        range.setStart(n1, 0)
        if (n2) {
            range.setEnd(n2, n2.nodeValue.length)
        } else {
            range.setEnd(n1, n1.nodeValue.length)
        }

        const sel = doc.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        // Trigger mouseup
        doc.dispatchEvent(new Event('selectionchange'))
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

        await new Promise(r => setTimeout(r, 300))

        let cfi = null
        let cfiError = null
        try {
            cfi = fv.getCFI(targetSecIndex, range)
            console.log('Poem range CFI:', cfi)
        } catch (e) {
            cfiError = e.toString()
            console.error('Poem CFI error:', e)
        }

        // Test creating highlight
        let addAnnotationError = null
        try {
            await fv.addAnnotation({
                value: `${cfi}::highlight`,
                id: 'test_hl_1',
                color: '#f43f5e',
                style: 'highlight'
            })
            console.log('addAnnotation SUCCESS!')
        } catch (e) {
            addAnnotationError = e.toString()
            console.error('addAnnotation error:', e)
        }

        const popup = document.getElementById('selection-popup')
        return {
            targetSecIndex,
            cfi,
            cfiError,
            addAnnotationError,
            popupDisplay: popup ? window.getComputedStyle(popup).display : 'none',
            popupVisibility: popup ? window.getComputedStyle(popup).visibility : 'hidden',
            popupTop: popup ? popup.style.top : null,
            popupLeft: popup ? popup.style.left : null
        }
    })

    console.log('Poem test result:\n', JSON.stringify(poemResult, null, 2))
    console.log('Logs:\n', logs.join('\n'))

    await browser.close()
    server.close()
    process.exit(0)
})
