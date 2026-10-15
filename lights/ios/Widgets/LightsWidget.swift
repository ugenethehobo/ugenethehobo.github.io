import AppIntents
import SwiftUI
import WidgetKit

/// Home Screen widget: lights on, All on / All off, and (medium size) a
/// button per room. Buttons work without opening the app.
struct LightsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HomeLights.home", provider: LightsProvider()) { entry in
            LightsWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(
                        colors: [Color.orange.opacity((entry.state?.onCount ?? 0) > 0 ? 0.35 : 0.08), Color(.systemBackground)],
                        startPoint: .top, endPoint: .bottom
                    )
                }
        }
        .configurationDisplayName("Lights")
        .description("Turn lights and rooms on and off.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct LightsWidgetView: View {
    let entry: LightsEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let s = entry.state {
            if family == .systemMedium {
                HStack(spacing: 12) {
                    summary(s)
                    rooms(s)
                }
            } else {
                summary(s)
            }
        } else {
            VStack(spacing: 6) {
                Image(systemName: "lightbulb.2")
                    .font(.title2)
                Text(entry.error ?? "Open Lights to sign in")
                    .font(.caption)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private func summary(_ s: HomeState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: s.onCount > 0 ? "lightbulb.fill" : "lightbulb")
                    .foregroundStyle(.orange)
                Text(s.chiefs.active ? "Game on" : "Lights")
                    .font(.caption.weight(.semibold))
            }
            Text(s.onCount == 0 ? "All off" : "\(s.onCount) on")
                .font(.system(size: 26, weight: .semibold, design: .rounded))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Button(intent: AllLightsIntent(on: true)) {
                    Image(systemName: "lightbulb.fill")
                        .frame(maxWidth: .infinity)
                }
                .tint(.orange)
                Button(intent: AllLightsIntent(on: false)) {
                    Image(systemName: "power")
                        .frame(maxWidth: .infinity)
                }
                .tint(.gray)
            }
            .buttonStyle(.bordered)
        }
    }

    private func rooms(_ s: HomeState) -> some View {
        let groups = Array(s.groups.prefix(4))
        return VStack(spacing: 6) {
            ForEach(groups, id: \.room) { g in
                let on = g.lights.contains { $0.on }
                let isRoom = s.rooms.contains(g.room)
                Button(intent: isRoom ? RoomLightsIntent(room: g.room, on: !on) : RoomLightsIntent(room: "", on: !on)) {
                    HStack {
                        Text(g.room)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Image(systemName: on ? "lightbulb.fill" : "lightbulb")
                            .foregroundStyle(on ? .orange : .secondary)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(on ? .orange : .gray)
                .disabled(!isRoom)
            }
        }
    }
}
