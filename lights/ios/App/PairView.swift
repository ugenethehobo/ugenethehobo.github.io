import SwiftUI

/// Find Hue Bluetooth lights near your hubs and pair them.
struct PairView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var naming: FoundLight?
    @State private var name = ""
    @State private var room = ""
    @State private var showAll = false

    var body: some View {
        NavigationStack {
            let scan = model.state?.scan
            let all = (scan?.found ?? []).sorted { $0.rssi > $1.rssi }
            let found = all.filter(\.isHue)
            let others = all.filter { !$0.isHue }
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Turn off Bluetooth on your PC (not just the app). Windows stays connected to paired lights, and a connected light is invisible to the hub.", systemImage: "1.circle")
                        Label("Put the light in pairing mode. A light that’s already paired somewhere only accepts a new device after you make it discoverable: in the Philips Hue phone app, Settings → Voice assistants → Amazon Alexa (or Google Home) → Make discoverable. Then close the Hue app. A factory-reset light is in pairing mode on its own.", systemImage: "2.circle")
                        Label("Keep the light within about 10 m of the hub, then search and tap Pair.", systemImage: "3.circle")
                    }
                    .font(.footnote)
                    .padding(.vertical, 4)
                }
                Section {
                    if scan?.running == true {
                        HStack {
                            ProgressView()
                            Text("Searching…")
                            Spacer()
                            Button("Stop") { model.fire("/api/scan/stop") }
                        }
                    } else {
                        Toggle("Show all Bluetooth devices", isOn: $showAll)
                        Button {
                            model.fire("/api/scan", ["all": showAll])
                        } label: {
                            Label(found.isEmpty ? "Search for lights" : "Search again", systemImage: "magnifyingglass")
                        }
                        .disabled(!(model.state?.hubs.contains { $0.online && !$0.pending } ?? false))
                    }
                } footer: {
                    if !(model.state?.hubs.contains { $0.online && !$0.pending } ?? false) {
                        Text("No hub is online. Set one up in Settings.")
                    } else {
                        Text("A light missing from the list? Turn on “Show all Bluetooth devices”: some lights (like Play bars) don’t say they’re Hue lights until you connect.")
                    }
                }
                if !found.isEmpty {
                    Section("Hue lights") {
                        ForEach(found) { f in
                            row(f)
                        }
                    }
                }
                if !others.isEmpty {
                    Section {
                        ForEach(others) { f in
                            row(f)
                        }
                    } header: {
                        Text("Other Bluetooth devices")
                    } footer: {
                        Text("Pair only works with Hue lights. The hub checks when it connects.")
                    }
                }
                if let log = model.state?.hubLog, !log.isEmpty {
                    Section("What the hub is doing") {
                        ForEach(log.prefix(8)) { e in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.text)
                                    .font(.caption)
                                Text(Date(ms: e.at).formatted(date: .omitted, time: .standard))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add lights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Pair this light", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
                TextField("Name (e.g. Couch lamp)", text: $name)
                TextField("Room (e.g. Living room)", text: $room)
                Button("Pair") {
                    if let f = naming {
                        model.fire("/api/pair", ["id": f.id, "name": name, "room": room])
                    }
                    naming = nil
                }
                Button("Cancel", role: .cancel) { naming = nil }
            } message: {
                Text("The hub connects to it and remembers it.")
            }
        }
    }

    private func row(_ f: FoundLight) -> some View {
        HStack {
            Image(systemName: "lightbulb")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(f.name)
                Text(detail(f))
                    .font(.caption)
                    .foregroundStyle(f.status == "failed" ? .red : .secondary)
            }
            Spacer()
            switch f.status {
            case "pairing":
                ProgressView()
            case "paired":
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            default:
                if f.known {
                    Text("Added").foregroundStyle(.secondary)
                } else {
                    Button(f.status == "failed" ? "Retry" : "Pair") {
                        name = ""
                        room = model.state?.rooms.first ?? ""
                        naming = f
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private func detail(_ f: FoundLight) -> String {
        if f.status == "failed" { return f.error ?? "Pairing failed" }
        let signal = f.rssi > -65 ? "Strong signal" : f.rssi > -80 ? "OK signal" : "Weak signal (move the hub closer)"
        return "\(signal) · \(f.id)"
    }
}
