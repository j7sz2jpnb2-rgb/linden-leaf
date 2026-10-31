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
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class LindenMediaPlaybackService : Service(), TextToSpeech.OnInitListener {
    private data class QueueData(
        val bookId: String, val title: String, val texts: ArrayList<String>,
        val utterances: ArrayList<String>, val index: Int, val rate: Float,
        val jobId: String, val generation: Long, var startPaused: Boolean = false
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
        var lastError = ""
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
            context: Context, bookTitle: String, text: String, rate: Float = 1f,
            jobId: String = "", utteranceId: String = "", generation: Long = 0L,
            bookId: String = ""
        ) = startSpeakingQueue(context, bookTitle, arrayListOf(text), arrayListOf(utteranceId),
            0, rate, jobId, generation, bookId)

        fun startSpeakingQueue(
            context: Context, bookTitle: String, queueTexts: ArrayList<String>,
            queueUtterances: ArrayList<String>, startIndex: Int = 0, rate: Float = 1f,
            jobId: String = "", generation: Long = 0L, bookId: String = ""
        ) {
            require(queueTexts.isNotEmpty()) { "没有可朗读的段落" }
            val id = jobId.ifBlank { UUID.randomUUID().toString() }
            // The service shares this process. Only a queue key crosses Binder.
            pendingQueues[id] = QueueData(bookId, bookTitle, queueTexts, queueUtterances,
                startIndex, rate.coerceIn(.5f, 3f), id, generation)
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
            running?.mainHandler?.post { running?.tts?.setSpeechRate(currentRate) }
        }
        fun setSleepTimer(minutes: Int) {
            sleepMinutes = minutes.coerceIn(0, 240)
            sleepTimerDeadlineRealtimeMs = if (sleepMinutes > 0 && running != null)
                SystemClock.elapsedRealtime() + sleepMinutes * 60_000L else 0L
            running?.mainHandler?.post { running?.scheduleSleepTimer() }
        }
        fun listeningIntervals(context: Context): JSONArray = ListeningJournal.pending(context)
        fun acknowledgeListening(context: Context, throughSequence: Long) = ListeningJournal.acknowledge(context, throughSequence)
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var destroyed = false
    private var wantsPlayback = false
    private var runId: String? = null
    private var runCounter = 0L
    private var activeEpochStart = 0L
    private var activeElapsedStart = 0L
    private var mediaSession: MediaSession? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var foreground = false
    private val sleepAction = Runnable { stopPlayback() }
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
            mainHandler.post { pausePlayback() }
    }
    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { pausePlayback() }
    }

    override fun onCreate() {
        super.onCreate()
        running = this
        ListeningJournal.pending(this)
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "听书播放", NotificationManager.IMPORTANCE_LOW)
            channel.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        ContextCompat.registerReceiver(this, noisyReceiver,
            IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
        mediaSession = MediaSession(this, "LindenLeafTts").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() { resumePlayback() }
                override fun onPause() { pausePlayback() }
                override fun onStop() { stopPlayback() }
                override fun onSkipToNext() { moveSegment(1) }
                override fun onSkipToPrevious() { moveSegment(-1) }
            }, mainHandler)
            setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
            isActive = true
        }
        tts = TextToSpeech(applicationContext, this)
    }

    override fun onInit(status: Int) {
        mainHandler.post {
            if (destroyed) return@post
            if (status != TextToSpeech.SUCCESS) {
                fail("系统语音初始化失败，请检查系统的文字转语音设置")
                return@post
            }
            ttsReady = true
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    mainHandler.post startCallback@ {
                        if (!accepts(utteranceId)) return@startCallback
                        if (sleepExpired()) { stopPlayback(); return@startCallback }
                        activeEpochStart = System.currentTimeMillis()
                        activeElapsedStart = SystemClock.elapsedRealtime()
                        isPlaying = true
                        playbackState = "playing"
                        publish()
                        emit("playbackstarted")
                    }
                }
                override fun onDone(utteranceId: String?) {
                    mainHandler.post doneCallback@ {
                        if (!accepts(utteranceId)) return@doneCallback
                        finishInterval()
                        isPlaying = false
                        completedUtteranceId = currentUtteranceId
                        completedGeneration = currentGeneration
                        if (!sleepExpired() && currentQueueIndex + 1 < texts.size) {
                            emit("playbacksegmentcompleted")
                            currentQueueIndex++
                            prepareCurrent()
                        } else {
                            wantsPlayback = false
                            playbackState = if (sleepExpired()) "stopped" else "completed"
                            abandonAudioFocus()
                            publish()
                            emit(if (playbackState == "completed") "playbackcompleted" else "playbackstopped")
                            stopForeground(false)
                            foreground = false
                        }
                    }
                }
                override fun onError(utteranceId: String?) {
                    mainHandler.post { if (accepts(utteranceId)) fail("系统语音无法朗读这一段，请检查语音包") }
                }
            })
            // A pause or stop while the engine initialized must remain effective.
            if (wantsPlayback && !destroyed) prepareCurrent()
        }
    }

    private fun accepts(id: String?): Boolean =
        !destroyed && wantsPlayback && id != null && id == runId

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PLAY_QUEUE) {
            val key = intent.getStringExtra(EXTRA_JOB_ID) ?: ""
            val queue = pendingQueues.remove(key)
            if (queue != null) begin(queue)
            else if (!foreground && texts.isEmpty()) stopSelf()
        } else {
            handleAction(intent?.action ?: "")
        }
        return START_NOT_STICKY
    }

    private fun begin(queue: QueueData) {
        runId = null
        tts?.stop()
        finishInterval()
        texts = queue.texts
        utterances = queue.utterances
        currentQueueIndex = queue.index.coerceIn(0, texts.lastIndex)
        queueTotalCount = texts.size
        currentBookId = queue.bookId
        currentBookTitle = queue.title
        currentJobId = queue.jobId
        currentGeneration = queue.generation
        currentRate = queue.rate
        completedUtteranceId = ""
        lastError = ""
        wantsPlayback = !queue.startPaused
        playbackState = if (queue.startPaused) "paused" else "preparing"
        isPlaying = false
        if (sleepMinutes > 0 && sleepTimerDeadlineRealtimeMs == 0L)
            sleepTimerDeadlineRealtimeMs = SystemClock.elapsedRealtime() + sleepMinutes * 60_000L
        scheduleSleepTimer()
        currentText = texts[currentQueueIndex]
        publish(ensureForeground = true)
        prepareCurrent()
    }

    private fun prepareCurrent() {
        if (!wantsPlayback || destroyed || texts.isEmpty()) return
        if (sleepExpired()) { stopPlayback(); return }
        currentText = texts[currentQueueIndex]
        currentUtteranceId = utterances.getOrNull(currentQueueIndex)?.ifBlank { null }
            ?: (currentJobId + ":" + currentQueueIndex)
        playbackState = "preparing"
        isPlaying = false
        publish(ensureForeground = true)
        if (!ttsReady) return
        if (!requestAudioFocus()) { fail("暂时无法获得音频焦点，请稍后播放"); return }
        val language = if (currentText.any { it in '\u3400'..'\u9fff' }) Locale.SIMPLIFIED_CHINESE else Locale.ENGLISH
        if ((tts?.setLanguage(language) ?: TextToSpeech.LANG_NOT_SUPPORTED) < TextToSpeech.LANG_AVAILABLE) {
            fail("系统缺少这本书所需的语音，请在系统文字转语音设置中安装语音包")
            return
        }
        tts?.setSpeechRate(currentRate)
        runCounter++
        runId = currentJobId + ":" + runCounter + ":" + currentQueueIndex
        val result = tts?.speak(currentText, TextToSpeech.QUEUE_FLUSH, null, runId)
        if (result == TextToSpeech.ERROR) fail("系统语音未能开始播放")
    }

    private fun handleAction(action: String) {
        when (action) {
            ACTION_PAUSE -> pausePlayback()
            ACTION_RESUME -> resumePlayback()
            ACTION_STOP -> stopPlayback()
            ACTION_NEXT -> moveSegment(1)
            ACTION_PREV -> moveSegment(-1)
        }
    }

    private fun pausePlayback() {
        if (destroyed || (!wantsPlayback && playbackState != "preparing")) return
        wantsPlayback = false
        runId = null
        tts?.stop()
        finishInterval()
        isPlaying = false
        playbackState = "paused"
        abandonAudioFocus()
        publish()
        emit("playbackpaused")
    }

    private fun resumePlayback() {
        if (destroyed || texts.isEmpty() || playbackState == "playing" || wantsPlayback) return
        wantsPlayback = true
        prepareCurrent()
    }

    private fun moveSegment(delta: Int) {
        if (texts.isEmpty()) return
        val next = currentQueueIndex + delta
        if (next !in texts.indices) return
        runId = null
        tts?.stop()
        finishInterval()
        currentQueueIndex = next
        currentText = texts[next]
        currentUtteranceId = utterances.getOrNull(next) ?: (currentJobId + ":" + next)
        if (wantsPlayback) prepareCurrent()
        else { publish(); emit("playbackpositionchanged") }
    }

    private fun stopPlayback() {
        wantsPlayback = false
        runId = null
        tts?.stop()
        finishInterval()
        isPlaying = false
        playbackState = "stopped"
        mainHandler.removeCallbacks(sleepAction)
        sleepTimerDeadlineRealtimeMs = 0L
        sleepMinutes = 0
        abandonAudioFocus()
        emit("playbackstopped")
        mediaSession?.isActive = false
        stopForeground(true)
        foreground = false
        stopSelf()
    }

    private fun fail(message: String) {
        wantsPlayback = false
        runId = null
        tts?.stop()
        finishInterval()
        isPlaying = false
        playbackState = "error"
        lastError = message
        abandonAudioFocus()
        publish()
        emit("playbackerror")
        stopForeground(false)
        foreground = false
    }

    private fun finishInterval() {
        if (activeEpochStart > 0L) {
            val end = activeEpochStart + maxOf(0L, SystemClock.elapsedRealtime() - activeElapsedStart)
            ListeningJournal.add(this, currentBookId, currentBookTitle, currentJobId, activeEpochStart, end)
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

    private fun emit(type: String) {
        eventSeq++
        // Capture ownership and state before posting to the WebView.
        val data = JSONObject().apply {
            put("type", type); put("state", playbackState); put("jobId", currentJobId)
            put("generation", currentGeneration); put("utteranceId", currentUtteranceId)
            put("queueIndex", currentQueueIndex); put("queueTotal", queueTotalCount)
            put("seq", eventSeq); put("error", lastError)
        }.toString()
        val webView = MainActivity.instance?.currentWebView ?: return
        webView.post { webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('androidttsevent',{detail:" + data + "}));", null) }
    }

    private fun publish(ensureForeground: Boolean = false) {
        val state = when (playbackState) {
            "playing" -> PlaybackState.STATE_PLAYING
            "preparing" -> PlaybackState.STATE_BUFFERING
            "paused" -> PlaybackState.STATE_PAUSED
            "completed", "stopped" -> PlaybackState.STATE_STOPPED
            "error" -> PlaybackState.STATE_ERROR
            else -> PlaybackState.STATE_NONE
        }
        mediaSession?.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE
                or PlaybackState.ACTION_STOP or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
            .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (isPlaying) 1f else 0f)
            .build())
        mediaSession?.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentBookTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, "第 " + (currentQueueIndex + 1) + " 段 / " + queueTotalCount + " 段")
            .build())
        val notification = buildNotification()
        if (ensureForeground && !foreground) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(NOTIFICATION_ID, notification)
            foreground = true
        } else getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        fun actionIntent(action: String, code: Int): PendingIntent =
            PendingIntent.getService(this, code, Intent(this, LindenMediaPlaybackService::class.java).setAction(action), flags)
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), flags)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        val pause = wantsPlayback
        return builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentBookTitle.ifBlank { "Linden Leaf" })
            .setContentText("第 " + (currentQueueIndex + 1) + " 段 / " + queueTotalCount + " 段")
            .setContentIntent(open).setOnlyAlertOnce(true).setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC).setCategory(Notification.CATEGORY_TRANSPORT)
            .setOngoing(wantsPlayback)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一段", actionIntent(ACTION_PREV, 1)).build())
            .addAction(Notification.Action.Builder(if (pause) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (pause) "暂停" else "播放", actionIntent(if (pause) ACTION_PAUSE else ACTION_RESUME, 2)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一段", actionIntent(ACTION_NEXT, 3)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "停止", actionIntent(ACTION_STOP, 4)).build())
            .setDeleteIntent(actionIntent(ACTION_STOP, 5))
            .setStyle(Notification.MediaStyle().setMediaSession(mediaSession!!.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    private fun requestAudioFocus(): Boolean {
        val manager = audioManager ?: return false
        return if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener(focusListener, mainHandler).build()
            manager.requestAudioFocus(focusRequest!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            (manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
                == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        else { @Suppress("DEPRECATION") audioManager?.abandonAudioFocus(focusListener) }
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        destroyed = true
        wantsPlayback = false
        runId = null
        finishInterval()
        if (playbackState == "playing" || playbackState == "preparing") {
            playbackState = "stopped"; isPlaying = false; emit("playbackstopped")
        }
        mainHandler.removeCallbacksAndMessages(null)
        tts?.stop(); tts?.shutdown()
        abandonAudioFocus()
        mediaSession?.release()
        try { unregisterReceiver(noisyReceiver) } catch (_: Exception) {}
        if (running === this) { running = null; texts.clear(); utterances.clear() }
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
    @Synchronized fun add(context: Context, bookId: String, title: String, jobId: String, start: Long, end: Long) {
        load(context)
        if (bookId.isBlank() || end <= start) return
        sequence++
        records.add(JSONObject().put("sequence", sequence).put("bookId", bookId).put("bookTitle", title)
            .put("jobId", jobId).put("startMs", start).put("endMs", end))
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
