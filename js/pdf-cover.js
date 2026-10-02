// js/pdf-cover.js - High-efficiency, bounded-resource PDF cover extractor
// Dedicated thumbnail generation without instantiating Foliate reader DOM or full UI.
// Distinguishes between graphic covers, blank flyleaves, and rendering failures.

import { PdfJsDriver, AdaptivePdfDriver } from './pdf-driver.js'
import * as db from './db.js'

/**
 * Checks whether an image canvas is predominantly empty/blank white or transparent (e.g. blank flyleaf)
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean}
 */
export function isCanvasBlankWhite(canvas) {
    if (!canvas || canvas.width === 0 || canvas.height === 0) return true
    try {
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        // Sample up to 100x100 grid to keep CPU cost minimal (< 1ms)
        const stepX = Math.max(1, Math.floor(canvas.width / 50))
        const stepY = Math.max(1, Math.floor(canvas.height / 50))
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const data = imgData.data

        let nonWhitePixels = 0
        const totalSamples = Math.floor(canvas.width / stepX) * Math.floor(canvas.height / stepY)

        for (let y = 0; y < canvas.height; y += stepY) {
            for (let x = 0; x < canvas.width; x += stepX) {
                const idx = (y * canvas.width + x) * 4
                const r = data[idx]
                const g = data[idx + 1]
                const b = data[idx + 2]
                const a = data[idx + 3]
                // Transparent or near-transparent pixels are blank/empty
                if (a < 16) continue
                // A pixel is considered non-white if RGB values are significantly below 240
                if (r < 240 || g < 240 || b < 240) {
                    nonWhitePixels++
                }
            }
        }
        // If less than 1.5% of sample points are non-white, consider it a blank page
        return (nonWhitePixels / totalSamples) < 0.015
    } catch (e) {
        return false
    }
}

/**
 * Converts canvas to compressed WebP/JPEG blob
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality
 * @returns {Promise<Blob | null>}
 */
function canvasToBlob(canvas, quality = 0.88) {
    return new Promise((resolve) => {
        if (!canvas) {
            resolve(null)
            return
        }
        canvas.toBlob((blob) => {
            if (blob && blob.size > 0) {
                resolve(blob)
            } else {
                canvas.toBlob((jpegBlob) => {
                    resolve(jpegBlob || null)
                }, 'image/jpeg', quality)
            }
        }, 'image/webp', quality)
    })
}

/**
 * Extract thumbnail cover directly from a PDF source
 * @param {Blob | File | ArrayBuffer | Uint8Array} source
 * @param {object} [options]
 * @param {number} [options.maxDimension=540]
 * @param {number} [options.quality=0.88]
 * @param {object} [options.snapshot]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Blob | null>}
 */
export async function extractPdfCover(source, options = {}) {
    const { maxDimension = 540, quality = 0.88, snapshot = null, signal } = options
    if (!source) return null

    let driver = null
    try {
        const snapObj = snapshot || (source?.blob ? source : null)
        driver = new AdaptivePdfDriver({ snapshot: snapObj })
        await driver.open(source)

        if (signal?.aborted || !driver.numPages || driver.numPages === 0) return null

        // Determine appropriate scale to bound memory and bitmap dimensions
        const pageSizes = await driver.getPageSizes(0, 1, signal)
        const firstPageSize = pageSizes?.[0] || { width: 800, height: 1100 }
        const maxPageDim = Math.max(firstPageSize.width, firstPageSize.height, 1)
        const scale = Math.min(1.5, maxDimension / maxPageDim)

        // 1. Render page 1
        let canvas = null
        try {
            canvas = await driver.renderPage(0, scale, signal)
        } catch (page1Err) {
            console.warn('[PdfCover] Failed to render PDF page 1:', page1Err)
            return null
        }

        if (signal?.aborted || !canvas) return null

        // 2. Check if page 1 is blank white flyleaf and page 2 is available
        if (isCanvasBlankWhite(canvas)) {
            if (driver.numPages > 1) {
                try {
                    // Page 2 dimensions must be queried independently
                    const page2Sizes = await driver.getPageSizes(1, 1, signal)
                    const page2Size = page2Sizes?.[0] || firstPageSize
                    const maxPage2Dim = Math.max(page2Size.width, page2Size.height, 1)
                    const scale2 = Math.min(1.5, maxDimension / maxPage2Dim)
                    const canvas2 = await driver.renderPage(1, scale2, signal)
                    if (canvas2 && !isCanvasBlankWhite(canvas2)) {
                        canvas = canvas2
                    } else {
                        // Both page 1 and page 2 are blank
                        return null
                    }
                } catch (page2Err) {
                    console.warn('[PdfCover] Failed checking page 2 fallback:', page2Err)
                    return null
                }
            } else {
                // Single-page PDF and page 1 is blank
                return null
            }
        }

        // 3. Encode to Blob
        const blob = await canvasToBlob(canvas, quality)
        return blob
    } catch (err) {
        console.warn('[PdfCover] Extract PDF cover error:', err)
        return null
    } finally {
        if (driver) {
            try { driver.destroy() } catch {}
            driver = null
        }
    }
}

/**
 * Regenerate cover for an existing book in the database without modifying progress or notes
 * @param {string} bookId
 * @returns {Promise<{ success: boolean, hasCover: boolean, error?: string }>}
 */
export async function regenerateBookCover(bookId) {
    if (!bookId) return { success: false, hasCover: false, error: '缺少书籍ID' }
    try {
        const book = await db.getBook(bookId)
        if (!book) return { success: false, hasCover: false, error: '书籍不存在' }

        const snapshot = await db.getBookFileSnapshot(bookId)
        if (!snapshot?.blob) {
            return { success: false, hasCover: false, error: '本地书籍文件不存在，无法生成封面' }
        }

        let newCoverBlob = null
        const format = (book.format || '').toLowerCase()
        if (format === 'pdf') {
            newCoverBlob = await extractPdfCover(snapshot.blob, { snapshot })
        } else if (format === 'epub' || format === 'cbz') {
            try {
                const { makeZipLoader } = await import('../foliate-js-main/view.js?v=20260914_rel_v1')
                const loader = await makeZipLoader(snapshot.blob)
                const imgEntries = (loader.entries || []).filter(e => /\.(jpe?g|png|webp)$/i.test(e.filename))
                const coverEntry = imgEntries.find(e => /cover/i.test(e.filename)) || imgEntries[0]
                if (coverEntry) {
                    const mime = coverEntry.filename.endsWith('.png') ? 'image/png' : coverEntry.filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
                    newCoverBlob = await loader.loadBlob(coverEntry.filename, mime)
                }
            } catch (e) {
                console.warn('[regenerateBookCover] EPUB zip cover fallback error:', e)
            }
        }

        if (newCoverBlob) {
            await db.saveBook({ id: bookId, coverBlob: newCoverBlob })
            return { success: true, hasCover: true }
        }

        return { success: true, hasCover: false }
    } catch (err) {
        console.error('[regenerateBookCover] Error:', err)
        return { success: false, hasCover: false, error: err.message || String(err) }
    }
}
