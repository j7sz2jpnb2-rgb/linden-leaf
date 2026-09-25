/**
 * advanced-settings.js - Triple-Click Unlockable Advanced Settings Manager
 * Manages 0-10000 token AI context budget, in-place paragraph translation, native cooldown & daily limit.
 * Part of Linden Leaf (2026-09-25)
 */

export const DEFAULT_ADVANCED_SETTINGS = Object.freeze({
    aiContextTokenBudget: 1000,          // 0 to 10000 tokens (0 = no extra context, 10000 = hard ceiling)
    inPlaceParagraphTranslation: false,  // Enable in-place paragraph translation card
    modelTokenizer: 'auto',              // 'auto' | 'cl100k_base' | 'gpt2' | 'cjk_heuristic'
    aiMaxTokens: 2048,                   // 256 to 4096 tokens
    aiCooldownSeconds: 10,               // 10 | 20 | 30 seconds
    aiDailyLimit: 0,                     // 0 = unlimited / unconfigured
    dictSaveHistory: false               // Save local dictionary lookups
})

const STORAGE_KEY_UNLOCKED = 'linden_advanced_settings_unlocked'
const STORAGE_KEY_CONFIG = 'linden_advanced_settings_config'

export class AdvancedSettingsManager {
    constructor(app = null) {
        this.app = app
        this.isUnlocked = false
        this.config = { ...DEFAULT_ADVANCED_SETTINGS }

        // Triple-click tracking state
        this.clickCount = 0
        this.lastClickTime = 0
        this.clickWindowMs = 8000 // Must complete 3 clicks within 8 seconds

        this.dom = {}
        this.load()
    }

