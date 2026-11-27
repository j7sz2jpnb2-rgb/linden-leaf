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
#include <intrin.h>
#define ll_isfinite(value) _finite((double)(value))
#else
#define ll_isfinite(value) isfinite(value)
#endif

static inline void ll_atomic_store_abort(int *abort_flag, int val) {
#if defined(_MSC_VER)
    _InterlockedExchange((volatile long *)abort_flag, (long)val);
#else
    __atomic_store_n(abort_flag, val, __ATOMIC_RELEASE);
#endif
}

static inline int ll_atomic_load_abort(const int *abort_flag) {
#if defined(_MSC_VER)
    return (int)_InterlockedCompareExchange((volatile long *)abort_flag, 0, 0);
#else
    return __atomic_load_n(abort_flag, __ATOMIC_ACQUIRE);
#endif
}

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

static uint64_t ll_now_us(void) {
    LARGE_INTEGER freq, counter;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&counter);
    uint64_t ticks = (uint64_t)counter.QuadPart;
    uint64_t rate = (uint64_t)freq.QuadPart;
    return (ticks / rate) * 1000000 + ((ticks % rate) * 1000000) / rate;
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
 * pages while zooming, reversing, or reading dual spreads (zero pixel retention). */
#define CACHE_PAGES 12
#define LL_MAX_RENDER_EDGE 4096
#define LL_MAX_RENDER_PIXELS 10000000

typedef struct {
    int page;
    uint64_t used;
    fz_rect bounds;
    fz_display_list *list;
    fz_stext_page *text;
    int text_adapted;
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
#ifdef _WIN32
    int parallel;
    CRITICAL_SECTION locks[FZ_LOCK_MAX];
#endif
};

typedef struct {
    fz_display_list *list;
    fz_matrix matrix;
    fz_rect box;
    fz_irect bbox;
    ll_render_timings timings;
} ll_render_plan;

struct ll_render_job {
    fz_context *ctx;
    ll_render_plan plan;
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

static ll_page *get_page_internal(ll_doc *d, int number, int *hit, int priority, ll_cancel *cancel) {
    (void)priority;
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

    if (ll_cancel_is_aborted(cancel))
        return NULL;

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
    fz_device *list_dev = NULL;
    fz_var(page);
    fz_var(list_dev);
    fz_var(entry);
    fz_try(d->ctx) {
        page = fz_load_page(d->ctx, d->document, number);
        entry->bounds = fz_bound_page(d->ctx, page);
        entry->list = fz_new_display_list(d->ctx, entry->bounds);
        list_dev = fz_new_list_device(d->ctx, entry->list);
        fz_run_page(d->ctx, page, list_dev, fz_identity,
                    cancel ? &cancel->cookie : NULL);
        fz_close_device(d->ctx, list_dev);
    }
    fz_always(d->ctx) {
        fz_drop_device(d->ctx, list_dev);
        fz_drop_page(d->ctx, page);
    }
    fz_catch(d->ctx) {
        drop_page(d, entry);
        fz_rethrow(d->ctx);
    }
    if (ll_cancel_is_aborted(cancel)) {
        drop_page(d, entry);
        return NULL;
    }
    entry->page = number;
    entry->used = ++d->clock;
    ++d->stats.list_builds;
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
                          int flags, fz_point dir, float font_size, int is_substitute) {
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
    /* A missing CJK font can give accurate-bboxes the substitute font's global
     * 2.858-em box instead of this glyph's ink bounds. The PDF-sized default
     * box remains correct. Do not union that anomalous substitute outline into
     * it; embedded fonts, normal outlines and invisible OCR keep their rules. */
    if (is_substitute && font_size > 0.001f && rh > 0.001f &&
        rh <= font_size * 1.6f && ih > font_size * 2.0f) {
        float center = (i_v[0] + i_v[1]) * 0.5f;
        i_v[0] = center - font_size * 0.6f;
        i_v[1] = center + font_size * 0.6f;
    }
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
        if (acc_text) {
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
                            c->quad = adapt_quad(&c->quad, &matched_acc->quad, matched_acc->flags, acc_l->dir, c->size,
                                c->font && fz_font_flags(c->font)->ft_substitute);
                        }
                    }
                    acc_l = acc_l->next;
                }
                acc_b = acc_b->next;
            }
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
    return get_page_internal(d, number, NULL, 0, NULL);
}

static fz_stext_page *get_plain_text(ll_doc *d, int number) {
    ll_page *p = get_page(d, number);
    if (!p->text) {
        p->text = fz_new_stext_page_from_display_list(d->ctx, p->list, NULL);
        ++d->stats.text_builds;
    }
    return p->text;
}

static fz_stext_page *get_text(ll_doc *d, int number) {
    fz_stext_page *text = get_plain_text(d, number);
    ll_page *p = get_page(d, number);
    if (!p->text_adapted) {
        adapt_stext_page(d, p);
        p->text_adapted = 1;
    }
    return text;
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
    return ll_open_with_options(path, password, error, n, g_max_store_mb, 0);
}

#ifdef _WIN32
static void ll_lock(void *user, int lock) {
    EnterCriticalSection(&((ll_doc *)user)->locks[lock]);
}

static void ll_unlock(void *user, int lock) {
    LeaveCriticalSection(&((ll_doc *)user)->locks[lock]);
}
#endif

