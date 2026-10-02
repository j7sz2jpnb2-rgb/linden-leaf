// Translation task state and validation, independent of DOM, network and credentials.
// Integration contract: request uses the existing guarded native AI broker.
// commit must verify isCurrent() and content revision INSIDE its storage transaction.
export function translationIdentity(value) {
  const keys = ['bookContentHash', 'chapterSourceKey', 'sourceHash', 'parserVersion', 'targetLanguage', 'promptVersion'];
  for (const key of keys) {
    if (typeof value?.[key] !== 'string' || !value[key]) throw new Error(`Missing identity: ${key}`);
  }
  return JSON.stringify(keys.map(key => value[key]));
}

/**
 * Robust linear scanner that recovers complete, closed JSON objects from a truncated JSON array.
 * Correctly distinguishes braces inside string literals vs real JSON structural delimiters.
 */
export function parseTruncatedJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. First attempt direct parse
  try {
    const val = JSON.parse(trimmed);
    if (Array.isArray(val)) return val;
  } catch (_) {}

  // 2. Find start of JSON array
  let startIndex = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '[') {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) return null;

  // 3. State machine linear scan
  const recovered = [];
  let inString = false;
  let escape = false;
  let objectDepth = 0;
  let arrayDepth = 0;
  let objectStart = -1;

  for (let i = startIndex; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '[') {
      arrayDepth++;
    } else if (ch === ']') {
      arrayDepth--;
      if (arrayDepth === 0) {
        break; // Clean closure of root array
      }
    } else if (ch === '{') {
      if (arrayDepth === 1 && objectDepth === 0) {
        objectStart = i;
      }
      objectDepth++;
    } else if (ch === '}') {
      objectDepth--;
      if (arrayDepth === 1 && objectDepth === 0 && objectStart !== -1) {
        const slice = trimmed.slice(objectStart, i + 1);
        try {
          const item = JSON.parse(slice);
          if (item && typeof item === 'object') {
            recovered.push(item);
          }
        } catch (_) {}
        objectStart = -1;
      }
    }
  }

  return recovered.length > 0 ? recovered : null;
}

export function validateTranslationResponse(raw, expectedIds) {
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length)
    throw new Error('Invalid expected paragraph IDs');
  let text = String(raw ?? '').trim();
  // Strip code fences if present (tolerant to ```json, whitespace, CRLF)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // If text has an unclosed markdown fence from truncation:
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Linear scan recovery: immune to braces inside strings
    parsed = parseTruncatedJsonArray(text);
    if (!parsed) {
      throw new Error(`Failed to parse translation JSON: ${err.message}`);
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Incomplete translation response: empty or non-array payload');
  }

  const allowed = new Set(expectedIds);
  const result = new Map();
  const conflictingIds = new Set();

  for (const item of parsed) {
    if (!item || typeof item.id !== 'string') continue;
    if (!allowed.has(item.id)) continue; // Unknown IDs ignored

    const trans = typeof item.translation === 'string' ? item.translation.trim() : '';
    if (!trans) continue;

    if (result.has(item.id)) {
      if (result.get(item.id) !== trans) {
        // Conflicting duplicate ID: reject both
        conflictingIds.add(item.id);
      }
    } else {
      result.set(item.id, trans);
    }
  }

  // Remove conflicting duplicate IDs
  for (const confId of conflictingIds) {
    result.delete(confId);
  }

  if (result.size === 0) {
    throw new Error('No valid paragraph translations matched the expected IDs');
  }

  return expectedIds.map(id => ({ id, translation: result.get(id) || '' })).filter(item => Boolean(item.translation));
}

// One active task, including its cancellation/commit cleanup. Never unlock on stop alone.
export class TranslationJobCoordinator {
  #active = null;
  #sequence = 0;
  #finalizePromise = Promise.resolve();

