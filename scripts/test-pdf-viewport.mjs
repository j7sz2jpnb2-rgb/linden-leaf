// scripts/test-viewport-scheduling.mjs
// Unit & Integration tests for PdfViewport Visible Page Priority Scheduling and Zoom Continuity

import assert from 'node:assert/strict';

// Set up browser-like environment
globalThis.window = globalThis;
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

class MockElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.style = {};
        this._classes = new Set();
        this.parentElement = null;
        this.scrollTop = 0;
        this.clientHeight = 800;
        this.clientWidth = 600;
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(v) {
        this._classes.clear();
        if (v) v.split(/\s+/).filter(Boolean).forEach(c => this._classes.add(c));
    }
    get classList() {
        return {
            add: (...cls) => cls.forEach(c => this._classes.add(c)),
            remove: (...cls) => cls.forEach(c => this._classes.delete(c)),
            contains: (c) => this._classes.has(c),
            get length() { return this._classes.size; }
        };
    }
    append(...children) {
        for (const c of children) {
            if (c) {
                c.parentElement = this;
                this.children.push(c);
            }
        }
    }
    replaceChildren(...children) {
        this.children = [];
        this.append(...children);
    }
    remove() {
        if (this.parentElement) {
            const idx = this.parentElement.children.indexOf(this);
            if (idx !== -1) this.parentElement.children.splice(idx, 1);
            this.parentElement = null;
        }
    }
    querySelector(selector) {
        const check = (el) => {
            if (selector.startsWith('.') && el._classes.has(selector.slice(1))) return el;
            if (selector.startsWith('#') && el.id === selector.slice(1)) return el;
            if (el.tagName.toLowerCase() === selector.toLowerCase()) return el;
            for (const child of el.children) {
                const found = check(child);
                if (found) return found;
            }
            return null;
        };
        for (const child of this.children) {
            const found = check(child);
            if (found) return found;
        }
        return null;
    }
    querySelectorAll(selector) {
        const results = [];
        const walk = (el) => {
            if (selector.startsWith('.') && el._classes.has(selector.slice(1))) results.push(el);
            for (const child of el.children) walk(child);
        };
        walk(this);
        return results;
    }
    closest(selector) { return this; }
    getBoundingClientRect() {
        return { top: 0, left: 0, width: parseFloat(this.style.width) || 600, height: parseFloat(this.style.height) || 800 };
    }
    addEventListener() {}
    removeEventListener() {}
}

globalThis.document = {
    createElement(tag) { return new MockElement(tag); },
    createElementNS(ns, tag) { return new MockElement(tag); },
    getElementById(id) { return null; },
    head: new MockElement('head'),
    body: new MockElement('body'),
};
globalThis.DOMException = class DOMException extends Error {
    constructor(msg, name) { super(msg); this.name = name; }
};

// Import PdfViewport
const { PdfViewport } = await import('../js/pdf-viewport.js');

console.log('====================================================');
console.log('Starting PDF Viewport Scheduling & Zoom Tests');
console.log('====================================================\n');

async function testVisiblePagePriority() {
    console.log('Suite 1: Visible Page Priority Scheduling');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { bufferPages: 2 });
    viewport.pageSizes = Array.from({ length: 20 }, () => ({ width: 595, height: 842 }));
    viewport._recomputeLayout();

    const renderOrder = [];
    const mockDriver = {
        kind: 'mock',
        async renderPage(page, scale, signal) {
            renderOrder.push({ page, scale, time: Date.now() });
            // simulate a small async delay
            await new Promise(r => setTimeout(r, 20));
            if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError');
            const canvas = new MockElement('canvas');
            return canvas;
        }
    };
    viewport.driver = mockDriver;

    // Scroll to page 5. Viewport height 800, each page ~1068px high.
    // Page 5 offset is roughly 5 * (1052 + 16) + 16 ~ 5356px.
    const p5 = viewport.pageOffsets[5];
    viewport.scrollArea.scrollTop = p5.top + 10;
    viewport.scrollArea.clientHeight = 800;
    viewport.currentPage = 5;

    // Trigger renderVisibleSlots
    viewport._renderVisibleSlots();

    // Wait for all in-flight and queued renders to finish
    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }

    // Verify render order:
    // Page 5 is visible (Tier 0). Pages 3, 4, 6, 7 are buffer pages (Tier 1).
    // Page 5 MUST be rendered before buffer pages!
    console.log('  Render execution order:', renderOrder.map(x => x.page));
    assert.equal(renderOrder[0].page, 5, 'Visible page 5 must be rendered first (before buffer pages 3, 4)');
    console.log('  [PASS] 1.1 Visible page 5 dispatched first ahead of buffer pages 3, 4');

    viewport.destroy();
}

