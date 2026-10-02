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
                        "epub", "pdf", "djvu", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz",
                    ],
                )
                .add_filter("EPUB 电子书", &["epub"])
                .add_filter("PDF / DjVu 文档", &["pdf", "djvu"])
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
