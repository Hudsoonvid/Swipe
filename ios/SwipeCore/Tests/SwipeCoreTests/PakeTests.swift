import XCTest
@testable import SwipeCore

final class PakeTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        // ios/SwipeCore/Tests/SwipeCoreTests/PakeTests.swift -> repo root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../docs/test-vectors.json")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: root)) as! [String: Any]
        return json["spake2"] as! [[String: Any]]
    }

    func testMatchesSharedVectors() throws {
        for tv in try vectors() {
            let code = tv["code"] as! String
            let pw = tv["password"] as! String
            XCTAssertEqual(passwordScalar(code: code, password: pw).fixedBytes(32).hex, tv["w"] as? String)
            let v = Spake2(role: .viewer, code: code, password: pw, testScalarHex: tv["x"] as? String)
            let h = Spake2(role: .host, code: code, password: pw, testScalarHex: tv["y"] as? String)
            XCTAssertEqual(v.start(), tv["X"] as? String)
            XCTAssertEqual(h.start(), tv["Y"] as? String)
            XCTAssertEqual(try h.finish(tv["X"] as! String), tv["confirmHost"] as? String)
            XCTAssertEqual(try v.finish(tv["Y"] as! String), tv["confirmViewer"] as? String)
            XCTAssertEqual(v.transcript.hex, tv["transcript"] as? String)
            XCTAssertEqual(v.keyV2H.hex, tv["keyV2H"] as? String)
            XCTAssertEqual(v.keyH2V.hex, tv["keyH2V"] as? String)
            XCTAssertTrue(v.verify(tv["confirmHost"] as? String))
            XCTAssertTrue(h.verify(tv["confirmViewer"] as? String))

            let msg = tv["message"] as! [String: Any]
            let sealedExpected = msg["sealed"] as! [String: Any]
            let sealed = try v.channel().seal(msg["plainJson"] as! String)
            XCTAssertEqual(Int(sealed.n), sealedExpected["n"] as? Int)
            XCTAssertEqual(sealed.c, sealedExpected["c"] as? String)
            XCTAssertEqual(try h.channel().open(n: sealed.n, c: sealed.c), msg["plainJson"] as? String)
        }
    }

    func testWrongPasswordFails() throws {
        let v = Spake2(role: .viewer, code: "123456789", password: "abcdefgh")
        let h = Spake2(role: .host, code: "123456789", password: "abcdefgx")
        let x = v.start()
        let y = h.start()
        let ch = try h.finish(x)
        let cv = try v.finish(y)
        XCTAssertFalse(v.verify(ch))
        XCTAssertFalse(h.verify(cv))
    }

    func testRejectsIdentityElement() {
        let h = Spake2(role: .host, code: "123456789", password: "pw")
        _ = h.start()
        XCTAssertThrowsError(try h.finish(String(repeating: "0", count: 511) + "1"))
    }

    func testNormalization() {
        XCTAssertEqual(Codes.normalizePassword(" k7m2-px9q "), "K7M2PX9Q")
        XCTAssertEqual(Codes.normalizePassword("ａｂｃ"), "ABC")
        XCTAssertEqual(Codes.formatCode("123456789"), "123 456 789")
        XCTAssertEqual(Codes.formatPassword("k7m2px9q"), "K7M2-PX9Q")
        XCTAssertNotNil(Codes.generatePassword().range(of: "^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$", options: .regularExpression))
    }
}
