import assert from 'node:assert/strict'
import { getReadingChartScale } from '../js/stats-chart-scale.js'
import { formatAxisLabel, aggregateSessions } from '../js/stats-heatmap.js'
import { setLocale } from '../js/i18n.js'
import { getSessionDur, computeActiveSessionSeconds } from '../js/reading-data.js'
import { mergeSyncData } from '../js/sync-model.js'

let count = 0
const test = async (name, run) => { await run(); count++; console.log('[PASS]', name) }
await test('the first lazy heatmap call returns its render promise to dashboard callers', async () => {
    const facade = await import('../js/app-modules.js')
    const pending = facade.renderCalendarHeatmap(null, 2026)
    assert.equal(typeof pending?.then, 'function')
    await pending
})
await test('empty, zero, invalid and negative durations never create an axis range', () => {
    for (const data of [[], [{ minutes: 0 }], [{ minutes: -3 }, { minutes: NaN }, { minutes: Infinity }]]) {
        assert.deepEqual(getReadingChartScale(data), { hasData: false, maxMinutes: 0, midMinutes: 0, unit: 'minutes' })
    }
})
await test('short and long durations share a bounded, evenly divided scale', () => {
    assert.deepEqual(getReadingChartScale([{ minutes: 2 }]), { hasData: true, maxMinutes: 20, midMinutes: 10, unit: 'minutes' })
    assert.deepEqual(getReadingChartScale([{ minutes: 32 }]), { hasData: true, maxMinutes: 40, midMinutes: 20, unit: 'minutes' })
    assert.deepEqual(getReadingChartScale([{ minutes: 87 }]), { hasData: true, maxMinutes: 120, midMinutes: 60, unit: 'hours' })
    for (const peak of [0.5, 7, 19, 60, 61, 179, 359, 18000]) {
        const scale = getReadingChartScale([{ minutes: peak }])
        assert.ok(scale.maxMinutes >= peak)
        assert.equal(scale.maxMinutes / 2, scale.midMinutes)
    }
})
await test('axis labels use readable localized units and a consistent selected unit', () => {
    setLocale('zh-CN', { persist: false, broadcast: false, applyDom: false })
    assert.match(formatAxisLabel(30, 'hours'), /0\.5.*小时/)
    assert.match(formatAxisLabel(20, 'minutes'), /20.*分钟/)
})
await test('legacy durations remain readable while an explicit zero active duration stays zero', () => {
    assert.equal(getSessionDur({ durationSeconds: 180 }), 180)
    assert.equal(getSessionDur({ durationSeconds: 180, activeDurationSeconds: 0 }), 0)
    assert.equal(getSessionDur({ durationSeconds: 180, activeDurationSeconds: 60 }), 60)
})
await test('syncing the same legacy session cannot synthesize a zero activity duration', () => {
    const payload = seconds => ({ booksMeta: [{ id: 'b', title: 'Fixture', format: 'txt' }], readingSessions: [{ id: 'legacy', bookId: 'b', durationSeconds: seconds }], highlights: [], bookmarks: [], deletedRecords: [] })
    const session = mergeSyncData(payload(120), payload(180)).merged.readingSessions[0]
    assert.equal(session.durationSeconds, 180); assert.equal(session.activeDurationSeconds, 180)
})
await test('heatmap and overview share active seconds and the union of reading/listening intervals', () => {
    const rows = [
        { id: 'read', bookId: 'b', date: '2026-11-17', durationSeconds: 300, activeDurationSeconds: 120, activeIntervals: [[1000, 121000]] },
        { id: 'listen', bookId: 'b', date: '2026-11-17', durationSeconds: 300, activeDurationSeconds: 120, activeIntervals: [[61000, 181000]], isListening: true },
        { id: 'idle', bookId: 'b', date: '2026-11-17', durationSeconds: 999, activeDurationSeconds: 0 }
    ]
    const heatmap = aggregateSessions(rows, { targetYear: 2026 }), day = heatmap.dayMap.get('2026-11-17')
    assert.equal(computeActiveSessionSeconds(rows), 180)
    assert.equal(heatmap.totalSeconds, 180); assert.equal(day.seconds, 180); assert.equal(day.minutes, 3); assert.equal(day.bookDurationMap.get('b'), 180)
})

