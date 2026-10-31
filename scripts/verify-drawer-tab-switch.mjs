import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const rootDir = 'D:/LindenLeaf-Dev/astra-mupdf-core';
console.log('====================================================');
console.log('Running Verification: Drawer Tab Switching & Markdown Exports');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failCount++;
  }
}

// Suite 1: Source Code Checks
console.log('Suite 1: Source Code Structure Checks');
const cssDesktop = fs.readFileSync(path.join(rootDir, 'css/desktop-settings.css'), 'utf8');
const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
const bridgeJs = fs.readFileSync(path.join(rootDir, 'js/platformBridge.js'), 'utf8');
const dialogRs = fs.readFileSync(path.join(rootDir, 'src-tauri/src/commands/dialog.rs'), 'utf8');
const libRs = fs.readFileSync(path.join(rootDir, 'src-tauri/src/lib.rs'), 'utf8');

test('1.1 desktop-settings.css enforces display: none on #panel-settings when hidden', () => {
  assert(cssDesktop.includes('#panel-settings[style*="display: none"]'), 'Must include attribute selector for display: none');
  assert(!cssDesktop.includes('#panel-settings {\n    --settings-control-width: 174px;\n    display: flex !important;'), 'Must not have unconditional display: flex !important on #panel-settings');
});

test('1.2 app.js switchTab sets display: flex for settings, block for others, and none for hidden', () => {
  assert(appJs.includes("panel.style.display = (key === 'settings') ? 'flex' : 'block'"), 'switchTab must set flex for settings');
  assert(appJs.includes("panel.style.display = 'none'"), 'switchTab must set none for inactive');
});

