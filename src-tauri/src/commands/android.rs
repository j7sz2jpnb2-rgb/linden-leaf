use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AndroidContentResolveResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct UriReq<'a> {
    uri: &'a str,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct KeystoreStoreReq<'a> {
    key: &'a str,
    secret: &'a str,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct KeyReq<'a> {
    key: &'a str,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct BoolVal {
    value: bool,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct StringVal {
    value: Option<String>,
}

#[tauri::command]
pub async fn android_resolve_content_uri(
    app_handle: tauri::AppHandle,
    content_uri: String,
) -> Result<AndroidContentResolveResult, String> {
    use tauri::Manager;

    // If it's a file:// URL or local path on desktop/Android sandbox:
    let clean_path = if let Some(stripped) = content_uri.strip_prefix("file://") {
        stripped.to_string()
    } else {
        content_uri.clone()
    };

    let p = PathBuf::from(&clean_path);
    if p.exists() && p.is_file() {
        let filename = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("book")
            .to_string();

        // Stream into private files snapshot directory to avoid holding full binary in RAM
        let books_dir = app_handle
            .path()
            .app_data_dir()
            .map(|d| d.join("books"))
            .unwrap_or_else(|_| PathBuf::from("books"));

        fs::create_dir_all(&books_dir).map_err(|e| format!("Failed to create books directory: {e}"))?;
        let staging_dir = app_handle
            .path()
            .app_data_dir()
            .map(|d| d.join("staging"))
            .unwrap_or_else(|_| PathBuf::from("staging"));
        fs::create_dir_all(&staging_dir).map_err(|e| format!("Failed to create staging directory: {e}"))?;

        let unique_staging_name = format!(
            "staging_{}_{}.tmp",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
            std::process::id()
        );
        let staging_path = staging_dir.join(&unique_staging_name);

        fs::copy(&p, &staging_path).map_err(|e| format!("Failed to stage file: {e}"))?;

        let mut dest_path = books_dir.join(&filename);
        if dest_path.exists() {
            let src_len = fs::metadata(&staging_path).map(|m| m.len()).unwrap_or(0);
            let dest_len = fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
            if src_len != dest_len {
                // Different content with same filename: generate unique versioned name
                let stem = std::path::Path::new(&filename).file_stem().and_then(|s| s.to_str()).unwrap_or("book");
                let ext = std::path::Path::new(&filename).extension().and_then(|e| e.to_str()).map(|e| format!(".{}", e)).unwrap_or_default();
                let short_hash = format!("{:x}", src_len);
                let unique_name = format!("{}_{}{}", stem, short_hash, ext);
                dest_path = books_dir.join(unique_name);
            } else {
                // Same size: check if identical
                let src_bytes = fs::read(&staging_path).unwrap_or_default();
                let dest_bytes = fs::read(&dest_path).unwrap_or_default();
                if src_bytes == dest_bytes {
                    let _ = fs::remove_file(&staging_path);
                    let snapshot_str = dest_path.to_string_lossy().to_string();
                    return Ok(AndroidContentResolveResult {
                        success: true,
                        snapshot_path: Some(snapshot_str.clone()),
                        cache_path: Some(snapshot_str),
                        buffer: None,
                        filename: Some(filename),
                        error: None,
                    });
                } else {
                    let stem = std::path::Path::new(&filename).file_stem().and_then(|s| s.to_str()).unwrap_or("book");
                    let ext = std::path::Path::new(&filename).extension().and_then(|e| e.to_str()).map(|e| format!(".{}", e)).unwrap_or_default();
                    let unique_name = format!("{}_{}{}", stem, std::process::id(), ext);
                    dest_path = books_dir.join(unique_name);
                }
            }
        }

        if let Err(_e) = fs::rename(&staging_path, &dest_path) {
            fs::copy(&staging_path, &dest_path).map_err(|e| format!("Failed to activate book snapshot: {e}"))?;
            let _ = fs::remove_file(&staging_path);
        }

        let snapshot_str = dest_path.to_string_lossy().to_string();
        return Ok(AndroidContentResolveResult {
            success: true,
            snapshot_path: Some(snapshot_str.clone()),
            cache_path: Some(snapshot_str),
            buffer: None,
            filename: Some(filename),
            error: None,
        });
    }

    #[cfg(target_os = "android")]
    {
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<AndroidContentResolveResult>(
                "resolveContentUri",
                UriReq { uri: &content_uri },
            )
            .map_err(|e| format!("resolveContentUri failed: {e}"))?;

        Ok(res)
    }

    #[cfg(not(target_os = "android"))]
    {
        Ok(AndroidContentResolveResult {
            success: false,
            snapshot_path: None,
            cache_path: None,
            buffer: None,
            filename: None,
            error: Some(format!(
                "Path or content URI does not exist on local filesystem: {}",
                content_uri
            )),
        })
    }
}

#[tauri::command]
pub async fn android_take_persistable_uri_permission(
    app_handle: tauri::AppHandle,
    content_uri: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>(
                "takePersistableUriPermission",
                UriReq { uri: &content_uri },
            )
            .map(|r| r.value)
            .map_err(|e| format!("takePersistableUriPermission failed: {e}"))?;

        Ok(res)
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, content_uri);
        Ok(true)
    }
}

