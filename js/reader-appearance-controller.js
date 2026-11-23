import { DomEvents } from './dom-events.js'
import { setMuPdfStoreLimit } from './pdf-driver.js'
import { platformBridge } from './platformBridge.js'
import { getAiConfig, saveAiConfig, getAiApiKey } from './reading-ai-assistant.js'
import { readingPresetsManager, MAX_READING_PRESETS } from './reading-presets.js'
import { customFontManager } from './custom-font-manager.js'
import { themeCustomizer } from './theme-customizer.js'
import { resolveReaderSettings, READER_OVERRIDE_ALLOWED_KEYS, resolveLegacyPreserveOriginalStyles } from './translation-job-core.js'
import {
    formatFontWeight,
    buildContentCSS,
    getDefaultReaderSettings,
    resolveEffectiveReaderLayout,
} from './reader-style-builder.js'
import { t } from './i18n.js'

/** Owns appearance UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class ReaderAppearanceController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this._bookSettingsOverride = null
    }

    initDOM() {
        this.dom = {
            settingEnableReadingGoals: document.getElementById('setting-enable-reading-goals'),
            settingGoalYear: document.getElementById('setting-goal-year'),
            settingGoalMonth: document.getElementById('setting-goal-month'),
            settingGoalToday: document.getElementById('setting-goal-today'),
            settingPdfStoreMb: document.getElementById('setting-pdf-store-mb'),
            pdfParallelSettings: document.getElementById('pdf-parallel-settings'),
            settingPdfParallel: document.getElementById('setting-pdf-parallel'),
            pdfParallelHint: document.getElementById('pdf-parallel-hint'),
            androidPdfEngineSection: document.getElementById('android-pdf-engine-section'),
            settingAndroidPdfEngine: document.getElementById('setting-android-pdf-engine'),
            androidPdfEngineUnavailable: document.getElementById('android-pdf-engine-unavailable'),
            androidPdfEngineFallback: document.getElementById('android-pdf-engine-fallback'),
            themeButtons: document.querySelectorAll('.theme-btn'),
            publisherStylesSwitch: document.getElementById('setting-publisher-styles'),
            publisherStylesHint: document.getElementById('publisher-styles-hint'),
            fontButtons: document.querySelectorAll('.font-choice-btn'),
            fontSizeSlider: document.getElementById('setting-font-size'),
            fontSizeValue: document.getElementById('value-font-size'),
            fontWeightSlider: document.getElementById('setting-font-weight'),
            fontWeightValue: document.getElementById('value-font-weight'),
            lineHeightSlider: document.getElementById('setting-line-height'),
            lineHeightValue: document.getElementById('value-line-height'),
            marginSlider: document.getElementById('setting-margin'),
            marginValue: document.getElementById('value-margin'),
            maxWidthSlider: document.getElementById('setting-max-width'),
            maxWidthValue: document.getElementById('value-max-width'),
            gapSlider: document.getElementById('setting-gap'),
            gapValue: document.getElementById('value-gap'),
            columnCountSelect: document.getElementById('setting-column-count'),
            layoutSelect: document.getElementById('setting-layout-mode'),
            turnAnimationSelect: document.getElementById('setting-turn-animation-mode'),
            settingRealisticPen: document.getElementById('setting-realistic-pen'),
            settingFullscreenAutohide: document.getElementById('setting-fullscreen-autohide'),
            letterSpacingSlider: document.getElementById('setting-letter-spacing'),
            letterSpacingValue: document.getElementById('value-letter-spacing'),
            chineseQuotesSwitch: document.getElementById('setting-chinese-quotes'),
            comicModeSwitch: document.getElementById('setting-comic-mode'),
            btnResetTypography: document.getElementById('btn-reset-typography'),
            btnToggleCustomPalette: document.getElementById('btn-toggle-custom-palette'),
            customPaletteEditor: document.getElementById('custom-palette-editor'),
            paletteBgPrimary: document.getElementById('palette-bg-primary'),
            paletteBgPrimaryHex: document.getElementById('palette-bg-primary-hex'),
            paletteBgSecondary: document.getElementById('palette-bg-secondary'),
            paletteBgSecondaryHex: document.getElementById('palette-bg-secondary-hex'),
            paletteBgSidebar: document.getElementById('palette-bg-sidebar'),
            paletteBgSidebarHex: document.getElementById('palette-bg-sidebar-hex'),
            paletteTextMain: document.getElementById('palette-text-main'),
            paletteTextMainHex: document.getElementById('palette-text-main-hex'),
            paletteAccent: document.getElementById('palette-accent'),
            paletteAccentHex: document.getElementById('palette-accent-hex'),
            btnSaveCustomPalette: document.getElementById('btn-save-custom-palette'),
            btnResetCustomPalette: document.getElementById('btn-reset-custom-palette'),
            btnImportCustomFont: document.getElementById('btn-import-custom-font'),
            customFontsContainer: document.getElementById('custom-fonts-container'),
            customFontsList: document.getElementById('custom-fonts-list'),
            btnToggleReadingPresets: document.getElementById('btn-toggle-reading-presets'),
            badgeActivePreset: document.getElementById('badge-active-preset'),
            hintPresetsToggle: document.getElementById('hint-presets-toggle'),
            readingPresetsContainer: document.getElementById('reading-presets-container'),
            presetsCountLabel: document.getElementById('presets-count-label'),
            btnSaveCurrentPreset: document.getElementById('btn-save-current-preset'),
            readingPresetsList: document.getElementById('reading-presets-list'),
            imgBrightnessSlider: document.getElementById('setting-img-brightness'),
            imgBrightnessValue: document.getElementById('value-img-brightness'),
            imgContrastSlider: document.getElementById('setting-img-contrast'),
            imgContrastValue: document.getElementById('value-img-contrast'),
            imgGrayscaleSwitch: document.getElementById('setting-img-grayscale'),
            imgInvertSwitch: document.getElementById('setting-img-invert'),
            btnResetImgEnhance: document.getElementById('btn-reset-img-enhance'),
            settingUserName: document.getElementById('setting-user-name'),
            settingSearchEngine: document.getElementById('setting-search-engine'),
            settingSearchCustomRow: document.getElementById('setting-search-custom-row'),
            settingSearchCustomUrl: document.getElementById('setting-search-custom-url'),
            settingAiEnabled: document.getElementById('setting-ai-enabled'),
            aiCustomInputsWrap: document.getElementById('ai-custom-inputs-wrap'),
            settingAiEndpoint: document.getElementById('setting-ai-endpoint'),
            settingAiModel: document.getElementById('setting-ai-model'),
            settingAiKey: document.getElementById('setting-ai-key'),
            settingDictEnabled: document.getElementById('setting-dict-enabled'),
            settingAiContextBudget: document.getElementById('setting-ai-context-budget'),
            settingInplaceParaTrans: document.getElementById('setting-inplace-para-trans'),
            settingModelTokenizer: document.getElementById('setting-model-tokenizer'),
            settingAiMaxTokens: document.getElementById('setting-ai-max-tokens'),
            settingAiCooldown: document.getElementById('setting-ai-cooldown'),
            settingAiDailyLimit: document.getElementById('setting-ai-daily-limit'),
            settingDictSaveHistory: document.getElementById('setting-dict-save-history')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        const settingsPanel = document.getElementById('panel-settings')
        if (settingsPanel) {
            this.events.on(settingsPanel, 'input', e => {
                if (e.target && e.target.type === 'range') {
                    this.syncSliderFill(e.target)
                }
            })
        }
        this.dom.themeButtons.forEach(btn => {
            this.events.on(btn, 'click', () => {
                if (themeCustomizer.isCustomActive) {
                    themeCustomizer.removeTheme()
                    themeCustomizer.isCustomActive = false
                    themeCustomizer.save()
                }
                this.applyTheme(btn.dataset.val)
                this.app.saveSettings()
                this.updateSettingsUI()
            })
        });
        this.events.on(this.dom.publisherStylesSwitch, 'change', e => {
            this.app.setSetting('preserveOriginalStyles', e.target.checked)
            this.app.saveSettings()
            this.updateSettingsUI()
        });
        this.dom.fontButtons.forEach(btn => {
            this.events.on(btn, 'click', () => {
                if (this.app.currentBookFormat === 'epub') {
                    this.app.setSetting('preserveOriginalStyles', false)
                }
                this.app.setSetting('font', btn.dataset.val)
                this.app.saveSettings()
                this.updateSettingsUI()
            })
        });
        this.events.on(this.dom.fontSizeSlider, 'input', e => {
            const val = parseInt(e.target.value, 10)
            this.app.setSetting('fontSize', val)
            this.dom.fontSizeValue.innerText = `${this.app.settings.fontSize}px`
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.fontWeightSlider, 'input', e => {
            const val = parseInt(e.target.value, 10)
            this.app.setSetting('fontWeight', val)
            this.dom.fontWeightValue.innerText = formatFontWeight(this.app.settings.fontWeight)
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.lineHeightSlider, 'input', e => {
            const raw = parseFloat(e.target.value)
            const val = Number(Number(Number.isFinite(raw) ? raw : 1.6).toFixed(2))
            this.app.setSetting('lineHeight', val)
            this.dom.lineHeightValue.innerText = val
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.marginSlider, 'input', e => {
            const val = parseInt(e.target.value, 10)
            this.app.setSetting('margin', val)
            this.dom.marginValue.innerText = `${this.app.settings.margin}px`
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.maxWidthSlider, 'input', e => {
            const val = parseInt(e.target.value, 10)
            this.app.setSetting('maxWidth', val)
            this.dom.maxWidthValue.innerText = `${this.app.settings.maxWidth}px`
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.gapSlider, 'input', e => {
            const val = parseInt(e.target.value, 10)
            this.app.setSetting('gap', val)
            this.dom.gapValue.innerText = `${this.app.settings.gap}%`
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.btnResetTypography, 'click', () => {
            const defaults = getDefaultReaderSettings(this._getViewportEnv())
            const resetKeys = [
                'preserveOriginalStyles', 'fontSize', 'fontWeight', 'lineHeight',
                'margin', 'maxWidth', 'gap', 'letterSpacing',
                'chineseQuotes', 'comicMode', 'columnCount', 'layout',
            ]
            for (const k of resetKeys) {
                if (k === 'preserveOriginalStyles' && this.app.currentBookFormat === 'txt') continue
                const value = k === 'columnCount' && this.app.settings.writingMode === 'vertical-rl'
                    ? '1'
                    : defaults[k]
                this.app.setSetting(k, value)
            }
            this.updateSettingsUI()
            this.applySettingsToReader()
            this.app.saveSettingsDebounced()
            this.app.dialogs.showToast(t('appearance.toast.spacingReset'), 'info')
        });
        this.events.on(this.dom.columnCountSelect, 'change', e => {
            if (this.app.settings.writingMode === 'vertical-rl') {
                this.dom.columnCountSelect.value = '1'
                this.app.dialogs.showToast(t('appearance.toast.verticalSingleOnly'), 'info')
                return
            }
            const layout = resolveEffectiveReaderLayout(
                { ...this.app.settings, columnCount: e.target.value },
                this._getViewportEnv(),
            )
            if (!layout.twoColumnAllowed && e.target.value === '2') {
                this.dom.columnCountSelect.value = '1'
                return
            }
            this.app.setSetting('columnCount', layout.columnCount)
            this.app.saveSettings()
            this.applySettingsToReader()
        });
        this.events.on(this.dom.layoutSelect, 'change', e => {
            this.app.pageTurnController?.cancelCurrent()
            this.app.setSetting('layout', e.target.value)
            this.app.saveSettings()
        });
        this.events.on(this.dom.turnAnimationSelect, 'change', e => {
            const validTurnModes = ['none', 'slide', 'cover']
            const mode = validTurnModes.includes(e.target.value) ? e.target.value : 'slide'
            this.app.setSetting('pageTurnMode', mode)
            this.app.pageTurnController?.setMode(mode)
            this.app.saveSettings()
        });
        try { this.initCustomPaletteUI() } catch (e) { console.warn('[App] Palette init error:', e) };
        try { this.initCustomFontsUI() } catch (e) { console.warn('[App] Custom fonts init error:', e) };
        try { this.initReadingPresetsUI() } catch (e) { console.warn('[App] Reading presets init error:', e) };
        this.events.on(this.dom.settingRealisticPen, 'change', async e => {
            this.app.setSetting('realisticPen', e.target.checked)
            await this.app.saveSettings()
            await this.app.annotations.reloadAnnotations()
            this.app.dialogs.showToast(this.app.settings.realisticPen ? t('appearance.toast.realisticPenOn') : t('appearance.toast.realisticPenOff'))
        });
        this.events.on(this.dom.settingFullscreenAutohide, 'change', async e => {
            this.app.setSetting('fullscreenAutohide', e.target.checked)
            await this.app.saveSettings()
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                this.app.toggleReaderUI(!this.app.settings.fullscreenAutohide)
            }
            this.app.dialogs.showToast(this.app.settings.fullscreenAutohide ? t('appearance.toast.fullscreenAutohideOn') : t('appearance.toast.fullscreenAutohideOff'))
        });
        const applyImgFilter = () => {
            const b = this.dom.imgBrightnessSlider?.value || 100
            const c = this.dom.imgContrastSlider?.value || 100
            const isGray = this.dom.imgGrayscaleSwitch?.checked || false
            const isInvert = this.dom.imgInvertSwitch?.checked || false
            
            if (this.dom.imgBrightnessValue) this.dom.imgBrightnessValue.innerText = `${b}%`
            if (this.dom.imgContrastValue) this.dom.imgContrastValue.innerText = `${c}%`

            let filter = `brightness(${b}%) contrast(${c}%)`
            if (isGray) filter += ' grayscale(100%)'
            if (isInvert) filter += ' invert(100%)'

            this.app.dom.readerContentArea?.style.setProperty('--reader-img-filter', filter)
            document.documentElement?.style.setProperty('--reader-img-filter', filter)
        };
        this.events.on(this.dom.imgBrightnessSlider, 'input', applyImgFilter);
        this.events.on(this.dom.imgContrastSlider, 'input', applyImgFilter);
        this.events.on(this.dom.imgGrayscaleSwitch, 'change', applyImgFilter);
        this.events.on(this.dom.imgInvertSwitch, 'change', applyImgFilter);
        this.events.on(this.dom.btnResetImgEnhance, 'click', () => {
            if (this.dom.imgBrightnessSlider) this.dom.imgBrightnessSlider.value = 100
            if (this.dom.imgContrastSlider) this.dom.imgContrastSlider.value = 100
            if (this.dom.imgGrayscaleSwitch) this.dom.imgGrayscaleSwitch.checked = false
            if (this.dom.imgInvertSwitch) this.dom.imgInvertSwitch.checked = false
            applyImgFilter()
            this.app.dialogs.showToast(t('appearance.toast.imgEnhanceReset'), 'info')
        });
        const writingModeSelect = document.getElementById('setting-writing-mode');
        if (writingModeSelect) {
            writingModeSelect.value = this.app.settings.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal'
            this.events.on(writingModeSelect, 'change', async e => {
                const newMode = e.target.value
                this.app.setSetting('writingMode', newMode)
                const isVertical = newMode === 'vertical-rl'
                if (isVertical && (this.app.settings.columnCount === '2' || this.app.settings.columnCount === 2)) {
                    this.app.setSetting('columnCount', '1')
                }
                await this.app.saveSettings()
                this.updateSettingsUI()
                this.applySettingsToReader()
                if (this.app.foliateView && this.app.currentBookId) {
                    const loc = this.app.currentLocation?.cfi || this.app.currentLocation?.fraction || 0
                    await this.app.foliateView.goTo(loc)
                }
            })
        };
        this.events.on(this.dom.chineseQuotesSwitch, 'change', async e => {
            this.app.setSetting('chineseQuotes', e.target.checked)
            await this.app.saveSettings()
            if (this.app.foliateView && this.app.currentBookId) {
                try {
                    const loc = this.app.currentLocation?.cfi || this.app.currentLocation?.fraction || 0
                    await this.app.foliateView.goTo(loc)
                } catch (_) {}
            }
        });
        this.events.on(this.dom.comicModeSwitch, 'change', async e => {
            this.app.setSetting('comicMode', e.target.checked)
            await this.app.saveSettings()
            if (this.app.foliateView && this.app.currentBookId) {
                try {
                    const loc = this.app.currentLocation?.cfi || this.app.currentLocation?.fraction || 0
                    await this.app.foliateView.goTo(loc)
                } catch (_) {}
            }
        });
        const isAndroid = platformBridge.isTauri && platformBridge.isAndroid
        const isWindows = platformBridge.isTauri && platformBridge.getOS() === 'windows'
        if (this.dom.androidPdfEngineSection) this.dom.androidPdfEngineSection.hidden = !isAndroid
        if (isAndroid || isWindows) {
            platformBridge.hasNativePdfBackend().then(available => {
                this.nativePdfAvailable = available
                if (this.dom.pdfParallelSettings) this.dom.pdfParallelSettings.hidden = !isWindows || !available
                this.updatePdfEngineSettingsUI()
            })
        }
        this.events.on(this.dom.settingPdfParallel, 'change', e => {
            platformBridge.setPdfParallelRendering(e.target.checked)
        })
        this.events.on(this.dom.settingAndroidPdfEngine, 'change', async e => {
            this.switchingPdfEngine = true
            try {
                platformBridge.setAndroidPdfEngine(e.target.value)
                this.updatePdfEngineSettingsUI()
                await this.app.reopenAndroidPdfWithPreferredEngine()
            } finally {
                this.switchingPdfEngine = false
                this.updatePdfEngineSettingsUI()
            }
        })
        this.events.on(this.dom.settingPdfStoreMb, 'change', (e) => {
            const val = e.target.value
            try { localStorage.setItem('linden_pdf_store_mb', val) } catch (err) {}
            const mbInt = parseInt(val, 10) || 256
            try { setMuPdfStoreLimit?.(mbInt) } catch (err) {}
            window.__TAURI__?.core?.invoke?.('mupdf_set_store_limit', { maxMb: mbInt }).catch(() => {})
            this.app.dialogs.showToast(t('appearance.toast.pdfCacheUpdated', { mb: val }), 'info')
        });
        this.events.on(this.dom.settingSearchEngine, 'change', async e => {
            this.app.setSetting('searchEngine', e.target.value)
            if (this.dom.settingSearchCustomRow) {
                this.dom.settingSearchCustomRow.style.display = (e.target.value === 'custom') ? 'flex' : 'none'
            }
            await this.app.saveSettings()
        });
        this.events.on(this.dom.settingSearchCustomUrl, 'input', e => {
            this.app.setSetting('searchCustomUrl', e.target.value.trim())
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.settingAiEnabled, 'change', async e => {
            const enabled = e.target.checked
            if (this.dom.aiCustomInputsWrap) {
                this.dom.aiCustomInputsWrap.style.display = enabled ? 'flex' : 'none'
            }
            try {
                await saveAiConfig({ enabled })
            } catch (err) {
                this.app.dialogs.showToast(err.message, 'warning')
            }
        });
        this.events.on(this.dom.settingAiEndpoint, 'change', async e => {
            try {
                await saveAiConfig({ endpoint: e.target.value.trim() })
                this.app.dialogs.showToast(t('appearance.toast.aiEndpointSaved'), 'success')
            } catch (err) {
                this.app.dialogs.showToast(err.message, 'warning')
            }
        });
        this.events.on(this.dom.settingAiModel, 'change', async e => {
            try {
                await saveAiConfig({ model: e.target.value.trim() })
                this.app.dialogs.showToast(t('appearance.toast.aiModelSaved'), 'success')
            } catch (err) {
                this.app.dialogs.showToast(err.message, 'warning')
            }
        });
            this.events.on(this.dom.settingAiKey, 'change', async e => {
            try {
                await saveAiConfig({ apiKey: e.target.value.trim() })
                this.app.dialogs.showToast(t('appearance.toast.aiKeySaved'), 'success')
            } catch (err) {
                this.app.dialogs.showToast(t('appearance.toast.saveFailed', { detail: err.message }), 'warning')
            }
        })

        // Prevent popup clicks from losing selection
        ;
    }

    dispose() { this.events.dispose(); this._bound = false }

    refreshLocale() {
        this.updateSettingsUI()
        this.renderReadingPresetsUI()
        this.renderCustomFontsUI()
        const btnTogglePalette = this.dom?.btnToggleCustomPalette || document.getElementById('btn-toggle-custom-palette')
        const paletteEditor = this.dom?.customPaletteEditor || document.getElementById('custom-palette-editor')
        if (btnTogglePalette && paletteEditor) {
            btnTogglePalette.textContent = paletteEditor.style.display === 'none'
                ? t('appearance.palette.openBtn')
                : t('appearance.palette.closeBtn')
        }
        const hint = this.dom?.hintPresetsToggle || document.getElementById('hint-presets-toggle')
        const container = this.dom?.readingPresetsContainer || document.getElementById('reading-presets-container')
        if (hint && container) {
            hint.textContent = container.style.display === 'none'
                ? t('settings.presetExpand')
                : t('appearance.preset.collapse')
        }
    }

    updatePdfEngineSettingsUI() {
        if (this.dom.settingPdfParallel) {
            const canUseParallel = platformBridge.canUseParallelPdfRendering()
            this.dom.settingPdfParallel.checked = platformBridge.getPdfParallelRendering()
            this.dom.settingPdfParallel.disabled = !canUseParallel
            if (this.dom.pdfParallelHint) {
                const key = canUseParallel ? 'settings.pdfParallelHint' : 'settings.pdfParallelLimited'
                this.dom.pdfParallelHint.dataset.i18n = key
                this.dom.pdfParallelHint.textContent = t(key)
            }
        }
        const select = this.dom.settingAndroidPdfEngine
        if (!select || this.dom.androidPdfEngineSection.hidden) return
        const canUseNative = this.nativePdfAvailable === true
        const preferred = platformBridge.getAndroidPdfEngine()
        const switching = this.switchingPdfEngine === true
        select.value = canUseNative ? preferred : 'pdfjs'
        select.disabled = !canUseNative || switching
        this.dom.androidPdfEngineUnavailable.hidden = this.nativePdfAvailable !== false
        this.dom.androidPdfEngineFallback.hidden =
            !canUseNative || switching || preferred !== 'mupdf' || this.app.pdfDriver?.kind !== 'pdfjs'
    }

    updateSettingsUI() {
        this.updatePdfEngineSettingsUI()
        // Theme active state
        this.dom.themeButtons = document.querySelectorAll('.theme-btn')
        this.dom.themeButtons.forEach(btn => {
            btn.hidden = false
            if (this.app.themeMode === 'system') {
                btn.classList.toggle('active', btn.dataset.val === 'system')
            } else {
                btn.classList.toggle('active', btn.dataset.val === this.app.settings.theme)
            }
        })
        const isEpub = this.app.currentBookFormat === 'epub'
        const isTxt = this.app.currentBookFormat === 'txt'
        if (this.dom.publisherStylesSwitch) {
            this.dom.publisherStylesSwitch.checked = this.app.settings.preserveOriginalStyles === true
        }
        if (this.dom.publisherStylesHint) {
            this.dom.publisherStylesHint.textContent = isTxt
                ? t('appearance.hint.txtPublisherDisabled')
                : t('appearance.hint.epubPublisher')
        }
        const publisherMode = isEpub && this.app.settings.preserveOriginalStyles === true
        const disabledInPublisher = [
            this.dom.fontWeightSlider,
            this.dom.lineHeightSlider,
            this.dom.letterSpacingSlider,
            this.dom.chineseQuotesSwitch,
            document.getElementById('setting-first-para-indent'),
            document.getElementById('setting-para-margin-top'),
            document.getElementById('setting-para-margin-bottom'),
            document.getElementById('setting-para-indent-size'),
        ]
        for (const control of disabledInPublisher) {
            if (control) {
                control.disabled = publisherMode
                control.title = publisherMode ? t('appearance.title.disablePublisherFirst') : ''
            }
        }
        // Font active state
        this.dom.fontButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.val === this.app.settings.font)
        })
        const customFontBtns = document.querySelectorAll('.custom-font-choice-btn')
        customFontBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.val === this.app.settings.font)
        })
        this.updatePresetsBadge()
        const effectiveLayout = resolveEffectiveReaderLayout(this.app.settings, this._getViewportEnv())
        // Sliders
        if (this.dom.fontSizeSlider) {
            const fsVal = effectiveLayout.fontSize
            this.dom.fontSizeSlider.value = fsVal
            this.dom.fontSizeValue.innerText = `${fsVal}px`
        }
        if (this.dom.fontWeightSlider) {
            const fwVal = this.app.settings.fontWeight ?? 400
            this.dom.fontWeightSlider.value = fwVal
            this.dom.fontWeightValue.innerText = formatFontWeight(fwVal)
        }
        if (this.dom.letterSpacingSlider) {
            const rawLs = this.app.settings.letterSpacing ?? 0
            const lsVal = Number(Number(rawLs).toFixed(2))
            this.dom.letterSpacingSlider.value = lsVal
            this.dom.letterSpacingValue.innerText = `${lsVal}px`
        }
        if (this.dom.chineseQuotesSwitch) {
            this.dom.chineseQuotesSwitch.checked = !!this.app.settings.chineseQuotes
        }
        if (this.dom.comicModeSwitch) {
            this.dom.comicModeSwitch.checked = !!this.app.settings.comicMode
        }
        if (this.dom.lineHeightSlider) {
            const rawLh = this.app.settings.lineHeight ?? 1.6
            const lhVal = Number(Number(rawLh).toFixed(2))
            this.dom.lineHeightSlider.value = lhVal
            this.dom.lineHeightValue.innerText = lhVal
        }
        if (this.dom.marginSlider) {
            const mgVal = effectiveLayout.margin
            this.dom.marginSlider.value = mgVal
            this.dom.marginValue.innerText = `${mgVal}px`
        }
        if (this.dom.maxWidthSlider) {
            const mwVal = effectiveLayout.maxInlineSize
            this.dom.maxWidthSlider.value = mwVal
            this.dom.maxWidthValue.innerText = `${mwVal}px`
        }
        if (this.dom.gapSlider) {
            const gapVal = effectiveLayout.gapPercent
            this.dom.gapSlider.value = gapVal
            this.dom.gapValue.innerText = `${gapVal}%`
        }
        const isVertical = effectiveLayout.isVertical
        if (this.dom.columnCountSelect) {
            const twoColOpt = this.dom.columnCountSelect.querySelector('option[value="2"]')
            const colRow = this.dom.columnCountSelect?.closest?.('.control-row')
            if (isVertical) {
                if (twoColOpt) {
                    twoColOpt.disabled = true
                    twoColOpt.title = t('appearance.toast.verticalSingleOnly')
                    twoColOpt.textContent = t('appearance.colTwoVerticalDisabled')
                }
                this.dom.columnCountSelect.title = t('appearance.toast.verticalSingleOnly')
                if (colRow) colRow.title = t('appearance.toast.verticalSingleOnly')
                if (this.app.settings.columnCount === '2' || this.app.settings.columnCount === 2) {
                    this.app.setSetting('columnCount', '1')
                    this.app.saveSettingsDebounced()
                }
                this.dom.columnCountSelect.value = '1'
            } else if (!effectiveLayout.twoColumnAllowed) {
                if (twoColOpt) {
                    twoColOpt.disabled = true
                    twoColOpt.removeAttribute('title')
                    twoColOpt.textContent = t('settings.colDouble')
                }
                this.dom.columnCountSelect.removeAttribute('title')
                if (colRow) colRow.removeAttribute('title')
                this.dom.columnCountSelect.value = effectiveLayout.columnCount
            } else {
                if (twoColOpt) {
                    twoColOpt.disabled = false
                    twoColOpt.removeAttribute('title')
                    twoColOpt.textContent = t('settings.colDouble')
                }
                this.dom.columnCountSelect.removeAttribute('title')
                if (colRow) colRow.removeAttribute('title')
                this.dom.columnCountSelect.value = effectiveLayout.columnCount
            }
        }
        if (this.dom.layoutSelect) {
            this.dom.layoutSelect.value = effectiveLayout.layout
        }
        const validTurnModes = ['none', 'slide', 'cover']
        const isMobile = effectiveLayout.isMobile
        const turnMode = isMobile
            ? (validTurnModes.includes(this.app.settings.pageTurnMode) ? this.app.settings.pageTurnMode : 'slide')
            : 'none'
        if (this.dom.turnAnimationSelect) {
            this.dom.turnAnimationSelect.value = turnMode
        }
        const turnRow = document.getElementById('setting-turn-animation-row')
        if (turnRow) {
            turnRow.style.display = isMobile ? '' : 'none'
        }
        this.app.pageTurnController?.setMode(turnMode)
        const writingModeSelect = document.getElementById('setting-writing-mode')
        if (writingModeSelect) {
            writingModeSelect.value = isVertical ? 'vertical-rl' : 'horizontal'
        }
        if (this.dom.settingRealisticPen) {
            this.dom.settingRealisticPen.checked = this.app.settings.realisticPen !== false
        }
        if (this.dom.settingFullscreenAutohide) {
            this.dom.settingFullscreenAutohide.checked = !!this.app.settings.fullscreenAutohide
        }
        if (this.dom.settingEnableReadingGoals) {
            this.dom.settingEnableReadingGoals.checked = !!this.app.settings.enableReadingGoals
        }
        if (this.app.stats.dom.goalsCustomInputsWrap) {
            this.app.stats.dom.goalsCustomInputsWrap.style.display = this.app.settings.enableReadingGoals ? 'block' : 'none'
        }
        if (this.app.stats.dom.statsGoalsRow) {
            this.app.stats.dom.statsGoalsRow.style.display = this.app.settings.enableReadingGoals ? 'grid' : 'none'
        }
        if (this.dom.settingGoalYear) {
            this.dom.settingGoalYear.value = this.app.settings.readingGoalYear || 12
        }
        if (this.dom.settingGoalMonth) {
            this.dom.settingGoalMonth.value = this.app.settings.readingGoalMonth || 20
        }
        if (this.dom.settingGoalToday) {
            this.dom.settingGoalToday.value = this.app.settings.readingGoalToday || 45
        }

        // Web search engine & AI assistant preferences
        if (this.dom.settingPdfStoreMb) {
            this.dom.settingPdfStoreMb.value = localStorage.getItem('linden_pdf_store_mb') || '256'
        }
        if (this.dom.settingSearchEngine) {
            this.dom.settingSearchEngine.value = this.app.settings.searchEngine || 'baidu'
            if (this.dom.settingSearchCustomRow) {
                this.dom.settingSearchCustomRow.style.display = (this.app.settings.searchEngine === 'custom') ? 'flex' : 'none'
            }
        }
        if (this.dom.settingSearchCustomUrl) {
            this.dom.settingSearchCustomUrl.value = this.app.settings.searchCustomUrl || ''
        }
        const aiCfg = getAiConfig()
        if (this.dom.settingAiEnabled) {
            this.dom.settingAiEnabled.checked = !!aiCfg.enabled
            if (this.dom.aiCustomInputsWrap) {
                this.dom.aiCustomInputsWrap.style.display = aiCfg.enabled ? 'flex' : 'none'
            }
        }
        if (this.dom.settingAiEndpoint) {
            this.dom.settingAiEndpoint.value = aiCfg.endpoint || 'https://api.openai.com/v1'
        }
        if (this.dom.settingAiModel) {
            this.dom.settingAiModel.value = aiCfg.model || 'gpt-4o-mini'
        }
        if (this.dom.settingAiKey) {
            getAiApiKey().then(k => {
                if (this.dom.settingAiKey) this.dom.settingAiKey.value = k || ''
            })
        }

        // View mode switcher buttons
        this.app.bookshelf.dom.btnViewShelf?.classList.toggle('active', this.app.bookshelf.shelfViewMode === 'shelf')
        this.app.bookshelf.dom.btnViewGrid?.classList.toggle('active', this.app.bookshelf.shelfViewMode === 'grid')
        this.app.bookshelf.dom.btnViewList?.classList.toggle('active', this.app.bookshelf.shelfViewMode === 'list')
        this.syncSettingsSliderFills()
    }

    syncSliderFill(input) {
        if (!input || !input.style?.setProperty) return
        const min = Number(input.min ?? 0)
        const max = Number(input.max ?? 100)
        const val = Number(input.value ?? min)
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(val)) return
        const pct = Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100))
        input.style.setProperty('--range-pct', `${pct.toFixed(1)}%`)
    }

    syncSettingsSliderFills() {
        const panel = document.getElementById('panel-settings')
        if (!panel || typeof panel.querySelectorAll !== 'function') return
        panel.querySelectorAll('input[type="range"]').forEach(el => this.syncSliderFill(el))
    }

    syncSettingsUI() {
        this.updateSettingsUI()
    }

    initCustomPaletteUI() {
        const btnToggle = this.dom.btnToggleCustomPalette
        const editor = this.dom.customPaletteEditor
        const bgPrimary = this.dom.paletteBgPrimary
        const bgPrimaryHex = this.dom.paletteBgPrimaryHex
        const bgSecondary = this.dom.paletteBgSecondary
        const bgSecondaryHex = this.dom.paletteBgSecondaryHex
        const bgSidebar = this.dom.paletteBgSidebar
        const bgSidebarHex = this.dom.paletteBgSidebarHex
        const textMain = this.dom.paletteTextMain
        const textMainHex = this.dom.paletteTextMainHex
        const accent = this.dom.paletteAccent
        const accentHex = this.dom.paletteAccentHex
        const btnSave = this.dom.btnSaveCustomPalette
        const btnReset = this.dom.btnResetCustomPalette

        if (btnToggle && editor) {
            btnToggle.addEventListener('click', () => {
                const isOpen = editor.style.display !== 'none'
                editor.style.display = isOpen ? 'none' : 'flex'
                btnToggle.textContent = isOpen ? t('appearance.palette.openBtn') : t('appearance.palette.closeBtn')
            })
        }

        const pairs = [
            { color: document.getElementById('palette-bg-primary') || bgPrimary, hex: document.getElementById('palette-bg-primary-hex') || bgPrimaryHex, key: 'bgPrimary', defaultVal: '#ffffff' },
            { color: document.getElementById('palette-bg-secondary') || bgSecondary, hex: document.getElementById('palette-bg-secondary-hex') || bgSecondaryHex, key: 'bgSecondary', defaultVal: '#f9fafb' },
            { color: document.getElementById('palette-bg-sidebar') || bgSidebar, hex: document.getElementById('palette-bg-sidebar-hex') || bgSidebarHex, key: 'bgSidebar', defaultVal: '#f3f4f6' },
            { color: document.getElementById('palette-text-main') || textMain, hex: document.getElementById('palette-text-main-hex') || textMainHex, key: 'textMain', defaultVal: '#111827' },
            { color: document.getElementById('palette-text-muted'), hex: document.getElementById('palette-text-muted-hex'), key: 'textMuted', defaultVal: '#6b7280' },
            { color: document.getElementById('palette-accent') || accent, hex: document.getElementById('palette-accent-hex') || accentHex, key: 'accent', defaultVal: '#d97706' },
            { color: document.getElementById('palette-border-color'), hex: document.getElementById('palette-border-color-hex'), key: 'borderColor', defaultVal: '#e5e7eb' },
            { color: document.getElementById('palette-reader-bg'), hex: document.getElementById('palette-reader-bg-hex'), key: 'readerBg', defaultVal: '#faf9f5' },
            { color: document.getElementById('palette-reader-text'), hex: document.getElementById('palette-reader-text-hex'), key: 'readerText', defaultVal: '#141413' },
            { color: document.getElementById('palette-selection-bg'), hex: document.getElementById('palette-selection-bg-hex'), key: 'selectionBg', defaultVal: '#fde68a' }
        ]

        const syncInputsFromTheme = () => {
            const p = themeCustomizer.currentPalette
            for (const { color, hex, key, defaultVal } of pairs) {
                let val = (p[key] || defaultVal).toLowerCase()
                if (val.startsWith('rgb')) {
                    val = defaultVal || '#fde68a'
                }
                if (color) color.value = val
                if (hex) hex.value = val
            }
        }
        syncInputsFromTheme()

        const onColorInput = () => {
            const temp = {}
            for (const { color, key, defaultVal } of pairs) {
                temp[key] = color?.value || defaultVal
            }
            themeCustomizer.preview(temp)
            if (this.app.foliateView) {
                this.applySettingsToReader()
            }
        }

        // Two-way synchronization between swatch picker and hex text input
        pairs.forEach(({ color, hex }) => {
            if (color && hex) {
                color.addEventListener('input', () => {
                    hex.value = color.value.toLowerCase()
                    onColorInput()
                })
                hex.addEventListener('input', () => {
                    let val = hex.value.trim().toLowerCase()
                    if (!val.startsWith('#') && /^[0-9a-fA-F]{6}$/.test(val)) {
                        val = '#' + val
                    }
                    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                        color.value = val
                        onColorInput()
                    }
                })
                hex.addEventListener('blur', () => {
                    // On blur normalize to valid 6-digit hex format
                    let val = hex.value.trim().toLowerCase()
                    if (!val.startsWith('#') && /^[0-9a-fA-F]{6}$/.test(val)) {
                        val = '#' + val
                    }
                    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                        hex.value = val
                        color.value = val
                    } else {
                        hex.value = color.value.toLowerCase()
                    }
                })
            }
        })

        btnSave?.addEventListener('click', () => {
            const finalPalette = {
                bgPrimary: bgPrimary?.value || '#ffffff',
                bgSecondary: bgSecondary?.value || '#f9fafb',
                bgSidebar: bgSidebar?.value || '#f3f4f6',
                textMain: textMain?.value || '#111827',
                accent: accent?.value || '#d97706'
            }
            themeCustomizer.commit(finalPalette)
            if (this.app.foliateView) {
                this.applySettingsToReader()
            }
            this.app.dialogs.showToast(t('appearance.toast.paletteSaved'), 'success')
        })

        btnReset?.addEventListener('click', () => {
            themeCustomizer.resetToDefaults()
            syncInputsFromTheme()
            if (this.app.foliateView) {
                this.applySettingsToReader()
            }
            this.app.dialogs.showToast(t('appearance.toast.paletteReset'), 'success')
        })
    }

    initCustomFontsUI() {
        const btnImport = this.dom.btnImportCustomFont
        if (!btnImport) return

        btnImport.addEventListener('click', () => {
            try {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = '.ttf,.otf,.woff,.woff2'
                input.onchange = async () => {
                    const file = input.files?.[0]
                    if (!file) return
                    try {
                        this.app.dialogs.showToast(t('appearance.toast.fontImporting', { name: file.name }), 'info')
                        const imported = await customFontManager.importFont(file)
                        this.app.settings.font = imported.id
                        await this.app.saveSettings()
                        await this.renderCustomFontsUI()
                        this.updateSettingsUI()
                        this.app.dialogs.showToast(t('appearance.toast.fontImported', { name: imported.name }), 'success')
                    } catch (err) {
                        this.app.dialogs.showToast(err.message || t('appearance.toast.fontImportFailed'), 'warning')
                    }
                }
                input.click()
            } catch (err) {
                this.app.dialogs.showToast(t('appearance.toast.fontImportError', { detail: err.message }), 'warning')
            }
        })
    }

    async renderCustomFontsUI() {
        const container = this.dom.customFontsContainer
        const list = this.dom.customFontsList
        if (!container || !list) return

        const fonts = await customFontManager.listFonts()
        if (fonts.length === 0) {
            container.style.display = 'none'
            list.innerHTML = ''
            return
        }

        container.style.display = 'flex'
        list.innerHTML = ''

        fonts.forEach(f => {
            const row = document.createElement('div')
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px; background: var(--bg-tertiary); padding: 4px 8px; border-radius: 6px;'

            const choiceBtn = document.createElement('button')
            choiceBtn.type = 'button'
            choiceBtn.className = `font-choice-btn custom-font-choice-btn ${this.app.settings.font === f.id ? 'active' : ''}`
            choiceBtn.dataset.val = f.id
            choiceBtn.style.cssText = `flex: 1; text-align: left; border: none; background: none; font-size: 0.8rem; cursor: pointer; padding: 2px 4px; font-family: "${f.familyName}", sans-serif;`
            choiceBtn.textContent = `${f.name} (${f.format.toUpperCase()}, ${(f.size / 1024 / 1024).toFixed(1)}MB)`
            choiceBtn.addEventListener('click', async () => {
                if (this.app.currentBookFormat === 'epub') {
                    this.app.setSetting('preserveOriginalStyles', false)
                }
                this.app.setSetting('font', f.id)
                await this.app.saveSettings()
                this.updateSettingsUI()
                this.renderReadingPresetsUI()
            })

            const delBtn = document.createElement('button')
            delBtn.type = 'button'
            delBtn.title = t('appearance.fontDeleteTitle')
            delBtn.style.cssText = 'border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 0.9rem; padding: 0 4px;'
            delBtn.textContent = '×'
            delBtn.addEventListener('click', async (e) => {
                e.stopPropagation()
                const isUsing = this.app.settings.font === f.id
                const msg = isUsing ? t('appearance.fontDeleteInUseMsg', { name: f.name }) : t('appearance.fontDeleteMsg', { name: f.name })
                const confirmed = await this.app.dialogs.showConfirmDialog(t('appearance.fontDeleteDialogTitle'), msg)
                if (!confirmed) return
                await customFontManager.deleteFont(f.id)
                if (isUsing) {
                    this.app.setSetting('font', 'serif')
                    await this.app.saveSettings()
                }
                await this.renderCustomFontsUI()
                this.updateSettingsUI()
                this.app.dialogs.showToast(t('appearance.toast.fontDeleted'), 'info')
            })

            row.appendChild(choiceBtn)
            row.appendChild(delBtn)
            list.appendChild(row)
        })
    }

    initReadingPresetsUI() {
        const btnToggle = this.dom.btnToggleReadingPresets
        const container = this.dom.readingPresetsContainer
        const hint = this.dom.hintPresetsToggle
        const btnSaveCurrent = this.dom.btnSaveCurrentPreset

        if (btnToggle && container) {
            btnToggle.addEventListener('click', () => {
                const isOpen = container.style.display !== 'none'
                container.style.display = isOpen ? 'none' : 'flex'
                if (hint) hint.textContent = isOpen ? t('settings.presetExpand') : t('appearance.preset.collapse')
            })
        }

        if (btnSaveCurrent) {
            btnSaveCurrent.addEventListener('click', async () => {
                const presets = readingPresetsManager.getPresets()
                if (presets.length >= MAX_READING_PRESETS) {
                    this.app.dialogs.showToast(t('appearance.toast.presetLimitReached', { max: MAX_READING_PRESETS }), 'warning')
                    return
                }

                const rawName = await this.app.dialogs.showInputDialog({
                    title: t('appearance.preset.saveTitle'),
                    message: t('appearance.preset.saveMsg'),
                    value: t('appearance.preset.defaultName', { num: presets.length + 1 })
                })
                if (rawName == null) return // cancelled
                const name = rawName.trim()
                if (!name) {
                    this.app.dialogs.showToast(t('appearance.toast.presetNameEmpty'), 'warning')
                    return
                }

                const res = readingPresetsManager.createPreset(name, this.app.settings)
                if (res.success) {
                    this.renderReadingPresetsUI()
                    this.app.dialogs.showToast(t('appearance.toast.presetSaved', { name: res.preset.name }), 'success')
                } else {
                    this.app.dialogs.showToast(res.error || t('appearance.toast.presetSaveFailed'), 'warning')
                }
            })
        }

        this.renderReadingPresetsUI()
    }

    updatePresetsBadge() {
        const badge = this.dom?.badgeActivePreset || document.getElementById('badge-active-preset')
        if (!badge) return
        const active = readingPresetsManager.getActivePreset()
        const isMod = readingPresetsManager.isCurrentModified(this.app.settings)
        if (active) {
            badge.textContent = active.name + (isMod ? t('appearance.preset.modifiedSuffix') : '')
            badge.style.color = isMod ? '#f59e0b' : 'var(--accent-primary, #da7756)'
        } else {
            badge.textContent = t('settings.presetDefault')
            badge.style.color = 'var(--text-muted)'
        }
    }

    renderReadingPresetsUI() {
        const countLabel = this.dom?.presetsCountLabel || document.getElementById('presets-count-label')
        const list = this.dom?.readingPresetsList || document.getElementById('reading-presets-list')
        const presets = readingPresetsManager.getPresets()
        const activeId = readingPresetsManager.activePresetId

        if (countLabel) {
            countLabel.textContent = t('appearance.preset.countLabel', { count: presets.length, max: MAX_READING_PRESETS })
        }

        this.updatePresetsBadge()

        if (!list) return
        list.innerHTML = ''

        if (presets.length === 0) {
            const emptyEl = document.createElement('div')
            emptyEl.className = 'presets-empty-hint'
            emptyEl.textContent = t('appearance.preset.emptyList')
            list.appendChild(emptyEl)
            return
        }

        presets.forEach(p => {
            const row = document.createElement('div')
            const isActive = activeId === p.id
            const isMod = isActive && readingPresetsManager.isCurrentModified(this.app.settings)

            row.style.cssText = `display: flex; flex-direction: column; gap: 4px; background: var(--bg-tertiary); padding: 6px 8px; border-radius: 6px; border: 1px solid ${isActive ? 'var(--accent)' : 'transparent'};`

            const topRow = document.createElement('div')
            topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;'

            const nameBtn = document.createElement('button')
            nameBtn.type = 'button'
            nameBtn.style.cssText = `border: none; background: none; font-size: 0.82rem; font-weight: ${isActive ? '600' : 'normal'}; color: ${isActive ? 'var(--accent)' : 'var(--text-primary)'}; cursor: pointer; text-align: left; padding: 0;`
            nameBtn.textContent = `${p.name}${isMod ? t('appearance.preset.modifiedSuffix') : ''}`
            nameBtn.title = t('appearance.preset.applyTitle')
            nameBtn.addEventListener('click', async () => {
                const applied = readingPresetsManager.applyPreset(p.id)
                if (applied) {
                    if (applied.writingMode === 'vertical-rl') {
                        applied.columnCount = '1'
                    }
                    for (const [k, v] of Object.entries(applied)) {
                        this.app.setSetting(k, v)
                    }
                    await this.app.saveSettings()
                    this.updateSettingsUI()
                    this.applySettingsToReader()
                    this.renderReadingPresetsUI()
                    this.app.dialogs.showToast(t('appearance.toast.presetApplied', { name: p.name }), 'success')
                }
            })

            const actionsWrap = document.createElement('div')
            actionsWrap.style.cssText = 'display: flex; align-items: center; gap: 4px;'

            const btnUpdate = document.createElement('button')
            btnUpdate.type = 'button'
            btnUpdate.title = t('appearance.preset.updateTitle')
            btnUpdate.style.cssText = 'border: 1px solid var(--border-color); background: none; color: var(--text-secondary); font-size: 0.7rem; border-radius: 3px; padding: 1px 4px; cursor: pointer;'
            btnUpdate.textContent = t('appearance.preset.updateBtn')
            btnUpdate.addEventListener('click', (e) => {
                e.stopPropagation()
                readingPresetsManager.updatePreset(p.id, this.app.settings)
                this.renderReadingPresetsUI()
                this.app.dialogs.showToast(t('appearance.toast.presetUpdated', { name: p.name }), 'success')
            })

            const btnRename = document.createElement('button')
            btnRename.type = 'button'
            btnRename.title = t('appearance.preset.renameTitle')
            btnRename.style.cssText = 'border: 1px solid var(--border-color); background: none; color: var(--text-secondary); font-size: 0.7rem; border-radius: 3px; padding: 1px 4px; cursor: pointer;'
            btnRename.textContent = t('appearance.preset.renameBtn')
            btnRename.addEventListener('click', async (e) => {
                e.stopPropagation()
                const newName = await this.app.dialogs.showInputDialog({
                    title: t('appearance.preset.renameDialogTitle'),
                    message: t('appearance.preset.renameDialogMsg'),
                    value: p.name
                })
                if (newName && newName.trim()) {
                    readingPresetsManager.renamePreset(p.id, newName.trim())
                    this.renderReadingPresetsUI()
                }
            })

            const btnDup = document.createElement('button')
            btnDup.type = 'button'
            btnDup.title = t('appearance.preset.dupTitle')
            btnDup.style.cssText = 'border: 1px solid var(--border-color); background: none; color: var(--text-secondary); font-size: 0.7rem; border-radius: 3px; padding: 1px 4px; cursor: pointer;'
            btnDup.textContent = t('appearance.preset.dupBtn')
            btnDup.addEventListener('click', (e) => {
                e.stopPropagation()
                const res = readingPresetsManager.duplicatePreset(p.id)
                if (res.success) {
                    this.renderReadingPresetsUI()
                    this.app.dialogs.showToast(t('appearance.toast.presetDuplicated', { name: res.preset.name }), 'success')
                } else {
                    this.app.dialogs.showToast(res.error || t('appearance.toast.dupFailed'), 'warning')
                }
            })

            const btnDel = document.createElement('button')
            btnDel.type = 'button'
            btnDel.title = t('appearance.preset.delTitle')
            btnDel.style.cssText = 'border: 1px solid var(--border-color); background: none; color: #ef4444; font-size: 0.7rem; border-radius: 3px; padding: 1px 4px; cursor: pointer;'
            btnDel.textContent = t('common.delete')
            btnDel.addEventListener('click', async (e) => {
                e.stopPropagation()
                const confirmed = await this.app.dialogs.showConfirmDialog(t('appearance.preset.delDialogTitle'), t('appearance.preset.delDialogMsg', { name: p.name }))
                if (confirmed) {
                    readingPresetsManager.deletePreset(p.id)
                    this.renderReadingPresetsUI()
                    this.app.dialogs.showToast(t('appearance.toast.presetDeleted'), 'info')
                }
            })

            actionsWrap.appendChild(btnUpdate)
            actionsWrap.appendChild(btnRename)
            actionsWrap.appendChild(btnDup)
            actionsWrap.appendChild(btnDel)

            topRow.appendChild(nameBtn)
            topRow.appendChild(actionsWrap)

            const s = p.settings || {}
            const detailsRow = document.createElement('div')
            detailsRow.style.cssText = 'font-size: 0.7rem; color: var(--text-muted); display: flex; gap: 8px;'
            const fontLabel = s.font === 'serif' ? t('appearance.fontLabel.serif') : s.font === 'sans' ? t('appearance.fontLabel.sans') : s.font === 'kaiti' ? t('appearance.fontLabel.kaiti') : s.font === 'mono' ? t('appearance.fontLabel.mono') : t('appearance.fontLabel.custom')
            detailsRow.textContent = `${fontLabel} · ${s.fontSize || 18}px · ${t('appearance.preset.summaryLineHeight', { val: s.lineHeight || 1.6 })} · ${s.writingMode === 'vertical-rl' ? t('appearance.preset.modeVertical') : t('appearance.preset.modeHorizontal')} · ${s.columnCount === '1' ? t('appearance.preset.colSingle') : t('appearance.preset.colDouble')}`

            row.appendChild(topRow)
            row.appendChild(detailsRow)
            list.appendChild(row)
        })
    }

    resolveThemePalette(themeName) {
        const theme = themeName || this.app.settings?.theme || 'light'
        const isDark = (theme === 'dark' || theme === 'black')
        const colorScheme = isDark ? 'dark' : 'light'
        const palettes = {
            light: { shellBg: '#FAF9F5', readerBg: '#FAF9F5', readerText: '#1a1815', link: '#da7756', selection: 'rgba(218, 119, 86,  0.22)' },
            sepia: { shellBg: '#f5eedc', readerBg: '#f5eedc', readerText: '#3b2e1e', link: '#b45309', selection: 'rgba(217, 119, 6, 0.26)' },
            dark:  { shellBg: '#1f1f1d', readerBg: '#1f1f1d', readerText: '#edece6', link: '#d97757', selection: 'rgba(217, 119, 87, 0.28)' },
            black: { shellBg: '#000000', readerBg: '#000000', readerText: '#cccccc', link: '#a1a1aa', selection: 'rgba(96, 165, 250, 0.36)' },
            green: { shellBg: '#e8f5e9', readerBg: '#e8f5e9', readerText: '#1b4d1d', link: '#2e7d32', selection: 'rgba(16, 185, 129, 0.25)' },
            eink:  { shellBg: '#ffffff', readerBg: '#ffffff', readerText: '#000000', link: '#000000', selection: 'rgba(0, 0, 0, 0.18)' },
            warm:  { shellBg: '#FAF9F5', readerBg: '#FAF9F5', readerText: '#292524', link: '#da7756', selection: 'rgba(218, 119, 86,  0.22)' }
        }
        return {
            ...(palettes[theme] || palettes.light),
            colorScheme
        }
    }

    applyTheme(theme, isUserExplicit = true) {
        this.app.pageTurnController?.cancelCurrent()
        this.app.themeGeneration = (this.app.themeGeneration || 0) + 1
        let targetTheme = theme
        if (theme === 'system') {
            this.app.themeMode = 'system'
            try { localStorage.setItem('linden_leaf_theme_mode', 'system') } catch (e) {}
            const isDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
            targetTheme = isDark ? 'black' : 'light'
        } else if (isUserExplicit) {
            this.app.themeMode = 'manual'
            try { localStorage.setItem('linden_leaf_theme_mode', 'manual') } catch (e) {}
        }
        document.documentElement.setAttribute('data-theme', targetTheme)
        const palette = this.resolveThemePalette(targetTheme)
        const bg = palette.shellBg
        document.documentElement.style.backgroundColor = bg
        if (document.body) document.body.style.backgroundColor = bg
        try { localStorage.setItem('linden_leaf_theme', targetTheme) } catch (e) {}
        this.app.setSetting('theme', theme)
        document.querySelectorAll('.theme-btn').forEach(btn => {
            if (this.app.themeMode === 'system') {
                btn.classList.toggle('active', btn.dataset.val === 'system')
            } else {
                btn.classList.toggle('active', btn.dataset.val === theme)
            }
        })
        if (typeof window !== 'undefined') window.mobileShell?.syncThemeLabel?.()
        this.applySettingsToReader()

        // Diagnostics export
        window.__getReaderThemeDiagnostics = () => {
            const isSystemDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : null
            const curTheme = this.app.settings?.theme || document.documentElement.getAttribute('data-theme')
            const pal = this.resolveThemePalette(curTheme)
            const iframe = document.querySelector('#reader-content-area iframe')
            let iframeComp = null
            if (iframe && iframe.contentDocument) {
                const body = iframe.contentDocument.body
                const html = iframe.contentDocument.documentElement
                const bodyStyle = body ? iframe.contentDocument.defaultView?.getComputedStyle(body) : null
                const htmlStyle = html ? iframe.contentDocument.defaultView?.getComputedStyle(html) : null
                const sampleP = body?.querySelector('p, div, span')
                const pStyle = sampleP ? iframe.contentDocument.defaultView?.getComputedStyle(sampleP) : null
                iframeComp = {
                    htmlBg: htmlStyle?.backgroundColor,
                    bodyBg: bodyStyle?.backgroundColor,
                    sampleTextTag: sampleP?.tagName,
                    textColor: pStyle?.color || bodyStyle?.color,
                    opacity: bodyStyle?.opacity,
                    filter: bodyStyle?.filter,
                    textFillColor: bodyStyle?.webkitTextFillColor
                }
            }
            return {
                themeMode: this.app.themeMode,
                isSystemDark,
                activeTheme: curTheme,
                palette: pal,
                rootBg: document.documentElement.style.backgroundColor,
                iframe: iframeComp,
                generation: this.app.themeGeneration || 1
            }
        }
    }

    _getViewportEnv() {
        const isAndroid = Boolean(platformBridge?.isAndroid) || document.documentElement.classList.contains('platform-android')
        const isMobile = Boolean(
            window.mobileShell?.isMobileViewport?.() ||
            isAndroid ||
            document.documentElement.classList.contains('is-mobile-ui') ||
            window.innerWidth < 768
        )
        return {
            isMobile,
            isAndroid,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            bookFormat: this.app.currentBookFormat || null,
        }
    }

    _buildEffectiveReaderSettings(overridePreserve = null) {
        const defaults = getDefaultReaderSettings(this._getViewportEnv())
        const s = {
            ...defaults,
            ...(this.app.advancedSettings?.config || {}),
            ...(this.app.settings || {}),
            ...(this._bookSettingsOverride || {})
        }
        const rawPreserve = overridePreserve !== null ? overridePreserve : (s.preserveOriginalStyles === true)
        s.preserveOriginalStyles = this.app.currentBookFormat === 'epub' && rawPreserve
        return s
    }

    applySettingsToReader() {
        this.app.pageTurnController?.cancelCurrent()
        this.app.pdfTools.applyPdfPageAppearance()
        if (!this.app.foliateView || !this.app.foliateView.renderer) return
        const r = this.app.foliateView.renderer
        const s = this._buildEffectiveReaderSettings()
        const layout = resolveEffectiveReaderLayout(s, this._getViewportEnv())

        if (this.app.foliateView.isFixedLayout) {
            this.app.pdfTools.dom.btnPdfSpreadToggle?.classList.toggle('active', layout.columnCount === '2')
            if (r.setSpread && this.app.foliateView.lastLocation != null) {
                r.setSpread(layout.columnCount)
            }
        } else {
            r.settle?.()
            // Pass canonical layout metrics to paginator without redundant reflow attributes
            if (r.setAttribute) {
                const syncAttr = (name, val) => {
                    const next = String(val)
                    if (r.getAttribute?.(name) !== next) r.setAttribute(name, next)
                }
                syncAttr('flow', layout.layout)
                syncAttr('margin', `${layout.paginatorMargin}px`)
                syncAttr('margin-top', `${layout.marginTop}px`)
                syncAttr('margin-bottom', `${layout.marginBottom}px`)
                if (layout.marginInline != null) {
                    syncAttr('margin-inline', `${layout.marginInline}px`)
                } else if (r.hasAttribute?.('margin-inline')) {
                    r.removeAttribute?.('margin-inline')
                }
                syncAttr('max-inline-size', `${layout.maxInlineSize}px`)
                syncAttr('max-column-count', layout.columnCount)
                syncAttr('gap', `${layout.gapPercent}%`)
            }
        }

        const css = buildContentCSS(s)
        if (r.setStyles) {
            r.setStyles(css)
        }
        if (!this.app.foliateView.isFixedLayout) {
            const currentContent = r.getContents?.()?.[0]
            const doc = currentContent?.doc
            const targetMode = s.preserveOriginalStyles ? 'publisher' : 'custom'
            this._desiredEpubStyleMode = targetMode
            const currentMode = doc?.documentElement?.dataset?.readerStyleMode
            if (currentMode && currentMode !== targetMode) {
                // Reload the unmodified chapter instead of layering patches over normalized DOM.
                r.settle?.()
                const activeView = this.app.foliateView
                const reloadBookId = this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId || null
                const cfi = activeView.lastLocation?.cfi
                const resolved = cfi ? activeView.resolveNavigation(cfi) : null
                const target = resolved || (Number.isInteger(currentContent?.index)
                    ? { index: currentContent.index, anchor: activeView.lastLocation?.fraction || 0 }
                    : null)
                if (target) {
                    const reloadSeq = (this._styleReloadSeq = (this._styleReloadSeq || 0) + 1)
                    Promise.resolve(r.goTo({ ...target, reload: true })).then(() => {
                        if (activeView !== this.app.foliateView || r !== this.app.foliateView?.renderer) return
                        const latestDocMode = r.getContents?.()?.[0]?.doc?.documentElement?.dataset?.readerStyleMode
                        if (latestDocMode && latestDocMode !== this._desiredEpubStyleMode) {
                            this.applySettingsToReader()
                            return
                        }
                        if (reloadSeq !== this._styleReloadSeq) return
                        r.setStyles?.(buildContentCSS(this._buildEffectiveReaderSettings()))
                    }).catch(error => {
                        if (reloadSeq !== this._styleReloadSeq || activeView !== this.app.foliateView || r !== this.app.foliateView?.renderer) return
                        const activeBookId = this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId || null
                        if (reloadBookId && activeBookId && activeBookId !== reloadBookId) return
                        console.warn('Could not switch EPUB style mode cleanly:', error)
                        const revertPreserve = currentMode === 'publisher'
                        this._desiredEpubStyleMode = currentMode
                        this.app.setSetting('preserveOriginalStyles', revertPreserve)
                        this.updateSettingsUI()
                        r.setStyles?.(buildContentCSS(this._buildEffectiveReaderSettings(revertPreserve)))
                        Promise.resolve(this.app.saveSettings?.({ apply: false })).catch(saveErr => {
                            console.warn('Could not persist reverted EPUB style mode:', saveErr)
                        })
                        this.app.dialogs.showToast(t('appearance.toast.togglePublisherFailed'), 'warning')
                    })
                }
            }
        }
    }

    initBookOverrideUI() {
        const cb = document.getElementById('setting-book-override')
        const hint = document.getElementById('book-override-hint')
        const btnReset = document.getElementById('btn-reset-book-override')
        if (!cb) return

        cb.addEventListener('change', () => {
            const bookId = this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId
            if (!bookId) {
                this.app.dialogs.showToast(t('appearance.toast.openBookFirst'), 'info')
                cb.checked = false
                return
            }
            if (cb.checked) {
                this._bookSettingsOverride = {}
                for (const k of READER_OVERRIDE_ALLOWED_KEYS) {
                    if (this.app.globalSettings && Object.hasOwn(this.app.globalSettings, k)) {
                        this._bookSettingsOverride[k] = structuredClone(this.app.globalSettings[k])
                    } else if (Object.hasOwn(this.app.settings, k)) {
                        this._bookSettingsOverride[k] = structuredClone(this.app.settings[k])
                    }
                }
                if (Object.hasOwn(this._bookSettingsOverride, 'pageTurnMode')) {
                    const isMobile = Boolean(
                        window.platformBridge?.isAndroid ||
                        window.mobileShell?.isMobileViewport?.() ||
                        document.documentElement?.classList?.contains?.('is-mobile-viewport')
                    )
                    this._bookSettingsOverride.pageTurnSourcePlatform = isMobile ? 'mobile' : 'desktop'
                }
                try {
                    localStorage.setItem(`linden_book_settings_${bookId}`, JSON.stringify(this._bookSettingsOverride))
                } catch (e) {}
                this.app.settings = resolveReaderSettings(this.app.globalSettings || this.app.settings, this._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
                this.updateBookOverrideUI(true)
                this.updateSettingsUI()
                this.applySettingsToReader()
                this.app.dialogs.showToast(t('appearance.toast.bookOverrideOn'), 'success')
            } else {
                this._bookSettingsOverride = null
                try {
                    localStorage.removeItem(`linden_book_settings_${bookId}`)
                } catch (e) {}
                this.app.settings = resolveReaderSettings(this.app.globalSettings || this.app.settings, null, READER_OVERRIDE_ALLOWED_KEYS)
                this.updateBookOverrideUI(false)
                this.updateSettingsUI()
                this.applySettingsToReader()
                this.app.saveSettingsDebounced()
                this.app.dialogs.showToast(t('appearance.toast.bookOverrideOff'), 'info')
            }
        })

        btnReset?.addEventListener('click', () => {
            const bookId = this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId
            if (bookId) {
                this._bookSettingsOverride = null
                try {
                    localStorage.removeItem(`linden_book_settings_${bookId}`)
                } catch (e) {}
                cb.checked = false
                this.app.settings = resolveReaderSettings(this.app.globalSettings || this.app.settings, null, READER_OVERRIDE_ALLOWED_KEYS)
                this.updateBookOverrideUI(false)
                this.updateSettingsUI()
                this.applySettingsToReader()
                this.app.saveSettingsDebounced()
                this.app.dialogs.showToast(t('appearance.toast.bookOverrideOff'), 'info')
            }
        })
    }

    updateBookOverrideUI(hasOverride) {
        const cb = document.getElementById('setting-book-override')
        const hint = document.getElementById('book-override-hint')
        if (cb) cb.checked = !!hasOverride
        if (hint) hint.style.display = hasOverride ? 'flex' : 'none'
    }

    async checkBookSpecificSettings(bookId) {
        if (!bookId) {
            this._bookSettingsOverride = null
            this.app.settings = resolveReaderSettings(this.app.globalSettings || this.app.settings, null, READER_OVERRIDE_ALLOWED_KEYS)
            this.updateBookOverrideUI(false)
            this.updateSettingsUI()
            return
        }
        try {
            const key = `linden_book_settings_${bookId}`
            const raw = localStorage.getItem(key)
            if (raw) {
                const parsed = JSON.parse(raw)
                this._bookSettingsOverride = {}
                for (const k of READER_OVERRIDE_ALLOWED_KEYS) {
                    if (parsed && Object.hasOwn(parsed, k)) {
                        this._bookSettingsOverride[k] = parsed[k]
                    }
                }
                if (parsed?.pageTurnSourcePlatform === 'mobile' || parsed?.pageTurnSourcePlatform === 'desktop') {
                    this._bookSettingsOverride.pageTurnSourcePlatform = parsed.pageTurnSourcePlatform
                }
                const legacyOverridePreserve = resolveLegacyPreserveOriginalStyles(parsed, true)
                if (legacyOverridePreserve !== undefined && !Object.hasOwn(this._bookSettingsOverride, 'preserveOriginalStyles')) {
                    this._bookSettingsOverride.preserveOriginalStyles = legacyOverridePreserve
                }
                this.updateBookOverrideUI(true)
            } else {
                this._bookSettingsOverride = null
                this.updateBookOverrideUI(false)
            }
        } catch (e) {
            this._bookSettingsOverride = null
            this.updateBookOverrideUI(false)
        }
        this.app.settings = resolveReaderSettings(this.app.globalSettings || this.app.settings, this._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
        this.updateSettingsUI()
    }

    switchSettingsDomain(domain) {
        const panel = this.app.annotations.dom.tabPanels?.settings || document.getElementById('panel-settings')
        if (panel) {
            panel.setAttribute('data-active-domain', domain)
        }
        document.querySelectorAll('.settings-domain-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.settingsDomain === domain)
        })
        if (domain === 'system') this.app._populateStoragePaths?.()
        const drawerBody = document.querySelector('#sidebar-drawer .drawer-body')
        if (drawerBody) drawerBody.scrollTop = 0
    }
}
