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

import { setCustomTxtPatterns, setTxtMergeSoftBreaks } from '../foliate-js-main/txt.js'
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
    aiMaxTokens: 2048,                   // 256 to 20000 tokens
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
    ttsSystemVoiceId: '',
    ttsApiVoiceId: 'nova',
    ttsOfflineVoiceId: 'zf_xiaobei',
    ttsApiNoAuth: false,
    ttsApiEndpoint: 'https://api.openai.com/v1/audio/speech',
    ttsApiKeyConfigured: false,
    ttsApiModel: 'tts-1',
    ttsOfflineEndpoint: 'http://127.0.0.1:8880/v1/audio/speech',
    ttsOfflineModel: 'kokoro-82m-zh'
})

export function sanitizeAdvancedSettings(incoming = {}) {
    const result = { ...DEFAULT_ADVANCED_SETTINGS }
    for (const [key, value] of Object.entries(incoming)) {
        if (!Object.hasOwn(result, key)) continue
        const type = typeof result[key]
        if (type === 'boolean' && typeof value === 'boolean') result[key] = value
        if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) result[key] = value
        if (type === 'string' && typeof value === 'string') result[key] = value.trim().slice(0, 1000)
    }
    const bounds = { aiContextTokenBudget: [0, 10000], aiMaxTokens: [256, 20000], aiCooldownSeconds: [0, 3600], aiDailyLimit: [0, 100000],
        paraMarginTop: [0, 3], paraMarginBottom: [0, 3], sidebarDefaultWidth: [320, 640], dictLookupDelay: [100, 600],
        highlighterOpacity: [0.15, 0.75], underlineWidth: [0.5, 5], pdfPenWidth: [0.5, 10], bgIndexConcurrency: [1, 4], ttsRate: [0.5, 3] }
    for (const [key, [min, max]] of Object.entries(bounds)) result[key] = Math.max(min, Math.min(max, result[key]))
    const enums = { ttsProvider: ['system', 'api', 'offline'], chapterTransStyle: ['auto', 'literal', 'literary', 'academic'],
        animIntensity: ['none', 'soft', 'normal'], modelTokenizer: ['auto', 'cl100k_base', 'gpt2', 'cjk_heuristic'], paraIndentSize: ['0', '0em', '1em', '2em', '3em'] }
    for (const [key, allowed] of Object.entries(enums)) if (!allowed.includes(result[key])) result[key] = DEFAULT_ADVANCED_SETTINGS[key]
    return result
}

const STORAGE_KEY_UNLOCKED = 'linden_advanced_settings_unlocked'
const STORAGE_KEY_CONFIG = 'linden_advanced_settings_config'

export class AdvancedSettingsManager {
    constructor(app = null) {
        this.app = app
        this.isUnlocked = true
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
            this.isUnlocked = true
            const saved = localStorage.getItem(STORAGE_KEY_CONFIG)
            if (saved) {
                const parsed = JSON.parse(saved)
                // Migrate legacy plaintext TTS API key if present in old config
                if (parsed.ttsApiKey) {
                    this._migrateLegacyTtsKey(parsed.ttsApiKey)
                    delete parsed.ttsApiKey
                }
                this.config = sanitizeAdvancedSettings(parsed)
                const legacyVoice = parsed.ttsVoiceId
                if (legacyVoice && !Object.hasOwn(parsed, 'ttsApiVoiceId') && parsed.ttsProvider === 'api') this.config.ttsApiVoiceId = legacyVoice
                if (legacyVoice && !Object.hasOwn(parsed, 'ttsOfflineVoiceId') && parsed.ttsProvider === 'offline') this.config.ttsOfflineVoiceId = legacyVoice
                delete this.config.ttsApiKey

                // Enforce budget bounds [0, 10000] (0 is a valid budget that disables extra context)
                const rawBudget = Number(this.config.aiContextTokenBudget)
                this.config.aiContextTokenBudget = Number.isFinite(rawBudget) ? Math.max(0, Math.min(10000, rawBudget)) : 1000
                this.config.aiMaxTokens = Math.max(256, Math.min(20000, Number(this.config.aiMaxTokens) || 2048))
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
        setTxtMergeSoftBreaks(this.config.txtMergeSoftBreaks !== false)
        try { localStorage.setItem('linden_sync_chapter_translations', String(!!this.config.webdavSyncTranslations)) } catch (_) {}
        if (typeof ttsPlayer !== 'undefined') ttsPlayer.loadSettings?.(this.config)
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
                document.documentElement.style.setProperty('--overlayer-highlight-opacity', String(this.config.highlighterOpacity))
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

            const width = Math.max(320, Math.min(640, Number(this.config.sidebarDefaultWidth) || 380))
            if (this._appliedSidebarWidth !== width) {
                this._appliedSidebarWidth = width
                const sidebar = this.app?.aiSidebar
                const anchor = sidebar?.captureCurrentReadingAnchor?.()
                document.documentElement.style.setProperty('--ai-sidebar-width', `${width}px`)
                if (sidebar) { sidebar.currentWidth = width; if (sidebar.isOpen) sidebar.relayoutReader(anchor).catch(() => {}) }
            }
            this.app?.refreshTtsVoiceOptions?.()
        } catch (e) {}
    }

    applyReaderParameters() {
        for (const key of ['firstParaIndent', 'paraMarginTop', 'paraMarginBottom', 'paraIndentSize']) this.app?.setSetting?.(key, this.config[key])
        this.app?.saveSettingsDebounced?.()
        this.app?.applySettingsToReader?.()
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
        if (this.isUnlocked) {
            this.updateTransStorageStats()
        }
    }

