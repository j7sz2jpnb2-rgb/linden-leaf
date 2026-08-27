const http = require('http')
const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const ROOT = 'C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader'

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.epub': 'application/epub+zip',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.cbz': 'application/vnd.comicbook+zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

const server = http.createServer((req, res) => {
    let relPath = req.url.split('?')[0].replace(/^\/+/, '')
    if (!relPath) relPath = 'index.html'
    const fullPath = path.join(ROOT, relPath)

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            return res.end('404 Not Found')
        }
        const ext = path.extname(fullPath).toLowerCase()
        const contentType = MIME[ext] || 'application/octet-stream'
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        })
        res.end(data)
    })
})

const PORT = 9120
server.listen(PORT, async () => {
    console.log(`[CUSTOM LISTS TEST] Running on http://localhost:${PORT}`)
    try {
        const tmpUserDataDir = path.join(__dirname, `../.pup_lists_${Date.now()}`)
        const browser = await puppeteer.launch({
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            headless: true,
            userDataDir: tmpUserDataDir,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        })

        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 860 })

        const errors = []
        const warnings = []

        page.on('dialog', async d => {
            console.log('  [Dialog Handled]', d.message())
            await d.accept()
        })
        page.on('console', msg => {
            const text = msg.text()
            if (msg.type() === 'error' && !text.includes('favicon')) {
                errors.push(text)
            }
            if (msg.type() === 'warn') {
                warnings.push(text)
            }
        })
        page.on('pageerror', err => errors.push(err.toString()))

        console.log('\n>>> 1. Navigate to Linden Leaf & Load Sample Books...')
        await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#file-input')
        await page.waitForFunction(() => window.app != null)

        await page.evaluate(async () => {
            await window.app.loadSampleBooks()
        })
        await new Promise(r => setTimeout(r, 2000))

        console.log('\n>>> 2. Verify Initial Custom Lists in Sidebar...')
        const initialListsCheck = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.custom-list-nav-item'))
            return {
                count: items.length,
                lists: items.map(el => ({
                    id: el.dataset.listId,
                    title: el.querySelector('.list-title')?.innerText?.trim(),
                    icon: el.querySelector('.list-icon')?.innerText?.trim(),
                    badge: el.querySelector('.list-count-badge')?.innerText?.trim()
                }))
            }
        })
        console.log('Initial Lists Check:', initialListsCheck)
        if (initialListsCheck.count < 3) {
            throw new Error('Default custom lists were not loaded')
        }

        console.log('\n>>> 3. Create a New Custom List ("🚀 科幻与未来畅想")...')
        const createListCheck = await page.evaluate(async () => {
            const app = window.app
            app.openCreateListModal()
            await new Promise(r => setTimeout(r, 200))

            document.getElementById('input-custom-list-name').value = '科幻与未来畅想'
            // Click the rocket icon 🚀
            const rocketBtn = Array.from(document.querySelectorAll('.icon-pick-btn')).find(b => b.innerText === '🚀')
            if (rocketBtn) rocketBtn.click()

            await app.handleCreateListConfirm()
            await new Promise(r => setTimeout(r, 800))

            const activeList = document.querySelector('.custom-list-nav-item.active')
            const title = document.getElementById('current-category-title')?.innerText

            return {
                activeListTitle: activeList?.querySelector('.list-title')?.innerText,
                activeListIcon: activeList?.querySelector('.list-icon')?.innerText,
                headerCategoryTitle: title,
                shelfCategory: app.shelfCategory
            }
        })
        console.log('Create List Check:', createListCheck)

        console.log('\n>>> 4. Add Book to Custom List via Manage Book Modal...')
        const addBookCheck = await page.evaluate(async () => {
            const app = window.app
            const books = await window.db.getAllBooks()
            const docxBook = books.find(b => b.format === 'docx' || (b.title && b.title.includes('白皮书')))
            if (!docxBook) return { error: 'No docx book found' }

            // Open manage modal for docxBook
            await app.openManageBookListsModal(docxBook.id)
            await new Promise(r => setTimeout(r, 300))

            // Check the newly created list checkbox
            const targetCb = document.querySelector(`#book-lists-checkbox-container input[data-list-id="${app.shelfCategory}"]`)
            if (targetCb) targetCb.checked = true

            await app.handleSaveBookLists()
            await new Promise(r => setTimeout(r, 600))

            const activeList = document.querySelector('.custom-list-nav-item.active')
            const countBadge = activeList?.querySelector('.list-count-badge')?.innerText
            const shelfBooks = document.querySelectorAll('.skeuo-book').length

            return {
                listBookCount: countBadge,
                shelfVisibleBooks: shelfBooks
            }
        })
        console.log('Add Book Check:', addBookCheck)

        console.log('\n>>> 5. Test Batch Adding Books via Header "+" Action...')
        const batchAddCheck = await page.evaluate(async () => {
            const app = window.app
            await app.openBatchAddToListModal()
            await new Promise(r => setTimeout(r, 300))

            // Check all book checkboxes in modal
            const cbs = Array.from(document.querySelectorAll('#batch-add-books-container input[type="checkbox"]'))
            cbs.forEach(cb => cb.checked = true)

            await app.handleConfirmBatchAddList()
            await new Promise(r => setTimeout(r, 800))

            const activeList = document.querySelector('.custom-list-nav-item.active')
            const countBadge = activeList?.querySelector('.list-count-badge')?.innerText
            const shelfBooks = document.querySelectorAll('.skeuo-book').length

            return {
                listBookCount: countBadge,
                shelfVisibleBooks: shelfBooks
            }
        })
        console.log('Batch Add Check:', batchAddCheck)

        console.log('\n>>> 6. Test Switching between Categories and Lists...')
        const switchCheck = await page.evaluate(async () => {
            const app = window.app
            document.getElementById('nav-cat-all')?.click()
            await new Promise(r => setTimeout(r, 400))
            const allCount = document.querySelectorAll('.skeuo-book').length

            document.getElementById('nav-cat-favorite')?.click()
            await new Promise(r => setTimeout(r, 400))
            const favTitle = document.getElementById('current-category-title')?.innerText

            return {
                allBooksCount: allCount,
                favoriteTitle: favTitle
            }
        })
        console.log('Category Switch Check:', switchCheck)

        console.log('\n>>> 7. Test Deleting Custom List...')
        const deleteCheck = await page.evaluate(async () => {
            const app = window.app
            const listsBefore = document.querySelectorAll('.custom-list-nav-item').length
            const delBtn = document.querySelector('.custom-list-nav-item .list-del-btn')
            if (delBtn) {
                delBtn.click()
                await new Promise(r => setTimeout(r, 800))
            }
            const listsAfter = document.querySelectorAll('.custom-list-nav-item').length

            return {
                listsBefore,
                listsAfter
            }
        })
        console.log('Delete List Check:', deleteCheck)

        console.log('\n==========================================')
        console.log(`CUSTOM LISTS SYSTEM VERIFIED! Total Errors: ${errors.length}, Warnings: ${warnings.length}`)
        if (errors.length > 0) {
            console.log('Errors caught:\n', errors)
        }
        console.log('==========================================')

        await browser.close()
        server.close()
        process.exit(errors.length === 0 ? 0 : 1)
    } catch (e) {
        console.error('Custom lists test error:', e)
        server.close()
        process.exit(1)
    }
})
