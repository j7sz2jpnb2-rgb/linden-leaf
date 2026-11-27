use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, Window};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

pub const NATIVE_HOST_NAME: &str = "com.lindenleaf.companion";
pub const MAX_IPC_MESSAGE_BYTES: usize = 1024 * 1024; // 1 MiB strict framing cap

#[derive(Default)]
pub struct CompanionState {
    pub inner: Mutex<CompanionBridgeInner>,
}

#[derive(Default)]
pub struct CompanionBridgeInner {
    pub bridge_running: bool,
    pub native_connected: bool,
    pub native_extension_id: Option<String>,
    pub relay_port: Option<u16>,
    pub relay_token: Option<String>,
    pub stop_signal: Option<Arc<AtomicBool>>,
    pub pending_commands: VecDeque<serde_json::Value>,
    pub active_pipe_tx: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    pub active_pipe_conn_id: u64,
    pub response_waiters: HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>,
    pub tracked_companion_hwnd: Option<isize>,
    pub snap_enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowserInfo {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub supports_app_mode: bool,
    pub profiles: Vec<BrowserProfileInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CandidateWindowInfo {
    pub hwnd: isize,
    pub title: String,
    pub process_name: String,
    pub class_name: String,
    pub is_browser: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RectPx {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl RectPx {
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(0)
    }
    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(0)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SideBySidePlan {
    pub reader_visual: RectPx,
    pub companion_visual: RectPx,
    pub tight_screen: bool,
    pub placement: String,
    pub logical_work_width: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCompanionOptions {
    pub browser_id: Option<String>,
    pub url: String,
    pub profile_directory: Option<String>,
    pub reuse_hwnd: Option<isize>,
    pub auto_dock: Option<bool>,
    pub placement: Option<String>,
    pub split_ratio: Option<f64>,
    pub compact_reader: Option<bool>,
    pub snap_enabled: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCompanionResult {
    pub ok: bool,
    pub hwnd: Option<isize>,
    pub launched: bool,
    pub window_found: bool,
    pub docked: bool,
    pub tight_screen: bool,
    pub fallback_default_browser: bool,
    pub process_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DockResult {
    pub ok: bool,
    pub companion_hwnd: isize,
    pub tight_screen: bool,
    pub logical_work_width: i32,
    pub snap_enabled: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusInfo {
    pub running: bool,
    pub native_connected: bool,
    pub native_extension_id: Option<String>,
    pub relay_port: Option<u16>,
    pub relay_token: Option<String>,
    pub pipe_name: String,
    pub extension_dir: String,
    pub tracked_hwnd: Option<isize>,
    pub snap_enabled: bool,
    pub chrome_manifest_registered: bool,
    pub edge_manifest_registered: bool,
}

/// Validates strict 32-char lowercase Chromium extension ID (`a`..=`p`).
pub fn is_valid_chromium_extension_id(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.len() == 32 && trimmed.bytes().all(|b| matches!(b, b'a'..=b'p'))
}

/// Validates strict HTTPS URL for external AI websites.
pub fn validate_companion_https_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return Err("Companion URL cannot be empty or contain control characters".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("External AI companion sites must use HTTPS".to_string());
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err("Missing hostname in companion URL".to_string());
    }
    Ok(parsed.to_string())
}

/// Validates an Origin header for optional local relay requests.
pub fn is_allowed_extension_origin(origin: Option<&str>) -> bool {
    let Some(raw) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
        // Native/background extension fetches may omit Origin in some Chromium paths; token still required.
        return true;
    };
    if let Some(id) = raw.strip_prefix("chrome-extension://") {
        let host = id.trim_end_matches('/');
        return is_valid_chromium_extension_id(host);
    }
    if let Some(id) = raw.strip_prefix("extension://") {
        let host = id.trim_end_matches('/');
        return is_valid_chromium_extension_id(host);
    }
    false
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.as_bytes().iter().zip(b.as_bytes().iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn encode_framed_message(payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_IPC_MESSAGE_BYTES {
        return Err(format!("IPC message exceeds {} byte cap", MAX_IPC_MESSAGE_BYTES));
    }
    let len = payload.len() as u32;
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn decode_framed_header(header: [u8; 4]) -> Result<usize, String> {
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 || len > MAX_IPC_MESSAGE_BYTES {
        return Err(format!("Invalid IPC frame length: {}", len));
    }
    Ok(len)
}

pub fn user_scoped_pipe_name() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "linden_user".to_string());
    let profile = std::env::var("USERPROFILE").unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(user.as_bytes());
    hasher.update(b":");
    hasher.update(profile.as_bytes());
    let digest = hasher.finalize();
    let hex_prefix: String = digest.iter().take(8).map(|b| format!("{:02x}", b)).collect();
    format!(r"\\.\pipe\linden_leaf_companion_{}", hex_prefix)
}

/// Computes DPI-aware side-by-side visual bounds inside `work_area`.
pub fn compute_side_by_side_layout(
    work_area: RectPx,
    scale_factor: f64,
    ratio: f64,
    placement: &str,
    compact_reader: bool,
) -> SideBySidePlan {
    let scale = if scale_factor.is_finite() && scale_factor >= 0.75 {
        scale_factor
    } else {
        1.0
    };
    let work_w = work_area.width().max(320);
    let work_h = work_area.height().max(320);
    let logical_work_width = ((work_w as f64) / scale).round() as i32;

    let min_reader_logical = if compact_reader { 520.0 } else { 760.0 };
    let min_comp_logical = 360.0;
    let min_reader_px = (min_reader_logical * scale).round() as i32;
    let min_comp_px = (min_comp_logical * scale).round() as i32;
    let tight_screen = (min_reader_px + min_comp_px) > work_w;

    let clean_ratio = ratio.clamp(0.45, 0.75);
    let mut reader_w = ((work_w as f64) * clean_ratio).round() as i32;

    if !tight_screen {
        reader_w = reader_w.max(min_reader_px);
        if work_w - reader_w < min_comp_px {
            reader_w = (work_w - min_comp_px).max(min_reader_px);
        }
    } else {
        // Narrow/high-DPI fallback: share proportionally without crushing companion below 320 logical px
        let floor_comp = ((320.0 * scale).round() as i32).min(work_w / 2);
        let floor_reader = work_w - floor_comp;
        reader_w = reader_w.clamp((work_w as f64 * 0.52).round() as i32, floor_reader.max(work_w / 2));
    }

    let comp_w = (work_w - reader_w).max(240);
    let place = if placement == "left" { "left" } else { "right" };

    let (reader_visual, companion_visual) = if place == "left" {
        (
            RectPx {
                left: work_area.left + comp_w,
                top: work_area.top,
                right: work_area.right,
                bottom: work_area.top + work_h,
            },
            RectPx {
                left: work_area.left,
                top: work_area.top,
                right: work_area.left + comp_w,
                bottom: work_area.top + work_h,
            },
        )
    } else {
        (
            RectPx {
                left: work_area.left,
                top: work_area.top,
                right: work_area.left + reader_w,
                bottom: work_area.top + work_h,
            },
            RectPx {
                left: work_area.left + reader_w,
                top: work_area.top,
                right: work_area.right,
                bottom: work_area.top + work_h,
            },
        )
    };

    SideBySidePlan {
        reader_visual,
        companion_visual,
        tight_screen,
        placement: place.to_string(),
        logical_work_width,
    }
}

pub fn generate_random_hex_token(byte_len: usize) -> String {
    let mut buf = vec![0u8; byte_len];
    fill_random_bytes(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(windows)]
pub(crate) fn fill_random_bytes(dest: &mut [u8]) {
    #[link(name = "advapi32")]
    extern "system" {
        fn SystemFunction036(random_buffer: *mut u8, random_buffer_length: u32) -> u8;
    }
    let ok = unsafe { SystemFunction036(dest.as_mut_ptr(), dest.len() as u32) };
    if ok == 0 {
        // Deterministic-free fallback mixed with monotonic clock + PID if RtlGenRandom unexpectedly fails
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut h = Sha256::new();
        h.update(nanos.to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        let d = h.finalize();
        for (i, b) in dest.iter_mut().enumerate() {
            *b = d[i % d.len()];
        }
    }
}

#[cfg(not(windows))]
pub(crate) fn fill_random_bytes(dest: &mut [u8]) {
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(dest).is_ok() {
            return;
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut h = Sha256::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    let d = h.finalize();
    for (i, b) in dest.iter_mut().enumerate() {
        *b = d[i % d.len()];
    }
}

pub fn resolve_extension_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(handle) = app {
        if let Ok(res_dir) = handle.path().resource_dir() {
            candidates.push(res_dir.join("extensions").join("chromium-companion"));
            candidates.push(res_dir.join("_up_").join("extensions").join("chromium-companion"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("extensions").join("chromium-companion"));
            candidates.push(dir.join("resources").join("extensions").join("chromium-companion"));
            candidates.push(dir.join("_up_").join("extensions").join("chromium-companion"));
            if let Some(up1) = dir.parent() {
                candidates.push(up1.join("extensions").join("chromium-companion"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("extensions").join("chromium-companion"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("extensions").join("chromium-companion"));
        }
    }
    for cand in &candidates {
        if cand.join("manifest.json").exists() {
            return cand.clone();
        }
    }
    candidates.into_iter().next().unwrap_or_else(|| PathBuf::from("extensions/chromium-companion"))
}

pub fn resolve_native_manifest_paths() -> (PathBuf, PathBuf) {
    let dir = crate::commands::fs::resolve_app_data_dir().join("companion");
    (
        dir.join(format!("{}.chrome.json", NATIVE_HOST_NAME)),
        dir.join(format!("{}.edge.json", NATIVE_HOST_NAME)),
    )
}

/// Entry point invoked from `main.rs` when Chrome/Edge launches Linden Leaf as a Native Messaging Host.
/// Uses Tokio Overlapped `NamedPipeClient` on Windows so concurrent stdin->pipe writes and pipe->stdout reads never deadlock.
#[cfg(windows)]
pub fn run_native_messaging_host() -> i32 {
    use std::io::{Read, Write};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
        return 1;
    };

    rt.block_on(async move {
        let pipe_name = user_scoped_pipe_name();
        let mut pipe_client = None;
        for _attempt in 0..8 {
            match ClientOptions::new().open(&pipe_name) {
                Ok(client) => {
                    pipe_client = Some(client);
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(120)).await,
            }
        }

        let Some(client) = pipe_client else {
            let offline_msg = serde_json::json!({
                "type": "host_offline",
                "ok": false,
                "error": "Linden Leaf companion bridge is not running"
            })
            .to_string();
            if let Ok(frame) = encode_framed_message(offline_msg.as_bytes()) {
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(&frame);
                let _ = stdout.flush();
            }
            return 0;
        };

        let (mut pipe_rd, mut pipe_wr) = tokio::io::split(client);
        let (in_tx, mut in_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut hdr = [0u8; 4];
            loop {
                if stdin.read_exact(&mut hdr).is_err() {
                    break;
                }
                let Ok(len) = decode_framed_header(hdr) else {
                    break;
                };
                let mut body = vec![0u8; len];
                if stdin.read_exact(&mut body).is_err() {
                    break;
                }
                let mut frame = Vec::with_capacity(4 + len);
                frame.extend_from_slice(&hdr);
                frame.extend_from_slice(&body);
                if in_tx.send(frame).is_err() {
                    break;
                }
            }
        });

        let mut writer_task = tokio::spawn(async move {
            while let Some(frame) = in_rx.recv().await {
                if pipe_wr.write_all(&frame).await.is_err() || pipe_wr.flush().await.is_err() {
                    break;
                }
            }
        });

        let mut reader_task = tokio::spawn(async move {
            let mut hdr = [0u8; 4];
            loop {
                if pipe_rd.read_exact(&mut hdr).await.is_err() {
                    break;
                }
                let Ok(len) = decode_framed_header(hdr) else {
                    break;
                };
                let mut body = vec![0u8; len];
                if pipe_rd.read_exact(&mut body).await.is_err() {
                    break;
                }
                let write_ok = {
                    let mut stdout = std::io::stdout().lock();
                    stdout.write_all(&hdr).is_ok()
                        && stdout.write_all(&body).is_ok()
                        && stdout.flush().is_ok()
                };
                if !write_ok {
                    break;
                }
            }
        });

        tokio::select! {
            _ = &mut writer_task => {
                reader_task.abort();
            }
            _ = &mut reader_task => {
                writer_task.abort();
            }
        }
        0
    })
}

#[cfg(not(windows))]
pub fn run_native_messaging_host() -> i32 {
    0
}

#[cfg(windows)]
mod win32 {
    use super::*;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, BOOL, HANDLE, HGLOBAL, HLOCAL, HMODULE, HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE,
        REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, DispatchMessageW, EnumWindows, GetClassNameW, GetMessageW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, PostQuitMessage,
        PostThreadMessageW, SetForegroundWindow, SetWindowPos, ShowWindow, TranslateMessage, MSG,
        SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE, WM_QUIT,
    };

    const EVENT_SYSTEM_MOVESIZEEND_CODE: u32 = 0x000B;
    const WINEVENT_OUTOFCONTEXT_FLAG: u32 = 0x0000;
    const CF_UNICODETEXT_ID: u32 = 13;

    pub(crate) fn build_current_user_dacl_sddl() -> Option<String> {
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return None;
            }
            struct TokenGuard(HANDLE);
            impl Drop for TokenGuard {
                fn drop(&mut self) {
                    if !self.0.is_invalid() {
                        unsafe {
                            let _ = CloseHandle(self.0);
                        }
                    }
                }
            }
            let _token_guard = TokenGuard(token);

            let mut needed: u32 = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            if needed < std::mem::size_of::<TOKEN_USER>() as u32 {
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            if GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut c_void),
                needed,
                &mut needed,
            )
            .is_err()
            {
                return None;
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut sid_pwstr = PWSTR::null();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid_pwstr).is_err() || sid_pwstr.is_null() {
                return None;
            }
            let mut len = 0usize;
            while len < 512 && *sid_pwstr.0.add(len) != 0 {
                len += 1;
            }
            let sid_str = String::from_utf16_lossy(std::slice::from_raw_parts(sid_pwstr.0, len));
            let _ = LocalFree(HLOCAL(sid_pwstr.0 as *mut c_void));
            if sid_str.trim().is_empty() {
                return None;
            }
            Some(format!("D:P(A;;GA;;;{})", sid_str.trim()))
        }
    }

    pub(crate) fn create_user_scoped_named_pipe(
        opts: &tokio::net::windows::named_pipe::ServerOptions,
        pipe_name: &str,
    ) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        if let Some(sddl) = build_current_user_dacl_sddl() {
            let sddl_w = to_wide_null(&sddl);
            let mut sd = PSECURITY_DESCRIPTOR::default();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl_w.as_ptr()),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
            }
            .is_ok()
                && !sd.is_invalid()
            {
                let mut sa = SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: sd.0,
                    bInheritHandle: BOOL(0),
                };
                let res = unsafe { opts.create_with_security_attributes_raw(pipe_name, &mut sa as *mut _ as *mut c_void) };
                unsafe {
                    let _ = LocalFree(HLOCAL(sd.0));
                }
                return res;
            }
        }
        opts.create(pipe_name)
    }

    #[derive(Clone)]
    struct DockSnapTarget {
        reader_hwnd: isize,
        companion_hwnd: isize,
        placement: String,
        app_handle: tauri::AppHandle,
    }

    static SNAP_TARGET: OnceLock<Mutex<Option<DockSnapTarget>>> = OnceLock::new();
    static SNAP_HOOK_THREAD: OnceLock<Mutex<Option<(u32, std::thread::JoinHandle<()>)>>> = OnceLock::new();

    fn to_wide_null(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct RegKeyGuard(HKEY);
    impl Drop for RegKeyGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
    }

    fn read_reg_sz(root: HKEY, subkey: &str, value_name: Option<&str>) -> Option<String> {
        let sub_w = to_wide_null(subkey);
        let mut hkey = HKEY::default();
        let err = unsafe { RegOpenKeyExW(root, PCWSTR(sub_w.as_ptr()), 0, KEY_QUERY_VALUE, &mut hkey) };
        if err.0 != 0 {
            return None;
        }
        let _guard = RegKeyGuard(hkey);
        let val_w = value_name.map(to_wide_null);
        let val_ptr = val_w.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
        let mut ty = REG_VALUE_TYPE::default();
        let mut len: u32 = 0;
        let q1 = unsafe { RegQueryValueExW(hkey, val_ptr, None, Some(&mut ty), None, Some(&mut len)) };
        if q1.0 != 0 || len == 0 || ty != REG_SZ {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let q2 = unsafe {
            RegQueryValueExW(
                hkey,
                val_ptr,
                None,
                Some(&mut ty),
                Some(buf.as_mut_ptr()),
                Some(&mut len),
            )
        };
        if q2.0 != 0 {
            return None;
        }
        let u16_slice: Vec<u16> = buf[..len as usize]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let end = u16_slice.iter().position(|&ch| ch == 0).unwrap_or(u16_slice.len());
        Some(String::from_utf16_lossy(&u16_slice[..end]))
    }

    pub fn write_native_host_registry(browser: &str, manifest_path: &str) -> Result<(), String> {
        let subkey = match browser {
            "chrome" => format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            "edge" => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            _ => return Err("Unsupported browser target".to_string()),
        };
        let sub_w = to_wide_null(&subkey);
        let mut hkey = HKEY::default();
        let res = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_w.as_ptr()),
                0,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                None,
            )
        };
        if res.0 != 0 {
            return Err(format!("RegCreateKeyExW failed with error {}", res.0));
        }
        let _guard = RegKeyGuard(hkey);
        let val_w = to_wide_null(manifest_path);
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2) };
        let set_res = unsafe { RegSetValueExW(hkey, PCWSTR::null(), 0, REG_SZ, Some(bytes)) };
        if set_res.0 != 0 {
            return Err(format!("RegSetValueExW failed with error {}", set_res.0));
        }
        Ok(())
    }

    pub fn is_native_host_registered(browser: &str, expected_manifest: &str) -> bool {
        let subkey = match browser {
            "chrome" => format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            "edge" => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            _ => return false,
        };
        read_reg_sz(HKEY_CURRENT_USER, &subkey, None)
            .map(|v| v.eq_ignore_ascii_case(expected_manifest) && PathBuf::from(&v).exists())
            .unwrap_or(false)
    }

    pub fn clear_native_host_registry(browser: &str) {
        let subkey = match browser {
            "chrome" => format!(r"Software\Google\Chrome\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            "edge" => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{}", NATIVE_HOST_NAME),
            _ => return,
        };
        let sub_w = to_wide_null(&subkey);
        let mut hkey = HKEY::default();
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(sub_w.as_ptr()), 0, KEY_SET_VALUE, &mut hkey) }.0 == 0 {
            let _guard = RegKeyGuard(hkey);
            unsafe {
                let _ = RegDeleteValueW(hkey, PCWSTR::null());
            }
        }
    }

    fn read_chromium_profiles(user_data_dir: &std::path::Path) -> Vec<BrowserProfileInfo> {
        let local_state = user_data_dir.join("Local State");
        let Ok(raw) = std::fs::read_to_string(local_state) else {
            return vec![BrowserProfileInfo {
                id: "Default".to_string(),
                name: "Default".to_string(),
            }];
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return vec![BrowserProfileInfo {
                id: "Default".to_string(),
                name: "Default".to_string(),
            }];
        };
        let mut profiles = Vec::new();
        if let Some(cache) = json.pointer("/profile/info_cache").and_then(|v| v.as_object()) {
            for (dir_name, meta) in cache {
                let display = meta
                    .get("name")
                    .or_else(|| meta.get("gaia_name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(dir_name)
                    .to_string();
                profiles.push(BrowserProfileInfo {
                    id: dir_name.clone(),
                    name: display,
                });
            }
        }
        profiles.sort_by(|a, b| a.id.cmp(&b.id));
        if profiles.is_empty() {
            profiles.push(BrowserProfileInfo {
                id: "Default".to_string(),
                name: "Default".to_string(),
            });
        }
        profiles
    }

    fn find_exe(exe_name: &str, extra_rel: &[&str]) -> Option<String> {
        let reg_sub = format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{}", exe_name);
        for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(raw) = read_reg_sz(root, &reg_sub, None) {
                let clean = raw.trim().trim_matches('"').to_string();
                if PathBuf::from(&clean).is_file() {
                    return Some(clean);
                }
            }
        }
        for env_var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(env_var) {
                for rel in extra_rel {
                    let cand = PathBuf::from(&base).join(rel);
                    if cand.is_file() {
                        return Some(cand.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    pub fn detect_browsers() -> Vec<DetectedBrowserInfo> {
        let local_app = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let mut out = Vec::new();

        if let Some(edge_exe) = find_exe("msedge.exe", &[r"Microsoft\Edge\Application\msedge.exe"]) {
            let user_data = PathBuf::from(&local_app).join(r"Microsoft\Edge\User Data");
            out.push(DetectedBrowserInfo {
                id: "edge".to_string(),
                name: "Microsoft Edge".to_string(),
                exe_path: edge_exe,
                supports_app_mode: true,
                profiles: read_chromium_profiles(&user_data),
            });
        }
        if let Some(chrome_exe) = find_exe("chrome.exe", &[r"Google\Chrome\Application\chrome.exe"]) {
            let user_data = PathBuf::from(&local_app).join(r"Google\Chrome\User Data");
            out.push(DetectedBrowserInfo {
                id: "chrome".to_string(),
                name: "Google Chrome".to_string(),
                exe_path: chrome_exe,
                supports_app_mode: true,
                profiles: read_chromium_profiles(&user_data),
            });
        }
        if let Some(brave_exe) = find_exe("brave.exe", &[r"BraveSoftware\Brave-Browser\Application\brave.exe"]) {
            let user_data = PathBuf::from(&local_app).join(r"BraveSoftware\Brave-Browser\User Data");
            out.push(DetectedBrowserInfo {
                id: "brave".to_string(),
                name: "Brave".to_string(),
                exe_path: brave_exe,
                supports_app_mode: true,
                profiles: read_chromium_profiles(&user_data),
            });
        }
        out
    }

    fn get_process_exe_basename(pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        unsafe {
            let Ok(hproc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
            let mut buf = vec![0u16; 512];
            let mut size = buf.len() as u32;
            let res = QueryFullProcessImageNameW(hproc, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
            let _ = windows::Win32::Foundation::CloseHandle(hproc);
            if res.is_ok() && size > 0 {
                let full = String::from_utf16_lossy(&buf[..size as usize]);
                return PathBuf::from(full)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
        String::new()
    }

    fn is_window_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        unsafe {
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
            {
                return cloaked != 0;
            }
        }
        false
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut (u32, Vec<CandidateWindowInfo>));
        if !IsWindowVisible(hwnd).as_bool() || is_window_cloaked(hwnd) {
            return BOOL(1);
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == state.0 {
            return BOOL(1);
        }
        let mut title_buf = vec![0u16; 256];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        if title_len <= 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]).trim().to_string();
        if title.is_empty() {
            return BOOL(1);
        }
        let mut class_buf = vec![0u16; 128];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = if class_len > 0 {
            String::from_utf16_lossy(&class_buf[..class_len as usize])
        } else {
            String::new()
        };
        if class_name == "Shell_TrayWnd" || class_name == "Progman" || class_name == "Windows.UI.Core.CoreWindow" {
            return BOOL(1);
        }
        let process_name = get_process_exe_basename(pid);
        let proc_low = process_name.to_ascii_lowercase();
        let is_browser = class_name == "Chrome_WidgetWin_1"
            || matches!(proc_low.as_str(), "msedge.exe" | "chrome.exe" | "brave.exe" | "firefox.exe");

        state.1.push(CandidateWindowInfo {
            hwnd: hwnd.0 as isize,
            title,
            process_name,
            class_name,
            is_browser,
        });
        BOOL(1)
    }

    pub fn list_candidate_windows() -> Vec<CandidateWindowInfo> {
        let self_pid = unsafe { GetCurrentProcessId() };
        let mut acc: (u32, Vec<CandidateWindowInfo>) = (self_pid, Vec::new());
        unsafe {
            let _ = EnumWindows(Some(enum_windows_proc), LPARAM(&mut acc as *mut _ as isize));
        }
        acc.1.sort_by(|a, b| b.is_browser.cmp(&a.is_browser).then(a.title.cmp(&b.title)));
        acc.1
    }

    fn get_frame_insets(hwnd: HWND) -> (i32, i32, i32, i32) {
        let mut rect = RECT::default();
        let mut ext = RECT::default();
        unsafe {
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return (0, 0, 0, 0);
            }
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut ext as *mut RECT as *mut c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                return (0, 0, 0, 0);
            }
        }
        (
            ext.left - rect.left,
            ext.top - rect.top,
            rect.right - ext.right,
            rect.bottom - ext.bottom,
        )
    }

    fn get_visual_rect(hwnd: HWND) -> Option<RectPx> {
        let mut rect = RECT::default();
        unsafe {
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut RECT as *mut c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                return Some(RectPx {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                });
            }
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                return Some(RectPx {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                });
            }
        }
        None
    }

    fn set_visual_rect(hwnd: HWND, target: &RectPx) -> Result<(), String> {
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                return Err("Target window handle is no longer valid".to_string());
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let (l_pad, t_pad, r_pad, b_pad) = get_frame_insets(hwnd);
            let x = target.left - l_pad;
            let y = target.top - t_pad;
            let cx = target.width() + l_pad + r_pad;
            let cy = target.height() + t_pad + b_pad;
            SetWindowPos(
                hwnd,
                HWND(std::ptr::null_mut()),
                x,
                y,
                cx,
                cy,
                SET_WINDOW_POS_FLAGS(SWP_NOZORDER.0 | SWP_NOACTIVATE.0),
            )
            .map_err(|e| format!("SetWindowPos failed: {e}"))
        }
    }

    fn monitor_work_area_and_scale(hwnd: HWND) -> Option<(RectPx, f64)> {
        unsafe {
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
                return None;
            }
            let dpi = GetDpiForWindow(hwnd);
            let scale = if dpi >= 72 { (dpi as f64) / 96.0 } else { 1.0 };
            let work = RectPx {
                left: mi.rcWork.left,
                top: mi.rcWork.top,
                right: mi.rcWork.right,
                bottom: mi.rcWork.bottom,
            };
            Some((work, scale))
        }
    }

    pub fn dock_windows_side_by_side(
        reader_hwnd_val: isize,
        companion_hwnd_val: isize,
        placement: &str,
        ratio: f64,
        compact_reader: bool,
    ) -> Result<(bool, i32), String> {
        let reader_hwnd = HWND(reader_hwnd_val as *mut c_void);
        let companion_hwnd = HWND(companion_hwnd_val as *mut c_void);
        if !unsafe { IsWindow(reader_hwnd).as_bool() } {
            return Err("Reader window handle is invalid".to_string());
        }
        if !unsafe { IsWindow(companion_hwnd).as_bool() } {
            return Err("Companion window handle is no longer open".to_string());
        }
        let (work, scale) = monitor_work_area_and_scale(reader_hwnd)
            .ok_or_else(|| "Unable to query monitor work area".to_string())?;
        let plan = compute_side_by_side_layout(work, scale, ratio, placement, compact_reader);
        set_visual_rect(reader_hwnd, &plan.reader_visual)?;
        set_visual_rect(companion_hwnd, &plan.companion_visual)?;
        Ok((plan.tight_screen, plan.logical_work_width))
    }

    pub fn activate_window(hwnd_val: isize) -> bool {
        let hwnd = HWND(hwnd_val as *mut c_void);
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                return false;
            }
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                let _ = AllowSetForegroundWindow(pid);
            }
            SetForegroundWindow(hwnd).as_bool()
        }
    }

    pub fn is_valid_window(hwnd_val: isize) -> bool {
        unsafe { IsWindow(HWND(hwnd_val as *mut c_void)).as_bool() }
    }

    pub fn launch_app_window(
        reader_hwnd_val: isize,
        opts: LaunchCompanionOptions,
    ) -> Result<LaunchCompanionResult, String> {
        let safe_url = validate_companion_https_url(&opts.url)?;
        if let Some(prev_hwnd) = opts.reuse_hwnd {
            if is_valid_window(prev_hwnd) {
                let mut docked = false;
                let mut tight = false;
                if opts.auto_dock.unwrap_or(true) && reader_hwnd_val != 0 {
                    if let Ok((t, _)) = dock_windows_side_by_side(
                        reader_hwnd_val,
                        prev_hwnd,
                        opts.placement.as_deref().unwrap_or("right"),
                        opts.split_ratio.unwrap_or(0.58),
                        opts.compact_reader.unwrap_or(false),
                    ) {
                        docked = true;
                        tight = t;
                    }
                }
                return Ok(LaunchCompanionResult {
                    ok: true,
                    hwnd: Some(prev_hwnd),
                    launched: false,
                    window_found: true,
                    docked,
                    tight_screen: tight,
                    fallback_default_browser: false,
                    process_name: None,
                    error: None,
                });
            }
        }

        let browsers = detect_browsers();
        let wanted = opts.browser_id.as_deref().unwrap_or("auto");
        let chosen = if wanted == "default" {
            None
        } else if wanted == "auto" {
            browsers.first()
        } else {
            browsers.iter().find(|b| b.id == wanted).or_else(|| browsers.first())
        };

        let Some(browser) = chosen else {
            let _ = std::process::Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", &safe_url])
                .spawn();
            return Ok(LaunchCompanionResult {
                ok: true,
                hwnd: None,
                launched: true,
                window_found: false,
                docked: false,
                tight_screen: false,
                fallback_default_browser: true,
                process_name: None,
                error: None,
            });
        };

        let before_hwnds: std::collections::HashSet<isize> = list_candidate_windows()
            .into_iter()
            .filter(|w| w.is_browser)
            .map(|w| w.hwnd)
            .collect();

        let mut cmd = std::process::Command::new(&browser.exe_path);
        cmd.arg(format!("--app={}", safe_url));
        if let Some(ref prof) = opts.profile_directory {
            let clean = prof.trim();
            if !clean.is_empty() && !clean.contains(['"', '\\', '/']) {
                cmd.arg(format!("--profile-directory={}", clean));
            }
        }
        cmd.spawn().map_err(|e| format!("Failed to launch {}: {e}", browser.name))?;

        let target_exe_lower = PathBuf::from(&browser.exe_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let mut found: Option<CandidateWindowInfo> = None;
        for _ in 0..24 {
            std::thread::sleep(std::time::Duration::from_millis(125));
            let after = list_candidate_windows();
            if let Some(new_win) = after.into_iter().find(|w| {
                w.is_browser
                    && !before_hwnds.contains(&w.hwnd)
                    && (target_exe_lower.is_empty()
                        || w.process_name.to_ascii_lowercase() == target_exe_lower)
            }) {
                found = Some(new_win);
                break;
            }
        }

        let mut docked = false;
        let mut tight = false;
        if let Some(ref win) = found {
            if opts.auto_dock.unwrap_or(true) && reader_hwnd_val != 0 {
                if let Ok((t, _)) = dock_windows_side_by_side(
                    reader_hwnd_val,
                    win.hwnd,
                    opts.placement.as_deref().unwrap_or("right"),
                    opts.split_ratio.unwrap_or(0.58),
                    opts.compact_reader.unwrap_or(false),
                ) {
                    docked = true;
                    tight = t;
                }
            }
        }

        Ok(LaunchCompanionResult {
            ok: true,
            hwnd: found.as_ref().map(|w| w.hwnd),
            launched: true,
            window_found: found.is_some(),
            docked,
            tight_screen: tight,
            fallback_default_browser: false,
            process_name: found.as_ref().map(|w| w.process_name.clone()),
            error: None,
        })
    }

    pub fn dock_new_browser_window_blocking(
        reader_hwnd_val: isize,
        before_hwnds: Vec<isize>,
        placement: String,
        ratio: f64,
        compact_reader: bool,
    ) -> LaunchCompanionResult {
        let before_set: std::collections::HashSet<isize> = before_hwnds.into_iter().collect();
        let mut found: Option<CandidateWindowInfo> = None;
        for _ in 0..16 {
            let after = list_candidate_windows();
            if let Some(new_win) = after.into_iter().find(|w| w.is_browser && !before_set.contains(&w.hwnd)) {
                found = Some(new_win);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let mut docked = false;
        let mut tight = false;
        if let Some(ref win) = found {
            if reader_hwnd_val != 0 {
                if let Ok((t, _)) = dock_windows_side_by_side(reader_hwnd_val, win.hwnd, &placement, ratio, compact_reader) {
                    docked = true;
                    tight = t;
                }
            }
        }
        LaunchCompanionResult {
            ok: found.is_some(),
            hwnd: found.as_ref().map(|w| w.hwnd),
            launched: false,
            window_found: found.is_some(),
            docked,
            tight_screen: tight,
            fallback_default_browser: false,
            process_name: found.as_ref().map(|w| w.process_name.clone()),
            error: None,
        }
    }

    unsafe extern "system" fn companion_movesizeend_cb(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event != EVENT_SYSTEM_MOVESIZEEND_CODE {
            return;
        }
        let moved = hwnd.0 as isize;
        let ctx_opt = SNAP_TARGET
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(ctx) = ctx_opt else {
            return;
        };
        if moved != ctx.reader_hwnd && moved != ctx.companion_hwnd {
            return;
        }
        let reader_h = HWND(ctx.reader_hwnd as *mut c_void);
        let comp_h = HWND(ctx.companion_hwnd as *mut c_void);
        if !IsWindow(reader_h).as_bool() || !IsWindow(comp_h).as_bool() {
            return;
        }
        let Some(r_rect) = get_visual_rect(reader_h) else { return };
        let Some(c_rect) = get_visual_rect(comp_h) else { return };
        let Some((work, _)) = monitor_work_area_and_scale(reader_h) else { return };

        if moved == ctx.reader_hwnd {
            // Keep companion flush next to reader within work area
            let cw = c_rect.width().max(320);
            let target_x = if ctx.placement == "left" {
                (r_rect.left - cw).max(work.left)
            } else {
                r_rect.right.min((work.right - cw).max(work.left))
            };
            let target = RectPx {
                left: target_x,
                top: r_rect.top,
                right: target_x + cw,
                bottom: r_rect.bottom,
            };
            let _ = set_visual_rect(comp_h, &target);
        } else {
            // Check magnetic snap threshold vs deliberate pull-away detach
            let edge_delta = if ctx.placement == "left" {
                (c_rect.right - r_rect.left).abs()
            } else {
                (c_rect.left - r_rect.right).abs()
            };
            let vertical_overlap = c_rect.bottom > r_rect.top + 40 && r_rect.bottom > c_rect.top + 40;
            if vertical_overlap && edge_delta <= 56 {
                let cw = c_rect.width().max(320);
                let target_x = if ctx.placement == "left" {
                    (r_rect.left - cw).max(work.left)
                } else {
                    r_rect.right.min((work.right - cw).max(work.left))
                };
                let target = RectPx {
                    left: target_x,
                    top: r_rect.top,
                    right: target_x + cw,
                    bottom: r_rect.bottom,
                };
                let _ = set_visual_rect(comp_h, &target);
            } else if edge_delta > 72 || !vertical_overlap {
                // User intentionally dragged away -> detach snap cleanly without dropping session/quotes
                if let Ok(mut guard) = SNAP_TARGET.get_or_init(|| Mutex::new(None)).lock() {
                    *guard = None;
                }
                let _ = ctx.app_handle.emit(
                    "companion:snap-detached",
                    serde_json::json!({ "companionHwnd": ctx.companion_hwnd }),
                );
                PostQuitMessage(0);
            }
        }
    }

    pub fn update_snap_watcher(
        app: Option<&tauri::AppHandle>,
        reader_hwnd: isize,
        companion_hwnd: isize,
        placement: &str,
        _ratio: f64,
        _compact_reader: bool,
        enabled: bool,
    ) {
        let target_lock = SNAP_TARGET.get_or_init(|| Mutex::new(None));
        let thread_lock = SNAP_HOOK_THREAD.get_or_init(|| Mutex::new(None));

        if !enabled || reader_hwnd == 0 || companion_hwnd == 0 || app.is_none() {
            if let Ok(mut g) = target_lock.lock() {
                *g = None;
            }
            if let Ok(mut tg) = thread_lock.lock() {
                if let Some((tid, handle)) = tg.take() {
                    unsafe {
                        let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                    drop(tg);
                    let _ = handle.join();
                }
            }
            return;
        }

        if let Ok(mut g) = target_lock.lock() {
            *g = Some(DockSnapTarget {
                reader_hwnd,
                companion_hwnd,
                placement: placement.to_string(),
                app_handle: app.unwrap().clone(),
            });
        }

        let mut tg = thread_lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, ref existing)) = *tg {
            if existing.is_finished() {
                if let Some((_, finished_handle)) = tg.take() {
                    let _ = finished_handle.join();
                }
            }
        }
        if tg.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<u32>();
            let handle = std::thread::spawn(move || unsafe {
                let tid = GetCurrentThreadId();
                let _ = tx.send(tid);
                let hook = SetWinEventHook(
                    EVENT_SYSTEM_MOVESIZEEND_CODE,
                    EVENT_SYSTEM_MOVESIZEEND_CODE,
                    HMODULE(std::ptr::null_mut()),
                    Some(companion_movesizeend_cb),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT_FLAG,
                );
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                if !hook.is_invalid() {
                    let _ = UnhookWinEvent(hook);
                }
            });
            if let Ok(tid) = rx.recv() {
                *tg = Some((tid, handle));
            }
        }
    }

    pub fn set_clipboard_text(text: &str) -> Result<(), String> {
        let wide = to_wide_null(text);
        let bytes = wide.len() * std::mem::size_of::<u16>();
        unsafe {
            let hmem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| format!("GlobalAlloc failed: {e}"))?;
            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                return Err("GlobalLock failed".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, bytes);
            let _ = GlobalUnlock(hmem);

            OpenClipboard(HWND(std::ptr::null_mut())).map_err(|e| format!("OpenClipboard failed: {e}"))?;
            let _ = EmptyClipboard();
            let res = SetClipboardData(CF_UNICODETEXT_ID, HANDLE(hmem.0));
            let _ = CloseClipboard();
            res.map(|_| ()).map_err(|e| format!("SetClipboardData failed: {e}"))
        }
    }

    pub fn get_clipboard_text() -> Result<String, String> {
        unsafe {
            OpenClipboard(HWND(std::ptr::null_mut())).map_err(|e| format!("OpenClipboard failed: {e}"))?;
            let out = (|| {
                let Ok(handle) = GetClipboardData(CF_UNICODETEXT_ID) else {
                    return Ok(String::new());
                };
                let hmem = HGLOBAL(handle.0);
                let ptr = GlobalLock(hmem) as *const u16;
                if ptr.is_null() {
                    return Ok(String::new());
                }
                let mut len = 0usize;
                // Cap single read to 2 MiB of UTF-16 code units safely
                while len < 1_048_576 && *ptr.add(len) != 0 {
                    len += 1;
                }
                let slice = std::slice::from_raw_parts(ptr, len);
                let text = String::from_utf16_lossy(slice);
                let _ = GlobalUnlock(hmem);
                Ok(text)
            })();
            let _ = CloseClipboard();
            out
        }
    }
}

