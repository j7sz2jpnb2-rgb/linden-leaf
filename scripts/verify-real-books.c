#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "mupdf/fitz.h"
#include "ll_mupdf.h"

typedef struct {
    int id;
    const char *path;
    int pages[3];
} BookSpec;

static float quad_height(const ll_quad *q) {
    float y_min = q->xy[1];
    float y_max = q->xy[1];
    for (int i = 3; i < 8; i += 2) {
        if (q->xy[i] < y_min) y_min = q->xy[i];
        if (q->xy[i] > y_max) y_max = q->xy[i];
    }
    return y_max - y_min;
}

static void calc_center(const ll_char *c, float *x, float *y) {
    *x = (c->quad.xy[0] + c->quad.xy[2] + c->quad.xy[4] + c->quad.xy[6]) * 0.25f;
    *y = (c->quad.xy[1] + c->quad.xy[3] + c->quad.xy[5] + c->quad.xy[7]) * 0.25f;
}

static void calc_boundary(const ll_char *c, const char *side, float *x, float *y) {
    const float *q = c->quad.xy;
    float lx = (q[0] + q[4]) * 0.5f, ly = (q[1] + q[5]) * 0.5f;
    float tx = (q[2] + q[6]) * 0.5f, ty = (q[3] + q[7]) * 0.5f;
    float frac = (strcmp(side, "leading") == 0) ? 0.05f : 0.95f;
    *x = lx + frac * (tx - lx);
    *y = ly + frac * (ty - ly);
}

