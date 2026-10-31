import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';

// =========================================================================
// 1. UPDATE css/mobile-shell.css
// =========================================================================
const shellCssPath = path.join(projectRoot, 'css/mobile-shell.css');
let shellCss = fs.readFileSync(shellCssPath, 'utf8');

const displaySheetExtrasCss = `
/* 3. Quick Font & Turn Selectors in Mobile Display Sheet (图 150 & 152) */
.mobile-sheet-subheading {
  margin-top: 1.1rem;
  margin-bottom: 0.45rem;
  font-size: 13px;
  font-weight: 600;
  color: var(--mobile-text-muted, #71717a);
  letter-spacing: 0.02em;
}

.mobile-option-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.mobile-option-pill {
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  background: var(--mobile-bg-secondary, rgba(0, 0, 0, 0.04));
  color: var(--mobile-text-main, #27272a);
  border: 1.5px solid var(--mobile-border, rgba(0, 0, 0, 0.08));
  transition: all 0.15s ease;
  user-select: none;
}

.mobile-option-pill:active {
  transform: scale(0.96);
}

.mobile-option-pill.active {
  border-color: var(--mobile-primary, #303634);
  background: var(--mobile-primary-subtle, rgba(48, 54, 52, 0.08));
  color: var(--mobile-primary, #303634);
  font-weight: 600;
}

.mobile-sheet-link-btn {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  margin-top: 1.35rem;
  padding: 12px 14px;
  background: var(--mobile-bg-secondary, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--mobile-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--mobile-text-main, #27272a);
  cursor: pointer;
  box-sizing: border-box;
  transition: background 0.15s ease;
}

.mobile-sheet-link-btn:active {
  background: var(--mobile-bg-active, rgba(0, 0, 0, 0.08));
}
`;

if (!shellCss.includes('Quick Font & Turn Selectors in Mobile Display Sheet')) {
  shellCss += displaySheetExtrasCss;
  fs.writeFileSync(shellCssPath, shellCss, 'utf8');
  console.log('[1/4] css/mobile-shell.css updated with display sheet option styles');
} else {
  console.log('[1/4] css/mobile-shell.css already contains display sheet option styles');
}

// =========================================================================
// 2. UPDATE js/mobile-shell.js
// =========================================================================
const mobileShellPath = path.join(projectRoot, 'js/mobile-shell.js');
let rawMobileShell = fs.readFileSync(mobileShellPath, 'utf8');
const isCrlf = rawMobileShell.includes('\r\n');
let mobileShellContent = rawMobileShell.replace(/\r\n/g, '\n');

// 2.1 Remove btn-home-refresh from home-top-actions
const refreshBtnRegex = /<button id="btn-home-refresh"[\s\S]*?<\/button>\s*/;
if (refreshBtnRegex.test(mobileShellContent)) {
  mobileShellContent = mobileShellContent.replace(refreshBtnRegex, '');
  console.log('[2/4-a] Removed btn-home-refresh HTML markup');
}

// Remove the event listener for btn-home-refresh
const refreshListenerRegex = /document\.getElementById\('btn-home-refresh'\)\?\.addEventListener\('click'[\s\S]*?\}\)\s*/;
if (refreshListenerRegex.test(mobileShellContent)) {
  mobileShellContent = mobileShellContent.replace(refreshListenerRegex, '');
  console.log('[2/4-b] Removed btn-home-refresh event listener');
}

// 2.2 Add Font Selection, Page Turn Animation, and "More Settings" to #mobile-display-sheet
const oldReflowControlsRegex = /<div id="mobile-reflow-controls">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<div id="mobile-pdf-page-sheet"/;

const newReflowControlsWithSheets = `<div id="mobile-reflow-controls">
                    <div class="mobile-stepper-row">
                        <span class="mobile-stepper-label">字号</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-font-dec" class="mobile-stepper-btn">A-</button>
                            <span id="val-font-size">18px</span>
                            <button id="btn-font-inc" class="mobile-stepper-btn">A+</button>
                        </div>
                    </div>

                    <div class="mobile-stepper-row" style="margin-top: 1rem;">
                        <span class="mobile-stepper-label">行距</span>
                        <div class="mobile-stepper-ctrls">
                            <button id="btn-lh-dec" class="mobile-stepper-btn">-</button>
                            <span id="val-line-height">1.6</span>
                            <button id="btn-lh-inc" class="mobile-stepper-btn">+</button>
                        </div>
                    </div>

                    <div class="mobile-sheet-subheading">正文字体</div>
                    <div class="mobile-option-row" id="mobile-font-family-row">
                        <button type="button" class="mobile-option-pill" data-mobile-font="serif" style="font-family: var(--font-serif, 'Noto Serif SC', serif);">宋体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="sans" style="font-family: var(--font-sans, 'Noto Sans SC', sans-serif);">黑体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="kaiti" style="font-family: var(--font-kaiti, 'LXGW WenKai', serif);">楷体</button>
                        <button type="button" class="mobile-option-pill" data-mobile-font="mono" style="font-family: var(--font-mono, monospace);">等宽</button>
                    </div>

                    <div class="mobile-sheet-subheading">翻页动效</div>
                    <div class="mobile-option-row" id="mobile-page-turn-row">
                        <button type="button" class="mobile-option-pill" data-mobile-turn="none">无动画</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="slide">滑动</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="cover">覆盖</button>
                        <button type="button" class="mobile-option-pill" data-mobile-turn="curl">仿真</button>
                    </div>

                    <button type="button" id="btn-mobile-more-reading-settings" class="mobile-sheet-link-btn">
                        <span>更多排版与显示设置</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                    </div>
                </div>
            </div>

            <div id="mobile-pdf-page-sheet"`;

