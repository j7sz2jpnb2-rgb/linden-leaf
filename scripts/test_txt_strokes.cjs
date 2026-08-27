const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')
const fs = require('fs')

async function testTxtStrokes() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // Import 埃涅阿斯纪 TXT
    const txtPath = 'C:\\Users\\Administrator\\Desktop\\埃涅阿斯纪_v13_final_r4.4_v4.2_FINAL_译文与注释.txt'
    if (fs.existsSync(txtPath)) {
        const fileInput = await page.$('#file-input')
        await fileInput.uploadFile(txtPath)
        console.log('Uploaded Aeneid TXT...')
        await new Promise(r => setTimeout(r, 6000))
    }

    // Now select multiple stanzas to test the 12 varied realistic marker profiles
    const res = await page.evaluate(async () => {
        const view = document.querySelector('#book-container foliate-view, #book-container foliate-fxl')
        if (!view) return 'No view element'

        const contents = view.getContents ? view.getContents() : []
        if (contents.length === 0) return 'No contents in view'

        const doc = contents[0].doc
        if (!doc) return 'No doc in contents'

        const paragraphs = Array.from(doc.querySelectorAll('p')).filter(p => p.innerText.trim().length > 10)
        if (paragraphs.length < 5) return 'Not enough paragraphs: ' + paragraphs.length

        // Select first 8 verse lines
        const startNode = paragraphs[0].firstChild
        const endNode = paragraphs[7].lastChild
        const range = doc.createRange()
        range.setStart(startNode, 0)
        range.setEnd(endNode, endNode.textContent.length)

        const sel = doc.defaultView.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
        return 'Successfully highlighted 8 verse lines with realistic marker!'
    })
    console.log('Highlight result:', res)

    await new Promise(r => setTimeout(r, 1500))
    const outPath = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_final.png'
    await page.screenshot({ path: outPath })
    console.log('Saved final marker screenshot to:', outPath)

    await browser.close()
}

testTxtStrokes().catch(console.error)
