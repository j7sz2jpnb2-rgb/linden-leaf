use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use tauri::{Manager, Window};
use crate::commands::fs::SUPPORTED_EXTENSIONS;

static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilePayload {
    pub file_path: String,
    pub filename: String,
    pub buffer: Vec<u8>,
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

pub fn spawn_new_app_window(
    app: &tauri::AppHandle,
    label_override: Option<String>,
    query: Option<String>,
    title_override: Option<String>,
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

    let win_title = match title_override {
        Some(t) if !t.trim().is_empty() => format!("{} - Linden Leaf", t.trim()),
        _ => "Linden Leaf - 桌面端电子书阅读器".to_string(),
    };

    #[cfg(desktop)]
    {
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::App(url_path.into()),
        )
        .title(&win_title)
        .inner_size(1360.0, 880.0)
        .min_inner_size(960.0, 640.0)
        .decorations(true)
        .resizable(true)
        .center();

        let new_win = builder.build().map_err(|e| format!("Failed to create window: {e}"))?;
        let _ = new_win.show();
        let _ = new_win.set_focus();
    }

    Ok((label, false))
}

#[tauri::command]
pub fn window_open_new(
    app: tauri::AppHandle,
    book_id: Option<String>,
    window_mode: Option<String>,
    title: Option<String>,
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
            let encoded_id = trimmed.replace('&', "%26").replace('=', "%3D").replace('#', "%23");
            let q = format!("windowMode={mode}&bookId={encoded_id}");
            (Some(lbl), Some(q))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let (label, already_exists) = spawn_new_app_window(&app, label_override, query, title)?;
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

pub fn load_open_file_payload(file_path: &str) -> Result<OpenFilePayload, String> {
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
    let buffer = std::fs::read(path)
        .map_err(|e| format!("Failed reading file '{}': {}", file_path, e))?;

    Ok(OpenFilePayload {
        file_path: path.to_string_lossy().to_string(),
        filename,
        buffer,
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
        let _ = window.emit("window:fullscreen-change", next_fs);
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
pub async fn shell_open_external(url: String) -> Result<bool, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") && !url.starts_with("mailto:") {
        return Ok(false);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn();
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
        Ok(true)
    }

    #[cfg(all(unix, not(any(target_os = "macos", target_os = "android", target_os = "ios"))))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
        Ok(true)
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        eprintln!("[shell_open_external] Process spawn is unsupported on mobile; delegate to mobile intent/browser handler: {}", url);
        Ok(false)
    }
}

#[tauri::command]
pub fn app_get_version() -> String {
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
        let mut ready = state.is_renderer_ready.lock().unwrap();
        *ready = true;
    }
    {
        let mut ready_map = state.ready_windows.lock().unwrap();
        ready_map.insert(win_label.clone(), true);
    }

    let files_to_emit: Vec<String> = {
        let mut queue = state.pending_files.lock().unwrap();
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
        match load_open_file_payload(&file_path) {
            Ok(payload) => {
                let _ = window.emit("app:open-file", payload);
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
        let mut close_map = state.close_state.lock().unwrap();
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
}

