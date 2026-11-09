#include "ll_mupdf.h"
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _MSC_VER
#include <float.h>
#define ll_isfinite(value) _finite((double)(value))
#else
#define ll_isfinite(value) isfinite(value)
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

static uint64_t ll_now_us(void) {
    static LARGE_INTEGER freq;
    static int initialized = 0;
    if (!initialized) {
        QueryPerformanceFrequency(&freq);
        initialized = 1;
    }
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return (uint64_t)((counter.QuadPart * 1000000ULL) / freq.QuadPart);
}
#else
#include <time.h>
static uint64_t ll_now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}
#endif

/* Small decoded working set. The application owns the larger byte-budgeted
 * bitmap/text caches; this cache avoids repeatedly interpreting nearby
 * pages while zooming and turning pages. Capacity 6 matches 1 visible + 4 buffer pages. */
#define CACHE_PAGES 6
#define LL_MAX_RENDER_EDGE 4096
#define LL_MAX_RENDER_PIXELS 10000000

typedef struct {
    int page;
    uint64_t used;
    fz_rect bounds;
    fz_display_list *list;
    fz_stext_page *text;
} ll_page;

struct ll_doc {
    fz_context *ctx;
    fz_document *document;
    int count;
    char error[512];
    ll_page pages[CACHE_PAGES];
    uint64_t clock;
    ll_stats stats;
    ll_render_timings last_render_timings;
};

struct ll_cancel {
    fz_cookie cookie;
};

static void clear_error(ll_doc *d) {
    if (d) d->error[0] = '\0';
}

static void caught(ll_doc *d) {
    if (d && d->ctx)
        snprintf(d->error, sizeof(d->error), "%s", fz_caught_message(d->ctx));
}

static void drop_page(ll_doc *d, ll_page *p) {
    if (!d || !p) return;
    fz_drop_stext_page(d->ctx, p->text);
    fz_drop_display_list(d->ctx, p->list);
    memset(p, 0, sizeof(*p));
    p->page = -1;
}

static ll_page *get_page_internal(ll_doc *d, int number, int *hit, int priority) {
    if (hit) *hit = 0;
    if (number < 0 || number >= d->count)
        fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Page index out of range");

    ll_page *entry = NULL;
    for (int i = 0; i < CACHE_PAGES; ++i) {
        ll_page *p = &d->pages[i];
        if (p->page == number && p->list) {
            p->used = ++d->clock;
            ++d->stats.list_hits;
            if (hit) *hit = 1;
            return p;
        }
    }

    /* Cache miss: pick best eviction victim using clean standard LRU.
     * Select unallocated slot (-1) first; otherwise evict entry with minimum 'used' clock. */
    for (int i = 0; i < CACHE_PAGES; ++i) {
        ll_page *p = &d->pages[i];
        if (p->page == -1) {
            entry = p;
            break;
        }
        if (!entry || p->used < entry->used) {
            entry = p;
        }
    }

    drop_page(d, entry);
    fz_page *page = NULL;
    fz_var(page);
    fz_var(entry);
    fz_try(d->ctx) {
        page = fz_load_page(d->ctx, d->document, number);
        entry->bounds = fz_bound_page(d->ctx, page);
        entry->list = fz_new_display_list_from_page(d->ctx, page);
        entry->page = number;
        entry->used = ++d->clock;
        ++d->stats.list_builds;
    }
    fz_always(d->ctx) {
        fz_drop_page(d->ctx, page);
    }
    fz_catch(d->ctx) {
        drop_page(d, entry);
        fz_rethrow(d->ctx);
    }
    return entry;
}

static void project_quad(const fz_quad *q, float ux, float uy, float vx, float vy,
                         float u_range[2], float v_range[2]) {
    float pts[4][2] = {
        {q->ul.x, q->ul.y},
        {q->ur.x, q->ur.y},
        {q->ll.x, q->ll.y},
        {q->lr.x, q->lr.y}
    };
    float min_u = 1e9f, max_u = -1e9f;
    float min_v = 1e9f, max_v = -1e9f;
    for (int i = 0; i < 4; ++i) {
        float pu = pts[i][0] * ux + pts[i][1] * uy;
        float pv = pts[i][0] * vx + pts[i][1] * vy;
        if (pu < min_u) min_u = pu;
        if (pu > max_u) max_u = pu;
        if (pv < min_v) min_v = pv;
        if (pv > max_v) max_v = pv;
    }
    u_range[0] = min_u; u_range[1] = max_u;
    v_range[0] = min_v; v_range[1] = max_v;
}

