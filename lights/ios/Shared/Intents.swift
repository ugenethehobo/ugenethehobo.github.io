import AppIntents
import Foundation

// Actions shared by the app, the widgets' buttons, Control Center controls,
// and Siri / Shortcuts.

struct AllLightsIntent: AppIntent {
    static let title: LocalizedStringResource = "Turn All Lights On or Off"
    static let description = IntentDescription("Turn every light on or off.")

    @Parameter(title: "On", default: true)
    var on: Bool

    init() {}

    init(on: Bool) {
        self.on = on
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Lights.power(on)
        let text = on ? "Lights on" : "Lights off"
        return .result(dialog: "\(text)")
    }
}

struct RoomLightsIntent: AppIntent {
    static let title: LocalizedStringResource = "Turn a Room On or Off"
    static let description = IntentDescription("Turn the lights in one room on or off.")

    @Parameter(title: "Room")
    var room: String

    @Parameter(title: "On", default: true)
    var on: Bool

    init() {}

    init(room: String, on: Bool) {
        self.room = room
        self.on = on
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Lights.power(on, room: room)
        let state = on ? "on" : "off"
        return .result(dialog: "\(room) \(state)")
    }
}

/// The Control Center toggle for all lights.
struct SetAllLightsIntent: SetValueIntent {
    static let title: LocalizedStringResource = "All Lights"

    @Parameter(title: "On")
    var value: Bool

    init() {}

    func perform() async throws -> some IntentResult {
        try await Lights.power(value)
        return .result()
    }
}

struct ChiefsColorsIntent: AppIntent {
    static let title: LocalizedStringResource = "Chiefs Colors"
    static let description = IntentDescription("Turn the game lights Chiefs red now, or put them back to normal.")

    @Parameter(title: "On", default: true)
    var on: Bool

    init() {}

    init(on: Bool) {
        self.on = on
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Lights.call("/api/chiefs/mode", ["on": on])
        let text = on ? "Go Chiefs!" : "Lights back to normal"
        return .result(dialog: "\(text)")
    }
}

struct TouchdownIntent: AppIntent {
    static let title: LocalizedStringResource = "Touchdown Lights"
    static let description = IntentDescription("Play the touchdown light show now.")

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Lights.call("/api/chiefs/test", ["kind": "td"])
        return .result(dialog: "Touchdown!")
    }
}
