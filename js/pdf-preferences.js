// The existing per-book keys are retained so upgrades do not reset reading settings.
const prefixes = Object.freeze({ scan: 'linden_scan_', columns: 'linden_col_cfg_' })

export const pdfPreferenceKey = (bookId, kind) => {
    if (!prefixes[kind]) throw new Error(`Unknown PDF preference: ${kind}`)
    return prefixes[kind] + bookId
}

export function readPdfPreference(bookId, kind, storage = globalThis.localStorage) {
    const raw = storage?.getItem(pdfPreferenceKey(bookId, kind))
    try { return JSON.parse(raw || 'null') }
    catch { return kind === 'scan' && raw ? { preset: raw } : null }
}

export function writePdfPreference(bookId, kind, value, storage = globalThis.localStorage) {
    const key = pdfPreferenceKey(bookId, kind)
    if (value == null) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(value))
}

export function collectPdfPreferences(books, storage = globalThis.localStorage) {
    return Object.fromEntries(books.filter(b => b?.id).map(b => [b.id, {
        scan: readPdfPreference(b.id, 'scan', storage),
        columns: readPdfPreference(b.id, 'columns', storage)
    }]).filter(([, values]) => values.scan || values.columns))
}

export function restoredPdfPreferenceEntries(preferences = {}, remap = new Map(), validBookIds = null) {
    const entries = []
    for (const [id, values] of Object.entries(preferences)) {
        const target = remap.get(id) || id
        if (validBookIds && !validBookIds.has(target)) continue
        for (const kind of Object.keys(prefixes)) {
            if (values?.[kind] && typeof values[kind] === 'object') {
                entries.push([pdfPreferenceKey(target, kind), JSON.stringify(values[kind])])
            }
        }
    }
    return entries
}
