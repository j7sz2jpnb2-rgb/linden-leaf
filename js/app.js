import { DomEvents, isComposedDescendant } from './dom-events.js'
import { UiDialogs } from './ui-dialogs.js'
import { StatsViewController } from './stats-view-controller.js'
import { BookshelfController } from './bookshelf-controller.js'
import { ImportFolderController } from './import-folder-controller.js'
import { SyncController } from './sync-controller.js'
import { UpdateController } from './update-controller.js'
import { PdfDrawingController } from './pdf-drawing-controller.js'
import { PdfToolsController } from './pdf-tools-controller.js'
import { ReaderSearchController } from './reader-search-controller.js'
import { AnnotationsDrawerController } from './annotations-drawer-controller.js'
import { ReaderCardsController } from './reader-cards-controller.js'
import { ReaderAppearanceController } from './reader-appearance-controller.js'
import { FoliateSectionBinder } from './foliate-section-binder.js'
import '../foliate-js-main/view.js'
export { ReaderLocationHistory, normalizeNavigationTarget, decodePdfProgress } from './reader-navigation.js'
export { FEATURE_CHAPTER_TRANSLATION_ENABLED, FEATURE_ANNUAL_REPORT_ENABLED, APP_BUILD_VER } from './app-features.js'
import { openLocalEpubSource, openLocalPdfSource } from './book-source.js'
import { pdfPreferenceKey } from './pdf-preferences.js'
import { Overlayer } from '../foliate-js-main/overlayer.js'
import * as db from './db.js'
import { tracker } from './tracker.js'
import { quoteCard } from './quote-card.js'
import { PdfViewport } from './pdf-viewport.js'
import { AdaptivePdfDriver, setMuPdfStoreLimit } from './pdf-driver.js'
import { buildPdfTocIndex, pdfTocAtPage } from './pdf-toc.js'
import { platformBridge } from './platformBridge.js'
import { importQueue } from './import-queue.js'
import { bookDetailsModal } from './book-details.js'
import { fullTextSearchEngine } from './fulltext-search.js'
import { saveAiConfig } from './reading-ai-assistant.js'
import { PageTurnController, FoliatePageTurnAdapter, PdfPageTurnAdapter, FEATURE_CURL_PAGE_TURN_ENABLED } from './page-turn-controller.js'
import { dictionaryService } from './dictionary-service.js'
import { customFontManager } from './custom-font-manager.js'
import { resolveReaderSettings, READER_OVERRIDE_ALLOWED_KEYS, resolveLegacyPreserveOriginalStyles } from './translation-job-core.js'
import { detectReaderViewportEnv, getDefaultReaderSettings, migrateLegacyReaderSettings } from './reader-style-builder.js'
import { ttsPlayer } from './tts-player.js'
import { mobileShell } from './mobile-shell.js'
import { ReaderLocationHistory, decodePdfProgress } from './reader-navigation.js'
import { coverUrlPool } from './cover-url-pool.js'
import { FEATURE_CHAPTER_TRANSLATION_ENABLED } from './app-features.js'
import { ensureAdvancedSettingsLoaded, ensureAiSidebarLoaded, ensureChapterTranslationLoaded } from './app-modules.js'
import { DEFAULT_READER_NAME } from './ui-format.js'
import {
    initLocale,
    getLocale,
    setLocale,
    onLocaleChange,
    t,
    detectPreferredLocale,
    shouldShowPreOnboardingLocaleGate,
} from './i18n.js'

/** Normalizes legacy `'curl'` and viewport-constrained page turn modes cleanly. */
function normalizeAppPageTurnMode(mode, isMobile) {
    if (!isMobile) return 'none'
    if (mode === 'curl') return FEATURE_CURL_PAGE_TURN_ENABLED ? 'cover' : 'slide'
    return ['none', 'slide', 'cover'].includes(mode) ? mode : 'slide'
}