const stored = new Map([['linden_ai_assistant_config', JSON.stringify({ cooldownSeconds: 0, dailyLimit: 0, maxTokens: 20000 })]])
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }
const { requestAiCompletion } = await import('../js/reading-ai-assistant.js')
const oldFetch = globalThis.fetch
const frame = (value, space = true) => 'data:' + (space ? ' ' : '') + JSON.stringify(value) + '\n\n'
const textFrame = (text, space = true) => frame({ choices: [{ delta: { content: text }, finish_reason: null }] }, space)
const stopFrame = (reason, space = true) => frame({ choices: [{ delta: {}, finish_reason: reason }] }, space)
const usageFrame = frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, false)
const chunksFor = value => new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(value); for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } })
let stream
globalThis.fetch = async (_url, options) => { assert.equal(JSON.parse(options.body).max_tokens, 20000); return new Response(stream) }
const ask = async (value, onChunk = () => {}) => {
    stream = typeof value === 'string' ? chunksFor(value) : value
    return requestAiCompletion({ endpoint: 'https://local-fixture.invalid/v1', model: 'fixture', apiKey: 'local-test-only', prompt: 'fixture', returnMetadata: true, onChunk })
}
try {
    await test('valid data fields without a space, split UTF-8 and final usage all survive', async () => {
        let displayed = ''
        const result = await ask((textFrame('中文🙂', false) + stopFrame('stop', false) + usageFrame.trimEnd()).replaceAll('\n', '\r\n'), delta => displayed += delta)
        assert.equal(result.fullText, '中文🙂'); assert.equal(displayed, result.fullText)
        assert.equal(result.status, 'completed'); assert.equal(result.finishReason, 'stop'); assert.equal(result.usage.total_tokens, 5)
    })
    await test('a final text frame without a newline reaches both saved content and live UI', async () => {
        let displayed = ''
        const result = await ask(textFrame('正文') + textFrame('末尾', false).trimEnd(), delta => displayed += delta)
        assert.equal(result.fullText, '正文末尾'); assert.equal(displayed, '正文末尾'); assert.equal(result.status, 'partial')
    })
    await test('DONE finishes and releases a still-open transport without waiting for EOF', async () => {
        let cancelled = false
        const openStream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(textFrame('完成') + 'data:[DONE]\n\n')) }, cancel() { cancelled = true } })
        let timer
        try {
            const result = await Promise.race([ask(openStream), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DONE kept waiting for EOF')), 1000) })])
            assert.equal(result.status, 'completed'); assert.equal(result.fullText, '完成'); assert.equal(cancelled, true)
        } finally { clearTimeout(timer) }
    })
    await test('a token-limit finish is partial while a stop finish is completed', async () => {
        assert.equal((await ask(textFrame('未完') + stopFrame('length'))).status, 'partial')
        assert.equal((await ask(textFrame('完成') + stopFrame('stop'))).status, 'completed')
    })
    await test('unconfirmed EOF keeps partial text and usage; null usage cannot erase totals', async () => {
        const result = await ask(textFrame('保留内容') + usageFrame + frame({ choices: [], usage: null }))
        assert.equal(result.status, 'partial'); assert.equal(result.usage.total_tokens, 5); assert.equal(result.fullText, '保留内容')
    })
    await test('provider error frames fail visibly and release admission for the next request', async () => {
        await assert.rejects(ask(textFrame('已有内容') + frame({ error: { code: 503, message: 'local test server failure' } }, false)), /local test server failure/)
        assert.equal((await ask(textFrame('下一次') + 'data:[DONE]\n\n')).status, 'completed')
    })
    await test('native cancellation before headers stays cancelled even when its event arrives late', async () => {
        globalThis.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async command => {
            assert.equal(command, 'ai_request_chat_completion')
            return { stopped: true, partialText: '' }
        } } }
        try {
            const result = await requestAiCompletion({ prompt: 'local cancellation fixture', returnMetadata: true })
            assert.equal(result.status, 'cancelled'); assert.equal(result.fullText, '')
        } finally { delete globalThis.__TAURI__ }
    })
} finally { globalThis.fetch = oldFetch }
console.log(`Pre-beta hardening tests: ${count} passed; no external requests.`)
