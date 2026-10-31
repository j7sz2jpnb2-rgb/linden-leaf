// scripts/verify-ai-cooldown-display.mjs
// Verification suite for AI Cooldown Number Input display and layout repairs.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const rootDir = 'D:/LindenLeaf-Dev/astra-mupdf-core';
console.log('====================================================');
console.log('Running Verification: AI Cooldown Display & Layout');
console.log('====================================================\n');

// --- Suite 1: Source Code Checks ---
console.log('Suite 1: Source Code Verification');

const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const desktopCss = fs.readFileSync(path.join(rootDir, 'css/desktop-settings.css'), 'utf8');
const advSettingsJs = fs.readFileSync(path.join(rootDir, 'js/advanced-settings.js'), 'utf8');

// 1.1 Check index.html
assert.ok(
    indexHtml.includes('id="setting-ai-cooldown"') && indexHtml.includes('style="min-width: 60px;"'),
    'index.html should have min-width: 60px on #setting-ai-cooldown'
);
console.log('  [PASS] 1.1 index.html contains min-width on #setting-ai-cooldown');

assert.ok(
    indexHtml.includes('white-space: nowrap; flex-shrink: 0;') && indexHtml.includes('>秒</span>'),
    'index.html should prevent wrap and shrink on the "秒" unit label'
);
console.log('  [PASS] 1.2 index.html prevents unit label wrapping');

// 1.2 Check css/desktop-settings.css
assert.ok(
    desktopCss.includes('#panel-settings .settings-row-pair > div:last-child { display: flex; width: var(--settings-control-width);'),
    'desktop-settings.css should set width: var(--settings-control-width) on settings-row-pair > div:last-child'
);
assert.ok(
    desktopCss.includes('#panel-settings .settings-row-pair > div:last-child input:not([type="color"])'),
    'desktop-settings.css should apply flex: 1 and min-width to non-color inputs'
);
assert.ok(
    desktopCss.includes('#panel-settings .settings-row-pair > div:last-child input[type="color"]'),
    'desktop-settings.css should protect color inputs from unintended flex growth'
);
console.log('  [PASS] 1.3 css/desktop-settings.css allocates control column width and input min-width');

// 1.3 Check js/advanced-settings.js
assert.ok(
    advSettingsJs.includes("document.getElementById('setting-ai-cooldown')?.addEventListener('input'"),
    'advanced-settings.js should listen to input events for real-time tip updates'
);
assert.ok(
    advSettingsJs.includes("document.getElementById('setting-ai-cooldown')?.addEventListener('change'"),
    'advanced-settings.js should listen to change events for saving settings'
);
console.log('  [PASS] 1.4 js/advanced-settings.js handles both input and change events');

// --- Suite 2: dist-tauri Synchronization ---
console.log('\nSuite 2: dist-tauri Synchronization');

const distIndexHtml = fs.readFileSync(path.join(rootDir, 'dist-tauri/index.html'), 'utf8');
const distDesktopCss = fs.readFileSync(path.join(rootDir, 'dist-tauri/css/desktop-settings.css'), 'utf8');
const distAdvJs = fs.readFileSync(path.join(rootDir, 'dist-tauri/js/advanced-settings.js'), 'utf8');
const buildInfo = JSON.parse(fs.readFileSync(path.join(rootDir, 'dist-tauri/build-info.json'), 'utf8'));

assert.ok(distIndexHtml.includes('style="min-width: 60px;"'), 'dist-tauri/index.html must be in sync');
assert.ok(distDesktopCss.includes('width: var(--settings-control-width);'), 'dist-tauri/css/desktop-settings.css must be in sync');
assert.ok(distAdvJs.includes("addEventListener('input'"), 'dist-tauri/js/advanced-settings.js must be in sync');
assert.ok(buildInfo.resourceHash, 'dist-tauri build-info.json must contain valid resourceHash');
console.log(`  [PASS] 2.1 dist-tauri is synchronized (buildId=${buildInfo.buildId}, hash=${buildInfo.resourceHash.slice(0, 10)})`);

// --- Suite 3: Headless Edge Layout & Geometry Verification ---
console.log('\nSuite 3: Live Headless Edge CDP Geometry Verification on dist-tauri');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9555;

