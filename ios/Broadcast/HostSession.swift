import CoreMedia
import Foundation
import ReplayKit
import SwipeCore
import WebRTC

/// Sharing side of the protocol (mirror of web/js/host.js) running inside the
/// broadcast upload extension. iOS does not let apps inject touches, so
/// viewers can watch but not control ("control": "none").
final class HostSession: NSObject {
    private let settings = SharedSettings()
    private let queue = DispatchQueue(label: "swipe.host")
    private let factory: RTCPeerConnectionFactory
    private let source: RTCVideoSource
    private let capturer: RTCVideoCapturer
    private let track: RTCVideoTrack
    private var sig: Signaling?
    private var stopped = false
    private var retry = 0
    private var iceServers: [RTCIceServer] = []
    private var viewers: [String: ViewerPeer] = [:]
    private var code: String?
    /// Read on the ReplayKit thread; frames are dropped while nobody watches.
    private let watching = ManagedFlag()

    override init() {
        _ = RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
        source = factory.videoSource(forScreenCast: true)
        // Keeps memory well inside the 50 MB extension limit and the
        // encoder fast: at most ~1440 px on the long side, 30 fps.
        capturer = RTCVideoCapturer(delegate: source)
        track = factory.videoTrack(with: source, trackId: "screen0")
        super.init()
    }

    func start() {
        queue.async { self.connect() }
    }

    func stop() {
        queue.sync {
            stopped = true
            for v in Array(viewers.values) { v.close(sayBye: true) }
            sig?.close()
            sig = nil
            settings.status = "offline"
            settings.viewers = []
        }
    }

    // MARK: frames from ReplayKit

    private var lastSize = CGSize.zero

