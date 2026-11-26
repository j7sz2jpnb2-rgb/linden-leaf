/**
 * reader-toolbar-config.js
 * Declarative registry and pure layout resolver for the customizable reader top bar.
 *
 * Design principles:
 * - Core navigation/settings items (`back`, `toc`, `settings`) are pinned and cannot be hidden.
 * - Every optional tool can be toggled by the user in Settings; hidden items automatically
 *   flow into a single tidy overflow menu (`···`) at the right end of `#reader-top-bar`,
 *   so no capability is ever permanently lost.
 */

export const READER_TOOLBAR_ITEMS = Object.freeze([
    {
        key: 'history',
        ids: ['btn-nav-history-back', 'btn-nav-history-forward'],
        group: 'left',
        pinned: false,
        defaultVisible: true,
        i18nKey: 'toolbar.item.history',
        fallbackLabel: 'Back / Forward History',
    },
    {
        key: 'pinWindow',
        ids: ['btn-toggle-pin-window'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        desktopOnly: true,
        i18nKey: 'toolbar.item.pinWindow',
        fallbackLabel: 'Always on Top',
    },
    {
        key: 'refPage',
        ids: ['btn-pin-ref-page'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        pdfOnly: true,
        i18nKey: 'toolbar.item.refPage',
        fallbackLabel: 'Pin Reference Page (PDF)',
    },
    {
        key: 'ocrPage',
        ids: ['btn-ocr-page'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        pdfOnly: true,
        i18nKey: 'toolbar.item.ocrPage',
        fallbackLabel: 'OCR Current Page (PDF)',
    },
    {
        key: 'search',
        ids: ['btn-toggle-search'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        i18nKey: 'toolbar.item.search',
        fallbackLabel: 'Book Search',
    },
    {
        key: 'notes',
        ids: ['btn-toggle-notes'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        i18nKey: 'toolbar.item.notes',
        fallbackLabel: 'Highlights & Notes',
    },
    {
        key: 'exportPdf',
        ids: ['btn-export-annotated-pdf'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        pdfOnly: true,
        i18nKey: 'toolbar.item.exportPdf',
        fallbackLabel: 'Export Annotated PDF',
    },
    {
        key: 'aiSidebar',
        ids: ['btn-toggle-ai-sidebar'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        i18nKey: 'toolbar.item.aiSidebar',
        fallbackLabel: 'AI Reading Assistant',
    },
    {
        key: 'chapterTranslate',
        ids: ['btn-chapter-translate'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        epubOnly: true,
        i18nKey: 'toolbar.item.chapterTranslate',
        fallbackLabel: 'Chapter Translation',
    },
    {
        key: 'tts',
        ids: ['btn-toggle-tts'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        i18nKey: 'toolbar.item.tts',
        fallbackLabel: 'Read Aloud (TTS)',
    },
    {
        key: 'fullscreen',
        ids: ['btn-toggle-fullscreen'],
        group: 'right',
        pinned: false,
        defaultVisible: true,
        desktopOnly: true,
        i18nKey: 'toolbar.item.fullscreen',
        fallbackLabel: 'Fullscreen',
    },
])

export function getDefaultReaderToolbarVisibility() {
    const map = {}
    for (const item of READER_TOOLBAR_ITEMS) {
        map[item.key] = item.defaultVisible !== false
    }
    return map
}

export function normalizeReaderToolbarVisibility(raw) {
    const defaults = getDefaultReaderToolbarVisibility()
    if (!raw || typeof raw !== 'object') return defaults
    const normalized = { ...defaults }
    for (const item of READER_TOOLBAR_ITEMS) {
        if (item.pinned) {
            normalized[item.key] = true
            continue
        }
        if (typeof raw[item.key] === 'boolean') {
            normalized[item.key] = raw[item.key]
        }
    }
    return normalized
}

/**
 * Given current toolbar visibility settings and active reader format/environment,
 * compute which item keys stay directly on `#reader-top-bar` vs move into the `···` overflow menu.
 * @param {Record<string, boolean>} visibility
 * @param {{ isPdf?: boolean, isDesktop?: boolean }} [context]
 * @returns {{ visibleKeys: string[], overflowKeys: string[], hiddenIds: Set<string> }}
 */
export function resolveReaderToolbarLayout(visibility, context = {}) {
    const norm = normalizeReaderToolbarVisibility(visibility)
    const isPdf = Boolean(context.isPdf)
    const isDesktop = context.isDesktop !== false
    const visibleKeys = []
    const overflowKeys = []
    const hiddenIds = new Set()

    for (const item of READER_TOOLBAR_ITEMS) {
        const applicable =
            (!item.pdfOnly || isPdf) &&
            (!item.epubOnly || !isPdf) &&
            (!item.desktopOnly || isDesktop)

        if (item.pinned || norm[item.key] !== false) {
            visibleKeys.push(item.key)
        } else {
            for (const id of item.ids) hiddenIds.add(id)
            if (applicable) {
                overflowKeys.push(item.key)
            }
        }
    }

    return { visibleKeys, overflowKeys, hiddenIds }
}
