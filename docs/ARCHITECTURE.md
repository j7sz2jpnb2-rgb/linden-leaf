# Linden Leaf：模块职责与验证入口

当前 Windows 版本为 1.0.0。以 Tauri + MuPDF 为 PDF 主路径，PDF.js 是同一驱动接口下的备用后端；流式电子书继续使用 Foliate。`app.js` 负责界面编排，不应重新实现持久化、内容判等或合并算法。

## 修改一个功能时应到哪里

| 职责 | 实现位置 | 边界 |
| --- | --- | --- |
| 内容身份与旧标识兼容 | `js/document-identity.js` | 新内容用完整 SHA-256；旧主标识在验证内容后增加别名，不批量改写旧批注绑定。采样 hash 不能证明两文件相同。 |
| 原生文件摘要 | `src-tauri/src/content_hash.rs` | 文件扫描与 PDF 暂存共用流式摘要；C/Rust/JS 不各造一套内容身份。 |
| 书籍传输字段 | `js/book-metadata.js` | 同步和备份共用元数据投影。新增字段时同时检查合并、应用、导出往返。 |
| 会话区间与绘图主键 | `js/reading-data.js` | 纯数据算法，不依赖界面和数据库。 |
| 多端数据合并 | `js/sync-model.js` | 纯输入/输出；不读库、不发请求、不创建 UI。`syncEngine.js` 保留旧导出以兼容调用者。 |
| 同步生命周期 | `js/syncEngine.js` | 读库、调用模型、写入、传输；账号与存储后端通过已有提供者接口选择。 |
| 快开本地 PDF | `js/book-source.js` | 准备原生描述符、查找同内容记录、保存书目与回收未提交快照。调用者管理窗口和阅读器 UI。 |
| 一般导入 | `js/import-queue.js` | 菜单、拖放、外部文件统一入队；解析可并发，判等与提交串行。大 PDF 保持原生路径描述符，不整本传进 JS。 |
| 本地持久化 | `js/db.js` | IndexedDB 事务、版本迁移、原生快照绑定。下载书籍文件与书目身份在同一事务中更新。 |
| 备份/恢复 | `js/backup-service.js` | 数据操作与设置界面分离。复用实际原子恢复接口，不能为了测试添加逐条写入的备用恢复流程。 |
| 设置默认值与清洗 | `js/advanced-settings-schema.js` | UI 与后台备份共同使用；`advanced-settings.js` 只管理设置界面与反馈。 |
| 单书 PDF 偏好 | `js/pdf-preferences.js` | 唯一的 localStorage 键定义、旧格式读取、备份与恢复映射。 |
| PDF 渲染与交互状态 | `js/pdf-viewport.js` | 控制可见页面、缩放、选区、标尺、自动滚屏。按钮读视口状态，避免在 App 再维护一份运行标志。 |
| PDF 后端调用 | `js/pdf-driver.js` | 对外统一文本、几何、位图接口。普通搜索/TTS 使用纯文本 API，需要选区才请求逐字几何。 |
| 云端书籍二进制 | `js/storage-providers.js` | 使用当前选定提供者；不支持整书文件的提供者明确返回能力限制，不能偷偷回退到 WebDAV。 |

## App 与功能控制器

`app.js` 保留启动、窗口、当前书籍/阅读会话、全局快捷键和关闭刷盘。PDF 与 Foliate 初始化分别在同类的 `_openPdfSession` / `_openFoliateSession` 中执行，异常统一返回 `openBook` 的原有清理流程，不另设一个会话状态源。

