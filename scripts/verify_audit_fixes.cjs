const fs = require('fs')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function run() {
    console.log('Connecting to browser and testing on http://localhost:8088/index.html...')
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })

    const errors = []
    const warnings = []
    page.on('dialog', async d => {
        console.log('Dialog:', d.message())
        await d.accept()
    })
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text())
        if (msg.type() === 'warn') warnings.push(msg.text())
    })
    page.on('pageerror', err => errors.push(err.toString()))

    await page.goto('http://localhost:8088/index.html', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForFunction(() => window.app != null, { timeout: 15000 })

    console.log('--- 1. Check DOM Button Bindings ---')
    const btnCheck = await page.evaluate(() => {
        const app = window.app
        return {
            hasBtnNavLeft: !!app.dom.btnNavLeft,
            hasBtnNavRight: !!app.dom.btnNavRight,
            hasBtnShelfSettings: !!app.dom.btnShelfSettings,
            navLeftId: app.dom.btnNavLeft?.id,
            navRightId: app.dom.btnNavRight?.id,
            shelfSettingsId: app.dom.btnShelfSettings?.id
        }
    })
    console.log('Button DOM Bindings:', btnCheck)

    console.log('--- 2. Load Sample Books & Check Bookshelf Multiline ---')
    await page.evaluate(async () => {
        await window.app.loadSampleBooks()
    })
    await new Promise(r => setTimeout(r, 2000))

    const shelfCheck = await page.evaluate(() => {
        const rows = document.querySelectorAll('.wood-shelf-row')
        const books = document.querySelectorAll('.skeuo-book')
        return {
            rowCount: rows.length,
            bookCount: books.length
        }
    })
    console.log('Bookshelf Shelves & Books Count:', shelfCheck)

    console.log('--- 3. Check Reading Tracker with Local Date & Session Safety ---')
    const trackerCheck = await page.evaluate(async () => {
        const tr = window.tracker
        await tr.startSession('book_test_1', '测试书名1', 0.1)
        tr.tick()
        tr.tick()
        await tr.flush()
        
        const sessions = await window.db.getAllReadingSessions()
        const latest = sessions[0]
        
        await tr.endSession(0.2)
        return {
            sessionCount: sessions.length,
            latestDate: latest?.date,
            latestBookTitle: latest?.bookTitle,
            isDateLocalFormat: /^\d{4}-\d{2}-\d{2}$/.test(latest?.date || '')
        }
    })
    console.log('Reading Tracker Validation:', trackerCheck)

    console.log('--- 4. Check Quote Card Generation ---')
    const quoteCheck = await page.evaluate(async () => {
        window.quoteCard.setBookInfo('测试书籍《百年孤独》', '马尔克斯', '第一章', '第 12 页', '读者君')
        window.quoteCard.setQuote('多年以后，面对行刑队，奥雷里亚诺·布恩迪亚上校将会回想起父亲带他去见识冰块的那个遥远的下午。')
        const canvas = await window.quoteCard.renderCanvas()
        const blob = await window.quoteCard.getBlob()
        return {
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            blobSize: blob?.size,
            blobType: blob?.type
        }
    })
    console.log('Quote Card Generation Validation:', quoteCheck)

    console.log('--- 5. Check Celan EPUB Highlight & High-Precision Annotation ---')
    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    if (fs.existsSync(celanPath)) {
        const fileInput = await page.$('#file-input')
        await fileInput.uploadFile(celanPath)
        await new Promise(r => setTimeout(r, 2500))

        const celanCheck = await page.evaluate(async () => {
            const books = await window.db.getAllBooks()
            const celan = books.find(b => b.title && b.title.includes('策兰'))
            if (!celan) return { error: 'Celan book not found in DB' }
            
            await window.app.openBook(celan.id)
            await new Promise(r => setTimeout(r, 3000))
            
            const fv = document.querySelector('foliate-view')
            if (!fv) return { error: 'foliate-view missing' }

            await fv.goTo(3)
            await new Promise(r => setTimeout(r, 1500))

            const contents = fv.renderer?.getContents?.() || []
            const item = contents.find(c => c.index === 3) || contents[0]
            if (!item || !item.doc) return { error: 'Content doc not loaded' }

            const doc = item.doc
            const ps = Array.from(doc.querySelectorAll('p'))
            const p = ps.find(p => p.textContent.includes('没人替我照应')) || ps[0]
            
            const range = doc.createRange()
            range.setStart(p.firstChild, 0)
            range.setEnd(p.firstChild, Math.min(6, p.firstChild.nodeValue?.length || 4))

            const sel = doc.getSelection()
            sel.removeAllRanges()
            sel.addRange(range)

            doc.dispatchEvent(new Event('selectionchange'))
            doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            
            await new Promise(r => setTimeout(r, 500))
            
            // Click Pink color dot
            const colorDot = document.querySelector('#selection-popup .color-dot[data-color="#f43f5e"]')
            if (colorDot) colorDot.click()

            await new Promise(r => setTimeout(r, 800))

            const hls = await window.db.getHighlightsByBook(celan.id)
            window.app.closeReader()
            
            return {
                celanTitle: celan.title,
                highlightCount: hls.length,
                savedCfi: hls[0]?.cfi,
                savedText: hls[0]?.text
            }
        })
        console.log('Celan EPUB Highlighting Check:', celanCheck)
    }

    console.log('\n--- VERIFICATION SUMMARY ---')
    console.log('Console Errors:', errors.length)
    if (errors.length > 0) console.log('Errors:', errors)
    console.log('Console Warnings:', warnings.length)

    await browser.close()
    process.exit(errors.length === 0 ? 0 : 1)
}

run().catch(err => {
    console.error('Test script failure:', err)
    process.exit(1)
})
