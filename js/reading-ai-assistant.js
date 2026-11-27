import { migrateLegacyAiOutputLimit } from './ai-output-budget.js'
import { platformBridge } from './platformBridge.js'
import { runWithAiAdmission } from './ai-request-scheduler.js'
import { BUILTIN_PROMPTS } from './ai-presets.js'
import { escapeHTML } from './ui-format.js'
import { getLocale, t } from './i18n.js'

const LOCAL_STORAGE_KEY_AI_CONFIG = 'linden_ai_assistant_config'
const LOCAL_STORAGE_KEY_AI_KEY = 'linden_ai_api_key'

let _cachedAiApiKey = null

export const DEFAULT_AI_CONFIG = {
    enabled: false,
    authMode: 'api', // 'api' | 'siwc'
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    siwcModel: 'gpt-5-codex',
    cooldownSeconds: 10,
    dailyLimit: 100,
    maxTokens: 20000
}

// Concise, generic default prompts matching user specifications
export const SYSTEM_PROMPTS = {
    get translate() { return BUILTIN_PROMPTS?.translate || t('aiPreset.promptTranslate') },
    get explain() { return BUILTIN_PROMPTS?.explain || t('aiPreset.promptExplain') },
    get qa() { return t('aiAssistant.prompt.qa') }
}

// In-memory fallback guards for non-Tauri / test environments
let _mockLastChatDispatched = 0
let _mockActiveRequestId = null
let _mockTodayCount = 0
let _mockDailyDate = ''

/**
 * Validates endpoint URL strictly rejecting malicious non-numeric domains masquerading as private IPs
 * @param {string} url
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateEndpointUrl(url) {
    if (!url || typeof url !== 'string') return { valid: false, error: t('aiAssistant.error.endpointEmpty') }
    const trimmed = url.trim()
    try {
        const parsed = new URL(trimmed)
        if (parsed.username || parsed.password) {
            return { valid: false, error: t('aiAssistant.error.endpointCredentials') }
        }
        if (parsed.protocol === 'https:') return { valid: true }
        if (parsed.protocol === 'http:') {
            const host = parsed.hostname.toLowerCase()
            if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
                return { valid: true }
            }
            // Strict numeric IPv4 check
            const isPrivateIpv4 = (ip) => {
                const parts = ip.split('.')
                if (parts.length !== 4) return false
                const nums = parts.map(p => Number(p))
                if (nums.some((n, idx) => isNaN(n) || n < 0 || n > 255 || String(n) !== parts[idx])) return false
                if (nums[0] === 10) return true
                if (nums[0] === 192 && nums[1] === 168) return true
                if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return true
                if (nums[0] === 127) return true
                return false
            }
            if (isPrivateIpv4(host)) {
                return { valid: true }
            }
            return { valid: false, error: t('aiAssistant.error.httpsRequired') }
        }
        return { valid: false, error: t('aiAssistant.error.httpOnly') }
    } catch (e) {
        return { valid: false, error: t('aiAssistant.error.endpointInvalid') }
    }
}

/**
 * Get stored AI configuration (excluding API key)
 */
export function getAiConfig() {
    migrateLegacyAiOutputLimit()
    try {
        let advCooldown = 10
        let advDaily = 0
        const advRaw = localStorage.getItem('linden_advanced_settings_config')
        if (advRaw) {
            const adv = JSON.parse(advRaw)
            if (typeof adv.aiCooldownSeconds === 'number') advCooldown = adv.aiCooldownSeconds
            if (typeof adv.aiDailyLimit === 'number') advDaily = adv.aiDailyLimit
        }
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY_AI_CONFIG)
        if (raw) {
            const parsed = JSON.parse(raw)
            return {
                ...DEFAULT_AI_CONFIG,
                ...parsed,
                cooldownSeconds: advRaw ? advCooldown : (parsed.cooldownSeconds ?? 10),
                dailyLimit: advRaw ? advDaily : (parsed.dailyLimit ?? 100)
            }
        }
        return {
            ...DEFAULT_AI_CONFIG,
            cooldownSeconds: advCooldown,
            dailyLimit: advDaily
        }
    } catch (e) {}
    return { ...DEFAULT_AI_CONFIG }
}

