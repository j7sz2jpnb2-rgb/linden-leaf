const fs = require('fs')
const path = require('path')
const resedit = require('resedit')

const root = path.join(__dirname, '..')
const iconIcoPath = path.join(root, 'assets/icon.ico')
const iconBuf = fs.readFileSync(iconIcoPath)
const iconFile = resedit.Data.IconFile.from(iconBuf)

function injectExeIcon(targetExePath) {
    if (!fs.existsSync(targetExePath)) {
        console.log(`[INJECT ICON] Skipping missing target: ${targetExePath}`)
        return false
    }
    try {
        console.log(`[INJECT ICON] Injecting icon into: ${targetExePath}`)
        const exeBuf = fs.readFileSync(targetExePath)
        const exe = resedit.NtExecutable.from(exeBuf)
        const res = resedit.NtExecutableResource.from(exe)

        // Find existing icon group ID or default to 1 / 101 / 'IDI_ICON1'
        const existingEntries = resedit.Resource.IconGroupEntry.fromEntries(res.entries)
        const iconGroupID = existingEntries.length > 0 ? existingEntries[0].id : 1

        resedit.Resource.IconGroupEntry.replaceIconsForResource(
            res.entries,
            iconGroupID,
            1033,
            iconFile.icons.map(item => item.data)
        )

        res.outputResource(exe)
        const outBuf = Buffer.from(exe.generate())
        fs.writeFileSync(targetExePath, outBuf)
        console.log(`[INJECT ICON] Successfully injected icon into: ${targetExePath} (${outBuf.length} bytes)`)
        return true
    } catch (e) {
        console.error(`[INJECT ICON] Failed to inject icon into ${targetExePath}:`, e.message)
        return false
    }
}

// 1. Ensure build directory exists with icon.ico and icon.png
const buildDir = path.join(root, 'build')
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true })
fs.copyFileSync(iconIcoPath, path.join(buildDir, 'icon.ico'))
fs.copyFileSync(path.join(root, 'assets/icon.png'), path.join(buildDir, 'icon.png'))
console.log('[INJECT ICON] Synced build/icon.ico and build/icon.png')

// 2. Inject into dist targets
const targets = [
    path.join(root, 'dist/win-unpacked/Linden Leaf.exe'),
    path.join(root, 'dist/Linden Leaf-v0.1.0-Portable.exe'),
    path.join(root, 'dist/Linden Leaf-v0.1.0-Setup.exe')
]

targets.forEach(t => injectExeIcon(t))
