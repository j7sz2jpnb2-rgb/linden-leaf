# Linden Leaf (菩提叶阅读) WebDAV 云同步协议与全量数据备份规范 (v2)

本文档定义 Linden Leaf 阅读器跨平台多设备（Windows PC、Android 等）数据同步协议、WebDAV 目录与生成文件规范、冲突解决算法及本地全量灾备格式。

---

## 一、核心设计哲学：Local-First 本地优先与零数据遗失

1. **本地优先 (Local-First)**：
   - 用户的图书文件、阅读进度、划线笔记、每日统计与排版偏好永久保存在本地数据库（IndexedDB 与客户端安全配置）。
   - 无网络或脱机状态下，阅读器所有功能 100% 完整可用，无任何启动阻塞或同步延迟。

2. **跨设备完全一致**：
   - 云同步不仅同步书籍进度，而且必须**100% 覆盖软件中产生的所有有效信息**。
   - 跨设备同步或恢复备份后，不仅书架与笔记完全恢复，**每日读书明细（每天具体读了哪本书、读了多久）、阅读评分、专属标签、命名阅读预设、自定义配色、甚至单书专属排版**均能无缝还原。

3. **隐私与系统级凭据保护**：
   - WebDAV 账户密码通过平台原生安全机制加密持久化（Windows DPAPI / Android Keystore），严禁明文或 Base64 存储。
   - 同步包与备份包**绝不携带任何第三方服务密钥（如 AI API Key、TTS Secret）**、本地绝对物理路径或设备私密标识。

---

## 二、WebDAV 云端目录布局与自动生成文档

用户配置 WebDAV 服务器（如坚果云、Nextcloud、群晖 WebDAV、InfiniCLOUD 等）后，同步引擎在指定的远程目录（默认为 `LindenLeaf/`）下自动维护以下文件：

```text
WebDAV Root/
└── LindenLeaf/
    ├── linden_sync_data.json                   # 核心同步协议数据包 (JSON, Schema v2)
    ├── LindenLeaf_Reading_Notes_and_Stats.md    # 自动生成的 Markdown 格式人类可读阅读总览与每日读书明细
    └── books/                                  # 经用户许可/策略符合的云备份书籍原文件
        ├── san-ti.epub
        ├── hong-lou-meng.epub
        └── ...
```

### 1. 核心同步数据包：`linden_sync_data.json`
- 存放全量结构化元数据、每日会话、笔记划线、排版偏好与删除墓碑。
- 采用 RFC 7232 标准的 **ETag 乐观锁并发控制**，防止多台设备同时写入造成覆盖丢失。
- 传输限制：单次 JSON Payload 设有 20 MiB 安全防御上限。

### 2. 自动生成的 Markdown 阅读总览：`LindenLeaf_Reading_Notes_and_Stats.md`
- **设计初衷**：让用户的阅读资产具备“逃生通道 (Data Portability)”与直接可读性。用户无需打开阅读器，即可通过手机文件管理器、Obsidian、Logseq、Notion 或 WebDAV 网页端直接浏览和检索自己的阅读笔记与统计日志。
- **自动生成的内容**：
  1. **元信息**：同步时间、同步客户端设备名称、同步协议版本；
  2. **阅读总体概览**：藏书总量、读完本数、在读本数、总阅读时长、总听书时长、笔记划线总数、登记阅读会话总数；
  3. **📅 每日读书详细登记表**：按日期倒序归档的表格，清晰列出**每天读了哪几本具体的书（书名）、作者、阅读/听书时长、会话次数**；
  4. **📚 书架图书明细与状态表**：书名、作者、格式、状态（未读/想读/在读/搁置/读完）、评分（五星）、标签、阅读累计时长、进度百分比；
  5. **📑 自定义书单列表**：书单名称及包含图书数量；
  6. **✍️ 近期精选划线与想法笔记**：包含引文原文、想法批注、出处书籍与章节、记录日期。

