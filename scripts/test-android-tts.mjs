import assert from 'node:assert/strict'
import { SystemTtsProvider, TtsPlayer } from '../js/tts-player.js'
import { platformBridge } from '../js/platformBridge.js'

// Exercise production owners with a controlled native transport; no engine or
// paid service is invoked. Device audio/notifications remain separate checks.
const originalWindow = globalThis.window
const originalDocument = globalThis.document
globalThis.window = new EventTarget()
globalThis.document = Object.assign(new EventTarget(), { hidden: true })
const saved = new Map()
const stub = (key, value) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(platformBridge, key))
    Object.defineProperty(platformBridge, key, { value, configurable: true, writable: true })
}
stub('isAndroid', true); stub('isTauri', true)
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
const tick = () => new Promise(r => setTimeout(r, 0))
const event = detail => { const e = new Event('androidttsevent'); e.detail = detail; window.dispatchEvent(e) }
let count = 0
const test = async (name, fn) => { await fn(); count++; console.log('[PASS]', name) }
try {
    await test('a native error during the start call reaches the waiting provider immediately', async () => {
        const p = new SystemTtsProvider()
        stub('stopBackgroundTts', async () => true)
        stub('startBackgroundTts', async (_title, _text, _rate, owner) => {
            event({ type: 'playbackerror', jobId: owner.jobId, generation: owner.generation,
                errorCode: 'NO_TTS_ENGINE', error: 'No engine' })
            return { started: true }
        })
        await assert.rejects(p.play({ text: 'hello' }, { jobId: 'error', generation: 3 }), e => e.code === 'NO_TTS_ENGINE')
        assert.equal(p._finishNativePlayback, null)
    })
    await test('stop settles a hidden provider and stops its late native start', async () => {
        const p = new SystemTtsProvider(), start = deferred(), stops = []
        stub('startBackgroundTts', () => start.promise)
        stub('stopBackgroundTts', async owner => { stops.push(owner.jobId); return true })
        const play = p.play({ text: 'hello' }, { jobId: 'late', generation: 4 })
        p.stop()
        await play
        start.resolve({ started: true })
        await tick()
        assert.deepEqual(stops, ['late', 'late'])
        assert.equal(p._finishNativePlayback, null)
    })
    await test('a pause before queue acceptance is reconciled for the same owner', async () => {
        const p = new TtsPlayer(), start = deferred(), pauses = []
        p.generation = 5; p.segments = [{ text: 'hello' }]; p.currentIndex = 0
        p.sessionBookOwner = { bookId: 'book-A', bookTitle: 'A' }
        p.highlightSegment = () => {}; p.clearHighlight = () => {}
        stub('startBackgroundTtsQueue', () => start.promise)
        stub('pauseBackgroundTts', async owner => { pauses.push(owner.jobId); return true })
        const play = p.playAndroidNativeQueue(5)
        const jobId = p._nativeQueue.jobId
        p.pause()
        p.handleNativePlaybackEvent({ type: 'playbackstarted', jobId, generation: 5 }, false)
        assert.equal(p.state, 'paused', 'Early native start must not override the pending pause')
        start.resolve({ started: true })
        await play
        assert.equal(p.state, 'paused')
        assert.deepEqual(pauses, [jobId, jobId])
        assert.equal(Object.hasOwn(p._nativeQueue, 'pendingStartPaused'), false)
    })
    await test('pause then resume before queue acceptance preserves one pending start', async () => {
        const p = new TtsPlayer(), start = deferred()
        let restarts = 0
        p.generation = 8; p.segments = [{ text: 'hello' }]; p.currentIndex = 0
        p.sessionBookOwner = { bookId: 'book-A', bookTitle: 'A' }
        p.highlightSegment = () => {}; p.clearHighlight = () => {}
        p.play = async () => { restarts++ }
        stub('startBackgroundTtsQueue', () => start.promise)
        stub('pauseBackgroundTts', async () => false)
        stub('resumeBackgroundTts', async () => false)
        const play = p.playAndroidNativeQueue(8)
        const jobId = p._nativeQueue.jobId
        p.pause(); p.resume()
        await tick()
        assert.equal(restarts, 0)
        start.resolve({ started: true })
        await play
        p.handleNativePlaybackEvent({ type: 'playbackstarted', jobId, generation: 8 }, false)
        assert.equal(p.state, 'playing')
        // Once accepted, notification controls remain authoritative.
        p.handleNativePlaybackEvent({ type: 'playbackpaused', jobId, generation: 8 }, false)
        p.handleNativePlaybackEvent({ type: 'playbackstarted', jobId, generation: 8 }, false)
        assert.equal(p.state, 'playing')
    })
    await test('a failed pause reconciliation stops the scoped native queue', async () => {
        const p = new TtsPlayer(), start = deferred(), stops = []
        p.generation = 9; p.segments = [{ text: 'hello' }]; p.currentIndex = 0
        p.highlightSegment = () => {}; p.clearHighlight = () => {}
        stub('startBackgroundTtsQueue', () => start.promise)
        let requests = 0
        stub('pauseBackgroundTts', async () => { if (++requests > 1) throw Error('Bridge lost'); return false })
        stub('stopBackgroundTts', async owner => { stops.push(owner.jobId); return true })
        const play = p.playAndroidNativeQueue(9)
        const jobId = p._nativeQueue.jobId
        p.pause(); start.resolve({ started: true }); await play
        assert.equal(p.state, 'stopped')
        assert.equal(p._nativeQueue, null)
        assert.deepEqual(stops, [jobId])
    })
    await test('stopping a pending queue never reports its eventual response as playing', async () => {
        const p = new TtsPlayer(), start = deferred(), stops = []
        p.generation = 6; p.segments = [{ text: 'hello' }]; p.currentIndex = 0
        p.sessionBookOwner = { bookId: 'book-A', bookTitle: 'A' }
        p.highlightSegment = () => {}; p.clearHighlight = () => {}
        p.flushListeningSession = () => {}; p.syncNativeListening = async () => null
        stub('startBackgroundTtsQueue', () => start.promise)
        stub('stopBackgroundTts', async owner => { stops.push(owner.jobId); return true })
        const play = p.playAndroidNativeQueue(6)
        const jobId = p._nativeQueue.jobId
        p.stop()
        start.resolve({ started: true })
        await play
        assert.equal(p.state, 'stopped')
        assert.equal(p._nativeQueue, null)
        assert.ok(stops.length >= 1 && stops.every(id => id === jobId))
    })
} finally {
    for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(platformBridge, key, descriptor)
        else delete platformBridge[key]
    }
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
}
console.log(`${count} Android TTS lifecycle checks passed; no native build or device audio.`)
