import assert from 'node:assert/strict'

globalThis.HTMLElement = class {}
globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }
globalThis.customElements = { get() {}, define() {} }
let channel
globalThis.BroadcastChannel = class {
    constructor() { channel = this }
    addEventListener(_event, listener) { this.listener = listener }
    postMessage() {}
}
const nodes = new Map()
const presets = ['jianguoyun', 'google_drive'].map(name => ({
    dataset: { preset: name },
    classList: {
        active: name === 'google_drive',
        toggle(_name, active) { this.active = active },
    },
}))
globalThis.document = {
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '.btn-sync-preset' ? presets : [],
    querySelector: () => null,
    documentElement: { dataset: {}, style: {} },
}

const { setLocale, onLocaleChange, subscribeLocaleSync, t, getLocale } = await import('../js/i18n.js')
const { BookDetailsModal } = await import('../js/book-details.js')
const { SyncController } = await import('../js/sync-controller.js')

for (const locale of ['zh-CN', 'en']) {
    setLocale(locale, { persist: false, broadcast: false, applyDom: false })
    for (const tags of [[], ['tag "<&']]) {
        const modal = new BookDetailsModal()
        modal.getBookStats = async () => ({ book: { id: 'test', title: 'Title "<&', author: 'Example', format: 'txt', tags, progress: { fraction: 0.2 } }, totalSeconds: 60, totalMinutes: 1, readingDaysCount: 1, notesCount: 0 })
        const container = { innerHTML: '', querySelector() { return null }, querySelectorAll() { return [] } }
        await modal.render(container, 'test')
        assert.ok(container.innerHTML.includes('Title &quot;&lt;&amp;'))
        if (tags.length) {
            assert.ok(container.innerHTML.includes('tag &quot;&lt;&amp;'))
            assert.ok(container.innerHTML.includes(t('bookDetails.filterByTagTitle')))
        } else {
            assert.ok(container.innerHTML.includes(t('bookDetails.noTags')))
        }
    }
}
console.log('[PASS] Book details: both languages, empty and escaped tagged books')

const server = { value: 'https://draft.example', selectionStart: 3, selectionEnd: 7 }
const user = { value: 'draft-user' }
const password = { value: 'draft-password', type: 'text', placeholder: '' }
const dir = { value: 'draft-dir' }
const folder = { value: 'draft-folder' }
const client = { value: 'draft-client' }
const checkbox = { checked: true }
const button = { title: '', innerHTML: 'visible-icon', setAttribute(key, value) { this[key] = value } }
const status = { innerText: '', style: {} }
nodes.set('sync-input-local-folder', folder)
nodes.set('sync-input-client-id', client)
nodes.set('sync-oauth-include-user-files', checkbox)
document.activeElement = server
const sync = Object.create(SyncController.prototype)
Object.assign(sync, {
    dom: { syncInputServer: server, syncInputUsername: user, syncInputPassword: password, syncInputDir: dir, btnToggleSyncPwd: button, syncStatusTitle: status },
    syncConfig: { enabled: false, serverUrl: 'https://saved.example', username: 'saved', password: 'saved', remoteDir: 'saved', serverType: 'jianguoyun' },
})
setLocale('zh-CN', { persist: false, broadcast: false, applyDom: false })
const unsubscribe = onLocaleChange(() => sync.refreshLocale())
subscribeLocaleSync()
channel.listener({ data: { type: 'LOCALE_CHANGED', locale: 'en' } })
assert.equal(getLocale(), 'en')
assert.deepEqual([server.value, user.value, password.value, dir.value, folder.value, client.value, checkbox.checked], ['https://draft.example', 'draft-user', 'draft-password', 'draft-dir', 'draft-folder', 'draft-client', true])
assert.equal(document.activeElement, server)
assert.deepEqual([server.selectionStart, server.selectionEnd], [3, 7])
assert.equal(password.type, 'text')
assert.equal(presets[1].classList.active, true)
assert.equal(presets[0].classList.active, false)
assert.equal(button.innerHTML, 'visible-icon')
assert.equal(button.title, t('syncCtrl.hidePwd'))
assert.equal(status.innerText, t('syncCtrl.statusNever'))
sync.refreshSyncStatusUI()
assert.equal(server.value, 'https://draft.example')
sync.renderSyncUI()
assert.equal(server.value, 'https://saved.example')
assert.equal(password.type, 'password')
assert.equal(presets[0].classList.active, true)
assert.equal(presets[1].classList.active, false)
unsubscribe()
console.log('[PASS] Cross-window locale refresh preserves unsaved sync form and localizes status; initial render loads saved settings')
