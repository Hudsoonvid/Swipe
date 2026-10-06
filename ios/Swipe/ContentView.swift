import CoreImage.CIFilterBuiltins
import SwiftUI
import SwipeCore

struct ContentView: View {
    private let settings = SharedSettings()
    @State private var code = ""
    @State private var password = ""
    @State private var status = "offline"
    @State private var viewers: [String] = []
    @State private var server = ""
    @State private var name = ""
    @State private var showViewer = false
    @State private var showSetPassword = false
    @State private var newPassword = ""
    @State private var message: String?
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var deviceWord: String { settings.platform == "ipad" ? "iPad" : "iPhone" }
    private var sharing: Bool { !["offline", "noserver", "replaced"].contains(status) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    shareCard
                    connectCard
                    settingsCard
                    Text("Connections are end-to-end encrypted. The server never sees your password or your screen.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
            .background(Color(red: 0.04, green: 0.05, blue: 0.08).ignoresSafeArea())
            .navigationTitle("Swipe")
        }
        .onAppear(perform: load)
        .onReceive(timer) { _ in refreshStatus() }
        .fullScreenCover(isPresented: $showViewer) { viewer }
        .alert("Set a password", isPresented: $showSetPassword) {
            TextField("At least 4 characters", text: $newPassword)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Save") {
                let pw = Codes.normalizePassword(newPassword)
                if pw.count >= 4 { setPassword(pw) } else { message = "Use at least 4 characters." }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Not case-sensitive. Use 8+ characters for access over the internet.")
        }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        }
    }

    // MARK: cards

    private func card<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.title2.bold())
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(red: 0.09, green: 0.11, blue: 0.16)))
    }

    private var shareCard: some View {
        card("Share this \(deviceWord)") {
            VStack(alignment: .leading, spacing: 4) {
                Text("YOUR CODE").font(.caption.bold()).foregroundColor(.secondary)
                Text(code.isEmpty ? "··· ··· ···" : Codes.formatCode(code))
                    .font(.system(size: 34, weight: .bold, design: .monospaced))
                    .textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("PASSWORD").font(.caption.bold()).foregroundColor(.secondary)
                Text(Codes.formatPassword(password))
                    .font(.system(size: 30, weight: .bold, design: .monospaced))
                    .textSelection(.enabled)
                HStack {
                    Button("New password") { setPassword(Codes.generatePassword()) }
                    Button("Set…") {
                        newPassword = ""
                        showSetPassword = true
                    }
                }
                .buttonStyle(.bordered)
            }
            if let qr = qrImage() {
                Image(uiImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 200, height: 200)
                    .frame(maxWidth: .infinity)
                Text("Scan with another device's camera to connect instantly (contains the password).")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
            Text(statusText).fontWeight(.semibold)
            if !viewers.isEmpty {
                Text(viewers.joined(separator: "\n")).foregroundColor(.secondary)
            }
            StartBroadcastButton(title: sharing ? "Stop sharing" : "Start sharing")
            Text("Tap the button, then \"Start Broadcast\". To stop, tap the red indicator at the top of the screen. Apple doesn't allow apps to control an \(deviceWord), so others can watch but not tap.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var connectCard: some View {
        card("Connect to another device") {
            Text("See and control a computer, phone or tablet that is sharing.")
                .foregroundColor(.secondary)
            Button {
                if server.isEmpty { message = "Enter your Swipe server address first." } else { showViewer = true }
            } label: {
                Text("Open viewer").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 40)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var settingsCard: some View {
        card("Settings") {
            TextField("https://swipe.example.com", text: $server)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)
            TextField("Device name", text: $name)
                .textFieldStyle(.roundedBorder)
            Button("Save") { save() }.buttonStyle(.bordered)
        }
    }

    private var viewer: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let url = URL(string: server + "/") {
                WebViewer(url: url).ignoresSafeArea()
            }
            Button {
                showViewer = false
            } label: {
                Image(systemName: "xmark")
                    .font(.headline)
                    .padding(10)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            }
            .padding(.leading, 12)
            .padding(.top, 4)
        }
    }

    private var statusText: String {
        switch status {
        case "online": return viewers.isEmpty ? "Sharing — waiting for a device to connect" : "\(viewers.count) device\(viewers.count == 1 ? "" : "s") watching"
        case "connecting": return "Connecting to the server…"
        case "reconnecting": return "Reconnecting to the server…"
        case "noserver": return "Enter the server address below, then start again"
        default: return "Not sharing"
        }
    }

    // MARK: actions

    private func load() {
        server = settings.server
        name = settings.deviceName
        password = settings.password
        code = settings.code
        refreshStatus()
        refreshCode()
    }

    private func refreshStatus() {
        status = settings.status
        viewers = settings.viewers
        if !settings.code.isEmpty { code = settings.code }
    }

    private func refreshCode() {
        guard !server.isEmpty else { return }
        fetchCode(server: server, deviceKey: settings.deviceKey) { c in
            guard let c = c else { return }
            DispatchQueue.main.async {
                settings.code = c
                code = c
            }
        }
    }

    private func setPassword(_ pw: String) {
        settings.password = pw
        password = settings.password
        if sharing { message = "New password set. Devices already watching stay connected." }
    }

    private func save() {
        let s = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !s.isEmpty && !(s.hasPrefix("https://") || s.hasPrefix("http://")) {
            message = "The address must start with https://"
            return
        }
        server = s
        settings.server = s
        settings.deviceName = name
        refreshCode()
        message = "Saved"
    }

    private func qrImage() -> UIImage? {
        guard !code.isEmpty, !server.isEmpty else { return nil }
        let pw = password.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? password
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data("\(server)/#c=\(code)&p=\(pw)".utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
