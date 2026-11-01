import Foundation

/*
 * Where everything lives. The app's own bundle is read-only and replaced by
 * every update, so nothing the jukebox writes goes in it: the queue, the
 * adapter choice, the log and the artwork cache all live in
 * ~/Library/Application Support/Party Jukebox, and survive updates.
 */
enum Paths {
    static let support: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Party Jukebox", isDirectory: true)

    static var data: URL { support.appendingPathComponent("data", isDirectory: true) }
    static var artwork: URL { support.appendingPathComponent("artwork", isDirectory: true) }
    /// The same file the git install read, in the same shell syntax: guest
    /// rules, PUBLIC_URL, the Wi-Fi QR code. Sourced by /bin/sh, as before.
    static var conf: URL { support.appendingPathComponent("jukebox.conf") }
    static var log: URL { data.appendingPathComponent("jukebox.log") }
    static var networkChoice: URL { data.appendingPathComponent("network.json") }

    /// The pinned Node CI puts beside the app's own executable.
    static var node: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node") }
    /// server.js, lib/, public/, scripts/: the jukebox itself, as in the repo.
    static var jukebox: URL {
        (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("jukebox", isDirectory: true)
    }
    static var confExample: URL { jukebox.appendingPathComponent("jukebox.conf.example") }

    /// The git install this app replaces, where the README put it.
    static var gitInstall: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Developer/apple-music-jukebox", isDirectory: true)
    }

    static func ensure() {
        for dir in [support, data, artwork] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    /// A build without Node or the jukebox in it (a bare Xcode build) can
    /// show its menu but cannot play anything.
    static var problem: String? {
        let fm = FileManager.default
        if !fm.isExecutableFile(atPath: node.path) { return "This build has no Node in it." }
        if !fm.fileExists(atPath: jukebox.appendingPathComponent("server.js").path) { return "This build has no jukebox in it." }
        return nil
    }

    /// First run on a Mac that had the git install: bring its settings, its
    /// adapter choice and its queue state across, once. Same Mac, same Music
    /// library, so the queue's persistent IDs still mean the same songs.
    static func importFromGitInstall() -> [String] {
        let fm = FileManager.default
        var brought: [String] = []
        let pairs: [(URL, URL, String)] = [
            (gitInstall.appendingPathComponent("jukebox.conf"), conf, "jukebox.conf"),
            (gitInstall.appendingPathComponent("data/network.json"), networkChoice, "the guest network choice"),
            (gitInstall.appendingPathComponent("data/state.json"), data.appendingPathComponent("state.json"), "the queue and genre buttons"),
        ]
        for (from, to, what) in pairs where fm.fileExists(atPath: from.path) && !fm.fileExists(atPath: to.path) {
            if (try? fm.copyItem(at: from, to: to)) != nil { brought.append(what) }
        }
        return brought
    }
}

/// The few settings the app itself needs to know. Everything else in
/// jukebox.conf is the server's business and reaches it through the shell.
enum Settings {
    /// PORT=NNNN in jukebox.conf, else 8484. Read here because the app has to
    /// know where to look for the server it started.
    static func port() -> Int {
        guard let text = try? String(contentsOf: Paths.conf, encoding: .utf8) else { return 8484 }
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("PORT=") || line.hasPrefix("export PORT=") else { continue }
            let value = line.split(separator: "=", maxSplits: 1).last.map(String.init) ?? ""
            let digits = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            if let n = Int(digits), (1024...65535).contains(n) { return n }
        }
        return 8484
    }

    /// Whether jukebox.conf pins PUBLIC_URL: only to say so in the menu.
    static func pinsPublicUrl() -> Bool {
        guard let text = try? String(contentsOf: Paths.conf, encoding: .utf8) else { return false }
        return text.split(whereSeparator: \.isNewline).contains {
            let line = $0.trimmingCharacters(in: .whitespaces)
            return line.hasPrefix("PUBLIC_URL=") || line.hasPrefix("export PUBLIC_URL=")
        }
    }
}
