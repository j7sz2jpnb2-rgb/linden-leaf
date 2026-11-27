/**
 * external-ai-companion.js
 * Manages Linden Leaf's External AI Browser Companion ("Bring Your Own AI"):
 * - Portable versioned ReadingReference snapshots & recent-reference anchor history
 * - Per-book external conversation URL / tab / window binding
 * - 3-tier reference delivery (Dedicated Adapter -> Explicit Generic -> Clipboard Fallback)
 * - Low-coupling knowledge backflow (Clipboard / Explicit Selection Menu -> Confirmed Origin Reference Note)
 * - Windows Chrome/Edge App Mode launcher, DWM side-by-side docking, and lazy snap watcher
 */

import { t } from './i18n.js'
import { escapeHTML } from './ui-format.js'
import {
    createReferenceSnapshot,
    extractEnclosingSentenceContext,
    formatExternalAiReferencePrompt
} from './ai-context.js'
import * as db from './db.js'
import { normalizeHighlightColor, DEFAULT_HIGHLIGHT_COLOR } from './highlight-palette.js'

const COMPANION_CFG_KEY = 'linden_ai_companion_config'
const COMPANION_SESSIONS_KEY = 'linden_ai_companion_sessions'
const MAX_RECENT_REFERENCES = 25
const MAX_BOOK_SESSIONS = 100

export const EXTERNAL_AI_PROVIDERS = Object.freeze({
    chatgpt: Object.freeze({
        id: 'chatgpt',
        name: 'ChatGPT',
        url: 'https://chatgpt.com',
        origin: 'https://chatgpt.com',
        hasAdapter: true
    }),
    gemini: Object.freeze({
        id: 'gemini',
        name: 'Gemini',
        url: 'https://gemini.google.com/app',
        origin: 'https://gemini.google.com',
        hasAdapter: true
    }),
    aistudio: Object.freeze({
        id: 'aistudio',
        name: 'Google AI Studio',
        url: 'https://aistudio.google.com/prompts/new_chat',
        origin: 'https://aistudio.google.com',
        hasAdapter: true
    }),
    deepseek: Object.freeze({
        id: 'deepseek',
        name: 'DeepSeek',
        url: 'https://chat.deepseek.com',
        origin: 'https://chat.deepseek.com',
        hasAdapter: true
    }),
    custom: Object.freeze({
        id: 'custom',
        name: 'Custom HTTPS',
        url: '',
        origin: '',
        hasAdapter: false
    })
})

export const DEFAULT_COMPANION_CONFIG = Object.freeze({
    companionMode: 'sidebar', // 'sidebar' | 'external'
    providerId: 'chatgpt',
    customUrl: '',
    allowGenericCustomInsert: false,
    browserId: 'auto', // 'auto' | 'edge' | 'chrome' | 'brave' | 'default'
    profileDirectory: 'Default',
    autoDock: true,
    snapEnabled: true,
    compactMode: true,
    collapseSidebar: true,
    zoomPercent: 90,
    allowContextMenu: false,
    placement: 'right',
    splitRatio: 0.58,
    extensionId: ''
})

export function validateCustomHttpsUrl(raw) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) return { valid: false, error: t('companion.error.customUrlEmpty') }
    try {
        const parsed = new URL(trimmed)
        if (parsed.protocol !== 'https:' || !parsed.hostname) {
            return { valid: false, error: t('companion.error.customUrlHttpsOnly') }
        }
        return { valid: true, url: parsed.toString(), origin: parsed.origin }
    } catch (_) {
        return { valid: false, error: t('companion.error.customUrlInvalid') }
    }
}