### 3. 图书原文件云存储：`books/<filename>`
- **安全阈值与防流量爆仓保护**：
  - 自动备份/自动下载仅针对体积 `< 15MB` 的文本类流式图书（EPUB, MOBI, AZW3, TXT 等）；
  - PDF、CBZ 等高风险或大体积格式严禁自动上传下载，必须由用户在书籍详情页手动确认，保护坚果云等每月上传流量配额（坚果云免费版仅 1GB 上传/月）。

---

## 三、同步数据 (linden_sync_data.json) 字段全量覆盖规范

`linden_sync_data.json` 覆盖的全部 7 大信息板块规范如下：

```json
{
  "version": 2,
  "clientId": "client_8f9a2b",
  "deviceName": "Windows PC",
  "updatedAt": 1761910000000,
  "settings": { ... },
  "readingPresets": [ ... ],
  "customPalette": { ... },
  "userName": "读者昵称",
  "bookSettingsOverrides": { ... },
  "advancedSettings": { ... },
  "booksMeta": [ ... ],
  "readingSessions": [ ... ],
  "highlights": [ ... ],
  "bookmarks": [ ... ],
  "pdfDrawings": [ ... ],
  "customLists": [ ... ],
  "chapterTranslations": [ ... ],
  "deletedRecords": [ ... ]
}
```

### 1. 图书元数据与状态 (`booksMeta`)
每个图书对象包含以下完整字段：
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | string | 本地图书唯一标识 |
| `stableKey` | string | 跨设备图书匹配锚点（标题+文件尺寸+格式哈希），确保不同设备导入同本书时能准确对应 |
| `identifier` | string/null | EPUB UUID / ISBN 等标准标识 |
| `title` | string | 原始图书标题 |
| `author` | string | 原始作者姓名 |
| `customTitle` | string/null | 用户自定义修改的书籍标题 |
| `customAuthor` | string/null | 用户自定义修改的书籍作者 |
| `format` | string | 格式扩展名 (`epub`, `pdf`, `txt`, `mobi` 等) |
| `size` | number | 文件字节大小 |
| `cover` | string/null | 封面缩略图 DataURL / Cloud 引用 |
| `isFavorite` | boolean | 是否收藏 / 设为特别关注 |
| `favoriteUpdatedAt` | number | 收藏状态最后变更时间戳（用于 LWW 仲裁） |
| `readingStatus` | string | 阅读状态：`unread`（未读）、`want_to_read`（想读）、`reading`（在读）、`on_hold`（搁置）、`finished`（读完） |
| `statusUpdatedAt` | number | 状态最后变更时间戳 |
| `completedAt` | number/null | 读完时间戳（取消读完时显式保留 null 并在多端传播） |
| `rating` | number/null | 5星评分（支持 0.5-5.0 星，null 表示未评分或已清除） |
| `ratingUpdatedAt` | number | 评分最后变更时间戳 |
| `tags` | string[] | 专属分类标签列表（如 `["科幻", "雨果奖"]`） |
| `tagsUpdatedAt` | number | 标签最后变更时间戳 |
| `customListIds` | string[] | 所属自定义书单 ID 列表 |
| `listsUpdatedAt` | number | 书单归属最后变更时间戳 |
| `progress` | object | 精确进度对象（`fraction`, `cfi`, `page`, `timestamp`） |
| `lastReadAt` | number | 最后阅读/翻页时间戳 |
| `totalReadingSeconds`| number | 累计文本阅读时长（秒） |
| `totalListeningSeconds`| number | 累计听书时长（秒） |
| `cloudBackup` | object/null | 云端文件备份元数据（`hasBackup`, `fileName`, `uploadedAt`） |

