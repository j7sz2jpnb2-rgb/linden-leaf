import { migrateLegacyAiOutputLimit } from './ai-output-budget.js'
import { DEFAULT_ADVANCED_SETTINGS, sanitizeAdvancedSettings, STORAGE_KEY_CONFIG } from './advanced-settings-schema.js'
export { DEFAULT_ADVANCED_SETTINGS, sanitizeAdvancedSettings } from './advanced-settings-schema.js'
import { getLocale, t } from './i18n.js'
import * as backups from './backup-service.js'
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

import { setCustomTxtPatterns, setTxtMergeSoftBreaks, setTxtPurifyConfig, TXT_LAYOUT_VERSION } from '../foliate-js-main/txt.js'
import { parseStarDictFiles, parseMdxBuffer } from './custom-dict-importer.js'
import { parseKindleClippings, matchClippingsToLibrary } from './clippings-importer.js'
import { escapeHTML } from './ui-format.js'
import { fullTextSearchEngine } from './fulltext-search.js'
import { getChapterTranslationsStats, clearAllChapterTranslations } from './db.js'
import * as db from './db.js'
import { runTxtRulesWorker } from './txt-toc-worker.js'
import { dictionaryService } from './dictionary-service.js'
import { ttsPlayer } from './tts-player.js'
import { platformBridge } from './platformBridge.js'
import { ocrService } from './ocr-service.js'
import { OCR_MODEL_CATALOG, ocrModelManager } from './ocr-model-manager.js'

const TXT_RULE_TEMPLATES = Object.freeze({
    zh_chapter: DEFAULT_ADVANCED_SETTINGS.txtRegexPattern,
    en_chapter: '^(?:Chapter|Section|Book|Part|Act|Scene)\\s+[0-9IVXLCDMivxlcdm]+.*',
    num_heading: '^[0-9]{1,4}[、.\\s]+[\\u4e00-\\u9fa5a-zA-Z0-9].*'
})