| 模块 | 状态与生命周期归属 |
| --- | --- |
| `bookshelf-controller.js` | 分类/筛选/书单/多选状态、书架 DOM、虚拟列表与观察器 |
| `stats-view-controller.js` | 周月年切换、统计 DOM、周期详情和热力图交互 |
| `import-folder-controller.js` | 导入中心 DOM、队列反馈、文件夹关联和重扫调度 |
| `sync-controller.js` | 同步配置、首次同步门槛、传输状态、OAuth 和云盘选书；底层规则仍在同步模型/引擎 |
| `update-controller.js` | 升级弹窗、焦点恢复和检查更新反馈 |
| `pdf-drawing-controller.js` | 画笔状态、页面笔迹缓存、绘图覆盖层和写入队列 |
| `pdf-tools-controller.js` | 缩放、OCR（按驱动原点对齐 CropBox/MediaBox）、裁边、参考页、副视口、手动目录与批注导出（覆盖 highlight/underline/strikeout/note/ink 及擦除后子线段） |
| `annotations-drawer-controller.js` | 选区/高亮快照、批注增改、目录/笔记抽屉与全局笔记视图 |
| `reader-search-controller.js` | 书内及跨书检索、结果游标、取消与结果 DOM |
| `reader-cards-controller.js` | 词典、脚注、段落翻译、分享卡与 AI 小浮层 |
| `reader-appearance-controller.js` | 排版/字体/配色/预设的界面；实际全局及会话设置仍由 App 协调。EPUB 默认开启原书排版（旧用户保留原有自定义排版），切回原书时清理归一化标记并重载原章；TXT 保持自定义排版独立不受 EPUB 原书开关限制 |
| `foliate-section-binder.js` | 单章节文档整理与事件绑定、章节内选择手势；与 `reader-style-builder.js` 共同区分原书样式与自定义覆盖，配合 `paginator.js` 对封面/单图页居中（不误伤图注、不全局篡改 `<svg preserveAspectRatio>`），在缺章/损坏章节派发 `section-load-error` |
| `ui-dialogs.js` | Toast、普通输入/确认、字段表单和 PDF 密码弹窗 |

辅助模块：`reader-style-builder.js`（保留字体/配色提供者的 CSS 生成）、`reader-navigation.js`、`cover-url-pool.js`、`ui-format.js`、`app-features.js` 和 `app-modules.js`（原有动态加载入口）。

控制器在构造函数中声明局部状态，`initDOM` 查询所属节点，`bindEvents` 绑定交互。章绑定器直接使用文档生命周期，不强行套全局 DOM 接口。`DomEvents` 只是 AbortController 的小封装，用来成组移除长期 UI 监听；不充当服务容器或事件总线。

App 保留既有模块确实使用的公共方法转发及少量状态访问器。内部代码直接调用所属控制器，访问器只映射同一个 backing state。为兼容既有设置/移动界面，`app.dom` 暂保留所属模块节点的聚合引用；新功能应在自己的控制器查询并使用节点，不继续往 App 的 DOM 表追加。

控制器可通过构造时传入的 App 访问当前阅读会话、全局设置、导航及其他功能入口，不导入 `app.js`，不创建第二个 App，也不复制共享状态。不要用 prototype 注入、mixin、Proxy 或批量动态生成方法隐藏真实调用位置。

`PdfDrawingController.resetSessionState()` 与 `PdfToolsController.resetSessionState()` 分别负责笔迹缓存/画笔和 OCR/参考页/副视口等会话资源；App 在切书、关闭阅读器时调用它们，不直接修改控制器私有字段或工具按钮。绘图写入队列保留已经提交的任务，窗口退出通过 `flushPendingWrites()` 等待。异步加载通过会话代数或任务持有者校验，旧回调不能清空新任务。`ReaderCardsController` 自己持有 AI 弹窗的引用快照、请求和完整回答；引用固定到打开弹窗时的书籍与内容版本。

切书时同时清空书内搜索与位置历史、重置阅读浮层并释放章节监听；跨书检索保留自己的弹窗生命周期。Foliate 章节文档的监听由章节绑定器的 AbortSignal 管理，定时器跟随相同会话取消；Ctrl 手势状态是布尔值。目录恢复、批注重载和 AI 对话查询在异步返回后核对原书籍/会话。段落翻译只复用同一本书的对话，关闭浮层会取消请求。PDF 指定位置的页码、纵向偏移、初始进度与计时起点使用同一个打开目标。

