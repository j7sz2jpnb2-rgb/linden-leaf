const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function openBookAndHighlight() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // Click the book on the shelf
    const bookSpine = await page.$('.book-spine, .book-card')
    if (bookSpine) {
        console.log('Clicking book spine on shelf...')
        await bookSpine.click()
        await new Promise(r => setTimeout(r, 5000))
    }

    // Highlight text in the open book
    const res = await page.evaluate(async () => {
        const doc = document.querySelector('#book-container iframe')?.contentDocument
        if (!doc) return 'No iframe doc'

        const paragraphs = Array.from(doc.querySelectorAll('p, div, blockquote')).filter(p => p.innerText.trim().length > 15)
        if (paragraphs.length === 0) return 'No paragraphs found'

        // Select first 8 paragraphs to see 8 varied WeChat Read marker lines
        const targetP = paragraphs[0]
        const range = doc.createRange()
        range.selectNodeContents(targetP)
        const sel = doc.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
        return 'Successfully added realistic-pen highlight!'
    })
    console.log('Highlight result:', res)

    await new Promise(r => setTimeout(r, 1500))
    const outPath = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_real.png'
    await page.screenshot({ path: outPath })
    console.log('Saved realistic marker screenshot to:', outPath)

    await browser.close()
}

openBookAndHighlight().catch(console.error)
