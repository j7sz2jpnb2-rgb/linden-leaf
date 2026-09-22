// scripts/diagnose-tauri.mjs
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const exePath = path.join(rootDir, 'src-tauri', 'target', 'debug', 'linden-leaf.exe');

console.log('[diagnose] Exe path:', exePath);

const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222'
};

const child = spawn(exePath, [], {
    env,
    cwd: path.join(rootDir, 'src-tauri'),
    stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => console.log('[Tauri stdout]', d.toString().trim()));
child.stderr.on('data', d => console.log('[Tauri stderr]', d.toString().trim()));

async function waitForCDP(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await fetch('http://127.0.0.1:9222/json');
            if (res.ok) {
                const list = await res.json();
                console.log('[diagnose] Raw targets:', JSON.stringify(list, null, 2));
                // Wait until target is no longer about:blank if possible
                const ready = list.find(t => t.type === 'page' && t.url !== 'about:blank') || list.find(t => t.type === 'page');
                if (ready && ready.webSocketDebuggerUrl) return ready;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('CDP port 9222 not reachable');
}

async function run() {
    try {
        await new Promise(r => setTimeout(r, 1000));
        const target = await waitForCDP();
        console.log('[diagnose] Selected target:', target);
        // Wait another 1s for webview to load
        await new Promise(r => setTimeout(r, 1000));
        
        // Fetch targets again in case URL changed
        const res = await fetch('http://127.0.0.1:9222/json');
        const list = await res.json();
        const activeTarget = list.find(t => t.id === target.id) || target;
        console.log('[diagnose] Connecting to WS:', activeTarget.webSocketDebuggerUrl);

        const ws = new WebSocket(activeTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = () => { console.log('[diagnose] WS connected!'); resolve(); };
            ws.onerror = (e) => reject(e);
        });

        let msgId = 1;
        const pendingCallbacks = new Map();

        ws.onmessage = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.id && pendingCallbacks.has(msg.id)) {
                pendingCallbacks.get(msg.id)(msg);
                pendingCallbacks.delete(msg.id);
            }
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
                console.log(`[WebView Console ${msg.params.type}]`, args);
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                console.error('[WebView Exception]', JSON.stringify(msg.params.exceptionDetails));
            }
        };

        function send(method, params = {}) {
            return new Promise((resolve) => {
                const id = msgId++;
                pendingCallbacks.set(id, resolve);
                ws.send(JSON.stringify({ id, method, params }));
            });
        }

        await send('Runtime.enable');
        await send('Console.enable');

        await new Promise(r => setTimeout(r, 2000));

        // Check if window.app exists
        const evalApp = await send('Runtime.evaluate', {
            expression: `({ url: window.location.href, hasApp: !!window.app, hasPlatformBridge: !!window.platformBridge })`,
            returnByValue: true
        });
        console.log('[diagnose] Global objects:', evalApp.result?.result?.value);

        // Test opening test_user_book.epub
        console.log('[diagnose] Executing book load in WebView2...');
        const loadResult = await send('Runtime.evaluate', {
            expression: `
                (async () => {
                    try {
                        const filePath = 'C:\\\\Users\\\\Administrator\\\\.gemini\\\\antigravity\\\\scratch\\\\test_user_book.epub';
                        const buf = await window.platformBridge.readFileBuffer(filePath);
                        const fileObj = new File([buf], 'test_user_book.epub', { type: 'application/epub+zip' });
                        const app = window.app;
                        if (!app) return { error: 'window.app not found' };
                        const bookId = await app.processAndSaveBook(fileObj);
                        console.log('[diagnose] Book saved with ID:', bookId);
                        await app.openBook(bookId);
                        console.log('[diagnose] app.openBook call resolved');
                        return { success: true, bookId };
                    } catch (e) {
                        console.error('[diagnose] Book load error:', e.message, e.stack);
                        return { error: e.message, stack: e.stack };
                    }
                })()
            `,
            awaitPromise: true,
            returnByValue: true
        });
        console.log('[diagnose] Load result:', loadResult.result?.result?.value);

        await new Promise(r => setTimeout(r, 5000));

        // Check reader DOM state
        const readerState = await send('Runtime.evaluate', {
            expression: `
                (() => {
                    const foliate = document.querySelector('foliate-view');
                    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
                        src: f.src,
                        vis: f.style.visibility,
                        disp: f.style.display,
                        docReady: f.contentDocument?.readyState,
                        bodyHtml: f.contentDocument?.body?.innerHTML?.slice(0, 200),
                        docHtml: f.contentDocument?.documentElement?.outerHTML?.slice(0, 200),
                    }));
                    return {
                        readerDisplay: document.getElementById('reader-view')?.style?.display,
                        hasFoliate: !!foliate,
                        iframes,
                        readerPageNumber: document.getElementById('reader-page-number')?.innerText,
                        readerEta: document.getElementById('reader-eta-badge')?.innerText,
                        progressVal: document.getElementById('reader-progress-slider')?.value,
                    };
                })()
            `,
            returnByValue: true
        });
        console.log('[diagnose] Reader State:', JSON.stringify(readerState.result?.result?.value, null, 2));

        ws.close();
    } catch (e) {
        console.error('[diagnose] Error:', e);
    } finally {
        child.kill();
        console.log('[diagnose] Finished and killed process.');
    }
}

run();
