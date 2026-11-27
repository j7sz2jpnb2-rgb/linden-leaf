// js/ocr-model-manager.js
// Manages on-demand offline PP-OCRv6 models & onnxruntime-web WASM binary
// across Tauri native storage (Windows & Android) and browser IndexedDB fallback.

import { platformBridge } from './platformBridge.js'

export const OCR_MODEL_CATALOG = Object.freeze([
    {
        id: 'ppocrv6-small',
        titleKey: 'settings.ocrModelSmallTitle',
        descKey: 'settings.ocrModelSmallDesc',
        approxMb: 31.2,
        runtimeMb: 28.2
    },
    {
        id: 'ppocrv6-tiny',
        titleKey: 'settings.ocrModelTinyTitle',
        descKey: 'settings.ocrModelTinyDesc',
        approxMb: 6.3,
        runtimeMb: 28.2
    }
])

const WEB_ASSET_DB_NAME = 'linden_ocr_models_web'
const WEB_ASSET_STORE = 'assets'
const RUNTIME_WASM_FILENAME = 'ort-wasm-simd-threaded.jsep.wasm'

function openWebAssetDb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null)
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(WEB_ASSET_DB_NAME, 1)
        req.onupgradeneeded = () => {
            const database = req.result
            if (!database.objectStoreNames.contains(WEB_ASSET_STORE)) {
                database.createObjectStore(WEB_ASSET_STORE, { keyPath: 'key' })
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'))
    })
}

