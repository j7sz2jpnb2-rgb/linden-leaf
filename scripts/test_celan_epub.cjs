const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')
const fs = require('fs')

async function testCelanEpub() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))
    page.on('pageerror', err => logs.push(`[ERROR] ${err.toString()}`))

    await page.goto('http://localhost:8088/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    // Wait for import
    await new Promise(r => setTimeout(r, 2000))

    // Click on the first book in shelf
    await page.evaluate(() => {
        const book = document.querySelector('.skeuo-book') || document.querySelector('.jane-book-card') || document.querySelector('.jane-table-row')
        if (book) book.click()
    })

    // Wait for reader to open
    await new Promise(r => setTimeout(r, 4000))

    // Let's inspect the foliateView and contents
    const testResult = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        if (!fv) return { error: 'No foliate-view' }

        const contents = fv.renderer?.getContents?.() || []
        console.log('Renderer contents count:', contents.length)

        const firstItem = contents[0]
        if (!firstItem || !firstItem.doc) {
            return { error: 'No firstItem.doc' }
        }

        const doc = firstItem.doc
        const body = doc.body
        console.log('Body HTML length:', body.innerHTML.length)

        // Find a paragraph or text node in doc
        const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        let textNode = walker.nextNode()
        while (textNode && (!textNode.nodeValue || textNode.nodeValue.trim().length < 4)) {
            textNode = walker.nextNode()
        }

        if (!textNode) return { error: 'No text node found' }

        console.log('Found text node:', textNode.nodeValue.trim().slice(0, 30))

        // Create range
        const range = doc.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(10, textNode.nodeValue.length))

        // Select it
        const sel = doc.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)

        // Test getCFI
        let cfi = null
        let cfiError = null
        try {
            cfi = fv.getCFI(firstItem.index, range)
            console.log('Generated CFI:', cfi)
        } catch (e) {
            cfiError = e.toString()
            console.error('getCFI error:', e)
        }

        // Test Overlayer.highlight
        let highlightError = null
        try {
            const rects = Array.from(range.getClientRects())
            console.log('Range rects count:', rects.length)
        } catch (e) {
            highlightError = e.toString()
        }

        // Check if selection popup is displayed
        const popup = document.getElementById('selection-popup')
        const popupDisplay = popup ? window.getComputedStyle(popup).display : 'none'
        const popupVisibility = popup ? window.getComputedStyle(popup).visibility : 'hidden'

        return {
            bookTitle: fv.book?.metadata?.title,
            sectionIndex: firstItem.index,
            cfi,
            cfiError,
            highlightError,
            popupDisplay,
            popupVisibility
        }
    })

    console.log('Test result:', testResult)
    console.log('Logs:\n', logs.join('\n'))

    await browser.close()
}

testCelanEpub().catch(console.error)
