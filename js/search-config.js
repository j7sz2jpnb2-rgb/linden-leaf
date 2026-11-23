// js/search-config.js - Configurable Web Selection Search
// Supports presets (Baidu, Bing, Google, DuckDuckGo) and validated custom URL templates.
// Strictly enforces protocol security, encodes query, limits length, and dispatches via platformBridge.

import { platformBridge } from './platformBridge.js'
import { t } from './i18n.js'

export const SEARCH_ENGINES = {
    baidu: {
        get name() { return t('searchConfig.engine.baidu') },
        template: 'https://www.baidu.com/s?wd={query}'
    },
    bing: {
        get name() { return t('searchConfig.engine.bing') },
        template: 'https://www.bing.com/search?q={query}'
    },
    google: {
        get name() { return t('searchConfig.engine.google') },
        template: 'https://www.google.com/search?q={query}'
    },
    duckduckgo: {
        get name() { return t('searchConfig.engine.duckduckgo') },
        template: 'https://duckduckgo.com/?q={query}'
    },
    custom: {
        get name() { return t('searchConfig.engine.custom') },
        template: ''
    }
}

export function getSearchEngineName(key) {
    return SEARCH_ENGINES[key]?.name || SEARCH_ENGINES.baidu.name
}

/**
 * Validates a custom search URL template
 * @param {string} template
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSearchTemplate(template) {
    if (!template || typeof template !== 'string') {
        return { valid: false, error: t('searchConfig.templateEmpty') };
    }
    const trimmed = template.trim();
    if (!trimmed.includes('{query}')) {
        return { valid: false, error: t('searchConfig.needQuery') };
    }
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
        return { valid: false, error: t('searchConfig.invalidProtocol') };
    }
    // Reject dangerous schemes or credential embedding
    if (/^(javascript|data|file|vbscript):/i.test(trimmed)) {
        return { valid: false, error: t('searchConfig.unsafeScheme') };
    }
    try {
        const parsed = new URL(trimmed.replace('{query}', 'test'));
        if (parsed.username || parsed.password) {
            return { valid: false, error: t('searchConfig.noCredentials') };
        }
    } catch (e) {
        return { valid: false, error: t('searchConfig.invalidUrl') };
    }
    return { valid: true };
}

/**
 * Builds the external search URL from configured engine and selected text
 * @param {object} settings Reader settings object
 * @param {string} selectedText Text to search
 * @returns {{ url: string | null, engineName: string, error?: string, truncated: boolean }}
 */
export function buildSearchUrl(settings, selectedText) {
    if (!selectedText || !selectedText.trim()) {
        return { url: null, engineName: t('searchConfig.webSearchTitle'), error: t('searchConfig.selectTextFirst'), truncated: false };
    }

    const engineKey = settings?.searchEngine || 'baidu';
    const engineDef = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.baidu;
    let template = engineDef.template;

    if (engineKey === 'custom') {
        const customUrl = (settings?.searchCustomUrl || '').trim();
        const check = validateSearchTemplate(customUrl);
        if (!check.valid) {
            return {
                url: null,
                engineName: t('searchConfig.customSearchName'),
                error: t('searchConfig.customConfigError', { error: check.error }),
                truncated: false
            };
        }
        template = customUrl;
    }

    // Limit unreasonable query length (max 120 characters) to avoid URL overflow and accidental whole-chapter upload
    let queryText = selectedText.trim();
    let truncated = false;
    if (queryText.length > 120) {
        queryText = queryText.slice(0, 120);
        truncated = true;
    }

    const encoded = encodeURIComponent(queryText);
    const finalUrl = template.replace('{query}', encoded);

    return {
        url: finalUrl,
        engineName: engineDef.name,
        truncated,
        queryText
    };
}

/**
 * Perform web search by opening external browser safely
 * @param {object} settings
 * @param {string} selectedText
 * @param {function(string, string): void} [showToast]
 * @returns {Promise<boolean>}
 */
export async function performWebSearch(settings, selectedText, showToast) {
    const res = buildSearchUrl(settings, selectedText);
    if (!res.url) {
        if (showToast && res.error) showToast(res.error, 'warning');
        return false;
    }

    if (res.truncated && showToast) {
        showToast(t('searchConfig.truncatedToast'), 'info', 2000);
    }

    try {
        await platformBridge.openExternal(res.url);
        return true;
    } catch (e) {
        console.error('[SearchConfig] openExternal failed:', e);
        if (showToast) showToast(t('searchConfig.openFailed'), 'error');
        return false;
    }
}
