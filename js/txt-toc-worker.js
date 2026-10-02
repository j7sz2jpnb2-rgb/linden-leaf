/**
 * txt-toc-worker.js - Terminable Isolated Worker for User-Defined TXT TOC Regular Expressions
 * Prevents catastrophic backtracking (ReDoS) from freezing the UI main thread.
 * Isolated TXT chapter-heading matching.
 */

export const MAX_RULE_PATTERN_LENGTH = 200
export const MAX_SAFE_LINE_LENGTH = 300
export const DEFAULT_WORKER_TIMEOUT_MS = 1500

const WORKER_SCRIPT_TEXT = `
self.onmessage = function(e) {
    const { lines, rules, maxMatches = 5000 } = e.data || {};
    try {
        if (!Array.isArray(rules) || rules.length === 0) {
            self.postMessage({ ok: true, matches: [], stats: { scanned: 0, matched: 0 } });
            return;
        }

        const compiledRules = [];
        for (const rule of rules) {
            const pat = String(rule.pattern || '').trim();
            if (!pat || pat.length > 200) continue;
            const flags = (rule.flags || 'i').replace(/[^gimsuy]/g, '');
            compiledRules.push({
                re: new RegExp(pat, flags),
                groupIndex: Number(rule.groupIndex) || 0,
                level: Number(rule.level) || 1
            });
        }

        if (compiledRules.length === 0) {
            self.postMessage({ ok: true, matches: [], stats: { scanned: 0, matched: 0 } });
            return;
        }

        const matches = [];
        const totalLines = Array.isArray(lines) ? lines.length : 0;
        let skippedLongLines = 0;

        for (let i = 0; i < totalLines; i++) {
            const raw = lines[i];
            const trimmed = (typeof raw === 'string' ? raw : (raw?.text ?? '')).trim();
            if (!trimmed) continue;
            // Prevent catastrophic backtracking on oversized single lines; record count for caller
            if (trimmed.length > 300) {
                skippedLongLines++;
                continue;
            }

            for (const cr of compiledRules) {
                cr.re.lastIndex = 0;
                const m = cr.re.exec(trimmed);
                if (m) {
                    let title = trimmed;
                    if (cr.groupIndex > 0 && m[cr.groupIndex]) {
                        title = m[cr.groupIndex].trim();
                    } else if (m[0]) {
                        title = m[0].trim();
                    }
                    matches.push({
                        lineIndex: i,
                        text: trimmed,
                        title: title || trimmed,
                        level: cr.level,
                        matchedLength: m[0]?.length || 0
                    });
                    if (matches.length >= maxMatches) break;
                }
            }
            if (matches.length >= maxMatches) break;
        }

        self.postMessage({
            ok: true,
            matches,
            stats: { scanned: totalLines, matched: matches.length, skippedLongLines }
        });
    } catch (err) {
        self.postMessage({ ok: false, error: err.message || String(err) });
    }
};
`

/**
 * Execute custom regex scanning inside a terminable Worker with strict timeout.
 * @param {object} options
 * @param {string[]} options.lines
 * @param {Array<{pattern: string, flags?: string, groupIndex?: number, level?: number}>} options.rules
 * @param {number} [options.maxMatches=5000]
 * @param {number} [options.timeoutMs=1500]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ matches: Array, stats: object }>}
 */