async function testBufferPreemption() {
    console.log('\nSuite 2: Buffer Task Preemption on Visible Page Arrival');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { bufferPages: 2 });
    viewport._renderConcurrency = 1; // set concurrency = 1 to test preemption strictly
    viewport.pageSizes = Array.from({ length: 20 }, () => ({ width: 595, height: 842 }));
    viewport._recomputeLayout();

    let bufferRenderStarted = false;
    let bufferAborted = false;
    let visibleRenderCompleted = false;

    const mockDriver = {
        kind: 'mock',
        async renderPage(page, scale, signal) {
            if (page === 3) {
                bufferRenderStarted = true;
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        bufferAborted = true;
                        reject(new DOMException('Render cancelled', 'AbortError'));
                    }, { once: true });
                    // Long running render
                    setTimeout(() => {
                        resolve(new MockElement('canvas'));
                    }, 500);
                });
            } else if (page === 5) {
                visibleRenderCompleted = true;
                return new MockElement('canvas');
            }
            return new MockElement('canvas');
        }
    };
    viewport.driver = mockDriver;

    // 1. Manually start buffer page 3
    viewport._mountSlot(3);
    const slot3 = viewport.activeSlots.get(3);
    viewport._inFlightRenders.set(3, {
        page: 3,
        slot: slot3,
        token: 1,
        tier: 1, // buffer
        distance: 2,
        abortController: slot3.renderAbort,
    });
    viewport._activeRenders = 1;
    viewport._renderPageContent(3, slot3, 1, slot3.renderAbort.signal).catch(() => {});

    await new Promise(r => setTimeout(r, 10));
    assert.equal(bufferRenderStarted, true, 'Buffer page 3 should be in-flight');

    // 2. Now visible page 5 arrives and enters queue
    viewport.scrollArea.scrollTop = viewport.pageOffsets[5].top;
    viewport.scrollArea.clientHeight = 800;
    viewport.currentPage = 5;
    viewport._mountSlot(5);
    const slot5 = viewport.activeSlots.get(5);

    viewport._renderQueue.push({
        page: 5,
        slot: slot5,
        token: 1,
        tier: 0, // visible
        distance: 0,
        signal: slot5.renderAbort.signal,
    });

    // Pump queue: should preempt slot3
    viewport._pumpRenderQueue();

    await new Promise(r => setTimeout(r, 50));
    assert.equal(bufferAborted, true, 'Buffer page 3 must be aborted when visible page 5 arrives');
    assert.equal(visibleRenderCompleted, true, 'Visible page 5 must execute immediately in freed slot');
    console.log('  [PASS] 2.1 In-flight buffer task successfully aborted to yield concurrency slot to visible page');

    viewport.destroy();
}

