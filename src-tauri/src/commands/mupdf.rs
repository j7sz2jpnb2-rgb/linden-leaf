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
        sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, Mutex, OnceLock},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::Manager;
    use tokio::sync::oneshot;

    const LL_OK: i32 = 0;
    const LL_CANCELLED: i32 = 1;

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

    extern "C" {
        fn ll_set_max_store_mb(max_mb: u32);
        #[allow(dead_code)]
        fn ll_get_max_store_mb() -> u32;
        fn ll_open(path: *const c_char, password: *const c_char, error: *mut c_char, error_size: usize) -> *mut LlDoc;
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

    #[derive(Clone)]
    struct DocumentSession {
        tx: mpsc::Sender<DocCommand>,
        cancels: Arc<Mutex<HashMap<String, Arc<CancelHandle>>>>,
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
        Render {
            page: usize,
            scale: f32,
            rotation: f32,
            clip: Option<[f32; 4]>,
            cancel: Arc<CancelHandle>,
            request_id: String,
            priority: u8,
            generation: u32,
            enqueued_at: std::time::Instant,
            reply: oneshot::Sender<Result<Vec<u8>, String>>,
        },
        Close,
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

    fn worker(path: String, password: String,
              rx: mpsc::Receiver<DocCommand>,
              cancels: Arc<Mutex<HashMap<String, Arc<CancelHandle>>>>,
              ready: oneshot::Sender<Result<(usize, [f32; 4], Option<String>, Option<String>), String>>) {
        let c_path = match CString::new(path) {
            Ok(v) => v,
            Err(_) => { let _ = ready.send(Err("File path contains NUL".into())); return; }
        };
        let c_password = CString::new(password).unwrap_or_else(|_| CString::new("").expect("empty CString"));
        let mut err = vec![0i8; 512];
        let doc = unsafe { ll_open(c_path.as_ptr(), c_password.as_ptr(), err.as_mut_ptr(), err.len()) };
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
        if ready.send(Ok((pages, first, title, author))).is_err() {
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
                let should_cancel = if let DocCommand::Render { page, generation, cancel, .. } = &pending[i] {
                    cancel.is_aborted() ||
                    pending.iter().skip(i + 1).any(|later| {
                        if let DocCommand::Render { page: later_page, generation: later_gen, .. } = later {
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
                    if let DocCommand::Render { cancel, request_id, reply, .. } = cmd {
                        cancel.abort();
                        if let Ok(mut map) = cancels.lock() { map.remove(&request_id); }
                        let _ = reply.send(Err("render cancelled".into()));
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
                        DocCommand::Render { priority: 0, .. } => 2,
                        DocCommand::Text { .. } => 3,
                        DocCommand::Bounds { .. } => 4,
                        DocCommand::Render { priority, .. } => 10 + (*priority as i32),
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
                DocCommand::Render { page, scale, rotation, clip, cancel, request_id, priority, generation: _, enqueued_at, reply } => {
                    let queue_wait_us = enqueued_at.elapsed().as_micros() as u64;
                    let mut raw = LlImage {
                        samples: std::ptr::null_mut(), length: 0, width: 0, height: 0,
                        stride: 0, x: 0, y: 0, matrix: [0.0; 6], pixmap_owner: std::ptr::null_mut(),
                    };
                    let clip_ptr = clip.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
                    let t0_c = std::time::Instant::now();
                    let status = unsafe {
                        ll_render_priority(doc, page as i32, scale, rotation, clip_ptr, cancel.ptr(), priority as c_int, &mut raw)
                    };
                    let c_total_us = t0_c.elapsed().as_micros() as u64;
                    let c_timings = unsafe { ll_get_last_render_timings(doc) };

                    let t0_packet = std::time::Instant::now();
                    let result = if status == LL_CANCELLED {
                        Err("render cancelled".into())
                    } else if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        render_packet(&raw)
                    };
                    let packet_us = t0_packet.elapsed().as_micros() as u64;
                    let packet_bytes = result.as_ref().map(|v| v.len()).unwrap_or(0);

                    if DIAGNOSTICS_ENABLED.load(Ordering::Relaxed) {
                        if let Ok(mut diag) = diagnostics_store().lock() {
                            if diag.len() >= 200 { diag.pop_front(); }
                            diag.push_back(RenderDiagnostics {
                                request_id: request_id.clone(),
                                queue_wait_us,
                                c_list_us: c_timings.list_time_us,
                                c_raster_us: c_timings.raster_time_us,
                                c_pixmap_us: c_timings.pixmap_time_us,
                                c_list_hit: c_timings.list_hit != 0,
                                c_total_us,
                                packet_us,
                                packet_bytes,
                            });
                        }
                    }

                    unsafe { ll_free_image(doc, &mut raw) };
                    if let Ok(mut map) = cancels.lock() { map.remove(&request_id); }
                    let _ = reply.send(result);
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
                DocCommand::Render { cancel, reply, request_id, .. } => {
                    cancel.abort();
                    if let Ok(mut map) = cancels.lock() { map.remove(&request_id); }
                    let _ = reply.send(Err("Document closed".into()));
                }
                DocCommand::Close => {}
            }
        }

        if let Ok(mut map) = cancels.lock() {
            for handle in map.values() { handle.abort(); }
            map.clear();
        }
        unsafe { ll_close(doc) };
    }

    fn render_packet(page: &LlImage) -> Result<Vec<u8>, String> {
        // Build the final IPC buffer directly from the C pixmap. A separate
        // Rust pixel Vec followed by a second packet Vec doubled large-page
        // transient allocations and memory traffic.
        let stride = page.width.checked_mul(4).ok_or("Invalid MuPDF width")?;
        let length = usize::try_from(stride).ok()
            .and_then(|s| usize::try_from(page.height).ok().and_then(|h| s.checked_mul(h)))
            .ok_or("Invalid MuPDF pixel length")?;
        if page.width <= 0 || page.height <= 0 || page.stride != stride ||
            page.length != length || page.samples.is_null() || length > 40_000_000 {
            return Err("Invalid MuPDF pixel buffer".into());
        }
        let packet_len = 52usize.checked_add(length).ok_or("MuPDF packet too large")?;
        let mut out = Vec::with_capacity(packet_len);
        out.extend_from_slice(b"LLP2");
        out.extend_from_slice(&(page.width as u32).to_le_bytes());
        out.extend_from_slice(&(page.height as u32).to_le_bytes());
        out.extend_from_slice(&(page.stride as u32).to_le_bytes());
        out.extend_from_slice(&page.x.to_le_bytes());
        out.extend_from_slice(&page.y.to_le_bytes());
        for v in page.matrix { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(&(length as u32).to_le_bytes());
        let pixels = unsafe { std::slice::from_raw_parts(page.samples, length) };
        out.extend_from_slice(pixels);
        Ok(out)
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
        let fallback = app.path().app_cache_dir().map(|p| p.join("pdf-native"))
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
            let root = native_snapshot_dir(&app)?;
            std::fs::create_dir_all(&root).map_err(|e| format!("Cannot create PDF cache: {e}"))?;
            static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
            let name = format!("snapshot-{}-{nanos}-{}.pdf", std::process::id(), NEXT_STAGE.fetch_add(1, Ordering::Relaxed));
            let final_path = root.join(name);
            let temp_path = final_path.with_extension("part");
            let mut input = std::fs::File::open(source).map_err(|e| format!("Cannot open PDF source: {e}"))?;
            let mut output = std::fs::OpenOptions::new().write(true).create_new(true)
                .open(&temp_path).map_err(|e| format!("Cannot stage PDF: {e}"))?;
            let size = input.metadata().map(|m| m.len()).unwrap_or(0);
            use std::collections::hash_map::DefaultHasher;
            use std::hash::Hasher;
            use std::io::{Read, Write};
            let mut hasher = DefaultHasher::new();
            let mut buf = [0u8; 64 * 1024];
            let stage_start = std::time::Instant::now();
            let mut copy_hash_ms = 0u64;
            let mut flush_ms = 0u64;
            let result = (|| -> Result<(), String> {
                let t0 = std::time::Instant::now();
                loop {
                    let n = input.read(&mut buf).map_err(|e| format!("Cannot read PDF: {e}"))?;
                    if n == 0 { break; }
                    hasher.write(&buf[..n]);
                    output.write_all(&buf[..n]).map_err(|e| format!("Cannot write PDF snapshot: {e}"))?;
                }
                copy_hash_ms = t0.elapsed().as_millis() as u64;
                let t1 = std::time::Instant::now();
                output.flush().map_err(|e| format!("Cannot flush PDF: {e}"))?;
                output.sync_all().map_err(|e| format!("Cannot sync PDF: {e}"))?;
                flush_ms = t1.elapsed().as_millis() as u64;
                drop(output);
                std::fs::rename(&temp_path, &final_path).map_err(|e| format!("Cannot publish PDF snapshot: {e}"))
            })();
            if result.is_err() { let _ = std::fs::remove_file(&temp_path); }
            result?;
            let doc_hash = format!("hash_{:x}_{size}", hasher.finish());
            let revision = format!("rev_{nanos}_{}", NEXT_STAGE.load(Ordering::Relaxed));
            let total_stage_ms = stage_start.elapsed().as_millis() as u64;
            let payload = serde_json::json!({
                "path": final_path.to_string_lossy().into_owned(),
                "size": size,
                "revision": revision,
                "documentHash": doc_hash,
                "copyHashMs": copy_hash_ms,
                "flushMs": flush_ms,
                "stageTotalMs": total_stage_ms
            });
            Ok(payload.to_string())
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
    ) -> Result<DocumentMetadata, String> {
        if let Some(mb) = max_store_mb {
            unsafe { ll_set_max_store_mb(mb) };
        }
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
            worker(worker_path, pw_clone.unwrap_or_default(), rx, worker_cancels, ready_tx)
        }).map_err(|e| format!("Failed to start MuPDF worker: {e}"))?;

        let open_res = ready_rx.await.map_err(|_| "MuPDF worker exited during open".to_string())?;
        let (num_pages, bounds, native_title, native_author) = match open_res {
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
            title, author: native_author, format: "PDF".into(), native_backend: true,
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
        s.cancels.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), cancel.clone());
        let (tx, rx) = oneshot::channel();
        if s.tx.send(DocCommand::Render {
            page: page_index, scale, rotation: rotation.unwrap_or(0.0), clip,
            cancel, request_id: request_id.clone(),
            priority: priority.unwrap_or(0),
            generation: generation.unwrap_or(0),
            enqueued_at: std::time::Instant::now(),
            reply: tx,
        }).is_err() {
            if let Ok(mut m) = s.cancels.lock() { m.remove(&request_id); }
            return Err("MuPDF worker is closed".into());
        }
        let packet = rx.await.map_err(|_| "MuPDF worker dropped render request".to_string())??;
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
            if !name.starts_with("snapshot-") || !name.ends_with(".pdf") { return Ok(false); }
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
            if !file_name.starts_with("snapshot-") || (!file_name.ends_with(".pdf") && !file_name.ends_with(".part")) {
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
        unsafe {
            ll_set_max_store_mb(clamped);
            Ok(ll_get_max_store_mb())
        }
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
    #[tauri::command] pub async fn mupdf_open_document(_app: tauri::AppHandle, _file_path: String, _password: Option<String>, _expected_size: Option<u64>, _max_store_mb: Option<u32>, _window_label: Option<String>) -> Result<DocumentMetadata, String> { unavailable() }
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
pub(crate) fn write_saved_pdf_snapshot(root: &std::path::Path, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 ||
        !bytes[..bytes.len().min(1024)].windows(5).any(|w| w == b"%PDF-") {
        return Err("Saved data is not a supported PDF binary payload".into());
    }
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create PDF cache: {e}"))?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let name = format!("snapshot-blob-{}-{nanos}-{}.pdf", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
    let final_path = root.join(name);
    let temp_path = final_path.with_extension("part");
    let result = (|| -> Result<(), String> {
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp_path)
            .map_err(|e| format!("Cannot create PDF snapshot: {e}"))?;
        output.write_all(bytes).map_err(|e| format!("Cannot write PDF snapshot: {e}"))?;
        output.sync_all().map_err(|e| format!("Cannot flush PDF snapshot: {e}"))?;
        drop(output);
        std::fs::rename(&temp_path, &final_path).map_err(|e| format!("Cannot publish PDF snapshot: {e}"))
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp_path); }
    result?;
    Ok(serde_json::json!({"path": final_path.to_string_lossy(), "size": bytes.len()}).to_string())
}

pub use imp::*;
