import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selected: Light?
    @State private var roomSheet: RoomRef?
    @State private var showPair = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let s = model.state {
                        banners(s)
                        if s.chiefs.settings.enabled || s.chiefs.active {
                            NavigationLink {
                                ChiefsView()
                            } label: {
                                ChiefsCard(chiefs: s.chiefs)
                            }
                            .buttonStyle(.plain)
                        }
                        if s.lights.isEmpty {
                            emptyState(s)
                        } else {
                            allButtons(s)
                            ForEach(s.groups) { group in
                                roomSection(group.room, group.lights, isRoom: group.isRoom)
                            }
                        }
                        if let next = s.nextSchedule {
                            NavigationLink {
                                SchedulesView()
                            } label: {
                                Label("Next: \(next.name) at \(Date(ms: next.at).formatted(date: .omitted, time: .shortened))", systemImage: "calendar")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } else {
                        ProgressView("Loading…")
                            .frame(maxWidth: .infinity, minHeight: 300)
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Lights")
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showPair = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add lights")
                    NavigationLink {
                        SchedulesView()
                    } label: {
                        Image(systemName: "calendar")
                    }
                    .accessibilityLabel("Schedules")
                    NavigationLink {
                        ChiefsView()
                    } label: {
                        Image(systemName: "football.fill")
                    }
                    .accessibilityLabel("Chiefs mode")
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(item: $selected) { light in
                LightDetailView(lightId: light.id)
            }
            .sheet(item: $roomSheet) { ref in
                RoomView(room: ref.name)
            }
            .sheet(isPresented: $showPair) {
                PairView()
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
    }

    @ViewBuilder
    private func banners(_ s: HomeState) -> some View {
        if let error = model.error {
            Banner(text: error, symbol: "exclamationmark.triangle.fill", color: .red)
        }
        if s.hubs.isEmpty {
            Button {
                showSettings = true
            } label: {
                Banner(text: "Set up a hub to reach your lights. Tap for steps.", symbol: "antenna.radiowaves.left.and.right", color: .orange)
            }
            .buttonStyle(.plain)
        }
        ForEach(s.hubs.filter(\.pending)) { hub in
            HStack {
                Banner(text: "\(hub.id) wants to join", symbol: "antenna.radiowaves.left.and.right", color: .blue)
                Button("Approve") { model.fire("/api/hub/approve", ["id": hub.id]) }
                    .buttonStyle(.borderedProminent)
            }
        }
        let offline = s.hubs.filter { !$0.pending && !$0.online }
        if !offline.isEmpty {
            Banner(text: "\(offline.map(\.name).joined(separator: ", ")) offline. Check its power and Wi-Fi.", symbol: "wifi.slash", color: .orange)
        }
    }

    private func allButtons(_ s: HomeState) -> some View {
        HStack(spacing: 12) {
            Button {
                model.setPower(true, room: nil)
            } label: {
                Label("All on", systemImage: "lightbulb.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.orange)
            Button {
                model.setPower(false, room: nil)
            } label: {
                Label("All off", systemImage: "lightbulb.slash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.gray)
        }
        .controlSize(.large)
    }

    private func roomSection(_ room: String, _ lights: [Light], isRoom: Bool) -> some View {
        let anyOn = lights.contains { $0.on }
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    if isRoom { roomSheet = RoomRef(name: room) }
                } label: {
                    HStack(spacing: 4) {
                        Text(room)
                            .font(.title3.bold())
                        if isRoom {
                            Image(systemName: "chevron.right")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                Spacer()
                Toggle(
                    "",
                    isOn: Binding(
                        get: { anyOn },
                        set: { on in
                            if isRoom { model.setPower(on, room: room) } else { model.setPower(on, ids: lights.map(\.id)) }
                        }
                    )
                )
                .labelsHidden()
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                ForEach(lights) { light in
                    LightTile(light: light) {
                        model.setPower(!light.on, ids: [light.id])
                    } open: {
                        selected = light
                    }
                }
            }
        }
    }

    private func emptyState(_ s: HomeState) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "lightbulb.2")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No lights yet")
                .font(.title2.bold())
            Text(s.hubs.contains { !$0.pending } ? "Search for your Hue lights to add them." : "First set up a hub (Settings), then add your lights.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button(s.hubs.contains { !$0.pending } ? "Add lights" : "Set up a hub") {
                if s.hubs.contains(where: { !$0.pending }) { showPair = true } else { showSettings = true }
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

struct RoomRef: Identifiable {
    let name: String
    var id: String { name }
}

struct Banner: View {
    let text: String
    let symbol: String
    let color: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(color == .red ? Color.red : Color.primary)
    }
}

struct LightTile: View {
    let light: Light
    let toggle: () -> Void
    let open: () -> Void

    var body: some View {
        let lit = light.on && light.reachable
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button(action: toggle) {
                    Image(systemName: lit ? "lightbulb.fill" : "lightbulb")
                        .font(.title2)
                        .foregroundStyle(lit ? light.color : .secondary)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(lit ? light.color.opacity(0.25) : Color(.tertiarySystemFill)))
                }
                .buttonStyle(.plain)
                .disabled(!light.reachable)
                Spacer()
                if light.inGame {
                    Image(systemName: "football.fill")
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(light.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(light.status)
                    .font(.caption)
                    .foregroundStyle(light.reachable ? .secondary : Color.orange)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(lit ? AnyShapeStyle(light.color.opacity(0.18)) : AnyShapeStyle(Color(.secondarySystemGroupedBackground)))
        )
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture(perform: open)
    }
}

struct ChiefsCard: View {
    let chiefs: Chiefs

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "football.fill")
                .font(.title)
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(Color(hex: Palette.chiefsRed)))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(LinearGradient(colors: [Color(hex: Palette.chiefsRed).opacity(chiefs.active ? 0.35 : 0.15), Color(hex: Palette.chiefsGold).opacity(0.12)], startPoint: .leading, endPoint: .trailing))
        )
    }

    private var title: String {
        guard let g = chiefs.game else { return chiefs.active ? "Chiefs colours on" : "Chiefs mode" }
        if let score = g.score, chiefs.phase == "live" || chiefs.phase == "final" {
            return "\(g.us.abbr) \(score.us) – \(score.opp) \(g.opp.abbr)"
        }
        return g.home ? "\(g.opp.abbr) at \(g.us.abbr)" : "\(g.us.abbr) at \(g.opp.abbr)"
    }

    private var subtitle: String {
        if let error = chiefs.error { return error }
        guard let g = chiefs.game else { return "No game this week" }
        switch chiefs.phase {
        case "live": return chiefs.recent.first.map { "\($0.label) · \(g.detail ?? "")" } ?? (g.detail ?? "Live")
        case "final": return "Final"
        case "pregame": return "Kickoff \(Date(ms: g.start).formatted(date: .omitted, time: .shortened)) · lights are red"
        default: return "Kickoff \(Date(ms: g.start).formatted(.dateTime.weekday(.wide).hour().minute()))"
        }
    }
}
