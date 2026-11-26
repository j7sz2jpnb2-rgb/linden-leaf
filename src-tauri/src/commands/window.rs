use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use tauri::{Manager, Window};
use crate::commands::fs::SUPPORTED_EXTENSIONS;

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);

pub fn next_request_id(prefix: &str) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{now_ms}_{seq}")
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilePayload {
    pub file_path: String,
    pub filename: String,
    pub buffer: Vec<u8>,
    pub target_window: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Default, Debug, Clone)]
pub struct CloseState {
    pub pending_request_id: Option<String>,
    pub close_permitted: bool,
}

#[derive(Default)]
pub struct AppState {
    /// Pending files queued for opening: (target_window_label, file_path)
    pub pending_files: Mutex<Vec<(Option<String>, String)>>,
    pub initial_boot_files: Mutex<Vec<(Option<String>, String)>>,
    /// Per-window renderer readiness state keyed by window label
    pub ready_windows: Mutex<HashMap<String, bool>>,
    /// Legacy fallback flag so any existing check remains compatible
    pub is_renderer_ready: Mutex<bool>,
    /// Per-window close handshake state keyed by window label
    pub close_state: Mutex<HashMap<String, CloseState>>,
}

pub fn sanitize_window_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "win".to_string()
    } else {
        out
    }
}

pub fn url_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match *byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            b => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

fn default_window_title(locale: Option<&str>) -> &'static str {
    crate::commands::l10n(
        crate::commands::is_en_locale(locale),
        "Linden Leaf - 桌面端电子书阅读器",
        "Linden Leaf - Desktop Ebook Reader",
    )
}

fn resolve_window_title(title: Option<&str>, locale: Option<&str>, append_brand: bool) -> String {
    match title {
        Some(t) if !t.trim().is_empty() => {
            if append_brand {
                format!("{} - Linden Leaf", t.trim())
            } else {
                t.trim().to_string()
            }
        }
        _ => default_window_title(locale).to_string(),
    }
}

/// Converts a window's physical outer position into a cascaded logical position
/// suitable for `WebviewWindowBuilder::position(f64, f64)`.
/// Returns `None` when the anchor window is minimized or has Windows' off-screen
/// minimized sentinel coordinates (e.g., `-32000`), signaling the caller to `.center()`.
#[cfg_attr(not(desktop), allow(dead_code))]
fn compute_cascaded_logical_position(
    physical_x: i32,
    physical_y: i32,
    scale_factor: f64,
    is_minimized: bool,
    offset_step: i32,
) -> Option<(f64, f64)> {
    if is_minimized || physical_x <= -10000 || physical_y <= -10000 {
        return None;
    }
    let scale = if scale_factor.is_finite() && scale_factor >= 0.5 {
        scale_factor
    } else {
        1.0
    };
    let logical_x = (physical_x as f64) / scale + 36.0 + (offset_step as f64);
    let logical_y = (physical_y as f64) / scale + 28.0 + (offset_step as f64);
    Some((logical_x, logical_y))
}

