// scripts/diagnose-two-pdfs-more.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const candidateExe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
const profileDir = 'D:\\LindenLeaf-Data\\test-env-ocr-diag2\\webview2-profile';
const nativeCache = 'D:\\LindenLeaf-Data\\test-env-ocr-diag2\\pdf-native';
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(nativeCache, { recursive: true });

const port = 9370;

const pdfCambridge = 'D:\\书\\剑桥大学人类学十五讲 ([英] 马泰·坎迪亚 主编) (Z-Library).pdf';
const pdfMiying = 'D:\\书\\迷影(创发一种观看的方法书写一段文化的历史1944-1968)新迷影丛书 (安托万·德巴克) (Z-Library).pdf';

const cambridgeSize = fs.statSync(pdfCambridge).size;
const miyingSize = fs.statSync(pdfMiying).size;

async function main() {
    console.log('[diagnose-two-pdfs-more] Starting candidate at port', port);
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

        for (let i = 0; i < 30; i++) {
            const ok = await evaluate("typeof window.platformBridge !== 'undefined'");
            if (ok) break;
            await new Promise(r => setTimeout(r, 300));
        }

        const testScript = `
        (async () => {
            const results = {};
            const pdfs = [
                { name: '剑桥人类学', path: ${JSON.stringify(pdfCambridge)}, size: ${cambridgeSize}, testPages: [1, 2, 5, 10, 15, 20] },
                { name: '迷影', path: ${JSON.stringify(pdfMiying)}, size: ${miyingSize}, testPages: [1, 2, 5, 6, 7, 10, 15, 20] }
            ];

            // Dynamically import PDF.js to test PDF.js extraction on same pages
            let pdfjsLib = null;
            try {
                pdfjsLib = await import('./foliate-js-main/vendor/pdfjs/pdf.mjs');
                if (pdfjsLib.GlobalWorkerOptions) {
                    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./foliate-js-main/vendor/pdfjs/pdf.worker.mjs', location.href).toString();
                }
            } catch (e) {
                results.pdfjsImportError = e.message;
            }

            for (const item of pdfs) {
                results[item.name] = { path: item.path, size: item.size, pages: {} };
                let stagedPath = null;
                let docId = null;
                let pdfjsDoc = null;

                try {
                    stagedPath = await window.platformBridge.stagePdfSource(item.path);
                    const meta = await window.platformBridge._invokeTauri('mupdf_open_document', {
                        filePath: stagedPath,
                        password: null,
                        expectedSize: item.size
                    });
                    docId = meta.docId;
                    results[item.name].numPages = meta.numPages;

                    // Also load with PDF.js via arrayBuffer from staged file
                    if (pdfjsLib) {
                        try {
                            const buf = await window.platformBridge.readFileBuffer(stagedPath);
                            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
                            pdfjsDoc = await loadingTask.promise;
                        } catch (pErr) {
                            results[item.name].pdfjsLoadError = pErr.message;
                        }
                    }

                    for (const pageNum of item.testPages) {
                        const pIdx = pageNum - 1;
                        const pageRes = {};

                        // 1. MuPDF text layer
                        try {
                            const layer = await window.platformBridge._invokeTauri('mupdf_get_text_layer', { docId, pageIndex: pIdx });
                            const chars = (layer?.spans || []).reduce((acc, s) => acc + (s.text ? s.text.length : 0), 0);
                            pageRes.mupdfCharCount = chars;
                            if (chars > 0) {
                                pageRes.mupdfSample = (layer?.spans || []).map(s => s.text || '').join('').slice(0, 40);
                            }
                        } catch (e) {
                            pageRes.mupdfError = e.message;
                        }

                        // 2. PDF.js text content
                        if (pdfjsDoc) {
                            try {
                                const page = await pdfjsDoc.getPage(pageNum);
                                const textContent = await page.getTextContent();
                                const items = textContent?.items || [];
                                const pdfjsChars = items.reduce((acc, it) => acc + (it.str ? it.str.length : 0), 0);
                                pageRes.pdfjsCharCount = pdfjsChars;
                                if (pdfjsChars > 0) {
                                    pageRes.pdfjsSample = items.map(it => it.str).join('').slice(0, 40);
                                }
                            } catch (e) {
                                pageRes.pdfjsError = e.message;
                            }
                        }

                        // 3. Render page dimensions and non-empty pixel ratio
                        try {
                            const renderRes = await window.platformBridge._invokeTauri('mupdf_render_page', {
                                docId,
                                pageIndex: pIdx,
                                scale: 1.0,
                                requestId: 'diag_' + pageNum
                            });
                            if (renderRes) {
                                const u8 = new Uint8Array(renderRes);
                                if (u8.length >= 16) {
                                    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
                                    const w = dv.getUint32(4, true);
                                    const h = dv.getUint32(8, true);
                                    const px = new Uint8Array(u8.buffer, u8.byteOffset + 16);
                                    let nonEmpty = 0;
                                    const total = w * h;
                                    for (let p = 0; p < px.length; p += 4) {
                                        const r = px[p], g = px[p+1], b = px[p+2], a = px[p+3];
                                        if (a > 20 && (r < 240 || g < 240 || b < 240)) nonEmpty++;
                                    }
                                    pageRes.renderWidth = w;
                                    pageRes.renderHeight = h;
                                    pageRes.nonEmptyRatio = total > 0 ? +(nonEmpty / total).toFixed(4) : 0;
                                }
                            }
                        } catch (e) {
                            pageRes.renderError = e.message;
                        }

                        results[item.name].pages['page_' + pageNum] = pageRes;
                    }
                } catch (err) {
                    results[item.name].error = err.message;
                } finally {
                    if (docId) await window.platformBridge._invokeTauri('mupdf_close_document', { docId }).catch(() => {});
                    if (stagedPath) await window.platformBridge.reclaimSnapshot(stagedPath).catch(() => {});
                }
            }

            return results;
        })()
        `;

        const diagResult = await evaluate(testScript);
        console.log('[diagnose-two-pdfs-more] Result:');
        console.log(JSON.stringify(diagResult, null, 2));

        ws.close();
    } finally {
        child.kill();
    }
}

main().catch(err => {
    console.error('[diagnose-two-pdfs-more] Error:', err);
    process.exit(1);
});
