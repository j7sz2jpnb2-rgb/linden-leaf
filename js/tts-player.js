/**
 * tts-player.js - Full-featured Text-To-Speech Audio Player for Linden Leaf
 * 
 * Features:
 * - Deterministic State Machine: idle, preparing, playing, paused, stopped
 * - Segment extraction for reflowable EPUB/TXT (DOM paragraphs) & PDF (text layer)
 * - 3 Pluggable Providers:
 *   1. SystemTtsProvider (Web Speech API / SAPI)
 *   2. OfflineTtsProvider (Kokoro-82M / sherpa-onnx local model dispatch)
 *   3. ApiTtsProvider (OpenAI / Qwen / CosyVoice audio speech with audio caching)
 * - Lookahead Pre-buffering (pre-fetches next 1-2 segments)
 * - Active text reading highlight and smooth auto-scroll sync
 * - Sleep Timer (15m, 30m, 45m, 60m, end-of-chapter)
 * - System MediaSession API integration (lockscreen & media buttons)
 */

import * as db from './db.js'
import { platformBridge } from './platformBridge.js'

async function requestSpeechAudio(endpoint, options) {
    if (!platformBridge.isAndroid || !platformBridge.isTauri) return fetch(endpoint, options)
    const data = await platformBridge.requestTtsAudio(endpoint, options.body, options.headers, options.signal)
    return new Response(data, { headers: { 'Content-Type': 'audio/mpeg' } })
}


export class SystemTtsProvider {
    constructor() {
        this.name = 'system'
        this.label = '系统原生语音 (Web Speech / Android TTS)'
        this.currentUtterance = null
        this._stopped = false
        this._paused = false
    }

