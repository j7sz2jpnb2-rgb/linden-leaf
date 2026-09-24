// scripts/benchmark-clip-paired-viewport.mjs
// Real Reading Path Paired Benchmark: Viewport Clipping ON vs OFF
// Compares:
// - timeToVisibleMs (time to first rendered pixels in viewport)
// - sharpCompletionMs (time to 2.0x high-res pixels)
// - payloadBytes (bitmap data transferred and allocated)
// - memory (main process, webview2 subprocesses, total MB)

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    if (!arr || arr.length === 0) return { min: 0, median: 0, max: 0, avg: 0, raw: [] };
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const median = n % 2 === 0
        ? Math.round(((sorted[n / 2 - 1] + sorted[n / 2]) / 2) * 100) / 100
        : sorted[Math.floor(n / 2)];
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min: sorted[0],
        median,
        max: sorted[sorted.length - 1],
        avg: Math.round((sum / n) * 100) / 100,
        raw: arr
    };
}

async function main() {
    console.log('================================================================');
    console.log('Linden Leaf: Paired Viewport Clip ON vs OFF Reading Path Benchmark');
    console.log('================================================================');

    const exe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
    if (!existsSync(exe)) throw new Error(`Target exe not found: ${exe}`);
    const exeStats = statSync(exe);
    console.log(`[Target EXE] ${exe} (${(exeStats.size / 1024 / 1024).toFixed(2)} MB, ${exeStats.mtime.toISOString()})`);

    const profile = 'D:\\LindenLeaf-Data\\benchmark-env\\webview2-profile';
    const nativeCache = 'D:\\LindenLeaf-Data\\benchmark-env\\pdf-native';
    const outDir = 'D:\\LindenLeaf-Data\\benchmarks';
    mkdirSync(outDir, { recursive: true });

    const port = 9342;
    const app = spawn(exe, [], {
        env: {
            ...process.env,
            WEBVIEW2_USER_DATA_FOLDER: profile,
            LINDEN_NATIVE_CACHE_DIR: nativeCache,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        },
        stdio: 'ignore',
    });

    let ws = null;
    try {
        let endpoint;
        for (let i = 0; i < 50; i++) {
            await SLEEP(400);
            try {
                const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
                endpoint = targets.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))?.webSocketDebuggerUrl;
                if (endpoint) break;
            } catch {}
        }
        if (!endpoint) throw new Error('Could not connect to candidate CDP page');

        ws = new WebSocket(endpoint);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        let msgId = 0;
        const pending = new Map();
        ws.onmessage = event => {
            const reply = JSON.parse(event.data);
            if (reply.id && pending.has(reply.id)) {
                pending.get(reply.id)(reply);
                pending.delete(reply.id);
            }
        };

        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const next = ++msgId;
            pending.set(next, reply => reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result));
            ws.send(JSON.stringify({ id: next, method, params }));
        });

        const evaluate = async expr => {
            const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            if (res.exceptionDetails) throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
            return res.result?.value;
        };

        await send('Runtime.enable');
        await send('Page.enable');

        for (let i = 0; i < 60; i++) {
            if (await evaluate('Boolean(window.app?.dom && document.querySelector("#btn-hero-read-now"))')) break;
            await SLEEP(250);
        }

        await evaluate('document.querySelector("#btn-welcome-skip")?.click(); true');
        await SLEEP(300);

        // Check existing books in database
        const existingBooks = await evaluate(`window.db.getAllBooks()`);
        console.log(`Found ${existingBooks.length} existing books in test profile:`, existingBooks.map(b => b.title));

        const targetDocs = [
            { name: 'Fire.pdf', titleMatch: 'Fire', targetPage: 50 },
            { name: 'book-index.pdf', titleMatch: 'book-index', targetPage: 2 },
        ];

        // Ensure each target book exists or is imported
        for (const doc of targetDocs) {
            let book = existingBooks.find(b => b.title.includes(doc.titleMatch));
            if (!book) {
                console.log(`Importing ${doc.name}...`);
                const docPath = path.join('D:\\LindenLeaf-Data\\test-pdfs', doc.name);
                const buf = readFileSync(docPath);
                const b64 = buf.toString('base64');
                const importedId = await evaluate(`(async () => {
                    const bin = atob("${b64}");
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const file = new File([bytes.buffer], "${doc.name}", { type: "application/pdf" });
                    const nativePath = "${docPath.replace(/\\/g, '\\\\')}";
                    const staged = await window.platformBridge.stagePdfSource(nativePath);
                    const bookRes = await window.app.processAndSaveBook(file, undefined, nativePath, staged);
                    return typeof bookRes === 'object' && bookRes !== null ? bookRes.id : bookRes;
                })()`);
                console.log(`Imported ${doc.name} as ID ${importedId}`);
                doc.bookId = importedId;
            } else {
                doc.bookId = book.id;
                console.log(`Matched ${doc.name} to existing ID ${book.id}`);
            }
        }

        const results = {};

        for (const doc of targetDocs) {
            console.log(`\n========================================================`);
            console.log(`Testing Document: ${doc.name} (ID: ${doc.bookId}, Target Page: ${doc.targetPage})`);
            console.log(`========================================================`);

            results[doc.name] = { clipOn: [], clipOff: [] };

            // Open book in UI
            await evaluate(`window.app.openBook("${doc.bookId}")`);

            // Wait for pdfViewport ready
            for (let i = 0; i < 80; i++) {
                if (await evaluate('Boolean(window.app?.pdfViewport?.pageOffsets?.length > 0)')) break;
                await SLEEP(200);
            }

            // Set zoom to 2.0x
            await evaluate('window.app.pdfViewport.setZoom(2); true');
            await SLEEP(500);

            const runs = 3;
            for (let r = 0; r < runs; r++) {
                // Test Clip ON
                {
                    await evaluate('window.app.pdfViewport.options.enableClip = true; true');
                    await evaluate('window.app.pdfViewport._bitmapCache.clear(); window.app.pdfViewport._bitmapCacheBytes = 0; true');

                    const m = await evaluate(`(async () => {
                        const vp = window.app.pdfViewport;
                        const page = ${doc.targetPage};
                        // Jump away first to ensure clean slot state
                        vp.goToPage(page > 0 ? 0 : 1);
                        await new Promise(r => setTimeout(r, 400));

                        const t0 = performance.now();
                        vp.goToPage(page);

                        let timeToVisibleMs = null;
                        let sharpCompletionMs = null;
                        let payloadBytes = 0;

                        for (let i = 0; i < 120; i++) {
                            await new Promise(r => setTimeout(r, 16));
                            const slot = vp.activeSlots.get(page);
                            if (!slot) continue;
                            const canvases = [...slot.querySelectorAll('canvas')];
                            if (!timeToVisibleMs && canvases.length > 0) {
                                timeToVisibleMs = Math.round(performance.now() - t0);
                            }
                            if (slot._renderedScale === 2 && (slot._renderedClip || slot._renderedToken)) {
                                sharpCompletionMs = Math.round(performance.now() - t0);
                                payloadBytes = canvases.reduce((acc, c) => acc + c.width * c.height * 4, 0);
                                break;
                            }
                        }
                        const slot = vp.activeSlots.get(page);
                        const clipInfo = slot?._renderedClip;
                        return { timeToVisibleMs, sharpCompletionMs, payloadBytes, clipInfo };
                    })()`);

                    const mem = getAppMemoryBreakdown(app.pid);
                    results[doc.name].clipOn.push({ ...m, memoryMB: mem.totalMB, webview2MB: mem.webview2MB });
                    console.log(`  [Clip ON  Run ${r + 1}] Visible=${m.timeToVisibleMs}ms, Sharp=${m.sharpCompletionMs}ms, Payload=${(m.payloadBytes / 1024).toFixed(1)} KB, Clip=[top:${m.clipInfo?.top}, btm:${m.clipInfo?.bottom}], TotalMem=${mem.totalMB}MB`);
                }

                await SLEEP(300);

                // Test Clip OFF
                {
                    await evaluate('window.app.pdfViewport.options.enableClip = false; true');
                    await evaluate('window.app.pdfViewport._bitmapCache.clear(); window.app.pdfViewport._bitmapCacheBytes = 0; true');

                    const m = await evaluate(`(async () => {
                        const vp = window.app.pdfViewport;
                        const page = ${doc.targetPage};
                        vp.goToPage(page > 0 ? 0 : 1);
                        await new Promise(r => setTimeout(r, 400));

                        const t0 = performance.now();
                        vp.goToPage(page);

                        let timeToVisibleMs = null;
                        let sharpCompletionMs = null;
                        let payloadBytes = 0;

                        for (let i = 0; i < 120; i++) {
                            await new Promise(r => setTimeout(r, 16));
                            const slot = vp.activeSlots.get(page);
                            if (!slot) continue;
                            const canvases = [...slot.querySelectorAll('canvas')];
                            if (!timeToVisibleMs && canvases.length > 0) {
                                timeToVisibleMs = Math.round(performance.now() - t0);
                            }
                            if (slot._renderedScale === 2 && !slot._renderedClip) {
                                sharpCompletionMs = Math.round(performance.now() - t0);
                                payloadBytes = canvases.reduce((acc, c) => acc + c.width * c.height * 4, 0);
                                break;
                            }
                        }
                        return { timeToVisibleMs, sharpCompletionMs, payloadBytes };
                    })()`);

                    const mem = getAppMemoryBreakdown(app.pid);
                    results[doc.name].clipOff.push({ ...m, memoryMB: mem.totalMB, webview2MB: mem.webview2MB });
                    console.log(`  [Clip OFF Run ${r + 1}] Visible=${m.timeToVisibleMs}ms, Sharp=${m.sharpCompletionMs}ms, Payload=${(m.payloadBytes / 1024).toFixed(1)} KB, TotalMem=${mem.totalMB}MB`);
                }

                await SLEEP(300);
            }

            // Close reader before next book
            await evaluate('window.app.closeReader(); true');
            await SLEEP(500);
        }

        // Summary table calculation
        console.log('\n================================================================');
        console.log('Paired Benchmark Summary: Viewport Clip ON vs OFF');
        console.log('================================================================');
        const summary = {};

        for (const doc of targetDocs) {
            const on = results[doc.name].clipOn;
            const off = results[doc.name].clipOff;

            const onVisible = computeStats(on.map(x => x.timeToVisibleMs));
            const onSharp = computeStats(on.map(x => x.sharpCompletionMs));
            const onPayload = computeStats(on.map(x => x.payloadBytes));
            const onMem = computeStats(on.map(x => x.memoryMB));

            const offVisible = computeStats(off.map(x => x.timeToVisibleMs));
            const offSharp = computeStats(off.map(x => x.sharpCompletionMs));
            const offPayload = computeStats(off.map(x => x.payloadBytes));
            const offMem = computeStats(off.map(x => x.memoryMB));

            summary[doc.name] = {
                clipOn: { visible: onVisible, sharp: onSharp, payload: onPayload, memory: onMem },
                clipOff: { visible: offVisible, sharp: offSharp, payload: offPayload, memory: offMem },
                visibleDiffMs: Math.round((onVisible.median - offVisible.median) * 10) / 10,
                sharpDiffMs: Math.round((onSharp.median - offSharp.median) * 10) / 10,
                payloadReductionPct: Math.round((1 - onPayload.median / offPayload.median) * 1000) / 10,
                memoryDiffMB: Math.round((onMem.median - offMem.median) * 10) / 10,
            };

            console.log(`\nDocument: ${doc.name}`);
            console.log(`  Clip ON : TimeToVisible = ${onVisible.median}ms, SharpCompletion = ${onSharp.median}ms, Payload = ${(onPayload.median / 1024).toFixed(1)} KB, Memory = ${onMem.median} MB`);
            console.log(`  Clip OFF: TimeToVisible = ${offVisible.median}ms, SharpCompletion = ${offSharp.median}ms, Payload = ${(offPayload.median / 1024).toFixed(1)} KB, Memory = ${offMem.median} MB`);
            console.log(`  Delta   : TimeToVisible = ${summary[doc.name].visibleDiffMs}ms, Sharp = ${summary[doc.name].sharpDiffMs}ms, Payload Reduction = ${summary[doc.name].payloadReductionPct}%, Memory Delta = ${summary[doc.name].memoryDiffMB} MB`);
        }

        const outPath = path.join(outDir, 'clip-paired-comparison.json');
        writeFileSync(outPath, JSON.stringify({ meta: { exe, timestamp: new Date().toISOString() }, summary, raw: results }, null, 2));
        console.log(`\nSaved benchmark data to: ${outPath}`);

    } finally {
        ws?.close();
        app.kill();
    }
}

main().catch(err => {
    console.error('Fatal error during paired benchmark:', err);
    process.exit(1);
});
