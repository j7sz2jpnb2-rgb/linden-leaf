// scripts/verify-mobile-v10-cdp.mjs
// Automated verification & CDP screenshot capture for Linden Leaf Template 10 & 11 Direct Reproduction

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const deliveryScreenshotsDir = 'D:\\LindenLeaf-Deliveries\\2026-10-10\\android-candidate-v10\\screenshots';
const brainArtifactsDir = 'C:\\Users\\YONGHU\\.gemini\\antigravity\\brain\\f412029f-3454-45e1-83e2-0bade0f4471d';

fs.mkdirSync(deliveryScreenshotsDir, { recursive: true });
fs.mkdirSync(brainArtifactsDir, { recursive: true });

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9466;
const previewPort = 18430;

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION FAILED] ${message}`);
    }
}

async function main() {
    console.log('=== Starting Candidate v10 Direct Template Reproduction Verification & Capture ===');

    // 1. Start Preview Server
    console.log('[1/6] Launching Preview Server on port', previewPort);
    const previewServer = spawn(process.execPath, ['scripts/preview-server.mjs', `--port=${previewPort}`], {
        cwd: rootDir,
        stdio: 'pipe',
        env: { ...process.env, PORT: String(previewPort) }
    });

    for (let i = 0; i < 30; i++) {
        try {
            const hRes = await fetch(`http://127.0.0.1:${previewPort}/health`);
            if (hRes.ok) {
                console.log('Preview server healthy on port', previewPort);
                break;
            }
        } catch (_) {}
        await SLEEP(200);
    }

    // 2. Launch Edge in headless mode with remote debugging
    console.log('[2/6] Launching Edge browser (CDP port:', debugPort, ')');
    const tempProfile = path.join(process.env.TEMP, `edge_mobile_v10_${Date.now()}`);
    fs.mkdirSync(tempProfile, { recursive: true });

    const edgeProc = spawn(edgeExe, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${tempProfile}`,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `http://127.0.0.1:${previewPort}/index.html`
    ], { stdio: 'ignore' });

    let ws = null;
    try {
        // Connect to CDP WebSocket
        let wsUrl = null;
        for (let i = 0; i < 40; i++) {
            await SLEEP(250);
            try {
                const res = await fetch(`http://127.0.0.1:${debugPort}/json`);
                const list = await res.json();
                const pageTarget = list.find(t => t.type === 'page');
                if (pageTarget?.webSocketDebuggerUrl) {
                    wsUrl = pageTarget.webSocketDebuggerUrl;
                    break;
                }
            } catch (_) {}
        }

        if (!wsUrl) throw new Error('Failed to connect to browser CDP endpoint');
        console.log('Connected to CDP target:', wsUrl);

        ws = new WebSocket(wsUrl);
        await new Promise((res, rej) => {
            ws.onopen = res;
            ws.onerror = rej;
        });

        let msgId = 0;
        const pending = new Map();
        ws.onmessage = evt => {
            const data = JSON.parse(evt.data);
            if (data.id && pending.has(data.id)) {
                pending.get(data.id)(data);
                pending.delete(data.id);
            }
        };

        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++msgId;
            pending.set(id, r => r.error ? reject(new Error(r.error.message)) : resolve(r.result));
            ws.send(JSON.stringify({ id, method, params }));
        });

        const evalExpr = async (expr) => {
            const res = await send('Runtime.evaluate', {
                expression: expr,
                awaitPromise: true,
                returnByValue: true
            });
            if (res.exceptionDetails) {
                throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
            }
            return res.result?.value;
        };

        const capture = async (name) => {
            const res = await send('Page.captureScreenshot', { format: 'png' });
            const buf = Buffer.from(res.data, 'base64');
            const target1 = path.join(deliveryScreenshotsDir, name);
            const target2 = path.join(brainArtifactsDir, name);
            fs.writeFileSync(target1, buf);
            fs.writeFileSync(target2, buf);
            console.log(`  [Screenshot Saved] -> ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
        };

        // Enable domains
        await send('Page.enable');
        await send('Runtime.enable');

        // Set mobile viewport (Standard Android / modern mobile viewport 390x844)
        console.log('[3/6] Setting mobile viewport (390 x 844, dpr: 2)');
        await send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
            mobile: true,
            screenOrientation: { angle: 0, type: 'portraitPrimary' }
        });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true });

        // Navigate to preview index.html
        console.log('[4/6] Navigating to preview index.html');
        await send('Page.navigate', { url: `http://127.0.0.1:${previewPort}/index.html` });
        await SLEEP(2500);

        // Inject sample books and reading notes into IndexedDB
        console.log('[5/6] Injecting test reading data into IndexedDB');
        const setupResult = await evalExpr(`
            (async () => {
                localStorage.setItem('linden_user_initialized', 'true');
                localStorage.setItem('linden_user_name', '诶云朵？！');
                const wModal = document.getElementById('welcome-modal-backdrop');
                if (wModal) {
                    wModal.style.display = 'none';
                    wModal.classList.remove('show');
                }
                const db = await import('./js/db.js');

                // Generate Canvas Cover Blob for Book 1 (堂吉诃德)
                const canvas = document.createElement('canvas');
                canvas.width = 300;
                canvas.height = 420;
                const ctx = canvas.getContext('2d');
                const grad = ctx.createLinearGradient(0, 0, 300, 420);
                grad.addColorStop(0, '#2c3e50');
                grad.addColorStop(1, '#1a252f');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 300, 420);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 26px serif';
                ctx.fillText('堂吉诃德', 40, 110);
                ctx.font = '16px sans-serif';
                ctx.fillStyle = '#bdc3c7';
                ctx.fillText('塞万提斯 著', 40, 150);
                const coverBlob1 = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));

                // Generate Canvas Cover Blob for Book 2 (Ulysses)
                const canvas2 = document.createElement('canvas');
                canvas2.width = 300;
                canvas2.height = 420;
                const ctx2 = canvas2.getContext('2d');
                const grad2 = ctx2.createLinearGradient(0, 0, 300, 420);
                grad2.addColorStop(0, '#356859');
                grad2.addColorStop(1, '#23443a');
                ctx2.fillStyle = grad2;
                ctx2.fillRect(0, 0, 300, 420);
                ctx2.fillStyle = '#ecdba8';
                ctx2.font = 'bold 28px serif';
                ctx2.fillText('ULYSSES', 45, 120);
                ctx2.font = '15px serif';
                ctx2.fillStyle = '#d2c59d';
                ctx2.fillText('James Joyce', 45, 160);
                const coverBlob2 = await new Promise(r => canvas2.toBlob(r, 'image/jpeg', 0.9));

                const sampleBook1 = {
                    id: 'sample_book_01',
                    title: '堂吉诃德 (精校注释本)',
                    author: '塞万提斯',
                    coverBlob: coverBlob1,
                    cover: null,
                    format: 'txt',
                    lastReadAt: Date.now() - 1800000,
                    progress: {
                        fraction: 0.42,
                        cfi: 'ch_01_p_05',
                        updatedAt: Date.now() - 1800000
                    },
                    readingStatus: 'reading',
                    totalReadingSeconds: 7200
                };
                await db.saveBook(sampleBook1);

                const sampleBook2 = {
                    id: 'sample_book_02',
                    title: '尤利西斯',
                    author: '詹姆斯·乔伊斯',
                    coverBlob: coverBlob2,
                    cover: null,
                    format: 'epub',
                    lastReadAt: Date.now() - 3600000,
                    progress: {
                        fraction: 0.28,
                        cfi: 'epub_ch_03',
                        updatedAt: Date.now() - 3600000
                    },
                    readingStatus: 'reading',
                    totalReadingSeconds: 5400
                };
                await db.saveBook(sampleBook2);

                const sampleBook3 = {
                    id: 'sample_book_03',
                    title: '百年孤独',
                    author: '加西亚·马尔克斯',
                    coverBlob: null,
                    cover: null,
                    format: 'epub',
                    lastReadAt: Date.now() - 86400000,
                    progress: {
                        fraction: 1.0,
                        cfi: 'epub_ch_20',
                        updatedAt: Date.now() - 86400000
                    },
                    readingStatus: 'finished',
                    status: 'finished',
                    completedAt: Date.now() - 86400000,
                    totalReadingSeconds: 14400
                };
                await db.saveBook(sampleBook3);

                // Sample Highlights matching Template 10 structure
                const sampleHighlight1 = {
                    id: 'hl_sample_01',
                    bookId: 'sample_book_01',
                    title: '礼貌与距离',
                    text: '[To Rosencrantz and Guildenstern] My good friends, I\\'ll leave you till night. You are welcome to Elsinore.',
                    note: '“好朋友”听来亲近，哈姆雷特却让他们离开，才独自开口。礼貌维持着距离：有欢迎，却非交心，仍有保留。',
                    chapterTitle: 'The Complete Works of William Shakespeare',
                    cfi: 'ch_02_scene_02',
                    createdAt: 1786930860000, // 2026/8/17 09:41
                    color: '#d5cec5'
                };
                await db.saveHighlight(sampleHighlight1);

                const sampleHighlight2 = {
                    id: 'hl_sample_02',
                    bookId: 'sample_book_01',
                    title: '礼数的分量',
                    text: '',
                    note: '在这个大家庭里，细小的礼数记录着每个人的位置：照拂显出亲疏，而谁必须留意谁，也显出身份。',
                    chapterTitle: '',
                    cfi: '',
                    createdAt: 1786930860000,
                    color: '#d5cec5'
                };
                await db.saveHighlight(sampleHighlight2);

                const sampleHighlight3 = {
                    id: 'hl_sample_03',
                    bookId: 'sample_book_02',
                    title: '拼成一个整体',
                    text: '',
                    note: '伍尔夫笔下的普通读者从零散印象中拼出一个暂成的整体。它或许粗疏，却不借用别人的权威。',
                    chapterTitle: '',
                    cfi: '',
                    createdAt: 1786930860000,
                    color: '#d5cec5'
                };
                await db.saveHighlight(sampleHighlight3);

                const sampleHighlight4 = {
                    id: 'hl_sample_04',
                    bookId: 'sample_book_01',
                    title: '',
                    text: 'Ay, so, God b\\' wi\\' ye. Now I am alone. O what a rogue and peasant slave am I! Is it not monstrous that this player here, But in a fiction, in a dream of passion...',
                    note: '',
                    chapterTitle: 'The Complete Works of William Shakespeare',
                    cfi: 'ch_02_scene_02_soliloquy',
                    createdAt: 1786930860000,
                    color: '#efc040'
                };
                await db.saveHighlight(sampleHighlight4);

                if (window.app?.refreshBookshelf) await window.app.refreshBookshelf();
                await window.mobileShell?.renderHomeTab();
                await window.mobileShell?.renderShelfTab();
                await window.mobileShell?.renderNotesTab();
                window.mobileShell?.updateUserProfileDisplay('诶云朵？！');
                return { success: true };
            })()
        `);
        console.log('Setup sample data result:', setupResult);
        await SLEEP(1200);

        // 6. Test and Capture Screenshots
        console.log('[6/6] Verifying mobile UI states and capturing screenshots');

        // Screenshot 1: Template 11 Reading Home (阅读 首页)
        console.log('--- Verifying Template 11 Reading Home View ---');
        await evalExpr(`window.mobileShell.switchTab('home')`);
        await SLEEP(800);

        const homeTitle = await evalExpr(`document.querySelector('.mobile-reading-title')?.innerText`);
        const homeGreeting = await evalExpr(`document.getElementById('mobile-home-greeting')?.innerText`);
        const stageBookTitle = await evalExpr(`document.querySelector('.reading-stage-book-title')?.innerText`);
        const stageAuthor = await evalExpr(`document.querySelector('.reading-stage-book-author')?.innerText`);
        const cover3dPresent = await evalExpr(`Boolean(document.querySelector('.reading-book-cover-3d'))`);
        const peekBookPresent = await evalExpr(`Boolean(document.querySelector('.reading-peek-book'))`);
        const navBarBottom = await evalExpr(`window.getComputedStyle(document.getElementById('mobile-nav-bar')).bottom`);
        const globalFabExists = await evalExpr(`Boolean(document.getElementById('btn-mobile-global-fab'))`);
        const navLabelExists = await evalExpr(`Boolean(document.querySelector('.mobile-nav-label'))`);
        
        const stageCardHeight = await evalExpr(`document.getElementById('reading-stage-card')?.getBoundingClientRect().height`);
        const ghostCardPresent = await evalExpr(`Boolean(document.querySelector('.reading-peek-glass'))`);
        
        console.log('  Home Title:', homeTitle);
        console.log('  Home Greeting:', homeGreeting);
        console.log('  Stage Book Title:', stageBookTitle);
        console.log('  Stage Book Author:', stageAuthor);
        console.log('  Stage Card Height:', stageCardHeight);
        console.log('  3D Cover Present:', cover3dPresent);
        console.log('  Peek Slivers Present:', peekBookPresent);
        console.log('  Ghost Peek Glass Present:', ghostCardPresent);
        console.log('  Nav Bar Bottom:', navBarBottom);
        console.log('  Global FAB Exists in DOM:', globalFabExists);
        console.log('  Nav Label Exists in DOM:', navLabelExists);

        assert(homeTitle === '阅读', 'Home header title must be 阅读');
        assert(homeGreeting.includes('诶云朵？！'), 'Home greeting must address user nickname');
        assert(stageBookTitle.includes('堂吉诃德'), 'Reading stage must show current reading book title');
        assert(stageAuthor === '塞万提斯', 'Reading stage must show book author');
        assert(stageCardHeight >= 650, 'Reading stage container must stretch to fill vertical space (>650px on 844px screen)');
        assert(cover3dPresent === true, '3D book cover container must be present');
        assert(peekBookPresent === true, 'Peek slivers for adjacent books must be present');
        assert(ghostCardPresent === true, 'Ghost glass peek card must be present on the left in Template 11');
        assert(navBarBottom === '0px', 'Dock navigation bar must be flat pinned to bottom');
        assert(globalFabExists === false, 'Global FAB must not exist on reading home');
        assert(navLabelExists === false, 'Nav labels must not exist for Template 10 dock');

        await capture('template_11_reading_home.png');

        // Screenshot 2: Template 10 Notes View (想法 页)
        console.log('--- Verifying Template 10 Notes View ---');
        await evalExpr(`window.mobileShell.switchTab('notes')`);
        await SLEEP(800);

        const notesTitle = await evalExpr(`document.querySelector('.mobile-notes-title')?.innerText`);
        const notesCardsCount = await evalExpr(`document.querySelectorAll('.mobile-note-card').length`);
        const card1Title = await evalExpr(`document.querySelector('.note-card-title')?.innerText`);
        const card1Quote = await evalExpr(`document.querySelector('.note-quote-body')?.innerText`);
        const card1Thought = await evalExpr(`document.querySelector('.note-thought-body')?.innerText`);
        const notesFabDisplay = await evalExpr(`window.getComputedStyle(document.getElementById('btn-mobile-notes-fab')).display`);
        const fabSvgPath = await evalExpr(`document.querySelector('#btn-mobile-notes-fab svg path')?.getAttribute('d')`);
        
        console.log('  Notes Title:', notesTitle);
        console.log('  Notes Cards Count:', notesCardsCount);
        console.log('  Card 1 Title:', card1Title);
        console.log('  Card 1 Quote:', card1Quote);
        console.log('  Card 1 Thought:', card1Thought);
        console.log('  Notes FAB Display:', notesFabDisplay);
        console.log('  Notes FAB SVG Path:', fabSvgPath);

        assert(notesTitle === '想法', 'Notes header title must be 想法');
        assert(notesCardsCount === 4, 'Must have 4 sample note cards');
        assert(card1Title === '礼貌与距离', 'Card 1 title must be 礼貌与距离');
        assert(card1Quote.includes('Rosencrantz'), 'Card 1 quote text must be present');
        assert(card1Thought.includes('好朋友'), 'Card 1 thought body text must be present');
        assert(notesFabDisplay === 'flex', 'Notes FAB must be visible in notes tab');
        assert(fabSvgPath?.includes('M11 4H4'), 'Notes FAB must use Template 10 square-pen SVG');

        await capture('template_10_notes.png');

        // Screenshot 3: Template 14 Bookshelf View (书架)
        console.log('--- Verifying Bookshelf View ---');
        await evalExpr(`window.mobileShell.switchTab('shelf')`);
        await SLEEP(800);

        const shelfTitle = await evalExpr(`document.querySelector('#mobile-header-bar .mobile-header-title')?.innerText`);
        console.log('  Shelf Header Title:', shelfTitle);
        assert(shelfTitle === '书架', 'Bookshelf header title must be 书架');
        await capture('template_14_bookshelf.png');

        // Screenshot 4: Template 13 Settings & Profile View (我的 / 设置)
        console.log('--- Verifying Template 13 Settings / Me View ---');
        await evalExpr(`window.mobileShell.switchTab('me')`);
        await SLEEP(800);

        const groupTitle = await evalExpr(`document.querySelector('.mobile-group-title')?.innerText`);
        const groupTitleWeight = await evalExpr(`window.getComputedStyle(document.querySelector('.mobile-group-title')).fontWeight`);
        console.log('  Group Title:', groupTitle);
        console.log('  Group Title Font-Weight:', groupTitleWeight);
        assert(groupTitle === '阅读记录', 'Group title should be 阅读记录');
        await capture('template_13_settings.png');

        // Screenshot 5: Dark Theme for Template 11
        console.log('--- Verifying Dark Theme Reading Home ---');
        await evalExpr(`
            document.documentElement.setAttribute('data-theme', 'dark');
            window.mobileShell.switchTab('home');
        `);
        await SLEEP(800);
        await capture('template_11_home_dark.png');

        // Screenshot 6: Dark Theme for Template 10
        console.log('--- Verifying Dark Theme Notes ---');
        await evalExpr(`window.mobileShell.switchTab('notes')`);
        await SLEEP(800);
        await capture('template_10_notes_dark.png');

        // Reset theme back to light
        await evalExpr(`document.documentElement.removeAttribute('data-theme')`);

        console.log('=== All visual verifications passed successfully! ===');

    } finally {
        if (ws) ws.close();
        edgeProc.kill('SIGTERM');
        previewServer.kill('SIGTERM');
    }
}

main().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
