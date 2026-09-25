// scripts/test-tesseract-load.mjs
import fs from 'node:fs';

const workerJs = fs.readFileSync('vendor/tesseract/worker.min.js', 'utf8');

const idx = workerJs.indexOf('https://cdn.jsdelivr.net/npm/tesseract.js-core@v');
console.log('--- Core loading snippet ---');
console.log(workerJs.slice(Math.max(0, idx - 300), idx + 600));

const langIdx = workerJs.indexOf('https://cdn.jsdelivr.net/npm/@tesseract.js-data/');
console.log('--- Lang loading snippet ---');
console.log(workerJs.slice(Math.max(0, langIdx - 300), langIdx + 600));
