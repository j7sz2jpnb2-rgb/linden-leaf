use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::commands::{is_en_locale, l10n, safe_https_redirect_policy};

const MAX_OCR_ASSET_BYTES: u64 = 100 * 1024 * 1024;
const RUNTIME_WASM_FILENAME: &str = "ort-wasm-simd-threaded.jsep.wasm";

static OCR_IS_DOWNLOADING: AtomicBool = AtomicBool::new(false);
static OCR_DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static OCR_ACTIVE_IS_EN: AtomicBool = AtomicBool::new(false);
static OCR_DOWNLOAD_PROGRESS: OnceLock<RwLock<OcrModelDownloadProgress>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OcrModelId {
    Runtime,
    PpOcrV6Small,
    PpOcrV6Tiny,
}

impl OcrModelId {
    pub(crate) fn from_str(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "runtime" => Ok(Self::Runtime),
            "ppocrv6-small" => Ok(Self::PpOcrV6Small),
            "ppocrv6-tiny" => Ok(Self::PpOcrV6Tiny),
            other => Err(format!("Unsupported OCR model id: '{}'", other)),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::PpOcrV6Small => "ppocrv6-small",
            Self::PpOcrV6Tiny => "ppocrv6-tiny",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct AssetSpec {
    filename: &'static str,
    min_bytes: u64,
    primary_urls: &'static [&'static str],
    mirror_urls: &'static [&'static str],
}

const RUNTIME_ASSETS: &[AssetSpec] = &[AssetSpec {
    filename: RUNTIME_WASM_FILENAME,
    min_bytes: 1024,
    primary_urls: &[
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.jsep.wasm",
        "https://unpkg.com/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.jsep.wasm",
    ],
    mirror_urls: &[
        "https://fastly.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.jsep.wasm",
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.jsep.wasm",
    ],
}];

const PPOCRV6_SMALL_ASSETS: &[AssetSpec] = &[
    AssetSpec {
        filename: "det.onnx",
        min_bytes: 1024,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
        ],
    },
    AssetSpec {
        filename: "rec.onnx",
        min_bytes: 1024,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
        ],
    },
    AssetSpec {
        filename: "rec.yml",
        min_bytes: 100,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.yml",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.yml",
        ],
    },
];

const PPOCRV6_TINY_ASSETS: &[AssetSpec] = &[
    AssetSpec {
        filename: "det.onnx",
        min_bytes: 1024,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/main/inference.onnx",
        ],
    },
    AssetSpec {
        filename: "rec.onnx",
        min_bytes: 1024,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.onnx",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.onnx",
        ],
    },
    AssetSpec {
        filename: "rec.yml",
        min_bytes: 100,
        primary_urls: &[
            "https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.yml",
        ],
        mirror_urls: &[
            "https://hf-mirror.com/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/main/inference.yml",
        ],
    },
];

fn assets_for_model(id: OcrModelId) -> &'static [AssetSpec] {
    match id {
        OcrModelId::Runtime => RUNTIME_ASSETS,
        OcrModelId::PpOcrV6Small => PPOCRV6_SMALL_ASSETS,
        OcrModelId::PpOcrV6Tiny => PPOCRV6_TINY_ASSETS,
    }
}

fn find_asset_spec(model: OcrModelId, asset_name: &str) -> Result<&'static AssetSpec, String> {
    let trimmed = asset_name.trim();
    assets_for_model(model)
        .iter()
        .find(|spec| spec.filename == trimmed)
        .ok_or_else(|| format!("Unsupported OCR asset '{}' for model '{}'", trimmed, model.as_str()))
}

fn resolve_asset_path_in_root(root: &Path, model: OcrModelId, asset_name: &str) -> Result<(PathBuf, &'static AssetSpec), String> {
    let spec = find_asset_spec(model, asset_name)?;
    let path = root.join(model.as_str()).join(spec.filename);
    Ok((path, spec))
}

