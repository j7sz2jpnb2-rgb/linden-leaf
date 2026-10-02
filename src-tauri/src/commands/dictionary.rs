use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock, OnceLock};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

static IS_INSTALLING: AtomicBool = AtomicBool::new(false);
static DB_MUTEX: Mutex<()> = Mutex::new(());
static CUSTOM_DICT_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_PROGRESS: OnceLock<RwLock<DictDownloadProgress>> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictDownloadProgress {
    pub phase: String,
    pub loaded_bytes: u64,
    pub total_bytes: u64,
    pub entries_processed: u64,
    pub percent: u32,
    pub message: String,
    pub error: Option<String>,
}

fn get_download_progress_lock() -> &'static RwLock<DictDownloadProgress> {
    DOWNLOAD_PROGRESS.get_or_init(|| {
        RwLock::new(DictDownloadProgress {
            phase: "idle".to_string(),
            loaded_bytes: 0,
            total_bytes: 0,
            entries_processed: 0,
            percent: 0,
            message: "就绪".to_string(),
            error: None,
        })
    })
}

fn update_download_progress<F>(updater: F)
where
    F: FnOnce(&mut DictDownloadProgress),
{
    if let Ok(mut guard) = get_download_progress_lock().write() {
        updater(&mut guard);
    }
}

pub struct InstallingGuard;
impl InstallingGuard {
    pub fn new() -> Result<Self, String> {
        if IS_INSTALLING.swap(true, Ordering::SeqCst) {
            return Err("已有词典或资源安装任务正在进行中".to_string());
        }
        Ok(Self)
    }
}
impl Drop for InstallingGuard {
    fn drop(&mut self) {
        IS_INSTALLING.store(false, Ordering::SeqCst);
    }
}

