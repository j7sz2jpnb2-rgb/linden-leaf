<div align="center">
  <img src="assets/logo-leaf.png" alt="Linden Leaf" width="88" />

  <h1>Linden Leaf</h1>

  <p>
    <strong>A quiet, local-first eBook reader for Windows &amp; Android.</strong><br/>
    一款轻盈、本地优先的跨平台全格式电子书阅读器。
  </p>

  <p>
    <em>Dedicated to Franz Schubert (1797–1828)</em><br/>
  </p>

  <p>
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">
      <img src="https://img.shields.io/badge/release-v1.0.0%20beta-3b6e52?style=flat-square" alt="Release v1.0.0 beta" />
    </a>
    <img src="https://img.shields.io/badge/platform-Windows%20x64%20%7C%20Android%20arm64-475569?style=flat-square" alt="Platform Windows and Android" />
    <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust%20%2B%20MuPDF-52525b?style=flat-square" alt="Built with Tauri 2, Rust, and MuPDF" />
    <a href="LICENSE.txt">
      <img src="https://img.shields.io/badge/license-GPL--3.0%20%2F%20AGPL--3.0-64748b?style=flat-square" alt="License GPL-3.0 / AGPL-3.0" />
    </a>
  </p>
</div>

---

## Philosophy · 设计初衷

Linden Leaf is built for unhurried reading, lasting notes, and full ownership of your library. Your books, highlights, and reading timelines live locally on your devices first—fast offline, quiet on screen, and cleanly portable across desktop and mobile without lock-in.

菩提叶阅读面向专注的长文阅读与长期知识沉淀：本地优先、零广告、零遥测，在 Windows 桌面端与 Android 移动端之间保持克制而一致的阅读体验。

---

## Supported Formats & Platforms

| Platform | Runtime & Rendering | Supported Formats |
| --- | --- | --- |
| **Windows 10 / 11 (x64)** | Tauri 2 (Rust) + WebView2 · Native **MuPDF 1.25.4** (PDF) + **Foliate.js** | `EPUB` `PDF` `DOCX` `TXT` `MD` `MOBI` `AZW` `AZW3` `FB2` `CBZ` |
| **Android (arm64, API 24+)** | Tauri 2 Mobile + Android WebView · WebGL 3D Page Curl + **Foliate.js** / **PDF.js** | `EPUB` `PDF` `DOCX` `TXT` `MD` `MOBI` `AZW` `AZW3` `FB2` `CBZ` |

---

## Highlights · 核心特性

### Reading & Typography · 排版与阅读体验
- **Dual-Engine Rendering**：桌面端由原生 **MuPDF 1.25.4** 驱动高性能 PDF 渲染、选词、手绘批注与双视口分屏；流式电子书基于深度调优的 **Foliate.js**，支持单/双栏、竖排、页边距与行高细调、单书独立覆盖及自定义字体。
- **Thoughtful Page Turns**：Windows 桌面端默认零延迟瞬时翻页与平滑滚动，支持多窗口同时开书与 10 种格式文件关联；Android 端提供高帧率 **WebGL 3D 拟真卷页**、横向滑动与无动效模式，并保持全屏轻点唤栏与滑动翻页。
- **Adaptive Themes**：跟随系统明暗切换，内置温润纸感浅色、羊皮纸与 OLED 纯黑主题，兼顾长时间阅读舒适度。

### Notes, Insights & Export · 批注、回顾与导出
- **Highlights & Quote Cards**：支持多色划线、批注想法、书签、全文检索、PDF 涂鸦/OCR 识别，以及适合分享的精致书摘卡片。
- **Daily Reading Timeline**：记录每日每本书的阅读与听书时长（自动合并重叠区间），支持年度热力图、阅读目标与回顾统计。
- **Native Export & Backup**：双端均支持将书摘笔记、AI 对话与全量数据导出为标准 Markdown / JSON（Windows 原生保存对话框 / Android SAF）。

