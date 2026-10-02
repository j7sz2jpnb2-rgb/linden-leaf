// scripts/test-round6-authoritative-fixes.mjs
// Authoritative verification suite for LL-01 through LL-43 repairs

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

console.log('========================================================')
console.log(' RUNNING AUTHORITATIVE VERIFICATION FOR ALL REPAIRS')
console.log('========================================================\n')

let passed = 0
let failed = 0

function runTest(name, fn) {
    try {
        fn()
        console.log(`  ✓ ${name}`)
        passed++
    } catch (e) {
        console.error(`  ✗ ${name}`)
        console.error(`    Error: ${e.message}`)
        if (e.stack) console.error(`    ${e.stack.split('\n').slice(1, 4).join('\n    ')}`)
        failed++
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn()
        console.log(`  ✓ ${name}`)
        passed++
    } catch (e) {
        console.error(`  ✗ ${name}`)
        console.error(`    Error: ${e.message}`)
        if (e.stack) console.error(`    ${e.stack.split('\n').slice(1, 4).join('\n    ')}`)
        failed++
    }
}

// 1. LL-01: Import Queue Byte Size Protection
runTest('LL-01: Import queue rejects duplicate match if file sizes differ', () => {
    const queueCode = fs.readFileSync(path.join(rootDir, 'js/import-queue.js'), 'utf8')
    assert(queueCode.includes('b.size && fileObj.size && b.size !== fileObj.size'), 'Must check byte size mismatch before matching duplicate')
})

// 2. LL-02, LL-07, LL-32, LL-42: Sync Engine
await runAsyncTest('LL-02, LL-07, LL-32, LL-42: Sync Engine metadata, strokes & drawing tombstone protection', async () => {
    const syncEngine = await import('../js/syncEngine.js')
    
    // LL-42 & LL-32: reconcileBookSyncMeta
    const local = {
        totalReadingSeconds: 300,
        totalListeningSeconds: 120,
        progress: { fraction: 0.5, updatedAt: 1000 },
        lastReadAt: 5000 // listening session updated lastReadAt
    }
    const remote = {
        totalReadingSeconds: 400,
        totalListeningSeconds: 200,
        progress: { fraction: 0.8, updatedAt: 2000 },
        lastReadAt: 2000
    }
    const reconciled = syncEngine.reconcileBookSyncMeta(local, remote)
    assert.strictEqual(reconciled.totalListeningSeconds, 200, 'Reconciled listening seconds must be max')
    assert.strictEqual(reconciled.progress.fraction, 0.8, 'Must use progress.updatedAt, NOT lastReadAt fallback')

    // LL-07: mergeDrawingStrokes with coordinate array tuples [x, y]
    const strokesA = [
        { tool: 'pen', color: '#ff0000', width: 2, points: [[10, 20], [30, 40]] }
    ]
    const strokesB = [
        { tool: 'pen', color: '#ff0000', width: 2, points: [[50, 60], [70, 80]] }
    ]
    const merged = syncEngine.mergeDrawingStrokes(strokesA, strokesB)
    assert.strictEqual(merged.length, 2, 'Strokes of identical length and style must not collapse into 1 when using [x, y] tuples')
})

// 3. LL-28, LL-29, LL-33, LL-43: Database & Reading Statistics
await runAsyncTest('LL-28, LL-29, LL-33, LL-43: Database timestamp normalization, active sessions, and unallocated historical time', async () => {
    const db = await import('../js/db.js')

    // LL-29: normalizeTimestampMs
    assert.strictEqual(db.normalizeTimestampMs(1727800000000), 1727800000000)
    assert.strictEqual(db.normalizeTimestampMs('2026-10-02T12:00:00Z'), Date.parse('2026-10-02T12:00:00Z'))
    assert.strictEqual(db.normalizeTimestampMs(new Date(1727800000000)), 1727800000000)

    // LL-28: computeActiveSessionSeconds
    const unintervaledSess = [{ durationSeconds: 120, startTime: 1000, endTime: 1000 + 3600 * 1000 }]
    const activeSecs = db.computeActiveSessionSeconds(unintervaledSess)
    assert.strictEqual(activeSecs, 120, 'Unintervaled session must return durationSeconds, not wall span of 3600s')

    // LL-02: applySynced* exports exist
    assert(typeof db.applySyncedHighlight === 'function', 'applySyncedHighlight must be exported')
    assert(typeof db.applySyncedBookmark === 'function', 'applySyncedBookmark must be exported')
    assert(typeof db.applySyncedCustomList === 'function', 'applySyncedCustomList must be exported')

    // LL-43 & LL-33: getReadingStats logic check in code
    const dbCode = fs.readFileSync(path.join(rootDir, 'js/db.js'), 'utf8')
    assert(dbCode.includes('unallocatedHistoricalSeconds,'), 'getReadingStats must expose unallocatedHistoricalSeconds')
    assert(dbCode.includes('resolveReadingState(b) === \'finished\''), 'isCompletedInPeriod must check resolveReadingState')
})

