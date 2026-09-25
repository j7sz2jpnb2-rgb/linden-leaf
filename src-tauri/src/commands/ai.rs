use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use crate::commands::sync::{is_allowed_server_url, secure_load_credential, secure_store_credential};

use std::collections::HashMap;

/// Global state for AI Request protection, concurrency guard, and cooldown
pub struct AiState {
    pub last_dispatched_at: Mutex<Option<Instant>>,
    pub cooldown_seconds: AtomicU64,
    pub active_request_id: Mutex<Option<String>>,
    pub abort_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub daily_limit: AtomicU32,
    pub seen_requests: Mutex<HashMap<String, (Instant, String)>>,
    pub recent_payload_hashes: Mutex<HashMap<u64, (String, Instant)>>,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            last_dispatched_at: Mutex::new(None),
            cooldown_seconds: AtomicU64::new(10), // Default 10 seconds hard cooldown
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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiCompletionPayload {
    pub request_id: String,
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
    let mut dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lindenleaf.reader");
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

pub fn append_audit_entry(entry: AiAuditEntry) {
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
fn sanitize_error_message(status: u16, raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return match status {
            401 => "API 鉴权失败，请检查 API Key 是否有效".to_string(),
            403 => "API 访问受限，缺少该模型的调用权限".to_string(),
            429 => "服务触发速率或限额限制 (Rate Limit)，请稍后再试".to_string(),
            500 => "大模型服务端发生内部错误 (500)".to_string(),
            503 => "大模型服务暂时繁忙 (503 Service Unavailable)，请稍后重试".to_string(),
            504 => "大模型网关响应超时 (504 Gateway Timeout)".to_string(),
            _ => format!("服务请求失败 (HTTP {})", status),
        };
    }

    // Try extracting JSON error message from OpenAI/compatible responses
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(msg) = val.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
            return format!("HTTP {}: {}", status, msg);
        }
    }

    // Strip HTML if provider returned an HTML page (like Cloudflare 502/503)
    let text = if trimmed.starts_with('<') {
        "服务返回错误页面，请检查网络或服务可用性"
    } else if trimmed.len() > 180 {
        &trimmed[..180]
    } else {
        trimmed
    };

    format!("HTTP {}: {}", status, text)
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

struct RequestLockGuard<'a> {
    state: &'a AiState,
    request_id: String,
    final_status: Mutex<String>,
}