    renderUIState() {
        const d = this.dom

        if (d.badgeAdvancedStatus) {
            d.badgeAdvancedStatus.innerText = this.isUnlocked ? '已展开' : '可展开'
            d.badgeAdvancedStatus.style.background = this.isUnlocked ? 'rgba(74, 222, 128, 0.15)' : 'var(--bg-tertiary)'
            d.badgeAdvancedStatus.style.color = this.isUnlocked ? '#16a34a' : 'var(--text-muted)'
        }

        if (d.hintAdvancedTrigger) {
            d.hintAdvancedTrigger.innerText = this.isUnlocked ? '点击折叠/展开' : '点击展开'
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
        if (paraTopVal) paraTopVal.innerText = `${Number(effTypography.paraMarginTop ?? 0.0).toFixed(2)}em`
        const paraBottom = document.getElementById('setting-para-margin-bottom')
        if (paraBottom) paraBottom.value = String(effTypography.paraMarginBottom ?? 0.5)
        const paraBottomVal = document.getElementById('value-para-margin-bottom')
        if (paraBottomVal) paraBottomVal.innerText = `${Number(effTypography.paraMarginBottom ?? 0.5).toFixed(2)}em`
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
        if (ttsApiKey) ttsApiKey.value = this.config.ttsApiKeyConfigured ? '••••••••••••••••' : ''
        for (const [id, key] of [['setting-tts-api-voice', 'ttsApiVoiceId'], ['setting-tts-offline-voice', 'ttsOfflineVoiceId'], ['setting-sidebar-default-width', 'sidebarDefaultWidth']]) {
            const el = document.getElementById(id); if (el) el.value = String(this.config[key] ?? '')
        }
        const noAuth = document.getElementById('setting-tts-api-no-auth')
        if (noAuth) noAuth.checked = this.config.ttsApiNoAuth === true
        this.updateTtsProviderVisibility()
    }

    updateTtsProviderVisibility() {
        const provider = this.config.ttsProvider || 'system'
        const group = document.getElementById('adv-group-tts')
        group?.querySelectorAll('[data-tts-for]').forEach(row => { row.hidden = row.dataset.ttsFor !== provider })
        const description = document.getElementById('tts-provider-description')
        if (description) description.textContent = provider === 'system'
            ? '使用设备系统语音，无需填写接口地址或密钥。'
            : '模型与音色名称以所用服务为准；自定义接口不一定支持情绪、风格参数。'
        if (description && platformBridge.isAndroid) description.textContent += provider === 'system'
            ? ' 支持锁屏连续播放。'
            : ' 当前请保持应用在前台；自建服务地址须能由手机访问，127.0.0.1 指手机本机。'
        const note = document.getElementById('tts-preview-note')
        if (note) note.textContent = provider === 'api' ? '使用所配置的接口试听，可能产生服务费用'
            : provider === 'offline' ? '使用用户自建服务试听' : '使用当前系统音色试听'
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
        document.getElementById('setting-ai-cooldown')?.addEventListener('input', (e) => {
            const raw = parseInt(e.target.value, 10)
            const tip = document.getElementById('tip-ai-cooldown-warning')
            if (tip) {
                tip.style.display = (!isNaN(raw) && (raw === 0 || raw < 5)) ? 'block' : 'none'
            }
        })
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
            const val = Math.max(256, Math.min(20000, parseInt(e.target.value, 10) || 2048))
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
            const raw = parseFloat(e.target.value)
            const val = Number(Number(Number.isFinite(raw) ? raw : 0).toFixed(2))
            this.config.paraMarginTop = val
            const label = document.getElementById('value-para-margin-top')
            if (label) label.innerText = `${val.toFixed(2)}em`
            this.app?.setSetting?.('paraMarginTop', val)
            this.app?.saveSettingsDebounced?.()
            this.save()
            this.app?.applySettingsToReader?.()
        })

        document.getElementById('setting-para-margin-bottom')?.addEventListener('input', (e) => {
            const raw = parseFloat(e.target.value)
            const val = Number(Number(Number.isFinite(raw) ? raw : 0.5).toFixed(2))
            this.config.paraMarginBottom = val
            const label = document.getElementById('value-para-margin-bottom')
            if (label) label.innerText = `${val.toFixed(2)}em`
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

        document.getElementById('setting-sidebar-default-width')?.addEventListener('change', e => {
            this.config.sidebarDefaultWidth = Math.max(320, Math.min(640, Number(e.target.value) || 380))
            this.save()
        })

        // TXT soft break merge & Background indexing settings
        document.getElementById('setting-txt-merge-soft-breaks')?.addEventListener('change', (e) => {
            this.config.txtMergeSoftBreaks = !!e.target.checked
            this.save()
            this.app?.showToast?.('软换行设置已保存，重新打开 TXT 图书后生效', 'info')
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
            const confirmed = this.app?.showConfirmDialog
                ? await this.app.showConfirmDialog('清空译文缓存', '确定要清空所有书籍的章节双语译文缓存吗？\n（此操作不会删除原书、笔记或划线）')
                : confirm('确定要清空所有书籍的章节双语译文缓存吗？\n（此操作不会删除原书、笔记或划线）')
            if (confirmed) {
                await clearAllChapterTranslations()
                this.updateTransStorageStats()
                this.app?.showToast?.('已清空全部章节双语译文缓存', 'info')
            }
        })

        // Audio Cache & Dictionary Resource Locations
        document.getElementById('btn-clear-audio-cache')?.addEventListener('click', async () => {
            try {
                const memory = ttsPlayer.clearAudioCache()
                const diskBytes = Number(await dictionaryService.clearAudioCache()) || 0
                this.app?.showToast?.(`已清理 ${memory.count} 段缓存音频，共 ${((memory.bytes + diskBytes) / 1024 / 1024).toFixed(1)} MB`, 'info')
            } catch (e) {
                this.app?.showToast?.(`清空语音缓存失败: ${e.message}`, 'warning')
            }
        })

        document.getElementById('btn-dict-download')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-dict-download')
            const labelStatus = document.getElementById('label-dict-resource-status')
            if (btn) btn.disabled = true
            this._dictDownloadController = new AbortController()
            const cancel = document.getElementById('btn-dict-cancel-download')
            if (cancel) cancel.style.display = ''
            try {
                this.app?.showToast?.('开始下载官方 ECDICT 词库...', 'info')
                await dictionaryService.downloadAndInstall({
                    signal: this._dictDownloadController.signal,
                    onProgress: (p) => {
                        if (labelStatus) {
                            labelStatus.innerText = p.message || `${p.phase}: ${p.percent}%`
                        }
                    }
                })
                await this.updateDictResourceStatus()
                this.app?.showToast?.('词库下载并安装成功！', 'success')
            } catch (err) {
                this.app?.showToast?.(this._dictDownloadController?.signal.aborted ? '词库下载已取消' : `下载失败: ${err.message}`, 'warning')
                await this.updateDictResourceStatus()
            } finally {
                if (btn) btn.disabled = false
                if (cancel) cancel.style.display = 'none'
                this._dictDownloadController = null
                this.updateDictResourceStatus()
            }
        })
        document.getElementById('btn-dict-cancel-download')?.addEventListener('click', () => this._dictDownloadController?.abort())

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
                    this.app?.showToast?.(`词库目录已设为：${targetDir}`, 'success')
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
        for (const [id, key] of [['setting-tts-api-voice', 'ttsApiVoiceId'], ['setting-tts-offline-voice', 'ttsOfflineVoiceId']]) {
            document.getElementById(id)?.addEventListener('change', e => {
                this.config[key] = e.target.value.trim()
                this.save()
                this.app?.refreshTtsVoiceOptions?.()
            })
        }
        document.getElementById('setting-tts-api-no-auth')?.addEventListener('change', e => {
            this.config.ttsApiNoAuth = !!e.target.checked
            this.save()
        })
        document.getElementById('btn-tts-preview')?.addEventListener('click', async e => {
            const button = e.currentTarget
            if (ttsPlayer._previewController) { ttsPlayer.cancelPreview(); return }
            button.innerText = '停止试听'
            this.app?.showToast?.(this.config.ttsProvider === 'api' ? '使用当前朗读接口试听，可能产生服务费用' : '正在试听当前语音', 'info')
            try { await ttsPlayer.preview() }
            catch (error) { if (error.name !== 'AbortError') this.app?.showToast?.(`试听失败：${error.message}`, 'warning') }
            finally { button.innerText = '试听短句' }
        })
        document.getElementById('setting-tts-provider')?.addEventListener('change', (e) => {
            this.config.ttsProvider = e.target.value
            this.updateTtsProviderVisibility()
            this.save()
            this.app?.refreshTtsVoiceOptions?.()
        })

