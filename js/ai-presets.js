/**
 * ai-presets.js - Configurable Quick Action Prompts & Presets Manager (Max 4 Enabled)
 * Part of Linden Leaf AI Reading Assistant
 */

import { t, isEnglish, SUPPORTED_LOCALES } from './i18n.js'

const LOCAL_STORAGE_KEY_AI_PRESETS = 'linden_ai_presets_v2'

const BUILTIN_PRESET_KEYS = {
    builtin_translate: {
        nameKey: 'aiPreset.nameTranslate',
        promptKey: 'aiPreset.promptTranslate'
    },
    builtin_explain: {
        nameKey: 'aiPreset.nameExplain',
        promptKey: 'aiPreset.promptExplain'
    }
}

export const BUILTIN_PROMPTS = {
    get translate() { return t('aiPreset.promptTranslate') },
    get explain() { return t('aiPreset.promptExplain') }
}

export const DEFAULT_PRESETS = [
    {
        id: 'builtin_translate',
        get name() { return t('aiPreset.nameTranslate') },
        get prompt() { return BUILTIN_PROMPTS.translate },
        enabled: true,
        builtIn: true,
        order: 0,
        requiresReference: true
    },
    {
        id: 'builtin_explain',
        get name() { return t('aiPreset.nameExplain') },
        get prompt() { return BUILTIN_PROMPTS.explain },
        enabled: true,
        builtIn: true,
        order: 1,
        requiresReference: true
    }
]

function isDefaultBuiltinText(key, value) {
    if (!key || typeof value !== 'string') return false
    const trimmed = value.trim()
    if (!trimmed) return true
    return SUPPORTED_LOCALES.some(locale => t(key, {}, locale) === trimmed)
}

function resolveBuiltinPreset(preset) {
    if (!preset || typeof preset !== 'object') return preset
    const keys = BUILTIN_PRESET_KEYS[preset.id]
    if (!keys) return preset

    const isNameDefault = preset.customName === false
        || (!preset.customName && isDefaultBuiltinText(keys.nameKey, preset.name))
    const isPromptDefault = preset.customPrompt === false
        || (!preset.customPrompt && isDefaultBuiltinText(keys.promptKey, preset.prompt))

    return {
        ...preset,
        builtIn: true,
        name: (!isNameDefault && preset.name) ? preset.name : t(keys.nameKey),
        prompt: (!isPromptDefault && preset.prompt) ? preset.prompt : t(keys.promptKey)
    }
}

export const MAX_ENABLED_PRESETS = 4

/**
 * Loads all presets from storage, falling back to defaults.
 * @returns {Array<object>}
 */
export function getAiPresets() {
    try {
        const raw = localStorage.getItem(LOCAL_STORAGE_KEY_AI_PRESETS)
        if (raw) {
            const list = JSON.parse(raw)
            if (Array.isArray(list) && list.length > 0) {
                // Ensure built-in presets exist
                const hasTranslate = list.some(p => p.id === 'builtin_translate')
                const hasExplain = list.some(p => p.id === 'builtin_explain')
                if (!hasTranslate) list.unshift({ ...DEFAULT_PRESETS[0] })
                if (!hasExplain) list.splice(1, 0, { ...DEFAULT_PRESETS[1] })

                // Ensure at most 4 enabled
                let enabledCount = 0
                for (const p of list) {
                    if (p.enabled) {
                        enabledCount++
                        if (enabledCount > MAX_ENABLED_PRESETS) {
                            p.enabled = false
                        }
                    }
                }
                return list.map(resolveBuiltinPreset)
            }
        }
    } catch (e) {
        console.warn('[AI Presets] Failed to read presets from storage:', e)
    }

    return DEFAULT_PRESETS.map(p => ({ ...p }))
}

/**
 * Saves all presets to storage.
 * @param {Array<object>} presets
 */
export function saveAiPresets(presets) {
    if (!Array.isArray(presets)) return false
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY_AI_PRESETS, JSON.stringify(presets))
        return true
    } catch (e) {
        console.warn('[AI Presets] Failed to save presets to storage:', e)
        return false
    }
}

/**
 * Gets all currently enabled presets (at most 4), sorted by order.
 * @returns {Array<object>}
 */
export function getEnabledPresets() {
    const all = getAiPresets()
    const enabled = all.filter(p => Boolean(p.enabled))
    enabled.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return enabled.slice(0, MAX_ENABLED_PRESETS)
}

/**
 * Toggles or enables a preset by ID.
 * Returns an error object if user attempts to enable a 5th preset!
 *
 * @param {string} id
 * @param {boolean} [targetState]
 * @returns {{ success: boolean, reason?: string, message?: string }}
 */
export function setPresetEnabled(id, targetState) {
    const list = getAiPresets()
    const target = list.find(p => p.id === id)
    if (!target) {
        return { success: false, reason: 'NOT_FOUND', message: t('aiPreset.notFound') }
    }

    const nextState = typeof targetState === 'boolean' ? targetState : !target.enabled

    if (nextState) {
        const currentlyEnabled = list.filter(p => p.enabled && p.id !== id)
        if (currentlyEnabled.length >= MAX_ENABLED_PRESETS) {
            return {
                success: false,
                reason: 'MAX_LIMIT_REACHED',
                message: t('aiPreset.maxLimit', { max: MAX_ENABLED_PRESETS })
            }
        }
    }

    target.enabled = nextState
    saveAiPresets(list)
    return { success: true }
}

