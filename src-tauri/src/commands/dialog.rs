use serde::{Deserialize, Serialize};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::PathBuf;

use crate::commands::{is_en_locale, l10n};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SelectedBookItem {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub filename: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct AndroidPickResult {
    #[serde(default)]
    items: Vec<SelectedBookItem>,
}

#[allow(dead_code)]
fn book_open_dialog_spec(locale: Option<&str>) -> (&'static str, Vec<(&'static str, &'static [&'static str])>) {
    let en = is_en_locale(locale);
    let title = l10n(en, "导入图书到 Linden Leaf 书架", "Import Books to Linden Leaf Shelf");
    let filters = vec![
        (
            l10n(en, "所有支持的电子书与文档", "All Supported Ebooks & Documents"),
            &["epub", "pdf", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz"][..],
        ),
        (l10n(en, "EPUB 电子书", "EPUB Ebook"), &["epub"][..]),
        (l10n(en, "PDF 文档", "PDF Document"), &["pdf"][..]),
        (l10n(en, "Word 文档 (.docx)", "Word Document (.docx)"), &["docx"][..]),
        (
            l10n(en, "Kindle 图书 (MOBI / AZW / AZW3)", "Kindle Ebooks (MOBI / AZW / AZW3)"),
            &["mobi", "azw", "azw3"][..],
        ),
        (l10n(en, "TXT / Markdown 文档", "TXT / Markdown Document"), &["txt", "md"][..]),
        (l10n(en, "漫画与归档 (CBZ / FB2)", "Comics & Archives (CBZ / FB2)"), &["cbz", "fb2"][..]),
        (l10n(en, "所有文件", "All Files"), &["*"][..]),
    ];
    (title, filters)
}

#[allow(dead_code)]
fn dict_open_dialog_spec(locale: Option<&str>) -> (&'static str, &'static str, &'static str) {
    let en = is_en_locale(locale);
    (
        l10n(en, "选择 ECDICT 词典数据库文件 (.db)", "Select ECDICT Dictionary Database File (.db)"),
        l10n(en, "ECDICT SQLite 数据库 (*.db)", "ECDICT SQLite Database (*.db)"),
        l10n(en, "所有文件", "All Files"),
    )
}

#[allow(dead_code)]
fn pick_folder_dialog_title(locale: Option<&str>) -> &'static str {
    l10n(
        is_en_locale(locale),
        "选择词典与资源存储目录",
        "Select Dictionary & Resource Storage Directory",
    )
}

#[allow(dead_code)]
fn save_dialog_defaults(title: Option<String>, locale: Option<&str>) -> (String, &'static str) {
    let en = is_en_locale(locale);
    let dialog_title = title.unwrap_or_else(|| l10n(en, "另存为文件", "Save File As").to_string());
    let all_files = l10n(en, "所有文件 (*.*)", "All Files (*.*)");
    (dialog_title, all_files)
}

#[allow(dead_code)]
fn save_text_extension_filter(
    default_name: &str,
    locale: Option<&str>,
) -> Option<(&'static str, &'static [&'static str])> {
    let en = is_en_locale(locale);
    let lower = default_name.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        Some((l10n(en, "Markdown 文档 (*.md)", "Markdown Document (*.md)"), &["md", "markdown"]))
    } else if lower.ends_with(".json") {
        Some((l10n(en, "JSON 备份文件 (*.json)", "JSON Backup File (*.json)"), &["json"]))
    } else if lower.ends_with(".txt") {
        Some((l10n(en, "文本文档 (*.txt)", "Text Document (*.txt)"), &["txt"]))
    } else if lower.ends_with(".csv") {
        Some((l10n(en, "CSV 表格 (*.csv)", "CSV Spreadsheet (*.csv)"), &["csv"]))
    } else {
        None
    }
}

