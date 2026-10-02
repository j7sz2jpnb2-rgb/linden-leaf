// scripts/verify-delivery-p1.mjs
// Targeted verification tests for P1 repairs: TTS, Settings Secret Sanitization, Credentials, and Build Pipeline Exit Code.

import { ttsPlayer, ApiTtsProvider } from '../js/tts-player.js';
import { AdvancedSettingsManager } from '../js/advanced-settings.js';
import assert from 'assert';

console.log('=== Starting P1 Verification Suite ===\n');

// ----------------------------------------------------------------------------
// Test 1: TTS next/prev cursor indexing & bounds check (P1-04)
// ----------------------------------------------------------------------------
console.log('[Test 1] Testing TTS next/prev cursor indexing...');

// Setup mock segments
ttsPlayer.segments = [
    { id: 'seg_0', index: 0, text: 'First paragraph test.' },
    { id: 'seg_1', index: 1, text: 'Second paragraph test.' },
    { id: 'seg_2', index: 2, text: 'Third paragraph test.' }
];

// Mock provider
let playedIndices = [];
const mockProvider = {
    play: async (seg, opts) => {
        opts?.onPlaybackStarted?.();
        playedIndices.push(seg.index);
    },
    prefetch: async () => {},
    pause: () => {},
    resume: () => {},
    stop: () => {}
};
ttsPlayer.providers.mock = mockProvider;
ttsPlayer.currentProviderName = 'mock';

ttsPlayer.currentIndex = 0;
ttsPlayer.state = 'playing';

// Advance with next()
ttsPlayer.next();
assert.strictEqual(ttsPlayer.currentIndex, 1, `Expected currentIndex=1 after next(), got ${ttsPlayer.currentIndex}`);

// Advance with next() again
ttsPlayer.next();
assert.strictEqual(ttsPlayer.currentIndex, 2, `Expected currentIndex=2 after next(), got ${ttsPlayer.currentIndex}`);

// Out of bounds next() should be ignored
ttsPlayer.next();
assert.strictEqual(ttsPlayer.currentIndex, 2, `Expected currentIndex to remain 2 at end of document`);

// Decrement with prev()
ttsPlayer.prev();
assert.strictEqual(ttsPlayer.currentIndex, 1, `Expected currentIndex=1 after prev(), got ${ttsPlayer.currentIndex}`);

// Decrement with prev() to 0
ttsPlayer.prev();
assert.strictEqual(ttsPlayer.currentIndex, 0, `Expected currentIndex=0 after prev(), got ${ttsPlayer.currentIndex}`);

// Decrement at 0 should be ignored
ttsPlayer.prev();
assert.strictEqual(ttsPlayer.currentIndex, 0, `Expected currentIndex to remain 0 at start of document`);

ttsPlayer.stop();
console.log('  -> PASSED: TTS next/prev indexing correctly advances and clamps without cursor reset to 0\n');

// ----------------------------------------------------------------------------
// Test 2: In-flight prefetch deduplication and error isolation (P1-06)
// ----------------------------------------------------------------------------
console.log('[Test 2] Testing API TTS in-flight prefetch deduplication & error caching...');

// Mock document, Blob, and URL for Node environment
let exportedJsonString = '';
global.Blob = class Blob {
    constructor(parts = []) {
        this.parts = parts;
        this.size = 1024;
        exportedJsonString = parts.join('');
    }
};
global.URL.createObjectURL = () => 'blob:mock-url';
global.URL.revokeObjectURL = () => {};
global.document = {
    createElement: () => ({
        set href(val) {},
        set download(val) {},
        click: () => {}
    }),
    body: {
        appendChild: () => {},
        removeChild: () => {}
    }
};

const apiProvider = new ApiTtsProvider();
let networkCallCount = 0;

// Mock global fetch
global.fetch = async (url, opts) => {
    networkCallCount++;
    await new Promise(r => setTimeout(r, 50));
    return {
        ok: true,
        blob: async () => new Blob(['fake audio'])
    };
};

const segA = { text: 'Prefetch deduplication test text' };
const options = { apiKey: 'mock-key', apiEndpoint: 'https://api.example.com', model: 'tts-1', voiceId: 'nova' };

// Fire two concurrent prefetches for the same segment
const p1 = apiProvider.prefetch(segA, options);
const p2 = apiProvider.prefetch(segA, options);
await Promise.all([p1, p2]);

assert.strictEqual(networkCallCount, 1, `Expected exactly 1 network call for deduplicated in-flight prefetch, got ${networkCallCount}`);
console.log(`  -> Deduplication verified: 2 concurrent prefetches resulted in exactly 1 API call`);

// Test prefetch error caching
apiProvider.clearCache();
global.fetch = async () => {
    return {
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded'
    };
};

await apiProvider.prefetch(segA, options);
assert.strictEqual(apiProvider._prefetchErrors.size, 1, 'Expected 1 cached prefetch error');

// When play() attempts to fetch the failed blob, it should reject immediately without a new network call
let threwError = false;
try {
    await apiProvider.fetchAudioBlob(segA.text, options);
} catch (e) {
    threwError = true;
    assert.match(e.message, /预取音频失败/, `Expected prefetch error message, got: ${e.message}`);
}
assert.strictEqual(threwError, true, 'Expected fetchAudioBlob to throw cached prefetch error');
console.log('  -> PASSED: In-flight prefetch deduplication & error caching prevent duplicate billing\n');

// ----------------------------------------------------------------------------
// Test 3: Settings Export Sanitization (P1-01)
// ----------------------------------------------------------------------------
console.log('[Test 3] Testing Settings Secret Sanitization...');

