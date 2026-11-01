import Foundation
import SystemConfiguration

/*
 * The Guest Network section: which adapters have an address the phones could
 * use, what to call them, and the choice the server reads (data/network.json,
 * the same file and format lib/net.js reads and writes). While the server
 * runs it is the authority on what guests get -- it is asked, not second-
 * guessed; this is only for the list, and for the stopped state.
 */
struct Adapter: Equatable {
    let name: String        // en0
    let ip: String          // 192.168.1.40
    let label: String?      // Wi-Fi

    var title: String { label.map { "\($0) (\(name)) — \(ip)" } ?? "\(name) — \(ip)" }
}

enum Network {
    /// Same rule as isPrivateIPv4 in lib/net.js: guests are never handed a public address.
    static func isPrivate(_ ip: String) -> Bool {
        let p = ip.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1]))
    }

    static func isInterfaceName(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 15 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    /// Every up, non-loopback interface with a private IPv4 address.
    static func adapters() -> [Adapter] {
        let names = labels()
        var out: [Adapter] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(truncatingIfNeeded: p.pointee.ifa_flags)
            guard let sa = p.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count),
                              nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(decoding: host.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            let name = String(cString: p.pointee.ifa_name)
            guard isPrivate(ip), !out.contains(where: { $0.name == name }) else { continue }
            out.append(Adapter(name: name, ip: ip, label: names[name]))
        }
        return out.sorted { $0.name < $1.name }
    }

    /// en0 -> "Wi-Fi", en1 -> "Ethernet": what System Settings calls them.
    static func labels() -> [String: String] {
        var out: [String: String] = [:]
        guard let all = SCNetworkInterfaceCopyAll() as? [SCNetworkInterface] else { return out }
        for i in all {
            if let bsd = SCNetworkInterfaceGetBSDName(i) as String?,
               let name = SCNetworkInterfaceGetLocalizedDisplayName(i) as String? {
                out[bsd] = name
            }
        }
        return out
    }

    /// The interface the Mac sends traffic out of: the routing table's answer,
    /// as lib/net.js gets from `route get default`.
    static func primaryInterface() -> String? {
        guard let store = SCDynamicStoreCreate(nil, "PartyJukebox" as CFString, nil, nil),
              let value = SCDynamicStoreCopyValue(store, "State:/Network/Global/IPv4" as CFString) as? [String: Any]
        else { return nil }
        return value["PrimaryInterface"] as? String
    }

    static func readChoice() -> String? {
        guard let data = try? Data(contentsOf: Paths.networkChoice),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = json["interface"] as? String, isInterfaceName(name) else { return nil }
        return name
    }

    /// nil puts it back to automatic. Written whole, then renamed into place.
    static func writeChoice(_ name: String?) {
        let fm = FileManager.default
        guard let name, isInterfaceName(name) else {
            try? fm.removeItem(at: Paths.networkChoice)
            return
        }
        Paths.ensure()
        let body: [String: Any] = ["interface": name, "chosenAt": ISO8601DateFormatter().string(from: Date())]
        if let data = try? JSONSerialization.data(withJSONObject: body) {
            try? data.write(to: Paths.networkChoice, options: .atomic)
        }
    }
}

/// What the running server says guests are given (GET /api/host/network).
struct ServerNetwork: Decodable, Equatable {
    var guestUrl: String?
    var source: String          // chosen | conf | auto | none
    var iface: String?
    var chosenMissing: Bool
    var choice: String?
}
