const { app, BrowserWindow, Menu, dialog, ipcMain, shell, screen, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')

app.name = 'Linden Leaf'

let mainWindow = null
const pendingFilesToOpen = []

// All supported e-book and document file extensions
const SUPPORTED_EXTENSIONS = ['.epub', '.pdf', '.docx', '.txt', '.md', '.mobi', '.azw', '.azw3', '.fb2', '.cbz']

// Parse command line arguments for file paths to open
function getFilePathFromArgv(argv) {
    const isPackaged = app.isPackaged
    const args = isPackaged ? argv.slice(1) : argv.slice(2)
    for (const arg of args) {
        if (!arg.startsWith('--') && !arg.startsWith('-') && fs.existsSync(arg)) {
            const ext = path.extname(arg).toLowerCase()
            if (SUPPORTED_EXTENSIONS.includes(ext)) {
                return arg
            }
        }
    }
    return null
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

        // Flush any pending files to open
        while (pendingFilesToOpen.length > 0) {
            const fp = pendingFilesToOpen.shift()
            sendOpenFile(fp)
        }
    })

    mainWindow.on('close', () => {
        saveWindowState()
    })

    mainWindow.on('closed', () => {
        mainWindow = null
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
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
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

    const filesData = []
    for (const fp of result.filePaths) {
        try {
            const buffer = await fs.promises.readFile(fp)
            filesData.push({
                filePath: fp,
                filename: path.basename(fp),
                buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            })
        } catch (err) {
            console.error('Failed reading selected file:', fp, err)
        }
    }
    return filesData
})

ipcMain.handle('dialog:saveFile', async (_event, options = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const result = await dialog.showSaveDialog(mainWindow, {
        title: options.title || '导出文件',
        defaultPath: options.defaultName || 'export.txt',
        filters: options.filters || [{ name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePath
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

function loadSyncConfig() {
    try {
        if (fs.existsSync(getSyncConfigPath())) {
            const data = fs.readFileSync(getSyncConfigPath(), 'utf8')
            const config = JSON.parse(data)
            if (config.password && config._pwdEncrypted && safeStorage && safeStorage.isEncryptionAvailable()) {
                try {
                    config.password = safeStorage.decryptString(Buffer.from(config.password, 'base64'))
                } catch (e) {
                    console.warn('Failed to decrypt sync password, using fallback:', e)
                }
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
        remoteDir: 'LindenLeaf',
        autoSyncOnStartup: true,
        autoSyncOnBookClose: true,
        lastSyncTime: null,
        lastSyncStatus: null
    }
}

function saveSyncConfig(config) {
    try {
        const configToSave = { ...config }
        if (configToSave.password && safeStorage && safeStorage.isEncryptionAvailable()) {
            configToSave.password = safeStorage.encryptString(configToSave.password).toString('base64')
            configToSave._pwdEncrypted = true
        }
        fs.writeFileSync(getSyncConfigPath(), JSON.stringify(configToSave, null, 2), 'utf8')
        return true
    } catch (e) {
        console.error('Failed to save sync config:', e)
        return false
    }
}

ipcMain.handle('sync:getConfig', () => {
    return loadSyncConfig()
})

ipcMain.handle('sync:saveConfig', (_event, config) => {
    return saveSyncConfig(config)
})

ipcMain.handle('sync:testConnection', async (_event, config) => {
    return await WebDAVService.testConnection(config)
})

ipcMain.handle('sync:fetchRemote', async (_event, config) => {
    return await WebDAVService.fetchRemoteState(config)
})

ipcMain.handle('sync:saveRemote', async (_event, { config, data }) => {
    return await WebDAVService.saveRemoteState({ ...config, data })
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

// Single Instance Lock & File Association Routing
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    app.quit()
    process.exit(0)
} else {
    const startupFile = getFilePathFromArgv(process.argv)
    if (startupFile) pendingFilesToOpen.push(startupFile)

    app.on('second-instance', (_event, argv) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()

            const fileFromSecondInstance = getFilePathFromArgv(argv)
            if (fileFromSecondInstance) {
                sendOpenFile(fileFromSecondInstance)
            }
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
