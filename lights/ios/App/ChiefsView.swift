import SwiftUI

/// Chiefs mode: game-day colours and live light shows for each play.
struct ChiefsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var delay: Double = 0
    @State private var bri: Double = 200
    @State private var loaded = false

    var body: some View {
        Form {
            if let c = model.state?.chiefs {
                Section {
                    gameHeader(c)
                }
                Section {
                    Toggle("Chiefs mode", isOn: Binding(get: { c.settings.enabled }, set: { model.setChiefs(["enabled": $0]) }))
                    if c.active {
                        Button("Put lights back to normal") { model.fire("/api/chiefs/mode", ["on": false]) }
                    } else {
                        Button("Chiefs colours now") { model.fire("/api/chiefs/mode", ["on": true]) }
                    }
                } footer: {
                    Text("Before each Chiefs game the game lights turn red, then react to plays as they happen. After the final whistle they go back to how they were.")
                }
                if !c.recent.isEmpty {
                    Section("Plays") {
                        ForEach(c.recent) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(item.label).font(.subheadline.bold())
                                    Spacer()
                                    Text(Date(ms: item.at).formatted(date: .omitted, time: .shortened))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if !item.text.isEmpty {
                                    Text(item.text)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(3)
                                }
                            }
                        }
                    }
                }
                Section {
                    VStack(alignment: .leading) {
                        HStack {
                            Text("My TV is behind by")
                            Spacer()
                            Text(delay == 0 ? "0 s" : "\(Int(delay)) s")
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        Slider(value: $delay, in: 0...120, step: 1) { editing in
                            if !editing { model.setChiefs(["delaySec": Int(delay)]) }
                        }
                    }
                    HStack {
                        Button("Lights too early: +5 s") {
                            delay = min(120, delay + 5)
                            model.setChiefs(["delaySec": Int(delay)])
                        }
                        .buttonStyle(.bordered)
                        Spacer()
                        Button("Too late: −5 s") {
                            delay = max(0, delay - 5)
                            model.setChiefs(["delaySec": Int(delay)])
                        }
                        .buttonStyle(.bordered)
                    }
                    .font(.caption)
                } header: {
                    Text("Timing")
                } footer: {
                    Text(timingHelp(c))
                }
                Section("Game lights") {
                    Button {
                        model.setChiefs(["lights": [String]()])
                    } label: {
                        row("All lights", on: c.settings.lights.isEmpty)
                    }
                    ForEach(model.state?.lights ?? []) { light in
                        Button {
                            var set = c.settings.lights
                            if let i = set.firstIndex(of: light.id) { set.remove(at: i) } else { set.append(light.id) }
                            model.setChiefs(["lights": set])
                        } label: {
                            row(light.name, on: c.settings.lights.contains(light.id))
                        }
                    }
                    HStack {
                        Text("Brightness")
                        Slider(value: $bri, in: 20...254) { editing in
                            if !editing { model.setChiefs(["bri": Int(bri)]) }
                        }
                    }
                }
                Section {
                    Stepper(value: Binding(get: { c.settings.pregameMin }, set: { model.setChiefs(["pregameMin": $0]) }), in: 0...240, step: 15) {
                        Text("Red \(c.settings.pregameMin) min before kickoff")
                    }
                    Picker("After the game", selection: Binding(get: { c.settings.afterGame }, set: { model.setChiefs(["afterGame": $0]) })) {
                        Text("Back to normal").tag("restore")
                        Text("Stay red").tag("stay")
                    }
                    if c.settings.afterGame == "restore" {
                        Stepper(value: Binding(get: { c.settings.postgameMin }, set: { model.setChiefs(["postgameMin": $0]) }), in: 0...180, step: 5) {
                            Text("\(c.settings.postgameMin) min after the final whistle")
                        }
                    }
                } header: {
                    Text("Before and after")
                }
                Section {
                    ForEach(c.events) { e in
                        HStack {
                            Toggle(e.label, isOn: Binding(get: { c.settings.events[e.id] ?? true }, set: { on in
                                model.setChiefs(["events": [e.id: on]])
                            }))
                            Button {
                                model.fire("/api/chiefs/test", ["kind": e.id])
                            } label: {
                                Image(systemName: "play.circle")
                                    .font(.title3)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Test \(e.label)")
                        }
                    }
                } header: {
                    Text("Light shows")
                } footer: {
                    Text("Tap ▶︎ to see a show right now on the game lights.")
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Chiefs mode")
        .refreshable { await model.send("/api/chiefs/refresh") }
        .onAppear {
            guard !loaded, let c = model.state?.chiefs else { return }
            delay = Double(c.settings.delaySec)
            bri = Double(c.settings.bri)
            loaded = true
        }
    }

    private func row(_ title: String, on: Bool) -> some View {
        HStack {
            Text(title).foregroundStyle(.primary)
            Spacer()
            if on { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
        }
    }

    @ViewBuilder
    private func gameHeader(_ c: Chiefs) -> some View {
        if let g = c.game {
            VStack(spacing: 10) {
                HStack {
                    team(g.home ? g.opp : g.us, score: g.home ? g.score?.opp : g.score?.us)
                    Spacer()
                    VStack {
                        Text("at")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(status(c, g))
                            .font(.caption.bold())
                            .multilineTextAlignment(.center)
                    }
                    Spacer()
                    team(g.home ? g.us : g.opp, score: g.home ? g.score?.us : g.score?.opp)
                }
                if let last = c.lastPlay, c.phase == "live" {
                    Text(last.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if let error = c.error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(.vertical, 6)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(c.error ?? "No Chiefs game this week")
                    .font(.headline)
                if let next = c.nextCheck, c.settings.enabled {
                    Text("Checks the NFL schedule again \(Date(ms: next).formatted(.relative(presentation: .named))).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func team(_ t: Team, score: Int?) -> some View {
        VStack(spacing: 4) {
            Circle()
                .fill(Color(hex: t.color ?? "#888888"))
                .frame(width: 40, height: 40)
                .overlay(Text(t.abbr).font(.caption.bold()).foregroundStyle(.white))
            if let score {
                Text("\(score)").font(.title.bold()).monospacedDigit()
            } else {
                Text(t.name).font(.caption)
            }
        }
        .frame(minWidth: 70)
    }

    private func status(_ c: Chiefs, _ g: Game) -> String {
        switch c.phase {
        case "live": return g.detail ?? "Live"
        case "final": return "Final"
        case "pregame": return "Kickoff \(Date(ms: g.start).formatted(date: .omitted, time: .shortened))\nLights are red"
        default:
            return Date(ms: g.start).formatted(.dateTime.weekday(.abbreviated).month().day().hour().minute())
        }
    }

    private func timingHelp(_ c: Chiefs) -> String {
        var s = "Streaming TV runs 20–60 s behind the stadium, cable about 5–10 s. Set this so the lights flash when you see the play."
        if let lag = c.espnLagSec, lag > 0 {
            s += " ESPN posted the last play \(lag) s after it happened."
        }
        return s
    }
}
