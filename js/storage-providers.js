// js/storage-providers.js - Unified Storage Provider Interface & Cloud Drive Implementations (F08, F09, F10)

import { platformBridge as defaultBridge } from './platformBridge.js';

/**
 * Base Abstract Storage Provider Interface (F08)
 */
export class StorageProvider {
    constructor(id, name) {
        this.id = id;
        this.name = name;
    }

    /**
     * Authenticate or verify existing connection
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async authenticate() {
        throw new Error('StorageProvider.authenticate must be implemented');
    }

    /**
     * List files in remote directory / app space
     * @param {string} [prefix]
     * @returns {Promise<Array<{ name: string, size: number, etag: string, modifiedTime: number }>>}
     */
    async listFiles(prefix = '') {
        throw new Error('StorageProvider.listFiles must be implemented');
    }

    /**
     * Read file content
     * @param {string} path
     * @returns {Promise<{ content: string, etag?: string, modifiedTime?: number }>}
     */
    async readFile(path) {
        throw new Error('StorageProvider.readFile must be implemented');
    }

    /**
     * Write file content with optimistic locking
     * @param {string} path
     * @param {string|Uint8Array} content
     * @param {{ ifMatch?: string }} [options]
     * @returns {Promise<{ success: boolean, etag?: string, conflict?: boolean }>}
     */
    async writeFile(path, content, options = {}) {
        throw new Error('StorageProvider.writeFile must be implemented');
    }

    /**
     * Delete file
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async deleteFile(path) {
        throw new Error('StorageProvider.deleteFile must be implemented');
    }

    /**
     * Return list of missing external prerequisites (e.g. OAuth App ID, User Consent)
     * @returns {string[]}
     */
    getMissingPrerequisites() {
        return [];
    }
}

/**
 * WebDAV Storage Provider (Existing Production Provider wrapped into unified interface)
 */
export class WebDavStorageProvider extends StorageProvider {
    constructor(config = {}) {
        super('webdav', 'WebDAV (Nutstore / Nextcloud)');
        this.config = config;
    }

    async authenticate() {
        if (!this.config.serverUrl || !this.config.username) {
            return { success: false, error: 'WebDAV server URL or username missing' };
        }
        return { success: true };
    }

    async listFiles(prefix = '') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        return [{ name: 'linden_sync_data.json', size: 0, etag: '', modifiedTime: Date.now() }];
    }

    async readFile(fileName = 'linden_sync_data.json') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        if (typeof window !== 'undefined' && window.platformBridge?.fetchRemoteSyncState) {
            const res = await window.platformBridge.fetchRemoteSyncState(this.config);
            if (res.error) throw new Error(res.error);
            if (!res.exists) return { content: '', etag: null, status: 'missing', missing: true };
            const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
            return { content, etag: res.etag };
        }
        const url = `${this.config.serverUrl.replace(/\/+$/, '')}/${this.config.remoteDir || 'LindenLeaf'}/${fileName}`;
        const headers = {};
        if (this.config.username && this.config.password) {
            const creds = `${this.config.username}:${this.config.password}`;
            headers['Authorization'] = 'Basic ' + (typeof btoa !== 'undefined' ? btoa(creds) : Buffer.from(creds).toString('base64'));
        }
        const resp = await fetch(url, { headers });
        if (resp.status === 404) return { content: '', etag: null, status: 'missing', missing: true };
        if (resp.status === 401 || resp.status === 403) throw new Error(`WebDAV 认证失败 (HTTP ${resp.status})`);
        if (!resp.ok) throw new Error(`WebDAV 读取失败 (HTTP ${resp.status})`);
        const text = await resp.text();
        return { content: text, etag: resp.headers.get('ETag') };
    }

    async writeFile(fileName = 'linden_sync_data.json', content, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        if (typeof window !== 'undefined' && window.platformBridge?.saveRemoteSyncState) {
            let data = content;
            try { if (typeof content === 'string') data = JSON.parse(content); } catch (_) {}
            const res = await window.platformBridge.saveRemoteSyncState(this.config, data, options.ifMatch);
            if (res.isConflict) return { success: false, conflict: true };
            if (!res.success) throw new Error(res.error || 'WebDAV 写入失败');
            return { success: true, etag: res.etag || `dav_${Date.now()}` };
        }
        const url = `${this.config.serverUrl.replace(/\/+$/, '')}/${this.config.remoteDir || 'LindenLeaf'}/${fileName}`;
        const headers = { 'Content-Type': 'application/json' };
        if (this.config.username && this.config.password) {
            const creds = `${this.config.username}:${this.config.password}`;
            headers['Authorization'] = 'Basic ' + (typeof btoa !== 'undefined' ? btoa(creds) : Buffer.from(creds).toString('base64'));
        }
        if (options.ifMatch) headers['If-Match'] = options.ifMatch;
        const resp = await fetch(url, { method: 'PUT', headers, body: content });
        if (resp.status === 412) return { success: false, conflict: true };
        if (resp.status === 401 || resp.status === 403) throw new Error(`WebDAV 认证失败 (HTTP ${resp.status})`);
        if (!resp.ok) throw new Error(`WebDAV 写入失败 (HTTP ${resp.status})`);
        return { success: true, etag: resp.headers.get('ETag') || `dav_${Date.now()}` };
    }

    async deleteFile(fileName = 'linden_sync_data.json') {
        const url = `${this.config.serverUrl.replace(/\/+$/, '')}/${this.config.remoteDir || 'LindenLeaf'}/${fileName}`;
        const headers = {};
        if (this.config.username && this.config.password) {
            const creds = `${this.config.username}:${this.config.password}`;
            headers['Authorization'] = 'Basic ' + (typeof btoa !== 'undefined' ? btoa(creds) : Buffer.from(creds).toString('base64'));
        }
        const resp = await fetch(url, { method: 'DELETE', headers });
        return resp.ok;
    }

    getMissingPrerequisites() {
        const missing = [];
        if (!this.config.serverUrl) missing.push('WebDAV 服务器地址 (Server URL)');
        if (!this.config.username) missing.push('WebDAV 账号 (Username)');
        if (!this.config.password) missing.push('WebDAV 应用专属密码 (Password)');
        return missing;
    }
}

