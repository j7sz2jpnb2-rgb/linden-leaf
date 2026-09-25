use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone, Debug)]
pub struct SelectedBookItem {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub filename: String,
}

#[tauri::command]
pub async fn dialog_open_file() -> Result<Option<Vec<SelectedBookItem>>, String> {
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
        // On mobile, native file picking is managed via Tauri's mobile file picker plugin or SAF content URIs
        Ok(None)
    }
}