static fz_quad adapt_quad(const fz_quad *raw, const fz_quad *ink,
                          int flags, fz_point dir, float font_size) {
    /* 1. Invisible OCR text (PDF rendering mode 3 Tr, neither filled nor stroked) */
    if (!(flags & (FZ_STEXT_FILLED | FZ_STEXT_STROKED))) {
        return *raw;
    }

    float len = sqrtf(dir.x * dir.x + dir.y * dir.y);
    if (len <= 1e-4f) {
        dir.x = 1.0f; dir.y = 0.0f; len = 1.0f;
    }
    float ux = dir.x / len, uy = dir.y / len;
    float vx = -uy, vy = ux;

    float r_u[2], r_v[2];
    float i_u[2], i_v[2];
    project_quad(raw, ux, uy, vx, vy, r_u, r_v);
    project_quad(ink, ux, uy, vx, vy, i_u, i_v);

    float ih = i_v[1] - i_v[0];
    /* 2. Empty outline fallback (zero-height ink outline, e.g. real book sample 5) */
    if (ih <= 0.001f) {
        return *raw;
    }

    float rh = r_v[1] - r_v[0];
    int sane_raw = (rh > 0.001f && rh <= font_size * 2.5f);
    float low = sane_raw ? (r_v[0] < i_v[0] ? r_v[0] : i_v[0]) : i_v[0];
    float high = sane_raw ? (r_v[1] > i_v[1] ? r_v[1] : i_v[1]) : i_v[1];

    /* Reconstruct quad corners */
    fz_quad out;
    out.ul.x = ux * r_u[0] + vx * low;  out.ul.y = uy * r_u[0] + vy * low;
    out.ur.x = ux * r_u[1] + vx * low;  out.ur.y = uy * r_u[1] + vy * low;
    out.ll.x = ux * r_u[0] + vx * high; out.ll.y = uy * r_u[0] + vy * high;
    out.lr.x = ux * r_u[1] + vx * high; out.lr.y = uy * r_u[1] + vy * high;
    return out;
}

static void adapt_stext_page(ll_doc *d, ll_page *p) {
    if (!d || !p || !p->text || !p->list) return;
    fz_stext_page *acc_text = NULL;
    fz_var(acc_text);
    fz_try(d->ctx) {
        fz_stext_options opts = {0};
        opts.flags = FZ_STEXT_ACCURATE_BBOXES;
        acc_text = fz_new_stext_page_from_display_list(d->ctx, p->list, &opts);
        if (!acc_text) return;

        fz_stext_block *acc_b = acc_text->first_block;
        for (fz_stext_block *b = p->text->first_block; b; b = b->next) {
            if (b->type != FZ_STEXT_BLOCK_TEXT) continue;
            while (acc_b && acc_b->type != FZ_STEXT_BLOCK_TEXT) {
                acc_b = acc_b->next;
            }
            if (!acc_b) break;

            fz_stext_line *acc_l = acc_b->u.t.first_line;
            for (fz_stext_line *l = b->u.t.first_line; l; l = l->next) {
                if (!acc_l) break;

                fz_stext_char *acc_c = acc_l->first_char;
                for (fz_stext_char *c = l->first_char; c; c = c->next) {
                    fz_stext_char *matched_acc = NULL;
                    if (acc_c && acc_c->c == c->c) {
                        matched_acc = acc_c;
                        acc_c = acc_c->next;
                    } else if (acc_c) {
                        fz_stext_char *scan = acc_c->next;
                        for (int k = 0; scan && k < 4; k++, scan = scan->next) {
                            if (scan->c == c->c) {
                                matched_acc = scan;
                                acc_c = scan->next;
                                break;
                            }
                        }
                    }

                    if (matched_acc) {
                        c->quad = adapt_quad(&c->quad, &matched_acc->quad, matched_acc->flags, acc_l->dir, c->size);
                    }
                }
                acc_l = acc_l->next;
            }
            acc_b = acc_b->next;
        }
    }
    fz_always(d->ctx) {
        if (acc_text) fz_drop_stext_page(d->ctx, acc_text);
    }
    fz_catch(d->ctx) {
        /* Non-fatal: keep unadapted metrics on failure */
    }
}

static ll_page *get_page(ll_doc *d, int number) {
    return get_page_internal(d, number, NULL, 0);
}

