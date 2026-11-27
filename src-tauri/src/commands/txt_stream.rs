use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Response;

const MAX_STREAM_CHAPTER_BYTES: usize = 8 * 1024 * 1024;
const AUTO_CHUNK_BYTES: u64 = 160 * 1024;
const MAX_ACTIVE_STREAMS: usize = 16;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TxtStreamChapterMeta {
    pub index: usize,
    pub title: String,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TxtStreamMeta {
    pub stream_id: String,
    pub encoding: String,
    pub total_bytes: u64,
    pub chapters: Vec<TxtStreamChapterMeta>,
}

struct TxtStreamSession {
    file_path: PathBuf,
    chapters: Vec<(u64, u64)>,
}

static TXT_STREAMS: OnceLock<Mutex<HashMap<String, TxtStreamSession>>> = OnceLock::new();
static NEXT_STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

fn streams_store() -> &'static Mutex<HashMap<String, TxtStreamSession>> {
    TXT_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn detect_txt_encoding(sample: &[u8]) -> (&'static str, usize) {
    if sample.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return ("utf-8", 3);
    }
    if sample.starts_with(&[0xFE, 0xFF]) {
        return ("utf-16be", 2);
    }
    if sample.starts_with(&[0xFF, 0xFE]) {
        return ("utf-16le", 2);
    }
    match std::str::from_utf8(sample) {
        Ok(_) => ("utf-8", 0),
        Err(e) if e.error_len().is_none() && e.valid_up_to() >= sample.len().saturating_sub(4) => {
            ("utf-8", 0)
        }
        Err(_) => {
            let has_high = sample.iter().any(|&b| b >= 0x80);
            if has_high {
                ("gb18030", 0)
            } else {
                ("windows-1252", 0)
            }
        }
    }
}

fn is_cjk_num_char(c: char) -> bool {
    c.is_ascii_digit()
        || matches!(
            c,
            '零' | '〇'
                | '一'
                | '二'
                | '两'
                | '三'
                | '四'
                | '五'
                | '六'
                | '七'
                | '八'
                | '九'
                | '十'
                | '百'
                | '千'
                | '万'
                | '壹'
                | '贰'
                | '貳'
                | '叁'
                | '參'
                | '肆'
                | '伍'
                | '陆'
                | '陸'
                | '柒'
                | '捌'
                | '玖'
                | '拾'
                | '佰'
                | '仟'
                | '萬'
        )
}

fn is_cjk_chapter_unit(c: char) -> bool {
    matches!(
        c,
        '章' | '回' | '节' | '節' | '卷' | '集' | '部' | '篇' | '幕' | '话' | '話' | '折' | '出' | '讲' | '講' | '场' | '場' | '辑' | '輯' | '案' | '首'
    )
}

fn is_standalone_heading(trimmed: &str) -> bool {
    const STANDALONE: &[&str] = &[
        "序言", "前言", "引子", "楔子", "尾声", "尾聲", "后记", "後記", "跋", "附录", "附錄",
        "自序", "译者序", "譯者序", "导言", "導言", "序章", "终章", "終章", "内容简介", "Contents",
        "Prologue", "Epilogue", "Preface", "Foreword", "Introduction", "Appendix",
    ];
    STANDALONE
        .iter()
        .any(|kw| trimmed == *kw || trimmed.starts_with(&format!("{kw} ")) || trimmed.starts_with(&format!("{kw}：")) || trimmed.starts_with(&format!("{kw}:")))
}

fn strip_heading_brackets(s: &str) -> &str {
    let s = s.trim();
    if let Some(inner) = s.strip_prefix('【').and_then(|x| x.strip_suffix('】')) {
        return inner.trim();
    }
    if let Some(inner) = s.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        return inner.trim();
    }
    s
}

