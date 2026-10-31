import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9486;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_svg_${Date.now()}`);
  fs.mkdirSync(tempProfile, { recursive: true });

  const proc = spawn(edgeExe, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tempProfile}`,
    '--headless=new',
    '--disable-gpu',
    'about:blank'
  ]);

  await new Promise(r => setTimeout(r, 1500));

  const listRes = await fetch(`http://127.0.0.1:${debugPort}/json`);
  const list = await listRes.json();
  const page = list.find(t => t.type === 'page');
  const wsUrl = page.webSocketDebuggerUrl;

  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let reqId = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = reqId++;
    const handler = (evt) => {
      const msg = JSON.parse(evt.data.toString());
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');

  const evalRes = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        try {
          const html = '<div style="background:#FAF9F5; color:#141413; font-size:24px; padding:20px;">测试SVG渲染HTML文本</div>';
          const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
            <foreignObject width="100%" height="100%">
              <div xmlns="http://www.w3.org/1999/xhtml">\${html}</div>
            </foreignObject>
          </svg>\`;
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = 400; canvas.height = 300;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return { success: true, dataUrlLength: canvas.toDataURL().length };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  console.log('SVG ForeignObject result:', JSON.stringify(evalRes.result.value, null, 2));

  ws.close();
  proc.kill();
}

run().catch(console.error);
