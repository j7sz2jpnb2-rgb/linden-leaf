use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tauri::ipc::Response;
use tauri::Manager;

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "epub", "pdf", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz",
];

pub const ALLOWED_TEXT_WRITE_EXTENSIONS: &[&str] = &["json", "md", "markdown", "txt", "csv", "tmp"];
pub const ALLOWED_BINARY_WRITE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const MAX_TEXT_WRITE_BYTES: usize = 64 * 1024 * 1024;
const MAX_BINARY_WRITE_BYTES: usize = 32 * 1024 * 1024;

static AUTHORIZED_WRITE_DIRS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
    std::sync::OnceLock::new();
static AUTHORIZED_SYNC_DIR: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> =
    std::sync::OnceLock::new();
static AUTHORIZED_SAVE_PATHS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<Vec<String>>>> =
    std::sync::OnceLock::new();
static CACHED_APP_CONFIG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static CACHED_APP_CACHE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_cached_extra_app_dirs(config_dir: Option<PathBuf>, cache_dir: Option<PathBuf>) {
    if let Some(dir) = config_dir {
        let _ = CACHED_APP_CONFIG_DIR.set(dir);
    }
    if let Some(dir) = cache_dir {
        let _ = CACHED_APP_CACHE_DIR.set(dir);
    }
}

fn to_absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn normalize_for_auth(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| to_absolute_path(path))
}

fn normalized_path_key(path: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::Prefix(prefix) => {
                let kind = match prefix.kind() {
                    std::path::Prefix::Disk(d) | std::path::Prefix::VerbatimDisk(d) => {
                        format!("disk:{}", (d as char).to_ascii_lowercase())
                    }
                    std::path::Prefix::UNC(server, share)
                    | std::path::Prefix::VerbatimUNC(server, share) => {
                        format!(
                            "unc:{}\\{}",
                            server.to_string_lossy().to_lowercase(),
                            share.to_string_lossy().to_lowercase()
                        )
                    }
                    _ => prefix.as_os_str().to_string_lossy().to_lowercase(),
                };
                out.push(kind);
            }
            std::path::Component::RootDir => out.push("/".to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => out.push("..".to_string()),
            std::path::Component::Normal(s) => {
                #[cfg(target_os = "windows")]
                out.push(s.to_string_lossy().to_lowercase());
                #[cfg(not(target_os = "windows"))]
                out.push(s.to_string_lossy().into_owned());
            }
        }
    }
    out
}

fn key_starts_with(path_key: &[String], root_key: &[String]) -> bool {
    !root_key.is_empty() && path_key.len() >= root_key.len() && &path_key[..root_key.len()] == root_key
}

pub fn register_authorized_write_dir(dir: &Path) {
    let norm = normalize_for_auth(dir);
    let set = AUTHORIZED_WRITE_DIRS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    set.lock().unwrap_or_else(|e| e.into_inner()).insert(norm);
}

pub fn set_authorized_sync_dir(dir: Option<&Path>) {
    let next = dir.map(normalize_for_auth);
    let slot = AUTHORIZED_SYNC_DIR.get_or_init(|| std::sync::Mutex::new(None));
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = next;
}

pub fn is_authorized_write_dir(dir: &Path) -> bool {
    let norm = normalize_for_auth(dir);
    let dir_key = normalized_path_key(&norm);
    authorized_root_dirs()
        .iter()
        .any(|root| key_starts_with(&dir_key, &normalized_path_key(root)))
}

pub fn register_authorized_save_path(path: &Path) {
    let norm = if let Some(parent) = path.parent() {
        let norm_parent = normalize_for_auth(parent);
        if let Some(name) = path.file_name() {
            norm_parent.join(name)
        } else {
            normalize_for_auth(path)
        }
    } else {
        normalize_for_auth(path)
    };
    let key = normalized_path_key(&norm);
    let set = AUTHORIZED_SAVE_PATHS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    set.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
}

pub(crate) fn validate_safe_path_syntax(raw: &str) -> Result<PathBuf, String> {
    let clean = raw.trim().trim_matches('"').trim_matches('\'');
    if clean.is_empty() {
        return Err("PATH_INVALID: Empty file path".to_string());
    }
    if clean.contains('\0') {
        return Err("PATH_INVALID: Path contains NUL byte".to_string());
    }
    let lower = clean.to_ascii_lowercase();
    if lower.starts_with(r"\\.\")
        || lower.starts_with(r"\??\")
        || lower.starts_with(r"\\?\globalroot")
    {
        return Err("PATH_DENIED: Device namespace paths are not allowed".to_string());
    }
    let path = Path::new(clean);
    for comp in path.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("PATH_DENIED: Parent directory traversal ('..') is not allowed".to_string());
        }
    }
    Ok(to_absolute_path(path))
}

