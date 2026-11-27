## Summary / 改动说明

- Concisely describe what changed and why.

## Checklist / 提交检查清单

- [ ] Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and respected module/pure-model boundaries (`*-controller.js` does not import `app.js`).
- [ ] Updated both [`js/i18n-zh.js`](js/i18n-zh.js) and [`js/i18n-en.js`](js/i18n-en.js) with 1:1 parity if any UI text changed.
- [ ] Ran `npm run verify` (all 17 suites pass).
- [ ] Ran `npm run build:dist` cleanly.
- [ ] Ran `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline` cleanly.
- [ ] No secrets, private sample files, or local machine paths added.
