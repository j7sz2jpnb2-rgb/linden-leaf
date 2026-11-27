/**
 * Linden Leaf Chromium Companion - Content Script
 * Implements draft-preserving, IME-safe, post-insert-verified reference insertion
 * across Tier A (site adapter) and Tier B (explicit generic fallback),
 * plus reversible compact layout helper classes (never mutates/deletes native controls).
 */

(() => {
    if (globalThis.__lindenCompanionContentLoaded) return
    globalThis.__lindenCompanionContentLoaded = true

    const DEFAULT_GENERIC_RULES = {
        unsafeExcludeSelectors: [
            "input[type='search']",
            "input[type='password']",
            "input[type='email']",
            "[role='search'] input",
            "[role='search'] textarea",
            "[role='dialog'] input",
            "[role='dialog'] textarea",
            "[role='dialog'] [contenteditable='true']",
            "header input",
            "nav input",
            "article textarea",
            "article [contenteditable='true']"
        ]
    }
    let _isComposing = false
    let _sidebarCollapsedOnce = false
    const _processedRequestIds = new Set()

    document.addEventListener('compositionstart', () => { _isComposing = true }, true)
    document.addEventListener('compositionend', () => { _isComposing = false }, true)

    function resolveProviderIdFromHost(hostname = location.hostname) {
        const h = String(hostname || '').toLowerCase()
        if (h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h === 'chat.openai.com') return 'chatgpt'
        if (h === 'gemini.google.com') return 'gemini'
        if (h === 'aistudio.google.com') return 'aistudio'
        if (h === 'chat.deepseek.com') return 'deepseek'
        return null
    }

    function recordProcessedRequest(reqId) {
        if (!reqId) return false
        if (_processedRequestIds.has(reqId)) return true
        _processedRequestIds.add(reqId)
        if (_processedRequestIds.size > 64) {
            const first = _processedRequestIds.values().next().value
            if (first !== undefined) _processedRequestIds.delete(first)
        }
        return false
    }

    function isElementVisible(el) {
        if (!el || !el.isConnected) return false
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = el.getBoundingClientRect()
        return rect.width >= 40 && rect.height >= 16
    }

    function isDisabledOrExcluded(el, excludeSelectors = []) {
        if (!el) return true
        if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return true
        for (const sel of excludeSelectors) {
            try {
                if (el.matches(sel) || el.closest(sel)) return true
            } catch (_) {}
        }
        return false
    }

    function pickAdapterEditor(spec, genericRules) {
        const excludeSelectors = [
            ...(genericRules?.unsafeExcludeSelectors || []),
            ...(spec?.unsafeExcludeSelectors || [])
        ]
        const candidates = []
        for (const sel of (spec?.editorSelectors || [])) {
            let nodes = []
            try { nodes = Array.from(document.querySelectorAll(sel)) } catch (_) { continue }
            for (const el of nodes) {
                if (!isElementVisible(el) || isDisabledOrExcluded(el, excludeSelectors)) continue
                if (!candidates.includes(el)) candidates.push(el)
            }
            if (candidates.length === 1) {
                return { ok: true, element: candidates[0], method: 'adapter' }
            }
            if (candidates.length > 1) {
                const activeMatch = candidates.find(el => el === document.activeElement || el.contains(document.activeElement))
                if (activeMatch) return { ok: true, element: activeMatch, method: 'adapter' }
                return { ok: false, reason: 'ambiguous_editor' }
            }
        }
        return { ok: false, reason: 'editor_not_found' }
    }

    function pickGenericEditor(genericRules) {
        const excludeSelectors = genericRules?.unsafeExcludeSelectors || []
        const raw = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']"))
        const scored = []
        const vh = window.innerHeight || 800
        for (const el of raw) {
            if (!isElementVisible(el) || isDisabledOrExcluded(el, excludeSelectors)) continue
            const rect = el.getBoundingClientRect()
            let score = 0
            if (el === document.activeElement || el.contains(document.activeElement)) score += 4
            if (rect.top > vh * 0.45) score += 2
            if (el.closest('form')) score += 2
            const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`.toLowerCase()
            if (/(message|prompt|ask|chat|问|输入|发送|内容)/.test(hint)) score += 2
            if (rect.width >= 200) score += 1
            scored.push({ el, score })
        }
        if (scored.length === 0) return { ok: false, reason: 'editor_not_found' }
        scored.sort((a, b) => b.score - a.score)
        if (scored.length > 1 && scored[0].score - scored[1].score < 2 && document.activeElement !== scored[0].el) {
            return { ok: false, reason: 'ambiguous_editor' }
        }
        if (scored[0].score < 3) {
            return { ok: false, reason: 'low_confidence_editor' }
        }
        return { ok: true, element: scored[0].el, method: 'generic' }
    }

    function readEditorText(el) {
        if (!el) return ''
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            return String(el.value || '')
        }
        return String(el.innerText || el.textContent || '')
    }

    function setTextareaValueReactSafe(el, nextValue) {
        const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
        if (proto && typeof proto.set === 'function') {
            proto.set.call(el, nextValue)
        } else {
            el.value = nextValue
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: nextValue, inputType: 'insertText' }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    function moveCaretToEnd(el) {
        const sel = window.getSelection()
        if (!sel) return
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
    }

    function waitForFrameworkReconcile() {
        return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 35)))
    }

    async function insertDraftPreservingText(el, promptText, expectedVerifySnippet) {
        const cleanPrompt = String(promptText || '').trim()
        if (!cleanPrompt) return { ok: false, reason: 'empty_prompt' }

        const beforeText = readEditorText(el)
        const hasDraft = beforeText.trim().length > 0
        const separator = hasDraft
            ? (/\n\s*$/.test(beforeText) ? '\n' : '\n\n')
            : ''
        const textToAppend = `${separator}${cleanPrompt}\n\n`
        const verifyProbe = String(expectedVerifySnippet || cleanPrompt).trim().slice(0, 24)

        const didLand = () => {
            const after = readEditorText(el)
            return verifyProbe ? after.includes(verifyProbe) : (after.length > beforeText.length)
        }

        el.focus({ preventScroll: false })

        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const combined = `${beforeText}${textToAppend}`
            setTextareaValueReactSafe(el, combined)
            try {
                el.selectionStart = el.selectionEnd = combined.length
            } catch (_) {}
            await waitForFrameworkReconcile()
        } else {
            // ContentEditable (ProseMirror / Quill / Rich editor):
            // 1. Preserve existing draft by moving caret to the very end
            moveCaretToEnd(el)
            let execOk = false
            try {
                execOk = document.execCommand('insertText', false, textToAppend)
            } catch (_) {
                execOk = false
            }
            if (execOk) {
                await waitForFrameworkReconcile()
            }

            // 2. Fallback: synthetic ClipboardEvent('paste') for Quill/Gemini & strict Slate/ProseMirror builds
            if (!didLand()) {
                moveCaretToEnd(el)
                try {
                    const dt = new DataTransfer()
                    dt.setData('text/plain', textToAppend)
                    const pasteEvt = new ClipboardEvent('paste', {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: dt
                    })
                    el.dispatchEvent(pasteEvt)
                } catch (_) {}
                await waitForFrameworkReconcile()
            }

            // 3. Final DOM fallback if editor ignored both execCommand and synthetic paste
            if (!didLand()) {
                moveCaretToEnd(el)
                const lines = textToAppend.split('\n')
                for (let i = 0; i < lines.length; i++) {
                    const p = document.createElement('p')
                    p.textContent = lines[i]
                    if (!lines[i]) p.appendChild(document.createElement('br'))
                    el.appendChild(p)
                }
                el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: textToAppend, inputType: 'insertText' }))
                el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, data: textToAppend, inputType: 'insertText' }))
                moveCaretToEnd(el)
                await waitForFrameworkReconcile()
            }
        }

        const afterText = readEditorText(el)
        if (!didLand()) {
            return { ok: false, reason: 'insert_unverified' }
        }
        return {
            ok: true,
            draftPreserved: !hasDraft || afterText.includes(beforeText.trim().slice(0, 16)),
            editorLength: afterText.length
        }
    }

    function applyCompactClasses(providerId, enabled, collapseSidebar = false, spec = null) {
        const root = document.documentElement
        root.classList.toggle('ll-companion-compact', Boolean(enabled))
        for (const cls of Array.from(root.classList)) {
            if (cls.startsWith('ll-provider-')) root.classList.remove(cls)
        }
        if (enabled && providerId) {
            root.classList.add(`ll-provider-${providerId}`)
        }
        if (enabled && collapseSidebar && !_sidebarCollapsedOnce && spec?.sidebarContainerSelectors) {
            const openSidebar = spec.sidebarContainerSelectors
                .map(sel => { try { return document.querySelector(sel) } catch (_) { return null } })
                .find(el => el && el.getBoundingClientRect().width > 120)
            if (openSidebar && Array.isArray(spec.sidebarToggleSelectors)) {
                const toggleBtn = spec.sidebarToggleSelectors
                    .map(sel => { try { return document.querySelector(sel) } catch (_) { return null } })
                    .find(btn => btn && isElementVisible(btn))
                if (toggleBtn) {
                    _sidebarCollapsedOnce = true
                    try { toggleBtn.click() } catch (_) {}
                }
            }
        }
        if (!enabled) {
            _sidebarCollapsedOnce = false
        }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return false

        if (msg.type === 'LL_APPLY_COMPACT') {
            const providerId = msg.providerId || resolveProviderIdFromHost() || 'custom'
            applyCompactClasses(providerId, Boolean(msg.enabled), Boolean(msg.collapseSidebar), msg.providerSpec || null)
            sendResponse({ ok: true, providerId })
            return false
        }

        if (msg.type === 'LL_INSERT_REF') {
            (async () => {
                if (_isComposing) {
                    sendResponse({ ok: false, reason: 'ime_composing' })
                    return
                }
                if (msg.requestId && recordProcessedRequest(msg.requestId)) {
                    sendResponse({ ok: true, duplicateIgnored: true, method: 'dedup' })
                    return
                }

                const hostProviderId = resolveProviderIdFromHost()
                if (msg.expectedProviderId && msg.expectedProviderId !== 'custom' && hostProviderId !== msg.expectedProviderId) {
                    sendResponse({ ok: false, reason: 'provider_mismatch', actualHost: location.hostname })
                    return
                }

                const providerSpec = msg.providerSpec || null
                const genericRules = msg.genericRules || DEFAULT_GENERIC_RULES
                let picked = null
                if (providerSpec) {
                    picked = pickAdapterEditor(providerSpec, genericRules)
                } else if (msg.allowGenericFallback) {
                    picked = pickGenericEditor(genericRules)
                } else {
                    picked = { ok: false, reason: 'generic_not_authorized' }
                }

                if (!picked?.ok || !picked.element) {
                    sendResponse({ ok: false, reason: picked?.reason || 'editor_not_found' })
                    return
                }

                const effProviderId = msg.providerId || hostProviderId || 'custom'
                if (msg.compactMode !== undefined) {
                    applyCompactClasses(
                        effProviderId,
                        Boolean(msg.compactMode),
                        Boolean(msg.collapseSidebar),
                        providerSpec
                    )
                }

                const res = await insertDraftPreservingText(
                    picked.element,
                    msg.promptText,
                    msg.verifySnippet
                )
                sendResponse({
                    ...res,
                    method: picked.method,
                    providerId: effProviderId,
                    url: location.href,
                    title: document.title
                })
            })()
            return true
        }

        return false
    })
})()