const _folderWriteLocks = new Map();

/**
 * Local Folder Storage Provider (F08: Synchronize to local folder managed by client like Dropbox, OneDrive, iCloud)
 */
export class LocalFolderStorageProvider extends StorageProvider {
    constructor(folderPath, platformBridge) {
        super('local_folder', '本地同步文件夹 (Local Sync Folder)');
        this.folderPath = folderPath || '';
        this.platformBridge = platformBridge;
    }

    _computeHash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return `hash_${Math.abs(hash).toString(36)}_${str.length}`;
    }

    async authenticate() {
        if (!this.folderPath) {
            return { success: false, error: '未选择本地同步文件夹' };
        }
        return { success: true };
    }

    async listFiles(prefix = '') {
        await this.authenticate();
        return [{ name: 'linden_sync_data.json', size: 0, etag: `local_${Date.now()}`, modifiedTime: Date.now() }];
    }

    async readFile(fileName = 'linden_sync_data.json') {
        if (!this.folderPath) throw new Error('未指定本地同步目录');
        const sep = this.folderPath.includes('/') ? '/' : '\\';
        const fullPath = `${this.folderPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
        const bridge = this.platformBridge || (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
        if (!bridge) throw new Error('Platform bridge not available');
        if (typeof bridge.readSyncFile === 'function') {
            try {
                const res = await bridge.readSyncFile(fullPath);
                if (res) {
                    if (res.exists === false || res.missing || res.status === 'missing') {
                        return { status: 'missing', missing: true, content: '', etag: null, error: null };
                    }
                    const content = res.content !== undefined ? res.content : (res.data !== undefined ? (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)) : null);
                    return {
                        status: res.status || (res.error ? 'invalid' : 'found'),
                        content,
                        etag: res.etag || null,
                        missing: false,
                        conflict: !!(res.conflict || res.isConflict),
                        error: res.error || null
                    };
                }
            } catch (_) {}
        }
        try {
            const resp = await bridge.readFileBuffer(fullPath);
            if (!resp) {
                return { content: '', etag: null, missing: true, status: 'missing' };
            }
            const buf = resp instanceof Uint8Array ? resp : new Uint8Array(resp);
            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(buf);
            return { content: text, etag: this._computeHash(text), status: 'found' };
        } catch (err) {
            const msg = String(err?.message || err);
            if (/not found|cannot find|no such file/i.test(msg)) {
                return { content: '', etag: null, missing: true, status: 'missing' };
            }
            throw err;
        }
    }

    async writeFile(fileName = 'linden_sync_data.json', content, options = {}) {
        if (!this.folderPath) throw new Error('未指定本地同步目录');
        const sep = this.folderPath.includes('/') ? '/' : '\\';
        const fullPath = `${this.folderPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
        const bridge = this.platformBridge || (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
        if (!bridge) throw new Error('Platform bridge not available');
        const textContent = typeof content === 'string' ? content : JSON.stringify(content);

        if (typeof bridge.writeSyncFile === 'function') {
            try {
                const res = await bridge.writeSyncFile(fullPath, textContent, options.ifMatch || null);
                if (res) {
                    return {
                        success: !!res.success,
                        conflict: !!(res.conflict || res.isConflict),
                        etag: res.etag || null,
                        error: res.error || null
                    };
                }
            } catch (err) {
                return { success: false, conflict: false, error: err.message };
            }
        }

        const lockKey = fullPath.toLowerCase().replace(/\\/g, '/');
        const prevLock = _folderWriteLocks.get(lockKey) || Promise.resolve();
        let releaseLock;
        const currentLock = new Promise(resolve => { releaseLock = resolve; });
        _folderWriteLocks.set(lockKey, prevLock.then(() => currentLock).catch(() => currentLock));

        await prevLock;
        try {
            // Conflict check: ifMatch specified, verify current file etag
            if (options.ifMatch) {
                let currentEtag = null;
                try {
                    const current = await this.readFile(fileName);
                    currentEtag = current?.etag;
                } catch (_) {}
                if (currentEtag && currentEtag !== options.ifMatch) {
                    return { success: false, conflict: true, error: 'ETag conflict: 文件在外部被修改' };
                }
            }

            const newEtag = this._computeHash(textContent);
            const tempPath = `${fullPath}.tmp`;
            if (typeof bridge.writeFileText === 'function') {
                const okTemp = await bridge.writeFileText(tempPath, textContent);
                if (okTemp === false) return { success: false, error: '写入临时同步文件失败' };
                const okFinal = await bridge.writeFileText(fullPath, textContent);
                if (typeof bridge.fsDeleteFile === 'function') bridge.fsDeleteFile(tempPath).catch(() => {});
                if (okFinal === false) return { success: false, error: '写入同步文件失败' };
                return { success: true, etag: newEtag };
            }
            if (typeof bridge.saveTextFile === 'function') {
                const ok = await bridge.saveTextFile(fullPath, textContent);
                if (ok === false) return { success: false, error: '写入文件失败' };
                return { success: true, etag: newEtag };
            }
            if (typeof bridge.exportTextFile === 'function') {
                const res = await bridge.exportTextFile(fileName, textContent);
                if (res && res.success === false) return { success: false, error: res.error || '写入文件失败' };
                return { success: true, etag: newEtag };
            }
            return { success: false, error: 'Platform bridge file writing not available' };
        } finally {
            releaseLock();
            if (_folderWriteLocks.get(lockKey) === currentLock) {
                _folderWriteLocks.delete(lockKey);
            }
        }
    }

    async deleteFile(fileName = 'linden_sync_data.json') {
        const bridge = this.platformBridge || (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
        const sep = this.folderPath.includes('/') ? '/' : '\\';
        const fullPath = `${this.folderPath.replace(/[\\/]+$/, '')}${sep}${fileName}`;
        if (bridge && typeof bridge.fsDeleteFile === 'function') {
            try {
                const ok = await bridge.fsDeleteFile(fullPath);
                return ok !== false;
            } catch (_) {
                return false;
            }
        }
        return false;
    }

    getMissingPrerequisites() {
        if (!this.folderPath) {
            return ['未指定本地同步目录路径'];
        }
        return [];
    }
}

function base64UrlEncode(bytes) {
    let binary = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.byteLength; i++) {
        binary += String.fromCharCode(arr[i]);
    }
    const b64 = (typeof btoa === 'function') 
        ? btoa(binary) 
        : Buffer.from(arr).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateSecureRandomBytes(len = 32) {
    const raw = new Uint8Array(len);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(raw);
    } else {
        try {
            const nodeCrypto = require('node:crypto');
            nodeCrypto.randomFillSync(raw);
        } catch (_) {
            throw new Error('当前环境不支持安全随机数，无法进行 OAuth 授权');
        }
    }
    return raw;
}

export function generateOAuthState(prefix = 'state') {
    const raw = generateSecureRandomBytes(16);
    return `${prefix}_${base64UrlEncode(raw)}`;
}

export function computeSha256Sync(str) {
    if (typeof process !== 'undefined' && process.versions?.node) {
        try {
            const nc = (typeof process.getBuiltinModule === 'function')
                ? process.getBuiltinModule('node:crypto')
                : (typeof require === 'function' ? require('node:crypto') : null);
            if (nc) {
                return nc.createHash('sha256').update(str).digest('base64url');
            }
        } catch (_) {}
    }
    return null;
}

export async function computeSha256Base64Url(str) {
    const syncRes = computeSha256Sync(str);
    if (syncRes) return syncRes;
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const hashBuf = await crypto.subtle.digest('SHA-256', data);
        return base64UrlEncode(new Uint8Array(hashBuf));
    }
    throw new Error('Standard cryptographic SHA-256 required');
}

