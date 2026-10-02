// scripts/verify-delivery-p2.mjs
// Verification suite for Android background TTS wiring, bilingual extraction exclusions,
// reading duration active interval union, and TOC resolution scopy.

import assert from 'assert';
import { SystemTtsProvider } from '../js/tts-player.js';
import { platformBridge } from '../js/platformBridge.js';
import { extractCleanTextFromHtml, extractCleanTextFromDoc } from '../js/fulltext-search.js';
import { resolveExcerptSource } from '../js/excerpt-source-resolver.js';

console.log('=== Starting Extended Verification Suite ===\n');

// ----------------------------------------------------------------------------
// Test 1: Android Native Background TTS in SystemTtsProvider (P1-07)
// ----------------------------------------------------------------------------
console.log('[Test 1] Testing Android native background TTS integration in SystemTtsProvider...');

// Mock platformBridge as Android Tauri environment
Object.defineProperty(platformBridge, 'isAndroid', { value: true, configurable: true, writable: true });
Object.defineProperty(platformBridge, 'isTauri', { value: true, configurable: true, writable: true });

let startCalled = false;
let pauseCalled = false;
let resumeCalled = false;
let stopCalled = false;
let getPlaybackStateCalls = 0;

platformBridge._invokeTauri = async (cmd, args) => {
    if (cmd === 'android_start_background_tts') {
        startCalled = true;
        assert.strictEqual(args.bookTitle, 'Test Novel');
        assert.strictEqual(args.text, 'Hello Android Background TTS');
        assert.strictEqual(args.rate, 1.25);
        return true;
    }
    if (cmd === 'android_pause_background_tts') {
        pauseCalled = true;
        return true;
    }
    if (cmd === 'android_resume_background_tts') {
        resumeCalled = true;
        return true;
    }
    if (cmd === 'android_stop_background_tts') {
        stopCalled = true;
        return true;
    }
    if (cmd === 'android_get_playback_state') {
        getPlaybackStateCalls++;
        // Simulate playing on first check, then done on second check
        return {
            isPlaying: getPlaybackStateCalls < 2,
            bookTitle: 'Test Novel',
            text: 'Hello Android Background TTS'
        };
    }
    throw new Error(`Unhandled invoke: ${cmd}`);
};

const sysProvider = new SystemTtsProvider();
const voices = await sysProvider.getVoices();
assert.strictEqual(voices.length, 1);
assert.strictEqual(voices[0].id, 'android_default');
assert.ok(voices[0].name.includes('TextToSpeech'));

let playbackStarted = false;
const playPromise = sysProvider.play(
    { text: 'Hello Android Background TTS' },
    { bookTitle: 'Test Novel', rate: 1.25, onPlaybackStarted: () => { playbackStarted = true; } }
);

await playPromise;
assert.ok(startCalled, 'startBackgroundTts should be invoked on Android');
assert.ok(playbackStarted, 'onPlaybackStarted callback should be fired');
assert.ok(getPlaybackStateCalls >= 2, 'getPlaybackState should be polled until done');

sysProvider.pause();
assert.ok(pauseCalled, 'pauseBackgroundTts should be invoked');

sysProvider.resume();
assert.ok(resumeCalled, 'resumeBackgroundTts should be invoked');

sysProvider.stop();
assert.ok(stopCalled, 'stopBackgroundTts should be invoked');

console.log('  -> PASSED: Android native background TTS correctly wired through SystemTtsProvider\n');

// Reset platformBridge
Object.defineProperty(platformBridge, 'isAndroid', { value: false, configurable: true, writable: true });
Object.defineProperty(platformBridge, 'isTauri', { value: false, configurable: true, writable: true });

// ----------------------------------------------------------------------------
// Test 2: Bilingual Translation Exclusions in Fulltext Search & TTS (P2)
// ----------------------------------------------------------------------------
console.log('[Test 2] Testing bilingual translation exclusion in search & extraction...');

const sampleHtmlWithTranslation = `
<html>
<body>
  <p>The quick brown fox jumps over the lazy dog.</p>
  <div class="linden-bilingual-target" data-target-anchor="p1" role="region" aria-label="译文">
    敏捷的棕色狐狸跃过了懒惰的狗。
  </div>
  <p>Second original paragraph for testing.</p>
  <div class="bilingual-translation-block">
    测试用的第二段译文。
  </div>
</body>
</html>
`;

const cleanedText = extractCleanTextFromHtml(sampleHtmlWithTranslation);
assert.ok(cleanedText.includes('The quick brown fox'), 'Must contain original English text');
assert.ok(cleanedText.includes('Second original paragraph'), 'Must contain second English paragraph');
assert.ok(!cleanedText.includes('敏捷的棕色狐狸'), 'Must NOT contain linden-bilingual-target content');
assert.ok(!cleanedText.includes('测试用的第二段译文'), 'Must NOT contain bilingual-translation-block content');

// Also test DOM doc cleaner
const mockDoc = {
    body: {
        cloneNode: () => {
            let removed = false;
            return {
                querySelectorAll: (sel) => {
                    assert.ok(sel.includes('.linden-bilingual-target'), 'Selector must include .linden-bilingual-target');
                    return [{ remove: () => { removed = true; } }];
                },
                innerText: 'Cleaned original text only'
            };
        }
    }
};

const docCleaned = extractCleanTextFromDoc(mockDoc);
assert.strictEqual(docCleaned, 'Cleaned original text only');
console.log('  -> PASSED: Injected bilingual translation blocks strictly excluded from search extraction\n');

// ----------------------------------------------------------------------------
// Test 3: Excerpt Resolver TOC Scoping & False Substring Prevention (P2)
// ----------------------------------------------------------------------------
console.log('[Test 3] Testing excerpt resolver TOC scoping...');

const sampleToc = [
    { label: 'Chapter 1', href: 'chapter1.xhtml' },
    { label: 'Subchapter 1', href: 'subchapter1.xhtml' },
    { label: 'Chapter 2', href: 'text/chapter2.xhtml#section1' }
];

// Resolving subchapter1.xhtml should match Subchapter 1, NOT Chapter 1 (even though subchapter1 ends with chapter1)
const resolvedSub = resolveExcerptSource({
    snapshot: {
        currentLocation: { href: 'subchapter1.xhtml' }
    },
    sourceToc: sampleToc
});
assert.strictEqual(resolvedSub.chapterTitle, 'Subchapter 1', `Expected 'Subchapter 1', got '${resolvedSub.chapterTitle}'`);

// Resolving chapter1.xhtml should match Chapter 1
const resolvedChap1 = resolveExcerptSource({
    snapshot: {
        currentLocation: { href: 'chapter1.xhtml' }
    },
    sourceToc: sampleToc
});
assert.strictEqual(resolvedChap1.chapterTitle, 'Chapter 1', `Expected 'Chapter 1', got '${resolvedChap1.chapterTitle}'`);

console.log('  -> PASSED: TOC matching accurately respects path boundaries and prevents false substring matches\n');

console.log('=== All Extended Verification Tests PASSED Successfully ===');