fn get_custom_dict_dir_lock() -> &'static RwLock<Option<PathBuf>> {
    CUSTOM_DICT_DIR.get_or_init(|| {
        let meta_file = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.lindenleaf.reader")
            .join("resources_config.json");
        if meta_file.exists() {
            if let Ok(content) = fs::read_to_string(&meta_file) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(p) = v.get("dictionaryDir").and_then(|s| s.as_str()) {
                        let path = PathBuf::from(p);
                        if path.is_dir() {
                            return RwLock::new(Some(path));
                        }
                    }
                }
            }
        }
        RwLock::new(None)
    })
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictEntryRow {
    pub pos: String,
    pub def: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictLookupResult {
    pub found: bool,
    pub word: String,
    pub normalized_word: String,
    pub phonetic: String,
    pub entries: Vec<DictEntryRow>,
    pub translation_raw: String,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DictStatus {
    pub status: String, // "installed" | "not_installed" | "corrupted" | "installing"
    pub word_count: u64,
    pub size_bytes: u64,
    pub version: String,
    pub name: String,
    pub path: String,
    pub sha256: Option<String>,
}

fn get_default_dict_storage_dir() -> PathBuf {
    let mut dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lindenleaf.reader");
    dir.push("dictionary");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn get_dict_storage_dir() -> PathBuf {
    if let Ok(guard) = get_custom_dict_dir_lock().read() {
        if let Some(ref custom) = *guard {
            if custom.exists() {
                return custom.clone();
            }
        }
    }
    get_default_dict_storage_dir()
}

fn get_dict_db_path() -> PathBuf {
    let mut path = get_dict_storage_dir();
    path.push("ecdict.db");
    path
}

fn get_dict_meta_path() -> PathBuf {
    let mut path = get_dict_storage_dir();
    path.push("metadata.json");
    path
}

fn is_explicitly_uninstalled() -> bool {
    let meta_path = get_dict_meta_path();
    if meta_path.exists() {
        if let Ok(meta_content) = fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&meta_content) {
                if json.get("uninstalled").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

fn get_bundled_db_path() -> Option<PathBuf> {
    // 1. Check relative to current working dir
    let cwd_bundled = PathBuf::from("resources").join("dictionary").join("ecdict.db");
    if cwd_bundled.exists() {
        return Some(cwd_bundled);
    }
    // 2. Check relative to executable directory (production release)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let exe_bundled = exe_dir.join("resources").join("dictionary").join("ecdict.db");
            if exe_bundled.exists() {
                return Some(exe_bundled);
            }
        }
    }
    None
}

fn get_effective_db_path() -> Option<PathBuf> {
    if is_explicitly_uninstalled() {
        return None;
    }
    let user_path = get_dict_db_path();
    // Auto-recovery check: if user_path does not exist but a valid .bak exists from a previously interrupted transaction, restore it safely
    if !user_path.exists() {
        let bak = user_path.with_extension("bak");
        if bak.exists() {
            let meta_path = get_dict_meta_path();
            let bak_meta = meta_path.with_extension("bak");
            let _ = fs::rename(&bak, &user_path);
            if bak_meta.exists() && !meta_path.exists() {
                let _ = fs::rename(&bak_meta, &meta_path);
            }
        }
    }
    if user_path.exists() {
        return Some(user_path);
    }
    get_bundled_db_path()
}

fn parse_translation_entries(raw: &str) -> Vec<DictEntryRow> {
    let mut rows = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try extracting part of speech tag: e.g. "n. ", "v. ", "adj. ", "adv. ", "prep. ", "[网络] "
        if let Some(pos_end) = trimmed.find(". ") {
            let pos = trimmed[..pos_end + 1].trim();
            let def = trimmed[pos_end + 2..].trim();
            if !pos.is_empty() && !def.is_empty() {
                rows.push(DictEntryRow {
                    pos: pos.to_string(),
                    def: def.to_string(),
                });
                continue;
            }
        } else if let Some(bracket_end) = trimmed.find("] ") {
            if trimmed.starts_with('[') {
                let pos = trimmed[..bracket_end + 1].trim();
                let def = trimmed[bracket_end + 2..].trim();
                rows.push(DictEntryRow {
                    pos: pos.to_string(),
                    def: def.to_string(),
                });
                continue;
            }
        }

        rows.push(DictEntryRow {
            pos: String::new(),
            def: trimmed.to_string(),
        });
    }
    rows
}

fn normalize_lookup_word(raw: &str) -> String {
    raw.trim()
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-' && c != ' ')
        .to_string()
}

fn generate_lemma_candidates(word: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let lower = word.to_lowercase();

    // 1. Plural / 3rd person -s, -es, -ies
    if let Some(base) = lower.strip_suffix("ies") {
        if !base.is_empty() {
            candidates.push(format!("{}y", base));
        }
    }
    if let Some(base) = lower.strip_suffix("es") {
        if !base.is_empty() {
            candidates.push(base.to_string());
            candidates.push(format!("{}e", base));
        }
    }
    if let Some(base) = lower.strip_suffix('s') {
        if !base.is_empty() && !candidates.contains(&base.to_string()) {
            candidates.push(base.to_string());
        }
    }

    // 2. Past tense / participle -ed, -ied, doubled consonant
    if let Some(base) = lower.strip_suffix("ied") {
        if !base.is_empty() {
            candidates.push(format!("{}y", base));
        }
    }
    if let Some(base) = lower.strip_suffix("ed") {
        if !base.is_empty() {
            candidates.push(base.to_string());
            candidates.push(format!("{}e", base));
            // Doubled consonant: stopped -> stop, planned -> plan
            let chars: Vec<char> = base.chars().collect();
            if chars.len() >= 3 && chars[chars.len() - 1] == chars[chars.len() - 2] {
                let single: String = chars[..chars.len() - 1].iter().collect();
                candidates.push(single);
            }
        }
    }

    // 3. Present participle / gerund -ing, doubled consonant
    if let Some(base) = lower.strip_suffix("ing") {
        if !base.is_empty() {
            candidates.push(base.to_string());
            candidates.push(format!("{}e", base));
            let chars: Vec<char> = base.chars().collect();
            if chars.len() >= 3 && chars[chars.len() - 1] == chars[chars.len() - 2] {
                let single: String = chars[..chars.len() - 1].iter().collect();
                candidates.push(single);
            }
        }
    }

    // 4. Possessives: 's, ’s, or trailing apostrophe (straight ' or curly ’)
    if let Some(base) = lower.strip_suffix("'s").or_else(|| lower.strip_suffix("’s")) {
        if !base.is_empty() {
            candidates.push(base.to_string());
        }
    } else if let Some(base) = lower.strip_suffix('\'').or_else(|| lower.strip_suffix('’')) {
        if !base.is_empty() {
            candidates.push(base.to_string());
            if let Some(s_base) = base.strip_suffix('s') {
                if !s_base.is_empty() {
                    candidates.push(s_base.to_string());
                }
            }
        }
    }

    // 5. Hyphenated compounds: "well-known" -> "well", "known"
    if lower.contains('-') {
        for part in lower.split('-') {
            let p = part.trim();
            if !p.is_empty() && !candidates.contains(&p.to_string()) {
                candidates.push(p.to_string());
            }
        }
    }

    // 6. Adverbs -ly
    if let Some(base) = lower.strip_suffix("ly") {
        if !base.is_empty() {
            candidates.push(base.to_string());
            candidates.push(format!("{}le", base));
        }
    }

    candidates
}

fn extract_root_lemma(exchange: &str) -> Option<String> {
    for part in exchange.split('/') {
        if part.starts_with("0:") {
            return Some(part[2..].to_string());
        }
    }
    None
}

#[tauri::command]
pub fn dict_get_status() -> DictStatus {
    if IS_INSTALLING.load(Ordering::SeqCst) {
        return DictStatus {
            status: "installing".to_string(),
            word_count: 0,
            size_bytes: 0,
            version: "1.0.28".to_string(),
            name: "Skywind3000 ECDICT".to_string(),
            path: String::new(),
            sha256: None,
        };
    }

    let db_path = match get_effective_db_path() {
        Some(p) => p,
        None => {
            return DictStatus {
                status: "not_installed".to_string(),
                word_count: 0,
                size_bytes: 0,
                version: String::new(),
                name: "Skywind3000 ECDICT".to_string(),
                path: String::new(),
                sha256: None,
            };
        }
    };

    let meta_path = get_dict_meta_path();
    let mut version = "1.0.28".to_string();
    let mut sha256 = None;
    if meta_path.exists() {
        if let Ok(meta_content) = fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&meta_content) {
                if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
                    version = v.to_string();
                }
                if let Some(h) = json.get("dbSha256").and_then(|h| h.as_str()) {
                    sha256 = Some(h.to_string());
                }
            }
        }
    }

    let size = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    if size < 100_000 {
        return DictStatus {
            status: "corrupted".to_string(),
            word_count: 0,
            size_bytes: size,
            version,
            name: "Skywind3000 ECDICT".to_string(),
            path: db_path.to_string_lossy().to_string(),
            sha256,
        };
    }

    // Verify DB can be opened and queried (read-only SQLite query, non-blocking)
    match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => {
            let count_res: Result<u64, _> = conn.query_row(
                "SELECT count(*) FROM entries;",
                [],
                |row| row.get(0),
            );
            match count_res {
                Ok(count) if count > 0 => DictStatus {
                    status: "installed".to_string(),
                    word_count: count,
                    size_bytes: size,
                    version,
                    name: "Skywind3000 ECDICT".to_string(),
                    path: db_path.to_string_lossy().to_string(),
                    sha256,
                },
                _ => DictStatus {
                    status: "corrupted".to_string(),
                    word_count: 0,
                    size_bytes: size,
                    version,
                    name: "Skywind3000 ECDICT".to_string(),
                    path: db_path.to_string_lossy().to_string(),
                    sha256,
                },
            }
        }
        Err(_) => DictStatus {
            status: "corrupted".to_string(),
            word_count: 0,
            size_bytes: size,
            version,
            name: "Skywind3000 ECDICT".to_string(),
            path: db_path.to_string_lossy().to_string(),
            sha256,
        },
    }
}

