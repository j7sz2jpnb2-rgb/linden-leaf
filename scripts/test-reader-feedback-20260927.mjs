import assert from 'node:assert/strict'
import { requestAiCompletion } from '../js/reading-ai-assistant.js'
import { makeTXT } from '../foliate-js-main/txt.js'
import { ChapterTranslationManager } from '../js/chapter-translation-manager.js'
import { AdvancedSettingsManager } from '../js/advanced-settings.js'

const values = new Map([
    ['linden_advanced_settings_config', JSON.stringify({ aiCooldownSeconds: 0, aiDailyLimit: 0 })],
    ['linden_ai_assistant_config', JSON.stringify({ cooldownSeconds: 0, dailyLimit: 0 })]
])
globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
}

const requests = []
globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return {
        ok: true,
        json: async () => ({
            choices: [{ message: { content: '尚未完结的回答' }, finish_reason: 'length' }],
            usage: { total_tokens: 2048 }
        })
    }
}

const metadata = await requestAiCompletion({
    endpoint: 'https://example.test/v1', model: 'test-model', apiKey: 'test-key',
    prompt: '解释这一段', maxTokens: 2048, returnMetadata: true
})
assert.equal(metadata.fullText, '尚未完结的回答')
assert.equal(metadata.finishReason, 'length')
assert.equal(metadata.usage.total_tokens, 2048)
assert.equal(requests[0].max_tokens, 2048)

const legacyText = await requestAiCompletion({
    endpoint: 'https://example.test/v1', model: 'test-model', apiKey: 'test-key',
    prompt: '另一段解释'
})
assert.equal(legacyText, '尚未完结的回答')

const source = '第一章 真实章节\n真实正文第一行\n第二章 下一章节\n'
const book = await makeTXT(new File([source], '真实样本.txt', { type: 'text/plain' }))
assert.deepEqual(book.tocPreviewLines.slice(0, 3), source.trimEnd().split('\n'))
book.destroy()

const previewResult = { style: {}, innerText: '' }
globalThis.document = { getElementById: id => id === 'txt-rules-test-result' ? previewResult : null }
const advanced = Object.create(AdvancedSettingsManager.prototype)
advanced.app = { foliateView: null }
advanced.config = { txtCustomRulesEnable: true, txtRegexPattern: '^第.+章', txtRegexFlags: 'i', txtGroupIndex: 0 }
await advanced.testTxtRulesOnCurrentBook()
assert.match(previewResult.innerText, /请先打开 TXT 图书/)
assert.doesNotMatch(previewResult.innerText, /风雪山神庙|梁山泊/)
delete globalThis.document

const translation = new ChapterTranslationManager()
translation.cachedRecord = { status: 'partial', paragraphs: [{ id: 'p_0', translation: '已存译文' }] }
let resumePrompts = 0
translation.openConfirmModal = () => { resumePrompts++ }
translation.handleToolbarClick()
assert.equal(resumePrompts, 1, 'partially translated chapters must offer a resume path')

console.log('AI finish reason, real TXT preview, empty-book preview, and translation resume checks passed')