ll_doc *ll_open_with_options(const char *path, const char *password, char *error, size_t n,
                             uint32_t max_store_mb, int parallel) {
    ll_doc *d = calloc(1, sizeof(*d));
    fz_var(d);
    if (!d) {
        if (n) snprintf(error, n, "Allocation failed");
        return NULL;
    }
    for (int i = 0; i < CACHE_PAGES; ++i) d->pages[i].page = -1;

    size_t store_bytes = ((size_t)max_store_mb) * 1024 * 1024;
    const fz_locks_context *locks = NULL;
#ifdef _WIN32
    fz_locks_context callbacks = {d, ll_lock, ll_unlock};
    if (parallel) {
        for (int i = 0; i < FZ_LOCK_MAX; ++i) InitializeCriticalSection(&d->locks[i]);
        d->parallel = 1;
        locks = &callbacks;
    }
#else
    (void)parallel;
#endif
    d->ctx = fz_new_context(NULL, locks, store_bytes);
    if (!d->ctx) {
        ll_close(d);
        if (n) snprintf(error, n, "Context allocation failed");
        return NULL;
    }

    fz_try(d->ctx) {
        /* Restrict native open to PDF rather than registering HTML/EPUB/SVG handlers. */
        d->document = (fz_document *)pdf_open_document(d->ctx, path);
        if (!d->document) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Cannot open PDF document");
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
    if (d->ctx) {
        for (int i = 0; i < CACHE_PAGES; ++i) drop_page(d, &d->pages[i]);
        fz_drop_document(d->ctx, d->document);
        fz_drop_context(d->ctx);
    }
#ifdef _WIN32
    if (d->parallel) {
        for (int i = 0; i < FZ_LOCK_MAX; ++i) DeleteCriticalSection(&d->locks[i]);
    }
#endif
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
    if (cancel) ll_atomic_store_abort(&cancel->cookie.abort, 1);
}

int ll_cancel_is_aborted(ll_cancel *cancel) {
    return (cancel && ll_atomic_load_abort(&cancel->cookie.abort)) ? 1 : 0;
}

void ll_cancel_free(ll_cancel *cancel) {
    free(cancel);
}

static int prepare_render(ll_doc *d, int number, float scale, float rotation,
                          const float *clip, ll_cancel *cancel, int priority, ll_render_plan *plan) {
    if (ll_cancel_is_aborted(cancel)) return LL_CANCELLED;
    clear_error(d);
    memset(plan, 0, sizeof(*plan));
    int cancelled = 0;
    fz_var(cancelled);
    fz_try(d->ctx) {
        if (!ll_isfinite(scale) || scale <= 0 || !ll_isfinite(rotation))
            fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Invalid render transform");

        uint64_t list_start = ll_now_us();
        ll_page *page = get_page_internal(d, number, &plan->timings.list_hit, priority, cancel);
        plan->timings.list_time_us = ll_now_us() - list_start;
        if (!page || ll_cancel_is_aborted(cancel)) {
            cancelled = 1;
        } else {
            plan->list = page->list;

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
            /* Bound coordinates before rounding or allocating the pixmap. */
            double box_width = (double)box.x1 - (double)box.x0;
            double box_height = (double)box.y1 - (double)box.y0;
            if (!ll_isfinite(box.x0) || !ll_isfinite(box.y0) ||
                !ll_isfinite(box.x1) || !ll_isfinite(box.y1) ||
                (double)box.x0 < -INT_MAX / 4.0 || (double)box.y0 < -INT_MAX / 4.0 ||
                (double)box.x1 > INT_MAX / 4.0 || (double)box.y1 > INT_MAX / 4.0 ||
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
                (size_t)width * (size_t)height > LL_MAX_RENDER_PIXELS || width > INT_MAX / 4)
                fz_throw(d->ctx, FZ_ERROR_ARGUMENT, "Render region exceeds pixel budget");
            plan->matrix = m;
            plan->box = box;
            plan->bbox = bbox;
        }
    }
    fz_catch(d->ctx) {
        caught(d);
        return LL_ERROR;
    }
    if (cancelled || ll_cancel_is_aborted(cancel)) return LL_CANCELLED;
    return LL_OK;
}

static void free_image(fz_context *ctx, ll_image *out) {
    if (!out) return;
    if (out->pixmap_owner) {
        if (ctx) fz_drop_pixmap(ctx, (fz_pixmap *)out->pixmap_owner);
    } else {
        free(out->samples);
    }
    memset(out, 0, sizeof(*out));
}

static int rasterize(fz_context *ctx, const ll_render_plan *plan, ll_cancel *cancel,
                     ll_image *out, ll_render_timings *timings, char *error, size_t n) {
    *timings = plan->timings;
    if (ll_cancel_is_aborted(cancel)) return LL_CANCELLED;

    fz_pixmap *pix = NULL;
    fz_device *dev = NULL;
    fz_var(pix);
    fz_var(dev);
    fz_try(ctx) {
        pix = fz_new_pixmap_with_bbox(ctx, fz_device_rgb(ctx), plan->bbox, NULL, 1);
        fz_clear_pixmap_with_value(ctx, pix, 255);

        uint64_t raster_start = ll_now_us();
        dev = fz_new_draw_device(ctx, fz_identity, pix);
        fz_run_display_list(ctx, plan->list, dev, plan->matrix, plan->box,
                            cancel ? &cancel->cookie : NULL);
        fz_close_device(ctx, dev);
        timings->raster_time_us = ll_now_us() - raster_start;

        if (!ll_cancel_is_aborted(cancel)) {
            uint64_t pixmap_start = ll_now_us();
            out->width = fz_pixmap_width(ctx, pix);
            out->height = fz_pixmap_height(ctx, pix);
            out->stride = out->width * 4;
            out->x = plan->bbox.x0;
            out->y = plan->bbox.y0;
            out->length = (size_t)out->stride * (size_t)out->height;
            unsigned char *src = fz_pixmap_samples(ctx, pix);
            int stride = fz_pixmap_stride(ctx, pix);
            if (!src || stride < out->stride)
                fz_throw(ctx, FZ_ERROR_SYSTEM, "Invalid pixmap storage");
            if (stride == out->stride) {
                /* Keep the pixmap alive through Rust packet assembly. */
                out->samples = src;
                out->pixmap_owner = pix;
                pix = NULL;
            } else {
                out->samples = malloc(out->length);
                if (!out->samples) fz_throw(ctx, FZ_ERROR_SYSTEM, "Allocation failed");
                for (int y = 0; y < out->height; ++y)
                    memcpy(out->samples + (size_t)y * (size_t)out->stride,
                           src + (size_t)y * (size_t)stride, (size_t)out->stride);
            }
            fz_matrix m = plan->matrix;
            float matrix[6] = {m.a, m.b, m.c, m.d, m.e, m.f};
            memcpy(out->matrix, matrix, sizeof(matrix));
            timings->pixmap_time_us = ll_now_us() - pixmap_start;
        }
    }
    fz_always(ctx) {
        fz_drop_device(ctx, dev);
        fz_drop_pixmap(ctx, pix);
    }
    fz_catch(ctx) {
        if (n) snprintf(error, n, "%s", fz_caught_message(ctx));
        free_image(ctx, out);
        return LL_ERROR;
    }

    if (ll_cancel_is_aborted(cancel)) {
        free_image(ctx, out);
        return LL_CANCELLED;
    }
    return LL_OK;
}

int ll_render_priority(ll_doc *d, int number, float scale, float rotation,
                       const float *clip, ll_cancel *cancel, int priority, ll_image *out) {
    if (!d || !out) return LL_ERROR;
    memset(out, 0, sizeof(*out));
    memset(&d->last_render_timings, 0, sizeof(d->last_render_timings));
    ll_render_plan plan;
    int status = prepare_render(d, number, scale, rotation, clip, cancel, priority, &plan);
    if (status != LL_OK) return status;
    return rasterize(d->ctx, &plan, cancel, out, &d->last_render_timings, d->error, sizeof(d->error));
}

int ll_render(ll_doc *d, int number, float scale, float rotation,
              const float *clip, ll_cancel *cancel, ll_image *out) {
    return ll_render_priority(d, number, scale, rotation, clip, cancel, 0, out);
}

void ll_free_image(ll_doc *d, ll_image *out) {
    free_image(d ? d->ctx : NULL, out);
}

#ifdef _WIN32
ll_render_job *ll_prepare_render_job(ll_doc *d, int number, float scale, float rotation,
                                    const float *clip, ll_cancel *cancel) {
    if (!d || !d->parallel) return NULL;
    ll_render_plan plan;
    if (prepare_render(d, number, scale, rotation, clip, cancel, 0, &plan) != LL_OK)
        return NULL;

    ll_render_job *job = malloc(sizeof(*job));
    if (!job) return NULL;
    job->ctx = fz_clone_context(d->ctx);
    if (!job->ctx) {
        free(job);
        return NULL;
    }
    job->plan = plan;
    job->plan.list = fz_keep_display_list(job->ctx, plan.list);
    return job;
}

int ll_run_render_job(ll_render_job *job, ll_cancel *cancel, ll_image *out,
                      ll_render_timings *timings, char *error, size_t n) {
    memset(out, 0, sizeof(*out));
    return rasterize(job->ctx, &job->plan, cancel, out, timings, error, n);
}

void ll_free_render_job(ll_render_job *job, ll_image *out) {
    free_image(job->ctx, out);
    fz_drop_display_list(job->ctx, job->plan.list);
    fz_drop_context(job->ctx);
    free(job);
}
#endif

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
        fz_stext_page *text = get_plain_text(d, number);
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
    if (!input_path || !output_path || annot_count < 0) return LL_ERROR;
    if (annot_count > 0 && !annots) return LL_ERROR;

    size_t store_bytes = ((size_t)ll_get_max_store_mb()) * 1024 * 1024;
    fz_context *ctx = fz_new_context(NULL, NULL, store_bytes);
    if (!ctx) return LL_ERROR;

    pdf_document *pdf = NULL;
    pdf_page *page = NULL;
    pdf_annot *annot = NULL;
    fz_quad *qv = NULL;
    fz_point *ink_pts = NULL;
    int *ink_counts = NULL;
    int result = LL_OK;
    fz_var(pdf);
    fz_var(page);
    fz_var(annot);
    fz_var(qv);
    fz_var(ink_pts);
    fz_var(ink_counts);
    fz_var(result);

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

            page = pdf_load_page(ctx, pdf, p);
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

                annot = pdf_create_annot(ctx, page, atype);
                if (!annot) continue;

                float rx0 = ea->rect[0], ry0 = ea->rect[1], rx1 = ea->rect[2], ry1 = ea->rect[3];
                fz_rect r = (ll_isfinite(rx0) && ll_isfinite(ry0) && ll_isfinite(rx1) && ll_isfinite(ry1))
                    ? fz_make_rect(rx0 < rx1 ? rx0 : rx1, ry0 < ry1 ? ry0 : ry1, rx0 > rx1 ? rx0 : rx1, ry0 > ry1 ? ry0 : ry1)
                    : fz_make_rect(0.0f, 0.0f, 100.0f, 100.0f);
                /* Text markup and ink derive their bounds from QuadPoints/InkList. */
                if (pdf_annot_has_rect(ctx, annot)) pdf_set_annot_rect(ctx, annot, r);
                pdf_set_annot_color(ctx, annot, 3, ea->color);
                if (ll_isfinite(ea->opacity)) {
                    float op = ea->opacity < 0.0f ? 0.0f : (ea->opacity > 1.0f ? 1.0f : ea->opacity);
                    pdf_set_annot_opacity(ctx, annot, op);
                }
                if (ea->text && ea->text[0]) {
                    pdf_set_annot_contents(ctx, annot, ea->text);
                }
                if (ea->author && ea->author[0]) {
                    pdf_set_annot_author(ctx, annot, ea->author);
                }

                if ((ea->type == 0 || ea->type == 1 || ea->type == 2) && ea->quads && ea->quad_count > 0) {
                    qv = malloc(sizeof(fz_quad) * (size_t)ea->quad_count);
                    if (qv) {
                        int valid_quads = 0;
                        for (int q = 0; q < ea->quad_count; q++) {
                            const float *qs = &ea->quads[q * 8];
                            int all_finite = 1;
                            for (int k = 0; k < 8; k++) {
                                if (!ll_isfinite(qs[k])) { all_finite = 0; break; }
                            }
                            if (!all_finite) continue;
                            float top_dx = qs[2] - qs[0], top_dy = qs[3] - qs[1];
                            float bot_dx = qs[6] - qs[4], bot_dy = qs[7] - qs[5];
                            float left_dx = qs[4] - qs[0], left_dy = qs[5] - qs[1];
                            if ((top_dx * top_dx + top_dy * top_dy) < 1e-6f &&
                                (bot_dx * bot_dx + bot_dy * bot_dy) < 1e-6f) continue;
                            if ((left_dx * left_dx + left_dy * left_dy) < 1e-6f) continue;
                            qv[valid_quads].ul.x = qs[0];
                            qv[valid_quads].ul.y = qs[1];
                            qv[valid_quads].ur.x = qs[2];
                            qv[valid_quads].ur.y = qs[3];
                            qv[valid_quads].ll.x = qs[4];
                            qv[valid_quads].ll.y = qs[5];
                            qv[valid_quads].lr.x = qs[6];
                            qv[valid_quads].lr.y = qs[7];
                            valid_quads++;
                        }
                        if (valid_quads > 0) {
                            pdf_set_annot_quad_points(ctx, annot, valid_quads, qv);
                        }
                        free(qv);
                        qv = NULL;
                    }
                }

                if (ea->type == 4 && ea->stroke_counts && ea->stroke_points && ea->stroke_count > 0) {
                    size_t total_pts = 0;
                    int valid_strokes = 0;
                    for (int s = 0; s < ea->stroke_count; s++) {
                        int c = ea->stroke_counts[s];
                        if (c > 0) {
                            total_pts += (size_t)(c == 1 ? 2 : c);
                            valid_strokes++;
                        }
                    }
                    if (valid_strokes > 0 && total_pts > 0) {
                        ink_counts = malloc(sizeof(int) * (size_t)valid_strokes);
                        ink_pts = malloc(sizeof(fz_point) * total_pts);
                        if (ink_counts && ink_pts) {
                            size_t src_off = 0;
                            size_t dst_off = 0;
                            int out_s = 0;
                            for (int s = 0; s < ea->stroke_count; s++) {
                                int c = ea->stroke_counts[s];
                                if (c <= 0) continue;
                                int stroke_valid_pts = 0;
                                size_t stroke_start = dst_off;
                                for (int k = 0; k < c; k++) {
                                    float px = ea->stroke_points[(src_off + (size_t)k) * 2 + 0];
                                    float py = ea->stroke_points[(src_off + (size_t)k) * 2 + 1];
                                    if (ll_isfinite(px) && ll_isfinite(py)) {
                                        ink_pts[dst_off++] = fz_make_point(px, py);
                                        stroke_valid_pts++;
                                    }
                                }
                                src_off += (size_t)c;
                                if (stroke_valid_pts == 1) {
                                    /* Ensure 1-point dots stroke a minimal segment for MuPDF appearance. */
                                    fz_point p0 = ink_pts[stroke_start];
                                    ink_pts[dst_off++] = fz_make_point(p0.x + 0.05f, p0.y);
                                    stroke_valid_pts = 2;
                                }
                                if (stroke_valid_pts >= 2) {
                                    ink_counts[out_s++] = stroke_valid_pts;
                                } else {
                                    dst_off = stroke_start;
                                }
                            }
                            if (out_s > 0) {
                                pdf_set_annot_ink_list(ctx, annot, out_s, ink_counts, ink_pts);
                            }
                        }
                        free(ink_counts);
                        ink_counts = NULL;
                        free(ink_pts);
                        ink_pts = NULL;
                    }
                    if (ll_isfinite(ea->width) && ea->width > 0.0f) {
                        pdf_set_annot_border(ctx, annot, ea->width);
                    }
                }

                pdf_update_annot(ctx, annot);
                pdf_drop_annot(ctx, annot);
                annot = NULL;
            }

            pdf_update_page(ctx, page);
            pdf_drop_page(ctx, page);
            page = NULL;
        }

        pdf_save_document(ctx, pdf, output_path, &pdf_default_write_options);
    }
    fz_always(ctx) {
        free(qv);
        free(ink_pts);
        free(ink_counts);
        if (annot) pdf_drop_annot(ctx, annot);
        if (page) pdf_drop_page(ctx, page);
        if (pdf) pdf_drop_document(ctx, pdf);
    }
    fz_catch(ctx) {
        result = LL_ERROR;
    }
    fz_drop_context(ctx);
    return result;
}

