import SwiftUI

struct MainView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            ScrollView {
                if let s = model.state {
                    VStack(spacing: 16) {
                        HeroCard(state: s)
                        if s.hold != nil || s.next != nil { ScheduleBanner(state: s) }
                        ModePicker(state: s)
                        if !s.fanModes.isEmpty { FanPicker(state: s) }
                        SensorGrid(state: s)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 32)
                } else {
                    ProgressView("Connecting to your thermostat…")
                        .padding(.top, 120)
                }
            }
            .refreshable { await model.refresh() }
            .navigationTitle("Home")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { StatusPill() }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let url = model.webURL {
                            Link(destination: url) { Label("Schedule & settings", systemImage: "calendar") }
                        }
                        Button(role: .destructive) { model.signOut() } label: {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .onAppear { model.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.start() } else { model.stop() }
        }
    }
}

struct StatusPill: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            HStack(spacing: 6) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var color: Color {
        if model.error != nil { return .orange }
        guard let s = model.state else { return .orange }
        if s.connection.state != "connected" || s.connection.pollError != nil { return .orange }
        return .green
    }

    private var text: String {
        if let error = model.error { return error }
        guard let s = model.state else { return "Connecting…" }
        if s.connection.state == "needs-login" { return "Amazon sign-in needed" }
        if s.connection.pollError != nil { return "Thermostat not answering" }
        guard let last = s.connection.lastPollAt else { return "Reading thermostat…" }
        let secs = Int(Date().timeIntervalSince1970 - last / 1000)
        return secs < 10 ? "Live · just now" : secs < 60 ? "Live · \(secs)s ago" : "Live · \(secs / 60) min ago"
    }
}

struct HeroCard: View {
    @EnvironmentObject private var model: AppModel
    let state: ClimateState

    var body: some View {
        VStack(spacing: 6) {
            Text("Inside now")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(Temp.reading(state.measured, unit: state.unit))
                .font(.system(size: 76, weight: .thin, design: .rounded))
                .contentTransition(.numericText())
            Text(state.sourceText + (state.thermostat.humidity.map { " · \(Int($0))% humidity" } ?? ""))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if state.mode == .off {
                Text("Off")
                    .font(.title.bold())
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 18)
            } else {
                HStack {
                    StepButton(systemImage: "minus") { model.nudge(-1) }
                    Spacer()
                    VStack(spacing: 0) {
                        Text("SET TO")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(Temp.target(state.program.target, unit: state.unit))
                            .font(.system(size: 46, weight: .semibold, design: .rounded))
                            .foregroundStyle(state.mode.color)
                            .contentTransition(.numericText())
                    }
                    Spacer()
                    StepButton(systemImage: "plus") { model.nudge(1) }
                }
                .padding(.vertical, 10)
            }

            Label(state.actionText, systemImage: state.action == "heating" ? "flame.fill" : state.action == "cooling" ? "snowflake" : "circle")
                .font(.headline)
                .foregroundStyle(state.action == "heating" ? .orange : state.action == "cooling" ? .blue : .secondary)
            if let line = thermostatLine {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let sending = model.sending {
                Label("Sending \(sending)…", systemImage: "arrow.up.circle")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.thinMaterial, in: Capsule())
            } else if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(
            LinearGradient(colors: [state.mode.color.opacity(0.18), Color(.secondarySystemBackground)], startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 28)
        )
        .animation(.snappy, value: state)
    }

    private var thermostatLine: String? {
        guard let mode = state.thermostat.mode else { return nil }
        let name = ["HEAT": "Heat", "COOL": "Cool", "OFF": "Off", "AUTO": "Auto"][mode] ?? mode
        let sp = mode != "OFF" ? state.thermostat.setpoint.map { " \(Temp.target($0, unit: state.unit))" } ?? "" : ""
        return "On the thermostat: \(name)\(sp)" + (state.pending ? " · waiting for it to confirm" : "")
    }
}

