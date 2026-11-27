<div align="center">
  <img src="assets/logo-leaf.png" alt="Linden Leaf" width="84" />

  <h1>Linden Leaf · 菩提叶阅读</h1>

  <p>
    <strong>本地优先的跨平台全格式电子书阅读与 PDF 研读工作台（Windows &amp; Android）。</strong><br/>
    <sub>A local-first eBook reader &amp; PDF study workbench for Windows and Android.</sub>
  </p>

  <p>
    <em>献给弗朗茨·舒伯特（Franz Schubert, 1797–1828）</em>
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
    <a href="README.md">English</a> · <strong>简体中文</strong> ·
    <a href="https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases">下载安装包</a> ·
    <a href="docs/ARCHITECTURE.md">架构文档</a>
  </p>
</div>

---

菩提叶阅读（Linden Leaf）为严肃长文阅读、专业 PDF 研读与长期知识沉淀而设计。书籍、划线批注与阅读记录默认完全留在本地设备——离线敏捷、界面克制，并以开放格式在 Windows 与 Android 间自由流转。

应用内置完整的 **简体中文 / English** 双语界面，可随时实时切换。

---

## 核心特性

### PDF 深度研读工作台
- **原生 MuPDF + PDF.js 双引擎**：Windows 端基于 MuPDF 1.25.4 提供高精矢量渲染与可选双页并发光栅化；Android 正式版内置双引擎，支持保持当前页原位切换并自动兜底。
- **零拷贝快开与参考页分屏**：桌面端打开外部大 PDF 免整本入库拷贝，秒开即读并支持一键加入书架；支持副视口固定图表附录对照阅读，配合 `Alt+Left` / `Alt+Right` 跳转历史栈与多窗口开书。
- **智能裁边与深色模式彩图保留**：自动检测页边白边并支持奇偶页独立裁边、无损扫描件增强；开启彩图保留后，夜间反色护眼的同时保留彩色插图原貌。
- **标准 PDF 批注双向读写**：直接读取原文件内嵌批注，并将高亮、下划线、删除线、附注、手绘墨迹及擦除结果完整写回导出为标准 `.pdf`。

### 离线 OCR：专为真实书籍排版打造
- **免下载兜底 + 按需启用 PP-OCRv6**：默认内置轻量 **Tesseract.js** 开箱即用；同时支持按需下载或离线导入 **PP-OCRv6 Small / Tiny**，在独立 Web Worker 中按硬件自适应调用 **WebGPU** 或 **WASM SIMD** 加速（提供国内镜像支持），不膨胀安装包体积。
- **繁体竖排古籍与双栏重排**：自动识别学术双栏与 **右起自上而下的繁体竖排古籍**，对应生成纵向可划词的透明文本层与单字级选区坐标；分版本持久化缓存并支持闲置预识别后续扫描页。*(架构与离线导入说明见 [docs/OFFLINE_OCR.md](docs/OFFLINE_OCR.md))*

### 十种格式、精排与大体积 TXT 引擎
- **十格式统一书桌**：`EPUB`、`PDF`、`DOCX`、`TXT`、`MD`、`MOBI`、`AZW`、`AZW3`、`FB2`、`CBZ`。
- **尊重原书与深度微调**：EPUB 默认还原出版社原版排版，同时开放字体、本地字体导入、页边距、双栏、中文竖排、阅读预设与章节内可逆 **简繁转换**、中文引号规范。
- **流式大 TXT 与净化引擎**：Rust 原生流式分章秒开数十 MB 长篇小说，内置自动编码识别、诗歌识别、广告/水印净化规则及独立 Worker 正则章节测试。

### 本地优先同步与 Obsidian 工作流
- **四云盘增量同步 + 进度分歧提醒**：支持 **WebDAV**、**本地目录**、**OneDrive** 与 **Google Drive** 双向增量同步；跨端进度差异显著时弹出 **分歧提醒横幅**，避免静默覆盖。
- **不破坏正文手写笔记的 Markdown Sidecar**：按书幂等更新受控批注块，严格保留你在 **Obsidian / Logseq** 中自己写的双链、标签与正文，并自动汇总 `LindenLeaf_Reading_Notes_and_Stats.md`。
- **文本指纹重绑与书摘迁移**：原书改名或移动目录后可通过文本指纹重新关联并完整保留批注；支持去重导入 **Kindle `My Clippings.txt`** 与随时导出恢复完整 JSON 备份。

### 阅读工学、词典与听书细节
- **专注阅读与隐私保护**：可拖动水平阅读标尺、聚焦弱化非当前段、一键 **隐私遮罩（`Alt+Shift+H`）**、可显隐排序的自定义顶部栏与新手引导，以及 **Android 3D WebGL 拟真卷页**。
- **多引擎离线词典**：支持按需获取 77 万词条 **ECDICT**，并可直接本地导入 **MDict (`.mdx`)** 与 **StarDict** 离线词库。
- **后台听书与真实热力图**：支持系统及自定义 HTTP TTS，Android 端提供前台媒体控制（锁屏控制、音频焦点与拔耳机暂停）；内置精准 CJK 全库检索与自动合并并发重叠时段的年度阅读/听书热力图。

