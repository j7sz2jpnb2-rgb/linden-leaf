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
        let ext_lower = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !crate::commands::fs::SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
            return Err(format!("Blocked staging unsupported file extension: {}", ext_lower));
        }

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
                // Same size: stream compare in 64KB chunks instead of loading two full books into RAM
                let is_identical = (|| -> std::io::Result<bool> {
                    use std::io::Read;
                    let mut fa = fs::File::open(&staging_path)?;
                    let mut fb = fs::File::open(&dest_path)?;
                    let mut buf_a = [0u8; 65536];
                    let mut buf_b = [0u8; 65536];
                    loop {
                        let na = fa.read(&mut buf_a)?;
                        let nb = fb.read(&mut buf_b)?;
                        if na != nb || buf_a[..na] != buf_b[..nb] {
                            return Ok(false);
                        }
                        if na == 0 {
                            return Ok(true);
                        }
                    }
                })().unwrap_or(false);
                if is_identical {
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
    #[serde(rename = "voiceId")]
    voice_id: &'a str,
    locale: &'a str,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct BackgroundTtsStartResult {
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub value: bool,
    #[serde(rename = "errorCode", default)]
    pub error_code: String,
    #[serde(default)]
    pub error: String,
    #[serde(rename = "engineCount", default)]
    pub engine_count: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TtsEngineInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TtsDiagnosticsResult {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub ready: bool,
    #[serde(rename = "serviceCount", default)]
    pub service_count: i32,
    #[serde(rename = "engineCount", default)]
    pub engine_count: i32,
    #[serde(rename = "defaultEngine", default)]
    pub default_engine: String,
    #[serde(rename = "activeEngine", default)]
    pub active_engine: String,
    #[serde(default)]
    pub engines: Vec<TtsEngineInfo>,
    #[serde(rename = "zhStatus", default)]
    pub zh_status: String,
    #[serde(rename = "enStatus", default)]
    pub en_status: String,
    #[serde(rename = "lastErrorCode", default)]
    pub last_error_code: String,
    #[serde(rename = "lastError", default)]
    pub last_error: String,
    #[serde(rename = "canOpenTtsSettings", default)]
    pub can_open_tts_settings: bool,
    #[serde(rename = "canInstallTtsData", default)]
    pub can_install_tts_data: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TtsActivityOpenResult {
    #[serde(default)]
    pub opened: bool,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub error: String,
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
    #[serde(rename = "errorCode", default)]
    pub error_code: String,
    #[serde(rename = "queueIndex", default)]
    pub queue_index: i32,
    #[serde(rename = "queueTotal", default)]
    pub queue_total: i32,
    #[serde(rename = "totalPlayingSeconds", default)]
    pub total_playing_seconds: i64,
    #[serde(rename = "sleepTimerDeadlineMs", default)]
    pub sleep_timer_deadline_ms: i64,
    #[serde(rename = "ttsStatus", default)]
    pub tts_status: String,
    #[serde(rename = "ttsReady", default)]
    pub tts_ready: bool,
    #[serde(rename = "engineCount", default)]
    pub engine_count: i32,
    #[serde(rename = "defaultEngine", default)]
    pub default_engine: String,
    #[serde(rename = "activeEngine", default)]
    pub active_engine: String,
    #[serde(rename = "canOpenTtsSettings", default)]
    pub can_open_tts_settings: bool,
    #[serde(rename = "canInstallTtsData", default)]
    pub can_install_tts_data: bool,
    #[serde(rename = "listeningIntervals", default)]
    pub listening_intervals: Vec<NativeListeningInterval>,
}

#[cfg(target_os = "android")]
fn get_mobile_bridge<'a>(app_handle: &'a tauri::AppHandle) -> Result<tauri::State<'a, crate::LindenMobileBridge>, String> {
    use tauri::Manager;
    app_handle
        .try_state::<crate::LindenMobileBridge>()
        .ok_or_else(|| "[BRIDGE_CALL_FAILED] LindenMobileBridge not initialized".to_string())
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
    voice_id: Option<String>,
    locale: Option<String>,
) -> Result<BackgroundTtsStartResult, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = get_mobile_bridge(&app_handle)?;
        let b_id = book_id.unwrap_or_default();
        let j_id = job_id.unwrap_or_default();
        let u_id = utterance_id.unwrap_or_default();
        let v_id = voice_id.unwrap_or_default();
        let loc = crate::commands::resolve_locale(locale.as_deref());
        let gen = generation.unwrap_or(0);

        let res = bridge
            .0
            .run_mobile_plugin::<BackgroundTtsStartResult>(
                "startBackgroundTts",
                BackgroundTtsStartReq {
                    book_title: &book_title,
                    book_id: &b_id,
                    text: &text,
                    rate,
                    job_id: &j_id,
                    utterance_id: &u_id,
                    generation: gen,
                    voice_id: &v_id,
                    locale: loc,
                },
            )
            .map_err(|e| format!("[BRIDGE_CALL_FAILED] startBackgroundTts failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, book_id, book_title, text, rate, job_id, utterance_id, generation, voice_id, locale);
        Ok(BackgroundTtsStartResult {
            started: false,
            value: false,
            error_code: "UNSUPPORTED_PLATFORM".to_string(),
            error: "Android background TTS is unavailable on this platform".to_string(),
            engine_count: 0,
        })
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
    #[serde(rename = "voiceId")]
    voice_id: &'a str,
    locale: &'a str,
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
    voice_id: Option<String>,
    locale: Option<String>,
) -> Result<BackgroundTtsStartResult, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = get_mobile_bridge(&app_handle)?;
        let b_id = book_id.unwrap_or_default();
        let j_id = job_id.unwrap_or_default();
        let v_id = voice_id.unwrap_or_default();
        let loc = crate::commands::resolve_locale(locale.as_deref());
        let gen = generation.unwrap_or(0);
        let s_idx = start_index.unwrap_or(0);

        let res = bridge
            .0
            .run_mobile_plugin::<BackgroundTtsStartResult>(
                "startBackgroundTtsQueue",
                BackgroundTtsQueueReq {
                    book_title: &book_title,
                    book_id: &b_id,
                    segments: &segments,
                    start_index: s_idx,
                    rate,
                    job_id: &j_id,
                    generation: gen,
                    voice_id: &v_id,
                    locale: loc,
                },
            )
            .map_err(|e| format!("[BRIDGE_CALL_FAILED] startBackgroundTtsQueue failed: {e}"))?;

        Ok(res)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, book_id, book_title, segments, start_index, rate, job_id, generation, voice_id, locale);
        Ok(BackgroundTtsStartResult {
            started: false,
            value: false,
            error_code: "UNSUPPORTED_PLATFORM".to_string(),
            error: "Android background TTS is unavailable on this platform".to_string(),
            engine_count: 0,
        })
    }
}

