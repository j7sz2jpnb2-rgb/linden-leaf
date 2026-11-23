// services/webdav.js - Native Node.js & Browser WebDAV Client
// Supports Nextcloud, ownCloud, NAS, Jianguoyun, and standard WebDAV servers.
const path = typeof require !== 'undefined' ? require('path') : null

function isWebdavEnglish(localeOverride) {
    if (localeOverride) {
        return String(localeOverride).toLowerCase().startsWith('en')
    }
    try {
        if (typeof document !== 'undefined' && document.documentElement?.dataset?.locale) {
            return document.documentElement.dataset.locale.toLowerCase().startsWith('en')
        }
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('linden_locale')
            if (saved) return saved.toLowerCase().startsWith('en')
        }
        if (typeof globalThis !== 'undefined' && globalThis.__lindenLocale) {
            return String(globalThis.__lindenLocale).toLowerCase().startsWith('en')
        }
        if (typeof navigator !== 'undefined' && navigator.language) {
            return !navigator.language.toLowerCase().startsWith('zh')
        }
    } catch {
        // Ignore storage/global access restrictions
    }
    return false
}

function wdMsg(zh, en, localeOverride) {
    return isWebdavEnglish(localeOverride) ? en : zh
}

class WebDAVService {
    /**
     * Strictly sanitize file name to eliminate path traversal and invalid characters
     * Preserves all Unicode letters (including Chinese/Japanese/Korean), numbers, dots, and hyphens.
     */
    static sanitizeFileName(rawName) {
        if (!rawName) return 'unnamed_book'
        // Strip directory traversal dots and normalize separators
        const flattened = String(rawName).replace(/[\\/]+/g, '_').replace(/\.{2,}/g, '')
        const noDots = flattened.replace(/^[_.\s]+/, '')
        // Strictly remove illegal filesystem/URI characters: : * ? " < > | # % & + and control characters
        // Explicitly PRESERVE all Unicode characters (Chinese, Japanese, etc.)
        let safe = noDots.replace(/[:*?"<>|#%&+\x00-\x1f\x7f]/gu, '_').replace(/\s+/g, '_')
        if (safe.length > 180) {
            const dotIdx = safe.lastIndexOf('.')
            if (dotIdx > 0 && dotIdx >= safe.length - 10) {
                const ext = safe.slice(dotIdx)
                const base = safe.slice(0, 180 - ext.length)
                safe = `${base}${ext}`
            } else {
                safe = safe.slice(0, 180)
            }
        }
        return safe || 'book_file'
    }

    /**
     * Clean and normalize URL path while strictly preserving base origin
     */
    static normalizeUrl(baseUrl, subPath = '', locale = null) {
        let base = (baseUrl || '').trim()
        if (!base.startsWith('http://') && !base.startsWith('https://')) {
            base = 'https://' + base
        }
        if (!base.endsWith('/')) {
            base += '/'
        }

        const baseUrlObj = new URL(base)
        if (baseUrlObj.protocol !== 'http:' && baseUrlObj.protocol !== 'https:') {
            throw new Error(wdMsg('WebDAV 服务器地址必须使用 HTTP 或 HTTPS 协议', 'WebDAV server URL must use the HTTP or HTTPS protocol', locale))
        }
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
        let credentials
        if (typeof Buffer !== 'undefined') {
            credentials = Buffer.from(`${u}:${p}`, 'utf8').toString('base64')
        } else {
            credentials = btoa(unescape(encodeURIComponent(`${u}:${p}`)))
        }
        return `Basic ${credentials}`
    }

    /**
     * Resilient fetch wrapper with automatic HTTP 429 (Rate Limit) backoff
     * Parses Retry-After header and applies exponential backoff
     */
    static async fetchWithRetry(url, options, maxRetries = 2) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let res
            try {
                res = await fetch(url, options)
            } catch (netErr) {
                // Retry transient network socket errors (ECONNRESET, ETIMEDOUT, socket hangup)
                if (attempt < maxRetries && netErr.name !== 'TimeoutError' && !netErr.message?.includes('aborted')) {
                    console.warn(`[WebDAV] Transient network glitch (${netErr.message}), retrying in 1.5s (${attempt + 1}/${maxRetries})...`)
                    await new Promise(r => setTimeout(r, 1500))
                    continue
                }
                throw netErr
            }

            if (res.status === 429 && attempt < maxRetries) {
                const retryAfterHeader = res.headers.get('retry-after')
                let delayMs = parseInt(retryAfterHeader || '0', 10) * 1000
                if (!delayMs || isNaN(delayMs) || delayMs <= 0) {
                    delayMs = (attempt + 1) * 3000 // 3s, 6s exponential backoff
                }
                console.warn(`[WebDAV] Hit HTTP 429 Rate Limit. Backing off ${delayMs}ms before retry (${attempt + 1}/${maxRetries})...`)
                await new Promise(r => setTimeout(r, delayMs))
                continue
            }
            return res
        }
    }

