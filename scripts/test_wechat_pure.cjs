const fs = require('fs')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body {
    background: #fdfbf7;
    color: #1a1a1a;
    font-family: 'Source Han Serif SC', 'Noto Serif CJK SC', 'SimSun', serif;
    font-size: 24px;
    line-height: 2.2;
    padding: 60px 80px;
    max-width: 600px;
    margin: 0 auto;
}
.poem-line {
    position: relative;
    margin-bottom: 12px;
    display: inline-block;
    padding: 0 4px;
}
svg.marker-layer {
    position: absolute;
    top: -2px;
    left: 0;
    width: 100%;
    height: calc(100% + 4px);
    pointer-events: none;
    z-index: -1;
    mix-blend-mode: multiply;
}
</style>
</head>
<body>
    <div id="container">
        <!-- Lines injected -->
    </div>

    <script>
    const textLines = [
        "“邓肯爵士，” 罗翰妮夫人说，",
        "“黑龙起兵时我才十岁。我乞求父",
        "亲莫以身犯险，或至少留下我丈"
    ];

    const color = '#f43f5e'; // Pink highlighter

    const container = document.getElementById('container');
    textLines.forEach((text, i) => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'poem-line';
        lineDiv.innerText = text;
        container.appendChild(lineDiv);
        container.appendChild(document.createElement('br'));
    });

    window.renderMarkers = function() {
        const divs = document.querySelectorAll('.poem-line');
        divs.forEach((div, i) => {
            const w = div.offsetWidth;
            const h = div.offsetHeight + 4;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'marker-layer');
            svg.setAttribute('viewBox', \`0 0 \${w} \${h}\`);

            const top = 2;
            const bottom = h - 2;
            const left = 2;
            const right = w - 2;
            const midY = (top + bottom) / 2;

            // 1. SOLID FLAT BASE PATH (Uniform color and opacity - clean and readable)
            const basePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            let d = '';

            if (i === 0) {
                // Line 1: WeChat Read exact profile (Soft rounded left, flat right with slight slant)
                d = \`M \${left + 3},\${top} L \${right - 1},\${top} Q \${right + 0.5},\${midY} \${right - 1},\${bottom} L \${left + 3},\${bottom} Q \${left},\${midY} \${left + 3},\${top} Z\`;
            } else if (i === 1) {
                // Line 2: WeChat Read exact profile (45° chisel touchdown cut on left, slight outward bottom on right)
                d = \`M \${left + 4},\${top} L \${right - 1},\${top} L \${right + 1},\${bottom} L \${left},\${bottom} Z\`;
            } else {
                // Line 3: WeChat Read exact profile (Straight rounded left, subtle chisel slant on right)
                d = \`M \${left + 2},\${top} L \${right + 0.5},\${top} L \${right - 3.5},\${bottom} L \${left + 2},\${bottom} Q \${left - 0.5},\${midY} \${left + 2},\${top} Z\`;
            }

            basePath.setAttribute('d', d);
            basePath.setAttribute('fill', color);
            basePath.style.opacity = '0.36';
            svg.appendChild(basePath);

            // 2. DISCRETE WECHAT-STYLE INK ACCUMULATION (Only at specific physical contact points!)
            if (i === 0) {
                // WeChat Line 1 detail: The delicate vertical lift-off brush mark on the far right
                const brushTail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                // A narrow vertical stroke overlapping the right terminal edge
                brushTail.setAttribute('d', \`M \${right - 2},\${top - 1} Q \${right + 1.5},\${midY} \${right - 1},\${bottom + 1} L \${right - 3.5},\${bottom} Q \${right - 1},\${midY} \${right - 3.5},\${top} Z\`);
                brushTail.setAttribute('fill', color);
                brushTail.style.opacity = '0.28';
                svg.appendChild(brushTail);
            }

            if (i === 1) {
                // WeChat Line 2 detail: The sharp chisel touchdown mark on the left
                const chiselEdge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                chiselEdge.setAttribute('d', \`M \${left + 3.5},\${top} L \${left + 5.5},\${top} L \${left + 1.5},\${bottom} L \${left},\${bottom} Z\`);
                chiselEdge.setAttribute('fill', color);
                chiselEdge.style.opacity = '0.22';
                svg.appendChild(chiselEdge);
            }

            div.appendChild(svg);
        });
    };
    window.addEventListener('load', window.renderMarkers);
    </script>
</body>
</html>
`

fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/scripts/test_wechat_pure.html', html)

async function testPure() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 800, height: 450 })
    await page.goto('file:///C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/scripts/test_wechat_pure.html')
    await new Promise(r => setTimeout(r, 600))
    const out = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_pure_compare.png'
    await page.screenshot({ path: out })
    console.log('Saved pure compare to:', out)
    await browser.close()
}

testPure().catch(console.error)