static char *ll_strdup_nonempty(const char *s) {
    if (!s || !s[0]) return NULL;
    size_t len = strlen(s);
    char *out = malloc(len + 1);
    if (!out) return NULL;
    memcpy(out, s, len + 1);
    return out;
}

static float ll_clamp01(float v) {
    if (!ll_isfinite(v)) return 0.0f;
    if (v < 0.0f) return 0.0f;
    if (v > 1.0f) return 1.0f;
    return v;
}

static void ll_extract_quote_for_quads(fz_context *ctx, fz_stext_page *stext,
                                       const ll_quad *quads, int quad_count, char **out_quote) {
    *out_quote = NULL;
    if (!ctx || !stext || !quads || quad_count <= 0) return;

    fz_buffer *buf = NULL;
    fz_var(buf);
    fz_try(ctx) {
        buf = fz_new_buffer(ctx, 256);
        int last_line = -1;
        int line_idx = 0;
        for (fz_stext_block *b = stext->first_block; b; b = b->next) {
            if (b->type != FZ_STEXT_BLOCK_TEXT) continue;
            for (fz_stext_line *l = b->u.t.first_line; l; l = l->next, ++line_idx) {
                int wrote_any_on_line = 0;
                for (fz_stext_char *c = l->first_char; c; c = c->next) {
                    float cx = (c->quad.ul.x + c->quad.lr.x) * 0.5f;
                    float cy = (c->quad.ul.y + c->quad.lr.y) * 0.5f;
                    int hit = 0;
                    for (int qi = 0; qi < quad_count; ++qi) {
                        const float *q = quads[qi].xy;
                        float qx0 = q[0], qx1 = q[0], qy0 = q[1], qy1 = q[1];
                        for (int k = 1; k < 4; ++k) {
                            float px = q[k * 2], py = q[k * 2 + 1];
                            if (px < qx0) qx0 = px;
                            if (px > qx1) qx1 = px;
                            if (py < qy0) qy0 = py;
                            if (py > qy1) qy1 = py;
                        }
                        if (cx >= qx0 - 1.5f && cx <= qx1 + 1.5f && cy >= qy0 - 1.5f && cy <= qy1 + 1.5f) {
                            hit = 1;
                            break;
                        }
                    }
                    if (!hit) continue;
                    if (!wrote_any_on_line && last_line >= 0 && last_line != line_idx) {
                        fz_append_byte(ctx, buf, ' ');
                    }
                    wrote_any_on_line = 1;
                    last_line = line_idx;
                    fz_append_rune(ctx, buf, c->c);
                }
            }
        }
        const char *str = fz_string_from_buffer(ctx, buf);
        *out_quote = ll_strdup_nonempty(str);
    }
    fz_always(ctx) {
        fz_drop_buffer(ctx, buf);
    }
    fz_catch(ctx) {
        free(*out_quote);
        *out_quote = NULL;
    }
}

