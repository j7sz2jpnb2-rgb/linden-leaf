const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testStatsAndStrokes() {
    console.log('Launching browser...')
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    await page.goto('http://localhost:8088/index.html', { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 2000))

    // 1. Click "阅读统计" in sidebar
    console.log('Navigating to Stats View...')
    await page.click('#nav-cat-stats')
    await new Promise(r => setTimeout(r, 1000))

    const statsScreenshot = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\wechat_stats_month.png'
    await page.screenshot({ path: statsScreenshot })
    console.log('Saved Month Stats screenshot to:', statsScreenshot)

    // Click "周"
    const weekBtn = await page.$('.stats-tab-btn[data-mode="week"]')
    if (weekBtn) {
        await weekBtn.click()
        await new Promise(r => setTimeout(r, 500))
        await page.screenshot({ path: 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\wechat_stats_week.png' })
    }

    // Click "年"
    const yearBtn = await page.$('.stats-tab-btn[data-mode="year"]')
    if (yearBtn) {
        await yearBtn.click()
        await new Promise(r => setTimeout(r, 500))
        await page.screenshot({ path: 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\wechat_stats_year.png' })
    }

    // Click "总"
    const totalBtn = await page.$('.stats-tab-btn[data-mode="total"]')
    if (totalBtn) {
        await totalBtn.click()
        await new Promise(r => setTimeout(r, 500))
        await page.screenshot({ path: 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\wechat_stats_total.png' })
    }

    // 2. Open 《说吧，记忆》 or 《埃涅阿斯纪》 and test authentic marker strokes
    console.log('Navigating back to bookshelf...')
    await page.click('#nav-cat-all')
    await new Promise(r => setTimeout(r, 1000))

    const bookCards = await page.$$('.book-card, .book-spine')
    if (bookCards.length > 0) {
        console.log('Opening book...')
        await bookCards[0].click()
        await new Promise(r => setTimeout(r, 4000))

        // Trigger realistic highlighter on multiple lines
        const strokeResult = await page.evaluate(async () => {
            const view = window.readerApp?.foliateView
            if (!view) return 'No view'
            
            const doc = document.querySelector('#book-container iframe')?.contentDocument
            if (!doc) return 'No iframe doc'

            const paragraphs = Array.from(doc.querySelectorAll('p, blockquote, div')).filter(p => p.innerText.trim().length > 20)
            if (paragraphs.length === 0) return 'No paragraphs'

            // Select multiple lines to generate authentic realistic pen strokes
            const targetP = paragraphs[0]
            const range = doc.createRange()
            range.selectNodeContents(targetP)
            const sel = doc.defaultView.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)

            // Trigger highlight
            await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
            return 'Highlighted successfully'
        })
        console.log('Stroke highlight result:', strokeResult)

        await new Promise(r => setTimeout(r, 1500))
        const strokeScreenshot = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\wechat_marker_strokes_test.png'
        await page.screenshot({ path: strokeScreenshot })
        console.log('Saved marker strokes screenshot to:', strokeScreenshot)
    }

    await browser.close()
    console.log('TEST COMPLETED!')
}

testStatsAndStrokes().catch(console.error)
