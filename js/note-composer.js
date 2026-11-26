/**
 * note-composer.js
 * Non-blocking, warm-paper floating Note Composer + Sidebar inline editor handoff.
 *
 * Replaces the full-screen blocking input modal when adding or editing reading notes so
 * users can keep reading, scrolling, and flipping pages while composing thoughts.
 * Follows Linden Leaf's existing floating-card visual language (#reader-dictionary-card /
 * #reader-para-translation-card): warm raised surface, 1px hairline border, no backdrop mask.
 */

import { t } from './i18n.js'
import { escapeHTML } from './ui-format.js'
import { HIGHLIGHT_PALETTE, getHighlightUiHex, normalizeHighlightColor } from './highlight-palette.js'

const COMPOSER_COLORS = HIGHLIGHT_PALETTE.map(c => ({
    value: c.storageHex,
    labelKey: c.labelKey,
    fallback: c.fallbackLabel,
    uiHex: c.uiHex,
    uiHexDark: c.uiHexDark,
}))

export class NoteComposer {
    constructor(app) {
        this.app = app
        this._card = null
        this._activeSession = null
        this._isDragging = false
        this._isSaving = false
        this._dragOffset = { x: 0, y: 0 }
        this._hasCustomPosition = false
        this._boundKeydown = this._onKeydown.bind(this)
    }

    get isOpen() {
        return Boolean(this._activeSession)
    }

    _isMobileEnv() {
        return Boolean(
            window.platformBridge?.isAndroid ||
            window.mobileShell?.isMobileViewport?.() ||
            document.documentElement?.classList?.contains('is-mobile-viewport') ||
            window.innerWidth <= 640
        )
    }

    _ensureCardDom() {
        if (this._card && document.body.contains(this._card)) return this._card
        let card = document.getElementById('reader-note-composer-card')
        if (!card) {
            card = document.createElement('aside')
            card.id = 'reader-note-composer-card'
            card.className = 'reader-note-composer-card'
            card.setAttribute('role', 'dialog')
            card.setAttribute('aria-modal', 'false')
            card.hidden = true
            card.innerHTML = `
                <div class="note-composer-header" id="note-composer-drag-handle">
                    <div class="note-composer-title-wrap">
                        <span class="note-composer-grip" aria-hidden="true">⋮⋮</span>
                        <span class="note-composer-title" id="note-composer-title"></span>
                    </div>
                    <div class="note-composer-header-actions">
                        <button type="button" class="note-composer-icon-btn" id="btn-note-composer-dock" title=""></button>
                        <button type="button" class="note-composer-icon-btn note-composer-close-btn" id="btn-note-composer-close" aria-label="Close">×</button>
                    </div>
                </div>
                <div class="note-composer-quote-wrap" id="note-composer-quote-wrap">
                    <div class="note-composer-quote-text" id="note-composer-quote-text"></div>
                </div>
                <div class="note-composer-colors" id="note-composer-colors" role="radiogroup"></div>
                <textarea class="note-composer-textarea" id="note-composer-textarea" rows="4"></textarea>
                <div class="note-composer-footer">
                    <span class="note-composer-shortcut-hint" id="note-composer-shortcut-hint"></span>
                    <div class="note-composer-footer-actions">
                        <button type="button" class="btn-secondary-action note-composer-btn-cancel" id="btn-note-composer-cancel"></button>
                        <button type="button" class="btn-primary-action note-composer-btn-save" id="btn-note-composer-save"></button>
                    </div>
                </div>
            `
            document.body.appendChild(card)
            this._wireCardEvents(card)
        }
        this._card = card
        return card
    }

