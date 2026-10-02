package com.lindenleaf.reader

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

@TauriPlugin
class LindenPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun resolveContentUri(invoke: Invoke) {
        try {
            val uri = invoke.getArgs().getString("uri")
            val jsonString = LindenNativeBridge.resolveContentUri(activity, uri)
            invoke.resolve(JSObject(jsonString))
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun takePersistableUriPermission(invoke: Invoke) {
        try {
            val uri = invoke.getArgs().getString("uri")
            val result = LindenNativeBridge.takePersistableUriPermission(activity, uri)
            val res = JSObject()
            res.put("value", result)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun keystoreStore(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val key = args.getString("key")
            val secret = args.getString("secret")
            val result = LindenNativeBridge.keystoreStore(activity, key, secret)
            val res = JSObject()
            res.put("value", result)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun keystoreLoad(invoke: Invoke) {
        try {
            val key = invoke.getArgs().getString("key")
            val secret = LindenNativeBridge.keystoreLoad(activity, key)
            val res = JSObject()
            if (secret != null) {
                res.put("value", secret)
            } else {
                res.put("value", JSONObject.NULL)
            }
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun keystoreDelete(invoke: Invoke) {
        try {
            val key = invoke.getArgs().getString("key")
            val result = LindenNativeBridge.keystoreDelete(activity, key)
            val res = JSObject()
            res.put("value", result)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun pickBooks(invoke: Invoke) {
        val mainActivity = activity as? MainActivity
        if (mainActivity == null) {
            invoke.reject("MainActivity not available")
            return
        }
        mainActivity.launchBookPicker { items ->
            if (items == null || items.isEmpty()) {
                val res = JSObject()
                res.put("items", JSONArray())
                invoke.resolve(res)
            } else {
                val res = JSObject()
                val array = JSONArray()
                for (item in items) {
                    val obj = JSONObject()
                    obj.put("filePath", item["filePath"])
                    obj.put("filename", item["filename"])
                    array.put(obj)
                }
                res.put("items", array)
                invoke.resolve(res)
            }
        }
    }

    @Command
    fun getPendingImports(invoke: Invoke) {
        try {
            val mainActivity = activity as? MainActivity
            val items = mainActivity?.getPendingImports() ?: emptyList()
            val res = JSObject()
            val array = JSONArray()
            for (item in items) {
                val obj = JSONObject()
                obj.put("id", item["id"])
                obj.put("filePath", item["filePath"])
                obj.put("filename", item["filename"])
                obj.put("status", item["status"])
                array.put(obj)
            }
            res.put("items", array)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun consumePendingImport(invoke: Invoke) {
        try {
            val importId = invoke.getArgs().getString("importId")
            val mainActivity = activity as? MainActivity
            val ok = mainActivity?.consumePendingImport(importId) ?: false
            val res = JSObject()
            res.put("value", ok)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun saveImageToGallery(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val base64Data = args.getString("base64")
            val filename = args.optString("filename", "linden_report_${System.currentTimeMillis()}.png")

            val cleanBase64 = if (base64Data.contains(",")) base64Data.substringAfter(",") else base64Data
            val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                ?: throw IllegalArgumentException("无法解码图片数据")

            var savedUri: Uri? = null
            var outPath = ""

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, filename)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/LindenLeaf")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }

                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("创建系统相册条目失败")

                resolver.openOutputStream(uri)?.use { out ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    out.flush()
                }

                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                savedUri = uri
                outPath = uri.toString()
            } else {
                val picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
                val targetDir = File(picturesDir, "LindenLeaf")
                if (!targetDir.exists()) targetDir.mkdirs()
                val targetFile = File(targetDir, filename)
                FileOutputStream(targetFile).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    out.flush()
                }
                outPath = targetFile.absolutePath
            }

            val res = JSObject()
            res.put("success", true)
            res.put("path", outPath)
            invoke.resolve(res)
        } catch (e: Exception) {
            val res = JSObject()
            res.put("success", false)
            res.put("error", e.message ?: e.toString())
            invoke.resolve(res)
        }
    }

    @Command
    fun shareImage(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val base64Data = args.getString("base64")
            val filename = args.optString("filename", "linden_share.png")
            val title = args.optString("title", "分享图片")

            val cleanBase64 = if (base64Data.contains(",")) base64Data.substringAfter(",") else base64Data
            val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)

            val shareDir = File(activity.cacheDir, "share")
            if (!shareDir.exists()) shareDir.mkdirs()
            val shareFile = File(shareDir, filename)
            FileOutputStream(shareFile).use { out ->
                out.write(bytes)
                out.flush()
            }

            val authority = "${activity.packageName}.fileprovider"
            val contentUri = FileProvider.getUriForFile(activity, authority, shareFile)

            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, contentUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            activity.runOnUiThread {
                activity.startActivity(Intent.createChooser(shareIntent, title))
            }

            val res = JSObject()
            res.put("success", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            val res = JSObject()
            res.put("success", false)
            res.put("error", e.message ?: e.toString())
            invoke.resolve(res)
        }
    }

    @Command
    fun startBackgroundTts(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val bookTitle = args.optString("bookTitle", "Linden Leaf 朗读")
            val text = args.getString("text")
            val rate = args.optDouble("rate", 1.0).toFloat()
            val jobId = args.optString("jobId", "")
            val utteranceId = args.optString("utteranceId", "")
            val generation = args.optLong("generation", 0L)

            LindenMediaPlaybackService.startSpeaking(activity, bookTitle, text, rate, jobId, utteranceId, generation)
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun pauseBackgroundTts(invoke: Invoke) {
        try {
            LindenMediaPlaybackService.pause(activity)
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun resumeBackgroundTts(invoke: Invoke) {
        try {
            LindenMediaPlaybackService.resume(activity)
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun stopBackgroundTts(invoke: Invoke) {
        try {
            LindenMediaPlaybackService.stop(activity)
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun getPlaybackState(invoke: Invoke) {
        try {
            val res = JSObject()
            res.put("isPlaying", LindenMediaPlaybackService.isPlaying)
            res.put("state", LindenMediaPlaybackService.playbackState)
            res.put("bookTitle", LindenMediaPlaybackService.currentBookTitle)
            res.put("text", LindenMediaPlaybackService.currentText)
            res.put("jobId", LindenMediaPlaybackService.currentJobId)
            res.put("utteranceId", LindenMediaPlaybackService.currentUtteranceId)
            res.put("generation", LindenMediaPlaybackService.currentGeneration)
            res.put("completedUtteranceId", LindenMediaPlaybackService.completedUtteranceId)
            res.put("completedGeneration", LindenMediaPlaybackService.completedGeneration)
            res.put("rate", LindenMediaPlaybackService.currentRate.toDouble())
            res.put("eventSeq", LindenMediaPlaybackService.eventSeq)
            res.put("error", LindenMediaPlaybackService.lastError)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }
}
