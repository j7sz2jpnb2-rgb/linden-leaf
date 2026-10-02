# Linden Leaf Tauri / MuPDF — current development snapshot

This ZIP is a full source snapshot of the current migration work, not an installer. It intentionally keeps validation lightweight and outside the runtime path; no large “multi-review framework” was added to the product.

## What is implemented now

### Tauri baseline
- `src-tauri/tauri.conf.json` uses `node scripts/build-dist.js` as the single frontend build hook; `build.rs` no longer launches Node a second time.
- Large file reads use `tauri::ipc::Response` rather than JSON byte arrays.
- Developer-specific absolute debug-log paths were removed.
- The old stale NPM lockfile has been preserved as `package-lock.legacy-electron.json` instead of leaving a known-broken `package-lock.json`. On an online development machine run `npm install` once to generate a new lockfile containing the Tauri dependencies.

### PDF.js path
- First page is available without serially scanning every page size first.
- Remaining page geometry is refined in background batches.
- Rendering uses Canvas directly; there is no Canvas -> JPEG/WebP/Base64 -> image round-trip in the new PDF viewport.
- Visible-page rendering is prioritized and cancellable; PDF.js raster concurrency is capped at 2.
- Backing bitmap size is bounded to reduce scan-PDF memory/GPU spikes.
- Failed renders are never cached as successful white pages.
- PDF.js uses its own `TextLayer` for browser selection.

### Native MuPDF path
- `src-tauri/native/ll_mupdf.c/.h` is the v2 C ABI used by the integration.
- Supports: open/close, metadata, flat outline, real page bounds, range/batch page bounds, cached Display Lists, cached StructuredText, RGBA render, region render, character quads, char/word/line selection and cooperative `fz_cookie` cancellation.
- Rust owns each `ll_doc` on one dedicated document thread. The document/context is not called concurrently from unrelated Rust threads.
- A render request has a small cancellation token (`ll_cancel`); leaving the viewport calls `mupdf_cancel_render`, which flips MuPDF's `fz_cookie.abort` flag.
- Render pixels are returned as a compact `LLP2` binary packet and displayed directly through Canvas.
- MuPDF is optional at build time. If no SDK is configured, the application still builds with the native backend disabled and falls back to PDF.js.
- Enable it by providing `LL_MUPDF_INCLUDE`, `LL_MUPDF_LIB_DIR`, and if needed `LL_MUPDF_LIBS` before the Cargo/Tauri build.

### Native PDF selection model
- MuPDF selection truth is page-space geometry, not transparent browser fonts.
- Per-page character geometry is cached in the frontend and indexed in a small spatial grid for pointer hit-testing.
- Drag preview uses cached character quads; pointer movement does not require an IPC call for every mouse move.
- Mouse-up asks MuPDF for authoritative selection quads/text.
- Double-click uses MuPDF word snapping.
- Cross-page dragging is implemented as `{page, charIndex}` endpoints and per-page selection segments.
- Saved PDF highlights can contain `segments`, exact page-space `quads`, `pageBounds`, and legacy normalized `rects` for compatibility.

### EPUB / Foliate stabilization
- Reflow paginator uses document generations so callbacks from an old iframe document cannot commit into a new section.
- ResizeObserver, scroll, iframe-load and font-ready lifetimes are tied to the active document generation.
- HTML waits for a usable body; body-less SVG/XML chapters can use `documentElement`.
- Section-load failures are surfaced instead of silently becoming an empty white page.
- Fixed-layout navigation is transactional: the old spread remains visible while candidate iframes load; only a fully prepared current-generation spread replaces it.
- Fixed-layout custom/theme styles are supported.

### Local-path privacy
- Native filesystem paths are stored in the local-only `book_files` IndexedDB store, not normal synchronizable book metadata.
- DB version is 7 and includes migration of an old `nativePath` out of book records.

## Validation performed in this environment

The following all pass in this snapshot:

```text
node scripts/test-all-fixes.mjs                 7/7 PASS
python prototype/mupdf/verify_native.py        13 checks PASS
node prototype/mupdf/verify_frontend.mjs       PASS
node scripts/build-dist.js                      PASS
node --check on changed JS modules              PASS
```

`verify_native.py` exercises the actual C core through ctypes, including metadata/outline, batch geometry, UTF-8 text, selection quads, word/line snapping, pre-cancelled render, crop/rotation coordinates, region pixels, cache reuse/eviction and recovery after errors.

The frontend algorithm check compares 3000 virtual-scroll positions against a linear reference and performs the 10,000-page near-tail lookup in 16 indexed page reads.

## Important remaining verification boundary

This environment does not contain Rust/Cargo/MSVC/WebView2, so the new Rust -> C -> Tauri v2 path has **not** been compiled and interacted with on Windows here. The C core itself has been compiled with GCC using `-Wall -Wextra -Werror` and executed successfully.

Before calling this a release build, do on Windows:

1. Install Node dependencies with `npm install` (this generates the new `package-lock.json`).
2. Run `npm run tauri:dev` without MuPDF first; confirm EPUB and PDF.js fallback behavior.
3. Configure the MuPDF SDK environment variables and run `cargo check` / `npm run tauri:dev` again.
4. Stress-test rapid EPUB section changes, fixed-layout image books, scan PDFs, zoom, render cancellation, single-page and cross-page selection, saved highlight restoration and application restart.
5. Measure total process memory (WebView2 renderer/GPU included), not only the Rust process.

## Intentionally not expanded yet

- No large multi-review/verification subsystem was added to the runtime.
- MuPDF render concurrency remains one document worker. A cloned-context Display List renderer pool should only be added after Windows measurements show rasterization is the bottleneck.
- No custom PDF parser, font rasterizer or GPU PDF engine was introduced.
- Native link extraction is still a compatibility placeholder (`mupdf_get_links` returns an empty list).
- Full OCR for image-only PDFs is a separate feature and is not part of this native core.

## Useful entry points

- `js/pdf-driver.js` — adaptive PDF.js / native MuPDF drivers and binary packet decode.
- `js/pdf-viewport.js` — virtualized scheduling, bitmap limits, PDF.js text layer and MuPDF geometry selection.
- `src-tauri/src/commands/mupdf.rs` — Rust document worker, commands, cancellation registry and binary Response.
- `src-tauri/native/ll_mupdf.c` — native rendering/text/selection core.
- `foliate-js-main/paginator.js` — reflow iframe lifetime handling.
- `foliate-js-main/fixed-layout.js` — transactional fixed-layout navigation.
- `prototype/mupdf/` — isolated native verification/prototype utilities.