/**
 * Save AI configuration with DPAPI secure credential storage & origin binding
 * @param {object} cfg
 */
export async function saveAiConfig(cfg = {}) {
    const existing = getAiConfig()
    const merged = { ...existing }

    if (cfg.enabled !== undefined) {
        merged.enabled = Boolean(cfg.enabled)
    }
    if (cfg.authMode === 'api' || cfg.authMode === 'siwc') {
        merged.authMode = cfg.authMode
    }
    if (cfg.siwcModel !== undefined) {
        const cleanSiwcModel = String(cfg.siwcModel || '').trim()
        if (cleanSiwcModel) merged.siwcModel = cleanSiwcModel
    }
    if (cfg.endpoint !== undefined) {
        const val = validateEndpointUrl(cfg.endpoint)
        if (!val.valid) {
            throw new Error(val.error || t('aiAssistant.error.endpointInvalid'))
        }
        merged.endpoint = cfg.endpoint.trim().replace(/\/+$/, '')
    }
    if (cfg.model !== undefined) {
        const cleanModel = cfg.model.trim()
        if (cleanModel) {
            merged.model = cleanModel
        }
    }
    if (typeof cfg.cooldownSeconds === 'number') {
        merged.cooldownSeconds = Math.max(0, Math.min(3600, cfg.cooldownSeconds))
        try {
            const advRaw = localStorage.getItem('linden_advanced_settings_config') || '{}'
            const adv = JSON.parse(advRaw)
            adv.aiCooldownSeconds = merged.cooldownSeconds
            localStorage.setItem('linden_advanced_settings_config', JSON.stringify(adv))
        } catch (_) {}
    }
    if (typeof cfg.dailyLimit === 'number') {
        merged.dailyLimit = Math.max(0, cfg.dailyLimit)
        try {
            const advRaw = localStorage.getItem('linden_advanced_settings_config') || '{}'
            const adv = JSON.parse(advRaw)
            adv.aiDailyLimit = merged.dailyLimit
            localStorage.setItem('linden_advanced_settings_config', JSON.stringify(adv))
        } catch (_) {}
    }
    if (typeof cfg.maxTokens === 'number') {
        merged.maxTokens = Math.max(64, Math.min(20000, cfg.maxTokens))
    }

    if (cfg.apiKey !== undefined) {
        const cleanKey = (cfg.apiKey || '').trim()
        if (cleanKey) {
            const stored = await platformBridge.secureStoreCredential('reading_ai_api_key', cleanKey)
            if (!stored) {
                throw new Error(t('aiAssistant.error.credentialStoreUnavailable'))
            }
            _cachedAiApiKey = cleanKey

            // Bind credential to endpoint origin in native layer
            if (globalThis.__TAURI__?.core?.invoke && merged.endpoint) {
                try {
                    await globalThis.__TAURI__.core.invoke('ai_bind_credential', {
                        endpoint: merged.endpoint,
                        apiKey: cleanKey,
                        locale: getLocale()
                    })
                } catch (e) {
                    console.warn('[AI Assistant] Native origin binding warning:', e)
                }
            }

            // Only sanitize legacy plaintext key from localStorage after confirmed secure store!
            try { localStorage.removeItem(LOCAL_STORAGE_KEY_AI_KEY) } catch (_) {}
        } else {
            await platformBridge.secureDeleteCredential('reading_ai_api_key')
            _cachedAiApiKey = ''
            try { localStorage.removeItem(LOCAL_STORAGE_KEY_AI_KEY) } catch (_) {}
            if (globalThis.__TAURI__?.core?.invoke) {
                try {
                    await globalThis.__TAURI__.core.invoke('ai_bind_credential', {
                        endpoint: merged.endpoint || 'https://api.openai.com/v1',
                        apiKey: '',
                        locale: getLocale()
                    })
                } catch (_) {}
            }
        }
    }

    // Sync cooldown & limit with native backend
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            await globalThis.__TAURI__.core.invoke('ai_set_cooldown_and_limit', {
                cooldownSeconds: merged.cooldownSeconds,
                dailyLimit: merged.dailyLimit
            })
        } catch (_) {}
    }

    localStorage.setItem(LOCAL_STORAGE_KEY_AI_CONFIG, JSON.stringify(merged))
    return merged
}

