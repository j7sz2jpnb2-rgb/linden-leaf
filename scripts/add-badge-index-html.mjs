import fs from 'fs';
import path from 'path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
const indexHtmlPath = path.join(projectRoot, 'index.html');
let c = fs.readFileSync(indexHtmlPath, 'utf8');

const target = '<h2 class="header-category-title" id="current-category-title" style="display: none;"></h2>';
const replacement = `<h2 class="header-category-title" id="current-category-title" style="display: none;"></h2>
            <span class="shelf-notes-count-badge" id="shelf-notes-stats-badge" style="display: none;">共 0 条</span>`;

if (c.includes(target) && !c.includes('id="shelf-notes-stats-badge"')) {
    c = c.replace(target, replacement);
    fs.writeFileSync(indexHtmlPath, c, 'utf8');
    console.log('[OK] Added shelf-notes-stats-badge');
} else {
    console.log('[INFO] Already present or target not found');
}