#[cfg(not(windows))]
mod win32 {
    use super::*;
    pub fn write_native_host_registry(_browser: &str, _manifest_path: &str) -> Result<(), String> {
        Err("Windows Registry Native Messaging setup is only applicable on Windows".to_string())
    }
    pub fn is_native_host_registered(_browser: &str, _expected_manifest: &str) -> bool {
        false
    }
    pub fn clear_native_host_registry(_browser: &str) {}
    pub fn detect_browsers() -> Vec<DetectedBrowserInfo> {
        Vec::new()
    }
    pub fn list_candidate_windows() -> Vec<CandidateWindowInfo> {
        Vec::new()
    }
    pub fn dock_windows_side_by_side(
        _reader: isize,
        _companion: isize,
        _placement: &str,
        _ratio: f64,
        _compact: bool,
    ) -> Result<(bool, i32), String> {
        Err("Side-by-side window docking is currently supported on Windows desktop".to_string())
    }
    pub fn activate_window(_hwnd_val: isize) -> bool {
        false
    }
    pub fn is_valid_window(_hwnd_val: isize) -> bool {
        false
    }
    pub fn launch_app_window(
        _reader_hwnd_val: isize,
        opts: LaunchCompanionOptions,
    ) -> Result<LaunchCompanionResult, String> {
        let _ = validate_companion_https_url(&opts.url)?;
        Ok(LaunchCompanionResult {
            ok: true,
            hwnd: None,
            launched: false,
            window_found: false,
            docked: false,
            tight_screen: false,
            fallback_default_browser: true,
            process_name: None,
            error: None,
        })
    }
    pub fn dock_new_browser_window_blocking(
        _reader_hwnd_val: isize,
        _before_hwnds: Vec<isize>,
        _placement: String,
        _ratio: f64,
        _compact_reader: bool,
    ) -> LaunchCompanionResult {
        LaunchCompanionResult {
            ok: false,
            hwnd: None,
            launched: false,
            window_found: false,
            docked: false,
            tight_screen: false,
            fallback_default_browser: false,
            process_name: None,
            error: Some("Window docking is only supported on Windows desktop".to_string()),
        }
    }
    pub fn update_snap_watcher(
        _app: Option<&tauri::AppHandle>,
        _reader_hwnd: isize,
        _companion_hwnd: isize,
        _placement: &str,
        _ratio: f64,
        _compact_reader: bool,
        _enabled: bool,
    ) {
    }
    pub fn set_clipboard_text(_text: &str) -> Result<(), String> {
        Err("Native Win32 clipboard fallback is Windows-only".to_string())
    }
    pub fn get_clipboard_text() -> Result<String, String> {
        Err("Native Win32 clipboard fallback is Windows-only".to_string())
    }
}

