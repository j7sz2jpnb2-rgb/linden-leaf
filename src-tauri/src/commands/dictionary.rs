use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

static IS_INSTALLING: AtomicBool = AtomicBool::new(false);
static DB_MUTEX: Mutex<()> = Mutex::new(());

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

fn get_dict_storage_dir() -> PathBuf {
    let mut dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("com.lindenleaf.reader");
    dir.push("dictionary");
    let _ = fs::create_dir_all(&dir);
    dir
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

fn get_bundled_db_path() -> PathBuf {
    PathBuf::from("resources").join("dictionary").join("ecdict.db")
}

fn get_effective_db_path() -> Option<PathBuf> {
    let user_path = get_dict_db_path();
    if user_path.exists() {
        return Some(user_path);
    }
    let bundled = get_bundled_db_path();
    if bundled.exists() {
        return Some(bundled);
    }
    None
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

    // Plural / 3rd person -s, -es, -ies
    if lower.ends_with("ies") && lower.len() > 3 {
        candidates.push(format!("{}y", &lower[..lower.len() - 3]));
    }
    if lower.ends_with("es") && lower.len() > 3 {
        candidates.push(lower[..lower.len() - 2].to_string());
        candidates.push(lower[..lower.len() - 1].to_string());
    }
    if lower.ends_with('s') && lower.len() > 2 {
        candidates.push(lower[..lower.len() - 1].to_string());
    }

    // Past tense / participle -ed, -ied, doubled consonant
    if lower.ends_with("ied") && lower.len() > 3 {
        candidates.push(format!("{}y", &lower[..lower.len() - 3]));
    }
    if lower.ends_with("ed") && lower.len() > 3 {
        candidates.push(lower[..lower.len() - 2].to_string());
        candidates.push(lower[..lower.len() - 1].to_string());
        // Doubled consonant: stopped -> stop, planned -> plan
        let base = &lower[..lower.len() - 2];
        if base.len() >= 3 {
            let bytes = base.as_bytes();
            if bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
                candidates.push(base[..base.len() - 1].to_string());
            }
        }
    }

    // Present participle / gerund -ing, doubled consonant
    if lower.ends_with("ing") && lower.len() > 4 {
        candidates.push(lower[..lower.len() - 3].to_string());
        candidates.push(format!("{}e", &lower[..lower.len() - 3]));
        let base = &lower[..lower.len() - 3];
        if base.len() >= 3 {
            let bytes = base.as_bytes();
            if bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
                candidates.push(base[..base.len() - 1].to_string());
            }
        }
    }

    // Possessives: 's, ’s, or trailing apostrophe
    if lower.ends_with("'s") || lower.ends_with("’s") {
        if lower.len() > 2 {
            candidates.push(lower[..lower.len() - 2].to_string());
        }
    } else if lower.ends_with('\'') || lower.ends_with('’') {
        if lower.len() > 1 {
            let base = &lower[..lower.len() - 1];
            candidates.push(base.to_string());
            if base.ends_with('s') && base.len() > 1 {
                candidates.push(base[..base.len() - 1].to_string());
            }
        }
    }

    // Hyphenated compounds: "well-known" -> "well", "known"
    if lower.contains('-') {
        for part in lower.split('-') {
            let p = part.trim();
            if !p.is_empty() && !candidates.contains(&p.to_string()) {
                candidates.push(p.to_string());
            }
        }
    }

    // Adverbs -ly
    if lower.ends_with("ly") && lower.len() > 3 {
        candidates.push(lower[..lower.len() - 2].to_string());
        candidates.push(format!("{}le", &lower[..lower.len() - 2]));
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

    // Verify DB can be opened and queried
    let _lock = DB_MUTEX.lock().unwrap();
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
    if norm.is_empty() {
        return DictLookupResult {
            found: false,
            word,
            normalized_word: String::new(),
            phonetic: String::new(),
            entries: Vec::new(),
            translation_raw: String::new(),
            source: "基础离线词库".to_string(),
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

    let _lock = DB_MUTEX.lock().unwrap();
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
    let _lock = DB_MUTEX.lock().unwrap();
    let db_path = get_dict_db_path();
    let meta_path = get_dict_meta_path();
    if db_path.exists() {
        let _ = fs::remove_file(db_path);
    }
    if meta_path.exists() {
        let _ = fs::remove_file(meta_path);
    }
    Ok(true)
}

#[tauri::command]
pub fn dict_install_from_file(source_path: String) -> Result<DictStatus, String> {
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err("所选词典文件不存在".to_string());
    }

    let _lock = DB_MUTEX.lock().unwrap();
    IS_INSTALLING.store(true, Ordering::SeqCst);

    // Validate that it's a valid SQLite database with entries table
    let conn = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开 SQLite 数据库: {}", e))?;
    let count: u64 = conn.query_row("SELECT count(*) FROM entries;", [], |r| r.get(0))
        .map_err(|e| format!("词典数据库格式不正确 (缺少 entries 表): {}", e))?;

    if count == 0 {
        IS_INSTALLING.store(false, Ordering::SeqCst);
        return Err("词典数据库中未找到任何词条".to_string());
    }

    let dest = get_dict_db_path();
    let tmp = get_dict_storage_dir().join("ecdict.db.tmp");
    fs::copy(src, &tmp).map_err(|e| format!("复制词典文件失败: {}", e))?;

    // Atomic rename
    fs::rename(&tmp, &dest).map_err(|e| format!("启用词典文件失败: {}", e))?;

    // Write metadata
    let metadata = serde_json::json!({
        "name": "Skywind3000 ECDICT",
        "version": "1.0.28",
        "totalEntries": count,
        "installedAt": chrono_or_now(),
        "source": "local_file",
        "originalPath": source_path
    });
    let _ = fs::write(get_dict_meta_path(), serde_json::to_string_pretty(&metadata).unwrap());

    IS_INSTALLING.store(false, Ordering::SeqCst);
    Ok(dict_get_status())
}

fn chrono_or_now() -> String {
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("timestamp:{}", secs)
}