static fz_stext_page *get_text(ll_doc *d, int number) {
    ll_page *p = get_page(d, number);
    if (!p->text) {
        p->text = fz_new_stext_page_from_display_list(d->ctx, p->list, NULL);
        adapt_stext_page(d, p);
        ++d->stats.text_builds;
    }
    return p->text;
}

static ll_quad quad_out(fz_quad q) {
    ll_quad out = {{q.ul.x, q.ul.y, q.ur.x, q.ur.y,
                    q.ll.x, q.ll.y, q.lr.x, q.lr.y}};
    return out;
}

static uint32_t g_max_store_mb = 256;

void ll_set_max_store_mb(uint32_t max_mb) {
    if (max_mb < 32) max_mb = 32;
    if (max_mb > 1024) max_mb = 1024;
    g_max_store_mb = max_mb;
}

uint32_t ll_get_max_store_mb(void) {
    return g_max_store_mb;
}

ll_doc *ll_open(const char *path, const char *password, char *error, size_t n) {
    ll_doc *d = calloc(1, sizeof(*d));
    fz_var(d);
    if (!d) {
        if (n) snprintf(error, n, "Allocation failed");
        return NULL;
    }
    for (int i = 0; i < CACHE_PAGES; ++i) d->pages[i].page = -1;

    size_t store_bytes = ((size_t)g_max_store_mb) * 1024 * 1024;
    d->ctx = fz_new_context(NULL, NULL, store_bytes);
    if (!d->ctx) {
        free(d);
        if (n) snprintf(error, n, "Context allocation failed");
        return NULL;
    }

    fz_try(d->ctx) {
        fz_register_document_handlers(d->ctx);
        d->document = fz_open_document(d->ctx, path);
        if (fz_needs_password(d->ctx, d->document) &&
            !fz_authenticate_password(d->ctx, d->document, password ? password : ""))
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Password required or incorrect");
        d->count = fz_count_pages(d->ctx, d->document);
    }
    fz_catch(d->ctx) {
        if (n) snprintf(error, n, "%s", fz_caught_message(d->ctx));
        ll_close(d);
        return NULL;
    }
    return d;
}

void ll_close(ll_doc *d) {
    if (!d) return;
    for (int i = 0; i < CACHE_PAGES; ++i) drop_page(d, &d->pages[i]);
    if (d->ctx) {
        fz_drop_document(d->ctx, d->document);
        fz_drop_context(d->ctx);
    }
    free(d);
}

int ll_page_count(ll_doc *d) {
    return d ? d->count : 0;
}

const char *ll_error(ll_doc *d) {
    return d ? d->error : "Invalid document";
}

char *ll_metadata(ll_doc *d, const char *key) {
    if (!d || !key) return NULL;
    clear_error(d);
    char *out = NULL;
    fz_var(out);
    fz_try(d->ctx) {
        int needed = fz_lookup_metadata(d->ctx, d->document, key, NULL, 0);
        if (needed >= 1) {
            out = malloc((size_t)needed);
            if (!out) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
            if (fz_lookup_metadata(d->ctx, d->document, key, out, (size_t)needed) < 0) {
                free(out);
                out = NULL;
            }
        }
    }
    fz_catch(d->ctx) {
        caught(d);
        free(out);
        out = NULL;
    }
    return out;
}

void ll_free_string(char *value) {
    free(value);
}

#define LL_MAX_OUTLINE_DEPTH 64
#define LL_MAX_OUTLINE_ITEMS 20000

static int outline_count_bounded(const fz_outline *node, int level, int *total) {
    if (!node || level >= LL_MAX_OUTLINE_DEPTH || *total >= LL_MAX_OUTLINE_ITEMS) return 0;
    int count = 0;
    for (const fz_outline *it = node; it; it = it->next) {
        if (*total >= LL_MAX_OUTLINE_ITEMS) break;
        ++count;
        ++(*total);
        if (it->down && level + 1 < LL_MAX_OUTLINE_DEPTH) {
            count += outline_count_bounded(it->down, level + 1, total);
        }
    }
    return count;
}

static void outline_fill(ll_doc *d, const fz_outline *node, int level,
                         ll_outline_item *items, int *offset, int capacity) {
    if (!node || level >= LL_MAX_OUTLINE_DEPTH) return;
    for (const fz_outline *it = node; it; it = it->next) {
        if (*offset >= capacity) break;
        ll_outline_item *dst = &items[(*offset)++];
        const char *title = it->title ? it->title : "";
        size_t n = strlen(title) + 1;
        dst->title = malloc(n);
        if (!dst->title) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
        memcpy(dst->title, title, n);
        dst->level = level;
        dst->page = -1;
        if (it->page.chapter >= 0 && it->page.page >= 0)
            dst->page = fz_page_number_from_location(d->ctx, d->document, it->page);
        if (it->down && level + 1 < LL_MAX_OUTLINE_DEPTH && *offset < capacity)
            outline_fill(d, it->down, level + 1, items, offset, capacity);
    }
}

