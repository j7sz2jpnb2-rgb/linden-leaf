# Offline OCR Architecture (`PP-OCRv6` + `onnxruntime-web` + `Tesseract.js`)

Linden Leaf implements a dual-tier offline OCR pipeline designed to keep the default installer lightweight while offering high accuracy on Simplified Chinese, Traditional Chinese, vertical classical texts, English, and multilingual documents.

## Engine Tiering & Automatic Fallback

| Engine | Default Footprint | Acceleration | Best For | Availability |
| --- | --- | --- | --- | --- |
| **PP-OCRv6 Small** | ~31.2 MB weights (+ ~28 MB shared WASM) | Adaptive **WebGPU** / **WASM SIMD** in Web Worker | Traditional Chinese, vertical ancient books, mixed CJK/Latin, complex multi-column layouts | On-demand download or local import |
| **PP-OCRv6 Tiny** | ~6.3 MB weights (+ ~28 MB shared WASM) | **WASM SIMD** in Web Worker | Fast Simplified Chinese & English print on lightweight or mobile devices | On-demand download or local import |
| **Tesseract.js** | Bundled offline | WASM SIMD / LSTM | Zero-configuration built-in fallback before downloading PP-OCRv6 | Always available offline |

Resolution rule in [`js/ocr-service.js`](../js/ocr-service.js):
- `auto`: uses `ppocrv6-small` if installed and ready, else `ppocrv6-tiny`, else `tesseract`.
- Explicit `ppocrv6-small` or `ppocrv6-tiny`: uses the requested model when ready, or cleanly falls back to `tesseract` if assets are missing or WebGPU/Worker execution throws at runtime.

## Model Distribution & Security Boundary

- **Minimal Vendored Glue**: Only [`vendor/onnxruntime/ort.webgpu.min.mjs`](../vendor/onnxruntime/ort.webgpu.min.mjs) and [`vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs`](../vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs) (~118 KB total) are shipped with the app.
- **On-Demand Native Asset Manager**: [`src-tauri/src/commands/ocr_models.rs`](../src-tauri/src/commands/ocr_models.rs) downloads and verifies `det.onnx`, `rec.onnx`, `rec.yml`, and `ort-wasm-simd-threaded.jsep.wasm` under `<appDataDir>/ocr_models/` via atomic temp-file writes, HTTPS redirect policy enforcement, size limits, and user cancellation.
- **Manual Offline Import**: Users in air-gapped environments can import local files via Settings using recognizable names:
  - `*det*.onnx` → `det.onnx`
  - `*rec*.onnx` → `rec.onnx`
  - `*.yml`, `*.yaml`, or `*dict*.txt` → `rec.yml`
  - `*.wasm` → `runtime/ort-wasm-simd-threaded.jsep.wasm`
- **Browser Fallback**: Outside Tauri desktop/Android runtimes, [`js/ocr-model-manager.js`](../js/ocr-model-manager.js) persists manually imported models in IndexedDB (`linden_ocr_models_web`).

## Inference & Reader-Specific Layout Pipeline

1. **Detection (`DBNet`)**:
   - Dynamically scales the rendered page canvas up to `limit_side_len = 960` rounded to multiples of 32.
   - Packs image pixels in **BGR NCHW** order using standard ImageNet normalization (`mean = [0.485, 0.456, 0.406]`, `std = [0.229, 0.224, 0.225]`).
   - [`dbPostProcess`](../js/ocr-layout.js) extracts 8-connected components, filters by `boxThresh` (`0.45` Small / `0.40` Tiny), applies `unclipRatio = 1.4` dilation, and scales bounding rects back into page coordinates.
2. **Recognition (`SVTR` + `CTCLabelDecode`)**:
   - Tall vertical regions (`h / w >= 1.5` in `auto`, `h / w >= 1.3` in `vertical`) are rotated **90° counter-clockwise** before height-48 BGR normalization `((v / 255) - 0.5) / 0.5`.
   - Crops are sorted by aspect ratio and processed in batches (`batch = 6`) masked by `validRatio`.
   - [`parsePaddleInferenceYmlDict`](../js/ocr-layout.js) aligns index `0` to CTC blank `""` and index `N + 1` to `" "` (`18,710` classes for Small; `6,906` for Tiny).
3. **Per-Character Coordinates & Vertical Selection**:
   - [`ctcGreedyDecode`](../js/ocr-layout.js) records `[startT, endT]` timestep bounds per character, which [`projectCharRects`](../js/ocr-layout.js) maps onto page coordinates (`x` for horizontal lines, `y` top-to-bottom for vertical columns).
   - [`buildOcrCharEntries`](../js/pdf-viewport.js) constructs selectable character quads and applies `writing-mode: vertical-rl; text-orientation: upright` on vertical `.pdf-ocr-span` overlays.
4. **Reading Order, Caching & Idle Prefetch**:
   - [`sortOcrSpansByReadingOrder`](../js/ocr-layout.js) reconstructs **right-to-left vertical columns** for Classical/Traditional books and **two-column academic layouts** cleanly.
   - [`PdfToolsController`](../js/pdf-tools-controller.js) caches recognized spans per `(documentHash, pageIndex, engineTag, direction)` (`linden_ocr_v2_*`) and optionally prefetches the next 1–2 scanned pages during idle time when using PP-OCRv6.
