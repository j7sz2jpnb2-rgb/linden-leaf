mod content_hash;
pub mod commands;

pub use commands::ai_companion::run_native_messaging_host;
use commands::*;
use tauri::Manager;

#[tauri::command]
fn app_write_debug_log(message: String) {
    // Keep diagnostics portable. Persisted debug logs, when needed, should use
    // Tauri's app-data directory rather than a developer-specific absolute path.
    eprintln!("[renderer] {message}");
}

fn format_sanitized_panic_record(info: &std::panic::PanicHookInfo<'_>) -> String {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let thread = std::thread::current()
        .name()
        .unwrap_or("unnamed")
        .to_string();
    let location = info
        .location()
        .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
        .unwrap_or_else(|| "unknown".to_string());
    // Intentionally omit panic payload strings so user file paths or secrets are never persisted.
    format!(
        "version={} ts_ms={} thread={} location={}\n",
        env!("CARGO_PKG_VERSION"),
        ts_ms,
        thread,
        location
    )
}

fn install_panic_recorder(app_data_dir: Option<std::path::PathBuf>) {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(ref dir) = app_data_dir {
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(dir.join("crash-last.txt"), format_sanitized_panic_record(info));
            }
            prev(info);
        }));
    });
}

#[cfg(target_os = "android")]
pub struct LindenMobileBridge(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = commands::window::init_process_start_epoch_ms();
    let builder = tauri::Builder::default();

    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("linden")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.lindenleaf.reader", "LindenPlugin")?;
                app.manage(LindenMobileBridge(handle));
                Ok(())
            })
            .build(),
    );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = if std::env::var_os("LINDEN_SINGLE_INSTANCE_KEY").is_some()
        || std::env::var_os("LINDEN_DISABLE_SINGLE_INSTANCE").is_some()
        || std::env::var_os("DISABLE_SINGLE_INSTANCE").is_some()
    {
        eprintln!("[single_instance] Single instance plugin bypassed by environment");
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        use tauri::Emitter;
        let file_paths = extract_book_paths_from_args_with_cwd(&argv, Some(&_cwd));

        // When launched with no file paths (e.g. user double-clicks desktop shortcut),
        // only unminimize, show, and focus the existing main bookshelf window
        // to prevent duplicate bookshelf instances and WebDAV sync race conditions.
        if file_paths.is_empty() {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            return;
        }

        // When file paths are provided, spawn a dedicated new window for reading.
        for file_path in &file_paths {
            if file_path.to_ascii_lowercase().ends_with(".pdf") {
                let p = std::path::Path::new(file_path);
                let _ = authorize_direct_pdf_path(p);
                prewarm_pdf_launch(app, file_path.clone());
            }
        }
        match spawn_new_app_window(app, None, None, None) {
            Ok((new_label, _already_exists)) => {
                let state = app.state::<AppState>();
                let is_win_ready = state
                    .ready_windows
                    .lock()
                    .unwrap()
                    .get(&new_label)
                    .copied()
                    .unwrap_or(false);
                for file_path in file_paths {
                    if is_win_ready {
                        if let Some(w) = app.get_webview_window(&new_label) {
                            let req_id = next_request_id(&format!("req_{}", new_label));
                            if let Ok(payload) = load_open_file_payload(&file_path, Some(new_label.clone()), Some(req_id)) {
                                let _ = w.emit_to(&new_label, "app:open-file", payload);
                            }
                        }
                    } else {
                        state
                            .pending_files
                            .lock()
                            .unwrap()
                            .push((Some(new_label.clone()), file_path.clone()));
                        state.initial_boot_files.lock().unwrap().push((Some(new_label.clone()), file_path));
                    }
                }
            }
            Err(err) => {
                eprintln!("[single_instance] Fallback to main window ({err})");
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let state = app.state::<AppState>();
                let is_ready = state
                    .ready_windows
                    .lock()
                    .unwrap()
                    .get("main")
                    .copied()
                    .unwrap_or(false);
                for file_path in file_paths {
                    if is_ready {
                        let req_id = next_request_id("req_main");
                        if let Ok(payload) = load_open_file_payload(&file_path, Some("main".to_string()), Some(req_id)) {
                            let _ = app.emit_to("main", "app:open-file", payload);
                        }
                    } else {
                        state.pending_files.lock().unwrap().push((None, file_path.clone()));
                        state.initial_boot_files.lock().unwrap().push((None, file_path));
                    }
                }
            }
        }
    }))
    };

    builder
        .setup(|app| {
            eprintln!("[TAURI SETUP] Setting up application...");
            let app_data_dir = app.path().app_data_dir().ok();
            install_panic_recorder(app_data_dir.clone());
            crate::commands::fs::set_cached_app_dirs(
                app_data_dir,
                app.path().resource_dir().ok(),
            );
            crate::commands::fs::set_cached_extra_app_dirs(
                app.path().app_config_dir().ok(),
                app.path().app_cache_dir().ok(),
            );
            if let Ok(exe_path) = std::env::current_exe() {
                eprintln!("[TAURI SETUP] EXE Path: {}", exe_path.display());
            }
            if let Ok(build_info) = std::fs::read_to_string("../dist-tauri/build-info.json") {
                eprintln!("[TAURI SETUP] Build Info: {}", build_info.trim());
            } else if let Ok(build_info) = std::fs::read_to_string("dist-tauri/build-info.json") {
                eprintln!("[TAURI SETUP] Build Info: {}", build_info.trim());
            }
            app.manage(AppState::default());
            app.manage(AiState::default());
            app.manage(CompanionState::default());
            app.manage(SiwcState::default());

            let args: Vec<String> = std::env::args().collect();
            let file_paths = extract_book_paths_from_args(&args);
            eprintln!("[TAURI SETUP] Extracted book paths from args: {:?}", file_paths);
            if !file_paths.is_empty() {
                let state = app.state::<AppState>();
                let mut pending = state.pending_files.lock().unwrap_or_else(|e| e.into_inner());
                for file_path in file_paths {
                    if file_path.to_ascii_lowercase().ends_with(".pdf") {
                        let _ = authorize_direct_pdf_path(std::path::Path::new(&file_path));
                        prewarm_pdf_launch(app.handle(), file_path.clone());
                    }
                    pending.push((Some("main".to_string()), file_path.clone()));
                    state
                        .initial_boot_files
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((Some("main".to_string()), file_path));
                }
            }

            if let Some(w) = app.get_webview_window("main") {
                eprintln!("[TAURI SETUP] Main window found: {:?}", w.label());
                #[cfg(all(debug_assertions, feature = "devtools"))]
                if std::env::var_os("LINDEN_OPEN_DEVTOOLS").is_some() {
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
                    let win_label = window.label().to_string();
                    eprintln!("[WINDOW EVENT] {:?} CloseRequested", win_label);
                    let state = window.state::<AppState>();
                    let (should_prevent, req_id) = {
                        let mut close_map = state.close_state.lock().unwrap_or_else(|e| e.into_inner());
                        let close_state = close_map.entry(win_label.clone()).or_default();
                        if close_state.close_permitted {
                            eprintln!("[WINDOW EVENT] Close already permitted for {:?}, closing now.", win_label);
                            (false, None)
                        } else if close_state.pending_request_id.is_some() {
                            eprintln!("[WINDOW EVENT] Flush already in progress for {:?}: {:?}", win_label, close_state.pending_request_id);
                            (true, None)
                        } else {
                            let id = format!(
                                "flush_{}_{}",
                                win_label,
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                            );
                            close_state.pending_request_id = Some(id.clone());
                            (true, Some(id))
                        }
                    };

                    if should_prevent {
                        api.prevent_close();
                    }

                    if let Some(id) = req_id {
                        use tauri::Emitter;
                        let _ = window.emit_to(
                            &win_label,
                            "app:request-flush",
                            serde_json::json!({
                                "requestId": id,
                                "windowLabel": win_label
                            }),
                        );

                        let window_clone = window.clone();
                        let id_clone = id.clone();
                        let label_clone = win_label.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
                            let state = window_clone.state::<AppState>();
                            let should_force_close = {
                                let mut close_map = state.close_state.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(close_state) = close_map.get_mut(&label_clone) {
                                    if close_state.pending_request_id.as_ref() == Some(&id_clone) {
                                        eprintln!("[WINDOW EVENT] Flush timeout for {:?} on {:?}; forcing close fallback", id_clone, label_clone);
                                        close_state.pending_request_id = None;
                                        close_state.close_permitted = true;
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            };
                            if should_force_close {
                                let _ = window_clone.close();
                            }
                        });
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let win_label = window.label().to_string();
                    eprintln!("[WINDOW EVENT] {:?} Destroyed", win_label);
                    let state = window.state::<AppState>();
                    let _ = state.close_state.lock().map(|mut m| m.remove(&win_label));
                    let _ = state.ready_windows.lock().map(|mut m| m.remove(&win_label));
                    crate::commands::mupdf::mupdf_close_documents_for_window(&win_label);
                    if win_label == "main" {
                        let cstate = window.state::<CompanionState>();
                        companion_stop_bridge(window.app_handle().clone(), cstate);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_write_debug_log,
            // Dialog & FS
            dialog_open_file,
            dialog_open_dict_file,
            dialog_pick_folder,
            dialog_pick_sidecar_folder,
            dialog_save_text_file,
            dialog_pick_save_path,
            fs_scan_folder,
            fs_get_file_identity,
            fs_get_app_paths,
            fs_open_in_explorer,
            fs_read_buffer,
            fs_read_text_file,
            fs_register_sidecar_dir,
            fs_stage_epub_snapshot,
            fs_write_file,
            fs_write_binary_file,
            fs_compute_file_hash,
            // Window & App
            window_open_new,
            window_set_title,
            window_set_titlebar_theme,
            window_minimize,
            window_maximize,
            window_close,
            window_is_maximized,
            window_toggle_fullscreen,
            window_is_fullscreen,
            window_set_always_on_top,
            window_is_always_on_top,
            shell_open_external,
            app_get_version,
            app_get_boot_context,
            app_renderer_ready,
            app_flush_complete,
            app_write_boot_metrics,
            // Sync & DPAPI
            sync_get_config,
            sync_save_config,
            sync_test_connection,
            sync_fetch_remote,
            sync_save_remote,
            sync_read_file,
            sync_write_file,
            sync_upload_book_binary,
            sync_upload_book_binary_raw,
            sync_download_book_binary,
            sync_download_book_binary_raw,
            sync_delete_book_binary,
            sync_oauth_loopback_listen,
            sync_oauth_loopback_cancel,
            secure_store_credential,
            secure_load_credential,
            secure_has_credential,
            secure_delete_credential,
            // Native AI Request Layer & Safeguards
            ai_request_chat_completion,
            ai_abort_request,
            ai_get_status,
            ai_get_audit_log,
            ai_record_translation_diagnostic,
            ai_clear_audit_log,
            ai_set_cooldown_and_limit,
            ai_bind_credential,
            // External AI Browser Companion & Native Messaging / Side-by-Side
            companion_detect_browsers,
            companion_snapshot_browser_hwnds,
            companion_list_candidate_windows,
            companion_launch_app_window,
            companion_dock_new_browser_window,
            companion_dock_side_by_side,
            companion_set_snap_state,
            companion_activate_window,
            companion_is_window_alive,
            companion_start_bridge,
            companion_stop_bridge,
            companion_get_status,
            companion_install_native_host,
            companion_uninstall_native_host,
            companion_send_command,
            companion_open_extension_folder,
            companion_clipboard_write,
            companion_clipboard_read,
            // Sign in with ChatGPT Official Branch
            siwc_get_status,
            siwc_sign_out,
            siwc_cancel_sign_in,
            siwc_start_sign_in,
            ai_request_siwc_completion,
            // Offline ECDICT SQLite Dictionary & Resource Management
            dict_get_status,
            dict_lookup,
            dict_install_from_file,
            dict_download_and_install,
            dict_cancel_download,
            dict_get_download_progress,
            dict_uninstall,
            dict_get_resource_locations,
            dict_migrate_storage,
            dict_custom_begin_import,
            dict_custom_insert_batch,
            dict_custom_finish_import,
            dict_custom_list,
            dict_custom_toggle,
            dict_custom_delete,
            resource_clear_audio_cache,
            // Offline PP-OCRv6 & ONNX Runtime Asset Manager
            ocr_model_list_status,
            ocr_model_download,
            ocr_model_cancel_download,
            ocr_model_get_download_progress,
            ocr_model_read_asset,
            ocr_model_write_asset,
            ocr_model_delete,
            // Streaming Large TXT
            txt_open_stream,
            txt_read_chapter,
            txt_close_stream,
            // MuPDF Native Reader
            mupdf_is_available,
            mupdf_set_store_limit,
            mupdf_authorize_direct_pdf_path,
            mupdf_update_quick_index,
            mupdf_stage_pdf,
            mupdf_stage_pdf_bytes,
            mupdf_stage_pdf_chunk,
            mupdf_open_document,
            mupdf_get_page_sizes,
            mupdf_get_page_bounds_range,
            mupdf_get_outline_flat,
            mupdf_get_text_layer,
            mupdf_select,
            mupdf_get_links,
            mupdf_render_page,
            mupdf_plan_mobile_render,
            mupdf_render_mobile_tile,
            mupdf_cancel_render,
            mupdf_enable_diagnostics,
            mupdf_get_render_diagnostics,
            mupdf_close_document,
            mupdf_reclaim_snapshot,
            mupdf_validate_snapshot,
            mupdf_get_plain_text,
            mupdf_extract_annotations,
            mupdf_compute_auto_crop,
            mupdf_get_page_image_rects,
            mupdf_export_annotated_pdf,
            // Android SAF & Keystore & Media Background Playback
            android_resolve_content_uri,
            android_take_persistable_uri_permission,
            android_keystore_store,
            android_keystore_load,
            android_keystore_delete,
            android_start_background_tts,
            android_start_background_tts_queue,
            android_pause_background_tts,
            android_resume_background_tts,
            android_stop_background_tts,
            android_next_background_tts,
            android_prev_background_tts,
            android_get_playback_state,
            android_acknowledge_tts_listening,
            android_export_book_file,
            android_export_text_file,
            tts_request_audio,
            tts_cancel_audio,
            android_get_pending_imports,
            android_consume_pending_import,
            android_save_image_to_gallery,
            android_share_image,
            android_get_system_insets,
            android_capture_reader_page,
            android_set_tts_sleep_timer,
            android_set_tts_rate,
            android_get_tts_diagnostics,
            android_open_tts_settings,
            android_install_tts_voice_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Linden Leaf Tauri application");
}
