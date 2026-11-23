<div align="center">
  <img src="assets/logo-leaf.png" alt="Linden Leaf" width="84" />

  <h1>Linden Leaf · 菩提叶阅读</h1>

  <p>
    <strong>一款轻盈、本地优先的跨平台全格式电子书阅读与 PDF 研读工作台。</strong><br/>
    <sub>A quiet, local-first eBook reader &amp; PDF study workbench for Windows and Android.</sub>
  </p>

  <p>
    <em>献给弗朗茨·舒伯特（Franz Schubert, 1797–1828）</em>
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
    <a href="README.md">English</a> · <strong>简体中文</strong> ·
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">下载安装包</a> ·
    <a href="docs/ARCHITECTURE.md">架构文档</a>
  </p>
</div>

---

菩提叶阅读（Linden Leaf）为不疾不徐的长文阅读、深度的 PDF 资料研读与长期知识沉淀而生。你的书籍、划线批注与阅读记录默认完全保存在自己的设备上——离线敏捷、界面克制，并以开放格式在 Windows 与 Android 之间自由流转。

应用内置完整的 **简体中文 / English** 双语界面，首次启动即可选择，之后随时可在设置中实时切换。

---

## 平台与渲染引擎

| 平台 | 运行框架与存储 | PDF 渲染引擎 | 流式电子书与漫画引擎 | 翻页与原生特性 |
| --- | --- | --- | --- | --- |
| **Windows 10 / 11 (x64)** | Tauri 2 (Rust) + WebView2 · IndexedDB + SQLite | 原生 **MuPDF 1.25.4**（支持可选多线程并行渲染）+ **PDF.js** 备用 | **Foliate.js**（`EPUB` `MOBI` `AZW` `AZW3` `DOCX` `FB2` `CBZ` `TXT` `MD`） | 零延迟瞬时翻页、平滑滚动、真正多窗口同时开书、10 种格式文件关联 |
| **Android (arm64, API 24+)** | Tauri 2 Mobile + Android WebView · IndexedDB + SQLite | **PDF.js**（默认）+ Release 包内置可切换原生 **MuPDF 1.25.4** | **Foliate.js**（`EPUB` `MOBI` `AZW` `AZW3` `DOCX` `FB2` `CBZ` `TXT` `MD`） | 3D WebGL 拟真卷页 / 滑动 / 无动效、全屏轻点唤栏、后台听书通知栏、SAF 导入导出 |

---

## 核心亮点

### 1. 专业级 PDF 研读工作台
- **原生 MuPDF 1.25.4 核心**：Windows 端默认提供高速矢量渲染与高精度选词，并可在设置中开启可选双页多线程光栅化；Android 正式包同时内置 **PDF.js 与 MuPDF 双引擎**，支持在阅读设置中保留当前位置原位切换，异常时自动回退保障可读性。
- **双视口参考页分屏**：在阅读正文的同时，将图表、公式、注释或附录固定在独立副视口中对照查阅，不再来回翻找。
- **裁边、扫描增强与离线 OCR**：支持奇偶页独立裁边、无损扫描件增强滤镜，并内置离线 **Tesseract.js OCR**，直接为扫描版 PDF 生成可选词、可检索的文本层。
- **真实带批注 PDF 回写导出**：高亮、下划线、删除线、批注、手绘墨迹及橡皮擦除结果均支持直接写回并导出为标准带批注 PDF，并支持手动目录与 OCR 辅助目录整理。

### 2. 流式电子书精排与 TXT 智能整理
- **十种格式统一书桌**：原生支持 `EPUB`、`PDF`、`DOCX`、`TXT`、`MD`、`MOBI`、`AZW`、`AZW3`、`FB2`、`CBZ`。
- **尊重原书的排版自由度**：EPUB 默认保留出版社原书样式，同时支持精细调整字号、行高、页边距、单/双栏、中文竖排、导入本地自定义字体、命名阅读预设与单书独立覆盖。
- **TXT / Markdown 深度整理**：自动识别编码、提取章节与可点击目录、识别诗歌排版、清理软换行，并支持在独立 Worker 中安全测试自定义章节正则与重建目录。
- **温润纸感与 OLED 暗色**：默认跟随系统明暗，内置浅色纸感、羊皮纸、深色、OLED 纯黑及可定制语义主题。

