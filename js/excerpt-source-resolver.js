/**
 * excerpt-source-resolver.js
 * Unified source resolver for excerpt sharing (selection & highlight cards).
 * 
 * Rules:
 * 1. Prefer chapter of selection's first node (nearest preceding heading or matching TOC anchor in section).
 * 2. Fall back to chapter of current visible screen / page.
 * 3. Fall back when no TOC or no matching chapter:
 *    - PDF with page number: locationInfo = "第 N 页", chapterTitle = "".
 *    - EPUB/TXT/reflow: chapterTitle = "", locationInfo = "".
 *    - Strictly prohibit injecting reading percentage (e.g. "42%") as chapterTitle or locationInfo.
 * 4. Preserve footnote markers like [1] or ① in chapter titles (no cleanFootnoteMarkers on chapter).
 */

import { buildPdfTocIndex, pdfTocAtPage } from './pdf-toc.js'
import { t } from './i18n.js'

/**
 * Recursively search a TOC tree for an item matching a predicate
 */
export function findTocItem(toc, predicate) {
    if (!Array.isArray(toc) || !predicate) return null
    for (const item of toc) {
        if (predicate(item)) return item
        if (item.subitems?.length) {
            const found = findTocItem(item.subitems, predicate)
            if (found) return found
        }
    }
    return null
}

/**
 * Flatten a TOC tree into an array preserving hierarchical order
 */
export function flattenToc(toc) {
    const list = []
    if (!Array.isArray(toc)) return list
    const stack = [...toc].reverse()
    while (stack.length > 0) {
        const item = stack.pop()
        list.push(item)
        if (item.subitems?.length) {
            for (let i = item.subitems.length - 1; i >= 0; i--) {
                stack.push(item.subitems[i])
            }
        }
    }
    return list
}

/**
 * Check whether an element looks like a section/poem heading (h1-h6, role="heading",
 * or common EPUB poetry/chapter title classes).
 */
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"], .poem-title, .chapter-title, .section-title, .entry-title, p.title, div.title'

function isHeadingCandidate(el) {
    if (!el || el.nodeType !== 1) return false
    const text = el.textContent?.trim()
    if (!text || text.length > 160) return false
    if (/^H[1-6]$/i.test(el.tagName)) return true
    if (el.getAttribute?.('role') === 'heading') return true
    const cls = el.classList
    if (cls && (cls.contains('poem-title') || cls.contains('chapter-title') || cls.contains('section-title') || cls.contains('entry-title') || cls.contains('title'))) {
        return true
    }
    return false
}

/**
 * Find the nearest preceding heading in the document tree strictly before (or containing) a DOM node.
 */
function findNearestHeadingFromNode(node) {
    if (!node || typeof node !== 'object') return null
    try {
        const el = node.nodeType === 1 ? node : node.parentElement
        if (!el) return null

        // 1. Check if el or direct parent is a heading
        const directHeading = el.closest?.('h1, h2, h3, h4, h5, h6, [role="heading"]')
        if (directHeading?.textContent?.trim()) {
            return directHeading.textContent.trim()
        }

        // 2. Query document headings in document order (prefer semantic headings first, then title classes)
        const doc = el.ownerDocument
        if (doc && typeof doc.querySelectorAll === 'function') {
            const pickLastPreceding = (selector) => {
                const nodes = Array.from(doc.querySelectorAll(selector))
                let lastPreceding = null
                for (const h of nodes) {
                    if (!isHeadingCandidate(h)) continue
                    if (h === el || h.contains(el)) {
                        return h.textContent.trim()
                    }
                    const pos = h.compareDocumentPosition(el)
                    // pos & 4 (DOCUMENT_POSITION_FOLLOWING): el follows h -> h strictly precedes el
                    if (pos & 4) {
                        lastPreceding = h
                    } else if (pos & 2) {
                        // h follows el -> stop so we never pick a later poem/chapter on the same page
                        break
                    }
                }
                return lastPreceding?.textContent?.trim() || null
            }

            const semanticMatch = pickLastPreceding('h1, h2, h3, h4, h5, h6, [role="heading"]')
            if (semanticMatch) return semanticMatch

            const classMatch = pickLastPreceding(HEADING_SELECTOR)
            if (classMatch) return classMatch
        }

        // 3. Fallback: backwards DOM walk taking the closest (last) heading in preceding siblings
        let curr = el
        let maxWalk = 25
        while (curr && maxWalk-- > 0) {
            let prev = curr.previousElementSibling
            while (prev) {
                if (isHeadingCandidate(prev)) {
                    return prev.textContent.trim()
                }
                const nested = prev.querySelectorAll?.(HEADING_SELECTOR)
                if (nested && nested.length > 0) {
                    const lastNested = nested[nested.length - 1]
                    if (isHeadingCandidate(lastNested)) {
                        return lastNested.textContent.trim()
                    }
                }
                prev = prev.previousElementSibling
            }
            curr = curr.parentElement
            if (!curr || curr.tagName === 'BODY' || curr.tagName === 'HTML') break
        }
    } catch (e) {
        console.debug('Heading walk error:', e)
    }
    return null
}