#[tauri::command]
pub fn android_keystore_store(
    app_handle: tauri::AppHandle,
    key: String,
    secret: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>(
                "keystoreStore",
                KeystoreStoreReq {
                    key: &key,
                    secret: &secret,
                },
            )
            .map(|r| r.value)
            .map_err(|e| format!("keystoreStore failed: {e}"))?;

        Ok(res)
    }

    #[cfg(not(target_os = "android"))]
    {
        crate::commands::sync::secure_store_credential(app_handle, key, secret)
    }
}

#[tauri::command]
pub fn android_keystore_load(
    app_handle: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<StringVal>("keystoreLoad", KeyReq { key: &key })
            .map(|r| r.value)
            .map_err(|e| format!("keystoreLoad failed: {e}"))?;

        Ok(res)
    }

    #[cfg(not(target_os = "android"))]
    {
        crate::commands::sync::secure_load_credential(app_handle, key)
    }
}

#[tauri::command]
pub fn android_keystore_delete(
    app_handle: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("keystoreDelete", KeyReq { key: &key })
            .map(|r| r.value)
            .map_err(|e| format!("keystoreDelete failed: {e}"))?;

        Ok(res)
    }

    #[cfg(not(target_os = "android"))]
    {
        crate::commands::sync::secure_delete_credential(app_handle, key)
    }
}

