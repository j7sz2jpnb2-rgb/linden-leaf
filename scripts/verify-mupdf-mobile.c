#include "ll_mupdf_mobile.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); return 0; } } while (0)

static int geometry_tests(void) {
    /* Crop/non-zero origin/arbitrary rotation/portrait/landscape/high DPR.
     * Every detail tile must cover its destination exactly once, including
     * partial last tiles. No GPU, DOM or mock rasterizer is involved. */
    const float page[] = {20, -30, 620, 770};
    const float crop[] = {70, 10, 580, 710};
    int plans = 0;
    for (int device = 0; device < 2; ++device) {
        uint32_t memory = device ? 8192 : 0;
        ll_mobile_limits limits = ll_mobile_limits_for_memory(memory);
        for (int angle = -180; angle <= 360; angle += 9) {
            for (int z = 1; z <= 80; ++z) {
                float scale = z * 0.125f;
                ll_mobile_render_plan p;
                CHECK(ll_mobile_plan_render(page, scale, (float)angle, crop,
                    LL_MOBILE_PREVIEW, memory, &p) == LL_OK);
                CHECK(p.tile_count == 1 && p.scale <= scale && p.scale > 0);
                uint64_t area = (uint64_t)(p.region[2] - p.region[0]) *
                    (p.region[3] - p.region[1]);
                CHECK(area <= limits.preview_pixels);
                CHECK(ll_mobile_plan_render(page, scale, (float)angle, crop,
                    LL_MOBILE_DETAIL, memory, &p) == LL_OK);
                uint64_t covered = 0;
                for (int i = 0; i < p.tile_count; ++i) {
                    ll_mobile_tile t;
                    CHECK(ll_mobile_tile_at(&p, i, &t) == LL_OK);
                    CHECK(t.rgba_bytes <= limits.max_tile_bytes);
                    CHECK(t.content[0] == p.region[0] + (i % p.columns) * p.tile_edge);
                    CHECK(t.content[1] == p.region[1] + (i / p.columns) * p.tile_edge);
                    CHECK(t.clip[0] <= t.content[0] && t.clip[1] <= t.content[1]);
                    CHECK(t.clip[2] >= t.content[2] && t.clip[3] >= t.content[3]);
                    covered += (uint64_t)(t.content[2] - t.content[0]) *
                        (t.content[3] - t.content[1]);
                }
                CHECK(covered == (uint64_t)(p.region[2] - p.region[0]) *
                    (p.region[3] - p.region[1]));
                CHECK(ll_mobile_tile_at(&p, p.tile_count, &(ll_mobile_tile){0}) == LL_ERROR);
                ++plans;
            }
        }
    }
    ll_mobile_render_plan p;
    float invalid[] = {0, 0, NAN, 1};
    float outside[] = {1000, 1000, 1100, 1100};
    CHECK(ll_mobile_plan_render(invalid, 1, 0, NULL, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, INFINITY, 0, NULL, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, 1, NAN, NULL, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, -1, 0, NULL, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, 1, 0, outside, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, 1, 0, NULL, 99, 0, &p) == LL_ERROR);
    CHECK(ll_mobile_plan_render(page, 10000, 0, NULL, LL_MOBILE_DETAIL, 0, &p) == LL_ERROR);
    printf("geometry_budget_and_coverage: PASS (%d preview/detail pairs)\n", plans);
    return 1;
}

static int write_fixture(const char *path) {
    FILE *f = fopen(path, "wb");
    CHECK(f);
    const char *objects[] = {
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Contents 4 0 R >>"
    };
    const char *content = "1 0 0 rg 0 0 100 600 re f\n0 1 0 rg 100 0 200 600 re f\n"
        "0 0 1 rg 300 0 100 600 re f\n"
        "1 1 0 rg 90 270 220 60 re f\n";
    long offset[5] = {0};
    fprintf(f, "%%PDF-1.4\n");
    for (int i = 1; i <= 3; ++i) {
        offset[i] = ftell(f);
        fprintf(f, "%d 0 obj\n%s\nendobj\n", i, objects[i - 1]);
    }
    offset[4] = ftell(f);
    fprintf(f, "4 0 obj\n<< /Length %zu >>\nstream\n%sendstream\nendobj\n", strlen(content), content);
    long xref = ftell(f);
    fprintf(f, "xref\n0 5\n0000000000 65535 f \n");
    for (int i = 1; i <= 4; ++i) fprintf(f, "%010ld 00000 n \n", offset[i]);
    fprintf(f, "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n%ld\n%%%%EOF\n", xref);
    CHECK(fclose(f) == 0);
    return 1;
}

