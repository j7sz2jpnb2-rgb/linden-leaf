

import { t } from './i18n.js'

export let _statsHeatmapMod = null

export let _statsHeatmapPromise = null

export const ensureStatsHeatmapModule = (loader = () => import('./stats-heatmap.js')) => {
    if (_statsHeatmapMod) return Promise.resolve(_statsHeatmapMod)
    if (!_statsHeatmapPromise) {
        _statsHeatmapPromise = Promise.resolve()
            .then(() => loader())
            .then(mod => {
                _statsHeatmapMod = mod
                return mod
            })
            .catch(err => {
                _statsHeatmapPromise = null
                throw err
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

export const ensureAdvancedSettingsLoaded = (appInstance, loader = () => import('./advanced-settings.js')) => {
    if (appInstance?.advancedSettings?._isRealInstance) return Promise.resolve(appInstance.advancedSettings)
    if (!_advancedSettingsModPromise) {
        _advancedSettingsModPromise = Promise.resolve()
            .then(() => loader())
            .catch(err => {
                _advancedSettingsModPromise = null
                throw err
            })
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

export const ensureAiSidebarLoaded = (appInstance, loader = () => import('./ai-sidebar-controller.js')) => {
    if (appInstance?.aiSidebar?._isRealInstance) return Promise.resolve(appInstance.aiSidebar)
    if (!_aiSidebarModPromise) {
        _aiSidebarModPromise = Promise.resolve()
            .then(() => loader())
            .catch(err => {
                _aiSidebarModPromise = null
                throw err
            })
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

export const ensureChapterTranslationLoaded = (appInstance, loader = () => import('./chapter-translation-manager.js')) => {
    if (appInstance?.chapterTranslationManager?._isRealInstance) return Promise.resolve(appInstance.chapterTranslationManager)
    if (!_chapterTransModPromise) {
        _chapterTransModPromise = Promise.resolve()
            .then(() => loader())
            .catch(err => {
                _chapterTransModPromise = null
                throw err
            })
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

export let _externalCompanionModPromise = null

export const ensureExternalCompanionLoaded = (appInstance, loader = () => import('./external-ai-companion.js')) => {
    if (appInstance?.externalCompanion?._isRealInstance) return Promise.resolve(appInstance.externalCompanion)
    if (!_externalCompanionModPromise) {
        _externalCompanionModPromise = Promise.resolve()
            .then(() => loader())
            .catch(err => {
                _externalCompanionModPromise = null
                throw err
            })
    }
    return _externalCompanionModPromise.then(({ ExternalAiCompanionManager }) => {
        if (appInstance && !appInstance.externalCompanion?._isRealInstance) {
            const mgr = new ExternalAiCompanionManager(appInstance)
            mgr._isRealInstance = true
            appInstance.externalCompanion = mgr
        }
        return appInstance?.externalCompanion
    })
}
