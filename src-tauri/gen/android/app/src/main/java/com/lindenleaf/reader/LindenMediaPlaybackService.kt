package com.lindenleaf.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.AtomicFile
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class LindenMediaPlaybackService : Service() {
    private enum class TtsInitState {
        UNINITIALIZED,
        INITIALIZING,
        READY,
        FAILED
    }

    private data class QueueData(
        val bookId: String,
        val title: String,
        val bookAuthor: String = "",
        val texts: ArrayList<String>,
        val utterances: ArrayList<String>,
        val index: Int,
        val rate: Float,
        val jobId: String,
        val generation: Long,
        val voiceId: String = "",
        val locale: String = "zh-CN",
        var startPaused: Boolean = false
    )

    companion object {
        const val CHANNEL_ID = "ll_media_playback"
        const val NOTIFICATION_ID = 1001
        const val ACTION_PLAY_QUEUE = "com.lindenleaf.reader.ACTION_PLAY_QUEUE"
        const val ACTION_PAUSE = "com.lindenleaf.reader.ACTION_PAUSE"
        const val ACTION_RESUME = "com.lindenleaf.reader.ACTION_RESUME"
        const val ACTION_STOP = "com.lindenleaf.reader.ACTION_STOP"
        const val ACTION_NEXT = "com.lindenleaf.reader.ACTION_NEXT"
        const val ACTION_PREV = "com.lindenleaf.reader.ACTION_PREV"
        const val EXTRA_JOB_ID = "extra_job_id"

        const val ERR_NO_TTS_ENGINE = "NO_TTS_ENGINE"
        const val ERR_MISSING_LANGUAGE_DATA = "MISSING_LANGUAGE_DATA"
        const val ERR_LANGUAGE_NOT_SUPPORTED = "LANGUAGE_NOT_SUPPORTED"
        const val ERR_TTS_INIT_FAILED = "TTS_INIT_FAILED"
        const val ERR_AUDIO_FOCUS_FAILED = "AUDIO_FOCUS_FAILED"
        const val ERR_PLAYBACK_FAILED = "PLAYBACK_FAILED"
        const val ERR_EMPTY_QUEUE = "EMPTY_QUEUE"

        private const val TTS_INIT_TIMEOUT_MS = 8000L
        private const val TTS_DIAG_TIMEOUT_MS = 3000L
        private const val ACTION_TTS_SETTINGS = "com.android.settings.TTS_SETTINGS"

        private val pendingQueues = ConcurrentHashMap<String, QueueData>()
        private var running: LindenMediaPlaybackService? = null
        private var sleepMinutes = 0
        var sleepTimerDeadlineRealtimeMs = 0L
            private set
        var isPlaying = false
            private set
        var playbackState = "idle"
            private set
        var currentBookId = ""
            private set
        var currentBookTitle = ""
            private set
        var currentBookAuthor = ""
            private set
        var currentText = ""
            private set
        var currentJobId = ""
            private set
        var currentUtteranceId = ""
            private set
        var currentGeneration = 0L
            private set
        var completedUtteranceId = ""
            private set
        var completedGeneration = 0L
            private set
        var currentRate = 1.0f
            private set
        var currentVoiceId = ""
            private set
        var currentLocale = "zh-CN"
            private set
        var lastError = ""
            private set
        var lastErrorCode = ""
            private set
        var ttsStatus = "uninitialized"
            private set
        var cachedDefaultEngine = ""
            private set
        var cachedActiveEngine = ""
            private set
        var cachedEngineCount = 0
            private set
        var eventSeq = 0L
            private set
        var currentQueueIndex = 0
            private set
        var queueTotalCount = 0
            private set
        private var texts = arrayListOf<String>()
        private var utterances = arrayListOf<String>()

        fun startSpeaking(
            context: Context,
            bookTitle: String,
            text: String,
            rate: Float = 1f,
            jobId: String = "",
            utteranceId: String = "",
            generation: Long = 0L,
            bookId: String = "",
            voiceId: String = "",
            locale: String = "zh-CN",
            bookAuthor: String = ""
        ) = startSpeakingQueue(
            context,
            bookTitle,
            arrayListOf(text),
            arrayListOf(utteranceId),
            0,
            rate,
            jobId,
            generation,
            bookId,
            voiceId,
            locale,
            bookAuthor
        )

        fun startSpeakingQueue(
            context: Context,
            bookTitle: String,
            queueTexts: ArrayList<String>,
            queueUtterances: ArrayList<String>,
            startIndex: Int = 0,
            rate: Float = 1f,
            jobId: String = "",
            generation: Long = 0L,
            bookId: String = "",
            voiceId: String = "",
            locale: String = "zh-CN",
            bookAuthor: String = ""
        ) {
            require(queueTexts.isNotEmpty() && queueTexts.any { it.isNotBlank() }) {
                val en = LindenNativeBridge.isEnglishLocale(locale)
                "$ERR_EMPTY_QUEUE: ${LindenNativeBridge.l10n(en, "没有可朗读的段落", "No readable paragraphs in queue")}"
            }
            val id = jobId.ifBlank { UUID.randomUUID().toString() }
            pendingQueues.clear()
            // The service shares this process. Only a queue key crosses Binder.
            pendingQueues[id] = QueueData(
                bookId = bookId,
                title = bookTitle,
                bookAuthor = bookAuthor,
                texts = queueTexts,
                utterances = queueUtterances,
                index = startIndex,
                rate = rate.coerceIn(.5f, 3f),
                jobId = id,
                generation = generation,
                voiceId = voiceId.trim(),
                locale = locale.ifBlank { "zh-CN" }
            )
            val intent = Intent(context, LindenMediaPlaybackService::class.java).apply {
                action = ACTION_PLAY_QUEUE
                putExtra(EXTRA_JOB_ID, id)
            }
            try {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (e: Exception) {
                pendingQueues.remove(id)
                throw e
            }
        }

        private fun control(action: String, jobId: String = ""): Boolean {
            if (jobId.isNotBlank()) {
                val pending = pendingQueues[jobId]
                if (pending != null) {
                    if (action == ACTION_STOP) pendingQueues.remove(jobId)
                    if (action == ACTION_PAUSE) pending.startPaused = true
                    if (action == ACTION_RESUME) pending.startPaused = false
                    return true
                }
            }
            val service = running ?: return false
            if (jobId.isNotBlank() && currentJobId != jobId) return false
            if (action == ACTION_RESUME && (texts.isEmpty() || playbackState == "error" || playbackState == "stopped" || playbackState == "completed")) {
                return false
            }
            service.mainHandler.post {
                if (jobId.isBlank() || currentJobId == jobId) service.handleAction(action)
            }
            return true
        }

        fun pause(context: Context, jobId: String = ""): Boolean = control(ACTION_PAUSE, jobId)
        fun resume(context: Context, jobId: String = ""): Boolean = control(ACTION_RESUME, jobId)
        fun stop(context: Context, jobId: String = ""): Boolean = control(ACTION_STOP, jobId)
        fun next(context: Context): Boolean = control(ACTION_NEXT)
        fun previous(context: Context): Boolean = control(ACTION_PREV)

        fun setRate(rate: Float) {
            currentRate = rate.coerceIn(.5f, 3f)
            running?.mainHandler?.post { running?.applyRateChange() }
        }

        fun setSleepTimer(minutes: Int) {
            sleepMinutes = minutes.coerceIn(0, 240)
            sleepTimerDeadlineRealtimeMs = if (sleepMinutes > 0 && running != null)
                SystemClock.elapsedRealtime() + sleepMinutes * 60_000L else 0L
            running?.mainHandler?.post { running?.scheduleSleepTimer() }
        }

        fun listeningIntervals(context: Context): JSONArray = ListeningJournal.pending(context)
        fun acknowledgeListening(context: Context, throughSequence: Long) = ListeningJournal.acknowledge(context, throughSequence)

        private fun queryTtsServices(context: Context): List<Pair<String, String>> {
            return try {
                val pm = context.packageManager
                val intent = Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE)
                val resolved = if (Build.VERSION.SDK_INT >= 33) {
                    pm.queryIntentServices(intent, PackageManager.ResolveInfoFlags.of(0L))
                } else {
                    @Suppress("DEPRECATION")
                    pm.queryIntentServices(intent, 0)
                }
                resolved.mapNotNull { info ->
                    val pkg = info.serviceInfo?.packageName ?: return@mapNotNull null
                    val label = info.loadLabel(pm)?.toString()?.ifBlank { pkg } ?: pkg
                    pkg to label
                }.distinctBy { it.first }
            } catch (_: Exception) {
                emptyList()
            }
        }

        private fun readConfiguredDefaultEngine(context: Context): String {
            return try {
                @Suppress("DEPRECATION")
                Settings.Secure.getString(context.contentResolver, Settings.Secure.TTS_DEFAULT_SYNTH) ?: ""
            } catch (_: Exception) {
                ""
            }
        }

        private fun resolveIntentActivity(context: Context, intent: Intent): Boolean {
            return try {
                val pm = context.packageManager
                val resolved = if (Build.VERSION.SDK_INT >= 33) {
                    pm.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(0L))
                } else {
                    @Suppress("DEPRECATION")
                    pm.resolveActivity(intent, 0)
                }
                resolved != null
            } catch (_: Exception) {
                false
            }
        }

        private fun mapLangAvailability(code: Int): String {
            return when {
                code >= TextToSpeech.LANG_AVAILABLE -> "available"
                code == TextToSpeech.LANG_MISSING_DATA -> "missing_data"
                code == TextToSpeech.LANG_NOT_SUPPORTED -> "not_supported"
                else -> "unknown"
            }
        }

        private fun localeStatusFor(engine: TextToSpeech, primary: Locale, fallback: Locale): String {
            val first = try { engine.isLanguageAvailable(primary) } catch (_: Exception) { TextToSpeech.LANG_NOT_SUPPORTED }
            if (first >= TextToSpeech.LANG_AVAILABLE) return "available"
            val second = try { engine.isLanguageAvailable(fallback) } catch (_: Exception) { TextToSpeech.LANG_NOT_SUPPORTED }
            if (second >= TextToSpeech.LANG_AVAILABLE) return "available"
            if (first == TextToSpeech.LANG_MISSING_DATA || second == TextToSpeech.LANG_MISSING_DATA) {
                return "missing_data"
            }
            return mapLangAvailability(first)
        }

        fun buildSyncDiagnosticsSnapshot(context: Context): JSONObject {
            val services = queryTtsServices(context)
            val configured = readConfiguredDefaultEngine(context)
            val serviceArray = JSONArray()
            for ((pkg, label) in services) {
                serviceArray.put(JSONObject().put("name", pkg).put("label", label))
            }
            val effectiveDefault = cachedDefaultEngine.ifBlank { configured }.ifBlank {
                services.firstOrNull()?.first ?: ""
            }
            return JSONObject().apply {
                put("status", ttsStatus)
                put("ready", running?.ttsReady == true)
                put("serviceCount", services.size)
                put("engineCount", maxOf(cachedEngineCount, services.size))
                put("defaultEngine", effectiveDefault)
                put("activeEngine", cachedActiveEngine.ifBlank { effectiveDefault })
                put("engines", serviceArray)
                put("lastErrorCode", lastErrorCode)
                put("lastError", lastError)
                put(
                    "canOpenTtsSettings",
                    resolveIntentActivity(context, Intent(ACTION_TTS_SETTINGS))
                        || resolveIntentActivity(context, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        || resolveIntentActivity(context, Intent(Settings.ACTION_SETTINGS))
                )
                put("canInstallTtsData", resolveIntentActivity(context, Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)))
            }
        }

        fun diagnoseTts(context: Context, callback: (JSONObject) -> Unit) {
            val handler = Handler(Looper.getMainLooper())
            handler.post {
                val services = queryTtsServices(context)
                val base = buildSyncDiagnosticsSnapshot(context)
                val activeService = running
                if (activeService != null && activeService.tts != null && activeService.ttsReady) {
                    val engine = activeService.tts!!
                    val diag = populateEngineDiagnostics(context, base, engine, services)
                    diag.put("status", "ready")
                    diag.put("ready", true)
                    callback(diag)
                    return@post
                }
                if (services.isEmpty()) {
                    base.put("status", "no_engine")
                    base.put("ready", false)
                    base.put("engineCount", 0)
                    base.put("zhStatus", "unavailable")
                    base.put("enStatus", "unavailable")
                    callback(base)
                    return@post
                }
                var finished = false
                var probeTts: TextToSpeech? = null
                val timeoutRunnable = Runnable {
                    if (finished) return@Runnable
                    finished = true
                    try { probeTts?.stop() } catch (_: Exception) {}
                    try { probeTts?.shutdown() } catch (_: Exception) {}
                    probeTts = null
                    base.put("status", "timeout")
                    base.put("ready", false)
                    base.put("zhStatus", "unknown")
                    base.put("enStatus", "unknown")
                    callback(base)
                }
                handler.postDelayed(timeoutRunnable, TTS_DIAG_TIMEOUT_MS)
                try {
                    probeTts = TextToSpeech(context.applicationContext) { status ->
                        handler.post {
                            if (finished) return@post
                            finished = true
                            handler.removeCallbacks(timeoutRunnable)
                            val instance = probeTts
                            probeTts = null
                            try {
                                if (status == TextToSpeech.SUCCESS && instance != null) {
                                    val diag = populateEngineDiagnostics(context, base, instance, services)
                                    val count = diag.optInt("engineCount", 0)
                                    diag.put("status", if (count > 0) "ready" else "no_engine")
                                    diag.put("ready", count > 0)
                                    callback(diag)
                                } else {
                                    base.put("status", "init_failed")
                                    base.put("ready", false)
                                    base.put("zhStatus", "unknown")
                                    base.put("enStatus", "unknown")
                                    callback(base)
                                }
                            } finally {
                                try { instance?.stop() } catch (_: Exception) {}
                                try { instance?.shutdown() } catch (_: Exception) {}
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (!finished) {
                        finished = true
                        handler.removeCallbacks(timeoutRunnable)
                        base.put("status", "init_failed")
                        base.put("ready", false)
                        base.put("lastError", e.message ?: e.toString())
                        base.put("zhStatus", "unknown")
                        base.put("enStatus", "unknown")
                        callback(base)
                    }
                }
            }
        }

        private fun populateEngineDiagnostics(
            context: Context,
            target: JSONObject,
            engine: TextToSpeech,
            services: List<Pair<String, String>>
        ): JSONObject {
            val engineList = try { engine.engines ?: emptyList() } catch (_: Exception) { emptyList() }
            val defaultEng = try { engine.defaultEngine ?: "" } catch (_: Exception) { "" }
            val configured = readConfiguredDefaultEngine(context)
            cachedEngineCount = maxOf(engineList.size, services.size)
            cachedDefaultEngine = defaultEng.ifBlank { configured }.ifBlank {
                engineList.firstOrNull()?.name ?: services.firstOrNull()?.first ?: ""
            }
            if (cachedActiveEngine.isBlank()) cachedActiveEngine = cachedDefaultEngine

            val arr = JSONArray()
            if (engineList.isNotEmpty()) {
                for (info in engineList) {
                    arr.put(JSONObject().put("name", info.name).put("label", info.label?.ifBlank { info.name } ?: info.name))
                }
            } else {
                for ((pkg, label) in services) {
                    arr.put(JSONObject().put("name", pkg).put("label", label))
                }
            }

            val zh = localeStatusFor(engine, Locale.SIMPLIFIED_CHINESE, Locale.CHINESE)
            val en = localeStatusFor(engine, Locale.US, Locale.ENGLISH)

            target.put("engineCount", cachedEngineCount)
            target.put("defaultEngine", cachedDefaultEngine)
            target.put("activeEngine", cachedActiveEngine.ifBlank { cachedDefaultEngine })
            target.put("engines", arr)
            target.put("zhStatus", zh)
            target.put("enStatus", en)
            return target
        }

        fun openTtsSettings(context: Context): JSONObject {
            val candidates = listOf(
                ACTION_TTS_SETTINGS,
                Settings.ACTION_ACCESSIBILITY_SETTINGS,
                Settings.ACTION_SETTINGS
            )
            for (action in candidates) {
                val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (resolveIntentActivity(context, intent)) {
                    return try {
                        context.startActivity(intent)
                        JSONObject().put("opened", true).put("action", action).put("error", "")
                    } catch (e: Exception) {
                        JSONObject().put("opened", false).put("action", action).put("error", e.message ?: e.toString())
                    }
                }
            }
            return JSONObject().put("opened", false).put("action", "").put("error", "NO_SETTINGS_ACTIVITY")
        }

        fun installTtsVoiceData(context: Context): JSONObject {
            val defaultEngine = cachedDefaultEngine.ifBlank { readConfiguredDefaultEngine(context) }
            val candidates = mutableListOf<Intent>()
            if (defaultEngine.isNotBlank()) {
                candidates.add(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).setPackage(defaultEngine).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            candidates.add(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            for (intent in candidates) {
                if (resolveIntentActivity(context, intent)) {
                    return try {
                        context.startActivity(intent)
                        JSONObject().put("opened", true).put("action", TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).put("error", "")
                    } catch (e: Exception) {
                        JSONObject().put("opened", false).put("action", TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).put("error", e.message ?: e.toString())
                    }
                }
            }
            return JSONObject().put("opened", false).put("action", "").put("error", "NO_INSTALL_ACTIVITY")
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ttsState = TtsInitState.UNINITIALIZED
    private var ttsInitSeq = 0L
    private var ttsReady = false
    private var destroyed = false
    private var wantsPlayback = false
    private var pausedForTransientFocus = false
    private var hasAudioFocus = false
    private var noisyReceiverRegistered = false
    private var runId: String? = null
    private var runCounter = 0L
    private var activeEpochStart = 0L
    private var activeElapsedStart = 0L
    private var mediaSession: MediaSession? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var foreground = false
    private val sleepAction = Runnable {
        sleepMinutes = 0
        sleepTimerDeadlineRealtimeMs = 0L
        stopPlayback()
    }
    private val ttsInitTimeoutRunnable = Runnable { handleTtsInitTimeout(ttsInitSeq) }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        mainHandler.post {
            if (destroyed) return@post
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> {
                    hasAudioFocus = false
                    pausedForTransientFocus = false
                    pausePlayback(preserveTransientFocus = false)
                    abandonAudioFocus()
                }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    hasAudioFocus = false
                    val shouldResumeLater = wantsPlayback || playbackState == "playing" || playbackState == "preparing"
                    if (shouldResumeLater) {
                        pausePlayback(preserveTransientFocus = true)
                    }
                }
                AudioManager.AUDIOFOCUS_GAIN -> {
                    hasAudioFocus = true
                    if (pausedForTransientFocus && texts.isNotEmpty() && playbackState == "paused") {
                        pausedForTransientFocus = false
                        resumePlayback()
                    }
                }
            }
        }
    }

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            mainHandler.post {
                if (destroyed) return@post
                pausedForTransientFocus = false
                pausePlayback(preserveTransientFocus = false)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        running = this
        ListeningJournal.pending(this)
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) {
            val channelName = LindenNativeBridge.l10n(LindenNativeBridge.isEnglishLocale(), "听书播放", "Audio Playback")
            val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        try {
            ContextCompat.registerReceiver(
                this,
                noisyReceiver,
                IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
            noisyReceiverRegistered = true
        } catch (e: Exception) {
            android.util.Log.w("LindenTts", "Cannot register noisy receiver", e)
        }
        mediaSession = MediaSession(this, "LindenLeafTts").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() { resumePlayback() }
                override fun onPause() { pausePlayback() }
                override fun onStop() { stopPlayback() }
                override fun onSkipToNext() { moveSegment(1) }
                override fun onSkipToPrevious() { moveSegment(-1) }
            }, mainHandler)
            @Suppress("DEPRECATION")
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            isActive = true
        }
        ttsState = TtsInitState.UNINITIALIZED
        ttsStatus = "uninitialized"
        ttsReady = false
    }

    private fun isEnglishLocale(): Boolean = currentLocale.startsWith("en", ignoreCase = true)

    private fun syncNotificationChannel(locale: String = currentLocale) {
        if (Build.VERSION.SDK_INT >= 26) {
            val channelName = LindenNativeBridge.l10n(
                LindenNativeBridge.isEnglishLocale(locale),
                "听书播放",
                "Audio Playback"
            )
            val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun tearDownTts() {
        mainHandler.removeCallbacks(ttsInitTimeoutRunnable)
        val old = tts
        tts = null
        ttsReady = false
        ttsState = TtsInitState.UNINITIALIZED
        if (old != null) {
            try { old.setOnUtteranceProgressListener(null) } catch (_: Exception) {}
            try { old.stop() } catch (_: Exception) {}
            try { old.shutdown() } catch (_: Exception) {}
        }
    }

    private fun ensureTtsInitialized() {
        if (destroyed) return
        if (ttsReady && tts != null && ttsState == TtsInitState.READY) {
            speakCurrent()
            return
        }
        if (ttsState == TtsInitState.INITIALIZING && tts != null) {
            return
        }

        tearDownTts()

        val services = queryTtsServices(this)
        cachedEngineCount = services.size
        if (services.isEmpty()) {
            ttsState = TtsInitState.FAILED
            ttsStatus = "no_engine"
            fail(
                ERR_NO_TTS_ENGINE,
                if (isEnglishLocale()) "No system text-to-speech engine found on this device" else "当前设备未检测到可用的系统文字转语音引擎"
            )
            return
        }

        val seq = ++ttsInitSeq
        ttsState = TtsInitState.INITIALIZING
        ttsStatus = "initializing"
        ttsReady = false

        mainHandler.postDelayed(ttsInitTimeoutRunnable, TTS_INIT_TIMEOUT_MS)
        try {
            tts = TextToSpeech(applicationContext) { status ->
                mainHandler.post { handleTtsInit(seq, status) }
            }
        } catch (e: Exception) {
            mainHandler.removeCallbacks(ttsInitTimeoutRunnable)
            tearDownTts()
            ttsState = TtsInitState.FAILED
            ttsStatus = "failed"
            fail(
                ERR_TTS_INIT_FAILED,
                e.message ?: if (isEnglishLocale()) "Failed to bind system text-to-speech service" else "系统文字转语音服务绑定失败"
            )
        }
    }

    private fun handleTtsInitTimeout(seq: Long) {
        if (destroyed || seq != ttsInitSeq || ttsState != TtsInitState.INITIALIZING) return
        tearDownTts()
        ttsState = TtsInitState.FAILED
        ttsStatus = "failed"
        fail(
            ERR_TTS_INIT_FAILED,
            if (isEnglishLocale()) "System TTS engine timed out while initializing" else "系统语音引擎初始化超时，请检查系统文字转语音设置"
        )
    }

    private fun handleTtsInit(seq: Long, status: Int) {
        if (destroyed || seq != ttsInitSeq) return
        mainHandler.removeCallbacks(ttsInitTimeoutRunnable)
        val engine = tts
        if (status != TextToSpeech.SUCCESS || engine == null) {
            val services = queryTtsServices(this)
            val engineListSize = try { engine?.engines?.size ?: 0 } catch (_: Exception) { 0 }
            tearDownTts()
            ttsState = TtsInitState.FAILED
            val hasEngine = services.isNotEmpty() || engineListSize > 0
            ttsStatus = if (hasEngine) "failed" else "no_engine"
            val code = if (hasEngine) ERR_TTS_INIT_FAILED else ERR_NO_TTS_ENGINE
            val msg = if (code == ERR_NO_TTS_ENGINE) {
                if (isEnglishLocale()) "No system text-to-speech engine installed or enabled" else "未检测到可用的系统文字转语音引擎，请前往系统设置安装或启用"
            } else {
                if (isEnglishLocale()) "System TTS initialization failed (status=$status)" else "系统语音引擎初始化失败 (status=$status)，请检查系统的文字转语音设置"
            }
            if (wantsPlayback || playbackState == "preparing") {
                fail(code, msg)
            }
            return
        }

        val engineList = try { engine.engines ?: emptyList() } catch (_: Exception) { emptyList() }
        val services = queryTtsServices(this)
        cachedEngineCount = maxOf(engineList.size, services.size)
        val defaultEng = try { engine.defaultEngine ?: "" } catch (_: Exception) { "" }
        cachedDefaultEngine = defaultEng.ifBlank { readConfiguredDefaultEngine(this) }.ifBlank {
            engineList.firstOrNull()?.name ?: services.firstOrNull()?.first ?: ""
        }
        cachedActiveEngine = cachedDefaultEngine

        if (cachedEngineCount == 0) {
            tearDownTts()
            ttsState = TtsInitState.FAILED
            ttsStatus = "no_engine"
            if (wantsPlayback || playbackState == "preparing") {
                fail(
                    ERR_NO_TTS_ENGINE,
                    if (isEnglishLocale()) "No system text-to-speech engine available" else "没有可用的系统文字转语音引擎"
                )
            }
            return
        }

        try {
            engine.setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            )
        } catch (_: Exception) {}

        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                mainHandler.post startCallback@{
                    if (!accepts(utteranceId)) return@startCallback
                    if (sleepExpired()) { stopPlayback(); return@startCallback }
                    activeEpochStart = System.currentTimeMillis()
                    activeElapsedStart = SystemClock.elapsedRealtime()
                    isPlaying = true
                    playbackState = "playing"
                    lastError = ""
                    lastErrorCode = ""
                    publish()
                    emit("playbackstarted")
                }
            }

            override fun onDone(utteranceId: String?) {
                mainHandler.post doneCallback@{
                    if (!accepts(utteranceId)) return@doneCallback
                    handleSegmentCompleted(emitSegmentEvent = true)
                }
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                mainHandler.post errorCallback@{
                    if (!accepts(utteranceId)) return@errorCallback
                    handleUtteranceError(errorCode)
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                mainHandler.post errorCallback@{
                    if (!accepts(utteranceId)) return@errorCallback
                    handleUtteranceError(TextToSpeech.ERROR)
                }
            }
        })

        ttsState = TtsInitState.READY
        ttsStatus = "ready"
        ttsReady = true
        // A pause or stop while the engine initialized must remain effective.
        if (wantsPlayback && !destroyed) speakCurrent()
    }

    private fun handleSegmentCompleted(emitSegmentEvent: Boolean) {
        finishInterval()
        isPlaying = false
        completedUtteranceId = currentUtteranceId
        completedGeneration = currentGeneration
        if (!sleepExpired() && currentQueueIndex + 1 < texts.size) {
            if (emitSegmentEvent) emit("playbacksegmentcompleted")
            currentQueueIndex++
            prepareCurrent()
        } else {
            val wasSleepExpired = sleepExpired()
            wantsPlayback = false
            pausedForTransientFocus = false
            runId = null
            playbackState = if (wasSleepExpired) "stopped" else "completed"
            if (wasSleepExpired) {
                sleepMinutes = 0
                sleepTimerDeadlineRealtimeMs = 0L
                mainHandler.removeCallbacks(sleepAction)
            }
            abandonAudioFocus()
            mediaSession?.isActive = false
            publishMetadataOnly()
            emit(if (playbackState == "completed") "playbackcompleted" else "playbackstopped")
            texts.clear()
            utterances.clear()
            queueTotalCount = 0
            currentQueueIndex = 0
            currentText = ""
            removeNotification()
        }
    }

    private fun handleUtteranceError(errorCode: Int) {
        val code: String
        val msg: String
        when (errorCode) {
            TextToSpeech.ERROR_NOT_INSTALLED_YET -> {
                code = ERR_MISSING_LANGUAGE_DATA
                msg = if (isEnglishLocale()) {
                    "System speech voice data is not installed yet"
                } else {
                    "系统语音包尚未安装完成，请检查语音数据"
                }
            }
            TextToSpeech.ERROR_SERVICE -> {
                tearDownTts()
                ttsState = TtsInitState.FAILED
                ttsStatus = "failed"
                code = ERR_TTS_INIT_FAILED
                msg = if (isEnglishLocale()) {
                    "System TTS engine service disconnected (error=$errorCode)"
                } else {
                    "系统语音服务异常中断 (error=$errorCode)，请检查系统语音设置"
                }
            }
            TextToSpeech.ERROR_NETWORK,
            TextToSpeech.ERROR_NETWORK_TIMEOUT -> {
                code = ERR_PLAYBACK_FAILED
                msg = if (isEnglishLocale()) {
                    "Selected TTS voice requires network access and timed out (error=$errorCode)"
                } else {
                    "当前系统语音需要网络连接或连接超时 (error=$errorCode)"
                }
            }
            else -> {
                code = ERR_PLAYBACK_FAILED
                msg = if (isEnglishLocale()) {
                    "System TTS playback failed (error=$errorCode)"
                } else {
                    "系统语音无法朗读当前段落 (error=$errorCode)，请检查语音包或引擎设置"
                }
            }
        }
        fail(code, msg)
    }

    private fun accepts(id: String?): Boolean =
        !destroyed && wantsPlayback && id != null && id == runId

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PLAY_QUEUE) {
            val key = intent.getStringExtra(EXTRA_JOB_ID) ?: ""
            val queue = pendingQueues.remove(key)
            if (queue != null) {
                if (queue.texts.isEmpty() || queue.texts.all { it.isBlank() }) {
                    if (Build.VERSION.SDK_INT >= 26) ensureForegroundNotification()
                    if (pendingQueues.isEmpty()) stopPlayback()
                } else {
                    begin(queue)
                }
            } else if (!foreground && texts.isEmpty() && pendingQueues.isEmpty()) {
                if (Build.VERSION.SDK_INT >= 26) ensureForegroundNotification()
                removeNotification()
                stopSelf()
            } else if (Build.VERSION.SDK_INT >= 26 && !foreground) {
                ensureForegroundNotification()
            }
        } else {
            if (Build.VERSION.SDK_INT >= 26 && !foreground) {
                ensureForegroundNotification()
            }
            handleAction(intent?.action ?: "")
            if (!wantsPlayback && texts.isEmpty() && pendingQueues.isEmpty()) {
                removeNotification()
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun begin(queue: QueueData) {
        if (queue.texts.isEmpty()) return
        runId = null
        try { tts?.stop() } catch (_: Exception) {}
        finishInterval()
        pausedForTransientFocus = false
        texts = queue.texts
        utterances = queue.utterances
        currentQueueIndex = queue.index.coerceIn(0, texts.lastIndex)
        queueTotalCount = texts.size
        currentBookId = queue.bookId
        currentBookTitle = queue.title
        currentBookAuthor = queue.bookAuthor
        currentJobId = queue.jobId
        currentGeneration = queue.generation
        currentRate = queue.rate
        currentVoiceId = queue.voiceId
        currentLocale = queue.locale
        syncNotificationChannel(currentLocale)
        completedUtteranceId = ""
        completedGeneration = 0L
        lastError = ""
        lastErrorCode = ""
        wantsPlayback = !queue.startPaused
        playbackState = if (queue.startPaused) "paused" else "preparing"
        isPlaying = false
        if (sleepMinutes > 0 && sleepTimerDeadlineRealtimeMs == 0L)
            sleepTimerDeadlineRealtimeMs = SystemClock.elapsedRealtime() + sleepMinutes * 60_000L
        scheduleSleepTimer()
        currentText = texts[currentQueueIndex]
        currentUtteranceId = utterances.getOrNull(currentQueueIndex)?.ifBlank { null }
            ?: (currentJobId + ":" + currentQueueIndex)
        mediaSession?.isActive = true
        publish(ensureForeground = true)
        if (wantsPlayback) {
            prepareCurrent()
        }
    }

    private fun prepareCurrent() {
        if (!wantsPlayback || destroyed || texts.isEmpty()) return
        if (sleepExpired()) { stopPlayback(); return }
        if (currentQueueIndex !in texts.indices) return
        currentText = texts[currentQueueIndex]
        currentUtteranceId = utterances.getOrNull(currentQueueIndex)?.ifBlank { null }
            ?: (currentJobId + ":" + currentQueueIndex)
        playbackState = "preparing"
        isPlaying = false
        mediaSession?.isActive = true
        publish(ensureForeground = true)
        ensureTtsInitialized()
    }

    private fun languageCandidatesFor(text: String): List<Locale> {
        val hasKana = text.any { ch ->
            ch in '\u3040'..'\u309F' || ch in '\u30A0'..'\u30FF' ||
                ch in '\u31F0'..'\u31FF' || ch in '\uFF65'..'\uFF9F'
        }
        val hasHangul = text.any { ch ->
            ch in '\uAC00'..'\uD7AF' || ch in '\u1100'..'\u11FF' || ch in '\u3130'..'\u318F'
        }
        val hasHan = text.any { ch ->
            ch in '\u3400'..'\u4DBF' || ch in '\u4E00'..'\u9FFF' || ch in '\uF900'..'\uFAFF'
        }
        val hasLatin = text.any { ch -> ch in 'A'..'Z' || ch in 'a'..'z' }
        val appLocale = run {
            val tag = currentLocale.trim()
            if (tag.isNotBlank()) Locale.forLanguageTag(tag) else null
        }
        return when {
            hasKana -> listOf(Locale.JAPANESE, Locale.JAPAN)
            hasHangul -> listOf(Locale.KOREAN, Locale.KOREA)
            hasHan -> when {
                currentLocale.startsWith("ja", ignoreCase = true) ->
                    listOf(Locale.JAPANESE, Locale.JAPAN, Locale.SIMPLIFIED_CHINESE, Locale.TRADITIONAL_CHINESE)
                currentLocale.contains("TW", ignoreCase = true) ||
                    currentLocale.contains("HK", ignoreCase = true) ||
                    currentLocale.contains("MO", ignoreCase = true) ||
                    currentLocale.contains("Hant", ignoreCase = true) ->
                    listOf(Locale.TRADITIONAL_CHINESE, Locale.SIMPLIFIED_CHINESE, Locale.CHINESE)
                else ->
                    listOf(Locale.SIMPLIFIED_CHINESE, Locale.CHINESE, Locale.TRADITIONAL_CHINESE)
            }
            hasLatin -> listOf(Locale.US, Locale.ENGLISH, Locale.UK)
            else -> listOfNotNull(appLocale, Locale.getDefault(), Locale.SIMPLIFIED_CHINESE, Locale.US).distinct()
        }
    }

    private fun speakCurrent() {
        if (!wantsPlayback || destroyed || currentQueueIndex !in texts.indices) return
        if (sleepExpired()) { stopPlayback(); return }
        val engine = tts
        if (!ttsReady || engine == null) {
            ensureTtsInitialized()
            return
        }

        if (currentText.isBlank() || !currentText.any { it.isLetterOrDigit() }) {
            mainHandler.post {
                if (wantsPlayback && !destroyed) {
                    handleSegmentCompleted(emitSegmentEvent = true)
                }
            }
            return
        }

        if (!requestAudioFocus()) {
            fail(
                ERR_AUDIO_FOCUS_FAILED,
                if (isEnglishLocale()) "Unable to obtain audio focus right now" else "暂时无法获得音频焦点，请稍后再试"
            )
            return
        }

        val candidates = languageCandidatesFor(currentText)
        var chosenLocale: Locale? = null
        var sawMissingData = false
        for (loc in candidates) {
            val avail = try {
                engine.isLanguageAvailable(loc)
            } catch (_: Exception) {
                TextToSpeech.LANG_NOT_SUPPORTED
            }
            if (avail >= TextToSpeech.LANG_AVAILABLE) {
                chosenLocale = loc
                break
            } else if (avail == TextToSpeech.LANG_MISSING_DATA) {
                sawMissingData = true
            }
        }

        if (chosenLocale == null) {
            val engineCountNow = try { engine.engines?.size ?: 0 } catch (_: Exception) { 0 }
            if (engineCountNow == 0 && queryTtsServices(this).isEmpty()) {
                tearDownTts()
                ttsState = TtsInitState.FAILED
                ttsStatus = "no_engine"
                fail(
                    ERR_NO_TTS_ENGINE,
                    if (isEnglishLocale()) "No system text-to-speech engine found" else "当前设备未检测到可用的系统文字转语音引擎"
                )
            } else if (sawMissingData) {
                val targetTag = candidates.first().toLanguageTag()
                fail(
                    ERR_MISSING_LANGUAGE_DATA,
                    if (isEnglishLocale()) {
                        "Missing system TTS voice data ($targetTag). Please install language data in system TTS settings."
                    } else {
                        "系统语音引擎缺少所需语音包 ($targetTag)，请前往系统设置安装语音数据"
                    }
                )
            } else {
                val targetTag = candidates.first().toLanguageTag()
                fail(
                    ERR_LANGUAGE_NOT_SUPPORTED,
                    if (isEnglishLocale()) {
                        "Current system TTS engine does not support language ($targetTag)"
                    } else {
                        "当前系统语音引擎不支持该语言 ($targetTag)，请切换引擎或安装对应语音包"
                    }
                )
            }
            return
        }

        val setLangRes = try { engine.setLanguage(chosenLocale) } catch (_: Exception) { TextToSpeech.LANG_NOT_SUPPORTED }
        if (setLangRes == TextToSpeech.LANG_MISSING_DATA) {
            fail(
                ERR_MISSING_LANGUAGE_DATA,
                if (isEnglishLocale()) "Missing system TTS voice data for ${chosenLocale.toLanguageTag()}" else "缺少系统语音数据 (${chosenLocale.toLanguageTag()})"
            )
            return
        }
        if (setLangRes < TextToSpeech.LANG_AVAILABLE) {
            fail(
                ERR_LANGUAGE_NOT_SUPPORTED,
                if (isEnglishLocale()) "Unsupported language in system TTS: ${chosenLocale.toLanguageTag()}" else "系统语音引擎不支持语言 (${chosenLocale.toLanguageTag()})"
            )
            return
        }

        // Optional real device voice selection; never require hardcoded preset voices.
        if (currentVoiceId.isNotBlank() && currentVoiceId != "android_default") {
            try {
                val matchedVoice = engine.voices?.firstOrNull {
                    it.name == currentVoiceId && it.locale?.language == chosenLocale.language
                }
                if (matchedVoice != null) {
                    engine.voice = matchedVoice
                }
            } catch (_: Exception) {}
        }

        try { engine.setSpeechRate(currentRate) } catch (_: Exception) {}

        val token = (++runCounter).toString()
        runId = token
        val speakRes = try {
            engine.speak(currentText, TextToSpeech.QUEUE_FLUSH, null, token)
        } catch (_: Exception) {
            TextToSpeech.ERROR
        }
        if (speakRes != TextToSpeech.SUCCESS) {
            runId = null
            tearDownTts()
            ttsState = TtsInitState.FAILED
            ttsStatus = "failed"
            fail(
                ERR_PLAYBACK_FAILED,
                if (isEnglishLocale()) {
                    "System TTS speak() rejected request (code=$speakRes)"
                } else {
                    "系统语音引擎启动朗读失败 (code=$speakRes)"
                }
            )
        }
    }

    private fun applyRateChange() {
        try { tts?.setSpeechRate(currentRate) } catch (_: Exception) {}
        if (!destroyed && wantsPlayback && playbackState == "playing" && texts.isNotEmpty()) {
            runId = null
            try { tts?.stop() } catch (_: Exception) {}
            finishInterval()
            prepareCurrent()
        } else if (!destroyed && texts.isNotEmpty()) {
            publish()
        }
    }

    private fun handleAction(action: String) {
        when (action) {
            ACTION_PAUSE -> pausePlayback(preserveTransientFocus = false)
            ACTION_RESUME -> resumePlayback()
            ACTION_STOP -> stopPlayback()
            ACTION_NEXT -> moveSegment(1)
            ACTION_PREV -> moveSegment(-1)
        }
    }

    private fun pausePlayback(preserveTransientFocus: Boolean = false) {
        if (destroyed) return
        if (!preserveTransientFocus) {
            pausedForTransientFocus = false
        }
        if (!wantsPlayback && playbackState != "preparing") {
            if (!preserveTransientFocus) abandonAudioFocus()
            return
        }
        wantsPlayback = false
        if (preserveTransientFocus) {
            pausedForTransientFocus = true
        }
        runId = null
        try { tts?.stop() } catch (_: Exception) {}
        finishInterval()
        isPlaying = false
        playbackState = "paused"
        if (!preserveTransientFocus) {
            abandonAudioFocus()
        }
        publish()
        emit("playbackpaused")
    }

    private fun resumePlayback() {
        if (destroyed || texts.isEmpty() || playbackState == "playing" || wantsPlayback) return
        if (playbackState == "error" || playbackState == "stopped" || playbackState == "completed") return
        pausedForTransientFocus = false
        wantsPlayback = true
        prepareCurrent()
    }

    private fun moveSegment(delta: Int) {
        if (destroyed || texts.isEmpty()) return
        val next = currentQueueIndex + delta
        if (next !in texts.indices) return
        pausedForTransientFocus = false
        runId = null
        try { tts?.stop() } catch (_: Exception) {}
        finishInterval()
        isPlaying = false
        currentQueueIndex = next
        currentText = texts[next]
        currentUtteranceId = utterances.getOrNull(next)?.ifBlank { null } ?: (currentJobId + ":" + next)
        if (wantsPlayback) prepareCurrent()
        else { publish(); emit("playbackpositionchanged") }
    }

    private fun stopPlayback() {
        val activeJob = currentJobId
        val activeGen = currentGeneration
        val activeUtt = currentUtteranceId
        val activeIdx = currentQueueIndex
        val activeTot = queueTotalCount
        wantsPlayback = false
        pausedForTransientFocus = false
        runId = null
        mainHandler.removeCallbacks(sleepAction)
        sleepMinutes = 0
        sleepTimerDeadlineRealtimeMs = 0L
        try { tts?.stop() } catch (_: Exception) {}
        finishInterval()
        isPlaying = false
        playbackState = "stopped"
        lastError = ""
        lastErrorCode = ""
        abandonAudioFocus()
        mediaSession?.isActive = false
        publishMetadataOnly()
        emit("playbackstopped", activeJob, activeGen, activeUtt, activeIdx, activeTot)
        texts.clear()
        utterances.clear()
        queueTotalCount = 0
        currentQueueIndex = 0
        currentText = ""
        removeNotification()
        stopSelf()
    }

    private fun fail(errorCode: String, message: String) {
        val activeJob = currentJobId
        val activeGen = currentGeneration
        val activeUtt = currentUtteranceId
        val activeIdx = currentQueueIndex
        val activeTot = queueTotalCount
        wantsPlayback = false
        pausedForTransientFocus = false
        runId = null
        mainHandler.removeCallbacks(sleepAction)
        sleepMinutes = 0
        sleepTimerDeadlineRealtimeMs = 0L
        tearDownTts()
        if (errorCode == ERR_NO_TTS_ENGINE) ttsStatus = "no_engine" else ttsStatus = "failed"
        finishInterval()
        isPlaying = false
        playbackState = "error"
        lastErrorCode = errorCode
        lastError = message
        abandonAudioFocus()
        mediaSession?.isActive = false
        publishMetadataOnly()
        emit("playbackerror", activeJob, activeGen, activeUtt, activeIdx, activeTot)
        texts.clear()
        utterances.clear()
        queueTotalCount = 0
        currentQueueIndex = 0
        currentText = ""
        removeNotification()
        stopSelf()
    }

    private fun removeNotification() {
        try {
            if (foreground) {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                foreground = false
            }
            getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
        } catch (_: Exception) {}
    }

    private fun finishInterval() {
        if (activeEpochStart > 0L) {
            val end = activeEpochStart + maxOf(0L, SystemClock.elapsedRealtime() - activeElapsedStart)
            ListeningJournal.add(this, currentBookId, currentBookTitle, currentBookAuthor, currentJobId, activeEpochStart, end)
            activeEpochStart = 0L
            activeElapsedStart = 0L
        }
    }

    private fun sleepExpired(): Boolean =
        sleepTimerDeadlineRealtimeMs > 0L && SystemClock.elapsedRealtime() >= sleepTimerDeadlineRealtimeMs

    private fun scheduleSleepTimer() {
        mainHandler.removeCallbacks(sleepAction)
        if (sleepTimerDeadlineRealtimeMs > 0L)
            mainHandler.postDelayed(sleepAction, maxOf(0L, sleepTimerDeadlineRealtimeMs - SystemClock.elapsedRealtime()))
    }

    private fun emit(
        type: String,
        jobId: String = currentJobId,
        generation: Long = currentGeneration,
        utteranceId: String = currentUtteranceId,
        queueIndex: Int = currentQueueIndex,
        queueTotal: Int = queueTotalCount
    ) {
        eventSeq++
        // Capture ownership and state before posting to the WebView.
        val data = JSONObject().apply {
            put("type", type)
            put("state", playbackState)
            put("jobId", jobId)
            put("generation", generation)
            put("utteranceId", utteranceId)
            put("queueIndex", queueIndex)
            put("queueTotal", queueTotal)
            put("seq", eventSeq)
            put("error", lastError)
            put("errorCode", lastErrorCode)
        }.toString()
        val webView = MainActivity.instance?.currentWebView ?: return
        webView.post { webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('androidttsevent',{detail:$data}));", null) }
    }

    private fun publishMetadataOnly() {
        val state = when (playbackState) {
            "playing" -> PlaybackState.STATE_PLAYING
            "preparing" -> PlaybackState.STATE_BUFFERING
            "paused" -> PlaybackState.STATE_PAUSED
            "completed", "stopped" -> PlaybackState.STATE_STOPPED
            "error" -> PlaybackState.STATE_ERROR
            else -> PlaybackState.STATE_NONE
        }
        mediaSession?.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE
                        or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS
                )
                .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (isPlaying) currentRate else 0f)
                .build()
        )
        val segText = if (isEnglishLocale()) {
            "Segment ${currentQueueIndex + 1} / $queueTotalCount"
        } else {
            "第 ${currentQueueIndex + 1} 段 / $queueTotalCount 段"
        }
        mediaSession?.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, currentBookTitle.ifBlank { "Linden Leaf" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, segText)
                .build()
        )
    }

    private fun ensureForegroundNotification() {
        if (foreground) return
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIFICATION_ID, notification)
        foreground = true
    }

    private fun publish(ensureForeground: Boolean = false) {
        publishMetadataOnly()
        val notification = buildNotification()
        if (ensureForeground && !foreground) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(NOTIFICATION_ID, notification)
            foreground = true
        } else if (foreground) {
            getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun actionIntent(action: String, code: Int): PendingIntent =
            PendingIntent.getService(this, code, Intent(this, LindenMediaPlaybackService::class.java).setAction(action), flags)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        val pause = wantsPlayback
        val en = isEnglishLocale()
        val prevLabel = if (en) "Previous" else "上一段"
        val toggleLabel = if (pause) (if (en) "Pause" else "暂停") else (if (en) "Play" else "播放")
        val nextLabel = if (en) "Next" else "下一段"
        val stopLabel = if (en) "Stop" else "停止"
        val contentText = if (en) {
            "Segment ${currentQueueIndex + 1} / $queueTotalCount"
        } else {
            "第 ${currentQueueIndex + 1} 段 / $queueTotalCount 段"
        }
        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentBookTitle.ifBlank { "Linden Leaf" })
            .setContentText(contentText)
            .setContentIntent(open).setOnlyAlertOnce(true).setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC).setCategory(Notification.CATEGORY_TRANSPORT)
            .setOngoing(wantsPlayback)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, prevLabel, actionIntent(ACTION_PREV, 1)).build())
            .addAction(Notification.Action.Builder(if (pause) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                toggleLabel, actionIntent(if (pause) ACTION_PAUSE else ACTION_RESUME, 2)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, nextLabel, actionIntent(ACTION_NEXT, 3)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, stopLabel, actionIntent(ACTION_STOP, 4)).build())
            .setDeleteIntent(actionIntent(ACTION_STOP, 5))
        mediaSession?.sessionToken?.let { token ->
            builder.setStyle(Notification.MediaStyle().setMediaSession(token).setShowActionsInCompactView(0, 1, 2))
        }
        return builder.build()
    }

    private fun requestAudioFocus(): Boolean {
        if (hasAudioFocus) return true
        val am = audioManager ?: return false
        val granted = if (Build.VERSION.SDK_INT >= 26) {
            val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .build()
                )
                .setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(focusListener, mainHandler)
                .build()
                .also { focusRequest = it }
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        hasAudioFocus = granted
        return granted
    }

    private fun abandonAudioFocus() {
        hasAudioFocus = false
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        else { @Suppress("DEPRECATION") audioManager?.abandonAudioFocus(focusListener) }
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        destroyed = true
        wantsPlayback = false
        pausedForTransientFocus = false
        runId = null
        finishInterval()
        if (playbackState == "playing" || playbackState == "preparing") {
            playbackState = "stopped"; isPlaying = false; emit("playbackstopped")
        }
        mainHandler.removeCallbacksAndMessages(null)
        tearDownTts()
        abandonAudioFocus()
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
        if (noisyReceiverRegistered) {
            noisyReceiverRegistered = false
            try { unregisterReceiver(noisyReceiver) } catch (_: Exception) {}
        }
        if (running === this) {
            running = null
            texts.clear()
            utterances.clear()
            queueTotalCount = 0
            currentQueueIndex = 0
        }
        super.onDestroy()
    }
}

