<div align="center">
  <img src="assets/logo-leaf.png" alt="Linden Leaf" width="84" />

  <h1>Linden Leaf</h1>

  <p>
    <strong>A local-first eBook reader &amp; PDF study workbench for Windows and Android.</strong><br/>
    <sub>菩提叶阅读 · 本地优先的跨平台全格式电子书与 PDF 研读工作台</sub>
  </p>

  <p>
    <em>Dedicated to Franz Schubert (1797–1828)</em>
  </p>

  <p>
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">
      <img src="https://img.shields.io/badge/release-v1.0.0-3b6e52?style=flat-square" alt="Release v1.0.0" />
    </a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Android%20arm64-475569?style=flat-square" alt="Platforms" />
    <img src="https://img.shields.io/badge/engine-Tauri%202%20%C2%B7%20MuPDF%20%C2%B7%20Foliate.js-52525b?style=flat-square" alt="Stack" />
    <a href="LICENSE.txt">
      <img src="https://img.shields.io/badge/license-GPL--3.0%20%2F%20AGPL--3.0-64748b?style=flat-square" alt="License" />
    </a>
  </p>

  <p>
    <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">Downloads</a> ·
    <a href="docs/ARCHITECTURE.md">Architecture</a>
  </p>
</div>

---

Linden Leaf is built for serious long-form reading, technical PDF study, and durable personal notes. Your books, highlights, and reading history stay local on your own devices first—fast offline, quiet on screen, and portable across Windows and Android in open formats.

Built-in **English** and **Simplified Chinese (`简体中文`)** interfaces can be switched anytime.

---

## Features

### PDF Study Workbench
- **Native MuPDF + PDF.js Dual Engine**: High-precision vector rendering on Windows (with optional dual-page parallel rasterization), plus switchable **PDF.js ↔ MuPDF** engines on Android Release builds with automatic fallback.
- **Zero-Copy Opening & Split Reference View**: Open external local PDFs instantly without duplicating files first; pin figures, tables, or appendices into a split reference pane while navigating forward/back through your reading history.
- **Crop, Scan Cleanup & Dark-Mode Color Preservation**: Automatic whitespace detection with odd/even margin cropping, scan clarity presets, and true-color preservation for embedded illustrations when reading in dark mode.
- **Standard PDF Annotation Round-Trip**: Reads embedded PDF annotations and writes highlights, underlines, strikethroughs, sticky notes, freehand ink, and eraser edits cleanly back into standard `.pdf` files.

### Offline OCR for Real Books
- **Ready Out of the Box + On-Demand PP-OCRv6**: Works offline immediately with built-in **Tesseract.js**, or enable on-demand **PP-OCRv6** (*Small* for multilingual/Traditional/classical texts, *Tiny* for fast light hardware) accelerated via Web Worker **WebGPU** or **WASM SIMD** with mirror and local file import support.
- **Horizontal, Two-Column & Vertical Right-to-Left**: Reconstructs academic two-column layouts and Classical/Traditional Chinese **vertical right-to-left columns** into selectable text overlays with per-character bounding boxes, persistent page caching, and idle lookahead pre-OCR. *(See [docs/OFFLINE_OCR.md](docs/OFFLINE_OCR.md) for architecture details.)*

### Ten Formats, Typography & Giant TXT
- **Ten Native Formats**: `EPUB`, `PDF`, `DOCX`, `TXT`, `MD`, `MOBI`, `AZW`, `AZW3`, `FB2`, and `CBZ`.
- **Publisher Fidelity & Fine Controls**: Preserves publisher EPUB typography by default while unlocking fonts, custom font imports, margins, dual-column spreads, vertical CJK typesetting, named presets, and reversible **Simplified ↔ Traditional Chinese** conversion.
- **Streaming Large TXT Engine**: Rust-backed incremental chapter streaming handles massive `.txt` novels smoothly alongside encoding detection, poetry formatting, content purification rules, and isolated regex TOC rules.

### Local-First Sync & Obsidian Workflow
- **Four Sync Backends + Divergence Guard**: Bidirectional incremental sync via **WebDAV**, **Local Folder**, **OneDrive**, or **Google Drive**, with an explicit conflict/divergence banner so remote progress never silently overwrites local reading.
- **Obsidian-Friendly Markdown Sidecar**: Updates Linden Leaf's managed note blocks per book idempotently while keeping your own Obsidian/Logseq prose, tags, and backlinks untouched, alongside `LindenLeaf_Reading_Notes_and_Stats.md`.
- **Text-Fingerprint Relinking & Kindle Import**: Rebind moved or renamed local books via text fingerprints without losing notes, import deduplicated **Kindle `My Clippings.txt`** highlights, and export/restore full JSON backups anytime.