async function testZoomContinuityAndPreviewRetention() {
    console.log('\nSuite 3: Zoom Continuity & Preview Canvas Retention');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { scale: 1.0 });
    viewport.pageSizes = [{ width: 600, height: 800 }];
    viewport._recomputeLayout();

    let renderCount = 0;
    let lastRenderScale = 0;
    const mockDriver = {
        kind: 'mock',
        async renderPage(page, scale, signal) {
            renderCount++;
            lastRenderScale = scale;
            await new Promise(r => setTimeout(r, 30));
            if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError');
            const canvas = new MockElement('canvas');
            canvas.dataset.scale = String(scale);
            return canvas;
        }
    };
    viewport.driver = mockDriver;

    // Render initial page 0 at 1.0x
    viewport.scrollArea.scrollTop = 0;
    viewport.scrollArea.clientHeight = 800;
    viewport.currentPage = 0;
    viewport._renderVisibleSlots();

    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }

    const slot = viewport.activeSlots.get(0);
    assert.ok(slot, 'Page 0 slot must exist');
    const initialCanvas = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.ok(initialCanvas, 'Initial canvas must exist');
    assert.equal(initialCanvas.dataset.scale, '1', 'Initial canvas scale is 1');

    // Perform zoom to 2.0x
    console.log('  Triggering zoom to 2.0x...');
    viewport.setZoom(2.0);

    // IMMEDIATELY after setZoom (before async render resolves):
    // 1. The slot must NOT have been unmounted
    assert.equal(viewport.activeSlots.get(0), slot, 'Slot must be preserved, not unmounted');
    // 2. The initial canvas must still be present in the wrapper as preview!
    const previewCanvas = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.equal(previewCanvas, initialCanvas, 'Old canvas must remain in DOM as GPU preview during zoom');
    // 3. Slot dimensions must be updated to new scale (600 * 2.0 = 1200)
    assert.equal(slot.style.width, '1200px', 'Slot width must be immediately scaled to 1200px');
    // 4. Token must be incremented
    assert.equal(slot._renderToken, 2, 'Token must be bumped to 2');
    console.log('  [PASS] 3.1 Old canvas retained as immediate preview, slot geometry scaled, token bumped');

    // Wait for the new 2.0x render to complete
    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }

    // Now the canvas must have been cleanly replaced by the 2.0x canvas
    const sharpCanvas = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.notEqual(sharpCanvas, initialCanvas, 'Old preview canvas must be replaced by new sharp canvas');
    assert.equal(sharpCanvas.dataset.scale, '2', 'Sharp canvas must have scale 2');
    console.log('  [PASS] 3.2 Sharp 2.0x canvas cleanly replaced preview canvas upon completion');

    viewport.destroy();
}

async function testGenerationalTokenDiscard() {
    console.log('\nSuite 4: Generational Token Outdated Result Discard');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { scale: 1.0 });
    viewport.pageSizes = [{ width: 600, height: 800 }];
    viewport._recomputeLayout();

    let resolveToken1;
    let resolveToken2;

    const mockDriver = {
        kind: 'mock',
        renderPage(page, scale, signal) {
            return new Promise((resolve) => {
                if (scale === 1.5) {
                    resolveToken1 = () => {
                        const c = new MockElement('canvas');
                        c.dataset.scale = '1.5';
                        resolve(c);
                    };
                } else if (scale === 2.0) {
                    resolveToken2 = () => {
                        const c = new MockElement('canvas');
                        c.dataset.scale = '2.0';
                        resolve(c);
                    };
                }
            });
        }
    };
    viewport.driver = mockDriver;
    viewport.scrollArea.scrollTop = 0;
    viewport.currentPage = 0;

    // Initial slot
    viewport._mountSlot(0);
    const slot = viewport.activeSlots.get(0);

    // Zoom 1: scale = 1.5 (token becomes 2)
    viewport.scale = 1.5;
    viewport._recomputeLayout();
    viewport._syncActiveSlotGeometry();
    viewport._renderVisibleSlots(true);
    assert.equal(slot._renderToken, 2, 'First zoom bumped token to 2');

    // Rapid Zoom 2: scale = 2.0 (token becomes 3) before Zoom 1 finishes
    viewport.scale = 2.0;
    viewport._recomputeLayout();
    viewport._syncActiveSlotGeometry();
    viewport._renderVisibleSlots(true);
    assert.equal(slot._renderToken, 3, 'Second zoom bumped token to 3');

    // Zoom 2 completes FIRST
    resolveToken2();
    await new Promise(r => setTimeout(r, 20));

    const finalCanvas = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.equal(finalCanvas?.dataset.scale, '2.0', 'Canvas has 2.0 scale from Zoom 2');

    // Now Zoom 1's late response arrives
    resolveToken1();
    await new Promise(r => setTimeout(r, 20));

    // Must NOT overwrite Zoom 2's canvas!
    const canvasAfterLate = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.equal(canvasAfterLate?.dataset.scale, '2.0', 'Late token 2 result did not overwrite token 3');
    console.log('  [PASS] 4.1 Stale render result from previous zoom token safely discarded without overwriting');

    viewport.destroy();
}

