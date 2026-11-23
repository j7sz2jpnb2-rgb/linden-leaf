import { DomEvents } from './dom-events.js'
import { t } from './i18n.js'

/** Owns dialogs UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class UiDialogs {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}

    }

    initDOM() {
        this.dom = {
            globalToast: document.getElementById('global-toast'),
            globalToastIcon: document.getElementById('global-toast-icon'),
            globalToastMsg: document.getElementById('global-toast-msg'),
            globalModalBackdrop: document.getElementById('global-modal-backdrop'),
            globalModalTitle: document.getElementById('global-modal-title'),
            globalModalInput: document.getElementById('global-modal-input'),
            globalModalClose: document.getElementById('global-modal-close'),
            globalModalCancel: document.getElementById('global-modal-cancel'),
            globalModalConfirm: document.getElementById('global-modal-confirm')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;

    }

    dispose() { this.events.dispose(); this._bound = false }

    showToast(msg, icon = 'info', duration = 2500) {
        if (!this.dom.globalToast) return
        if (this._toastTimer) clearTimeout(this._toastTimer)
        if (typeof icon === 'number') {
            duration = icon
            icon = 'info'
        }

        const toastSvgMap = {
            'success': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
            'error': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
            'warning': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
            'info': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-primary, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
            'cloud': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#6a9bcc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>',
            'book': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-primary, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
            'delete': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
            'list': '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-primary, #da7756)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>'
        }

        // Automatic mapping from legacy icons
        let mappedKey = 'info'
        if (icon === '⚠️' || icon === 'warning') mappedKey = 'warning'
        else if (icon === '🔴' || icon === 'error') mappedKey = 'error'
        else if (icon === '🟢' || icon === '🎉' || icon === '✓' || icon === '🌱' || icon === '✅' || icon === '⭐' || icon === '💾' || icon === 'success') mappedKey = 'success'
        else if (icon === '🗑️' || icon === 'delete') mappedKey = 'delete'
        else if (icon === '☁️' || icon === 'cloud' || icon === '⏳') mappedKey = 'cloud'
        else if (icon === '📖' || icon === 'book') mappedKey = 'book'
        else if (icon === '📑' || icon === 'list') mappedKey = 'list'
        else if (icon === '📋' || icon === 'copy') mappedKey = 'success'
        else if (icon === '📝') mappedKey = 'info'
        else if (toastSvgMap[icon]) mappedKey = icon

        if (this.dom.globalToastIcon) {
            this.dom.globalToastIcon.innerHTML = toastSvgMap[mappedKey] || toastSvgMap['info']
        }
        if (this.dom.globalToastMsg) this.dom.globalToastMsg.innerText = typeof msg === 'string' ? msg : String(msg || '')
        this.dom.globalToast.style.display = 'flex'
        requestAnimationFrame(() => {
            this.dom.globalToast?.classList.add('show')
        })
        this._toastTimer = setTimeout(() => {
            this.dom.globalToast?.classList.remove('show')
            setTimeout(() => {
                if (!this.dom.globalToast?.classList.contains('show')) {
                    this.dom.globalToast.style.display = 'none'
                }
            }, 250)
        }, duration)
    }

    showInputDialog({ title = t('dialog.inputTitle'), message = '', placeholder = '', value = '', isMultiline = false, hideInput = false, confirmText = t('common.confirm'), cancelText = t('common.cancel') }) {
        return new Promise(resolve => {
            if (!this.dom.globalModalBackdrop) {
                const res = prompt(title, value)
                return resolve(res)
            }

            // Cleanup any previously active instance and resolve its pending
            // promise with null, so awaiters never hang forever
            if (this._inputDialogCleanup) {
                this._inputDialogCleanup()
                this._inputDialogCleanup = null
                if (this._inputDialogActiveClose) {
                    const prevClose = this._inputDialogActiveClose
                    this._inputDialogActiveClose = null
                    prevClose(null)
                }
            }

            const modalCard = this.dom.globalModalBackdrop.querySelector('.global-modal-card')
            if (modalCard) modalCard.classList.toggle('is-confirm-only', Boolean(hideInput))

            if (this.dom.globalModalTitle) this.dom.globalModalTitle.innerText = title
            if (this.dom.globalModalInput) {
                this.dom.globalModalInput.placeholder = placeholder
                this.dom.globalModalInput.value = value || ''
                this.dom.globalModalInput.rows = isMultiline ? 4 : 1
                this.dom.globalModalInput.classList.toggle('is-singleline', !isMultiline)
                this.dom.globalModalInput.style.display = hideInput ? 'none' : ''
            }
            if (this.dom.globalModalConfirm) this.dom.globalModalConfirm.innerText = confirmText
            if (this.dom.globalModalCancel) this.dom.globalModalCancel.innerText = cancelText

            const description = document.getElementById('global-modal-description')
            if (description) { description.textContent = message; description.hidden = !message }
            const previousFocus = document.activeElement
            let isResolved = false
            const close = (result) => {
                if (isResolved) return
                isResolved = true
                if (this._inputDialogActiveClose === close) this._inputDialogActiveClose = null
                this.dom.globalModalBackdrop?.classList.remove('show')
                setTimeout(() => {
                    if (this.dom.globalModalBackdrop && !this.dom.globalModalBackdrop.classList.contains('show')) {
                        this.dom.globalModalBackdrop.style.display = 'none'
                    }
                }, 200)
                cleanup()
                if (previousFocus?.isConnected) previousFocus.focus?.()
                resolve(result)
            }
            this._inputDialogActiveClose = close

            const onConfirm = () => {
                const val = this.dom.globalModalInput?.value ?? ''
                close(val)
            }

            const onCancel = () => close(null)

            const onKeydown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                } else if (e.key === 'Enter' && (!isMultiline || e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    onConfirm()
                }
            }

            const cleanup = () => {
                this.dom.globalModalConfirm?.removeEventListener('click', onConfirm)
                this.dom.globalModalCancel?.removeEventListener('click', onCancel)
                this.dom.globalModalClose?.removeEventListener('click', onCancel)
                this.dom.globalModalInput?.removeEventListener('keydown', onKeydown)
                this._inputDialogCleanup = null
            }

            this._inputDialogCleanup = cleanup

            this.dom.globalModalConfirm?.addEventListener('click', onConfirm)
            this.dom.globalModalCancel?.addEventListener('click', onCancel)
            this.dom.globalModalClose?.addEventListener('click', onCancel)
            this.dom.globalModalInput?.addEventListener('keydown', onKeydown)

            this.app.annotations.hideSelectionPopup?.(true)
            if (this.app.annotations.dom.highlightActionPopup) {
                this.app.annotations.dom.highlightActionPopup.style.display = 'none'
            }
            if (this.app.cards.dom.readerDictionaryCard) {
                this.app.cards.dom.readerDictionaryCard.classList.remove('active')
                this.app.cards.dom.readerDictionaryCard.style.display = 'none'
            }

            this.dom.globalModalBackdrop.style.display = 'flex'
            this.dom.globalModalBackdrop.classList.add('show')
            requestAnimationFrame(() => {
                if (isResolved) return
                if (hideInput) this.dom.globalModalCancel?.focus()
                else { this.dom.globalModalInput?.focus(); this.dom.globalModalInput?.select() }
            })
        })
    }

    showConfirmDialog(title, message = '') {
        return this.showInputDialog({
            title,
            message,
            hideInput: true,
            confirmText: t('common.confirm'),
            cancelText: t('common.cancel')
        }).then(result => result != null)
    }

    async showReaderFieldsDialog(title, fields) {
        return await new Promise(resolve => {
            const previousFocus = document.activeElement
            const backdrop = document.createElement('div')
            backdrop.className = 'global-modal-backdrop show'
            backdrop.style.zIndex = '100000'
            const form = document.createElement('form')
            form.className = 'global-modal-card'
            form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-label', title)
            form.style.cssText = 'width:min(480px,100%);max-height:90vh;overflow:auto;opacity:1;transform:none;'
            const heading = document.createElement('h2')
            heading.className = 'global-modal-title'
            heading.style.margin = '0 0 6px'
            heading.textContent = title; form.append(heading)
            const inputs = {}
            for (const field of fields) {
                const label = document.createElement('label'); label.style.cssText = 'display:block;margin:8px 0;font-size:13.5px;color:var(--text-secondary);'
                const name = document.createElement('span'); name.style.cssText = 'display:block;margin-bottom:5px;font-weight:500;'; name.textContent = field.label; label.append(name)
                const input = document.createElement(field.options ? 'select' : 'input')
                input.className = 'leaf-modal-input'
                input.name = field.name; input.style.cssText = 'display:block;box-sizing:border-box;width:100%;padding:8px 10px;'
                if (field.options) {
                    for (const option of field.options) { const el = document.createElement('option'); el.value = option.value; el.textContent = option.label; input.append(el) }
                } else {
                    input.type = field.type || 'text'
                    if (field.min != null) input.min = String(field.min)
                    if (field.max != null) input.max = String(field.max)
                    if (field.step != null) input.step = String(field.step)
                    if (field.required) input.required = true
                }
                input.value = String(field.value ?? '')
                label.append(input); form.append(label); inputs[field.name] = input
            }
            const error = document.createElement('div'); error.setAttribute('role','alert'); error.style.cssText = 'color:var(--danger-color,#b91c1c);font-size:13px;'; form.append(error)
            const actions = document.createElement('div'); actions.className = 'global-modal-footer'; actions.style.marginTop = '8px'
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn-secondary-action'; cancel.textContent = t('common.cancel')
            const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn-primary-action'; submit.textContent = t('dialog.saveBtn')
            actions.append(cancel, submit); form.append(actions); backdrop.append(form); document.body.append(backdrop)
            let done = false
            const finish = value => { if (done) return; done = true; backdrop.remove(); previousFocus?.focus?.(); resolve(value) }
            cancel.addEventListener('click', () => finish(null))
            backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(null) })
            form.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); finish(null) }
                if (event.key === 'Tab') {
                    const focusable = [...form.querySelectorAll('input,select,button')].filter(x => !x.disabled)
                    const first = focusable[0], last = focusable[focusable.length - 1]
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
                }
            })
            form.addEventListener('submit', event => {
                event.preventDefault()
                const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]))
                const message = fields.validate?.(values)
                if (message) { error.textContent = message; return }
                finish(values)
            })
            Object.values(inputs)[0]?.focus()
        })
    }

    async promptPasswordModal(title = t('dialog.pdfPasswordTitle')) {
        return new Promise(resolve => {
            if (typeof document === 'undefined') return resolve(null)
            const previousFocus = document.activeElement
            const overlay = document.createElement('div')
            overlay.className = 'modal-backdrop show password-prompt-backdrop'
            overlay.setAttribute('role', 'dialog')
            overlay.setAttribute('aria-modal', 'true')
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:var(--ime-bottom, 0px);padding:max(16px, var(--safe-top, 0px)) 16px max(16px, var(--safe-bottom, 0px));box-sizing:border-box;overflow-y:auto;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:100005;'

            const card = document.createElement('div')
            card.style.cssText = 'background:var(--bg-card, #ffffff);color:var(--text-main, #333333);padding:24px;border-radius:12px;width:min(340px, calc(100vw - 32px));max-height:100%;overflow-y:auto;margin:auto;box-sizing:border-box;box-shadow:0 8px 24px rgba(0,0,0,0.25);display:flex;flex-direction:column;gap:16px;'

            const heading = document.createElement('h3')
            heading.style.cssText = 'margin:0;font-size:1.1rem;font-weight:600;'
            heading.innerText = title

            const input = document.createElement('input')
            input.type = 'password'
            input.placeholder = t('dialog.pdfPasswordPlaceholder')
            input.style.cssText = 'padding:10px 12px;min-height:44px;box-sizing:border-box;border:1px solid var(--border-color, #ccc);border-radius:6px;font-size:0.95rem;background:var(--bg-input, #fff);color:inherit;'

            const btnRow = document.createElement('div')
            btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;'

            const cancelBtn = document.createElement('button')
            cancelBtn.type = 'button'
            cancelBtn.className = 'modal-close'
            cancelBtn.setAttribute('data-modal-dismiss', 'true')
            cancelBtn.innerText = t('common.cancel')
            cancelBtn.style.cssText = 'min-height:44px;padding:8px 16px;border:1px solid var(--border-color, #ccc);background:transparent;color:inherit;border-radius:6px;cursor:pointer;'

            const confirmBtn = document.createElement('button')
            confirmBtn.type = 'button'
            confirmBtn.innerText = t('common.confirm')
            confirmBtn.style.cssText = 'min-height:44px;padding:8px 16px;border:none;background:var(--accent-primary, #da7756);color:#fff;border-radius:8px;cursor:pointer;'

            let settled = false
            const onGlobalKeyDown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    cleanup(null)
                }
            }
            const cleanup = (val) => {
                if (settled) return
                settled = true
                overlay.classList.remove('show')
                try { window.removeEventListener('keydown', onGlobalKeyDown, true) } catch (_) {}
                try { document.body.removeChild(overlay) } catch (_) {}
                try { previousFocus?.focus?.() } catch (_) {}
                resolve(val)
            }

            cancelBtn.onclick = () => cleanup(null)
            confirmBtn.onclick = () => cleanup(input.value !== '' ? input.value : '')
            overlay.onclick = (e) => {
                if (e.target === overlay) cleanup(null)
            }
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault()
                    cleanup(input.value !== '' ? input.value : '')
                }
                if (e.key === 'Escape') {
                    e.preventDefault()
                    cleanup(null)
                }
            }
            window.addEventListener('keydown', onGlobalKeyDown, true)

            btnRow.appendChild(cancelBtn)
            btnRow.appendChild(confirmBtn)
            card.appendChild(heading)
            card.appendChild(input)
            card.appendChild(btnRow)
            overlay.appendChild(card)
            document.body.appendChild(overlay)
            requestAnimationFrame(() => {
                if (!settled) input.focus()
            })
        })
    }
}
