import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
const appJsPath = path.join(projectRoot, 'js/app.js');
let appJs = fs.readFileSync(appJsPath, 'utf8');

// Normalize line endings for replacement or use regex
const notesRegex = /(if\s*\(this\.shelfCategory\s*===\s*'notes'\)\s*\{[\s\S]*?const notesWsView = document\.getElementById\('shelf-notes-view'\)[\s\S]*?if\s*\(notesWsView\)\s*notesWsView\.style\.display\s*=\s*'flex'[\s\S]*?this\.updateSidebarNotesCount\(\)[\s\S]*?return this\.renderShelfNotesView\(\)[\s\S]*?\})([\s\S]*?const notesWsView = document\.getElementById\('shelf-notes-view'\)[\s\S]*?if\s*\(notesWsView\)\s*notesWsView\.style\.display\s*=\s*'none'[\s\S]*?const wsView = document\.getElementById\('ai-history-workspace-view'\)[\s\S]*?if\s*\(wsView\)\s*wsView\.style\.display\s*=\s*'none'[\s\S]*?if\s*\(this\.dom\.statsDashboardContainer\)\s*this\.dom\.statsDashboardContainer\.style\.display\s*=\s*'none'[\s\S]*?if\s*\(this\.dom\.shelfHeaderActions\)\s*this\.dom\.shelfHeaderActions\.style\.display\s*=\s*'flex'[\s\S]*?if\s*\(this\.dom\.bookCountFooter\)\s*this\.dom\.bookCountFooter\.style\.display\s*=\s*'block')/;

const match = appJs.match(notesRegex);
if (match) {
    let part1 = match[1];
    let part2 = match[2];

    // In part 1: add notesHeaderActions and statsBadge show
    part1 = part1.replace(
        "if (notesWsView) notesWsView.style.display = 'flex'",
        "if (notesWsView) notesWsView.style.display = 'flex'\n            const notesHeaderActions = document.getElementById('shelf-notes-header-actions')\n            if (notesHeaderActions) notesHeaderActions.style.display = 'flex'\n            const statsBadge = document.getElementById('shelf-notes-stats-badge')\n            if (statsBadge) statsBadge.style.display = 'inline-flex'"
    );

    // In part 2: add notesHeaderActions and statsBadge hide
    part2 = part2.replace(
        "if (notesWsView) notesWsView.style.display = 'none'",
        "if (notesWsView) notesWsView.style.display = 'none'\n        const notesHeaderActions = document.getElementById('shelf-notes-header-actions')\n        if (notesHeaderActions) notesHeaderActions.style.display = 'none'\n        const statsBadge = document.getElementById('shelf-notes-stats-badge')\n        if (statsBadge) statsBadge.style.display = 'none'"
    );

    appJs = appJs.replace(match[0], part1 + part2);
    fs.writeFileSync(appJsPath, appJs, 'utf8');
    console.log('[OK] Successfully updated js/app.js refreshBookshelf!');
} else {
    console.error('[FAIL] Regex could not match notes block in js/app.js');
}
