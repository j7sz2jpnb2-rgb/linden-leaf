// run-syntax-checks.mjs
// Sequentially run node --check on all key JS modules
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const files = [
  'js/translation-job-core.js',
  'js/chapter-translation-manager.js',
  'js/db.js',
  'js/syncEngine.js',
  'js/txt-toc-worker.js',
  'js/advanced-settings.js',
  'js/ai-sidebar-controller.js',
  'js/reading-ai-assistant.js',
  'js/annual-report.js',
  'js/tts-player.js',
  'js/excerpt-source-resolver.js',
  'js/dictionary-service.js',
  'js/platformBridge.js',
  'js/quote-card.js',
  'js/page-turn-controller.js',
  'js/custom-font-manager.js',
  'js/theme-customizer.js',
  'js/reading-presets.js',
  'js/app.js',
  'foliate-js-main/txt.js'
];

console.log('--- Sequential Node Syntax Checks ---');
let allPassed = true;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`[PASS] ${file}`);
  } catch (err) {
    allPassed = false;
    console.error(`[FAIL] ${file}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
  }
}

if (!allPassed) {
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} JS files passed individual syntax checks cleanly.`);
}
