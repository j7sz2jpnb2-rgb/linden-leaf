use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use crate::commands::{is_en_locale, l10n};
use crate::commands::sync::{is_allowed_server_url, secure_load_credential};

use std::collections::HashMap;

/// Shared in-flight state; the user-configured cooldown belongs to chat only.
pub struct AiState {
    pub last_chat_dispatched_at: Mutex<Option<Instant>>,
    pub cooldown_seconds: AtomicU64,
    pub active_request_id: Mutex<Option<String>>,
    pub abort_tx: Mutex<Option<(String, tokio::sync::oneshot::Sender<()>)>>,
    pub daily_limit: AtomicU32,
    pub seen_requests: Mutex<HashMap<String, (Instant, String)>>,
    pub recent_payload_hashes: Mutex<HashMap<u64, (String, Instant)>>,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            last_chat_dispatched_at: Mutex::new(None),
            cooldown_seconds: AtomicU64::new(10), // Default interval between reader questions
            active_request_id: Mutex::new(None),
            abort_tx: Mutex::new(None),
            daily_limit: AtomicU32::new(100), // Default 100 requests per day limit
            seen_requests: Mutex::new(HashMap::new()),
            recent_payload_hashes: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// This is local scheduling metadata, never a provider request parameter.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiRequestPurpose {
    #[default]
    Chat,
    ChapterTranslation,
}

impl AiRequestPurpose {
    fn cooldown_seconds(self, configured: u64) -> u64 {
        match self {
            Self::Chat => configured,
            Self::ChapterTranslation => 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletionPayload {
    pub request_id: String,
    #[serde(default)]
    pub purpose: AiRequestPurpose,
    #[serde(default)]
    pub request_scope: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    pub endpoint: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditEntry {
    pub id: String,
    pub timestamp: String,
    pub request_id: String,
    pub model: String,
    pub endpoint_host: String,
    pub status: String, // "completed", "cancelled", "failed", "cooldown_blocked", "concurrency_blocked"
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub duration_ms: u128,
    pub error_message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiStatusResponse {
    pub is_busy: bool,
    pub active_request_id: Option<String>,
    pub cooldown_seconds: u64,
    pub remaining_cooldown_seconds: u64,
    pub remaining_cooldown_ms: u64,
    pub today_count: u32,
    pub daily_limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DailyUsageRecord {
    pub date: String,
    pub count: u32,
}

fn get_ai_storage_dir() -> PathBuf {
    let dir = crate::commands::fs::resolve_app_data_dir();
    let _ = fs::create_dir_all(&dir);
    dir
}

fn get_audit_log_path() -> PathBuf {
    let mut dir = get_ai_storage_dir();
    dir.push("ai_audit_log.json");
    dir
}

fn get_daily_usage_path() -> PathBuf {
    let mut dir = get_ai_storage_dir();
    dir.push("ai_usage.json");
    dir
}

// Howard Hinnant's algorithm for converting unix timestamp to UTC Y-M-D and ISO8601
fn format_system_time_iso(time: SystemTime) -> (String, String) {
    let secs = time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = (secs / 86400) as i64;
    let day_secs = (secs % 86400) as u32;

    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;

    let date_str = format!("{:04}-{:02}-{:02}", y, m, d);
    let iso_str = format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hh, mm, ss);
    (date_str, iso_str)
}

fn get_today_count() -> u32 {
    let path = get_daily_usage_path();
    let (today, _) = format_system_time_iso(SystemTime::now());
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(rec) = serde_json::from_str::<DailyUsageRecord>(&content) {
            if rec.date == today {
                return rec.count;
            }
        }
    }
    0
}

fn increment_today_count() -> u32 {
    let path = get_daily_usage_path();
    let (today, _) = format_system_time_iso(SystemTime::now());
    let current = get_today_count();
    let next = current + 1;
    let rec = DailyUsageRecord {
        date: today,
        count: next,
    };
    if let Ok(json) = serde_json::to_string(&rec) {
        let _ = fs::write(&path, json);
    }
    next
}

static AI_AUDIT_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn append_audit_entry(entry: AiAuditEntry) {
    let _write_guard = AI_AUDIT_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = get_audit_log_path();
    let mut entries: Vec<AiAuditEntry> = if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };
    entries.push(entry);
    // Keep at most 500 audit entries to avoid unbounded file growth
    if entries.len() > 500 {
        entries.drain(0..entries.len() - 500);
    }
    if let Ok(json) = serde_json::to_string_pretty(&entries) {
        let _ = fs::write(&path, json);
    }
}

// Clean error message without leaking sensitive authorization tokens or long HTML
fn sanitize_error_message_localized(status: u16, raw: &str, locale: Option<&str>) -> String {
    let en = is_en_locale(locale);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return match status {
            401 => l10n(
                en,
                "API 鉴权失败，请检查 API Key 是否有效",
                "API authentication failed. Please check your API key.",
            )
            .to_string(),
            403 => l10n(
                en,
                "API 访问受限，缺少该模型的调用权限",
                "API access denied. Insufficient permission for this model.",
            )
            .to_string(),
            429 => l10n(
                en,
                "服务触发速率或限额限制 (Rate Limit)，请稍后再试",
                "Rate or quota limit exceeded (Rate Limit). Please try again later.",
            )
            .to_string(),
            500 => l10n(
                en,
                "大模型服务端发生内部错误 (500)",
                "AI service internal server error (500).",
            )
            .to_string(),
            503 => l10n(
                en,
                "大模型服务暂时繁忙 (503 Service Unavailable)，请稍后重试",
                "AI service temporarily busy (503 Service Unavailable). Please try again later.",
            )
            .to_string(),
            504 => l10n(
                en,
                "大模型网关响应超时 (504 Gateway Timeout)",
                "AI gateway timed out (504 Gateway Timeout).",
            )
            .to_string(),
            _ => {
                if en {
                    format!("Service request failed (HTTP {})", status)
                } else {
                    format!("服务请求失败 (HTTP {})", status)
                }
            }
        };
    }

    // Try extracting JSON error message from OpenAI/compatible responses
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(msg) = val.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
            return format!("HTTP {}: {}", status, msg);
        }
    }

