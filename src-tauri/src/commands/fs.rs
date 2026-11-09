use std::path::{Path, PathBuf};
use tokio::fs;
use tauri::ipc::Response;
use tauri::Manager;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "epub", "pdf", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz", "djvu",
];

#[derive(serde::Serialize, Clone, Debug)]
pub struct FolderBookItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_time: u64,
    pub mtime: u64,
    pub extension: String,
    pub ext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_id: Option<String>,
    #[serde(rename = "volumeId", skip_serializing_if = "Option::is_none")]
    pub volume_id_camel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    #[serde(rename = "fileId", skip_serializing_if = "Option::is_none")]
    pub file_id_camel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_hash: Option<String>,
    #[serde(rename = "documentHash", skip_serializing_if = "Option::is_none")]
    pub document_hash_camel: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct FolderScanResponse {
    pub files: Vec<FolderBookItem>,
    pub complete: bool,
    pub errors: Vec<String>,
    pub failed_dirs: Vec<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct AppPathsInfo {
    pub config_dir: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub snapshot_dir: String,
    pub documents_dir: String,
    pub webview_profile_dir: String,
    pub indexeddb_dir: String,
}

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

#[tauri::command]
pub async fn fs_write_file(file_path: String, content: String) -> Result<(), String> {
    let clean = file_path.trim().trim_matches('"').trim_matches('\'');
    let path = Path::new(clean);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed creating parent directories: {e}"))?;
        }
    }
    fs::write(path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed writing file '{}': {}", file_path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_compute_file_hash(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::Hasher;
        use std::io::Read;

        let clean = file_path.trim().trim_matches('"').trim_matches('\'');
        let path = Path::new(clean);
        if !path.exists() || !path.is_file() {
            return Err(format!("File does not exist: {}", file_path));
        }
        let mut f = std::fs::File::open(path)
            .map_err(|e| format!("Failed opening file '{}': {}", file_path, e))?;
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut hasher = DefaultHasher::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("Failed reading file '{}': {}", file_path, e))?;
            if n == 0 {
                break;
            }
            hasher.write(&buf[..n]);
        }
        Ok(format!("hash_{:x}_{size}", hasher.finish()))
    })
    .await
    .map_err(|e| format!("Compute file hash task failed: {e}"))?
}

