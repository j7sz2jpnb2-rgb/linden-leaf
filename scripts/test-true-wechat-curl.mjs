import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9510;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_test_wechat_${Date.now()}`);
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
        const width = 458;
        const height = 1024;
        const bgColor = '#F5EFD9'; // Exact WeChat paper color from P3
        const textColor = '#1C1A17';

        function createPage(title, lines, pageNumStr) {
          const c = document.createElement('canvas');
          c.width = width; c.height = height;
          const ctx = c.getContext('2d');
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);

          // Header
          ctx.fillStyle = '#8E8A82';
          ctx.font = '16px serif';
          ctx.textAlign = 'center';
          ctx.fillText(title, width / 2, 55);

          // Body text - matching exact lines in P3
          ctx.fillStyle = textColor;
          ctx.font = '24px "Source Han Serif SC", "Noto Serif SC", serif';
          ctx.textAlign = 'left';
          lines.forEach((l, i) => {
            ctx.fillText(l, 36, 120 + i * 50);
          });

          // Page Number
          ctx.fillStyle = '#A09C94';
          ctx.font = '16px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(pageNumStr, width - 40, height - 40);

          return c;
        }

        const page1 = createPage('简论》', [
          '斯宾诺莎《知性改进论》简论',
          '因为；斯宾诺莎信中提到',
          '起来，想把《知性改进论》加',
          '构成的以及《神、人及其幸福',
          '中皆是为后者的导言。',
          '与我们通常信写于1662年',
          '的“注43认为《神、人及',
          '章论不属于至少是在1661',
          '“那些通常被戈的。按照雪',
          '不是属于神的属性，',
          '这些误解神的属性的言论',
          '以一些貌似有理的论据',
          '神学上的无知做辩护'
        ], '217 / 2314');

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
          '戈的。按照雪的',
          '的意见，该书',
          '注46不久',
          '节哈特则认为',
          '即1660年',
          '撰写时间'
        ], '218 / 2314');

        // Target Canvas
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Geometry: Matching P3 exact coordinates!
        // Crease line: from (x=135, y=0) to (x=320, y=height)
        const foldTopX = 135;
        const foldBottomX = 320;
        const dx = foldBottomX - foldTopX;
        const dy = height;
        const lineLen = Math.hypot(dx, dy);
        const foldAngle = Math.atan2(dy, dx); // Angle of crease line

        // Normal perpendicular to crease line pointing right (revealed page side):
        const nx = dy / lineLen;
        const ny = -dx / lineLen;

        // Flap width: from measurement, flap width is ~110px at top, ~75px at bottom
        const flapWidthTop = 130;
        const flapWidthBottom = 75;

        // 1. LAYER 1: Revealed Next Page (underneath)
        ctx.drawImage(page2, 0, 0);

        // 2. LAYER 2: Crease drop shadow cast onto Revealed Page (to the right of crease)
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        ctx.lineTo(width, 0);
        ctx.lineTo(width, height);
        ctx.lineTo(foldBottomX, height);
        ctx.closePath();
        ctx.clip();

        // Shadow gradient perpendicular to crease line
        const midX = (foldTopX + foldBottomX) / 2;
        const midY = height / 2;
        const shadowDist = 45; // 45px soft falloff
        const shadG = ctx.createLinearGradient(midX, midY, midX + nx * shadowDist, midY + ny * shadowDist);
        shadG.addColorStop(0, 'rgba(40, 30, 20, 0.35)');
        shadG.addColorStop(0.20, 'rgba(40, 30, 20, 0.18)');
        shadG.addColorStop(0.55, 'rgba(40, 30, 20, 0.05)');
        shadG.addColorStop(1, 'rgba(40, 30, 20, 0)');
        ctx.fillStyle = shadG;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();

        // 3. LAYER 3: Flat Current Page (to the left of crease)
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

        // 4. LAYER 4: Curled Flap (Peeled Paper Flap)
        // Flap boundary path:
        // Left edge of flap starts at top-left curl, runs down to foldBottomX - flapWidthBottom
        const flapTopCornerX = foldTopX - flapWidthTop; // ~ 5px
        const flapBottomCornerX = foldBottomX - flapWidthBottom; // ~ 245px

        // 4a. Drop shadow cast by the flap outer edge onto Page 1
        ctx.save();
        const edgeShadW = 28;
        ctx.beginPath();
        ctx.moveTo(flapTopCornerX - edgeShadW, 40);
        ctx.quadraticCurveTo(
          (flapTopCornerX + flapBottomCornerX) / 2 - edgeShadW, height * 0.5,
          flapBottomCornerX - edgeShadW, height
        );
        ctx.lineTo(flapBottomCornerX + 2, height);
        ctx.quadraticCurveTo(
          (flapTopCornerX + flapBottomCornerX) / 2 + 2, height * 0.5,
          flapTopCornerX + 2, 40
        );
        ctx.closePath();
        const fEdgeShad = ctx.createLinearGradient(flapTopCornerX - edgeShadW, 0, flapTopCornerX, 0);
        fEdgeShad.addColorStop(0, 'rgba(40, 30, 20, 0)');
        fEdgeShad.addColorStop(0.6, 'rgba(40, 30, 20, 0.08)');
        fEdgeShad.addColorStop(1, 'rgba(40, 30, 20, 0.28)');
        ctx.fillStyle = fEdgeShad;
        ctx.fill();
        ctx.restore();

        // 4b. Flap shape
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        // Top edge: curves up and left into curled arch at top-left
        ctx.bezierCurveTo(
          foldTopX - 45, -12,
          flapTopCornerX + 20, 5,
          flapTopCornerX, 55
        );
        // Outer left peeling edge: smooth curve down to bottom
        ctx.quadraticCurveTo(
          (flapTopCornerX + flapBottomCornerX) / 2 - 8, height * 0.5,
          flapBottomCornerX, height
        );
        ctx.lineTo(foldBottomX, height);
        ctx.closePath();
        ctx.clip();

        // Flap base fill: 100% opaque paper color (SAME AS BOOK PAPER!)
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);

        // 4c. Mirrored translucent text on the flap
        ctx.save();
        ctx.translate(foldTopX, 0);
        ctx.rotate(foldAngle - Math.PI / 2);
        ctx.scale(-1, 1);
        ctx.rotate(-(foldAngle - Math.PI / 2));
        ctx.translate(-foldTopX, 0);

        // Clip strictly to peeled region (to the right of fold line in source coordinates)
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        ctx.lineTo(width + 20, 0);
        ctx.lineTo(width + 20, height + 20);
        ctx.lineTo(foldBottomX, height + 20);
        ctx.closePath();
        ctx.clip();

        ctx.globalAlpha = 0.22; // subtle translucent ink show-through
        ctx.drawImage(page1, 0, 0);
        ctx.restore();

        // 4d. Flap lighting: ONLY subtle crease AO shadow, NO metallic highlight!
        const flapG = ctx.createLinearGradient(midX, midY, midX - nx * 100, midY - ny * 100);
        flapG.addColorStop(0, 'rgba(40, 30, 20, 0.28)'); // Crease shadow on flap side
        flapG.addColorStop(0.20, 'rgba(40, 30, 20, 0.10)');
        flapG.addColorStop(0.50, 'rgba(40, 30, 20, 0)');    // Clean paper in middle
        flapG.addColorStop(0.85, 'rgba(40, 30, 20, 0)');
        flapG.addColorStop(1, 'rgba(40, 30, 20, 0.12)');    // Slight darkening along outer rim
        ctx.fillStyle = flapG;
        ctx.fillRect(0, 0, width, height);

        // 4e. Top curl inner shadow (giving the 3D curl at the top corner its depth)
        const topCurlG = ctx.createRadialGradient(foldTopX - 40, 20, 5, foldTopX - 40, 20, 75);
        topCurlG.addColorStop(0, 'rgba(40, 30, 20, 0.22)');
        topCurlG.addColorStop(0.6, 'rgba(40, 30, 20, 0.06)');
        topCurlG.addColorStop(1, 'rgba(40, 30, 20, 0)');
        ctx.fillStyle = topCurlG;
        ctx.fillRect(0, 0, width, 120);

        // Subtle 0.7px paper edge stroke along top curl & outer edge
        ctx.beginPath();
        ctx.moveTo(foldTopX, 0);
        ctx.bezierCurveTo(
          foldTopX - 45, -12,
          flapTopCornerX + 20, 5,
          flapTopCornerX, 55
        );
        ctx.quadraticCurveTo(
          (flapTopCornerX + flapBottomCornerX) / 2 - 8, height * 0.5,
          flapBottomCornerX, height
        );
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(40, 30, 20, 0.12)';
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
    console.error('Eval failed:', evalRes);
    ws.close();
    proc.kill();
    return;
  }

  const b64 = res.replace(/^data:image\/png;base64,/, '');
  const outPath = 'D:\\LindenLeaf-Dev\\astra-mupdf-core\\scripts\\true-wechat-benchmark.png';
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('Saved true-wechat-benchmark.png successfully!');

  ws.close();
  proc.kill();
}

run().catch(console.error);