fn get_ocr_models_root_dir() -> PathBuf {
    let dir = crate::commands::fs::resolve_app_data_dir().join("ocr_models");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelItemStatus {
    pub id: String,
    pub installed: bool,
    pub ready: bool,
    pub size_bytes: u64,
    pub missing_assets: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelsStatusResponse {
    pub storage_dir: String,
    pub runtime_installed: bool,
    pub runtime_size_bytes: u64,
    pub models: Vec<OcrModelItemStatus>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelDownloadProgress {
    pub phase: String,
    pub model_id: String,
    pub current_file: String,
    pub file_index: usize,
    pub total_files: usize,
    pub loaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u32,
    pub message: String,
    pub error: Option<String>,
}

fn default_progress() -> OcrModelDownloadProgress {
    let en = OCR_ACTIVE_IS_EN.load(Ordering::SeqCst);
    OcrModelDownloadProgress {
        phase: "idle".to_string(),
        model_id: String::new(),
        current_file: String::new(),
        file_index: 0,
        total_files: 0,
        loaded_bytes: 0,
        total_bytes: 0,
        percent: 0,
        message: l10n(en, "就绪", "Ready").to_string(),
        error: None,
    }
}

fn get_progress_lock() -> &'static RwLock<OcrModelDownloadProgress> {
    OCR_DOWNLOAD_PROGRESS.get_or_init(|| RwLock::new(default_progress()))
}

fn update_progress<F>(app_handle: Option<&tauri::AppHandle>, updater: F)
where
    F: FnOnce(&mut OcrModelDownloadProgress),
{
    let snapshot = if let Ok(mut guard) = get_progress_lock().write() {
        updater(&mut guard);
        Some(guard.clone())
    } else {
        None
    };
    if let (Some(app), Some(payload)) = (app_handle, snapshot) {
        let _ = app.emit("ocr-model-download-progress", payload);
    }
}

struct OcrDownloadGuard;
impl OcrDownloadGuard {
    fn acquire(en: bool) -> Result<Self, String> {
        if OCR_IS_DOWNLOADING.swap(true, Ordering::SeqCst) {
            return Err(l10n(
                en,
                "已有 OCR 模型下载任务正在进行中",
                "An OCR model download task is already in progress",
            )
            .to_string());
        }
        Ok(Self)
    }
}
impl Drop for OcrDownloadGuard {
    fn drop(&mut self) {
        OCR_IS_DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

fn is_valid_installed_file(path: &Path, min_bytes: u64) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    if len >= min_bytes { Some(len) } else { None }
}

pub(crate) fn status_from_root(root: &Path) -> OcrModelsStatusResponse {
    let (runtime_path, runtime_spec) =
        resolve_asset_path_in_root(root, OcrModelId::Runtime, RUNTIME_WASM_FILENAME)
            .expect("static runtime asset must exist in allowlist");
    let runtime_size_bytes = is_valid_installed_file(&runtime_path, runtime_spec.min_bytes).unwrap_or(0);
    let runtime_installed = runtime_size_bytes > 0;

    let mut models = Vec::with_capacity(2);
    for model_id in [OcrModelId::PpOcrV6Small, OcrModelId::PpOcrV6Tiny] {
        let mut total_size = 0u64;
        let mut missing = Vec::new();
        for spec in assets_for_model(model_id) {
            let p = root.join(model_id.as_str()).join(spec.filename);
            if let Some(sz) = is_valid_installed_file(&p, spec.min_bytes) {
                total_size += sz;
            } else {
                missing.push(spec.filename.to_string());
            }
        }
        let installed = missing.is_empty();
        models.push(OcrModelItemStatus {
            id: model_id.as_str().to_string(),
            installed,
            ready: installed && runtime_installed,
            size_bytes: total_size,
            missing_assets: missing,
        });
    }

    OcrModelsStatusResponse {
        storage_dir: root.to_string_lossy().to_string(),
        runtime_installed,
        runtime_size_bytes,
        models,
    }
}

fn write_asset_atomic_in_root(
    root: &Path,
    model_id: &str,
    asset_name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if (bytes.len() as u64) > MAX_OCR_ASSET_BYTES {
        return Err(format!(
            "OCR asset payload exceeds {} byte limit",
            MAX_OCR_ASSET_BYTES
        ));
    }
    let model = OcrModelId::from_str(model_id)?;
    let (dest_path, spec) = resolve_asset_path_in_root(root, model, asset_name)?;
    if (bytes.len() as u64) < spec.min_bytes {
        return Err(format!(
            "OCR asset '{}' is too small ({} bytes < minimum {} bytes)",
            spec.filename,
            bytes.len(),
            spec.min_bytes
        ));
    }
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to prepare OCR model dir: {e}"))?;
    }
    let tmp_path = dest_path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temporary OCR asset file: {e}"))?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                format!("Failed to write OCR asset: {e}")
            })?;
    }
    fs::rename(&tmp_path, &dest_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to activate OCR asset '{}': {e}", spec.filename)
    })?;
    Ok(())
}

