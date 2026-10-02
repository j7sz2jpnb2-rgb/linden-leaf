import { parseTruncatedJsonArray, validateTranslationResponse } from '../js/translation-job-core.js';
import assert from 'node:assert';

// Test 1: Truncation with braces inside string
const truncatedWithBraces = `[
  {"id": "p_0", "translation": "段落一"},
  {"id": "p_1", "translation": "这是包含 {测试} 符号的段落"},
  {"id": "p_2", "translation": "第三段未完成{"
`;

const res1 = validateTranslationResponse(truncatedWithBraces, ['p_0', 'p_1', 'p_2']);
assert.equal(res1.length, 2);
assert.equal(res1[0].id, 'p_0');
assert.equal(res1[0].translation, '段落一');
assert.equal(res1[1].id, 'p_1');
assert.equal(res1[1].translation, '这是包含 {测试} 符号的段落');

// Test 2: Conflicting duplicate IDs
const conflictingJson = `[
  {"id": "p_0", "translation": "翻译A"},
  {"id": "p_0", "translation": "翻译B"},
  {"id": "p_1", "translation": "正常段落"}
]`;
const res2 = validateTranslationResponse(conflictingJson, ['p_0', 'p_1']);
assert.equal(res2.length, 1);
assert.equal(res2[0].id, 'p_1');

// Test 3: Unknown IDs ignored
const unknownJson = `[
  {"id": "p_unknown", "translation": "未知"},
  {"id": "p_0", "translation": "已知段落"}
]`;
const res3 = validateTranslationResponse(unknownJson, ['p_0']);
assert.equal(res3.length, 1);
assert.equal(res3[0].id, 'p_0');

console.log('✓ All linear-scan recovery tests passed cleanly!');
