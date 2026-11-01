import AppKit
import SwiftUI
import ServiceManagement

/*
 * The Settings window: everything jukebox.conf holds, as controls, plus the
 * few things that are the app's own (open at login, start on open, preview
 * builds, the guest network).
 *
 * jukebox.conf settings are read when the jukebox starts, so a save does not
 * change a running party by itself: the window says so, and offers Restart
 * Jukebox, which keeps the queue and leaves Music playing. The guest network
 * is the exception -- it applies at once, as it does from the menu.
 */
@MainActor
final class SettingsModel: ObservableObject {
    // jukebox.conf, as text: conf.js validates and says why in words.
    @Published var title = ""
    @Published var playlist = ""
    @Published var maxPhone = ""
    @Published var maxLaptop = ""
    @Published var maxQueue = ""
    @Published var repeatMinutes = ""
    @Published var showWifi = false
    @Published var wifiName = ""
    @Published var wifiPassword = ""
    @Published var publicUrl = ""

    @Published var errors: [String: String] = [:]
    @Published var problem: String?            // the file itself could not be read or written
    @Published var savedNeedsRestart = false
    @Published var saved = false
    @Published var showPassword = false

    // The app's own
    @Published var network = "auto"
    @Published var adapters: [Adapter] = []
    @Published var autoLabel = ""
    @Published var openAtLogin = false
    @Published var loginNote: String?
    @Published var startOnOpen = UserDefaults.standard.object(forKey: "startJukeboxOnOpen") as? Bool ?? true {
        didSet { UserDefaults.standard.set(startOnOpen, forKey: "startJukeboxOnOpen") }
    }
    @Published var previews = false
    @Published var updateStatus = ""

    private var loaded: [String: String] = [:]
    let server: ServerController
    let updater: Updater

    init(server: ServerController, updater: Updater) {
        self.server = server
        self.updater = updater
    }

    var running: Bool { server.state == .running && server.ours }

    var dirty: Bool { current() != loaded }

    func load() {
        let r = ConfStore.read()
        errors = [:]
        saved = false
        savedNeedsRestart = false
        if r.ok, let v = r.values {
            problem = nil
            apply(v)
            loaded = current()
        } else {
            problem = r.error ?? "The settings could not be read."
        }
        refreshApp()
    }

    func refreshApp() {
        adapters = Network.adapters()
        network = server.network?.choice ?? Network.readChoice() ?? "auto"
        let primary = Network.primaryInterface()
        autoLabel = Settings.pinsPublicUrl() || !publicUrl.isEmpty ? "the address set below"
            : (adapters.first { $0.name == primary } ?? adapters.first).map { $0.label ?? $0.name } ?? "no address yet"
        openAtLogin = SMAppService.mainApp.status == .enabled
        previews = updater.previews
        updateStatus = updater.statusLine
    }

    private func apply(_ v: [String: String]) {
        title = v["JUKEBOX_TITLE"] ?? ""
        playlist = v["JUKEBOX_PLAYLIST"] ?? ""
        maxPhone = v["JUKEBOX_MAX_PER_PHONE"] ?? ""
        maxLaptop = v["JUKEBOX_MAX_PER_LAPTOP"] ?? ""
        maxQueue = v["JUKEBOX_MAX_QUEUE"] ?? ""
        repeatMinutes = v["JUKEBOX_REPEAT_MINUTES"] ?? ""
        wifiName = v["JUKEBOX_WIFI_NAME"] ?? ""
        wifiPassword = v["JUKEBOX_WIFI_PASSWORD"] ?? ""
        showWifi = !wifiName.isEmpty
        publicUrl = v["PUBLIC_URL"] ?? ""
    }