    static _ensuredDirs = new Set()

    /**
     * Ensure remote directory (and any parent directories) exist on WebDAV server
     */
    static async ensureDirectory(serverUrl, username, password, remoteDir = 'LindenLeaf', forceCheck = false, locale = null) {
        const cacheKey = `${serverUrl}|${remoteDir}`
        if (!forceCheck && this._ensuredDirs.has(cacheKey)) {
            return { success: true, url: this.normalizeUrl(serverUrl, remoteDir + '/', locale) }
        }

        const auth = this.getAuthHeader(username, password)
        const segments = (remoteDir || 'LindenLeaf')
            .split('/')
            .map(s => s.trim())
            .filter(s => s.length > 0 && s !== '.' && s !== '..')

        let currentPath = ''
        let lastUrl = this.normalizeUrl(serverUrl, '', locale)
        let allSuccess = true

        for (const seg of segments) {
            currentPath = currentPath ? `${currentPath}/${seg}` : seg
            const targetUrl = this.normalizeUrl(serverUrl, currentPath + '/', locale)
            lastUrl = targetUrl

            try {
                // Check if directory exists with PROPFIND
                const checkRes = await this.fetchWithRetry(targetUrl, {
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
                    const mkcolRes = await this.fetchWithRetry(targetUrl, {
                        method: 'MKCOL',
                        headers: { 'Authorization': auth },
                        signal: AbortSignal.timeout(12000)
                    })

                    if (mkcolRes.status === 201 || mkcolRes.status === 200 || mkcolRes.status === 405) {
                        continue
                    }
                }
                allSuccess = false
            } catch (err) {
                allSuccess = false
                console.warn('[WebDAV] ensureDirectory segment warning:', currentPath, err.message)
            }
        }

        if (allSuccess) {
            this._ensuredDirs.add(cacheKey)
        }
        return { success: allSuccess, url: lastUrl }
    }

    /**
     * Test connection & authentication to WebDAV server
     */
    static async testConnection({ serverUrl, username, password, remoteDir = 'LindenLeaf', locale }) {
        if (!serverUrl || !username || !password) {
            return { success: false, error: wdMsg('请填写完整的服务器地址、账号（邮箱）和应用授权密码', 'Please fill in the server URL, username (email), and app password', locale) }
        }

        const auth = this.getAuthHeader(username, password)
        const baseUrl = this.normalizeUrl(serverUrl, '', locale)

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
                return { success: false, error: wdMsg('认证失败：请检查账号（邮箱）与应用授权密码是否正确', 'Authentication failed: please check your username (email) and app password', locale) }
            }

            if (!rootRes.ok && rootRes.status !== 207) {
                // Fallback attempt with OPTIONS
                const optRes = await fetch(baseUrl, {
                    method: 'OPTIONS',
                    headers: { 'Authorization': auth },
                    signal: AbortSignal.timeout(10000)
                })
                if (optRes.status === 401 || optRes.status === 403) {
                    return { success: false, error: wdMsg('认证失败：账号或授权密码错误', 'Authentication failed: incorrect username or app password', locale) }
                }
            }

            // 2. Ensure / create remote app directory
            const dirRes = await this.ensureDirectory(serverUrl, username, password, remoteDir, false, locale)
            if (!dirRes.success && dirRes.error) {
                console.warn('[WebDAV] Directory check warning:', dirRes.error)
            }

            return {
                success: true,
                message: wdMsg('连接 WebDAV 服务器成功！远程应用目录已就绪。', 'Connected to WebDAV server! Remote app directory is ready.', locale),
                targetUrl: dirRes.url
            }
        } catch (err) {
            if (err.name === 'TimeoutError') {
                return { success: false, error: wdMsg('连接超时，请检查网络连接或服务器地址', 'Connection timed out. Please check your network or server URL', locale) }
            }
            return { success: false, error: wdMsg(`连接失败: ${err.message}`, `Connection failed: ${err.message}`, locale) }
        }
    }

    /**
     * Fetch remote sync state JSON
     */
    static async fetchRemoteState({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName = 'linden_sync_data.json', locale }) {
        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/${fileName}`, locale)
        const auth = this.getAuthHeader(username, password)

        try {
            const res = await this.fetchWithRetry(fileUrl, {
                method: 'GET',
                headers: {
                    'Authorization': auth,
                    'Accept': 'application/json, text/plain, */*'
                },
                signal: AbortSignal.timeout(18000)
            })

            const etag = res.headers.get('etag') || null

            if (res.status === 404) {
                return { exists: false, data: null, etag: null }
            }

            if (!res.ok) {
                return { exists: false, error: wdMsg(`拉取云端数据失败 (HTTP ${res.status}): ${res.statusText}`, `Failed to fetch cloud data (HTTP ${res.status}): ${res.statusText}`, locale), etag: null }
            }

            const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
            if (contentLength > 20 * 1024 * 1024) {
                return { exists: false, error: wdMsg('云端同步文件大小超过 20MB 安全上限', 'Cloud sync file exceeds the 20 MB safety limit', locale), etag: null }
            }

            const text = await res.text()
            if (!text || !text.trim()) {
                return { exists: false, data: null, etag }
            }
            if (text.length > 20 * 1024 * 1024) {
                return { exists: false, error: wdMsg('云端同步文件大小超过 20MB 安全上限', 'Cloud sync file exceeds the 20 MB safety limit', locale), etag: null }
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
    static async saveRemoteState({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName = 'linden_sync_data.json', data, etag = null, summaryMarkdown = null, locale }) {
        // Ensure remote directory exists first
        await this.ensureDirectory(serverUrl, username, password, remoteDir, false, locale)

        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/${fileName}`, locale)
        const auth = this.getAuthHeader(username, password)
        const jsonString = JSON.stringify(data)
        const payloadBytes = (new TextEncoder().encode(jsonString)).length
        if (payloadBytes > 20 * 1024 * 1024) {
            const sizeMb = (payloadBytes / 1024 / 1024).toFixed(1)
            return {
                success: false,
                error: wdMsg(`同步数据过大 (${sizeMb} MiB)，超过 20 MiB 限制`, `Sync payload is too large (${sizeMb} MiB), exceeding the 20 MiB limit`, locale)
            }
        }

        const headers = {
            'Authorization': auth,
            'Content-Type': 'application/json; charset=utf-8'
        }
        // RFC 7232: Weak ETags (starting with W/) must NOT be sent in If-Match header
        if (etag && typeof etag === 'string' && !etag.startsWith('W/')) {
            headers['If-Match'] = etag
        } else if (!etag) {
            headers['If-None-Match'] = '*'
        }

        try {
            const res = await this.fetchWithRetry(fileUrl, {
                method: 'PUT',
                headers,
                body: jsonString,
                signal: AbortSignal.timeout(25000)
            })

            if (res.status === 412) {
                return {
                    success: false,
                    isConflict: true,
                    error: wdMsg('云端同步冲突：云端数据已被其他设备更新，请重试', 'Cloud sync conflict: remote data was updated by another device. Please retry', locale)
                }
            }

            if (res.status === 200 || res.status === 201 || res.status === 204) {
                const newEtag = res.headers.get('etag') || null
                if (summaryMarkdown && typeof summaryMarkdown === 'string') {
                    try {
                        const mdUrl = this.normalizeUrl(serverUrl, `${remoteDir}/LindenLeaf_Reading_Notes_and_Stats.md`, locale)
                        await this.fetchWithRetry(mdUrl, {
                            method: 'PUT',
                            headers: {
                                'Authorization': auth,
                                'Content-Type': 'text/markdown; charset=utf-8'
                            },
                            body: summaryMarkdown,
                            signal: AbortSignal.timeout(20000)
                        })
                    } catch (mdErr) {
                        console.warn('[WebDAVService] Failed to upload summary markdown (non-blocking):', mdErr)
                    }
                }
                return { success: true, etag: newEtag, updatedAt: Date.now() }
            }

            if (res.status === 404) {
                this._ensuredDirs.clear()
            }

            return { success: false, error: wdMsg(`写入云端数据失败 (HTTP ${res.status})`, `Failed to write cloud data (HTTP ${res.status})`, locale) }
        } catch (err) {
            return { success: false, error: err.message }
        }
    }

    /**
     * Upload a single book binary file to WebDAV LindenLeaf/books/ directory
     */
    static async uploadBookBinary({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName, buffer, locale }) {
        if (!fileName || !buffer) {
            return { success: false, error: wdMsg('缺少文件名或图书内容', 'Missing filename or book content', locale) }
        }

        const safeFileName = this.sanitizeFileName(fileName)

        // Ensure both remoteDir and books subdirectory exist
        const booksSubdir = `${remoteDir}/books`
        await this.ensureDirectory(serverUrl, username, password, booksSubdir, false, locale)

        const fileUrl = this.normalizeUrl(serverUrl, `${booksSubdir}/${safeFileName}`, locale)
        const auth = this.getAuthHeader(username, password)

        const headers = {
            'Authorization': auth,
            'Content-Type': 'application/octet-stream'
        }

        try {
            let bodyData = buffer
            let byteLength = 0
            if (typeof Buffer !== 'undefined') {
                bodyData = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
                byteLength = bodyData.length
            } else if (buffer instanceof ArrayBuffer) {
                bodyData = new Uint8Array(buffer)
                byteLength = bodyData.byteLength
            } else if (buffer && buffer.buffer instanceof ArrayBuffer) {
                byteLength = buffer.byteLength
            } else {
                bodyData = buffer
                byteLength = buffer ? (buffer.byteLength || buffer.length || 0) : 0
            }
            // Adaptive timeout: base 60s + 2s per MB, capped between 60s and 10 minutes
            const timeoutMs = Math.min(600000, Math.max(60000, 60000 + Math.ceil(byteLength / (1024 * 1024)) * 2000))
            const res = await this.fetchWithRetry(fileUrl, {
                method: 'PUT',
                headers,
                body: bodyData,
                signal: AbortSignal.timeout(timeoutMs)
            })

            if (res.status === 200 || res.status === 201 || res.status === 204) {
                return { success: true, fileName: safeFileName, size: byteLength, uploadedAt: Date.now() }
            }

            if (res.status === 404) {
                this._ensuredDirs.clear()
            }

            return { success: false, error: wdMsg(`上传图书到云端失败 (HTTP ${res.status}): ${res.statusText}`, `Failed to upload book to cloud (HTTP ${res.status}): ${res.statusText}`, locale) }
        } catch (err) {
            return { success: false, error: err.message || wdMsg('上传异常', 'Upload error', locale) }
        }
    }

    /**
     * Download a single book binary file from WebDAV LindenLeaf/books/ directory
     */
    static async downloadBookBinary({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName, locale }) {
        if (!fileName) {
            return { success: false, error: wdMsg('缺少文件名', 'Missing filename', locale) }
        }

        const safeFileName = this.sanitizeFileName(fileName)
        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/books/${safeFileName}`, locale)
        const auth = this.getAuthHeader(username, password)

        try {
            const res = await this.fetchWithRetry(fileUrl, {
                method: 'GET',
                headers: {
                    'Authorization': auth,
                    'Accept': 'application/octet-stream, */*'
                },
                signal: AbortSignal.timeout(120000) // 120s timeout for download
            })

            if (res.status === 404) {
                return { success: false, isNotFound: true, error: wdMsg('云端图书文件不存在或已被删除', 'Cloud book file does not exist or has been deleted', locale) }
            }

            if (!res.ok) {
                return { success: false, error: wdMsg(`拉取云端图书失败 (HTTP ${res.status}): ${res.statusText}`, `Failed to download cloud book (HTTP ${res.status}): ${res.statusText}`, locale) }
            }

            // OOM / DoS prevention: enforce max file download size guard
            const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
            const MAX_ALLOWED_DOWNLOAD_BYTES = 250 * 1024 * 1024 // 250 MB
            if (contentLength > MAX_ALLOWED_DOWNLOAD_BYTES) {
                return { success: false, error: wdMsg('文件体积超出安全下载限制 (最大 250MB)', 'File size exceeds the 250 MB safety download limit', locale) }
            }

            // Stream reading with chunk accumulator (crucial: protects against Transfer-Encoding: chunked without Content-Length)
            if (res.body && typeof res.body.getReader === 'function') {
                const reader = res.body.getReader()
                const chunks = []
                let receivedBytes = 0

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    receivedBytes += value.byteLength
                    if (receivedBytes > MAX_ALLOWED_DOWNLOAD_BYTES) {
                        await reader.cancel('Download limit exceeded')
                        return { success: false, error: wdMsg('文件传输超出安全限制 (最大 250MB)，已主动熔断终止', 'File transfer exceeded the 250 MB safety limit and was aborted', locale) }
                    }
                    chunks.push(value)
                }

                if (typeof Buffer !== 'undefined') {
                    const nodeChunks = chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))
                    const totalBuffer = Buffer.concat(nodeChunks)
                    return {
                        success: true,
                        fileName: safeFileName,
                        size: totalBuffer.length,
                        buffer: totalBuffer.buffer.slice(totalBuffer.byteOffset, totalBuffer.byteOffset + totalBuffer.byteLength)
                    }
                } else {
                    const totalBytes = new Uint8Array(receivedBytes)
                    let offset = 0
                    for (const chunk of chunks) {
                        totalBytes.set(chunk, offset)
                        offset += chunk.byteLength
                    }
                    return {
                        success: true,
                        fileName: safeFileName,
                        size: totalBytes.byteLength,
                        buffer: totalBytes.buffer
                    }
                }
            }

            const arrayBuffer = await res.arrayBuffer()
            if (arrayBuffer.byteLength > MAX_ALLOWED_DOWNLOAD_BYTES) {
                return { success: false, error: wdMsg('文件体积超出安全下载限制 (最大 250MB)', 'File size exceeds the 250 MB safety download limit', locale) }
            }
            return {
                success: true,
                fileName: safeFileName,
                size: arrayBuffer.byteLength,
                buffer: arrayBuffer
            }
        } catch (err) {
            return { success: false, error: err.message || wdMsg('下载异常', 'Download error', locale) }
        }
    }

    /**
     * Delete a book binary file from WebDAV LindenLeaf/books/ directory
     */
    static async deleteBookBinary({ serverUrl, username, password, remoteDir = 'LindenLeaf', fileName, locale }) {
        if (!fileName) return { success: false, error: wdMsg('缺少文件名', 'Missing filename', locale) }

        const safeFileName = this.sanitizeFileName(fileName)
        const fileUrl = this.normalizeUrl(serverUrl, `${remoteDir}/books/${safeFileName}`, locale)
        const auth = this.getAuthHeader(username, password)

        try {
            const res = await this.fetchWithRetry(fileUrl, {
                method: 'DELETE',
                headers: { 'Authorization': auth },
                signal: AbortSignal.timeout(15000)
            })

            if (res.status === 200 || res.status === 204 || res.status === 404) {
                return { success: true, fileName: safeFileName }
            }

            return { success: false, error: wdMsg(`删除云端图书失败 (HTTP ${res.status})`, `Failed to delete cloud book (HTTP ${res.status})`, locale) }
        } catch (err) {
            return { success: false, error: err.message }
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WebDAVService;
}
if (typeof window !== 'undefined') {
    window.WebDAVService = WebDAVService;
}

