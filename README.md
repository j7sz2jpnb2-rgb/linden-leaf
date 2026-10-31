# Linden Leaf (菩提叶阅读)

基于 Tauri 2.0 与 Rust 渲染桥接构建的高性能、跨平台全格式电子书阅读器。面向日常专注阅读、深度知识批注与学习场景，支持 Windows (x64) 与 Android (arm64-v8a)。

---

## 核心架构与支持格式

- **渲染引擎**：
  - **PDF 引擎**：集成高性能 MuPDF 1.25.4 原生 C/C++ 动态链接库与矢量图元层，支持视口自适应、高精度选词与手绘批注。
  - **流式排版 (EPUB / MOBI / AZW3 / TXT / DOCX / FB2 / CBZ)**：深度调优的 Foliate 分页与重排引擎，支持单栏/双栏、拟真翻页与竖排排版。
- **跨平台外壳**：基于 Tauri 2.0 (Rust) + 系统原生 WebView (Windows WebView2 / Android System WebView)。
- **数据管理**：本地优先 (Local-First) IndexedDB 与 SQLite 架构，保障数据隐私与零离线延迟。

---

## 主要特性

### 1. 深度排版与主题系统
- **统一主题链**：新安装默认跟随系统明暗设置，日间米黄羊皮纸、夜间纯黑 OLED；支持单书独立设置与全局设置。
- **自适应布局**：针对手机、平板、折叠屏及分屏环境自动适配导航栏、书架网格与阅读间距；尺寸变化通过文档源定位锚点精准恢复。
- **安全区贯通**：全面支持 Android 状态栏、打孔屏摄像头（Cutout）、手势导航条与软键盘自适应，拒绝内容遮挡。
- **拟真翻页**：基于 GPU 加速的圆柱曲面网格算法，支持触摸跟手卷页、反向拖回取消与平滑回弹。

### 2. 多端同步与数据安全
- **全量有效信息同步 (WebDAV & Local-First)**：双向增量同步阅读进度、**每日各书阅读明细（包含每天具体读了哪几本书、时长与作者，删书或跨设备不丢失书名）**、划线想法、书签、PDF 手绘批注、自定义书单、评分与专属标签、命名阅读预设、自定义语义配色、单书排版覆盖与阅读目标。
- **自动生成可读 Markdown 总览**：云端同步目录自动维护人类可读的 `LindenLeaf_Reading_Notes_and_Stats.md`，支持通过 Obsidian、Logseq、任意 Markdown 查看器或 WebDAV 网页端直接浏览每日读书明细与笔记。详细协议规范参见 [WebDAV 同步协议规范](docs/WEBDAV_SYNC_SPECIFICATION.md)。
- **系统级凭据保护与零泄露**：账户密码使用操作系统原生安全机制保护（Windows DPAPI / Android Keystore 加密存储），同步数据包严格脱敏，不携带第三方 API Key。
- **本地全量灾备备份 (Schema v4)**：支持一键导出/导入单文件全量备份，跨设备灾备恢复 100% 完整无损。

### 3. 听书与后台播放
- **Android 前台媒体服务**：接驳系统 MediaSession，支持通知栏/耳机控件双向控制；带会话身份与段完成状态机，锁屏或 WebView 挂起仍可稳定连续播音。
- **精确听书统计**：真实播放区间结算，智能合并阅读与听书重叠时段。

### 4. 辅助阅读工具
- **离线词库**：内置 77 万词条 ECDICT 快速本地查询，支持自定义词库导入与安全事务恢复。
- **AI 伴读**：用户可自选配置 DeepSeek、OpenAI 或本地 Ollama 模型，提供划词提问、长文总结与润色。

---

## 构建与测试

### 环境依赖
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Rust >= 1.80.0
- Windows 11 SDK & MSVC v143 (用于 Windows 构建)
- Android NDK 26.3 & JDK 17 (用于 Android 构建)

### 常用命令
```powershell
# 引入项目会话环境变量（无须修改全局环境）
. .\scripts\env.ps1

# 启动开发版预览
pnpm dev

# 运行自动化语法检查与构建
node scripts/run-syntax-checks.mjs
node scripts/build-dist.js

# 构建 Android arm64 安装包 (输出至 D:\LindenLeaf-Deliveries\...)
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1

# 构建 Windows x64 安装包及便携版 (输出至 D:\LindenLeaf-Deliveries\...)
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-release.ps1
```

---

## 许可证说明

本项目主程序代码基于 **GNU General Public License v3.0 or later (GPL-3.0-or-later)** 开源分发。
集成的 MuPDF 核心组件遵循 AGPL-3.0 或商业许可。详细第三方授权与隐私数据流说明请参见 [LICENSE.txt](LICENSE.txt)。