if (oldReflowControlsRegex.test(mobileShellContent)) {
  mobileShellContent = mobileShellContent.replace(oldReflowControlsRegex, newReflowControlsWithSheets);
  console.log('[2/4-c] Added font and page turn options to #mobile-display-sheet markup');
}

// 2.3 Wire up listeners for font, turn animation, and more reading settings link
const stepperAnchor = `            const v = document.getElementById('val-line-height')
            if (v) v.innerText = next.toFixed(1)
        })`;

const newSheetListeners = `            const v = document.getElementById('val-line-height')
            if (v) v.innerText = next.toFixed(1)
        })

        // Quick Font Selection (Feedback 3 & 150)
        document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(btn => {
            btn.addEventListener('click', () => {
                const fontKey = btn.dataset.mobileFont
                window.app?.setSetting?.('font', fontKey)
                window.app?.saveSettingsDebounced?.()
                window.app?.updateSettingsUI?.()
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileFont === fontKey)
                })
            })
        })

        // Quick Page Turn Animation Selection (Feedback 3, 5 & 152)
        document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(btn => {
            btn.addEventListener('click', () => {
                const turnKey = btn.dataset.mobileTurn
                window.app?.setSetting?.('pageTurnMode', turnKey)
                window.app?.pageTurnController?.setMode?.(turnKey)
                window.app?.saveSettingsDebounced?.()
                if (window.app?.dom?.turnAnimationSelect) {
                    window.app.dom.turnAnimationSelect.value = turnKey
                }
                document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileTurn === turnKey)
                })
            })
        })

        // Link to full appearance / reading settings
        document.getElementById('btn-mobile-more-reading-settings')?.addEventListener('click', () => {
            this.closeAllSheets()
            this.settingsPage.open('appearance')
        })`;

if (mobileShellContent.includes(stepperAnchor) && !mobileShellContent.includes('Quick Font Selection (Feedback 3 & 150)')) {
  mobileShellContent = mobileShellContent.replace(stepperAnchor, newSheetListeners);
  console.log('[2/4-d] Added font, turn animation, and more settings listeners');
}

// 2.4 Sync font & turn animation active states when sheet opens
const syncAnchor = `                const fVal = document.getElementById('val-font-size')
                const lhVal = document.getElementById('val-line-height')
                if (fVal) fVal.innerText = \`\${window.app?.settings?.fontSize || 18}px\`
                if (lhVal) lhVal.innerText = \`\${window.app?.settings?.lineHeight || 1.6}\``;

const newSyncLogic = `                const fVal = document.getElementById('val-font-size')
                const lhVal = document.getElementById('val-line-height')
                if (fVal) fVal.innerText = \`\${window.app?.settings?.fontSize || 18}px\`
                if (lhVal) lhVal.innerText = \`\${window.app?.settings?.lineHeight || 1.6}\`

                const curFont = window.app?.settings?.font || 'serif'
                document.querySelectorAll('#mobile-font-family-row [data-mobile-font]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileFont === curFont)
                })

                const curTurn = window.app?.settings?.pageTurnMode || 'slide'
                document.querySelectorAll('#mobile-page-turn-row [data-mobile-turn]').forEach(b => {
                    b.classList.toggle('active', b.dataset.mobileTurn === curTurn)
                })`;

if (mobileShellContent.includes(syncAnchor) && !mobileShellContent.includes('curFont = window.app?.settings?.font')) {
  mobileShellContent = mobileShellContent.replace(syncAnchor, newSyncLogic);
  console.log('[2/4-e] Synced font and turn state on sheet open');
}

fs.writeFileSync(mobileShellPath, isCrlf ? mobileShellContent.replace(/\n/g, '\r\n') : mobileShellContent, 'utf8');
console.log('Mobile shell updated cleanly.');
