/**
 * sync-config-contract.js
 * Shared config field security & storage key contract for Cloud Sync and Backup/Restore.
 * Prevents drift between syncEngine.js and backup-service.js on excluded credential keys.
 */

export const SYNC_SENSITIVE_CONFIG_KEYS = Object.freeze([
    'ttsApiKey',
    'apiKey',
    'secret',
    'password',
    'token',
    'auth',
    'privateKey',
    'dictStoragePath',
    'customDirectory',
    'ttsOfflineEndpoint',
])

const SENSITIVE_KEY_SET_LOWER = new Set(SYNC_SENSITIVE_CONFIG_KEYS.map(k => k.toLowerCase()))

export const SYNC_STORAGE_KEYS = Object.freeze({
    readingPresets: 'linden_reading_presets_v1',
    customPalette: 'linden_custom_semantic_palette_v1',
    userName: 'linden_user_name',
    bookSettingsPrefix: 'linden_book_settings_',
    advancedConfig: 'linden_advanced_settings_config',
    legacyAdvancedConfig: 'linden_advanced_settings',
})

/**
 * Return a shallow clone of config/settings with all secret/local-only keys removed.
 */
export function stripSensitiveConfigFields(rawConfig) {
    if (!rawConfig || typeof rawConfig !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(rawConfig)) {
        if (!SENSITIVE_KEY_SET_LOWER.has(k.toLowerCase())) {
            out[k] = v
        }
    }
    return out
}