async function testJumpCleanupAndUnmount() {
    console.log('\nSuite 5: Jump / Rapid Scroll Slot Unmount & Cancellation');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { bufferPages: 1 });
    viewport.pageSizes = Array.from({ length: 50 }, () => ({ width: 600, height: 800 }));
    viewport._recomputeLayout();

    let abortedPages = [];
    const mockDriver = {
        kind: 'mock',
        renderPage(page, scale, signal) {
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    abortedPages.push(page);
                    reject(new DOMException('Render cancelled', 'AbortError'));
                });
                setTimeout(() => resolve(new MockElement('canvas')), 200);
            });
        }
    };
    viewport.driver = mockDriver;

    // Open at page 0
    viewport.scrollArea.scrollTop = 0;
    viewport.currentPage = 0;
    viewport._renderVisibleSlots();

    assert.ok(viewport.activeSlots.has(0), 'Page 0 active');
    assert.ok(viewport.activeSlots.has(1), 'Page 1 active');

    // Jump to page 40
    viewport.goToPage(40);

    // Active slots must no longer contain page 0 or 1
    assert.equal(viewport.activeSlots.has(0), false, 'Page 0 unmounted after jump');
    assert.equal(viewport.activeSlots.has(1), false, 'Page 1 unmounted after jump');
    assert.ok(viewport.activeSlots.has(40), 'Page 40 active after jump');
    assert.ok(abortedPages.includes(0) || abortedPages.includes(1), 'Old in-flight tasks aborted on jump');
    console.log('  [PASS] 5.1 Distant slots unmounted and in-flight tasks aborted on navigation jump');

    viewport.destroy();
}

async function testMapOwnershipRace() {
    console.log('\nSuite 6: In-Flight Map Ownership & Delayed Task Completion Race');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { scale: 1.0, bufferPages: 1 });
    viewport.pageSizes = [{ width: 600, height: 800 }];
    viewport._recomputeLayout();

    let resolveOldTask;
    let resolveNewTask;

    const mockDriver = {
        kind: 'mock',
        renderPage(page, scale, signal) {
            return new Promise((resolve) => {
                if (scale === 1.0) {
                    resolveOldTask = () => {
                        const c = new MockElement('canvas');
                        c.dataset.name = 'old-1.0';
                        resolve(c);
                    };
                } else if (scale === 2.0) {
                    resolveNewTask = () => {
                        const c = new MockElement('canvas');
                        c.dataset.name = 'new-2.0';
                        resolve(c);
                    };
                }
            });
        }
    };
    viewport.driver = mockDriver;

    // 1. Initial render at scale 1.0
    viewport.scrollArea.scrollTop = 0;
    viewport.currentPage = 0;
    viewport._renderVisibleSlots();

    // Verify task A is running
    assert.equal(viewport._activeDriverTasks.size, 1, 'Task A is in-flight on driver');
    const entryA = viewport._inFlightRenders.get(0);
    assert.ok(entryA, 'Task A registered in _inFlightRenders');

    // 2. Zoom to 2.0x while task A is still running
    viewport.scale = 2.0;
    viewport._recomputeLayout();
    viewport._syncActiveSlotGeometry();
    const slot = viewport.activeSlots.get(0);
    slot._renderToken = 2;
    slot.renderAbort?.abort();
    slot.renderAbort = new AbortController();

    // Schedule new 2.0x render
    viewport._scheduleRender({
        page: 0,
        slot,
        token: 2,
        tier: 0,
        distance: 0
    });

    // 3. Task A finishes late now
    resolveOldTask();
    // Allow microtasks to run Task A's finally
    await new Promise(r => setTimeout(r, 20));

    // After Task A's finally, slot freed for Task B
    assert.equal(viewport._activeDriverTasks.size, 1, 'Task B now dispatched to driver');
    const entryB = viewport._inFlightRenders.get(0);
    assert.ok(entryB, 'Task B must be registered in _inFlightRenders');
    assert.notEqual(entryB, entryA, 'Task B is a new entry with different request identity');
    assert.equal(entryB.token, 2, 'Task B token is 2');

    // 4. Now Task B completes
    resolveNewTask();
    await new Promise(r => setTimeout(r, 20));

    assert.equal(viewport._inFlightRenders.size, 0, 'In-flight renders empty after Task B completes');
    const finalCanvas = slot.querySelector('.pdf-img-wrapper').children[0];
    assert.equal(finalCanvas?.dataset.name, 'new-2.0', 'Final canvas must be new sharp canvas, not overwritten by old task');
    console.log('  [PASS] 6.1 Late task completion does not delete newer task from _inFlightRenders');
    console.log('  [PASS] 6.2 Old result does not overwrite newer result in DOM');

    viewport.destroy();
}