    _wireCardEvents(card) {
        const handle = card.querySelector('#note-composer-drag-handle')
        const btnClose = card.querySelector('#btn-note-composer-close')
        const btnCancel = card.querySelector('#btn-note-composer-cancel')
        const btnSave = card.querySelector('#btn-note-composer-save')
        const btnDock = card.querySelector('#btn-note-composer-dock')
        const textarea = card.querySelector('#note-composer-textarea')
        const quoteWrap = card.querySelector('#note-composer-quote-wrap')

        btnClose?.addEventListener('click', () => this.cancel())
        btnCancel?.addEventListener('click', () => this.cancel())
        btnSave?.addEventListener('click', () => this._commit())
        btnDock?.addEventListener('click', () => this._handoffToSidebar())
        quoteWrap?.addEventListener('click', () => {
            quoteWrap.classList.toggle('is-expanded')
        })

        textarea?.addEventListener('input', () => {
            this._autoResizeTextarea(textarea)
        })
        textarea?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                this._commit()
            } else if (e.key === 'Escape') {
                e.preventDefault()
                this.cancel()
            }
        })

        // Draggable header on desktop so user can freely move the card anywhere on screen
        handle?.addEventListener('pointerdown', (e) => {
            if (this._isMobileEnv() || card.classList.contains('is-mobile-sheet')) return
            if (e.target.closest('button')) return
            if (e.button !== 0 && e.pointerType === 'mouse') return
            this._isDragging = true
            this._hasCustomPosition = true
            const rect = card.getBoundingClientRect()
            this._dragOffset = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            }
            card.classList.add('is-dragging')
            try { handle.setPointerCapture?.(e.pointerId) } catch (_) {}
        })

        handle?.addEventListener('pointermove', (e) => {
            if (!this._isDragging) return
            const vw = window.innerWidth
            const vh = window.innerHeight
            const rect = card.getBoundingClientRect()
            const nextLeft = Math.max(8, Math.min(vw - rect.width - 8, e.clientX - this._dragOffset.x))
            const nextTop = Math.max(8, Math.min(vh - rect.height - 8, e.clientY - this._dragOffset.y))
            card.style.left = `${nextLeft}px`
            card.style.top = `${nextTop}px`
            card.style.right = 'auto'
            card.style.bottom = 'auto'
        })

        const stopDrag = (e) => {
            if (!this._isDragging) return
            this._isDragging = false
            card.classList.remove('is-dragging')
            try { handle.releasePointerCapture?.(e.pointerId) } catch (_) {}
        }
        handle?.addEventListener('pointerup', stopDrag)
        handle?.addEventListener('pointercancel', stopDrag)
    }

    _autoResizeTextarea(el) {
        if (!el) return
        el.style.height = 'auto'
        const maxH = Math.min(260, Math.max(120, window.innerHeight * 0.34))
        el.style.height = `${Math.min(maxH, Math.max(88, el.scrollHeight))}px`
    }

    _onKeydown(e) {
        if (e.defaultPrevented || !this._activeSession || this._isSaving) return
        if (e.key === 'Escape') {
            e.preventDefault()
            this.cancel()
        }
    }

    /**
     * Open the non-blocking note composer (floating popover, or inline in sidebar if requested).
     * @param {Object} options
     * @param {string} [options.title]
     * @param {string} [options.quoteText]
     * @param {string} [options.initialNote]
     * @param {string} [options.initialColor]
     * @param {boolean} [options.showColorPicker=true]
     * @param {DOMRect|Object|null} [options.anchorRect]
     * @param {boolean} [options.preferSidebar=false]
     * @param {Function} options.onSave - async ({ note, color }) => void
     * @param {Function} [options.onCancel]
     */
    open(options = {}) {
        this.close(false)

        const isDarkTheme = ['dark', 'black'].includes(document.documentElement?.getAttribute?.('data-theme'))
        const canonicalColor = normalizeHighlightColor(options.initialColor || '#facc15')
        const session = {
            title: options.title || t('annotations.addNoteTitle'),
            quoteText: String(options.quoteText || '').trim(),
            note: String(options.initialNote || ''),
            color: canonicalColor,
            uiColor: getHighlightUiHex(canonicalColor, isDarkTheme),
            showColorPicker: options.showColorPicker !== false,
            anchorRect: options.anchorRect || null,
            onSave: options.onSave,
            onCancel: options.onCancel,
            mode: 'floating',
        }
        this._activeSession = session

        const isMobile = this._isMobileEnv()
        const isDrawerNotesVisible = !isMobile && Boolean(
            this.app?.annotations?.dom?.sidebarDrawer?.classList?.contains('open') &&
            document.getElementById('panel-notes')?.classList?.contains('active')
        )

        if (!isMobile && (options.preferSidebar || isDrawerNotesVisible)) {
            this._renderSidebarInlineComposer(session)
            return
        }

        this._renderFloatingCard(session)
    }

    _renderFloatingCard(session) {
        session.mode = 'floating'
        this._clearSidebarInlineComposer()

        const card = this._ensureCardDom()
        const titleEl = card.querySelector('#note-composer-title')
        const dockBtn = card.querySelector('#btn-note-composer-dock')
        const quoteWrap = card.querySelector('#note-composer-quote-wrap')
        const quoteEl = card.querySelector('#note-composer-quote-text')
        const colorsWrap = card.querySelector('#note-composer-colors')
        const textarea = card.querySelector('#note-composer-textarea')
        const hintEl = card.querySelector('#note-composer-shortcut-hint')
        const cancelBtn = card.querySelector('#btn-note-composer-cancel')
        const saveBtn = card.querySelector('#btn-note-composer-save')

        const isMobile = this._isMobileEnv()
        const isDarkTheme = ['dark', 'black'].includes(document.documentElement?.getAttribute?.('data-theme'))
        card.classList.toggle('is-mobile-sheet', isMobile)

        if (titleEl) titleEl.textContent = session.title
        if (dockBtn) {
            dockBtn.hidden = isMobile
            dockBtn.textContent = t('noteComposer.dockToSidebar')
            dockBtn.title = t('noteComposer.dockToSidebarTitle')
        }
        if (quoteWrap && quoteEl) {
            if (session.quoteText) {
                quoteWrap.hidden = false
                quoteWrap.classList.remove('is-expanded')
                quoteEl.textContent = `“${session.quoteText}”`
                quoteWrap.style.borderLeftColor = getHighlightUiHex(session.color, isDarkTheme)
            } else {
                quoteWrap.hidden = true
            }
        }

        if (colorsWrap) {
            colorsWrap.hidden = !session.showColorPicker
            colorsWrap.innerHTML = ''
            if (session.showColorPicker) {
                COMPOSER_COLORS.forEach(c => {
                    const uiHex = getHighlightUiHex(c.value, isDarkTheme)
                    const dot = document.createElement('button')
                    dot.type = 'button'
                    dot.className = `note-composer-color-dot${normalizeHighlightColor(session.color) === c.value ? ' active' : ''}`
                    dot.style.background = uiHex
                    dot.dataset.color = c.value
                    dot.title = t(c.labelKey) || c.fallback
                    dot.setAttribute('aria-label', dot.title)
                    dot.addEventListener('click', () => {
                        session.color = c.value
                        colorsWrap.querySelectorAll('.note-composer-color-dot').forEach(b => {
                            b.classList.toggle('active', b === dot)
                        })
                        if (quoteWrap) quoteWrap.style.borderLeftColor = uiHex
                    })
                    colorsWrap.appendChild(dot)
                })
            }
        }

        if (textarea) {
            textarea.value = session.note
            textarea.placeholder = t('annotations.addNotePlaceholder')
        }
        if (hintEl) {
            hintEl.hidden = isMobile
            hintEl.textContent = t('noteComposer.shortcutHint')
        }
        if (cancelBtn) cancelBtn.textContent = t('common.cancel')
        if (saveBtn) saveBtn.textContent = t('common.save')

        card.hidden = false
        this._hasCustomPosition = false
        if (isMobile) {
            // Let mobile-shell.css dock the sheet cleanly above --ime-bottom and --safe-bottom
            card.style.left = ''
            card.style.top = ''
            card.style.right = ''
            card.style.bottom = ''
            card.style.width = ''
        } else {
            this._positionCardSafely(card, session.anchorRect)
        }
        document.addEventListener('keydown', this._boundKeydown)

        requestAnimationFrame(() => {
            if (textarea) {
                this._autoResizeTextarea(textarea)
                textarea.focus()
                textarea.setSelectionRange(textarea.value.length, textarea.value.length)
            }
        })
    }

    _positionCardSafely(card, anchorRect) {
        const vw = window.innerWidth
        const vh = window.innerHeight
        const isCompact = vw <= 640
        const margin = isCompact ? 10 : 18
        const cardW = Math.min(360, vw - margin * 2)
        card.style.width = `${cardW}px`

        // Measure approximate height after showing
        const rectH = card.offsetHeight || 270
        let left = vw - cardW - margin
        let top = vh - rectH - margin - 24

        if (!isCompact && anchorRect && Number.isFinite(anchorRect.top)) {
            const selTop = anchorRect.top
            const selBottom = (anchorRect.bottom != null ? anchorRect.bottom : anchorRect.top + (anchorRect.height || 24))
            const selCenterX = (anchorRect.left || 0) + ((anchorRect.width || 80) / 2)

            // Prefer placing cleanly below or above the selected passage so the quoted line is NEVER covered
            const spaceBelow = vh - selBottom - margin
            const spaceAbove = selTop - 56 - margin
            if (spaceBelow >= rectH + 14) {
                top = selBottom + 14
                left = Math.max(margin, Math.min(vw - cardW - margin, selCenterX - cardW / 2))
            } else if (spaceAbove >= rectH + 14) {
                top = selTop - rectH - 14
                left = Math.max(margin, Math.min(vw - cardW - margin, selCenterX - cardW / 2))
            } else {
                // Place on the opposite horizontal side of the selection so the passage remains completely unobstructed
                const selOnLeftHalf = selCenterX < vw * 0.5
                left = selOnLeftHalf ? (vw - cardW - margin) : margin
                top = Math.max(60, Math.min(vh - rectH - margin, Math.round((vh - rectH) * 0.5)))
            }
        } else if (isCompact) {
            left = Math.max(margin, Math.round((vw - cardW) / 2))
            top = Math.max(56, vh - rectH - margin)
        }

        card.style.left = `${Math.round(left)}px`
        card.style.top = `${Math.round(top)}px`
        card.style.right = 'auto'
        card.style.bottom = 'auto'
    }

    _handoffToSidebar() {
        if (this._isMobileEnv()) return
        const session = this._activeSession
        if (!session) return
        const textarea = this._card?.querySelector('#note-composer-textarea')
        if (textarea) session.note = textarea.value
        if (this._card) this._card.hidden = true
        this._renderSidebarInlineComposer(session)
    }

    _renderSidebarInlineComposer(session) {
        session.mode = 'sidebar'
        this.app?.annotations?.openDrawer?.('notes')
        const container = this.app?.annotations?.dom?.notesContainer
        if (!container) {
            this._renderFloatingCard(session)
            return
        }

        this._clearSidebarInlineComposer()

        const isDarkTheme = ['dark', 'black'].includes(document.documentElement?.getAttribute?.('data-theme'))
        const accentHex = getHighlightUiHex(session.color, isDarkTheme)
        const box = document.createElement('div')
        box.id = 'sidebar-inline-note-composer'
        box.className = 'sidebar-inline-note-composer'
        box.innerHTML = `
            <div class="inline-composer-header">
                <span class="inline-composer-title">${escapeHTML(session.title)}</span>
                <button type="button" class="note-composer-icon-btn inline-composer-popout" title="${escapeHTML(t('noteComposer.popoutTitle'))}">${escapeHTML(t('noteComposer.popoutBtn'))}</button>
            </div>
            ${session.quoteText ? `<div class="inline-composer-quote" style="border-left-color: ${escapeHTML(accentHex)};">“${escapeHTML(session.quoteText)}”</div>` : ''}
            ${session.showColorPicker ? `<div class="note-composer-colors inline-composer-colors"></div>` : ''}
            <textarea class="note-composer-textarea inline-composer-textarea" rows="4" placeholder="${escapeHTML(t('annotations.addNotePlaceholder'))}"></textarea>
            <div class="note-composer-footer">
                <span class="note-composer-shortcut-hint">${escapeHTML(t('noteComposer.shortcutHint'))}</span>
                <div class="note-composer-footer-actions">
                    <button type="button" class="btn-secondary-action inline-composer-cancel">${escapeHTML(t('common.cancel'))}</button>
                    <button type="button" class="btn-primary-action inline-composer-save">${escapeHTML(t('common.save'))}</button>
                </div>
            </div>
        `

        const colorsWrap = box.querySelector('.inline-composer-colors')
        const quoteEl = box.querySelector('.inline-composer-quote')
        if (colorsWrap) {
            COMPOSER_COLORS.forEach(c => {
                const uiHex = getHighlightUiHex(c.value, isDarkTheme)
                const dot = document.createElement('button')
                dot.type = 'button'
                dot.className = `note-composer-color-dot${normalizeHighlightColor(session.color) === c.value ? ' active' : ''}`
                dot.style.background = uiHex
                dot.title = t(c.labelKey) || c.fallback
                dot.addEventListener('click', () => {
                    session.color = c.value
                    colorsWrap.querySelectorAll('.note-composer-color-dot').forEach(b => b.classList.toggle('active', b === dot))
                    if (quoteEl) quoteEl.style.borderLeftColor = uiHex
                })
                colorsWrap.appendChild(dot)
            })
        }

        const textarea = box.querySelector('.inline-composer-textarea')
        if (textarea) {
            textarea.value = session.note
            textarea.addEventListener('input', () => this._autoResizeTextarea(textarea))
            textarea.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault()
                    this._commit()
                } else if (e.key === 'Escape') {
                    e.preventDefault()
                    this.cancel()
                }
            })
        }

        box.querySelector('.inline-composer-popout')?.addEventListener('click', () => {
            if (textarea) session.note = textarea.value
            this._clearSidebarInlineComposer()
            this.app?.annotations?.closeDrawer?.()
            this._renderFloatingCard(session)
        })
        box.querySelector('.inline-composer-cancel')?.addEventListener('click', () => this.cancel())
        box.querySelector('.inline-composer-save')?.addEventListener('click', () => this._commit())

        const host = document.getElementById('sidebar-inline-note-composer-host')
        if (host) {
            host.replaceChildren(box)
        } else {
            container.parentNode?.insertBefore(box, container)
        }
        const panelNotes = document.getElementById('panel-notes')
        if (panelNotes) panelNotes.scrollTop = 0
        container.scrollTop = 0
        document.addEventListener('keydown', this._boundKeydown)
        requestAnimationFrame(() => {
            if (textarea) {
                this._autoResizeTextarea(textarea)
                textarea.focus()
                textarea.setSelectionRange(textarea.value.length, textarea.value.length)
            }
        })
    }

    _clearSidebarInlineComposer() {
        document.getElementById('sidebar-inline-note-composer')?.remove()
    }

    async _commit() {
        const session = this._activeSession
        if (!session || this._isSaving) return
        const isSidebar = session.mode === 'sidebar'
        const textarea = isSidebar
            ? document.querySelector('#sidebar-inline-note-composer .inline-composer-textarea')
            : this._card?.querySelector('#note-composer-textarea')
        const saveBtn = isSidebar
            ? document.querySelector('#sidebar-inline-note-composer .inline-composer-save')
            : this._card?.querySelector('#btn-note-composer-save')
        const cancelBtn = isSidebar
            ? document.querySelector('#sidebar-inline-note-composer .inline-composer-cancel')
            : this._card?.querySelector('#btn-note-composer-cancel')

        const noteText = textarea ? textarea.value : session.note
        session.note = noteText
        const selectedColor = session.color
        const onSave = session.onSave

        this._isSaving = true
        if (saveBtn) saveBtn.disabled = true
        if (cancelBtn) cancelBtn.disabled = true

        try {
            if (typeof onSave === 'function') {
                await onSave({ note: noteText, color: selectedColor })
            }
            this.close(false)
        } catch (err) {
            console.warn('[NoteComposer] Save failed:', err)
            const msg = t('noteComposer.saveFailedToast')
            if (this.app?.dialogs?.showToast) {
                this.app.dialogs.showToast(msg, 'warning')
            } else {
                this.app?.showToast?.(msg, 'warning')
            }
            textarea?.focus()
        } finally {
            this._isSaving = false
            if (saveBtn?.isConnected) saveBtn.disabled = false
            if (cancelBtn?.isConnected) cancelBtn.disabled = false
        }
    }

    cancel() {
        if (this._isSaving) return
        const onCancel = this._activeSession?.onCancel
        this.close(false)
        if (typeof onCancel === 'function') {
            onCancel()
        }
    }

    close(invokeCancel = false) {
        const onCancel = invokeCancel ? this._activeSession?.onCancel : null
        this._activeSession = null
        this._isSaving = false
        if (this._card) {
            this._card.hidden = true
            this._card.classList.remove('is-dragging')
        }
        this._clearSidebarInlineComposer()
        document.removeEventListener('keydown', this._boundKeydown)
        if (typeof onCancel === 'function') onCancel()
    }
}
