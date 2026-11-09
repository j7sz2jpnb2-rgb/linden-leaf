use serde::{Deserialize, Serialize};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::PathBuf;

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

#[tauri::command]
pub async fn dialog_open_file(
    #[allow(unused)] app_handle: tauri::AppHandle,
) -> Result<Option<Vec<SelectedBookItem>>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let files: Option<Vec<PathBuf>> = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("导入图书到 Linden Leaf 书架")
                .add_filter(
                    "所有支持的电子书与文档",
                    &[
                        "epub", "pdf", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz",
                    ],
                )
                .add_filter("EPUB 电子书", &["epub"])
                .add_filter("PDF 文档", &["pdf"])
                .add_filter("Word 文档 (.docx)", &["docx"])
                .add_filter("Kindle 图书 (MOBI / AZW / AZW3)", &["mobi", "azw", "azw3"])
                .add_filter("TXT / Markdown 文档", &["txt", "md"])
                .add_filter("漫画与归档 (CBZ / FB2)", &["cbz", "fb2"])
                .add_filter("所有文件", &["*"])
                .pick_files()
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
pub async fn dialog_open_dict_file() -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let file: Option<PathBuf> = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("选择 ECDICT 词典数据库文件 (.db)")
                .add_filter("ECDICT SQLite 数据库 (*.db)", &["db", "sqlite", "sqlite3"])
                .add_filter("所有文件", &["*"])
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
pub async fn dialog_pick_folder() -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let folder: Option<PathBuf> = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("选择词典与资源存储目录")
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
    default_name: String,
    content: String,
    title: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let safe_name = default_name.clone();
        let selected_path: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            let mut dialog = rfd::FileDialog::new();
            let dialog_title = title.unwrap_or_else(|| "另存为文件".to_string());
            dialog = dialog.set_title(&dialog_title).set_file_name(&safe_name);

            let lower = safe_name.to_lowercase();
            if lower.ends_with(".md") || lower.ends_with(".markdown") {
                dialog = dialog.add_filter("Markdown 文档 (*.md)", &["md", "markdown"]);
            } else if lower.ends_with(".json") {
                dialog = dialog.add_filter("JSON 备份文件 (*.json)", &["json"]);
            } else if lower.ends_with(".txt") {
                dialog = dialog.add_filter("文本文档 (*.txt)", &["txt"]);
            } else if lower.ends_with(".csv") {
                dialog = dialog.add_filter("CSV 表格 (*.csv)", &["csv"]);
            }
            dialog = dialog.add_filter("所有文件 (*.*)", &["*"]);

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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[allow(unused_variables)]
        let _ = (default_name, content, title);
        Ok(None)
    }
}


#[tauri::command]
pub async fn dialog_pick_save_path(
    default_name: String,
    title: Option<String>,
    filter_name: Option<String>,
    filter_ext: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let selected_path: Option<PathBuf> = tokio::task::spawn_blocking(move || {
            let mut dialog = rfd::FileDialog::new();
            let dialog_title = title.unwrap_or_else(|| "另存为文件".to_string());
            dialog = dialog.set_title(&dialog_title).set_file_name(&default_name);
            if let (Some(name), Some(ext)) = (filter_name, filter_ext) {
                dialog = dialog.add_filter(&name, &[&ext]);
            }
            dialog = dialog.add_filter("所有文件 (*.*)", &["*"]);
            dialog.save_file()
        })
        .await
        .map_err(|e| format!("Dialog save task failed: {}", e))?;

        Ok(selected_path.map(|p| p.to_string_lossy().to_string()))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[allow(unused_variables)]
        let _ = (default_name, title, filter_name, filter_ext);
        Ok(None)
    }
}
