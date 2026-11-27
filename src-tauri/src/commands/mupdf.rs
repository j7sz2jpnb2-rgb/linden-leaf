use serde::{Deserialize, Serialize};
use tauri::ipc::Response;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DocumentMetadata {
    #[serde(rename = "docId")]
    pub doc_id: String,
    #[serde(rename = "numPages")]
    pub num_pages: usize,
    #[serde(rename = "defaultWidth")]
    pub default_width: f32,
    #[serde(rename = "defaultHeight")]
    pub default_height: f32,
    pub title: Option<String>,
    pub author: Option<String>,
    pub format: String,
    #[serde(rename = "nativeBackend")]
    pub native_backend: bool,
    #[serde(default, rename = "parallelRendering")]
    pub parallel_rendering: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FlatOutlineItem {
    pub title: String,
    pub page: Option<usize>,
    pub level: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TextCharItem {
    pub text: String,
    pub line: i32,
    pub size: f32,
    pub quad: [f32; 8],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TextLayerResponse {
    pub chars: Vec<TextCharItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SelectionResponse {
    pub text: String,
    pub quads: Vec<[f32; 8]>,
    pub a: [f32; 2],
    pub b: [f32; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PdfLinkItem {
    pub rect: [f32; 4],
    pub uri: Option<String>,
    pub page: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MobileRenderTile {
    pub content: [i32; 4],
    pub clip: [f32; 4],
    #[serde(rename = "rgbaBytes")]
    pub rgba_bytes: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MobileRenderPlan {
    pub scale: f32,
    pub rotation: f32,
    pub matrix: [f32; 6],
    pub region: [i32; 4],
    #[serde(rename = "tileEdge")]
    pub tile_edge: i32,
    pub bleed: i32,
    pub columns: i32,
    pub rows: i32,
    #[serde(rename = "maxTileBytes")]
    pub max_tile_bytes: usize,
    pub tiles: Vec<MobileRenderTile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RenderDiagnostics {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "queueWaitUs")]
    pub queue_wait_us: u64,
    #[serde(rename = "cListUs")]
    pub c_list_us: u64,
    #[serde(rename = "cRasterUs")]
    pub c_raster_us: u64,
    #[serde(rename = "cPixmapUs")]
    pub c_pixmap_us: u64,
    #[serde(rename = "cListHit")]
    pub c_list_hit: bool,
    #[serde(rename = "cTotalUs")]
    pub c_total_us: u64,
    #[serde(rename = "packetUs")]
    pub packet_us: u64,
    #[serde(rename = "packetBytes")]
    pub packet_bytes: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ExtractedPdfAnnot {
    pub page: usize,
    #[serde(rename = "type")]
    pub annot_type: String,
    pub color: String,
    pub opacity: f32,
    pub rect: [f32; 4],
    #[serde(rename = "pageBounds")]
    pub page_bounds: [f32; 4],
    pub quads: Vec<[f32; 8]>,
    pub rects: Vec<[f32; 4]>,
    pub text: Option<String>,
    pub author: Option<String>,
    #[serde(rename = "quoteText")]
    pub quote_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AutoCropMargins {
    pub uniform: [f32; 4],
    pub odd: [f32; 4],
    pub even: [f32; 4],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct QuickPdfIndexEntry {
    page: usize,
    scale: f32,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

static AUTHORIZED_DIRECT_PDF_PATHS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>,
> = std::sync::OnceLock::new();

fn authorized_direct_pdf_store(
) -> &'static std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>> {
    AUTHORIZED_DIRECT_PDF_PATHS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

pub(crate) fn authorize_direct_pdf_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let raw = path.to_string_lossy();
    let abs = super::fs::validate_safe_path_syntax(&raw)?;
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "pdf" {
        return Err("Direct MuPDF access requires a .pdf file".into());
    }
    let sym = std::fs::symlink_metadata(&abs)
        .map_err(|e| format!("Cannot inspect PDF file: {e}"))?;
    if sym.file_type().is_symlink() {
        return Err("Symbolic links are not permitted for direct PDF open".into());
    }
    let canon = std::fs::canonicalize(&abs)
        .map_err(|e| format!("Cannot resolve PDF path: {e}"))?;
    let meta = std::fs::metadata(&canon)
        .map_err(|e| format!("Cannot stat PDF file: {e}"))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("Target PDF must be a non-empty regular file".into());
    }
    if !file_has_pdf_header_prefix(&canon)? {
        return Err("Target file does not have a valid %PDF- header".into());
    }
    if let Ok(mut guard) = authorized_direct_pdf_store().lock() {
        guard.insert(canon.clone());
    }
    Ok(canon)
}

#[cfg_attr(not(ll_mupdf), allow(dead_code))]
pub(crate) fn is_authorized_direct_pdf_path(path: &std::path::Path) -> bool {
    let Ok(canon) = std::fs::canonicalize(path) else {
        return false;
    };
    authorized_direct_pdf_store()
        .lock()
        .map(|guard| guard.contains(&canon))
        .unwrap_or(false)
}

fn quick_index_key(path: &std::path::Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        s.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        s
    }
}

fn quick_index_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("pdf_quick_index.json"))
}

#[cfg_attr(not(ll_mupdf), allow(dead_code))]
pub(crate) fn read_quick_index_entry(
    app: &tauri::AppHandle,
    canonical_path: &std::path::Path,
) -> Option<(usize, f32)> {
    let idx_path = quick_index_file(app)?;
    let content = std::fs::read_to_string(idx_path).ok()?;
    let map: std::collections::HashMap<String, QuickPdfIndexEntry> =
        serde_json::from_str(&content).ok()?;
    let key = quick_index_key(canonical_path);
    map.get(&key)
        .map(|entry| (entry.page, entry.scale.clamp(0.4, 4.0)))
}

#[tauri::command]
pub async fn mupdf_authorize_direct_pdf_path(file_path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authorize_direct_pdf_path(std::path::Path::new(&file_path))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("Authorize PDF task failed: {e}"))?
}

#[tauri::command]
pub async fn mupdf_update_quick_index(
    app: tauri::AppHandle,
    file_path: String,
    page_index: usize,
    scale: f32,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(idx_path) = quick_index_file(&app) else {
            return Ok(false);
        };
        let Ok(canon) = std::fs::canonicalize(&file_path) else {
            return Ok(false);
        };
        if let Some(parent) = idx_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut map: std::collections::HashMap<String, QuickPdfIndexEntry> =
            std::fs::read_to_string(&idx_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        map.insert(
            quick_index_key(&canon),
            QuickPdfIndexEntry {
                page: page_index,
                scale: if scale.is_finite() { scale.clamp(0.4, 4.0) } else { 1.25 },
                updated_at: now,
            },
        );
        if map.len() > 200 {
            let mut entries: Vec<(String, u64)> = map
                .iter()
                .map(|(k, v)| (k.clone(), v.updated_at))
                .collect();
            entries.sort_by_key(|(_, ts)| *ts);
            let remove_n = map.len() - 200;
            for (k, _) in entries.into_iter().take(remove_n) {
                map.remove(&k);
            }
        }
        if let Ok(json) = serde_json::to_string(&map) {
            let tmp = idx_path.with_extension("json.tmp");
            if std::fs::write(&tmp, json.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp, &idx_path);
            }
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("Update PDF quick index failed: {e}"))?
}

#[cfg(ll_mupdf)]
mod imp {
    use super::*;
    use std::{
        collections::HashMap,
        ffi::{CStr, CString},
        os::raw::{c_char, c_float, c_int, c_void},
        path::{Path, PathBuf},
        ptr::NonNull,
        sync::{atomic::Ordering, mpsc, Arc, Mutex, OnceLock},
        thread,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };
    use tauri::Manager;
    use tokio::sync::oneshot;

    const LL_OK: i32 = 0;
    const LL_CANCELLED: i32 = 1;
    static DEFAULT_STORE_MB: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(256);

    #[repr(C)]
    struct LlDoc { _private: [u8; 0] }
    #[repr(C)]
    struct LlCancel { _private: [u8; 0] }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct LlQuad { xy: [f32; 8] }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct LlChar { codepoint: c_int, line: c_int, size: c_float, quad: LlQuad }
    #[repr(C)]
    struct LlText { chars: *mut LlChar, count: c_int }
    #[repr(C)]
    struct LlSelection {
        text: *mut c_char,
        quads: *mut LlQuad,
        count: c_int,
        a: [f32; 2],
        b: [f32; 2],
    }
    #[repr(C)]
    struct LlImage {
        samples: *mut u8,
        length: usize,
        width: c_int,
        height: c_int,
        stride: c_int,
        x: c_int,
        y: c_int,
        matrix: [f32; 6],
        pixmap_owner: *mut c_void,
    }
    #[repr(C)]
    struct LlOutlineItem { title: *mut c_char, page: c_int, level: c_int }
    #[repr(C)]
    struct LlOutline { items: *mut LlOutlineItem, count: c_int }
    #[repr(C)]
    struct LlLink {
        rect: [f32; 4],
        uri: *mut c_char,
        page: c_int,
    }
    #[repr(C)]
    struct LlLinks {
        count: c_int,
        items: *mut LlLink,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct LlRenderTimings {
        list_time_us: u64,
        raster_time_us: u64,
        pixmap_time_us: u64,
        list_hit: c_int,
    }

    #[repr(C)]
    struct LlExportAnnot {
        page: c_int,
        annot_type: c_int,
        color: [f32; 3],
        opacity: f32,
        rect: [f32; 4],
        quads: *const f32,
        quad_count: c_int,
        text: *const c_char,
        author: *const c_char,
        stroke_counts: *const c_int,
        stroke_points: *const f32,
        stroke_count: c_int,
        width: f32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct LlMobileRenderPlan {
        scale: c_float,
        rotation: c_float,
        matrix: [c_float; 6],
        region: [c_int; 4],
        tile_edge: c_int,
        bleed: c_int,
        columns: c_int,
        rows: c_int,
        tile_count: c_int,
        max_tile_bytes: usize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct LlMobileTile {
        content: [c_int; 4],
        clip: [c_float; 4],
        rgba_bytes: usize,
    }

    #[repr(C)]
    struct LlPdfAnnot {
        page: c_int,
        annot_type: c_int,
        color: [c_float; 3],
        opacity: c_float,
        rect: [c_float; 4],
        page_bounds: [c_float; 4],
        quads: *mut LlQuad,
        quad_count: c_int,
        text: *mut c_char,
        author: *mut c_char,
        quote_text: *mut c_char,
    }

    #[repr(C)]
    struct LlPdfAnnotList {
        items: *mut LlPdfAnnot,
        count: c_int,
    }

    #[repr(C)]
    struct LlRectList {
        rects: *mut c_float,
        count: c_int,
    }

    #[cfg(target_os = "windows")]
    #[repr(C)]
    struct LlRenderJob { _private: [u8; 0] }

    extern "C" {
        fn ll_set_max_store_mb(max_mb: u32);
        #[cfg(test)]
        fn ll_open(path: *const c_char, password: *const c_char, error: *mut c_char, error_size: usize) -> *mut LlDoc;
        fn ll_open_with_options(path: *const c_char, password: *const c_char, error: *mut c_char,
                                error_size: usize, max_store_mb: u32, parallel: c_int) -> *mut LlDoc;
        #[cfg(target_os = "windows")]
        fn ll_prepare_render_job(doc: *mut LlDoc, page: c_int, scale: c_float, rotation: c_float,
                                 clip: *const c_float, cancel: *mut LlCancel) -> *mut LlRenderJob;
        #[cfg(target_os = "windows")]
        fn ll_run_render_job(job: *mut LlRenderJob, cancel: *mut LlCancel, out: *mut LlImage,
                             timings: *mut LlRenderTimings, error: *mut c_char, error_size: usize) -> c_int;
        #[cfg(target_os = "windows")]
        fn ll_free_render_job(job: *mut LlRenderJob, out: *mut LlImage);
        fn ll_close(doc: *mut LlDoc);
        fn ll_page_count(doc: *mut LlDoc) -> c_int;
        fn ll_error(doc: *mut LlDoc) -> *const c_char;
        fn ll_metadata(doc: *mut LlDoc, key: *const c_char) -> *mut c_char;
        fn ll_free_string(value: *mut c_char);
        fn ll_get_outline(doc: *mut LlDoc, out: *mut LlOutline) -> c_int;
        fn ll_free_outline(out: *mut LlOutline);
        fn ll_get_links(doc: *mut LlDoc, page: c_int, out: *mut LlLinks) -> c_int;
        fn ll_free_links(out: *mut LlLinks);
        fn ll_page_bounds(doc: *mut LlDoc, page: c_int, bounds: *mut c_float) -> c_int;
        fn ll_page_bounds_many(doc: *mut LlDoc, start_page: c_int, count: c_int, bounds4: *mut c_float) -> c_int;
        fn ll_cancel_new() -> *mut LlCancel;
        fn ll_cancel_abort(cancel: *mut LlCancel);
        fn ll_cancel_is_aborted(cancel: *mut LlCancel) -> c_int;
        fn ll_cancel_free(cancel: *mut LlCancel);
        #[allow(dead_code)]
        fn ll_render(doc: *mut LlDoc, page: c_int, scale: c_float, rotation: c_float,
                     clip: *const c_float, cancel: *mut LlCancel, out: *mut LlImage) -> c_int;
        fn ll_render_priority(doc: *mut LlDoc, page: c_int, scale: c_float, rotation: c_float,
                              clip: *const c_float, cancel: *mut LlCancel, priority: c_int, out: *mut LlImage) -> c_int;
        fn ll_free_image(doc: *mut LlDoc, out: *mut LlImage);
        fn ll_get_text(doc: *mut LlDoc, page: c_int, out: *mut LlText) -> c_int;
        fn ll_free_text(out: *mut LlText);
        fn ll_select_mode(doc: *mut LlDoc, page: c_int, ax: c_float, ay: c_float,
                          bx: c_float, by: c_float, mode: c_int,
                          out: *mut LlSelection) -> c_int;
        fn ll_free_selection(out: *mut LlSelection);
        fn ll_get_last_render_timings(doc: *mut LlDoc) -> LlRenderTimings;
        fn ll_get_page_plain_text(doc: *mut LlDoc, page: c_int, out_text: *mut *mut c_char) -> c_int;
        fn ll_export_annotated_pdf(
            input_path: *const c_char,
            output_path: *const c_char,
            password: *const c_char,
            annots: *const LlExportAnnot,
            annot_count: c_int,
        ) -> c_int;
        fn ll_mobile_plan_render(
            page_bounds: *const c_float,
            scale: c_float,
            rotation: c_float,
            visible_page_rect: *const c_float,
            quality: c_int,
            memory_mb: u32,
            out: *mut LlMobileRenderPlan,
        ) -> c_int;
        fn ll_mobile_tile_at(
            plan: *const LlMobileRenderPlan,
            index: c_int,
            out: *mut LlMobileTile,
        ) -> c_int;
        fn ll_mobile_render_tile(
            doc: *mut LlDoc,
            page: c_int,
            plan: *const LlMobileRenderPlan,
            index: c_int,
            cancel: *mut LlCancel,
            out: *mut LlImage,
        ) -> c_int;
        fn ll_extract_pdf_annots(
            doc: *mut LlDoc,
            max_annots: c_int,
            out: *mut LlPdfAnnotList,
        ) -> c_int;
        fn ll_free_pdf_annots(out: *mut LlPdfAnnotList);
        fn ll_compute_auto_crop(
            doc: *mut LlDoc,
            max_samples: c_int,
            out_uniform: *mut c_float,
            out_odd: *mut c_float,
            out_even: *mut c_float,
        ) -> c_int;
        fn ll_get_page_image_rects(
            doc: *mut LlDoc,
            page: c_int,
            out: *mut LlRectList,
        ) -> c_int;
        fn ll_free_rect_list(out: *mut LlRectList);
    }

    fn native_error(doc: *mut LlDoc) -> String {
        unsafe {
            let p = ll_error(doc);
            if p.is_null() { "MuPDF error".into() }
            else { CStr::from_ptr(p).to_string_lossy().into_owned() }
        }
    }

    fn native_metadata(doc: *mut LlDoc, key: &str) -> Option<String> {
        let key = CString::new(key).ok()?;
        let value = unsafe { ll_metadata(doc, key.as_ptr()) };
        if value.is_null() { return None; }
        let result = unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned();
        unsafe { ll_free_string(value) };
        if result.trim().is_empty() { None } else { Some(result) }
    }

    struct CancelHandle(NonNull<LlCancel>);
    unsafe impl Send for CancelHandle {}
    unsafe impl Sync for CancelHandle {}
    impl CancelHandle {
        fn new() -> Result<Self, String> {
            NonNull::new(unsafe { ll_cancel_new() })
                .map(Self)
                .ok_or_else(|| "Failed to allocate MuPDF cancel token".into())
        }
        fn abort(&self) { unsafe { ll_cancel_abort(self.0.as_ptr()) } }
        fn is_aborted(&self) -> bool { unsafe { ll_cancel_is_aborted(self.0.as_ptr()) != 0 } }
        fn ptr(&self) -> *mut LlCancel { self.0.as_ptr() }
    }
    impl Drop for CancelHandle {
        fn drop(&mut self) { unsafe { ll_cancel_free(self.0.as_ptr()) } }
    }

    type CancellationMap = Arc<Mutex<HashMap<String, Arc<CancelHandle>>>>;

    #[derive(Clone)]
    struct DocumentSession {
        tx: mpsc::Sender<DocCommand>,
        cancels: CancellationMap,
        num_pages: usize,
        file_path: PathBuf,
        password: Option<String>,
    }

    enum DocCommand {
        Bounds {
            start: usize,
            count: usize,
            reply: oneshot::Sender<Result<Vec<f32>, String>>,
        },
        Text {
            page: usize,
            reply: oneshot::Sender<Result<TextLayerResponse, String>>,
        },
        Select {
            page: usize,
            a: [f32; 2],
            b: [f32; 2],
            mode: i32,
            reply: oneshot::Sender<Result<SelectionResponse, String>>,
        },
        Outline {
            reply: oneshot::Sender<Result<Vec<FlatOutlineItem>, String>>,
        },
        Links {
            page: usize,
            reply: oneshot::Sender<Result<Vec<PdfLinkItem>, String>>,
        },
        PlainText {
            page: usize,
            reply: oneshot::Sender<Result<String, String>>,
        },
        ExtractAnnotations {
            reply: oneshot::Sender<Result<Vec<ExtractedPdfAnnot>, String>>,
        },
        ComputeAutoCrop {
            reply: oneshot::Sender<Result<AutoCropMargins, String>>,
        },
        PageImageRects {
            page: usize,
            reply: oneshot::Sender<Result<Vec<[f32; 4]>, String>>,
        },
        PlanMobileRender {
            page: usize,
            scale: f32,
            rotation: f32,
            visible_page_rect: Option<[f32; 4]>,
            quality: i32,
            memory_mb: u32,
            reply: oneshot::Sender<Result<MobileRenderPlan, String>>,
        },
        Render(RenderRequest),
        Close,
    }

    struct RenderRequest {
        page: usize,
        scale: f32,
        rotation: f32,
        clip: Option<[f32; 4]>,
        mobile_tile: Option<(LlMobileRenderPlan, c_int)>,
        cancel: Arc<CancelHandle>,
        request_id: String,
        priority: u8,
        generation: u32,
        enqueued_at: Instant,
        reply: oneshot::Sender<Result<Vec<u8>, String>>,
    }

    impl RenderRequest {
        fn clip_ptr(&self) -> *const f32 {
            self.clip.as_ref().map_or(std::ptr::null(), |clip| clip.as_ptr())
        }

        fn finish(self, cancels: &CancellationMap, result: Result<Vec<u8>, String>) {
            if let Ok(mut map) = cancels.lock() { map.remove(&self.request_id); }
            let _ = self.reply.send(result);
        }

        fn cancel(self, cancels: &CancellationMap, message: &str) {
            self.cancel.abort();
            self.finish(cancels, Err(message.into()));
        }
    }

    impl LlImage {
        fn empty() -> Self {
            Self {
                samples: std::ptr::null_mut(), length: 0, width: 0, height: 0,
                stride: 0, x: 0, y: 0, matrix: [0.0; 6], pixmap_owner: std::ptr::null_mut(),
            }
        }
    }

    enum RasterTarget {
        Document(*mut LlDoc),
        MobileTile {
            doc: *mut LlDoc,
            plan: LlMobileRenderPlan,
            tile_index: c_int,
        },
        #[cfg(target_os = "windows")]
        Auxiliary(PreparedRaster),
    }

    #[cfg(target_os = "windows")]
    struct PreparedRaster {
        job: NonNull<LlRenderJob>,
        image: LlImage,
    }

    // The job holds its own context and a retained display list. Only the receiving
    // thread uses it, and the owner waits for that thread before dropping shared locks.
    #[cfg(target_os = "windows")]
    unsafe impl Send for PreparedRaster {}
    #[cfg(target_os = "windows")]
    impl Drop for PreparedRaster {
        fn drop(&mut self) {
            unsafe { ll_free_render_job(self.job.as_ptr(), &mut self.image) };
        }
    }

    #[cfg(target_os = "windows")]
    struct RasterWork {
        request: RenderRequest,
        prepared: PreparedRaster,
        started: Instant,
    }

    #[cfg(target_os = "windows")]
    struct RasterLane {
        sender: mpsc::SyncSender<RasterWork>,
        thread: thread::JoinHandle<()>,
        busy: Arc<std::sync::atomic::AtomicBool>,
    }

    #[cfg(target_os = "windows")]
    impl RasterLane {
        fn new(cancels: CancellationMap) -> Option<Self> {
            let (sender, receiver) = mpsc::sync_channel::<RasterWork>(1);
            let busy = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let worker_busy = busy.clone();
            let thread = thread::Builder::new().name("ll-mupdf-raster".into()).spawn(move || {
                while let Ok(work) = receiver.recv() {
                    render_request(work.request, RasterTarget::Auxiliary(work.prepared), &cancels, work.started);
                    worker_busy.store(false, Ordering::Release);
                }
            }).ok()?;
            Some(Self { sender, thread, busy })
        }

        fn dispatch(&self, doc: *mut LlDoc, request: RenderRequest, started: Instant) -> Option<RenderRequest> {
            if request.priority != 0 || self.busy.load(Ordering::Acquire) || request.cancel.is_aborted() {
                return Some(request);
            }
            let job = unsafe {
                ll_prepare_render_job(doc, request.page as i32, request.scale, request.rotation,
                                      request.clip_ptr(), request.cancel.ptr())
            };
            let Some(job) = NonNull::new(job) else { return Some(request); };
            let prepared = PreparedRaster { job, image: LlImage::empty() };
            self.busy.store(true, Ordering::Release);
            match self.sender.send(RasterWork { request, prepared, started }) {
                Ok(()) => None,
                Err(error) => {
                    self.busy.store(false, Ordering::Release);
                    Some(error.0.request)
                }
            }
        }

        fn finish(self) {
            drop(self.sender);
            let _ = self.thread.join();
        }
    }

    fn render_request(request: RenderRequest, mut target: RasterTarget, cancels: &CancellationMap, started: Instant) {
        if request.cancel.is_aborted() {
            request.finish(cancels, Err("render cancelled".into()));
            return;
        }
        let mut serial_image = LlImage::empty();
        let (status, timings, image, error) = match &mut target {
            RasterTarget::Document(doc) => {
                let status = unsafe {
                    ll_render_priority(*doc, request.page as i32, request.scale, request.rotation,
                                       request.clip_ptr(), request.cancel.ptr(), request.priority as c_int,
                                       &mut serial_image)
                };
                let error = (status < LL_OK).then(|| native_error(*doc));
                (status, unsafe { ll_get_last_render_timings(*doc) }, &serial_image, error)
            }
            RasterTarget::MobileTile { doc, plan, tile_index } => {
                let status = unsafe {
                    ll_mobile_render_tile(*doc, request.page as i32, plan, *tile_index,
                                          request.cancel.ptr(), &mut serial_image)
                };
                let error = (status < LL_OK).then(|| native_error(*doc));
                (status, unsafe { ll_get_last_render_timings(*doc) }, &serial_image, error)
            }
            #[cfg(target_os = "windows")]
            RasterTarget::Auxiliary(prepared) => {
                let mut timings = LlRenderTimings::default();
                let mut message = [0 as c_char; 512];
                let status = unsafe {
                    ll_run_render_job(prepared.job.as_ptr(), request.cancel.ptr(), &mut prepared.image,
                                      &mut timings, message.as_mut_ptr(), message.len())
                };
                let error = (status < LL_OK).then(|| {
                    unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy().into_owned()
                });
                (status, timings, &prepared.image, error)
            }
        };
        let c_total_us = started.elapsed().as_micros() as u64;
        let packet_start = Instant::now();
        let result = if status == LL_CANCELLED || request.cancel.is_aborted() {
            Err("render cancelled".into())
        } else if let Some(error) = error {
            Err(error)
        } else {
            let packet = render_packet(image);
            if packet.is_ok() && request.cancel.is_aborted() { Err("render cancelled".into()) } else { packet }
        };
        if DIAGNOSTICS_ENABLED.load(Ordering::Relaxed) {
            if let Ok(mut diag) = diagnostics_store().lock() {
                if diag.len() >= 200 { diag.pop_front(); }
                diag.push_back(RenderDiagnostics {
                    request_id: request.request_id.clone(),
                    queue_wait_us: started.duration_since(request.enqueued_at).as_micros() as u64,
                    c_list_us: timings.list_time_us,
                    c_raster_us: timings.raster_time_us,
                    c_pixmap_us: timings.pixmap_time_us,
                    c_list_hit: timings.list_hit != 0,
                    c_total_us,
                    packet_us: packet_start.elapsed().as_micros() as u64,
                    packet_bytes: result.as_ref().map(|v| v.len()).unwrap_or(0),
                });
            }
        }
        match target {
            RasterTarget::Document(doc) | RasterTarget::MobileTile { doc, .. } => unsafe { ll_free_image(doc, &mut serial_image) },
            #[cfg(target_os = "windows")]
            RasterTarget::Auxiliary(prepared) => drop(prepared),
        }
        request.finish(cancels, result);
    }

    fn store() -> &'static Mutex<HashMap<String, DocumentSession>> {
        static STORE: OnceLock<Mutex<HashMap<String, DocumentSession>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn window_docs_store() -> &'static Mutex<HashMap<String, Vec<String>>> {
        static STORE: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn register_window_doc(window_label: &str, doc_id: &str) {
        if let Ok(mut store) = window_docs_store().lock() {
            let list = store.entry(window_label.to_string()).or_default();
            if !list.iter().any(|id| id == doc_id) {
                list.push(doc_id.to_string());
            }
        }
    }

    pub fn mupdf_close_documents_for_window(window_label: &str) {
        let doc_ids = if let Ok(mut store) = window_docs_store().lock() {
            store.remove(window_label).unwrap_or_default()
        } else {
            Vec::new()
        };
        for doc_id in doc_ids {
            mupdf_close_document(doc_id);
        }
    }

    static DIAGNOSTICS_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    fn diagnostics_store() -> &'static Mutex<std::collections::VecDeque<RenderDiagnostics>> {
        static STORE: OnceLock<Mutex<std::collections::VecDeque<RenderDiagnostics>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(std::collections::VecDeque::with_capacity(200)))
    }

    fn session(doc_id: &str) -> Result<DocumentSession, String> {
        store().lock().map_err(|e| e.to_string())?
            .get(doc_id).cloned()
            .ok_or_else(|| format!("MuPDF document session not found: {doc_id}"))
    }

    fn make_doc_id() -> String {
        let ns = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        format!("mupdf_{ns}")
    }

    struct OpenDocument {
        pages: usize,
        first: [f32; 4],
        title: Option<String>,
        author: Option<String>,
        parallel: bool,
    }

    fn worker(path: String, password: String, max_store_mb: u32, parallel: bool,
              rx: mpsc::Receiver<DocCommand>, cancels: CancellationMap,
              ready: oneshot::Sender<Result<OpenDocument, String>>) {
        let c_path = match CString::new(path) {
            Ok(v) => v,
            Err(_) => { let _ = ready.send(Err("File path contains NUL".into())); return; }
        };
        let c_password = CString::new(password).unwrap_or_else(|_| CString::new("").expect("empty CString"));
        let mut err = [0 as c_char; 512];
        let doc = unsafe {
            ll_open_with_options(c_path.as_ptr(), c_password.as_ptr(), err.as_mut_ptr(), err.len(),
                                 max_store_mb, i32::from(parallel))
        };
        if doc.is_null() {
            let msg = unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned();
            let _ = ready.send(Err(if msg.is_empty() { "MuPDF failed to open document".into() } else { msg }));
            return;
        }

        let pages = unsafe { ll_page_count(doc) }.max(0) as usize;
        let mut first = [0f32; 4];
        let first_status = if pages > 0 { unsafe { ll_page_bounds(doc, 0, first.as_mut_ptr()) } } else { LL_OK };
        if first_status != LL_OK {
            let msg = native_error(doc);
            unsafe { ll_close(doc) };
            let _ = ready.send(Err(msg));
            return;
        }
        let title = native_metadata(doc, "info:Title");
        let author = native_metadata(doc, "info:Author");
        #[cfg(target_os = "windows")]
        let raster = if parallel { RasterLane::new(cancels.clone()) } else { None };
        #[cfg(target_os = "windows")]
        let parallel = raster.is_some();
        if ready.send(Ok(OpenDocument { pages, first, title, author, parallel })).is_err() {
            #[cfg(target_os = "windows")]
            if let Some(raster) = raster { raster.finish(); }
            unsafe { ll_close(doc) };
            return;
        }

        let mut pending: Vec<DocCommand> = Vec::new();

        loop {
            if pending.is_empty() {
                match rx.recv() {
                    Ok(cmd) => pending.push(cmd),
                    Err(_) => break,
                }
            }

            while pending.len() < 16 {
                match rx.try_recv() {
                    Ok(cmd) => pending.push(cmd),
                    Err(_) => break,
                }
            }

            if pending.iter().any(|c| matches!(c, DocCommand::Close)) {
                break;
            }

            let mut i = 0;
            while i < pending.len() {
                let should_cancel = if let DocCommand::Render(RenderRequest { page, generation, cancel, .. }) = &pending[i] {
                    cancel.is_aborted() ||
                    pending.iter().skip(i + 1).any(|later| {
                        if let DocCommand::Render(RenderRequest { page: later_page, generation: later_gen, .. }) = later {
                            *later_page == *page && *later_gen > *generation
                        } else {
                            false
                        }
                    })
                } else {
                    false
                };

                if should_cancel {
                    let cmd = pending.remove(i);
                    if let DocCommand::Render(request) = cmd {
                        request.cancel(&cancels, "render cancelled");
                    }
                } else {
                    i += 1;
                }
            }

            if pending.is_empty() {
                continue;
            }

            let best_idx = {
                let mut best_idx = 0;
                let mut best_score = 999;
                for (j, c) in pending.iter().enumerate() {
                    let score = match c {
                        DocCommand::Close => 0,
                        DocCommand::Select { .. } => 1,
                        DocCommand::PlanMobileRender { .. } => 2,
                        DocCommand::Render(RenderRequest { priority: 0, .. }) => 2,
                        DocCommand::Text { .. } => 3,
                        DocCommand::Bounds { .. } => 4,
                        DocCommand::Render(RenderRequest { priority, .. }) => 10 + (*priority as i32),
                        DocCommand::PlainText { .. } => 25,
                        DocCommand::Outline { .. } | DocCommand::Links { .. } | DocCommand::ExtractAnnotations { .. } | DocCommand::ComputeAutoCrop { .. } | DocCommand::PageImageRects { .. } => 26,
                    };
                    if score < best_score {
                        best_score = score;
                        best_idx = j;
                    }
                }
                best_idx
            };

            let cmd = pending.remove(best_idx);
            match cmd {
                DocCommand::Bounds { start, count, reply } => {
                    let mut values = vec![0f32; count.saturating_mul(4)];
                    let n = unsafe { ll_page_bounds_many(doc, start as i32, count as i32, values.as_mut_ptr()) };
                    let result = if n < 0 { Err(native_error(doc)) } else {
                        values.truncate(n as usize * 4);
                        Ok(values)
                    };
                    let _ = reply.send(result);
                }
                DocCommand::Text { page, reply } => {
                    let mut raw = LlText { chars: std::ptr::null_mut(), count: 0 };
                    let status = unsafe { ll_get_text(doc, page as i32, &mut raw) };
                    let result = if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let chars = if raw.count > 0 && !raw.chars.is_null() {
                            unsafe { std::slice::from_raw_parts(raw.chars, raw.count as usize) }
                                .iter().map(|c| TextCharItem {
                                    text: char::from_u32(c.codepoint as u32).unwrap_or('\u{FFFD}').to_string(),
                                    line: c.line,
                                    size: c.size,
                                    quad: c.quad.xy,
                                }).collect()
                        } else { Vec::new() };
                        Ok(TextLayerResponse { chars })
                    };
                    unsafe { ll_free_text(&mut raw) };
                    let _ = reply.send(result);
                }
                DocCommand::Select { page, a, b, mode, reply } => {
                    let mut raw = LlSelection {
                        text: std::ptr::null_mut(), quads: std::ptr::null_mut(), count: 0,
                        a: [0.0; 2], b: [0.0; 2],
                    };
                    let status = unsafe { ll_select_mode(doc, page as i32, a[0], a[1], b[0], b[1], mode, &mut raw) };
                    let result = if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let text = if raw.text.is_null() { String::new() }
                            else { unsafe { CStr::from_ptr(raw.text) }.to_string_lossy().into_owned() };
                        let quads = if raw.count > 0 && !raw.quads.is_null() {
                            unsafe { std::slice::from_raw_parts(raw.quads, raw.count as usize) }
                                .iter().map(|q| q.xy).collect()
                        } else { Vec::new() };
                        Ok(SelectionResponse { text, quads, a: raw.a, b: raw.b })
                    };
                    unsafe { ll_free_selection(&mut raw) };
                    let _ = reply.send(result);
                }
                DocCommand::Outline { reply } => {
                    let mut raw = LlOutline { items: std::ptr::null_mut(), count: 0 };
                    let status = unsafe { ll_get_outline(doc, &mut raw) };
                    let result = if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let items = if raw.count > 0 && !raw.items.is_null() {
                            unsafe { std::slice::from_raw_parts(raw.items, raw.count as usize) }
                                .iter().map(|item| FlatOutlineItem {
                                    title: if item.title.is_null() { String::new() }
                                        else { unsafe { CStr::from_ptr(item.title) }.to_string_lossy().into_owned() },
                                     page: if item.page >= 0 { Some(item.page as usize) } else { None },
                                    level: item.level.max(0) as usize,
                                }).collect()
                        } else { Vec::new() };
                        Ok(items)
                    };
                    unsafe { ll_free_outline(&mut raw) };
                    let _ = reply.send(result);
                }
                DocCommand::PlainText { page, reply } => {
                    let mut out_ptr: *mut c_char = std::ptr::null_mut();
                    let rc = unsafe { ll_get_page_plain_text(doc, page as c_int, &mut out_ptr) };
                    if rc == 0 && !out_ptr.is_null() {
                        let text = unsafe { CStr::from_ptr(out_ptr).to_string_lossy().into_owned() };
                        unsafe { ll_free_string(out_ptr) };
                        let _ = reply.send(Ok(text));
                    } else {
                        let _ = reply.send(Err(native_error(doc)));
                    }
                }
                DocCommand::ExtractAnnotations { reply } => {
                    let _ = reply.send(extract_annots_from_doc(doc));
                }
                DocCommand::ComputeAutoCrop { reply } => {
                    let mut uniform = [0f32; 4];
                    let mut odd = [0f32; 4];
                    let mut even = [0f32; 4];
                    let status = unsafe {
                        ll_compute_auto_crop(doc, 12, uniform.as_mut_ptr(), odd.as_mut_ptr(), even.as_mut_ptr())
                    };
                    let res = if status == LL_OK {
                        Ok(AutoCropMargins { uniform, odd, even })
                    } else {
                        Err(native_error(doc))
                    };
                    let _ = reply.send(res);
                }
                DocCommand::PageImageRects { page, reply } => {
                    let mut raw = LlRectList { rects: std::ptr::null_mut(), count: 0 };
                    let status = unsafe { ll_get_page_image_rects(doc, page as c_int, &mut raw) };
                    let res = if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let mut out = Vec::with_capacity(raw.count.max(0) as usize);
                        if raw.count > 0 && !raw.rects.is_null() {
                            let slice = unsafe { std::slice::from_raw_parts(raw.rects, raw.count as usize * 4) };
                            for chunk in slice.chunks_exact(4) {
                                out.push([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            }
                        }
                        Ok(out)
                    };
                    unsafe { ll_free_rect_list(&mut raw) };
                    let _ = reply.send(res);
                }
                DocCommand::PlanMobileRender { page, scale, rotation, visible_page_rect, quality, memory_mb, reply } => {
                    let result = build_mobile_render_plan(doc, page, scale, rotation, visible_page_rect, quality, memory_mb);
                    let _ = reply.send(result);
                }
                DocCommand::Links { page, reply } => {
                    let mut raw = LlLinks { items: std::ptr::null_mut(), count: 0 };
                    let status = unsafe { ll_get_links(doc, page as i32, &mut raw) };
                    let result = if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let links = if raw.count > 0 && !raw.items.is_null() {
                            unsafe { std::slice::from_raw_parts(raw.items, raw.count as usize) }
                                .iter().map(|item| {
                                    let uri = if item.uri.is_null() { None } else {
                                        let s = unsafe { CStr::from_ptr(item.uri) }.to_string_lossy().into_owned();
                                        if s.trim().is_empty() { None } else { Some(s) }
                                    };
                                    let page = if item.page >= 0 { Some(item.page as usize) } else { None };
                                    PdfLinkItem { rect: item.rect, uri, page }
                                }).collect()
                        } else { Vec::new() };
                        Ok(links)
                    };
                    unsafe { ll_free_links(&mut raw) };
                    let _ = reply.send(result);
                }
                DocCommand::Render(mut request) => {
                    let started = Instant::now();
                    if let Some((plan, tile_index)) = request.mobile_tile.take() {
                        render_request(request, RasterTarget::MobileTile { doc, plan, tile_index }, &cancels, started);
                        continue;
                    }
                    #[cfg(target_os = "windows")]
                    let request = if let Some(raster) = &raster {
                        match raster.dispatch(doc, request, started) {
                            Some(request) => request,
                            None => continue,
                        }
                    } else {
                        request
                    };
                    render_request(request, RasterTarget::Document(doc), &cancels, started);
                }
                DocCommand::Close => break,
            }
        }

        for cmd in pending.drain(..) {
            match cmd {
                DocCommand::Bounds { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::Text { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::Select { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::Outline { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::PlainText { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::ExtractAnnotations { reply } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::ComputeAutoCrop { reply } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::PageImageRects { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::PlanMobileRender { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::Links { reply, .. } => { let _ = reply.send(Err("Document closed".into())); }
                DocCommand::Render(request) => request.cancel(&cancels, "Document closed"),
                DocCommand::Close => {}
            }
        }

        if let Ok(mut map) = cancels.lock() {
            for handle in map.values() { handle.abort(); }
            map.clear();
        }
        #[cfg(target_os = "windows")]
        if let Some(raster) = raster { raster.finish(); }
        unsafe { ll_close(doc) };
    }

    /// Losslessly compresses an RGBA pixel slice into QOI opcodes directly appended to `out`.
    /// Aborts early and returns `false` if encoded size reaches `max_encoded_bytes`.
    fn append_qoi_rgba(pixels: &[u8], out: &mut Vec<u8>, max_encoded_bytes: usize) -> bool {
        let base = out.len();
        let pixel_count = pixels.len() / 4;
        if pixel_count == 0 || pixels.len() != pixel_count * 4 {
            return false;
        }
        let limit = base.saturating_add(max_encoded_bytes);
        let mut index = [[0u8; 4]; 64];
        let mut prev = [255u8, 255, 255, 255];
        let mut run: u8 = 0;

        for (i, chunk) in pixels.chunks_exact(4).enumerate() {
            let px = [chunk[0], chunk[1], chunk[2], chunk[3]];
            if px == prev {
                run += 1;
                if run == 62 || i + 1 == pixel_count {
                    if out.len() + 1 > limit {
                        out.truncate(base);
                        return false;
                    }
                    out.push(0xC0 | (run - 1));
                    run = 0;
                }
            } else {
                if run > 0 {
                    if out.len() + 1 > limit {
                        out.truncate(base);
                        return false;
                    }
                    out.push(0xC0 | (run - 1));
                    run = 0;
                }
                if out.len() + 5 > limit {
                    out.truncate(base);
                    return false;
                }
                let h = ((px[0] as usize) * 3
                    + (px[1] as usize) * 5
                    + (px[2] as usize) * 7
                    + (px[3] as usize) * 11)
                    & 63;
                if index[h] == px {
                    out.push(h as u8);
                } else {
                    index[h] = px;
                    if px[3] == prev[3] {
                        let dr = (px[0] as i8).wrapping_sub(prev[0] as i8);
                        let dg = (px[1] as i8).wrapping_sub(prev[1] as i8);
                        let db = (px[2] as i8).wrapping_sub(prev[2] as i8);
                        let dr_dg = dr.wrapping_sub(dg);
                        let db_dg = db.wrapping_sub(dg);
                        if (-2..=1).contains(&dr) && (-2..=1).contains(&dg) && (-2..=1).contains(&db) {
                            out.push(
                                0x40 | (((dr + 2) as u8) << 4)
                                    | (((dg + 2) as u8) << 2)
                                    | ((db + 2) as u8),
                            );
                        } else if (-32..=31).contains(&dg)
                            && (-8..=7).contains(&dr_dg)
                            && (-8..=7).contains(&db_dg)
                        {
                            out.push(0x80 | ((dg + 32) as u8));
                            out.push((((dr_dg + 8) as u8) << 4) | ((db_dg + 8) as u8));
                        } else {
                            out.push(0xFE);
                            out.extend_from_slice(&px[..3]);
                        }
                    } else {
                        out.push(0xFF);
                        out.extend_from_slice(&px);
                    }
                }
                prev = px;
            }
        }
        true
    }

    fn write_packet_header(
        out: &mut Vec<u8>,
        magic: &[u8; 4],
        width: u32,
        height: u32,
        stride: u32,
        offset_x: i32,
        offset_y: i32,
        matrix: [f32; 6],
        payload_len: u32,
    ) {
        out.extend_from_slice(magic);
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&stride.to_le_bytes());
        out.extend_from_slice(&offset_x.to_le_bytes());
        out.extend_from_slice(&offset_y.to_le_bytes());
        for v in matrix { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(&payload_len.to_le_bytes());
    }

    fn encode_render_packet_slice(
        pixels: &[u8],
        width: i32,
        height: i32,
        stride: i32,
        offset_x: i32,
        offset_y: i32,
        matrix: [f32; 6],
    ) -> Result<Vec<u8>, String> {
        let expected_stride = width.checked_mul(4).ok_or("Invalid MuPDF width")?;
        let length = usize::try_from(expected_stride).ok()
            .and_then(|s| usize::try_from(height).ok().and_then(|h| s.checked_mul(h)))
            .ok_or("Invalid MuPDF pixel length")?;
        if width <= 0 || height <= 0 || stride != expected_stride || pixels.len() != length || length > 40_000_000 {
            return Err("Invalid MuPDF pixel buffer".into());
        }
        // Try lossless QOI-RGBA compression first (`LLP3`). Typically reduces
        // text PDFs by 15x-40x and scanned pages by 2x-4x over WebView2 IPC;
        // falls back cleanly to raw `LLP2` if savings < 15% or tiny buffer.
        if length >= 256 {
            let max_qoi_len = (length * 85) / 100;
            let initial_cap = 52 + (length / 8).clamp(4096, 2_097_152).min(max_qoi_len);
            let mut out = Vec::with_capacity(initial_cap);
            write_packet_header(
                &mut out,
                b"LLP3",
                width as u32,
                height as u32,
                stride as u32,
                offset_x,
                offset_y,
                matrix,
                0,
            );
            if append_qoi_rgba(pixels, &mut out, max_qoi_len) {
                let payload_len = (out.len() - 52) as u32;
                out[48..52].copy_from_slice(&payload_len.to_le_bytes());
                return Ok(out);
            }
        }
        let packet_len = 52usize.checked_add(length).ok_or("MuPDF packet too large")?;
        let mut out = Vec::with_capacity(packet_len);
        write_packet_header(
            &mut out,
            b"LLP2",
            width as u32,
            height as u32,
            stride as u32,
            offset_x,
            offset_y,
            matrix,
            length as u32,
        );
        out.extend_from_slice(pixels);
        Ok(out)
    }

    fn render_packet(page: &LlImage) -> Result<Vec<u8>, String> {
        let stride = page.width.checked_mul(4).ok_or("Invalid MuPDF width")?;
        let length = usize::try_from(stride).ok()
            .and_then(|s| usize::try_from(page.height).ok().and_then(|h| s.checked_mul(h)))
            .ok_or("Invalid MuPDF pixel length")?;
        if page.width <= 0 || page.height <= 0 || page.stride != stride ||
            page.length != length || page.samples.is_null() || length > 40_000_000 {
            return Err("Invalid MuPDF pixel buffer".into());
        }
        let pixels = unsafe { std::slice::from_raw_parts(page.samples, length) };
        encode_render_packet_slice(pixels, page.width, page.height, page.stride, page.x, page.y, page.matrix)
    }

    #[tauri::command]
    pub fn mupdf_is_available() -> bool { true }

    pub(crate) fn native_snapshot_dir_public(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        native_snapshot_dir(app)
    }

    fn native_snapshot_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        let configured = std::env::var_os("LINDEN_NATIVE_CACHE_DIR")
            .or_else(|| option_env!("LINDEN_NATIVE_CACHE_DIR").map(std::ffi::OsString::from));
        #[cfg(not(debug_assertions))]
        let configured = std::env::var_os("LINDEN_NATIVE_CACHE_DIR");

        if let Some(configured) = configured {
            let path = PathBuf::from(configured);
            if path.is_absolute() && std::fs::create_dir_all(&path).is_ok() {
                return Ok(path);
            }
        }
        // Snapshot-only Android imports must survive eviction of the app cache.
        let data_root = if cfg!(target_os = "android") {
            app.path().app_data_dir()
        } else {
            app.path().app_cache_dir()
        };
        let fallback = data_root.map(|p| p.join("pdf-native"))
            .map_err(|e| format!("Cannot locate native PDF cache: {e}"))?;
        let _ = std::fs::create_dir_all(&fallback);
        Ok(fallback)
    }

    // Legacy IndexedDB PDFs must be staged from their saved bytes, never from a
    // mutable original path. Raw IPC avoids expanding tens of MB into JSON arrays.
    #[tauri::command]
    pub async fn mupdf_stage_pdf_bytes(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
        let bytes = match request.body() {
            tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= 128 * 1024 * 1024 => bytes.clone(),
            _ => return Err("Expected a PDF binary payload of at most 128 MiB".into()),
        };
        let root = native_snapshot_dir(&app)?;
        tauri::async_runtime::spawn_blocking(move || super::write_saved_pdf_snapshot(&root, &bytes))
            .await.map_err(|e| format!("PDF snapshot worker failed: {e}"))?
    }

    #[tauri::command]
    pub async fn mupdf_stage_pdf(app: tauri::AppHandle, file_path: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let source = Path::new(&file_path);
            if !source.is_file() || !source.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
                return Err("Native staging requires a local PDF file".into());
            }
            if !file_has_pdf_header_prefix(source)? {
                return Err("Native staging requires a valid PDF binary payload".into());
            }
            let root = native_snapshot_dir(&app)?;
            let input = std::fs::File::open(source).map_err(|e| format!("Cannot open PDF source: {e}"))?;
            super::super::fs::stage_book_snapshot(&root, input, "pdf")
        }).await.map_err(|e| format!("PDF stage worker failed: {e}"))?
    }

    fn rgb_to_hex(col: [f32; 3]) -> String {
        let r = (col[0].clamp(0.0, 1.0) * 255.0).round() as u8;
        let g = (col[1].clamp(0.0, 1.0) * 255.0).round() as u8;
        let b = (col[2].clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    fn extract_annots_from_doc(doc: *mut LlDoc) -> Result<Vec<ExtractedPdfAnnot>, String> {
        let mut raw = LlPdfAnnotList { items: std::ptr::null_mut(), count: 0 };
        let status = unsafe { ll_extract_pdf_annots(doc, 2000, &mut raw) };
        let result = if status != LL_OK {
            Err(native_error(doc))
        } else {
            let mut out = Vec::with_capacity(raw.count.max(0) as usize);
            if raw.count > 0 && !raw.items.is_null() {
                let slice = unsafe { std::slice::from_raw_parts(raw.items, raw.count as usize) };
                for item in slice {
                    let annot_type = match item.annot_type {
                        0 => "highlight",
                        1 => "underline",
                        2 => "strikeout",
                        3 => "squiggly",
                        4 => "note",
                        5 => "freetext",
                        6 => "ink",
                        _ => "highlight",
                    }
                    .to_string();
                    let quads: Vec<[f32; 8]> = if item.quad_count > 0 && !item.quads.is_null() {
                        unsafe { std::slice::from_raw_parts(item.quads, item.quad_count as usize) }
                            .iter()
                            .map(|q| q.xy)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let bw = (item.page_bounds[2] - item.page_bounds[0]).abs().max(0.001);
                    let bh = (item.page_bounds[3] - item.page_bounds[1]).abs().max(0.001);
                    let mut rects: Vec<[f32; 4]> = quads
                        .iter()
                        .map(|q| {
                            let min_x = q[0].min(q[2]).min(q[4]).min(q[6]);
                            let max_x = q[0].max(q[2]).max(q[4]).max(q[6]);
                            let min_y = q[1].min(q[3]).min(q[5]).min(q[7]);
                            let max_y = q[1].max(q[3]).max(q[5]).max(q[7]);
                            [
                                ((min_x - item.page_bounds[0]) / bw).clamp(0.0, 1.0),
                                ((min_y - item.page_bounds[1]) / bh).clamp(0.0, 1.0),
                                ((max_x - item.page_bounds[0]) / bw).clamp(0.0, 1.0),
                                ((max_y - item.page_bounds[1]) / bh).clamp(0.0, 1.0),
                            ]
                        })
                        .collect();
                    if rects.is_empty() && item.rect[2] > item.rect[0] && item.rect[3] > item.rect[1] {
                        rects.push(item.rect);
                    }
                    let text = if item.text.is_null() {
                        None
                    } else {
                        let s = unsafe { CStr::from_ptr(item.text) }.to_string_lossy().into_owned();
                        if s.trim().is_empty() { None } else { Some(s) }
                    };
                    let author = if item.author.is_null() {
                        None
                    } else {
                        let s = unsafe { CStr::from_ptr(item.author) }.to_string_lossy().into_owned();
                        if s.trim().is_empty() { None } else { Some(s) }
                    };
                    let quote_text = if item.quote_text.is_null() {
                        None
                    } else {
                        let s = unsafe { CStr::from_ptr(item.quote_text) }.to_string_lossy().into_owned();
                        if s.trim().is_empty() { None } else { Some(s) }
                    };
                    out.push(ExtractedPdfAnnot {
                        page: item.page.max(0) as usize,
                        annot_type,
                        color: rgb_to_hex(item.color),
                        opacity: item.opacity.clamp(0.05, 1.0),
                        rect: item.rect,
                        page_bounds: item.page_bounds,
                        quads,
                        rects,
                        text,
                        author,
                        quote_text,
                    });
                }
            }
            Ok(out)
        };
        unsafe { ll_free_pdf_annots(&mut raw) };
        result
    }

    struct PrewarmedSession {
        canonical_path: PathBuf,
        num_pages: usize,
        width: f32,
        height: f32,
        title: Option<String>,
        author: Option<String>,
        parallel: bool,
        tx: mpsc::Sender<DocCommand>,
        cancels: CancellationMap,
        created_at: Instant,
        prewarm_frame: Option<(usize, f32, Vec<u8>)>,
    }

    static PREWARM_SESSIONS: OnceLock<Mutex<Vec<PrewarmedSession>>> = OnceLock::new();
    static PREWARM_FRAMES: OnceLock<Mutex<HashMap<String, (usize, f32, Vec<u8>, Instant)>>> = OnceLock::new();

    fn prewarm_sessions_store() -> &'static Mutex<Vec<PrewarmedSession>> {
        PREWARM_SESSIONS.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn prewarm_frames_store() -> &'static Mutex<HashMap<String, (usize, f32, Vec<u8>, Instant)>> {
        PREWARM_FRAMES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn prune_stale_prewarms(sessions: &mut Vec<PrewarmedSession>) {
        let now = Instant::now();
        let mut i = 0;
        while i < sessions.len() {
            if now.duration_since(sessions[i].created_at).as_secs() >= 30 {
                let expired = sessions.remove(i);
                let _ = expired.tx.send(DocCommand::Close);
            } else {
                i += 1;
            }
        }
        while sessions.len() >= 2 {
            let oldest = sessions.remove(0);
            let _ = oldest.tx.send(DocCommand::Close);
        }
    }

    pub fn prewarm_pdf_launch(app: &tauri::AppHandle, file_path: String) {
        let app_handle = app.clone();
        let _ = thread::Builder::new().name("ll-mupdf-prewarm".into()).spawn(move || {
            let Ok(canon) = super::authorize_direct_pdf_path(Path::new(&file_path)) else {
                return;
            };
            let (target_page, target_scale) = super::read_quick_index_entry(&app_handle, &canon)
                .unwrap_or((0usize, 1.25f32));
            let max_store_mb = DEFAULT_STORE_MB.load(Ordering::Relaxed).clamp(32, 1024);
            let parallel = cfg!(target_os = "windows");
            let (tx, rx) = mpsc::channel();
            let cancels = Arc::new(Mutex::new(HashMap::new()));
            let (ready_tx, ready_rx) = oneshot::channel();
            let worker_cancels = cancels.clone();
            let worker_path = canon.to_string_lossy().into_owned();
            if thread::Builder::new()
                .name("ll-mupdf-prewarm-doc".into())
                .spawn(move || {
                    worker(worker_path, String::new(), max_store_mb, parallel, rx, worker_cancels, ready_tx)
                })
                .is_err()
            {
                return;
            }
            let Ok(Ok(OpenDocument { pages, first, title, author, parallel })) = ready_rx.blocking_recv() else {
                return;
            };
            let mut frame: Option<(usize, f32, Vec<u8>)> = None;
            if pages > 0 {
                let clamped_page = target_page.min(pages - 1);
                if let Ok(cancel) = CancelHandle::new().map(Arc::new) {
                    let req_id = format!("prewarm:{clamped_page}");
                    if let Ok(mut m) = cancels.lock() {
                        m.insert(req_id.clone(), cancel.clone());
                    }
                    let (ftx, frx) = oneshot::channel();
                    if tx.send(DocCommand::Render(RenderRequest {
                        page: clamped_page,
                        scale: target_scale,
                        rotation: 0.0,
                        clip: None,
                        mobile_tile: None,
                        cancel,
                        request_id: req_id,
                        priority: 0,
                        generation: 0,
                        enqueued_at: Instant::now(),
                        reply: ftx,
                    })).is_ok() {
                        if let Ok(Ok(packet)) = frx.blocking_recv() {
                            frame = Some((clamped_page, target_scale, packet));
                        }
                    }
                }
            }
            let width = (first[2] - first[0]).abs().max(1.0);
            let height = (first[3] - first[1]).abs().max(1.0);
            let resolved_title = title.or_else(|| canon.file_stem().map(|x| x.to_string_lossy().into_owned()));
            if let Ok(mut store) = prewarm_sessions_store().lock() {
                prune_stale_prewarms(&mut store);
                store.push(PrewarmedSession {
                    canonical_path: canon,
                    num_pages: pages,
                    width,
                    height,
                    title: resolved_title,
                    author,
                    parallel,
                    tx,
                    cancels,
                    created_at: Instant::now(),
                    prewarm_frame: frame,
                });
            }
        });
    }

    #[tauri::command]
    pub async fn mupdf_open_document(
        app: tauri::AppHandle,
        file_path: String,
        password: Option<String>,
        expected_size: Option<u64>,
        max_store_mb: Option<u32>,
        window_label: Option<String>,
        parallel_rendering: Option<bool>,
        direct_read_only: Option<bool>,
    ) -> Result<DocumentMetadata, String> {
        let max_store_mb = max_store_mb.unwrap_or_else(|| DEFAULT_STORE_MB.load(Ordering::Relaxed)).clamp(32, 1024);
        let parallel = cfg!(target_os = "windows") && parallel_rendering.unwrap_or(false);
        let is_direct = direct_read_only.unwrap_or(false);
        if file_path.trim().is_empty() {
            return Err("MuPDF requires a local file path".into());
        }
        let raw_path = Path::new(&file_path);
        if !raw_path.exists() || !raw_path.is_file() {
            return Err("MuPDF requires an existing readable local file".into());
        }
        let actual_path = std::fs::canonicalize(raw_path)
            .map_err(|e| format!("Native PDF file unavailable: {e}"))?;
        let actual_size = std::fs::metadata(&actual_path).map_err(|e| e.to_string())?.len();
        if actual_size == 0 {
            return Err("Native PDF file size cannot be zero".into());
        }
        if is_direct {
            if !super::is_authorized_direct_pdf_path(&actual_path) {
                super::authorize_direct_pdf_path(&actual_path)?;
            }
            if let Some(sz) = expected_size.filter(|&s| s > 0) {
                if actual_size != sz {
                    return Err("Native PDF file size changed before open".into());
                }
            }
        } else {
            let size = expected_size.ok_or_else(|| "Native PDF open requires expectedSize to verify snapshot boundary".to_string())?;
            if size == 0 {
                return Err("Native PDF snapshot size cannot be zero".into());
            }
            let root = std::fs::canonicalize(native_snapshot_dir(&app)?)
                .map_err(|e| format!("Native PDF cache unavailable: {e}"))?;
            if actual_path.parent() != Some(root.as_path()) {
                return Err("Native PDF snapshot is outside the app cache".into());
            }
            let file_name = actual_path.file_name().and_then(|s| s.to_str()).ok_or("Invalid snapshot filename")?;
            if !file_name.starts_with("snapshot-") || !file_name.ends_with(".pdf") {
                return Err("Invalid native PDF snapshot file format".into());
            }
            if actual_size != size {
                return Err("Native PDF snapshot size differs from the indexed Blob".into());
            }
        }
        if !file_has_pdf_header_prefix(&actual_path)? {
            return Err("Invalid native PDF binary payload".into());
        }

        if password.as_deref().unwrap_or("").is_empty() {
            let claimed = prewarm_sessions_store().lock().ok().and_then(|mut guard| {
                let now = Instant::now();
                let mut i = 0;
                while i < guard.len() {
                    if now.duration_since(guard[i].created_at).as_secs() >= 30 {
                        let expired = guard.remove(i);
                        let _ = expired.tx.send(DocCommand::Close);
                    } else {
                        i += 1;
                    }
                }
                guard.iter().position(|p| p.canonical_path == actual_path).map(|idx| guard.remove(idx))
            });
            if let Some(mut prewarmed) = claimed {
                let doc_id = make_doc_id();
                if let Some(ref win) = window_label {
                    register_window_doc(win, &doc_id);
                }
                if let Some((ppage, pscale, packet)) = prewarmed.prewarm_frame.take() {
                    if let Ok(mut frames) = prewarm_frames_store().lock() {
                        frames.retain(|_, (_, _, _, ts)| ts.elapsed().as_secs() < 15);
                        frames.insert(doc_id.clone(), (ppage, pscale, packet, Instant::now()));
                    }
                }
                if let Ok(mut store_guard) = store().lock() {
                    store_guard.insert(
                        doc_id.clone(),
                        DocumentSession {
                            tx: prewarmed.tx,
                            cancels: prewarmed.cancels,
                            num_pages: prewarmed.num_pages,
                            file_path: actual_path.clone(),
                            password,
                        },
                    );
                }
                return Ok(DocumentMetadata {
                    doc_id,
                    num_pages: prewarmed.num_pages,
                    default_width: prewarmed.width,
                    default_height: prewarmed.height,
                    title: prewarmed.title,
                    author: prewarmed.author,
                    format: "PDF".into(),
                    native_backend: true,
                    parallel_rendering: prewarmed.parallel,
                });
            }
        }

        let doc_id = make_doc_id();
        if let Some(ref win) = window_label {
            register_window_doc(win, &doc_id);
        }
        let (tx, rx) = mpsc::channel();
        let cancels = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let worker_cancels = cancels.clone();
        let worker_path = actual_path.to_string_lossy().into_owned();
        let pw_clone = password.clone();
        thread::Builder::new().name(format!("ll-mupdf-{doc_id}")).spawn(move || {
            worker(worker_path, pw_clone.unwrap_or_default(), max_store_mb, parallel, rx, worker_cancels, ready_tx)
        }).map_err(|e| format!("Failed to start MuPDF worker: {e}"))?;

        let open_res = ready_rx.await.map_err(|_| "MuPDF worker exited during open".to_string())?;
        let OpenDocument { pages: num_pages, first: bounds, title: native_title, author: native_author, parallel } = match open_res {
            Ok(data) => data,
            Err(e) => {
                if let Some(ref win) = window_label {
                    if let Ok(mut win_store) = window_docs_store().lock() {
                        if let Some(docs) = win_store.get_mut(win) {
                            docs.retain(|d| d != &doc_id);
                        }
                    }
                }
                return Err(e);
            }
        };

        {
            let win_guard = window_docs_store().lock().map_err(|e| e.to_string())?;
            let mut store_guard = store().lock().map_err(|e| e.to_string())?;
            if let Some(ref win) = window_label {
                let is_alive = win_guard.get(win).map(|d| d.iter().any(|id| id == &doc_id)).unwrap_or(false);
                if !is_alive {
                    let _ = tx.send(DocCommand::Close);
                    return Err("Window closed while opening document".to_string());
                }
            }
            store_guard.insert(
                doc_id.clone(),
                DocumentSession { tx, cancels, num_pages, file_path: actual_path.clone(), password },
            );
        }
        let width = (bounds[2] - bounds[0]).abs().max(1.0);
        let height = (bounds[3] - bounds[1]).abs().max(1.0);
        let title = native_title.or_else(|| actual_path.file_stem().map(|x| x.to_string_lossy().into_owned()));
        Ok(DocumentMetadata {
            doc_id, num_pages, default_width: width, default_height: height,
            title, author: native_author, format: "PDF".into(), native_backend: true, parallel_rendering: parallel,
        })
    }

    #[tauri::command]
    pub async fn mupdf_get_page_bounds_range(doc_id: String, start_page: usize, count: usize) -> Result<Vec<f32>, String> {
        let s = session(&doc_id)?;
        if start_page >= s.num_pages || count == 0 { return Ok(Vec::new()); }
        let count = count.min(s.num_pages - start_page).min(i32::MAX as usize);
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Bounds { start: start_page, count, reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped bounds request".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_get_page_sizes(doc_id: String) -> Result<Vec<f32>, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Bounds { start: 0, count: s.num_pages.min(i32::MAX as usize), reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        let bounds = rx.await.map_err(|_| "MuPDF worker dropped bounds request".to_string())??;
        Ok(bounds.chunks_exact(4).flat_map(|b| [(b[2] - b[0]).abs(), (b[3] - b[1]).abs()]).collect())
    }

    #[tauri::command]
    pub async fn mupdf_get_text_layer(doc_id: String, page_index: usize) -> Result<TextLayerResponse, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Text { page: page_index, reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped text request".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_select(doc_id: String, page_index: usize, a: [f32; 2], b: [f32; 2], mode: Option<String>) -> Result<SelectionResponse, String> {
        let mode = match mode.as_deref() { Some("word") => 1, Some("line") => 2, _ => 0 };
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Select { page: page_index, a, b, mode, reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped selection request".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_render_page(doc_id: String, page_index: usize, scale: f32,
                                   rotation: Option<f32>, clip: Option<[f32; 4]>,
                                   request_id: String,
                                   priority: Option<u8>,
                                   generation: Option<u32>) -> Result<Response, String> {
        let rot = rotation.unwrap_or(0.0);
        if clip.is_none() && rot.abs() < 1e-3 {
            let cached = prewarm_frames_store().lock().ok().and_then(|mut map| {
                map.retain(|_, (_, _, _, ts)| ts.elapsed().as_secs() < 15);
                let matches = map.get(&doc_id)
                    .map(|(p, s, _, _)| *p == page_index && (scale - *s).abs() <= 0.12)
                    .unwrap_or(false);
                if matches {
                    map.remove(&doc_id).map(|(_, _, pkt, _)| pkt)
                } else {
                    None
                }
            });
            if let Some(packet) = cached {
                return Ok(Response::new(packet));
            }
        }
        let s = session(&doc_id)?;
        let cancel = Arc::new(CancelHandle::new()?);
        let cancel_check = cancel.clone();
        s.cancels.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), cancel.clone());
        let (tx, rx) = oneshot::channel();
        if s.tx.send(DocCommand::Render(RenderRequest {
            page: page_index, scale, rotation: rotation.unwrap_or(0.0), clip,
            mobile_tile: None,
            cancel, request_id: request_id.clone(),
            priority: priority.unwrap_or(0),
            generation: generation.unwrap_or(0),
            enqueued_at: Instant::now(),
            reply: tx,
        })).is_err() {
            if let Ok(mut m) = s.cancels.lock() { m.remove(&request_id); }
            return Err("MuPDF worker is closed".into());
        }
        let packet = rx.await.map_err(|_| "MuPDF worker dropped render request".to_string())??;
        if cancel_check.is_aborted() {
            return Err("render cancelled".into());
        }
        Ok(Response::new(packet))
    }

    fn build_mobile_render_plan(
        doc: *mut LlDoc,
        page: usize,
        scale: f32,
        rotation: f32,
        visible_page_rect: Option<[f32; 4]>,
        quality: i32,
        memory_mb: u32,
    ) -> Result<MobileRenderPlan, String> {
        let mut bounds = [0f32; 4];
        if unsafe { ll_page_bounds(doc, page as c_int, bounds.as_mut_ptr()) } != LL_OK {
            return Err(native_error(doc));
        }
        let mut raw = LlMobileRenderPlan {
            scale: 0.0,
            rotation: 0.0,
            matrix: [0.0; 6],
            region: [0; 4],
            tile_edge: 0,
            bleed: 0,
            columns: 0,
            rows: 0,
            tile_count: 0,
            max_tile_bytes: 0,
        };
        let visible_ptr = visible_page_rect.as_ref().map_or(std::ptr::null(), |r| r.as_ptr());
        if unsafe { ll_mobile_plan_render(bounds.as_ptr(), scale, rotation, visible_ptr, quality, memory_mb, &mut raw) } != LL_OK {
            return Err("Invalid mobile MuPDF render geometry".into());
        }
        let mut tiles = Vec::with_capacity(raw.tile_count.max(0) as usize);
        for index in 0..raw.tile_count {
            let mut tile = LlMobileTile { content: [0; 4], clip: [0.0; 4], rgba_bytes: 0 };
            if unsafe { ll_mobile_tile_at(&raw, index, &mut tile) } != LL_OK {
                return Err("Mobile MuPDF tile exceeds memory cap".into());
            }
            tiles.push(MobileRenderTile {
                content: tile.content,
                clip: tile.clip,
                rgba_bytes: tile.rgba_bytes,
            });
        }
        Ok(MobileRenderPlan {
            scale: raw.scale,
            rotation: raw.rotation,
            matrix: raw.matrix,
            region: raw.region,
            tile_edge: raw.tile_edge,
            bleed: raw.bleed,
            columns: raw.columns,
            rows: raw.rows,
            max_tile_bytes: raw.max_tile_bytes,
            tiles,
        })
    }

    #[tauri::command]
    pub async fn mupdf_plan_mobile_render(
        doc_id: String,
        page_index: usize,
        scale: f32,
        rotation: Option<f32>,
        visible_page_rect: Option<[f32; 4]>,
        quality: i32,
        memory_mb: Option<u32>,
    ) -> Result<MobileRenderPlan, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::PlanMobileRender {
            page: page_index,
            scale,
            rotation: rotation.unwrap_or(0.0),
            visible_page_rect,
            quality,
            memory_mb: memory_mb.unwrap_or(0),
            reply: tx,
        }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped mobile render plan".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_render_mobile_tile(
        doc_id: String,
        page_index: usize,
        plan: MobileRenderPlan,
        tile_index: i32,
        request_id: String,
        generation: Option<u32>,
    ) -> Result<Response, String> {
        let s = session(&doc_id)?;
        let tile_count = plan.columns.checked_mul(plan.rows)
            .filter(|&n| n > 0 && n as usize == plan.tiles.len())
            .ok_or_else(|| "Invalid mobile render plan tile count".to_string())?;
        if tile_index < 0 || tile_index >= tile_count {
            return Err("Mobile tile index out of range".into());
        }
        let raw_plan = LlMobileRenderPlan {
            scale: plan.scale,
            rotation: plan.rotation,
            matrix: plan.matrix,
            region: plan.region,
            tile_edge: plan.tile_edge,
            bleed: plan.bleed,
            columns: plan.columns,
            rows: plan.rows,
            tile_count,
            max_tile_bytes: plan.max_tile_bytes,
        };
        let cancel = Arc::new(CancelHandle::new()?);
        let cancel_check = cancel.clone();
        s.cancels.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), cancel.clone());
        let (tx, rx) = oneshot::channel();
        if s.tx.send(DocCommand::Render(RenderRequest {
            page: page_index,
            scale: plan.scale,
            rotation: plan.rotation,
            clip: None,
            mobile_tile: Some((raw_plan, tile_index)),
            cancel,
            request_id: request_id.clone(),
            priority: 0,
            generation: generation.unwrap_or(0),
            enqueued_at: Instant::now(),
            reply: tx,
        })).is_err() {
            if let Ok(mut m) = s.cancels.lock() { m.remove(&request_id); }
            return Err("MuPDF worker is closed".into());
        }
        let packet = rx.await.map_err(|_| "MuPDF worker dropped mobile tile render".to_string())??;
        if cancel_check.is_aborted() {
            return Err("render cancelled".into());
        }
        Ok(Response::new(packet))
    }

    #[tauri::command]
    pub fn mupdf_enable_diagnostics(enable: bool) {
        DIAGNOSTICS_ENABLED.store(enable, Ordering::Relaxed);
        if !enable {
            if let Ok(mut s) = diagnostics_store().lock() {
                s.clear();
            }
        }
    }

    #[tauri::command]
    pub fn mupdf_get_render_diagnostics() -> Vec<RenderDiagnostics> {
        diagnostics_store().lock().map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    #[tauri::command]
    pub fn mupdf_cancel_render(doc_id: String, request_id: String) -> bool {
        let Ok(s) = session(&doc_id) else { return false };
        let handle = s.cancels.lock().ok().and_then(|m| m.get(&request_id).cloned());
        if let Some(handle) = handle { handle.abort(); true } else { false }
    }

    #[tauri::command]
    pub async fn mupdf_get_outline_flat(doc_id: String) -> Result<Vec<FlatOutlineItem>, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Outline { reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped outline request".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_get_links(doc_id: String, page_index: usize) -> Result<Vec<PdfLinkItem>, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::Links { page: page_index, reply: tx }).map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "MuPDF worker dropped links request".to_string())?
    }

    #[tauri::command]
    pub fn mupdf_close_document(doc_id: String) -> bool {
        if let Ok(mut win_store) = window_docs_store().lock() {
            for docs in win_store.values_mut() {
                docs.retain(|d| d != &doc_id);
            }
        }
        let session = store().lock().ok().and_then(|mut m| m.remove(&doc_id));
        if let Some(s) = session {
            if let Ok(map) = s.cancels.lock() { for handle in map.values() { handle.abort(); } }
            let _ = s.tx.send(DocCommand::Close);
            true
        } else { false }
    }

    #[tauri::command]
    pub async fn mupdf_validate_snapshot(app: tauri::AppHandle, snapshot_path: String, expected_size: u64) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let root = match std::fs::canonicalize(native_snapshot_dir(&app)?) { Ok(x) => x, Err(_) => return Ok(false) };
            let path = match std::fs::canonicalize(snapshot_path) { Ok(x) => x, Err(_) => return Ok(false) };
            if path.parent() != Some(root.as_path()) { return Ok(false); }
            let name = path.file_name().and_then(|x| x.to_str()).unwrap_or("");
            if !name.starts_with("snapshot-") || !(name.ends_with(".pdf") || name.ends_with(".epub")) { return Ok(false); }
            let meta = match std::fs::metadata(path) { Ok(x) => x, Err(_) => return Ok(false) };
            Ok(meta.is_file() && meta.len() > 0 && (expected_size == 0 || meta.len() == expected_size))
        }).await.map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_reclaim_snapshot(app: tauri::AppHandle, snapshot_path: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let path_str = snapshot_path.trim();
            if path_str.is_empty() {
                return Err("Snapshot path cannot be empty".into());
            }
            if path_str.contains('*') || path_str.contains('?') {
                return Err("Wildcards are not permitted in snapshot reclaim".into());
            }
            let raw_path = Path::new(path_str);
            if !raw_path.exists() {
                return Ok(false);
            }
            let root = std::fs::canonicalize(native_snapshot_dir(&app)?)
                .map_err(|e| format!("Native PDF cache unavailable: {e}"))?;
            let actual_path = std::fs::canonicalize(raw_path)
                .map_err(|e| format!("Cannot resolve snapshot path: {e}"))?;

            if actual_path.parent() != Some(root.as_path()) {
                return Err("Refusing to reclaim file outside native PDF cache".into());
            }
            if !actual_path.is_file() {
                return Err("Target snapshot is not a regular file".into());
            }
            let file_name = actual_path.file_name().and_then(|s| s.to_str())
                .ok_or_else(|| "Invalid snapshot filename".to_string())?;
            if !file_name.starts_with("snapshot-") || !(file_name.ends_with(".pdf") || file_name.ends_with(".epub") || file_name.ends_with(".part")) {
                return Err("Refusing to reclaim non-snapshot file".into());
            }
            if let Ok(store) = store().lock() {
                if store.values().any(|s| s.file_path == actual_path) {
                    return Err("Cannot reclaim snapshot: actively in use by open document session".into());
                }
            }
            let mut last_err = None;
            for attempt in 0..5 {
                match std::fs::remove_file(&actual_path) {
                    Ok(()) => return Ok(true),
                    Err(e) => {
                        last_err = Some(e);
                        if attempt < 4 {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                    }
                }
            }
            Err(format!("Failed to remove snapshot file: {}", last_err.unwrap()))
        }).await.map_err(|e| format!("Snapshot reclaim worker failed: {e}"))?
    }

    #[tauri::command]
    pub fn mupdf_set_store_limit(max_mb: u32) -> Result<u32, String> {
        let clamped = max_mb.clamp(32, 1024);
        DEFAULT_STORE_MB.store(clamped, Ordering::Relaxed);
        unsafe { ll_set_max_store_mb(clamped); }
        Ok(clamped)
    }

    #[tauri::command]
    pub async fn mupdf_get_plain_text(
        doc_id: String,
        page_index: usize,
    ) -> Result<String, String> {
        let s = session(&doc_id)?;
        if page_index >= s.num_pages {
            return Err(format!("Page index {} out of bounds (num_pages: {})", page_index, s.num_pages));
        }
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::PlainText { page: page_index, reply: tx })
            .map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "Worker dropped PlainText reply channel".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_extract_annotations(doc_id: String) -> Result<Vec<ExtractedPdfAnnot>, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::ExtractAnnotations { reply: tx })
            .map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "Worker dropped ExtractAnnotations reply channel".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_compute_auto_crop(doc_id: String) -> Result<AutoCropMargins, String> {
        let s = session(&doc_id)?;
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::ComputeAutoCrop { reply: tx })
            .map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "Worker dropped ComputeAutoCrop reply channel".to_string())?
    }

    #[tauri::command]
    pub async fn mupdf_get_page_image_rects(
        doc_id: String,
        page_index: usize,
    ) -> Result<Vec<[f32; 4]>, String> {
        let s = session(&doc_id)?;
        if page_index >= s.num_pages {
            return Err(format!("Page index {} out of bounds", page_index));
        }
        let (tx, rx) = oneshot::channel();
        s.tx.send(DocCommand::PageImageRects { page: page_index, reply: tx })
            .map_err(|_| "MuPDF worker is closed".to_string())?;
        rx.await.map_err(|_| "Worker dropped PageImageRects reply channel".to_string())?
    }

    #[derive(serde::Deserialize)]
    struct ExportAnnotationItem {
        page: usize,
        #[serde(rename = "type")]
        annot_type: Option<String>,
        color: Option<String>,
        opacity: Option<f32>,
        rect: Option<[f32; 4]>,
        quads: Option<Vec<f32>>,
        text: Option<String>,
        author: Option<String>,
        strokes: Option<Vec<Vec<[f32; 2]>>>,
        width: Option<f32>,
    }

    fn sanitize_cstring(s: &str) -> CString {
        if !s.as_bytes().contains(&0) {
            if let Ok(cs) = CString::new(s) {
                return cs;
            }
        }
        let cleaned: String = s.chars().filter(|&c| c != '\0').collect();
        CString::new(cleaned).unwrap_or_default()
    }

    fn parse_css_color(raw: Option<&str>) -> ([f32; 3], Option<f32>) {
        let fallback = ([1.0, 0.9, 0.0], None);
        let Some(input) = raw else { return fallback; };
        let trimmed = input.trim();
        if trimmed.is_empty() || !trimmed.is_ascii() {
            return fallback;
        }
        let lower = trimmed.to_ascii_lowercase();
        let named = match lower.as_str() {
            "yellow" => Some([250.0, 204.0, 21.0]),
            "green" => Some([34.0, 197.0, 94.0]),
            "blue" => Some([59.0, 130.0, 246.0]),
            "pink" => Some([236.0, 72.0, 153.0]),
            "purple" => Some([168.0, 85.0, 247.0]),
            "red" => Some([239.0, 68.0, 68.0]),
            "orange" => Some([249.0, 115.0, 22.0]),
            "gray" | "grey" => Some([148.0, 163.0, 184.0]),
            "black" => Some([0.0, 0.0, 0.0]),
            "white" => Some([255.0, 255.0, 255.0]),
            _ => None,
        };
        if let Some([r, g, b]) = named {
            return ([r / 255.0, g / 255.0, b / 255.0], None);
        }
        if let Some(hex) = lower.strip_prefix('#') {
            if hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                match hex.len() {
                    3 | 4 => {
                        let bytes = hex.as_bytes();
                        let nibble = |b: u8| -> Option<f32> {
                            let val = (b as char).to_digit(16)? as f32;
                            Some((val * 17.0) / 255.0)
                        };
                        if let (Some(r), Some(g), Some(b)) = (nibble(bytes[0]), nibble(bytes[1]), nibble(bytes[2])) {
                            let alpha = if hex.len() == 4 { nibble(bytes[3]) } else { None };
                            return ([r, g, b], alpha);
                        }
                    }
                    6 | 8 => {
                        if let (Ok(r), Ok(g), Ok(b)) = (
                            u8::from_str_radix(&hex[0..2], 16),
                            u8::from_str_radix(&hex[2..4], 16),
                            u8::from_str_radix(&hex[4..6], 16),
                        ) {
                            let alpha = if hex.len() == 8 {
                                u8::from_str_radix(&hex[6..8], 16).ok().map(|a| a as f32 / 255.0)
                            } else {
                                None
                            };
                            return ([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0], alpha);
                        }
                    }
                    _ => {}
                }
            }
            return fallback;
        }
        if let Some(inner) = lower
            .strip_prefix("rgba(")
            .or_else(|| lower.strip_prefix("rgb("))
            .and_then(|s| s.strip_suffix(')'))
        {
            let parts: Vec<&str> = inner.split(',').map(|p| p.trim()).collect();
            if parts.len() == 3 || parts.len() == 4 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    parts[0].parse::<f32>(),
                    parts[1].parse::<f32>(),
                    parts[2].parse::<f32>(),
                ) {
                    let alpha = if parts.len() == 4 {
                        parts[3].parse::<f32>().ok().filter(|a| a.is_finite()).map(|a| a.clamp(0.0, 1.0))
                    } else {
                        None
                    };
                    if r.is_finite() && g.is_finite() && b.is_finite() {
                        return ([
                            r.clamp(0.0, 255.0) / 255.0,
                            g.clamp(0.0, 255.0) / 255.0,
                            b.clamp(0.0, 255.0) / 255.0,
                        ], alpha);
                    }
                }
            }
        }
        fallback
    }

    fn paths_refer_to_same_target(a: &Path, b: &Path) -> bool {
        if let (Ok(ca), Ok(cb)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            return ca == cb;
        }
        match (a.parent(), b.parent(), a.file_name(), b.file_name()) {
            (Some(pa), Some(pb), Some(fa), Some(fb)) if fa == fb => {
                std::fs::canonicalize(pa).ok() == std::fs::canonicalize(pb).ok()
            }
            _ => a == b,
        }
    }

    #[tauri::command]
    pub async fn mupdf_export_annotated_pdf(
        doc_id: String,
        output_path: String,
        annotations_json: String,
    ) -> Result<bool, String> {
        let s = session(&doc_id)?;
        let file_path = s.file_path;
        let num_pages = s.num_pages;
        let password = s.password.clone();
        if output_path.trim().is_empty() {
            return Err("Output path is required".into());
        }
        if paths_refer_to_same_target(Path::new(&output_path), &file_path) {
            return Err("Output path cannot overwrite the active source PDF".into());
        }
        let items: Vec<ExportAnnotationItem> = serde_json::from_str(&annotations_json)
            .map_err(|e| format!("Invalid annotations JSON: {e}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            let input_c = CString::new(file_path.to_string_lossy().as_bytes())
                .map_err(|e| format!("Invalid input path: {e}"))?;
            let output_c = CString::new(output_path.as_str())
                .map_err(|e| format!("Invalid output path: {e}"))?;
            let pass_c = password.as_deref().map(sanitize_cstring);
            let pass_ptr = pass_c.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null());

            let mut c_annots = Vec::new();
            let mut text_c_strings = Vec::new();
            let mut author_c_strings = Vec::new();
            let mut quad_buffers = Vec::new();
            let mut stroke_count_buffers = Vec::new();
            let mut stroke_point_buffers = Vec::new();

            for item in &items {
                if item.page >= num_pages {
                    continue;
                }
                let a_type = match item.annot_type.as_deref().unwrap_or("highlight") {
                    "highlight" => 0,
                    "underline" => 1,
                    "strikeout" | "strike" => 2,
                    "note" | "text" => 3,
                    "ink" | "drawing" => 4,
                    _ => 0,
                };
                let (col, parsed_alpha) = parse_css_color(item.color.as_deref());
                let raw_op = item.opacity.or(parsed_alpha).unwrap_or(0.8);
                let op = if raw_op.is_finite() { raw_op.clamp(0.0, 1.0) } else { 0.8 };
                let raw_r = item.rect.unwrap_or([0.0, 0.0, 100.0, 100.0]);
                let r = if raw_r.iter().all(|v| v.is_finite()) {
                    [
                        raw_r[0].min(raw_r[2]),
                        raw_r[1].min(raw_r[3]),
                        raw_r[0].max(raw_r[2]),
                        raw_r[1].max(raw_r[3]),
                    ]
                } else {
                    [0.0, 0.0, 100.0, 100.0]
                };

                let t_ptr = if let Some(ref t) = item.text {
                    let cs = sanitize_cstring(t);
                    let ptr = cs.as_ptr();
                    text_c_strings.push(cs);
                    ptr
                } else {
                    std::ptr::null()
                };

                let a_ptr = if let Some(ref a) = item.author {
                    let cs = sanitize_cstring(a);
                    let ptr = cs.as_ptr();
                    author_c_strings.push(cs);
                    ptr
                } else {
                    std::ptr::null()
                };

                let (q_ptr, q_cnt) = if let Some(ref q) = item.quads {
                    let mut clean_quads = Vec::with_capacity(q.len());
                    for quad in q.chunks_exact(8) {
                        if quad.iter().all(|v| v.is_finite()) {
                            clean_quads.extend_from_slice(quad);
                        }
                    }
                    if clean_quads.is_empty() {
                        (std::ptr::null(), 0)
                    } else {
                        let cnt = (clean_quads.len() / 8) as c_int;
                        quad_buffers.push(clean_quads);
                        (quad_buffers.last().unwrap().as_ptr(), cnt)
                    }
                } else {
                    (std::ptr::null(), 0)
                };

                let (sc_ptr, sp_ptr, s_cnt) = if let Some(ref strokes) = item.strokes {
                    let mut counts = Vec::new();
                    let mut points = Vec::new();
                    for stroke in strokes {
                        let clean_pts: Vec<[f32; 2]> = stroke.iter().copied()
                            .filter(|p| p[0].is_finite() && p[1].is_finite())
                            .collect();
                        if clean_pts.is_empty() {
                            continue;
                        }
                        counts.push(clean_pts.len() as c_int);
                        for p in clean_pts {
                            points.push(p[0]);
                            points.push(p[1]);
                        }
                    }
                    if counts.is_empty() {
                        (std::ptr::null(), std::ptr::null(), 0)
                    } else {
                        let cnt = counts.len() as c_int;
                        stroke_count_buffers.push(counts);
                        stroke_point_buffers.push(points);
                        (
                            stroke_count_buffers.last().unwrap().as_ptr(),
                            stroke_point_buffers.last().unwrap().as_ptr(),
                            cnt,
                        )
                    }
                } else {
                    (std::ptr::null(), std::ptr::null(), 0)
                };

                let w = item.width.unwrap_or(2.0);
                let clean_width = if w.is_finite() && w > 0.0 { w.clamp(0.25, 100.0) } else { 2.0 };

                c_annots.push(LlExportAnnot {
                    page: item.page as c_int,
                    annot_type: a_type,
                    color: col,
                    opacity: op,
                    rect: r,
                    quads: q_ptr,
                    quad_count: q_cnt,
                    text: t_ptr,
                    author: a_ptr,
                    stroke_counts: sc_ptr,
                    stroke_points: sp_ptr,
                    stroke_count: s_cnt,
                    width: clean_width,
                });
            }

            let rc = unsafe {
                ll_export_annotated_pdf(
                    input_c.as_ptr(),
                    output_c.as_ptr(),
                    pass_ptr,
                    c_annots.as_ptr(),
                    c_annots.len() as c_int,
                )
            };
            if rc == 0 {
                Ok(true)
            } else {
                Err("Failed to export annotated PDF via MuPDF".to_string())
            }
        }).await.map_err(|e| format!("Export worker task failed: {e}"))?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn write_minimal_two_page_pdf(path: &std::path::Path) {
            let mut pdf = String::from("%PDF-1.4\n");
            let mut offsets = vec![0usize];
            let objs = [
                "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
                "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 5 0 R >>\nendobj\n",
                "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 5 0 R >>\nendobj\n",
                "5 0 obj\n<< /Length 0 >>\nstream\nendstream\nendobj\n",
            ];
            for obj in &objs {
                offsets.push(pdf.len());
                pdf.push_str(obj);
            }
            let xref_pos = pdf.len();
            pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1));
            for off in offsets.iter().skip(1) {
                pdf.push_str(&format!("{:010} 00000 n \n", off));
            }
            pdf.push_str(&format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objs.len() + 1,
                xref_pos
            ));
            std::fs::write(path, pdf.as_bytes()).unwrap();
        }

        #[test]
        fn test_export_annotated_pdf_all_five_subtypes_and_reopen() {
            let tmp_dir = std::env::temp_dir().join(format!("linden_mupdf_annot_test_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&tmp_dir);
            std::fs::create_dir_all(&tmp_dir).unwrap();
            let src_pdf = tmp_dir.join("source.pdf");
            let out_pdf = tmp_dir.join("exported.pdf");
            write_minimal_two_page_pdf(&src_pdf);

            let quads_hl: [f32; 8] = [50.0, 100.0, 200.0, 100.0, 50.0, 120.0, 200.0, 120.0];
            let quads_ul: [f32; 8] = [50.0, 160.0, 220.0, 160.0, 50.0, 178.0, 220.0, 178.0];
            let quads_st: [f32; 8] = [60.0, 200.0, 240.0, 200.0, 60.0, 220.0, 240.0, 220.0];
            let stroke_counts: [c_int; 2] = [2, 2];
            let stroke_points: [f32; 8] = [80.0, 300.0, 140.0, 340.0, 160.0, 340.0, 210.0, 360.0];

            let t_hl = CString::new("hl-note").unwrap();
            let t_note = CString::new("sticky-note").unwrap();
            let author = CString::new("Linden Test").unwrap();

            let annots = [
                LlExportAnnot {
                    page: 0, annot_type: 0, color: [1.0, 0.9, 0.0], opacity: 0.7,
                    rect: [50.0, 100.0, 200.0, 120.0], quads: quads_hl.as_ptr(), quad_count: 1,
                    text: t_hl.as_ptr(), author: author.as_ptr(),
                    stroke_counts: std::ptr::null(), stroke_points: std::ptr::null(), stroke_count: 0, width: 2.0,
                },
                LlExportAnnot {
                    page: 0, annot_type: 1, color: [0.1, 0.6, 0.9], opacity: 0.9,
                    rect: [50.0, 160.0, 220.0, 178.0], quads: quads_ul.as_ptr(), quad_count: 1,
                    text: std::ptr::null(), author: author.as_ptr(),
                    stroke_counts: std::ptr::null(), stroke_points: std::ptr::null(), stroke_count: 0, width: 2.0,
                },
                LlExportAnnot {
                    page: 1, annot_type: 2, color: [0.9, 0.2, 0.2], opacity: 0.85,
                    rect: [60.0, 200.0, 240.0, 220.0], quads: quads_st.as_ptr(), quad_count: 1,
                    text: std::ptr::null(), author: author.as_ptr(),
                    stroke_counts: std::ptr::null(), stroke_points: std::ptr::null(), stroke_count: 0, width: 2.0,
                },
                LlExportAnnot {
                    page: 0, annot_type: 3, color: [1.0, 0.8, 0.2], opacity: 1.0,
                    rect: [300.0, 120.0, 324.0, 144.0], quads: std::ptr::null(), quad_count: 0,
                    text: t_note.as_ptr(), author: author.as_ptr(),
                    stroke_counts: std::ptr::null(), stroke_points: std::ptr::null(), stroke_count: 0, width: 2.0,
                },
                LlExportAnnot {
                    page: 1, annot_type: 4, color: [0.1, 0.7, 0.3], opacity: 0.8,
                    rect: [80.0, 300.0, 210.0, 360.0], quads: std::ptr::null(), quad_count: 0,
                    text: std::ptr::null(), author: author.as_ptr(),
                    stroke_counts: stroke_counts.as_ptr(), stroke_points: stroke_points.as_ptr(), stroke_count: 2, width: 3.0,
                },
            ];

            let src_c = CString::new(src_pdf.to_string_lossy().as_bytes()).unwrap();
            let out_c = CString::new(out_pdf.to_string_lossy().as_bytes()).unwrap();
            let rc = unsafe {
                ll_export_annotated_pdf(src_c.as_ptr(), out_c.as_ptr(), std::ptr::null(), annots.as_ptr(), annots.len() as c_int)
            };
            assert_eq!(rc, 0, "ll_export_annotated_pdf should succeed");

            let exported_bytes = std::fs::read(&out_pdf).unwrap();
            let exported_str = String::from_utf8_lossy(&exported_bytes);
            for token in ["/Highlight", "/Underline", "/StrikeOut", "/Text", "/Ink", "/QuadPoints", "/InkList", "hl-note", "sticky-note"] {
                assert!(exported_str.contains(token), "Exported PDF missing expected token: {token}");
            }

            let mut err_buf = [0 as c_char; 256];
            let doc = unsafe { ll_open(out_c.as_ptr(), std::ptr::null(), err_buf.as_mut_ptr(), err_buf.len()) };
            assert!(!doc.is_null(), "Exported PDF should reopen cleanly in MuPDF");
            let page_count = unsafe { ll_page_count(doc) };
            assert_eq!(page_count, 2);

            for page in 0..2 {
                let mut img: LlImage = unsafe { std::mem::zeroed() };
                let render_rc = unsafe { ll_render_priority(doc, page, 1.0, 0.0, std::ptr::null(), std::ptr::null_mut(), 100, &mut img) };
                assert_eq!(render_rc, LL_OK);
                assert!(img.width > 0 && img.height > 0 && !img.samples.is_null());
                unsafe { ll_free_image(doc, &mut img) };
            }

            let extracted = extract_annots_from_doc(doc).expect("extract_annots_from_doc");
            assert_eq!(extracted.len(), 5, "Should extract all 5 exported annotation subtypes cleanly");
            assert_eq!(extracted[0].annot_type, "highlight");
            assert_eq!(extracted[0].text.as_deref(), Some("hl-note"));
            assert_eq!(extracted[0].author.as_deref(), Some("Linden Test"));
            assert_eq!(extracted[1].annot_type, "underline");
            assert_eq!(extracted[2].annot_type, "note");
            assert_eq!(extracted[3].annot_type, "strikeout");
            assert_eq!(extracted[4].annot_type, "ink");

            let mut u = [0f32; 4];
            let mut o = [0f32; 4];
            let mut e = [0f32; 4];
            let crop_rc = unsafe { ll_compute_auto_crop(doc, 2, u.as_mut_ptr(), o.as_mut_ptr(), e.as_mut_ptr()) };
            assert_eq!(crop_rc, LL_OK);

            let mut imgs = LlRectList { rects: std::ptr::null_mut(), count: 0 };
            let img_rc = unsafe { ll_get_page_image_rects(doc, 0, &mut imgs) };
            assert_eq!(img_rc, LL_OK);
            unsafe { ll_free_rect_list(&mut imgs) };

            unsafe { ll_close(doc) };
            let _ = std::fs::remove_dir_all(&tmp_dir);
        }

        fn decode_qoi_rgba_test(encoded: &[u8], pixel_count: usize) -> Vec<u8> {
            let mut out = Vec::with_capacity(pixel_count * 4);
            let mut index = [[0u8; 4]; 64];
            let mut prev = [255u8, 255, 255, 255];
            let mut i = 0;
            while i < encoded.len() && out.len() < pixel_count * 4 {
                let b1 = encoded[i];
                i += 1;
                if b1 == 0xFE {
                    prev[0] = encoded[i]; prev[1] = encoded[i + 1]; prev[2] = encoded[i + 2];
                    i += 3;
                    let h = ((prev[0] as usize) * 3 + (prev[1] as usize) * 5 + (prev[2] as usize) * 7 + (prev[3] as usize) * 11) & 63;
                    index[h] = prev;
                    out.extend_from_slice(&prev);
                } else if b1 == 0xFF {
                    prev = [encoded[i], encoded[i + 1], encoded[i + 2], encoded[i + 3]];
                    i += 4;
                    let h = ((prev[0] as usize) * 3 + (prev[1] as usize) * 5 + (prev[2] as usize) * 7 + (prev[3] as usize) * 11) & 63;
                    index[h] = prev;
                    out.extend_from_slice(&prev);
                } else {
                    match b1 & 0xC0 {
                        0x00 => {
                            prev = index[b1 as usize];
                            out.extend_from_slice(&prev);
                        }
                        0x40 => {
                            let dr = ((b1 >> 4) & 3) as i8 - 2;
                            let dg = ((b1 >> 2) & 3) as i8 - 2;
                            let db = (b1 & 3) as i8 - 2;
                            prev[0] = prev[0].wrapping_add(dr as u8);
                            prev[1] = prev[1].wrapping_add(dg as u8);
                            prev[2] = prev[2].wrapping_add(db as u8);
                            let h = ((prev[0] as usize) * 3 + (prev[1] as usize) * 5 + (prev[2] as usize) * 7 + (prev[3] as usize) * 11) & 63;
                            index[h] = prev;
                            out.extend_from_slice(&prev);
                        }
                        0x80 => {
                            let b2 = encoded[i];
                            i += 1;
                            let vg = (b1 & 0x3F) as i8 - 32;
                            let dr_dg = ((b2 >> 4) & 0x0F) as i8 - 8;
                            let db_dg = (b2 & 0x0F) as i8 - 8;
                            prev[0] = prev[0].wrapping_add(vg.wrapping_add(dr_dg) as u8);
                            prev[1] = prev[1].wrapping_add(vg as u8);
                            prev[2] = prev[2].wrapping_add(vg.wrapping_add(db_dg) as u8);
                            let h = ((prev[0] as usize) * 3 + (prev[1] as usize) * 5 + (prev[2] as usize) * 7 + (prev[3] as usize) * 11) & 63;
                            index[h] = prev;
                            out.extend_from_slice(&prev);
                        }
                        _ => {
                            let run = (b1 & 0x3F) as usize + 1;
                            for _ in 0..run {
                                out.extend_from_slice(&prev);
                            }
                        }
                    }
                }
            }
            assert_eq!(i, encoded.len());
            out
        }

        #[test]
        fn test_llp3_qoi_roundtrip_and_raw_fallback() {
            // 1. Mixed page margins (white runs) + wraparound gradients + alpha changes + index hits
            let w = 64i32;
            let h = 48i32;
            let mut rgba = vec![255u8; (w * h * 4) as usize];
            for y in 4..44 {
                for x in 6..58 {
                    let idx = ((y * w + x) * 4) as usize;
                    if (x + y) % 5 == 0 {
                        rgba[idx] = 10; rgba[idx + 1] = 12; rgba[idx + 2] = 14; rgba[idx + 3] = 255;
                    } else if y == 10 {
                        rgba[idx] = ((x * 17) & 0xFF) as u8;
                        rgba[idx + 1] = ((x * 23 + 128) & 0xFF) as u8;
                        rgba[idx + 2] = ((255 - x * 3) & 0xFF) as u8;
                        rgba[idx + 3] = if x % 2 == 0 { 255 } else { 200 };
                    } else if y > 20 && y < 30 {
                        // Subtle gray scan-like deltas
                        let base = 240u8.saturating_sub(((x + y) % 6) as u8);
                        rgba[idx] = base; rgba[idx + 1] = base; rgba[idx + 2] = base; rgba[idx + 3] = 255;
                    }
                }
            }
            let pkt = encode_render_packet_slice(&rgba, w, h, w * 4, 3, 7, [1.25, 0.0, 0.0, 1.25, 0.0, 0.0]).unwrap();
            assert_eq!(&pkt[0..4], b"LLP3");
            let payload_len = u32::from_le_bytes(pkt[48..52].try_into().unwrap()) as usize;
            assert_eq!(pkt.len(), 52 + payload_len);
            assert!(payload_len < rgba.len() / 2, "Expected significant LLP3 compression");
            let decoded = decode_qoi_rgba_test(&pkt[52..], (w * h) as usize);
            assert_eq!(decoded, rgba);

            // 2. High-entropy incompressible pattern falls back to LLP2 cleanly
            let mut noise = vec![0u8; 20 * 20 * 4];
            let mut state = 0x12345678u32;
            for b in noise.chunks_exact_mut(4) {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                b[0] = (state >> 24) as u8;
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                b[1] = (state >> 24) as u8;
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                b[2] = (state >> 24) as u8;
                b[3] = 255;
            }
            let pkt_noise = encode_render_packet_slice(&noise, 20, 20, 80, 0, 0, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).unwrap();
            assert_eq!(&pkt_noise[0..4], b"LLP2");
            assert_eq!(&pkt_noise[52..], &noise[..]);
        }
    }
}