class UniversalReaderApp {
    constructor() {
        this.rootEvents = new DomEvents()
        this.dialogs = new UiDialogs(this)
        this.stats = new StatsViewController(this)
        this.bookshelf = new BookshelfController(this)
        this.imports = new ImportFolderController(this)
        this.sync = new SyncController(this)
        this.updates = new UpdateController(this)
        this.drawing = new PdfDrawingController(this)
        this.pdfTools = new PdfToolsController(this)
        this.search = new ReaderSearchController(this)
        this.annotations = new AnnotationsDrawerController(this)
        this.cards = new ReaderCardsController(this)
        this.appearance = new ReaderAppearanceController(this)
        this.sections = new FoliateSectionBinder(this)
 
        this.currentBookId = null
        this.currentBookData = null
        this.foliateView = null
        this.pdfViewport = null
        this.currentBookFormat = null
        this.pdfDriver = null

        this.currentLocation = null

        // Multi-window satellite reader mode detection (?windowMode=reader&bookId=xxx)
        this.isSatelliteReaderWindow = false
        this.initialSatelliteBookId = null
        try {
            if (typeof window !== 'undefined' && window.location) {
                let searchStr = window.location.search || ''
                if (!searchStr && window.location.hash && window.location.hash.indexOf('?') !== -1) {
                    searchStr = window.location.hash.substring(window.location.hash.indexOf('?'))
                }
                if (searchStr) {
                    const params = new URLSearchParams(searchStr)
                    const wMode = params.get('windowMode')
                    const bId = params.get('bookId')
                    if (wMode === 'reader' && bId) {
                        this.isSatelliteReaderWindow = true
                        this.initialSatelliteBookId = bId
                        if (typeof document !== 'undefined') {
                            document.documentElement.classList.add('satellite-reader-window')
                        }
                    }
                }
            }
        } catch (e) {}

        // Cross-window live bookshelf & reader synchronization bus
        this._crossWindowSyncBus = null
        this._crossWindowRefreshTimer = null
        if (typeof BroadcastChannel !== 'undefined') {
            try {
                this._crossWindowSyncBus = new BroadcastChannel('linden-sync-bus')
                this._crossWindowSyncBus.onmessage = (event) => {
                    const msg = event?.data
                    if (!msg) return
                    if (this.isSatelliteReaderWindow) {
                        if (
                            msg.type === 'NAVIGATE_BOOK_LOCATION' &&
                            msg.bookId &&
                            String(msg.bookId) === String(this.initialSatelliteBookId || this.currentBookId) &&
                            msg.location != null
                        ) {
                            this.navigateReaderToLocation(msg.location)
                        }
                        return
                    }
                    if (msg.type === 'BOOK_PROGRESS_UPDATED' || msg.type === 'READING_STATS_UPDATED') {
                        db.invalidateReadingStatsCache()
                        if (!this._activeSession) {
                            if (msg.bookId) {
                                this.bookshelf.updateBookCardLocally(msg.bookId, msg)
                            }
                            clearTimeout(this._crossWindowRefreshTimer)
                            this._crossWindowRefreshTimer = setTimeout(() => {
                                this.bookshelf.refreshBookshelf().catch(() => {})
                            }, 1200)
                        }
                    }
                }
            } catch (e) {}
        }

        // Unified Theme Decision Chain ('system' default for new users, 'manual' if user explicitly picked)
        let themeMode = 'system'
        let savedManualTheme = null
        try {
            themeMode = localStorage.getItem('linden_leaf_theme_mode') || 'system'
            savedManualTheme = localStorage.getItem('linden_leaf_theme')
        } catch (e) {}

        const isSystemDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        let initialTheme = 'light'
        if (themeMode === 'manual' && savedManualTheme) {
            initialTheme = savedManualTheme
        } else {
            themeMode = 'system'
            initialTheme = isSystemDark ? 'black' : 'light'
        }
        // Desktop keeps an explicit reading palette; Android retains system appearance.
        if (!platformBridge.isAndroid) {
            themeMode = 'manual'
            initialTheme = savedManualTheme && savedManualTheme !== 'system' ? savedManualTheme : initialTheme
            try { localStorage.setItem('linden_leaf_theme_mode', 'manual') } catch (_) {}
        }
        this.themeMode = themeMode
        this.themeGeneration = 1

        if (typeof window !== 'undefined' && window.matchMedia) {
            this._sysDarkQuery = window.matchMedia('(prefers-color-scheme: dark)')
            this.rootEvents.on(this._sysDarkQuery, 'change', () => {
                if (this.themeMode === 'system') {
                    this.appearance.applyTheme('system', false)
                }
            })
        }

        const startupEnv = detectReaderViewportEnv({
            isAndroid: Boolean(platformBridge?.isAndroid),
            isMobile: (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid) || (typeof window !== 'undefined' && window.innerWidth < 768),
            viewportWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
        })
        this.settings = {
            ...getDefaultReaderSettings(startupEnv),
            theme: initialTheme,
            realisticPen: true,
            fullscreenAutohide: false,
            shelfViewMode: 'shelf',
            enableReadingGoals: false,
            readingGoalYear: 12,
            readingGoalMonth: 20,
            readingGoalToday: 45,
            searchEngine: 'baidu',
            searchCustomUrl: '',
            pageTurnMode: startupEnv.isMobile ? 'slide' : 'none',
            pdfPageAppearance: 'auto'
        }
        this.globalSettings = structuredClone(this.settings)

        // Import Queue Integration
        this.importQueue = importQueue

        this._foliatePageIndex = 0

        this.initDOM()

        this.dictionaryService = dictionaryService
        this.dictionaryService.app = this
        this.advancedSettings = { config: {} }
        this.aiSidebar = null
        this.chapterTranslationManager = null
        this.navHistory = new ReaderLocationHistory(this)

        // Unified Page Turn Controller
        const isMobileDevice = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
        if (this.settings.pageTurnMode === 'curl') {
            this.settings.pageTurnMode = normalizeAppPageTurnMode('curl', isMobileDevice)
        }
        this.pageTurnController = new PageTurnController({
            container: this.dom.readerContentArea,
            mode: isMobileDevice ? (this.settings.pageTurnMode || 'slide') : 'none',
            onCurlUnavailable: () => this.dialogs.showToast(t('app.pageCurlUnavailable'), 'warning'),
            isBlockedCallback: () => Boolean(
                this.drawing.pdfDrawTool ||
                this.pdfViewport?.ownsTouchGesture() ||
                window.mobileShell?.activeSheet ||
                (this.annotations.activeDrawer && this.annotations.activeDrawer !== 'none') ||
                (this.annotations.dom.selectionPopup && this.annotations.dom.selectionPopup.style.display !== 'none')
            )
        })

        this.bindEvents()
        this._unsubscribeLocaleChange = onLocaleChange((locale) => {
            this.handleLocaleChanged(locale)
        })
        initLocale({ applyDom: true, subscribe: true })
        if (!this.isSatelliteReaderWindow) {
            this._updateWindowTitle()
        }
        
        this.search.clearSearchState(true)
        try {
            const initialPdfStoreMb = parseInt(localStorage.getItem('linden_pdf_store_mb') || '256', 10) || 256
            try { setMuPdfStoreLimit?.(initialPdfStoreMb) } catch (e) {}
            window.__TAURI__?.core?.invoke?.('mupdf_set_store_limit', { maxMb: initialPdfStoreMb }).catch(() => {})
        } catch (e) {}

        this.rootEvents.on(document.getElementById('btn-cancel-chapter-trans'), 'click', () => {
            this.chapterTranslationManager?.closeConfirmModal?.()
        })
        this.rootEvents.on(document.getElementById('btn-chapter-trans-close'), 'click', () => {
            this.chapterTranslationManager?.hideBilingualBar?.()
        })
        this.appearance.initBookOverrideUI()
        // Window close flush listener is bound once in bindEvents() via platformBridge.onFlushBeforeQuit()

        this.checkFirstTimeUser()
        platformBridge.syncSystemInsets?.().catch?.(() => {})
        this.rootEvents.on(window, 'focus', () => {
            platformBridge.syncSystemInsets?.().catch?.(() => {})
            this.imports.debouncedRescanLinkedRoots?.()
        })
        const syncReaderLayoutOnResize = () => {
            platformBridge.syncSystemInsets?.().catch?.(() => {})
            if (this.currentBookFormat && this.currentBookFormat !== 'pdf' && this.foliateView) {
                clearTimeout(this._resizeAppearanceTimer)
                this._resizeAppearanceTimer = setTimeout(() => {
                    if (this.currentBookFormat && this.currentBookFormat !== 'pdf' && this.foliateView) {
                        this.appearance.updateSettingsUI()
                        this.appearance.applySettingsToReader()
                    }
                }, 80)
            }
        }
        this.rootEvents.on(window, 'resize', syncReaderLayoutOnResize)
        this.rootEvents.on(window, 'orientationchange', syncReaderLayoutOnResize)

        const fallbackProcessOrigin = (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin))
            ? Math.round(performance.timeOrigin)
            : Date.now()
        this.bootStageTimings = {
            processStartEpochMs: fallbackProcessOrigin,
            webviewReady: Date.now(),
            entry: Date.now()
        }
        const initialBudget = platformBridge.setResourceBudget()
        this.importQueue.setResourceBudget(initialBudget)
        fullTextSearchEngine?.setResourceBudget?.(initialBudget)
        const bootContextPromise = Promise.resolve().then(() => platformBridge.getBootContext?.()).catch(() => null)
        this.loadSettings().then(async () => {
            if (this.themeMode === 'system') {
                const isDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
                this.settings.theme = isDark ? 'black' : 'light'
            }
            this.appearance.applyTheme(this.settings.theme, false)
            const bootCtx = (await bootContextPromise) || null
            if (bootCtx?.processStartEpochMs) {
                this.bootStageTimings.processStartEpochMs = bootCtx.processStartEpochMs
                this.bootStageTimings.bootId = bootCtx.bootId
                this.bootStageTimings.launchMode = bootCtx.launchMode
            }
            if (bootCtx?.launchMode === 'external-file' || bootCtx?.pendingFiles?.length || this.isSatelliteReaderWindow || this._hasPendingExternalFileLaunch) {
                this.publishStartupView('reader')
            }
            await this.ensureRecoveryBarrier()
            this.markBootStage('dbReady')
            this.bootStageTimings['DB-ready'] = this.bootStageTimings.dbReady

            const isExternalFileColdStart = Boolean(
                bootCtx?.launchMode === 'external-file' ||
                (Array.isArray(bootCtx?.pendingFiles) && bootCtx.pendingFiles.length > 0) ||
                this._hasPendingExternalFileLaunch
            )

            if (isExternalFileColdStart) {
                if (this.bootStageTimings) {
                    this.bootStageTimings.launchMode = 'external-file'
                }
                window.mobileShell?.beginReaderSessionLoading?.()
                if (this.dom.bookshelfView) {
                    this.dom.bookshelfView.style.display = 'none'
                }
                if (this.dom.readerView) {
                    this.dom.readerView.style.display = 'flex'
                    this.dom.readerView.classList.add('active')
                }
            } else if (this.isSatelliteReaderWindow && this.initialSatelliteBookId) {
                if (this.dom.bookshelfView) {
                    this.dom.bookshelfView.style.display = 'none'
                }
                if (this.dom.readerView) {
                    this.dom.readerView.style.display = 'flex'
                    this.dom.readerView.classList.add('active')
                }
                setTimeout(async () => {
                    try {
                        await customFontManager.init(this.settings.font)
                        await this.appearance.renderCustomFontsUI()
                    } catch (e) {}
                    try {
                        this.appearance.renderReadingPresetsUI()
                    } catch (e) {}
                    ensureAdvancedSettingsLoaded(this).catch(() => {})
                    ensureAiSidebarLoaded(this).catch(() => {})
                    ensureChapterTranslationLoaded(this).catch(() => {})
                }, 0)
                let pendingLoc = null
                try {
                    const pendingKey = `linden_pending_nav_${this.initialSatelliteBookId}`
                    const rawPending = localStorage.getItem(pendingKey)
                    if (rawPending) {
                        localStorage.removeItem(pendingKey)
                        const parsed = JSON.parse(rawPending)
                        if (parsed && (!parsed.ts || Date.now() - parsed.ts < 60000)) {
                            pendingLoc = (parsed.location != null) ? parsed.location : null
                        }
                    }
                } catch (_) {}
                await this.openBook(this.initialSatelliteBookId, pendingLoc, { forceInPlace: true })
            } else {
                await this.bookshelf.renderCustomListsSidebar()
                // R9: Render bookshelf immediately without waiting for font binaries
                await this.bookshelf.refreshBookshelf()
                if (!this._bootStagesSealed && !this.currentBookId && !isExternalFileColdStart && !this.isSatelliteReaderWindow) {
                    this.markBootStage?.('shelfReady')
                }

                // Non-blocking deferred loading of custom fonts, presets, and non-critical services
                setTimeout(async () => {
                    try {
                        await ensureAdvancedSettingsLoaded(this)
                        await ensureAiSidebarLoaded(this)
                        await ensureChapterTranslationLoaded(this)
                    } catch (_) {}
                    try {
                        await customFontManager.init(this.settings.font)
                        await this.appearance.renderCustomFontsUI()
                    } catch (e) {
                        console.warn('[App] Custom fonts init error:', e)
                    }
                    try {
                        this.appearance.renderReadingPresetsUI()
                    } catch (e) {
                        console.warn('[App] Presets UI error:', e)
                    }
                    await this.sync.initSyncService()
                }, 0)
            }
            this.setupAndroidNavigationAndImports()
            // An external-file event may have opened a reader while startup awaited DB work.
            if (document.documentElement.dataset.startupView === 'pending') {
                this.publishStartupView(this.currentBookId || isExternalFileColdStart || this.isSatelliteReaderWindow ? 'reader' : 'shelf')
            }
        }).catch(err => {
            console.error('[App] Critical startup error:', err)
            document.documentElement.dataset.startupView = 'error'
            const label = document.getElementById('startup-loading-label')
            if (label) label.textContent = t('app.startupOpenFailed')
            const retry = document.getElementById('startup-retry')
            if (retry) retry.hidden = false
        })
     }

    publishStartupView(destination) {
        if (destination === 'reader') {
            if (this.dom.bookshelfView) this.dom.bookshelfView.style.display = 'none'
            if (this.dom.readerView) {
                this.dom.readerView.style.display = 'flex'
                this.dom.readerView.classList.add('active')
            }
        } else {
            if (this.dom.readerView) this.dom.readerView.style.display = 'none'
            const isMobileNonShelfActive = Boolean(
                (this.isMobileLayout?.() || document.documentElement?.classList?.contains?.('is-mobile-viewport')) &&
                window.mobileShell &&
                window.mobileShell.currentTab !== 'shelf' &&
                !document.body?.classList?.contains?.('mobile-subview-active')
            )
            if (this.dom.bookshelfView) {
                this.dom.bookshelfView.style.display = isMobileNonShelfActive ? 'none' : 'flex'
            }
        }
        document.documentElement.dataset.startupView = 'ready'
    }

    reportInitialPdfFrame(readerSession, viewport, page, canvas) {
        if (this._firstReadableFrameReported || this._bootStagesSealed || !readerSession?.isCurrent() || page !== viewport?._initialTargetPage) return
        this._initialFrameCleanup?.()
        let observer = null
        let rafId = 0
        const signal = readerSession.abortController?.signal
        const cleanup = () => {
            if (rafId) {
                cancelAnimationFrame(rafId)
                rafId = 0
            }
            observer?.disconnect()
            signal?.removeEventListener('abort', cleanup)
            if (this._initialFrameCleanup === cleanup) this._initialFrameCleanup = null
        }
        this._initialFrameCleanup = cleanup
        const record = () => {
            rafId = 0
            if (this._firstReadableFrameReported || this._bootStagesSealed || !readerSession.isCurrent() || !canvas?.isConnected || !viewport.container.contains(canvas)) { cleanup(); return }
            const rect = canvas.getBoundingClientRect()
            const view = viewport.scrollArea.getBoundingClientRect()
            const style = getComputedStyle(canvas)
            if (style.visibility === 'hidden' || style.display === 'none' || !rect.width || !rect.height || rect.right <= view.left || rect.left >= view.right || rect.bottom <= view.top || rect.top >= view.bottom) return
            this._firstReadableFrameReported = true
            this.markBootStage?.('firstReadableFrame')
            cleanup()
        }
        signal?.addEventListener('abort', cleanup, { once:true })
        if (typeof IntersectionObserver === 'function') {
            observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) rafId = requestAnimationFrame(record) }, { root:viewport.scrollArea })
            observer.observe(canvas)
        }
        rafId = requestAnimationFrame(record)
    }

    reportInitialFoliateFrame(readerSession, sessionView) {
        if (this._firstReadableFrameReported || this._bootStagesSealed || !readerSession?.isCurrent() || !sessionView) return
        this._initialFrameCleanup?.()
        let observer = null
        let rafOuter = 0
        let rafInner = 0
        let scheduled = false
        let settled = false
        const signal = readerSession.abortController?.signal

        const cancelFrames = () => {
            if (rafOuter) { cancelAnimationFrame(rafOuter); rafOuter = 0 }
            if (rafInner) { cancelAnimationFrame(rafInner); rafInner = 0 }
            scheduled = false
        }
        const cleanup = () => {
            settled = true
            cancelFrames()
            observer?.disconnect()
            observer = null
            sessionView.removeEventListener('load', scheduleCheck)
            sessionView.removeEventListener('relocate', scheduleCheck)
            signal?.removeEventListener('abort', cleanup)
            if (this._initialFrameCleanup === cleanup) this._initialFrameCleanup = null
        }
        this._initialFrameCleanup = cleanup

        const findVisibleRenderedContent = () => {
            if (!sessionView.isConnected) return null
            const viewRect = sessionView.getBoundingClientRect()
            if (!viewRect.width || !viewRect.height) return null
            const viewStyle = getComputedStyle(sessionView)
            if (viewStyle.visibility === 'hidden' || viewStyle.display === 'none') return null
            const contents = sessionView.renderer?.getContents?.() || []
            for (const item of contents) {
                const doc = item?.doc
                if (!doc?.documentElement || !doc?.body) continue
                const contentWin = doc.defaultView
                const frame = contentWin?.frameElement || null
                const targetBox = frame || sessionView
                if (!targetBox.isConnected || (frame && !isComposedDescendant(sessionView, frame))) continue
                const rect = targetBox.getBoundingClientRect()
                const style = getComputedStyle(targetBox)
                if (style.visibility === 'hidden' || style.display === 'none') continue
                if (!rect.width || !rect.height) continue
                if (rect.right <= viewRect.left || rect.left >= viewRect.right || rect.bottom <= viewRect.top || rect.top >= viewRect.bottom) continue
                const hasText = (doc.body.innerText || doc.body.textContent || '').trim().length > 0
                const hasMedia = Boolean(doc.body.querySelector?.('img, svg, canvas, video, math'))
                const hasLaidOutChildren = (doc.body.children?.length || 0) > 0 && (doc.documentElement.scrollWidth || 0) > 0
                if (hasText || hasMedia || hasLaidOutChildren) {
                    return { doc, contentWin, frame: targetBox }
                }
            }
            return null
        }

        const commitAfterSecondPaint = () => {
            rafInner = 0
            if (settled || this._firstReadableFrameReported || this._bootStagesSealed || !readerSession.isCurrent()) {
                cleanup()
                return
            }
            const visible = findVisibleRenderedContent()
            if (!visible) {
                scheduled = false
                return
            }
            this._firstReadableFrameReported = true
            this.markBootStage?.('firstReadableFrame')
            cleanup()
        }

        const scheduleCheck = () => {
            if (settled || scheduled || this._firstReadableFrameReported || this._bootStagesSealed || !readerSession.isCurrent()) {
                if (this._firstReadableFrameReported || this._bootStagesSealed || !readerSession.isCurrent()) cleanup()
                return
            }
            const visible = findVisibleRenderedContent()
            if (!visible) return
            scheduled = true
            const rafHost = (typeof visible.contentWin?.requestAnimationFrame === 'function') ? visible.contentWin : window
            rafOuter = rafHost.requestAnimationFrame(() => {
                rafOuter = 0
                if (settled || this._firstReadableFrameReported || this._bootStagesSealed || !readerSession.isCurrent()) {
                    cleanup()
                    return
                }
                rafInner = requestAnimationFrame(commitAfterSecondPaint)
            })
        }

        signal?.addEventListener('abort', cleanup, { once: true })
        sessionView.addEventListener('load', scheduleCheck)
        sessionView.addEventListener('relocate', scheduleCheck)
        if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(() => scheduleCheck())
            observer.observe(sessionView)
        }
        scheduleCheck()
    }

    markBootStage(stageName, explicitEpochMs = null) {
        if (!this.bootStageTimings) this.bootStageTimings = {}
        const isColdBootStage = ['entry', 'webviewReady', 'dbReady', 'stage', 'driverOpen', 'firstReadableFrame', 'shelfReady'].includes(stageName)
        if (isColdBootStage && this._bootStagesSealed) {
            return this.bootStageTimings[stageName] ?? null
        }
        const nowEpoch = explicitEpochMs != null ? Number(explicitEpochMs) : Date.now()
        const nowRel = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? Number(performance.now().toFixed(3))
            : nowEpoch
        this.bootStageTimings[stageName] = nowEpoch
        if (!this.bootStageRelativeTimings) this.bootStageRelativeTimings = {}
        this.bootStageRelativeTimings[stageName] = nowRel
        if (stageName === 'firstReadableFrame' || stageName === 'shelfReady') {
            this._bootStagesSealed = true
            if (platformBridge?.isTauri && typeof platformBridge.writeBootMetrics === 'function') {
                Promise.resolve().then(() => platformBridge.writeBootMetrics(this.exportBootSessionLogs())).catch(() => {})
            }
        }
        return nowEpoch
    }

    exportBootSessionLogs() {
        return {
            bootId: this.bootStageTimings?.bootId || null,
            launchMode: this.bootStageTimings?.launchMode || 'shelf',
            bootStageTimings: { ...(this.bootStageTimings || {}) },
            bootStageRelativeTimings: { ...(this.bootStageRelativeTimings || {}) }
        }
    }

    setThemeMode(mode) {
        this.themeMode = mode === 'manual' || !platformBridge.isAndroid ? 'manual' : 'system'
        try { localStorage.setItem('linden_leaf_theme_mode', this.themeMode) } catch (e) {}
        if (this.themeMode === 'system') {
            const isDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
            const targetTheme = isDark ? 'black' : 'light'
            this.appearance.applyTheme(targetTheme, false)
        }
    }

    async importFilesAndWait(files) {
        if (!files || files.length === 0) return []
        const isReaderOpen = this.dom.readerView && this.dom.readerView.style.display !== 'none'
        if (!isReaderOpen) {
            this.imports.showImportPanel()
        } else {
            this.imports.minimizeImportPanel()
        }
        return await this.importQueue.enqueueAndWait(files)
    }

    async saveProgressNonTerminating() {
        const activeSession = this._activeSession
        const activeBookId = this.currentBookId || activeSession?.bookId
        const activeSnapshot = activeSession?.snapshot || this._currentSnapshot
        if (activeSession && activeSession.isCurrent() && activeBookId && activeSnapshot) {
            const progressSnapshot = this.makeProgressSnapshot(activeSession)
            if (progressSnapshot) {
                try {
                    await db.updateBookProgress(activeBookId, progressSnapshot)
                } catch (e) {
                    console.warn('[App] saveProgressNonTerminating updateBookProgress error:', e)
                }
            }
        }
        if (tracker.isTracking) {
            const loc = this.currentLocation
            const frac = Number.isFinite(loc?.fraction) ? loc.fraction : null
            try {
                await tracker.flush(false, frac)
            } catch (e) {
                console.warn('[App] saveProgressNonTerminating tracker.flush error:', e)
            }
        }
    }

    setupAndroidNavigationAndImports() {
        // 1. Android Back Button / System Gesture Handler with strict modal precedence
        window.__handleAndroidBackPress = () => {
    if (this.onboardingTour?.active) { this.onboardingTour.skip(); return true }
    const visible = element => element && !element.hidden && getComputedStyle(element).display !== 'none'
    const globalDialogs = [...document.querySelectorAll('.global-modal-backdrop.show')].filter(visible)
    if (globalDialogs.length) {
        const top = globalDialogs.map((element, order) => ({ element, order, z: Number(getComputedStyle(element).zIndex) || 0 }))
            .sort((a, b) => a.z - b.z || a.order - b.order).at(-1).element
        const close = top.id === 'global-modal-backdrop' ? this.dialogs.dom.globalModalCancel
            : top.id === 'welcome-modal-backdrop' ? document.getElementById('btn-welcome-skip')
            : top.id === 'locale-onboarding-backdrop' ? (top.querySelector('.locale-choice-card.recommended') || document.getElementById('btn-locale-choice-zh'))
            : top.querySelector('[id="btn-cancel-chapter-trans-modal"], .footnote-popup-close, .modal-close')
        close?.click()
        return true
    }
    const routes = [
        ['modal-book-details', () => this.closeBookDetailsModal()],
        ['modal-webdav-sync', () => this.sync.closeWebdavSyncModal()],
        ['modal-stats-detail', () => this.stats.closeStatsDetailModal()],
        ['quote-card-backdrop', () => this.cards.closeQuoteCardModal()],
        ['modal-pdf-ocr', () => this.pdfTools.closePdfOcrModal()],
        ['modal-ai-assistant', () => this.cards.closeAiAssistantModal()],
        ['modal-batch-add-to-list', () => this.bookshelf.closeBatchAddToListModal()],
        ['modal-manage-book-lists', () => this.bookshelf.closeManageBookListsModal()],
        ['modal-create-list', () => this.bookshelf.closeCreateListModal()],
        ['modal-update-dialog', () => this.updates.closeUpdateModal()],
    ]
    const open = routes.map(([id, close], order) => ({ element: document.getElementById(id), close, order }))
        .filter(item => visible(item.element) && (!item.element.classList.contains('global-modal-backdrop') || item.element.classList.contains('show')))
        .map(item => ({ ...item, z: Number(getComputedStyle(item.element).zIndex) || 0 }))
        .sort((a, b) => a.z - b.z || a.order - b.order)
    if (open.length) { open.at(-1).close(); return true }
    const shell = window.mobileShell
    if (shell && (shell.isNowPlayingOpen || shell.activeSheet || document.body.classList.contains('mobile-settings-active'))) {
        return shell.handleBackPress()
    }
    const popupEl = this.annotations.dom.selectionPopup
    const highlightPopupEl = this.annotations.dom.highlightActionPopup
    const dictCardEl = this.cards.dom.readerDictionaryCard
    const paraCardEl = this.cards.dom.readerParaTranslationCard
    const footnotePopupEl = document.getElementById('footnote-popup')
    const hasReaderPopup = Boolean(
        popupEl?.classList.contains('active') || visible(popupEl) ||
        highlightPopupEl?.classList.contains('active') || visible(highlightPopupEl) ||
        dictCardEl?.classList.contains('active') || visible(dictCardEl) ||
        paraCardEl?.classList.contains('active') || visible(paraCardEl) ||
        visible(footnotePopupEl)
    )
    if (hasReaderPopup) {
        this.annotations.hideSelectionPopup()
        this.annotations.hideHighlightActionPopup()
        this.cards.hideDictionaryCard?.()
        this.cards.hideParaTranslationCard?.()
        this.cards.hideFootnotePopup?.()
        this.pdfViewport?.clearSelection?.()
        return true
    }
    if (this.aiSidebar?.isOpen) { this.aiSidebar.close(); return true }
    const drawer = document.getElementById('sidebar-drawer')
    if ((this.annotations.activeDrawer && this.annotations.activeDrawer !== 'none') || drawer?.classList.contains('open')) {
        this.annotations.closeDrawer()
        return true
    }
    const remaining = [...document.querySelectorAll('.modal.show, .modal-overlay.show, .modal-backdrop.show, .ai-modal.show, .dialog-overlay.active')]
        .filter(visible)
    if (remaining.length) {
        const top = remaining.at(-1)
        top.querySelector('[data-modal-dismiss], .btn-cancel, .modal-close, .ai-modal-close, button[data-i18n-aria="common.close"], button[data-i18n-title="common.close"], button[aria-label="Close"], button[title="Close"], button[aria-label="\u5173\u95ed"], button[title="\u5173\u95ed"]')?.click()
        return true
    }
    if (shell?.settingsPage?.back?.()) return true
    if (shell && (shell.currentTab === 'search' || document.body.classList.contains('mobile-subview-active') || document.querySelector('.ai-history-split-pane.show-detail'))) {
        if (shell.handleBackPress()) return true
    }
    if (shell?.readerToolsVisible) {
        shell.setReaderToolsVisible(false)
        return true
    }
    const reader = document.getElementById('reader-view')
    if (reader?.classList.contains('active')) { this.closeReader(); return true }
    if (shell?.handleBackPress()) return true
    return false

        }

        // 2. Mobile Bookshelf Sidebar backdrop dismiss
        document.getElementById('leaf-sidebar-backdrop')?.addEventListener('click', () => {
            document.getElementById('bookshelf-view')?.classList.add('sidebar-collapsed')
        })

        // 3. Process Pending Android Imports (via intent / file association)
        this.checkPendingAndroidImports()
        window.addEventListener('focus', () => this.checkPendingAndroidImports())
        window.addEventListener('pendingimportready', () => this.checkPendingAndroidImports())
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.checkPendingAndroidImports()
            } else if (document.visibilityState === 'hidden') {
                this.saveProgressNonTerminating()
            }
        })
        window.addEventListener('pagehide', () => {
            this.saveProgressNonTerminating()
        })
    }

    async checkPendingAndroidImports() {
        if (!platformBridge.isAndroid && platformBridge.getOS?.() !== 'android') return
        if (this._isCheckingPendingImports) return
        this._isCheckingPendingImports = true
        if (!this._processingPendingImportIds) {
            this._processingPendingImportIds = new Set()
        }
        try {
            const pending = await platformBridge.getPendingImports()
            if (Array.isArray(pending) && pending.length > 0) {
                console.log(`[Android Import] Processing ${pending.length} pending imports`)
                for (const item of pending) {
                    if (!item || !item.id || this._processingPendingImportIds.has(item.id)) {
                        continue
                    }
                    this._processingPendingImportIds.add(item.id)
                    try {
                        const fileObj = {
                            filePath: item.filePath || item.uri,
                            filename: item.filename,
                            name: item.filename,
                            size: 0
                        }
                        this.dialogs.showToast(t('app.importingFile', { filename: item.filename }), 'info')
                        const results = await this.importFilesAndWait([fileObj])
                        const job = results?.[0]
                        if (job && job.status === 'succeeded') {
                            await platformBridge.consumePendingImport(item.id)
                            this.dialogs.showToast(t('app.importSuccess', { filename: item.filename }), 'success')
                        } else {
                            console.warn(`[Android Import] Job for ${item.filename} status: ${job?.status}, deferring consume`, job?.error)
                        }
                    } catch (err) {
                        console.error(`[Android Import] Error importing ${item.filename}:`, err)
                    } finally {
                        this._processingPendingImportIds.delete(item.id)
                    }
                }
            }
        } catch (e) {
            console.warn('[Android Import] Failed to check pending imports:', e)
        } finally {
            this._isCheckingPendingImports = false
        }
    }

    get currentPdfPageIndex() {
        return this.pdfViewport?.currentPage ?? this._foliatePageIndex
    }

    get currentBook() {
        return this.currentBookData
    }

    async ensureRecoveryBarrier() {
        if (!this._recoveryBarrierPromise) {
            this._recoveryBarrierPromise = (async () => {
                let progressResult = null
                let trackerResult = null
                try {
                    if (typeof db.recoverPendingRestoreOperations === 'function') {
                        await db.recoverPendingRestoreOperations()
                    }
                } catch (e) {
                    console.warn('[App] Error recovering pending restore operations:', e)
                    this.dialogs.showToast?.(t('app.recoveryPending', { error: e.message }), 'warning')
                    throw e
                }
                try {
                    progressResult = await db.recoverPendingProgressBackup()
                } catch (e) {
                    console.warn('[App] Error recovering progress backup:', e)
                    progressResult = { recovered: [], filtered: [], failed: [{ error: e }], deferred: [] }
                }
                try {
                    trackerResult = await tracker.recoverPendingBackup()
                } catch (e) {
                    console.warn('[App] Error recovering tracker backup:', e)
                    trackerResult = { recovered: [], filtered: [], failed: [{ error: e }], deferred: [] }
                }
                if (!this.isSatelliteReaderWindow) {
                    try {
                        await db.recoverInterruptedAiMessages()
                    } catch (e) {
                        console.warn('[App] Error recovering interrupted AI messages:', e)
                    }
                }
                const failedProgressBooks = new Set((progressResult?.failed || []).map(f => f.bookId || f.data?.bookId).filter(Boolean))
                return {
                    progress: progressResult,
                    tracker: trackerResult,
                    hasFailed: (progressResult?.failed?.length > 0) || (trackerResult?.failed?.length > 0),
                    failedProgressBooks,
                    canProceedSafely: (bookId) => {
                        if (!bookId) return true
                        return !failedProgressBooks.has(bookId)
                    }
                }
            })()
        }
        return this._recoveryBarrierPromise
    }

    initDOM() {
        this.dom = {
            readerBookTitle: document.getElementById('reader-book-title'),
            bookshelfView: document.getElementById('bookshelf-view'),
            readerView: document.getElementById('reader-view'),
            readerContentArea: document.getElementById('reader-content-area'),
            bookContainer: document.getElementById('reader-content-area'),
            heroKpiTodayTime: document.getElementById('hero-kpi-today-time'),
            heroKpiStreak: document.getElementById('hero-kpi-streak'),
            heroKpiFinished: document.getElementById('hero-kpi-finished'),
            readerTopBar: document.getElementById('reader-top-bar'),
            readerBottomBar: document.getElementById('reader-bottom-bar'),
            readerPageNumber: document.getElementById('reader-page-number'),
            readerLiveTimer: document.getElementById('reader-live-timer'),
            readerEtaBadge: document.getElementById('reader-eta-badge'),
            btnBackToShelf: document.getElementById('btn-back-to-shelf'),
            btnAddToShelf: document.getElementById('btn-add-to-shelf'),
            btnNavHistoryBack: document.getElementById('btn-nav-history-back'),
            btnNavHistoryForward: document.getElementById('btn-nav-history-forward'),
            btnTogglePinWindow: document.getElementById('btn-toggle-pin-window'),
            btnShelfSettings: document.getElementById('btn-shelf-settings'),
            btnNavLeft: document.getElementById('btn-nav-left'),
            btnNavRight: document.getElementById('btn-nav-right'),
            btnToggleTts: document.getElementById('btn-toggle-tts'),
            btnChapterTranslate: document.getElementById('btn-chapter-translate'),
            btnToggleFullscreen: document.getElementById('btn-toggle-fullscreen'),
            ttsPlayerBar: document.getElementById('tts-player-bar'),
            btnTtsPrev: document.getElementById('btn-tts-prev'),
            btnTtsTogglePlay: document.getElementById('btn-tts-toggle-play'),
            btnTtsNext: document.getElementById('btn-tts-next'),
            iconTtsPlay: document.getElementById('icon-tts-play'),
            iconTtsPause: document.getElementById('icon-tts-pause'),
            selectTtsRate: document.getElementById('select-tts-rate'),
            selectTtsVoice: document.getElementById('select-tts-voice'),
            btnTtsTimer: document.getElementById('btn-tts-timer'),
            labelTtsTimer: document.getElementById('label-tts-timer'),
            btnTtsClose: document.getElementById('btn-tts-close'),
            progressSlider: document.getElementById('reader-progress-slider'),
            progressText: document.getElementById('reader-progress-text'),
            localeOnboardingBackdrop: document.getElementById('locale-onboarding-backdrop'),
            welcomeModalBackdrop: document.getElementById('welcome-modal-backdrop'),
            welcomeUsernameInput: document.getElementById('welcome-username-input'),
            btnWelcomeConfirm: document.getElementById('btn-welcome-confirm'),
            btnWelcomeSkip: document.getElementById('btn-welcome-skip'),
            modalCreateListTitle: document.getElementById('modal-create-list-title'),
            rowAdvancedSettingsTrigger: document.getElementById('row-advanced-settings-trigger'),
            badgeAdvancedStatus: document.getElementById('badge-advanced-status'),
            hintAdvancedTrigger: document.getElementById('hint-advanced-trigger'),
            advancedSettingsContainer: document.getElementById('advanced-settings-container'),
            labelAiContextBudget: document.getElementById('label-ai-context-budget'),
            btnResetAdvancedSettings: document.getElementById('btn-reset-advanced-settings'),
            btnOpenAuditFromSettings: document.getElementById('btn-open-audit-from-settings'),
            btnClearAiCacheSettings: document.getElementById('btn-clear-ai-cache-settings'),
            modalAdvancedSettingsConfirm: document.getElementById('modal-advanced-settings-confirm'),
            btnCloseAdvancedConfirm: document.getElementById('btn-close-advanced-confirm'),
            btnCancelAdvancedUnlock: document.getElementById('btn-cancel-advanced-unlock'),
            btnConfirmAdvancedUnlock: document.getElementById('btn-confirm-advanced-unlock'),
            modalBookDetails: document.getElementById('modal-book-details'),
            btnCloseBookDetails: document.getElementById('btn-close-book-details'),
            bookDetailsBody: document.getElementById('book-details-body'),
            navCatOverview: document.getElementById('nav-cat-overview'),
            batchExistingTagsSection: document.getElementById('batch-existing-tags-section')
        }
        this.dialogs.initDOM()
        Object.assign(this.dom, this.dialogs.dom)
        this.stats.initDOM()
        Object.assign(this.dom, this.stats.dom)
        this.bookshelf.initDOM()
        Object.assign(this.dom, this.bookshelf.dom)
        this.imports.initDOM()
        Object.assign(this.dom, this.imports.dom)
        this.sync.initDOM()
        Object.assign(this.dom, this.sync.dom)
        this.updates.initDOM()
        Object.assign(this.dom, this.updates.dom)
        this.drawing.initDOM()
        Object.assign(this.dom, this.drawing.dom)
        this.pdfTools.initDOM()
        Object.assign(this.dom, this.pdfTools.dom)
        this.search.initDOM()
        Object.assign(this.dom, this.search.dom)
        this.annotations.initDOM()
        Object.assign(this.dom, this.annotations.dom)
        this.cards.initDOM()
        Object.assign(this.dom, this.cards.dom)
        this.appearance.initDOM()
        Object.assign(this.dom, this.appearance.dom)
    }

    getUserDisplayName() {
        const stored = (localStorage.getItem('linden_user_name') || '').trim()
        if (stored && stored !== 'Linden 读者' && stored !== '我的书架' && stored !== '读者') {
            return stored
        }
        return DEFAULT_READER_NAME
    }

    updateUserProfileDisplay() {
        const displayName = this.getUserDisplayName()
        const isCustom = displayName !== DEFAULT_READER_NAME

        const el = document.getElementById('user-display-name') || document.getElementById('sidebar-username') || document.querySelector('.sidebar-username')
        const avatarEl = document.getElementById('user-avatar-icon') || document.getElementById('sidebar-user-avatar-char') || document.querySelector('.sidebar-user-avatar')
        if (el) {
            el.innerText = displayName
            el.title = displayName
        }
        if (avatarEl) {
            avatarEl.innerText = displayName ? displayName.charAt(0).toUpperCase() : 'O'
        }
        if (window.mobileShell?.updateUserProfileDisplay) {
            window.mobileShell.updateUserProfileDisplay(displayName)
        }
        if (this.appearance.dom?.settingUserName && !this.appearance.dom.settingUserName.matches(':focus')) {
            this.appearance.dom.settingUserName.value = isCustom ? displayName : ''
        }
    }

    openWelcomeModal() {
        if (!this.dom.welcomeModalBackdrop) return
        const currentName = this.getUserDisplayName()
        if (currentName !== DEFAULT_READER_NAME) {
            localStorage.setItem('linden_user_initialized', 'true')
            return
        }
        this.dom.welcomeModalBackdrop.style.display = 'flex'
        this.dom.welcomeModalBackdrop.classList.add('show')
        if (this.dom.welcomeUsernameInput) {
            this.dom.welcomeUsernameInput.value = ''
            setTimeout(() => {
                this.dom.welcomeUsernameInput?.focus()
                this.dom.welcomeUsernameInput?.select()
            }, 100)
        }
    }

    openPreOnboardingLocaleGate() {
        const backdrop = this.dom.localeOnboardingBackdrop
        if (!backdrop) {
            this.openWelcomeModal()
            return
        }
        const preferred = detectPreferredLocale()
        backdrop.querySelectorAll('[data-locale-choice]').forEach(card => {
            card.classList.toggle('recommended', card.dataset.localeChoice === preferred)
        })
        backdrop.style.display = 'flex'
        backdrop.classList.add('show')
        setTimeout(() => {
            const preferredBtn = backdrop.querySelector(`[data-locale-choice="${preferred}"]`)
            preferredBtn?.focus?.()
        }, 80)
    }

    _updateWindowTitle(locale = getLocale()) {
        const baseTitle = t('app.windowTitle', {}, locale)
        const bookTitle = String(this.currentBookData?.title || this._currentSnapshot?.title || '').trim()
        if (!bookTitle) {
            if (this.isSatelliteReaderWindow) return
            platformBridge.setWindowTitle(baseTitle).catch(() => {})
            return
        }
        const isEn = String(locale || '').toLowerCase().startsWith('en')
        const formatted = isEn
            ? `${bookTitle} - ${baseTitle}`
            : `\u300a${bookTitle}\u300b - ${baseTitle}`
        platformBridge.setWindowTitle(formatted).catch(() => {})
    }

    handleLocaleChanged(newLocale) {
        this._updateWindowTitle(newLocale)
        try { window.electronAPI?.setLocale?.(newLocale) } catch (_) {}
        try { this.updateUserProfileDisplay?.() } catch (_) {}
        try { this._populateStoragePaths?.() } catch (_) {}
        try { this.refreshTtsVoiceOptions?.() } catch (_) {}
        try { this._refreshReaderLocaleLabels?.() } catch (_) {}
        try { this.bookshelf?.refreshLocale?.() } catch (_) {}
        try { this.stats?.refreshLocale?.() } catch (_) {}
        try { this.annotations?.refreshLocale?.() } catch (_) {}
        try { this.appearance?.refreshLocale?.() } catch (_) {}
        try { this.sync?.refreshLocale?.() } catch (_) {}
        try { this.updates?.refreshLocale?.() } catch (_) {}
        try { this.imports?.refreshLocale?.() } catch (_) {}
        try { this.search?.refreshLocale?.() } catch (_) {}
        try { this.pdfTools?.refreshLocale?.() } catch (_) {}
        try { this.aiSidebar?.refreshLocale?.() } catch (_) {}
        try { this.chapterTranslationManager?.refreshLocale?.() } catch (_) {}
        try { this.onboardingTour?.refreshLocale?.() } catch (_) {}
        try { window.advancedSettings?.renderUIState?.() } catch (_) {}
        try { window.mobileShell?.refreshLocale?.() } catch (_) {}
    }

    _setReaderPageLabel(state) {
        this._lastPageLabelState = state
        if (!this.dom?.readerPageNumber || !state) return
        if (state.kind === 'pdf') {
            this.dom.readerPageNumber.innerText = t('app.pageOfTotal', { page: state.page, total: state.total })
            this.dom.readerPageNumber.title = t('app.pageJumpTooltip', { total: state.total })
        } else if (state.kind === 'bookTotal') {
            this.dom.readerPageNumber.innerText = t('app.bookPageOfTotal', { cur: state.cur, tot: state.tot })
            const chPage = (state.secPage != null && state.secTotal != null)
                ? t('app.chapterSectionPagesSuffix', { page: state.secPage, total: state.secTotal })
                : ''
            const tocTitle = state.tocLabel
                ? (getLocale() === 'zh-CN' ? `\u3010${state.tocLabel}\u3011` : `[${state.tocLabel}] `)
                : ''
            this.dom.readerPageNumber.title = t('app.bookPageJumpTooltip', {
                toc: tocTitle,
                cur: state.cur,
                tot: state.tot,
                chPage
            })
        } else if (state.kind === 'percent') {
            this.dom.readerPageNumber.innerText = `${state.pctDisplay}%`
            this.dom.readerPageNumber.title = t('app.quickJumpTooltip')
        }
    }

    _setReaderEta(state) {
        this._lastEtaState = state
        if (!this.dom?.readerEtaBadge || !state) return
        if (state.kind === 'finishing') {
            this.dom.readerEtaBadge.innerText = t('app.etaFinishing')
        } else if (state.kind === 'unknown') {
            this.dom.readerEtaBadge.innerText = t('app.etaUnknown')
        } else if (state.kind === 'remaining') {
            this.dom.readerEtaBadge.innerText = t('app.etaRemaining', { duration: tracker.formatDuration(state.remainingSecs) })
        }
    }

    _setReaderLiveTimer(activeSecs, isIdle) {
        this._lastLiveTimerState = { activeSecs, isIdle }
        if (!this.dom?.readerLiveTimer) return
        const timeText = activeSecs < 60
            ? t('app.timerLessThanMinute')
            : t('app.timerMinutes', { minutes: Math.floor(activeSecs / 60) })
        this.dom.readerLiveTimer.innerText = isIdle
            ? t('app.timerPaused', { time: timeText })
            : t('app.timerActive', { time: timeText })
    }

    _refreshReaderLocaleLabels() {
        if (this.dom?.btnTogglePinWindow) {
            this.dom.btnTogglePinWindow.title = this._isPinnedWindow ? t('app.unpinWindowTitle') : t('app.pinWindowTitle')
        }
        if (this.dom?.btnToggleFullscreen) {
            this.dom.btnToggleFullscreen.title = this.isCurrentlyFullscreen ? t('app.exitFullscreenTitle') : t('reader.fullscreenTitle')
        }
        if (this.dom?.btnChapterTranslate && this.currentBookData?.format) {
            const safeFmt = (this.currentBookData.format || '').toLowerCase()
            const supported = ['epub', 'txt'].includes(safeFmt)
            this.dom.btnChapterTranslate.title = supported ? t('app.chapterTransSupportedTitle') : t('app.chapterTransUnsupportedTitle')
        }
        if (this.dom?.labelTtsTimer && this._ttsTimerOpt !== undefined) {
            if (this._ttsTimerOpt === 0) this.dom.labelTtsTimer.innerText = t('app.ttsTimerOffLabel')
            else if (this._ttsTimerOpt === 'end_of_chapter') this.dom.labelTtsTimer.innerText = t('app.ttsTimerChapterLabel')
            else this.dom.labelTtsTimer.innerText = `${this._ttsTimerOpt}m`
        }
        if (this.pdfTools?.dom?.btnPdfSpreadToggle && this.pdfViewport) {
            const spMode = this.pdfViewport.spreadMode
            this.pdfTools.dom.btnPdfSpreadToggle.setAttribute('title', spMode === 'dual' ? t('app.pdfSpreadSingleTitle') : t('app.pdfSpreadDualTitle'))
        }
        if (this._lastPageLabelState) this._setReaderPageLabel(this._lastPageLabelState)
        if (this._lastEtaState) this._setReaderEta(this._lastEtaState)
        if (this._lastLiveTimerState) this._setReaderLiveTimer(this._lastLiveTimerState.activeSecs, this._lastLiveTimerState.isIdle)
    }

    checkFirstTimeUser() {
        const isInit = localStorage.getItem('linden_user_initialized')
        if (window.electronAPI?.syncGetConfig && !this.sync.syncConfig) {
            window.electronAPI.syncGetConfig().then(cfg => {
                if (cfg) {
                    this.sync.syncConfig = cfg
                    this.updateUserProfileDisplay()
                }
            }).catch(() => {})
        }
        this.updateUserProfileDisplay()
        const currentName = this.getUserDisplayName()
        if (this.appearance.dom.settingUserName) {
            this.appearance.dom.settingUserName.value = currentName !== DEFAULT_READER_NAME ? currentName : ''
        }
        if (this.cards.dom.quoteUserNameInput) {
            this.cards.dom.quoteUserNameInput.value = currentName
        }
        if (!isInit) {
            if (!this.isSatelliteReaderWindow && shouldShowPreOnboardingLocaleGate() && this.dom.localeOnboardingBackdrop) {
                this.openPreOnboardingLocaleGate()
                return
            }
            if (!this.isSatelliteReaderWindow && this.dom.welcomeModalBackdrop) {
                this.openWelcomeModal()
            }
        }
    }

    showToast(...args) { return this.dialogs.showToast(...args) }

    showInputDialog(...args) { return this.dialogs.showInputDialog(...args) }

    showConfirmDialog(...args) { return this.dialogs.showConfirmDialog(...args) }

    async loadSettings() {
        const initialTheme = this.settings.theme
        const saved = await db.getSetting('readerSettings')
        const env = detectReaderViewportEnv({
            isAndroid: Boolean(platformBridge?.isAndroid),
            isMobile: (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid) || (typeof window !== 'undefined' && window.innerWidth < 768),
            viewportWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
        })
        const { settings: migratedSettings, migrated } = migrateLegacyReaderSettings(saved, env)
        if (saved) {
            const migratedPreserve = resolveLegacyPreserveOriginalStyles(saved, false)
            this.globalSettings = {
                ...this.globalSettings,
                ...migratedSettings,
                preserveOriginalStyles: migratedPreserve
            }
        } else {
            this.globalSettings = {
                ...this.globalSettings,
                ...migratedSettings
            }
        }
        this.settings = resolveReaderSettings(this.globalSettings, this.appearance._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
        if (migrated) db.setSetting('readerSettings', this.globalSettings).catch(() => {})
        if (!platformBridge.isAndroid && this.settings.theme === 'system') {
            this.setSetting('theme', initialTheme)
        }
        // Always default to Modern Hero Grid on application startup
        this.bookshelf.shelfViewMode = 'grid'
        try {
            if (this.settings.theme) localStorage.setItem('linden_leaf_theme', this.settings.theme)
            localStorage.setItem('linden_leaf_view_mode', 'grid')
        } catch (e) {}
        const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
        if (this.settings.pageTurnMode === 'curl') {
            this.settings.pageTurnMode = normalizeAppPageTurnMode('curl', isMobile)
            if (this.globalSettings?.pageTurnMode === 'curl') {
                this.globalSettings.pageTurnMode = this.settings.pageTurnMode
            }
        }
        if (!isMobile && this.settings.pageTurnMode !== 'none') {
            this.settings.pageTurnMode = 'none'
        }
        const initialTurnMode = normalizeAppPageTurnMode(this.settings.pageTurnMode, isMobile)
        this.pageTurnController?.setMode(initialTurnMode)
        this.appearance.updateSettingsUI()
    }

    setSetting(key, value, scope = 'auto') {
        const bookId = this.currentBookData?.id || this.currentBook?.id || this.bookId
        const hasBookOverride = !!(this.appearance._bookSettingsOverride && bookId)
        const isTypography = READER_OVERRIDE_ALLOWED_KEYS.includes(key)

        let targetScope = scope
        if (targetScope === 'auto') {
            targetScope = (hasBookOverride && isTypography) ? 'book' : 'global'
        }

        if (targetScope === 'book' && hasBookOverride && isTypography) {
            if (!this.appearance._bookSettingsOverride) this.appearance._bookSettingsOverride = {}
            this.appearance._bookSettingsOverride[key] = value
            if (key === 'pageTurnMode') {
                const isMobile = Boolean(
                    platformBridge?.isAndroid ||
                    window.mobileShell?.isMobileViewport?.() ||
                    document.documentElement?.classList?.contains?.('is-mobile-viewport')
                )
                this.appearance._bookSettingsOverride.pageTurnSourcePlatform = isMobile ? 'mobile' : 'desktop'
            }
        } else {
            if (!this.globalSettings) this.globalSettings = { ...this.settings }
            this.globalSettings[key] = value
        }

        this.settings = resolveReaderSettings(this.globalSettings, this.appearance._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
        if (key === 'pageTurnMode') {
            const isMobileDev = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
            const nextMode = value === 'curl' ? normalizeAppPageTurnMode('curl', isMobileDev) : value
            if (nextMode !== value) {
                if (this.globalSettings?.pageTurnMode === 'curl') this.globalSettings.pageTurnMode = nextMode
                if (this.appearance._bookSettingsOverride?.pageTurnMode === 'curl') this.appearance._bookSettingsOverride.pageTurnMode = nextMode
                this.settings = resolveReaderSettings(this.globalSettings, this.appearance._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
            }
            this.pageTurnController?.setMode(isMobileDev ? nextMode : 'none')
        }
        return this.settings
    }

    saveSettingsDebounced(delay = 200) {
        this.appearance.applySettingsToReader()
        this.appearance.updatePresetsBadge()
        clearTimeout(this._saveSettingsTimer)
        this._saveSettingsTimer = setTimeout(() => {
            this.saveSettings().catch(err => console.warn('Failed to save settings:', err))
        }, delay)
    }

    async saveSettings({ apply = true } = {}) {
        clearTimeout(this._saveSettingsTimer)
        const bookId = this.currentBookData?.id || this.currentBook?.id || this.bookId
        if (this.appearance._bookSettingsOverride && bookId) {
            const cleanOverride = {}
            for (const key of READER_OVERRIDE_ALLOWED_KEYS) {
                if (Object.hasOwn(this.appearance._bookSettingsOverride, key)) {
                    cleanOverride[key] = this.appearance._bookSettingsOverride[key]
                }
            }
            if (
                this.appearance._bookSettingsOverride.pageTurnSourcePlatform === 'mobile' ||
                this.appearance._bookSettingsOverride.pageTurnSourcePlatform === 'desktop'
            ) {
                cleanOverride.pageTurnSourcePlatform = this.appearance._bookSettingsOverride.pageTurnSourcePlatform
            }
            this.appearance._bookSettingsOverride = cleanOverride
            try {
                localStorage.setItem(`linden_book_settings_${bookId}`, JSON.stringify(this.appearance._bookSettingsOverride))
            } catch (e) {}
        }

        if (!this.globalSettings) {
            this.globalSettings = structuredClone(this.settings)
        }
        this.globalSettings.shelfViewMode = this.bookshelf.shelfViewMode
        this.globalSettings.updatedAt = Date.now()
        this.settings = resolveReaderSettings(this.globalSettings, this.appearance._bookSettingsOverride, READER_OVERRIDE_ALLOWED_KEYS)
        try {
            if (this.globalSettings.theme) localStorage.setItem('linden_leaf_theme', this.globalSettings.theme)
            if (this.bookshelf.shelfViewMode) localStorage.setItem('linden_leaf_view_mode', this.bookshelf.shelfViewMode)
        } catch (e) {}
        await db.setSetting('readerSettings', this.globalSettings)
        if (apply) {
            this.appearance.applySettingsToReader()
        }
        this.appearance.updatePresetsBadge()
    }

    updateSettingsUI(...args) { return this.appearance.updateSettingsUI(...args) }

    openStatsView(...args) { return this.stats.openStatsView(...args) }

    applyTheme(...args) { return this.appearance.applyTheme(...args) }

    applySettingsToReader(...args) { return this.appearance.applySettingsToReader(...args) }

    bindEvents() {
        if (this._eventsBound) return
        this._eventsBound = true
        this.dialogs.bindEvents()
        this.stats.bindEvents()
        this.bookshelf.bindEvents()
        this.imports.bindEvents()
        this.sync.bindEvents()
        this.updates.bindEvents()
        this.drawing.bindEvents()
        this.pdfTools.bindEvents()
        this.search.bindEvents()
        this.annotations.bindEvents()
        this.cards.bindEvents()
        this.appearance.bindEvents()
        this._bindWindowLifecycleEvents()
        this._bindProfileAndDataEvents()
        this._bindReaderNavigationEvents()
        this._bindReaderGestureEvents()
        this._bindAudioControls()
    }

    _bindWindowLifecycleEvents() {
        platformBridge.onFlushRequest(async requestId => {
            await this.flushReaderStateOnExit(requestId)
        });
        platformBridge.onFlushBeforeQuit(async () => {
            await this.flushReaderStateOnExit()
        });
        this._fileOpenQueue = Promise.resolve();
        const handleOpenFile = (fileInfo) => {
            this._hasPendingExternalFileLaunch = true
            if (this.bootStageTimings) {
                this.bootStageTimings.launchMode = 'external-file'
            }
            this._fileOpenQueue = this._fileOpenQueue.then(async () => {
                if (!fileInfo) return

                const curWinLabel = platformBridge.getCurrentWindowLabel ? platformBridge.getCurrentWindowLabel() : null
                if (fileInfo.targetWindow && curWinLabel && fileInfo.targetWindow !== curWinLabel) {
                    return
                }

                if (fileInfo.requestId) {
                    this._handledOpenFileRequests = this._handledOpenFileRequests || new Set()
                    if (this._handledOpenFileRequests.has(fileInfo.requestId)) return
                    this._handledOpenFileRequests.add(fileInfo.requestId)
                    if (this._handledOpenFileRequests.size > 100) {
                        const oldest = this._handledOpenFileRequests.values().next().value
                        this._handledOpenFileRequests.delete(oldest)
                    }
                }

                let nativeSnapshotPath = null
                let savedBookId = null
                let preparedEpub = null
                try {
                    const ext = (fileInfo.filename || '').split('.').pop()?.toLowerCase() || ''
                    if (ext === 'pdf' && fileInfo.filePath) {
                        const prepared = await openLocalPdfSource(fileInfo, { db, bridge: platformBridge })
                        if (prepared) {
                            nativeSnapshotPath = prepared.descriptor
                            savedBookId = prepared.book.id
                            this.markBootStage?.('stage')
                            Object.assign(this.bootStageTimings || {}, {
                                stageCopyHashMs: prepared.descriptor.copyHashMs,
                                stageFlushMs: prepared.descriptor.flushMs,
                                stageTotalMs: prepared.descriptor.stageTotalMs
                            })
                        }
                    } else if (ext === 'epub' && fileInfo.filePath && platformBridge.isTauri &&
                        platformBridge.getCapabilities().isWindows) {
                        const opened = await openLocalEpubSource(fileInfo, { db, bridge: platformBridge, queue: this.importQueue })
                        savedBookId = opened.bookId
                        preparedEpub = opened.epub
                        this.markBootStage?.('stage')
                    }

                    // 1. Close any active modal dialogs
                    const modals = [
                        this.dialogs.dom.globalModalBackdrop,
                        this.dom.localeOnboardingBackdrop,
                        this.dom.welcomeModalBackdrop,
                        this.bookshelf.dom.modalCreateList,
                        this.bookshelf.dom.modalManageBookLists,
                        this.bookshelf.dom.modalBatchAddToList,
                        document.getElementById('modal-stats-detail'),
                        document.getElementById('modal-webdav-sync'),
                        document.getElementById('quote-card-backdrop'),
                        document.getElementById('footnote-popup')
                    ]
                    modals.forEach(m => {
                        if (m) {
                            m.classList?.remove('show')
                            m.style.display = 'none'
                        }
                    })

                    // 2. Close active drawer
                    if (this.annotations.activeDrawer) {
                        this.annotations.closeDrawer()
                    }

                    // 3. If currently reading a book, lock reader loading placeholder cleanly instead of flashing bookshelf
                    const hadOpenBook = Boolean(this.currentBookId)
                    if (hadOpenBook) {
                        window.mobileShell?.beginReaderSessionLoading?.(fileInfo?.filename || '')
                    }

                    if (!savedBookId) {
                        // Non-PDF or non-staged: read buffer via binary IPC and process
                        let buf = fileInfo.buffer
                        if ((!buf || buf.byteLength === 0 || buf.length === 0) && fileInfo.filePath && platformBridge.readFileBuffer) {
                            buf = await platformBridge.readFileBuffer(fileInfo.filePath)
                        }
                        if (!buf || (buf.byteLength === 0 && buf.length === 0)) {
                            if (hadOpenBook) {
                                window.mobileShell?.finishReaderSessionLoading?.()
                                if (this.currentBookId && this.currentBookData) {
                                    window.mobileShell?.setReaderInView?.(true)
                                    window.mobileShell?.setReaderToolsVisible?.(false, this.currentBookData.title || '')
                                }
                            }
                            return
                        }
                        if (Array.isArray(buf)) {
                            buf = new Uint8Array(buf).buffer
                        } else if (ArrayBuffer.isView(buf) && !(buf instanceof ArrayBuffer)) {
                            buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
                        } else if (typeof buf.arrayBuffer === 'function') {
                            buf = await buf.arrayBuffer()
                        }
                        const fileObj = new File([buf], fileInfo.filename)
                        savedBookId = await this.imports.processAndSaveBook(fileObj, undefined, fileInfo.filePath, nativeSnapshotPath)
                        if (savedBookId) {
                            this.markBootStage?.('stage')
                        }

                    }

                    if (savedBookId) {
                        const shouldOpenInPlace = Boolean(!this.currentBookId || hadOpenBook)
                        await this.openBook(savedBookId, null, {
                            forceInPlace: shouldOpenInPlace,
                            takePreparedEpub: preparedEpub ? snapshot => {
                                if (preparedEpub.documentHash !== snapshot.documentHash) return null
                                const { book } = preparedEpub
                                preparedEpub = null
                                return book
                            } : undefined
                        })
                    } else if (hadOpenBook) {
                        window.mobileShell?.finishReaderSessionLoading?.()
                        if (this.currentBookId && this.currentBookData) {
                            window.mobileShell?.setReaderInView?.(true)
                            window.mobileShell?.setReaderToolsVisible?.(false, this.currentBookData.title || '')
                        }
                    }
                } catch (err) {
                    if (!savedBookId && nativeSnapshotPath && platformBridge.reclaimSnapshot) {
                        platformBridge.reclaimSnapshot(nativeSnapshotPath).catch(() => {})
                    }
                    if (!savedBookId) {
                        window.mobileShell?.finishReaderSessionLoading?.()
                        if (this.currentBookId && this.currentBookData) {
                            window.mobileShell?.setReaderInView?.(true)
                            window.mobileShell?.setReaderToolsVisible?.(false, this.currentBookData.title || '')
                        }
                    }
                    console.error('Failed to open file from OS event:', err)
                    this.dialogs.showToast(t('app.cannotOpenFile', { error: err.message || t('app.reselectBook') }), 'warning')
                } finally {
                    preparedEpub?.book.destroy()
                }
            }).catch(err => {
                console.error('[App] Error in file open queue:', err)
            })
        };
        const unsubOpenFile = platformBridge.onOpenFile(handleOpenFile);
        if (unsubOpenFile?.ready) {
            unsubOpenFile.ready.then(() => platformBridge.rendererReady().catch(() => {}))
        } else {
            platformBridge.rendererReady().catch(() => {})
        };
        this.rootEvents.on(this.dom.btnShelfSettings, 'click', () => this.annotations.openDrawer('settings'));
        this.sync.setupSyncEventListeners();
        this.updates.setupUpdateEventListeners();
        this.updates.initUpdateService();
        this.updateCachedDimensions = () => {
            const target = this.bookshelf.dom.modernShelfScreen || this.bookshelf.dom.modernShelfDivider
            this.bookshelf.cachedShelfHeight = target ? target.offsetTop : (window.innerHeight - 54)
        };
        this.updateCachedDimensions();
        let resizeTimer = null;
        this.rootEvents.on(window, 'resize', () => {
            this.pageTurnController?.cancelCurrent()
            this.updateCachedDimensions()
            clearTimeout(resizeTimer)
            resizeTimer = setTimeout(() => {
                if (this.bookshelf.shelfViewMode === 'shelf' && this.dom.bookshelfView?.style.display !== 'none') {
                    if (this.bookshelf.currentBooksList) this.bookshelf.renderBooksShelf(this.bookshelf.currentBooksList)
                } else if (this.bookshelf.shelfViewMode === 'grid' && this.bookshelf._isGridVirtualized && this.bookshelf._virtualBooks) {
                    this.bookshelf._renderVirtualizedBooksGrid(this.bookshelf._virtualBooks)
                } else if (this.currentBookId && (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf')) {
                    this.drawing.renderPdfDrawingOverlayForCurrentPage()
                }
            }, 120)
        }, { passive: true });
        this.rootEvents.on(document, 'keydown', e => this.handleGlobalKeydown(e));
        this.rootEvents.on(window, 'contextmenu', e => {
            if (e.target?.matches?.('input, textarea') || e.target?.isContentEditable) {
                return
            }
            const card = e.target?.closest?.('.skeuo-book, .leaf-book-card, .leaf-table-row')
            if (card && card.dataset?.id) {
                e.preventDefault()
                this.openBookDetailsModal(card.dataset.id)
                return
            }
            if (e.target?.closest?.('#reader-view, #bookshelf-view, .books-workspace, .modern-shelf-screen')) {
                e.preventDefault()
            }
        }, false);
    }

    _bindProfileAndDataEvents() {
        const closeLocaleOnboardingModal = () => {
            const backdrop = this.dom.localeOnboardingBackdrop
            if (!backdrop) return
            backdrop.classList.remove('show')
            clearTimeout(this._localeGateCloseTimer)
            this._localeGateCloseTimer = setTimeout(() => {
                if (this.dom.localeOnboardingBackdrop) {
                    this.dom.localeOnboardingBackdrop.style.display = 'none'
                }
            }, 180)
        }
        this.rootEvents.on(document, 'click', e => {
            const choiceBtn = e.target?.closest?.('[data-locale-choice]')
            if (choiceBtn && this.dom.localeOnboardingBackdrop?.classList.contains('show')) {
                const chosen = choiceBtn.dataset.localeChoice
                if (chosen) {
                    setLocale(chosen, { persist: true, broadcast: true, applyDom: true })
                }
                closeLocaleOnboardingModal()
                setTimeout(() => {
                    if (localStorage.getItem('linden_user_initialized') !== 'true') {
                        this.openWelcomeModal()
                    }
                }, 170)
                return
            }

            const optionBtn = e.target?.closest?.('[data-locale-option]')
            if (optionBtn) {
                const next = optionBtn.dataset.localeOption
                if (next) {
                    setLocale(next, { persist: true, broadcast: true, applyDom: true })
                }
                return
            }

            const toggleBtn = e.target?.closest?.('[data-locale-toggle]')
            if (toggleBtn) {
                const next = getLocale() === 'en' ? 'zh-CN' : 'en'
                setLocale(next, { persist: true, broadcast: true, applyDom: true })
            }
        })

        const closeWelcomeModal = () => {
            if (!this.dom.welcomeModalBackdrop) return
            this.dom.welcomeModalBackdrop.classList.remove('show')
            clearTimeout(this._welcomeCloseTimer)
            this._welcomeCloseTimer = setTimeout(() => {
                if (this.dom.welcomeModalBackdrop) {
                    this.dom.welcomeModalBackdrop.style.display = 'none'
                }
            }, 180)
        }
        const handleWelcomeSave = () => {
            if (this.dom.welcomeModalBackdrop && !this.dom.welcomeModalBackdrop.classList.contains('show')) return
            const name = this.dom.welcomeUsernameInput?.value.trim()
            if (name) {
                localStorage.setItem('linden_user_name', name)
            }
            localStorage.setItem('linden_user_initialized', 'true')
            closeWelcomeModal()
            this.updateUserProfileDisplay()
            const displayName = this.getUserDisplayName()
            if (this.appearance.dom.settingUserName) this.appearance.dom.settingUserName.value = displayName !== DEFAULT_READER_NAME ? displayName : ''
            if (this.cards.dom.quoteUserNameInput) this.cards.dom.quoteUserNameInput.value = displayName
            if (quoteCard) quoteCard.userName = displayName
            if (this.bookshelf.dom.heroGreetingTitle && this.bookshelf.shelfCategory === 'all') {
                const greetingData = this.bookshelf.getDynamicGreeting()
                this.bookshelf.dom.heroGreetingTitle.innerText = greetingData.title
                this.bookshelf.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
            }
            const shouldLaunchTour = localStorage.getItem('linden_tour_completed') !== 'true'
                && !this.isSatelliteReaderWindow
                && !this.isMobileLayout()
                && !platformBridge?.isAndroid
                && this.dom.bookshelfView?.style.display !== 'none'
            clearTimeout(this._onboardingLaunchTimer)
            if (shouldLaunchTour) {
                this._onboardingLaunchTimer = setTimeout(() => {
                    this._onboardingLaunchTimer = null
                    if (this.isSatelliteReaderWindow || this.currentBookId || this.isMobileLayout() || platformBridge?.isAndroid) return
                    if (this.dom.bookshelfView?.style.display === 'none') return
                    if (this.annotations.activeDrawer) return
                    this.startOnboardingTour()
                }, 200)
            } else {
                this.dialogs.showToast(
                    displayName !== DEFAULT_READER_NAME
                        ? t('welcome.toastReturn', { name: displayName })
                        : t('welcome.toastFirst'),
                    'info'
                )
            }
        };
        this.rootEvents.on(this.dom.btnWelcomeConfirm, 'click', handleWelcomeSave);
        this.rootEvents.on(this.dom.welcomeUsernameInput, 'keydown', e => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) handleWelcomeSave()
        });
        const handleWelcomeSkip = () => {
            if (this.dom.welcomeModalBackdrop && !this.dom.welcomeModalBackdrop.classList.contains('show')) return
            clearTimeout(this._onboardingLaunchTimer)
            this._onboardingLaunchTimer = null
            localStorage.setItem('linden_user_initialized', 'true')
            localStorage.setItem('linden_tour_completed', 'true')
            closeWelcomeModal()
            this.updateUserProfileDisplay()
        };
        this.rootEvents.on(this.dom.btnWelcomeSkip, 'click', handleWelcomeSkip);
        this.rootEvents.on(document.getElementById('btn-replay-onboarding-guide'), 'click', () => {
            this.annotations.closeDrawer()
            window.mobileShell?.settingsPage?.close?.()
            window.mobileShell?.closeAllSheets?.()
            clearTimeout(this._onboardingLaunchTimer)
            this._onboardingLaunchTimer = setTimeout(() => {
                this._onboardingLaunchTimer = null
                this.startOnboardingTour({ force: true })
            }, 200)
        });
        this.rootEvents.on(this.appearance.dom.settingUserName, 'input', e => {
            const name = e.target.value.trim()
            if (name) {
                localStorage.setItem('linden_user_name', name)
            } else {
                localStorage.removeItem('linden_user_name')
            }
            const displayName = this.getUserDisplayName()
            if (this.cards.dom.quoteUserNameInput) this.cards.dom.quoteUserNameInput.value = displayName
            if (quoteCard) quoteCard.userName = displayName
            this.updateUserProfileDisplay()
            if (this.bookshelf.dom.heroGreetingTitle && this.bookshelf.shelfCategory === 'all') {
                const greetingData = this.bookshelf.getDynamicGreeting()
                this.bookshelf.dom.heroGreetingTitle.innerText = greetingData.title
                this.bookshelf.dom.heroGreetingSubtitle.innerText = greetingData.subtitle
            }
        });
        this.rootEvents.on(document.getElementById('sidebar-user-info'), 'click', () => {
            this.annotations.openDrawer('settings')
            setTimeout(() => {
                this.appearance.dom.settingUserName?.focus()
                this.appearance.dom.settingUserName?.select()
            }, 200)
        });
        const populateStoragePaths = async () => {
            try {
                const paths = await window.platformBridge?.fsGetAppPaths?.()
                const booksEl = document.getElementById('storage-path-books')
                const openBooksBtn = document.getElementById('btn-open-books-folder')
                const dataEl = document.getElementById('storage-path-data')
                const cacheEl = document.getElementById('storage-path-cache')
                const linkedRoots = (await db.getSetting('linkedFolderRoots', [])) || []
                const hasLinkedRoots = Array.isArray(linkedRoots) && linkedRoots.length > 0
                if (booksEl) {
                    booksEl.textContent = hasLinkedRoots
                        ? linkedRoots.join('; ')
                        : t('app.noLinkedFolderHint')
                }
                if (openBooksBtn) {
                    openBooksBtn.hidden = !hasLinkedRoots
                    openBooksBtn.disabled = !hasLinkedRoots
                }
                if (paths) {
                    if (dataEl) {
                        dataEl.textContent = paths.indexeddb_dir || paths.webview_profile_dir || paths.data_dir || t('app.localDbDirFallback')
                    }
                    if (cacheEl) {
                        cacheEl.textContent = paths.snapshot_dir || paths.cache_dir || t('app.localCacheDirFallback')
                    }
                }
            } catch (err) {
                console.warn('[F13] populateStoragePaths failed:', err)
            }
        };
        this._populateStoragePaths = populateStoragePaths;
        populateStoragePaths();
        this.rootEvents.on(document.getElementById('btn-open-books-folder'), 'click', async () => {
            const linkedRoots = (await db.getSetting('linkedFolderRoots', [])) || []
            const target = Array.isArray(linkedRoots) && linkedRoots.length > 0 ? linkedRoots[0] : null
            if (target) window.platformBridge?.fsOpenInExplorer?.(target)
        });
        this.rootEvents.on(document.getElementById('btn-open-data-folder'), 'click', async () => {
            const paths = await window.platformBridge?.fsGetAppPaths?.()
            const target = paths?.indexeddb_dir || paths?.webview_profile_dir || paths?.data_dir
            if (target) window.platformBridge?.fsOpenInExplorer?.(target)
        });
        this.rootEvents.on(document.getElementById('btn-open-cache-folder'), 'click', async () => {
            const paths = await window.platformBridge?.fsGetAppPaths?.()
            const target = paths?.snapshot_dir || paths?.cache_dir
            if (target) window.platformBridge?.fsOpenInExplorer?.(target)
        });
        this.rootEvents.on(document.getElementById('btn-f13-export-backup'), 'click', () => {
            document.getElementById('btn-export-full-data-backup')?.click()
        });
        this.rootEvents.on(document.getElementById('btn-f13-restore-backup'), 'click', () => {
            document.getElementById('btn-restore-full-data-backup')?.click()
        });
        this.rootEvents.on(this.dom.btnOpenAuditFromSettings, 'click', () => {
            if (this.aiSidebar) {
                this.aiSidebar.openAuditModal()
            }
        });
        this.rootEvents.on(this.dom.btnClearAiCacheSettings, 'click', async () => {
            if (this.aiSidebar) {
                await this.aiSidebar.handleClearAuditLog()
            }
        });
    }

    _bindReaderNavigationEvents() {
        this.rootEvents.on(this.dom.btnBackToShelf, 'click', () => this.closeReader());
        this.rootEvents.on(document.getElementById('btn-toggle-ai-sidebar'), 'click', async () => {
            const session = this._activeSession
            const sidebar = await ensureAiSidebarLoaded(this)
            if (session?.isCurrent()) await sidebar.toggleSidebar()
        });
        this.rootEvents.on(this.dom.btnNavLeft, 'click', () => this.turnPagePrev());
        this.rootEvents.on(this.dom.btnNavRight, 'click', () => this.turnPageNext());
        this.rootEvents.on(this.dom.btnNavHistoryBack, 'click', () => this.navHistory?.back());
        this.rootEvents.on(this.dom.btnNavHistoryForward, 'click', () => this.navHistory?.forward());
        this._isPinnedWindow = false;
        this.rootEvents.on(this.dom.btnTogglePinWindow, 'click', async () => {
            this._isPinnedWindow = !this._isPinnedWindow
            if (window.platformBridge?.windowSetAlwaysOnTop) {
                await window.platformBridge.windowSetAlwaysOnTop(this._isPinnedWindow)
            }
            this.dom.btnTogglePinWindow.classList.toggle('active', this._isPinnedWindow)
            this.dom.btnTogglePinWindow.title = this._isPinnedWindow ? t('app.unpinWindowTitle') : t('app.pinWindowTitle')
        });
        this.rootEvents.on(this.dom.btnAddToShelf, 'click', async () => {
            if (!this.currentBookId || !this.currentBookData) return
            this.currentBookData.isRecentOnly = false
            await db.saveBook(this.currentBookData)
            this.dom.btnAddToShelf.style.display = 'none'
            this.dialogs.showToast(t('app.addedToShelfToast'), 'success')
            await this.bookshelf.refreshBookshelf()
        });
        this.rootEvents.on(window, 'mouseup', e => {
            if (this.dom.bookshelfView?.style.display === 'none') {
                if (e.button === 3) {
                    e.preventDefault()
                    this.navHistory?.back()
                } else if (e.button === 4) {
                    e.preventDefault()
                    this.navHistory?.forward()
                }
            }
        });

        this.rootEvents.on(this.dom.progressSlider, 'input', e => {
            const rawVal = parseFloat(e.target.value)
            if (this.dom.progressText && Number.isFinite(rawVal)) {
                const pctDisplay = rawVal > 0 && rawVal < 100 && rawVal % 1 !== 0
                    ? rawVal.toFixed(1).replace(/\.0$/, '')
                    : `${Math.round(rawVal)}`
                this.dom.progressText.innerText = `${pctDisplay}%`
            }
        });
        this.rootEvents.on(this.dom.progressSlider, 'change', e => {
            const fraction = parseFloat(e.target.value) / 100
            if (this.pdfViewport && Number.isFinite(fraction)) {
                const totalPages = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 1
                const targetPage = Math.min(totalPages - 1, Math.max(0, Math.floor(fraction * totalPages)))
                this.pdfViewport.goToPage(targetPage)
            } else if (this.foliateView && Number.isFinite(fraction)) {
                this.foliateView.goToFraction(Math.max(0, Math.min(1, fraction)))
            }
        });
        this.rootEvents.on(this.dom.btnCloseBookDetails, 'click', () => this.closeBookDetailsModal());
        this.rootEvents.on(this.dom.modalBookDetails, 'click', e => {
            if (e.target === this.dom.modalBookDetails) this.closeBookDetailsModal()
        });
        this.rootEvents.on(this.dom.readerPageNumber, 'click', async () => {
            const isFixed = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
            const hasLocationTotal = !isFixed && typeof this.currentLocation?.location?.total === 'number' && this.currentLocation.location.total > 0

            let total, curr, isPercentageMode = false

            if (isFixed) {
                total = this.currentLocation?.totalPages || 1
                curr = this.currentLocation?.page || 1
            } else if (hasLocationTotal) {
                total = this.currentLocation.location.total
                curr = (this.currentLocation.location.current != null) ? this.currentLocation.location.current + 1 : 1
            } else {
                // In reflowable mode before location index is built, operate strictly on whole-book percentage
                isPercentageMode = true
                total = 100
                curr = Math.max(0, Math.min(100, Math.round((this.currentLocation?.fraction || 0) * 100)))
            }

            const title = isPercentageMode 
                ? t('app.jumpPercentTitle')
                : t('app.jumpPageTitle', { total })
            const placeholder = isPercentageMode
                ? t('app.jumpPercentPlaceholder')
                : t('app.jumpPagePlaceholder', { total })

            const targetStr = await this.dialogs.showInputDialog({
                title,
                value: String(curr),
                placeholder
            })
            if (targetStr != null && targetStr.trim() !== '') {
                const trimmed = targetStr.trim()
                if (trimmed.endsWith('%')) {
                    const pctVal = parseFloat(trimmed)
                    if (!isNaN(pctVal) && pctVal >= 0 && pctVal <= 100) {
                        if (this.pdfViewport) {
                            const totalPages = this.pdfViewport.pageOffsets?.length || this.pdfViewport.pageSizes?.length || 1
                            const targetPage = Math.min(totalPages - 1, Math.max(0, Math.floor((pctVal / 100) * totalPages)))
                            this.pdfViewport.goToPage(targetPage)
                        } else {
                            this.foliateView?.goToFraction(pctVal / 100)
                        }
                        return
                    }
                }
                const targetPage = parseInt(trimmed, 10)
                const minVal = isPercentageMode ? 0 : 1
                if (!isNaN(targetPage) && targetPage >= minVal && targetPage <= total) {
                    if (this.pdfViewport) {
                        this.pdfViewport.goToPage(targetPage - 1)
                    } else if (this.foliateView) {
                        if (isFixed) {
                            this.foliateView.goTo(targetPage - 1)
                        } else if (isPercentageMode) {
                            this.foliateView.goToFraction(targetPage / 100)
                        } else {
                            const targetFraction = total > 1 ? (targetPage - 1) / (total - 1) : 0
                            this.foliateView.goToFraction(targetFraction)
                        }
                    }
                } else {
                    this.dialogs.showToast(isPercentageMode ? t('app.invalidPercentToast') : t('app.invalidPageToast'), 'warning')
                }
            }
        });
    }

    _bindReaderGestureEvents() {
        let contentAreaHadActiveSelectionOnDown = false;
        this.rootEvents.on(this.dom.readerContentArea, 'pointerdown', e => {
            this._lastContentAreaPointerDownTime = Date.now()
            const hasDict = Boolean(this.cards.dom.readerDictionaryCard?.classList.contains('active') || (this.cards.dom.readerDictionaryCard?.style.display && this.cards.dom.readerDictionaryCard.style.display !== 'none'))
            const hasPopup = Boolean(this.annotations.dom.selectionPopup?.classList.contains('active') || (this.annotations.dom.selectionPopup?.style.display && this.annotations.dom.selectionPopup.style.display !== 'none'))
            const hasHighlightPopup = Boolean(this.annotations.dom.highlightActionPopup?.classList.contains('active') || (this.annotations.dom.highlightActionPopup?.style.display && this.annotations.dom.highlightActionPopup.style.display !== 'none'))
            const hasFootnote = Boolean(this.cards.dom.footnotePopup?.classList.contains('active') || (this.cards.dom.footnotePopup?.style.display && this.cards.dom.footnotePopup.style.display !== 'none'))
            contentAreaHadActiveSelectionOnDown = hasDict || hasPopup || hasHighlightPopup || hasFootnote
        }, true);
        let contentAreaTouchStartX = 0;
        let contentAreaTouchStartY = 0;
        let contentAreaTouchStartTime = 0;
        let contentAreaTouchMoved = false;
        this.rootEvents.on(this.dom.readerContentArea, 'touchstart', e => {
            if (!e.touches || e.touches.length !== 1) {
                contentAreaTouchMoved = true
            } else {
                const t = e.touches[0]
                contentAreaTouchStartX = t.clientX
                contentAreaTouchStartY = t.clientY
                contentAreaTouchStartTime = Date.now()
                contentAreaTouchMoved = false
            }
            this.pageTurnController?.handleTouchStart(e)
        }, { passive: true });
        this.rootEvents.on(this.dom.readerContentArea, 'touchmove', e => {
            if (!e.touches || e.touches.length !== 1) {
                contentAreaTouchMoved = true
            } else {
                const t = e.touches[0]
                if (Math.hypot(t.clientX - contentAreaTouchStartX, t.clientY - contentAreaTouchStartY) > 8) {
                    contentAreaTouchMoved = true
                }
            }
            this.pageTurnController?.handleTouchMove(e)
        }, { passive: false });
        const cancelContentTouch = (e) => {
            contentAreaTouchMoved = true
            this.pageTurnController?.handleTouchCancel(e)
        }
        this.rootEvents.on(this.dom.readerContentArea, 'touchcancel', cancelContentTouch, { passive: true });
        this.rootEvents.on(this.dom.readerContentArea, 'pointercancel', cancelContentTouch, { passive: true });
        this.rootEvents.on(this.dom.readerContentArea, 'touchend', e => {
            this.pageTurnController?.handleTouchEnd(e)

            if (this.pdfViewport || this.pageTurnController?.shouldSuppressTap?.()) {
                return
            }

            if (!contentAreaTouchMoved && (Date.now() - contentAreaTouchStartTime <= 450)) {
                if (!e.target.closest('button, a, .selection-popup, .highlight-action-popup, .reader-dictionary-card, input, .nav-arrow-left, .nav-arrow-right')) {
                    const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
                    if (isMobile) {
                        const winSel = window.getSelection()
                        const hasWinSel = Boolean(winSel && !winSel.isCollapsed && winSel.toString().trim())
                        const hasPopup = Boolean(
                            this.annotations.dom.selectionPopup?.classList.contains('active') ||
                            (this.annotations.dom.selectionPopup?.style.display && this.annotations.dom.selectionPopup.style.display !== 'none') ||
                            this.cards.dom.readerDictionaryCard?.classList.contains('active') ||
                            (this.cards.dom.readerDictionaryCard?.style.display && this.cards.dom.readerDictionaryCard.style.display !== 'none') ||
                            contentAreaHadActiveSelectionOnDown
                        )
                        if (hasWinSel || hasPopup) {
                            this.annotations.hideSelectionPopup()
                            this.cards.hideDictionaryCard()
                            this.cards.hideFootnotePopup()
                            try { winSel?.removeAllRanges?.() } catch {}
                            this.annotations._frozenSelectionSnapshot = null
                            contentAreaHadActiveSelectionOnDown = false
                            this.cancelPendingReaderUIToggle()
                            this._lastContentAreaTapHandledTime = Date.now()
                            return
                        }
                        this._lastContentAreaTapHandledTime = Date.now()
                        this.cancelPendingReaderUIToggle()
                        this.requestToggleReaderUI(60)
                    }
                }
            }
        });
        this.rootEvents.on(this.dom.readerContentArea, 'click', e => {
            if (this.pdfViewport || this.pageTurnController?.shouldSuppressTap?.()) {
                return
            }
            if (this._lastContentAreaTapHandledTime && (Date.now() - this._lastContentAreaTapHandledTime < 800)) {
                return
            }
            if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.selection-popup') || e.target.closest('.highlight-action-popup') || e.target.closest('.reader-dictionary-card') || e.target.closest('input') || e.target.closest('.nav-arrow-left') || e.target.closest('.nav-arrow-right')) {
                this.cancelPendingReaderUIToggle()
                return
            }
            if (this.pdfViewport?.shouldIgnoreContentClick()) {
                this.cancelPendingReaderUIToggle()
                return
            }
            const now = Date.now()
            const isTouch = (e.pointerType === 'touch') || (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
            this._lastContentAreaClickTime = now

            if (contentAreaHadActiveSelectionOnDown) {
                contentAreaHadActiveSelectionOnDown = false
                this.cancelPendingReaderUIToggle()
                try {
                    window.getSelection()?.removeAllRanges?.()
                } catch (err) {}
                return
            }
            const selection = window.getSelection()
            if (selection && !selection.isCollapsed && selection.toString().trim()) {
                this.cancelPendingReaderUIToggle()
                return
            }
            // Blank space in readerContentArea toggles immediately (0ms) on desktop mouse, 60ms on touch
            const delay = isTouch ? 60 : 0
            this.requestToggleReaderUI(delay)
        });
        this.isCurrentlyFullscreen = false;
        this.rootEvents.on(this.dom.btnToggleFullscreen, 'click', () => this.toggleFullscreen());
        const updateFullscreenUI = (isFs) => {
            this.isCurrentlyFullscreen = isFs
            if (this.dom.btnToggleFullscreen) {
                if (isFs) {
                    this.dom.btnToggleFullscreen.title = t('app.exitFullscreenTitle')
                    this.dom.btnToggleFullscreen.innerHTML = `
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
                        </svg>
                    `
                } else {
                    this.dom.btnToggleFullscreen.title = t('reader.fullscreenTitle')
                    this.dom.btnToggleFullscreen.innerHTML = `
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                        </svg>
                    `
                }
            }

            if (isFs) {
                if (this.settings.fullscreenAutohide) {
                    this.toggleReaderUI(false)
                }
            } else {
                this.toggleReaderUI(true)
            }
        };
        this.rootEvents.on(document, 'fullscreenchange', () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement)
            updateFullscreenUI(isFs)
        });
        if (window.electronAPI?.onFullscreenChange) {
            window.electronAPI.onFullscreenChange(isFs => {
                updateFullscreenUI(isFs)
            })
        };
        const handleFullscreenProximity = (clientY) => {
            const isFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
            if (!isFs || !this.settings.fullscreenAutohide) return
            const winH = window.innerHeight

            if (clientY <= 50) {
                this.dom.readerTopBar?.classList.remove('autohide')
                clearTimeout(this._fsTopTimer)
                this._fsTopTimer = setTimeout(() => {
                    const stillFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
                    if (stillFs && this.settings.fullscreenAutohide) {
                        this.dom.readerTopBar?.classList.add('autohide')
                    }
                }, 3000)
            }
            if (clientY >= winH - 50) {
                this.dom.readerBottomBar?.classList.remove('autohide')
                this.pdfTools.dom.pdfZoomBar?.classList.remove('autohide')
                clearTimeout(this._fsBottomTimer)
                this._fsBottomTimer = setTimeout(() => {
                    const stillFs = this.isCurrentlyFullscreen || !!(document.fullscreenElement || document.webkitFullscreenElement)
                    if (stillFs && this.settings.fullscreenAutohide) {
                        this.dom.readerBottomBar?.classList.add('autohide')
                        this.pdfTools.dom.pdfZoomBar?.classList.add('autohide')
                    }
                }, 3000)
            }
        };
        this.rootEvents.on(window, 'mousemove', e => handleFullscreenProximity(e.clientY), { passive: true });
        this._handleFullscreenProximity = handleFullscreenProximity;
        const stopWheelElements = document.querySelectorAll(
            '#sidebar-drawer, #quote-card-backdrop, #modal-pdf-ocr, .global-modal-backdrop, #reader-ai-sidebar, .reader-ai-sidebar, #ai-chat-messages, #modal-ai-presets, #modal-ai-history, #modal-ai-audit, .reader-dictionary-card'
        );
        stopWheelElements.forEach(el => {
            this.rootEvents.on(el, 'wheel', e => {
                e.stopPropagation()
            }, { passive: true })
        });
        let outerWheelCooldown = false;
        this.rootEvents.on(window, 'wheel', e => {
            // When drawer, quote-card modal, AI sidebar, or any dialog is open, do NOT flip reader pages
            const isAnyModalOpen = !!document.querySelector(
                '#quote-card-backdrop:not([style*="display: none"]), #modal-pdf-ocr:not([style*="display: none"]), .global-modal-backdrop:not([style*="display: none"]), .modal-backdrop:not([style*="display: none"]), .modal.show, #modal-ai-presets:not([style*="display: none"]), #modal-ai-history:not([style*="display: none"]), #modal-ai-audit:not([style*="display: none"])'
            )
            if (this.annotations.activeDrawer || isAnyModalOpen || e.target?.closest?.(
                '#sidebar-drawer, #quote-card-backdrop, #quote-card-dialog, .global-modal-backdrop, .global-modal-card, .drawer-body, .drawer-panel, .modal-card, .modal-dialog, .dropdown-menu, .popup-menu, .modal, #reader-ai-sidebar, .reader-ai-sidebar, .ai-sidebar-inner, #ai-chat-messages, .ai-chat-messages, #modal-ai-presets, #modal-ai-history, #modal-ai-audit, .ai-modal, .reader-dictionary-card'
            )) {
                return
            }
            if (e.ctrlKey || e.metaKey) {
                if (this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf') {
                    e.preventDefault()
                    this.pdfTools.stepPDFZoom(e.deltaY < 0 ? 10 : -10)
                }
                return
            }
            if (this.dom.readerView?.classList.contains('active') && this.settings.layout !== 'scrolled' && !this.foliateView?.isFixedLayout && this.currentBookData?.format !== 'pdf') {
                e.preventDefault()
                if (outerWheelCooldown) return
                const absY = Math.abs(e.deltaY)
                const absX = Math.abs(e.deltaX)
                if (absY > 20 || absX > 20) {
                    outerWheelCooldown = true
                    const dominantDelta = absY >= absX ? e.deltaY : e.deltaX
                    if (dominantDelta > 0) this.turnPageNext()
                    else if (dominantDelta < 0) this.turnPagePrev()
                    setTimeout(() => { outerWheelCooldown = false }, 220)
                }
            }
        }, { passive: false });
        this.sections.isCtrlPressed = false;
        this.sections._activeSelectionGestureCtrl = false;
        this.rootEvents.on(window, 'keydown', e => {
            if (e.key === 'Control' || e.key === 'Meta') this.sections.isCtrlPressed = true
        }, true);
        this.rootEvents.on(window, 'keyup', e => {
            if (e.key === 'Control' || e.key === 'Meta') {
                this.sections.isCtrlPressed = false
            }
        }, true);
        this.rootEvents.on(window, 'blur', () => {
            this.sections.isCtrlPressed = false
            this.sections._activeSelectionGestureCtrl = false
            this.sections._pointerDownWithCtrl = false
        });
        const settingsDomainMap = {
            'book-override-section': 'reading',
            'reading-presets-section': 'reading',
            'pdf-paper-settings-section': 'reading',
            'theme-settings-section': 'reading',
            'font-settings-section': 'reading',
            'typography-settings-section': 'reading',
            'adv-group-typography': 'reading',
            'adv-group-fonts': 'reading',
            'adv-group-palette': 'reading',
            'adv-group-txt-rules': 'reading',
            'adv-group-tts': 'assistant',
            'ai-settings-section': 'assistant',
            'adv-group-ai': 'assistant',
            'adv-group-translation': 'assistant',
            'dict-settings-section': 'assistant',
            'adv-group-dictionary': 'assistant',
            'user-profile-settings-section': 'system',
            'goals-settings-section': 'system',
            'adv-group-interaction': 'system',
            'adv-group-strokes': 'system',
            'search-settings-section': 'system',
            'sync-settings-section': 'system',
            'adv-group-backup': 'system',
            'mobile-backup-hint': 'system',
            'about-settings-section': 'system',
            'mobile-advanced-reset': 'system'
        };
        this.rootEvents.on(document.querySelector('.settings-shortcuts'), 'click', e => {
            const btn = e.target.closest('[data-settings-target], [data-settings-domain]')
            if (!btn) return
            const domain = btn.dataset.settingsDomain
            const targetId = btn.dataset.settingsTarget
            if (domain) {
                this.appearance.switchSettingsDomain(domain)
            } else if (targetId && settingsDomainMap[targetId]) {
                this.appearance.switchSettingsDomain(settingsDomainMap[targetId])
            }
            if (targetId) {
                const target = document.getElementById(targetId)
                if (target) {
                    target.scrollIntoView({ block: 'start', behavior: 'auto' })
                }
            }
        });
    }

    _bindAudioControls() {
        ttsPlayer.attachReaderApp(this);
        ttsPlayer.onStateChange((state) => {
            if (this.dom.iconTtsPlay && this.dom.iconTtsPause) {
                const isPlaying = state === 'playing'
                this.dom.iconTtsPlay.style.display = isPlaying ? 'none' : 'block'
                this.dom.iconTtsPause.style.display = isPlaying ? 'block' : 'none'
            }
        });
        this.rootEvents.on(this.dom.btnToggleTts, 'click', async () => {
            const bar = this.dom.ttsPlayerBar
            if (!bar) return
            const isHidden = bar.style.display === 'none' || !bar.classList.contains('active')
            if (isHidden) {
                bar.style.display = 'flex'
                bar.classList.add('active')
                await this.refreshTtsVoiceOptions()
                try {
                    ttsPlayer.segments = []
                    await ttsPlayer.play(0)
                } catch (e) {
                    this.dialogs.showToast(e.message, 'warning')
                }
            } else {
                if (ttsPlayer.state === 'playing') {
                    ttsPlayer.pause()
                } else if (ttsPlayer.state === 'paused') {
                    ttsPlayer.resume()
                } else {
                    bar.classList.remove('active')
                    bar.style.display = 'none'
                    ttsPlayer.stop()
                }
            }
        });
        this.rootEvents.on(this.dom.btnTtsTogglePlay, 'click', () => {
            if (ttsPlayer.state === 'playing') {
                ttsPlayer.pause()
            } else if (ttsPlayer.state === 'paused') {
                ttsPlayer.resume()
            } else {
                ttsPlayer.segments = []
                ttsPlayer.play(0).catch(e => this.dialogs.showToast(e.message, 'warning'))
            }
        });
        this.rootEvents.on(this.dom.btnTtsPrev, 'click', () => ttsPlayer.prev());
        this.rootEvents.on(this.dom.btnTtsNext, 'click', () => ttsPlayer.next());
        this.rootEvents.on(this.dom.selectTtsRate, 'change', (e) => {
            ttsPlayer.setRate(parseFloat(e.target.value))
        });
        this.rootEvents.on(this.dom.selectTtsVoice, 'change', (e) => {
            ttsPlayer.setVoice(e.target.value)
        });
        const selectTtsProvider = document.getElementById('select-tts-provider');
        if (selectTtsProvider) {
            selectTtsProvider.value = ttsPlayer.currentProviderName || 'system'
            this.rootEvents.on(selectTtsProvider, 'change', async (e) => {
                const provName = e.target.value
                ttsPlayer.setProvider(provName)
                await this.refreshTtsVoiceOptions()
                this.dialogs.showToast?.(t('app.ttsProviderSwitched', { provider: provName }), 'info')
            })
        };
        const timerOptions = [0, 15, 30, 45, 60, 'end_of_chapter'];
        let timerIdx = 0;
        this.rootEvents.on(this.dom.btnTtsTimer, 'click', () => {
            timerIdx = (timerIdx + 1) % timerOptions.length
            const opt = timerOptions[timerIdx]
            this._ttsTimerOpt = opt
            ttsPlayer.setSleepTimer(opt)
            if (this.dom.labelTtsTimer) {
                if (opt === 0) this.dom.labelTtsTimer.innerText = t('app.ttsTimerOffLabel')
                else if (opt === 'end_of_chapter') this.dom.labelTtsTimer.innerText = t('app.ttsTimerChapterLabel')
                else this.dom.labelTtsTimer.innerText = `${opt}m`
            }
            const tip = opt === 0 ? t('app.ttsTimerOffTip') : (opt === 'end_of_chapter' ? t('app.ttsTimerChapterTip') : t('app.ttsTimerMinsTip', { minutes: opt }))
            this.dialogs.showToast(tip, 'info')
        });
        this.rootEvents.on(this.dom.btnTtsClose, 'click', () => {
            ttsPlayer.stop()
            if (this.dom.ttsPlayerBar) {
                this.dom.ttsPlayerBar.classList.remove('active')
                this.dom.ttsPlayerBar.style.display = 'none'
            }
        });
        this.rootEvents.on(this.appearance.dom.letterSpacingSlider, 'input', e => {
            const raw = parseFloat(e.target.value)
            const val = Number(Number(Number.isFinite(raw) ? raw : 0).toFixed(2))
            this.setSetting('letterSpacing', val)
            this.appearance.dom.letterSpacingValue.innerText = `${val}px`
            this.saveSettingsDebounced()
        });
    }

    switchShelfCategory(...args) { return this.bookshelf.switchShelfCategory(...args) }

    // ==========================================================
    // PDF Freehand Drawing & Light OCR Annotation Engine
    // ==========================================================

    renderPdfDrawingOverlayForCurrentPage(...args) { return this.drawing.renderPdfDrawingOverlayForCurrentPage(...args) }

    openBookDetailsModal(bookId) {
        if (!this.dom.modalBookDetails || !this.dom.bookDetailsBody) return
        this.dom.modalBookDetails.style.display = 'flex'
        this.dom.modalBookDetails.classList.add('show')
        bookDetailsModal.render(this.dom.bookDetailsBody, bookId, {
            onOpenBook: (id) => {
                this.closeBookDetailsModal()
                this.openBook(id)
            },
            onOpenBookNewWindow: (id) => {
                this.closeBookDetailsModal()
                this.openBookInNewWindow(id)
            },
            onFilterByTag: (tag) => {
                this.closeBookDetailsModal()
                this.bookshelf.switchShelfCategory('overview', { tags: [tag], status: 'all' })
            },
            onManageLists: (id) => {
                this.bookshelf.openManageBookListsModal(id)
            },
            onDeleteBook: async (id) => {
                let book = (this.bookshelf.currentBooksList || []).find(b => b.id === id)
                if (!book) book = await db.getBook(id)
                if (book) {
                    this.closeBookDetailsModal()
                    this.bookshelf.handleDeleteBook(book)
                }
            },
            onShelfRefresh: () => this.bookshelf.refreshBookshelf()
        })
    }

    async navigateReaderToLocation(targetLoc) {
        if (targetLoc == null) return
        try {
            if (typeof targetLoc === 'object' && targetLoc !== null) {
                const yRatio = typeof targetLoc.yRatio === 'number' ? targetLoc.yRatio : 0
                let targetPage0 = null
                if (typeof targetLoc.pageIndex === 'number') {
                    targetPage0 = Math.max(0, targetLoc.pageIndex)
                } else if (typeof targetLoc.page === 'number') {
                    targetPage0 = Math.max(0, targetLoc.page - 1)
                }
                if (targetPage0 != null && this.pdfViewport) {
                    this.pdfViewport.scrollToPage(targetPage0, yRatio)
                    return
                }
                if (targetLoc.cfi && this.foliateView) {
                    await this.foliateView.goTo(targetLoc.cfi)
                    return
                }
                if (typeof targetLoc.fraction === 'number' && this.foliateView?.goToFraction) {
                    await this.foliateView.goToFraction(targetLoc.fraction)
                    return
                }
            } else if (typeof targetLoc === 'string' && this.foliateView) {
                await this.foliateView.goTo(targetLoc)
            } else if (typeof targetLoc === 'number') {
                if (this.pdfViewport) {
                    const totalPages = this.pdfDriver?.numPages || this.pdfViewport?.pageCount || 1
                    if (targetLoc <= 1 && targetLoc > 0 && totalPages > 1) {
                        const pg = Math.max(0, Math.round(targetLoc * (totalPages - 1)))
                        this.pdfViewport.scrollToPage(pg, 0)
                    } else {
                        this.pdfViewport.scrollToPage(Math.max(0, Math.round(targetLoc) - 1), 0)
                    }
                } else if (this.foliateView?.goToFraction) {
                    await this.foliateView.goToFraction(targetLoc)
                }
            }
        } catch (e) {
            console.warn('[navigateReaderToLocation] Navigation warning:', e)
        }
    }

    async openBookInNewWindow(bookId, initialLocation = null) {
        if (!bookId) return { success: false }
        if (!this._pendingWindowSpawns) {
            this._pendingWindowSpawns = new Set()
        }
        if (this._pendingWindowSpawns.has(bookId)) {
            return { success: true, pending: true }
        }
        this._pendingWindowSpawns.add(bookId)
        try {
            let book = (this.bookshelf.currentBooksList || []).find(b => b.id === bookId)
            if (!book) book = await db.getBook(bookId)
            if (!book) {
                this.dialogs.showToast(t('app.bookNotFound'), 'warning')
                return { success: false }
            }
            if (book.isCloudOnly) {
                this.sync.handleCloudBookClick(book)
                return { success: true, cloudHandled: true }
            }
            if (initialLocation != null) {
                try {
                    localStorage.setItem(
                        `linden_pending_nav_${book.id}`,
                        JSON.stringify({ location: initialLocation, ts: Date.now() })
                    )
                } catch (_) {}
            }
            const res = await platformBridge.openNewWindow({
                bookId: book.id,
                windowMode: 'reader',
                title: book.title || 'Linden Leaf'
            })
            if (res?.alreadyExists) {
                if (initialLocation != null) {
                    try {
                        this._crossWindowSyncBus?.postMessage({
                            type: 'NAVIGATE_BOOK_LOCATION',
                            bookId: book.id,
                            location: initialLocation
                        })
                    } catch (_) {}
                }
                this.dialogs.showToast(t('app.focusedReaderToast', { title: book.title }), 'book')
            }
            return res || { success: false }
        } finally {
            this._pendingWindowSpawns.delete(bookId)
        }
    }

    closeBookDetailsModal() {
        bookDetailsModal.cleanup?.()
        if (!this.dom.modalBookDetails) return
        this.dom.modalBookDetails.classList.remove('show')
        setTimeout(() => {
            if (this.dom.modalBookDetails && !this.dom.modalBookDetails.classList.contains('show')) this.dom.modalBookDetails.style.display = 'none'
        }, 200)
    }

    async refreshTtsVoiceOptions() {
        const rate = this.dom.selectTtsRate
        if (rate) {
            const value = String(ttsPlayer.rate)
            if (!Array.from(rate.options).some(option => option.value === value)) rate.add(new Option(value + '×', value))
            rate.value = value
        }
        const providerSelect = document.getElementById('select-tts-provider')
        if (providerSelect) providerSelect.value = ttsPlayer.currentProviderName
        const select = this.dom.selectTtsVoice
        if (!select) return
        const options = ttsPlayer.getProviderOptions()
        const key = JSON.stringify([ttsPlayer.currentProviderName, options.voiceId, options.apiEndpoint, options.localEndpoint, options.model])
        if (this._ttsVoiceChoicesKey === key) return
        this._ttsVoiceChoicesKey = key
        const generation = this._ttsVoiceChoicesGeneration = (this._ttsVoiceChoicesGeneration || 0) + 1
        try {
            const voices = await ttsPlayer.provider.getVoices(options)
            if (generation !== this._ttsVoiceChoicesGeneration) return
            const choices = [{ id: '', name: t('app.ttsDefaultVoice') }, ...(voices || []).filter(v => v.id)]
            if (options.voiceId && !choices.some(v => v.id === options.voiceId)) choices.push({ id: options.voiceId, name: options.voiceId })
            select.replaceChildren(...choices.map(voice => new Option(voice.name, voice.id)))
            select.value = options.voiceId || ''
        } catch (_) { this._ttsVoiceChoicesKey = null }
    }

    toggleBatchMode(...args) { return this.bookshelf.toggleBatchMode(...args) }

    toggleBookSelection(...args) { return this.bookshelf.toggleBookSelection(...args) }

    async copyMultiSelectionOrSingle() {
        const selection = this.annotations.selectedTextInfo || this.annotations._frozenSelectionSnapshot
        if (selection?.formatType !== 'pdf' && this.annotations.multiSelectedRanges && this.annotations.multiSelectedRanges.length > 1) {
            const mergedText = this.annotations.multiSelectedRanges.map(r => r.text).filter(Boolean).join('\n\n')
            if (!mergedText) return false
            try {
                await navigator.clipboard.writeText(mergedText)
                this.dialogs.showToast(t('app.copiedMultiToast', { count: this.annotations.multiSelectedRanges.length }), 'success')
                this.annotations.clearVirtualMultiSelections()
                this.annotations.multiSelectedRanges = []
                const iframe = this.foliateView?.shadowRoot?.querySelector('iframe') || this.foliateView?.querySelector('iframe')
                iframe?.contentDocument?.getSelection()?.removeAllRanges()
                this.annotations.hideSelectionPopup()
                return true
            } catch (err) {
                console.error('[Copy] Clipboard writeText failed:', err)
                this.dialogs.showToast(t('app.copyFailedToast'), 'warning')
                return false
            }
        } else if (selection?.text) {
            try {
                await navigator.clipboard.writeText(selection.text)
                this.dialogs.showToast(t('app.copiedSelectionToast'), 'success')
                if (selection.formatType !== 'pdf') this.annotations.hideSelectionPopup()
                return true
            } catch (err) {
                console.error('[Copy] Clipboard writeText failed:', err)
                this.dialogs.showToast(t('app.copyFailedToast'), 'warning')
                return false
            }
        }
        return false
    }

    turnPageNext() {
        this.cancelPendingReaderUIToggle()
        this.cards.hideFootnotePopup()
        if (this.pageTurnController) {
            this.pageTurnController.turnNext()
            return
        }
        if (this.pdfViewport) {
            const target = this.pdfViewport.getAdjacentPage('next')
            if (target != null) this.pdfViewport.goToPage(target)
            return
        }
        if (!this.foliateView) return
        if (typeof this.foliateView.goRight === 'function') {
            this.foliateView.goRight()
        } else if (typeof this.foliateView.next === 'function') {
            this.foliateView.next()
        }
    }

    turnPagePrev() {
        this.cancelPendingReaderUIToggle()
        this.cards.hideFootnotePopup()
        if (this.pageTurnController) {
            this.pageTurnController.turnPrev()
            return
        }
        if (this.pdfViewport) {
            const target = this.pdfViewport.getAdjacentPage('prev')
            if (target != null) this.pdfViewport.goToPage(target)
            return
        }
        if (!this.foliateView) return
        if (typeof this.foliateView.goLeft === 'function') {
            this.foliateView.goLeft()
        } else if (typeof this.foliateView.prev === 'function') {
            this.foliateView.prev()
        }
    }

    handleGlobalKeydown(e) {
        if (e.defaultPrevented) return
        const editing = e.target?.isContentEditable || e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="combobox"], [role="tab"], [role="menuitem"]')
        if (editing && e.key !== 'Escape') return

        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            if (e.key === 'ArrowLeft') {
                this.navHistory?.back?.()
            } else {
                this.navHistory?.forward?.()
            }
            return
        }

        const action = e.target?.closest?.('button, a[href], [role="button"]')
        const pagingKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)
        const copyKey = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c'
        const hasPdfSelection = Boolean(this.pdfViewport && this.annotations.selectedTextInfo?.formatType === 'pdf')
        const copyNativePdf = copyKey && hasPdfSelection && this.pdfViewport.driver?.kind === 'mupdf'
        if (action && !pagingKey && e.key !== 'Escape' && !copyNativePdf) return
        if (pagingKey && (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) return

        const openDialogs = [...document.querySelectorAll('.global-modal-backdrop')]
            .filter(el => el.classList.contains('show') && getComputedStyle(el).display !== 'none')
        if (openDialogs.length) {
            if (e.key === 'Escape') {
                const top = openDialogs.map((el, index) => ({ el, index, z: Number(getComputedStyle(el).zIndex) || 0 }))
                    .sort((a, b) => a.z - b.z || a.index - b.index).at(-1).el
                const close = top.id === 'global-modal-backdrop' ? this.dialogs.dom.globalModalCancel
                    : top.id === 'locale-onboarding-backdrop' ? (top.querySelector('.locale-choice-card.recommended') || document.getElementById('btn-locale-choice-zh'))
                    : top.id === 'welcome-modal-backdrop' ? this.dom.btnWelcomeSkip || document.getElementById('btn-welcome-skip')
                    : top.querySelector('.footnote-popup-close, [id="btn-cancel-chapter-trans-modal"]')
                e.preventDefault()
                e.stopPropagation()
                close?.click()
            }
            return
        }

        // A fading-out dialog still blocks interaction until its backdrop disappears.
        if ([...document.querySelectorAll('.global-modal-backdrop')].some(el => getComputedStyle(el).display !== 'none')) return

        // Escape closes a reading popup or drawer after all modal dialogs are dismissed.
        if (e.key === 'Escape') {
            if (!editing && hasPdfSelection) {
                e.preventDefault()
                this.annotations.hideSelectionPopup()
                return
            }
            if (this.cards.dom.footnotePopup && this.cards.dom.footnotePopup.style.display !== 'none') {
                this.cards.hideFootnotePopup()
                return
            }
            const statsDetailModal = document.getElementById('modal-stats-detail')
            if (statsDetailModal && (statsDetailModal.classList.contains('show') || statsDetailModal.style.display !== 'none')) {
                this.stats.closeStatsDetailModal()
                return
            }
            const syncModal = this.sync.dom.modalWebdavSync || document.getElementById('modal-webdav-sync')
            if (syncModal && (syncModal.classList.contains('show') || syncModal.style.display !== 'none')) {
                this.sync.closeWebdavSyncModal()
                return
            }
            if (this.cards.dom.quoteCardBackdrop && this.cards.dom.quoteCardBackdrop.style.display !== 'none') {
                this.cards.closeQuoteCardModal()
                return
            }
            if (this.bookshelf.dom.modalManageBookLists && this.bookshelf.dom.modalManageBookLists.style.display !== 'none') {
                this.bookshelf.closeManageBookListsModal()
                return
            }
            if (this.bookshelf.dom.modalCreateList && this.bookshelf.dom.modalCreateList.style.display !== 'none') {
                this.bookshelf.closeCreateListModal()
                return
            }
            const updateModal = this.updates.dom.modalUpdateDialog || document.getElementById('modal-update-dialog')
            if (updateModal && (updateModal.classList.contains('show') || updateModal.style.display !== 'none')) {
                this.updates.closeUpdateModal()
                return
            }
            if (this.bookshelf.dom.modalBatchAddToList && this.bookshelf.dom.modalBatchAddToList.style.display !== 'none') {
                this.bookshelf.closeBatchAddToListModal()
                return
            }
            if (this.annotations.activeDrawer) {
                this.annotations.closeDrawer()
                return
            }
        }

        if (this.dom.bookshelfView.style.display === 'none') {
            // If any drawer (settings/toc/notes/search) is currently open, do not trigger reader page flips
            if (this.annotations.activeDrawer) {
                return
            }

            // Check if any modal backdrop or popup dialog is active
            const isModalActive = () => {
                const modalBackdrops = [
                    this.dialogs.dom.globalModalBackdrop || document.getElementById('global-modal-backdrop'),
                    this.bookshelf.dom.modalCreateList || document.getElementById('modal-create-list'),
                    this.bookshelf.dom.modalManageBookLists || document.getElementById('modal-manage-book-lists'),
                    this.bookshelf.dom.modalBatchAddToList || document.getElementById('modal-batch-add-to-list'),
                    this.updates.dom.modalUpdateDialog || document.getElementById('modal-update-dialog'),
                    this.sync.dom.modalWebdavSync || document.getElementById('modal-webdav-sync'),
                    document.getElementById('modal-stats-detail'),
                    document.getElementById('quote-card-backdrop'),
                    document.getElementById('modal-pdf-ocr')
                ]
                return modalBackdrops.some(m => m && m.classList?.contains('show'))
            }

            if (isModalActive()) {
                return
            }

            // Alt+ArrowLeft / Alt+ArrowRight: History Back / Forward navigation
            if (e.altKey && e.key === 'ArrowLeft') {
                e.preventDefault()
                this.navHistory?.back()
                return
            }
            if (e.altKey && e.key === 'ArrowRight') {
                e.preventDefault()
                this.navHistory?.forward()
                return
            }

            // MuPDF paints its selection without a DOM range, so WebView cannot copy it itself.
            if (copyNativePdf || (copyKey && this.annotations.multiSelectedRanges?.length > 1)) {
                e.preventDefault()
                this.copyMultiSelectionOrSingle()
                return
            }

            switch (e.key) {
                case 'ArrowUp': {
                    e.preventDefault()
                    if (this.pdfViewport?.spreadMode === 'dual') {
                        this.turnPagePrev()
                    } else if (this.pdfViewport?.scrollArea) {
                        this.pdfViewport.scrollArea.scrollBy({ top: -90, behavior: 'auto' })
                    } else {
                        const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                        if (container && container.scrollHeight > container.clientHeight + 10) {
                            container.scrollBy({ top: -90, behavior: 'smooth' })
                        } else {
                            this.turnPagePrev()
                        }
                    }
                    break
                }
                case 'ArrowDown': {
                    e.preventDefault()
                    if (this.pdfViewport?.spreadMode === 'dual') {
                        this.turnPageNext()
                    } else if (this.pdfViewport?.scrollArea) {
                        this.pdfViewport.scrollArea.scrollBy({ top: 90, behavior: 'auto' })
                    } else {
                        const container = this.foliateView?.renderer?.shadowRoot?.host || this.foliateView?.renderer || this.foliateView
                        if (container && container.scrollHeight > container.clientHeight + 10) {
                            container.scrollBy({ top: 90, behavior: 'smooth' })
                        } else {
                            this.turnPageNext()
                        }
                    }
                    break
                }
                case 'ArrowLeft': {
                    if (e.altKey) return
                    e.preventDefault()
                    this.turnPagePrev()
                    break
                }
                case 'PageUp':
                case 'h':
                case 'H':
                case 'k':
                case 'K': {
                    if (e.ctrlKey || e.metaKey || e.altKey) return
                    e.preventDefault()
                    this.turnPagePrev()
                    break
                }
                case 'ArrowRight': {
                    if (e.altKey) return
                    e.preventDefault()
                    this.turnPageNext()
                    break
                }
                case 'PageDown':
                case ' ':
                case 'l':
                case 'L':
                case 'j':
                case 'J':
                case 'Enter': {
                    if (e.ctrlKey || e.metaKey || e.altKey) return
                    if (e.key === ' ' && this.pdfViewport?.getAutoScrollState().active) {
                        e.preventDefault()
                        this.pdfTools.toggleAutoScrollPause()
                        break
                    }
                    e.preventDefault()
                    this.turnPageNext()
                    break
                }
                case 'f':
                case 'F':
                    e.preventDefault()
                    if (e.ctrlKey || e.metaKey) {
                        this.annotations.openDrawer('search')
                    } else {
                        this.toggleFullscreen()
                    }
                    break
                case 'F3':
                    e.preventDefault()
                    if (this.search.currentSearchMatches.length > 0) {
                        this.search.navigateSearchMatch(e.shiftKey ? -1 : 1)
                    }
                    break
                case 'Escape':
                    if (this.pdfViewport?.getAutoScrollState().active) {
                        this.pdfTools.stopAutoScroll()
                        break
                    }
                    if (this.cards.dom.quoteCardBackdrop && this.cards.dom.quoteCardBackdrop.style.display !== 'none') {
                        this.cards.closeQuoteCardModal()
                        return
                    }
                    if (this.search.currentSearchMatches.length > 0 || (this.search.dom.readerSearchBar && this.search.dom.readerSearchBar.style.display !== 'none')) {
                        this.search.clearSearchState(false)
                    }
                    if (this.annotations.activeDrawer) {
                        this.annotations.closeDrawer()
                    } else if (this.isCurrentlyFullscreen || document.fullscreenElement || document.webkitFullscreenElement) {
                        this.toggleFullscreen()
                    }
                    this.annotations.hideSelectionPopup()
                    this.annotations.hideHighlightActionPopup()
                    break
            }
        }
    }

    toggleFullscreen() {
        if (window.electronAPI?.toggleFullscreen) {
            window.electronAPI.toggleFullscreen()
            return
        }
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            const req = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
            if (req) {
                req.call(document.documentElement).catch(err => console.warn('Fullscreen request failed:', err))
            }
        } else {
            const exit = document.exitFullscreen || document.webkitExitFullscreen
            if (exit) {
                exit.call(document).catch(err => console.warn('Exit fullscreen failed:', err))
            }
        }
    }

    // ==========================================
    // Quote Card Generator Logic
    // ==========================================

    openQuoteCardModal(...args) { return this.cards.openQuoteCardModal(...args) }

    // ==========================================
    // Bookshelf Logic
    // ==========================================

    refreshBookshelf(...args) { return this.bookshelf.refreshBookshelf(...args) }

    handleDeleteBook(...args) { return this.bookshelf.handleDeleteBook(...args) }

    // ==========================================================
    // Custom Reading Lists Management
    // ==========================================================

    openManageBookListsModal(...args) { return this.bookshelf.openManageBookListsModal(...args) }

    // ==========================================
    // Reader Logic
    // ==========================================
    /**
     * Unified reader progress snapshot generator
     * Ensures consistent structure across debounce, closeReader, and flushReaderStateOnExit
     */
    makeProgressSnapshot(session) {
        if (!session || !session.location || !session.snapshot) return null
        const loc = session.location
        const fraction = Number.isFinite(loc.fraction) ? Math.min(1, Math.max(0, loc.fraction)) : 0
        const page = typeof loc.page === 'number' && loc.page >= 1 ? Math.round(loc.page) : null
        const totalPages = typeof loc.totalPages === 'number' && loc.totalPages >= 1 ? Math.round(loc.totalPages) : null
        const cfi = typeof loc.cfi === 'string' ? loc.cfi : null
        const tocItem = loc.tocItem ? { label: loc.tocItem.label || '', href: loc.tocItem.href || '' } : null
        const format = session.bookData?.format || ''
        const snapshot = session.snapshot

        return {
            fraction,
            page,
            totalPages,
            cfi,
            tocItem,
            format,
            yRatio: typeof loc.yRatio === 'number' ? loc.yRatio : null,
            blobRevision: snapshot.blobRevision || null,
            revisionOrigin: snapshot.revisionOrigin || null,
            documentHash: snapshot.documentHash || null,
            updatedAt: Date.now()
        }
    }

    isMobileLayout() {
        if (platformBridge?.isAndroid) return true
        if (window.mobileShell?.isMobileViewport) {
            return window.mobileShell.isMobileViewport()
        }
        if (typeof window !== 'undefined') {
            return window.innerWidth <= 768 || window.matchMedia('(max-width: 768px)').matches
        }
        return false
    }

    async openBook(bookOrId, initialLocation = null, options = {}) {
        const bookId = (typeof bookOrId === 'object' && bookOrId !== null) ? bookOrId.id : bookOrId
        if (!bookId) return this.dialogs.showToast(t('app.bookNotFound'), 'warning')

        // Desktop Multi-Window Architecture:
        // When invoked from the main bookshelf window on desktop, always open/focus an
        // independent satellite reader window so the bookshelf window stays open.
        if (
            !this.isSatelliteReaderWindow &&
            !options?.forceInPlace &&
            !this.isMobileLayout() &&
            !platformBridge.isAndroid
        ) {
            try {
                const winRes = await this.openBookInNewWindow(bookId, initialLocation)
                if (winRes?.success) {
                    return
                }
            } catch (err) {
                console.warn('[openBook] Failed to open satellite window, falling back in-place:', err)
            }
        }

        // 1. Synchronously increment session epoch and clear pending timers
        this._currentBookEpoch = (this._currentBookEpoch || 0) + 1
        const currentEpoch = this._currentBookEpoch
        clearTimeout(this._resizeAppearanceTimer)
        this.pageTurnController?.cancelCurrent()
        this.pageTurnController?.setAdapter(null)
        this.pdfTools.resetSessionState()
        this.drawing.resetSessionState()
        this.search.clearSearchState(true)
        this.navHistory.reset()
        this.cards.resetSessionState()
        this.sections.resetSessionState()
        this.annotations.resetSessionState()
        this._foliatePageIndex = 0

        if (this.currentBookId && this.currentBookId !== bookId) {
            this.chapterTranslationManager?.onCloseBook?.().catch?.(() => {})
        }

        if (this._closeTimer) {
            clearTimeout(this._closeTimer)
            this._closeTimer = null
        }
        if (this._loadingFadeTimer) {
            clearTimeout(this._loadingFadeTimer)
            this._loadingFadeTimer = null
        }
        if (this._progressDebounceTimer) {
            clearTimeout(this._progressDebounceTimer)
            this._progressDebounceTimer = null
        }

        // 2. Create new session with AbortController
        const abortController = new AbortController()
        const readerSession = {
            epoch: currentEpoch,
            bookId,
            abortController,
            isCurrent: () => this._currentBookEpoch === currentEpoch && !abortController.signal.aborted,
            view: null,
            driver: null,
            viewport: null,
            location: null,
            snapshot: null,
            bookData: null,
            toc: null
        }
        const prevSession = this._activeSession
        this._activeSession = readerSession

        if (ttsPlayer.state !== 'stopped' && ttsPlayer.sessionBookOwner?.bookId && ttsPlayer.sessionBookOwner.bookId !== bookId) {
            ttsPlayer.stop()
        }

        // 3. Tear down previous session resources without hiding readerView; synchronously capture and flush prev session progress
        if (prevSession && prevSession !== readerSession) {
            const prevBookId = prevSession.bookId
            const prevProgress = this.makeProgressSnapshot(prevSession)
            const prevLoc = prevSession.location

            prevSession.abortController?.abort()
            this.chapterTranslationManager?.stop?.()
            ttsPlayer.stop()
            if (prevSession.view) {
                try { prevSession.view.close?.() } catch (e) {}
                try { prevSession.view.remove?.() } catch (e) {}
                if (this.foliateView === prevSession.view) this.foliateView = null
            }
            if (prevSession.viewport) {
                try { prevSession.viewport.destroy?.() } catch (e) {}
                if (this.pdfViewport === prevSession.viewport) this.pdfViewport = null
            }
            if (prevSession.driver) {
                try { prevSession.driver.destroy?.() } catch (e) {}
                if (this.pdfDriver === prevSession.driver) this.pdfDriver = null
            }

            if (prevBookId && prevProgress) {
                db.updateBookProgress(prevBookId, prevProgress).catch(err => {
                    console.warn('Failed to flush previous book progress on switch:', err)
                })
            }
            if (prevLoc?.fraction != null) {
                tracker.endSession(prevLoc.fraction).catch(() => {})
            } else {
                tracker.endSession().catch(() => {})
            }
        }

        // Synchronously detach old display state immediately upon entering new session
        this.currentLocation = null
        this.currentBookData = null
        this._currentSnapshot = null
        this.currentBookId = null
        this._foliatePageIndex = 0

        clearTimeout(this._onboardingLaunchTimer)
        this._onboardingLaunchTimer = null
        clearTimeout(this._welcomeCloseTimer)
        this._welcomeCloseTimer = null
        clearTimeout(this._localeGateCloseTimer)
        this._localeGateCloseTimer = null
        if (this.dom.localeOnboardingBackdrop) {
            this.dom.localeOnboardingBackdrop.classList.remove('show')
            this.dom.localeOnboardingBackdrop.style.display = 'none'
        }
        if (this.dom.welcomeModalBackdrop) {
            this.dom.welcomeModalBackdrop.classList.remove('show')
            this.dom.welcomeModalBackdrop.style.display = 'none'
        }
        if (this.onboardingTour?.active) {
            this.onboardingTour.skip()
        }

        try {
            // Ensure recovery barrier has settled before reading book data
            const barrierResult = await this.ensureRecoveryBarrier()
            if (!readerSession.isCurrent()) return

            if (barrierResult?.canProceedSafely && !barrierResult.canProceedSafely(bookId)) {
                this.dialogs.showToast(t('app.recoveryIncompleteToast'), 'warning')
            }

            // 4. Fetch snapshot with content identity
            const snapshot = await db.getBookFileSnapshot(bookId)
            if (!readerSession.isCurrent()) return

            const bookData = (typeof bookOrId === 'object' && bookOrId !== null && bookOrId.title)
                ? { ...snapshot, ...bookOrId }
                : (await db.getBook(bookId)) || snapshot
            if (!readerSession.isCurrent()) return

            await this.appearance.checkBookSpecificSettings(bookId)
            if (!readerSession.isCurrent()) return

            // Handle cloud-only books before requiring local Blob
            if (bookData?.isCloudOnly) {
                return this.sync.handleCloudBookClick(bookData)
            }

            if (!snapshot || !snapshot.blob) {
                this.dialogs.showToast(t('app.cannotReadBookBlob'), 'warning')
                return this.closeReader()
            }

            const targetBlob = snapshot.blob
            if (!targetBlob) {
                this.dialogs.showToast(t('app.cannotReadBookBlob'), 'warning')
                return this.closeReader()
            }

            // Accurately resolve book format - fallback to 'epub', NEVER default to 'pdf'
            let safeFormat = (bookData.format || snapshot.format || '').trim().toLowerCase()
            if (!safeFormat) {
                const candidateName = (bookData.filename || snapshot.filename || bookData.title || (targetBlob instanceof File ? targetBlob.name : '') || '').toLowerCase()
                const extMatch = candidateName.match(/\.([a-z0-9]+)$/i)
                if (extMatch) {
                    safeFormat = extMatch[1].toLowerCase()
                } else if (targetBlob?.type === 'application/pdf') {
                    safeFormat = 'pdf'
                } else if (targetBlob?.type === 'application/epub+zip') {
                    safeFormat = 'epub'
                } else {
                    safeFormat = 'epub'
                }
            }

            const baseTitle = (bookData.title || snapshot.title || 'document').replace(/\.[^/.]+$/, '').trim() || 'document'
            const safeFileName = bookData.filename || snapshot.filename || `${baseTitle}.${safeFormat}`
            if (this.dom.btnChapterTranslate) this.dom.btnChapterTranslate.style.display = FEATURE_CHAPTER_TRANSLATION_ENABLED && !['pdf', 'cbz'].includes(safeFormat) ? 'inline-flex' : 'none'
            if (this.pdfTools.dom.btnPdfSpreadToggle) this.pdfTools.dom.btnPdfSpreadToggle.style.display = ''

            const isPdf = safeFormat === 'pdf' || safeFileName.toLowerCase().endsWith('.pdf')
            const safeFileType = isPdf ? 'application/pdf' : (safeFormat === 'epub' ? 'application/epub+zip' : (targetBlob.type || ''))

            const fileObj = (targetBlob?.isLazySnapshot || targetBlob?.nativeSnapshotOnly || snapshot?.nativeSnapshotOnly)
                ? targetBlob
                : ((targetBlob instanceof File && targetBlob.name && !targetBlob.name.toLowerCase().endsWith('.pdf') && !isPdf)
                    ? targetBlob
                    : new File([targetBlob], safeFileName, { type: safeFileType }))

            if (bookData && !bookData.format && safeFormat) bookData.format = safeFormat;
            this.currentBookFormat = safeFormat;
            readerSession.bookData = bookData
            readerSession.snapshot = snapshot
            this.currentBookId = bookId
            this.currentBookData = bookData
            this._currentSnapshot = snapshot
            this.currentLocation = null
            this._foliatePageIndex = 0
            this.appearance.updateSettingsUI()

            // Keep the current library tab visible until this synchronous handoff.
            this.annotations.dom.sidebarDrawer?.classList.remove('drawer-shelf-mode')
            this.dom.readerView?.classList.remove('closing')
            this.dom.bookshelfView.style.display = 'none'
            this.dom.readerView.style.display = 'block'
            this.dom.readerView.classList.add('active')
            document.documentElement.dataset.startupView = 'ready'
            this.imports.minimizeImportPanel()
            const resolvedBookTitle = bookData.title || snapshot.title || t('app.readingFallbackTitle')
            this.dom.readerBookTitle.innerText = resolvedBookTitle
            this._updateWindowTitle()
            if (this.dom.btnAddToShelf) {
                this.dom.btnAddToShelf.style.display = bookData.isRecentOnly ? 'inline-flex' : 'none'
            }
            if (this.pdfTools.dom.btnOcrPage) {
                this.pdfTools.dom.btnOcrPage.style.display = (bookData.format === 'pdf') ? 'inline-flex' : 'none'
            }
            if (this.pdfTools.dom.btnExportAnnotatedPdf) {
                this.pdfTools.dom.btnExportAnnotatedPdf.style.display = (bookData.format === 'pdf') ? 'inline-flex' : 'none'
            }
            if (this.pdfTools.dom.btnPinRefPage) {
                this.pdfTools.dom.btnPinRefPage.style.display = (bookData.format === 'pdf') ? 'inline-flex' : 'none'
            }
            if (this.dom.btnChapterTranslate) {
                const supported = ['epub', 'txt'].includes(bookData.format)
                this.dom.btnChapterTranslate.disabled = !supported
                this.dom.btnChapterTranslate.title = supported ? t('app.chapterTransSupportedTitle') : t('app.chapterTransUnsupportedTitle')
            }
            window.mobileShell?.beginReaderSessionLoading?.(resolvedBookTitle)

            // Clean up previous views if any
            if (this.pdfViewport && this.pdfViewport !== readerSession.viewport) {
                this.pdfViewport.destroy()
                this.pdfViewport = null
            }
            if (this.pdfTools.dom.pdfZoomBar) {
                this.pdfTools.dom.pdfZoomBar.style.display = 'none'
            }
            if (this.foliateView && this.foliateView !== readerSession.view) {
                this.foliateView.close?.()
                this.foliateView.remove?.()
                this.foliateView = null
            }

            if (isPdf) return await this._openPdfSession({ initialLocation, options, bookId, readerSession, snapshot, bookData, fileObj })
            return await this._openFoliateSession({ initialLocation, bookId, readerSession, snapshot, bookData, fileObj, takePreparedEpub: options.takePreparedEpub })

        } catch (err) {
            const msg = String(err?.message || err).toLowerCase()
            const isPasswordError = err?.name === 'PasswordException' || msg.includes('password') || msg.includes('needs_password')
            if (isPasswordError && readerSession.isCurrent()) {
                const promptTitle = options?.password ? t('app.wrongPasswordPrompt') : t('app.passwordRequiredPrompt')
                const userPassword = await this.dialogs.promptPasswordModal(promptTitle)
                if (!readerSession.isCurrent()) return
                if (userPassword) {
                    return this.openBook(bookOrId, initialLocation, { ...options, password: userPassword })
                }
            }
            if (readerSession.isCurrent()) {
                console.error('Failed to open book in reader:', err)
                this.dialogs.showToast(isPasswordError ? t('app.passwordNeededToast') : t('app.openBookFailedToast', { error: err.message }), 'warning')
                this.closeReader()
            } else {
                try { readerSession.view?.close?.() } catch (e) {}
                try { readerSession.view?.remove?.() } catch (e) {}
                try { readerSession.viewport?.destroy?.() } catch (e) {}
                try { readerSession.driver?.destroy?.() } catch (e) {}
            }
        }
    }

    // Runs inside the owning App session; errors propagate to openBook's existing cleanup.
    async _openPdfSession({ initialLocation, options, bookId, readerSession, snapshot, bookData, fileObj }) {

                // Independent PDF Viewport (no iframe sandbox)
                const nativePath = snapshot.nativePath || await db.getBookNativePath(bookId)
                if (!readerSession.isCurrent()) return

                const isMobile = Boolean(platformBridge?.isAndroid) || (window.mobileShell?.isMobileViewport?.() ?? false) || (typeof window !== 'undefined' && window.innerWidth < 768)
                const isPortraitMobile = isMobile && (typeof window === 'undefined' || window.innerWidth < 768)
                const sessionDriver = new AdaptivePdfDriver({ nativePath, snapshot })
                const sessionViewport = new PdfViewport(this.dom.readerContentArea, {
                    spreadMode: isPortraitMobile ? 'none' : (this.settings.pdfSpreadMode || 'none'),
                    scale: isMobile ? 1.0 : 1.25,
                    deferPdfTextLayer: platformBridge.isAndroid,
                    minScale: 0.1,
                    snapshot,
                    onInitialPageRendered: ({ page, canvas }) => {
                        if (readerSession.isCurrent()) {
                            window.mobileShell?.finishReaderSessionLoading?.()
                        }
                        this.reportInitialPdfFrame(readerSession, sessionViewport, page, canvas)
                    },
                    onSlotMount: (pageIdx, slot) => {
                        if (!readerSession.isCurrent()) return
                        this.drawing.mountPdfOverlayForSlot(pageIdx, slot, readerSession).catch(error => console.warn('[PDF] Drawing overlay:', error))
                    },
                    onSlotUnmount: (pageIdx, slot) => {
                        this.drawing.unmountPdfOverlayForSlot(pageIdx, slot)
                    },
                    onSlotGeometrySync: (pageIdx, slot) => {
                        if (!readerSession.isCurrent()) return
                        this.drawing.syncPdfOverlayGeometryForSlot(pageIdx, slot)
                    },
                    onZoomChange: (scale) => {
                        if (!readerSession.isCurrent()) return
                        this.pdfTools.updatePdfZoomControls(scale, sessionViewport.zoomMode)
                        this.drawing.syncAllPdfOverlays()
                        window.mobileShell?.syncPdfControls()
                    },
                    onAutoScrollStateChange: state => {
                        if (!readerSession.isCurrent()) return
                        const button = document.getElementById('btn-toggle-auto-scroll')
                        button?.classList.toggle('active', state.active)
                        button?.setAttribute('aria-pressed', String(state.active))
                    },
                    onTap: () => {
                        if (readerSession.isCurrent() && !window.mobileShell?.activeSheet && (!this.annotations.activeDrawer || this.annotations.activeDrawer === 'none')) {
                            const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
                            this.requestToggleReaderUI(isMobile ? 60 : 0)
                        }
                    },
                    onOutline: toc => {
                        if (!readerSession.isCurrent()) return
                        this.currentPdfTOC = toc
                        readerSession.toc = toc
                        readerSession.tocIndex = buildPdfTocIndex(toc)
                        this.annotations.renderTOC(toc)
                        const active = pdfTocAtPage(readerSession.tocIndex, sessionViewport.currentPage)
                        if (active?.href) this.annotations.highlightActiveTOCItem(active.href)
                        if (active && readerSession.location) readerSession.location.tocItem = active
                    },
                    onPageChange: (pageIdx, total) => {
                        if (!readerSession.isCurrent()) return
                        window.mobileShell?.syncPdfControls()
                        tracker.resetActivity()
                        tracker.recordPageTurn()

                        const frac = total > 0 ? (pageIdx + 1) / total : 0
                        const loc = { fraction: frac, page: pageIdx + 1, totalPages: total }
                        readerSession.location = loc
                        if (this._activeSession === readerSession) {
                            this.currentLocation = loc
                            this._setReaderPageLabel({ kind: 'pdf', page: pageIdx + 1, total })
                            if (this.dom.progressSlider) {
                                this.dom.progressSlider.value = (frac * 100).toFixed(1)
                            }
                            if (this.dom.progressText) {
                                this.dom.progressText.innerText = `${Math.round(frac * 100)}%`
                            }
                            if (frac >= 0.99) {
                                this._setReaderEta({ kind: 'finishing' })
                            } else if (frac <= 0.005) {
                                this._setReaderEta({ kind: 'unknown' })
                            } else {
                                const paceSecs = tracker.getCurrentPaceSecs()
                                const remainingPages = Math.max(0, total - (pageIdx + 1))
                                const remainingSecs = remainingPages * paceSecs
                                this._setReaderEta({ kind: 'remaining', remainingSecs })
                            }
                        }

                        const activeItem = pdfTocAtPage(readerSession.tocIndex, pageIdx)
                        if (activeItem?.href && this._activeSession === readerSession) {
                            this.annotations.highlightActiveTOCItem(activeItem.href)
                        }
                        if (activeItem) {
                            loc.tocItem = activeItem
                        }

                        // Debounce progress update to db using unified makeProgressSnapshot
                        clearTimeout(this._progressDebounceTimer)
                        this._progressDebounceTimer = setTimeout(() => {
                            if (readerSession.isCurrent() && this.currentBookId === bookId) {
                                const progressSnapshot = this.makeProgressSnapshot(readerSession)
                                if (progressSnapshot) {
                                    db.updateBookProgress(bookId, progressSnapshot).catch(err => console.warn('Failed to update PDF progress:', err))
                                }
                            }
                        }, 500)
                    },
                    onSelection: (selInfo) => {
                        if (!readerSession.isCurrent() || this.drawing.pdfDrawTool) return
                        this.annotations.selectedTextInfo = {
                            text: selInfo.text,
                            formatType: 'pdf',
                            pdfTarget: {
                                page: selInfo.page,
                                rects: selInfo.rects,
                                quads: selInfo.quads || [],
                                pageBounds: selInfo.pageBounds || null,
                                segments: selInfo.segments || null,
                                coordinateVersion: selInfo.coordinateVersion || 'pdf-page-v1',
                            },
                            rect: selInfo.clientRect
                        }
                        this.annotations._frozenSelectionSnapshot = { ...this.annotations.selectedTextInfo }
                        this.annotations.hideHighlightActionPopup()
                        const trimmed = (selInfo.text || '').trim()
                        const dictEnabled = typeof this.dictionaryService?.isEnabled === 'function' ? this.dictionaryService.isEnabled() : (this.dictionaryService?.isEnabled !== false)
                        const isSingleWord = /^[a-zA-Z]+(?:['’-][a-zA-Z]+)?$/.test(trimmed) && dictEnabled
                        const shouldLookUp = isSingleWord && (!selInfo.selectionMode || selInfo.selectionMode === 'word')
                        if (shouldLookUp) {
                            const wordSnapshot = { ...this.annotations.selectedTextInfo }
                            this.annotations.hideSelectionPopup(true)
                            this.annotations.selectedTextInfo = wordSnapshot
                            this.annotations._frozenSelectionSnapshot = wordSnapshot
                            this.cards.showDictionaryCard(wordSnapshot)
                        } else {
                            this.cards.hideDictionaryCard()
                            this.annotations.showSelectionPopup(selInfo.clientRect)
                        }
                    },
                    onSelectionClear: () => {
                        this.annotations.hideSelectionPopup()
                        this.cards.hideDictionaryCard()
                    },
                    onHighlightCreate: async (hl) => {
                        const newHl = {
                            id: 'hl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                            bookId: readerSession.bookId,
                            formatType: 'pdf',
                            text: hl.text,
                            color: '#fef08a',
                            createdAt: Date.now(),
                            chapterTitle: readerSession.location?.tocItem?.label || t('app.defaultBodyChapter'),
                            blobRevision: snapshot.blobRevision,
                            revisionOrigin: snapshot.revisionOrigin,
                            documentHash: snapshot.documentHash,
                            pdfTarget: {
                                page: hl.page,
                                rects: hl.rects,
                                quads: hl.quads || [],
                                pageBounds: hl.pageBounds || null,
                                segments: hl.segments || null,
                                coordinateVersion: hl.coordinateVersion || 'pdf-page-v1',
                            }
                        }
                        await db.saveHighlight(newHl)
                        if (!readerSession.isCurrent()) return
                        const allHls = await db.getHighlightsByBook(readerSession.bookId)
                        if (!readerSession.isCurrent()) return
                        sessionViewport.setHighlights(allHls, snapshot)
                        this.annotations.loadNotesList()
                        this.dialogs.showToast(t('app.highlightNoteAdded'), 'success')
                    },
                    onHighlightClick: (hl, event, customRect) => {
                        if (!readerSession.isCurrent() || this.drawing.pdfDrawTool) return
                        let targetRect = customRect
                        if (!targetRect && event?.target?.classList?.contains('pdf-highlight-rect')) {
                            targetRect = event.target.getBoundingClientRect()
                        }
                        if (!targetRect) {
                            targetRect = {
                                top: window.innerHeight / 2 - 22,
                                left: window.innerWidth / 2 - 110,
                                width: 100,
                                height: 30
                            }
                        }
                        this.annotations.hideSelectionPopup()
                        this.annotations.clickedHighlightInfo = { value: hl.id, id: hl.id, hl, rect: targetRect }
                        this.annotations.showHighlightActionPopup(targetRect)
                    }
                })

                readerSession.driver = sessionDriver
                readerSession.viewport = sessionViewport
                this.pdfDriver = sessionDriver
                this.pdfViewport = sessionViewport

                const initialPageFn = (totalPages) => {
                    if (initialLocation?.page != null && totalPages > 0) {
                        return Math.max(0, Math.min(totalPages - 1, initialLocation.page - 1))
                    }
                    const progressMeta = bookData?.progress
                    if (progressMeta?.blobRevision && !db.isContentIdentityMatching(progressMeta, snapshot).matches) {
                        return 0 // Content replaced, do not reuse old page
                    }
                    const decoded = decodePdfProgress(progressMeta, totalPages)
                    return decoded.page - 1
                }

this.pdfTools.applyPdfPageAppearance()
                if (this.settings.pdfSpreadMode === 'dual' && !isPortraitMobile) {
                    sessionViewport.setSpreadMode?.('dual')
                }
                if (this.pdfTools.dom.btnPdfSpreadToggle) {
                    const spMode = sessionViewport.getSpreadMode ? sessionViewport.getSpreadMode() : (this.settings.pdfSpreadMode || 'none')
                    this.pdfTools.dom.btnPdfSpreadToggle.classList.toggle('active', spMode === 'dual')
                    this.pdfTools.dom.btnPdfSpreadToggle.setAttribute('title', spMode === 'dual' ? t('app.pdfSpreadSingleTitle') : t('app.pdfSpreadDualTitle'))
                }
                if (bookData?.cropSettings) {
                    sessionViewport.setCropSettings(bookData.cropSettings)
                    const cropModeSelect = document.getElementById('setting-pdf-crop-mode')
                    const cropWrap = document.getElementById('pdf-crop-controls-wrap')
                    const cropTb = document.getElementById('setting-pdf-crop-tb')
                    const cropLr = document.getElementById('setting-pdf-crop-lr')
                    const cropTbVal = document.getElementById('setting-pdf-crop-tb-val')
                    const cropLrVal = document.getElementById('setting-pdf-crop-lr-val')
                    if (cropModeSelect) cropModeSelect.value = bookData.cropSettings.mode || 'none'
                    if (cropWrap) cropWrap.style.display = (bookData.cropSettings.mode && bookData.cropSettings.mode !== 'none') ? 'flex' : 'none'
                    const tbVal = bookData.cropSettings.margins?.top || 0
                    const lrVal = bookData.cropSettings.margins?.left || 0
                    if (cropTb) cropTb.value = String(tbVal)
                    if (cropLr) cropLr.value = String(lrVal)
                    if (cropTbVal) cropTbVal.textContent = `${tbVal}%`
                    if (cropLrVal) cropLrVal.textContent = `${lrVal}%`
                }
                const docInfo = await sessionViewport.load(
                    sessionDriver,
                    { blob: fileObj, nativePath, password: options?.password || null },
                    { initialPage: initialPageFn, initialYRatio: initialLocation ? (initialLocation.yRatio ?? 0) :
                        ((!bookData.progress?.blobRevision || db.isContentIdentityMatching(bookData.progress, snapshot).matches) ? (bookData.progress?.yRatio ?? 0) : 0), snapshot }
                )
                if (!this._bootStagesSealed && this.bootStageTimings) {
                    this.bootStageTimings.bookFormat = bookData?.format || 'pdf'
                    this.bootStageTimings.readerBackend = sessionDriver?.kind || 'pdf'
                    this.bootStageTimings.bookTitle = bookData?.title || null
                }
                this.markBootStage?.('driverOpen')
                if (!readerSession.isCurrent()) {
                    sessionViewport.destroy()
                    sessionDriver.destroy()
                    if (this.pdfViewport === sessionViewport) this.pdfViewport = null
                    if (this.pdfDriver === sessionDriver) this.pdfDriver = null
                    return
                }

                this.currentPdfTOC = docInfo.toc || []
                readerSession.toc = docInfo.toc || []

                // Restore saved progress display accurately
                const progressMeta = bookData?.progress
                const isProgressIdentityMatching = !progressMeta || !progressMeta.blobRevision || db.isContentIdentityMatching(progressMeta, snapshot).matches
                const decodedInitial = isProgressIdentityMatching
                    ? decodePdfProgress(progressMeta, docInfo.numPages)
                    : { page: 1, fraction: 0 }
                const displayPage = sessionViewport.currentPage + 1
                const initialFrac = initialLocation?.page != null ? displayPage / docInfo.numPages : decodedInitial.fraction
                const initLoc = { fraction: initialFrac, page: displayPage, totalPages: docInfo.numPages }
                readerSession.location = initLoc
                this.currentLocation = initLoc

                // 加载已有高亮 (filtered by content identity)
                const existingHls = await db.getHighlightsByBook(bookId)
                if (!readerSession.isCurrent()) return
                sessionViewport.setHighlights(existingHls, snapshot)

                if (initialLocation?.page != null && initialLocation?.highlightId) {
                    sessionViewport.pulseHighlight?.(initialLocation.page - 1, initialLocation.highlightId, initialLocation.rects)
                }

                // Apply platform resource budget & connect PageTurnController
                const currentBudget = platformBridge.getResourceBudget()
                const isConstrained = Boolean(
                    currentBudget.isLowMemoryDevice ||
                    !platformBridge.getCapabilities().isWindows ||
                    (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 6)
                )
                const normalCacheBytes = isConstrained
                    ? 32 * 1024 * 1024
                    : Math.round(currentBudget.maxCacheMb * 1024 * 1024 / 2)
                sessionViewport.setResourceBudget({
                    isLowMemoryDevice: isConstrained,
                    bitmapCacheLimitBytes: normalCacheBytes,
                    bufferPages: isConstrained ? 1 : 2,
                    renderConcurrency: isConstrained ? 1 : (currentBudget.maxConcurrent || 2)
                })

                const updateVisibilityBudget = () => {
                    sessionViewport.setResourceBudget({
                        bufferPages: document.hidden ? 0 : (isConstrained ? 1 : 2),
                        bitmapCacheLimitBytes: document.hidden ? 16 * 1024 * 1024 : normalCacheBytes
                    })
                }
                document.addEventListener('visibilitychange', updateVisibilityBudget, {
                    signal: readerSession.abortController.signal
                })
                this.pageTurnController?.setAdapter(new PdfPageTurnAdapter(sessionViewport))
                if (isMobile) {
                    sessionViewport.setZoom('fit-width')
                }

                this.pdfTools.updatePdfZoomControls(sessionViewport.scale, sessionViewport.zoomMode)
                if (this.pdfTools.dom.pdfZoomBar) this.pdfTools.dom.pdfZoomBar.style.display = 'flex'
                this._setReaderPageLabel({ kind: 'pdf', page: displayPage, total: docInfo.numPages })
                if (this.dom.progressSlider) {
                    this.dom.progressSlider.value = (initialFrac * 100).toFixed(1)
                }
                if (this.dom.progressText) {
                    this.dom.progressText.innerText = `${Math.round(initialFrac * 100)}%`
                }
                if (initialFrac >= 0.99) {
                    this._setReaderEta({ kind: 'finishing' })
                } else if (initialFrac <= 0.005) {
                    this._setReaderEta({ kind: 'unknown' })
                } else {
                    const paceSecs = tracker.getCurrentPaceSecs()
                    const remainingPages = Math.max(0, docInfo.numPages - displayPage)
                    const remainingSecs = remainingPages * paceSecs
                    this._setReaderEta({ kind: 'remaining', remainingSecs })
                }

                // 启动阅读计时
                tracker.onTickCallback = ({ seconds, sessionSeconds, todaySeconds, isIdle }) => {
                    if (readerSession.isCurrent()) {
                        const activeSecs = sessionSeconds != null ? sessionSeconds : seconds
                        this._setReaderLiveTimer(activeSecs, isIdle)
                    }
                }
                tracker.startSession(bookId, bookData.title, initialFrac, bookData.author || '')
                db.recordBookOpened(bookId).catch(err => {
                    console.warn('Failed to record book opened for PDF:', err)
                })

                setTimeout(() => {
                    this.pdfTools.restoreBookSessionState(readerSession).catch(error => console.warn('[PDF] Restore reading tools:', error))
                }, 20)

                return
            
    }

    // Runs inside the owning App session; errors propagate to openBook's existing cleanup.
    async _openFoliateSession({ initialLocation, bookId, readerSession, snapshot, bookData, fileObj, takePreparedEpub }) {
const sessionView = document.createElement('foliate-view')
            readerSession.view = sessionView
            this.foliateView = sessionView
            sessionView.style.visibility = 'hidden'
            this.dom.readerContentArea.appendChild(sessionView)

            // Pre-register ALL Events BEFORE calling open / init
            sessionView.addEventListener('relocate', e => {
                if (readerSession.isCurrent()) {
                    readerSession.location = e.detail
                    this.onReaderRelocate(e.detail, readerSession)
                }
            })
            sessionView.addEventListener('load', e => {
                if (readerSession.isCurrent()) {
                    this.sections.onSectionLoaded(e.detail)
                }
            })
            sessionView.addEventListener('section-load-error', e => {
                if (!readerSession.isCurrent()) return
                console.warn('[App] Section load error:', e.detail?.index, e.detail?.error)
                this.dialogs?.showToast?.(t('app.sectionLoadErrorToast'), 'error')
            })

            sessionView.addEventListener('link', async e => {
                if (!readerSession.isCurrent()) return
                const { a, href, href_ } = e.detail || {}
                const targetHref = href || href_ || ''
                
                if (targetHref.startsWith('http://') || targetHref.startsWith('https://') || targetHref.startsWith('mailto:')) {
                    e.preventDefault()
                    try {
                        platformBridge.openExternal(targetHref)
                    } catch (openErr) {
                        console.warn('Failed to open external link:', targetHref, openErr)
                    }
                    return
                }

                const cleanText = (a?.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(【]|[\]）)】]$/g, '')
                const isNumericOrSymbolMark = /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注)\s*[\]）)】]?$/.test(cleanText)
                const isSup = !!(a?.closest('sup, sub, .math-super') || 
                                 a?.querySelector('sup, sub, .math-super') || 
                                 a?.classList?.contains('math-super'))
                const footnoteContainer = a?.parentElement?.closest?.(
                    'ol.duokan-footnote-content, ol.footnotes, ul.footnotes, ' +
                    'li.duokan-footnote-item, li.footnote, li.endnote, ' +
                    'aside[epub\\:type~="footnote"], aside[epub\\:type~="endnote"], ' +
                    'aside[role~="doc-footnote"], aside[role~="doc-endnote"], ' +
                    'aside.footnote, section.footnotes, [role~="doc-footnote"]'
                )
                const isSourceInFootnote = !!footnoteContainer && !a?.matches?.('.duokan-footnote, .epub-footnote, .footnote-ref, [epub\\:type~="noteref"], [role~="doc-noteref"]')
                
                if (isSourceInFootnote) {
                    return
                }

                const targetId = targetHref.includes('#') ? targetHref.split('#')[1] : null
                const isNoteIdPattern = targetId ? /(?:filepos|fn|footnote|note|nt|ftn|ref|[mfw])\d+/i.test(targetId) : false

                const isNoteref = a?.getAttribute('epub:type') === 'noteref' ||
                                  a?.getAttribute('role') === 'doc-noteref' ||
                                  a?.classList?.contains('epub-footnote') ||
                                  a?.classList?.contains('footnote-ref') ||
                                  a?.classList?.contains('duokan-footnote') ||
                                  a?.hasAttribute('data-wr-footernote') ||
                                  a?.hasAttribute('zy-footnote') ||
                                  a?.hasAttribute('data-note') ||
                                  a?.querySelector?.('img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote') ||
                                  a?.classList?.contains('note') ||
                                  isSup ||
                                  (targetId && isNoteIdPattern && (isNumericOrSymbolMark || !cleanText))

                if (isNoteref && targetId) {
                    e.preventDefault()
                    const doc = a?.ownerDocument
                    let targetEl = doc ? (doc.getElementById(targetId) || doc.querySelector(`[name="${CSS.escape(targetId)}"]`)) : null
                    
                    const isTargetBacklink = targetEl && (targetEl.closest('sup, sub, .math-super') || targetEl.tagName === 'SUP' || targetEl.querySelector('sup, sub'))
                    if (isTargetBacklink) {
                        this.cards.hideFootnotePopup()
                        return
                    }

                    let footnoteText = (a?.getAttribute('data-wr-footernote') || a?.getAttribute('zy-footnote') || a?.getAttribute('data-note') || '').trim()
                    if (!footnoteText && targetEl) {
                        footnoteText = this.cards.extractFootnoteFromTarget(targetEl, a)
                    }

                    if (!footnoteText && sessionView?.book) {
                        try {
                            const book = sessionView.book
                            const resolved = book.resolveHref ? (book.resolveHref(targetHref) || (href_ ? book.resolveHref(href_) : null)) : null
                            if (resolved && resolved.index != null) {
                                const targetSec = book.sections[resolved.index]
                                const secDoc = await targetSec?.createDocument?.()
                                if (secDoc) {
                                    const extEl = secDoc.getElementById(targetId) || secDoc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                                    if (extEl) {
                                        if (extEl.closest('sup, sub, .math-super') || extEl.tagName === 'SUP') {
                                            this.cards.hideFootnotePopup()
                                            return
                                        }
                                        footnoteText = this.cards.extractFootnoteFromTarget(extEl, a)
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('External footnote lookup error in link event:', err)
                        }
                    }

                    if (!footnoteText && a) {
                        const img = a.querySelector('img')
                        const imgAlt = (img?.getAttribute('alt') || '').trim()
                        const title = (a.getAttribute('title') || '').trim()
                        const anchorClean = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(【]|[\]）)】]$/g, '')
                        const isTrivial = s => !s || /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注\s*\d*)\s*[\]）)】]?\s*[.、:：\-]?$/.test(s) || s === anchorClean
                        if (imgAlt && !isTrivial(imgAlt)) {
                            footnoteText = imgAlt
                        } else if (title && !isTrivial(title)) {
                            footnoteText = title
                        }
                    }

                    if (footnoteText) {
                        e.preventDefault()
                        const rect = a.getBoundingClientRect()
                        const doc = a.ownerDocument
                        const iframe = doc?.defaultView?.frameElement || sessionView?.shadowRoot?.querySelector('iframe') || sessionView
                        const iframeRect = (iframe || sessionView).getBoundingClientRect()
                        const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                        const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                        let anchorLabel = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(]|[\]）)]$/g, '')
                        if (!anchorLabel && targetId) {
                            const m = targetId.match(/(?:fn|footnote|note|ref)?([0-9\.]+)/i)
                            if (m) anchorLabel = m[1]
                        }
                        const popupTitle = anchorLabel && anchorLabel.length <= 8 ? t('app.footnoteTitleWithLabel', { label: anchorLabel }) : t('app.footnoteTitleDefault')
                        
                        this.cards.showFootnotePopup({
                            title: popupTitle,
                            text: footnoteText,
                            rect: {
                                top: iframeRect.top + ((rect.top || 0) * scaleY),
                                left: iframeRect.left + ((rect.left || 0) * scaleX),
                                width: (rect.width || 40) * scaleX,
                                height: (rect.height || 20) * scaleY
                            }
                        })
                        return
                    }
                }
            })

            sessionView.addEventListener('draw-annotation', e => {
                if (!readerSession.isCurrent()) return
                const { draw, annotation } = e.detail
                const { color = '#facc15', style = 'highlight' } = annotation
                const writingMode = this.settings.writingMode || 'horizontal'
                const rawUnderlineWidth = Number(this.advancedSettings?.config?.underlineWidth)
                const underlineWidth = Number.isFinite(rawUnderlineWidth) ? rawUnderlineWidth : 1.5
                const rawHlOpacity = Number(this.advancedSettings?.config?.highlighterOpacity)
                const highlighterOpacity = Number.isFinite(rawHlOpacity) ? rawHlOpacity : 0.35
                if (style === 'underline') {
                    draw(Overlayer.underline, { color, width: underlineWidth, writingMode })
                } else if (style === 'dashed') {
                    draw(Overlayer.dashed, { color: color === '#facc15' ? '#64748b' : color, width: Math.max(1, underlineWidth * 0.7), writingMode })
                } else if (style === 'squiggly') {
                    draw(Overlayer.squiggly, { color, width: Math.max(1.5, underlineWidth * 1.2), writingMode })
                } else if (style === 'strikethrough') {
                    draw(Overlayer.strikethrough, { color, width: underlineWidth, writingMode })
                } else {
                    draw(Overlayer.highlight, {
                        color,
                        opacity: highlighterOpacity,
                        realisticPen: this.settings.realisticPen !== false,
                        writingMode,
                        annotationId: annotation.id,
                        id: annotation.id
                    })
                }
            })

            // When new section overlay is mounted, draw saved highlights that match current content identity!
            sessionView.addEventListener('create-overlay', async () => {
                if (!readerSession.isCurrent()) return
                const highlights = await db.getHighlightsByBook(readerSession.bookId)
                if (!readerSession.isCurrent()) return
                for (const hl of highlights) {
                    const match = db.isContentIdentityMatching(hl, snapshot)
                    if (!match.matches) {
                        // Do not silently draw unconfirmed or conflicting highlights
                        continue
                    }
                    try {
                        await sessionView.addAnnotation({
                            value: `${hl.cfi}::${hl.style || 'highlight'}`,
                            id: hl.id,
                            color: hl.color,
                            style: hl.style || 'highlight'
                        })
                    } catch (err) {
                        // Section index mismatch handled internally by foliate-js
                    }
                }
            })

            // Clicked an existing highlight on the page!
            sessionView.addEventListener('show-annotation', e => {
                if (!readerSession.isCurrent()) return
                const { value, range } = e.detail
                this.annotations.onHighlightClicked(value, range)
            })

            await sessionView.open(takePreparedEpub?.(snapshot) || fileObj)
            if (!this._bootStagesSealed && this.bootStageTimings) {
                this.bootStageTimings.bookFormat = bookData?.format || 'epub'
                this.bootStageTimings.readerBackend = 'foliate'
                this.bootStageTimings.bookTitle = bookData?.title || null
            }
            this.markBootStage?.('driverOpen')
            if (!readerSession.isCurrent()) {
                sessionView?.close?.()
                sessionView?.remove?.()
                if (this.foliateView === sessionView) {
                    this.foliateView = null
                }
                return
            }
            
            // Set initial styles & flow
            this.appearance.applySettingsToReader()
            this.pageTurnController?.setAdapter(new FoliatePageTurnAdapter(this.foliateView))

            // Restore location with content identity check or jump to initialLocation
            let lastLoc = 0
            const progressMeta = bookData.progress
            const isProgressIdentityMatching = !progressMeta || !progressMeta.blobRevision || db.isContentIdentityMatching(progressMeta, snapshot).matches

            let resolvedSearchCfi = null
            if (initialLocation?.query && initialLocation?.sectionIndex != null && typeof sessionView.search === 'function') {
                try {
                    const targetMatchIndex = initialLocation.matchIndex || 0
                    let currentMatchIdx = 0
                    for await (const match of sessionView.search({ query: initialLocation.query, index: initialLocation.sectionIndex })) {
                        if (match.cfi) {
                            if (currentMatchIdx === targetMatchIndex) {
                                resolvedSearchCfi = match.cfi
                                break
                            }
                            currentMatchIdx++
                        }
                    }
                } catch (searchErr) {
                    console.warn('[openBook] Failed to resolve search CFI:', searchErr)
                }
            }

            if (initialLocation) {
                if (resolvedSearchCfi) {
                    lastLoc = resolvedSearchCfi
                } else if (initialLocation.cfi) {
                    lastLoc = initialLocation.cfi
                } else if (typeof initialLocation === 'string') {
                    lastLoc = initialLocation
                } else if (initialLocation.href) {
                    lastLoc = initialLocation.href
                } else if (initialLocation.sectionIndex != null) {
                    lastLoc = initialLocation.sectionIndex
                } else if (initialLocation.fraction != null) {
                    lastLoc = { fraction: initialLocation.fraction }
                } else if (initialLocation.page != null) {
                    lastLoc = initialLocation.page
                }
            } else if (isProgressIdentityMatching) {
                if (bookData.progress?.cfi && bookData.progress.cfi.split('!')[1]?.split('/').length > 2) {
                    lastLoc = bookData.progress.cfi
                } else if (bookData.progress?.fraction != null && bookData.progress.fraction > 0) {
                    lastLoc = { fraction: bookData.progress.fraction }
                } else if (bookData.progress?.cfi) {
                    lastLoc = bookData.progress.cfi
                }
            }
            await sessionView.init({ lastLocation: lastLoc })
            if (!readerSession.isCurrent()) {
                sessionView?.close?.()
                sessionView?.remove?.()
                if (this.foliateView === sessionView) {
                    this.foliateView = null
                }
                return
            }

            const targetHighlightCfi = resolvedSearchCfi || (initialLocation?.cfi ? initialLocation.cfi : null)
            if (targetHighlightCfi && typeof sessionView.setActiveSearchMatch === 'function') {
                sessionView.setActiveSearchMatch(targetHighlightCfi)
            } else if (initialLocation?.query && !resolvedSearchCfi) {
                this.dialogs.showToast(t('app.searchAnchorExpiredToast'), 'warning')
            }

            // Ensure any already-loaded content doc is initialized
            const contents = sessionView.renderer?.getContents?.() || []
            for (const item of contents) {
                if (item?.doc) this.sections.onSectionLoaded(item)
            }
            sessionView.style.visibility = ''
            window.mobileShell?.finishReaderSessionLoading?.()
            this.reportInitialFoliateFrame(readerSession, sessionView)

            // Start Reading Session & Timer
            const startFrac = (isProgressIdentityMatching && bookData.progress?.fraction) || 0
            tracker.startSession(bookId, bookData.title, startFrac, bookData.author || '')
            db.recordBookOpened(bookId).catch(err => {
                console.warn('Failed to record book opened for EPUB:', err)
            })
            tracker.onTickCallback = ({ seconds, sessionSeconds, todaySeconds, isIdle }) => {
                if (readerSession.isCurrent()) {
                    const activeSecs = sessionSeconds != null ? sessionSeconds : seconds
                    this._setReaderLiveTimer(activeSecs, isIdle)
                }
            }

            // Display floating zoom bar for fixed-layout / comic formats (CBZ), hide for reflow formats (EPUB, MOBI, TXT, DOCX)
            if (sessionView?.isFixedLayout || bookData?.format === 'cbz') {
                if (this.pdfTools.dom.pdfZoomBar) this.pdfTools.dom.pdfZoomBar.style.display = 'flex'
                this.pdfTools.setPDFZoom('fit-page')
            } else {
                if (this.pdfTools.dom.pdfZoomBar) this.pdfTools.dom.pdfZoomBar.style.display = 'none'
            }

            // Defer non-critical TOC and notes population so first page paints with zero delay
            setTimeout(() => {
                if (readerSession.isCurrent() && this.currentBookId === bookId && this.foliateView === sessionView) {
                    this.annotations.renderTOC(sessionView.book?.toc || [])
                    this.annotations.loadNotesList()
                }
            }, 20)
    }

    // Flush pending progress + session time on direct window close (no UI teardown)
    async flushReaderStateOnExit(requestId = null) {
        if (typeof requestId === 'string' && requestId.length > 0) {
            this._activeFlushRequests = this._activeFlushRequests || new Map()
            this._completedFlushRequests = this._completedFlushRequests || new Map()

            if (this._activeFlushRequests.has(requestId)) {
                return this._activeFlushRequests.get(requestId)
            }
            if (this._completedFlushRequests.has(requestId)) {
                return this._completedFlushRequests.get(requestId)
            }
        }

        const doFlush = async () => {
            let progressBackupSaved = false
            let trackerBackupSaved = false

            // 1. Synchronous capture and pre-await backup
            try {
                this.chapterTranslationManager?.stop?.()
                ttsPlayer.stop()
            } catch (_) {}
            try {
                this.foliateView?.renderer?.settle?.()
            } catch (e) {}
            if (this._progressDebounceTimer) {
                clearTimeout(this._progressDebounceTimer)
                this._progressDebounceTimer = null
            }

            const activeSession = this._activeSession
            const activeBookId = this.currentBookId || activeSession?.bookId
            const activeSnapshot = activeSession?.snapshot || this._currentSnapshot
            const activeLocation = activeSession?.location || this.currentLocation
            let progressSnapshot = null

            if (activeSession && activeSession.isCurrent() && activeBookId && activeSnapshot) {
                progressSnapshot = this.makeProgressSnapshot(activeSession)
                if (progressSnapshot) {
                    try {
                        progressBackupSaved = db.backupPendingProgress(activeBookId, progressSnapshot) === true
                    } catch (bErr) {
                        console.warn('flushReaderStateOnExit: progress backup failed:', bErr)
                    }
                }
            }

            const endFrac = Number.isFinite(activeLocation?.fraction) ? activeLocation.fraction : null
            try {
                trackerBackupSaved = tracker.backupPendingSession(endFrac) === true
            } catch (tErr) {
                console.warn('flushReaderStateOnExit: tracker backup failed:', tErr)
            }

            // 2. Decoupled and truly independent asynchronous flushes with bounded timeout (<= 1200ms)
            // Rust closes process after 1500ms; flushes must complete or report backup within 1200ms
            const TIMEOUT_MS = 1200
            let progressTimedOut = false

            const rawProgressPromise = (async () => {
                if (!activeBookId || !progressSnapshot) {
                    return { status: 'not_applicable', saved: false }
                }
                try {
                    const res = await db.updateBookProgress(activeBookId, progressSnapshot)
                    if (res !== false && res !== null) {
                        if (!progressTimedOut) {
                            try {
                                db.clearPendingProgressBackup(activeBookId, progressSnapshot.updatedAt, progressSnapshot._backupId)
                            } catch (cErr) {}
                        }
                        return { status: 'committed', saved: true }
                    } else {
                        return { status: progressBackupSaved ? 'backed_up' : 'failed', saved: false }
                    }
                } catch (pErr) {
                    console.warn('flushReaderStateOnExit: db.updateBookProgress failed:', pErr)
                    return { status: progressBackupSaved ? 'backed_up' : 'failed', saved: false }
                }
            })()

            const boundedProgressPromise = Promise.race([
                rawProgressPromise,
                new Promise(resolve => setTimeout(() => {
                    progressTimedOut = true
                    resolve({ status: progressBackupSaved ? 'backed_up' : 'failed', saved: false, timedOut: true })
                }, TIMEOUT_MS))
            ])

            const rawTrackerPromise = (async () => {
                if (!tracker.isTracking && !tracker._sessionQueueTail) {
                    return { status: 'not_applicable', saved: false }
                }
                try {
                    const res = await tracker.endSession(endFrac, activeBookId)
                    if (res?.status === 'filtered_short_session') {
                        return { status: 'filtered_short_session', saved: false }
                    }
                    if (res?.status === 'not_applicable') {
                        return { status: 'not_applicable', saved: false }
                    }
                    return { status: 'committed', saved: true }
                } catch (eErr) {
                    console.warn('flushReaderStateOnExit: tracker.endSession failed:', eErr)
                    return { status: trackerBackupSaved ? 'backed_up' : 'failed', saved: false }
                }
            })()

            const boundedTrackerPromise = Promise.race([
                rawTrackerPromise,
                new Promise(resolve => setTimeout(() => {
                    resolve({ status: trackerBackupSaved ? 'backed_up' : 'failed', saved: false, timedOut: true })
                }, TIMEOUT_MS))
            ])

            const drawingDrainPromise = this.drawing.flushPendingWrites(TIMEOUT_MS).catch(() => {})
            const [pRes, tRes] = await Promise.all([boundedProgressPromise, boundedTrackerPromise, drawingDrainPromise])

            // 3. Status determination & synthesis
            let status = 'database_success'
            const hasFailure = pRes.status === 'failed' || tRes.status === 'failed'
            const hasBackup = pRes.status === 'backed_up' || tRes.status === 'backed_up'

            if (hasFailure) {
                status = 'failed'
            } else if (hasBackup) {
                status = 'recovery_backup_success'
            } else {
                status = 'database_success'
            }

            const result = {
                status,
                progressStatus: pRes.status,
                trackerStatus: tRes.status,
                progressSaved: pRes.saved,
                trackerSaved: tRes.saved,
                progressBackupSaved,
                trackerBackupSaved
            }

            try {
                this.pdfViewport?.destroy?.()
                this.pdfDriver?.destroy?.()
                if (activeSession?.viewport) activeSession.viewport.destroy?.()
                if (activeSession?.driver) activeSession.driver.destroy?.()
            } catch (dErr) {
                console.warn('flushReaderStateOnExit: pdf driver cleanup error:', dErr)
            }

            try {
                await Promise.race([this.aiSidebar?.flushActiveStreamingMessage?.(), new Promise(r => setTimeout(r, 600))])
            } catch (aErr) {
                console.warn('flushReaderStateOnExit: aiSidebar flush error:', aErr)
            }

            // 4. Close handshake completion: Only call if requestId is a non-empty string
            if (typeof requestId === 'string' && requestId.length > 0) {
                try {
                    platformBridge.flushComplete(requestId)
                } catch (fErr) {
                    console.warn('flushReaderStateOnExit: flushComplete failed:', fErr)
                }

                this._completedFlushRequests = this._completedFlushRequests || new Map()
                this._completedFlushRequests.set(requestId, result)
                if (this._completedFlushRequests.size > 100) {
                    const oldest = this._completedFlushRequests.keys().next().value
                    this._completedFlushRequests.delete(oldest)
                }
            }

            return result
        }

        if (typeof requestId === 'string' && requestId.length > 0) {
            const flushPromise = doFlush()
            this._activeFlushRequests.set(requestId, flushPromise)
            try {
                return await flushPromise
            } finally {
                this._activeFlushRequests.delete(requestId)
            }
        }

        return await doFlush()
    }

    _returnToLibraryView({ deferRefresh = false } = {}) {
        const shell = window.mobileShell
        shell?.setReaderInView(false, { deferRender: deferRefresh })
        if (shell && this.isMobileLayout()) {
            return
        }
        if (this.dom.bookshelfView) {
            this.dom.bookshelfView.style.display = 'flex'
        }
    }

    async closeReader() {
        document.documentElement.dataset.startupView = 'ready'
        this.pdfTools.resetSessionState()
        this.drawing.resetSessionState()
        this.navHistory.reset()
        this.cards.resetSessionState()
        this.sections.resetSessionState()
        this.annotations.resetSessionState()
        this.cancelPendingReaderUIToggle()
        const closingSession = this._activeSession
        if (!closingSession) {
            if (this.isSatelliteReaderWindow) {
                platformBridge.windowClose()
                return
            }
            if (this.dom.readerView) {
                this.dom.readerView.classList.remove('active', 'closing')
                this.dom.readerView.style.display = 'none'
            }
            this._returnToLibraryView()
            this._updateWindowTitle()
            return
        }

        // 1. Immediately and synchronously abort closing session so its callbacks become no-op
        this.pageTurnController?.cancelCurrent()
        this.pageTurnController?.setAdapter(null)
        closingSession.abortController?.abort()
        if (ttsPlayer.state !== 'playing' && ttsPlayer.state !== 'paused') {
            ttsPlayer.stop()
        }
        if (this.dom.ttsPlayerBar) {
            this.dom.ttsPlayerBar.classList.remove('active')
            this.dom.ttsPlayerBar.style.display = 'none'
        }

        // 2. Synchronously capture session's fixed parameters and views
        const closingBookId = closingSession.bookId
        const closingProgress = this.makeProgressSnapshot(closingSession)
        const closingLocation = closingSession.location || this.currentLocation
        const closingFoliateView = closingSession.view || this.foliateView
        const closingPdfViewport = closingSession.viewport || this.pdfViewport
        const closingPdfDriver = closingSession.driver || this.pdfDriver

        // 3. Synchronously detach views from `this` ONLY if they belong to closingSession
        if (this.foliateView === closingFoliateView) this.foliateView = null
        if (this.pdfViewport === closingPdfViewport) this.pdfViewport = null
        if (this.pdfDriver === closingPdfDriver) this.pdfDriver = null
        if (this._activeSession === closingSession) this.currentPdfTOC = null
        this.pageTurnController?.cancelCurrent()
        this.pageTurnController?.setAdapter(null)

        // 4. Synchronously settle paginator and destroy closing views
        try {
            closingFoliateView?.renderer?.settle?.()
        } catch (e) {}
        try { closingFoliateView?.close?.() } catch (e) {}
        try { closingFoliateView?.remove?.() } catch (e) {}
        try { closingPdfViewport?.destroy?.() } catch (e) {}
        try { closingPdfDriver?.destroy?.() } catch (e) {}

        // 5. Clear pending progress debounce timer
        if (this._progressDebounceTimer) {
            clearTimeout(this._progressDebounceTimer)
            this._progressDebounceTimer = null
        }

        // 6. Stop reading tracker
        tracker.onTickCallback = null

        // 7. If active session is still closingSession, clean up active state
        if (this._activeSession === closingSession) {
            this._activeSession = null
            this.currentBookId = null
            this.currentBookData = null
            this._currentSnapshot = null
            this.currentLocation = null
        }

        this.search.clearSearchState(true)
        this.annotations.closeDrawer()
        if (this.annotations.dom.tocContainer) this.annotations.dom.tocContainer.innerHTML = ''
        if (this.search.dom.searchResultsContainer) this.search.dom.searchResultsContainer.innerHTML = ''
        const searchResultsList = document.getElementById('search-results-list')
        if (searchResultsList) searchResultsList.innerHTML = ''
        if (this.annotations.dom.notesContainer) this.annotations.dom.notesContainer.innerHTML = ''
        this.annotations.dom.sidebarDrawer?.classList.add('drawer-shelf-mode')
        this.annotations.switchTab('settings')
        this.annotations.hideSelectionPopup()
        this.annotations.hideHighlightActionPopup()
        this.toggleReaderUI(true)
        // 8. Trigger UI transition only if no new session has started
        if (!this._activeSession) {
            if (!this.isSatelliteReaderWindow) {
                this.dom.readerView.classList.remove('active')
                this.dom.readerView.classList.add('closing')
                this._returnToLibraryView({ deferRefresh: true })
                const library = this.dom.bookshelfView
                if (library.style.display !== 'none') {
                    library.classList.remove('view-spring-transition')
                    void library.offsetWidth
                    library.classList.add('view-spring-transition')
                }

                if (this._closeTimer) clearTimeout(this._closeTimer)
                this._closeTimer = setTimeout(() => {
                    this._closeTimer = null
                    if (!this._activeSession) {
                        this.dom.readerView?.classList.remove('closing')
                        if (this.dom.readerView) this.dom.readerView.style.display = 'none'
                        this.dom.bookshelfView?.classList.remove('view-spring-transition')
                    }
                }, 240)
            }

            this.currentBookFormat = null
            this.currentBookId = null
            this.currentBookData = null
            this._foliatePageIndex = 0
            this.appearance._bookSettingsOverride = null
            this.settings = resolveReaderSettings(this.globalSettings || this.settings, null, READER_OVERRIDE_ALLOWED_KEYS)
            this.appearance.updateBookOverrideUI(false)
            this.chapterTranslationManager?.onCloseBook?.().catch?.(() => {})
            this.appearance.updateSettingsUI()
            if (!this.isSatelliteReaderWindow) {
                this._updateWindowTitle()
            }
            if (typeof coverUrlPool !== 'undefined') {
                coverUrlPool.pruneUnused()
            }
        }

        // 9. Asynchronously flush progress and end tracker using captured parameters
        const closingEpoch = this._currentBookEpoch

        // End tracker independently (do not block progress update)
        if (closingLocation?.fraction != null) {
            tracker.endSession(closingLocation.fraction).catch(err => {
                console.warn('Failed to end tracker session:', err)
            })
        } else {
            tracker.endSession().catch(err => {
                console.warn('Failed to end tracker session:', err)
            })
        }

        // Flush final progress to DB, then refresh the active library view once (guarded by session epoch)
        const progressPromise = (closingBookId && closingProgress)
            ? db.updateBookProgress(closingBookId, closingProgress)
            : Promise.resolve()

        const refreshLibraryAfterClose = () => {
            if (this._currentBookEpoch !== closingEpoch || this._activeSession) return
            const shell = window.mobileShell
            if (shell && this.isMobileLayout() && shell.currentTab !== 'shelf') {
                if (!shell.currentTab || shell.currentTab === 'home') {
                    shell.refreshContinueReadingCard?.()
                } else if (shell.currentTab === 'me') {
                    shell.renderMeTab?.()
                }
                return
            }
            this.bookshelf.refreshBookshelf().then(() => {
                if (closingBookId) {
                    this._lastOpenedBookId = closingBookId
                    this.bookshelf._scrollToBookAnchor(closingBookId)
                }
            }).catch(err => {
                console.warn('Failed to refresh bookshelf after book close:', err)
            })
        }

        progressPromise.then(() => {
            if (this.isSatelliteReaderWindow && !this._activeSession) {
                platformBridge.windowClose()
                return
            }
            refreshLibraryAfterClose()
        }).catch(err => {
            console.warn('Failed to flush final book progress:', err)
            if (this.isSatelliteReaderWindow && !this._activeSession) {
                platformBridge.windowClose()
                return
            }
            refreshLibraryAfterClose()
        })

        if (this.sync.syncConfig?.enabled && this.sync.syncConfig?.autoSyncOnBookClose) {
            this.sync.triggerSilentBackgroundSync()
        }
    }

    onReaderRelocate(detail, session = this._activeSession) {
        if (session) {
            session.location = detail
            if (!session.isCurrent()) return
        }
        if (!this.currentBookId) return
        if (session && this._activeSession !== session) return
        this.cards.hideFootnotePopup()
        if (this.annotations.multiSelectedRanges && this.annotations.multiSelectedRanges.length > 1) {
            this.annotations.renderVirtualMultiSelections()
        }
        const activeBookId = this.currentBookId
        const activeEpoch = this._currentBookEpoch

        // Only record page turns for the initial turn (fast-path or standard), not the debounced settlement
        if (!detail.isSettled) {
            tracker.resetActivity()
            tracker.recordPageTurn()
            this.aiSidebar?.invalidatePendingLayout?.()
        }
        this.currentLocation = detail
        const fraction = Number.isFinite(detail.fraction) ? detail.fraction : 0
        const pctFloat = fraction * 100
        const pctRounded = Math.round(pctFloat)
        const pctDisplay = pctFloat > 0 && pctFloat < 100 && pctFloat % 1 !== 0 
            ? pctFloat.toFixed(1).replace(/\.0$/, '') 
            : `${pctRounded}`

        if (this.dom.progressSlider) {
            this.dom.progressSlider.value = pctFloat.toFixed(1)
        }
        if (this.dom.progressText) {
            this.dom.progressText.innerText = `${pctDisplay}%`
        }
        if (window.mobileShell?.updateReaderProgress) {
            const chName = detail.sectionTitle || detail.chapterTitle || this.currentChapterTitle || ''
            window.mobileShell.updateReaderProgress(pctDisplay, chName)
        }

        // Smart Estimated Time Left (ETA) using Adaptive Dual-State Time Window Engine
        if (this.dom.readerEtaBadge) {
            if (fraction >= 0.99) {
                this._setReaderEta({ kind: 'finishing' })
            } else if (fraction <= 0.005) {
                this._setReaderEta({ kind: 'unknown' })
            } else {
                let remainingSecs = 0
                const paceSecs = tracker.getCurrentPaceSecs()
                const isFixed = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
                
                if (isFixed && detail.totalPages && detail.page && detail.totalPages > detail.page) {
                    // Fixed layout (PDF): exact page count difference
                    const remainingPages = detail.totalPages - detail.page
                    remainingSecs = remainingPages * paceSecs
                } else if (detail.location?.total > 0 && detail.location?.current != null) {
                    // Reflow layout with whole-book location metrics
                    const remainingLocs = Math.max(0, detail.location.total - (detail.location.current + 1))
                    const effectivePace = Math.max(25, paceSecs || 30)
                    const baselineRemaining = remainingLocs * effectivePace
                    const totalActiveSecs = (this.currentBookData?.totalReadingSeconds || 0) + (tracker.sessionCumulativeSeconds || 0)
                    if (totalActiveSecs >= 300 && fraction > 0.05 && fraction < 0.95) {
                        const rawRemaining = (totalActiveSecs / fraction) * (1 - fraction)
                        remainingSecs = Math.min(86400 * 3, Math.max(Math.round(baselineRemaining * 0.5), Math.round(rawRemaining)))
                    } else {
                        remainingSecs = Math.round(baselineRemaining)
                    }
                } else {
                    const totalActiveSecs = (this.currentBookData?.totalReadingSeconds || 0) + (tracker.sessionCumulativeSeconds || 0)
                    if (totalActiveSecs >= 90 && fraction > 0.01) {
                        const rawRemaining = (totalActiveSecs / fraction) * (1 - fraction)
                        remainingSecs = Math.min(86400 * 3, Math.max(60, Math.round(rawRemaining)))
                    } else {
                        const estimatedTotalScreens = Math.max(20, Math.round(1 / Math.max(0.005, fraction || 0.01)))
                        remainingSecs = Math.round((1 - fraction) * Math.min(500, estimatedTotalScreens) * paceSecs)
                    }
                }
                this._setReaderEta({ kind: 'remaining', remainingSecs })
            }
        }

        // PDF Page Index Tracking and Overlay Mount
        const isPdfMode = this.foliateView?.isFixedLayout || this.currentBookData?.format === 'pdf'
        if (isPdfMode) {
            this._foliatePageIndex = (detail.index != null) ? detail.index : (detail.page != null ? detail.page - 1 : 0)
            setTimeout(() => {
                if (this.currentBookId === activeBookId && this._currentBookEpoch === activeEpoch) {
                    this.drawing.renderPdfDrawingOverlayForCurrentPage()
                }
            }, 100)
        }

        // Page Number Indicator
        if (this.dom.readerPageNumber) {
            if (isPdfMode) {
                const p = detail.page != null ? detail.page : (detail.index != null ? detail.index + 1 : 1)
                const totalPdfPages = detail.totalPages || 1
                this._setReaderPageLabel({ kind: 'pdf', page: p, total: totalPdfPages })
            } else if (detail.location?.total > 0) {
                const cur = detail.location.current + 1
                const tot = detail.location.total
                this._setReaderPageLabel({
                    kind: 'bookTotal',
                    cur,
                    tot,
                    secPage: detail.page,
                    secTotal: detail.totalPages,
                    tocLabel: detail.tocItem?.label || ''
                })
            } else if (detail.page != null && detail.totalPages != null) {
                this._setReaderPageLabel({ kind: 'pdf', page: detail.page, total: detail.totalPages })
            } else {
                this._setReaderPageLabel({ kind: 'percent', pctDisplay })
            }
        }

        // Update active TOC item
        if (detail.tocItem) {
            this.annotations.highlightActiveTOCItem(detail.tocItem.href)
        }

        // Save progress to IndexedDB with debounce using unified makeProgressSnapshot
        clearTimeout(this._progressDebounceTimer)
        this._progressDebounceTimer = setTimeout(() => {
            if (session && session.isCurrent() && this._activeSession === session && this.currentBookId === activeBookId) {
                const progressSnapshot = this.makeProgressSnapshot(session)
                if (progressSnapshot) {
                    db.updateBookProgress(activeBookId, progressSnapshot).catch(err => console.warn('Failed to update book progress:', err))
                }
            }
        }, 500)
    }

    cancelPendingReaderUIToggle() {
        if (this._pendingReaderUIToggleTimer) {
            clearTimeout(this._pendingReaderUIToggleTimer)
            this._pendingReaderUIToggleTimer = null
        }
    }

    requestToggleReaderUI(delay = 0, forceState = null) {
        this.cancelPendingReaderUIToggle()
        const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
        const effectiveDelay = isMobile ? Math.min(delay, 80) : delay

        const doToggle = () => {
            this._pendingReaderUIToggleTimer = null

            const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)

            // 1. Suppress if double-click on text happened recently (< 300ms) - only on desktop text clicks (delay > 0)
            if (!isMobile && delay > 0 && this.sections._lastDoubleClickTime && (Date.now() - this.sections._lastDoubleClickTime < 300)) {
                return
            }

            // 2. Suppress if dictionary card, selection popup, highlight popup, paragraph translation card, or footnote popup is currently visible
            const isDictVisible = Boolean(this.cards.dom.readerDictionaryCard?.classList.contains('active') || (this.cards.dom.readerDictionaryCard?.style.display && this.cards.dom.readerDictionaryCard.style.display !== 'none'))
            const isPopupVisible = Boolean(this.annotations.dom.selectionPopup?.classList.contains('active') || (this.annotations.dom.selectionPopup?.style.display && this.annotations.dom.selectionPopup.style.display !== 'none'))
            const isHighlightPopupVisible = Boolean(this.annotations.dom.highlightActionPopup?.classList.contains('active') || (this.annotations.dom.highlightActionPopup?.style.display && this.annotations.dom.highlightActionPopup.style.display !== 'none'))
            const isParaTransVisible = Boolean(this.cards.dom.readerParaTranslationCard?.classList.contains('active') || (this.cards.dom.readerParaTranslationCard?.style.display && this.cards.dom.readerParaTranslationCard.style.display !== 'none'))
            const isFootnoteVisible = Boolean(this.cards.dom.footnotePopup?.classList.contains('active') || (this.cards.dom.footnotePopup?.style.display && this.cards.dom.footnotePopup.style.display !== 'none'))
            if (isDictVisible || isPopupVisible || isHighlightPopupVisible || isParaTransVisible || isFootnoteVisible) {
                this.annotations.hideSelectionPopup()
                this.cards.hideDictionaryCard()
                this.cards.hideParaTranslationCard?.()
                this.cards.hideFootnotePopup()
                this.annotations.hideHighlightActionPopup()
                this.pdfViewport?.clearSelection?.()
                return
            }

            // Once popups are closed, clear any lingering snapshot so it never blocks UI toggle
            this.annotations._frozenSelectionSnapshot = null

            // 3. Suppress if window has text selected
            const winSel = window.getSelection()
            if (winSel && !winSel.isCollapsed && winSel.toString().trim().length > 0) {
                try { winSel.removeAllRanges() } catch {}
                return
            }

            // 4. Suppress if any reader section document has text selected
            try {
                let hasSectionSel = false
                const contents = this.foliateView?.renderer?.getContents?.() || []
                for (const content of contents) {
                    const sel = content?.doc?.getSelection?.()
                    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                        hasSectionSel = true
                        try { sel.removeAllRanges() } catch {}
                    }
                }
                const iframes = this.dom.readerContentArea?.querySelectorAll('iframe') || []
                for (const iframe of iframes) {
                    const docSel = iframe?.contentDocument?.getSelection?.()
                    if (docSel && !docSel.isCollapsed && docSel.toString().trim().length > 0) {
                        hasSectionSel = true
                        try { docSel.removeAllRanges() } catch {}
                    }
                }
                if (hasSectionSel) return
            } catch {}

            this.toggleReaderUI(forceState)
        }

        if (effectiveDelay <= 0) {
            doToggle()
        } else {
            this._pendingReaderUIToggleTimer = setTimeout(doToggle, effectiveDelay)
        }
    }

    toggleReaderUI(forceState) {
        this.cancelPendingReaderUIToggle()
        const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
        const isMobileReader = isMobile && Boolean(
            window.mobileShell?.isInReader ||
            document.body.classList.contains('mobile-reader-active') ||
            this.dom.readerView?.classList.contains('active')
        )
        if (isMobileReader && window.mobileShell && !window.mobileShell.isInReader) {
            window.mobileShell.isInReader = true
            document.body.classList.add('mobile-reader-active')
        }
        if (isMobileReader && forceState == null) {
            forceState = !window.mobileShell?.readerToolsVisible
        }
        if (forceState === true) {
            this.dom.readerTopBar?.classList.remove('autohide')
            this.dom.readerBottomBar?.classList.remove('autohide')
            this.pdfTools.dom.pdfZoomBar?.classList.remove('autohide')
        } else if (forceState === false) {
            this.dom.readerTopBar?.classList.add('autohide')
            this.dom.readerBottomBar?.classList.add('autohide')
            this.pdfTools.dom.pdfZoomBar?.classList.add('autohide')
        } else {
            const isCurrentlyVisible = !this.dom.readerTopBar?.classList.contains('autohide') ||
                                       !this.dom.readerBottomBar?.classList.contains('autohide')
            if (isCurrentlyVisible) {
                this.dom.readerTopBar?.classList.add('autohide')
                this.dom.readerBottomBar?.classList.add('autohide')
                this.pdfTools.dom.pdfZoomBar?.classList.add('autohide')
            } else {
                this.dom.readerTopBar?.classList.remove('autohide')
                this.dom.readerBottomBar?.classList.remove('autohide')
                this.pdfTools.dom.pdfZoomBar?.classList.remove('autohide')
            }
        }

        if (window.mobileShell) {
            const isVisible = forceState !== null ? forceState : !this.dom.readerTopBar?.classList.contains('autohide')
            window.mobileShell.setReaderToolsVisible(isVisible, this.currentBookData?.title || '')
        }
    }

    createHighlight(...args) { return this.annotations.createHighlight(...args) }

    // ==========================================
    // Drawer Management (TOC, Notes, Search, Settings)
    // ==========================================
    openDrawer(...args) { return this.annotations.openDrawer(...args) }

    // Fixed-layout books (PDF / comic) ignore typography & theme settings, so grey
    // those controls out instead of silently doing nothing

    closeDrawer(...args) { return this.annotations.closeDrawer(...args) }

    switchTab(...args) { return this.annotations.switchTab(...args) }

    renderTOC(...args) { return this.annotations.renderTOC(...args) }

    // ==========================================
    // Sample Books Demo & Deduplication
    // ==========================================
    // Safe no-op deduplication helper (never cascade delete user books)

    // ==========================================
    // Reading Statistics Dashboard
    // ==========================================
    renderStatsDashboard(...args) { return this.stats.renderStatsDashboard(...args) }

    // ==========================================================
    // WebDAV & Nutstore Cloud Sync Controller
    // ==========================================================

    openWebdavSyncModal(...args) { return this.sync.openWebdavSyncModal(...args) }

    saveSyncConfig(...args) { return this.sync.saveSyncConfig(...args) }

    testSyncConnection(...args) { return this.sync.testSyncConnection(...args) }

    stopAutoScroll(...args) { return this.pdfTools.stopAutoScroll(...args) }

    pauseAutoScroll(...args) { return this.pdfTools.pauseAutoScroll(...args) }

    resumeAutoScroll(...args) { return this.pdfTools.resumeAutoScroll(...args) }

    openCloudBookPickerUI(...args) { return this.sync.openCloudBookPickerUI(...args) }

    async getBuildInfo() {
        if (this._buildInfo) return this._buildInfo
        try {
            const res = await fetch('./build-info.json')
            if (res.ok) {
                this._buildInfo = await res.json()
                return this._buildInfo
            }
        } catch {}
        return null
    }

    async startOnboardingTour(options = {}) {
        if (!this.onboardingTour) {
            const { OnboardingTourController } = await import('./onboarding-tour.js')
            this.onboardingTour = new OnboardingTourController(this)
            this.onboardingTour.initDOM()
        }
        return this.onboardingTour.start(options)
    }

    // Whole-window cleanup; book/session cleanup remains in closeReader.
    disposeUI() {
        clearTimeout(this._onboardingLaunchTimer)
        clearTimeout(this._welcomeCloseTimer)
        this._onboardingLaunchTimer = null
        this._welcomeCloseTimer = null
        this.onboardingTour?.dispose?.()
        this.rootEvents.dispose()
        this.dialogs.dispose()
        this.stats.dispose()
        this.bookshelf.dispose()
        this.imports.dispose()
        this.sync.dispose()
        this.updates.dispose()
        this.drawing.dispose()
        this.pdfTools.dispose()
        this.search.dispose()
        this.annotations.dispose()
        this.cards.dispose()
        this.appearance.dispose()
        this.sections.dispose()
        this._crossWindowSyncBus?.close()
        clearTimeout(this._crossWindowRefreshTimer)
        this._eventsBound = false
    }

    // Compatibility accessors expose one backing state; internal code uses its owner.
    get shelfCategory() { return this.bookshelf.shelfCategory }
    set shelfCategory(value) { this.bookshelf.shelfCategory = value }
    get customLists() { return this.bookshelf.customLists }
    set customLists(value) { this.bookshelf.customLists = value }
    get syncConfig() { return this.sync.syncConfig }
    set syncConfig(value) { this.sync.syncConfig = value }
    get selectedBookIds() { return this.bookshelf.selectedBookIds }
    set selectedBookIds(value) { this.bookshelf.selectedBookIds = value }
}

export { UniversalReaderApp }

// Expose modules to global window for accessibility and diagnostics
if (typeof window !== 'undefined') {
    window.db = db
    window.tracker = tracker
    window.quoteCard = quoteCard

    // Initialize Application on DOM Ready or immediately if DOMContentLoaded already fired
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', () => {
                window.app = new UniversalReaderApp()
                window.readerApp = window.app
            })
        } else {
            window.app = new UniversalReaderApp()
            window.readerApp = window.app
        }
    }
}
