#include "mupdf/fitz.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int unpack_case(int width, int depth, int channels, int reject) {
    const unsigned char bytes[8] = {1,2,3,4,5,6,7,8};
    unsigned char result[8] = {0};
    fz_context *ctx = fz_new_context(NULL, NULL, 0);
    fz_stream *source = NULL, *unpacked = NULL;
    int caught = 0, good = 0;
    fz_var(source); fz_var(unpacked); fz_var(caught); fz_var(good);
    fz_try(ctx) {
        source = fz_open_memory(ctx, bytes, sizeof(bytes));
        unpacked = fz_unpack_stream(ctx, source, depth, width, 1, channels, 0, 0, 0);
        source = NULL;
        if (!reject) good = fz_read(ctx, unpacked, result, sizeof(result)) == sizeof(result) && !memcmp(bytes, result, sizeof(bytes));
    }
    fz_catch(ctx) { caught = 1; }
    fz_drop_stream(ctx, unpacked); fz_drop_stream(ctx, source); fz_drop_context(ctx);
    return reject ? caught : good && !caught;
}

typedef struct { int reject; void *watched; int frees; } AllocState;
static void *test_malloc(void *user, size_t n) { return ((AllocState *)user)->reject ? NULL : malloc(n); }
static void *test_realloc(void *user, void *p, size_t n) { return ((AllocState *)user)->reject ? NULL : realloc(p,n); }
static void test_free(void *user, void *p) { AllocState *s=user; if (p && p==s->watched) s->frees++; free(p); }

static int pixmap_ownership(void) {
    AllocState state = {0};
    fz_alloc_context alloc = { &state, test_malloc, test_realloc, test_free };
    fz_context *ctx = fz_new_context(&alloc, NULL, 0);
    fz_rect bounds = {0,0,8,8};
    fz_pixmap *pix = fz_new_pixmap(ctx, fz_device_rgb(ctx), 8, 8, NULL, 1);
    fz_display_list *list = fz_new_display_list(ctx, bounds);
    int caught = 0, good;
    fz_var(caught);
    state.watched = pix; state.reject = 1;
    fz_try(ctx) { fz_fill_pixmap_from_display_list(ctx, list, fz_identity, pix); }
    fz_catch(ctx) { caught = 1; }
    state.reject = 0;
    good = caught && state.frees == 0;
    if (state.frees == 0) fz_drop_pixmap(ctx, pix);
    fz_drop_display_list(ctx, list); fz_drop_context(ctx);
    return good;
}

static int render_pdf(const char *path) {
    fz_context *ctx=fz_new_context(NULL,NULL,0);
    fz_document *doc=NULL; fz_page *page=NULL; fz_pixmap *pix=NULL;
    int good=0;
    fz_var(doc);fz_var(page);fz_var(pix);fz_var(good);
    fz_register_document_handlers(ctx);
    fz_try(ctx) {
        doc=fz_open_document(ctx,path);page=fz_load_page(ctx,doc,0);
        pix=fz_new_pixmap_from_page(ctx,page,fz_scale(.5f,.5f),fz_device_rgb(ctx),0);
        good=fz_pixmap_width(ctx,pix)>0 && fz_pixmap_height(ctx,pix)>0;
    }
    fz_catch(ctx) { fprintf(stderr,"PDF render error: %s\n",fz_caught_message(ctx)); }
    fz_drop_pixmap(ctx,pix);fz_drop_page(ctx,page);fz_drop_document(ctx,doc);fz_drop_context(ctx);
    return good;
}

int main(int argc,char **argv) {
    int failures=0;
    #define CHECK(name, expression) do { int ok=(expression); printf("%s: %s\n",name,ok?"PASS":"FAIL"); if(!ok)failures++; } while(0)
    CHECK("normal_image_unpack",unpack_case(8,8,1,0));
    CHECK("integer_overflow_image_rejected",unpack_case(1<<30,8,4,1));
    CHECK("negative_width_rejected",unpack_case(-1,8,1,1));
    CHECK("invalid_channel_count_rejected",unpack_case(8,8,0,1));
    CHECK("caller_pixmap_survives_allocation_failure",pixmap_ownership());
    if(argc>1) CHECK("real_pdf_render",render_pdf(argv[1]));
    return failures?1:0;
}
