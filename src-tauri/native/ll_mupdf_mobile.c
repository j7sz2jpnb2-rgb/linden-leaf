#include "ll_mupdf_mobile.h"
#include <mupdf/fitz.h>
#include <math.h>
#include <string.h>

#ifdef _MSC_VER
#include <float.h>
#define finite_number(x) _finite((double)(x))
#else
#define finite_number(x) isfinite(x)
#endif

/* Match the existing C bridge's bounds; do not change its desktop defaults. */
#define MAX_DEVICE_COORD 8388608
#define MAX_PLAN_TILES 4096

ll_mobile_limits ll_mobile_limits_for_memory(uint32_t memory_mb) {
    int low = memory_mb == 0 || memory_mb <= 4096;
    ll_mobile_limits limits = {
        low ? 48u : 64u,
        low ? 524288u : 1048576u,
        2048,
        low ? 768 : 1024,
        (size_t)(low ? 4 : 8) * 1024 * 1024
    };
    return limits;
}

static int valid_rect(const float *r) {
    if (!r) return 0;
    for (int i = 0; i < 4; ++i)
        if (!finite_number(r[i])) return 0;
    return r[2] > r[0] && r[3] > r[1];
}

/* Same normalized device origin as ll_render_priority, including rotated and
 * non-zero CropBox origins. Never normalize the crop as though it were a page. */
static int make_transform(fz_rect page, float scale, float rotation,
                          fz_matrix *matrix, fz_rect *box) {
    *matrix = fz_concat(fz_rotate(rotation), fz_scale(scale, scale));
    *box = fz_transform_rect(page, *matrix);
    *matrix = fz_concat(*matrix, fz_translate(-box->x0, -box->y0));
    *box = fz_transform_rect(page, *matrix);
    float values[] = {matrix->a, matrix->b, matrix->c, matrix->d,
        matrix->e, matrix->f, box->x0, box->y0, box->x1, box->y1};
    for (int i = 0; i < 10; ++i)
        if (!finite_number(values[i])) return 0;
    return box->x1 > box->x0 && box->y1 > box->y0;
}

static int bounded_box(fz_rect r) {
    return finite_number(r.x0) && finite_number(r.y0) &&
        finite_number(r.x1) && finite_number(r.y1) &&
        r.x0 >= -MAX_DEVICE_COORD && r.y0 >= -MAX_DEVICE_COORD &&
        r.x1 <= MAX_DEVICE_COORD && r.y1 <= MAX_DEVICE_COORD &&
        r.x1 > r.x0 && r.y1 > r.y0;
}

int ll_mobile_plan_render(const float bounds[4], float scale, float rotation,
    const float *visible, int quality, uint32_t memory_mb,
    ll_mobile_render_plan *out) {
    if (!out) return LL_ERROR;
    memset(out, 0, sizeof(*out));
    if (!valid_rect(bounds) || !finite_number(scale) || scale <= 0 ||
        !finite_number(rotation) || (visible && !valid_rect(visible)) ||
        (quality != LL_MOBILE_PREVIEW && quality != LL_MOBILE_DETAIL))
        return LL_ERROR;

    ll_mobile_limits limits = ll_mobile_limits_for_memory(memory_mb);
    fz_rect page = {bounds[0], bounds[1], bounds[2], bounds[3]};
    fz_matrix matrix;
    fz_rect box;
    rotation = fmodf(rotation, 360.0f);
    if (!make_transform(page, scale, rotation, &matrix, &box)) return LL_ERROR;

    if (quality == LL_MOBILE_PREVIEW) {
        double w = (double)box.x1 - box.x0, h = (double)box.y1 - box.y0;
        double ratio = fmin(1.0, sqrt((double)limits.preview_pixels / (w * h)));
        ratio = fmin(ratio, limits.preview_edge / fmax(w, h));
        scale = (float)(scale * ratio);
        /* Leave space for outward integer rounding, without distorting aspect. */
        if (ratio < 1.0) scale *= 0.998f;
        if (!finite_number(scale) || scale <= 0 ||
            !make_transform(page, scale, rotation, &matrix, &box)) return LL_ERROR;
    } else if (visible) {
        fz_rect r = {visible[0], visible[1], visible[2], visible[3]};
        r = fz_intersect_rect(page, r);
        if (fz_is_empty_rect(r)) return LL_ERROR;
        box = fz_intersect_rect(box, fz_transform_rect(r, matrix));
    }

    if (!bounded_box(box)) return LL_ERROR;
    fz_irect region = fz_round_rect(box);
    int width = region.x1 - region.x0, height = region.y1 - region.y0;
    if (width <= 0 || height <= 0) return LL_ERROR;

    int edge = limits.tile_edge;
    if (quality == LL_MOBILE_PREVIEW) {
        if (width > limits.preview_edge || height > limits.preview_edge ||
            (uint64_t)width * height > limits.preview_pixels) return LL_ERROR;
        edge = width > height ? width : height;
    } else if (width <= 4096 && height <= 4096 &&
        (uint64_t)width * height * 4 <= limits.max_tile_bytes) {
        /* A normal phone-sized visible page often fits in one bounded image.
         * Do not replay its display list several times just to force tiling. */
        edge = width > height ? width : height;
    }
    int cols = (width + edge - 1) / edge, rows = (height + edge - 1) / edge;
    if ((uint64_t)cols * rows > MAX_PLAN_TILES) return LL_ERROR;

    out->scale = scale;
    out->rotation = rotation;
    float m[6] = {matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f};
    memcpy(out->matrix, m, sizeof(m));
    out->region[0] = region.x0; out->region[1] = region.y0;
    out->region[2] = region.x1; out->region[3] = region.y1;
    out->tile_edge = edge;
    out->bleed = quality == LL_MOBILE_DETAIL ? 1 : 0;
    out->columns = cols; out->rows = rows; out->tile_count = cols * rows;
    out->max_tile_bytes = limits.max_tile_bytes;
    return LL_OK;
}

