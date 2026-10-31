import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';

// 1. Patch index.html
const indexHtmlPath = path.join(projectRoot, 'index.html');
let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// 1a. Extend setting-gap max to 25
if (indexHtml.includes('id="setting-gap" class="control-input" min="2" max="15"')) {
    indexHtml = indexHtml.replace(
        'id="setting-gap" class="control-input" min="2" max="15"',
        'id="setting-gap" class="control-input" min="2" max="25"'
    );
    console.log('[OK] index.html setting-gap expanded to max=25');
} else {
    console.warn('[SKIP] setting-gap max=15 not found in index.html');
}

// 1b. Add stats-badge and shelf-notes-header-actions in #bookshelf-header
const categoryTitleTarget = '<h2 class="header-category-title" id="current-category-title" style="display: none;"></h2>';
const categoryTitleReplacement = `<h2 class="header-category-title" id="current-category-title" style="display: none;"></h2>\n            <span class="shelf-notes-count-badge" id="shelf-notes-stats-badge" style="display: none;">共 0 条</span>`;
if (indexHtml.includes(categoryTitleTarget) && !indexHtml.includes('id="shelf-notes-stats-badge"')) {
    indexHtml = indexHtml.replace(categoryTitleTarget, categoryTitleReplacement);
    console.log('[OK] index.html added shelf-notes-stats-badge next to current-category-title');
}

const shelfHeaderActionsTarget = '<div class="header-actions" id="shelf-header-actions">';
const shelfNotesHeaderActionsBlock = `<!-- Shelf Notes Dedicated Header Actions (Desktop) -->
          <div class="header-actions" id="shelf-notes-header-actions" style="display: none;">
            <button type="button" id="btn-export-shelf-notes" class="btn-shelf-notes-action" title="导出为 Markdown 文件">
              <svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>导出 Markdown</span>
            </button>
          </div>

          <div class="header-actions" id="shelf-header-actions">`;

if (indexHtml.includes(shelfHeaderActionsTarget) && !indexHtml.includes('id="shelf-notes-header-actions"')) {
    indexHtml = indexHtml.replace(shelfHeaderActionsTarget, shelfNotesHeaderActionsBlock);
    console.log('[OK] index.html added shelf-notes-header-actions');
}

// 1c. Remove inner duplicate shelf-notes-header-bar from #shelf-notes-view
const duplicateHeaderBarRegex = /<!-- Top Header Bar -->\s*<div class="shelf-notes-header-bar">[\s\S]*?<\/div>\s*<\/div>\s*(<!-- Filter Toolbar -->)/;
if (duplicateHeaderBarRegex.test(indexHtml)) {
    indexHtml = indexHtml.replace(duplicateHeaderBarRegex, '$1');
    console.log('[OK] index.html removed redundant inner shelf-notes-header-bar');
} else {
    // Fallback search
    const oldBarSnippet = `<div class="shelf-notes-header-bar">
                <div class="shelf-notes-header-left">
                  <h2 class="shelf-notes-heading">划线与笔记</h2>
                  <span class="shelf-notes-count-badge" id="shelf-notes-stats-badge">共 0 条</span>
                </div>
                <div class="shelf-notes-header-actions">
                  <button type="button" id="btn-export-shelf-notes" class="btn-shelf-notes-action" title="导出为 Markdown 文件">
                    <svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span>导出 Markdown</span>
                  </button>
                </div>
              </div>`;
    if (indexHtml.includes(oldBarSnippet)) {
        indexHtml = indexHtml.replace(oldBarSnippet, '');
        console.log('[OK] index.html removed redundant inner shelf-notes-header-bar (fallback match)');
    } else {
        console.warn('[SKIP] duplicate shelf-notes-header-bar not found');
    }
}

fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');

// 2. Patch css/desktop-ui.css
const desktopCssPath = path.join(projectRoot, 'css/desktop-ui.css');
let desktopCss = fs.readFileSync(desktopCssPath, 'utf8');

// 2a. Update .header-category-title to authentic literary Serif (Noto Serif SC) matching Android
const oldHeaderTitleRule = `.header-category-title { font-family: var(--font-ui); font-size: 20px; font-weight: 600; line-height: 28px; letter-spacing: -.35px; }`;
const newHeaderTitleRule = `.header-category-title {
    font-family: "Noto Serif SC", var(--font-serif);
    font-size: 24px;
    font-weight: 700;
    line-height: 32px;
    letter-spacing: -0.015em;
    color: var(--text-main);
  }`;