#[tauri::command]
pub fn dict_lookup(word: String) -> DictLookupResult {
    let norm = normalize_lookup_word(&word);
    if norm.is_empty() || norm.len() > 256 {
        let is_over = norm.len() > 256;
        return DictLookupResult {
            found: false,
            word,
            normalized_word: norm,
            phonetic: String::new(),
            entries: Vec::new(),
            translation_raw: String::new(),
            source: if is_over { "查询内容过长".to_string() } else { "基础离线词库".to_string() },
        };
    }

    let db_path = match get_effective_db_path() {
        Some(p) => p,
        None => {
            return DictLookupResult {
                found: false,
                word,
                normalized_word: norm,
                phonetic: String::new(),
                entries: Vec::new(),
                translation_raw: String::new(),
                source: "尚未安装英汉词库".to_string(),
            };
        }
    };

    // Read-only SQLite query without taking global DB_MUTEX
    let conn = match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => {
            return DictLookupResult {
                found: false,
                word,
                normalized_word: norm,
                phonetic: String::new(),
                entries: Vec::new(),
                translation_raw: String::new(),
                source: "词典文件损坏".to_string(),
            };
        }
    };

    // 1. Direct match (try raw trimmed first to preserve abbreviations like A.M.D. / etc., then norm)
    let query = "SELECT word, phonetic, translation, exchange FROM entries WHERE word = ?1 COLLATE NOCASE LIMIT 1;";
    let raw_trimmed = word.trim();
    let mut direct = conn.query_row(query, params![raw_trimmed], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    });
    if direct.is_err() && !norm.is_empty() && norm != raw_trimmed {
        direct = conn.query_row(query, params![norm], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        });
    }

    if let Ok((matched_word, phonetic, translation, exchange)) = direct {
        let entries = parse_translation_entries(&translation);
        let root_lemma = extract_root_lemma(&exchange);
        let final_norm = if let Some(r) = root_lemma {
            if r.to_lowercase() != norm.to_lowercase() { r } else { matched_word }
        } else {
            matched_word
        };
        return DictLookupResult {
            found: true,
            word,
            normalized_word: final_norm,
            phonetic: if phonetic.is_empty() { String::new() } else { format!("/{}/", phonetic) },
            entries,
            translation_raw: translation,
            source: "ECDICT 离线词库".to_string(),
        };
    }

    // 2. Lemmatization candidates
    let candidates = generate_lemma_candidates(&norm);
    for cand in candidates {
        let found_cand = conn.query_row(query, params![cand], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        });
        if let Ok((matched_word, phonetic, translation, exchange)) = found_cand {
            let entries = parse_translation_entries(&translation);
            let root_lemma = extract_root_lemma(&exchange);
            let final_norm = root_lemma.unwrap_or(matched_word);
            return DictLookupResult {
                found: true,
                word,
                normalized_word: final_norm,
                phonetic: if phonetic.is_empty() { String::new() } else { format!("/{}/", phonetic) },
                entries,
                translation_raw: translation,
                source: "ECDICT 离线词库".to_string(),
            };
        }
    }

    // Not found in installed dictionary
    DictLookupResult {
        found: false,
        word,
        normalized_word: norm,
        phonetic: String::new(),
        entries: Vec::new(),
        translation_raw: String::new(),
        source: "ECDICT 离线词库".to_string(),
    }
}

#[tauri::command]
pub fn dict_uninstall() -> Result<bool, String> {
    let _lock = DB_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
    let db_path = get_dict_db_path();
    let meta_path = get_dict_meta_path();
    if db_path.exists() {
        fs::remove_file(&db_path).map_err(|e| format!("删除词典文件失败: {}", e))?;
    }
    // Record explicit uninstallation so bundled db is not automatically resurrected
    let tombstone = serde_json::json!({
        "uninstalled": true,
        "uninstalledAt": chrono_or_now()
    });
    fs::write(&meta_path, serde_json::to_string_pretty(&tombstone).unwrap_or_default())
        .map_err(|e| format!("写入卸载元数据失败: {}", e))?;
    Ok(true)
}

pub fn parse_csv_line_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else {
            if c == '"' {
                in_quotes = true;
            } else if c == ',' {
                fields.push(current);
                current = String::new();
            } else {
                current.push(c);
            }
        }
    }
    fields.push(current);
    fields
}

