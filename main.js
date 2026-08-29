const { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')

app.name = 'Linden Leaf'

let mainWindow = null
let isRendererReady = false
const pendingFilesToOpen = []

// All supported e-book and document file extensions
const SUPPORTED_EXTENSIONS = ['.epub', '.pdf', '.docx', '.txt', '.md', '.mobi', '.azw', '.azw3', '.fb2', '.cbz']

// Parse command line arguments for file paths to open
function getFilePathsFromArgv(argv) {
    const isPackaged = app.isPackaged
    const args = isPackaged ? argv.slice(1) : argv.slice(2)
    const files = []
    for (const arg of args) {
        if (!arg.startsWith('--') && !arg.startsWith('-') && fs.existsSync(arg)) {
            const ext = path.extname(arg).toLowerCase()
            if (SUPPORTED_EXTENSIONS.includes(ext)) {
                files.push(arg)
            }
        }
    }
    return files
}

// Window state management with display bounds validation
function getWindowStatePath() {
    return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState() {
    try {
        const data = fs.readFileSync(getWindowStatePath(), 'utf8')
        const state = JSON.parse(data)
        const displays = screen.getAllDisplays()
        
        // Check if saved bounds are visible on any active display
        if (typeof state.x === 'number' && typeof state.y === 'number' && state.width > 300 && state.height > 200) {
            const isVisible = displays.some(display => {
                const { x, y, width, height } = display.workArea
                return (
                    state.x >= x - 50 &&
                    state.y >= y - 50 &&
                    state.x + state.width <= x + width + 50 &&
                    state.y + state.height <= y + height + 50
                )
            })
            if (isVisible) return state
        }
        return { width: 1360, height: 880, isMaximized: false }
    } catch {
        return { width: 1360, height: 880, isMaximized: false }
    }
}

function saveWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
        const isMaximized = mainWindow.isMaximized()
        const bounds = mainWindow.getBounds()
        fs.writeFileSync(getWindowStatePath(), JSON.stringify({
            ...bounds,
            isMaximized
        }))
    } catch (err) {
        console.error('Failed to save window state:', err)
    }
}

function createWindow() {
    const state = loadWindowState()

    mainWindow = new BrowserWindow({
        width: state.width || 1360,
        height: state.height || 880,
        x: state.x,
        y: state.y,
        minWidth: 960,
        minHeight: 640,
        title: 'Linden Leaf - 现代化全格式电子书阅读器',
        backgroundColor: '#f5efe6',
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            preload: path.join(__dirname, 'preload.js')
        }
    })

    Menu.setApplicationMenu(null)

    mainWindow.loadFile(path.join(__dirname, 'index.html'))

    mainWindow.once('ready-to-show', () => {
        if (state.isMaximized) {
            mainWindow.maximize()
        }
        mainWindow.show()
    })

    mainWindow.webContents.on('did-finish-load', () => {
        isRendererReady = false
    })

    mainWindow.on('close', () => {
        saveWindowState()
    })

    mainWindow.on('closed', () => {
        mainWindow = null
        isRendererReady = false
    })

    // Secure navigation & external link handling
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        if (!navigationUrl.startsWith('file://')) {
            event.preventDefault()
            try {
                const parsed = new URL(navigationUrl)
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                    shell.openExternal(navigationUrl)
                }
            } catch (e) {
                console.warn('Blocked invalid navigation URL:', navigationUrl)
            }
        }
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url)
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
                shell.openExternal(url)
            }
        } catch (e) {
            console.warn('Blocked invalid external link:', url)
        }
        return { action: 'deny' }
    })
}

async function sendOpenFile(filePath) {
    if (!isRendererReady || !mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
        pendingFilesToOpen.push(filePath)
        return
    }
    try {
        const filename = path.basename(filePath)
        const buffer = await fs.promises.readFile(filePath)
        mainWindow.webContents.send('app:open-file', {
            filePath,
            filename,
            buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        })
    } catch (err) {
        console.error('Failed to read and send file:', filePath, err)
    }
}

// IPC Handlers
ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入图书到 Linden Leaf 书架',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: '所有支持的电子书与文档', extensions: ['epub', 'pdf', 'docx', 'txt', 'md', 'mobi', 'azw', 'azw3', 'fb2', 'cbz'] },
            { name: 'EPUB 电子书', extensions: ['epub'] },
            { name: 'PDF 文档', extensions: ['pdf'] },
            { name: 'Word 文档 (.docx)', extensions: ['docx'] },
            { name: 'Kindle 图书 (MOBI / AZW / AZW3)', extensions: ['mobi', 'azw', 'azw3'] },
            { name: 'TXT / Markdown 文档', extensions: ['txt', 'md'] },
            { name: '漫画与归档 (CBZ / FB2)', extensions: ['cbz', 'fb2'] },
            { name: '所有文件', extensions: ['*'] }
        ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths.map(fp => ({
        filePath: fp,
        filename: path.basename(fp)
    }))
})

