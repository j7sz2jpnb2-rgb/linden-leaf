// scripts/diagnose-two-pdfs.mjs
// Diagnoses the 3-stage OCR / text pipeline on the two test PDFs using Candidate EXE:
// 1. D:\书\剑桥大学人类学十五讲 ([英] 马泰·坎迪亚 主编) (Z-Library).pdf
// 2. D:\书\迷影(创发一种观看的方法书写一段文化的历史1944-1968)新迷影丛书 (安托万·德巴克) (Z-Library).pdf

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const candidateExe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
const profileDir = 'D:\\LindenLeaf-Data\\test-env-ocr-diag\\webview2-profile';
const nativeCache = 'D:\\LindenLeaf-Data\\test-env-ocr-diag\\pdf-native';
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(nativeCache, { recursive: true });

const port = 9369;

const pdfCambridge = 'D:\\书\\剑桥大学人类学十五讲 ([英] 马泰·坎迪亚 主编) (Z-Library).pdf';
const pdfMiying = 'D:\\书\\迷影(创发一种观看的方法书写一段文化的历史1944-1968)新迷影丛书 (安托万·德巴克) (Z-Library).pdf';

const cambridgeSize = fs.statSync(pdfCambridge).size;
const miyingSize = fs.statSync(pdfMiying).size;

console.log('[diagnose-two-pdfs] File sizes:', { cambridgeSize, miyingSize });

async function main() {
    console.log('[diagnose-two-pdfs] Starting candidate at port', port);
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
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 400));
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json`);
                const targets = await res.json();
                endpoint = targets.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))?.webSocketDebuggerUrl;
                if (endpoint) break;
            } catch {}
        }
        if (!endpoint) throw new Error('CDP not reachable');

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

        // Wait for platformBridge
        for (let i = 0; i < 30; i++) {
            const ok = await evaluate("typeof window.platformBridge !== 'undefined'");
            if (ok) break;
            await new Promise(r => setTimeout(r, 300));
        }

        console.log('[diagnose-two-pdfs] App ready. Running diagnosis...');

        const testScript = `
        (async () => {
            const results = {};
            const pdfs = [
                { name: '剑桥人类学', path: ${JSON.stringify(pdfCambridge)}, size: ${cambridgeSize}, testPages: [1, 5] },
                { name: '迷影', path: ${JSON.stringify(pdfMiying)}, size: ${miyingSize}, testPages: [1, 5] }
            ];

            for (const item of pdfs) {
                results[item.name] = { path: item.path, size: item.size, stages: {} };
                let stagedPath = null;
                try {
                    // Stage PDF source into native cache
                    stagedPath = await window.platformBridge.stagePdfSource(item.path);
                    results[item.name].stagedPath = stagedPath;
                    if (!stagedPath) {
                        results[item.name].error = 'stagePdfSource returned null';
                        continue;
                    }

                    // Open via MuPDF Tauri command with stagedPath and expectedSize
                    const meta = await window.platformBridge._invokeTauri('mupdf_open_document', {
                        filePath: stagedPath,
                        password: null,
                        expectedSize: item.size
                    });
                    const docId = meta.docId;
                    results[item.name].numPages = meta.numPages;
                    results[item.name].defaultWidth = meta.defaultWidth;
                    results[item.name].defaultHeight = meta.defaultHeight;
                    results[item.name].title = meta.title;

                    for (const pageNum of item.testPages) {
                        const pIdx = pageNum - 1;
                        const pageRes = {};

                        // Stage 1: Geometry (bounds)
                        try {
                            const bounds = await window.platformBridge._invokeTauri('mupdf_get_page_bounds_range', {
                                docId,
                                startPage: pIdx,
                                count: 1
                            });
                            pageRes.geometry = bounds?.[0] || null;
                        } catch (e) {
                            pageRes.geometryError = e.message;
                        }

                        // Stage 2: Embedded Text Layer
                        try {
                            const layer = await window.platformBridge._invokeTauri('mupdf_get_text_layer', {
                                docId,
                                pageIndex: pIdx
                            });
                            const charCount = (layer?.spans || []).reduce((acc, s) => acc + (s.text ? s.text.length : 0), 0);
                            pageRes.textLayerCharCount = charCount;
                            pageRes.spanCount = layer?.spans?.length || 0;
                            pageRes.hasEmbeddedText = charCount > 5;
                            // Record sample text snippet (first 30 chars for verification)
                            const sampleText = (layer?.spans || []).map(s => s.text || '').join('').slice(0, 30);
                            pageRes.samplePreview = sampleText ? (sampleText.slice(0, 10) + '...') : '(none)';
                        } catch (e) {
                            pageRes.textLayerError = e.message;
                        }

                        // Stage 3: Full Page Canvas Render via mupdf_render_page
                        try {
                            const t0 = performance.now();
                            const scale = 1.5;
                            const renderRes = await window.platformBridge._invokeTauri('mupdf_render_page', {
                                docId,
                                pageIndex: pIdx,
                                scale,
                                requestId: 'diag_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)
                            });
                            const renderTimeMs = Math.round(performance.now() - t0);
                            pageRes.renderTimeMs = renderTimeMs;

                            // Decode LLP2 packet to check dimensions and non-empty pixels
                            let width = 0, height = 0, nonEmptyRatio = 0;
                            if (renderRes) {
                                const u8 = new Uint8Array(renderRes);
                                if (u8.length >= 16) {
                                    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
                                    width = dv.getUint32(4, true);
                                    height = dv.getUint32(8, true);
                                    const pixels = new Uint8Array(u8.buffer, u8.byteOffset + 16);
                                    let nonEmpty = 0;
                                    const total = width * height;
                                    for (let p = 0; p < pixels.length; p += 4) {
                                        const r = pixels[p], g = pixels[p+1], b = pixels[p+2], a = pixels[p+3];
                                        if (a > 20 && (r < 240 || g < 240 || b < 240)) {
                                            nonEmpty++;
                                        }
                                    }
                                    nonEmptyRatio = total > 0 ? +(nonEmpty / total).toFixed(4) : 0;
                                }
                            }
                            pageRes.renderedWidth = width;
                            pageRes.renderedHeight = height;
                            pageRes.nonEmptyRatio = nonEmptyRatio;
                        } catch (e) {
                            pageRes.renderError = e.message;
                        }

                        results[item.name].stages['page_' + pageNum] = pageRes;
                    }

                    await window.platformBridge._invokeTauri('mupdf_close_document', { docId });
                } catch (err) {
                    results[item.name].error = err.message || String(err);
                } finally {
                    if (stagedPath) {
                        await window.platformBridge.reclaimSnapshot(stagedPath).catch(() => {});
                    }
                }
            }

            return results;
        })()
        `;

        const diagResult = await evaluate(testScript);
        console.log('[diagnose-two-pdfs] Result:');
        console.log(JSON.stringify(diagResult, null, 2));

        ws.close();
    } finally {
        child.kill();
    }
}

main().catch(err => {
    console.error('[diagnose-two-pdfs] Error:', err);
    process.exit(1);
});