fn handle_extension_incoming(app: &tauri::AppHandle, state: &CompanionState, msg: serde_json::Value) {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if msg_type == "extension_hello" {
        if let Ok(mut g) = state.inner.lock() {
            g.native_connected = true;
            g.native_extension_id = msg
                .get("extensionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
    }
    if let Some(req_id) = msg.get("requestId").and_then(|v| v.as_str()) {
        if let Ok(mut g) = state.inner.lock() {
            if let Some(tx) = g.response_waiters.remove(req_id) {
                let _ = tx.send(msg.clone());
            }
        }
    }
    let _ = app.emit("companion:event", msg);
}

#[cfg(windows)]
fn start_pipe_server(app: tauri::AppHandle, stop: Arc<AtomicBool>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = user_scoped_pipe_name();
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        while !stop.load(Ordering::Relaxed) {
            let mut opts = ServerOptions::new();
            opts.reject_remote_clients(true);
            if first {
                opts.first_pipe_instance(true);
                first = false;
            }
            let Ok(server) = win32::create_user_scoped_named_pipe(&opts, &pipe_name) else {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                continue;
            };
            tokio::select! {
                res = server.connect() => {
                    if res.is_err() { continue; }
                }
                _ = async {
                    while !stop.load(Ordering::Relaxed) {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    }
                } => { break; }
            }

            let app_conn = app.clone();
            let stop_conn = stop.clone();
            tauri::async_runtime::spawn(async move {
                let (mut rd, mut wr) = tokio::io::split(server);
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
                let my_conn_id = {
                    let state = app_conn.state::<CompanionState>();
                    let mut id = 0u64;
                    if let Ok(mut g) = state.inner.lock() {
                        g.active_pipe_conn_id = g.active_pipe_conn_id.wrapping_add(1).max(1);
                        id = g.active_pipe_conn_id;
                        g.native_connected = true;
                        g.active_pipe_tx = Some(tx);
                    }
                    id
                };

                let writer_task = tauri::async_runtime::spawn(async move {
                    while let Some(frame) = rx.recv().await {
                        if wr.write_all(&frame).await.is_err() || wr.flush().await.is_err() {
                            break;
                        }
                    }
                });

                let mut hdr = [0u8; 4];
                while !stop_conn.load(Ordering::Relaxed) {
                    if rd.read_exact(&mut hdr).await.is_err() {
                        break;
                    }
                    let Ok(len) = decode_framed_header(hdr) else {
                        break;
                    };
                    let mut body = vec![0u8; len];
                    if rd.read_exact(&mut body).await.is_err() {
                        break;
                    }
                    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
                        let st = app_conn.state::<CompanionState>();
                        handle_extension_incoming(&app_conn, &st, json);
                    }
                }

                writer_task.abort();
                let state = app_conn.state::<CompanionState>();
                let mut cleared = false;
                if let Ok(mut g) = state.inner.lock() {
                    if g.active_pipe_conn_id == my_conn_id {
                        g.native_connected = false;
                        g.active_pipe_tx = None;
                        cleared = true;
                    }
                }
                if cleared {
                    let _ = app_conn.emit("companion:event", serde_json::json!({ "type": "host_disconnected" }));
                }
            });
        }
    });
}