#[allow(dead_code)]
#[derive(Serialize)]
struct BackgroundTtsStartReq<'a> {
    #[serde(rename = "bookTitle")]
    book_title: &'a str,
    #[serde(rename = "bookId")]
    book_id: &'a str,
    text: &'a str,
    rate: f32,
    #[serde(rename = "jobId")]
    job_id: &'a str,
    #[serde(rename = "utteranceId")]
    utterance_id: &'a str,
    generation: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct BackgroundPlaybackState {
    #[serde(rename = "isPlaying", default)]
    pub is_playing: bool,
    #[serde(default)]
    pub state: String,
    #[serde(rename = "bookTitle", default)]
    pub book_title: String,
    #[serde(default)]
    pub text: String,
    #[serde(rename = "jobId", default)]
    pub job_id: String,
    #[serde(rename = "utteranceId", default)]
    pub utterance_id: String,
    #[serde(default)]
    pub generation: i64,
    #[serde(rename = "completedUtteranceId", default)]
    pub completed_utterance_id: String,
    #[serde(rename = "completedGeneration", default)]
    pub completed_generation: i64,
    #[serde(default)]
    pub rate: f64,
    #[serde(rename = "eventSeq", default)]
    pub event_seq: i64,
    #[serde(default)]
    pub error: String,
    #[serde(rename = "queueIndex", default)]
    pub queue_index: i32,
    #[serde(rename = "queueTotal", default)]
    pub queue_total: i32,
    #[serde(rename = "totalPlayingSeconds", default)]
    pub total_playing_seconds: i64,
    #[serde(rename = "listeningIntervals", default)]
    pub listening_intervals: Vec<NativeListeningInterval>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingImportItem {
    pub id: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub filename: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingImportsResult {
    pub items: Vec<PendingImportItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageOperationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct ConsumeImportReq<'a> {
    #[serde(rename = "importId")]
    import_id: &'a str,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct SaveImageReq<'a> {
    base64: &'a str,
    filename: &'a str,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct ShareImageReq<'a> {
    base64: &'a str,
    filename: &'a str,
    title: &'a str,
}

#[tauri::command]
pub fn android_start_background_tts(
    app_handle: tauri::AppHandle,
    book_title: String,
    text: String,
    rate: f32,
    book_id: Option<String>,
    job_id: Option<String>,
    utterance_id: Option<String>,
    generation: Option<i64>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let b_id = book_id.unwrap_or_default();
        let j_id = job_id.unwrap_or_default();
        let u_id = utterance_id.unwrap_or_default();
        let gen = generation.unwrap_or(0);

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>(
                "startBackgroundTts",
                BackgroundTtsStartReq {
                    book_title: &book_title,
                    book_id: &b_id,
                    text: &text,
                    rate,
                    job_id: &j_id,
                    utterance_id: &u_id,
                    generation: gen,
                },
            )
            .map(|r| r.value)
            .map_err(|e| format!("startBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, book_id, book_title, text, rate, job_id, utterance_id, generation);
        Ok(false)
    }
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TtsQueueSegment {
    #[serde(rename = "utteranceId")]
    pub utterance_id: String,
    pub text: String,
}

#[allow(dead_code)]
#[derive(Serialize)]
struct BackgroundTtsQueueReq<'a> {
    #[serde(rename = "bookTitle")]
    book_title: &'a str,
    #[serde(rename = "bookId")]
    book_id: &'a str,
    segments: &'a [TtsQueueSegment],
    #[serde(rename = "startIndex")]
    start_index: i32,
    rate: f32,
    #[serde(rename = "jobId")]
    job_id: &'a str,
    generation: i64,
}

#[tauri::command]
pub fn android_start_background_tts_queue(
    app_handle: tauri::AppHandle,
    book_title: String,
    segments: Vec<TtsQueueSegment>,
    start_index: Option<i32>,
    rate: f32,
    book_id: Option<String>,
    job_id: Option<String>,
    generation: Option<i64>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let b_id = book_id.unwrap_or_default();
        let j_id = job_id.unwrap_or_default();
        let gen = generation.unwrap_or(0);
        let s_idx = start_index.unwrap_or(0);

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>(
                "startBackgroundTtsQueue",
                BackgroundTtsQueueReq {
                    book_title: &book_title,
                    book_id: &b_id,
                    segments: &segments,
                    start_index: s_idx,
                    rate,
                    job_id: &j_id,
                    generation: gen,
                },
            )
            .map(|r| r.value)
            .map_err(|e| format!("startBackgroundTtsQueue failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, book_id, book_title, segments, start_index, rate, job_id, generation);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_pause_background_tts(app_handle: tauri::AppHandle, job_id: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("pauseBackgroundTts", JobControlReq { job_id: job_id.unwrap_or_default() })
            .map(|r| r.value)
            .map_err(|e| format!("pauseBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, job_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_resume_background_tts(app_handle: tauri::AppHandle, job_id: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("resumeBackgroundTts", JobControlReq { job_id: job_id.unwrap_or_default() })
            .map(|r| r.value)
            .map_err(|e| format!("resumeBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, job_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_stop_background_tts(app_handle: tauri::AppHandle, job_id: Option<String>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("stopBackgroundTts", JobControlReq { job_id: job_id.unwrap_or_default() })
            .map(|r| r.value)
            .map_err(|e| format!("stopBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, job_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_next_background_tts(app_handle: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        #[derive(Serialize)]
        struct EmptyArgs {}

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("nextBackgroundTts", EmptyArgs {})
            .map(|r| r.value)
            .map_err(|e| format!("nextBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(false)
    }
}

#[tauri::command]
pub fn android_prev_background_tts(app_handle: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        #[derive(Serialize)]
        struct EmptyArgs {}

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("prevBackgroundTts", EmptyArgs {})
            .map(|r| r.value)
            .map_err(|e| format!("prevBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(false)
    }
}

#[tauri::command]
pub fn android_get_playback_state(app_handle: tauri::AppHandle) -> Result<BackgroundPlaybackState, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        #[derive(Serialize)]
        struct EmptyArgs {}

        let res = bridge
            .0
            .run_mobile_plugin::<BackgroundPlaybackState>("getPlaybackState", EmptyArgs {})
            .map_err(|e| format!("getPlaybackState failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(BackgroundPlaybackState::default())
    }
}

#[tauri::command]
pub fn android_get_pending_imports(app_handle: tauri::AppHandle) -> Result<Vec<PendingImportItem>, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        #[derive(Serialize)]
        struct EmptyArgs {}

        let res = bridge
            .0
            .run_mobile_plugin::<PendingImportsResult>("getPendingImports", EmptyArgs {})
            .map(|r| r.items)
            .map_err(|e| format!("getPendingImports failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn android_consume_pending_import(app_handle: tauri::AppHandle, import_id: String) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("consumePendingImport", ConsumeImportReq { import_id: &import_id })
            .map(|r| r.value)
            .map_err(|e| format!("consumePendingImport failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, import_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_save_image_to_gallery(
    app_handle: tauri::AppHandle,
    base64: String,
    filename: String,
) -> Result<ImageOperationResult, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<ImageOperationResult>(
                "saveImageToGallery",
                SaveImageReq {
                    base64: &base64,
                    filename: &filename,
                },
            )
            .map_err(|e| format!("saveImageToGallery failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, base64, filename);
        Ok(ImageOperationResult {
            success: false,
            path: None,
            error: Some("Desktop environment: use standard browser file download".to_string()),
        })
    }
}

#[tauri::command]
pub fn android_share_image(
    app_handle: tauri::AppHandle,
    base64: String,
    filename: String,
    title: String,
) -> Result<ImageOperationResult, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<ImageOperationResult>(
                "shareImage",
                ShareImageReq {
                    base64: &base64,
                    filename: &filename,
                    title: &title,
                },
            )
            .map_err(|e| format!("shareImage failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, base64, filename, title);
        Ok(ImageOperationResult {
            success: false,
            path: None,
            error: Some("Desktop environment: share dialog not supported".to_string()),
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SystemInsets {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
    pub ime: f64,
    #[serde(rename = "keyboardOpen", default)]
    pub keyboard_open: bool,
}

#[tauri::command]
pub fn android_get_system_insets(app_handle: tauri::AppHandle) -> Result<SystemInsets, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        #[derive(Serialize)]
        struct EmptyArgs {}

        let res = bridge
            .0
            .run_mobile_plugin::<SystemInsets>("getSystemInsets", EmptyArgs {})
            .map_err(|e| format!("getSystemInsets failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(SystemInsets::default())
    }
}

#[derive(Serialize)]
struct SetSleepTimerReq {
    minutes: i32,
}

#[tauri::command]
pub fn android_set_tts_sleep_timer(app_handle: tauri::AppHandle, minutes: i32) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("setTtsSleepTimer", SetSleepTimerReq { minutes })
            .map(|r| r.value)
            .map_err(|e| format!("setTtsSleepTimer failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, minutes);
        Ok(false)
    }
}

#[derive(Serialize)]
struct SetRateReq {
    rate: f32,
}

#[tauri::command]
pub fn android_set_tts_rate(app_handle: tauri::AppHandle, rate: f32) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>("setTtsRate", SetRateReq { rate })
            .map(|r| r.value)
            .map_err(|e| format!("setTtsRate failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, rate);
        Ok(false)
    }
}


#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeListeningInterval {
    pub sequence: i64,
    pub book_id: String,
    pub book_title: String,
    pub job_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListeningAck { through_sequence: i64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobControlReq { job_id: String }

#[tauri::command]
pub fn android_acknowledge_tts_listening(app_handle: tauri::AppHandle, through_sequence: i64) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle.try_state::<crate::LindenMobileBridge>()
            .ok_or("Android bridge is unavailable")?;
        bridge.0.run_mobile_plugin::<BoolVal>("acknowledgeTtsListening", ListeningAck { through_sequence })
            .map(|r| r.value).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app_handle, through_sequence); Ok(false) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookExportReq { file_path: String, filename: String, share: bool }

#[tauri::command]
pub async fn android_export_book_file(app_handle: tauri::AppHandle, file_path: String, filename: String, share: bool) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let bridge = app_handle.try_state::<crate::LindenMobileBridge>()
            .ok_or("Android bridge is unavailable")?;
        bridge.0.run_mobile_plugin::<serde_json::Value>("exportBookFile", BookExportReq { file_path, filename, share })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app_handle, file_path, filename, share); Err("当前平台暂不支持此导出方式".into()) }
}

type TtsCancellations = std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>;
fn tts_cancellations() -> &'static TtsCancellations {
    static REQUESTS: std::sync::OnceLock<TtsCancellations> = std::sync::OnceLock::new();
    REQUESTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub fn tts_cancel_audio(request_id: String) -> bool {
    tts_cancellations().lock().ok()
        .and_then(|mut requests| requests.remove(&request_id))
        .map(|sender| sender.send(()).is_ok()).unwrap_or(false)
}

#[tauri::command]
pub async fn tts_request_audio(
    request_id: String, endpoint: String, body: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<tauri::ipc::Response, String> {
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "朗读接口地址无效")?;
    if !matches!(url.scheme(), "http" | "https") { return Err("朗读接口需要 HTTP 或 HTTPS 地址".into()); }
    let (sender, mut cancelled) = tokio::sync::oneshot::channel();
    tts_cancellations().lock().map_err(|_| "语音请求状态暂不可用")?.insert(request_id.clone(), sender);
    let result = tokio::select! {
        _ = &mut cancelled => Err("朗读已停止".to_string()),
        value = async {
            static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
            let client = CLIENT.get_or_init(reqwest::Client::new);
            let mut request = client.post(url).timeout(std::time::Duration::from_secs(90)).body(body);
            for (key, value) in headers { request = request.header(key, value); }
            let mut response = request.send().await.map_err(|e| format!("朗读接口连接失败：{e}"))?;
            if !response.status().is_success() {
                let status = response.status();
                let detail = response.chunk().await.ok().flatten().unwrap_or_default();
                let detail: String = String::from_utf8_lossy(&detail).chars().take(200).collect();
                return Err(format!("语音服务返回 {status}：{detail}"));
            }
            let mut audio = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| format!("音频接收中断：{e}"))? {
                if audio.len() + chunk.len() > 16 * 1024 * 1024 { return Err("单段语音过大，请减少朗读分段长度".into()); }
                audio.extend_from_slice(&chunk);
            }
            if audio.is_empty() { return Err("语音服务返回了空音频".into()); }
            Ok(tauri::ipc::Response::new(audio))
        } => value
    };
    if let Ok(mut requests) = tts_cancellations().lock() { requests.remove(&request_id); }
    result
}
