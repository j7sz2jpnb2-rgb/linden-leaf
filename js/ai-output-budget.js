// Upgrade the previous default once; preserve custom limits and later user changes.
export const AI_OUTPUT_LIMIT_MIGRATION_KEY = 'linden_ai_output_limit_20000_v1'

export function migrateLegacyAiOutputLimit(storage) {
    try {
        storage ??= globalThis.localStorage
        if (!storage || storage.getItem(AI_OUTPUT_LIMIT_MIGRATION_KEY) === '1') return
        for (const [key, field] of [
            ['linden_advanced_settings_config', 'aiMaxTokens'],
            ['linden_ai_assistant_config', 'maxTokens']
        ]) {
            const raw = storage.getItem(key)
            if (!raw) continue
            let config
            try { config = JSON.parse(raw) } catch (_) { continue }
            if (config && typeof config === 'object' && !Array.isArray(config) && config[field] === 2048) {
                config[field] = 20000
                storage.setItem(key, JSON.stringify(config))
            }
        }
        storage.setItem(AI_OUTPUT_LIMIT_MIGRATION_KEY, '1')
    } catch (_) {
        // Storage may be unavailable. Defaults still work without migration.
    }
}
