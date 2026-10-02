// src-tauri/native/mupdf_bridge.c
// 纯 C 语言跨平台 MuPDF 桥接实现（去 JNI 化，跨平台锁）
// 完整复刻 EbookNT 核心底层算法：
// 1. collect_page_sizes: 非递归 O(N) Page-Tree 栈遍历提取 MediaBox
// 2. outline_flatten: 一次性递归深搜展平目录，零跨语言调用往返
// 3. 跨平台 fine-grained lock (fz_locks_context) 支持真并发渲染

#include "mupdf_bridge.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
typedef CRITICAL_SECTION native_mutex_t;
static inline void native_mutex_init(native_mutex_t *m) { InitializeCriticalSection(m); }
static inline void native_mutex_destroy(native_mutex_t *m) { DeleteCriticalSection(m); }
static inline void native_mutex_lock(native_mutex_t *m) { EnterCriticalSection(m); }
static inline void native_mutex_unlock(native_mutex_t *m) { LeaveCriticalSection(m); }
#else
#include <pthread.h>
typedef pthread_mutex_t native_mutex_t;
static inline void native_mutex_init(native_mutex_t *m) { pthread_mutex_init(m, NULL); }
static inline void native_mutex_destroy(native_mutex_t *m) { pthread_mutex_destroy(m); }
static inline void native_mutex_lock(native_mutex_t *m) { pthread_mutex_lock(m); }
static inline void native_mutex_unlock(native_mutex_t *m) { pthread_mutex_unlock(m); }
#endif

// --- 锁上下文实现 (移植自 jni_concurrent.c) ---
enum {
    LOCK_INTERNAL = FZ_LOCK_MAX,
    TOTAL_LOCKS
};

typedef struct {
    native_mutex_t locks[TOTAL_LOCKS];
} bridge_locks_t;

static void bridge_lock_cb(void *user, int lock) {
    if (user && lock < TOTAL_LOCKS) {
        bridge_locks_t *l = (bridge_locks_t*)user;
        native_mutex_lock(&l->locks[lock]);
    }
}

static void bridge_unlock_cb(void *user, int lock) {
    if (user && lock < TOTAL_LOCKS) {
        bridge_locks_t *l = (bridge_locks_t*)user;
        native_mutex_unlock(&l->locks[lock]);
    }
}

static fz_locks_context* create_bridge_locks() {
    fz_locks_context *ctx_locks = (fz_locks_context*)malloc(sizeof(fz_locks_context));
    if (!ctx_locks) return NULL;
    bridge_locks_t *user_locks = (bridge_locks_t*)malloc(sizeof(bridge_locks_t));
    if (!user_locks) { free(ctx_locks); return NULL; }
    for (int i = 0; i < TOTAL_LOCKS; i++) {
        native_mutex_init(&user_locks->locks[i]);
    }
    ctx_locks->user = user_locks;
    ctx_locks->lock = bridge_lock_cb;
    ctx_locks->unlock = bridge_unlock_cb;
    return ctx_locks;
}

static void free_bridge_locks(fz_locks_context *ctx_locks) {
    if (ctx_locks) {
        if (ctx_locks->user) {
            bridge_locks_t *user_locks = (bridge_locks_t*)ctx_locks->user;
            for (int i = 0; i < TOTAL_LOCKS; i++) {
                native_mutex_destroy(&user_locks->locks[i]);
            }
            free(user_locks);
        }
        free(ctx_locks);
    }
}

// 文档内部封装
struct mupdf_doc_s {
    fz_context *ctx;
    fz_locks_context *locks;
    fz_document *doc;
    pdf_document *pdoc; // 若非 PDF 则为 NULL
    int32_t page_count;
};