#[cfg(not(windows))]
fn start_pipe_server(_app: tauri::AppHandle, _stop: Arc<AtomicBool>) {}

async fn start_relay_server(app: tauri::AppHandle, stop: Arc<AtomicBool>, expected_token: String) -> Option<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.ok()?;
    let port = listener.local_addr().ok()?.port();

    tauri::async_runtime::spawn(async move {
        while !stop.load(Ordering::Relaxed) {
            let accept_res = tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept()).await;
            let Ok(Ok((mut stream, _))) = accept_res else {
                continue;
            };
            let app_c = app.clone();
            let token_c = expected_token.clone();
            tauri::async_runtime::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let raw = String::from_utf8_lossy(&buf[..n]).to_string();
                let Some((head, initial_body)) = raw.split_once("\r\n\r\n") else {
                    let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                };
                let mut lines = head.lines();
                let req_line = lines.next().unwrap_or("");
                let mut parts = req_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("/");

                let mut origin: Option<String> = None;
                let mut auth_tok: Option<String> = None;
                let mut content_len: usize = 0;
                for line in lines {
                    if let Some((k, v)) = line.split_once(':') {
                        let kl = k.trim().to_ascii_lowercase();
                        let val = v.trim();
                        if kl == "origin" {
                            origin = Some(val.to_string());
                        } else if kl == "x-linden-token" {
                            auth_tok = Some(val.to_string());
                        } else if kl == "content-length" {
                            content_len = val.parse().unwrap_or(0);
                        }
                    }
                }

                if content_len > MAX_IPC_MESSAGE_BYTES {
                    let _ = stream.write_all(b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }
                if !is_allowed_extension_origin(origin.as_deref())
                    || !auth_tok.as_deref().map(|t| constant_time_eq(t, &token_c)).unwrap_or(false)
                {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                }

                let (status_line, json_resp) = match (method, path) {
                    ("GET", "/ping") => ("200 OK", serde_json::json!({ "ok": true })),
                    ("GET", "/pull") => {
                        let cmds: Vec<serde_json::Value> = {
                            let st = app_c.state::<CompanionState>();
                            let mut g = st.inner.lock().unwrap_or_else(|e| e.into_inner());
                            g.pending_commands.drain(..).collect()
                        };
                        ("200 OK", serde_json::json!({ "ok": true, "commands": cmds }))
                    }
                    ("POST", "/event") => {
                        let mut body_bytes = initial_body.as_bytes().to_vec();
                        while body_bytes.len() < content_len {
                            let mut chunk = [0u8; 4096];
                            let m = stream.read(&mut chunk).await.unwrap_or(0);
                            if m == 0 {
                                break;
                            }
                            body_bytes.extend_from_slice(&chunk[..m]);
                        }
                        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body_bytes[..content_len.min(body_bytes.len())]) {
                            let st = app_c.state::<CompanionState>();
                            handle_extension_incoming(&app_c, &st, json);
                            ("200 OK", serde_json::json!({ "ok": true }))
                        } else {
                            ("400 Bad Request", serde_json::json!({ "ok": false, "error": "invalid_json" }))
                        }
                    }
                    _ => ("404 Not Found", serde_json::json!({ "ok": false })),
                };
                let body_str = json_resp.to_string();
                let resp = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status_line,
                    body_str.len(),
                    body_str
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            });
        }
    });
    Some(port)
}

