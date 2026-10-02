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
 * Find the nearest preceding heading in the document tree before a DOM node
 */
function findNearestHeadingFromNode(node) {
    if (!node || typeof node !== 'object') return null
    try {
        const el = node.nodeType === 1 ? node : node.parentElement
        if (!el) return null

        // 1. Check if el or direct parent is a heading
        const directHeading = el.closest?.('h1, h2, h3, h4, h5, h6')
        if (directHeading?.textContent?.trim()) {
            return directHeading.textContent.trim()
        }

        // 2. Query document headings in document order
        const doc = el.ownerDocument
        if (doc && typeof doc.querySelectorAll === 'function') {
            const allHeadings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'))
            let lastPreceding = null
            for (const h of allHeadings) {
                if (h === el || h.contains(el)) {
                    return h.textContent.trim()
                }
                const pos = h.compareDocumentPosition(el)
                // pos & 4 (DOCUMENT_POSITION_FOLLOWING): el follows h, meaning h precedes el
                if (pos & 4) {
                    lastPreceding = h
                } else {
                    break
                }
            }
            if (lastPreceding?.textContent?.trim()) {
                return lastPreceding.textContent.trim()
            }
        }

        // 3. Fallback: backwards DOM walk taking the closest (last) heading in preceding siblings
        let curr = el
        let maxWalk = 25
        while (curr && maxWalk-- > 0) {
            let prev = curr.previousElementSibling
            while (prev) {
                if (/^H[1-6]$/i.test(prev.tagName) && prev.textContent?.trim()) {
                    return prev.textContent.trim()
                }
                const nested = prev.querySelectorAll?.('h1, h2, h3, h4, h5, h6')
                if (nested && nested.length > 0) {
                    const lastNested = nested[nested.length - 1]
                    if (lastNested?.textContent?.trim()) {
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

/**
 * Match a DOM node to the most specific TOC item in the current section
 */
function findTocItemByNode(node, sourceToc, sectionHref = '') {
    if (!node || !Array.isArray(sourceToc) || sourceToc.length === 0) return null
    try {
        const el = node.nodeType === 1 ? node : node.parentElement
        if (!el) return null
        const flat = flattenToc(sourceToc)
        const doc = el.ownerDocument

        // Determine current document/section file name
        const docUrl = doc?.defaultView?.location?.href || doc?.URL || sectionHref || ''
        const docFile = docUrl ? docUrl.split(/[?#]/)[0].split('/').pop() : ''

        let bestItem = null
        let bestAnchorEl = null

        // Check each TOC item whose href belongs to this section document
        for (const item of flat) {
            const href = item.href || ''
            const [itemPath, itemId] = href.split('#')
            const itemFile = itemPath ? itemPath.split('/').pop() : ''

            const fileMatches = docFile
                ? (!itemFile || itemFile === docFile || docUrl.endsWith('/' + itemFile) || docFile.endsWith('/' + itemFile))
                : (!itemFile && Boolean(itemId))

            if (fileMatches && itemId && doc && typeof doc.getElementById === 'function') {
                const anchorEl = doc.getElementById(itemId) || doc.querySelector?.(`[name="${CSS.escape ? CSS.escape(itemId) : itemId}"]`)
                if (anchorEl) {
                    if (anchorEl === el || anchorEl.contains(el)) {
                        return item.label?.trim() || null
                    }
                    const pos = anchorEl.compareDocumentPosition(el)
                    if (pos & 4) { // el follows anchorEl
                        if (!bestAnchorEl || (bestAnchorEl.compareDocumentPosition(anchorEl) & 4)) {
                            bestAnchorEl = anchorEl
                            bestItem = item
                        }
                    }
                }
            } else if (!itemId && fileMatches && !bestItem) {
                bestItem = item
            }
        }

        if (bestItem?.label) return bestItem.label.trim()

        // Fallback: check ancestor id matching
        let curr = el
        let maxWalk = 10
        while (curr && maxWalk-- > 0) {
            const id = curr.id
            if (id) {
                const matched = flat.find(item => {
                    const href = item.href || ''
                    const [itemPath, itemId] = href.split('#')
                    const itemFile = itemPath ? itemPath.split('/').pop() : ''
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
        // 1a. Try TOC item matching by anchor within section
        const sectionHref = snapshot.currentLocation?.href || ''
        const tocMatch = findTocItemByNode(range.startContainer, sourceToc, sectionHref)
        if (tocMatch) {
            chapterTitle = sanitizeChapter(tocMatch)
        }
        // 1b. Try nearest preceding heading in the DOM
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
        const activeItem = pdfTocAtPage(tocIdx, pdfPage0)
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
        locationInfo = `第 ${pdfPage0 + 1} 页`
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