mupdf_doc_t* mupdf_bridge_open(const char *path, const char *password) {
    if (!path) return NULL;

    fz_locks_context *locks = create_bridge_locks();
    if (!locks) return NULL;

    fz_context *ctx = fz_new_context(NULL, locks, FZ_STORE_DEFAULT);
    if (!ctx) {
        free_bridge_locks(locks);
        return NULL;
    }
    fz_register_document_handlers(ctx);

    mupdf_doc_t *doc = (mupdf_doc_t*)calloc(1, sizeof(mupdf_doc_t));
    if (!doc) {
        fz_drop_context(ctx);
        free_bridge_locks(locks);
        return NULL;
    }
    doc->ctx = ctx;
    doc->locks = locks;

    fz_try(ctx) {
        doc->doc = fz_open_document(ctx, path);
        if (fz_needs_password(ctx, doc->doc)) {
            if (password && !fz_authenticate_password(ctx, doc->doc, password)) {
                // 密码错误
                fz_throw(ctx, FZ_ERROR_GENERIC, "Wrong password");
            }
        }
        doc->page_count = fz_count_pages(ctx, doc->doc);
        doc->pdoc = pdf_document_from_fz_document(ctx, doc->doc);
    } fz_catch(ctx) {
        mupdf_bridge_close(doc);
        return NULL;
    }

    return doc;
}

void mupdf_bridge_close(mupdf_doc_t *doc) {
    if (!doc) return;
    if (doc->ctx) {
        if (doc->doc) {
            fz_drop_document(doc->ctx, doc->doc);
            doc->doc = NULL;
        }
        fz_locks_context *locks = doc->locks;
        fz_drop_context(doc->ctx);
        doc->ctx = NULL;
        free_bridge_locks(locks);
    }
    free(doc);
}

int32_t mupdf_bridge_get_page_count(mupdf_doc_t *doc) {
    return doc ? doc->page_count : 0;
}

// --- 【EbookNT 核心魔改 1: collect_page_sizes】---
typedef struct {
    pdf_obj *node;
    int child_len;
    int child_idx;
} page_tree_frame_t;

int32_t mupdf_bridge_collect_page_sizes(mupdf_doc_t *doc, int32_t *out_wh_buffer, int32_t max_pages) {
    if (!doc || !doc->ctx || !out_wh_buffer) return 0;
    int limit = (max_pages > 0 && max_pages < doc->page_count) ? max_pages : doc->page_count;

    // 若不是 PDF 格式或无 pdoc，降级逐页获取
    if (!doc->pdoc) {
        for (int i = 0; i < limit; i++) {
            fz_page *page = NULL;
            fz_try(doc->ctx) {
                page = fz_load_page(doc->ctx, doc->doc, i);
                fz_rect bounds = fz_bound_page(doc->ctx, page);
                out_wh_buffer[i * 2] = (int32_t)(bounds.x1 - bounds.x0);
                out_wh_buffer[i * 2 + 1] = (int32_t)(bounds.y1 - bounds.y0);
                fz_drop_page(doc->ctx, page);
            } fz_catch(doc->ctx) {
                out_wh_buffer[i * 2] = 595;
                out_wh_buffer[i * 2 + 1] = 842;
            }
        }
        return limit;
    }

    fz_context *ctx = doc->ctx;
    pdf_document *pdoc = doc->pdoc;
    int idx = 0;

    fz_try(ctx) {
        pdf_obj *root = pdf_dict_get(ctx, pdf_dict_get(ctx, pdf_trailer(ctx, pdoc), PDF_NAME(Root)), PDF_NAME(Pages));
        page_tree_frame_t stack_buf[256];
        page_tree_frame_t *stack = stack_buf;
        int depth = 0;
        pdf_obj *node = root;

    push_node:
        while (node) {
            pdf_obj *type = pdf_dict_get(ctx, node, PDF_NAME(Type));
            if (pdf_name_eq(ctx, type, PDF_NAME(Pages))) {
                pdf_obj *kids = pdf_dict_get(ctx, node, PDF_NAME(Kids));
                int len = pdf_array_len(ctx, kids);
                if (len > 0) {
                    stack[depth].node = node;
                    stack[depth].child_len = len;
                    stack[depth].child_idx = 0;
                    depth++;
                    node = pdf_array_get(ctx, kids, 0);
                    continue;
                }
            } else {
                // 叶子节点 (Page)
                int pos = idx;
                if (pos < limit) {
                    fz_rect box = fz_empty_rect;
                    pdf_obj *mediabox = pdf_dict_get(ctx, node, PDF_NAME(MediaBox));
                    if (mediabox) {
                        box = pdf_to_rect(ctx, mediabox);
                    } else {
                        pdf_obj *cropbox = pdf_dict_get(ctx, node, PDF_NAME(CropBox));
                        if (cropbox) box = pdf_to_rect(ctx, cropbox);
                    }
                    int w = (int)(box.x1 - box.x0 + 0.5f);
                    int h = (int)(box.y1 - box.y0 + 0.5f);
                    if (w <= 0 || h <= 0) { w = 595; h = 842; }
                    out_wh_buffer[pos * 2] = w;
                    out_wh_buffer[pos * 2 + 1] = h;
                    idx++;
                }
                goto pop_stack;
            }
            break;
        }

    pop_stack:
        while (depth > 0) {
            page_tree_frame_t *frame = &stack[depth - 1];
            frame->child_idx++;
            if (frame->child_idx < frame->child_len && idx < limit) {
                pdf_obj *kids = pdf_dict_get(ctx, frame->node, PDF_NAME(Kids));
                node = pdf_array_get(ctx, kids, frame->child_idx);
                goto push_node;
            }
            depth--;
        }
    } fz_catch(ctx) {
        // 捕获异常，容错退出
    }

    return idx;
}

