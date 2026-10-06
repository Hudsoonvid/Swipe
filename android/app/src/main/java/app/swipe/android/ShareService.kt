package app.swipe.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.math.max
import kotlin.math.roundToInt

/** Live sharing state for the UI (main thread only). */
object ShareState {
    var status = "offline"
        private set
    var code: String? = null
        private set
    var viewers: List<String> = emptyList()
        private set
    var error: String? = null
        private set
    private val listeners = LinkedHashSet<() -> Unit>()

    fun listen(l: () -> Unit) = listeners.add(l)
    fun unlisten(l: () -> Unit) = listeners.remove(l)

    fun update(status: String? = null, code: String? = null, viewers: List<String>? = null, error: String? = null) {
        status?.let { this.status = it }
        code?.let { this.code = it }
        viewers?.let { this.viewers = it }
        this.error = error
        listeners.toList().forEach { it() }
    }
}

/**
 * Foreground service that captures the screen (MediaProjection) and runs the
 * [HostSession]. Android requires screen capture to live in a foreground
 * service of type "mediaProjection".
 */
class ShareService : Service(), HostSession.Listener {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: Prefs
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    var session: HostSession? = null
        private set
    private val controlListener: () -> Unit = { main.post { session?.refreshControl() } }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSharing()
                stopSelf()
            }
            ACTION_START -> {
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_DATA)
                }
                // Must be in the foreground before touching MediaProjection.
                goForeground()
                if (data != null && session == null) startSharing(data)
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground() {
        val nm = getSystemService(NotificationManager::class.java)!!
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
        }
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ShareService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        val code = ShareState.code?.let { Codes.formatCode(it) } ?: "…"
        val viewers = ShareState.viewers
        val text = if (viewers.isEmpty()) "Code $code · Password ${Codes.formatPassword(prefs.password)}" else "Connected: ${viewers.joinToString()}"
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_swipe)
            .setContentTitle(if (viewers.isEmpty()) "Sharing is on" else "Your screen is being shared")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun refreshNotification() {
        if (session == null) return
        getSystemService(NotificationManager::class.java)!!.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun startSharing(data: Intent) {
        try {
            if (!webrtcReady) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions(),
                )
                webrtcReady = true
            }
            val eglBase = EglBase.create()
            egl = eglBase
            val f = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, false))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
                .createPeerConnectionFactory()
            factory = f
            val cap = ScreenCapturer(
                data,
                resources.displayMetrics.densityDpi,
                onStopped = { main.post { stopSharing(); stopSelf() } },
            )
            capturer = cap
            val h = SurfaceTextureHelper.create("SwipeCapture", eglBase.eglBaseContext)
            helper = h
            val src = f.createVideoSource(true)
            source = src
            cap.initialize(h, applicationContext, src.capturerObserver)
            val (w, ht) = captureSize()
            cap.startCapture(w, ht, 30)
            val t = f.createVideoTrack("screen0", src)
            track = t
            session = HostSession(prefs, f, t, this).also { it.start() }
            ControlService.listeners.add(controlListener)
        } catch (e: Exception) {
            Log.e("SwipeShare", "could not start sharing", e)
            ShareState.update(status = "offline", error = e.message ?: "Could not start screen capture")
            stopSharing()
            stopSelf()
        }
    }

    /** Screen size scaled so the long side is at most 1600 px (multiples of 16). */
    private fun captureSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val (w, h) = if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            dm.widthPixels to dm.heightPixels
        }
        val scale = minOf(1.0, 1600.0 / max(w, h))
        fun even16(v: Double) = max(16, (v / 16).roundToInt() * 16)
        return even16(w * scale) to even16(h * scale)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val (w, h) = captureSize()
        capturer?.resize(w, h)
    }

    fun setPassword(pw: String) {
        prefs.password = pw
        session?.password = Codes.normalizePassword(pw)
        refreshNotification()
    }

    private fun stopSharing() {
        ControlService.listeners.remove(controlListener)
        session?.stop()
        session = null
        try {
            capturer?.stopCapture()
        } catch (e: Exception) {
        }
        capturer = null
        track?.dispose()
        track = null
        source?.dispose()
        source = null
        helper?.dispose()
        helper = null
        factory?.dispose()
        factory = null
        egl?.release()
        egl = null
        ShareState.update(status = "offline", viewers = emptyList(), error = ShareState.error)
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    }

    override fun onDestroy() {
        stopSharing()
        if (instance === this) instance = null
        super.onDestroy()
    }

    // HostSession.Listener (main thread)
    override fun onStatus(status: String, code: String?) {
        ShareState.update(status = status, code = code)
        refreshNotification()
    }

    override fun onViewers(viewers: List<String>) {
        ShareState.update(viewers = viewers)
        refreshNotification()
    }

    override fun onAuthFailed() {
        ShareState.update(error = "Someone tried to connect with a wrong password")
    }

    companion object {
        const val ACTION_START = "app.swipe.android.START"
        const val ACTION_STOP = "app.swipe.android.STOP"
        const val EXTRA_DATA = "projection"
        private const val CHANNEL = "sharing"
        private const val NOTIFICATION_ID = 1
        private var webrtcReady = false

        @Volatile
        var instance: ShareService? = null
            private set
    }
}
