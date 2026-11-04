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
            val rawFilename = args.optString("filename", "linden_report_${System.currentTimeMillis()}.png")
            val filename = File(rawFilename).name.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifBlank { "linden_report_${System.currentTimeMillis()}.png" }

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
            val rawFilename = args.optString("filename", "linden_share.png")
            val filename = File(rawFilename).name.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifBlank { "linden_share.png" }
            val title = args.optString("title", "分享图片")

            val cleanBase64 = if (base64Data.contains(",")) base64Data.substringAfter(",") else base64Data
            val bytes = Base64.decode(cleanBase64, Base64.DEFAULT)

            val shareDir = File(activity.cacheDir, "share")
            if (!shareDir.exists()) shareDir.mkdirs()
            val shareFile = File(shareDir, filename)
            if (!shareFile.canonicalPath.startsWith(shareDir.canonicalPath + File.separator)) {
                throw SecurityException("Invalid share filename")
            }
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

            (activity as? MainActivity)?.requestListeningNotificationPermission()
            LindenMediaPlaybackService.startSpeaking(activity, bookTitle, text, rate, jobId, utteranceId, generation, args.optString("bookId", ""))
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun startBackgroundTtsQueue(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            val bookTitle = args.optString("bookTitle", "Linden Leaf 朗读")
            val segmentsArray = args.getJSONArray("segments")
            val startIndex = args.optInt("startIndex", 0)
            val rate = args.optDouble("rate", 1.0).toFloat()
            val jobId = args.optString("jobId", "")
            val generation = args.optLong("generation", 0L)

            val texts = ArrayList<String>()
            val utterances = ArrayList<String>()
            for (i in 0 until segmentsArray.length()) {
                val seg = segmentsArray.optJSONObject(i)
                if (seg != null) {
                    texts.add(seg.optString("text", ""))
                    utterances.add(seg.optString("utteranceId", "utt_$i"))
                } else {
                    texts.add(segmentsArray.optString(i, ""))
                    utterances.add("utt_$i")
                }
            }

            (activity as? MainActivity)?.requestListeningNotificationPermission()
            LindenMediaPlaybackService.startSpeakingQueue(activity, bookTitle, texts, utterances, startIndex, rate, jobId, generation, args.optString("bookId", ""))
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    @Command
    fun pauseBackgroundTts(invoke: Invoke) {
        val res = JSObject()
        res.put("value", LindenMediaPlaybackService.pause(activity, invoke.getArgs().optString("jobId", "")))
        invoke.resolve(res)
    }

    @Command
    fun resumeBackgroundTts(invoke: Invoke) {
        val res = JSObject()
        res.put("value", LindenMediaPlaybackService.resume(activity, invoke.getArgs().optString("jobId", "")))
        invoke.resolve(res)
    }

    @Command
    fun stopBackgroundTts(invoke: Invoke) {
        val res = JSObject()
        res.put("value", LindenMediaPlaybackService.stop(activity, invoke.getArgs().optString("jobId", "")))
        invoke.resolve(res)
    }

    @Command
    fun setTtsSleepTimer(invoke: Invoke) {
        LindenMediaPlaybackService.setSleepTimer(invoke.getArgs().optInt("minutes", 0))
        invoke.resolve(JSObject().put("value", true) as JSObject)
    }

    @Command
    fun setTtsRate(invoke: Invoke) {
        LindenMediaPlaybackService.setRate(invoke.getArgs().optDouble("rate", 1.0).toFloat())
        invoke.resolve(JSObject().put("value", true) as JSObject)
    }

    @Command
    fun nextBackgroundTts(invoke: Invoke) {
        val res = JSObject()
        res.put("value", LindenMediaPlaybackService.next(activity))
        invoke.resolve(res)
    }

    @Command
    fun prevBackgroundTts(invoke: Invoke) {
        val res = JSObject()
        res.put("value", LindenMediaPlaybackService.previous(activity))
        invoke.resolve(res)
    }

    @Command
    fun acknowledgeTtsListening(invoke: Invoke) {
        try {
            LindenMediaPlaybackService.acknowledgeListening(activity, invoke.getArgs().getLong("throughSequence"))
            val res = JSObject()
            res.put("value", true)
            invoke.resolve(res)
        } catch (e: Exception) { invoke.reject(e.message ?: "听书记录确认失败") }
    }

    @Command
    fun exportBookFile(invoke: Invoke) {
        val main = activity as? MainActivity
        if (main == null) { invoke.reject("文件导出暂不可用"); return }
        val args = invoke.getArgs()
        main.exportBookFile(args.getString("filePath"), args.optString("filename", "book.epub"),
            args.optBoolean("share", false)) { result -> invoke.resolve(JSObject(result.toString())) }
    }

    @Command
    fun getSystemInsets(invoke: Invoke) {
        try {
            val insets = JSObject()
            insets.put("top", MainActivity.lastInsetsTop.toDouble())
            insets.put("bottom", MainActivity.lastInsetsBottom.toDouble())
            insets.put("left", MainActivity.lastInsetsLeft.toDouble())
            insets.put("right", MainActivity.lastInsetsRight.toDouble())
            insets.put("ime", MainActivity.lastInsetsIme.toDouble())
            insets.put("keyboardOpen", MainActivity.lastInsetsIme > 50)
            invoke.resolve(insets)
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
            res.put("queueIndex", LindenMediaPlaybackService.currentQueueIndex)
            res.put("queueTotal", LindenMediaPlaybackService.queueTotalCount)
            res.put("listeningIntervals", LindenMediaPlaybackService.listeningIntervals(activity))
            res.put("sleepTimerDeadlineMs", LindenMediaPlaybackService.sleepTimerDeadlineRealtimeMs)
            invoke.resolve(res)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }
}
