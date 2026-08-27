const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const userJpg = 'C:/Users/Administrator/.gemini/antigravity/brain/bd426518-f7bf-4095-8900-a49687157128/.user_uploaded/media_1787757292222.jpg'
const userPng = 'C:/Users/Administrator/.gemini/antigravity/brain/bd426518-f7bf-4095-8900-a49687157128/.user_uploaded/media_1787757303864.png'

const assetsDir = path.join(__dirname, '../assets')
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })

async function main() {
    console.log('[BUILD ICONS] Reading user images...')
    const jpgBase64 = fs.readFileSync(userJpg).toString('base64')
    const pngBase64 = fs.readFileSync(userPng).toString('base64')

    const tmpUserDataDir = path.join(__dirname, `../.pup_icon_${Date.now()}`)
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        userDataDir: tmpUserDataDir,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    })

    const page = await browser.newPage()

    // 1. Generate 512x512 App Icon (assets/icon.png)
    const iconPageHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          width: 100%;
          height: 100%;
          background: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .squircle-wrapper {
          width: 93.75%;
          height: 93.75%;
          border-radius: 22%;
          background: #ffffff;
          box-shadow: 0 4% 12% rgba(0,0,0,0.12), 0 1% 3% rgba(0,0,0,0.06);
          border: 1px solid rgba(0,0,0,0.08);
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .squircle-wrapper img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
      </style>
    </head>
    <body>
      <div class="squircle-wrapper">
        <img id="leaf-img" src="data:image/jpeg;base64,${jpgBase64}" />
      </div>
    </body>
    </html>
    `

    await page.setViewport({ width: 512, height: 512 })
    await page.setContent(iconPageHtml, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.getElementById('leaf-img')?.complete === true)
    
    const icon512Path = path.join(assetsDir, 'icon.png')
    await page.screenshot({ path: icon512Path, omitBackground: true })
    console.log('Saved assets/icon.png (512x512 squircle)')

    // 2. Generate Transparent Line-art Logo (assets/logo-leaf.png)
    const transparentLogoHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          width: 256px;
          height: 256px;
          background: transparent;
          overflow: hidden;
        }
        canvas {
          width: 256px;
          height: 256px;
        }
      </style>
    </head>
    <body>
      <canvas id="cv" width="256" height="256"></canvas>
      <img id="src-png" src="data:image/png;base64,${pngBase64}" style="display:none;" />
    </body>
    </html>
    `
    await page.setViewport({ width: 256, height: 256 })
    await page.setContent(transparentLogoHtml, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
        const img = document.getElementById('src-png')
        const cv = document.getElementById('cv')
        const ctx = cv.getContext('2d')
        ctx.drawImage(img, 0, 0, 256, 256)
        const imgData = ctx.getImageData(0, 0, 256, 256)
        const data = imgData.data
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i+1], b = data[i+2]
            if (r > 240 && g > 240 && b > 240) {
                data[i+3] = 0
            } else {
                const brightness = (r + g + b) / 3
                if (brightness > 175) {
                    data[i+3] = Math.round(255 * (255 - brightness) / 80)
                }
            }
        }
        ctx.putImageData(imgData, 0, 0)
    })

    const logoLeafPath = path.join(assetsDir, 'logo-leaf.png')
    await page.screenshot({ path: logoLeafPath, omitBackground: true })
    console.log('Saved assets/logo-leaf.png (transparent line art)')

    // 3. Multi-resolution Responsive ICO Generator (256, 128, 64, 48, 32, 16)
    const sizes = [256, 128, 64, 48, 32, 16]
    const pngBuffers = []

    for (const size of sizes) {
        await page.setViewport({ width: size, height: size })
        await page.setContent(iconPageHtml, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => document.getElementById('leaf-img')?.complete === true)
        const buf = await page.screenshot({ omitBackground: true })
        console.log(`Rendered icon size ${size}x${size}: ${buf.length} bytes`)
        pngBuffers.push({ size, buffer: buf })
    }

    // Build standard Windows ICO
    const count = pngBuffers.length
    const header = Buffer.alloc(6)
    header.writeUInt16LE(0, 0) // Reserved
    header.writeUInt16LE(1, 2) // Type 1 = ICO
    header.writeUInt16LE(count, 4) // Number of images

    let offset = 6 + count * 16
    const entries = []

    for (const item of pngBuffers) {
        const entry = Buffer.alloc(16)
        const s = item.size >= 256 ? 0 : item.size
        entry.writeUInt8(s, 0) // Width
        entry.writeUInt8(s, 1) // Height
        entry.writeUInt8(0, 2) // Color palette
        entry.writeUInt8(0, 3) // Reserved
        entry.writeUInt16LE(1, 4) // Color planes
        entry.writeUInt16LE(32, 6) // Bits per pixel
        entry.writeUInt32LE(item.buffer.length, 8) // Size of image data
        entry.writeUInt32LE(offset, 12) // Offset of image data
        entries.push(entry)
        offset += item.buffer.length
    }

    const icoBuffer = Buffer.concat([
        header,
        ...entries,
        ...pngBuffers.map(p => p.buffer)
    ])

    const icoPath = path.join(assetsDir, 'icon.ico')
    fs.writeFileSync(icoPath, icoBuffer)
    console.log(`Saved assets/icon.ico (${icoBuffer.length} bytes, ${count} resolutions: ${sizes.join(', ')})`)

    await browser.close()
    console.log('[BUILD ICONS] All icon assets successfully generated!')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
