import Foundation

/*
 * Where updates come from, and which is newer: the part of the updater that
 * is not the Mac (Updater does the downloading and the swap). Ported from
 * busy-bar-sign. Each build CI publishes carries PartyJukebox.json beside
 * the app:
 *
 *   {"build": 41, "version": "1.0", "commit": "d477305", "channel": "latest"}
 *
 * `build` is the CI run's number, the app's CFBundleVersion: higher is newer.
 * Main's builds go to the "latest" release; a pull request's to "preview".
 * Every copy follows "latest"; with Get Preview Builds on, "preview" too.
 */
enum Updates {
    static let repository = "woody438/apple-music-jukebox"

    struct Release: Decodable, Equatable {
        var build: Int
        var version: String
        var commit: String
        var channel: String          // the release it is in: "latest" or "preview"
    }

    /// A file in a release.
    static func url(_ channel: String, _ file: String) -> URL {
        URL(string: "https://github.com/\(repository)/releases/download/\(channel)/\(file)")!
    }

    /// The releases followed: main's, and the preview's while previews are on.
    static func channels(previews: Bool) -> [String] {
        previews ? ["preview", "latest"] : ["latest"]
    }

    static func decode(_ data: Data) -> Release? {
        try? JSONDecoder().decode(Release.self, from: data)
    }

    /// The newest release built after `build`, if any.
    static func newest(_ releases: [Release], after build: Int) -> Release? {
        releases.filter { $0.build > build }.max { $0.build < $1.build }
    }
}