### Ergonomics, Dictionaries & Listening
- **Focus & Privacy Aids**: Horizontal reading ruler, paragraph focus dimming, instant Privacy Veil (`Alt+Shift+H`), customizable reader top toolbar with onboarding guide, tactile paper/OLED themes, and **Android 3D WebGL Page Curl**.
- **ECDICT + Custom MDict / StarDict**: Download the offline **ECDICT** dictionary on demand or import local **`.mdx`** and **StarDict** dictionaries.
- **Background TTS & Honest Stats**: System or custom HTTP TTS with Android foreground media controls (lock-screen playback, audio focus, headphone-unplug pause), plus full-library CJK search and overlap-aware reading/listening heatmaps.

### AI Reading Companion (BYOA & BYOK)
- **Bring Your Own AI (Windows Browser Companion)**: Connect your already logged-in Chrome or Edge session (**ChatGPT**, **Gemini**, **Google AI Studio**, **DeepSeek**, or custom HTTPS sites) via the bundled Chromium extension ([setup guide](extensions/chromium-companion/README.md)) and side-by-side window docking. Keeps one continuous conversation per book without extra API billing or WebView login issues, and lets you pull replies back into your book notes.
- **Bring Your Own Key (BYOK) & Official Sign-In**: Also supports connecting **OpenAI**, **DeepSeek**, local **Ollama**, or any OpenAI-compatible API directly in the built-in sidebar, plus optional **Sign in with ChatGPT**, with local cooldowns, daily limits, and audit logs.

---

## Platforms at a Glance

| Platform | Stack | Key Capabilities |
| --- | --- | --- |
| **Windows 10 / 11 (x64)** | Tauri 2 (Rust) + WebView2 · MuPDF 1.25.4 + PDF.js · Foliate.js | Zero-copy PDF open, multi-window reading, Chromium Browser AI Companion, linked local folders, 10 file associations |
| **Android (arm64, API 24+)** | Tauri 2 Mobile + Android WebView · PDF.js + switchable MuPDF · Foliate.js | 3D WebGL Page Curl / Slide modes, full-screen tap UI, foreground media TTS service, SAF import/export |

---

## Privacy & Security

- **Zero Telemetry**: No user accounts, no ads, and no analytics. Books, highlights, and reading logs stay on your device unless you configure sync or AI.
- **OS Credential Protection**: Sync secrets, OAuth tokens, and API keys are encrypted via **Windows DPAPI** and **Android Keystore** and omitted from sync payloads.
- **Sandboxed Rendering & Hardening**: Reflowable books run in script-disabled frames; local companion IPC enforces user-scoped ACLs; bundled MuPDF includes CVE security backports. See [SECURITY.md](SECURITY.md) and [LICENSE.txt](LICENSE.txt).

---

## Downloads & Building from Source

Pre-built Windows (`x64` NSIS installer) and Android (`arm64-v8a` Release APK) packages are available on [**GitHub Releases**](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases).

**Prerequisites**: Node.js `>= 20`, pnpm `>= 9`, Rust `>= 1.80`, plus MSVC/Windows SDK (Windows) or JDK 17 + Android SDK/NDK (Android).

```powershell
# Load local session toolchain paths if needed
. .\scripts\env.ps1

# Start desktop dev window
pnpm tauri dev

# Run all 17 frontend verification suites (syntax, structure, i18n, safety, contracts, OCR, regressions)
npm run verify

# Run Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline

# Package Windows x64 installer or Android arm64 APK
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\build-android.ps1 -Mode Release -Version 1.0.0
```

> Community Android builds without a local release keystore automatically fall back to debug signing (`src-tauri/gen/android/keystore.properties.example`).

---

## Documentation

| Document | Scope |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module boundaries, shared data models, and verification entrypoints |
| [docs/OFFLINE_OCR.md](docs/OFFLINE_OCR.md) | Dual-tier PP-OCRv6 + Tesseract architecture, vertical/column layout, and offline import |
| [extensions/chromium-companion/README.md](extensions/chromium-companion/README.md) | Windows Browser AI Companion extension setup and local IPC security model |
| [docs/WEBDAV_SYNC_SPECIFICATION.md](docs/WEBDAV_SYNC_SPECIFICATION.md) | Sync schema, merge rules, divergence checks, and backups |
| [docs/ANDROID_MUPDF_CORE.md](docs/ANDROID_MUPDF_CORE.md) | Android native MuPDF bridge, tile planner, and dual-engine switching |
| [docs/ANDROID_PAGE_CURL.md](docs/ANDROID_PAGE_CURL.md) | Android WebGL page curl architecture and texture budgets |
| [patches/README.md](patches/README.md) | MuPDF 1.25.4 CVE security patch backports |
| [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | Changelog, contributor guide, and security policy |

---

## License

- **Original source code**: **GNU GPL-3.0-or-later** ([LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt))
- **Combined binaries linking MuPDF**: **GNU AGPL-3.0-or-later** ([LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)) unless under a commercial Artifex license
- Full third-party notices and network disclosures are documented in [LICENSE.txt](LICENSE.txt).