#[tauri::command]
pub fn companion_detect_browsers() -> Vec<DetectedBrowserInfo> {
    win32::detect_browsers()
}

#[tauri::command]
pub fn companion_list_candidate_windows() -> Vec<CandidateWindowInfo> {
    win32::list_candidate_windows()
}

fn relax_reader_min_size(window: &Window) {
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(520.0_f64, 540.0_f64)));
}

fn restore_reader_min_size(app: &tauri::AppHandle) {
    for win in app.webview_windows().values() {
        let _ = win.set_min_size(Some(tauri::LogicalSize::new(960.0_f64, 640.0_f64)));
    }
}

#[tauri::command]
pub fn companion_snapshot_browser_hwnds() -> Vec<isize> {
    win32::list_candidate_windows()
        .into_iter()
        .filter(|w| w.is_browser)
        .map(|w| w.hwnd)
        .collect()
}

#[tauri::command]
pub async fn companion_launch_app_window(
    window: Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    options: LaunchCompanionOptions,
) -> Result<LaunchCompanionResult, String> {
    let snap = options.snap_enabled.unwrap_or(false);
    let placement = options.placement.clone().unwrap_or_else(|| "right".to_string());
    let ratio = options.split_ratio.unwrap_or(0.58);
    let compact = options.compact_reader.unwrap_or(false);

    if options.auto_dock.unwrap_or(true) {
        relax_reader_min_size(&window);
    }

    #[cfg(windows)]
    let reader_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let reader_hwnd: isize = 0;

    let res = tokio::task::spawn_blocking(move || win32::launch_app_window(reader_hwnd, options))
        .await
        .map_err(|e| format!("Companion launch task failed: {e}"))??;

    if let Ok(mut g) = state.inner.lock() {
        if let Some(hwnd) = res.hwnd {
            g.tracked_companion_hwnd = Some(hwnd);
        }
        g.snap_enabled = snap && res.docked;
    }
    if snap && res.docked {
        if let Some(comp_hwnd) = res.hwnd {
            win32::update_snap_watcher(Some(&app), reader_hwnd, comp_hwnd, &placement, ratio, compact, true);
        }
    }
    Ok(res)
}