#[cfg(not(ll_mupdf))]
mod imp {
    use super::*;
    use std::path::PathBuf;
    fn unavailable<T>() -> Result<T, String> { Err("MuPDF native backend is not compiled into this build".into()) }

    pub fn mupdf_close_documents_for_window(_window_label: &str) {}
    pub fn register_window_doc(_window_label: &str, _doc_id: &str) {}
    pub fn prewarm_pdf_launch(_app: &tauri::AppHandle, _file_path: String) {}

    #[tauri::command] pub fn mupdf_is_available() -> bool { false }
    #[tauri::command] pub fn mupdf_set_store_limit(_max_mb: u32) -> Result<u32, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_stage_pdf_bytes(_app: tauri::AppHandle, _request: tauri::ipc::Request<'_>) -> Result<String, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_stage_pdf(_app: tauri::AppHandle, _file_path: String) -> Result<String, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_open_document(_app: tauri::AppHandle, _file_path: String, _password: Option<String>, _expected_size: Option<u64>, _max_store_mb: Option<u32>, _window_label: Option<String>, _parallel_rendering: Option<bool>, _direct_read_only: Option<bool>) -> Result<DocumentMetadata, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_bounds_range(_doc_id: String, _start_page: usize, _count: usize) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_sizes(_doc_id: String) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_text_layer(_doc_id: String, _page_index: usize) -> Result<TextLayerResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_select(_doc_id: String, _page_index: usize, _a: [f32; 2], _b: [f32; 2], _mode: Option<String>) -> Result<SelectionResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_render_page(_doc_id: String, _page_index: usize, _scale: f32, _rotation: Option<f32>, _clip: Option<[f32; 4]>, _request_id: String, _priority: Option<u8>, _generation: Option<u32>) -> Result<Response, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_plan_mobile_render(_doc_id: String, _page_index: usize, _scale: f32, _rotation: Option<f32>, _visible_page_rect: Option<[f32; 4]>, _quality: i32, _memory_mb: Option<u32>) -> Result<MobileRenderPlan, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_render_mobile_tile(_doc_id: String, _page_index: usize, _plan: MobileRenderPlan, _tile_index: i32, _request_id: String, _generation: Option<u32>) -> Result<Response, String> { unavailable() }
    #[tauri::command] pub fn mupdf_enable_diagnostics(_enable: bool) {}
    #[tauri::command] pub fn mupdf_get_render_diagnostics() -> Vec<RenderDiagnostics> { Vec::new() }
    #[tauri::command] pub fn mupdf_cancel_render(_doc_id: String, _request_id: String) -> bool { false }
    #[tauri::command] pub async fn mupdf_get_outline_flat(_doc_id: String) -> Result<Vec<FlatOutlineItem>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_links(_doc_id: String, _page_index: usize) -> Result<Vec<PdfLinkItem>, String> { unavailable() }
    #[tauri::command] pub fn mupdf_close_document(_doc_id: String) -> bool { false }
    pub(crate) fn native_snapshot_dir_public(_app: &tauri::AppHandle) -> Result<PathBuf, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_plain_text(_doc_id: String, _page_index: usize) -> Result<String, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_extract_annotations(_doc_id: String) -> Result<Vec<ExtractedPdfAnnot>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_compute_auto_crop(_doc_id: String) -> Result<AutoCropMargins, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_image_rects(_doc_id: String, _page_index: usize) -> Result<Vec<[f32; 4]>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_export_annotated_pdf(_doc_id: String, _output_path: String, _annotations_json: String) -> Result<bool, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_validate_snapshot(_app: tauri::AppHandle, _snapshot_path: String, _expected_size: u64) -> Result<bool, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_reclaim_snapshot(_app: tauri::AppHandle, _snapshot_path: String) -> Result<bool, String> { unavailable() }
}

