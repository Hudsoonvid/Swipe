import ReplayKit
import SwipeCore

/// Entry point of the broadcast upload extension: iOS hands us the screen
/// frames after the user starts a broadcast from the Swipe app or Control Center.
final class SampleHandler: RPBroadcastSampleHandler {
    private var host: HostSession?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let settings = SharedSettings()
        guard !settings.server.isEmpty else {
            finishBroadcastWithError(NSError(
                domain: "Swipe", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Open Swipe and enter your server address first."]
            ))
            return
        }
        let session = HostSession()
        host = session
        session.start()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        if sampleBufferType == .video { host?.capture(sampleBuffer) }
    }

    override func broadcastFinished() {
        host?.stop()
        host = nil
    }
}
