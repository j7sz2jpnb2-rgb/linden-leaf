use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub enabled: Option<bool>,
    pub server_type: Option<String>,
    pub server_url: Option<String>,
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub has_password: Option<bool>,
    #[serde(default)]
    pub _pwd_encrypted: Option<bool>,
    pub remote_dir: Option<String>,
    pub auto_sync_on_startup: Option<bool>,
    pub auto_sync_on_book_close: Option<bool>,
    pub last_sync_time: Option<serde_json::Value>,
    pub last_sync_status: Option<serde_json::Value>,
    #[serde(default)]
    pub credential_origin: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteSyncResponse {
    pub success: bool,
    pub exists: bool,
    pub data: Option<serde_json::Value>,
    pub etag: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SaveRemoteResponse {
    pub success: bool,
    pub etag: Option<String>,
    #[serde(rename = "isConflict")]
    pub is_conflict: Option<bool>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BookBinaryResponse {
    pub success: bool,
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    pub size: Option<usize>,
    pub buffer: Option<Vec<u8>>,
    pub error: Option<String>,
}

fn get_sync_config_path() -> PathBuf {
    let mut dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lindenleaf.reader");
    let _ = fs::create_dir_all(&dir);
    dir.push("sync-config.json");
    dir
}

// Windows DPAPI encryption helper
#[cfg(target_os = "windows")]
fn encrypt_password(plain: &str) -> Result<String, String> {
    use std::ptr;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    if plain.is_empty() {
        return Ok(String::new());
    }

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    unsafe {
        if CryptProtectData(
            &mut in_blob,
            None,
            None,
            None,
            None,
            0,
            &mut out_blob,
        )
        .is_ok()
        {
            let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
            let b64 = base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                slice,
            );
            LocalFree(windows::Win32::Foundation::HLOCAL(out_blob.pbData as _));
            Ok(b64)
        } else {
            Err("DPAPI encryption failed".to_string())
        }
    }
}

#[allow(dead_code)]
#[cfg(not(target_os = "windows"))]
fn encrypt_password(_plain: &str) -> Result<String, String> {
    // Base64 encoding is not encryption and must never be used to store credentials on disk.
    // On Android/mobile/Linux, a platform Keystore or Keyring bridge is required.
    Err("Safe credential storage (Keystore) is not yet configured for this platform. Credentials cannot be persisted to disk safely.".to_string())
}

#[cfg(target_os = "windows")]
fn decrypt_password(cipher_b64: &str) -> Result<String, String> {
    use std::ptr;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    if cipher_b64.is_empty() {
        return Ok(String::new());
    }

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cipher_b64)
        .map_err(|e| e.to_string())?;

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    unsafe {
        if CryptUnprotectData(
            &mut in_blob,
            None,
            None,
            None,
            None,
            0,
            &mut out_blob,
        )
        .is_ok()
        {
            let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
            let s = String::from_utf8_lossy(slice).to_string();
            LocalFree(windows::Win32::Foundation::HLOCAL(out_blob.pbData as _));
            Ok(s)
        } else {
            Err("DPAPI decryption failed".to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn decrypt_password(_cipher_b64: &str) -> Result<String, String> {
    Err("Safe credential decryption is not supported on this platform without native Keystore.".to_string())
}

#[tauri::command]
pub fn sync_get_config() -> SyncConfig {
    let path = get_sync_config_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut cfg) = serde_json::from_str::<SyncConfig>(&content) {
            let has_pwd = cfg.password.as_ref().map(|p| !p.is_empty()).unwrap_or(false);
            cfg.has_password = Some(has_pwd);
            cfg.password = Some(String::new()); // Never leak plaintext password to renderer
            return cfg;
        }
    }
    SyncConfig {
        enabled: Some(false),
        server_type: Some("jianguoyun".to_string()),
        server_url: Some("https://dav.jianguoyun.com/dav/".to_string()),
        username: Some(String::new()),
        password: Some(String::new()),
        has_password: Some(false),
        _pwd_encrypted: Some(false),
        remote_dir: Some("LindenLeaf".to_string()),
        auto_sync_on_startup: Some(true),
        auto_sync_on_book_close: Some(true),
        last_sync_time: None,
        last_sync_status: None,
        credential_origin: None,
    }
}

#[tauri::command]
pub fn sync_reveal_password(#[allow(unused)] app_handle: tauri::AppHandle) -> String {
    #[cfg(target_os = "android")]
    {
        if let Ok(Some(secret)) = crate::commands::android::android_keystore_load(app_handle.clone(), "sync_webdav_password".to_string()) {
            if !secret.is_empty() {
                return secret;
            }
        }
    }
    let path = get_sync_config_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<SyncConfig>(&content) {
            if let Some(pwd) = cfg.password {
                if pwd.starts_with("__keystore:") {
                    #[cfg(target_os = "android")]
                    {
                        if let Ok(Some(secret)) = crate::commands::android::android_keystore_load(app_handle, "sync_webdav_password".to_string()) {
                            return secret;
                        }
                    }
                    return String::new();
                }
                if cfg._pwd_encrypted.unwrap_or(false) {
                    return decrypt_password(&pwd).unwrap_or_default();
                }
                return pwd;
            }
        }
    }
    String::new()
}

#[tauri::command]
pub fn sync_save_config(#[allow(unused)] app_handle: tauri::AppHandle, mut config: SyncConfig) -> bool {
    let path = get_sync_config_path();
    let existing_raw = fs::read_to_string(&path).ok();
    let existing_cfg: Option<SyncConfig> = existing_raw.and_then(|s| serde_json::from_str(&s).ok());

    // Preserve existing password if new one is empty
    if config.password.as_deref().unwrap_or("").is_empty() {
        if let Some(ref ext) = existing_cfg {
            config.password = ext.password.clone();
            config._pwd_encrypted = ext._pwd_encrypted;
            config.credential_origin = ext.credential_origin.clone();
        }
    } else if let Some(ref plain) = config.password {
        #[cfg(target_os = "android")]
        {
            match crate::commands::android::android_keystore_store(app_handle, "sync_webdav_password".to_string(), plain.clone()) {
                Ok(true) => {
                    config.password = Some("__keystore:sync_webdav_password__".to_string());
                    config._pwd_encrypted = Some(true);
                    let s_url = config.server_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/");
                    if let Ok(parsed) = reqwest::Url::parse(s_url) {
                        config.credential_origin = Some(parsed.origin().ascii_serialization());
                    }
                }
                _ => return false,
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            match encrypt_password(plain) {
                Ok(enc) => {
                    config.password = Some(enc);
                    config._pwd_encrypted = Some(true);
                    // Bind saved credential to target server origin
                    let s_url = config.server_url.as_deref().unwrap_or("https://dav.jianguoyun.com/dav/");
                    if let Ok(parsed) = reqwest::Url::parse(s_url) {
                        config.credential_origin = Some(parsed.origin().ascii_serialization());
                    }
                }
                Err(_) => {
                    // S1: Encryption failed: fail fast and do NOT save config or write plain text
                    return false;
                }
            }
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&config) {
        return fs::write(&path, json).is_ok();
    }
    false
}

// S5: Verify that the server URL uses HTTPS, or local/private network HTTP
pub fn is_allowed_server_url(url: &reqwest::Url) -> Result<(), String> {
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            let host_str = url.host_str().unwrap_or("");
            if host_str == "localhost" {
                return Ok(());
            }
            if let Ok(ip) = host_str.parse::<std::net::IpAddr>() {
                if ip.is_loopback() {
                    return Ok(());
                }
                match ip {
                    std::net::IpAddr::V4(ipv4) => {
                        if ipv4.is_private() {
                            return Ok(());
                        }
                    }
                    std::net::IpAddr::V6(_) => {}
                }
            }
            Err(format!(
                "Plain HTTP is only permitted for local or private intranet addresses (e.g. localhost, 127.0.0.1, 192.168.x.x). Host '{}' requires HTTPS for security.",
                host_str
            ))
        }
        other => Err(format!(
            "Unsupported protocol '{}': only HTTPS (and local HTTP) are permitted.",
            other
        )),
    }
}

// S4: Validate that a book filename is a single safe path segment
pub fn validate_book_filename(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Book filename cannot be empty".to_string());
    }
    if trimmed.len() > 255 {
        return Err(format!("Book filename exceeds maximum length of 255 characters (length: {})", trimmed.len()));
    }
    // Reject any path separators, traversal dots, control characters, or URL encoding markers
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('%')
        || trimmed.contains('?') || trimmed.contains('#')
        || trimmed.contains('\0') || trimmed.contains(':')
        || trimmed.contains('*') || trimmed.contains('"')
        || trimmed.contains('<') || trimmed.contains('>')
        || trimmed.contains('|')
    {
        return Err(format!("Book filename contains disallowed characters or path separators: '{}'", name));
    }
    if trimmed == "." || trimmed == ".." || trimmed.starts_with('.') {
        return Err(format!("Book filename cannot be or start with a dot segment: '{}'", name));
    }
    Ok(trimmed.to_string())
}

