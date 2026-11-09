// js/pdf-toc.js - PDF Outline Indexing, Manual Table of Contents & OCR Assisted TOC (S01)

export function buildPdfTocIndex(toc) {
    const index = [], stack = [...(toc || [])].reverse()
    while (stack.length) {
        const item = stack.pop()
        const fallback = /^#page=(\d+)$/.exec(item.href || '')
        const page = Number.isInteger(item.page) ? item.page : fallback ? Number(fallback[1]) - 1 : -1
        if (page >= 0) index.push({ page, item, order: index.length })
        if (item.subitems?.length) {
            for (let i = item.subitems.length - 1; i >= 0; --i) stack.push(item.subitems[i])
        }
    }
    index.sort((a, b) => a.page - b.page || a.order - b.order)
    return index
}

export function pdfTocAtPage(index, page) {
    let lo = 0, hi = index?.length || 0
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (index[mid].page <= page) lo = mid + 1
        else hi = mid
    }
    return lo ? index[lo - 1].item : null
}

/**
 * Roman numeral parser for front-matter page numbers (e.g. "iv", "XII")
 */
export function romanToInt(str) {
    if (!str || typeof str !== 'string') return null
    const clean = str.trim().toUpperCase()
    if (!/^[IVXLCDM]+$/.test(clean)) return null
    const romanMap = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
    let sum = 0
    for (let i = 0; i < clean.length; i++) {
        const cur = romanMap[clean[i]]
        const next = romanMap[clean[i + 1]]
        if (next && cur < next) {
            sum += (next - cur)
            i++
        } else {
            sum += cur
        }
    }
    return sum > 0 ? sum : null
}

/**
 * Detect parent-child cyclic reference in TOC hierarchy
 */
export function detectTocCycle(items, itemId, newParentId) {
    if (!newParentId || itemId === newParentId) return itemId === newParentId
    const itemMap = new Map((items || []).map(it => [it.id, it]))
    let cur = newParentId
    const visited = new Set([itemId])
    while (cur) {
        if (visited.has(cur)) return true
        visited.add(cur)
        const parent = itemMap.get(cur)
        cur = parent?.parentId || null
    }
    return false
}

/**
 * Create a new manual TOC item record with schema compliance
 */