/**
 * Get stored API key securely using DPAPI / Keychain with automatic migration from localStorage
 * @returns {Promise<string>}
 */
export async function getAiApiKey() {
    if (_cachedAiApiKey !== null) return _cachedAiApiKey

    try {
        const secKey = await platformBridge.secureLoadCredential('reading_ai_api_key')
        if (secKey) {
            _cachedAiApiKey = secKey.trim()
            return _cachedAiApiKey
        }
    } catch (e) {
        console.warn('[AI Assistant] Failed to load secure credential:', e)
    }

    // Legacy migration check
    const legacyKey = (localStorage.getItem(LOCAL_STORAGE_KEY_AI_KEY) || '').trim()
    if (legacyKey) {
        try {
            const stored = await platformBridge.secureStoreCredential('reading_ai_api_key', legacyKey)
            if (stored) {
                localStorage.removeItem(LOCAL_STORAGE_KEY_AI_KEY)
            }
        } catch (e) {
            console.warn('[AI Assistant] Secure store migration failed, preserving legacy key:', e)
        }
        _cachedAiApiKey = legacyKey
        return legacyKey
    }

    _cachedAiApiKey = ''
    return ''
}

export function getAiApiKeySync() {
    return _cachedAiApiKey || (localStorage.getItem(LOCAL_STORAGE_KEY_AI_KEY) || '').trim()
}

/**
 * Queries official Sign in with ChatGPT authorization status (via native Rust keychain/DPAPI)
 */
export async function getSiwcStatus() {
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            return await globalThis.__TAURI__.core.invoke('siwc_get_status')
        } catch (e) {
            return { signedIn: false, hasDirectScope: false, error: e?.message || String(e) }
        }
    }
    return { signedIn: false, hasDirectScope: false, error: 'Desktop Tauri required' }
}

export async function startSiwcSignIn(sessionId = `siwc_${Date.now()}`) {
    if (!globalThis.__TAURI__?.core?.invoke) {
        throw new Error(t('aiAssistant.error.credentialStoreUnavailable'))
    }
    return globalThis.__TAURI__.core.invoke('siwc_start_sign_in', {
        sessionId,
        locale: getLocale()
    })
}

export async function cancelSiwcSignIn(sessionId) {
    if (!globalThis.__TAURI__?.core?.invoke || !sessionId) return false
    return globalThis.__TAURI__.core.invoke('siwc_cancel_sign_in', { sessionId }).catch(() => false)
}

export async function signOutSiwc() {
    if (!globalThis.__TAURI__?.core?.invoke) return { signedIn: false, hasDirectScope: false }
    return globalThis.__TAURI__.core.invoke('siwc_sign_out')
}

/**
 * Checks whether AI service is configured and ready
 */
export async function isAiReady() {
    const cfg = getAiConfig()
    if (cfg.authMode === 'siwc') {
        if (!cfg.enabled) return false
        const status = await getSiwcStatus()
        return Boolean(status?.signedIn && status?.hasDirectScope)
    }
    const key = await getAiApiKey()
    return Boolean(cfg.enabled && key && cfg.endpoint && cfg.model)
}

/**
 * Safely escape HTML to prevent script injection in AI output
 */
export const escapeUntrustedHtml = escapeHTML

/**
 * Render basic safe markdown formatting (bold, italic, code blocks, lists) without allowing raw HTML
 */