### AI 伴读：自带 AI（BYOA）或自带 Key（BYOK）
- **直接使用已登录的浏览器 AI（BYOA，Windows）**：通过随附的 Chromium 扩展（[配置说明](extensions/chromium-companion/README.md)）与窗口并排停靠，将书中划词与上下文送入你浏览器中已登录的 **ChatGPT**、**Gemini**、**Google AI Studio**、**DeepSeek** 或授权自定义站点。无需另付 API 费用，也避开了内嵌 WebView 的登录与风控限制；一本书保持一条连续伴读对话，需要时可将回答一键回流保存为笔记。
- **自备 API Key（BYOK）与官方登录**：如果习惯内置侧栏直连，也支持配置 **OpenAI**、**DeepSeek**、本地 **Ollama** 等 OpenAI 兼容接口或使用可选的 **Sign in with ChatGPT**，并配有本地冷却、每日限额与审计日志。

---

## 平台支持一览

| 平台 | 技术栈 | 核心特性 |
| --- | --- | --- |
| **Windows 10 / 11 (x64)** | Tauri 2 (Rust) + WebView2 · MuPDF 1.25.4 + PDF.js · Foliate.js | 外部 PDF 零拷贝快开、真正多窗口阅读、桌面浏览器 AI 伴读扩展、本地文件夹关联书库、10 种格式文件关联 |
| **Android (arm64, API 24+)** | Tauri 2 Mobile + Android WebView · PDF.js + 可切换原生 MuPDF · Foliate.js | 3D WebGL 拟真卷页 / 滑动翻页、全屏轻点唤栏、前台媒体听书服务、SAF 导入导出 |

---

## 隐私与安全

- **零遥测、无账号、无广告**：书籍与阅读记录默认完全留在本地，不主动上传阅读行为日志。
- **系统级凭据加密**：同步密码、云盘令牌与 API Key 在 Windows 下使用 **DPAPI**、Android 下使用 **Keystore** 本地加密存储，不进入同步数据包。
- **沙盒与补丁加固**：流式电子书在禁用脚本的沙盒视图中渲染；桌面伴读通道启用用户 SID ACL；内置 MuPDF 包含对应 CVE 安全补丁回移。详见 [SECURITY.md](SECURITY.md) 与 [LICENSE.txt](LICENSE.txt)。

---

## 下载与源码构建

预编译的 Windows（`x64` 安装包）与 Android（`arm64-v8a` Release APK）请在 [**GitHub Releases**](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases) 获取。

**构建前置**：Node.js `>= 20`、pnpm `>= 9`、Rust `>= 1.80`，以及对应平台的 Visual Studio 生成工具 / Android SDK & NDK。

```powershell
# 按需加载本地工具链环境
. .\scripts\env.ps1

# 启动桌面端开发预览
pnpm tauri dev

# 运行全套 17 项前端语法、结构、双语、安全、契约、OCR 与回归测试
npm run verify

# 运行 Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline

# 构建 Windows x64 安装包 或 Android arm64 Release APK
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\build-android.ps1 -Mode Release -Version 1.0.0
```

> 开源社区本地编译 Android 时若未配置 `src-tauri/gen/android/keystore.properties`，构建脚本会自动回退至 Debug 签名。

---

## 文档导航

| 文档 | 说明 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块职责边界、共享数据模型与验证入口 |
| [docs/OFFLINE_OCR.md](docs/OFFLINE_OCR.md) | PP-OCRv6 + Tesseract 双轨架构、竖排/双栏重排与离线导入说明 |
| [extensions/chromium-companion/README.md](extensions/chromium-companion/README.md) | Windows 桌面浏览器 AI 伴读扩展安装与本地 IPC 安全模型 |
| [docs/WEBDAV_SYNC_SPECIFICATION.md](docs/WEBDAV_SYNC_SPECIFICATION.md) | 同步数据模型、分歧策略与备份规范 |
| [docs/ANDROID_MUPDF_CORE.md](docs/ANDROID_MUPDF_CORE.md) | Android 原生 MuPDF 桥接、分块渲染与双引擎切换 |
| [docs/ANDROID_PAGE_CURL.md](docs/ANDROID_PAGE_CURL.md) | 移动端 WebGL 卷页架构与纹理预算 |
| [patches/README.md](patches/README.md) | MuPDF 1.25.4 安全补丁回移说明 |
| [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | 更新日志、贡献指南与安全政策 |

---

## 开源许可

- **原创源代码**：基于 **GNU GPL-3.0-or-later** 开源（[LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)）
- **链接 MuPDF 的组合二进制产物**：整体遵循 **GNU AGPL-3.0-or-later**（[LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)）或 Artifex 商业授权
- 完整第三方组件声明与联网边界说明见 [LICENSE.txt](LICENSE.txt)。