fn check_leaf_not_symlink(path: &Path) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "PATH_DENIED: Symbolic links are not allowed in write path: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn check_no_symlink_below_root(abs_path: &Path, matched_root: &Path) -> Result<(), String> {
    let root_key = normalized_path_key(matched_root);
    let mut cur = Some(abs_path);
    while let Some(p) = cur {
        if normalized_path_key(p) == root_key {
            break;
        }
        check_leaf_not_symlink(p)?;
        if let Ok(canon) = std::fs::canonicalize(p) {
            if normalized_path_key(&canon) == root_key {
                break;
            }
        }
        cur = p.parent();
    }
    Ok(())
}

fn canonicalize_nearest_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        if cursor.exists() {
            let mut base = std::fs::canonicalize(cursor)
                .map_err(|e| format!("PATH_INVALID: Cannot resolve target directory '{}': {}", cursor.display(), e))?;
            for part in tail.into_iter().rev() {
                base.push(part);
            }
            return Ok(base);
        }
        match (cursor.file_name(), cursor.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                cursor = parent;
            }
            _ => {
                return Err(format!("PATH_INVALID: Target ancestor does not exist for '{}'", path.display()));
            }
        }
    }
}

fn authorized_root_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(normalize_for_auth(&resolve_app_data_dir()));
    if let Ok(cfg) = std::env::var("LINDEN_APP_CONFIG_DIR") {
        if !cfg.is_empty() {
            roots.push(normalize_for_auth(Path::new(&cfg)));
        }
    }
    if let Some(cfg) = CACHED_APP_CONFIG_DIR.get() {
        roots.push(normalize_for_auth(cfg));
    }
    if let Some(cache) = CACHED_APP_CACHE_DIR.get() {
        roots.push(normalize_for_auth(cache));
    }
    if let Some(slot) = AUTHORIZED_SYNC_DIR.get() {
        if let Some(sync_dir) = slot.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            roots.push(sync_dir.clone());
        }
    }
    if let Some(set) = AUTHORIZED_WRITE_DIRS.get() {
        for dir in set.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            roots.push(dir.clone());
        }
    }
    roots
}

pub(crate) fn authorize_write_path(raw: &str, allowed_exts: &[&str]) -> Result<PathBuf, String> {
    let abs_path = validate_safe_path_syntax(raw)?;
    let ext = abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if ext.is_empty() || !allowed_exts.contains(&ext.as_str()) {
        return Err(format!("PATH_DENIED: File extension '.{}' is not allowed for write IPC", ext));
    }
    check_leaf_not_symlink(&abs_path)?;
    let resolved = canonicalize_nearest_ancestor(&abs_path)?;
    let resolved_key = normalized_path_key(&resolved);

    if let Some(exact_set) = AUTHORIZED_SAVE_PATHS.get() {
        if exact_set.lock().unwrap_or_else(|e| e.into_inner()).contains(&resolved_key) {
            return Ok(resolved);
        }
    }

    for root in authorized_root_dirs() {
        let root_key = normalized_path_key(&root);
        if key_starts_with(&resolved_key, &root_key) {
            check_no_symlink_below_root(&abs_path, &root)?;
            return Ok(resolved);
        }
    }

    Err(format!(
        "PATH_DENIED: Target path '{}' is outside authorized app and user-selected directories",
        raw
    ))
}

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

// Cap each range response, independently of document and resource size.
const BOOK_RANGE_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn fs_read_buffer(
    file_path: String, offset: Option<u64>, length: Option<usize>,
) -> Result<Response, String> {
    let abs_path = validate_safe_path_syntax(&file_path)?;
    let path = abs_path.as_path();

    if !path.exists() || !path.is_file() {
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

    let bytes = match (offset, length) {
        (None, None) => fs::read(path)
            .await
            .map_err(|e| format!("Failed reading file '{}': {}", file_path, e))?,
        (Some(offset), Some(length)) if ext == "epub" && length <= BOOK_RANGE_BYTES => {
            let mut file = fs::File::open(path).await.map_err(|e| e.to_string())?;
            file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
            let mut bytes = vec![0; length];
            file.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
            bytes
        }
        _ => return Err("Invalid EPUB file range".into()),
    };
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn fs_stage_epub_snapshot(app: tauri::AppHandle, file_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("epub")) {
            return Err("EPUB staging requires an EPUB file".into());
        }
        let source = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let metadata = source.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() <= BOOK_RANGE_BYTES as u64 {
            return Ok(None);
        }
        let root = crate::commands::mupdf::native_snapshot_dir_public(&app)?;
        stage_book_snapshot(&root, source, "epub").map(Some)
    }).await.map_err(|e| e.to_string())?
}

