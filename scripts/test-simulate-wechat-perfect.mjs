import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9495;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_snap_wechat_${Date.now()}`);
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
        const width = 412;
        const height = 915;
        const bgColor = '#FAF8F3';
        const textColor = '#1C1A17';

        function createPage(title, lines, isFirst) {
          const c = document.createElement('canvas');
          c.width = width; c.height = height;
          const ctx = c.getContext('2d');
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);

          // Header
          ctx.fillStyle = '#8E8A82';
          ctx.font = '14px serif';
          ctx.textAlign = 'center';
          ctx.fillText(title, width / 2, 45);

          // Body text
          ctx.fillStyle = textColor;
          ctx.font = '21px "Source Han Serif SC", "Noto Serif SC", serif';
          ctx.textAlign = 'left';
          lines.forEach((l, i) => {
            ctx.fillText(l, 32, 100 + i * 44);
          });

          // Page Number
          ctx.fillStyle = '#A09C94';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(isFirst ? '217 / 2314' : '218 / 2314', width - 36, height - 35);

          return c;
        }

        const page1 = createPage('简论》', [
          '斯宾诺莎《知性改进论》简论',
          '因为；斯宾诺莎信中提到',
          '起来，想把《知性改进论》',
          '构成的以及《神、人及其幸福',
          '中皆是为后者的导言。',
          '与我们通常信写于1662年',
          '的“注43认为《神、人',
          '章论不属于至少是在1661',
          '“那些通常被戈的。按照雪',
          '不是属于神的属性，',
          '这些误解神的属性的言论',
          '以一些貌似有理的论据',
          '神学上的无知做辩护'
        ], true);

        const page2 = createPage('简论》', [
          '激起神学家和教士们的反对',
          '绝不会容许这本书公开发行',
          '（斯宾诺莎信中提到撰写',
          '撰写好了的完整小册子',
          '人及其幸福简论》',
          '所以讲到知性的改进方法',
          '想把《知性改进论》加',
          '及其幸福简论》为后者的导言。',
          '信写于1662年',
          '人为《神、人及',
          '至少是在1661',
          '戈的。按照雪莱',
          '的意见，该书',
          '注46不久',
          '节哈特则认为',
          '即1660年',
          '撰写时间'
        ], false);

        // Render WeChat-style realistic corner curl
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Fold line: Steep diagonal corner curl (matching P3 exactly)
        const foldTopX = width * 0.35;    // Top corner pulled past middle
        const foldBottomX = width * 0.82; // Bottom right corner barely touched
        const dx = foldBottomX - foldTopX;
        const dy = height;
        const lineLen = Math.hypot(dx, dy);
        const foldAngle = Math.atan2(dy, dx);

        // Flap width: distance flap extends to the left of the fold line
        const flapWidth = width * 0.46;
        const R = 32; // Cylinder roll radius

        // 1. Layer 1: Revealed Next Page (underneath)
        ctx.drawImage(page2, 0, 0);

        // 2. Layer 2: Drop shadow onto next page
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        ctx.lineTo(width, 0);
        ctx.lineTo(width, height);
        ctx.lineTo(foldBottomX, height);
        ctx.closePath();
        ctx.clip();

        // Shadow gradient perpendicular to fold line
        const nx = dy / lineLen;
        const ny = -dx / lineLen;
        const midX = (foldTopX + foldBottomX) / 2;
        const midY = height / 2;
        const shadowDist = 65;
        const shadG = ctx.createLinearGradient(midX, midY, midX + nx * shadowDist, midY + ny * shadowDist);
        shadG.addColorStop(0, 'rgba(40, 30, 20, 0.40)');
        shadG.addColorStop(0.25, 'rgba(40, 30, 20, 0.20)');
        shadG.addColorStop(0.65, 'rgba(40, 30, 20, 0.05)');
        shadG.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = shadG;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();

        // 3. Layer 3: Unpeeled Current Page (left of fold)
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(foldTopX, 0);
        ctx.lineTo(foldBottomX, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(page1, 0, 0);
        ctx.restore();

        // 4. Layer 4: Curled Flap with Paper Reflection
        // Flap apex & edge
        const flapTopX = foldTopX - nx * flapWidth;
        const flapBottomX = foldBottomX - nx * (flapWidth * 0.55);

        // Flap edge drop shadow onto unpeeled page
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(flapTopX - 35, 0);
        ctx.lineTo(flapTopX, 0);
        ctx.quadraticCurveTo((flapTopX + flapBottomX) / 2 - 10, height * 0.5, flapBottomX, height);
        ctx.lineTo(flapBottomX - 25, height);
        ctx.quadraticCurveTo((flapTopX + flapBottomX) / 2 - 35, height * 0.5, flapTopX - 35, 0);
        ctx.closePath();
        const fEdgeShad = ctx.createLinearGradient(flapTopX - 35, 0, flapTopX, 0);
        fEdgeShad.addColorStop(0, 'rgba(0,0,0,0)');
        fEdgeShad.addColorStop(0.5, 'rgba(40, 30, 20, 0.08)');
        fEdgeShad.addColorStop(1, 'rgba(40, 30, 20, 0.26)');
        ctx.fillStyle = fEdgeShad;
        ctx.fill();
        ctx.restore();

        // Flap Path
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        // Rounded curled corner at top
        ctx.bezierCurveTo(
          foldTopX - nx * R * 1.5, -R * 0.4,
          flapTopX + R * 0.5, 0,
          flapTopX, Math.min(70, R * 1.5)
        );
        ctx.quadraticCurveTo(
          (flapTopX + flapBottomX) / 2 - 12, height * 0.5,
          flapBottomX, height
        );
        ctx.lineTo(foldBottomX, height);
        ctx.closePath();
        ctx.clip();

        // Opaque paper background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);

        // Mirrored show-through text of the curled portion
        ctx.save();
        ctx.translate(foldTopX, 0);
        ctx.rotate(foldAngle - Math.PI / 2);
        ctx.scale(-1, 1);
        ctx.rotate(-(foldAngle - Math.PI / 2));
        ctx.translate(-foldTopX, 0);
        ctx.globalAlpha = 0.14;
        ctx.drawImage(page1, 0, 0);
        ctx.restore();

        // 3D paper cylinder lighting across the flap
        const fShadG = ctx.createLinearGradient(midX, midY, midX - nx * flapWidth, midY - ny * flapWidth);
        fShadG.addColorStop(0, 'rgba(40, 30, 20, 0.32)');      // Crease fold shadow
        fShadG.addColorStop(0.16, 'rgba(40, 30, 20, 0.10)');
        fShadG.addColorStop(0.46, 'rgba(255, 255, 255, 0.28)'); // Cylinder apex highlight
        fShadG.addColorStop(0.76, 'rgba(40, 30, 20, 0.06)');
        fShadG.addColorStop(1, 'rgba(40, 30, 20, 0.18)');       // Rolled edge darkening
        ctx.fillStyle = fShadG;
        ctx.fillRect(0, 0, width, height);

        // Soft matte specular highlight line along apex ridge
        const apexTop = foldTopX - nx * R * 1.0;
        const apexBottom = foldBottomX - nx * R * 0.8;
        ctx.beginPath();
        ctx.moveTo(apexTop, 0);
        ctx.quadraticCurveTo((apexTop + apexBottom) / 2 - 8, height * 0.5, apexBottom, height);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.stroke();

        ctx.restore();

        return canvas.toDataURL('image/png');
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  const res = evalRes.result?.value;
  if (!res) {
    console.error('Eval error:', evalRes);
    ws.close();
    proc.kill();
    return;
  }

  const b64 = res.replace(/^data:image\/png;base64,/, '');
  const outPath = 'D:\\\\LindenLeaf-Dev\\\\astra-mupdf-core\\\\scripts\\\\wechat-perfect-curl.png';
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('Saved wechat-perfect-curl.png successfully!');

  ws.close();
  proc.kill();
}

run().catch(console.error);