fn validate_external_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    let parsed = reqwest::Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().map(|h| !h.is_empty()).unwrap_or(false) {
                Some(parsed.to_string())
            } else {
                None
            }
        }
        "mailto" => {
            if !parsed.path().trim().is_empty() {
                Some(parsed.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn spawn_new_app_window(
    app: &tauri::AppHandle,
    label_override: Option<String>,
    query: Option<String>,
    title_override: Option<String>,
) -> Result<(String, bool), String> {
    spawn_new_app_window_localized(app, label_override, query, title_override, None)
}

pub fn spawn_new_app_window_localized(
    app: &tauri::AppHandle,
    label_override: Option<String>,
    query: Option<String>,
    title_override: Option<String>,
    locale: Option<String>,
) -> Result<(String, bool), String> {
    let label = match label_override {
        Some(l) if !l.trim().is_empty() => sanitize_window_label(l.trim()),
        _ => {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
            format!("win_{now_ms}_{seq}")
        }
    };

    if let Some(existing) = app.get_webview_window(&label) {
        #[cfg(desktop)]
        {
            if let Some(ref t) = title_override {
                if !t.trim().is_empty() {
                    let _ = existing.set_title(&format!("{} - Linden Leaf", t.trim()));
                }
            }
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
        }
        return Ok((label, true));
    }

    let url_path = match query {
        Some(q) if !q.trim().is_empty() => {
            let clean_q = q.trim().trim_start_matches('?');
            format!("index.html?{clean_q}")
        }
        _ => "index.html".to_string(),
    };

    let win_title = resolve_window_title(title_override.as_deref(), locale.as_deref(), true);

    #[cfg(desktop)]
    {
        let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
        let offset_step = ((seq % 6) as i32) * 28;
        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::App(url_path.into()),
        )
        .title(&win_title)
        .inner_size(1360.0, 880.0)
        .min_inner_size(960.0, 640.0)
        .decorations(true)
        .resizable(true)
        .visible(true)
        .focused(true);

        if let Some(main_win) = app.get_webview_window("main") {
            let is_minimized = main_win.is_minimized().unwrap_or(false);
            let scale_factor = main_win.scale_factor().unwrap_or(1.0);
            if let Some((lx, ly)) = main_win.outer_position().ok().and_then(|pos| {
                compute_cascaded_logical_position(
                    pos.x,
                    pos.y,
                    scale_factor,
                    is_minimized,
                    offset_step,
                )
            }) {
                builder = builder.position(lx, ly);
            } else {
                builder = builder.center();
            }
        } else {
            builder = builder.center();
        }

        let new_win = builder.build().map_err(|e| format!("Failed to create window: {e}"))?;
        let _ = new_win.unminimize();
        let _ = new_win.show();
        let _ = new_win.set_focus();
    }

    Ok((label, false))
}

#[tauri::command]
pub async fn window_open_new(
    app: tauri::AppHandle,
    book_id: Option<String>,
    window_mode: Option<String>,
    title: Option<String>,
    locale: Option<String>,
) -> Result<serde_json::Value, String> {
    let mode = window_mode.unwrap_or_else(|| {
        if book_id.is_some() {
            "reader".to_string()
        } else {
            "shelf".to_string()
        }
    });

    let (label_override, query) = if let Some(ref bid) = book_id {
        let trimmed = bid.trim();
        if !trimmed.is_empty() {
            let lbl = format!("reader-{}", sanitize_window_label(trimmed));
            let encoded_id = url_encode_component(trimmed);
            let encoded_mode = url_encode_component(&mode);
            let q = format!("windowMode={encoded_mode}&bookId={encoded_id}");
            (Some(lbl), Some(q))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let (label, already_exists) =
        spawn_new_app_window_localized(&app, label_override, query, title, locale)?;
    Ok(serde_json::json!({
        "success": true,
        "windowLabel": label,
        "alreadyExists": already_exists
    }))
}

pub fn extract_book_path_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    extract_book_path_from_args_with_cwd(args, None)
}

pub fn extract_book_path_from_args_with_cwd<I, S>(args: I, cwd: Option<&str>) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    extract_book_paths_from_args_with_cwd(args, cwd).into_iter().next()
}

pub fn extract_book_paths_from_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    extract_book_paths_from_args_with_cwd(args, None)
}

pub fn extract_book_paths_from_args_with_cwd<I, S>(args: I, cwd: Option<&str>) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut results = Vec::new();
    for arg in args {
        let raw = arg.as_ref();
        let s = raw.trim().trim_matches('"').trim_matches('\'');
        if s.starts_with('-') || s.is_empty() {
            continue;
        }
        let p = std::path::Path::new(s);
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            let ext_lower = ext.to_lowercase();
            if SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
                if p.exists() {
                    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
                    results.push(abs.to_string_lossy().to_string());
                    continue;
                }
                if let Some(c) = cwd {
                    let combined = std::path::Path::new(c).join(p);
                    if combined.exists() {
                        let abs = std::path::absolute(&combined).unwrap_or(combined);
                        results.push(abs.to_string_lossy().to_string());
                        continue;
                    }
                }
            }
        }
    }
    results
}