static int compare_tiles(ll_doc *doc, int page, float scale, float rotation,
    const float *crop, uint32_t memory, int synthetic_fixture) {
    float bounds[4];
    CHECK(ll_page_bounds(doc, page, bounds) == LL_OK);
    ll_mobile_render_plan p;
    CHECK(ll_mobile_plan_render(bounds, scale, rotation, crop, LL_MOBILE_DETAIL, memory, &p) == LL_OK);
    float region[] = {(float)p.region[0], (float)p.region[1], (float)p.region[2], (float)p.region[3]};
    ll_image reference = {0};
    CHECK(ll_render(doc, page, scale, rotation, region, NULL, &reference) == LL_OK);
    size_t bytes = reference.length;
    unsigned char *stitched = calloc(bytes, 1);
    CHECK(stitched);
    for (int i = 0; i < p.tile_count; ++i) {
        ll_mobile_tile t;
        ll_image image = {0};
        CHECK(ll_mobile_tile_at(&p, i, &t) == LL_OK);
        CHECK(ll_mobile_render_tile(doc, page, &p, i, NULL, &image) == LL_OK);
        CHECK(image.length == t.rgba_bytes && image.length <= p.max_tile_bytes);
        for (int k = 0; k < 6; ++k) CHECK(fabsf(image.matrix[k] - p.matrix[k]) < 0.002f);
        int w = t.content[2] - t.content[0];
        for (int y = t.content[1]; y < t.content[3]; ++y) {
            size_t dest = (size_t)(y - reference.y) * reference.stride +
                (size_t)(t.content[0] - reference.x) * 4;
            size_t src = (size_t)(y - image.y) * image.stride +
                (size_t)(t.content[0] - image.x) * 4;
            CHECK(dest + (size_t)w * 4 <= bytes && src + (size_t)w * 4 <= image.length);
            memcpy(stitched + dest, image.samples + src, (size_t)w * 4);
        }
        ll_free_image(doc, &image);
    }
    size_t different = 0;
    int max_delta = 0;
    for (size_t i = 0; i < bytes; ++i) {
        int delta = abs((int)reference.samples[i] - (int)stitched[i]);
        if (delta) ++different;
        if (delta > max_delta) max_delta = delta;
    }
    printf("raster_comparison: angle=%.0f crop=%d tiles=%d bytes=%zu different=%zu max_delta=%d\n",
        rotation, crop != NULL, p.tile_count, bytes, different, max_delta);
    /* Axis-aligned solid fixture must be byte-identical. Arbitrarily rotated
     * vector edges are re-clipped by MuPDF for each tile: bound both changed
     * area and AA intensity rather than claiming bit-identical rasterization. */
    int right_angle = fabsf(remainderf(rotation, 90)) < 0.001f;
    int acceptable = synthetic_fixture ? (right_angle ? different == 0 :
        (max_delta <= 64 && different <= bytes / 500)) :
        (max_delta <= 32 && different <= bytes / 200);
    if (!acceptable) {
        FILE *f = fopen("mobile-raster-difference.ppm", "wb");
        if (f) {
            fprintf(f, "P6\n%d %d\n255\n", reference.width, reference.height);
            for (size_t i = 0; i < bytes; i += 4) {
                unsigned char rgb[3];
                for (int c = 0; c < 3; ++c)
                    rgb[c] = (unsigned char)abs((int)reference.samples[i+c] - (int)stitched[i+c]);
                fwrite(rgb, 1, 3, f);
            }
            fclose(f);
        }
    }
    free(stitched);
    ll_free_image(doc, &reference);
    CHECK(acceptable);

    ll_cancel *cancel = ll_cancel_new();
    CHECK(cancel);
    ll_cancel_abort(cancel);
    ll_stats before = ll_get_stats(doc);
    ll_image cancelled = {0};
    CHECK(ll_mobile_render_tile(doc, page, &p, 0, cancel, &cancelled) == LL_CANCELLED);
    CHECK(!cancelled.samples && cancelled.length == 0);
    ll_stats after = ll_get_stats(doc);
    CHECK(before.list_builds == after.list_builds && before.list_hits == after.list_hits);
    ll_cancel_free(cancel);

    CHECK(ll_mobile_plan_render(bounds, scale, rotation, crop, LL_MOBILE_PREVIEW, memory, &p) == LL_OK);
    ll_image preview = {0};
    CHECK(ll_mobile_render_tile(doc, page, &p, 0, NULL, &preview) == LL_OK);
    CHECK((uint64_t)preview.width * preview.height <= ll_mobile_limits_for_memory(memory).preview_pixels);
    ll_free_image(doc, &preview);
    printf("raster_rotation_%.0f_crop_%d: PASS (different_bytes=%zu)\n", rotation, crop != NULL, different);
    return 1;
}

static int native_tests(const char *fixture, const char *book) {
    CHECK(write_fixture(fixture));
    char error[256] = {0};
    ll_set_max_store_mb(ll_mobile_limits_for_memory(0).store_mb);
    ll_doc *doc = ll_open(fixture, NULL, error, sizeof(error));
    if (!doc) fprintf(stderr, "%s\n", error);
    CHECK(doc);
    float crop[] = {40, 30, 360, 560};
    const float rotations[] = {0, 90, 180, 270, 33};
    for (int i = 0; i < 5; ++i)
        CHECK(compare_tiles(doc, 0, 3, rotations[i], i % 2 ? NULL : crop, 0, 1));
    /* Whole page would be 4800x7200, beyond the shared renderer's full-frame
     * budget. Zoom must retain full requested detail for the visible region. */
    float zoom_crop[] = {180, 200, 280, 320};
    CHECK(compare_tiles(doc, 0, 12, 0, zoom_crop, 0, 1));
    ll_stats stats = ll_get_stats(doc);
    CHECK(stats.list_builds == 1 && stats.list_hits > 1 && stats.text_builds == 0);
    ll_close(doc);
    remove(fixture);
    printf("shared_display_list_no_text_work: PASS\n");
    if (book && book[0]) {
        doc = ll_open(book, NULL, error, sizeof(error));
        if (!doc) fprintf(stderr, "%s\n", error);
        CHECK(doc && ll_page_count(doc) > 0);
        int last = ll_page_count(doc) - 1;
        CHECK(compare_tiles(doc, 0, 4, 0, NULL, 0, 0));
        CHECK(compare_tiles(doc, last / 2, 4, 90, NULL, 8192, 0));
        CHECK(compare_tiles(doc, last, 4, 0, NULL, 0, 0));
        ll_close(doc);
        printf("real_book_first_middle_last: PASS\n");
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: verify-mupdf-mobile fixture.pdf [real-book.pdf]\n"); return 2; }
    if (!geometry_tests() || !native_tests(argv[1], argc > 2 ? argv[2] : NULL)) return 1;
    printf("mobile_native_core: PASS (host execution; Android objects compiled separately)\n");
    return 0;
}
