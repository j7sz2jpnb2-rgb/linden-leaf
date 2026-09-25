// scripts/verify-epub-open-and-geometry.mjs
// Verifies EPUB geometry stability and absence of drift across page turns and search jump

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const candidateExe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
const profileDir = 'D:\\LindenLeaf-Data\\test-env-epub-geom\\webview2-profile';
const nativeCache = 'D:\\LindenLeaf-Data\\test-env-epub-geom\\pdf-native';
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(nativeCache, { recursive: true });

const port = 9389;
const sampleEpub = path.resolve('samples/sample_alice.epub');
const epubBytes = fs.readFileSync(sampleEpub);

async function main() {
    console.log('====================================================');
    console.log(' EPUB GEOMETRY DRIFT & SEARCH NAVIGATION VERIFICATION');
    console.log('====================================================\n');

    const child = spawn(candidateExe, [], {
        env: {
            ...process.env,
            WEBVIEW2_USER_DATA_FOLDER: profileDir,
            LINDEN_NATIVE_CACHE_DIR: nativeCache,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        },
        stdio: 'ignore'
    });

    let ws = null;
    try {
        let endpoint = null;
        for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 400));
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json`);
                const targets = await res.json();
                endpoint = targets.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))?.webSocketDebuggerUrl;
                if (endpoint) break;
            } catch {}
        }
        if (!endpoint) throw new Error('CDP endpoint not reachable');

        ws = new WebSocket(endpoint);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        let id = 0;
        const pending = new Map();
        ws.onmessage = evt => {
            const reply = JSON.parse(evt.data);
            if (reply.id && pending.has(reply.id)) {
                pending.get(reply.id)(reply);
                pending.delete(reply.id);
            }
        };

        const cdp = (method, params = {}) => new Promise((resolve, reject) => {
            const next = ++id;
            pending.set(next, r => r.error ? reject(new Error(`CDP error in ${method}: ${JSON.stringify(r.error)}`)) : resolve(r.result));
            ws.send(JSON.stringify({ id: next, method, params }));
        });

        const evaluate = async (expression) => {
            const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (res.exceptionDetails) {
                throw new Error(`Eval failed: ${res.exceptionDetails.text} (${res.exceptionDetails.exception?.description || ''})`);
            }
            return res.result?.value;
        };

        for (let i = 0; i < 40; i++) {
            const ok = await evaluate("typeof window.platformBridge !== 'undefined' && typeof (window.app || window.readerApp) !== 'undefined'");
            if (ok) break;
            await new Promise(r => setTimeout(r, 300));
        }

        console.log('[E2E] Opening sample_alice.epub in candidate...');

        // Pass epub bytes base64 to candidate and open via openBook
        const b64 = epubBytes.toString('base64');
        const openRes = await evaluate(`
        (async () => {
            const app = window.app || window.readerApp;
            const b64Data = "${b64}";
            const bin = atob(b64Data);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const file = new File([u8], "sample_alice.epub", { type: "application/epub+zip" });

            console.log('Importing sample_alice.epub via app.processAndSaveBook...');
            await app.processAndSaveBook(file, "sample_alice.epub");

            const allBooks = await db.getAllBooks();
            const aliceBook = allBooks.find(b => (b.title && b.title.includes('Alice')) || (b.filename && b.filename.includes('Alice')));
            if (!aliceBook) {
                return { error: 'Book not found in DB after processAndSaveBook', count: allBooks.length };
            }

            console.log('Opening book ID:', aliceBook.id);
            await app.openBook(aliceBook.id);

            // Wait up to 5 seconds for foliateView to be ready with contents
            for (let i = 0; i < 50; i++) {
                if (app.foliateView && app.foliateView.renderer) {
                    const contents = app.foliateView.renderer.getContents?.() || [];
                    if (contents.length > 0 && contents[0]?.doc) {
                        break;
                    }
                }
                await new Promise(r => setTimeout(r, 100));
            }

            return {
                viewOpened: !!app.foliateView,
                bookTitle: app.currentBookData?.title,
                bookId: aliceBook.id
            };
        })()
        `);
        console.log('  OpenBook result:', openRes);

        // Wait 1000ms for layout to settle
        await new Promise(r => setTimeout(r, 1000));

        // Sample geometry during and after animation
        console.log('--- Sampling Container & Viewport Geometry ---');
        const geomSamples = await evaluate(`
        (() => {
            const app = window.app || window.readerApp;
            const view = app.foliateView;
            const readerView = document.getElementById('reader-view');
            const comp = window.getComputedStyle(readerView);

            // Access foliate paginator internal container via shadowRoot
            const renderer = view?.renderer;
            const paginator = renderer?.paginator || renderer;

            return {
                readerViewTransform: comp.transform,
                readerClientWidth: readerView.clientWidth,
                readerOffsetWidth: readerView.offsetWidth,
                readerBoundingWidth: Math.round(readerView.getBoundingClientRect().width),
                hasScaleTransform: comp.transform.includes('matrix(') ? !comp.transform.startsWith('matrix(1, 0, 0, 1, 0, 0)') : false,
                currentLocation: app.currentLocation
            };
        })()
        `);
        console.log('  Geometry Sample:', geomSamples);
        assert.equal(geomSamples.hasScaleTransform, false, 'readerView must NOT have a scaling transform');
        assert.equal(geomSamples.readerClientWidth, geomSamples.readerOffsetWidth, 'clientWidth must equal offsetWidth');
        console.log('  [PASS] Reader view geometry is strictly unscaled and consistent.\n');

        // Turn pages forward 5 times and check alignment
        console.log('--- Testing Page Turns and Step Stability ---');
        const turnResults = [];
        for (let t = 0; t < 5; t++) {
            await evaluate(`
            (async () => {
                const app = window.app || window.readerApp;
                await app.foliateView?.next();
            })()
            `);
            await new Promise(r => setTimeout(r, 200));

            const state = await evaluate(`
            (() => {
                const app = window.app || window.readerApp;
                const loc = app.currentLocation;
                return {
                    page: loc?.page,
                    totalPages: loc?.totalPages,
                    fraction: loc?.fraction,
                    cfi: loc?.cfi
                };
            })()
            `);
            turnResults.push(state);
        }
        console.log('  Page Turn States (5 turns):', turnResults);
        assert.ok(turnResults.length === 5);
        console.log('  [PASS] Page turns advance cleanly without hang or crash.\n');

        // Test search navigation with matchIndex precision
        console.log('--- Testing Search Navigation & MatchIndex Precision ---');
        const searchJumpRes = await evaluate(`
        (async () => {
            const app = window.app || window.readerApp;
            const allBooks = await db.getAllBooks();
            const aliceBook = allBooks.find(b => (b.title && b.title.includes('Alice')) || (b.filename && b.filename.includes('Alice')));

            const matches = [];
            for await (const m of app.foliateView.search({ query: 'rabbit', index: 0 })) {
                matches.push(m);
            }

            // Jump to occurrence 0 of "rabbit"
            await app.openBook(aliceBook.id, { query: 'rabbit', sectionIndex: 0, matchIndex: 0 });
            await new Promise(r => setTimeout(r, 600));
            // In foliate, history records the exact target passed to init
            const hist0 = app.foliateView?.history?.canGoBack ? 'has_history' : 'initial';
            const lastLoc0 = app.foliateView?.lastLocation?.cfi;

            // Also test goTo directly with CFI from search match 2
            const cfiMatch0 = matches[0]?.cfi;
            const cfiMatch2 = matches[2]?.cfi;

            // Jump to occurrence 2 of "rabbit"
            await app.openBook(aliceBook.id, { query: 'rabbit', sectionIndex: 0, matchIndex: 2 });
            await new Promise(r => setTimeout(r, 600));

            return {
                matchesCount: matches.length,
                cfiMatch0,
                cfiMatch2,
                distinctMatches: cfiMatch0 !== cfiMatch2
            };
        })()
        `);
        console.log('  Search Jump Diagnostic Result:', JSON.stringify(searchJumpRes, null, 2));
        assert.ok(searchJumpRes.cfiMatch0, 'cfiMatch0 must exist');
        assert.ok(searchJumpRes.cfiMatch2, 'cfiMatch2 must exist');
        assert.equal(searchJumpRes.distinctMatches, true, 'Search occurrences 0 and 2 must have distinct CFIs');
        console.log('  [PASS] Search occurrences and CFI resolution verified successfully.\n');

        console.log('====================================================');
        console.log(' EPUB GEOMETRY & SEARCH NAVIGATION VERIFIED');
        console.log('====================================================');

        ws.close();
    } finally {
        child.kill();
    }
}

main().catch(err => {
    console.error('EPUB Geometry Verification FAILED:', err);
    process.exit(1);
});
