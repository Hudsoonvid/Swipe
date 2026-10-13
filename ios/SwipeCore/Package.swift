// swift-tools-version:5.9
import PackageDescription

// Shared code for the Swipe app and its broadcast extension: SPAKE2 pairing,
// settings and the signaling client. Tested with `swift test` (see CI).
let package = Package(
    name: "SwipeCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "SwipeCore", targets: ["SwipeCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/attaswift/BigInt", .upToNextMajor(from: "5.4.0")),
    ],
    targets: [
        .target(name: "SwipeCore", dependencies: ["BigInt"]),
        .testTarget(name: "SwipeCoreTests", dependencies: ["SwipeCore"]),
    ]
)