int ll_extract_pdf_annots(ll_doc *d, int max_annots, ll_pdf_annot_list *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));
    if (max_annots <= 0) max_annots = 2000;

    pdf_document *pdf = pdf_specifics(d->ctx, d->document);
    if (!pdf) return LL_OK;

    int cap = 32;
    ll_pdf_annot *items = calloc((size_t)cap, sizeof(ll_pdf_annot));
    if (!items) {
        snprintf(d->error, sizeof(d->error), "Allocation failed");
        return LL_ERROR;
    }
    int count = 0;
    pdf_page *ppage = NULL;
    fz_var(ppage);
    fz_var(items);
    fz_var(cap);
    fz_var(count);

    fz_try(d->ctx) {
        int total_pages = pdf_count_pages(d->ctx, pdf);
        if (d->count < total_pages) total_pages = d->count;
        for (int p = 0; p < total_pages && count < max_annots; ++p) {
            ppage = pdf_load_page(d->ctx, pdf, p);
            if (!ppage) continue;

            pdf_annot *first_a = pdf_first_annot(d->ctx, ppage);
            if (!first_a) {
                pdf_drop_page(d->ctx, ppage);
                ppage = NULL;
                continue;
            }

            fz_rect pbounds = fz_bound_page(d->ctx, (fz_page *)ppage);
            float bw = pbounds.x1 - pbounds.x0;
            float bh = pbounds.y1 - pbounds.y0;
            if (bw < 1e-3f) bw = 1.0f;
            if (bh < 1e-3f) bh = 1.0f;
            fz_stext_page *stext = NULL;

            for (pdf_annot *a = first_a; a && count < max_annots; a = pdf_next_annot(d->ctx, a)) {
                enum pdf_annot_type raw_type = pdf_annot_type(d->ctx, a);
                int mapped_type = -1;
                switch (raw_type) {
                    case PDF_ANNOT_HIGHLIGHT: mapped_type = 0; break;
                    case PDF_ANNOT_UNDERLINE: mapped_type = 1; break;
                    case PDF_ANNOT_STRIKE_OUT: mapped_type = 2; break;
                    case PDF_ANNOT_SQUIGGLY: mapped_type = 3; break;
                    case PDF_ANNOT_TEXT: mapped_type = 4; break;
                    case PDF_ANNOT_FREE_TEXT: mapped_type = 5; break;
                    case PDF_ANNOT_INK: mapped_type = 6; break;
                    default: break;
                }
                if (mapped_type < 0) continue;

                if (count >= cap) {
                    int new_cap = cap * 2;
                    ll_pdf_annot *grown = realloc(items, sizeof(ll_pdf_annot) * (size_t)new_cap);
                    if (!grown) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
                    memset(grown + cap, 0, sizeof(ll_pdf_annot) * (size_t)(new_cap - cap));
                    items = grown;
                    cap = new_cap;
                }

                ll_pdf_annot *dst = &items[count];
                memset(dst, 0, sizeof(*dst));
                dst->page = p;
                dst->type = mapped_type;
                dst->page_bounds[0] = pbounds.x0;
                dst->page_bounds[1] = pbounds.y0;
                dst->page_bounds[2] = pbounds.x1;
                dst->page_bounds[3] = pbounds.y1;

                int cn = 0;
                float raw_col[4] = {0};
                pdf_annot_color(d->ctx, a, &cn, raw_col);
                if (cn == 1) {
                    dst->color[0] = raw_col[0];
                    dst->color[1] = raw_col[0];
                    dst->color[2] = raw_col[0];
                } else if (cn == 3) {
                    dst->color[0] = raw_col[0];
                    dst->color[1] = raw_col[1];
                    dst->color[2] = raw_col[2];
                } else if (cn == 4) {
                    float inv_k = 1.0f - raw_col[3];
                    dst->color[0] = (1.0f - raw_col[0]) * inv_k;
                    dst->color[1] = (1.0f - raw_col[1]) * inv_k;
                    dst->color[2] = (1.0f - raw_col[2]) * inv_k;
                } else {
                    dst->color[0] = 0.98f;
                    dst->color[1] = 0.80f;
                    dst->color[2] = 0.08f;
                }
                dst->opacity = ll_clamp01(pdf_annot_opacity(d->ctx, a));
                if (dst->opacity <= 0.0f) dst->opacity = 1.0f;

                if (pdf_annot_has_quad_points(d->ctx, a)) {
                    int qn = pdf_annot_quad_point_count(d->ctx, a);
                    if (qn > 512) qn = 512;
                    if (qn > 0) {
                        dst->quads = malloc(sizeof(ll_quad) * (size_t)qn);
                        if (dst->quads) {
                            for (int qi = 0; qi < qn; ++qi) {
                                fz_quad q = pdf_annot_quad_point(d->ctx, a, qi);
                                dst->quads[qi] = quad_out(q);
                            }
                            dst->quad_count = qn;
                            if (!stext) stext = get_plain_text(d, p);
                            if (stext) {
                                ll_extract_quote_for_quads(d->ctx, stext, dst->quads, qn, &dst->quote_text);
                            }
                        }
                    }
                }

                fz_rect ar = pdf_annot_has_rect(d->ctx, a)
                    ? pdf_annot_rect(d->ctx, a)
                    : pdf_bound_annot(d->ctx, a);
                if (fz_is_empty_rect(ar) && dst->quads && dst->quad_count > 0) {
                    ar = fz_empty_rect;
                    for (int qi = 0; qi < dst->quad_count; ++qi) {
                        for (int k = 0; k < 4; ++k) {
                            ar = fz_include_point_in_rect(ar, fz_make_point(dst->quads[qi].xy[k * 2], dst->quads[qi].xy[k * 2 + 1]));
                        }
                    }
                }
                dst->rect[0] = ll_clamp01((ar.x0 - pbounds.x0) / bw);
                dst->rect[1] = ll_clamp01((ar.y0 - pbounds.y0) / bh);
                dst->rect[2] = ll_clamp01((ar.x1 - pbounds.x0) / bw);
                dst->rect[3] = ll_clamp01((ar.y1 - pbounds.y0) / bh);

                dst->text = ll_strdup_nonempty(pdf_annot_contents(d->ctx, a));
                dst->author = pdf_annot_has_author(d->ctx, a)
                    ? ll_strdup_nonempty(pdf_annot_author(d->ctx, a))
                    : NULL;
                count++;
            }

            pdf_drop_page(d->ctx, ppage);
            ppage = NULL;
        }
    }
    fz_always(d->ctx) {
        if (ppage) pdf_drop_page(d->ctx, ppage);
    }
    fz_catch(d->ctx) {
        caught(d);
        out->items = items;
        out->count = count;
        ll_free_pdf_annots(out);
        return LL_ERROR;
    }

    out->items = items;
    out->count = count;
    return LL_OK;
}

