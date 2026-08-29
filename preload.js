const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    platform: process.platform,

    // Dialogs & File Stream
    openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
    readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),

    // Window Controls
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    toggleFullscreen: () => ipcRenderer.send('window:toggleFullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),

    // App events (e.g. OS file association open)
    onOpenFile: (callback) => {
        const listener = (_event, fileInfo) => callback(fileInfo)
        ipcRenderer.on('app:open-file', listener)
        return () => ipcRenderer.removeListener('app:open-file', listener)
    },

    // WebDAV / Nutstore Cloud Sync APIs
    syncTestConnection: (config) => ipcRenderer.invoke('sync:testConnection', config),
    syncFetchRemote: (config) => ipcRenderer.invoke('sync:fetchRemote', config),
    syncSaveRemote: (config, data) => ipcRenderer.invoke('sync:saveRemote', { config, data }),
    syncGetConfig: () => ipcRenderer.invoke('sync:getConfig'),
    syncSaveConfig: (config) => ipcRenderer.invoke('sync:saveConfig', config),

    // System Shell & App Info
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    checkGitHubRelease: (repo) => ipcRenderer.invoke('updater:checkRelease', repo)
})