if (desktopCss.includes(oldHeaderTitleRule)) {
    desktopCss = desktopCss.replace(oldHeaderTitleRule, newHeaderTitleRule);
    console.log('[OK] css/desktop-ui.css updated .header-category-title font to Noto Serif SC');
} else {
    console.warn('[SKIP] old .header-category-title rule not found in desktop-ui.css');
}

// 2b. Add top-header shelf-notes styles
const extraShelfNotesCss = `
/* Top Bookshelf Header Notes Integrations */
.header-left .shelf-notes-count-badge {
  font-size: 0.8rem;
  padding: 3px 12px;
  border-radius: 20px;
  background: var(--brand-terracotta-subtle, rgba(217, 119, 87, 0.12));
  color: var(--accent-purple, #da7756);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
  vertical-align: middle;
}

#shelf-notes-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

#shelf-notes-header-actions .btn-shelf-notes-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--text-main);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.18s ease;
}

#shelf-notes-header-actions .btn-shelf-notes-action:hover {
  background: var(--bg-sidebar-hover);
  border-color: var(--accent-purple, #da7756);
  color: var(--accent-purple, #da7756);
}
`;

if (!desktopCss.includes('Top Bookshelf Header Notes Integrations')) {
    desktopCss += '\n' + extraShelfNotesCss;
    console.log('[OK] css/desktop-ui.css appended header notes integration styles');
}

fs.writeFileSync(desktopCssPath, desktopCss, 'utf8');

// 3. Patch js/app.js
const appJsPath = path.join(projectRoot, 'js/app.js');
let appJs = fs.readFileSync(appJsPath, 'utf8');

// 3a. Update shelfCategory === 'notes' handling in refreshBookshelf()
const notesBranchOld = `            const notesWsView = document.getElementById('shelf-notes-view')
            if (notesWsView) notesWsView.style.display = 'flex'
            this.updateSidebarNotesCount()
            return this.renderShelfNotesView()`;

const notesBranchNew = `            const notesWsView = document.getElementById('shelf-notes-view')
            if (notesWsView) notesWsView.style.display = 'flex'
            const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
            if (notesHeaderActions) notesHeaderActions.style.display = 'flex'
            const statsBadge = document.getElementById('shelf-notes-stats-badge')
            if (statsBadge) statsBadge.style.display = 'inline-flex'
            this.updateSidebarNotesCount()
            return this.renderShelfNotesView()`;

if (appJs.includes(notesBranchOld)) {
    appJs = appJs.replace(notesBranchOld, notesBranchNew);
    console.log('[OK] js/app.js updated refreshBookshelf notes branch');
} else {
    console.warn('[SKIP] notesBranchOld not found in js/app.js');
}

// 3b. Update non-notes branch to hide notes header actions & badge
const nonNotesBranchOld = `        const notesWsView = document.getElementById('shelf-notes-view')
        if (notesWsView) notesWsView.style.display = 'none'
        const wsView = document.getElementById('ai-history-workspace-view')
        if (wsView) wsView.style.display = 'none'
        if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
        if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
        if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'`;

const nonNotesBranchNew = `        const notesWsView = document.getElementById('shelf-notes-view')
        if (notesWsView) notesWsView.style.display = 'none'
        const notesHeaderActions = document.getElementById('shelf-notes-header-actions')
        if (notesHeaderActions) notesHeaderActions.style.display = 'none'
        const statsBadge = document.getElementById('shelf-notes-stats-badge')
        if (statsBadge) statsBadge.style.display = 'none'
        const wsView = document.getElementById('ai-history-workspace-view')
        if (wsView) wsView.style.display = 'none'
        if (this.dom.statsDashboardContainer) this.dom.statsDashboardContainer.style.display = 'none'
        if (this.dom.shelfHeaderActions) this.dom.shelfHeaderActions.style.display = 'flex'
        if (this.dom.bookCountFooter) this.dom.bookCountFooter.style.display = 'block'`;

if (appJs.includes(nonNotesBranchOld)) {
    appJs = appJs.replace(nonNotesBranchOld, nonNotesBranchNew);
    console.log('[OK] js/app.js updated refreshBookshelf non-notes branch');
} else {
    console.warn('[SKIP] nonNotesBranchOld not found in js/app.js');
}

fs.writeFileSync(appJsPath, appJs, 'utf8');

console.log('Patch complete!');