### 3. 桌面生产力与移动端手感并重
- **真正的多窗口并行阅读**：Windows 端支持书架主窗搭配多个独立书籍阅读窗口同时对照研读，主题与界面语言跨窗口实时同步。
- **本地文件夹关联书库**：可将本机现有书籍目录直接关联为书库并增量重扫；支持窗口置顶、自动滚屏以及阅读位置前进/后退历史栈。
- **克制顺手的移动端体验**：专为手机打造的移动外壳，提供高帧率 **3D WebGL 拟真卷页**与横向滑动翻页，支持全屏轻点任意正文/空白处呼出工具栏、左右滑动翻页。

### 4. 批注、全文检索与阅读时光轴
- **全库全文检索**：支持单书内检索与跨全库检索（适配中文精准匹配），渐进呈现结果并一键直达对应段落。
- **多色划线与书摘分享卡**：支持多色高亮、随手批注、书签、脚注气泡预览，以及可直接保存或分享的精致排版书摘卡片。
- **真实的阅读与听书统计**：按日记录每本书的阅读与听书时长（自动合并同时看书与听书的重叠时段），提供年度热力图、阅读目标追踪，以及通过 Windows 原生对话框或 Android SAF 导出标准 Markdown / JSON 笔记与全量备份。

### 5. 本地优先的多端同步（天然契合 Obsidian）
- **四种同步存储自由选择**：支持 **WebDAV**、**本地同步目录**、**OneDrive** 与 **Google Drive** 双向增量同步阅读进度、划线笔记、PDF 批注、自定义书单、评分标签、阅读预设与每日阅读明细。
- **自动维护可读 Markdown 总览**：同步目录自动生成结构清晰的 `LindenLeaf_Reading_Notes_and_Stats.md`，可直接使用 **Obsidian**、**Logseq** 或任意 Markdown 编辑器查阅每日读书记录与书摘。
- **随时可迁移的完整备份**：支持一键导出/恢复包含元数据、批注、阅读历史与设置的本地 JSON 备份。

### 6. 后台听书、离线词库与可选 AI 伴读
- **听书与 Android 前台媒体服务**：支持系统语音及自定义在线 TTS 接口；Android 端配备锁屏/通知栏媒体控制、音频焦点管理与拔耳机自动暂停，并自动计入听书时长。
- **按需离线词库**：支持一键在线下载或本地导入 **77 万词条 ECDICT** SQLite 离线英汉词典，零延迟划词查词，同时保持基础安装包轻巧。
- **自备接口的 AI 伴读**：可选接入 **OpenAI**、**DeepSeek**、本地 **Ollama** 或任意 OpenAI 兼容服务，支持划词提问、段落解析、章节总结与正文内嵌双语对照翻译。

---

## 隐私与安全设计

- **本地优先，零遥测**：无需注册账号、无广告、无行为埋点，阅读数据始终由你掌控。
- **系统级凭据加密**：同步密码、云盘令牌与 AI/TTS 密钥在 Windows 下经 **DPAPI**、在 Android 下经 **Android Keystore (AES-GCM)** 本地加密存储，不写入同步数据包。
- **安全加固的渲染隔离**：流式电子书运行在禁用脚本的沙盒视图中；内置 MuPDF 1.25.4 已回移 `CVE-2026-7233`、`CVE-2026-3308`、`CVE-2026-25556` 安全补丁。
- **透明的联网边界**：除你主动使用的云同步、词库下载、AI/TTS 服务及主窗口启动时可选的 GitHub Releases 版本检查外，不发起其他网络请求。完整说明见 [LICENSE.txt](LICENSE.txt)。

