# Linden Leaf：原生 MuPDF 原型与小范围性能优化

本轮产物是可编译、已实际调用验证的 C 核心，以及本地阅读交互原型。原来的 Tauri 应用仍默认使用 PDF.js；本轮没有把未验证的 Rust FFI 切入主程序。

## 本轮完成

- `src-tauri/native/ll_mupdf.h/.c`：独立 C ABI。按本地路径打开 PDF，按需获取页面边界；复用 Display List；输出整页或指定区域的原始 RGBA；返回完整字符与四边形；调用 MuPDF 原生选择接口返回跨行文字及高亮四边形。
- 原生缓存同时保留最多 3 个页面的 Display List 和按需生成的结构化文字。不同倍率复用解释结果。它是原型的页数限制，不是完整内存预算。
- `prototype/mupdf/index.html`：翻页、缩放、90° 旋转、鼠标选择、复制、保存/删除高亮。高亮使用页面坐标，保存在浏览器 localStorage；书籍身份使用显式 book-id 或启动时的绝对路径，不做内容哈希。
- `serve.py` 与 `native.py`：本地 Python HTTP/ctypes 传输壳。实际文件打开、解释、渲染与选择由上述 C 核心执行，服务端不使用 PyMuPDF 渲染。二进制 RGBA 传输，没有 Base64；存在正常的内存复制，不是零拷贝。
- 原有 `mupdf_bridge.h/.c` 修正已确认的编译错误：size_t 头文件、目录位置类型、点与矩形类型混用。原型使用新 `ll_mupdf` 核心；旧桥接的整行文本方案没有被宣称完成。

## 现有应用的小范围优化

| 文件 | 改动 | 收益/边界 |
|---|---|---|
| js/pdf-driver.js | PDF.js 直接返回 Canvas；渲染支持 AbortSignal；文本 viewport 每页只建一次 | 移除 JPEG 编码、Base64 字符串及再次解码；停止已离开视口的在途渲染 |
| js/pdf-viewport.js | 当前页检测二分定位；高亮按页建立 Map；异步结果核对 slot 身份 | 当前页检测由从书首扫描改为 O(log N + 可见页数)；每次点击/绘制不再筛选全书高亮；快速缩放不会把旧结果写给新 slot |
| js/db.js | 周/月/年筛选边界在循环外计算一次 | 避免每条阅读记录重复格式化日期；统计语义保持原样 |

PDF.js 的全书尺寸预扫描、简化 TextLayer 尚未改造。原生 MuPDF 原型按需读取当前页，不依赖该扫描。没有引入哈希监测或通用防御框架。

## 运行原型（已验证的 Linux 路径）

进入 `universal-reader-tauri` 后，准备 Python、GCC 和 MuPDF 开发库。当前验证环境使用 PyMuPDF 1.26.6 自带的 MuPDF 1.26.11 头文件和动态库。若使用相同 wheel，可运行：

```bash
python -m pip install pymupdf==1.26.6
python prototype/mupdf/build.py
python prototype/mupdf/serve.py /absolute/path/book.pdf
```

浏览器打开 `http://127.0.0.1:8765`。该地址是本机原型服务，不是发布网站。

独立安装的 MuPDF 可以显式传入头文件和库文件，额外依赖库可重复指定：

```bash
python prototype/mupdf/build.py --include /path/to/include --library /path/to/libmupdf.so --extra-library /path/to/another-library
```

服务端启动参数：`--port`、`--library`、`--password`、`--book-id`。原型一次打开一本书；换书需重新启动。笔记仅在此原型浏览器存储中，没有连接应用 IndexedDB/WebDAV。

## Windows 路径及验收边界

本轮环境没有 Rust、MSVC 和 WebView2，未生成 Windows exe，也未验证 Windows 构建。

`build.py` 提供 MSVC 命令分支。已有匹配架构和运行时的 MuPDF 开发包时，可在 x64 VS Developer Prompt 中显式提供：

```powershell
python prototype/mupdf/build.py --include C:/mupdf/include --library C:/mupdf/lib/mupdf.lib
python prototype/mupdf/serve.py C:/Books/book.pdf
```

这是待 Windows 实测的构建入口，不会下载或构建 MuPDF 本身。静态库所需的附加依赖通过 `--extra-library` 提供；使用动态库时，其依赖 DLL 也必须能够被系统加载。脚本使用 `/MD`，须与所选 MuPDF 构建匹配。

## 已执行的验证

- GCC：新核心以 C11、O2、Wall、Wextra、Werror 编译为实际共享库。
- 原生功能：6 页生成样本；长英文与中文完整提取、跨行选择；PDF 固有旋转与裁边；0/90/180/270° 用户旋转及逆变换；区域像素与整页对应区域逐字节一致；Display List/text 重用及缓存淘汰；错误返回后会话继续工作。
- HTTP：真实调用 info/render/select，检查二进制长度、裁边旋转后的尺寸和中文返回；HTML 路由成功。
- 前端算法：3000 组位置与线性参考算法结果一致；一万页接近末尾场景读取 16 次页面记录；按页高亮顺序一致；直接 Canvas 输出不调用图像编码；取消传递到 RenderTask。
- 真实 PDF.js：在 Node + Canvas 环境打开 6 页样本并渲染，验证中文提取。测试适配了 Node 文件读取路径，浏览器源码的 URL 路径没有更改。
- JS 语法检查通过。

环境中只有 Playwright 包，没有浏览器可执行文件，所以未完成浏览器鼠标操作、剪贴板、刷新恢复等端到端验收，也没有验证最终视觉效果。上述原生和算法测试不能替代 Windows WebView2 验收。

重跑主要验证：

```bash
python prototype/mupdf/verify_native.py
node prototype/mupdf/verify_frontend.mjs
```

`verify_native.py` 仅用 PyMuPDF 生成测试 PDF，随后通过 ctypes 调用新 C 核心。可用 `--fixture /path/fixture.pdf` 保存样本用于手动打开。

## 下一步的具体接入边界

1. 在 Windows 编译并跑完原型交互，验证长中文、双栏文档、旋转/裁边页面。
2. Rust 拥有 `ll_doc`，通过单一专用工作线程调用；句柄禁止并发使用。保留 `ll_*` C ABI，替换 Python 传输壳即可，不必重写原生渲染算法。
3. 先接文档打开、当前页、选择与高亮，再接目录/搜索和应用的笔记存储。当前核心没有目录/全文搜索 API，原型也没有跨页拖选。
4. 当前渲染按请求串行、同步执行，尚未接任务取消和多线程。先测清实际传输和绘制成本，再引入 context 克隆、渲染线程池及按字节预算的缓存。
5. API 已能区域渲染；原型 UI 仍按整页显示，没有实现分块调度。

本轮不承诺比 PDF.js 快某个倍数。已经证实的是：原生 Display List、字符几何和区域输出能够经新桥接工作，接入路线有实际可运行的基础。