书内检索按需生成完整结果，每页 50 条，控制器仅缓存最近三页；更早的页面按需重放检索。上一处/下一处可跨结果页，书内和跨书请求使用独立取消信号。Foliate 的 `batchSize` 与 `retainHighlights:false` 支持分批生成 CFI，避免先物化整章所有匹配和全书高亮；PDF 无匹配页只读取纯文本，命中页才读取几何。结果总数在遍历完成前显示为还有更多，不把首批条数当全文总数。

## 必须保持的几项约定

- `stableKey` 表示作品线索，`documentHash` 表示内容，`blobRevision` 表示本地文件修订；三者不互相替代。
- 内容身份的 `same / different / unknown` 三态由共享模型决定。跨算法的旧标识需要验证原文件，不能直接当作相同或不同。
- 旧书记录 ID、阅读进度和批注绑定应保留。不可变原生快照、标准 IndexedDB 事务、现有恢复日志和凭据存储继续使用。
- 空白 PDF 页面不分配手绘位图；页面已有笔迹或启用画笔时再创建。手绘按内容和页码索引读取。
- 不给生产代码增加仅供测试桩调用的另一套算法。测试实现明确的存储/驱动接口，或使用隔离浏览器中的真实 IndexedDB。
- 普通错误在功能边界说明即可。避免层层吞错、无条件重试、重复回滚和通用“安全框架”。

## 验证与构建

在仓库根目录执行，先做与修改相关的检查；变更数据契约或公共生命周期时再跑全量回归。

```powershell
node scripts/run-syntax-checks.mjs
node --expose-internals scripts/check-structure.cjs
node scripts/test-data-contracts.mjs
node scripts/test-app-composition.mjs
node scripts/test-reader-search.mjs
node scripts/test-android-tts.mjs
node scripts/test-regression-suite.mjs

. .\scripts\env.ps1
cargo check --offline --manifest-path src-tauri/Cargo.toml
```

结构检查使用开发用 Node 内置 Acorn，检查重复类成员和纯模型依赖；解析器不会打包进阅读器。`--check-runner` 会故意制造错误并返回 1，用于检查运行器。

仓内回归的 MuPDF 实书验证会比较 C 桥、头文件和验证源程序的更新时间；验证程序过期时通过 `build-native-verifier.ps1` 重建后再运行，避免把旧二进制的结果用于新源码。首次重建需要工程已配置的 MSVC/MuPDF 开发环境，后续源文件未变时直接复用。

`npm run build:windows` 使用受控 Windows 构建脚本，默认只生成候选物；`-Deploy` 才覆盖安装。Tauri 的 `beforeBuildCommand` 负责刷新前端资源，避免多处重复构建或打包旧资源。仅改源码与验证时无需生成 EXE/NSIS。

JSON 备份保存书目元数据、笔记与配置，不嵌入整本书籍二进制。跨机器迁移请同时保留原书或已上传的云端副本。OneDrive/Google Drive 的真实账号授权、打包态启动耗时和真机帧率需要对应环境实测，语法检查与模拟网络不能代替这些结果。

冷启动打点：`app.js` 的 `markBootStage()` 在首个可读帧（PDF 由 `reportInitialPdfFrame`、EPUB/TXT 由 `reportInitialFoliateFrame` 在首屏可见章节文档双 `rAF` 绘制完成后触发）或书架首屏 `shelfReady` 时锁定 `_bootStagesSealed`，防止后续切书、翻页回写启动阶段耗时；仅当设置环境变量 `LINDEN_BOOT_METRICS_FILE` 时才通过 `app_write_boot_metrics` 落盘启动阶段 JSON（不打开 DevTools）。

安卓实验卷页的页面快照、资源预算、格式降级与真机验收边界见 [ANDROID_PAGE_CURL.md](ANDROID_PAGE_CURL.md)。手机默认仍为 slide；快照仅在选用 cover 时按需准备，导航与进度继续由现有 Controller/Adapter 和 paginator 负责。