int ll_get_outline(ll_doc *d, ll_outline *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));
    fz_outline *root = NULL;
    int filled = 0;
    fz_var(root);
    fz_var(filled);
    fz_try(d->ctx) {
        root = fz_load_outline(d->ctx, d->document);
        int total_seen = 0;
        int count = outline_count_bounded(root, 0, &total_seen);
        if (count > 0) {
            out->items = calloc((size_t)count, sizeof(ll_outline_item));
            if (!out->items) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
            outline_fill(d, root, 0, out->items, &filled, count);
            out->count = filled;
        }
    }
    fz_always(d->ctx) {
        fz_drop_outline(d->ctx, root);
    }
    fz_catch(d->ctx) {
        caught(d);
        out->count = filled;
        ll_free_outline(out);
        return LL_ERROR;
    }
    return LL_OK;
}

void ll_free_outline(ll_outline *out) {
    if (!out) return;
    for (int i = 0; i < out->count; ++i) free(out->items[i].title);
    free(out->items);
    memset(out, 0, sizeof(*out));
}

ll_stats ll_get_stats(ll_doc *d) {
    ll_stats zero = {0, 0, 0};
    return d ? d->stats : zero;
}

int ll_page_bounds(ll_doc *d, int number, float bounds[4]) {
    if (!d || !bounds) return LL_ERROR;
    clear_error(d);
    fz_page *page = NULL;
    fz_var(page);
    fz_try(d->ctx) {
        if (number < 0 || number >= d->count)
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Page index out of range");
        page = fz_load_page(d->ctx, d->document, number);
        fz_rect r = fz_bound_page(d->ctx, page);
        bounds[0] = r.x0;
        bounds[1] = r.y0;
        bounds[2] = r.x1;
        bounds[3] = r.y1;
    }
    fz_always(d->ctx) {
        fz_drop_page(d->ctx, page);
    }
    fz_catch(d->ctx) {
        caught(d);
        return LL_ERROR;
    }
    return LL_OK;
}

int ll_page_bounds_many(ll_doc *d, int start_page, int count, float *bounds4) {
    if (!d || !bounds4 || count < 0) return LL_ERROR;
    if (count == 0) return 0;
    clear_error(d);

    fz_page *page = NULL;
    int written = 0;
    int first = start_page;
    int requested = count;
    fz_var(page);
    fz_var(written);
    fz_var(first);
    fz_var(requested);
    fz_try(d->ctx) {
        if (first < 0 || first >= d->count)
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Start page out of range");
        int end = first + (requested > d->count - first ? d->count - first : requested);
        for (int i = first; i < end; ++i) {
            page = fz_load_page(d->ctx, d->document, i);
            fz_rect r = fz_bound_page(d->ctx, page);
            fz_drop_page(d->ctx, page);
            page = NULL;
            float *dst = bounds4 + (size_t)written * 4;
            dst[0] = r.x0;
            dst[1] = r.y0;
            dst[2] = r.x1;
            dst[3] = r.y1;
            ++written;
        }
    }
    fz_always(d->ctx) {
        fz_drop_page(d->ctx, page);
    }
    fz_catch(d->ctx) {
        caught(d);
        return LL_ERROR;
    }
    return written;
}

ll_cancel *ll_cancel_new(void) {
    return calloc(1, sizeof(ll_cancel));
}

void ll_cancel_abort(ll_cancel *cancel) {
    if (cancel) cancel->cookie.abort = 1;
}

int ll_cancel_is_aborted(ll_cancel *cancel) {
    return (cancel && cancel->cookie.abort) ? 1 : 0;
}

void ll_cancel_free(ll_cancel *cancel) {
    free(cancel);
}