test('1.3 app.js switchTab calls updateSettingsPanelAvailability when switching to settings', () => {
  assert(/if \(tabName === 'settings'\) \{\s*this\.updateSettingsPanelAvailability\(\)/.test(appJs), 'switchTab must invoke updateSettingsPanelAvailability');
});

test('1.4 app.js openDrawer unconditionally calls updateSettingsPanelAvailability', () => {
  assert(/openDrawer\(tab\) \{[\s\S]*?this\.updateSettingsPanelAvailability\(\)[\s\S]*?this\.switchTab\(tab\)/.test(appJs), 'openDrawer must invoke updateSettingsPanelAvailability');
});

test('1.5 app.js updateSettingsPanelAvailability identifies PDF via format string or pdfViewport', () => {
  assert(appJs.includes("formatStr.includes('pdf')"), 'updateSettingsPanelAvailability must check format string');
  assert(appJs.includes("paperSection.style.display = isPdf ? 'block' : 'none'"), 'paperSection display must use isPdf');
});

test('1.6 platformBridge provides unified exportTextFile with dialog_save_text_file and fallback', () => {
  assert(bridgeJs.includes('dialog_save_text_file'), 'platformBridge must invoke dialog_save_text_file');
  assert(bridgeJs.includes('document.body.appendChild(a)'), 'exportTextFile fallback must append anchor to body');
  assert(bridgeJs.includes('directoryHint'), 'exportTextFile must return directoryHint');
});

test('1.7 app.js exports handle res.filePath, res.cancelled, and fallback directoryHint', () => {
  assert(appJs.includes('res?.cancelled'), 'exportNotesToMarkdown must handle res?.cancelled');
  assert(appJs.includes('res.filePath'), 'exportNotesToMarkdown must handle res.filePath');
  assert(appJs.includes('res.directoryHint'), 'Toast must mention directoryHint');
});

test('1.8 src-tauri commands/dialog.rs declares dialog_save_text_file and lib.rs registers it', () => {
  assert(dialogRs.includes('pub async fn dialog_save_text_file'), 'dialog.rs must define dialog_save_text_file');
  assert(libRs.includes('dialog_save_text_file'), 'lib.rs must register dialog_save_text_file');
});

// Suite 2: Live Headless Edge CDP Verification on dist-tauri
console.log('\nSuite 2: Live Headless Edge CDP Verification on dist-tauri');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9560;

async function runEdgeVerification() {
  const edge = spawn(edgePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--user-data-dir=C:\\Users\\YONGHU\\AppData\\Local\\Temp\\edge-test-profile-tab',
    'file:///D:/LindenLeaf-Dev/astra-mupdf-core/dist-tauri/index.html'
  ], { stdio: 'ignore' });

  try {
    let wsEndpoint = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        const list = await res.json();
        const target = list.find(t => t.type === 'page');
        if (target?.webSocketDebuggerUrl) {
          wsEndpoint = target.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }

    if (!wsEndpoint) throw new Error('Could not connect to Edge CDP');

    const ws = new WebSocket(wsEndpoint);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (evt) => {
          const data = JSON.parse(evt.data);
          if (data.id === id) {
            ws.removeEventListener('message', handler);
            if (data.error) reject(data.error);
            else resolve(data.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');

    // Wait for window.app to be initialized
    for (let i = 0; i < 60; i++) {
      const checkRes = await send('Runtime.evaluate', {
        expression: 'Boolean(window.app && window.app.dom && window.app.dom.tabPanels)',
        returnByValue: true
      });
      if (checkRes.result?.value) break;
      await new Promise(r => setTimeout(r, 100));
    }

    async function evalCode(expression) {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        console.error('Eval error:', JSON.stringify(res.exceptionDetails));
      }
      return res.result?.value;
    }

    // Step 2.1: Open drawer to 'toc'
    const tocData = await evalCode(`(() => {
      window.app.currentBookId = 'test-book-1';
      window.app.currentBookData = { id: 'test-book-1', format: 'epub', title: 'Test EPUB' };
      window.app.openDrawer('toc');

      const panelToc = document.getElementById('panel-toc');
      const panelSettings = document.getElementById('panel-settings');
      return {
        tocDisplay: window.getComputedStyle(panelToc).display,
        settingsDisplay: window.getComputedStyle(panelSettings).display,
        settingsHeight: panelSettings.offsetHeight
      };
    })()`);

    test('2.1 Open drawer with "toc": #panel-toc is block, #panel-settings is display:none with 0 height', () => {
      assert(tocData, 'tocData must be returned');
      assert.strictEqual(tocData.tocDisplay, 'block', `panel-toc should be block, got ${tocData.tocDisplay}`);
      assert.strictEqual(tocData.settingsDisplay, 'none', `panel-settings should be none, got ${tocData.settingsDisplay}`);
      assert.strictEqual(tocData.settingsHeight, 0, `panel-settings height should be 0, got ${tocData.settingsHeight}`);
    });

    // Step 2.2: Switch to 'notes'
    const notesData = await evalCode(`(() => {
      window.app.switchTab('notes');
      const panelNotes = document.getElementById('panel-notes');
      const panelSettings = document.getElementById('panel-settings');
      return {
        notesDisplay: window.getComputedStyle(panelNotes).display,
        settingsDisplay: window.getComputedStyle(panelSettings).display,
        settingsHeight: panelSettings.offsetHeight
      };
    })()`);

    test('2.2 Switch to "notes": #panel-notes is block, #panel-settings is display:none with 0 height', () => {
      assert(notesData, 'notesData must be returned');
      assert.strictEqual(notesData.notesDisplay, 'block', `panel-notes should be block, got ${notesData.notesDisplay}`);
      assert.strictEqual(notesData.settingsDisplay, 'none', `panel-settings should be none, got ${notesData.settingsDisplay}`);
      assert.strictEqual(notesData.settingsHeight, 0, `panel-settings height should be 0, got ${notesData.settingsHeight}`);
    });

    // Step 2.3: Switch to 'search'
    const searchData = await evalCode(`(() => {
      window.app.switchTab('search');
      const panelSearch = document.getElementById('panel-search');
      const panelSettings = document.getElementById('panel-settings');
      return {
        searchDisplay: window.getComputedStyle(panelSearch).display,
        settingsDisplay: window.getComputedStyle(panelSettings).display,
        settingsHeight: panelSettings.offsetHeight
      };
    })()`);

    test('2.3 Switch to "search": #panel-search is block, #panel-settings is display:none with 0 height', () => {
      assert(searchData, 'searchData must be returned');
      assert.strictEqual(searchData.searchDisplay, 'block', `panel-search should be block, got ${searchData.searchDisplay}`);
      assert.strictEqual(searchData.settingsDisplay, 'none', `panel-settings should be none, got ${searchData.settingsDisplay}`);
      assert.strictEqual(searchData.settingsHeight, 0, `panel-settings height should be 0, got ${searchData.settingsHeight}`);
    });

    // Step 2.4: Switch to 'settings' (EPUB)
    const settingsData = await evalCode(`(() => {
      window.app.switchTab('settings');
      const panelSettings = document.getElementById('panel-settings');
      const panelToc = document.getElementById('panel-toc');
      const paperSection = document.getElementById('pdf-paper-settings-section');
      return {
        settingsDisplay: window.getComputedStyle(panelSettings).display,
        tocDisplay: window.getComputedStyle(panelToc).display,
        paperDisplay: window.getComputedStyle(paperSection).display,
        activeDomain: panelSettings.getAttribute('data-active-domain')
      };
    })()`);

    test('2.4 Switch to "settings" (EPUB): #panel-settings is flex, #panel-toc is none, pdf paper is none', () => {
      assert(settingsData, 'settingsData must be returned');
      assert.strictEqual(settingsData.settingsDisplay, 'flex', `panel-settings should be flex, got ${settingsData.settingsDisplay}`);
      assert.strictEqual(settingsData.tocDisplay, 'none', `panel-toc should be none, got ${settingsData.tocDisplay}`);
      assert.strictEqual(settingsData.paperDisplay, 'none', `paperSection should be none for EPUB, got ${settingsData.paperDisplay}`);
      assert.strictEqual(settingsData.activeDomain, 'reading', `activeDomain should default to reading, got ${settingsData.activeDomain}`);
    });

    // Step 2.5: Switch to PDF book and open drawer from 'toc', then switch to 'settings'
    const pdfData = await evalCode(`(() => {
      window.app.currentBookId = 'test-pdf-1';
      window.app.currentBookData = { id: 'test-pdf-1', format: 'pdf', title: 'Test PDF Book' };
      
      // Open drawer to toc first
      window.app.openDrawer('toc');
      
      // Then user clicks settings tab in drawer
      window.app.switchTab('settings');

      const panelSettings = document.getElementById('panel-settings');
      const paperSection = document.getElementById('pdf-paper-settings-section');
      const typoSection = document.getElementById('typography-settings-section');
      const fontSizeInput = document.getElementById('setting-font-size');

      return {
        settingsDisplay: window.getComputedStyle(panelSettings).display,
        paperDisplay: window.getComputedStyle(paperSection).display,
        typoDisabled: typoSection.classList.contains('ll-fixed-disabled'),
        fontSizeDisabled: fontSizeInput.disabled
      };
    })()`);

    test('2.5 PDF Book workflow: #pdf-paper-settings-section displays block, typography controls are disabled', () => {
      assert(pdfData, 'pdfData must be returned');
      assert.strictEqual(pdfData.settingsDisplay, 'flex', `panel-settings should be flex, got ${pdfData.settingsDisplay}`);
      assert.strictEqual(pdfData.paperDisplay, 'block', `paperSection should be block for PDF, got ${pdfData.paperDisplay}`);
      assert.strictEqual(pdfData.typoDisabled, true, `typography-settings-section should have .ll-fixed-disabled`);
      assert.strictEqual(pdfData.fontSizeDisabled, true, `fontSizeInput should be disabled`);
    });

    // Step 2.6: Test Markdown Export Execution & Toast Messaging (Browser Fallback)
    const exportData = await evalCode(`(async () => {
      let toastMessage = '';
      const origShowToast = window.app.showToast;
      window.app.showToast = (msg) => { toastMessage = msg; };

      // Save real highlight in IndexedDB via saveHighlight
      await window.db.saveHighlight({
        id: 'hl-test-cdp-1',
        bookId: 'test-book-md',
        text: 'Sample highlight text for markdown export',
        note: 'CDP test annotation',
        createdAt: Date.now()
      });

      window.app.currentBookId = 'test-book-md';
      window.app.currentBookData = { id: 'test-book-md', title: '测试图书', author: '测试作者' };

      await window.app.exportNotesToMarkdown();

      window.app.showToast = origShowToast;

      return { toastMessage };
    })()`);

    test('2.6 exportNotesToMarkdown shows toast mentioning system download directory on fallback', () => {
      assert(exportData, 'exportData must be returned');
      assert(exportData.toastMessage.includes('系统【下载】') || exportData.toastMessage.includes('Downloads'), `Toast must mention Downloads folder, got: ${exportData.toastMessage}`);
      assert(exportData.toastMessage.includes('测试图书_读书笔记.md'), `Toast must include filename, got: ${exportData.toastMessage}`);
    });

    // Step 2.7: Test Shelf Global Notes Markdown Export (Browser Fallback)
    const shelfExportData = await evalCode(`(async () => {
      let toastMessage = '';
      const origShowToast = window.app.showToast;
      window.app.showToast = (msg) => { toastMessage = msg; };

      window.app._shelfAllNotes = [
        { id: 'sh-1', bookId: 'b1', text: 'Shelf note test', createdAt: Date.now() }
      ];
      window.app._shelfBookMap = new Map([
        ['b1', { id: 'b1', title: '书架测试书' }]
      ]);

      await window.app.exportShelfNotesToMarkdown();

      window.app.showToast = origShowToast;

      return { toastMessage };
    })()`);

    test('2.7 exportShelfNotesToMarkdown shows toast mentioning system download directory on fallback', () => {
      assert(shelfExportData, 'shelfExportData must be returned');
      assert(shelfExportData.toastMessage.includes('系统【下载】') || shelfExportData.toastMessage.includes('Downloads'), `Toast must mention Downloads folder, got: ${shelfExportData.toastMessage}`);
      assert(shelfExportData.toastMessage.includes('Astra_划线与笔记_'), `Toast must include filename prefix, got: ${shelfExportData.toastMessage}`);
    });

    // Step 2.8: Test Native Tauri Save Dialog Returning Custom Path
    const tauriSuccessData = await evalCode(`(async () => {
      let toastMessage = '';
      const origShowToast = window.app.showToast;
      window.app.showToast = (msg) => { toastMessage = msg; };

      // Mock Tauri invoke to simulate user picking "D:\\MyNotes\\custom_export.md"
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'dialog_save_text_file') {
              return 'D:\\\\MyNotes\\\\custom_export.md';
            }
            return null;
          }
        }
      };

      await window.app.exportNotesToMarkdown();

      delete window.__TAURI__;
      window.app.showToast = origShowToast;

      return { toastMessage };
    })()`);

    test('2.8 Native Tauri dialog_save_text_file shows full custom file path in toast', () => {
      assert(tauriSuccessData, 'tauriSuccessData must be returned');
      assert.strictEqual(tauriSuccessData.toastMessage, '已导出至：D:\\MyNotes\\custom_export.md', `Toast should show full path, got: ${tauriSuccessData.toastMessage}`);
    });

    // Step 2.9: Test Native Tauri Save Dialog User Cancellation
    const tauriCancelData = await evalCode(`(async () => {
      let toastCalls = 0;
      let toastMessage = '';
      const origShowToast = window.app.showToast;
      window.app.showToast = (msg) => { toastCalls++; toastMessage = msg; };

      // Mock Tauri invoke returning null (user clicked Cancel)
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === 'dialog_save_text_file') {
              return null;
            }
            return null;
          }
        }
      };

      await window.app.exportNotesToMarkdown();

      delete window.__TAURI__;
      window.app.showToast = origShowToast;

      return { toastCalls, toastMessage };
    })()`);

    test('2.9 Native Tauri dialog_save_text_file cancellation does not trigger toast or error', () => {
      assert(tauriCancelData, 'tauriCancelData must be returned');
      assert.strictEqual(tauriCancelData.toastCalls, 0, `Toast should not be called on cancel, got: ${tauriCancelData.toastMessage}`);
    });

    ws.close();
  } finally {
    edge.kill('SIGKILL');
  }
}

try {
  await runEdgeVerification();
} catch (err) {
  console.error('[FAIL] Edge CDP Suite encountered error:', err);
  failCount++;
}

console.log('\n====================================================');
console.log(`Results: ${passCount} passed, ${failCount} failed.`);
console.log('====================================================');

if (failCount > 0) {
  process.exit(1);
}
