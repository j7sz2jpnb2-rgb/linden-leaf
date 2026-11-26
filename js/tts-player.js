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
import { getLocale, t } from './i18n.js'

async function requestSpeechAudio(endpoint, options) {
    if (!platformBridge.isAndroid || !platformBridge.isTauri) return fetch(endpoint, options)
    const data = await platformBridge.requestTtsAudio(endpoint, options.body, options.headers, options.signal)
    return new Response(data, { headers: { 'Content-Type': 'audio/mpeg' } })
}

export function formatAndroidTtsError(errorCode, rawDetail) {
    const detail = String(rawDetail || '').trim()
    switch (errorCode) {
        case 'NO_TTS_ENGINE':
            return t('tts.error.noEngine')
        case 'MISSING_LANGUAGE_DATA':
            return detail ? t('tts.error.missingLangDataDetail', { detail }) : t('tts.error.missingLangData')
        case 'LANGUAGE_NOT_SUPPORTED':
            return detail ? t('tts.error.langNotSupportedDetail', { detail }) : t('tts.error.langNotSupported')
        case 'TTS_INIT_FAILED':
            return detail ? t('tts.error.initFailedDetail', { detail }) : t('tts.error.initFailed')
        case 'AUDIO_FOCUS_FAILED':
            return t('tts.error.audioFocusFailed')
        case 'BRIDGE_CALL_FAILED':
            return detail ? t('tts.error.bridgeFailedDetail', { detail }) : t('tts.error.bridgeFailed')
        case 'EMPTY_QUEUE':
            return t('tts.error.noReadableText')
        case 'PLAYBACK_FAILED':
            return detail ? t('tts.error.playbackFailedDetail', { detail }) : t('tts.error.androidFailed')
        default:
            return detail || t('tts.error.androidFailed')
    }
}

function makeAndroidTtsError(errorCode, rawDetail) {
    const err = new Error(formatAndroidTtsError(errorCode, rawDetail))
    err.code = errorCode || 'PLAYBACK_FAILED'
    err.rawDetail = String(rawDetail || '').trim()
    return err
}


function hasSpeakableText(text) {
    return Boolean(text && /[\p{L}\p{N}]/u.test(text))
}

function detectSpeechLang(text, fallbackLocale = 'zh-CN') {
    const s = String(text || '')
    const loc = String(fallbackLocale || 'zh-CN').trim()
    if (/[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F]/.test(s)) return 'ja-JP'
    if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(s)) return 'ko-KR'
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(s)) {
        if (/^ja/i.test(loc)) return 'ja-JP'
        if (/zh[-_](TW|HK|MO|Hant)/i.test(loc)) return 'zh-TW'
        return 'zh-CN'
    }
    if (/[A-Za-z]/.test(s)) return /^en/i.test(loc) ? loc : 'en-US'
    return loc || 'zh-CN'
}

export class SystemTtsProvider {
    get label() { return t('tts.provider.systemLabel') }

    constructor() {
        this.name = 'system'
        this.currentUtterance = null
        this._stopped = false
        this._paused = false
    }