async function testWorkerCapacityStrictness() {
    console.log('\nSuite 7: Physical Driver Capacity & Delayed Abort Serialization');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { bufferPages: 2 });
    viewport._renderConcurrency = 1; // Strict single-worker
    viewport.pageSizes = Array.from({ length: 10 }, () => ({ width: 600, height: 800 }));
    viewport._recomputeLayout();

    let taskAAborted = false;
    let taskAResolved = false;
    let taskBStarted = false;
    let maxConcurrentDriverTasks = 0;
    let currentConcurrentDriverTasks = 0;

    const mockDriver = {
        kind: 'mock',
        async renderPage(page, scale, signal) {
            currentConcurrentDriverTasks++;
            maxConcurrentDriverTasks = Math.max(maxConcurrentDriverTasks, currentConcurrentDriverTasks);
            try {
                if (page === 3) {
                    // Buffer task: simulates cooperative delayed abort (e.g. C loop)
                    return await new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            taskAAborted = true;
                            // Deliberately delay actual termination by 30ms to simulate cooperative C thread
                            setTimeout(() => {
                                taskAResolved = true;
                                reject(new DOMException('Render cancelled', 'AbortError'));
                            }, 30);
                        }, { once: true });
                    });
                } else if (page === 0) {
                    taskBStarted = true;
                    await new Promise(r => setTimeout(r, 10));
                    return new MockElement('canvas');
                }
                return new MockElement('canvas');
            } finally {
                currentConcurrentDriverTasks--;
            }
        }
    };
    viewport.driver = mockDriver;

    // 1. Start buffer task on page 3
    viewport._mountSlot(3);
    const slot3 = viewport.activeSlots.get(3);
    viewport._scheduleRender({
        page: 3, slot: slot3, token: 1, tier: 1, distance: 3
    });
    viewport._pumpRenderQueue();

    assert.equal(viewport._activeDriverTasks.size, 1, 'Buffer task 3 is running');
    assert.equal(currentConcurrentDriverTasks, 1, 'Driver has 1 task');

    // 2. Visible page 0 arrives while buffer task 3 is running
    viewport._mountSlot(0);
    const slot0 = viewport.activeSlots.get(0);
    viewport.currentPage = 0;
    viewport._scheduleRender({
        page: 0, slot: slot0, token: 1, tier: 0, distance: 0
    });

    // Pump: Visible page triggers preemption of buffer page 3
    viewport._pumpRenderQueue();

    assert.equal(taskAAborted, true, 'Buffer task 3 received abort signal');
    // BUT task 3 has NOT finished yet (30ms delay).
    // Concurrency is 1, so visible page 0 MUST NOT start until task 3 finishes!
    assert.equal(taskBStarted, false, 'Visible task 0 must NOT start while buffer task 3 is still occupying driver');
    assert.equal(maxConcurrentDriverTasks, 1, 'Driver concurrency never exceeded 1');

    // 3. Wait for delayed abort to complete
    await new Promise(r => setTimeout(r, 60));

    assert.equal(taskAResolved, true, 'Buffer task 3 has yielded driver');
    assert.equal(taskBStarted, true, 'Visible task 0 dispatched immediately once driver was released');
    assert.equal(maxConcurrentDriverTasks, 1, 'Peak concurrency was strictly 1 throughout preemption lifecycle');
    console.log('  [PASS] 7.1 Abort signal cooperatively delivered to driver');
    console.log('  [PASS] 7.2 Driver concurrency limit never violated during preemption delay');

    viewport.destroy();
}