int ll_render_priority(ll_doc *d, int number, float scale, float rotation,
                      const float *clip, ll_cancel *cancel, int priority, ll_image *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));

    fz_pixmap *pix = NULL;
    fz_device *dev = NULL;
    int was_cancelled = 0;
    fz_var(pix);
    fz_var(dev);
    fz_var(was_cancelled);

    fz_try(d->ctx) {
        if (!ll_isfinite(scale) || scale <= 0 || !ll_isfinite(rotation))
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Invalid render transform");
        if (cancel && cancel->cookie.abort) {
            was_cancelled = 1;
        } else {
            uint64_t t_list_start = ll_now_us();
            int list_hit = 0;
            ll_page *page = get_page_internal(d, number, &list_hit, priority);
            uint64_t list_time_us = ll_now_us() - t_list_start;

            fz_matrix m = fz_concat(fz_rotate(rotation), fz_scale(scale, scale));
            fz_rect box = fz_transform_rect(page->bounds, m);
            m = fz_concat(m, fz_translate(-box.x0, -box.y0));
            box = fz_transform_rect(page->bounds, m);
            if (clip) {
                for (int i = 0; i < 4; ++i)
                    if (!ll_isfinite(clip[i]))
                        fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Invalid render clip");
                box = fz_intersect_rect(box, (fz_rect){clip[0], clip[1], clip[2], clip[3]});
            }
            /* Check before fz_round_rect and the pixmap allocation. A corrupt
             * MediaBox or extreme zoom must not allocate an unbounded bitmap. */
            double box_width = (double)box.x1 - (double)box.x0;
            double box_height = (double)box.y1 - (double)box.y0;
            if (!ll_isfinite(box.x0) || !ll_isfinite(box.y0) ||
                !ll_isfinite(box.x1) || !ll_isfinite(box.y1) ||
                box.x0 < -INT_MAX / 4 || box.y0 < -INT_MAX / 4 ||
                box.x1 > INT_MAX / 4 || box.y1 > INT_MAX / 4 ||
                !ll_isfinite(box_width) || !ll_isfinite(box_height) ||
                box_width <= 0 || box_height <= 0 ||
                box_width > LL_MAX_RENDER_EDGE || box_height > LL_MAX_RENDER_EDGE ||
                box_width * box_height > LL_MAX_RENDER_PIXELS)
                fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Render region exceeds pixel budget");
            fz_irect bbox = fz_round_rect(box);
            int width = bbox.x1 - bbox.x0;
            int height = bbox.y1 - bbox.y0;
            if (width <= 0 || height <= 0)
                fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Empty render region");
            if (width > LL_MAX_RENDER_EDGE || height > LL_MAX_RENDER_EDGE ||
                (size_t)width * (size_t)height > LL_MAX_RENDER_PIXELS ||
                width > INT_MAX / 4)
                fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Render region exceeds pixel budget");

            pix = fz_new_pixmap_with_bbox(d->ctx, fz_device_rgb(d->ctx), bbox, NULL, 1);
            fz_clear_pixmap_with_value(d->ctx, pix, 255);

            uint64_t t_raster_start = ll_now_us();
            dev = fz_new_draw_device(d->ctx, fz_identity, pix);
            fz_run_display_list(d->ctx, page->list, dev, m, box,
                                cancel ? &cancel->cookie : NULL);
            fz_close_device(d->ctx, dev);
            uint64_t raster_time_us = ll_now_us() - t_raster_start;

            if (cancel && cancel->cookie.abort) {
                was_cancelled = 1;
            } else {
                uint64_t t_pixmap_start = ll_now_us();
                out->width = fz_pixmap_width(d->ctx, pix);
                out->height = fz_pixmap_height(d->ctx, pix);
                out->stride = out->width * 4;
                out->x = bbox.x0;
                out->y = bbox.y0;
                out->length = (size_t)out->stride * (size_t)out->height;
                unsigned char *src = fz_pixmap_samples(d->ctx, pix);
                int stride = fz_pixmap_stride(d->ctx, pix);
                if (!src || stride < out->stride)
                    fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Invalid pixmap storage");
                if (stride == out->stride) {
                    /* Keep the pixmap alive through Rust packet assembly.
                     * This removes a full-page C malloc and pixel copy. */
                    out->samples = src;
                    out->pixmap_owner = pix;
                    pix = NULL;
                } else {
                    out->samples = malloc(out->length);
                    if (!out->samples)
                        fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
                    for (int y = 0; y < out->height; ++y)
                        memcpy(out->samples + (size_t)y * (size_t)out->stride,
                               src + (size_t)y * (size_t)stride,
                               (size_t)out->stride);
                }
                float matrix[6] = {m.a, m.b, m.c, m.d, m.e, m.f};
                memcpy(out->matrix, matrix, sizeof(matrix));
                uint64_t pixmap_time_us = ll_now_us() - t_pixmap_start;

                d->last_render_timings.list_time_us = list_time_us;
                d->last_render_timings.raster_time_us = raster_time_us;
                d->last_render_timings.pixmap_time_us = pixmap_time_us;
                d->last_render_timings.list_hit = list_hit;
            }
        }
    }
    fz_always(d->ctx) {
        fz_drop_device(d->ctx, dev);
        fz_drop_pixmap(d->ctx, pix);
    }
    fz_catch(d->ctx) {
        caught(d);
        ll_free_image(d, out);
        return LL_ERROR;
    }

    if (was_cancelled) {
        ll_free_image(d, out);
        return LL_CANCELLED;
    }
    return LL_OK;
}

