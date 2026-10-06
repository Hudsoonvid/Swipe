package app.swipe.android

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

/** Home screen: share this phone, or open the viewer to control another device. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var codeView: TextView
    private lateinit var pwView: TextView
    private lateinit var statusView: TextView
    private lateinit var viewersView: TextView
    private lateinit var qrView: ImageView
    private lateinit var shareButton: Button
    private lateinit var controlView: TextView
    private lateinit var controlButton: Button
    private lateinit var serverInput: EditText
    private lateinit var nameInput: EditText
    private val stateListener: () -> Unit = { render() }

    private val accent = Color.parseColor("#4C8DFF")
    private val card = Color.parseColor("#161C28")
    private val muted = Color.parseColor("#8F9BB0")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        window.statusBarColor = Color.parseColor("#0B0E14")
        setContentView(buildUi())
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
        }
    }

    override fun onResume() {
        super.onResume()
        ShareState.listen(stateListener)
        ShareService.instance?.session?.refreshControl()
        fetchCode()
        render()
    }

    override fun onPause() {
        ShareState.unlisten(stateListener)
        super.onPause()
    }

    // ---------- UI ----------

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(size: Float, color: Int = Color.WHITE, bold: Boolean = false, mono: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        typeface = Typeface.create(if (mono) Typeface.MONOSPACE else Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
    }

    private fun button(label: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(if (primary) accent else Color.parseColor("#232B3B"))
        }
        setOnClickListener { onClick() }
    }

    private fun cardLayout(title: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(18), dp(18), dp(18))
        background = GradientDrawable().apply {
            cornerRadius = dp(16).toFloat()
            setColor(card)
        }
        addView(text(20f, bold = true).apply { this.text = title })
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(14) }
    }

    private fun LinearLayout.gap(h: Int) = addView(View(context), LinearLayout.LayoutParams(1, dp(h)))

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        root.addView(text(28f, bold = true).apply { text = "Swipe" })

        // Share card
        val share = cardLayout("Share this phone")
        share.addView(text(13f, muted).apply { text = "YOUR CODE" })
        codeView = text(32f, bold = true, mono = true)
        share.addView(codeView)
        share.gap(8)
        share.addView(text(13f, muted).apply { text = "PASSWORD" })
        pwView = text(28f, bold = true, mono = true)
        share.addView(pwView)
        val pwRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        pwRow.addView(button("New password") { setPassword(Codes.generatePassword()) })
        pwRow.addView(View(this), LinearLayout.LayoutParams(dp(8), 1))
        pwRow.addView(button("Set…") { askPassword() })
        pwRow.addView(View(this), LinearLayout.LayoutParams(dp(8), 1))
        pwRow.addView(button("Copy code") { copyCode() })
        share.addView(pwRow)
        share.gap(10)
        statusView = text(15f, bold = true)
        share.addView(statusView)
        viewersView = text(14f, muted)
        share.addView(viewersView)
        share.gap(10)
        qrView = ImageView(this).apply { adjustViewBounds = true }
        share.addView(qrView, LinearLayout.LayoutParams(dp(220), dp(220)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        share.addView(text(12f, muted).apply {
            text = "Scan with another device's camera to connect instantly (contains the password)."
            gravity = Gravity.CENTER
        })
        share.gap(12)
        shareButton = button("Start sharing", primary = true) { toggleSharing() }
        share.addView(shareButton, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)))
        share.gap(14)
        controlView = text(14f, muted)
        share.addView(controlView)
        controlButton = button("Turn on remote control") { openAccessibilitySettings() }
        share.addView(controlButton)
        root.addView(share)

        // Viewer card
        val view = cardLayout("Connect to another device")
        view.addView(text(14f, muted).apply { text = "See and control a computer, tablet or phone that is sharing." })
        view.gap(10)
        view.addView(button("Open viewer", primary = true) { openViewer() }, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)))
        root.addView(view)

        // Settings card
        val settings = cardLayout("Settings")
        settings.addView(text(13f, muted).apply { text = "Server address" })
        serverInput = EditText(this).apply {
            setText(prefs.server)
            hint = "https://swipe.example.com"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.WHITE)
            setHintTextColor(muted)
        }
        settings.addView(serverInput)
        settings.addView(text(13f, muted).apply { text = "This phone's name" })
        nameInput = EditText(this).apply {
            setText(prefs.deviceName)
            setTextColor(Color.WHITE)
        }
        settings.addView(nameInput)
        settings.addView(button("Save") { saveSettings() })
        root.addView(settings)

        root.addView(text(12f, muted).apply {
            text = "Connections are end-to-end encrypted. The server never sees your password or your screen."
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, 0)
        })

        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0B0E14"))
            addView(root)
            fitsSystemWindows = true
        }
        return scroll
    }

    private fun render() {
        val code = ShareState.code ?: prefs.lastCode.takeIf { it.isNotEmpty() }
        codeView.text = code?.let { Codes.formatCode(it) } ?: "··· ··· ···"
        pwView.text = Codes.formatPassword(prefs.password)
        val sharing = ShareService.instance?.session != null
        shareButton.text = if (sharing) "Stop sharing" else "Start sharing"
        val viewers = ShareState.viewers
        statusView.text = when {
            !sharing -> "Not sharing"
            ShareState.status == "online" && viewers.isEmpty() -> "Waiting for a device to connect"
            viewers.isNotEmpty() -> "${viewers.size} device${if (viewers.size > 1) "s" else ""} connected"
            ShareState.status == "reconnecting" -> "Reconnecting to the server…"
            ShareState.status == "noserver" -> "Enter the server address below"
            ShareState.status == "replaced" -> "Sharing moved to another device or app"
            else -> "Connecting…"
        }
        viewersView.text = viewers.joinToString("\n")
        ShareState.error?.let { Toast.makeText(this, it, Toast.LENGTH_LONG).show() }
        val controlOn = ControlService.isEnabled(this)
        controlView.text = if (controlOn) {
            "Remote control: on. Connected devices can tap, swipe and type on this phone."
        } else {
            "Remote control: off. Others can only watch. Turn it on to let them tap, swipe and type." +
                if (Build.VERSION.SDK_INT >= 33) "\nIf Android says the setting is restricted: App info → ⋮ → Allow restricted settings." else ""
        }
        controlButton.visibility = if (controlOn) View.GONE else View.VISIBLE
        renderQr(code)
    }

    private fun renderQr(code: String?) {
        val server = prefs.server
        if (code == null || server.isEmpty()) {
            qrView.setImageBitmap(null)
            return
        }
        val link = "$server/#c=$code&p=${Uri.encode(prefs.password)}"
        val size = 512
        val matrix = QRCodeWriter().encode(link, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
        val pixels = IntArray(size * size) { if (matrix[it % size, it / size]) Color.BLACK else Color.WHITE }
        qrView.setImageBitmap(Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888))
    }

    // ---------- actions ----------

    private fun toggleSharing() {
        if (ShareService.instance?.session != null) {
            startService(Intent(this, ShareService::class.java).setAction(ShareService.ACTION_STOP))
            render()
            return
        }
        if (prefs.server.isEmpty()) {
            Toast.makeText(this, "Enter your Swipe server address first", Toast.LENGTH_LONG).show()
            serverInput.requestFocus()
            return
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)!!
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "Screen sharing was not allowed", Toast.LENGTH_SHORT).show()
            return
        }
        startForegroundService(
            Intent(this, ShareService::class.java).setAction(ShareService.ACTION_START).putExtra(ShareService.EXTRA_DATA, data),
        )
        render()
    }

    private fun setPassword(pw: String) {
        val service = ShareService.instance
        if (service != null) service.setPassword(pw) else prefs.password = pw
        render()
        Toast.makeText(this, "Password changed. Devices already connected stay connected.", Toast.LENGTH_SHORT).show()
    }

    private fun askPassword() {
        val input = EditText(this).apply {
            hint = "At least 4 characters"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        AlertDialog.Builder(this)
            .setTitle("Set a password")
            .setMessage("Not case-sensitive. Use 8+ characters for access over the internet.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val pw = Codes.normalizePassword(input.text.toString())
                if (pw.length < 4) Toast.makeText(this, "Use at least 4 characters", Toast.LENGTH_SHORT).show() else setPassword(pw)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun copyCode() {
        val code = codeView.text.toString()
        getSystemService(ClipboardManager::class.java)!!.setPrimaryClip(ClipData.newPlainText("Swipe code", code))
        Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
    }

    private fun openAccessibilitySettings() {
        Toast.makeText(this, "Find \"Swipe remote control\" and turn it on", Toast.LENGTH_LONG).show()
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun openViewer() {
        if (prefs.server.isEmpty()) {
            Toast.makeText(this, "Enter your Swipe server address first", Toast.LENGTH_LONG).show()
            serverInput.requestFocus()
            return
        }
        startActivity(Intent(this, ViewerActivity::class.java))
    }

    private fun saveSettings() {
        val server = serverInput.text.toString().trim().trimEnd('/')
        if (server.isNotEmpty() && !Regex("^https?://\\S+$").matches(server)) {
            Toast.makeText(this, "The address must start with https://", Toast.LENGTH_LONG).show()
            return
        }
        prefs.server = server
        prefs.deviceName = nameInput.text.toString()
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        fetchCode()
        render()
    }

    /** Learns this phone's code before sharing starts. */
    private fun fetchCode() {
        val server = prefs.server
        if (server.isEmpty() || ShareState.code != null) return
        val body = JSONObject().put("key", prefs.deviceKey).toString().toRequestBody("application/json".toMediaType())
        Signaling.client.newCall(Request.Builder().url("$server/api/code").post(body).build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val code = try {
                        JSONObject(it.body?.string() ?: "").optString("code")
                    } catch (e: Exception) {
                        ""
                    }
                    if (code.matches(Regex("\\d{9}"))) runOnUiThread {
                        prefs.lastCode = code
                        render()
                    }
                }
            }
        })
    }

    companion object {
        private const val REQ_CAPTURE = 1
    }
}
