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
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.zip.ZipInputStream
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object LindenNativeBridge {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS_PREFIX = "ll_sec_"
    private const val GCM_TAG_LENGTH = 128
    private val ALLOWED_BOOK_EXTENSIONS = setOf(
        "epub", "pdf", "docx", "txt", "md", "mobi", "azw", "azw3", "fb2", "cbz"
    )
    private val ALLOWED_MIME_TO_EXT = mapOf(
        "application/epub+zip" to "epub",
        "application/pdf" to "pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "docx",
        "text/plain" to "txt",
        "text/markdown" to "md",
        "application/x-mobipocket-ebook" to "mobi",
        "application/vnd.amazon.ebook" to "azw",
        "application/vnd.amazon.mobi8-ebook" to "azw3",
        "application/x-fictionbook+xml" to "fb2",
        "application/vnd.comicbook+zip" to "cbz",
        "application/x-cbz" to "cbz"
    )

    private fun sniffZipBookExtension(file: File): String? {
        return try {
            var hasContainer = false
            var hasContentTypes = false
            var hasWordDir = false
            var hasOtherOffice = false
            var hasImage = false
            ZipInputStream(BufferedInputStream(FileInputStream(file))).use { zis ->
                var entriesScanned = 0
                while (entriesScanned < 256) {
                    val entry = zis.nextEntry ?: break
                    entriesScanned++
                    val name = entry.name.trimStart('/').lowercase(Locale.ROOT)
                    if (name == "androidmanifest.xml" || name == "classes.dex" || name == "meta-inf/manifest.mf") {
                        return null
                    }
                    if (name == "mimetype") {
                        val buf = ByteArray(128)
                        val read = zis.read(buf)
                        if (read > 0 && String(buf, 0, read, Charsets.UTF_8).trim() == "application/epub+zip") {
                            return "epub"
                        }
                    } else if (name == "meta-inf/container.xml") {
                        hasContainer = true
                    } else if (name == "[content_types].xml") {
                        hasContentTypes = true
                    } else if (name.startsWith("word/")) {
                        hasWordDir = true
                    } else if (name.startsWith("xl/") || name.startsWith("ppt/")) {
                        hasOtherOffice = true
                    } else if (!entry.isDirectory && (
                        name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") ||
                        name.endsWith(".webp") || name.endsWith(".gif") || name.endsWith(".bmp")
                    )) {
                        hasImage = true
                    }
                    zis.closeEntry()
                }
            }
            when {
                hasContainer -> "epub"
                hasWordDir && hasContentTypes -> "docx"
                hasOtherOffice -> null
                hasImage -> "cbz"
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun sniffExtensionFromMagic(header: ByteArray, length: Int, mimeType: String?, stagedFile: File? = null): String? {
        val normMime = mimeType?.substringBefore(';')?.trim()?.lowercase()
        if (normMime != null && ALLOWED_MIME_TO_EXT.containsKey(normMime)) {
            return ALLOWED_MIME_TO_EXT[normMime]
        }
        if (length >= 5 &&
            header[0] == 0x25.toByte() && header[1] == 0x50.toByte() &&
            header[2] == 0x44.toByte() && header[3] == 0x46.toByte() && header[4] == 0x2D.toByte()
        ) {
            return "pdf"
        }
        if (length >= 68) {
            val mobiTag = String(header, 60, 8, Charsets.ISO_8859_1)
            if (mobiTag == "BOOKMOBI" || mobiTag == "TEXtREAd") {
                return "mobi"
            }
        }
        if (length >= 4 &&
            header[0] == 0x50.toByte() && header[1] == 0x4B.toByte() &&
            (header[2] == 0x03.toByte() || header[2] == 0x05.toByte() || header[2] == 0x07.toByte()) &&
            (header[3] == 0x04.toByte() || header[3] == 0x06.toByte() || header[3] == 0x08.toByte())
        ) {
            if (stagedFile != null) {
                return sniffZipBookExtension(stagedFile)
            }
            val ascii = String(header, 0, minOf(length, 512), Charsets.ISO_8859_1)
            return when {
                ascii.contains("application/epub+zip") -> "epub"
                ascii.contains("word/") -> "docx"
                else -> null
            }
        }
        if (length > 0) {
            val sampleLen = minOf(length, 512)
            val hasUtf16Bom = sampleLen >= 2 && (
                (header[0] == 0xFF.toByte() && header[1] == 0xFE.toByte()) ||
                (header[0] == 0xFE.toByte() && header[1] == 0xFF.toByte())
            )
            if (hasUtf16Bom) return "txt"
            var nulBytes = 0
            for (i in 0 until sampleLen) {
                if (header[i] == 0.toByte()) nulBytes++
            }
            if (nulBytes == 0) {
                val headStr = String(header, 0, sampleLen, Charsets.UTF_8)
                if (headStr.contains("<FictionBook", ignoreCase = true)) return "fb2"
                return "txt"
            }
        }
        return null
    }

    @JvmStatic
    fun isEnglishLocale(localeArg: String? = null): Boolean {
        val candidate = localeArg?.trim()?.takeIf { it.isNotEmpty() }
            ?: Locale.getDefault().language
        return candidate.startsWith("en", ignoreCase = true)
    }

    @JvmStatic
    fun l10n(en: Boolean, zh: String, enText: String): String = if (en) enText else zh

    @JvmStatic
    fun resolveContentUri(context: Context, uriString: String): String {
        val result = JSONObject()
        var stagingFile: File? = null
        try {
            val uri = Uri.parse(uriString)
            val contentResolver: ContentResolver = context.contentResolver

            // Guard against file:// URIs or symlinks pointing inside the app private sandbox (dataDir / filesDir)
            if (uri.scheme == null || uri.scheme.equals("file", ignoreCase = true)) {
                val rawPath = uri.path ?: uriString.removePrefix("file://")
                val targetCanon = File(rawPath).canonicalPath
                val dataCanon = File(context.applicationInfo.dataDir).canonicalPath
                val filesCanon = context.filesDir.canonicalPath
                val booksCanon = File(context.filesDir, "books").canonicalPath
                if ((targetCanon.startsWith("$dataCanon/") || targetCanon == dataCanon ||
                     targetCanon.startsWith("$filesCanon/") || targetCanon == filesCanon) &&
                    !targetCanon.startsWith("$booksCanon/")
                ) {
                    val en = isEnglishLocale()
                    throw SecurityException(
                        l10n(
                            en,
                            "拒绝从应用私有沙盒目录导入内部文件",
                            "Refusing to import internal file from app private sandbox"
                        )
                    )
                }
            }

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

            // Clean filename to prevent path traversal and verify book extension allowlist
            val cleaned = (resolvedName ?: "imported_book").replace(Regex("[/\\\\:*?\"<>|]"), "_").trim()
            var filename: String = if (cleaned.isEmpty()) "imported_book" else cleaned
            val hasDot = filename.contains('.')
            val ext = if (hasDot) filename.substringAfterLast('.', "").lowercase() else ""
            if (ext.isNotEmpty() && !ALLOWED_BOOK_EXTENSIONS.contains(ext)) {
                val en = isEnglishLocale()
                throw SecurityException(
                    l10n(en, "不支持的图书文件扩展名: .$ext", "Unsupported ebook file extension: .$ext")
                )
            }

            // 2. Prepare staging directory (files/staging/)
            val stagingDir = File(context.filesDir, "staging")
            if (!stagingDir.exists()) stagingDir.mkdirs()

            val uniqueStagingName = "staging_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.tmp"
            stagingFile = File(stagingDir, uniqueStagingName)

            // 3. Stream data to staging while computing digest and sniffing magic header for extensionless files
            val md = MessageDigest.getInstance("SHA-256")
            var totalBytes = 0L
            val headerSample = ByteArray(1024)
            var headerLen = 0

            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(stagingFile).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        if (headerLen < headerSample.size) {
                            val toCopy = minOf(read, headerSample.size - headerLen)
                            System.arraycopy(buffer, 0, headerSample, headerLen, toCopy)
                            headerLen += toCopy
                        }
                        output.write(buffer, 0, read)
                        md.update(buffer, 0, read)
                        totalBytes += read
                    }
                    output.flush()
                }
            } ?: throw IllegalStateException(
                l10n(isEnglishLocale(), "无法打开输入流读取: $uriString", "Cannot open input stream for: $uriString")
            )

            if (totalBytes <= 0L || !stagingFile.exists() || stagingFile.length() == 0L) {
                throw IllegalStateException(
                    l10n(isEnglishLocale(), "导入图书文件大小为0或读取失败", "Imported ebook file is empty or unreadable")
                )
            }

            if (ext.isEmpty()) {
                val mime = try { contentResolver.getType(uri) } catch (_: Exception) { null }
                val inferredExt = sniffExtensionFromMagic(headerSample, headerLen, mime, stagingFile)
                if (inferredExt == null || !ALLOWED_BOOK_EXTENSIONS.contains(inferredExt)) {
                    val en = isEnglishLocale()
                    throw SecurityException(
                        l10n(en, "无法识别的无扩展名图书文件类型", "Unrecognized extensionless ebook file format")
                    )
                }
                val baseName = filename.trimEnd('.').ifEmpty { "imported_book" }
                filename = "$baseName.$inferredExt"
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
