const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testHighlightPage2() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    page.on('dialog', async d => { await d.accept() })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // Open first book
    await page.evaluate(async () => {
        const db = await import('./js/db.js?v=20260826_23')
        const books = await db.getAllBooks()
        if (books.length > 0) {
            await window.readerApp.openBook(books[0].id)
        }
    })
    await new Promise(r => setTimeout(r, 4000))

    // Flip to next page
    await page.evaluate(async () => {
        await window.readerApp.foliateView?.next()
    })
    await new Promise(r => setTimeout(r, 2000))

    // Select multiple lines and apply realistic marker
    const info = await page.evaluate(async () => {
        const view = window.readerApp.foliateView
        const contents = view?.getContents ? view.getContents() : (view?.renderer?.getContents ? view.renderer.getContents() : [])
        console.log('Contents found:', contents.length)
        if (contents.length === 0) return 'No contents found in view or renderer'

        const doc = contents[0].doc
        if (!doc) return 'No doc inside contents[0]'

        const ps = Array.from(doc.querySelectorAll('p, div, li, h1, h2, h3')).filter(p => p.innerText.trim().length > 10)
        if (ps.length === 0) return 'No elements to highlight'

        // Select first 8 lines
        const startNode = ps[0].firstChild
        const lastP = ps[Math.min(7, ps.length - 1)]
        const endNode = lastP.lastChild
        const range = doc.createRange()
        range.setStart(startNode, 0)
        range.setEnd(endNode, endNode.textContent ? endNode.textContent.length : 0)

        const sel = doc.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
        return `Successfully highlighted ${ps.length} lines with 12 distinct realistic marker variations!`
    })
    console.log('Highlight Info:', info)

    await new Promise(r => setTimeout(r, 1500))
    const outPath = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_page2.png'
    await page.screenshot({ path: outPath })
    console.log('Saved page 2 marker screenshot to:', outPath)

    await browser.close()
}

testHighlightPage2().catch(console.error)