ipcMain.handle('file:readBuffer', async (_event, filePath) => {
    try {
        if (!filePath || typeof filePath !== 'string') return null
        const buffer = await fs.promises.readFile(filePath)
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (err) {
        console.error('Failed reading selected file:', filePath, err)
        return null
    }
})

// Window controls
ipcMain.on('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
})

ipcMain.on('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
    }
})

ipcMain.on('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
})

ipcMain.handle('window:isMaximized', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false
})

ipcMain.on('window:toggleFullscreen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
})

ipcMain.handle('window:isFullscreen', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isFullScreen() : false
})

const WebDAVService = require('./services/webdav')

function getSyncConfigPath() {
    return path.join(app.getPath('userData'), 'sync-config.json')
}

function loadSyncConfig(includePassword = false) {
    try {
        const configPath = getSyncConfigPath()
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8')
            const config = JSON.parse(data)
            if (config.password && config._pwdEncrypted && safeStorage && safeStorage.isEncryptionAvailable()) {
                try {
                    config.password = safeStorage.decryptString(Buffer.from(config.password, 'base64'))
                } catch (e) {
                    console.warn('Failed to decrypt sync password, using fallback:', e)
                }
            }
            if (!includePassword) {
                config.hasPassword = !!config.password
                config.password = '' // Never expose decrypted plaintext password to renderer process
            }
            return config
        }
    } catch (e) {
        console.warn('Failed to load sync config:', e)
    }
    return {
        enabled: false,
        serverType: 'jianguoyun',
        serverUrl: 'https://dav.jianguoyun.com/dav/',
        username: '',
        password: '',
        hasPassword: false,
        remoteDir: 'LindenLeaf',
        autoSyncOnStartup: true,
        autoSyncOnBookClose: true,
        lastSyncTime: null,
        lastSyncStatus: null
    }
}

function saveSyncConfig(config) {
    try {
        const configPath = getSyncConfigPath()
        const tempPath = configPath + '.tmp'
        const existing = loadSyncConfig(true)
        const configToSave = { ...existing, ...config }

        // If password is not provided in update, preserve existing stored password
        if (config.password === undefined || config.password === '') {
            configToSave.password = existing.password || ''
        }

        if (configToSave.password && safeStorage && safeStorage.isEncryptionAvailable()) {
            configToSave.password = safeStorage.encryptString(configToSave.password).toString('base64')
            configToSave._pwdEncrypted = true
        }

        // Atomic file write to avoid file corruption during crash
        fs.writeFileSync(tempPath, JSON.stringify(configToSave, null, 2), 'utf8')
        fs.renameSync(tempPath, configPath)
        return true
    } catch (e) {
        console.error('Failed to save sync config:', e)
        return false
    }
}

function getResolvedSyncConfig(incomingConfig) {
    const saved = loadSyncConfig(true)
    const finalConfig = { ...saved, ...(incomingConfig || {}) }
    if ((!incomingConfig?.password || incomingConfig.password === '') && saved.password) {
        finalConfig.password = saved.password
    }
    return finalConfig
}

ipcMain.handle('sync:getConfig', () => {
    return loadSyncConfig(false)
})

ipcMain.handle('sync:saveConfig', (_event, config) => {
    return saveSyncConfig(config)
})

ipcMain.handle('sync:testConnection', async (_event, config) => {
    const resolved = getResolvedSyncConfig(config)
    return await WebDAVService.testConnection(resolved)
})

ipcMain.handle('sync:fetchRemote', async (_event, config) => {
    const resolved = getResolvedSyncConfig(config)
    return await WebDAVService.fetchRemoteState(resolved)
})

ipcMain.handle('sync:saveRemote', async (_event, { config, data, etag }) => {
    const resolved = getResolvedSyncConfig(config)
    return await WebDAVService.saveRemoteState({ ...resolved, data, etag })
})

// Renderer Handshake IPC (Eliminates cold-start setTimeout race condition)
ipcMain.handle('app:rendererReady', () => {
    isRendererReady = true
    while (pendingFilesToOpen.length > 0) {
        const fp = pendingFilesToOpen.shift()
        sendOpenFile(fp)
    }
    return true
})

