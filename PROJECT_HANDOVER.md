# Linden Leaf (Universal Reader) 轻量版 Tauri 与 PDF 引擎演进技术交接文档

> **文档性质**：工程交接与技术决策全景文档（面向接手工程师 / 后续 AI Agent）  
> **编写日期**：2026-09-09  
> **基准项目路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader` （原工程，保持完好无损）  
> **新试验线路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri` （轻量版工程）

---

## 1. 核心需求与背景 (Requirements & Context)

### 1.1 项目原貌
* **产品名称**：Linden Leaf（菩提叶阅读器）。
* **业务定位**：现代化全格式桌面电子书阅读器，支持 EPUB, PDF, MOBI, AZW/AZW3, DOCX, TXT, CBZ, FB2 等。
* **现有技术栈**：Electron + 原生 JS（ES Module）+ Foliate (`foliate-js-main`) 阅读排版渲染核心 + PDF.js (v5)。
* **核心价值体验**：基于 W3C / IDPF 规范的 **EPUB CFI 锚定机制**、高精度划线与高亮、引文卡片导出、多语言字典、全文搜索、WebDAV 云同步。

### 1.2 用户的两大核心诉求
1. **轻量版 Tauri 技术线探索**：
   - 评估并探索将庞大的 Electron 运行时（安装包 ~150MB，运行内存 ~180MB-250MB）迁移/重构为 **Tauri (Rust + OS 原生 WebView2)** 轻量版。
   - 目标：将安装包压制在 15MB 左右，运行内存降至 30MB-50MB，启动秒开。
