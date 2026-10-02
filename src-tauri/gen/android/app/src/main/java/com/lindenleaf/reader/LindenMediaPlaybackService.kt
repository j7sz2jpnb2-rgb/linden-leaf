package com.lindenleaf.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.util.Locale

class LindenMediaPlaybackService : Service(), TextToSpeech.OnInitListener {

    companion object {
        const val CHANNEL_ID = "ll_media_playback"
        const val NOTIFICATION_ID = 1001

        const val ACTION_PLAY = "com.lindenleaf.reader.ACTION_PLAY"
        const val ACTION_PAUSE = "com.lindenleaf.reader.ACTION_PAUSE"
        const val ACTION_RESUME = "com.lindenleaf.reader.ACTION_RESUME"
        const val ACTION_STOP = "com.lindenleaf.reader.ACTION_STOP"
        const val ACTION_NEXT = "com.lindenleaf.reader.ACTION_NEXT"
        const val ACTION_PREV = "com.lindenleaf.reader.ACTION_PREV"

        const val EXTRA_BOOK_TITLE = "extra_book_title"
        const val EXTRA_TEXT = "extra_text"
        const val EXTRA_RATE = "extra_rate"
        const val EXTRA_JOB_ID = "extra_job_id"
        const val EXTRA_UTTERANCE_ID = "extra_utterance_id"
        const val EXTRA_GENERATION = "extra_generation"

        var isPlaying: Boolean = false
            private set
        var playbackState: String = "idle" // "idle", "preparing", "playing", "paused", "completed", "error", "stopped"
            private set
        var currentBookTitle: String = "Linden Leaf 朗读"
            private set
        var currentText: String = ""
            private set
        var currentJobId: String = ""
            private set
        var currentUtteranceId: String = ""
            private set
        var currentGeneration: Long = 0L
            private set
        var completedUtteranceId: String = ""
            private set
        var completedGeneration: Long = 0L
            private set
        var currentRate: Float = 1.0f
            private set
        var lastError: String = ""
            private set
        var eventSeq: Long = 0L
            private set

        fun startSpeaking(
            context: Context,
            bookTitle: String,
            text: String,
            rate: Float = 1.0f,
            jobId: String = "",
            utteranceId: String = "",
            generation: Long = 0L
        ) {
            val intent = Intent(context, LindenMediaPlaybackService::class.java).apply {
                action = ACTION_PLAY
                putExtra(EXTRA_BOOK_TITLE, bookTitle)
                putExtra(EXTRA_TEXT, text)
                putExtra(EXTRA_RATE, rate)
                putExtra(EXTRA_JOB_ID, jobId)
                putExtra(EXTRA_UTTERANCE_ID, utteranceId)
                putExtra(EXTRA_GENERATION, generation)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun pause(context: Context) {
            val intent = Intent(context, LindenMediaPlaybackService::class.java).apply {
                action = ACTION_PAUSE
            }
            context.startService(intent)
        }

        fun resume(context: Context) {
            val intent = Intent(context, LindenMediaPlaybackService::class.java).apply {
                action = ACTION_RESUME
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, LindenMediaPlaybackService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingSpeakText: String? = null
    private var pendingRate: Float = 1.0f

    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        tts = TextToSpeech(applicationContext, this)
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = true
            tts?.language = Locale.CHINESE
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    isPlaying = true
                    playbackState = "playing"
                    eventSeq++
                    updateNotification(currentBookTitle, currentText, isPlaying = true)
                    dispatchJsEvent("playbackstarted", utteranceId)
                }

                override fun onDone(utteranceId: String?) {
                    isPlaying = false
                    playbackState = "completed"
                    completedUtteranceId = utteranceId ?: currentUtteranceId
                    completedGeneration = currentGeneration
                    eventSeq++
                    updateNotification(currentBookTitle, currentText, isPlaying = false)
                    dispatchJsEvent("playbackcompleted", utteranceId)
                }

                override fun onError(utteranceId: String?) {
                    isPlaying = false
                    playbackState = "error"
                    lastError = "TTS引擎播报失败"
                    eventSeq++
                    updateNotification(currentBookTitle, "朗读出错", isPlaying = false)
                    dispatchJsEvent("playbackerror", utteranceId)
                }
            })

            pendingSpeakText?.let { text ->
                speakText(text, pendingRate)
                pendingSpeakText = null
            }
        } else {
            ttsReady = false
            playbackState = "error"
            lastError = "TTS引擎初始化失败"
        }
    }

