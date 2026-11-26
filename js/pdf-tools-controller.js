import { DomEvents } from './dom-events.js'
import { pdfPreferenceKey, readPdfPreference } from './pdf-preferences.js'
import * as db from './db.js'
import { PdfViewport } from './pdf-viewport.js'
import { ocrService, parsePageRange, MAX_OCR_PAGES } from './ocr-service.js'
import { t } from './i18n.js'

/** Owns pdfTools UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class PdfToolsController {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()
        this.dom = {}
        this._isPageOcrRunning = false
        this._pageOcrAbortController = null

    }

    refreshLocale() {
        if (this.dom.btnPdfSpreadToggle && this.app.pdfViewport) {
            const spreadMode = this.app.pdfViewport.getSpreadMode ? this.app.pdfViewport.getSpreadMode() : (this.app.settings.pdfSpreadMode || 'none')
            this.dom.btnPdfSpreadToggle.setAttribute('title', spreadMode === 'dual' ? t('pdfTools.switchToSingleTitle') : t('pdfTools.switchToDualTitle'))
        }
        const refPane = this._pdfSplitSession?.pane
        if (refPane) {
            refPane.setAttribute('aria-label', t('pdfTools.refAria'))
            const titleEl = refPane.querySelector('.pdf-reference-title')
            if (titleEl) titleEl.textContent = t('pdfTools.refHeader')
            const prevBtn = refPane.querySelector('[data-ref="prev"]')
            if (prevBtn) { prevBtn.title = t('pdfTools.refPrevTitle'); prevBtn.setAttribute('aria-label', t('pdfTools.refPrevTitle')) }
            const pageInput = refPane.querySelector('[data-ref="page"]')
            if (pageInput) pageInput.setAttribute('aria-label', t('pdfTools.refPageInputAria'))
            const nextBtn = refPane.querySelector('[data-ref="next"]')
            if (nextBtn) { nextBtn.title = t('pdfTools.refNextTitle'); nextBtn.setAttribute('aria-label', t('pdfTools.refNextTitle')) }
            const fitBtn = refPane.querySelector('[data-ref="fit"]')
            if (fitBtn) fitBtn.textContent = t('pdf.fitPageBtn')
            const widthBtn = refPane.querySelector('[data-ref="width"]')
            if (widthBtn) widthBtn.textContent = t('pdf.fitWidthBtn')
            const swapBtn = refPane.querySelector('[data-ref="swap"]')
            if (swapBtn) { swapBtn.title = t('pdfTools.refSwapTitle'); swapBtn.textContent = t('pdfTools.refSwapBtn') }
            const closeBtn = refPane.querySelector('[data-ref="close"]')
            if (closeBtn) { closeBtn.title = t('pdfTools.refCloseTitle'); closeBtn.setAttribute('aria-label', t('pdfTools.refCloseTitle')) }
            this.secondaryPdfViewport?.scrollArea?.setAttribute('aria-label', t('pdfTools.refScrollAreaAria'))
        }
    }

    initDOM() {
        this.dom = {
            btnOcrPage: document.getElementById('btn-ocr-page'),
            btnExportAnnotatedPdf: document.getElementById('btn-export-annotated-pdf'),
            btnPinRefPage: document.getElementById('btn-pin-ref-page'),
            readerPinnedReferencePanel: document.getElementById('reader-pinned-reference-panel'),
            pinnedRefCanvas: document.getElementById('pinned-ref-canvas'),
            pinnedRefPageBadge: document.getElementById('pinned-ref-page-badge'),
            pinnedRefTitleText: document.getElementById('pinned-ref-title-text'),
            btnClosePinnedRef: document.getElementById('btn-close-pinned-ref'),
            btnPinnedRefPrev: document.getElementById('btn-pinned-ref-prev'),
            btnPinnedRefNext: document.getElementById('btn-pinned-ref-next'),
            pdfZoomBar: document.getElementById('pdf-zoom-control-bar'),
            btnPdfZoomOut: document.getElementById('btn-pdf-zoom-out'),
            pdfZoomSlider: document.getElementById('pdf-zoom-slider'),
            btnPdfZoomIn: document.getElementById('btn-pdf-zoom-in'),
            pdfZoomPercentInput: document.getElementById('pdf-zoom-percent-input'),
            btnPdfFitWidth: document.getElementById('btn-pdf-fit-width'),
            btnPdfFitPage: document.getElementById('btn-pdf-fit-page'),
            btnPdfSpreadToggle: document.getElementById('btn-pdf-spread-toggle'),
            btnPdfOcrExtract: document.getElementById('btn-pdf-ocr-extract'),
            modalPdfOcr: document.getElementById('modal-pdf-ocr'),
            btnClosePdfOcr: document.getElementById('btn-close-pdf-ocr'),
            btnCancelPdfOcr: document.getElementById('btn-cancel-pdf-ocr'),
            btnCopyPdfOcr: document.getElementById('btn-copy-pdf-ocr'),
            pdfOcrResultText: document.getElementById('pdf-ocr-result-text'),
            pdfOcrStatusIcon: document.getElementById('pdf-ocr-status-icon'),
            pdfOcrStatusText: document.getElementById('pdf-ocr-status-text'),
            pdfOcrCharCount: document.getElementById('pdf-ocr-char-count'),
            pdfOcrPageRange: document.getElementById('pdf-ocr-page-range'),
            pdfOcrMode: document.getElementById('pdf-ocr-mode'),
            btnStartPdfOcr: document.getElementById('btn-start-pdf-ocr')
        }
    }

    bindEvents() {
        if (this._bound) return
        this._bound = true;
        this.events.on(this.dom.btnOcrPage, 'click', () => this.recognizeCurrentPage());
        this.events.on(this.dom.btnExportAnnotatedPdf, 'click', () => this.exportAnnotatedPdf());
        this.events.on(this.dom.btnPinRefPage, 'click', () => {
            if (!this.app.currentBookId || this.app.currentBookData?.format !== 'pdf') return
            const curPage = (this.app.pdfViewport?.currentPage ?? 0) + 1
            this.pinReferencePage(curPage)
        });
        this.events.on(this.dom.btnClosePinnedRef, 'click', () => this.closePinnedReference());
        this.events.on(this.dom.btnPinnedRefPrev, 'click', () => {
            if (this._pinnedRefPageIndex > 1) this.pinReferencePage(this._pinnedRefPageIndex - 1)
        });
        this.events.on(this.dom.btnPinnedRefNext, 'click', () => {
            this.pinReferencePage((this._pinnedRefPageIndex || 1) + 1)
        });
        this.events.on(document.getElementById('btn-add-page-to-toc'), 'click', async () => {
            if (!this.app.currentBookId) {
                this.app.dialogs.showToast(t('pdfTools.openBookFirst'), 'info')
                return
            }
            await this.addCurrentPageToToc()
            if (this.app.currentPdfTOC) this.app.annotations.renderTOC(this.app.currentPdfTOC)
        });
        this.events.on(document.getElementById('btn-ocr-page-to-toc'), 'click', async () => {
            if (!this.app.currentBookId || this.app.currentBookData?.format !== 'pdf') {
                this.app.dialogs.showToast(t('pdfTools.ocrTocPdfOnly'), 'info')
                return
            }
            this._tocOcrAbortController?.abort()
            const controller = this._tocOcrAbortController = new AbortController()
            const { signal } = controller
            const expectedBookId = this.app.currentBookId
            const expectedBookData = this.app.currentBookData
            const expectedEpoch = this.app._currentBookEpoch
            const targetViewport = this.app.pdfViewport
            const pageIndex = targetViewport?.currentPage ?? 0
            const isStale = () => signal.aborted || this.app.currentBookId !== expectedBookId ||
                this.app.currentBookData !== expectedBookData ||
                (expectedEpoch != null && this.app._currentBookEpoch !== expectedEpoch)
            this.app.dialogs.showToast(t('pdfTools.extractingToc', { page: pageIndex + 1 }), 'info')
            let canvas = null
            try {
                const ocrMod = await import('./ocr-service.js')
                if (isStale()) return
                const activeOcr = ocrMod?.ocrService || ocrMod?.default || ocrMod
                const driver = this.app.pdfDriver || targetViewport?.driver
                const scale = 1.5
                const pageSize = targetViewport?.pageSizes?.[pageIndex] || driver?.pageSizes?.[pageIndex] || null
                if (typeof driver?.renderPageBitmap === 'function') {
                    const bmp = await driver.renderPageBitmap(pageIndex, scale, signal)
                    canvas = bmp?.canvas || bmp
                }
                if (isStale()) return
                if (canvas && activeOcr?.recognizeCanvas) {
                    const result = await activeOcr.recognizeCanvas(canvas, signal, {
                        scale,
                        originX: driver?.kind === 'mupdf' ? (pageSize?.x0 || 0) : 0,
                        originY: driver?.kind === 'mupdf' ? (pageSize?.y0 || 0) : 0
                    })
                    if (isStale()) return
                    if (result?.text) {
                        const lines = result.text.split('\n')
                        await this.parseOcrTocAndApply(lines, 0, { interactiveConfirm: true })
                        if (this.app.currentPdfTOC) this.app.annotations.renderTOC(this.app.currentPdfTOC)
                    }
                }
            } catch (err) {
                if (!isStale()) {
                    this.app.dialogs.showToast(t('pdfTools.ocrTocFailed', { error: err.message || err }), 'warning')
                }
            } finally {
                if (this._tocOcrAbortController === controller) {
                    this._tocOcrAbortController = null
                }
                if (canvas) {
                    canvas.width = 0
                    canvas.height = 0
                    canvas = null
                }
            }
        });
        this.events.on(document.getElementById('btn-export-toc-json'), 'click', async () => {
            if (!this.app.currentBookId) return
            try {
                const json = await this.exportManualToc('json')
                const filename = `${this.app.currentBookData?.title || 'book'}_toc.json`
                if (window.platformBridge?.exportTextFile) {
                    await window.platformBridge.exportTextFile(filename, json, 'application/json')
                }
                this.app.dialogs.showToast(t('pdfTools.tocJsonExported'), 'success')
            } catch (err) {
                this.app.dialogs.showToast(t('pdfTools.exportFailed', { error: err.message || err }), 'warning')
            }
        });
        this.events.on(document.getElementById('btn-export-toc-md'), 'click', async () => {
            if (!this.app.currentBookId) return
            try {
                const md = await this.exportManualToc('markdown')
                const filename = `${this.app.currentBookData?.title || 'book'}_toc.md`
                if (window.platformBridge?.exportTextFile) {
                    await window.platformBridge.exportTextFile(filename, md, 'text/markdown')
                }
                this.app.dialogs.showToast(t('pdfTools.tocMdExported'), 'success')
            } catch (err) {
                this.app.dialogs.showToast(t('pdfTools.exportFailed', { error: err.message || err }), 'warning')
            }
        });
        const cropModeSelect = document.getElementById('setting-pdf-crop-mode');
        const cropWrap = document.getElementById('pdf-crop-controls-wrap');
        const cropTb = document.getElementById('setting-pdf-crop-tb');
        const cropLr = document.getElementById('setting-pdf-crop-lr');
        const cropTbVal = document.getElementById('setting-pdf-crop-tb-val');
        const cropLrVal = document.getElementById('setting-pdf-crop-lr-val');
        const updateCropSettings = () => {
            const mode = cropModeSelect?.value || 'none'
            if (cropWrap) cropWrap.style.display = mode === 'none' ? 'none' : 'flex'
            const tb = parseInt(cropTb?.value || '0', 10)
            const lr = parseInt(cropLr?.value || '0', 10)
            if (cropTbVal) cropTbVal.textContent = `${tb}%`
            if (cropLrVal) cropLrVal.textContent = `${lr}%`
            const settings = {
                mode,
                margins: { top: tb, bottom: tb, left: lr, right: lr },
                oddMargins: { top: tb, bottom: tb, left: lr, right: Math.max(0, lr - 2) },
                evenMargins: { top: tb, bottom: tb, left: Math.max(0, lr - 2), right: lr }
            }
            this.app.pdfViewport?.setCropSettings?.(settings)
            if (this.app.currentBookId) {
                db.updateBook(this.app.currentBookId, { cropSettings: settings }).catch(() => {})
                if (this.app.currentBookData) this.app.currentBookData.cropSettings = settings
            }
        };
        this.events.on(cropModeSelect, 'change', updateCropSettings);
        this.events.on(cropTb, 'input', updateCropSettings);
        this.events.on(cropLr, 'input', updateCropSettings);
        this.events.on(this.dom.btnPdfZoomOut, 'click', () => this.stepPDFZoom(-10));
        this.events.on(this.dom.btnPdfZoomIn, 'click', () => this.stepPDFZoom(10));
        this.events.on(this.dom.pdfZoomSlider, 'input', e => {
            const val = parseFloat(e.target.value) || 100
            this.setPDFZoom(val / 100)
        });
        this.events.on(this.dom.pdfZoomPercentInput, 'focus', e => {
            this._zoomInputInitialVal = e.target.value
            this._zoomCommittedByEnter = false
        });
        this.events.on(this.dom.pdfZoomPercentInput, 'keydown', e => {
            if (e.key === 'Enter') {
                this._zoomCommittedByEnter = true
                this.parseAndSetPDFZoom(e.target.value)
                this._zoomInputInitialVal = e.target.value
                e.target.blur()
            }
        });
        this.events.on(this.dom.pdfZoomPercentInput, 'blur', e => {
            if (this._zoomCommittedByEnter) {
                this._zoomCommittedByEnter = false
                return
            }
            const unchanged = this._zoomInputInitialVal != null && e.target.value === this._zoomInputInitialVal
            this._zoomInputInitialVal = null
            if (unchanged) return
            this.parseAndSetPDFZoom(e.target.value)
        });
        this.events.on(document.getElementById('setting-pdf-page-appearance'), 'change', e => {
            this.app.setSetting('pdfPageAppearance', e.target.value)
            this.applyPdfPageAppearance()
            this.app.saveSettingsDebounced()
        });
        this.events.on(this.dom.btnPdfFitWidth, 'click', () => this.setPDFZoom('fit-width'));
        this.events.on(this.dom.btnPdfFitPage, 'click', () => this.setPDFZoom('fit-page'));
        this.events.on(this.dom.btnPdfSpreadToggle, 'click', () => {
            const isPdf = this.app.currentBookFormat === 'pdf' || this.app.currentBookData?.format === 'pdf' || !!this.app.pdfViewport
            if (isPdf && this.app.pdfViewport) {
                const currentMode = this.app.pdfViewport.getSpreadMode ? this.app.pdfViewport.getSpreadMode() : (this.app.settings.pdfSpreadMode || 'none')
                const nextMode = currentMode === 'dual' ? 'none' : 'dual'
                this.app.pdfViewport.setSpreadMode?.(nextMode)
                this.app.setSetting('pdfSpreadMode', nextMode)
                this.dom.btnPdfSpreadToggle?.classList.toggle('active', nextMode === 'dual')
                this.dom.btnPdfSpreadToggle?.setAttribute('title', nextMode === 'dual' ? t('pdfTools.switchToSingleTitle') : t('pdfTools.switchToDualTitle'))
                this.app.saveSettings()
                this.app.dialogs.showToast(nextMode === 'dual' ? t('pdfTools.switchedToDual') : t('pdfTools.switchedToSingle'), 'book')
                return
            }

            const nextMode = this.app.settings.columnCount === '2' ? '1' : '2'
            this.app.setSetting('columnCount', nextMode)
            if (this.app.appearance.dom.columnCountSelect) this.app.appearance.dom.columnCountSelect.value = nextMode
            this.dom.btnPdfSpreadToggle?.classList.toggle('active', nextMode === '2')
            this.app.saveSettings()
            if (this.app.foliateView?.renderer?.setSpread) {
                this.app.foliateView.renderer.setSpread(nextMode)
            }
            setTimeout(() => {
                this.app.drawing.renderPdfDrawingOverlayForCurrentPage?.()
            }, 180)
            this.app.dialogs.showToast(nextMode === '2' ? t('pdfTools.switchedToDual') : t('pdfTools.switchedToSingle'), 'book')
        });
        this.events.on(this.dom.btnPdfOcrExtract, 'click', () => this.handlePdfOcrExtract());
        this.events.on(this.dom.btnStartPdfOcr, 'click', () => this.startPdfOcrExtraction());
        this.events.on(this.dom.btnClosePdfOcr, 'click', () => this.closePdfOcrModal());
        this.events.on(this.dom.btnCancelPdfOcr, 'click', () => this.closePdfOcrModal());
        this.events.on(this.dom.modalPdfOcr, 'click', e => {
            if (e.target === this.dom.modalPdfOcr) this.closePdfOcrModal()
        });
        this.events.on(this.dom.btnCopyPdfOcr, 'click', () => {
            const text = this.dom.pdfOcrResultText?.value || ''
            if (!text.trim()) {
                this.app.dialogs.showToast(t('pdfTools.ocrNoCopyText'), 'warning')
                return
            }
            navigator.clipboard.writeText(text).then(() => {
                this.app.dialogs.showToast(t('pdfTools.ocrCopied'), 'success')
            }).catch(() => {
                this.app.dialogs.showToast(t('pdfTools.ocrCopyFailed'), 'warning')
            })
        });
        this.initPdfMoreTools();
        this.events.on(document.getElementById('btn-toggle-auto-scroll'), 'click', () => this.toggleAutoScroll());
        this.events.on(document.getElementById('btn-pdf-split-viewport'), 'click', () => this.toggleSecondaryPdfViewport());
        this.events.on(document.getElementById('btn-scan-gray-boost'), 'click', () => this.toggleScanPreset('gray-boost'));
        this.events.on(document.getElementById('btn-scan-text-darken'), 'click', () => this.toggleScanPreset('text-darken'));
    }

    async recognizeCurrentPage() {
        if (!this.app.currentBookId || this.app.currentBookData?.format !== 'pdf') return
        if (this._isPageOcrRunning) {
            this.app.dialogs.showToast(t('pdfTools.recognizingCurrent'), 'info')
            return
        }
        const controller = this._pageOcrAbortController = new AbortController()
        const signal = controller.signal
        this._isPageOcrRunning = true
        const bookId = this.app.currentBookId, viewport = this.app.pdfViewport
        const driver = this.app.pdfDriver || viewport?.driver
        const epoch = this.app._currentBookEpoch
        const pageIndex = viewport?.currentPage ?? 0
        const cacheKey = `linden_ocr_${this.app.currentBookData?.documentHash || bookId}_p${pageIndex}`
        const isStale = () => signal.aborted || this.app.currentBookId !== bookId ||
            this.app.pdfViewport !== viewport || this.app._currentBookEpoch !== epoch || viewport?._destroyed
        let canvas = null
        try {
            const cached = await db.getSetting(cacheKey).catch(() => null)
            if (isStale()) return
            if (Array.isArray(cached) && cached.length) {
                viewport.setPageOcrData(pageIndex, cached)
                this.app.dialogs.showToast(t('pdfTools.textLayerRestored', { page: pageIndex + 1 }), 'info')
                return
            }
            this.app.dialogs.showToast(t('pdfTools.ocringPage', { page: pageIndex + 1 }), 'info')
            const scale = 1.5
            const pageSize = viewport?.pageSizes?.[pageIndex] || null
            const result = typeof driver?.renderPageBitmap === 'function'
                ? await driver.renderPageBitmap(pageIndex, scale, signal)
                : await driver?.renderPage(pageIndex, scale, signal)
            canvas = result?.canvas || (result?.tagName === 'CANVAS' ? result : null)
            if (isStale() || !canvas) return
            const recognized = await ocrService.recognizeCanvas(canvas, signal, {
                scale,
                originX: driver?.kind === 'mupdf' ? (pageSize?.x0 || 0) : 0,
                originY: driver?.kind === 'mupdf' ? (pageSize?.y0 || 0) : 0
            })
            if (isStale()) return
            if (recognized?.spans?.length) {
                viewport.setPageOcrData(pageIndex, recognized.spans)
                await db.setSetting(cacheKey, recognized.spans).catch(() => {})
                if (!isStale()) this.app.dialogs.showToast(t('pdfTools.textLayerCreated', { page: pageIndex + 1 }), 'success')
            } else {
                this.app.dialogs.showToast(t('pdfTools.noTextRecognizedPage', { page: pageIndex + 1 }), 'info')
            }
        } catch (error) {
            if (!isStale()) {
                console.warn('[OCR] page recognition failed:', error)
                this.app.dialogs.showToast(t('pdfTools.ocrFailed', { error: error.message || String(error) }), 'warning')
            }
        } finally {
            if (this._pageOcrAbortController === controller) {
                this._pageOcrAbortController = null
                this._isPageOcrRunning = false
            }
            if (canvas) { canvas.width = 0; canvas.height = 0 }
        }
    }

    closePinnedReference() {
        this._pinnedRefAbortController?.abort()
        this._pinnedRefAbortController = null
        this._pinnedRefEpoch = (this._pinnedRefEpoch || 0) + 1
        if (this.dom.readerPinnedReferencePanel) this.dom.readerPinnedReferencePanel.style.display = 'none'
        if (this.dom.pinnedRefCanvas) {
            this.dom.pinnedRefCanvas.width = 0
            this.dom.pinnedRefCanvas.height = 0
        }
    }

    async restoreBookSessionState(session) {
        if (!session.isCurrent()) return
        const savedToc = await db.getSetting(`linden_manual_toc_${session.bookId}`).catch(() => [])
        if (!session.isCurrent()) return
        this._currentManualToc = Array.isArray(savedToc) ? savedToc : []
        this.restoreBookScanEnhancement(session.bookId)
        this.app.annotations.renderTOC(session.toc || [])
        this.app.annotations.loadNotesList()
    }

    resetSessionState() {
        clearTimeout(this._pdfZoomOverlayTimer)
        this._pageOcrAbortController?.abort()
        this._pageOcrAbortController = null
        this._isPageOcrRunning = false
        this.closePdfOcrModal()
        this.closePinnedReference()
        this.closeSecondaryPdfViewport()
        this.stopAutoScroll()
        this.setPdfMoreToolsOpen(false)
        this._currentManualToc = null
        if (this.dom.pdfZoomBar) this.dom.pdfZoomBar.style.display = 'none'
    }

    dispose() {
        this.resetSessionState()
        this._pdfMoreToolsController?.abort()
        this._pdfMoreToolsObserver?.disconnect()
        this.events.dispose()
        this._bound = false
    }

    applyPdfPageAppearance() {
        const setting = ['auto', 'original', 'night'].includes(this.app.settings.pdfPageAppearance) ? this.app.settings.pdfPageAppearance : 'auto'
        const theme = document.documentElement.getAttribute('data-theme')
        const night = setting === 'night' || (setting === 'auto' && ['dark', 'black'].includes(theme))
        this.app.pdfViewport?.setPageAppearance(night ? 'night' : 'original')
const select = document.getElementById('setting-pdf-page-appearance')
        if (select) select.value = setting
        if (this.dom.btnPdfSpreadToggle && this.app.pdfViewport) {
            const spreadMode = this.app.pdfViewport.getSpreadMode ? this.app.pdfViewport.getSpreadMode() : (this.app.settings.pdfSpreadMode || 'none')
            this.dom.btnPdfSpreadToggle.classList.toggle('active', spreadMode === 'dual')
            this.dom.btnPdfSpreadToggle.setAttribute('title', spreadMode === 'dual' ? t('pdfTools.switchToSingleTitle') : t('pdfTools.switchToDualTitle'))
        }
    }

    updatePdfZoomControls(scale, mode = null) {
        const percentage = Math.round(scale * 100)
        if (this.dom.pdfZoomSlider) {
            if (this.app.pdfViewport?.options) {
                const minPct = Math.round((this.app.pdfViewport.options.minScale ?? 0.1) * 100)
                const maxPct = Math.round((this.app.pdfViewport.options.maxScale ?? 3.5) * 100)
                this.dom.pdfZoomSlider.min = String(minPct)
                this.dom.pdfZoomSlider.max = String(maxPct)
            }
            this.dom.pdfZoomSlider.value = percentage
        }
        if (this.dom.pdfZoomPercentInput) this.dom.pdfZoomPercentInput.value = `${percentage}%`
        this.dom.btnPdfFitWidth?.classList.toggle('active', mode === 'fit-width')
        this.dom.btnPdfFitPage?.classList.toggle('active', mode === 'fit-page')
    }

    setPDFZoom(zoomVal) {
        this.app.pageTurnController?.cancelCurrent()
        if (this.app.pdfViewport) {
            this.app.pdfViewport.setZoom(zoomVal)
            this.updatePdfZoomControls(this.app.pdfViewport.scale, this.app.pdfViewport.zoomMode)
            clearTimeout(this._pdfZoomOverlayTimer)
            this._pdfZoomOverlayTimer = setTimeout(() => {
                this.app.drawing.syncAllPdfOverlays?.()
            }, 80)
            return
        }
        if (!this.app.foliateView?.renderer) return
        let displayStr = '100%'
        let sliderVal = 100

        if (zoomVal === 'fit-width') {
            this.app.foliateView.renderer.setAttribute('zoom', 'fit-width')
            displayStr = t('pdf.fitWidthBtn')
            this.dom.btnPdfFitWidth?.classList.add('active')
            this.dom.btnPdfFitPage?.classList.remove('active')
        } else if (zoomVal === 'fit-page') {
            this.app.foliateView.renderer.setAttribute('zoom', 'fit-page')
            displayStr = t('pdf.fitPageBtn')
            this.dom.btnPdfFitPage?.classList.add('active')
            this.dom.btnPdfFitWidth?.classList.remove('active')
        } else {
            const num = typeof zoomVal === 'number' ? zoomVal : (parseFloat(zoomVal) || 1)
            const clamped = Math.max(0.3, Math.min(3.0, num))
            this.app.foliateView.renderer.setAttribute('zoom', clamped)
            sliderVal = Math.round(clamped * 100)
            displayStr = `${sliderVal}%`
            this.dom.btnPdfFitWidth?.classList.remove('active')
            this.dom.btnPdfFitPage?.classList.remove('active')
        }

        if (this.dom.pdfZoomSlider) this.dom.pdfZoomSlider.value = sliderVal
        if (this.dom.pdfZoomPercentInput) this.dom.pdfZoomPercentInput.value = displayStr

        clearTimeout(this._pdfZoomOverlayTimer)
        this._pdfZoomOverlayTimer = setTimeout(() => {
            this.app.drawing.renderPdfDrawingOverlayForCurrentPage?.()
        }, 120)
    }

    stepPDFZoom(deltaPct) {
        const vp = this.app.pdfViewport
        const minPct = vp ? Math.round((vp.options?.minScale ?? 0.1) * 100) : 30
        const maxPct = vp ? Math.round((vp.options?.maxScale ?? 3.5) * 100) : 300
        const currSliderVal = vp ? Math.round(vp.scale * 100) : (parseFloat(this.dom.pdfZoomSlider?.value) || 100)
        const nextVal = Math.max(minPct, Math.min(maxPct, currSliderVal + deltaPct))
        this.setPDFZoom(nextVal / 100)
    }

    parseAndSetPDFZoom(inputVal) {
        if (!inputVal) return
        const str = String(inputVal).trim().toLowerCase()
        const fitWidthLabel = String(t('pdf.fitWidthBtn') || '').trim().toLowerCase()
        const fitPageLabel = String(t('pdf.fitPageBtn') || '').trim().toLowerCase()
        if (str.includes('宽') || str === 'fit-width' || str === 'fit width' || str === 'width' || str === 'fit w' || (fitWidthLabel && str === fitWidthLabel)) {
            this.setPDFZoom('fit-width')
        } else if (str.includes('页') || str === 'fit-page' || str === 'fit page' || str === 'page' || str === 'auto' || str === 'fit p' || (fitPageLabel && str === fitPageLabel)) {
            this.setPDFZoom('fit-page')
        } else {
            const num = parseFloat(str.replace('%', ''))
            if (Number.isFinite(num) && num > 0) {
                this.setPDFZoom(num / 100)
            } else if (this.app.pdfViewport) {
                this.updatePdfZoomControls(this.app.pdfViewport.scale, this.app.pdfViewport.zoomMode)
            }
        }
    }

    handlePdfOcrExtract() {
        if (!this.dom.modalPdfOcr) return
        clearTimeout(this._pdfOcrCloseTimer)
        this.dom.modalPdfOcr.style.display = 'flex'
        this.dom.modalPdfOcr.classList.add('show')
        if (this._isPdfOcrRunning) return
        const curPage = (this.app.pdfViewport?.currentPage ?? this.app.currentPdfPageIndex ?? 0) + 1
        if (this.dom.pdfOcrPageRange) {
            this.dom.pdfOcrPageRange.value = ''
            this.dom.pdfOcrPageRange.placeholder = t('pdfTools.ocrRangePlaceholder', { page: curPage })
        }
        if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.textContent = ''
        if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = t('pdfTools.ocrStatusReadyPage', { page: curPage })
        if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = ''
        if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = t('pdfTools.ocrCharCount', { count: 0 })
    }

    async startPdfOcrExtraction() {
        if (this._isPdfOcrRunning) {
            this._pdfOcrTaskGeneration = (this._pdfOcrTaskGeneration || 0) + 1
            this._isPdfOcrRunning = false
            ocrService.abort().catch(() => {})
            if (this.dom.btnStartPdfOcr) this.dom.btnStartPdfOcr.innerText = t('pdfTools.ocrStartBtn')
            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = t('pdfTools.ocrStoppedStatus')
            return
        }
        const driver = this.app.pdfDriver || this.app._activeSession?.driver
        if (!driver) { this.app.dialogs.showToast(t('pdfTools.openPdfFirst'), 'warning'); return }
        const curPage = (this.app.pdfViewport?.currentPage ?? this.app.currentPdfPageIndex ?? 0) + 1
        const rangeStr = (this.dom.pdfOcrPageRange?.value || '').trim() || String(curPage)
        const mode = this.dom.pdfOcrMode?.value || 'auto'
        const totalPages = driver.numPages || this.app.pdfViewport?.numPages || this.app.currentLocation?.totalPages || 1
        const check = parsePageRange(rangeStr, totalPages, curPage, MAX_OCR_PAGES)
        if (!check.valid) {
            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = check.error
            this.app.dialogs.showToast(check.error, 'warning')
            return
        }
        const generation = this._pdfOcrTaskGeneration = (this._pdfOcrTaskGeneration || 0) + 1
        const bookId = this.app.currentBookId
        const isCurrent = () => generation === this._pdfOcrTaskGeneration && this.app.currentBookId === bookId &&
            (this.app.pdfDriver || this.app._activeSession?.driver) === driver
        this._isPdfOcrRunning = true
        if (this.dom.btnStartPdfOcr) this.dom.btnStartPdfOcr.innerText = t('pdfTools.ocrStopBtn')
        if (this.dom.pdfOcrStatusIcon) this.dom.pdfOcrStatusIcon.textContent = ''
        if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = ''
        if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = t('pdfTools.ocrCharCount', { count: 0 })
        let completedChars = 0
        try {
            const res = await ocrService.extractText({
                driver, pages: check.pages, mode,
                onProgress: msg => { if (isCurrent() && this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = msg },
                onPageResult: (page, chunk) => {
                    if (!isCurrent()) return
                    if (this.dom.pdfOcrResultText) {
                        const separator = this.dom.pdfOcrResultText.value ? '\n\n' : ''
                        this.dom.pdfOcrResultText.value += separator + chunk
                    }
                    completedChars += page.text?.length || 0
                    if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = t('pdfTools.ocrCharCount', { count: completedChars })
                }
            })
            if (!isCurrent()) return
            if (this.dom.pdfOcrResultText) this.dom.pdfOcrResultText.value = res.fullText || ''
            const count = res.results.reduce((sum, page) => sum + (page.text?.length || 0), 0)
            if (this.dom.pdfOcrCharCount) this.dom.pdfOcrCharCount.innerText = t('pdfTools.ocrCharCount', { count })
            const failed = res.results.filter(page => page.error).length
            const embedded = res.results.filter(page => !page.error && page.source === 'embedded_text').length
            const imageOcr = res.results.filter(page => !page.error && page.source === 'image_ocr').length
            if (this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = !res.success
                ? (res.error || t('pdfTools.ocrIncomplete'))
                : failed ? t('pdfTools.ocrPartialSummary', { done: check.pages.length - failed, total: check.pages.length, embedded, imageOcr })
                : count ? t('pdfTools.ocrDoneSummary', { embedded, imageOcr })
                : mode === 'text_only' ? t('pdfTools.ocrTextOnlyEmpty')
                : t('pdfTools.ocrNoTextTryOther')
        } catch (e) {
            if (isCurrent() && this.dom.pdfOcrStatusText) this.dom.pdfOcrStatusText.innerText = t('pdfTools.ocrExtractFailed', { error: e.message || e })
        } finally {
            if (isCurrent()) {
                this._isPdfOcrRunning = false
                if (this.dom.btnStartPdfOcr) this.dom.btnStartPdfOcr.innerText = t('pdfTools.ocrStartBtn')
            }
        }
    }

    closePdfOcrModal() {
        this._pdfOcrTaskGeneration = (this._pdfOcrTaskGeneration || 0) + 1
        this._isPdfOcrRunning = false
        ocrService.abort().catch(() => {})
        if (this.dom.btnStartPdfOcr) this.dom.btnStartPdfOcr.innerText = t('pdfTools.ocrStartBtn')
        clearTimeout(this._pdfOcrCloseTimer)
        if (this.dom.modalPdfOcr) {
            this.dom.modalPdfOcr.classList.remove('show')
            this._pdfOcrCloseTimer = setTimeout(() => {
                if (this.dom.modalPdfOcr && !this.dom.modalPdfOcr.classList.contains('show')) this.dom.modalPdfOcr.style.display = 'none'
            }, 200)
        }
    }

    async exportAnnotatedPdf() {
        if (!this.app.currentBookId || this.app.currentBookData?.format !== 'pdf') {
            this.app.dialogs.showToast(t('pdfTools.exportAnnotatedPdfOnly'), 'info')
            return
        }
        const docId = this.app.pdfDriver?.docId || this.app.pdfViewport?.driver?.docId || this.app.currentBookData.docId
        if (!docId && !this.app.currentBookData.nativeSnapshotPath) {
            this.app.dialogs.showToast(t('pdfTools.cannotLocateNativePdf'), 'warning')
            return
        }
        const title = this.app.currentBookData.title || 'document'
        const defaultName = `${title}_annotated.pdf`
        let savePath = null
        if (window.platformBridge?.dialogPickSavePath) {
            savePath = await window.platformBridge.dialogPickSavePath({
                defaultName,
                defaultPath: defaultName,
                title: t('pdfTools.saveAnnotatedTitle'),
                filterName: t('pdfTools.pdfFilterName'),
                filterExt: 'pdf'
            })
        }
        if (!savePath) return
        await this.app.drawing?.flushPendingWrites?.()

        const driver = this.app.pdfDriver || this.app.pdfViewport?.driver
        const pageDimsCache = new Map()
        const resolvePageDims = async (page) => {
            const known = this.app.pdfViewport?.pageSizes?.[page] || driver?.pageSizes?.[page]
            if (known?.width > 0 && known?.height > 0) return known
            if (pageDimsCache.has(page)) return pageDimsCache.get(page)
            let loaded = null
            if (typeof driver?.getPageSizes === 'function') {
                try {
                    const arr = await driver.getPageSizes(page, 1)
                    if (arr?.[0]?.width > 0 && arr?.[0]?.height > 0) loaded = arr[0]
                } catch (_) {}
            }
            const resolved = loaded || { width: 612, height: 792, x0: 0, y0: 0 }
            pageDimsCache.set(page, resolved)
            return resolved
        }

        const parseColorWithAlpha = (rawColor, fallbackHex = '#ffeb3b', fallbackAlpha = 1.0) => {
            const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
            const s = String(rawColor || '').trim()
            if (!s) return { hex: fallbackHex, alpha: fallbackAlpha }
            const rgbaMatch = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i)
            if (rgbaMatch) {
                const alpha = rgbaMatch[4] != null ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : fallbackAlpha
                return { hex: toHex(Number(rgbaMatch[1]), Number(rgbaMatch[2]), Number(rgbaMatch[3])), alpha: Number.isFinite(alpha) ? alpha : fallbackAlpha }
            }
            const named = {
                yellow: '#facc15', green: '#22c55e', blue: '#3b82f6', pink: '#ec4899',
                purple: '#a855f7', red: '#ef4444', orange: '#f97316', gray: '#94a3b8'
            }
            if (named[s.toLowerCase()]) return { hex: named[s.toLowerCase()], alpha: fallbackAlpha }
            if (/^#[0-9a-f]{8}$/i.test(s)) {
                const alpha = Math.max(0, Math.min(1, parseInt(s.slice(7, 9), 16) / 255))
                return { hex: `#${s.slice(1, 7).toLowerCase()}`, alpha }
            }
            if (/^#[0-9a-f]{6}$/i.test(s)) {
                return { hex: s.toLowerCase(), alpha: fallbackAlpha }
            }
            if (/^#[0-9a-f]{3}$/i.test(s)) {
                return { hex: `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase(), alpha: fallbackAlpha }
            }
            return { hex: fallbackHex, alpha: fallbackAlpha }
        }

        // Query real highlights and ink drawings for the active book
        const activeDb = this.app.db || db
        const snapshot = this.app.pdfViewport?.snapshot || this.app.pdfDriver?.snapshot || this.app.currentBookData || {}
        let highlights = []
        try {
            if (typeof activeDb?.getHighlightsByBook === 'function') {
                const rawHighlights = (await activeDb.getHighlightsByBook(this.app.currentBookId)) || []
                highlights = typeof activeDb.isContentIdentityMatching === 'function'
                    ? rawHighlights.filter(hl => !hl.blobRevision || activeDb.isContentIdentityMatching(hl, snapshot).matches)
                    : rawHighlights
            }
        } catch (e) {
            console.error('[ExportAnnotatedPdf] Note retrieval failed:', e)
            this.app.dialogs.showToast(t('pdfTools.readAnnotationsFailed', { error: e.message || String(e) }), 'error')
            return
        }
        const numPages = driver?.numPages || this.app.pdfViewport?.numPages || 0
        const items = []

        for (const hl of highlights || []) {
            const segments = (hl.pdfTarget?.segments && hl.pdfTarget.segments.length > 0)
                ? hl.pdfTarget.segments
                : [{
                    page: hl.pdfTarget?.page ?? hl.page ?? 0,
                    quads: hl.pdfTarget?.quads || hl.quads || [],
                    rects: hl.pdfTarget?.rects || (Array.isArray(hl.rects) && hl.rects.length > 0 ? hl.rects : (hl.rect ? [hl.rect] : []))
                }]

            for (const seg of segments) {
                const page = seg.page ?? hl.pdfTarget?.page ?? hl.page ?? 0
                const pageDims = await resolvePageDims(page)
                const pageW = pageDims.width || 612
                const pageH = pageDims.height || 792
                const pageX0 = pageDims.x0 || 0
                const pageY0 = pageDims.y0 || 0

                const quads = (seg.quads || []).flat()
                const rawRects = (seg.rects && seg.rects.length > 0)
                    ? seg.rects
                    : (seg.rect ? [seg.rect] : (hl.pdfTarget?.rects?.length ? hl.pdfTarget.rects : (hl.rect ? [hl.rect] : [])))
                const normalizeRect = (r) => {
                    if (!Array.isArray(r) || r.length < 4) return null
                    if (r[0] <= 1 && r[1] <= 1 && r[2] <= 1 && r[3] <= 1 && (r[2] > 0 || r[3] > 0)) {
                        return [pageX0 + r[0] * pageW, pageY0 + r[1] * pageH, pageX0 + r[2] * pageW, pageY0 + r[3] * pageH]
                    }
                    return [r[0], r[1], r[2], r[3]]
                }
                let rect = null
                const rectQuads = []
                if (quads.length >= 8) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                    for (let i = 0; i < quads.length; i += 2) {
                        minX = Math.min(minX, quads[i])
                        maxX = Math.max(maxX, quads[i])
                        minY = Math.min(minY, quads[i + 1])
                        maxY = Math.max(maxY, quads[i + 1])
                    }
                    rect = [minX, minY, maxX, maxY]
                } else if (rawRects.length > 0) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                    for (const rawR of rawRects) {
                        const nr = normalizeRect(rawR)
                        if (!nr) continue
                        minX = Math.min(minX, nr[0], nr[2])
                        maxX = Math.max(maxX, nr[0], nr[2])
                        minY = Math.min(minY, nr[1], nr[3])
                        maxY = Math.max(maxY, nr[1], nr[3])
                        rectQuads.push(nr[0], nr[1], nr[2], nr[1], nr[0], nr[3], nr[2], nr[3])
                    }
                    rect = Number.isFinite(minX) ? [minX, minY, maxX, maxY] : [pageX0 + 36, pageY0 + 36, pageX0 + 60, pageY0 + 60]
                } else {
                    rect = [pageX0 + 36, pageY0 + 36, pageX0 + 60, pageY0 + 60]
                }

                const rawKind = String(hl.type || hl.style || '').toLowerCase()
                let mappedType = 'highlight'
                if (rawKind === 'underline' || rawKind === 'dashed') mappedType = 'underline'
                else if (rawKind === 'strikeout' || rawKind === 'strike' || rawKind === 'strikethrough') mappedType = 'strikeout'
                else if (rawKind === 'note' || rawKind === 'text') mappedType = 'note'
                else if (rawKind === 'ink' || rawKind === 'drawing') mappedType = 'ink'
                else if (!quads.length && !rawRects.length && hl.note) mappedType = 'note'

                let exportQuads = quads.length >= 8 ? quads : []
                if (!exportQuads.length && (mappedType === 'highlight' || mappedType === 'underline' || mappedType === 'strikeout')) {
                    if (rectQuads.length >= 8) exportQuads = rectQuads
                    else if (rect?.length >= 4) exportQuads = [rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]
                }
                if (mappedType === 'note' && rect?.length >= 4 && (rect[2] - rect[0] < 12 || rect[3] - rect[1] < 12)) {
                    rect = [rect[0], rect[1], rect[0] + 24, rect[1] + 24]
                }

                const hlColor = parseColorWithAlpha(hl.color || '#ffeb3b', '#ffeb3b', hl.opacity ?? 0.8)
                items.push({
                    page,
                    type: mappedType,
                    color: hlColor.hex,
                    opacity: hl.opacity ?? hlColor.alpha,
                    rect: rect || [0, 0, 100, 100],
                    quads: exportQuads.length ? exportQuads : undefined,
                    text: hl.note || hl.text || undefined,
                    author: hl.author || 'Linden Leaf'
                })
            }
        }

        if (typeof activeDb?.getPdfPageDrawing === 'function') {
            const clipIntervalsAgainstCapsule = (ax, ay, bx, by, e1x, e1y, e2x, e2y, radius) => {
                const intervals = []
                const vx = bx - ax
                const vy = by - ay
                const vLenSq = vx * vx + vy * vy

                const addDiskInterval = (cx, cy) => {
                    const ox = ax - cx
                    const oy = ay - cy
                    if (vLenSq < 1e-12) {
                        if (ox * ox + oy * oy <= radius * radius) intervals.push([0, 1])
                        return
                    }
                    const b = 2 * (ox * vx + oy * vy)
                    const c = ox * ox + oy * oy - radius * radius
                    const disc = b * b - 4 * vLenSq * c
                    if (disc < 0) return
                    const sqrtD = Math.sqrt(Math.max(0, disc))
                    const t1 = Math.max(0, (-b - sqrtD) / (2 * vLenSq))
                    const t2 = Math.min(1, (-b + sqrtD) / (2 * vLenSq))
                    if (t1 <= t2) intervals.push([t1, t2])
                }

                addDiskInterval(e1x, e1y)
                addDiskInterval(e2x, e2y)

                const ux = e2x - e1x
                const uy = e2y - e1y
                const uLen = Math.hypot(ux, uy)
                if (uLen > 1e-9) {
                    const uHatX = ux / uLen
                    const uHatY = uy / uLen
                    const nHatX = -uHatY
                    const nHatY = uHatX

                    const solveLinearRange = (f0, fv, minVal, maxVal) => {
                        if (Math.abs(fv) < 1e-12) {
                            return (f0 >= minVal && f0 <= maxVal) ? [0, 1] : null
                        }
                        let tMin = (minVal - f0) / fv
                        let tMax = (maxVal - f0) / fv
                        if (tMin > tMax) {
                            const tmp = tMin
                            tMin = tMax
                            tMax = tmp
                        }
                        const lo = Math.max(0, tMin)
                        const hi = Math.min(1, tMax)
                        return lo <= hi ? [lo, hi] : null
                    }

                    const d0 = (ax - e1x) * nHatX + (ay - e1y) * nHatY
                    const dv = vx * nHatX + vy * nHatY
                    const perpRange = solveLinearRange(d0, dv, -radius, radius)
                    if (perpRange) {
                        const s0 = (ax - e1x) * uHatX + (ay - e1y) * uHatY
                        const sv = vx * uHatX + vy * uHatY
                        const paraRange = solveLinearRange(s0, sv, 0, uLen)
                        if (paraRange) {
                            const lo = Math.max(perpRange[0], paraRange[0])
                            const hi = Math.min(perpRange[1], paraRange[1])
                            if (lo <= hi) intervals.push([lo, hi])
                        }
                    }
                }
                return intervals
            }

            const subtractIntervalsFromUnit = (erasedIntervals) => {
                if (!erasedIntervals.length) return [[0, 1]]
                const sorted = erasedIntervals
                    .map(([a, b]) => [Math.max(0, a), Math.min(1, b)])
                    .filter(([a, b]) => a <= b + 1e-9)
                    .sort((x, y) => x[0] - y[0])
                if (!sorted.length) return [[0, 1]]
                const merged = [sorted[0]]
                for (let k = 1; k < sorted.length; k++) {
                    const prev = merged[merged.length - 1]
                    const cur = sorted[k]
                    if (cur[0] <= prev[1] + 1e-6) {
                        prev[1] = Math.max(prev[1], cur[1])
                    } else {
                        merged.push(cur)
                    }
                }
                const kept = []
                let cursor = 0
                for (const [a, b] of merged) {
                    if (a - cursor > 1e-5) {
                        kept.push([cursor, a])
                    }
                    cursor = Math.max(cursor, b)
                }
                if (1 - cursor > 1e-5) {
                    kept.push([cursor, 1])
                }
                return kept
            }

            for (let p = 0; p < numPages; p++) {
                try {
                    const drawing = await activeDb.getPdfPageDrawing(this.app.currentBookId, p, snapshot)
                    if (drawing?.strokes?.length) {
                        const pageDims = await resolvePageDims(p)
                        const pageW = pageDims.width || 612
                        const pageH = pageDims.height || 792
                        const pageX0 = pageDims.x0 || 0
                        const pageY0 = pageDims.y0 || 0
                        const ptPerVirtualPx = pageW / 800
                        const allStrokes = drawing.strokes
                        const validStrokes = []

                        for (let i = 0; i < allStrokes.length; i++) {
                            const s = allStrokes[i]
                            if (!s || s.tool === 'eraser') continue
                            const pts = Array.isArray(s) ? s : (s.points || [])
                            if (!pts.length) continue
                            const penWidthPt = (Number(s.width ?? drawing.width) || (s.tool === 'marker' ? 18 : 3)) * ptPerVirtualPx

                            // Collect subsequent erasers on this page
                            const erasersAfter = []
                            for (let j = i + 1; j < allStrokes.length; j++) {
                                const er = allStrokes[j]
                                if (!er || er.tool !== 'eraser') continue
                                const erPts = Array.isArray(er) ? er : (er.points || [])
                                if (erPts.length > 0) {
                                    erasersAfter.push({
                                        points: erPts,
                                        width: Number(er.width) || 24,
                                        widthPt: (Number(er.width) || 24) * ptPerVirtualPx
                                    })
                                }
                            }

                            if (pts.length === 1) {
                                const px = (Number(pts[0][0]) || 0) * pageW
                                const py = (Number(pts[0][1]) || 0) * pageH
                                let ptErased = false
                                for (const er of erasersAfter) {
                                    const r = (er.widthPt + penWidthPt) / 2
                                    for (let q = 0; q < er.points.length; q++) {
                                        const e1x = (Number(er.points[q][0]) || 0) * pageW
                                        const e1y = (Number(er.points[q][1]) || 0) * pageH
                                        const e2x = q + 1 < er.points.length ? (Number(er.points[q + 1][0]) || 0) * pageW : e1x
                                        const e2y = q + 1 < er.points.length ? (Number(er.points[q + 1][1]) || 0) * pageH : e1y
                                        if (clipIntervalsAgainstCapsule(px, py, px, py, e1x, e1y, e2x, e2y, r).length > 0) {
                                            ptErased = true
                                            break
                                        }
                                    }
                                    if (ptErased) break
                                }
                                if (!ptErased) {
                                    validStrokes.push({ ...s, points: [pts[0]] })
                                }
                                continue
                            }

                            const remainingSegments = []
                            let currentPolyline = []

                            for (let segIdx = 0; segIdx < pts.length - 1; segIdx++) {
                                const pA = pts[segIdx]
                                const pB = pts[segIdx + 1]
                                const ax = (Number(pA[0]) || 0) * pageW
                                const ay = (Number(pA[1]) || 0) * pageH
                                const bx = (Number(pB[0]) || 0) * pageW
                                const by = (Number(pB[1]) || 0) * pageH

                                const erasedIntervals = []
                                for (const er of erasersAfter) {
                                    const r = (er.widthPt + penWidthPt) / 2
                                    if (er.points.length === 1) {
                                        const ex = (Number(er.points[0][0]) || 0) * pageW
                                        const ey = (Number(er.points[0][1]) || 0) * pageH
                                        erasedIntervals.push(...clipIntervalsAgainstCapsule(ax, ay, bx, by, ex, ey, ex, ey, r))
                                    } else {
                                        for (let q = 0; q < er.points.length - 1; q++) {
                                            const e1x = (Number(er.points[q][0]) || 0) * pageW
                                            const e1y = (Number(er.points[q][1]) || 0) * pageH
                                            const e2x = (Number(er.points[q + 1][0]) || 0) * pageW
                                            const e2y = (Number(er.points[q + 1][1]) || 0) * pageH
                                            erasedIntervals.push(...clipIntervalsAgainstCapsule(ax, ay, bx, by, e1x, e1y, e2x, e2y, r))
                                        }
                                    }
                                }

                                const keptPieces = subtractIntervalsFromUnit(erasedIntervals)
                                if (keptPieces.length === 0) {
                                    if (currentPolyline.length > 0) {
                                        remainingSegments.push(currentPolyline)
                                        currentPolyline = []
                                    }
                                    continue
                                }

                                for (const [t0, t1] of keptPieces) {
                                    const startPt = [
                                        (Number(pA[0]) || 0) + t0 * ((Number(pB[0]) || 0) - (Number(pA[0]) || 0)),
                                        (Number(pA[1]) || 0) + t0 * ((Number(pB[1]) || 0) - (Number(pA[1]) || 0))
                                    ]
                                    const endPt = [
                                        (Number(pA[0]) || 0) + t1 * ((Number(pB[0]) || 0) - (Number(pA[0]) || 0)),
                                        (Number(pA[1]) || 0) + t1 * ((Number(pB[1]) || 0) - (Number(pA[1]) || 0))
                                    ]

                                    if (t0 > 1e-5) {
                                        if (currentPolyline.length > 0) {
                                            remainingSegments.push(currentPolyline)
                                            currentPolyline = []
                                        }
                                    }

                                    if (currentPolyline.length === 0) {
                                        currentPolyline.push(startPt, endPt)
                                    } else {
                                        currentPolyline.push(endPt)
                                    }

                                    if (t1 < 1 - 1e-5) {
                                        remainingSegments.push(currentPolyline)
                                        currentPolyline = []
                                    }
                                }
                            }

                            if (currentPolyline.length > 0) {
                                remainingSegments.push(currentPolyline)
                            }

                            for (const seg of remainingSegments) {
                                if (seg.length > 0) {
                                    validStrokes.push({
                                        ...s,
                                        points: seg
                                    })
                                }
                            }
                        }

                        if (validStrokes.length > 0) {

                            // Group strokes by style { color, opacity, width }
                            const strokeGroups = new Map()
                            for (const s of validStrokes) {
                                const pts = Array.isArray(s) ? s : (s.points || [])
                                if (pts.length === 0) continue
                                const rawColor = s.color || drawing.color || (s.tool === 'marker' ? 'rgba(250, 204, 21, 0.45)' : '#ef4444')
                                const defaultAlpha = s.tool === 'marker' ? 0.45 : 1.0
                                const parsed = parseColorWithAlpha(rawColor, '#ef4444', defaultAlpha)
                                const opacity = s.opacity ?? drawing.opacity ?? parsed.alpha
                                const rawWidth = Number(s.width ?? drawing.width) || (s.tool === 'marker' ? 18 : 3)
                                const width = Math.max(0.5, rawWidth * ptPerVirtualPx)
                                const key = `${parsed.hex}__${opacity}__${width}`
                                if (!strokeGroups.has(key)) {
                                    strokeGroups.set(key, { color: parsed.hex, opacity, width, pointLists: [] })
                                }
                                const mappedPts = pts.map(pt => [
                                    pageX0 + (Number(pt[0]) || 0) * pageW,
                                    pageY0 + (Number(pt[1]) || 0) * pageH
                                ])
                                if (mappedPts.length === 1) {
                                    mappedPts.push([mappedPts[0][0] + 0.05, mappedPts[0][1]])
                                }
                                strokeGroups.get(key).pointLists.push(mappedPts)
                            }

                            for (const g of strokeGroups.values()) {
                                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
                                for (const pl of g.pointLists) {
                                    for (const [px, py] of pl) {
                                        if (px < minX) minX = px
                                        if (px > maxX) maxX = px
                                        if (py < minY) minY = py
                                        if (py > maxY) maxY = py
                                    }
                                }
                                items.push({
                                    page: p,
                                    type: 'ink',
                                    color: g.color,
                                    opacity: g.opacity,
                                    rect: Number.isFinite(minX) ? [minX, minY, Math.max(minX + 1, maxX), Math.max(minY + 1, maxY)] : [0, 0, pageW, pageH],
                                    width: g.width,
                                    strokes: g.pointLists
                                })
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        try {
            const res = await window.platformBridge.mupdfExportAnnotatedPdf(docId, savePath, JSON.stringify(items))
            if (res === true || res?.success) {
                this.app.dialogs.showToast(t('pdfTools.annotationsExportedPath', { path: savePath }), 'success')
            } else {
                this.app.dialogs.showToast(t('pdfTools.exportFailed', { error: res?.error || t('pdfTools.copyNotCreated') }), 'warning')
            }
        } catch (err) {
            console.warn('[ExportAnnotatedPdf] failed:', err)
            this.app.dialogs.showToast(t('pdfTools.exportFailed', { error: err.message || String(err) }), 'warning')
        }
    }

    async pinReferencePage(pageIndex, title = null) {
        if (!this.dom.readerPinnedReferencePanel) return
        const resolvedTitle = title || t('pdfTools.pinDefaultTitle')
        const maxPages = this.app.pdfDriver?.numPages || this.app.pdfViewport?.numPages || 1
        const clampedPage = Math.max(1, Math.min(pageIndex, maxPages))
        this._pinnedRefPageIndex = clampedPage
        this.dom.readerPinnedReferencePanel.style.display = 'flex'
        if (this.dom.pinnedRefPageBadge) this.dom.pinnedRefPageBadge.textContent = `${clampedPage}/${maxPages}`
        if (this.dom.pinnedRefTitleText) this.dom.pinnedRefTitleText.textContent = resolvedTitle

        // Abort previous in-flight render and bump generation epoch
        if (this._pinnedRefAbortController) {
            this._pinnedRefAbortController.abort()
        }
        const abortController = new AbortController()
        this._pinnedRefAbortController = abortController
        this._pinnedRefEpoch = (this._pinnedRefEpoch || 0) + 1
        const currentEpoch = this._pinnedRefEpoch

        const driver = this.app.pdfDriver || this.app.pdfViewport?.driver
        if (driver && this.dom.pinnedRefCanvas) {
            let bmp = null
            try {
                if (typeof driver.renderPageBitmap === 'function') {
                    bmp = await driver.renderPageBitmap(clampedPage - 1, 0.4, abortController.signal)
                } else if (typeof driver.renderPage === 'function') {
                    const canvas = await driver.renderPage(clampedPage - 1, 0.4, abortController.signal)
                    bmp = { canvas, width: canvas?.width || 0, height: canvas?.height || 0 }
                }
                if (abortController.signal.aborted || this._pinnedRefEpoch !== currentEpoch) return
                if (bmp?.canvas && this.dom.pinnedRefCanvas) {
                    const targetCanvas = this.dom.pinnedRefCanvas
                    targetCanvas.width = bmp.canvas.width
                    targetCanvas.height = bmp.canvas.height
                    const ctx = targetCanvas.getContext('2d')
                    ctx.drawImage(bmp.canvas, 0, 0)
                }
            } catch (err) {
                if (!abortController.signal.aborted) {
                    console.warn('Failed to render pinned reference page:', err)
                }
            } finally {
                if (bmp?.canvas && bmp.canvas !== this.dom.pinnedRefCanvas) {
                    bmp.canvas.width = 0
                    bmp.canvas.height = 0
                }
            }
        }
    }

    async addCurrentPageToToc(customTitle = null, parentId = null) {
        if (!this.app.currentBookId) {
            this.app.dialogs.showToast(t('pdfTools.openBookFirst'), 'warning')
            return null
        }
        const { addManualTocItem } = await import('./pdf-toc.js')
        const pageIndex = this.app.pdfViewport?.currentPage ?? (this.app.currentPage || 0)
        const title = customTitle || t('pdfTools.pageTitle', { page: pageIndex + 1 })
        const list = this._currentManualToc || []
        const updated = addManualTocItem(list, {
            title,
            pageIndex,
            parentId,
            documentIdentity: this.app.currentBookData?.documentHash || this.app.currentBookId
        }, { maxPages: this.app.pdfViewport?.numPages })
        this._currentManualToc = updated
        try {
            await db.setSetting(`linden_manual_toc_${this.app.currentBookId}`, updated)
        } catch (_) {}
        this.app.annotations.renderTOC?.(this.app.currentPdfTOC || [])
        this.app.dialogs.showToast(t('pdfTools.addedPageToToc'))
        return updated
    }

    async updateManualTocItem(id, updates, expected = null) {
        if (!this.app.currentBookId || !this._currentManualToc) return null
        const bookId = this.app.currentBookId, epoch = this.app._currentBookEpoch
        const { updateManualTocItem } = await import('./pdf-toc.js')
        if (this.app.currentBookId !== bookId || this.app._currentBookEpoch !== epoch || (expected && (expected.bookId !== bookId || expected.epoch !== epoch))) return null
        const updated = updateManualTocItem(this._currentManualToc, id, updates, { maxPages: this.app.pdfViewport?.numPages })
        await db.setSetting(`linden_manual_toc_${bookId}`, updated)
        if (this.app.currentBookId === bookId && this.app._currentBookEpoch === epoch) {
            this._currentManualToc = updated
            this.app.annotations.renderTOC?.(this.app.currentPdfTOC || [])
        }
        return updated
    }

    async editManualTocItemUI(item) {
        if (!item || !this.app.currentBookId) return
        const bookId = this.app.currentBookId, epoch = this.app._currentBookEpoch, viewport = this.app.pdfViewport
        const list = this._currentManualToc || []
        const current = list.find(x => x.id === item.id)
        if (!current) return
        const descendants = new Set([current.id])
        let changed = true
        while (changed) {
            changed = false
            for (const entry of list) if (descendants.has(entry.parentId) && !descendants.has(entry.id)) { descendants.add(entry.id); changed = true }
        }
        const fields = [
            { name:'title', label:t('pdfTools.tocFieldTitle'), value:current.title, required:true },
            { name:'page', label:t('pdfTools.tocFieldPage'), type:'number', min:1, max:viewport?.numPages || 1, step:1, value:current.pageIndex + 1, required:true },
            { name:'parent', label:t('pdfTools.tocFieldParent'), value:current.parentId || '', options:[{ value:'', label:t('pdfTools.tocTopLevel') }, ...list.filter(x => !descendants.has(x.id)).map(x => ({ value:x.id, label:x.title }))] }
        ]
        fields.validate = v => !v.title.trim() ? t('pdfTools.tocTitleRequired') : (!Number.isInteger(Number(v.page)) || Number(v.page) < 1 || Number(v.page) > (viewport?.numPages || 0) ? t('pdfTools.tocPageOutOfRange') : '')
        const result = await this.app.dialogs.showReaderFieldsDialog(t('pdfTools.tocEditDialogTitle'), fields)
        if (!result || this.app.currentBookId !== bookId || this.app._currentBookEpoch !== epoch || this.app.pdfViewport !== viewport) return
        try {
            const updated = await this.updateManualTocItem(current.id, { title:result.title.trim(), pageIndex:Number(result.page)-1, parentId:result.parent || null }, { bookId, epoch })
            if (updated && this.app.currentBookId === bookId && this.app._currentBookEpoch === epoch) this.app.dialogs.showToast(t('pdfTools.tocItemUpdated'))
        } catch (err) { this.app.dialogs.showToast(t('pdfTools.tocItemUpdateFailed', { error: err.message }), 'warning') }
    }

    async deleteManualTocItem(id) {
        if (!this.app.currentBookId || !this._currentManualToc) return null
        const { deleteManualTocItem } = await import('./pdf-toc.js')
        const updated = deleteManualTocItem(this._currentManualToc, id)
        this._currentManualToc = updated
        try {
            await db.setSetting(`linden_manual_toc_${this.app.currentBookId}`, updated)
        } catch (_) {}
        this.app.annotations.renderTOC?.(this.app.currentPdfTOC || [])
        return updated
    }

    async reorderManualToc(orderedIds) {
        if (!this.app.currentBookId || !this._currentManualToc) return null
        const { reorderManualTocItems } = await import('./pdf-toc.js')
        const updated = reorderManualTocItems(this._currentManualToc, orderedIds)
        this._currentManualToc = updated
        try {
            await db.setSetting(`linden_manual_toc_${this.app.currentBookId}`, updated)
        } catch (_) {}
        this.app.annotations.renderTOC?.(this.app.currentPdfTOC || [])
        return updated
    }

    async parseOcrTocAndApply(ocrLines, pageOffset = 0, options = {}) {
        if (!this.app.currentBookId) return []
        const expectedBookId = this.app.currentBookId
        const expectedBookData = this.app.currentBookData
        const expectedEpoch = this.app._currentBookEpoch ?? this.app._readerEpoch
        const { parseOcrTocCandidates, addManualTocItem } = await import('./pdf-toc.js')
        let finalOffset = Number(pageOffset) || 0
        if (options.interactiveConfirm && typeof this.app.dialogs.showInputDialog === 'function') {
            const previewList = parseOcrTocCandidates(ocrLines, {
                pageOffset: finalOffset,
                totalPages: this.app.pdfViewport?.numPages
            })
            if (previewList.length === 0) {
                this.app.dialogs.showToast(t('pdfTools.ocrTocNoRows'), 'warning')
                return []
            }
            const sampleSummary = previewList.slice(0, 5).map(c => t('pdfTools.ocrTocPreviewItem', { title: c.title, page: c.pageIndex + 1 })).join(t('pdfTools.ocrTocPreviewSep'))
            const offsetInput = await this.app.dialogs.showInputDialog({
                title: t('pdfTools.ocrTocConfirmTitle'),
                message: t('pdfTools.ocrTocConfirmMsg', { count: previewList.length, preview: sampleSummary }),
                value: String(finalOffset),
                confirmText: t('pdfTools.ocrTocApplyBtn'),
                cancelText: t('common.cancel')
            })
            if (offsetInput === null) return []
            if (
                this.app.currentBookId !== expectedBookId ||
                (expectedBookData && this.app.currentBookData && this.app.currentBookData !== expectedBookData) ||
                (expectedEpoch != null && (this.app._currentBookEpoch ?? this.app._readerEpoch) !== expectedEpoch)
            ) {
                return []
            }
            finalOffset = parseInt(offsetInput, 10) || 0
        }
        const candidates = parseOcrTocCandidates(ocrLines, {
            pageOffset: finalOffset,
            totalPages: this.app.pdfViewport?.numPages
        })
        if (candidates.length === 0) {
            this.app.dialogs.showToast(t('pdfTools.ocrTocNoRows'), 'warning')
            return []
        }
        let list = this._currentManualToc || []
        for (const cand of candidates) {
            list = addManualTocItem(list, {
                title: cand.title,
                pageIndex: cand.pageIndex,
                pageLabel: cand.pageLabel,
                documentIdentity: this.app.currentBookData?.documentHash || this.app.currentBookId
            }, { maxPages: this.app.pdfViewport?.numPages })
        }
        this._currentManualToc = list
        try {
            await db.setSetting(`linden_manual_toc_${this.app.currentBookId}`, list)
        } catch (_) {}
        this.app.annotations.renderTOC?.(this.app.currentPdfTOC || [])
        this.app.dialogs.showToast(t('pdfTools.ocrTocAddedCount', { count: candidates.length }))
        return candidates
    }

    async exportManualToc(format = 'markdown') {
        const { exportTocAsMarkdown, exportTocAsJson } = await import('./pdf-toc.js')
        const items = this._currentManualToc || []
        if (format === 'json') {
            return exportTocAsJson(items, {
                bookId: this.app.currentBookId,
                title: this.app.currentBookData?.title,
                documentHash: this.app.currentBookData?.documentHash
            })
        }
        return exportTocAsMarkdown(items)
    }

    applyScanEnhancement(preset = 'original', customParams = null) {
        const state = this.app.pdfViewport?.setScanEnhancementPreset(preset, customParams)
        if (this.app.currentBookId) {
            try {
                localStorage.setItem(pdfPreferenceKey(this.app.currentBookId, 'scan'), JSON.stringify({ preset, customParams }))
            } catch (_) {}
        }
        return state
    }

    resetScanEnhancement() {
        if (this.app.currentBookId) {
            try {
                localStorage.removeItem(pdfPreferenceKey(this.app.currentBookId, 'scan'))
            } catch (_) {}
        }
        return this.app.pdfViewport?.setScanEnhancementPreset('original')
    }

    restoreBookScanEnhancement(bookId) {
        const state = readPdfPreference(bookId, 'scan') || { preset: 'original' }
        this.app.pdfViewport?.setScanEnhancementPreset(state.preset, state.customParams)
    }

    async openSecondaryPdfViewport(splitDirection = 'horizontal', initialPage = null) {
        const primary = this.app.pdfViewport, driver = this.app.pdfDriver, area = this.app.dom.readerContentArea
        if (!driver || !primary || !area) throw new Error(t('pdfTools.openPdfDocFirst'))
        this.closeSecondaryPdfViewport()
        const request = this._pdfSplitRequestId
        this._pdfSplitOpening = true
        const epoch = this.app._currentBookEpoch
        let AdaptivePdfDriverLease, PdfViewport
        try {
            const modules = await Promise.all([import('./pdf-driver.js'), import('./pdf-viewport.js')])
            AdaptivePdfDriverLease = modules[0].AdaptivePdfDriverLease
            PdfViewport = modules[1].PdfViewport
        } catch (error) {
            if (this._pdfSplitRequestId === request) this.closeSecondaryPdfViewport()
            throw error
        }
        if (this._pdfSplitRequestId !== request || this.app.pdfViewport !== primary || this.app.pdfDriver !== driver || this.app._currentBookEpoch !== epoch || primary._destroyed) {
            if (this._pdfSplitRequestId === request) this.closeSecondaryPdfViewport()
            return null
        }
        this._pdfSplitOpening = false

        const pane = document.createElement('section')
        pane.className = 'pdf-secondary-viewport-pane'
        pane.setAttribute('aria-label', t('pdfTools.refAria'))
        pane.innerHTML = `<header class="pdf-reference-toolbar">
            <span class="pdf-reference-title">${t('pdfTools.refHeader')}</span>
            <button type="button" data-ref="prev" title="${t('pdfTools.refPrevTitle')}" aria-label="${t('pdfTools.refPrevTitle')}">‹</button>
            <form class="pdf-reference-page-form"><input data-ref="page" type="number" min="1" step="1" aria-label="${t('pdfTools.refPageInputAria')}"/><span data-ref="total"></span></form>
            <button type="button" data-ref="next" title="${t('pdfTools.refNextTitle')}" aria-label="${t('pdfTools.refNextTitle')}">›</button>
            <button type="button" data-ref="fit">${t('pdf.fitPageBtn')}</button>
            <button type="button" data-ref="width">${t('pdf.fitWidthBtn')}</button>
            <button type="button" data-ref="swap" title="${t('pdfTools.refSwapTitle')}">${t('pdfTools.refSwapBtn')}</button>
            <button type="button" data-ref="close" title="${t('pdfTools.refCloseTitle')}" aria-label="${t('pdfTools.refCloseTitle')}">×</button>
        </header><div class="pdf-reference-content"></div>`
        const body = pane.querySelector('.pdf-reference-content')
        const controller = new AbortController(), lease = new AdaptivePdfDriverLease(driver, 'secondary')
        const state = { primary, driver, area, pane, controller, lease, epoch,
            zoomMode: primary.zoomMode, scale: primary.scale, automaticMainFit: true }
        this._pdfSplitSession = state
        area.classList.add('pdf-split-active')
        area.classList.toggle('pdf-split-stacked', splitDirection === 'vertical')
        area.append(pane)
        this._secondaryContainer = pane
        // Keep the existing main-reader toolbar over the main pane, including
        // narrow/stacked layouts. Preserve its nodes and listeners on close.
        const toolbar = this.dom.pdfZoomBar || document.getElementById('pdf-zoom-control-bar')
        if (toolbar?.parentNode) {
            const placeholder = document.createComment('PDF main toolbar position')
            toolbar.parentNode.insertBefore(placeholder, toolbar)
            const host = document.createElement('div')
            host.className = 'pdf-primary-tools-host'
            host.append(toolbar)
            area.append(host)
            Object.assign(state, { toolbar, toolbarPlaceholder: placeholder, toolbarHost: host })
        }

        const input = pane.querySelector('[data-ref="page"]'), prev = pane.querySelector('[data-ref="prev"]'), next = pane.querySelector('[data-ref="next"]')
        const sync = () => {
            if (this._pdfSplitSession !== state) return
            const page = viewport.currentPage + 1, total = viewport.numPages || driver.numPages || 1
            input.max = String(total)
            if (document.activeElement !== input) input.value = String(page)
            pane.querySelector('[data-ref="total"]').textContent = `/ ${total}`
            prev.disabled = page <= 1
            next.disabled = page >= total
        }
        const viewport = new PdfViewport(body, { readOnly: true, bufferPages: 0, loadOutline: false,
            isLowMemoryDevice: true, bitmapCacheLimitBytes: 8 * 1024 * 1024, maxCanvasPixels: 4_000_000,
            onPageChange: p => { this._secondaryCurrentPage = p; sync() } })
        state.viewport = viewport
        this.secondaryPdfViewport = viewport
        viewport.scrollArea.tabIndex = 0
        viewport.scrollArea.setAttribute('aria-label', t('pdfTools.refScrollAreaAria'))
        const listen = (element, event, handler, extra = {}) => element.addEventListener(event, handler, { ...extra, signal: controller.signal })
        const turn = direction => { const page = viewport.getAdjacentPage(direction); if (page != null) viewport.goToPage(page); sync() }
        const jump = () => {
            const page = Number(input.value)
            if (!Number.isInteger(page) || page < 1 || page > viewport.numPages) {
                input.value = String(viewport.currentPage + 1)
                this.app.dialogs.showToast(t('pdfTools.enterValidPageRange', { total: viewport.numPages }), 'warning')
                return
            }
            viewport.goToPage(page - 1)
            input.value = String(page)
            sync()
        }
        listen(pane.querySelector('form'), 'submit', event => { event.preventDefault(); event.stopPropagation(); jump() })
        listen(input, 'change', jump)
        listen(prev, 'click', () => turn('prev'))
        listen(next, 'click', () => turn('next'))
        listen(pane.querySelector('[data-ref="fit"]'), 'click', () => viewport.setZoom('fit-page'))
        listen(pane.querySelector('[data-ref="width"]'), 'click', () => viewport.setZoom('fit-width'))
        listen(pane.querySelector('[data-ref="swap"]'), 'click', () => { this.swapPdfViewports(); sync() })
        listen(pane.querySelector('[data-ref="close"]'), 'click', () => this.closeSecondaryPdfViewport())
        listen(viewport.scrollArea, 'pointerdown', event => { if (event.button === 0) viewport.scrollArea.focus({ preventScroll: true }) })
        // Reference navigation must never fall through to the main reader's hotkeys.
        listen(pane, 'keydown', event => {
            if (event.target.closest('input,button,select,textarea,[contenteditable="true"]')) { event.stopPropagation(); return }
            if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
            if (['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); event.stopPropagation()
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') viewport.scrollArea.scrollBy({ top: event.key === 'ArrowUp' ? -90 : 90, behavior: 'auto' })
                else if (event.key === 'Home' || event.key === 'End') viewport.goToPage(event.key === 'Home' ? 0 : viewport.numPages - 1)
                else turn(['ArrowLeft', 'PageUp'].includes(event.key) || event.key === ' ' && event.shiftKey ? 'prev' : 'next')
                sync()
            }
        })
        for (const event of ['click', 'pointerdown', 'pointerup', 'mouseup', 'wheel']) listen(pane, event, e => e.stopPropagation())

        const button = document.getElementById('btn-pdf-split-viewport')
        button?.classList.add('active')
        button?.setAttribute('aria-pressed', 'true')
        button?.setAttribute('aria-busy', 'true')
        try {
            if (state.automaticMainFit) primary.setZoom('fit-width')
            const target = Number.isInteger(initialPage) ? initialPage : primary.currentPage || 0
            await viewport.attachOpenedDriver(lease, { initialPage: Math.max(0, Math.min(driver.numPages - 1, target)) })
            if (this._pdfSplitSession !== state || this.app.pdfViewport !== primary || this.app._currentBookEpoch !== epoch || viewport._destroyed) return null
            viewport.setZoom('fit-page')
            sync()
            this.app.dialogs.showToast(t('pdfTools.refOpenedToast'))
            return viewport
        } catch (error) {
            if (this._pdfSplitSession !== state) return null
            this.closeSecondaryPdfViewport()
            throw error
        } finally {
            if (this._pdfSplitSession === state) button?.removeAttribute('aria-busy')
        }
    }

    swapPdfViewports() {
        if (!this.app.pdfViewport || !this.secondaryPdfViewport) return false
        const mainPage = this.app.pdfViewport.currentPage || 0, referencePage = this.secondaryPdfViewport.currentPage || 0
        this.app.pdfViewport.goToPage(referencePage)
        this.secondaryPdfViewport.goToPage(mainPage)
        return true
    }

    closeSecondaryPdfViewport() {
        this._pdfSplitRequestId = (this._pdfSplitRequestId || 0) + 1
        this._pdfSplitOpening = false
        const state = this._pdfSplitSession, viewport = this.secondaryPdfViewport
        this._pdfSplitSession = null
        this.secondaryPdfViewport = null
        state?.controller.abort()
        viewport?.destroy?.()
        const pane = state?.pane || this._secondaryContainer
        const restoreFocus = Boolean(pane?.contains(document.activeElement))
        pane?.remove()
        if (state?.toolbarPlaceholder?.parentNode) {
            state.toolbarPlaceholder.parentNode.insertBefore(state.toolbar, state.toolbarPlaceholder)
            state.toolbarPlaceholder.remove()
        }
        state?.toolbarHost?.remove()
        this._secondaryContainer = null
        const area = state?.area || this.app.dom?.readerContentArea
        area?.classList.remove('pdf-split-active', 'pdf-split-stacked')
        if (state && this.app.pdfViewport === state.primary && this.app._currentBookEpoch === state.epoch && !state.primary._destroyed) {
            if (state.automaticMainFit && state.primary.zoomMode === 'fit-width') state.primary.setZoom(state.zoomMode || state.scale)
            else state.primary.setZoom(state.primary.zoomMode || state.primary.scale)
        }
        const button = document.getElementById('btn-pdf-split-viewport')
        button?.classList.remove('active')
        button?.setAttribute('aria-pressed', 'false')
        button?.removeAttribute('aria-busy')
        if (restoreFocus && button?.isConnected) button.focus()
        return true
    }

    initPdfMoreTools() {
        const button = document.getElementById('btn-pdf-more-tools')
        const panel = document.getElementById('pdf-more-tools-panel')
        if (!button || !panel) return
        this._pdfMoreToolsController?.abort()
        this._pdfMoreToolsObserver?.disconnect()
        const controller = new AbortController()
        this._pdfMoreToolsController = controller
        const options = { signal: controller.signal }
        this.setPdfMoreToolsOpen(false)
        button.addEventListener('click', () => this.setPdfMoreToolsOpen(panel.hidden), options)
        document.addEventListener('pointerdown', event => {
            if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) this.setPdfMoreToolsOpen(false)
        }, options)
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !panel.hidden) {
                event.preventDefault()
                event.stopImmediatePropagation()
                this.setPdfMoreToolsOpen(false)
                button.focus()
            }
        }, { ...options, capture: true })
        panel.addEventListener('focusout', event => {
            if (event.relatedTarget && !panel.contains(event.relatedTarget) && event.relatedTarget !== button) this.setPdfMoreToolsOpen(false)
        }, options)
        const update = () => {
            for (const id of ['btn-toggle-auto-scroll', 'btn-pdf-split-viewport', 'btn-scan-gray-boost', 'btn-scan-text-darken']) {
                const control = document.getElementById(id)
                control?.setAttribute('aria-pressed', String(control.classList.contains('active')))
            }
        }
        if (typeof MutationObserver !== 'undefined') {
            this._pdfMoreToolsObserver = new MutationObserver(update)
            this._pdfMoreToolsObserver.observe(panel, { subtree: true, attributes: true, attributeFilter: ['class'] })
        }
        update()
    }

    setPdfMoreToolsOpen(open) {
        const button = document.getElementById('btn-pdf-more-tools')
        const panel = document.getElementById('pdf-more-tools-panel')
        if (!button || !panel) return
        panel.hidden = !open
        button.setAttribute('aria-expanded', String(Boolean(open)))
    }

    toggleAutoScroll(speed = 30) {
        if (!this.app.pdfViewport) return this.app.dialogs.showToast(t('pdfTools.autoScrollNeedPdf'))
        if (this.app.pdfViewport.getAutoScrollState().active) {
            this.stopAutoScroll()
            this.app.dialogs.showToast(t('pdfTools.autoScrollStopped'))
            return false
        }
        this.startAutoScroll(speed)
        this.app.dialogs.showToast(t('pdfTools.autoScrollStarted'))
        return true
    }

    startAutoScroll(speed = 30) {
        this.app.pdfViewport?.startAutoScroll({ speed })
    }

    stopAutoScroll() {
        this.app.pdfViewport?.stopAutoScroll()
    }

    pauseAutoScroll() {
        if (this.app.pdfViewport?.pauseAutoScroll) {
            this.app.pdfViewport.pauseAutoScroll()
        }
    }

    resumeAutoScroll() {
        if (this.app.pdfViewport?.resumeAutoScroll) {
            this.app.pdfViewport.resumeAutoScroll()
        }
    }

    toggleAutoScrollPause() {
        const state = this.app.pdfViewport?.getAutoScrollState()
        if (!state?.active) return
        this.app.pdfViewport.toggleAutoScrollPause()
        this.app.dialogs.showToast(state.paused ? t('pdfTools.autoScrollResumed') : t('pdfTools.autoScrollPaused'))
    }

    toggleSecondaryPdfViewport() {
        if (this.secondaryPdfViewport || this._pdfSplitOpening) {
            this.closeSecondaryPdfViewport()
            document.getElementById('btn-pdf-split-viewport')?.classList.remove('active')
            this.app.dialogs.showToast(t('pdfTools.refClosedToast'))
        } else {
            if (!this.app.pdfDriver || !this.app.pdfViewport) {
                this.app.dialogs.showToast(t('pdfTools.openPdfDocFirst'))
                return
            }
            this.openSecondaryPdfViewport('horizontal').catch(error => {
                console.warn('[PDF] Reference view failed:', error)
                this.app.dialogs.showToast(t('pdfTools.refOpenFailed'), 'warning')
            })
        }
    }

    toggleScanPreset(presetId) {
        if (!this.app.pdfViewport) {
            this.app.dialogs.showToast(t('pdfTools.scanEnhancePdfOnly'))
            return
        }
        const currentState = this.app.pdfViewport.getScanEnhancementState?.() || {}
        const currentPreset = currentState.preset || 'original'
        const next = (currentPreset === presetId) ? 'original' : presetId
        this.applyScanEnhancement(next)
        document.getElementById('btn-scan-gray-boost')?.classList.toggle('active', next === 'gray-boost')
        document.getElementById('btn-scan-text-darken')?.classList.toggle('active', next === 'text-darken')
        const name = next === 'gray-boost' ? t('pdfTools.scanGrayBoost') : (next === 'text-darken' ? t('pdfTools.scanTextDarken') : t('pdfTools.scanOriginal'))
        this.app.dialogs.showToast(t('pdfTools.scanSwitched', { name }))
    }
}
