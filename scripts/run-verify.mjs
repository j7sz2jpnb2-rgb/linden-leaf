// scripts/run-verify.mjs
// Unified cross-platform verification entrypoint for Linden Leaf (local dev & CI).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { name: 'Syntax Checks', args: ['scripts/run-syntax-checks.mjs'] },
  { name: 'Architecture Structure Checks', args: ['--expose-internals', 'scripts/check-structure.cjs'] },
  { name: 'i18n Parity & Coverage', args: ['scripts/test-i18n.mjs'] },
  { name: 'i18n Interactions', args: ['scripts/test-i18n-interactions.mjs'] },
  { name: 'UI Output Safety', args: ['scripts/test-ui-output-safety.mjs'] },
  { name: 'Data Contracts', args: ['scripts/test-data-contracts.mjs'] },
  { name: 'App Composition', args: ['scripts/test-app-composition.mjs'] },
  { name: 'Reader Search', args: ['scripts/test-reader-search.mjs'] },
  { name: 'Reader UX Fixes', args: ['scripts/test-reader-ux-fixes.mjs'] },
  { name: 'Android TTS', args: ['scripts/test-android-tts.mjs'] },
  { name: 'PDF / TTS / Rust Contracts', args: ['scripts/test-pdf-tts-rust-fixes.mjs'] },
  { name: 'Pre-beta Hardening', args: ['scripts/test-prebeta-hardening.mjs'] },
  { name: 'Regression Suite', args: ['scripts/test-regression-suite.mjs'] },
  { name: 'Audit Hardening Suite', args: ['--test', 'scripts/test-audit-hardening.mjs'] },
  { name: 'UX & Polish Modules Suite', args: ['--test', 'scripts/test-ux-polish-modules.mjs'] },
];

const results = [];
let failed = false;

for (const step of steps) {
  const start = Date.now();
  console.log(`\n=== [verify] ${step.name} ===`);
  const res = spawnSync(process.execPath, step.args, {
    cwd: root,
    stdio: 'inherit',
  });
  const ms = Date.now() - start;
  const ok = !res.error && !res.signal && res.status === 0;
  results.push({ name: step.name, ok, ms, status: res.status, signal: res.signal });
  if (!ok) {
    failed = true;
    console.error(`[verify] FAILED: ${step.name} (status=${res.status}, signal=${res.signal || 'none'})`);
    break;
  }
}

console.log('\n=== [verify] Summary ===');
for (const r of results) {
  console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name} (${r.ms}ms)`);
}

if (failed) {
  process.exit(1);
}
console.log(`\nAll ${results.length}/${steps.length} verification suites passed.`);
