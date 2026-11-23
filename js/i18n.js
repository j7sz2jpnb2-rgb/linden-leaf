import { ZH_CN } from './i18n-zh.js'
import { EN } from './i18n-en.js'

export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en'])
export const LOCALE_STORAGE_KEY = 'linden_locale'
export const USER_INIT_STORAGE_KEY = 'linden_user_initialized'
const SYNC_CHANNEL_NAME = 'linden-sync-bus'

export const MESSAGES = {
    'zh-CN': ZH_CN,
    en: EN,
}

const listeners = new Set()
let syncChannel = null
let syncSubscribed = false

function readStorage(key) {
    try {
        return globalThis?.localStorage?.getItem(key) ?? null
    } catch (_) {
        return null
    }
}

function writeStorage(key, value) {
    try {
        globalThis?.localStorage?.setItem(key, value)
        return true
    } catch (_) {
        return false
    }
}

export function normalizeLocale(value) {
    if (typeof value !== 'string') return null
    const lower = value.trim().toLowerCase().replace(/_/g, '-')
    if (!lower) return null
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-sg' || lower.startsWith('zh-hans')) {
        return 'zh-CN'
    }
    if (lower === 'en' || lower.startsWith('en-')) {
        return 'en'
    }
    return null
}

export function detectPreferredLocale() {
    try {
        const nav = globalThis?.navigator
        const candidates = []
        if (typeof nav?.language === 'string') candidates.push(nav.language)
        if (Array.isArray(nav?.languages)) {
            for (const lang of nav.languages) {
                if (typeof lang === 'string') candidates.push(lang)
            }
        }
        const first = candidates.find(item => item && item.trim())
        if (!first) return 'zh-CN'
        return first.trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
    } catch (_) {
        return 'zh-CN'
    }
}

export function isLocaleChosen() {
    return normalizeLocale(readStorage(LOCALE_STORAGE_KEY)) !== null
}

export function shouldShowPreOnboardingLocaleGate() {
    if (isLocaleChosen()) return false
    return readStorage(USER_INIT_STORAGE_KEY) !== 'true'
}

export function resolveInitialLocale() {
    const stored = normalizeLocale(readStorage(LOCALE_STORAGE_KEY))
    if (stored) return stored
    if (readStorage(USER_INIT_STORAGE_KEY) === 'true') {
        return 'zh-CN'
    }
    return detectPreferredLocale()
}

let currentLocale = resolveInitialLocale()

export function getLocale() {
    return currentLocale
}

export function isEnglish(locale = currentLocale) {
    return normalizeLocale(locale) === 'en'
}

export function getIntlLocale(locale = currentLocale) {
    return isEnglish(locale) ? 'en-US' : 'zh-CN'
}

export function syncLocaleFromStorage() {
    currentLocale = resolveInitialLocale()
    return currentLocale
}

function interpolate(template, params) {
    if (typeof template !== 'string' || !params || typeof params !== 'object') {
        return template
    }
    return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(params, key)) return match
        const value = params[key]
        return value === undefined || value === null ? '' : String(value)
    })
}

export function t(key, params = {}, localeOverride = null) {
    const locale = normalizeLocale(localeOverride) || currentLocale
    const bundle = MESSAGES[locale] || ZH_CN
    const raw = Object.prototype.hasOwnProperty.call(bundle, key)
        ? bundle[key]
        : (Object.prototype.hasOwnProperty.call(ZH_CN, key) ? ZH_CN[key] : key)
    if (typeof raw !== 'string') {
        return Array.isArray(raw) ? raw.join(', ') : String(key)
    }
    return interpolate(raw, params)
}

export function tList(key, localeOverride = null) {
    const locale = normalizeLocale(localeOverride) || currentLocale
    const bundle = MESSAGES[locale] || ZH_CN
    const raw = Object.prototype.hasOwnProperty.call(bundle, key)
        ? bundle[key]
        : (Object.prototype.hasOwnProperty.call(ZH_CN, key) ? ZH_CN[key] : [])
    return Array.isArray(raw) ? raw.slice() : []
}

function updateAttrIfKey(el, attrName, datasetKey, locale) {
    const key = el?.dataset?.[datasetKey]
    if (!key) return
    el.setAttribute(attrName, t(key, {}, locale))
}

