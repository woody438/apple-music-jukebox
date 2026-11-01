import Foundation

/*
 * jukebox.conf for the Settings window, through lib/conf.js and the app's
 * own Node. Nothing here understands the file: reading it means asking
 * /bin/sh, writing it means changing only the lines that changed and then
 * reading it back -- all of which conf.js does, and test/conf-suite.js
 * tests. A second reader written here would disagree with the shell on
 * exactly the Wi-Fi passwords that matter.
 */
struct ConfResult: Decodable {
    var ok: Bool
    var values: [String: String]?
    var defaults: [String: String]?
    var errors: [String: String]?
    var error: String?
    var unchanged: Bool?
}

enum ConfStore {
    private static var script: URL { Paths.jukebox.appendingPathComponent("lib/conf.js") }

    static func read() -> ConfResult {
        run(["read", Paths.conf.path], input: nil)
    }

    static func write(_ values: [String: String]) -> ConfResult {
        Paths.ensure()
        let data = (try? JSONSerialization.data(withJSONObject: values)) ?? Data("{}".utf8)
        return run(["write", Paths.conf.path, Paths.confExample.path], input: data)
    }

    private static func run(_ args: [String], input: Data?) -> ConfResult {
        if let problem = Paths.problem { return ConfResult(ok: false, error: problem) }
        let p = Process()
        p.executableURL = Paths.node
        p.arguments = [script.path] + args
        p.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory()]
        let out = Pipe()
        let inp = Pipe()
        p.standardOutput = out
        p.standardInput = inp
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch {
            return ConfResult(ok: false, error: "Could not run the settings helper: \(error.localizedDescription)")
        }
        if let input { inp.fileHandleForWriting.write(input) }
        try? inp.fileHandleForWriting.close()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (try? JSONDecoder().decode(ConfResult.self, from: data))
            ?? ConfResult(ok: false, error: "The settings helper gave no answer (status \(p.terminationStatus)).")
    }
}
