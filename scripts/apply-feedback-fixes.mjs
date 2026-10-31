import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';

// =========================================================================
// 1. UPDATE index.html
// =========================================================================
const indexPath = path.join(projectRoot, 'index.html');
let indexContent = fs.readFileSync(indexPath, 'utf8');

// 1.1 Add cover & curl to setting-turn-animation-mode
const oldAnimRegex = /<select id="setting-turn-animation-mode"[^>]*>[\s\S]*?<\/select>/;
const newAnimHtml = `<select id="setting-turn-animation-mode" class="setting-select">
                <option value="none">无动画翻页 (默认)</option>
                <option value="slide" selected>横向滑动</option>
                <option value="cover">仿真覆盖</option>
                <option value="curl">仿真纸张卷曲</option>
              </select>`;

indexContent = indexContent.replace(oldAnimRegex, newAnimHtml);

// 1.2 Reorder #selection-popup: popup-note placed right after popup-underline
const oldPopupRegex = /<div id="selection-popup">[\s\S]*?<\/div>(\s*<!-- Standalone Offline Dictionary Card)/;
const newPopupHtml = `<div id="selection-popup">
      <span id="popup-multi-badge" class="multi-sel-badge" style="display: none;">已选 1 处</span>
      <div class="color-dot color-yellow" data-color="#facc15" title="黄色荧光笔"></div>
      <div class="color-dot color-green" data-color="#4ade80" title="绿色荧光笔"></div>
      <div class="color-dot color-blue" data-color="#60a5fa" title="蓝色荧光笔"></div>
      <div class="color-dot color-pink" data-color="#f472b6" title="粉色荧光笔"></div>
      <div style="width: 1px; height: 18px; background: var(--border-color); margin: 0 2px;"></div>
      <button id="popup-underline" class="btn-tool" style="width: 28px; height: 28px; font-weight: 700; text-decoration: underline;" title="实线下划线">U</button>
      <button id="popup-note" class="btn-tool" style="width: 28px; height: 28px;" title="写想法/笔记">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button id="popup-copy" class="btn-tool" style="width: 28px; height: 28px;" title="复制文本 (支持 Ctrl 多选合并复制)">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
      <button id="popup-dict" class="btn-tool" style="width: 28px; height: 28px; color: var(--accent-green); font-size: 13px;" title="查词典（本地英汉释义）"><svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 3H20v19H6.5A2.5 2.5 0 0 1 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z"/></svg></button>
      <button id="popup-ai" class="btn-tool" style="width: 28px; height: 28px; color: var(--accent-purple); font-size: 13px;" title="AI 翻译与智能问答" aria-label="AI 翻译与智能问答"><svg class="icon" viewBox="0 0 24 24"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg></button>
      <button id="popup-search" class="btn-tool" style="width: 28px; height: 28px; color: var(--accent-blue);" title="网页搜索 / 百科查词">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
      <button id="popup-dashed" class="btn-tool" style="width: 28px; height: 28px; font-weight: 700; border-bottom: 2px dashed var(--text-muted); border-radius: 4px; font-size: 11px;" title="虚线下划线">┄</button>
      <button id="popup-share" class="btn-tool" style="width: 28px; height: 28px; color: var(--accent-purple);" title="生成精美书摘图片 (可一键复制到剪贴板)">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      </button>
      <button id="popup-translate-para" class="btn-tool" style="display: none; width: auto; height: 28px; padding: 0 6px; font-size: 11px; color: var(--accent-purple); font-weight: 600;" title="整段就地翻译 (高级设置)">译本段</button>
    </div>$1`;

indexContent = indexContent.replace(oldPopupRegex, newPopupHtml);
fs.writeFileSync(indexPath, indexContent, 'utf8');
console.log('[1/5] index.html updated');

// =========================================================================
// 2. UPDATE css/mobile-preferences.css (Fix AI settings slider collapse)
// =========================================================================
const prefCssPath = path.join(projectRoot, 'css/mobile-preferences.css');
let prefCss = fs.readFileSync(prefCssPath, 'utf8');

