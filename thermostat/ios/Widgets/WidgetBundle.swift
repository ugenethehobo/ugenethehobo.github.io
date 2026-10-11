import SwiftUI
import WidgetKit

@main
struct HomeClimateWidgets: WidgetBundle {
    var body: some Widget {
        HomeWidget()
        LockWidget()
        WarmerControl()
        CoolerControl()
        ModeControl()
        SensorControl()
    }
}
