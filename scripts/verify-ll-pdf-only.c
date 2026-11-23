/*
 * Security probe: verifies ll_open rejects disguised HTML renamed to .pdf and
 * opens/renders a valid minimal PDF via the native MuPDF bridge.
 *
 * Reproduce on Windows x64 (keeps build artifacts on D:, never C:):
 *   powershell -NoProfile -ExecutionPolicy Bypass -Command "
 *     . .\scripts\env.ps1;
 *     $probeDir = Join-Path $env:CARGO_TARGET_DIR 'security-probes';
 *     New-Item -ItemType Directory -Force -Path $probeDir | Out-Null;
 *     $env:TEMP = $probeDir; $env:TMP = $probeDir;
 *     cl.exe /nologo /O2 /MD /utf-8 \"/I$env:LL_MUPDF_INCLUDE\" /Isrc-tauri/native scripts/verify-ll-pdf-only.c src-tauri/native/ll_mupdf.c \"/Fo$probeDir\\\" \"/Fe$probeDir\verify-ll-pdf-only.exe\" /link \"/LIBPATH:$env:LL_MUPDF_LIB_DIR\" libmupdf.lib libthirdparty.lib libresources.lib user32.lib gdi32.lib advapi32.lib shell32.lib ole32.lib comdlg32.lib ws2_32.lib crypt32.lib /INCREMENTAL:NO /LTCG;
 *     & \"$probeDir\verify-ll-pdf-only.exe\"
 *   "
 */
#include "ll_mupdf.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int write_bytes(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    size_t written = fwrite(data, 1, len, f);
    fclose(f);
    return written == len;
}

int main(void) {
    const char *tmp = getenv("TEMP");
    if (!tmp || !tmp[0]) tmp = ".";

    char html_pdf[512];
    char valid_pdf[512];
    snprintf(html_pdf, sizeof(html_pdf), "%s\\ll_probe_disguised_html.pdf", tmp);
    snprintf(valid_pdf, sizeof(valid_pdf), "%s\\ll_probe_valid_minimal.pdf", tmp);

    const char *disguised = "<!DOCTYPE html><html><body><style>body{color:red}</style><p>Fake PDF</p></body></html>";
    if (!write_bytes(html_pdf, disguised, strlen(disguised))) {
        fprintf(stderr, "FAIL: unable to write disguised test file\n");
        return 1;
    }

    char err[256] = {0};
    ll_doc *bad_doc = ll_open(html_pdf, NULL, err, sizeof(err));
    remove(html_pdf);
    if (bad_doc != NULL) {
        ll_close(bad_doc);
        fprintf(stderr, "FAIL: ll_open accepted disguised HTML payload renamed to .pdf!\n");
        return 1;
    }
    printf("disguised_html_pdf_rejected: PASS (error=%s)\n", err);

    const char *minimal_pdf =
        "%PDF-1.4\n"
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n"
        "xref\n0 4\n"
        "0000000000 65535 f \n"
        "0000000009 00000 n \n"
        "0000000058 00000 n \n"
        "0000000115 00000 n \n"
        "trailer\n<< /Size 4 /Root 1 0 R >>\n"
        "startxref\n183\n%%EOF\n";

    if (!write_bytes(valid_pdf, minimal_pdf, strlen(minimal_pdf))) {
        fprintf(stderr, "FAIL: unable to write valid minimal PDF\n");
        return 1;
    }

    memset(err, 0, sizeof(err));
    ll_doc *good_doc = ll_open(valid_pdf, NULL, err, sizeof(err));
    if (!good_doc) {
        remove(valid_pdf);
        fprintf(stderr, "FAIL: ll_open failed valid minimal PDF: %s\n", err);
        return 1;
    }
    int count = ll_page_count(good_doc);
    if (count != 1) {
        ll_close(good_doc);
        remove(valid_pdf);
        fprintf(stderr, "FAIL: expected page count 1, got %d\n", count);
        return 1;
    }
    ll_image img = {0};
    int rc = ll_render(good_doc, 0, 1.0f, 0.0f, NULL, NULL, &img);
    if (rc != LL_OK || img.width != 100 || img.height != 100 || !img.samples) {
        ll_free_image(good_doc, &img);
        ll_close(good_doc);
        remove(valid_pdf);
        fprintf(stderr, "FAIL: ll_render failed (%d, %dx%d)\n", rc, img.width, img.height);
        return 1;
    }
    ll_free_image(good_doc, &img);
    ll_close(good_doc);
    remove(valid_pdf);
    printf("valid_minimal_pdf_opened_and_rendered: PASS (pages=1, 100x100)\n");
    return 0;
}
