const http = require('http')
const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const ROOT = 'C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader'

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url.split('?')[0])
    if (filePath.endsWith('/') || filePath === ROOT) filePath = path.join(ROOT, 'index.html')

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404)
            return res.end('Not found')
        }
        const ext = path.extname(filePath)
        const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime })
        res.end(data)
    })
})

const PORT = 9085
server.listen(PORT, async () => {
    console.log(`Advanced test server running on ${PORT}`)

    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })

    const errors = []
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', err => errors.push(err.toString()))

    await page.goto(`http://localhost:${PORT}/index.html`)

    console.log('--- TEST A: Themes & Font Customization ---')
    const testA = await page.evaluate(async () => {
        const app = window.app
        const themes = ['sepia', 'dark', 'black', 'green', 'eink', 'light']
        const appliedThemes = []
        for (const t of themes) {
            app.applyTheme(t)
            appliedThemes.push(document.documentElement.getAttribute('data-theme'))
        }

        // Test Font and slider changes
        app.settings.fontSize = 22
        app.settings.lineHeight = 1.9
        app.settings.letterSpacing = 1.5
        app.settings.font = 'kaiti'
        app.applySettingsToReader()

        return {
            appliedThemes,
            fontSize: app.settings.fontSize,
            lineHeight: app.settings.lineHeight,
            font: app.settings.font
        }
    })
    console.log('Test A Theme/Font result:', testA)

    console.log('--- TEST B: In-Book Search & Navigation ---')
    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)
    await new Promise(r => setTimeout(r, 2000))

    // Open Celan book
    await page.evaluate(async () => {
        const books = await window.db.getAllBooks()
        const celan = books.find(b => b.title && b.title.includes('策兰'))
        if (celan) await window.app.openBook(celan.id)
    })
    await new Promise(r => setTimeout(r, 4000))

    const testB = await page.evaluate(async () => {
        const app = window.app
        app.openDrawer('search')
        app.dom.searchQueryInput.value = '阿克拉'
        await app.executeSearch()
        await new Promise(r => setTimeout(r, 1200))

        const matchCount = app.currentSearchMatches?.length || 0
        const searchBarVisible = app.dom.readerSearchBar && window.getComputedStyle(app.dom.readerSearchBar).display !== 'none'
        const barTitle = app.dom.searchBarTitle?.innerText || ''

        // Test navigation
        if (matchCount > 0) {
            await app.navigateSearchMatch(1)
        }

        app.clearSearchState(true)
        app.closeDrawer()

        return {
            matchCount,
            searchBarVisible,
            barTitle
        }
    })
    console.log('Test B Search result:', testB)

    console.log('--- TEST C: Table of Contents Jump ---')
    const testC = await page.evaluate(async () => {
        const app = window.app
        app.openDrawer('toc')
        const tocItems = document.querySelectorAll('.toc-item')
        const hasTOC = tocItems.length > 0
        if (hasTOC) {
            const secondItem = tocItems[Math.min(2, tocItems.length - 1)]
            secondItem.click()
            await new Promise(r => setTimeout(r, 1500))
        }
        app.closeDrawer()
        return {
            tocCount: tocItems.length,
            currentLoc: !!app.currentLocation
        }
    })
    console.log('Test C TOC result:', testC)

    console.log('--- TEST D: Footnote Translation Bubble ---')
    const testD = await page.evaluate(async () => {
        const app = window.app
        app.showFootnotePopup({
            title: '💡 译注与说明',
            text: '基路伯（Cherub），《圣经》中守卫伊甸园的智天使。',
            rect: { top: 300, left: 400, width: 30, height: 20 }
        })
        const popup = document.getElementById('footnote-popup')
        const isVisible = popup && window.getComputedStyle(popup).display !== 'none'
        const title = document.getElementById('footnote-popup-title')?.innerText
        const content = document.getElementById('footnote-popup-content')?.innerText

        app.hideFootnotePopup()
        return {
            isVisible,
            title,
            content
        }
    })
    console.log('Test D Footnote result:', testD)

    console.log('\n--- ADVANCED TEST SUMMARY ---')
    console.log('Errors caught:', errors.length)
    if (errors.length > 0) console.log('Errors:\n', errors)

    await browser.close()
    server.close()
    process.exit(0)
})