pub fn load_open_file_payload(
    file_path: &str,
    target_window: Option<String>,
    request_id: Option<String>,
) -> Result<OpenFilePayload, String> {
    let clean = file_path.trim().trim_matches('"').trim_matches('\'');
    let raw_path = std::path::Path::new(clean);
    let abs_path = std::path::absolute(raw_path).unwrap_or_else(|_| raw_path.to_path_buf());
    let path = abs_path.as_path();

    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book")
        .to_string();
    // Avoid reading & serializing full book bytes as a 4x-bloated JSON number array over Tauri Event IPC.
    // Frontend handleOpenFile automatically stages PDFs via mupdf_stage_pdf_source and reads via binary Response IPC (fs_read_buffer).
    Ok(OpenFilePayload {
        file_path: path.to_string_lossy().to_string(),
        filename,
        buffer: Vec::new(),
        target_window,
        request_id,
    })
}

#[tauri::command]
pub fn window_minimize(window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        window.minimize().map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        Ok(())
    }
}

#[tauri::command]
pub fn window_maximize(window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())
        } else {
            window.maximize().map_err(|e| e.to_string())
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        Ok(())
    }
}

#[tauri::command]
pub fn window_close(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_is_maximized(window: Window) -> bool {
    #[cfg(desktop)]
    {
        window.is_maximized().unwrap_or(false)
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        true
    }
}

#[tauri::command]
pub fn window_toggle_fullscreen(window: Window) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Emitter;
        let is_fs = window.is_fullscreen().unwrap_or(false);
        let next_fs = !is_fs;
        window.set_fullscreen(next_fs).map_err(|e| e.to_string())?;
        let _ = window.emit_to(window.label(), "window:fullscreen-change", next_fs);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        Ok(())
    }
}

#[tauri::command]
pub fn window_is_fullscreen(window: Window) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
pub fn window_set_always_on_top(window: Window, always_on_top: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, always_on_top);
        Ok(())
    }
}

#[tauri::command]
pub fn window_set_title(
    window: Window,
    title: Option<String>,
    locale: Option<String>,
) -> Result<(), String> {
    let resolved = resolve_window_title(title.as_deref(), locale.as_deref(), false);
    #[cfg(desktop)]
    {
        window.set_title(&resolved).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, resolved);
        Ok(())
    }
}

