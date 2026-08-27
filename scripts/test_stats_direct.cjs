const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

async function testStatsDirect() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security']
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1360, height: 900 })

    page.on('console', msg => console.log('PAGE LOG:', msg.text()))
    page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()))

    await page.goto('http://localhost:8088/index.html?v=' + Date.now(), { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 1500))

    const statsInfo = await page.evaluate(async () => {
        // Trigger click on stats nav
        const btn = document.getElementById('nav-cat-stats')
        if (btn) btn.click()
        await new Promise(r => setTimeout(r, 600))

        const container = document.getElementById('stats-dashboard-container')
        const chart = document.getElementById('stats-distribution-chart')
        const heroTime = document.getElementById('stats-hero-time')?.innerText
        const bars = chart?.querySelectorAll('.chart-bar-col')?.length || 0

        return {
            containerDisplay: container ? container.style.display : 'not found',
            heroTime,
            barsCount: bars,
            tabActive: document.querySelector('.stats-tab-btn.active')?.dataset?.mode
        }
    })
    console.log('Stats Info:', statsInfo)

    await page.screenshot({ path: 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_stats_direct.png' })
    
    // Test clicking other tabs
    await page.evaluate(() => {
        document.querySelector('.stats-tab-btn[data-mode="week"]')?.click()
    })
    await new Promise(r => setTimeout(r, 500))
    await page.screenshot({ path: 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_stats_week.png' })

    await page.evaluate(() => {
        document.querySelector('.stats-tab-btn[data-mode="total"]')?.click()
    })
    await new Promise(r => setTimeout(r, 500))
    await page.screenshot({ path: 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_stats_total.png' })

    await browser.close()
    console.log('STATS SCREENSHOTS SAVED SUCCESSFULLY!')
}

testStatsDirect().catch(console.error)