void ll_free_pdf_annots(ll_pdf_annot_list *out) {
    if (!out) return;
    if (out->items) {
        for (int i = 0; i < out->count; ++i) {
            free(out->items[i].quads);
            free(out->items[i].text);
            free(out->items[i].author);
            free(out->items[i].quote_text);
        }
        free(out->items);
    }
    memset(out, 0, sizeof(*out));
}

static void ll_accumulate_crop(float cur_min[4], int *has_sample, const float sample[4]) {
    if (!*has_sample) {
        for (int i = 0; i < 4; ++i) cur_min[i] = sample[i];
        *has_sample = 1;
        return;
    }
    for (int i = 0; i < 4; ++i) {
        if (sample[i] < cur_min[i]) cur_min[i] = sample[i];
    }
}

static void ll_finalize_crop_margins(float out[4], const float raw_min[4], int has_sample) {
    if (!has_sample) {
        memset(out, 0, sizeof(float) * 4);
        return;
    }
    const float padding_pct = 1.5f;
    for (int i = 0; i < 4; ++i) {
        float val = raw_min[i] - padding_pct;
        if (val < 0.0f) val = 0.0f;
        if (val > 35.0f) val = 35.0f;
        out[i] = floorf(val * 2.0f + 0.5f) * 0.5f;
    }
}