export function renderSafeMarkdown(markdownText) {
    const lines = String(markdownText ?? '').replace(/\r\n?/g, '\n').split('\n')
    const inline = text => {
        const code = []
        const escaped = escapeUntrustedHtml(text).replace(/`([^`]+)`/g, (_, value) => {
            code.push(`<code>${value}</code>`)
            return `\u0000${code.length - 1}\u0000`
        })
        return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)] || '')
    }
    const out = []
    let paragraph = [], list = null, fence = false, codeLines = []
    const flushParagraph = () => { if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br/>')}</p>`); paragraph = [] }
    const closeList = () => { if (list) out.push(`</${list}>`); list = null }
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            flushParagraph(); closeList()
            if (fence) { out.push(`<pre><code>${escapeUntrustedHtml(codeLines.join('\n'))}</code></pre>`); codeLines = [] }
            fence = !fence
            continue
        }
        if (fence) { codeLines.push(line); continue }
        if (!line.trim()) { flushParagraph(); closeList(); continue }
        const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
        const item = line.match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/)
        const quote = line.match(/^\s*>\s?(.*)$/)
        if (heading) {
            flushParagraph(); closeList()
            const level = Math.min(heading[1].length + 1, 6)
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
        } else if (item) {
            flushParagraph()
            const type = item[1] ? 'ul' : 'ol'
            if (list !== type) { closeList(); list = type; out.push(`<${list}>`) }
            out.push(`<li>${inline(item[2])}</li>`)
        } else if (quote) {
            flushParagraph(); closeList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
        } else { closeList(); paragraph.push(line) }
    }
    flushParagraph(); closeList()
    if (fence) out.push(`<pre><code>${escapeUntrustedHtml(codeLines.join('\n'))}</code></pre>`)
    return out.join('')
}

/**
 * Legacy prompt helpers for backward compatibility
 */
export function createTranslationPrompt(selectedText) {
    return t('aiAssistant.legacyTranslateWrap', { text: (selectedText || '').trim(), prompt: SYSTEM_PROMPTS.translate })
}

export function createExplainPrompt(selectedText) {
    return t('aiAssistant.legacyExplainWrap', { text: (selectedText || '').trim() })
}

export function createQuestionPrompt(selectedText, question) {
    return t('aiAssistant.legacyQuestionWrap', { text: (selectedText || '').trim(), question: (question || '').trim() })
}


/**
 * Queries native cooldown and in-flight request status
 * @returns {Promise<{ isBusy: boolean, remainingCooldownSeconds: number, todayCount: number, dailyLimit: number }>}
 */
export async function getAiStatus({ requireNative = false, purpose = 'chat' } = {}) {
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            const res = await globalThis.__TAURI__.core.invoke('ai_get_status', { purpose })
            return {
                isBusy: Boolean(res.isBusy),
                activeRequestId: res.activeRequestId || null,
                remainingCooldownSeconds: res.remainingCooldownSeconds ?? 0,
                remainingCooldownMs: res.remainingCooldownMs,
                todayCount: res.todayCount ?? 0,
                dailyLimit: res.dailyLimit ?? 100
            }
        } catch (e) {
            console.warn('[AI Assistant] Failed to get native status:', e)
            if (requireNative) throw new Error(t('aiAssistant.error.statusUnavailable'))
        }
    }

    // In-memory fallback
    const cfg = getAiConfig()
    const now = Date.now()
    const elapsedSecs = Math.floor((now - _mockLastChatDispatched) / 1000)
    const cd = purpose === 'chapterTranslation' ? 0 : (cfg.cooldownSeconds ?? 10)
    const rem = elapsedSecs < cd ? cd - elapsedSecs : 0

    return {
        isBusy: Boolean(_mockActiveRequestId),
        activeRequestId: _mockActiveRequestId,
        remainingCooldownSeconds: rem,
        todayCount: _mockTodayCount,
        dailyLimit: cfg.dailyLimit ?? 100
    }
}

/**
 * Aborts an active in-flight request via native layer or fallback
 * @param {string} [requestId]
 */
export async function abortAiRequest(requestId) {
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            return await globalThis.__TAURI__.core.invoke('ai_abort_request', {
                requestId: requestId || null
            })
        } catch (e) {
            console.warn('[AI Assistant] Native abort error:', e)
        }
    }
    _mockActiveRequestId = null
    return true
}