// --- 【EbookNT 核心魔改 2: outline_flatten】---
static int count_outline_nodes(fz_outline *node) {
    int c = 0;
    while (node) {
        c++;
        if (node->down) c += count_outline_nodes(node->down);
        node = node->next;
    }
    return c;
}

static void recursive_outline_flatten(
    fz_context *ctx,
    fz_document *doc,
    fz_outline *node,
    int level,
    mupdf_flat_outline_item_t *items,
    int *pos
) {
    while (node) {
        int i = *pos;
        items[i].title = node->title ? strdup(node->title) : strdup("");
        items[i].page = fz_page_number_from_location(ctx, doc, node->page);
        items[i].level = level;
        items[i].target_x = node->x;
        items[i].target_y = node->y;
        items[i].uri = node->uri ? strdup(node->uri) : NULL;
        (*pos)++;

        if (node->down) {
            recursive_outline_flatten(ctx, doc, node->down, level + 1, items, pos);
        }
        node = node->next;
    }
}

int32_t mupdf_bridge_get_outline_flat(mupdf_doc_t *doc, mupdf_flat_outline_t *out_outline) {
    if (!doc || !doc->ctx || !doc->doc || !out_outline) return -1;
    out_outline->items = NULL;
    out_outline->count = 0;

    fz_outline *outline = NULL;
    fz_try(doc->ctx) {
        outline = fz_load_outline(doc->ctx, doc->doc);
    } fz_catch(doc->ctx) {
        return -1;
    }

    if (!outline) return 0; // 无大纲，正常返回 0 项

    int count = count_outline_nodes(outline);
    if (count <= 0) {
        fz_drop_outline(doc->ctx, outline);
        return 0;
    }

    mupdf_flat_outline_item_t *items = (mupdf_flat_outline_item_t*)calloc(count, sizeof(mupdf_flat_outline_item_t));
    if (!items) {
        fz_drop_outline(doc->ctx, outline);
        return -1;
    }

    int pos = 0;
    recursive_outline_flatten(doc->ctx, doc->doc, outline, 0, items, &pos);
    fz_drop_outline(doc->ctx, outline);

    out_outline->items = items;
    out_outline->count = pos;
    return 0;
}

void mupdf_bridge_free_outline(mupdf_flat_outline_t *outline) {
    if (!outline || !outline->items) return;
    for (int i = 0; i < outline->count; i++) {
        if (outline->items[i].title) free(outline->items[i].title);
        if (outline->items[i].uri) free(outline->items[i].uri);
    }
    free(outline->items);
    outline->items = NULL;
    outline->count = 0;
}

