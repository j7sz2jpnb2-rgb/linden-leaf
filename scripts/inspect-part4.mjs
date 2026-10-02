import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const candidateExe = 'D:\\LindenLeaf-Candidate\\linden-leaf.exe';
const profileDir = 'D:\\LindenLeaf-Data\\test-env-round4\\webview2-profile';
const nativeCache = 'D:\\LindenLeaf-Data\\test-env-round4\\pdf-native';
const port = 9349;

async function main() {
    const app = spawn(candidateExe, [], {
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
        for (let i = 0; i < 60; i++) {
            await SLEEP(350);
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json`);
                const targets = await res.json();
                endpoint = targets.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))?.webSocketDebuggerUrl;
                if (endpoint) break;
            } catch {}
        }
        if (!endpoint) throw new Error('No CDP endpoint');

        ws = new WebSocket(endpoint);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

        let msgId = 0;
        const pending = new Map();
        ws.onmessage = evt => {
            const reply = JSON.parse(evt.data);
            if (reply.id && pending.has(reply.id)) {
                pending.get(reply.id)(reply);
                pending.delete(reply.id);
            }
        };

        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const next = ++msgId;
            pending.set(next, r => r.error ? reject(new Error(r.error.message)) : resolve(r.result));
            ws.send(JSON.stringify({ id: next, method, params }));
        });

        const evaluate = async expr => {
            const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            if (res.exceptionDetails) throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
            return res.result?.value;
        };

        await send('Runtime.enable');
        await send('Page.enable');

        for (let i = 0; i < 50; i++) {
            if (await evaluate('Boolean(window.app?.dom)')) break;
            await SLEEP(250);
        }
        await evaluate('document.querySelector("#btn-welcome-skip")?.click(); true');
        await SLEEP(400);

        const books = await evaluate(`window.db.getAllBooks()`);
        const shibusawa = books.find(b => b.title.includes('涩泽龙彦'));
        console.log('Opening book:', shibusawa?.id, shibusawa?.title);
        await evaluate(`window.app.openBook("${shibusawa.id}")`);
        await SLEEP(1800);

        // Go to section 5 (part0004.html)
        await evaluate(`window.app.foliateView.goTo(5); true`);
        await SLEEP(1800);

        const metrics = await evaluate(`(() => {
            const renderer = window.app.foliateView?.renderer;
            const iframes = Array.from(renderer?.shadowRoot?.querySelectorAll('iframe') || []);
            const iframe = iframes[0];
            const doc = iframe?.contentDocument;
            const body = doc?.body;
            const k = doc?.querySelector('.k');
            const k1 = doc?.querySelector('.k1');
            const k2 = doc?.querySelector('.k2');
            const centers = Array.from(doc?.querySelectorAll('.center') || []);
            const img = doc?.querySelector('img');

            const toBox = el => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                return {
                    tag: el.tagName,
                    class: el.className,
                    x: r.x, y: r.y,
                    width: r.width, height: r.height,
                    top: r.top, bottom: r.bottom, left: r.left, right: r.right,
                    marginTop: cs.marginTop, marginBottom: cs.marginBottom,
                    paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
                    borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth,
                    breakInside: cs.breakInside,
                    boxSizing: cs.boxSizing
                };
            };

            const getRules = el => {
                if (!el) return [];
                const res = [];
                for (const sheet of doc.styleSheets) {
                    try {
                        for (const rule of sheet.cssRules) {
                            if (rule.selectorText && el.matches(rule.selectorText)) {
                                res.push({ selector: rule.selectorText, cssText: rule.cssText });
                            }
                        }
                    } catch(e) {}
                }
                return res;
            };

            return {
                iframeWidth: iframe?.offsetWidth,
                iframeHeight: iframe?.offsetHeight,
                docHeight: doc?.documentElement?.scrollHeight,
                docWidth: doc?.documentElement?.scrollWidth,
                columnWidth: window.getComputedStyle(doc.documentElement).columnWidth,
                columnCount: window.getComputedStyle(doc.documentElement).columnCount,
                columnGap: window.getComputedStyle(doc.documentElement).columnGap,
                body: toBox(body),
                k: toBox(k),
                k1: toBox(k1),
                k2: toBox(k2),
                centers: centers.map(toBox),
                img: toBox(img),
                rulesK: getRules(k),
                rulesK1: getRules(k1),
                rulesK2: getRules(k2),
                html: doc?.documentElement?.outerHTML
            };
        })()`);

        console.log('Metrics summary:');
        console.log('body:', metrics.body);
        console.log('k:', metrics.k);
        console.log('k1:', metrics.k1);
        console.log('k2:', metrics.k2);
        console.log('rulesK:', metrics.rulesK);
        console.log('rulesK1:', metrics.rulesK1);
        console.log('rulesK2:', metrics.rulesK2);

    } finally {
        ws?.close();
        app.kill();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
