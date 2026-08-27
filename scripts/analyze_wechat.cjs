const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')
const fs = require('fs')

async function analyzeWeChatHighlight() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 1000 })

    const imgBase64 = fs.readFileSync('C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/.user_uploaded/media_1787720045886.png').toString('base64')
    const imgSrc = 'data:image/png;base64,' + imgBase64

    await page.goto('about:blank')

    const analysis = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await new Promise(r => { img.onload = r })

        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)

        const imgData = ctx.getImageData(0, 0, img.width, img.height)
        const data = imgData.data

        // Background color
        const bgR = data[0], bgG = data[1], bgB = data[2]

        const isHighlight = (r, g, b) => {
            return (r > 235 && g < 225 && b < 228) && !(r < 60 && g < 60 && b < 60)
        }

        let sampleColors = []
        for (let y = 100; y < 140; y++) {
            for (let x = 100; x < 200; x++) {
                const idx = (y * img.width + x) * 4
                const r = data[idx], g = data[idx+1], b = data[idx+2]
                if (isHighlight(r, g, b)) {
                    sampleColors.push({ r, g, b, hex: '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('') })
                }
            }
        }

        // Trace upper edge and lower edge of line 2 across X
        const line2Edges = []
        for (let x = 40; x < img.width - 40; x += 20) {
            let topY = -1, bottomY = -1
            for (let y = 140; y < 320; y++) {
                const idx = (y * img.width + x) * 4
                const r = data[idx], g = data[idx+1], b = data[idx+2]
                if (isHighlight(r, g, b)) {
                    if (topY === -1) topY = y
                    bottomY = y
                }
            }
            if (topY !== -1) {
                line2Edges.push({ x, topY, bottomY, height: bottomY - topY })
            }
        }

        // Right-most contour of line 2
        let rightEdgeProfile = []
        for (let y = 140; y < 310; y += 5) {
            let maxX = -1
            for (let x = img.width - 200; x < img.width; x++) {
                const idx = (y * img.width + x) * 4
                const r = data[idx], g = data[idx+1], b = data[idx+2]
                if (isHighlight(r, g, b)) {
                    maxX = Math.max(maxX, x)
                }
            }
            if (maxX !== -1) {
                rightEdgeProfile.push({ y, maxX })
            }
        }

        // Left-most contour of line 2
        let leftEdgeProfile = []
        for (let y = 140; y < 310; y += 5) {
            let minX = 9999
            for (let x = 0; x < 200; x++) {
                const idx = (y * img.width + x) * 4
                const r = data[idx], g = data[idx+1], b = data[idx+2]
                if (isHighlight(r, g, b)) {
                    minX = Math.min(minX, x)
                }
            }
            if (minX !== 9999) {
                leftEdgeProfile.push({ y, minX })
            }
        }

        return {
            dimensions: { w: img.width, h: img.height },
            bg: { r: bgR, g: bgG, b: bgB },
            sampleColors: sampleColors.slice(0, 8),
            line2Edges: line2Edges,
            rightEdgeProfile: rightEdgeProfile,
            leftEdgeProfile: leftEdgeProfile
        }
    }, imgSrc)

    console.log('Analysis Result:\n', JSON.stringify(analysis, null, 2))
    await browser.close()
}

analyzeWeChatHighlight().catch(console.error)
