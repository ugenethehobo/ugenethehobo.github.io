import AppIntents

/// Siri phrases and Shortcuts app actions. ("Climate" is the app's name on
/// the Home Screen, so Siri phrases use it.)
struct ClimateShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AdjustTemperatureIntent(steps: 1),
            phrases: ["Make it warmer with \(.applicationName)", "Turn up \(.applicationName)"],
            shortTitle: "Warmer",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: AdjustTemperatureIntent(steps: -1),
            phrases: ["Make it cooler with \(.applicationName)", "Turn down \(.applicationName)"],
            shortTitle: "Cooler",
            systemImageName: "minus.circle"
        )
        AppShortcut(
            intent: SetModeIntent(),
            phrases: ["Set \(.applicationName) to \(\.$mode)", "Switch \(.applicationName) to \(\.$mode)"],
            shortTitle: "Set Mode",
            systemImageName: "thermometer.medium"
        )
        AppShortcut(
            intent: UseSensorIntent(),
            phrases: ["Use \(\.$sensor) with \(.applicationName)"],
            shortTitle: "Use Sensor",
            systemImageName: "sensor"
        )
        AppShortcut(
            intent: ResumeScheduleIntent(),
            phrases: ["Resume the \(.applicationName) schedule"],
            shortTitle: "Resume Schedule",
            systemImageName: "calendar"
        )
    }
}
