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

#[cfg(ll_mupdf)]
mod imp {
    use super::*;
    use std::{
        collections::HashMap,
        ffi::{CStr, CString},
        os::raw::{c_char, c_float, c_int},
        path::Path,
        ptr::NonNull,
        sync::{mpsc, Arc, Mutex, OnceLock},
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };
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
    }
    #[repr(C)]
    struct LlOutlineItem { title: *mut c_char, page: c_int, level: c_int }
    #[repr(C)]
    struct LlOutline { items: *mut LlOutlineItem, count: c_int }

    extern "C" {
        fn ll_open(path: *const c_char, password: *const c_char, error: *mut c_char, error_size: usize) -> *mut LlDoc;
        fn ll_close(doc: *mut LlDoc);
        fn ll_page_count(doc: *mut LlDoc) -> c_int;
        fn ll_error(doc: *mut LlDoc) -> *const c_char;
        fn ll_metadata(doc: *mut LlDoc, key: *const c_char) -> *mut c_char;
        fn ll_free_string(value: *mut c_char);
        fn ll_get_outline(doc: *mut LlDoc, out: *mut LlOutline) -> c_int;
        fn ll_free_outline(out: *mut LlOutline);
        fn ll_page_bounds(doc: *mut LlDoc, page: c_int, bounds: *mut c_float) -> c_int;
        fn ll_page_bounds_many(doc: *mut LlDoc, start_page: c_int, count: c_int, bounds4: *mut c_float) -> c_int;
        fn ll_cancel_new() -> *mut LlCancel;
        fn ll_cancel_abort(cancel: *mut LlCancel);
        fn ll_cancel_free(cancel: *mut LlCancel);
        fn ll_render(doc: *mut LlDoc, page: c_int, scale: c_float, rotation: c_float,
                     clip: *const c_float, cancel: *mut LlCancel, out: *mut LlImage) -> c_int;
        fn ll_free_image(out: *mut LlImage);
        fn ll_get_text(doc: *mut LlDoc, page: c_int, out: *mut LlText) -> c_int;
        fn ll_free_text(out: *mut LlText);
        fn ll_select_mode(doc: *mut LlDoc, page: c_int, ax: c_float, ay: c_float,
                          bx: c_float, by: c_float, mode: c_int,
                          out: *mut LlSelection) -> c_int;
        fn ll_free_selection(out: *mut LlSelection);
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
    }

    struct RenderedPage {
        pixels: Vec<u8>,
        width: i32,
        height: i32,
        stride: i32,
        x: i32,
        y: i32,
        matrix: [f32; 6],
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
        Render {
            page: usize,
            scale: f32,
            rotation: f32,
            clip: Option<[f32; 4]>,
            cancel: Arc<CancelHandle>,
            request_id: String,
            reply: oneshot::Sender<Result<RenderedPage, String>>,
        },
        Close,
    }

    fn store() -> &'static Mutex<HashMap<String, DocumentSession>> {
        static STORE: OnceLock<Mutex<HashMap<String, DocumentSession>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
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

        while let Ok(cmd) = rx.recv() {
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
                DocCommand::Render { page, scale, rotation, clip, cancel, request_id, reply } => {
                    let mut raw = LlImage {
                        samples: std::ptr::null_mut(), length: 0, width: 0, height: 0,
                        stride: 0, x: 0, y: 0, matrix: [0.0; 6],
                    };
                    let clip_ptr = clip.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
                    let status = unsafe {
                        ll_render(doc, page as i32, scale, rotation, clip_ptr, cancel.ptr(), &mut raw)
                    };
                    let result = if status == LL_CANCELLED {
                        Err("render cancelled".into())
                    } else if status != LL_OK {
                        Err(native_error(doc))
                    } else {
                        let pixels = if raw.length > 0 && !raw.samples.is_null() {
                            unsafe { std::slice::from_raw_parts(raw.samples, raw.length) }.to_vec()
                        } else { Vec::new() };
                        Ok(RenderedPage {
                            pixels, width: raw.width, height: raw.height, stride: raw.stride,
                            x: raw.x, y: raw.y, matrix: raw.matrix,
                        })
                    };
                    unsafe { ll_free_image(&mut raw) };
                    if let Ok(mut map) = cancels.lock() { map.remove(&request_id); }
                    let _ = reply.send(result);
                }
                DocCommand::Close => break,
            }
        }

        if let Ok(mut map) = cancels.lock() {
            for handle in map.values() { handle.abort(); }
            map.clear();
        }
        unsafe { ll_close(doc) };
    }

    fn render_packet(page: RenderedPage) -> Vec<u8> {
        // LLP2 + fixed little-endian header + tightly packed RGBA.
        let mut out = Vec::with_capacity(52 + page.pixels.len());
        out.extend_from_slice(b"LLP2");
        out.extend_from_slice(&(page.width as u32).to_le_bytes());
        out.extend_from_slice(&(page.height as u32).to_le_bytes());
        out.extend_from_slice(&(page.stride as u32).to_le_bytes());
        out.extend_from_slice(&page.x.to_le_bytes());
        out.extend_from_slice(&page.y.to_le_bytes());
        for v in page.matrix { out.extend_from_slice(&v.to_le_bytes()); }
        out.extend_from_slice(&(page.pixels.len() as u32).to_le_bytes());
        out.extend_from_slice(&page.pixels);
        out
    }

    #[tauri::command]
    pub fn mupdf_is_available() -> bool { true }

    #[tauri::command]
    pub async fn mupdf_open_document(file_path: String, password: Option<String>) -> Result<DocumentMetadata, String> {
        if file_path.is_empty() || !Path::new(&file_path).is_file() {
            return Err("MuPDF requires a readable local file path".into());
        }
        let doc_id = make_doc_id();
        let (tx, rx) = mpsc::channel();
        let cancels = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let worker_cancels = cancels.clone();
        let worker_path = file_path.clone();
        thread::Builder::new().name(format!("ll-mupdf-{doc_id}")).spawn(move || {
            worker(worker_path, password.unwrap_or_default(), rx, worker_cancels, ready_tx)
        }).map_err(|e| format!("Failed to start MuPDF worker: {e}"))?;

        let (num_pages, bounds, native_title, native_author) = ready_rx.await.map_err(|_| "MuPDF worker exited during open".to_string())??;
        store().lock().map_err(|e| e.to_string())?.insert(doc_id.clone(), DocumentSession { tx, cancels, num_pages });
        let width = (bounds[2] - bounds[0]).abs().max(1.0);
        let height = (bounds[3] - bounds[1]).abs().max(1.0);
        let title = native_title.or_else(|| Path::new(&file_path).file_stem().map(|x| x.to_string_lossy().into_owned()));
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
                                   request_id: String) -> Result<Response, String> {
        let s = session(&doc_id)?;
        let cancel = Arc::new(CancelHandle::new()?);
        s.cancels.lock().map_err(|e| e.to_string())?.insert(request_id.clone(), cancel.clone());
        let (tx, rx) = oneshot::channel();
        if s.tx.send(DocCommand::Render {
            page: page_index, scale, rotation: rotation.unwrap_or(0.0), clip,
            cancel, request_id: request_id.clone(), reply: tx,
        }).is_err() {
            if let Ok(mut m) = s.cancels.lock() { m.remove(&request_id); }
            return Err("MuPDF worker is closed".into());
        }
        let rendered = rx.await.map_err(|_| "MuPDF worker dropped render request".to_string())??;
        Ok(Response::new(render_packet(rendered)))
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
    pub async fn mupdf_get_links(_doc_id: String, _page_index: usize) -> Result<Vec<serde_json::Value>, String> { Ok(Vec::new()) }

    #[tauri::command]
    pub fn mupdf_close_document(doc_id: String) -> bool {
        let session = store().lock().ok().and_then(|mut m| m.remove(&doc_id));
        if let Some(s) = session {
            if let Ok(map) = s.cancels.lock() { for handle in map.values() { handle.abort(); } }
            let _ = s.tx.send(DocCommand::Close);
            true
        } else { false }
    }
}

