import AppIntents
import SwiftUI
import WidgetKit

// Control Center / Lock Screen / Action button controls (iOS 18).

struct WarmerControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HomeClimate.warmer") {
            ControlWidgetButton(action: AdjustTemperatureIntent(steps: 1)) {
                Label("Warmer", systemImage: "plus.circle")
            }
        }
        .displayName("Warmer")
        .description("Raise the set temperature one step.")
    }
}

struct CoolerControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HomeClimate.cooler") {
            ControlWidgetButton(action: AdjustTemperatureIntent(steps: -1)) {
                Label("Cooler", systemImage: "minus.circle")
            }
        }
        .displayName("Cooler")
        .description("Lower the set temperature one step.")
    }
}

struct ModeControlConfiguration: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Thermostat Mode"

    @Parameter(title: "Mode", default: .cool)
    var mode: ModeOption
}

struct ModeControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: "HomeClimate.mode", intent: ModeControlConfiguration.self) { config in
            ControlWidgetButton(action: SetModeIntent(mode: config.mode)) {
                Label(config.mode.title, systemImage: config.mode.symbol)
            }
        }
        .displayName("Thermostat Mode")
        .description("Switch the thermostat to a mode you choose.")
        .promptsForUserConfiguration()
    }
}

struct SensorControlConfiguration: ControlConfigurationIntent {
    static let title: LocalizedStringResource = "Temperature Sensor"

    @Parameter(title: "Sensor")
    var sensor: SensorEntity?
}

struct SensorControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind: "HomeClimate.sensor", intent: SensorControlConfiguration.self) { config in
            ControlWidgetButton(action: UseSensorIntent(sensor: config.sensor)) {
                Label(config.sensor?.name ?? "Choose sensor", systemImage: "sensor")
            }
        }
        .displayName("Use Sensor")
        .description("Make the thermostat follow a sensor you choose.")
        .promptsForUserConfiguration()
    }
}