fn is_txt_heading_line(raw: &str, custom_prefixes: &[String]) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('\u{3000}').trim();
    if trimmed.is_empty() {
        return None;
    }
    let char_count = trimmed.chars().count();
    if char_count > 68 {
        return None;
    }
    if trimmed.ends_with('。') || trimmed.ends_with('！') || trimmed.ends_with('？') {
        if char_count > 24 {
            return None;
        }
    }

    for pat in custom_prefixes {
        let p = pat.trim().trim_start_matches('^');
        if !p.is_empty() && trimmed.starts_with(p) {
            return Some(trimmed.to_string());
        }
    }

    if is_standalone_heading(trimmed) {
        return Some(trimmed.to_string());
    }

    if let Some(rest) = trimmed.strip_prefix('#') {
        let heading = rest.trim_start_matches('#').trim();
        if !heading.is_empty() && heading.chars().count() <= 60 {
            return Some(heading.to_string());
        }
    }

    let check_target = strip_heading_brackets(trimmed);
    if let Some(after_di) = check_target.strip_prefix('第') {
        let after_ws = after_di.trim_start();
        let mut num_chars = 0usize;
        let mut byte_idx = 0usize;
        for (idx, ch) in after_ws.char_indices() {
            if is_cjk_num_char(ch) {
                num_chars += 1;
                byte_idx = idx + ch.len_utf8();
            } else {
                break;
            }
        }
        if num_chars > 0 {
            let tail = after_ws[byte_idx..].trim_start();
            if let Some(unit) = tail.chars().next() {
                if is_cjk_chapter_unit(unit) {
                    let after_unit = tail[unit.len_utf8()..].trim_start();
                    if after_unit.is_empty()
                        || after_unit.starts_with(' ')
                        || after_unit.starts_with(':')
                        || after_unit.starts_with('：')
                        || after_unit.starts_with('-')
                        || after_unit.starts_with('—')
                        || after_unit.chars().count() <= 36
                    {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
    }

    let lower = check_target.to_ascii_lowercase();
    for en_prefix in ["chapter ", "section ", "book ", "part ", "act ", "scene ", "canto "] {
        if let Some(rest) = lower.strip_prefix(en_prefix) {
            let tok = rest.trim_start();
            if tok
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || matches!(c, 'i' | 'v' | 'x' | 'l' | 'c' | 'd' | 'm'))
            {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn index_txt_file(
    path: &Path,
    custom_patterns: &[String],
) -> Result<(String, u64, Vec<TxtStreamChapterMeta>), String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open TXT file '{}': {e}", path.display()))?;
    let total_bytes = file
        .metadata()
        .map_err(|e| format!("Cannot inspect TXT file: {e}"))?
        .len();

    let mut sample = vec![0u8; (total_bytes as usize).min(64 * 1024)];
    if !sample.is_empty() {
        let n = file.read(&mut sample).map_err(|e| format!("Cannot sample TXT file: {e}"))?;
        sample.truncate(n);
    }
    let (encoding, bom_offset) = detect_txt_encoding(&sample);

    if total_bytes == 0 {
        return Ok((
            encoding.to_string(),
            0,
            vec![TxtStreamChapterMeta {
                index: 0,
                title: "正文".to_string(),
                start_byte: 0,
                end_byte: 0,
            }],
        ));
    }

    file.seek(SeekFrom::Start(bom_offset as u64))
        .map_err(|e| format!("Cannot seek TXT file: {e}"))?;

    let mut chapters: Vec<TxtStreamChapterMeta> = Vec::new();
    let mut cur_start = bom_offset as u64;
    let mut cur_title = "序言 / Front Matter".to_string();
    let mut cur_has_content = false;
    let mut cont_count = 1usize;

    if encoding == "utf-16le" || encoding == "utf-16be" {
        let is_le = encoding == "utf-16le";
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut offset = bom_offset as u64;
        let mut pair = [0u8; 2];
        loop {
            match reader.read_exact(&mut pair) {
                Ok(()) => {
                    offset += 2;
                    let is_lf = if is_le { pair == [0x0A, 0x00] } else { pair == [0x00, 0x0A] };
                    if is_lf && offset - cur_start >= AUTO_CHUNK_BYTES {
                        let idx = chapters.len();
                        chapters.push(TxtStreamChapterMeta {
                            index: idx,
                            title: cur_title.clone(),
                            start_byte: cur_start,
                            end_byte: offset,
                        });
                        cur_start = offset;
                        cont_count += 1;
                        cur_title = format!("Part {cont_count}");
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(format!("Failed reading UTF-16 TXT: {e}")),
            }
        }
        if cur_start < total_bytes || chapters.is_empty() {
            let idx = chapters.len();
            chapters.push(TxtStreamChapterMeta {
                index: idx,
                title: cur_title,
                start_byte: cur_start,
                end_byte: total_bytes,
            });
        }
        return Ok((encoding.to_string(), total_bytes, chapters));
    }

    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::with_capacity(512);
    let mut offset = bom_offset as u64;
    let is_utf8 = encoding == "utf-8";

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed scanning TXT stream: {e}"))?;
        if n == 0 {
            break;
        }
        let line_start = offset;
        offset += n as u64;

        let detected = if is_utf8 {
            std::str::from_utf8(&buf)
                .ok()
                .and_then(|s| is_txt_heading_line(s, custom_patterns))
        } else if buf.iter().all(|&b| b < 0x80) {
            std::str::from_utf8(&buf)
                .ok()
                .and_then(|s| is_txt_heading_line(s, custom_patterns))
        } else {
            None
        };

        if let Some(heading_title) = detected {
            if cur_has_content && line_start > cur_start {
                let idx = chapters.len();
                chapters.push(TxtStreamChapterMeta {
                    index: idx,
                    title: cur_title,
                    start_byte: cur_start,
                    end_byte: line_start,
                });
                cur_start = line_start;
                cont_count = 1;
            }
            cur_title = heading_title;
            cur_has_content = false;
        } else {
            if !buf.iter().all(|b| b.is_ascii_whitespace()) {
                cur_has_content = true;
            }
            if offset - cur_start >= AUTO_CHUNK_BYTES {
                let idx = chapters.len();
                chapters.push(TxtStreamChapterMeta {
                    index: idx,
                    title: cur_title.clone(),
                    start_byte: cur_start,
                    end_byte: offset,
                });
                cur_start = offset;
                cont_count += 1;
                cur_title = if idx == 0 {
                    format!("Part {cont_count}")
                } else {
                    format!("{cur_title} ({cont_count})")
                };
                cur_has_content = false;
            }
        }
    }

    if cur_start < offset || chapters.is_empty() {
        let idx = chapters.len();
        chapters.push(TxtStreamChapterMeta {
            index: idx,
            title: cur_title,
            start_byte: cur_start,
            end_byte: offset.max(cur_start),
        });
    }

    Ok((encoding.to_string(), total_bytes, chapters))
}

pub(crate) fn read_txt_chapter_bytes(
    path: &Path,
    start_byte: u64,
    end_byte: u64,
) -> Result<Vec<u8>, String> {
    if end_byte < start_byte {
        return Err("Invalid TXT chapter byte range".into());
    }
    let len = (end_byte - start_byte) as usize;
    if len > MAX_STREAM_CHAPTER_BYTES {
        return Err(format!("TXT chapter slice exceeds {} bytes limit", MAX_STREAM_CHAPTER_BYTES));
    }
    if len == 0 {
        return Ok(Vec::new());
    }
    let mut f = File::open(path).map_err(|e| format!("Cannot open TXT file: {e}"))?;
    f.seek(SeekFrom::Start(start_byte))
        .map_err(|e| format!("Cannot seek TXT chapter: {e}"))?;
    let mut out = vec![0u8; len];
    f.read_exact(&mut out)
        .map_err(|e| format!("Cannot read TXT chapter bytes: {e}"))?;
    Ok(out)
}

#[tauri::command]
pub async fn txt_open_stream(
    file_path: String,
    custom_patterns: Option<Vec<String>>,
) -> Result<TxtStreamMeta, String> {
    let abs = crate::commands::fs::validate_safe_path_syntax(&file_path)?;
    let ext = abs
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "txt" && ext != "md" && ext != "text" {
        return Err(format!("Unsupported streaming text extension '.{ext}'"));
    }
    if !abs.is_file() {
        return Err(format!("TXT file not found: {file_path}"));
    }

    let patterns = custom_patterns.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let (encoding, total_bytes, chapters) = index_txt_file(&abs, &patterns)?;
        let seq = NEXT_STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
        let stream_id = format!("txts_{seq}");
        let ranges: Vec<(u64, u64)> = chapters
            .iter()
            .map(|c| (c.start_byte, c.end_byte))
            .collect();

        let mut guard = streams_store()
            .lock()
            .map_err(|e| format!("TXT stream store poisoned: {e}"))?;
        if guard.len() >= MAX_ACTIVE_STREAMS {
            if let Some(first_key) = guard.keys().next().cloned() {
                guard.remove(&first_key);
            }
        }
        guard.insert(
            stream_id.clone(),
            TxtStreamSession {
                file_path: abs,
                chapters: ranges,
            },
        );
        Ok(TxtStreamMeta {
            stream_id,
            encoding,
            total_bytes,
            chapters,
        })
    })
    .await
    .map_err(|e| format!("TXT open stream worker failed: {e}"))?
}

#[tauri::command]
pub async fn txt_read_chapter(
    stream_id: String,
    chapter_index: usize,
) -> Result<Response, String> {
    let (file_path, start_byte, end_byte) = {
        let guard = streams_store()
            .lock()
            .map_err(|e| format!("TXT stream store poisoned: {e}"))?;
        let sess = guard
            .get(&stream_id)
            .ok_or_else(|| format!("Unknown TXT stream id: {stream_id}"))?;
        let &(start_byte, end_byte) = sess
            .chapters
            .get(chapter_index)
            .ok_or_else(|| format!("Chapter index {chapter_index} out of bounds"))?;
        (sess.file_path.clone(), start_byte, end_byte)
    };
    let bytes = tokio::task::spawn_blocking(move || read_txt_chapter_bytes(&file_path, start_byte, end_byte))
        .await
        .map_err(|e| format!("TXT read chapter worker failed: {e}"))??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn txt_close_stream(stream_id: String) -> bool {
    streams_store()
        .lock()
        .map(|mut g| g.remove(&stream_id).is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_txt_stream_utf8_chapter_indexing_and_slice() {
        let dir = std::env::temp_dir().join(format!("linden_txt_stream_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("novel.txt");
        let content = "\u{FEFF}序言\n这是开篇简介。\n\n第一章 初入江湖\n少年背起行囊。\n第二章 风雨同舟\n长风破浪会有时。\n";
        std::fs::write(&file, content.as_bytes()).unwrap();

        let (enc, total, chapters) = index_txt_file(&file, &[]).unwrap();
        assert_eq!(enc, "utf-8");
        assert_eq!(total as usize, content.as_bytes().len());
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].title, "序言");
        assert_eq!(chapters[1].title, "第一章 初入江湖");
        assert_eq!(chapters[2].title, "第二章 风雨同舟");

        let ch1 = String::from_utf8(
            read_txt_chapter_bytes(&file, chapters[1].start_byte, chapters[1].end_byte).unwrap(),
        )
        .unwrap();
        assert!(ch1.starts_with("第一章 初入江湖"));
        assert!(ch1.contains("少年背起行囊"));

        let ch2 = String::from_utf8(
            read_txt_chapter_bytes(&file, chapters[2].start_byte, chapters[2].end_byte).unwrap(),
        )
        .unwrap();
        assert!(ch2.starts_with("第二章 风雨同舟"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_txt_stream_splits_giant_section_cleanly() {
        let dir = std::env::temp_dir().join(format!("linden_txt_giant_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("giant.txt");
        let line = "这是一段没有任何章节标题的正文内容用来测试大文件换行安全切分能力。\n";
        let mut text = String::with_capacity(240 * 1024);
        while text.len() < 220 * 1024 {
            text.push_str(line);
        }
        std::fs::write(&file, text.as_bytes()).unwrap();

        let (_, _, chapters) = index_txt_file(&file, &[]).unwrap();
        assert!(chapters.len() >= 2, "Expected giant section to split into >= 2 newline-aligned slices");
        for c in &chapters {
            let bytes = read_txt_chapter_bytes(&file, c.start_byte, c.end_byte).unwrap();
            assert!(std::str::from_utf8(&bytes).is_ok(), "Each slice must remain valid UTF-8");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
