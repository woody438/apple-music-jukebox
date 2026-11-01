import AppKit

/*
 * Starts, watches and stops the jukebox server: the bundled Node running the
 * bundled server.js, exactly the program the git install ran.
 *
 * Started through /bin/sh so that jukebox.conf is read by a real shell, as
 * both old launchers read it (`set -a; . jukebox.conf`): its quoting rules --
 * single quotes round a Wi-Fi password with a $ in it -- are the shell's, and
 * imitating them here would be a second, subtly different reader. The shell
 * then execs Node, so the pid this holds IS the server.
 *
 * The app is the server's parent, so it is the app macOS asks about when the
 * server first drives Music: "Party Jukebox wants to control Music". One
 * certificate signs every build (tools/sign.sh), so that answer carries over
 * from one update to the next.
 */
@MainActor
final class ServerController {
    enum State: Equatable { case stopped, starting, running, stopping }

    private(set) var state: State = .stopped { didSet { if state != oldValue { onChange?() } } }
    /// Answering on our port, but not a server this app started (the git
    /// install's, say). Stop still works: it finds the listener by its port.
    private(set) var external = false
    /// What guests are given, from the server itself, refreshed with each poll.
    private(set) var network: ServerNetwork?
    /// Why the server last stopped, when it was not asked to.
    private(set) var lastProblem: String?

    var onChange: (() -> Void)?

    let port: Int
    let mock: Bool

    private var process: Process?
    private var awake: NSObjectProtocol?
    private var timer: Timer?
    private var openPageWhenUp = false
    private var startedAt = Date.distantPast
    private var stopWaiters: [() -> Void] = []

    init(port: Int, mock: Bool) {
        self.port = port
        self.mock = mock
    }

    var pageURL: URL { URL(string: "http://localhost:\(port)/")! }
    var ours: Bool { process != nil }

    // MARK: Watching

    func startWatching() {
        let t = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.probe() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        probe()
    }

    /// Asks the server what it is giving guests. Any HTTP answer at all means
    /// something is up on the port; no answer means nothing is.
    func probe() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/host/network")!)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let up = response is HTTPURLResponse
            let net = (response as? HTTPURLResponse)?.statusCode == 200
                ? data.flatMap { try? JSONDecoder().decode(ServerNetwork.self, from: $0) } : nil
            DispatchQueue.main.async { [weak self] in self?.answered(up: up, network: net) }
        }.resume()
    }

    private func answered(up: Bool, network: ServerNetwork?) {
        let changed = network != self.network
        self.network = up ? network : nil
        if up {
            external = process == nil
            if state == .starting || state == .stopped {
                state = .running
                if openPageWhenUp { openPageWhenUp = false; openPage() }
            }
        } else if process == nil, state != .stopping {
            external = false
            state = .stopped
        }
        if changed { onChange?() }
    }

    // MARK: Starting

    func start(openPage: Bool) {
        if state == .running { if openPage { self.openPage() }; return }
        guard process == nil, state != .stopping else { return }
        if let problem = Paths.problem {
            lastProblem = problem
            onChange?()
            return
        }
        Paths.ensure()
        if !mock {
            // Music up before the server's first read, hidden: the cabinet is the show.
            let music = Process()
            music.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            music.arguments = ["-g", "-a", "Music"]
            try? music.run()
        }

        FileManager.default.createFile(atPath: Paths.log.path, contents: nil)     // a fresh log each start
        guard let log = try? FileHandle(forWritingTo: Paths.log) else {
            lastProblem = "Could not write the log in \(Paths.data.path)."
            onChange?()
            return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // $1 jukebox.conf, $2 node. The conf is sourced first and our own
        // values are set after it, so it cannot move the port or the data
        // out from under the app.
        p.arguments = ["-c", """
            set -a
            if [ -f "$1" ]; then . "$1"; fi
            set +a
            export PORT="$PJ_PORT" JUKEBOX_DATA_DIR="$PJ_DATA" JUKEBOX_ARTWORK_DIR="$PJ_ARTWORK"
            exec "$2" server.js
            """, "party-jukebox", Paths.conf.path, Paths.node.path]
        p.currentDirectoryURL = Paths.jukebox
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"      // osascript, route: by name, from here
        env["PJ_PORT"] = String(port)
        env["PJ_DATA"] = Paths.data.path
        env["PJ_ARTWORK"] = Paths.artwork.path
        if mock { env["MOCK"] = "1" } else { env.removeValue(forKey: "MOCK") }
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { proc in
            let status = proc.terminationStatus
            let signalled = proc.terminationReason == .uncaughtSignal
            DispatchQueue.main.async { [weak self] in self?.exited(status: status, signalled: signalled) }
        }
        do {
            try p.run()
        } catch {
            lastProblem = "Could not start the jukebox: \(error.localizedDescription)"
            onChange?()
            return
        }
        process = p
        lastProblem = nil
        startedAt = Date()
        openPageWhenUp = openPage
        state = .starting
        // What caffeinate -dims did for the git install: no sleep, no display
        // sleep, for exactly as long as the server lives.
        awake = ProcessInfo.processInfo.beginActivity(
            options: [.idleSystemSleepDisabled, .idleDisplaySleepDisabled, .userInitiated],
            reason: "Party Jukebox is running")
        // Look often while it comes up, rather than waiting for the 3 s tick.
        for delay in [0.5, 1.0, 1.5, 2.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                if self?.state == .starting { self?.probe() }
            }
        }
    }

    private func exited(status: Int32, signalled: Bool) {
        NSLog("Party Jukebox: server exited (status \(status)\(signalled ? ", signal" : ""))")
        process = nil
        if let awake { ProcessInfo.processInfo.endActivity(awake) }
        awake = nil
        if state != .stopping {
            let ran = Date().timeIntervalSince(startedAt)
            lastProblem = signalled
                ? "The jukebox was killed (signal \(status)). See the log."
                : ran < 15
                    ? "The jukebox stopped while starting (status \(status)). See the log."
                    : "The jukebox stopped unexpectedly (status \(status)). See the log."
        }
        network = nil
        state = .stopped
        let waiters = stopWaiters
        stopWaiters = []
        waiters.forEach { $0() }
        probe()                  // something else may still be on the port
    }

    // MARK: Stopping

    /// Stops the server. Music carries on playing whatever is on, and the
    /// queue is on disk for the next start. `done` runs once it has gone.
    func stop(_ done: (() -> Void)? = nil) {
        if let p = process {
            if let done { stopWaiters.append(done) }
            guard state != .stopping else { return }
            state = .stopping
            NSLog("Party Jukebox: stopping the server (pid \(p.processIdentifier))")
            p.terminate()                                    // SIGTERM: server.js shuts down cleanly
            let pid = p.processIdentifier
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self, self.process?.processIdentifier == pid else { return }
                kill(pid, SIGKILL)                           // it had its chance
            }
        } else if external, let pid = Self.listener(on: port) {
            // Not ours -- the git install's, or one started from Terminal.
            state = .stopping
            kill(pid, SIGTERM)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.state = .stopped
                self?.probe()
                done?()
            }
        } else {
            done?()
        }
    }

    func restart() {
        stop { [weak self] in self?.start(openPage: false) }
    }

    func openPage() {
        // localhost, never the LAN address: only localhost gets host rights.
        NSWorkspace.shared.open(pageURL)
    }

    /// The pid listening on a TCP port, as the Dock launcher asked for it.
    static func listener(on port: Int) -> pid_t? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return text.split(whereSeparator: \.isNewline).first.flatMap { pid_t($0) }
    }
}