// 结构化文本提取
int32_t mupdf_bridge_get_page_text(mupdf_doc_t *doc, int32_t page_number, mupdf_page_text_t *out_text) {
    if (!doc || !doc->ctx || !doc->doc || !out_text) return -1;
    out_text->spans = NULL;
    out_text->count = 0;

    fz_page *page = NULL;
    fz_stext_page *stext = NULL;

    fz_try(doc->ctx) {
        page = fz_load_page(doc->ctx, doc->doc, page_number);
        stext = fz_new_stext_page_from_page(doc->ctx, page, NULL);
    } fz_catch(doc->ctx) {
        if (page) fz_drop_page(doc->ctx, page);
        return -1;
    }

    // 统计 spans 数量
    int cap = 128;
    int count = 0;
    mupdf_text_span_t *spans = (mupdf_text_span_t*)malloc(sizeof(mupdf_text_span_t) * cap);

    for (fz_stext_block *b = stext->first_block; b; b = b->next) {
        if (b->type == FZ_STEXT_BLOCK_TEXT) {
            for (fz_stext_line *l = b->u.t.first_line; l; l = l->next) {
                // 将一行作为一个 span，避免单字 span 造成 DOM 节点爆炸
                char line_buf[256] = {0};
                int buf_idx = 0;
                fz_rect line_bbox = fz_empty_rect;
                float max_size = 12.0f;

                for (fz_stext_char *ch = l->first_char; ch; ch = ch->next) {
                    line_bbox = fz_union_rect(line_bbox, fz_rect_from_quad(ch->quad));
                    if (ch->size > max_size) max_size = ch->size;

                    // UTF-8 转码
                    char utf8[8];
                    int n = fz_runetochar(utf8, ch->c);
                    if (buf_idx + n < sizeof(line_buf) - 1) {
                        memcpy(&line_buf[buf_idx], utf8, n);
                        buf_idx += n;
                    }
                }
                line_buf[buf_idx] = '\0';

                if (buf_idx > 0) {
                    if (count >= cap) {
                        cap *= 2;
                        spans = (mupdf_text_span_t*)realloc(spans, sizeof(mupdf_text_span_t) * cap);
                    }
                    strncpy(spans[count].text, line_buf, sizeof(spans[count].text) - 1);
                    spans[count].x = line_bbox.x0;
                    spans[count].y = line_bbox.y0;
                    spans[count].w = line_bbox.x1 - line_bbox.x0;
                    spans[count].h = line_bbox.y1 - line_bbox.y0;
                    spans[count].size = max_size;
                    count++;
                }
            }
        }
    }

    fz_drop_stext_page(doc->ctx, stext);
    fz_drop_page(doc->ctx, page);

    out_text->spans = spans;
    out_text->count = count;
    return 0;
}

void mupdf_bridge_free_text(mupdf_page_text_t *text) {
    if (!text || !text->spans) return;
    free(text->spans);
    text->spans = NULL;
    text->count = 0;
}

// 页面光栅化渲染 (暂输出未压缩像素或调用内部轻量压缩)
int32_t mupdf_bridge_render_page(
    mupdf_doc_t *doc,
    int32_t page_number,
    float scale,
    bool auto_crop,
    bool enhancement,
    mupdf_render_result_t *out_result
) {
    if (!doc || !doc->ctx || !doc->doc || !out_result) return -1;
    out_result->data = NULL;
    out_result->size = 0;

    fz_page *page = NULL;
    fz_pixmap *pix = NULL;

    fz_try(doc->ctx) {
        page = fz_load_page(doc->ctx, doc->doc, page_number);
        fz_matrix ctm = fz_scale(scale, scale);
        pix = fz_new_pixmap_from_page(doc->ctx, page, ctm, fz_device_rgb(doc->ctx), 0);
    } fz_catch(doc->ctx) {
        if (page) fz_drop_page(doc->ctx, page);
        return -1;
    }

    int w = fz_pixmap_width(doc->ctx, pix);
    int h = fz_pixmap_height(doc->ctx, pix);
    unsigned char *samples = fz_pixmap_samples(doc->ctx, pix);
    size_t raw_size = (size_t)w * h * 3;

    // 拷贝至堆内存返回
    uint8_t *buffer = (uint8_t*)malloc(raw_size);
    if (buffer) {
        memcpy(buffer, samples, raw_size);
        out_result->data = buffer;
        out_result->size = raw_size;
        out_result->width = (uint32_t)w;
        out_result->height = (uint32_t)h;
    }

    fz_drop_pixmap(doc->ctx, pix);
    fz_drop_page(doc->ctx, page);
    return buffer ? 0 : -1;
}

void mupdf_bridge_free_render_result(mupdf_render_result_t *result) {
    if (!result || !result->data) return;
    free(result->data);
    result->data = NULL;
    result->size = 0;
}
