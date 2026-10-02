/**
 * theme-customizer.js - Global Semantic Color Schemes & Token Customization
 * Manages UI and reader semantic CSS tokens, color validation, preview, persistence,
 * and derivation of hover/active/border states.
 * Semantic reader and interface colors.
 */

const STORAGE_KEY_CUSTOM_THEME = 'linden_custom_semantic_palette_v1'

export const DEFAULT_SEMANTIC_PALETTE = Object.freeze({
    bgPrimary: '#ffffff',       // 界面主背景
    bgSecondary: '#f9fafb',     // 卡片 / 浮层背景
    bgSidebar: '#f3f4f6',       // 侧栏背景
    textMain: '#111827',        // 主文字
    textSecondary: '#4b5563',   // 次文字
    borderColor: '#e5e7eb',     // 边框
    accent: '#d97706',          // 强调色 / 按钮
    readerBg: '#fbf0d9',        // 阅读纸张背景
    readerText: '#2b2319',      // 阅读正文文字
    selectionBg: 'rgba(217, 119, 6, 0.22)' // 划词选中高亮
})

export class ThemeCustomizer {
    constructor() {
        this.currentPalette = { ...DEFAULT_SEMANTIC_PALETTE }
        this.backupPalette = null
        this.isCustomActive = false
        this.styleElement = null
        this.load()
    }