### 2. 每日读书具体书目明细 (`reading_sessions`)
每一笔阅读与听书会话记录均独立存盘，**核心规范是必须冗余保存 `bookTitle` 与 `bookAuthor`**：
| 字段名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | string | 会话唯一 ID（`sess_<timestamp>_<rand>`） |
| `bookId` | string | 关联图书 ID（跨设备同步时通过 `stableKey` 自动映射） |
| `bookTitle` | string | **具体书名**（确保跨设备尚未导入原书、或删书后，历史日历与柱状图点击依然能展示具体书名！） |
| `bookAuthor` | string | **具体作者** |
| `date` | string | 本地自然日日期字符串（格式 `YYYY-MM-DD`） |
| `startTime` | number | 会话开始时间戳（毫秒） |
| `endTime` | number | 会话结束时间戳（毫秒） |
| `durationSeconds` | number | 有效专注阅读时长（秒，已过滤走开闲置与飞速翻页） |
| `activeIntervals` | array | 连续活跃时间段 `[[start, end], ...]`（用于消除听书与阅读时段重叠统计） |
| `isListening` | boolean | 是否为语音听书会话 |
| `startProgress` | number | 开始阅读进度 fraction (0.0 - 1.0) |
| `endProgress` | number | 结束阅读进度 fraction (0.0 - 1.0) |

> **为什么必须冗余记录 `bookTitle` 和 `bookAuthor`？**
> 传统阅读软件往往在 session 中只存 `bookId`，然后通过 join 查询书籍表。一旦用户在电脑上读完了某本书并将文件移出书架，或者在手机新设备上同步时还没有下载/导入该书，历史统计中点击某一天就会变成“未知书籍”，导致宝贵的历史阅读轨迹残缺不全。Linden Leaf 在会话产生、备份与同步时全程保证 `bookTitle` 与 `bookAuthor` 的独立完整性。

### 3. 划线与想法笔记 (`highlights`)
- 包含 `id`, `bookId`, `bookTitle`, `bookAuthor`, `cfi`, `pdfTarget`（PDF 视口坐标/页码）, `color`, `style`（下划线/背景高亮/波浪线/虚线）, `text`（引文原文）, `note`（用户想法批注）, `chapterTitle`, `createdAt`, `updatedAt`。
- 支持墓碑标记与删除同步。

### 4. 书签 (`bookmarks`) 与 PDF 手绘矢量批注 (`pdfDrawings`)
- 书签：`id`, `bookId`, `cfi` / `pageIndex`, `title`, `snippet`, `createdAt`。
- PDF 手绘矢量批注：按页面组织，包含高精细度的笔划对象数组 `strokes`（颜色、线宽、工具类型、坐标点数组 `points`）。支持多设备增量笔画级合并，设备 A 和设备 B 在同一页的不同涂鸦笔划会自动并集合成。

### 5. 我的书单 (`customLists`)
- 包含 `id`, `name`, `icon`, `bookIds`（书籍 ID 列表）, `createdAt`, `updatedAt`。
- 跨设备同步时，`bookIds` 会自动依据 `stableKey` 重映射至本机对应的图书 ID。

### 6. 排版与偏好设置
| 配置项 | 存储位置 | 说明 |
| :--- | :--- | :--- |
| `settings` | IndexedDB `settings` 表 | 全局阅读器排版配置（字号、字偶间距、段落间距、默认主题、阅读目标设置等） |
| `readingPresets` | `linden_reading_presets_v1` | 用户命名的阅读预设方案（最多 10 套，含预设名称、字体、排版参数） |
| `customPalette` | `linden_custom_semantic_palette_v1` | 全局自定义语义调色板（主背景、次背景、文字、高亮选区颜色等） |
| `userName` | `linden_user_name` | 读者个性化昵称（用于引文卡片与年度报告生成） |
| `bookSettingsOverrides` | `linden_book_settings_<bookId>` | 单书独立排版覆盖（针对特定书籍的单/双栏排版、专属字体与边距） |
| `advancedSettings` | `linden_advanced_settings` | 高级设置（TTS 语速、翻页模式、缓存限制等，脱敏滤除任何敏感密钥） |
| `chapterTranslations` | IndexedDB `chapter_translations` 表 | AI 章节双语对照译文与段落缓存（当开启云同步译文选项时同步） |