function normalizeSectionHref(rawHref) {
    if (!rawHref || typeof rawHref !== 'string') return ''
    const trimmed = rawHref.trim()
    // Foliate renders EPUB sections in blob: iframes whose tail is a random UUID, never a real file path
    if (/^(?:blob:|about:|data:)/i.test(trimmed)) return ''
    return trimmed.split(/[?#]/)[0]
}

function extractFileName(pathStr) {
    if (!pathStr) return ''
    try {
        return decodeURIComponent(pathStr.split('/').pop() || '')
    } catch (_) {
        return pathStr.split('/').pop() || ''
    }
}

function resolveSectionHrefFromReader(node, snapshot = {}) {
    if (snapshot.sectionHref) return snapshot.sectionHref
    const doc = node?.nodeType === 9 ? node : node?.ownerDocument
    const reader = snapshot.reader
    if (reader && doc) {
        try {
            const contents = reader.renderer?.getContents?.() || []
            const matchedContent = contents.find(c => c?.doc === doc)
            if (matchedContent != null && matchedContent.index != null) {
                const sec = reader.book?.sections?.[matchedContent.index]
                if (sec?.id) return sec.id
            }
        } catch (_) {}
    }
    if (snapshot.currentLocation?.href) return snapshot.currentLocation.href
    if (snapshot.currentLocation?.tocItem?.href) return snapshot.currentLocation.tocItem.href
    return ''
}

/**
 * Match a DOM node to the most specific TOC item strictly preceding (or containing) it
 * in the current section document.
 */
function findTocItemByNode(node, sourceToc, sectionHref = '') {
    if (!node || !Array.isArray(sourceToc) || sourceToc.length === 0) return null
    try {
        const el = node.nodeType === 1 ? node : node.parentElement
        if (!el) return null
        const flat = flattenToc(sourceToc)
        const doc = el.ownerDocument

        // Prefer real spine/section href over iframe blob: URL
        const realSectionPath = normalizeSectionHref(sectionHref)
            || normalizeSectionHref(doc?.defaultView?.location?.href || '')
            || normalizeSectionHref(doc?.URL || '')
        const docFile = extractFileName(realSectionPath)

        let bestAnchorItem = null
        let bestAnchorEl = null
        let sectionLevelFallback = null
        let sawAnyAnchorInDoc = false

        // Check each TOC item whose href belongs to this section document (or whose #id exists in doc)
        for (const item of flat) {
            const href = item.href || ''
            const hashIdx = href.indexOf('#')
            const itemPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href
            const itemId = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''
            const cleanItemPath = normalizeSectionHref(itemPath)
            const itemFile = extractFileName(cleanItemPath)

            const fileMatches = docFile
                ? (!itemFile || itemFile === docFile || realSectionPath.endsWith('/' + itemFile) || cleanItemPath.endsWith('/' + docFile))
                : false

            if (itemId && doc && typeof doc.getElementById === 'function' && (fileMatches || !docFile)) {
                const escapedId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
                    ? CSS.escape(itemId)
                    : itemId.replace(/["\\]/g, '\\$&')
                const anchorEl = doc.getElementById(itemId) || doc.querySelector?.(`[name="${escapedId}"]`)
                if (anchorEl) {
                    sawAnyAnchorInDoc = true
                    if (anchorEl === el || anchorEl.contains(el)) {
                        return item.label?.trim() || null
                    }
                    const pos = anchorEl.compareDocumentPosition(el)
                    if (pos & 4) { // el strictly follows anchorEl
                        if (!bestAnchorEl || (bestAnchorEl.compareDocumentPosition(anchorEl) & 4)) {
                            bestAnchorEl = anchorEl
                            bestAnchorItem = item
                        }
                    }
                }
            } else if (!itemId && fileMatches && !sectionLevelFallback) {
                sectionLevelFallback = item
            }
        }

        if (bestAnchorItem?.label) return bestAnchorItem.label.trim()

        // If the document has TOC anchors (e.g. Poem B starts halfway down the same file),
        // and the selection sits BEFORE the first anchor in this file, the selection belongs to
        // either the file-level TOC item (if any) or the immediately preceding TOC item before that anchor!
        if (sawAnyAnchorInDoc && !bestAnchorItem) {
            if (sectionLevelFallback?.label) return sectionLevelFallback.label.trim()
            const firstInDocIdx = flat.findIndex(item => {
                const href = item.href || ''
                const hashIdx = href.indexOf('#')
                const itemId = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''
                if (!itemId || !doc?.getElementById) return false
                return Boolean(doc.getElementById(itemId))
            })
            if (firstInDocIdx > 0 && flat[firstInDocIdx - 1]?.label) {
                return flat[firstInDocIdx - 1].label.trim()
            }
        }

        if (sectionLevelFallback?.label) return sectionLevelFallback.label.trim()

        // Fallback: check ancestor id matching
        let curr = el
        let maxWalk = 10
        while (curr && maxWalk-- > 0) {
            const id = curr.id
            if (id) {
                const matched = flat.find(item => {
                    const href = item.href || ''
                    const hashIdx = href.indexOf('#')
                    const itemPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href
                    const itemId = hashIdx >= 0 ? href.slice(hashIdx + 1) : ''
                    const itemFile = extractFileName(normalizeSectionHref(itemPath))
                    const fileMatches = !itemFile || !docFile || itemFile === docFile
                    return fileMatches && itemId === id
                })
                if (matched?.label) return matched.label.trim()
            }
            curr = curr.parentElement
            if (!curr || curr.tagName === 'BODY') break
        }
    } catch (e) {
        console.debug('TOC node match error:', e)
    }
    return null
}

/**
 * Main resolution function
 * @param {Object} snapshot - Reader / selection snapshot
 * @param {Array} sourceToc - Document TOC tree
 * @returns {{ chapterTitle: string, locationInfo: string, source: string }}
 */
export function resolveExcerptSource(snapshot = {}, sourceToc = []) {
    if (snapshot && typeof snapshot === 'object' && snapshot.snapshot && snapshot.sourceToc && arguments.length === 1) {
        sourceToc = snapshot.sourceToc
        snapshot = snapshot.snapshot
    }
    const isPdf = snapshot.format === 'pdf' || !!snapshot.pdfViewport || snapshot.highlight?.formatType === 'pdf' || !!snapshot.highlight?.pdfTarget
    let chapterTitle = ''
    let locationInfo = ''

    // Helper to sanitize chapter title: strip trailing percentage pollution while preserving legitimate titles
    const sanitizeChapter = title => {
        if (!title) return ''
        let s = String(title).trim()
        if (/^\d{1,3}(?:\.\d+)?%$/.test(s)) {
            const isLegitTocTitle = sourceToc && flattenToc(sourceToc).some(item => item.label?.trim() === s)
            if (!isLegitTocTitle) return ''
        }
        s = s.replace(/\s*[·•\-–]\s*\d{1,3}(?:\.\d+)?%\s*$/, '').trim()
        s = s.replace(/\s*\(\s*\d{1,3}(?:\.\d+)?%\s*\)\s*$/, '').trim()
        return s
    }

    // Determine normalized 0-based PDF page index if applicable
    let pdfPage0 = null
    if (isPdf) {
        if (snapshot.pageIndex != null) {
            pdfPage0 = Number(snapshot.pageIndex)
        } else if (snapshot.page != null) {
            pdfPage0 = Number(snapshot.page) - 1
        } else if (snapshot.currentLocation?.page != null) {
            pdfPage0 = Number(snapshot.currentLocation.page) - 1
        } else if (snapshot.pdfViewport?.currentPage != null) {
            pdfPage0 = Number(snapshot.pdfViewport.currentPage) - 1
        } else if (snapshot.highlight?.pdfTarget) {
            const target = snapshot.highlight.pdfTarget
            const firstSeg = Array.isArray(target.segments) ? target.segments[0] : null
            const rawPage = firstSeg?.page ?? target.page
            if (rawPage != null) pdfPage0 = Number(rawPage) - 1
        }
        if (pdfPage0 != null && (isNaN(pdfPage0) || pdfPage0 < 0)) {
            pdfPage0 = 0
        }
    }

    // --- STEP 1: Try selection's first node (Priority 1) ---
    const range = snapshot.range
    if (range && typeof range === 'object' && range.startContainer) {
        // 1a. Try TOC item matching by anchor within section (using real spine href, never blob: URL)
        const sectionHref = resolveSectionHrefFromReader(range.startContainer, snapshot)
        const tocMatch = findTocItemByNode(range.startContainer, sourceToc, sectionHref)
        if (tocMatch) {
            chapterTitle = sanitizeChapter(tocMatch)
        }
        // 1b. Try nearest preceding heading in the DOM strictly before selection start
        if (!chapterTitle) {
            const heading = findNearestHeadingFromNode(range.startContainer)
            if (heading) {
                chapterTitle = sanitizeChapter(heading)
            }
        }
    }

    // --- STEP 2: Fall back to visible screen / page / highlight metadata (Priority 2) ---
    if (!chapterTitle && snapshot.chapterTitle) {
        chapterTitle = sanitizeChapter(snapshot.chapterTitle)
    }

    if (!chapterTitle && isPdf && pdfPage0 != null) {
        const tocIdx = buildPdfTocIndex(sourceToc)
        // If selection Y coordinate is available and a TOC item begins lower on the same page
        // (e.g. end of Poem A at top of page, start of Poem B halfway down), choose the preceding TOC item.
        const pdfTarget = snapshot.pdfTarget || snapshot.highlight?.pdfTarget
        const firstSeg = Array.isArray(pdfTarget?.segments) ? pdfTarget.segments[0] : null
        const firstRect = (firstSeg?.rects?.[0]) || (pdfTarget?.rects?.[0]) || null
        const selectionY = Array.isArray(firstRect) && Number.isFinite(firstRect[1]) ? firstRect[1] : null

        let activeItem = null
        if (selectionY != null && Array.isArray(tocIdx) && tocIdx.length > 0) {
            for (const entry of tocIdx) {
                const tocNode = entry?.item || entry
                if (entry.page < pdfPage0) {
                    activeItem = tocNode
                } else if (entry.page === pdfPage0) {
                    const entryY = Number.isFinite(tocNode?.yRatio) ? tocNode.yRatio : null
                    if (entryY != null) {
                        if (entryY <= selectionY + 0.02) activeItem = tocNode
                    } else if (selectionY >= 0.45 || !activeItem) {
                        // When PDF TOC has no Y anchor and a new entry starts on this page,
                        // avoid assigning a mid-page new chapter to a selection near the top of the page.
                        activeItem = tocNode
                    }
                } else {
                    break
                }
            }
        }
        if (!activeItem) {
            activeItem = pdfTocAtPage(tocIdx, pdfPage0)
        }
        if (activeItem?.label) {
            chapterTitle = sanitizeChapter(activeItem.label)
        }
    }

    if (!chapterTitle && snapshot.currentLocation?.tocItem?.label) {
        chapterTitle = sanitizeChapter(snapshot.currentLocation.tocItem.label)
    }

    if (!chapterTitle && snapshot.currentLocation?.href && Array.isArray(sourceToc)) {
        const href = snapshot.currentLocation.href
        const matched = findTocItem(sourceToc, item => {
            if (!item.href) return false
            if (item.href === href) return true
            const itemClean = item.href.split('#')[0]
            const hrefClean = href.split('#')[0]
            if (itemClean === hrefClean) return true
            const itemLast = itemClean.split('/').pop()
            const hrefLast = hrefClean.split('/').pop()
            return Boolean(itemLast && hrefLast && itemLast === hrefLast)
        })
        if (matched?.label) {
            chapterTitle = sanitizeChapter(matched.label)
        }
    }

    // --- STEP 3: Location resolution ---
    if (snapshot.locationInfo != null && String(snapshot.locationInfo).trim() !== '') {
        const explicitLoc = String(snapshot.locationInfo).trim()
        if (!isPdf && /^\d{1,3}(?:\.\d+)?%$/.test(explicitLoc)) {
            locationInfo = ''
        } else {
            locationInfo = explicitLoc
        }
    } else if (isPdf && pdfPage0 != null) {
        locationInfo = t('common.pageNumber', { page: pdfPage0 + 1 })
    } else {
        locationInfo = ''
    }

    // Format combined source for backward compatibility
    const parts = []
    if (chapterTitle) parts.push(chapterTitle)
    if (locationInfo) parts.push(locationInfo)
    const source = parts.join(' · ')

    return {
        chapterTitle,
        locationInfo,
        source
    }
}