    load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_THEME)
            if (raw) {
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object') {
                    for (const key of Object.keys(DEFAULT_SEMANTIC_PALETTE)) {
                        if (this.isValidColor(parsed[key])) {
                            this.currentPalette[key] = parsed[key]
                        }
                    }
                    this.isCustomActive = parsed._active === true
                }
            }
            if (this.isCustomActive && typeof document !== 'undefined' && document.head) {
                this.applyTheme()
            }
        } catch (e) {
            this.currentPalette = { ...DEFAULT_SEMANTIC_PALETTE }
            this.isCustomActive = false
        }
    }

    save() {
        try {
            const data = {
                ...this.currentPalette,
                _active: this.isCustomActive
            }
            localStorage.setItem(STORAGE_KEY_CUSTOM_THEME, JSON.stringify(data))
        } catch (e) {}
    }

    /**
     * Strict color validation to prevent CSS/HTML code injection
     * @param {string} colorStr
     * @returns {boolean}
     */
    isValidColor(colorStr) {
        if (!colorStr || typeof colorStr !== 'string') return false
        const trimmed = colorStr.trim()
        // Allow hex (#rgb, #rrggbb, #rrggbbaa)
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
            return true
        }
        // Allow rgb() / rgba() with numeric values
        if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmed)) {
            return true
        }
        return false
    }

    /**
     * Normalizes partial palette and fills missing tokens from defaults
     * @param {object} palette
     * @returns {object}
     */
    normalizePalette(palette) {
        const base = (this && this.currentPalette) ? this.currentPalette : DEFAULT_SEMANTIC_PALETTE
        const p = { ...DEFAULT_SEMANTIC_PALETTE, ...base, ...(palette || {}) }
        for (const key of Object.keys(DEFAULT_SEMANTIC_PALETTE)) {
            if (p[key] == null || typeof p[key] !== 'string' || !p[key].trim()) {
                p[key] = (base && base[key]) || DEFAULT_SEMANTIC_PALETTE[key]
            }
        }
        return p
    }

    /**
     * Generate CSS variable overrides
     * @param {object} palette
     * @returns {string}
     */
    buildStyleRules(palette) {
        const base = (this && this.currentPalette) ? this.currentPalette : DEFAULT_SEMANTIC_PALETTE
        const p = { ...DEFAULT_SEMANTIC_PALETTE, ...base, ...(palette || {}) }
        if (!p.borderColor) p.borderColor = (base && base.borderColor) || DEFAULT_SEMANTIC_PALETTE.borderColor
        if (!p.textSecondary) p.textSecondary = (base && base.textSecondary) || DEFAULT_SEMANTIC_PALETTE.textSecondary
        if (!p.bgPrimary) p.bgPrimary = (base && base.bgPrimary) || DEFAULT_SEMANTIC_PALETTE.bgPrimary
        if (!p.bgSecondary) p.bgSecondary = (base && base.bgSecondary) || DEFAULT_SEMANTIC_PALETTE.bgSecondary
        if (!p.bgSidebar) p.bgSidebar = (base && base.bgSidebar) || DEFAULT_SEMANTIC_PALETTE.bgSidebar
        if (!p.textMain) p.textMain = (base && base.textMain) || DEFAULT_SEMANTIC_PALETTE.textMain
        if (!p.accent) p.accent = (base && base.accent) || DEFAULT_SEMANTIC_PALETTE.accent
        if (!p.readerBg) p.readerBg = (base && base.readerBg) || DEFAULT_SEMANTIC_PALETTE.readerBg
        if (!p.readerText) p.readerText = (base && base.readerText) || DEFAULT_SEMANTIC_PALETTE.readerText
        if (!p.selectionBg) p.selectionBg = (base && base.selectionBg) || DEFAULT_SEMANTIC_PALETTE.selectionBg

        return `
            :root {
                --bg-primary: ${p.bgPrimary} !important;
                --bg-secondary: ${p.bgSecondary} !important;
                --bg-sidebar: ${p.bgSidebar} !important;
                --text-main: ${p.textMain} !important;
                --text-primary: ${p.textMain} !important;
                --text-secondary: ${p.textSecondary} !important;
                --border-color: ${p.borderColor} !important;
                --accent: ${p.accent} !important;
                --accent-purple: ${p.accent} !important;
                --reader-bg: ${p.readerBg} !important;
                --reader-text: ${p.readerText} !important;
                --selection-bg: ${p.selectionBg} !important;
            }
            #books-workspace,
            .shelf-books-container,
            .reading-overview-panel {
                background: ${p.bgPrimary} !important;
                color: ${p.textMain} !important;
            }
            .sidebar-content,
            .jane-sidebar {
                background: ${p.bgSidebar} !important;
            }
        `
    }

    /**
     * Applies custom theme stylesheet into document head
     */
    applyTheme(palette = null) {
        if (!palette && !this.isCustomActive) {
            this.removeTheme()
            return
        }

        const pal = palette || this.currentPalette
        if (!this.styleElement) {
            this.styleElement = document.createElement('style')
            this.styleElement.id = 'linden-custom-theme-overrides'
            document.head.appendChild(this.styleElement)
        }
        this.styleElement.textContent = this.buildStyleRules(pal)
        if (!palette) {
            this.isCustomActive = true
            this.save()
        }
    }

    /**
     * Preview changes without committing
     * @param {object} tempPalette
     */
    preview(tempPalette) {
        if (!this.backupPalette) {
            this.backupPalette = { ...this.currentPalette }
        }
        this.applyTheme(tempPalette)
    }

    /**
     * Reverts preview back to saved state
     */
    cancelPreview() {
        if (this.backupPalette) {
            this.currentPalette = { ...this.backupPalette }
            this.backupPalette = null
        }
        if (this.isCustomActive) {
            this.applyTheme()
        } else {
            this.removeTheme()
        }
    }

    /**
     * Commits previewed or current palette
     * @param {object} [newPalette]
     */
    commit(newPalette = null) {
        if (newPalette) {
            for (const key of Object.keys(DEFAULT_SEMANTIC_PALETTE)) {
                if (this.isValidColor(newPalette[key])) {
                    this.currentPalette[key] = newPalette[key]
                }
            }
        }
        this.backupPalette = null
        this.isCustomActive = true
        this.applyTheme()
        this.save()
    }

    /**
     * Reset to default application colors
     */
    resetToDefaults() {
        this.currentPalette = { ...DEFAULT_SEMANTIC_PALETTE }
        this.backupPalette = null
        this.isCustomActive = false
        this.removeTheme()
        try {
            localStorage.removeItem(STORAGE_KEY_CUSTOM_THEME)
        } catch (e) {}
    }

    removeTheme() {
        if (this.styleElement && this.styleElement.parentNode) {
            this.styleElement.parentNode.removeChild(this.styleElement)
            this.styleElement = null
        }
    }
}

export const themeCustomizer = new ThemeCustomizer()
