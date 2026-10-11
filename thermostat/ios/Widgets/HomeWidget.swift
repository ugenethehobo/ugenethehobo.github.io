import AppIntents
import SwiftUI
import WidgetKit

/// Home Screen widget: inside temperature, target with −/+ buttons, status,
/// and (medium size) mode buttons. Buttons work without opening the app.
struct HomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HomeClimate.home", provider: ClimateProvider()) { entry in
            HomeWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(
                        colors: [(entry.state?.mode.color ?? .gray).opacity(0.35), Color(.systemBackground)],
                        startPoint: .top, endPoint: .bottom
                    )
                }
        }
        .configurationDisplayName("Thermostat")
        .description("Inside temperature and quick controls.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct HomeWidgetView: View {
    let entry: ClimateEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let s = entry.state {
            if family == .systemMedium {
                HStack(spacing: 14) {
                    summary(s)
                    Divider()
                    modeButtons(s)
                }
            } else {
                summary(s)
            }
        } else {
            VStack(spacing: 6) {
                Image(systemName: "thermometer.medium")
                    .font(.title2)
                Text(entry.error ?? "Open Climate to sign in")
                    .font(.caption)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func summary(_ s: ClimateState) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: s.mode.symbol)
                    .foregroundStyle(s.mode.color)
                Text(s.actionText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .font(.caption.weight(.semibold))
            Text(Temp.reading(s.measured, unit: s.unit))
                .font(.system(size: 40, weight: .light, design: .rounded))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if s.mode == .off {
                Text("Off")
                    .font(.headline)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 6) {
                    Button(intent: AdjustTemperatureIntent(steps: -1)) {
                        Image(systemName: "minus")
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
                    Text(Temp.target(s.program.target, unit: s.unit))
                        .font(.headline.monospacedDigit())
                        .foregroundStyle(s.mode.color)
                        .frame(minWidth: 34)
                    Button(intent: AdjustTemperatureIntent(steps: 1)) {
                        Image(systemName: "plus")
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
                }
            }
            if entry.error != nil {
                Text("Offline · last update \(entry.date, style: .relative) ago")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func modeButtons(_ s: ClimateState) -> some View {
        VStack(spacing: 6) {
            ForEach(ModeOption.allCases, id: \.self) { mode in
                Button(intent: SetModeIntent(mode: mode)) {
                    Label(mode.title, systemImage: mode.symbol)
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .tint(s.mode == mode ? mode.color : .secondary)
            }
        }
        .frame(width: 110)
    }
}