export function generatePkcePair() {
    const raw = generateSecureRandomBytes(32);
    const codeVerifier = base64UrlEncode(raw);
    const syncChallenge = computeSha256Sync(codeVerifier);

    const promise = (async () => {
        const codeChallenge = syncChallenge || await computeSha256Base64Url(codeVerifier);
        return { codeVerifier, codeChallenge };
    })();

    promise.codeVerifier = codeVerifier;
    promise.codeChallenge = syncChallenge || null;
    return promise;
}

// Validate the ID token against the provider's published signing keys before using its subject.
async function resolveOAuthSubject(data, provider, clientId, expectedNonce, includeUserFiles = false) {
    if (!data?.id_token || !data.access_token || !clientId || !expectedNonce || !globalThis.crypto?.subtle) throw new Error('缺少可验证的身份信息，请重新授权')
    const parts = data.id_token.split('.')
    if (parts.length !== 3 || !parts[2]) throw new Error('身份令牌格式无效')
    const decode = value => {
        const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
        const binary = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
        return Uint8Array.from(binary, c => c.charCodeAt(0))
    }
    let header, claims
    try {
        header = JSON.parse(new TextDecoder().decode(decode(parts[0])))
        claims = JSON.parse(new TextDecoder().decode(decode(parts[1])))
    } catch (_) { throw new Error('身份令牌格式无效') }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('身份令牌签名算法无效')
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const now = Math.floor(Date.now() / 1000)
    if (!aud.includes(clientId) || (aud.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 60) || claims.nonce !== expectedNonce) throw new Error('身份令牌校验失败')
    let identity
    let keysUrl
    if (provider === 'gdrive') {
        if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Google 用户主体无效')
        identity = `google_${base64UrlEncode(new TextEncoder().encode(claims.sub))}`
        keysUrl = 'https://www.googleapis.com/oauth2/v3/certs'
    } else {
        if (typeof claims.tid !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.tid) || claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0` || typeof claims.oid !== 'string' || !claims.oid) throw new Error('Microsoft 用户主体无效')
        identity = `ms_${base64UrlEncode(new TextEncoder().encode(`${claims.tid}:${claims.oid}`))}`
        keysUrl = 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
    }
    const keysResp = await fetch(keysUrl)
    if (!keysResp.ok) throw new Error('无法获取身份验证公钥')
    const jwks = await keysResp.json()
    const jwk = jwks.keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'))
    if (!jwk) throw new Error('找不到身份令牌签名公钥')
    if (provider === 'onedrive' && (!jwk.issuer || jwk.issuer.replace('{tenantid}', claims.tid) !== claims.iss)) throw new Error('Microsoft 签名公钥签发方不匹配')
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!valid) throw new Error('身份令牌签名验证失败')
    const userinfoUrl = provider === 'gdrive' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/oidc/userinfo'
    const userinfoResponse = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${data.access_token}` } })
    if (!userinfoResponse.ok) throw new Error('无法确认云端账户身份')
    const userinfo = await userinfoResponse.json()
    if (!claims.sub || userinfo.sub !== claims.sub) throw new Error('云端账户主体与身份令牌不一致')
    const scopes = String(data.scope || '').split(/\s+/).map(x => x.toLowerCase())
    const required = provider === 'gdrive' ? 'https://www.googleapis.com/auth/drive.appdata' : 'files.readwrite.appfolder'
    if (!scopes.includes(required)) throw new Error('云盘未授予应用同步权限')
    const filesScope = provider === 'gdrive' ? 'https://www.googleapis.com/auth/drive.readonly' : 'files.read'
    if (includeUserFiles && !scopes.includes(filesScope) && !(provider === 'onedrive' && scopes.includes('files.readwrite'))) throw new Error('云盘未授予读取用户文件权限')
    return { identity, scopes }
}

