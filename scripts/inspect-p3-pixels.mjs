import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9505;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_inspect_p3_${Date.now()}`);
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

  const p3Base64 = fs.readFileSync('C:/Users/YONGHU/.gemini/antigravity/brain/6b833ecb-e66c-4651-a9f4-72379ea4b411/.user_uploaded/media_1792938328374_19087733.jpg').toString('base64');

  const evalRes = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        const img = new Image();
        img.src = 'data:image/jpeg;base64,${p3Base64}';
        await new Promise(r => img.onload = r);

        const w = img.width;
        const h = img.height;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Sample horizontal scanlines at y = 100, 300, 500, 700, 900
        const ySamples = [100, 300, 500, 700, 900];
        const results = {};

        for (const y of ySamples) {
          const rowData = ctx.getImageData(0, y, w, 1).data;
          // Find luminance across row
          const lums = [];
          for (let x = 0; x < w; x++) {
            const r = rowData[x * 4];
            const g = rowData[x * 4 + 1];
            const b = rowData[x * 4 + 2];
            lums.push(Math.round(0.299*r + 0.587*g + 0.114*b));
          }
          results[y] = lums;
        }

        // Also get corner color (background paper color)
        const bgData = ctx.getImageData(10, 10, 1, 1).data;
        return {
          width: w,
          height: h,
          bgColor: [bgData[0], bgData[1], bgData[2]],
          samples: results
        };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const res = evalRes.result?.value;
  console.log('p3 Info:', {
    width: res.width,
    height: res.height,
    bgColor: res.bgColor
  });

  // Let's analyze the dark dips (shadows/creases) in each scanline
  for (const [y, lums] of Object.entries(res.samples)) {
    // Find min luminance regions (shadows)
    let minLum = 255;
    let minX = -1;
    for (let x = 30; x < res.width - 30; x++) {
      if (lums[x] < minLum) {
        minLum = lums[x];
        minX = x;
      }
    }
    console.log(`y=${y}: minLum=${minLum} at x=${minX}`);
  }

  ws.close();
  proc.kill();
}

run().catch(console.error);
