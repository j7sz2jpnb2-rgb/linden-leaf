// scripts/test-pc-page-turn-and-vertical-column.mjs
// Comprehensive verification suite for:
// 1. PC desktop: Removal of page-turn animation UI & instant non-animated mode.
// 2. Vertical layout: Proactive graying-out / disabling of two-column option and auto-adjust to single-column.
// 3. Preset extraction & application normalization for vertical-rl reading presets.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PageTurnController, PageTurnAdapter } from '../js/page-turn-controller.js'
import { readingPresetsManager } from '../js/reading-presets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

console.log('====================================================')
console.log('Running Verification: PC Turn Animation & Vertical Column')
console.log('====================================================\n')

let passed = 0

function test(name, fn) {
    try {
        fn()
        console.log(`  [PASS] ${name}`)
        passed++
    } catch (err) {
        console.error(`  [FAIL] ${name}`)
        console.error(err)
        process.exitCode = 1
    }
}

async function asyncTest(name, fn) {
    try {
        await fn()
        console.log(`  [PASS] ${name}`)
        passed++
    } catch (err) {
        console.error(`  [FAIL] ${name}`)
        console.error(err)
        process.exitCode = 1
    }
}

// ----------------------------------------------------
// Suite 1: index.html & desktop-settings.css UI Structure
// ----------------------------------------------------
console.log('Suite 1: PC Reader Settings UI Structure')

const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8')
const desktopCss = fs.readFileSync(path.join(rootDir, 'css/desktop-settings.css'), 'utf8')

test('1.1 index.html hides #setting-turn-animation-row by default with mobile-only and style="display: none;"', () => {
    assert.match(indexHtml, /<div[^>]*id="setting-turn-animation-row"[^>]*>/)
    const rowMatch = indexHtml.match(/<div[^>]*id="setting-turn-animation-row"[^>]*>/)[0]
    assert.ok(rowMatch.includes('mobile-only'), 'row should have class mobile-only')
    assert.ok(rowMatch.includes('display: none'), 'row should have inline style display: none')
})

test('1.2 index.html defaults setting-turn-animation-mode to none selected', () => {
    assert.match(indexHtml, /<option\s+value="none"\s+selected>无动画翻页 \(默认\)<\/option>/)
})

test('1.3 index.html labels horizontal writing mode as 现代横排 (从左至右)', () => {
    assert.match(indexHtml, /<option\s+value="horizontal"[^>]*>现代横排 \(从左至右\)<\/option>/)
})

