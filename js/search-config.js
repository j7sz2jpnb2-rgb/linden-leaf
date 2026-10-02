// js/search-config.js - Configurable Web Selection Search
// Supports presets (Baidu, Bing, Google, DuckDuckGo) and validated custom URL templates.
// Strictly enforces protocol security, encodes query, limits length, and dispatches via platformBridge.

import { platformBridge } from './platformBridge.js'

export const SEARCH_ENGINES = {
    baidu: {
        name: '百度',
        template: 'https://www.baidu.com/s?wd={query}'
    },
    bing: {
        name: '必应',
        template: 'https://www.bing.com/search?q={query}'
    },
    google: {
        name: 'Google',
        template: 'https://www.google.com/search?q={query}'
    },
    duckduckgo: {
        name: 'DuckDuckGo',
        template: 'https://duckduckgo.com/?q={query}'
    },
    custom: {
        name: '自定义',
        template: ''
    }
}

/**
 * Validates a custom search URL template
 * @param {string} template
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSearchTemplate(template) {
    if (!template || typeof template !== 'string') {
        return { valid: false, error: 'URL 模板不能为空' };
    }
    const trimmed = template.trim();
    if (!trimmed.includes('{query}')) {
        return { valid: false, error: '模板必须包含 {query} 占位符' };
    }
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
        return { valid: false, error: '仅支持以 https:// 或 http:// 开头的网址' };
    }
    // Reject dangerous schemes or credential embedding
    if (/^(javascript|data|file|vbscript):/i.test(trimmed)) {
        return { valid: false, error: '不支持不安全的协议方案' };
    }
    try {
        const parsed = new URL(trimmed.replace('{query}', 'test'));
        if (parsed.username || parsed.password) {
            return { valid: false, error: '禁止在 URL 中包含用户名或密码' };
        }
    } catch (e) {
        return { valid: false, error: 'URL 格式无效，请检查地址结构' };
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
        return { url: null, engineName: '网页搜索', error: '请先选取需要搜索的文本内容', truncated: false };
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
                engineName: '自定义搜索',
                error: `自定义搜索配置无效: ${check.error}，请在设置中调整`,
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
        showToast('选中文本过长，已截取前 120 字进行搜索', 'info', 2000);
    }

    try {
        await platformBridge.openExternal(res.url);
        return true;
    } catch (e) {
        console.error('[SearchConfig] openExternal failed:', e);
        if (showToast) showToast('无法唤起浏览器进行搜索', 'error');
        return false;
    }
}