#[tauri::command]
pub fn window_is_always_on_top(window: Window) -> bool {
    window.is_always_on_top().unwrap_or(false)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_hex_to_colorref(hex: &str) -> Option<u32> {
    let clean = hex.trim().trim_start_matches('#');
    if !clean.is_ascii() {
        return None;
    }
    let expanded = if clean.len() == 3 {
        let mut s = String::with_capacity(6);
        for ch in clean.chars() {
            s.push(ch);
            s.push(ch);
        }
        s
    } else if clean.len() == 6 {
        clean.to_string()
    } else {
        return None;
    };
    let r = u32::from_str_radix(&expanded[0..2], 16).ok()?;
    let g = u32::from_str_radix(&expanded[2..4], 16).ok()?;
    let b = u32::from_str_radix(&expanded[4..6], 16).ok()?;
    // Win32 COLORREF layout is 0x00BBGGRR
    Some((b << 16) | (g << 8) | r)
}

#[tauri::command]
pub fn window_set_titlebar_theme(
    window: Window,
    bg_hex: String,
    text_hex: Option<String>,
    is_dark: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        // Cross-platform light/dark window chrome (Windows 10/11, macOS, Linux).
        let target_theme = if is_dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        };
        let _ = window.set_theme(Some(target_theme));

        #[cfg(target_os = "windows")]
        {
            #[link(name = "dwmapi")]
            extern "system" {
                fn DwmSetWindowAttribute(
                    hwnd: *mut std::ffi::c_void,
                    dw_attribute: u32,
                    pv_attribute: *const std::ffi::c_void,
                    cb_attribute: u32,
                ) -> i32;
            }

            // Windows 10 1809–1909 uses attribute 19; Windows 10 20H1+ & Windows 11 use attribute 20.
            // Custom caption/text RGB colors (35/36) apply on Windows 11 (22000+) and are safely
            // ignored with an HRESULT error on Windows 10, where immersive dark/light mode still works.
            const DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1: u32 = 19;
            const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
            const DWMWA_CAPTION_COLOR: u32 = 35;
            const DWMWA_TEXT_COLOR: u32 = 36;

            if let Ok(hwnd) = window.hwnd() {
                let hwnd_ptr = hwnd.0 as *mut std::ffi::c_void;
                let dark_val: i32 = if is_dark { 1 } else { 0 };
                unsafe {
                    let hr = DwmSetWindowAttribute(
                        hwnd_ptr,
                        DWMWA_USE_IMMERSIVE_DARK_MODE,
                        &dark_val as *const i32 as *const std::ffi::c_void,
                        std::mem::size_of::<i32>() as u32,
                    );
                    if hr != 0 {
                        let _ = DwmSetWindowAttribute(
                            hwnd_ptr,
                            DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1,
                            &dark_val as *const i32 as *const std::ffi::c_void,
                            std::mem::size_of::<i32>() as u32,
                        );
                    }
                    if let Some(bg_colorref) = parse_hex_to_colorref(&bg_hex) {
                        let _ = DwmSetWindowAttribute(
                            hwnd_ptr,
                            DWMWA_CAPTION_COLOR,
                            &bg_colorref as *const u32 as *const std::ffi::c_void,
                            std::mem::size_of::<u32>() as u32,
                        );
                    }
                    if let Some(ref txt) = text_hex {
                        if let Some(txt_colorref) = parse_hex_to_colorref(txt) {
                            let _ = DwmSetWindowAttribute(
                                hwnd_ptr,
                                DWMWA_TEXT_COLOR,
                                &txt_colorref as *const u32 as *const std::ffi::c_void,
                                std::mem::size_of::<u32>() as u32,
                            );
                        }
                    }
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (&bg_hex, &text_hex);
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, bg_hex, text_hex, is_dark);
        Ok(())
    }
}

#[tauri::command]
pub async fn shell_open_external(
    #[allow(unused)] app: tauri::AppHandle,
    url: String,
) -> Result<bool, String> {
    let Some(safe_url) = validate_external_url(&url) else {
        return Ok(false);
    };

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &safe_url])
            .spawn();
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&safe_url).spawn();
        Ok(true)
    }

    #[cfg(all(unix, not(any(target_os = "macos", target_os = "android", target_os = "ios"))))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&safe_url).spawn();
        Ok(true)
    }

    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(serde::Serialize)]
        struct OpenExternalArgs {
            url: String,
        }
        #[derive(serde::Deserialize)]
        struct OpenExternalResult {
            #[serde(default)]
            opened: bool,
        }
        let Some(bridge) = app.try_state::<crate::LindenMobileBridge>() else {
            return Ok(false);
        };
        match bridge
            .0
            .run_mobile_plugin::<OpenExternalResult>("openExternalUrl", OpenExternalArgs { url: safe_url })
        {
            Ok(res) => Ok(res.opened),
            Err(e) => {
                eprintln!("[shell_open_external] Android openExternalUrl failed: {}", e);
                Ok(false)
            }
        }
    }

    #[cfg(target_os = "ios")]
    {
        eprintln!("[shell_open_external] Process spawn is unsupported on iOS; delegate to mobile intent/browser handler: {}", safe_url);
        Ok(false)
    }
}

#[tauri::command]
pub fn app_get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

static PROCESS_START_EPOCH_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

pub fn init_process_start_epoch_ms() -> u64 {
    *PROCESS_START_EPOCH_MS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    })
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BootContextResponse {
    pub boot_id: String,
    pub process_start_epoch_ms: u64,
    pub launch_mode: String,
    pub window_label: String,
    pub pending_files: Vec<String>,
}

pub(crate) fn take_initial_boot_files_for_window(
    initial: &mut Vec<(Option<String>, String)>,
    win_label: &str,
) -> Vec<String> {
    let mut matched = Vec::new();
    initial.retain(|(target_lbl, path)| {
        let matches_window = match target_lbl {
            Some(lbl) => lbl == win_label,
            None => win_label == "main",
        };
        if matches_window {
            matched.push(path.clone());
            false
        } else {
            true
        }
    });
    matched
}