fn read_asset_in_root(root: &Path, model_id: &str, asset_name: &str) -> Result<Vec<u8>, String> {
    let model = OcrModelId::from_str(model_id)?;
    let (path, _spec) = resolve_asset_path_in_root(root, model, asset_name)?;
    fs::read(&path).map_err(|e| format!("Failed to read OCR asset '{}/{}': {e}", model.as_str(), asset_name, ))
}

fn delete_model_in_root(root: &Path, model_id: &str) -> Result<(), String> {
    let model = OcrModelId::from_str(model_id)?;
    let target_dir = root.join(model.as_str());
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .map_err(|e| format!("Failed to remove OCR model directory: {e}"))?;
    }
    Ok(())
}

fn ordered_urls(spec: &AssetSpec, use_mirror: bool) -> Vec<&'static str> {
    let mut urls = Vec::with_capacity(spec.primary_urls.len() + spec.mirror_urls.len());
    if use_mirror {
        urls.extend_from_slice(spec.mirror_urls);
        urls.extend_from_slice(spec.primary_urls);
    } else {
        urls.extend_from_slice(spec.primary_urls);
        urls.extend_from_slice(spec.mirror_urls);
    }
    urls
}

#[tauri::command]
pub fn ocr_model_list_status() -> OcrModelsStatusResponse {
    status_from_root(&get_ocr_models_root_dir())
}

#[tauri::command]
pub fn ocr_model_cancel_download() -> Result<(), String> {
    OCR_DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn ocr_model_get_download_progress() -> OcrModelDownloadProgress {
    get_progress_lock()
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| default_progress())
}

#[tauri::command]
pub fn ocr_model_read_asset(model_id: String, asset_name: String) -> Result<tauri::ipc::Response, String> {
    let bytes = read_asset_in_root(&get_ocr_models_root_dir(), &model_id, &asset_name)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn ocr_model_write_asset(request: tauri::ipc::Request<'_>) -> Result<OcrModelsStatusResponse, String> {
    let root = get_ocr_models_root_dir();
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            let model_id = request
                .headers()
                .get("x-ocr-model-id")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "Missing x-ocr-model-id header".to_string())?;
            let asset_name = request
                .headers()
                .get("x-ocr-asset-name")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "Missing x-ocr-asset-name header".to_string())?;
            write_asset_atomic_in_root(&root, model_id, asset_name, bytes)?;
        }
        tauri::ipc::InvokeBody::Json(val) => {
            let model_id = val
                .get("modelId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing modelId field".to_string())?;
            let asset_name = val
                .get("assetName")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing assetName field".to_string())?;
            let b64 = val
                .get("base64")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Missing base64 field".to_string())?;
            if b64.len() > (MAX_OCR_ASSET_BYTES as usize) * 2 {
                return Err("Encoded OCR asset exceeds size limit".to_string());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .map_err(|e| format!("Invalid base64 OCR asset payload: {e}"))?;
            write_asset_atomic_in_root(&root, model_id, asset_name, &bytes)?;
        }
    }
    Ok(status_from_root(&root))
}

#[tauri::command]
pub fn ocr_model_delete(model_id: String) -> Result<OcrModelsStatusResponse, String> {
    let root = get_ocr_models_root_dir();
    delete_model_in_root(&root, &model_id)?;
    Ok(status_from_root(&root))
}