#[tauri::command]
pub async fn companion_dock_new_browser_window(
    window: Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    before_hwnds: Vec<isize>,
    placement: Option<String>,
    split_ratio: Option<f64>,
    compact_reader: Option<bool>,
    snap_enabled: Option<bool>,
) -> Result<LaunchCompanionResult, String> {
    let place = placement.unwrap_or_else(|| "right".to_string());
    let ratio = split_ratio.unwrap_or(0.58);
    let compact = compact_reader.unwrap_or(false);
    let snap = snap_enabled.unwrap_or(true);

    relax_reader_min_size(&window);

    #[cfg(windows)]
    let reader_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let reader_hwnd: isize = 0;

    let place_bg = place.clone();
    let res = tokio::task::spawn_blocking(move || {
        win32::dock_new_browser_window_blocking(reader_hwnd, before_hwnds, place_bg, ratio, compact)
    })
    .await
    .map_err(|e| format!("Companion popup dock task failed: {e}"))?;

    if let Ok(mut g) = state.inner.lock() {
        if let Some(hwnd) = res.hwnd {
            g.tracked_companion_hwnd = Some(hwnd);
        }
        g.snap_enabled = snap && res.docked;
    }
    if snap && res.docked {
        if let Some(comp_hwnd) = res.hwnd {
            win32::update_snap_watcher(Some(&app), reader_hwnd, comp_hwnd, &place, ratio, compact, true);
        }
    }
    Ok(res)
}

