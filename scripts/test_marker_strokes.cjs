const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testMarkerStrokes() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // Open book directly
    await page.evaluate(async () => {
        const books = await window.readerApp?.loadBooks?.() || []
        if (books.length > 0) {
            await window.readerApp.openBook(books[0].id)
        }
    })
    await new Promise(r => setTimeout(r, 4000))

    // Select 5 consecutive lines to see 5 distinct varied marker profiles with chisel cuts & ink pooling
    const highlightInfo = await page.evaluate(async () => {
        const iframe = document.querySelector('#book-container iframe')
        const doc = iframe?.contentDocument
        if (!doc) return 'No iframe doc'

        const paragraphs = Array.from(doc.querySelectorAll('p, div, blockquote')).filter(p => p.innerText.trim().length > 30)
        if (paragraphs.length === 0) return 'No paragraphs found'

        const targetP = paragraphs[0]
        const range = doc.createRange()
        range.selectNodeContents(targetP)
        const sel = doc.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
        return 'Highlighted ' + targetP.innerText.slice(0, 30)
    })
    console.log('Highlight info:', highlightInfo)

    await new Promise(r => setTimeout(r, 1500))
    const strokeScreenshot = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_verified.png'
    await page.screenshot({ path: strokeScreenshot })
    console.log('Saved marker screenshot to:', strokeScreenshot)

    await browser.close()
}

testMarkerStrokes().catch(console.error)
