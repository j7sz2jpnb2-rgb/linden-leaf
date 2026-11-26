// js/platformBridge.js - Universal Cross-Platform Bridge for Linden Leaf
// Unifies Electron IPC, Tauri 2.0 Rust commands, and Web/Browser fallback into a clean Promise-based API.
import { getLocale, t } from './i18n.js'

const withLocale = (cfg) => ({ ...(cfg || {}), locale: cfg?.locale || getLocale() })

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
     *   hasNativePdf: boolean,
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
            // Native compiled Rust PDF backend available in Tauri
            hasNativePdf: Boolean(isTauri),
            hasNativeMuPdf: Boolean(isTauri),
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
        const isAndroid = this.isAndroid || this.getOS() === 'android';
        const isConstrained = Boolean(
            isAndroid ||
            (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 6)
        );
        this._resourceBudget = {
            maxMemoryMb: budget.maxMemoryMb || (isConstrained ? 512 : (isWin ? 1024 : 384)),
            maxCacheMb: budget.maxCacheMb || (isConstrained ? 64 : (isWin ? 256 : 128)),
            maxConcurrentTasks: budget.maxConcurrentTasks || (isConstrained ? 1 : (isWin ? 3 : 1)),
            maxConcurrent: budget.maxConcurrent || (isConstrained ? 1 : (isAndroid ? 1 : 2)),
            coverMaxConcurrent: budget.coverMaxConcurrent || 1,
            isLowMemoryDevice: budget.isLowMemoryDevice !== undefined ? budget.isLowMemoryDevice : isConstrained,
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

    getPdfRenderBudget() {
        const budget = this.getResourceBudget()
        const isLowMemoryDevice = this.getOS() !== 'windows' || Boolean(budget.isLowMemoryDevice)
        return {
            isLowMemoryDevice,
            bitmapCacheLimitBytes: isLowMemoryDevice ? 32 * 1024 * 1024 : Math.round(budget.maxCacheMb * 1024 * 1024 / 2),
            bufferPages: isLowMemoryDevice ? 1 : 2,
            renderConcurrency: isLowMemoryDevice ? 1 : Math.min(budget.maxConcurrent || 2, 2),
        }
    }

    canUseParallelPdfRendering() {
        return this.isTauri && this.getPdfRenderBudget().renderConcurrency > 1
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
     * Stream copy a document source (file, blob, or content URI) into app private snapshot cache.
     * Contract: Ensures that file-seekable engines have an isolated private file.
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
            return { success: false, error: t('bridge.error.noInputSource') };
        }

        const caps = this.getCapabilities();
        if (!caps.hasPrivateCacheStreaming) {
            return {
                success: false,
                error: t('bridge.error.noPrivateCache')
            };
        }

        if (options.signal?.aborted) {
            return { success: false, error: t('bridge.error.opCancelled') };
        }

        // 1. Android content:// URIs use Android native import/snapshot commands rather than legacy SAF cache IPC
        if (source.contentUri && this.isContentUri(source.contentUri)) {
            return { success: false, error: t('bridge.error.noContentResolver') };
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
                return { success: false, error: t('bridge.error.localCopyError', { error: err.message || err }) };
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
                return { success: false, error: t('bridge.error.memCopyError', { error: err.message || err }) };
            }
        }

        return { success: false, error: t('bridge.error.noCacheStrategy') };
    }

    /**
     * Low-level Tauri invoke dispatcher supporting Tauri 2.0 and Tauri 1.x
     */
    async _invokeTauri(cmd, args = {}, options = undefined) {
        if (typeof window === 'undefined') {
            throw new Error(`Cannot invoke Tauri command '${cmd}' outside browser window`);
        }
        if (window.__TAURI__?.core?.invoke) {
            return options !== undefined
                ? await window.__TAURI__.core.invoke(cmd, args, options)
                : await window.__TAURI__.core.invoke(cmd, args);
        }
        if (window.__TAURI__?.invoke) {
            return options !== undefined
                ? await window.__TAURI__.invoke(cmd, args, options)
                : await window.__TAURI__.invoke(cmd, args);
        }
        if (window.__TAURI_INTERNALS__?.invoke) {
            return options !== undefined
                ? await window.__TAURI_INTERNALS__.invoke(cmd, args, options)
                : await window.__TAURI_INTERNALS__.invoke(cmd, args);
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
                const items = await this._invokeTauri('dialog_open_file', { locale: getLocale() });
                if (items && items.length > 0) return items;
                // Explicit user cancel returns null immediately, do NOT fallback to web input!
                return null;
            } catch (err) {
                console.error('[PlatformBridge] Tauri dialog_open_file failed:', err);
                return null;
            }
        }

        // Web / Fallback file input picker (pass File objects directly without eager arrayBuffer heap preloading)
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '.epub,.pdf,.docx,.txt,.md,.mobi,.azw,.azw3,.fb2,.cbz';
            input.style.display = 'none';
            document.body.appendChild(input);

            input.onchange = () => {
                const files = Array.from(input.files || []);
                document.body.removeChild(input);
                if (files.length === 0) {
                    resolve(null);
                    return;
                }
                const result = files.map(f => ({
                    filePath: f.name,
                    filename: f.name,
                    file: f,
                    size: f.size
                }));
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
     * Retrieve Android system window insets (status bar, navigation bar, gesture bar)
     * @returns {Promise<{ top: number, bottom: number, left: number, right: number }>}
     */
    async getSystemInsets() {
        if (!this.isAndroid) return { top: 0, bottom: 0, left: 0, right: 0 };
        try {
            if (this.isTauri) {
                const res = await this._invokeTauri('android_get_system_insets');
                if (res) return res;
            }
        } catch (e) {
            console.warn('[PlatformBridge] getSystemInsets warning:', e);
        }
        return { top: 0, bottom: 0, left: 0, right: 0 };
    }

    /**
     * Synchronize system insets to CSS custom properties on documentElement
     */
    async syncSystemInsets() {
        if (!this.isAndroid) return;
        const insets = await this.getSystemInsets();
        if (!insets || typeof insets !== 'object') return;
        const doc = document.documentElement;
        if (!doc) return;
        const top = Number(insets.top) || 0;
        const bottom = Number(insets.bottom) || 0;
        const left = Number(insets.left) || 0;
        const right = Number(insets.right) || 0;
        const ime = Number(insets.ime) || 0;
        const keyboardOpen = typeof insets.keyboardOpen === 'boolean' ? insets.keyboardOpen : ime > 50;
        doc.style.setProperty('--safe-area-inset-top', `${top}px`);
        doc.style.setProperty('--safe-area-inset-bottom', `${bottom}px`);
        doc.style.setProperty('--safe-area-inset-left', `${left}px`);
        doc.style.setProperty('--safe-area-inset-right', `${right}px`);
        doc.style.setProperty('--safe-top', `${top}px`);
        doc.style.setProperty('--safe-bottom', `${bottom}px`);
        doc.style.setProperty('--safe-left', `${left}px`);
        doc.style.setProperty('--safe-right', `${right}px`);
        doc.style.setProperty('--ime-inset-bottom', `${ime}px`);
        doc.style.setProperty('--ime-bottom', `${ime}px`);
        doc.style.setProperty('--viewport-keyboard-offset', `${ime > 50 ? ime : 0}px`);
        doc.style.setProperty('--window-inset-bottom', `${Math.max(bottom, ime)}px`);
        doc.classList.toggle('keyboard-open', keyboardOpen);
    }

    /**
     * Read file content from local disk as ArrayBuffer
     * @param {string} filePath
     * @returns {Promise<ArrayBuffer | null>}
     */
    async readFileBuffer(filePath, options = {}) {
        const pathStr = (typeof filePath === 'object' && filePath) ? (filePath.path || filePath.filePath || String(filePath)) : String(filePath || '');
        if (!pathStr) return null;
        if (options.signal?.aborted) {
            throw new DOMException('The operation was aborted', 'AbortError');
        }

        if (this._getNativeElectron()?.readFileBuffer) {
            return await this._getNativeElectron().readFileBuffer(pathStr);
        }

        if (this.isTauri) {
            try {
                const { offset, length } = options
                const raw = await this._invokeTauri('fs_read_buffer', { filePath: pathStr, file_path: pathStr, offset, length });
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
                console.error('[PlatformBridge] Tauri fs_read_buffer failed:', pathStr, err);
                return null;
            }
        }

        console.warn('[PlatformBridge] Direct filesystem read is unsupported in pure web mode:', pathStr);
        return null;
    }

    _readPdfPreference(key) {
        const temporary = this._temporaryPdfPreferences?.get(key)
        if (temporary !== undefined) return temporary
        try { return globalThis.localStorage?.getItem(key) } catch { return null }
    }

    _writePdfPreference(key, value) {
        try {
            globalThis.localStorage.setItem(key, value)
            this._temporaryPdfPreferences?.delete(key)
        } catch {
            this._temporaryPdfPreferences ??= new Map()
            this._temporaryPdfPreferences.set(key, value)
        }
    }

    getAndroidPdfEngine() {
        return this._readPdfPreference('linden_android_pdf_engine') === 'mupdf' ? 'mupdf' : 'pdfjs'
    }

    setAndroidPdfEngine(engine) {
        this._writePdfPreference('linden_android_pdf_engine', engine === 'mupdf' ? 'mupdf' : 'pdfjs')
    }

    getPdfParallelRendering() {
        return this.canUseParallelPdfRendering() && this._readPdfPreference('linden_pdf_parallel_rendering') === '1'
    }

    setPdfParallelRendering(enabled) {
        this._writePdfPreference('linden_pdf_parallel_rendering', enabled ? '1' : '0')
    }

    async hasNativePdfBackend() {
        if (!this.isTauri) return false
        try {
            return Boolean(await this._invokeTauri('mupdf_is_available'))
        } catch {
            return false
        }
    }

    async isNativePdfAvailable() {
        return (!this.isAndroid || this.getAndroidPdfEngine() === 'mupdf') && await this.hasNativePdfBackend()
    }

    /** Copy a local PDF once into the app-owned native cache. The caller must
     * read this returned path to create the IndexedDB Blob from the same bytes. */
    async stagePdfSource(filePath) {
        if (!this.isTauri || !filePath || !/\.pdf$/i.test(filePath)) return null;
        try {
            if (!await this.isNativePdfAvailable()) return null;
            const res = await this._invokeTauri('mupdf_stage_pdf', { filePath });
            if (!res) return null;
            let descriptor = null;
            if (typeof res === 'string') {
                try {
                    const parsed = JSON.parse(res);
                    if (parsed && typeof parsed === 'object' && parsed.path) {
                        descriptor = parsed;
                    }
                } catch (_) {}
                if (!descriptor) {
                    descriptor = { path: res, size: 0, revision: null, documentHash: null };
                }
            } else if (typeof res === 'object' && res.path) {
                descriptor = res;
            }
            return descriptor;
        } catch (err) {
            console.warn('[PlatformBridge] Native PDF staging unavailable:', err);
            return null;
        }
    }

    async stageSavedPdfBlob(blob) {
        if (!this.isTauri || !(blob instanceof Blob) || blob.isLazySnapshot || !blob.size) return null
        if (blob.size > 128 * 1024 * 1024) return null
        const raw = this.isAndroid
            ? await this._stageAndroidPdfBlob(blob)
            : await this._invokeTauri('mupdf_stage_pdf_bytes', new Uint8Array(await blob.arrayBuffer()))
        const descriptor = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!descriptor?.path || descriptor.size !== blob.size) throw new Error('Saved PDF snapshot size mismatch')
        return descriptor
    }

    async _stageAndroidPdfBlob(blob) {
        // Android Tauri sends requests as JSON. Encode one Blob slice at a time.
        const chunkSize = 256 * 1024
        const uploadId = Array.from(crypto.getRandomValues(new Uint32Array(4)),
            n => n.toString(16).padStart(8, '0')).join('')
        const size = blob.size
        let descriptor = null
        try {
            for (let offset = 0; offset < size; offset += chunkSize) {
                const chunk = blob.slice(offset, offset + chunkSize, 'application/octet-stream')
                const data = await new Promise((resolve, reject) => {
                    const reader = new FileReader()
                    reader.onerror = () => reject(reader.error)
                    reader.onload = () => resolve(reader.result.split(',', 2)[1])
                    reader.readAsDataURL(chunk)
                })
                descriptor = await this._invokeTauri('mupdf_stage_pdf_chunk', { uploadId, offset, size, data })
            }
            return descriptor
        } finally {
            if (!descriptor) {
                await this._invokeTauri('mupdf_stage_pdf_chunk', { uploadId, offset: 0, size, data: null }).catch(() => {})
            }
        }
    }

    async stageEpubSnapshot(filePath) {
        const descriptor = await this._invokeTauri('fs_stage_epub_snapshot', { filePath })
        return descriptor ? JSON.parse(descriptor) : null
    }

    async validateNativeSnapshot(snapshotPath, expectedSize = 0) {
        if (!this.isTauri || !snapshotPath) return false
        try {
            return await this._invokeTauri('mupdf_validate_snapshot', { snapshotPath, expectedSize: Number(expectedSize) || 0 })
        } catch (_) { return false }
    }

    validatePdfSnapshot(snapshotPath, expectedSize = 0) {
        return this.validateNativeSnapshot(snapshotPath, expectedSize)
    }

    /** Reclaim an orphaned or obsolete snapshot from native cache. */
    async reclaimSnapshot(snapshotPath) {
        const pathStr = (typeof snapshotPath === 'object' && snapshotPath) ? (snapshotPath.path || String(snapshotPath)) : String(snapshotPath || '');
        if (!this.isTauri || !pathStr) return false;
        try {
            return await this._invokeTauri('mupdf_reclaim_snapshot', { snapshotPath: pathStr });
        } catch (err) {
            console.warn('[PlatformBridge] Snapshot reclaim failed:', pathStr, err);
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

    async windowSetAlwaysOnTop(alwaysOnTop) {
        if (this.isTauri) {
            const flag = Boolean(alwaysOnTop);
            if (window.__TAURI__?.window?.getCurrentWindow) {
                try {
                    await window.__TAURI__.window.getCurrentWindow().setAlwaysOnTop(flag);
                    return true;
                } catch (e) {
                    console.warn('[PlatformBridge] Tauri window.setAlwaysOnTop error, falling back:', e);
                }
            }
            try {
                await this._invokeTauri('window_set_always_on_top', { alwaysOnTop: flag });
                return true;
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_set_always_on_top error:', e);
            }
        }
        return false;
    }

    async windowIsAlwaysOnTop() {
        if (this.isTauri) {
            if (window.__TAURI__?.window?.getCurrentWindow) {
                try {
                    return Boolean(await window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop());
                } catch (e) {
                    console.warn('[PlatformBridge] Tauri window.isAlwaysOnTop error, falling back:', e);
                }
            }
            try {
                return Boolean(await this._invokeTauri('window_is_always_on_top'));
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_is_always_on_top error:', e);
            }
        }
        return false;
    }

    async setWindowTitle(title) {
        const resolved = typeof title === 'string' && title.trim() ? title.trim() : 'Linden Leaf';
        if (typeof document !== 'undefined') {
            document.title = resolved;
        }
        if (this.isTauri) {
            try {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    await window.__TAURI__.window.getCurrentWindow().setTitle(resolved);
                    return true;
                }
            } catch (_) {}
            try {
                await this._invokeTauri('window_set_title', { title: resolved, locale: getLocale() });
                return true;
            } catch (_) {}
        }
        return false;
    }

    async fsScanFolder(folderPath, maxDepth = 5) {
        if (this.isTauri) {
            try {
                const raw = await this._invokeTauri('fs_scan_folder', { folderPath, maxDepth });
                const rawList = Array.isArray(raw) ? raw : (raw?.files || raw?.items || []);
                const mapped = (rawList || []).map(item => ({
                    ...item,
                    ext: item.ext || item.extension || '',
                    extension: item.extension || item.ext || '',
                    size: item.size != null ? item.size : item.fileSize,
                    fileSize: item.fileSize != null ? item.fileSize : item.size,
                    mtime: item.mtime != null ? item.mtime : item.modified_time,
                    modified_time: item.modified_time != null ? item.modified_time : item.mtime,
                    volumeId: item.volumeId || item.volume_id || null,
                    fileId: item.fileId || item.file_id || null
                }));
                if (raw && !Array.isArray(raw) && typeof raw === 'object') {
                    Object.defineProperty(mapped, 'complete', { value: raw.complete !== false, enumerable: false, configurable: true });
                    Object.defineProperty(mapped, 'errors', { value: Array.isArray(raw.errors) ? raw.errors : [], enumerable: false, configurable: true });
                    Object.defineProperty(mapped, 'failedDirs', { value: Array.isArray(raw.failed_dirs || raw.failedDirs) ? (raw.failed_dirs || raw.failedDirs) : [], enumerable: false, configurable: true });
                } else {
                    Object.defineProperty(mapped, 'complete', { value: true, enumerable: false, configurable: true });
                    Object.defineProperty(mapped, 'errors', { value: [], enumerable: false, configurable: true });
                    Object.defineProperty(mapped, 'failedDirs', { value: [], enumerable: false, configurable: true });
                }
                return mapped;
            } catch (e) {
                console.warn('[PlatformBridge] fs_scan_folder failed:', e);
                throw e;
            }
        }
        return [];
    }

    async computeNativeFileHash(filePath) {
        if (this.isTauri && filePath) {
            try {
                return await this._invokeTauri('fs_compute_file_hash', { filePath: String(filePath) });
            } catch (e) {
                console.warn('[PlatformBridge] fs_compute_file_hash failed:', e);
                return null;
            }
        }
        return null;
    }

    async fsComputeFileHash(filePath) {
        return await this.computeNativeFileHash(filePath);
    }

    async fsGetAppPaths() {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('fs_get_app_paths');
            } catch (e) {
                console.warn('[PlatformBridge] fs_get_app_paths failed:', e);
            }
        }
        return {
            config_dir: '',
            data_dir: '',
            cache_dir: '',
            snapshot_dir: '',
            documents_dir: '',
            webview_profile_dir: '',
            indexeddb_dir: ''
        };
    }

    async fsOpenInExplorer(path) {
        if (this.isTauri) {
            try {
                await this._invokeTauri('fs_open_in_explorer', { path });
                return true;
            } catch (e) {
                console.warn('[PlatformBridge] fs_open_in_explorer failed:', e);
            }
        }
        return false;
    }

    async dialogPickFolder(options = {}) {
        if (this._getNativeElectron()?.openDirectoryDialog) {
            return await this._getNativeElectron().openDirectoryDialog(options);
        }
        if (this.isTauri) {
            try {
                const title = typeof options === 'string' ? options : (options?.title || null);
                return await this._invokeTauri('dialog_pick_folder', {
                    title,
                    locale: getLocale()
                });
            } catch (e) {
                console.warn('[PlatformBridge] dialog_pick_folder failed:', e);
            }
        }
        return null;
    }

    async dialogPickSavePath(options) {
        if (this.isTauri) {
            try {
                return await this._invokeTauri('dialog_pick_save_path', {
                    defaultName: options?.defaultName || 'untitled.pdf',
                    title: options?.title || t('bridge.dialog.saveAs'),
                    filterName: options?.filterName || t('bridge.dialog.pdfFilter'),
                    filterExt: options?.filterExt || 'pdf',
                    locale: getLocale()
                });
            } catch (e) {
                console.warn('[PlatformBridge] dialog_pick_save_path failed:', e);
            }
        }
        return null;
    }

    async mupdfExportAnnotatedPdf(docId, outputPath, annotationsJson) {
        if (this.isTauri) {
            try {
                const jsonPayload = typeof annotationsJson === 'string' ? annotationsJson : JSON.stringify(annotationsJson || []);
                return await this._invokeTauri('mupdf_export_annotated_pdf', {
                    docId,
                    outputPath,
                    annotationsJson: jsonPayload
                });
            } catch (e) {
                console.warn('[PlatformBridge] mupdf_export_annotated_pdf failed:', e);
                throw e;
            }
        }
        return false;
    }

    async writeFileText(filePath, content) {
        if (this.isTauri) {
            try {
                await this._invokeTauri('fs_write_file', {
                    filePath,
                    content: typeof content === 'string' ? content : String(content)
                });
                return true;
            } catch (e) {
                console.warn('[PlatformBridge] fs_write_file failed:', e);
                throw e;
            }
        }
        return false;
    }

    /**
     * Native atomic CAS sync file read
     * @param {string} filePath
     * @returns {Promise<{ content?: string, etag?: string, missing?: boolean, status: string }>}
     */
    async readSyncFile(filePath) {
        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_read_file', { filePath, file_path: filePath });
                if (res) {
                    if (res.exists === false || res.missing === true || res.status === 'missing') {
                        return { status: 'missing', missing: true, content: '', etag: null, error: null };
                    }
                    if (res.error && (res.error.includes('Corrupted') || res.error.includes('Invalid sync JSON') || res.error.includes('Failed to read'))) {
                        return { status: 'invalid', missing: false, content: null, etag: res.etag || null, error: res.error };
                    }
                    const rawContent = res.content !== undefined ? res.content : (res.data !== undefined ? (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)) : null);
                    let status = res.status;
                    if (!status) {
                        if (res.error) {
                            if (res.error.includes('auth')) status = 'auth';
                            else if (res.error.includes('offline')) status = 'offline';
                            else status = 'invalid';
                        } else {
                            status = 'found';
                        }
                    }
                    return {
                        status,
                        content: rawContent,
                        etag: res.etag || null,
                        missing: false,
                        conflict: !!(res.conflict || res.isConflict),
                        error: res.error || null
                    };
                }
            } catch (e) {
                const msg = String(e?.message || e);
                if (/corrupted|invalid|failed to parse/i.test(msg)) {
                    return { status: 'invalid', missing: false, content: null, etag: null, error: msg };
                }
                if (/auth/i.test(msg)) {
                    return { status: 'auth', missing: false, content: null, etag: null, error: msg };
                }
                if (/offline/i.test(msg)) {
                    return { status: 'offline', missing: false, content: null, etag: null, error: msg };
                }
                if (/not found|cannot find|no such file/i.test(msg)) {
                    return { status: 'missing', missing: true, content: '', etag: null, error: null };
                }
                console.warn('[PlatformBridge] sync_read_file failed, falling back:', e);
            }
        }
        try {
            const buf = await this.readFileBuffer(filePath);
            if (!buf) {
                return { content: '', etag: null, missing: true, status: 'missing', error: null };
            }
            const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            const text = new TextDecoder('utf-8').decode(arr);
            let hash = 5381;
            for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) + text.charCodeAt(i) | 0;
            const etag = `etag_${Math.abs(hash).toString(16)}_${text.length}`;
            return { content: text, etag, status: 'found', missing: false, error: null };
        } catch (err) {
            const msg = String(err?.message || err);
            if (/not found|cannot find|no such file/i.test(msg)) {
                return { content: '', etag: null, missing: true, status: 'missing', error: null };
            }
            throw err;
        }
    }

    /**
     * Native atomic CAS sync file write with cross-process file lock and atomic rename
     * @param {string} filePath
     * @param {string} content
     * @param {string|null} expectedEtag
     * @returns {Promise<{ success: boolean, conflict?: boolean, etag?: string, error?: string }>}
     */
    async writeSyncFile(filePath, content, expectedEtag = null) {
        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_write_file', {
                    filePath,
                    file_path: filePath,
                    content,
                    expectedEtag,
                    expected_etag: expectedEtag,
                    locale: getLocale()
                });
                if (res) {
                    return {
                        success: !!res.success,
                        conflict: !!(res.conflict || res.isConflict),
                        etag: res.etag || null,
                        error: res.error || null
                    };
                }
            } catch (e) {
                console.warn('[PlatformBridge] sync_write_file failed:', e);
                // "原生 CAS 错误禁止降级无条件 writeFileText"
                return { success: false, conflict: false, error: e.message || String(e) };
            }
        }
        if (typeof this.writeFileText === 'function') {
            const ok = await this.writeFileText(filePath, content);
            if (!ok) return { success: false, error: t('bridge.error.writeFailed') };
            let hash = 5381;
            for (let i = 0; i < content.length; i++) hash = ((hash << 5) + hash) + content.charCodeAt(i) | 0;
            return { success: true, etag: `etag_${Math.abs(hash).toString(16)}_${content.length}` };
        }
        return { success: false, error: 'Platform bridge file writing not available' };
    }

    /**
     * Open a new independent application window (either a satellite reader window for a specific book
     * or a full shelf window). If a satellite window for the same bookId is already open, focuses it.
     * @param {{ bookId?: string|null, windowMode?: string|null, title?: string|null }} [options]
     */
    async openNewWindow(options = {}) {
        const bookId = options?.bookId ? String(options.bookId) : null;
        const windowMode = options?.windowMode || (bookId ? 'reader' : 'shelf');
        const title = options?.title ? String(options.title) : null;

        if (this._getNativeElectron()?.openNewWindow) {
            try {
                const res = await this._getNativeElectron().openNewWindow({
                    bookId,
                    windowMode,
                    title
                });
                if (res?.success) return res;
            } catch (e) {
                console.warn('[PlatformBridge] Electron openNewWindow failed:', e);
            }
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('window_open_new', {
                    bookId,
                    book_id: bookId,
                    windowMode,
                    window_mode: windowMode,
                    title,
                    locale: getLocale()
                });
                if (res && typeof res === 'object') return res;
                return { success: false, error: 'window_open_new returned empty response' };
            } catch (e) {
                console.warn('[PlatformBridge] Tauri window_open_new failed:', e);
                return { success: false, error: e?.message || String(e) };
            }
        }

        if (typeof window !== 'undefined' && typeof window.open === 'function') {
            const url = new URL(window.location.href);
            if (bookId) {
                url.searchParams.set('windowMode', windowMode);
                url.searchParams.set('bookId', bookId);
            } else {
                url.searchParams.delete('windowMode');
                url.searchParams.delete('bookId');
            }
            const win = window.open(url.toString(), '_blank');
            if (win) {
                return { success: true, alreadyExists: false };
            }
            return { success: false, error: 'Window.open blocked or returned null' };
        }
        return { success: false, error: 'No supported window opening mechanism' };
    }

    /**
     * Get current window label (Tauri only, returns null otherwise)
     * @returns {string|null}
     */
    getCurrentWindowLabel() {
        try {
            return window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.()?.label
                || window.__TAURI__?.window?.getCurrentWindow?.()?.label
                || null;
        } catch (_) {
            return null;
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

        if (this.isTauri) {
            const currentWin = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
            const listenFn = typeof currentWin?.listen === 'function'
                ? currentWin.listen.bind(currentWin)
                : (typeof window.__TAURI__?.event?.listen === 'function'
                    ? window.__TAURI__.event.listen.bind(window.__TAURI__.event)
                    : null);
            if (listenFn) {
                let unlistenFn = null;
                let disposed = false;
                listenFn('window:fullscreen-change', (event) => {
                    callback(Boolean(event.payload));
                }).then(unlisten => {
                    if (disposed) {
                        unlisten?.();
                    } else {
                        unlistenFn = unlisten;
                    }
                });

                return () => {
                    disposed = true;
                    if (unlistenFn) unlistenFn();
                };
            }
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
                const targetWinLabel = event.payload?.windowLabel || event.payload?.window_label || null;
                if (targetWinLabel) {
                    try {
                        const curLabel = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.()?.label
                            || window.__TAURI__?.window?.getCurrentWindow?.()?.label
                            || null;
                        if (curLabel && curLabel !== targetWinLabel) {
                            return;
                        }
                    } catch (_) {}
                }
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

    _isSafeExternalUrl(url) {
        if (typeof url !== 'string') return null;
        const trimmed = url.trim();
        if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
        try {
            const parsed = new URL(trimmed);
            if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return null;
            return parsed.protocol === 'mailto:'
                ? (trimmed.length > 'mailto:'.length ? trimmed : null)
                : (parsed.hostname ? trimmed : null);
        } catch (_) {
            return null;
        }
    }

    /**
     * Open URL in user's default web browser
     * @param {string} url
     */
    async openExternal(url) {
        const safeUrl = this._isSafeExternalUrl(url);
        if (!safeUrl) return false;
        if (this._getNativeElectron()?.openExternal) {
            const opened = await this._getNativeElectron().openExternal(safeUrl);
            if (opened !== false) return Boolean(opened ?? true);
        }
        if (this.isTauri) {
            if (window.__TAURI__?.shell?.open) {
                try {
                    await window.__TAURI__.shell.open(safeUrl);
                    return true;
                } catch (e) {
                    console.warn('[PlatformBridge] Tauri shell.open error, falling back:', e);
                }
            }
            try {
                const opened = await this._invokeTauri('shell_open_external', { url: safeUrl });
                if (opened === true) return true;
            } catch (e) {
                console.warn('[PlatformBridge] Tauri openExternal error:', e);
            }
        }
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
            const win = window.open(safeUrl, '_blank', 'noopener,noreferrer');
            return Boolean(win);
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
                return '1.0.0';
            }
        }
        return '1.0.0';
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
        const loc = getLocale();
        if (this._getNativeElectron()?.checkGitHubRelease) {
            return await this._getNativeElectron().checkGitHubRelease(repo, loc);
        }
        // Tauri & Web: query GitHub Releases API directly (with 403 raw package.json fallback)
        try {
            const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });
            if (!res.ok) {
                if (res.status === 403) {
                    try {
                        const rawRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`);
                        if (rawRes.ok) {
                            const pkg = await rawRes.json();
                            const fallbackData = {
                                tag_name: `v${pkg.version || '0.1.0'}`,
                                name: `Linden Leaf v${pkg.version || '0.1.0'}`,
                                html_url: `https://github.com/${repo}/releases`,
                                body: t('updater.viewOnGithub')
                            };
                            return {
                                success: true,
                                data: fallbackData,
                                tagName: fallbackData.tag_name,
                                body: fallbackData.body,
                                htmlUrl: fallbackData.html_url
                            };
                        }
                    } catch (_) {}
                    return { success: false, error: t('updater.rateLimited') };
                }
                if (res.status === 404) {
                    return { success: false, error: t('updater.noRelease', { repo }) };
                }
                return { success: false, error: t('updater.httpError', { status: res.status }) };
            }
            const json = await res.json();
            return {
                success: true,
                data: json,
                tagName: json.tag_name,
                body: json.body,
                htmlUrl: json.html_url
            };
        } catch (err) {
            return { success: false, error: err?.message || t('updater.networkFallback') };
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
     * Reveal plaintext password for user verification (deprecated; credentials are secure)
     * @returns {Promise<string>}
     */
    async revealSyncPassword() {
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

    /**
     * Pause background TTS playback
     * @returns {Promise<boolean>}
     */

    /**
     * Resume background TTS playback
     * @returns {Promise<boolean>}
     */

    /**
     * Stop background TTS playback
     * @returns {Promise<boolean>}
     */

    /**
     * Get background playback state from Android Media Service
     * @returns {Promise<{ isPlaying: boolean, bookTitle: string, text: string }>}
     */
    async exportBookFile(filePath, filename, share = false) {
        if (!this.isAndroid || !this.isTauri) throw new Error(t('bridge.error.exportUnsupported'))
        return this._invokeTauri('android_export_book_file', { filePath, filename, share, locale: getLocale() })
    }

    async acknowledgeTtsListening(throughSequence) {
        if (!this.isAndroid || !this.isTauri) return
        return this._invokeTauri('android_acknowledge_tts_listening', { throughSequence })
    }

    async requestTtsAudio(endpoint, body, headers = {}, signal) {
        if (signal?.aborted) throw new DOMException(t('bridge.error.ttsStopped'), 'AbortError')
        const requestId = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}`
        const abort = () => this._invokeTauri('tts_cancel_audio', { requestId }).catch(() => {})
        signal?.addEventListener('abort', abort, { once: true })
        try {
            const raw = await this._invokeTauri('tts_request_audio', { requestId, endpoint, body, headers, locale: getLocale() })
            if (signal?.aborted) throw new DOMException(t('bridge.error.ttsStopped'), 'AbortError')
            if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw
            if (Array.isArray(raw)) return new Uint8Array(raw)
            throw new Error(t('bridge.error.ttsNoAudio'))
        } finally { signal?.removeEventListener('abort', abort) }
    }

    /**
     * Test connection to WebDAV server
     * @param {object} config
     * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
     */
    async testSyncConnection(config) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncTestConnection) {
            return await this._getNativeElectron().syncTestConnection(localizedConfig);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_test_connection', { config: localizedConfig, newConfig: localizedConfig });
                if (res && (res.success !== undefined || typeof res === 'object')) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_test_connection failed, trying WebDAVService fallback:', err);
            }
        }

        // Direct fallback via WebDAVService in browser
        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.testConnection(localizedConfig);
        }

        return { success: false, error: t('bridge.error.webdavUnavailable') };
    }

    /**
     * Fetch remote sync state data
     * @param {object} config
     * @returns {Promise<{ exists: boolean, data?: any, etag?: string, error?: string }>}
     */
    async fetchRemoteSyncState(config) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncFetchRemote) {
            return await this._getNativeElectron().syncFetchRemote(localizedConfig);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_fetch_remote', { config: localizedConfig });
                if (res && res.exists !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_fetch_remote failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.fetchRemoteState(localizedConfig);
        }

        return { exists: false, error: t('bridge.error.syncUnavailable') };
    }

    /**
     * Save merged sync state data to remote server
     * @param {object} config
     * @param {object} data
     * @param {string|null} [etag=null]
     * @returns {Promise<{ success: boolean, isConflict?: boolean, etag?: string, error?: string }>}
     */
    async saveRemoteSyncState(config, data, etag = null, summaryMarkdown = null) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncSaveRemote) {
            return await this._getNativeElectron().syncSaveRemote(localizedConfig, data, etag, summaryMarkdown);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_save_remote', {
                    config: localizedConfig,
                    data,
                    etag,
                    summaryMarkdown,
                    summary_markdown: summaryMarkdown
                });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_save_remote failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.saveRemoteState({ ...localizedConfig, data, etag, summaryMarkdown });
        }

        return { success: false, error: t('bridge.error.syncUnavailable') };
    }

    _bytesToBase64(u8) {
        if (!u8 || u8.length === 0) return '';
        // 24 KiB is an exact multiple of 3 bytes so each chunk encodes cleanly without padding mid-stream,
        // avoiding allocating one giant binary string + Base64 copy simultaneously on large Android payloads.
        const chunkSize = 0x6000;
        if (u8.length <= chunkSize) {
            return btoa(String.fromCharCode(...u8));
        }
        const parts = [];
        for (let i = 0; i < u8.length; i += chunkSize) {
            const slice = u8.subarray(i, Math.min(i + chunkSize, u8.length));
            parts.push(btoa(String.fromCharCode(...slice)));
        }
        return parts.join('');
    }

    _utf8ToBase64(str) {
        return this._bytesToBase64(new TextEncoder().encode(String(str ?? '')));
    }

    _parseRawSyncError(err) {
        const rawText = typeof err === 'string'
            ? err
            : (typeof err?.message === 'string' ? err.message : null);
        if (!rawText || !rawText.trim().startsWith('{')) return null;
        try {
            const parsed = JSON.parse(rawText);
            if (parsed && typeof parsed.error === 'string') {
                return parsed;
            }
        } catch (_) {}
        return null;
    }

    async _normalizeBinaryArrayBuffer(value) {
        if (!value) return null;
        if (value instanceof ArrayBuffer) return value;
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        if (value?.body instanceof ArrayBuffer) return value.body;
        if (ArrayBuffer.isView(value?.body)) {
            return value.body.buffer.slice(value.body.byteOffset, value.body.byteOffset + value.body.byteLength);
        }
        if (typeof value?.arrayBuffer === 'function') {
            return await value.arrayBuffer();
        }
        if (Array.isArray(value)) {
            return new Uint8Array(value).buffer;
        }
        return null;
    }

    /**
     * Upload single book binary to WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @param {ArrayBuffer|Uint8Array} buffer
     * @returns {Promise<{ success: boolean, fileName?: string, size?: number, error?: string }>}
     */
    async uploadBookBinary(config, fileName, buffer) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncUploadBookBinary) {
            return await this._getNativeElectron().syncUploadBookBinary(localizedConfig, fileName, buffer);
        }

        if (this.isTauri) {
            const u8 = buffer instanceof Uint8Array
                ? buffer
                : (buffer instanceof ArrayBuffer
                    ? new Uint8Array(buffer)
                    : (buffer?.buffer instanceof ArrayBuffer
                        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
                        : new Uint8Array(buffer || [])));

            if (!this.isAndroid) {
                try {
                    const rawPayload = (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) ? u8 : u8.slice();
                    const metaHeader = this._utf8ToBase64(JSON.stringify({ config: localizedConfig, fileName }));
                    const res = await this._invokeTauri('sync_upload_book_binary_raw', rawPayload, {
                        headers: { 'x-linden-upload-meta': metaHeader }
                    });
                    if (res && res.success !== undefined) return res;
                } catch (err) {
                    console.warn('[PlatformBridge] Tauri sync_upload_book_binary_raw failed, falling back:', err);
                }
            }

            try {
                const bufferBase64 = this._bytesToBase64(u8);
                const res = await this._invokeTauri('sync_upload_book_binary', {
                    config: localizedConfig,
                    fileName,
                    file_name: fileName,
                    bufferBase64
                });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_upload_book_binary failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.uploadBookBinary({ ...localizedConfig, fileName, buffer });
        }

        return { success: false, error: t('bridge.error.syncUnavailable') };
    }

    /**
     * Download single book binary from WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @returns {Promise<{ success: boolean, isNotFound?: boolean, fileName?: string, size?: number, buffer?: ArrayBuffer, error?: string }>}
     */
    async downloadBookBinary(config, fileName) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncDownloadBookBinary) {
            return await this._getNativeElectron().syncDownloadBookBinary(localizedConfig, fileName);
        }

        if (this.isTauri) {
            try {
                const raw = await this._invokeTauri('sync_download_book_binary_raw', {
                    config: localizedConfig,
                    fileName,
                    file_name: fileName
                });
                if (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw) && raw.success !== undefined) {
                    const arrayBuffer = await this._normalizeBinaryArrayBuffer(raw.buffer);
                    return raw.success && arrayBuffer ? { ...raw, buffer: arrayBuffer } : raw;
                }
                const arrayBuffer = await this._normalizeBinaryArrayBuffer(raw);
                if (arrayBuffer) {
                    return {
                        success: true,
                        fileName,
                        size: arrayBuffer.byteLength,
                        buffer: arrayBuffer
                    };
                }
            } catch (err) {
                const structured = this._parseRawSyncError(err);
                if (structured) {
                    return {
                        success: false,
                        isNotFound: Boolean(structured.isNotFound),
                        fileName: structured.fileName || fileName,
                        error: structured.error
                    };
                }
                console.warn('[PlatformBridge] Tauri sync_download_book_binary_raw failed, trying legacy IPC fallback:', err);
                try {
                    const res = await this._invokeTauri('sync_download_book_binary', {
                        config: localizedConfig,
                        fileName,
                        file_name: fileName
                    });
                    if (res && res.success && res.buffer) {
                        const arrayBuffer = await this._normalizeBinaryArrayBuffer(res.buffer);
                        return { ...res, buffer: arrayBuffer };
                    }
                    if (res && res.success !== undefined) return res;
                } catch (legacyErr) {
                    console.warn('[PlatformBridge] Tauri sync_download_book_binary failed, trying WebDAVService fallback:', legacyErr);
                }
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.downloadBookBinary({ ...localizedConfig, fileName });
        }

        return { success: false, error: t('bridge.error.syncUnavailable') };
    }

    /**
     * Delete book binary from WebDAV LindenLeaf/books/
     * @param {object} config
     * @param {string} fileName
     * @returns {Promise<{ success: boolean, fileName?: string, error?: string }>}
     */
    async deleteBookBinary(config, fileName) {
        const localizedConfig = withLocale(config);
        if (this._getNativeElectron()?.syncDeleteBookBinary) {
            return await this._getNativeElectron().syncDeleteBookBinary(localizedConfig, fileName);
        }

        if (this.isTauri) {
            try {
                const res = await this._invokeTauri('sync_delete_book_binary', { config: localizedConfig, fileName, file_name: fileName });
                if (res && res.success !== undefined) return res;
            } catch (err) {
                console.warn('[PlatformBridge] Tauri sync_delete_book_binary failed, trying WebDAVService fallback:', err);
            }
        }

        if (typeof window !== 'undefined' && window.WebDAVService) {
            return await window.WebDAVService.deleteBookBinary({ ...localizedConfig, fileName });
        }

        return { success: false, error: t('bridge.error.syncUnavailable') };
    }

    // ==========================================
    // Android Foundations: SAF, Keystore & Media
    // ==========================================

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
    _buildTtsBridgeError(err, fallbackCode = 'BRIDGE_CALL_FAILED') {
        const raw = err instanceof Error ? err.message : String(err || '');
        const match = raw.match(/^\[([A-Z0-9_]+)\]\s*(.*)$/);
        const code = err?.code || (match ? match[1] : fallbackCode);
        const msg = match ? (match[2] || raw) : raw;
        const out = new Error(msg || t('tts.error.androidStartFailed'));
        out.code = code;
        out.cause = err;
        return out;
    }

    _normalizeTtsStartResponse(res) {
        if (res === true) return { started: true, value: true, errorCode: '', error: '' };
        if (res && typeof res === 'object') {
            const ok = res.started === true || (res.started == null && res.value === true);
            if (ok) return { ...res, started: true, value: true };
            const err = new Error(res.error || t('tts.error.androidStartFailed'));
            err.code = res.errorCode || 'TTS_INIT_FAILED';
            err.result = res;
            throw err;
        }
        const err = new Error(t('tts.error.androidStartFailed'));
        err.code = 'TTS_INIT_FAILED';
        throw err;
    }

    async captureAndroidReaderPage(bounds) {
        if (!this.isAndroid || !this.isTauri) return null;
        if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
        const dpr = window.devicePixelRatio || 1;
        const x = Math.max(0, Math.round(bounds.left * dpr));
        const y = Math.max(0, Math.round(bounds.top * dpr));
        const width = Math.max(1, Math.round(bounds.width * dpr));
        const height = Math.max(1, Math.round(bounds.height * dpr));
        const { data, mime } = await this._invokeTauri('android_capture_reader_page', { x, y, width, height });
        let bytes;
        if (typeof Uint8Array.fromBase64 === 'function') {
            bytes = Uint8Array.fromBase64(data);
        } else {
            const decoded = atob(data);
            bytes = new Uint8Array(decoded.length);
            for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        }
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        return { bitmap, width: bounds.width, height: bounds.height, textureDpr: bitmap.width / bounds.width };
    }

    async _invokeAndroidTtsControl(command, args) {
        if (!this.isTauri) return false;
        try {
            return await this._invokeTauri(command, args);
        } catch (e) {
            const wrapped = this._buildTtsBridgeError(e);
            console.warn(`[PlatformBridge] ${command} failed:`, wrapped);
            throw wrapped;
        }
    }

    async startBackgroundTts(bookTitle, text, rate = 1.0, options = {}) {
        if (!this.isTauri) {
            const err = new Error(t('tts.error.androidStartFailed'));
            err.code = 'UNSUPPORTED_PLATFORM';
            throw err;
        }
        try {
            const res = await this._invokeTauri('android_start_background_tts', {
                bookTitle,
                text,
                rate: Number(rate) || 1.0,
                bookId: options.bookId || null,
                bookAuthor: options.bookAuthor || null,
                jobId: options.jobId || null,
                utteranceId: options.utteranceId || null,
                generation: options.generation != null ? Number(options.generation) : null,
                voiceId: options.voiceId || null,
                locale: options.locale || getLocale() || 'zh-CN'
            });
            return this._normalizeTtsStartResponse(res);
        } catch (e) {
            const wrapped = this._buildTtsBridgeError(e, e?.code || 'BRIDGE_CALL_FAILED');
            console.warn('[PlatformBridge] startBackgroundTts failed:', wrapped);
            throw wrapped;
        }
    }

    async startBackgroundTtsQueue(bookTitle, segments, startIndex = 0, rate = 1.0, options = {}) {
        if (!this.isTauri) {
            const err = new Error(t('tts.error.androidStartFailed'));
            err.code = 'UNSUPPORTED_PLATFORM';
            throw err;
        }
        try {
            const res = await this._invokeTauri('android_start_background_tts_queue', {
                bookTitle,
                segments: (segments || []).map((s, i) => ({
                    utteranceId: `${options.jobId || 'job'}:${i}`,
                    text: s?.text != null ? String(s.text) : String(s ?? '')
                })),
                startIndex: Number(startIndex) || 0,
                rate: Number(rate) || 1.0,
                bookId: options.bookId || null,
                bookAuthor: options.bookAuthor || null,
                jobId: options.jobId || null,
                generation: options.generation != null ? Number(options.generation) : null,
                voiceId: options.voiceId || null,
                locale: options.locale || getLocale() || 'zh-CN'
            });
            return this._normalizeTtsStartResponse(res);
        } catch (e) {
            const wrapped = this._buildTtsBridgeError(e, e?.code || 'BRIDGE_CALL_FAILED');
            console.warn('[PlatformBridge] startBackgroundTtsQueue failed:', wrapped);
            throw wrapped;
        }
    }

    async pauseBackgroundTts(options = {}) {
        return this._invokeAndroidTtsControl('android_pause_background_tts', { jobId: options.jobId || null });
    }

    async resumeBackgroundTts(options = {}) {
        return this._invokeAndroidTtsControl('android_resume_background_tts', { jobId: options.jobId || null });
    }

    async stopBackgroundTts(options = {}) {
        return this._invokeAndroidTtsControl('android_stop_background_tts', { jobId: options.jobId || null });
    }

    async nextBackgroundTts() {
        return this._invokeAndroidTtsControl('android_next_background_tts');
    }

    async prevBackgroundTts() {
        return this._invokeAndroidTtsControl('android_prev_background_tts');
    }

    async getBackgroundPlaybackState() {
        if (!this.isTauri) {
            return { isPlaying: false, state: 'idle', bookTitle: '', text: '' };
        }
        return this._invokeAndroidTtsControl('android_get_playback_state');
    }

    async setTtsSleepTimer(minutes) {
        return this._invokeAndroidTtsControl('android_set_tts_sleep_timer', { minutes: Number(minutes) || 0 });
    }

    async setTtsRate(rate) {
        return this._invokeAndroidTtsControl('android_set_tts_rate', { rate: Number(rate) || 1.0 });
    }

    async getAndroidTtsDiagnostics() {
        if (!this.isAndroid || !this.isTauri) {
            return { status: 'unsupported', ready: false, engineCount: 0, engines: [] };
        }
        try {
            return await this._invokeTauri('android_get_tts_diagnostics');
        } catch (e) {
            const msg = String(e?.message || e || '');
            if (/not found/i.test(msg)) {
                const state = await this.getBackgroundPlaybackState();
                return {
                    status: state?.ttsStatus || 'uninitialized',
                    ready: Boolean(state?.ttsReady),
                    engineCount: Number(state?.engineCount) || 0,
                    defaultEngine: state?.defaultEngine || '',
                    activeEngine: state?.activeEngine || '',
                    engines: [],
                    lastErrorCode: state?.errorCode || '',
                    lastError: state?.error || '',
                    canOpenTtsSettings: state?.canOpenTtsSettings !== false,
                    canInstallTtsData: Boolean(state?.canInstallTtsData)
                };
            }
            throw this._buildTtsBridgeError(e);
        }
    }

    async openAndroidTtsSettings() {
        if (!this.isAndroid || !this.isTauri) {
            return { opened: false, action: '', error: 'UNSUPPORTED_PLATFORM' };
        }
        return this._invokeAndroidTtsControl('android_open_tts_settings');
    }

    async installAndroidTtsVoiceData() {
        if (!this.isAndroid || !this.isTauri) {
            return { opened: false, action: '', error: 'UNSUPPORTED_PLATFORM' };
        }
        return this._invokeAndroidTtsControl('android_install_tts_voice_data');
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
                    filename: filename || `linden_${Date.now()}.png`,
                    locale: getLocale()
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

    async shareImage(base64Data, filename, title) {
        const shareTitle = title || t('bridge.share.title');
        if (this.isTauri) {
            try {
                return await this._invokeTauri('android_share_image', {
                    base64: base64Data,
                    filename: filename || `linden_share_${Date.now()}.png`,
                    title: shareTitle,
                    locale: getLocale()
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
                    title: shareTitle,
                    files: [file]
                });
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        }
        return { success: false, error: t('bridge.error.shareUnsupported') };
    }

    /**
     * Unified text file export supporting native desktop "Save As" file dialog (Tauri),
     * Web File System Access API (showSaveFilePicker), and fallback DOM Blob download.
     * @param {string} filename
     * @param {string} content
     * @param {string} [mimeType='text/markdown;charset=utf-8']
     * @returns {Promise<{ success: boolean, cancelled?: boolean, filePath?: string|null, filename: string, directoryHint?: string, error?: string }>}
     */
    async exportTextFile(filename, content, mimeType = 'text/markdown;charset=utf-8') {
        const cleanFilename = String(filename || 'export.md').replace(/[\\/:*?"<>|]/g, '_').trim();
        const textContent = String(content ?? '');

        // Branch 1A: Android Tauri SAF Create-Document export
        if (this.isTauri && this.isAndroid) {
            try {
                const res = await this._invokeTauri('android_export_text_file', {
                    filename: cleanFilename,
                    content: textContent,
                    mimeType,
                    locale: getLocale()
                });
                if (res?.saved) {
                    const savedUri = res.uri || cleanFilename;
                    return {
                        success: true,
                        cancelled: false,
                        filePath: savedUri,
                        filename: cleanFilename,
                        directoryHint: res.uri || t('bridge.dialog.chosenLocation')
                    };
                }
                if (res?.cancelled) {
                    return {
                        success: false,
                        cancelled: true,
                        filePath: null,
                        filename: cleanFilename
                    };
                }
                return {
                    success: false,
                    cancelled: false,
                    filePath: null,
                    filename: cleanFilename,
                    error: t('bridge.dialog.saveFile')
                };
            } catch (androidErr) {
                console.warn('[PlatformBridge] Android android_export_text_file failed:', androidErr);
                return {
                    success: false,
                    cancelled: false,
                    filePath: null,
                    filename: cleanFilename,
                    error: androidErr?.message || String(androidErr)
                };
            }
        }

        // Branch 1B: Tauri Native Desktop Save Dialog (Save As)
        if (this.isTauri) {
            try {
                const savedPath = await this._invokeTauri('dialog_save_text_file', {
                    defaultName: cleanFilename,
                    default_name: cleanFilename,
                    content: textContent,
                    title: t('bridge.dialog.saveFile'),
                    locale: getLocale(),
                    mimeType
                });
                if (savedPath) {
                    return {
                        success: true,
                        cancelled: false,
                        filePath: savedPath,
                        filename: cleanFilename,
                        directoryHint: savedPath
                    };
                }
                // User explicitly clicked "Cancel" on native file dialog
                return {
                    success: false,
                    cancelled: true,
                    filePath: null,
                    filename: cleanFilename
                };
            } catch (tauriErr) {
                console.warn('[PlatformBridge] Tauri dialog_save_text_file failed, trying fallback:', tauriErr);
            }
        }

        // Branch 2: Web File System Access API (e.g. Modern Chromium / Electron showSaveFilePicker)
        if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
            try {
                const ext = cleanFilename.split('.').pop() || 'txt';
                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: cleanFilename,
                    types: [{
                        description: t('bridge.dialog.extDoc', { ext: ext.toUpperCase() }),
                        accept: { [mimeType.split(';')[0]]: ['.' + ext] }
                    }]
                });
                const writable = await fileHandle.createWritable();
                await writable.write(textContent);
                await writable.close();
                return {
                    success: true,
                    cancelled: false,
                    filePath: fileHandle.name || cleanFilename,
                    filename: fileHandle.name || cleanFilename,
                    directoryHint: t('bridge.dialog.chosenLocation')
                };
            } catch (pickerErr) {
                if (pickerErr?.name === 'AbortError') {
                    return {
                        success: false,
                        cancelled: true,
                        filePath: null,
                        filename: cleanFilename
                    };
                }
                console.warn('[PlatformBridge] showSaveFilePicker failed, trying blob download:', pickerErr);
            }
        }

        // Branch 3: Fallback DOM Blob download (Browser / Headless CDP)
        try {
            const blob = new Blob([textContent], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = cleanFilename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                try {
                    if (a.parentNode) a.parentNode.removeChild(a);
                    URL.revokeObjectURL(url);
                } catch (_) {}
            }, 1000);

            const directoryHint = this.isAndroid ? t('bridge.dialog.androidDownloads') : t('bridge.dialog.desktopDownloads');
            return {
                success: true,
                cancelled: false,
                filePath: null,
                filename: cleanFilename,
                directoryHint
            };
        } catch (err) {
            console.error('[PlatformBridge] exportTextFile error:', err);
            return {
                success: false,
                cancelled: false,
                filePath: null,
                filename: cleanFilename,
                error: err.message || String(err)
            };
        }
    }

    async waitOAuthCallback(port = 18520, timeoutSecs = 180, onReady = null, sessionId = '', signal = null) {
        if (!this.isTauri || !sessionId || !window.__TAURI__?.event?.listen) {
            return { success: false, error: t('bridge.error.oauthUnavailable') }
        }
        let unlisten = null
        let started = false
        let ready = false
        const cancel = () => { if (started && ready) this._invokeTauri('sync_oauth_loopback_cancel', { sessionId }).catch(() => {}) }
        try {
            unlisten = await window.__TAURI__.event.listen('oauth:listener-ready', event => {
                if (event.payload?.sessionId !== sessionId || event.payload?.port !== port) return
                ready = true
                if (signal?.aborted) { cancel(); return }
                if (typeof onReady === 'function') onReady(event.payload)
            })
            if (signal?.aborted) return { success:false, cancelled:true }
            signal?.addEventListener('abort', cancel, { once:true })
            started = true
            return await this._invokeTauri('sync_oauth_loopback_listen', { port, timeoutSecs, sessionId, locale: getLocale() })
        } catch (err) {
            return { success: false, error: err?.message || String(err) }
        } finally {
            signal?.removeEventListener('abort', cancel)
            if (unlisten) { try { unlisten() } catch (_) {} }
        }
    }

    async cancelOAuthCallback(sessionId = '') {
        if (!this.isTauri || !sessionId) return false;
        try {
            return await this._invokeTauri('sync_oauth_loopback_cancel', { sessionId });
        } catch (_) {
            return false;
        }
    }

    async getBootContext() {
        if (this.isTauri) {
            try {
                const ctx = await this._invokeTauri('app_get_boot_context', {});
                if (ctx && typeof ctx === 'object') return ctx;
            } catch (_) {}
        }
        const originMs = (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin))
            ? Math.round(performance.timeOrigin)
            : Date.now();
        return {
            bootId: `web_boot_${originMs}`,
            processStartEpochMs: originMs,
            launchMode: 'shelf',
            windowLabel: this.getCurrentWindowLabel(),
            pendingFiles: []
        };
    }

    async writeBootMetrics(metrics) {
        if (!this.isTauri || !metrics || typeof metrics !== 'object') return false;
        try {
            return await this._invokeTauri('app_write_boot_metrics', { payload: metrics });
        } catch (_) {
            return false;
        }
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
