// Translation task state and validation, independent of DOM, network and credentials.
// Integration contract: request uses the existing guarded native AI broker.
// commit must verify isCurrent() and content revision INSIDE its storage transaction.
import { getAiResponseState } from './ai-response-state.js';
import { t } from './i18n.js';

export function translationError(code, message, diagnostic = {}) {
  return Object.assign(new Error(message), { code, diagnostic: { ...diagnostic, errorCode: code } });
}
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
export function parseTruncatedJsonArray(text, { details = false } = {}) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. First attempt direct parse
  try {
    const val = JSON.parse(trimmed);
    if (Array.isArray(val)) return details ? { items: val, complete: true, closed: true } : val;
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
  let complete = false;
  let closed = false;

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
        closed = true;
        try { complete = Array.isArray(JSON.parse(trimmed.slice(startIndex, i + 1))); } catch (_) {}
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

  return recovered.length > 0 ? (details ? { items: recovered, complete, closed } : recovered) : null;
}

// A response to exactly one source unit needs no model-generated alignment metadata.
function inspectSingleTranslation(raw, expectedIds) {
  if (expectedIds.length !== 1) throw new Error('Single-text translation requires exactly one source unit');
  let text = String(raw ?? '').trim();
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  const fence = text.match(/^```(?:json|text|plaintext)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) text = fence[1].trim();
  const diagnostic = { protocol: 'single-text-v1', expected: 1, expectedIds: expectedIds.slice(), matched: 0, structure: 'text', recovered: false, responseChars: text.length };
  const fail = (code, message) => { throw translationError(code, message, { ...diagnostic, responsePreview: text.slice(0, 2000) }); };
  // Compatible services sometimes keep a JSON wrapper despite a plain-text instruction.
  // Every returned translation still belongs to this one source unit, so no positional guessing occurs.
  if (/^[\[{]/.test(text)) {
    let value;
    try { value = JSON.parse(text); } catch (_) {
      if (/^\{\s*"(?:translations?|id)"\s*:|^\[\s*(?:"|\{)/.test(text)) fail('invalid_json', t('transJobError.wrapperIncomplete'));
    }
    if (value !== undefined) {
      let pieces = Array.isArray(value) ? value : value?.translations;
      if (typeof value?.translation === 'string') pieces = [value.translation];
      if (Array.isArray(pieces)) {
        const texts = pieces.map(item => typeof item === 'string' ? item : item?.translation);
        if (!texts.length || texts.some(item => typeof item !== 'string') || !texts.some(item => item.trim())) fail('invalid_items', t('transJobError.noValidBody'));
        text = texts.map(item => item.trim()).filter(Boolean).join('\n\n');
        diagnostic.structure = 'single_translation_wrapper';
      } else if (value && ('translation' in value || 'translations' in value || 'id' in value)) {
        fail('invalid_items', t('transJobError.noValidBody'));
      }
    }
  }
  if (!text || text === '""' || text === '{}') fail('empty_response', t('transJobError.noValidBody'));
  diagnostic.matched = 1;
  diagnostic.returned = 1;
  return { translated: [{ id: expectedIds[0], translation: text }], diagnostic };
}

export function inspectTranslationResponse(raw, expectedIds, { protocol = 'id-v1' } = {}) {
  if (!Array.isArray(expectedIds) || !expectedIds.length || new Set(expectedIds).size !== expectedIds.length)
    throw new Error('Invalid expected paragraph IDs');
  if (protocol === 'single-text-v1') return inspectSingleTranslation(raw, expectedIds);
  let text = String(raw ?? '').trim();
  // Strip code fences if present (tolerant to ```json, whitespace, CRLF)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    // If text has an unclosed markdown fence from truncation:
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  const diagnostic = { protocol, expected: expectedIds.length, expectedIds: expectedIds.slice(), matched: 0, structure: 'invalid', recovered: false };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Ordered output needs a complete array: a missing item would shift every later paragraph.
    if (protocol === 'ordered-v1') {
      throw translationError(text ? 'invalid_json' : 'empty_response', text ? t('transJobError.invalidJsonOrdered') : t('transJobError.noTranslation'), diagnostic);
    }
    // Linear scan recovery: immune to braces inside strings
    const recovered = parseTruncatedJsonArray(text, { details: true });
    if (!recovered) {
      throw translationError(text ? 'invalid_json' : 'empty_response', text ? t('transJobError.invalidJson') : t('transJobError.noTranslation'), diagnostic);
    }
    parsed = recovered.items;
    diagnostic.recovered = !recovered.complete;
    diagnostic.arrayClosed = recovered.closed;
  }

  diagnostic.structure = Array.isArray(parsed) ? 'array' : (parsed && typeof parsed === 'object' ? 'object' : typeof parsed);
  // A common compatible-service envelope. IDs are still validated; never infer correspondence.
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.translations)) {
    parsed = parsed.translations;
    diagnostic.structure = 'translations_array';
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw translationError(Array.isArray(parsed) ? 'empty_response' : 'non_array', t('transJobError.emptyArray'), diagnostic);
  }

  diagnostic.returned = parsed.length;
  diagnostic.itemTypes = [...new Set(parsed.map(item => item === null ? 'null' : typeof item))];
  if (protocol === 'ordered-v1') {
    // The request explicitly asks for an ordered string array. Stable storage IDs never leave the app.
    if (parsed.length !== expectedIds.length) {
      throw translationError('count_mismatch', t('transJobError.countMismatch', { expected: expectedIds.length, returned: parsed.length }), diagnostic);
    }
    if (parsed.some(item => typeof item !== 'string' || !item.trim())) {
      throw translationError('invalid_items', t('transJobError.invalidArrayItems'), diagnostic);
    }
    diagnostic.matched = expectedIds.length;
    return { translated: expectedIds.map((id, index) => ({ id, translation: parsed[index].trim() })), diagnostic };
  }
  diagnostic.returnedIds = parsed.slice(0, 12).map(item => typeof item?.id === 'string' ? item.id.slice(0, 80) : null);

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
    throw translationError('id_mismatch', t('transJobError.idMismatch'), diagnostic);
  }

  diagnostic.matched = result.size;
  return { translated: expectedIds.map(id => ({ id, translation: result.get(id) || '' })).filter(item => Boolean(item.translation)), diagnostic };
}