    async getVoices() {
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            return [{
                id: 'android_default',
                name: 'Android 系统默认语音引擎 (TextToSpeech)',
                lang: 'zh-CN',
                isDefault: true
            }]
        }
        if (typeof window === 'undefined' || !window.speechSynthesis) return []
        let voices = window.speechSynthesis.getVoices()
        if (voices.length === 0) {
            voices = await new Promise(resolve => {
                let timer
                const finish = voices => {
                    clearTimeout(timer)
                    window.speechSynthesis.removeEventListener('voiceschanged', handler)
                    resolve(voices)
                }
                const handler = () => finish(window.speechSynthesis.getVoices())
                window.speechSynthesis.addEventListener('voiceschanged', handler)
                timer = setTimeout(() => finish(window.speechSynthesis.getVoices()), 500)
            })
        }
        return voices.map((v, i) => ({
            id: v.voiceURI || `voice_${i}`,
            name: `${v.name} (${v.lang})`,
            lang: v.lang,
            isDefault: v.default,
            rawVoice: v
        }))
    }

    async play(segment, options = {}) {
        this.stop()
        this._stopped = false
        this._paused = false

        if (platformBridge.isAndroid && platformBridge.isTauri) {
            const bookTitle = options.bookTitle || 'Linden Leaf'
            const text = segment?.text || ''
            const rate = options.rate || 1.0
            const jobId = options.jobId || `job_${Date.now()}`
            const utteranceId = options.utteranceId || `utt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            const generation = options.generation || 0

            this._nativeJobId = jobId
            const started = await platformBridge.startBackgroundTts(bookTitle, text, rate, {
                jobId,
                utteranceId,
                generation
            })
            if (!started) {
                throw new Error('启动 Android 系统朗读服务失败')
            }

            return new Promise((resolve, reject) => {
                let resolved = false
                let cleanup = () => {}

                const eventHandler = (e) => {
                    const d = e.detail || {}
                    if (d.jobId !== jobId || Number(d.generation) !== generation) return
                    if (d.type === 'playbacksegmentcompleted' && d.utteranceId === utteranceId) {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            resolve()
                        }
                    } else if (d.type === 'playbackcompleted') {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            resolve()
                        }
                    } else if (d.type === 'playbackstarted' && (!d.utteranceId || d.utteranceId === utteranceId)) {
                        options.onPlaybackStarted?.()
                    } else if (d.type === 'playbackerror') {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            reject(new Error(d.error || 'Android朗读出错'))
                        }
                    } else if (d.type === 'playbackstopped') {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            resolve()
                        }
                    }
                }

                window.addEventListener('androidttsevent', eventHandler)

                const pollTimer = setInterval(async () => {
                    if (resolved) return
                    if (typeof document !== 'undefined' && document.hidden) return
                    if (this._stopped) {
                        resolved = true
                        cleanup()
                        resolve()
                        return
                    }
                    try {
                        const state = await platformBridge.getBackgroundPlaybackState()
                        if (state.completedUtteranceId === utteranceId && state.state === 'completed') {
                            resolved = true
                            cleanup()
                            resolve()
                        } else if (state.state === 'error' && state.utteranceId === utteranceId) {
                            resolved = true
                            cleanup()
                            reject(new Error(state.error || 'Android朗读出错'))
                        }
                    } catch (_) {}
                }, 1000)

                cleanup = () => {
                    window.removeEventListener('androidttsevent', eventHandler)
                    clearInterval(pollTimer)
                }
            })
        }

        if (typeof window === 'undefined' || !window.speechSynthesis) {
            throw new Error('当前系统环境不支持 Web Speech API')
        }

        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(segment.text)
            utterance.rate = options.rate || 1.0
            utterance.pitch = options.pitch || 1.0

            if (options.voiceId) {
                const all = window.speechSynthesis.getVoices()
                const match = all.find(v => (v.voiceURI || v.name) === options.voiceId)
                if (match) utterance.voice = match
            }

            utterance.onstart = () => {
                options.onPlaybackStarted?.()
            }
            utterance.onend = () => {
                this.currentUtterance = null
                resolve()
            }
            utterance.onerror = (e) => {
                this.currentUtterance = null
                if (e.error === 'interrupted' || e.error === 'canceled') {
                    resolve()
                } else {
                    reject(new Error(`TTS播放错误: ${e.error}`))
                }
            }

            this.currentUtterance = utterance
            window.speechSynthesis.speak(utterance)
        })
    }

    pause() {
        this._paused = true
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            platformBridge.pauseBackgroundTts()
            return
        }
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.pause()
        }
    }

    resume() {
        this._paused = false
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            platformBridge.resumeBackgroundTts()
            return
        }
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.resume()
        }
    }

    stop() {
        this._stopped = true
        this._paused = false
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            const jobId = this._nativeJobId
            this._nativeJobId = null
            if (jobId) platformBridge.stopBackgroundTts({ jobId })
            return
        }
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel()
            this.currentUtterance = null
        }
    }

    async prefetch() {
        // System synthesis runs synchronously in system audio subsystem; no pre-buffering required
    }
}

export class ApiTtsProvider {
    constructor() {
        this.name = 'api'
        this.label = '云端 / 自定义语音接口'
        this.cache = new Map() // key -> { url, size, lastUsed }
        this.maxCacheBytes = 50 * 1024 * 1024 // 50MB bounded LRU cache
        this.currentCacheBytes = 0
        this.currentAudio = null
        this._inflight = new Map() // key -> Promise<string>
        this._prefetchErrors = new Map()
    }

    async getVoices(options = {}) {
        let official = false
        try { official = new URL(options.apiEndpoint || 'https://api.openai.com/v1/audio/speech').hostname === 'api.openai.com' } catch (_) {}
        if (!official) return [{ id: options.voiceId || '', name: options.voiceId || '使用服务默认音色' }]
        return [
            { id: 'alloy', name: 'Alloy (标准男声)' },
            { id: 'echo', name: 'Echo (沉稳男声)' },
            { id: 'fable', name: 'Fable (叙述英音)' },
            { id: 'onyx', name: 'Onyx (深沉低音)' },
            { id: 'nova', name: 'Nova (柔和女声)' },
            { id: 'shimmer', name: 'Shimmer (清澈女声)' }
        ]
    }

    getCacheKey(text, options) {
        const ep = options.apiEndpoint || 'default'
        const model = options.model || 'tts-1'
        const voice = options.voiceId || 'nova'
        const speed = options.rate || 1.0
        return `${ep}::${model}::${voice}::${speed}::${text.trim()}`
    }

    _addToCache(cacheKey, url, size) {
        while (this.currentCacheBytes + size > this.maxCacheBytes && this.cache.size > 0) {
            const oldestKey = this.cache.keys().next().value
            const item = this.cache.get(oldestKey)
            if (item) {
                try { URL.revokeObjectURL(item.url) } catch (_) {}
                this.currentCacheBytes -= (item.size || 0)
            }
            this.cache.delete(oldestKey)
        }
        this.cache.set(cacheKey, { url, size, lastUsed: Date.now() })
        this.currentCacheBytes += size
    }

    async fetchAudioBlob(text, options = {}) {
        const cacheKey = this.getCacheKey(text, options)
        if (this.cache.has(cacheKey)) {
            const item = this.cache.get(cacheKey)
            item.lastUsed = Date.now()
            return item.url
        }

        if (this._prefetchErrors.has(cacheKey)) {
            const err = this._prefetchErrors.get(cacheKey)
            this._prefetchErrors.delete(cacheKey)
            throw new Error(`预取音频失败: ${err.message || err}`)
        }

        if (this._inflight.has(cacheKey)) {
            return await this._inflight.get(cacheKey)
        }

        const fetchPromise = (async () => {
            const endpoint = options.apiEndpoint || 'https://api.openai.com/v1/audio/speech'
            let apiKey = options.allowUnauthenticated ? '' : options.apiKey || ''
            if (!apiKey && !options.allowUnauthenticated) {
                try {
                    const storedOrigin = await platformBridge.secureLoadCredential('tts_api_origin').catch(() => null)
                    let currentOrigin = ''
                    try { currentOrigin = new URL(endpoint).origin } catch (_) { currentOrigin = endpoint }
                    if (!storedOrigin || storedOrigin === currentOrigin) {
                        apiKey = await platformBridge.secureLoadCredential('tts_api_key') || ''
                    } else {
                        console.warn('[ApiTtsProvider] TTS API endpoint origin mismatch with stored credential origin; suppressing auto-send')
                    }
                } catch (_) {}
            }
            const model = options.model || 'tts-1'
            const voice = options.voiceId || 'nova'
            const speed = options.rate || 1.0

            if (!apiKey && !options.allowUnauthenticated) {
                throw new Error('未配置朗读接口密钥；免认证服务请在听书设置中启用免密模式')
            }

            const resp = await requestSpeechAudio(endpoint, {
                method: 'POST',
                headers: {
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model,
                    input: text,
                    voice,
                    speed
                }),
                signal: options.signal
            })

            if (!resp.ok) {
                const errBody = await resp.text().catch(() => '')
                throw new Error(`TTS API 请求失败 (${resp.status}): ${errBody}`)
            }

            const blob = await resp.blob()
            if (options.signal?.aborted) throw new DOMException('朗读已停止', 'AbortError')
            const url = URL.createObjectURL(blob)
            this._addToCache(cacheKey, url, blob.size || 64 * 1024)
            return url
        })()

        this._inflight.set(cacheKey, fetchPromise)
        try {
            const resultUrl = await fetchPromise
            return resultUrl
        } finally {
            if (this._inflight.get(cacheKey) === fetchPromise) this._inflight.delete(cacheKey)
        }
    }

    async prefetch(segment, options = {}) {
        if (!segment?.text) return
        const cacheKey = this.getCacheKey(segment.text, options)
        if (this.cache.has(cacheKey) || this._inflight.has(cacheKey)) return
        try {
            await this.fetchAudioBlob(segment.text, options)
        } catch (e) {
            if (options.signal?.aborted || e.name === 'AbortError') return
            console.debug('[ApiTtsProvider] prefetch failed:', e)
            this._prefetchErrors.set(cacheKey, e)
        }
    }

    async play(segment, options = {}) {
        this.stop()
        const url = await this.fetchAudioBlob(segment.text, options)
        if (options.signal?.aborted || (options.isPaused && options.isPaused())) return

        return new Promise((resolve, reject) => {
            if (options.isPaused && options.isPaused()) {
                resolve()
                return
            }

            const audio = new Audio(url)
            audio.playbackRate = 1.0
            
            const cleanup = () => {
                this.currentAudio = null
                if (options.signal) {
                    options.signal.removeEventListener('abort', onAbort)
                }
            }
            const onAbort = () => {
                try { audio.pause() } catch (_) {}
                cleanup()
                resolve()
            }
            if (options.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true })
            }

            audio.onplay = () => {
                if (options.isPaused && options.isPaused()) {
                    try { audio.pause() } catch (_) {}
                    cleanup()
                    resolve()
                    return
                }
                options.onPlaybackStarted?.()
            }

            audio.onended = () => {
                cleanup()
                resolve()
            }
            audio.onerror = (e) => {
                cleanup()
                if (options.signal?.aborted) {
                    resolve()
                } else {
                    reject(new Error('音频解码播放失败'))
                }
            }

            this.currentAudio = audio
            audio.play().catch(err => {
                cleanup()
                if (options.signal?.aborted || (options.isPaused && options.isPaused())) resolve()
                else reject(err)
            })
        })
    }

    pause() {
        if (this.currentAudio) {
            this.currentAudio.pause()
        }
    }

    resume() {
        if (this.currentAudio) {
            this.currentAudio.play()
        }
    }

    stop() {
        if (this.currentAudio) {
            this.currentAudio.pause()
            this.currentAudio.currentTime = 0
            this.currentAudio = null
        }
    }

    clearCache() {
        const cleared = { count: this.cache.size, bytes: this.currentCacheBytes }
        for (const [_, item] of this.cache.entries()) {
            try { URL.revokeObjectURL(item.url) } catch (_) {}
        }
        this.cache.clear()
        this.currentCacheBytes = 0
        this._inflight.clear()
        this._prefetchErrors.clear()
        return cleared
    }
}

export class OfflineTtsProvider {
    constructor() {
        this.name = 'offline'
        this.label = '自建离线语音服务 (兼容 OpenAI / Kokoro / sherpa-onnx 接口)'
        this.currentAudio = null
        this.localEndpoint = 'http://127.0.0.1:8880/v1/audio/speech'
    }

    async getVoices() {
        return [
            { id: 'zf_xiaobei', name: '小贝 (普通话女声 · Kokoro-82M)' },
            { id: 'zf_xiaoni', name: '小妮 (普通话女声 · Kokoro-82M)' },
            { id: 'zf_xiaoxiao', name: '潇潇 (普通话女声 · Kokoro-82M)' },
            { id: 'zf_xiaoyi', name: '小怡 (普通话女声 · Kokoro-82M)' },
            { id: 'zm_yunjian', name: '云健 (普通话男声 · Kokoro-82M)' },
            { id: 'zm_yunxi', name: '云希 (普通话男声 · Kokoro-82M)' },
            { id: 'af_bella', name: 'Bella (美音女声 · Kokoro-82M)' },
            { id: 'af_sarah', name: 'Sarah (美音女声 · Kokoro-82M)' },
            { id: 'am_adam', name: 'Adam (美音男声 · Kokoro-82M)' }
        ]
    }

    async prefetch(segment, options = {}) {
        // Pre-render local ONNX acoustic features if local service endpoint is reachable
    }

    async play(segment, options = {}) {
        this.stop()
        const text = segment?.text?.trim()
        if (!text || options.signal?.aborted) return
        const endpoint = options.localEndpoint || this.localEndpoint
        const controller = new AbortController()
        this.abortController = controller
        const onAbort = () => controller.abort()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
        try {
            const resp = await requestSpeechAudio(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: options.model || 'kokoro-82m-zh', input: text, voice: options.voiceId || 'zf_xiaobei', speed: options.rate || 1 }), signal: controller.signal })
            if (!resp.ok) throw new Error(`语音服务返回 ${resp.status}：${(await resp.text()).slice(0, 200)}`)
            const blob = await resp.blob()
            clearTimeout(timer)
            if (timedOut) throw new Error('连接自建语音服务超时')
            if (controller.signal.aborted || options.signal?.aborted) return
            const url = URL.createObjectURL(blob)
            this.currentUrl = url
            await new Promise((resolve, reject) => {
                const audio = new Audio(url)
                this.currentAudio = audio
                const finish = error => {
                    controller.signal.removeEventListener('abort', cancelled)
                    audio.onended = null; audio.onerror = null
                    if (this.currentAudio === audio) this.currentAudio = null
                    if (this.currentUrl === url) this.currentUrl = null
                    URL.revokeObjectURL(url)
                    error ? reject(error) : resolve()
                }
                const cancelled = () => { audio.pause(); finish() }
                controller.signal.addEventListener('abort', cancelled, { once: true })
                audio.onplay = () => options.onPlaybackStarted?.()
                audio.onended = () => finish()
                audio.onerror = () => finish(new Error('自建语音音频解码失败'))
                audio.play().catch(error => finish(error))
            })
        } catch (error) {
            if (!timedOut && (controller.signal.aborted || options.signal?.aborted)) return
            throw new Error('无法播放自建语音：' + error.message + '。请检查服务地址、模型与音色 ID。')
        } finally {
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            if (this.abortController === controller) this.abortController = null
        }
    }

    pause() {
        if (this.currentAudio) this.currentAudio.pause()
    }

    resume() {
        if (this.currentAudio) this.currentAudio.play()
    }

    stop() {
        if (this.abortController) {
            try { this.abortController.abort() } catch (_) {}
            this.abortController = null
        }
        if (this.currentAudio) {
            this.currentAudio.pause()
            this.currentAudio.currentTime = 0
            this.currentAudio = null
        }
        if (this.currentUrl) {
            try { URL.revokeObjectURL(this.currentUrl) } catch (_) {}
            this.currentUrl = null
        }
    }
}

function splitTextIntoSentences(text, maxLen = 800) {
    if (!text || text.length <= maxLen) return [text]
    const parts = text.match(/[^。！？!?；;\n\r]+[。！？!?；;\n\r]*|.+/g) || [text]
    const chunks = []
    let current = ''
    for (const part of parts) {
        if (!part) continue
        if (current.length + part.length <= maxLen) {
            current += part
        } else {
            if (current.trim()) chunks.push(current.trim())
            if (part.length > maxLen) {
                let rem = part
                while (rem.length > maxLen) {
                    chunks.push(rem.slice(0, maxLen).trim())
                    rem = rem.slice(maxLen)
                }
                current = rem
            } else {
                current = part
            }
        }
    }
    if (current.trim()) chunks.push(current.trim())
    return chunks.length > 0 ? chunks : [text]
}

export class TtsPlayer {
    constructor() {
        this.state = 'idle' // 'idle' | 'preparing' | 'playing' | 'paused' | 'stopped'
        this.providers = {
            system: new SystemTtsProvider(),
            api: new ApiTtsProvider(),
            offline: new OfflineTtsProvider()
        }
        this.currentProviderName = 'system'
        this.rate = 1.0
        this.voiceId = null
        this.segments = []
        this.currentIndex = -1
        this.activeHighlightEl = null
        this.sleepTimerDurationMinutes = 0
        this.sleepTimerRemainingSeconds = 0
        this.sleepTimerInterval = null
        this.onStateChangeCallbacks = []
        this.readerApp = null
        this._stopRequested = false
        this.generation = 0
        this.abortController = null
        this.sessionBookOwner = null
        this.providerConfigs = {
            system: {},
            offline: {
                localEndpoint: 'http://127.0.0.1:8880/v1/audio/speech',
                model: 'kokoro-82m-zh',
                voiceId: 'zf_xiaobei'
            },
            api: {
                apiEndpoint: 'https://api.openai.com/v1/audio/speech',
                apiKey: '',
                model: 'tts-1',
                voiceId: 'nova',
                allowUnauthenticated: false
            }
        }

        this.activeListeningIntervals = []
        this._currentSegmentStartTime = null
        this.completedUtteranceIds = new Set()

        if (typeof window !== 'undefined') {
            window.addEventListener('androidmedianext', () => this.next())
            window.addEventListener('androidmediaprev', () => this.prev())
            window.addEventListener('androidttsevent', e => this.handleNativePlaybackEvent(e.detail || {}))
            document.addEventListener('visibilitychange', async () => {
                if (document.hidden || !platformBridge.isAndroid || !platformBridge.isTauri) return
                try {
                    const state = await this.syncNativeListening()
                    if (state) this.handleNativePlaybackEvent({ ...state, type: ({playing: 'playbackstarted', preparing: 'playbackpreparing', paused: 'playbackpaused', completed: 'playbackcompleted', stopped: 'playbackstopped', error: 'playbackerror'})[state.state] }, false)
                } catch (e) { console.debug('Playback restore deferred:', e) }
            })
        }

        this.initMediaSession()
    }

    get provider() {
        return this.providers[this.currentProviderName] || this.providers.system
    }

    setProvider(name, config = {}) {
        if (!this.providers[name]) throw new Error(`未知语音引擎: ${name}`)
        if (name !== this.currentProviderName) this.stop()
        this.currentProviderName = name
        this.providerConfigs[name] = { ...this.providerConfigs[name], ...config }
        this.voiceId = this.providerConfigs[name].voiceId || ''
        this.persistPreferences()
        this.notifyStateChange()
    }

    loadSettings(settings = {}) {
        this._loadingSettings = true
        try {
            const provider = this.providers[settings.ttsProvider] ? settings.ttsProvider : this.currentProviderName
            if (provider !== this.currentProviderName && ['playing', 'paused', 'preparing'].includes(this.state)) this.stop()
            this.currentProviderName = provider
            this.rate = Math.max(0.5, Math.min(3, Number(settings.ttsRate) || 1))
            const nextEndpoint = settings.ttsApiEndpoint || 'https://api.openai.com/v1/audio/speech'
            try {
                if (new URL(nextEndpoint).origin !== new URL(this.providerConfigs.api.apiEndpoint).origin) this.providerConfigs.api.apiKey = ''
            } catch (_) { this.providerConfigs.api.apiKey = '' }
            this.providerConfigs.api = { ...this.providerConfigs.api,
                apiEndpoint: settings.ttsApiEndpoint || 'https://api.openai.com/v1/audio/speech',
                model: settings.ttsApiModel || 'tts-1', voiceId: settings.ttsApiVoiceId ?? 'nova',
                allowUnauthenticated: settings.ttsApiNoAuth === true }
            this.providerConfigs.offline = { ...this.providerConfigs.offline,
                localEndpoint: settings.ttsOfflineEndpoint || 'http://127.0.0.1:8880/v1/audio/speech',
                model: settings.ttsOfflineModel || 'kokoro-82m-zh', voiceId: settings.ttsOfflineVoiceId ?? 'zf_xiaobei' }
            this.providerConfigs.system.voiceId = settings.ttsSystemVoiceId ?? (provider === 'system' ? settings.ttsVoiceId || '' : '')
            this.voiceId = this.providerConfigs[provider].voiceId || ''
        } finally { this._loadingSettings = false }
    }

    persistPreferences() {
        if (this._loadingSettings) return
        const manager = this.readerApp?.advancedSettings
        if (!manager?.config) return
        const { ttsApiKeyConfigured, ...preferences } = this.getSettings()
        Object.assign(manager.config, preferences)
        manager.save()
        manager.renderUIState()
    }

    getSettings() {
        return {
            ttsProvider: this.currentProviderName,
            ttsRate: this.rate,
            ttsVoiceId: this.voiceId || '',
            ttsSystemVoiceId: this.providerConfigs.system.voiceId || '',
            ttsApiVoiceId: this.providerConfigs.api.voiceId || '',
            ttsOfflineVoiceId: this.providerConfigs.offline.voiceId || '',
            ttsApiNoAuth: this.providerConfigs.api.allowUnauthenticated === true,
            ttsApiEndpoint: this.providerConfigs.api?.apiEndpoint || '',
            ttsApiKeyConfigured: Boolean(this.providerConfigs.api?.apiKey),
            ttsApiModel: this.providerConfigs.api?.model || 'tts-1',
            ttsOfflineEndpoint: this.providerConfigs.offline?.localEndpoint || 'http://127.0.0.1:8880/v1/audio/speech',
            ttsOfflineModel: this.providerConfigs.offline?.model || 'kokoro-82m-zh'
        }
    }

    updateProviderConfig(name, config = {}) {
        if (this.providerConfigs[name]) {
            this.providerConfigs[name] = { ...this.providerConfigs[name], ...config }
        }
    }

    getProviderOptions() {
        const base = this.providerConfigs[this.currentProviderName] || {}
        return {
            ...base,
            voiceId: this.voiceId || base.voiceId || '',
            rate: this.rate,
            signal: this.abortController?.signal
        }
    }

    setState(newState) {
        if (this.state === newState) return
        this.state = newState
        this.notifyStateChange()
    }

    onStateChange(cb) {
        if (typeof cb === 'function') this.onStateChangeCallbacks.push(cb)
    }

    notifyStateChange() {
        for (const cb of this.onStateChangeCallbacks) {
            try { cb(this.state, this) } catch (e) { console.error('TTS callback error:', e) }
        }
    }

    attachReaderApp(app) {
        this.readerApp = app
        this.syncNativeListening().catch(e => console.debug('Listening recovery deferred:', e))
    }

    /**
     * Extract speakable segments from the current reading view using proper Foliate source documents
     */
    extractSegments() {
        const segments = []
        if (!this.readerApp) return segments

        // 1. Reflowable EPUB / TXT document
        const foliateView = this.readerApp.foliateView
        if (foliateView) {
            const renderer = foliateView.renderer
            const contentItems = (typeof foliateView.getContents === 'function' ? foliateView.getContents() : null)
                || (typeof renderer?.getContents === 'function' ? renderer.getContents() : null)
                || []

            const docs = contentItems.map(item => item?.doc).filter(Boolean)
            if (docs.length === 0) {
                const fallbackDoc = renderer?.doc || renderer?.shadowRoot || foliateView.shadowRoot
                if (fallbackDoc) docs.push(fallbackDoc)
            }

            let idx = 0
            for (const doc of docs) {
                const candidates = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, li, div.paragraph')
                for (const el of candidates) {
                    if (el.closest('.bilingual-derived-view, .linden-inline-translation, [data-injected-translation], [data-reader-hidden], .linden-bilingual-target, .bilingual-translation-block')) {
                        continue
                    }
                    // Exclude container element if it contains other candidate elements to avoid reading twice!
                    if (el.querySelector('p, h1, h2, h3, h4, h5, h6, li, div.paragraph')) {
                        continue
                    }
                    if (el.offsetParent === null && !el.getClientRects().length) continue

                    // Clean out footnote tags and markers before reading
                    const clone = el.cloneNode(true)
                    clone.querySelectorAll('sup, a[role="doc-noteref"], .footnote-ref, .footnote').forEach(n => n.remove())
                    const raw = clone.innerText || clone.textContent || ''
                    const cleaned = raw.replace(/\s+/g, ' ').trim()
                    if (cleaned.length >= 2) {
                        const chunks = splitTextIntoSentences(cleaned, 800)
                        for (const chunk of chunks) {
                            if (chunk.length >= 2) {
                                segments.push({
                                    id: `seg_${idx++}`,
                                    index: segments.length,
                                    text: chunk,
                                    element: el,
                                    format: 'epub'
                                })
                            }
                        }
                    }
                }
            }
        }

        // 2. PDF Viewport
        const pdfViewport = this.readerApp.pdfViewport
        if (!foliateView && pdfViewport) {
            const curPage = pdfViewport.currentPage ?? 0
            let textLayer = pdfViewport.activeSlots?.get?.(curPage)?.querySelector?.('.pdf-text-layer')
            if (!textLayer) {
                textLayer = document.querySelector('.pdf-text-layer') || document.querySelector('#pdf-text-layer')
            }
            if (textLayer) {
                const spans = textLayer.querySelectorAll('span')
                const combined = Array.from(spans).map(s => s.textContent).join(' ').trim()
                if (combined) {
                    const chunks = splitTextIntoSentences(combined, 800)
                    let pdfIdx = 0
                    for (const chunk of chunks) {
                        if (chunk.length >= 2) {
                            segments.push({
                                id: `seg_pdf_${pdfIdx++}`,
                                index: segments.length,
                                text: chunk,
                                element: textLayer,
                                format: 'pdf'
                            })
                        }
                    }
                }
            }
        }

        this.segments = segments
        return segments
    }

    /**
     * Start playing from the given or first segment
     */
    async play(startIndex = null) {
        this.cancelPreview()
        if (this.state === 'paused' && (startIndex === null || startIndex === this.currentIndex)) {
            this.resume()
            return
        }

        this._stopRequested = false
        const myGen = ++this.generation
        if (this.abortController) {
            this.abortController.abort()
        }
        this.abortController = new AbortController()

        this.setState('preparing')

        if (this.segments.length === 0) {
            this.extractSegments()
        }

        if (this.segments.length === 0) {
            this.setState('stopped')
            throw new Error('未在当前视图中检测到可朗读的文字内容')
        }

        if (this.state === 'paused' || this._stopRequested || this.generation !== myGen) return

        const target = startIndex !== null ? startIndex : (this.currentIndex >= 0 ? this.currentIndex : 0)
        this.currentIndex = Math.max(0, Math.min(target, this.segments.length - 1))
        this._listenStartTime = null
        const now = Date.now()
        const app = this.readerApp || (typeof window !== 'undefined' ? window.app : null)
        this.sessionBookOwner = {
            bookId: app?.currentBookId || app?.currentBookData?.id || null,
            bookTitle: app?.currentBookData?.title || '未知书籍',
            bookAuthor: app?.currentBookData?.author || app?.currentBookMeta?.author || '',
            startTimestamp: now
        }
        this.setState('playing')

        this.updateMediaSessionMetadata()
        if (platformBridge.isAndroid && platformBridge.isTauri && this.provider.name === 'system') {
            await this.playAndroidNativeQueue(myGen)
            return
        }
        await this.playbackLoop(myGen)
    }

    /**
     * Android native queue driver mode:
     * Native service runs the playback queue as the single driver, JS acts as controller & observer.
     */
    async playAndroidNativeQueue(generation) {
        this._loopRunning = false
        const owner = this.sessionBookOwner
        const jobId = `job_${generation}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        this._nativeQueue = { jobId, generation }
        this._lastNativeEventSeq = 0
        this._currentSegmentStartTime = null
        this._listenStartTime = null
        this.setState('preparing')
        this.highlightSegment(this.segments[this.currentIndex])
        try {
            const started = await platformBridge.startBackgroundTtsQueue(owner?.bookTitle || 'Linden Leaf',
                this.segments, this.currentIndex, this.rate, { jobId, generation, bookId: owner?.bookId || '' })
            if (this.generation !== generation || this._nativeQueue?.jobId !== jobId) {
                await platformBridge.stopBackgroundTts({ jobId })
                return
            }
            if (!started) throw new Error('启动系统朗读失败')
        } catch (e) {
            if (this.generation === generation && this._nativeQueue?.jobId === jobId) {
                this.setState('paused')
                this.readerApp?.showToast?.(e.message || '启动朗读失败', 'warning')
            }
        }
    }

    /**
     * Core playback loop with lookahead pre-buffering and cancellation check
     */
    async playbackLoop(gen) {
        this._loopRunning = true
        const loopOwner = this.sessionBookOwner
        try {
            while (this.state === 'playing' && this.currentIndex < this.segments.length && !this._stopRequested && this.generation === gen) {
                const seg = this.segments[this.currentIndex]
                if (this.generation !== gen) break
                this.highlightSegment(seg)

                const next1 = this.segments[this.currentIndex + 1]
                const segUttId = `utt_${gen}_${this.currentIndex}_${Date.now()}`
                const opts = {
                    ...this.getProviderOptions(),
                    utteranceId: segUttId,
                    generation: gen,
                    queue: this.segments,
                    startIndex: this.currentIndex,
                    isPaused: () => this.state === 'paused' || this._stopRequested || this.generation !== gen,
                    onPlaybackStarted: () => {
                        if (this.generation === gen) {
                            const now = Date.now()
                            if (this._currentSegmentStartTime && now > this._currentSegmentStartTime) {
                                this.activeListeningIntervals.push([this._currentSegmentStartTime, now])
                            }
                            this._listenStartTime = now
                            this._currentSegmentStartTime = now
                        }
                    }
                }
                if (next1) this.provider.prefetch(next1, opts).catch(() => {})

                try {
                    await this.provider.play(seg, opts)
                    // Close segment interval cleanly upon actual completion
                    if (this._currentSegmentStartTime) {
                        const now = Date.now()
                        if (now > this._currentSegmentStartTime) {
                            this.activeListeningIntervals.push([this._currentSegmentStartTime, now])
                        }
                        this._currentSegmentStartTime = null
                    }
                } catch (err) {
                    if (this._stopRequested || this.generation !== gen || opts.signal?.aborted) {
                        break
                    }
                    console.error(`TTS segment ${this.currentIndex} error:`, err)
                    this.flushListeningSession(true, loopOwner)
                    this.setState('paused')
                    this.readerApp?.showToast?.(`TTS朗读暂停: ${err.message}`, 'warning')
                    break
                }

                if (this.state !== 'playing' || this._stopRequested || this.generation !== gen) break

                this.currentIndex++

                // Check sleep timer end-of-chapter condition
                if (this.sleepTimerDurationMinutes === 'end_of_chapter' && this.currentIndex >= this.segments.length) {
                    this.clearHighlight()
                    this.flushListeningSession(false, loopOwner)
                    this.setSleepTimer(0)
                    this.setState('stopped')
                    this.readerApp?.showToast?.('章节朗读完成，定时器已自动停止', 'info')
                    return
                }
            }
        } finally {
            if (this.generation === gen) {
                this._loopRunning = false
                if (this.state !== 'paused') {
                    this.clearHighlight()
                }
                this.flushListeningSession(this.state === 'paused', loopOwner)
                if (this.currentIndex >= this.segments.length && !this._stopRequested) {
                    this.setState('stopped')
                    this.readerApp?.showToast?.('当前章节朗读完毕', 'info')
                }
            }
        }
    }

    highlightSegment(segment) {
        this.clearHighlight()
        if (!segment?.element) return

        try {
            segment.element.classList.add('tts-active-reading-segment')
            this.activeHighlightEl = segment.element
            segment.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } catch (_) {}
    }

    clearHighlight() {
        if (this.activeHighlightEl) {
            try {
                this.activeHighlightEl.classList.remove('tts-active-reading-segment')
            } catch (_) {}
            this.activeHighlightEl = null
        }
    }

    flushListeningSession(keepOwner = false, ownerOverride = null) {
        this._listenStartTime = null
        if (this._currentSegmentStartTime) {
            const now = Date.now()
            if (now > this._currentSegmentStartTime) {
                this.activeListeningIntervals.push([this._currentSegmentStartTime, now])
            }
            this._currentSegmentStartTime = null
        }

        const intervals = this.activeListeningIntervals.slice()
        this.activeListeningIntervals = []

        const owner = ownerOverride || this.sessionBookOwner
        if (!keepOwner && !ownerOverride) {
            this.sessionBookOwner = null
        }

        if (!this._pendingListeningBatches) {
            this._pendingListeningBatches = []
        }

        if (intervals.length > 0) {
            // Compute union of active intervals to strictly exclude pauses and prevent double-counting
            intervals.sort((a, b) => a[0] - b[0])
            const mergedIntervals = []
            let cur = null
            for (const [s, e] of intervals) {
                if (!cur) {
                    cur = [s, e]
                } else if (s <= cur[1]) {
                    cur[1] = Math.max(cur[1], e)
                } else {
                    mergedIntervals.push(cur)
                    cur = [s, e]
                }
            }
            if (cur) {
                mergedIntervals.push(cur)
            }

            const bookId = owner?.bookId
            if (bookId && mergedIntervals.length > 0) {
                const bookTitle = owner?.bookTitle || '未知书籍'
                const bookAuthor = owner?.bookAuthor || (window.app?.currentBookData?.id === bookId ? window.app?.currentBookData?.author : '') || window.app?.currentBookMeta?.author || ''
                const firstStart = mergedIntervals[0][0]
                const baseId = `tts_${firstStart}_${Math.random().toString(36).slice(2, 6)}`

                // Split each active interval by local calendar midnight (LL-30)
                const splitSlices = []
                for (const [intStart, intEnd] of mergedIntervals) {
                    let curStart = intStart
                    while (curStart < intEnd) {
                        const curDate = new Date(curStart)
                        const nextMidnight = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate() + 1, 0, 0, 0, 0)
                        const nextMidnightMs = nextMidnight.getTime()
                        const curEnd = Math.min(intEnd, nextMidnightMs)
                        const localDateKey = (typeof db.toLocalDateKey === 'function')
                            ? db.toLocalDateKey(new Date(curStart))
                            : new Date(curStart).toLocaleDateString('en-CA')
                        splitSlices.push({
                            startMs: curStart,
                            endMs: curEnd,
                            durationSeconds: (curEnd - curStart) / 1000,
                            date: localDateKey
                        })
                        curStart = curEnd
                    }
                }

                // Group slices by calendar date to create consolidated records per day
                const dayGroups = new Map()
                for (const sl of splitSlices) {
                    if (!dayGroups.has(sl.date)) {
                        dayGroups.set(sl.date, { date: sl.date, startMs: sl.startMs, endMs: sl.endMs, durationSeconds: 0, activeIntervals: [] })
                    }
                    const grp = dayGroups.get(sl.date)
                    grp.durationSeconds += sl.durationSeconds
                    grp.activeIntervals.push([sl.startMs, sl.endMs])
                    grp.startMs = Math.min(grp.startMs, sl.startMs)
                    grp.endMs = Math.max(grp.endMs, sl.endMs)
                }

                const records = []
                let sliceIdx = 0
                for (const grp of dayGroups.values()) {
                    const dur = Math.round(grp.durationSeconds)
                    if (dur > 0) {
                        records.push({
                            id: sliceIdx === 0 ? baseId : `${baseId}_slice_${sliceIdx}`,
                            parentSessionId: baseId,
                            sliceIndex: sliceIdx,
                            bookId,
                            bookTitle,
                            bookAuthor,
                            startTime: grp.startMs, // Numerical epoch ms (LL-29)
                            endTime: grp.endMs,     // Numerical epoch ms (LL-29)
                            durationSeconds: dur,
                            activeIntervals: grp.activeIntervals,
                            isListening: true,
                            kind: 'listen',
                            date: grp.date
                        })
                        sliceIdx++
                    }
                }

                if (records.length > 0) {
                    this._pendingListeningBatches.push({
                        id: baseId,
                        bookId,
                        records
                    })
                }
            }
        }

        // Process pending batches (LL-31)
        if (this._pendingListeningBatches.length === 0) return Promise.resolve()

        const processBatches = async () => {
            const batches = [...this._pendingListeningBatches]
            for (const batch of batches) {
                try {
                    for (const record of batch.records) {
                        await db.recordReadingSession(record)
                    }
                    const idx = this._pendingListeningBatches.indexOf(batch)
                    if (idx !== -1) {
                        this._pendingListeningBatches.splice(idx, 1)
                    }
                } catch (e) {
                    console.debug('Failed to record TTS session batch, will retry:', e)
                    throw e
                }
            }
        }

        return processBatches().catch(e => {
            // Keep error logged but handled; batches remain in _pendingListeningBatches for subsequent flush retry
            console.debug('TTS session flush deferred for retry:', e)
        })
    }

    pause(notifyProvider = true) {
        if (this.state !== 'playing' && this.state !== 'preparing') return
        if (this._nativeQueue) {
            this.setState('paused')
            if (notifyProvider) platformBridge.pauseBackgroundTts({ jobId: this._nativeQueue.jobId }).catch(() => {})
            return
        }
        if (this._currentSegmentStartTime) {
            const now = Date.now()
            if (now > this._currentSegmentStartTime) this.activeListeningIntervals.push([this._currentSegmentStartTime, now])
            this._currentSegmentStartTime = null
        }
        this.setState('paused')
        if (notifyProvider) this.provider.pause()
    }

    resume(notifyProvider = true) {
        if (this.state !== 'paused') return
        if (this._nativeQueue) {
            const owner = this._nativeQueue
            this.setState('preparing')
            if (notifyProvider) platformBridge.resumeBackgroundTts({ jobId: owner.jobId }).then(started => {
                if (!started && this._nativeQueue === owner) {
                    const index = this.currentIndex
                    this.stop(false)
                    this.play(index).catch(e => this.readerApp?.showToast?.(e.message, 'warning'))
                }
            }).catch(() => { if (this._nativeQueue === owner) this.setState('paused') })
            return
        }
        const now = Date.now()
        if (!this.sessionBookOwner) {
            const app = this.readerApp || window.app
            this.sessionBookOwner = { bookId: app?.currentBookId || app?.currentBookData?.id || null, bookTitle: app?.currentBookData?.title || '未知书籍', bookAuthor: app?.currentBookData?.author || app?.currentBookMeta?.author || '', startTimestamp: now }
        }
        this._currentSegmentStartTime = now
        this.setState('playing')
        if (this._loopRunning) {
            if (notifyProvider) this.provider.resume()
        } else {
            if (notifyProvider) this.provider.stop()
            this._stopRequested = false
            this.playbackLoop(++this.generation)
        }
    }

    stop(resetIndex = true) {
        const nativeOwner = this._nativeQueue
        this._nativeQueue = null
        clearInterval(this.sleepTimerInterval)
        this.sleepTimerInterval = null
        this.sleepTimerDurationMinutes = 0
        this.sleepTimerRemainingSeconds = 0
        this._stopRequested = true
        this.generation++
        this.abortController?.abort()
        this.abortController = null
        this.flushListeningSession(false)
        this.setState('stopped')
        if (nativeOwner) {
            platformBridge.stopBackgroundTts({ jobId: nativeOwner.jobId })
                .then(() => this.syncNativeListening()).catch(e => console.debug('Listening stop sync deferred:', e))
        } else this.provider.stop()
        this.clearHighlight()
        if (resetIndex) this.currentIndex = -1
    }

    next() {
        if (platformBridge.isAndroid && platformBridge.isTauri && this.provider.name === 'system') {
            platformBridge.nextBackgroundTts().catch(() => {})
            return
        }
        const curr = this.currentIndex >= 0 ? this.currentIndex : 0
        if (curr + 1 < this.segments.length) {
            const targetIdx = curr + 1
            this.stop(false)
            this.play(targetIdx)
        }
    }

    prev() {
        if (platformBridge.isAndroid && platformBridge.isTauri && this.provider.name === 'system') {
            platformBridge.prevBackgroundTts().catch(() => {})
            return
        }
        const curr = this.currentIndex >= 0 ? this.currentIndex : 0
        if (curr > 0) {
            const targetIdx = curr - 1
            this.stop(false)
            this.play(targetIdx)
        }
    }

    setRate(rate) {
        this.rate = Math.max(0.5, Math.min(3.0, Number(rate) || 1.0))
        this.persistPreferences()
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            (this.currentProviderName === 'system' ? platformBridge.setTtsRate(this.rate) : Promise.resolve()).catch(() => {})
        }
    }

    setVoice(voiceId) {
        this.voiceId = String(voiceId || '').trim()
        this.providerConfigs[this.currentProviderName].voiceId = this.voiceId
        this.persistPreferences()
    }

    cancelPreview() {
        this._previewController?.abort()
        this._previewProvider?.stop()
        this._previewController = null
        this._previewProvider = null
    }

    async preview(text = '你好，欢迎使用 Linden Leaf。愿你享受阅读的时光。') {
        this.stop()
        this.cancelPreview()
        const controller = new AbortController()
        const provider = this.currentProviderName === 'api' ? new ApiTtsProvider() : this.currentProviderName === 'offline' ? new OfflineTtsProvider() : new SystemTtsProvider()
        this._previewController = controller
        this._previewProvider = provider
        try { await provider.play({ id: 'preview', text }, { ...this.getProviderOptions(), signal: controller.signal }) }
        finally {
            provider.stop()
            provider.clearCache?.()
            if (this._previewController === controller) { this._previewController = null; this._previewProvider = null }
        }
    }

    clearAudioCache() {
        this.stop()
        this.cancelPreview()
        return this.providers.api.clearCache()
    }

    /**
     * Sleep Timer: 0, 15, 30, 45, 60, or 'end_of_chapter'
     */
    setSleepTimer(minutes) {
        clearInterval(this.sleepTimerInterval)
        this.sleepTimerDurationMinutes = minutes
        this.sleepTimerRemainingSeconds = minutes === 'end_of_chapter' ? -1 : Math.max(0, Number(minutes) || 0) * 60
        if (platformBridge.isAndroid && platformBridge.isTauri && this.currentProviderName === 'system') {
            platformBridge.setTtsSleepTimer(minutes === 'end_of_chapter' ? 0 : Number(minutes) || 0).catch(() => {})
            return
        }
        if (!this.sleepTimerRemainingSeconds || minutes === 'end_of_chapter') return
        this.sleepTimerInterval = setInterval(() => {
            if (this.state === 'playing' && --this.sleepTimerRemainingSeconds <= 0) {
                clearInterval(this.sleepTimerInterval)
                this.pause()
                this.readerApp?.showToast?.('定时关闭时间到，朗读已暂停', 'info')
            }
        }, 1000)
    }

    async syncNativeListening() {
        if (!platformBridge.isAndroid || !platformBridge.isTauri) return null
        this._nativeSyncRequested = true
        if (this._nativeSync) return this._nativeSync
        this._nativeSync = (async () => {
            let snapshot
            do {
                this._nativeSyncRequested = false
                snapshot = await platformBridge.getBackgroundPlaybackState()
                const intervals = [...(snapshot?.listeningIntervals || [])].sort((a, b) => a.sequence - b.sequence)
                let through = 0
                for (const interval of intervals) {
                    let start = Number(interval.startMs)
                    const end = Number(interval.endMs)
                    if (!interval.bookId || !(end > start)) continue
                    let part = 0
                    while (start < end) {
                        const date = new Date(start)
                        const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
                        const until = Math.min(end, midnight)
                        const dateKey = db.toLocalDateKey(date)
                        const author = interval.bookAuthor || (window.app?.currentBookData?.id === interval.bookId ? window.app?.currentBookData?.author : '') || window.app?.currentBookMeta?.author || ''
                        await db.recordReadingSession({
                            id: `android_tts_${interval.jobId}_${interval.sequence}_${part++}`,
                            bookId: interval.bookId, bookTitle: interval.bookTitle, bookAuthor: author,
                            startTime: start, endTime: until, durationSeconds: (until - start) / 1000,
                            activeIntervals: [[start, until]], kind: 'listen', isListening: true, date: dateKey
                        })
                        start = until
                    }
                    through = interval.sequence
                }
                if (through > 0) await platformBridge.acknowledgeTtsListening(through)
            } while (this._nativeSyncRequested)
            return snapshot
        })().finally(() => { this._nativeSync = null })
        return this._nativeSync
    }

    handleNativePlaybackEvent(data, synchronize = true) {
        if (synchronize) this.syncNativeListening().catch(e => console.debug('Listening sync deferred:', e))
        const owner = this._nativeQueue
        if (!owner || data.jobId !== owner.jobId || Number(data.generation) !== owner.generation) return
        const sequence = Number(data.seq ?? data.eventSeq ?? 0)
        if (sequence && sequence < (this._lastNativeEventSeq || 0)) return
        this._lastNativeEventSeq = sequence
        const index = Number(data.queueIndex)
        if (Number.isInteger(index) && index >= 0 && index < this.segments.length && this.currentIndex !== index) {
            this.currentIndex = index
            if (!document.hidden) this.highlightSegment(this.segments[index])
            this.notifyStateChange()
        }
        switch (data.type) {
            case 'playbackstarted':
                this.setState('playing')
                if (!document.hidden) this.highlightSegment(this.segments[this.currentIndex])
                break
            case 'playbackpreparing':
                this.setState('preparing')
                break
            case 'playbackpaused':
                this.setState('paused')
                break
            case 'playbackcompleted':
                this.setState('stopped')
                this.clearHighlight()
                this.readerApp?.showToast?.('本章朗读完毕', 'info')
                break
            case 'playbackstopped':
                this.setState('stopped')
                this.clearHighlight()
                this._nativeQueue = null
                break
            case 'playbackerror':
                this.setState('paused')
                this.readerApp?.showToast?.(data.error || '系统朗读未完成，请检查语音设置', 'warning')
                break
        }
    }

    initMediaSession() {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return
        try {
            navigator.mediaSession.setActionHandler('play', () => this.resume())
            navigator.mediaSession.setActionHandler('pause', () => this.pause())
            navigator.mediaSession.setActionHandler('stop', () => this.stop())
            navigator.mediaSession.setActionHandler('previoustrack', () => this.prev())
            navigator.mediaSession.setActionHandler('nexttrack', () => this.next())
        } catch (e) {
            console.debug('MediaSession registration error:', e)
        }
    }

    updateMediaSessionMetadata() {
        if (typeof navigator === 'undefined' || !navigator.mediaSession || !window.MediaMetadata) return
        const bookData = this.readerApp?.currentBookData || {}
        navigator.mediaSession.metadata = new window.MediaMetadata({
            title: bookData.title || 'Linden Leaf 朗读',
            artist: bookData.author || '未知作者',
            album: this.readerApp?.currentLocation?.tocItem?.label || '正文'
        })
    }
}

export const ttsPlayer = new TtsPlayer()
if (typeof window !== 'undefined') window.ttsPlayer = ttsPlayer
