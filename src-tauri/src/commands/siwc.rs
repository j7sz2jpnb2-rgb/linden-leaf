use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use crate::commands::ai::{
    ai_audit_terminal_message, ai_concurrency_blocked_msg, ai_cooldown_active_msg, ai_daily_limit_exceeded_msg,
    ai_duplicate_payload_blocked_msg, ai_duplicate_request_id_msg, ai_http_client_error_msg, ai_invalid_request_id_msg,
    ai_network_failure_msg, ai_stream_interrupted_msg, append_audit_entry, audit_local_rejection,
    compute_scoped_payload_hash, format_system_time_iso, get_today_count, increment_today_count, remaining_cooldown_ms,
    sanitize_error_message_localized, AiAuditEntry, AiCompletionPayload, AiRequestPurpose, AiState, ChatMessage,
    RequestLockGuard,
};
use crate::commands::ai_companion::{fill_random_bytes, generate_random_hex_token};
use crate::commands::security::{
    secure_delete_credential_internal, secure_load_credential_internal, secure_store_credential_internal,
};
use crate::commands::{is_en_locale, l10n};

const SIWC_AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const SIWC_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const SIWC_REVOKE_URL: &str = "https://auth.openai.com/api/accounts/oauth/revoke";
const SIWC_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const SIWC_RESOURCE: &str = "https://api.openai.com/v1";
const SIWC_SCOPE_DIRECT: &str = "chatgpt.tokens.use.direct";
const SIWC_FULL_SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const CRED_SIWC_CLIENT_ID: &str = "siwc_dynamic_client_id";
const CRED_SIWC_ACCESS_TOKEN: &str = "siwc_access_token";
const CRED_SIWC_REFRESH_TOKEN: &str = "siwc_refresh_token";
const CRED_SIWC_META: &str = "siwc_token_meta";

pub struct SiwcState {
    pub pending_cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
}