#[tauri::command]
pub fn app_get_boot_context(
    window: Window,
    state: tauri::State<AppState>,
) -> BootContextResponse {
    let start_ms = init_process_start_epoch_ms();
    let win_label = window.label().to_string();
    let initial_for_window: Vec<String> = {
        let mut initial = state.initial_boot_files.lock().unwrap_or_else(|e| e.into_inner());
        take_initial_boot_files_for_window(&mut initial, &win_label)
    };
    let pending_for_window: Vec<String> = {
        let queue = state.pending_files.lock().unwrap_or_else(|e| e.into_inner());
        queue
            .iter()
            .filter_map(|(target_lbl, path)| match target_lbl {
                Some(lbl) if lbl == &win_label => Some(path.clone()),
                None if win_label == "main" => Some(path.clone()),
                _ => None,
            })
            .collect()
    };
    let effective_files = if !initial_for_window.is_empty() {
        initial_for_window
    } else {
        pending_for_window
    };
    let launch_mode = if !effective_files.is_empty() {
        "external-file".to_string()
    } else if win_label != "main" {
        "satellite".to_string()
    } else {
        "shelf".to_string()
    };
    BootContextResponse {
        boot_id: format!("boot_{}_{}", start_ms, std::process::id()),
        process_start_epoch_ms: start_ms,
        launch_mode,
        window_label: win_label,
        pending_files: effective_files,
    }
}

#[allow(dead_code)]
fn _app_get_version_compat() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn app_renderer_ready(
    window: Window,
    state: tauri::State<AppState>,
) -> bool {
    use tauri::Emitter;
    let win_label = window.label().to_string();

    {
        let mut ready = state.is_renderer_ready.lock().unwrap_or_else(|e| e.into_inner());
        *ready = true;
    }
    {
        let mut ready_map = state.ready_windows.lock().unwrap_or_else(|e| e.into_inner());
        ready_map.insert(win_label.clone(), true);
    }

    let files_to_emit: Vec<String> = {
        let mut queue = state.pending_files.lock().unwrap_or_else(|e| e.into_inner());
        let mut matched = Vec::new();
        let mut remaining = Vec::new();
        for (target_lbl, path) in queue.drain(..) {
            match target_lbl {
                Some(ref lbl) if lbl == &win_label => matched.push(path),
                None if win_label == "main" => matched.push(path),
                other => remaining.push((other, path)),
            }
        }
        *queue = remaining;
        matched
    };

    for file_path in files_to_emit {
        let req_id = format!("req_{}_{}", win_label, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis());
        match load_open_file_payload(&file_path, Some(win_label.clone()), Some(req_id)) {
            Ok(payload) => {
                let _ = window.emit_to(&win_label, "app:open-file", payload);
            }
            Err(e) => {
                eprintln!("[app_renderer_ready] Error loading pending file: {}", e);
            }
        }
    }

    true
}