/** Unacknowledged real playback intervals survive a WebView or service restart. */
private object ListeningJournal {
    private var loaded = false
    private var sequence = 0L
    private val records = mutableListOf<JSONObject>()
    private fun file(context: Context) = AtomicFile(File(context.filesDir, "tts-listening.json"))
    private fun load(context: Context) {
        if (loaded) return
        try {
            val data = file(context).openRead().bufferedReader().use { JSONObject(it.readText()) }
            sequence = data.optLong("sequence", 0L)
            val items = data.optJSONArray("intervals") ?: JSONArray()
            for (i in 0 until items.length()) records.add(items.getJSONObject(i))
        } catch (_: java.io.FileNotFoundException) {
        } catch (e: Exception) { android.util.Log.w("LindenTts", "Cannot read listening intervals", e) }
        loaded = true
    }
    private fun save(context: Context) {
        val store = file(context)
        val out = store.startWrite()
        try {
            val data = JSONObject().put("sequence", sequence).put("intervals", JSONArray(records))
            out.write(data.toString().toByteArray(Charsets.UTF_8))
            store.finishWrite(out)
        } catch (e: Exception) { store.failWrite(out); throw e }
    }
    @Synchronized fun add(context: Context, bookId: String, title: String, bookAuthor: String, jobId: String, start: Long, end: Long) {
        load(context)
        if (bookId.isBlank() || end <= start) return
        sequence++
        records.add(JSONObject().put("sequence", sequence).put("bookId", bookId).put("bookTitle", title)
            .put("bookAuthor", bookAuthor).put("jobId", jobId).put("startMs", start).put("endMs", end))
        try { save(context) } catch (e: Exception) { android.util.Log.w("LindenTts", "Listening save deferred", e) }
    }
    @Synchronized fun pending(context: Context): JSONArray {
        load(context)
        return JSONArray(records.map { JSONObject(it.toString()) })
    }
    @Synchronized fun acknowledge(context: Context, throughSequence: Long) {
        load(context)
        records.removeAll { it.optLong("sequence") <= throughSequence }
        save(context)
    }
}
