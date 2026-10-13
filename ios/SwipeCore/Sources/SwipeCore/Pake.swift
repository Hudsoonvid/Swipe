import BigInt
import CryptoKit
import Foundation

// SPAKE2 pairing and the encrypted signaling channel.
// Must match web/js/crypto.js byte for byte; see docs/PROTOCOL.md and the
// shared vectors in docs/test-vectors.json (checked by PakeTests).

public enum PakeError: Error {
    case badElement
    case outOfOrder
    case decryptFailed
}

enum Group {
    static let P = BigUInt(
        "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff",
        radix: 16
    )!
    static let Q = (P - 1) / 2
    static let G = BigUInt(2)
    static let M = BigUInt(
        "4e8bcbcd6027c51d25c4a67455821583123238f421d6151584d264ab765dd2d6685f2652844df349d01c6bd2ada22d4ce2331be4a695416badaa9926f289c93098cb92ee73af2d3570066d145432e0c025ba3c23fc7e66c7c2aaa3cb6c41fa3a09ba71fee3f8a1012a9e824c4d21246c50e368e9f7ec066c0cc7d0cf800b734ce59c893d7995b523ecb668a98e76a09117cac5e7c726cc7bba279fe9700a01987f27013b26d2a516295500d67474092b6d7fb068229a1a824fd7ba2b0556466d52cccd1f9e9cda12d0fef2792f55d2cd8ac213b17fa292fdb2b061575fdd18365f010b121725ff03bb36948657b8d97b525a5b142920abfcc2b2c79077f88055",
        radix: 16
    )!
    static let N = BigUInt(
        "5b41daf0c14a2106a4e789f111c2b3a4a3e4df3261c7fa816b2e424db2ec9af3c715d46d8c0d4c43264cd41870253dfe0a06f63fac7825464081f041cb990ea484fe3a6e514a4bc0db49d390325fa0eba52356083d073e5bd76f75ee35c30bb92b542daa575b8f06916e17c8cbea9d5b966c7fa1bdeb262e81a138c26a41b097e2e5920421bfee4cb74b6fff4287fbf6cd4d543e0be12eafda0f6f69f882062f764b468c08c8f697351c7bdc72d66b434700839f8e9a8cb87c0d3f527a808dc08731f706617a965f673c5881934d4ef2d11045b37e3662037b7423154ef20893c6c4d0122dd283d026cf5d504568c0c6411c5a86df61d86aeb0ad29ec39a9b27",
        radix: 16
    )!
    static let elementBytes = 256

    static func isValidElement(_ e: BigUInt) -> Bool {
        e > 1 && e < P - 1 && e.power(Q, modulus: P) == 1
    }
}

private let label = Data("swipe-pake-v1".utf8)

public enum Codes {
    public static func normalizeCode(_ code: String) -> String {
        String(code.filter { ("0"..."9").contains($0) })
    }

    public static func normalizePassword(_ pw: String) -> String {
        let nfkc = pw.precomposedStringWithCompatibilityMapping
        return String(nfkc.unicodeScalars.filter { !" \t\r\n-".unicodeScalars.contains($0) }).uppercased()
    }

    private static let alphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

    public static func generatePassword(length: Int = 8) -> String {
        var out = ""
        var rng = SystemRandomNumberGenerator()
        while out.count < length {
            let b = UInt8.random(in: 0...255, using: &rng)
            if b < 248 { out.append(alphabet[Int(b) % alphabet.count]) }
        }
        return out
    }

    public static func formatCode(_ code: String) -> String {
        let digits = Array(normalizeCode(code))
        return stride(from: 0, to: digits.count, by: 3).map { String(digits[$0..<min($0 + 3, digits.count)]) }.joined(separator: " ")
    }

    public static func formatPassword(_ pw: String) -> String {
        let n = normalizePassword(pw)
        guard n.count == 8 else { return n }
        return "\(n.prefix(4))-\(n.suffix(4))"
    }
}

extension Data {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }

    public init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let b = UInt8(hex[idx..<next], radix: 16) else { return nil }
            bytes.append(b)
            idx = next
        }
        self.init(bytes)
    }
}

extension BigUInt {
    /// Big-endian, zero-padded to `length` bytes.
    func fixedBytes(_ length: Int) -> Data {
        let raw = serialize()
        precondition(raw.count <= length, "integer too large")
        return Data(repeating: 0, count: length - raw.count) + raw
    }
}

private func sha256(_ parts: Data...) -> Data {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return Data(h.finalize())
}

private func hmac(_ key: Data, _ data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
}

/// RFC 5869 HKDF-SHA256 with an empty salt, 32-byte output.
private func hkdf(_ ikm: Data, _ info: String) -> Data {
    let prk = hmac(Data(count: 32), ikm)
    return hmac(prk, Data(info.utf8) + Data([1]))
}

func passwordScalar(code: String, password: String) -> BigUInt {
    BigUInt(sha256(label, Data([0]), Data(Codes.normalizeCode(code).utf8), Data([0]), Data(Codes.normalizePassword(password).utf8)))
}