// One streamed copy and digest. The published snapshot owns the saved book bytes.
pub(super) fn stage_book_snapshot(
    root: &Path, source: std::fs::File, extension: &str,
) -> Result<String, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create book cache: {e}"))?;
    static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let sequence = NEXT_STAGE.fetch_add(1, Ordering::Relaxed);
    let name = format!("snapshot-{}-{nanos}-{}.{extension}", std::process::id(), sequence);
    let final_path = root.join(name);
    let temp_path = final_path.with_extension("part");
    let mut input = source;
    let metadata = input.metadata().map_err(|e| e.to_string())?;
    let size = metadata.len();
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(&temp_path).map_err(|e| format!("Cannot stage book: {e}"))?;
    use std::io::{Read, Write};
    let mut hasher = crate::content_hash::ContentHasher::new();
    let mut buf = [0u8; 64 * 1024];
    let stage_start = std::time::Instant::now();
    let mut copy_hash_ms = 0u64;
    let mut flush_ms = 0u64;
    let result = (|| -> Result<(), String> {
        let t0 = std::time::Instant::now();
        let mut copied = 0;
        loop {
            let n = input.read(&mut buf).map_err(|e| format!("Cannot read book: {e}"))?;
            if n == 0 { break; }
            hasher.update(&buf[..n]);
            output.write_all(&buf[..n]).map_err(|e| format!("Cannot write book snapshot: {e}"))?;
            copied += n as u64;
        }
        let current = input.metadata().map_err(|e| e.to_string())?;
        if copied != size || current.len() != size || current.modified().ok() != metadata.modified().ok() {
            return Err("Book changed while saving its snapshot".into());
        }
        copy_hash_ms = t0.elapsed().as_millis() as u64;
        let t1 = std::time::Instant::now();
        output.flush().map_err(|e| format!("Cannot flush book: {e}"))?;
        output.sync_all().map_err(|e| format!("Cannot sync book: {e}"))?;
        flush_ms = t1.elapsed().as_millis() as u64;
        drop(output);
        std::fs::rename(&temp_path, &final_path).map_err(|e| format!("Cannot publish book snapshot: {e}"))
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp_path); }
    result?;
    let (doc_hash, legacy_hash) = hasher.finish(size);
    let revision = format!("rev_{nanos}_{sequence}");
    let total_stage_ms = stage_start.elapsed().as_millis() as u64;
    let payload = serde_json::json!({
        "path": final_path.to_string_lossy().into_owned(),
        "size": size,
        "revision": revision,
        "documentHash": doc_hash,
        "legacyDocumentHash": legacy_hash,
        "copyHashMs": copy_hash_ms,
        "flushMs": flush_ms,
        "stageTotalMs": total_stage_ms
    });
    Ok(payload.to_string())
}


#[tauri::command]
pub async fn fs_write_file(file_path: String, content: String) -> Result<(), String> {
    if content.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!(
            "PAYLOAD_TOO_LARGE: Write content ({} bytes) exceeds the 64MiB limit",
            content.len()
        ));
    }
    let resolved = authorize_write_path(&file_path, ALLOWED_TEXT_WRITE_EXTENSIONS)?;
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed creating parent directories: {e}"))?;
        }
    }
    fs::write(&resolved, content.as_bytes())
        .await
        .map_err(|e| format!("Failed writing file '{}': {}", resolved.display(), e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_write_binary_file(file_path: String, bytes_base64: String) -> Result<(), String> {
    use base64::Engine as _;

    // Strip optional data URL prefix (e.g. "data:image/png;base64,...")
    let b64_payload = bytes_base64
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(bytes_base64.as_str())
        .trim();

    // Quick upper-bound check before decoding to avoid allocating oversized buffers
    let estimated_bytes = (b64_payload.len() / 4) * 3;
    if estimated_bytes > MAX_BINARY_WRITE_BYTES {
        return Err(format!(
            "PAYLOAD_TOO_LARGE: Binary write payload (~{} bytes) exceeds the 32MiB limit",
            estimated_bytes
        ));
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64_payload)
        .map_err(|e| format!("INVALID_BASE64: Failed decoding binary payload: {e}"))?;

    if decoded.len() > MAX_BINARY_WRITE_BYTES {
        return Err(format!(
            "PAYLOAD_TOO_LARGE: Decoded binary payload ({} bytes) exceeds the 32MiB limit",
            decoded.len()
        ));
    }

    let resolved = authorize_write_path(&file_path, ALLOWED_BINARY_WRITE_EXTENSIONS)?;
    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed creating parent directories: {e}"))?;
        }
    }
    fs::write(&resolved, &decoded)
        .await
        .map_err(|e| format!("Failed writing binary file '{}': {}", resolved.display(), e))?;
    Ok(())
}