#[tauri::command]
pub fn companion_dock_side_by_side(
    window: Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    companion_hwnd: isize,
    placement: Option<String>,
    split_ratio: Option<f64>,
    compact_reader: Option<bool>,
    snap_enabled: Option<bool>,
) -> Result<DockResult, String> {
    relax_reader_min_size(&window);

    #[cfg(windows)]
    let reader_hwnd = window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let reader_hwnd: isize = 0;

    let place = placement.unwrap_or_else(|| "right".to_string());
    let ratio = split_ratio.unwrap_or(0.58);
    let compact = compact_reader.unwrap_or(false);
    let snap = snap_enabled.unwrap_or(true);
    let (tight_screen, logical_work_width) =
        win32::dock_windows_side_by_side(reader_hwnd, companion_hwnd, &place, ratio, compact)?;
    if let Ok(mut g) = state.inner.lock() {
        g.tracked_companion_hwnd = Some(companion_hwnd);
        g.snap_enabled = snap;
    }
    win32::update_snap_watcher(Some(&app), reader_hwnd, companion_hwnd, &place, ratio, compact, snap);
    Ok(DockResult {
        ok: true,
        companion_hwnd,
        tight_screen,
        logical_work_width,
        snap_enabled: snap,
        error: None,
    })
}

#[tauri::command]
pub fn companion_set_snap_state(
    window: Window,
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    enabled: bool,
    companion_hwnd: Option<isize>,
    placement: Option<String>,
    split_ratio: Option<f64>,
    compact_reader: Option<bool>,
) -> bool {
    #[cfg(windows)]
    let reader_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let reader_hwnd: isize = 0;

    let target_hwnd = {
        let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.snap_enabled = enabled;
        companion_hwnd.or(g.tracked_companion_hwnd).unwrap_or(0)
    };
    win32::update_snap_watcher(
        Some(&app),
        reader_hwnd,
        target_hwnd,
        placement.as_deref().unwrap_or("right"),
        split_ratio.unwrap_or(0.58),
        compact_reader.unwrap_or(false),
        enabled && target_hwnd != 0,
    );
    enabled
}

#[tauri::command]
pub fn companion_activate_window(companion_hwnd: isize) -> bool {
    win32::activate_window(companion_hwnd)
}

#[tauri::command]
pub fn companion_is_window_alive(companion_hwnd: isize) -> bool {
    win32::is_valid_window(companion_hwnd)
}

#[tauri::command]
pub async fn companion_start_bridge(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    enable_relay: Option<bool>,
) -> Result<BridgeStatusInfo, String> {
    let want_relay = enable_relay.unwrap_or(true);
    let (already_running, need_relay, existing_token) = {
        let g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        (g.bridge_running, want_relay && g.relay_port.is_none(), g.relay_token.clone())
    };
    if !already_running {
        let stop = Arc::new(AtomicBool::new(false));
        let token = existing_token.unwrap_or_else(|| generate_random_hex_token(16));
        {
            let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            g.bridge_running = true;
            g.stop_signal = Some(stop.clone());
            g.relay_token = Some(token.clone());
        }
        start_pipe_server(app.clone(), stop.clone());
        if want_relay {
            if let Some(port) = start_relay_server(app.clone(), stop, token).await {
                if let Ok(mut g) = state.inner.lock() {
                    g.relay_port = Some(port);
                }
            }
        }
    } else if need_relay {
        let (stop_opt, tok) = {
            let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            let t = g.relay_token.clone().unwrap_or_else(|| generate_random_hex_token(16));
            g.relay_token = Some(t.clone());
            (g.stop_signal.clone(), t)
        };
        if let Some(stop) = stop_opt {
            if let Some(port) = start_relay_server(app.clone(), stop, tok).await {
                if let Ok(mut g) = state.inner.lock() {
                    g.relay_port = Some(port);
                }
            }
        }
    }
    Ok(companion_get_status(app, state))
}

#[tauri::command]
pub fn companion_stop_bridge(app: tauri::AppHandle, state: tauri::State<'_, CompanionState>) -> bool {
    win32::update_snap_watcher(None, 0, 0, "right", 0.58, false, false);
    restore_reader_min_size(&app);
    if let Ok(mut g) = state.inner.lock() {
        if let Some(stop) = g.stop_signal.take() {
            stop.store(true, Ordering::Relaxed);
        }
        g.bridge_running = false;
        g.native_connected = false;
        g.active_pipe_tx = None;
        g.relay_port = None;
        g.snap_enabled = false;
        g.pending_commands.clear();
        g.response_waiters.clear();
        true
    } else {
        false
    }
}

