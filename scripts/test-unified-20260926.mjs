// scripts/test-unified-20260926.mjs
// Verification suite for Reading Presets, Custom Fonts, Theme Customizer, and Rating Normalization.

import assert from 'node:assert/strict';

// Mock browser globals for node execution
globalThis.localStorage = {
    _data: new Map(),
    getItem(k) { return this._data.get(k) || null; },
    setItem(k, v) { this._data.set(k, String(v)); },
    removeItem(k) { this._data.delete(k); },
    clear() { this._data.clear(); }
};

import { ReadingPresetsManager, MAX_READING_PRESETS } from '../js/reading-presets.js';
import { customFontManager } from '../js/custom-font-manager.js';
import { themeCustomizer, DEFAULT_SEMANTIC_PALETTE } from '../js/theme-customizer.js';

console.log('=== Running Linden Leaf Unified Test Suite (2026-09-26) ===\n');

// 1. Reading Presets Tests
console.log('--- 1. Testing Reading Presets Manager ---');
{
    globalThis.localStorage.clear();
    const manager = new ReadingPresetsManager();
    assert.equal(manager.getPresets().length, 0, 'Initial presets should be empty');

    const baseSettings = {
        font: 'serif',
        fontSize: 18,
        fontWeight: 400,
        lineHeight: 1.6,
        letterSpacing: 0,
        margin: 48,
        maxWidth: 760,
        gap: 6,
        chineseQuotes: false,
        writingMode: 'horizontal',
        columnCount: '2',
        layoutMode: 'paginated',
        turnAnimationMode: 'none',
        theme: 'light'
    };

    // Create preset 1
    const res1 = manager.createPreset('小说日常', baseSettings);
    assert.ok(res1.success, 'Should successfully create preset 1');
    assert.equal(res1.preset.name, '小说日常');
    assert.equal(manager.getPresets().length, 1);
    assert.equal(manager.activePresetId, res1.preset.id);

    // Test modification detection
    assert.equal(manager.isCurrentModified(baseSettings), false, 'Base settings should not be modified');
    const modifiedSettings = { ...baseSettings, fontSize: 22 };
    assert.equal(manager.isCurrentModified(modifiedSettings), true, 'Modified fontSize should be detected');

    // Rename
    const renameRes = manager.renamePreset(res1.preset.id, '小说排版');
    assert.ok(renameRes.success, 'Rename should succeed');
    assert.equal(manager.getActivePreset().name, '小说排版');

    // Duplicate
    const dupRes = manager.duplicatePreset(res1.preset.id);
    assert.ok(dupRes.success, 'Duplicate should succeed');
    assert.equal(manager.getPresets().length, 2);
    assert.ok(dupRes.preset.name.includes('副本'));

    // Quota test: Fill up to MAX_READING_PRESETS (10)
    while (manager.getPresets().length < MAX_READING_PRESETS) {
        manager.createPreset(`预设 ${manager.getPresets().length + 1}`, baseSettings);
    }
    assert.equal(manager.getPresets().length, 10, 'Should have exactly 10 presets');

    // Attempt to exceed quota
    const overflowRes = manager.createPreset('第11个预设', baseSettings);
    assert.equal(overflowRes.success, false, 'Creating 11th preset must fail');
    assert.ok(overflowRes.quotaExceeded, 'Should report quotaExceeded');
    assert.equal(manager.getPresets().length, 10, 'Preset count must remain capped at 10');

    // Update existing preset
    const updateRes = manager.updatePreset(res1.preset.id, modifiedSettings, '小说大字版');
    assert.ok(updateRes.success, 'Update preset should succeed');
    assert.equal(manager.getActivePreset().settings.fontSize, 22);
    assert.equal(manager.getActivePreset().name, '小说大字版');

    // Delete preset
    const delRes = manager.deletePreset(dupRes.preset.id);
    assert.ok(delRes.success, 'Delete should succeed');
    assert.equal(manager.getPresets().length, 9, 'Count should be 9 after delete');

    // Batch apply
    const applied = manager.applyPreset(res1.preset.id);
    assert.ok(applied != null, 'Apply should return settings object');
    assert.equal(applied.fontSize, 22);

    console.log('✓ Reading Presets Manager tests passed.');
}