    // Strip HTML if provider returned an HTML page (like Cloudflare 502/503)
    if trimmed.starts_with('<') {
        return if en {
            format!(
                "HTTP {}: Service returned an HTML error page. Please check your network or service availability.",
                status
            )
        } else {
            format!("HTTP {}: 服务返回错误页面，请检查网络或服务可用性", status)
        };
    }
    let text: String = if trimmed.chars().count() > 180 {
        let prefix: String = trimmed.chars().take(180).collect();
        format!("{}...", prefix)
    } else {
        trimmed.to_string()
    };

    format!("HTTP {}: {}", status, text)
}

#[allow(dead_code)]
fn sanitize_error_message(status: u16, raw: &str) -> String {
    sanitize_error_message_localized(status, raw, None)
}

fn ai_concurrency_blocked_msg(en: bool, cur: &str) -> String {
    if en {
        format!(
            "CONCURRENCY_BLOCKED: Another generation request ({}) is already in progress. Please wait or click Stop.",
            cur
        )
    } else {
        format!("CONCURRENCY_BLOCKED: 当前已有正在进行的生成请求 ({})，请等待完成或点击停止", cur)
    }
}

fn ai_cooldown_active_msg(en: bool, remaining_ms: u64) -> String {
    let seconds = (remaining_ms + 999) / 1000;
    if en {
        format!(
            "COOLDOWN_ACTIVE: Please wait {}s before sending a new request ({} ms remaining)",
            seconds, remaining_ms
        )
    } else {
        format!("COOLDOWN_ACTIVE: 请等待 {} 秒后再发送新请求 (剩余 {} 毫秒)", seconds, remaining_ms)
    }
}

fn ai_daily_limit_exceeded_msg(en: bool, count: u32) -> String {
    if en {
        format!(
            "DAILY_LIMIT_EXCEEDED: Daily request limit ({}) reached. Adjust the limit in Settings to continue.",
            count
        )
    } else {
        format!(
            "DAILY_LIMIT_EXCEEDED: 已达到今日请求上限 ({} 次)，请在设置中调整上限后继续",
            count
        )
    }
}

fn ai_bind_invalid_endpoint_msg(en: bool, err: &dyn std::fmt::Display) -> String {
    if en {
        format!("Invalid endpoint URL: {}", err)
    } else {
        format!("接口地址无效: {}", err)
    }
}

fn ai_invalid_request_id_msg(en: bool) -> &'static str {
    l10n(
        en,
        "INVALID_REQUEST_ID: 缺少请求标识符",
        "INVALID_REQUEST_ID: Missing request identifier",
    )
}

fn ai_duplicate_request_id_msg(en: bool, req_id: &str, status: &str) -> String {
    if en {
        format!(
            "DUPLICATE_REQUEST_ID: Request '{}' is already processing or completed ({}); duplicate dispatch rejected.",
            req_id, status
        )
    } else {
        format!(
            "DUPLICATE_REQUEST_ID: 请求 '{}' 已经处于处理或已完成状态 ({})，拒绝重复派发",
            req_id, status
        )
    }
}

fn ai_duplicate_payload_blocked_msg(en: bool, prev_req_id: &str) -> String {
    if en {
        format!(
            "DUPLICATE_PAYLOAD_BLOCKED: Detected prompt identical to recent request ({}); duplicate dispatch blocked to prevent accidental charges.",
            prev_req_id
        )
    } else {
        format!(
            "DUPLICATE_PAYLOAD_BLOCKED: 检测到与近期请求 ({}) 相同的生成内容，短时间内不重复派发以防误扣费",
            prev_req_id
        )
    }
}

fn ai_invalid_endpoint_msg(en: bool, err: &dyn std::fmt::Display) -> String {
    if en {
        format!("INVALID_ENDPOINT: Invalid endpoint URL format: {}", err)
    } else {
        format!("INVALID_ENDPOINT: 接口地址格式无效: {}", err)
    }
}

fn ai_credential_missing_msg(en: bool) -> &'static str {
    l10n(
        en,
        "CREDENTIAL_MISSING: 未检测到 API Key，请在设置中配置",
        "CREDENTIAL_MISSING: No API key found. Please configure one in Settings.",
    )
}

fn ai_origin_mismatch_msg(en: bool, saved_origin: &str, target_origin: &str) -> String {
    if en {
        format!(
            "ORIGIN_MISMATCH: API key is bound to origin '{}' and cannot be sent automatically to '{}'. Please confirm or rebind it in Settings.",
            saved_origin, target_origin
        )
    } else {
        format!(
            "ORIGIN_MISMATCH: API Key 当前绑定于地址 '{}'，无法自动发送至新地址 '{}'。请在设置中明确确认或重新绑定。",
            saved_origin, target_origin
        )
    }
}

fn ai_http_client_error_msg(en: bool, err: &dyn std::fmt::Display) -> String {
    if en {
        format!("HTTP_CLIENT_ERROR: Failed to initialize HTTP client: {}", err)
    } else {
        format!("HTTP_CLIENT_ERROR: 初始化 HTTP 客户端失败: {}", err)
    }
}

fn ai_network_failure_msg(en: bool, err: &dyn std::fmt::Display) -> String {
    if en {
        format!("Network connection failed: {}", err)
    } else {
        format!("网络连接失败: {}", err)
    }
}

fn ai_stream_interrupted_msg(en: bool, err: &dyn std::fmt::Display) -> String {
    if en {
        format!("Stream read interrupted: {}", err)
    } else {
        format!("数据流读取中断: {}", err)
    }
}

