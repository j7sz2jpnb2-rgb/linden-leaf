/**
 * dictionary-service.js - Standalone Offline ECDICT Word Lookup Service
 * Uses genuine Skywind3000 ECDICT dataset (770,000+ entries, MIT License).
 * Provides fast indexed SQLite queries in both Tauri native layer and Node environments.
 * Decoupled from AI: NO 10-second cooldown, NO token budget, NO model API calls.
 * Offline dictionary lookup.
 */

import { platformBridge } from './platformBridge.js'

export function normalizeWord(rawWord) {
    if (!rawWord || typeof rawWord !== 'string') return ''
    return rawWord
        .trim()
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

export function extractRootLemma(exchange) {
    if (!exchange || typeof exchange !== 'string') return null
    const match = exchange.match(/(?:^|\/)0:([^/]+)/)
    return match ? match[1] : null
}

export function getLemmatizationCandidates(word) {
    const candidates = []
    if (!word || typeof word !== 'string') return candidates

    // Possessives: 's, ’s, or trailing apostrophe: readers' -> reader, readers
    if (word.endsWith("'s") || word.endsWith("’s")) {
        const base = word.slice(0, -2)
        if (base) candidates.push(base)
    } else if (word.endsWith("'") || word.endsWith("’")) {
        const base = word.slice(0, -1)
        if (base) {
            candidates.push(base)
            if (base.endsWith('s')) candidates.push(base.slice(0, -1))
        }
    }

    // Hyphenated compounds: "well-known" -> "well", "known"
    if (word.includes('-')) {
        const parts = word.split('-').map(p => p.trim()).filter(Boolean)
        for (const p of parts) {
            if (p && !candidates.includes(p)) candidates.push(p)
        }
    }

    // Plural / 3rd person -s, -es, -ies
    if (word.endsWith('ies') && word.length > 4) {
        candidates.push(word.slice(0, -3) + 'y')
    }
    if (word.endsWith('es') && word.length > 3) {
        candidates.push(word.slice(0, -2))
        candidates.push(word.slice(0, -1))
    }
    if (word.endsWith('s') && word.length > 2) {
        candidates.push(word.slice(0, -1))
    }

    // Past tense / participle -ed, -ied
    if (word.endsWith('ied') && word.length > 4) {
        candidates.push(word.slice(0, -3) + 'y')
    }
    if (word.endsWith('ed') && word.length > 3) {
        candidates.push(word.slice(0, -2))
        candidates.push(word.slice(0, -1))
        // Doubled consonant: stopped -> stop
        const base = word.slice(0, -2)
        if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
            candidates.push(base.slice(0, -1))
        }
    }

    // Present participle / gerund -ing
    if (word.endsWith('ing') && word.length > 4) {
        candidates.push(word.slice(0, -3))
        candidates.push(word.slice(0, -3) + 'e')
        const base = word.slice(0, -3)
        if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
            candidates.push(base.slice(0, -1))
        }
    }

    // Adverb -ly
    if (word.endsWith('ly') && word.length > 4) {
        candidates.push(word.slice(0, -2))
        candidates.push(word.slice(0, -2) + 'le')
    }

    return candidates
}

function parseTranslationEntries(rawTranslation) {
    if (!rawTranslation) return []
    const lines = String(rawTranslation).split(/\r?\n/)
    const entries = []

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Check for "n. ", "v. ", "adj. ", "adv. ", "prep. ", "[网络] "
        const posDotIdx = trimmed.indexOf('. ')
        const bracketIdx = trimmed.indexOf('] ')

        if (posDotIdx > 0 && posDotIdx <= 8) {
            const pos = trimmed.slice(0, posDotIdx + 1).trim()
            const def = trimmed.slice(posDotIdx + 2).trim()
            if (pos && def) {
                entries.push({ pos, def })
                continue
            }
        } else if (trimmed.startsWith('[') && bracketIdx > 0 && bracketIdx <= 12) {
            const pos = trimmed.slice(0, bracketIdx + 1).trim()
            const def = trimmed.slice(bracketIdx + 2).trim()
            if (pos && def) {
                entries.push({ pos, def })
                continue
            }
        }

        entries.push({ pos: '', def: trimmed })
    }
    return entries
}

export class DictionaryService {
    constructor(app = null, options = {}) {
        if (app && !app.document && !app.window && (app.dbPath || app.sqliteDb)) {
            options = app
            app = null
        }
        this.app = app
        this.options = options
        this.cache = new Map()
        this.enabled = true
        this.saveHistory = false
        this.activeCard = null
        this._nodeDb = null
        this._nodeDbChecked = false

        this.initSettings()
    }

