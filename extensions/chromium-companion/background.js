/**
 * Linden Leaf Chromium Companion - MV3 Service Worker
 * Transport: Native Messaging Host ('com.lindenleaf.companion') primary +
 * optional pair-token authenticated loopback fallback (127.0.0.1).
 */

const NATIVE_HOST_NAME = 'com.lindenleaf.companion'
const OFFICIAL_PATTERNS = [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://gemini.google.com/*',
    'https://aistudio.google.com/*',
    'https://chat.deepseek.com/*'
]
const RECONNECT_DELAYS_MS = [2500, 5000, 10000]

let nativePort = null
let nativeStatus = 'disconnected' // 'connected' | 'bridge_inactive' | 'disconnected' | 'error'
let lastNativeError = ''
let relayTimer = null
let reconnectTimer = null
let reconnectAttempts = 0
let rulesCache = null
let activeSession = {
    bookId: null,
    providerId: 'chatgpt',
    expectedOrigin: '',
    tabId: null,
    windowId: null,
    compactMode: false,
    collapseSidebar: false,
    zoomPercent: 100,
    prevZoomFactor: null,
    allowContextMenu: false,
    allowGenericFallback: false,
    pendingInitialApply: false,
    relayPort: null,
    pairingToken: ''
}

const MAX_RECENT_RESULTS = 40
const recentRequestResults = new Map()

async function loadState() {
    try {
        const stored = await chrome.storage.local.get('llCompanionSession')
        if (stored?.llCompanionSession && typeof stored.llCompanionSession === 'object') {
            activeSession = { ...activeSession, ...stored.llCompanionSession }
        }
    } catch (_) {}
}

async function saveState() {
    try {
        await chrome.storage.local.set({ llCompanionSession: activeSession })
    } catch (_) {}
}

function postToDesktop(message) {
    if (nativePort) {
        try {
            nativePort.postMessage(message)
            return true
        } catch (err) {
            nativeStatus = 'error'
            lastNativeError = err?.message || String(err)
            nativePort = null
        }
    }
    if (activeSession.relayPort && activeSession.pairingToken) {
        fetch(`http://127.0.0.1:${activeSession.relayPort}/event`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Linden-Token': activeSession.pairingToken
            },
            body: JSON.stringify(message)
        }).catch(() => {})
        return true
    }
    return false
}

async function loadRulesInBackground() {
    if (rulesCache) return rulesCache
    try {
        const resp = await fetch(chrome.runtime.getURL('adapters/rules.json'))
        if (resp.ok) {
            const json = await resp.json()
            if (json && typeof json === 'object' && json.providers) {
                rulesCache = json
                return rulesCache
            }
        }
    } catch (_) {}
    return { providers: {}, generic: { unsafeExcludeSelectors: [] } }
}

function isFatalManifestError(errMsg = '') {
    const low = String(errMsg || '').toLowerCase()
    return low.includes('not found') || low.includes('forbidden') || low.includes('access to the specified native messaging host')
}

function scheduleReconnect() {
    if (nativePort || reconnectTimer || reconnectAttempts >= RECONNECT_DELAYS_MS.length) return
    const delay = RECONNECT_DELAYS_MS[reconnectAttempts] || 10000
    reconnectAttempts += 1
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (!nativePort) connectNative()
    }, delay)
}

function connectNative({ resetBackoff = false } = {}) {
    if (resetBackoff) {
        reconnectAttempts = 0
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }
    }
    if (nativePort) return nativePort
    try {
        const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
        nativePort = port
        nativeStatus = 'connected'
        lastNativeError = ''

        port.onMessage.addListener((msg) => {
            if (msg?.type === 'host_offline') {
                nativeStatus = 'bridge_inactive'
                lastNativeError = ''
                if (nativePort === port) {
                    nativePort = null
                    try { port.disconnect() } catch (_) {}
                }
                scheduleReconnect()
                return
            }
            reconnectAttempts = 0
            handleDesktopCommand(msg).catch((err) => {
                if (msg?.requestId) {
                    postToDesktop({
                        type: 'command_error',
                        requestId: msg.requestId,
                        ok: false,
                        error: err?.message || String(err)
                    })
                }
            })
        })

        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError?.message || ''
            if (nativePort === port) nativePort = null
            if (nativeStatus !== 'bridge_inactive') {
                nativeStatus = err ? 'error' : 'disconnected'
            }
            if (err) lastNativeError = err
            if (!err || !isFatalManifestError(err)) {
                scheduleReconnect()
            }
        })

        port.postMessage({
            type: 'extension_hello',
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
            session: {
                tabId: activeSession.tabId,
                windowId: activeSession.windowId,
                bookId: activeSession.bookId
            }
        })
        return port
    } catch (err) {
        nativeStatus = 'error'
        lastNativeError = err?.message || String(err)
        nativePort = null
        return null
    }
}