struct StepButton: View {
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .light))
                .frame(width: 68, height: 68)
                .background(Color(.tertiarySystemFill), in: Circle())
        }
        .buttonStyle(.plain)
        .buttonRepeatBehavior(.enabled)
    }
}

struct ScheduleBanner: View {
    @EnvironmentObject private var model: AppModel
    let state: ClimateState

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                if let hold = state.hold {
                    Text(hold.until.map { "Holding until \(time($0))" } ?? "Holding")
                        .font(.subheadline.bold())
                    if let by = hold.by {
                        Text("Set by \(by)").font(.caption).foregroundStyle(.secondary)
                    }
                } else if let next = state.next {
                    Text("On schedule").font(.subheadline.bold())
                    Text("Next: \(next.name ?? next.mode.capitalized) \(Temp.target(next.target, unit: state.unit)) at \(time(next.at))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if state.hold != nil {
                Button("Resume") { model.resume() }
                    .buttonStyle(.borderedProminent)
                    .tint(state.mode.color)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
    }

    private func time(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(date) ? "h:mm a" : "EEE h:mm a"
        return f.string(from: date)
    }
}

struct ModePicker: View {
    @EnvironmentObject private var model: AppModel
    let state: ClimateState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Mode")
            HStack(spacing: 6) {
                ForEach(ModeOption.allCases, id: \.self) { mode in
                    Button {
                        model.setMode(mode)
                    } label: {
                        VStack(spacing: 4) {
                            Image(systemName: mode.symbol).font(.title3)
                            Text(mode.title).font(.subheadline.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .foregroundStyle(state.mode == mode ? mode.color : .secondary)
                        .background(state.mode == mode ? mode.color.opacity(0.15) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                }
            }
            if state.mode == .smart {
                Text("A/C at \(Temp.target(state.program.target + state.smartThreshold, unit: state.unit)), heat at \(Temp.target(state.program.target - state.smartThreshold, unit: state.unit))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct FanPicker: View {
    @EnvironmentObject private var model: AppModel
    let state: ClimateState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Fan")
            Picker("Fan", selection: Binding(get: { state.program.fan ?? "" }, set: { model.setFan($0) })) {
                ForEach(state.fanModes, id: \.self) { mode in
                    Text(mode.label).tag(mode.value)
                }
            }
            .pickerStyle(.segmented)
        }
    }
}

struct SensorGrid: View {
    @EnvironmentObject private var model: AppModel
    let state: ClimateState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Sensors")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(state.sensors) { sensor in
                    SensorCard(sensor: sensor, selected: state.program.sensors.contains(sensor.id), unit: state.unit, tappable: state.sensorControl && sensor.eligible) {
                        model.useSensor(sensor.id, combine: false)
                    } onCombine: {
                        model.useSensor(sensor.id, combine: true)
                    }
                }
            }
            Text(state.sensorControl ? "Tap a sensor to follow just that one, or + to average several." : "Sensors are chosen in the Alexa app.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct SensorCard: View {
    let sensor: ClimateState.Sensor
    let selected: Bool
    let unit: String
    let tappable: Bool
    let onTap: () -> Void
    let onCombine: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Text(sensor.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer()
                if tappable {
                    Button(action: onCombine) {
                        Image(systemName: selected ? "checkmark.circle.fill" : "plus.circle")
                            .font(.title3)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                } else if sensor.inUse {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                }
            }
            Text(sensor.reachable ? Temp.reading(sensor.temp, unit: unit) : "Offline")
                .font(.system(size: 28, weight: .light, design: .rounded))
            Text(sensor.kind == "thermostat" ? "Thermostat" : sensor.kind == "air-quality" ? "Air monitor" : "Sensor")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
        .contentShape(RoundedRectangle(cornerRadius: 18))
        .onTapGesture { if tappable { onTap() } }
    }
}

struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .tracking(0.8)
    }
}
