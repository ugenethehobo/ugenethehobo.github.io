import Foundation
import SwiftUI

// What the server sends back (GET /api/state and after every change).

struct HomeState: Codable {
    var now: Double
    var tz: String
    var settings: HouseSettings
    var sun: SunTimes?
    var lights: [Light]
    var rooms: [String]
    var hubs: [Hub]
    var scan: ScanState
    var schedules: [Schedule]
    var nextSchedule: NextSchedule?
    var chiefs: Chiefs
    var log: [LogEntry]

    var onCount: Int { lights.filter { $0.on && $0.reachable }.count }

    /// Rooms in display order, with lights that have no room at the end.
    var groups: [(room: String, lights: [Light])] {
        var out: [(String, [Light])] = []
        for room in rooms {
            let ls = lights.filter { $0.room == room }
            if !ls.isEmpty { out.append((room, ls)) }
        }
        let loose = lights.filter { $0.room.isEmpty || !rooms.contains($0.room) }
        if !loose.isEmpty { out.append((rooms.isEmpty ? "Lights" : "Other lights", loose)) }
        return out
    }

    func light(_ id: String) -> Light? { lights.first { $0.id == id } }
}

struct HouseSettings: Codable {
    var tz: String?
    var lat: Double?
    var lon: Double?
    var place: String?
}

struct SunTimes: Codable {
    var sunrise: Double
    var sunset: Double
}

struct Caps: Codable, Hashable {
    var xy: Bool
    var ct: Bool
}

struct Light: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var room: String
    var hub: String?
    var model: String?
    var caps: Caps?
    var on: Bool
    var bri: Int
    var xy: [Double]?
    var ct: Int?
    var mode: String?
    var connected: Bool?
    var unpaired: Bool?
    var standby: Bool?
    var hubOnline: Bool
    var reachable: Bool
    var hex: String
    var inGame: Bool

    var percent: Int { max(1, Int((Double(bri) / 254 * 100).rounded())) }
    var color: Color { Color(hex: hex) }
    var canColor: Bool { caps?.xy ?? true }
    var canWhite: Bool { caps?.ct ?? true }

    var status: String {
        if unpaired == true { return "Needs pairing again" }
        if !hubOnline { return "Hub offline" }
        if !reachable { return "Not reachable" }
        return on ? "\(percent)%" : "Off"
    }
}

struct Hub: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var fw: String?
    var online: Bool
    var pending: Bool
    var lights: Int
    var since: Double?
}

struct ScanState: Codable {
    var running: Bool
    var until: Double
    var found: [FoundLight]
}

struct FoundLight: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var rssi: Int
    var hub: String
    var addrType: Int?
    var status: String
    var error: String?
    var known: Bool
}

struct Schedule: Codable, Identifiable, Hashable {
    struct Target: Codable, Hashable {
        var all: Bool?
        var rooms: [String]?
        var lights: [String]?
    }

    struct Action: Codable, Hashable {
        var power: String
        var bri: Int?
        var color: String?
        var ct: Int?
        var fade: Int
    }

    var id: String
    var name: String
    var enabled: Bool
    var days: [Int]
    var time: String?
    var sun: String?
    var offset: Int
    var target: Target
    var action: Action

    static func new() -> Schedule {
        Schedule(
            id: UUID().uuidString.prefix(8).lowercased(), name: "New schedule", enabled: true, days: [0, 1, 2, 3, 4, 5, 6],
            time: "07:00", sun: nil, offset: 0, target: Target(all: true, rooms: nil, lights: nil),
            action: Action(power: "on", bri: 254, color: nil, ct: 366, fade: 0)
        )
    }
}

struct NextSchedule: Codable {
    var id: String
    var name: String
    var at: Double
}

struct Team: Codable, Hashable {
    var id: String
    var abbr: String
    var name: String
    var color: String?
    var alt: String?
}

struct Score: Codable, Hashable {
    var us: Int
    var opp: Int
    var period: Int?
    var clock: String?
}

struct Game: Codable, Hashable {
    var id: String
    var name: String
    var start: Double
    var home: Bool
    var us: Team
    var opp: Team
    var detail: String?
    var score: Score?
    var pregameAt: Double
}

struct LastPlay: Codable, Hashable {
    var text: String
    var wall: Double?
    var seenAt: Double
}

struct FeedItem: Codable, Hashable, Identifiable {
    var kind: String
    var label: String
    var text: String
    var at: Double
    var id: String { "\(kind)-\(at)" }
}

struct GameEvent: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var who: String
}

struct ChiefsSettings: Codable, Hashable {
    var enabled: Bool
    var teamId: String
    var lights: [String]
    var bri: Int
    var pregameMin: Int
    var afterGame: String
    var postgameMin: Int
    var delaySec: Int
    var pollSec: Int
    var events: [String: Bool]
}

struct Chiefs: Codable {
    var settings: ChiefsSettings
    var events: [GameEvent]
    var phase: String
    var active: Bool
    var manual: Bool
    var game: Game?
    var lastPlay: LastPlay?
    var recent: [FeedItem]
    var espnLagSec: Int?
    var restoreAt: Double?
    var nextCheck: Double?
    var error: String?
    var polling: Bool
}

struct LogEntry: Codable, Hashable, Identifiable {
    var at: Double
    var by: String?
    var text: String
    var id: String { "\(at)-\(text)" }
}

// MARK: - helpers

extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let n = UInt64(s, radix: 16) ?? 0xFFFFFF
        self.init(red: Double((n >> 16) & 0xFF) / 255, green: Double((n >> 8) & 0xFF) / 255, blue: Double(n & 0xFF) / 255)
    }

    var hexString: String {
        let ui = UIColor(self)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        ui.getRed(&r, green: &g, blue: &b, alpha: &a)
        func c(_ v: CGFloat) -> Int { Int((min(1, max(0, v)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", c(r), c(g), c(b))
    }
}

/// Quick colour choices, shared by the app's pickers.
enum Palette {
    static let chiefsRed = "#e31837"
    static let chiefsGold = "#ffb612"
    static let swatches: [(name: String, hex: String)] = [
        ("Chiefs red", chiefsRed), ("Gold", chiefsGold), ("Orange", "#ff7a1a"), ("Pink", "#ff4fa3"),
        ("Purple", "#8a4dff"), ("Blue", "#2f6bff"), ("Teal", "#19c3b0"), ("Green", "#3ccf4e"),
    ]
    /// White temperatures in mireds.
    static let whites: [(name: String, ct: Int)] = [("Candle", 454), ("Warm", 366), ("Neutral", 250), ("Daylight", 175)]
}