### Local-First Sync & Privacy · 同步与数据主权
- **Multi-Provider Sync**：支持 **WebDAV**、**本地同步目录**、**OneDrive** 与 **Google Drive** 双向增量同步进度、划线、批注、书单、标签、预设与每日阅读明细。
- **Obsidian / Logseq Friendly**：同步目录自动维护可读的 `LindenLeaf_Reading_Notes_and_Stats.md`，随时可用任意 Markdown 工具直接查阅。详见 [WebDAV Sync Specification](docs/WEBDAV_SYNC_SPECIFICATION.md)。
- **OS-Level Credential Security**：同步凭据与 API Key 由 **Windows DPAPI** 与 **Android Keystore (AES-GCM)** 本地加密保护，不写入同步包；软件无任何统计埋点或后台遥测。

### Listening & Companion Tools · 听书与伴读工具
- **Background TTS**：支持系统语音与自定义在线 TTS；Android 端具备前台媒体通知栏控制、音频焦点管理与拔耳机自动暂停。
- **On-Demand Offline Dictionary**：支持按需在线下载或本地导入 77 万词条 **ECDICT** SQLite 离线词库（不预膨胀安装包体积）。
- **Bring-Your-Own AI**：可自由接入 OpenAI、DeepSeek、本地 Ollama 等兼容接口，提供划词问答、章节总结与双语对照翻译。

---

## Downloads

Pre-built installers and signed APKs are published on the [**Releases**](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases) page:

- **Windows (x64)**: `Linden-Leaf-<version>-x64-setup.exe` — NSIS installer with bilingual setup and file associations.
- **Android (arm64-v8a)**: `Linden-Leaf-<version>-android-arm64-release.apk` — signed release build for Android 7.0+ (API 24+).

> Both Chinese (`简体中文`) and English (`English`) interfaces are built in and selectable on first launch or anytime in Settings.

---

## Building from Source

### Prerequisites
- **Node.js** `>= 20` & **pnpm** `>= 9`
- **Rust** `>= 1.80` (plus `aarch64-linux-android` target for Android)
- **Windows**: Visual Studio Build Tools (MSVC + Windows 10/11 SDK) & MuPDF 1.25.4 source (optional `MUPDF_ROOT`)
- **Android**: JDK 17+, Android SDK & NDK (`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_NDK_HOME`)

### Development & Verification
```powershell
# Load local toolchain environment (optional: set LINDEN_TOOLCHAINS_DIR / MUPDF_ROOT)
. .\scripts\env.ps1

# Prepare frontend assets and launch desktop dev app
pnpm tauri dev

# Run syntax, structure, contract, i18n, and regression test suites
pnpm check:syntax
pnpm check:structure
pnpm test:contracts
pnpm test:composition
node scripts/test-i18n.mjs
node scripts/test-regression-suite.mjs
```

### Release Builds
```powershell
# Build Windows x64 Release binary & NSIS installer
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1

# Build Android arm64 Release APK
powershell -ExecutionPolicy Bypass -File .\scripts\build-android.ps1 -Mode Release -Version 1.0.0
```

> **Android Release Signing**: Copy `src-tauri/gen/android/keystore.properties.example` to `src-tauri/gen/android/keystore.properties` (gitignored) or pass `LINDEN_ANDROID_KEYSTORE_PATH`, `LINDEN_ANDROID_KEYSTORE_PASSWORD`, `LINDEN_ANDROID_KEY_ALIAS`, and `LINDEN_ANDROID_KEY_PASSWORD`. Community builds without a release keystore automatically fall back to debug signing.

### Documentation
- [Architecture & Module Boundaries](docs/ARCHITECTURE.md)
- [WebDAV Sync Specification](docs/WEBDAV_SYNC_SPECIFICATION.md)
- [Android Page Curl Notes](docs/ANDROID_PAGE_CURL.md)
- [Android MuPDF Core Notes](docs/ANDROID_MUPDF_CORE.md)

---

## License & Network Disclosure

- **Original source code**: licensed under **GNU GPL-3.0-or-later** ([LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)).
- **Combined binaries linking MuPDF**: distributed under **GNU AGPL-3.0-or-later** ([LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)) unless under a commercial Artifex license.
- Full third-party notices (Foliate.js, PDF.js, Tesseract.js, Mammoth.js, bundled OFL fonts) and exact network/privacy disclosures (including optional GitHub Releases update checks) are documented in [LICENSE.txt](LICENSE.txt).

<sub>原创源码遵循 GPL-3.0-or-later；集成 MuPDF 核心后的组合安装包遵循 AGPL-3.0-or-later，详细第三方组件与隐私说明见 [LICENSE.txt](LICENSE.txt)。</sub>
