import AppIntents
import Foundation

// Actions shared by the app, the widgets' buttons, Control Center / Lock
// Screen controls, and Siri / Shortcuts.

enum ModeOption: String, AppEnum, CaseIterable {
    case off, heat, cool, smart

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mode")
    static let caseDisplayRepresentations: [ModeOption: DisplayRepresentation] = [
        .off: DisplayRepresentation(title: "Off", image: .init(systemName: "power")),
        .heat: DisplayRepresentation(title: "Heat", image: .init(systemName: "flame.fill")),
        .cool: DisplayRepresentation(title: "Cool", image: .init(systemName: "snowflake")),
        .smart: DisplayRepresentation(title: "Smart", image: .init(systemName: "sparkles")),
    ]

    var title: String {
        switch self {
        case .off: return "Off"
        case .heat: return "Heat"
        case .cool: return "Cool"
        case .smart: return "Smart"
        }
    }

    var symbol: String {
        switch self {
        case .off: return "power"
        case .heat: return "flame.fill"
        case .cool: return "snowflake"
        case .smart: return "sparkles"
        }
    }
}

struct SensorEntity: AppEntity {
    let id: String
    let name: String

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Sensor")
    static let defaultQuery = SensorQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct SensorQuery: EntityQuery {
    func entities(for identifiers: [SensorEntity.ID]) async throws -> [SensorEntity] {
        await all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [SensorEntity] {
        await all()
    }

    private func all() async -> [SensorEntity] {
        let state = await Climate.latest()
        return (state?.sensors ?? []).filter(\.eligible).map { SensorEntity(id: $0.id, name: $0.name) }
    }
}

struct AdjustTemperatureIntent: AppIntent {
    static let title: LocalizedStringResource = "Adjust Temperature"
    static let description = IntentDescription("Raise or lower the set temperature by a number of steps (1 °F or 0.5 °C each).")

    @Parameter(title: "Steps", default: 1)
    var steps: Int

    init() {}

    init(steps: Int) {
        self.steps = steps
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let unit = SharedStore.lastState?.unit ?? "F"
        let state = try await Climate.control(["delta": Double(steps) * Temp.stepF(unit: unit)])
        return .result(dialog: "Set to \(Temp.target(state.program.target, unit: state.unit))")
    }
}

struct SetTemperatureIntent: AppIntent {
    static let title: LocalizedStringResource = "Set Temperature"
    static let description = IntentDescription("Set the target temperature, in the units the app shows.")

    @Parameter(title: "Temperature")
    var temperature: Double

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let unit = SharedStore.lastState?.unit ?? "F"
        let state = try await Climate.control(["target": Temp.fromUnit(temperature, unit: unit)])
        return .result(dialog: "Set to \(Temp.target(state.program.target, unit: state.unit))")
    }
}

struct SetModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Set Thermostat Mode"
    static let description = IntentDescription("Switch between Off, Heat, Cool and Smart.")

    @Parameter(title: "Mode", default: .heat)
    var mode: ModeOption

    init() {}

    init(mode: ModeOption) {
        self.mode = mode
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Climate.control(["mode": mode.rawValue])
        return .result(dialog: "Thermostat set to \(mode.title)")
    }
}

struct UseSensorIntent: AppIntent {
    static let title: LocalizedStringResource = "Use Temperature Sensor"
    static let description = IntentDescription("Choose which sensor the thermostat follows. Turn on Combine to add it to the current ones instead.")

    @Parameter(title: "Sensor")
    var sensor: SensorEntity?

    @Parameter(title: "Combine with current sensors", default: false)
    var combine: Bool

    init() {}

    init(sensor: SensorEntity?, combine: Bool = false) {
        self.sensor = sensor
        self.combine = combine
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let sensor else { throw ClimateError(message: "Choose a sensor first") }
        var sensors = [sensor.id]
        if combine, let current = await Climate.latest()?.program.sensors {
            sensors = Array(Set(current + [sensor.id]))
        }
        try await Climate.control(["sensors": sensors])
        return .result(dialog: combine ? "Added \(sensor.name)" : "Now following \(sensor.name)")
    }
}

struct ResumeScheduleIntent: AppIntent {
    static let title: LocalizedStringResource = "Resume Schedule"
    static let description = IntentDescription("End a manual hold and go back to the schedule.")

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        try await Climate.resume()
        return .result(dialog: "Back on schedule")
    }
}