function originFromUrl(raw) {
    try { return new URL(raw).origin } catch (_) { return '' }
}

function originsEquivalent(a, b) {
    if (!a || !b) return false
    if (a === b) return true
    const chatgptPair = new Set(['https://chatgpt.com', 'https://chat.openai.com'])
    return chatgptPair.has(a) && chatgptPair.has(b)
}

function isUrlAllowedForSession(urlStr) {
    if (!urlStr || !urlStr.startsWith('https://')) return false
    const actualOrigin = originFromUrl(urlStr)
    if (!actualOrigin) return false
    if (activeSession.expectedOrigin) {
        return originsEquivalent(actualOrigin, activeSession.expectedOrigin)
    }
    return OFFICIAL_PATTERNS.some(pat => originsEquivalent(actualOrigin, originFromUrl(pat.replace('/*', ''))))
}

function isOfficialAiUrl(urlStr) {
    if (!urlStr || !urlStr.startsWith('https://')) return false
    const actualOrigin = originFromUrl(urlStr)
    if (!actualOrigin) return false
    return OFFICIAL_PATTERNS.some(pat => originsEquivalent(actualOrigin, originFromUrl(pat.replace('/*', ''))))
}

async function resolveBoundTab(msg = {}) {
    if (activeSession.tabId != null) {
        try {
            const tab = await chrome.tabs.get(activeSession.tabId)
            if (tab && tab.url) return tab
        } catch (_) {
            activeSession.tabId = null
            activeSession.windowId = null
        }
    }
    if (msg.allowAutoBindExisting && msg.targetOrigin) {
        const tabs = await chrome.tabs.query({})
        const matches = tabs.filter(t => t.url && originsEquivalent(originFromUrl(t.url), msg.targetOrigin))
        if (matches.length) {
            const allWins = await chrome.windows.getAll().catch(() => [])
            const popupWinIds = new Set(allWins.filter(w => w.type === 'popup').map(w => w.id))
            const chosen = matches.find(t => popupWinIds.has(t.windowId)) || matches[0]
            activeSession.tabId = chosen.id
            activeSession.windowId = chosen.windowId
            await saveState()
            return chosen
        }
    }
    return null
}

async function applyTabZoom(tabId, zoomPercent, enabled) {
    if (!tabId) return
    try {
        await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' })
        if (enabled && Number.isFinite(Number(zoomPercent))) {
            if (activeSession.prevZoomFactor == null) {
                activeSession.prevZoomFactor = await chrome.tabs.getZoom(tabId).catch(() => 1.0)
            }
            const factor = Math.max(0.5, Math.min(2.0, Number(zoomPercent) / 100))
            await chrome.tabs.setZoom(tabId, factor)
        } else if (activeSession.prevZoomFactor != null) {
            await chrome.tabs.setZoom(tabId, activeSession.prevZoomFactor)
            activeSession.prevZoomFactor = null
        }
        await saveState()
    } catch (_) {}
}

async function applyTabCompactStyle(tabId, enabled, providerId, collapseSidebar, rules = null) {
    if (!tabId) return
    try {
        const loadedRules = rules || await loadRulesInBackground()
        const providerSpec = providerId ? (loadedRules.providers?.[providerId] || null) : null
        if (enabled) {
            await chrome.scripting.insertCSS({
                target: { tabId },
                files: ['styles/compact.css']
            }).catch(() => {})
        } else {
            await chrome.scripting.removeCSS({
                target: { tabId },
                files: ['styles/compact.css']
            }).catch(() => {})
        }
        await chrome.tabs.sendMessage(tabId, {
            type: 'LL_APPLY_COMPACT',
            enabled: Boolean(enabled),
            providerId,
            collapseSidebar: Boolean(collapseSidebar),
            providerSpec,
            genericRules: loadedRules.generic || null
        }).catch(() => {})
    } catch (_) {}
}

