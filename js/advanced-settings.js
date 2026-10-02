/**
 * advanced-settings.js - Triple-Click Unlockable Advanced Settings Manager
 * Manages 10 comprehensive customization modules:
 * 1. Font Library Management
 * 2. Semantic Palette HEX Editor
 * 3. TXT TOC Regex Rules
 * 4. Typography & Paragraph Formatting
 * 5. Reading Interaction & Reduced Motion
 * 6. Annotations & Handwriting Strokes
 * 7. AI Budget & Tokenizer Mapping
 * 8. Chapter Translation & Local Archive
 * 9. Standalone Dictionary & Lookup Timing
 * 10. Background Indexing & Settings Backup
 * Advanced reader and AI settings.
 */

import { setCustomTxtPatterns } from '../foliate-js-main/txt.js'
import { getChapterTranslationsStats, clearAllChapterTranslations } from './db.js'
import * as db from './db.js'
import { runTxtRulesWorker } from './txt-toc-worker.js'
import { dictionaryService } from './dictionary-service.js'
import { ttsPlayer } from './tts-player.js'
import { platformBridge } from './platformBridge.js'

const TXT_RULE_TEMPLATES = Object.freeze({
    zh_chapter: '^第\\s*[0-9一二三四五六七八九十百千万零两]+\\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案].*',
    en_chapter: '^(?:Chapter|Section|Book|Part|Act|Scene)\\s+[0-9IVXLCDMivxlcdm]+.*',
    num_heading: '^[0-9]{1,4}[、.\\s]+[\\u4e00-\\u9fa5a-zA-Z0-9].*'
})

export const DEFAULT_ADVANCED_SETTINGS = Object.freeze({
    aiContextTokenBudget: 1000,          // 0 to 10000 tokens (0 = no extra context, 10000 = hard ceiling)
    inPlaceParagraphTranslation: false,  // Enable in-place paragraph translation card
    modelTokenizer: 'auto',              // 'auto' | 'cl100k_base' | 'gpt2' | 'cjk_heuristic'
    aiMaxTokens: 2048,                   // 256 to 8192 tokens
    aiCooldownSeconds: 10,               // 0 to 3600 seconds (0 truly active)
    aiDailyLimit: 0,                     // 0 = unlimited / unconfigured
    dictSaveHistory: false,              // Save local dictionary lookups
    dictLookupDelay: 250,                // 100 to 600 ms
    dictLemmatization: true,             // English lemmatization
    // TXT TOC Rules
    txtCustomRulesEnable: false,
    txtRegexPattern: '^第\\s*[0-9一二三四五六七八九十百千万零两]+\\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案].*',
    txtRegexFlags: 'i',
    txtGroupIndex: 0,
    // Text formatting
    firstParaIndent: true,               // Follow body indent for first paragraph after heading
    paraMarginTop: 0.0,
    paraMarginBottom: 0.5,
    paraIndentSize: '2em',
    txtMergeSoftBreaks: true,
    // Interaction & Animation
    reducedMotion: false,
    glassmorphismBlur: true,
    animIntensity: 'normal',             // 'none' | 'soft' | 'normal'
    sidebarDefaultWidth: 380,
    // Strokes
    highlighterOpacity: 0.35,
    underlineWidth: 1.5,
    pdfPenWidth: 2.5,
    pdfSmoothing: true,
    // Translation
    chapterTransAutoSave: true,
    chapterTransAutoRestore: true,
    chapterTransStyle: 'auto',
    webdavSyncTranslations: false,
    // Background Index
    bgIndexIdleOnly: true,
    bgIndexConcurrency: 1,
    // TTS Audio & Speech Engine
    ttsProvider: 'system',
    ttsRate: 1.0,
    ttsVoiceId: '',
    ttsApiEndpoint: 'https://api.openai.com/v1/audio/speech',
    ttsApiKeyConfigured: false,
    ttsApiModel: 'tts-1',
    ttsOfflineEndpoint: 'http://127.0.0.1:8880/v1/audio/speech',
    ttsOfflineModel: 'kokoro-82m-zh'
})

const STORAGE_KEY_UNLOCKED = 'linden_advanced_settings_unlocked'
const STORAGE_KEY_CONFIG = 'linden_advanced_settings_config'