async function runEdgeVerification() {
    const edge = spawn(edgePath, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--allow-file-access-from-files',
        '--user-data-dir=C:\\Users\\YONGHU\\AppData\\Local\\Temp\\edge-test-profile-cd',
        'file:///D:/LindenLeaf-Dev/astra-mupdf-core/dist-tauri/index.html'
    ], { stdio: 'ignore' });

    try {
        let wsEndpoint = null;
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 300));
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json`);
                const list = await res.json();
                const target = list.find(t => t.type === 'page');
                if (target?.webSocketDebuggerUrl) {
                    wsEndpoint = target.webSocketDebuggerUrl;
                    break;
                }
            } catch {}
        }
        if (!wsEndpoint) throw new Error('Could not connect to Edge CDP endpoint');

        const ws = new WebSocket(wsEndpoint);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        let id = 1;
        function send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const curId = id++;
                const handler = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.id === curId) {
                        ws.removeEventListener('message', handler);
                        if (data.error) reject(data.error);
                        else resolve(data.result);
                    }
                };
                ws.addEventListener('message', handler);
                ws.send(JSON.stringify({ id: curId, method, params }));
            });
        }

        await send('Runtime.enable');
        await send('Page.enable');
        await send('Console.enable');

        ws.addEventListener('message', (event) => {
            const data = JSON.parse(event.data);
            if (data.method === 'Console.messageAdded') {
                console.log('[Edge Console]', data.params.message.text);
            }
        });

        for (let i = 0; i < 50; i++) {
            const check = await send('Runtime.evaluate', {
                expression: 'Boolean(window.app && window.app.advancedSettings)',
                returnByValue: true
            });
            if (check.result?.value) break;
            await new Promise(r => setTimeout(r, 200));
        }

        await send('Emulation.setDeviceMetricsOverride', {
            width: 1200,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false
        });

        const evalRes = await send('Runtime.evaluate', {
            expression: `
                (() => {
                    const drawer = document.getElementById('sidebar-drawer');
                    drawer.style.setProperty('display', 'block', 'important');
                    drawer.style.setProperty('transform', 'none', 'important');
                    drawer.style.setProperty('position', 'absolute', 'important');
                    drawer.style.setProperty('left', '0', 'important');
                    drawer.style.setProperty('top', '0', 'important');
                    drawer.style.setProperty('width', '420px', 'important');
                    drawer.style.setProperty('height', '900px', 'important');
                    drawer.classList.add('open');

                    const panel = document.getElementById('panel-settings');
                    panel.style.setProperty('display', 'block', 'important');
                    panel.classList.add('active');

                    const advContainer = document.getElementById('advanced-settings-container');
                    advContainer.style.setProperty('display', 'flex', 'important');

                    const cdInput = document.getElementById('setting-ai-cooldown');
                    const maxTokensInput = document.getElementById('setting-ai-max-tokens');
                    const dailyLimitInput = document.getElementById('setting-ai-daily-limit');
                    const cdWrapper = cdInput.parentElement;
                    const unitSpan = cdWrapper.querySelector('span');

                    const cdRect = cdInput.getBoundingClientRect();
                    const wrapRect = cdWrapper.getBoundingClientRect();
                    const tokensRect = maxTokensInput.getBoundingClientRect();
                    const dailyRect = dailyLimitInput.getBoundingClientRect();
                    const spanRect = unitSpan.getBoundingClientRect();

                    const colorInput = document.getElementById('palette-bg-primary');
                    const colorRect = colorInput.getBoundingClientRect();

                    // Test value = 0 interaction
                    cdInput.value = '0';
                    cdInput.dispatchEvent(new Event('input', { bubbles: true }));
                    const tip = document.getElementById('tip-ai-cooldown-warning');
                    const tipVisibleOnInput = tip && window.getComputedStyle(tip).display !== 'none';

                    return {
                        cooldownInputWidth: cdRect.width,
                        cooldownInputHeight: cdRect.height,
                        cooldownInputLeft: cdRect.left,
                        wrapperWidth: wrapRect.width,
                        wrapperLeft: wrapRect.left,
                        wrapperRight: wrapRect.right,
                        maxTokensLeft: tokensRect.left,
                        maxTokensRight: tokensRect.right,
                        dailyLimitLeft: dailyRect.left,
                        dailyLimitRight: dailyRect.right,
                        spanLeft: spanRect.left,
                        spanRight: spanRect.right,
                        colorWidth: colorRect.width,
                        tipVisibleOnInput
                    };
                })()
            `,
            returnByValue: true
        });

        const m = evalRes.result?.value;
        assert.ok(m, 'Measurement results must be valid');

        // 3.1 Input width is wide enough (not 20px)
        assert.ok(m.cooldownInputWidth >= 120, `cooldownInputWidth should be >= 120px, got ${m.cooldownInputWidth}`);
        console.log(`  [PASS] 3.1 setting-ai-cooldown width is ${m.cooldownInputWidth}px (expanded from 20px)`);

        // 3.2 Alignments
        assert.strictEqual(Math.round(m.wrapperLeft), Math.round(m.maxTokensLeft), 'Control wrapper left aligns with max-tokens input');
        assert.strictEqual(Math.round(m.wrapperRight), Math.round(m.maxTokensRight), 'Control wrapper right aligns with max-tokens input');
        assert.strictEqual(Math.round(m.cooldownInputLeft), Math.round(m.maxTokensLeft), 'Cooldown input left aligns with max-tokens input');
        assert.strictEqual(Math.round(m.wrapperRight), Math.round(m.dailyLimitRight), 'Control wrapper right aligns with daily-limit input');
        console.log('  [PASS] 3.2 Cooldown input and wrapper align with neighboring settings inputs');

        // 3.3 Color picker swatch remains un-distorted
        assert.ok(m.colorWidth >= 20 && m.colorWidth <= 35, `Color input width should be ~24-30px, got ${m.colorWidth}`);
        console.log(`  [PASS] 3.3 Color input width is preserved at ${m.colorWidth}px`);

        // 3.4 Dynamic input tip toggle
        assert.ok(m.tipVisibleOnInput, 'Warning tip is displayed immediately when cooldown is 0 on input event');
        console.log('  [PASS] 3.4 Warning tip reacts dynamically to cooldown 0 value');

        ws.close();
    } finally {
        edge.kill();
    }
}

await runEdgeVerification();

console.log('\n====================================================');
console.log('ALL AI COOLDOWN DISPLAY CHECKS PASSED SUCCESSFULLY!');
console.log('====================================================');
