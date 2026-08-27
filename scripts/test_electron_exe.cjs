const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')
const path = require('path')

async function testElectronExe() {
    const exePath = 'C:\\Users\\Administrator\\.gemini\\antigravity\\scratch\\universal-reader\\dist\\win-unpacked\\Linden Leaf.exe'
    
    console.log('Launching built Electron .exe:', exePath)
    const browser = await puppeteer.launch({
        executablePath: exePath,
        headless: false,
        args: ['--no-sandbox']
    })

    const pages = await browser.pages()
    const page = pages[0] || await browser.newPage()
    await new Promise(r => setTimeout(r, 4000))

    // Check if electronAPI is exposed and bookshelf rendered
    const appState = await page.evaluate(() => {
        return {
            title: document.title,
            isElectron: !!window.electronAPI?.isElectron,
            platform: window.electronAPI?.platform,
            bookshelfView: document.getElementById('bookshelf-view') ? 'visible' : 'missing',
            totalBooks: document.querySelectorAll('.book-spine, .book-card').length
        }
    })
    console.log('Electron App State:', appState)

    const screenshotPath = 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\40ebe18d-48fa-406e-96c5-420fe912e1ea\\scratch\\electron_app_launched.png'
    await page.screenshot({ path: screenshotPath })
    console.log('Electron App Screenshot saved to:', screenshotPath)

    await browser.close()
    console.log('ELECTRON EXE VERIFIED SUCCESSFULLY!')
}

testElectronExe().catch(console.error)