  get busy() { return this.#active !== null; }
  get state() { return this.#active?.state ?? 'idle'; }
  get finalizePromise() { return this.#finalizePromise; }

  stop() {
    const job = this.#active;
    if (!job) return;
    job.state = 'cancelling';
    job.controller.abort();
    job.wake?.();
  }

  pause() {
    if (this.#active?.state === 'running') this.#active.state = 'paused';
  }

  resume() {
    if (this.#active?.state !== 'paused') return;
    this.#active.state = 'running';
    this.#active.wake?.();
  }

  async run({ identity, chunks, request, commit, onProgress = () => {}, cooldownMs = 0, getCooldownRemainingMs = null }) {
    if (this.busy) throw new Error('Translation task is still active');
    const snapshot = structuredClone(identity);
    const key = translationIdentity(snapshot);
    const batch = structuredClone(chunks);
    if (!Array.isArray(batch) || !batch.length || batch.some(c => !Array.isArray(c) || !c.length))
      throw new Error('No translation chunks');
    const ids = batch.flat().map(p => p.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
      throw new Error('Invalid or duplicated paragraph IDs');

    let resolveFinalize;
    this.#finalizePromise = new Promise(resolve => { resolveFinalize = resolve; });

    const job = { sequence: ++this.#sequence, state: 'running', controller: new AbortController(), wake: null };
    this.#active = job;
    const isCurrent = () => this.#active === job && !job.controller.signal.aborted;
    let completed = 0;

    try {
      let isFirst = true;
      for (const chunk of batch) {
        if (!isFirst) {
          const waitTime = typeof getCooldownRemainingMs === 'function'
            ? Math.max(0, getCooldownRemainingMs())
            : cooldownMs;

          if (waitTime > 0) {
            if (!isCurrent() || job.controller.signal.aborted) return { status: 'cancelled', completed };
            const aborted = await new Promise(resolve => {
              if (job.controller.signal.aborted) return resolve(true);
              let timer = null;
              const onAbort = () => {
                if (timer) clearTimeout(timer);
                job.controller.signal.removeEventListener('abort', onAbort);
                resolve(true);
              };
              timer = setTimeout(() => {
                job.controller.signal.removeEventListener('abort', onAbort);
                resolve(false);
              }, waitTime);
              job.controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            if (aborted || !isCurrent()) return { status: 'cancelled', completed };
          }
        }
        isFirst = false;

        if (job.state === 'paused') {
          await new Promise(resolve => { job.wake = resolve; });
        }
        job.wake = null;
        if (!isCurrent()) return { status: 'cancelled', completed };

        // Broker implements native concurrency, cooldown, output budget and cancellation.
        // No automatic retry: a failed network response may already have been billed.
        const raw = await request({ identity: structuredClone(snapshot), key, chunk: structuredClone(chunk), signal: job.controller.signal });
        if (!isCurrent()) return { status: 'cancelled', completed };
        const translated = validateTranslationResponse(raw, chunk.map(p => p.id));
        const saved = await commit({ identity: structuredClone(snapshot), key, chunk: structuredClone(chunk), translated, isCurrent });
        if (!isCurrent()) return { status: 'cancelled', completed };
        if (saved !== true) throw new Error('Translation was not durably saved');
        completed += translated.length;
        onProgress({ key, completed, total: ids.length });
        if (translated.length < chunk.length) {
          throw new Error('模型单次输出达到上限，部分段落未在本次返回中完成');
        }
      }
      return { status: 'completed', completed };
    } catch (error) {
      if (!isCurrent()) return { status: 'cancelled', completed };
      throw error; // Caller displays partial/failed; already committed chunks remain durable.
    } finally {
      if (this.#active === job) this.#active = null;
      resolveFinalize?.();
    }
  }
}

export const READER_OVERRIDE_ALLOWED_KEYS = [
  'font',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'margin',
  'maxWidth',
  'gap',
  'columnCount',
  'layout',
  'writingMode',
  'justify',
  'hyphenate',
  'theme',
  'chineseQuotes',
  'pageTurnMode',
  'firstParaIndent',
  'paraMarginTop',
  'paraMarginBottom',
  'paraIndentSize',
  'preserveOriginalStyles'
];

// A pure overlay. UI must edit the selected layer, never an effective merged object.
export function resolveReaderSettings(globalSettings, bookOverride, allowedKeys = READER_OVERRIDE_ALLOWED_KEYS) {
  const result = structuredClone(globalSettings);
  for (const key of allowedKeys) {
    if (bookOverride && Object.hasOwn(bookOverride, key)) result[key] = structuredClone(bookOverride[key]);
  }
  return result;
}

/**
 * Checks if two translation records or payloads are version-compatible for paragraph-level merging.
 * If sourceHash, parserVersion, targetLanguage, or promptVersion mismatch, returns false.
 */
export function checkTranslationCompatibility(a, b) {
  if (!a || !b) return false;
  if ((a.sourceHash || b.sourceHash) && a.sourceHash !== b.sourceHash) return false;
  if ((a.parserVersion || b.parserVersion) && a.parserVersion !== b.parserVersion) return false;
  if ((a.targetLanguage || b.targetLanguage) && a.targetLanguage !== b.targetLanguage) return false;
  if ((a.promptVersion || b.promptVersion) && a.promptVersion !== b.promptVersion) return false;
  return true;
}

/**
 * Standard revision archive builder for chapter bilingual translations.
 * Strictly avoids leaking local paths, secrets, API keys, or authorization tokens.
 */
export function buildTranslationRevisionArchive(data = {}) {
  const now = Date.now();
  const cleanId = String(data.id || `${data.bookId}::${data.chapterKey}`);
  const revId = data.revisionId || `rev_${now}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    schemaVersion: 1,
    archiveType: 'chapter_translation_revision',
    revisionId: revId,
    parentRevisionIds: Array.isArray(data.parentRevisionIds) ? data.parentRevisionIds : [],
    id: cleanId,
    bookId: String(data.bookId || ''),
    bookStableKey: String(data.bookStableKey || data.contentHash || data.bookId || ''),
    contentHash: String(data.contentHash || data.bookContentHash || ''),
    chapterKey: String(data.chapterKey || ''),
    chapterSourceKey: String(data.chapterSourceKey || data.chapterKey || ''),
    title: String(data.title || ''),
    sourceHash: String(data.sourceHash || ''),
    parserVersion: String(data.parserVersion || 'foliate-txt-epub-v1'),
    targetLanguage: String(data.targetLanguage || 'zh-CN'),
    promptVersion: String(data.promptVersion || 'translation-v1-auto'),
    model: String(data.model || 'gpt-4o-mini'),
    clientId: String(data.clientId || 'local'),
    status: data.status || 'partial',
    totalParagraphs: Number(data.totalParagraphs) || data.paragraphs?.length || 0,
    completedParagraphs: (data.paragraphs || []).filter(p => p.status === 'completed' && p.translation?.trim()).length,
    paragraphs: (data.paragraphs || []).map(p => ({
      id: p.id,
      sourceText: p.sourceText || p.text || '',
      translation: p.translation || '',
      sourceHash: p.sourceHash || '',
      status: p.status || 'pending',
      subChunks: Array.isArray(p.subChunks) ? p.subChunks.map(sc => ({
        id: sc.id,
        subChunkIndex: sc.subChunkIndex,
        totalSubChunks: sc.totalSubChunks,
        text: sc.text,
        translation: sc.translation,
        status: sc.status
      })) : undefined,
      updatedAt: p.updatedAt || now
    })),
    conflictRevisions: Array.isArray(data.conflictRevisions) ? data.conflictRevisions : [],
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now
  };
}