const STORAGE_KEY_UNLOCKED = 'linden_advanced_settings_unlocked'

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
        migrateLegacyAiOutputLimit()
        try {
            this.isUnlocked = true
            const saved = localStorage.getItem(STORAGE_KEY_CONFIG)
            if (saved) {
                const parsed = JSON.parse(saved)
                delete parsed.ttsApiKey
                this.config = sanitizeAdvancedSettings(parsed)

                // Enforce budget bounds [0, 10000] (0 is a valid budget that disables extra context)
                const rawBudget = Number(this.config.aiContextTokenBudget)
                this.config.aiContextTokenBudget = Number.isFinite(rawBudget) ? Math.max(0, Math.min(10000, rawBudget)) : 1000
                this.config.aiMaxTokens = Math.max(256, Math.min(20000, Number(this.config.aiMaxTokens) || 20000))
                const rawCd = Number(this.config.aiCooldownSeconds)
                this.config.aiCooldownSeconds = Number.isFinite(rawCd) ? Math.max(0, Math.min(3600, rawCd)) : 10
                this.config.aiDailyLimit = Math.max(0, Number(this.config.aiDailyLimit) || 0)
            }
        } catch (e) {
            this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        }

        this.applyRuntimeConfig()
    }

    save() {
        let saved = true
        let saveError = null
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
            this.lastSaveError = null
        } catch (e) {
            saved = false
            saveError = e
            this.lastSaveError = e
            console.warn('[AdvancedSettings] Failed to persist settings to localStorage:', e)
            const now = Date.now()
            if (!this._lastSaveErrorToastAt || now - this._lastSaveErrorToastAt > 5000) {
                this._lastSaveErrorToastAt = now
                const toastFn = this.app?.dialogs?.showToast || this.app?.showToast
                if (typeof toastFn === 'function') {
                    toastFn.call(this.app?.dialogs || this.app, t('advancedSettings.saveFailedToast'), 'warning')
                }
            }
        }

        this.applyRuntimeConfig()
        this.syncNativeBackendLimits()
        return { saved, error: saveError }
    }

    applyRuntimeConfig() {
        setTxtMergeSoftBreaks(this.config.txtMergeSoftBreaks !== false)
        setTxtPurifyConfig({
            enabled: !!this.config.txtPurifyEnabled,
            stripAds: true,
            collapseBlankLines: true,
            customRulesText: this.config.txtPurifyCustomRules || ''
        })
        try { localStorage.setItem('linden_sync_chapter_translations', String(!!this.config.webdavSyncTranslations)) } catch (_) {}
        if (typeof ttsPlayer !== 'undefined') ttsPlayer.loadSettings?.(this.config)
        try {
            ocrService?.configure?.({
                engine: this.config.ocrEngine,
                backend: this.config.ocrBackend,
                direction: this.config.ocrDirection
            })
        } catch (_) {}
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
            d.badgeAdvancedStatus.innerText = this.isUnlocked ? t('adv.badgeExpanded') : t('settings.advBadge')
            d.badgeAdvancedStatus.style.background = this.isUnlocked ? 'rgba(74, 222, 128, 0.15)' : 'var(--bg-tertiary)'
            d.badgeAdvancedStatus.style.color = this.isUnlocked ? '#16a34a' : 'var(--text-muted)'
        }

        if (d.hintAdvancedTrigger) {
            d.hintAdvancedTrigger.innerText = this.isUnlocked ? t('adv.hintClickToggle') : t('settings.advExpand')
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
        if (maxTokensInput) maxTokensInput.value = String(this.config.aiMaxTokens || 20000)

        // Tokenizer
        const tokSelect = document.getElementById('setting-model-tokenizer')
        if (tokSelect) tokSelect.value = this.config.modelTokenizer || 'auto'

        // TXT Rules
        const txtEnable = document.getElementById('setting-txt-custom-rules-enable')
        if (txtEnable) txtEnable.checked = !!this.config.txtCustomRulesEnable
        const txtPattern = document.getElementById('setting-txt-regex-pattern')
        if (txtPattern) txtPattern.value = this.config.txtRegexPattern || TXT_RULE_TEMPLATES.zh_chapter
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
        const txtPurifyToggle = document.getElementById('setting-txt-purify-enabled')
        if (txtPurifyToggle) txtPurifyToggle.checked = !!this.config.txtPurifyEnabled
        const txtPurifyRules = document.getElementById('setting-txt-purify-custom-rules')
        if (txtPurifyRules) txtPurifyRules.value = this.config.txtPurifyCustomRules || ''
        const sidecarLabel = document.getElementById('label-sidecar-dir')
        const savedSidecarDir = typeof localStorage !== 'undefined' ? (localStorage.getItem('linden_markdown_sidecar_dir') || '').trim() : ''
        if (sidecarLabel) sidecarLabel.textContent = savedSidecarDir || t('settings.sidecarDirNotSet')
        const sidecarAuto = document.getElementById('setting-sidecar-autosync')
        if (sidecarAuto) sidecarAuto.checked = typeof localStorage !== 'undefined' && localStorage.getItem('linden_markdown_sidecar_autosync') === 'true'
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

        // Offline OCR settings
        const ocrEngineEl = document.getElementById('setting-ocr-engine')
        if (ocrEngineEl) ocrEngineEl.value = this.config.ocrEngine || 'auto'
        const ocrBackendEl = document.getElementById('setting-ocr-backend')
        if (ocrBackendEl) ocrBackendEl.value = this.config.ocrBackend || 'auto'
        const ocrDirectionEl = document.getElementById('setting-ocr-direction')
        if (ocrDirectionEl) ocrDirectionEl.value = this.config.ocrDirection || 'auto'
        const ocrMirrorEl = document.getElementById('setting-ocr-use-mirror')
        if (ocrMirrorEl) ocrMirrorEl.checked = !!this.config.ocrUseMirror
        const ocrPrefetchEl = document.getElementById('setting-ocr-idle-prefetch')
        if (ocrPrefetchEl) ocrPrefetchEl.checked = this.config.ocrIdlePrefetch !== false
        this.updateOcrModelsStatus()

        if (this.isUnlocked) this.updateTransStorageStats()
        this.updateDictResourceStatus()
        if (platformBridge.isTauri) this.renderCustomDictionariesList()
    }

    _formatAndroidDiagStatusLabel(status) {
        switch (status) {
            case 'ready': return t('tts.android.statusReady')
            case 'init_failed':
            case 'failed': return t('tts.android.statusInitFailed')
            case 'timeout': return t('tts.android.statusTimeout')
            case 'no_engine': return t('tts.android.engineNone')
            default: return t('tts.android.statusUnknown')
        }
    }

    _formatAndroidLangStatusLabel(status) {
        switch (status) {
            case 'available': return t('tts.android.statusAvailable')
            case 'missing_data': return t('tts.android.statusMissingData')
            case 'not_supported': return t('tts.android.statusNotSupported')
            default: return t('tts.android.statusUnknown')
        }
    }

    ensureAndroidTtsDiagnosticsUI() {
        if (!platformBridge.isAndroid || typeof document === 'undefined') return null
        const group = document.getElementById('adv-group-tts')
        if (!group) return null
        let row = document.getElementById('android-tts-diagnostics-row')
        if (row) return row

        row = document.createElement('div')
        row.id = 'android-tts-diagnostics-row'
        row.className = 'control-row settings-row-stacked'
        row.dataset.ttsFor = 'system'
        row.style.marginTop = '6px'

        const titleEl = document.createElement('span')
        titleEl.id = 'android-tts-diag-title'
        titleEl.className = 'control-label'
        titleEl.textContent = t('tts.android.diagTitle')

        const statusEl = document.createElement('div')
        statusEl.id = 'android-tts-diag-status'
        statusEl.style.fontSize = '12px'
        statusEl.style.lineHeight = '1.45'
        statusEl.style.color = 'var(--text-muted)'
        statusEl.textContent = t('tts.android.diagChecking')

        const errEl = document.createElement('div')
        errEl.id = 'android-tts-diag-error'
        errEl.style.fontSize = '12px'
        errEl.style.lineHeight = '1.45'
        errEl.style.color = '#d9534f'
        errEl.style.marginTop = '3px'
        errEl.hidden = true

        const actions = document.createElement('div')
        actions.style.display = 'flex'
        actions.style.flexWrap = 'wrap'
        actions.style.gap = '8px'
        actions.style.marginTop = '6px'

        const btnRefresh = document.createElement('button')
        btnRefresh.type = 'button'
        btnRefresh.id = 'btn-android-tts-refresh'
        btnRefresh.className = 'btn-secondary-action'
        btnRefresh.style.padding = '6px 10px'
        btnRefresh.textContent = t('tts.android.btnRefreshDiag')
        btnRefresh.addEventListener('click', () => this.refreshAndroidTtsDiagnostics(true))

        const btnSettings = document.createElement('button')
        btnSettings.type = 'button'
        btnSettings.id = 'btn-android-tts-settings'
        btnSettings.className = 'btn-secondary-action'
        btnSettings.style.padding = '6px 10px'
        btnSettings.textContent = t('tts.android.btnOpenSettings')
        btnSettings.addEventListener('click', () => {
            ttsPlayer.openAndroidTtsSettings().catch(err => {
                this.app?.showToast?.(t('tts.android.openSettingsFailed', { detail: err?.message || '' }), 'warning')
            })
        })

        const btnInstall = document.createElement('button')
        btnInstall.type = 'button'
        btnInstall.id = 'btn-android-tts-install'
        btnInstall.className = 'btn-secondary-action'
        btnInstall.style.padding = '6px 10px'
        btnInstall.textContent = t('tts.android.btnInstallVoice')
        btnInstall.addEventListener('click', () => {
            ttsPlayer.installAndroidTtsVoiceData().catch(() => {
                this.app?.showToast?.(t('tts.android.installVoiceFailed'), 'warning')
            })
        })

        actions.append(btnRefresh, btnSettings, btnInstall)
        row.append(titleEl, statusEl, errEl, actions)

        const anchor = document.getElementById('tts-provider-description')
        if (anchor && anchor.parentNode === group) group.insertBefore(row, anchor)
        else group.appendChild(row)
        return row
    }

    async refreshAndroidTtsDiagnostics(force = false) {
        if (!platformBridge.isAndroid || !platformBridge.isTauri) return null
        if (this._androidTtsDiagPromise && !force) return this._androidTtsDiagPromise
        const row = this.ensureAndroidTtsDiagnosticsUI()
        if (!row) return null

        const titleEl = document.getElementById('android-tts-diag-title')
        const statusEl = document.getElementById('android-tts-diag-status')
        const errEl = document.getElementById('android-tts-diag-error')
        const btnRefresh = document.getElementById('btn-android-tts-refresh')
        const btnSettings = document.getElementById('btn-android-tts-settings')
        const btnInstall = document.getElementById('btn-android-tts-install')
        if (titleEl) titleEl.textContent = t('tts.android.diagTitle')
        if (btnRefresh) btnRefresh.textContent = t('tts.android.btnRefreshDiag')
        if (btnSettings) btnSettings.textContent = t('tts.android.btnOpenSettings')
        if (btnInstall) btnInstall.textContent = t('tts.android.btnInstallVoice')
        if (statusEl && (force || !this._lastAndroidTtsDiag)) {
            statusEl.textContent = t('tts.android.diagChecking')
        }

        const task = (async () => {
            try {
                const diag = await ttsPlayer.getAndroidDiagnostics()
                this._lastAndroidTtsDiag = diag
                const count = Number(diag?.engineCount) || 0
                if (statusEl) {
                    if (count === 0 || diag?.status === 'no_engine') {
                        statusEl.textContent = t('tts.android.diagNoEngine')
                    } else {
                        const engName = diag?.defaultEngine || diag?.activeEngine || diag?.engines?.[0]?.name || t('tts.android.engineNone')
                        statusEl.textContent = t('tts.android.diagSummary', {
                            status: this._formatAndroidDiagStatusLabel(diag?.status),
                            count,
                            engine: engName,
                            zh: this._formatAndroidLangStatusLabel(diag?.zhStatus),
                            en: this._formatAndroidLangStatusLabel(diag?.enStatus)
                        })
                    }
                }
                const errCode = ttsPlayer.lastError?.code || diag?.lastErrorCode || ''
                const errMsg = ttsPlayer.lastError?.message || diag?.lastError || ''
                if (errEl) {
                    if (errCode || errMsg) {
                        errEl.textContent = t('tts.android.diagLastError', {
                            code: errCode || 'ERROR',
                            message: errMsg || errCode
                        })
                        errEl.hidden = false
                    } else {
                        errEl.textContent = ''
                        errEl.hidden = true
                    }
                }
                if (btnInstall && typeof diag?.canInstallTtsData === 'boolean') {
                    btnInstall.disabled = !diag.canInstallTtsData
                }
                return diag
            } catch (err) {
                if (statusEl) statusEl.textContent = err?.message || t('tts.android.statusInitFailed')
                return null
            } finally {
                if (this._androidTtsDiagPromise === task) this._androidTtsDiagPromise = null
            }
        })()
        this._androidTtsDiagPromise = task
        return task
    }

    updateTtsProviderVisibility() {
        const provider = this.config.ttsProvider || 'system'
        const group = document.getElementById('adv-group-tts')
        if (platformBridge.isAndroid) {
            this.ensureAndroidTtsDiagnosticsUI()
        }
        group?.querySelectorAll('[data-tts-for]').forEach(row => { row.hidden = row.dataset.ttsFor !== provider })
        if (platformBridge.isAndroid && provider === 'system') {
            this.refreshAndroidTtsDiagnostics(false).catch(() => {})
        }
        const description = document.getElementById('tts-provider-description')
        if (description) description.textContent = provider === 'system'
            ? t('settings.ttsNativeNote')
            : t('adv.ttsModelNote')
        if (description && platformBridge.isAndroid) description.textContent += provider === 'system'
            ? t('adv.ttsMobileLockScreen')
            : t('adv.ttsMobileForeground')
        const note = document.getElementById('tts-preview-note')
        if (note) note.textContent = provider === 'api' ? t('adv.ttsNoteApi')
            : provider === 'offline' ? t('adv.ttsNoteOffline') : t('settings.ttsTestNativeBtn')
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
            const val = Math.max(256, Math.min(20000, parseInt(e.target.value, 10) || 20000))
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
                this.app?.showToast?.(t('adv.toast.customRulesEnabled'), 'info')
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
            this.applyTxtRulesAndReload({ upgradeLegacy: true })
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
            this.app?.showToast?.(t('adv.toast.softWrapSaved'), 'info')
        })

        document.getElementById('setting-txt-purify-enabled')?.addEventListener('change', (e) => {
            this.config.txtPurifyEnabled = !!e.target.checked
            this.applyRuntimeConfig()
            this.save()
            this.app?.showToast?.(t('adv.toast.txtPurifySaved'), 'info')
        })
        const savePurifyRules = (e) => {
            this.config.txtPurifyCustomRules = String(e?.target?.value || '')
            this.applyRuntimeConfig()
            this.save()
        }
        document.getElementById('setting-txt-purify-custom-rules')?.addEventListener('change', savePurifyRules)
        document.getElementById('setting-txt-purify-custom-rules')?.addEventListener('blur', savePurifyRules)

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
                ? await this.app.showConfirmDialog(t('adv.confirmClearTransTitle'), t('adv.confirmClearTransMsg'))
                : confirm(t('adv.confirmClearTransMsg'))
            if (confirmed) {
                await clearAllChapterTranslations()
                this.updateTransStorageStats()
                this.app?.showToast?.(t('adv.toast.transCacheCleared'), 'info')
            }
        })

        // Audio Cache & Dictionary Resource Locations
        document.getElementById('btn-clear-audio-cache')?.addEventListener('click', async () => {
            try {
                const memory = ttsPlayer.clearAudioCache()
                const diskBytes = Number(await dictionaryService.clearAudioCache()) || 0
                this.app?.showToast?.(t('adv.toast.ttsCacheCleared', { count: memory.count, mb: ((memory.bytes + diskBytes) / 1024 / 1024).toFixed(1) }), 'info')
            } catch (e) {
                this.app?.showToast?.(t('adv.toast.ttsCacheClearFailed', { error: e.message }), 'warning')
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
                this.app?.showToast?.(t('adv.toast.dictDownloading'), 'info')
                await dictionaryService.downloadAndInstall({
                    signal: this._dictDownloadController.signal,
                    onProgress: (p) => {
                        if (labelStatus) {
                            labelStatus.innerText = p.message || `${p.phase}: ${p.percent}%`
                        }
                    }
                })
                await this.updateDictResourceStatus()
                this.app?.showToast?.(t('adv.toast.dictInstalled'), 'success')
            } catch (err) {
                this.app?.showToast?.(this._dictDownloadController?.signal.aborted ? t('dict.error.downloadCancelled') : t('adv.toast.dictDownloadFailed', { error: err.message }), 'warning')
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
                this.app?.showToast?.(t('adv.toast.dictImporting'), 'info')
                const res = await dictionaryService.pickAndInstallFromFile()
                if (res) {
                    await this.updateDictResourceStatus()
                    this.app?.showToast?.(t('adv.toast.dictImported'), 'success')
                }
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err.message }), 'warning')
            }
        })

        document.getElementById('btn-dict-migrate-dir')?.addEventListener('click', async () => {
            try {
                const targetDir = await dictionaryService.pickFolder()
                if (targetDir) {
                    await dictionaryService.migrateStorage(targetDir)
                    await this.updateDictResourceStatus()
                    this.app?.showToast?.(t('adv.toast.dictDirSet', { dir: targetDir }), 'success')
                }
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.migrateFailed', { error: err.message }), 'warning')
            }
        })

        const customDictInput = document.getElementById('input-custom-dict-files')
        document.getElementById('btn-dict-import-custom')?.addEventListener('click', () => {
            if (!platformBridge.isTauri) {
                this.app?.showToast?.(t('adv.toast.customDictDesktopOnly'), 'info')
                return
            }
            if (customDictInput) {
                customDictInput.value = ''
                customDictInput.click()
            }
        })
        customDictInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || [])
            if (!files.length) return
            try {
                this.app?.showToast?.(t('adv.toast.customDictParsing'), 'info')
                const mdxFile = files.find(f => /\.mdx$/i.test(f.name))
                let parsed
                if (mdxFile) {
                    const buf = await mdxFile.arrayBuffer()
                    parsed = await parseMdxBuffer(buf, mdxFile.name.replace(/\.mdx$/i, ''))
                } else {
                    const idxFile = files.find(f => /\.idx$/i.test(f.name))
                    const dictFile = files.find(f => /\.dict(\.dz)?$/i.test(f.name))
                    const ifoFile = files.find(f => /\.ifo$/i.test(f.name))
                    if (!idxFile || !dictFile) {
                        throw new Error(t('adv.toast.customDictSelectPair'))
                    }
                    const [ifoBytes, idxBytes, dictBytes] = await Promise.all([
                        ifoFile ? ifoFile.arrayBuffer().then(b => new Uint8Array(b)) : Promise.resolve(null),
                        idxFile.arrayBuffer().then(b => new Uint8Array(b)),
                        dictFile.arrayBuffer().then(b => new Uint8Array(b)),
                    ])
                    parsed = await parseStarDictFiles({
                        ifoBytes,
                        idxBytes,
                        dictBytes,
                        isGzipped: /\.dz$/i.test(dictFile.name),
                        fileName: ifoFile?.name || idxFile.name,
                    })
                }
                const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
                if (!entries.length) {
                    throw new Error(t('adv.toast.customDictEmpty'))
                }
                const dictId = await platformBridge.dictCustomBeginImport(parsed.title || 'Custom Dict', parsed.format || 'mdx')
                const BATCH = 2000
                for (let i = 0; i < entries.length; i += BATCH) {
                    await platformBridge.dictCustomInsertBatch(dictId, entries.slice(i, i + BATCH))
                }
                await platformBridge.dictCustomFinishImport(dictId)
                await this.renderCustomDictionariesList()
                await this.updateDictResourceStatus()
                this.app?.showToast?.(t('adv.toast.customDictImported', { name: parsed.title, count: entries.length }), 'success')
            } catch (err) {
                console.warn('[AdvancedSettings] custom dict import failed:', err)
                this.app?.showToast?.(t('adv.toast.customDictFailed', { error: err?.message || err }), 'warning')
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
            button.innerText = t('adv.btn.stopTest')
            this.app?.showToast?.(this.config.ttsProvider === 'api' ? t('adv.toast.testingApi') : t('adv.toast.testingVoice'), 'info')
            try { await ttsPlayer.preview() }
            catch (error) {
                if (error.name !== 'AbortError') this.app?.showToast?.(t('adv.toast.testFailed', { error: error.message }), 'warning')
            } finally {
                button.innerText = t('settings.ttsTestBtn')
                if (platformBridge.isAndroid && (this.config.ttsProvider || 'system') === 'system') {
                    this.refreshAndroidTtsDiagnostics(true).catch(() => {})
                }
            }
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
                this.app?.showToast?.(t('adv.toast.ttsUrlChangedResetKey'), 'warning')
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
                this.app?.showToast?.(t('adv.toast.restoreFailed', { error: err.message }), 'warning')
            }
        })

        document.getElementById('btn-relink-missing-book')?.addEventListener('click', () => {
            this.relinkMissingBook()
        })

        // Markdown Sidecar Folder & Auto-Sync
        document.getElementById('btn-pick-sidecar-dir')?.addEventListener('click', async () => {
            if (!platformBridge.isTauri) {
                this.app?.showToast?.(t('annotations.sidecarDesktopOnly'), 'info')
                return
            }
            try {
                const dir = await platformBridge.pickSidecarFolder?.()
                if (!dir) return
                const authorized = (await platformBridge.registerSidecarDir(dir)) || dir
                try { localStorage.setItem('linden_markdown_sidecar_dir', authorized) } catch {}
                const lbl = document.getElementById('label-sidecar-dir')
                if (lbl) lbl.textContent = authorized
                this.app?.showToast?.(t('adv.toast.sidecarDirSet', { dir: authorized }), 'success')
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
            }
        })
        document.getElementById('setting-sidecar-autosync')?.addEventListener('change', (e) => {
            try { localStorage.setItem('linden_markdown_sidecar_autosync', e.target.checked ? 'true' : 'false') } catch {}
        })

        // Kindle My Clippings.txt Importer
        const kindleInput = document.getElementById('input-kindle-clippings-file')
        document.getElementById('btn-import-kindle-clippings')?.addEventListener('click', () => {
            if (kindleInput) {
                kindleInput.value = ''
                kindleInput.click()
            }
        })
        kindleInput?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            try {
                const text = await file.text()
                const parsedGroups = parseKindleClippings(text)
                if (!parsedGroups.length) {
                    this.app?.showToast?.(t('adv.toast.kindleEmpty'), 'info')
                    return
                }
                const matched = matchClippingsToLibrary(parsedGroups, await db.getAllBooks().catch(() => []))
                this.openKindleImportModal(matched)
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
            }
        })

        // Reset & Re-lock Button
        document.getElementById('btn-reset-advanced-settings')?.addEventListener('click', () => {
            this.resetAndLock()
        })

        // Offline OCR settings & model manager controls
        for (const [id, key] of [
            ['setting-ocr-engine', 'ocrEngine'],
            ['setting-ocr-backend', 'ocrBackend'],
            ['setting-ocr-direction', 'ocrDirection']
        ]) {
            document.getElementById(id)?.addEventListener('change', (e) => {
                this.config[key] = e.target.value
                this.save()
            })
        }
        document.getElementById('setting-ocr-use-mirror')?.addEventListener('change', (e) => {
            this.config.ocrUseMirror = !!e.target.checked
            this.save()
        })
        document.getElementById('setting-ocr-idle-prefetch')?.addEventListener('change', (e) => {
            this.config.ocrIdlePrefetch = !!e.target.checked
            this.save()
        })

        const ocrImportInput = document.getElementById('input-ocr-import-files')
        document.getElementById('btn-ocr-import-local')?.addEventListener('click', () => {
            if (ocrImportInput) {
                ocrImportInput.value = ''
                ocrImportInput.click()
            }
        })
        ocrImportInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || [])
            if (!files.length) return
            const targetModel = document.getElementById('setting-ocr-import-target')?.value || 'ppocrv6-small'
            try {
                const res = await ocrModelManager.importLocalFiles(targetModel, files)
                await this.updateOcrModelsStatus({ force: true })
                if (res.imported?.length) {
                    this.app?.showToast?.(t('adv.toast.ocrImported', { count: res.imported.length }), 'success')
                } else {
                    this.app?.showToast?.(t('adv.toast.ocrImportNone'), 'warning')
                }
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
            }
        })

        document.getElementById('btn-clear-ocr-cache')?.addEventListener('click', async () => {
            try {
                const count = await db.clearSettingsByPrefix('linden_ocr_')
                this.app?.showToast?.(t('adv.toast.ocrCacheCleared', { count }), 'info')
            } catch (err) {
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
            }
        })
    }

    async updateOcrModelsStatus({ force = false } = {}) {
        const runtimeEl = document.getElementById('label-ocr-runtime-status')
        const cardsEl = document.getElementById('ocr-model-cards')
        if (!runtimeEl && !cardsEl) return

        const status = await ocrModelManager.getStatus({ force }).catch(() => null)
        if (!status) return

        if (runtimeEl) {
            if (status.runtimeInstalled) {
                const mb = (status.runtimeSizeBytes / (1024 * 1024)).toFixed(1)
                runtimeEl.textContent = t('settings.ocrRuntimeReady', { mb })
            } else {
                runtimeEl.textContent = t('settings.ocrRuntimeNotInstalled', { mb: '28.2' })
            }
        }

        if (!cardsEl) return
        const statusById = new Map((status.models || []).map(m => [m.id, m]))
        cardsEl.innerHTML = OCR_MODEL_CATALOG.map((item) => {
            const st = statusById.get(item.id) || { installed: false, ready: false, sizeBytes: 0, missingAssets: [] }
            const isDownloading = this._ocrDownloadingModelId === item.id
            const badgeClass = st.ready ? 'ocr-model-badge ready' : 'ocr-model-badge'
            const badgeText = st.ready
                ? `${t('settings.ocrBadgeReady')} (${(st.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`
                : (st.installed ? t('settings.ocrBadgeMissingRuntime') : t('settings.ocrBadgeNotInstalled'))
            const actionBtn = isDownloading
                ? `<button type="button" class="btn-secondary-action ocr-model-cancel-btn" data-model-id="${escapeHTML(item.id)}">${escapeHTML(t('settings.ocrModelCancelBtn'))}</button>`
                : `<button type="button" class="${st.ready ? 'btn-secondary-action' : 'btn-primary-action'} ocr-model-download-btn" data-model-id="${escapeHTML(item.id)}"${this._ocrDownloadingModelId ? ' disabled' : ''}>${escapeHTML(t(st.ready ? 'settings.ocrModelRedownloadBtn' : 'settings.ocrModelDownloadBtn'))}</button>`
            const deleteBtn = (st.installed && !isDownloading)
                ? `<button type="button" class="btn-secondary-action ocr-model-delete-btn" data-model-id="${escapeHTML(item.id)}">${escapeHTML(t('settings.ocrModelDeleteBtn'))}</button>`
                : ''
            return `
                <div class="ocr-model-card">
                    <div class="ocr-model-card-header">
                        <span class="ocr-model-title">${escapeHTML(t(item.titleKey))}</span>
                        <span class="${escapeHTML(badgeClass)}">${escapeHTML(badgeText)}</span>
                    </div>
                    <div class="ocr-model-desc">${escapeHTML(t(item.descKey))}</div>
                    <div class="ocr-model-actions">${actionBtn}${deleteBtn}</div>
                </div>
            `
        }).join('')

        cardsEl.querySelectorAll('.ocr-model-download-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const modelId = btn.dataset.modelId
                if (modelId) this.downloadOcrModel(modelId)
            })
        })
        cardsEl.querySelectorAll('.ocr-model-cancel-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this._ocrDownloadAbortController?.abort()
                ocrModelManager.cancelDownload().catch(() => {})
            })
        })
        cardsEl.querySelectorAll('.ocr-model-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const modelId = btn.dataset.modelId
                if (!modelId) return
                try {
                    await ocrModelManager.deleteModel(modelId)
                    await this.updateOcrModelsStatus({ force: true })
                    this.app?.showToast?.(t('adv.toast.ocrDeleted', { model: modelId }), 'info')
                } catch (err) {
                    this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
                }
            })
        })
    }

    async downloadOcrModel(modelId) {
        if (this._ocrDownloadingModelId) return
        const wrap = document.getElementById('ocr-download-progress-wrap')
        const fill = document.getElementById('ocr-download-progress-fill')
        const text = document.getElementById('ocr-download-progress-text')
        const controller = this._ocrDownloadAbortController = new AbortController()
        this._ocrDownloadingModelId = modelId
        if (wrap) wrap.hidden = false
        if (fill) fill.style.width = '2%'
        if (text) text.textContent = t('adv.toast.ocrDownloading')
        await this.updateOcrModelsStatus()

        try {
            this.app?.showToast?.(t('adv.toast.ocrDownloading'), 'info')
            await ocrModelManager.downloadModel(modelId, {
                useMirror: !!this.config.ocrUseMirror,
                signal: controller.signal,
                onProgress: (p) => {
                    if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(p.percent) || 0))}%`
                    if (text) text.textContent = p.message || `${p.percent || 0}%`
                }
            })
            this.app?.showToast?.(t('adv.toast.ocrDownloaded'), 'success')
        } catch (err) {
            const msg = controller.signal.aborted
                ? t('adv.toast.ocrDownloadCancelled')
                : t('adv.toast.ocrDownloadFailed', { error: err?.message || String(err) })
            this.app?.showToast?.(msg, 'warning')
        } finally {
            this._ocrDownloadingModelId = null
            if (this._ocrDownloadAbortController === controller) {
                this._ocrDownloadAbortController = null
            }
            if (wrap) wrap.hidden = true
            await this.updateOcrModelsStatus({ force: true })
        }
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
            this.app?.showToast?.(t('adv.toast.ttsKeyCleared'), 'info')
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
            this.app?.showToast?.(t('adv.toast.ttsKeySaved'), 'success')
        } else {
            this.config.ttsApiKeyConfigured = false
            this._sessionTtsApiKey = clean
            this.app?.showToast?.(t('adv.toast.ttsKeySessionOnly'), 'warning')
        }
        this.save()
        ttsPlayer.updateProviderConfig('api', { apiKey: clean })
    }

    async assembleFullBackupData(customDb = this.db || db) {
        return backups.assembleFullBackupData(customDb, this.config)
    }

    async createFullDataBackup(options = {}) {
        return backups.createFullDataBackup({ ...options, db: options.db || this.db || db, config: this.config })
    }

    async exportFullDataBackup() {
        try {
            const payload = await this.assembleFullBackupData(this.db || db)
            const filename = t('adv.backupFilename', { date: new Date().toISOString().slice(0, 10) })
            const res = await platformBridge.exportTextFile(filename, JSON.stringify(payload, null, 2), 'application/json')
            if (res?.cancelled) {
                return
            }
            if (res.success) {
                if (res.filePath) {
                    this.app?.showToast?.(t('adv.toast.backupExportedPath', { path: res.filePath }), 'success', 5000)
                } else {
                    this.app?.showToast?.(t('adv.toast.backupExportedHint', { hint: res.directoryHint, filename: res.filename }), 'success', 5000)
                }
            } else if (res?.error) {
                this.app?.showToast?.(t('adv.toast.backupExportFailed', { error: res.error }), 'warning')
            }
        } catch (e) {
            this.app?.showToast?.(t('adv.toast.backupExportFailed', { error: e.message }), 'warning')
        }
    }

    async restoreFullDataBackup(backupData, customDb = this.db || db) {
        const previousConfig = this.config
        try {
            const result = await backups.restoreFullDataBackup(backupData, customDb, config => {
                this.config = config
                this.applyReaderParameters()
                this.applyRuntimeConfig()
                this.save()
            })
            this.app?.showToast?.(t('adv.toast.backupRestored', {
                books: result.restoredBooks,
                highlights: result.restoredHighlights,
                sessions: result.restoredSessions
            }), 'success')
            await this.app?.refreshBookshelf?.()
            return result
        } catch (error) {
            this.config = previousConfig
            throw error
        }
    }

    async relinkMissingBook() {
        try {
            const books = await (db.getAllBooks?.() || Promise.resolve([]))
            if (!books || books.length === 0) {
                this.app?.showToast?.(t('adv.relink.noBooks'), 'info')
                return
            }
            const bookTitles = books.map((b, i) => `${i + 1}. ${b.title} (${b.format || 'doc'})`).join('\n')
            const choice = prompt(t('adv.relink.prompt', { count: books.length, list: bookTitles }))
            if (!choice) return
            const idx = parseInt(choice, 10) - 1
            if (isNaN(idx) || idx < 0 || idx >= books.length) {
                this.app?.showToast?.(t('adv.relink.invalidChoice'), 'warning')
                return
            }
            const targetBook = books[idx]
            const invoke = globalThis.__TAURI__?.core?.invoke || globalThis.window?.__TAURI__?.core?.invoke
            if (invoke) {
                const picked = await invoke('dialog_open_file', { locale: getLocale() })
                const newPath = picked?.[0]?.filePath
                if (newPath) {
                    const format = newPath.split('.').pop().toLowerCase()
                    if (targetBook.format && format !== targetBook.format.toLowerCase()) throw new Error(t('adv.relink.formatMismatch'))
                    const buffer = await platformBridge.readFileBuffer(newPath)
                    if (!buffer?.byteLength) throw new Error(t('adv.relink.emptyFile'))
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
                        if (!saved) throw new Error(t('adv.relink.notSaved'))
                    } else {
                        targetBook.nativePath = newPath
                        targetBook.filePath = newPath
                        targetBook.updatedAt = Date.now()
                        await db.updateBook?.(targetBook)
                    }
                    this.app?.showToast?.(t('adv.relink.success', { title: targetBook.title, path: newPath }), 'success')
                    await this.app?.refreshBookshelf?.()
                    if (wasOpen) await this.app.openBook(targetBook.id)
                    return
                }
            }
            this.app?.showToast?.(t('adv.relink.cancelled'), 'info')
        } catch (e) {
            this.app?.showToast?.(t('adv.relink.failed', { error: e.message }), 'warning')
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
                    this.dom.hintAdvancedTrigger.innerText = isHidden ? t('adv.hintCollapse') : t('settings.advExpand')
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
        this.app?.showToast?.(t('adv.toast.unlocked'), 'info')
    }

    resetAndLock() {
        this.isUnlocked = true
        this.config = { ...DEFAULT_ADVANCED_SETTINGS }
        this.applyReaderParameters()
        this.clickCount = 0
        this.save()
        this.renderUIState()
        this.app?.showToast?.(t('adv.toast.defaultsRestored'), 'info')
    }

    async updateTransStorageStats() {
        if (typeof document === 'undefined') return
        const label = document.getElementById('label-trans-storage-size')
        if (!label) return
        try {
            const stats = await getChapterTranslationsStats()
            const kb = (stats.estimatedBytes / 1024).toFixed(1)
            label.innerText = t('adv.transStatsCount', { count: stats.count, kb })
        } catch (e) {
            label.innerText = t('adv.transStatsZero')
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
                    labelStatus.innerText = t('adv.dictReadyCount', { wordsK })
                    labelStatus.style.color = '#10b981'
                } else {
                    labelStatus.innerText = t('adv.dictNotInstalled')
                    labelStatus.style.color = '#ef4444'
                }
            }
            if (labelPath && locations?.dictionaryDir) {
                labelPath.innerText = t('adv.dictLocation', { dir: locations.dictionaryDir })
            }
        } catch (_) {
            if (labelStatus) { labelStatus.innerText = t('adv.dictReadError'); labelStatus.style.color = 'var(--text-muted)' }
            if (labelPath) labelPath.innerText = t('adv.dictRetryLater')
        }
    }

    async renderCustomDictionariesList() {
        const listEl = document.getElementById('custom-dict-list')
        if (!listEl) return
        if (!platformBridge.isTauri) {
            listEl.replaceChildren()
            return
        }
        const dicts = await platformBridge.dictCustomList().catch(() => [])
        if (!Array.isArray(dicts) || dicts.length === 0) {
            listEl.innerHTML = `<div class="custom-dict-empty">${escapeHTML(t('adv.customDictEmptyList'))}</div>`
            return
        }
        listEl.innerHTML = dicts.map(d => `
            <div class="custom-dict-row" data-dict-id="${Number(d.id)}">
                <label class="custom-dict-toggle-wrap">
                    <input type="checkbox" class="custom-dict-toggle" data-dict-id="${Number(d.id)}" ${d.enabled ? 'checked' : ''} />
                    <span class="custom-dict-name">${escapeHTML(d.name || 'Dictionary')}</span>
                </label>
                <span class="custom-dict-meta">${escapeHTML(String(d.format || '').toUpperCase())} · ${Number(d.entryCount ?? d.entry_count ?? 0)}</span>
                <button type="button" class="btn-secondary-action custom-dict-del-btn" data-dict-id="${Number(d.id)}">${escapeHTML(t('common.delete'))}</button>
            </div>
        `).join('')

        listEl.querySelectorAll('.custom-dict-toggle').forEach(cb => {
            cb.addEventListener('change', async () => {
                await platformBridge.dictCustomToggle(Number(cb.dataset.dictId), Boolean(cb.checked)).catch(() => {})
            })
        })
        listEl.querySelectorAll('.custom-dict-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await platformBridge.dictCustomDelete(Number(btn.dataset.dictId)).catch(() => {})
                await this.renderCustomDictionariesList()
                await this.updateDictResourceStatus()
            })
        })
    }

    _hashKindleId(seed) {
        let h = 2166136261
        for (let i = 0; i < seed.length; i++) {
            h ^= seed.charCodeAt(i)
            h = Math.imul(h, 16777619)
        }
        return `kindle_${(h >>> 0).toString(36)}`
    }

    openKindleImportModal(groups = []) {
        const modal = document.getElementById('modal-kindle-import')
        const listEl = document.getElementById('kindle-import-groups-list')
        const createMissingCb = document.getElementById('kindle-import-create-missing')
        const summaryEl = document.getElementById('kindle-import-summary')
        const btnConfirm = document.getElementById('btn-confirm-kindle-import')
        const btnClose = document.getElementById('btn-close-kindle-import')
        const btnCancel = document.getElementById('btn-cancel-kindle-import')
        if (!modal || !listEl || !btnConfirm) return

        const closeModal = () => {
            modal.classList.remove('show')
            modal.style.display = 'none'
        }
        if (btnClose) btnClose.onclick = closeModal
        if (btnCancel) btnCancel.onclick = closeModal

        const matchedCount = groups.filter(g => g.matchedBookId).length
        const totalHighlights = groups.reduce((acc, g) => acc + (g.highlights?.length || 0), 0)
        if (summaryEl) {
            summaryEl.textContent = t('adv.kindleSummary', { books: groups.length, matched: matchedCount, highlights: totalHighlights })
        }

        listEl.innerHTML = groups.map((g, idx) => {
            const matchedBadge = g.matchedBookId
                ? `<span class="kindle-match-badge matched">${escapeHTML(t('adv.kindleMatchedBadge', { title: g.matchedBookTitle || g.title }))}</span>`
                : `<span class="kindle-match-badge unmatched">${escapeHTML(t('adv.kindleUnmatchedBadge'))}</span>`
            const previewQuote = g.highlights?.[0]?.text ? `<div class="kindle-group-preview">“${escapeHTML(g.highlights[0].text.slice(0, 120))}”</div>` : ''
            return `
                <label class="kindle-group-row">
                    <input type="checkbox" class="kindle-group-check" data-group-idx="${idx}" checked />
                    <div class="kindle-group-meta">
                        <div class="kindle-group-title">${escapeHTML(g.title)} <span class="kindle-group-count">(${g.highlights.length})</span></div>
                        <div class="kindle-group-sub">${escapeHTML(g.author || t('book.unknownAuthor'))} · ${matchedBadge}</div>
                        ${previewQuote}
                    </div>
                </label>
            `
        }).join('')

        modal.style.display = 'flex'
        modal.classList.add('show')

        btnConfirm.onclick = async () => {
            btnConfirm.disabled = true
            try {
                const allowCreateUnmatched = Boolean(createMissingCb?.checked)
                const checkedIdx = new Set(
                    Array.from(listEl.querySelectorAll('.kindle-group-check:checked')).map(c => Number(c.dataset.groupIdx))
                )
                const now = Date.now()
                const records = []
                let importedBooks = 0

                for (let idx = 0; idx < groups.length; idx++) {
                    if (!checkedIdx.has(idx)) continue
                    const g = groups[idx]
                    let targetBookId = g.matchedBookId
                    if (!targetBookId) {
                        if (!allowCreateUnmatched) continue
                        targetBookId = this._hashKindleId(`book|${g.key}`)
                        const existingBook = await db.getBook(targetBookId).catch(() => null)
                        if (!existingBook) {
                            await db.saveBook({
                                id: targetBookId,
                                title: g.title,
                                author: g.author || t('book.unknownAuthor'),
                                format: 'txt',
                                isCloudOnly: false,
                                hasLocalFile: false,
                                isOffline: true,
                                addedAt: now,
                                updatedAt: now,
                                progress: { fraction: 0, updatedAt: now }
                            })
                        }
                    }
                    importedBooks++
                    for (const hl of (g.highlights || [])) {
                        const detId = this._hashKindleId(`${targetBookId}|${hl.text}|${hl.note || ''}|${hl.locationStart ?? ''}`)
                        records.push({
                            id: detId,
                            bookId: targetBookId,
                            formatType: 'txt',
                            text: hl.text,
                            note: hl.note || '',
                            color: '#facc15',
                            style: 'highlight',
                            chapterTitle: hl.page != null
                                ? `P.${hl.page}`
                                : (hl.locationStart != null ? `Loc ${hl.locationStart}` : t('adv.kindleImportSource')),
                            createdAt: now,
                            updatedAt: now
                        })
                    }
                }

                if (records.length > 0) {
                    if (typeof db.saveHighlightsBatch === 'function') {
                        await db.saveHighlightsBatch(records)
                    } else {
                        for (const r of records) await db.saveHighlight(r)
                    }
                }
                closeModal()
                window.app?.bookshelf?.refreshBookshelf?.()
                if (window.app?.currentBookId) {
                    window.app?.annotations?.loadNotesList?.()
                    window.app?.annotations?.updateSidebarNotesCount?.()
                }
                this.app?.showToast?.(t('adv.toast.kindleImported', { highlights: records.length, books: importedBooks }), 'success')
            } catch (err) {
                console.warn('[AdvancedSettings] Kindle import failed:', err)
                this.app?.showToast?.(t('adv.toast.opFailed', { error: err?.message || err }), 'warning')
            } finally {
                btnConfirm.disabled = false
            }
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
            resultEl.innerText = this.config.txtCustomRulesEnable ? t('adv.txtTest.needOpenBook') : t('adv.txtTest.needEnableCustom')
            resultEl.style.color = 'var(--text-secondary, #6b7280)'
            return
        }

        resultEl.style.display = 'block'
        resultEl.innerText = t('adv.txtTest.checking')
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
                resultEl.innerText = t('adv.txtTest.matched', { titles: previewTitles })
                resultEl.style.color = 'var(--accent, #16a34a)'
            } else {
                resultEl.innerText = t('adv.txtTest.none')
                resultEl.style.color = '#ef4444'
            }
        } catch (err) {
            resultEl.style.display = 'block'
            resultEl.innerText = t('adv.txtTest.failed', { error: err.message })
            resultEl.style.color = '#ef4444'
        }
    }

    async applyTxtRulesAndReload({ upgradeLegacy = false } = {}) {
        this.applyRuntimeConfig()
        const txtBook = this.app?.foliateView?.book
        if (!txtBook?.tocPreviewLines) {
            this.app?.showToast?.(t('adv.txtRebuild.savedForNext'), 'info')
            return
        }
        const bookId = this.app.currentBookId
        if (!bookId || typeof this.app.openBook !== 'function') return
        const isLegacy = txtBook.txtLayoutVersion !== TXT_LAYOUT_VERSION
        if (isLegacy && !upgradeLegacy) return
        const fraction = this.app.currentLocation?.fraction
        try {
            if (isLegacy) {
                const confirmed = await this.app.showConfirmDialog(t('adv.txtRebuild.upgradeTitle'), t('adv.txtRebuild.upgradeMessage'))
                if (!confirmed || this.app.currentBookId !== bookId) return
                await db.saveBook({ id: bookId, txtLayoutVersion: TXT_LAYOUT_VERSION })
            }
            await fullTextSearchEngine.invalidate(bookId)
            await this.app.openBook(bookId, Number.isFinite(fraction) ? { fraction } : null, { forceInPlace: true })
            if (this.app.currentBookId === bookId && this.app.foliateView?.book?.txtLayoutVersion === TXT_LAYOUT_VERSION) {
                this.app.showToast?.(t('adv.txtRebuild.success'), 'info')
            }
        } catch (error) {
            console.warn('[AdvancedSettings] TXT directory rebuild failed:', error)
            this.app?.showToast?.(t('adv.txtRebuild.failed'), 'warn')
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
                this.app?.showToast?.(t('adv.configPort.exportedPath', { path: res.filePath }), 'success', 4500)
            } else {
                this.app?.showToast?.(t('adv.configPort.exportedHint', { hint: res.directoryHint, filename: res.filename }), 'success', 4500)
            }
        } else if (res?.error) {
            this.app?.showToast?.(t('adv.configPort.exportFailed', { error: res.error }), 'warning')
        }
    }

    async importSettingsJSON(file) {
        if (!file) return
        if (file.size > 512 * 1024) {
            this.app?.showToast?.(t('adv.configPort.tooLarge'), 'warn')
            return
        }

        try {
            const text = await file.text()
            const parsed = JSON.parse(text)
            const incoming = parsed.advancedSettings || (parsed.config ? parsed.config : null)
            if (!incoming || typeof incoming !== 'object') {
                throw new Error(t('adv.configPort.invalidFormat'))
            }

            // Create rollback backup snapshot before modifying config
            const rollbackConfig = { ...this.config }

            this.config = sanitizeAdvancedSettings(incoming)
            this.applyReaderParameters()
            this.save()
            this.renderUIState()
            this._lastRollbackConfig = rollbackConfig
            this.app?.showToast?.(t('adv.configPort.imported'), 'success')
        } catch (e) {
            this.app?.showToast?.(t('adv.configPort.importFailed', { error: e.message }), 'warn')
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
        return Math.max(256, Math.min(20000, Number(this.config.aiMaxTokens) || 20000))
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
    return backups.assembleFullBackupData(customDb, advancedSettings.config)
}
