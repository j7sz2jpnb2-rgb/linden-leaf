const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')
const fs = require('fs')

async function debugCelanBook() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const consoleLogs = []
    page.on('console', msg => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', err => {
        consoleLogs.push(`[PAGE_ERROR] ${err.toString()}`)
    })

    await page.goto('http://localhost:8088/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    console.log('Loading file:', celanPath)

    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    // Wait for book to open
    await new Promise(r => setTimeout(r, 3000))

    // Let's inspect the DOM and iframe contents
    const iframeInfo = await page.evaluate(() => {
        const view = document.getElementById('view')
        const selectionToolbar = document.getElementById('selection-toolbar')
        const toolbarDisplay = selectionToolbar ? window.getComputedStyle(selectionToolbar).display : 'none'
        const toolbarVisible = selectionToolbar ? window.getComputedStyle(selectionToolbar).visibility : 'hidden'

        // Check foliate-view or iframe
        const iframes = Array.from(document.querySelectorAll('iframe'))
        return {
            iframesCount: iframes.length,
            toolbarDisplay,
            toolbarVisible,
            hasBook: !!window.currentBook || !!window.bookDoc
        }
    })
    console.log('Iframe info:', iframeInfo)

    // Let's trigger a selection in the view or iframe
    const selectResult = await page.evaluate(async () => {
        // Find foliate-view or renderer
        const view = document.querySelector('foliate-view') || document.getElementById('view')
        console.log('view tag:', view ? view.tagName : 'null')

        // Dispatch selection on document or foliate-view
        // Let's check view's event listeners or selection
        let selectedText = ''
        if (view && view.shadowRoot) {
            console.log('view has shadowRoot')
        }
        return { viewFound: !!view }
    })
    console.log('Select result:', selectResult)

    await new Promise(r => setTimeout(r, 1000))
    console.log('Console logs from browser:\n', consoleLogs.join('\n'))

    await browser.close()
}

debugCelanBook().catch(console.error)
