import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const files = fs.readdirSync('D:/书');
const target = files.find(f => f.includes('涩泽龙彦作品集'));
console.log('Target file:', target);

const full = path.join('D:/书', target);
const outDir = 'D:/LindenLeaf-Data/test-env/epub-inspect/shibusawa';
const tmpZip = 'D:/LindenLeaf-Data/test-env/epub-inspect/shibusawa.zip';

if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
fs.copyFileSync(full, tmpZip);

execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${outDir}' -Force"`);
fs.unlinkSync(tmpZip);

console.log('Extraction complete. Files:');
console.log(fs.readdirSync(outDir));
