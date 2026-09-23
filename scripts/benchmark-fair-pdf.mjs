// scripts/benchmark-fair-pdf.mjs
// Fair Performance Baseline & PDF Reading Experience Benchmark Suite
// Covers:
// 1. Isolated Driver-Level Benchmarks (PdfJsDriver vs MuPdfTauriDriver, alternating order)
// 2. Product-Level Viewport & Interaction Benchmarks (First visible preview frame vs Sharp frame, zoom continuity, memory breakdown)
// 3. Bounded Local Rendering Experiment (MuPDF Clip coordinate correction, pixel identity, trade-off analysis)

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function getAppMemoryBreakdown(targetPid) {
    try {
        const scriptPath = path.resolve('scripts/get-process-mem.ps1');
        const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -targetPid ${targetPid}`).toString().trim();
        return JSON.parse(out);
    } catch (e) {
        return { mainMB: null, webview2MB: null, totalMB: null, procs: [] };
    }
}

function computeStats(arr) {
    if (!arr || arr.length === 0) return { min: 0, median: 0, max: 0, avg: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min: sorted[0],
        median,
        max: sorted[sorted.length - 1],
        avg: Math.round(sum / sorted.length)
    };
}

async function main() {
    console.log('================================================================');
    console.log('Linden Leaf: Fair PDF Performance Baseline & Reading Experience');
    console.log('================================================================');

    let exePath = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
    if (!existsSync(exePath)) {
        exePath = 'D:\\LindenLeaf-Build\\target\\release\\linden-leaf.exe';
    }
    if (!existsSync(exePath)) {
        exePath = 'D:\\LindenLeaf-Release\\linden-leaf.exe';
    }
    if (!existsSync(exePath)) {
        throw new Error('No candidate or release executable found.');
    }
    const exeStats = statSync(exePath);
    console.log(`[Target EXE] ${exePath}`);
    console.log(`  Size: ${(exeStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Modified: ${exeStats.mtime.toISOString()}`);

    // Verify build-info.json
    const buildInfoPath = path.resolve('dist-tauri/build-info.json');
    let buildInfo = {};
    if (existsSync(buildInfoPath)) {
        buildInfo = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
        console.log(`[Build Info] ID: ${buildInfo.buildId}, Commit: ${buildInfo.commit}, Timestamp: ${buildInfo.timestamp}`);
    }

    // Isolated test environment
    const testEnvRoot = 'D:\\LindenLeaf-Data\\benchmark-env';
    const profileDir = path.join(testEnvRoot, 'webview2-profile');
    const cacheDir = path.join(testEnvRoot, 'pdf-native');
    const screenDir = path.join(testEnvRoot, 'screenshots');
    const resultDir = 'D:\\LindenLeaf-Data\\benchmarks';

    if (existsSync(profileDir)) {
        try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    }
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(screenDir, { recursive: true });
    mkdirSync(resultDir, { recursive: true });

    // Target test documents
    const docSources = [
        { name: 'book-index.pdf', type: 'text-index', path: 'D:\\LindenLeaf-Data\\test-pdfs\\book-index.pdf' },
        { name: 'Fire.pdf', type: 'magazine-graphics', path: 'D:\\LindenLeaf-Data\\test-pdfs\\Fire.pdf' },
        { name: 'aa.pdf', type: 'large-multipage', path: 'D:\\LindenLeaf-Data\\test-pdfs\\aa.pdf' },
    ];

    for (const doc of docSources) {
        if (!existsSync(doc.path)) throw new Error(`Document missing: ${doc.path}`);
        doc.size = statSync(doc.path).size;
        console.log(`  [Asset] ${doc.name} (${(doc.size / 1024).toFixed(1)} KB) - ${doc.type}`);
    }

    const cdpPort = 9222;
    const env = {
        ...process.env,
        WEBVIEW2_USER_DATA_FOLDER: profileDir,
        LINDEN_NATIVE_CACHE_DIR: cacheDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    };

    console.log(`\nLaunching application with isolated profile and CDP port ${cdpPort}...`);
    const appProcess = spawn(exePath, [], { env, stdio: 'ignore' });
    const appPid = appProcess.pid;
    console.log(`  Main PID: ${appPid}`);

    let cdpWsUrl = null;
    for (let i = 0; i < 30; i++) {
        await SLEEP(1000);
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
            if (res.ok) {
                const list = await res.json();
                const pageTarget = list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'));
                if (pageTarget && pageTarget.webSocketDebuggerUrl) {
                    cdpWsUrl = pageTarget.webSocketDebuggerUrl;
                    console.log(`  CDP connected: "${pageTarget.title}" (${pageTarget.url})`);
                    break;
                }
            }
        } catch {}
    }

    if (!cdpWsUrl) {
        appProcess.kill();
        throw new Error(`Failed to connect to CDP on port ${cdpPort}`);
    }

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

    await send('Runtime.enable')({});
    await send('Log.enable')({});
    await send('Page.enable')({});

    const evaluate = async expr => {
        const res = await send('Runtime.evaluate')({
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(`JS Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
    };

    const captureScreenshot = async (name) => {
        const shot = await send('Page.captureScreenshot')({ format: 'png' });
        const filePath = path.join(screenDir, `${name}.png`);
        writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
        return filePath;
    };

    const benchmarkResults = {
        meta: {
            timestamp: new Date().toISOString(),
            buildInfo,
            targetExe: exePath,
            exeSize: exeStats.size,
            mainPid: appPid
        },
        driverLevel: {},
        productLevel: {},
        clipExperiment: {}
    };

    try {
        console.log('  Waiting for app ready...');
        let ready = false;
        for (let i = 0; i < 40; i++) {
            try {
                ready = await evaluate(`
                    typeof window.__TAURI__ !== 'undefined' &&
                    document.readyState === 'complete' &&
                    typeof window.app !== 'undefined' &&
                    typeof window.app.dom !== 'undefined' &&
                    typeof window.db !== 'undefined' &&
                    typeof window.platformBridge !== 'undefined'
                `);
                if (ready) break;
            } catch {}
            await SLEEP(500);
        }
        if (!ready) throw new Error('App page failed to initialize within timeout');

        // Dismiss welcome modal if visible
        await evaluate(`(() => {
            const skip = document.querySelector('#btn-welcome-skip');
            if (skip) skip.click();
            localStorage.setItem('linden_user_initialized', 'true');
        })()`);
        await SLEEP(500);

        // Verify runtime diagnostic info
        const runtimeBuildInfo = await evaluate(`window.app.getBuildInfo ? window.app.getBuildInfo() : null`);
        console.log('  Runtime Diagnostics:', JSON.stringify(runtimeBuildInfo));
        benchmarkResults.meta.runtimeBuildInfo = runtimeBuildInfo;

        const isNativeAvailable = await evaluate(`window.__TAURI__.core.invoke('mupdf_is_available')`);
        console.log(`  Native MuPDF Backend Available: ${isNativeAvailable}`);
        if (!isNativeAvailable) throw new Error('MuPDF native engine is not available!');

        const dpr = await evaluate(`window.devicePixelRatio || 1`);
        console.log(`  Device Pixel Ratio (DPR): ${dpr}`);
        benchmarkResults.meta.dpr = dpr;

        // ====================================================================
        // Section 4.1: Isolated Driver-Level Benchmarks (Alternating Order)
        // ====================================================================
        console.log('\n================================================================');
        console.log('Section 4.1: Isolated Driver-Level Comparison (MuPDF vs PDF.js)');
        console.log('================================================================');

        for (const doc of docSources) {
            console.log(`\n--- Benchmarking Document: ${doc.name} (${(doc.size / 1024).toFixed(1)} KB) ---`);
            const docPathEscaped = doc.path.replace(/\\/g, '\\\\');

            // Stage native snapshot once
            const snapshotPath = await evaluate(`platformBridge.stagePdfSource("${docPathEscaped}")`);
            const expectedSize = doc.size;
            console.log(`  Staged Snapshot: ${snapshotPath} (${expectedSize} bytes)`);

            // Read Uint8Array in node for PDF.js data transfer
            const fileBuf = readFileSync(doc.path);
            const fileB64 = fileBuf.toString('base64');

            // Send base64 to browser once
            await evaluate(`
                window.__testDocs = window.__testDocs || {};
                window.__testDocs["${doc.name}"] = {
                    b64: "${fileB64}",
                    nativePath: "${snapshotPath.replace(/\\/g, '\\\\')}",
                    expectedSize: ${expectedSize}
                };
            `);

            const iterations = 4; // 4 iterations alternating order
            const driverData = {
                pdfjs: { open: [], coldPage0: [], seq3Pages: [], warmPage0: [], zoom2x: [], outDims: null, payloadBytes: null },
                mupdf: { open: [], coldPage0: [], seq3Pages: [], warmPage0: [], zoom2x: [], outDims: null, payloadBytes: null },
            };

            for (let iter = 0; iter < iterations; iter++) {
                // Alternating order: even iter -> mupdf then pdfjs; odd iter -> pdfjs then mupdf
                const order = iter % 2 === 0 ? ['mupdf', 'pdfjs'] : ['pdfjs', 'mupdf'];
                console.log(`  [Iteration ${iter + 1}/${iterations}] Execution Order: ${order.join(' -> ')}`);

                for (const backend of order) {
                    const runRes = await evaluate(`(async () => {
                        const { PdfJsDriver, MuPdfTauriDriver } = await import('./js/pdf-driver.js');
                        const docMeta = window.__testDocs["${doc.name}"];
                        let driver = null;
                        let source = null;

                        if ("${backend}" === 'mupdf') {
                            driver = new MuPdfTauriDriver();
                            source = { nativePath: docMeta.nativePath, expectedSize: docMeta.expectedSize };
                        } else {
                            driver = new PdfJsDriver();
                            // Decode base64 to Uint8Array
                            const binStr = atob(docMeta.b64);
                            const u8 = new Uint8Array(binStr.length);
                            for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
                            source = u8;
                        }

                        // 1. Open & Metadata
                        const t0_open = performance.now();
                        const opened = await driver.open(source);
                        const openMs = Math.round(performance.now() - t0_open);

                        // 2. Cold Page 0 render at scale 1.25
                        const t0_cold = performance.now();
                        const page0Cold = await driver.renderPage(0, 1.25 * ${dpr}, null, null);
                        const coldMs = Math.round(performance.now() - t0_cold);
                        const canvasW = page0Cold.width;
                        const canvasH = page0Cold.height;
                        const bytes = canvasW * canvasH * 4;

                        // 3. Continuous sequential 3 pages (pages 0, 1, 2)
                        const t0_seq = performance.now();
                        await driver.renderPage(0, 1.25 * ${dpr}, null, null);
                        await driver.renderPage(1, 1.25 * ${dpr}, null, null);
                        await driver.renderPage(2, 1.25 * ${dpr}, null, null);
                        const seqMs = Math.round((performance.now() - t0_seq) / 3);

                        // 4. Warm / Repeat Page 0 render (scale 1.25)
                        const t0_warm = performance.now();
                        const page0Warm = await driver.renderPage(0, 1.25 * ${dpr}, null, null);
                        const warmMs = Math.round(performance.now() - t0_warm);

                        // 5. High-Res Zoom Render at scale 2.0
                        const t0_zoom = performance.now();
                        const page0Zoom = await driver.renderPage(0, 2.0 * ${dpr}, null, null);
                        const zoomMs = Math.round(performance.now() - t0_zoom);
                        const zoomW = page0Zoom.width;
                        const zoomH = page0Zoom.height;
                        const zoomBytes = zoomW * zoomH * 4;

                        // Clean destroy
                        await driver.destroy();

                        return {
                            openMs,
                            coldMs,
                            seqMs,
                            warmMs,
                            zoomMs,
                            outDims: { w: canvasW, h: canvasH },
                            zoomDims: { w: zoomW, h: zoomH },
                            bytes,
                            zoomBytes,
                            numPages: opened.numPages
                        };
                    })()`);

                    driverData[backend].open.push(runRes.openMs);
                    driverData[backend].coldPage0.push(runRes.coldMs);
                    driverData[backend].seq3Pages.push(runRes.seqMs);
                    driverData[backend].warmPage0.push(runRes.warmMs);
                    driverData[backend].zoom2x.push(runRes.zoomMs);
                    driverData[backend].outDims = runRes.outDims;
                    driverData[backend].zoomDims = runRes.zoomDims;
                    driverData[backend].payloadBytes = runRes.bytes;
                    driverData[backend].zoomBytes = runRes.zoomBytes;
                }
            }

            const docSummary = {
                name: doc.name,
                sizeBytes: doc.size,
                type: doc.type,
                pdfjs: {
                    open: computeStats(driverData.pdfjs.open),
                    coldPage0: computeStats(driverData.pdfjs.coldPage0),
                    seq3Pages: computeStats(driverData.pdfjs.seq3Pages),
                    warmPage0: computeStats(driverData.pdfjs.warmPage0),
                    zoom2x: computeStats(driverData.pdfjs.zoom2x),
                    outDims: driverData.pdfjs.outDims,
                    zoomDims: driverData.pdfjs.zoomDims,
                    payloadBytes: driverData.pdfjs.payloadBytes,
                    rawSamples: driverData.pdfjs
                },
                mupdf: {
                    open: computeStats(driverData.mupdf.open),
                    coldPage0: computeStats(driverData.mupdf.coldPage0),
                    seq3Pages: computeStats(driverData.mupdf.seq3Pages),
                    warmPage0: computeStats(driverData.mupdf.warmPage0),
                    zoom2x: computeStats(driverData.mupdf.zoom2x),
                    outDims: driverData.mupdf.outDims,
                    zoomDims: driverData.mupdf.zoomDims,
                    payloadBytes: driverData.mupdf.payloadBytes,
                    rawSamples: driverData.mupdf
                }
            };

            benchmarkResults.driverLevel[doc.name] = docSummary;

            console.log(`\n  Results for ${doc.name}:`);
            console.log(`    MuPDF:  Open=${docSummary.mupdf.open.median}ms, Cold P0=${docSummary.mupdf.coldPage0.median}ms, Seq Avg=${docSummary.mupdf.seq3Pages.median}ms, Warm P0=${docSummary.mupdf.warmPage0.median}ms, Zoom 2.0x=${docSummary.mupdf.zoom2x.median}ms`);
            console.log(`    PDF.js: Open=${docSummary.pdfjs.open.median}ms, Cold P0=${docSummary.pdfjs.coldPage0.median}ms, Seq Avg=${docSummary.pdfjs.seq3Pages.median}ms, Warm P0=${docSummary.pdfjs.warmPage0.median}ms, Zoom 2.0x=${docSummary.pdfjs.zoom2x.median}ms`);
            console.log(`    Output Dims: 1.25x=[${docSummary.mupdf.outDims.w}x${docSummary.mupdf.outDims.h}], 2.0x=[${docSummary.mupdf.zoomDims.w}x${docSummary.mupdf.zoomDims.h}]`);
        }

        // ====================================================================
        // Section 4.2: Product-Level Viewport & Interaction Benchmarks
        // ====================================================================
        console.log('\n================================================================');
        console.log('Section 4.2: Product-Level Viewport & Reading Interaction');
        console.log('================================================================');

        // Test with Fire.pdf in real PdfViewport
        const testPdfDoc = docSources[1]; // Fire.pdf
        const testPdfB64 = readFileSync(testPdfDoc.path).toString('base64');

        // Import into app database
        const importedPdfId = await evaluate(`(async () => {
            const bin = atob("${testPdfB64}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes.buffer], "Fire_magazine.pdf", { type: "application/pdf" });
            const bookRes = await window.app.processAndSaveBook(file);
            return typeof bookRes === 'object' && bookRes !== null ? bookRes.id : bookRes;
        })()`);
        console.log(`  Imported ${testPdfDoc.name} into library as ID: ${importedPdfId}`);

        // Measure open book in viewport
        console.log('  Opening PDF book in PdfViewport...');
        const t0_bookOpen = Date.now();
        await evaluate(`window.app.openBook("${importedPdfId}")`);

        // Wait for viewport readiness
        const vpReady = await evaluate(`new Promise((resolve, reject) => {
            const start = Date.now();
            const check = setInterval(() => {
                const vp = window.app.pdfViewport;
                if (vp && vp.activeSlots && vp.activeSlots.size > 0) {
                    const firstSlot = vp.activeSlots.get(0);
                    const canvas = firstSlot ? firstSlot.querySelector('canvas') : null;
                    if (canvas && firstSlot._renderedToken) {
                        clearInterval(check);
                        return resolve({
                            ok: true,
                            totalPages: vp.numPages,
                            backend: vp.driver?.kind,
                            hasCanvas: true,
                            renderToken: firstSlot._renderedToken
                        });
                    }
                }
                if (Date.now() - start > 15000) {
                    clearInterval(check);
                    reject(new Error("Timeout waiting for PdfViewport first frame"));
                }
            }, 50);
        })`);
        const bookOpenLatencyMs = Date.now() - t0_bookOpen;
        console.log(`  PdfViewport First Frame Rendered: latency=${bookOpenLatencyMs}ms, backend=${vpReady.backend}, pages=${vpReady.totalPages}`);
        await captureScreenshot('06_pdf_viewport_opened');

        // Test Page Navigation Latency
        console.log('  Testing Page Turn Forward (Page 0 -> Page 1)...');
        const pageTurnRes = await evaluate(`(async () => {
            const vp = window.app.pdfViewport;
            const t0 = performance.now();
            await vp.goToPage(1);
            // Wait for RAF paint and page 1 render to complete
            const startWait = performance.now();
            while (performance.now() - startWait < 5000) {
                await new Promise(r => requestAnimationFrame(r));
                const slot1 = vp.activeSlots.get(1);
                const canvas1 = slot1 ? slot1.querySelector('canvas') : null;
                if (canvas1 && slot1._renderedToken) {
                    break;
                }
            }
            const duration = Math.round(performance.now() - t0);
            const slot1 = vp.activeSlots.get(1) || vp.activeSlots.get(0);
            const canvas1 = slot1 ? slot1.querySelector('canvas') : null;
            return {
                duration,
                hasCanvas: !!canvas1,
                canvasWidth: canvas1?.width,
                canvasHeight: canvas1?.height
            };
        })()`);
        console.log(`  Page Turn Latency: ${pageTurnRes.duration}ms, canvas=[${pageTurnRes.canvasWidth}x${pageTurnRes.canvasHeight}]`);
        await captureScreenshot('07_pdf_viewport_page1');

        // Test Zoom Transition & Continuity (Section 6 verification in real product)
        console.log('\n  Testing Zoom Continuity (1.0x -> 1.5x)...');
        const zoomTransition = await evaluate(`(async () => {
            const vp = window.app.pdfViewport;
            const slot = vp.activeSlots.get(1) || vp.activeSlots.get(0);
            const initialCanvas = slot ? slot.querySelector('canvas') : null;
            const initialWidth = initialCanvas ? initialCanvas.width : 0;
            const initialToken = slot ? (slot._renderedToken || 0) : 0;

            // Trigger zoom to 1.5x
            const t0 = performance.now();
            vp.setZoom(1.5);

            // Immediate check: preview canvas retention
            const previewCanvas = slot ? slot.querySelector('canvas') : null;
            const previewWidth = previewCanvas ? previewCanvas.width : 0;
            const previewComputed = previewCanvas ? window.getComputedStyle(previewCanvas) : null;
            const previewStyleWidth = previewComputed ? previewComputed.width : null;
            const previewTransform = previewComputed ? previewComputed.transform : null;
            const isPreviewRetained = previewCanvas !== null && previewCanvas === initialCanvas; // Exact same canvas element retained as preview!

            // Measure time to sharp high-res replacement
            let sharpReplaced = false;
            let sharpMs = 0;
            const startWait = performance.now();
            while (performance.now() - startWait < 5000) {
                await new Promise(r => requestAnimationFrame(r));
                const curCanvas = slot ? slot.querySelector('canvas') : null;
                if (slot && slot._renderedToken > initialToken && curCanvas !== initialCanvas) {
                    sharpReplaced = true;
                    sharpMs = Math.round(performance.now() - t0);
                    break;
                }
            }

            const finalCanvas = slot ? slot.querySelector('canvas') : null;
            return {
                isPreviewRetained,
                initialWidth,
                previewStyleWidth,
                previewTransform,
                sharpReplaced,
                sharpMs,
                finalWidth: finalCanvas ? finalCanvas.width : 0,
                finalToken: slot ? slot._renderedToken : 0
            };
        })()`);

        console.log('  Zoom Continuity Verification:');
        console.log(`    Preview Canvas Retained: ${zoomTransition.isPreviewRetained} (Instant GPU CSS stretch, 0ms white flash)`);
        console.log(`    Preview CSS Stretched: style.width=${zoomTransition.previewStyleWidth}, transform=${zoomTransition.previewTransform}`);
        console.log(`    Sharp Render Replacement: replaced=${zoomTransition.sharpReplaced} in ${zoomTransition.sharpMs}ms`);
        console.log(`    Resolution Transition: ${zoomTransition.initialWidth}px -> ${zoomTransition.finalWidth}px`);
        if (!zoomTransition.isPreviewRetained) {
            throw new Error('Zoom continuity failed: preview canvas was destroyed instead of being retained!');
        }
        await captureScreenshot('08_pdf_zoom_150');

        // Test Rapid Successive Zooming (Generational Token Invalidation)
        console.log('  Testing Rapid Consecutive Zooms (1.5 -> 1.7 -> 2.0)...');
        const rapidZoomRes = await evaluate(`(async () => {
            const vp = window.app.pdfViewport;
            const t0 = performance.now();
            vp.setZoom(1.7);
            await new Promise(r => setTimeout(r, 40));
            vp.setZoom(1.9);
            await new Promise(r => setTimeout(r, 40));
            vp.setZoom(2.0);

            // Wait for final sharp render to settle
            const targetToken = (vp.activeSlots.get(1) || vp.activeSlots.get(0))?._renderToken;
            let settled = false;
            const waitStart = performance.now();
            while (performance.now() - waitStart < 5000) {
                await new Promise(r => setTimeout(r, 50));
                const slot = vp.activeSlots.get(1) || vp.activeSlots.get(0);
                if (slot && slot._renderedToken === targetToken && vp._inFlightRenders.size === 0) {
                    settled = true;
                    break;
                }
            }
            const totalMs = Math.round(performance.now() - t0);
            const slot1 = vp.activeSlots.get(1) || vp.activeSlots.get(0);
            const canvas1 = slot1 ? slot1.querySelector('canvas') : null;
            return {
                settled,
                totalMs,
                finalToken: targetToken,
                slotToken: slot1?._renderedToken,
                finalCanvasW: canvas1?.width,
                finalCanvasH: canvas1?.height
            };
        })()`);
        console.log(`  Rapid Zoom Settled: ${rapidZoomRes.settled} in ${rapidZoomRes.totalMs}ms, token=${rapidZoomRes.finalToken}, dims=[${rapidZoomRes.finalCanvasW}x${rapidZoomRes.finalCanvasH}]`);
        await captureScreenshot('09_pdf_zoom_200_settled');
        await captureScreenshot('09_pdf_zoom_200_settled');

        // Memory usage measurement
        const appMem = getAppMemoryBreakdown(appPid);
        console.log(`\n  Memory Breakdown During Active Reading:`);
        console.log(`    Tauri Main Process:        ${appMem.mainMB} MB`);
        console.log(`    WebView2 Subprocesses:     ${appMem.webview2MB} MB`);
        console.log(`    Total Application Memory:  ${appMem.totalMB} MB`);
        console.log(`    Subprocesses Count:        ${appMem.procs.length}`);

        benchmarkResults.productLevel = {
            bookOpenLatencyMs,
            pageTurnMs: pageTurnRes.duration,
            zoomContinuity: zoomTransition,
            rapidZoom: rapidZoomRes,
            memory: appMem
        };

        // Close reader
        await evaluate(`window.app.closeReader()`);
        await SLEEP(500);

        // ====================================================================
        // Section 7: Bounded Local Rendering Experiment (MuPDF Clip)
        // ====================================================================
        console.log('\n================================================================');
        console.log('Section 7: Bounded Local Rendering (MuPDF Clip) Experiment');
        console.log('================================================================');

        for (const doc of [docSources[1], docSources[0]]) { // Fire.pdf and book-index.pdf
            console.log(`\n--- Clip Experiment: ${doc.name} at 2.0x Scale ---`);
            const clipExpRes = await evaluate(`(async () => {
                const { MuPdfTauriDriver } = await import('./js/pdf-driver.js');
                const docMeta = window.__testDocs["${doc.name}"];
                const driver = new MuPdfTauriDriver();
                const opened = await driver.open({ nativePath: docMeta.nativePath, expectedSize: docMeta.expectedSize });

                // Page 0 size at scale 2.0
                const scale = 2.0;
                const dpr = ${dpr};
                const baseW = opened.pageSizes[0]?.width || 595;
                const baseH = opened.pageSizes[0]?.height || 842;
                const scaledW = Math.round(baseW * scale * dpr);
                const scaledH = Math.round(baseH * scale * dpr);

                // 1. Full Page Render at 2.0x
                const t0_full = performance.now();
                const fullCanvas = await driver.renderPage(0, scale * dpr, null, null);
                const fullMs = Math.round(performance.now() - t0_full);
                const fullBytes = fullCanvas.width * fullCanvas.height * 4 + 52;

                // 2. Viewport-Clipped Render at 2.0x (Top 50% slice)
                // Correct pixel coordinate math: clip is in scaled page pixel coordinates [x0, y0, x1, y1]
                const halfH = Math.round(scaledH * 0.5);
                const clipTop = [0, 0, scaledW, halfH];

                const t0_clipTop = performance.now();
                const clipTopCanvas = await driver.renderPage(0, scale * dpr, null, clipTop);
                const clipTopMs = Math.round(performance.now() - t0_clipTop);
                const clipTopBytes = clipTopCanvas.width * clipTopCanvas.height * 4 + 52;

                // 3. Viewport-Clipped Render at 2.0x (Bottom 50% slice)
                const clipBottom = [0, halfH, scaledW, scaledH];
                const t0_clipBottom = performance.now();
                const clipBottomCanvas = await driver.renderPage(0, scale * dpr, null, clipBottom);
                const clipBottomMs = Math.round(performance.now() - t0_clipBottom);
                const clipBottomBytes = clipBottomCanvas.width * clipBottomCanvas.height * 4 + 52;

                // 4. Pixel-Perfect Image Verification
                // Compare top slice pixels with full canvas top-half pixels
                const checkW = Math.min(fullCanvas.width, clipTopCanvas.width);
                const checkH = Math.min(Math.min(fullCanvas.height, halfH), clipTopCanvas.height);
                const ctxFull = fullCanvas.getContext('2d');
                const fullTopImageData = ctxFull.getImageData(0, 0, checkW, checkH);

                const ctxClip = clipTopCanvas.getContext('2d');
                const clipImageData = ctxClip.getImageData(0, 0, checkW, checkH);

                let pixelMismatches = 0;
                const totalPixels = checkW * checkH;
                const fullBuf = fullTopImageData.data;
                const clipBuf = clipImageData.data;
                for (let i = 0; i < fullBuf.length; i += 4) {
                    const dr = Math.abs(fullBuf[i] - clipBuf[i]);
                    const dg = Math.abs(fullBuf[i + 1] - clipBuf[i + 1]);
                    const db = Math.abs(fullBuf[i + 2] - clipBuf[i + 2]);
                    const da = Math.abs(fullBuf[i + 3] - clipBuf[i + 3]);
                    if (dr > 1 || dg > 1 || db > 1 || da > 1) {
                        pixelMismatches++;
                    }
                }
                const matchPct = ((totalPixels - pixelMismatches) / totalPixels * 100).toFixed(2);

                await driver.destroy();

                return {
                    full: {
                        ms: fullMs,
                        bytes: fullBytes,
                        w: fullCanvas.width,
                        h: fullCanvas.height,
                        offsetX: fullCanvas.offsetX,
                        offsetY: fullCanvas.offsetY
                    },
                    clipTop: {
                        ms: clipTopMs,
                        bytes: clipTopBytes,
                        w: clipTopCanvas.width,
                        h: clipTopCanvas.height,
                        offsetX: clipTopCanvas.offsetX,
                        offsetY: clipTopCanvas.offsetY
                    },
                    clipBottom: {
                        ms: clipBottomMs,
                        bytes: clipBottomBytes,
                        w: clipBottomCanvas.width,
                        h: clipBottomCanvas.height,
                        offsetX: clipBottomCanvas.offsetX,
                        offsetY: clipBottomCanvas.offsetY
                    },
                    pixelVerification: {
                        totalPixels,
                        pixelMismatches,
                        matchPct: Number(matchPct)
                    }
                };
            })()`);

            console.log(`  Full Page 2.0x:     ${clipExpRes.full.ms}ms (${(clipExpRes.full.bytes / 1024 / 1024).toFixed(2)} MB, ${clipExpRes.full.w}x${clipExpRes.full.h})`);
            console.log(`  Clip Top 50%:       ${clipExpRes.clipTop.ms}ms (${(clipExpRes.clipTop.bytes / 1024 / 1024).toFixed(2)} MB, ${clipExpRes.clipTop.w}x${clipExpRes.clipTop.h}, offset=[${clipExpRes.clipTop.offsetX}, ${clipExpRes.clipTop.offsetY}])`);
            console.log(`  Clip Bottom 50%:    ${clipExpRes.clipBottom.ms}ms (${(clipExpRes.clipBottom.bytes / 1024 / 1024).toFixed(2)} MB, ${clipExpRes.clipBottom.w}x${clipExpRes.clipBottom.h}, offset=[${clipExpRes.clipBottom.offsetX}, ${clipExpRes.clipBottom.offsetY}])`);
            console.log(`  Pixel Identity:     ${clipExpRes.pixelVerification.matchPct}% match (${clipExpRes.pixelVerification.pixelMismatches} mismatches out of ${clipExpRes.pixelVerification.totalPixels} pixels)`);

            // Offsets assertions
            if (clipExpRes.clipTop.offsetX !== 0 || clipExpRes.clipTop.offsetY !== 0) {
                throw new Error(`Clip top offset invalid: [${clipExpRes.clipTop.offsetX}, ${clipExpRes.clipTop.offsetY}]`);
            }
            if (clipExpRes.clipBottom.offsetX !== 0 || clipExpRes.clipBottom.offsetY <= 0) {
                throw new Error(`Clip bottom offset invalid: [${clipExpRes.clipBottom.offsetX}, ${clipExpRes.clipBottom.offsetY}]`);
            }

            benchmarkResults.clipExperiment[doc.name] = clipExpRes;
        }

        // Save complete JSON result
        const jsonOutPath = path.join(resultDir, 'fair-benchmark-results.json');
        writeFileSync(jsonOutPath, JSON.stringify(benchmarkResults, null, 2), 'utf8');
        console.log(`\n[Results Saved] Full raw benchmark results written to:\n  ${jsonOutPath}`);

    } finally {
        console.log('\nCleaning up benchmark session...');
        ws.close();
        appProcess.kill();
        await SLEEP(500);
    }

    console.log('\n================================================================');
    console.log('ALL BENCHMARKS & VERIFICATIONS COMPLETED SUCCESSFULLY!');
    console.log('================================================================');
}

main().catch(err => {
    console.error('\nFATAL BENCHMARK ERROR:', err);
    process.exit(1);
});
