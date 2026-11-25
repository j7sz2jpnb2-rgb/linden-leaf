# Linden Leaf 状态语法规范（「纸、墨、签、印」）

> 适用于全站桌面端与移动端界面组件。所有主题（`light` / `sepia` / `dark` / `black` / `green` / `eink`）共用同一套语义 Token 与状态语法。

## 1. 状态语法表

| 状态 | 隐喻 | 视觉表现 | 颜色语义 | 触发方式 |
|---|---|---|---|---|
| 输入框·静止 | 纸面上的浅槽 | 略深的纸底 `--paper-sunken` + 发丝线 `--line-soft` | 中性 | 默认 |
| 输入框·焦点 | 纸被轻轻提起 | 亮一层纸底 `--paper-raised` + 墨线 `--line-strong` + 极淡中性投影 `--shadow-lift` + `outline: 1px solid transparent`（Windows 高对比度兜底） | **中性墨色**（仅光标 `caret-color` 用 `--accent-primary`） | `:focus-within`（容器型）或 `:focus`（独立输入框） |
| 非文本控件·键盘焦点 | 铅笔圈 | `outline: 2px solid var(--line-strong); outline-offset: 2px;` | 中性墨色 | **仅在** `:focus-visible` 时出现 |
| 选项·选中 | 书签纸条 | 浅朱底 `--accent-soft` + 朱色文字/图标 `--accent-text`，**无边框、无光晕** | 朱色（浅） | `.active` / `[aria-checked="true"]` / `[aria-selected="true"]` / `[aria-pressed="true"]` |
| 导航·当前页 | 翻到的这一页 | 中性加深底（侧栏 `--bg-sidebar-active`） | 中性 | `.active` / `[aria-current]` |
| 主操作 | 朱印 | 实心朱色背景 + 白色文字 | 朱色 | 每个视图 / 弹窗最多一个主按钮 |
| 悬停 | 手指压纸 | 边框微深或底色压深一级 | 中性 | `:hover` |
| 错误 | 批红 | 独立错误红边框 `--danger` + 下方错误图标与文字（`aria-describedby` 关联） | **独立错误红**（偏深红/玫红，色相与赤陶 `--accent-primary` 明确拉开） | `.is-error` 校验失败 |
| 禁用 | 褪色 | 整体降低对比度，取消交互反馈 | 中性 | `:disabled` / `[disabled]` |

---

## 2. 硬规则

1. **单一焦点指示**：每个控件同一时刻只能有一个焦点指示，并由**最外层可见形状**承担。
2. **禁止彩色光晕与双环**：禁用模糊的彩色 `box-shadow` 光晕（如 `0 0 0 3px rgba(218, 119, 86, ...)`）；内嵌 `<input>` 永远 `outline: none; box-shadow: none; border: 0; background: transparent;`，绝不允许全局 `input:focus-visible` 覆盖容器型输入。
3. **品牌色不画焦点线**：赤陶品牌色只用于实心主操作按钮（朱印）、选中态浅底/文字（书签纸条）与文本光标（`caret-color: var(--accent-primary)`）。
4. **错误不依赖纯色**：错误态必须同时提供 `--danger` 边框、错误图标和可读说明文字（`.leaf-field-error`）。
5. **焦点不可删除，只能换样式**：禁止全局 `*:focus { outline: none; }`；非文本控件统一保留 `:focus-visible` 铅笔圈，输入框保留 `outline: 1px solid transparent` 保障系统高对比度模式可见。
6. **动效节制**：颜色/背景/投影过渡使用 `--dur-fast`（`120ms`），顶栏搜索宽度展开使用 `--dur-med`（`180ms`）；在 `prefers-reduced-motion: reduce` 与应用内减动效模式下自动取消过渡。

---

## 3. 统一组件契约