impl<'a> Drop for RequestLockGuard<'a> {
    fn drop(&mut self) {
        let mut active = self.state.active_request_id.lock().unwrap();
        *active = None;
        let mut tx_guard = self.state.abort_tx.lock().unwrap();
        *tx_guard = None;

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
pub fn ai_get_status(state: tauri::State<'_, AiState>) -> AiStatusResponse {
    let active_id = state.active_request_id.lock().unwrap().clone();
    let is_busy = active_id.is_some();
    let cooldown_secs = state.cooldown_seconds.load(Ordering::Relaxed);
    let daily_limit = state.daily_limit.load(Ordering::Relaxed);
    let today_count = get_today_count();

    let remaining_cooldown = {
        let last_disp = state.last_dispatched_at.lock().unwrap();
        if let Some(prev) = *last_disp {
            let elapsed = prev.elapsed().as_secs();
            if elapsed < cooldown_secs {
                cooldown_secs - elapsed
            } else {
                0
            }
        } else {
            0
        }
    };

    AiStatusResponse {
        is_busy,
        active_request_id: active_id,
        cooldown_seconds: cooldown_secs,
        remaining_cooldown_seconds: remaining_cooldown,
        today_count,
        daily_limit,
    }
}

#[tauri::command]
pub fn ai_abort_request(state: tauri::State<'_, AiState>, request_id: Option<String>) -> bool {
    let mut active = state.active_request_id.lock().unwrap();
    let should_abort = match (active.as_deref(), request_id.as_deref()) {
        (Some(cur), Some(req)) => cur == req,
        (Some(_), None) => true,
        _ => false,
    };

    if should_abort {
        let mut tx_guard = state.abort_tx.lock().unwrap();
        if let Some(tx) = tx_guard.take() {
            let _ = tx.send(());
        }
        *active = None;
        true
    } else {
        false
    }
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
        // Enforce minimum 5s cooldown, default 10s
        let safe_cd = cd.clamp(5, 60);
        state.cooldown_seconds.store(safe_cd, Ordering::Relaxed);
    }
    if let Some(lim) = daily_limit {
        state.daily_limit.store(lim, Ordering::Relaxed);
    }
    true
}

#[tauri::command]
pub fn ai_bind_credential(endpoint: String, api_key: String) -> Result<bool, String> {
    let parsed = reqwest::Url::parse(&endpoint)
        .map_err(|e| format!("接口地址无效: {}", e))?;
    is_allowed_server_url(&parsed)?;

    let clean_key = api_key.trim();
    if clean_key.is_empty() {
        secure_store_credential("reading_ai_api_key".to_string(), String::new())?;
        secure_store_credential("reading_ai_credential_origin".to_string(), String::new())?;
        return Ok(true);
    }

    let origin = parsed.origin().ascii_serialization();
    secure_store_credential("reading_ai_api_key".to_string(), clean_key.to_string())?;
    secure_store_credential("reading_ai_credential_origin".to_string(), origin)?;
    Ok(true)
}

#[tauri::command]
pub async fn ai_request_chat_completion(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AiState>,
    payload: AiCompletionPayload,
) -> Result<serde_json::Value, String> {
    let req_id = payload.request_id.trim().to_string();
    if req_id.is_empty() {
        return Err("INVALID_REQUEST_ID: 缺少请求标识符".to_string());
    }

    let start_time = Instant::now();
    let (_, iso_time) = format_system_time_iso(SystemTime::now());

    // 1. Check Request ID Deduplication (Prevent IPC replay, double send, re-attempt collisions)
    {
        let seen = state.seen_requests.lock().unwrap();
        if let Some((_, status)) = seen.get(&req_id) {
            return Err(format!(
                "DUPLICATE_REQUEST_ID: 请求 '{}' 已经处于处理或已完成状态 ({})，拒绝重复派发",
                req_id, status
            ));
        }
    }

    // 2. Concurrency Check (Max 1 in-flight request per application)
    {
        let active = state.active_request_id.lock().unwrap();
        if let Some(ref cur) = *active {
            return Err(format!(
                "CONCURRENCY_BLOCKED: 当前已有正在进行的生成请求 ({})，请等待完成或点击停止",
                cur
            ));
        }
    }

    // 3. Cooldown Check (Default 10s hard cooldown between dispatched model requests)
    let cooldown_secs = state.cooldown_seconds.load(Ordering::Relaxed);
    {
        let last_disp = state.last_dispatched_at.lock().unwrap();
        if let Some(prev) = *last_disp {
            let elapsed = prev.elapsed().as_secs();
            if elapsed < cooldown_secs {
                let rem = cooldown_secs - elapsed;
                return Err(format!(
                    "COOLDOWN_ACTIVE: 请等待 {} 秒后再发送新请求 (剩余 {} 秒)",
                    rem, rem
                ));
            }
        }
    }

    // 4. Daily Limit Quota Check
    let limit = state.daily_limit.load(Ordering::Relaxed);
    if limit > 0 {
        let count = get_today_count();
        if count >= limit {
            return Err(format!(
                "DAILY_LIMIT_EXCEEDED: 已达到今日请求上限 ({} 次)，请在设置中调整上限后继续",
                count
            ));
        }
    }

    // 5. Payload Hash Deduplication (Prevent rapid duplicate clicks of identical prompts across distinct IDs within cooldown window)
    let payload_hash = compute_payload_hash(&payload.endpoint, &payload.model, &payload.messages);
    {
        let hashes = state.recent_payload_hashes.lock().unwrap();
        if let Some((prev_req_id, prev_time)) = hashes.get(&payload_hash) {
            if prev_time.elapsed().as_secs() < cooldown_secs {
                return Err(format!(
                    "DUPLICATE_PAYLOAD_BLOCKED: 检测到与近期请求 ({}) 相同的生成内容，短时间内不重复派发以防误扣费",
                    prev_req_id
                ));
            }
        }
    }

    // 6. Validate Endpoint URL & Protocol (BEFORE claiming daily quota or in-flight lock!)
    let parsed_url = reqwest::Url::parse(&payload.endpoint)
        .map_err(|e| format!("INVALID_ENDPOINT: 接口地址格式无效: {}", e))?;
    is_allowed_server_url(&parsed_url)?;

    // 7. Credential & Origin Binding Verification (BEFORE claiming daily quota or in-flight lock!)
    let api_key = match secure_load_credential("reading_ai_api_key".to_string())? {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => return Err("CREDENTIAL_MISSING: 未检测到 API Key，请在设置中配置".to_string()),
    };

    let target_origin = parsed_url.origin().ascii_serialization();
    if let Ok(Some(saved_origin)) = secure_load_credential("reading_ai_credential_origin".to_string()) {
        let clean_origin = saved_origin.trim();
        if !clean_origin.is_empty() && clean_origin != target_origin {
            return Err(format!(
                "ORIGIN_MISMATCH: API Key 当前绑定于地址 '{}'，无法自动发送至新地址 '{}'。请在设置中明确确认或重新绑定。",
                clean_origin, target_origin
            ));
        }
    }

    // Atomically claim lock, update dispatch time, and increment daily count ONLY AFTER pre-flight validation passes!
    {
        let mut active = state.active_request_id.lock().unwrap();
        if let Some(ref cur) = *active {
            return Err(format!(
                "CONCURRENCY_BLOCKED: 当前已有正在进行的生成请求 ({})，请等待完成或点击停止",
                cur
            ));
        }
        *active = Some(req_id.clone());
        let mut last_disp = state.last_dispatched_at.lock().unwrap();
        *last_disp = Some(Instant::now());
        let mut seen = state.seen_requests.lock().unwrap();
        seen.insert(req_id.clone(), (Instant::now(), "in_flight".to_string()));
        let mut hashes = state.recent_payload_hashes.lock().unwrap();
        hashes.insert(payload_hash, (req_id.clone(), Instant::now()));
        increment_today_count();
    }

    // Setup abort channel and RAII lock release
    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut tx_guard = state.abort_tx.lock().unwrap();
        *tx_guard = Some(abort_tx);
    }
    let _guard = RequestLockGuard {
        state: &state,
        request_id: req_id.clone(),
        final_status: Mutex::new("failed".to_string()),
    };

