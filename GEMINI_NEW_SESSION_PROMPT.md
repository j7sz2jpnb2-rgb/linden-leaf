# 给新 Gemini 3.8 Flash 窗口的首轮提示词（直接复制下文）

你现在是 Linden Leaf 的具体编码执行者；Astra（Codex）负责架构、复杂算法和审查。请你本人完成本轮工作，不再委派 DeepCoder 或其他高价子代理。旧 Gemini 聊天很长，新窗口没有可靠的旧对话上下文；以下文字和当前源码是任务依据，旧报告只作为线索。

## 工作目录与现状

- 唯一工作目录：`D:\LindenLeaf-Dev\astra-mupdf-core`。先运行 `pwd`、`git status --short`、`git branch --show-current`、`git rev-parse --short HEAD`。预期分支 `codex/mupdf-core`、历史包含代码提交 `f8699ed`、干净工作树。若不符，先停下并报告，不要自动重置、合并或切换到另一个工作树。
- `D:\LindenLeaf-Dev\linden-next-dev` 是未改动的原工作树，`master` 在 `78b56ab`。不要在那里写入，也不要复制覆盖、清理或移动历史资料。不要改桌面现有预览版或快捷方式。
- 先阅读 `ASTRA_MUPDF_HANDOFF.md` 和实际核心源码：`src-tauri/build.rs`、`src-tauri/native/ll_mupdf.{c,h}`、`src-tauri/src/commands/mupdf.rs`、`js/pdf-driver.js`、`js/pdf-viewport.js`、`js/db.js`、`js/app.js`。请用代码和 Git diff 校正报告，不要假定“测试通过”等于原生已跑通。
- 已有前端测试：`node scripts/test-batch1.mjs` 为 46/46、`node scripts/test-astra-review-s1-s5.mjs` 为 28/28、`node scripts/test-batch1-repairs.mjs` 为 17/17；原型验证和前端资源构建通过。这些都是 Node/前端证据，**不是** MuPDF Windows 实机证据。上次 `cargo check` 实际失败于缺少 `link.exe`；`src-tauri/native/include` 与 `native/lib` 也不存在，原生桥尚未编译。

## 本轮唯一目标：让已写好的原生 PDF 路径在 Windows 上可信地编译、启动、通过基本交互

1. **先做环境盘点，不要立刻下载。** 检查 D 盘现有 Rust、MSVC/Windows SDK、MuPDF headers/libs、Tauri 依赖的实际位置和版本；检查 `scripts/env.ps1` 与 `build.rs` 条件编译。给出简短矩阵：已有、缺失、不兼容、拟采用的版本。MuPDF header 与库必须来自同一已标明版本，架构和 MSVC ABI 匹配；不要混用旧原型或不明来源的 DLL/库。
2. **补齐最小编译条件。** 可以从官方渠道下载必要工具到明确的 `D:\LindenLeaf-*` 目录，复用已有安装。禁止修改全局 PATH、关闭防护、后台绕过 UAC、强制接管系统目录、递归删除或清空 C 盘/用户目录。若官方 MSVC 安装必须桌面 UAC，请清楚指出需要用户完成的那个交互步骤；不要反复尝试静默提权。任何删除/移动都先核对解析后的绝对路径位于本次目标 D 盘目录内。
3. **编译时逐层验证。** 先 `cargo check`，再真实 Tauri debug 启动；必须看到构建脚本报告 `MuPDF native backend enabled`，运行时 `mupdf_is_available === true`。只看到 `dist-tauri/build-info.json` 的 `backend: adaptive` 不算原生已启用。核对 `ll_image` 的 C/Rust 字段、对齐和 pixmap 生命周期；这次 C 层借用 pixmap 样本直到 Rust 组装完原始二进制包再释放，不能发生悬垂指针或双重释放。遇到编译错误直接修复最小代码，不要重写整个桥。
4. **在真实窗口做闭环。** 用本地普通 PDF 通过 Tauri 文件对话框导入，关闭并重开，实测 `AdaptivePdfDriver.kind === 'mupdf'`；验证首屏、翻页、滚动、缩放、目录、鼠标选词/高亮、快速 A/B 切书、修改或删除原始源文件后重开仍显示导入快照。至少再测一份多页图文 PDF 和一份带非零 CropBox 或旋转页的 PDF。精确记录每项的真实后端、通过/失败和日志。遇到可复现的错位或崩溃，做最小修复与对应回归测试。
5. **性能先采样，暂不大改。** 在同设备同文件同显示器上记录 PDF.js 与 MuPDF 冷/暖首屏、连续翻页、2× 缩放的耗时，以及大页 IPC 包字节数和内存峰值。禁止先加入整书 SHA-256、同步重建所有缓存、整书页面几何扫描，或未经测量就大规模改成 tile。滚动时应复用现有 Canvas，不能每动画帧重新传整页 RGBA。

## 不属于本轮的工作

历史 IndexedDB Blob 的分块物化、云同步 PDF 的原生覆盖、tile 渲染、MuPDF EPUB、安装包发布、覆盖现有预览版和桌面快捷方式，都先不要做。它们会在 Astra 审查本轮原生闭环后按测量结果逐项发令。保留 EPUB 的 Foliate/WebView2 路径及 60 秒阅读统计口径。

## 交付格式与停点

提交到当前 `codex/mupdf-core` 分支并保持工作树干净，报告提交哈希、完整改动文件、编译/测试命令与退出码、`MuPDF native backend enabled` 和 `mupdf_is_available` 的实际证据、每个真实窗口场景结果、PDF.js 对照测量、未运行项。证据严格分层：静态、Node 模拟、真实 Windows 编译、真实 Tauri 窗口、真实 MuPDF。若 MSVC/UAC 或 SDK 仍阻塞，提交已完成且可审查的非依赖工作并明确阻塞点，然后停止，不要以 91 项前端测试宣称桌面通过。交付后停在 Astra 审查点。
