package app.swipe.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.ThreadUtils
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/**
 * Screen capturer for WebRTC built on MediaProjection.
 *
 * Unlike org.webrtc.ScreenCapturerAndroid it resizes the existing virtual
 * display when the phone rotates: Android 14+ forbids creating a second
 * virtual display from the same MediaProjection.
 */
class ScreenCapturer(
    private val permissionData: Intent,
    private val densityDpi: Int,
    private val onStopped: () -> Unit,
    private val onContentResized: ((Int, Int) -> Unit)? = null,
) : VideoCapturer, VideoSink {
    private var helper: SurfaceTextureHelper? = null
    private var context: Context? = null
    private var observer: CapturerObserver? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var width = 0
    private var height = 0

    override fun initialize(helper: SurfaceTextureHelper, context: Context, observer: CapturerObserver) {
        this.helper = helper
        this.context = context
        this.observer = observer
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        val helper = helper ?: throw IllegalStateException("not initialized")
        this.width = width
        this.height = height
        val mpm = context!!.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mp = mpm.getMediaProjection(Activity.RESULT_OK, permissionData)
            ?: throw IllegalStateException("screen capture permission was not granted")
        projection = mp
        // Must be registered before createVirtualDisplay on Android 14+.
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() = onStopped()

            override fun onCapturedContentResize(width: Int, height: Int) {
                onContentResized?.invoke(width, height)
            }
        }, helper.handler)
        helper.setTextureSize(width, height)
        display = mp.createVirtualDisplay(
            "SwipeScreen", width, height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            Surface(helper.surfaceTexture), null, null,
        )
        observer?.onCapturerStarted(true)
        helper.startListening(this)
    }

    /** Changes the output size (e.g. after rotation) without a new display. */
    fun resize(width: Int, height: Int) {
        val helper = helper ?: return
        helper.handler.post {
            if (display == null || (width == this.width && height == this.height)) return@post
            this.width = width
            this.height = height
            helper.setTextureSize(width, height)
            display?.resize(width, height, densityDpi)
        }
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) = resize(width, height)

    override fun onFrame(frame: VideoFrame) {
        observer?.onFrameCaptured(frame)
    }

    override fun stopCapture() {
        val helper = helper ?: return
        ThreadUtils.invokeAtFrontUninterruptibly(helper.handler) {
            helper.stopListening()
            observer?.onCapturerStopped()
            display?.release()
            display = null
            projection?.stop()
            projection = null
        }
    }

    override fun dispose() {}

    override fun isScreencast(): Boolean = true
}