---

## 下载与安装

请前往 [**GitHub Releases**](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases) 页面获取最新预编译安装包：

- **Windows (x64)**：`Linden-Leaf-1.0.0-x64-setup.exe`（中英文双语 NSIS 安装程序，内置 MuPDF 与 10 种格式文件关联）
- **Android (arm64-v8a)**：`Linden-Leaf-1.0.0-android-arm64-release.apk`（正式签名 Release 包，支持 Android 7.0 / API 24 及以上）

> 如果手机此前安装过早期的 Debug 测试包，请先卸载旧 Debug 版再安装正式签名 Release APK。

---

## 从源码构建与验证

### 环境要求
- **Node.js** `>= 20` 与 **pnpm** `>= 9`
- **Rust** `>= 1.80`（编译 Android 需安装 `aarch64-linux-android` target）
- **Windows**：Visual Studio 生成工具（MSVC + Windows 10/11 SDK）与 MuPDF 1.25.4 源码（可通过 `MUPDF_ROOT` 指定）
- **Android**：JDK 17+、Android SDK 与 NDK（`JAVA_HOME`、`ANDROID_HOME`、`ANDROID_NDK_HOME`）

### 本地开发与全量测试
```powershell
# 加载会话工具链环境（可选配置 LINDEN_TOOLCHAINS_DIR / MUPDF_ROOT）
. .\scripts\env.ps1

# 启动桌面端开发预览
pnpm tauri dev

# 运行全套 JS 语法、结构、契约、双语、安全与 Rust 单元测试
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

### 构建发布包
```powershell
# 构建 Windows x64 Release 二进制与 NSIS 安装包
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1

# 构建 Android arm64 Release APK（默认同时包含 PDF.js 与 MuPDF 双引擎）
powershell -ExecutionPolicy Bypass -File .\scripts\build-android.ps1 -Mode Release -Version 1.0.0
```

> **Android 正式签名配置**：复制 `src-tauri/gen/android/keystore.properties.example` 为 `src-tauri/gen/android/keystore.properties`（已被 `.gitignore` 忽略），或设置环境变量 `LINDEN_ANDROID_KEYSTORE_PATH` / `LINDEN_ANDROID_KEYSTORE_PASSWORD` / `LINDEN_ANDROID_KEY_ALIAS` / `LINDEN_ANDROID_KEY_PASSWORD`。开源社区本地编译未提供密钥时会自动回退至 Debug 签名。

---

## 技术文档导航

| 文档 | 内容说明 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块职责边界、共享数据模型与验证入口 |
| [docs/WEBDAV_SYNC_SPECIFICATION.md](docs/WEBDAV_SYNC_SPECIFICATION.md) | 同步数据模型、冲突合并规则与备份规范 |
| [docs/ANDROID_MUPDF_CORE.md](docs/ANDROID_MUPDF_CORE.md) | Android 原生 MuPDF 桥接、分块渲染规划与双引擎切换 |
| [docs/ANDROID_PAGE_CURL.md](docs/ANDROID_PAGE_CURL.md) | 移动端 WebGL 拟真卷页架构、纹理预算与降级机制 |
| [patches/README.md](patches/README.md) | MuPDF 1.25.4 CVE 安全补丁回移说明 |

---

## 开源许可

- **原创源代码**：基于 **GNU GPL-3.0-or-later** 开源（见 [LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)）。
- **集成 MuPDF 的组合二进制安装包**：整体遵循 **GNU AGPL-3.0-or-later**（见 [LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)）或 Artifex 商业授权。
- 完整的第三方组件授权（Foliate.js、PDF.js、Tesseract.js、Mammoth.js、内置 OFL 字体）及隐私联网边界说明请参见 [LICENSE.txt](LICENSE.txt)。