int main(void) {
    BookSpec books[5] = {
        { 1, "E:\\书\\导读福柯《规训与惩罚》 (施沃恩) (Z-Library).pdf", { 40, 98, 147 } },
        { 2, "E:\\书\\面具与真相 拉康的七堂课 (斯拉沃热·齐泽克, 唐健 译) (Z-Library).pdf", { 44, 110, 165 } },
        { 3, "E:\\书\\现代性 (汪民安) (Z-Library).pdf", { 45, 111, 166 } },
        { 4, "E:\\书\\德勒兹论福柯 (德勒兹) (Z-Library).pdf", { 43, 106, 158 } },
        { 5, "E:\\书\\散文的理念 -- 吉奥乔·阿甘本 -- 当代激进思想家译丛 -- 9787305231124 -- 760046378476c9cc4ae0854a42e2fe3c -- Anna’s Archive.pdf", { 23, 57, 85 } }
    };

    printf("=== Real 5 Books Direct MuPDF & ll_mupdf Verification ===\n\n");

    int total_pages_tested = 0;
    int total_chars_extracted = 0;
    int total_lines_tested = 0;
    int center_matches = 0;
    int edge_matches = 0;
    int zero_height_count = 0;
    int preserved_ocr_count = 0;

    for (int b = 0; b < 5; b++) {
        BookSpec *bs = &books[b];
        char err[512] = {0};
        ll_doc *doc = ll_open(bs->path, NULL, err, sizeof(err));
        if (!doc) {
            printf("[FAIL] Failed to open Book %d: %s (Error: %s)\n", bs->id, bs->path, err);
            continue;
        }

        printf("--- Book %d: %s ---\n", bs->id, bs->path);
        printf("    Page count in PDF: %d\n", ll_page_count(doc));

        for (int p = 0; p < 3; p++) {
            int page_1based = bs->pages[p];
            int page_idx = page_1based - 1;
            total_pages_tested++;

            ll_text text = {0};
            int rc = ll_get_text(doc, page_idx, &text);
            if (rc != LL_OK) {
                printf("    [P%d] ll_get_text failed: %s\n", page_1based, ll_error(doc));
                continue;
            }

            printf("    [P%d] Total extracted chars: %d\n", page_1based, text.count);
            total_chars_extracted += text.count;

            if (text.count == 0) {
                printf("          Pure scan page correctly detected: 0 chars, safe handling verified.\n");
                ll_free_text(&text);
                continue;
            }

            // Check heights of characters
            int page_zero_h = 0;
            float min_h = 1e9f, max_h = 0.0f;
            for (int i = 0; i < text.count; i++) {
                if (text.chars[i].codepoint <= 32) continue; // skip spaces
                float h = quad_height(&text.chars[i].quad);
                if (h <= 0.001f) {
                    page_zero_h++;
                    zero_height_count++;
                } else {
                    preserved_ocr_count++;
                }
                if (h < min_h) min_h = h;
                if (h > max_h) max_h = h;
            }
            printf("          Height range: min=%.3f pt, max=%.3f pt, zero-height chars=%d\n",
                   (min_h > 1e8f ? 0.0f : min_h), max_h, page_zero_h);

            // Sample line segments of length >= 10
            int line_count = 0;
            for (int start = 0; start < text.count && line_count < 3; ) {
                int end = start + 1;
                while (end < text.count && text.chars[end].line == text.chars[start].line) {
                    end++;
                }
                int len = end - start;
                if (len >= 10) {
                    line_count++;
                    total_lines_tested++;

                    // Build expected string
                    char expected[1024] = {0};
                    int pos = 0;
                    for (int k = start; k < end && pos < 1000; k++) {
                        // codepoint to UTF-8
                        int cp = text.chars[k].codepoint;
                        if (cp < 0x80) {
                            expected[pos++] = (char)cp;
                        } else if (cp < 0x800) {
                            expected[pos++] = (char)(0xC0 | (cp >> 6));
                            expected[pos++] = (char)(0x80 | (cp & 0x3F));
                        } else if (cp < 0x10000) {
                            expected[pos++] = (char)(0xE0 | (cp >> 12));
                            expected[pos++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                            expected[pos++] = (char)(0x80 | (cp & 0x3F));
                        } else {
                            expected[pos++] = (char)(0xF0 | (cp >> 18));
                            expected[pos++] = (char)(0x80 | ((cp >> 12) & 0x3F));
                            expected[pos++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                            expected[pos++] = (char)(0x80 | (cp & 0x3F));
                        }
                    }
                    expected[pos] = '\0';

                    // 1. Center copy (old method)
                    float c_ax, c_ay, c_bx, c_by;
                    calc_center(&text.chars[start], &c_ax, &c_ay);
                    calc_center(&text.chars[end - 1], &c_bx, &c_by);
                    ll_selection sel_center = {0};
                    ll_select(doc, page_idx, c_ax, c_ay, c_bx, c_by, &sel_center);
                    int c_match = (sel_center.text && strcmp(sel_center.text, expected) == 0);
                    if (c_match) center_matches++;

                    // 2. Boundary copy (new method)
                    float b_ax, b_ay, b_bx, b_by;
                    calc_boundary(&text.chars[start], "leading", &b_ax, &b_ay);
                    calc_boundary(&text.chars[end - 1], "trailing", &b_bx, &b_by);
                    ll_selection sel_edge = {0};
                    ll_select(doc, page_idx, b_ax, b_ay, b_bx, b_by, &sel_edge);
                    int e_match = (sel_edge.text && strcmp(sel_edge.text, expected) == 0);
                    if (e_match) edge_matches++;

                    printf("          Line %d (%d chars): CenterCopy=%s (%d bytes vs exp %d), EdgeCopy=%s (%d bytes)\n",
                           text.chars[start].line, len,
                           c_match ? "MATCH" : "MISMATCH",
                           (sel_center.text ? (int)strlen(sel_center.text) : 0), (int)strlen(expected),
                           e_match ? "MATCH" : "MISMATCH",
                           (sel_edge.text ? (int)strlen(sel_edge.text) : 0));

                    ll_free_selection(&sel_center);
                    ll_free_selection(&sel_edge);
                }
                start = end;
            }

            ll_free_text(&text);
        }

        ll_close(doc);
        printf("\n");
    }

    printf("=== Real Books Verification Summary ===\n");
    printf("Total Pages Tested: %d\n", total_pages_tested);
    printf("Total Extracted Chars: %d\n", total_chars_extracted);
    printf("Zero-height Chars: %d (MUST BE 0 with zero-height fallback)\n", zero_height_count);
    printf("Preserved OCR Chars: %d\n", preserved_ocr_count);
    printf("Total Line Segments Tested: %d\n", total_lines_tested);
    printf("Center-point Matches: %d / %d (expected ~2 matches, demonstrating the M02 defect)\n", center_matches, total_lines_tested);
    printf("Directional Boundary Matches: %d / %d (expected 100%% matches with M02 fix)\n", edge_matches, total_lines_tested);

    if (total_pages_tested != 15) {
        printf("[FAIL] Expected 15 pages tested, got %d!\n", total_pages_tested);
        return 1;
    }
    if (total_lines_tested != 18) {
        printf("[FAIL] Expected 18 lines tested, got %d!\n", total_lines_tested);
        return 2;
    }
    if (total_chars_extracted != 3252) {
        printf("[FAIL] Expected 3252 characters extracted, got %d!\n", total_chars_extracted);
        return 3;
    }
    if (zero_height_count > 0) {
        printf("[FAIL] Detected zero-height characters!\n");
        return 4;
    }
    if (edge_matches != total_lines_tested) {
        printf("[FAIL] Not all directional boundary selections matched! (%d / %d)\n", edge_matches, total_lines_tested);
        return 5;
    }
    printf("[SUCCESS] All 5 real books and 15 pages verified cleanly against real data!\n");
    return 0;
}
