# MuPDF 1.25.4 security backport

The Windows build applies this patch idempotently and incrementally rebuilds the static libraries before linking. The public MuPDF ABI stays at 1.25.4. Do not label this as a general upgrade to MuPDF 1.28.

Scope:
- CVE-2026-7233: CFF index bounds include the index data offset; the final subtraction check avoids unsigned addition overflow.
- CVE-2026-3308: reject overflowing unpack strides before allocation; use 64-bit arithmetic and preserve the old int ABI. Inline PDF image row/total lengths are checked before narrowing to the int loader API.
- CVE-2026-25556: match the upstream ownership fix: only the function creating a pixmap frees it on error; a fill operation never frees the caller's pixmap.

Primary references:
- https://mupdf.com/releases/cve
- https://github.com/ArtifexSoftware/mupdf/commit/a26f0142e7d390d4a82c6e5ae0e312e07cc4ec85
- https://github.com/ArtifexSoftware/mupdf/commit/a08c5ee1637580658184ab8b1860779ed2e9f73e
- https://github.com/ArtifexSoftware/mupdf/commit/d4743b6092d513321c23c6f7fe5cff87cde043c1

The stride checks are a narrow backport for the int-based 1.25 implementation, not a verbatim cherry-pick of newer size_t/checked-arithmetic APIs. Other advisories still need applicability review before public release (HTML layout and mutool CLI are separate paths; our EPUB uses Foliate).

CFF upstream fix: https://github.com/ArtifexSoftware/mupdf/commit/611f75f0c8657b92460554009196c5ac4b68d909