export function createManualTocItem({
    id = null,
    parentId = null,
    title = '',
    pageIndex = 0,
    pageLabel = null,
    yRatio = 0,
    order = 0,
    documentIdentity = null
} = {}) {
    return {
        id: id || `toc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        parentId: parentId || null,
        title: (title || '').trim(),
        pageIndex: Math.max(0, parseInt(pageIndex, 10) || 0),
        pageLabel: pageLabel != null ? String(pageLabel).trim() : null,
        yRatio: Math.max(0, Math.min(1, parseFloat(yRatio) || 0)),
        order: Number(order) || 0,
        updatedAt: Date.now(),
        documentIdentity: documentIdentity || null
    }
}

/**
 * Add a manual TOC item with validation
 */
export function addManualTocItem(items, newItemData, { maxPages = null } = {}) {
    const list = Array.isArray(items) ? [...items] : []
    const item = createManualTocItem(newItemData)
    if (!item.title) throw new Error('目录标题不能为空')
    if (maxPages != null && item.pageIndex >= maxPages) {
        throw new Error(`页码 ${item.pageIndex + 1} 超出文档总页数 (${maxPages}页)`)
    }
    if (item.parentId && detectTocCycle(list, item.id, item.parentId)) {
        throw new Error('检测到目录层级循环嵌套，无法指定该父项')
    }
    if (!item.order) {
        item.order = list.length > 0 ? Math.max(...list.map(it => it.order || 0)) + 1 : 0
    }
    list.push(item)
    return list
}

/**
 * Update an existing manual TOC item
 */
export function updateManualTocItem(items, id, updates = {}, { maxPages = null } = {}) {
    const list = Array.isArray(items) ? [...items] : []
    const idx = list.findIndex(it => it.id === id)
    if (idx === -1) throw new Error(`未找到 ID 为 ${id} 的目录项`)

    const current = list[idx]
    const nextParentId = updates.parentId !== undefined ? updates.parentId : current.parentId
    if (nextParentId && detectTocCycle(list, id, nextParentId)) {
        throw new Error('检测到目录层级循环嵌套，无法指定该父项')
    }

    const nextPage = updates.pageIndex !== undefined ? Math.max(0, parseInt(updates.pageIndex, 10) || 0) : current.pageIndex
    if (maxPages != null && nextPage >= maxPages) {
        throw new Error(`页码 ${nextPage + 1} 超出文档总页数 (${maxPages}页)`)
    }

    list[idx] = {
        ...current,
        ...updates,
        id,
        parentId: nextParentId || null,
        pageIndex: nextPage,
        updatedAt: Date.now()
    }
    return list
}

/**
 * Delete a manual TOC item and safely reparent orphaned children
 */
export function deleteManualTocItem(items, id) {
    const list = Array.isArray(items) ? [...items] : []
    const target = list.find(it => it.id === id)
    if (!target) return list

    const newParentId = target.parentId || null
    return list
        .filter(it => it.id !== id)
        .map(it => it.parentId === id ? { ...it, parentId: newParentId, updatedAt: Date.now() } : it)
}

/**
 * Reorder manual TOC items stably by IDs
 */
export function reorderManualTocItems(items, orderedIds) {
    const list = Array.isArray(items) ? [...items] : []
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]))
    return list.map(it => ({
        ...it,
        order: orderMap.has(it.id) ? orderMap.get(it.id) : it.order,
        updatedAt: Date.now()
    })).sort((a, b) => (a.order - b.order) || (a.pageIndex - b.pageIndex))
}

/**
 * Convert flat manual TOC list to nested tree structure
 */
export function buildNestedToc(items) {
    const list = Array.isArray(items) ? [...items] : []
    const roots = []
    const childrenMap = new Map()

    for (const it of list) {
        if (!childrenMap.has(it.id)) childrenMap.set(it.id, [])
    }

    for (const it of list) {
        if (it.parentId && childrenMap.has(it.parentId)) {
            childrenMap.get(it.parentId).push(it)
        } else {
            roots.push(it)
        }
    }

    const sortNodes = (arr) => {
        arr.sort((a, b) => (a.order - b.order) || (a.pageIndex - b.pageIndex))
        for (const node of arr) {
            const subs = childrenMap.get(node.id) || []
            if (subs.length > 0) {
                sortNodes(subs)
                node.subitems = subs
            } else {
                delete node.subitems
            }
        }
    }

    sortNodes(roots)
    return roots
}

/**
 * Parse OCR lines into table-of-contents candidates
 * Supports dot leaders, page numbers, Roman numerals, and offset correction
 */
export function parseOcrTocCandidates(lines, { pageOffset = 0, totalPages = null } = {}) {
    const candidates = []
    if (!Array.isArray(lines)) return candidates

    for (const rawLine of lines) {
        const line = (typeof rawLine === 'string' ? rawLine : rawLine?.text || '').trim()
        if (!line || line.length < 2) continue

        // Pattern 1: Title ...... 123 or Title . . . 123 or Title 123
        const match = /^(.*?)(?:[.\s·…_-]{2,}|\s+)(\b[ivxlcdm]+\b|\d+)\s*$/i.exec(line)
        if (match) {
            const rawTitle = match[1].replace(/[.\s·…_-]+$/, '').trim()
            const rawPage = match[2].trim()
            if (!rawTitle) continue

            let printedPage = null
            const isRoman = /^[ivxlcdm]+$/i.test(rawPage)
            if (isRoman) {
                printedPage = romanToInt(rawPage)
            } else {
                printedPage = parseInt(rawPage, 10)
            }

            if (Number.isInteger(printedPage) && printedPage > 0) {
                const physicalPageIndex = printedPage + pageOffset - 1
                if (physicalPageIndex >= 0 && (totalPages == null || physicalPageIndex < totalPages)) {
                    candidates.push({
                        title: rawTitle,
                        printedPage,
                        pageLabel: rawPage,
                        pageIndex: physicalPageIndex,
                        rawText: line
                    })
                }
            }
        }
    }

    return candidates
}

/**
 * Export manual TOC as structured JSON
 */
export function exportTocAsJson(items, metadata = {}) {
    return JSON.stringify({
        format: 'linden-leaf-toc',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        metadata,
        items: Array.isArray(items) ? items : []
    }, null, 2)
}

/**
 * Export manual TOC as hierarchical Markdown
 */
export function exportTocAsMarkdown(items) {
    const nested = buildNestedToc(items)
    const lines = []

    const walk = (nodes, depth = 0) => {
        const indent = '  '.repeat(depth)
        for (const node of nodes) {
            const pageStr = node.pageLabel ? `${node.pageLabel} (p.${node.pageIndex + 1})` : `p.${node.pageIndex + 1}`
            lines.push(`${indent}- [${node.title}](#page=${node.pageIndex + 1}) —— ${pageStr}`)
            if (node.subitems?.length) {
                walk(node.subitems, depth + 1)
            }
        }
    }

    walk(nested, 0)
    return lines.join('\n')
}