export async function runTxtRulesWorker({
    lines = [],
    rules = [],
    customRules = null,
    maxMatches = 5000,
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
    signal = null
}) {
    const activeRules = (Array.isArray(rules) && rules.length > 0)
        ? rules
        : (Array.isArray(customRules) ? customRules : [])

    if (!Array.isArray(activeRules) || activeRules.length === 0) {
        return { matches: [], headings: [], stats: { scanned: 0, matched: 0 } }
    }

    // Validate rules patterns first
    for (const rule of activeRules) {
        const pat = String(rule.pattern || '').trim()
        if (pat.length > MAX_RULE_PATTERN_LENGTH) {
            throw new Error(`正则表达式长度不能超过 ${MAX_RULE_PATTERN_LENGTH} 字符`)
        }
        // Test compilation
        try {
            new RegExp(pat, rule.flags || 'i')
        } catch (e) {
            throw new Error(`正则表达式语法错误: ${e.message}`)
        }
    }

    // 1. Browser Worker Execution via Blob URL
    if (typeof window !== 'undefined' && typeof window.Worker === 'function' && typeof Blob !== 'undefined') {
        return new Promise((resolve, reject) => {
            let worker = null
            let timeoutTimer = null

            const cleanup = () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer)
                    timeoutTimer = null
                }
                if (worker) {
                    worker.terminate()
                    worker = null
                }
            }

            try {
                const blob = new Blob([WORKER_SCRIPT_TEXT], { type: 'application/javascript' })
                const blobUrl = URL.createObjectURL(blob)
                worker = new Worker(blobUrl)
                URL.revokeObjectURL(blobUrl)

                timeoutTimer = setTimeout(() => {
                    cleanup()
                    reject(new Error(`TXT 目录正则解析超时 (${timeoutMs}ms)，可能存在灾难性回溯 (ReDoS) 风险。已安全终止 Worker。`))
                }, timeoutMs)

                if (signal) {
                    signal.addEventListener('abort', () => {
                        cleanup()
                        reject(new Error('TXT 目录规则解析任务已由用户取消'))
                    }, { once: true })
                }

                worker.onmessage = (e) => {
                    cleanup()
                    if (e.data?.ok) {
                        const m = e.data.matches || []
                        resolve({
                            matches: m,
                            headings: m,
                            stats: e.data.stats || { scanned: lines.length, matched: m.length }
                        })
                    } else {
                        reject(new Error(e.data?.error || 'Worker execution failed'))
                    }
                }

                worker.onerror = (err) => {
                    cleanup()
                    reject(new Error(err.message || 'Worker runtime error'))
                }

                worker.postMessage({ lines, rules: activeRules, maxMatches })
            } catch (err) {
                cleanup()
                reject(err)
            }
        })
    }

    // 2. Node.js Environment (Testing / Headless) using worker_threads or safe timeout
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
        const workerThreads = process.getBuiltinModule('node:worker_threads')
        if (workerThreads?.Worker) {
            return new Promise((resolve, reject) => {
                let worker = null
                let timeoutTimer = null

                const cleanup = () => {
                    if (timeoutTimer) {
                        clearTimeout(timeoutTimer)
                        timeoutTimer = null
                    }
                    if (worker) {
                        worker.terminate()
                        worker = null
                    }
                }

                try {
                    const nodeWorkerScript = `
                        import { parentPort } from 'node:worker_threads';
                        const self = { postMessage: (msg) => parentPort.postMessage(msg) };
                        ${WORKER_SCRIPT_TEXT}
                        parentPort.on('message', (data) => {
                            self.onmessage({ data });
                        });
                    `
                    worker = new workerThreads.Worker(nodeWorkerScript, { eval: true })

                    timeoutTimer = setTimeout(() => {
                        cleanup()
                        reject(new Error(`TXT 目录正则解析超时 (${timeoutMs}ms)，已安全终止。`))
                    }, timeoutMs)

                    worker.on('message', (msg) => {
                        cleanup()
                        if (msg?.ok) {
                            const m = msg.matches || []
                            resolve({ matches: m, headings: m, stats: msg.stats || {} })
                        } else {
                            reject(new Error(msg?.error || 'Worker failed'))
                        }
                    })

                    worker.on('error', (err) => {
                        cleanup()
                        reject(err)
                    })

                    worker.postMessage({ lines, rules: activeRules, maxMatches })
                } catch (e) {
                    cleanup()
                    reject(e)
                }
            })
        }
    }

    // 3. Capability Guard:
    // When terminable Worker is unavailable, strictly refuse synchronous execution.
    // Line length limits and line counts do not protect against catastrophic backtracking (ReDoS).
    // Safely stop custom rule processing so the host keeps the heuristic/original TOC intact.
    throw new Error('Worker 独立运行环境不可用，已安全停止自定义正则扫描以防止界面冻结，保留原书籍目录。')
}
