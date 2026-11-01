// Detect publisher paper surfaces once per loaded chapter. Theme CSS controls their paint.
const scannedDocuments = new WeakSet()

export const isLightPaperColor = value => {
    const match = /^rgba?\((.*)\)$/i.exec(value || '')
    if (!match) return false
    const parts = match[1].trim().split(/[\s,/]+/)
    if (parts.length < 3) return false
    const component = s => s.endsWith('%') ? parseFloat(s) / 100 : Number(s) / 255
    const alpha = parts[3] == null ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3])
    const channels = parts.slice(0, 3).map(component).map(c => Math.max(0, Math.min(1, c * alpha)))
    if (!Number.isFinite(alpha) || !channels.every(Number.isFinite)) return false
    const linear = channels.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] > .10
}

export const markReaderPaperBackgrounds = doc => {
    if (!doc?.body || !doc.defaultView || scannedDocuments.has(doc)) return 0
    const candidates = new Set()
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */)
    let text
    while ((text = walker.nextNode())) {
        if (!text.nodeValue?.trim()) continue
        let element = text.parentElement
        // Graphic artwork and code surfaces retain their own colors.
        if (element?.closest('svg, math, canvas, video, audio, iframe, object, pre, code, script, style')) continue
        while (element && element !== doc.body && !candidates.has(element)) {
            candidates.add(element)
            element = element.parentElement
        }
    }
    const paper = []
    for (const element of candidates) {
        const style = doc.defaultView.getComputedStyle(element)
        if (style.backgroundImage === 'none' && isLightPaperColor(style.backgroundColor)) paper.push(element)
    }
    // Batch writes after style reads; no text, geometry, or publisher declarations are changed.
    for (const element of paper) element.setAttribute('data-reader-paper-background', '')
    scannedDocuments.add(doc)
    return paper.length
}
