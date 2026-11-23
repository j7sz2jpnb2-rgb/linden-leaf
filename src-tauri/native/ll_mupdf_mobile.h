#ifndef LL_MUPDF_MOBILE_H
#define LL_MUPDF_MOBILE_H

#include "ll_mupdf.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Offline native core, deliberately not registered as an IPC command yet.
 * The caller supplies scale in physical pixels per PDF point (including DPR).
 * page_bounds and visible_page_rect use the MuPDF page-space returned by
 * ll_page_bounds/ll_get_text (not raw PDF bottom-left coordinates). Crop
 * never changes the page origin. rotation uses the same convention as ll_render.
 * Plan once per visible region, render one tile, consume/free it, then continue.
 * Do not retain all tile images or call the same ll_doc from multiple threads.
 */
enum { LL_MOBILE_PREVIEW = 0, LL_MOBILE_DETAIL = 1 };

typedef struct {
    uint32_t store_mb;          /* Suggested MuPDF store, not a process RAM cap. */
    uint32_t preview_pixels;
    int preview_edge;
    int tile_edge;             /* Non-overlapping content edge, excluding bleed. */
    size_t max_tile_bytes;     /* RGBA only; packet/WebView copies are separate. */
} ll_mobile_limits;

typedef struct {
    float scale, rotation;
    float matrix[6];           /* Original page -> device, before tile offset. */
    int region[4];             /* Visible device bbox, half-open. */
    int tile_edge, bleed;
    int columns, rows, tile_count;
    size_t max_tile_bytes;
} ll_mobile_render_plan;

typedef struct {
    int content[4];            /* Destination rectangle without overlap. */
    float clip[4];             /* Includes 1 px bleed, passed to ll_render. */
    size_t rgba_bytes;
} ll_mobile_tile;

/* memory_mb == 0 means unknown: use the conservative profile. */
LL_API ll_mobile_limits ll_mobile_limits_for_memory(uint32_t memory_mb);
/* Preview covers the whole page at a capped resolution, independent of crop.
 * Detail retains the requested zoom and renders ONLY the visible region.
 * A successful plan allocates no bitmap. Invalid/excessive geometry is rejected.
 */
LL_API int ll_mobile_plan_render(const float page_bounds[4], float scale,
    float rotation, const float *visible_page_rect, int quality,
    uint32_t memory_mb, ll_mobile_render_plan *out);
LL_API int ll_mobile_tile_at(const ll_mobile_render_plan *plan, int index,
    ll_mobile_tile *out);
/* Reuses the existing rasterizer, display-list cache, cancellation and RGBA
 * ownership. ll_free_image(doc, out) is required after EVERY successful tile.
 * Plan/doc/page must refer to the same immutable document and page bounds.
 */
LL_API int ll_mobile_render_tile(ll_doc *doc, int page,
    const ll_mobile_render_plan *plan, int index, ll_cancel *cancel,
    ll_image *out);

#ifdef __cplusplus
}
#endif
#endif
