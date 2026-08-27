const fs = require('fs')
const path = require('path')

/**
 * electron-builder afterPack hook
 * Prunes unused Chromium locale .pak files to reduce package and installation size.
 * Keeps: Simplified Chinese, Traditional Chinese, US English, GB English, Japanese, French, German.
 */
exports.default = async function(context) {
    const appOutDir = context.appOutDir
    console.log(`\n[afterPack] Running packaging optimization on: ${appOutDir}`)

    const localesDir = path.join(appOutDir, 'locales')
    const keepLocales = [
        'zh-CN.pak',
        'zh-TW.pak',
        'en-US.pak',
        'en-GB.pak',
        'ja.pak',
        'fr.pak',
        'de.pak'
    ]

    if (fs.existsSync(localesDir)) {
        const files = fs.readdirSync(localesDir)
        let removedCount = 0
        let savedBytes = 0

        for (const file of files) {
            if (!keepLocales.includes(file)) {
                const filePath = path.join(localesDir, file)
                try {
                    const stats = fs.statSync(filePath)
                    savedBytes += stats.size
                    fs.unlinkSync(filePath)
                    removedCount++
                } catch (e) {
                    console.warn(`[afterPack] Could not remove ${file}:`, e.message)
                }
            }
        }
        const savedMB = (savedBytes / (1024 * 1024)).toFixed(2)
        console.log(`[afterPack] Successfully pruned ${removedCount} unused locale files (saved ~${savedMB} MB disk space).`)
    } else {
        console.log('[afterPack] No locales directory found to prune.')
    }

    // Inject custom icon directly into Linden Leaf.exe
    try {
        const resedit = require('resedit')
        const iconIcoPath = path.join(__dirname, '../assets/icon.ico')
        const exePath = path.join(appOutDir, 'Linden Leaf.exe')
        if (fs.existsSync(iconIcoPath) && fs.existsSync(exePath)) {
            const iconBuf = fs.readFileSync(iconIcoPath)
            const iconFile = resedit.Data.IconFile.from(iconBuf)
            const exeBuf = fs.readFileSync(exePath)
            const exe = resedit.NtExecutable.from(exeBuf)
            const res = resedit.NtExecutableResource.from(exe)
            const existingEntries = resedit.Resource.IconGroupEntry.fromEntries(res.entries)
            const iconGroupID = existingEntries.length > 0 ? existingEntries[0].id : 1
            resedit.Resource.IconGroupEntry.replaceIconsForResource(
                res.entries,
                iconGroupID,
                1033,
                iconFile.icons.map(item => item.data)
            )
            res.outputResource(exe)
            fs.writeFileSync(exePath, Buffer.from(exe.generate()))
            console.log(`[afterPack] Injected custom Linden Leaf icon directly into ${exePath}`)
        }
    } catch (err) {
        console.warn('[afterPack] Icon injection warning:', err.message)
    }
}
