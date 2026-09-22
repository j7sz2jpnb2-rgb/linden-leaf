pub mod commands;

use commands::*;
use tauri::Manager;

#[tauri::command]
fn app_write_debug_log(message: String) {
    // Keep diagnostics portable. Persisted debug logs, when needed, should use
    // Tauri's app-data directory rather than a developer-specific absolute path.
    eprintln!("[renderer] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }

            let file_paths = extract_book_paths_from_args_with_cwd(&argv, Some(&_cwd));
            if !file_paths.is_empty() {
                let state = app.state::<AppState>();
                let is_ready = *state.is_renderer_ready.lock().unwrap();
                for file_path in file_paths {
                    if is_ready {
                        match load_open_file_payload(&file_path) {
                            Ok(payload) => {
                                let _ = app.emit("app:open-file", payload);
                            }
                            Err(e) => {
                                eprintln!("[single_instance] Error loading file: {}", e);
                            }
                        }
                    } else {
                        state.pending_files.lock().unwrap().push(file_path);
                    }
                }
            }
        }))
        .setup(|app| {
            eprintln!("[TAURI SETUP] Setting up application...");
            if let Ok(exe_path) = std::env::current_exe() {
                eprintln!("[TAURI SETUP] EXE Path: {}", exe_path.display());
            }
            if let Ok(build_info) = std::fs::read_to_string("../dist-tauri/build-info.json") {
                eprintln!("[TAURI SETUP] Build Info: {}", build_info.trim());
            } else if let Ok(build_info) = std::fs::read_to_string("dist-tauri/build-info.json") {
                eprintln!("[TAURI SETUP] Build Info: {}", build_info.trim());
            }
            app.manage(AppState::default());

            let args: Vec<String> = std::env::args().collect();
            let file_paths = extract_book_paths_from_args(&args);
            eprintln!("[TAURI SETUP] Extracted book paths from args: {:?}", file_paths);
            if !file_paths.is_empty() {
                let state = app.state::<AppState>();
                let mut pending = state.pending_files.lock().unwrap();
                for file_path in file_paths {
                    pending.push(file_path);
                }
            }

            if let Some(w) = app.get_webview_window("main") {
                eprintln!("[TAURI SETUP] Main window found: {:?}", w.label());
                #[cfg(debug_assertions)]
                {
                    let _ = w.open_devtools();
                }
            } else {
                eprintln!("[TAURI SETUP] WARNING: Main window NOT found in setup!");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    eprintln!("[WINDOW EVENT] {:?} CloseRequested", window.label());
                    let state = window.state::<AppState>();
                    let mut permitted = state.close_permitted.lock().unwrap();
                    if *permitted {
                        eprintln!("[WINDOW EVENT] Close already permitted, closing now.");
                        return;
                    }
                    api.prevent_close();

                    let mut closing_id = state.closing_request_id.lock().unwrap();
                    if closing_id.is_some() {
                        eprintln!("[WINDOW EVENT] Flush already in progress for {:?}", *closing_id);
                        return;
                    }
                    let req_id = format!("flush_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
                    *closing_id = Some(req_id.clone());
                    drop(closing_id);
                    drop(permitted);

                    use tauri::Emitter;
                    let _ = window.emit("app:request-flush", serde_json::json!({ "requestId": req_id }));

                    let window_clone = window.clone();
                    let req_id_clone = req_id.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                        let state = window_clone.state::<AppState>();
                        let mut closing_id = state.closing_request_id.lock().unwrap();
                        if closing_id.as_ref() == Some(&req_id_clone) {
                            eprintln!("[WINDOW EVENT] Flush timeout for {:?}; forcing close fallback", req_id_clone);
                            *closing_id = None;
                            let mut permitted = state.close_permitted.lock().unwrap();
                            *permitted = true;
                            let _ = window_clone.close();
                        }
                    });
                }
                tauri::WindowEvent::Destroyed => {
                    eprintln!("[WINDOW EVENT] {:?} Destroyed", window.label());
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_write_debug_log,
            // Dialog & FS
            dialog_open_file,
            fs_read_buffer,
            // Window & App
            window_minimize,
            window_maximize,
            window_close,
            window_is_maximized,
            window_toggle_fullscreen,
            window_is_fullscreen,
            shell_open_external,
            app_get_version,
            app_renderer_ready,
            app_flush_complete,
            // Sync & DPAPI
            sync_get_config,
            sync_save_config,
            sync_reveal_password,
            sync_test_connection,
            sync_fetch_remote,
            sync_save_remote,
            sync_upload_book_binary,
            sync_download_book_binary,
            sync_delete_book_binary,
            // MuPDF Native Reader
            mupdf_is_available,
            mupdf_open_document,
            mupdf_get_page_sizes,
            mupdf_get_page_bounds_range,
            mupdf_get_outline_flat,
            mupdf_get_text_layer,
            mupdf_select,
            mupdf_get_links,
            mupdf_render_page,
            mupdf_cancel_render,
            mupdf_close_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Linden Leaf Tauri application");
}
