import Foundation

/// The compact state served by GET /api/widget. Temperatures are °F; `unit`
/// says how to show them.
struct ClimateState: Codable, Equatable {
    struct Connection: Codable, Equatable {
        var state: String
        var message: String?
        var lastPollAt: Double?
        var pollError: String?
    }

    struct Program: Codable, Equatable {
        var mode: String
        var target: Double
        var fan: String?
        var sensors: [String]
    }

    struct Thermostat: Codable, Equatable {
        var name: String
        var mode: String?
        var setpoint: Double?
        var humidity: Double?
    }

    struct Sensor: Codable, Equatable, Identifiable {
        var id: String
        var name: String
        var kind: String?
        var temp: Double?
        var inUse: Bool
        var eligible: Bool
        var reachable: Bool
    }

    struct FanMode: Codable, Equatable, Hashable {
        var value: String
        var label: String
    }

    struct Hold: Codable, Equatable {
        var until: Double?
        var by: String?
    }

    struct Next: Codable, Equatable {
        var at: Double
        var name: String?
        var mode: String
        var target: Double
    }

    var serverTime: Double
    var unit: String
    var connection: Connection
    var measured: Double?
    var source: String?
    var action: String
    var reason: String
    var program: Program
    var thermostat: Thermostat
    var sensorControl: Bool
    var sensors: [Sensor]
    var fanModes: [FanMode]
    var hold: Hold?
    var next: Next?
    var smartThreshold: Double
    var pending: Bool
    var lastError: String?

    var mode: ModeOption { ModeOption(rawValue: program.mode) ?? .off }

    /// "Cooling to 68°", "Idle", …
    var actionText: String {
        switch action {
        case "heating": return "Heating to \(Temp.target(program.target, unit: unit))"
        case "cooling": return "Cooling to \(Temp.target(program.target, unit: unit))"
        case "off": return "System off"
        case "unknown": return "Waiting for readings"
        default: return mode == .smart ? "Comfortable" : "Idle"
        }
    }

    var sourceText: String {
        let names = sensors.filter(\.inUse).map(\.name)
        if !names.isEmpty { return names.joined(separator: " + ") }
        return source == "selected" ? "Selected sensors" : thermostat.name
    }

    static let preview = ClimateState(
        serverTime: Date().timeIntervalSince1970 * 1000,
        unit: "F",
        connection: .init(state: "connected", message: nil, lastPollAt: Date().timeIntervalSince1970 * 1000, pollError: nil),
        measured: 67.6,
        source: "selected",
        action: "heating",
        reason: "",
        program: .init(mode: "heat", target: 69, fan: "1", sensors: ["a"]),
        thermostat: .init(name: "Thermostat", mode: "HEAT", setpoint: 69, humidity: 45),
        sensorControl: true,
        sensors: [
            .init(id: "t", name: "Thermostat", kind: "thermostat", temp: 68.1, inUse: false, eligible: true, reachable: true),
            .init(id: "a", name: "Bedroom", kind: "air-quality", temp: 67.6, inUse: true, eligible: true, reachable: true),
        ],
        fanModes: [.init(value: "1", label: "Auto"), .init(value: "2", label: "On")],
        hold: nil,
        next: nil,
        smartThreshold: 1,
        pending: false,
        lastError: nil
    )
}

/// Temperature formatting and the size of one −/+ step in °F.
enum Temp {
    static func toUnit(_ f: Double, unit: String) -> Double {
        unit == "C" ? (f - 32) / 1.8 : f
    }

    static func fromUnit(_ v: Double, unit: String) -> Double {
        unit == "C" ? v * 1.8 + 32 : v
    }

    /// One tap of −/+: 1 °F, or 0.5 °C (0.9 °F).
    static func stepF(unit: String) -> Double {
        unit == "C" ? 0.9 : 1
    }

    /// "68.4°"
    static func reading(_ f: Double?, unit: String) -> String {
        guard let f else { return "--" }
        let v = toUnit(f, unit: unit)
        let s = String(format: "%.1f", v)
        return (s.hasSuffix(".0") ? String(s.dropLast(2)) : s) + "°"
    }

    /// "68°" (whole degrees in °F, halves in °C)
    static func target(_ f: Double, unit: String) -> String {
        let v = toUnit(f, unit: unit)
        if unit == "C" {
            let r = (v * 2).rounded() / 2
            return (r == r.rounded() ? String(Int(r)) : String(format: "%.1f", r)) + "°"
        }
        return "\(Int(v.rounded()))°"
    }
}