int ll_render(ll_doc *d, int number, float scale, float rotation,
              const float *clip, ll_cancel *cancel, ll_image *out) {
    return ll_render_priority(d, number, scale, rotation, clip, cancel, 0, out);
}

void ll_free_image(ll_doc *d, ll_image *out) {
    if (!out) return;
    if (out->pixmap_owner) {
        if (d) fz_drop_pixmap(d->ctx, (fz_pixmap *)out->pixmap_owner);
    } else {
        free(out->samples);
    }
    memset(out, 0, sizeof(*out));
}

int ll_get_text(ll_doc *d, int number, ll_text *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));
    fz_try(d->ctx) {
        fz_stext_page *text = get_text(d, number);
        int count = 0;
        for (fz_stext_block *b = text->first_block; b; b = b->next)
            if (b->type == FZ_STEXT_BLOCK_TEXT)
                for (fz_stext_line *l = b->u.t.first_line; l; l = l->next)
                    for (fz_stext_char *c = l->first_char; c; c = c->next) ++count;

        out->chars = malloc(sizeof(ll_char) * (size_t)(count ? count : 1));
        if (!out->chars)
            fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");

        int line = 0;
        for (fz_stext_block *b = text->first_block; b; b = b->next) {
            if (b->type != FZ_STEXT_BLOCK_TEXT) continue;
            for (fz_stext_line *l = b->u.t.first_line; l; l = l->next, ++line) {
                for (fz_stext_char *c = l->first_char; c; c = c->next) {
                    ll_char *ch = &out->chars[out->count++];
                    ch->codepoint = c->c;
                    ch->line = line;
                    ch->size = c->size;
                    ch->quad = quad_out(c->quad);
                }
            }
        }
    }
    fz_catch(d->ctx) {
        caught(d);
        ll_free_text(out);
        return LL_ERROR;
    }
    return LL_OK;
}

void ll_free_text(ll_text *out) {
    if (!out) return;
    free(out->chars);
    memset(out, 0, sizeof(*out));
}

static int select_impl(ll_doc *d, int number, float ax, float ay, float bx, float by,
                       int mode, ll_selection *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));

    fz_quad *quads = NULL;
    char *copy = NULL;
    fz_var(quads);
    fz_var(copy);
    fz_try(d->ctx) {
        if (mode < FZ_SELECT_CHARS || mode > FZ_SELECT_LINES)
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Invalid selection mode");
        fz_stext_page *text = get_text(d, number);
        int capacity = 1;
        for (fz_stext_block *blk = text->first_block; blk; blk = blk->next)
            if (blk->type == FZ_STEXT_BLOCK_TEXT)
                for (fz_stext_line *line = blk->u.t.first_line; line; line = line->next)
                    for (fz_stext_char *ch = line->first_char; ch; ch = ch->next) ++capacity;

        quads = fz_malloc_array(d->ctx, capacity, fz_quad);
        fz_point a = {ax, ay};
        fz_point b = {bx, by};
        (void)fz_snap_selection(d->ctx, text, &a, &b, mode);
        int count = fz_highlight_selection(d->ctx, text, a, b, quads, capacity);
        copy = fz_copy_selection(d->ctx, text, a, b, 0);

        out->text = malloc(strlen(copy) + 1);
        out->quads = malloc(sizeof(ll_quad) * (size_t)(count ? count : 1));
        if (!out->text || !out->quads)
            fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
        strcpy(out->text, copy);
        for (int i = 0; i < count; ++i) out->quads[i] = quad_out(quads[i]);
        out->count = count;
        out->a[0] = a.x;
        out->a[1] = a.y;
        out->b[0] = b.x;
        out->b[1] = b.y;
    }
    fz_always(d->ctx) {
        fz_free(d->ctx, quads);
        fz_free(d->ctx, copy);
    }
    fz_catch(d->ctx) {
        caught(d);
        ll_free_selection(out);
        return LL_ERROR;
    }
    return LL_OK;
}

