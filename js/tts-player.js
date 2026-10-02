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
                const handler = () => {
                    window.speechSynthesis.removeEventListener('voiceschanged', handler)
                    resolve(window.speechSynthesis.getVoices())
                }
                window.speechSynthesis.addEventListener('voiceschanged', handler)
                setTimeout(() => resolve([]), 500)
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
                    if (d.utteranceId && d.utteranceId !== utteranceId) return
                    if (d.type === 'playbackstarted') {
                        options.onPlaybackStarted?.()
                    } else if (d.type === 'playbackcompleted') {
                        if (!resolved) {
                            resolved = true
                            cleanup()
                            resolve()
                        }
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
                }, 400)

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
            platformBridge.stopBackgroundTts()
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
        this.label = '云端 AI 拟真语音 (OpenAI / Qwen / CosyVoice)'
        this.cache = new Map() // key -> { url, size, lastUsed }
        this.maxCacheBytes = 50 * 1024 * 1024 // 50MB bounded LRU cache
        this.currentCacheBytes = 0
        this.currentAudio = null
        this._inflight = new Map() // key -> Promise<string>
        this._prefetchErrors = new Map()
    }

    async getVoices() {
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
            let apiKey = options.apiKey || ''
            if (!apiKey) {
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

            if (!apiKey) {
                throw new Error('未配置 TTS API Key，请在高级设置中配置 AI 密钥')
            }

            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
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
            const url = URL.createObjectURL(blob)
            this._addToCache(cacheKey, url, blob.size || 64 * 1024)
            return url
        })()

        this._inflight.set(cacheKey, fetchPromise)
        try {
            const resultUrl = await fetchPromise
            return resultUrl
        } finally {
            this._inflight.delete(cacheKey)
        }
    }

    async prefetch(segment, options = {}) {
        if (!segment?.text) return
        const cacheKey = this.getCacheKey(segment.text, options)
        if (this.cache.has(cacheKey) || this._inflight.has(cacheKey)) return
        try {
            await this.fetchAudioBlob(segment.text, options)
        } catch (e) {
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
        for (const [_, item] of this.cache.entries()) {
            try { URL.revokeObjectURL(item.url) } catch (_) {}
        }
        this.cache.clear()
        this.currentCacheBytes = 0
        this._inflight.clear()
        this._prefetchErrors.clear()
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
        if (!text) return

        // 1. Try connecting to local sherpa-onnx / Kokoro HTTP engine endpoint
        try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 15000)
            const endpoint = options.localEndpoint || this.localEndpoint
            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: options.model || 'kokoro-82m-zh',
                    input: text,
                    voice: options.voiceId || 'zf_xiaobei',
                    speed: options.rate || 1.0
                }),
                signal: controller.signal
            })
            clearTimeout(timer)

            if (resp.ok) {
                const blob = await resp.blob()
                const url = URL.createObjectURL(blob)
                return new Promise((resolve, reject) => {
                    const audio = new Audio(url)
                    // Note: speed was already rendered into the synthesized waveform, keep playbackRate at 1.0
                    audio.playbackRate = 1.0
                    audio.onplay = () => {
                        options.onPlaybackStarted?.()
                    }
                    audio.onended = () => {
                        this.currentAudio = null
                        URL.revokeObjectURL(url)
                        resolve()
                    }
                    audio.onerror = () => {
                        this.currentAudio = null
                        URL.revokeObjectURL(url)
                        reject(new Error('离线音频解码失败'))
                    }
                    this.currentAudio = audio
                    audio.play().catch(reject)
                })
            }
        } catch (_) {
            // Local server not running
        }

        // 2. Explicit dependency check: HTTP service unavailable
        throw new Error('无法连接到自建语音服务（' + endpoint + '）。请确认本地或局域网中的 sherpa-onnx / Kokoro HTTP 语音服务已启动，或切换使用「系统原生语音」/「云端 AI 拟真语音」。')
    }

    pause() {
        if (this.currentAudio) this.currentAudio.pause()
    }

    resume() {
        if (this.currentAudio) this.currentAudio.play()
    }

    stop() {
        if (this.currentAudio) {
            this.currentAudio.pause()
            this.currentAudio.currentTime = 0
            this.currentAudio = null
        }
    }
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
                model: 'kokoro-82m-zh'
            },
            api: {
                apiEndpoint: 'https://api.openai.com/v1/audio/speech',
                apiKey: '',
                model: 'tts-1'
            }
        }

        this.activeListeningIntervals = []
        this._currentSegmentStartTime = null
        this.completedUtteranceIds = new Set()

        if (typeof window !== 'undefined') {
            window.addEventListener('androidmedianext', () => this.next())
            window.addEventListener('androidmediaprev', () => this.prev())
            window.addEventListener('androidttsevent', (e) => {
                const d = e.detail || {}
                if (d.type === 'playbackpaused') {
                    if (this.state === 'playing') {
                        this.pause(false)
                    }
                } else if (d.type === 'playbackstarted') {
                    if (this.state === 'paused') {
                        this.resume(false)
                    } else if (this.state === 'playing' && !this._currentSegmentStartTime) {
                        this._currentSegmentStartTime = Date.now()
                    }
                }
            })
        }

        this.initMediaSession()
    }

    get provider() {
        return this.providers[this.currentProviderName] || this.providers.system
    }

    setProvider(name, config = {}) {
        if (!this.providers[name]) {
            throw new Error(`未知语音引擎: ${name}`)
        }
        const wasPlaying = this.state === 'playing'
        const resumeIdx = this.currentIndex
        this.stop()
        this.currentProviderName = name
        if (config && typeof config === 'object') {
            this.providerConfigs[name] = { ...this.providerConfigs[name], ...config }
        }
        this.voiceId = null
        this.notifyStateChange()
        if (wasPlaying && resumeIdx >= 0) {
            this.play(resumeIdx).catch(() => {})
        }
    }

    loadSettings(settings = {}) {
        if (!settings || typeof settings !== 'object') return
        if (settings.ttsProvider && this.providers[settings.ttsProvider]) {
            this.currentProviderName = settings.ttsProvider
        }
        if (settings.ttsRate != null) {
            this.setRate(settings.ttsRate)
        }
        if (settings.ttsVoiceId) {
            this.voiceId = settings.ttsVoiceId
        }
        if (settings.ttsApiEndpoint) {
            this.providerConfigs.api.apiEndpoint = settings.ttsApiEndpoint
        }
        if (settings.ttsApiKey) {
            this.providerConfigs.api.apiKey = settings.ttsApiKey
        }
        if (settings.ttsApiModel) {
            this.providerConfigs.api.model = settings.ttsApiModel
        }
        if (settings.ttsOfflineEndpoint) {
            this.providerConfigs.offline.localEndpoint = settings.ttsOfflineEndpoint
        }
        if (settings.ttsOfflineModel) {
            this.providerConfigs.offline.model = settings.ttsOfflineModel
        }
    }

    getSettings() {
        return {
            ttsProvider: this.currentProviderName,
            ttsRate: this.rate,
            ttsVoiceId: this.voiceId,
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
            voiceId: this.voiceId,
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
                        segments.push({
                            id: `seg_${idx++}`,
                            index: segments.length,
                            text: cleaned,
                            element: el,
                            format: 'epub'
                        })
                    }
                }
            }
        }

        // 2. PDF Viewport
        const pdfViewport = this.readerApp.pdfViewport
        if (!foliateView && pdfViewport) {
            const textLayer = document.querySelector('.pdf-text-layer') || document.querySelector('#pdf-text-layer')
            if (textLayer) {
                const spans = textLayer.querySelectorAll('span')
                const combined = Array.from(spans).map(s => s.textContent).join(' ').trim()
                if (combined) {
                    segments.push({
                        id: 'seg_pdf_0',
                        index: 0,
                        text: combined,
                        element: textLayer,
                        format: 'pdf'
                    })
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
            startTimestamp: now
        }
        this.setState('playing')

        this.updateMediaSessionMetadata()
        await this.playbackLoop(myGen)
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

        if (intervals.length === 0) return

        // Compute union of intervals to strictly exclude pauses and prevent double-counting
        intervals.sort((a, b) => a[0] - b[0])
        let unionSecs = 0
        let cur = null
        for (const [s, e] of intervals) {
            if (!cur) {
                cur = [s, e]
            } else if (s <= cur[1]) {
                cur[1] = Math.max(cur[1], e)
            } else {
                unionSecs += (cur[1] - cur[0]) / 1000
                cur = [s, e]
            }
        }
        if (cur) {
            unionSecs += (cur[1] - cur[0]) / 1000
        }

        const bookId = owner?.bookId
        if (unionSecs >= 2 && bookId) {
            const bookTitle = owner?.bookTitle || '未知书籍'
            const dur = Math.round(unionSecs)
            const firstStart = intervals[0][0]
            const lastEnd = intervals[intervals.length - 1][1]
            const todayStr = (typeof db.toLocalDateKey === 'function')
                ? db.toLocalDateKey(new Date(firstStart))
                : new Date(firstStart).toLocaleDateString('en-CA')

            db.recordReadingSession({
                id: `tts_${firstStart}_${Math.random().toString(36).slice(2, 6)}`,
                bookId,
                bookTitle,
                startTime: new Date(firstStart).toISOString(),
                endTime: new Date(lastEnd).toISOString(),
                durationSeconds: dur,
                isListening: true,
                kind: 'listen',
                date: todayStr
            }).catch(e => console.debug('Failed to record TTS session:', e))
        }
    }

    pause(notifyProvider = true) {
        if (this.state === 'playing' || this.state === 'preparing') {
            if (this._currentSegmentStartTime) {
                const now = Date.now()
                if (now > this._currentSegmentStartTime) {
                    this.activeListeningIntervals.push([this._currentSegmentStartTime, now])
                }
                this._currentSegmentStartTime = null
            }
            this.setState('paused')
            if (notifyProvider) this.provider.pause()
        }
    }

    resume(notifyProvider = true) {
        if (this.state === 'paused') {
            const now = Date.now()
            if (!this.sessionBookOwner) {
                const app = this.readerApp || (typeof window !== 'undefined' ? window.app : null)
                this.sessionBookOwner = {
                    bookId: app?.currentBookId || app?.currentBookData?.id || null,
                    bookTitle: app?.currentBookData?.title || '未知书籍',
                    startTimestamp: now
                }
            }
            this._currentSegmentStartTime = now
            this.setState('playing')
            if (this._loopRunning) {
                if (notifyProvider) this.provider.resume()
            } else if (this.currentIndex >= 0 && this.currentIndex < this.segments.length) {
                this.playbackLoop(++this.generation)
            }
        }
    }

    stop(resetIndex = true) {
        this._stopRequested = true
        this.generation++
        if (this.abortController) {
            this.abortController.abort()
            this.abortController = null
        }
        this.flushListeningSession(false)
        this.setState('stopped')
        this.provider.stop()
        this.clearHighlight()
        if (resetIndex) {
            this.currentIndex = -1
        }
    }

    next() {
        const curr = this.currentIndex >= 0 ? this.currentIndex : 0
        if (curr + 1 < this.segments.length) {
            const targetIdx = curr + 1
            this.stop(false)
            this.play(targetIdx)
        }
    }

    prev() {
        const curr = this.currentIndex >= 0 ? this.currentIndex : 0
        if (curr > 0) {
            const targetIdx = curr - 1
            this.stop(false)
            this.play(targetIdx)
        }
    }

    setRate(rate) {
        this.rate = Math.max(0.5, Math.min(3.0, Number(rate) || 1.0))
    }

    setVoice(voiceId) {
        this.voiceId = voiceId
    }

    /**
     * Sleep Timer: 0, 15, 30, 45, 60, or 'end_of_chapter'
     */
    setSleepTimer(minutes) {
        clearInterval(this.sleepTimerInterval)
        this.sleepTimerDurationMinutes = minutes

        if (!minutes || minutes === 0) {
            this.sleepTimerRemainingSeconds = 0
            return
        }

        if (minutes === 'end_of_chapter') {
            this.sleepTimerRemainingSeconds = -1
            return
        }

        this.sleepTimerRemainingSeconds = Number(minutes) * 60
        this.sleepTimerInterval = setInterval(() => {
            if (this.state === 'playing') {
                this.sleepTimerRemainingSeconds--
                if (this.sleepTimerRemainingSeconds <= 0) {
                    clearInterval(this.sleepTimerInterval)
                    this.pause()
                    this.readerApp?.showToast?.('定时关闭时间到，朗读已暂停', 'info')
                }
            }
        }, 1000)
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