    async getVoices() {
        if (platformBridge.isAndroid && platformBridge.isTauri) {
            return [{
                id: 'android_default',
                name: t('tts.provider.androidDefault'),
                lang: getLocale(),
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

        const rawText = String(segment?.text || '')
        if (!hasSpeakableText(rawText)) {
            return Promise.resolve()
        }

        if (platformBridge.isAndroid && platformBridge.isTauri) {
            const bookTitle = options.bookTitle || 'Linden Leaf'
            const text = rawText
            const rate = options.rate || 1.0
            const jobId = options.jobId || `job_${Date.now()}`
            const utteranceId = options.utteranceId || `utt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            const generation = options.generation || 0

            this._nativeJobId = jobId
            const startNative = () => platformBridge.startBackgroundTts(bookTitle, text, rate, {
                jobId,
                utteranceId,
                generation,
                bookId: options.bookId || '',
                bookAuthor: options.bookAuthor || '',
                voiceId: options.voiceId || '',
                locale: options.locale || getLocale() || 'zh-CN'
            })

            return new Promise((resolve, reject) => {
                let resolved = false
                let cleanup = () => {}

                const settleReject = (err) => {
                    if (resolved) return
                    resolved = true
                    cleanup()
                    reject(err)
                }
                const settleResolve = () => {
                    if (resolved) return
                    resolved = true
                    cleanup()
                    resolve()
                }

                const eventHandler = (e) => {
                    const d = e.detail || {}
                    if (d.jobId !== jobId || Number(d.generation) !== generation) return
                    if (d.type === 'playbacksegmentcompleted' && d.utteranceId === utteranceId) {
                        settleResolve()
                    } else if (d.type === 'playbackcompleted') {
                        settleResolve()
                    } else if (d.type === 'playbackstarted' && (!d.utteranceId || d.utteranceId === utteranceId)) {
                        if (!this._paused && !this._stopped) options.onPlaybackStarted?.()
                    } else if (d.type === 'playbackerror') {
                        settleReject(makeAndroidTtsError(d.errorCode, d.error))
                    } else if (d.type === 'playbackstopped') {
                        settleResolve()
                    }
                }

                window.addEventListener('androidttsevent', eventHandler)
                const onAbort = () => {
                    platformBridge.stopBackgroundTts({ jobId }).catch(() => {})
                    settleResolve()
                }
                options.signal?.addEventListener('abort', onAbort, { once: true })
                this._finishNativePlayback = settleResolve

                const pollTimer = setInterval(async () => {
                    if (resolved) return
                    if (this._stopped || options.signal?.aborted) {
                        settleResolve()
                        return
                    }
                    if (typeof document !== 'undefined' && document.hidden) return
                    try {
                        const state = await platformBridge.getBackgroundPlaybackState()
                        if (!state) return
                        const sameJob = state.jobId === jobId && Number(state.generation) === generation
                        if (state.completedUtteranceId === utteranceId && Number(state.completedGeneration) === generation && state.state === 'completed') {
                            settleResolve()
                        } else if (sameJob && state.state === 'error' && (!state.utteranceId || state.utteranceId === utteranceId)) {
                            settleReject(makeAndroidTtsError(state.errorCode, state.error))
                        } else if (sameJob && state.state === 'stopped') {
                            settleResolve()
                        }
                    } catch (_) {}
                }, 1000)

                cleanup = () => {
                    window.removeEventListener('androidttsevent', eventHandler)
                    options.signal?.removeEventListener('abort', onAbort)
                    clearInterval(pollTimer)
                    if (this._finishNativePlayback === settleResolve) this._finishNativePlayback = null
                }
                // Subscribe before invoking native: a ready engine can start/error
                // synchronously, and stopping must settle even while the app is hidden.
                if (options.signal?.aborted) { settleResolve(); return }
                startNative().then(async result => {
                    if (resolved || this._stopped || this._nativeJobId !== jobId || options.signal?.aborted) {
                        await platformBridge.stopBackgroundTts({ jobId }).catch(() => {})
                        settleResolve()
                        return
                    }
                    if (!result?.started && result !== true)
                        throw makeAndroidTtsError(result?.errorCode || 'TTS_INIT_FAILED', result?.error || '')
                    if (this._paused) await platformBridge.pauseBackgroundTts({ jobId })
                }).catch(settleReject)
            })
        }

        if (typeof window === 'undefined' || !window.speechSynthesis) {
            throw new Error(t('tts.error.webSpeechUnsupported'))
        }

        return new Promise((resolve, reject) => {
            const utterance = new SpeechSynthesisUtterance(rawText)
            utterance.rate = options.rate || 1.0
            utterance.pitch = options.pitch || 1.0

            if (options.voiceId) {
                const all = window.speechSynthesis.getVoices()
                const match = all.find(v => (v.voiceURI || v.name) === options.voiceId)
                if (match) utterance.voice = match
            }
            utterance.lang = utterance.voice?.lang || detectSpeechLang(rawText, options.locale || getLocale() || 'zh-CN')

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
                    reject(new Error(t('tts.error.webSpeechPlayback', { error: e.error })))
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
            this._finishNativePlayback?.()
            if (jobId) platformBridge.stopBackgroundTts({ jobId }).catch(() => {})
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
    get label() { return t('tts.provider.apiLabel') }

    constructor() {
        this.name = 'api'
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
        if (!official) return [{ id: options.voiceId || '', name: options.voiceId || t('tts.voice.defaultService') }]
        return [
            { id: 'alloy', name: t('tts.voice.alloy') },
            { id: 'echo', name: t('tts.voice.echo') },
            { id: 'fable', name: t('tts.voice.fable') },
            { id: 'onyx', name: t('tts.voice.onyx') },
            { id: 'nova', name: t('tts.voice.nova') },
            { id: 'shimmer', name: t('tts.voice.shimmer') }
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
            throw new Error(t('tts.error.prefetchFailed', { detail: err.message || err }))
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
                throw new Error(t('tts.error.missingApiKey'))
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
                throw new Error(t('tts.error.apiFailed', { status: resp.status, body: errBody }))
            }

            const blob = await resp.blob()
            if (options.signal?.aborted) throw new DOMException(t('tts.error.aborted'), 'AbortError')
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
                    reject(new Error(t('tts.error.audioDecodeFailed')))
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
    get label() { return t('tts.provider.offlineLabel') }

    constructor() {
        this.name = 'offline'
        this.currentAudio = null
        this.localEndpoint = 'http://127.0.0.1:8880/v1/audio/speech'
    }

    async getVoices() {
        return [
            { id: 'zf_xiaobei', name: t('tts.voice.kokoroXiaobei') },
            { id: 'zf_xiaoni', name: t('tts.voice.kokoroXiaoni') },
            { id: 'zf_xiaoxiao', name: t('tts.voice.kokoroXiaoxiao') },
            { id: 'zf_xiaoyi', name: t('tts.voice.kokoroXiaoyi') },
            { id: 'zm_yunjian', name: t('tts.voice.kokoroYunjian') },
            { id: 'zm_yunxi', name: t('tts.voice.kokoroYunxi') },
            { id: 'af_bella', name: t('tts.voice.kokoroBella') },
            { id: 'af_sarah', name: t('tts.voice.kokoroSarah') },
            { id: 'am_adam', name: t('tts.voice.kokoroAdam') }
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
            if (!resp.ok) throw new Error(t('tts.error.offlineHttp', { status: resp.status, body: (await resp.text()).slice(0, 200) }))
            const blob = await resp.blob()
            clearTimeout(timer)
            if (timedOut) throw new Error(t('tts.error.offlineTimeout'))
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
                audio.onerror = () => finish(new Error(t('tts.error.offlineDecode')))
                audio.play().catch(error => finish(error))
            })
        } catch (error) {
            if (!timedOut && (controller.signal.aborted || options.signal?.aborted)) return
            throw new Error(t('tts.error.offlinePlay', { detail: error.message }))
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

/**
 * Decide whether a <sup> element is a footnote marker (should strip from TTS speech)
 * vs. mathematical/scientific notation or units (x², 10⁶, m², cm³ — must preserve!).
 */
export function shouldStripTtsSuperscript(supEl) {
    if (!supEl) return false
    if (supEl.matches?.('a[role="doc-noteref"], .footnote-ref, .footnote')) return true
    if (supEl.querySelector?.('a[href], [role="doc-noteref"], .footnote-ref') || supEl.closest?.('a[href]')) return true

    const txt = (supEl.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (!txt) return true

    // Circled numbers, daggers, stars, section marks, explicit [1] / (1) / 注1
    if (/^[\[（(【]/.test(txt) || /[\]）)】]$/.test(txt)) {
        return /^[\[（(【]\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021§¶]|注\s*\d*|[a-zA-Z])\s*[\]）)】]$/.test(txt)
    }
    if (/^(?:[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021§¶]|注\s*\d*)$/.test(txt)) return true

    // Preserve numeric/variable exponents immediately following math/unit bases (x^2, 10^6, m^2, kg^-1)
    const prevText = supEl.previousSibling?.textContent || ''
    const prevChar = prevText.slice(-1)
    if (prevChar && /[a-zA-Z0-9)\]°℃℉%μ]/.test(prevChar) && /^[+-]?\d{1,3}$|^[a-zA-Z]$/.test(txt)) {
        return false
    }

    return /^\d{1,4}$/.test(txt)
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
        this._segmentOwner = null
        this._activeLoopPromise = null
        this._visibilityListenerBound = false
        this.lastError = null
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
                    if (!state) return
                    if (this._nativeQueue && state.state === 'idle' && !state.jobId) {
                        this._nativeQueue = null
                        this.sessionBookOwner = null
                        this.clearHighlight()
                        this.setState('stopped')
                        return
                    }
                    const typeMap = {
                        playing: 'playbackstarted',
                        preparing: 'playbackpreparing',
                        paused: 'playbackpaused',
                        completed: 'playbackcompleted',
                        stopped: 'playbackstopped',
                        error: 'playbackerror'
                    }
                    const mappedType = typeMap[state.state]
                    if (mappedType) this.handleNativePlaybackEvent({ ...state, type: mappedType }, false)
                } catch (e) { console.debug('Playback restore deferred:', e) }
            })
        }

        this.initMediaSession()
    }

    get provider() {
        return this.providers[this.currentProviderName] || this.providers.system
    }

    setProvider(name, config = {}) {
        if (!this.providers[name]) throw new Error(t('tts.error.unknownProvider', { name }))
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
        const fallbackLocale = typeof getLocale === 'function' ? getLocale() : 'zh-CN'
        return {
            ...base,
            voiceId: this.voiceId || base.voiceId || '',
            rate: this.rate,
            locale: fallbackLocale || 'zh-CN',
            bookId: this.sessionBookOwner?.bookId || this.readerApp?.currentBookId || '',
            bookAuthor: this.sessionBookOwner?.bookAuthor || this.readerApp?.currentBookData?.author || '',
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
        if (!this._visibilityListenerBound && typeof document !== 'undefined') {
            this._visibilityListenerBound = true
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    this.reattachNativePlayback().catch(e => console.debug('TTS reattach deferred:', e))
                }
            })
        }
        this.reattachNativePlayback().catch(e => console.debug('Listening recovery deferred:', e))
    }

    _resolveChapterKey(app = this.readerApp) {
        if (!app?.foliateView) return null
        const loc = app.currentLocation || app.foliateView?.lastLocation || null
        if (loc?.sectionIndex != null) return `sec:${loc.sectionIndex}`
        if (loc?.tocItem?.href) return `href:${loc.tocItem.href}`
        if (loc?.cfi) return `cfi:${String(loc.cfi).split('!')[0]}`
        return null
    }

    _invalidateSegments() {
        this.segments = []
        this._segmentOwner = null
        this.currentIndex = -1
    }

    _areSegmentsValid(app = this.readerApp, startIndex = null) {
        if (!this.segments.length || !this._segmentOwner) return false
        const activeBookId = app?.currentBookId || app?.currentBookData?.id || null
        if (this._segmentOwner.bookId && activeBookId && this._segmentOwner.bookId !== activeBookId) {
            return false
        }
        if (this._segmentOwner.format === 'epub') {
            const chapterKey = this._resolveChapterKey(app)
            if (chapterKey != null && this._segmentOwner.chapterKey != null && chapterKey !== this._segmentOwner.chapterKey) {
                return false
            }
            if (this.segments.some(s => s?.element && s.element.isConnected === false)) {
                return false
            }
            return true
        }
        if (this._segmentOwner.format === 'pdf') {
            const curPage = app?.pdfViewport?.currentPage ?? 0
            if (startIndex == null && !['playing', 'paused', 'preparing'].includes(this.state)) {
                if (curPage !== this._segmentOwner.startPage) return false
            }
            if (curPage < this._segmentOwner.startPage || curPage > this._segmentOwner.endPage) {
                return false
            }
            return true
        }
        return true
    }

    _ocrCharsToText(chars) {
        if (!Array.isArray(chars) || !chars.length) return ''
        let text = ''
        let lastLine = null
        for (const ch of chars) {
            if (!ch?.text) continue
            if (lastLine !== null && ch.line !== lastLine) text += '\n'
            text += ch.text
            lastLine = ch.line
        }
        return text.trim()
    }

    /**
     * Extract speakable segments from the current reading view using proper Foliate source documents
     */
    async extractSegments({ startPage = null } = {}) {
        const segments = []
        this._segmentOwner = null
        if (!this.readerApp) {
            this.segments = segments
            return segments
        }

        const app = this.readerApp
        const activeBookId = app.currentBookId || app.currentBookData?.id || null

        // 1. Reflowable EPUB / TXT document
        const foliateView = app.foliateView
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

                    // Clean out footnote tags and markers before reading while preserving math/unit superscripts
                    const clone = el.cloneNode(true)
                    clone.querySelectorAll('a[role="doc-noteref"], .footnote-ref, .footnote').forEach(n => n.remove())
                    clone.querySelectorAll('sup').forEach(sup => {
                        if (shouldStripTtsSuperscript(sup)) sup.remove()
                    })
                    const raw = clone.innerText || clone.textContent || ''
                    const cleaned = raw.replace(/\s+/g, ' ').trim()
                    if (cleaned.length >= 1 && hasSpeakableText(cleaned)) {
                        const chunks = splitTextIntoSentences(cleaned, 800)
                        for (const chunk of chunks) {
                            if (chunk.length >= 1 && hasSpeakableText(chunk)) {
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
            this.segments = segments
            this._segmentOwner = {
                bookId: activeBookId,
                chapterKey: this._resolveChapterKey(app),
                format: 'epub'
            }
            return segments
        }

        const viewport = app.pdfViewport
        if (!foliateView && viewport) {
            const driver = app.pdfDriver || viewport.driver
            const numPages = Math.max(1, viewport.numPages || driver?.numPages || 1)
            const firstPage = Math.max(0, Math.min(startPage != null ? startPage : (viewport.currentPage ?? 0), numPages - 1))
            const maxPagesPerBatch = 10
            const maxCharsPerBatch = 50000
            let totalChars = 0
            let endPage = firstPage
            const docHash = app.currentBookData?.documentHash || activeBookId

            for (let p = firstPage; p < numPages && (p - firstPage) < maxPagesPerBatch && totalChars < maxCharsPerBatch; p++) {
                let text = ''
                if (typeof driver?.getPagePlainText === 'function') {
                    text = await driver.getPagePlainText(p).catch(() => '')
                }
                if (app.currentBookId !== activeBookId || app.pdfViewport !== viewport) {
                    this.segments = []
                    return []
                }
                if (!hasSpeakableText(text)) {
                    const memOcr = viewport._pageOcrData?.get?.(p)
                    if (memOcr?.length) {
                        text = this._ocrCharsToText(memOcr)
                    } else if (docHash && typeof db?.getSetting === 'function') {
                        const cached = await db.getSetting(`linden_ocr_${docHash}_p${p}`).catch(() => null)
                        if (app.currentBookId !== activeBookId || app.pdfViewport !== viewport) {
                            this.segments = []
                            return []
                        }
                        if (Array.isArray(cached) && cached.length) {
                            viewport.setPageOcrData?.(p, cached)
                            text = cached.map(s => s?.text || '').join(' ').trim()
                        }
                    }
                }
                if (!hasSpeakableText(text) && p === firstPage && typeof driver?.renderPageBitmap === 'function') {
                    let canvas = null
                    try {
                        const ocrMod = await import('./ocr-service.js')
                        const activeOcr = ocrMod?.ocrService || ocrMod?.default
                        const scale = 1.5
                        const pageSize = viewport.pageSizes?.[p] || driver.pageSizes?.[p] || null
                        const bmp = await driver.renderPageBitmap(p, scale, this.abortController?.signal)
                        canvas = bmp?.canvas || (bmp?.tagName === 'CANVAS' ? bmp : null)
                        if (app.currentBookId !== activeBookId || app.pdfViewport !== viewport) {
                            this.segments = []
                            return []
                        }
                        if (canvas && activeOcr?.recognizeCanvas) {
                            const recognized = await activeOcr.recognizeCanvas(canvas, this.abortController?.signal, {
                                scale,
                                originX: driver?.kind === 'mupdf' ? (pageSize?.x0 || 0) : 0,
                                originY: driver?.kind === 'mupdf' ? (pageSize?.y0 || 0) : 0
                            })
                            if (app.currentBookId !== activeBookId || app.pdfViewport !== viewport) {
                                this.segments = []
                                return []
                            }
                            if (recognized?.spans?.length) {
                                viewport.setPageOcrData?.(p, recognized.spans)
                                if (docHash && typeof db?.setSetting === 'function') {
                                    db.setSetting(`linden_ocr_${docHash}_p${p}`, recognized.spans).catch(() => {})
                                }
                                text = recognized.text || ''
                            }
                        }
                    } catch (_) {
                    } finally {
                        if (canvas) { canvas.width = 0; canvas.height = 0 }
                    }
                }

                endPage = p
                if (!hasSpeakableText(text)) continue
                for (const chunk of splitTextIntoSentences(text, 800)) {
                    if (chunk.length >= 1 && hasSpeakableText(chunk)) {
                        segments.push({
                            id: 'seg_pdf_' + segments.length,
                            index: segments.length,
                            text: chunk,
                            format: 'pdf',
                            page: p
                        })
                        totalChars += chunk.length
                    }
                }
            }
            this.segments = segments
            this._segmentOwner = {
                bookId: activeBookId,
                startPage: firstPage,
                endPage,
                format: 'pdf'
            }
            return segments
        }

        this.segments = segments
        return segments
    }

    /**
     * Start playing from the given or first segment
     */
    async play(startIndex = null) {
        this.cancelPreview()
        const app = this.readerApp || (typeof window !== 'undefined' ? window.app : null)
        const activeBookId = app?.currentBookId || app?.currentBookData?.id || null
        if (this.sessionBookOwner?.bookId && activeBookId && this.sessionBookOwner.bookId !== activeBookId) {
            this.stop(true)
            this._invalidateSegments()
        }

        if (this.state === 'paused' && (startIndex === null || startIndex === this.currentIndex)) {
            if (this._areSegmentsValid(app, startIndex)) {
                this.resume()
                return
            }
            this.stop(true)
        }

        if (!this._areSegmentsValid(app, startIndex)) {
            this._invalidateSegments()
        }

        this.lastError = null
        this._stopRequested = false
        const myGen = ++this.generation
        if (this.abortController) {
            this.abortController.abort()
        }
        this.abortController = new AbortController()
        if (this._activeLoopPromise) {
            try { await this._activeLoopPromise } catch (_) {}
            if (this.generation !== myGen || this._stopRequested) return
        }

        this.setState('preparing')

        if (this.segments.length === 0) {
            await this.extractSegments()
        }

        const postBookId = app?.currentBookId || app?.currentBookData?.id || null
        if (this.state === 'paused' || this._stopRequested || this.generation !== myGen || postBookId !== activeBookId) {
            return
        }

        if (this.segments.length === 0) {
            this.sessionBookOwner = null
            this._segmentOwner = null
            this.setState('stopped')
            throw new Error(t('tts.error.noReadableText'))
        }

        const target = startIndex !== null ? startIndex : (this.currentIndex >= 0 ? this.currentIndex : 0)
        this.currentIndex = Math.max(0, Math.min(target, this.segments.length - 1))
        this._listenStartTime = null
        const now = Date.now()
        this.sessionBookOwner = {
            bookId: activeBookId,
            bookTitle: app?.currentBookData?.title || t('book.untitled'),
            bookAuthor: app?.currentBookData?.author || app?.currentBookMeta?.author || '',
            startTimestamp: now
        }

        this.updateMediaSessionMetadata()
        if (platformBridge.isAndroid && platformBridge.isTauri && this.provider.name === 'system') {
            await this.playAndroidNativeQueue(myGen)
            return
        }
        this.setState('playing')
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
        if (!this.segments.some(s => String(s?.text || '').trim().length > 0)) {
            this._nativeQueue = null
            this.sessionBookOwner = null
            this.clearHighlight()
            this.setState('stopped')
            const err = makeAndroidTtsError('EMPTY_QUEUE', '')
            this.lastError = { code: err.code, message: err.message, detail: '', timestamp: Date.now() }
            this.readerApp?.showToast?.(err.message, 'warning')
            return
        }
        const queueOwner = { jobId, generation, pendingStartPaused: false }
        this._nativeQueue = queueOwner
        this._lastNativeEventSeq = 0
        this._currentSegmentStartTime = null
        this._listenStartTime = null
        this.setState('preparing')
        this.highlightSegment(this.segments[this.currentIndex])
        try {
            const opts = this.getProviderOptions()
            const res = await platformBridge.startBackgroundTtsQueue(
                owner?.bookTitle || 'Linden Leaf',
                this.segments,
                this.currentIndex,
                this.rate,
                {
                    jobId,
                    generation,
                    bookId: owner?.bookId || '',
                    bookAuthor: owner?.bookAuthor || '',
                    voiceId: opts.voiceId || '',
                    locale: getLocale() || 'zh-CN'
                }
            )
            if (this.generation !== generation || this._nativeQueue?.jobId !== jobId) {
                await platformBridge.stopBackgroundTts({ jobId }).catch(() => {})
                return
            }
            if (!res?.started && res !== true) {
                throw makeAndroidTtsError(res?.errorCode || 'TTS_INIT_FAILED', res?.error || '')
            }
            // A pause sent before native accepted the queue may have found no job.
            // Reconcile the user's latest intent once that exact owner is accepted.
            if (queueOwner.pendingStartPaused) await platformBridge.pauseBackgroundTts({ jobId })
            delete queueOwner.pendingStartPaused
        } catch (e) {
            if (this.generation === generation && this._nativeQueue?.jobId === jobId) {
                platformBridge.stopBackgroundTts({ jobId }).catch(() => {})
                const code = e?.code || 'TTS_INIT_FAILED'
                const msg = formatAndroidTtsError(code, e?.message)
                this.lastError = { code, message: msg, detail: String(e?.message || ''), timestamp: Date.now() }
                this._nativeQueue = null
                this.sessionBookOwner = null
                this.clearHighlight()
                this.setState('stopped')
                this.readerApp?.showToast?.(msg, 'warning')
                this.notifyStateChange()
            }
        }
    }

    /**
     * Core playback loop with lookahead pre-buffering and cancellation check
     */
    async playbackLoop(gen) {
        this._loopRunning = true
        const loopOwner = this.sessionBookOwner
        let finishedCleanly = false
        let resolveLoopExit = null
        const loopPromise = new Promise(resolve => { resolveLoopExit = resolve })
        this._activeLoopPromise = loopPromise
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
                    if (this.generation !== gen || this._stopRequested) break
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
                    this.readerApp?.showToast?.(t('tts.toast.pausedWithError', { detail: err.message }), 'warning')
                    break
                }

                if (this.state !== 'playing' || this._stopRequested || this.generation !== gen) break

                this.currentIndex++

                if (this.currentIndex >= this.segments.length &&
                    this._segmentOwner?.format === 'pdf' &&
                    this.sleepTimerDurationMinutes !== 'end_of_chapter') {
                    const vp = this.readerApp?.pdfViewport
                    const numPages = vp?.numPages ?? this.readerApp?.pdfDriver?.numPages ?? 0
                    let nextPage = (this._segmentOwner.endPage ?? -1) + 1
                    while (nextPage < numPages && !this._stopRequested && this.generation === gen && this.state === 'playing') {
                        vp?.goToPage?.(nextPage)
                        const nextSegs = await this.extractSegments({ startPage: nextPage })
                        if (this._stopRequested || this.generation !== gen || this.state !== 'playing') break
                        if (nextSegs.length > 0) {
                            this.currentIndex = 0
                            break
                        }
                        nextPage = (this._segmentOwner?.endPage ?? nextPage) + 1
                    }
                }

                // Check sleep timer end-of-chapter condition
                if (this.sleepTimerDurationMinutes === 'end_of_chapter' && this.currentIndex >= this.segments.length) {
                    finishedCleanly = true
                    this.clearHighlight()
                    this.flushListeningSession(false, loopOwner)
                    this.setSleepTimer(0)
                    this._invalidateSegments()
                    this.setState('stopped')
                    this.readerApp?.showToast?.(t('tts.toast.chapterDoneTimerStopped'), 'info')
                    return
                }
            }
        } finally {
            if (this._activeLoopPromise === loopPromise) {
                this._activeLoopPromise = null
            }
            resolveLoopExit?.()
            if (this.generation === gen) {
                this._loopRunning = false
                if (this.state !== 'paused') {
                    this.clearHighlight()
                }
                const keepOnPause = this.state === 'paused' && !finishedCleanly
                this.flushListeningSession(keepOnPause, loopOwner)
                if (!finishedCleanly && this.currentIndex >= this.segments.length && !this._stopRequested) {
                    this._invalidateSegments()
                    this.sessionBookOwner = null
                    this.setState('stopped')
                    this.readerApp?.showToast?.(t('tts.toast.chapterDone'), 'info')
                }
            }
        }
    }

    highlightSegment(segment) {
        this.clearHighlight()
        if (!segment) return
        if (segment.format === 'pdf' && segment.page != null) {
            const vp = this.readerApp?.pdfViewport
            if (vp && vp.currentPage !== segment.page) {
                vp.goToPage?.(segment.page)
            }
            return
        }
        if (!segment.element) return

        try {
            segment.element.classList.add('tts-active-reading-segment')
            this.activeHighlightEl = segment.element
            const renderer = this.readerApp?.foliateView?.renderer
            if (typeof renderer?.scrollToAnchor === 'function' && segment.element.isConnected) {
                Promise.resolve(renderer.scrollToAnchor(segment.element)).catch(() => {
                    try { segment.element.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) {}
                })
            } else {
                segment.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
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
                const bookTitle = owner?.bookTitle || t('book.untitled')
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
            if (Object.hasOwn(this._nativeQueue, 'pendingStartPaused')) this._nativeQueue.pendingStartPaused = true
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
        const app = this.readerApp || (typeof window !== 'undefined' ? window.app : null)
        if (this.state === 'stopped' || this.state === 'idle') {
            if (notifyProvider && (app?.currentBookId || app?.currentBookData?.id || this.segments.length > 0)) {
                this.play().catch(e => {
                    this.readerApp?.showToast?.(e?.message || String(e), 'warning')
                })
            }
            return
        }
        if (this.state !== 'paused') return
        const activeBookId = app?.currentBookId || app?.currentBookData?.id || null
        if (this.sessionBookOwner?.bookId && activeBookId && this.sessionBookOwner.bookId !== activeBookId) {
            this.stop(true)
            return
        }
        if (this._nativeQueue) {
            const owner = this._nativeQueue
            const starting = Object.hasOwn(owner, 'pendingStartPaused')
            if (starting) owner.pendingStartPaused = false
            this.setState('preparing')
            if (notifyProvider) platformBridge.resumeBackgroundTts({ jobId: owner.jobId }).then(started => {
                if (!started && !starting && this._nativeQueue === owner) {
                    const index = this.currentIndex >= 0 ? this.currentIndex : 0
                    this.stop(false)
                    this.play(index).catch(e => this.readerApp?.showToast?.(formatAndroidTtsError(e?.code, e?.message), 'warning'))
                }
            }).catch((e) => {
                if (this._nativeQueue === owner) {
                    const code = e?.code || 'BRIDGE_CALL_FAILED'
                    const msg = formatAndroidTtsError(code, e?.message)
                    this.lastError = { code, message: msg, detail: String(e?.message || ''), timestamp: Date.now() }
                    this._nativeQueue = null
                    this.sessionBookOwner = null
                    this.clearHighlight()
                    this.setState('stopped')
                    this.readerApp?.showToast?.(msg, 'warning')
                }
            })
            return
        }
        const now = Date.now()
        if (!this.sessionBookOwner) {
            this.sessionBookOwner = { bookId: app?.currentBookId || app?.currentBookData?.id || null, bookTitle: app?.currentBookData?.title || t('book.untitled'), bookAuthor: app?.currentBookData?.author || app?.currentBookMeta?.author || '', startTimestamp: now }
        }
        this._currentSegmentStartTime = now
        this.setState('playing')
        if (this._loopRunning) {
            if (notifyProvider) this.provider.resume()
        } else {
            if (notifyProvider) this.provider.stop()
            this._stopRequested = false
            if (this.currentIndex < 0) this.currentIndex = 0
            if (!this.segments.length) {
                this.play(0).catch(e => this.readerApp?.showToast?.(e?.message || String(e), 'warning'))
                return
            }
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
        if (resetIndex) {
            this._invalidateSegments()
            this.sessionBookOwner = null
        }
    }

    next() {
        if (platformBridge.isAndroid && platformBridge.isTauri && this.provider.name === 'system') {
            if (this._nativeQueue) {
                platformBridge.nextBackgroundTts().catch(() => {})
            }
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
            if (this._nativeQueue) {
                platformBridge.prevBackgroundTts().catch(() => {})
            }
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

    async preview(text = t('tts.previewSample')) {
        this.stop()
        this.cancelPreview()
        const controller = new AbortController()
        const provider = this.currentProviderName === 'api' ? new ApiTtsProvider() : this.currentProviderName === 'offline' ? new OfflineTtsProvider() : new SystemTtsProvider()
        this._previewController = controller
        this._previewProvider = provider
        try { await provider.play({ id: 'preview', text }, { ...this.getProviderOptions(), signal: controller.signal }) }
        catch (error) {
            if (platformBridge.isAndroid && error?.name !== 'AbortError') {
                this.lastError = {
                    code: error?.code || 'PLAYBACK_FAILED',
                    message: error?.message || t('tts.error.androidFailed'),
                    detail: String(error?.rawDetail || error?.message || ''),
                    timestamp: Date.now()
                }
            }
            throw error
        }
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
                this.readerApp?.showToast?.(t('tts.toast.sleepReached'), 'info')
            }
        }, 1000)
    }

    async syncNativeListening() {
        if (!platformBridge.isAndroid || !platformBridge.isTauri) return null
        this._nativeSyncRequested = true
        if (this._nativeSync) return this._nativeSync
        this._nativeSync = (async () => {
            let snapshot
            let through = 0
            try {
                do {
                    this._nativeSyncRequested = false
                    snapshot = await platformBridge.getBackgroundPlaybackState()
                    const intervals = [...(snapshot?.listeningIntervals || [])].sort((a, b) => a.sequence - b.sequence)
                    for (const interval of intervals) {
                        const seq = Number(interval.sequence) || 0
                        let start = Number(interval.startMs)
                        const end = Number(interval.endMs)
                        if (!interval.bookId || !(end > start)) {
                            if (seq > through) through = seq
                            continue
                        }
                        let part = 0
                        while (start < end) {
                            const date = new Date(start)
                            const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
                            const until = Math.min(end, midnight)
                            const dateKey = typeof db?.toLocalDateKey === 'function'
                                ? db.toLocalDateKey(date)
                                : date.toLocaleDateString('en-CA')
                            const author = interval.bookAuthor || (window.app?.currentBookData?.id === interval.bookId ? window.app?.currentBookData?.author : '') || window.app?.currentBookMeta?.author || ''
                            await db.recordReadingSession({
                                id: `android_tts_${interval.jobId}_${interval.sequence}_${part++}`,
                                bookId: interval.bookId, bookTitle: interval.bookTitle, bookAuthor: author,
                                startTime: start, endTime: until, durationSeconds: (until - start) / 1000,
                                activeIntervals: [[start, until]], kind: 'listen', isListening: true, date: dateKey
                            })
                            start = until
                        }
                        if (seq > through) through = seq
                    }
                    if (through > 0) {
                        await platformBridge.acknowledgeTtsListening(through)
                        through = 0
                    }
                } while (this._nativeSyncRequested)
            } finally {
                if (through > 0) {
                    await platformBridge.acknowledgeTtsListening(through).catch(() => {})
                }
            }
            return snapshot
        })().finally(() => { this._nativeSync = null })
        return this._nativeSync
    }

    async reattachNativePlayback() {
        if (!platformBridge.isAndroid || !platformBridge.isTauri) return null
        const snapshot = await this.syncNativeListening()
        if (!snapshot || !snapshot.jobId || !['playing', 'paused', 'preparing'].includes(snapshot.state)) {
            return snapshot
        }
        const app = this.readerApp
        const activeBookId = app?.currentBookId || app?.currentBookData?.id || ''
        if (snapshot.bookId && activeBookId && snapshot.bookId !== activeBookId) {
            return snapshot
        }
        if (this._nativeQueue?.jobId === snapshot.jobId) {
            if (Number.isInteger(snapshot.queueIndex) && snapshot.queueIndex >= 0) {
                this.currentIndex = snapshot.queueIndex
            }
            this.setState(snapshot.state)
            return snapshot
        }
        const gen = Math.max(this.generation + 1, Number(snapshot.generation) || 1)
        this.generation = gen
        this._nativeQueue = { jobId: snapshot.jobId, generation: Number(snapshot.generation) || 0 }
        this._lastNativeEventSeq = Number(snapshot.eventSeq) || 0
        this.sessionBookOwner = {
            bookId: snapshot.bookId || activeBookId || null,
            bookTitle: snapshot.bookTitle || app?.currentBookData?.title || t('book.untitled'),
            bookAuthor: snapshot.bookAuthor || app?.currentBookData?.author || app?.currentBookMeta?.author || '',
            startTimestamp: Date.now()
        }
        if (this.segments.length === 0 && app) {
            await this.extractSegments().catch(() => [])
        }
        if (Number.isInteger(snapshot.queueIndex) && snapshot.queueIndex >= 0) {
            this.currentIndex = this.segments.length > 0
                ? Math.min(snapshot.queueIndex, this.segments.length - 1)
                : snapshot.queueIndex
        }
        this.setState(snapshot.state)
        if (this.segments[this.currentIndex]) {
            this.highlightSegment(this.segments[this.currentIndex])
        }
        return snapshot
    }

    async _advancePdfNativeQueueAfterCompletion(owner) {
        const vp = this.readerApp?.pdfViewport
        const numPages = vp?.numPages ?? this.readerApp?.pdfDriver?.numPages ?? 0
        let nextPage = (this._segmentOwner?.endPage ?? -1) + 1
        while (nextPage < numPages && !this._stopRequested) {
            vp?.goToPage?.(nextPage)
            const nextSegs = await this.extractSegments({ startPage: nextPage })
            if (this._stopRequested) return
            if (nextSegs.length > 0) {
                await this.play(0)
                return
            }
            nextPage = (this._segmentOwner?.endPage ?? nextPage) + 1
        }
        this.sessionBookOwner = null
        this._invalidateSegments()
        this.setState('stopped')
        this.readerApp?.showToast?.(t('tts.toast.chapterShortDone'), 'info')
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
            if (!document.hidden && data.type !== 'playbackerror' && data.type !== 'playbackstopped' && data.type !== 'playbackcompleted') {
                this.highlightSegment(this.segments[index])
            }
            this.notifyStateChange()
        }
        switch (data.type) {
            case 'playbackstarted':
                if (owner.pendingStartPaused) break
                this.lastError = null
                this.setState('playing')
                if (!document.hidden) this.highlightSegment(this.segments[this.currentIndex])
                break
            case 'playbackpreparing':
                if (owner.pendingStartPaused) break
                this.setState('preparing')
                break
            case 'playbackpaused':
                this.setState('paused')
                break
            case 'playbackcompleted': {
                this._nativeQueue = null
                this.sleepTimerDurationMinutes = 0
                this.sleepTimerRemainingSeconds = 0
                this.clearHighlight()
                const vp = this.readerApp?.pdfViewport
                const numPages = vp?.numPages ?? this.readerApp?.pdfDriver?.numPages ?? 0
                if (this._segmentOwner?.format === 'pdf' &&
                    this._segmentOwner.endPage + 1 < numPages &&
                    !this._stopRequested) {
                    this._advancePdfNativeQueueAfterCompletion(owner).catch(e => {
                        this.sessionBookOwner = null
                        this._invalidateSegments()
                        this.setState('stopped')
                        this.readerApp?.showToast?.(e?.message || String(e), 'warning')
                    })
                    break
                }
                this.sessionBookOwner = null
                this._invalidateSegments()
                this.setState('stopped')
                this.readerApp?.showToast?.(t('tts.toast.chapterShortDone'), 'info')
                break
            }
            case 'playbackstopped':
                this._nativeQueue = null
                this.sessionBookOwner = null
                this.sleepTimerDurationMinutes = 0
                this.sleepTimerRemainingSeconds = 0
                this._invalidateSegments()
                this.clearHighlight()
                this.setState('stopped')
                break
            case 'playbackerror': {
                const code = data.errorCode || 'PLAYBACK_FAILED'
                const msg = formatAndroidTtsError(code, data.error)
                this.lastError = { code, message: msg, detail: String(data.error || ''), timestamp: Date.now() }
                this._nativeQueue = null
                this.sessionBookOwner = null
                this._invalidateSegments()
                this.clearHighlight()
                this.setState('stopped')
                this.readerApp?.showToast?.(msg, 'warning')
                break
            }
        }
    }

    async getAndroidDiagnostics() {
        return await platformBridge.getAndroidTtsDiagnostics()
    }

    async openAndroidTtsSettings() {
        const res = await platformBridge.openAndroidTtsSettings()
        if (!res?.opened) {
            this.readerApp?.showToast?.(t('tts.android.openSettingsFailed', { detail: res?.error || 'unavailable' }), 'warning')
        }
        return res
    }

    async installAndroidTtsVoiceData() {
        const res = await platformBridge.installAndroidTtsVoiceData()
        if (!res?.opened) {
            this.readerApp?.showToast?.(t('tts.android.installVoiceFailed'), 'warning')
        }
        return res
    }

    initMediaSession() {
        if (typeof navigator === 'undefined' || !navigator.mediaSession) return
        if (platformBridge.isAndroid && platformBridge.isTauri && this.currentProviderName === 'system') {
            try {
                for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack']) {
                    navigator.mediaSession.setActionHandler(action, null)
                }
                navigator.mediaSession.metadata = null
            } catch (_) {}
            return
        }
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
        if (platformBridge.isAndroid && platformBridge.isTauri && this.currentProviderName === 'system') return
        const bookData = this.readerApp?.currentBookData || {}
        navigator.mediaSession.metadata = new window.MediaMetadata({
            title: bookData.title || t('tts.mediaTitleFallback'),
            artist: bookData.author || t('book.unknownAuthor'),
            album: this.readerApp?.currentLocation?.tocItem?.label || t('tts.mediaAlbumFallback')
        })
    }
}

export const ttsPlayer = new TtsPlayer()
if (typeof window !== 'undefined') window.ttsPlayer = ttsPlayer