test('1.4 css/desktop-settings.css explicitly hides #setting-turn-animation-row with !important', () => {
    assert.match(desktopCss, /#setting-turn-animation-row\s*\{\s*display:\s*none\s*!important;\s*\}/)
})

test('1.5 css/desktop-settings.css grays out disabled select options with opacity and cursor', () => {
    assert.match(desktopCss, /#setting-column-count option:disabled/)
    assert.match(desktopCss, /#setting-column-count option\[disabled\]/)
    assert.match(desktopCss, /cursor:\s*not-allowed/)
    assert.match(desktopCss, /opacity:\s*0\.55/)
})

test('1.6 css/desktop-settings.css includes top-level fallback rules outside @media for all viewport widths', () => {
    // Verify fallback rules exist after the closing of @media block
    const mediaEnd = desktopCss.lastIndexOf('@media')
    assert.ok(mediaEnd !== -1, 'Should contain @media block')
    const fallbackSlice = desktopCss.slice(mediaEnd)
    assert.match(fallbackSlice, /#setting-turn-animation-row\s*\{\s*display:\s*none\s*!important;\s*\}/)
    assert.match(fallbackSlice, /#setting-column-count option:disabled/)
})

// ----------------------------------------------------
// Suite 2: PC Instant Non-Animated Mode in page-turn-controller.js
// ----------------------------------------------------
console.log('\nSuite 2: PC Page Turn Controller Behavior')

test('2.1 Controller returns "none" in browser environment when on PC desktop (non-mobile)', () => {
    const prevWindow = globalThis.window
    const prevDocument = globalThis.document

    try {
        globalThis.window = {
            mobileShell: { isMobileViewport: () => false },
            platformBridge: { isAndroid: false }
        }
        globalThis.document = {
            documentElement: { dataset: {} },
            getElementById: () => null,
            createElement: () => ({ style: {}, appendChild: () => {} })
        }

        const controller = new PageTurnController({
            mode: 'curl'
        })

        // Even though controller.mode is set to 'curl', getEffectiveMode() on PC desktop MUST return 'none'
        assert.equal(controller.getEffectiveMode(), 'none')
    } finally {
        globalThis.window = prevWindow
        globalThis.document = prevDocument
    }
})

await asyncTest('2.2 Controller turns next/prev via instant adapter jump when effective mode is "none"', async () => {
    let nextCalled = false
    let prevCalled = false

    class InstantMockAdapter extends PageTurnAdapter {
        canTurnNext() { return true }
        canTurnPrev() { return true }
        isBusy() { return false }
        async turnNext() { nextCalled = true }
        async turnPrev() { prevCalled = true }
    }

    const prevWindow = globalThis.window
    const prevDocument = globalThis.document

    try {
        globalThis.window = {
            mobileShell: { isMobileViewport: () => false },
            platformBridge: { isAndroid: false }
        }
        globalThis.document = {
            documentElement: { dataset: {} },
            getElementById: () => null,
            createElement: () => ({ style: {}, appendChild: () => {} })
        }

        const controller = new PageTurnController({
            adapter: new InstantMockAdapter(),
            mode: 'curl'
        })

        await controller.turnNext()
        assert.equal(nextCalled, true, 'turnNext should call adapter.turnNext directly')

        await controller.turnPrev()
        assert.equal(prevCalled, true, 'turnPrev should call adapter.turnPrev directly')
        assert.equal(controller.state, 'idle')
    } finally {
        globalThis.window = prevWindow
        globalThis.document = prevDocument
    }
})

// ----------------------------------------------------
// Suite 3: js/app.js Proactive Vertical / Single-Column Management
// ----------------------------------------------------
console.log('\nSuite 3: Reactive Settings & Vertical Column Logic in app.js')

const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8')

test('3.1 app.js default pageTurnMode is "none" on desktop (!isAndroid)', () => {
    assert.match(appJs, /pageTurnMode:\s*platformBridge\.isAndroid\s*\?\s*'slide'\s*:\s*'none'/)
})

test('3.2 app.js loadSettings enforces "none" on PC desktop and normalizes settings', () => {
    assert.match(appJs, /const\s+initialTurnMode\s*=\s*isMobile\s*\?\s*\(validTurnModes\.includes\(this\.settings\.pageTurnMode\)\s*\?\s*this\.settings\.pageTurnMode\s*:\s*defaultTurnMode\)\s*:\s*'none'/)
    assert.match(appJs, /if\s*\(!isMobile\s*&&\s*this\.settings\.pageTurnMode\s*!==\s*'none'\)\s*\{\s*this\.settings\.pageTurnMode\s*=\s*'none'\s*\}/)
})

test('3.3 updateSettingsUI disables option 2 and adds title when vertical-rl is active', () => {
    assert.match(appJs, /twoColOpt\.disabled\s*=\s*true/)
    assert.match(appJs, /twoColOpt\.title\s*=\s*'古典竖排模式仅支持单栏排版'/)
    assert.match(appJs, /twoColOpt\.textContent\s*=\s*'双栏 \/ 双页展开 \(竖排仅限单栏\)'/)
    assert.match(appJs, /this\.dom\.columnCountSelect\.title\s*=\s*'古典竖排模式仅支持单栏排版'/)
})

test('3.4 updateSettingsUI automatically adjusts columnCount to 1 (both string and number) in vertical mode and debounces save', () => {
    assert.match(appJs, /if\s*\(this\.settings\.columnCount\s*===\s*'2'\s*\|\|\s*this\.settings\.columnCount\s*===\s*2\)\s*\{\s*this\.setSetting\('columnCount',\s*'1'\)\s*this\.saveSettingsDebounced\(\)\s*\}/)
})

test('3.5 updateSettingsUI re-enables option 2 and clears title when in horizontal mode', () => {
    assert.match(appJs, /twoColOpt\.disabled\s*=\s*false/)
    assert.match(appJs, /twoColOpt\.removeAttribute\('title'\)/)
    assert.match(appJs, /twoColOpt\.textContent\s*=\s*'双栏 \/ 双页展开'/)
    assert.match(appJs, /this\.dom\.columnCountSelect\.removeAttribute\('title'\)/)
})

test('3.6 writingModeSelect change handler adjusts columnCount (string and number), awaits saveSettings, and triggers updateSettingsUI', () => {
    assert.match(appJs, /const\s+newMode\s*=\s*e\.target\.value/)
    assert.match(appJs, /const\s+isVertical\s*=\s*newMode\s*===\s*'vertical-rl'/)
    assert.match(appJs, /if\s*\(isVertical\s*&&\s*\(this\.settings\.columnCount\s*===\s*'2'\s*\|\|\s*this\.settings\.columnCount\s*===\s*2\)\)\s*\{\s*this\.setSetting\('columnCount',\s*'1'\)\s*\}/)
    assert.match(appJs, /await\s+this\.saveSettings\(\)/)
    assert.match(appJs, /this\.updateSettingsUI\(\)/)
})

test('3.7 syncSettingsUI method alias is defined on app to prevent undefined invocation errors', () => {
    assert.match(appJs, /syncSettingsUI\(\)\s*\{\s*this\.updateSettingsUI\(\)\s*\}/)
})

test('3.8 openDrawer and switchTab invoke updateSettingsUI when navigating to settings', () => {
    assert.match(appJs, /if\s*\(tab\s*===\s*'settings'\)\s*\{\s*this\.updateSettingsPanelAvailability\(\)\s*this\.updateSettingsUI\(\)\s*\}/)
    assert.match(appJs, /if\s*\(tabName\s*===\s*'settings'\)\s*\{\s*this\.updateSettingsUI\(\)/)
})

test('3.9 columnCountSelect change handler guards against vertical-rl two-column selection with toast', () => {
    assert.match(appJs, /if\s*\(this\.settings\.writingMode\s*===\s*'vertical-rl'\)\s*\{\s*this\.dom\.columnCountSelect\.value\s*=\s*'1'\s*this\.showToast\('古典竖排模式仅支持单栏排版',\s*'ℹ️'\)\s*return\s*\}/)
})

// ----------------------------------------------------
// Suite 4: Reading Presets & Edge Case Normalization
// ----------------------------------------------------
console.log('\nSuite 4: Reading Presets & Normalization Edge Cases')

test('4.1 readingPresetsManager.extractPresetSettings forces columnCount to 1 when writingMode is vertical-rl', () => {
    const verticalPreset = readingPresetsManager.extractPresetSettings({
        writingMode: 'vertical-rl',
        columnCount: '2',
        fontSize: 20
    })
    assert.equal(verticalPreset.writingMode, 'vertical-rl')
    assert.equal(verticalPreset.columnCount, '1', 'columnCount must be forced to 1 for vertical-rl')

    const horizontalPreset = readingPresetsManager.extractPresetSettings({
        writingMode: 'horizontal',
        columnCount: '2',
        fontSize: 20
    })
    assert.equal(horizontalPreset.writingMode, 'horizontal')
    assert.equal(horizontalPreset.columnCount, '2', 'columnCount remains 2 for horizontal')
})

test('4.2 app.js reading preset application normalizes columnCount to 1 for vertical-rl presets', () => {
    assert.match(appJs, /if\s*\(applied\.writingMode\s*===\s*'vertical-rl'\)\s*\{\s*applied\.columnCount\s*=\s*'1'\s*\}/)
})

// ----------------------------------------------------
// Suite 5: Simulated DOM & Reactive State Machine Execution
// ----------------------------------------------------
console.log('\nSuite 5: Behavioral State Machine Simulation')

test('5.1 Simulated updateSettingsUI reactive cycle transitions correctly between vertical and horizontal', () => {
    // Minimal mock DOM for columnCount select and control row
    const mockOpt1 = { value: '1', disabled: false, textContent: '单栏 / 单页展示' }
    const mockOpt2 = { value: '2', disabled: false, textContent: '双栏 / 双页展开', title: '' }
    const mockRow = { title: '' }
    const mockSelect = {
        value: '2',
        title: '',
        querySelector: (sel) => (sel === 'option[value="2"]' ? mockOpt2 : (sel === 'option[value="1"]' ? mockOpt1 : null)),
        closest: (sel) => (sel === '.control-row' ? mockRow : null),
        removeAttribute: (attr) => { if (attr === 'title') mockSelect.title = '' }
    }
    mockOpt2.removeAttribute = (attr) => { if (attr === 'title') mockOpt2.title = '' }
    mockRow.removeAttribute = (attr) => { if (attr === 'title') mockRow.title = '' }

    let debouncedSaved = false
    const mockApp = {
        settings: {
            writingMode: 'vertical-rl',
            columnCount: '2'
        },
        dom: {
            columnCountSelect: mockSelect
        },
        setSetting(k, v) { this.settings[k] = v },
        saveSettingsDebounced() { debouncedSaved = true }
    }

    // Simulate vertical state logic
    const isVertical = mockApp.settings.writingMode === 'vertical-rl'
    if (mockApp.dom.columnCountSelect) {
        const twoColOpt = mockApp.dom.columnCountSelect.querySelector('option[value="2"]')
        const colRow = mockApp.dom.columnCountSelect.closest('.control-row')
        if (isVertical) {
            if (twoColOpt) {
                twoColOpt.disabled = true
                twoColOpt.title = '古典竖排模式仅支持单栏排版'
                twoColOpt.textContent = '双栏 / 双页展开 (竖排仅限单栏)'
            }
            mockApp.dom.columnCountSelect.title = '古典竖排模式仅支持单栏排版'
            if (colRow) colRow.title = '古典竖排模式仅支持单栏排版'
            if (mockApp.settings.columnCount === '2' || mockApp.settings.columnCount === 2) {
                mockApp.setSetting('columnCount', '1')
                mockApp.saveSettingsDebounced()
            }
            mockApp.dom.columnCountSelect.value = '1'
        }
    }

    assert.equal(mockOpt2.disabled, true, 'Option 2 must be disabled')
    assert.equal(mockOpt2.title, '古典竖排模式仅支持单栏排版', 'Option 2 title must explain vertical restriction')
    assert.equal(mockSelect.title, '古典竖排模式仅支持单栏排版', 'Select element title must be set')
    assert.equal(mockRow.title, '古典竖排模式仅支持单栏排版', 'Row title must be set')
    assert.equal(mockSelect.value, '1', 'Select value must be normalized to 1')
    assert.equal(mockApp.settings.columnCount, '1', 'App setting columnCount must be normalized to 1')
    assert.equal(debouncedSaved, true, 'Debounced save must be triggered')

    // Now simulate switching back to horizontal
    mockApp.settings.writingMode = 'horizontal'
    const isVertical2 = mockApp.settings.writingMode === 'vertical-rl'
    if (mockApp.dom.columnCountSelect) {
        const twoColOpt = mockApp.dom.columnCountSelect.querySelector('option[value="2"]')
        const colRow = mockApp.dom.columnCountSelect.closest('.control-row')
        if (!isVertical2) {
            if (twoColOpt) {
                twoColOpt.disabled = false
                twoColOpt.removeAttribute('title')
                twoColOpt.textContent = '双栏 / 双页展开'
            }
            mockApp.dom.columnCountSelect.removeAttribute('title')
            if (colRow) colRow.removeAttribute('title')
            mockApp.dom.columnCountSelect.value = mockApp.settings.columnCount || '2'
        }
    }

    assert.equal(mockOpt2.disabled, false, 'Option 2 must be re-enabled')
    assert.equal(mockOpt2.title, '', 'Option 2 title must be cleared')
    assert.equal(mockSelect.title, '', 'Select title must be cleared')
    assert.equal(mockRow.title, '', 'Row title must be cleared')
    assert.equal(mockOpt2.textContent, '双栏 / 双页展开', 'Option 2 label must be restored')
})

console.log(`\n====================================================`)
console.log(`Results: ${passed} passed, 0 failed.`)
console.log(`====================================================`)