pub fn convert_csv_to_sqlite(csv_path: &Path, db_dest_path: &Path, progress_cb: Option<&dyn Fn(u64)>) -> Result<u64, String> {
    use std::io::{BufRead, BufReader};

    let file = fs::File::open(csv_path).map_err(|e| format!("打开 CSV 文件失败: {}", e))?;
    let reader = BufReader::new(file);

    let mut conn = Connection::open(db_dest_path).map_err(|e| format!("创建 SQLite 数据库失败: {}", e))?;
    conn.execute_batch(
        "PRAGMA synchronous = OFF;
         PRAGMA journal_mode = MEMORY;
         PRAGMA page_size = 4096;
         CREATE TABLE IF NOT EXISTS entries (
             word TEXT PRIMARY KEY COLLATE NOCASE,
             phonetic TEXT,
             definition TEXT,
             translation TEXT,
             pos TEXT,
             exchange TEXT
         );"
    ).map_err(|e| format!("初始化表结构失败: {}", e))?;

    let mut row_count: u64 = 0;
    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO entries (word, phonetic, definition, translation, pos, exchange) VALUES (?1, ?2, ?3, ?4, ?5, ?6);"
        ).map_err(|e| format!("准备插入语句失败: {}", e))?;

        let mut lines = reader.lines();
        if let Some(first_res) = lines.next() {
            let first_line = first_res.map_err(|e| format!("读取 CSV 首行失败: {}", e))?;
            let cols = parse_csv_line_fields(&first_line);
            if cols.get(0).map(|s| s.trim().to_lowercase()) != Some("word".to_string()) {
                let word = cols.get(0).map(|s| s.trim()).unwrap_or("");
                if !word.is_empty() {
                    let phonetic = cols.get(1).map(|s| s.as_str()).unwrap_or("");
                    let def = cols.get(2).map(|s| s.as_str()).unwrap_or("");
                    let trans = cols.get(3).map(|s| s.replace("\\n", "\n")).unwrap_or_default();
                    let pos = cols.get(4).map(|s| s.as_str()).unwrap_or("");
                    let exchange = cols.get(10).map(|s| s.as_str()).unwrap_or("");
                    stmt.execute(params![word, phonetic, def, trans, pos, exchange])
                        .map_err(|e| format!("写入词条失败 ({}): {}", word, e))?;
                    row_count += 1;
                }
            }
        }

        for line_res in lines {
            if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                return Err("操作已由用户取消".to_string());
            }
            let line = line_res.map_err(|e| format!("读取 CSV 文件行失败: {}", e))?;
            if line.trim().is_empty() {
                continue;
            }
            let cols = parse_csv_line_fields(&line);
            let word = match cols.get(0).map(|s| s.trim()) {
                Some(w) if !w.is_empty() => w,
                _ => continue,
            };
            let phonetic = cols.get(1).map(|s| s.as_str()).unwrap_or("");
            let def = cols.get(2).map(|s| s.as_str()).unwrap_or("");
            let trans = cols.get(3).map(|s| s.replace("\\n", "\n")).unwrap_or_default();
            let pos = cols.get(4).map(|s| s.as_str()).unwrap_or("");
            let exchange = cols.get(10).map(|s| s.as_str()).unwrap_or("");
            stmt.execute(params![word, phonetic, def, trans, pos, exchange])
                .map_err(|e| format!("写入词条失败 ({}): {}", word, e))?;
            row_count += 1;

            if row_count % 25000 == 0 {
                if let Some(cb) = progress_cb {
                    cb(row_count);
                }
            }
        }
    }

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_word ON entries(word COLLATE NOCASE);
         PRAGMA optimize;"
    ).map_err(|e| format!("构建词库索引失败: {}", e))?;

    if let Some(cb) = progress_cb {
        cb(row_count);
    }

    Ok(row_count)
}

