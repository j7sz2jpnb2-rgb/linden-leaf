import fs from 'fs'
import { makeZipLoader } from '../foliate-js-main/view.js'

const epubPath = 'C:/Users/Administrator/Desktop/保罗·策兰诗全集. 第二卷, 罂粟与记忆.epub'

async function inspectEpub() {
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
            console.log('Content snippet:\n', text)
        }
    }
}

inspectEpub().catch(console.error)