async function testDocumentSwitchIsolation() {
    console.log('\nSuite 8: Book Switching Isolation & Ghost Result Discard');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, { bufferPages: 1 });

    let resolveDoc1Page;
    const driver1 = {
        kind: 'mock1',
        async open() {
            return { numPages: 5, pageSizes: Array.from({ length: 5 }, () => ({ width: 500, height: 700 })) };
        },
        renderPage() {
            return new Promise(resolve => {
                resolveDoc1Page = resolve;
            });
        },
        destroy() {}
    };

    const driver2 = {
        kind: 'mock2',
        async open() {
            return { numPages: 10, pageSizes: Array.from({ length: 10 }, () => ({ width: 600, height: 800 })) };
        },
        async renderPage() {
            const c = new MockElement('canvas');
            c.dataset.doc = 'doc2';
            return c;
        },
        destroy() {}
    };

    // Load Document 1
    await viewport.load(driver1, { blob: new Uint8Array() });
    assert.equal(viewport.activeSlots.size, 2, 'Doc 1 mounted initial visible slots');

    // Switch to Document 2 while Doc 1 is in-flight
    await viewport.load(driver2, { blob: new Uint8Array() });
    assert.equal(viewport.numPages, 10, 'Doc 2 loaded with 10 pages');

    // Now old Document 1 render completes very late
    const oldCanvas = new MockElement('canvas');
    oldCanvas.dataset.doc = 'doc1-ghost';
    resolveDoc1Page?.(oldCanvas);
    await new Promise(r => setTimeout(r, 20));

    // Check slot 0: it must belong to Doc 2, never contaminated by Doc 1
    const slot0 = viewport.activeSlots.get(0);
    const canvas = slot0?.querySelector('.pdf-img-wrapper')?.children[0];
    assert.equal(canvas?.dataset.doc, 'doc2', 'Slot canvas belongs to Doc 2, old Doc 1 ghost discarded');
    console.log('  [PASS] 8.1 Ghost render results from previous document discarded on book switch');

    viewport.destroy();
}

