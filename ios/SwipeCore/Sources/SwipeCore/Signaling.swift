import Foundation

/// WebSocket connection to the Swipe server (see docs/PROTOCOL.md).
public final class Signaling: NSObject, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onMessage: (([String: Any]) -> Void)?
    public var onClose: ((String) -> Void)?
    public private(set) var isOpen = false

    private let url: URL
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var closed = false

    public init?(server: String) {
        let ws = server.replacingOccurrences(of: "^http", with: "ws", options: .regularExpression) + "/ws"
        guard let url = URL(string: ws) else { return nil }
        self.url = url
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    public func connect() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(.string(let text)):
                if let data = text.data(using: .utf8),
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    self.onMessage?(obj)
                }
                self.receive()
            case .success:
                self.receive()
            case .failure(let error):
                self.finish(error.localizedDescription)
            }
        }
    }

    public func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    public func close() {
        closed = true
        isOpen = false
        pingTimer?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private func finish(_ reason: String) {
        guard !closed else { return }
        closed = true
        isOpen = false
        pingTimer?.cancel()
        session.invalidateAndCancel()
        onClose?(reason)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        isOpen = true
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 20, repeating: 20)
        timer.setEventHandler { [weak self] in
            self?.task?.sendPing { error in
                if let error = error { self?.finish(error.localizedDescription) }
            }
        }
        timer.resume()
        pingTimer = timer
        onOpen?()
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish("closed")
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error?.localizedDescription ?? "closed")
    }
}

/// Asks the server which code this device has (before sharing starts).
public func fetchCode(server: String, deviceKey: String, completion: @escaping (String?) -> Void) {
    guard let url = URL(string: server + "/api/code") else { return completion(nil) }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["key": deviceKey])
    URLSession.shared.dataTask(with: req) { data, _, _ in
        let code = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["code"] as? String
        completion(code.flatMap { $0.count == 9 ? $0 : nil })
    }.resume()
}
