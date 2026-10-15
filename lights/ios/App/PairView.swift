import SwiftUI

/// Find Hue Bluetooth lights near your hubs and pair them.
struct PairView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var naming: FoundLight?
    @State private var name = ""
    @State private var room = ""

    var body: some View {
        NavigationStack {
            let scan = model.state?.scan
            let found = (scan?.found ?? []).sorted { $0.rssi > $1.rssi }
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Close the Hue Bluetooth app on your PC first. A Hue light talks to only one device at a time.", systemImage: "1.circle")
                        Label("Lights already paired to your PC must be made discoverable: in the PC app use “Make discoverable” / “Voice assistant” pairing, or turn the light off and on at the wall and search within a minute.", systemImage: "2.circle")
                        Label("Keep the light within about 10 m of the hub.", systemImage: "3.circle")
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
                        Button {
                            model.fire("/api/scan")
                        } label: {
                            Label(found.isEmpty ? "Search for lights" : "Search again", systemImage: "magnifyingglass")
                        }
                        .disabled(!(model.state?.hubs.contains { $0.online && !$0.pending } ?? false))
                    }
                } footer: {
                    if !(model.state?.hubs.contains { $0.online && !$0.pending } ?? false) {
                        Text("No hub is online. Set one up in Settings.")
                    }
                }
                if !found.isEmpty {
                    Section("Found") {
                        ForEach(found) { f in
                            row(f)
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
