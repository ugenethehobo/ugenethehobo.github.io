import SwiftUI
import WidgetKit

/// Lock Screen widgets: inside temperature and target. Tapping opens the app.
struct LockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HomeClimate.lock", provider: ClimateProvider()) { entry in
            LockWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Thermostat")
        .description("Inside temperature and target at a glance.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct LockWidgetView: View {
    let entry: ClimateEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let s = entry.state {
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: 0) {
                        Image(systemName: s.mode.symbol)
                            .font(.system(size: 10))
                        Text(Temp.reading(s.measured, unit: s.unit))
                            .font(.system(size: 17, weight: .semibold, design: .rounded))
                            .minimumScaleFactor(0.6)
                        if s.mode != .off {
                            Text("→\(Temp.target(s.program.target, unit: s.unit))")
                                .font(.system(size: 10))
                        }
                    }
                }
            case .accessoryInline:
                Text("\(Temp.reading(s.measured, unit: s.unit)) · \(s.mode.title)\(s.mode == .off ? "" : " \(Temp.target(s.program.target, unit: s.unit))")")
            default:
                VStack(alignment: .leading, spacing: 1) {
                    Text("Inside \(Temp.reading(s.measured, unit: s.unit))")
                        .font(.headline)
                    Text(s.mode == .off ? "System off" : "\(s.mode.title) \(Temp.target(s.program.target, unit: s.unit))")
                    Text(s.actionText)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            Image(systemName: "thermometer.medium")
        }
    }
}
