# Changelog

All notable changes to **Linden Leaf** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Offline PP-OCRv6 + ONNX Runtime Web Engine**:
  - Added on-demand offline download and local import for **PP-OCRv6 Small** (~31.2 MB; Simplified/Traditional Chinese, vertical classical books, English, Japanese, Korean, 50 languages) and **PP-OCRv6 Tiny** (~6.3 MB) via [`src-tauri/src/commands/ocr_models.rs`](src-tauri/src/commands/ocr_models.rs) with domestic mirror support (`hf-mirror.com` / `fastly.jsdelivr.net`).
  - Added isolated ONNX Web Worker ([`js/ocr-onnx-worker.js`](js/ocr-onnx-worker.js)) with adaptive **WebGPU** / single-threaded **WASM SIMD** execution and automatic fallback to built-in **Tesseract.js**.
  - Added horizontal, two-column academic, and **right-to-left vertical** reading-order reconstruction ([`js/ocr-layout.js`](js/ocr-layout.js)), per-character CTC bounding boxes, `writing-mode: vertical-rl` selectable PDF overlays, versioned OCR page caching, and idle next-page prefetch.
- **Serious Reading & Research Upgrades**:
  - **Zero-Copy External PDF Opening & Ephemeral Mode**: Instant read-only desktop PDF opening without mandatory full IndexedDB copy, plus one-click "Pin to Library".
  - **Incremental Markdown Sidecar**: Per-book Markdown export that updates managed annotation blocks idempotently without overwriting user prose in Obsidian / Logseq.
  - **Standard PDF Annotation Round-Trip**: Extracts embedded PDF annotations and writes highlights, underlines, strikethroughs, sticky notes, freehand ink, and erased strokes cleanly back to `.pdf`.
  - **PDF Auto-Crop & Dark-Mode Color Image Preservation**: Automatic whitespace crop plus true-color illustration preservation under inverted/dark reader themes.
  - **Custom Offline Dictionaries & Kindle Import**: Local import for **MDict (`.mdx`)** and **StarDict (`.ifo`/`.idx`/`.dict[.dz]`)** dictionaries alongside **Kindle `My Clippings.txt`** deduplicated shelf import.
  - **Reading Ergonomics & Customizable Toolbar**: Horizontal reading ruler, focus paragraph dimming, instant Privacy Veil (`Alt+Shift+H`), customizable reader top toolbar with overflow menu and interactive quick tour.
  - **Sync Divergence & Book Relinking**: Sync progress divergence banner with direct cross-device jump, plus text-fingerprint relinking for moved/renamed local books.
  - **Streaming Large TXT, Purifier & CJK Script**: Rust streaming chapter reader for large `.txt` books, configurable ad/blank-line purifier, and reversible Simplified ↔ Traditional Chinese chapter conversion.
- **AI Reading Companion Options**:
  - **Windows External Browser AI Companion**: Bundled Chromium Manifest V3 extension ([`extensions/chromium-companion/`](extensions/chromium-companion/README.md)) with Native Messaging and side-by-side window docking for ChatGPT, Gemini, Google AI Studio, DeepSeek, and user-authorized HTTPS sites.
  - **Sign in with ChatGPT (Optional OAuth 2.0 PKCE Branch)**: Direct authenticated session support alongside BYOK OpenAI-compatible APIs under shared cooldown, quota, and audit guards.

## [1.0.0]

### Added
- Initial cross-platform release for **Windows (x64)** and **Android (arm64, API 24+)** built on **Tauri 2**, **Rust**, **MuPDF 1.25.4** (with `CVE-2026-7233`, `CVE-2026-3308`, `CVE-2026-25556` backports), **PDF.js**, and **Foliate.js**.
- 10-format reading desk (`EPUB`, `PDF`, `DOCX`, `TXT`, `MD`, `MOBI`, `AZW`, `AZW3`, `FB2`, `CBZ`), multi-window desktop reading, Android 3D WebGL page curl, background Android TTS service, ECDICT offline dictionary, and WebDAV / Local Folder / OneDrive / Google Drive sync.