function syncLocaleToggleUi(root, locale) {
    const optionButtons = root.querySelectorAll('[data-locale-option]')
    optionButtons.forEach(btn => {
        const option = normalizeLocale(btn.dataset.localeOption)
        const active = option === locale
        btn.classList.toggle('active', active)
        btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    })

    const toggleButtons = root.querySelectorAll('[data-locale-toggle]')
    const isEn = isEnglish(locale)
    const tip = t(isEn ? 'common.switchToZh' : 'common.switchToEn', {}, locale)
    toggleButtons.forEach(btn => {
        btn.setAttribute('title', tip)
        btn.setAttribute('aria-label', tip)
        btn.dataset.currentLocale = locale
        const zhChip = btn.querySelector('[data-lang-chip="zh-CN"]')
        const enChip = btn.querySelector('[data-lang-chip="en"]')
        if (zhChip) zhChip.classList.toggle('active', !isEn)
        if (enChip) enChip.classList.toggle('active', isEn)
        const singleLabel = btn.querySelector('[data-lang-toggle-label]')
        if (singleLabel) {
            singleLabel.textContent = isEn ? '中文' : 'EN'
        }
    })
}

export function applyI18n(root = globalThis?.document, locale = currentLocale) {
    if (!root || typeof root.querySelectorAll !== 'function') return
    const resolved = normalizeLocale(locale) || currentLocale
    const doc = globalThis?.document

    if (doc && (root === doc || root === doc.documentElement)) {
        if (doc.documentElement) {
            doc.documentElement.lang = resolved
            doc.documentElement.dataset.locale = resolved
        }
        doc.title = t('app.windowTitle', {}, resolved)
    }

    root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n
        if (!key) return
        el.textContent = t(key, {}, resolved)
    })

    root.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.dataset.i18nHtml
        if (!key) return
        el.innerHTML = t(key, {}, resolved)
    })

    root.querySelectorAll('[data-i18n-title]').forEach(el => updateAttrIfKey(el, 'title', 'i18nTitle', resolved))
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => updateAttrIfKey(el, 'placeholder', 'i18nPlaceholder', resolved))
    root.querySelectorAll('[data-i18n-aria-label]').forEach(el => updateAttrIfKey(el, 'aria-label', 'i18nAriaLabel', resolved))
    root.querySelectorAll('[data-i18n-alt]').forEach(el => updateAttrIfKey(el, 'alt', 'i18nAlt', resolved))

    syncLocaleToggleUi(root, resolved)
}

export function onLocaleChange(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
}

function getSyncChannel() {
    if (syncChannel) return syncChannel
    if (typeof globalThis?.BroadcastChannel !== 'function') return null
    try {
        syncChannel = new globalThis.BroadcastChannel(SYNC_CHANNEL_NAME)
    } catch (_) {
        syncChannel = null
    }
    return syncChannel
}

function notifyListeners(locale, meta) {
    for (const listener of Array.from(listeners)) {
        try {
            listener(locale, meta)
        } catch (err) {
            console.warn('[i18n] locale listener error:', err)
        }
    }
}

export function setLocale(nextLocale, { persist = true, broadcast = true, applyDom = true } = {}) {
    const normalized = normalizeLocale(nextLocale) || 'zh-CN'
    const prev = currentLocale
    currentLocale = normalized

    if (persist) {
        writeStorage(LOCALE_STORAGE_KEY, normalized)
    }

    if (applyDom && globalThis?.document) {
        applyI18n(globalThis.document, normalized)
    }

    notifyListeners(normalized, { prev, persist, broadcast })

    if (broadcast) {
        const channel = getSyncChannel()
        if (channel) {
            try {
                channel.postMessage({ type: 'LOCALE_CHANGED', locale: normalized })
            } catch (_) {}
        }
    }

    return normalized
}

export function subscribeLocaleSync() {
    if (syncSubscribed) return
    syncSubscribed = true

    const channel = getSyncChannel()
    if (channel) {
        channel.addEventListener('message', event => {
            const data = event?.data
            if (!data || data.type !== 'LOCALE_CHANGED') return
            const next = normalizeLocale(data.locale)
            if (!next || next === currentLocale) return
            setLocale(next, { persist: false, broadcast: false, applyDom: true })
        })
    }

    if (typeof globalThis?.addEventListener === 'function') {
        globalThis.addEventListener('storage', event => {
            if (event?.key !== LOCALE_STORAGE_KEY) return
            const next = normalizeLocale(event.newValue)
            if (!next || next === currentLocale) return
            setLocale(next, { persist: false, broadcast: false, applyDom: true })
        })
    }
}

export function initLocale({ applyDom = true, subscribe = true } = {}) {
    syncLocaleFromStorage()
    if (subscribe) {
        subscribeLocaleSync()
    }
    if (applyDom && globalThis?.document) {
        applyI18n(globalThis.document, currentLocale)
    }
    return currentLocale
}
