use std::sync::Mutex;
use serde::Serialize;
use tauri::Window;
use crate::commands::fs::SUPPORTED_EXTENSIONS;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilePayload {
    pub file_path: String,
    pub filename: String,
    pub buffer: Vec<u8>,
}

#[derive(Default, Debug)]
pub struct CloseState {
    pub pending_request_id: Option<String>,
    pub close_permitted: bool,
}

#[derive(Default)]
pub struct AppState {
    pub pending_files: Mutex<Vec<String>>,
    pub is_renderer_ready: Mutex<bool>,
    pub close_state: Mutex<CloseState>,
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
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> bool {
    use tauri::Emitter;
    {
        let mut ready = state.is_renderer_ready.lock().unwrap();
        *ready = true;
    }

    let files_to_emit: Vec<String> = {
        let mut queue = state.pending_files.lock().unwrap();
        queue.drain(..).collect()
    };

    for file_path in files_to_emit {
        match load_open_file_payload(&file_path) {
            Ok(payload) => {
                let _ = app.emit("app:open-file", payload);
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
    let should_close = {
        let mut close_state = state.close_state.lock().unwrap();
        match (&close_state.pending_request_id, &request_id) {
            (Some(pending), Some(req)) if !req.is_empty() && pending == req => {
                close_state.pending_request_id = None;
                close_state.close_permitted = true;
                eprintln!("[app_flush_complete] Flush complete acknowledged for {:?}. Permitting window close.", req);
                true
            }
            (Some(pending), req) => {
                eprintln!("[app_flush_complete] Ignored invalid/mismatched request_id: {:?} (expected {:?})", req, pending);
                false
            }
            (None, _) => {
                eprintln!("[app_flush_complete] Ignored flush complete with no pending close request.");
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