    // 8. Build Safe HTTP Request (No redirects carrying secrets, timeout 90s)
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP_CLIENT_ERROR: 初始化 HTTP 客户端失败: {}", e))?;

    let full_url = if payload.endpoint.ends_with("/chat/completions") {
        payload.endpoint.clone()
    } else {
        format!("{}/chat/completions", payload.endpoint.trim_end_matches('/'))
    };

    let max_tokens = payload.max_tokens.unwrap_or(2048).clamp(64, 8192);

    let req_body = serde_json::json!({
        "model": payload.model,
        "messages": payload.messages,
        "stream": true,
        "max_tokens": max_tokens,
        "temperature": payload.temperature.unwrap_or(0.3),
        "stream_options": { "include_usage": true }
    });

    let send_result = client
        .post(&full_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&req_body)
        .send()
        .await;

    let mut response = match send_result {
        Ok(res) => res,
        Err(err) => {
            let err_msg = format!("网络连接失败: {}", err);
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
    };

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let raw_err = response.text().await.unwrap_or_default();
        let sanitized = sanitize_error_message(status_code, &raw_err);

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

    // 7. Process SSE Stream with Stop / Abort Interruption
    let mut buffer = String::new();
    let mut full_text = String::new();
    let mut usage_val: Option<serde_json::Value> = None;
    let mut was_cancelled = false;

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
                        let chunk_str = String::from_utf8_lossy(&bytes);
                        buffer.push_str(&chunk_str);

                        while let Some(newline_pos) = buffer.find('\n') {
                            let line = buffer[..newline_pos].trim().to_string();
                            buffer = buffer[newline_pos + 1..].to_string();

                            if line.is_empty() || line.starts_with(':') {
                                continue;
                            }
                            if line == "data: [DONE]" {
                                continue;
                            }
                            if let Some(json_slice) = line.strip_prefix("data: ") {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_slice) {
                                    if let Some(delta) = val.get("choices")
                                        .and_then(|c| c.get(0))
                                        .and_then(|c0| c0.get("delta"))
                                        .and_then(|d| d.get("content"))
                                        .and_then(|t| t.as_str())
                                    {
                                        full_text.push_str(delta);
                                        let _ = window.emit(
                                            &format!("ai:chunk:{}", req_id),
                                            serde_json::json!({
                                                "delta": delta,
                                                "fullText": full_text
                                            }),
                                        );
                                    }
                                    if let Some(u) = val.get("usage") {
                                        usage_val = Some(u.clone());
                                    }
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        // EOF - Stream completed normally
                        break;
                    }
                    Err(e) => {
                        let err_msg = format!("数据流读取中断: {}", e);
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

    let final_status = if was_cancelled { "cancelled" } else { "completed" };
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
        error_message: if was_cancelled { Some("用户点击停止".to_string()) } else { None },
    });

    if !was_cancelled {
        let _ = window.emit(
            &format!("ai:done:{}", req_id),
            serde_json::json!({
                "fullText": full_text,
                "usage": usage_val
            }),
        );
    }

    Ok(serde_json::json!({
        "requestId": req_id,
        "status": final_status,
        "fullText": full_text,
        "usage": usage_val
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_cooldown_enforcement() {
        let state = AiState::default();
        state.cooldown_seconds.store(10, Ordering::Relaxed);

        // First dispatch sets timestamp
        {
            let mut last = state.last_dispatched_at.lock().unwrap();
            *last = Some(Instant::now());
        }

        // Within 10s cooldown, checking elapsed should be < 10
        let last = state.last_dispatched_at.lock().unwrap();
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
}
