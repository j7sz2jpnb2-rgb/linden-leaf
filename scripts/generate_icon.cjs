const fs = require('fs')
const path = require('path')

const assetsDir = path.join(__dirname, '..', 'assets')
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="96" fill="none" stroke="#334155" stroke-width="4" opacity="0.5"/>
  <g filter="url(#shadow)" transform="translate(56, 64)">
    <path d="M200,40 C100,40 40,110 40,220 C40,320 120,360 200,360 C280,360 360,320 360,220 C360,110 300,40 200,40 Z" fill="url(#grad)"/>
    <path d="M200,80 L200,320" stroke="#ffffff" stroke-width="8" stroke-linecap="round" opacity="0.85"/>
    <path d="M200,140 Q260,110 300,130" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,140 Q140,110 100,130" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,200 Q270,170 310,200" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,200 Q130,170 90,200" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,260 Q260,240 290,270" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,260 Q140,240 110,270" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.75"/>
    <path d="M200,310 L200,380 L215,365 L230,380 L230,310 Z" fill="#f59e0b" opacity="0.95"/>
  </g>
</svg>`

fs.writeFileSync(path.join(assetsDir, 'icon.svg'), svgContent)
console.log('Saved assets/icon.svg')

// Convert SVG to PNG using Puppeteer
async function generatePngAndIco() {
    const puppeteer = require('../node_modules/puppeteer-core')
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 })
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden;">${svgContent}</body></html>`)
    
    const pngPath = path.join(assetsDir, 'icon.png')
    await page.screenshot({ path: pngPath, omitBackground: true })
    console.log('Saved assets/icon.png')

    // Create 256x256 png for ICO
    await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 })
    const png256 = await page.screenshot({ omitBackground: true })

    // Generate standard Windows ICO file from PNG buffer
    const icoHeader = Buffer.alloc(6)
    icoHeader.writeUInt16LE(0, 0)
    icoHeader.writeUInt16LE(1, 2)
    icoHeader.writeUInt16LE(1, 4)

    const entry = Buffer.alloc(16)
    entry.writeUInt8(0, 0) // 0 means 256px
    entry.writeUInt8(0, 1) // 0 means 256px
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png256.length, 8) // size of image data
    entry.writeUInt32LE(6 + 16, 12) // offset

    const icoBuffer = Buffer.concat([icoHeader, entry, png256])
    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer)
    console.log('Saved assets/icon.ico')

    await browser.close()
}

generatePngAndIco().catch(console.error)
