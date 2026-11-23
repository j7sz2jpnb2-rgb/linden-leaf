

import { t } from './i18n.js'

export let _statsHeatmapMod = null

export let _statsHeatmapPromise = null

export const ensureStatsHeatmapModule = () => {
    if (_statsHeatmapMod) return Promise.resolve(_statsHeatmapMod)
    if (!_statsHeatmapPromise) {
        _statsHeatmapPromise = import('./stats-heatmap.js').then(mod => {
            _statsHeatmapMod = mod
            return mod
        })
    }
    return _statsHeatmapPromise
}

export const formatMinutesClean = (mins) => {
    if (_statsHeatmapMod?.formatMinutesClean) return _statsHeatmapMod.formatMinutesClean(mins)
    const m = Math.max(0, Math.round(Number(mins) || 0))
    if (m < 60) return t('time.minutes', { count: m })
    const h = Math.floor(m / 60)
    const rem = m % 60
    return rem > 0 ? t('time.hoursMinutes', { hours: h, mins: rem }) : t('time.hours', { hours: h })
}

export const formatAxisLabel = (mins, unit = mins >= 60 ? 'hours' : 'minutes') => {
    if (_statsHeatmapMod?.formatAxisLabel) return _statsHeatmapMod.formatAxisLabel(mins, unit)
    const m = Math.max(0, Math.round(Number(mins) || 0))
    return unit === 'hours' ? t('time.hours', { hours: Number((m / 60).toFixed(2)) }) : t('time.minutes', { count: m })
}

export const renderCleanBarChart = (container, data) => {
    if (_statsHeatmapMod?.renderCleanBarChart) return _statsHeatmapMod.renderCleanBarChart(container, data)
    return ensureStatsHeatmapModule().then(mod => mod?.renderCleanBarChart?.(container, data)).catch(() => {})
}

export const renderCalendarHeatmap = (container, targetYear, onSelectDay) => {
    if (_statsHeatmapMod?.renderCalendarHeatmap) return _statsHeatmapMod.renderCalendarHeatmap(container, targetYear, onSelectDay)
    return ensureStatsHeatmapModule().then(mod => mod?.renderCalendarHeatmap?.(container, targetYear, onSelectDay)).catch(() => {})
}

export let _advancedSettingsModPromise = null

export const ensureAdvancedSettingsLoaded = (appInstance) => {
    if (appInstance?.advancedSettings?._isRealInstance) return Promise.resolve(appInstance.advancedSettings)
    if (!_advancedSettingsModPromise) {
        _advancedSettingsModPromise = import('./advanced-settings.js')
    }
    return _advancedSettingsModPromise.then(({ advancedSettings }) => {
        advancedSettings._isRealInstance = true
        if (appInstance) {
            appInstance.advancedSettings = advancedSettings
            advancedSettings.app = appInstance
            if (appInstance.dom) {
                advancedSettings.bindUI({
                    badgeAdvancedStatus: appInstance.dom.badgeAdvancedStatus,
                    hintAdvancedTrigger: appInstance.dom.hintAdvancedTrigger,
                    advancedSettingsContainer: appInstance.dom.advancedSettingsContainer,
                    settingAiContextBudget: appInstance.dom.settingAiContextBudget,
                    labelAiContextBudget: appInstance.dom.labelAiContextBudget,
                    settingInplaceParaTrans: appInstance.dom.settingInplaceParaTrans,
                    settingModelTokenizer: appInstance.dom.settingModelTokenizer,
                    settingAiMaxTokens: appInstance.dom.settingAiMaxTokens,
                    settingAiCooldown: appInstance.dom.settingAiCooldown,
                    settingAiDailyLimit: appInstance.dom.settingAiDailyLimit,
                    settingDictSaveHistory: appInstance.dom.settingDictSaveHistory,
                    btnPopupTranslatePara: appInstance.dom.popupTranslatePara,
                    rowAdvancedSettingsTrigger: appInstance.dom.rowAdvancedSettingsTrigger,
                    modalAdvancedSettingsConfirm: appInstance.dom.modalAdvancedSettingsConfirm,
                    btnCloseAdvancedConfirm: appInstance.dom.btnCloseAdvancedConfirm,
                    btnCancelAdvancedUnlock: appInstance.dom.btnCancelAdvancedUnlock,
                    btnConfirmAdvancedUnlock: appInstance.dom.btnConfirmAdvancedUnlock,
                    btnResetAdvancedSettings: appInstance.dom.btnResetAdvancedSettings
                })
            }
        }
        return advancedSettings
    })
}

export let _aiSidebarModPromise = null

export const ensureAiSidebarLoaded = (appInstance) => {
    if (appInstance?.aiSidebar?._isRealInstance) return Promise.resolve(appInstance.aiSidebar)
    if (!_aiSidebarModPromise) {
        _aiSidebarModPromise = import('./ai-sidebar-controller.js')
    }
    return _aiSidebarModPromise.then(({ AiSidebarController }) => {
        if (appInstance && !appInstance.aiSidebar?._isRealInstance) {
            const ctrl = new AiSidebarController(appInstance)
            ctrl._isRealInstance = true
            appInstance.aiSidebar = ctrl
        }
        return appInstance?.aiSidebar
    })
}

export let _chapterTransModPromise = null

export const ensureChapterTranslationLoaded = (appInstance) => {
    if (appInstance?.chapterTranslationManager?._isRealInstance) return Promise.resolve(appInstance.chapterTranslationManager)
    if (!_chapterTransModPromise) {
        _chapterTransModPromise = import('./chapter-translation-manager.js')
    }
    return _chapterTransModPromise.then(({ chapterTranslationManager }) => {
        chapterTranslationManager._isRealInstance = true
        if (appInstance) {
            appInstance.chapterTranslationManager = chapterTranslationManager
            chapterTranslationManager.app = appInstance
            if (typeof document !== 'undefined') {
                chapterTranslationManager.init({
                    btnChapterTranslate: document.getElementById('btn-chapter-translate'),
                    modalChapterTransConfirm: document.getElementById('modal-chapter-trans-confirm'),
                    btnCancelChapterTransModal: document.getElementById('btn-cancel-chapter-trans-modal'),
                    btnConfirmChapterTransStart: document.getElementById('btn-confirm-chapter-trans-start'),
                    btnChapterTransStop: document.getElementById('btn-chapter-trans-stop'),
                    btnChapterTransClear: document.getElementById('btn-chapter-trans-clear'),
                    btnTransModeSource: document.getElementById('btn-trans-mode-source'),
                    btnTransModeBilingual: document.getElementById('btn-trans-mode-bilingual'),
                    btnTransModeTarget: document.getElementById('btn-trans-mode-target'),
                    chapterTransBar: document.getElementById('chapter-translation-bar')
                })
            }
        }
        return chapterTranslationManager
    })
}
