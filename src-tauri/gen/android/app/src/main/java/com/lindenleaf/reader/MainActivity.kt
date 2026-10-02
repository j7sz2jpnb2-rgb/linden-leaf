package com.lindenleaf.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
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

class MainActivity : TauriActivity() {

    companion object {
        const val REQUEST_CODE_PICK_BOOKS = 1002
        var pendingPickCallback: ((List<Map<String, String>>?) -> Unit)? = null
        var instance: MainActivity? = null
    }

    var currentWebView: WebView? = null
        private set

    private var lastInsetsTop = 0f
    private var lastInsetsBottom = 0f
    private var lastInsetsLeft = 0f
    private var lastInsetsRight = 0f
    private var lastInsetsIme = 0f

    override fun onCreate(savedInstanceState: Bundle?) {
        instance = this
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // 1. Establish unified WindowInsets listener for system bars, camera cutouts, and IME keyboard
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val density = resources.displayMetrics.density
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())

            // Per spec: union of obstruction rectangle, system bars and cutout take max, not sum
            val topCss = maxOf(systemBars.top, cutout.top) / density
            val leftCss = maxOf(systemBars.left, cutout.left) / density
            val rightCss = maxOf(systemBars.right, cutout.right) / density
            val bottomBarCss = maxOf(systemBars.bottom, cutout.bottom) / density
            val imeCss = ime.bottom / density
            val bottomCss = maxOf(bottomBarCss, imeCss)

            lastInsetsTop = topCss
            lastInsetsBottom = bottomCss
            lastInsetsLeft = leftCss
            lastInsetsRight = rightCss
            lastInsetsIme = imeCss

            applyInsetsToWebView()

            insets
        }

        // 2. Intercept native Android back button navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
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

        // Apply insets as soon as webView is initialized
        applyInsetsToWebView()
    }

    private fun applyInsetsToWebView() {
        val wv = currentWebView ?: return
        val js = """
            (function() {
                var doc = document.documentElement;
                if (!doc) return;
                doc.style.setProperty('--safe-area-inset-top', '${lastInsetsTop}px');
                doc.style.setProperty('--safe-area-inset-bottom', '${lastInsetsBottom}px');
                doc.style.setProperty('--safe-area-inset-left', '${lastInsetsLeft}px');
                doc.style.setProperty('--safe-area-inset-right', '${lastInsetsRight}px');
                doc.style.setProperty('--safe-top', '${lastInsetsTop}px');
                doc.style.setProperty('--safe-bottom', '${lastInsetsBottom}px');
                doc.style.setProperty('--safe-left', '${lastInsetsLeft}px');
                doc.style.setProperty('--safe-right', '${lastInsetsRight}px');
                doc.style.setProperty('--ime-inset-bottom', '${lastInsetsIme}px');
                doc.style.setProperty('--ime-bottom', '${lastInsetsIme}px');
                window.dispatchEvent(new CustomEvent('safeareachanged', {
                    detail: {
                        top: $lastInsetsTop,
                        bottom: $lastInsetsBottom,
                        left: $lastInsetsLeft,
                        right: $lastInsetsRight,
                        ime: $lastInsetsIme
                    }
                }));
            })();
        """.trimIndent()
        wv.post {
            wv.evaluateJavascript(js, null)
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
        pendingPickCallback = null
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
            Thread {
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
            }.start()
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
        if (requestCode == REQUEST_CODE_PICK_BOOKS) {
            val cb = pendingPickCallback
            pendingPickCallback = null

            if (resultCode != Activity.RESULT_OK || data == null) {
                cb?.invoke(null)
                return
            }

            Thread {
                val results = mutableListOf<Map<String, String>>()
                val clipData = data.clipData
                if (clipData != null) {
                    for (i in 0 until clipData.itemCount) {
                        val uri = clipData.getItemAt(i).uri
                        val resJson = LindenNativeBridge.resolveContentUri(this@MainActivity, uri.toString())
                        val obj = JSONObject(resJson)
                        if (obj.optBoolean("success", false)) {
                            val path = obj.optString("snapshot_path", "")
                            val name = obj.optString("filename", "")
                            if (path.isNotEmpty()) {
                                results.add(mapOf("filePath" to path, "filename" to name))
                            }
                        }
                    }
                } else if (data.data != null) {
                    val uri = data.data!!
                    val resJson = LindenNativeBridge.resolveContentUri(this@MainActivity, uri.toString())
                    val obj = JSONObject(resJson)
                    if (obj.optBoolean("success", false)) {
                        val path = obj.optString("snapshot_path", "")
                        val name = obj.optString("filename", "")
                        if (path.isNotEmpty()) {
                            results.add(mapOf("filePath" to path, "filename" to name))
                        }
                    }
                }

                runOnUiThread {
                    cb?.invoke(if (results.isEmpty()) null else results)
                }
            }.start()
        }
    }
}
