#ifndef LL_MUPDF_H
#define LL_MUPDF_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#define LL_API __declspec(dllexport)
#else
#define LL_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Linden Leaf MuPDF ABI v2.
 *
 * Threading contract:
 *   - One owning thread per ll_doc. Never call document APIs concurrently.
 *   - ll_cancel_abort() is the only function intentionally callable from a
 *     different thread while ll_render() is running. It maps to MuPDF's
 *     fz_cookie abort channel.
 *
 * Coordinates are MuPDF page-space coordinates before user zoom/rotation.
 * Returned allocations must be released with the matching ll_free_* call.
 */
typedef struct ll_doc ll_doc;
typedef struct ll_cancel ll_cancel;

typedef struct { float xy[8]; } ll_quad; /* ul, ur, ll, lr */
typedef struct { int codepoint, line; float size; ll_quad quad; } ll_char;
typedef struct { ll_char *chars; int count; } ll_text;
typedef struct { char *text; ll_quad *quads; int count; float a[2], b[2]; } ll_selection;
typedef struct {
    unsigned char *samples;
    size_t length;
    int width, height, stride, x, y;
    float matrix[6]; /* page -> device, including user rotation */
    void *pixmap_owner; /* non-NULL when samples borrow the MuPDF pixmap */
} ll_image;
typedef struct { uint64_t list_builds, list_hits, text_builds; } ll_stats;
typedef struct { char *title; int page, level; } ll_outline_item;
typedef struct { ll_outline_item *items; int count; } ll_outline;

enum {
    LL_SELECT_CHARS = 0,
    LL_SELECT_WORDS = 1,
    LL_SELECT_LINES = 2,
};

enum {
    LL_OK = 0,
    LL_CANCELLED = 1,
    LL_ERROR = -1,
};

LL_API ll_doc *ll_open(const char *path, const char *password, char *error, size_t error_size);
LL_API void ll_close(ll_doc *doc);
LL_API int ll_page_count(ll_doc *doc);
LL_API const char *ll_error(ll_doc *doc);
/* Returns malloc-owned UTF-8 metadata, or NULL when the key is absent. */
LL_API char *ll_metadata(ll_doc *doc, const char *key);
LL_API void ll_free_string(char *value);
LL_API int ll_get_outline(ll_doc *doc, ll_outline *out);
LL_API void ll_free_outline(ll_outline *out);

LL_API int ll_page_bounds(ll_doc *doc, int page, float bounds[4]);
/* Writes 4 floats per page. Returns number of pages written or -1 on error. */
LL_API int ll_page_bounds_many(ll_doc *doc, int start_page, int count, float *bounds4);

LL_API ll_cancel *ll_cancel_new(void);
LL_API void ll_cancel_abort(ll_cancel *cancel);
LL_API void ll_cancel_free(ll_cancel *cancel);

/* clip is optional, in device pixels after matrix transformation. Output is
 * tightly packed opaque RGBA. Region origin is returned as x/y.
 * Returns LL_CANCELLED when the associated fz_cookie was aborted. */
LL_API int ll_render(ll_doc *doc, int page, float scale, float rotation,
                     const float *clip, ll_cancel *cancel, ll_image *out);
LL_API void ll_free_image(ll_doc *doc, ll_image *out);

LL_API int ll_get_text(ll_doc *doc, int page, ll_text *out);
LL_API void ll_free_text(ll_text *out);
LL_API int ll_select(ll_doc *doc, int page, float ax, float ay, float bx, float by,
                     ll_selection *out);
LL_API int ll_select_mode(ll_doc *doc, int page, float ax, float ay, float bx, float by,
                          int mode, ll_selection *out);
LL_API void ll_free_selection(ll_selection *out);
LL_API ll_stats ll_get_stats(ll_doc *doc);

#ifdef __cplusplus
}
#endif
#endif