#[tauri::command]
pub async fn fs_compute_file_hash(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;

        let clean = file_path.trim().trim_matches('"').trim_matches('\'');
        let path = Path::new(clean);
        if !path.exists() || !path.is_file() {
            return Err(format!("File does not exist: {}", file_path));
        }
        let mut f = std::fs::File::open(path)
            .map_err(|e| format!("Failed opening file '{}': {}", file_path, e))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("Failed reading file '{}': {}", file_path, e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| format!("Compute file hash task failed: {e}"))?
}

#[tauri::command]
pub async fn fs_scan_folder(
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<FolderScanResponse, String> {
    tokio::task::spawn_blocking(move || scan_folder_sync(&folder_path, max_depth))
        .await
        .map_err(|e| format!("Scan folder task failed: {e}"))?
}

pub(crate) fn scan_folder_sync(
    folder_path: &str,
    max_depth: Option<usize>,
) -> Result<FolderScanResponse, String> {
    {
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
        let mut visited_dirs = std::collections::HashSet::new();
        if let Ok(canon_root) = std::fs::canonicalize(root) {
            visited_dirs.insert(canon_root);
        }

        fn scan_dir(
            dir: &Path,
            current_depth: usize,
            max_depth: usize,
            visited_dirs: &mut std::collections::HashSet<PathBuf>,
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
                // Skip symlinks and NTFS directory junctions to prevent traversal cycles.
                let file_type = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                let p = entry.path();
                if file_type.is_dir() {
                    let canon = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
                    if !visited_dirs.insert(canon) {
                        continue;
                    }
                    scan_dir(&p, current_depth + 1, max_depth, visited_dirs, results, errors, failed_dirs);
                } else if file_type.is_file() {
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

        scan_dir(root, 0, depth_limit, &mut visited_dirs, &mut results, &mut errors, &mut failed_dirs);
        Ok(FolderScanResponse {
            files: results,
            complete: errors.is_empty(),
            errors,
            failed_dirs,
        })
    }
}

static CACHED_APP_DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static CACHED_RESOURCE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_cached_app_dirs(app_data_dir: Option<PathBuf>, resource_dir: Option<PathBuf>) {
    if let Some(dir) = app_data_dir {
        let _ = CACHED_APP_DATA_DIR.set(dir);
    }
    if let Some(dir) = resource_dir {
        let _ = CACHED_RESOURCE_DIR.set(dir);
    }
}

pub fn resolve_resource_dir() -> Option<PathBuf> {
    CACHED_RESOURCE_DIR.get().cloned()
}

pub fn resolve_app_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LINDEN_APP_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    if let Some(dir) = CACHED_APP_DATA_DIR.get() {
        return dir.clone();
    }
    dirs::data_dir()
        .map(|d| d.join("com.lindenleaf.reader"))
        .unwrap_or_else(|| std::env::temp_dir().join("com.lindenleaf.reader"))
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
        .unwrap_or_else(|_| {
            let root = if cfg!(target_os = "android") && !data_dir.is_empty() {
                Path::new(&data_dir)
            } else {
                Path::new(&cache_dir)
            };
            root.join("pdf-native").to_string_lossy().to_string()
        });

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

pub(crate) fn normalize_windows_explorer_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"');
    let without_verbatim = trimmed
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{}", rest))
        .unwrap_or_else(|| trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed).to_string());
    without_verbatim.replace('/', "\\").replace('"', "")
}

#[tauri::command]
pub fn fs_open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let normalized = normalize_windows_explorer_path(&path);
        if normalized.is_empty() {
            return Err("Empty path".to_string());
        }
        let p = Path::new(&normalized);
        if p.is_file() {
            let _ = Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", normalized))
                .spawn();
        } else {
            let _ = Command::new("explorer")
                .raw_arg(format!("\"{}\"", normalized))
                .spawn();
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_windows_explorer_path() {
        assert_eq!(
            normalize_windows_explorer_path(r#" "C:/Users/Alice/My Books, Vol 1/book.pdf" "#),
            r"C:\Users\Alice\My Books, Vol 1\book.pdf"
        );
        assert_eq!(
            normalize_windows_explorer_path(r"\\?\D:\Library\sub/test.epub"),
            r"D:\Library\sub\test.epub"
        );
        assert_eq!(
            normalize_windows_explorer_path(r"\\?\UNC\server\share/book.pdf"),
            r"\\server\share\book.pdf"
        );
    }

    #[test]
    fn test_resolve_app_data_dir_never_returns_relative_dot() {
        let dir = resolve_app_data_dir();
        assert_ne!(dir, PathBuf::from("."));
        assert!(dir.is_absolute());
    }

    #[test]
    fn test_scan_folder_sync_handles_normal_files_and_skips_symlinks() {
        let base = std::env::temp_dir().join(format!("linden_test_scan_{}", std::process::id()));
        let sub = base.join("sub");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(base.join("a.epub"), b"epub").unwrap();
        std::fs::write(sub.join("b.pdf"), b"pdf").unwrap();

        #[cfg(target_os = "windows")]
        let _ = std::os::windows::fs::symlink_dir(&base, sub.join("loop_link"));
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&base, sub.join("loop_link"));

        let res = scan_folder_sync(base.to_str().unwrap(), Some(10)).unwrap();
        assert_eq!(res.files.len(), 2);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_authorize_write_path_enforces_roots_extensions_and_traversal() {
        let base = std::env::temp_dir().join(format!("linden_auth_test_{}", std::process::id()));
        let unauthorized = std::env::temp_dir().join(format!("linden_unauth_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&unauthorized);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&unauthorized).unwrap();

        register_authorized_write_dir(&base);

        // Authorized directory + safe extension succeeds
        let ok_target = base.join("backup.json");
        assert!(authorize_write_path(ok_target.to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_ok());

        // Disallowed executable extension is blocked even in authorized directory
        let exe_target = base.join("evil.exe");
        assert!(authorize_write_path(exe_target.to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());

        // Parent traversal is blocked
        let traversal = format!("{}/../escape.json", base.display());
        assert!(authorize_write_path(&traversal, ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());

        // Unauthorized directory is blocked
        let bad_target = unauthorized.join("notes.md");
        assert!(authorize_write_path(bad_target.to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());

        // Explicitly registered exact save path succeeds
        register_authorized_save_path(&bad_target);
        assert!(authorize_write_path(bad_target.to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_ok());

        // Device namespace and globalroot paths are blocked
        assert!(authorize_write_path(r"\\?\GLOBALROOT\Device\HarddiskVolume1\evil.json", ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());
        assert!(authorize_write_path(r"\\.\PhysicalDrive0\evil.json", ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());

        // Sibling prefix collision directory must remain blocked
        let sibling_prefix = std::env::temp_dir().join(format!("linden_auth_test_{}_evil", std::process::id()));
        std::fs::create_dir_all(&sibling_prefix).unwrap();
        let sibling_target = sibling_prefix.join("leak.json");
        assert!(authorize_write_path(sibling_target.to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());

        // Replacing active sync directory clears previously synced root
        let outside_sync_a = std::env::temp_dir().join(format!("linden_sync_a_{}", std::process::id()));
        let outside_sync_b = std::env::temp_dir().join(format!("linden_sync_b_{}", std::process::id()));
        std::fs::create_dir_all(&outside_sync_a).unwrap();
        std::fs::create_dir_all(&outside_sync_b).unwrap();
        set_authorized_sync_dir(Some(&outside_sync_a));
        assert!(authorize_write_path(outside_sync_a.join("linden_sync_data.json").to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_ok());
        set_authorized_sync_dir(Some(&outside_sync_b));
        assert!(authorize_write_path(outside_sync_a.join("linden_sync_data.json").to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_err());
        assert!(authorize_write_path(outside_sync_b.join("linden_sync_data.json").to_str().unwrap(), ALLOWED_TEXT_WRITE_EXTENSIONS).is_ok());
        set_authorized_sync_dir(None);

        #[cfg(target_os = "windows")]
        {
            // Windows casing mismatch against authorized root and exact save path must succeed
            let sub_mixed = base.join("SubFolder");
            std::fs::create_dir_all(&sub_mixed).unwrap();
            let upper_target = sub_mixed.to_string_lossy().to_uppercase() + "\\MixedCase.JSON";
            assert!(authorize_write_path(&upper_target, ALLOWED_TEXT_WRITE_EXTENSIONS).is_ok());
        }

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&unauthorized);
        let _ = std::fs::remove_dir_all(&sibling_prefix);
        let _ = std::fs::remove_dir_all(&outside_sync_a);
        let _ = std::fs::remove_dir_all(&outside_sync_b);
    }
}
