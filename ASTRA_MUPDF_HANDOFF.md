# Linden Leaf：MuPDF 接入与实机验收执行指令（给 Gemini）

工作基线：`D:\LindenLeaf-Dev\astra-mupdf-core`，分支 `codex/mupdf-core`。这是 Astra 的隔离工作树；`D:\LindenLeaf-Dev\linden-next-dev` 是原工作树，不要在两个目录中同时改同一项。先读本分支 diff 与 `src-tauri/native/ll_mupdf.{c,h}`、`src-tauri/src/commands/mupdf.rs`、`js/pdf-driver.js`、`js/pdf-viewport.js`、`js/db.js`、`js/app.js`。不要只依据旧报告。

## 架构约束

- EPUB 仍用 Foliate/WebView2 的 HTML/CSS 排版。MuPDF 只接管可信本地快照的 PDF；MOBI/CBZ 等保持现状，另立性能证据后再考虑。
- PDF 内容身份由同一次导入产生的 IndexedDB Blob 和本机快照共同绑定到 `revisionOrigin + blobRevision + size`。`nativePath` 只是来源元数据，绝不能因为同名/同尺寸就直接打开原文件。替换 Blob 必须使旧快照失效。禁止在开书、翻页、缩放、笔记或同步热路径加整书 SHA-256。
- MuPDF C 文档、页面 display list、文字对象全部由单个 Rust 文档工作线程拥有；跨线程只允许 cookie 取消。页面图像通过 Tauri `Response` 的原始二进制返回，不能转 JSON 数组、Base64 或 Data URL。Canvas 在页面保持可见时复用，滚动不重复 IPC 渲染同一页。
- 文字选区沿用 MuPDF 字符 quad → 页面坐标 → JS 网格命中 → SVG 四边形叠层。不要创建每字一个透明 DOM span。检查裁剪框原点、缩放、DPI、旋转下的坐标变换。PDF.js 仅在原生快照不可用或原生打开失败时回退。

## 第一阶段：先把原生路径真正编译并测量

1. 复用 D 盘现有 Rust；在 D 盘项目隔离目录准备匹配的 MSVC/Windows SDK 和有明确版本来源的 MuPDF headers/libs。安装只用供应商官方安装器；检查签名/版本。若 UAC 必需，停在具体安装步骤并报告，不用后台提权、关闭安全机制、修改全局 PATH 或在 C 盘执行清理命令。所有下载、解压、生成物限于 `D:\LindenLeaf-*` 明确目录。删除或移动前逐项核对解析后的绝对路径；不得递归删除 C 盘或用户目录。
2. 运行 `scripts/env.ps1`，确认 `LL_MUPDF_INCLUDE`、`LL_MUPDF_LIB_DIR`、`LL_MUPDF_LIBS` 指向实际兼容库，`cargo check`、Tauri debug/release 构建必须看到 `MuPDF native backend enabled`，否则不是原生验收。检查这次 `ll_image` 的 C/Rust ABI、pixmap 借用释放、取消后的释放，尤其不要在释放 pixmap 后读 samples。
3. 在真实 Windows WebView2/Tauri 窗口导入 PDF 并确认 `AdaptivePdfDriver.kind === 'mupdf'`，至少覆盖首次导入、关闭重开、原始源文件在导入后被改写/删除、同尺寸不同内容替换、缩放、高 DPI、快速切书、长 PDF 跳页、关闭窗口。记录每例后端、首屏时间、传输字节数、内存峰值和失败回退；不能拿 Node DOM 测试代替桌面实测。

## 第二阶段：消除遗留 PDF 的原生覆盖缺口

当前原生路径只覆盖经 Tauri 本地文件对话框或 OS 打开事件生成快照的新导入 PDF。历史 IndexedDB Blob、浏览器 File 输入和同步下载的 PDF 仍可能使用 PDF.js。先列出实际入口与数量，不要声称“所有 PDF 默认原生”。

为只有 Blob、没有可信本机快照的 PDF 设计一次性后台物化：从 **Blob 本身** 分块写入应用拥有的 D 盘临时文件，建议每块不超过 1 MiB，使用 Tauri 原始二进制请求而非 JSON 数组；完成并 `sync_all` 后原子发布。数据库绑定必须用条件更新确认 `bookId + revisionOrigin + blobRevision + blob.size` 仍未变化，失败时清理该次临时文件并保留 PDF.js 回退。物化不能阻塞首次阅读首屏；成功后再次开书走 MuPDF。不能从未经验证的旧 `nativePath` 猜测内容相同。清理废弃快照只能限于专用缓存目录且在引用检查后执行，不得全盘扫描或递归删除。

## 第三阶段：性能与选区验收

- 用同一组真实 PDF 在同设备上对比现有 PDF.js 与 MuPDF：冷/暖首屏、顺序翻页、快速拖动、1×/2×缩放、4K 图文页、1 万页长书跳页、长时间滚动后的 RSS/JS 堆，以及每次交互的 IPC 字节数。中位数和 P95 都记录，注明 PDF 类型、页数、文件大小、显示器 DPI、构建 ID、真实后端。
- 针对高 DPI 大页面，若整页 RGBA IPC 占主导，再实现 clip tile（MuPDF `fz_run_display_list` 支持 scissor）与有界预取；先测证据，不要为了“优化”无条件切成大量小 IPC。始终维持像素/边长预算和取消令牌。
- 选区验证：带非零 CropBox 原点、横向/纵向、旋转页面、中英混排、连字、跨行/跨页，鼠标选词与高亮重开后位置一致。对每页文字几何保持有界 LRU，不预扫整本书。
- 自动化测试需直接调用生产路径，覆盖快照身份变化、资源迟到释放、取消、二进制包尺寸、按需页面几何、目录索引；报告静态测试、模拟环境、真实 Tauri、真实 MuPDF 各自的证据层级。

验收后交付：提交哈希与干净工作树、完整 diff、测试命令和退出码、原生编译日志、实机对比数据、尚未覆盖的入口或文档类型。停在代码审查点，交由 Astra 审核；不要把当前原工作树直接覆盖，也不要先打包发布/更新桌面快捷方式。
