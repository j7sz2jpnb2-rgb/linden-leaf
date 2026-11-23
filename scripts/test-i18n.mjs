import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZH_CN } from '../js/i18n-zh.js';
import { EN } from '../js/i18n-en.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_ZH_PATH = path.join(REPO_ROOT, 'js', 'i18n-zh.js');
const I18N_EN_PATH = path.join(REPO_ROOT, 'js', 'i18n-en.js');
const INDEX_HTML_PATH = path.join(REPO_ROOT, 'index.html');
const JS_DIR = path.join(REPO_ROOT, 'js');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log('[PASS]', name);
    } catch (err) {
        failed++;
        console.error('[FAIL]', name, '-', err.stack || err.message || err);
    }
}

/**
 * Extracts top-level property keys from a dictionary object literal without
 * collapsing duplicates at runtime.
 */
function extractDictSourceKeys(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const occurrences = new Map();
    let i = 0;
    let braceDepth = 0;
    let inObject = false;
    let line = 1;

    const addKey = (key, keyLine) => {
        if (!occurrences.has(key)) occurrences.set(key, []);
        occurrences.get(key).push(keyLine);
    };

    const readQuoted = (quote) => {
        const startLine = line;
        i++;
        let val = '';
        while (i < src.length) {
            const ch = src[i];
            if (ch === '\\') {
                if (i + 1 < src.length) {
                    val += ch + src[i + 1];
                    if (src[i + 1] === '\n') line++;
                    i += 2;
                    continue;
                }
            }
            if (ch === '\n') line++;
            if (ch === quote) {
                i++;
                return { val, startLine };
            }
            val += ch;
            i++;
        }
        return { val, startLine };
    };

    while (i < src.length) {
        const ch = src[i];
        if (ch === '\n') {
            line++;
            i++;
            continue;
        }
        // Skip comments outside strings
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') line++;
                i++;
            }
            i += 2;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            if (inObject && braceDepth === 1) {
                const { val, startLine } = readQuoted(ch);
                let j = i;
                while (j < src.length && /\s/.test(src[j])) j++;
                if (src[j] === ':') {
                    addKey(val, startLine);
                }
                continue;
            }
            readQuoted(ch);
            continue;
        }
        if (ch === '`') {
            i++;
            while (i < src.length && src[i] !== '`') {
                if (src[i] === '\\') {
                    if (src[i + 1] === '\n') line++;
                    i += 2;
                    continue;
                }
                if (src[i] === '\n') line++;
                i++;
            }
            i++;
            continue;
        }
        if (ch === '{') {
            braceDepth++;
            if (braceDepth === 1) inObject = true;
        } else if (ch === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            if (braceDepth === 0) inObject = false;
        }
        i++;
    }
    return occurrences;
}

function extractPlaceholders(str) {
    const out = new Set();
    for (const m of String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
        out.add(m[1]);
    }
    return [...out].sort();
}

function stripJsComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            out += '  ';
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            if (i < src.length) {
                out += '  ';
                i += 2;
            }
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch;
            out += ch;
            i++;
            while (i < src.length) {
                const c = src[i];
                out += c;
                if (c === '\\' && i + 1 < src.length) {
                    out += src[i + 1];
                    i += 2;
                    continue;
                }
                if (quote === '`' && c === '$' && src[i + 1] === '{') {
                    out += '{';
                    i += 2;
                    let nested = 1;
                    while (i < src.length && nested > 0) {
                        const nc = src[i];
                        out += nc;
                        if (nc === '{') nested++;
                        else if (nc === '}') nested--;
                        else if (nc === '\\' && i + 1 < src.length) {
                            out += src[i + 1];
                            i += 2;
                            continue;
                        }
                        i++;
                    }
                    continue;
                }
                i++;
                if (c === quote) break;
            }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function installI18nGlobals({ savedLocale = null, userInitialized = null, navLang = 'zh-CN' } = {}) {
    const store = new Map();
    if (savedLocale !== null) store.set('linden_locale', savedLocale);
    if (userInitialized !== null) store.set('linden_user_initialized', userInitialized);

    const elements = new Map();
    const registerEl = (selectorKey, el) => {
        if (!elements.has(selectorKey)) elements.set(selectorKey, []);
        elements.get(selectorKey).push(el);
        return el;
    };

    const makeEl = (attrs = {}) => {
        const classSet = new Set(attrs.classes || []);
        const attrMap = new Map(Object.entries(attrs.rawAttrs || {}));
        const queryMap = new Map(Object.entries(attrs.children || {}));
        return {
            textContent: attrs.textContent || '',
            innerHTML: attrs.innerHTML || '',
            dataset: { ...(attrs.dataset || {}) },
            classList: {
                toggle(cls, force) {
                    if (force === undefined) {
                        if (classSet.has(cls)) classSet.delete(cls);
                        else classSet.add(cls);
                    } else if (force) {
                        classSet.add(cls);
                    } else {
                        classSet.delete(cls);
                    }
                },
                contains(cls) {
                    return classSet.has(cls);
                }
            },
            querySelector(selector) {
                return queryMap.has(selector) ? queryMap.get(selector) : null;
            },
            getAttribute(name) {
                return attrMap.has(name) ? attrMap.get(name) : null;
            },
            setAttribute(name, value) {
                attrMap.set(name, String(value));
            }
        };
    };

    const mockRoot = {
        querySelectorAll(selector) {
            return elements.get(selector) || [];
        }
    };

    const listeners = new Map();
    const documentMock = {
        title: '',
        documentElement: {
            lang: '',
            dataset: {}
        },
        querySelectorAll(selector) {
            return mockRoot.querySelectorAll(selector);
        }
    };

    const windowMock = {
        addEventListener(type, cb) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(cb);
        },
        removeEventListener(type, cb) {
            if (!listeners.has(type)) return;
            listeners.set(type, listeners.get(type).filter((fn) => fn !== cb));
        }
    };

    globalThis.localStorage = {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(k, String(v)); },
        removeItem(k) { store.delete(k); },
        clear() { store.clear(); }
    };
    globalThis.document = documentMock;
    globalThis.window = windowMock;
    Object.defineProperty(globalThis, 'navigator', {
        value: { language: navLang, languages: [navLang] },
        configurable: true
    });

    return { store, registerEl, makeEl, mockRoot, documentMock };
}

await runTest('Dictionary sources contain no duplicate keys', () => {
    for (const [label, filePath] of [['js/i18n-zh.js', I18N_ZH_PATH], ['js/i18n-en.js', I18N_EN_PATH]]) {
        const keys = extractDictSourceKeys(filePath);
        const dups = [...keys.entries()]
            .filter(([, lines]) => lines.length > 1)
            .map(([k, lines]) => `${k} (lines ${lines.join(', ')})`);
        assert.deepEqual(dups, [], `Duplicate keys in ${label}: ${dups.join('; ')}`);
    }
});

