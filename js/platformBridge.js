// js/platformBridge.js - Universal Cross-Platform Bridge for Linden Leaf
// Unifies Electron IPC, Tauri 2.0 Rust commands, and Web/Browser fallback into a clean Promise-based API.

class PlatformBridge {
    constructor() {
        this._initEnvironment();
    }

    /**
     * Auto-detect current runtime environment
     */
        /**
     * Get underlying native Electron API (guaranteed not to return this platformBridge wrapper)
     */
    _getNativeElectron() {
        if (typeof window === 'undefined') return null;
        const api = window.electronAPI;
        if (api && api !== this && this.isElectron) return api;
        return null;
    }

    get isTauri() {
        return Boolean(
            typeof window !== 'undefined' &&
            (window.__TAURI__ || window.__TAURI_INTERNALS__)
        );
    }

    _initEnvironment() {
        const rawApi = typeof window !== 'undefined' ? window.electronAPI : null;
        this.isElectron = Boolean(
            typeof window !== 'undefined' &&
            ((rawApi && rawApi !== this) || window.process?.versions?.electron)
        );

        if (this.isTauri) {
            this.platform = 'tauri';
            this._setupLoggingBridge();
        } else if (this.isElectron) {
            this.platform = 'electron';
        } else {
            this.platform = 'web';
            if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
                window.addEventListener('DOMContentLoaded', () => {
                    if (this.isTauri && !this._loggingBridgeInitialized) {
                        this.platform = 'tauri';
                        this._setupLoggingBridge();
                    }
                });
            }
        }
    }

    _setupLoggingBridge() {
        if (this._loggingBridgeInitialized) return;
        this._loggingBridgeInitialized = true;
        const queue = [];
        let flushing = false;
        const flush = async () => {
            if (flushing || queue.length === 0) return;
            flushing = true;
            try {
                while (queue.length > 0) {
                    const msg = queue.shift();
                    await this._invokeTauri('app_write_debug_log', { message: msg });
                }
            } catch (e) {
            } finally {
                flushing = false;
            }
        };

        const logToServer = (type, args) => {
            try {
                const text = `[${new Date().toISOString()}][${type}] ` + Array.from(args).map(a => {
                    if (a instanceof Error) return a.stack || a.message;
                    if (typeof a === 'object') {
                        try { return JSON.stringify(a); } catch (e) { return String(a); }
                    }
                    return String(a);
                }).join(' ');
                queue.push(text);
                flush();
            } catch (e) {}
        };

        const _log = console.log, _warn = console.warn, _err = console.error;
        console.log = (...args) => { logToServer('LOG', args); _log.apply(console, args); };
        console.warn = (...args) => { logToServer('WARN', args); _warn.apply(console, args); };
        console.error = (...args) => { logToServer('ERROR', args); _err.apply(console, args); };
        window.addEventListener('error', e => {
            logToServer('UNCAUGHT_ERR', [e.message, e.filename, e.lineno, e.colno, e.error?.stack]);
        });
        window.addEventListener('unhandledrejection', e => {
            logToServer('UNHANDLED_REJECTION', [e.reason?.stack || e.reason]);
        });
        setInterval(flush, 400);
        logToServer('SYSTEM', ['PlatformBridge logger initialized in Tauri']);
    }

    /**
     * Get platform identifier ('tauri' | 'electron' | 'web')
     */
    getPlatform() {
        return this.platform;
    }

    /**
     * Detect running operating system
     * @returns {'windows' | 'android' | 'linux' | 'macos' | 'browser'}
     */
    getOS() {
        if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'browser';
        const ua = navigator.userAgent || '';
        if (/android/i.test(ua)) return 'android';
        if (/windows|win32|win64/i.test(ua)) return 'windows';
        if (/macintosh|mac os x/i.test(ua)) return 'macos';
        if (/linux/i.test(ua)) return 'linux';
        return 'browser';
    }

    /**
     * Deep capability matrix for cross-platform fallback and Android readiness
     * @returns {Readonly<{
     *   platform: string,
     *   os: string,
     *   isAndroid: boolean,
     *   isWindows: boolean,
     *   hasNativeMuPdf: boolean,
     *   hasContentUriSupport: boolean,
     *   hasPersistentUriPermission: boolean,
     *   hasPrivateCacheStreaming: boolean,
     *   hasSecureStorage: boolean,
     *   hasExternalBrowserIntent: boolean,
     *   hasWindowControls: boolean
     * }>}
     */
    getCapabilities() {
        const os = this.getOS();
        const isTauri = this.isTauri;
        const isElectron = this.isElectron;
        const isAndroid = os === 'android';
        const isWindows = os === 'windows';

        return Object.freeze({
            platform: this.platform, // 'tauri' | 'electron' | 'web'
            os,
            isAndroid,
            isWindows,
            // Native compiled MuPDF only available on Windows desktop in current build
            hasNativeMuPdf: Boolean(isTauri && isWindows),
            // Android SAF (Storage Access Framework) content:// URIs - NOT yet implemented in native layer
            hasContentUriSupport: false,
            // Persistent permissions require Android ContentResolver takePersistableUriPermission - NOT yet implemented
            hasPersistentUriPermission: false,
            // Streaming copy to app-private cache snapshot
            hasPrivateCacheStreaming: Boolean((isTauri && isWindows) || isElectron),
            // Secure credential storage (Windows DPAPI)
            hasSecureStorage: Boolean((isTauri && isWindows) || isElectron),
            hasExternalBrowserIntent: true,
            // Desktop window controls (minimize, maximize, close)
            hasWindowControls: Boolean((isTauri || isElectron) && !isAndroid)
        });
    }

    /**
     * Set runtime memory and cache budget
     * @param {object} budget
     * @param {number} [budget.maxMemoryMb]
     * @param {number} [budget.maxCacheMb]
     * @param {number} [budget.maxConcurrentTasks]
     */
    setResourceBudget(budget = {}) {
        const isWin = this.getOS() === 'windows';
        this._resourceBudget = {
            maxMemoryMb: budget.maxMemoryMb || (isWin ? 1024 : 384),
            maxCacheMb: budget.maxCacheMb || (isWin ? 512 : 128),
            maxConcurrentTasks: budget.maxConcurrentTasks || (isWin ? 3 : 1),
            ...budget
        };
        return this._resourceBudget;
    }

    getResourceBudget() {
        if (!this._resourceBudget) {
            this.setResourceBudget();
        }
        return this._resourceBudget;
    }

    /**
     * Check if a given string or path is an Android content:// URI
     * @param {string} uriString
     * @returns {boolean}
     */
    isContentUri(uriString) {
        if (!uriString || typeof uriString !== 'string') return false;
        return uriString.trim().toLowerCase().startsWith('content://');
    }

    /**
     * Take persistent URI read permission for an Android SAF source.
     * Must return explicit capability failure if unsupported; NEVER returns fake success.
     * @param {string} contentUri
     * @returns {Promise<{ success: boolean, supported: boolean, uri?: string, error?: string }>}
     */
    async takePersistentUriPermission(contentUri) {
        if (!contentUri || !this.isContentUri(contentUri)) {
            return {
                success: false,
                supported: false,
                error: '非法的 Content URI'
            };
        }

        const caps = this.getCapabilities();
        if (!caps.hasPersistentUriPermission) {
            return {
                success: false,
                supported: false,
                error: '当前平台或环境不支持持久化 Content URI 权限 (仅在 Android 原生端可用)'
            };
        }

        try {
            const res = await this._invokeTauri('saf_take_persistent_permission', { uri: contentUri });
            return {
                success: Boolean(res?.success),
                supported: true,
                uri: contentUri,
                error: res?.error || null
            };
        } catch (err) {
            return {
                success: false,
                supported: true,
                error: `获取持久化权限失败: ${err.message || err}`
            };
        }
    }

    /**
     * Release persistent URI permission for an Android SAF source.
     * @param {string} contentUri
     * @returns {Promise<{ success: boolean, supported: boolean, error?: string }>}
     */
    async releasePersistentUriPermission(contentUri) {
        if (!contentUri || !this.isContentUri(contentUri)) {
            return {
                success: false,
                supported: false,
                error: '非法的 Content URI'
            };
        }

        const caps = this.getCapabilities();
        if (!caps.hasPersistentUriPermission) {
            return {
                success: false,
                supported: false,
                error: '当前平台不支持 Content URI 权限释放'
            };
        }

        try {
            const res = await this._invokeTauri('saf_release_persistent_permission', { uri: contentUri });
            return {
                success: Boolean(res?.success),
                supported: true,
                error: res?.error || null
            };
        } catch (err) {
            return {
                success: false,
                supported: true,
                error: `释放持久化权限失败: ${err.message || err}`
            };
        }
    }

    /**
     * Stream copy a document source (file, blob, or content URI) into app private snapshot cache.
     * Contract: Ensures that file-seekable engines like MuPDF have an isolated private file.
     * @param {object} source
     * @param {string} [source.path]
     * @param {string} [source.contentUri]
     * @param {Blob} [source.blob]
     * @param {ArrayBuffer} [source.buffer]
     * @param {string} [source.filename]
     * @param {object} [options]
     * @param {string} [options.destinationFilename]
     * @param {Function} [options.onProgress]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ success: boolean, cachedPath?: string, bytesWritten?: number, error?: string }>}
     */
    async copySourceToPrivateCache(source, options = {}) {
        if (!source) {
            return { success: false, error: '缺少输入源' };
        }

        const caps = this.getCapabilities();
        if (!caps.hasPrivateCacheStreaming) {
            return {
                success: false,
                error: '当前环境无私有文件系统缓存能力 (Web 或沙箱不可用)'
            };
        }

        if (options.signal?.aborted) {
            return { success: false, error: '操作已取消' };
        }

        // 1. If contentUri is provided on Android
        if (source.contentUri && this.isContentUri(source.contentUri)) {
            if (!caps.hasContentUriSupport) {
                return { success: false, error: '当前环境不支持通过 ContentResolver 复制 Content URI' };
            }
            try {
                const res = await this._invokeTauri('saf_copy_to_private_cache', {
                    uri: source.contentUri,
                    destinationFilename: options.destinationFilename || source.filename || 'cached_doc'
                });
                return res || { success: false, error: 'Content URI 流式复制失败' };
            } catch (err) {
                return { success: false, error: `Content URI 复制异常: ${err.message || err}` };
            }
        }

        // 2. If native local file path is available
        if (source.path && typeof source.path === 'string') {
            try {
                // If it's a PDF, we can reuse stagePdfSource
                if (/\.pdf$/i.test(source.path) && this.stagePdfSource) {
                    const staged = await this.stagePdfSource(source.path);
                    const snapPath = typeof staged === 'string' ? staged : staged?.snapshotPath;
                    if (snapPath) {
                        return {
                            success: true,
                            cachedPath: snapPath,
                            bytesWritten: typeof staged === 'object' ? (staged?.size || 0) : 0
                        };
                    }
                }

                // Generic snapshot creation for any document file
                const buf = await this.readFileBuffer(source.path, { signal: options.signal });
                if (buf && this.createBookSnapshot) {
                    const fname = options.destinationFilename || source.filename || source.path.split(/[\\/]/).pop();
                    const snapPath = await this.createBookSnapshot(fname, buf);
                    if (snapPath) {
                        return {
                            success: true,
                            cachedPath: snapPath,
                            bytesWritten: buf.byteLength
                        };
                    }
                }
            } catch (err) {
                return { success: false, error: `本地文件缓存复制失败: ${err.message || err}` };
            }
        }

        // 3. If Blob or ArrayBuffer is provided
        const buffer = source.buffer || (source.blob ? await source.blob.arrayBuffer() : null);
        if (buffer && this.createBookSnapshot) {
            try {
                const fname = options.destinationFilename || source.filename || `doc_${Date.now()}`;
                const snapPath = await this.createBookSnapshot(fname, buffer);
                if (snapPath) {
                    return {
                        success: true,
                        cachedPath: snapPath,
                        bytesWritten: buffer.byteLength
                    };
                }
            } catch (err) {
                return { success: false, error: `内存流写入私有缓存失败: ${err.message || err}` };
            }
        }

        return { success: false, error: '未能匹配可执行的私有缓存复制策略' };
    }

    /**
     * Low-level Tauri invoke dispatcher supporting Tauri 2.0 and Tauri 1.x
     */
    async _invokeTauri(cmd, args = {}) {
        if (typeof window === 'undefined') {
            throw new Error(`Cannot invoke Tauri command '${cmd}' outside browser window`);
        }
        if (window.__TAURI__?.core?.invoke) {
            return await window.__TAURI__.core.invoke(cmd, args);
        }
        if (window.__TAURI__?.invoke) {
            return await window.__TAURI__.invoke(cmd, args);
        }
        if (window.__TAURI_INTERNALS__?.invoke) {
            return await window.__TAURI_INTERNALS__.invoke(cmd, args);
        }
        throw new Error(`Tauri invoke is not available in current window for command '${cmd}'`);
    }

    // ==========================================
    // 1. File Dialogs & Buffer Streaming
    // ==========================================

    /**
     * Open native file selection dialog for books
     * @returns {Promise<Array<{ filePath: string, filename: string, buffer?: ArrayBuffer }> | null>}
     */
    async openFileDialog() {
        if (this._getNativeElectron()?.openFileDialog) {
            return await this._getNativeElectron().openFileDialog();
        }

        if (this.isTauri) {
            try {
                const items = await this._invokeTauri('dialog_open_file');
                if (items && items.length > 0) return items;
                if (!this.isAndroid) return null;
            } catch (err) {
                console.error('[PlatformBridge] Tauri dialog_open_file failed:', err);
                if (!this.isAndroid) return null;
            }
        }

        // Web / Fallback file input picker
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '.epub,.pdf,.docx,.txt,.md,.mobi,.azw,.azw3,.fb2,.cbz';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = async () => {
                const files = Array.from(input.files || []);
                document.body.removeChild(input);
                if (files.length === 0) {
                    resolve(null);
                    return;
                }
                const result = [];
                for (const f of files) {
                    const buf = await f.arrayBuffer();
                    result.push({
                        filePath: f.name,
                        filename: f.name,
                        buffer: buf
                    });
                }
                resolve(result);
            };

            input.oncancel = () => {
                document.body.removeChild(input);
                resolve(null);
            };

            input.click();
        });
    }

    /**
     * Read file content from local disk as ArrayBuffer
     * @param {string} filePath
     * @returns {Promise<ArrayBuffer | null>}
     */
    async readFileBuffer(filePath, options = {}) {
        if (!filePath) return null;
        if (options.signal?.aborted) {
            throw new DOMException('The operation was aborted', 'AbortError');
        }

        if (this._getNativeElectron()?.readFileBuffer) {
            return await this._getNativeElectron().readFileBuffer(filePath);
        }

        if (this.isTauri) {
            try {
                const raw = await this._invokeTauri('fs_read_buffer', { filePath, file_path: filePath });
                if (!raw) return null;
                let data = raw;
                if (data && typeof data === 'object' && 'body' in data) {
                    data = data.body;
                }
                if (data instanceof ArrayBuffer) return data;
                if (ArrayBuffer.isView(data)) {
                    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                }
                if (Array.isArray(data)) {
                    return new Uint8Array(data).buffer;
                }
                if (data && typeof data === 'object' && Array.isArray(data.data)) {
                    return new Uint8Array(data.data).buffer;
                }
                if (data && typeof data.arrayBuffer === 'function') {
                    return await data.arrayBuffer();
                }
                console.warn('[PlatformBridge] Unexpected binary payload format from fs_read_buffer:', typeof data);
                return null;
            } catch (err) {
                console.error('[PlatformBridge] Tauri fs_read_buffer failed:', filePath, err);
                return null;
            }
        }

        console.warn('[PlatformBridge] Direct filesystem read is unsupported in pure web mode:', filePath);
        return null;
    }

    /** Copy a local PDF once into the app-owned native cache. The caller must
     * read this returned path to create the IndexedDB Blob from the same bytes. */
    async stagePdfSource(filePath) {
        if (!this.isTauri || !filePath || !/\.pdf$/i.test(filePath)) return null;
        try {
            if (!await this._invokeTauri('mupdf_is_available')) return null;
            return await this._invokeTauri('mupdf_stage_pdf', { filePath });
        } catch (err) {
            console.warn('[PlatformBridge] Native PDF staging unavailable:', err);
            return null;
        }
    }

    /** Reclaim an orphaned or obsolete snapshot from native cache. */
    async reclaimSnapshot(snapshotPath) {
        if (!this.isTauri || !snapshotPath) return false;
        try {
            return await this._invokeTauri('mupdf_reclaim_snapshot', { snapshotPath });
        } catch (err) {
            console.warn('[PlatformBridge] Snapshot reclaim failed:', snapshotPath, err);
            return false;
        }
    }

    // ==========================================
    // 2. Window Controls & States
    // ==========================================

    /**
     * Minimize window
     */
    async windowMinimize() {
        if (this._getNativeElectron()?.minimize) {
            this._getNativeElectron().minimize();
            return;
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    await window.__TAURI__.window.getCurrentWindow().minimize();
                } else {
                    await this._invokeTauri('window_minimize');
                }
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_minimize error:', e);
            }
        }
    }

    /**
     * Maximize or unmaximize window
     */
    async windowMaximize() {
        if (this._getNativeElectron()?.maximize) {
            this._getNativeElectron().maximize();
            return;
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    await window.__TAURI__.window.getCurrentWindow().toggleMaximize();
                } else {
                    await this._invokeTauri('window_maximize');
                }
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_maximize error:', e);
            }
        }
    }

    /**
     * Close window
     */
    async windowClose() {
        if (this._getNativeElectron()?.close) {
            this._getNativeElectron().close();
            return;
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    await window.__TAURI__.window.getCurrentWindow().close();
                } else {
                    await this._invokeTauri('window_close');
                }
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_close error:', e);
            }
            return;
        }
        if (typeof window !== 'undefined' && window.close) {
            window.close();
        }
    }

    /**
     * Check if window is currently maximized
     * @returns {Promise<boolean>}
     */
    async isWindowMaximized() {
        if (this._getNativeElectron()?.isMaximized) {
            return await this._getNativeElectron().isMaximized();
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    return await window.__TAURI__.window.getCurrentWindow().isMaximized();
                }
                return await this._invokeTauri('window_is_maximized');
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Toggle fullscreen mode
     */
    async toggleFullscreen() {
        if (this._getNativeElectron()?.toggleFullscreen) {
            this._getNativeElectron().toggleFullscreen();
            return;
        }
        if (this.isTauri) {
            try {
                await this._invokeTauri('window_toggle_fullscreen');
                return;
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_toggle_fullscreen error:', e);
            }
        }
        // Web fallback
        if (typeof document !== 'undefined') {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen?.().catch(() => {});
            } else {
                document.exitFullscreen?.().catch(() => {});
            }
        }
    }

    /**
     * Check if window is currently fullscreen
     * @returns {Promise<boolean>}
     */
    async isFullscreen() {
        if (this._getNativeElectron()?.isFullscreen) {
            return await this._getNativeElectron().isFullscreen();
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('window_is_fullscreen');
            } catch (e) {
                return false;
            }
        }
        return Boolean(typeof document !== 'undefined' && document.fullscreenElement);
    }

    /**
     * Listen to fullscreen state change
     * @param {function(boolean): void} callback
     * @returns {function(): void} Unsubscribe function
     */
    onFullscreenChange(callback) {
        if (this._getNativeElectron()?.onFullscreenChange) {
            return this._getNativeElectron().onFullscreenChange(callback);
        }

        if (this.isTauri && window.__TAURI__?.event?.listen) {
            let unlistenFn = null;
            window.__TAURI__.event.listen('window:fullscreen-change', (event) => {
                callback(Boolean(event.payload));
            }).then(unlisten => { unlistenFn = unlisten; });

            return () => {
                if (unlistenFn) unlistenFn();
            };
        }

        // Web fallback: listen to DOM fullscreenchange
        if (typeof document !== 'undefined') {
            const listener = () => callback(Boolean(document.fullscreenElement));
            document.addEventListener('fullscreenchange', listener);
            return () => document.removeEventListener('fullscreenchange', listener);
        }

        return () => {};
    }

    // ==========================================
    // 3. Application Lifecycle & System Integration
    // ==========================================

    /**
     * Listen to OS file association open event
     * @param {function(object): void} callback
     * @returns {function(): void & { ready: Promise<void> }}
     */
    onOpenFile(callback) {
        if (this._getNativeElectron()?.onOpenFile) {
            const unsub = this._getNativeElectron().onOpenFile(callback);
            if (typeof unsub === 'function' && !unsub.ready) {
                unsub.ready = Promise.resolve();
            }
            return unsub;
        }

        if (this.isTauri && window.__TAURI__?.event?.listen) {
            let unlistenFn = null;
            const readyPromise = window.__TAURI__.event.listen('app:open-file', async (event) => {
                const payload = event.payload;
                if (payload && payload.buffer) {
                    let buf = payload.buffer;
                    if (buf && typeof buf === 'object' && 'body' in buf) {
                        buf = buf.body;
                    }
                    if (Array.isArray(buf)) {
                        payload.buffer = new Uint8Array(buf).buffer;
                    } else if (ArrayBuffer.isView(buf)) {
                        payload.buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                    } else if (buf && typeof buf.arrayBuffer === 'function') {
                        payload.buffer = await buf.arrayBuffer();
                    }
                }
                callback(payload);
            }).then(unlisten => { unlistenFn = unlisten; });

            const unsub = () => {
                if (unlistenFn) unlistenFn();
            };
            unsub.ready = readyPromise;
            return unsub;
        }

        const noop = () => {};
        noop.ready = Promise.resolve();
        return noop;
    }

    /**
     * Hook before application quits to flush state (Electron / Web beforeunload)
     * @param {function(): void} callback
     */
    onFlushBeforeQuit(callback) {
        if (this._getNativeElectron()?.onFlushBeforeQuit) {
            this._getNativeElectron().onFlushBeforeQuit(callback);
            return;
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', () => {
                callback();
            });
        }
    }

    /**
     * Listen to Tauri close-request flush signal
     * @param {function(string|null): Promise<void>|void} callback
     * @returns {function(): void}
     */
    onFlushRequest(callback) {
        if (this.isTauri && window.__TAURI__?.event?.listen) {
            let unlistenFn = null;
            window.__TAURI__.event.listen('app:request-flush', async (event) => {
                const reqId = event.payload?.requestId || event.payload?.request_id || (typeof event.payload === 'string' ? event.payload : null);
                try {
                    await callback(reqId);
                } catch (e) {
                    console.error('[PlatformBridge] onFlushRequest callback failed:', e);
                }
            }).then(unlisten => { unlistenFn = unlisten; });

            return () => {
                if (unlistenFn) unlistenFn();
            };
        }
        return () => {};
    }

    /**
     * Signal to backend that state flush is complete
     * @param {string|null} [requestId=null]
     */
    flushComplete(requestId = null) {
        if (this._getNativeElectron()?.flushComplete) {
            this._getNativeElectron().flushComplete(requestId);
            return;
        }
        if (this.isTauri) {
            this._invokeTauri('app_flush_complete', { requestId, request_id: requestId }).catch((err) => {
                console.warn('[PlatformBridge] app_flush_complete invoke failed:', err);
            });
        }
    }

    /**
     * Notify backend that renderer is ready to receive pending files
     */
    async rendererReady() {
        if (this._getNativeElectron()?.rendererReady) {
            return await this._getNativeElectron().rendererReady();
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('app_renderer_ready');
            } catch (e) {
                return true;
            }
        }
        return true;
    }

    /**
     * Open URL in user's default web browser
     * @param {string} url
     */
    async openExternal(url) {
        if (!url) return false;
        if (this._getNativeElectron()?.openExternal) {
            return await this._getNativeElectron().openExternal(url);
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.shell?.open) {
                    await window.__TAURI__.shell.open(url);
                    return true;
                }
                return await this._invokeTauri('shell_open_external', { url });
            } catch (e) {
                console.warn('[PlatformBridge] Tauri openExternal error:', e);
            }
        }
        if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        }
        return false;
    }

    /**
     * Get application version
     * @returns {Promise<string>}
     */
    async getVersion() {
        if (this._getNativeElectron()?.getVersion) {
            return await this._getNativeElectron().getVersion();
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.app?.getVersion) {
                    return await window.__TAURI__.app.getVersion();
                }
                return await this._invokeTauri('app_get_version');
            } catch (e) {
                return '2.0.0';
            }
        }
        return '2.0.0';
    }

    /**
     * Alias for getVersion
     * @returns {Promise<string>}
     */
    async getAppVersion() {
        return await this.getVersion();
    }

    /**
     * Check GitHub release update
     * @param {string} repo
     */
    async checkGitHubRelease(repo) {
        if (this._getNativeElectron()?.checkGitHubRelease) {
            return await this._getNativeElectron().checkGitHubRelease(repo);
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('updater_check_release', { repo });
            } catch (e) {
                // Fallback to fetch directly
            }
        }
        // Web fallback via GitHub API
        try {
            const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
            const json = await res.json();
            return {
                success: true,
                data: json,
                tagName: json.tag_name,
                body: json.body,
                htmlUrl: json.html_url
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // ==========================================
    // 4. WebDAV / Cloud Sync APIs
    // ==========================================

    /**
     * Read local WebDAV configuration (password masked)
     * @returns {Promise<object>}
     */
    async getSyncConfig() {
        if (this._getNativeElectron()?.syncGetConfig) {
            return await this._getNativeElectron().syncGetConfig();
        }

        if (this.isTauri) {
            try {
                return await this._invokeTauri('sync_get_config');
            } catch (e) {
                console.warn('[PlatformBridge] Tauri sync_get_config error:', e);
            }
        }

        // Web fallback to localStorage
        try {
            const raw = localStorage.getItem('linden_sync_config');
            if (raw) {
                const parsed = JSON.parse(raw);
                return {
                    ...parsed,
                    hasPassword: Boolean(parsed.password),
                    password: ''
                };
            }
        } catch (e) {}

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
        };
    }

    /**
     * Save local WebDAV configuration with encrypted password
     * @param {object} config
     * @returns {Promise<boolean>}
     */
    async saveSyncConfig(config) {
        if (this._getNativeElectron()?.syncSaveConfig) {
            return await this._getNativeElectron().syncSaveConfig(config);
        }

        if (this.isTauri) {
            try {
                return await this._invokeTauri('sync_save_config', { config, newConfig: config, new_config: config });
            } catch (e) {
                console.error('[PlatformBridge] Tauri sync_save_config error:', e);
                return false;
            }
        }

        // Web fallback
        try {
            const existingRaw = localStorage.getItem('linden_sync_config');
            const existing = existingRaw ? JSON.parse(existingRaw) : {};
            const toSave = { ...existing, ...config };
            if (!config.password && existing.password) {
                toSave.password = existing.password;
            }
            localStorage.setItem('linden_sync_config', JSON.stringify(toSave));
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Reveal plaintext password for user verification
     * @returns {Promise<string>}
     */
    async revealSyncPassword() {
        if (this._getNativeElectron()?.syncRevealPassword) {
            return await this._getNativeElectron().syncRevealPassword();
        }

        if (this.isTauri) {
            try {
                return await this._invokeTauri('sync_reveal_password');
            } catch (e) {
                return '';
            }
        }

        // Web fallback
        try {
            const raw = localStorage.getItem('linden_sync_config');
            if (raw) {
                const parsed = JSON.parse(raw);
                return parsed.password || '';
            }
        } catch (e) {}
        return '';
    }

    /**
     * Securely store credential using OS DPAPI / Keychain when available
     * @param {string} key
     * @param {string} value
     * @returns {Promise<boolean>}
     */
    async secureStoreCredential(key, value) {
        if (!key) return false;
        if (this._getNativeElectron()?.secureStoreCredential) {
            return await this._getNativeElectron().secureStoreCredential(key, value);
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('secure_store_credential', { key, value });
            } catch (e) {
                console.warn('[PlatformBridge] secure_store_credential error:', e);
                return false;
            }
        }
        try {
            sessionStorage.setItem(`__sec_${key}`, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Securely load credential using OS DPAPI / Keychain when available
     * @param {string} key
     * @returns {Promise<string | null>}
     */
    async secureLoadCredential(key) {
        if (!key) return null;
        if (this._getNativeElectron()?.secureLoadCredential) {
            return await this._getNativeElectron().secureLoadCredential(key);
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('secure_load_credential', { key });
            } catch (e) {
                console.warn('[PlatformBridge] secure_load_credential error:', e);
                return null;
            }
        }
        try {
            return sessionStorage.getItem(`__sec_${key}`) || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if credential exists
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async secureHasCredential(key) {
        if (!key) return false;
        if (this._getNativeElectron()?.secureHasCredential) {
            return await this._getNativeElectron().secureHasCredential(key);
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('secure_has_credential', { key });
            } catch (e) {
                console.warn('[PlatformBridge] secure_has_credential error:', e);
                return false;
            }
        }
        try {
            return Boolean(sessionStorage.getItem(`__sec_${key}`));
        } catch (e) {
            return false;
        }
    }

    /**
     * Delete stored credential
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async secureDeleteCredential(key) {
        if (!key) return false;
        if (this._getNativeElectron()?.secureDeleteCredential) {
            return await this._getNativeElectron().secureDeleteCredential(key);
        }
        if (this.isTauri) {
            try {
                return await this._invokeTauri('secure_delete_credential', { key });
            } catch (e) {
                console.warn('[PlatformBridge] secure_delete_credential error:', e);
                return false;
            }
        }
        try {
            sessionStorage.removeItem(`__sec_${key}`);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Start background TTS playback using Android Foreground Media Service
     * @param {string} bookTitle
     * @param {string} text
     * @param {number} rate
     * @returns {Promise<boolean>}
     */
    async startBackgroundTts(bookTitle, text, rate = 1.0) {
        if (this.isAndroid && this.isTauri) {
            try {
                return await this._invokeTauri('android_start_background_tts', { bookTitle, text, rate });
            } catch (e) {
                console.warn('[PlatformBridge] startBackgroundTts error:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Pause background TTS playback
     * @returns {Promise<boolean>}
     */
    async pauseBackgroundTts() {
        if (this.isAndroid && this.isTauri) {
            try {
                return await this._invokeTauri('android_pause_background_tts');
            } catch (e) {
                console.warn('[PlatformBridge] pauseBackgroundTts error:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Resume background TTS playback
     * @returns {Promise<boolean>}
     */
    async resumeBackgroundTts() {
        if (this.isAndroid && this.isTauri) {
            try {
                return await this._invokeTauri('android_resume_background_tts');
            } catch (e) {
                console.warn('[PlatformBridge] resumeBackgroundTts error:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Stop background TTS playback
     * @returns {Promise<boolean>}
     */
    async stopBackgroundTts() {
        if (this.isAndroid && this.isTauri) {
            try {
                return await this._invokeTauri('android_stop_background_tts');
            } catch (e) {
                console.warn('[PlatformBridge] stopBackgroundTts error:', e);
                return false;
            }
        }
        return false;
    }

    /**
     * Get background playback state from Android Media Service
     * @returns {Promise<{ isPlaying: boolean, bookTitle: string, text: string }>}
     */
    async getBackgroundPlaybackState() {
        if (this.isAndroid && this.isTauri) {
            try {
                return await this._invokeTauri('android_get_playback_state');
            } catch (e) {
                console.warn('[PlatformBridge] getBackgroundPlaybackState error:', e);
            }
        }
        return { isPlaying: false, bookTitle: '', text: '' };
    }

    /**
     * Test connection to WebDAV server
     * @param {object} config
     * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
     */
    async testSyncConnection(config) {
        if (this._getNativeElectron()?.syncTestConnection) {
            return await this._getNativeElectron().syncTestConnection(config);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_test_connection', { config, newConfig: config });
                if (res && (res.success !== undefined || typeof res === 'object')) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_test_connection failed, trying WebDAVService fallback:', err);
            }
        }

        // Direct fallback via WebDAVService in browser
        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.testConnection(config);
        }

        return { success: false, error: 'WebDAV 客户端不可用' };
    }

    /**
     * Fetch remote sync state data
     * @param {object} config
     * @returns {Promise<{ exists: boolean, data?: any, etag?: string, error?: string }>}
     */
    async fetchRemoteSyncState(config) {
        if (this._getNativeElectron()?.syncFetchRemote) {
            return await this._getNativeElectron().syncFetchRemote(config);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_fetch_remote', { config });
                if (res && res.exists !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_fetch_remote failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.fetchRemoteState(config);
        }

        return { exists: false, error: '云同步不可用' };
    }

    /**
     * Save merged sync state data to remote server
     * @param {object} config
     * @param {object} data
     * @param {string|null} [etag=null]
     * @returns {Promise<{ success: boolean, isConflict?: boolean, etag?: string, error?: string }>}
     */
    async saveRemoteSyncState(config, data, etag = null) {
        if (this._getNativeElectron()?.syncSaveRemote) {
            return await this._getNativeElectron().syncSaveRemote(config, data, etag);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_save_remote', { config, data, etag });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_save_remote failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.saveRemoteState({ ...config, data, etag });
        }

        return { success: false, error: '云同步不可用' };
    }

    /**
     * Upload single book binary to WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @param {ArrayBuffer|Uint8Array} buffer
     * @returns {Promise<{ success: boolean, fileName?: string, size?: number, error?: string }>}
     */
    async uploadBookBinary(config, fileName, buffer) {
        if (this._getNativeElectron()?.syncUploadBookBinary) {
            return await this._getNativeElectron().syncUploadBookBinary(config, fileName, buffer);
        }

        if (this.isTauri) {
            try {
                const u8 = buffer instanceof Uint8Array ? buffer : (buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : (buffer?.buffer instanceof ArrayBuffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer || [])));
                const res = await this._invokeTauri('sync_upload_book_binary', {
                    config,
                    fileName,
                    file_name: fileName,
                    buffer: Array.from(u8)
                });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_upload_book_binary failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.uploadBookBinary({ ...config, fileName, buffer });
        }

        return { success: false, error: '云同步不可用' };
    }

    /**
     * Download single book binary from WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @returns {Promise<{ success: boolean, isNotFound?: boolean, fileName?: string, size?: number, buffer?: ArrayBuffer, error?: string }>}
     */
    async downloadBookBinary(config, fileName) {
        if (this._getNativeElectron()?.syncDownloadBookBinary) {
            return await this._getNativeElectron().syncDownloadBookBinary(config, fileName);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_download_book_binary', { config, fileName, file_name: fileName });
                if (res && res.success && res.buffer) {
                    let arrayBuffer = null;
                    if (res.buffer instanceof ArrayBuffer) {
                        arrayBuffer = res.buffer;
                    } else if (ArrayBuffer.isView(res.buffer)) {
                        arrayBuffer = res.buffer.buffer.slice(res.buffer.byteOffset, res.buffer.byteOffset + res.buffer.byteLength);
                    } else if (Array.isArray(res.buffer)) {
                        arrayBuffer = new Uint8Array(res.buffer).buffer;
                    }
                    return {
                        ...res,
                        buffer: arrayBuffer
                    };
                }
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_download_book_binary failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.downloadBookBinary({ ...config, fileName });
        }

        return { success: false, error: '云同步不可用' };
    }

    /**
     * Delete book binary from WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @returns {Promise<{ success: boolean, fileName?: string, error?: string }>}
     */
    async deleteBookBinary(config, fileName) {
        if (this._getNativeElectron()?.syncDeleteBookBinary) {
            return await this._getNativeElectron().syncDeleteBookBinary(config, fileName);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_delete_book_binary', { config, fileName, file_name: fileName });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_delete_book_binary failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.deleteBookBinary({ ...config, fileName });
        }

        return { success: false, error: '云同步不可用' };
    }

    // ==========================================
    // Android Foundations: SAF, Keystore & Media
    // ==========================================

    get isAndroid() {
        return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
    }

    /**
     * Resolve Android SAF content:// URI or stream to private cache
     * @param {string} contentUri
     * @returns {Promise<{ success: boolean, cachePath?: string, buffer?: ArrayBuffer, filename?: string, error?: string }>}
     */
    async resolveSafContentUri(contentUri) {
        if (!contentUri) return { success: false, error: 'Empty content URI' };
        
        // 1. If running under Tauri Android layer
        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('android_resolve_content_uri', { contentUri });
                if (res && res.success) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri android_resolve_content_uri failed:', err);
            }
        }

        // 2. Browser / WebView fetch streaming fallback
        try {
            const resp = await fetch(contentUri);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} resolving content URI`);
            const buffer = await resp.arrayBuffer();
            const filename = contentUri.split('/').pop() || 'book';
            return {
                success: true,
                buffer,
                filename
            };
        } catch (e) {
            return {
                success: false,
                error: e.message || 'Failed to resolve content URI'
            };
        }
    }

    /**
     * Request persistent URI permission for Android SAF
     */
    async takePersistableUriPermission(contentUri) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_take_persistable_uri_permission', { contentUri });
            } catch (e) {
                console.warn('[PlatformBridge] takePersistableUriPermission warning:', e);
            }
        }
        return true;
    }

    /**
     * Android Keystore / Hardware-backed Credential Storage
     */
    async androidStoreCredential(key, secret) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_keystore_store', { key, secret });
            } catch (e) {}
        }
        return await this.secureStoreCredential(key, secret);
    }

    get isAndroid() {
        if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) return true;
        if (typeof window !== 'undefined' && (window.__TAURI_PLATFORM__ === 'android' || window.__TAURI_INTERNALS__?.plugins?.linden)) return true;
        return false;
    }

    /**
     * Android Background Media / TTS Commands
     */
    async startBackgroundTts(bookTitle, text, rate = 1.0, options = {}) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_start_background_tts', {
                    bookTitle,
                    text,
                    rate: Number(rate) || 1.0,
                    jobId: options.jobId || null,
                    utteranceId: options.utteranceId || null,
                    generation: options.generation != null ? Number(options.generation) : null
                });
            } catch (e) {
                console.warn('[PlatformBridge] startBackgroundTts failed:', e);
                return false;
            }
        }
        return false;
    }

    async pauseBackgroundTts() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_pause_background_tts');
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    async resumeBackgroundTts() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_resume_background_tts');
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    async stopBackgroundTts() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_stop_background_tts');
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    async getBackgroundPlaybackState() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_get_playback_state');
            } catch (e) {
                return { isPlaying: false, state: 'idle', bookTitle: '', text: '' };
            }
        }
        return { isPlaying: false, state: 'idle', bookTitle: '', text: '' };
    }

    /**
     * Staged External Pending Imports (ACTION_VIEW / ACTION_SEND)
     */
    async getPendingImports() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_get_pending_imports');
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    async consumePendingImport(importId) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_consume_pending_import', { importId });
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Android Gallery & Sharing Support for Annual Report / Quote Card
     */
    async saveImageToGallery(base64Data, filename) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_save_image_to_gallery', {
                    base64: base64Data,
                    filename: filename || `linden_${Date.now()}.png`
                });
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }
        // Fallback for desktop browser: trigger download
        try {
            const link = document.createElement('a');
            link.href = base64Data;
            link.download = filename || `linden_${Date.now()}.png`;
            link.click();
            return { success: true, path: filename };
        } catch (e) {
            return { success: false, error: e.message || String(e) };
        }
    }

    async shareImage(base64Data, filename, title = '分享图片') {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_share_image', {
                    base64: base64Data,
                    filename: filename || `linden_share_${Date.now()}.png`,
                    title
                });
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }
        // Fallback for Web Share API
        if (typeof navigator !== 'undefined' && navigator.share) {
            try {
                const res = await fetch(base64Data);
                const blob = await res.blob();
                const file = new File([blob], filename || 'share.png', { type: 'image/png' });
                await navigator.share({
                    title,
                    files: [file]
                });
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }
        return { success: false, error: '当前环境不支持分享对话框' };
    }

    // ==========================================
    // Backward Compatibility Aliases (matching electronAPI exactly)
    // ==========================================
    get syncGetConfig() { return this.getSyncConfig.bind(this); }
    get syncSaveConfig() { return this.saveSyncConfig.bind(this); }
    get syncRevealPassword() { return this.revealSyncPassword.bind(this); }
    get syncTestConnection() { return this.testSyncConnection.bind(this); }
    get syncFetchRemote() { return this.fetchRemoteSyncState.bind(this); }
    get syncSaveRemote() { return this.saveRemoteSyncState.bind(this); }
    get syncUploadBookBinary() { return this.uploadBookBinary.bind(this); }
    get syncDownloadBookBinary() { return this.downloadBookBinary.bind(this); }
    get syncDeleteBookBinary() { return this.deleteBookBinary.bind(this); }
    get minimize() { return this.windowMinimize.bind(this); }
    get maximize() { return this.windowMaximize.bind(this); }
    get close() { return this.windowClose.bind(this); }
    get isMaximized() { return this.isWindowMaximized.bind(this); }
}

// Instantiate singleton
export const platformBridge = new PlatformBridge();

// Expose on global window for legacy/direct script usage
if (typeof window !== 'undefined') {
    window.platformBridge = platformBridge;
    if (!window.electronAPI) {
        window.electronAPI = platformBridge;
    }
}

export default platformBridge;