    load() {
        try {
            this.isUnlocked = localStorage.getItem(STORAGE_KEY_UNLOCKED) === 'true'
            const saved = localStorage.getItem(STORAGE_KEY_CONFIG)
            if (saved) {
                const parsed = JSON.parse(saved)
                this.config = {
                    ...DEFAULT_ADVANCED_SETTINGS,
                    ...parsed
                }
                // Enforce budget bounds [0, 10000] (0 is a valid budget that disables extra context)
                const rawBudget = Number(this.config.aiContextTokenBudget)
                this.config.aiContextTokenBudget = Number.isFinite(rawBudget) ? Math.max(0, Math.min(10000, rawBudget)) : 1000
                this.config.aiMaxTokens = Math.max(256, Math.min(4096, Number(this.config.aiMaxTokens) || 2048))
                this.config.aiCooldownSeconds = [10, 20, 30].includes(Number(this.config.aiCooldownSeconds)) ? Number(this.config.aiCooldownSeconds) : 10
                this.config.aiDailyLimit = Math.max(0, Number(this.config.aiDailyLimit) || 0)
            }
        } catch (e) {
            this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        }
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY_UNLOCKED, String(this.isUnlocked))
            localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(this.config))
        } catch (e) {}

        // Sync native cooldown and daily limit to Rust backend if available
        this.syncNativeBackendLimits()
    }

    async syncNativeBackendLimits() {
        const cooldown = this.config.aiCooldownSeconds || 10
        const limit = this.config.aiDailyLimit || 0

        try {
            if (globalThis.window?.__TAURI__?.core?.invoke) {
                await globalThis.window.__TAURI__.core.invoke('ai_set_cooldown_and_limit', {
                    cooldownSeconds: cooldown,
                    dailyLimit: limit,
                    cooldown_seconds: cooldown,
                    daily_limit: limit
                })
            }
        } catch (e) {
            console.warn('[AdvancedSettings] Failed to sync limits to native backend:', e)
        }
    }

    bindUI(domElements = {}) {
        this.dom = domElements
        this.renderUIState()
        this.attachEventListeners()
    }

    renderUIState() {
        const {
            badgeAdvancedStatus,
            hintAdvancedTrigger,
            advancedSettingsContainer,
            settingAiContextBudget,
            labelAiContextBudget,
            settingInplaceParaTrans,
            settingModelTokenizer,
            settingAiMaxTokens,
            settingAiCooldown,
            settingAiDailyLimit,
            settingDictSaveHistory,
            btnPopupTranslatePara
        } = this.dom

        if (badgeAdvancedStatus) {
            badgeAdvancedStatus.innerText = this.isUnlocked ? '已解锁' : '未解锁'
            badgeAdvancedStatus.style.background = this.isUnlocked ? 'rgba(74, 222, 128, 0.15)' : 'var(--bg-tertiary)'
            badgeAdvancedStatus.style.color = this.isUnlocked ? '#16a34a' : 'var(--text-muted)'
        }

        if (hintAdvancedTrigger) {
            hintAdvancedTrigger.innerText = this.isUnlocked ? '点击折叠/展开' : '连续点击3次解锁'
        }

        if (advancedSettingsContainer) {
            advancedSettingsContainer.style.display = this.isUnlocked ? 'flex' : 'none'
        }

        if (settingAiContextBudget) {
            settingAiContextBudget.value = this.config.aiContextTokenBudget
        }
        if (labelAiContextBudget) {
            labelAiContextBudget.innerText = String(this.config.aiContextTokenBudget)
        }

        if (settingInplaceParaTrans) {
            settingInplaceParaTrans.checked = !!this.config.inPlaceParagraphTranslation
        }

        if (btnPopupTranslatePara) {
            btnPopupTranslatePara.style.display = this.config.inPlaceParagraphTranslation ? 'inline-block' : 'none'
        }

        if (settingModelTokenizer) {
            settingModelTokenizer.value = this.config.modelTokenizer || 'auto'
        }

        if (settingAiMaxTokens) {
            settingAiMaxTokens.value = this.config.aiMaxTokens || 2048
        }

        if (settingAiCooldown) {
            settingAiCooldown.value = String(this.config.aiCooldownSeconds || 10)
        }

        if (settingAiDailyLimit) {
            settingAiDailyLimit.value = String(this.config.aiDailyLimit || 0)
        }

        if (settingDictSaveHistory) {
            settingDictSaveHistory.checked = !!this.config.dictSaveHistory
        }
    }

    attachEventListeners() {
        // Trigger row click for 3-click unlock or toggle
        this.dom.rowAdvancedSettingsTrigger?.addEventListener('click', () => {
            this.handleTriggerClick()
        })
        this.dom.rowAdvancedSettingsTrigger?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                this.handleTriggerClick()
            }
        })

        // Confirmation modal buttons & backdrop click
        this.dom.modalAdvancedSettingsConfirm?.addEventListener('click', (e) => {
            if (e.target === this.dom.modalAdvancedSettingsConfirm) {
                this.closeConfirmModal()
            }
        })
        this.dom.btnCloseAdvancedConfirm?.addEventListener('click', () => {
            this.closeConfirmModal()
        })
        this.dom.btnCancelAdvancedUnlock?.addEventListener('click', () => {
            this.closeConfirmModal()
        })
        this.dom.btnConfirmAdvancedUnlock?.addEventListener('click', () => {
            this.unlock()
            this.closeConfirmModal()
        })

        // AI Context Budget Slider
        this.dom.settingAiContextBudget?.addEventListener('input', (e) => {
            const val = Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0))
            this.config.aiContextTokenBudget = val
            if (this.dom.labelAiContextBudget) {
                this.dom.labelAiContextBudget.innerText = String(val)
            }
            this.save()
        })

        // In-place Paragraph Translation Switch
        this.dom.settingInplaceParaTrans?.addEventListener('change', (e) => {
            this.config.inPlaceParagraphTranslation = !!e.target.checked
            if (this.dom.btnPopupTranslatePara) {
                this.dom.btnPopupTranslatePara.style.display = this.config.inPlaceParagraphTranslation ? 'inline-block' : 'none'
            }
            this.save()
        })

        // Model Tokenizer Select
        this.dom.settingModelTokenizer?.addEventListener('change', (e) => {
            this.config.modelTokenizer = e.target.value
            this.save()
        })

        // Max Tokens Input
        this.dom.settingAiMaxTokens?.addEventListener('change', (e) => {
            const val = Math.max(256, Math.min(4096, parseInt(e.target.value, 10) || 2048))
            this.config.aiMaxTokens = val
            e.target.value = String(val)
            this.save()
        })

        // Cooldown Select
        this.dom.settingAiCooldown?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10) || 10
            this.config.aiCooldownSeconds = [10, 20, 30].includes(val) ? val : 10
            this.save()
        })

        // Daily Limit Input
        this.dom.settingAiDailyLimit?.addEventListener('change', (e) => {
            const val = Math.max(0, parseInt(e.target.value, 10) || 0)
            this.config.aiDailyLimit = val
            e.target.value = String(val)
            this.save()
        })

        // Dict Save History Switch
        this.dom.settingDictSaveHistory?.addEventListener('change', (e) => {
            this.config.dictSaveHistory = !!e.target.checked
            this.save()
            if (this.app?.dictionaryService) {
                this.app.dictionaryService.setSaveHistory(this.config.dictSaveHistory)
            }
        })

        // Reset & Re-lock Button
        this.dom.btnResetAdvancedSettings?.addEventListener('click', () => {
            this.resetAndLock()
        })
    }

    handleTriggerClick() {
        if (this.isUnlocked) {
            // Already unlocked: toggle collapse/expand
            const container = this.dom.advancedSettingsContainer
            if (container) {
                const isHidden = container.style.display === 'none'
                container.style.display = isHidden ? 'flex' : 'none'
                if (this.dom.hintAdvancedTrigger) {
                    this.dom.hintAdvancedTrigger.innerText = isHidden ? '点击折叠' : '点击展开'
                }
            }
            return
        }

        const now = Date.now()
        if (now - this.lastClickTime > this.clickWindowMs) {
            this.clickCount = 0
        }

        this.clickCount++
        this.lastClickTime = now

        if (this.clickCount === 1) {
            this.app?.showToast?.('再点两次以开启高级设置', 'info')
            if (this.dom.hintAdvancedTrigger) {
                this.dom.hintAdvancedTrigger.innerText = '再点两次以开启'
            }
        } else if (this.clickCount === 2) {
            this.app?.showToast?.('再点一次以开启高级设置', 'info')
            if (this.dom.hintAdvancedTrigger) {
                this.dom.hintAdvancedTrigger.innerText = '再点一次以开启'
            }
        } else if (this.clickCount >= 3) {
            this.clickCount = 0
            this.openConfirmModal()
        }
    }

    openConfirmModal() {
        if (this.dom.modalAdvancedSettingsConfirm) {
            this.dom.modalAdvancedSettingsConfirm.style.display = 'flex'
            this.dom.modalAdvancedSettingsConfirm.classList.add('show')
        }
    }

    closeConfirmModal() {
        if (this.dom.modalAdvancedSettingsConfirm) {
            this.dom.modalAdvancedSettingsConfirm.classList.remove('show')
            this.dom.modalAdvancedSettingsConfirm.style.display = 'none'
        }
    }

    unlock() {
        this.isUnlocked = true
        this.save()
        this.renderUIState()
        this.app?.showToast?.('高级设置已解锁', 'success')
    }

    resetAndLock() {
        this.isUnlocked = false
        this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        this.clickCount = 0
        this.save()
        this.renderUIState()
        if (this.app?.dictionaryService) {
            this.app.dictionaryService.setSaveHistory(false)
        }
        this.app?.showToast?.('已恢复高级默认参数并锁定', 'info')
    }

    get aiContextTokenBudget() {
        const raw = Number(this.config.aiContextTokenBudget)
        return Number.isFinite(raw) ? Math.max(0, Math.min(10000, raw)) : 1000
    }

    get contextTokenBudget() {
        return this.aiContextTokenBudget
    }

    get inPlaceParagraphTranslation() {
        return !!this.config.inPlaceParagraphTranslation
    }

    get modelTokenizer() {
        return this.config.modelTokenizer || 'auto'
    }

    get aiMaxTokens() {
        return Math.max(256, Math.min(4096, Number(this.config.aiMaxTokens) || 2048))
    }

    get aiCooldownSeconds() {
        return [10, 20, 30].includes(Number(this.config.aiCooldownSeconds)) ? Number(this.config.aiCooldownSeconds) : 10
    }

    get aiDailyLimit() {
        return Math.max(0, Number(this.config.aiDailyLimit) || 0)
    }
}

export const advancedSettings = new AdvancedSettingsManager()