// S4 & S5: Construct safe WebDAV target URL without escaping remote directory
pub fn get_sync_url(config: &SyncConfig, sub_path: &str) -> Result<reqwest::Url, String> {
    let saved_cfg = if config.server_url.as_deref().unwrap_or("").is_empty() {
        Some(sync_get_config())
    } else {
        None
    };
    let base_str = config.server_url.as_deref().filter(|s| !s.is_empty())
        .or_else(|| saved_cfg.as_ref().and_then(|c| c.server_url.as_deref()))
        .unwrap_or("https://dav.jianguoyun.com/dav/");

    let base_url = reqwest::Url::parse(base_str)
        .map_err(|e| format!("Invalid base WebDAV server URL '{}': {}", base_str, e))?;

    is_allowed_server_url(&base_url)?;

    let dir_str = config.remote_dir.as_deref().filter(|s| !s.is_empty())
        .or_else(|| saved_cfg.as_ref().and_then(|c| c.remote_dir.as_deref()))
        .unwrap_or("LindenLeaf");

    let clean_dir = dir_str.trim().trim_matches('/');
    if clean_dir.contains("..") || clean_dir.contains('\\') || clean_dir.contains('%') {
        return Err(format!("Invalid remote directory: '{}'", dir_str));
    }

    let base_path = base_url.path().trim_end_matches('/').to_string();

    let mut segments = Vec::new();
    if !clean_dir.is_empty() {
        for seg in clean_dir.split('/') {
            let s = seg.trim();
            if !s.is_empty() {
                if s == "." || s == ".." {
                    return Err(format!("Directory segment cannot be dot: '{}'", s));
                }
                segments.push(s.to_string());
            }
        }
    }

    let sub_clean = sub_path.trim().trim_matches('/');
    if !sub_clean.is_empty() {
        for seg in sub_clean.split('/') {
            let s = seg.trim();
            if !s.is_empty() {
                if s == "." || s == ".." {
                    return Err(format!("Path segment cannot be dot: '{}'", s));
                }
                segments.push(s.to_string());
            }
        }
    }

    let mut final_url = base_url.clone();
    {
        let mut path_segs = final_url.path_segments_mut().map_err(|_| "Cannot mutate URL path segments".to_string())?;
        path_segs.pop_if_empty();
        for seg in &segments {
            path_segs.push(seg);
        }
    }

    // Security invariant: final URL origin MUST match base URL origin
    if final_url.origin() != base_url.origin() {
        return Err(format!(
            "URL security check failed: constructed URL origin '{}' differs from base origin '{}'",
            final_url.origin().ascii_serialization(),
            base_url.origin().ascii_serialization()
        ));
    }

    // Security invariant: final URL path MUST start with expected base path
    if !final_url.path().starts_with(&base_path) {
        return Err(format!(
            "URL security check failed: constructed path '{}' escaped base path '{}'",
            final_url.path(),
            base_path
        ));
    }

    Ok(final_url)
}

