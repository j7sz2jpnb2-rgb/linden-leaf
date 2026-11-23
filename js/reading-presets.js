/**
 * reading-presets.js - Up to 10 Named Reading Presets Management
 * Manages typography, layout, direction, and color scheme snapshots.
 * Supports batch application, rename, clone, update, delete, modification detection,
 * and quota protection without silent overwriting.
 * Named reading presets.
 */

import { t } from './i18n.js'
import { getDefaultReaderSettings } from './reader-style-builder.js'

const STORAGE_KEY_PRESETS = 'linden_reading_presets_v1'
const STORAGE_KEY_ACTIVE_PRESET = 'linden_active_reading_preset_id'
export const MAX_READING_PRESETS = 10

export class ReadingPresetsManager {
    constructor(app = null) {
        this.app = app
        this.presets = []
        this.activePresetId = null
        this.load()
    }

    load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_PRESETS)
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) {
                    this.presets = parsed.slice(0, MAX_READING_PRESETS)
                }
            }
            this.activePresetId = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET) || null
        } catch (e) {
            this.presets = []
            this.activePresetId = null
        }
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(this.presets))
            if (this.activePresetId) {
                localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, this.activePresetId)
            } else {
                localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET)
            }
        } catch (e) {}
    }

    getPresets() {
        return this.presets
    }

    getActivePreset() {
        if (!this.activePresetId) return null
        return this.presets.find(p => p.id === this.activePresetId) || null
    }

    /**
     * Extracts reading-related typography and layout fields from full app settings
     * @param {object} settings
     * @returns {object}
     */
    extractPresetSettings(settings = {}, env = {}) {
        const defaults = getDefaultReaderSettings(env)
        const layout = (settings.layout || settings.layoutMode || defaults.layout) === 'scrolled' ? 'scrolled' : 'paginated'
        const pageTurnMode = (settings.pageTurnMode || settings.turnAnimationMode) || defaults.pageTurnMode || 'none'
        const writingMode = settings.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal'
        const isMobileEnv = typeof env?.isMobile === 'boolean'
            ? env.isMobile
            : (typeof window !== 'undefined' && (
                Boolean(window.platformBridge?.isAndroid) ||
                Boolean(window.mobileShell?.isMobileViewport?.()) ||
                Boolean(typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-mobile-viewport'))
            ))
        return {
            preserveOriginalStyles: settings.preserveOriginalStyles === true,
            font: settings.font || defaults.font,
            fontSize: Number.isFinite(Number(settings.fontSize)) ? Number(settings.fontSize) : defaults.fontSize,
            fontWeight: Number.isFinite(Number(settings.fontWeight)) ? Number(settings.fontWeight) : defaults.fontWeight,
            lineHeight: Number.isFinite(Number(settings.lineHeight)) ? Number(settings.lineHeight) : defaults.lineHeight,
            letterSpacing: Number.isFinite(Number(settings.letterSpacing)) ? Number(settings.letterSpacing) : defaults.letterSpacing,
            margin: Number.isFinite(Number(settings.margin)) ? Number(settings.margin) : defaults.margin,
            maxWidth: Number.isFinite(Number(settings.maxWidth)) ? Number(settings.maxWidth) : defaults.maxWidth,
            gap: Number.isFinite(Number(settings.gap)) ? Number(settings.gap) : defaults.gap,
            chineseQuotes: Boolean(settings.chineseQuotes),
            writingMode,
            columnCount: writingMode === 'vertical-rl' ? '1' : String(settings.columnCount || defaults.columnCount),
            layout,
            layoutMode: layout,
            pageTurnMode,
            turnAnimationMode: pageTurnMode,
            pageTurnSourcePlatform: settings.pageTurnSourcePlatform || (isMobileEnv ? 'mobile' : 'desktop'),
            theme: settings.theme || defaults.theme
        }
    }

    /**
     * Checks if current active settings have diverged from the saved preset
     * @param {object} currentSettings
     * @returns {boolean}
     */
    isCurrentModified(currentSettings) {
        const active = this.getActivePreset()
        if (!active || !active.settings) return false
        const current = this.extractPresetSettings(currentSettings)
        const saved = active.settings
        const isMobileRuntime = typeof window !== 'undefined' && (
            Boolean(window.platformBridge?.isAndroid) ||
            Boolean(window.mobileShell?.isMobileViewport?.()) ||
            Boolean(typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-mobile-viewport'))
        )
        const ignoreDesktopNoneTurn = isMobileRuntime
            && saved.pageTurnMode === 'none'
            && saved.pageTurnSourcePlatform !== 'mobile'

        for (const key of Object.keys(current)) {
            if (key === 'pageTurnSourcePlatform') continue
            if (key === 'preserveOriginalStyles' && !Object.hasOwn(saved, key)) continue
            if (ignoreDesktopNoneTurn && (key === 'pageTurnMode' || key === 'turnAnimationMode')) continue
            if (current[key] !== saved[key]) {
                return true
            }
        }
        return false
    }

    /**
     * Create and save a new preset
     * @param {string} rawName
     * @param {object} currentSettings
     * @returns {{ success: boolean, preset?: object, error?: string, quotaExceeded?: boolean }}
     */
    createPreset(rawName, currentSettings) {
        const name = (rawName || '').trim().slice(0, 24)
        if (!name) {
            return { success: false, error: t('presetError.emptyName') }
        }

        if (this.presets.length >= MAX_READING_PRESETS) {
            return {
                success: false,
                quotaExceeded: true,
                error: t('presetError.quotaExceeded', { max: MAX_READING_PRESETS })
            }
        }

        const id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        const preset = {
            schemaVersion: 1,
            id,
            name,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            settings: this.extractPresetSettings(currentSettings)
        }

        this.presets.push(preset)
        this.activePresetId = id
        this.save()
        return { success: true, preset }
    }

    /**
     * Overwrites an existing preset with new settings (or replaces slot)
     * @param {string} presetId
     * @param {object} currentSettings
     * @param {string} [newName]
     * @returns {{ success: boolean, error?: string }}
     */
    updatePreset(presetId, currentSettings, newName = null) {
        const idx = this.presets.findIndex(p => p.id === presetId)
        if (idx === -1) {
            return { success: false, error: t('presetError.notFound') }
        }

        const target = this.presets[idx]
        if (newName != null && newName.trim()) {
            target.name = newName.trim().slice(0, 24)
        }
        target.settings = this.extractPresetSettings(currentSettings)
        target.updatedAt = Date.now()

        this.activePresetId = presetId
        this.save()
        return { success: true, preset: target }
    }

    /**
     * Rename a preset
     * @param {string} presetId
     * @param {string} newName
     */
    renamePreset(presetId, newName) {
        const name = (newName || '').trim().slice(0, 24)
        if (!name) return { success: false, error: t('presetError.nameEmpty') }
        const p = this.presets.find(p => p.id === presetId)
        if (!p) return { success: false, error: t('presetError.notFound') }
        p.name = name
        p.updatedAt = Date.now()
        this.save()
        return { success: true }
    }

    /**
     * Clone an existing preset
     * @param {string} presetId
     */
    duplicatePreset(presetId) {
        if (this.presets.length >= MAX_READING_PRESETS) {
            return { success: false, error: t('presetError.duplicateLimit', { max: MAX_READING_PRESETS }) }
        }
        const source = this.presets.find(p => p.id === presetId)
        if (!source) return { success: false, error: t('presetError.sourceNotFound') }

        const id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        const clone = {
            schemaVersion: 1,
            id,
            name: t('presetError.copySuffix', { name: source.name }).slice(0, 24),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            settings: { ...source.settings }
        }
        this.presets.push(clone)
        this.save()
        return { success: true, preset: clone }
    }

    /**
     * Delete a preset
     * @param {string} presetId
     */
    deletePreset(presetId) {
        this.presets = this.presets.filter(p => p.id !== presetId)
        if (this.activePresetId === presetId) {
            this.activePresetId = null
        }
        this.save()
        return { success: true }
    }

    /**
     * Apply a preset into the app settings in one batch
     * @param {string} presetId
     * @returns {object | null} Returns the applied settings or null if not found
     */
    applyPreset(presetId) {
        const p = this.presets.find(p => p.id === presetId)
        if (!p || !p.settings) return null
        this.activePresetId = presetId
        this.save()
        const applied = { preserveOriginalStyles: false, ...p.settings }
        const isMobileRuntime = typeof window !== 'undefined' && (
            Boolean(window.platformBridge?.isAndroid) ||
            Boolean(window.mobileShell?.isMobileViewport?.()) ||
            Boolean(typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-mobile-viewport'))
        )
        if (isMobileRuntime && applied.pageTurnMode === 'none' && applied.pageTurnSourcePlatform !== 'mobile') {
            const currentMode = this.app?.settings?.pageTurnMode || (typeof window !== 'undefined' ? window.app?.settings?.pageTurnMode : null)
            if (currentMode && currentMode !== 'none') {
                applied.pageTurnMode = currentMode
                applied.turnAnimationMode = currentMode
            }
        }
        return applied
    }
}

export const readingPresetsManager = new ReadingPresetsManager()