    private fun dispatchJsEvent(type: String, utteranceId: String?) {
        MainActivity.instance?.currentWebView?.post {
            val js = """
                window.dispatchEvent(new CustomEvent('androidttsevent', {
                    detail: {
                        type: '$type',
                        state: '$playbackState',
                        jobId: '$currentJobId',
                        utteranceId: '${utteranceId ?: currentUtteranceId}',
                        generation: $currentGeneration,
                        seq: $eventSeq
                    }
                }));
            """.trimIndent()
            MainActivity.instance?.currentWebView?.evaluateJavascript(js, null)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> {
                val bookTitle = intent.getStringExtra(EXTRA_BOOK_TITLE) ?: "Linden Leaf 朗读"
                val text = intent.getStringExtra(EXTRA_TEXT) ?: ""
                val rate = intent.getFloatExtra(EXTRA_RATE, 1.0f)
                val jobId = intent.getStringExtra(EXTRA_JOB_ID) ?: ""
                val utteranceId = intent.getStringExtra(EXTRA_UTTERANCE_ID) ?: ""
                val generation = intent.getLongExtra(EXTRA_GENERATION, 0L)

                currentBookTitle = bookTitle
                currentText = text
                currentRate = rate
                currentJobId = jobId
                currentUtteranceId = utteranceId
                currentGeneration = generation
                playbackState = "preparing"
                eventSeq++

                startForegroundServiceWithNotification(bookTitle, text)
                requestAudioFocus()
                if (ttsReady) {
                    speakText(text, rate)
                } else {
                    pendingSpeakText = text
                    pendingRate = rate
                }
            }
            ACTION_PAUSE -> {
                tts?.stop()
                isPlaying = false
                playbackState = "paused"
                eventSeq++
                updateNotification(currentBookTitle, currentText, isPlaying = false)
                dispatchJsEvent("playbackpaused", currentUtteranceId)
            }
            ACTION_RESUME -> {
                if (currentText.isNotEmpty()) {
                    requestAudioFocus()
                    playbackState = "preparing"
                    eventSeq++
                    speakText(currentText, currentRate)
                }
            }
            ACTION_STOP -> {
                tts?.stop()
                isPlaying = false
                playbackState = "stopped"
                eventSeq++
                abandonAudioFocus()
                dispatchJsEvent("playbackstopped", currentUtteranceId)
                stopForeground(true)
                stopSelf()
            }
            ACTION_NEXT -> {
                MainActivity.instance?.currentWebView?.post {
                    MainActivity.instance?.currentWebView?.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('androidmedianext'));",
                        null
                    )
                }
            }
            ACTION_PREV -> {
                MainActivity.instance?.currentWebView?.post {
                    MainActivity.instance?.currentWebView?.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('androidmediaprev'));",
                        null
                    )
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun speakText(text: String, rate: Float) {
        tts?.setSpeechRate(rate)
        val uttId = if (currentUtteranceId.isNotEmpty()) currentUtteranceId else "ll_utt_${System.currentTimeMillis()}"
        val params = android.os.Bundle()
        params.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, uttId)
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, uttId)
    }

    private fun startForegroundServiceWithNotification(title: String, text: String) {
        val notification = buildNotification(title, text, isPlaying = true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(title: String, text: String, isPlaying: Boolean) {
        val notification = buildNotification(title, text, isPlaying)
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(title: String, text: String, isPlaying: Boolean): Notification {
        val contentIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pContentIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevIntent = Intent(this, LindenMediaPlaybackService::class.java).apply { action = ACTION_PREV }
        val pPrevIntent = PendingIntent.getService(this, 10, prevIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val toggleActionIntent = Intent(this, LindenMediaPlaybackService::class.java).apply {
            action = if (isPlaying) ACTION_PAUSE else ACTION_RESUME
        }
        val pToggleIntent = PendingIntent.getService(
            this, 1, toggleActionIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val nextIntent = Intent(this, LindenMediaPlaybackService::class.java).apply { action = ACTION_NEXT }
        val pNextIntent = PendingIntent.getService(this, 11, nextIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val stopIntent = Intent(this, LindenMediaPlaybackService::class.java).apply {
            action = ACTION_STOP
        }
        val pStopIntent = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val preview = if (text.length > 80) text.take(80) + "..." else text

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(preview)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(pContentIntent)
            .setOngoing(isPlaying)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "上一段", pPrevIntent)
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (isPlaying) "暂停" else "继续",
                pToggleIntent
            )
            .addAction(android.R.drawable.ic_media_next, "下一段", pNextIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", pStopIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Linden Leaf 后台朗读播放",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "通知栏有声朗读控制"
                setShowBadge(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun requestAudioFocus() {
        if (audioManager == null) return
        val playbackAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(playbackAttributes)
                .setOnAudioFocusChangeListener { focusChange ->
                    when (focusChange) {
                        AudioManager.AUDIOFOCUS_LOSS -> {
                            stop(this)
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                            pause(this)
                        }
                    }
                }
                .build()
            audioManager?.requestAudioFocus(focusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                { focusChange ->
                    if (focusChange == AudioManager.AUDIOFOCUS_LOSS) stop(this)
                    else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause(this)
                },
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(null)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        abandonAudioFocus()
        super.onDestroy()
    }
}
