import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9487;

async function run() {
  const tempProfile = path.join(process.env.TEMP, `edge_clean_slice_${Date.now()}`);
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
      (() => {
        const container = document.createElement('div');
        container.style.cssText = 'width: 400px; height: 300px; overflow: hidden; position: relative;';
        document.body.appendChild(container);

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 800px; height: 300px; border: 0;';
        container.appendChild(iframe);

        const doc = iframe.contentDocument;
        doc.documentElement.style.cssText = 'box-sizing: border-box; width: 400px; height: 300px; column-width: 360px; column-gap: 40px; column-fill: auto; overflow: hidden; padding: 0 20px;';
        doc.body.style.cssText = 'margin: 0; font-size: 18px; line-height: 30px;';
        doc.body.innerHTML = \`
          <p id="p1">第01行文字。第02行文字。第03行文字。第04行文字。第05行文字。第06行文字。第07行文字。第08行文字。第09行文字。第10行文字。第11行文字。第12行文字。第13行文字。第14行文字。第15行文字。</p>
          <p id="p2">第二段文字在第二页。第二段第二行文字。第二段第三行文字。</p>
        \`;

        // Extract visible lines for column K (0 or 1)
        function getLinesForColumn(colK, pageSize = 400) {
          const colMinX = colK * pageSize;
          const colMaxX = (colK + 1) * pageSize;
          const colLines = [];

          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
          const charRange = doc.createRange();
          let node = walker.nextNode();

          while (node) {
            const text = node.textContent;
            if (text && text.trim()) {
              const fullRange = doc.createRange();
              fullRange.selectNodeContents(node);
              const rects = fullRange.getClientRects();

              // Check if node has any rect in this column
              let inCol = false;
              for (const r of rects) {
                if (r.left >= colMinX - 5 && r.left < colMaxX - 5) {
                  inCol = true;
                  break;
                }
              }

              if (inCol) {
                // Find lines in this column
                let currentLine = '';
                let currentTop = -999;
                let currentLeft = 0;

                for (let c = 0; c < text.length; c++) {
                  charRange.setStart(node, c);
                  charRange.setEnd(node, c + 1);
                  const cr = charRange.getBoundingClientRect();
                  if (!cr || cr.width === 0) {
                    if (currentLine) currentLine += text[c];
                    continue;
                  }

                  if (cr.left >= colMinX - 5 && cr.left < colMaxX - 5) {
                    // Belongs to this column!
                    if (currentLine && Math.abs(cr.top - currentTop) > 6) {
                      colLines.push({ text: currentLine, x: currentLeft - colMinX, y: currentTop });
                      currentLine = '';
                    }
                    if (!currentLine) {
                      currentTop = cr.top;
                      currentLeft = cr.left;
                    }
                    currentLine += text[c];
                  } else {
                    if (currentLine) {
                      colLines.push({ text: currentLine, x: currentLeft - colMinX, y: currentTop });
                      currentLine = '';
                      currentTop = -999;
                    }
                  }
                }
                if (currentLine) {
                  colLines.push({ text: currentLine, x: currentLeft - colMinX, y: currentTop });
                }
              }
            }
            node = walker.nextNode();
          }
          return colLines;
        }

        const col0Lines = getLinesForColumn(0);
        const col1Lines = getLinesForColumn(1);

        return {
          col0Count: col0Lines.length,
          col0Lines,
          col1Count: col1Lines.length,
          col1Lines
        };
      })()
    `,
    returnByValue: true
  });

  console.log('Clean extraction result:', JSON.stringify(evalRes.result.value, null, 2));

  ws.close();
  proc.kill();
}

run().catch(console.error);