fn ai_audit_terminal_message(
    en: bool,
    was_cancelled: bool,
    has_stream_error: bool,
    final_status: &str,
) -> Option<String> {
    if was_cancelled {
        Some(l10n(en, "用户点击停止", "Stopped by user").to_string())
    } else if has_stream_error {
        Some(l10n(en, "数据流读取中断", "Stream read interrupted").to_string())
    } else if final_status == "partial" {
        Some(
            l10n(
                en,
                "响应未收到终止事件或达到最大Token",
                "Response ended without completion marker or reached max tokens",
            )
            .to_string(),
        )
    } else {
        None
    }
}

fn compute_payload_hash(endpoint: &str, model: &str, messages: &[ChatMessage]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    endpoint.hash(&mut hasher);
    model.hash(&mut hasher);
    for m in messages {
        m.role.hash(&mut hasher);
        m.content.hash(&mut hasher);
    }
    hasher.finish()
}

// Identical source text at two different locations is not a duplicate user action.
fn compute_scoped_payload_hash(endpoint: &str, model: &str, messages: &[ChatMessage], scope: Option<&str>) -> u64 {
    let base = compute_payload_hash(endpoint, model, messages);
    match scope.filter(|value| !value.is_empty()) {
        None => base,
        Some(value) => {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            base.hash(&mut hasher);
            value.hash(&mut hasher);
            hasher.finish()
        }
    }
}

struct RequestLockGuard<'a> {
    state: &'a AiState,
    request_id: String,
    final_status: Mutex<String>,
}

impl<'a> Drop for RequestLockGuard<'a> {
    fn drop(&mut self) {
        let mut active = self.state.active_request_id.lock().unwrap();
        if active.as_deref() == Some(&self.request_id) {
            *active = None;
        }
        let mut tx_guard = self.state.abort_tx.lock().unwrap();
        if let Some((ref req, _)) = *tx_guard {
            if req == &self.request_id {
                *tx_guard = None;
            }
        }

        let status = self.final_status.lock().unwrap().clone();
        let mut seen = self.state.seen_requests.lock().unwrap();
        seen.insert(self.request_id.clone(), (Instant::now(), status));
        if seen.len() > 300 {
            let cutoff = Instant::now() - std::time::Duration::from_secs(3600);
            seen.retain(|_, (time, _)| *time > cutoff);
        }
        let mut hashes = self.state.recent_payload_hashes.lock().unwrap();
        if hashes.len() > 100 {
            let cutoff = Instant::now() - std::time::Duration::from_secs(120);
            hashes.retain(|_, (_, time)| *time > cutoff);
        }
    }
}

#[tauri::command]
pub fn ai_get_status(state: tauri::State<'_, AiState>, purpose: Option<AiRequestPurpose>) -> AiStatusResponse {
    let active_id = state.active_request_id.lock().unwrap().clone();
    let is_busy = active_id.is_some();
    let cooldown_secs = purpose.unwrap_or_default().cooldown_seconds(state.cooldown_seconds.load(Ordering::Relaxed));
    let daily_limit = state.daily_limit.load(Ordering::Relaxed);
    let today_count = get_today_count();

    let remaining_ms = {
        let last_disp = state.last_chat_dispatched_at.lock().unwrap();
        last_disp.map(|prev| remaining_cooldown_ms(cooldown_secs, prev.elapsed())).unwrap_or(0)
    };

    AiStatusResponse {
        is_busy,
        active_request_id: active_id,
        cooldown_seconds: cooldown_secs,
        remaining_cooldown_seconds: (remaining_ms + 999) / 1000,
        remaining_cooldown_ms: remaining_ms,
        today_count,
        daily_limit,
    }
}

pub(crate) fn abort_request_inner(state: &AiState, request_id: Option<&str>) -> bool {
    let active = state.active_request_id.lock().unwrap();
    let should_abort = match (active.as_deref(), request_id) {
        (Some(cur), Some(req)) => cur == req,
        (Some(_), None) => true,
        _ => false,
    };

    if should_abort {
        let mut tx_guard = state.abort_tx.lock().unwrap();
        let matches_req = match (tx_guard.as_ref(), request_id) {
            (Some((cur_req, _)), Some(req)) => cur_req == req,
            (Some(_), None) => true,
            _ => false,
        };
        if matches_req {
            if let Some((_, tx)) = tx_guard.take() {
                let _ = tx.send(());
            }
        }
        // Leave `active_request_id` owned until `RequestLockGuard::drop` runs after cleanup/audit.
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn ai_abort_request(state: tauri::State<'_, AiState>, request_id: Option<String>) -> bool {
    abort_request_inner(&state, request_id.as_deref())
}

#[tauri::command]
pub fn ai_get_audit_log(limit: Option<usize>) -> Vec<AiAuditEntry> {
    let path = get_audit_log_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut entries) = serde_json::from_str::<Vec<AiAuditEntry>>(&content) {
            entries.reverse(); // Show latest first
            if let Some(lim) = limit {
                entries.truncate(lim);
            }
            return entries;
        }
    }
    Vec::new()
}

#[tauri::command]
pub fn ai_clear_audit_log() -> bool {
    let path = get_audit_log_path();
    fs::write(&path, "[]").is_ok()
}

#[tauri::command]
pub fn ai_set_cooldown_and_limit(
    state: tauri::State<'_, AiState>,
    cooldown_seconds: Option<u64>,
    daily_limit: Option<u32>,
) -> bool {
    if let Some(cd) = cooldown_seconds {
        let safe_cd = cd.min(3600);
        state.cooldown_seconds.store(safe_cd, Ordering::Relaxed);
    }
    if let Some(lim) = daily_limit {
        state.daily_limit.store(lim, Ordering::Relaxed);
    }
    true
}

