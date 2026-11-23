# Linden Leaf (菩提叶阅读)

基于 Tauri 2.0 与 Rust 渲染桥接构建的跨平台轻量级全格式电子书阅读器。面向日常专注阅读、深度知识批注与多端同步场景，覆盖 Windows 10 / 11 (x64) 桌面端与 Android 移动端。

---

## 核心架构与支持格式

- **渲染引擎**：
  - **PDF 引擎**：集成高性能 MuPDF 1.25.4 原生 C/C++ 动态链接库与矢量图元层，支持视口自适应、高精度选词与手绘批注。
  - **流式排版 (EPUB / MOBI / AZW3 / TXT / DOCX / FB2 / CBZ)**：深度调优的 Foliate 分页与重排引擎，支持单栏/双栏、平滑翻页与竖排排版。
- **桌面外壳**：基于 Tauri 2.0 (Rust) + 系统原生 Microsoft Edge WebView2，内存占用低、响应极致敏捷。
- **数据管理**：本地优先 (Local-First) IndexedDB 与 SQLite 架构，保障数据隐私与零离线延迟。

---

## 主要特性

### 1. 深度排版与主题系统
- **统一主题链**：新安装默认跟随系统明暗设置，日间米黄羊皮纸、夜间纯黑 OLED；支持单书独立排版覆盖与全局设置。
- **现代化桌面设置面板**：重构的三栏式设置交互，支持排版边距、行高、字号等超宽范围微调。
- **全端适配翻页体验**：PC 桌面端默认采用零延迟瞬时翻页与平滑滚动，避免大屏长动效遮挡；Android 移动端支持 3D 仿真卷页 (Cover)、横向滑动 (Slide) 与无动效模式。

### 2. 云同步与数据安全
- **全量有效信息同步 (WebDAV & Local-First)**：双向增量同步阅读进度、**每日各书阅读明细（包含每天具体读了哪几本书、时长与作者，删书或跨设备不丢失书名）**、划线想法、书签、PDF 手绘批注、自定义书单、评分与专属标签、命名阅读预设、自定义语义配色、单书排版覆盖与阅读目标。
- **自动生成可读 Markdown 总览**：云端同步目录自动维护人类可读的 `LindenLeaf_Reading_Notes_and_Stats.md`，支持通过 Obsidian、Logseq、任意 Markdown 查看器或 WebDAV 网页端直接浏览每日读书明细与笔记。详细协议规范参见 [WebDAV 同步协议规范](docs/WEBDAV_SYNC_SPECIFICATION.md)。
- **系统级凭据保护与零泄露**：WebDAV 账户密码使用 Windows DPAPI 原生安全加密存储，同步数据包严格脱敏，不携带第三方 API Key。
- **本地全量灾备备份 (Schema v4)**：支持导出/导入阅读记录、批注、目录与配置的 JSON 备份；书籍原文件需另行保留，原生快照路径不能替代跨设备文件备份。

### 3. 听书与 TTS 朗读
- **语音朗读**：支持本地系统语音及在线 TTS，无缝朗读小说与电子书。
- **精确听书统计**：真实播放区间结算，智能合并阅读与听书重叠时段。

### 4. 辅助阅读工具
- **离线词库**：支持按需在线下载并本地构建 77 万词条 ECDICT SQLite 词库，支持自定义词库导入与安全事务恢复（默认安装包不预打包大型词库文件，仅随附元数据）。
- **AI 伴读**：用户可自选配置 DeepSeek、OpenAI 或本地 Ollama 模型，提供划词提问、长文总结与润色。
- **原生文件导出**：支持通过 Windows 原生另存为对话框将划线想法导出为纯文本或 Markdown 笔记。

---

## 接手开发

修改前请先阅读 [模块职责与验证入口](docs/ARCHITECTURE.md)。导入、同步、备份的内容身份与字段规则集中在共享模型中；不要在按钮回调里复制这些规则。

## 构建与发布

### 环境依赖
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Rust >= 1.80.0
- Windows 10 / 11 SDK & MSVC v143 (C++ 生成工具)

### 常用命令
```powershell
# 引入项目会话环境变量（可选设置 LINDEN_TOOLCHAINS_DIR / MUPDF_ROOT，无须修改全局环境）
. .\scripts\env.ps1

# 启动开发版预览
pnpm tauri dev

# 运行自动化语法检查与构建
node scripts/run-syntax-checks.mjs
node scripts/build-dist.js

# 构建 Windows x64 Release 安装包及便携二进制 (输出至 deliveries/windows-<version>-mupdf/)
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-current.ps1
```

> **Android 正式版签名**：发布包构建可通过 `src-tauri/gen/android/keystore.properties`（模板见 `keystore.properties.example`）或环境变量 `LINDEN_ANDROID_KEYSTORE_*` 配置正式签名；未配置时仅回退至 Debug 签名用于本地测试。

---

## 许可证说明

本项目原创源代码基于 **GNU General Public License v3.0 or later (GPL-3.0-or-later)** 开源分发（见 [LICENSE-GPL-3.0.txt](LICENSE-GPL-3.0.txt)）。
集成 MuPDF 核心后的组合二进制分发包整体遵循 **AGPL-3.0-or-later**（见 [LICENSE-AGPL-3.0.txt](LICENSE-AGPL-3.0.txt)）或 Artifex 商业许可。详细第三方组件、字体授权与隐私网络边界说明请参见 [LICENSE.txt](LICENSE.txt)。