#[tauri::command]
pub async fn fs_scan_folder(
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<FolderScanResponse, String> {
    tokio::task::spawn_blocking(move || {
        let clean = folder_path.trim().trim_matches('"').trim_matches('\'');
        let root = Path::new(clean);
        if !root.is_dir() {
            return Err(format!("Not a directory: {}", folder_path));
        }
        // Fail fast if root directory itself is unreadable (e.g. permission denied / unmounted)
        if let Err(e) = std::fs::read_dir(root) {
            return Err(format!("Cannot read root directory '{}': {}", folder_path, e));
        }

        let depth_limit = max_depth.unwrap_or(5);
        let mut results = Vec::new();
        let mut errors = Vec::new();
        let mut failed_dirs = Vec::new();

        fn scan_dir(
            dir: &Path,
            current_depth: usize,
            max_depth: usize,
            results: &mut Vec<FolderBookItem>,
            errors: &mut Vec<String>,
            failed_dirs: &mut Vec<String>,
        ) {
            if current_depth > max_depth {
                return;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(err) => {
                    let d = dir.to_string_lossy().to_string();
                    failed_dirs.push(d.clone());
                    errors.push(format!("{}: {}", d, err));
                    return;
                }
            };
            for entry_res in entries {
                let entry = match entry_res {
                    Ok(ent) => ent,
                    Err(err) => {
                        let d = dir.to_string_lossy().to_string();
                        errors.push(format!("{}: {}", d, err));
                        continue;
                    }
                };
                let p = entry.path();
                if p.is_dir() {
                    scan_dir(&p, current_depth + 1, max_depth, results, errors, failed_dirs);
                } else if p.is_file() {
                    let ext = p.extension()
                        .and_then(|e| e.to_str())
                        .map(|s| s.to_lowercase())
                        .unwrap_or_default();
                    if SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
                        let meta = entry.metadata().ok();
                        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified_time = meta.as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let name = p.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        #[cfg(target_os = "windows")]
                        let (volume_id, file_id) = {
                            use std::os::windows::io::AsRawHandle;
                            #[repr(C)]
                            struct BY_HANDLE_FILE_INFORMATION {
                                dw_file_attributes: u32,
                                ft_creation_time: [u32; 2],
                                ft_last_access_time: [u32; 2],
                                ft_last_write_time: [u32; 2],
                                dw_volume_serial_number: u32,
                                n_file_size_high: u32,
                                n_file_size_low: u32,
                                n_number_of_links: u32,
                                n_file_index_high: u32,
                                n_file_index_low: u32,
                            }
                            extern "system" {
                                fn GetFileInformationByHandle(
                                    h_file: *mut std::ffi::c_void,
                                    lp_file_information: *mut BY_HANDLE_FILE_INFORMATION,
                                ) -> i32;
                            }
                            if let Ok(file) = std::fs::File::open(&p) {
                                let handle = file.as_raw_handle();
                                let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
                                let res = unsafe { GetFileInformationByHandle(handle as *mut std::ffi::c_void, info.as_mut_ptr()) };
                                if res != 0 {
                                    let info = unsafe { info.assume_init() };
                                    let idx = ((info.n_file_index_high as u64) << 32) | (info.n_file_index_low as u64);
                                    let vol = format!("{:08x}", info.dw_volume_serial_number);
                                    let fid = format!("{:08x}:{:016x}", info.dw_volume_serial_number, idx);
                                    (Some(vol), Some(fid))
                                } else {
                                    (None, None)
                                }
                            } else {
                                (None, None)
                            }
                        };
                        #[cfg(not(target_os = "windows"))]
                        let (volume_id, file_id) = {
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::MetadataExt;
                                let vol = meta.as_ref().map(|m| m.dev().to_string());
                                let fid = meta.as_ref().map(|m| format!("{}:{}", m.dev(), m.ino()));
                                (vol, fid)
                            }
                            #[cfg(not(unix))]
                            {
                                (None::<String>, None::<String>)
                            }
                        };
                        results.push(FolderBookItem {
                            path: p.to_string_lossy().to_string(),
                            name,
                            size,
                            modified_time,
                            mtime: modified_time,
                            extension: ext.clone(),
                            ext,
                            volume_id: volume_id.clone(),
                            volume_id_camel: volume_id,
                            file_id: file_id.clone(),
                            file_id_camel: file_id,
                            document_hash: None,
                            document_hash_camel: None,
                        });
                    }
                }
            }
        }

        scan_dir(root, 0, depth_limit, &mut results, &mut errors, &mut failed_dirs);
        Ok(FolderScanResponse {
            files: results,
            complete: errors.is_empty(),
            errors,
            failed_dirs,
        })
    })
    .await
    .map_err(|e| format!("Scan folder task failed: {e}"))?
}

pub fn resolve_app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LINDEN_APP_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::data_dir()
        .map(|d| d.join("com.lindenleaf.reader"))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
pub fn fs_get_app_paths(app: tauri::AppHandle) -> Result<AppPathsInfo, String> {
    let config_dir = std::env::var("LINDEN_APP_CONFIG_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        app.path().app_config_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let data_dir = std::env::var("LINDEN_APP_DATA_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        app.path().app_data_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let cache_dir = app.path().app_cache_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let documents_dir = app.path().document_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    
    let snapshot_dir = crate::commands::mupdf::native_snapshot_dir_public(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| format!("{}\\pdf-native", cache_dir));

    let webview_profile_dir = std::env::var("WEBVIEW2_USER_DATA_FOLDER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Path::new(&data_dir).join("EBWebView").to_string_lossy().to_string());
    
    let indexeddb_dir = Path::new(&webview_profile_dir)
        .join("Default")
        .join("IndexedDB")
        .to_string_lossy()
        .to_string();

    Ok(AppPathsInfo {
        config_dir,
        data_dir,
        cache_dir,
        snapshot_dir,
        documents_dir,
        webview_profile_dir,
        indexeddb_dir,
    })
}

#[tauri::command]
pub fn fs_open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let clean = path.trim().trim_matches('"');
        let p = Path::new(clean);
        if p.is_file() {
            let _ = Command::new("explorer").arg(format!("/select,{}", clean)).spawn();
        } else {
            let _ = Command::new("explorer").arg(clean).spawn();
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}
