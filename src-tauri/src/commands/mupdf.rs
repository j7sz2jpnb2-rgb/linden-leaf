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

    #[cfg(target_os = "windows")]
    #[repr(C)]
    struct LlRenderJob { _private: [u8; 0] }

    extern "C" {
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
        Render(RenderRequest),
        Close,
    }

    struct RenderRequest {
        page: usize,
        scale: f32,
        rotation: f32,
        clip: Option<[f32; 4]>,
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
            RasterTarget::Document(doc) => unsafe { ll_free_image(doc, &mut serial_image) },
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
                        DocCommand::Render(RenderRequest { priority: 0, .. }) => 2,
                        DocCommand::Text { .. } => 3,
                        DocCommand::Bounds { .. } => 4,
                        DocCommand::Render(RenderRequest { priority, .. }) => 10 + (*priority as i32),
                        DocCommand::PlainText { .. } => 25,
                        DocCommand::Outline { .. } | DocCommand::Links { .. } => 26,
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
                DocCommand::Render(request) => {
                    let started = Instant::now();
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

    #[tauri::command]
    pub async fn mupdf_open_document(
        app: tauri::AppHandle,
        file_path: String,
        password: Option<String>,
        expected_size: Option<u64>,
        max_store_mb: Option<u32>,
        window_label: Option<String>,
        parallel_rendering: Option<bool>,
    ) -> Result<DocumentMetadata, String> {
        let max_store_mb = max_store_mb.unwrap_or_else(|| DEFAULT_STORE_MB.load(Ordering::Relaxed)).clamp(32, 1024);
        let parallel = cfg!(target_os = "windows") && parallel_rendering.unwrap_or(false);
        let size = expected_size.ok_or_else(|| "Native PDF open requires expectedSize to verify snapshot boundary".to_string())?;
        if size == 0 {
            return Err("Native PDF snapshot size cannot be zero".into());
        }
        if file_path.trim().is_empty() {
            return Err("MuPDF requires a local file path".into());
        }
        let raw_path = Path::new(&file_path);
        if !raw_path.exists() || !raw_path.is_file() {
            return Err("MuPDF requires an existing readable local file".into());
        }
        let root = std::fs::canonicalize(native_snapshot_dir(&app)?)
            .map_err(|e| format!("Native PDF cache unavailable: {e}"))?;
        let actual_path = std::fs::canonicalize(raw_path)
            .map_err(|e| format!("Native PDF snapshot unavailable: {e}"))?;
        if actual_path.parent() != Some(root.as_path()) {
            return Err("Native PDF snapshot is outside the app cache".into());
        }
        let file_name = actual_path.file_name().and_then(|s| s.to_str()).ok_or("Invalid snapshot filename")?;
        if !file_name.starts_with("snapshot-") || !file_name.ends_with(".pdf") {
            return Err("Invalid native PDF snapshot file format".into());
        }
        let actual_size = std::fs::metadata(&actual_path).map_err(|e| e.to_string())?.len();
        if actual_size != size {
            return Err("Native PDF snapshot size differs from the indexed Blob".into());
        }
        if !file_has_pdf_header_prefix(&actual_path)? {
            return Err("Invalid native PDF binary payload".into());
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
        let s = session(&doc_id)?;
        let cancel = Arc::new(CancelHandle::new()?);
        let cancel_check = cancel.clone();
        s.cancels.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), cancel.clone());
        let (tx, rx) = oneshot::channel();
        if s.tx.send(DocCommand::Render(RenderRequest {
            page: page_index, scale, rotation: rotation.unwrap_or(0.0), clip,
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

    fn parse_hex_color(hex: Option<&str>) -> [f32; 3] {
        if let Some(h) = hex {
            let clean = h.trim().trim_start_matches('#');
            if clean.len() == 6 {
                if let (Ok(r), Ok(g), Ok(b)) = (
                    u8::from_str_radix(&clean[0..2], 16),
                    u8::from_str_radix(&clean[2..4], 16),
                    u8::from_str_radix(&clean[4..6], 16),
                ) {
                    return [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0];
                }
            }
        }
        [1.0, 0.9, 0.0]
    }

    #[tauri::command]
    pub async fn mupdf_export_annotated_pdf(
        doc_id: String,
        output_path: String,
        annotations_json: String,
    ) -> Result<bool, String> {
        let s = session(&doc_id)?;
        let file_path = s.file_path;
        let password = s.password.clone();
        let items: Vec<ExportAnnotationItem> = serde_json::from_str(&annotations_json)
            .map_err(|e| format!("Invalid annotations JSON: {e}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            let input_c = CString::new(file_path.to_string_lossy().as_bytes())
                .map_err(|e| format!("Invalid input path: {e}"))?;
            let output_c = CString::new(output_path.as_str())
                .map_err(|e| format!("Invalid output path: {e}"))?;
            let pass_c = password.as_deref().and_then(|p| CString::new(p).ok());
            let pass_ptr = pass_c.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null());

            let mut c_annots = Vec::new();
            let mut text_c_strings = Vec::new();
            let mut author_c_strings = Vec::new();
            let mut quad_buffers = Vec::new();
            let mut stroke_count_buffers = Vec::new();
            let mut stroke_point_buffers = Vec::new();

            for item in &items {
                let a_type = match item.annot_type.as_deref().unwrap_or("highlight") {
                    "highlight" => 0,
                    "underline" => 1,
                    "strikeout" | "strike" => 2,
                    "note" | "text" => 3,
                    "ink" | "drawing" => 4,
                    _ => 0,
                };
                let col = parse_hex_color(item.color.as_deref());
                let op = item.opacity.unwrap_or(0.8);
                let r = item.rect.unwrap_or([0.0, 0.0, 100.0, 100.0]);

                let t_ptr = if let Some(ref t) = item.text {
                    let cs = CString::new(t.as_str()).unwrap_or_default();
                    let ptr = cs.as_ptr();
                    text_c_strings.push(cs);
                    ptr
                } else {
                    std::ptr::null()
                };

                let a_ptr = if let Some(ref a) = item.author {
                    let cs = CString::new(a.as_str()).unwrap_or_default();
                    let ptr = cs.as_ptr();
                    author_c_strings.push(cs);
                    ptr
                } else {
                    std::ptr::null()
                };

                let (q_ptr, q_cnt) = if let Some(ref q) = item.quads {
                    quad_buffers.push(q.clone());
                    (quad_buffers.last().unwrap().as_ptr(), (q.len() / 8) as c_int)
                } else {
                    (std::ptr::null(), 0)
                };

                let (sc_ptr, sp_ptr, s_cnt) = if let Some(ref strokes) = item.strokes {
                    let mut counts = Vec::new();
                    let mut points = Vec::new();
                    for stroke in strokes {
                        counts.push(stroke.len() as c_int);
                        for p in stroke {
                            points.push(p[0]);
                            points.push(p[1]);
                        }
                    }
                    stroke_count_buffers.push(counts);
                    stroke_point_buffers.push(points);
                    (
                        stroke_count_buffers.last().unwrap().as_ptr(),
                        stroke_point_buffers.last().unwrap().as_ptr(),
                        strokes.len() as c_int,
                    )
                } else {
                    (std::ptr::null(), std::ptr::null(), 0)
                };

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
                    width: item.width.unwrap_or(2.0),
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

    #[tauri::command] pub fn mupdf_is_available() -> bool { false }
    #[tauri::command] pub fn mupdf_set_store_limit(_max_mb: u32) -> Result<u32, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_stage_pdf_bytes(_app: tauri::AppHandle, _request: tauri::ipc::Request<'_>) -> Result<String, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_stage_pdf(_app: tauri::AppHandle, _file_path: String) -> Result<String, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_open_document(_app: tauri::AppHandle, _file_path: String, _password: Option<String>, _expected_size: Option<u64>, _max_store_mb: Option<u32>, _window_label: Option<String>, _parallel_rendering: Option<bool>) -> Result<DocumentMetadata, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_bounds_range(_doc_id: String, _start_page: usize, _count: usize) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_sizes(_doc_id: String) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_text_layer(_doc_id: String, _page_index: usize) -> Result<TextLayerResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_select(_doc_id: String, _page_index: usize, _a: [f32; 2], _b: [f32; 2], _mode: Option<String>) -> Result<SelectionResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_render_page(_doc_id: String, _page_index: usize, _scale: f32, _rotation: Option<f32>, _clip: Option<[f32; 4]>, _request_id: String, _priority: Option<u8>, _generation: Option<u32>) -> Result<Response, String> { unavailable() }
    #[tauri::command] pub fn mupdf_enable_diagnostics(_enable: bool) {}
    #[tauri::command] pub fn mupdf_get_render_diagnostics() -> Vec<RenderDiagnostics> { Vec::new() }
    #[tauri::command] pub fn mupdf_cancel_render(_doc_id: String, _request_id: String) -> bool { false }
    #[tauri::command] pub async fn mupdf_get_outline_flat(_doc_id: String) -> Result<Vec<FlatOutlineItem>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_links(_doc_id: String, _page_index: usize) -> Result<Vec<PdfLinkItem>, String> { unavailable() }
    #[tauri::command] pub fn mupdf_close_document(_doc_id: String) -> bool { false }
    pub(crate) fn native_snapshot_dir_public(_app: &tauri::AppHandle) -> Result<PathBuf, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_plain_text(_doc_id: String, _page_index: usize) -> Result<String, String> { unavailable() }
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
    static UPLOADS: OnceLock<Mutex<HashMap<String, (SavedPdfWriter, u64)>>> = OnceLock::new();
    static CLEANUP: Once = Once::new();
    if upload_id.len() != 32 || !upload_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid PDF upload ID".into());
    }
    let root = imp::native_snapshot_dir_public(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut uploads = UPLOADS.get_or_init(|| Mutex::new(HashMap::new())).lock()
            .map_err(|e| e.to_string())?;
        let mut existing = uploads.remove(&upload_id);
        let Some(data) = data else { return Ok(None); };

        // Android's bridge accepts JSON. Decode only a single bounded chunk.
        let expected = size.checked_sub(offset).unwrap_or(0).min(CHUNK_SIZE);
        if expected == 0 || data.len() != (expected as usize).div_ceil(3) * 4 {
            return Err("Invalid PDF snapshot chunk length".into());
        }
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        if bytes.len() as u64 != expected { return Err("Invalid PDF snapshot chunk length".into()); }

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
            let (snapshot, original_size) = existing.take().ok_or("PDF snapshot upload is closed")?;
            if snapshot.written != offset || original_size != size {
                return Err("PDF snapshot chunk is out of sequence".into());
            }
            snapshot
        };

        snapshot.append(&bytes)?;
        if snapshot.written == size {
            snapshot.finish().map(Some)
        } else {
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