### 7. 删除墓碑 (`deletedRecords`)
- 记录 `id`, `type` (`book`, `highlight`, `bookmark`, `custom_list`, `pdfDrawing`, `chapter_translation`), `stableKey`, `deletedAt`。
- 采用 **60 天生存期 (TTL)** 自动老化淘汰，既防止跨设备死灰复燃，又杜绝同步 JSON 无限膨胀。

---

## 四、确定性冲突合并算法 (Deterministic LWW)

在执行多端同步时，`mergeSyncData` 遵循严格的数学确定性规则：

1. **时钟漂移防御 (Clock-Drift Clamp)**：
   - 所有传入的时间戳钳位在 `Date.now() + 60s` 内，防止某台设备时钟严重偏快永久“霸占”最新胜出权。
2. **图书状态 Last-Write-Wins (LWW)**：
   - 收藏、标签、状态、评分、单书排版依据各自独立的 `*UpdatedAt` 时间戳仲裁。
   - 时间戳相等时，以 `clientId` 字典序进行确定性决胜，保证两端合并结果 100% 对称一致。
3. **每日阅读时长取大合并**：
   - 若两台设备在离线期间上报了同一个会话 ID（例如由同一个基准时间分片生成），时长取其最大值 `Math.max(localDur, remoteDur)`，确保阅读时间不丢失也不重复累加。
4. **PDF 笔划级合并**：
   - 提取笔划的起止坐标与工具指纹，相同笔划保留更新版本，不同笔划并集保留。
5. **双语译文段落级合并**：
   - 校验源文本哈希、模型版本与提示词兼容性；兼容版本按段落状态合并，优先采纳已翻译完成的段落。

---

## 五、本地全量数据备份 (Schema v4) 规范

在客户端「高级设置」->「全量数据备份」中，导出为单文件 JSON：
- **格式标识**：`format: "linden-leaf-full-backup"`
- **架构版本**：`schemaVersion: 4`
- **涵盖内容**：
  - `userName`、`readerSettings`、`readingPresets`、`customPalette`、`bookSettingsOverrides`、`config`（脱敏高级设置）；
  - `books`（完整元数据，含 `isFavorite`、`rating`、`tags`、`customTitle`、`customAuthor` 等）；
  - `sessions`（完整每日阅读会话，含 `bookTitle` 与 `bookAuthor`）；
  - `highlights`、`bookmarks`、`drawings`、`customLists`、`chapterTranslations`。
- **向下兼容性**：
  - 恢复引擎完全兼容历史上所有的 v1、v2、v3 备份文件，并平滑升级至 v4。

---

## 六、总结对照表

| 有效信息分类 | 历史状态 | 现行规范 (v2/v4) | 保证效果 |
| :--- | :--- | :--- | :--- |
| **每日读书具体书目** | 仅存 bookId，删书/跨设备显示“未知书籍” | 会话中冗余记录 `bookTitle` 与 `bookAuthor` | 跨设备或删书后，日历与明细依然 100% 正确显示书名与作者 |
| **图书元数据** | 部分漏同步自定义书名、作者、收藏标志 | 覆盖 `customTitle`, `customAuthor`, `isFavorite`, `rating` 等 | 多端元数据完全同步，备份恢复不丢收藏 |
| **排版与预设** | 仅同步部分 readerSettings | 同步 readingPresets, customPalette, bookOverrides, userName | 用户定制的阅读预设与调色板多端同步 |
| **人类可读文档** | 云端仅有不可读的 json | 自动生成 `LindenLeaf_Reading_Notes_and_Stats.md` | 在任意外部 Markdown 查看器或 WebDAV 网页端直接查看每日阅读明细与笔记 |
| **凭据安全** | 曾有明文隐患 | 操作系统 DPAPI / Keystore 加密存储，云端不存密钥 | 零泄露风险 |
