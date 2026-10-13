import SwiftUI
import SwipeCore

@main
struct SwipeApp: App {
    init() {
        // The broadcast extension reads this instead of touching UIKit.
        SharedSettings().platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}