/**
 * Fetch local audit log from native layer
 * @param {number} [limit=100]
 */
export async function getAiAuditLog(limit = 100) {
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            return await globalThis.__TAURI__.core.invoke('ai_get_audit_log', { limit })
        } catch (e) {
            console.warn('[AI Assistant] Failed to get audit log:', e)
        }
    }
    return []
}

/**
 * Clear local audit log
 */
export async function clearAiAuditLog() {
    if (globalThis.__TAURI__?.core?.invoke) {
        try {
            return await globalThis.__TAURI__.core.invoke('ai_clear_audit_log')
        } catch (e) {
            console.warn('[AI Assistant] Failed to clear audit log:', e)
        }
    }
    return true
}

/**
 * Dispatches an AI chat completion request through the Native Rust request layer with:
 * - User-configured interval for reader questions; continuous chapter tasks are exempt
 * - Concurrency limit (max 1 in-flight per application)
 * - Atomic deduplication
 * - Max output tokens limit
 * - Daily quota enforcement
 * - SSE streaming via native events
 * - Stop / cancel support
 *
 * @param {object} params
 * @param {string} [params.requestId]
 * @param {'chat'|'chapterTranslation'} [params.purpose='chat'] Local scheduling intent
 * @param {string} [params.endpoint]
 * @param {string} [params.model]
 * @param {string} [params.apiKey]
 * @param {string} [params.prompt]
 * @param {string} [params.systemPrompt]
 * @param {Array<{role: string, content: string}>} [params.messages]
 * @param {number} [params.maxTokens]
 * @param {boolean} [params.returnMetadata] Return text with provider stop reason when requested.
 * @param {AbortSignal} [params.signal]
 * @param {function(string, string): void} [params.onChunk] (delta, fullText)
 * @returns {Promise<string>}
 */