        document.getElementById('setting-tts-rate')?.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value) || 1.0
            this.config.ttsRate = val
            const label = document.getElementById('value-tts-rate')
            if (label) label.innerText = `${val.toFixed(1)}x`
            this.save()
            this.app?.refreshTtsVoiceOptions?.()
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

        const restoreFileInput = document.getElementById('input-restore-full-data-file')
        document.getElementById('btn-restore-full-data-backup')?.addEventListener('click', () => {
            if (restoreFileInput) {
                restoreFileInput.value = ''
                restoreFileInput.click()
            }
        })
        restoreFileInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            try {
                const text = await file.text()
                const data = JSON.parse(text)
                await this.restoreFullDataBackup(data)
            } catch (err) {
                this.app?.showToast?.(`恢复失败: ${err.message}`, 'warning')
            }
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

    async assembleFullBackupData(customDb = this.db || db) {
        const activeDb = customDb || this.db || db
        const [sessions, highlights, books, bookmarks, drawings, customLists] = await Promise.all([
            activeDb.getAllReadingSessions ? activeDb.getAllReadingSessions() : Promise.resolve([]),
            activeDb.getAllHighlights ? activeDb.getAllHighlights() : Promise.resolve([]),
            activeDb.getAllBooks ? activeDb.getAllBooks() : Promise.resolve([]),
            activeDb.getAllBookmarks ? activeDb.getAllBookmarks() : Promise.resolve([]),
            activeDb.getAllPdfDrawings ? activeDb.getAllPdfDrawings() : Promise.resolve([]),
            activeDb.getAllCustomLists ? activeDb.getAllCustomLists() : Promise.resolve([])
        ])

        let chapterTranslations = []
        if (activeDb.getAllChapterTranslations) {
            try {
                chapterTranslations = await activeDb.getAllChapterTranslations()
            } catch (_) {}
        }

        let deletedRecords = []
        if (activeDb.getAllDeletedRecords) {
            try {
                deletedRecords = await activeDb.getAllDeletedRecords()
            } catch (_) {}
        }

        const manualTocs = {}
        for (const b of books) {
            if (b && b.id && activeDb.getSetting) {
                try {
                    const toc = await activeDb.getSetting(`linden_manual_toc_${b.id}`)
                    if (Array.isArray(toc) && toc.length > 0) {
                        manualTocs[b.id] = toc
                    }
                } catch (_) {}
            }
        }

        const readerSettings = (await activeDb.getSetting?.('readerSettings')) || (await activeDb.getSetting?.('reader_settings')) || {}

        let readingPresets = []
        try {
            const rawPresets = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_reading_presets_v1') : null
            if (rawPresets) readingPresets = JSON.parse(rawPresets) || []
        } catch (_) {}

        let customPalette = null
        try {
            const rawPalette = typeof localStorage !== 'undefined' ? localStorage.getItem('linden_custom_semantic_palette_v1') : null
            if (rawPalette) customPalette = JSON.parse(rawPalette)
        } catch (_) {}

        let userName = ''
        try {
            userName = (typeof localStorage !== 'undefined' ? (localStorage.getItem('linden_user_name') || '') : '').trim()
        } catch (_) {}

        const bookSettingsOverrides = {}
        try {
            if (typeof localStorage !== 'undefined') {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i)
                    if (k && k.startsWith('linden_book_settings_')) {
                        const bId = k.replace('linden_book_settings_', '')
                        try {
                            bookSettingsOverrides[bId] = JSON.parse(localStorage.getItem(k))
                        } catch (_) {}
                    }
                }
            }
        } catch (_) {}

        const safeConfig = { ...(this.config || {}) }
        const sensitiveKeys = ['ttsApiKey', 'apiKey', 'secret', 'password', 'token', 'auth', 'privateKey', 'dictStoragePath', 'customDirectory']
        for (const k of sensitiveKeys) {
            delete safeConfig[k]
        }

        const bookMapById = new Map(books.map(b => [b.id, b]))
        const enrichedSessions = sessions.map(s => {
            if (!s) return s
            const b = s.bookId ? bookMapById.get(s.bookId) : null
            return {
                ...s,
                bookTitle: s.bookTitle || b?.customTitle || b?.title || '',
                bookAuthor: s.bookAuthor || b?.customAuthor || b?.author || ''
            }
        })

        return {
            format: 'linden-leaf-full-backup',
            schemaVersion: 4,
            exportedAt: new Date().toISOString(),
            userName,
            readerSettings,
            readingPresets,
            customPalette,
            bookSettingsOverrides,
            config: safeConfig,
            sessions: enrichedSessions,
            highlights,
            bookmarks,
            drawings,
            customLists,
            readingLists: customLists,
            chapterTranslations,
            deletedRecords,
            manualTocs,
            books: books.map(b => ({
                id: b.id,
                stableKey: b.stableKey || null,
                identifier: b.identifier || null,
                documentHash: b.documentHash || null,
                blobRevision: b.blobRevision || null,
                nativePath: b.nativePath || null,
                nativeSnapshotPath: b.nativeSnapshotPath || null,
                sourceDescriptor: b.sourceDescriptor || null,
                title: b.title,
                author: b.author,
                customTitle: b.customTitle || null,
                customAuthor: b.customAuthor || null,
                format: b.format,
                size: b.size || 0,
                cover: b.cover || null,
                isFavorite: !!b.isFavorite,
                favoriteUpdatedAt: b.favoriteUpdatedAt || 0,
                readingStatus: b.readingStatus || 'unread',
                statusUpdatedAt: b.statusUpdatedAt || 0,
                completedAt: b.completedAt || null,
                rating: b.rating !== undefined ? b.rating : null,
                ratingUpdatedAt: b.ratingUpdatedAt || 0,
                tags: Array.isArray(b.tags) ? b.tags : [],
                tagsUpdatedAt: b.tagsUpdatedAt || 0,
                customListIds: b.customListIds || [],
                listsUpdatedAt: b.listsUpdatedAt || 0,
                totalReadingSeconds: b.totalReadingSeconds || 0,
                totalListeningSeconds: b.totalListeningSeconds || 0,
                lastReadAt: b.lastReadAt || 0,
                currentLocation: b.currentLocation || null,
                progress: b.progress || { fraction: 0 },
                addedAt: b.addedAt || 0,
                updatedAt: b.updatedAt || 0
            }))
        }
    }

    async createFullDataBackup(options = {}) {
        const payload = await this.assembleFullBackupData(options.db || this.db || db)
        const backupId = 'backup_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
        const jsonContent = JSON.stringify(payload, null, 2)
        const filename = options.filename || `linden_leaf_auto_backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}_${backupId.replace(/^backup_/, '')}.json`
        let backupPath = null

        const bridge = (typeof window !== 'undefined' ? window.platformBridge : null)
        if (!bridge) {
            return {
                success: false,
                error: '未连接平台桥，无法进行持久化本地备份'
            }
        }

        try {
            const paths = typeof bridge.fsGetAppPaths === 'function' ? await bridge.fsGetAppPaths() : null
            const baseDir = options.targetDir || paths?.data_dir || paths?.config_dir
            if (!baseDir) {
                throw new Error('未找到可用的备份落盘目录 (No target data_dir)')
            }
            const sep = baseDir.includes('/') ? '/' : '\\'
            backupPath = `${baseDir.replace(/[\\/]+$/, '')}${sep}${filename}`
            if (typeof bridge.writeSyncFile === 'function') {
                const res = await bridge.writeSyncFile(backupPath, jsonContent)
                if (!res || !res.success) throw new Error(`持久化备份文件失败: ${res?.error || 'CAS/Write failed'}`)
            } else if (typeof bridge.writeFileText === 'function') {
                const wrote = await bridge.writeFileText(backupPath, jsonContent)
                if (wrote === false) throw new Error('持久化备份文件失败')
            } else if (typeof bridge.saveTextFile === 'function') {
                const wrote = await bridge.saveTextFile(backupPath, jsonContent)
                if (wrote === false) throw new Error('持久化备份文件失败')
            } else {
                throw new Error('平台桥不支持文件写入')
            }
            return {
                success: true,
                backupId,
                path: backupPath,
                payload
            }
        } catch (err) {
            console.error('[createFullDataBackup] failed:', err)
            throw new Error(`自动备份写入失败: ${err.message || String(err)}`)
        }
    }

    async exportFullDataBackup() {
        try {
            const payload = await this.assembleFullBackupData(this.db || db)
            const filename = `LindenLeaf_阅读记录备份_${new Date().toISOString().slice(0, 10)}.json`
            const res = await platformBridge.exportTextFile(filename, JSON.stringify(payload, null, 2), 'application/json')
            if (res?.cancelled) {
                return
            }
            if (res.success) {
                if (res.filePath) {
                    this.app?.showToast?.(`阅读记录已导出至：${res.filePath}；原书文件需另外保留`, 'success', 5000)
                } else {
                    this.app?.showToast?.(`阅读记录已导出至${res.directoryHint}：${res.filename}；原书文件需另外保留`, 'success', 5000)
                }
            } else if (res?.error) {
                this.app?.showToast?.(`备份导出失败: ${res.error}`, 'warning')
            }
        } catch (e) {
            this.app?.showToast?.(`备份导出失败: ${e.message}`, 'warning')
        }
    }

    async restoreFullDataBackup(backupData, customDb = this.db || db) {
        const activeDb = customDb || this.db || db
        const operationId = `restore_op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const acquire = activeDb.acquireRestoreOperationLock
        if (typeof acquire === 'function') await acquire(operationId)
        try {
            return await AdvancedSettingsManager.prototype._restoreFullDataBackupLocked.call(this, backupData, activeDb, operationId)
        } finally {
            if (typeof activeDb.releaseRestoreOperationLock === 'function') await activeDb.releaseRestoreOperationLock(operationId)
        }
    }

    async _restoreFullDataBackupLocked(backupData, customDb, operationId) {
        if (!backupData || typeof backupData !== 'object') {
            throw new Error('无效的备份数据格式')
        }
        if (backupData.format !== 'linden-leaf-full-backup' || ![1, 2, 3, 4].includes(backupData.schemaVersion)) {
            throw new Error('不支持的备份文件格式')
        }
        const activeDb = customDb || this.db || db

        // 1. Snapshot existing records to verify conflicts & support rollback
        const [
            existingBooks,
            existingHighlights,
            existingBookmarks,
            existingSessions,
            existingTranslations,
            existingDrawings,
            existingLists,
            existingDeleted
        ] = await Promise.all([
            activeDb.getAllBooks ? activeDb.getAllBooks() : Promise.resolve([]),
            activeDb.getAllHighlights ? activeDb.getAllHighlights() : Promise.resolve([]),
            activeDb.getAllBookmarks ? activeDb.getAllBookmarks() : Promise.resolve([]),
            activeDb.getAllReadingSessions ? activeDb.getAllReadingSessions() : Promise.resolve([]),
            activeDb.getAllChapterTranslations ? activeDb.getAllChapterTranslations() : Promise.resolve([]),
            activeDb.getAllPdfDrawings ? activeDb.getAllPdfDrawings() : (activeDb.getAllPdfPageDrawings ? activeDb.getAllPdfPageDrawings() : Promise.resolve([])),
            activeDb.getAllCustomLists ? activeDb.getAllCustomLists() : Promise.resolve([]),
            activeDb.getAllDeletedRecords ? activeDb.getAllDeletedRecords() : Promise.resolve([])
        ])

        const snapshot = {
            books: existingBooks || [],
            highlights: existingHighlights || [],
            bookmarks: existingBookmarks || [],
            sessions: existingSessions || [],
            translations: existingTranslations || [],
            drawings: existingDrawings || [],
            lists: existingLists || [],
            deletedRecords: existingDeleted || []
        }

        const existingBookMap = new Map((snapshot.books).map(b => [b.id, b]))
        const bookIdRemap = new Map()

        // 2. Tombstone reconciliation: combine local tombstones and incoming backup tombstones
        const combinedDeleted = [
            ...(existingDeleted || []),
            ...(Array.isArray(backupData.deletedRecords) ? backupData.deletedRecords : [])
        ].filter(Boolean)
        const tombstonedBookIds = new Set()
        const isTombstoned = (b) => {
            if (!b) return false
            return combinedDeleted.some(dr => {
                if (
                    dr.id === b.id ||
                    (b.stableKey && (dr.id === `key:${b.stableKey}` || dr.stableKey === `id:${b.id}`)) ||
                    (b.documentHash && (dr.id === `docHash:${b.documentHash}` || dr.documentHash === b.documentHash || dr.stableKey === `hash:${b.documentHash}`))
                ) {
                    return (dr.deletedAt || 0) >= (b.updatedAt || b.addedAt || 0)
                }
                return false
            })
        }
        if (Array.isArray(backupData.books)) {
            for (const b of backupData.books) {
                if (b && b.id && isTombstoned(b)) {
                    tombstonedBookIds.add(b.id)
                }
            }
        }
        for (const dr of combinedDeleted) {
            if (dr && (dr.type === 'book' || dr.type === 'books')) {
                const matchBook = Array.isArray(backupData.books) ? backupData.books.find(b => b && b.id === dr.id) : null
                if (!matchBook || (dr.deletedAt || 0) >= (matchBook.updatedAt || matchBook.addedAt || 0)) {
                    tombstonedBookIds.add(dr.id)
                }
            }
        }

        const isItemTombstoned = (item) => {
            if (!item || !item.id) return false
            if (item.bookId && tombstonedBookIds.has(item.bookId)) return true
            return combinedDeleted.some(dr => {
                if (dr.id === item.id) {
                    return (dr.deletedAt || 0) >= (item.updatedAt || item.createdAt || 0)
                }
                return false
            })
        }

        // 3. Pre-map books to resolve content identity conflicts
        if (Array.isArray(backupData.books)) {
            for (const b of backupData.books) {
                if (!b || !b.id) continue
                if (isTombstoned(b)) continue
                let existing = existingBookMap.get(b.id)
                if (!existing && typeof activeDb.getBook === 'function') {
                    existing = await activeDb.getBook(b.id).catch(() => null)
                    if (existing) existingBookMap.set(b.id, existing)
                }
                if (existing) {
                    let isConflict = false
                    if (existing.documentHash && b.documentHash && existing.documentHash !== b.documentHash) {
                        isConflict = true
                    } else if (!existing.documentHash || !b.documentHash) {
                        if (existing.format && b.format && existing.format.toLowerCase() !== b.format.toLowerCase()) {
                            isConflict = true
                        } else if (existing.size && b.size && existing.size !== b.size) {
                            isConflict = true
                        } else if (existing.stableKey && b.stableKey && existing.stableKey !== b.stableKey) {
                            isConflict = true
                        }
                    }

                    if (isConflict) {
                        const cleanHash = (b.documentHash || '').replace(/[^a-zA-Z0-9_-]/g, '')
                        const suffix = cleanHash || (b.stableKey || Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'diff'
                        let mappedId = `${b.id}_backup_${suffix}`
                        let counter = 1
                        while (existingBookMap.has(mappedId) && existingBookMap.get(mappedId).documentHash !== b.documentHash) {
                            mappedId = `${b.id}_backup_${suffix}_${counter++}`
                        }
                        bookIdRemap.set(b.id, mappedId)
                    }
                }
            }
        }

        // 4. Build restore plan
        const booksToPut = []
        const highlightsToPut = []
        const bookmarksToPut = []
        const sessionsToPut = []
        const translationsToPut = []
        const drawingsToPut = []
        const listsToPut = []
        const settingsToPut = []

        // 4a. Chapter Translations
        if (Array.isArray(backupData.chapterTranslations)) {
            const existingTrMap = new Map((snapshot.translations || []).map(t => [t.id, t]))
            for (const ct of backupData.chapterTranslations) {
                if (ct && ct.bookId && ct.chapterKey) {
                    if (isItemTombstoned(ct)) continue
                    const targetBookId = bookIdRemap.get(ct.bookId) || ct.bookId
                    const targetId = `${targetBookId}::${ct.chapterKey}`
                    const existing = existingTrMap.get(targetId)
                    if (existing && (existing.updatedAt || 0) > (ct.updatedAt || 0)) {
                        continue
                    }
                    translationsToPut.push({
                        ...ct,
                        bookId: targetBookId,
                        id: targetId
                    })
                }
            }
        }

        // 4b. Reading Sessions
        if (Array.isArray(backupData.sessions)) {
            const existingSessionMap = new Map((snapshot.sessions || []).map(s => [s.id, s]))
            for (const s of backupData.sessions) {
                if (!s || !s.id) continue
                if (isItemTombstoned(s)) continue
                const targetBookId = (s.bookId && bookIdRemap.has(s.bookId)) ? bookIdRemap.get(s.bookId) : s.bookId
                const targetSessionId = targetBookId !== s.bookId ? `${s.id}_remap_${targetBookId}` : s.id
                let finalSession = { ...s, id: targetSessionId, bookId: targetBookId }
                const existing = existingSessionMap.get(targetSessionId)
                if (existing) {
                    finalSession = {
                        ...existing,
                        ...finalSession,
                        durationSeconds: Math.max(existing.durationSeconds || 0, s.durationSeconds || 0),
                        activeDurationSeconds: Math.max(existing.activeDurationSeconds || 0, s.activeDurationSeconds || 0),
                        updatedAt: Math.max(existing.updatedAt || 0, s.updatedAt || 0)
                    }
                }
                sessionsToPut.push(finalSession)
            }
        }

        // 4c. Highlights
        if (Array.isArray(backupData.highlights)) {
            const existingHlMap = new Map((snapshot.highlights || []).map(h => [h.id, h]))
            for (const h of backupData.highlights) {
                if (!h || !h.id) continue
                if (isItemTombstoned(h)) continue
                const targetBookId = (h.bookId && bookIdRemap.has(h.bookId)) ? bookIdRemap.get(h.bookId) : h.bookId
                const targetHlId = targetBookId !== h.bookId ? `${h.id}_remap_${targetBookId}` : h.id
                const incomingTime = h.updatedAt || h.createdAt || 0
                const existing = existingHlMap.get(targetHlId)
                if (existing) {
                    const existingTime = existing.updatedAt || existing.createdAt || 0
                    if (existingTime > incomingTime) {
                        continue
                    }
                }
                highlightsToPut.push({
                    ...h,
                    id: targetHlId,
                    bookId: targetBookId
                })
            }
        }

        // 4d. Bookmarks
        if (Array.isArray(backupData.bookmarks)) {
            const existingBmMap = new Map((snapshot.bookmarks || []).map(bm => [bm.id, bm]))
            for (const bm of backupData.bookmarks) {
                if (!bm || !bm.id) continue
                if (isItemTombstoned(bm)) continue
                const targetBookId = (bm.bookId && bookIdRemap.has(bm.bookId)) ? bookIdRemap.get(bm.bookId) : bm.bookId
                const targetBmId = targetBookId !== bm.bookId ? `${bm.id}_remap_${targetBookId}` : bm.id
                const incomingTime = bm.updatedAt || bm.createdAt || 0
                const existing = existingBmMap.get(targetBmId)
                if (existing) {
                    const existingTime = existing.updatedAt || existing.createdAt || 0
                    if (existingTime > incomingTime) continue
                }
                bookmarksToPut.push({ ...bm, id: targetBmId, bookId: targetBookId })
            }
        }

        // 4e. PDF Drawings
        if (Array.isArray(backupData.drawings)) {
            for (const d of backupData.drawings) {
                if (!d || !d.bookId || d.pageIndex == null) continue
                if (isItemTombstoned(d)) continue
                const targetBookId = bookIdRemap.has(d.bookId) ? bookIdRemap.get(d.bookId) : d.bookId
                const targetDrawingId = (typeof activeDb.remapPdfDrawingId === 'function')
                    ? activeDb.remapPdfDrawingId(d, targetBookId)
                    : (typeof activeDb.buildPdfDrawingKey === 'function'
                        ? activeDb.buildPdfDrawingKey(targetBookId, d.pageIndex, d)
                        : (typeof db.buildPdfDrawingKey === 'function'
                            ? db.buildPdfDrawingKey(targetBookId, d.pageIndex, d)
                            : `${targetBookId}_page_${d.pageIndex}`))
                drawingsToPut.push({
                    ...d,
                    bookId: targetBookId,
                    id: targetDrawingId
                })
            }
        }

        // 4f. Custom Lists
        const lists = backupData.customLists || backupData.readingLists
        if (Array.isArray(lists)) {
            for (const l of lists) {
                if (!l || !l.id) continue
                const remappedBookIds = Array.isArray(l.bookIds) 
                    ? l.bookIds.map(bId => bookIdRemap.get(bId) || bId)
                    : l.bookIds
                listsToPut.push({ ...l, bookIds: remappedBookIds })
            }
        }

        // 4g. Books
        if (Array.isArray(backupData.books)) {
            for (const b of backupData.books) {
                if (!b || !b.id) continue
                if (isTombstoned(b)) continue

                if (bookIdRemap.has(b.id)) {
                    const mappedId = bookIdRemap.get(b.id)
                    const existingTarget = existingBookMap.get(mappedId)
                    if (existingTarget) {
                        let progress = existingTarget.progress
                        const existingProgTime = existingTarget.progress?.updatedAt || 0
                        const incomingProgTime = b.progress?.updatedAt || 0
                        if (incomingProgTime > existingProgTime) {
                            progress = b.progress
                        } else if (existingProgTime === 0 && incomingProgTime === 0) {
                            const exFrac = existingTarget.progress?.fraction || 0
                            const inFrac = b.progress?.fraction || 0
                            progress = inFrac > exFrac ? b.progress : existingTarget.progress
                        }

                        const totalReadingSeconds = Math.max(
                            existingTarget.totalReadingSeconds || 0,
                            b.totalReadingSeconds || 0
                        )

                        booksToPut.push({
                            ...b,
                            ...existingTarget,
                            id: mappedId,
                            title: existingTarget.title || b.title,
                            author: existingTarget.author || b.author,
                            progress: progress || existingTarget.progress || b.progress,
                            totalReadingSeconds,
                            updatedAt: Math.max(existingTarget.updatedAt || 0, b.updatedAt || 0),
                            hasLocalFile: existingTarget.hasLocalFile !== undefined ? existingTarget.hasLocalFile : false,
                            isCloudOnly: existingTarget.hasLocalFile ? false : true,
                            documentHash: existingTarget.documentHash || b.documentHash
                        })
                    } else {
                        booksToPut.push({
                            ...b,
                            id: mappedId,
                            hasLocalFile: false,
                            isCloudOnly: true
                        })
                    }
                    continue
                }

                const existing = existingBookMap.get(b.id)
                if (existing) {
                    let progress = existing.progress
                    const existingProgTime = existing.progress?.updatedAt || 0
                    const incomingProgTime = b.progress?.updatedAt || 0
                    if (incomingProgTime > existingProgTime) {
                        progress = b.progress
                    } else if (existingProgTime === 0 && incomingProgTime === 0) {
                        const exFrac = existing.progress?.fraction || 0
                        const inFrac = b.progress?.fraction || 0
                        progress = inFrac > exFrac ? b.progress : existing.progress
                    }

                    const totalReadingSeconds = Math.max(
                        existing.totalReadingSeconds || 0,
                        b.totalReadingSeconds || 0
                    )

                    booksToPut.push({
                        ...b,
                        ...existing,
                        title: existing.title || b.title,
                        author: existing.author || b.author,
                        progress: progress || existing.progress || b.progress,
                        totalReadingSeconds,
                        updatedAt: Math.max(existing.updatedAt || 0, b.updatedAt || 0),
                        hasLocalFile: existing.hasLocalFile !== undefined ? existing.hasLocalFile : b.hasLocalFile,
                        isCloudOnly: existing.hasLocalFile ? false : (existing.isCloudOnly !== undefined ? existing.isCloudOnly : b.isCloudOnly),
                        nativeSnapshotPath: existing.nativeSnapshotPath || b.nativeSnapshotPath,
                        blobRevision: existing.blobRevision || b.blobRevision,
                        documentHash: existing.documentHash || b.documentHash,
                        coverBlob: existing.coverBlob || b.coverBlob
                    })
                } else {
                    booksToPut.push({
                        ...b,
                        hasLocalFile: false,
                        isCloudOnly: true
                    })
                }
            }
        }

        // 4h. Settings
        if (backupData.readerSettings && typeof backupData.readerSettings === 'object') {
            settingsToPut.push({ key: 'readerSettings', value: backupData.readerSettings })
        }
        if (backupData.manualTocs && typeof backupData.manualTocs === 'object') {
            for (const [origBookId, toc] of Object.entries(backupData.manualTocs)) {
                if (Array.isArray(toc) && toc.length > 0) {
                    const targetBookId = bookIdRemap.get(origBookId) || origBookId
                    settingsToPut.push({ key: `linden_manual_toc_${targetBookId}`, value: toc })
                }
            }
        }

        // 4i. Deleted records (tombstones)
        const deletedRecordsToPut = []
        if (Array.isArray(backupData.deletedRecords)) {
            for (const dr of backupData.deletedRecords) {
                if (!dr || !dr.id) continue
                deletedRecordsToPut.push(dr)
            }
        }

        const restorePlan = {
            booksToPut,
            highlightsToPut,
            bookmarksToPut,
            sessionsToPut,
            translationsToPut,
            drawingsToPut,
            listsToPut,
            settingsToPut,
            deletedRecordsToPut
        }

        // Snapshot settings for rollback
        const existingSettingsMap = new Map()
        if (typeof activeDb.getSetting === 'function') {
            for (const st of settingsToPut) {
                try {
                    const prevVal = await activeDb.getSetting(st.key)
                    existingSettingsMap.set(st.key, prevVal !== undefined ? prevVal : null)
                } catch (_) {
                    existingSettingsMap.set(st.key, null)
                }
            }
        }

        // 5. Changelog for out-of-transaction settings (localStorage)
        const localStorageLog = new Map()
        const localStorageEntries = []
        const recordLocalStorage = (k, afterVal = undefined) => {
            if (typeof localStorage !== 'undefined') {
                if (!localStorageLog.has(k)) {
                    const prev = localStorage.getItem(k)
                    localStorageLog.set(k, { beforeValue: prev, afterValue: afterVal })
                    localStorageEntries.push({
                        key: k,
                        hadBefore: prev !== null && prev !== undefined,
                        beforeValue: prev,
                        afterValue: afterVal
                    })
                } else if (afterVal !== undefined) {
                    const existing = localStorageLog.get(k)
                    existing.afterValue = afterVal
                    const entry = localStorageEntries.find(e => e.key === k)
                    if (entry) entry.afterValue = afterVal
                }
            }
        }

        if (typeof localStorage !== 'undefined') {
            if (Array.isArray(backupData.readingPresets)) recordLocalStorage('linden_reading_presets_v1', JSON.stringify(backupData.readingPresets))
            if (backupData.customPalette) recordLocalStorage('linden_custom_semantic_palette_v1', JSON.stringify(backupData.customPalette))
            if (backupData.userName) recordLocalStorage('linden_user_name', backupData.userName)
            if (backupData.config && typeof backupData.config === 'object') recordLocalStorage(STORAGE_KEY_CONFIG, JSON.stringify(sanitizeAdvancedSettings(backupData.config)))
            if (backupData.bookSettingsOverrides && typeof backupData.bookSettingsOverrides === 'object') {
                for (const [bId, ov] of Object.entries(backupData.bookSettingsOverrides)) {
                    const targetId = bookIdRemap.get(bId) || bId
                    if (targetId && ov && typeof ov === 'object') {
                        recordLocalStorage(`linden_book_settings_${targetId}`, JSON.stringify(ov))
                    }
                }
            }
        }

        restorePlan.operationId = operationId
        restorePlan.persistJournal = true
        restorePlan.localStorageEntries = localStorageEntries

        const existingBookIds = new Set(snapshot.books.map(b => b.id))
        const existingHlIds = new Set(snapshot.highlights.map(h => h.id))
        const existingBmIds = new Set(snapshot.bookmarks.map(bm => bm.id))
        const existingSessIds = new Set(snapshot.sessions.map(s => s.id))
        const existingTrIds = new Set(snapshot.translations.map(t => t.id))
        const existingDrawIds = new Set(snapshot.drawings.map(d => d.id))
        const existingListIds = new Set(snapshot.lists.map(l => l.id))

        const newlyInsertedRecordKeys = {
            books: booksToPut.filter(b => b?.id && !existingBookIds.has(b.id)).map(b => b.id),
            highlights: highlightsToPut.filter(h => h?.id && !existingHlIds.has(h.id)).map(h => h.id),
            bookmarks: bookmarksToPut.filter(bm => bm?.id && !existingBmIds.has(bm.id)).map(bm => bm.id),
            sessions: sessionsToPut.filter(s => s?.id && !existingSessIds.has(s.id)).map(s => s.id),
            translations: translationsToPut.filter(ct => ct?.id && !existingTrIds.has(ct.id)).map(ct => ct.id),
            drawings: drawingsToPut.filter(d => d?.id && !existingDrawIds.has(d.id)).map(d => d.id),
            lists: listsToPut.filter(l => l?.id && !existingListIds.has(l.id)).map(l => l.id)
        }

        let applyRes = null
        try {
            // If activeDb provides atomic single-transaction applyRestorePlan, use it!
            if (typeof activeDb.applyRestorePlan === 'function') {
                applyRes = await activeDb.applyRestorePlan(restorePlan)
            } else {
                // Mock / fallback DB execution with strict rollback tracking

                // Apply translations
                if (activeDb.saveChapterTranslation) {
                    for (const ct of translationsToPut) {
                        if (!existingTrIds.has(ct.id)) newlyInsertedRecordKeys.translations.push(ct.id)
                        await activeDb.saveChapterTranslation(ct)
                    }
                }
                // Apply sessions
                if (activeDb.saveReadingSession) {
                    for (const s of sessionsToPut) {
                        if (!existingSessIds.has(s.id)) newlyInsertedRecordKeys.sessions.push(s.id)
                        await activeDb.saveReadingSession(s, false)
                    }
                }
                // Apply highlights
                if (activeDb.saveHighlight) {
                    for (const h of highlightsToPut) {
                        if (!existingHlIds.has(h.id)) newlyInsertedRecordKeys.highlights.push(h.id)
                        await activeDb.saveHighlight(h)
                    }
                }
                // Apply bookmarks
                if (activeDb.saveBookmark) {
                    for (const bm of bookmarksToPut) {
                        if (!existingBmIds.has(bm.id)) newlyInsertedRecordKeys.bookmarks.push(bm.id)
                        await activeDb.saveBookmark(bm)
                    }
                }
                // Apply drawings
                if (activeDb.savePdfPageDrawing) {
                    for (const d of drawingsToPut) {
                        await activeDb.savePdfPageDrawing(d.bookId, d.pageIndex, d.strokes || [], d)
                    }
                }
                // Apply custom lists
                if (activeDb.saveCustomList) {
                    for (const l of listsToPut) {
                        await activeDb.saveCustomList(l)
                    }
                }
                // Apply books
                if (activeDb.saveBook) {
                    for (const b of booksToPut) {
                        if (!existingBookIds.has(b.id)) newlyInsertedRecordKeys.books.push(b.id)
                        await activeDb.saveBook(b)
                    }
                }
                // Apply settings
                if (activeDb.setSetting) {
                    for (const st of settingsToPut) {
                        await activeDb.setSetting(st.key, st.value)
                    }
                }
            }

            // 6. Apply out-of-transaction localStorage items
            if (typeof localStorage !== 'undefined') {
                if (Array.isArray(backupData.readingPresets)) {
                    recordLocalStorage('linden_reading_presets_v1')
                    localStorage.setItem('linden_reading_presets_v1', JSON.stringify(backupData.readingPresets))
                    if (typeof window !== 'undefined' && window.readingPresetsManager?.load) {
                        window.readingPresetsManager.load()
                    }
                }
                if (backupData.customPalette) {
                    recordLocalStorage('linden_custom_semantic_palette_v1')
                    localStorage.setItem('linden_custom_semantic_palette_v1', JSON.stringify(backupData.customPalette))
                    if (typeof window !== 'undefined' && window.themeCustomizer?.load) {
                        window.themeCustomizer.load()
                    }
                }
                if (backupData.userName) {
                    recordLocalStorage('linden_user_name')
                    localStorage.setItem('linden_user_name', backupData.userName)
                }
                if (backupData.bookSettingsOverrides && typeof backupData.bookSettingsOverrides === 'object') {
                    for (const [bId, ov] of Object.entries(backupData.bookSettingsOverrides)) {
                        const targetId = bookIdRemap.get(bId) || bId
                        if (targetId && ov && typeof ov === 'object') {
                            const k = `linden_book_settings_${targetId}`
                            recordLocalStorage(k)
                            localStorage.setItem(k, JSON.stringify(ov))
                        }
                    }
                }
            }

            // 7. Advanced Config
            if (backupData.config && typeof backupData.config === 'object') {
                this.config = sanitizeAdvancedSettings(backupData.config)
                this.applyReaderParameters()
                this.applyRuntimeConfig()
                this.save()
            }

            // 8. Commit durable restore journal
            const commitFn = typeof activeDb.commitRestoreOperation === 'function'
                ? activeDb.commitRestoreOperation
                : (typeof db.commitRestoreOperation === 'function' ? db.commitRestoreOperation : null)
            if (commitFn) {
                const commitRes = await commitFn(applyRes?.operationId || operationId, activeDb !== db ? activeDb : null, { retainLock: true })
                if (commitRes === false) throw new Error('持久化恢复日志清理失败 (commitRestoreOperation failed)')
            }
        } catch (restoreErr) {
            // Selective Journal Rollback: revert ONLY keys modified by this restore operation
            // whose revision still matches afterRevision (never overwriting concurrent user edits!)
            try {
                const rollbackFn = typeof activeDb.rollbackRestoreOperation === 'function'
                    ? activeDb.rollbackRestoreOperation
                    : (typeof db.rollbackRestoreOperation === 'function' ? db.rollbackRestoreOperation : null)

                if (applyRes && rollbackFn) {
                    await rollbackFn(applyRes.operationId || operationId, applyRes.journal || null, null, { retainLock: true })
                } else if (!applyRes && typeof activeDb.applyRestorePlan !== 'function') {
                    // Fallback for non-IDB mock DBs
                    if (activeDb.deleteBook && newlyInsertedRecordKeys.books.length > 0) {
                        for (const id of newlyInsertedRecordKeys.books) await activeDb.deleteBook(id, false).catch(() => {})
                    }
                    if (activeDb.saveBook && snapshot.books) {
                        for (const b of snapshot.books) await activeDb.saveBook(b).catch(() => {})
                    }
                    if (activeDb.deleteHighlight && newlyInsertedRecordKeys.highlights.length > 0) {
                        for (const id of newlyInsertedRecordKeys.highlights) await activeDb.deleteHighlight(id).catch(() => {})
                    }
                    if (activeDb.saveHighlight && snapshot.highlights) {
                        for (const h of snapshot.highlights) await activeDb.saveHighlight(h).catch(() => {})
                    }
                    if (activeDb.deleteBookmark && newlyInsertedRecordKeys.bookmarks.length > 0) {
                        for (const id of newlyInsertedRecordKeys.bookmarks) await activeDb.deleteBookmark(id, false).catch(() => {})
                    }
                    if (activeDb.saveBookmark && snapshot.bookmarks) {
                        for (const bm of snapshot.bookmarks) await activeDb.saveBookmark(bm).catch(() => {})
                    }
                    if (activeDb.deleteReadingSession && newlyInsertedRecordKeys.sessions.length > 0) {
                        for (const id of newlyInsertedRecordKeys.sessions) await activeDb.deleteReadingSession(id).catch(() => {})
                    }
                    if (activeDb.saveReadingSession && snapshot.sessions) {
                        for (const s of snapshot.sessions) await activeDb.saveReadingSession(s, false).catch(() => {})
                    }
                    if (activeDb.deleteChapterTranslation && newlyInsertedRecordKeys.translations.length > 0) {
                        for (const id of newlyInsertedRecordKeys.translations) await activeDb.deleteChapterTranslation(id).catch(() => {})
                    }
                    if (activeDb.saveChapterTranslation && snapshot.translations) {
                        for (const ct of snapshot.translations) await activeDb.saveChapterTranslation(ct).catch(() => {})
                    }
                    if (activeDb.deleteCustomList && (newlyInsertedRecordKeys.lists.length > 0 || listsToPut.length > 0)) {
                        for (const l of listsToPut) await activeDb.deleteCustomList(l.id, false).catch(() => {})
                    }
                    if (activeDb.saveCustomList && snapshot.lists) {
                        for (const l of snapshot.lists) await activeDb.saveCustomList(l).catch(() => {})
                    }
                    if (activeDb.clearPdfDrawingById && (newlyInsertedRecordKeys.drawings.length > 0 || drawingsToPut.length > 0)) {
                        for (const d of drawingsToPut) await activeDb.clearPdfDrawingById(d.id, false).catch(() => {})
                    }
                    if (activeDb.savePdfPageDrawing && snapshot.drawings) {
                        for (const d of snapshot.drawings) await activeDb.savePdfPageDrawing(d.bookId, d.pageIndex, d.strokes || [], d).catch(() => {})
                    }
                    if (activeDb.setSetting && existingSettingsMap.size > 0) {
                        for (const [k, prevVal] of existingSettingsMap.entries()) {
                            if (prevVal === null || prevVal === undefined) {
                                if (activeDb.deleteSetting) await activeDb.deleteSetting(k).catch(() => {})
                            } else {
                                await activeDb.setSetting(k, prevVal).catch(() => {})
                            }
                        }
                    }
                }
            } catch (_) {}

            // Revert localStorage changes from log ONLY if current value still matches afterValue
            if (typeof localStorage !== 'undefined') {
                for (const [k, info] of localStorageLog.entries()) {
                    try {
                        const currentVal = localStorage.getItem(k)
                        const expectedAfter = typeof info === 'object' && info !== null ? info.afterValue : undefined
                        const prevVal = typeof info === 'object' && info !== null ? info.beforeValue : info
                        if (expectedAfter !== undefined && currentVal !== expectedAfter) {
                            // User or another task modified this key after restore; preserve newer settings!
                            continue
                        }
                        if (prevVal === null || prevVal === undefined) {
                            localStorage.removeItem(k)
                        } else {
                            localStorage.setItem(k, prevVal)
                        }
                    } catch (_) {}
                }
            }
            throw restoreErr
        }

        const restoredBooks = booksToPut.length
        const restoredHighlights = highlightsToPut.length
        const restoredSessions = sessionsToPut.length
        const restoredBookmarks = bookmarksToPut.length
        const restoredDrawings = drawingsToPut.length
        const restoredLists = listsToPut.length

        this.app?.showToast?.(`备份恢复完成：${restoredBooks} 本书，${restoredHighlights} 条划线，${restoredSessions} 条记录`, 'success')
        if (this.app?.renderShelf) {
            this.app.renderShelf()
        }
        return { restoredBooks, restoredSessions, restoredHighlights, restoredBookmarks, restoredDrawings, restoredLists }
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
                    const format = newPath.split('.').pop().toLowerCase()
                    if (targetBook.format && format !== targetBook.format.toLowerCase()) throw new Error('请选择与原书相同格式、相同版本的文件')
                    const buffer = await platformBridge.readFileBuffer(newPath)
                    if (!buffer?.byteLength) throw new Error('所选文件为空或无法读取，原关联未修改')
                    const blob = new Blob([buffer], { type: format === 'pdf' ? 'application/pdf' : 'application/octet-stream' })
                    const wasOpen = this.app?.currentBookId === targetBook.id
                    if (wasOpen) {
                        if (typeof this.app.closeReader === 'function') {
                            await this.app.closeReader()
                        } else if (this.app.reader?.destroy) {
                            this.app.reader.destroy()
                        }
                    }
                    if (db.relinkBookFile) {
                        const saved = await db.relinkBookFile(targetBook.id, { blob, nativePath: newPath })
                        if (!saved) throw new Error('重新关联未保存')
                    } else {
                        targetBook.nativePath = newPath
                        targetBook.filePath = newPath
                        targetBook.updatedAt = Date.now()
                        await db.updateBook?.(targetBook)
                    }
                    this.app?.showToast?.(`已成功将《${targetBook.title}》重新关联至: ${newPath}`, 'success')
                    await this.app?.refreshBookshelf?.()
                    if (wasOpen) await this.app.openBook(targetBook.id)
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

        this.unlock()
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
        this.app?.showToast?.('高级设置已展开', 'info')
    }

    resetAndLock() {
        this.isUnlocked = true
        this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        this.applyReaderParameters()
        this.clickCount = 0
        this.save()
        this.renderUIState()
        this.app?.showToast?.('已恢复高级默认参数', 'info')
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
        if (typeof document === 'undefined' || this._dictDownloadController) return
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
            if (labelStatus) { labelStatus.innerText = '暂无法读取词库状态'; labelStatus.style.color = 'var(--text-muted)' }
            if (labelPath) labelPath.innerText = '可稍后重新打开设置查看'
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

    async exportSettingsJSON() {
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
        const filename = `linden_leaf_settings_${new Date().toISOString().slice(0, 10)}.json`
        const res = await platformBridge.exportTextFile(filename, JSON.stringify(exportData, null, 2), 'application/json')
        if (res?.cancelled) {
            return
        }
        if (res.success) {
            if (res.filePath) {
                this.app?.showToast?.(`配置已安全导出至：${res.filePath}`, 'success', 4500)
            } else {
                this.app?.showToast?.(`配置已安全导出至${res.directoryHint}：${res.filename}`, 'success', 4500)
            }
        } else if (res?.error) {
            this.app?.showToast?.(`导出失败: ${res.error}`, 'warning')
        }
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

            this.config = sanitizeAdvancedSettings(incoming)
            this.applyReaderParameters()
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
        return Math.max(256, Math.min(20000, Number(this.config.aiMaxTokens) || 2048))
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

export async function exportFullDataBackupPayload(customDb = db) {
    const mgr = new AdvancedSettingsManager()
    return await mgr.assembleFullBackupData(customDb)
}
