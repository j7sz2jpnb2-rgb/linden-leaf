import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9506;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_inspect_p3_profile_${Date.now()}`);
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

        // Let's inspect along y = 350 (no text on flap, pure paper)
        // Check pixel values every 10 pixels from x=0 to x=w
        const y = 350;
        const row = [];
        for (let x = 0; x < w; x += 10) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          row.push({ x, rgb: [pixel[0], pixel[1], pixel[2]] });
        }

        // Top curl boundary along y=0 to y=150
        const topCurl = [];
        for (let ty = 0; ty <= 150; ty += 10) {
          // find where flap edge is
          for (let tx = 0; tx < 200; tx += 5) {
            const p = ctx.getImageData(tx, ty, 1, 1).data;
            if (p[0] < 200) { // shadow or edge
              topCurl.push({ ty, tx, rgb: [p[0], p[1], p[2]] });
              break;
            }
          }
        }

        return { row350: row, topCurl };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const res = evalRes.result?.value;
  console.log('Row 350 profile:');
  for (const item of res.row350) {
    console.log(`x=${item.x}: rgb=(${item.rgb.join(',')})`);
  }

  ws.close();
  proc.kill();
}

run().catch(console.error);
