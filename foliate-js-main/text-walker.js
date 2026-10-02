const isTextNode = node => node && (node.nodeType === 3 || node.nodeType === 4)

const walkRange = (range, walker) => {
    const nodes = []
    for (let node = isTextNode(walker.currentNode) ? walker.currentNode : walker.nextNode(); node; node = walker.nextNode()) {
        if (!isTextNode(node)) continue
        const compare = range.comparePoint(node, 0)
        if (compare === 0 || (range.intersectsNode && range.intersectsNode(node))) nodes.push(node)
        else if (compare > 0) break
    }
    return nodes
}

const walkDocument = (_, walker) => {
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (isTextNode(node)) nodes.push(node)
    return nodes
}

const filter = NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    | NodeFilter.SHOW_CDATA_SECTION

const acceptNode = node => {
    if (node.nodeType === 1) {
        const name = node.tagName.toLowerCase()
        if (name === 'script' || name === 'style') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_SKIP
    }
    return NodeFilter.FILTER_ACCEPT
}

export const textWalker = function* (x, func, filterFunc) {
    const root = x.commonAncestorContainer ?? x.body ?? x
    if (!root) return
    const doc = root.ownerDocument || (root.nodeType === 9 ? root : document)
    const walker = (doc.createTreeWalker ? doc : document).createTreeWalker(root, filter, { acceptNode: filterFunc || acceptNode })
    const walk = x.commonAncestorContainer ? walkRange : walkDocument
    const nodes = walk(x, walker)
    const strs = nodes.map(node => node.nodeValue ?? '')
    const makeRange = (startIndex, startOffset, endIndex, endOffset) => {
        const startNode = nodes[startIndex]
        const endNode = nodes[endIndex] || startNode
        if (!startNode) return null
        const range = doc.createRange ? doc.createRange() : document.createRange()
        const safeStartOffset = Math.min(startOffset, startNode.nodeValue ? startNode.nodeValue.length : 0)
        const safeEndOffset = Math.min(endOffset, endNode.nodeValue ? endNode.nodeValue.length : 0)
        range.setStart(startNode, safeStartOffset)
        range.setEnd(endNode, safeEndOffset)
        return range
    }
    for (const match of func(strs, makeRange)) {
        if (match.range) yield match
    }
}
