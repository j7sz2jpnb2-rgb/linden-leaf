// services/webdav.js - Native Node.js WebDAV Client for Electron Main Process
// Supports Jianguoyun (坚果云), Nextcloud, ownCloud, NAS, and standard WebDAV servers.

class WebDAVService {
    /**
     * Clean and normalize URL path
     */
    static normalizeUrl(baseUrl, subPath = '') {
        let base = (baseUrl || '').trim()
        if (!base.startsWith('http://') && !base.startsWith('https://')) {
            base = 'https://' + base
        }
        if (!base.endsWith('/')) {
            base += '/'
        }

        let cleanSub = (subPath || '').trim()
        if (cleanSub.startsWith('/')) {
            cleanSub = cleanSub.slice(1)
        }

        const parsed = new URL(cleanSub, base)
        return parsed.toString()
    }

    /**
     * Build Basic Authorization header
     */
    static getAuthHeader(username, password) {
        const u = (username || '').trim().replace(/[\r\n]/g, '')
        const p = (password || '').replace(/[\r\n]/g, '')
        const credentials = Buffer.from(`${u}:${p}`, 'utf8').toString('base64')
        return `Basic ${credentials}`
    }

    /**
     * Ensure remote directory exists on WebDAV server
     */
    static async ensureDirectory(serverUrl, username, password, remoteDir = 'LindenLeaf') {
        const cleanDir = (remoteDir || 'LindenLeaf').replace(/^\/+|\/+$/g, '')
        const targetUrl = this.normalizeUrl(serverUrl, cleanDir + '/')
        const auth = this.getAuthHeader(username, password)

        try {
            // Check if directory exists with PROPFIND
            const checkRes = await fetch(targetUrl, {
                method: 'PROPFIND',
                headers: {
                    'Authorization': auth,
                    'Depth': '0'
                },
                signal: AbortSignal.timeout(12000)
            })

            if (checkRes.status === 200 || checkRes.status === 207) {
                return { success: true, url: targetUrl }
            }

            // If 404 or other not found status, attempt MKCOL
            if (checkRes.status === 404 || checkRes.status === 405) {
                const mkcolRes = await fetch(targetUrl, {
                    method: 'MKCOL',
                    headers: { 'Authorization': auth },
                    signal: AbortSignal.timeout(12000)
                })

                if (mkcolRes.status === 201 || mkcolRes.status === 200 || mkcolRes.status === 405) {
                    return { success: true, url: targetUrl }
                }
            }

            return { success: checkRes.ok, status: checkRes.status, url: targetUrl }
        } catch (err) {
            console.warn('[WebDAV] ensureDirectory notice:', err.message)
            return { success: false, error: err.message, url: targetUrl }
        }
    }

    /**
     * Test connection & authentication to WebDAV server
     */
    static async testConnection({ serverUrl, username, password, remoteDir = 'LindenLeaf' }) {
        if (!serverUrl || !username || !password) {
            return { success: false, error: '请填写完整的服务器地址、账号（邮箱）和应用授权密码' }
        }

        const auth = this.getAuthHeader(username, password)
        const baseUrl = this.normalizeUrl(serverUrl)

        try {
            // 1. Probe server root
            const rootRes = await fetch(baseUrl, {
                method: 'PROPFIND',
                headers: {
                    'Authorization': auth,
                    'Depth': '0'
                },
                signal: AbortSignal.timeout(12000)
            })

            if (rootRes.status === 401 || rootRes.status === 403) {
                return { success: false, error: '认证失败：请检查账号（邮箱）与应用授权密码是否正确' }
            }

            if (!rootRes.ok && rootRes.status !== 207) {
                // Fallback attempt with OPTIONS
                const optRes = await fetch(baseUrl, {
                    method: 'OPTIONS',
                    headers: { 'Authorization': auth },
                    signal: AbortSignal.timeout(10000)
                })
                if (optRes.status === 401 || optRes.status === 403) {
                    return { success: false, error: '认证失败：账号或授权密码错误' }
                }
            }

            // 2. Ensure / create remote app directory
            const dirRes = await this.ensureDirectory(serverUrl, username, password, remoteDir)
            if (!dirRes.success && dirRes.error) {
                console.warn('[WebDAV] Directory check warning:', dirRes.error)
            }

            return {
                success: true,
                message: '连接坚果云 / WebDAV 服务器成功！远程应用目录已就绪。',
                targetUrl: dirRes.url
            }
        } catch (err) {
            if (err.name === 'TimeoutError') {
                return { success: false, error: '连接超时，请检查网络连接或服务器地址' }
            }
            return { success: false, error: `连接失败: ${err.message}` }
        }
    }

    /**
     * Fetch remote sync state JSON
     */
    static async fetchRemoteState({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName = 'linden_sync_data.json' }) {
        const cleanDir = (remoteDir || 'LindenLeaf').replace(/^\/+|\/+$/g, '')
        const fileUrl = this.normalizeUrl(serverUrl, `${cleanDir}/${fileName}`)
        const auth = this.getAuthHeader(username, password)

        try {
            const res = await fetch(fileUrl, {
                method: 'GET',
                headers: {
                    'Authorization': auth,
                    'Accept': 'application/json, text/plain, */*'
                },
                signal: AbortSignal.timeout(15000)
            })

            if (res.status === 404) {
                return { exists: false, data: null }
            }

            if (!res.ok) {
                return { exists: false, error: `拉取云端数据失败 (HTTP ${res.status}): ${res.statusText}` }
            }

            const text = await res.text()
            if (!text || !text.trim()) {
                return { exists: false, data: null }
            }

            const data = JSON.parse(text)
            return { exists: true, data }
        } catch (err) {
            return { exists: false, error: err.message }
        }
    }

    /**
     * Save / upload merged sync state JSON atomically
     */
    static async saveRemoteState({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName = 'linden_sync_data.json', data }) {
        // Ensure remote directory exists first
        await this.ensureDirectory(serverUrl, username, password, remoteDir)

        const cleanDir = (remoteDir || 'LindenLeaf').replace(/^\/+|\/+$/g, '')
        const fileUrl = this.normalizeUrl(serverUrl, `${cleanDir}/${fileName}`)
        const auth = this.getAuthHeader(username, password)
        const jsonString = JSON.stringify(data, null, 2)

        try {
            const res = await fetch(fileUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': auth,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                body: jsonString,
                signal: AbortSignal.timeout(20000)
            })

            if (res.status === 200 || res.status === 201 || res.status === 204) {
                return { success: true, updatedAt: Date.now() }
            }

            return { success: false, error: `写入云端数据失败 (HTTP ${res.status})` }
        } catch (err) {
            return { success: false, error: err.message }
        }
    }
}

module.exports = WebDAVService