#[tauri::command]
pub fn android_get_tts_diagnostics(app_handle: tauri::AppHandle) -> Result<TtsDiagnosticsResult, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = get_mobile_bridge(&app_handle)?;
        #[derive(Serialize)]
        struct EmptyArgs {}
        bridge
            .0
            .run_mobile_plugin::<TtsDiagnosticsResult>("getTtsDiagnostics", EmptyArgs {})
            .map_err(|e| format!("[BRIDGE_CALL_FAILED] getTtsDiagnostics failed: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(TtsDiagnosticsResult {
            status: "unsupported".to_string(),
            ..Default::default()
        })
    }
}

#[tauri::command]
pub fn android_open_tts_settings(app_handle: tauri::AppHandle) -> Result<TtsActivityOpenResult, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = get_mobile_bridge(&app_handle)?;
        #[derive(Serialize)]
        struct EmptyArgs {}
        bridge
            .0
            .run_mobile_plugin::<TtsActivityOpenResult>("openTtsSettings", EmptyArgs {})
            .map_err(|e| format!("[BRIDGE_CALL_FAILED] openTtsSettings failed: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(TtsActivityOpenResult {
            opened: false,
            action: String::new(),
            error: "UNSUPPORTED_PLATFORM".to_string(),
        })
    }
}