    func capture(_ sampleBuffer: CMSampleBuffer) {
        guard watching.value, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        var rotation = RTCVideoRotation._0
        if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value) {
            switch orientation {
            case .left, .leftMirrored: rotation = ._90
            case .right, .rightMirrored: rotation = ._270
            case .down, .downMirrored: rotation = ._180
            default: rotation = ._0
            }
        }
        let size = CGSize(width: width, height: height)
        if size != lastSize {
            lastSize = size
            let scale = min(1.0, 1440.0 / Double(max(width, height)))
            source.adaptOutputFormat(toWidth: Int32(Double(width) * scale), height: Int32(Double(height) * scale), fps: 30)
        }
        let ts = Int64(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1_000_000_000)
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixelBuffer), rotation: rotation, timeStampNs: ts)
        source.capturer(capturer, didCapture: frame)
    }

    // MARK: signaling

    private func connect() {
        guard !stopped else { return }
        let server = settings.server
        guard !server.isEmpty, let s = Signaling(server: server) else {
            settings.status = "noserver"
            return
        }
        settings.status = "connecting"
        s.onOpen = { [weak self, weak s] in
            guard let self = self, let s = s else { return }
            self.queue.async {
                s.send([
                    "t": "host", "key": self.settings.deviceKey, "name": self.settings.deviceName,
                    "platform": self.settings.platform, "control": "none",
                ])
            }
        }
        s.onMessage = { [weak self, weak s] msg in
            self?.queue.async { if let s = s, s === self?.sig { self?.onSignal(msg) } }
        }
        s.onClose = { [weak self, weak s] _ in
            self?.queue.async { if let s = s, s === self?.sig { self?.onSignalClosed() } }
        }
        sig = s
        s.connect()
    }

    private func onSignalClosed() {
        sig = nil
        guard !stopped else { return }
        for v in Array(viewers.values) where !v.connected { v.close() }
        settings.status = "reconnecting"
        let delay = min(Double(1 << min(retry, 4)), 15)
        retry += 1
        queue.asyncAfter(deadline: .now() + delay) { self.connect() }
    }

    private func onSignal(_ m: [String: Any]) {
        switch (m["t"] as? String) ?? "" {
        case "hosted":
            retry = 0
            code = m["code"] as? String
            settings.code = code ?? ""
            iceServers = parseIce(m["ice"] as? [[String: Any]] ?? [])
            settings.status = "online"
        case "viewer":
            if let sid = m["sid"] as? String { viewers[sid] = ViewerPeer(host: self, sid: sid) }
        case "left":
            if let sid = m["sid"] as? String, let v = viewers[sid] {
                v.signalingGone = true
                if !v.connected { v.close() }
            }
        case "msg":
            if let from = m["from"] as? String, let data = m["data"] as? [String: Any] { viewers[from]?.onSignal(data) }
        case "error":
            if m["error"] as? String == "replaced" {
                stopped = true
                settings.status = "replaced"
            }
        default:
            break
        }
    }

    private func parseIce(_ list: [[String: Any]]) -> [RTCIceServer] {
        list.compactMap { s in
            let urls: [String]
            if let u = s["urls"] as? [String] { urls = u } else if let u = s["urls"] as? String { urls = [u] } else { return nil }
            guard !urls.isEmpty else { return nil }
            return RTCIceServer(urlStrings: urls, username: s["username"] as? String, credential: s["credential"] as? String)
        }
    }

    fileprivate func emitViewers() {
        let list = viewers.values.filter { $0.authed }.map { $0.state == "connected" ? $0.name : "\($0.name) (\($0.state))" }
        settings.viewers = list
        watching.value = viewers.values.contains { $0.authed }
    }

    fileprivate func infoMessage() -> [String: Any] {
        ["t": "info", "name": settings.deviceName, "platform": settings.platform, "control": "none", "screens": [], "screen": NSNull()]
    }

    // MARK: per-viewer peer

    fileprivate final class ViewerPeer: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
        unowned let host: HostSession
        let sid: String
        var name = "Viewer"
        var state = "auth"
        var authed = false
        var connected = false
        var signalingGone = false
        private var spake: Spake2?
        private var channel: SecureChannel?
        private var pc: RTCPeerConnection?
        private var ctrl: RTCDataChannel?
        private var restarts = 0

        init(host: HostSession, sid: String) {
            self.host = host
            self.sid = sid
        }

        private func relay(_ data: [String: Any]) {
            host.sig?.send(["t": "msg", "to": sid, "data": data])
        }

        private func authFailed() {
            host.sig?.send(["t": "authfail", "sid": sid])
            close()
        }

        func onSignal(_ d: [String: Any]) {
            switch (d["type"] as? String) ?? "" {
            case "pake1" where state == "auth":
                guard let code = host.code else { return }
                state = "confirm"
                let sp = Spake2(role: .host, code: code, password: host.settings.password)
                spake = sp
                let y = sp.start()
                guard let x = d["X"] as? String, let confirm = try? sp.finish(x) else { return authFailed() }
                relay(["type": "pake2", "Y": y, "confirm": confirm])
            case "pake3" where state == "confirm":
                guard let sp = spake, sp.verify(d["confirm"] as? String) else { return authFailed() }
                channel = sp.channel()
                spake = nil
                authed = true
                state = "connecting"
                host.sig?.send(["t": "authok", "sid": sid])
                host.emitViewers()
                startPeer()
            case "sec":
                guard let ch = channel, let n = (d["n"] as? NSNumber)?.uint64Value, let c = d["c"] as? String else { return }
                do {
                    let plain = try ch.open(n: n, c: c)
                    if let obj = try JSONSerialization.jsonObject(with: Data(plain.utf8)) as? [String: Any] { onSecure(obj) }
                } catch {
                    close()
                }
            default:
                break
            }
        }

        private func secureSend(_ obj: [String: Any]) {
            guard let ch = channel,
                  let data = try? JSONSerialization.data(withJSONObject: obj),
                  let json = String(data: data, encoding: .utf8),
                  let sealed = try? ch.seal(json) else { return }
            relay(["type": "sec", "n": sealed.n, "c": sealed.c])
        }

        private func startPeer() {
            let config = RTCConfiguration()
            config.iceServers = host.iceServers
            config.sdpSemantics = .unifiedPlan
            config.bundlePolicy = .maxBundle
            config.continualGatheringPolicy = .gatherContinually
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let peer = host.factory.peerConnection(with: config, constraints: constraints, delegate: self) else { return close() }
            pc = peer
            let initOpts = RTCRtpTransceiverInit()
            initOpts.direction = .sendOnly
            initOpts.streamIds = ["screen"]
            if let tr = peer.addTransceiver(with: host.track, init: initOpts) {
                let params = tr.sender.parameters
                for e in params.encodings {
                    e.maxBitrateBps = NSNumber(value: 6_000_000)
                    e.maxFramerate = NSNumber(value: 30)
                }
                tr.sender.parameters = params
            }
            let ctrlConfig = RTCDataChannelConfiguration()
            ctrlConfig.isOrdered = true
            ctrl = peer.dataChannel(forLabel: "ctrl", configuration: ctrlConfig)
            ctrl?.delegate = self
            let inputConfig = RTCDataChannelConfiguration()
            inputConfig.isOrdered = false
            inputConfig.maxRetransmits = 0
            _ = peer.dataChannel(forLabel: "input", configuration: inputConfig)
            sendOffer(iceRestart: false)
        }

        private func sendOffer(iceRestart: Bool) {
            guard let peer = pc else { return }
            let constraints = RTCMediaConstraints(
                mandatoryConstraints: iceRestart ? ["IceRestart": "true"] : nil,
                optionalConstraints: nil
            )
            peer.offer(for: constraints) { [weak self] sdp, _ in
                guard let self = self, let sdp = sdp else { return }
                self.host.queue.async {
                    self.pc?.setLocalDescription(sdp) { [weak self] error in
                        guard let self = self, error == nil else { return }
                        self.host.queue.async {
                            guard let local = self.pc?.localDescription else { return }
                            self.secureSend(["type": "offer", "sdp": local.sdp])
                        }
                    }
                }
            }
        }

        private func restartIce() {
            restarts += 1
            if signalingGone || host.sig?.isOpen != true || restarts > 3 { return close() }
            state = "reconnecting"
            host.emitViewers()
            pc?.restartIce()
            sendOffer(iceRestart: true)
        }

        private func onSecure(_ m: [String: Any]) {
            switch (m["type"] as? String) ?? "" {
            case "hello":
                name = String((m["name"] as? String ?? "Viewer").prefix(64))
                host.emitViewers()
            case "answer":
                guard let sdp = m["sdp"] as? String else { return }
                pc?.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: boostStartBitrate(sdp))) { _ in }
            case "ice":
                guard let c = m["candidate"] as? [String: Any], let cand = c["candidate"] as? String else { return }
                let candidate = RTCIceCandidate(
                    sdp: cand,
                    sdpMLineIndex: Int32((c["sdpMLineIndex"] as? NSNumber)?.intValue ?? 0),
                    sdpMid: c["sdpMid"] as? String
                )
                pc?.add(candidate) { _ in }
            case "bye":
                close()
            default:
                break
            }
        }

        func sendCtrl(_ obj: [String: Any]) {
            guard let ch = ctrl, ch.readyState == .open, let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
            ch.sendData(RTCDataBuffer(data: data, isBinary: false))
        }

        func close(sayBye: Bool = false) {
            guard state != "closed" else { return }
            if sayBye { secureSend(["type": "bye"]) }
            state = "closed"
            connected = false
            ctrl?.delegate = nil
            ctrl = nil
            pc?.close()
            pc = nil
            host.viewers[sid] = nil
            host.emitViewers()
        }

        // RTCPeerConnectionDelegate (called on WebRTC's signaling thread)
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
            host.queue.async {
                switch newState {
                case .connected:
                    self.connected = true
                    self.restarts = 0
                    self.state = "connected"
                    self.host.emitViewers()
                case .failed:
                    self.restartIce()
                case .closed:
                    self.close()
                default:
                    break
                }
            }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
            host.queue.async {
                var c: [String: Any] = ["candidate": candidate.sdp, "sdpMLineIndex": candidate.sdpMLineIndex]
                c["sdpMid"] = candidate.sdpMid ?? NSNull()
                self.secureSend(["type": "ice", "candidate": c])
            }
        }

        func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
        func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
        func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

        // RTCDataChannelDelegate
        func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
            if dataChannel.readyState == .open {
                host.queue.async { self.sendCtrl(self.host.infoMessage()) }
            }
        }

        func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
            // iOS hosts are view-only; input events are ignored.
        }
    }
}

/// Same start-bitrate hints as web/js/rtc.js.
func boostStartBitrate(_ sdp: String) -> String {
    sdp.components(separatedBy: "\r\n").map { line in
        guard line.hasPrefix("a=fmtp:"), !line.contains("apt="), !line.contains("x-google") else { return line }
        return line + ";x-google-start-bitrate=2500;x-google-min-bitrate=500;x-google-max-bitrate=6000"
    }.joined(separator: "\r\n")
}

/// Thread-safe boolean.
final class ManagedFlag {
    private let lock = NSLock()
    private var _value = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}
