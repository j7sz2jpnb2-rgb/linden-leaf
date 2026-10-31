import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9490;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_snap_both_${Date.now()}`);
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

        function createTestTexture(title, textList) {
          const c = document.createElement('canvas');
          c.width = width; c.height = height;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#FAF9F5';
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = '#141413';
          ctx.font = 'bold 22px serif';
          ctx.fillText(title, 40, 70);
          ctx.font = '20px serif';
          textList.forEach((t, i) => ctx.fillText(t, 40, 120 + i * 40));
          return c;
        }

        const page1Tex = createTestTexture('第 1 页（当前页）', [
          '斯宾诺莎《知性改进论》简论',
          '因为；斯宾诺莎信中提到',
          '起来，想把《知性改进论》',
          '构成的以及《神、人及其幸福',
          '中皆是为后者的导言。',
          '与我们通常信写于1662年',
          '的“注43认为《神、人及',
          '章论不属于至少是在1661',
          '“那些通常被戈的。按照雪'
        ]);

        const page2Tex = createTestTexture('第 2 页（目标页）', [
          '激起神学家和教士们的反抗',
          '绝不会容许这本书公开发行',
          '（斯宾诺莎信中提到撰写',
          '好了的完整小册子内容）',
          '人及其幸福简论》',
          '所以讲到知性的改进方法',
          '想把《知性改进论》作为基础',
          '在哲学史上具有里程碑意义'
        ]);

        // Enhanced Curl Simulator Function
        function renderRealisticCurl(ctx, {
          width, height, progress, direction = 'next',
          touchX = null, touchY = null,
          currentTexture = null, nextTexture = null,
          bgColor = '#FAF9F5', textColor = '#141413'
        }) {
          ctx.clearRect(0, 0, width, height);
          const p = Math.min(1, Math.max(0, progress));
          if (p <= 0 || p >= 1) return;

          const isNext = direction === 'next';
          const isDarkTheme = false;

          // Corner curl slant calculation from touch position
          const ty = touchY != null ? Math.max(0, Math.min(height, touchY)) : height * 0.5;
          const normY = (ty - height * 0.5) / (height * 0.5); // -1 (top) to +1 (bottom)

          // Slant factor: corner curl tilts more when touched near top or bottom
          // When turning next (R to L): top leads if touched in top half, bottom leads if touched in bottom half
          const topLead = -normY * 0.55 * Math.sin(p * Math.PI) + (normY === 0 ? 0.25 : 0);
          const slantTop = isNext ? (1 - p * (1 + 0.35 * topLead)) : (p * (1 + 0.35 * topLead));
          const slantBottom = isNext ? (1 - p * (1 - 0.35 * topLead)) : (p * (1 - 0.35 * topLead));

          const foldTopX = width * Math.min(1.05, Math.max(-0.05, slantTop));
          const foldBottomX = width * Math.min(1.05, Math.max(-0.05, slantBottom));

          // Radius smoothly curves with paper elasticity
          const R = Math.max(16, Math.min(width * 0.14, 20 + 26 * Math.sin(p * Math.PI)));

          const dx = foldBottomX - foldTopX;
          const dy = height;
          const lineLen = Math.hypot(dx, dy);

          // Normal vector pointing towards revealed page
          const nx = isNext ? (dy / lineLen) : (-dy / lineLen);
          const ny = isNext ? (-dx / lineLen) : (dx / lineLen);

          const midX = (foldTopX + foldBottomX) / 2;
          const midY = height / 2;

          // Flap reach and apex offset
          const peelDist = isNext ? (width - midX) : midX;
          const flapWidth = Math.min(peelDist * 0.95 + R * 1.3, width * 0.70);
          const apexOffset = R * 1.05;

          const apexTopX = foldTopX - (isNext ? 1 : -1) * (dy / lineLen) * apexOffset;
          const apexBottomX = foldBottomX - (isNext ? 1 : -1) * (dy / lineLen) * apexOffset;

          const flapEdgeTopX = foldTopX - (isNext ? 1 : -1) * (dy / lineLen) * flapWidth;
          const flapEdgeBottomX = foldBottomX - (isNext ? 1 : -1) * (dy / lineLen) * (flapWidth * 0.88);

          // -------------------------------------------------------------
          // LAYER 1: Stationary Target Revealed Page (Underneath curl)
          // -------------------------------------------------------------
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);
          if (nextTexture) {
            ctx.drawImage(nextTexture, 0, 0, width, height);
          }
          // Spine shadow
          const spineSide = isNext ? 0 : width;
          const spineG = ctx.createLinearGradient(spineSide, 0, isNext ? 24 : width - 24, 0);
          spineG.addColorStop(0, 'rgba(0,0,0,0.12)');
          spineG.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = spineG;
          ctx.fillRect(isNext ? 0 : width - 24, 0, 24, height);

          // -------------------------------------------------------------
          // LAYER 2: Contact Drop Shadow on Revealed Page
          // -------------------------------------------------------------
          ctx.save();
          ctx.beginPath();
          if (isNext) {
            ctx.moveTo(foldTopX, 0);
            ctx.lineTo(width, 0);
            ctx.lineTo(width, height);
            ctx.lineTo(foldBottomX, height);
          } else {
            ctx.moveTo(0, 0);
            ctx.lineTo(foldTopX, 0);
            ctx.lineTo(foldBottomX, height);
            ctx.lineTo(0, height);
          }
          ctx.closePath();
          ctx.clip();

          const shadowDist = Math.min(130, Math.max(40, R * 2.3));
          const shadG = ctx.createLinearGradient(midX, midY, midX + nx * shadowDist, midY + ny * shadowDist);
          shadG.addColorStop(0, 'rgba(0, 0, 0, 0.36)');
          shadG.addColorStop(0.2, 'rgba(0, 0, 0, 0.18)');
          shadG.addColorStop(0.55, 'rgba(0, 0, 0, 0.06)');
          shadG.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = shadG;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();

          // -------------------------------------------------------------
          // LAYER 3: Stationary Unpeeled Current Page
          // -------------------------------------------------------------
          ctx.save();
          ctx.beginPath();
          if (isNext) {
            ctx.moveTo(0, 0);
            ctx.lineTo(foldTopX, 0);
            ctx.lineTo(foldBottomX, height);
            ctx.lineTo(0, height);
          } else {
            ctx.moveTo(foldTopX, 0);
            ctx.lineTo(width, 0);
            ctx.lineTo(width, height);
            ctx.lineTo(foldBottomX, height);
          }
          ctx.closePath();
          ctx.clip();

          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);
          if (currentTexture) {
            ctx.drawImage(currentTexture, 0, 0, width, height);
          }
          ctx.fillStyle = spineG;
          ctx.fillRect(isNext ? 0 : width - 24, 0, 24, height);
          ctx.restore();

          // -------------------------------------------------------------
          // LAYER 4: Curled Flap & Mirrored Paper Show-Through
          // -------------------------------------------------------------
          const buildFlapPath = () => {
            ctx.beginPath();
            ctx.moveTo(foldTopX, 0);
            if (isNext) {
              ctx.bezierCurveTo(
                foldTopX - (dy / lineLen) * (R * 1.2), -R * 0.25,
                flapEdgeTopX + R * 0.4, 0,
                flapEdgeTopX, Math.min(60, R * 1.2)
              );
              ctx.quadraticCurveTo(
                (flapEdgeTopX + flapEdgeBottomX) / 2 - 10, height * 0.5,
                flapEdgeBottomX, height
              );
              ctx.lineTo(foldBottomX, height);
            } else {
              ctx.bezierCurveTo(
                foldTopX + (dy / lineLen) * (R * 1.2), -R * 0.25,
                flapEdgeTopX - R * 0.4, 0,
                flapEdgeTopX, Math.min(60, R * 1.2)
              );
              ctx.quadraticCurveTo(
                (flapEdgeTopX + flapEdgeBottomX) / 2 + 10, height * 0.5,
                flapEdgeBottomX, height
              );
              ctx.lineTo(foldBottomX, height);
            }
            ctx.closePath();
          };

          // 4a. Drop shadow cast by flap edge onto current page
          ctx.save();
          const flapShadW = Math.min(50, Math.max(18, R * 0.9));
          ctx.beginPath();
          if (isNext) {
            ctx.moveTo(flapEdgeTopX - flapShadW, 0);
            ctx.lineTo(flapEdgeTopX + 2, 0);
            ctx.quadraticCurveTo((flapEdgeTopX + flapEdgeBottomX) / 2 + 2, height * 0.5, flapEdgeBottomX + 2, height);
            ctx.lineTo(flapEdgeBottomX - flapShadW, height);
            ctx.quadraticCurveTo((flapEdgeTopX + flapEdgeBottomX) / 2 - flapShadW, height * 0.5, flapEdgeTopX - flapShadW, 0);
          } else {
            ctx.moveTo(flapEdgeTopX - 2, 0);
            ctx.lineTo(flapEdgeTopX + flapShadW, 0);
            ctx.quadraticCurveTo((flapEdgeTopX + flapEdgeBottomX) / 2 + flapShadW, height * 0.5, flapEdgeBottomX + flapShadW, height);
            ctx.lineTo(flapEdgeBottomX - 2, height);
            ctx.quadraticCurveTo((flapEdgeTopX + flapEdgeBottomX) / 2 - 2, height * 0.5, flapEdgeTopX - 2, 0);
          }
          ctx.closePath();
          const fEdgeG = isNext
            ? ctx.createLinearGradient(flapEdgeTopX - flapShadW, 0, flapEdgeTopX, 0)
            : ctx.createLinearGradient(flapEdgeTopX, 0, flapEdgeTopX + flapShadW, 0);
          fEdgeG.addColorStop(isNext ? 0 : 1, 'rgba(0, 0, 0, 0)');
          fEdgeG.addColorStop(isNext ? 0.6 : 0.4, 'rgba(0, 0, 0, 0.08)');
          fEdgeG.addColorStop(isNext ? 1 : 0, 'rgba(0, 0, 0, 0.28)');
          ctx.fillStyle = fEdgeG;
          ctx.fill();
          ctx.restore();

          // 4b. Render the Flap body
          ctx.save();
          buildFlapPath();
          ctx.clip();

          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, width, height);

          // Mirrored show-through text from current page
          if (currentTexture) {
            ctx.save();
            const foldAngle = Math.atan2(dy, dx);
            ctx.translate(foldTopX, 0);
            ctx.rotate(foldAngle - Math.PI / 2);
            ctx.scale(-1, 1);
            ctx.rotate(-(foldAngle - Math.PI / 2));
            ctx.translate(-foldTopX, 0);

            ctx.globalAlpha = 0.13;
            ctx.drawImage(currentTexture, 0, 0, width, height);
            ctx.restore();
          }

          // Cylindrical crease & curve lighting
          const flapDirX = isNext ? -(dy / lineLen) : (dy / lineLen);
          const flapDirY = isNext ? (dx / lineLen) : -(dx / lineLen);
          const fShadG = ctx.createLinearGradient(midX, midY, midX + flapDirX * flapWidth, midY + flapDirY * flapWidth);
          fShadG.addColorStop(0, 'rgba(0, 0, 0, 0.26)');
          fShadG.addColorStop(0.18, 'rgba(0, 0, 0, 0.07)');
          fShadG.addColorStop(0.48, 'rgba(255, 255, 255, 0.18)');
          fShadG.addColorStop(0.78, 'rgba(0, 0, 0, 0.04)');
          fShadG.addColorStop(1, 'rgba(0, 0, 0, 0.16)');
          ctx.fillStyle = fShadG;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();

          // -------------------------------------------------------------
          // LAYER 5: Specular Crest Highlight Along the Cylinder Ridge
          // -------------------------------------------------------------
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(apexTopX, 0);
          ctx.quadraticCurveTo((apexTopX + apexBottomX) / 2 - (isNext ? 5 : -5), height * 0.5, apexBottomX, height);
          ctx.lineWidth = Math.max(2.5, R * 0.09);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.60)';
          ctx.stroke();
          ctx.restore();
        }

        // Test Case 1: Next Page, Top Corner Curl (progress 0.42, touchY 200)
        const c1 = document.createElement('canvas');
        c1.width = width; c1.height = height;
        renderRealisticCurl(c1.getContext('2d'), {
          width, height, progress: 0.42, direction: 'next',
          touchY: 200, currentTexture: page1Tex, nextTexture: page2Tex
        });

        // Test Case 2: Prev Page (L to R), Mid Curl (progress 0.45, touchY 500)
        const c2 = document.createElement('canvas');
        c2.width = width; c2.height = height;
        renderRealisticCurl(c2.getContext('2d'), {
          width, height, progress: 0.45, direction: 'prev',
          touchY: 500, currentTexture: page2Tex, nextTexture: page1Tex
        });

        return {
          case1Url: c1.toDataURL('image/png'),
          case2Url: c2.toDataURL('image/png')
        };
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

  const b64_1 = res.case1Url.replace(/^data:image\/png;base64,/, '');
  const b64_2 = res.case2Url.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('D:\\LindenLeaf-Dev\\astra-mupdf-core\\scripts\\rendered-curl-case1-next.png', Buffer.from(b64_1, 'base64'));
  fs.writeFileSync('D:\\LindenLeaf-Dev\\astra-mupdf-core\\scripts\\rendered-curl-case2-prev.png', Buffer.from(b64_2, 'base64'));
  console.log('Saved both cases to scripts directory.');

  ws.close();
  proc.kill();
}

run().catch(console.error);
