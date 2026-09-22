// scripts/build-dist.js
// Prepares clean frontend distribution folder for Tauri packaging
// Eliminates lock contentions with src-tauri/target build directories

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist');

console.log('[build-dist] Preparing frontend dist at:', distDir);

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

const itemsToCopy = [
    'index.html',
    'js',
    'css',
    'assets',
    'foliate-js-main',
    'vendor',
    'services'
];

for (const item of itemsToCopy) {
    const src = path.join(rootDir, item);
    const dest = path.join(distDir, item);
    if (fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true, force: true });
        console.log(`[build-dist] Copied ${item} -> dist/${item}`);
    }
}

console.log('[build-dist] Frontend dist preparation complete!');