#[tauri::command]
pub fn android_install_tts_voice_data(app_handle: tauri::AppHandle) -> Result<TtsActivityOpenResult, String> {
    #[cfg(target_os = "android")]
    {
        let bridge = get_mobile_bridge(&app_handle)?;
        #[derive(Serialize)]
        struct EmptyArgs {}
        bridge
            .0
            .run_mobile_plugin::<TtsActivityOpenResult>("installTtsVoiceData", EmptyArgs {})
            .map_err(|e| format!("[BRIDGE_CALL_FAILED] installTtsVoiceData failed: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app_handle;
        Ok(TtsActivityOpenResult {
            opened: false,
            action: String::new(),
            error: "UNSUPPORTED_PLATFORM".to_string(),
        })
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
    #[allow(unused)] locale: Option<String>,
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
        let en = crate::commands::is_en_locale(locale.as_deref());
        let _ = (app_handle, base64, filename, title);
        Ok(ImageOperationResult {
            success: false,
            path: None,
            error: Some(
                crate::commands::l10n(
                    en,
                    "当前桌面端环境不支持系统图片分享",
                    "Desktop environment: share dialog not supported",
                )
                .to_string(),
            ),
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

#[derive(Serialize, Deserialize)]
pub struct AndroidReaderFrame {
    mime: String,
    data: String,
}

#[tauri::command]
pub async fn android_capture_reader_page(
    app_handle: tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<AndroidReaderFrame, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        #[derive(Serialize)]
        struct CaptureRegion {
            x: i32,
            y: i32,
            width: i32,
            height: i32,
        }

        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "Android bridge not initialized".to_string())?;
        bridge.0.run_mobile_plugin::<AndroidReaderFrame>(
            "captureReaderPage", CaptureRegion { x, y, width, height },
        ).map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, x, y, width, height);
        Err("Reader capture is only available on Android".into())
    }
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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
#[allow(dead_code)]
struct ListeningAck { through_sequence: i64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
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
#[allow(dead_code)]
struct BookExportReq { file_path: String, filename: String, share: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TextExportReq {
    filename: String,
    content: String,
    mime_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AndroidTextExportResult {
    #[serde(default)]
    pub saved: bool,
    #[serde(default)]
    pub uri: Option<String>,
    #[serde(default)]
    pub cancelled: bool,
}

#[allow(dead_code)]
fn android_export_unsupported_format_msg(en: bool) -> &'static str {
    crate::commands::l10n(
        en,
        "仅允许导出受支持的电子书格式文件",
        "Only supported ebook file formats can be exported",
    )
}

fn android_export_unsupported_platform_msg(en: bool) -> &'static str {
    crate::commands::l10n(
        en,
        "当前平台暂不支持此导出方式",
        "This export method is not supported on the current platform",
    )
}

fn validate_tts_endpoint(endpoint: &str, locale: Option<&str>) -> Result<reqwest::Url, String> {
    let en = crate::commands::is_en_locale(locale);
    let url = reqwest::Url::parse(endpoint).map_err(|_| {
        crate::commands::l10n(en, "朗读接口地址无效", "Invalid TTS endpoint URL").to_string()
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(crate::commands::l10n(
            en,
            "朗读接口需要 HTTP 或 HTTPS 地址",
            "TTS endpoint must use HTTP or HTTPS",
        )
        .into());
    }
    if url.scheme() == "http" {
        let host = url.host_str().unwrap_or("");
        if host != "127.0.0.1" && host != "localhost" && host != "::1" && host != "[::1]" {
            return Err(crate::commands::l10n(
                en,
                "安全限制：明文 HTTP 朗读接口仅允许连接本地回环地址 (127.0.0.1 / localhost)，远程接口请使用 HTTPS",
                "Security restriction: plain HTTP TTS endpoints are limited to localhost/loopback (127.0.0.1 / localhost); use HTTPS for remote endpoints.",
            )
            .into());
        }
    }
    Ok(url)
}

#[tauri::command]
pub async fn android_export_book_file(
    app_handle: tauri::AppHandle,
    file_path: String,
    filename: String,
    share: bool,
    locale: Option<String>,
) -> Result<serde_json::Value, String> {
    let en = crate::commands::is_en_locale(locale.as_deref());
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let p = PathBuf::from(&file_path);
        let ext_lower = p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
        if !crate::commands::fs::SUPPORTED_EXTENSIONS.contains(&ext_lower.as_str()) {
            return Err(android_export_unsupported_format_msg(en).to_string());
        }
        let bridge = app_handle.try_state::<crate::LindenMobileBridge>()
            .ok_or("Android bridge is unavailable")?;
        bridge.0.run_mobile_plugin::<serde_json::Value>("exportBookFile", BookExportReq { file_path, filename, share })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, file_path, filename, share);
        Err(android_export_unsupported_platform_msg(en).into())
    }
}

#[tauri::command]
pub async fn android_export_text_file(
    app_handle: tauri::AppHandle,
    filename: String,
    content: String,
    mime_type: Option<String>,
) -> Result<AndroidTextExportResult, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let resolved_mime = mime_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("text/plain;charset=utf-8")
            .to_string();
        let bridge = app_handle
            .try_state::<crate::LindenMobileBridge>()
            .ok_or_else(|| "Android bridge is unavailable".to_string())?;
        bridge
            .0
            .run_mobile_plugin::<AndroidTextExportResult>(
                "exportTextFile",
                TextExportReq {
                    filename,
                    content,
                    mime_type: resolved_mime,
                },
            )
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, filename, content, mime_type);
        Err("Text file export via Android SAF is only available on Android".into())
    }
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
    request_id: String,
    endpoint: String,
    body: String,
    headers: std::collections::HashMap<String, String>,
    locale: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let en = crate::commands::is_en_locale(locale.as_deref());
    let url = validate_tts_endpoint(&endpoint, locale.as_deref())?;
    let (sender, mut cancelled) = tokio::sync::oneshot::channel();
    tts_cancellations()
        .lock()
        .map_err(|_| crate::commands::l10n(en, "语音请求状态暂不可用", "TTS request state is temporarily unavailable"))?
        .insert(request_id.clone(), sender);
    let result = tokio::select! {
        _ = &mut cancelled => Err(crate::commands::l10n(en, "朗读已停止", "Speech playback stopped").to_string()),
        value = async {
            static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
            let client = CLIENT.get_or_init(|| {
                reqwest::Client::builder()
                    .redirect(crate::commands::safe_https_redirect_policy(5, true))
                    .build()
                    .expect("Failed to build TTS HTTP client")
            });
            let mut request = client.post(url).timeout(std::time::Duration::from_secs(90)).body(body);
            for (key, value) in headers { request = request.header(key, value); }
            let mut response = request.send().await.map_err(|e| {
                if en {
                    format!("Failed to connect to TTS endpoint: {e}")
                } else {
                    format!("朗读接口连接失败：{e}")
                }
            })?;
            if !response.status().is_success() {
                let status = response.status();
                let detail = response.chunk().await.ok().flatten().unwrap_or_default();
                let detail: String = String::from_utf8_lossy(&detail).chars().take(200).collect();
                return Err(if en {
                    format!("TTS service returned {status}: {detail}")
                } else {
                    format!("语音服务返回 {status}：{detail}")
                });
            }
            let mut audio = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| {
                if en {
                    format!("Audio stream interrupted: {e}")
                } else {
                    format!("音频接收中断：{e}")
                }
            })? {
                if audio.len() + chunk.len() > 16 * 1024 * 1024 {
                    return Err(crate::commands::l10n(
                        en,
                        "单段语音过大，请减少朗读分段长度",
                        "Synthesized audio segment is too large; please shorten the segment",
                    ).into());
                }
                audio.extend_from_slice(&chunk);
            }
            if audio.is_empty() {
                return Err(crate::commands::l10n(en, "语音服务返回了空音频", "TTS service returned empty audio").into());
            }
            Ok(tauri::ipc::Response::new(audio))
        } => value
    };
    if let Ok(mut requests) = tts_cancellations().lock() { requests.remove(&request_id); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tts_and_android_export_locale_messages() {
        assert_eq!(android_export_unsupported_format_msg(false), "仅允许导出受支持的电子书格式文件");
        assert_eq!(android_export_unsupported_format_msg(true), "Only supported ebook file formats can be exported");
        assert_eq!(android_export_unsupported_platform_msg(false), "当前平台暂不支持此导出方式");
        assert_eq!(android_export_unsupported_platform_msg(true), "This export method is not supported on the current platform");

        assert!(validate_tts_endpoint("not a url", Some("en")).unwrap_err().contains("Invalid TTS endpoint"));
        assert!(validate_tts_endpoint("not a url", Some("zh-CN")).unwrap_err().contains("朗读接口地址无效"));
        assert!(validate_tts_endpoint("not a url", None).unwrap_err().contains("朗读接口地址无效"));
        assert!(validate_tts_endpoint("ftp://example.com/tts", Some("en")).unwrap_err().contains("HTTP or HTTPS"));
        assert!(validate_tts_endpoint("http://example.com/tts", Some("en")).unwrap_err().contains("Security restriction"));
        assert!(validate_tts_endpoint("http://example.com/tts", Some("fr")).unwrap_err().contains("安全限制"));
        assert!(validate_tts_endpoint("http://127.0.0.1:8080/tts", Some("en")).is_ok());
        assert!(validate_tts_endpoint("https://tts.example.com/v1/audio/speech", Some("en")).is_ok());

        let parsed_start: BackgroundTtsStartResult = serde_json::from_str(
            r#"{"started":false,"value":false,"errorCode":"NO_TTS_ENGINE","error":"missing","engineCount":0}"#
        ).unwrap();
        assert!(!parsed_start.started);
        assert_eq!(parsed_start.error_code, "NO_TTS_ENGINE");

        let parsed_state: BackgroundPlaybackState = serde_json::from_str(
            r#"{"state":"error","errorCode":"MISSING_LANGUAGE_DATA","error":"no zh","ttsStatus":"ready","ttsReady":true,"engineCount":1,"canOpenTtsSettings":true,"canInstallTtsData":true}"#
        ).unwrap();
        assert_eq!(parsed_state.error_code, "MISSING_LANGUAGE_DATA");
        assert!(parsed_state.tts_ready);
        assert!(parsed_state.can_open_tts_settings);
        assert!(parsed_state.can_install_tts_data);

        let parsed_diag: TtsDiagnosticsResult = serde_json::from_str(
            r#"{"status":"ready","ready":true,"serviceCount":1,"engineCount":1,"defaultEngine":"com.google.android.tts","zhStatus":"available","enStatus":"missing_data"}"#
        ).unwrap();
        assert_eq!(parsed_diag.zh_status, "available");
        assert_eq!(parsed_diag.en_status, "missing_data");

        let parsed_export: AndroidTextExportResult = serde_json::from_str(
            r#"{"saved":true,"uri":"content://com.android.externalstorage.documents/document/notes.md","cancelled":false}"#
        ).unwrap();
        assert!(parsed_export.saved);
        assert!(!parsed_export.cancelled);
        assert_eq!(
            parsed_export.uri.as_deref(),
            Some("content://com.android.externalstorage.documents/document/notes.md")
        );
    }
}