#[tauri::command]
pub fn dict_install_from_file(source_path: String) -> Result<DictStatus, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("所选词典文件不存在".to_string());
    }

    let _guard = InstallingGuard::new()?;
    let dest = get_dict_db_path();
    let tmp = get_dict_storage_dir().join("ecdict.db.tmp");
    let is_csv = source_path.to_lowercase().ends_with(".csv");

    let count: u64 = if is_csv {
        let _ = fs::remove_file(&tmp);
        convert_csv_to_sqlite(src, &tmp, None)?
    } else {
        // Validate SQLite database
        let conn = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("无法打开 SQLite 数据库: {}", e))?;
        
        let has_entries: bool = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='entries';",
            [],
            |r| r.get::<_, u64>(0),
        ).unwrap_or(0) > 0;

        let has_stardict: bool = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='stardict';",
            [],
            |r| r.get::<_, u64>(0),
        ).unwrap_or(0) > 0;

        if has_entries {
            let c: u64 = conn.query_row("SELECT count(*) FROM entries;", [], |r| r.get(0))
                .map_err(|e| format!("读取 entries 表条目失败: {}", e))?;
            if c == 0 {
                return Err("词典数据库中未找到任何词条".to_string());
            }
            fs::copy(src, &tmp).map_err(|e| format!("复制词典文件失败: {}", e))?;
            c
        } else if has_stardict {
            // Convert stardict schema to standard entries schema
            let c: u64 = conn.query_row("SELECT count(*) FROM stardict;", [], |r| r.get(0))
                .map_err(|e| format!("读取 stardict 表条目失败: {}", e))?;
            if c == 0 {
                return Err("词典数据库中未找到任何词条".to_string());
            }
            let _ = fs::remove_file(&tmp);
            let mut dest_conn = Connection::open(&tmp).map_err(|e| format!("创建目标数据库失败: {}", e))?;
            dest_conn.execute_batch(
                "PRAGMA synchronous = OFF;
                 CREATE TABLE entries (
                     word TEXT PRIMARY KEY COLLATE NOCASE,
                     phonetic TEXT,
                     definition TEXT,
                     translation TEXT,
                     pos TEXT,
                     exchange TEXT
                 );"
            ).map_err(|e| format!("创建 entries 表失败: {}", e))?;

            let tx = dest_conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
            {
                let mut ins = tx.prepare(
                    "INSERT OR REPLACE INTO entries (word, phonetic, definition, translation, pos, exchange) VALUES (?1, ?2, ?3, ?4, ?5, ?6);"
                ).map_err(|e| format!("准备插入语句失败: {}", e))?;

                let mut stmt = conn.prepare("SELECT word, phonetic, definition, translation, pos, exchange FROM stardict;").map_err(|e| format!("查询 stardict 失败: {}", e))?;
                let mut rows = stmt.query([]).map_err(|e| format!("遍历 stardict 失败: {}", e))?;
                while let Some(row) = rows.next().map_err(|e| format!("读取条目失败: {}", e))? {
                    let w: String = row.get(0).map_err(|e| format!("读取词条字段失败: {}", e))?;
                    let ph: Option<String> = row.get(1).ok();
                    let def: Option<String> = row.get(2).ok();
                    let tr: Option<String> = row.get(3).ok();
                    let pos: Option<String> = row.get(4).ok();
                    let ex: Option<String> = row.get(5).ok();
                    ins.execute(params![w, ph.unwrap_or_default(), def.unwrap_or_default(), tr.unwrap_or_default(), pos.unwrap_or_default(), ex.unwrap_or_default()])
                        .map_err(|e| format!("导入词条失败: {}", e))?;
                }
            }
            tx.commit().map_err(|e| format!("提交导入事务失败: {}", e))?;
            dest_conn.execute_batch("CREATE INDEX idx_word ON entries(word COLLATE NOCASE); PRAGMA optimize;")
                .map_err(|e| format!("构建索引失败: {}", e))?;
            c
        } else {
            return Err("所选词典数据库格式不受支持 (缺少 entries 或 stardict 表)".to_string());
        }
    };

    // Prepare metadata
    let meta_path = get_dict_meta_path();
    let meta_tmp = meta_path.with_extension("tmp");
    let metadata = serde_json::json!({
        "name": "Skywind3000 ECDICT",
        "version": "1.0.28",
        "totalEntries": count,
        "installedAt": chrono_or_now(),
        "source": if is_csv { "local_csv" } else { "local_file" },
        "originalPath": source_path,
        "uninstalled": false
    });
    fs::write(&meta_tmp, serde_json::to_string_pretty(&metadata).unwrap_or_default())
        .map_err(|e| format!("写入词典临时元数据失败: {}", e))?;

    // Atomic activate under mutex with rollback
    let bak_dest = dest.with_extension("bak");
    let bak_meta = meta_path.with_extension("bak");
    {
        let _lock = DB_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        // Preserve and restore existing backup if destination db is missing (e.g. from an interrupted install)
        if !dest.exists() && bak_dest.exists() {
            let _ = fs::rename(&bak_dest, &dest);
            if bak_meta.exists() && !meta_path.exists() {
                let _ = fs::rename(&bak_meta, &meta_path);
            }
        } else {
            let _ = fs::remove_file(&bak_dest);
            let _ = fs::remove_file(&bak_meta);
        }

        if dest.exists() {
            fs::rename(&dest, &bak_dest).map_err(|e| format!("备份旧词典失败: {}", e))?;
        }
        if meta_path.exists() {
            let _ = fs::rename(&meta_path, &bak_meta);
        }

        let activate_result: Result<(), String> = (|| {
            fs::rename(&tmp, &dest).map_err(|e| format!("启用词典文件失败: {}", e))?;
            fs::rename(&meta_tmp, &meta_path).map_err(|e| format!("启用元数据失败: {}", e))?;
            Ok(())
        })();

        if let Err(e) = activate_result {
            if bak_dest.exists() {
                let _ = fs::rename(&bak_dest, &dest);
            }
            if bak_meta.exists() {
                let _ = fs::rename(&bak_meta, &meta_path);
            }
            let _ = fs::remove_file(&tmp);
            let _ = fs::remove_file(&meta_tmp);
            return Err(e);
        }

        let _ = fs::remove_file(&bak_dest);
        let _ = fs::remove_file(&bak_meta);
    }

    drop(_guard);
    Ok(dict_get_status())
}