// S5: Origin verification for credentials
fn verify_credential_origin(config: &SyncConfig, saved_cfg: &SyncConfig) -> Result<(), String> {
    if let Some(ref req_url) = config.server_url {
        let trimmed = req_url.trim();
        if !trimmed.is_empty() {
            let parsed_req = reqwest::Url::parse(trimmed)
                .map_err(|e| format!("Invalid target server URL '{}': {}", trimmed, e))?;
            let req_origin = parsed_req.origin().ascii_serialization();

            let saved_origin = saved_cfg.credential_origin.clone()
                .or_else(|| {
                    saved_cfg.server_url.as_deref().and_then(|s| {
                        reqwest::Url::parse(s.trim()).ok().map(|u| u.origin().ascii_serialization())
                    })
                })
                .unwrap_or_else(|| "https://dav.jianguoyun.com".to_string());

            if req_origin != saved_origin {
                return Err(format!(
                    "Target server origin '{}' does not match saved credentials origin '{}'. Please provide credentials explicitly for the new server.",
                    req_origin, saved_origin
                ));
            }
        }
    }
    Ok(())
}

fn get_credentials(#[allow(unused)] app_handle: Option<&tauri::AppHandle>, config: &SyncConfig) -> Result<(String, String), String> {
    let saved_cfg = sync_get_config();
    let user = match config.username {
        Some(ref u) if !u.is_empty() => u.clone(),
        _ => saved_cfg.username.clone().unwrap_or_default(),
    };

    let pass = if let Some(ref p) = config.password {
        if !p.is_empty() && !p.starts_with("__keystore:") {
            p.clone()
        } else {
            verify_credential_origin(config, &saved_cfg)?;
            if let Some(handle) = app_handle {
                sync_reveal_password(handle.clone())
            } else {
                #[cfg(target_os = "windows")]
                {
                    if let Some(pwd) = saved_cfg.password {
                        if saved_cfg._pwd_encrypted.unwrap_or(false) {
                            decrypt_password(&pwd).unwrap_or_default()
                        } else {
                            pwd
                        }
                    } else {
                        String::new()
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    String::new()
                }
            }
        }
    } else {
        verify_credential_origin(config, &saved_cfg)?;
        if let Some(handle) = app_handle {
            sync_reveal_password(handle.clone())
        } else {
            #[cfg(target_os = "windows")]
            {
                if let Some(pwd) = saved_cfg.password {
                    if saved_cfg._pwd_encrypted.unwrap_or(false) {
                        decrypt_password(&pwd).unwrap_or_default()
                    } else {
                        pwd
                    }
                } else {
                    String::new()
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                String::new()
            }
        }
    };

    Ok((user, pass))
}

fn create_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many redirects (max 5)");
        }
        if let Some(prev) = attempt.previous().last() {
            if prev.scheme() == "https" && attempt.url().scheme() == "http" {
                return attempt.error("Disallowed insecure downgrade redirect from HTTPS to HTTP");
            }
            if prev.origin() != attempt.url().origin() {
                return attempt.error("Disallowed cross-origin redirect");
            }
        }
        attempt.follow()
    });

    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .redirect(redirect_policy)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