export class AdvancedSettingsManager {
    constructor(app = null) {
        this.app = app
        this.isUnlocked = false
        this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        this._sessionTtsApiKey = ''

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
                // Migrate legacy plaintext TTS API key if present in old config
                if (parsed.ttsApiKey) {
                    this._migrateLegacyTtsKey(parsed.ttsApiKey)
                    delete parsed.ttsApiKey
                }
                this.config = {
                    ...DEFAULT_ADVANCED_SETTINGS,
                    ...parsed
                }
                delete this.config.ttsApiKey

                // Enforce budget bounds [0, 10000] (0 is a valid budget that disables extra context)
                const rawBudget = Number(this.config.aiContextTokenBudget)
                this.config.aiContextTokenBudget = Number.isFinite(rawBudget) ? Math.max(0, Math.min(10000, rawBudget)) : 1000
                this.config.aiMaxTokens = Math.max(256, Math.min(8192, Number(this.config.aiMaxTokens) || 2048))
                const rawCd = Number(this.config.aiCooldownSeconds)
                this.config.aiCooldownSeconds = Number.isFinite(rawCd) ? Math.max(0, Math.min(3600, rawCd)) : 10
                this.config.aiDailyLimit = Math.max(0, Number(this.config.aiDailyLimit) || 0)
            }
        } catch (e) {
            this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        }

        this.applyRuntimeConfig()
    }

    async _migrateLegacyTtsKey(legacyKey) {
        if (!legacyKey || !legacyKey.trim()) return
        const clean = legacyKey.trim()
        try {
            const ok = await platformBridge.secureStoreCredential('tts_api_key', clean)
            if (ok) {
                const endpoint = this.config.ttsApiEndpoint || 'https://api.openai.com/v1/audio/speech'
                let origin = ''
                try { origin = new URL(endpoint).origin } catch (_) { origin = endpoint }
                await platformBridge.secureStoreCredential('tts_api_origin', origin)
                this.config.ttsApiKeyConfigured = true
                this._sessionTtsApiKey = clean
                this.save()
            } else {
                this._sessionTtsApiKey = clean
                this.config.ttsApiKeyConfigured = true
            }
        } catch (e) {
            this._sessionTtsApiKey = clean
        }
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY_UNLOCKED, String(this.isUnlocked))
            // Strict sanitization: ensure no credentials ever enter localStorage
            const safeConfig = { ...this.config }
            delete safeConfig.ttsApiKey
            delete safeConfig.apiKey
            delete safeConfig.secret
            delete safeConfig.password
            delete safeConfig.token
            localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(safeConfig))
        } catch (e) {}

        this.applyRuntimeConfig()
        this.syncNativeBackendLimits()
    }

    applyRuntimeConfig() {
        try {
            // 1. Reduced motion
            document.documentElement.dataset.reducedMotion = String(!!this.config.reducedMotion)

            // 2. Animation Intensity
            const anim = this.config.animIntensity || 'normal'
            document.documentElement.dataset.animIntensity = anim
            const duration = anim === 'none' ? '0ms' : (anim === 'soft' ? '150ms' : '250ms')
            document.documentElement.style.setProperty('--app-anim-duration', duration)

            // 3. Glassmorphism toggle & blur
            const glassEnabled = this.config.glassmorphismBlur !== false
            document.documentElement.classList.toggle('no-glass', !glassEnabled)
            document.documentElement.dataset.glassmorphism = String(glassEnabled)
            document.documentElement.style.setProperty('--glass-blur', glassEnabled ? '12px' : '0px')

            // 4. Annotations CSS variables
            if (this.config.highlighterOpacity != null) {
                document.documentElement.style.setProperty('--annotation-highlighter-opacity', String(this.config.highlighterOpacity))
            }
            if (this.config.underlineWidth != null) {
                document.documentElement.style.setProperty('--annotation-underline-width', `${this.config.underlineWidth}px`)
            }

            // 5. Sync custom TXT patterns
            if (this.config.txtCustomRulesEnable && this.config.txtRegexPattern) {
                try {
                    const re = new RegExp(this.config.txtRegexPattern, this.config.txtRegexFlags || 'i')
                    setCustomTxtPatterns([{
                        regex: re,
                        pattern: this.config.txtRegexPattern,
                        flags: this.config.txtRegexFlags || 'i',
                        groupIndex: Number(this.config.txtGroupIndex) || 0
                    }])
                } catch (e) {
                    console.warn('[AdvancedSettings] Invalid TXT regex:', e)
                    setCustomTxtPatterns(null)
                }
            } else {
                setCustomTxtPatterns(null)
            }

            // 6. Sync TTS configuration
            if (typeof ttsPlayer !== 'undefined' && ttsPlayer?.loadSettings) {
                ttsPlayer.loadSettings(this.config)
            }
        } catch (e) {}
    }

    async syncNativeBackendLimits() {
        const cooldown = (this.config.aiCooldownSeconds != null && !isNaN(this.config.aiCooldownSeconds)) ? this.config.aiCooldownSeconds : 10
        const limit = this.config.aiDailyLimit || 0

        try {
            const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
            if (invoke) {
                await invoke('ai_set_cooldown_and_limit', {
                    cooldownSeconds: cooldown,
                    dailyLimit: limit,
                    cooldown_seconds: cooldown,
                    daily_limit: limit
                })
            }
        } catch (e) {
            // Not running in Tauri native environment
        }
    }

    bindUI(domElements = {}) {
        this.dom = domElements
        this.syncNativeBackendLimits()
        this.renderUIState()
        this.attachEventListeners()
        this.updateTransStorageStats()
    }

    renderUIState() {
        const d = this.dom

        if (d.badgeAdvancedStatus) {
            d.badgeAdvancedStatus.innerText = this.isUnlocked ? '已解锁' : '未解锁'
            d.badgeAdvancedStatus.style.background = this.isUnlocked ? 'rgba(74, 222, 128, 0.15)' : 'var(--bg-tertiary)'
            d.badgeAdvancedStatus.style.color = this.isUnlocked ? '#16a34a' : 'var(--text-muted)'
        }

        if (d.hintAdvancedTrigger) {
            d.hintAdvancedTrigger.innerText = this.isUnlocked ? '点击折叠/展开' : '连续点击3次解锁'
        }

        if (d.advancedSettingsContainer) {
            d.advancedSettingsContainer.style.display = this.isUnlocked ? 'flex' : 'none'
        }

        if (typeof document === 'undefined') return

        // AI budget
        const rawBudget = Number(this.config.aiContextTokenBudget)
        const budgetVal = Number.isFinite(rawBudget) ? Math.max(0, Math.min(10000, rawBudget)) : 1000
        const budgetInput = document.getElementById('setting-ai-context-budget')
        const budgetLabel = document.getElementById('label-ai-context-budget')
        if (budgetInput) budgetInput.value = budgetVal
        if (budgetLabel) budgetLabel.innerText = String(budgetVal)

        // Cooldown
        const cdInput = document.getElementById('setting-ai-cooldown')
        if (cdInput) cdInput.value = String(this.config.aiCooldownSeconds != null ? this.config.aiCooldownSeconds : 10)
        const tip = document.getElementById('tip-ai-cooldown-warning')
        if (tip) {
            tip.style.display = (this.config.aiCooldownSeconds === 0 || this.config.aiCooldownSeconds < 5) ? 'block' : 'none'
        }

        // Daily limit
        const dailyLimitInput = document.getElementById('setting-ai-daily-limit')
        if (dailyLimitInput) dailyLimitInput.value = String(this.config.aiDailyLimit || 0)

        // Max tokens
        const maxTokensInput = document.getElementById('setting-ai-max-tokens')
        if (maxTokensInput) maxTokensInput.value = String(this.config.aiMaxTokens || 2048)

        // Tokenizer
        const tokSelect = document.getElementById('setting-model-tokenizer')
        if (tokSelect) tokSelect.value = this.config.modelTokenizer || 'auto'

        // TXT Rules
        const txtEnable = document.getElementById('setting-txt-custom-rules-enable')
        if (txtEnable) txtEnable.checked = !!this.config.txtCustomRulesEnable
        const txtPattern = document.getElementById('setting-txt-regex-pattern')
        if (txtPattern && this.config.txtRegexPattern) txtPattern.value = this.config.txtRegexPattern
        const txtTemplate = document.getElementById('setting-txt-template-select')
        if (txtTemplate && txtPattern) {
            const matchingTemplate = Object.entries(TXT_RULE_TEMPLATES).find(([, value]) => value === txtPattern.value)
            txtTemplate.value = matchingTemplate?.[0] || 'custom'
        }
        this.updateTxtRuleControls()

        // Typography (Read from effective settings overlay so single-path overrides are reflected)
        const effTypography = this.app?.settings || this.config
        const firstIndent = document.getElementById('setting-first-para-indent')
        if (firstIndent) firstIndent.checked = effTypography.firstParaIndent !== false
        const paraTop = document.getElementById('setting-para-margin-top')
        if (paraTop) paraTop.value = String(effTypography.paraMarginTop ?? 0.0)
        const paraTopVal = document.getElementById('value-para-margin-top')
        if (paraTopVal) paraTopVal.innerText = `${Number(effTypography.paraMarginTop ?? 0.0).toFixed(1)}em`
        const paraBottom = document.getElementById('setting-para-margin-bottom')
        if (paraBottom) paraBottom.value = String(effTypography.paraMarginBottom ?? 0.5)
        const paraBottomVal = document.getElementById('value-para-margin-bottom')
        if (paraBottomVal) paraBottomVal.innerText = `${Number(effTypography.paraMarginBottom ?? 0.5).toFixed(1)}em`
        const indentSize = document.getElementById('setting-para-indent-size')
        if (indentSize) indentSize.value = effTypography.paraIndentSize || '2em'

        // Motion & Blur
        const redMotion = document.getElementById('setting-reduced-motion')
        if (redMotion) redMotion.checked = !!this.config.reducedMotion
        const glass = document.getElementById('setting-glassmorphism-blur')
        if (glass) glass.checked = this.config.glassmorphismBlur !== false
        const animInt = document.getElementById('setting-anim-intensity')
        if (animInt) animInt.value = this.config.animIntensity || 'normal'

        // Strokes & Annotations
        const hlOpacity = document.getElementById('setting-highlighter-opacity')
        const hlOpacityVal = document.getElementById('value-highlighter-opacity')
        if (hlOpacity) hlOpacity.value = String(this.config.highlighterOpacity ?? 0.35)
        if (hlOpacityVal) hlOpacityVal.innerText = `${Math.round((this.config.highlighterOpacity ?? 0.35) * 100)}%`

        const underWidth = document.getElementById('setting-underline-width')
        if (underWidth) underWidth.value = String(this.config.underlineWidth ?? 1.5)

        const pdfWidth = document.getElementById('setting-pdf-pen-width')
        const pdfWidthVal = document.getElementById('value-pdf-pen-width')
        if (pdfWidth) pdfWidth.value = String(this.config.pdfPenWidth ?? 2.5)
        if (pdfWidthVal) pdfWidthVal.innerText = `${Number(this.config.pdfPenWidth ?? 2.5).toFixed(1)}px`

        const pdfSmooth = document.getElementById('setting-pdf-smoothing')
        if (pdfSmooth) pdfSmooth.checked = this.config.pdfSmoothing !== false

        // Translation
        const transAutoSave = document.getElementById('setting-chapter-trans-auto-save')
        if (transAutoSave) transAutoSave.checked = this.config.chapterTransAutoSave !== false
        const transAutoRestore = document.getElementById('setting-chapter-trans-auto-restore')
        if (transAutoRestore) transAutoRestore.checked = this.config.chapterTransAutoRestore !== false
        const transStyle = document.getElementById('setting-chapter-trans-style')
        if (transStyle) transStyle.value = this.config.chapterTransStyle || 'auto'
        const webdavTrans = document.getElementById('setting-webdav-sync-translations')
        if (webdavTrans) webdavTrans.checked = !!this.config.webdavSyncTranslations

        // TXT soft break merge & Background indexing settings
        const softBreaks = document.getElementById('setting-txt-merge-soft-breaks')
        if (softBreaks) softBreaks.checked = this.config.txtMergeSoftBreaks !== false
        const bgIndexIdle = document.getElementById('setting-bg-index-idle-only')
        if (bgIndexIdle) bgIndexIdle.checked = this.config.bgIndexIdleOnly !== false
        const bgIndexConcurrency = document.getElementById('setting-bg-index-concurrency')
        if (bgIndexConcurrency) bgIndexConcurrency.value = String(this.config.bgIndexConcurrency || 1)

        // TTS Settings
        const ttsProv = document.getElementById('setting-tts-provider')
        if (ttsProv) ttsProv.value = this.config.ttsProvider || 'system'
        const ttsRate = document.getElementById('setting-tts-rate')
        if (ttsRate) ttsRate.value = String(this.config.ttsRate || 1.0)
        const ttsRateVal = document.getElementById('value-tts-rate')
        if (ttsRateVal) ttsRateVal.innerText = `${Number(this.config.ttsRate || 1.0).toFixed(1)}x`
        const ttsOffEnd = document.getElementById('setting-tts-offline-endpoint')
        if (ttsOffEnd) ttsOffEnd.value = this.config.ttsOfflineEndpoint || 'http://127.0.0.1:8880/v1/audio/speech'
        const ttsOffMod = document.getElementById('setting-tts-offline-model')
        if (ttsOffMod) ttsOffMod.value = this.config.ttsOfflineModel || 'kokoro-82m-zh'
        const ttsApiEnd = document.getElementById('setting-tts-api-endpoint')
        if (ttsApiEnd) ttsApiEnd.value = this.config.ttsApiEndpoint || 'https://api.openai.com/v1/audio/speech'
        const ttsApiMod = document.getElementById('setting-tts-api-model')
        if (ttsApiMod) ttsApiMod.value = this.config.ttsApiModel || 'tts-1'
        const ttsApiKey = document.getElementById('setting-tts-api-key')
        if (ttsApiKey) ttsApiKey.value = this.config.ttsApiKey || ''
    }

    attachEventListeners() {
        if (typeof document === 'undefined') return
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
        document.getElementById('setting-ai-context-budget')?.addEventListener('input', (e) => {
            const val = Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0))
            this.config.aiContextTokenBudget = val
            const label = document.getElementById('label-ai-context-budget')
            if (label) label.innerText = String(val)
            this.save()
        })

        // Cooldown Number Input (Supports 0s for no interval, up to 3600s)
        document.getElementById('setting-ai-cooldown')?.addEventListener('change', (e) => {
            const raw = parseInt(e.target.value, 10)
            const val = isNaN(raw) ? 10 : Math.max(0, Math.min(3600, raw))
            this.config.aiCooldownSeconds = val
            e.target.value = String(val)
            const tip = document.getElementById('tip-ai-cooldown-warning')
            if (tip) {
                tip.style.display = (val === 0 || val < 5) ? 'block' : 'none'
            }
            this.save()
        })

        // Daily Limit Input
        document.getElementById('setting-ai-daily-limit')?.addEventListener('change', (e) => {
            const val = Math.max(0, parseInt(e.target.value, 10) || 0)
            this.config.aiDailyLimit = val
            e.target.value = String(val)
            this.save()
        })

        // Max Tokens
        document.getElementById('setting-ai-max-tokens')?.addEventListener('change', (e) => {
            const val = Math.max(256, Math.min(8192, parseInt(e.target.value, 10) || 2048))
            this.config.aiMaxTokens = val
            e.target.value = String(val)
            this.save()
        })

        // Model Tokenizer
        document.getElementById('setting-model-tokenizer')?.addEventListener('change', (e) => {
            this.config.modelTokenizer = e.target.value
            this.save()
        })

        // TXT Custom Rules Toggle & Templates
        document.getElementById('setting-txt-custom-rules-enable')?.addEventListener('change', (e) => {
            this.config.txtCustomRulesEnable = !!e.target.checked
            this.save()
            this.updateTxtRuleControls()
            if (this.config.txtCustomRulesEnable) {
                this.app?.showToast?.('已开启自定义规则；选择模板后点击“应用并重建目录”', 'info')
            } else {
                this.applyTxtRulesAndReload()
            }
        })

        document.getElementById('setting-txt-template-select')?.addEventListener('change', (e) => {
            const patternInput = document.getElementById('setting-txt-regex-pattern')
            if (!patternInput) return
            const val = e.target.value
            if (TXT_RULE_TEMPLATES[val]) patternInput.value = TXT_RULE_TEMPLATES[val]
            this.config.txtRegexPattern = patternInput.value
            this.save()
            this.updateTxtRuleControls()
        })

        document.getElementById('setting-txt-regex-pattern')?.addEventListener('change', (e) => {
            this.config.txtRegexPattern = e.target.value.trim()
            this.save()
            const template = document.getElementById('setting-txt-template-select')
            if (template) template.value = 'custom'
        })

        // Test TXT Regex against book text
        document.getElementById('btn-test-txt-rules')?.addEventListener('click', () => {
            this.testTxtRulesOnCurrentBook()
        })

        document.getElementById('btn-apply-txt-rules')?.addEventListener('click', () => {
            this.applyTxtRulesAndReload()
        })

        // Typography settings (routed through single-path app.setSetting)
        document.getElementById('setting-first-para-indent')?.addEventListener('change', (e) => {
            const val = !!e.target.checked
            this.config.firstParaIndent = val
            this.app?.setSetting?.('firstParaIndent', val)
            this.app?.saveSettingsDebounced?.()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-para-margin-top')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 0
            this.config.paraMarginTop = val
            const label = document.getElementById('value-para-margin-top')
            if (label) label.innerText = `${val.toFixed(1)}em`
            this.app?.setSetting?.('paraMarginTop', val)
            this.app?.saveSettingsDebounced?.()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-para-margin-bottom')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 0
            this.config.paraMarginBottom = val
            const label = document.getElementById('value-para-margin-bottom')
            if (label) label.innerText = `${val.toFixed(1)}em`
            this.app?.setSetting?.('paraMarginBottom', val)
            this.app?.saveSettingsDebounced?.()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-para-indent-size')?.addEventListener('change', (e) => {
            const val = e.target.value
            this.config.paraIndentSize = val
            this.app?.setSetting?.('paraIndentSize', val)
            this.app?.saveSettingsDebounced?.()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        // TXT soft break merge & Background indexing settings
        document.getElementById('setting-txt-merge-soft-breaks')?.addEventListener('change', (e) => {
            this.config.txtMergeSoftBreaks = !!e.target.checked
            this.save()
        })

        document.getElementById('setting-bg-index-idle-only')?.addEventListener('change', (e) => {
            this.config.bgIndexIdleOnly = !!e.target.checked
            this.save()
        })

        document.getElementById('setting-bg-index-concurrency')?.addEventListener('change', (e) => {
            this.config.bgIndexConcurrency = parseInt(e.target.value, 10) || 1
            this.save()
        })

        // Motion settings
        document.getElementById('setting-reduced-motion')?.addEventListener('change', (e) => {
            this.config.reducedMotion = !!e.target.checked
            this.applyRuntimeConfig()
            this.save()
        })

        document.getElementById('setting-glassmorphism-blur')?.addEventListener('change', (e) => {
            this.config.glassmorphismBlur = !!e.target.checked
            this.applyRuntimeConfig()
            this.save()
        })

        document.getElementById('setting-anim-intensity')?.addEventListener('change', (e) => {
            this.config.animIntensity = e.target.value
            this.applyRuntimeConfig()
            this.save()
        })

        // Strokes & Annotations settings
        document.getElementById('setting-highlighter-opacity')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 0.35
            this.config.highlighterOpacity = val
            const label = document.getElementById('value-highlighter-opacity')
            if (label) label.innerText = `${Math.round(val * 100)}%`
            this.applyRuntimeConfig()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-underline-width')?.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value) || 1.5
            this.config.underlineWidth = val
            this.applyRuntimeConfig()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-pdf-pen-width')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 2.5
            this.config.pdfPenWidth = val
            const label = document.getElementById('value-pdf-pen-width')
            if (label) label.innerText = `${val.toFixed(1)}px`
            this.save()
        })

        document.getElementById('setting-pdf-smoothing')?.addEventListener('change', (e) => {
            this.config.pdfSmoothing = !!e.target.checked
            this.save()
        })

        // Translation settings
        document.getElementById('setting-chapter-trans-auto-save')?.addEventListener('change', (e) => {
            this.config.chapterTransAutoSave = !!e.target.checked
            this.save()
        })

        document.getElementById('setting-chapter-trans-auto-restore')?.addEventListener('change', (e) => {
            this.config.chapterTransAutoRestore = !!e.target.checked
            this.save()
        })

        document.getElementById('setting-chapter-trans-style')?.addEventListener('change', (e) => {
            this.config.chapterTransStyle = e.target.value
            this.save()
        })

        document.getElementById('setting-webdav-sync-translations')?.addEventListener('change', (e) => {
            this.config.webdavSyncTranslations = !!e.target.checked
            localStorage.setItem('linden_sync_chapter_translations', String(this.config.webdavSyncTranslations))
            this.save()
        })

        document.getElementById('btn-clear-trans-cache')?.addEventListener('click', async () => {
            if (confirm('确定要清空所有书籍的章节双语译文缓存吗？\n（此操作不会删除原书、笔记或划线）')) {
                await clearAllChapterTranslations()
                this.updateTransStorageStats()
                this.app?.showToast?.('已清空全部章节双语译文缓存', 'info')
            }
        })

        // Audio Cache & Dictionary Resource Locations
        document.getElementById('btn-clear-audio-cache')?.addEventListener('click', async () => {
            try {
                const count = await dictionaryService.clearAudioCache()
                this.app?.showToast?.(`已清空语音音频缓存（共清理 ${count} 个音频文件）`, 'info')
            } catch (e) {
                this.app?.showToast?.(`清空语音缓存失败: ${e.message}`, 'warning')
            }
        })

        document.getElementById('btn-dict-download')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dict-download')
            const labelStatus = document.getElementById('label-dict-resource-status')
            if (btn) btn.disabled = true
            try {
                this.app?.showToast?.('开始下载官方 ECDICT 词库...', 'info')
                await dictionaryService.downloadAndInstall({
                    onProgress: (p) => {
                        if (labelStatus) {
                            labelStatus.innerText = p.message || `${p.phase}: ${p.percent}%`
                        }
                    }
                })
                await this.updateDictResourceStatus()
                this.app?.showToast?.('词库下载并安装成功！', 'success')
            } catch (err) {
                this.app?.showToast?.(`下载失败: ${err.message}`, 'warning')
                await this.updateDictResourceStatus()
            } finally {
                if (btn) btn.disabled = false
            }
        })

        document.getElementById('btn-dict-install-builtin')?.addEventListener('click', async () => {
            try {
                this.app?.showToast?.('正在尝试安装或导入词库...', 'info')
                const res = await dictionaryService.pickAndInstallFromFile()
                if (res) {
                    await this.updateDictResourceStatus()
                    this.app?.showToast?.('词典导入成功', 'success')
                }
            } catch (err) {
                this.app?.showToast?.(`操作失败: ${err.message}`, 'warning')
            }
        })

        document.getElementById('btn-dict-migrate-dir')?.addEventListener('click', async () => {
            try {
                const targetDir = await dictionaryService.pickFolder()
                if (targetDir) {
                    await dictionaryService.migrateStorage(targetDir)
                    await this.updateDictResourceStatus()
                    this.app?.showToast?.(`词典目录已成功迁移至: ${targetDir}`, 'success')
                }
            } catch (err) {
                this.app?.showToast?.(`迁移失败: ${err.message}`, 'warning')
            }
        })

        // Settings JSON Export & Import
        document.getElementById('btn-export-settings-json')?.addEventListener('click', () => {
            this.exportSettingsJSON()
        })

        const importInput = document.getElementById('input-import-settings-file')
        document.getElementById('btn-import-settings-json')?.addEventListener('click', () => {
            importInput?.click()
        })
        importInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0]
            if (file) this.importSettingsJSON(file)
            e.target.value = ''
        })

        // TTS Audio & Speech Engine Settings
        document.getElementById('setting-tts-provider')?.addEventListener('change', (e) => {
            this.config.ttsProvider = e.target.value
            this.save()
            ttsPlayer.setProvider(e.target.value)
        })

        document.getElementById('setting-tts-rate')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 1.0
            this.config.ttsRate = val
            const label = document.getElementById('value-tts-rate')
            if (label) label.innerText = `${val.toFixed(1)}x`
            this.save()
            ttsPlayer.setRate(val)
        })

        document.getElementById('setting-tts-offline-endpoint')?.addEventListener('change', (e) => {
            this.config.ttsOfflineEndpoint = e.target.value.trim()
            this.save()
            ttsPlayer.updateProviderConfig('offline', { localEndpoint: this.config.ttsOfflineEndpoint })
        })

        document.getElementById('setting-tts-offline-model')?.addEventListener('change', (e) => {
            this.config.ttsOfflineModel = e.target.value.trim()
            this.save()
            ttsPlayer.updateProviderConfig('offline', { model: this.config.ttsOfflineModel })
        })

        document.getElementById('setting-tts-api-endpoint')?.addEventListener('change', async (e) => {
            const newEndpoint = e.target.value.trim()
            let newOrigin = ''
            try { newOrigin = new URL(newEndpoint).origin } catch (_) { newOrigin = newEndpoint }

            const storedOrigin = await platformBridge.secureLoadCredential('tts_api_origin').catch(() => null)
            if (storedOrigin && newOrigin && storedOrigin !== newOrigin) {
                this.app?.showToast?.('TTS 接口地址已更改，为防泄露旧凭据已重置，请重新输入密钥', 'warning')
                this.config.ttsApiKeyConfigured = false
                this._sessionTtsApiKey = ''
                await platformBridge.secureStoreCredential('tts_api_key', '')
                await platformBridge.secureStoreCredential('tts_api_origin', newOrigin)
                ttsPlayer.updateProviderConfig('api', { apiKey: '', apiEndpoint: newEndpoint })
                const keyInput = document.getElementById('setting-tts-api-key')
                if (keyInput) keyInput.value = ''
            } else {
                ttsPlayer.updateProviderConfig('api', { apiEndpoint: newEndpoint })
            }
            this.config.ttsApiEndpoint = newEndpoint
            this.save()
        })

        document.getElementById('setting-tts-api-model')?.addEventListener('change', (e) => {
            this.config.ttsApiModel = e.target.value.trim()
            this.save()
            ttsPlayer.updateProviderConfig('api', { model: this.config.ttsApiModel })
        })

        const ttsKeyInput = document.getElementById('setting-tts-api-key')
        if (ttsKeyInput) {
            ttsKeyInput.value = this.config.ttsApiKeyConfigured ? '••••••••••••••••' : ''
            ttsKeyInput.addEventListener('change', async (e) => {
                const val = e.target.value.trim()
                if (val === '••••••••••••••••') return
                await this.setTtsApiKey(val)
            })
        }

        // Data Recovery and Book Re-linking
        document.getElementById('btn-export-full-data-backup')?.addEventListener('click', () => {
            this.exportFullDataBackup()
        })

        document.getElementById('btn-relink-missing-book')?.addEventListener('click', () => {
            this.relinkMissingBook()
        })

        // Reset & Re-lock Button
        document.getElementById('btn-reset-advanced-settings')?.addEventListener('click', () => {
            this.resetAndLock()
        })
    }

    async setTtsApiKey(key) {
        const clean = (key || '').trim()
        if (!clean) {
            this.config.ttsApiKeyConfigured = false
            this._sessionTtsApiKey = ''
            await platformBridge.secureStoreCredential('tts_api_key', '')
            await platformBridge.secureStoreCredential('tts_api_origin', '')
            this.save()
            ttsPlayer.updateProviderConfig('api', { apiKey: '' })
            this.app?.showToast?.('TTS API 密钥已清除', 'info')
            return
        }

        const endpoint = this.config.ttsApiEndpoint || 'https://api.openai.com/v1/audio/speech'
        let origin = ''
        try { origin = new URL(endpoint).origin } catch (_) { origin = endpoint }

        const ok = await platformBridge.secureStoreCredential('tts_api_key', clean)
        if (ok) {
            await platformBridge.secureStoreCredential('tts_api_origin', origin)
            this.config.ttsApiKeyConfigured = true
            this._sessionTtsApiKey = clean
            this.app?.showToast?.('TTS API 密钥已通过安全存储保存', 'success')
        } else {
            this.config.ttsApiKeyConfigured = false
            this._sessionTtsApiKey = clean
            this.app?.showToast?.('系统安全存储暂不可用，密钥仅在当前会话生效，未保存到磁盘', 'warning')
        }
        this.save()
        ttsPlayer.updateProviderConfig('api', { apiKey: clean })
    }

    async exportFullDataBackup() {
        try {
            const [sessions, highlights, books] = await Promise.all([
                db.getAllReadingSessions?.().catch(() => []) || [],
                db.getAllHighlights?.().catch(() => []) || [],
                db.getAllBooks?.().catch(() => []) || []
            ])

            const safeConfig = { ...this.config }
            const sensitiveKeys = ['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory']
            for (const k of sensitiveKeys) {
                delete safeConfig[k]
            }

            const payload = {
                format: 'linden-leaf-full-backup',
                schemaVersion: 2,
                exportedAt: new Date().toISOString(),
                config: safeConfig,
                sessions,
                highlights,
                books: books.map(b => ({
                    id: b.id,
                    title: b.title,
                    author: b.author,
                    format: b.format,
                    totalReadingSeconds: b.totalReadingSeconds,
                    totalListeningSeconds: b.totalListeningSeconds,
                    lastReadAt: b.lastReadAt,
                    currentLocation: b.currentLocation
                }))
            }

            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `LindenLeaf_完整备份_${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
            this.app?.showToast?.('完整阅读与统计数据导出成功', 'success')
        } catch (e) {
            this.app?.showToast?.(`备份导出失败: ${e.message}`, 'warning')
        }
    }

    async relinkMissingBook() {
        try {
            const books = await (db.getAllBooks?.() || Promise.resolve([]))
            if (!books || books.length === 0) {
                this.app?.showToast?.('书架中暂无图书，无需重新关联', 'info')
                return
            }
            const bookTitles = books.map((b, i) => `${i + 1}. 《${b.title}》 (${b.format || 'doc'})`).join('\n')
            const choice = prompt(`请输入需要重新关联本地文件的图书编号 (1-${books.length}):\n\n${bookTitles}`)
            if (!choice) return
            const idx = parseInt(choice, 10) - 1
            if (isNaN(idx) || idx < 0 || idx >= books.length) {
                this.app?.showToast?.('输入的图书编号无效', 'warning')
                return
            }
            const targetBook = books[idx]
            const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
            if (invoke) {
                const picked = await invoke('dialog_open_file')
                const newPath = picked?.[0]?.filePath
                if (newPath) {
                    targetBook.filePath = newPath
                    targetBook.updatedAt = Date.now()
                    await db.updateBook?.(targetBook)
                    this.app?.showToast?.(`已成功将《${targetBook.title}》重新关联至: ${newPath}`, 'success')
                    if (this.app?.loadBookshelf) this.app.loadBookshelf()
                    return
                }
            }
            this.app?.showToast?.('未选择新文件，关联取消', 'info')
        } catch (e) {
            this.app?.showToast?.(`重新关联失败: ${e.message}`, 'warning')
        }
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
        this.app?.showToast?.('已恢复高级默认参数并锁定', 'info')
    }

    async updateTransStorageStats() {
        if (typeof document === 'undefined') return
        const label = document.getElementById('label-trans-storage-size')
        if (!label) return
        try {
            const stats = await getChapterTranslationsStats()
            const kb = (stats.estimatedBytes / 1024).toFixed(1)
            label.innerText = `已存译文：${stats.count} 章节 (~${kb} KB)`
        } catch (e) {
            label.innerText = '已存译文：0 章节'
        }
    }

    async updateDictResourceStatus() {
        if (typeof document === 'undefined') return
        const labelStatus = document.getElementById('label-dict-resource-status')
        const labelPath = document.getElementById('label-dict-resource-path')
        try {
            const status = await dictionaryService.getStatus()
            const locations = await dictionaryService.getResourceLocations()
            if (labelStatus) {
                if (status?.installed) {
                    const wordsK = status.wordCount ? Math.round(status.wordCount / 1000) : 770
                    labelStatus.innerText = `已就绪 (${wordsK}k 词条)`
                    labelStatus.style.color = '#10b981'
                } else {
                    labelStatus.innerText = '未安装'
                    labelStatus.style.color = '#ef4444'
                }
            }
            if (labelPath && locations?.dictionaryDir) {
                labelPath.innerText = `存储位置：${locations.dictionaryDir}`
            }
        } catch (_) {
            if (labelStatus) labelStatus.innerText = '未安装'
        }
    }

    updateTxtRuleControls() {
        const enabled = !!this.config.txtCustomRulesEnable
        for (const id of ['setting-txt-template-select', 'setting-txt-regex-pattern', 'btn-test-txt-rules', 'btn-apply-txt-rules']) {
            const control = document.getElementById(id)
            if (control) control.disabled = !enabled
        }
        const pattern = document.getElementById('setting-txt-regex-pattern')
        const template = document.getElementById('setting-txt-template-select')
        if (pattern && template) pattern.readOnly = enabled && template.value !== 'custom'
        const result = document.getElementById('txt-rules-test-result')
        if (result && !enabled) result.style.display = 'none'
    }

    async testTxtRulesOnCurrentBook() {
        const pattern = this.config.txtRegexPattern
        const resultEl = document.getElementById('txt-rules-test-result')
        if (!resultEl) return

        const book = this.app?.foliateView?.book
        const sampleLines = book?.tocPreviewLines
        if (!this.config.txtCustomRulesEnable || !Array.isArray(sampleLines) || sampleLines.length === 0) {
            resultEl.style.display = 'block'
            resultEl.innerText = this.config.txtCustomRulesEnable ? '请先打开 TXT 图书，再测试当前图书的目录规则。' : '请先开启自定义目录规则。'
            resultEl.style.color = 'var(--text-secondary, #6b7280)'
            return
        }

        resultEl.style.display = 'block'
        resultEl.innerText = '正在检查当前 TXT 图书的前 1000 行...'
        resultEl.style.color = 'var(--text-secondary, #6b7280)'

        try {
            const rule = {
                pattern,
                flags: this.config.txtRegexFlags || 'i',
                groupIndex: Number(this.config.txtGroupIndex) || 0,
                level: 1
            }

            const { matches } = await runTxtRulesWorker({
                lines: sampleLines,
                rules: [rule],
                maxMatches: 5,
                timeoutMs: 800
            })

            if (matches.length > 0) {
                const previewTitles = matches.slice(0, 3).map(m => m.title).join('\n')
                resultEl.innerText = `当前图书匹配到的章节：\n${previewTitles}`
                resultEl.style.color = 'var(--accent, #16a34a)'
            } else {
                resultEl.innerText = '当前图书前 1000 行未匹配到章节，请调整规则。'
                resultEl.style.color = '#ef4444'
            }
        } catch (err) {
            resultEl.style.display = 'block'
            resultEl.innerText = `规则检查失败：${err.message}`
            resultEl.style.color = '#ef4444'
        }
    }

    async applyTxtRulesAndReload() {
        this.applyRuntimeConfig()
        if (!this.app?.foliateView?.book?.tocPreviewLines) {
            this.app?.showToast?.('规则已保存，将在打开 TXT 图书时生效', 'info')
            return
        }
        const bookId = this.app?.currentBookId
        if (!bookId || typeof this.app.openBook !== 'function') return
        const fraction = this.app?.currentLocation?.fraction
        try {
            await this.app.openBook(bookId, Number.isFinite(fraction) ? { fraction } : null)
            this.app?.showToast?.('当前 TXT 图书目录已按新规则重建', 'info')
        } catch (error) {
            console.warn('[AdvancedSettings] TXT directory rebuild failed:', error)
            this.app?.showToast?.('目录重建失败，请重新打开这本 TXT 图书', 'warn')
        }
    }

    exportSettingsJSON() {
        const safeConfig = { ...this.config }
        const sensitiveKeys = ['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory']
        for (const k of sensitiveKeys) {
            delete safeConfig[k]
        }

        const exportData = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            advancedSettings: safeConfig
        }
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `linden_leaf_settings_${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
        this.app?.showToast?.('配置已安全导出为 JSON 文件', 'success')
    }

    async importSettingsJSON(file) {
        if (!file) return
        if (file.size > 512 * 1024) {
            this.app?.showToast?.('导入失败：配置文件大小超过 512KB 上限', 'warn')
            return
        }

        try {
            const text = await file.text()
            const parsed = JSON.parse(text)
            const incoming = parsed.advancedSettings || (parsed.config ? parsed.config : null)
            if (!incoming || typeof incoming !== 'object') {
                throw new Error('无效的设置配置文件格式，缺少 advancedSettings 对象')
            }

            // Create rollback backup snapshot before modifying config
            const rollbackConfig = { ...this.config }

            const sanitized = { ...DEFAULT_ADVANCED_SETTINGS }
            const allowedKeys = new Set(Object.keys(DEFAULT_ADVANCED_SETTINGS))

            // Prohibited sensitive keys to strictly prevent credential or private path leak
            const sensitiveKeys = new Set(['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory', '__proto__', 'constructor', 'prototype'])

            for (const [k, v] of Object.entries(incoming)) {
                if (!allowedKeys.has(k) || sensitiveKeys.has(k)) continue

                const defaultVal = DEFAULT_ADVANCED_SETTINGS[k]
                const expectedType = typeof defaultVal

                if (expectedType === 'boolean') {
                    sanitized[k] = Boolean(v)
                } else if (expectedType === 'number') {
                    const n = Number(v)
                    if (Number.isFinite(n)) {
                        sanitized[k] = n
                    }
                } else if (expectedType === 'string') {
                    if (typeof v === 'string') {
                        sanitized[k] = v.trim().slice(0, 500)
                    }
                }
            }

            this.config = sanitized
            this.save()
            this.renderUIState()
            this._lastRollbackConfig = rollbackConfig
            this.app?.showToast?.('高级设置已安全校验并成功导入', 'success')
        } catch (e) {
            this.app?.showToast?.(`导入失败: ${e.message}`, 'warn')
        }
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
        return Math.max(256, Math.min(8192, Number(this.config.aiMaxTokens) || 2048))
    }

    get aiCooldownSeconds() {
        const raw = Number(this.config.aiCooldownSeconds)
        return Number.isFinite(raw) ? Math.max(0, Math.min(3600, raw)) : 10
    }

    get aiDailyLimit() {
        return Math.max(0, Number(this.config.aiDailyLimit) || 0)
    }
}

export const advancedSettings = new AdvancedSettingsManager()
