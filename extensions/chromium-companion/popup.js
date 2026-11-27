const statusPill = document.getElementById('ext-status-pill')
const btnReconnectNative = document.getElementById('btn-reconnect-native')
const extIdCode = document.getElementById('ext-id-code')
const btnCopyExtId = document.getElementById('btn-copy-ext-id')
const extNativeErr = document.getElementById('ext-native-err')
const btnBindCurrent = document.getElementById('btn-bind-current')
const extBoundUrl = document.getElementById('ext-bound-url')
const chkCompact = document.getElementById('chk-compact')
const selZoom = document.getElementById('sel-zoom')
const chkContextMenu = document.getElementById('chk-context-menu')
const inpRelayPort = document.getElementById('inp-relay-port')
const inpPairingToken = document.getElementById('inp-pairing-token')
const btnSaveRelay = document.getElementById('btn-save-relay')

async function refresh() {
    const state = await chrome.runtime.sendMessage({ type: 'POPUP_GET_STATE' })
    extIdCode.textContent = state?.extensionId || chrome.runtime.id
    if (state?.nativeStatus === 'connected') {
        statusPill.textContent = 'Native 已连接'
        statusPill.className = 'll-ext-pill is-ok'
        extNativeErr.textContent = ''
    } else if (state?.nativeStatus === 'bridge_inactive') {
        statusPill.textContent = '等待阅读器启动伴读'
        statusPill.className = 'll-ext-pill'
        extNativeErr.textContent = '宿主已注册。在 Linden Leaf 中开启伴读窗或发送引用时会自动连接。'
    } else {
        statusPill.textContent = state?.session?.relayPort ? '本地配对中' : '未连接宿主'
        statusPill.className = 'll-ext-pill is-err'
        extNativeErr.textContent = state?.lastNativeError
            ? `提示: ${state.lastNativeError}`
            : '请在 Linden Leaf「AI 伴读设置」粘贴上方扩展 ID 并点击注册。'
    }
    const session = state?.session || {}
    extBoundUrl.textContent = session.expectedOrigin
        ? `${session.expectedOrigin}${session.tabId != null ? ` (Tab #${session.tabId})` : ''}`
        : '尚未绑定（可点击右侧绑定当前伴读页）'
    chkCompact.checked = Boolean(session.compactMode)
    selZoom.value = String(session.zoomPercent || 100)
    chkContextMenu.checked = Boolean(session.allowContextMenu)
    inpRelayPort.value = session.relayPort || ''
    inpPairingToken.value = session.pairingToken || ''
}

btnReconnectNative?.addEventListener('click', async () => {
    btnReconnectNative.disabled = true
    btnReconnectNative.textContent = '连接中…'
    try {
        await chrome.runtime.sendMessage({ type: 'POPUP_CONNECT_NATIVE' })
        await refresh()
    } finally {
        btnReconnectNative.disabled = false
        btnReconnectNative.textContent = '重连'
    }
})

btnCopyExtId.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(chrome.runtime.id)
        btnCopyExtId.textContent = '已复制'
        setTimeout(() => { btnCopyExtId.textContent = '复制' }, 1500)
    } catch (_) {}
})

btnBindCurrent.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'POPUP_BIND_ACTIVE_TAB' })
    if (res?.ok) await refresh()
})

chkCompact.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'POPUP_UPDATE_PREFS', compactMode: chkCompact.checked })
})

selZoom.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'POPUP_UPDATE_PREFS', zoomPercent: Number(selZoom.value) })
})

chkContextMenu.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ type: 'POPUP_UPDATE_PREFS', allowContextMenu: chkContextMenu.checked })
})

btnSaveRelay.addEventListener('click', async () => {
    const port = Number(inpRelayPort.value) || null
    const token = inpPairingToken.value.trim()
    if (port && chrome.permissions?.request) {
        await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] }).catch(() => false)
    }
    await chrome.runtime.sendMessage({
        type: 'POPUP_UPDATE_PREFS',
        relayPort: port,
        pairingToken: token
    })
    await chrome.runtime.sendMessage({ type: 'POPUP_CONNECT_NATIVE' })
    await refresh()
})

refresh()
