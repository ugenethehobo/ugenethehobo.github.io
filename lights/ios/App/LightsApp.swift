import SwiftUI

@main
struct LightsApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.signedIn {
                    HomeView()
                } else {
                    LoginView()
                }
            }
            .environmentObject(model)
            .onChange(of: phase, initial: true) { _, phase in
                if phase == .active { model.start() } else { model.stop() }
            }
        }
    }
}
