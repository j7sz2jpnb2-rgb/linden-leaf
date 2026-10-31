import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9499;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_snap_test_${Date.now()}`);
  fs.mkdirSync(tempProfile, { recursive: true });

  const proc = spawn(edgeExe, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tempProfile}`,
    '--headless=new',
    '--disable-gpu',
    '--allow-file-access-from-files',
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

  const controllerCode = fs.readFileSync('D:\\LindenLeaf-Dev\\astra-mupdf-core\\js\\page-turn-controller.js', 'utf8')
    .replace(/^export\s+/gm, ''); // strip export keywords so it runs in global scope

  await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 500));

  const rawCode = fs.readFileSync('D:\\LindenLeaf-Dev\\astra-mupdf-core\\js\\page-turn-controller.js', 'utf8')
    .replace(/^export\s+/gm, '') // strip export
    .replace(/\bconst\s+PAGE_TURN_/g, 'var PAGE_TURN_')
    .replace(/\bconst\s+FEATURE_/g, 'var FEATURE_')
    .replace(/\bconst\s+safeRaf\b/g, 'var safeRaf')
    .replace(/\bfunction\s+isDarkColor\b/g, 'var isDarkColor = function')
    .replace(/\bclass\s+CurlSimulator\b/g, 'window.CurlSimulator = class CurlSimulator');

  const evalControllerRes = await send('Runtime.evaluate', {
    expression: rawCode
  });
  if (evalControllerRes.exceptionDetails) {
    console.error('FAILED TO EVAL CONTROLLER:', evalControllerRes.exceptionDetails);
    process.exit(1);
  } else {
    console.log('Controller evaluated cleanly!');
  }

  const evalRes = await send('Runtime.evaluate', {
    expression: `
      (async () => {
        const width = 412;
        const height = 915;
        const bgColor = '#FAF8F3';
        const textColor = '#1C1A17';

        function createPage(title, lines, pageNumStr) {
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
          ctx.fillText(pageNumStr, width - 36, height - 35);

          return c;
        }

        const page1 = createPage('简论》', [
          '斯宾诺莎《知性改进论》简论',
          '因为；斯宾诺莎信中提到',
          '起来，想把《知性改进论》',
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
          '戈的。按照雪莱',
          '的意见，该书',
          '注46不久',
          '节哈特则认为',
          '即1660年',
          '撰写时间'
        ], '218 / 2314');

        // Case 1: Next, top corner drag (Progress 0.45, touchY 180 - WeChat P3 benchmark)
        const c1 = document.createElement('canvas');
        c1.width = width; c1.height = height;
        const sim1 = new CurlSimulator(c1);
        sim1.renderCurl({
            width, height, progress: 0.45, direction: 'next',
            touchY: 180, currentTexture: page1, nextTexture: page2, bgColor, textColor
        });

        // Case 2: Next, mid horizontal drag (Progress 0.50, touchY 450)
        const c2 = document.createElement('canvas');
        c2.width = width; c2.height = height;
        const sim2 = new CurlSimulator(c2);
        sim2.renderCurl({
            width, height, progress: 0.50, direction: 'next',
            touchY: 450, currentTexture: page1, nextTexture: page2, bgColor, textColor
        });

        // Case 3: Next, bottom corner drag (Progress 0.45, touchY 750)
        const c3 = document.createElement('canvas');
        c3.width = width; c3.height = height;
        const sim3 = new CurlSimulator(c3);
        sim3.renderCurl({
            width, height, progress: 0.45, direction: 'next',
            touchY: 750, currentTexture: page1, nextTexture: page2, bgColor, textColor
        });

        // Case 4: Prev, page turn backward (Progress 0.45, touchY 180)
        const c4 = document.createElement('canvas');
        c4.width = width; c4.height = height;
        const sim4 = new CurlSimulator(c4);
        sim4.renderCurl({
            width, height, progress: 0.45, direction: 'prev',
            touchY: 180, currentTexture: page2, nextTexture: page1, bgColor, textColor
        });

        return {
            case1Url: c1.toDataURL('image/png'),
            case2Url: c2.toDataURL('image/png'),
            case3Url: c3.toDataURL('image/png'),
            case4Url: c4.toDataURL('image/png')
        };
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  console.log('evalRes:', JSON.stringify(evalRes, null, 2));
  const res = evalRes.result?.value;
  if (!res) {
    console.error('Eval error:', evalRes);
    ws.close();
    proc.kill();
    return;
  }

  const saveCase = (dataUrl, filename) => {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const outPath = path.join('D:\\LindenLeaf-Dev\\astra-mupdf-core\\scripts', filename);
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    console.log(`Saved ${filename} successfully!`);
  };

  saveCase(res.case1Url, 'curl-case1-next-top.png');
  saveCase(res.case2Url, 'curl-case2-next-mid.png');
  saveCase(res.case3Url, 'curl-case3-next-bottom.png');
  saveCase(res.case4Url, 'curl-case4-prev-top.png');

  ws.close();
  proc.kill();
}

run().catch(console.error);
