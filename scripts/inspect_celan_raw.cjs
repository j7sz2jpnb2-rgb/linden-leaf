const fs = require('fs')
const yauzl = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/foliate-js-main/vendor/yauzl.js')

// Let's inspect the epub internal structure
const epubPath = 'C:/Users/Administrator/Desktop/保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'

// Read zip using Node
const AdmZip = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/adm-zip') || null
console.log('Epub size:', fs.statSync(epubPath).size)

async function inspectEpub() {
    const { makeZipLoader } = await import('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/foliate-js-main/view.js')
    const fileBuf = fs.readFileSync(epubPath)
    const fileBlob = new Blob([fileBuf])
    const loader = await makeZipLoader(fileBlob)
    console.log('Zip entries count:', loader.entries.length)
    const htmlEntries = loader.entries.filter(e => /\.(html|xhtml|xml|htm)$/i.test(e.filename))
    console.log('HTML entries count:', htmlEntries.length)

    for (const e of htmlEntries) {
        const text = await loader.loadText(e.filename)
        if (text.includes('阿克拉') || text.includes('没人替我照应') || text.includes('Akra')) {
            console.log('MATCHED FILE:', e.filename)
            console.log('Content snippet:\n', text.slice(0, 1000))
        }
    }
}

inspectEpub().catch(console.error)