function syncContextMenu() {
    chrome.contextMenus.removeAll(() => {
        if (!activeSession.allowContextMenu) return
        const patterns = [...OFFICIAL_PATTERNS]
        if (activeSession.expectedOrigin && activeSession.allowGenericFallback) {
            patterns.push(`${activeSession.expectedOrigin}/*`)
        }
        chrome.contextMenus.create({
            id: 'linden-save-selection',
            title: chrome.i18n.getMessage('menuSaveSelection') || '保存选中文本到 Linden Leaf 原文批注',
            contexts: ['selection'],
            documentUrlPatterns: patterns
        }, () => { void chrome.runtime.lastError })
    })
}

async function ensureCustomScriptInjected(tabId, urlStr) {
    try {
        const origin = originFromUrl(urlStr)
        if (!origin) return false
        const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] })
        if (!granted) return false
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        })
        return true
    } catch (_) {
        return false
    }
}

async function handleDesktopCommand(msg) {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'ping') {
        postToDesktop({ type: 'pong', requestId: msg.requestId || null, extensionId: chrome.runtime.id })
        return
    }

    if (msg.type === 'sync_session') {
        activeSession = {
            ...activeSession,
            bookId: msg.bookId ?? activeSession.bookId,
            providerId: msg.providerId || activeSession.providerId,
            expectedOrigin: msg.expectedOrigin ?? activeSession.expectedOrigin,
            compactMode: msg.compactMode ?? activeSession.compactMode,
            collapseSidebar: msg.collapseSidebar ?? activeSession.collapseSidebar,
            zoomPercent: msg.zoomPercent ?? activeSession.zoomPercent,
            allowContextMenu: msg.allowContextMenu ?? activeSession.allowContextMenu,
            allowGenericFallback: msg.allowGenericFallback ?? activeSession.allowGenericFallback
        }
        await saveState()
        syncContextMenu()
        if (activeSession.tabId != null) {
            await applyTabCompactStyle(activeSession.tabId, activeSession.compactMode, activeSession.providerId, activeSession.collapseSidebar)
            await applyTabZoom(activeSession.tabId, activeSession.zoomPercent, activeSession.compactMode)
        }
        return
    }

    if (msg.type === 'deactivate_companion') {
        activeSession.compactMode = false
        activeSession.pendingInitialApply = false
        if (activeSession.tabId != null) {
            await applyTabCompactStyle(activeSession.tabId, false, activeSession.providerId, false)
            await applyTabZoom(activeSession.tabId, 100, false)
        }
        await saveState()
        postToDesktop({ type: 'deactivate_result', requestId: msg.requestId || null, ok: true })
        return
    }

    if (msg.type === 'open_or_bind_tab') {
        const url = String(msg.url || '').trim()
        if (!url.startsWith('https://')) {
            postToDesktop({ type: 'bind_result', requestId: msg.requestId, ok: false, reason: 'invalid_url' })
            return
        }
        activeSession.bookId = msg.bookId ?? activeSession.bookId
        activeSession.providerId = msg.providerId || activeSession.providerId
        activeSession.expectedOrigin = originFromUrl(url)
        activeSession.compactMode = Boolean(msg.compactMode)
        activeSession.collapseSidebar = Boolean(msg.collapseSidebar)
        activeSession.zoomPercent = Number(msg.zoomPercent) || 100
        activeSession.allowGenericFallback = Boolean(msg.allowGenericFallback)

        let tab = msg.forceNewPopup
            ? null
            : await resolveBoundTab({
                targetOrigin: activeSession.expectedOrigin,
                allowAutoBindExisting: Boolean(msg.allowAutoBindExisting)
            })
        if (!tab) {
            const win = await chrome.windows.create({
                url,
                type: msg.windowType === 'normal' ? 'normal' : 'popup',
                focused: Boolean(msg.focusWindow)
            })
            tab = win?.tabs?.[0] || null
            activeSession.pendingInitialApply = true
        } else if (msg.navigateIfDifferent && tab.url !== url && msg.allowNavigate) {
            tab = await chrome.tabs.update(tab.id, { url, active: true })
            activeSession.pendingInitialApply = true
        }

        if (tab) {
            activeSession.tabId = tab.id
            activeSession.windowId = tab.windowId
            await saveState()
            postToDesktop({
                type: 'bind_result',
                requestId: msg.requestId,
                ok: true,
                tabId: tab.id,
                windowId: tab.windowId,
                url: tab.url || url,
                title: tab.title || ''
            })
        } else {
            postToDesktop({ type: 'bind_result', requestId: msg.requestId, ok: false, reason: 'tab_create_failed' })
        }
        return
    }

    if (msg.type === 'insert_reference') {
        const requestId = msg.requestId || `req_${Date.now()}`
        if (recentRequestResults.has(requestId)) {
            postToDesktop(recentRequestResults.get(requestId))
            return
        }

        activeSession.providerId = msg.providerId || activeSession.providerId
        if (msg.expectedOrigin) activeSession.expectedOrigin = msg.expectedOrigin
        const tab = await resolveBoundTab({
            targetOrigin: activeSession.expectedOrigin,
            allowAutoBindExisting: Boolean(msg.allowAutoBindExisting)
        })
        if (!tab) {
            const fail = { type: 'insert_result', requestId, ok: false, reason: 'no_bound_tab' }
            postToDesktop(fail)
            return
        }
        if (!isUrlAllowedForSession(tab.url)) {
            const fail = {
                type: 'insert_result',
                requestId,
                ok: false,
                reason: 'untrusted_or_changed_origin',
                actualUrl: tab.url
            }
            postToDesktop(fail)
            return
        }

        if (msg.allowGenericFallback) {
            await ensureCustomScriptInjected(tab.id, tab.url)
        }

        const rules = await loadRulesInBackground()
        const effProviderId = msg.providerId || activeSession.providerId
        const providerSpec = (effProviderId && effProviderId !== 'custom')
            ? (rules.providers?.[effProviderId] || null)
            : null

        try {
            const res = await chrome.tabs.sendMessage(tab.id, {
                type: 'LL_INSERT_REF',
                requestId,
                expectedProviderId: msg.providerId,
                providerId: effProviderId,
                providerSpec,
                genericRules: rules.generic || null,
                promptText: msg.promptText,
                verifySnippet: msg.verifySnippet,
                allowGenericFallback: Boolean(msg.allowGenericFallback || activeSession.allowGenericFallback),
                compactMode: msg.compactMode ?? activeSession.compactMode,
                collapseSidebar: msg.collapseSidebar ?? activeSession.collapseSidebar
            })
            if (msg.compactMode ?? activeSession.compactMode) {
                await applyTabCompactStyle(tab.id, true, effProviderId, activeSession.collapseSidebar, rules)
                await applyTabZoom(tab.id, msg.zoomPercent || activeSession.zoomPercent, true)
            }
            const out = {
                type: 'insert_result',
                requestId,
                ok: Boolean(res?.ok),
                method: res?.method || 'none',
                reason: res?.reason || '',
                tabId: tab.id,
                windowId: tab.windowId,
                url: res?.url || tab.url,
                title: res?.title || tab.title || ''
            }
            recentRequestResults.set(requestId, out)
            if (recentRequestResults.size > MAX_RECENT_RESULTS) {
                const firstKey = recentRequestResults.keys().next().value
                recentRequestResults.delete(firstKey)
            }
            postToDesktop(out)
        } catch (err) {
            postToDesktop({
                type: 'insert_result',
                requestId,
                ok: false,
                reason: 'tab_message_failed',
                error: err?.message || String(err)
            })
        }
    }
}