int ll_select(ll_doc *d, int number, float ax, float ay, float bx, float by,
              ll_selection *out) {
    return select_impl(d, number, ax, ay, bx, by, FZ_SELECT_CHARS, out);
}

int ll_select_mode(ll_doc *d, int number, float ax, float ay, float bx, float by,
                   int mode, ll_selection *out) {
    return select_impl(d, number, ax, ay, bx, by, mode, out);
}

void ll_free_selection(ll_selection *out) {
    if (!out) return;
    free(out->text);
    free(out->quads);
    memset(out, 0, sizeof(*out));
}

int ll_get_links(ll_doc *d, int number, ll_links *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));
    if (number < 0 || number >= d->count) return LL_ERROR;

    fz_page *page = NULL;
    fz_link *links = NULL;
    fz_var(page);
    fz_var(links);

    fz_try(d->ctx) {
        page = fz_load_page(d->ctx, d->document, number);
        links = fz_load_links(d->ctx, page);

        int count = 0;
        for (fz_link *l = links; l; l = l->next) {
            count++;
        }
        out->count = count;
        if (count > 0) {
            out->items = calloc((size_t)count, sizeof(ll_link));
            if (!out->items) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");

            int idx = 0;
            for (fz_link *l = links; l; l = l->next, idx++) {
                out->items[idx].rect[0] = l->rect.x0;
                out->items[idx].rect[1] = l->rect.y0;
                out->items[idx].rect[2] = l->rect.x1;
                out->items[idx].rect[3] = l->rect.y1;
                out->items[idx].page = -1;
                if (l->uri) {
                    size_t ulen = strlen(l->uri);
                    out->items[idx].uri = malloc(ulen + 1);
                    if (out->items[idx].uri) {
                        memcpy(out->items[idx].uri, l->uri, ulen + 1);
                    }
                    if (!fz_is_external_link(d->ctx, l->uri)) {
                        float xp = 0, yp = 0;
                        fz_location loc = fz_resolve_link(d->ctx, d->document, l->uri, &xp, &yp);
                        if (loc.page >= 0) {
                            out->items[idx].page = fz_page_number_from_location(d->ctx, d->document, loc);
                        }
                    }
                }
            }
        }
    }
    fz_always(d->ctx) {
        if (links) fz_drop_link(d->ctx, links);
        if (page) fz_drop_page(d->ctx, page);
    }
    fz_catch(d->ctx) {
        caught(d);
        ll_free_links(out);
        return LL_ERROR;
    }
    return LL_OK;
}

void ll_free_links(ll_links *out) {
    if (!out) return;
    if (out->items) {
        for (int i = 0; i < out->count; i++) {
            if (out->items[i].uri) free(out->items[i].uri);
        }
        free(out->items);
    }
    memset(out, 0, sizeof(*out));
}

ll_render_timings ll_get_last_render_timings(ll_doc *d) {
    if (!d) {
        ll_render_timings zero = {0, 0, 0, 0};
        return zero;
    }
    return d->last_render_timings;
}

int ll_get_page_plain_text(ll_doc *d, int number, char **out_text) {
    if (!d || !out_text) return LL_ERROR;
    *out_text = NULL;
    clear_error(d);
    if (number < 0 || number >= d->count) return LL_ERROR;

    fz_buffer *buf = NULL;
    fz_output *out = NULL;
    fz_var(buf);
    fz_var(out);
    fz_try(d->ctx) {
        fz_stext_page *text = get_text(d, number);
        buf = fz_new_buffer(d->ctx, 1024);
        out = fz_new_output_with_buffer(d->ctx, buf);
        fz_print_stext_page_as_text(d->ctx, out, text);
        fz_close_output(d->ctx, out);
        const char *s = fz_string_from_buffer(d->ctx, buf);
        size_t len = strlen(s);
        char *copy = malloc(len + 1);
        if (!copy) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
        memcpy(copy, s, len + 1);
        *out_text = copy;
    }
    fz_always(d->ctx) {
        fz_drop_output(d->ctx, out);
        fz_drop_buffer(d->ctx, buf);
    }
    fz_catch(d->ctx) {
        caught(d);
        if (*out_text) {
            free(*out_text);
            *out_text = NULL;
        }
        return LL_ERROR;
    }
    return LL_OK;
}

