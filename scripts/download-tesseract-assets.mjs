// scripts/download-tesseract-assets.mjs
// Downloads Tesseract 7.0.0 core wasm files and Fast language traineddata models
// for full offline OCR capability.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const vendorDir = path.resolve('vendor/tesseract');
const tessdataDir = path.join(vendorDir, 'tessdata');
fs.mkdirSync(tessdataDir, { recursive: true });

const filesToDownload = [
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-relaxedsimd-lstm.wasm.js',
        dest: path.join(vendorDir, 'tesseract-core-relaxedsimd-lstm.wasm.js'),
        minSize: 100000
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-relaxedsimd-lstm.wasm',
        dest: path.join(vendorDir, 'tesseract-core-relaxedsimd-lstm.wasm'),
        minSize: 1000000
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js',
        dest: path.join(vendorDir, 'tesseract-core-simd-lstm.wasm.js'),
        minSize: 100000
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm',
        dest: path.join(vendorDir, 'tesseract-core-simd-lstm.wasm'),
        minSize: 1000000
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-lstm.wasm.js',
        dest: path.join(vendorDir, 'tesseract-core-lstm.wasm.js'),
        minSize: 100000
    },
    {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-lstm.wasm',
        dest: path.join(vendorDir, 'tesseract-core-lstm.wasm'),
        minSize: 1000000
    },
    {
        url: 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz',
        dest: path.join(tessdataDir, 'eng.traineddata.gz'),
        minSize: 1500000
    },
    {
        url: 'https://tessdata.projectnaptha.com/4.0.0_fast/chi_sim.traineddata.gz',
        dest: path.join(tessdataDir, 'chi_sim.traineddata.gz'),
        minSize: 1500000
    }
];

async function downloadFile(url, dest, minSize) {
    if (fs.existsSync(dest) && fs.statSync(dest).size >= minSize) {
        console.log(`[skip] Already downloaded: ${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
        return;
    }
    console.log(`[downloading] ${url} -> ${path.basename(dest)}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const fileStream = fs.createWriteStream(dest);
    await pipeline(res.body, fileStream);
    const size = fs.statSync(dest).size;
    console.log(`[saved] ${path.basename(dest)}: ${size} bytes`);
    if (size < minSize) {
        throw new Error(`File ${dest} too small: ${size} < ${minSize}`);
    }
}

async function main() {
    for (const item of filesToDownload) {
        await downloadFile(item.url, item.dest, item.minSize);
    }
    console.log('All Tesseract offline assets ready!');
}

main().catch(err => {
    console.error('Download failed:', err);
    process.exit(1);
});