    private func current() -> [String: String] {
        [
            "JUKEBOX_TITLE": title,
            "JUKEBOX_PLAYLIST": playlist,
            "JUKEBOX_MAX_PER_PHONE": maxPhone,
            "JUKEBOX_MAX_PER_LAPTOP": maxLaptop,
            "JUKEBOX_MAX_QUEUE": maxQueue,
            "JUKEBOX_REPEAT_MINUTES": repeatMinutes,
            // Switched off, the code goes -- but what was typed stays in the
            // window until it closes, in case that was a slip.
            "JUKEBOX_WIFI_NAME": showWifi ? wifiName : "",
            "JUKEBOX_WIFI_PASSWORD": showWifi ? wifiPassword : "",
            "PUBLIC_URL": publicUrl,
        ]
    }

    func save() {
        let r = ConfStore.write(current())
        if r.ok {
            errors = [:]
            problem = nil
            if let v = r.values { apply(v) }       // as normalised: "025" becomes "25"
            loaded = current()
            saved = true
            savedNeedsRestart = running && r.unchanged != true
        } else {
            errors = r.errors ?? [:]
            problem = r.error ?? (errors.isEmpty ? "The settings could not be saved." : nil)
            saved = false
        }
        refreshApp()
    }

    func revert() { load() }

    func restartJukebox() {
        savedNeedsRestart = false
        server.restart()
    }

    func chooseNetwork(_ name: String) {
        server.chooseNetwork(name == "auto" ? nil : name)
    }