// Mock localStorage
const store = {};
global.localStorage = {
    getItem: (k) => store[k] || null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
};

const settings = new AdvancedSettingsManager();
settings.config.ttsApiKey = 'sk-live-secret-never-export-12345';
settings.config.apiKey = 'sk-ai-secret-key-67890';
settings.config.password = 'super_secret_webdav_pass';
settings.config.ttsProvider = 'api';
settings.config.ttsRate = 1.25;

// Export full backup
await settings.exportFullDataBackup();
const backup = JSON.parse(exportedJsonString);

assert.strictEqual(backup.config.ttsApiKey, undefined, 'Exported backup MUST NOT contain ttsApiKey');
assert.strictEqual(backup.config.apiKey, undefined, 'Exported backup MUST NOT contain apiKey');
assert.strictEqual(backup.config.password, undefined, 'Exported backup MUST NOT contain password');
assert.strictEqual(backup.config.ttsRate, 1.25, 'Exported backup should preserve safe settings');

// Export JSON settings
settings.exportSettingsJSON();
const exportedSettings = JSON.parse(exportedJsonString);
assert.strictEqual(exportedSettings.advancedSettings.ttsApiKey, undefined, 'Exported JSON MUST NOT contain ttsApiKey');
assert.strictEqual(exportedSettings.advancedSettings.apiKey, undefined, 'Exported JSON MUST NOT contain apiKey');
assert.strictEqual(exportedSettings.advancedSettings.password, undefined, 'Exported JSON MUST NOT contain password');

// Import JSON settings with malicious/leaked fields injected
const maliciousFile = {
    size: 1000,
    text: async () => JSON.stringify({
        advancedSettings: {
            ttsApiKey: 'malicious_injected_key',
            apiKey: 'malicious_api_key',
            ttsRate: 1.5,
            ttsProvider: 'system'
        }
    })
};
await settings.importSettingsJSON(maliciousFile);
assert.strictEqual(settings.config.ttsApiKey, undefined, 'Imported config MUST discard ttsApiKey');
assert.strictEqual(settings.config.apiKey, undefined, 'Imported config MUST discard apiKey');
assert.strictEqual(settings.config.ttsRate, 1.5, 'Imported config should apply safe settings');

console.log('  -> PASSED: Plaintext API keys and passwords strictly excluded from export and import\n');

// ----------------------------------------------------------------------------
// Test 4: Listening session owner retention across pause/resume (P1-05)
// ----------------------------------------------------------------------------
console.log('[Test 4] Testing TTS listening session owner retention across pause/resume...');

ttsPlayer.state = 'playing';
ttsPlayer.sessionBookOwner = {
    bookId: 'book_test_123',
    bookTitle: 'Test Book Title',
    startTimestamp: Date.now()
};

// Pause should flush session with keepOwner = true
ttsPlayer.pause();
assert.notStrictEqual(ttsPlayer.sessionBookOwner, null, 'Expected sessionBookOwner to be retained on pause');
assert.strictEqual(ttsPlayer.sessionBookOwner.bookId, 'book_test_123', 'Expected bookId to remain intact');

// Resume should keep owner and allow listening tracking to resume seamlessly
ttsPlayer.resume();
assert.strictEqual(ttsPlayer.sessionBookOwner.bookId, 'book_test_123', 'Expected bookId to remain intact after resume');

// Stop should clear owner
ttsPlayer.stop();
assert.strictEqual(ttsPlayer.sessionBookOwner, null, 'Expected sessionBookOwner to be cleared after explicit stop');
console.log('  -> PASSED: Session owner correctly preserved during pause/resume and isolated upon stop\n');

// ----------------------------------------------------------------------------
// Test 5: ApiTtsProvider endpoint origin binding & credential protection (P1-01)
// ----------------------------------------------------------------------------
console.log('[Test 5] Testing TTS credential origin binding...');

global.sessionStorage = {
    _data: {},
    getItem(k) { return this._data[k] || null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; }
};

// Store valid key and origin
global.sessionStorage.setItem('__sec_tts_api_key', 'sk-test-secret-123');
global.sessionStorage.setItem('__sec_tts_api_origin', 'https://trusted-tts.example.com');

const originTestProvider = new ApiTtsProvider();
let capturedAuthHeader = null;
global.fetch = async (url, opts) => {
    capturedAuthHeader = opts.headers?.Authorization;
    return {
        ok: true,
        blob: async () => new Blob(['fake audio'])
    };
};

// 1. Mismatched origin should NOT load or send stored key
capturedAuthHeader = null;
let originMismatchThrew = false;
try {
    await originTestProvider.fetchAudioBlob('Origin test mismatched text', {
        apiEndpoint: 'https://evil-untrusted-server.com/v1/audio/speech'
    });
} catch (e) {
    originMismatchThrew = true;
    assert.match(e.message, /未配置 TTS API Key/);
}
assert.strictEqual(originMismatchThrew, true, 'Expected origin mismatch to withhold stored API key');
assert.strictEqual(capturedAuthHeader, null, 'Authorization header MUST NOT be sent to mismatched origin');

// 2. Matching origin should send stored key
capturedAuthHeader = null;
await originTestProvider.fetchAudioBlob('Origin test matched text', {
    apiEndpoint: 'https://trusted-tts.example.com/v1/audio/speech'
});
assert.strictEqual(capturedAuthHeader, 'Bearer sk-test-secret-123', 'Matching origin should load and send stored API key');

console.log('  -> PASSED: Origin binding prevents sending credentials to changed/untrusted domains\n');

console.log('=== All P1 Verification Tests PASSED Successfully ===');