/**
 * Replaces an existing enabled preset with a new one atomically.
 *
 * @param {string} disableId
 * @param {string} enableId
 * @returns {{ success: boolean, message?: string }}
 */
export function replaceEnabledPreset(disableId, enableId) {
    const list = getAiPresets()
    const toDisable = list.find(p => p.id === disableId)
    const toEnable = list.find(p => p.id === enableId)

    if (!toEnable) {
        return { success: false, message: t('aiPreset.targetNotFound') }
    }

    if (toDisable) {
        toDisable.enabled = false
    }
    toEnable.enabled = true

    saveAiPresets(list)
    return { success: true }
}

/**
 * Creates a new custom preset.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.prompt
 * @param {boolean} [params.requiresReference=true]
 * @returns {{ success: boolean, preset?: object, message?: string }}
 */
export function createCustomPreset(paramsOrName, maybePrompt, maybeRequiresRef = true) {
    let name = ''
    let prompt = ''
    let requiresReference = true

    if (paramsOrName && typeof paramsOrName === 'object') {
        name = paramsOrName.name
        prompt = paramsOrName.prompt
        requiresReference = paramsOrName.requiresReference !== undefined ? paramsOrName.requiresReference : true
    } else {
        name = paramsOrName
        prompt = maybePrompt
        requiresReference = maybeRequiresRef !== undefined ? maybeRequiresRef : true
    }

    const cleanName = (name || '').trim()
    const cleanPrompt = (prompt || '').trim()
    const maxNameLen = isEnglish() ? 24 : 12

    if (!cleanName) {
        return { success: false, message: t('aiPreset.nameEmpty') }
    }
    if (cleanName.length > maxNameLen) {
        return { success: false, message: t('aiPreset.nameTooLongCreate', { max: maxNameLen }) }
    }
    if (!cleanPrompt) {
        return { success: false, message: t('aiPreset.promptEmpty') }
    }

    const list = getAiPresets()
    const currentlyEnabled = list.filter(p => p.enabled)
    const canEnable = currentlyEnabled.length < MAX_ENABLED_PRESETS

    const newPreset = {
        id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: cleanName,
        prompt: cleanPrompt,
        enabled: canEnable, // Only auto-enable if budget permits!
        builtIn: false,
        order: list.length,
        requiresReference: Boolean(requiresReference)
    }

    list.push(newPreset)
    saveAiPresets(list)

    return {
        success: true,
        preset: newPreset,
        id: newPreset.id,
        name: newPreset.name,
        prompt: newPreset.prompt,
        message: canEnable ? t('aiPreset.createdEnabled') : t('aiPreset.createdQueued', { max: MAX_ENABLED_PRESETS })
    }
}

/**
 * Updates an existing preset.
 *
 * @param {string} id
 * @param {object} updates { name, prompt, requiresReference, order }
 * @returns {{ success: boolean, message?: string }}
 */
export function updatePreset(id, updates = {}) {
    const list = getAiPresets()
    const target = list.find(p => p.id === id)
    if (!target) {
        return { success: false, message: t('aiPreset.notFound') }
    }

    const maxNameLen = isEnglish() ? 24 : 12
    const builtinKeys = BUILTIN_PRESET_KEYS[id]
    if (updates.name !== undefined) {
        const cleanName = updates.name.trim()
        if (!cleanName) return { success: false, message: t('aiPreset.nameEmpty') }
        if (cleanName.length > maxNameLen) return { success: false, message: t('aiPreset.nameTooLongUpdate', { max: maxNameLen }) }
        target.name = cleanName
        if (builtinKeys) {
            target.customName = !isDefaultBuiltinText(builtinKeys.nameKey, cleanName)
        }
    }

    if (updates.prompt !== undefined) {
        const cleanPrompt = updates.prompt.trim()
        if (!cleanPrompt) return { success: false, message: t('aiPreset.promptEmpty') }
        target.prompt = cleanPrompt
        if (builtinKeys) {
            target.customPrompt = !isDefaultBuiltinText(builtinKeys.promptKey, cleanPrompt)
        }
    }

    if (updates.requiresReference !== undefined) {
        target.requiresReference = Boolean(updates.requiresReference)
    }

    if (typeof updates.order === 'number') {
        target.order = updates.order
    }

    saveAiPresets(list)
    return { success: true }
}

/**
 * Deletes a custom preset. Built-in presets cannot be deleted (only disabled).
 *
 * @param {string} id
 * @returns {{ success: boolean, message?: string }}
 */
export function deletePreset(id) {
    const list = getAiPresets()
    const target = list.find(p => p.id === id)
    if (!target) return { success: false, message: t('aiPreset.notFound') }
    if (target.builtIn) return { success: false, message: t('aiPreset.builtinProtected') }

    const remaining = list.filter(p => p.id !== id)
    saveAiPresets(remaining)
    return { success: true }
}

/**
 * Resets a built-in preset to its default prompt.
 *
 * @param {string} id
 * @returns {{ success: boolean }}
 */
export function resetBuiltinPreset(id) {
    const list = getAiPresets()
    const target = list.find(p => p.id === id)
    const keys = BUILTIN_PRESET_KEYS[id]
    if (target && (target.builtIn || keys)) {
        if (keys) {
            target.name = t(keys.nameKey)
            target.prompt = t(keys.promptKey)
        }
        delete target.customName
        delete target.customPrompt
        saveAiPresets(list)
        return { success: true }
    }
    return { success: false }
}
