# Android MuPDF native rendering core

Release Android builds include both PDF.js (default) and MuPDF linked into the
shared Rust worker, while Debug builds link MuPDF when run with `-NativePdf`. A
native open failure automatically falls back to PDF.js. Android PDF snapshots for
this backend live in app data so they survive cache eviction. The mobile tile
planner described below has its own verifier and awaits integration with the
viewport scheduler.

## Ownership and boundary

`src-tauri/native/ll_mupdf_mobile.{h,c}` is a small render planner and tile renderer
on top of the existing `ll_mupdf.c` bridge. It does not contain another PDF parser,
selection algorithm, page cache, asynchronous queue or transport protocol. Text,
selection quads, display-list reuse, cancellation and image ownership remain in
the shared native bridge. The owning worker must serialize calls on each `ll_doc`.

## Algorithm

1. Read page bounds once with `ll_page_bounds`. Pass scale in **physical pixels per
   PDF point**, including device pixel ratio exactly once. The caller determines
   fit width/height and user zoom; this core never guesses CSS viewport size.
2. `ll_mobile_plan_render(..., LL_MOBILE_PREVIEW, ...)` plans one whole-page image.
   Aspect ratio is preserved. Unknown/<=4 GiB memory uses <=524,288 pixels; the
   normal profile uses <=1,048,576. Both limit the longest preview edge to 2048.
   A preview is an intermediate image, never the final zoom resolution.
3. `LL_MOBILE_DETAIL` preserves the requested scale, maps the visible page-space
   rectangle through rotation and normalized page-to-device transform, and
   intersects with the page. Offscreen portions are not scheduled. The resulting
   device bounding box uses one image if it fits the 4/8 MiB RGBA budget (and
   <=4096px edges); otherwise it is split into 768px (conservative) or 1024px tiles.
   A normal visible page need not replay its display list for unnecessary tiles.
   At arbitrary rotations this is the visible rectangle's device bounding box,
   not an exact polygon mask. Adjacent tiles have 1px sampling bleed. Composite
   only each tile's `content` rectangle, removing its overlap.
4. `ll_mobile_render_tile` passes the planned device-pixel clip to the existing
   `ll_render_priority`. The returned `ll_image.matrix` still maps original page
   coordinates; `x/y` identify the bitmap's device origin. Cropping must not
   renormalize page coordinates or change annotation/selection coordinates.
5. Consume each returned tile before requesting another and call `ll_free_image`.
   A pre-cancelled request exits before display-list work; an in-flight request
   retains the existing MuPDF cookie cancellation behavior. The caller must
   check session/generation before displaying a result and stop scheduling old
   tiles. This core does not introduce another request queue or timer.

The conservative and normal suggested MuPDF store budgets are 48/64 MiB per
context. These are **not total memory caps**: display lists, output pixels,
transport copies, WebView canvases and GPU textures add memory. The hard output
image limits are 4/8 MiB; when tiling, a tile needs at most about 2.27/4.02 MiB.
Avoid retaining all tiles or multiplying this budget across several active
documents unchecked.
The planner rejects non-finite/empty/excessive geometry before allocation.

## Verification without building the application

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-mupdf-mobile.ps1
# Optional: also compare the first/middle/last pages of a real local PDF.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-mupdf-mobile.ps1 -RealBook '.\path\to\sample.pdf'
# Compile NDK objects only, without the host verification executable.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-mupdf-mobile.ps1 -AndroidOnly
```

The host verifier links the real shared C bridge and existing patched MuPDF
libraries. It checks preview budgets, tile coverage, non-zero page origins,
rotations, cropped tiled pixels against direct rendering, cancellation and
display-list reuse. The NDK compiles ARM64 and x86_64 API 24 object files and checks
their ELF architecture. All temporary
objects/fixtures/test binaries are placed under `$env:LINDEN_BUILD_ROOT` (or repo-local `.local\build` by default).
Host execution plus Android object compilation do not establish phone performance,
cross-linked Android-library correctness or real-device rendering correctness.

The solid-color fixture at 0/90/180/270 degrees must match byte-for-byte. At
arbitrary rotations, MuPDF re-clips vector edges to the tile scissor; the fixture
allows <=64/255 channel delta in <=0.2% of bytes. The real-book comparison allows
<=32/255 in <=0.5%. These are explicit acceptance tolerances, not a guarantee of
byte-identical arbitrary-vector rasterization. Geometry/coverage/affine mapping
and cancellation are checked separately.

## APK builds and device verification

Use the signing key from the previous build and set an Android installation
version greater than the package under test.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Mode Debug -VersionCode 1000001 -Tag beta-upgrade-pdfjs -OfflineGradle
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Mode Debug -VersionCode 1000002 -Tag beta-mupdf -NativePdf -OfflineGradle

In an Android build with both engines, open **Settings → Appearance → PDF Rendering Engine**.
PDF.js remains the default. Selecting an engine reopens the current PDF at its
reading position. A previously saved PDF with only a Blob gets a reusable native
snapshot the first time it needs MuPDF. The book identity and reading history
are shared between the engines. PDF.js opens books that fail native staging or opening.

Release builds include both engines by default. Debug builds include MuPDF
when run with `-NativePdf`.

Use a populated library to verify installing over the old APK. For the native
trial, check CJK fonts, first page, scrolling, zoom, text selection, copying,
rotate/resume and closing/reopening a document. The native mouse-selection
implementation skips touch events. Verify Android touch selection and connect
the tile planner before considering a default switch.

References: [MuPDF Android](https://mupdf.readthedocs.io/en/latest/guide/using-with-android.html),
[Android NDK build](https://developer.android.com/ndk/guides/ndk-build).
