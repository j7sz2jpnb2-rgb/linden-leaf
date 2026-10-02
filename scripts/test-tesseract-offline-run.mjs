// scripts/test-tesseract-offline-run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const candidateExe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
const profileDir = 'D:\\LindenLeaf-Data\\test-env-ocr-offline\\webview2-profile';
const nativeCache = 'D:\\LindenLeaf-Data\\test-env-ocr-offline\\pdf-native';
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(nativeCache, { recursive: true });

const port = 9371;

async function main() {
    console.log('[test-tesseract-offline-run] Starting candidate at port', port);
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
            const ok = await evaluate("typeof window.platformBridge !== 'undefined' && typeof window.Tesseract !== 'undefined'");
            if (ok) break;
            await new Promise(r => setTimeout(r, 300));
        }

        console.log('[test-tesseract-offline-run] Ready. Testing Tesseract worker initialization...');

        const testScript = `
        (async () => {
            const logs = [];
            const result = { success: false };
            try {
                const t0 = performance.now();
                // Test worker creation with local assets
                const worker = await Tesseract.createWorker(['chi_sim', 'eng'], 1, {
                    workerPath: './vendor/tesseract/worker.min.js',
                    corePath: './vendor/tesseract',
                    langPath: './vendor/tesseract/tessdata',
                    workerBlobURL: false,
                    logger: (m) => logs.push(m.status + ' (' + Math.round((m.progress || 0) * 100) + '%)')
                });

                result.workerInitTimeMs = Math.round(performance.now() - t0);

                // Create a small test canvas with text "Hello 123"
                const canvas = document.createElement('canvas');
                canvas.width = 300;
                canvas.height = 80;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, 300, 80);
                ctx.fillStyle = '#000000';
                ctx.font = '28px sans-serif';
                ctx.fillText('Hello 123', 20, 50);

                const t1 = performance.now();
                const ocrRes = await worker.recognize(canvas);
                result.recognizeTimeMs = Math.round(performance.now() - t1);
                result.recognizedText = ocrRes.data?.text?.trim() || '';

                await worker.terminate();
                result.success = true;
            } catch (e) {
                result.error = e.message || String(e);
            }
            result.logs = logs.slice(0, 10);
            return result;
        })()
        `;

        const testRes = await evaluate(testScript);
        console.log('[test-tesseract-offline-run] Result:');
        console.log(JSON.stringify(testRes, null, 2));

        ws.close();
    } finally {
        child.kill();
    }
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
