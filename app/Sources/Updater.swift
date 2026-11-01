import AppKit
import Security

/*
 * Keeps Party Jukebox up to date from its GitHub releases. Ported from
 * busy-bar-sign's updater, with one deliberate difference: it never installs
 * on its own. It looks at launch and every four hours, says once per build
 * that one is ready, and installs only when you say Install -- and if the
 * jukebox is playing, it says so first. A party is the one place an update
 * is pure risk, so the decision stays with the host.
 *
 * A download is only installed if it is signed with the same certificate as
 * the app that is running (tools/sign.sh): its signature must satisfy this
 * app's own designated requirement. An app signed ad hoc has nothing to
 * match, so it never installs anything. The swap happens after the app
 * quits -- the old copy moved aside, the new one put in its place, then
 * opened -- and a download made here is not quarantined, so there is no
 * second Open Anyway. Permissions (control Music) carry over: to macOS it is
 * the same app.
 */
@MainActor
final class Updater {
    enum Phase: Equatable {
        case idle, checking, upToDate, available, downloading, installing
        case failed(String)
    }

    private(set) var phase: Phase = .idle { didSet { onChange?() } }
    private(set) var available: Updates.Release?
    private(set) var lastChecked: Date?

    var previews: Bool = UserDefaults.standard.object(forKey: "getPreviewBuilds") as? Bool
        ?? (Bundle.main.object(forInfoDictionaryKey: "PJUpdateChannel") as? String == "preview") {
        didSet {
            UserDefaults.standard.set(previews, forKey: "getPreviewBuilds")
            if previews != oldValue { check(userAsked: false) }
        }
    }

    let build = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    let channel = Bundle.main.object(forInfoDictionaryKey: "PJUpdateChannel") as? String ?? "latest"

    var onChange: (() -> Void)?
    /// Called once per newly found build, to ask the host.
    var onFound: ((Updates.Release) -> Void)?
    /// Stops the jukebox before the swap; calls back once it has stopped.
    var stopJukebox: (@escaping () -> Void) -> Void = { $0() }

    private var timer: Timer?
    /// The last build the host was told about, so it is said once, not every four hours.
    private var announced: Int {
        get { UserDefaults.standard.integer(forKey: "announcedBuild") }
        set { UserDefaults.standard.set(newValue, forKey: "announcedBuild") }
    }

    static let checkEvery: TimeInterval = 4 * 3600