export function validateTranslationResponse(raw, expectedIds) {
  return inspectTranslationResponse(raw, expectedIds).translated;
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
    let durableCompleted = 0;
    let batchIndex = 0;
    const waitUntilRunnable = async () => {
      while (job.state === 'paused' && isCurrent()) {
        await new Promise(resolve => { job.wake = resolve; });
      }
      job.wake = null;
      if (!isCurrent()) throw new DOMException('Translation cancelled before dispatch', 'AbortError');
    };

    try {
      let isFirst = true;
      for (const chunk of batch) {
        batchIndex++;
        if (!isFirst) {
          const waitTime = typeof getCooldownRemainingMs === 'function'
            ? Math.max(0, getCooldownRemainingMs())
            : cooldownMs;

          if (waitTime > 0) {
            onProgress({ key, completed, durableCompleted, total: ids.length, batchIndex, batches: batch.length, waitingMs: waitTime });
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
        const raw = await request({ identity: structuredClone(snapshot), key, chunk: structuredClone(chunk), signal: job.controller.signal, waitUntilRunnable });
        if (!isCurrent()) return { status: 'cancelled', completed };
        const status = getAiResponseState(raw);
        const terminal = { batchIndex, batches: batch.length, status, requestId: typeof raw === 'string' ? null : (raw?.requestId || null), finishReason: typeof raw === 'string' ? null : (raw?.finishReason || null) };
        if (status === 'cancelled') return { status, completed, durableCompleted };
        if (raw?.translationProtocol === 'single-text-v1' && (status !== 'completed' || (terminal.finishReason && !['stop', 'end_turn', 'eos_token'].includes(terminal.finishReason)))) {
          const limited = ['length', 'max_tokens'].includes(terminal.finishReason);
          throw translationError(limited ? 'output_limit' : 'interrupted', limited ? t('transJobError.singleOutputLimit') : t('transJobError.singleInterrupted'), { ...terminal, protocol: 'single-text-v1', expected: 1, expectedIds: chunk.map(p => p.id), matched: 0, responsePreview: String(raw?.fullText || raw?.text || '').slice(0, 2000) });
        }
        let inspected;
        try {
          inspected = inspectTranslationResponse(typeof raw === 'string' ? raw : (raw?.fullText || raw?.text || ''), chunk.map(p => p.id), { protocol: raw?.translationProtocol || 'id-v1' });
        } catch (error) {
          error.diagnostic = { ...error.diagnostic, ...terminal };
          throw error;
        }
        const { translated } = inspected;
        const diagnostic = { ...inspected.diagnostic, ...terminal };
        const saved = await commit({ identity: structuredClone(snapshot), key, chunk: structuredClone(chunk), translated, isCurrent });
        if (!isCurrent()) return { status: 'cancelled', completed };
        if (saved !== true && saved?.accepted !== true) throw translationError('save_failed', t('transJobError.saveFailed'), diagnostic);
        completed += translated.length;
        if (saved === true || saved?.durable === true) durableCompleted += translated.length;
        onProgress({ key, completed, durableCompleted, total: ids.length, diagnostic });
        if (status !== 'completed') {
          throw translationError(terminal.finishReason === 'length' || terminal.finishReason === 'max_tokens' ? 'output_limit' : 'interrupted', terminal.finishReason === 'length' || terminal.finishReason === 'max_tokens' ? t('transJobError.batchOutputLimit') : t('transJobError.interrupted'), diagnostic);
        }
        if (translated.length < chunk.length || inspected.diagnostic.recovered) {
          const damaged = inspected.diagnostic.recovered;
          const code = damaged ? (diagnostic.arrayClosed ? 'invalid_json' : 'truncated_json') : 'missing_ids';
          throw translationError(code, damaged ? t('transJobError.damagedJsonPartial') : t('transJobError.missingIds'), diagnostic);
        }
      }
      return { status: 'completed', completed, durableCompleted };
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
  const isMobileRuntime = typeof window !== 'undefined' && (
    Boolean(window.platformBridge?.isAndroid) ||
    Boolean(window.mobileShell?.isMobileViewport?.()) ||
    Boolean(typeof document !== 'undefined' && document.documentElement?.classList?.contains('is-mobile-viewport'))
  );
  for (const key of allowedKeys) {
    if (bookOverride && Object.hasOwn(bookOverride, key)) {
      if (
        isMobileRuntime &&
        key === 'pageTurnMode' &&
        bookOverride[key] === 'none' &&
        bookOverride.pageTurnSourcePlatform !== 'mobile' &&
        globalSettings?.pageTurnMode &&
        globalSettings.pageTurnMode !== 'none'
      ) {
        continue;
      }
      result[key] = structuredClone(bookOverride[key]);
    }
  }
  return result;
}

/**
 * Resolves persisted `preserveOriginalStyles` preference for global settings or per-book overrides.
 * Custom typography (e.g. Noto Serif SC) is prioritized by default unless `preserveOriginalStyles: true`
 * was explicitly enabled.
 */
export function resolveLegacyPreserveOriginalStyles(saved, isOverride = false) {
  if (!saved || typeof saved !== 'object') return isOverride ? undefined : false;
  if (Object.hasOwn(saved, 'preserveOriginalStyles')) {
    return saved.preserveOriginalStyles === true;
  }
  if (isOverride) {
    const hasCustomTypography = (saved.font && saved.font !== 'serif')
      || (saved.fontWeight != null && Number(saved.fontWeight) !== 400)
      || (saved.lineHeight != null && Math.abs(Number(saved.lineHeight) - 1.6) > 0.01)
      || (saved.letterSpacing != null && Math.abs(Number(saved.letterSpacing)) > 0.01)
      || saved.writingMode === 'vertical-rl'
      || saved.chineseQuotes === true
      || saved.comicMode === true
      || saved.firstParaIndent === false;
    if (hasCustomTypography) return false;
    return undefined;
  }
  return false;
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

// Opt-in per chapter launch. Only explicit HTTP service failures before any returned text qualify.
export async function requestTranslationWithRecovery({ invoke, signal, beforeDispatch, onWait, maxRetries = 0, wait = null }) {
  const limit = Math.max(0, Math.min(2, Number(maxRetries) || 0));
  const stopped = () => { if (signal?.aborted) throw new DOMException('Translation cancelled', 'AbortError'); };
  const sleep = wait || ((ms) => new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', stop);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); cleanup(); reject(new DOMException('Translation cancelled', 'AbortError')); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  }));
  for (let retries = 0; ; retries++) {
    stopped();
    await beforeDispatch?.();
    stopped();
    try { return await invoke(); }
    catch (error) {
      const message = typeof error === 'string' ? error : error?.message || '';
      const status = message.match(/^HTTP[\s_:]*(429|502|503|504)\b/)?.[1];
      if (!status || retries >= limit || signal?.aborted) throw error;
      const remainingMs = status === '429' ? 30000 * (retries + 1) : 3000 * (2 ** retries);
      onWait?.({ reason: 'service', status, remainingMs, retryIndex: retries + 1, maxRetries: limit });
      await sleep(remainingMs, signal);
    }
  }
}