- **统一输入框 `.leaf-field`**：支持 `--sm`（顶栏搜索）、`--md`（表单/弹窗）、`--lg`（搜索命令栏），内置 `.leaf-field-icon`、`.leaf-field-input`、`.leaf-field-clear`、`.leaf-field-kbd`、`.leaf-field-action` 及错误容器 `.leaf-field.is-error` + `.leaf-field-error`。
- **顶栏搜索 `#header-search-bar`**：桌面宽屏（`>= 1025px`）聚焦时平滑向左展开（`210px -> 268px`），右边缘锚定不挤压导入按钮；窄屏固定宽度不展开；聚焦或有值时隐藏 `.leaf-field-kbd`。
- **跨书全文搜索 `#modal-cross-book-search`**：桌面端采用顶部固定 `height: auto; max-height: 70vh;` 的 Spotlight 无盒底线头部（仅保留底边框线由 `--line-soft` 变为 `--line-strong`），移动端维持全屏 44px 舒适搜索栏与清晰无重框检索按钮；结果高亮 `<mark>` 使用 `--accent-soft` + 墨色加粗，键盘焦点行使用书签纸条样式。
- **新建书单 `#modal-create-list`**：名称输入框采用 `.leaf-field--md`，支持空提交 `.is-error` 内联批红提示与上方 `.create-list-preview` 实时侧栏预览；`#custom-list-icon-picker` 与顶栏视图切换 `.btn-view-mode.active` 统一使用书签纸条选中态。

---

## 4. 六套主题语义 Token 说明

所有主题均在 `css/main.css` 的 `[data-theme="..."]` 中完整定义以下 12 个状态 Token（`--line-strong` 在对应 `--paper-raised` 与底色上的对比度均 >= 3:1）：

| Token | 语义用途 | `light` | `sepia` | `dark` | `black` | `green` | `eink` |
|---|---|---|---|---|---|---|---|
| `--paper-sunken` | 静止输入框底槽 | `#f3f1ea` | `#ece3cc` | `#1f1f1d` | `#111111` | `#e3efe3` | `#f2f2f2` |
| `--paper-raised` | 焦点输入框浮起底 | `#ffffff` | `#fdfbf6` | `#32312e` | `#1c1c1a` | `#f9fcf9` | `#ffffff` |
| `--line-soft` | 静止发丝边框 | `#e2ddd2` | `rgba(100,80,50,0.16)` | `rgba(255,255,255,0.12)` | `#2a2a28` | `#c5dbc5` | `#bbbbbb` |
| `--line-strong` | 焦点墨线 / 铅笔圈 | `#76726a` | `#6f604d` | `#9b9990` | `#a3a29c` | `#536e54` | `#000000` |
| `--ink-muted` | 次要文字 / 快捷键提示 | `#6f6d66` | `#6e5f4d` | `#9e9d95` | `#aaa9a2` | `#33691e` | `#444444` |
| `--accent-soft` | 书签纸条选中底 | `rgba(218,119,86,0.12)` | `rgba(218,119,86,0.13)` | `rgba(204,120,92,0.18)` | `rgba(204,120,92,0.18)` | `rgba(218,119,86,0.13)` | `rgba(218,119,86,0.12)` |
| `--accent-text` | 浅底朱色强调字 | `#b34d2b` | `#9e4425` | `#ee9e82` | `#ee9e82` | `#b34d2b` | `#9e3d1d` |
| `--danger` | 错误红边框与文案 | `#be2f45` | `#b8293d` | `#f06478` | `#f06478` | `#be2f45` | `#a81d34` |
| `--danger-soft` | 错误状态浅底 | `rgba(190,47,69,0.10)` | `rgba(184,41,61,0.11)` | `rgba(240,100,120,0.16)` | `rgba(240,100,120,0.16)` | `rgba(190,47,69,0.10)` | `rgba(168,29,52,0.10)` |
| `--shadow-lift` | 焦点中性极淡投影 | `0 1px 2px rgb(0 0 0 / 0.06)` | `0 1px 2px rgb(0 0 0 / 0.06)` | `0 1px 2px rgb(0 0 0 / 0.25)` | `0 1px 2px rgb(0 0 0 / 0.25)` | `0 1px 2px rgb(0 0 0 / 0.06)` | `none` |
| `--dur-fast` | 颜色/边框快速过渡 | `120ms` | `120ms` | `120ms` | `120ms` | `120ms` | `120ms` |
| `--dur-med` | 展开/预览中等过渡 | `180ms` | `180ms` | `180ms` | `180ms` | `180ms` | `180ms` |