export async function requestAiCompletion({
    requestId,
    requestScope,
    purpose = 'chat',
    endpoint,
    model,
    apiKey,
    prompt,
    systemPrompt,
    messages,
    maxTokens,
    returnMetadata = false,
    queueIfBusy = false,
    beforeDispatch,
    onWait,
    onChunk,
    signal
}) {
    if (signal?.aborted) {
        const abortErr = new Error('AI request was aborted before start')
        abortErr.name = 'AbortError'
        throw abortErr
    }

    const cfg = getAiConfig()
    const targetEndpoint = (endpoint || cfg.endpoint || DEFAULT_AI_CONFIG.endpoint).replace(/\/+$/, '')
    const targetModel = model || cfg.model || DEFAULT_AI_CONFIG.model
    const targetMaxTokens = maxTokens || cfg.maxTokens || DEFAULT_AI_CONFIG.maxTokens || 20000
    const resultValue = (payload, fallbackText = '') => returnMetadata
        ? {
            requestId: reqId,
            fullText: payload?.fullText ?? payload?.partialText ?? fallbackText,
            finishReason: payload?.finishReason ?? null,
            status: payload?.status || (payload?.stopped ? 'cancelled' : 'completed'),
            usage: payload?.usage ?? null
        }
        : (payload?.fullText ?? fallbackText)

    const reqId = requestId || ('req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))

    if (queueIfBusy) {
        return runWithAiAdmission({
            signal, beforeDispatch, onWait,
            getStatus: () => getAiStatus({ requireNative: !!globalThis.__TAURI__?.core?.invoke, purpose }),
            invoke: () => requestAiCompletion({
                requestId: reqId, requestScope, purpose, endpoint, model, apiKey,
                prompt, systemPrompt, messages, maxTokens: targetMaxTokens,
                returnMetadata, onChunk, signal
            })
        })
    }

    let chatMessages = messages
    if (!chatMessages) {
        chatMessages = []
        if (systemPrompt && systemPrompt.trim()) {
            chatMessages.push({ role: 'system', content: systemPrompt.trim() })
        }
        if (prompt) {
            chatMessages.push({ role: 'user', content: prompt })
        }
    }

    // 1. Native Tauri Implementation
    if (globalThis.__TAURI__?.core?.invoke && globalThis.__TAURI__?.event?.listen) {
        let unlistenChunk = null
        let unlistenDone = null
        let unlistenStopped = null
        let unlistenError = null
        let abortHandler = null

        const cleanupListeners = () => {
            if (abortHandler) { signal?.removeEventListener('abort', abortHandler); abortHandler = null }
            if (unlistenChunk) { unlistenChunk(); unlistenChunk = null }
            if (unlistenDone) { unlistenDone(); unlistenDone = null }
            if (unlistenStopped) { unlistenStopped(); unlistenStopped = null }
            if (unlistenError) { unlistenError(); unlistenError = null }
        }

        if (signal) {
            if (signal.aborted) {
                abortAiRequest(reqId).catch(() => {})
                const abortErr = new Error('AI request was aborted')
                abortErr.name = 'AbortError'
                return Promise.reject(abortErr)
            }
            abortHandler = () => { abortAiRequest(reqId).catch(() => {}) }
            signal.addEventListener('abort', abortHandler, { once: true })
        }

        return new Promise((resolve, reject) => {
            let fullText = ''
            let settled = false
            const finishResolve = (val) => {
                if (settled) return
                settled = true
                cleanupListeners()
                resolve(val)
            }
            const finishReject = (err) => {
                if (settled) return
                settled = true
                cleanupListeners()
                reject(err instanceof Error ? err : new Error(err?.message || String(err)))
            }

            Promise.all([
                globalThis.__TAURI__.event.listen(`ai:chunk:${reqId}`, (event) => {
                    if (settled) return
                    const delta = event.payload?.delta || ''
                    fullText = event.payload?.fullText || (fullText + delta)
                    if (onChunk) onChunk(delta, fullText)
                }),
                globalThis.__TAURI__.event.listen(`ai:done:${reqId}`, (event) => {
                    finishResolve(resultValue(event.payload, fullText))
                }),
                globalThis.__TAURI__.event.listen(`ai:stopped:${reqId}`, (event) => {
                    finishResolve(resultValue({ fullText: event.payload?.partialText ?? fullText, status: 'cancelled' }, fullText))
                }),
                globalThis.__TAURI__.event.listen(`ai:error:${reqId}`, (event) => {
                    finishReject(new Error(event.payload?.message || t('aiAssistant.error.requestFailed')))
                })
            ]).then(([c, d, s, e]) => {
                unlistenChunk = c
                unlistenDone = d
                unlistenStopped = s
                unlistenError = e

                if (settled) {
                    cleanupListeners()
                    return
                }
                if (signal?.aborted) {
                    finishReject(new DOMException('AI request aborted', 'AbortError'))
                    return
                }

                const useSiwc = cfg.authMode === 'siwc' && !endpoint
                if (useSiwc) {
                    return globalThis.__TAURI__.core.invoke('ai_request_siwc_completion', {
                        payload: {
                            requestId: reqId,
                            requestScope,
                            purpose,
                            model: model || cfg.siwcModel || 'gpt-5-codex',
                            messages: chatMessages,
                            locale: getLocale()
                        }
                    })
                }

                return globalThis.__TAURI__.core.invoke('ai_request_chat_completion', {
                    payload: {
                        requestId: reqId,
                        requestScope,
                        purpose,
                        endpoint: targetEndpoint,
                        model: targetModel,
                        messages: chatMessages,
                        maxTokens: targetMaxTokens,
                        locale: getLocale()
                    }
                })
            }).then((res) => {
                if (settled || !res) return
                if (res.status === 'failed') {
                    finishReject(new Error(res.error || t('aiAssistant.error.requestFailed')))
                    return
                }
                finishResolve(resultValue(res, fullText))
            }).catch((err) => {
                finishReject(err)
            })
        })
    }

    // 2. Fallback for non-Tauri / mock test environment
    const now = Date.now()
    const cooldown = purpose === 'chapterTranslation' ? 0 : (cfg.cooldownSeconds ?? 10) * 1000

    if (_mockActiveRequestId) {
        throw new Error(t('aiAssistant.error.concurrencyBlocked'))
    }

    if (cooldown > 0 && now - _mockLastChatDispatched < cooldown) {
        const remSecs = Math.ceil((cooldown - (now - _mockLastChatDispatched)) / 1000)
        throw new Error(t('aiAssistant.error.cooldownActive', { seconds: remSecs }))
    }

    const todayStr = new Date().toISOString().slice(0, 10)
    if (_mockDailyDate !== todayStr) {
        _mockDailyDate = todayStr
        _mockTodayCount = 0
    }
    const limit = cfg.dailyLimit ?? 100
    if (limit > 0 && _mockTodayCount >= limit) {
        throw new Error(t('aiAssistant.error.dailyLimitExceeded', { limit }))
    }

    if (purpose !== 'chapterTranslation') _mockLastChatDispatched = now
    _mockActiveRequestId = reqId
    _mockTodayCount++

    const key = apiKey || (await getAiApiKey())
    if (!key) {
        _mockActiveRequestId = null
        throw new Error(t('aiAssistant.error.missingApiKey'))
    }

    const endpointCheck = validateEndpointUrl(targetEndpoint)
    if (!endpointCheck.valid) {
        _mockActiveRequestId = null
        throw new Error(endpointCheck.error)
    }

    const url = targetEndpoint.endsWith('/chat/completions')
        ? targetEndpoint
        : `${targetEndpoint}/chat/completions`

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model: targetModel,
                messages: chatMessages,
                stream: Boolean(onChunk),
                max_tokens: targetMaxTokens,
                temperature: 0.3
            }),
            signal
        })

        if (!response.ok) {
            let errBody = ''
            try { errBody = await response.text() } catch (e) {}
            throw new Error(t('aiAssistant.error.httpFailed', { status: response.status, body: errBody.slice(0, 200) }))
        }

        if (!onChunk) {
            const json = await response.json()
            return resultValue({
                fullText: json.choices?.[0]?.message?.content || '',
                finishReason: json.choices?.[0]?.finish_reason ?? null,
                usage: json.usage ?? null
            })
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let fullText = ''
        let buffer = ''
        let finishReason = null
        let receivedDone = false
        let usage = null

        const consumeLine = line => {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) return
            const payload = trimmed.slice(5).trimStart()
            if (payload === '[DONE]') { receivedDone = true; return }
            let data
            try { data = JSON.parse(payload) } catch (_) { return }
            if (data.error) {
                reader.cancel().catch(() => {})
                throw new Error(t('aiAssistant.error.httpFailed', {
                    status: data.error.status || data.error.code || 500,
                    body: String(data.error.message || t('aiAssistant.error.requestFailed')).slice(0, 200)
                }))
            }
            if (data.usage && typeof data.usage === 'object') usage = data.usage
            if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason
            const delta = data.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
                fullText += delta
                onChunk(delta, fullText)
            }
        }

        while (true) {
            const { done, value } = await reader.read()
            if (done) {
                buffer += decoder.decode()
                break
            }

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()

            for (const line of lines) {
                consumeLine(line)
                if (receivedDone) break
            }
            if (receivedDone) {
                await reader.cancel().catch(() => {})
                buffer = ''
                break
            }
        }

        // Parse remaining buffer if present (e.g. without trailing newline)
        if (buffer.trim()) consumeLine(buffer)

        // EOF classification: unconfirmed EOF without [DONE] or finish_reason is partial
        const finalStatus = (finishReason === 'length' || finishReason === 'max_tokens' || (!receivedDone && !finishReason))
            ? 'partial'
            : 'completed'

        return resultValue({ fullText, finishReason, status: finalStatus, usage })
    } finally {
        _mockActiveRequestId = null
    }
}

// Translation parsing happens after a successful API response; the transport audit alone cannot show it.
export async function recordTranslationDiagnostic(diagnostic) {
    if (globalThis.__TAURI__?.core?.invoke) {
        return globalThis.__TAURI__.core.invoke('ai_record_translation_diagnostic', { diagnostic });
    }
    console.warn('[ChapterTranslation]', diagnostic);
    return false;
}