async function testViewportBoundedClipAndHandover() {
    console.log('\nSuite 9: Viewport Bounded Clip Rendering & Preview Handover');

    const container = new MockElement('div');
    const viewport = new PdfViewport(container, {
        scale: 2.0,
        enableClip: true,
        clipPixelThreshold: 2_000_000,
    });
    viewport.pageSizes = [{ width: 600, height: 1000 }];
    viewport._recomputeLayout();

    let lastClip = null;
    let clipCallCount = 0;

    const mupdfDriver = {
        kind: 'mupdf',
        async renderPage(page, scale, signal, clip, priority, generation) {
            lastClip = clip;
            clipCallCount++;
            const canvas = new MockElement('canvas');
            canvas.dataset.page = String(page);
            canvas.dataset.scale = String(scale);
            if (clip) {
                canvas.width = clip[2] - clip[0];
                canvas.height = clip[3] - clip[1];
                canvas.offsetX = clip[0];
                canvas.offsetY = clip[1];
            } else {
                canvas.width = Math.round(600 * scale);
                canvas.height = Math.round(1000 * scale);
                canvas.offsetX = 0;
                canvas.offsetY = 0;
            }
            return canvas;
        },
        destroy() {}
    };

    viewport.driver = mupdfDriver;
    viewport.scrollArea.scrollTop = 0;
    viewport.scrollArea.clientHeight = 600;
    viewport.currentPage = 0;

    // 1. Initial visible render at 2.0x
    viewport._renderVisibleSlots();
    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }

    assert.ok(lastClip, 'MuPDF driver must receive a bounded clip rectangle for large visible page');
    assert.equal(lastClip[0], 0, 'Clip starts at x=0');
    assert.ok(lastClip[3] > lastClip[1], 'Clip height must be positive');
    console.log(`  Clip computed: [${lastClip.join(', ')}]`);

    const slot = viewport.activeSlots.get(0);
    assert.ok(slot, 'Slot 0 must be active');
    const wrapper = slot.querySelector('.pdf-img-wrapper');
    assert.ok(wrapper, 'Wrapper must exist');
    const clipCanvas = wrapper.children[0];
    assert.ok(clipCanvas.classList.contains('pdf-clip-canvas'), 'Clipped canvas must have pdf-clip-canvas class');
    assert.equal(clipCanvas.style.zIndex, '2', 'Clip canvas must have zIndex 2');
    console.log('  [PASS] 9.1 Bounded clip calculated and positioned correctly');

    // 2. Preview retention test
    const initialClipCanvas = clipCanvas;
    const initialCallCount = clipCallCount;

    // Simulate small scroll within bleed margin (e.g. 20px)
    viewport.scrollArea.scrollTop = 20;
    viewport._renderVisibleSlots();
    assert.equal(clipCallCount, initialCallCount, 'Scroll within bleed margin must NOT trigger re-render');
    console.log('  [PASS] 9.2 Scrolling within bleed margin avoided redundant render');

    // 3. Scroll beyond bleed margin (e.g. scroll down by 500px)
    viewport.scrollArea.scrollTop = 500;
    viewport._renderVisibleSlots();
    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(clipCallCount > initialCallCount, 'Scroll beyond bleed margin must trigger new clip render');
    const newClipCanvas = wrapper.children[0];
    assert.ok(newClipCanvas, 'New clip canvas must be mounted');
    console.log('  [PASS] 9.3 Scrolling beyond bleed margin dynamically requested new visible clip');

    // 4. Fallback on driver clip error
    let failClipOnce = true;
    mupdfDriver.renderPage = async (page, scale, signal, clip, priority, generation) => {
        if (clip && failClipOnce) {
            failClipOnce = false;
            throw new Error('Simulated clip failure');
        }
        const canvas = new MockElement('canvas');
        canvas.width = Math.round(600 * scale);
        canvas.height = Math.round(1000 * scale);
        canvas.offsetX = 0;
        canvas.offsetY = 0;
        return canvas;
    };

    slot._renderedScale = null;
    viewport._renderVisibleSlots(true);
    while (viewport._activeRenders > 0 || viewport._renderQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
    }
    const fallbackCanvas = wrapper.children[0];
    assert.ok(fallbackCanvas.classList.contains('pdf-page-canvas'), 'Failed clip must cleanly fall back to full-page render');
    console.log('  [PASS] 9.4 Driver clip exception cleanly fell back to full-page render');

    viewport.destroy();
}

async function runAll() {
    await testVisiblePagePriority();
    await testBufferPreemption();
    await testZoomContinuityAndPreviewRetention();
    await testGenerationalTokenDiscard();
    await testJumpCleanupAndUnmount();
    await testMapOwnershipRace();
    await testWorkerCapacityStrictness();
    await testDocumentSwitchIsolation();
    await testViewportBoundedClipAndHandover();

    console.log('\n====================================================');
    console.log('All PDF Viewport Scheduling & Zoom Tests Passed!');
    console.log('====================================================');
}

runAll().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
