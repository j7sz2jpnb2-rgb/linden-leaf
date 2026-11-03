pub mod commands;

use commands::*;
use tauri::Manager;

#[tauri::command]
fn app_write_debug_log(message: String) {
    // Keep diagnostics portable. Persisted debug logs, when needed, should use
    // Tauri's app-data directory rather than a developer-specific absolute path.
    eprintln!("[renderer] {message}");
}

#[cfg(target_os = "android")]
pub struct LindenMobileBridge(pub tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
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
                            if let Ok(payload) = load_open_file_payload(&file_path) {
                                let _ = w.emit("app:open-file", payload);
                            }
                        }
                    } else {
                        state
                            .pending_files
                            .lock()
                            .unwrap()
                            .push((Some(new_label.clone()), file_path));
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
                        if let Ok(payload) = load_open_file_payload(&file_path) {
                            let _ = app.emit("app:open-file", payload);
                        }
                    } else {
                        state.pending_files.lock().unwrap().push((None, file_path));
                    }
                }
            }
        }
    }));

    builder
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
            app.manage(AiState::default());

            let args: Vec<String> = std::env::args().collect();
            let file_paths = extract_book_paths_from_args(&args);
            eprintln!("[TAURI SETUP] Extracted book paths from args: {:?}", file_paths);
            if !file_paths.is_empty() {
                let state = app.state::<AppState>();
                let mut pending = state.pending_files.lock().unwrap();
                for file_path in file_paths {
                    pending.push((Some("main".to_string()), file_path));
                }
            }

            if let Some(w) = app.get_webview_window("main") {
                eprintln!("[TAURI SETUP] Main window found: {:?}", w.label());
                #[cfg(debug_assertions)]
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
                        let mut close_map = state.close_state.lock().unwrap();
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
                        let _ = window.emit(
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
                                let mut close_map = state.close_state.lock().unwrap();
                                let close_state = close_map.entry(label_clone.clone()).or_default();
                                if close_state.pending_request_id.as_ref() == Some(&id_clone) {
                                    eprintln!("[WINDOW EVENT] Flush timeout for {:?} on {:?}; forcing close fallback", id_clone, label_clone);
                                    close_state.pending_request_id = None;
                                    close_state.close_permitted = true;
                                    true
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
            dialog_save_text_file,
            fs_read_buffer,
            // Window & App
            window_open_new,
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
            resource_clear_audio_cache,
            // MuPDF Native Reader
            mupdf_is_available,
            mupdf_set_store_limit,
            mupdf_stage_pdf,
            mupdf_open_document,
            mupdf_get_page_sizes,
            mupdf_get_page_bounds_range,
            mupdf_get_outline_flat,
            mupdf_get_text_layer,
            mupdf_select,
            mupdf_get_links,
            mupdf_render_page,
            mupdf_cancel_render,
            mupdf_enable_diagnostics,
            mupdf_get_render_diagnostics,
            mupdf_close_document,
            mupdf_reclaim_snapshot,
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
            tts_request_audio,
            tts_cancel_audio,
            android_get_pending_imports,
            android_consume_pending_import,
            android_save_image_to_gallery,
            android_share_image,
            android_get_system_insets,
            android_set_tts_sleep_timer,
            android_set_tts_rate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Linden Leaf Tauri application");
}