#[tauri::command]
pub fn app_flush_complete(
    request_id: Option<String>,
    window: Window,
    state: tauri::State<AppState>,
) -> bool {
    let win_label = window.label().to_string();
    let should_close = {
        let mut close_map = state.close_state.lock().unwrap_or_else(|e| e.into_inner());
        let entry = close_map.entry(win_label.clone()).or_default();
        match (&entry.pending_request_id, &request_id) {
            (Some(pending), Some(req)) if !req.is_empty() && pending == req => {
                entry.pending_request_id = None;
                entry.close_permitted = true;
                eprintln!("[app_flush_complete] Flush complete acknowledged for window {:?} ({:?}). Permitting close.", win_label, req);
                true
            }
            (Some(pending), req) => {
                eprintln!("[app_flush_complete] Ignored invalid/mismatched request_id on {:?}: {:?} (expected {:?})", win_label, req, pending);
                false
            }
            (None, _) => {
                eprintln!("[app_flush_complete] Ignored flush complete on {:?} with no pending close request.", win_label);
                false
            }
        }
    };

    if should_close {
        let _ = window.close();
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn app_write_boot_metrics(payload: serde_json::Value) -> Result<bool, String> {
    let target = match std::env::var_os("LINDEN_BOOT_METRICS_FILE") {
        Some(v) if !v.is_empty() => std::path::PathBuf::from(v),
        _ => return Ok(false),
    };
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create boot metrics dir: {e}"))?;
        }
    }
    let json_text = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize boot metrics: {e}"))?;
    let temp_path = target.with_extension("json.tmp");
    std::fs::write(&temp_path, json_text.as_bytes())
        .map_err(|e| format!("Failed to write boot metrics temp file: {e}"))?;
    std::fs::rename(&temp_path, &target)
        .or_else(|_| {
            std::fs::write(&target, json_text.as_bytes())?;
            let _ = std::fs::remove_file(&temp_path);
            Ok::<(), std::io::Error>(())
        })
        .map_err(|e| format!("Failed to finalize boot metrics file: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_window_label() {
        assert_eq!(sanitize_window_label(""), "win");
        assert_eq!(sanitize_window_label("reader-123_abc"), "reader-123_abc");
        assert_eq!(sanitize_window_label("book:123/part?one"), "book_123_part_one");
        assert_eq!(sanitize_window_label("理想国"), "___");
        assert_eq!(sanitize_window_label("   "), "___");
        assert_eq!(sanitize_window_label("My-Book_42"), "My-Book_42");
    }

    #[test]
    fn test_extract_book_paths_flags_and_extensions() {
        let args = vec![
            "linden-leaf.exe".to_string(),
            "--devtools".to_string(),
            "-f".to_string(),
            "invalid_file.xyz".to_string(),
            "nonexistent_book.pdf".to_string(),
        ];
        // Nonexistent files should be filtered out
        let res = extract_book_paths_from_args_with_cwd(&args, None);
        assert!(res.is_empty());
    }

    #[test]
    fn test_extract_book_paths_with_real_temp_file() {
        let dir = std::env::temp_dir();
        let test_file = dir.join("test_book_sample.epub");
        let _ = std::fs::write(&test_file, b"test content");

        let args = vec![
            "--flag".to_string(),
            test_file.to_string_lossy().to_string(),
        ];
        let res = extract_book_paths_from_args_with_cwd(&args, None);
        assert_eq!(res.len(), 1);
        assert!(res[0].ends_with("test_book_sample.epub"));

        let _ = std::fs::remove_file(&test_file);
    }

    #[test]
    fn test_extract_book_paths_relative_with_cwd() {
        let dir = std::env::temp_dir();
        let rel_file = "test_rel_sample.pdf";
        let full_path = dir.join(rel_file);
        let _ = std::fs::write(&full_path, b"%PDF-1.4 test");

        let cwd_str = dir.to_string_lossy().to_string();
        let args = vec![rel_file.to_string()];
        let res = extract_book_paths_from_args_with_cwd(&args, Some(&cwd_str));
        assert_eq!(res.len(), 1);
        assert!(res[0].ends_with("test_rel_sample.pdf"));

        let _ = std::fs::remove_file(&full_path);
    }

    #[test]
    fn test_multi_window_close_state_isolation() {
        let mut close_map: HashMap<String, CloseState> = HashMap::new();
        let main_entry = close_map.entry("main".to_string()).or_default();
        main_entry.pending_request_id = Some("flush_main_123".to_string());

        let reader_entry = close_map.entry("reader-1".to_string()).or_default();
        reader_entry.pending_request_id = Some("flush_reader_456".to_string());

        assert_eq!(close_map.get("main").unwrap().pending_request_id.as_deref(), Some("flush_main_123"));
        assert_eq!(close_map.get("reader-1").unwrap().pending_request_id.as_deref(), Some("flush_reader_456"));
        assert!(!close_map.get("main").unwrap().close_permitted);
        assert!(!close_map.get("reader-1").unwrap().close_permitted);
    }

    #[test]
    fn test_url_encode_component() {
        assert_eq!(url_encode_component("simple_id-123.test~"), "simple_id-123.test~");
        assert_eq!(
            url_encode_component("book 1?test#foo&bar=baz+special%20char"),
            "book%201%3Ftest%23foo%26bar%3Dbaz%2Bspecial%2520char"
        );
        assert_eq!(url_encode_component("理想国"), "%E7%90%86%E6%83%B3%E5%9B%BD");
    }

    #[test]
    fn test_localized_window_titles() {
        assert_eq!(default_window_title(None), "Linden Leaf - 桌面端电子书阅读器");
        assert_eq!(default_window_title(Some("zh-CN")), "Linden Leaf - 桌面端电子书阅读器");
        assert_eq!(default_window_title(Some("fr")), "Linden Leaf - 桌面端电子书阅读器");
        assert_eq!(default_window_title(Some("en")), "Linden Leaf - Desktop Ebook Reader");
        assert_eq!(default_window_title(Some("en-US")), "Linden Leaf - Desktop Ebook Reader");

        assert_eq!(
            resolve_window_title(Some("Dune"), Some("en"), true),
            "Dune - Linden Leaf"
        );
        assert_eq!(
            resolve_window_title(Some("Dune - Linden Leaf"), Some("en"), false),
            "Dune - Linden Leaf"
        );
        assert_eq!(
            resolve_window_title(Some("   "), Some("en"), false),
            "Linden Leaf - Desktop Ebook Reader"
        );
        assert_eq!(
            resolve_window_title(None, None, true),
            "Linden Leaf - 桌面端电子书阅读器"
        );
    }

    #[test]
    fn test_compute_cascaded_logical_position() {
        assert_eq!(compute_cascaded_logical_position(100, 80, 1.0, false, 28), Some((164.0, 136.0)));
        assert_eq!(compute_cascaded_logical_position(300, 150, 1.5, false, 0), Some((236.0, 128.0)));
        assert_eq!(compute_cascaded_logical_position(400, 200, 2.0, false, 56), Some((292.0, 184.0)));
        assert_eq!(compute_cascaded_logical_position(100, 80, 1.0, true, 0), None);
        assert_eq!(compute_cascaded_logical_position(-32000, -32000, 1.0, false, 0), None);
        assert_eq!(compute_cascaded_logical_position(100, 80, 0.0, false, 0), Some((136.0, 108.0)));
    }

    #[test]
    fn test_validate_external_url() {
        assert_eq!(
            validate_external_url("https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases"),
            Some("https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases".to_string())
        );
        assert_eq!(
            validate_external_url("http://example.com/path?a=1&b=2"),
            Some("http://example.com/path?a=1&b=2".to_string())
        );
        assert!(validate_external_url("mailto:support@example.com").is_some());
        assert_eq!(validate_external_url("mailto:"), None);
        assert_eq!(validate_external_url("http://"), None);
        assert_eq!(validate_external_url("file:///C:/Windows/System32/calc.exe"), None);
        assert_eq!(validate_external_url("javascript:alert(1)"), None);
        assert_eq!(validate_external_url("https://example.com/\r\nInjected"), None);
        assert_eq!(validate_external_url("https://example.com/test\0bad"), None);
        assert_eq!(validate_external_url("   "), None);
    }

    #[test]
    fn test_take_initial_boot_files_consumes_once_per_window() {
        let mut queue = vec![
            (None, "C:\\books\\first.pdf".to_string()),
            (Some("reader-2".to_string()), "C:\\books\\second.epub".to_string()),
        ];

        assert_eq!(
            take_initial_boot_files_for_window(&mut queue, "main"),
            vec!["C:\\books\\first.pdf".to_string()]
        );
        // Subsequent boot context query (e.g., WebView reload) must see empty boot queue.
        assert!(take_initial_boot_files_for_window(&mut queue, "main").is_empty());

        // Entries targeting other windows remain intact until that window consumes them.
        assert_eq!(
            take_initial_boot_files_for_window(&mut queue, "reader-2"),
            vec!["C:\\books\\second.epub".to_string()]
        );
        assert!(queue.is_empty());
    }

    #[test]
    fn test_parse_hex_to_colorref() {
        // Win32 COLORREF is 0x00BBGGRR
        assert_eq!(parse_hex_to_colorref("#faf8f5"), Some(0x00F5F8FA));
        assert_eq!(parse_hex_to_colorref("#1f1d1a"), Some(0x001A1D1F));
        assert_eq!(parse_hex_to_colorref("#fff"), Some(0x00FFFFFF));
        assert_eq!(parse_hex_to_colorref("123456"), Some(0x00563412));
        assert_eq!(parse_hex_to_colorref(""), None);
        assert_eq!(parse_hex_to_colorref("#12345"), None);
        assert_eq!(parse_hex_to_colorref("#zzzzzz"), None);
        assert_eq!(parse_hex_to_colorref("#中文"), None);
        assert_eq!(parse_hex_to_colorref("#你好啊"), None);
    }
}

