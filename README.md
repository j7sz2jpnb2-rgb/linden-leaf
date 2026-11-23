<div align="center">
  <img src="assets/logo-leaf.png" alt="Linden Leaf" width="84" />

  <h1>Linden Leaf</h1>

  <p>
    <strong>A quiet, local-first eBook reader &amp; PDF study workbench for Windows and Android.</strong><br/>
    <sub>菩提叶阅读 · 轻盈、本地优先的跨平台全格式电子书阅读与研读工作台</sub>
  </p>

  <p>
    <em>Dedicated to Franz Schubert (1797–1828)</em>
  </p>

  <p>
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">
      <img src="https://img.shields.io/badge/release-v1.0.0%20beta-3b6e52?style=flat-square" alt="Release v1.0.0 beta" />
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

Linden Leaf is built for unhurried long-form reading, serious PDF study, and lasting personal notes. Your books, highlights, and reading history stay local on your own devices first—fast offline, calm on screen, and cleanly portable between Windows and Android in open formats.

Built-in **English** and **Simplified Chinese (`简体中文`)** interfaces are selectable on first launch or anytime in Settings.

---

## Platforms & Rendering Engines

| Platform | Shell & Storage | PDF Engine | Reflowable & Comic Engine | Page Turns & Native UX |
| --- | --- | --- | --- | --- |
| **Windows 10 / 11 (x64)** | Tauri 2 (Rust) + WebView2 · IndexedDB + SQLite | Native **MuPDF 1.25.4** (optional multi-threaded rendering) + **PDF.js** fallback | **Foliate.js** (`EPUB`, `MOBI`, `AZW`, `AZW3`, `DOCX`, `FB2`, `CBZ`, `TXT`, `MD`) | Instant zero-latency turns, smooth scroll, true multi-window reading, 10 file associations |
| **Android (arm64, API 24+)** | Tauri 2 Mobile + Android WebView · IndexedDB + SQLite | **PDF.js** (default) + switchable native **MuPDF 1.25.4** in Release builds | **Foliate.js** (`EPUB`, `MOBI`, `AZW`, `AZW3`, `DOCX`, `FB2`, `CBZ`, `TXT`, `MD`) | 3D WebGL Page Curl / Slide / Instant, full-screen tap controls, background media TTS, SAF export |

---

## What Makes Linden Leaf Stand Out

### 1. A Serious PDF Study Workbench
- **Native MuPDF 1.25.4 Core**: Crisp vector rendering and accurate text selection on Windows—with optional dual-page parallel rasterization for heavy documents—plus in-place **PDF.js ↔ MuPDF** engine switching on Android Release builds with automatic fallback.
- **Split-Screen Reference View**: Pin a figure, table, footnote, or appendix in a secondary viewport while continuing to read and annotate in the main view.
- **Crop, Scan Cleanup & Offline OCR**: Independent odd/even page margin cropping, non-destructive scan enhancement filters, and built-in offline **Tesseract.js OCR** that turns scanned pages into selectable, searchable text layers.
- **Real Annotated PDF Export**: Highlights, underlines, strikethroughs, sticky notes, freehand ink, and eraser strokes write back cleanly into standard annotated PDF files alongside manual or OCR-assisted tables of contents.

### 2. Reflowable Reading & Smart TXT Formatting
- **10 Formats, One Quiet Desk**: Native support for `EPUB`, `PDF`, `DOCX`, `TXT`, `MD`, `MOBI`, `AZW`, `AZW3`, `FB2`, and `CBZ`.
- **Typography That Respects the Book**: Preserves publisher EPUB layouts by default while letting you customize fonts, margins, line height, dual-column spreads, vertical CJK typesetting, custom font imports, named reading presets, and per-book overrides.
- **Thoughtful TXT & Markdown Engine**: Automatic encoding detection, chapter & table-of-contents parsing, poetry layout recognition, soft line-wrap repair, and custom regex chapter rules tested safely in an isolated Worker.
- **Tactile Themes**: Follows your system light/dark mode with warm paper, parchment, dark, OLED black, and customizable semantic color themes.

### 3. Tailored Desktop Productivity & Mobile Craft
- **True Multi-Window Desktop Reading**: Open multiple books simultaneously in independent satellite reader windows alongside the main bookshelf, with live cross-window theme and language sync.
- **Linked Local Libraries**: Link existing folders on Windows as live shelves with incremental rescanning, plus always-on-top pinning, auto-scroll, and back/forward reading location history.
- **Fluid Mobile Reading**: Dedicated Android shell with warm editorial aesthetics, high-frame-rate **3D WebGL Page Curl** and **Slide** modes, full-screen tap-to-toggle toolbars, and swipe navigation.

### 4. Notes, Full-Library Search & Reading Journal
- **Full-Text Search**: Fast search inside the current book or across your entire library—including accurate CJK matching—with progressive results and direct jump-to-passage navigation.
- **Highlights & Quote Cards**: Multi-color highlights, inline notes, bookmarks, footnote popups, and typographic quote cards ready to save or share.
- **Honest Reading & Listening Timeline**: Tracks daily per-book reading and listening duration (intelligently merging overlapping sessions), complete with a yearly activity heatmap, reading goals, and Markdown/JSON export via Windows native dialogs or Android SAF.

