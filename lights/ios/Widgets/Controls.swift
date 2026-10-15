import AppIntents
import SwiftUI
import WidgetKit

// Control Center / Lock Screen / Action button controls (iOS 18).

struct AllLightsValue: ControlValueProvider {
    var previewValue: Bool { true }

    func currentValue() async throws -> Bool {
        let state = try await Lights.refresh(reloadWidgets: false)
        return state.onCount > 0
    }
}

struct AllLightsControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HomeLights.all", provider: AllLightsValue()) { isOn in
            ControlWidgetToggle("Lights", isOn: isOn, action: SetAllLightsIntent()) { on in
                Label(on ? "On" : "Off", systemImage: on ? "lightbulb.fill" : "lightbulb")
            }
        }
        .displayName("All Lights")
        .description("Turn every light on or off.")
    }
}

struct ChiefsControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "HomeLights.chiefs") {
            ControlWidgetButton(action: ChiefsColorsIntent(on: true)) {
                Label("Chiefs Colors", systemImage: "football.fill")
            }
        }
        .displayName("Chiefs Colors")
        .description("Turn the game lights Chiefs red.")
    }
}
