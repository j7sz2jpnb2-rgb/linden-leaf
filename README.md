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
- **WebDAV 同步**：支持私有云、坚果云等标准 WebDAV 服务器，双向增量同步阅读进度、笔记划线与书单分类。
- **系统级凭据保护**：账户密码使用操作系统原生安全机制保护（Windows DPAPI / Android Keystore 加密存储）。

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

# 构建 Android arm64 安装包 (输出至 D:\LindenLeaf-Deliveries\...)
powershell -ExecutionPolicy Bypass -File .\scripts\build-android-apk.ps1

# 构建 Windows x64 安装包及便携版 (输出至 D:\LindenLeaf-Deliveries\...)
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-release.ps1
```

---

## 许可证说明

本项目主程序代码基于 **GNU General Public License v3.0 or later (GPL-3.0-or-later)** 开源分发。
集成的 MuPDF 核心组件遵循 AGPL-3.0 或商业许可。详细第三方授权与隐私数据流说明请参见 [LICENSE.txt](LICENSE.txt)。