const aiSliderFix = `
/* Fix AI Settings Stacked Slider Row & Prevent Label Column Collapse */
#mobile-settings-page .control-row.settings-row-stacked {
  display: flex !important;
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 8px !important;
  min-height: auto !important;
  padding: 12px 0 !important;
}
#mobile-settings-page .control-row.settings-row-stacked > div:first-child {
  display: flex !important;
  justify-content: space-between !important;
  align-items: center !important;
  width: 100% !important;
}
#mobile-settings-page .control-row.settings-row-stacked .control-label {
  grid-column: auto !important;
  grid-row: auto !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  font: 500 15px/1.5 var(--mobile-font-ui) !important;
  color: var(--mobile-text-main) !important;
}
#mobile-settings-page .control-row.settings-row-stacked > input[type="range"] {
  grid-column: auto !important;
  grid-row: auto !important;
  width: 100% !important;
  margin: 4px 0 !important;
}
#mobile-settings-page .control-row.settings-row-stacked > p {
  width: 100% !important;
  margin: 0 !important;
  font: 13px/1.6 var(--mobile-font-ui) !important;
  color: var(--mobile-text-muted) !important;
}
`;

if (!prefCss.includes('Fix AI Settings Stacked Slider Row')) {
  prefCss += aiSliderFix;
  fs.writeFileSync(prefCssPath, prefCss, 'utf8');
  console.log('[2/5] css/mobile-preferences.css updated');
}

// =========================================================================
// 3. UPDATE css/mobile-shell.css (Mobile selection popup & "Me" typography)
// =========================================================================
const shellCssPath = path.join(projectRoot, 'css/mobile-shell.css');
let shellCss = fs.readFileSync(shellCssPath, 'utf8');

const mobileTypographyAndPopupCss = `
/* ==========================================================================
   MOBILE SELECTION POPUP & "ME" VIEW LITERARY EDITORIAL TYPOGRAPHY
   ========================================================================== */

/* 1. Mobile Selection Popup Responsive Behavior (图 148) */
html.is-mobile-viewport #selection-popup {
  max-width: calc(100vw - 20px) !important;
  overflow-x: auto !important;
  -webkit-overflow-scrolling: touch !important;
  scrollbar-width: none !important;
  padding: 6px 10px !important;
  gap: 7px !important;
  border-radius: 14px !important;
  box-sizing: border-box !important;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.25) !important;
}
html.is-mobile-viewport #selection-popup::-webkit-scrollbar {
  display: none !important;
}
html.is-mobile-viewport #selection-popup .btn-tool {
  min-width: 32px !important;
  min-height: 32px !important;
  flex-shrink: 0 !important;
}
html.is-mobile-viewport #selection-popup .color-dot {
  flex-shrink: 0 !important;
}
html.is-mobile-viewport #selection-popup #popup-note {
  color: var(--mobile-primary, #303634) !important;
  background: var(--mobile-primary-subtle, rgba(48, 54, 52, .06)) !important;
  border-radius: 6px !important;
}

/* 2. Unified Literary Editorial Typography for "我的" (图 151) */
html.is-mobile-viewport #mobile-me-view .mobile-header-title {
  font-family: var(--mobile-font-editorial) !important;
  font-size: 28px !important;
  font-weight: 600 !important;
  color: var(--mobile-text-main) !important;
}
html.is-mobile-viewport .mobile-profile-name {
  font-family: var(--mobile-font-editorial) !important;
  font-size: 1.35rem !important;
  font-weight: 600 !important;
  color: var(--mobile-text-main) !important;
}
html.is-mobile-viewport .mobile-profile-sub {
  font-family: var(--mobile-font-ui) !important;
  font-size: 0.8rem !important;
  color: var(--mobile-text-muted) !important;
}
html.is-mobile-viewport .mobile-stat-val {
  font-family: var(--mobile-font-editorial) !important;
  font-size: 1.25rem !important;
  font-weight: 600 !important;
  color: var(--mobile-text-main) !important;
}
html.is-mobile-viewport .mobile-stat-key {
  font-family: var(--mobile-font-ui) !important;
  font-size: 12px !important;
  color: var(--mobile-text-muted) !important;
}
html.is-mobile-viewport .mobile-group-title {
  font-family: var(--mobile-font-editorial) !important;
  font-size: 14.5px !important;
  font-weight: 600 !important;
  color: var(--mobile-text-main) !important;
  letter-spacing: 0.02em !important;
}
html.is-mobile-viewport .mobile-cell-label {
  font-family: var(--mobile-font-ui) !important;
  font-size: 15px !important;
  font-weight: 400 !important;
  color: var(--mobile-text-main) !important;
}
`;

if (!shellCss.includes('MOBILE SELECTION POPUP & "ME" VIEW LITERARY EDITORIAL TYPOGRAPHY')) {
  shellCss += mobileTypographyAndPopupCss;
  fs.writeFileSync(shellCssPath, shellCss, 'utf8');
  console.log('[3/5] css/mobile-shell.css updated');
}

console.log('Batch CSS and index.html applied successfully.');