await runTest('ZH_CN and EN have 1:1 key, type, non-empty value, and {param} placeholder parity', () => {
    const zhKeys = Object.keys(ZH_CN);
    const enKeys = Object.keys(EN);
    const zhSet = new Set(zhKeys);
    const enSet = new Set(enKeys);

    const missingInEn = zhKeys.filter((k) => !enSet.has(k));
    const missingInZh = enKeys.filter((k) => !zhSet.has(k));
    assert.deepEqual(missingInEn, [], `Keys in ZH_CN missing from EN: ${missingInEn.join(', ')}`);
    assert.deepEqual(missingInZh, [], `Keys in EN missing from ZH_CN: ${missingInZh.join(', ')}`);

    const mismatches = [];
    for (const key of zhKeys) {
        const zv = ZH_CN[key];
        const ev = EN[key];
        if (Array.isArray(zv) !== Array.isArray(ev)) {
            mismatches.push(`${key}: type mismatch (zh array=${Array.isArray(zv)}, en array=${Array.isArray(ev)})`);
            continue;
        }
        if (Array.isArray(zv)) {
            if (zv.length === 0) {
                mismatches.push(`${key}: empty array`);
                continue;
            }
            if (zv.length !== ev.length) {
                mismatches.push(`${key}: array length mismatch (zh=${zv.length}, en=${ev.length})`);
                continue;
            }
            for (let idx = 0; idx < zv.length; idx++) {
                if (typeof zv[idx] !== 'string' || typeof ev[idx] !== 'string' || !zv[idx].trim() || !ev[idx].trim()) {
                    mismatches.push(`${key}[${idx}]: non-string or empty array element`);
                    continue;
                }
                const zp = extractPlaceholders(zv[idx]);
                const ep = extractPlaceholders(ev[idx]);
                if (zp.join(',') !== ep.join(',')) {
                    mismatches.push(`${key}[${idx}]: placeholder mismatch zh=[${zp.join(',')}] vs en=[${ep.join(',')}]`);
                }
            }
        } else {
            if (typeof zv !== 'string' || typeof ev !== 'string' || !zv.trim() || !ev.trim()) {
                mismatches.push(`${key}: non-string or empty value`);
                continue;
            }
            const zp = extractPlaceholders(zv);
            const ep = extractPlaceholders(ev);
            if (zp.join(',') !== ep.join(',')) {
                mismatches.push(`${key}: placeholder mismatch zh=[${zp.join(',')}] vs en=[${ep.join(',')}]`);
            }
        }
    }
    assert.deepEqual(mismatches, [], `Locale parity errors:\n${mismatches.join('\n')}`);
});

await runTest('index.html data-i18n* keys exist in both locales and no unintended visible CJK leaks', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    const zhSet = new Set(Object.keys(ZH_CN));
    const enSet = new Set(Object.keys(EN));

    const attrRe = /\b(data-i18n(?:-html|-title|-placeholder|-aria-label|-aria|-alt)?)\s*=\s*(['"])([^'"]*)\2/g;
    const missingKeys = [];
    let match;
    while ((match = attrRe.exec(html)) !== null) {
        const [, attr, , key] = match;
        if (!key || !zhSet.has(key) || !enSet.has(key)) {
            const line = html.slice(0, match.index).split('\n').length;
            missingKeys.push(`L${line} ${attr}="${key}" (zh=${zhSet.has(key)}, en=${enSet.has(key)})`);
        }
    }
    assert.deepEqual(missingKeys, [], `Missing HTML i18n keys:\n${missingKeys.join('\n')}`);

    // Strip HTML comments, <script>, and <style> while preserving line counts
    const maskNewlines = (s) => s.replace(/[^\n]/g, ' ');
    const stripped = html
        .replace(/<!--[\s\S]*?-->/g, maskNewlines)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, maskNewlines)
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, maskNewlines);

    const tokenRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
    const voidTags = new Set([
        'meta', 'link', 'input', 'br', 'hr', 'img', 'path',
        'circle', 'line', 'rect', 'polyline', 'polygon', 'source'
    ]);
    const stack = [];
    let lineNo = 1;
    const wipedChildren = [];
    const uncontrolledCjk = [];
    const attrCjkMissingI18n = [];

    const readAttr = (attrs, name) => {
        const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
        return m ? (m[1] ?? m[2] ?? '') : null;
    };

    while ((match = tokenRe.exec(stripped)) !== null) {
        const chunk = match[0];
        if (match[1]) {
            const isClose = chunk.startsWith('</');
            const tag = match[1].toLowerCase();
            const attrs = match[2] || '';
            if (!isClose) {
                for (const ancestor of stack) {
                    if (ancestor.hasTextI18n && !ancestor.hasHtmlI18n) {
                        wipedChildren.push(`L${ancestor.line} <${ancestor.tag} data-i18n="${ancestor.textI18nKey}"> wraps L${lineNo} <${tag}>`);
                    }
                }
                for (const [attrName, i18nAttr] of [
                    ['title', 'data-i18n-title'],
                    ['placeholder', 'data-i18n-placeholder'],
                    ['aria-label', 'data-i18n-aria-label'],
                    ['alt', 'data-i18n-alt']
                ]) {
                    const val = readAttr(attrs, attrName);
                    if (val && /[\u4e00-\u9fff]/.test(val) && readAttr(attrs, i18nAttr) === null) {
                        attrCjkMissingI18n.push(`L${lineNo} <${tag}> ${attrName}="${val}" missing ${i18nAttr}`);
                    }
                }

                const selfClose = chunk.endsWith('/>') || voidTags.has(tag);
                if (!selfClose) {
                    const textI18nKey = readAttr(attrs, 'data-i18n');
                    const htmlI18nKey = readAttr(attrs, 'data-i18n-html');
                    const idAttr = readAttr(attrs, 'id');
                    const classAttr = readAttr(attrs, 'class') || '';
                    const langChip = readAttr(attrs, 'data-lang-chip');
                    const isIntentionalBilingualChip =
                        langChip === 'zh-CN' ||
                        /\blocale-choice-code\b/.test(classAttr);
                    stack.push({
                        tag,
                        line: lineNo,
                        idAttr,
                        hasTextI18n: textI18nKey !== null,
                        hasHtmlI18n: htmlI18nKey !== null,
                        textI18nKey,
                        isIntentionalBilingualChip
                    });
                }
            } else {
                for (let idx = stack.length - 1; idx >= 0; idx--) {
                    if (stack[idx].tag === tag) {
                        stack.length = idx;
                        break;
                    }
                }
            }
        } else if (match[3] && /[\u4e00-\u9fff]/.test(match[3])) {
            const top = stack[stack.length - 1];
            const inTitle = top && top.tag === 'title';
            const controlled = stack.some((s) => s.hasTextI18n || s.hasHtmlI18n || s.isIntentionalBilingualChip);
            if (!inTitle && !controlled) {
                uncontrolledCjk.push(`L${lineNo} <${top ? top.tag : 'root'}> "${match[3].trim()}"`);
            }
        }
        const nl = chunk.match(/\n/g);
        if (nl) lineNo += nl.length;
    }

    assert.deepEqual(wipedChildren, [], `data-i18n elements wrapping child HTML tags:\n${wipedChildren.join('\n')}`);
    assert.deepEqual(attrCjkMissingI18n, [], `HTML attributes with CJK missing data-i18n-*:\n${attrCjkMissingI18n.join('\n')}`);
    assert.deepEqual(uncontrolledCjk, [], `Uncontrolled visible CJK text in index.html:\n${uncontrolledCjk.join('\n')}`);
});