#[tauri::command]
pub async fn ocr_model_download(
    app_handle: tauri::AppHandle,
    model_id: String,
    use_mirror: Option<bool>,
    locale: Option<String>,
) -> Result<OcrModelsStatusResponse, String> {
    let en = is_en_locale(locale.as_deref());
    OCR_ACTIVE_IS_EN.store(en, Ordering::SeqCst);
    let target = OcrModelId::from_str(&model_id)?;
    if target == OcrModelId::Runtime {
        return Err(l10n(en, "请通过具体识别模型触发运行时下载", "Select an OCR model to download").to_string());
    }
    let _guard = OcrDownloadGuard::acquire(en)?;
    OCR_DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);

    let root = get_ocr_models_root_dir();
    let prefer_mirror = use_mirror.unwrap_or(false);

    let mut queue: Vec<(OcrModelId, &'static AssetSpec)> = Vec::new();
    let (rt_path, rt_spec) = resolve_asset_path_in_root(&root, OcrModelId::Runtime, RUNTIME_WASM_FILENAME)?;
    if is_valid_installed_file(&rt_path, rt_spec.min_bytes).is_none() {
        queue.push((OcrModelId::Runtime, rt_spec));
    }
    for spec in assets_for_model(target) {
        let (p, _) = resolve_asset_path_in_root(&root, target, spec.filename)?;
        if is_valid_installed_file(&p, spec.min_bytes).is_none() {
            queue.push((target, spec));
        }
    }

    if queue.is_empty() {
        update_progress(Some(&app_handle), |p| {
            p.phase = "completed".to_string();
            p.model_id = target.as_str().to_string();
            p.percent = 100;
            p.error = None;
            p.message = l10n(en, "OCR 模型已就绪", "OCR model already ready").to_string();
        });
        return Ok(status_from_root(&root));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .redirect(safe_https_redirect_policy(10, false))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let total_files = queue.len();

    for (idx, (item_model, spec)) in queue.into_iter().enumerate() {
        let file_index = idx + 1;
        let (dest_path, _) = resolve_asset_path_in_root(&root, item_model, spec.filename)?;
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create OCR dir: {e}"))?;
        }
        let tmp_path = dest_path.with_extension("tmp");
        let _ = fs::remove_file(&tmp_path);

        let urls = ordered_urls(spec, prefer_mirror);
        let mut last_err = String::new();
        let mut file_done = false;

        for url in urls {
            if OCR_DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&tmp_path);
                let msg = l10n(en, "用户取消了 OCR 模型下载", "OCR model download cancelled by user").to_string();
                update_progress(Some(&app_handle), |p| {
                    p.phase = "cancelled".to_string();
                    p.model_id = target.as_str().to_string();
                    p.current_file = spec.filename.to_string();
                    p.file_index = file_index;
                    p.total_files = total_files;
                    p.error = None;
                    p.message = msg.clone();
                });
                return Err(msg);
            }

            let parsed_url = match reqwest::Url::parse(url) {
                Ok(u) if u.scheme() == "https" => u,
                _ => {
                    last_err = format!("Invalid HTTPS URL: {url}");
                    continue;
                }
            };

            update_progress(Some(&app_handle), |p| {
                p.phase = "connecting".to_string();
                p.model_id = target.as_str().to_string();
                p.current_file = spec.filename.to_string();
                p.file_index = file_index;
                p.total_files = total_files;
                p.loaded_bytes = 0;
                p.total_bytes = 0;
                p.percent = ((idx as f64 / total_files as f64) * 100.0) as u32;
                p.error = None;
                p.message = if en {
                    format!("Requesting {} ({}/{})...", spec.filename, file_index, total_files)
                } else {
                    format!("正在连接下载 {} ({}/{})...", spec.filename, file_index, total_files)
                };
            });

            let mut resp = match client.get(parsed_url).send().await {
                Ok(r) if r.status().is_success() => r,
                Ok(r) => {
                    last_err = format!("HTTP {} from {}", r.status(), url);
                    continue;
                }
                Err(e) => {
                    last_err = format!("Request failed ({}): {}", url, e);
                    continue;
                }
            };

            let total_size = resp.content_length().unwrap_or(0);
            if total_size > MAX_OCR_ASSET_BYTES {
                last_err = format!("Remote asset {} exceeds 100MB safety limit", spec.filename);
                continue;
            }

            let mut out_file = fs::File::create(&tmp_path)
                .map_err(|e| format!("Failed to create temp file for {}: {e}", spec.filename))?;
            let mut downloaded: u64 = 0;
            let mut stream_err: Option<String> = None;

            loop {
                if OCR_DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                    drop(out_file);
                    let _ = fs::remove_file(&tmp_path);
                    let msg = l10n(en, "用户取消了 OCR 模型下载", "OCR model download cancelled by user").to_string();
                    update_progress(Some(&app_handle), |p| {
                        p.phase = "cancelled".to_string();
                        p.model_id = target.as_str().to_string();
                        p.current_file = spec.filename.to_string();
                        p.file_index = file_index;
                        p.total_files = total_files;
                        p.error = None;
                        p.message = msg.clone();
                    });
                    return Err(msg);
                }

                match resp.chunk().await {
                    Ok(Some(chunk)) => {
                        if downloaded + (chunk.len() as u64) > MAX_OCR_ASSET_BYTES {
                            stream_err = Some(format!("Asset {} exceeded 100MB cap", spec.filename));
                            break;
                        }
                        if let Err(e) = out_file.write_all(&chunk) {
                            stream_err = Some(format!("Disk write error: {e}"));
                            break;
                        }
                        downloaded += chunk.len() as u64;
                        let file_frac = if total_size > 0 {
                            (downloaded as f64 / total_size as f64).min(1.0)
                        } else {
                            0.5
                        };
                        let overall_pct = (((idx as f64 + file_frac) / total_files as f64) * 100.0).min(99.0) as u32;
                        update_progress(Some(&app_handle), |p| {
                            p.phase = "downloading".to_string();
                            p.model_id = target.as_str().to_string();
                            p.current_file = spec.filename.to_string();
                            p.file_index = file_index;
                            p.total_files = total_files;
                            p.loaded_bytes = downloaded;
                            p.total_bytes = total_size;
                            p.percent = overall_pct;
                            p.error = None;
                            p.message = if en {
                                format!(
                                    "Downloading {} ({}/{}): {:.1} MB",
                                    spec.filename,
                                    file_index,
                                    total_files,
                                    downloaded as f64 / (1024.0 * 1024.0)
                                )
                            } else {
                                format!(
                                    "正在下载 {} ({}/{}): {:.1} MB",
                                    spec.filename,
                                    file_index,
                                    total_files,
                                    downloaded as f64 / (1024.0 * 1024.0)
                                )
                            };
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        stream_err = Some(format!("Stream interrupted: {e}"));
                        break;
                    }
                }
            }

            if stream_err.is_none() {
                if let Err(e) = out_file.sync_all() {
                    stream_err = Some(format!("Disk flush error: {e}"));
                } else if downloaded < spec.min_bytes {
                    stream_err = Some(format!("Downloaded {} is too small ({} bytes)", spec.filename, downloaded));
                } else if total_size > 0 && downloaded != total_size {
                    stream_err = Some(format!(
                        "Incomplete {}: expected {} bytes, got {} bytes",
                        spec.filename, total_size, downloaded
                    ));
                }
            }
            drop(out_file);

            if let Some(err) = stream_err {
                let _ = fs::remove_file(&tmp_path);
                last_err = err;
                continue;
            }

            fs::rename(&tmp_path, &dest_path).map_err(|e| {
                let _ = fs::remove_file(&tmp_path);
                format!("Failed to finalize {}: {e}", spec.filename)
            })?;
            file_done = true;
            break;
        }

        if !file_done {
            let err_msg = if en {
                format!("Failed to download {}: {}", spec.filename, last_err)
            } else {
                format!("下载 {} 失败: {}", spec.filename, last_err)
            };
            update_progress(Some(&app_handle), |p| {
                p.phase = "error".to_string();
                p.model_id = target.as_str().to_string();
                p.current_file = spec.filename.to_string();
                p.file_index = file_index;
                p.total_files = total_files;
                p.error = Some(err_msg.clone());
                p.message = err_msg.clone();
            });
            return Err(err_msg);
        }
    }

    update_progress(Some(&app_handle), |p| {
        p.phase = "completed".to_string();
        p.model_id = target.as_str().to_string();
        p.current_file = String::new();
        p.file_index = total_files;
        p.total_files = total_files;
        p.percent = 100;
        p.error = None;
        p.message = l10n(en, "OCR 离线模型下载完成并已就绪", "OCR offline model downloaded and ready").to_string();
    });

    Ok(status_from_root(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "linden_ocr_models_test_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn allowlist_rejects_traversal_and_unknown_assets() {
        assert!(OcrModelId::from_str("../secret").is_err());
        assert!(OcrModelId::from_str("ppocrv6-large").is_err());
        assert!(OcrModelId::from_str("ppocrv6-small").is_ok());
        assert!(OcrModelId::from_str("ppocrv6-tiny").is_ok());
        assert!(OcrModelId::from_str("runtime").is_ok());

        let root = PathBuf::from("unused_root");
        assert!(resolve_asset_path_in_root(&root, OcrModelId::PpOcrV6Small, "../evil").is_err());
        assert!(resolve_asset_path_in_root(&root, OcrModelId::PpOcrV6Small, "ort-wasm-simd-threaded.jsep.wasm").is_err());
        assert!(resolve_asset_path_in_root(&root, OcrModelId::Runtime, "det.onnx").is_err());
        assert!(resolve_asset_path_in_root(&root, OcrModelId::PpOcrV6Tiny, "rec.yml").is_ok());
    }

    #[test]
    fn manifest_urls_are_public_https_and_mirror_order_honored() {
        for model in [OcrModelId::Runtime, OcrModelId::PpOcrV6Small, OcrModelId::PpOcrV6Tiny] {
            for spec in assets_for_model(model) {
                assert!(!spec.primary_urls.is_empty());
                assert!(!spec.mirror_urls.is_empty());
                let prim = ordered_urls(spec, false);
                let mirr = ordered_urls(spec, true);
                assert_eq!(prim[0], spec.primary_urls[0]);
                assert_eq!(mirr[0], spec.mirror_urls[0]);
                for u in prim {
                    let parsed = reqwest::Url::parse(u).expect("valid URL");
                    assert_eq!(parsed.scheme(), "https");
                }
            }
        }
    }

    #[test]
    fn status_write_read_delete_roundtrip_in_temp_root() {
        let root = temp_test_dir("roundtrip");
        let initial = status_from_root(&root);
        assert!(!initial.runtime_installed);
        assert_eq!(initial.models.len(), 2);
        assert!(!initial.models[0].installed);
        assert!(!initial.models[0].ready);

        let fake_wasm = vec![0x61u8; 2048];
        let fake_onnx = vec![0x42u8; 2048];
        let fake_yml = vec![0x20u8; 256];

        // Model without runtime: installed=true, ready=false
        write_asset_atomic_in_root(&root, "ppocrv6-tiny", "det.onnx", &fake_onnx).unwrap();
        write_asset_atomic_in_root(&root, "ppocrv6-tiny", "rec.onnx", &fake_onnx).unwrap();
        write_asset_atomic_in_root(&root, "ppocrv6-tiny", "rec.yml", &fake_yml).unwrap();

        let partial = status_from_root(&root);
        assert!(!partial.runtime_installed);
        let tiny = partial.models.iter().find(|m| m.id == "ppocrv6-tiny").unwrap();
        assert!(tiny.installed);
        assert!(!tiny.ready);
        assert_eq!(tiny.size_bytes, (2048 + 2048 + 256) as u64);

        // Install runtime -> tiny becomes ready
        write_asset_atomic_in_root(&root, "runtime", RUNTIME_WASM_FILENAME, &fake_wasm).unwrap();
        let ready = status_from_root(&root);
        assert!(ready.runtime_installed);
        assert_eq!(ready.runtime_size_bytes, 2048);
        let tiny_ready = ready.models.iter().find(|m| m.id == "ppocrv6-tiny").unwrap();
        assert!(tiny_ready.ready);

        // Read back exact bytes
        let read_back = read_asset_in_root(&root, "ppocrv6-tiny", "det.onnx").unwrap();
        assert_eq!(read_back, fake_onnx);

        // Reject undersized payload
        assert!(write_asset_atomic_in_root(&root, "ppocrv6-tiny", "det.onnx", &[1, 2, 3]).is_err());

        // Delete removes model without breaking runtime
        delete_model_in_root(&root, "ppocrv6-tiny").unwrap();
        let after_del = status_from_root(&root);
        assert!(after_del.runtime_installed);
        let tiny_after = after_del.models.iter().find(|m| m.id == "ppocrv6-tiny").unwrap();
        assert!(!tiny_after.installed);
        assert!(!tiny_after.ready);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_progress_initializes_idle() {
        let p = ocr_model_get_download_progress();
        assert!(!p.phase.is_empty());
    }
}