async function pollRelayOnce() {
    if (!activeSession.relayPort || !activeSession.pairingToken) return
    try {
        const resp = await fetch(`http://127.0.0.1:${activeSession.relayPort}/pull`, {
            headers: { 'X-Linden-Token': activeSession.pairingToken }
        })
        if (!resp.ok) return
        const payload = await resp.json()
        if (Array.isArray(payload?.commands)) {
            for (const cmd of payload.commands) {
                await handleDesktopCommand(cmd)
            }
        }
    } catch (_) {}
}

function refreshRelayLoop() {
    if (relayTimer) {
        clearInterval(relayTimer)
        relayTimer = null
    }
    if (activeSession.relayPort && activeSession.pairingToken && !nativePort) {
        relayTimer = setInterval(pollRelayOnce, 1200)
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab?.url && (isOfficialAiUrl(tab.url) || isUrlAllowedForSession(tab.url)) && !nativePort) {
        connectNative({ resetBackoff: true })
    }
    if (tabId !== activeSession.tabId) return
    if (changeInfo.status === 'complete' && tab?.url && isUrlAllowedForSession(tab.url)) {
        if (activeSession.compactMode) {
            applyTabCompactStyle(tabId, true, activeSession.providerId, activeSession.collapseSidebar)
            applyTabZoom(tabId, activeSession.zoomPercent, true)
        }
        if (activeSession.pendingInitialApply) {
            activeSession.pendingInitialApply = false
            saveState()
        }
        postToDesktop({
            type: 'tab_navigated',
            bookId: activeSession.bookId,
            tabId,
            windowId: tab.windowId,
            url: tab.url,
            title: tab.title || ''
        })
    }
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (nativePort) return
    chrome.tabs.get(tabId).then((tab) => {
        if (tab?.url && (isOfficialAiUrl(tab.url) || isUrlAllowedForSession(tab.url))) {
            connectNative({ resetBackoff: true })
        }
    }).catch(() => {})
})

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeSession.tabId) {
        activeSession.tabId = null
        activeSession.windowId = null
        activeSession.prevZoomFactor = null
        saveState()
        postToDesktop({ type: 'tab_closed', bookId: activeSession.bookId, tabId })
    }
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'linden-save-selection' || !info.selectionText) return
    postToDesktop({
        type: 'selection_backflow',
        bookId: activeSession.bookId,
        selectionText: info.selectionText,
        pageUrl: info.pageUrl || tab?.url || '',
        title: tab?.title || '',
        tabId: tab?.id ?? null,
        windowId: tab?.windowId ?? null,
        capturedAt: Date.now()
    })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false
    if (msg.type === 'POPUP_GET_STATE') {
        if (!nativePort) connectNative()
        sendResponse({
            extensionId: chrome.runtime.id,
            nativeStatus,
            lastNativeError,
            session: activeSession
        })
        return false
    }
    if (msg.type === 'POPUP_CONNECT_NATIVE') {
        connectNative({ resetBackoff: true })
        setTimeout(() => {
            sendResponse({ nativeStatus, lastNativeError })
        }, 320)
        return true
    }
    if (msg.type === 'POPUP_BIND_ACTIVE_TAB') {
        chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
            if (!tab || !tab.url?.startsWith('https://')) {
                sendResponse({ ok: false, reason: 'not_https' })
                return
            }
            activeSession.tabId = tab.id
            activeSession.windowId = tab.windowId
            activeSession.expectedOrigin = originFromUrl(tab.url)
            await saveState()
            postToDesktop({
                type: 'tab_bound',
                bookId: activeSession.bookId,
                tabId: tab.id,
                windowId: tab.windowId,
                url: tab.url,
                title: tab.title || ''
            })
            sendResponse({ ok: true, tabId: tab.id, url: tab.url })
        })
        return true
    }
    if (msg.type === 'POPUP_UPDATE_PREFS') {
        (async () => {
            if (msg.compactMode !== undefined) activeSession.compactMode = Boolean(msg.compactMode)
            if (msg.zoomPercent !== undefined) activeSession.zoomPercent = Number(msg.zoomPercent) || 100
            if (msg.allowContextMenu !== undefined) activeSession.allowContextMenu = Boolean(msg.allowContextMenu)
            if (msg.relayPort !== undefined) activeSession.relayPort = msg.relayPort ? Number(msg.relayPort) : null
            if (msg.pairingToken !== undefined) activeSession.pairingToken = String(msg.pairingToken || '').trim()
            await saveState()
            syncContextMenu()
            refreshRelayLoop()
            if (activeSession.tabId != null) {
                await applyTabCompactStyle(activeSession.tabId, activeSession.compactMode, activeSession.providerId, activeSession.collapseSidebar)
                await applyTabZoom(activeSession.tabId, activeSession.zoomPercent, activeSession.compactMode)
            }
            sendResponse({ ok: true, session: activeSession })
        })()
        return true
    }
    return false
})

loadState().then(() => {
    connectNative()
    syncContextMenu()
    refreshRelayLoop()
})