// S3: Response body reader with strict size limit and streaming accumulation
async fn read_response_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes as u64 {
            return Err(format!(
                "Content length ({} bytes) exceeds maximum permitted limit ({} bytes)",
                content_length, max_bytes
            ));
        }
    }

    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("Network read error: {}", e))? {
        if buffer.len() + chunk.len() > max_bytes {
            return Err(format!(
                "Response body exceeded maximum permitted limit of {} bytes",
                max_bytes
            ));
        }
        buffer.extend_from_slice(&chunk);
    }

    Ok(buffer)
}

async fn ensure_remote_dir(client: &reqwest::Client, dir_url: &reqwest::Url, user: &str, pass: &str) {
    let mut url_str = dir_url.to_string();
    if !url_str.ends_with('/') {
        url_str.push('/');
    }
    let _ = client
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url_str)
        .basic_auth(user, Some(pass))
        .send()
        .await;
}

#[tauri::command]
pub async fn sync_test_connection(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
) -> Result<serde_json::Value, String> {
    let client = create_http_client(10)?;

    let target_url = if let Some(ref url) = config.server_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            let u = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid server URL: {}", e))?;
            is_allowed_server_url(&u)?;
            u
        } else {
            get_sync_url(&config, "")?
        }
    } else {
        get_sync_url(&config, "")?
    };

    let (user, pass) = get_credentials(Some(&app_handle), &config)?;

    let res = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), target_url.as_str())
        .basic_auth(&user, Some(&pass))
        .header("Depth", "0")
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 207 => {
            if let Ok(dir_url) = get_sync_url(&config, "") {
                ensure_remote_dir(&client, &dir_url, &user, &pass).await;
            }
            Ok(serde_json::json!({
                "success": true,
                "message": "连接 WebDAV 服务器成功！远程应用目录已就绪。"
            }))
        }
        Ok(r) if r.status().as_u16() == 401 || r.status().as_u16() == 403 => {
            Ok(serde_json::json!({
                "success": false,
                "error": "认证失败：请检查坚果云/WebDAV账号与应用授权密码"
            }))
        }
        Ok(r) => Ok(serde_json::json!({
            "success": false,
            "error": format!("HTTP {}", r.status().as_u16())
        })),
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "error": e.to_string()
        })),
    }
}

