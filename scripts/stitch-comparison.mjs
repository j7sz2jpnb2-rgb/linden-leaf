import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9520;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_stitch_${Date.now()}`);
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

  const p3B64 = fs.readFileSync('C:/Users/YONGHU/.gemini/antigravity/brain/6b833ecb-e66c-4651-a9f4-72379ea4b411/.user_uploaded/media_1792938328374_19087733.jpg').toString('base64');
  const newB64 = fs.readFileSync('D:/LindenLeaf-Dev/astra-mupdf-core/scripts/curl-case1-next-top.png').toString('base64');

  const evalRes = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        const loadImg = (b64, type) => new Promise(res => {
          const img = new Image();
          img.onload = () => res(img);
          img.src = 'data:image/' + type + ';base64,' + b64;
        });

        const imgP3 = await loadImg('${p3B64}', 'jpeg');
        const imgNew = await loadImg('${newB64}', 'png');

        const targetH = 915;
        const wP3 = Math.round(imgP3.width * (targetH / imgP3.height));
        const wNew = Math.round(imgNew.width * (targetH / imgNew.height));

        const canvas = document.createElement('canvas');
        canvas.width = wP3 + wNew + 30;
        canvas.height = targetH + 60;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#222222';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Titles
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('微信读书原图 (标杆 p3)', wP3 / 2 + 10, 36);
        ctx.fillText('最新实测真实渲染 (Linden Leaf)', wP3 + 20 + wNew / 2, 36);

        // Images
        ctx.drawImage(imgP3, 10, 50, wP3, targetH);
        ctx.drawImage(imgNew, wP3 + 20, 50, wNew, targetH);

        return canvas.toDataURL('image/png');
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const b64 = evalRes.result?.value?.replace(/^data:image\/png;base64,/, '');
  if (b64) {
    fs.writeFileSync('C:\\Users\\YONGHU\\Desktop\\微信读书对标实测对比图-最新.png', Buffer.from(b64, 'base64'));
    fs.writeFileSync('C:\\Users\\YONGHU\\.gemini\\antigravity\\brain\\6b833ecb-e66c-4651-a9f4-72379ea4b411\\wechat-comparison-curl.png', Buffer.from(b64, 'base64'));
    console.log('Saved side-by-side comparison successfully!');
  }

  ws.close();
  proc.kill();
}

run().catch(console.error);