### 5. Local-First Multi-Cloud Sync (Obsidian-Friendly)
- **Choose Your Own Storage**: Bidirectional incremental sync across **WebDAV**, **Local Folder**, **OneDrive**, and **Google Drive**—syncing reading progress, highlights, notes, PDF annotations, reading lists, ratings, tags, presets, and daily timelines.
- **Readable Markdown Mirror**: Your sync directory automatically maintains a clean, human-readable `LindenLeaf_Reading_Notes_and_Stats.md` so you can browse your notes and daily log directly in **Obsidian**, **Logseq**, or any text editor.
- **Full Local Backups**: Export and restore complete structured JSON backups of metadata, annotations, reading history, and preferences at any time.

### 6. Background Listening, Offline Dictionary & Optional AI
- **TTS & Android Background Audio**: Works with system voices and custom HTTP/OpenAI-compatible TTS endpoints. On Android, a dedicated foreground media service brings lock-screen & notification controls, audio focus handling, and automatic pause when headphones disconnect.
- **On-Demand Offline Dictionary**: Download or import the 770,000+ entry **ECDICT** SQLite dictionary for instant offline word lookup without bloating the base installer.
- **Bring-Your-Own AI Companion**: Optionally connect **OpenAI**, **DeepSeek**, local **Ollama**, or any OpenAI-compatible API for selection Q&A, passage explanations, chapter summaries, and inline bilingual chapter translation.

---

## Privacy & Security by Design

- **Local-First, Zero Telemetry**: No account required, no ads, no analytics, and no hidden background tracking.
- **OS-Level Credential Protection**: Sync passwords, OAuth tokens, and AI/TTS API keys are encrypted locally using **Windows DPAPI** and **Android Keystore (AES-GCM)** and are excluded from sync payloads.
- **Hardened Rendering**: Reflowable books render inside script-disabled sandboxed frames; the bundled MuPDF 1.25.4 core includes security backports (`CVE-2026-7233`, `CVE-2026-3308`, `CVE-2026-25556`).
- **Transparent Network Access**: Network requests occur only for user-configured sync, dictionary downloads, AI/TTS endpoints, and an optional GitHub Releases update check on startup. See [LICENSE.txt](LICENSE.txt) for full disclosures.

---

## Downloads

Pre-built beta packages are available on the [**GitHub Releases**](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases) page:

- **Windows (x64)**: `Linden-Leaf-1.0.0-x64-setup.exe` — Bilingual NSIS installer with native MuPDF and file associations for all 10 formats.
- **Android (arm64-v8a)**: `Linden-Leaf-1.0.0-android-arm64-release.apk` — Signed Release APK for Android 7.0+ (API 24+).

> If upgrading from an earlier debug APK on Android, uninstall the debug build once before installing the signed Release APK.

---

## Building from Source

### Prerequisites
- **Node.js** `>= 20` and **pnpm** `>= 9`
- **Rust** `>= 1.80` (with `aarch64-linux-android` target for Android)
- **Windows**: Visual Studio Build Tools (MSVC + Windows 10/11 SDK) and MuPDF 1.25.4 source (optional `MUPDF_ROOT`)
- **Android**: JDK 17+, Android SDK & NDK (`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_NDK_HOME`)

### Development & Verification
```powershell
# Load session toolchain variables (optional: set LINDEN_TOOLCHAINS_DIR / MUPDF_ROOT)
. .\scripts\env.ps1

# Launch desktop development preview
pnpm tauri dev

# Run full JS & Rust verification suites
pnpm check:syntax
pnpm check:structure
pnpm test:contracts
pnpm test:composition
pnpm test:reader-search
pnpm test:android-tts
pnpm test:prebeta
node scripts/test-i18n.mjs
node scripts/test-i18n-interactions.mjs
node scripts/test-ui-output-safety.mjs
node scripts/test-regression-suite.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline
```

### Release Packaging
```powershell
# Build Windows x64 Release binary & NSIS installer
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1

# Build Android arm64 Release APK (includes both PDF.js and MuPDF by default)
powershell -ExecutionPolicy Bypass -File .\scripts\build-android.ps1 -Mode Release -Version 1.0.0
```

> **Android Release Signing**: Copy `src-tauri/gen/android/keystore.properties.example` to `src-tauri/gen/android/keystore.properties` (gitignored) or set `LINDEN_ANDROID_KEYSTORE_PATH`, `LINDEN_ANDROID_KEYSTORE_PASSWORD`, `LINDEN_ANDROID_KEY_ALIAS`, and `LINDEN_ANDROID_KEY_PASSWORD`. Community builds without a local keystore automatically fall back to debug signing.

---

## Documentation

| Document | Scope |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module boundaries, shared data models, and verification commands |
| [docs/WEBDAV_SYNC_SPECIFICATION.md](docs/WEBDAV_SYNC_SPECIFICATION.md) | Sync data schema, merge rules, and backup format specification |
| [docs/ANDROID_MUPDF_CORE.md](docs/ANDROID_MUPDF_CORE.md) | Android native MuPDF rendering bridge, tile planner, and dual-engine switching |
| [docs/ANDROID_PAGE_CURL.md](docs/ANDROID_PAGE_CURL.md) | Mobile WebGL page curl architecture, texture budgets, and fallbacks |
| [patches/README.md](patches/README.md) | MuPDF 1.25.4 CVE security patch backport notes |

---

## License

- **Original source code**: licensed under **GNU GPL-3.0-or-later** ([LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)).
- **Combined binaries linking MuPDF**: distributed under **GNU AGPL-3.0-or-later** ([LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)) unless under a commercial Artifex license.
- Complete third-party notices (Foliate.js, PDF.js, Tesseract.js, Mammoth.js, bundled OFL fonts) and network/privacy disclosures are listed in [LICENSE.txt](LICENSE.txt).
