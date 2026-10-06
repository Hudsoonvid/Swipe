package app.swipe.android

import android.content.Context
import android.os.Build
import java.security.SecureRandom
import java.util.Base64

/** Persistent settings: server address, device identity and password. */
class Prefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("swipe", Context.MODE_PRIVATE)

    var server: String
        get() = (prefs.getString("server", null) ?: BuildConfig.DEFAULT_SERVER).trim().trimEnd('/')
        set(v) = prefs.edit().putString("server", v.trim().trimEnd('/')).apply()

    var deviceName: String
        get() = prefs.getString("name", null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(v) = prefs.edit().putString("name", v.trim()).apply()

    /** Random secret that gives this phone a stable code on the server. */
    val deviceKey: String
        get() {
            prefs.getString("deviceKey", null)?.let { return it }
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val key = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            prefs.edit().putString("deviceKey", key).apply()
            return key
        }

    var password: String
        get() = prefs.getString("password", null) ?: Codes.generatePassword().also { password = it }
        set(v) = prefs.edit().putString("password", Codes.normalizePassword(v)).apply()

    var lastCode: String
        get() = prefs.getString("code", "") ?: ""
        set(v) = prefs.edit().putString("code", v).apply()

    private fun defaultName(): String {
        val model = Build.MODEL ?: "Android"
        val maker = Build.MANUFACTURER ?: ""
        return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim()
    }
}
