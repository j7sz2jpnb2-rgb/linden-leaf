// Advanced settings values and normalization; no UI or service initialization.

export const DEFAULT_ADVANCED_SETTINGS = Object.freeze({
    aiContextTokenBudget: 1000,          // 0 to 10000 tokens (0 = no extra context, 10000 = hard ceiling)
    inPlaceParagraphTranslation: false,  // Enable in-place paragraph translation card
    modelTokenizer: 'auto',              // 'auto' | 'cl100k_base' | 'gpt2' | 'cjk_heuristic'
    aiMaxTokens: 20000,                   // 256 to 20000 tokens
    aiCooldownSeconds: 10,               // 0 to 3600 seconds (0 truly active)
    aiDailyLimit: 0,                     // 0 = unlimited / unconfigured
    dictSaveHistory: false,              // Save local dictionary lookups
    dictLookupDelay: 250,                // 100 to 600 ms
    dictLemmatization: true,             // English lemmatization
    // TXT TOC Rules
    txtCustomRulesEnable: false,
    txtRegexPattern: '^第\\s*[0-9一二三四五六七八九十百千万零两]+\\s*[首章节回卷集部篇幕话诗歌曲折出段讲场辑案].*',
    txtRegexFlags: 'i',
    txtGroupIndex: 0,
    // Text formatting
    firstParaIndent: true,               // Follow body indent for first paragraph after heading
    paraMarginTop: 0.0,
    paraMarginBottom: 0.5,
    paraIndentSize: '2em',
    txtMergeSoftBreaks: true,
    txtPurifyEnabled: false,
    txtPurifyCustomRules: '',
    // Interaction & Animation
    reducedMotion: false,
    glassmorphismBlur: true,
    animIntensity: 'normal',             // 'none' | 'soft' | 'normal'
    sidebarDefaultWidth: 380,
    // Strokes
    highlighterOpacity: 0.35,
    underlineWidth: 1.5,
    pdfPenWidth: 2.5,
    pdfSmoothing: true,
    // Translation
    chapterTransAutoSave: true,
    chapterTransAutoRestore: true,
    chapterTransStyle: 'auto',
    webdavSyncTranslations: false,
    // Background Index
    bgIndexIdleOnly: true,
    bgIndexConcurrency: 1,
    // TTS Audio & Speech Engine
    ttsProvider: 'system',
    ttsRate: 1.0,
    ttsVoiceId: '',
    ttsSystemVoiceId: '',
    ttsApiVoiceId: 'nova',
    ttsOfflineVoiceId: 'zf_xiaobei',
    ttsApiNoAuth: false,
    ttsApiEndpoint: 'https://api.openai.com/v1/audio/speech',
    ttsApiKeyConfigured: false,
    ttsApiModel: 'tts-1',
    ttsOfflineEndpoint: 'http://127.0.0.1:8880/v1/audio/speech',
    ttsOfflineModel: 'kokoro-82m-zh',
    // Offline OCR (PP-OCRv6 & ONNX Runtime)
    ocrEngine: 'auto',                    // 'auto' | 'ppocrv6-small' | 'ppocrv6-tiny' | 'tesseract'
    ocrBackend: 'auto',                   // 'auto' | 'webgpu' | 'wasm'
    ocrDirection: 'auto',                 // 'auto' | 'horizontal' | 'vertical'
    ocrUseMirror: false,
    ocrIdlePrefetch: true
})

export function sanitizeAdvancedSettings(incoming = {}) {
    const result = { ...DEFAULT_ADVANCED_SETTINGS }
    for (const [key, value] of Object.entries(incoming)) {
        if (!Object.hasOwn(result, key)) continue
        const type = typeof result[key]
        if (type === 'boolean' && typeof value === 'boolean') result[key] = value
        if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) result[key] = value
        if (type === 'string' && typeof value === 'string') {
            const limit = key === 'txtPurifyCustomRules' ? 4000 : 1000
            result[key] = value.trim().slice(0, limit)
        }
    }
    const bounds = { aiContextTokenBudget: [0, 10000], aiMaxTokens: [256, 20000], aiCooldownSeconds: [0, 3600], aiDailyLimit: [0, 100000],
        paraMarginTop: [0, 3], paraMarginBottom: [0, 3], sidebarDefaultWidth: [320, 640], dictLookupDelay: [100, 600],
        highlighterOpacity: [0.15, 0.75], underlineWidth: [0.5, 5], pdfPenWidth: [0.5, 10], bgIndexConcurrency: [1, 4], ttsRate: [0.5, 3] }
    for (const [key, [min, max]] of Object.entries(bounds)) result[key] = Math.max(min, Math.min(max, result[key]))
    const enums = { ttsProvider: ['system', 'api', 'offline'], chapterTransStyle: ['auto', 'literal', 'literary', 'academic'],
        animIntensity: ['none', 'soft', 'normal'], modelTokenizer: ['auto', 'cl100k_base', 'gpt2', 'cjk_heuristic'], paraIndentSize: ['0', '0em', '1em', '2em', '3em'],
        ocrEngine: ['auto', 'ppocrv6-small', 'ppocrv6-tiny', 'tesseract'], ocrBackend: ['auto', 'webgpu', 'wasm'], ocrDirection: ['auto', 'horizontal', 'vertical'] }
    for (const [key, allowed] of Object.entries(enums)) if (!allowed.includes(result[key])) result[key] = DEFAULT_ADVANCED_SETTINGS[key]
    return result
}

export const STORAGE_KEY_CONFIG = 'linden_advanced_settings_config'
