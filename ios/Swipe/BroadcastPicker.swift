import ReplayKit
import SwiftUI

/// The system "Start Broadcast" picker, preselecting the Swipe extension.
/// Apple only allows starting a screen broadcast from this system UI.
struct BroadcastPicker: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
        picker.preferredExtension = (Bundle.main.bundleIdentifier ?? "app.swipe.ios") + ".Broadcast"
        picker.showsMicrophoneButton = false
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

/// A full-width button that opens the broadcast picker.
struct StartBroadcastButton: View {
    let title: String

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12)
                .fill(LinearGradient(colors: [Color(red: 0.30, green: 0.55, blue: 1), Color(red: 0.48, green: 0.36, blue: 1)], startPoint: .leading, endPoint: .trailing))
            HStack {
                Image(systemName: "record.circle")
                Text(title).fontWeight(.semibold)
            }
            .foregroundColor(.white)
            .allowsHitTesting(false)
            // The real (invisible) picker sits on top and receives the tap.
            BroadcastPicker()
                .opacity(0.02)
        }
        .frame(height: 52)
    }
}
