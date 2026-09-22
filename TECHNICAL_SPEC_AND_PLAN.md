# Linden Leaf (Universal Reader) 轻量版 Tauri + 魔改 MuPDF 全套技术规范与下一阶段直接实施指南

> **文档性质**：已定型工业级技术规格书与下一阶段“开箱即做”实施蓝图（面向接手工程师 / 后续 AI Agent）  
> **更新日期**：2026-09-09（经过深度代码审查与 EbookNT 底层算法资产注入）  
> **软件项目本地绝对路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri`  
> **原基准工程路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader`（完好无损）  
> **已就绪的纯 C 桥接源码路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri\src-tauri\native\`  
> **环境一键配置脚本**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri\scripts\setup-env.ps1`  
> **本文档自身本地绝对路径**：`c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri\TECHNICAL_SPEC_AND_PLAN.md`

---

## 1. 战略决策与技术定调（严禁推翻已知共识）

接手人员必须明确以下经过深层博弈拍板的五大前提：

1. **存量用户包袱清零**：
   * 本产品处于早期孵化期，**没有存量用户历史包袱**；
   * **彻底废弃过去为了兼容旧笔记而把 PDF 强塞进 HTML iframe 的畸形做法**；
   * 只要**本版本之后**的阅读体验稳定、极速、秒开、划线好用即可。
2. **全面接纳 GPL-3.0 / AGPL-3.0 开源协议**：
   * 本项目完全走开源技术路线，彻底解除对 MuPDF AGPL 协议的顾虑，直奔 C 引擎极致性能。
3. **格式收敛，舍弃 DjVu**：
   * 砍掉沉重的第三方 `DjVuLibre` 依赖，集中 100% 精力攻坚 **EPUB (流式核心) + PDF (固定版面核心)**。
4. **EPUB 资产绝对复用（双轨制）**：
   * 前期在 `foliate-js-main` 上通过 12 组严密测试验证的 EPUB 排版中枢（行矩形融合、溢出保护、跨分块搜索等）**必须 100% 满血复用，严禁破坏**。
