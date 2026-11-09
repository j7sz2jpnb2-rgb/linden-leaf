// run-syntax-checks.mjs - Single-process syntax verification using vm.SourceTextModule
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (!vm.SourceTextModule) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url)], {
    stdio: 'inherit'
  });
  process.exit(result.status ?? 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'js/translation-job-core.js',
  'js/chapter-translation-manager.js',
  'js/db.js',
  'js/syncEngine.js',
  'js/txt-toc-worker.js',
  'js/advanced-settings.js',
  'js/ai-sidebar-controller.js',
  'js/reading-ai-assistant.js',
  'js/tts-player.js',
  'js/excerpt-source-resolver.js',
  'js/dictionary-service.js',
  'js/platformBridge.js',
  'js/quote-card.js',
  'js/page-turn-controller.js',
  'js/custom-font-manager.js',
  'js/theme-customizer.js',
  'js/reading-presets.js',
  'js/pdf-driver.js',
  'js/pdf-viewport.js',
  'js/pdf-cover.js',
  'js/pdf-toc.js',
  'js/fulltext-search.js',
  'js/import-queue.js',
  'js/updater.js',
  'js/storage-providers.js',
  'js/ocr-service.js',
  'js/app.js',
  'foliate-js-main/txt.js'
];

console.log('--- Single-Process Node Syntax Checks (vm.SourceTextModule) ---');
let allPassed = true;

for (const file of files) {
  try {
    const fullPath = path.join(root, file);
    const code = fs.readFileSync(fullPath, 'utf8');
    new vm.SourceTextModule(code, { identifier: file });
    console.log(`[PASS] ${file}`);
  } catch (err) {
    allPassed = false;
    console.error(`[FAIL] ${file}`);
    console.error(err.message);
  }
}

if (!allPassed) {
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} JS files passed single-process syntax checks cleanly.`);
}