#[tauri::command]
pub async fn dict_download_and_install(source_url: Option<String>) -> Result<DictStatus, String> {
    let _guard = InstallingGuard::new()?;
    DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);

    update_download_progress(|p| {
        p.phase = "connecting".to_string();
        p.loaded_bytes = 0;
        p.total_bytes = 0;
        p.entries_processed = 0;
        p.percent = 0;
        p.message = "正在连接词库服务器...".to_string();
        p.error = None;
    });

    let urls = if let Some(ref u) = source_url {
        let trimmed = u.trim();
        if !trimmed.is_empty() {
            vec![trimmed.to_string()]
        } else {
            vec![
                "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv".to_string(),
                "https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@master/ecdict.csv".to_string(),
            ]
        }
    } else {
        vec![
            "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv".to_string(),
            "https://cdn.jsdelivr.net/gh/skywind3000/ECDICT@master/ecdict.csv".to_string(),
        ]
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {}", e))?;

    let storage_dir = get_dict_storage_dir();
    let temp_csv = storage_dir.join("ecdict_download.csv.tmp");
    let temp_db = storage_dir.join("ecdict.db.tmp");

    let mut download_success = false;
    let mut chosen_url = String::new();
    let mut last_err = String::new();

    for url in urls {
        if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
            update_download_progress(|p| {
                p.phase = "cancelled".to_string();
                p.message = "用户取消了下载".to_string();
            });
            let _ = fs::remove_file(&temp_csv);
            return Err("下载已由用户取消".to_string());
        }

        update_download_progress(|p| {
            p.message = format!("正在从 {} 请求资源...", url);
        });

        let resp_res = client.get(&url).send().await;
        let mut resp = match resp_res {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };

        let total_size = resp.content_length().unwrap_or(0);
        let mut file = match fs::File::create(&temp_csv) {
            Ok(f) => f,
            Err(e) => return Err(format!("无法创建临时文件: {}", e)),
        };

        use std::io::Write;
        let mut downloaded: u64 = 0;
        let mut chunk_failed = false;
        let mut eof_reached = false;

        update_download_progress(|p| {
            p.phase = "downloading".to_string();
            p.total_bytes = total_size;
        });

        loop {
            if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&temp_csv);
                update_download_progress(|p| {
                    p.phase = "cancelled".to_string();
                    p.message = "下载已取消".to_string();
                });
                return Err("下载已由用户取消".to_string());
            }

            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(e) = file.write_all(&chunk) {
                        last_err = format!("写入磁盘失败: {}", e);
                        chunk_failed = true;
                        break;
                    }
                    downloaded += chunk.len() as u64;

                    let pct = if total_size > 0 {
                        ((downloaded as f64 / total_size as f64) * 100.0) as u32
                    } else {
                        0
                    };

                    update_download_progress(|p| {
                        p.loaded_bytes = downloaded;
                        p.percent = pct;
                        p.message = format!("正在下载: {:.1} MB", downloaded as f64 / (1024.0 * 1024.0));
                    });
                }
                Ok(None) => {
                    eof_reached = true;
                    break;
                }
                Err(e) => {
                    chunk_failed = true;
                    last_err = format!("网络传输异常中断: {}", e);
                    break;
                }
            }
        }

        if !chunk_failed && eof_reached {
            if total_size > 0 && downloaded != total_size {
                last_err = format!("下载数据不完整: 预期 {} 字节，实际获取 {} 字节", total_size, downloaded);
                let _ = fs::remove_file(&temp_csv);
                continue;
            }
            if downloaded > 50_000 {
                download_success = true;
                chosen_url = url;
                break;
            } else {
                last_err = format!("下载文件过小 ({} 字节)，不是有效词库数据", downloaded);
                let _ = fs::remove_file(&temp_csv);
                continue;
            }
        }
    }

    if !download_success {
        let _ = fs::remove_file(&temp_csv);
        update_download_progress(|p| {
            p.phase = "error".to_string();
            p.error = Some(last_err.clone());
            p.message = format!("词库下载失败: {}", last_err);
        });
        return Err(format!("下载官方词库失败: {}", last_err));
    }

    // Convert CSV to SQLite
    update_download_progress(|p| {
        p.phase = "converting".to_string();
        p.percent = 0;
        p.message = "下载完成，正在解析并构建本地索引数据库...".to_string();
    });

    let _ = fs::remove_file(&temp_db);
    let temp_csv_clone = temp_csv.clone();
    let temp_db_clone = temp_db.clone();
    let convert_res = tokio::task::spawn_blocking(move || {
        convert_csv_to_sqlite(&temp_csv_clone, &temp_db_clone, Some(&|rows| {
            update_download_progress(|p| {
                p.entries_processed = rows;
                p.message = format!("已写入 {} 词条...", rows);
            });
        }))
    })
    .await
    .map_err(|e| format!("转换任务执行失败: {}", e))?;

    let count = match convert_res {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&temp_csv);
            let _ = fs::remove_file(&temp_db);
            update_download_progress(|p| {
                p.phase = "error".to_string();
                p.error = Some(e.clone());
                p.message = format!("转换词库失败: {}", e);
            });
            return Err(e);
        }
    };

    // Clean up temporary CSV
    let _ = fs::remove_file(&temp_csv);

    // Prepare metadata
    let now_ts = chrono_or_now();
    let metadata = serde_json::json!({
        "name": "Skywind3000 ECDICT",
        "version": format!("ecdict_official_{}", now_ts.split('T').next().unwrap_or("latest")),
        "totalEntries": count,
        "installedAt": now_ts,
        "source": "official_download",
        "originalUrl": chosen_url,
        "uninstalled": false
    });
    let meta_path = get_dict_meta_path();
    let meta_tmp = meta_path.with_extension("tmp");
    fs::write(&meta_tmp, serde_json::to_string_pretty(&metadata).unwrap_or_default())
        .map_err(|e| format!("写入临时元数据失败: {}", e))?;

    // Atomic activate under mutex with rollback
    let dest_db = get_dict_db_path();
    let bak_db = dest_db.with_extension("bak");
    let bak_meta = meta_path.with_extension("bak");
    {
        let _lock = DB_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        // Preserve and restore existing backup if destination db is missing (e.g. from an interrupted install)
        if !dest_db.exists() && bak_db.exists() {
            let _ = fs::rename(&bak_db, &dest_db);
            if bak_meta.exists() && !meta_path.exists() {
                let _ = fs::rename(&bak_meta, &meta_path);
            }
        } else {
            let _ = fs::remove_file(&bak_db);
            let _ = fs::remove_file(&bak_meta);
        }

        if dest_db.exists() {
            fs::rename(&dest_db, &bak_db).map_err(|e| format!("备份旧词典失败: {}", e))?;
        }
        if meta_path.exists() {
            let _ = fs::rename(&meta_path, &bak_meta);
        }

        let activate_result: Result<(), String> = (|| {
            fs::rename(&temp_db, &dest_db).map_err(|e| format!("启用词库文件失败: {}", e))?;
            fs::rename(&meta_tmp, &meta_path).map_err(|e| format!("启用元数据失败: {}", e))?;
            Ok(())
        })();

        if let Err(e) = activate_result {
            if bak_db.exists() {
                let _ = fs::rename(&bak_db, &dest_db);
            }
            if bak_meta.exists() {
                let _ = fs::rename(&bak_meta, &meta_path);
            }
            let _ = fs::remove_file(&temp_db);
            let _ = fs::remove_file(&meta_tmp);
            return Err(e);
        }

        let _ = fs::remove_file(&bak_db);
        let _ = fs::remove_file(&bak_meta);
    }

    update_download_progress(|p| {
        p.phase = "completed".to_string();
        p.percent = 100;
        p.message = format!("词库安装成功！共收录 {} 词条", count);
    });

    drop(_guard);
    Ok(dict_get_status())
}

#[tauri::command]
pub fn dict_cancel_download() -> Result<bool, String> {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    update_download_progress(|p| {
        p.phase = "cancelled".to_string();
        p.message = "正在取消...".to_string();
    });
    Ok(true)
}