    func start() {
        let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if Date().timeIntervalSince(self.lastChecked ?? .distantPast) >= Self.checkEvery {
                    self.check(userAsked: false)
                }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        // a moment after launch, not during it
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            self?.check(userAsked: false)
        }
    }

    /// Why the app cannot replace itself where it is, or nil when it can.
    var installProblem: String? {
        let app = Bundle.main.bundleURL
        if app.path.contains("/AppTranslocation/") {
            return "Move Party Jukebox to the Applications folder first."
        }
        let fm = FileManager.default
        guard fm.isWritableFile(atPath: app.deletingLastPathComponent().path), fm.isWritableFile(atPath: app.path) else {
            return "Party Jukebox can't replace itself in \(app.deletingLastPathComponent().path): download it from the release page."
        }
        return nil
    }

    var releasePage: URL {
        URL(string: "https://github.com/\(Updates.repository)/releases/tag/\(channel)")!
    }

    // MARK: Checking

    /// `userAsked`: from the menu, so say the result even when it is "up to
    /// date", and offer a build even if it was offered before.
    func check(userAsked: Bool) {
        guard phase != .checking, phase != .downloading, phase != .installing else { return }
        phase = .checking
        let previews = self.previews
        Task {
            var found: [Updates.Release] = []
            for c in Updates.channels(previews: previews) {
                if let release = await fetch(c) { found.append(release) }
            }
            lastChecked = Date()
            available = Updates.newest(found, after: build)
            if found.isEmpty {
                phase = .failed("Couldn't reach GitHub")
            } else {
                phase = available == nil ? .upToDate : .available
            }
            if let next = available, userAsked || next.build != announced {
                announced = next.build
                onFound?(next)
            }
        }
    }

    private func fetch(_ channel: String) async -> Updates.Release? {
        var request = URLRequest(url: Updates.url(channel, "PartyJukebox.json"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        guard let got = try? await URLSession.shared.data(for: request),
              (got.1 as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return Updates.decode(got.0)
    }

    // MARK: Installing

    enum UpdateError: LocalizedError {
        case download, unzip, notTheApp, adHoc, signature(OSStatus)
        var errorDescription: String? {
            switch self {
            case .download: return "The download didn't finish"
            case .unzip: return "The download wouldn't unzip"
            case .notTheApp: return "The download isn't the build expected"
            case .adHoc: return "This copy isn't signed with the project's certificate, so it can't check an update: download it from the release page"
            case .signature(let status): return "The download isn't signed with the project's certificate (\(status)), so it wasn't installed"
            }
        }
    }

    /// Downloads the newer build and checks it while the jukebox keeps
    /// playing; only then stops it, swaps the app and reopens.
    func install() {
        guard let release = available, phase == .available || isFailed else { return }
        if let problem = installProblem {
            phase = .failed(problem)
            return
        }
        let target = Bundle.main.bundleURL
        phase = .downloading
        Task {
            do {
                // beside the app, on the same disk, so the swap is a rename
                let dir = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                                      appropriateFor: target, create: true)
                let zip = dir.appendingPathComponent("PartyJukebox.zip")
                var request = URLRequest(url: Updates.url(release.channel, "PartyJukebox.zip"))
                request.cachePolicy = .reloadIgnoringLocalCacheData
                let (file, response) = try await URLSession.shared.download(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.download }
                try FileManager.default.moveItem(at: file, to: zip)
                guard await Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, dir.path]) == 0 else { throw UpdateError.unzip }
                try? FileManager.default.removeItem(at: zip)
                let app = dir.appendingPathComponent(target.lastPathComponent)
                _ = await Self.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
                try Self.verify(app, build: release.build)
                phase = .installing
                stopJukebox { [weak self] in
                    do { try self?.relaunch(replacing: target, with: app) }
                    catch { self?.phase = .failed(error.localizedDescription) }
                }
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    /// The download must be this app, the build expected, and signed with the
    /// certificate this one is: it must satisfy this app's designated requirement.
    private static func verify(_ app: URL, build: Int) throws {
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier,
              Int(info["CFBundleVersion"] as? String ?? "") == build else { throw UpdateError.notTheApp }

        var me: SecCode?
        var mine: SecStaticCode?
        var requirement: SecRequirement?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
              SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine,
              SecCodeCopyDesignatedRequirement(mine, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateError.adHoc
        }
        var text: CFString?
        SecRequirementCopyString(requirement, [], &text)
        // ad hoc, the requirement is this build's own hash, which no other build can meet
        guard let text, (text as String).contains("certificate") else { throw UpdateError.adHoc }

        var download: SecStaticCode?
        let created = SecStaticCodeCreateWithPath(app as CFURL, [], &download)
        guard created == errSecSuccess, let download else { throw UpdateError.signature(created) }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSStrictValidate)
                               | UInt32(kSecCSCheckNestedCode))
        let status = SecStaticCodeCheckValidityWithErrors(download, flags, requirement, nil)
        guard status == errSecSuccess else { throw UpdateError.signature(status) }
    }

    /// Quits, and leaves a shell to swap the apps once it has, then open the new one.
    private func relaunch(replacing target: URL, with app: URL) throws {
        let script = """
        while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done
        /bin/rm -rf "$2.old"
        if /bin/mv "$2" "$2.old"; then
          if /bin/mv "$3" "$2"; then /bin/rm -rf "$2.old"; else /bin/mv "$2.old" "$2"; fi
        fi
        /usr/bin/open "$2"
        """
        let swap = Process()
        swap.executableURL = URL(fileURLWithPath: "/bin/sh")
        swap.arguments = ["-c", script, "partyjukebox-update", String(getpid()), target.path, app.path]
        try swap.run()
        NSApp.terminate(nil)
    }

    private static func run(_ tool: String, _ arguments: [String]) async -> Int32 {
        await withCheckedContinuation { done in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = arguments
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { done.resume(returning: $0.terminationStatus) }
            do { try p.run() } catch { done.resume(returning: -1) }
        }
    }

    /// One line for the menu: what is happening, or what is there.
    var statusLine: String {
        switch phase {
        case .idle: return "Build \(build)"
        case .checking: return "Checking for updates…"
        case .upToDate:
            return "Up to date, build \(build)" + (lastChecked.map { " · checked \($0.formatted(date: .omitted, time: .shortened))" } ?? "")
        case .available: return "Build \(available?.build ?? 0) is ready (you have \(build))"
        case .downloading: return "Downloading build \(available?.build ?? 0)…"
        case .installing: return "Installing; Party Jukebox will reopen…"
        case .failed(let why): return why
        }
    }
}
