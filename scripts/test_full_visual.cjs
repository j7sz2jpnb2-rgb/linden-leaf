const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testFullVisual() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    await page.goto('http://localhost:8088/index.html?t=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    // 1. Inject realistic reading sessions into IndexedDB
    await page.evaluate(async () => {
        const dbMod = await import('./js/db.js?v=20260826_23')
        const now = Date.now()
        
        // Populate days in August 2026
        const days = [
            { day: 1, mins: 45 },
            { day: 2, mins: 12 },
            { day: 3, mins: 70 }, // Peak
            { day: 4, mins: 20 },
            { day: 7, mins: 35 },
            { day: 8, mins: 25 },
            { day: 10, mins: 50 },
            { day: 14, mins: 15 },
            { day: 20, mins: 30 },
            { day: 26, mins: 60 }
        ]

        for (const item of days) {
            const dateStr = `2026-08-${String(item.day).padStart(2, '0')}`
            const startTime = new Date(`${dateStr}T10:00:00`).getTime()
            await dbMod.recordReadingSession({
                id: `mock_sess_${item.day}`,
                bookId: 'book_mock_1',
                bookTitle: '说吧，记忆 (纳博科夫)',
                date: dateStr,
                startTime: startTime,
                endTime: startTime + item.mins * 60 * 1000,
                durationSeconds: item.mins * 60,
                startProgress: 0.1,
                endProgress: 0.25
            })
        }
    })

    // 2. Open Stats View and take screenshot
    await page.evaluate(() => {
        document.getElementById('nav-cat-stats')?.click()
    })
    await new Promise(r => setTimeout(r, 800))

    const statsScreenshot = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_stats_populated.png'
    await page.screenshot({ path: statsScreenshot })
    console.log('Saved populated stats screenshot to:', statsScreenshot)

    // 3. Open a book to test the new authentic WeChat Read marker strokes!
    await page.evaluate(() => {
        document.getElementById('nav-cat-all')?.click()
    })
    await new Promise(r => setTimeout(r, 800))

    const firstBook = await page.$('.book-card, .book-spine')
    if (firstBook) {
        await firstBook.click()
        await new Promise(r => setTimeout(r, 4000))

        // Trigger realistic highlighter on stanzas/paragraphs
        await page.evaluate(async () => {
            const iframe = document.querySelector('#book-container iframe')
            const doc = iframe?.contentDocument
            if (!doc) return

            const ps = Array.from(doc.querySelectorAll('p, div')).filter(el => el.innerText.trim().length > 15)
            if (ps.length > 0) {
                const target = ps[0]
                const range = doc.createRange()
                range.selectNodeContents(target)
                const sel = doc.defaultView.getSelection()
                sel.removeAllRanges()
                sel.addRange(range)

                await window.readerApp.addHighlight('realistic-pen', '#f43f5e')
            }
        })
        await new Promise(r => setTimeout(r, 1500))

        const markerScreenshot = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_marker_strokes_rendered.png'
        await page.screenshot({ path: markerScreenshot })
        console.log('Saved marker screenshot to:', markerScreenshot)
    }

    await browser.close()
    console.log('VISUAL VERIFICATION COMPLETED!')
}

testFullVisual().catch(console.error)