#[tauri::command]
pub fn dict_get_download_progress() -> DictDownloadProgress {
    get_download_progress_lock().read().map(|g| g.clone()).unwrap_or_else(|_| DictDownloadProgress {
        phase: "idle".to_string(),
        loaded_bytes: 0,
        total_bytes: 0,
        entries_processed: 0,
        percent: 0,
        message: "就绪".to_string(),
        error: None,
    })
}

#[tauri::command]
pub fn dict_get_resource_locations() -> serde_json::Value {
    let dict_dir = get_dict_storage_dir();
    let default_dict_dir = get_default_dict_storage_dir();
    let db_path = get_dict_db_path();
    let dict_size = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    let dict_installed = db_path.exists() && dict_size > 100_000 && !is_explicitly_uninstalled();

    let app_data = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("com.lindenleaf.reader");
    let model_dir = app_data.join("models");
    let _ = fs::create_dir_all(&model_dir);
    let audio_cache_dir = dirs::cache_dir().unwrap_or_else(|| app_data.clone()).join("com.lindenleaf.reader").join("audio_cache");
    let _ = fs::create_dir_all(&audio_cache_dir);

    let audio_cache_size = fs::read_dir(&audio_cache_dir).map(|entries| {
        entries.filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum::<u64>()
    }).unwrap_or(0);

    serde_json::json!({
        "dictionaryDir": dict_dir.to_string_lossy().to_string(),
        "defaultDictionaryDir": default_dict_dir.to_string_lossy().to_string(),
        "isCustomDictionaryDir": dict_dir != default_dict_dir,
        "dictionaryInstalled": dict_installed,
        "dictionarySizeBytes": dict_size,
        "modelDir": model_dir.to_string_lossy().to_string(),
        "audioCacheDir": audio_cache_dir.to_string_lossy().to_string(),
        "audioCacheSizeBytes": audio_cache_size
    })
}

