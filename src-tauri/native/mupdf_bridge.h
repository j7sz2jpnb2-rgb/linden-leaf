// src-tauri/native/mupdf_bridge.h
// 纯 C 语言跨平台 MuPDF 桥接头文件（彻底剥离 Android JNI 依赖）
// 吸收 EbookNT (leviathan) 针对大文档的底层核心魔改：
// 1. collect_page_sizes: O(N) 极速扫描 /Pages 字典树 MediaBox，绕过流解码
// 2. outline_flatten: 一维紧凑向量展平整棵目录树，彻底消灭上万次跨边界调用
// 3. 跨平台细粒度锁 (Windows CRITICAL_SECTION / POSIX pthread_mutex) 保证并发渲染安全

#ifndef MUPDF_BRIDGE_H
#define MUPDF_BRIDGE_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// 文档不透明句柄
typedef struct mupdf_doc_s mupdf_doc_t;

// 扁平化目录条目结构体 (配合 outline_flatten)
typedef struct {
    char *title;       // UTF-8 编码标题
    int32_t page;      // 目标页码 (从 0 开始)
    int32_t level;     // 缩进深度 (0 为根章节)
    float target_x;    // 页面跳转 X 坐标 (点位 Points)
    float target_y;    // 页面跳转 Y 坐标 (点位 Points)
    char *uri;         // 外部链接 (若是页面跳转则为 NULL)
} mupdf_flat_outline_item_t;

typedef struct {
    mupdf_flat_outline_item_t *items;
    int32_t count;
} mupdf_flat_outline_t;

// 页面单字文本结构体 (配合 stext)
typedef struct {
    char text[32];     // UTF-8 字符/小词串
    float x;           // 物理点位 X
    float y;           // 物理点位 Y (顶部)
    float w;           // 物理点位 宽度
    float h;           // 物理点位 高度
    float size;        // 字号大小
} mupdf_text_span_t;

typedef struct {
    mupdf_text_span_t *spans;
    int32_t count;
} mupdf_page_text_t;

// 渲染结果结构体
typedef struct {
    uint8_t *data;     // 图像字节数据 (JPEG/WebP 或 RGBA)
    size_t size;       // 字节长度
    uint32_t width;    // 像素宽
    uint32_t height;   // 像素高
} mupdf_render_result_t;

// --- 核心 API ---

/**
 * 打开文档
 * @param path 文件本地绝对路径 (UTF-8)
 * @param password 密码 (若无则传 NULL)
 * @return 文档句柄，失败返回 NULL
 */
mupdf_doc_t* mupdf_bridge_open(const char *path, const char *password);

/**
 * 关闭并释放文档句柄
 */
void mupdf_bridge_close(mupdf_doc_t *doc);

/**
 * 获取总页数
 */
int32_t mupdf_bridge_get_page_count(mupdf_doc_t *doc);

/**
 * 【EbookNT 核心魔改 1】O(N) 极速扫描全书所有页面的物理尺寸
 * 直接非递归遍历 /Pages 字典树提取 /MediaBox，完全不解码页面内部流
 * @param out_wh_buffer 输出数组，长度必须 >= page_count * 2，顺序为 [w0, h0, w1, h1, ...]
 * @param max_pages 最大获取页数 (传 0 则获取全部)
 * @return 成功获取尺寸的页数
 */
int32_t mupdf_bridge_collect_page_sizes(mupdf_doc_t *doc, int32_t *out_wh_buffer, int32_t max_pages);

/**
 * 【EbookNT 核心魔改 2】单次批量展平整棵目录树
 * 彻底消灭数千次跨语言边界往返穿梭，10毫秒内展平万级目录
 * @param out_outline 输出大纲指针
 * @return 0 成功，非 0 失败
 */
int32_t mupdf_bridge_get_outline_flat(mupdf_doc_t *doc, mupdf_flat_outline_t *out_outline);

/**
 * 释放大纲结构体内存
 */
void mupdf_bridge_free_outline(mupdf_flat_outline_t *outline);

/**
 * 提取指定页的结构化文本 (用于构建前端透明对齐 TextLayer)
 */
int32_t mupdf_bridge_get_page_text(mupdf_doc_t *doc, int32_t page_number, mupdf_page_text_t *out_text);

/**
 * 释放结构化文本结构体内存
 */
void mupdf_bridge_free_text(mupdf_page_text_t *text);

/**
 * 渲染指定页面并输出为 TurboJPEG/WebP 轻量图像流 (支持自动白边裁剪与图像增强)
 * @param page_number 页码 (从 0 开始)
 * @param scale 缩放倍率 (基准 72 DPI 为 1.0)
 * @param auto_crop 是否启用 C 级自动切白边
 * @param enhancement 是否启用古籍扫描件去底灰与对比度增强
 * @param out_result 输出渲染结果
 */
int32_t mupdf_bridge_render_page(
    mupdf_doc_t *doc,
    int32_t page_number,
    float scale,
    bool auto_crop,
    bool enhancement,
    mupdf_render_result_t *out_result
);

/**
 * 释放渲染结果内存
 */
void mupdf_bridge_free_render_result(mupdf_render_result_t *result);

#ifdef __cplusplus
}
#endif

#endif // MUPDF_BRIDGE_H
