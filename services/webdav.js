// services/webdav.js - Native Node.js WebDAV Client for Electron Main Process
// Supports Jianguoyun (坚果云), Nextcloud, ownCloud, NAS, and standard WebDAV servers.

class WebDAVService {
    /**
     * Clean and normalize URL path while strictly preserving base origin
     */
    static normalizeUrl(baseUrl, subPath = '') {
        let base = (baseUrl || '').trim()
        if (!base.startsWith('http://') && !base.startsWith('https://')) {
            base = 'https://' + base
        }
        if (!base.endsWith('/')) {
            base += '/'
        }

        const baseUrlObj = new URL(base)
        const isDir = typeof subPath === 'string' && subPath.endsWith('/')
        const segments = (subPath || '')
            .split('/')
            .map(s => s.trim())
            .filter(s => s.length > 0 && s !== '.' && s !== '..')

        const basePath = baseUrlObj.pathname.endsWith('/') ? baseUrlObj.pathname : baseUrlObj.pathname + '/'
        let combinedPath = basePath + segments.map(encodeURIComponent).join('/')
        if (isDir && !combinedPath.endsWith('/')) combinedPath += '/'
        baseUrlObj.pathname = combinedPath.replace(/\/+/g, '/')
        return baseUrlObj.toString()
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
     * Ensure remote directory (and any parent directories) exist on WebDAV server
     */
    static async ensureDirectory(serverUrl, username, password, remoteDir = 'LindenLeaf') {
        const auth = this.getAuthHeader(username, password)
        const segments = (remoteDir || 'LindenLeaf')
            .split('/')
            .map(s => s.trim())
            .filter(s => s.length > 0 && s !== '.' && s !== '..')

        let currentPath = ''
        let lastUrl = this.normalizeUrl(serverUrl, '')

        for (const seg of segments) {
            currentPath = currentPath ? `${currentPath}/${seg}` : seg
            const targetUrl = this.normalizeUrl(serverUrl, currentPath + '/')
            lastUrl = targetUrl

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
                    continue
                }

                // If not found, create directory with MKCOL
                if (checkRes.status === 404 || checkRes.status === 405) {
                    const mkcolRes = await fetch(targetUrl, {
                        method: 'MKCOL',
                        headers: { 'Authorization': auth },
                        signal: AbortSignal.timeout(12000)
                    })

                    if (mkcolRes.status === 201 || mkcolRes.status === 200 || mkcolRes.status === 405) {
                        continue
                    }
                }
            } catch (err) {
                console.warn('[WebDAV] ensureDirectory segment warning:', currentPath, err.message)
            }
        }

        return { success: true, url: lastUrl }
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
                message: '连接 WebDAV 服务器成功！远程应用目录已就绪。',
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
        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/${fileName}`)
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

            const etag = res.headers.get('etag') || null

            if (res.status === 404) {
                return { exists: false, data: null, etag: null }
            }

            if (!res.ok) {
                return { exists: false, error: `拉取云端数据失败 (HTTP ${res.status}): ${res.statusText}`, etag: null }
            }

            const text = await res.text()
            if (!text || !text.trim()) {
                return { exists: false, data: null, etag }
            }

            const data = JSON.parse(text)
            return { exists: true, data, etag }
        } catch (err) {
            return { exists: false, error: err.message, etag: null }
        }
    }

    /**
     * Save / upload merged sync state JSON with optimistic concurrency
     */
    static async saveRemoteState({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName = 'linden_sync_data.json', data, etag = null }) {
        // Ensure remote directory exists first
        await this.ensureDirectory(serverUrl, username, password, remoteDir)

        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/${fileName}`)
        const auth = this.getAuthHeader(username, password)
        const jsonString = JSON.stringify(data, null, 2)

        const headers = {
            'Authorization': auth,
            'Content-Type': 'application/json; charset=utf-8'
        }
        if (etag) {
            headers['If-Match'] = etag
        }

        try {
            const res = await fetch(fileUrl, {
                method: 'PUT',
                headers,
                body: jsonString,
                signal: AbortSignal.timeout(20000)
            })

            if (res.status === 412) {
                return {
                    success: false,
                    isConflict: true,
                    error: '云端同步冲突：云端数据已被其他设备更新，请重试'
                }
            }

            if (res.status === 200 || res.status === 201 || res.status === 204) {
                const newEtag = res.headers.get('etag') || null
                return { success: true, etag: newEtag, updatedAt: Date.now() }
            }

            return { success: false, error: `写入云端数据失败 (HTTP ${res.status})` }
        } catch (err) {
            return { success: false, error: err.message }
        }
    }
}

module.exports = WebDAVService