/// role "viewer" sends X (masked with M); role "host" sends Y (masked with N).
public final class Spake2 {
    public enum Role { case viewer, host }

    let role: Role
    let code: String
    let password: String
    private var w = BigUInt(0)
    private var x = BigUInt(0)
    private var mine = BigUInt(0)
    private var peerConfirm = Data()
    private let testScalar: BigUInt?
    public private(set) var transcript = Data()
    public private(set) var keyV2H = Data()
    public private(set) var keyH2V = Data()

    public init(role: Role, code: String, password: String, testScalarHex: String? = nil) {
        self.role = role
        self.code = Codes.normalizeCode(code)
        self.password = password
        testScalar = testScalarHex.flatMap { BigUInt($0, radix: 16) }
    }

    public func start() -> String {
        w = passwordScalar(code: code, password: password)
        if let t = testScalar {
            x = t
        } else {
            repeat {
                var bytes = [UInt8](repeating: 0, count: 40)
                _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
                x = BigUInt(Data(bytes))
            } while x == 0
        }
        let mask = role == .viewer ? Group.M : Group.N
        mine = (Group.G.power(x, modulus: Group.P) * mask.power(w, modulus: Group.P)) % Group.P
        return mine.fixedBytes(Group.elementBytes).hex
    }

    /// Returns this side's confirmation MAC (hex).
    public func finish(_ peerHex: String) throws -> String {
        guard peerHex.count == Group.elementBytes * 2, let data = Data(hex: peerHex) else { throw PakeError.badElement }
        let peer = BigUInt(data)
        guard Group.isValidElement(peer) else { throw PakeError.badElement }
        let peerMask = role == .viewer ? Group.N : Group.M
        let unmasked = (peer * peerMask.power(Group.Q - (w % Group.Q), modulus: Group.P)) % Group.P
        let k = unmasked.power(x, modulus: Group.P)
        let bigX = role == .viewer ? mine : peer
        let bigY = role == .viewer ? peer : mine
        let tt = sha256(
            label, Data([0]), Data(code.utf8), Data([0]),
            bigX.fixedBytes(Group.elementBytes),
            bigY.fixedBytes(Group.elementBytes),
            k.fixedBytes(Group.elementBytes),
            w.fixedBytes(32)
        )
        transcript = tt
        let kcViewer = hkdf(tt, "swipe/confirm/viewer")
        let kcHost = hkdf(tt, "swipe/confirm/host")
        keyV2H = hkdf(tt, "swipe/enc/v2h")
        keyH2V = hkdf(tt, "swipe/enc/h2v")
        peerConfirm = hmac(role == .viewer ? kcHost : kcViewer, tt)
        x = 0
        return hmac(role == .viewer ? kcViewer : kcHost, tt).hex
    }

    public func verify(_ peerConfirmHex: String?) -> Bool {
        guard let hex = peerConfirmHex, hex.count == 64, let given = Data(hex: hex) else { return false }
        // constant-time comparison
        var diff: UInt8 = 0
        for (a, b) in zip(given, peerConfirm) { diff |= a ^ b }
        return diff == 0 && given.count == peerConfirm.count
    }

    public func channel() -> SecureChannel {
        role == .viewer ? SecureChannel(sendKey: keyV2H, recvKey: keyH2V) : SecureChannel(sendKey: keyH2V, recvKey: keyV2H)
    }
}

/// AES-256-GCM with per-direction keys and strict message counters.
public final class SecureChannel {
    private let sendKey: SymmetricKey
    private let recvKey: SymmetricKey
    private var sendCounter: UInt64 = 0
    private var recvCounter: UInt64 = 0
    private let lock = NSLock()
    private static let aad = Data("swipe/v1".utf8)

    init(sendKey: Data, recvKey: Data) {
        self.sendKey = SymmetricKey(data: sendKey)
        self.recvKey = SymmetricKey(data: recvKey)
    }

    private static func nonce(_ n: UInt64) -> AES.GCM.Nonce {
        var bytes = Data(repeating: 0, count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        return try! AES.GCM.Nonce(data: bytes)
    }

    /// Returns the message counter and base64 ciphertext+tag.
    public func seal(_ plainJson: String) throws -> (n: UInt64, c: String) {
        lock.lock()
        defer { lock.unlock() }
        let n = sendCounter
        sendCounter += 1
        let box = try AES.GCM.seal(Data(plainJson.utf8), using: sendKey, nonce: Self.nonce(n), authenticating: Self.aad)
        return (n, (box.ciphertext + box.tag).base64EncodedString())
    }

    public func open(n: UInt64, c: String) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        guard n == recvCounter else { throw PakeError.outOfOrder }
        guard let data = Data(base64Encoded: c), data.count >= 16 else { throw PakeError.decryptFailed }
        let box = try AES.GCM.SealedBox(nonce: Self.nonce(n), ciphertext: data.prefix(data.count - 16), tag: data.suffix(16))
        let plain = try AES.GCM.open(box, using: recvKey, authenticating: Self.aad)
        recvCounter += 1
        guard let s = String(data: plain, encoding: .utf8) else { throw PakeError.decryptFailed }
        return s
    }
}