    func setOpenAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginNote = SMAppService.mainApp.status == .requiresApproval
                ? "Allow Party Jukebox in System Settings ▸ General ▸ Login Items." : nil
        } catch {
            loginNote = error.localizedDescription
        }
        openAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setPreviews(_ on: Bool) {
        updater.previews = on
        refreshApp()
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(spacing: 0) {
            if let problem = model.problem {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(problem).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Open the File") { NSWorkspace.shared.open(Paths.conf) }
                }
                .padding(10)
                .background(Color.orange.opacity(0.12))
            }
            TabView {
                general.tabItem { Label("General", systemImage: "gearshape") }
                guests.tabItem { Label("Guests", systemImage: "person.3") }
                wifi.tabItem { Label("Wi-Fi Code", systemImage: "wifi") }
                network.tabItem { Label("Network", systemImage: "network") }
                updates.tabItem { Label("Updates", systemImage: "arrow.down.circle") }
            }
            .padding([.horizontal, .top])
            footer
        }
        .frame(width: 560, height: 470)
    }

    // MARK: Tabs

    private var general: some View {
        Form {
            Section("On the cabinet") {
                TextField("Marquee title", text: $model.title, prompt: Text("JUKEBOX"))
                note("The neon sign along the top of the jukebox screen.")
                error("JUKEBOX_TITLE")
                TextField("Music playlist", text: $model.playlist, prompt: Text("Jukebox"))
                note("The playlist in Music that mirrors the queue. Party Jukebox creates it, and only ever changes that one.")
                error("JUKEBOX_PLAYLIST")
            }
            Section("This app") {
                Toggle("Start the jukebox when Party Jukebox opens", isOn: $model.startOnOpen)
                Toggle("Open Party Jukebox at login", isOn: Binding(
                    get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
                if let n = model.loginNote { note(n) }
            }
        }
        .formStyle(.grouped)
    }

    private var guests: some View {
        Form {
            Section("Picks waiting at once") {
                number("Each phone", $model.maxPhone, "JUKEBOX_MAX_PER_PHONE")
                number("The laptop", $model.maxLaptop, "JUKEBOX_MAX_PER_LAPTOP")
                number("Everyone together", $model.maxQueue, "JUKEBOX_MAX_QUEUE")
                note("A song that has started playing leaves the queue and frees its place, so everyone gets another turn as the night goes on.")
            }
            Section("Repeats") {
                number("Minutes before a song can be picked again", $model.repeatMinutes, "JUKEBOX_REPEAT_MINUTES")
                note("0 turns the rule off. The laptop is always exempt.")
            }
        }
        .formStyle(.grouped)
    }

    private var wifi: some View {
        Form {
            Section {
                Toggle("Show a code that joins phones to the Wi-Fi", isOn: $model.showWifi)
                note("It appears on the laptop's jukebox screen, above the jukebox's own code. Phones never see it.")
            }
            if model.showWifi {
                Section("The network the laptop is on") {
                    TextField("Network name", text: $model.wifiName)
                    error("JUKEBOX_WIFI_NAME")
                    HStack {
                        if model.showPassword {
                            TextField("Password", text: $model.wifiPassword)
                        } else {
                            SecureField("Password", text: $model.wifiPassword)
                        }
                        Toggle("Show", isOn: $model.showPassword).toggleStyle(.checkbox)
                    }
                    error("JUKEBOX_WIFI_PASSWORD")
                    note("Leave the password empty for an open network. Use the laptop's own network: a separate guest network usually stops phones reaching the jukebox.")
                }
            }
        }
        .formStyle(.grouped)
    }

    private var network: some View {
        Form {
            Section("The address on the jukebox's QR code") {
                Picker("Guests use", selection: Binding(
                    get: { model.network },
                    set: { model.network = $0; model.chooseNetwork($0) })) {
                    Text("Automatic — \(model.autoLabel)").tag("auto")
                    ForEach(model.adapters, id: \.name) { a in Text(a.title).tag(a.name) }
                    if model.network != "auto" && !model.adapters.contains(where: { $0.name == model.network }) {
                        Text("\(model.network) — not connected").tag(model.network)
                    }
                }
                note("Applies at once, with no restart. On a Mac with Wi-Fi and Ethernet, pick the one the phones are on.")
            }
            Section("Advanced") {
                TextField("Fixed address", text: $model.publicUrl, prompt: Text("http://192.168.1.40:8484/"))
                error("PUBLIC_URL")
                note("Only if Automatic gets it wrong and picking an adapter is not enough. Leave empty otherwise. An adapter picked above takes priority.")
            }
        }
        .formStyle(.grouped)
    }

    private var updates: some View {
        Form {
            Section {
                LabeledContent("Status", value: model.updateStatus)
                Button("Check for Updates Now") {
                    model.updater.check(userAsked: true)
                    model.refreshApp()
                }
                note("Party Jukebox looks for a new build at launch and every four hours. It always asks before installing, and says first if the jukebox is playing.")
            }
            Section("Testing") {
                Toggle("Get preview builds", isOn: Binding(get: { model.previews }, set: { model.setPreviews($0) }))
                note("Builds of changes not finished yet. Leave off unless you are trying one out.")
            }
            Section("Files") {
                HStack {
                    Button("Open Settings File") { NSWorkspace.shared.open(Paths.conf) }
                    Button("Show Data Folder") { NSWorkspace.shared.activateFileViewerSelecting([Paths.support]) }
                }
            }
        }
        .formStyle(.grouped)
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            if model.savedNeedsRestart {
                Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(.blue)
                Text("Saved. The jukebox uses them from its next start.")
                Button("Restart Jukebox Now") { model.restartJukebox() }
            } else if model.saved && !model.dirty {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Saved.")
            } else if !model.errors.isEmpty {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                Text("Not saved: see the red notes.")
            }
            Spacer()
            Button("Revert") { model.revert() }.disabled(!model.dirty)
            Button("Save") { model.save() }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.dirty || model.problem != nil && model.errors.isEmpty)
        }
        .padding()
    }

    // MARK: Pieces

    private func number(_ label: String, _ value: Binding<String>, _ key: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(label, text: value).multilineTextAlignment(.trailing)
            error(key)
        }
    }

    @ViewBuilder
    private func error(_ key: String) -> some View {
        if let e = model.errors[key] {
            Text(e).font(.caption).foregroundStyle(.red)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

/// The window itself: one, reused, brought to the front when asked for.
@MainActor
final class SettingsWindow {
    private var window: NSWindow?
    private let model: SettingsModel

    init(model: SettingsModel) { self.model = model }

    func show() {
        model.load()
        if window == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(model: model)))
            w.title = "Party Jukebox Settings"
            w.styleMask = [.titled, .closable, .miniaturizable]
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func refresh() {
        guard window?.isVisible == true else { return }
        model.refreshApp()
    }
}
