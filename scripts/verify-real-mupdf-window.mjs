// scripts/verify-real-mupdf-window.mjs
// Real Tauri WebView2 Window verification for MuPDF native engine.
// Connects via Chrome DevTools Protocol (CDP) to measure and verify actual desktop execution.

import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function getProcessMemoryMB(pid) {
    try {
        const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64"`).toString().trim();
        const bytes = Number(out);
        return bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
    } catch {
        return null;
    }
}

async function main() {
    console.log('====================================================');
    console.log('Linden Leaf: Real Tauri Window MuPDF Verification');
    console.log('====================================================');

    const exePath = 'D:\\LindenLeaf-Build\\target\\debug\\linden-leaf.exe';
    if (!existsSync(exePath)) {
        throw new Error('Executable not found: ' + exePath);
    }

    // 1. Launch Tauri app with remote debugging port
    console.log('\n[Phase 1] Launching real Tauri debug executable with CDP port 9222...');
    const env = {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
        LINDEN_NATIVE_CACHE_DIR: 'D:\\LindenLeaf-Data\\development\\pdf-native',
    };

    const appProcess = spawn(exePath, [], { env, stdio: 'ignore' });
    console.log(`  App PID: ${appProcess.pid}`);

    let cdpWsUrl = null;
    for (let i = 0; i < 25; i++) {
        await SLEEP(1000);
        try {
            const res = await fetch('http://127.0.0.1:9222/json');
            if (res.ok) {
                const list = await res.json();
                const pageTarget = list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'));
                if (pageTarget && pageTarget.webSocketDebuggerUrl) {
                    cdpWsUrl = pageTarget.webSocketDebuggerUrl;
                    console.log(`  CDP connected: ${pageTarget.title} (${pageTarget.url})`);
                    break;
                }
            }
        } catch {}
    }

    if (!cdpWsUrl) {
        appProcess.kill();
        throw new Error('Failed to connect to WebView2 CDP on port 9222');
    }

    // 2. Setup WebSocket client
    const ws = new WebSocket(cdpWsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data);
            pending.delete(data.id);
        }
    };

    const send = method => params => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, res => {
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async expr => {
        const res = await send('Runtime.evaluate')({
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || 'Evaluation error');
        }
        return res.result?.value;
    };

    await send('Runtime.enable')({});

    try {
        // Wait for page load and Tauri injection
        console.log('  Waiting for page navigation and Tauri injection...');
        let ready = false;
        for (let i = 0; i < 40; i++) {
            try {
                ready = await evaluate(`
                    typeof window.__TAURI__ !== 'undefined' &&
                    document.readyState === 'complete' &&
                    typeof window.platformBridge !== 'undefined' &&
                    typeof window.app !== 'undefined' &&
                    typeof window.db !== 'undefined'
                `);
                if (ready) break;
            } catch {}
            await SLEEP(500);
        }
        if (!ready) {
            throw new Error('Page failed to become ready');
        }
        console.log('  App and database fully initialized.');
        console.log(`  Initial RSS Memory: ${getProcessMemoryMB(appProcess.pid)} MB`);

        // 3. Verify Tauri backend availability
        console.log('\n[Phase 2] Verifying MuPDF runtime backend availability in window...');
        const tauriAvailable = await evaluate(`typeof window.__TAURI__ !== 'undefined'`);
        console.log(`  window.__TAURI__ available: ${tauriAvailable}`);

        const mupdfAvailable = await evaluate(`window.__TAURI__.core.invoke('mupdf_is_available')`);
        console.log(`  mupdf_is_available() returned: ${mupdfAvailable}`);
        if (!mupdfAvailable) {
            throw new Error('Assertion failed: mupdf_is_available() did not return true!');
        }

        // 4. Test Book 1: book-index.pdf
        console.log('\n[Phase 3] Testing Book 1: book-index.pdf (592 KB, text index document)...');
        const test1Source = 'D:\\LindenLeaf-Data\\test-pdfs\\book-index.pdf';
        const test1Copy = 'D:\\LindenLeaf-Data\\test-pdfs\\test-temp-book1.pdf';
        copyFileSync(test1Source, test1Copy);

        const book1Result = await evaluate(`
            (async () => {
                const filePath = "${test1Copy.replace(/\\/g, '\\\\')}";
                const stagedPath = await platformBridge.stagePdfSource(filePath);
                const buf = await platformBridge.readFileBuffer(stagedPath);
                const fileObj = new File([buf], "test-temp-book1.pdf", { type: "application/pdf" });
                
                const t0_import = performance.now();
                const bookId = await app.processAndSaveBook(fileObj, undefined, filePath, stagedPath);
                const importMs = Math.round(performance.now() - t0_import);

                const t0_open = performance.now();
                await app.openBook(bookId);
                const openMs = Math.round(performance.now() - t0_open);

                await new Promise(r => setTimeout(r, 200));

                const driver = app.pdfDriver;
                const kind = driver?.kind;
                const docId = driver?.backend?.docId;
                const numPages = driver?.backend?.numPages || 0;
                
                return { bookId, kind, docId, numPages, stagedPath, importMs, openMs };
            })()
        `);

        console.log(`  Imported bookId: ${book1Result.bookId} (import: ${book1Result.importMs} ms, open: ${book1Result.openMs} ms)`);
        console.log(`  Driver kind: ${book1Result.kind} (Expected: 'mupdf')`);
        console.log(`  Native docId: ${book1Result.docId}`);
        console.log(`  Page count: ${book1Result.numPages}`);
        if (book1Result.kind !== 'mupdf') throw new Error(`Assertion failed: Expected driver kind 'mupdf', got '${book1Result.kind}'`);

        // Rendering, Page turns, Zoom, Selection on Book 1
        const book1Ops = await evaluate(`
            (async () => {
                const driver = app.pdfDriver;

                // Page 1 render
                const t0_p0 = performance.now();
                const canvas0 = await driver.renderPage(0, 1.25);
                const p0Ms = Math.round(performance.now() - t0_p0);

                // Sequential flips (pages 1..3)
                const flips = [];
                for (let p = 1; p <= 3; p++) {
                    const t0 = performance.now();
                    await driver.renderPage(p, 1.25);
                    flips.push(Math.round(performance.now() - t0));
                }

                // 2.0x Zoom render
                const t0_zoom = performance.now();
                const canvasZoom = await driver.renderPage(0, 2.0);
                const zoomMs = Math.round(performance.now() - t0_zoom);

                // Text layer & selection
                const textLayer = await driver.getTextLayer(0);
                const sel = await driver.select(0, [50, 100], [500, 300], 'word');

                return {
                    p0: { width: canvas0.width, height: canvas0.height, ms: p0Ms },
                    flips,
                    zoom: { width: canvasZoom.width, height: canvasZoom.height, ms: zoomMs },
                    spansCount: textLayer?.spans?.length || 0,
                    selLength: sel?.text?.length || 0,
                    selSample: sel?.text?.slice(0, 50) || ''
                };
            })()
        `);

        console.log(`  Page 1 (1.25x): ${book1Ops.p0.width}x${book1Ops.p0.height} in ${book1Ops.p0.ms} ms`);
        console.log(`  Pages 2-4 flips: ${book1Ops.flips.join(', ')} ms (avg ${Math.round(book1Ops.flips.reduce((a,b)=>a+b)/book1Ops.flips.length)} ms)`);
        console.log(`  Zoom 2.0x: ${book1Ops.zoom.width}x${book1Ops.zoom.height} in ${book1Ops.zoom.ms} ms`);
        console.log(`  Text layer spans: ${book1Ops.spansCount}`);
        console.log(`  Text selection: ${book1Ops.selLength} chars ("${book1Ops.selSample.trim()}")`);
        console.log(`  Current Process Memory: ${getProcessMemoryMB(appProcess.pid)} MB`);

        // Snapshot isolation test on Book 1
        console.log('\n[Phase 4] Testing Snapshot Isolation on Book 1 (deleting original file)...');
        unlinkSync(test1Copy);
        console.log(`  Deleted disk file: ${test1Copy}`);

        const book1Reopen = await evaluate(`
            (async () => {
                await app.closeReader();
                await new Promise(r => setTimeout(r, 200));
                await app.openBook("${book1Result.bookId}");
                await new Promise(r => setTimeout(r, 200));
                const driver = app.pdfDriver;
                const canvas = await driver.renderPage(0, 1.25);
                return {
                    kind: driver?.kind,
                    rendered: canvas.width > 0 && canvas.height > 0,
                    width: canvas.width,
                    height: canvas.height
                };
            })()
        `);
        console.log(`  Reopened after source deleted: kind=${book1Reopen.kind}, canvas=${book1Reopen.width}x${book1Reopen.height}`);
        if (book1Reopen.kind !== 'mupdf' || !book1Reopen.rendered) {
            throw new Error('Assertion failed: Snapshot isolation broken!');
        }

        // Outline extraction test on outline-test.pdf
        console.log('\n[Phase 5] Testing Document Outline / TOC extraction on outline-test.pdf...');
        const outlineTest = await evaluate(`
            (async () => {
                const p = 'D:\\\\LindenLeaf-Data\\\\test-pdfs\\\\outline-test.pdf';
                const meta = await platformBridge._invokeTauri('mupdf_open_document', { filePath: p, password: null, expectedSize: null });
                const toc = await platformBridge._invokeTauri('mupdf_get_outline_flat', { docId: meta.docId });
                await platformBridge._invokeTauri('mupdf_close_document', { docId: meta.docId });
                return { count: toc?.length || 0, items: toc || [] };
            })()
        `);
        console.log(`  TOC items extracted: ${outlineTest.count}`);
        outlineTest.items.forEach(it => {
            console.log(`    - [Level ${it.level}] "${it.title}" -> Page ${it.page}`);
        });
        if (outlineTest.count !== 2) {
            throw new Error(`Assertion failed: Expected 2 TOC items, got ${outlineTest.count}`);
        }

        // Test Book 2: Fire.pdf (3.54 MB, 456 pages)
        console.log('\n[Phase 6] Testing Book 2: Fire.pdf (3.54 MB, 456 pages document)...');
        const test2Source = 'D:\\LindenLeaf-Data\\test-pdfs\\Fire.pdf';
        const test2Copy = 'D:\\LindenLeaf-Data\\test-pdfs\\test-temp-fire.pdf';
        copyFileSync(test2Source, test2Copy);

        const book2Result = await evaluate(`
            (async () => {
                await app.closeReader();
                await new Promise(r => setTimeout(r, 200));

                const filePath = "${test2Copy.replace(/\\/g, '\\\\')}";
                const stagedPath = await platformBridge.stagePdfSource(filePath);
                const buf = await platformBridge.readFileBuffer(stagedPath);
                const fileObj = new File([buf], "test-temp-fire.pdf", { type: "application/pdf" });

                const t0_import = performance.now();
                const bookId = await app.processAndSaveBook(fileObj, undefined, filePath, stagedPath);
                const importMs = Math.round(performance.now() - t0_import);

                const t0_open = performance.now();
                await app.openBook(bookId);
                const openMs = Math.round(performance.now() - t0_open);

                await new Promise(r => setTimeout(r, 200));

                const driver = app.pdfDriver;
                const kind = driver?.kind;
                const docId = driver?.backend?.docId;
                const numPages = driver?.backend?.numPages || 0;

                // Page 1 render
                const t0_p0 = performance.now();
                const canvas0 = await driver.renderPage(0, 1.25);
                const p0Ms = Math.round(performance.now() - t0_p0);

                // Sequential flips (pages 1..4)
                const flips = [];
                for (let p = 1; p <= 4; p++) {
                    const t0 = performance.now();
                    await driver.renderPage(p, 1.25);
                    flips.push(Math.round(performance.now() - t0));
                }

                // 2.0x Zoom
                const t0_zoom = performance.now();
                const canvasZoom = await driver.renderPage(0, 2.0);
                const zoomMs = Math.round(performance.now() - t0_zoom);

                // Text layer & selection
                const textLayer = await driver.getTextLayer(0);
                const sel = await driver.select(0, [100, 100], [500, 400], 'word');

                return {
                    bookId, kind, docId, numPages, stagedPath, importMs, openMs,
                    p0: { width: canvas0.width, height: canvas0.height, ms: p0Ms },
                    flips,
                    zoom: { width: canvasZoom.width, height: canvasZoom.height, ms: zoomMs },
                    spansCount: textLayer?.spans?.length || 0,
                    selLength: sel?.text?.length || 0,
                    selSample: sel?.text?.slice(0, 50) || ''
                };
            })()
        `);

        console.log(`  Imported bookId: ${book2Result.bookId} (import: ${book2Result.importMs} ms, open: ${book2Result.openMs} ms)`);
        console.log(`  Driver kind: ${book2Result.kind} (Expected: 'mupdf')`);
        console.log(`  Native docId: ${book2Result.docId}`);
        console.log(`  Page count: ${book2Result.numPages}`);
        console.log(`  Page 1 (1.25x): ${book2Result.p0.width}x${book2Result.p0.height} in ${book2Result.p0.ms} ms`);
        console.log(`  Pages 2-5 flips: ${book2Result.flips.join(', ')} ms (avg ${Math.round(book2Result.flips.reduce((a,b)=>a+b)/book2Result.flips.length)} ms)`);
        console.log(`  Zoom 2.0x: ${book2Result.zoom.width}x${book2Result.zoom.height} in ${book2Result.zoom.ms} ms`);
        console.log(`  Text layer spans: ${book2Result.spansCount}`);
        console.log(`  Text selection: ${book2Result.selLength} chars ("${book2Result.selSample.trim()}")`);
        console.log(`  Current Process Memory: ${getProcessMemoryMB(appProcess.pid)} MB`);

        if (existsSync(test2Copy)) unlinkSync(test2Copy);

        // 7. Comparative Benchmarks (MuPDF vs PDF.js) on both documents
        console.log('\n[Phase 7] Comparative Performance Benchmark: MuPDF vs PDF.js...');
        const benchmark = await evaluate(`
            (async () => {
                const { PdfJsDriver } = await import('./js/pdf-driver.js');

                // 1. Benchmark on book-index.pdf (592 KB)
                const snap1 = await db.getBookFileSnapshot("${book1Result.bookId}");
                await app.openBook("${book1Result.bookId}");
                await new Promise(r => setTimeout(r, 200));

                const mupdf1Times = [];
                for (let i = 0; i < 3; i++) {
                    const t0 = performance.now();
                    await app.pdfDriver.renderPage(0, 1.25);
                    mupdf1Times.push(Math.round(performance.now() - t0));
                }
                const t0_mupdf1_zoom = performance.now();
                await app.pdfDriver.renderPage(0, 2.0);
                const mupdf1ZoomMs = Math.round(performance.now() - t0_mupdf1_zoom);

                const pdfjs1 = new PdfJsDriver();
                const t0_pdfjs1_open = performance.now();
                await pdfjs1.open(snap1.blob);
                const pdfjs1OpenMs = Math.round(performance.now() - t0_pdfjs1_open);

                const pdfjs1Times = [];
                for (let i = 0; i < 3; i++) {
                    const t0 = performance.now();
                    await pdfjs1.renderPage(0, 1.25);
                    pdfjs1Times.push(Math.round(performance.now() - t0));
                }
                const t0_pdfjs1_zoom = performance.now();
                await pdfjs1.renderPage(0, 2.0);
                const pdfjs1ZoomMs = Math.round(performance.now() - t0_pdfjs1_zoom);
                pdfjs1.destroy();

                // 2. Benchmark on Fire.pdf (3.54 MB)
                const snap2 = await db.getBookFileSnapshot("${book2Result.bookId}");
                await app.openBook("${book2Result.bookId}");
                await new Promise(r => setTimeout(r, 200));

                const mupdf2Times = [];
                for (let i = 0; i < 3; i++) {
                    const t0 = performance.now();
                    await app.pdfDriver.renderPage(0, 1.25);
                    mupdf2Times.push(Math.round(performance.now() - t0));
                }
                const t0_mupdf2_zoom = performance.now();
                await app.pdfDriver.renderPage(0, 2.0);
                const mupdf2ZoomMs = Math.round(performance.now() - t0_mupdf2_zoom);

                const pdfjs2 = new PdfJsDriver();
                const t0_pdfjs2_open = performance.now();
                await pdfjs2.open(snap2.blob);
                const pdfjs2OpenMs = Math.round(performance.now() - t0_pdfjs2_open);

                const pdfjs2Times = [];
                for (let i = 0; i < 3; i++) {
                    const t0 = performance.now();
                    await pdfjs2.renderPage(0, 1.25);
                    pdfjs2Times.push(Math.round(performance.now() - t0));
                }
                const t0_pdfjs2_zoom = performance.now();
                await pdfjs2.renderPage(0, 2.0);
                const pdfjs2ZoomMs = Math.round(performance.now() - t0_pdfjs2_zoom);
                pdfjs2.destroy();

                return {
                    book1: {
                        name: 'book-index.pdf (592 KB, 40 pages)',
                        mupdf: { renders: mupdf1Times, zoom2x: mupdf1ZoomMs },
                        pdfjs: { openMs: pdfjs1OpenMs, renders: pdfjs1Times, zoom2x: pdfjs1ZoomMs }
                    },
                    book2: {
                        name: 'Fire.pdf (3.54 MB, 456 pages)',
                        mupdf: { renders: mupdf2Times, zoom2x: mupdf2ZoomMs },
                        pdfjs: { openMs: pdfjs2OpenMs, renders: pdfjs2Times, zoom2x: pdfjs2ZoomMs }
                    }
                };
            })()
        `);

        console.log('\n  [Benchmark Summary]');
        console.log(`  --- Document 1: ${benchmark.book1.name} ---`);
        console.log(`    MuPDF 1.25x renders: ${benchmark.book1.mupdf.renders.join(', ')} ms (avg ${Math.round(benchmark.book1.mupdf.renders.reduce((a,b)=>a+b)/3)} ms)`);
        console.log(`    PDF.js 1.25x renders: ${benchmark.book1.pdfjs.renders.join(', ')} ms (avg ${Math.round(benchmark.book1.pdfjs.renders.reduce((a,b)=>a+b)/3)} ms) | open: ${benchmark.book1.pdfjs.openMs} ms`);
        console.log(`    MuPDF 2.0x zoom: ${benchmark.book1.mupdf.zoom2x} ms | PDF.js 2.0x zoom: ${benchmark.book1.pdfjs.zoom2x} ms`);

        console.log(`\n  --- Document 2: ${benchmark.book2.name} ---`);
        console.log(`    MuPDF 1.25x renders: ${benchmark.book2.mupdf.renders.join(', ')} ms (avg ${Math.round(benchmark.book2.mupdf.renders.reduce((a,b)=>a+b)/3)} ms)`);
        console.log(`    PDF.js 1.25x renders: ${benchmark.book2.pdfjs.renders.join(', ')} ms (avg ${Math.round(benchmark.book2.pdfjs.renders.reduce((a,b)=>a+b)/3)} ms) | open: ${benchmark.book2.pdfjs.openMs} ms`);
        console.log(`    MuPDF 2.0x zoom: ${benchmark.book2.mupdf.zoom2x} ms | PDF.js 2.0x zoom: ${benchmark.book2.pdfjs.zoom2x} ms`);
        console.log(`  Final Process Memory: ${getProcessMemoryMB(appProcess.pid)} MB`);

        // Close app cleanly
        await evaluate(`app.closeReader()`);
        console.log('\n====================================================');
        console.log('ALL REAL WINDOW MUPDF VERIFICATION SCENARIOS PASSED!');
        console.log('====================================================');

    } finally {
        ws.close();
        appProcess.kill();
        await SLEEP(1000);
    }
}

main().catch(err => {
    console.error('\nVerification FAILED:', err);
    process.exit(1);
});