impl Default for SiwcState {
    fn default() -> Self {
        Self {
            pending_cancels: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SiwcHostRecord {
    pub ext_agent_host_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SiwcTokenMeta {
    pub email: Option<String>,
    pub name: Option<String>,
    pub plan_type: Option<String>,
    pub scopes: Vec<String>,
    pub has_direct_scope: bool,
    pub expires_at_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiwcStatusInfo {
    pub signed_in: bool,
    pub has_direct_scope: bool,
    pub email: Option<String>,
    pub name: Option<String>,
    pub plan_type: Option<String>,
    pub host_id: String,
    pub expires_at_ms: u64,
    pub token_expired: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiwcCompletionRequest {
    pub request_id: String,
    #[serde(default)]
    pub purpose: AiRequestPurpose,
    #[serde(default)]
    pub request_scope: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn get_or_create_host_id() -> String {
    let dir = crate::commands::fs::resolve_app_data_dir();
    let path = dir.join("siwc_host.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(rec) = serde_json::from_str::<SiwcHostRecord>(&raw) {
            if rec.ext_agent_host_id.starts_with("urn:uuid:") && rec.ext_agent_host_id.len() >= 40 {
                return rec.ext_agent_host_id;
            }
        }
    }
    let mut bytes = [0u8; 16];
    fill_random_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    let host_id = format!(
        "urn:uuid:{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    );
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(json) = serde_json::to_string_pretty(&SiwcHostRecord {
        ext_agent_host_id: host_id.clone(),
    }) {
        let _ = std::fs::write(&path, json);
    }
    host_id
}

pub fn compute_pkce_challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub fn decode_jwt_claims_unverified(jwt: &str) -> Option<serde_json::Value> {
    let payload_b64 = jwt.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload_b64))
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&decoded).ok()
}

pub fn build_authorize_url(
    client_id: &str,
    host_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    nonce: &str,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(SIWC_AUTHORIZE_URL).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        if client_id == "dynamic_agent_client" {
            q.append_pair("agent_name_hint", "Linden Leaf");
        }
        q.append_pair("ext_agent_host_id", host_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("scope", SIWC_FULL_SCOPE);
        q.append_pair("resource", SIWC_RESOURCE);
        q.append_pair("code_challenge", code_challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("state", state);
        q.append_pair("nonce", nonce);
    }
    Ok(url.to_string())
}

/// Converts Linden Leaf `ChatMessage` history into preview-compliant Responses API body (`store: false`, `stream: true`).
/// Strictly omits unsupported preview fields (`temperature`, `max_output_tokens`, `top_p`, `metadata`, `conversation`, etc.)
/// and puts system/developer instructions in top-level `instructions`.
pub fn build_siwc_responses_body(model: &str, messages: &[ChatMessage]) -> serde_json::Value {
    let mut sys_parts: Vec<String> = Vec::new();
    let mut input_items: Vec<serde_json::Value> = Vec::new();

    for m in messages {
        let clean = m.content.trim();
        if clean.is_empty() {
            continue;
        }
        match m.role.as_str() {
            "system" | "developer" => sys_parts.push(clean.to_string()),
            "assistant" => input_items.push(serde_json::json!({
                "role": "assistant",
                "content": clean
            })),
            _ => input_items.push(serde_json::json!({
                "role": "user",
                "content": clean
            })),
        }
    }

    let mut obj = serde_json::Map::new();
    obj.insert("model".to_string(), serde_json::Value::String(model.trim().to_string()));
    if !sys_parts.is_empty() {
        obj.insert("instructions".to_string(), serde_json::Value::String(sys_parts.join("\n\n")));
    }
    obj.insert("input".to_string(), serde_json::Value::Array(input_items));
    obj.insert("store".to_string(), serde_json::Value::Bool(false));
    obj.insert("stream".to_string(), serde_json::Value::Bool(true));
    serde_json::Value::Object(obj)
}

#[derive(Default, Debug)]
pub struct SiwcStreamUpdate {
    pub delta: Option<String>,
    pub done: bool,
    pub incomplete_reason: Option<String>,
    pub usage: Option<serde_json::Value>,
}

pub fn apply_responses_stream_line(line: &str, full_text: &mut String) -> Result<SiwcStreamUpdate, String> {
    let trimmed = line.trim();
    let Some(data) = trimmed.strip_prefix("data:") else {
        return Ok(SiwcStreamUpdate::default());
    };
    let payload = data.trim_start();
    if payload == "[DONE]" {
        return Ok(SiwcStreamUpdate {
            done: true,
            ..Default::default()
        });
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Ok(SiwcStreamUpdate::default());
    };
    let ev_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ev_type == "error" || val.get("error").filter(|v| !v.is_null()).is_some() {
        let msg = val
            .pointer("/error/message")
            .or_else(|| val.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("Responses API error");
        return Err(msg.to_string());
    }
    if ev_type == "response.output_text.delta" {
        if let Some(delta) = val.get("delta").and_then(|v| v.as_str()) {
            if !delta.is_empty() {
                full_text.push_str(delta);
                return Ok(SiwcStreamUpdate {
                    delta: Some(delta.to_string()),
                    ..Default::default()
                });
            }
        }
    }
    if ev_type == "response.failed" {
        let msg = val
            .pointer("/response/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("ChatGPT response failed");
        return Err(msg.to_string());
    }
    if ev_type == "response.incomplete" {
        let reason = val
            .pointer("/response/incomplete_details/reason")
            .and_then(|v| v.as_str())
            .unwrap_or("max_output_tokens")
            .to_string();
        return Ok(SiwcStreamUpdate {
            done: true,
            incomplete_reason: Some(reason),
            usage: val.pointer("/response/usage").cloned(),
            ..Default::default()
        });
    }
    if ev_type == "response.completed" {
        return Ok(SiwcStreamUpdate {
            done: true,
            usage: val.pointer("/response/usage").cloned(),
            ..Default::default()
        });
    }
    Ok(SiwcStreamUpdate::default())
}

fn store_token_bundle(app: &tauri::AppHandle, token_json: &serde_json::Value) -> Result<SiwcTokenMeta, String> {
    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Missing access_token in OAuth token response".to_string())?;

    let scope_str = token_json.get("scope").and_then(|v| v.as_str()).unwrap_or("");
    let scopes: Vec<String> = scope_str.split_whitespace().map(str::to_string).collect();
    let has_direct_scope = scopes.iter().any(|s| s == SIWC_SCOPE_DIRECT);

    let id_claims = token_json
        .get("id_token")
        .and_then(|v| v.as_str())
        .and_then(decode_jwt_claims_unverified);
    let access_claims = decode_jwt_claims_unverified(access_token);

    let client_id = token_json
        .get("client_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            access_claims
                .as_ref()
                .and_then(|c| c.get("client_id").or_else(|| c.get("azp")))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .or_else(|| {
            id_claims
                .as_ref()
                .and_then(|c| c.get("aud"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });

    let email = id_claims
        .as_ref()
        .and_then(|c| c.get("email"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let name = id_claims
        .as_ref()
        .and_then(|c| c.get("name"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let plan_type = id_claims
        .as_ref()
        .and_then(|c| c.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let expires_in = token_json.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    let meta = SiwcTokenMeta {
        email,
        name,
        plan_type,
        scopes,
        has_direct_scope,
        expires_at_ms: now_epoch_ms().saturating_add(expires_in.saturating_mul(1000)),
    };

    secure_store_credential_internal(app.clone(), CRED_SIWC_ACCESS_TOKEN.to_string(), access_token.to_string())?;
    if let Some(ref_tok) = token_json.get("refresh_token").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        secure_store_credential_internal(app.clone(), CRED_SIWC_REFRESH_TOKEN.to_string(), ref_tok.to_string())?;
    }
    if let Some(cid) = client_id.filter(|s| !s.is_empty() && s != "dynamic_agent_client") {
        secure_store_credential_internal(app.clone(), CRED_SIWC_CLIENT_ID.to_string(), cid)?;
    }
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    secure_store_credential_internal(app.clone(), CRED_SIWC_META.to_string(), meta_json)?;
    Ok(meta)
}

async fn ensure_fresh_access_token(
    app: &tauri::AppHandle,
    siwc_state: &SiwcState,
    en: bool,
) -> Result<(String, SiwcTokenMeta), String> {
    let access_opt = secure_load_credential_internal(app.clone(), CRED_SIWC_ACCESS_TOKEN.to_string()).unwrap_or(None);
    let meta_raw = secure_load_credential_internal(app.clone(), CRED_SIWC_META.to_string()).unwrap_or(None);
    let meta: SiwcTokenMeta = meta_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let needs_refresh = access_opt
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
        || meta.expires_at_ms <= now_epoch_ms().saturating_add(60_000);

    if !needs_refresh {
        if !meta.has_direct_scope {
            return Err(l10n(
                en,
                "当前 ChatGPT 登录授权缺少套餐直连权限 (chatgpt.tokens.use.direct)，请重新授权。",
                "Current ChatGPT authorization lacks plan direct-usage scope (chatgpt.tokens.use.direct). Please re-authorize.",
            )
            .to_string());
        }
        return Ok((access_opt.unwrap(), meta));
    }

    let _refresh_guard = siwc_state.refresh_lock.lock().await;
    // Re-check once lock is acquired so concurrent requests don't double-refresh.
    let rechecked_access = secure_load_credential_internal(app.clone(), CRED_SIWC_ACCESS_TOKEN.to_string()).unwrap_or(None);
    let rechecked_meta_raw = secure_load_credential_internal(app.clone(), CRED_SIWC_META.to_string()).unwrap_or(None);
    let rechecked_meta: SiwcTokenMeta = rechecked_meta_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    if let Some(tok) = rechecked_access.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if rechecked_meta.expires_at_ms > now_epoch_ms().saturating_add(60_000) {
            if !rechecked_meta.has_direct_scope {
                return Err(l10n(
                    en,
                    "当前 ChatGPT 登录授权缺少套餐直连权限 (chatgpt.tokens.use.direct)，请重新授权。",
                    "Current ChatGPT authorization lacks plan direct-usage scope (chatgpt.tokens.use.direct). Please re-authorize.",
                )
                .to_string());
            }
            return Ok((tok.to_string(), rechecked_meta));
        }
    }

    let refresh_tok = secure_load_credential_internal(app.clone(), CRED_SIWC_REFRESH_TOKEN.to_string())
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            l10n(
                en,
                "未登录 ChatGPT 账号或授权已过期，请在设置中点击登录。",
                "Not signed in with ChatGPT or session expired. Please sign in from Settings.",
            )
            .to_string()
        })?;

    let client_id = secure_load_credential_internal(app.clone(), CRED_SIWC_CLIENT_ID.to_string())
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            l10n(
                en,
                "缺少 ChatGPT 动态客户端标识，请重新登录。",
                "Missing ChatGPT dynamic client registration ID. Please sign in again.",
            )
            .to_string()
        })?;

    let host_id = get_or_create_host_id();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(SIWC_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_tok.as_str()),
            ("client_id", client_id.as_str()),
            ("ext_agent_host_id", host_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh network error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let _ = secure_delete_credential_internal(app.clone(), CRED_SIWC_ACCESS_TOKEN.to_string());
        if status == 400 || status == 401 || status == 403 {
            let _ = secure_delete_credential_internal(app.clone(), CRED_SIWC_REFRESH_TOKEN.to_string());
        }
        return Err(l10n(
            en,
            "ChatGPT 登录凭据已失效或被撤销，请重新授权登录。",
            "ChatGPT authorization expired or revoked. Please sign in again.",
        )
        .to_string());
    }

    let token_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let next_meta = store_token_bundle(app, &token_json)?;
    if !next_meta.has_direct_scope {
        return Err(l10n(
            en,
            "刷新后的授权缺少 chatgpt.tokens.use.direct 权限，无法调用套餐额度。",
            "Refreshed authorization does not include chatgpt.tokens.use.direct scope.",
        )
        .to_string());
    }
    let fresh_access = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((fresh_access, next_meta))
}

#[tauri::command]
pub fn siwc_get_status(app: tauri::AppHandle) -> SiwcStatusInfo {
    let host_id = get_or_create_host_id();
    let access_ok = secure_load_credential_internal(app.clone(), CRED_SIWC_ACCESS_TOKEN.to_string())
        .ok()
        .flatten()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let refresh_ok = secure_load_credential_internal(app.clone(), CRED_SIWC_REFRESH_TOKEN.to_string())
        .ok()
        .flatten()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let meta: SiwcTokenMeta = secure_load_credential_internal(app, CRED_SIWC_META.to_string())
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    SiwcStatusInfo {
        signed_in: access_ok || refresh_ok,
        has_direct_scope: meta.has_direct_scope,
        email: meta.email,
        name: meta.name,
        plan_type: meta.plan_type,
        host_id,
        expires_at_ms: meta.expires_at_ms,
        token_expired: meta.expires_at_ms > 0 && meta.expires_at_ms <= now_epoch_ms(),
        error: None,
    }
}

#[tauri::command]
pub async fn siwc_sign_out(app: tauri::AppHandle) -> SiwcStatusInfo {
    let refresh_tok = secure_load_credential_internal(app.clone(), CRED_SIWC_REFRESH_TOKEN.to_string())
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());
    let client_id = secure_load_credential_internal(app.clone(), CRED_SIWC_CLIENT_ID.to_string())
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty());

    if let (Some(tok), Some(cid)) = (refresh_tok, client_id) {
        if let Ok(client) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            let _ = client
                .post(SIWC_REVOKE_URL)
                .form(&[("token", tok.as_str()), ("client_id", cid.as_str())])
                .send()
                .await;
        }
    }

    for k in [
        CRED_SIWC_ACCESS_TOKEN,
        CRED_SIWC_REFRESH_TOKEN,
        CRED_SIWC_META,
        CRED_SIWC_CLIENT_ID,
    ] {
        let _ = secure_delete_credential_internal(app.clone(), k.to_string());
    }
    siwc_get_status(app)
}

#[tauri::command]
pub fn siwc_cancel_sign_in(state: tauri::State<'_, SiwcState>, session_id: String) -> bool {
    let g = state.pending_cancels.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(flag) = g.get(&session_id) {
        flag.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn siwc_start_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, SiwcState>,
    session_id: String,
    locale: Option<String>,
) -> Result<SiwcStatusInfo, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let en = is_en_locale(locale.as_deref());
    let clean_sid = session_id.trim().to_string();
    if clean_sid.is_empty() {
        return Err("Missing sessionId".to_string());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut g = state.pending_cancels.lock().unwrap_or_else(|e| e.into_inner());
        g.insert(clean_sid.clone(), cancel_flag.clone());
    }
    struct Guard<'a>(&'a SiwcState, String);
    impl<'a> Drop for Guard<'a> {
        fn drop(&mut self) {
            if let Ok(mut g) = self.0.pending_cancels.lock() {
                g.remove(&self.1);
            }
        }
    }
    let _guard = Guard(&state, clean_sid);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local loopback port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let mut verifier_bytes = [0u8; 48];
    fill_random_bytes(&mut verifier_bytes);
    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);
    let code_challenge = compute_pkce_challenge_s256(&code_verifier);
    let oauth_state = generate_random_hex_token(16);
    let nonce = generate_random_hex_token(16);
    let host_id = get_or_create_host_id();

    let saved_client_id = secure_load_credential_internal(app.clone(), CRED_SIWC_CLIENT_ID.to_string())
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "dynamic_agent_client".to_string());

    let auth_url = build_authorize_url(
        &saved_client_id,
        &host_id,
        &redirect_uri,
        &code_challenge,
        &oauth_state,
        &nonce,
    )?;

    let _ = crate::commands::window::shell_open_external(app.clone(), auth_url).await?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    let auth_code: Option<String>;

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(l10n(en, "已取消 ChatGPT 登录", "ChatGPT sign-in cancelled").to_string());
        }
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if rem.is_zero() {
            return Err(l10n(en, "等待 ChatGPT 授权回调超时", "Timed out waiting for ChatGPT authorization").to_string());
        }
        let step = rem.min(std::time::Duration::from_millis(250));
        match tokio::time::timeout(step, listener.accept()).await {
            Ok(Ok((mut stream, _))) => {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    continue;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
                if path.starts_with("/favicon.ico") {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    continue;
                }
                let parsed = reqwest::Url::parse(&format!("http://127.0.0.1:{}{}", port, path)).ok();
                let mut cb_code = None;
                let mut cb_state = None;
                let mut cb_err = None;
                if let Some(u) = parsed {
                    for (k, v) in u.query_pairs() {
                        match k.as_ref() {
                            "code" => cb_code = Some(v.into_owned()),
                            "state" => cb_state = Some(v.into_owned()),
                            "error" => cb_err = Some(v.into_owned()),
                            _ => {}
                        }
                    }
                }
                let ok_cb = cb_code.is_some() && cb_err.is_none() && cb_state.as_deref() == Some(&oauth_state);
                let html = crate::commands::sync::sync_oauth_html_body(en, ok_cb);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.flush().await;

                if !ok_cb {
                    return Err(l10n(
                        en,
                        "ChatGPT 授权未完成或校验失败",
                        "ChatGPT authorization failed or state mismatch",
                    )
                    .to_string());
                }
                auth_code = cb_code;
                break;
            }
            Ok(Err(e)) => return Err(e.to_string()),
            Err(_) => {}
        }
    }

    let code = auth_code.ok_or_else(|| "Missing authorization code".to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let token_resp = client
        .post(SIWC_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", saved_client_id.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("ext_agent_host_id", host_id.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {e}"))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status().as_u16();
        let body = token_resp.text().await.unwrap_or_default();
        return Err(sanitize_error_message_localized(status, &body, locale.as_deref()));
    }