export function getCompanionConfig() {
    try {
        const raw = localStorage.getItem(COMPANION_CFG_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            return { ...DEFAULT_COMPANION_CONFIG, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
        }
    } catch (_) {}
    return { ...DEFAULT_COMPANION_CONFIG }
}

export function saveCompanionConfig(patch = {}) {
    const cur = getCompanionConfig()
    const next = { ...cur }
    if (patch.companionMode === 'sidebar' || patch.companionMode === 'external') {
        next.companionMode = patch.companionMode
    }
    if (patch.providerId && EXTERNAL_AI_PROVIDERS[patch.providerId]) {
        next.providerId = patch.providerId
    }
    if (patch.customUrl !== undefined) {
        const val = String(patch.customUrl || '').trim()
        if (val) {
            const check = validateCustomHttpsUrl(val)
            if (!check.valid) throw new Error(check.error)
            next.customUrl = check.url
        } else {
            next.customUrl = ''
        }
    }
    if (patch.allowGenericCustomInsert !== undefined) next.allowGenericCustomInsert = Boolean(patch.allowGenericCustomInsert)
    if (patch.browserId !== undefined) next.browserId = String(patch.browserId || 'auto')
    if (patch.profileDirectory !== undefined) next.profileDirectory = String(patch.profileDirectory || 'Default')
    if (patch.autoDock !== undefined) next.autoDock = Boolean(patch.autoDock)
    if (patch.snapEnabled !== undefined) next.snapEnabled = Boolean(patch.snapEnabled)
    if (patch.compactMode !== undefined) next.compactMode = Boolean(patch.compactMode)
    if (patch.collapseSidebar !== undefined) next.collapseSidebar = Boolean(patch.collapseSidebar)
    if (patch.zoomPercent !== undefined) {
        const z = Number(patch.zoomPercent)
        if (Number.isFinite(z)) next.zoomPercent = Math.max(60, Math.min(150, Math.round(z)))
    }
    if (patch.allowContextMenu !== undefined) next.allowContextMenu = Boolean(patch.allowContextMenu)
    if (patch.placement === 'left' || patch.placement === 'right') next.placement = patch.placement
    if (patch.splitRatio !== undefined) {
        const r = Number(patch.splitRatio)
        if (Number.isFinite(r)) next.splitRatio = Math.max(0.45, Math.min(0.75, r))
    }
    if (patch.extensionId !== undefined) next.extensionId = String(patch.extensionId || '').trim().toLowerCase()

    try {
        localStorage.setItem(COMPANION_CFG_KEY, JSON.stringify(next))
    } catch (_) {}
    return next
}

function readSessionsMap() {
    try {
        const raw = localStorage.getItem(COMPANION_SESSIONS_KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (_) {
        return {}
    }
}

function writeSessionsMap(map) {
    try {
        const entries = Object.entries(map)
            .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
            .slice(0, MAX_BOOK_SESSIONS)
        localStorage.setItem(COMPANION_SESSIONS_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch (_) {}
}

export function getBookCompanionSession(bookId) {
    if (!bookId) return null
    const map = readSessionsMap()
    return map[String(bookId)] || null
}

export function saveBookCompanionSession(bookId, data) {
    if (!bookId || !data) return null
    const key = String(bookId)
    const map = readSessionsMap()
    const next = {
        ...(map[key] || {}),
        ...data,
        bookId: key,
        updatedAt: Date.now()
    }
    map[key] = next
    writeSessionsMap(map)
    return next
}

export function clearBookCompanionSession(bookId) {
    if (!bookId) return
    const map = readSessionsMap()
    delete map[String(bookId)]
    writeSessionsMap(map)
}

export function resolveProviderTarget(cfg = getCompanionConfig(), bookSession = null) {
    const providerId = cfg.providerId && EXTERNAL_AI_PROVIDERS[cfg.providerId] ? cfg.providerId : 'chatgpt'
    const spec = EXTERNAL_AI_PROVIDERS[providerId]
    let baseUrl = spec.url
    let baseOrigin = spec.origin
    if (providerId === 'custom') {
        const check = validateCustomHttpsUrl(cfg.customUrl)
        if (!check.valid) return { ok: false, error: check.error, providerId, hasAdapter: false }
        baseUrl = check.url
        baseOrigin = check.origin
    }
    let effectiveUrl = baseUrl
    if (bookSession?.conversationUrl && bookSession.providerId === providerId) {
        try {
            const parsedSaved = new URL(bookSession.conversationUrl)
            const allowedOrigins = providerId === 'chatgpt'
                ? ['https://chatgpt.com', 'https://chat.openai.com']
                : [baseOrigin]
            if (parsedSaved.protocol === 'https:' && allowedOrigins.includes(parsedSaved.origin)) {
                effectiveUrl = parsedSaved.toString()
            }
        } catch (_) {}
    }
    return {
        ok: true,
        providerId,
        providerName: spec.name,
        hasAdapter: spec.hasAdapter,
        url: effectiveUrl,
        baseOrigin
    }
}

export class ExternalAiCompanionManager {
    constructor(app) {
        this.app = app
        this.isActive = false
        this.companionHwnd = null
        this.extensionConnected = false
        this.snapDetachedByUser = false
        this.tightScreenWarned = false
        this.recentReferences = []
        this.lastDeliveredRefId = null
        this._bridgeInitialized = false
        this._tauriUnlistenEvent = null
        this._tauriUnlistenDetach = null
        this._boundWindowResize = null
        this._pillBound = false
    }

    isEnabledExternalMode() {
        return getCompanionConfig().companionMode === 'external'
    }

    recordReference(ref) {
        if (!ref || !ref.referenceId) return
        const filtered = this.recentReferences.filter(r => r.referenceId !== ref.referenceId)
        filtered.unshift(ref)
        this.recentReferences = filtered.slice(0, MAX_RECENT_REFERENCES)
        this.lastDeliveredRefId = ref.referenceId
        this._refreshPillUI()
    }

    getReferenceById(referenceId) {
        if (!referenceId) return this.recentReferences[0] || null
        return this.recentReferences.find(r => r.referenceId === referenceId) || this.recentReferences[0] || null
    }

    async buildSelectionReference(selectionInfo, { isWordContext = false } = {}) {
        const book = this.app?.currentBookData || this.app?.currentBook || null
        let sentenceContext = selectionInfo?.sentenceContext || selectionInfo?.context || ''
        if (isWordContext && !sentenceContext && selectionInfo?.text) {
            const iframe = this.app?.foliateView?.shadowRoot?.querySelector('iframe')
                || this.app?.foliateView?.querySelector('iframe')
            const doc = iframe?.contentDocument || this.app?.foliateView?.renderer?.getContents?.()?.[0]?.doc || null
            let pageText = ''
            const pageIdx = selectionInfo?.pageIndex ?? (typeof selectionInfo?.pdfTarget?.page === 'number' ? selectionInfo.pdfTarget.page : null)
            if (!doc && pageIdx != null && typeof document !== 'undefined') {
                const pageEl = document.querySelector(`.pdf-page-slot[data-page-index="${pageIdx}"], .pdf-page-container[data-page-index="${pageIdx}"]`)
                pageText = pageEl?.innerText || ''
                if (!pageText && typeof this.app?.pdfViewport?.driver?.getPlainText === 'function') {
                    pageText = await this.app.pdfViewport.driver.getPlainText(pageIdx).catch(() => '')
                }
            }
            sentenceContext = extractEnclosingSentenceContext({
                doc,
                range: selectionInfo?.range || null,
                pageText,
                selectedText: selectionInfo.text,
                maxChars: 360
            })
        }
        const enriched = {
            ...(selectionInfo || {}),
            sentenceContext,
            kind: isWordContext ? 'word_context' : (selectionInfo?.kind || 'passage')
        }
        const ref = createReferenceSnapshot(book, enriched)
        if (!ref.bookId && this.app?.currentBookId) ref.bookId = this.app.currentBookId
        return ref
    }

    async _ensureListenersAttached() {
        if (this._bridgeInitialized) return
        this._bridgeInitialized = true
        if (globalThis.__TAURI__?.event?.listen) {
            try {
                this._tauriUnlistenEvent = await globalThis.__TAURI__.event.listen('companion:event', (ev) => {
                    this._handleNativeBridgeEvent(ev?.payload)
                })
                this._tauriUnlistenDetach = await globalThis.__TAURI__.event.listen('companion:snap-detached', () => {
                    this.snapDetachedByUser = true
                    saveCompanionConfig({ snapEnabled: false })
                    this._refreshPillUI()
                    this.app?.dialogs?.showToast?.(t('companion.toastSnapDetached'), 'info')
                })
            } catch (_) {}
        }
    }

    _handleNativeBridgeEvent(msg) {
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'extension_hello') {
            this.extensionConnected = true
            this._syncExtensionSession().catch(() => {})
            this._refreshPillUI()
            return
        }
        if (msg.type === 'host_disconnected') {
            this.extensionConnected = false
            this._refreshPillUI()
            return
        }
        if (msg.type === 'tab_bound' || msg.type === 'tab_navigated') {
            const bookId = msg.bookId || this.app?.currentBookId
            if (bookId && msg.url && String(msg.url).startsWith('https://')) {
                const cfg = getCompanionConfig()
                saveBookCompanionSession(bookId, {
                    providerId: cfg.providerId,
                    conversationUrl: msg.url,
                    conversationTitle: msg.title || '',
                    tabId: msg.tabId ?? null,
                    windowId: msg.windowId ?? null
                })
            }
            this.extensionConnected = true
            this._refreshPillUI()
            return
        }
        if (msg.type === 'tab_closed') {
            this._refreshPillUI()
            return
        }
        if (msg.type === 'selection_backflow' && msg.selectionText) {
            this.openSaveBackflowModal(String(msg.selectionText), {
                sourceType: 'extension_menu',
                pageUrl: msg.pageUrl || '',
                pageTitle: msg.title || ''
            })
        }
    }

    async _invokeTauri(cmd, args = {}) {
        if (!globalThis.__TAURI__?.core?.invoke) return null
        return globalThis.__TAURI__.core.invoke(cmd, args)
    }

    async _copyTextSafe(text) {
        try {
            if (globalThis.__TAURI__?.core?.invoke) {
                const ok = await this._invokeTauri('companion_clipboard_write', { text })
                if (ok) return true
            }
        } catch (_) {}
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text)
                return true
            }
        } catch (_) {}
        return false
    }

    async _readClipboardSafe() {
        try {
            if (globalThis.__TAURI__?.core?.invoke) {
                const text = await this._invokeTauri('companion_clipboard_read')
                if (typeof text === 'string' && text.trim()) return text
            }
        } catch (_) {}
        try {
            if (navigator?.clipboard?.readText) {
                return await navigator.clipboard.readText()
            }
        } catch (_) {}
        return ''
    }

    async _startBridgeIfNeeded() {
        await this._ensureListenersAttached()
        if (!globalThis.__TAURI__?.core?.invoke) return null
        try {
            const status = await this._invokeTauri('companion_start_bridge', { enableRelay: true })
            this.extensionConnected = Boolean(status?.nativeConnected)
            return status
        } catch (_) {
            return null
        }
    }

    async _syncExtensionSession() {
        const cfg = getCompanionConfig()
        const bookId = this.app?.currentBookId || null
        const target = resolveProviderTarget(cfg, bookId ? getBookCompanionSession(bookId) : null)
        await this._invokeTauri('companion_send_command', {
            command: {
                type: 'sync_session',
                bookId,
                providerId: cfg.providerId,
                expectedOrigin: target.ok ? target.baseOrigin : '',
                compactMode: cfg.compactMode,
                collapseSidebar: cfg.collapseSidebar,
                zoomPercent: cfg.zoomPercent,
                allowContextMenu: cfg.allowContextMenu,
                allowGenericFallback: cfg.allowGenericCustomInsert
            },
            timeoutMs: 800
        }).catch(() => {})
    }

    async openCompanionForBook({ autoLaunch = true } = {}) {
        const cfg = getCompanionConfig()
        const bookId = this.app?.currentBookId || null
        const savedSession = bookId ? getBookCompanionSession(bookId) : null
        const target = resolveProviderTarget(cfg, savedSession)
        if (!target.ok) {
            this.app?.dialogs?.showToast?.(target.error || t('companion.error.customUrlInvalid'), 'warning')
            return { ok: false, error: target.error }
        }

        this.isActive = true
        if (typeof window !== 'undefined') window.mobileShell?.handleResize?.()
        this._bindPillEvents()
        this._refreshPillUI()

        const bridgeStatus = await this._startBridgeIfNeeded()

        if (!globalThis.__TAURI__?.core?.invoke) {
            window.open(target.url, '_blank', 'noopener,noreferrer')
            return { ok: true, webFallback: true }
        }

        let reuseHwnd = savedSession?.hwnd || this.companionHwnd || null
        if (reuseHwnd) {
            const alive = await this._invokeTauri('companion_is_window_alive', { companionHwnd: reuseHwnd }).catch(() => false)
            if (!alive) reuseHwnd = null
        }

        if (!autoLaunch && !reuseHwnd) {
            this._refreshPillUI()
            return { ok: true, waitingLaunch: true }
        }

        const isCompactReader = (typeof window !== 'undefined' && window.innerWidth <= 1100) || (typeof document !== 'undefined' && Boolean(document.body?.classList?.contains('compact-reader-layout')))
        let launchRes = null

        if (bridgeStatus?.nativeConnected && !reuseHwnd) {
            const beforeHwnds = (await this._invokeTauri('companion_snapshot_browser_hwnds').catch(() => [])) || []
            const bindRes = await this._invokeTauri('companion_send_command', {
                command: {
                    type: 'open_or_bind_tab',
                    bookId,
                    providerId: target.providerId,
                    url: target.url,
                    windowType: 'popup',
                    forceNewPopup: true,
                    focusWindow: true,
                    compactMode: cfg.compactMode,
                    collapseSidebar: cfg.collapseSidebar,
                    zoomPercent: cfg.zoomPercent,
                    allowGenericFallback: target.providerId === 'custom' && Boolean(cfg.allowGenericCustomInsert)
                },
                timeoutMs: 2600
            }).catch(() => null)
            if (bindRes?.ok) {
                launchRes = await this._invokeTauri('companion_dock_new_browser_window', {
                    beforeHwnds,
                    placement: cfg.placement,
                    splitRatio: cfg.splitRatio,
                    compactReader: isCompactReader,
                    snapEnabled: cfg.autoDock && cfg.snapEnabled
                }).catch(() => ({ ok: true, windowFound: false, docked: false }))
            }
        }

        if (!launchRes) {
            launchRes = await this._invokeTauri('companion_launch_app_window', {
                options: {
                    browserId: cfg.browserId,
                    url: target.url,
                    profileDirectory: cfg.profileDirectory,
                    reuseHwnd,
                    autoDock: cfg.autoDock,
                    placement: cfg.placement,
                    splitRatio: cfg.splitRatio,
                    compactReader: isCompactReader,
                    snapEnabled: cfg.autoDock && cfg.snapEnabled
                }
            }).catch((err) => ({ ok: false, error: err?.message || String(err) }))
        }

        if (launchRes?.hwnd) {
            this.companionHwnd = launchRes.hwnd
            if (bookId) {
                saveBookCompanionSession(bookId, {
                    sessionId: savedSession?.sessionId || `ext_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    providerId: target.providerId,
                    conversationUrl: target.url,
                    hwnd: launchRes.hwnd
                })
            }
        }
        if (launchRes?.tightScreen && !this.tightScreenWarned) {
            this.tightScreenWarned = true
            this.app?.dialogs?.showToast?.(t('companion.toastTightScreen'), 'info')
        }
        if (!launchRes?.windowFound && !launchRes?.fallbackDefaultBrowser) {
            this.app?.dialogs?.showToast?.(t('companion.toastWindowPickHint'), 'info')
        }
        if (bridgeStatus?.nativeConnected) {
            this.extensionConnected = true
            await this._syncExtensionSession()
        }
        this._refreshPillUI()
        return launchRes || { ok: true }
    }

    async sendReference(selectionInfo, { isWordContext = false, userQuestion = '' } = {}) {
        const ref = await this.buildSelectionReference(selectionInfo, { isWordContext })
        if (!ref || !ref.selectedText) return { ok: false, reason: 'empty_selection' }
        this.recordReference(ref)

        const cfg = getCompanionConfig()
        const bookId = ref.bookId || this.app?.currentBookId || null
        const savedSession = bookId ? getBookCompanionSession(bookId) : null
        const target = resolveProviderTarget(cfg, savedSession)
        if (!target.ok) {
            this.app?.dialogs?.showToast?.(target.error || t('companion.error.customUrlInvalid'), 'warning')
            return { ok: false, reason: 'invalid_url' }
        }

        const promptText = formatExternalAiReferencePrompt(ref, {
            surroundingContext: ref.context,
            userQuestion
        })
        const verifySnippet = ref.selectedText.trim().slice(0, 28)

        // Ensure companion window & bridge are started cleanly before dispatching reference
        await this.openCompanionForBook({ autoLaunch: true })

        const requestId = `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        let inserted = { ok: false, reason: 'bridge_offline' }

        if (globalThis.__TAURI__?.core?.invoke) {
            inserted = await this._invokeTauri('companion_send_command', {
                command: {
                    type: 'insert_reference',
                    requestId,
                    bookId,
                    providerId: target.providerId,
                    expectedOrigin: target.baseOrigin,
                    allowAutoBindExisting: true,
                    promptText,
                    verifySnippet,
                    allowGenericFallback: target.providerId === 'custom' && Boolean(cfg.allowGenericCustomInsert),
                    compactMode: cfg.compactMode,
                    collapseSidebar: cfg.collapseSidebar,
                    zoomPercent: cfg.zoomPercent
                },
                timeoutMs: 2600
            }).catch(() => ({ ok: false, reason: 'bridge_error' }))
        }

        if (inserted?.ok) {
            this.extensionConnected = true
            let focused = false
            if (this.companionHwnd) {
                focused = Boolean(await this._invokeTauri('companion_activate_window', { companionHwnd: this.companionHwnd }).catch(() => false))
            }
            const msg = focused
                ? t('companion.toastSentToAi', { provider: target.providerName })
                : t('companion.toastSentManualFocus', { provider: target.providerName })
            this.app?.dialogs?.showToast?.(msg, 'success')
            this._refreshPillUI()
            return { ok: true, method: inserted.method || 'adapter', referenceId: ref.referenceId }
        }

        // Level C Clipboard Fallback (guaranteed draft-safe, zero data loss, never auto-submits!)
        const copied = await this._copyTextSafe(promptText)
        let focused = false
        if (this.companionHwnd) {
            focused = Boolean(await this._invokeTauri('companion_activate_window', { companionHwnd: this.companionHwnd }).catch(() => false))
        }

        const reason = inserted?.reason || 'bridge_offline'
        let fallbackKey = focused ? 'companion.toastClipboardPasteReady' : 'companion.toastClipboardManualSwitch'
        if (reason === 'ime_composing') {
            fallbackKey = 'companion.toastImeComposingFallback'
        } else if (reason === 'untrusted_or_changed_origin' || reason === 'provider_mismatch') {
            fallbackKey = 'companion.toastOriginMismatchFallback'
        } else if (reason === 'insert_unverified') {
            fallbackKey = 'companion.toastInsertUnverifiedFallback'
        }
        if (!copied) fallbackKey = 'companion.toastClipboardFailed'

        this.app?.dialogs?.showToast?.(t(fallbackKey, { provider: target.providerName }), copied ? 'info' : 'warning')
        this._refreshPillUI()
        return { ok: copied, fallback: 'clipboard', reason, referenceId: ref.referenceId }
    }

    async dockNow() {
        const cfg = getCompanionConfig()
        if (!this.companionHwnd) {
            return this.openCompanionForBook({ autoLaunch: true })
        }
        const isCompactReader = (typeof window !== 'undefined' && window.innerWidth <= 1100) || (typeof document !== 'undefined' && Boolean(document.body?.classList?.contains('compact-reader-layout')))
        try {
            const res = await this._invokeTauri('companion_dock_side_by_side', {
                companionHwnd: this.companionHwnd,
                placement: cfg.placement,
                splitRatio: cfg.splitRatio,
                compactReader: isCompactReader,
                snapEnabled: cfg.snapEnabled
            })
            if (res?.tightScreen) {
                this.app?.dialogs?.showToast?.(t('companion.toastTightScreen'), 'info')
            } else {
                this.app?.dialogs?.showToast?.(t('companion.toastDocked'), 'success')
            }
            this._refreshPillUI()
            return res
        } catch (err) {
            this.app?.dialogs?.showToast?.(t('companion.toastWindowLost'), 'warning')
            this.companionHwnd = null
            this._refreshPillUI()
            return { ok: false, error: err?.message }
        }
    }

    async toggleSnap() {
        const cfg = getCompanionConfig()
        const nextSnap = !cfg.snapEnabled
        saveCompanionConfig({ snapEnabled: nextSnap })
        this.snapDetachedByUser = !nextSnap
        if (this.companionHwnd && globalThis.__TAURI__?.core?.invoke) {
            await this._invokeTauri('companion_set_snap_state', {
                enabled: nextSnap,
                companionHwnd: this.companionHwnd,
                placement: cfg.placement,
                splitRatio: cfg.splitRatio,
                compactReader: window.innerWidth <= 1100
            }).catch(() => {})
        }
        this._refreshPillUI()
    }

    async toggleCompactMode() {
        const cfg = getCompanionConfig()
        const nextCompact = !cfg.compactMode
        saveCompanionConfig({ compactMode: nextCompact })
        await this._syncExtensionSession()
        this._refreshPillUI()
    }

    async openWindowPickerModal() {
        const modal = document.getElementById('modal-companion-window-picker')
        const listEl = document.getElementById('companion-window-picker-list')
        if (!modal || !listEl) return
        listEl.innerHTML = `<div style="padding:12px;color:var(--text-muted);">${escapeHTML(t('common.loading'))}</div>`
        modal.style.display = 'flex'
        modal.classList.add('show')

        const windows = (await this._invokeTauri('companion_list_candidate_windows').catch(() => [])) || []
        if (!windows.length) {
            listEl.innerHTML = `<div style="padding:12px;color:var(--text-muted);">${escapeHTML(t('companion.pickerEmpty'))}</div>`
            return
        }
        listEl.innerHTML = windows.map(w => `
            <button type="button" class="companion-window-pick-item" data-hwnd="${escapeHTML(String(w.hwnd))}">
                <span class="companion-win-title">${escapeHTML(w.title || '-')}</span>
                <span class="companion-win-meta">${escapeHTML(w.processName || '')}${w.isBrowser ? ' · Browser' : ''}</span>
            </button>
        `).join('')
        listEl.querySelectorAll('.companion-window-pick-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const hwnd = Number(btn.dataset.hwnd)
                if (!Number.isFinite(hwnd)) return
                this.companionHwnd = hwnd
                this.isActive = true
                const bookId = this.app?.currentBookId
                if (bookId) {
                    saveBookCompanionSession(bookId, {
                        providerId: getCompanionConfig().providerId,
                        hwnd
                    })
                }
                modal.classList.remove('show')
                setTimeout(() => { if (!modal.classList.contains('show')) modal.style.display = 'none' }, 180)
                await this.dockNow()
            })
        })
    }

    async openSaveBackflowModal(preselectedText = null, sourceMeta = {}) {
        const modal = document.getElementById('modal-companion-backflow')
        const textarea = document.getElementById('companion-backflow-text')
        const refSelect = document.getElementById('companion-backflow-ref-select')
        const sourceLabel = document.getElementById('companion-backflow-source-label')
        const colorSelect = document.getElementById('companion-backflow-color')
        if (!modal || !textarea || !refSelect) return

        const clipText = preselectedText !== null ? String(preselectedText) : await this._readClipboardSafe()
        textarea.value = clipText.trim()

        if (sourceLabel) {
            sourceLabel.textContent = sourceMeta?.pageUrl
                ? t('companion.backflowSourceUrl', { url: sourceMeta.pageUrl })
                : t('companion.backflowSourceClipboard')
        }

        // Populate exact reference choices explicitly (NEVER guess active page!)
        refSelect.innerHTML = ''
        if (!this.recentReferences.length) {
            const opt = document.createElement('option')
            opt.value = ''
            opt.textContent = t('companion.backflowNoReference')
            refSelect.appendChild(opt)
        } else {
            for (const ref of this.recentReferences) {
                const opt = document.createElement('option')
                opt.value = ref.referenceId
                const excerpt = (ref.selectedText || '').replace(/\s+/g, ' ').slice(0, 46)
                const loc = ref.chapterOrPage ? ` · ${ref.chapterOrPage}` : ''
                opt.textContent = `[${ref.bookTitle || t('book.defaultTitleCurrent')}${loc}] “${excerpt}${ref.selectedText.length > 46 ? '…' : ''}”`
                if (ref.referenceId === this.lastDeliveredRefId) opt.selected = true
                refSelect.appendChild(opt)
            }
        }
        if (colorSelect && !colorSelect.value) {
            colorSelect.value = DEFAULT_HIGHLIGHT_COLOR
        }

        modal.style.display = 'flex'
        modal.classList.add('show')
        textarea.focus()
    }

    async commitBackflowModal() {
        const modal = document.getElementById('modal-companion-backflow')
        const textarea = document.getElementById('companion-backflow-text')
        const refSelect = document.getElementById('companion-backflow-ref-select')
        const colorSelect = document.getElementById('companion-backflow-color')
        const noteBody = (textarea?.value || '').trim()
        if (!noteBody) {
            this.app?.dialogs?.showToast?.(t('companion.backflowEmptyWarn'), 'warning')
            return false
        }
        const refId = refSelect?.value
        const ref = refId ? this.getReferenceById(refId) : null
        if (!ref) {
            this.app?.dialogs?.showToast?.(t('companion.backflowNeedRefWarn'), 'warning')
            return false
        }

        const color = normalizeHighlightColor(colorSelect?.value || DEFAULT_HIGHLIGHT_COLOR)
        const formattedNote = `${t('companion.backflowNotePrefix')}\n${noteBody}`

        if (ref.highlightId) {
            // Append cleanly to the exact existing highlight
            const existing = await db.getHighlightsByBook(ref.bookId).catch(() => [])
            const targetHl = existing.find(h => h.id === ref.highlightId)
            if (targetHl) {
                targetHl.note = targetHl.note?.trim() ? `${targetHl.note}\n\n${formattedNote}` : formattedNote
                targetHl.updatedAt = Date.now()
                await db.saveHighlight(targetHl)
                if (ref.bookId === this.app?.currentBookId) {
                    this.app.annotations?.loadNotesList?.()
                }
                this.closeBackflowModal()
                this.app?.dialogs?.showToast?.(t('companion.backflowSavedToast'), 'success')
                return true
            }
        }

        if (ref.bookId === this.app?.currentBookId && this.app?.annotations?.createHighlight && (ref.cfi || ref.pdfTarget)) {
            await this.app.annotations.createHighlight(color, 'highlight', formattedNote, { ...ref, appendNote: true })
        } else if (ref.bookId && (ref.cfi || ref.pdfTarget)) {
            const hl = {
                id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId: ref.bookId,
                formatType: ref.pdfTarget ? 'pdf' : 'epub',
                cfi: ref.cfi || undefined,
                pdfTarget: ref.pdfTarget || undefined,
                text: ref.selectedText,
                color,
                style: 'highlight',
                note: formattedNote,
                chapterTitle: ref.chapter || ref.chapterOrPage || '',
                createdAt: Date.now(),
                blobRevision: ref.blobRevision || null,
                revisionOrigin: ref.revisionOrigin || null,
                documentHash: ref.documentVersion || null
            }
            await db.saveHighlight(hl)
        } else {
            this.app?.dialogs?.showToast?.(t('companion.backflowNoAnchorWarn'), 'warning')
            return false
        }

        this.closeBackflowModal()
        this.app?.dialogs?.showToast?.(t('companion.backflowSavedToast'), 'success')
        return true
    }

    closeBackflowModal() {
        const modal = document.getElementById('modal-companion-backflow')
        if (!modal) return
        modal.classList.remove('show')
        setTimeout(() => { if (!modal.classList.contains('show')) modal.style.display = 'none' }, 180)
    }

    onReaderClosed() {
        if (typeof document !== 'undefined') {
            const pill = document.getElementById('companion-floating-bar')
            if (pill) pill.style.display = 'none'
        }
        this.closeBackflowModal()
    }

    async closeCompanion() {
        this.isActive = false
        if (typeof window !== 'undefined') window.mobileShell?.handleResize?.()
        this._refreshPillUI()
        if (this.extensionConnected && globalThis.__TAURI__?.core?.invoke) {
            await this._invokeTauri('companion_send_command', {
                command: { type: 'deactivate_companion' },
                timeoutMs: 450
            }).catch(() => {})
        }
        if (globalThis.__TAURI__?.core?.invoke) {
            this._invokeTauri('companion_stop_bridge').catch(() => {})
        }
        this.extensionConnected = false
    }

    _bindPillEvents() {
        if (this._pillBound || typeof document === 'undefined') return
        this._pillBound = true

        document.getElementById('btn-companion-dock')?.addEventListener('click', () => this.dockNow())
        document.getElementById('btn-companion-snap')?.addEventListener('click', () => this.toggleSnap())
        document.getElementById('btn-companion-compact')?.addEventListener('click', () => this.toggleCompactMode())
        document.getElementById('btn-companion-pick-win')?.addEventListener('click', () => this.openWindowPickerModal())
        document.getElementById('btn-companion-save-back')?.addEventListener('click', () => this.openSaveBackflowModal())
        document.getElementById('btn-companion-close-bar')?.addEventListener('click', () => this.closeCompanion())

        document.getElementById('btn-close-companion-backflow')?.addEventListener('click', () => this.closeBackflowModal())
        document.getElementById('btn-cancel-companion-backflow')?.addEventListener('click', () => this.closeBackflowModal())
        document.getElementById('btn-confirm-companion-backflow')?.addEventListener('click', () => this.commitBackflowModal())

        const pickerModal = document.getElementById('modal-companion-window-picker')
        document.getElementById('btn-close-companion-picker')?.addEventListener('click', () => {
            if (!pickerModal) return
            pickerModal.classList.remove('show')
            setTimeout(() => { if (!pickerModal.classList.contains('show')) pickerModal.style.display = 'none' }, 180)
        })
    }

    _refreshPillUI() {
        if (typeof document === 'undefined') return
        const pill = document.getElementById('companion-floating-bar')
        if (!pill) return
        pill.style.display = this.isActive ? 'flex' : 'none'
        if (!this.isActive) return

        const cfg = getCompanionConfig()
        const provider = EXTERNAL_AI_PROVIDERS[cfg.providerId] || EXTERNAL_AI_PROVIDERS.chatgpt
        const label = document.getElementById('companion-bar-provider-label')
        const dot = document.getElementById('companion-bar-conn-dot')
        if (label) {
            label.textContent = provider.name
        }
        if (dot) {
            dot.classList.toggle('is-connected', this.extensionConnected)
            dot.title = this.extensionConnected ? t('companion.statusExtConnected') : t('companion.statusClipboardMode')
        }
        document.getElementById('btn-companion-snap')?.classList?.toggle?.('active', Boolean(cfg.snapEnabled))
        document.getElementById('btn-companion-compact')?.classList?.toggle?.('active', Boolean(cfg.compactMode))
        const refCount = this.recentReferences.length
        const saveBtn = document.getElementById('btn-companion-save-back')
        if (saveBtn) {
            saveBtn.disabled = refCount === 0
        }
    }

    onBookOpened(bookId) {
        if (!this.isActive && !this.isEnabledExternalMode()) return
        this._refreshPillUI()
        if (this.extensionConnected && bookId) {
            this._syncExtensionSession().catch(() => {})
        }
    }

    dispose() {
        if (this._tauriUnlistenEvent) {
            try { this._tauriUnlistenEvent() } catch (_) {}
            this._tauriUnlistenEvent = null
        }
        if (this._tauriUnlistenDetach) {
            try { this._tauriUnlistenDetach() } catch (_) {}
            this._tauriUnlistenDetach = null
        }
        this._bridgeInitialized = false
        Promise.resolve(this.closeCompanion()).catch(() => {})
    }
}
