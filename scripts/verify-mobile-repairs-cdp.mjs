// scripts/verify-mobile-repairs-cdp.mjs
// Automated verification & screenshot capture for Linden Leaf Mobile UI Repairs (Candidate v4)

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const deliveryScreenshotsDir = 'D:\\LindenLeaf-Deliveries\\2026-10-10\\android-candidate-v9\\screenshots';
const brainArtifactsDir = 'C:\\Users\\YONGHU\\.gemini\\antigravity\\brain\\078bd2d3-0278-4dea-88bc-42bea56fbcc7';

fs.mkdirSync(deliveryScreenshotsDir, { recursive: true });
fs.mkdirSync(brainArtifactsDir, { recursive: true });

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const debugPort = 9455;
const previewPort = 18420;

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function assert(condition, message) {
    if (!condition) {
        throw new Error(`[ASSERTION FAILED] ${message}`);
    }
}

async function main() {
    console.log('=== Starting Candidate v4 Mobile UI Repairs Verification & CDP Capture ===');

    // 1. Start Preview Server
    console.log('[1/6] Launching Preview Server on port', previewPort);
    const previewServer = spawn(process.execPath, ['scripts/preview-server.mjs'], {
        cwd: rootDir,
        stdio: 'pipe'
    });

    await SLEEP(1200);

    // 2. Launch Edge in headless mode with remote debugging
    console.log('[2/6] Launching Edge browser (CDP port:', debugPort, ')');
    const tempProfile = path.join(process.env.TEMP, `edge_mobile_verify_${Date.now()}`);
    fs.mkdirSync(tempProfile, { recursive: true });

    const edgeProc = spawn(edgeExe, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${tempProfile}`,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
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
        console.log('[5/6] Injecting test reading data into IndexedDB (Sample 1: Canvas Cover Blob, Sample 2: No Cover Fallback)');
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

                // Generate Canvas Cover Blob for Book 1
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
                const coverBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));

                const sampleBook1 = {
                    id: 'sample_book_01',
                    title: '堂吉诃德 (精校注释本)',
                    author: '塞万提斯',
                    coverBlob: coverBlob,
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

                // Book 2 has NO cover image, demonstrating the editorial fallback
                const sampleBook2 = {
                    id: 'sample_book_02',
                    title: '中国哲学简史',
                    author: '冯友兰',
                    coverBlob: null,
                    cover: null,
                    format: 'epub',
                    lastReadAt: Date.now() - 7200000,
                    progress: {
                        fraction: 0.18,
                        cfi: 'epub_ch_02',
                        updatedAt: Date.now() - 7200000
                    },
                    readingStatus: 'reading',
                    totalReadingSeconds: 3600
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

                const sampleBook4 = {
                    id: 'sample_book_04',
                    title: '月亮与六便士',
                    author: '毛姆',
                    coverBlob: null,
                    cover: null,
                    format: 'epub',
                    lastReadAt: 0,
                    progress: {
                        fraction: 0,
                        cfi: null,
                        updatedAt: 0
                    },
                    readingStatus: 'unread',
                    totalReadingSeconds: 0
                };
                await db.saveBook(sampleBook4);

                const sampleBook5 = {
                    id: 'sample_book_05',
                    title: '人类简史',
                    author: '尤瓦尔·赫拉利',
                    coverBlob: null,
                    cover: null,
                    format: 'epub',
                    lastReadAt: 0,
                    progress: {
                        fraction: 0,
                        cfi: null,
                        updatedAt: 0
                    },
                    readingStatus: 'unread',
                    totalReadingSeconds: 0
                };
                await db.saveBook(sampleBook5);

                const sampleHighlight1 = {
                    id: 'hl_sample_01',
                    bookId: 'sample_book_01',
                    text: '自由，桑丘，是上天赐予人类最宝贵的恩物之一；地里埋藏的财宝和大海淹没的珍珠都比不上它。',
                    note: '堂吉诃德关于自由的经典独白，行文沉稳隽永。',
                    chapterTitle: '第五十八章 桑丘与堂吉诃德论自由',
                    cfi: 'ch_58_para_02',
                    createdAt: Date.now() - 1800000,
                    color: '#da7756'
                };
                await db.saveHighlight(sampleHighlight1);

                const sampleHighlight2 = {
                    id: 'hl_sample_02',
                    bookId: 'sample_book_02',
                    text: '人往往需要说很多话，然后才能归入圣洁的寂静。',
                    note: '中国哲学中关于言意之辨的精辟阐述。',
                    chapterTitle: '第十章 儒家的理想主义',
                    cfi: 'ch_10_para_01',
                    createdAt: Date.now() - 3600000,
                    color: '#10b981'
                };
                await db.saveHighlight(sampleHighlight2);

                const sampleHighlight3 = {
                    id: 'hl_sample_03',
                    bookId: 'sample_book_03',
                    text: '生命中真正重要的不是你遭遇了什么，而是你记住了哪些事，又是如何铭记的。',
                    note: '',
                    chapterTitle: '第二十章 终章',
                    cfi: 'ch_20_para_05',
                    createdAt: Date.now() - 86400000,
                    color: '#f59e0b'
                };
                await db.saveHighlight(sampleHighlight3);

                const sampleSession = {
                    id: 'sess_sample_01',
                    bookId: 'sample_book_01',
                    startTime: Date.now() - 7200000,
                    endTime: Date.now() - 3600000,
                    date: new Date().toISOString().slice(0, 10),
                    durationSeconds: 3600,
                    activeDurationSeconds: 3600,
                    seconds: 3600
                };
                await db.saveReadingSession(sampleSession);

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

        // Screenshot 1: Home View (首页 - Daily Welcome, Hero Card, Floating Capsule Nav)
        console.log('--- Verifying Home View ---');
        await evalExpr(`window.mobileShell.switchTab('home')`);
        await SLEEP(800);

        const homeGreeting = await evalExpr(`document.getElementById('mobile-home-greeting')?.innerText`);
        const heroTitle = await evalExpr(`document.querySelector('.hero-book-title')?.innerText`);
        const heroPct = await evalExpr(`document.querySelector('.hero-progress-text')?.innerText`);
        const navBarBottom = await evalExpr(`window.getComputedStyle(document.getElementById('mobile-nav-bar')).bottom`);
        const navBarRadius = await evalExpr(`window.getComputedStyle(document.getElementById('mobile-nav-bar')).borderRadius`);
        const globalFabDisplay = await evalExpr(`window.getComputedStyle(document.getElementById('btn-mobile-global-fab')).display`);
        console.log('  Home Greeting:', homeGreeting);
        console.log('  Hero Book Title:', heroTitle);
        console.log('  Hero Progress:', heroPct);
        console.log('  Bottom Nav Bar bottom offset:', navBarBottom);
        console.log('  Bottom Nav Bar border radius:', navBarRadius);
        console.log('  Global FAB display:', globalFabDisplay);
        assert(homeGreeting.includes('诶云朵？！'), 'Home greeting must address user nickname');
        assert(heroTitle === '堂吉诃德 (精校注释本)', 'Hero title must be 堂吉诃德 (精校注释本)');
        assert(heroPct === '已读 42%', 'Hero progress must show 已读 42%');
        assert(parseInt(navBarBottom, 10) > 0, 'Navigation bar must be floating capsule dock above bottom');
        assert(parseInt(navBarRadius, 10) > 10, 'Navigation bar must have capsule border radius');
        assert(globalFabDisplay === 'flex', 'Floating action button must be visible on home view');
        await capture('mobile_1_home.png');

        // Screenshot 2: Bookshelf View (书架 - Shelf Search Bar, Book Grid, Segmented Control)
        console.log('--- Verifying Bookshelf View ---');
        await evalExpr(`window.mobileShell.switchTab('shelf')`);
        await SLEEP(800);

        const shelfTitle = await evalExpr(`document.querySelector('#mobile-header-bar .mobile-header-title')?.innerText`);
        const shelfBookCount = await evalExpr(`document.getElementById('mobile-shelf-book-count')?.innerText`);
        const shelfSearchBar = await evalExpr(`Boolean(document.getElementById('mobile-shelf-search-bar'))`);
        const shelfSegControl = await evalExpr(`Boolean(document.getElementById('mobile-shelf-segmented-control'))`);
        const footerStatusDisplay = await evalExpr(`window.getComputedStyle(document.querySelector('.jane-footer-status')).display`);
        console.log('  Shelf Header Title:', shelfTitle);
        console.log('  Shelf Book Count:', shelfBookCount);
        console.log('  Shelf Search Bar present:', shelfSearchBar);
        console.log('  Shelf Segmented Control present:', shelfSegControl);
        console.log('  Desktop Footer Status display:', footerStatusDisplay);
        assert(shelfTitle === '书架', 'Bookshelf header title must be 书架');
        assert(shelfBookCount.includes('5'), 'Bookshelf count must show 5 books');
        assert(shelfSearchBar === true, 'Bookshelf search bar must be present');
        assert(shelfSegControl === true, 'Bookshelf segmented control must be present');
        assert(footerStatusDisplay === 'none', 'Desktop footer status must be hidden');
        await capture('mobile_2_bookshelf.png');

        // Screenshot 3: Notes View (笔记 / 想法 - Section 8 Style)
        console.log('--- Verifying Notes View (Section 8 Style) ---');
        await evalExpr(`window.mobileShell.switchTab('notes')`);
        await SLEEP(800);

        const notesHeader = await evalExpr(`document.querySelector('#mobile-notes-view .mobile-header-title')?.innerText`);
        const notesCount = await evalExpr(`document.getElementById('mobile-notes-count')?.innerText`);
        const noteSource = await evalExpr(`document.querySelector('.note-source-title')?.innerText`);
        const quoteFontStyle = await evalExpr(`window.getComputedStyle(document.querySelector('.note-quote-body')).fontStyle`);
        const thoughtBody = await evalExpr(`document.querySelector('.note-thought-body')?.innerText`);
        console.log('  Notes Header Title:', notesHeader);
        console.log('  Notes Count:', notesCount);
        console.log('  Note Source:', noteSource);
        console.log('  Quote font-style:', quoteFontStyle);
        assert(notesHeader === '笔记' || notesHeader === '想法' || notesHeader === '我的笔记', 'Notes header title must be 笔记');
        assert(notesCount.includes('3'), 'Notes count should show 3');
        assert(noteSource.includes('堂吉诃德'), 'Note source must cite book title');
        assert(quoteFontStyle === 'normal', 'Note quote must be upright text (font-style: normal)');
        assert(thoughtBody.includes('堂吉诃德关于自由的经典独白'), 'Thought body text must be present');
        await capture('mobile_3_notes.png');

        // Screenshot 4: Search View (搜索)
        console.log('--- Verifying Search View ---');
        await evalExpr(`
            window.mobileShell.switchTab('search');
            const inp = document.getElementById('mobile-search-input');
            if (inp) {
                inp.value = '自由';
                inp.dispatchEvent(new Event('input'));
            }
        `);
        await SLEEP(700);

        const searchResultsCount = await evalExpr(`document.querySelectorAll('.search-result-note-item').length`);
        const searchBackBtn = await evalExpr(`Boolean(document.getElementById('btn-mobile-search-back'))`);
        console.log('  Search results count for "自由":', searchResultsCount);
        console.log('  Search back button present:', searchBackBtn);
        assert(searchResultsCount >= 1, 'Search should find note matching 自由');
        assert(searchBackBtn === true, 'Search view must have a back button');
        await capture('mobile_4_search.png');

        // Test Back press from search: should return to shelf
        console.log('  Testing Back from Search...');
        const backFromSearch = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(backFromSearch === true, 'Back press from search must be handled');
        const tabAfterSearchBack = await evalExpr(`window.mobileShell.currentTab`);
        console.log('  Tab after back from search:', tabAfterSearchBack);
        assert(tabAfterSearchBack === 'shelf', 'Back press from search must return to shelf');

        // Screenshot 5: Me View (我的 - 3-Column Stats Card, Groups)
        console.log('--- Verifying Me View ---');
        await evalExpr(`window.mobileShell.switchTab('me')`);
        await SLEEP(700);

        const meName = await evalExpr(`document.getElementById('mobile-user-name')?.innerText`);
        const meHours = await evalExpr(`document.getElementById('mobile-stat-hours')?.innerText`);
        const meBooks = await evalExpr(`document.getElementById('mobile-stat-books')?.innerText`);
        const meNotes = await evalExpr(`document.getElementById('mobile-stat-notes')?.innerText`);
        console.log('  Me Profile Name:', meName);
        console.log('  Me Stats Card:', { hours: meHours, books: meBooks, notes: meNotes });
        assert(meName === '诶云朵？！', 'Me view username must be 诶云朵？！');
        assert(parseInt(meHours, 10) >= 1, 'Reading hours should be at least 1');
        assert(parseInt(meBooks, 10) === 5, 'Books count should be 5');
        assert(parseInt(meNotes, 10) === 3, 'Notes count should be 3');
        await capture('mobile_5_me.png');

        // Screenshot 6: Reader View with Immersive Tools and Display Sheet
        console.log('--- Verifying Reader Tools and Display Sheet ---');
        await evalExpr(`
            window.mobileShell.setReaderInView(true);
            window.mobileShell.setReaderToolsVisible(true, '堂吉诃德 (精校注释本)');
            window.mobileShell.openSheet('display');
        `);
        await SLEEP(800);

        const displaySheetOpen = await evalExpr(`document.getElementById('mobile-display-sheet')?.classList.contains('open')`);
        console.log('  Display sheet open:', displaySheetOpen);
        assert(displaySheetOpen === true, 'Display sheet must be open');
        await capture('mobile_6_reader_display.png');

        // Screenshot 7: Now Playing Expanded Sheet
        console.log('--- Verifying Now Playing Sheet ---');
        await evalExpr(`
            window.mobileShell.closeAllSheets();
            window.mobileShell.setReaderToolsVisible(false);
            window.mobileShell.setReaderInView(false);
            window.mobileShell.switchTab('home');
            window.mobileShell.openNowPlayingSheet();
        `);
        await SLEEP(800);

        const nowPlayingOpen = await evalExpr(`document.getElementById('mobile-now-playing-sheet')?.classList.contains('open')`);
        const npTitle = await evalExpr(`document.getElementById('np-book-title')?.innerText`);
        const npHasFallbackOrCover = await evalExpr(`Boolean(document.querySelector('#np-artwork-wrap img, #np-artwork-wrap .editorial-cover-fallback'))`);
        console.log('  Now playing sheet open:', nowPlayingOpen);
        console.log('  Now playing title:', npTitle);
        console.log('  Now playing artwork rendered:', npHasFallbackOrCover);
        assert(nowPlayingOpen === true, 'Now playing sheet must open');
        assert(npHasFallbackOrCover === true, 'Now playing must render artwork or editorial fallback');
        await capture('mobile_7_now_playing.png');

        // Test Back Press Hierarchy
        console.log('--- Verifying Back Press Hierarchy ---');
        // 1. In Now Playing -> collapses Now Playing
        const bp1 = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(bp1 === true, 'Back press 1 must collapse Now Playing sheet');
        const npStateAfter = await evalExpr(`window.mobileShell.isNowPlayingOpen`);
        assert(npStateAfter === false, 'Now Playing must be closed after back');

        // 2. Open Display sheet -> back closes Display sheet
        await evalExpr(`window.mobileShell.openSheet('display')`);
        const bp2 = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(bp2 === true, 'Back press 2 must close bottom sheet');
        const sheetAfter = await evalExpr(`window.mobileShell.activeSheet === null`);
        assert(sheetAfter === true, 'Bottom sheet must be null');

        // 3. Reader tools visible -> back hides reader tools
        await evalExpr(`window.mobileShell.setReaderToolsVisible(true)`);
        const bp3 = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(bp3 === true, 'Back press 3 must hide reader tools');
        const toolsVisible = await evalExpr(`window.mobileShell.readerToolsVisible`);
        assert(toolsVisible === false, 'Reader tools must be hidden');

        // 4. On secondary tab (notes) -> back returns to home
        await evalExpr(`window.mobileShell.switchTab('notes')`);
        const bp4 = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(bp4 === true, 'Back press 4 must navigate back to home');
        const tabAfterNotes = await evalExpr(`window.mobileShell.currentTab`);
        console.log('  Tab after back from notes:', tabAfterNotes);
        assert(tabAfterNotes === 'home', 'Back press from notes must return to home');

        // 5. On shelf tab -> back returns to home
        await evalExpr(`window.mobileShell.switchTab('shelf')`);
        const bp5 = await evalExpr(`window.mobileShell.handleBackPress()`);
        assert(bp5 === true, 'Back press 5 must navigate back to home');
        const tabAfterShelf = await evalExpr(`window.mobileShell.currentTab`);
        console.log('  Tab after back from shelf:', tabAfterShelf);
        assert(tabAfterShelf === 'home', 'Back press from shelf must return to home');

        console.log('=== All 7 mobile screenshots captured and verifications passed with 100% success! ===');

    } finally {
        if (ws) ws.close();
        edgeProc.kill();
        previewServer.kill();
        try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch (_) {}
    }
}

main().catch(err => {
    console.error('Mobile verification failed:', err);
    process.exit(1);
});
