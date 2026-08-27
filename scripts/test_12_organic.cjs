const fs = require('fs')
const puppeteer = require('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/node_modules/puppeteer-core')

// Let's create an organic Bézier highlighter generator with 12 truly distinct, continuous-wobble profiles
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
    max-width: 620px;
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
    top: -4px;
    left: -4px;
    width: calc(100% + 8px);
    height: calc(100% + 8px);
    pointer-events: none;
    z-index: -1;
    mix-blend-mode: multiply;
}
</style>
</head>
<body>
    <div id="container"></div>

    <script>
    const textLines = [
        "“邓肯爵士，” 罗翰妮夫人说，",
        "“黑龙起兵时我才十岁。我乞求父",
        "亲莫以身犯险，或至少留下我丈",
        "夫，如果两个男人都走了，谁来保",
        "护我？他带我登上冷壕堡城墙，指",
        "出要津所在。‘保证它们完好，’",
        "他说，‘它们会保护你。照顾好自",
        "己，就没人能伤害你。’他指的第",
        "一处就是护城壕。”她用辫子末梢"
    ];

    const color = '#f8719d'; // WeChat Read authentic soft pink

    const container = document.getElementById('container');
    textLines.forEach((text, i) => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'poem-line';
        lineDiv.innerText = text;
        container.appendChild(lineDiv);
        container.appendChild(document.createElement('br'));
    });

    // 12 Authentic WeChat Read Hand-Drawn Organic Bézier Profiles
    function generateOrganicHighlightPath(left, top, width, height, seedIndex) {
        const right = left + width;
        const bottom = top + height;
        const midY = top + height * 0.5;
        const midX = left + width * 0.5;

        // Pseudo-random jitter generator
        function rnd(offset, scale) {
            const val = Math.sin(seedIndex * 137.5 + offset * 73.1) * 10000;
            return (val - Math.floor(val) - 0.5) * scale;
        }

        // 3 control points along top edge for realistic hand-drawn continuous micro-wobble
        const t1X = left + width * 0.25;
        const t1Y = top + rnd(1, 1.4);
        const t2X = left + width * 0.50;
        const t2Y = top + rnd(2, 1.8);
        const t3X = left + width * 0.75;
        const t3Y = top + rnd(3, 1.4);

        // 3 control points along bottom edge
        const b3X = left + width * 0.75;
        const b3Y = bottom + rnd(4, 1.4);
        const b2X = left + width * 0.50;
        const b2Y = bottom + rnd(5, 1.8);
        const b1X = left + width * 0.25;
        const b1Y = bottom + rnd(6, 1.4);

        const v = seedIndex % 12;

        let path = '';

        switch (v) {
            case 0: // 1. WeChat Line 1 classic: Soft rounded left entry, top wave, gentle vertical soft cap on right
                path = \`M \${left + 3},\${top + 1}
                        Q \${left},\${midY} \${left + 3},\${bottom - 1}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 2},\${bottom}
                        Q \${right + 1.5},\${midY} \${right - 1},\${top + 1}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 3},\${top + 1} Z\`;
                break;

            case 1: // 2. WeChat Line 2 classic: 45° soft chisel entry, slight rightward bottom flare
                path = \`M \${left + 4.5},\${top}
                        Q \${left + 1.5},\${midY} \${left},\${bottom - 0.5}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right + 1.5},\${bottom}
                        Q \${right + 2},\${midY} \${right - 1},\${top}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 4.5},\${top} Z\`;
                break;

            case 2: // 3. WeChat Line 3 classic: Soft rounded entry, 35° chisel slant with soft rounded corners on exit
                path = \`M \${left + 2.5},\${top + 0.5}
                        Q \${left - 0.5},\${midY} \${left + 2},\${bottom - 0.5}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 3.5},\${bottom}
                        Q \${right - 1.5},\${midY} \${right + 0.5},\${top}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 2.5},\${top + 0.5} Z\`;
                break;

            case 3: // 4. Natural Hand-Glide Arc: subtle convex round right bubble
                path = \`M \${left + 3},\${top + 1}
                        Q \${left + 0.5},\${midY} \${left + 2},\${bottom - 0.5}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 1.5},\${bottom - 0.5}
                        Q \${right + 2.5},\${midY} \${right - 1.5},\${top + 0.5}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 3},\${top + 1} Z\`;
                break;

            case 4: // 5. Reverse Chisel Angle: top right overhang, bottom right cut inward
                path = \`M \${left + 1},\${top + 1}
                        Q \${left - 1},\${midY} \${left + 3.5},\${bottom}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right + 1},\${bottom}
                        Q \${right + 0.5},\${midY} \${right - 3},\${top + 0.5}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 1},\${top + 1} Z\`;
                break;

            case 5: // 6. Dual 40° Parallel Slants (Marker held with firm slanted posture)
                path = \`M \${left + 4},\${top}
                        Q \${left + 1.5},\${midY} \${left - 0.5},\${bottom}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 3.5},\${bottom}
                        Q \${right - 1},\${midY} \${right + 1},\${top}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 4},\${top} Z\`;
                break;

            case 6: // 7. Organic S-Wave with pinched waist
                path = \`M \${left + 2.5},\${top + 0.5}
                        Q \${left - 0.8},\${midY} \${left + 2.5},\${bottom - 0.5}
                        Q \${b1X},\${b1Y - 0.5} \${b2X},\${b2Y + 0.5}
                        Q \${b3X},\${b3Y} \${right - 1},\${bottom}
                        Q \${right + 1.8},\${midY} \${right - 2},\${top + 0.5}
                        Q \${t3X},\${t3Y + 0.5} \${t2X},\${t2Y - 0.5}
                        Q \${t1X},\${t1Y} \${left + 2.5},\${top + 0.5} Z\`;
                break;

            case 7: // 8. Soft Droplet Entry with Vertical Flat Chisel Release
                path = \`M \${left + 3.5},\${top}
                        Q \${left - 1.2},\${midY} \${left + 3.5},\${bottom}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 0.5},\${bottom}
                        Q \${right + 0.8},\${midY} \${right - 0.5},\${top}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 3.5},\${top} Z\`;
                break;

            case 8: // 9. Fast Stroke with Feathered Lift-off
                path = \`M \${left + 2},\${top + 0.8}
                        Q \${left},\${midY} \${left + 1.5},\${bottom - 0.5}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 4},\${bottom}
                        Q \${right - 1},\${midY} \${right},\${top + 0.5}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 2},\${top + 0.8} Z\`;
                break;

            case 9: // 10. Heavy Solid Stroke with Full Bleed Corners
                path = \`M \${left + 3},\${top}
                        Q \${left - 0.5},\${midY} \${left + 3},\${bottom}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 2},\${bottom}
                        Q \${right + 1.5},\${midY} \${right - 2},\${top}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 3},\${top} Z\`;
                break;

            case 10: // 11. Upward Hand-Glide with slight top-right curl
                path = \`M \${left + 2},\${top + 1}
                        Q \${left - 0.5},\${midY} \${left + 1.5},\${bottom}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 1},\${bottom - 0.5}
                        Q \${right + 2},\${midY} \${right + 0.5},\${top - 0.5}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 2},\${top + 1} Z\`;
                break;

            case 11:
            default: // 12. Classic Balanced Organic Highlighter
                path = \`M \${left + 2.8},\${top + 0.5}
                        Q \${left - 0.6},\${midY} \${left + 2.8},\${bottom - 0.5}
                        Q \${b1X},\${b1Y} \${b2X},\${b2Y}
                        Q \${b3X},\${b3Y} \${right - 2.5},\${bottom - 0.5}
                        Q \${right + 1.2},\${midY} \${right - 2.5},\${top + 0.5}
                        Q \${t3X},\${t3Y} \${t2X},\${t2Y}
                        Q \${t1X},\${t1Y} \${left + 2.8},\${top + 0.5} Z\`;
                break;
        }

        return { path, v };
    }

    window.renderMarkers = function() {
        const divs = document.querySelectorAll('.poem-line');
        divs.forEach((div, i) => {
            const w = div.offsetWidth + 6;
            const h = div.offsetHeight + 4;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'marker-layer');
            svg.setAttribute('viewBox', \`0 0 \${w} \${h}\`);

            const top = 3;
            const height = h - 6;
            const left = 2;
            const width = w - 4;
            const right = left + width;
            const midY = top + height * 0.5;

            const { path: d, v } = generateOrganicHighlightPath(left, top, width, height, i);

            // 1. Organic Base Hand-drawn Path
            const basePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            basePath.setAttribute('d', d);
            basePath.setAttribute('fill', color);
            basePath.style.opacity = '0.38';
            svg.appendChild(basePath);

            // 2. Subtle micro-accent on WeChat Line 1 style terminal
            if (v === 0) {
                const brushTail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                brushTail.setAttribute('d', \`M \${right - 3},\${top + 1} Q \${right + 1},\${midY} \${right - 2},\${top + height} L \${right - 4.5},\${top + height} Q \${right - 1.5},\${midY} \${right - 4.5},\${top + 1} Z\`);
                brushTail.setAttribute('fill', color);
                brushTail.style.opacity = '0.22';
                svg.appendChild(brushTail);
            }

            div.appendChild(svg);
        });
    };
    window.addEventListener('load', window.renderMarkers);
    </script>
</body>
</html>
`

fs.writeFileSync('C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/scripts/test_12_organic_profiles.html', html)

async function test12Organic() {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        headless: true
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 850, height: 950 })
    await page.goto('file:///C:/Users/Administrator/.gemini/antigravity/scratch/universal-reader/scripts/test_12_organic_profiles.html')
    await new Promise(r => setTimeout(r, 800))
    const out = 'C:/Users/Administrator/.gemini/antigravity/brain/40ebe18d-48fa-406e-96c5-420fe912e1ea/scratch/wechat_12_organic_verified.png'
    await page.screenshot({ path: out })
    console.log('Saved 12 organic verified screenshot to:', out)
    await browser.close()
}

test12Organic().catch(console.error)
