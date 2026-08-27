const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testSampleHighlight() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    // Auto dismiss any alert dialogs
    page.on('dialog', async dialog => {
        console.log('Dialog auto-accepted:', dialog.message())
        await dialog.accept()
    })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // Load sample books
    await page.evaluate(async () => {
        await window.readerApp.loadSampleBooks()
    })
    await new Promise(r => setTimeout(r, 3000))

    // Open first sample book (e.g. 荷马史诗 / 诗歌集)
    await page.evaluate(async () => {
        const db = await import('./js/db.js?v=20260826_23')
        const books = await db.getAllBooks()
        if (books.length > 0) {
            await window.readerApp.openBook(books[0].id)
        }
    })
    console.log('Opening sample book...')
    await new Promise(r => setTimeout(r, 5000))

    // Select text in book and add realistic marker highlight
    const res = await page.evaluate(async () => {
        const view = window.readerApp.foliateView
        const contents = view?.getContents ? view.getContents() : []
        let doc = contents[0]?.doc
        if (!doc) {
            const iframe = document.querySelector('#book-container iframe')
            doc = iframe?.contentDocument
        }
        if (!doc) return 'No doc'

        const paragraphs = Array.from(doc.querySelectorAll('p, div, blockquote, li')).filter(p => p.innerText.trim().length > 15)
        if (paragraphs.length === 0) return 'No paragraphs found'

        // Select first 8 paragraphs
        const startNode = paragraphs[0].firstChild
        const lastP = paragraphs[Math.min(7, paragraphs.length - 1)]
        const endNode = lastP.lastChild
        const range = doc.createRange()
        range.setStart(startNode, 0)
        range.setEnd(endNode, endNode.textContent.length)

        const sel = doc.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
        return 'Highlighted ' + paragraphs.length + ' lines successfully with authentic WeChat Read marker!'
    })
    console.log('Highlight result:', res)

    await new Promise(r => setTimeout(r, 2000))
    const outPath = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_success.png'
    await page.screenshot({ path: outPath })
    console.log('Saved success screenshot to:', outPath)

    await browser.close()
    console.log('FINISHED!')
}

testSampleHighlight().catch(console.error)