// 4. LL-35, LL-36, LL-37, LL-38, LL-40: Foliate Overlayer
await runAsyncTest('LL-35, LL-36, LL-37, LL-38, LL-40: Overlayer geometry, deterministic seed, capsule fallback, and defs isolation', async () => {
    const overlayerModule = await import('../foliate-js-main/overlayer.js')
    const { Overlayer, sortRectsGeometrically } = overlayerModule

    // LL-40: Transitive geometric sorting
    const rects = [
        { top: 100, bottom: 120, left: 200, right: 300, width: 100, height: 20 },
        { top: 50, bottom: 70, left: 10, right: 50, width: 40, height: 20 },
        { top: 52, bottom: 72, left: 60, right: 120, width: 60, height: 20 },
        { top: 102, bottom: 122, left: 10, right: 150, width: 140, height: 20 }
    ]
    const sorted = sortRectsGeometrically(rects, 'horizontal')
    assert.strictEqual(sorted[0].left, 10, 'Line 1 left rect should be first')
    assert.strictEqual(sorted[1].left, 60, 'Line 1 right rect should be second')
    assert.strictEqual(sorted[2].left, 10, 'Line 2 left rect should be third')
    assert.strictEqual(sorted[3].left, 200, 'Line 2 right rect should be fourth')

    // LL-36 & LL-37 & LL-38: Overlayer highlight rendering code check
    const overlayerCode = fs.readFileSync(path.join(rootDir, 'foliate-js-main/overlayer.js'), 'utf8')
    assert(overlayerCode.includes('width < Math.min(16, height * 0.8)'), 'Must implement clamped capsule fallback for narrow rects (LL-38)')
    assert(overlayerCode.includes('options.annotationId || options.id || options.seed'), 'Must derive deterministic seed (LL-37)')
    assert(overlayerCode.includes('#filterId = \'wechat-soak-\''), 'Overlayer must have instance-scoped filterId (LL-36)')
})

// 5. LL-15 & LL-16: AI Assistant Safeguards
runTest('LL-15 & LL-16: Reading AI Assistant and Native Command Safeguards', () => {
    const jsAi = fs.readFileSync(path.join(rootDir, 'js/reading-ai-assistant.js'), 'utf8')
    assert(jsAi.includes('if (signal?.aborted) {'), 'Must check signal.aborted after Promise.all resolves (LL-15)')

    const rsAi = fs.readFileSync(path.join(rootDir, 'src-tauri/src/commands/ai.rs'), 'utf8')
    assert(rsAi.includes('let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();'), 'Must create abort channel before lock')
    assert(rsAi.includes('*tx_guard = Some((req_id.clone(), abort_tx));'), 'Must register abort_tx atomically with active_request_id (LL-16)')
})

// 6. LL-18: Sync Payload Limits
runTest('LL-18: 20 MiB Payload Limit Enforcement in WebDAV and Tauri', () => {
    const webdavJs = fs.readFileSync(path.join(rootDir, 'services/webdav.js'), 'utf8')
    assert(webdavJs.includes('20 * 1024 * 1024'), 'webdav.js must reject payloads > 20 MiB')

    const syncRs = fs.readFileSync(path.join(rootDir, 'src-tauri/src/commands/sync.rs'), 'utf8')
    assert(syncRs.includes('MAX_SYNC_PAYLOAD_BYTES: usize = 20 * 1024 * 1024'), 'sync.rs must enforce 20 MiB limit')
})

// 7. LL-24 & LL-25: Full-Text Search
runTest('LL-24 & LL-25: Search Engine Stale Index Pruning and HTML Entity Decoding', () => {
    const fts = fs.readFileSync(path.join(rootDir, 'js/fulltext-search.js'), 'utf8')
    assert(fts.includes('await this.removeBookIndex(bookId)'), 'Must remove index for nonexistent book (LL-24)')
    assert(fts.includes('!(code >= 0xd800 && code <= 0xdfff)'), 'Must exclude surrogate code points from parsing (LL-25)')

    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8')
    assert(appJs.includes('await fullTextSearchEngine.pruneStaleIndexes(validBookIds)'), 'app.js executeCrossSearch must prune stale indexes')
    assert(appJs.includes('bgIndexConcurrency'), 'app.js executeCrossSearch must respect concurrency setting')
})

// 8. LL-06, LL-07, LL-22, LL-35: App.js PDF Drawing and Annotations
runTest('LL-06, LL-07, LL-22, LL-35: App.js PDF Drawing Generations and Opacity', () => {
    const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8')
    assert(appJs.includes('this._drawingPageGenerations = new Map()'), 'Must initialize _drawingPageGenerations (LL-06)')
    assert(appJs.includes('this._inFlightDrawingLoads = new Map()'), 'Must initialize _inFlightDrawingLoads (LL-06)')
    assert(appJs.includes('id: `stroke_${Date.now()}_'), 'Must assign unique ID to currentStroke (LL-07)')
    assert(appJs.includes('Clear mutation error:'), 'Must attach catch to clearPdfPageDrawing mutation (LL-22)')
    assert(appJs.includes('Save mutation error:'), 'Must attach catch to savePdfPageDrawing mutation (LL-22)')
    assert(appJs.includes('Number.isFinite(rawHlOpacity)'), 'Must preserve 0 opacity using Number.isFinite (LL-35)')
})

// 9. LL-12, LL-13: Advanced Settings Full Data Backup and Restore
runTest('LL-12, LL-13: Advanced Settings Backup and Restore implementation', () => {
    const adv = fs.readFileSync(path.join(rootDir, 'js/advanced-settings.js'), 'utf8')
    assert(adv.includes('db.getAllCustomLists'), 'Must use db.getAllCustomLists instead of getAllReadingLists (LL-13)')
    assert(!adv.includes('db.getAllTags'), 'Must not call nonexistent db.getAllTags')
    assert(adv.includes('restoreFullDataBackup(backupData)'), 'Must implement restoreFullDataBackup (LL-12)')
    assert(adv.includes('--overlayer-highlight-opacity'), 'Must set --overlayer-highlight-opacity CSS var (LL-35)')

    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8')
    assert(html.includes('id="btn-restore-full-data-backup"'), 'Must have restore button in index.html (LL-12)')
    assert(html.includes('id="input-restore-full-data-file"'), 'Must have restore file input in index.html (LL-12)')
})

console.log('\n========================================================')
console.log(` SUMMARY: ${passed} passed, ${failed} failed`)
console.log('========================================================')

if (failed > 0) {
    process.exit(1)
}
