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

        let j_id = job_id.unwrap_or_default();
        let u_id = utterance_id.unwrap_or_default();
        let gen = generation.unwrap_or(0);

        let res = bridge
            .0
            .run_mobile_plugin::<BoolVal>(
                "startBackgroundTts",
                BackgroundTtsStartReq {
                    book_title: &book_title,
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
        let _ = (app_handle, book_title, text, rate, job_id, utterance_id, generation);
        Ok(false)
    }
}

#[tauri::command]
pub fn android_pause_background_tts(app_handle: tauri::AppHandle) -> Result<bool, String> {
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
            .run_mobile_plugin::<BoolVal>("pauseBackgroundTts", EmptyArgs {})
            .map(|r| r.value)
            .map_err(|e| format!("pauseBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(false)
    }
}

#[tauri::command]
pub fn android_resume_background_tts(app_handle: tauri::AppHandle) -> Result<bool, String> {
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
            .run_mobile_plugin::<BoolVal>("resumeBackgroundTts", EmptyArgs {})
            .map(|r| r.value)
            .map_err(|e| format!("resumeBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(false)
    }
}

#[tauri::command]
pub fn android_stop_background_tts(app_handle: tauri::AppHandle) -> Result<bool, String> {
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
            .run_mobile_plugin::<BoolVal>("stopBackgroundTts", EmptyArgs {})
            .map(|r| r.value)
            .map_err(|e| format!("stopBackgroundTts failed: {e}"))?;

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