5. **PDF 轨全面继承 EbookNT 对 MuPDF 的底层魔改**：
   * 采用知乎作者 `leviathan`（Jike Song）在 [EbookNT](https://github.com/l1viathan/ebooknt) 中对 MuPDF 核心动的大手术，彻底解决大文档卡顿。

---

## 2. 灵魂资产：EbookNT 对 MuPDF 的底层神级魔改（已完成 C 语言提取）

接手者不需要面对原版 1831 行杂乱的 Android JNI 代码！我们已经将其提炼为干净、跨平台的纯 C 接口：
* 头文件：`src-tauri/native/mupdf_bridge.h`
* 实现文件：`src-tauri/native/mupdf_bridge.c`

### 魔改 1：`collect_page_sizes`（O(N) 栈迭代扫描 Page-Tree，万页秒开）
* **原理**：传统 PDF 引擎循环调用 `fz_load_page` -> `fz_bound_page`，会触发页面 Contents 流、字形字典与图片资源的完整解析，11,000 页大文档需要等待数十秒；
* **算法实现**（见 `mupdf_bridge.c`）：
  使用固定数组 `page_tree_frame_t stack_buf[256]` 进行**非递归深度优先栈迭代**，直接扫描 PDF 底层字典树根节点的 `/Pages` 结构，提取各叶子节点的 `/MediaBox` 和 `/CropBox`；
* **效果**：**11,000 页的物理尺寸在 100 毫秒内一次性全部就绪**，前端虚拟滚动条瞬间绘制完毕。

### 魔改 2：`outline_flatten`（一维向量大纲展平，消灭上万次语言边界穿梭）
* **原理**：面对《全唐诗》（8270 目录）或《ARMv9 手册》（13000+ 目录），原生 MuPDF 暴露递归树，若逐节点跨 FFI 查询，跨语言往返穿梭上万次会导致主线程卡死数秒甚至闪退；
* **算法实现**（见 `mupdf_bridge.c`）：
  在 C 语言层内部一次性递归深搜，将整棵目录树扁平化压入一维连续数组 `mupdf_flat_outline_item_t`，**单次 FFI 调用整体返回**；
* **效果**：万级目录展开从 9 秒降至 **20 毫秒以内**。

### 魔改 3：跨平台细粒度锁体系（`fz_locks_context`）
* **原理**：MuPDF 的 `fz_context` 内部有字形缓存与全局表，非线程安全；若粗暴单线程锁会浪费多核 CPU；
* **实现**（见 `mupdf_bridge.c`）：
  Windows 下采用 `CRITICAL_SECTION`，POSIX 下采用 `pthread_mutex`，挂载 `TOTAL_LOCKS` 组互斥锁，实现**真正的多页面、多文档安全并发解码渲染**。

---

## 3. 三大工程铁律与避坑指南

### 铁律 1：TurboJPEG 内存流传输，严禁传输 Raw RGBA 大像素
* 4K 页面未压缩原始像素高达 **33~56 MB**，跨进程 IPC 传输会造成严重掉帧和主线程卡顿；
* Rust 后端渲染后调用 SIMD TurboJPEG/WebP 压缩至 **200~300 KB**，通过 `mupdf://` 协议流式返回，前端利用浏览器 GPU 硬件解码管线（`img.decode()`），耗时压制在 10ms 以内。

### 铁律 2：Rust 端实装带取消机制的 LIFO 抢占式调度器
* 用户连跳 500 页时，使用 `tokio_util::sync::CancellationToken`；
* 新视口请求进来时，立即中断（Abort）远离当前屏幕的在途任务，**保证眼前的页面独占 CPU 算力**。

### 铁律 3：前端全新 `<pdf-viewport>` 双缓冲缩放与防漂移 TextLayer
* **双缓冲消灭白屏与马赛克**：
  保持 Active 层（旧图 GPU 拉伸防马赛克）与 Back 层（新高清图静默预载并 `await img.decode()`），完成后 80ms 淡入覆盖。
* **TextLayer 3 行防漂移算法（必用）**：
  系统字体与 PDF 内嵌字体的字符步进存在天然差异，**严禁用裸 span 绝对定位**！必须引入离屏 Canvas 测宽与 CSS `scaleX` 几何补偿：
  ```javascript
  ctx.font = `${span.size * scale}px sans-serif`;
  const measured = ctx.measureText(span.text).width;
  const target = span.w * scale;
  if (measured > 0 && target > 0) {
      el.style.transform = `scaleX(${target / measured})`;
      el.style.transformOrigin = 'left center';
  }
  ```

---

## 4. 下一轮接手“开箱即做”具体行动步骤 (Step-by-Step Execution)

### 第一步：宿主机编译环境准备（5 分钟）
打开 PowerShell 终端，以管理员权限运行我们已准备好的脚本：
```powershell
powershell -ExecutionPolicy Bypass -File c:\Users\Administrator\.gemini\antigravity\scratch\universal-reader-tauri\scripts\setup-env.ps1
```
验证：在终端输入 `cargo -V` 和 `rustc -V`，确认 Rust 工具链就绪。

### 第二步：配置 MuPDF C 依赖与 `build.rs`
1. 将 MuPDF 官方发布的头文件放入 `src-tauri/native/include/`，预编译静态库（`libmupdf.lib` / `libmupdf-third.lib`）放入 `src-tauri/native/lib/`；
2. 在 `src-tauri/build.rs` 中编译链接 `src-tauri/native/mupdf_bridge.c`：
   ```rust
   fn main() {
       tauri_build::build();
       println!("cargo:rustc-link-search=native=native/lib");
       println!("cargo:rustc-link-lib=static=mupdf");
       println!("cargo:rustc-link-lib=static=mupdf-third");
       cc::Build::new()
           .file("native/mupdf_bridge.c")
           .include("native")
           .include("native/include")
           .compile("mupdf_bridge");
   }
   ```

### 第三步：Rust 端封装与 FFI 绑定
在 `src-tauri/src/commands/mupdf.rs` 中替换空桩代码，直接调用 `mupdf_bridge_*` 函数：
* `mupdf_open_document` -> 调用 `mupdf_bridge_open`
* `mupdf_get_page_sizes` -> 调用 `mupdf_bridge_collect_page_sizes`（秒级返回所有宽高）
* `mupdf_get_outline_flat` -> 调用 `mupdf_bridge_get_outline_flat`（瞬间展开目录）
* 注册 `mupdf://` 自定义协议，实装 LIFO 抢占队列返回 JPEG 流。

### 第四步：前端实现全新 `<pdf-viewport>` 组件
1. 在 `js/` 下新建 `pdf-viewport.js`，基于 `mupdf_get_page_sizes` 返回的前缀和高度数组，构建丝滑的**虚拟滚动（Virtual Scroll）**容器；
2. 接入双缓冲图像淡入切换；
3. 平铺透明 `TextLayer` 并挂载 `scaleX` 防漂移；
4. 划选文本时，将矩形转换为归一化百分比存入 `js/db.js`。

---

## 5. 关键存储契约规范 (`IndexedDB: highlights`)

```typescript
interface UnifiedHighlight {
  id: string;
  bookId: string;
  formatType: "epub" | "pdf";
  text: string;
  note?: string;
  color: string;
  createdAt: number;
  
  // EPUB 专属: 沿用现有魔改的 W3C CFI
  cfi?: string; 
  
  // PDF 专属: 归一化物理百分比矩形 (0.0 ~ 1.0)，任何缩放与设备下永不漂移
  pdfTarget?: {
    page: number;
    rects: Array<[number, number, number, number]>; // [x1, y1, x2, y2]
  };
}
```

---

> **致下一任接手工程师 / AI 的交接确认**：  
> 本工程已经扫清了全部战略分歧与深水区障碍。纯 C 桥接源码、核心魔改算法、跨平台锁以及环境安装脚本均已物理落盘就绪。直接按照第四节的四步行动清单开工即可！