async function webPutAsset(modelId, assetName, buffer) {
    const database = await openWebAssetDb()
    if (!database) return
    const bytes = buffer instanceof Uint8Array
        ? buffer.slice().buffer
        : (buffer instanceof ArrayBuffer ? buffer.slice(0) : new Uint8Array(buffer || []).buffer)
    await new Promise((resolve, reject) => {
        const tx = database.transaction(WEB_ASSET_STORE, 'readwrite')
        tx.objectStore(WEB_ASSET_STORE).put({
            key: `${modelId}/${assetName}`,
            modelId,
            assetName,
            sizeBytes: bytes.byteLength,
            buffer: bytes
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

async function webGetAsset(modelId, assetName) {
    const database = await openWebAssetDb()
    if (!database) return null
    return await new Promise((resolve) => {
        try {
            const tx = database.transaction(WEB_ASSET_STORE, 'readonly')
            const req = tx.objectStore(WEB_ASSET_STORE).get(`${modelId}/${assetName}`)
            req.onsuccess = () => resolve(req.result?.buffer || null)
            req.onerror = () => resolve(null)
        } catch (_) {
            resolve(null)
        }
    })
}

async function webDeleteModel(modelId) {
    const database = await openWebAssetDb()
    if (!database) return
    await new Promise((resolve) => {
        try {
            const tx = database.transaction(WEB_ASSET_STORE, 'readwrite')
            const store = tx.objectStore(WEB_ASSET_STORE)
            const req = store.getAllKeys()
            req.onsuccess = () => {
                const keys = Array.isArray(req.result) ? req.result : []
                for (const k of keys) {
                    if (typeof k === 'string' && k.startsWith(`${modelId}/`)) {
                        store.delete(k)
                    }
                }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => resolve()
        } catch (_) {
            resolve()
        }
    })
}

async function webComputeStatus() {
    const database = await openWebAssetDb()
    const entries = database
        ? await new Promise((resolve) => {
            try {
                const tx = database.transaction(WEB_ASSET_STORE, 'readonly')
                const req = tx.objectStore(WEB_ASSET_STORE).getAll()
                req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
                req.onerror = () => resolve([])
            } catch (_) {
                resolve([])
            }
        })
        : []

    const byKey = new Map(entries.map(item => [item.key, item.sizeBytes || item.buffer?.byteLength || 0]))
    const runtimeSizeBytes = byKey.get(`runtime/${RUNTIME_WASM_FILENAME}`) || 0
    const runtimeInstalled = runtimeSizeBytes > 1024

    const models = ['ppocrv6-small', 'ppocrv6-tiny'].map(id => {
        const required = ['det.onnx', 'rec.onnx', 'rec.yml']
        let sizeBytes = 0
        const missingAssets = []
        for (const asset of required) {
            const sz = byKey.get(`${id}/${asset}`) || 0
            if (sz > (asset === 'rec.yml' ? 100 : 1024)) sizeBytes += sz
            else missingAssets.push(asset)
        }
        const installed = missingAssets.length === 0
        return {
            id,
            installed,
            ready: installed && runtimeInstalled,
            sizeBytes,
            missingAssets
        }
    })

    return {
        storageDir: 'IndexedDB (Browser)',
        runtimeInstalled,
        runtimeSizeBytes,
        models
    }
}

export function classifyLocalOcrAssetFile(fileName) {
    const lower = String(fileName || '').toLowerCase()
    if (!lower) return null
    if (lower.endsWith('.wasm')) {
        return { target: 'runtime', assetName: RUNTIME_WASM_FILENAME }
    }
    if (lower.endsWith('.onnx')) {
        if (lower.includes('det')) return { target: 'model', assetName: 'det.onnx' }
        if (lower.includes('rec')) return { target: 'model', assetName: 'rec.onnx' }
        return null
    }
    if (lower.endsWith('.yml') || lower.endsWith('.yaml') || (lower.endsWith('.txt') && lower.includes('dict'))) {
        return { target: 'model', assetName: 'rec.yml' }
    }
    return null
}

class OcrModelManager {
    constructor() {
        this._cachedStatus = null
        this._cachedAt = 0
        this._listeners = new Set()
    }

    onChange(fn) {
        if (typeof fn !== 'function') return () => {}
        this._listeners.add(fn)
        return () => this._listeners.delete(fn)
    }

    _notifyChange(status) {
        for (const fn of this._listeners) {
            try { fn(status) } catch (_) {}
        }
    }

    invalidateCache() {
        this._cachedStatus = null
        this._cachedAt = 0
    }

    async getStatus({ force = false, maxAgeMs = 3000 } = {}) {
        const now = Date.now()
        if (!force && this._cachedStatus && (now - this._cachedAt) < maxAgeMs) {
            return this._cachedStatus
        }
        let status = null
        if (platformBridge.isTauri) {
            try {
                status = await platformBridge.ocrModelListStatus()
            } catch (_) {
                status = null
            }
        }
        if (!status) {
            status = await webComputeStatus()
        }
        this._cachedStatus = status
        this._cachedAt = Date.now()
        return status
    }

    async downloadModel(modelId, { useMirror = false, onProgress = null, signal = null } = {}) {
        if (!platformBridge.isTauri) {
            throw new Error('Desktop or Android native runtime is required for automatic model download.')
        }
        let stopped = false
        let pollTimer = null

        const poll = async () => {
            if (stopped) return
            try {
                const p = await platformBridge.ocrModelGetDownloadProgress()
                if (p && !stopped) onProgress?.(p)
            } catch (_) {}
        }

        const abortHandler = () => {
            platformBridge.ocrModelCancelDownload().catch(() => {})
        }
        signal?.addEventListener('abort', abortHandler, { once: true })

        try {
            if (onProgress) {
                pollTimer = setInterval(() => { poll() }, 250)
            }
            const status = await platformBridge.ocrModelDownload(modelId, useMirror)
            stopped = true
            clearInterval(pollTimer)
            this._cachedStatus = status
            this._cachedAt = Date.now()
            this._notifyChange(status)
            const finalProgress = await platformBridge.ocrModelGetDownloadProgress().catch(() => null)
            if (finalProgress) onProgress?.(finalProgress)
            return status
        } finally {
            stopped = true
            if (pollTimer) clearInterval(pollTimer)
            signal?.removeEventListener('abort', abortHandler)
        }
    }

    async cancelDownload() {
        if (!platformBridge.isTauri) return false
        return await platformBridge.ocrModelCancelDownload()
    }

    async deleteModel(modelId) {
        let status = null
        if (platformBridge.isTauri) {
            status = await platformBridge.ocrModelDelete(modelId)
        } else {
            await webDeleteModel(modelId)
            status = await webComputeStatus()
        }
        this._cachedStatus = status
        this._cachedAt = Date.now()
        this._notifyChange(status)
        return status
    }

    async importLocalFiles(modelId, fileList) {
        const files = Array.from(fileList || [])
        if (!files.length) return { imported: [], status: await this.getStatus({ force: true }) }
        const imported = []
        let latestStatus = null

        for (const file of files) {
            const matched = classifyLocalOcrAssetFile(file.name)
            if (!matched) continue
            const targetModel = matched.target === 'runtime' ? 'runtime' : modelId
            const buf = await file.arrayBuffer()
            if (platformBridge.isTauri) {
                latestStatus = await platformBridge.ocrModelWriteAsset(targetModel, matched.assetName, buf)
            } else {
                await webPutAsset(targetModel, matched.assetName, buf)
                latestStatus = await webComputeStatus()
            }
            imported.push(`${targetModel}/${matched.assetName}`)
        }

        if (!latestStatus) {
            latestStatus = await this.getStatus({ force: true })
        }
        this._cachedStatus = latestStatus
        this._cachedAt = Date.now()
        this._notifyChange(latestStatus)
        return { imported, status: latestStatus }
    }

    async loadModelAssets(modelId) {
        const readFn = async (targetModel, assetName) => {
            if (platformBridge.isTauri) {
                return await platformBridge.ocrModelReadAsset(targetModel, assetName)
            }
            return await webGetAsset(targetModel, assetName)
        }

        const [detBuffer, recBuffer, recYmlBuffer, wasmBuffer] = await Promise.all([
            readFn(modelId, 'det.onnx'),
            readFn(modelId, 'rec.onnx'),
            readFn(modelId, 'rec.yml'),
            readFn('runtime', RUNTIME_WASM_FILENAME)
        ])

        if (!detBuffer || !recBuffer || !recYmlBuffer || !wasmBuffer) {
            throw new Error(`OCR model assets incomplete for '${modelId}'`)
        }
        const dictText = new TextDecoder('utf-8').decode(new Uint8Array(recYmlBuffer))
        return {
            detBuffer,
            recBuffer,
            dictText,
            wasmBuffer
        }
    }
}

export const ocrModelManager = new OcrModelManager()
