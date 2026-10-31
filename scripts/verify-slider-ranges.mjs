import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('Running Deep Verification of Slider Ranges & Settings');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failCount++;
  }
}

// Suite 1: index.html HTML Attributes
console.log('Suite 1: HTML Input Attributes');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('1.1 #setting-font-size attributes: min=12 max=48 step=1', () => {
  const match = html.match(/id=["']setting-font-size["'][^>]*min=["']12["'][^>]*max=["']48["'][^>]*step=["']1["']/);
  assert(match, 'setting-font-size must have min=12, max=48, step=1');
});

test('1.2 #setting-line-height attributes: min=1.1 max=3.0 step=0.05', () => {
  const match = html.match(/id=["']setting-line-height["'][^>]*min=["']1.1["'][^>]*max=["']3\.0["'][^>]*step=["']0\.05["']/);
  assert(match, 'setting-line-height must have min=1.1, max=3.0, step=0.05');
});

test('1.3 #setting-margin attributes: min=8 max=140 step=4', () => {
  const match = html.match(/id=["']setting-margin["'][^>]*min=["']8["'][^>]*max=["']140["'][^>]*step=["']4["']/);
  assert(match, 'setting-margin must have min=8, max=140, step=4');
});

test('1.4 #setting-max-width attributes: min=400 max=1800 step=20', () => {
  const match = html.match(/id=["']setting-max-width["'][^>]*min=["']400["'][^>]*max=["']1800["'][^>]*step=["']20["']/);
  assert(match, 'setting-max-width must have min=400, max=1800, step=20');
});

test('1.5 #setting-letter-spacing attributes: min=-1 max=5 step=0.1', () => {
  const match = html.match(/id=["']setting-letter-spacing["'][^>]*min=["']-1["'][^>]*max=["']5["'][^>]*step=["']0\.1["']/);
  assert(match, 'setting-letter-spacing must have min=-1, max=5, step=0.1');
});

test('1.6 #setting-para-margin-top attributes: min=0 max=3.0 step=0.05', () => {
  const match = html.match(/id=["']setting-para-margin-top["'][^>]*min=["']0["'][^>]*max=["']3\.0["'][^>]*step=["']0\.05["']/);
  assert(match, 'setting-para-margin-top must have min=0, max=3.0, step=0.05');
});

test('1.7 #setting-para-margin-bottom attributes: min=0 max=3.0 step=0.05', () => {
  const match = html.match(/id=["']setting-para-margin-bottom["'][^>]*min=["']0["'][^>]*max=["']3\.0["'][^>]*step=["']0\.05["']/);
  assert(match, 'setting-para-margin-bottom must have min=0, max=3.0, step=0.05');
});

// Suite 2: js/app.js Slider Sync & Number Formatting
console.log('\nSuite 2: js/app.js Slider Sync & Formatting');
const appJs = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

test('2.1 app.js updateSettingsUI uses nullish coalescing (??) for sliders', () => {
  assert(appJs.includes('this.settings.fontSize ?? 18'), 'fontSize should use ?? 18');
  assert(appJs.includes('this.settings.letterSpacing ?? 0'), 'letterSpacing should use ?? 0');
  assert(appJs.includes('this.settings.lineHeight ?? 1.6'), 'lineHeight should use ?? 1.6');
  assert(appJs.includes('this.settings.margin ?? 48'), 'margin should use ?? 48');
  assert(appJs.includes('this.settings.maxWidth ?? 760'), 'maxWidth should use ?? 760');
});

test('2.2 app.js eliminates floating precision tails on lineHeight and letterSpacing', () => {
  assert(appJs.includes('Number(Number(rawLh).toFixed(2))'), 'lineHeight in updateSettingsUI should use toFixed(2)');
  assert(appJs.includes('Number(Number(rawLs).toFixed(2))'), 'letterSpacing in updateSettingsUI should use toFixed(2)');
});

test('2.3 app.js lineHeightSlider listener parses and formats toFixed(2)', () => {
  assert(/this\.dom\.lineHeightSlider\?\.addEventListener\('input'[\s\S]*?toFixed\(2\)/.test(appJs), 'lineHeightSlider input should format with toFixed(2)');
});

test('2.4 app.js letterSpacingSlider listener parses and formats toFixed(2)', () => {
  assert(/this\.dom\.letterSpacingSlider\?\.addEventListener\('input'[\s\S]*?toFixed\(2\)/.test(appJs), 'letterSpacingSlider input should format with toFixed(2)');
});

// Suite 3: js/advanced-settings.js
console.log('\nSuite 3: js/advanced-settings.js Paragraph Spacing Formatting');
const advJs = fs.readFileSync(path.join(root, 'js/advanced-settings.js'), 'utf8');

test('3.1 advanced-settings.js formats paraMargin with toFixed(2)em', () => {
  assert(advJs.includes('toFixed(2)}em'), 'advanced-settings must format paraMargin with toFixed(2)em');
});

test('3.2 advanced-settings.js bounds contains paraMargin bounds [0, 3]', () => {
  assert(/paraMarginTop:\s*\[0,\s*3\]/.test(advJs), 'paraMarginTop bounds must be [0, 3]');
  assert(/paraMarginBottom:\s*\[0,\s*3\]/.test(advJs), 'paraMarginBottom bounds must be [0, 3]');
});

// Suite 4: js/reading-presets.js
console.log('\nSuite 4: js/reading-presets.js Extraction Fallbacks');
const presetsJs = fs.readFileSync(path.join(root, 'js/reading-presets.js'), 'utf8');

test('4.1 reading-presets.js uses Number.isFinite fallback for typography fields', () => {
  assert(presetsJs.includes('Number.isFinite(Number(settings.fontSize))'), 'fontSize must check Number.isFinite');
  assert(presetsJs.includes('Number.isFinite(Number(settings.lineHeight))'), 'lineHeight must check Number.isFinite');
  assert(presetsJs.includes('Number.isFinite(Number(settings.letterSpacing))'), 'letterSpacing must check Number.isFinite');
  assert(presetsJs.includes('Number.isFinite(Number(settings.margin))'), 'margin must check Number.isFinite');
  assert(presetsJs.includes('Number.isFinite(Number(settings.maxWidth))'), 'maxWidth must check Number.isFinite');
});

console.log('\n====================================================');
console.log(`Results: ${passCount} passed, ${failCount} failed.`);
console.log('====================================================');

if (failCount > 0) {
  process.exit(1);
}
