// scripts/verify-mobile-v11-cdp.mjs
// Automated verification & CDP screenshot capture for Linden Leaf Candidate v11 Reproduction (Images 12, 14, 15)

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const deliveryScreenshotsDir = 'D:\\LindenLeaf-Deliveries\\2026-10-10\\android-candidate-v11\\screenshots';
const brainArtifactsDir = 'C:\\Users\\YONGHU\\.gemini\\antigravity\\brain\\a99a6097-d48a-4ea2-b1ad-927d1982378c';

fs.mkdirSync(deliveryScreenshotsDir, { recursive: true });
fs.mkdirSync(brainArtifactsDir, { recursive: true });

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9467;
const previewPort = 18431;

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION FAILED] ${message}`);
    }
}

async function main() {
    console.log('=== Starting Candidate v11 Direct Reproduction Verification & Capture ===');

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
    const tempProfile = path.join(process.env.TEMP, `edge_mobile_v11_${Date.now()}`);
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

        // Set mobile viewport (Standard Android modern mobile viewport 390x844)
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
                localStorage.setItem('linden_streak_days', '5');
                const wModal = document.getElementById('welcome-modal-backdrop');
                if (wModal) {
                    wModal.style.display = 'none';
                    wModal.classList.remove('show');
                }
                const db = await import('./js/db.js');

                // Canvas cover for 乡土中国 (matching image 15_122.jpg)
                const canvas = document.createElement('canvas');
                canvas.width = 300;
                canvas.height = 420;
                const ctx = canvas.getContext('2d');
                const grad = ctx.createLinearGradient(0, 0, 300, 420);
                grad.addColorStop(0, '#3d5a45');
                grad.addColorStop(1, '#24382c');
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, 300, 420);
                ctx.fillStyle = '#fef3c7';
                ctx.fillRect(30, 40, 240, 160);
                ctx.fillStyle = '#1c1917';
                ctx.font = 'bold 28px serif';
                ctx.fillText('乡土中国', 70, 130);
                ctx.font = '16px serif';
                ctx.fillStyle = '#57534e';
                ctx.fillText('费孝通 著', 110, 170);
                const coverBlob1 = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));

                // Canvas cover for 堂吉诃德
                const canvas2 = document.createElement('canvas');
                canvas2.width = 300;
                canvas2.height = 420;
                const ctx2 = canvas2.getContext('2d');
                const grad2 = ctx2.createLinearGradient(0, 0, 300, 420);
                grad2.addColorStop(0, '#2c3e50');
                grad2.addColorStop(1, '#1a252f');
                ctx2.fillStyle = grad2;
                ctx2.fillRect(0, 0, 300, 420);
                ctx2.fillStyle = '#ffffff';
                ctx2.font = 'bold 26px serif';
                ctx2.fillText('堂吉诃德', 40, 110);
                ctx2.font = '16px sans-serif';
                ctx2.fillStyle = '#bdc3c7';
                ctx2.fillText('塞万提斯 著', 40, 150);
                const coverBlob2 = await new Promise(r => canvas2.toBlob(r, 'image/jpeg', 0.9));

                // Book 1: 乡土中国 (Currently reading, 95.2%)
                const sampleBook1 = {
                    id: 'sample_book_01',
                    title: '乡土中国',
                    author: '费孝通',
                    coverBlob: coverBlob1,
                    cover: null,
                    format: 'epub',
                    lastReadAt: Date.now() - 600000,
                    progress: {
                        fraction: 0.952,
                        cfi: 'ch_14_end',
                        updatedAt: Date.now() - 600000
                    },
                    readingStatus: 'reading',
                    status: 'reading',
                    totalReadingSeconds: 9600 // 2小时40分钟
                };
                await db.saveBook(sampleBook1);

                // Book 2: 堂吉诃德 (Reading)
                const sampleBook2 = {
                    id: 'sample_book_02',
                    title: '堂吉诃德',
                    author: '塞万提斯',
                    coverBlob: coverBlob2,
                    cover: null,
                    format: 'txt',
                    lastReadAt: Date.now() - 3600000,
                    progress: {
                        fraction: 0.42,
                        cfi: 'ch_01_p_05',
                        updatedAt: Date.now() - 3600000
                    },
                    readingStatus: 'reading',
                    status: 'reading',
                    totalReadingSeconds: 5400
                };
                await db.saveBook(sampleBook2);

                // Book 3: 百年孤独 (Finished)
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

                // Book 4: 尤利西斯 (Shelved)
                const sampleBook4 = {
                    id: 'sample_book_04',
                    title: '尤利西斯',
                    author: '詹姆斯·乔伊斯',
                    coverBlob: null,
                    cover: null,
                    format: 'epub',
                    lastReadAt: Date.now() - 172800000,
                    progress: {
                        fraction: 0.12,
                        cfi: 'ch_02',
                        updatedAt: Date.now() - 172800000
                    },
                    readingStatus: 'on_hold',
                    status: 'on_hold',
                    totalReadingSeconds: 2200
                };
                await db.saveBook(sampleBook4);

                // Sample Highlights matching Template 10
                const sampleHighlight1 = {
                    id: 'hl_sample_01',
                    bookId: 'sample_book_01',
                    title: '礼貌与距离',
                    text: '[To Rosencrantz and Guildenstern] My good friends, I\\'ll leave you till night. You are welcome to Elsinore.',
                    note: '“好朋友”听来亲近，哈姆雷特却让他们离开，才独自开口。礼貌维持着距离：有欢迎，却非交心，仍有保留。',
                    chapterTitle: '乡土中国 导言',
                    cfi: 'ch_02_scene_02',
                    createdAt: 1786930860000,
                    color: '#d5cec5'
                };
                await db.saveHighlight(sampleHighlight1);

                const sampleHighlight2 = {
                    id: 'hl_sample_02',
                    bookId: 'sample_book_01',
                    title: '差序格局与礼数',
                    text: '从己到家，从家到国，从国到天下，是一层层推出去的。',
                    note: '在这个大家庭里，细小的礼数记录着每个人的位置：照拂显出亲疏，而谁必须留意谁，也显出身份。',
                    chapterTitle: '差序格局',
                    cfi: 'ch_04',
                    createdAt: 1786930860000,
                    color: '#d5cec5'
                };
                await db.saveHighlight(sampleHighlight2);

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

        // =========================================================================
        // Test 1: Reading Home (首页 - Direct Reproduction of Images 12 & 15)
        // =========================================================================
        console.log('--- Verifying Home Page (12_122.jpg & 15_122.jpg Reproduction) ---');
        await evalExpr(`window.mobileShell.switchTab('home')`);
        await SLEEP(800);

        const homeTitle = await evalExpr(`document.querySelector('.mobile-home-title')?.innerText`);
        const refreshBtnExists = await evalExpr(`Boolean(document.getElementById('btn-home-refresh'))`);
        const menuBtnExists = await evalExpr(`Boolean(document.getElementById('btn-home-menu'))`);

        // Card 1
        const card1Exists = await evalExpr(`Boolean(document.getElementById('home-card-cumulative'))`);
        const card1Text = await evalExpr(`document.getElementById('home-cumulative-sub')?.innerText`);

        // Card 2 (Hero Card)
        const heroCardExists = await evalExpr(`Boolean(document.getElementById('home-hero-card'))`);
        const heroBookTitle = await evalExpr(`document.querySelector('.home-hero-book-title')?.innerText`);
        const heroAuthor = await evalExpr(`document.querySelector('.home-hero-book-author')?.innerText`);
        const heroProgress = await evalExpr(`document.querySelector('.home-hero-progress-pct')?.innerText`);
        const heroStreak = await evalExpr(`document.querySelector('.home-hero-streak-badge')?.innerText`);
        const heroTime = await evalExpr(`document.querySelector('.home-hero-time')?.innerText`);
        const heroContinue = await evalExpr(`document.querySelector('.home-hero-action')?.innerText`);

        // Card 3 (Today's Goals)
        const goalsCardExists = await evalExpr(`Boolean(document.getElementById('home-goals-card'))`);
        const goalsTitle = await evalExpr(`document.querySelector('.home-goals-title')?.innerText`);
        const goalsSub = await evalExpr(`document.querySelector('.home-goals-encouragement')?.innerText`);

        // Card 4 (Random Recommendations)
        const recsCardExists = await evalExpr(`Boolean(document.getElementById('home-recs-card'))`);
        const recsTitle = await evalExpr(`document.querySelector('.home-recs-title')?.innerText`);
        const recsCount = await evalExpr(`document.querySelectorAll('.home-rec-item').length`);

        // Ergonomic safe-area bound checks (Fixing the cramped top/bottom issue)
        const homeTopPadding = await evalExpr(`parseInt(window.getComputedStyle(document.querySelector('.mobile-home-top-bar')).paddingTop)`);
        const dockBottomPadding = await evalExpr(`parseInt(window.getComputedStyle(document.getElementById('mobile-nav-bar')).paddingBottom)`);
        const dockHeight = await evalExpr(`parseInt(window.getComputedStyle(document.getElementById('mobile-nav-bar')).height)`);
        const navLabels = await evalExpr(`Array.from(document.querySelectorAll('.mobile-nav-label')).map(el => el.innerText)`);

        console.log('  Home Title:', homeTitle);
        console.log('  Refresh & Menu buttons:', refreshBtnExists, menuBtnExists);
        console.log('  Card 1 (Cumulative):', card1Exists, '| Stats:', card1Text);
        console.log('  Card 2 (Hero):', heroCardExists, '| Title:', heroBookTitle, '| Author:', heroAuthor, '| Pct:', heroProgress, '| Streak:', heroStreak, '| Time:', heroTime);
        console.log('  Card 3 (Goals):', goalsCardExists, '| Title:', goalsTitle);
        console.log('  Card 4 (Recs):', recsCardExists, '| Items count:', recsCount);
        console.log('  Top Bar paddingTop (should >= 44px):', homeTopPadding, 'px');
        console.log('  Dock paddingBottom (should >= 28px):', dockBottomPadding, 'px');
        console.log('  Dock height (should >= 84px):', dockHeight, 'px');
        console.log('  Dock Navigation Labels:', navLabels);

        assert(homeTitle === '首页', 'Home title must be 首页');
        assert(refreshBtnExists && menuBtnExists, 'Home top bar must have refresh and menu action buttons');
        assert(card1Exists === true, 'Card 1 累计阅读卡 must be present');
        assert(card1Text?.includes('小时') && card1Text?.includes('本'), 'Card 1 must show reading time and books');
        assert(heroCardExists === true, 'Card 2 正在读主角卡 must be present');
        assert(heroBookTitle.includes('乡土中国'), 'Hero card title must show currently reading book');
        assert(heroAuthor === '费孝通', 'Hero card must show book author');
        assert(heroProgress.includes('%'), 'Hero card must show reading progress percentage');
        assert(heroStreak.includes('连续阅读 5 天'), 'Hero card must show reading streak');
        assert(heroTime.includes('本书已读'), 'Hero card must show reading duration for book');
        assert(heroContinue.includes('继续阅读'), 'Hero card must have 继续阅读 action');
        assert(goalsCardExists === true, 'Card 3 今日目标卡 must be present');
        assert(goalsTitle === '今日目标', 'Card 3 title must be 今日目标');
        assert(goalsSub.includes('阅读目标已经完成'), 'Card 3 must show encouraging subtitle');
        assert(recsCardExists === true, 'Card 4 随机推荐 must be present');
        assert(recsTitle.includes('随机推荐'), 'Card 4 title must be 随机推荐');
        assert(recsCount >= 1, 'Card 4 must display book items');
        assert(homeTopPadding >= 44, 'Top safe area padding must be at least 44px');
        assert(dockBottomPadding >= 28, 'Bottom safe area padding must be at least 28px');
        assert(dockHeight >= 84, 'Bottom dock height must include 28px cushion');
        assert(navLabels.includes('首页') && navLabels.includes('书架') && navLabels.includes('想法') && navLabels.includes('我的'), 'Dock must include 4 legible labels');

        await capture('v11_01_home_reproduction.png');

        // =========================================================================
        // Test 2: Bookshelf (书架 - Direct Reproduction of Images 14 & 15 right half)
        // =========================================================================
        console.log('--- Verifying Bookshelf View (14_122.jpg & 15_122.jpg Reproduction) ---');
        await evalExpr(`window.mobileShell.switchTab('shelf')`);
        await SLEEP(800);

        const shelfTitle = await evalExpr(`document.querySelector('#mobile-header-bar .mobile-header-title')?.innerText`);
        const segButtons = await evalExpr(`Array.from(document.querySelectorAll('.shelf-seg-btn')).map(b => b.innerText.trim())`);
        const searchInputText = await evalExpr(`document.querySelector('#mobile-shelf-search-bar .mobile-shelf-search-inner span')?.innerText`);
        const shelfTopPadding = await evalExpr(`parseInt(window.getComputedStyle(document.getElementById('mobile-header-bar')).paddingTop)`);

        console.log('  Shelf Header Title:', shelfTitle);
        console.log('  Segmented Control Tabs:', segButtons);
        console.log('  Search Bar Text:', searchInputText);
        console.log('  Shelf Header paddingTop (should >= 44px):', shelfTopPadding, 'px');

        assert(shelfTitle === '书架', 'Bookshelf title must be 书架');
        assert(segButtons.some(t => t.includes('全部')), 'Segmented control must include 全部');
        assert(segButtons.some(t => t.includes('在读')), 'Segmented control must include 在读');
        assert(segButtons.some(t => t.includes('搁置')), 'Segmented control must include 搁置');
        assert(segButtons.some(t => t.includes('读完')), 'Segmented control must include 读完');
        assert(searchInputText?.includes('搜索'), 'Search bar must display search prompt');
        assert(shelfTopPadding >= 44, 'Shelf header top padding must be at least 44px');

        // Test filtering: switch to 读完
        await evalExpr(`document.querySelector('.shelf-seg-btn[data-filter="finished"]')?.click()`);
        await SLEEP(400);
        const finishedCountText = await evalExpr(`document.querySelector('#mobile-shelf-search-bar .mobile-shelf-search-inner span')?.innerText`);
        console.log('  Finished filter search prompt:', finishedCountText);
        assert(finishedCountText.includes('搜索 1 本书'), 'Filter finished should show 搜索 1 本书');

        // Reset filter to all
        await evalExpr(`document.querySelector('.shelf-seg-btn[data-filter="all"]')?.click()`);
        await SLEEP(400);

        await capture('v11_02_bookshelf_tabs.png');

        // Test Context Action Menu (14_122.jpg 9 options)
        console.log('--- Verifying Bookshelf Context Action Sheet (14_122.jpg) ---');
        await evalExpr(`window.mobileShell.openBookActionSheet('sample_book_01')`);
        await SLEEP(600);

        const actSheetTitle = await evalExpr(`document.getElementById('action-sheet-book-title')?.innerText`);
        const actItems = await evalExpr(`
            Array.from(document.querySelectorAll('#mobile-book-action-sheet .mobile-cell-item .mobile-cell-label'))
                .map(el => el.innerText.trim())
        `);
        console.log('  Action Sheet Book Title:', actSheetTitle);
        console.log('  Action Sheet Items:', actItems);

        assert(actSheetTitle === '乡土中国', 'Action sheet title must match book');
        assert(actItems.includes('信息'), 'Must include 信息');
        assert(actItems.includes('编辑信息'), 'Must include 编辑信息');
        assert(actItems.includes('标签'), 'Must include 标签');
        assert(actItems.includes('分类'), 'Must include 分类');
        assert(actItems.includes('加入书单'), 'Must include 加入书单');
        assert(actItems.includes('标记为...'), 'Must include 标记为...');
        assert(actItems.includes('选择'), 'Must include 选择');
        assert(actItems.includes('移除'), 'Must include 移除');
        assert(actItems.includes('更多'), 'Must include 更多');

        await capture('v11_03_bookshelf_context_menu.png');

        // Test 2b: Share Action Sheet (Triggered by 更多 >)
        console.log('--- Verifying Share Action Sheet (14_122.jpg Reproduction) ---');
        await evalExpr(`document.getElementById('act-sheet-more')?.click()`);
        await SLEEP(600);

        const shareSheetOpen = await evalExpr(`document.getElementById('mobile-share-action-sheet')?.classList.contains('open')`);
        const shareSheetTitle = await evalExpr(`document.getElementById('share-sheet-book-title')?.innerText`);
        const shareItems = await evalExpr(`
            Array.from(document.querySelectorAll('#mobile-share-action-sheet .mobile-cell-item .mobile-cell-label'))
                .map(el => el.innerText.trim())
        `);
        console.log('  Share Sheet Open:', shareSheetOpen, '| Title:', shareSheetTitle);
        console.log('  Share Sheet Options:', shareItems);

        assert(shareSheetOpen === true, 'Share action sheet must open when clicking 更多');
        assert(shareSheetTitle === '乡土中国', 'Share sheet title must match book');
        assert(shareItems.includes('分享文件'), 'Share sheet must include 分享文件');
        assert(shareItems.includes('分享统计海报'), 'Share sheet must include 分享统计海报');
        assert(shareItems.includes('分享页面截图'), 'Share sheet must include 分享页面截图');
        assert(shareItems.includes('保存到本地'), 'Share sheet must include 保存到本地');

        await capture('v11_10_share_action_sheet.png');
        await evalExpr(`window.mobileShell.closeAllSheets()`);
        await SLEEP(300);

        // Test 2c: Bookshelf List Mode toggle (via Floating Palette Button)
        console.log('--- Verifying Bookshelf List Mode (14_122.jpg Reproduction) ---');
        await evalExpr(`document.getElementById('btn-mobile-palette')?.click()`);
        await SLEEP(400);

        const isListMode = await evalExpr(`document.getElementById('books-grid')?.classList.contains('is-list-mode')`);
        const moreBtnsCount = await evalExpr(`document.querySelectorAll('.mobile-book-more-btn').length`);
        console.log('  Bookshelf is-list-mode active:', isListMode);
        console.log('  Book more buttons (···) rendered:', moreBtnsCount);

        assert(isListMode === true, 'Clicking palette button should toggle is-list-mode');
        assert(moreBtnsCount >= 4, 'Every book card must have a ··· more options button');

        // Test clicking the ··· button directly in list mode
        await evalExpr(`document.querySelector('.jane-book-card .mobile-book-more-btn')?.click()`);
        await SLEEP(500);
        const listActOpen = await evalExpr(`document.getElementById('mobile-book-action-sheet')?.classList.contains('open')`);
        assert(listActOpen === true, 'Clicking ··· in list mode must open action sheet');
        await evalExpr(`window.mobileShell.closeAllSheets()`);
        await SLEEP(300);

        await capture('v11_09_bookshelf_list_mode.png');

        // Toggle back to default layout
        await evalExpr(`document.getElementById('btn-mobile-palette')?.click()`);
        await SLEEP(300);

        // Test 2d: Goal Edit Sheet on Home Tab
        console.log('--- Verifying Goal Edit Bottom Sheet (12_122.jpg & 15_122.jpg) ---');
        await evalExpr(`window.mobileShell.switchTab('home')`);
        await SLEEP(600);
        await evalExpr(`document.getElementById('btn-goal-edit')?.click()`);
        await SLEEP(500);

        const goalSheetOpen = await evalExpr(`document.getElementById('mobile-goal-edit-sheet')?.classList.contains('open')`);
        assert(goalSheetOpen === true, 'Goal edit bottom sheet must open when clicking edit icon');
        await capture('v11_11_goal_edit_sheet.png');

        // Change goal to 3 hours (180 mins) and save
        await evalExpr(`
            document.querySelector('#goal-time-options .goal-pill-btn[data-time="180"]')?.click();
            document.getElementById('btn-save-reading-goal')?.click();
        `);
        await SLEEP(500);

        const updatedGoalTarget = await evalExpr(`document.querySelector('#home-goals-card')?.innerText`);
        assert(updatedGoalTarget.includes('3 小时'), 'Goal card must reflect the updated 3 hours target');
        console.log('  Goal successfully updated to 3 hours target!');

        // =========================================================================
        // Test 3: Notes (想法 - Template 10 Preserved!)
        // =========================================================================
        console.log('--- Verifying Notes View (Template 10 Preserved) ---');
        await evalExpr(`window.mobileShell.switchTab('notes')`);
        await SLEEP(800);

        const notesTitle = await evalExpr(`document.querySelector('.mobile-notes-title')?.innerText`);
        const notesCardsCount = await evalExpr(`document.querySelectorAll('.mobile-note-card').length`);
        const notesTopPadding = await evalExpr(`parseInt(window.getComputedStyle(document.querySelector('.mobile-notes-header')).paddingTop)`);
        const fabBottom = await evalExpr(`parseInt(window.getComputedStyle(document.getElementById('btn-mobile-notes-fab')).bottom)`);

        console.log('  Notes Title:', notesTitle);
        console.log('  Notes Count:', notesCardsCount);
        console.log('  Notes paddingTop (should >= 44px):', notesTopPadding, 'px');
        console.log('  Notes FAB bottom (should >= 84px):', fabBottom, 'px');

        assert(notesTitle === '想法', 'Notes title must be 想法');
        assert(notesCardsCount >= 2, 'Notes must display cards');
        assert(notesTopPadding >= 44, 'Notes header paddingTop must be at least 44px');
        assert(fabBottom >= 84, 'Notes FAB must float comfortably above the dock');

        await capture('v11_04_notes_template10.png');

        // =========================================================================
        // Test 4: Me / Profile View
        // =========================================================================
        console.log('--- Verifying Profile & Settings View ---');
        await evalExpr(`window.mobileShell.switchTab('me')`);
        await SLEEP(800);
        await capture('v11_05_profile_settings.png');

        // =========================================================================
        // Test 5: Dark Theme Visual Checks
        // =========================================================================
        console.log('--- Verifying Dark Theme Home, Shelf, and Notes ---');
        await evalExpr(`
            document.documentElement.setAttribute('data-theme', 'dark');
            window.mobileShell.switchTab('home');
        `);
        await SLEEP(800);
        await capture('v11_06_home_dark.png');

        await evalExpr(`window.mobileShell.switchTab('shelf')`);
        await SLEEP(800);
        await capture('v11_07_bookshelf_dark.png');

        await evalExpr(`window.mobileShell.switchTab('notes')`);
        await SLEEP(800);
        await capture('v11_08_notes_dark.png');

        // Reset theme back to light
        await evalExpr(`document.documentElement.removeAttribute('data-theme')`);

        console.log('=== All Candidate v11 visual verifications passed successfully! ===');

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
