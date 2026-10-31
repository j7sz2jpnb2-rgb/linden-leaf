import { spawn } from 'node:child_process';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const previewPort = 18446;
const debugPort = 9476;
const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const srv = spawn(process.execPath, ['scripts/preview-server.mjs'], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(previewPort) }
});
for (let i = 0; i < 30; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${previewPort}/health`);
        if (r.ok) break;
    } catch {}
    await SLEEP(200);
}

const edge = spawn(edgeExe, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${process.env.TEMP}\\edge_audit_${Date.now()}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `http://127.0.0.1:${previewPort}/index.html`
], { stdio: 'ignore' });

try {
    let wsUrl;
    for (let i = 0; i < 40; i++) {
        await SLEEP(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
            const page = list.find(t => t.type === 'page');
            if (page?.webSocketDebuggerUrl) {
                wsUrl = page.webSocketDebuggerUrl;
                break;
            }
        } catch {}
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = e => {
        const d = JSON.parse(e.data);
        if (d.id && pending.has(d.id)) {
            pending.get(d.id)(d);
            pending.delete(d.id);
        }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const mId = ++id;
        pending.set(mId, r => r.error ? rej(new Error(r.error.message)) : res(r.result));
        ws.send(JSON.stringify({ id: mId, method, params }));
    });
    const evalExpr = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${previewPort}/index.html` });
    await SLEEP(2500);

    const report = await evalExpr(`
    (async () => {
        const toRect = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
        };
        localStorage.setItem('linden_user_initialized', 'true');
        document.getElementById('welcome-modal-backdrop')?.classList.remove('show');
        if (document.getElementById('welcome-modal-backdrop')) document.getElementById('welcome-modal-backdrop').style.display = 'none';

        const db = await import('./js/db.js');
        await db.saveBook({
            id: 'audit_b1',
            title: '乡土中国（修订本）',
            author: '费孝通',
            format: 'epub',
            size: 524288,
            lastReadAt: Date.now() - 300000,
            progress: { fraction: 0.65, cfi: 'ch_1' },
            readingStatus: 'reading',
            status: 'reading',
            totalReadingSeconds: 7200
        });
        await db.saveReadingSession({
            id: 'sess_1',
            bookId: 'audit_b1',
            bookTitle: '测试超长书名防止溢出截断显示异常问题研究报告导论第二卷',
            dateKey: new Date().toISOString().slice(0, 10),
            durationSeconds: 2400,
            startTime: Date.now() - 2500000,
            endTime: Date.now() - 100000
        });

        await window.app.refreshBookshelf();
        window.mobileShell.switchTab('shelf');
        await new Promise(r => setTimeout(r, 300));
        const beforeMoreBtns = document.querySelectorAll('#books-grid .mobile-book-more-btn').length;
        await window.app.refreshBookshelf();
        await new Promise(r => setTimeout(r, 300));
        const afterRefreshMoreBtns = document.querySelectorAll('#books-grid .mobile-book-more-btn').length;

        // Check Me tab -> Stats subview
        window.mobileShell.switchTab('me');
        await new Promise(r => setTimeout(r, 200));
        window.mobileShell.openStatsSubview();
        await new Promise(r => setTimeout(r, 400));

        const statsContainerDisplayBeforeSwitch = getComputedStyle(document.getElementById('stats-dashboard-container')).display;
        const modernGridDisplayBeforeSwitch = getComputedStyle(document.getElementById('modern-grid-wrapper')).display;

        // Now force switchShelfCategory('stats') to see the stats dashboard layout
        await window.app.switchShelfCategory('stats');
        await new Promise(r => setTimeout(r, 400));

        const subHeader = toRect(document.getElementById('mobile-subview-header'));
        const monthChart = document.getElementById('stats-distribution-chart');
        const monthChartRect = toRect(monthChart);
        const monthFirstTip = toRect(monthChart?.querySelector('.chart-col:first-child .chart-tooltip'));
        const monthLastTip = toRect(monthChart?.querySelector('.chart-col:last-child .chart-tooltip'));

        // Switch to Week period
        document.querySelector('.wechat-stats-segmented-tabs [data-mode="week"]')?.click();
        await new Promise(r => setTimeout(r, 300));
        const weekCols = Array.from(document.querySelectorAll('#stats-distribution-chart .chart-col')).map(c => ({
            col: toRect(c),
            tip: toRect(c.querySelector('.chart-tooltip'))
        }));

        // Check recent sessions item layout
        const sessionItem = document.querySelector('#stats-recent-sessions-list .session-item');
        const sessionTitle = sessionItem?.querySelector('.session-book-title');
        const sessionDur = sessionItem?.querySelector('.session-duration');
        const sessionLayout = sessionItem ? {
            itemRect: toRect(sessionItem),
            titleRect: toRect(sessionTitle),
            durRect: toRect(sessionDur),
            titleOverflow: sessionTitle ? getComputedStyle(sessionTitle).textOverflow : null
        } : null;

        // Check Book Details Modal on mobile
        window.mobileShell.exitStatsOrAiSubview();
        await window.app.openBookDetailsModal('audit_b1');
        await new Promise(r => setTimeout(r, 300));
        const actionBtns = Array.from(document.querySelectorAll('.book-details-actions button')).map(b => ({
            id: b.id,
            text: b.textContent.trim(),
            display: getComputedStyle(b).display,
            rect: toRect(b)
        }));

        return {
            shelfBugCheck: { beforeMoreBtns, afterRefreshMoreBtns },
            statsBugCheck: { statsContainerDisplayBeforeSwitch, modernGridDisplayBeforeSwitch },
            subHeader,
            monthChartRect,
            monthFirstTip,
            monthLastTip,
            weekFirstCol: weekCols[0],
            weekLastCol: weekCols[weekCols.length - 1],
            sessionLayout,
            actionBtns
        };
    })()
    `);

    console.log(JSON.stringify(report, null, 2));
    ws.close();
} finally {
    edge.kill();
    srv.kill();
}