/**
 * OneDrive App Folder Storage Provider (F09)
 * Targets Microsoft Graph /me/drive/special/approot
 */
export class OneDriveStorageProvider extends StorageProvider {
    constructor(credentials = {}) {
        super('onedrive', 'Microsoft OneDrive (Personal & School)');
        this.clientId = credentials.clientId || '';
        this.accountId = credentials.accountId || '';
        this.accessToken = credentials.accessToken || '';
        this.refreshToken = credentials.refreshToken || '';
        this.expiresAt = credentials.expiresAt || 0;
        this.endpoint = 'https://graph.microsoft.com/v1.0';
    }

    getCredentialKey() {
        return this.accountId ? `linden_onedrive_token_${this.accountId}` : 'linden_onedrive_token';
    }

    async ready() {
        return this.authenticate();
    }

    async authenticate() {
        if (!this.clientId) {
            return { success: false, error: '缺少 Azure App Client ID' };
        }
        if (!this.accessToken) {
            await this.loadToken();
        }
        if (!this.accessToken) {
            return { success: false, error: '缺少 OAuth 2.0 用户授权访问令牌' };
        }
        if (this.expiresAt && Date.now() >= this.expiresAt) {
            if (this.refreshToken) {
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    return { success: false, error: 'OAuth 刷新令牌已过期，请重新登录' };
                }
            } else {
                return { success: false, error: 'OAuth 访问令牌已过期，请重新登录' };
            }
        }
        return { success: true, authenticated: true };
    }

    async refreshAccessToken() {
        // Controlled token renewal implementation (RFC 6749)
        if (!this.refreshToken || !this.clientId) return false;
        try {
            const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: this.clientId,
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken,
                    scope: (this.grantedScopes?.length ? this.grantedScopes.join(' ') : 'Files.ReadWrite.AppFolder offline_access')
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                const scopes = data.scope ? String(data.scope).split(/\s+/).map(x => x.toLowerCase()) : this.grantedScopes;
                if (!data.access_token || (Array.isArray(scopes) && scopes.length && !scopes.includes('files.readwrite.appfolder'))) return false;
                if (Array.isArray(scopes)) this.grantedScopes = scopes;
                this.accessToken = data.access_token;
                if (data.refresh_token) this.refreshToken = data.refresh_token;
                this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
                await this.saveToken();
                return true;
            }
        } catch (e) {
            console.warn('[OneDriveStorageProvider] Token refresh failed:', e);
        }
        return false;
    }

    async readFile(fileName = 'linden_sync_data.json') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/special/approot:/${encodeURIComponent(fileName)}:/content`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (resp.status === 404) {
            return { content: '', etag: null, status: 'missing', missing: true };
        }
        if (resp.status === 401 || resp.status === 403) {
            throw new Error(`OneDrive 认证失败 (HTTP ${resp.status})，请重新授权登录`);
        }
        if (!resp.ok) {
            throw new Error(`OneDrive read failed: HTTP ${resp.status}`);
        }
        const text = await resp.text();
        const etag = resp.headers.get('ETag');
        return { content: text, etag };
    }

    async writeFile(fileName = 'linden_sync_data.json', content, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/special/approot:/${encodeURIComponent(fileName)}:/content`;
        const headers = {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
        };
        if (options.ifMatch) {
            headers['If-Match'] = options.ifMatch;
        }
        const resp = await fetch(url, {
            method: 'PUT',
            headers,
            body: content
        });
        if (resp.status === 412) {
            return { success: false, conflict: true };
        }
        if (resp.status === 401 || resp.status === 403) {
            throw new Error(`OneDrive 认证失败 (HTTP ${resp.status})，请重新授权登录`);
        }
        if (!resp.ok) {
            throw new Error(`OneDrive write failed: HTTP ${resp.status}`);
        }
        const etag = resp.headers.get('ETag');
        return { success: true, etag };
    }

    async deleteFile(fileName = 'linden_sync_data.json') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/special/approot:/${encodeURIComponent(fileName)}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        return resp.ok;
    }

    /**
     * List user books stored in cloud drive (approot or user files) with pagination
     */
    async listCloudBooks(pageSize = 20, pageToken = null, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        if (options.space === 'drive' && (!this.grantedScopes?.includes('files.read') && !this.grantedScopes?.includes('files.readwrite'))) throw new Error('请先授权读取用户云盘文件');
        const top = Math.max(1, Math.min(pageSize, 100));
        const space = options?.space === 'drive' ? 'drive' : 'approot';
        let url = space === 'drive'
            ? `${this.endpoint}/me/drive/root/search(q='.pdf,.epub,.txt')?$top=${top}`
            : `${this.endpoint}/me/drive/special/approot:/books:/children?$top=${top}`;
        if (pageToken) {
            url = pageToken.startsWith('http') ? pageToken : `${url}&$skiptoken=${encodeURIComponent(pageToken)}`;
        }
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (resp.status === 404) return { items: [], nextPageToken: null };
        if (resp.status === 401 || resp.status === 403) throw new Error(`OneDrive 认证失效 (HTTP ${resp.status})`);
        if (!resp.ok) throw new Error(`OneDrive list books failed: HTTP ${resp.status}`);
        const data = await resp.json();
        const items = (data.value || []).map(f => ({
            id: f.id,
            name: f.name,
            size: f.size || 0,
            modifiedTime: f.lastModifiedDateTime ? new Date(f.lastModifiedDateTime).getTime() : Date.now(),
            etag: f.eTag || f.cTag || null
        }));
        return { items, nextPageToken: data['@odata.nextLink'] || null };
    }

    async getCloudBookMeta(fileId) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/items/${encodeURIComponent(fileId)}`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return {
            id: data.id,
            name: data.name,
            size: data.size || 0,
            mimeType: data.file?.mimeType || null
        };
    }

    /**
     * Download cloud book content
     */
    async downloadCloudBook(fileId, signal = null) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/items/${encodeURIComponent(fileId)}/content`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            signal
        });
        if (!resp.ok) throw new Error(`OneDrive book download failed: HTTP ${resp.status}`);
        return await resp.arrayBuffer();
    }

    /**
     * Upload book to approot/books
     */
    async uploadCloudBook(fileName, fileBuffer, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/me/drive/special/approot:/books/${encodeURIComponent(fileName)}:/content`;
        const headers = { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/octet-stream' };
        if (options.ifMatch) headers['If-Match'] = options.ifMatch;
        const resp = await fetch(url, { method: 'PUT', headers, body: fileBuffer });
        if (resp.status === 412) return { success: false, conflict: true };
        if (!resp.ok) throw new Error(`OneDrive upload failed: HTTP ${resp.status}`);
        const data = await resp.json();
        return { success: true, fileId: data.id, etag: data.eTag };
    }

    /**
     * OAuth PKCE authorization lifecycle
     */
    startOAuthLogin(redirectUri = 'http://localhost:18520/callback', options = {}) {
        if (!this.clientId) throw new Error('缺少 Client ID，无法发起授权');
        const state = generateOAuthState('onedrive');
        const nonce = generateOAuthState('nonce');
        const pkce = generatePkcePair();
        const codeVerifier = pkce.codeVerifier;
        const syncChallenge = pkce.codeChallenge;
        const scope = options?.includeUserFiles
            ? 'Files.ReadWrite.AppFolder Files.Read offline_access openid profile'
            : 'Files.ReadWrite.AppFolder offline_access openid profile';

        const buildAuthUrl = (challenge) => {
            return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${encodeURIComponent(this.clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
        };

        const resultObj = {
            state,
            nonce,
            codeVerifier,
            codeChallenge: syncChallenge,
            authUrl: syncChallenge ? buildAuthUrl(syncChallenge) : null
        };

        const promise = (async () => {
            const pair = await pkce;
            resultObj.codeChallenge = pair.codeChallenge;
            resultObj.authUrl = buildAuthUrl(pair.codeChallenge);
            return resultObj;
        })();

        Object.assign(promise, resultObj);
        return promise;
    }

    async handleOAuthCallback(code, codeVerifier, redirectUri = 'http://localhost:18520/callback', expectedNonce = '', includeUserFiles = false) {
        const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.clientId,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier
            })
        });
        if (!resp.ok) throw new Error(`OneDrive 换取 Token 失败: HTTP ${resp.status}`);
        const data = await resp.json();
        const { identity: resolvedSubject, scopes } = await resolveOAuthSubject(data, 'onedrive', this.clientId, expectedNonce, includeUserFiles);
        if (!resolvedSubject) {
            throw new Error('OAuth 响应未包含稳定用户主体标识 (Subject/OID)，认证失败');
        }
        this.accountId = resolvedSubject;
        this.grantedScopes = scopes;
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        try {
            await this.saveToken();
        } catch (err) {
            this.accessToken = '';
            this.refreshToken = '';
            this.expiresAt = 0;
            throw err;
        }
        return { success: true, accessToken: this.accessToken, accountId: this.accountId };
    }

    async revokeToken() {
        this.accessToken = '';
        this.refreshToken = '';
        this.expiresAt = 0;
        try {
            const key = this.getCredentialKey();
            const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
            if (bridge && typeof bridge.secureDeleteCredential === 'function') {
                await bridge.secureDeleteCredential(key);
            } else if (bridge && typeof bridge.deleteSecureCredential === 'function') {
                await bridge.deleteSecureCredential(key);
            }
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
            if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
        } catch (_) {}
        return true;
    }

    async saveToken() {
        const key = this.getCredentialKey();
        const payload = JSON.stringify({
            accountId: this.accountId || '',
            grantedScopes: this.grantedScopes || [],
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: this.expiresAt
        });
        const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
        if (bridge && typeof bridge.secureStoreCredential === 'function') {
            const ok = await bridge.secureStoreCredential(key, payload);
            if (ok === false) throw new Error('OneDrive 安全凭据保存失败');
            return true;
        } else if (bridge && typeof bridge.setSecureCredential === 'function') {
            const ok = await bridge.setSecureCredential(key, payload);
            if (ok === false) throw new Error('OneDrive 安全凭据保存失败');
            return true;
        }
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(key, payload);
            return true;
        }
        throw new Error('无可用的安全凭据存储后端');
    }

    async loadToken() {
        try {
            const key = this.getCredentialKey();
            let raw = null;
            const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
            if (bridge && typeof bridge.secureLoadCredential === 'function') {
                raw = await bridge.secureLoadCredential(key);
            } else if (bridge && typeof bridge.getSecureCredential === 'function') {
                raw = await bridge.getSecureCredential(key);
            } else if (typeof sessionStorage !== 'undefined') {
                raw = sessionStorage.getItem(key);
            }
            if (raw) {
                const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (data.accountId && !this.accountId) this.accountId = data.accountId;
                this.grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes : [];
                this.accessToken = data.accessToken || '';
                this.refreshToken = data.refreshToken || '';
                this.expiresAt = data.expiresAt || 0;
            }
        } catch (_) {}
    }

    getMissingPrerequisites() {
        const missing = [];
        if (!this.clientId) {
            missing.push('Microsoft Azure 应用注册 Client ID (Application ID)');
        }
        if (!this.accessToken) {
            missing.push('用户 OAuth 2.0 PKCE 授权登录（需 Files.ReadWrite.AppFolder 权限）');
        }
        return missing;
    }
}

/**
 * Google Drive AppData Folder Storage Provider (F10)
 * Targets Google Drive appDataFolder space
 */
export class GoogleDriveStorageProvider extends StorageProvider {
    constructor(credentials = {}) {
        super('google_drive', 'Google Drive (appDataFolder)');
        this.clientId = credentials.clientId || '';
        this.accountId = credentials.accountId || '';
        this.accessToken = credentials.accessToken || '';
        this.refreshToken = credentials.refreshToken || '';
        this.expiresAt = credentials.expiresAt || 0;
        this.endpoint = 'https://www.googleapis.com/drive/v3';
    }

    getCredentialKey() {
        return this.accountId ? `linden_gdrive_token_${this.accountId}` : 'linden_gdrive_token';
    }

    async ready() {
        return this.authenticate();
    }

    async authenticate() {
        if (!this.clientId) {
            return { success: false, error: '缺少 Google Cloud OAuth 2.0 Client ID' };
        }
        if (!this.accessToken) {
            await this.loadToken();
        }
        if (!this.accessToken) {
            return { success: false, error: '缺少 Google Drive 用户授权访问令牌' };
        }
        if (this.expiresAt && Date.now() >= this.expiresAt) {
            if (this.refreshToken) {
                const refreshed = await this.refreshAccessToken();
                if (!refreshed) {
                    return { success: false, error: 'Google Drive 刷新令牌已过期，请重新登录' };
                }
            } else {
                return { success: false, error: 'Google Drive 访问令牌已过期，请重新授权' };
            }
        }
        return { success: true, authenticated: true };
    }

    async refreshAccessToken() {
        if (!this.refreshToken || !this.clientId) return false;
        try {
            const resp = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: this.clientId,
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                const scopes = data.scope ? String(data.scope).split(/\s+/).map(x => x.toLowerCase()) : this.grantedScopes;
                if (!data.access_token || (Array.isArray(scopes) && scopes.length && !scopes.includes('https://www.googleapis.com/auth/drive.appdata'))) return false;
                if (Array.isArray(scopes)) this.grantedScopes = scopes;
                this.accessToken = data.access_token;
                if (data.refresh_token) this.refreshToken = data.refresh_token;
                this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
                await this.saveToken();
                return true;
            }
        } catch (e) {
            console.warn('[GoogleDriveStorageProvider] Token refresh failed:', e);
        }
        return false;
    }

    async findAppFile(fileName = 'linden_sync_data.json') {
        const q = encodeURIComponent(`name = '${fileName}' and 'appDataFolder' in parents and trashed = false`);
        const url = `${this.endpoint}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,version,modifiedTime)`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (resp.status === 401 || resp.status === 403) {
            throw new Error(`Google Drive 认证失败 (HTTP ${resp.status})，请重新授权`);
        }
        if (!resp.ok) {
            throw new Error(`Google Drive 查询失败: HTTP ${resp.status}`);
        }
        const data = await resp.json();
        return data.files?.[0] || null;
    }

    async readFile(fileName = 'linden_sync_data.json') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const file = await this.findAppFile(fileName);
        if (!file) {
            return { content: '', etag: null, status: 'missing', missing: true };
        }
        const url = `${this.endpoint}/files/${file.id}?alt=media`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (resp.status === 404) return { content: '', etag: null, status: 'missing', missing: true };
        if (resp.status === 401 || resp.status === 403) throw new Error(`Google Drive 认证失效 (HTTP ${resp.status})`);
        if (!resp.ok) throw new Error(`Google Drive read failed: HTTP ${resp.status}`);
        const text = await resp.text();
        return { content: text, etag: file.version };
    }

    async writeFile(fileName = 'linden_sync_data.json', content, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const file = await this.findAppFile(fileName);
        if (file) {
            const url = `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`;
            const headers = {
                Authorization: `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            };
            if (options.ifMatch) {
                headers['If-Match'] = options.ifMatch;
            }
            const resp = await fetch(url, { method: 'PATCH', headers, body: content });
            if (resp.status === 412) return { success: false, conflict: true };
            if (resp.status === 401 || resp.status === 403) throw new Error(`Google Drive 认证失效 (HTTP ${resp.status})`);
            if (!resp.ok) throw new Error(`Google Drive write failed: HTTP ${resp.status}`);
            return { success: true, etag: String(Date.now()) };
        } else {
            // Create in appDataFolder
            const metadata = { name: fileName, parents: ['appDataFolder'] };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: 'application/json' }));
            const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
            const resp = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.accessToken}` },
                body: form
            });
            if (resp.status === 401 || resp.status === 403) throw new Error(`Google Drive 认证失效 (HTTP ${resp.status})`);
            if (!resp.ok) throw new Error(`Google Drive create failed: HTTP ${resp.status}`);
            return { success: true, etag: String(Date.now()) };
        }
    }

    async deleteFile(fileName = 'linden_sync_data.json') {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const file = await this.findAppFile(fileName);
        if (!file) return true;
        const resp = await fetch(`${this.endpoint}/files/${file.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        return resp.ok;
    }

    /**
     * List user books stored in Google Drive (appDataFolder or drive) with pagination
     */
    async listCloudBooks(pageSize = 20, pageToken = null, options = {}) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        if (options.space === 'drive' && (!this.grantedScopes?.includes('https://www.googleapis.com/auth/drive.readonly') && !this.grantedScopes?.includes('https://www.googleapis.com/auth/drive'))) throw new Error('请先授权读取用户云盘文件');
        const size = Math.max(1, Math.min(pageSize, 100));
        const space = options?.space === 'drive' ? 'drive' : 'appDataFolder';
        let url = `${this.endpoint}/files?spaces=${space}&q=trashed%20%3D%20false&pageSize=${size}&fields=nextPageToken,files(id,name,size,modifiedTime,version)`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (resp.status === 401 || resp.status === 403) throw new Error(`Google Drive 认证失效 (HTTP ${resp.status})`);
        if (!resp.ok) throw new Error(`Google Drive list failed: HTTP ${resp.status}`);
        const data = await resp.json();
        const items = (data.files || []).map(f => ({
            id: f.id,
            name: f.name,
            size: parseInt(f.size || '0', 10),
            modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now(),
            etag: f.version || null
        }));
        return { items, nextPageToken: data.nextPageToken || null };
    }

    async getCloudBookMeta(fileId) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return {
            id: data.id,
            name: data.name,
            size: Number(data.size) || 0,
            mimeType: data.mimeType || null
        };
    }

    /**
     * Download cloud book content
     */
    async downloadCloudBook(fileId, signal = null) {
        const auth = await this.authenticate();
        if (!auth.success) throw new Error(auth.error);
        const url = `${this.endpoint}/files/${encodeURIComponent(fileId)}?alt=media`;
        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
            signal
        });
        if (!resp.ok) throw new Error(`Google Drive download failed: HTTP ${resp.status}`);
        return await resp.arrayBuffer();
    }

    /**
     * OAuth PKCE authorization lifecycle
     */
    startOAuthLogin(redirectUri = 'http://localhost:18520/callback', options = {}) {
        if (!this.clientId) throw new Error('缺少 Client ID，无法发起授权');
        const state = generateOAuthState('gdrive');
        const nonce = generateOAuthState('nonce');
        const pkce = generatePkcePair();
        const codeVerifier = pkce.codeVerifier;
        const syncChallenge = pkce.codeChallenge;
        const scope = options?.includeUserFiles
            ? 'openid email profile https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.readonly'
            : 'openid email profile https://www.googleapis.com/auth/drive.appdata';

        const buildAuthUrl = (challenge) => {
            return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(this.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&access_type=offline&prompt=consent`;
        };

        const resultObj = {
            state,
            nonce,
            codeVerifier,
            codeChallenge: syncChallenge,
            authUrl: syncChallenge ? buildAuthUrl(syncChallenge) : null
        };

        const promise = (async () => {
            const pair = await pkce;
            resultObj.codeChallenge = pair.codeChallenge;
            resultObj.authUrl = buildAuthUrl(pair.codeChallenge);
            return resultObj;
        })();

        Object.assign(promise, resultObj);
        return promise;
    }

    async handleOAuthCallback(code, codeVerifier, redirectUri = 'http://localhost:18520/callback', expectedNonce = '', includeUserFiles = false) {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: this.clientId,
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier
            })
        });
        if (!resp.ok) throw new Error(`Google Drive 换取 Token 失败: HTTP ${resp.status}`);
        const data = await resp.json();
        const { identity: resolvedSubject, scopes } = await resolveOAuthSubject(data, 'gdrive', this.clientId, expectedNonce, includeUserFiles);
        if (!resolvedSubject) {
            throw new Error('OAuth 响应未包含稳定用户主体标识 (Subject/sub)，认证失败');
        }
        this.accountId = resolvedSubject;
        this.grantedScopes = scopes;
        this.accessToken = data.access_token;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        try {
            await this.saveToken();
        } catch (err) {
            this.accessToken = '';
            this.refreshToken = '';
            this.expiresAt = 0;
            throw err;
        }
        return { success: true, accessToken: this.accessToken, accountId: this.accountId };
    }

    async revokeToken() {
        if (this.accessToken) {
            try {
                await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(this.accessToken)}`, { method: 'POST' });
            } catch (_) {}
        }
        this.accessToken = '';
        this.refreshToken = '';
        this.expiresAt = 0;
        try {
            const key = this.getCredentialKey();
            const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
            if (bridge && typeof bridge.secureDeleteCredential === 'function') {
                await bridge.secureDeleteCredential(key);
            } else if (bridge && typeof bridge.deleteSecureCredential === 'function') {
                await bridge.deleteSecureCredential(key);
            }
            if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
            if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
        } catch (_) {}
        return true;
    }

    async saveToken() {
        const key = this.getCredentialKey();
        const payload = JSON.stringify({
            accountId: this.accountId || '',
            grantedScopes: this.grantedScopes || [],
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: this.expiresAt
        });
        const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
        if (bridge && typeof bridge.secureStoreCredential === 'function') {
            const ok = await bridge.secureStoreCredential(key, payload);
            if (ok === false) throw new Error('Google Drive 安全凭据保存失败');
            return true;
        } else if (bridge && typeof bridge.setSecureCredential === 'function') {
            const ok = await bridge.setSecureCredential(key, payload);
            if (ok === false) throw new Error('Google Drive 安全凭据保存失败');
            return true;
        }
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(key, payload);
            return true;
        }
        throw new Error('无可用的安全凭据存储后端');
    }

    async loadToken() {
        try {
            const key = this.getCredentialKey();
            let raw = null;
            const bridge = (typeof window !== 'undefined' ? window.platformBridge : null) || defaultBridge;
            if (bridge && typeof bridge.secureLoadCredential === 'function') {
                raw = await bridge.secureLoadCredential(key);
            } else if (bridge && typeof bridge.getSecureCredential === 'function') {
                raw = await bridge.getSecureCredential(key);
            } else if (typeof sessionStorage !== 'undefined') {
                raw = sessionStorage.getItem(key);
            }
            if (raw) {
                const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (data.accountId && !this.accountId) this.accountId = data.accountId;
                this.grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes : [];
                this.accessToken = data.accessToken || '';
                this.refreshToken = data.refreshToken || '';
                this.expiresAt = data.expiresAt || 0;
            }
        } catch (_) {}
    }

    getMissingPrerequisites() {
        const missing = [];
        if (!this.clientId) {
            missing.push('Google Cloud Console OAuth 2.0 客户端 ID (Client ID)');
        }
        if (!this.accessToken) {
            missing.push('用户 Google 账号登录授权（需 https://www.googleapis.com/auth/drive.appdata 作用域）');
        }
        return missing;
    }
}

/**
 * Storage Provider Factory
 * @param {string} type
 * @param {object} [options]
 * @returns {StorageProvider}
 */
export function getStorageProvider(type, options = {}) {
    switch (type) {
        case 'webdav':
        case 'jianguoyun':
            return new WebDavStorageProvider(options);
        case 'local_folder':
            return new LocalFolderStorageProvider(options.folderPath, options.platformBridge || (typeof window !== 'undefined' ? window.platformBridge : null));
        case 'onedrive':
            return new OneDriveStorageProvider(options);
        case 'google_drive':
            return new GoogleDriveStorageProvider(options);
        default:
            throw new Error(`Unsupported storage provider type: ${type}`);
    }
}
