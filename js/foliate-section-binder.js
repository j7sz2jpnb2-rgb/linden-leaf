import { DomEvents } from './dom-events.js'
import { tracker } from './tracker.js'
import { platformBridge } from './platformBridge.js'
import { markReaderPaperBackgrounds } from './reader-paper.js'
import { FEATURE_CHAPTER_TRANSLATION_ENABLED } from './app-features.js'
import { t } from './i18n.js'

/** Owns sections UI state, DOM queries and bindings. App supplies shared reading/session coordination. */
export class FoliateSectionBinder {
    constructor(app) {
        this.app = app
        this.events = new DomEvents()

    }

    resetSessionState() {
        this.events.dispose()
        this._activeSelectionGestureCtrl = false
        this._pointerDownWithCtrl = false
        this.isCtrlPressed = false
    }

    dispose() { this.resetSessionState() }

    normalizeEpubDocument(doc) {
        if (!doc || !doc.body) return
        const isPublisherMode = this.app.currentBookFormat === 'epub'
            && this.app.settings?.preserveOriginalStyles === true
        doc.documentElement.dataset.readerStyleMode = isPublisherMode ? 'publisher' : 'custom'
        if (isPublisherMode || doc.documentElement.hasAttribute('data-reader-image-page')) return
        const win = doc.defaultView || window

        try {

            // Prevent empty first page: Neutralize page-break-before on first visible elements
            const firstChild = doc.body.firstElementChild
            if (firstChild) {
                firstChild.style.setProperty('page-break-before', 'avoid', 'important')
                firstChild.style.setProperty('break-before', 'avoid', 'important')
                const grandChild = firstChild.firstElementChild
                if (grandChild) {
                    grandChild.style.setProperty('page-break-before', 'avoid', 'important')
                    grandChild.style.setProperty('break-before', 'avoid', 'important')
                }
            }

            // Neutralize publisher hardcoded background colors on containers (like .kuai, .body)
            doc.querySelectorAll('.kuai, .body, [class*="kuai"]').forEach(el => {
                el.style.setProperty('background-color', 'transparent', 'important')
                el.style.setProperty('background', 'transparent', 'important')
            })

            // Prevent oversized percentage top margins (e.g. margin-top: 65%) from spilling title divs into empty extra pages
            doc.querySelectorAll('.kuai, [style*="margin-top"]').forEach(el => {
                const mt = el.style.marginTop
                if (mt && (mt.includes('%') || mt.includes('vh'))) {
                    const val = parseFloat(mt)
                    if (val > 20) {
                        el.style.setProperty('margin-top', '15vh', 'important')
                    }
                }
            })

            // Comic Book & Manga Chapter Detection (Single Image Column Isolation)
            const imgs = Array.from(doc.querySelectorAll('img, svg image'))
            if (imgs.length > 0) {
                const textLen = (doc.body.innerText || doc.body.textContent || '').replace(/[\s\r\n\t]/g, '').length
                const hasCaptions = !!doc.querySelector('figcaption, .caption, [class*="caption" i]')
                const isComicSection = !!(this.app.settings?.comicMode) ||
                    !!(this.app.book?.isComic || this.app.foliateView?.book?.isComic || this.app.currentBookData?.isComic) ||
                    (!hasCaptions && imgs.length >= 2 && textLen < 20 * imgs.length)

                if (isComicSection) {
                    doc.documentElement.classList.add('comic-mode')
                    doc.body.classList.add('comic-mode')
                    imgs.forEach(img => {
                        img.classList.add('comic-img')
                        img.dataset.comicImage = 'true'
                        const svgParent = img.closest('svg')
                        if (svgParent) {
                            svgParent.classList.add('comic-img')
                            svgParent.dataset.comicImage = 'true'
                        }
                        const parent = (svgParent || img).closest('p, div, figure')
                        if (parent && parent !== doc.body && parent !== doc.documentElement) {
                            parent.classList.add('comic-container')
                        }
                    })
                }
            }

            // 1. Safe Non-Destructive Hiding of Calibre Dummy Page Breaks & Ghost Elements
            // (Only hide genuinely empty dummy markers without text or media to preserve Calibre chapter root divs)
            const calibrePbs = doc.querySelectorAll('[id*="calibre_pb" i], [class*="calibre_pb" i], .calibre_pb')
            calibrePbs.forEach(el => {
                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, audio, canvas, table, iframe')
                if (!rawText && !hasMedia) {
                    el.dataset.readerHidden = 'true'
                    el.style.setProperty('display', 'none', 'important')
                    el.style.setProperty('height', '0', 'important')
                    el.style.setProperty('min-height', '0', 'important')
                    el.style.setProperty('max-height', '0', 'important')
                    el.style.setProperty('margin', '0', 'important')
                    el.style.setProperty('padding', '0', 'important')
                    el.style.setProperty('font-size', '0', 'important')
                    el.style.setProperty('line-height', '0', 'important')
                    el.style.setProperty('border', 'none', 'important')
                }
            })

            // Safely collapse trailing ghost empty spacer paragraphs at the bottom of the section
            const allBlocks = Array.from(doc.querySelectorAll('p, div'))
            for (let i = allBlocks.length - 1; i >= 0; i--) {
                const el = allBlocks[i]
                if (!el.isConnected) continue
                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, audio, canvas, table, iframe')
                if (!rawText && !hasMedia && el.children.length <= 1) {
                    if (el === doc.body.lastElementChild || (el.parentElement === doc.body && !el.nextElementSibling)) {
                        el.dataset.readerHidden = 'true'
                        el.style.setProperty('display', 'none', 'important')
                        el.style.setProperty('height', '0', 'important')
                        el.style.setProperty('margin', '0', 'important')
                        el.style.setProperty('padding', '0', 'important')
                    }
                } else {
                    if (el.parentElement === doc.body) break
                }
            }

            // 2. Deep Heading & Chapter Title Recognition
            const chapterPattern = /^(?:第[一二三四五六七八九十百千0-9\s]+[章节回部篇卷折幕集期讲]|chapter\s+\d+|section\s+\d+|prologue|epilogue|引言|序言|楔子|尾声|结语|后记|前言)\b/i

            const candidateList = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [class*="title" i], [class*="heading" i], [class*="chapter" i], .contenttitle, .contenttitle1, .contenttitle2, .chaptertitle, .sequencetitle, [id^="toc_" i], [id^="chap" i]'))

            // Also scan short standalone paragraphs matching chapter title patterns
            const allP = doc.querySelectorAll('p, div')
            allP.forEach(p => {
                if (!candidateList.includes(p)) {
                    const txt = (p.textContent || '').trim()
                    if (txt.length >= 2 && txt.length <= 40 && chapterPattern.test(txt)) {
                        candidateList.push(p)
                    }
                }
            })

            let isFirstHeadingFound = false

            candidateList.forEach(el => {
                if (el.classList.contains('titlepage') || el.closest('.titlepage')) return

                const rawHeadingText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                const hasMedia = el.querySelector('img, svg, picture, video, canvas')
                
                // Empty anchor headings (like <h1 id="a004"></h1> placed before full-page SVG illustrations in 砂女)
                if (!rawHeadingText && !hasMedia) {
                    el.dataset.readerHidden = 'true'
                    el.style.setProperty('display', 'none', 'important')
                    el.style.setProperty('height', '0', 'important')
                    el.style.setProperty('min-height', '0', 'important')
                    el.style.setProperty('max-height', '0', 'important')
                    el.style.setProperty('margin', '0', 'important')
                    el.style.setProperty('padding', '0', 'important')
                    el.style.setProperty('font-size', '0', 'important')
                    el.style.setProperty('line-height', '0', 'important')
                    el.style.setProperty('border', 'none', 'important')
                    return
                }

                el.dataset.readerHeading = 'true'
                const isChapter = chapterPattern.test(rawHeadingText) || /chapter|chap/i.test(el.id || el.className)
                if (isChapter) {
                    el.dataset.chapterHeading = 'true'
                }

                if (isFirstHeadingFound) {
                    el.dataset.sectionHeading = 'true'
                    return
                }

                // Check if this heading has substantive visible content before it
                let hasVisibleContentBefore = false
                let current = el
                while (current && current !== doc.body) {
                    let prev = current.previousElementSibling
                    while (prev) {
                        const cleanText = (prev.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                        const hasMedia = prev.querySelector('img, svg, picture, video, canvas, table')
                        if ((cleanText.length > 0 || hasMedia) && !prev.dataset.readerHidden) {
                            hasVisibleContentBefore = true
                            break
                        }
                        prev = prev.previousElementSibling
                    }
                    if (hasVisibleContentBefore) break
                    current = current.parentElement
                }

                if (!hasVisibleContentBefore) {
                    el.dataset.firstHeading = 'true'
                    isFirstHeadingFound = true
                } else {
                    el.dataset.sectionHeading = 'true'
                }
            })

            // 3. Computed Style Penetration & Semantic Tagging (Solves InDesign/Calibre hashed classes)
            const allParagraphs = doc.querySelectorAll('p, div, blockquote, h1, h2, h3, h4, h5, h6, span, section, article')
            allParagraphs.forEach(el => {
                // Mark media containers
                if (el.querySelector('img, svg, picture, video, canvas')) {
                    el.dataset.hasMedia = 'true'
                    return
                }

                // Mark dropcaps to prevent awkward double indent
                if (el.querySelector('.dropcap, [class*="dropcap" i], [class*="first-letter" i]')) {
                    el.dataset.hasDropcap = 'true'
                }

                // Normalize hardcoded full-width leading spaces (\u3000\u3000) so text-indent: 2em standardizes layout
                if (el.tagName?.toLowerCase() === 'p' && el.firstChild && el.firstChild.nodeType === 3) {
                    const val = el.firstChild.nodeValue
                    if (val && /^[\u3000\u00a0\s]{1,4}/.test(val)) {
                        el.firstChild.nodeValue = val.replace(/^[\u3000\u00a0\s]{1,4}/, '')
                    }
                }

                const rawText = (el.textContent || '').replace(/[\s\u00a0\u3000\ufeff\u200b\u200c\u200d]/g, '')
                if (!rawText && !el.dataset.readerHidden) {
                    el.dataset.emptyLine = 'true'
                    return
                }

                // Penetrate real computed style via getComputedStyle
                try {
                    const style = win.getComputedStyle(el)
                    const textAlign = style?.textAlign
                    const alignAttr = (el.getAttribute('align') || '').toLowerCase()
                    const className = (el.className || '').toLowerCase()

                    if (textAlign === 'center' || alignAttr === 'center' || /center/i.test(className)) {
                        el.dataset.align = 'center'
                    } else if (textAlign === 'right' || alignAttr === 'right' || /right|sequence/i.test(className)) {
                        el.dataset.align = 'right'
                    }
                } catch (styleErr) {
                    // Fallback to attribute / class heuristics if window context is detached
                    const alignAttr = (el.getAttribute('align') || '').toLowerCase()
                    const inlineAlign = (el.style?.textAlign || '').toLowerCase()
                    if (alignAttr === 'center' || inlineAlign === 'center') el.dataset.align = 'center'
                    else if (alignAttr === 'right' || inlineAlign === 'right') el.dataset.align = 'right'
                }

                // Short verse / standalone line detection based on container class and length heuristics
                const className = (el.className || '').toLowerCase()
                if (className.includes('copyright') || className.includes('poetry') || className.includes('verse') || className.includes('poem')) {
                    const txt = (el.textContent || '').trim()
                    if (txt.length < 35 && !txt.endsWith('。') && !txt.endsWith('”') && !txt.endsWith('；')) {
                        el.dataset.poetryLine = 'true'
                    }
                }
            })
        } catch (e) {
            console.warn('[DOM Normalizer] Warning:', e)
        }
    }

    onSectionLoaded({ doc, index }) {
        const signal = this.events.abortController.signal
        if (!doc || doc._readerBindingSignal === signal) return
        doc._readerBindingSignal = signal
        const session = this.app._activeSession
        const isCurrent = () => !signal.aborted && (!session || session.isCurrent())
        const timers = new Set()
        const cancelTimer = timer => { clearTimeout(timer); timers.delete(timer) }
        const schedule = (callback, delay) => {
            const timer = setTimeout(() => { timers.delete(timer); if (isCurrent()) callback() }, delay)
            timers.add(timer)
            return timer
        }
        signal.addEventListener('abort', () => { for (const timer of timers) clearTimeout(timer); timers.clear() }, { once: true })

        const isPointerDirectlyOnText = (e) => {
            if (!doc || !e || !e.target) return false
            try {
                const target = e.target
                const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX
                const clientY = e.clientY ?? e.changedTouches?.[0]?.clientY ?? e.touches?.[0]?.clientY
                if (clientX == null || clientY == null) return false

                // 1. Margin / Root / Body checks: clicks on body, html, or non-elements are blank space
                if (target === doc.body || target === doc.documentElement || target.nodeType !== Node.ELEMENT_NODE) {
                    return false
                }

                // 2. Non-text media and UI elements are not text
                if (target.matches?.('svg, img, canvas, video, audio, hr, button, input')) {
                    return false
                }

                // 3. Directly clicking an inline formatted text element (span, em, strong, etc.)
                if (target.matches?.('span, em, strong, b, i, u, mark, a, code, small, sub, sup')) {
                    const rects = target.getClientRects?.()
                    if (rects && rects.length > 0) {
                        for (let i = 0; i < rects.length; i++) {
                            const r = rects[i]
                            if (clientX >= r.left && clientX <= r.right &&
                                clientY >= r.top && clientY <= r.bottom) {
                                return true
                            }
                        }
                    }
                }

                // 4. Standard doc.caretPositionFromPoint (Chromium 128+, Firefox)
                if (typeof doc.caretPositionFromPoint === 'function') {
                    const pos = doc.caretPositionFromPoint(clientX, clientY)
                    if (pos && pos.offsetNode) {
                        const node = pos.offsetNode.nodeType === Node.TEXT_NODE
                            ? pos.offsetNode
                            : (pos.offsetNode.childNodes?.[pos.offset] || pos.offsetNode)
                        if (node && node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
                            const offset = pos.offset || 0
                            const testRange = doc.createRange()
                            const start = Math.max(0, Math.min(offset, Math.max(0, node.length - 1)))
                            testRange.setStart(node, start)
                            testRange.setEnd(node, Math.min(start + 1, node.length))
                            const r = testRange.getBoundingClientRect()
                            if (r && (r.width > 0 || r.height > 0)) {
                                const dx = Math.max(0, r.left - clientX, clientX - r.right)
                                const dy = Math.max(0, r.top - clientY, clientY - r.bottom)
                                if (dx <= 4 && dy <= 4) return true
                            }
                            if (offset > 0 && offset - 1 !== start) {
                                testRange.setStart(node, offset - 1)
                                testRange.setEnd(node, offset)
                                const rPrev = testRange.getBoundingClientRect()
                                if (rPrev && (rPrev.width > 0 || rPrev.height > 0)) {
                                    const dxPrev = Math.max(0, rPrev.left - clientX, clientX - rPrev.right)
                                    const dyPrev = Math.max(0, rPrev.top - clientY, clientY - rPrev.bottom)
                                    if (dxPrev <= 4 && dyPrev <= 4) return true
                                }
                            }
                        }
                    }
                    // In modern browsers, caretPositionFromPoint is authoritative for document layout.
                    // If the pointer is not within 4px of the resolved glyph, it is blank space.
                    return false
                } else if (typeof doc.caretRangeFromPoint === 'function') {
                    const range = doc.caretRangeFromPoint(clientX, clientY)
                    if (range && range.startContainer) {
                        const node = range.startContainer.nodeType === Node.TEXT_NODE
                            ? range.startContainer
                            : (range.startContainer.childNodes?.[range.startOffset] || range.startContainer)
                        if (node && node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
                            const offset = range.startOffset || 0
                            const testRange = doc.createRange()
                            const start = Math.max(0, Math.min(offset, Math.max(0, node.length - 1)))
                            testRange.setStart(node, start)
                            testRange.setEnd(node, Math.min(start + 1, node.length))
                            const r = testRange.getBoundingClientRect()
                            if (r && (r.width > 0 || r.height > 0)) {
                                const dx = Math.max(0, r.left - clientX, clientX - r.right)
                                const dy = Math.max(0, r.top - clientY, clientY - r.bottom)
                                if (dx <= 4 && dy <= 4) return true
                            }
                            if (offset > 0 && offset - 1 !== start) {
                                testRange.setStart(node, offset - 1)
                                testRange.setEnd(node, offset)
                                const rPrev = testRange.getBoundingClientRect()
                                if (rPrev && (rPrev.width > 0 || rPrev.height > 0)) {
                                    const dxPrev = Math.max(0, rPrev.left - clientX, clientX - rPrev.right)
                                    const dyPrev = Math.max(0, rPrev.top - clientY, clientY - rPrev.bottom)
                                    if (dxPrev <= 4 && dyPrev <= 4) return true
                                }
                            }
                        }
                    }
                    // Authoritative caret hit test: not within 4px of glyph means blank space.
                    return false
                }

                // 5. Fallback only if browser does not support caretPositionFromPoint or caretRangeFromPoint:
                // Fast-reject if click is not even within target's bounding rect
                if (target.matches?.('p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd, td, th, div, section, article')) {
                    const targetBox = target.getBoundingClientRect?.()
                    if (targetBox && (clientX < targetBox.left || clientX > targetBox.right || clientY < targetBox.top || clientY > targetBox.bottom)) {
                        return false
                    }
                    const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, null)
                    let textNode
                    let count = 0
                    while ((textNode = walker.nextNode()) && count < 10) {
                        count++
                        if (!textNode.textContent?.trim()) continue
                        const tr = doc.createRange()
                        tr.selectNodeContents(textNode)
                        const rects = tr.getClientRects()
                        for (let i = 0; i < rects.length; i++) {
                            const r = rects[i]
                            if (clientX >= r.left && clientX <= r.right &&
                                clientY >= r.top && clientY <= r.bottom) {
                                return true
                            }
                        }
                    }
                }
            } catch {}
            return false
        }

        // Synchronize local bundled fonts to iframe document
        if (doc.fonts && document.fonts) {
            try {
                for (const f of document.fonts) {
                    doc.fonts.add(f)
                }
            } catch {}
        }

        // Industrial-grade DOM Normalization (Prune ghost pagebreaks, format headings, normalize short-line blocks)
        this.normalizeEpubDocument(doc)
        markReaderPaperBackgrounds(doc)

        // Chapter bilingual translation auto-restore or section tracking (Disabled for PC Candidate)
        const bookId = this.app.currentBookData?.id || this.app.currentBook?.id || this.app.bookId
        const contents = this.app.foliateView?.renderer?.getContents?.()
        const activeContent = Array.isArray(contents) && contents.length > 0 ? contents[0] : null
        const isActiveDoc = !activeContent || (activeContent.index === index && (!activeContent.doc || activeContent.doc === doc))
        if (FEATURE_CHAPTER_TRANSLATION_ENABLED && bookId && this.app.chapterTranslationManager && isActiveDoc) {
            this.app.chapterTranslationManager.onSectionChanged(bookId, index, doc).catch(err => {
                console.warn('[ChapterTrans] Section change hook warning:', err)
            })
        }

        if (this.app.annotations.multiSelectedRanges && this.app.annotations.multiSelectedRanges.length > 1) {
            schedule(() => this.app.annotations.renderVirtualMultiSelections(), 60)
        }

        // Throttled activity heartbeat on reading doc (mousemove, scroll, selection, keydown)
        let lastActReset = 0
        const triggerActReset = () => {
            const now = Date.now()
            if (now - lastActReset > 3000) {
                lastActReset = now
                tracker.resetActivity()
            }
        }
        ;['mousemove', 'scroll', 'pointerdown', 'selectionchange', 'keydown'].forEach(evt => {
            this.events.on(doc, evt, triggerActReset, { passive: true })
        })

        // Fullscreen edge proximity listener inside iframe document
        this.events.on(doc, 'mousemove', e => {
            if (this.app._handleFullscreenProximity) {
                const iframe = this.app.foliateView?.renderer?.querySelector?.('iframe') || document.querySelector('iframe')
                const iframeRect = iframe?.getBoundingClientRect?.() || { top: 0, left: 0 }
                this.app._handleFullscreenProximity((e.clientY || 0) + iframeRect.top)
            }
        }, { passive: true })

        // Chinese Quotes Transformation (Only applies to Chinese/CJK content; never mutates English text or apostrophes)
        if (this.app.settings.chineseQuotes && doc.body) {
            const bookLang = (this.app.book?.metadata?.language || this.app.currentBook?.language || '').toLowerCase()
            const isEnglishBook = bookLang.startsWith('en')
            const sampleText = (doc.body.innerText || doc.body.textContent || '').slice(0, 3000)
            const cjkCount = (sampleText.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length
            const latinCount = (sampleText.match(/[a-zA-Z]/g) || []).length
            // Only apply if section is genuinely CJK content, and not an English book
            const isPredominantlyCJK = !isEnglishBook && (
                (cjkCount > 0 && latinCount === 0) ||
                (cjkCount >= 10 && cjkCount >= latinCount * 0.2)
            )

            if (isPredominantlyCJK) {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
                let n = walker.nextNode()
                while (n) {
                    if (n.nodeValue && /["'“”‘’]/.test(n.nodeValue)) {
                        let text = n.nodeValue
                        // 1. Replace Chinese double quotes “ and ” with 「 and 」
                        text = text.replace(/“/g, '「').replace(/”/g, '」')
                        // 2. Replace Chinese single opening quote ‘ with 『
                        text = text.replace(/‘/g, '『')
                        // 3. Replace ’ with 』 ONLY when it's NOT an English apostrophe!
                        // Preserve apostrophes inside Latin words and plural possessives.
                        text = text.replace(/(?<![a-zA-Z0-9])’|’(?![a-zA-Z0-9])/g, (match, offset, fullStr) => {
                            const before = fullStr.slice(Math.max(0, offset - 10), offset)
                            if (/[a-zA-Z]+s$/i.test(before)) {
                                return '’'
                            }
                            return '』'
                        })
                        n.nodeValue = text
                    }
                    n = walker.nextNode()
                }
            }
        }

        let selectionTimeout = null
        let selectionDebounceTimer = null
        let isCtrlActive = false
        let sawDocTouchPointerDown = false

        const iframeKeyHandler = e => {
            if (e.key === 'Control' || e.key === 'Meta') {
                isCtrlActive = true
                this.isCtrlPressed = true
            }
            // Let the shared handler decide ownership before cancelling the
            // event. Pre-cancelling here made its defaultPrevented guard skip
            // every page key originating in the reading document.
            this.app.handleGlobalKeydown(e)
            if (e.defaultPrevented) e.stopPropagation()
        }
        // Register on the iframe document only. Adding the same handler to
        // doc.defaultView as well made every keydown fire twice (capture order
        // Window -> Document), double-toggling fullscreen and skipping search matches.
        this.events.on(doc, 'keydown', iframeKeyHandler, true)
        this.events.on(doc, 'keyup', e => {
            if (e.key === 'Control' || e.key === 'Meta') {
                isCtrlActive = false
                this.isCtrlPressed = false
            }
        })
        this.events.on(doc, 'pointerdown', e => {
            this.app.clearTouchTapSyntheticClickLock?.()
            const isTouch = (e.pointerType === 'touch') || (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
            const now = Date.now()
            if (!isTouch && e.detail > 1) {
                if (isPointerDirectlyOnText(e)) {
                    this._lastDoubleClickTime = now
                    this.app.cancelPendingReaderUIToggle()
                }
            }
            this._lastDocPointerDownTime = now

            const hasCtrl = e.ctrlKey || e.metaKey || isCtrlActive || this.isCtrlPressed
            this._pointerDownWithCtrl = hasCtrl
            this._activeSelectionGestureCtrl = hasCtrl
            if (e.pointerType === 'touch') {
                sawDocTouchPointerDown = true
            }
            if (!hasCtrl) {
                this.app.captureSelectionAndPopupStateOnGestureStart?.()
            } else {
                this.app._clearDismissSelectionGesture?.()
            }
        })
        this.events.on(doc, 'contextmenu', e => {
            if (e.target?.matches?.('input, textarea') || e.target?.isContentEditable) {
                return
            }
            e.preventDefault()

            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim()) {
                const text = sel.toString().trim()
                let cfi = null
                try {
                    const r = sel.getRangeAt(0)
                    cfi = this.app.foliateView?.getCFI?.(index, r)
                } catch (ce) {}
                this.app.annotations._frozenSelectionSnapshot = {
                    text,
                    cfi,
                    index,
                    bookId: this.app.currentBookId
                }
                const iframe = doc.defaultView?.frameElement || this.app.foliateView?.renderer?.querySelector?.('iframe') || this.app.foliateView
                const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
                this.app.annotations.showSelectionPopup({
                    top: iframeRect.top + e.clientY,
                    left: iframeRect.left + e.clientX,
                    width: 0,
                    height: 0,
                    bottom: iframeRect.top + e.clientY,
                    right: iframeRect.left + e.clientX
                })
            }
        }, true)

        const checkSelection = (evt) => {
            if (!isCurrent()) return
            if (this.app.dialogs.dom.globalModalBackdrop?.classList.contains('show')) return
            const sel = doc.getSelection()
            if (!sel || sel.isCollapsed) return
            const text = sel.toString().trim()
            if (!text) return

            try {
                const range = sel.getRangeAt(0)
                let rect = range.getBoundingClientRect()
                const clientRects = Array.from(range.getClientRects())
                if ((!rect || (rect.width === 0 && rect.height === 0)) && clientRects.length > 0) {
                    rect = clientRects[0]
                }
                
                const iframe = doc.defaultView?.frameElement || this.app.foliateView?.renderer?.querySelector?.('iframe') || this.app.foliateView
                const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
                const scaleX = iframe.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                const scaleY = iframe.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                
                const absTop = iframeRect.top + ((rect?.top || 0) * scaleY)
                const absLeft = iframeRect.left + ((rect?.left || 0) * scaleX)
                const absWidth = (rect?.width || (clientRects.length > 0 ? clientRects[0].width : 100)) * scaleX
                const absHeight = (rect?.height || (clientRects.length > 0 ? clientRects[0].height : 24)) * scaleY

                const absRect = {
                    top: absTop,
                    left: absLeft,
                    width: absWidth,
                    height: absHeight,
                    bottom: absTop + absHeight,
                    right: absLeft + absWidth
                }

                let cfi = null
                try {
                    cfi = this.app.foliateView.getCFI(index, range)
                } catch (cfiErr) {
                    console.warn('getCFI fallback on index:', index, cfiErr)
                }

                const currentItem = {
                    text,
                    range,
                    cfi,
                    index,
                    rect: absRect
                }

                const isCtrl = evt?.ctrlKey || evt?.metaKey || isCtrlActive || this.isCtrlPressed || this._activeSelectionGestureCtrl || this._pointerDownWithCtrl
                this._activeSelectionGestureCtrl = false

                if (isCtrl) {
                    if (!this.app.annotations.multiSelectedRanges) this.app.annotations.multiSelectedRanges = []
                    const exists = this.app.annotations.multiSelectedRanges.some(r => {
                        if (r.cfi && currentItem.cfi) return r.cfi === currentItem.cfi
                        if (r.range && currentItem.range) {
                            return r.range.startContainer === currentItem.range.startContainer &&
                                   r.range.startOffset === currentItem.range.startOffset &&
                                   r.range.endContainer === currentItem.range.endContainer &&
                                   r.range.endOffset === currentItem.range.endOffset
                        }
                        return r.text === text && r.index === index
                    })
                    if (!exists) {
                        this.app.annotations.multiSelectedRanges.push(currentItem)
                    }
                    if (this.app.annotations.multiSelectedRanges.length > 1) {
                        this.app.annotations.renderVirtualMultiSelections()
                        if (this.app.annotations.dom.popupMultiBadge) {
                            this.app.annotations.dom.popupMultiBadge.style.display = 'inline-block'
                            this.app.annotations.dom.popupMultiBadge.innerText = t('reader.multiSelected', { count: this.app.annotations.multiSelectedRanges.length })
                        }
                    } else {
                        // Exactly 1 selection: browser native selection is already highlighted, clear virtual box
                        this.app.annotations.clearVirtualMultiSelections()
                        if (this.app.annotations.dom.popupMultiBadge) {
                            this.app.annotations.dom.popupMultiBadge.style.display = 'none'
                        }
                    }
                } else {
                    this.app.annotations.clearVirtualMultiSelections()
                    this.app.annotations.multiSelectedRanges = [currentItem]
                    if (this.app.annotations.dom.popupMultiBadge) {
                        this.app.annotations.dom.popupMultiBadge.style.display = 'none'
                    }
                }

                this.app.annotations.selectedTextInfo = currentItem
                this.app.annotations._frozenSelectionSnapshot = { ...currentItem, bookId: this.app.currentBookId }
                this.app.annotations.hideHighlightActionPopup()

                const trimmed = text.trim()
                const dictEnabled = typeof this.app.dictionaryService?.isEnabled === 'function' ? this.app.dictionaryService.isEnabled() : (this.app.dictionaryService?.isEnabled !== false)
                const isSingleWord = !isCtrl && /^[a-zA-Z]+(?:['’-][a-zA-Z]+)?$/.test(trimmed) && dictEnabled
                if (isSingleWord) {
                    const wordItem = { ...currentItem }
                    this.app.annotations._frozenSelectionSnapshot = wordItem
                    this.app.annotations.selectedTextInfo = wordItem
                    this.app.annotations.hideSelectionPopup(true)
                    this.app.cards.showDictionaryCard(wordItem)
                } else {
                    this.app.cards.hideDictionaryCard()
                    this.app.annotations.showSelectionPopup(absRect)
                }
            } catch (err) {
                console.warn('checkSelection warning:', err)
            }
        }

        // Selection change listener inside iframe
        this.events.on(doc, 'selectionchange', (e) => {
            const currentSel = doc.getSelection()
            if (currentSel && !currentSel.isCollapsed && currentSel.toString().trim().length > 0) {
                this.app.cancelPendingReaderUIToggle()
            }
            if (selectionTimeout) cancelTimer(selectionTimeout)
            const sel = doc.getSelection()
            if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
                if (selectionDebounceTimer) cancelTimer(selectionDebounceTimer)
                const isCtrlHolding = isCtrlActive || this.isCtrlPressed || this._pointerDownWithCtrl
                if (!isCtrlHolding && (!this.app.annotations.multiSelectedRanges || this.app.annotations.multiSelectedRanges.length <= 1)) {
                    this.app.annotations.clearVirtualMultiSelections()
                    this.app.annotations.multiSelectedRanges = []
                    if (this.app.annotations.dom.popupMultiBadge) this.app.annotations.dom.popupMultiBadge.style.display = 'none'
                    this.app.annotations.hideSelectionPopup()
                }
                return
            }
            selectionTimeout = schedule(() => {
                checkSelection(e)
            }, 120)
        })

        // Pointer displacement tracking to prevent Drag-as-Click false positive
        let pointerStartX = 0
        let pointerStartY = 0
        let isDragGesture = false
        let isTouchPointer = false
        let docTouchStartX = 0
        let docTouchStartY = 0
        let docTouchStartTime = 0
        let docTouchMoved = false

        this.events.on(doc, 'dblclick', (e) => {
            const isTouch = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid) || isTouchPointer
            if (!isTouch && isPointerDirectlyOnText(e)) {
                this._lastDoubleClickTime = Date.now()
                this.app.cancelPendingReaderUIToggle()
            }
        }, true)

        this.events.on(doc, 'pointerdown', e => {
            pointerStartX = e.clientX
            pointerStartY = e.clientY
            isDragGesture = false
            isTouchPointer = (e.pointerType === 'touch') || (window.mobileShell?.isMobileViewport?.() ?? false)
        }, { passive: true })

        this.events.on(doc, 'pointermove', e => {
            const slop = 8
            if (Math.abs(e.clientX - pointerStartX) > slop || Math.abs(e.clientY - pointerStartY) > slop) {
                isDragGesture = true
            }
        }, { passive: true })

        this.events.on(doc, 'pointercancel', () => {
            sawDocTouchPointerDown = false
            isDragGesture = false
            docTouchMoved = true
            this.app._clearDismissSelectionGesture?.()
            this.app.cancelPendingReaderUIToggle()
        }, { passive: true })

        // Abort pending page-turn lock immediately when long-press text selection activates
        this.events.on(doc, 'selectionchange', () => {
            const sel = doc.getSelection?.()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                this.app.pageTurnController?.handleExternalSelectionStart?.()
            }
        }, { passive: true })

        // Mobile clean tap detection fallback for iframe document
        this.events.on(doc, 'touchstart', e => {
            if (sawDocTouchPointerDown) {
                sawDocTouchPointerDown = false
            } else {
                this.app.clearTouchTapSyntheticClickLock?.()
                this.app.captureSelectionAndPopupStateOnGestureStart?.()
            }
            if (!e.touches || e.touches.length !== 1) {
                docTouchMoved = true
                this.app.pageTurnController?.cancelCurrent?.()
                return
            }
            const t = e.touches[0]
            docTouchStartX = t.clientX
            docTouchStartY = t.clientY
            docTouchStartTime = Date.now()
            docTouchMoved = false
        }, { passive: true })

        this.events.on(doc, 'touchmove', e => {
            if (!e.touches || e.touches.length !== 1) {
                docTouchMoved = true
                return
            }
            const t = e.touches[0]
            if (Math.hypot(t.clientX - docTouchStartX, t.clientY - docTouchStartY) > 8) {
                docTouchMoved = true
            }
        }, { passive: true })

        this.events.on(doc, 'touchcancel', () => {
            sawDocTouchPointerDown = false
            docTouchMoved = true
            isDragGesture = false
            this.app._clearDismissSelectionGesture?.()
            this.app.cancelPendingReaderUIToggle()
        }, { passive: true })

        const isAnnotationHit = (point) => {
            if (!point || point.clientX == null || point.clientY == null) return false
            try {
                const contents = this.app.foliateView?.renderer?.getContents?.() || []
                const item = contents.find(x => x.doc === doc && x.overlayer) || contents.find(x => x.overlayer)
                const [val] = item?.overlayer?.hitTest?.(point) || []
                return Boolean(val && typeof val === 'string' && !val.startsWith('foliate-search:'))
            } catch {
                return false
            }
        }

        this.events.on(doc, 'touchend', e => {
            sawDocTouchPointerDown = false
            if (this.app.pageTurnController?.shouldSuppressTap?.()) {
                docTouchMoved = true
                this.app.armTouchTapSyntheticClickLock?.({ dismissed: true })
                this.app._clearDismissSelectionGesture?.()
                this.app.cancelPendingReaderUIToggle()
                return
            }
            if (docTouchMoved) {
                this.app._clearDismissSelectionGesture?.()
                return
            }
            const dur = Date.now() - docTouchStartTime
            if (dur > 450) {
                this.app._clearDismissSelectionGesture?.()
                return
            }
            if (this.app.drawing.pdfDrawTool) return
            if (e.target?.closest?.(
                'a, button, input, textarea, [data-wr-footernote], [zy-footnote], [data-note], ' +
                '.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote'
            )) return

            const reverseFootnoteMark = e.target?.closest?.('[id*="filepos"], [id^="fn"], [id^="note"]') ||
                (e.target?.id && /(?:filepos|fn|note)\d+/i.test(e.target.id) ? e.target : null)
            if (reverseFootnoteMark?.id) {
                const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(reverseFootnoteMark.id)
                    : reverseFootnoteMark.id.replace(/["\\]/g, '\\$&')
                if (doc.querySelector(`a[href="#${escapedId}"]`)) return
            }

            const isMobile = (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
            if (!isMobile) return

            if (window.mobileShell?.activeSheet || (this.app.annotations.activeDrawer && this.app.annotations.activeDrawer !== 'none')) {
                this.app._clearDismissSelectionGesture?.()
                this.app.cancelPendingReaderUIToggle()
                return
            }

            if (this.app.consumeDismissalGesture?.({ clearSelection: true })) {
                if (selectionTimeout) cancelTimer(selectionTimeout)
                if (selectionDebounceTimer) cancelTimer(selectionDebounceTimer)
                this.app.armTouchTapSyntheticClickLock?.({ dismissed: true })
                return
            }

            const touch = e.changedTouches?.[0]
            if (isAnnotationHit(touch ? { clientX: touch.clientX, clientY: touch.clientY } : null)) {
                this.app.cancelPendingReaderUIToggle()
                return
            }

            this.app.armTouchTapSyntheticClickLock?.({ dismissed: false })
            this.app.cancelPendingReaderUIToggle()
            this.app.requestToggleReaderUI(60)
        }, { passive: true })

        // Click on page: Intercept footnotes/links; full-screen tap toggles reader toolbars
        this.events.on(doc, 'click', async e => {
            if (this.app.pageTurnController?.shouldSuppressTap?.()) {
                this.app._clearDismissSelectionGesture?.()
                e.preventDefault()
                e.stopPropagation()
                e.stopImmediatePropagation?.()
                return
            }
            const syntheticLock = this.app.consumeTouchTapSyntheticClickLock?.()
            if (syntheticLock) {
                if (syntheticLock.dismissed) {
                    e.preventDefault?.()
                    e.stopPropagation?.()
                    e.stopImmediatePropagation?.()
                }
                return
            }
            if (this.app.drawing.pdfDrawTool) {
                return
            }
            if (isDragGesture) {
                isDragGesture = false
                const sel = doc.getSelection()
                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                    this.app._clearDismissSelectionGesture?.()
                    return
                }
            }

            const standaloneFootnote = e.target.closest(
                'img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote, ' +
                '[data-wr-footernote], [zy-footnote], [data-note], .duokan-footnote'
            )
            if (standaloneFootnote) {
                const noteText = (
                    standaloneFootnote.getAttribute('data-wr-footernote') ||
                    standaloneFootnote.getAttribute('zy-footnote') ||
                    standaloneFootnote.getAttribute('data-note') ||
                    standaloneFootnote.getAttribute('alt') ||
                    standaloneFootnote.getAttribute('title') ||
                    ''
                ).trim()
                if (noteText) {
                    e.preventDefault()
                    e.stopPropagation()
                    e.stopImmediatePropagation()
                    const rect = standaloneFootnote.getBoundingClientRect()
                    const doc = standaloneFootnote.ownerDocument
                    const iframe = doc?.defaultView?.frameElement || this.app.foliateView?.renderer?.querySelector?.('iframe') || this.app.foliateView
                    const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
                    const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                    const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                    this.app.cards.showFootnotePopup({
                        title: t('reader.footnotePopupTitle'),
                        text: noteText,
                        rect: {
                            top: rect.top * scaleY + iframeRect.top,
                            left: rect.left * scaleX + iframeRect.left,
                            width: rect.width * scaleX,
                            height: rect.height * scaleY
                        }
                    })
                    return
                }
            }

            const a = e.target.closest('a[href]') || e.target.closest('a')
            if (a) {
                const href = a.getAttribute('href') || ''
                const cleanText = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(【]|[\]）)】]$/g, '')
                const isNumericOrSymbolMark = /^[\[（(【]?\s*(?:\d{1,4}|[\u2460-\u2473\u3251-\u325f]|[\*\u2020\u2021]|注)\s*[\]）)】]?$/.test(cleanText)
                const isSup = !!(a.closest('sup, sub, .math-super') || 
                                 a.querySelector('sup, sub, .math-super') || 
                                 a.classList.contains('math-super'))
                // Check if clicked anchor is located inside an actual footnote container (a return backlink from notes to body)
                const footnoteContainer = a.parentElement?.closest?.(
                    'ol.duokan-footnote-content, ol.footnotes, ul.footnotes, ' +
                    'li.duokan-footnote-item, li.footnote, li.endnote, ' +
                    'aside[epub\\:type~="footnote"], aside[epub\\:type~="endnote"], ' +
                    'aside[role~="doc-footnote"], aside[role~="doc-endnote"], ' +
                    'aside.footnote, section.footnotes, [role~="doc-footnote"]'
                )
                const isSourceInFootnote = !!footnoteContainer && !a.matches?.('.duokan-footnote, .epub-footnote, .footnote-ref, [epub\\:type~="noteref"], [role~="doc-noteref"]')
                
                // If the user clicked a return backlink inside the footnote section, allow normal jump back to story
                if (isSourceInFootnote) {
                    return
                }

                const targetId = href.includes('#') ? href.split('#')[1] : null
                const isNoteIdPattern = targetId ? /(?:filepos|fn|footnote|note|nt|ftn|ref|[mfw])\d+/i.test(targetId) : false

                const isNoteref = a.getAttribute('epub:type') === 'noteref' || 
                                  a.getAttribute('role') === 'doc-noteref' || 
                                  a.classList.contains('epub-footnote') ||
                                  a.classList.contains('footnote-ref') ||
                                  a.classList.contains('duokan-footnote') ||
                                  a.hasAttribute('data-wr-footernote') ||
                                  a.hasAttribute('zy-footnote') ||
                                  a.hasAttribute('data-note') ||
                                  a.querySelector('img.duokan-footnote, img.epub-footnote, img.qqreader-footnote, img.zy-footnote, img.dd-footnote') ||
                                  a.classList.contains('note') ||
                                  isSup ||
                                  (targetId && isNoteIdPattern && (isNumericOrSymbolMark || !cleanText))

                if (isNoteref && targetId) {
                    let targetEl = doc.getElementById(targetId) || doc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                    
                    // If target is inside <sup> in story text, this is a backlink returning to main text; do NOT show popup!
                    const isTargetBacklink = targetEl && (targetEl.closest('sup, sub, .math-super') || targetEl.tagName === 'SUP' || targetEl.querySelector('sup, sub'))
                    if (isTargetBacklink) {
                        this.app.cards.hideFootnotePopup()
                        return
                    }

                    let footnoteText = (a.getAttribute('data-wr-footernote') || a.getAttribute('zy-footnote') || a.getAttribute('data-note') || '').trim()
                    if (!footnoteText && targetEl) {
                        footnoteText = this.app.cards.extractFootnoteFromTarget(targetEl, a)
                    }

                    // If still empty and link points to another file in book, resolve external section
                    if (!footnoteText && this.app.foliateView?.book) {
                        try {
                            const book = this.app.foliateView.book
                            const section = book.sections[index]
                            const fullHref = section?.resolveHref?.(href) ?? href
                            const resolved = book.resolveHref ? (book.resolveHref(fullHref) || book.resolveHref(href)) : null
                            if (resolved && resolved.index != null && (resolved.index !== index || !targetEl)) {
                                const targetSec = book.sections[resolved.index]
                                const secDoc = await targetSec?.createDocument?.()
                                if (secDoc) {
                                    const extEl = secDoc.getElementById(targetId) || secDoc.querySelector(`[name="${CSS.escape(targetId)}"]`)
                                    if (extEl) {
                                        if (extEl.closest('sup, sub, .math-super') || extEl.tagName === 'SUP') {
                                            this.app.cards.hideFootnotePopup()
                                            return
                                        }
                                        footnoteText = this.app.cards.extractFootnoteFromTarget(extEl, a)
                                    }
                                }
                            }
                        } catch (err) {
                            console.warn('External footnote lookup error in doc click:', err)
                        }
                    }

                    // Fallback to img alt or title only if not trivial
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
                        e.stopPropagation()
                        e.stopImmediatePropagation()
                        
                        const rect = a.getBoundingClientRect()
                        const doc = a.ownerDocument
                        const iframe = doc?.defaultView?.frameElement || this.app.foliateView?.renderer?.querySelector?.('iframe') || this.app.foliateView
                        const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
                        const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                        const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                        let anchorLabel = (a.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().replace(/^[\[（(]|[\]）)]$/g, '')
                        if (!anchorLabel && targetId) {
                            const m = targetId.match(/(?:fn|footnote|note|ref)?([0-9\.]+)/i)
                            if (m) anchorLabel = m[1]
                        }
                        const popupTitle = anchorLabel && anchorLabel.length <= 8
                            ? t('reader.footnotePopupTitleWithAnchor', { anchor: anchorLabel })
                            : t('reader.footnotePopupTitle')
                        
                        this.app.cards.showFootnotePopup({
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

                // If 'a' has a real external or cross-chapter link (not dummy #, not javascript:, not pure name anchor), let Foliate handle navigation
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                    return
                }
            }

            // Reverse footnote lookup: when user clicks an in-text mark with id (e.g. <img id="filepos70497"> in Kindle books)
            if (!a && e.target) {
                const targetMark = e.target.closest('[id*="filepos"], [id^="fn"], [id^="note"]') || (e.target.id && /(?:filepos|fn|note)\d+/i.test(e.target.id) ? e.target : null)
                if (targetMark && targetMark.id) {
                    const escapedId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                        ? CSS.escape(targetMark.id)
                        : targetMark.id.replace(/["\\]/g, '\\$&')
                    const noteAnchor = doc.querySelector(`a[href="#${escapedId}"]`)
                    if (noteAnchor) {
                        const footnoteText = this.app.cards.extractFootnoteFromTarget(noteAnchor.closest('li, p, blockquote, dd') || noteAnchor, noteAnchor)
                        if (footnoteText) {
                            e.preventDefault()
                            e.stopPropagation()
                            e.stopImmediatePropagation()
                            const rect = targetMark.getBoundingClientRect()
                            const iframe = doc?.defaultView?.frameElement || this.app.foliateView?.renderer?.querySelector?.('iframe') || this.app.foliateView
                            const iframeRect = (iframe || this.app.foliateView).getBoundingClientRect()
                            const scaleX = iframe?.offsetWidth ? (iframeRect.width / iframe.offsetWidth) : 1
                            const scaleY = iframe?.offsetHeight ? (iframeRect.height / iframe.offsetHeight) : 1
                            this.app.cards.showFootnotePopup({
                                title: t('reader.footnotePopupTitle'),
                                text: footnoteText,
                                rect: {
                                    top: iframeRect.top + ((rect.top || 0) * scaleY),
                                    left: iframeRect.left + ((rect.left || 0) * scaleX),
                                    width: (rect.width || 20) * scaleX,
                                    height: (rect.height || 20) * scaleY
                                }
                            })
                            return
                        }
                    }
                }
            }

            this.app.cards.hideFootnotePopup()

            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.selection-popup') || e.target.closest('.highlight-action-popup') || e.target.closest('.reader-dictionary-card')) {
                this.app.cancelPendingReaderUIToggle()
                return
            }
            const now = Date.now()
            const isTouch = (e.pointerType === 'touch') || (window.mobileShell?.isMobileViewport?.() ?? false) || Boolean(platformBridge?.isAndroid)
            const onText = isPointerDirectlyOnText(e)

            if (!isTouch) {
                if (e.detail > 1) {
                    if (onText) {
                        this._lastDoubleClickTime = now
                        this._lastDocClickTime = now
                        this.app.cancelPendingReaderUIToggle()
                        return
                    }
                }
            }
            this._lastDocClickTime = now

            const hasCtrl = e.ctrlKey || e.metaKey || isCtrlActive || this.isCtrlPressed
            if (!hasCtrl && this.app._dismissSelectionGesture && this.app.consumeDismissalGesture?.({ clearSelection: true })) {
                if (selectionTimeout) cancelTimer(selectionTimeout)
                if (selectionDebounceTimer) cancelTimer(selectionDebounceTimer)
                e.stopImmediatePropagation?.()
                return
            }
            this.app._clearDismissSelectionGesture?.()

            const sel = doc.getSelection()
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                this.app.cancelPendingReaderUIToggle()
                this.app.annotations.hideHighlightActionPopup()
                return
            }

            if (isAnnotationHit({ clientX: e.clientX, clientY: e.clientY })) {
                this.app.cancelPendingReaderUIToggle()
                return
            }

            if (!hasCtrl) {
                this.app.annotations.clearVirtualMultiSelections()
                this.app.annotations.multiSelectedRanges = []
                if (this.app.annotations.dom.popupMultiBadge) this.app.annotations.dom.popupMultiBadge.style.display = 'none'
                this.app.annotations.hideSelectionPopup()
                this.app.cards.hideDictionaryCard()
                try {
                    doc.getSelection()?.removeAllRanges?.()
                    window.getSelection()?.removeAllRanges?.()
                } catch (err) {}
            }

            this.app.annotations.hideHighlightActionPopup()

            // Disambiguate text click vs blank space click:
            // Clicks directly on words / text have a brief window (~200ms) on desktop mouse to allow double-click selection,
            // while clicks on blank margin areas toggle immediately (0ms) without delay. On touch / mobile, isolated 60ms.
            const toggleDelay = isTouch ? 60 : (onText ? 200 : 0)
            this.app.requestToggleReaderUI(toggleDelay)
        })

        // Mouse wheel / trackpad scrolling handler
        let wheelCooldown = false
        this.events.on(doc, 'wheel', e => {
            if (e.ctrlKey || e.metaKey) {
                if (this.app.foliateView?.isFixedLayout || this.app.currentBookData?.format === 'pdf') {
                    e.preventDefault()
                    this.app.pdfTools.stepPDFZoom(e.deltaY < 0 ? 10 : -10)
                    return
                }
                return
            }

            if (this.app.settings.layout === 'scrolled') return
            // In PDF / Fixed-layout mode, wheel / trackpad must scroll the container for free panning!
            if (this.app.foliateView?.isFixedLayout || this.app.currentBookData?.format === 'pdf') {
                const host = this.app.foliateView?.renderer?.shadowRoot?.host || this.app.foliateView?.renderer
                if (host) {
                    host.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' })
                }
                return
            }

            // In paginated mode, ALWAYS prevent browser native scrolling to protect column alignment!
            e.preventDefault()
            if (wheelCooldown) return
            const absY = Math.abs(e.deltaY)
            const absX = Math.abs(e.deltaX)
            if (absY > 20 || absX > 20) {
                wheelCooldown = true
                const dominantDelta = absY >= absX ? e.deltaY : e.deltaX
                if (dominantDelta > 0) {
                    this.app.turnPageNext()
                } else if (dominantDelta < 0) {
                    this.app.turnPagePrev()
                }
                schedule(() => {
                    if (this.app.foliateView) wheelCooldown = false
                }, 220)
            }
        }, { passive: false })

        // Multi-event listeners for robust text selection with debounce
        const triggerCheckSelection = (e) => {
            if (this.app.pageTurnController?.shouldSuppressTap?.()) {
                const s = doc.getSelection?.()
                if (!s || s.isCollapsed || !s.toString().trim()) return
            }
            if (selectionTimeout) cancelTimer(selectionTimeout)
            if (selectionDebounceTimer) cancelTimer(selectionDebounceTimer)
            selectionDebounceTimer = schedule(() => {
                checkSelection(e)
            }, 40)
        }

        this.events.on(doc, 'pointerup', (e) => triggerCheckSelection(e))
        this.events.on(doc, 'touchend', (e) => triggerCheckSelection(e))
    }
}