    let token_json: serde_json::Value = token_resp.json().await.map_err(|e| e.to_string())?;
    if let Some(id_tok) = token_json.get("id_token").and_then(|v| v.as_str()) {
        if let Some(claims) = decode_jwt_claims_unverified(id_tok) {
            if let Some(id_nonce) = claims.get("nonce").and_then(|v| v.as_str()) {
                if id_nonce != nonce {
                    return Err(l10n(
                        en,
                        "ChatGPT 授权响应校验失败（nonce 不匹配），请重试登录。",
                        "ChatGPT authorization response validation failed (nonce mismatch). Please sign in again.",
                    )
                    .to_string());
                }
            }
        }
    }
    let meta = store_token_bundle(&app, &token_json)?;
    if !meta.has_direct_scope {
        return Err(l10n(
            en,
            "您的账号未授予 chatgpt.tokens.use.direct 直连套餐权限，无法在第三方阅读器直接使用套餐额度。",
            "Account did not grant chatgpt.tokens.use.direct plan usage scope.",
        )
        .to_string());
    }
    Ok(siwc_get_status(app))
}

#[tauri::command]
pub async fn ai_request_siwc_completion(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AiState>,
    siwc_state: tauri::State<'_, SiwcState>,
    payload: SiwcCompletionRequest,
) -> Result<serde_json::Value, String> {
    let en = is_en_locale(payload.locale.as_deref());
    let req_id = payload.request_id.trim().to_string();
    if req_id.is_empty() {
        return Err(ai_invalid_request_id_msg(en).to_string());
    }

    let audit_proxy = AiCompletionPayload {
        request_id: req_id.clone(),
        purpose: payload.purpose,
        request_scope: payload.request_scope.clone(),
        locale: payload.locale.clone(),
        endpoint: SIWC_RESPONSES_URL.to_string(),
        model: payload.model.clone(),
        messages: payload.messages.clone(),
        max_tokens: None,
        temperature: None,
    };

    let start_time = Instant::now();
    let (_, iso_time) = format_system_time_iso(SystemTime::now());

    {
        let seen = state.seen_requests.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, status)) = seen.get(&req_id) {
            return Err(ai_duplicate_request_id_msg(en, &req_id, status));
        }
    }
    {
        let active = state.active_request_id.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref cur) = *active {
            return Err(audit_local_rejection(
                &audit_proxy,
                &req_id,
                start_time,
                "concurrency_blocked",
                ai_concurrency_blocked_msg(en, cur),
            ));
        }
    }

    let cooldown_secs = payload.purpose.cooldown_seconds(state.cooldown_seconds.load(Ordering::Relaxed));
    let remaining_ms = {
        let last_disp = state.last_chat_dispatched_at.lock().unwrap_or_else(|p| p.into_inner());
        last_disp
            .map(|prev| remaining_cooldown_ms(cooldown_secs, prev.elapsed()))
            .unwrap_or(0)
    };
    if remaining_ms > 0 {
        return Err(audit_local_rejection(
            &audit_proxy,
            &req_id,
            start_time,
            "cooldown_blocked",
            ai_cooldown_active_msg(en, remaining_ms),
        ));
    }

    let limit = state.daily_limit.load(Ordering::Relaxed);
    if limit > 0 {
        let count = get_today_count();
        if count >= limit {
            return Err(ai_daily_limit_exceeded_msg(en, count));
        }
    }

    let payload_hash = compute_scoped_payload_hash(
        SIWC_RESPONSES_URL,
        &payload.model,
        &payload.messages,
        payload.request_scope.as_deref(),
    );
    {
        let hashes = state.recent_payload_hashes.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((prev_req_id, prev_time)) = hashes.get(&payload_hash) {
            if prev_time.elapsed().as_secs() < cooldown_secs {
                return Err(ai_duplicate_payload_blocked_msg(en, prev_req_id));
            }
        }
    }

    // Never fall back silently to a billed API key! Fail loudly if SIWC OAuth isn't authorized.
    let (access_token, _meta) = ensure_fresh_access_token(&window.app_handle(), &siwc_state, en).await?;

    let (abort_tx, mut abort_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut active = state.active_request_id.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref cur) = *active {
            return Err(audit_local_rejection(
                &audit_proxy,
                &req_id,
                start_time,
                "concurrency_blocked",
                ai_concurrency_blocked_msg(en, cur),
            ));
        }
        let mut tx_guard = state.abort_tx.lock().unwrap_or_else(|e| e.into_inner());
        let mut last_disp = state.last_chat_dispatched_at.lock().unwrap_or_else(|p| p.into_inner());
        *active = Some(req_id.clone());
        *tx_guard = Some((req_id.clone(), abort_tx));
        if payload.purpose == AiRequestPurpose::Chat {
            *last_disp = Some(Instant::now());
        }
        state
            .seen_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(req_id.clone(), (Instant::now(), "in_flight".to_string()));
        if payload.purpose == AiRequestPurpose::Chat {
            state
                .recent_payload_hashes
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(payload_hash, (req_id.clone(), Instant::now()));
        }
    }
    let _guard = RequestLockGuard {
        state: &state,
        request_id: req_id.clone(),
        final_status: Mutex::new("failed".to_string()),
    };

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| ai_http_client_error_msg(en, &e))?;

    let req_body = build_siwc_responses_body(&payload.model, &payload.messages);
    let host_id = get_or_create_host_id();
    let send_future = client
        .post(SIWC_RESPONSES_URL)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("X-Client-Host-Id", host_id)
        .json(&req_body)
        .send();

    let mut response = tokio::select! {
        _ = &mut abort_rx => {
            if let Ok(mut s) = _guard.final_status.lock() { *s = "cancelled".to_string(); }
            let _ = window.emit(&format!("ai:stopped:{}", req_id), serde_json::json!({ "partialText": "" }));
            return Ok(serde_json::json!({ "stopped": true, "partialText": "" }));
        }
        res = send_future => {
            match res {
                Ok(r) => r,
                Err(err) => {
                    let msg = ai_network_failure_msg(en, &err);
                    append_audit_entry(AiAuditEntry {
                        id: format!("audit_{}", req_id),
                        timestamp: iso_time,
                        request_id: req_id.clone(),
                        model: payload.model.clone(),
                        endpoint_host: "chatgpt-plan/api.openai.com".to_string(),
                        status: "failed".to_string(),
                        prompt_tokens: None,
                        completion_tokens: None,
                        total_tokens: None,
                        duration_ms: start_time.elapsed().as_millis(),
                        error_message: Some(msg.clone()),
                    });
                    let _ = window.emit(&format!("ai:error:{}", req_id), serde_json::json!({ "status": 0, "message": msg }));
                    return Err(msg);
                }
            }
        }
    };

    if !response.status().is_success() {
        let code = response.status().as_u16();
        let raw = response.text().await.unwrap_or_default();
        let msg = if code == 429 || raw.contains("usage_limit") || raw.contains("insufficient_quota") {
            l10n(
                en,
                "ChatGPT 套餐当前可用额度已达上限或触发限流，已立即停止（不会切换或消耗付费 API）。",
                "ChatGPT plan quota or rate limit reached. Request stopped immediately (will not fall back to billed API).",
            )
            .to_string()
        } else {
            sanitize_error_message_localized(code, &raw, payload.locale.as_deref())
        };
        append_audit_entry(AiAuditEntry {
            id: format!("audit_{}", req_id),
            timestamp: iso_time,
            request_id: req_id.clone(),
            model: payload.model.clone(),
            endpoint_host: "chatgpt-plan/api.openai.com".to_string(),
            status: "failed".to_string(),
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            duration_ms: start_time.elapsed().as_millis(),
            error_message: Some(msg.clone()),
        });
        let _ = window.emit(&format!("ai:error:{}", req_id), serde_json::json!({ "status": code, "message": msg }));
        return Err(msg);
    }

    increment_today_count();

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
                let _ = window.emit(&format!("ai:stopped:{}", req_id), serde_json::json!({ "partialText": full_text }));
                break;
            }
            chunk_res = response.chunk() => {
                match chunk_res {
                    Ok(Some(bytes)) => {
                        byte_buffer.extend_from_slice(&bytes);
                        while let Some(pos) = byte_buffer.iter().position(|&b| b == b'\n') {
                            let line = String::from_utf8_lossy(&byte_buffer[..pos]).trim().to_string();
                            byte_buffer.drain(..=pos);
                            match apply_responses_stream_line(&line, &mut full_text) {
                                Ok(upd) => {
                                    received_done |= upd.done;
                                    if upd.usage.is_some() { usage_val = upd.usage; }
                                    if upd.incomplete_reason.is_some() { finish_reason = Some("length".to_string()); }
                                    if let Some(delta) = upd.delta {
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
                        if !byte_buffer.is_empty() {
                            let trailing = String::from_utf8_lossy(&byte_buffer).trim().to_string();
                            byte_buffer.clear();
                            if let Ok(upd) = apply_responses_stream_line(&trailing, &mut full_text) {
                                received_done |= upd.done;
                                if upd.usage.is_some() { usage_val = upd.usage; }
                                if let Some(delta) = upd.delta {
                                    let _ = window.emit(&format!("ai:chunk:{}", req_id), serde_json::json!({ "delta": delta }));
                                }
                            }
                        }
                        break;
                    }
                    Err(e) => {
                        has_stream_error = true;
                        let err_msg = ai_stream_interrupted_msg(en, &e);
                        last_stream_error = Some(err_msg.clone());
                        let _ = window.emit(&format!("ai:error:{}", req_id), serde_json::json!({ "status": 500, "message": err_msg }));
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
    } else if received_done || !full_text.is_empty() {
        if finish_reason.as_deref() == Some("length") {
            "partial"
        } else {
            "completed"
        }
    } else {
        "partial"
    };

    if let Ok(mut s) = _guard.final_status.lock() {
        *s = final_status.to_string();
    }

    let prompt_tokens = usage_val.as_ref().and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64());
    let completion_tokens = usage_val.as_ref().and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64());
    let total_tokens = usage_val.as_ref().and_then(|u| u.get("total_tokens")).and_then(|v| v.as_u64());

    append_audit_entry(AiAuditEntry {
        id: format!("audit_{}", req_id),
        timestamp: iso_time,
        request_id: req_id.clone(),
        model: payload.model.clone(),
        endpoint_host: "chatgpt-plan/api.openai.com".to_string(),
        status: final_status.to_string(),
        prompt_tokens,
        completion_tokens,
        total_tokens,
        duration_ms: start_time.elapsed().as_millis(),
        error_message: last_stream_error.clone().or_else(|| {
            ai_audit_terminal_message(en, was_cancelled, has_stream_error, final_status)
        }),
    });

    if was_cancelled {
        return Ok(serde_json::json!({ "stopped": true, "partialText": full_text }));
    }
    if has_stream_error {
        return Err(last_stream_error.unwrap_or_else(|| "SIWC stream failed".to_string()));
    }

    let norm_usage = usage_val.map(|u| {
        serde_json::json!({
            "prompt_tokens": u.get("input_tokens").and_then(|v| v.as_u64()),
            "completion_tokens": u.get("output_tokens").and_then(|v| v.as_u64()),
            "total_tokens": u.get("total_tokens").and_then(|v| v.as_u64()),
        })
    });

    let done_payload = serde_json::json!({
        "fullText": full_text,
        "status": final_status,
        "finishReason": finish_reason,
        "usage": norm_usage,
    });
    let _ = window.emit(&format!("ai:done:{}", req_id), done_payload.clone());
    Ok(done_payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_s256_vector_and_authorize_url() {
        // RFC 7636 Appendix B test vector
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(compute_pkce_challenge_s256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

        let url = build_authorize_url(
            "dynamic_agent_client",
            "urn:uuid:00000000-0000-4000-8000-000000000001",
            "http://127.0.0.1:45678/callback",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "state123",
            "nonce123",
        )
        .unwrap();
        assert!(url.contains("client_id=dynamic_agent_client"));
        assert!(url.contains("agent_name_hint=Linden+Leaf") || url.contains("agent_name_hint=Linden%20Leaf"));
        assert!(url.contains("chatgpt.tokens.use.direct"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn test_responses_body_strict_preview_compliance() {
        let msgs = vec![
            ChatMessage { role: "system".to_string(), content: "You are helpful".to_string() },
            ChatMessage { role: "user".to_string(), content: "Explain this".to_string() },
        ];
        let body = build_siwc_responses_body("gpt-5-codex", &msgs);
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "You are helpful");
        assert!(body.get("temperature").is_none());
        assert!(body.get("max_output_tokens").is_none());
        assert!(body.get("top_p").is_none());
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_responses_sse_stream_delta_and_completion() {
        let mut text = String::new();
        let u1 = apply_responses_stream_line(
            r#"data: {"type":"response.output_text.delta","delta":"Hello "}"#,
            &mut text,
        )
        .unwrap();
        assert_eq!(u1.delta.as_deref(), Some("Hello "));
        let u2 = apply_responses_stream_line(
            r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}"#,
            &mut text,
        )
        .unwrap();
        assert!(u2.done);
        assert_eq!(text, "Hello ");
    }
}