// 2. Custom Font Magic Bytes Sniffing Tests
console.log('\n--- 2. Testing Custom Font Format Sniffer ---');
{
    // TTF (0x00010000)
    const ttfBuf = new ArrayBuffer(16);
    new DataView(ttfBuf).setUint32(0, 0x00010000, false);
    assert.equal(customFontManager.sniffFontFormat(ttfBuf), 'truetype', '0x00010000 must be TrueType');

    // TTF ('true' -> 0x74727565)
    const ttfTrueBuf = new ArrayBuffer(16);
    new DataView(ttfTrueBuf).setUint32(0, 0x74727565, false);
    assert.equal(customFontManager.sniffFontFormat(ttfTrueBuf), 'truetype', '"true" must be TrueType');

    // OTF ('OTTO' -> 0x4F54544F)
    const otfBuf = new ArrayBuffer(16);
    new DataView(otfBuf).setUint32(0, 0x4F54544F, false);
    assert.equal(customFontManager.sniffFontFormat(otfBuf), 'opentype', '"OTTO" must be OpenType');

    // WOFF ('wOFF' -> 0x774F4646)
    const woffBuf = new ArrayBuffer(16);
    new DataView(woffBuf).setUint32(0, 0x774F4646, false);
    assert.equal(customFontManager.sniffFontFormat(woffBuf), 'woff', '"wOFF" must be WOFF');

    // WOFF2 ('wOF2' -> 0x774F4632)
    const woff2Buf = new ArrayBuffer(16);
    new DataView(woff2Buf).setUint32(0, 0x774F4632, false);
    assert.equal(customFontManager.sniffFontFormat(woff2Buf), 'woff2', '"wOF2" must be WOFF2');

    // Invalid file (e.g. PDF magic "%PDF" -> 0x25504446)
    const pdfBuf = new ArrayBuffer(16);
    new DataView(pdfBuf).setUint32(0, 0x25504446, false);
    assert.equal(customFontManager.sniffFontFormat(pdfBuf), null, 'Non-font file must return null');

    // Short buffer (< 4 bytes)
    const shortBuf = new ArrayBuffer(2);
    assert.equal(customFontManager.sniffFontFormat(shortBuf), null, 'Short buffer must return null');

    console.log('✓ Custom Font Format Sniffer tests passed.');
}

// 3. Theme Customizer Color Validation & Token Generation Tests
console.log('\n--- 3. Testing Theme Customizer & Security Validation ---');
{
    // Valid colors
    assert.ok(themeCustomizer.isValidColor('#fff'), '#fff is valid');
    assert.ok(themeCustomizer.isValidColor('#1a1815'), '#1a1815 is valid');
    assert.ok(themeCustomizer.isValidColor('#1a1815ff'), '#1a1815ff is valid');
    assert.ok(themeCustomizer.isValidColor('rgb(255, 255, 255)'), 'rgb is valid');
    assert.ok(themeCustomizer.isValidColor('rgba(217, 119, 6, 0.22)'), 'rgba is valid');

    // Malicious injection payloads must be strictly rejected
    assert.equal(themeCustomizer.isValidColor('red; background: url(javascript:alert(1))'), false, 'CSS injection rejected');
    assert.equal(themeCustomizer.isValidColor('<script>alert(1)</script>'), false, 'HTML injection rejected');
    assert.equal(themeCustomizer.isValidColor('expression(alert(1))'), false, 'expression rejected');
    assert.equal(themeCustomizer.isValidColor(''), false, 'empty string rejected');
    assert.equal(themeCustomizer.isValidColor(null), false, 'null rejected');

    // Token Generation
    const rules = themeCustomizer.buildStyleRules(DEFAULT_SEMANTIC_PALETTE);
    assert.ok(rules.includes('--bg-primary: #ffffff !important;'), 'Contains bg-primary override');
    assert.ok(rules.includes('--accent: #d97706 !important;'), 'Contains accent override');

    console.log('✓ Theme Customizer Security Validation tests passed.');
}

// 4. Rating Normalization Logic Test
console.log('\n--- 4. Testing Rating Filter 0.5 Step Normalization ---');
{
    function normalizeRatingFilter(filterVal) {
        if (filterVal === 'all' || filterVal === 'unrated') {
            return filterVal;
        }
        const num = parseFloat(filterVal);
        if (isNaN(num) || num <= 0) {
            return 'all';
        }
        const stepped = Math.round(num * 2) / 2;
        const clamped = Math.max(0.5, Math.min(5.0, stepped));
        return String(clamped);
    }

    assert.equal(normalizeRatingFilter('all'), 'all');
    assert.equal(normalizeRatingFilter('unrated'), 'unrated');
    assert.equal(normalizeRatingFilter(0), 'all', 'Rating 0 means ALL');
    assert.equal(normalizeRatingFilter('0'), 'all');
    assert.equal(normalizeRatingFilter('4.2'), '4', '4.2 rounds to 4.0');
    assert.equal(normalizeRatingFilter('4.3'), '4.5', '4.3 rounds to 4.5');
    assert.equal(normalizeRatingFilter('4.7'), '4.5', '4.7 rounds to 4.5');
    assert.equal(normalizeRatingFilter('4.8'), '5', '4.8 rounds to 5.0');
    assert.equal(normalizeRatingFilter('0.2'), '0.5', 'Clamped to min 0.5');
    assert.equal(normalizeRatingFilter('5.5'), '5', 'Clamped to max 5.0');

    console.log('✓ Rating Filter 0.5 Step Normalization tests passed.');
}

console.log('\n=== All Unit Tests Successfully Passed! ===');