int ll_mobile_tile_at(const ll_mobile_render_plan *p, int index, ll_mobile_tile *out) {
    if (!out) return LL_ERROR;
    memset(out, 0, sizeof(*out));
    if (!p || p->columns <= 0 || p->rows <= 0 || p->tile_edge <= 0 ||
        p->tile_edge > 4096 || p->bleed < 0 || p->bleed > 1 ||
        p->tile_count <= 0 || p->tile_count > MAX_PLAN_TILES ||
        (uint64_t)p->columns * p->rows != (uint64_t)p->tile_count ||
        index < 0 || index >= p->tile_count) return LL_ERROR;
    if (p->region[0] < -MAX_DEVICE_COORD || p->region[1] < -MAX_DEVICE_COORD ||
        p->region[2] > MAX_DEVICE_COORD || p->region[3] > MAX_DEVICE_COORD ||
        p->region[2] <= p->region[0] || p->region[3] <= p->region[1])
        return LL_ERROR;

    int x = index % p->columns, y = index / p->columns;
    int x0 = p->region[0] + x * p->tile_edge;
    int y0 = p->region[1] + y * p->tile_edge;
    int x1 = x0 + p->tile_edge, y1 = y0 + p->tile_edge;
    if (x1 > p->region[2]) x1 = p->region[2];
    if (y1 > p->region[3]) y1 = p->region[3];
    if (x1 <= x0 || y1 <= y0) return LL_ERROR;
    out->content[0] = x0; out->content[1] = y0;
    out->content[2] = x1; out->content[3] = y1;
    out->clip[0] = (float)(x0 - (x > 0 ? p->bleed : 0));
    out->clip[1] = (float)(y0 - (y > 0 ? p->bleed : 0));
    out->clip[2] = (float)(x1 + (x + 1 < p->columns ? p->bleed : 0));
    out->clip[3] = (float)(y1 + (y + 1 < p->rows ? p->bleed : 0));
    out->rgba_bytes = (size_t)(out->clip[2] - out->clip[0]) *
        (size_t)(out->clip[3] - out->clip[1]) * 4;
    return out->rgba_bytes <= p->max_tile_bytes ? LL_OK : LL_ERROR;
}

int ll_mobile_render_tile(ll_doc *doc, int page, const ll_mobile_render_plan *plan,
    int index, ll_cancel *cancel, ll_image *out) {
    if (!out) return LL_ERROR;
    memset(out, 0, sizeof(*out));
    ll_mobile_tile tile;
    if (!doc || ll_mobile_tile_at(plan, index, &tile) != LL_OK) return LL_ERROR;
    if (ll_cancel_is_aborted(cancel)) return LL_CANCELLED;
    return ll_render_priority(doc, page, plan->scale, plan->rotation,
        tile.clip, cancel, 0, out);
}
