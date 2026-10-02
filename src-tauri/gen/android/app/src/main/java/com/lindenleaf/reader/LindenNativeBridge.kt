package com.lindenleaf.reader

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object LindenNativeBridge {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS_PREFIX = "ll_sec_"
    private const val GCM_TAG_LENGTH = 128

    @JvmStatic
    fun resolveContentUri(context: Context, uriString: String): String {
        val result = JSONObject()
        var stagingFile: File? = null
        try {
            val uri = Uri.parse(uriString)
            val contentResolver: ContentResolver = context.contentResolver

            // 1. Resolve display filename
            var resolvedName: String? = null
            if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
                try {
                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIndex != -1) {
                                resolvedName = cursor.getString(nameIndex)
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
            if (resolvedName.isNullOrBlank()) {
                resolvedName = uri.lastPathSegment?.substringAfterLast('/') ?: "imported_book"
            }

            // Clean filename to prevent path traversal
            val cleaned = (resolvedName ?: "imported_book").replace(Regex("[/\\\\:*?\"<>|]"), "_").trim()
            val filename: String = if (cleaned.isEmpty()) "imported_book" else cleaned

            // 2. Prepare staging directory (files/staging/)
            val stagingDir = File(context.filesDir, "staging")
            if (!stagingDir.exists()) stagingDir.mkdirs()

            val uniqueStagingName = "staging_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.tmp"
            stagingFile = File(stagingDir, uniqueStagingName)

            // 3. Stream data to staging while computing digest to prevent memory exhaustion
            val md = MessageDigest.getInstance("SHA-256")
            var totalBytes = 0L

            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(stagingFile).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        md.update(buffer, 0, read)
                        totalBytes += read
                    }
                    output.flush()
                }
            } ?: throw IllegalStateException("无法打开输入流读取: $uriString")

            if (totalBytes <= 0L || !stagingFile.exists() || stagingFile.length() == 0L) {
                throw IllegalStateException("导入图书文件大小为0或读取失败")
            }

            val hexHash = md.digest().joinToString("") { "%02x".format(it) }

            // 4. Determine final destination path without overwriting different content
            val booksDir = File(context.filesDir, "books")
            if (!booksDir.exists()) booksDir.mkdirs()

            var destFile = File(booksDir, filename)
            if (destFile.exists()) {
                // If destination exists, check if it's the exact same content
                if (destFile.length() == totalBytes) {
                    val destMd = MessageDigest.getInstance("SHA-256")
                    destFile.inputStream().use { inp ->
                        val buf = ByteArray(64 * 1024)
                        var r: Int
                        while (inp.read(buf).also { r = it } != -1) {
                            destMd.update(buf, 0, r)
                        }
                    }
                    val destHash = destMd.digest().joinToString("") { "%02x".format(it) }
                    if (destHash == hexHash) {
                        // Identical content already saved, reuse cleanly
                        stagingFile.delete()
                        stagingFile = null
                        result.put("success", true)
                        result.put("snapshot_path", destFile.absolutePath)
                        result.put("cache_path", destFile.absolutePath)
                        result.put("filename", filename)
                        result.put("error", JSONObject.NULL)
                        return result.toString()
                    }
                }

                // Different content with the same name: generate unique versioned name
                val namePart = if (filename.contains('.')) filename.substringBeforeLast('.') else filename
                val extPart = if (filename.contains('.')) "." + filename.substringAfterLast('.') else ""
                val uniqueName = "${namePart}_${hexHash.take(8)}${extPart}"
                destFile = File(booksDir, uniqueName)
            }

            // 5. Atomically activate staging file to destination
            if (!stagingFile.renameTo(destFile)) {
                stagingFile.copyTo(destFile, overwrite = true)
                stagingFile.delete()
            }
            stagingFile = null

            val absPath = destFile.absolutePath
            result.put("success", true)
            result.put("snapshot_path", absPath)
            result.put("cache_path", absPath)
            result.put("filename", filename)
            result.put("error", JSONObject.NULL)
        } catch (e: Exception) {
            stagingFile?.delete()
            result.put("success", false)
            result.put("snapshot_path", JSONObject.NULL)
            result.put("cache_path", JSONObject.NULL)
            result.put("filename", JSONObject.NULL)
            result.put("error", e.message ?: e.toString())
        }
        return result.toString()
    }

    @JvmStatic
    fun takePersistableUriPermission(context: Context, uriString: String): Boolean {
        return try {
            val uri = Uri.parse(uriString)
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun sanitizeKey(key: String): String {
        val sanitized = key.replace(Regex("[^a-zA-Z0-9_-]"), "_")
        if (sanitized.isBlank()) throw IllegalArgumentException("Credential key cannot be empty or invalid")
        return sanitized
    }

    private fun getOrCreateSecretKey(alias: String): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val fullAlias = KEY_ALIAS_PREFIX + alias
        if (keyStore.containsAlias(fullAlias)) {
            val entry = keyStore.getEntry(fullAlias, null) as? KeyStore.SecretKeyEntry
            if (entry != null) {
                return entry.secretKey
            }
        }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            fullAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        keyGen.init(spec)
        return keyGen.generateKey()
    }

    @JvmStatic
    fun keystoreStore(context: Context, key: String, secret: String): Boolean {
        return try {
            val safeKey = sanitizeKey(key)
            val secretKey = getOrCreateSecretKey(safeKey)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val cipherBytes = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))

            val keystoreDir = File(context.filesDir, "keystore")
            if (!keystoreDir.exists()) keystoreDir.mkdirs()

            val payload = JSONObject().apply {
                put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
                put("data", Base64.encodeToString(cipherBytes, Base64.NO_WRAP))
            }

            val encFile = File(keystoreDir, "$safeKey.enc")
            val tmpFile = File(keystoreDir, "$safeKey.enc.tmp")
            tmpFile.writeText(payload.toString(), Charsets.UTF_8)
            if (!tmpFile.renameTo(encFile)) {
                encFile.delete()
                if (!tmpFile.renameTo(encFile)) {
                    tmpFile.delete()
                    return false
                }
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    @JvmStatic
    fun keystoreLoad(context: Context, key: String): String? {
        val safeKey = sanitizeKey(key)
        val keystoreDir = File(context.filesDir, "keystore")
        val encFile = File(keystoreDir, "$safeKey.enc")
        if (!encFile.exists()) return null

        return try {
            val json = JSONObject(encFile.readText(Charsets.UTF_8))
            val iv = Base64.decode(json.getString("iv"), Base64.NO_WRAP)
            val cipherBytes = Base64.decode(json.getString("data"), Base64.NO_WRAP)

            val secretKey = getOrCreateSecretKey(safeKey)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, spec)
            val plainBytes = cipher.doFinal(cipherBytes)
            String(plainBytes, Charsets.UTF_8)
        } catch (e: Exception) {
            // Distinguish corrupted from unconfigured
            throw IllegalStateException("Keystore credential corrupted or invalidated for $key: ${e.message}")
        }
    }

    @JvmStatic
    fun keystoreDelete(context: Context, key: String): Boolean {
        return try {
            val safeKey = sanitizeKey(key)
            val keystoreDir = File(context.filesDir, "keystore")
            val encFile = File(keystoreDir, "$safeKey.enc")
            if (encFile.exists()) encFile.delete() else true
        } catch (_: Exception) {
            false
        }
    }
}