int ll_export_annotated_pdf(const char *input_path, const char *output_path,
                           const char *password,
                           const ll_export_annot *annots, int annot_count) {
    if (!input_path || !output_path) return LL_ERROR;

    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_UNLIMITED);
    if (!ctx) return LL_ERROR;
    fz_register_document_handlers(ctx);

    pdf_document *pdf = NULL;
    fz_var(pdf);

    fz_try(ctx) {
        pdf = pdf_open_document(ctx, input_path);
        if (!pdf) fz_throw(ctx, FZ_ERROR_SYSTEM, "Cannot open PDF document");

        if (password && password[0]) {
            if (pdf_needs_password(ctx, pdf)) {
                if (!pdf_authenticate_password(ctx, pdf, password)) {
                    fz_throw(ctx, FZ_ERROR_GENERIC, "Invalid PDF password");
                }
            }
        }

        int total_pages = pdf_count_pages(ctx, pdf);

        for (int p = 0; p < total_pages; p++) {
            int page_annot_count = 0;
            for (int i = 0; i < annot_count; i++) {
                if (annots[i].page == p) page_annot_count++;
            }
            if (page_annot_count == 0) continue;

            pdf_page *page = pdf_load_page(ctx, pdf, p);
            if (!page) continue;

            for (int i = 0; i < annot_count; i++) {
                const ll_export_annot *ea = &annots[i];
                if (ea->page != p) continue;

                enum pdf_annot_type atype = PDF_ANNOT_HIGHLIGHT;
                switch (ea->type) {
                    case 0: atype = PDF_ANNOT_HIGHLIGHT; break;
                    case 1: atype = PDF_ANNOT_UNDERLINE; break;
                    case 2: atype = PDF_ANNOT_STRIKE_OUT; break;
                    case 3: atype = PDF_ANNOT_TEXT; break;
                    case 4: atype = PDF_ANNOT_INK; break;
                    default: atype = PDF_ANNOT_HIGHLIGHT; break;
                }

                pdf_annot *annot = pdf_create_annot(ctx, page, atype);
                if (!annot) continue;

                fz_rect r = { ea->rect[0], ea->rect[1], ea->rect[2], ea->rect[3] };
                pdf_set_annot_rect(ctx, annot, r);
                pdf_set_annot_color(ctx, annot, 3, ea->color);
                if (ea->opacity > 0.0f) {
                    pdf_set_annot_opacity(ctx, annot, ea->opacity);
                }
                if (ea->text && ea->text[0]) {
                    pdf_set_annot_contents(ctx, annot, ea->text);
                }
                if (ea->author && ea->author[0]) {
                    pdf_set_annot_author(ctx, annot, ea->author);
                }

                if ((ea->type == 0 || ea->type == 1 || ea->type == 2) && ea->quads && ea->quad_count > 0) {
                    fz_quad *qv = malloc(sizeof(fz_quad) * (size_t)ea->quad_count);
                    if (qv) {
                        for (int q = 0; q < ea->quad_count; q++) {
                            qv[q].ul.x = ea->quads[q * 8 + 0];
                            qv[q].ul.y = ea->quads[q * 8 + 1];
                            qv[q].ur.x = ea->quads[q * 8 + 2];
                            qv[q].ur.y = ea->quads[q * 8 + 3];
                            qv[q].ll.x = ea->quads[q * 8 + 4];
                            qv[q].ll.y = ea->quads[q * 8 + 5];
                            qv[q].lr.x = ea->quads[q * 8 + 6];
                            qv[q].lr.y = ea->quads[q * 8 + 7];
                        }
                        pdf_set_annot_quad_points(ctx, annot, ea->quad_count, qv);
                        free(qv);
                    }
                }

                if (ea->type == 4 && ea->stroke_counts && ea->stroke_points && ea->stroke_count > 0) {
                    pdf_set_annot_ink_list(ctx, annot, ea->stroke_count, ea->stroke_counts,
                                           (const fz_point *)ea->stroke_points);
                    if (ea->width > 0.0f) {
                        pdf_set_annot_border(ctx, annot, ea->width);
                    }
                }

                pdf_update_annot(ctx, annot);
                pdf_drop_annot(ctx, annot);
            }

            pdf_update_page(ctx, page);
            pdf_drop_page(ctx, page);
        }

        pdf_save_document(ctx, pdf, output_path, &pdf_default_write_options);
    }
    fz_always(ctx) {
        if (pdf) pdf_drop_document(ctx, pdf);
        fz_drop_context(ctx);
    }
    fz_catch(ctx) {
        return LL_ERROR;
    }
    return LL_OK;
}


