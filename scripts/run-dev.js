// scripts/run-dev.js
// 启动 Linden Leaf 桌面端开发环境并实时输出控制台日志，支持传递打开文件参数

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

let electronPath
try {
    electronPath = require('electron')
} catch (e) {
    const localElectron = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
    const siblingElectron = path.resolve(__dirname, '..', '..', 'universal-reader', 'node_modules', 'electron', 'dist', 'electron.exe')
    if (fs.existsSync(localElectron)) {
        electronPath = localElectron
    } else if (fs.existsSync(siblingElectron)) {
        electronPath = siblingElectron
    } else {
        electronPath = process.platform === 'win32' ? 'electron.cmd' : 'electron'
    }
}
const appPath = path.resolve(__dirname, '..')

const extraArgs = process.argv.slice(2)
const args = [appPath, '--enable-logging', ...extraArgs]

console.log('[Runner] 正在启动 Linden Leaf...')
console.log('[Runner] Electron 运行时:', electronPath)
console.log('[Runner] 启动参数:', args.join(' '))

const child = spawn(electronPath, args, {
    cwd: appPath,
    stdio: ['inherit', 'pipe', 'pipe']
})

child.stdout.on('data', (data) => {
    process.stdout.write(`[Electron STDOUT] ${data}`)
})

child.stderr.on('data', (data) => {
    process.stderr.write(`[Electron STDERR] ${data}`)
})

child.on('close', (code) => {
    console.log(`[Runner] Electron 进程已退出，退出码: ${code}`)
})

child.on('error', (err) => {
    console.error('[Runner] 启动失败:', err)
})
