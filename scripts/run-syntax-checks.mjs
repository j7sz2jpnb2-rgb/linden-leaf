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
  if (result.error) {
    console.error('[syntax-check] Failed to spawn child process:', result.error);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[syntax-check] Child process terminated by signal: ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'js'))
  .filter(name => name.endsWith('.js'))
  .map(name => 'js/' + name)
  .concat([
    'foliate-js-main/txt.js',
    'foliate-js-main/paginator.js',
    'foliate-js-main/view.js',
    'foliate-js-main/epub.js',
    'services/webdav.js'
  ]);

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
