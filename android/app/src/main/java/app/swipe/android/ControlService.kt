package app.swipe.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

/**
 * Performs remote input on this phone: taps, swipes, system navigation and
 * typing into the focused text field. Android only allows this through an
 * accessibility service, which the user must switch on in Settings.
 */
class ControlService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
        listeners.forEach { it() }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        listeners.forEach { it() }
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    /** Real display size in pixels (what screen capture records). */
    private fun screenSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.currentWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            dm.widthPixels to dm.heightPixels
        }
    }

    /** Handles an input event from a viewer (normalized 0..1 coordinates). */
    fun handle(evt: JSONObject) {
        when (evt.optString("t")) {
            "gesture" -> gesture(evt)
            "scroll" -> scroll(evt)
            "nav" -> nav(evt.optString("a"))
            "tx" -> typeText(evt.optString("text"))
            "kd" -> key(evt.optString("code"), evt.optString("key"))
        }
    }

    private fun gesture(evt: JSONObject) {
        val pts = evt.optJSONArray("pts") ?: return
        if (pts.length() == 0) return
        val (w, h) = screenSize()
        val path = Path()
        var last = 0L
        var minX = Float.MAX_VALUE
        var maxX = -Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxY = -Float.MAX_VALUE
        for (i in 0 until pts.length()) {
            val p = pts.optJSONArray(i) ?: continue
            val x = (p.optDouble(0).coerceIn(0.0, 1.0) * (w - 1)).toFloat()
            val y = (p.optDouble(1).coerceIn(0.0, 1.0) * (h - 1)).toFloat()
            last = max(last, p.optLong(2))
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
        val moved = maxX - minX > 12 || maxY - minY > 12
        // A short touch without movement is a tap; a long one a long press.
        val duration = when {
            !moved && last < 400 -> 40L
            else -> last.coerceIn(40L, GestureDescription.getMaxGestureDuration())
        }
        dispatch(path, duration)
    }

    private fun scroll(evt: JSONObject) {
        val (w, h) = screenSize()
        val density = resources.displayMetrics.density
        val x = (evt.optDouble("x", 0.5).coerceIn(0.0, 1.0) * w).toFloat()
        val y = (evt.optDouble("y", 0.5).coerceIn(0.0, 1.0) * h).toFloat()
        // Wheel "down" moves content up: the finger travels upwards.
        val dx = (evt.optDouble("dx") * density * 1.5).toFloat().coerceIn(-w * 0.45f, w * 0.45f)
        val dy = (evt.optDouble("dy") * density * 1.5).toFloat().coerceIn(-h * 0.45f, h * 0.45f)
        val path = Path().apply {
            moveTo(x.coerceIn(1f, w - 2f), y.coerceIn(1f, h - 2f))
            lineTo((x - dx).coerceIn(1f, w - 2f), (y - dy).coerceIn(1f, h - 2f))
        }
        dispatch(path, 120)
    }

    private fun dispatch(path: Path, durationMs: Long) {
        try {
            val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
            dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
        } catch (e: IllegalArgumentException) {
            // invalid path (e.g. off-screen); ignore
        }
    }

    private fun nav(action: String) {
        val a = when (action) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            else -> return
        }
        performGlobalAction(a)
    }

    private fun focusedField(): AccessibilityNodeInfo? {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        return if (node.isEditable) node else null
    }

    /** Inserts text at the cursor of the focused field. */
    private fun typeText(text: String) {
        if (text.isEmpty()) return
        val node = focusedField() ?: return
        val current = if (Build.VERSION.SDK_INT >= 26 && node.isShowingHintText) "" else node.text?.toString() ?: ""
        var start = node.textSelectionStart
        var end = node.textSelectionEnd
        if (start < 0 || start > current.length) start = current.length
        if (end < start || end > current.length) end = start
        setText(node, current.substring(0, start) + text + current.substring(end), start + text.length)
    }

    private fun key(code: String, key: String) {
        when (if (code.isNotEmpty()) code else key) {
            "Backspace" -> {
                val node = focusedField() ?: return
                val current = if (Build.VERSION.SDK_INT >= 26 && node.isShowingHintText) "" else node.text?.toString() ?: ""
                var start = node.textSelectionStart
                var end = node.textSelectionEnd
                if (start < 0 || start > current.length) start = current.length
                if (end < start || end > current.length) end = start
                if (start == end && start > 0) start--
                if (start == end) return
                setText(node, current.substring(0, start) + current.substring(end), start)
            }
            "Enter", "NumpadEnter" -> {
                val node = focusedField() ?: return
                if (Build.VERSION.SDK_INT >= 30) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                } else {
                    typeText("\n")
                }
            }
            "Escape" -> performGlobalAction(GLOBAL_ACTION_BACK)
        }
    }

    private fun setText(node: AccessibilityNodeInfo, value: String, cursor: Int) {
        node.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) },
        )
        node.performAction(
            AccessibilityNodeInfo.ACTION_SET_SELECTION,
            Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
            },
        )
    }

    companion object {
        @Volatile
        var instance: ControlService? = null
            private set

        /** Called when the service connects or disconnects. */
        val listeners = mutableListOf<() -> Unit>()

        fun isEnabled(context: Context): Boolean {
            if (instance != null) return true
            val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return enabled.split(':').any { it.endsWith("/" + ControlService::class.java.name) || it.endsWith("/.ControlService") }
        }
    }
}
