import AppIntents

/// Siri phrases and Shortcuts app actions. ("Lights" is the app's name on the
/// Home Screen, so Siri phrases use it.)
struct LightsShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AllLightsIntent(on: true),
            phrases: ["Turn on \(.applicationName)", "Turn on the lights with \(.applicationName)"],
            shortTitle: "All On",
            systemImageName: "lightbulb.fill"
        )
        AppShortcut(
            intent: AllLightsIntent(on: false),
            phrases: ["Turn off \(.applicationName)", "Turn off the lights with \(.applicationName)"],
            shortTitle: "All Off",
            systemImageName: "lightbulb.slash"
        )
        AppShortcut(
            intent: ChiefsColorsIntent(on: true),
            phrases: ["Chiefs colors in \(.applicationName)", "Go Chiefs with \(.applicationName)"],
            shortTitle: "Chiefs Colors",
            systemImageName: "football.fill"
        )
        AppShortcut(
            intent: TouchdownIntent(),
            phrases: ["Touchdown with \(.applicationName)"],
            shortTitle: "Touchdown",
            systemImageName: "sparkles"
        )
    }
}
