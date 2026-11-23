# Android page curl and source readiness

The default mobile turn mode remains **slide**. **Cover** is an experimental
page curl mode for ready PDF canvases and supported paginated EPUB/TXT/DOCX pages.
Desktop reading does not enable these mobile page textures.

## Ownership

`PageTurnController` owns gestures and the single navigation commit.
`FoliatePageTurnAdapter` lazily loads `foliate-page-snapshot.js` only when curl
is selected on a mobile viewport. `Paginator.getPageSnapshotContext()` supplies
the actual iframe/column/overlayer geometry without moving the reading position.
`FoliatePageSnapshots` owns asynchronous raster preparation, cancellation,
observers and canvas disposal. All formats use the existing `CurlRenderer` and
`curl-geometry.js`; there is no second curl or navigation implementation.

The browser paints cloned XHTML/CSS into an SVG foreignObject image. This is
not TreeWalker/Range/fillText text reconstruction. Chapter images, publisher
fonts, pseudo elements and the app fonts copied into the iframe are embedded
into the image. Media queries are evaluated using the actual iframe viewport;
root-relative units retain that document's reference size. The chapter's
actual multicolumn layout and RTL direction are retained. Saved annotation SVG
is composed using the same viewport coordinates.

Canvas and live-DOM text can have different antialiasing. Visual tests compare
the real page before/after navigation with its texture, allowing one pixel at
glyph edges, and also record RGB error. They do not claim exact pixel identity.

## Bounds and fallback

- Keep at most three CPU canvases at up to 1 Mi pixels each by default.
  If WebView reports at least 8 GiB of device memory, prepare one more
  page in the reading direction, with up to 3 Mi pixels per canvas and
  up to 3x display density.
  The GL renderer uses the prepared texture resolution, two page textures
  and shadow buffers. These limits describe allocations for page turning.
- Chapter pagination retains the serialized XHTML and already painted page
  neighbors. Idle work fills missing neighbors. Each page embeds the same
  encoded chapter into its own viewport without parsing the chapter again.
  Content and layout changes invalidate the cached source. A document over 12,000 elements or 8 MiB of
  embedded resources stays on slide.
- When the destination texture is missing, retain the current sheet and curl
  it over the live destination. Android can copy the displayed reader region
  on demand, with a lossless transient image and the same texture size budget.
  Cross-section navigation uses this live-destination path. Accepted swipes
  retain their order and each has its own curl. If the renderer cannot draw
  the source, report the unavailable mode and preserve the reading location.
  The old iframe remains attached until a touch that started there ends.
  A finished in-chapter curl commits through the paginator's normal relocation
  path without the native swipe debounce.
- Changing books/modes, hiding the app and disposing an adapter clears texture
  work. WebGL context loss releases the new CPU cache as well as existing GPU
  resources and keeps the real reading view available.
- Page curl consumes the active PDF viewport canvas regardless of whether PDF.js
  or MuPDF is selected in Android settings; it does not alter the PDF backend itself.

## Validation boundary

Run `node scripts/test-android-tts.mjs` for controlled native-transport lifecycle
checks, alongside the existing syntax/structure/composition/regression suites.
It does not synthesize device audio or test Android services.

The 2026-11-16 isolated Edge checks exercised real Foliate imports, embedded
fonts/linked SVG, Chinese TXT, LTR/RTL, trusted touch curl/cancel, theme/size
invalidation, chapter fallback, book switches and context loss. Chromium
software WebGL tests do not establish Android phone frame rate, battery usage
or driver support. Unsupported Android WebViews must fall back to slide.

Before an internal Android release, build a candidate from the final shared
source once, then verify on a phone: launch/resume/external import, gestures
and text selection, device GPU behavior, TTS sound/voice-data errors, notification
controls and background/lockscreen behavior. No APK/EXE/Gradle/Cargo build,
installation, real account or paid API was used for this source work.
