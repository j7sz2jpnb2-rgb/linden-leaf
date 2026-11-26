package com.lindenleaf.reader

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

class MainActivity : TauriActivity() {

    companion object {
        const val REQUEST_CODE_PICK_BOOKS = 1002
        const val REQUEST_CODE_EXPORT_TEXT = 1005
        var pendingPickCallback: ((List<Map<String, String>>?) -> Unit)? = null
        var instance: MainActivity? = null
        var lastInsetsTop = 0f
        var lastInsetsBottom = 0f
        var lastInsetsLeft = 0f
        var lastInsetsRight = 0f
        var lastInsetsIme = 0f
    }

    var currentWebView: WebView? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        instance = this
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // 1. Establish unified WindowInsets listener for system bars, camera cutouts, and IME keyboard
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val density = resources.displayMetrics.density.let { if (it.isFinite() && it > 0f) it else 1f }
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())

            // Per spec: system bars and cutout take max; IME is tracked separately to avoid double-padding
            val topCss = maxOf(0f, maxOf(systemBars.top, cutout.top) / density)
            val leftCss = maxOf(0f, maxOf(systemBars.left, cutout.left) / density)
            val rightCss = maxOf(0f, maxOf(systemBars.right, cutout.right) / density)
            val bottomBarCss = maxOf(0f, maxOf(systemBars.bottom, cutout.bottom) / density)
            val rawImeCss = maxOf(0f, ime.bottom / density)
            val imeCss = if (imeVisible || rawImeCss > 50f) rawImeCss else 0f

            lastInsetsTop = topCss
            lastInsetsBottom = bottomBarCss
            lastInsetsLeft = leftCss
            lastInsetsRight = rightCss
            lastInsetsIme = imeCss

            applyInsetsToWebView()

            insets
        }

        // 2. Intercept native Android back button navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val rootInsets = ViewCompat.getRootWindowInsets(window.decorView)
                val imeVisible = rootInsets?.isVisible(WindowInsetsCompat.Type.ime()) == true || lastInsetsIme > 50f
                if (imeVisible) {
                    val controller = ViewCompat.getWindowInsetsController(window.decorView)
                    if (controller != null) {
                        controller.hide(WindowInsetsCompat.Type.ime())
                    } else {
                        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                        imm?.hideSoftInputFromWindow((currentWebView ?: window.decorView).windowToken, 0)
                    }
                    return
                }
                val wv = currentWebView
                if (wv != null) {
                    wv.evaluateJavascript(
                        "(function(){ return window.__handleAndroidBackPress ? window.__handleAndroidBackPress() : false; })()"
                    ) { result ->
                        val consumed = (result == "true")
                        if (!consumed) {
                            // At shelf root with no overlay open -> moveTaskToBack instead of destroying
                            moveTaskToBack(true)
                        }
                    }
                } else {
                    moveTaskToBack(true)
                }
            }
        })

        handleIntent(intent)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        currentWebView = webView

        // Disable algorithmic force-dark to prevent WebView engine color inversion clashes
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
            } else if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
                WebSettingsCompat.setForceDark(webView.settings, WebSettingsCompat.FORCE_DARK_OFF)
            }
        } catch (e: Exception) {
            android.util.Log.w("MainActivity", "Failed configuring WebView dark mode settings", e)
        }

        // Apply cached insets immediately and request a fresh pass once the view attaches
        applyInsetsToWebView()
        window.decorView.post {
            ViewCompat.requestApplyInsets(window.decorView)
        }
    }

    private fun fmtCssPx(value: Float): String =
        if (value.isFinite() && value > 0f) String.format(Locale.US, "%.2fpx", value) else "0px"

    fun applyInsetsToWebView() {
        val wv = currentWebView ?: return
        val top = if (lastInsetsTop.isFinite() && lastInsetsTop > 0f) lastInsetsTop else 0f
        val bottom = if (lastInsetsBottom.isFinite() && lastInsetsBottom > 0f) lastInsetsBottom else 0f
        val left = if (lastInsetsLeft.isFinite() && lastInsetsLeft > 0f) lastInsetsLeft else 0f
        val right = if (lastInsetsRight.isFinite() && lastInsetsRight > 0f) lastInsetsRight else 0f
        val rawIme = if (lastInsetsIme.isFinite() && lastInsetsIme > 0f) lastInsetsIme else 0f
        val keyboardOpen = rawIme > 50f
        val ime = if (keyboardOpen) rawIme else 0f

        val topPx = fmtCssPx(top)
        val bottomPx = fmtCssPx(bottom)
        val leftPx = fmtCssPx(left)
        val rightPx = fmtCssPx(right)
        val imePx = fmtCssPx(ime)
        val windowBottomPx = fmtCssPx(maxOf(bottom, ime))

        val js = """
            (function() {
                var doc = document.documentElement;
                if (!doc) return;
                doc.style.setProperty('--safe-area-inset-top', '$topPx');
                doc.style.setProperty('--safe-area-inset-bottom', '$bottomPx');
                doc.style.setProperty('--safe-area-inset-left', '$leftPx');
                doc.style.setProperty('--safe-area-inset-right', '$rightPx');
                doc.style.setProperty('--safe-top', '$topPx');
                doc.style.setProperty('--safe-bottom', '$bottomPx');
                doc.style.setProperty('--safe-left', '$leftPx');
                doc.style.setProperty('--safe-right', '$rightPx');
                doc.style.setProperty('--ime-inset-bottom', '$imePx');
                doc.style.setProperty('--ime-bottom', '$imePx');
                doc.style.setProperty('--viewport-keyboard-offset', '$imePx');
                doc.style.setProperty('--window-inset-bottom', '$windowBottomPx');
                if ($keyboardOpen) {
                    doc.classList.add('keyboard-open');
                } else {
                    doc.classList.remove('keyboard-open');
                }
                window.dispatchEvent(new CustomEvent('safeareachanged', {
                    detail: {
                        top: $top,
                        bottom: $bottom,
                        left: $left,
                        right: $right,
                        ime: $ime,
                        keyboardOpen: $keyboardOpen
                    }
                }));
            })();
        """.trimIndent()
        wv.post {
            wv.evaluateJavascript(js, null)
        }
    }

    override fun onResume() {
        super.onResume()
        window.decorView.post {
            ViewCompat.requestApplyInsets(window.decorView)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        if (instance == this) {
            instance = null
        }
        if (isFinishing) {
            pendingPickCallback = null
        }
        pendingExportCallback?.invoke(JSONObject().put("success", false).put("cancelled", true))
        pendingExportCallback = null
        pendingTextExportCallback?.invoke(
            JSONObject().put("saved", false).put("uri", JSONObject.NULL).put("cancelled", true)
        )
        pendingTextExportCallback = null
        pendingTextExportContent = null
        bookIo.shutdown()
        currentWebView = null
        super.onDestroy()
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action

        val uri: Uri? = when (action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
            }
            else -> null
        }

        if (uri != null) {
            bookIo.execute {
                try {
                    val resolvedJson = LindenNativeBridge.resolveContentUri(this@MainActivity, uri.toString())
                    val obj = JSONObject(resolvedJson)
                    if (obj.optBoolean("success", false)) {
                        val path = obj.optString("snapshot_path", "")
                        val filename = obj.optString("filename", "imported_book")
                        if (path.isNotEmpty()) {
                            android.util.Log.i("MainActivity", "Successfully staged incoming book intent: $path")
                            enqueuePendingImport(path, filename)
                        }
                    }
                } catch (e: Exception) {
                    android.util.Log.e("MainActivity", "Failed staging incoming intent uri: $uri", e)
                }
            }
        }
    }

    private fun getPendingImportsFile(): File {
        return File(filesDir, "pending_imports.json")
    }

    @Synchronized
    fun enqueuePendingImport(filePath: String, filename: String) {
        try {
            val file = getPendingImportsFile()
            val array = if (file.exists()) {
                try { JSONArray(file.readText(Charsets.UTF_8)) } catch (_: Exception) { JSONArray() }
            } else {
                JSONArray()
            }

            // Check if already in queue
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i)
                if (item?.optString("filePath") == filePath) {
                    return
                }
            }

            val newItem = JSONObject().apply {
                put("id", "import_${System.currentTimeMillis()}_${(1000..9999).random()}")
                put("filePath", filePath)
                put("filename", filename)
                put("status", "ready")
                put("timestamp", System.currentTimeMillis())
            }
            array.put(newItem)
            file.writeText(array.toString(), Charsets.UTF_8)

            // Notify WebView if ready
            currentWebView?.post {
                currentWebView?.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('pendingimportready'));",
                    null
                )
            }
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed enqueueing pending import", e)
        }
    }

    @Synchronized
    fun getPendingImports(): List<Map<String, String>> {
        val list = mutableListOf<Map<String, String>>()
        try {
            val file = getPendingImportsFile()
            if (!file.exists()) return list
            val array = JSONArray(file.readText(Charsets.UTF_8))
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                list.add(
                    mapOf(
                        "id" to item.optString("id"),
                        "filePath" to item.optString("filePath"),
                        "filename" to item.optString("filename"),
                        "status" to item.optString("status", "ready")
                    )
                )
            }
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed reading pending imports", e)
        }
        return list
    }

    @Synchronized
    fun consumePendingImport(importId: String): Boolean {
        try {
            val file = getPendingImportsFile()
            if (!file.exists()) return false
            val array = JSONArray(file.readText(Charsets.UTF_8))
            val newArray = JSONArray()
            var found = false
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (item.optString("id") == importId || item.optString("filePath") == importId) {
                    found = true
                } else {
                    newArray.put(item)
                }
            }
            file.writeText(newArray.toString(), Charsets.UTF_8)
            return found
        } catch (e: Exception) {
            android.util.Log.e("MainActivity", "Failed consuming pending import", e)
            return false
        }
    }

    private val bookIo = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var pendingExportSource: File? = null
    private var pendingExportCallback: ((JSONObject) -> Unit)? = null
    private var pendingTextExportContent: String? = null
    private var pendingTextExportCallback: ((JSONObject) -> Unit)? = null

    fun requestListeningNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        runOnUiThread {
            if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) return@runOnUiThread
            val preferences = getSharedPreferences("listening-permissions", MODE_PRIVATE)
            if (!preferences.getBoolean("notification-asked", false)) {
                preferences.edit().putBoolean("notification-asked", true).apply()
                androidx.core.app.ActivityCompat.requestPermissions(this,
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1004)
            }
        }
    }

    fun exportBookFile(filePath: String, filename: String, share: Boolean, locale: String = "", callback: (JSONObject) -> Unit) {
        val en = LindenNativeBridge.isEnglishLocale(locale)
        val source = File(filePath)
        if (!source.isFile) {
            callback(JSONObject().put("success", false).put("error", LindenNativeBridge.l10n(en, "原始图书文件不存在", "Source ebook file does not exist")))
            return
        }
        val booksDirCanon = File(filesDir, "books").canonicalPath
        val nativePdfDirCanon = File(filesDir, "pdf-native").canonicalPath
        val legacySnapshotsDirCanon = File(filesDir, "pdf_snapshots").canonicalPath
        val sourceCanon = try { source.canonicalPath } catch (_: Exception) { "" }
        val inAllowedDir = sourceCanon.startsWith(booksDirCanon + File.separator) ||
            sourceCanon.startsWith(nativePdfDirCanon + File.separator) ||
            sourceCanon.startsWith(legacySnapshotsDirCanon + File.separator)
        if (!inAllowedDir) {
            callback(JSONObject().put("success", false).put("error", LindenNativeBridge.l10n(en, "安全限制：仅允许导出书库内的图书文件", "Security restriction: only library ebook files can be exported")))
            return
        }
        val name = filename.replace('\\', '/').substringAfterLast('/').replace(Regex("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5 ()\\[\\]]"), "_").ifBlank { "book.epub" }
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        if (share) {
            bookIo.execute {
                try {
                    val directory = File(cacheDir, "share").apply { mkdirs() }
                    val output = File(directory, System.currentTimeMillis().toString() + "-" + name)
                    source.inputStream().use { input -> output.outputStream().use { input.copyTo(it, 64 * 1024) } }
                    val uri = androidx.core.content.FileProvider.getUriForFile(this, packageName + ".fileprovider", output)
                    runOnUiThread {
                        try {
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = mime
                                putExtra(Intent.EXTRA_STREAM, uri)
                                clipData = android.content.ClipData.newUri(contentResolver, name, uri)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            startActivity(Intent.createChooser(intent, LindenNativeBridge.l10n(en, "分享图书", "Share Ebook")))
                            callback(JSONObject().put("success", true).put("opened", true))
                        } catch (e: Exception) { callback(JSONObject().put("success", false).put("error", e.message)) }
                    }
                } catch (e: Exception) { callback(JSONObject().put("success", false).put("error", e.message)) }
            }
        } else runOnUiThread {
            if (pendingExportCallback != null) {
                callback(JSONObject().put("success", false).put("error", LindenNativeBridge.l10n(en, "请先完成当前的文件保存", "Please finish the current file save first")))
                return@runOnUiThread
            }
            pendingExportSource = source
            pendingExportCallback = callback
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = mime; putExtra(Intent.EXTRA_TITLE, name)
                }, 1003)
            } catch (e: Exception) {
                pendingExportSource = null; pendingExportCallback = null
                callback(JSONObject().put("success", false).put("error", e.message))
            }
        }
    }

    fun exportTextFile(filename: String, content: String, mimeType: String, locale: String = "", callback: (JSONObject) -> Unit) {
        val safeName = filename
            .replace('\\', '/')
            .substringAfterLast('/')
            .replace(Regex("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5 ()\\[\\]]"), "_")
            .ifBlank { "export.txt" }
        val baseMime = mimeType.substringBefore(';').trim().ifBlank { "text/plain" }
        runOnUiThread {
            val en = LindenNativeBridge.isEnglishLocale(locale)
            if (pendingTextExportCallback != null) {
                callback(
                    JSONObject()
                        .put("saved", false)
                        .put("uri", JSONObject.NULL)
                        .put("cancelled", false)
                        .put("error", LindenNativeBridge.l10n(en, "请先完成当前的文件保存", "Please finish the current file save first"))
                )
                return@runOnUiThread
            }
            pendingTextExportContent = content
            pendingTextExportCallback = callback
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = baseMime
                    putExtra(Intent.EXTRA_TITLE, safeName)
                }, REQUEST_CODE_EXPORT_TEXT)
            } catch (e: Exception) {
                pendingTextExportContent = null
                pendingTextExportCallback = null
                callback(
                    JSONObject()
                        .put("saved", false)
                        .put("uri", JSONObject.NULL)
                        .put("cancelled", false)
                        .put("error", e.message ?: LindenNativeBridge.l10n(en, "无法打开文件保存对话框", "Unable to open save file dialog"))
                )
            }
        }
    }

    fun launchBookPicker(callback: (List<Map<String, String>>?) -> Unit) {
        pendingPickCallback = callback
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            val mimeTypes = arrayOf(
                "application/epub+zip",
                "application/pdf",
                "application/x-mobipocket-ebook",
                "application/vnd.amazon.ebook",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "text/plain",
                "text/markdown",
                "application/x-cbz",
                "application/octet-stream"
            )
            putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
        }
        try {
            startActivityForResult(intent, REQUEST_CODE_PICK_BOOKS)
        } catch (e: Exception) {
            pendingPickCallback = null
            callback(null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1003) {
            val callback = pendingExportCallback
            val source = pendingExportSource
            pendingExportCallback = null
            pendingExportSource = null
            val uri = data?.data
            if (resultCode != Activity.RESULT_OK || uri == null || source == null) {
                callback?.invoke(JSONObject().put("success", false).put("cancelled", true))
                return
            }
            bookIo.execute {
                val en = LindenNativeBridge.isEnglishLocale()
                try {
                    source.inputStream().use { input ->
                        val output = contentResolver.openOutputStream(uri, "wt")
                            ?: error(LindenNativeBridge.l10n(en, "无法写入所选位置", "Cannot write to the selected location"))
                        output.use { input.copyTo(it, 64 * 1024) }
                    }
                    callback?.invoke(JSONObject().put("success", true).put("path", uri.toString()))
                } catch (e: Exception) { callback?.invoke(JSONObject().put("success", false).put("error", e.message)) }
            }
        } else if (requestCode == REQUEST_CODE_EXPORT_TEXT) {
            val callback = pendingTextExportCallback
            val content = pendingTextExportContent
            pendingTextExportCallback = null
            pendingTextExportContent = null
            val uri = data?.data
            if (resultCode != Activity.RESULT_OK || uri == null || content == null) {
                callback?.invoke(
                    JSONObject()
                        .put("saved", false)
                        .put("uri", JSONObject.NULL)
                        .put("cancelled", true)
                )
                return
            }
            bookIo.execute {
                val en = LindenNativeBridge.isEnglishLocale()
                try {
                    val output = contentResolver.openOutputStream(uri, "wt")
                        ?: error(LindenNativeBridge.l10n(en, "无法写入所选位置", "Cannot write to the selected location"))
                    output.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                    callback?.invoke(
                        JSONObject()
                            .put("saved", true)
                            .put("uri", uri.toString())
                            .put("cancelled", false)
                    )
                } catch (e: Exception) {
                    callback?.invoke(
                        JSONObject()
                            .put("saved", false)
                            .put("uri", JSONObject.NULL)
                            .put("cancelled", false)
                            .put("error", e.message ?: LindenNativeBridge.l10n(en, "写入文件失败", "Failed to write file"))
                    )
                }
            }
        } else if (requestCode == REQUEST_CODE_PICK_BOOKS) {
            val callback = pendingPickCallback
            pendingPickCallback = null
            if (resultCode != Activity.RESULT_OK || data == null) { callback?.invoke(null); return }
            bookIo.execute {
                val results = mutableListOf<Map<String, String>>()
                try {
                    val uris = mutableListOf<Uri>()
                    val clip = data.clipData
                    if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
                    else data.data?.let { uris.add(it) }
                    for (uri in uris) {
                        try {
                            val result = JSONObject(LindenNativeBridge.resolveContentUri(this, uri.toString()))
                            if (result.optBoolean("success")) {
                                val path = result.optString("snapshot_path")
                                if (path.isNotEmpty()) results.add(mapOf("filePath" to path, "filename" to result.optString("filename")))
                            }
                        } catch (e: Exception) { android.util.Log.w("LindenImport", "Cannot import selected document", e) }
                    }
                } finally {
                    runOnUiThread { callback?.invoke(if (results.isEmpty()) null else results) }
                }
            }
        }
    }
}