await runTest('All static t(...) and tList(...) string-literal keys across js/*.js exist in both locales', () => {
    const zhSet = new Set(Object.keys(ZH_CN));
    const enSet = new Set(Object.keys(EN));
    const jsFiles = fs.readdirSync(JS_DIR)
        .filter((f) => f.endsWith('.js') && f !== 'i18n-zh.js' && f !== 'i18n-en.js');

    const missingCalls = [];
    const typeMismatches = [];

    for (const file of jsFiles) {
        const raw = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
        const cleaned = stripJsComments(raw);
        // Direct calls t('key'...) / tList('key'...) plus single-line ternary t(cond ? 'k1' : 'k2'...)
        const directRe = /(?:^|[^\w.$])(t|tList)\(\s*(['"`])([a-zA-Z0-9_.-]+)\2\s*[,)]/g;
        let m;
        while ((m = directRe.exec(cleaned)) !== null) {
            const [, fn, , key] = m;
            const line = cleaned.slice(0, m.index).split('\n').length;
            if (!zhSet.has(key) || !enSet.has(key)) {
                missingCalls.push(`${file}:${line} ${fn}('${key}') [zh=${zhSet.has(key)}, en=${enSet.has(key)}]`);
            } else if (fn === 'tList' && (!Array.isArray(ZH_CN[key]) || !Array.isArray(EN[key]))) {
                typeMismatches.push(`${file}:${line} tList('${key}') target is not an Array`);
            } else if (fn === 't' && (Array.isArray(ZH_CN[key]) || Array.isArray(EN[key]))) {
                typeMismatches.push(`${file}:${line} t('${key}') target is an Array (expected tList)`);
            }
        }

        const ternaryRe = /(?:^|[^\w.$])(t|tList)\([^()\n]*?\?\s*(['"])([a-zA-Z0-9_.-]+)\2\s*:\s*(['"])([a-zA-Z0-9_.-]+)\4/g;
        while ((m = ternaryRe.exec(cleaned)) !== null) {
            const [, fn, , k1, , k2] = m;
            const line = cleaned.slice(0, m.index).split('\n').length;
            for (const key of [k1, k2]) {
                if (!zhSet.has(key) || !enSet.has(key)) {
                    missingCalls.push(`${file}:${line} ${fn}(? '${key}') [zh=${zhSet.has(key)}, en=${enSet.has(key)}]`);
                }
            }
        }
    }

    assert.deepEqual(missingCalls, [], `Missing JS i18n keys:\n${missingCalls.join('\n')}`);
    assert.deepEqual(typeMismatches, [], `JS i18n t/tList type mismatches:\n${typeMismatches.join('\n')}`);
});

await runTest('Runtime i18n.js gate detection, setLocale, interpolation, tList, applyI18n, and listeners', async () => {
    const { store, registerEl, makeEl, mockRoot, documentMock } = installI18nGlobals({
        savedLocale: null,
        userInitialized: null,
        navLang: 'en-US'
    });

    const i18n = await import(`../js/i18n.js?testRun=${Date.now()}`);

    // 1. Pre-onboarding locale gate rules
    assert.equal(i18n.shouldShowPreOnboardingLocaleGate(), true, 'Fresh install with no stored locale or init flag should show gate');
    store.set('linden_user_initialized', 'true');
    assert.equal(i18n.shouldShowPreOnboardingLocaleGate(), false, 'Existing initialized user should bypass pre-onboarding gate');
    store.delete('linden_user_initialized');
    store.set('linden_locale', 'zh-CN');
    assert.equal(i18n.shouldShowPreOnboardingLocaleGate(), false, 'Saved locale should bypass pre-onboarding gate');
    store.set('linden_locale', 'invalid-locale');
    assert.equal(i18n.shouldShowPreOnboardingLocaleGate(), true, 'Corrupt locale with no init flag should re-show gate');

    // 2. Normalization helpers
    assert.equal(i18n.normalizeLocale('en-GB'), 'en');
    assert.equal(i18n.normalizeLocale('zh-Hans'), 'zh-CN');
    assert.equal(i18n.normalizeLocale('fr'), null);

    // 3. Setup DOM mock nodes for applyI18n verification
    const textEl = registerEl('[data-i18n]', makeEl({ dataset: { i18n: 'common.cancel' } }));
    const htmlEl = registerEl('[data-i18n-html]', makeEl({ dataset: { i18nHtml: 'welcome.desc' } }));
    const titleEl = registerEl('[data-i18n-title]', makeEl({ dataset: { i18nTitle: 'nav.collapseSidebar' } }));
    const placeholderEl = registerEl('[data-i18n-placeholder]', makeEl({ dataset: { i18nPlaceholder: 'shelf.searchPlaceholder' } }));
    const ariaEl = registerEl('[data-i18n-aria-label]', makeEl({ dataset: { i18nAriaLabel: 'common.close' } }));
    const altEl = registerEl('[data-i18n-alt]', makeEl({ dataset: { i18nAlt: 'common.close' } }));
    const zhOptEl = registerEl('[data-locale-option]', makeEl({ dataset: { localeOption: 'zh-CN' } }));
    const enOptEl = registerEl('[data-locale-option]', makeEl({ dataset: { localeOption: 'en' } }));
    const zhChip = makeEl({ dataset: { langChip: 'zh-CN' } });
    const enChip = makeEl({ dataset: { langChip: 'en' } });
    const singleLabel = makeEl();
    const toggleBtn = registerEl('[data-locale-toggle]', makeEl({
        children: {
            '[data-lang-chip="zh-CN"]': zhChip,
            '[data-lang-chip="en"]': enChip,
            '[data-lang-toggle-label]': singleLabel
        }
    }));

    // 4. Listener + setLocale transitions
    const events = [];
    const unsubscribe = i18n.onLocaleChange((loc, meta) => events.push({ loc, prev: meta?.prev }));

    const appliedEn = i18n.setLocale('en', { persist: true, broadcast: false, applyDom: true });
    assert.equal(appliedEn, 'en');
    assert.equal(i18n.getLocale(), 'en');
    assert.equal(i18n.isEnglish(), true);
    assert.equal(i18n.getIntlLocale(), 'en-US');
    assert.equal(store.get('linden_locale'), 'en');
    assert.equal(documentMock.documentElement.lang, 'en');
    assert.equal(documentMock.documentElement.dataset.locale, 'en');
    assert.equal(documentMock.title, EN['app.windowTitle']);
    assert.equal(textEl.textContent, EN['common.cancel']);
    assert.equal(htmlEl.innerHTML, EN['welcome.desc']);
    assert.equal(titleEl.getAttribute('title'), EN['nav.collapseSidebar']);
    assert.equal(placeholderEl.getAttribute('placeholder'), EN['shelf.searchPlaceholder']);
    assert.equal(ariaEl.getAttribute('aria-label'), EN['common.close']);
    assert.equal(altEl.getAttribute('alt'), EN['common.close']);
    assert.equal(enOptEl.classList.contains('active'), true);
    assert.equal(enOptEl.getAttribute('aria-pressed'), 'true');
    assert.equal(zhOptEl.classList.contains('active'), false);
    assert.equal(zhOptEl.getAttribute('aria-pressed'), 'false');
    assert.equal(toggleBtn.getAttribute('title'), EN['common.switchToZh']);
    assert.equal(toggleBtn.getAttribute('aria-label'), EN['common.switchToZh']);
    assert.equal(toggleBtn.dataset.currentLocale, 'en');
    assert.equal(enChip.classList.contains('active'), true);
    assert.equal(zhChip.classList.contains('active'), false);
    assert.equal(singleLabel.textContent, '中文');

    // Zero-value and missing-key interpolation checks
    assert.equal(i18n.t('tour.stepCounter', { step: 0, total: 4 }), 'Step 0 of 4');
    assert.equal(i18n.t('nonexistent.sample.key'), 'nonexistent.sample.key');
    const enList = i18n.tList('greeting.morning.subtitles');
    assert.equal(Array.isArray(enList) && enList.length === EN['greeting.morning.subtitles'].length, true);
    assert.equal(enList[0], EN['greeting.morning.subtitles'][0]);

    // Switching back to zh-CN
    i18n.setLocale('zh-CN', { persist: true, broadcast: false, applyDom: true });
    assert.equal(i18n.getLocale(), 'zh-CN');
    assert.equal(i18n.isEnglish(), false);
    assert.equal(i18n.getIntlLocale(), 'zh-CN');
    assert.equal(textEl.textContent, ZH_CN['common.cancel']);
    assert.equal(toggleBtn.getAttribute('title'), ZH_CN['common.switchToEn']);
    assert.equal(zhChip.classList.contains('active'), true);
    assert.equal(enChip.classList.contains('active'), false);
    assert.equal(singleLabel.textContent, 'EN');

    // Listener receives previous locale metadata; unsubscribe must stop notifications
    const countBeforeSame = events.length;
    i18n.setLocale('zh-CN', { persist: false, broadcast: false, applyDom: false });
    assert.equal(events.length, countBeforeSame + 1);
    assert.equal(events[events.length - 1].prev, 'zh-CN');

    unsubscribe();
    i18n.setLocale('en', { persist: false, broadcast: false, applyDom: false });
    assert.equal(events.length, countBeforeSame + 1);

    // Explicit applyI18n(mockRoot, 'zh-CN') overrides DOM text using override locale
    i18n.applyI18n(mockRoot, 'zh-CN');
    assert.equal(textEl.textContent, ZH_CN['common.cancel']);
});

console.log(`i18n test suite finished: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exitCode = 1;
}
