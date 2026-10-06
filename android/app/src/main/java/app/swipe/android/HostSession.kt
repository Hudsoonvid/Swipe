package app.swipe.android

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

private const val TAG = "SwipeHost"

/**
 * Sharing side of the protocol (mirror of web/js/host.js): registers with the
 * server, authenticates viewers with SPAKE2 and streams the screen to them.
 * All state is confined to one executor thread.
 */
class HostSession(
    private val prefs: Prefs,
    private val factory: PeerConnectionFactory,
    private val videoTrack: VideoTrack,
    private val listener: Listener,
) {
    interface Listener {
        fun onStatus(status: String, code: String?)
        fun onViewers(viewers: List<String>)
        fun onAuthFailed()
    }

    private val exec = Executors.newSingleThreadScheduledExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var sig: Signaling? = null
    private var stopped = false
    private var retry = 0
    private var ice: List<PeerConnection.IceServer> = emptyList()
    private val viewers = LinkedHashMap<String, ViewerPeer>()

    @Volatile var code: String? = null
        private set
    @Volatile var password: String = prefs.password
    @Volatile var controlAllowed = true

    val control: String
        get() = if (controlAllowed && ControlService.instance != null) "touch" else "none"

    /** Runs on the session thread; ignored once the session has stopped. */
    private fun post(block: () -> Unit) {
        try {
            exec.execute(block)
        } catch (e: RejectedExecutionException) {
        }
    }

    fun start() = post { connect() }

    fun stop() {
        post {
            stopped = true
            viewers.values.toList().forEach { it.close(sayBye = true) }
            sig?.close()
            sig = null
            status("offline")
        }
        exec.shutdown()
    }

    /** Re-announce capabilities (e.g. accessibility service toggled). */
    fun refreshControl() = post {
        sig?.send(JSONObject().put("t", "update").put("control", control))
        val info = infoMessage()
        viewers.values.forEach { it.sendCtrl(info) }
    }

    fun kickAll() = post {
        viewers.values.toList().forEach {
            it.close(sayBye = true)
            sig?.send(JSONObject().put("t", "kick").put("sid", it.sid))
        }
    }

    private fun status(s: String) {
        val c = code
        main.post { listener.onStatus(s, c) }
    }

    private fun emitViewers() {
        val list = viewers.values.filter { it.authed }.map { if (it.state == "connected") it.name else "${it.name} (${it.state})" }
        main.post { listener.onViewers(list) }
    }

    private fun connect() {
        if (stopped) return
        val server = prefs.server
        if (server.isEmpty()) {
            status("noserver")
            return
        }
        status("connecting")
        lateinit var s: Signaling
        s = Signaling(
            server,
            onMessage = { m -> post { if (s === sig) onSignal(m) } },
            onOpen = {
                post {
                    s.send(
                        JSONObject().put("t", "host").put("key", prefs.deviceKey).put("name", prefs.deviceName)
                            .put("platform", "android").put("control", control),
                    )
                }
            },
            onClosed = { post { if (s === sig) onSignalClosed() } },
        )
        sig = s
        s.connect()
    }

    private fun onSignalClosed() {
        sig = null
        if (stopped) return
        viewers.values.toList().filter { !it.connected }.forEach { it.close() }
        status("reconnecting")
        val delay = minOf(1000L shl minOf(retry++, 4), 15_000L)
        try {
            exec.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
        } catch (e: RejectedExecutionException) {
        }
    }

    private fun onSignal(m: JSONObject) {
        when (m.optString("t")) {
            "hosted" -> {
                retry = 0
                code = m.getString("code")
                prefs.lastCode = code!!
                ice = parseIce(m.optJSONArray("ice"))
                status("online")
            }
            "viewer" -> {
                val sid = m.getString("sid")
                viewers[sid] = ViewerPeer(sid)
            }
            "left" -> viewers[m.optString("sid")]?.let {
                it.signalingGone = true
                if (!it.connected) it.close()
            }
            "msg" -> viewers[m.optString("from")]?.onSignal(m.optJSONObject("data") ?: return)
            "error" -> if (m.optString("error") == "replaced") {
                stopped = true
                status("replaced")
            }
        }
    }

    private fun parseIce(arr: JSONArray?): List<PeerConnection.IceServer> {
        if (arr == null) return emptyList()
        val out = ArrayList<PeerConnection.IceServer>()
        for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            val urls = when (val u = s.opt("urls")) {
                is JSONArray -> (0 until u.length()).map { u.getString(it) }
                is String -> listOf(u)
                else -> continue
            }
            if (urls.isEmpty()) continue
            val b = PeerConnection.IceServer.builder(urls)
            if (s.has("username")) b.setUsername(s.getString("username"))
            if (s.has("credential")) b.setPassword(s.getString("credential"))
            out.add(b.createIceServer())
        }
        return out
    }

    fun infoMessage(): JSONObject = JSONObject()
        .put("t", "info")
        .put("name", prefs.deviceName)
        .put("platform", "android")
        .put("control", control)
        .put("screens", JSONArray())
        .put("screen", JSONObject.NULL)

    /** One remote viewer. Only touched on [exec]. */
    private inner class ViewerPeer(val sid: String) {
        var name = "Viewer"
        var state = "auth"
        var authed = false
        var connected = false
        var signalingGone = false
        private var spake: Spake2? = null
        private var channel: SecureChannel? = null
        private var pc: PeerConnection? = null
        private var ctrl: DataChannel? = null
        private var input: DataChannel? = null
        private var restarts = 0

        private fun relay(data: JSONObject) {
            sig?.send(JSONObject().put("t", "msg").put("to", sid).put("data", data))
        }

        private fun authFailed() {
            sig?.send(JSONObject().put("t", "authfail").put("sid", sid))
            main.post { listener.onAuthFailed() }
            close()
        }

        fun onSignal(d: JSONObject) {
            try {
                handle(d)
            } catch (e: Exception) {
                Log.w(TAG, "viewer $sid: ${e.message}")
                close()
            }
        }

        private fun handle(d: JSONObject) {
            when (d.optString("type")) {
                "pake1" -> if (state == "auth") {
                    state = "confirm"
                    val sp = Spake2("host", code ?: return, password)
                    spake = sp
                    val y = sp.start()
                    val confirm = try {
                        sp.finish(d.optString("X"))
                    } catch (e: PakeException) {
                        authFailed()
                        return
                    }
                    relay(JSONObject().put("type", "pake2").put("Y", y).put("confirm", confirm))
                }
                "pake3" -> if (state == "confirm") {
                    val sp = spake ?: return
                    if (!sp.verify(d.optString("confirm"))) {
                        authFailed()
                        return
                    }
                    channel = sp.channel()
                    spake = null
                    authed = true
                    state = "connecting"
                    sig?.send(JSONObject().put("t", "authok").put("sid", sid))
                    emitViewers()
                    startPeer()
                }
                "sec" -> {
                    val ch = channel ?: return
                    onSecure(JSONObject(ch.open(d.getLong("n"), d.getString("c"))))
                }
            }
        }

        private fun secureSend(obj: JSONObject) {
            val ch = channel ?: return
            val sealed = ch.seal(obj.toString())
            relay(JSONObject().put("type", "sec").put("n", sealed.n).put("c", sealed.c))
        }

        private fun startPeer() {
            val config = PeerConnection.RTCConfiguration(ice).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }
            val peer = factory.createPeerConnection(config, observer) ?: run {
                close()
                return
            }
            pc = peer
            val tr = peer.addTransceiver(
                videoTrack,
                RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("screen")),
            )
            preferH264(tr)
            tuneSender(tr.sender)
            ctrl = peer.createDataChannel("ctrl", DataChannel.Init().apply { ordered = true })
            input = peer.createDataChannel("input", DataChannel.Init().apply { ordered = false; maxRetransmits = 0 })
            ctrl?.registerObserver(ChannelObserver(ctrl!!, isCtrl = true))
            input?.registerObserver(ChannelObserver(input!!, isCtrl = false))
            sendOffer(false)
        }

        private fun preferH264(tr: RtpTransceiver) {
            try {
                val caps = factory.getRtpReceiverCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
                fun rank(c: org.webrtc.RtpCapabilities.CodecCapability): Int {
                    val base = when (c.name.uppercase()) {
                        "H264" -> 0
                        "VP8" -> 10
                        "VP9" -> 20
                        "AV1" -> 30
                        else -> 100
                    }
                    if (base != 0) return base
                    val p = c.parameters ?: emptyMap()
                    return (if (p["packetization-mode"] == "1") 0 else 2) + (if (p["profile-level-id"]?.startsWith("42e0") == true) 0 else 1)
                }
                tr.setCodecPreferences(caps.sortedBy { rank(it) })
            } catch (e: Exception) {
                Log.w(TAG, "codec preferences: ${e.message}")
            }
        }

        private fun tuneSender(sender: RtpSender) {
            try {
                val params = sender.parameters
                params.degradationPreference = RtpParameters.DegradationPreference.BALANCED
                for (e in params.encodings) {
                    e.maxBitrateBps = 8_000_000
                    e.maxFramerate = 30
                }
                sender.parameters = params
            } catch (e: Exception) {
                Log.w(TAG, "sender parameters: ${e.message}")
            }
        }

        private fun sendOffer(iceRestart: Boolean) {
            val peer = pc ?: return
            val constraints = MediaConstraints()
            if (iceRestart) constraints.mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
            peer.createOffer(SdpCallbacks(onCreate = { sdp ->
                post {
                    pc?.setLocalDescription(SdpCallbacks(onSet = {
                        post {
                            val local = pc?.localDescription ?: return@post
                            secureSend(JSONObject().put("type", "offer").put("sdp", local.description))
                        }
                    }), sdp)
                }
            }), constraints)
        }

        private fun restartIce() {
            if (signalingGone || sig?.isOpen != true || ++restarts > 3) {
                close()
                return
            }
            state = "reconnecting"
            emitViewers()
            pc?.restartIce()
            sendOffer(true)
        }

        private fun onSecure(m: JSONObject) {
            when (m.optString("type")) {
                "hello" -> {
                    name = m.optString("name", "Viewer").take(64)
                    emitViewers()
                }
                "answer" -> pc?.setRemoteDescription(
                    SdpCallbacks(),
                    SessionDescription(SessionDescription.Type.ANSWER, boostStartBitrate(m.getString("sdp"))),
                )
                "ice" -> {
                    val c = m.optJSONObject("candidate") ?: return
                    pc?.addIceCandidate(IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.optString("candidate")))
                }
                "bye" -> close()
            }
        }

        fun sendCtrl(obj: JSONObject) {
            val ch = ctrl ?: return
            if (ch.state() != DataChannel.State.OPEN) return
            val bytes = obj.toString().toByteArray(StandardCharsets.UTF_8)
            ch.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
        }

        fun close(sayBye: Boolean = false) {
            if (state == "closed") return
            if (sayBye) try {
                secureSend(JSONObject().put("type", "bye"))
            } catch (e: Exception) {
            }
            state = "closed"
            connected = false
            ctrl?.unregisterObserver()
            input?.unregisterObserver()
            ctrl = null
            input = null
            try {
                pc?.dispose()
            } catch (e: Exception) {
            }
            pc = null
            viewers.remove(sid)
            emitViewers()
        }

        private val observer = object : PeerConnection.Observer {
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                post {
                    when (newState) {
                        PeerConnection.PeerConnectionState.CONNECTED -> {
                            connected = true
                            restarts = 0
                            state = "connected"
                            emitViewers()
                        }
                        PeerConnection.PeerConnectionState.FAILED -> restartIce()
                        PeerConnection.PeerConnectionState.CLOSED -> close()
                        else -> {}
                    }
                }
            }

            override fun onIceCandidate(candidate: IceCandidate) {
                post {
                    secureSend(
                        JSONObject().put(
                            "type", "ice",
                        ).put(
                            "candidate",
                            JSONObject().put("candidate", candidate.sdp).put("sdpMid", candidate.sdpMid)
                                .put("sdpMLineIndex", candidate.sdpMLineIndex),
                        ),
                    )
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(channel: DataChannel) {}
            override fun onRenegotiationNeeded() {}
        }

        private inner class ChannelObserver(private val ch: DataChannel, private val isCtrl: Boolean) : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}

            override fun onStateChange() {
                if (isCtrl && ch.state() == DataChannel.State.OPEN) post { sendCtrl(infoMessage()) }
            }

            override fun onMessage(buffer: DataChannel.Buffer) {
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                val evt = try {
                    JSONObject(String(bytes, StandardCharsets.UTF_8))
                } catch (e: Exception) {
                    return
                }
                if (control == "none") return
                val service = ControlService.instance ?: return
                main.post { service.handle(evt) }
            }
        }
    }

    private open class SdpCallbacks(
        private val onCreate: (SessionDescription) -> Unit = {},
        private val onSet: () -> Unit = {},
    ) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) = onCreate(sdp)
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(error: String?) {
            Log.w(TAG, "SDP create failed: $error")
        }

        override fun onSetFailure(error: String?) {
            Log.w(TAG, "SDP set failed: $error")
        }
    }

    companion object {
        /** Same start-bitrate hints as web/js/rtc.js (ignored by non-Chromium peers). */
        fun boostStartBitrate(sdp: String): String =
            Regex("a=fmtp:(\\d+) (.*)\r\n").replace(sdp) { m ->
                val params = m.groupValues[2]
                if (params.contains("apt=") || params.contains("x-google")) m.value
                else "a=fmtp:${m.groupValues[1]} $params;x-google-start-bitrate=3000;x-google-min-bitrate=600;x-google-max-bitrate=8000\r\n"
            }
    }
}
