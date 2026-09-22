# Windows build / smoke-test checklist

1. Open the project root in a normal networked development shell and run `npm install` once. Do not use the preserved `package-lock.legacy-electron.json` as the active lockfile.
2. Run `node scripts/test-all-fixes.mjs` and `node scripts/build-dist.js`.
3. Run `npm run tauri:dev` with no MuPDF variables. `mupdf_is_available` should be false and local PDFs should use PDF.js.
4. Obtain an x64 MuPDF SDK matching the compiler/runtime. Set, for example:
   - `LL_MUPDF_INCLUDE=C:\path\to\mupdf\include`
   - `LL_MUPDF_LIB_DIR=C:\path\to\mupdf\lib`
   - `LL_MUPDF_LIBS=mupdf` (or a semicolon-separated list required by that SDK build)
5. Run `cargo check` from `src-tauri`, then `npm run tauri:dev` from the project root.
6. Open a local PDF and confirm the console reports the native backend; then test fast scroll, zoom, abort by immediately scrolling away, word selection, cross-page selection and highlight restore.
7. Open representative reflow EPUB and fixed-layout/image EPUB files. Repeatedly change chapters/pages quickly and resize the window. A failed candidate page must not clear the currently visible spread.
8. Finally run the release build only after the above smoke tests.

If native linking is problematic, leave MuPDF variables unset and debug the Tauri/EPUB/PDF.js baseline first. The native backend is deliberately optional.