#[cfg(not(ll_mupdf))]
mod imp {
    use super::*;
    fn unavailable<T>() -> Result<T, String> { Err("MuPDF native backend is not compiled into this build".into()) }

    #[tauri::command] pub fn mupdf_is_available() -> bool { false }
    #[tauri::command] pub async fn mupdf_open_document(_file_path: String, _password: Option<String>) -> Result<DocumentMetadata, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_bounds_range(_doc_id: String, _start_page: usize, _count: usize) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_page_sizes(_doc_id: String) -> Result<Vec<f32>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_text_layer(_doc_id: String, _page_index: usize) -> Result<TextLayerResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_select(_doc_id: String, _page_index: usize, _a: [f32; 2], _b: [f32; 2], _mode: Option<String>) -> Result<SelectionResponse, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_render_page(_doc_id: String, _page_index: usize, _scale: f32, _rotation: Option<f32>, _clip: Option<[f32; 4]>, _request_id: String) -> Result<Response, String> { unavailable() }
    #[tauri::command] pub fn mupdf_cancel_render(_doc_id: String, _request_id: String) -> bool { false }
    #[tauri::command] pub async fn mupdf_get_outline_flat(_doc_id: String) -> Result<Vec<FlatOutlineItem>, String> { unavailable() }
    #[tauri::command] pub async fn mupdf_get_links(_doc_id: String, _page_index: usize) -> Result<Vec<serde_json::Value>, String> { unavailable() }
    #[tauri::command] pub fn mupdf_close_document(_doc_id: String) -> bool { false }
}

pub use imp::*;