#[tauri::command]
pub fn ai_bind_credential(
    app_handle: tauri::AppHandle,
    endpoint: String,
    api_key: String,
    locale: Option<String>,
) -> Result<bool, String> {
    let en = is_en_locale(locale.as_deref());
    let parsed = reqwest::Url::parse(&endpoint)
        .map_err(|e| ai_bind_invalid_endpoint_msg(en, &e))?;
    is_allowed_server_url(&parsed)?;

    let clean_key = api_key.trim();
    if clean_key.is_empty() {
        crate::commands::sync::secure_store_credential_internal(app_handle.clone(), "reading_ai_api_key".to_string(), String::new())?;
        crate::commands::sync::secure_store_credential_internal(app_handle, "reading_ai_credential_origin".to_string(), String::new())?;
        return Ok(true);
    }

    let origin = parsed.origin().ascii_serialization();
    crate::commands::sync::secure_store_credential_internal(app_handle.clone(), "reading_ai_api_key".to_string(), clean_key.to_string())?;
    crate::commands::sync::secure_store_credential_internal(app_handle, "reading_ai_credential_origin".to_string(), origin)?;
    Ok(true)
}

// Millisecond admission state uses the same monotonic clock as dispatch.
fn remaining_cooldown_ms(cooldown_secs: u64, elapsed: Duration) -> u64 {
    let remaining = Duration::from_secs(cooldown_secs).saturating_sub(elapsed);
    ((remaining.as_nanos() + 999_999) / 1_000_000) as u64
}

fn audit_local_rejection(payload: &AiCompletionPayload, request_id: &str, start: Instant, status: &str, message: String) -> String {
    let (_, timestamp) = format_system_time_iso(SystemTime::now());
    append_audit_entry(AiAuditEntry {
        id: format!("audit_{}_local_{}", request_id, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()),
        timestamp,
        request_id: request_id.to_string(),
        model: payload.model.clone(),
        endpoint_host: reqwest::Url::parse(&payload.endpoint).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default(),
        status: status.to_string(),
        prompt_tokens: None,
        completion_tokens: None,
        total_tokens: None,
        duration_ms: start.elapsed().as_millis(),
        error_message: Some(message.clone()),
    });
    message
}

#[derive(Default, Debug)]
struct AiStreamUpdate {
    delta: Option<String>,
    done: bool,
}

// The final unterminated line follows the same text/usage path as normal lines.
fn apply_ai_stream_line(
    line: &str,
    full_text: &mut String,
    usage: &mut Option<serde_json::Value>,
    finish_reason: &mut Option<String>,
) -> Result<AiStreamUpdate, String> {
    let Some(data) = line.trim().strip_prefix("data:") else { return Ok(AiStreamUpdate::default()); };
    let data = data.trim_start();
    if data == "[DONE]" { return Ok(AiStreamUpdate { done: true, ..Default::default() }); }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else { return Ok(AiStreamUpdate::default()); };
    if let Some(error) = value.get("error").filter(|v| !v.is_null()) {
        return Err(serde_json::json!({ "error": error }).to_string());
    }
    let choice = value.get("choices").and_then(|c| c.get(0));
    let delta = choice.and_then(|c| c.get("delta")).and_then(|d| d.get("content"))
        .and_then(|s| s.as_str()).map(str::to_string);
    if let Some(text) = delta.as_deref() { full_text.push_str(text); }
    if let Some(value) = value.get("usage").filter(|v| v.is_object()) { *usage = Some(value.clone()); }
    if let Some(reason) = choice.and_then(|c| c.get("finish_reason")).and_then(|r| r.as_str()) {
        *finish_reason = Some(reason.to_string());
    }
    Ok(AiStreamUpdate { delta, done: false })
}

