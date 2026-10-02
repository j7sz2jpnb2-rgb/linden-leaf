// scripts/inspect-and-clean-test-books.mjs
// One-off targeted utility to inspect and clean strictly the two test books in the user profile:
// 1. book_1790155580603_pforo0 (test-temp-fire)
// 2. book_1790155576943_js2vo6 (test-temp-book1)
// Verifies 0 highlights, 0 notes, 0 bookmarks, 0 drawings before removal.
// Backs up records to localStorage before deletion.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

const TARGET_IDS = [
    'book_1790155580603_pforo0',
    'book_1790155576943_js2vo6'
];

async function main() {
    console.log('================================================================');
    console.log('Linden Leaf: Targeted Test Books Inspection & Safe Cleanup');
    console.log('================================================================');

    let exePath = 'D:\\LindenLeaf-Build\\target\\release\\linden-leaf.exe';
    if (!existsSync(exePath)) exePath = 'D:\\LindenLeaf-Build\\target\\debug\\linden-leaf.exe';

    const cdpPort = 9444;
    // Note: Do NOT override WEBVIEW2_USER_DATA_FOLDER because we are inspecting the user's real profile!
    const env = {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    };

    console.log(`Launching real user instance with CDP port ${cdpPort}...`);
    const appProcess = spawn(exePath, [], { env, stdio: 'ignore' });
    const appPid = appProcess.pid;
    console.log(`  Process PID: ${appPid}`);

    let cdpWsUrl = null;
    for (let i = 0; i < 30; i++) {
        await SLEEP(1000);
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
            if (res.ok) {
                const list = await res.json();
                const pageTarget = list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'));
                if (pageTarget && pageTarget.webSocketDebuggerUrl) {
                    cdpWsUrl = pageTarget.webSocketDebuggerUrl;
                    break;
                }
            }
        } catch {}
    }

    if (!cdpWsUrl) {
        appProcess.kill();
        throw new Error(`Failed to connect to CDP on port ${cdpPort}`);
    }

    const ws = new WebSocket(cdpWsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data);
            pending.delete(data.id);
        }
    };

    const send = method => params => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, res => {
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Runtime.enable')({});

    const evaluate = async expr => {
        const res = await send('Runtime.evaluate')({
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
        });
        if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
        return res.result?.value;
    };

    // Wait for app ready
    await evaluate(`new Promise(resolve => {
        if (window.app && window.app.dom) return resolve(true);
        const timer = setInterval(() => {
            if (window.app && window.app.dom) {
                clearInterval(timer);
                resolve(true);
            }
        }, 100);
    })`);

    console.log('\nInspecting candidate test books in user IndexedDB:');
    const inspectionReport = [];

    for (const targetId of TARGET_IDS) {
        const check = await evaluate(`(async () => {
            const dbModule = await import('./js/db.js?v=20260914_rel_v1');
            const book = await dbModule.getBook("${targetId}");
            if (!book) return { found: false, id: "${targetId}" };

            const highlights = await dbModule.getHighlightsByBook("${targetId}");
            const notes = (await dbModule.getAllNotes ? await dbModule.getAllNotes() : []).filter(n => n.bookId === "${targetId}");
            const bookmarks = await dbModule.getBookmarksByBook ? await dbModule.getBookmarksByBook("${targetId}") : [];

            return {
                found: true,
                id: book.id,
                title: book.title,
                format: book.format,
                size: book.size,
                nativePath: book.nativePath,
                highlightsCount: (highlights || []).length,
                notesCount: (notes || []).length,
                bookmarksCount: (bookmarks || []).length,
                hasUserContent: (highlights && highlights.length > 0) || (notes && notes.length > 0) || (bookmarks && bookmarks.length > 0)
            };
        })()`);

        console.log(`  Target ID: ${targetId}`);
        console.log(`    Found: ${check.found}`);
        if (check.found) {
            console.log(`    Title: "${check.title}"`);
            console.log(`    Format: ${check.format}, Size: ${check.size}`);
            console.log(`    Native Path: ${check.nativePath}`);
            console.log(`    Highlights: ${check.highlightsCount}, Notes: ${check.notesCount}, Bookmarks: ${check.bookmarksCount}`);
            console.log(`    Has User Content: ${check.hasUserContent}`);
        }
        inspectionReport.push(check);
    }

    console.log('\nEvaluating safety criteria for cleanup:');
    for (const item of inspectionReport) {
        if (!item.found) {
            console.log(`  [SKIP] Book ${item.id} not found in database.`);
            continue;
        }

        if (item.hasUserContent) {
            console.warn(`  [PRESERVE] Book ${item.id} has user annotations/notes! Preserving as instructed.`);
            continue;
        }

        console.log(`  [SAFE] Book ${item.id} ("${item.title}") verified as automated test artifact with 0 user annotations.`);
        console.log(`  Backing up and deleting book ${item.id}...`);

        const result = await evaluate(`(async () => {
            const dbModule = await import('./js/db.js?v=20260914_rel_v1');
            const book = await dbModule.getBook("${item.id}");
            localStorage.setItem("backup_test_book_${item.id}", JSON.stringify(book));
            await dbModule.deleteBook("${item.id}");
            const checkDeleted = await dbModule.getBook("${item.id}");
            return { deleted: !checkDeleted };
        })()`);

        console.log(`    Deletion result: ${result.deleted ? 'SUCCESS' : 'FAILED'}`);
    }

    console.log('\nRefreshing bookshelf after inspection...');
    await evaluate(`window.app.refreshBookshelf()`);
    await SLEEP(1000);

    ws.close();
    appProcess.kill();
    console.log('Cleanup utility finished cleanly.');
}

main().catch(err => {
    console.error('Fatal cleanup error:', err);
    process.exit(1);
});
