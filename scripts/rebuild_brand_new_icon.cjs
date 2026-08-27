const fs = require('fs')
const path = require('path')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const root = path.join(__dirname, '..')
const assetsDir = path.join(root, 'assets')
const buildDir = path.join(root, 'build')
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true })

const userLogoPng = 'C:/Users/Administrator/.gemini/antigravity/brain/bd426518-f7bf-4095-8900-a49687157128/.user_uploaded/media_1787757303864.png'

async function buildIcons() {
    console.log('[REBUILD BRAND ICON] Reading user leaf logo from:', userLogoPng)
    const logoBase64 = fs.readFileSync(userLogoPng).toString('base64')

    const tmpUserDataDir = path.join(__dirname, `../.pup_brand_icon_${Date.now()}`)
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true,
        userDataDir: tmpUserDataDir,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    })

    const page = await browser.newPage()

    // 1. Extract transparent monochrome/emerald leaf logo (512x512)
    const extractHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; }
        body { width: 512px; height: 512px; background: transparent; overflow: hidden; }
        canvas { width: 512px; height: 512px; }
      </style>
    </head>
    <body>
      <canvas id="cv" width="512" height="512"></canvas>
      <img id="src" src="data:image/png;base64,${logoBase64}" style="display:none;" />
      <script>
        const img = document.getElementById('src');
        img.onload = () => {
            const cv = document.getElementById('cv');
            const ctx = cv.getContext('2d');
            
            const pad = 24;
            ctx.drawImage(img, pad, pad, 512 - pad * 2, 512 - pad * 2);
            
            const imgData = ctx.getImageData(0, 0, 512, 512);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                const r = d[i];
                const g = d[i+1];
                const b = d[i+2];
                const a = d[i+3];
                
                const lum = 0.299 * r + 0.587 * g + 0.587 * b;
                
                if (lum > 235) {
                    d[i+3] = 0;
                } else {
                    const lineAlpha = (1 - (lum / 235)) * (a / 255);
                    // Deep Linden emerald color #1a4d3d
                    d[i] = 26;    // R: 26
                    d[i+1] = 77;  // G: 77
                    d[i+2] = 61;  // B: 61
                    d[i+3] = Math.min(255, Math.round(lineAlpha * 255 * 1.35));
                }
            }
            ctx.putImageData(imgData, 0, 0);
            window.__EXTRACT_DONE = true;
        };
      </script>
    </body>
    </html>
    `

    await page.setViewport({ width: 512, height: 512 })
    await page.setContent(extractHtml, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__EXTRACT_DONE === true)

    const transparentLeaf512 = await page.evaluate(() => {
        return document.getElementById('cv').toDataURL('image/png')
    })

    const logoLeafPath = path.join(assetsDir, 'logo-leaf.png')
    const logoLeafBuf = Buffer.from(transparentLeaf512.replace(/^data:image\/png;base64,/, ''), 'base64')
    fs.writeFileSync(logoLeafPath, logoLeafBuf)
    console.log('[REBUILD BRAND ICON] Saved assets/logo-leaf.png (clean transparent line art)')

    // 2. Generate Apple/Fluent Style Squircle App Icon in Multi-resolutions
    const renderSquircleHtml = (size) => `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          width: 100vw;
          height: 100vh;
          background: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .squircle-bg {
          width: 90%;
          height: 90%;
          border-radius: 22.5%;
          background: linear-gradient(150deg, #ffffff 0%, #f4fbf7 60%, #e5f4ec 100%);
          box-shadow: 0 4% 14% rgba(20, 60, 45, 0.2), 0 1% 4% rgba(0, 0, 0, 0.08);
          border: 1px solid rgba(26, 77, 61, 0.18);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }
        .squircle-bg::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 42%;
          background: linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 100%);
          border-radius: 22.5% 22.5% 50% 50%;
          pointer-events: none;
        }
        .leaf-logo {
          width: 74%;
          height: 74%;
          object-fit: contain;
          filter: drop-shadow(0 2px 5px rgba(20, 60, 45, 0.18));
        }
      </style>
    </head>
    <body>
      <div class="squircle-bg">
        <img class="leaf-logo" id="leaf-img" src="${transparentLeaf512}" />
      </div>
    </body>
    </html>
    `

    const sizes = [256, 128, 64, 48, 32, 16]
    const pngBuffers = []

    for (const size of sizes) {
        await page.setViewport({ width: size, height: size })
        await page.setContent(renderSquircleHtml(size), { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => document.getElementById('leaf-img')?.complete === true)
        const buf = await page.screenshot({ omitBackground: true })
        pngBuffers.push({ size, buffer: buf })
        console.log(`  Rendered squircle ${size}x${size} (${buf.length} bytes)`)

        if (size === 256) {
            fs.writeFileSync(path.join(assetsDir, 'icon.png'), buf)
            fs.writeFileSync(path.join(buildDir, 'icon.png'), buf)
        }
    }

    await browser.close()

    // 3. Create Multi-resolution Windows ICO
    console.log('[REBUILD BRAND ICON] Packaging into multi-resolution icon.ico...')
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

    fs.writeFileSync(path.join(assetsDir, 'icon.ico'), icoBuffer)
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer)
    console.log(`[REBUILD BRAND ICON] Successfully generated icon.ico (${icoBuffer.length} bytes, 6 resolutions: ${sizes.join(', ')})`)

    return true
}

buildIcons().then(() => {
    console.log('[REBUILD BRAND ICON] All icons built successfully!')
    process.exit(0)
}).catch(err => {
    console.error('[REBUILD BRAND ICON] Error:', err)
    process.exit(1)
})