#[tauri::command]
pub fn companion_get_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
) -> BridgeStatusInfo {
    let (chrome_manifest, edge_manifest) = resolve_native_manifest_paths();
    let chrome_str = chrome_manifest.to_string_lossy().to_string();
    let edge_str = edge_manifest.to_string_lossy().to_string();
    let ext_dir = resolve_extension_dir(Some(&app)).to_string_lossy().to_string();
    let g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    BridgeStatusInfo {
        running: g.bridge_running,
        native_connected: g.native_connected,
        native_extension_id: g.native_extension_id.clone(),
        relay_port: g.relay_port,
        relay_token: g.relay_token.clone(),
        pipe_name: user_scoped_pipe_name(),
        extension_dir: ext_dir,
        tracked_hwnd: g.tracked_companion_hwnd,
        snap_enabled: g.snap_enabled,
        chrome_manifest_registered: win32::is_native_host_registered("chrome", &chrome_str),
        edge_manifest_registered: win32::is_native_host_registered("edge", &edge_str),
    }
}

#[tauri::command]
pub fn companion_install_native_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    extension_id: String,
    browser: Option<String>,
) -> Result<BridgeStatusInfo, String> {
    let clean_id = extension_id.trim().to_ascii_lowercase();
    if !is_valid_chromium_extension_id(&clean_id) {
        return Err("Invalid Chromium extension ID (must be 32 characters a-p)".to_string());
    }
    let exe = std::env::current_exe().map_err(|e| format!("Cannot resolve exe path: {e}"))?;
    let exe_str = exe.to_string_lossy().to_string();
    let (chrome_manifest, edge_manifest) = resolve_native_manifest_paths();
    if let Some(parent) = chrome_manifest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let allowed = vec![format!("chrome-extension://{}/", clean_id)];
    let build_manifest = |origins: &[String]| {
        serde_json::json!({
            "name": NATIVE_HOST_NAME,
            "description": "Linden Leaf External AI Companion Host",
            "path": exe_str,
            "type": "stdio",
            "allowed_origins": origins
        })
    };
    let target = browser.as_deref().unwrap_or("both");
    if target == "chrome" || target == "both" {
        let json = serde_json::to_string_pretty(&build_manifest(&allowed)).map_err(|e| e.to_string())?;
        std::fs::write(&chrome_manifest, json).map_err(|e| e.to_string())?;
        win32::write_native_host_registry("chrome", &chrome_manifest.to_string_lossy())?;
    }
    if target == "edge" || target == "both" {
        let json = serde_json::to_string_pretty(&build_manifest(&allowed)).map_err(|e| e.to_string())?;
        std::fs::write(&edge_manifest, json).map_err(|e| e.to_string())?;
        win32::write_native_host_registry("edge", &edge_manifest.to_string_lossy())?;
    }
    Ok(companion_get_status(app, state))
}

#[tauri::command]
pub fn companion_uninstall_native_host(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
) -> BridgeStatusInfo {
    win32::clear_native_host_registry("chrome");
    win32::clear_native_host_registry("edge");
    let (chrome_manifest, edge_manifest) = resolve_native_manifest_paths();
    let _ = std::fs::remove_file(chrome_manifest);
    let _ = std::fs::remove_file(edge_manifest);
    companion_get_status(app, state)
}

#[tauri::command]
pub async fn companion_send_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, CompanionState>,
    command: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let request_id = command
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("cmp_{}", crate::commands::window::next_request_id("req")));

    let mut payload = command;
    if let Some(obj) = payload.as_object_mut() {
        obj.entry("requestId".to_string())
            .or_insert_with(|| serde_json::Value::String(request_id.clone()));
    }
    let json_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let frame = encode_framed_message(&json_bytes)?;

    let rx = {
        let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
        g.response_waiters.insert(request_id.clone(), tx);

        if let Some(ref pipe_tx) = g.active_pipe_tx {
            let _ = pipe_tx.send(frame);
        } else if g.relay_port.is_some() {
            g.pending_commands.push_back(payload);
            while g.pending_commands.len() > 24 {
                g.pending_commands.pop_front();
            }
        } else {
            g.response_waiters.remove(&request_id);
            return Ok(serde_json::json!({
                "ok": false,
                "reason": "bridge_offline",
                "requestId": request_id
            }));
        }
        rx
    };

    let wait_dur = std::time::Duration::from_millis(timeout_ms.unwrap_or(2800).clamp(300, 10000));
    let res = tokio::time::timeout(wait_dur, rx).await;
    let _ = &app;
    if let Ok(mut g) = state.inner.lock() {
        g.response_waiters.remove(&request_id);
    }
    match res {
        Ok(Ok(val)) => Ok(val),
        _ => Ok(serde_json::json!({
            "ok": false,
            "reason": "timeout",
            "requestId": request_id
        })),
    }
}

#[tauri::command]
pub fn companion_open_extension_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = resolve_extension_dir(Some(&app));
    let dir_str = dir.to_string_lossy().to_string();
    if !dir.exists() {
        return Err(format!("Companion extension folder not found at {}", dir_str));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }
    Ok(dir_str)
}

#[tauri::command]
pub fn companion_clipboard_write(text: String) -> Result<bool, String> {
    if text.len() > MAX_IPC_MESSAGE_BYTES {
        return Err("Clipboard payload exceeds size cap".to_string());
    }
    win32::set_clipboard_text(&text)?;
    Ok(true)
}

#[tauri::command]
pub fn companion_clipboard_read() -> Result<String, String> {
    win32::get_clipboard_text()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extension_id_and_https_validation() {
        assert!(is_valid_chromium_extension_id("abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_valid_chromium_extension_id("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"));
        assert!(!is_valid_chromium_extension_id("short"));
        assert!(!is_valid_chromium_extension_id("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));

        assert!(validate_companion_https_url("https://chatgpt.com/c/123").is_ok());
        assert!(validate_companion_https_url("https://gemini.google.com/app").is_ok());
        assert!(validate_companion_https_url("http://chatgpt.com").is_err());
        assert!(validate_companion_https_url("javascript:alert(1)").is_err());

        assert!(is_allowed_extension_origin(Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop")));
        assert!(!is_allowed_extension_origin(Some("https://evil.example")));
    }

    #[test]
    fn test_framed_ipc_roundtrip_and_limits() {
        let msg = br#"{"type":"ping"}"#;
        let encoded = encode_framed_message(msg).unwrap();
        assert_eq!(encoded.len(), 4 + msg.len());
        let len = decode_framed_header([encoded[0], encoded[1], encoded[2], encoded[3]]).unwrap();
        assert_eq!(len, msg.len());
        assert_eq!(&encoded[4..], msg);

        assert!(decode_framed_header([0, 0, 0, 0]).is_err());
        assert!(encode_framed_message(&vec![b'a'; MAX_IPC_MESSAGE_BYTES + 1]).is_err());
    }

    #[test]
    fn test_side_by_side_layout_dpi_and_work_area() {
        // 1920x1080 at 150% DPI -> logical 1280px wide; standard reader min 760 + 360 = 1120 fits!
        let work_1080 = RectPx { left: 0, top: 0, right: 1920, bottom: 1032 };
        let plan = compute_side_by_side_layout(work_1080.clone(), 1.5, 0.60, "right", false);
        assert_eq!(plan.logical_work_width, 1280);
        assert!(!plan.tight_screen);
        assert_eq!(plan.reader_visual.left, 0);
        assert_eq!(plan.companion_visual.left, plan.reader_visual.right);
        assert_eq!(plan.companion_visual.right, 1920);
        assert_eq!(plan.reader_visual.height(), 1032);

        // Very tight 960 logical px screen without compact reader flags tight_screen = true
        let work_tight = RectPx { left: 1920, top: 0, right: 2880, bottom: 1040 };
        let tight_plan = compute_side_by_side_layout(work_tight.clone(), 1.0, 0.58, "right", false);
        assert!(tight_plan.tight_screen);
        assert_eq!(tight_plan.reader_visual.left, 1920);
        assert_eq!(tight_plan.companion_visual.right, 2880);

        // Enabling compact reader lowers reader floor to 520 logical px so 960px screen fits without tight warning
        let compact_plan = compute_side_by_side_layout(work_tight, 1.0, 0.58, "right", true);
        assert!(!compact_plan.tight_screen);
    }

    #[cfg(windows)]
    #[test]
    fn test_current_user_dacl_sddl_is_scoped_to_sid() {
        let sddl = win32::build_current_user_dacl_sddl().expect("current user SID SDDL should resolve");
        assert!(sddl.starts_with("D:P(A;;GA;;;S-1-"), "Unexpected SDDL: {}", sddl);
        assert!(sddl.ends_with(')'));
    }
}