int ll_compute_auto_crop(ll_doc *d, int max_samples,
                         float out_uniform[4], float out_odd[4], float out_even[4]) {
    if (!d || !out_uniform || !out_odd || !out_even) return LL_ERROR;
    clear_error(d);
    memset(out_uniform, 0, sizeof(float) * 4);
    memset(out_odd, 0, sizeof(float) * 4);
    memset(out_even, 0, sizeof(float) * 4);
    if (d->count <= 0) return LL_OK;

    if (max_samples <= 0) max_samples = 12;
    if (max_samples > 24) max_samples = 24;

    int start_idx = (d->count >= 4) ? 1 : 0;
    int span = d->count - start_idx;
    int actual_samples = (span < max_samples) ? span : max_samples;
    if (actual_samples <= 0) return LL_OK;

    float min_all[4] = {0}, min_odd[4] = {0}, min_even[4] = {0};
    int has_all = 0, has_odd = 0, has_even = 0;

    fz_pixmap *pix = NULL;
    fz_device *dev = NULL;
    fz_var(pix);
    fz_var(dev);

    fz_try(d->ctx) {
        for (int s = 0; s < actual_samples; ++s) {
            int p_idx = (actual_samples == 1)
                ? start_idx
                : start_idx + (int)(((int64_t)s * (span - 1)) / (actual_samples - 1));
            if (p_idx < 0) p_idx = 0;
            if (p_idx >= d->count) p_idx = d->count - 1;

            ll_page *page = get_page(d, p_idx);
            if (!page || !page->list) continue;
            float bw = page->bounds.x1 - page->bounds.x0;
            float bh = page->bounds.y1 - page->bounds.y0;
            if (bw < 10.0f || bh < 10.0f) continue;

            float max_edge = bw > bh ? bw : bh;
            float scale = 360.0f / max_edge;
            if (scale < 0.08f) scale = 0.08f;
            if (scale > 1.0f) scale = 1.0f;

            fz_matrix m = fz_scale(scale, scale);
            fz_rect tbox = fz_transform_rect(page->bounds, m);
            m = fz_concat(m, fz_translate(-tbox.x0, -tbox.y0));
            tbox = fz_transform_rect(page->bounds, m);
            fz_irect bbox = fz_round_rect(tbox);
            int w = bbox.x1 - bbox.x0;
            int h = bbox.y1 - bbox.y0;
            if (w < 16 || h < 16 || w > 600 || h > 600) continue;

            pix = fz_new_pixmap_with_bbox(d->ctx, fz_device_rgb(d->ctx), bbox, NULL, 0);
            fz_clear_pixmap_with_value(d->ctx, pix, 255);
            dev = fz_new_draw_device(d->ctx, fz_identity, pix);
            fz_run_display_list(d->ctx, page->list, dev, m, tbox, NULL);
            fz_close_device(d->ctx, dev);
            fz_drop_device(d->ctx, dev);
            dev = NULL;

            const unsigned char *samples = fz_pixmap_samples(d->ctx, pix);
            int stride = fz_pixmap_stride(d->ctx, pix);
            int min_x = w, max_x = -1, min_y = h, max_y = -1;
            int dark_pixels = 0;

            for (int y = 0; y < h; ++y) {
                const unsigned char *row = samples + (size_t)y * (size_t)stride;
                for (int x = 0; x < w; ++x) {
                    const unsigned char *px = row + x * 3;
                    int luma = (px[0] * 77 + px[1] * 150 + px[2] * 29) >> 8;
                    if (luma < 242) {
                        dark_pixels++;
                        if (x < min_x) min_x = x;
                        if (x > max_x) max_x = x;
                        if (y < min_y) min_y = y;
                        if (y > max_y) max_y = y;
                    }
                }
            }

            fz_drop_pixmap(d->ctx, pix);
            pix = NULL;

            if (dark_pixels * 1000 < w * h * 2) continue; /* blank or virtually empty page */
            /* Ignore full-bleed background images covering > 92% of page */
            if (dark_pixels * 100 > w * h * 92) continue;
            if (max_x < min_x || max_y < min_y) continue;

            float margins[4] = {
                (float)min_y * 100.0f / (float)h,             /* top */
                (float)(w - 1 - max_x) * 100.0f / (float)w,   /* right */
                (float)(h - 1 - max_y) * 100.0f / (float)h,   /* bottom */
                (float)min_x * 100.0f / (float)w              /* left */
            };
            ll_accumulate_crop(min_all, &has_all, margins);
            if (((p_idx + 1) % 2) == 1) {
                ll_accumulate_crop(min_odd, &has_odd, margins);
            } else {
                ll_accumulate_crop(min_even, &has_even, margins);
            }
        }
    }
    fz_always(d->ctx) {
        fz_drop_device(d->ctx, dev);
        fz_drop_pixmap(d->ctx, pix);
    }
    fz_catch(d->ctx) {
        caught(d);
        return LL_ERROR;
    }

    ll_finalize_crop_margins(out_uniform, min_all, has_all);
    if (has_odd) ll_finalize_crop_margins(out_odd, min_odd, 1);
    else memcpy(out_odd, out_uniform, sizeof(float) * 4);
    if (has_even) ll_finalize_crop_margins(out_even, min_even, 1);
    else memcpy(out_even, out_uniform, sizeof(float) * 4);
    return LL_OK;
}