#[tauri::command]
pub async fn sync_fetch_remote(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
) -> Result<RemoteSyncResponse, String> {
    let client = match create_http_client(15) {
        Ok(c) => c,
        Err(e) => return Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(e),
        }),
    };

    let url = match get_sync_url(&config, "linden_sync_data.json") {
        Ok(u) => u,
        Err(e) => return Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(e),
        }),
    };

    let (user, pass) = match get_credentials(Some(&app_handle), &config) {
        Ok(c) => c,
        Err(e) => return Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(e),
        }),
    };

    match client.get(url.as_str()).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() => {
            let etag = res.headers().get("etag").and_then(|h| h.to_str().ok()).map(|s| s.to_string());
            // Hard limit: 20 MB for sync JSON state
            match read_response_body_limited(res, 20 * 1024 * 1024).await {
                Ok(bytes) => {
                    match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(data) => Ok(RemoteSyncResponse {
                            success: true,
                            exists: true,
                            data: Some(data),
                            etag,
                            error: None,
                        }),
                        Err(e) => Ok(RemoteSyncResponse {
                            success: false,
                            exists: true,
                            data: None,
                            etag: None,
                            error: Some(format!("Failed to parse sync state JSON: {}", e)),
                        }),
                    }
                }
                Err(e) => Ok(RemoteSyncResponse {
                    success: false,
                    exists: true,
                    data: None,
                    etag: None,
                    error: Some(format!("Sync state download exceeded size limit: {}", e)),
                }),
            }
        }
        Ok(res) if res.status().as_u16() == 404 => Ok(RemoteSyncResponse {
            success: true,
            exists: false,
            data: None,
            etag: None,
            error: None,
        }),
        Ok(res) => Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_save_remote(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
    data: serde_json::Value,
    etag: Option<String>,
) -> Result<SaveRemoteResponse, String> {
    let client = match create_http_client(20) {
        Ok(c) => c,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e),
        }),
    };

    let url = match get_sync_url(&config, "linden_sync_data.json") {
        Ok(u) => u,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e),
        }),
    };

    let dir_url = match get_sync_url(&config, "") {
        Ok(u) => u,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e),
        }),
    };

    let (user, pass) = match get_credentials(Some(&app_handle), &config) {
        Ok(c) => c,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e),
        }),
    };

    ensure_remote_dir(&client, &dir_url, &user, &pass).await;

    let body = match serde_json::to_string(&data) {
        Ok(b) => b,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e.to_string()),
        }),
    };

    const MAX_SYNC_PAYLOAD_BYTES: usize = 20 * 1024 * 1024;
    if body.len() > MAX_SYNC_PAYLOAD_BYTES {
        return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(format!("PAYLOAD_TOO_LARGE: 同步数据大小 ({} 字节) 超出 20MiB 上限", body.len())),
        });
    }

    let mut req = client.put(url.as_str()).basic_auth(user, Some(pass)).header("Content-Type", "application/json");
    if let Some(ref tag) = etag {
        if !tag.is_empty() && !tag.starts_with("W/") {
            req = req.header("If-Match", tag.as_str());
        }
    } else {
        req = req.header("If-None-Match", "*");
    }

    match req.body(body).send().await {
        Ok(res) if res.status().is_success() => {
            let new_etag = res.headers().get("etag").and_then(|h| h.to_str().ok()).map(|s| s.to_string());
            Ok(SaveRemoteResponse {
                success: true,
                etag: new_etag,
                is_conflict: Some(false),
                error: None,
            })
        }
        Ok(res) if res.status().as_u16() == 412 => Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: Some(true),
            error: Some("Conflict (HTTP 412 Precondition Failed)".to_string()),
        }),
        Ok(res) => Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: Some(false),
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: Some(false),
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_upload_book_binary(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
    file_name: String,
    buffer: Vec<u8>,
) -> Result<BookBinaryResponse, String> {
    let safe_file_name = match validate_book_filename(&file_name) {
        Ok(n) => n,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let client = match create_http_client(60) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let url = match get_sync_url(&config, &format!("books/{}", safe_file_name)) {
        Ok(u) => u,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let base_dir_url = match get_sync_url(&config, "") {
        Ok(u) => u,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let books_dir_url = match get_sync_url(&config, "books") {
        Ok(u) => u,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let (user, pass) = match get_credentials(Some(&app_handle), &config) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    ensure_remote_dir(&client, &base_dir_url, &user, &pass).await;
    ensure_remote_dir(&client, &books_dir_url, &user, &pass).await;
    let size = buffer.len();

    match client.put(url.as_str()).basic_auth(user, Some(pass)).body(buffer).send().await {
        Ok(res) if res.status().is_success() => Ok(BookBinaryResponse {
            success: true,
            file_name: Some(safe_file_name),
            size: Some(size),
            buffer: None,
            error: None,
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_download_book_binary(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
    file_name: String,
) -> Result<BookBinaryResponse, String> {
    let safe_file_name = match validate_book_filename(&file_name) {
        Ok(n) => n,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let client = match create_http_client(60) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let url = match get_sync_url(&config, &format!("books/{}", safe_file_name)) {
        Ok(u) => u,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let (user, pass) = match get_credentials(Some(&app_handle), &config) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    match client.get(url.as_str()).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() => {
            // Hard limit: 300 MB for book binary
            match read_response_body_limited(res, 300 * 1024 * 1024).await {
                Ok(bytes) => {
                    let len = bytes.len();
                    Ok(BookBinaryResponse {
                        success: true,
                        file_name: Some(safe_file_name),
                        size: Some(len),
                        buffer: Some(bytes),
                        error: None,
                    })
                }
                Err(e) => Ok(BookBinaryResponse {
                    success: false,
                    file_name: Some(safe_file_name),
                    size: None,
                    buffer: None,
                    error: Some(format!("Book binary download failed size limit: {}", e)),
                }),
            }
        }
        Ok(res) if res.status().as_u16() == 404 => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some("404 Not Found".to_string()),
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_delete_book_binary(
    #[allow(unused)] app_handle: tauri::AppHandle,
    config: SyncConfig,
    file_name: String,
) -> Result<BookBinaryResponse, String> {
    let safe_file_name = match validate_book_filename(&file_name) {
        Ok(n) => n,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let client = match create_http_client(15) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let url = match get_sync_url(&config, &format!("books/{}", safe_file_name)) {
        Ok(u) => u,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    let (user, pass) = match get_credentials(Some(&app_handle), &config) {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e),
        }),
    };

    match client.delete(url.as_str()).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() || res.status().as_u16() == 404 => Ok(BookBinaryResponse {
            success: true,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: None,
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(safe_file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}

#[allow(dead_code)]
fn get_credentials_dir() -> PathBuf {
    let mut dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lindenleaf.reader");
    dir.push("credentials");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[allow(dead_code)]
fn sanitize_credential_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

#[tauri::command]
pub fn secure_store_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<bool, String> {
    if key.trim().is_empty() {
        return Err("Credential key cannot be empty".to_string());
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_store(app_handle, key, value)
    }
    #[cfg(not(target_os = "android"))]
    {
        let sanitized = sanitize_credential_key(&key);
        let mut file_path = get_credentials_dir();
        file_path.push(format!("{}.enc", sanitized));

        let encrypted = encrypt_password(&value)?;
        fs::write(&file_path, encrypted).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
pub fn secure_load_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    if key.trim().is_empty() {
        return Ok(None);
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_load(app_handle, key)
    }
    #[cfg(not(target_os = "android"))]
    {
        let sanitized = sanitize_credential_key(&key);
        let mut file_path = get_credentials_dir();
        file_path.push(format!("{}.enc", sanitized));

        if !file_path.exists() {
            return Ok(None);
        }

        let encrypted = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
        if encrypted.trim().is_empty() {
            return Ok(Some(String::new()));
        }
        let decrypted = decrypt_password(encrypted.trim())?;
        Ok(Some(decrypted))
    }
}

#[tauri::command]
pub fn secure_has_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    if key.trim().is_empty() {
        return Ok(false);
    }
    #[cfg(target_os = "android")]
    {
        match crate::commands::android::android_keystore_load(app_handle, key) {
            Ok(Some(val)) => Ok(!val.is_empty()),
            _ => Ok(false),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let sanitized = sanitize_credential_key(&key);
        let mut file_path = get_credentials_dir();
        file_path.push(format!("{}.enc", sanitized));
        Ok(file_path.exists())
    }
}

#[tauri::command]
pub fn secure_delete_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    if key.trim().is_empty() {
        return Ok(false);
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_delete(app_handle, key)
    }
    #[cfg(not(target_os = "android"))]
    {
        let sanitized = sanitize_credential_key(&key);
        let mut file_path = get_credentials_dir();
        file_path.push(format!("{}.enc", sanitized));

        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_book_filename() {
        assert!(validate_book_filename("book.epub").is_ok());
        assert!(validate_book_filename("my-book_v2.pdf").is_ok());
        assert!(validate_book_filename("novel 123.mobi").is_ok());

        // Traversal attempts
        assert!(validate_book_filename("../../audit-target.txt").is_err());
        assert!(validate_book_filename("..\\target.txt").is_err());
        assert!(validate_book_filename("%2e%2e%2fattack.pdf").is_err());
        assert!(validate_book_filename(".").is_err());
        assert!(validate_book_filename("..").is_err());
        assert!(validate_book_filename(".hidden").is_err());
        assert!(validate_book_filename("").is_err());

        // Dangerous characters
        assert!(validate_book_filename("book?.pdf").is_err());
        assert!(validate_book_filename("book#anchor.epub").is_err());
        assert!(validate_book_filename("sub/dir/book.pdf").is_err());
    }

    #[test]
    fn test_sync_url_path_containment() {
        let config = SyncConfig {
            enabled: Some(true),
            server_type: Some("webdav".into()),
            server_url: Some("https://dav.jianguoyun.com/dav/".into()),
            username: Some("user".into()),
            password: None,
            has_password: None,
            _pwd_encrypted: None,
            remote_dir: Some("LindenLeaf".into()),
            auto_sync_on_startup: None,
            auto_sync_on_book_close: None,
            last_sync_time: None,
            last_sync_status: None,
            credential_origin: None,
        };

        let normal_url = get_sync_url(&config, "books/novel.epub").unwrap();
        assert_eq!(normal_url.as_str(), "https://dav.jianguoyun.com/dav/LindenLeaf/books/novel.epub");

        // Attempt traversal in sub_path
        let err_traversal = get_sync_url(&config, "books/../../audit-target.txt");
        assert!(err_traversal.is_err(), "Must reject path traversal in sub_path");

        // Attempt traversal in remote_dir
        let mut bad_config = config.clone();
        bad_config.remote_dir = Some("../LindenLeaf".into());
        assert!(get_sync_url(&bad_config, "test.json").is_err());
    }

    #[test]
    fn test_allowed_server_url() {
        assert!(is_allowed_server_url(&reqwest::Url::parse("https://dav.jianguoyun.com/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://localhost:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://127.0.0.1:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://192.168.1.100:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://10.0.0.5:8080/dav/").unwrap()).is_ok());

        // Insecure public HTTP must be blocked
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://dav.example.com/dav/").unwrap()).is_err());
    }

    #[test]
    fn test_credential_origin_binding() {
        let saved = SyncConfig {
            enabled: Some(true),
            server_type: Some("webdav".into()),
            server_url: Some("https://dav.jianguoyun.com/dav/".into()),
            username: Some("user".into()),
            password: Some("secret".into()),
            has_password: Some(true),
            _pwd_encrypted: Some(false),
            remote_dir: Some("LindenLeaf".into()),
            auto_sync_on_startup: None,
            auto_sync_on_book_close: None,
            last_sync_time: None,
            last_sync_status: None,
            credential_origin: Some("https://dav.jianguoyun.com".into()),
        };

        // Same origin passes
        let req_same = SyncConfig {
            enabled: Some(true),
            server_type: Some("webdav".into()),
            server_url: Some("https://dav.jianguoyun.com/dav/custom/".into()),
            username: None,
            password: None,
            has_password: None,
            _pwd_encrypted: None,
            remote_dir: None,
            auto_sync_on_startup: None,
            auto_sync_on_book_close: None,
            last_sync_time: None,
            last_sync_status: None,
            credential_origin: None,
        };
        assert!(verify_credential_origin(&req_same, &saved).is_ok());

        // Cross origin fails!
        let req_evil = SyncConfig {
            enabled: Some(true),
            server_type: Some("webdav".into()),
            server_url: Some("https://attacker.example.com/dav/".into()),
            username: None,
            password: None,
            has_password: None,
            _pwd_encrypted: None,
            remote_dir: None,
            auto_sync_on_startup: None,
            auto_sync_on_book_close: None,
            last_sync_time: None,
            last_sync_status: None,
            credential_origin: None,
        };
        assert!(verify_credential_origin(&req_evil, &saved).is_err());
    }
}