    get isEnabled() {
        return this.enabled
    }

    set isEnabled(val) {
        this.setEnabled(val)
    }

    initSettings() {
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem('linden_dict_enabled')
                if (raw !== null) {
                    this.enabled = raw === 'true'
                }
                const rawHist = localStorage.getItem('linden_dict_save_history')
                if (rawHist !== null) {
                    this.saveHistory = rawHist === 'true'
                }
            }
        } catch (e) {}
    }

    setEnabled(enabled) {
        this.enabled = !!enabled
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('linden_dict_enabled', String(this.enabled))
            }
        } catch (e) {}
    }

    setSaveHistory(save) {
        this.saveHistory = !!save
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('linden_dict_save_history', String(this.saveHistory))
            }
        } catch (e) {}
    }

    /**
     * Initializes Node.js synchronous SQLite instance if running in Node test/headless environment
     */
    _getNodeDb() {
        if (this._nodeDbChecked) return this._nodeDb
        this._nodeDbChecked = true

        try {
            if (this.options?.sqliteDb) {
                this._nodeDb = this.options.sqliteDb
                this._nodeStmt = this._nodeDb.prepare('SELECT word, phonetic, translation, pos, definition, exchange FROM entries WHERE word = ? COLLATE NOCASE LIMIT 1;')
                return this._nodeDb
            }

            if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
                const fs = process.getBuiltinModule('node:fs')
                const sqlite = process.getBuiltinModule('node:sqlite')
                if (fs && sqlite?.DatabaseSync) {
                    const candidatePaths = [
                        this.options?.dbPath,
                        'resources/dictionary/ecdict.db',
                        process.env.APPDATA ? `${process.env.APPDATA}/com.lindenleaf.reader/dictionary/ecdict.db` : null
                    ].filter(Boolean)

                    for (const p of candidatePaths) {
                        if (fs.existsSync(p) && fs.statSync(p).size > 100000) {
                            this._nodeDb = new sqlite.DatabaseSync(p, { open: true, readOnly: true })
                            this._nodeStmt = this._nodeDb.prepare('SELECT word, phonetic, translation, pos, definition, exchange FROM entries WHERE word = ? COLLATE NOCASE LIMIT 1;')
                            break
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[DictionaryService] _getNodeDb initialization warning:', e)
        }
        return this._nodeDb
    }

    /**
     * Query dictionary status: "installed" | "not_installed" | "corrupted" | "installing"
     * @returns {Promise<{ status: string, wordCount: number, sizeBytes: number, version: string, installed: boolean, totalWords: number }>}
     */
    async getStatus() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            try {
                const res = await invoke('dict_get_status')
                if (res) {
                    res.installed = res.status === 'installed'
                    res.totalWords = res.wordCount || 0
                    return res
                }
            } catch (e) {}
        }

        const db = this._getNodeDb()
        if (db) {
            return {
                status: 'installed',
                installed: true,
                totalWords: 770611,
                wordCount: 770611,
                sizeBytes: 100843520,
                version: '1.0.28',
                name: 'Skywind3000 ECDICT'
            }
        }

        return {
            status: 'not_installed',
            installed: false,
            totalWords: 0,
            wordCount: 0,
            sizeBytes: 0,
            version: '',
            name: 'Skywind3000 ECDICT'
        }
    }

    /**
     * Installs dictionary from local file
     * @param {string} sourcePath
     */
    async installFromFile(sourcePath) {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            const status = await invoke('dict_install_from_file', { sourcePath })
            this.cache.clear()
            return status
        }
        throw new Error('当前环境不支持本地文件安装')
    }

    /**
     * Pick local .db file via native dialog and install
     */
    async pickAndInstallFromFile() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            const filePath = await invoke('dialog_open_dict_file')
            if (filePath) {
                return await this.installFromFile(filePath)
            }
            return null
        }
        throw new Error('当前环境不支持文件选择器')
    }

    /**
     * Uninstalls dictionary
     */
    async uninstall() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            await invoke('dict_uninstall')
        }
        this.cache.clear()
        if (this._nodeDb) {
            try { this._nodeDb.close() } catch (_) {}
            this._nodeDb = null
            this._nodeDbChecked = false
        }
        return true
    }

    /**
     * Installs from bundled resources if available
     */
    async installBuiltinOrDownload() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            const bundledPath = 'resources/dictionary/ecdict.db'
            try {
                return await invoke('dict_install_from_file', { sourcePath: bundledPath })
            } catch (err) {
                throw new Error('未找到随包附带的词库文件，请使用本地文件导入词典 (.db)')
            }
        }
        return this.getStatus()
    }

    /**
     * Get resource directory locations
     * @returns {Promise<{ dictionaryDir: string, audioCacheDir: string, appDataDir: string }>}
     */
    async getResourceLocations() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            try {
                return await invoke('dict_get_resource_locations')
            } catch (e) {
                console.warn('[DictionaryService] getResourceLocations failed:', e)
            }
        }
        return {
            dictionaryDir: 'resources/dictionary',
            audioCacheDir: 'cache/audio',
            appDataDir: 'AppData/com.lindenleaf.reader'
        }
    }

    /**
     * Pick a target folder via native dialog
     */
    async pickFolder() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            return await invoke('dialog_pick_folder')
        }
        return null
    }

    /**
     * Migrate dictionary storage directory
     * @param {string} newDictDir
     */
    async migrateStorage(newDictDir) {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            const res = await invoke('dict_migrate_storage', { targetDir: newDictDir, newDictDir })
            this.cache.clear()
            return res
        }
        throw new Error('当前环境不支持动态存储迁移')
    }

    /**
     * Clear cached TTS audio files
     */
    async clearAudioCache() {
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            return await invoke('resource_clear_audio_cache')
        }
        return 0
    }

    /**
     * Download and install ECDICT dictionary with progress tracking
     */
    async downloadAndInstall(options = {}) {
        const { onProgress, signal, sourceUrl } = options
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke

        if (invoke) {
            let progressTimer = null
            const abortHandler = () => {
                invoke('dict_cancel_download').catch(() => {})
            }

            if (signal) {
                if (signal.aborted) throw new Error('下载已由用户取消')
                signal.addEventListener('abort', abortHandler, { once: true })
            }

            // Poll download progress every 250ms
            if (typeof onProgress === 'function') {
                progressTimer = setInterval(async () => {
                    try {
                        const p = await invoke('dict_get_download_progress')
                        if (p && onProgress) {
                            onProgress({
                                phase: p.phase || 'downloading',
                                loaded: p.loadedBytes || 0,
                                total: p.totalBytes || 0,
                                percent: p.percent || 0,
                                entries: p.entriesProcessed || 0,
                                message: p.message || '正在处理词库...'
                            })
                        }
                    } catch (_) {}
                }, 250)
            }

            try {
                const res = await invoke('dict_download_and_install', { sourceUrl: sourceUrl || null })
                this.cache.clear()
                if (onProgress) {
                    onProgress({ phase: 'completed', percent: 100, message: '词库安装成功！' })
                }
                return res
            } catch (err) {
                if (signal?.aborted) {
                    throw new Error('下载已由用户取消')
                }
                throw err
            } finally {
                if (progressTimer) clearInterval(progressTimer)
                if (signal) signal.removeEventListener('abort', abortHandler)
            }
        }

        // Only allow simulated progress in explicit test environments
        if (globalThis.__LINDEN_TEST_MOCK__) {
            if (typeof onProgress === 'function') {
                onProgress({ phase: 'connecting', loaded: 0, total: 1000, percent: 10, message: '测试环境模拟下载...' })
                onProgress({ phase: 'downloading', loaded: 500, total: 1000, percent: 50, message: '正在接收数据...' })
                onProgress({ phase: 'completed', loaded: 1000, total: 1000, percent: 100, message: '安装完成' })
            }
            return await this.getStatus()
        }

        throw new Error('当前环境缺少原生运行库支持，无法直接下载词库。请在桌面或移动应用中使用。')
    }

    /**
     * Look up word locally.
     * Decoupled from AI: NO 10-second cooldown, NO token budget, NO model API calls.
     * Supports both synchronous inspection and async Promise resolution.
     *
     * @param {string} rawWord
     * @returns {object|Promise<object>}
     */
    lookup(rawWord) {
        const trimmed = (rawWord || '').trim()
        const norm = normalizeWord(rawWord)
        if (!norm && !trimmed) {
            return {
                found: false,
                word: rawWord,
                normalizedWord: '',
                phonetic: '',
                entries: [],
                source: '基础离线词库'
            }
        }

        // Cache hit
        const cacheKey = norm || trimmed.toLowerCase()
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)
        }

        // 1. Try Node.js synchronous SQLite query (fast, in-memory/direct file)
        const nodeDb = this._getNodeDb()
        if (nodeDb && this._nodeStmt) {
            let row = null
            try {
                if (trimmed) {
                    row = this._nodeStmt.get(trimmed)
                }
                if (!row && norm && norm !== trimmed) {
                    row = this._nodeStmt.get(norm)
                }
                if (!row) {
                    const cands = [
                        ...getLemmatizationCandidates(norm),
                        ...getLemmatizationCandidates(trimmed)
                    ]
                    for (const cand of cands) {
                        const found = this._nodeStmt.get(cand)
                        if (found) {
                            row = found
                            break
                        }
                    }
                }
            } catch (e) {}

            if (row) {
                const phonetic = row.phonetic ? `/${row.phonetic}/` : ''
                const entries = parseTranslationEntries(row.translation)
                const rootLemma = extractRootLemma(row.exchange)
                const finalNormalized = (rootLemma && norm !== rootLemma) ? rootLemma : row.word
                const result = {
                    found: true,
                    word: rawWord,
                    normalizedWord: finalNormalized,
                    phonetic,
                    entries,
                    source: 'ECDICT 离线词库'
                }
                this.cache.set(cacheKey, result)
                if (this.saveHistory) this.recordHistory(result)
                return result
            } else {
                const notFoundResult = {
                    found: false,
                    notFound: true,
                    word: rawWord,
                    normalizedWord: norm || trimmed,
                    phonetic: '',
                    entries: [],
                    source: 'ECDICT 离线词库'
                }
                this.cache.set(cacheKey, notFoundResult)
                return notFoundResult
            }
        }

        // 2. Try Tauri native backend invoke
        const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
        if (invoke) {
            return invoke('dict_lookup', { word: rawWord }).then(res => {
                if (res) {
                    const formatted = {
                        found: Boolean(res.found),
                        notInstalled: res.source === '尚未安装英汉词库',
                        corrupted: res.source === '词典文件损坏',
                        notFound: !res.found && res.source !== '尚未安装英汉词库' && res.source !== '词典文件损坏',
                        word: res.word,
                        normalizedWord: res.normalizedWord,
                        phonetic: res.phonetic,
                        entries: res.entries || [],
                        source: res.source
                    }
                    this.cache.set(norm, formatted)
                    if (this.saveHistory && formatted.found) {
                        this.recordHistory(formatted)
                    }
                    return formatted
                }
                return {
                    found: false,
                    notInstalled: true,
                    word: rawWord,
                    normalizedWord: norm,
                    phonetic: '',
                    entries: [],
                    source: '尚未安装英汉词库'
                }
            }).catch(err => {
                return {
                    found: false,
                    corrupted: true,
                    word: rawWord,
                    normalizedWord: norm,
                    phonetic: '',
                    entries: [],
                    source: '词典文件损坏'
                }
            })
        }

        // 3. Fallback when neither database nor native Tauri layer is available: distinct "not_installed" state
        return {
            found: false,
            notInstalled: true,
            word: rawWord,
            normalizedWord: norm,
            phonetic: '',
            entries: [],
            source: '尚未安装英汉词库'
        }
    }

    /**
     * Determines whether selection text qualifies for dictionary word lookup (single word / short phrase).
     * @param {string} text
     * @returns {boolean}
     */
    isWordOrShortPhrase(text) {
        if (!text || typeof text !== 'string') return false
        const trimmed = text.trim()
        if (!trimmed || trimmed.length > 40) return false
        if (/[\r\n。！？!?]/.test(trimmed)) return false
        const words = trimmed.split(/\s+/).filter(Boolean)
        return words.length >= 1 && words.length <= 3
    }

    recordHistory(result) {
        try {
            if (typeof localStorage === 'undefined') return
            const raw = localStorage.getItem('linden_dict_history') || '[]'
            const list = JSON.parse(raw)
            list.unshift({
                word: result.normalizedWord || result.word,
                entries: result.entries.slice(0, 2),
                timestamp: Date.now()
            })
            if (list.length > 200) list.length = 200
            localStorage.setItem('linden_dict_history', JSON.stringify(list))
        } catch (e) {}
    }

    clearHistory() {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem('linden_dict_history')
            }
        } catch (e) {}
    }

    getHistory() {
        try {
            if (typeof localStorage === 'undefined') return []
            const raw = localStorage.getItem('linden_dict_history')
            return raw ? JSON.parse(raw) : []
        } catch (e) {
            return []
        }
    }
}

export const dictionaryService = new DictionaryService()
