import Foundation

/// Settings shared between the app and its broadcast extension through an
/// App Group (set SWIPE_APP_GROUP in ios/project.yml).
public final class SharedSettings {
    public static var appGroup: String {
        (Bundle.main.object(forInfoDictionaryKey: "SwipeAppGroup") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "group.app.swipe.ios"
    }

    public let defaults: UserDefaults

    public init() {
        defaults = UserDefaults(suiteName: Self.appGroup) ?? .standard
    }

    public var server: String {
        get {
            let s = defaults.string(forKey: "server") ?? (Bundle.main.object(forInfoDictionaryKey: "SwipeDefaultServer") as? String) ?? ""
            return s.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "server") }
    }

    public var deviceName: String {
        get { defaults.string(forKey: "name").flatMap { $0.isEmpty ? nil : $0 } ?? defaultName }
        set { defaults.set(newValue, forKey: "name") }
    }

    /// Random secret that gives this device a stable code on the server.
    public var deviceKey: String {
        if let k = defaults.string(forKey: "deviceKey") { return k }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let key = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        defaults.set(key, forKey: "deviceKey")
        return key
    }

    public var password: String {
        get {
            if let p = defaults.string(forKey: "password"), !p.isEmpty { return p }
            let p = Codes.generatePassword()
            defaults.set(p, forKey: "password")
            return p
        }
        set { defaults.set(Codes.normalizePassword(newValue), forKey: "password") }
    }

    // Status written by the broadcast extension, read by the app.
    public var code: String {
        get { defaults.string(forKey: "code") ?? "" }
        set { defaults.set(newValue, forKey: "code") }
    }

    public var status: String {
        get { defaults.string(forKey: "status") ?? "offline" }
        set { defaults.set(newValue, forKey: "status") }
    }

    public var viewers: [String] {
        get { defaults.stringArray(forKey: "viewers") ?? [] }
        set { defaults.set(newValue, forKey: "viewers") }
    }

    /// "ipad" or "iphone"; recorded by the app on launch (main thread) so the
    /// extension can report it without touching UIKit.
    public var platform: String {
        get { defaults.string(forKey: "platform") ?? "iphone" }
        set { defaults.set(newValue, forKey: "platform") }
    }

    private var defaultName: String {
        platform == "ipad" ? "iPad" : "iPhone"
    }
}