#[tauri::command]
pub async fn dialog_open_file(
    #[allow(unused)] app_handle: tauri::AppHandle,
    #[allow(unused)] locale: Option<String>,
) -> Result<Option<Vec<SelectedBookItem>>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let files: Option<Vec<PathBuf>> = tokio::task::spawn_blocking(move || {
            let (title, filters) = book_open_dialog_spec(locale.as_deref());
            let mut dialog = rfd::FileDialog::new().set_title(title);
            for (name, exts) in filters {
                dialog = dialog.add_filter(name, exts);
            }
            dialog.pick_files()
        })
        .await
        .map_err(|e| format!("Dialog task failed: {}", e))?;

        match files {
            Some(paths) if !paths.is_empty() => {
                let items: Vec<SelectedBookItem> = paths
                    .into_iter()
                    .map(|p| {
                        let filename = p
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown_book")
                            .to_string();
                        let file_path = p.to_string_lossy().to_string();
                        SelectedBookItem { file_path, filename }
                    })
                    .collect();
                Ok(Some(items))
            }
            _ => Ok(None),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            let bridge = app_handle
                .try_state::<crate::LindenMobileBridge>()
                .ok_or_else(|| "LindenMobileBridge not initialized".to_string())?;

            #[derive(Serialize)]
            struct EmptyArgs {}

            let res = bridge
                .0
                .run_mobile_plugin::<AndroidPickResult>("pickBooks", EmptyArgs {})
                .map_err(|e| format!("pickBooks failed: {e}"))?;

            if res.items.is_empty() {
                Ok(None)
            } else {
                Ok(Some(res.items))
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn dialog_open_dict_file(#[allow(unused)] locale: Option<String>) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let file: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            let (title, db_filter, all_filter) = dict_open_dialog_spec(locale.as_deref());
            rfd::FileDialog::new()
                .set_title(title)
                .add_filter(db_filter, &["db", "sqlite", "sqlite3"])
                .add_filter(all_filter, &["*"])
                .pick_file()
        })
        .await
        .map_err(|e| format!("Dialog task failed: {}", e))?;

        Ok(file.map(|p| p.to_string_lossy().to_string()))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn dialog_pick_folder(
    #[allow(unused)] title: Option<String>,
    #[allow(unused)] locale: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let dialog_title = title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| pick_folder_dialog_title(locale.as_deref()).to_string());
        let folder: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            rfd::FileDialog::new()
                .set_title(&dialog_title)
                .pick_folder()
        })
        .await
        .map_err(|e| format!("Dialog task failed: {}", e))?;

        Ok(folder.map(|p| p.to_string_lossy().to_string()))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn dialog_save_text_file(
    #[allow(unused)] app_handle: tauri::AppHandle,
    default_name: String,
    content: String,
    title: Option<String>,
    #[allow(unused)] locale: Option<String>,
    #[allow(unused)] mime_type: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let safe_name = default_name.clone();
        let selected_path: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            let mut dialog = rfd::FileDialog::new();
            let (dialog_title, all_files) = save_dialog_defaults(title, locale.as_deref());
            dialog = dialog.set_title(&dialog_title).set_file_name(&safe_name);

            if let Some((filter_label, exts)) = save_text_extension_filter(&safe_name, locale.as_deref()) {
                dialog = dialog.add_filter(filter_label, exts);
            }
            dialog = dialog.add_filter(all_files, &["*"]);

            dialog.save_file()
        })
        .await
        .map_err(|e| format!("Dialog save task failed: {}", e))?;

        if let Some(path) = selected_path {
            tokio::fs::write(&path, content.as_bytes())
                .await
                .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))?;
            Ok(Some(path.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = (title, locale);
        let res = crate::commands::android::android_export_text_file(
            app_handle,
            default_name,
            content,
            mime_type,
        )
        .await?;
        if res.saved {
            Ok(Some(res.uri.unwrap_or_default()))
        } else if res.cancelled {
            Ok(None)
        } else {
            Err("Android text export failed".to_string())
        }
    }
    #[cfg(target_os = "ios")]
    {
        #[allow(unused_variables)]
        let _ = (app_handle, default_name, content, title, locale, mime_type);
        Ok(None)
    }
}


#[tauri::command]
pub async fn dialog_pick_save_path(
    default_name: String,
    title: Option<String>,
    filter_name: Option<String>,
    filter_ext: Option<String>,
    #[allow(unused)] locale: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let selected_path: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            let mut dialog = rfd::FileDialog::new();
            let (dialog_title, all_files) = save_dialog_defaults(title, locale.as_deref());
            dialog = dialog.set_title(&dialog_title).set_file_name(&default_name);
            if let (Some(name), Some(ext)) = (filter_name, filter_ext) {
                dialog = dialog.add_filter(&name, &[&ext]);
            }
            dialog = dialog.add_filter(all_files, &["*"]);
            dialog.save_file()
        })
        .await
        .map_err(|e| format!("Dialog save task failed: {}", e))?;

        Ok(selected_path.map(|p| p.to_string_lossy().to_string()))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[allow(unused_variables)]
        let _ = (default_name, title, filter_name, filter_ext, locale);
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dialog_strings_localization() {
        let (zh_title, zh_filters) = book_open_dialog_spec(None);
        assert_eq!(zh_title, "导入图书到 Linden Leaf 书架");
        assert_eq!(zh_filters.last().unwrap().0, "所有文件");

        let (en_title, en_filters) = book_open_dialog_spec(Some("en"));
        assert_eq!(en_title, "Import Books to Linden Leaf Shelf");
        assert_eq!(en_filters[0].0, "All Supported Ebooks & Documents");
        assert_eq!(en_filters.last().unwrap().0, "All Files");

        let (fallback_title, _) = book_open_dialog_spec(Some("unknown"));
        assert_eq!(fallback_title, "导入图书到 Linden Leaf 书架");

        assert_eq!(
            dict_open_dialog_spec(Some("en-US")).0,
            "Select ECDICT Dictionary Database File (.db)"
        );
        assert_eq!(
            dict_open_dialog_spec(Some("zh-CN")).0,
            "选择 ECDICT 词典数据库文件 (.db)"
        );
        assert_eq!(
            pick_folder_dialog_title(Some("en")),
            "Select Dictionary & Resource Storage Directory"
        );
        assert_eq!(pick_folder_dialog_title(None), "选择词典与资源存储目录");

        let (en_save_title, en_all) = save_dialog_defaults(None, Some("en"));
        assert_eq!(en_save_title, "Save File As");
        assert_eq!(en_all, "All Files (*.*)");
        let (zh_save_title, zh_all) = save_dialog_defaults(None, None);
        assert_eq!(zh_save_title, "另存为文件");
        assert_eq!(zh_all, "所有文件 (*.*)");

        assert_eq!(
            save_text_extension_filter("notes.md", Some("en")).unwrap().0,
            "Markdown Document (*.md)"
        );
        assert_eq!(
            save_text_extension_filter("backup.json", Some("zh-CN")).unwrap().0,
            "JSON 备份文件 (*.json)"
        );
        assert!(save_text_extension_filter("archive.bin", Some("en")).is_none());
    }
}
