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

#[cfg(not(target_os = "windows"))]
fn encrypt_password(plain: &str) -> Result<String, String> {
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        plain.as_bytes(),
    ))
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
fn decrypt_password(cipher_b64: &str) -> Result<String, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, cipher_b64)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
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
    }
}

#[tauri::command]
pub fn sync_reveal_password() -> String {
    let path = get_sync_config_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<SyncConfig>(&content) {
            if let Some(pwd) = cfg.password {
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
pub fn sync_save_config(mut config: SyncConfig) -> bool {
    let path = get_sync_config_path();
    let existing_raw = fs::read_to_string(&path).ok();
    let existing_cfg: Option<SyncConfig> = existing_raw.and_then(|s| serde_json::from_str(&s).ok());

    // Preserve existing password if new one is empty
    if config.password.as_deref().unwrap_or("").is_empty() {
        if let Some(ref ext) = existing_cfg {
            config.password = ext.password.clone();
            config._pwd_encrypted = ext._pwd_encrypted;
        }
    } else if let Some(ref plain) = config.password {
        if let Ok(enc) = encrypt_password(plain) {
            config.password = Some(enc);
            config._pwd_encrypted = Some(true);
        }
    }

    if let Ok(json) = serde_json::to_string_pretty(&config) {
        return fs::write(&path, json).is_ok();
    }
    false
}

fn get_sync_url(config: &SyncConfig, sub_path: &str) -> String {
    let saved_cfg = if config.server_url.as_deref().unwrap_or("").is_empty() {
        Some(sync_get_config())
    } else {
        None
    };
    let base_opt = config.server_url.as_deref().filter(|s| !s.is_empty())
        .or_else(|| saved_cfg.as_ref().and_then(|c| c.server_url.as_deref()));
    let base = base_opt.unwrap_or("https://dav.jianguoyun.com/dav/").trim().trim_end_matches('/');

    let dir_opt = config.remote_dir.as_deref().filter(|s| !s.is_empty())
        .or_else(|| saved_cfg.as_ref().and_then(|c| c.remote_dir.as_deref()));
    let remote_dir = dir_opt.unwrap_or("LindenLeaf").trim().trim_matches('/');

    if sub_path.is_empty() {
        format!("{}/{}", base, remote_dir)
    } else {
        format!("{}/{}/{}", base, remote_dir, sub_path.trim_start_matches('/'))
    }
}

fn get_credentials(config: &SyncConfig) -> (String, String) {
    let saved_cfg = sync_get_config();
    let user = match config.username {
        Some(ref u) if !u.is_empty() => u.clone(),
        _ => saved_cfg.username.unwrap_or_default(),
    };
    let pass = match config.password {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => sync_reveal_password(),
    };
    (user, pass)
}

async fn ensure_remote_dir(client: &reqwest::Client, dir_url: &str, user: &str, pass: &str) {
    let url = if dir_url.ends_with('/') {
        dir_url.to_string()
    } else {
        format!("{}/", dir_url)
    };
    let _ = client
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url)
        .basic_auth(user, Some(pass))
        .send()
        .await;
}

#[tauri::command]
pub async fn sync_test_connection(config: SyncConfig) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = config.server_url.as_deref().unwrap_or("").trim().to_string();
    let (user, pass) = get_credentials(&config);
    let target_url = if url.is_empty() {
        get_sync_url(&config, "")
    } else {
        url
    };

    let res = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &target_url)
        .basic_auth(&user, Some(&pass))
        .header("Depth", "0")
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 207 => {
            ensure_remote_dir(&client, &get_sync_url(&config, ""), &user, &pass).await;
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
pub async fn sync_fetch_remote(config: SyncConfig) -> Result<RemoteSyncResponse, String> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(e) => return Ok(RemoteSyncResponse {
            success: false,
            exists: false,
            data: None,
            etag: None,
            error: Some(e.to_string()),
        }),
    };

    let url = get_sync_url(&config, "linden_sync_data.json");
    let (user, pass) = get_credentials(&config);

    match client.get(&url).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() => {
            let etag = res.headers().get("etag").and_then(|h| h.to_str().ok()).map(|s| s.to_string());
            match res.json::<serde_json::Value>().await {
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
    config: SyncConfig,
    data: serde_json::Value,
    etag: Option<String>,
) -> Result<SaveRemoteResponse, String> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(c) => c,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e.to_string()),
        }),
    };

    let url = get_sync_url(&config, "linden_sync_data.json");
    let (user, pass) = get_credentials(&config);
    ensure_remote_dir(&client, &get_sync_url(&config, ""), &user, &pass).await;

    let body = match serde_json::to_string_pretty(&data) {
        Ok(b) => b,
        Err(e) => return Ok(SaveRemoteResponse {
            success: false,
            etag: None,
            is_conflict: None,
            error: Some(e.to_string()),
        }),
    };

    let mut req = client.put(&url).basic_auth(user, Some(pass)).header("Content-Type", "application/json");
    if let Some(ref tag) = etag {
        if !tag.is_empty() {
            req = req.header("If-Match", tag.as_str());
        }
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
    config: SyncConfig,
    file_name: String,
    buffer: Vec<u8>,
) -> Result<BookBinaryResponse, String> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build() {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    };

    let url = get_sync_url(&config, &format!("books/{}", file_name));
    let (user, pass) = get_credentials(&config);
    ensure_remote_dir(&client, &get_sync_url(&config, ""), &user, &pass).await;
    ensure_remote_dir(&client, &get_sync_url(&config, "books"), &user, &pass).await;
    let size = buffer.len();

    match client.put(&url).basic_auth(user, Some(pass)).body(buffer).send().await {
        Ok(res) if res.status().is_success() => Ok(BookBinaryResponse {
            success: true,
            file_name: Some(file_name),
            size: Some(size),
            buffer: None,
            error: None,
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_download_book_binary(
    config: SyncConfig,
    file_name: String,
) -> Result<BookBinaryResponse, String> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build() {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    };

    let url = get_sync_url(&config, &format!("books/{}", file_name));
    let (user, pass) = get_credentials(&config);

    match client.get(&url).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() => {
            match res.bytes().await {
                Ok(bytes) => {
                    let len = bytes.len();
                    Ok(BookBinaryResponse {
                        success: true,
                        file_name: Some(file_name),
                        size: Some(len),
                        buffer: Some(bytes.to_vec()),
                        error: None,
                    })
                }
                Err(e) => Ok(BookBinaryResponse {
                    success: false,
                    file_name: Some(file_name),
                    size: None,
                    buffer: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        Ok(res) if res.status().as_u16() == 404 => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some("404 Not Found".to_string()),
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn sync_delete_book_binary(
    config: SyncConfig,
    file_name: String,
) -> Result<BookBinaryResponse, String> {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(e) => return Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    };

    let url = get_sync_url(&config, &format!("books/{}", file_name));
    let (user, pass) = get_credentials(&config);

    match client.delete(&url).basic_auth(user, Some(pass)).send().await {
        Ok(res) if res.status().is_success() || res.status().as_u16() == 404 => Ok(BookBinaryResponse {
            success: true,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: None,
        }),
        Ok(res) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(format!("HTTP {}", res.status().as_u16())),
        }),
        Err(e) => Ok(BookBinaryResponse {
            success: false,
            file_name: Some(file_name),
            size: None,
            buffer: None,
            error: Some(e.to_string()),
        }),
    }
}
