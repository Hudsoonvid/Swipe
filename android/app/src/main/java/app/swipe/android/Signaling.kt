package app.swipe.android

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** WebSocket connection to the Swipe server (see docs/PROTOCOL.md). */
class Signaling(
    server: String,
    private val onMessage: (JSONObject) -> Unit,
    private val onOpen: () -> Unit,
    private val onClosed: (String) -> Unit,
) {
    private val url = server.replaceFirst(Regex("^http"), "ws") + "/ws"
    private var ws: WebSocket? = null
    @Volatile var isOpen = false
        private set

    fun connect() {
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                isOpen = true
                onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (e: Exception) { return }
                onMessage(msg)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                isOpen = false
                onClosed(reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                isOpen = false
                onClosed(t.message ?: "connection failed")
            }
        })
    }

    fun send(msg: JSONObject) {
        ws?.send(msg.toString())
    }

    fun close() {
        isOpen = false
        ws?.close(1000, "bye")
        ws = null
    }

    companion object {
        val client: OkHttpClient = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build()
    }
}