// Kept independent of the WebView so disk publication can be exercised directly.
#[cfg_attr(not(ll_mupdf), allow(dead_code))]
pub(crate) fn has_pdf_header_prefix(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-")
}

#[cfg_attr(not(ll_mupdf), allow(dead_code))]
pub(crate) fn file_has_pdf_header_prefix(path: &std::path::Path) -> Result<bool, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("Cannot open PDF file: {e}"))?;
    let mut header = [0u8; 1024];
    let read_len = file.read(&mut header).map_err(|e| format!("Cannot read PDF header: {e}"))?;
    Ok(has_pdf_header_prefix(&header[..read_len]))
}

#[cfg(test)]
mod header_tests {
    use super::*;

    #[test]
    fn pdf_header_prefix_rejects_non_pdf_payloads() {
        assert!(has_pdf_header_prefix(b"%PDF-1.7\n1 0 obj"));
        let mut offset_hdr = vec![b' '; 100];
        offset_hdr.extend_from_slice(b"%PDF-1.4\n");
        assert!(has_pdf_header_prefix(&offset_hdr));

        assert!(!has_pdf_header_prefix(b""));
        assert!(!has_pdf_header_prefix(b"<html><body>not pdf</body></html>"));
        assert!(!has_pdf_header_prefix(b"PK\x03\x04epub-zip"));

        let mut late_hdr = vec![b' '; 1024];
        late_hdr.extend_from_slice(b"%PDF-1.7");
        assert!(!has_pdf_header_prefix(&late_hdr));

        let temp_dir = std::env::temp_dir().join(format!(
            "linden_pdf_hdr_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let fake_pdf = temp_dir.join("disguised.pdf");
        let valid_pdf = temp_dir.join("valid.pdf");
        std::fs::write(&fake_pdf, b"<!doctype html><script>alert(1)</script>").unwrap();
        std::fs::write(&valid_pdf, b"%PDF-1.7\n%%EOF\n").unwrap();

        assert!(!file_has_pdf_header_prefix(&fake_pdf).unwrap());
        assert!(file_has_pdf_header_prefix(&valid_pdf).unwrap());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

struct SavedPdfWriter {
    output: Option<std::fs::File>,
    final_path: std::path::PathBuf,
    part_path: std::path::PathBuf,
    hasher: crate::content_hash::ContentHasher,
    written: u64,
}

impl SavedPdfWriter {
    fn new(root: &std::path::Path, tag: &str) -> Result<Self, String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(root).map_err(|e| format!("Cannot create PDF cache: {e}"))?;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let final_path = root.join(format!("snapshot-{tag}-{}-{nanos}-{sequence}.pdf", std::process::id()));
        let part_path = final_path.with_extension("part");
        let output = std::fs::OpenOptions::new().write(true).create_new(true).open(&part_path)
            .map_err(|e| format!("Cannot create PDF snapshot: {e}"))?;
        Ok(Self {
            output: Some(output), final_path, part_path,
            hasher: crate::content_hash::ContentHasher::new(), written: 0,
        })
    }

    fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        self.output.as_mut().expect("staging file").write_all(bytes)
            .map_err(|e| format!("Cannot write PDF snapshot: {e}"))?;
        for chunk in bytes.chunks(64 * 1024) { self.hasher.update(chunk); }
        self.written += bytes.len() as u64;
        Ok(())
    }

    fn finish(mut self) -> Result<String, String> {
        let file = self.output.take().expect("staging file");
        file.sync_all().map_err(|e| format!("Cannot flush PDF snapshot: {e}"))?;
        drop(file);
        std::fs::rename(&self.part_path, &self.final_path)
            .map_err(|e| format!("Cannot publish PDF snapshot: {e}"))?;
        self.part_path.clear();
        let hasher = std::mem::replace(&mut self.hasher, crate::content_hash::ContentHasher::new());
        let (document_hash, legacy_hash) = hasher.finish(self.written);
        Ok(serde_json::json!({"path": self.final_path.to_string_lossy(), "size": self.written,
            "documentHash": document_hash, "legacyDocumentHash": legacy_hash}).to_string())
    }
}

impl Drop for SavedPdfWriter {
    fn drop(&mut self) {
        drop(self.output.take());
        if !self.part_path.as_os_str().is_empty() { let _ = std::fs::remove_file(&self.part_path); }
    }
}

pub(crate) fn write_saved_pdf_snapshot(root: &std::path::Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 || !has_pdf_header_prefix(bytes) {
        return Err("Saved data is not a supported PDF binary payload".into());
    }
    let mut snapshot = SavedPdfWriter::new(root, "blob")?;
    snapshot.append(bytes)?;
    snapshot.finish()
}

#[cfg(all(target_os = "android", ll_mupdf))]
#[tauri::command]
pub async fn mupdf_stage_pdf_chunk(
    app: tauri::AppHandle, upload_id: String, offset: u64, size: u64, data: Option<String>,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::{collections::HashMap, sync::{Mutex, Once, OnceLock}};

    const CHUNK_SIZE: u64 = 256 * 1024;
    const MAX_STAGED_PDF_BYTES: u64 = 128 * 1024 * 1024;
    static UPLOADS: OnceLock<Mutex<HashMap<String, (SavedPdfWriter, u64)>>> = OnceLock::new();
    static CLEANUP: Once = Once::new();
    if upload_id.len() != 32 || !upload_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid PDF upload ID".into());
    }
    let uploads_map = UPLOADS.get_or_init(|| Mutex::new(HashMap::new()));
    let Some(data) = data else {
        let removed = {
            let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
            uploads.remove(&upload_id)
        };
        drop(removed);
        return Ok(None);
    };
    if size == 0 || size > MAX_STAGED_PDF_BYTES {
        let removed = {
            let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
            uploads.remove(&upload_id)
        };
        drop(removed);
        return Err("PDF snapshot exceeds 128 MiB limit or is empty".into());
    }
    let root = imp::native_snapshot_dir_public(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Android's bridge accepts JSON. Decode only a single bounded chunk without holding the map mutex across I/O.
        let expected = size.checked_sub(offset).unwrap_or(0).min(CHUNK_SIZE);
        if expected == 0 || data.len() != (expected as usize).div_ceil(3) * 4 {
            let removed = {
                let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
                uploads.remove(&upload_id)
            };
            drop(removed);
            return Err("Invalid PDF snapshot chunk length".into());
        }
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        if bytes.len() as u64 != expected {
            let removed = {
                let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
                uploads.remove(&upload_id)
            };
            drop(removed);
            return Err("Invalid PDF snapshot chunk length".into());
        }

        let existing = {
            let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
            uploads.remove(&upload_id)
        };

        let mut snapshot = if offset == 0 && existing.is_none() {
            if !has_pdf_header_prefix(&bytes) { return Err("Saved data is not a PDF".into()); }
            CLEANUP.call_once(|| {
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if name.starts_with("snapshot-blob-android-") && name.ends_with(".part") {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            });
            SavedPdfWriter::new(&root, "blob-android")?
        } else {
            let (snapshot, original_size) = existing.ok_or("PDF snapshot upload is closed")?;
            if snapshot.written != offset || original_size != size {
                return Err("PDF snapshot chunk is out of sequence".into());
            }
            snapshot
        };

        snapshot.append(&bytes)?;
        if snapshot.written == size {
            snapshot.finish().map(Some)
        } else {
            let mut uploads = uploads_map.lock().map_err(|e| e.to_string())?;
            uploads.insert(upload_id, (snapshot, size));
            Ok(None)
        }
    }).await.map_err(|e| format!("PDF snapshot worker failed: {e}"))?
}

#[cfg(not(all(target_os = "android", ll_mupdf)))]
#[tauri::command]
pub async fn mupdf_stage_pdf_chunk(
    _app: tauri::AppHandle, _upload_id: String, _offset: u64, _size: u64, _data: Option<String>,
) -> Result<Option<String>, String> {
    Err("Native Android PDF staging is unavailable".into())
}

pub use imp::*;
