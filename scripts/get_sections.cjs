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

server.listen(9096, async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 800 })

    const logs = []
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`))

    await page.goto('http://localhost:9096/index.html')
    await page.waitForSelector('#file-input')

    const celanPath = 'C:\\Users\\Administrator\\Desktop\\保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'
    const fileInput = await page.$('#file-input')
    await fileInput.uploadFile(celanPath)

    await new Promise(r => setTimeout(r, 2000))

    await page.evaluate(() => {
        const book = document.querySelector('.skeuo-book') || document.querySelector('.jane-book-card')
        if (book) book.click()
    })

    await new Promise(r => setTimeout(r, 4000))

    const secInfo = await page.evaluate(async () => {
        const fv = document.querySelector('foliate-view')
        const sections = fv.book?.sections || []
        const list = sections.map((s, idx) => ({
            index: idx,
            id: s.id,
            href: s.href || s.name || s.path
        }))
        return { sections: list }
    })

    console.log('Book sections:\n', JSON.stringify(secInfo, null, 2))

    await browser.close()
    server.close()
    process.exit(0)
})
