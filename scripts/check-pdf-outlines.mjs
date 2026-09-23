import { spawn } from 'node:child_process';

const exe = 'D:\\LindenLeaf-Build\\target\\debug\\linden-leaf.exe';
const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9225',
    LINDEN_NATIVE_CACHE_DIR: 'D:\\LindenLeaf-Data\\development\\pdf-native'
};

const p = spawn(exe, [], { env, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2000));

try {
    const res = await fetch('http://127.0.0.1:9225/json');
    const list = await res.json();
    const target = list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);

    let id = 0;
    const send = (method, params) => new Promise((resolve, reject) => {
        const cur = ++id;
        const handler = e => {
            const d = JSON.parse(e.data);
            if (d.id === cur) {
                ws.removeEventListener('message', handler);
                if (d.error) reject(d.error);
                else resolve(d.result);
            }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: cur, method, params }));
    });

    const evalExpr = expr => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });

    // Wait for platformBridge
    for (let i = 0; i < 20; i++) {
        const ok = await evalExpr("typeof window.platformBridge !== 'undefined'");
        if (ok.result?.value) break;
        await new Promise(r => setTimeout(r, 300));
    }

    const result = await evalExpr(`
        (async () => {
            const files = ['outline-test.pdf', 'aa.pdf', 'Fire.pdf', 'book-index.pdf', 'sample_doc.pdf'];
            const r = {};
            for (const f of files) {
                const p = 'D:\\\\LindenLeaf-Data\\\\test-pdfs\\\\' + f;
                try {
                    const meta = await platformBridge._invokeTauri('mupdf_open_document', { filePath: p, password: null, expectedSize: null });
                    const toc = await platformBridge._invokeTauri('mupdf_get_outline_flat', { docId: meta.docId });
                    await platformBridge._invokeTauri('mupdf_close_document', { docId: meta.docId });
                    r[f] = { pages: meta.numPages, tocCount: toc?.length || 0, first: toc?.[0] || null };
                } catch (e) {
                    r[f] = { error: e.message };
                }
            }
            return r;
        })()
    `);

    console.log('PDF Outlines check:');
    console.log(JSON.stringify(result.result?.value, null, 2));

    ws.close();
} finally {
    p.kill();
}
