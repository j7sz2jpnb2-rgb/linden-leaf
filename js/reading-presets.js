/**
 * reading-presets.js - Up to 10 Named Reading Presets Management
 * Manages typography, layout, direction, and color scheme snapshots.
 * Supports batch application, rename, clone, update, delete, modification detection,
 * and quota protection without silent overwriting.
 * Named reading presets.
 */

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
    extractPresetSettings(settings = {}) {
        return {
            font: settings.font || 'serif',
            fontSize: Number(settings.fontSize) || 18,
            fontWeight: Number(settings.fontWeight) || 400,
            lineHeight: Number(settings.lineHeight) || 1.6,
            letterSpacing: Number(settings.letterSpacing) || 0,
            margin: Number(settings.margin) || 48,
            maxWidth: Number(settings.maxWidth) || 760,
            gap: Number(settings.gap) || 6,
            chineseQuotes: Boolean(settings.chineseQuotes),
            writingMode: settings.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal',
            columnCount: String(settings.columnCount || '2'),
            layoutMode: settings.layoutMode === 'scrolled' ? 'scrolled' : 'paginated',
            turnAnimationMode: settings.turnAnimationMode === 'slide' ? 'slide' : 'none',
            theme: settings.theme || 'light'
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

        for (const key of Object.keys(current)) {
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
            return { success: false, error: '预设名称不能为空' }
        }

        if (this.presets.length >= MAX_READING_PRESETS) {
            return {
                success: false,
                quotaExceeded: true,
                error: `预设数量已达上限（最多 ${MAX_READING_PRESETS} 套），请选择一套已有预设进行替换或先删除不常用的预设。`
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
            return { success: false, error: '未找到指定预设' }
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
        if (!name) return { success: false, error: '名称不能为空' }
        const p = this.presets.find(p => p.id === presetId)
        if (!p) return { success: false, error: '未找到指定预设' }
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
            return { success: false, error: `预设数量已达上限（最多 ${MAX_READING_PRESETS} 套）` }
        }
        const source = this.presets.find(p => p.id === presetId)
        if (!source) return { success: false, error: '未找到源预设' }

        const id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
        const clone = {
            schemaVersion: 1,
            id,
            name: `${source.name} 副本`.slice(0, 24),
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
        return { ...p.settings }
    }
}

export const readingPresetsManager = new ReadingPresetsManager()
