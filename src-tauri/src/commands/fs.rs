use std::path::Path;
use tokio::fs;
use tauri::ipc::Response;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "epub", "pdf", "djvu", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz",
];

#[tauri::command]
pub async fn fs_read_buffer(file_path: String) -> Result<Response, String> {
    let clean_str = file_path.trim().trim_matches('"').trim_matches('\'');
    let raw_path = Path::new(clean_str);
    let abs_path = std::path::absolute(raw_path).unwrap_or_else(|_| raw_path.to_path_buf());
    let path = abs_path.as_path();

    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if !SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("Blocked reading non-book file via IPC: {}", file_path));
    }

    let bytes = fs::read(path)
        .await
        .map_err(|e| format!("Failed reading file '{}': {}", file_path, e))?;

    Ok(Response::new(bytes))
}

