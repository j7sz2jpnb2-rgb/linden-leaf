// A PDF outline is resolved once per document. Page changes should only do a
// predecessor lookup, even when the outline has thousands of destinations.
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
