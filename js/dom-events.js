// Per-controller listener lifetime. This does not own page/reader-session events.
export class DomEvents {
    constructor() { this.abortController = new AbortController() }
    on(target, type, handler, options = {}) {
        if (!target) return
        const normalized = typeof options === 'boolean' ? { capture: options } : options
        target.addEventListener(type, handler, { ...normalized, signal: this.abortController.signal })
    }
    dispose() { this.abortController.abort(); this.abortController = new AbortController() }
}

/** Checks whether `node` is `root` or inside `root`'s light or Shadow DOM subtrees. */
export function isComposedDescendant(root, node) {
    if (!root || !node) return false
    let curr = node
    while (curr) {
        if (curr === root || (typeof root.contains === 'function' && root.contains(curr))) return true
        const rootNode = typeof curr.getRootNode === 'function' ? curr.getRootNode() : null
        curr = rootNode && rootNode !== curr && rootNode.host ? rootNode.host : null
    }
    return false
}