#define LL_MAX_IMAGE_RECTS 48

typedef struct {
    fz_device super;
    fz_rect page_bounds;
    float rects[LL_MAX_IMAGE_RECTS * 4];
    int count;
    int ignore_depth;
} ll_img_device;

static void ll_img_begin_mask(fz_context *ctx, fz_device *dev, fz_rect area,
                              int luminosity, fz_colorspace *cs, const float *bc,
                              fz_color_params color_params) {
    (void)ctx; (void)area; (void)luminosity; (void)cs; (void)bc; (void)color_params;
    ((ll_img_device *)dev)->ignore_depth++;
}

static void ll_img_end_mask(fz_context *ctx, fz_device *dev, fz_function *fn) {
    (void)ctx; (void)fn;
    ll_img_device *idev = (ll_img_device *)dev;
    if (idev->ignore_depth > 0) idev->ignore_depth--;
}

static int ll_img_begin_tile(fz_context *ctx, fz_device *dev, fz_rect area, fz_rect view,
                             float xstep, float ystep, fz_matrix ctm, int id) {
    (void)ctx; (void)area; (void)view; (void)xstep; (void)ystep; (void)ctm; (void)id;
    ((ll_img_device *)dev)->ignore_depth++;
    return 0;
}

static void ll_img_end_tile(fz_context *ctx, fz_device *dev) {
    (void)ctx;
    ll_img_device *idev = (ll_img_device *)dev;
    if (idev->ignore_depth > 0) idev->ignore_depth--;
}

