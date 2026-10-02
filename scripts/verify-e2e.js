// scripts/verify-e2e.js
// Automated verification runner using Electron Chromium engine
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8189;
const distDir = path.resolve(__dirname, '..', 'dist');

// 1. Simple static file server for dist/
const server = http.createServer((req, res) => {
    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    let filePath;
    if (reqPath.startsWith('/samples/')) {
        filePath = path.join(path.resolve(__dirname, '..', 'samples'), reqPath.replace('/samples/', ''));
    } else {
        filePath = path.join(distDir, reqPath);
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found: ' + reqPath);
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf'
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, async () => {
    console.log(`[verify-e2e] Static server listening at http://localhost:${PORT}`);
    await app.whenReady();

    const win = new BrowserWindow({
        width: 1360,
        height: 880,
        show: false, // Headless
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            webSecurity: false // allow local blob/origin access for test
        }
    });

    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        if (level >= 2 && !message.includes('font') && !message.includes('DevTools')) {
            console.log(`[Browser Console L${level}]:`, message);
        }
    });

    await win.loadURL(`http://localhost:${PORT}/index.html`);

    // Give page time to load and instantiate UniversalReaderApp
    console.log('[verify-e2e] Page loaded, executing verification suite inside browser context...');

    const results = await win.webContents.executeJavaScript(`
        (async () => {
            const suiteResults = [];
            function assert(desc, pass, detail = '') {
                suiteResults.push({ desc, pass: Boolean(pass), detail });
                if (!pass) console.error('[FAIL]', desc, detail);
                else console.log('[PASS]', desc);
            }

            // Wait for window.app to be available
            let attempts = 0;
            while (!window.app && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
            if (!window.app) {
                return [{ desc: 'App initialization', pass: false, detail: 'window.app was not initialized within 5s' }];
            }

            const app = window.app;

            // ----------------------------------------------------
            // TEST p1: Icon Picker Grid Layout
            // ----------------------------------------------------
            try {
                app.openCreateListModal();
                const picker = document.getElementById('custom-list-icon-picker');
                const pickerStyle = window.getComputedStyle(picker);
                const display = pickerStyle.display;
                const gridCols = pickerStyle.gridTemplateColumns;
                const numCols = gridCols ? gridCols.split(' ').length : 0;
                const buttons = picker.querySelectorAll('button.icon-pick-btn');

                assert(
                    'p1: #custom-list-icon-picker has display: grid',
                    display === 'grid',
                    'Expected display: grid, got ' + display
                );
                assert(
                    'p1: #custom-list-icon-picker renders 8 columns grid layout',
                    numCols === 8,
                    'Expected 8 columns, got ' + numCols + ' (' + gridCols + ')'
                );
                assert(
                    'p1: #custom-list-icon-picker contains 16 icon buttons with min-width: 0',
                    buttons.length === 16 && window.getComputedStyle(buttons[0]).minWidth === '0px',
                    'Found ' + buttons.length + ' buttons, minWidth: ' + (buttons[0] ? window.getComputedStyle(buttons[0]).minWidth : 'none')
                );
                app.closeCreateListModal();
            } catch (err) {
                assert('p1: Icon Picker Grid Layout', false, err.message);
            }

            // ----------------------------------------------------
            // TEST p2: Native file input is completely hidden
            // ----------------------------------------------------
            try {
                const fileInput = document.getElementById('file-input');
                const btnImport = document.getElementById('btn-import');
                const inputStyle = window.getComputedStyle(fileInput);

                assert(
                    'p2: Native file-input is completely hidden from header',
                    inputStyle.display === 'none' || fileInput.hidden || inputStyle.opacity === '0' || inputStyle.width === '0px',
                    'display=' + inputStyle.display + ' hidden=' + fileInput.hidden + ' opacity=' + inputStyle.opacity
                );
                assert(
                    'p2: Header import "+" button (#btn-import) is present and visible',
                    btnImport && window.getComputedStyle(btnImport).display !== 'none',
                    'btnImport display=' + (btnImport ? window.getComputedStyle(btnImport).display : 'null')
                );
            } catch (err) {
                assert('p2: Native file input hidden', false, err.message);
            }

            // ----------------------------------------------------
            // TEST p3: Finished empty shelf layout is centered
            // ----------------------------------------------------
            try {
                app.shelfCategory = 'finished';
                await app.refreshBookshelf();

                const booksGrid = document.getElementById('books-grid');
                const emptyState = booksGrid.querySelector('.jane-empty-state');
                const gridStyle = window.getComputedStyle(booksGrid);

                assert(
                    'p3: Finished empty shelf displays jane-empty-state',
                    Boolean(emptyState),
                    'Expected .jane-empty-state in #books-grid'
                );
                assert(
                    'p3: #books-grid has .is-empty class and flex centering layout',
                    booksGrid.classList.contains('is-empty') && gridStyle.display === 'flex' && gridStyle.justifyContent === 'center',
                    'classList=' + booksGrid.className + ' display=' + gridStyle.display + ' justifyContent=' + gridStyle.justifyContent
                );

                if (emptyState) {
                    const rect = emptyState.getBoundingClientRect();
                    assert(
                        'p3: Empty state is not squeezed into 140px track (width > 200px)',
                        rect.width > 200,
                        'Empty state width is ' + rect.width + 'px'
                    );
                }
            } catch (err) {
                assert('p3: Finished empty shelf layout', false, err.message);
            }

            // ----------------------------------------------------
            // TEST p4.1: Progress bar fill clamped accurately
            // ----------------------------------------------------
            try {
                // Ensure default grid view context so modernHeroThreshold is active
                app.shelfCategory = 'all';
                app.searchQuery = '';
                app.shelfViewMode = 'grid';
                if (app.dom.modernHeroThreshold) app.dom.modernHeroThreshold.style.display = 'flex';

                // Mock hero book with 0.2% progress
                const mockHeroBook = {
                    id: 'mock_book_02',
                    title: '测试微小进度图书',
                    format: 'epub',
                    progress: { fraction: 0.002 }, // 0.2%
                    totalReadingSeconds: 45,
                    lastReadAt: Date.now()
                };

                app.renderModernThreshold([mockHeroBook]);
                const fillEl = document.querySelector('.hero-progress-bar-fill');
                const fillStyle = fillEl ? fillEl.style.width : '';
                const computedWidth = fillEl ? fillEl.getBoundingClientRect().width : 0;
                const parentWidth = fillEl ? fillEl.parentElement.getBoundingClientRect().width : 1;

                assert(
                    'p4.1: Progress bar style.width is 0.2% (not 100%)',
                    fillStyle === '0.2%',
                    'Expected style.width to be 0.2%, got: ' + fillStyle
                );
                assert(
                    'p4.1: Progress bar rendered width ratio is < 5% of container',
                    parentWidth > 0 && (computedWidth / parentWidth) < 0.05,
                    'Ratio: ' + (computedWidth / parentWidth) + ' (' + computedWidth + 'px / ' + parentWidth + 'px)'
                );
            } catch (err) {
                assert('p4.1: Progress bar fill', false, err.message);
            }

            // ----------------------------------------------------
            // TEST p4.2: First-time user welcome nickname modal
            // ----------------------------------------------------
            try {
                localStorage.removeItem('linden_user_initialized');
                localStorage.removeItem('linden_user_name');

                const welcomeModal = document.getElementById('welcome-modal-backdrop');
                // In headless Chromium (show: false), transitions are paused; disable transition for instant opacity calculation
                if (welcomeModal) welcomeModal.style.transition = 'none';

                app.checkFirstTimeUser();
                await new Promise(r => setTimeout(r, 100));

                const modalStyle = window.getComputedStyle(welcomeModal);
                const hasShow = welcomeModal.classList.contains('show');
                const isFlex = modalStyle.display === 'flex';
                const opacity = parseFloat(modalStyle.opacity);
                const input = document.getElementById('welcome-username-input');

                assert(
                    'p4.2: Welcome modal backdrop has display: flex and .show class',
                    isFlex && hasShow,
                    'display=' + modalStyle.display + ' classList=' + welcomeModal.className
                );
                assert(
                    'p4.2: Welcome modal backdrop has opacity: 1 and pointer-events: auto',
                    opacity >= 0.9 && modalStyle.pointerEvents === 'auto',
                    'opacity=' + modalStyle.opacity + ' pointerEvents=' + modalStyle.pointerEvents
                );
                assert(
                    'p4.2: Welcome nickname input (#welcome-username-input) is present',
                    Boolean(input),
                    'Found welcome username input: ' + Boolean(input)
                );

                // Simulate nickname save
                if (input) input.value = '测试读者';
                document.getElementById('btn-welcome-confirm')?.click();
                await new Promise(r => setTimeout(r, 250));

                assert(
                    'p4.2: Clicking confirm saves nickname to localStorage and hides modal',
                    localStorage.getItem('linden_user_name') === '测试读者' &&
                    localStorage.getItem('linden_user_initialized') === 'true' &&
                    welcomeModal.style.display === 'none',
                    'name=' + localStorage.getItem('linden_user_name') + ' init=' + localStorage.getItem('linden_user_initialized') + ' display=' + welcomeModal.style.display
                );
            } catch (err) {
                assert('p4.2: Welcome modal', false, err.message);
            }

            // ----------------------------------------------------
            // TEST 6: EPUB Reading Pipeline Verification
            // ----------------------------------------------------
            try {
                // Fetch sample EPUB binary from server
                const resp = await fetch('http://localhost:${PORT}/samples/sample_alice.epub');
                if (!resp.ok) {
                    // Try direct relative path
                    const respAlt = await fetch('/samples/sample_alice.epub').catch(() => null);
                    if (!respAlt || !respAlt.ok) {
                        throw new Error('Failed to fetch /samples/sample_alice.epub (status: ' + resp.status + ')');
                    }
                }
                const blob = await resp.blob();
                const fileObj = new File([blob], 'sample_alice.epub', { type: 'application/epub+zip' });

                console.log('[TEST 6] Importing sample_alice.epub (' + blob.size + ' bytes)...');
                await app.processAndSaveBook(fileObj, 'AliceInWonderland.epub');

                const allBooks = await db.getAllBooks();
                const aliceBook = allBooks.find(b => b.title.includes('Alice') || b.filename?.includes('Alice'));
                assert('TEST 6: sample_alice.epub saved into IndexedDB', Boolean(aliceBook), 'Found: ' + (aliceBook ? aliceBook.title : 'none'));

                if (aliceBook) {
                    console.log('[TEST 6] Opening book ID ' + aliceBook.id + ' with foliate-view...');
                    await app.openBook(aliceBook.id);

                    // Wait for foliate-view renderer to load section document
                    let loadAttempts = 0;
                    let docFound = false;
                    let bodyText = '';

                    while (loadAttempts < 60) {
                        await new Promise(r => setTimeout(r, 150));
                        const foliateView = app.foliateView;
                        if (foliateView && foliateView.renderer) {
                            const contents = foliateView.renderer.getContents?.() || [];
                            if (contents.length > 0 && contents[0]?.doc) {
                                const doc = contents[0].doc;
                                bodyText = doc.body?.textContent?.trim() || '';
                                if (bodyText.length > 0) {
                                    docFound = true;
                                    break;
                                }
                            }
                            // Also check iframe directly
                            const iframe = foliateView.shadowRoot?.querySelector('iframe') || foliateView.querySelector('iframe');
                            if (iframe && iframe.contentDocument?.body?.textContent?.trim()) {
                                bodyText = iframe.contentDocument.body.textContent.trim();
                                docFound = true;
                                break;
                            }
                        }
                        loadAttempts++;
                    }

                    assert(
                        'TEST 6: EPUB chapter document successfully loaded into Foliate iframe',
                        docFound,
                        'Attempts=' + loadAttempts + ' Body snippet: ' + bodyText.slice(0, 100)
                    );
                    assert(
                        'TEST 6: EPUB body contains readable chapter text',
                        bodyText.length > 10,
                        'Extracted length: ' + bodyText.length
                    );

                    app.closeReader();
                }
            } catch (err) {
                assert('TEST 6: EPUB Reading Pipeline', false, err.stack || err.message);
            }

            return suiteResults;
        })()
    `);

    console.log('\n=== E2E Test Suite Results ===\n');
    let allPassed = true;
    for (const r of results) {
        const icon = r.pass ? '✓ [PASS]' : '✗ [FAIL]';
        console.log(`${icon} ${r.desc}`);
        if (!r.pass || r.detail) {
            console.log(`    Detail: ${r.detail}`);
        }
        if (!r.pass) allPassed = false;
    }

    server.close();
    win.destroy();
    app.quit();

    if (!allPassed) {
        console.error('\nOne or more E2E tests failed!');
        process.exit(1);
    } else {
        console.log('\nAll E2E tests passed successfully!');
        process.exit(0);
    }
});