// External Browser & App Info IPC
ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        try {
            await shell.openExternal(url)
            return true
        } catch (e) {
            console.error('Failed to open external URL:', e)
            return false
        }
    }
    return false
})

ipcMain.handle('app:getVersion', () => {
    return app.getVersion()
})

// GitHub Releases Update Checker IPC (Dual channel: REST API + Zero-Rate-Limit Web Redirect Fallback)
const https = require('https')

function checkViaWebRedirect(targetRepo) {
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'github.com',
            path: `/${targetRepo}/releases/latest`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        }, res => {
            if (res.statusCode === 302 && res.headers.location) {
                const tagMatch = res.headers.location.match(/tag\/(.+)$/)
                if (tagMatch) {
                    const tag = tagMatch[1]
                    resolve({
                        success: true,
                        statusCode: 200,
                        data: {
                            tag_name: tag,
                            name: `Linden Leaf ${tag}`,
                            html_url: res.headers.location,
                            body: '可在 GitHub 查看最新版本发布与下载资源。'
                        }
                    })
                    return
                }
            } else if (res.statusCode === 404) {
                resolve({ success: false, statusCode: 404, error: `未在 GitHub 仓库 [${targetRepo}] 找到任何已发布的 Release 版本。` })
                return
            }
            resolve({ success: false, error: '未能通过网页获取到最新版本标签' })
        })
        req.on('error', err => resolve({ success: false, error: `网络连接失败: ${err.message}` }))
        req.setTimeout(12000, () => {
            req.destroy()
            resolve({ success: false, error: '连接 GitHub 超时，请检查网络。' })
        })
        req.end()
    })
}

ipcMain.handle('updater:checkRelease', async (_event, repo) => {
    const targetRepo = (repo || 'j7sz2jpnb2-rgb/linden-leaf').trim()
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.github.com',
            path: `/repos/${targetRepo}/releases/latest`,
            method: 'GET',
            headers: {
                'User-Agent': 'LindenLeaf-Desktop/1.1.0',
                'Accept': 'application/vnd.github.v3+json'
            }
        }, res => {
            let data = ''
            res.on('data', d => data += d)
            res.on('end', async () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data)
                        resolve({ success: true, statusCode: 200, data: json })
                    } catch (e) {
                        resolve({ success: false, statusCode: 200, error: '解析 GitHub 返回数据失败' })
                    }
                } else if (res.statusCode === 403) {
                    // API rate limit exceeded -> seamlessly fallback to web redirect (no rate limits)
                    console.log('GitHub API rate limited (403), falling back to zero-rate-limit web redirect...')
                    const fallbackRes = await checkViaWebRedirect(targetRepo)
                    resolve(fallbackRes)
                } else if (res.statusCode === 404) {
                    resolve({ success: false, statusCode: 404, error: `未在 GitHub 仓库 [${targetRepo}] 找到任何已发布的 Release 版本。` })
                } else {
                    const fallbackRes = await checkViaWebRedirect(targetRepo)
                    if (fallbackRes.success) resolve(fallbackRes)
                    else resolve({ success: false, statusCode: res.statusCode, error: `GitHub API 返回 HTTP ${res.statusCode}` })
                }
            })
        })
        req.on('error', async err => {
            console.log('GitHub API error, trying web redirect fallback...', err.message)
            const fallbackRes = await checkViaWebRedirect(targetRepo)
            if (fallbackRes.success) resolve(fallbackRes)
            else resolve({ success: false, error: `网络连接失败: ${err.message}` })
        })
        req.setTimeout(10000, async () => {
            req.destroy()
            const fallbackRes = await checkViaWebRedirect(targetRepo)
            if (fallbackRes.success) resolve(fallbackRes)
            else resolve({ success: false, error: '连接 GitHub 超时，请检查网络。' })
        })
        req.end()
    })
})

// Single Instance Lock & File Association Routing
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
    process.exit(0)
} else {
    const startupFiles = getFilePathsFromArgv(process.argv)
    startupFiles.forEach(f => pendingFilesToOpen.push(f))

    app.on('second-instance', (_event, argv) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()

            const filesFromSecondInstance = getFilePathsFromArgv(argv)
            filesFromSecondInstance.forEach(f => sendOpenFile(f))
        }
    })

    app.whenReady().then(() => {
        createWindow()

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow()
            }
        })
    })
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})