static void ll_img_fill_image(fz_context *ctx, fz_device *dev, fz_image *img,
                              fz_matrix ctm, float alpha, fz_color_params color_params) {
    (void)alpha; (void)color_params;
    ll_img_device *idev = (ll_img_device *)dev;
    if (idev->ignore_depth > 0) return;
    if (!img || !img->colorspace || fz_colorspace_n(ctx, img->colorspace) < 3) return;

    fz_rect r = fz_transform_rect(fz_unit_rect, ctm);
    r = fz_intersect_rect(r, idev->page_bounds);
    if (fz_is_empty_rect(r)) return;

    float bw = idev->page_bounds.x1 - idev->page_bounds.x0;
    float bh = idev->page_bounds.y1 - idev->page_bounds.y0;
    if (bw < 1e-3f || bh < 1e-3f) return;

    float nx0 = ll_clamp01((r.x0 - idev->page_bounds.x0) / bw);
    float ny0 = ll_clamp01((r.y0 - idev->page_bounds.y0) / bh);
    float nx1 = ll_clamp01((r.x1 - idev->page_bounds.x0) / bw);
    float ny1 = ll_clamp01((r.y1 - idev->page_bounds.y0) / bh);
    float nw = nx1 - nx0;
    float nh = ny1 - ny0;
    if (nw < 0.04f || nh < 0.04f) return;
    if (nw * nh > 0.78f) return;

    for (int i = 0; i < idev->count; ++i) {
        float *ex = &idev->rects[i * 4];
        if (nx1 >= ex[0] - 0.008f && nx0 <= ex[2] + 0.008f &&
            ny1 >= ex[1] - 0.008f && ny0 <= ex[3] + 0.008f) {
            if (nx0 < ex[0]) ex[0] = nx0;
            if (ny0 < ex[1]) ex[1] = ny0;
            if (nx1 > ex[2]) ex[2] = nx1;
            if (ny1 > ex[3]) ex[3] = ny1;
            return;
        }
    }
    if (idev->count >= LL_MAX_IMAGE_RECTS) return;
    float *dst = &idev->rects[idev->count * 4];
    dst[0] = nx0;
    dst[1] = ny0;
    dst[2] = nx1;
    dst[3] = ny1;
    idev->count++;
}

int ll_get_page_image_rects(ll_doc *d, int page, ll_rect_list *out) {
    if (!d || !out) return LL_ERROR;
    clear_error(d);
    memset(out, 0, sizeof(*out));
    if (page < 0 || page >= d->count) return LL_ERROR;

    fz_device *dev = NULL;
    fz_var(dev);
    fz_try(d->ctx) {
        ll_page *p = get_page(d, page);
        if (p && p->list) {
            ll_img_device *idev = (ll_img_device *)fz_new_device_of_size(d->ctx, (int)sizeof(ll_img_device));
            idev->super.fill_image = ll_img_fill_image;
            idev->super.begin_mask = ll_img_begin_mask;
            idev->super.end_mask = ll_img_end_mask;
            idev->super.begin_tile = ll_img_begin_tile;
            idev->super.end_tile = ll_img_end_tile;
            idev->page_bounds = p->bounds;
            dev = (fz_device *)idev;

            fz_run_display_list(d->ctx, p->list, dev, fz_identity, p->bounds, NULL);
            fz_close_device(d->ctx, dev);

            if (idev->count > 0) {
                out->rects = malloc(sizeof(float) * (size_t)idev->count * 4);
                if (!out->rects) fz_throw(d->ctx, FZ_ERROR_SYSTEM, "Allocation failed");
                memcpy(out->rects, idev->rects, sizeof(float) * (size_t)idev->count * 4);
                out->count = idev->count;
            }
        }
    }
    fz_always(d->ctx) {
        fz_drop_device(d->ctx, dev);
    }
    fz_catch(d->ctx) {
        caught(d);
        ll_free_rect_list(out);
        return LL_ERROR;
    }
    return LL_OK;
}

void ll_free_rect_list(ll_rect_list *out) {
    if (!out) return;
    free(out->rects);
    memset(out, 0, sizeof(*out));
}


