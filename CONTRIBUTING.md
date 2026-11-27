# Contributing to Linden Leaf · 参与贡献

Thank you for your interest in **Linden Leaf**! Contributions—including bug reports, documentation improvements, test coverage, and pull requests—are welcome.

感谢你关注 **Linden Leaf（菩提叶阅读）**！欢迎提交 Bug 反馈、文档改进、测试用例与代码 PR。

---

## Development Principles / 开发约定

1. **Architecture Boundaries / 架构边界**:
   - Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before modifying state or controllers.
   - Pure models (`js/sync-model.js`, `js/book-metadata.js`, `js/reading-data.js`, `js/document-identity.js`, `js/ocr-layout.js`) must remain independent of UI/DOM, IndexedDB, and platform bridges.
   - `*-controller.js` modules must never import `js/app.js` directly.
2. **Bilingual Parity / 双语界面一致性**:
   - Every visible user-facing string, `title`, `placeholder`, and `aria-label` in `index.html` must carry `data-i18n*` attributes and exist identically in both [`js/i18n-zh.js`](js/i18n-zh.js) and [`js/i18n-en.js`](js/i18n-en.js).
3. **Security & Privacy Guardrails / 安全与隐私红线**:
   - Never add telemetry, undocumented network hosts, or plaintext credential storage in `localStorage` / sync payloads.
   - Escape any dynamic values rendered into HTML via `escapeHTML` (or prefer `textContent`).
   - Do not add new `!important` overrides in `css/*.css`.
4. **Offline & Locked Cargo Builds / 离线与锁定构建**:
   - Do not add unnecessary crate dependencies to `src-tauri/Cargo.toml` unless discussed first, so `cargo test --lib --locked --offline` stays reproducible.

---

## Required Verification Before Opening a PR / 提交前必跑验证

Run the full verification suite from the repository root:

```powershell
# Frontend syntax, module structure, i18n parity, UI safety, data contracts, OCR layout, and regressions (17 suites)
npm run verify

# Dist packaging smoke check
npm run build:dist

# Rust unit tests & binary compilation check
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline
cargo check --manifest-path src-tauri/Cargo.toml --bins --locked --offline
```

When modifying Windows native MuPDF C/Rust code, also verify with `LL_REQUIRE_NATIVE_MUPDF=1` against MuPDF 1.25.4 headers and libraries.

---

## License Agreement / 许可协议

By submitting a contribution, you agree that your work will be licensed under **GNU GPL-3.0-or-later** (and **GNU AGPL-3.0-or-later** where combined binaries link MuPDF), consistent with [LICENSE.txt](LICENSE.txt).
