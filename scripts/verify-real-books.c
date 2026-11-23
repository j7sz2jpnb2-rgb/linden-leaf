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

static int load_books_from_manifest(const char* manifest_path, BookSpec out_books[5]) {
    FILE* fp = fopen(manifest_path, "r");
    if (!fp) return 0;
    char line[2048];
    int idx = 0;
    while (idx < 5 && fgets(line, sizeof(line), fp)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
        if (len == 0 || line[0] == '#') continue;
        char* tab1 = strchr(line, '\t');
        char* tab2 = tab1 ? strchr(tab1 + 1, '\t') : NULL;
        if (!tab1 || !tab2) continue;
        *tab1 = '\0';
        *tab2 = '\0';
        int id = atoi(line);
        const char* book_path = tab1 + 1;
        int p0 = 0, p1 = 0, p2 = 0;
        if (sscanf(tab2 + 1, "%d,%d,%d", &p0, &p1, &p2) != 3) continue;
        out_books[idx].id = id > 0 ? id : (idx + 1);
        out_books[idx].path = _strdup(book_path);
        out_books[idx].pages[0] = p0;
        out_books[idx].pages[1] = p1;
        out_books[idx].pages[2] = p2;
        idx++;
    }
    fclose(fp);
    return idx;
}

int main(int argc, char** argv) {
    const char* manifest = (argc > 1 && argv[1][0]) ? argv[1] : getenv("LINDEN_REAL_BOOKS_MANIFEST");
    if (!manifest || !manifest[0]) {
        printf("[SKIP] No real-books manifest provided (pass argv[1] or set LINDEN_REAL_BOOKS_MANIFEST).\n");
        return 0;
    }
    BookSpec books[5] = {0};
    int loaded = load_books_from_manifest(manifest, books);
    if (loaded != 5) {
        printf("[FAIL] Expected 5 entries in manifest %s, loaded %d\n", manifest, loaded);
        return 1;
    }

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