2. **底层 PDF 引擎替代评估（重点攻关）**：
   - 用户提议深入调研 GitHub 项目：**[ebooknt](https://github.com/l1viathan/ebooknt)**。
   - 核心问题：**能否使用基于 MuPDF C 库的底层技术路线取代当前的 PDF.js？**

### 1.3 核心原则与硬性约束
* **绝对保留已有功能**：不得破坏 EPUB/MOBI/TXT/DOCX 等多格式阅读，不得丢失划线、高亮、引文卡片、搜索和 WebDAV 笔记同步。
* **独立工程隔离**：必须在新目录 `universal-reader-tauri` 中开发，严禁修改原工程 `universal-reader`。
* **不盲目重新造轮子**：遇到 PDF 划线、选区、文本提取等复杂交互时，必须优先深度参考原 PDF.js 的实现方案，禁止简单粗暴打补丁。
* **客观严谨，杜绝虚假完成**：不能把空桩代码（Stub）或脚手架宣称为“已完成”。

---

## 2. 深度调研：`ebooknt` 核心机制与可借鉴性分析

* **参考项目仓库**：[https://github.com/l1viathan/ebooknt](https://github.com/l1viathan/ebooknt)
* **作者技术文章**：知乎用户 `@leviathan`《11,000 页大文档 1 秒打开》等解析。
* **项目本质**：`ebooknt` 是一款运行在 Android (墨水屏设备，如 BOOX) 上的原生阅读器，分支继承自经典开源项目 EBookDroid / Document Viewer，其核心 PDF/DjVu 解码依赖引入的 **MuPDF 1.14 (C 语言源码，通过 Android NDK JNI 调用)**。

### 2.1 `ebooknt` 的核心性能秘籍与优化点
1. **O(N) 极速页表与尺寸遍历 (`collect_page_sizes`)**：
   - **机制**：作者直接在 C 语言层遍历 PDF 底层的对象字典树（Page Tree），提取各页的 `/MediaBox` 坐标尺寸，**完全绕过了 MuPDF 对逐页内部字形、图片、流内容的解码与初始化**。因此 11,000 页文档可以在 1 秒内拿到所有页面的物理尺寸。
2. **大纲单次批量展平 (`outline_flatten`)**：
   - **机制**：MuPDF 原生目录是递归树形结构。传统做法需要通过 JNI 多次往返递归查询，产生数万次跨边界调用开销。`ebooknt` 在 C 语言层使用递归遍历将整棵目录树扁平化为包含 `[level, page, title, dest]` 等数据的 7 维扁平数组，一次性跨边界返回，前端直接线性组装。
3. **墨水屏图像滤镜增强**：
   - **机制**：针对古籍和论文扫描件，提供纯黑白二值化（Binarization）、动态对比度补偿、亮度校正、Gamma 曲线调整，去除底灰，提高字符锐度。

### 2.2 为什么 `ebooknt` 在 Android 能成，而在 Linden Leaf 中是“深水区”？
| 维度 | `ebooknt` (Android 原生) | Linden Leaf (Foliate / Webview) |
| :--- | :--- | :--- |
| **渲染形态** | Android 原生 `SurfaceView` / `OpenGL` | Chromium / WebView2 中的 HTML `<iframe>` |
| **文字选择** | 原生触摸手势直接命中 MuPDF 的 `fz_stext_char` 物理四角坐标 (`fz_quad`) | 浏览器的原生鼠标拖拽文本选区 (`window.getSelection()`) |
| **高亮划线** | 直接在底层位图上调用 Android `Canvas.drawRect()` 绘制黄色矩形 | 基于 DOM `Range`，由 `overlayer.js` 绘制 SVG，或由 Chromium 原生 `::highlight()` API 绘制 |
| **笔记存储体系** | 专有的物理坐标 `(pageIndex, x, y, w, h)` | 严格遵循 W3C 的 **EPUB CFI 规范**（通过 DOM 节点树索引寻址，如 `/4/2/18/1:15`） |

> **关键认知断层**：  
> `ebooknt` **没有 DOM、没有 CSS、没有浏览器字体度量差异**。  
> 但 Linden Leaf 基于 Foliate，一切划线、选区、笔记、搜索和引文导出**完全绑定在 DOM 文本层 (TextLayer)** 上。如果直接把 MuPDF 渲染成图片放到网页上，就必须人工合成一个像素级严丝合缝的 DOM TextLayer！

---

## 3. 目前已经完成的工作 (Current Implementation)

所有产物均位于 `c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri`：

### 3.1 跨平台抽象层 (`js/platformBridge.js`) —— 【🟢 真实可用】
* 编写了近 800 行的通用平台抽象门面 `platformBridge`。
* **解耦范围**：
  - 窗口管理：最小化、最大化、关闭、全屏、置顶；
  - 原生文件操作：`readFile`, `writeFile`, `readDir`, `openFileDialog`, `saveFileDialog`, `exists`；
  - 菜单与快捷键：注册全局与本地快捷键；
  - 剪贴板与原生外链跳转；
  - WebDAV 云同步接口封装。
* **多运行时适配**：能动态识别 `isTauri`（通过 `window.__TAURI__.core.invoke`）、`isElectron`（通过 `window.electronAPI`）或标准纯浏览器环境，自动降级兼容，上层业务零改造。

### 3.2 扫描件 GPU 增强滤镜 (`index.html`, `js/app.js`) —— 【🟢 真实可用】
* 吸收了 `ebooknt` 对扫描 PDF 的画质调优需求，但避免在 CPU 层面进行昂贵的逐像素计算。
* 在前端 DOM 根注入 `--reader-img-filter` 变量，直接利用 GPU 硬件加速管线：
  - 亮度 (`brightness`)、对比度 (`contrast`)、灰度化 (`grayscale`)、反色夜间模式 (`invert`)、E-Ink 增强高对比度。
  - 在 `js/app.js` 中新增了 `setPdfImageAdjustment()` 统一控制台接口。

### 3.3 Foliate 适配层结构 (`foliate-js-main/mupdf-adapter.js`) —— 【🟡 架构完成，底层待接】
* 实现了 `buildTOCFromFlat` 算法，能以 $O(N)$ 速度将 `ebooknt` 风格的扁平化目录树瞬间重建为 Foliate 兼容的嵌套目录对象。
* 建立了满足 Foliate 契约的页面结构：
  ```html
  <div id="page-container">
      <img id="page-img" src="..." />
      <div class="textLayer">...</div>
      <div class="annotationLayer">...</div>
  </div>
  ```
* 实现了双轨回退模式：当检测到无原生 MuPDF 支持时，自动降级调用原生已有的 `pdf.js`，保证系统不瘫痪。

### 3.4 Tauri 工程脚手架 (`src-tauri/`) —— 【🟡 骨架建立】
* 搭建了标准的 Tauri 2.x 目录体系：
  - `tauri.conf.json`：配置了窗口参数、CSP 安全策略、文件系统与对话框插件；
  - `Cargo.toml`：声明了 serde, tokio, tauri, tauri-plugin-fs 等依赖；
  - `src/main.rs`, `src/lib.rs`；
  - `src/commands/fs.rs`, `src/commands/window.rs`, `src/commands/mupdf.rs`。

---

## 4. 目前还有哪些没做？（核心缺口与深水区阻碍）

接手人员必须清晰了解以下**未完成状态与客观瓶颈**，切勿认为项目已经可以直接构建运行：

### 4.1 核心缺口一：Tauri 端的 Rust/C 引擎当前为纯空桩 (Stub)
* **现状**：打开 `src-tauri/src/commands/mupdf.rs`，可以看到：
  - `mupdf_render_page` 返回的是空像素字节 `image_bytes: vec![]`；
  - `mupdf_get_text_layer` 返回的是空集合 `spans: vec![]`；
  - `mupdf_get_outline_flat` 返回的是 `Ok(vec![])`。
* **原因**：真正的 MuPDF C 代码或 Rust `mupdf-rs` 绑定尚未编译链接。如果当前在 Tauri 环境下调用此命令，页面只是一片空白。

### 4.2 核心缺口二：本地宿主机环境缺少 Rust / C++ 编译器
* **现状**：经运行命令环境检测：
  - 机器仅安装了 `node.exe` (v22.18.0) 和 `npm.ps1`；
  - **未安装 `cargo`、未安装 `rustc`**；
  - **未安装 MSVC `cl.exe` (Visual Studio C++ Build Tools)、未安装 `gcc`、未安装 `clang` 或 `cmake`**。
* **影响**：当前开发机**暂时无法本地编译 Tauri 项目**。若要编译原生 Tauri 或 C/FFI，必须先在宿主机配置 Rustup 和 C++ 编译链。

### 4.3 核心缺口三：TextLayer 文本层对齐与字宽累计漂移（深水区）
* **现状**：目前 `mupdf-adapter.js` 中只是天真地输出了：
  `<span style="left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px;">${escaped}</span>`
* **问题实质（为什么必须深度学习 PDF.js）**：
  我们深度查阅了 `vendor/pdfjs/pdf.mjs`（第 14150 ~ 14450 行），PDF.js 的对齐包含一整套极度精密的几何补偿算法：
  1. **离屏测宽与动态缩放（`measureText` + `--scale-x`）**：PDF 内部使用的是内嵌字体的字符步进（Character Advance），而浏览器 DOM 使用的是系统的兜底字体（如 `sans-serif`）。两个字体的字形宽度天然存在误差。PDF.js 每次排版都会通过离屏 Canvas 的 `ctx.measureText(textContent)` 测量浏览器真实渲染宽度，计算水平比例因子：
     $$\text{--scale-x} = \frac{\text{canvasWidth} \times \text{scale}}{\text{measuredBrowserWidth}}$$
     并通过 CSS `transform: scaleX(var(--scale-x))` 强制修正。缺少这步，划选一段话时，**后半截蓝色的高亮选区会严重漂移错位**！
  2. **字体基线与字高补偿（Ascent）**：PDF 坐标系是以左下角为原点（Y 轴向上），HTML 是以左上角为原点（Y 轴向下）。PDF.js 计算了 `fontAscent = fontHeight * getAscent(...)`，然后将 `top` 设为 `tx[5] - fontAscent`。如果直接拿 MuPDF 矩形框填入 CSS `top`，行间距会上下晃动。

### 4.4 核心缺口四：EPUB CFI 规范与旧有笔记兼容性风险
* **现状**：Linden Leaf 所有的历史笔记、划线和 WebDAV 笔记同步都依赖 `foliate-js-main/epubcfi.js`。
* **风险点**：`CFI` 是根据 DOM 树的子节点索引来寻址的（如 `/4/2/18/1:15` 表示第 4 个容器下的第 2 个文本层下的第 18 个 `<span>` 里的第 15 个字符）。
  - PDF.js 有自己成熟的分词与 TextChunk 合并策略；
  - 如果 MuPDF 输出的 `<span>` 数量或切分粒度与 PDF.js 不一致，**用户以前在 PDF 上的所有高亮划线、批注和书签在重新加载时会全线崩溃或锚定在错误词句上**！

### 4.5 核心缺口五：MuPDF 的多线程与并发模型
* `fz_context` 在 C 语言层是非线程安全的。如果在多线程中同时渲染两个页面，会引发段错误（Segfault）。必须为其设计专属的单线程 Rendering Worker 或带锁的 Context Clone 机制。

---

## 5. 后续接手 AI / 团队的可选演进方案 (Three Viable Paths)

请根据项目资源与目标，从以下三条方案中做出抉择：

### 方案 A：【高可行性 · 工业级推荐】Tauri 极简外壳 + 优化版 PDF.js（融入 ebooknt 精髓）
> **核心思路**：用 Tauri 解决“轻量化”，用优化版 PDF.js 解决“稳定与兼容”，把 `ebooknt` 的核心算法融入 PDF.js。

* **具体做法**：
  1. **保留并深度打磨 PDF.js**：直接在 Tauri 的系统 WebView2 中运行 PDF.js。
  2. **解决轻量化痛点**：通过已完成的 `platformBridge.js`，用 Tauri 替代 Electron。包体积由 150MB 降为 15MB，运行底噪内存由 200MB 降为 30MB。
  3. **落地 `ebooknt` 的真正优化点**：
     - **视口保护的高性能 LRU 缓存**（已完成）：限制最大缓存页数，保护当前阅读页前后 4 页，解决万页大文档的内存膨胀；
     - **GPU 级扫描件画质增强**（已完成）：使用 CSS GPU 滤镜解决扫描件底灰和锐化问题；
     - **O(N) 尺寸预加载**：在 PDF.js 内部实现轻量化只读字典树，仅按需加载各页的尺寸，不预载复杂资源。
* **优势**：
  - **100% 保护用户资产**：旧有的 CFI 笔记、划线、卡片、WebDAV 同步完全无缝兼容；
  - **免除 C++ 编译地狱**：零 native 动态库依赖，全平台（Windows, macOS, Linux）构建极度顺畅。

---

### 方案 B：【深度自研 · 极限性能】真正的 Native MuPDF C-FFI 深度集成
> **核心思路**：彻底用 C 语言 MuPDF 替代 PDF.js，全面追求原生级的渲染极速。

* **必要前置条件**：
  1. 必须在开发机上安装完整的 Rust 工具链 (`rustup`) 以及 Visual Studio C++ 生成工具 (MSVC `cl.exe`)。
  2. 引入 `mupdf-sys` 或通过 `vcpkg` 编译 `mupdf` 静态库，在 `src-tauri` 中通过 FFI 进行绑定。
* **技术攻关清单**：
  1. **单线程 Worker 机制**：在 Rust 侧使用 Tokio + std::sync::mpsc 建立专有渲染管线，确保 `fz_context` 串行/安全调用。
  2. **完全复刻 PDF.js 级别的 TextLayer 生成引擎**：
     - 在 Rust 侧提取 `fz_stext_page`，向前端返回包含字符精确物理尺寸、基线坐标与字号的结构体；
     - 前端适配器**必须引入 Canvas 测宽与 `--scale-x` 动态缩放**，严格按照 PDF.js 的 TextLayer 逻辑排版。
  3. **CFI 兼容适配**：若无法做到 100% 节点复刻，需为 MuPDF 模式设计专用的坐标型或字符偏移型笔记定位降级方案。
  4. **开源协议风险注意**：MuPDF 是 AGPLv3 协议，若闭源商用必须购买商业授权，开源须遵守传染性协议。

---

### 方案 C：【折中方案 · 跨平台通用】MuPDF WebAssembly (mupdf.js)
> **核心思路**：不在 Rust 宿主编译 C 库，而是在前端 Web Worker 中直接加载官方的 WebAssembly 版 MuPDF (`mupdf-js`)。

* **优缺点**：
  - **优点**：无需安装 MSVC 或配置 C++ 编译链，跨平台通用，不增加 Tauri 原生打包负担。
  - **难点**：WASM 体积约 8~12MB；同样需要在前端解决精准 TextLayer 对齐和 CFI 兼容问题。

---

## 6. 接手工程师 / AI 的行动指引 (Action Checklist)

当下一个 AI 接入本项目时，请按照以下步骤行动：

1. **环境准备**：
   - 确认当前是需要立即产出**可运行的轻量版桌面程序**，还是需要**死磕 C 库**。
   - 若要运行 Tauri：在宿主机安装 Rust 工具链 (`rustup default stable-x86_64-pc-windows-msvc`) 并安装 Visual Studio 2022 C++ 生成工具。
2. **决策技术路线**：
   - 若采纳 **方案 A**（推荐）：
     - 检查 `foliate-js-main/mupdf-adapter.js`，让其默认通过 `pdf.js` 提供高可靠文本排版与渲染；
     - 确保 `platformBridge.js` 在 Tauri 下的各 API（文件读取、选择、WebDAV）全面接通。
   - 若采纳 **方案 B**（原生 MuPDF）：
     - 先编写 C-FFI 接口打通 `mupdf_render_page`，让其返回真实 WebP/RGBA 数据；
     - 在 `mupdf-adapter.js` 中参考 `vendor/pdfjs/pdf.mjs` 第 14388 行实现 `ctx.measureText` 和 `--scale-x`，严禁使用粗暴的绝对定位。
3. **关键验证测试**：
   - **划线精准度测试**：打开一份中英文混排的双栏 PDF，用鼠标划选连续 3 行文字，检查选区蓝色高亮框是否与底图字符边缘严格对齐；
   - **笔记持久化测试**：为某一句话创建划线和引文卡片，重新打开文档，检查划线能否在原地 100% 精确复现。