#[tauri::command]
pub async fn ai_request_chat_completion(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AiState>,
    payload: AiCompletionPayload,
) -> Result<serde_json::Value, String> {
    let en = is_en_locale(payload.locale.as_deref());
    let req_id = payload.request_id.trim().to_string();
    if req_id.is_empty() {
        return Err(ai_invalid_request_id_msg(en).to_string());
    }

    let start_time = Instant::now();
    let (_, iso_time) = format_system_time_iso(SystemTime::now());

    // 1. Check Request ID Deduplication (Prevent IPC replay, double send, re-attempt collisions)
    {
        let seen = state.seen_requests.lock().unwrap();
        if let Some((_, status)) = seen.get(&req_id) {
            return Err(ai_duplicate_request_id_msg(en, &req_id, status));
        }
    }

    // 2. Concurrency Check (Max 1 in-flight request per application)
    {
        let active = state.active_request_id.lock().unwrap();
        if let Some(ref cur) = *active {
            return Err(audit_local_rejection(
                &payload,
                &req_id,
                start_time,
                "concurrency_blocked",
                ai_concurrency_blocked_msg(en, cur),
            ));
        }
    }

    // 3. Reader-question cooldown does not pace an already-started chapter translation.
    let cooldown_secs = payload.purpose.cooldown_seconds(state.cooldown_seconds.load(Ordering::Relaxed));
    let remaining_ms = {
        let last_disp = state.last_chat_dispatched_at.lock().unwrap_or_else(|p| p.into_inner());
        last_disp.map(|prev| remaining_cooldown_ms(cooldown_secs, prev.elapsed())).unwrap_or(0)
    };
    if remaining_ms > 0 {
        return Err(audit_local_rejection(
            &payload,
            &req_id,
            start_time,
            "cooldown_blocked",
            ai_cooldown_active_msg(en, remaining_ms),
        ));
    }

    // 4. Daily Limit Quota Check
    let limit = state.daily_limit.load(Ordering::Relaxed);
    if limit > 0 {
        let count = get_today_count();
        if count >= limit {
            return Err(ai_daily_limit_exceeded_msg(en, count));
        }
    }

    // 5. Chat anti-double-click window; chapter units retain request-ID deduplication.
    let dedup_window_secs = cooldown_secs;
    let payload_hash = compute_scoped_payload_hash(&payload.endpoint, &payload.model, &payload.messages, payload.request_scope.as_deref());
    {
        let hashes = state.recent_payload_hashes.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((prev_req_id, prev_time)) = hashes.get(&payload_hash) {
            if prev_time.elapsed().as_secs() < dedup_window_secs {
                return Err(ai_duplicate_payload_blocked_msg(en, prev_req_id));
            }
        }
    }

    // 6. Validate Endpoint URL & Protocol (BEFORE claiming daily quota or in-flight lock!)
    let parsed_url = reqwest::Url::parse(&payload.endpoint)
        .map_err(|e| ai_invalid_endpoint_msg(en, &e))?;
    is_allowed_server_url(&parsed_url)?;

    // 7. Credential & Origin Binding Verification (BEFORE claiming daily quota or in-flight lock!)
    let api_key = match secure_load_credential(window.app_handle().clone(), "reading_ai_api_key".to_string())? {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => return Err(ai_credential_missing_msg(en).to_string()),
    };

    let target_origin = parsed_url.origin().ascii_serialization();
    if let Ok(Some(saved_origin)) = secure_load_credential(window.app_handle().clone(), "reading_ai_credential_origin".to_string()) {
        let clean_origin = saved_origin.trim();
        if !clean_origin.is_empty() && clean_origin != target_origin {
            return Err(ai_origin_mismatch_msg(en, clean_origin, &target_origin));
        }
    }

    // Setup abort channel before claiming lock so both active_request_id and abort_tx are registered atomically
    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();

    // Atomically claim lock, register abort channel, update dispatch time, and increment daily count
    {
        let mut active = state.active_request_id.lock().unwrap();
        if let Some(ref cur) = *active {
            return Err(audit_local_rejection(
                &payload,
                &req_id,
                start_time,
                "concurrency_blocked",
                ai_concurrency_blocked_msg(en, cur),
            ));
        }
        let mut tx_guard = state.abort_tx.lock().unwrap();
        let mut last_disp = state.last_chat_dispatched_at.lock().unwrap();
        // Credential loading can yield; recheck under the dispatch lock before claiming the slot.
        let remaining_ms = last_disp.map(|prev| remaining_cooldown_ms(
            payload.purpose.cooldown_seconds(state.cooldown_seconds.load(Ordering::Relaxed)), prev.elapsed()
        )).unwrap_or(0);
        if remaining_ms > 0 {
            return Err(audit_local_rejection(
                &payload,
                &req_id,
                start_time,
                "cooldown_blocked",
                ai_cooldown_active_msg(en, remaining_ms),
            ));
        }
        *active = Some(req_id.clone());
        *tx_guard = Some((req_id.clone(), abort_tx));
        if payload.purpose == AiRequestPurpose::Chat {
            *last_disp = Some(Instant::now());
        }
        let mut seen = state.seen_requests.lock().unwrap();
        seen.insert(req_id.clone(), (Instant::now(), "in_flight".to_string()));
        let mut hashes = state.recent_payload_hashes.lock().unwrap();
        if payload.purpose == AiRequestPurpose::Chat {
            hashes.insert(payload_hash, (req_id.clone(), Instant::now()));
        }
    }
    let _guard = RequestLockGuard {
        state: &state,
        request_id: req_id.clone(),
        final_status: Mutex::new("failed".to_string()),
    };

    // Bound connection and stalled reads, while allowing an active long answer.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| ai_http_client_error_msg(en, &e))?;

    let full_url = if payload.endpoint.ends_with("/chat/completions") {
        payload.endpoint.clone()
    } else {
        format!("{}/chat/completions", payload.endpoint.trim_end_matches('/'))
    };

    let max_tokens = payload.max_tokens.unwrap_or(20000).clamp(64, 20000);

    let req_body = serde_json::json!({
        "model": payload.model,
        "messages": payload.messages,
        "stream": true,
        "max_tokens": max_tokens,
        "temperature": payload.temperature.unwrap_or(0.3),
        "stream_options": { "include_usage": true }
    });

    let send_future = client
        .post(&full_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&req_body)
        .send();

    let mut response = tokio::select! {
        _ = &mut abort_rx => {
            {
                let mut status_guard = _guard.final_status.lock().unwrap();
                *status_guard = "cancelled".to_string();
            }
            append_audit_entry(AiAuditEntry {
                id: format!("audit_{}", req_id),
                timestamp: iso_time,
                request_id: req_id.clone(),
                model: payload.model.clone(),
                endpoint_host: parsed_url.host_str().unwrap_or("").to_string(),
                status: "cancelled".to_string(),
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
                duration_ms: start_time.elapsed().as_millis(),
                error_message: Some(l10n(en, "用户主动取消请求", "Request cancelled by user").to_string()),
            });
            let _ = window.emit(
                &format!("ai:stopped:{}", req_id),
                serde_json::json!({
                    "partialText": ""
                }),
            );
            return Ok(serde_json::json!({
                "stopped": true,
                "partialText": ""
            }));
        }
        res = send_future => {
            match res {
                Ok(r) => r,
                Err(err) => {
                    let err_msg = ai_network_failure_msg(en, &err);
                    append_audit_entry(AiAuditEntry {
                        id: format!("audit_{}", req_id),
                        timestamp: iso_time,
                        request_id: req_id.clone(),
                        model: payload.model.clone(),
                        endpoint_host: parsed_url.host_str().unwrap_or("").to_string(),
                        status: "failed".to_string(),
                        prompt_tokens: None,
                        completion_tokens: None,
                        total_tokens: None,
                        duration_ms: start_time.elapsed().as_millis(),
                        error_message: Some(err_msg.clone()),
                    });
                    let _ = window.emit(
                        &format!("ai:error:{}", req_id),
                        serde_json::json!({
                            "status": 0,
                            "message": err_msg
                        }),
                    );
                    return Err(err_msg);
                }
            }
        }
    };

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let raw_err = response.text().await.unwrap_or_default();
        let sanitized = sanitize_error_message_localized(status_code, &raw_err, payload.locale.as_deref());

        append_audit_entry(AiAuditEntry {
            id: format!("audit_{}", req_id),
            timestamp: iso_time,
            request_id: req_id.clone(),
            model: payload.model.clone(),
            endpoint_host: parsed_url.host_str().unwrap_or("").to_string(),
            status: "failed".to_string(),
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            duration_ms: start_time.elapsed().as_millis(),
            error_message: Some(sanitized.clone()),
        });

        let _ = window.emit(
            &format!("ai:error:{}", req_id),
            serde_json::json!({
                "status": status_code,
                "message": sanitized
            }),
        );
        return Err(sanitized);
    }

    increment_today_count();

    // 7. Process SSE Stream with Stop / Abort Interruption
    let mut byte_buffer: Vec<u8> = Vec::new();
    let mut full_text = String::new();
    let mut usage_val: Option<serde_json::Value> = None;
    let mut finish_reason: Option<String> = None;
    let mut was_cancelled = false;
    let mut has_stream_error = false;
    let mut last_stream_error: Option<String> = None;
    let mut received_done = false;

    loop {
        tokio::select! {
            _ = &mut abort_rx => {
                was_cancelled = true;
                let _ = window.emit(
                    &format!("ai:stopped:{}", req_id),
                    serde_json::json!({
                        "partialText": full_text
                    }),
                );
                break;
            }
            chunk_res = response.chunk() => {
                match chunk_res {
                    Ok(Some(bytes)) => {
                        byte_buffer.extend_from_slice(&bytes);

                        while let Some(newline_pos) = byte_buffer.iter().position(|&b| b == b'\n') {
                            let line = String::from_utf8_lossy(&byte_buffer[..newline_pos]).trim().to_string();
                            byte_buffer.drain(..=newline_pos);

                            match apply_ai_stream_line(&line, &mut full_text, &mut usage_val, &mut finish_reason) {
                                Ok(update) => {
                                    received_done |= update.done;
                                    if let Some(delta) = update.delta {
                                        let _ = window.emit(&format!("ai:chunk:{}", req_id), serde_json::json!({ "delta": delta }));
                                    }
                                }
                                Err(raw) => {
                                    has_stream_error = true;
                                    let message = sanitize_error_message_localized(500, &raw, payload.locale.as_deref());
                                    last_stream_error = Some(message.clone());
                                    let _ = window.emit(&format!("ai:error:{}", req_id), serde_json::json!({ "status": 500, "message": message }));
                                }
                            }
                            if received_done || has_stream_error { break; }
                        }
                        if received_done || has_stream_error { break; }
                    }
                    Ok(None) => {
                        // EOF - Check remaining byte_buffer without newline
                        if !byte_buffer.is_empty() {
                            let trailing = String::from_utf8_lossy(&byte_buffer).trim().to_string();
                            byte_buffer.clear();
                            match apply_ai_stream_line(&trailing, &mut full_text, &mut usage_val, &mut finish_reason) {
                                Ok(update) => {
                                    received_done |= update.done;
                                    if let Some(delta) = update.delta {
                                        let _ = window.emit(&format!("ai:chunk:{}", req_id), serde_json::json!({ "delta": delta }));
                                    }
                                }
                                Err(raw) => {
                                    has_stream_error = true;
                                    let message = sanitize_error_message_localized(500, &raw, payload.locale.as_deref());
                                    last_stream_error = Some(message.clone());
                                    let _ = window.emit(&format!("ai:error:{}", req_id), serde_json::json!({ "status": 500, "message": message }));
                                }
                            }
                        }
                        break;
                    }
                    Err(e) => {
                        has_stream_error = true;
                        let err_msg = ai_stream_interrupted_msg(en, &e);
                        last_stream_error = Some(err_msg.clone());
                        let _ = window.emit(
                            &format!("ai:error:{}", req_id),
                            serde_json::json!({
                                "status": 500,
                                "message": err_msg
                            }),
                        );
                        break;
                    }
                }
            }
        }
    }

    let final_status = if was_cancelled {
        "cancelled"
    } else if has_stream_error {
        "failed"
    } else if received_done || finish_reason.is_some() {
        if finish_reason.as_deref() == Some("length") || finish_reason.as_deref() == Some("max_tokens") {
            "partial"
        } else {
            "completed"
        }
    } else {
        // EOF with no [DONE] and no finish_reason: unconfirmed termination, classify as partial
        "partial"
    };
    {
        let mut status_guard = _guard.final_status.lock().unwrap();
        *status_guard = final_status.to_string();
    }
    let p_tok = usage_val.as_ref().and_then(|u| u.get("prompt_tokens")).and_then(|v| v.as_u64());
    let c_tok = usage_val.as_ref().and_then(|u| u.get("completion_tokens")).and_then(|v| v.as_u64());
    let t_tok = usage_val.as_ref().and_then(|u| u.get("total_tokens")).and_then(|v| v.as_u64());

    append_audit_entry(AiAuditEntry {
        id: format!("audit_{}", req_id),
        timestamp: iso_time,
        request_id: req_id.clone(),
        model: payload.model,
        endpoint_host: parsed_url.host_str().unwrap_or("").to_string(),
        status: final_status.to_string(),
        prompt_tokens: p_tok,
        completion_tokens: c_tok,
        total_tokens: t_tok,
        duration_ms: start_time.elapsed().as_millis(),
        error_message: ai_audit_terminal_message(en, was_cancelled, has_stream_error, final_status),
    });

    if has_stream_error && !was_cancelled {
        return Err(last_stream_error.unwrap_or_else(|| {
            ai_audit_terminal_message(en, false, true, final_status)
                .unwrap_or_else(|| "Stream failed".to_string())
        }));
    }

    if !was_cancelled && !has_stream_error {
        let _ = window.emit(
            &format!("ai:done:{}", req_id),
            serde_json::json!({
                "fullText": full_text,
                "usage": usage_val,
                "finishReason": finish_reason,
                "status": final_status
            }),
        );
    }

    Ok(serde_json::json!({
        "requestId": req_id,
        "status": final_status,
        "fullText": full_text,
        "usage": usage_val,
        "finishReason": finish_reason
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_fields_accept_optional_space_and_preserve_final_text_and_usage() {
        let mut text = String::new();
        let mut usage = None;
        let mut finish = None;
        let delta = apply_ai_stream_line(r#"data:{"choices":[{"delta":{"content":"中文末尾🙂"},"finish_reason":null}]}"#, &mut text, &mut usage, &mut finish).unwrap();
        assert_eq!(text, "中文末尾🙂");
        assert_eq!(delta.delta.as_deref(), Some("中文末尾🙂"));
        apply_ai_stream_line(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}"#, &mut text, &mut usage, &mut finish).unwrap();
        assert_eq!(finish.as_deref(), Some("stop"));
        assert_eq!(usage.as_ref().unwrap()["total_tokens"], 5);
        apply_ai_stream_line(r#"data: {"choices":[],"usage":null}"#, &mut text, &mut usage, &mut finish).unwrap();
        assert_eq!(usage.as_ref().unwrap()["total_tokens"], 5);
        assert!(apply_ai_stream_line("data:[DONE]", &mut text, &mut usage, &mut finish).unwrap().done);
        assert!(!apply_ai_stream_line(": heartbeat", &mut text, &mut usage, &mut finish).unwrap().done);
        assert!(apply_ai_stream_line(r#"data:{"error":{"message":"local test error"}}"#, &mut text, &mut usage, &mut finish).is_err());
    }

    #[test]
    fn test_format_system_time_iso() {
        let (d, iso) = format_system_time_iso(UNIX_EPOCH);
        assert_eq!(d, "1970-01-01");
        assert_eq!(iso, "1970-01-01T00:00:00Z");

        let (d2, iso2) = format_system_time_iso(UNIX_EPOCH + std::time::Duration::from_secs(86400 * 365 + 3600));
        assert_eq!(d2, "1971-01-01");
        assert_eq!(iso2, "1971-01-01T01:00:00Z");
    }

    #[test]
    fn test_cooldown_millisecond_boundary() {
        assert_eq!(remaining_cooldown_ms(10, Duration::from_millis(9655)), 345);
        assert_eq!(remaining_cooldown_ms(10, Duration::from_millis(9999)), 1);
        assert_eq!(remaining_cooldown_ms(10, Duration::from_secs(10)), 0);
        assert_eq!(remaining_cooldown_ms(0, Duration::ZERO), 0);
    }

    #[test]
    fn test_chapter_translation_ignores_chat_cooldown() {
        let chat = AiRequestPurpose::default();
        let chapter = AiRequestPurpose::ChapterTranslation;
        assert_eq!(remaining_cooldown_ms(chat.cooldown_seconds(10), Duration::from_secs(2)), 8000);
        assert_eq!(remaining_cooldown_ms(chapter.cooldown_seconds(10), Duration::from_secs(2)), 0);
        assert_eq!(chapter.cooldown_seconds(3600), 0);
        assert_eq!(chat.cooldown_seconds(0), 0);
        let old_payload: AiCompletionPayload = serde_json::from_value(serde_json::json!({
            "requestId": "old-chat", "endpoint": "https://example.com/v1", "model": "fixture", "messages": []
        })).unwrap();
        assert_eq!(old_payload.purpose, AiRequestPurpose::Chat);
        assert_eq!(serde_json::from_str::<AiRequestPurpose>("\"chapterTranslation\"").unwrap(), chapter);
    }

    #[test]
    fn test_cooldown_enforcement() {
        let state = AiState::default();
        state.cooldown_seconds.store(10, Ordering::Relaxed);

        // First dispatch sets timestamp
        {
            let mut last = state.last_chat_dispatched_at.lock().unwrap();
            *last = Some(Instant::now());
        }

        // Within 10s cooldown, checking elapsed should be < 10
        let last = state.last_chat_dispatched_at.lock().unwrap();
        let elapsed = last.unwrap().elapsed().as_secs();
        assert!(elapsed < 10);
    }

    #[test]
    fn test_sanitize_error_message() {
        let msg503 = sanitize_error_message(503, "");
        assert!(msg503.contains("503"));
        assert!(msg503.contains("繁忙"));

        let msg429 = sanitize_error_message(429, "");
        assert!(msg429.contains("速率或限额限制"));

        let json_err = r#"{"error":{"message":"Incorrect API key provided"}}"#;
        let sanitized = sanitize_error_message(401, json_err);
        assert_eq!(sanitized, "HTTP 401: Incorrect API key provided");

        let html_err = "<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>";
        let sanitized_html = sanitize_error_message(502, html_err);
        assert!(sanitized_html.contains("HTTP 502: 服务返回错误页面"));
        assert!(!sanitized_html.contains("<html"));

        let long_cjk = "这是一段很长的测试错误文本，包含许多中文字符。".repeat(10);
        assert!(long_cjk.chars().count() > 180);
        let sanitized_cjk = sanitize_error_message(500, &long_cjk);
        assert!(sanitized_cjk.ends_with("..."));
        assert!(sanitized_cjk.starts_with("HTTP 500: "));
    }

    #[test]
    fn test_ai_locale_sanitization_payload_and_machine_prefixes() {
        // Explicit "en", "zh-CN", unrecognized fallback, and None default
        let en503 = sanitize_error_message_localized(503, "", Some("en"));
        assert!(en503.contains("503 Service Unavailable"));
        assert!(en503.contains("temporarily busy"));

        let en_html = sanitize_error_message_localized(502, "<html>bad</html>", Some("en-US"));
        assert_eq!(
            en_html,
            "HTTP 502: Service returned an HTML error page. Please check your network or service availability."
        );

        let zh401 = sanitize_error_message_localized(401, "", Some("zh-CN"));
        assert!(zh401.contains("API 鉴权失败"));
        let fallback401 = sanitize_error_message_localized(401, "", Some("ja-JP"));
        assert_eq!(fallback401, zh401);
        let none401 = sanitize_error_message_localized(401, "", None);
        assert_eq!(none401, zh401);

        // Serde compatibility with and without `locale`
        let legacy_json = r#"{
            "requestId": "req_1",
            "endpoint": "https://api.openai.com/v1",
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}]
        }"#;
        let legacy_payload: AiCompletionPayload = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy_payload.locale, None);
        assert!(!is_en_locale(legacy_payload.locale.as_deref()));

        let en_json = r#"{
            "requestId": "req_2",
            "locale": "en",
            "endpoint": "https://api.openai.com/v1",
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}]
        }"#;
        let en_payload: AiCompletionPayload = serde_json::from_str(en_json).unwrap();
        assert_eq!(en_payload.locale.as_deref(), Some("en"));
        assert!(is_en_locale(en_payload.locale.as_deref()));

        // Preserve every uppercase machine error prefix verbatim in both zh-CN and en
        for en in [false, true] {
            assert!(ai_invalid_request_id_msg(en).starts_with("INVALID_REQUEST_ID:"));
            assert!(ai_duplicate_request_id_msg(en, "r1", "in_flight").starts_with("DUPLICATE_REQUEST_ID:"));
            assert!(ai_concurrency_blocked_msg(en, "r1").starts_with("CONCURRENCY_BLOCKED:"));
            assert!(ai_cooldown_active_msg(en, 1500).starts_with("COOLDOWN_ACTIVE:"));
            assert!(ai_daily_limit_exceeded_msg(en, 100).starts_with("DAILY_LIMIT_EXCEEDED:"));
            assert!(ai_duplicate_payload_blocked_msg(en, "r1").starts_with("DUPLICATE_PAYLOAD_BLOCKED:"));
            assert!(ai_invalid_endpoint_msg(en, &"bad url").starts_with("INVALID_ENDPOINT:"));
            assert!(ai_credential_missing_msg(en).starts_with("CREDENTIAL_MISSING:"));
            assert!(ai_origin_mismatch_msg(en, "https://a.com", "https://b.com").starts_with("ORIGIN_MISMATCH:"));
            assert!(ai_http_client_error_msg(en, &"init").starts_with("HTTP_CLIENT_ERROR:"));
        }

        assert_eq!(ai_audit_terminal_message(true, true, false, "cancelled").as_deref(), Some("Stopped by user"));
        assert_eq!(ai_audit_terminal_message(false, true, false, "cancelled").as_deref(), Some("用户点击停止"));
        assert_eq!(ai_audit_terminal_message(true, false, true, "failed").as_deref(), Some("Stream read interrupted"));
        assert_eq!(ai_audit_terminal_message(true, false, false, "partial").as_deref(), Some("Response ended without completion marker or reached max tokens"));
        assert!(ai_audit_terminal_message(true, false, false, "completed").is_none());
    }

    #[test]
    fn test_request_id_and_payload_hash_deduplication() {
        let state = AiState::default();

        // 1. Verify seen_requests deduplication
        let req_id = "req_unique_001".to_string();
        {
            let mut seen = state.seen_requests.lock().unwrap();
            seen.insert(req_id.clone(), (Instant::now(), "completed".to_string()));
        }

        {
            let seen = state.seen_requests.lock().unwrap();
            assert!(seen.contains_key(&req_id));
            let (_, status) = seen.get(&req_id).unwrap();
            assert_eq!(status, "completed");
        }

        // 2. Verify payload hash computation consistency
        let msgs = vec![
            ChatMessage { role: "user".to_string(), content: "Translate this".to_string() }
        ];
        let h1 = compute_payload_hash("https://api.openai.com/v1", "gpt-4o", &msgs);
        let h2 = compute_payload_hash("https://api.openai.com/v1", "gpt-4o", &msgs);
        assert_eq!(h1, h2);

        let msgs2 = vec![
            ChatMessage { role: "user".to_string(), content: "Different question".to_string() }
        ];
        let h3 = compute_payload_hash("https://api.openai.com/v1", "gpt-4o", &msgs2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn test_concurrency_lock_guard() {
        let state = AiState::default();

        // Acquire lock
        {
            let mut active = state.active_request_id.lock().unwrap();
            assert!(active.is_none());
            *active = Some("req_in_flight".to_string());
        }

        // Check active blocks concurrent request
        {
            let active = state.active_request_id.lock().unwrap();
            assert_eq!(active.as_deref(), Some("req_in_flight"));
        }

        // Release lock
        {
            let mut active = state.active_request_id.lock().unwrap();
            *active = None;
        }

        {
            let active = state.active_request_id.lock().unwrap();
            assert!(active.is_none());
        }
    }

    #[test]
    fn test_abort_request_preserves_lock_until_guard_drop() {
        let state = AiState::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        *state.active_request_id.lock().unwrap() = Some("req_abort_1".to_string());
        *state.abort_tx.lock().unwrap() = Some(("req_abort_1".to_string(), tx));

        let guard = RequestLockGuard {
            state: &state,
            request_id: "req_abort_1".to_string(),
            final_status: Mutex::new("failed".to_string()),
        };

        assert!(abort_request_inner(&state, Some("req_abort_1")));
        assert!(rx.try_recv().is_ok());
        assert_eq!(
            state.active_request_id.lock().unwrap().as_deref(),
            Some("req_abort_1"),
            "abort must keep request lock until stream guard drops"
        );

        drop(guard);
        assert!(state.active_request_id.lock().unwrap().is_none());
    }
}

/// Bounded local protocol diagnostics; no original text, translations or credentials.
#[tauri::command]
pub fn ai_record_translation_diagnostic(diagnostic: serde_json::Value) -> Result<(), String> {
    let _guard = AI_AUDIT_WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut entry = serde_json::Map::new();
    for key in ["requestId", "protocol", "errorCode", "batchIndex", "batches", "expected", "matched", "returned", "structure", "itemTypes", "expectedIds", "returnedIds", "status", "finishReason", "recovered", "responseChars", "responsePreview"] {
        if let Some(value) = diagnostic.get(key) {
            entry.insert(key.to_owned(), value.clone());
        }
    }
    entry.insert("timestamp".into(), serde_json::Value::String(format_system_time_iso(SystemTime::now()).1));
    let path = get_ai_storage_dir().join("translation_diagnostics.json");
    let mut entries: Vec<serde_json::Value> = fs::read_to_string(&path).ok()
        .and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    entries.push(serde_json::Value::Object(entry));
    if entries.len() > 20 { entries.drain(0..entries.len() - 20); }
    let text = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}
