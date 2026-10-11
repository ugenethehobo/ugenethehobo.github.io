import SwiftUI

@main
struct HomeClimateApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if model.signedIn {
                    MainView()
                } else {
                    LoginView()
                }
            }
            .environmentObject(model)
        }
    }
}
