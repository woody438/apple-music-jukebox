import AppKit

/*
 * Party Jukebox: a Dock icon and a menu bar note around the jukebox server.
 *
 *   open the app         -> the jukebox starts, and its page opens
 *   click the Dock icon  -> the page again (or start, if it was stopped)
 *   quit the app         -> the jukebox stops; Music carries on playing
 *
 * The menu is the git install's menu bar menu, natively: status, the address
 * on the QR code, Open, Start/Stop, Guest Network, updates. What it shows
 * about guests comes from the running server, never from guesses here.
 *
 * Launch options, for CI and for debugging:
 *   --mock          the simulated Music (MOCK=1): no Music, no audio
 *   --port N        another port than jukebox.conf's (or 8484)
 *   --no-autostart  open the app without starting the jukebox
 *   --no-updates    never look for updates
 */
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let args = CommandLine.arguments
    private lazy var mock = args.contains("--mock")
    private lazy var server = ServerController(port: Self.portArgument(args) ?? Settings.port(), mock: mock)
    private let updater = Updater()
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var signalSource: DispatchSourceSignal?
    private var quitting = false

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        Paths.ensure()
        let imported = Paths.importFromGitInstall()
        buildMainMenu()
        catchSigterm()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.autoenablesItems = false        // greyed means greyed: AppKit must not re-enable items
        menu.delegate = self                 // rebuilt fresh every time it opens
        statusItem.menu = menu
        paintIcon()

        server.onChange = { [weak self] in self?.paintIcon() }
        server.startWatching()

        updater.onChange = { [weak self] in self?.paintIcon() }
        updater.onFound = { [weak self] release in self?.offer(release) }
        updater.stopJukebox = { [weak self] done in
            guard let self, self.server.ours || self.server.state == .running else { return done() }
            self.server.stop(done)
        }
        if !args.contains("--no-updates") { updater.start() }

        if !args.contains("--no-autostart") { server.start(openPage: !mock) }

        if !imported.isEmpty {
            NSLog("Party Jukebox: brought across from the git install: \(imported.joined(separator: ", "))")
        }
    }

    /// The Dock icon clicked while the app runs.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if server.state == .running { server.openPage() } else { server.start(openPage: true) }
        return false
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let m = NSMenu()
        m.autoenablesItems = false
        let running = server.state == .running
        m.addItem(ActionItem("Open Jukebox Page", enabled: running) { [weak self] in self?.server.openPage() })
        m.addItem(ActionItem("Start Jukebox", enabled: server.state == .stopped) { [weak self] in self?.server.start(openPage: true) })
        m.addItem(ActionItem("Stop Jukebox", enabled: running) { [weak self] in self?.server.stop() })
        return m
    }

    /// Quitting stops the jukebox first -- cleanly, so the queue is on disk --
    /// and only then lets the app go. Music keeps playing.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        NSLog("Party Jukebox: quit requested (server ours: \(server.ours), state: \(Self.word(server.state)))")
        guard server.ours, !quitting else { return .terminateNow }
        quitting = true
        server.stop {
            NSLog("Party Jukebox: server stopped; quitting")
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// SIGTERM (kill, a CI run, a logout script) goes through the same clean
    /// quit, rather than leaving the server running with no app.
    private func catchSigterm() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            NSLog("Party Jukebox: SIGTERM")
            NSApp.terminate(nil)
        }
        source.resume()
        signalSource = source
    }

    private static func portArgument(_ args: [String]) -> Int? {
        guard let i = args.firstIndex(of: "--port"), i + 1 < args.count else { return nil }
        return Int(args[i + 1])
    }

    // MARK: The icon

    private func paintIcon() {
        guard let button = statusItem?.button else { return }
        if button.image == nil {
            let image = NSImage(systemSymbolName: "music.note", accessibilityDescription: "Party Jukebox")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeft
        }
        let state = server.state
        button.title = state == .starting || state == .stopping ? "…" : ""
        button.appearsDisabled = state == .stopped
        let guests = server.network?.guestUrl.map { " · guests \(Self.hostPort($0))" } ?? ""
        button.toolTip = "Party Jukebox — \(Self.word(state))\(guests)"
    }

    private static func word(_ s: ServerController.State) -> String {
        switch s {
        case .stopped: return "stopped"
        case .starting: return "starting"
        case .running: return "running"
        case .stopping: return "stopping"
        }
    }

    static func hostPort(_ url: String) -> String {
        var s = url
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: The menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = server.state
        let running = state == .running

        let head: String
        switch state {
        case .running: head = server.external ? "Jukebox is running (not started by this app)" : "Jukebox is running"
        case .starting: head = "Jukebox is starting…"
        case .stopping: head = "Jukebox is stopping…"
        case .stopped: head = "Jukebox is stopped"
        }
        menu.addItem(TextItem(head))
        menu.addItem(TextItem(guestLine()))
        if let problem = server.lastProblem, state == .stopped {
            menu.addItem(TextItem(problem))
            menu.addItem(ActionItem("Show Log", indent: 1) { Self.open(Paths.log, app: "Console") })
        }
        menu.addItem(.separator())

        menu.addItem(ActionItem("Open Jukebox Page", enabled: running, key: "o") { [weak self] in self?.server.openPage() })
        menu.addItem(.separator())
        menu.addItem(ActionItem("Start Jukebox", enabled: state == .stopped && Paths.problem == nil) { [weak self] in
            self?.server.start(openPage: true)
        })
        menu.addItem(ActionItem("Stop Jukebox", enabled: running) { [weak self] in self?.server.stop() })
        menu.addItem(ActionItem("Restart Jukebox", enabled: running && server.ours) { [weak self] in self?.server.restart() })
        menu.addItem(.separator())

        addGuestNetwork(to: menu)
        menu.addItem(.separator())

        addUpdates(to: menu)
        menu.addItem(.separator())

        menu.addItem(ActionItem("Edit Settings…") { [weak self] in self?.editSettings() })
        menu.addItem(ActionItem("Show Log") { Self.open(Paths.log, app: "Console") })
        menu.addItem(.separator())
        menu.addItem(ActionItem("Quit Party Jukebox", key: "q") { NSApp.terminate(nil) })
    }

    private func guestLine() -> String {
        if let net = server.network {
            var line = net.guestUrl.map { "Guests: \(Self.hostPort($0))" } ?? "Guests: no network address"
            if net.chosenMissing, let choice = net.choice {
                line += " (\(Network.labels()[choice] ?? choice) not connected)"
            }
            return line
        }
        // Stopped, or not answering yet: what the next start will most likely give.
        let adapters = Network.adapters()
        if let choice = Network.readChoice(), let a = adapters.first(where: { $0.name == choice }) {
            return "Guests: \(a.ip):\(server.port)"
        }
        if Settings.pinsPublicUrl() { return "Guests: as set in jukebox.conf" }
        let primary = Network.primaryInterface()
        if let a = adapters.first(where: { $0.name == primary }) ?? adapters.first {
            return "Guests: \(a.ip):\(server.port)"
        }
        return "Guests: no network address"
    }

    private func addGuestNetwork(to menu: NSMenu) {
        menu.addItem(TextItem("Guest Network"))
        let adapters = Network.adapters()
        let choice = server.network?.choice ?? Network.readChoice()
        let primary = Network.primaryInterface()
        let autoWhat = Settings.pinsPublicUrl() ? "jukebox.conf"
            : (adapters.first { $0.name == primary } ?? adapters.first).map { $0.label ?? $0.name } ?? "no address"
        menu.addItem(ActionItem("Automatic — \(autoWhat)", checked: choice == nil, indent: 1) { [weak self] in
            self?.choose(nil)
        })
        for a in adapters {
            menu.addItem(ActionItem(a.title, checked: choice == a.name, indent: 1) { [weak self] in self?.choose(a.name) })
        }
        if let choice, !adapters.contains(where: { $0.name == choice }) {
            let label = Network.labels()[choice].map { "\($0) (\(choice))" } ?? choice
            menu.addItem(TextItem("\(label) — not connected", checked: true, indent: 1))
        }
        if adapters.isEmpty { menu.addItem(TextItem("No network address found", indent: 1)) }
    }

    /// Through the server when it is up -- it writes the same file and redraws
    /// the QR code on the cabinet there and then -- else straight to disk.
    private func choose(_ name: String?) {
        guard server.state == .running else {
            Network.writeChoice(name)
            return
        }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/api/host/network")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["interface": name.map { $0 as Any } ?? NSNull()]     // null means automatic
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { [weak self] in
                if !ok { Network.writeChoice(name) }      // an older server: the file alone
                self?.server.probe()
            }
        }.resume()
    }

    private func addUpdates(to menu: NSMenu) {
        switch updater.phase {
        case .checking, .downloading, .installing:
            menu.addItem(TextItem(updater.statusLine))
        case .available:
            let n = updater.available?.build ?? 0
            menu.addItem(ActionItem("Install Update (build \(n))…") { [weak self] in
                if let r = self?.updater.available { self?.offer(r) }
            })
            menu.addItem(TextItem(updater.statusLine, indent: 1))
        default:
            menu.addItem(ActionItem("Check for Updates…") { [weak self] in self?.updater.check(userAsked: true) })
            menu.addItem(TextItem(updater.statusLine, indent: 1))
        }
        menu.addItem(ActionItem("Get Preview Builds", checked: updater.previews, indent: 1) { [weak self] in
            guard let self else { return }
            self.updater.previews.toggle()
        })
    }

    // MARK: Updates: ask first

    private func offer(_ release: Updates.Release) {
        if let problem = updater.installProblem {
            alert("Build \(release.build) of Party Jukebox is ready", problem, buttons: ["OK"])
            return
        }
        let playing = server.state == .running
        let detail = playing
            ? "Installing stops the jukebox for about ten seconds while Party Jukebox restarts. The queue is kept, and Music keeps playing."
            : "Party Jukebox will quit, update and reopen."
        let answer = alert("Build \(release.build) of Party Jukebox is ready",
                           "You have build \(updater.build). \(detail)",
                           buttons: ["Install", "Later"])
        if answer == .alertFirstButtonReturn { updater.install() }
    }

    @discardableResult
    private func alert(_ title: String, _ text: String, buttons: [String]) -> NSApplication.ModalResponse {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        buttons.forEach { a.addButton(withTitle: $0) }
        return a.runModal()
    }

    // MARK: Settings and the log

    private func editSettings() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: Paths.conf.path) {
            try? fm.copyItem(at: Paths.confExample, to: Paths.conf)
        }
        Self.open(Paths.conf, app: "TextEdit")
        if server.state == .running {
            alert("Restart the jukebox to apply changes",
                  "Settings are read when the jukebox starts. After saving, choose Restart Jukebox from the menu.",
                  buttons: ["OK"])
        }
    }

    private static func open(_ file: URL, app: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", app, file.path]
        try? p.run()
    }

    // MARK: The main menu (the app menu at the top of the screen)

    private func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Party Jukebox",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Party Jukebox", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Party Jukebox", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = main
    }
}

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, enabled: Bool = true, checked: Bool = false, indent: Int = 0, key: String = "",
         _ handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(ActionItem.fire), keyEquivalent: key)
        target = self
        isEnabled = enabled
        state = checked ? .on : .off
        indentationLevel = indent
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func fire() { handler() }
}

/// A line of text in the menu that is not a button.
final class TextItem: NSMenuItem {
    init(_ title: String, checked: Bool = false, indent: Int = 0) {
        super.init(title: title, action: nil, keyEquivalent: "")
        isEnabled = false
        state = checked ? .on : .off
        indentationLevel = indent
    }

    required init(coder: NSCoder) { fatalError("not used") }
}