#[tauri::command]
pub fn dict_migrate_storage(
    target_dir: Option<String>,
    new_dict_dir: Option<String>,
) -> Result<DictStatus, String> {
    let raw_target = target_dir
        .or(new_dict_dir)
        .ok_or_else(|| "缺少目标迁移目录参数 (target_dir / new_dict_dir)".to_string())?;

    let _guard = InstallingGuard::new()?;

    let target = PathBuf::from(&raw_target);
    let canon_target = target.canonicalize().unwrap_or_else(|_| target.clone());

    // Basic filesystem sanity: target must not be filesystem root
    if canon_target.parent().is_none() || canon_target.to_string_lossy().trim_end_matches(['\\', '/']).is_empty() {
        return Err("安全保护拦截：禁止将词库迁移至系统根目录".to_string());
    }

    if !target.exists() {
        fs::create_dir_all(&target).map_err(|e| format!("无法创建目标目录: {}", e))?;
    }
    if !target.is_dir() {
        return Err("目标路径不是有效的目录".to_string());
    }

    let current_dir = get_dict_storage_dir();
    if target == current_dir {
        return Ok(dict_get_status());
    }

    let dest_db = target.join("ecdict.db");
    let dest_meta = target.join("metadata.json");

    // Protection contract: Never overwrite existing user files in the target directory
    if dest_db.exists() {
        return Err("目标目录已存在同名词库文件 (ecdict.db)，为保护用户已有数据，禁止直接覆盖".to_string());
    }
    if dest_meta.exists() {
        return Err("目标目录已存在同名词库元数据 (metadata.json)，为保护用户已有数据，禁止直接覆盖".to_string());
    }

    // Check target is writable by creating a unique test file
    let pid = std::process::id();
    let test_file = target.join(format!(".linden_write_test_{}", pid));
    fs::write(&test_file, b"ok").map_err(|e| format!("目标目录没有写入权限: {}", e))?;
    let _ = fs::remove_file(&test_file);

    let src_db = get_dict_db_path();
    let src_meta = get_dict_meta_path();

    if src_db.exists() {
        let unique_id = format!("{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let tmp_dest = target.join(format!("ecdict.db.tmp.{}", unique_id));
        let _ = fs::remove_file(&tmp_dest);

        fs::copy(&src_db, &tmp_dest).map_err(|e| format!("复制词典到新目录失败: {}", e))?;

        let conn = Connection::open_with_flags(&tmp_dest, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| {
                let _ = fs::remove_file(&tmp_dest);
                format!("验证新目录词典数据库失败: {}", e)
            })?;
        let count: u64 = conn.query_row("SELECT count(*) FROM entries;", [], |r| r.get(0))
            .map_err(|e| {
                let _ = fs::remove_file(&tmp_dest);
                format!("新目录词典检验失败: {}", e)
            })?;
        if count == 0 {
            let _ = fs::remove_file(&tmp_dest);
            return Err("新目录词典校验条目为0，放弃激活".to_string());
        }
        drop(conn);

        if let Err(e) = fs::rename(&tmp_dest, &dest_db) {
            let _ = fs::remove_file(&tmp_dest);
            return Err(format!("激活新目录词典文件失败: {}", e));
        }

        if src_meta.exists() {
            let _ = fs::copy(&src_meta, &dest_meta);
        }
    }

    {
        let _lock = DB_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let meta_file = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("com.lindenleaf.reader")
            .join("resources_config.json");
        let conf = serde_json::json!({
            "dictionaryDir": target.to_string_lossy().to_string(),
            "migratedAt": chrono_or_now()
        });
        
        // Critical: config write MUST succeed atomically before updating in-memory pointer or deleting old db!
        let unique_cfg_id = format!("{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
        let meta_tmp = meta_file.with_extension(format!("tmp.{}", unique_cfg_id));
        fs::write(&meta_tmp, serde_json::to_string_pretty(&conf).unwrap_or_default())
            .map_err(|e| format!("持久化新目录配置失败: {}", e))?;
        fs::rename(&meta_tmp, &meta_file)
            .map_err(|e| format!("启用新目录配置失败: {}", e))?;

        if let Ok(mut guard) = get_custom_dict_dir_lock().write() {
            *guard = Some(target.clone());
        }

        if current_dir == get_default_dict_storage_dir() && src_db.exists() && dest_db.exists() {
            let _ = fs::remove_file(&src_db);
        }
    }

    Ok(dict_get_status())
}

#[tauri::command]
pub fn resource_clear_audio_cache() -> Result<u64, String> {
    let app_data = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("com.lindenleaf.reader");
    let audio_cache_dir = dirs::cache_dir().unwrap_or_else(|| app_data).join("com.lindenleaf.reader").join("audio_cache");
    let mut cleared_bytes: u64 = 0;
    if audio_cache_dir.exists() {
        if let Ok(entries) = fs::read_dir(&audio_cache_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if let Ok(meta) = entry.metadata() {
                    cleared_bytes += meta.len();
                }
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(cleared_bytes)
}

fn chrono_or_now() -> String {
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("timestamp:{}", secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_lemma_candidates_unicode_safety() {
        // Non-existent stem + curly apostrophe possessive: e.g. "foobarbaz’s"
        let c1 = generate_lemma_candidates("foobarbaz’s");
        assert!(c1.contains(&"foobarbaz".to_string()));

        // Straight apostrophe possessive: e.g. "foobarbaz's"
        let c2 = generate_lemma_candidates("foobarbaz's");
        assert!(c2.contains(&"foobarbaz".to_string()));

        // Trailing curly apostrophe: e.g. "readers’"
        let c3 = generate_lemma_candidates("readers’");
        assert!(c3.contains(&"readers".to_string()));
        assert!(c3.contains(&"reader".to_string()));

        // Trailing straight apostrophe: e.g. "readers'"
        let c4 = generate_lemma_candidates("readers'");
        assert!(c4.contains(&"readers".to_string()));
        assert!(c4.contains(&"reader".to_string()));

        // Accented Latin: e.g. "café’s"
        let c5 = generate_lemma_candidates("café’s");
        assert!(c5.contains(&"café".to_string()));

        // Empty string
        let c6 = generate_lemma_candidates("");
        assert!(c6.is_empty());

        // Single apostrophe
        let c7 = generate_lemma_candidates("’");
        assert!(c7.is_empty());

        let c8 = generate_lemma_candidates("'");
        assert!(c8.is_empty());
    }

    #[test]
    fn test_dict_lookup_edge_cases_and_recovery() {
        // 1. Empty input
        let r_empty = dict_lookup("".to_string());
        assert!(!r_empty.found);

        // 2. Oversized input (> 256 chars)
        let long_word = "a".repeat(300);
        let r_long = dict_lookup(long_word);
        assert!(!r_long.found);
        assert_eq!(r_long.source, "查询内容过长");

        // 3. Non-existent stem with curly apostrophe: MUST NOT panic!
        let r_curly = dict_lookup("xyznonexistentword’s".to_string());
        assert!(!r_curly.found);

        // 4. Straight apostrophe possessive non-existent
        let r_straight = dict_lookup("xyznonexistentword's".to_string());
        assert!(!r_straight.found);

        // 5. Trailing curly apostrophe non-existent
        let r_trail = dict_lookup("xyznonexistentwords’".to_string());
        assert!(!r_trail.found);

        // 6. Accented Latin
        let r_accent = dict_lookup("café’s".to_string());
        let _ = r_accent; // must not panic

        // 7. Subsequent lookup for "hello" should succeed without mutex corruption if db exists
        let r_hello = dict_lookup("hello".to_string());
        if get_effective_db_path().is_some() {
            assert!(r_hello.found);
            assert_eq!(r_hello.word, "hello");
        }
    }

    #[test]
    fn test_parse_csv_line_fields() {
        let line1 = "hello,həˈləʊ,definition,\"trans1\\ntrans2\",n,,,,,,exchange";
        let cols = parse_csv_line_fields(line1);
        assert_eq!(cols.len(), 11);
        assert_eq!(cols[0], "hello");
        assert_eq!(cols[1], "həˈləʊ");
        assert_eq!(cols[2], "definition");
        assert_eq!(cols[3], "trans1\\ntrans2");
        assert_eq!(cols[4], "n");
        assert_eq!(cols[10], "exchange");

        let line_quotes = "\"word with, comma\",\"quoted\"\"quote\",def,trans";
        let cols2 = parse_csv_line_fields(line_quotes);
        assert_eq!(cols2[0], "word with, comma");
        assert_eq!(cols2[1], "quoted\"quote");
    }

    #[test]
    fn test_convert_csv_to_sqlite() {
        let temp_dir = std::env::temp_dir().join(format!("linden_test_dict_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let csv_file = temp_dir.join("test.csv");
        let db_file = temp_dir.join("test.db");

        let sample_csv = "word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n\
book,bʊk,\"a written or printed work\",\"n. 书籍\\nv. 预订\",n,,,,,p:books,\n\
read,riːd,\"look at and comprehend\",\"v. 阅读\\nn. 读物\",v,,,,,p:reads,\n";
        fs::write(&csv_file, sample_csv).unwrap();

        let count = convert_csv_to_sqlite(&csv_file, &db_file, None).unwrap();
        assert_eq!(count, 2);

        let conn = Connection::open_with_flags(&db_file, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let trans: String = conn.query_row("SELECT translation FROM entries WHERE word = 'book';", [], |r| r.get(0)).unwrap();
        assert!(trans.contains("书籍\n"));

        let _ = fs::remove_file(&csv_file);
        let _ = fs::remove_file(&db_file);
        let _ = fs::remove_dir(&temp_dir);
    }
}

