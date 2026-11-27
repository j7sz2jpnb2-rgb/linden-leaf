use std::fs;
use std::path::PathBuf;

// Windows DPAPI encryption helper
#[cfg(target_os = "windows")]
pub(crate) fn encrypt_password(plain: &str) -> Result<String, String> {
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
pub(crate) fn encrypt_password(_plain: &str) -> Result<String, String> {
    // Base64 encoding is not encryption and must never be used to store credentials on disk.
    // On Android/mobile/Linux, a platform Keystore or Keyring bridge is required.
    Err("Safe credential storage (Keystore) is not yet configured for this platform. Credentials cannot be persisted to disk safely.".to_string())
}

#[cfg(target_os = "windows")]
pub(crate) fn decrypt_password(cipher_b64: &str) -> Result<String, String> {
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
pub(crate) fn decrypt_password(_cipher_b64: &str) -> Result<String, String> {
    Err("Safe credential decryption is not supported on this platform without native Keystore.".to_string())
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

#[allow(dead_code)]
fn get_credentials_dir() -> PathBuf {
    let mut dir = crate::commands::fs::resolve_app_data_dir();
    dir.push("credentials");
    let _ = fs::create_dir_all(&dir);
    dir
}

#[allow(dead_code)]
pub(crate) fn sanitize_credential_key(key: &str) -> String {
    key.trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

pub(crate) fn is_protected_ipc_key(sanitized: &str) -> bool {
    sanitized == "sync_webdav_password"
        || sanitized == "reading_ai_credential_origin"
        || sanitized.starts_with("siwc_")
}

pub(crate) fn secure_store_credential_internal(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<bool, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Err("Credential key cannot be empty".to_string());
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_store(app_handle, sanitized, value)
    }
    #[cfg(not(target_os = "android"))]
    {
        let mut file_path = get_credentials_dir();
        file_path.push(format!("{}.enc", sanitized));

        let encrypted = encrypt_password(&value)?;
        fs::write(&file_path, encrypted).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

pub(crate) fn secure_load_credential_internal(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Ok(None);
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_load(app_handle, sanitized)
    }
    #[cfg(not(target_os = "android"))]
    {
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

pub(crate) fn secure_delete_credential_internal(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Ok(false);
    }
    #[cfg(target_os = "android")]
    {
        crate::commands::android::android_keystore_delete(app_handle, sanitized)
    }
    #[cfg(not(target_os = "android"))]
    {
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

#[tauri::command]
pub fn secure_store_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<bool, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Err("Credential key cannot be empty".to_string());
    }
    // Block renderer from directly overwriting WebDAV keystore secret, AI origin binding, or SIWC OAuth tokens
    if is_protected_ipc_key(&sanitized) {
        return Err(format!("Protected credential key '{}' cannot be modified directly via generic IPC", sanitized));
    }
    // If renderer changes tts_api_origin to a different origin, automatically wipe any bound tts_api_key
    if sanitized == "tts_api_origin" {
        if let Ok(Some(prev_origin)) = secure_load_credential_internal(app_handle.clone(), "tts_api_origin".to_string()) {
            let clean_prev = prev_origin.trim();
            let clean_next = value.trim();
            if !clean_prev.is_empty() && clean_prev != clean_next {
                let _ = secure_store_credential_internal(app_handle.clone(), "tts_api_key".to_string(), String::new());
            }
        }
    }
    secure_store_credential_internal(app_handle, sanitized, value)
}

#[tauri::command]
pub fn secure_load_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Ok(None);
    }
    if sanitized == "sync_webdav_password" || sanitized.starts_with("siwc_") {
        return Err(format!("Protected credential key '{}' cannot be read via generic credential IPC", sanitized));
    }
    secure_load_credential_internal(app_handle, sanitized)
}

#[tauri::command]
pub fn secure_has_credential(
    #[allow(unused)] app_handle: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Ok(false);
    }
    if sanitized == "sync_webdav_password" || sanitized.starts_with("siwc_") {
        return Err(format!("Protected credential key '{}' cannot be queried via generic credential IPC", sanitized));
    }
    #[cfg(target_os = "android")]
    {
        match crate::commands::android::android_keystore_load(app_handle, sanitized) {
            Ok(Some(val)) => Ok(!val.is_empty()),
            _ => Ok(false),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
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
    let sanitized = sanitize_credential_key(&key);
    if sanitized.is_empty() {
        return Ok(false);
    }
    if is_protected_ipc_key(&sanitized) {
        return Err(format!("Protected credential key '{}' cannot be deleted via generic credential IPC", sanitized));
    }
    secure_delete_credential_internal(app_handle, sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allowed_server_url() {
        assert!(is_allowed_server_url(&reqwest::Url::parse("https://dav.jianguoyun.com/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://localhost:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://127.0.0.1:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://192.168.1.100:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://10.0.0.5:8080/dav/").unwrap()).is_ok());
        assert!(is_allowed_server_url(&reqwest::Url::parse("http://dav.example.com/dav/").unwrap()).is_err());
    }

    #[test]
    fn test_protected_credential_keys() {
        assert_eq!(sanitize_credential_key("  sync_webdav_password  "), "sync_webdav_password");
        assert_eq!(sanitize_credential_key("reading_ai_credential_origin"), "reading_ai_credential_origin");
        assert_eq!(sanitize_credential_key("tts_api_origin"), "tts_api_origin");
        assert_eq!(sanitize_credential_key("custom/key!with#specials"), "custom_key_with_specials");
        assert!(is_protected_ipc_key("siwc_access_token"));
        assert!(is_protected_ipc_key("siwc_refresh_token"));
        assert!(is_protected_ipc_key("siwc_dynamic_client_id"));
        assert!(is_protected_ipc_key("siwc_token_meta"));
        assert!(is_protected_ipc_key("sync_webdav_password"));
        assert!(!is_protected_ipc_key("reading_ai_api_key"));
    }
}
