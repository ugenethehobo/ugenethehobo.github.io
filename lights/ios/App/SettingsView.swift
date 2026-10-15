import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var renaming: Hub?
    @State private var hubName = ""
    @State private var removing: Hub?
    @State private var locating = false
    @State private var newPasscode = ""
    @State private var confirmSignOutAll = false
    private let locator = LocationFetcher()

    var body: some View {
        NavigationStack {
            Form {
                if let s = model.state {
                    hubsSection(s)
                    setupSection
                    Section {
                        LabeledContent("Time zone", value: s.tz)
                        if s.tz != TimeZone.current.identifier {
                            Button("Use this phone’s time zone (\(TimeZone.current.identifier))") {
                                model.fire("/api/settings", method: "PUT", ["tz": TimeZone.current.identifier])
                            }
                        }
                        if let lat = s.settings.lat, let lon = s.settings.lon {
                            LabeledContent("Location", value: String(format: "%.2f, %.2f", lat, lon))
                        }
                        if let sun = s.sun {
                            LabeledContent("Sunrise / sunset", value: "\(Date(ms: sun.sunrise).formatted(date: .omitted, time: .shortened)) / \(Date(ms: sun.sunset).formatted(date: .omitted, time: .shortened))")
                        }
                        Button {
                            locating = true
                            Task {
                                defer { locating = false }
                                do {
                                    let loc = try await locator.fetch()
                                    await model.send("/api/settings", method: "PUT", ["lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude])
                                } catch {
                                    model.error = error.localizedDescription
                                }
                            }
                        } label: {
                            HStack {
                                Text(s.settings.lat == nil ? "Set location from this phone" : "Update location")
                                if locating { Spacer(); ProgressView() }
                            }
                        }
                    } header: {
                        Text("Home")
                    } footer: {
                        Text("Used for schedules that follow sunrise or sunset. Stored rounded to about 1 km.")
                    }
                    Section("Household") {
                        SecureField("New passcode (6+ characters)", text: $newPasscode)
                        Button("Change passcode") {
                            Task {
                                if await model.send("/api/passcode", ["passcode": newPasscode]) { model.signOut() }
                            }
                        }
                        .disabled(newPasscode.count < 6)
                        Button("Sign out everyone", role: .destructive) { confirmSignOutAll = true }
                        Button("Sign out of this phone") { model.signOut() }
                    }
                    Section("Recent activity") {
                        ForEach(s.log) { e in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.text)
                                Text("\(e.by ?? "Automatic") · \(Date(ms: e.at).formatted(.relative(presentation: .named)))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let url = model.serverURL {
                    Section {
                        Text(url.host() ?? url.absoluteString)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Server")
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Rename hub", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $hubName)
                Button("Save") {
                    if let h = renaming { model.fire("/api/hub", method: "PUT", ["id": h.id, "name": hubName]) }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
            .confirmationDialog("Remove \(removing?.name ?? "hub")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    if let h = removing { model.fire("/api/hub/forget", ["id": h.id]) }
                    removing = nil
                }
            } message: {
                Text("Its lights stay in the app but need pairing to another hub.")
            }
            .confirmationDialog("Sign out every phone?", isPresented: $confirmSignOutAll, titleVisibility: .visible) {
                Button("Sign out everyone", role: .destructive) {
                    Task {
                        if await model.send("/api/signout-everyone") { model.signOut() }
                    }
                }
            }
        }
    }

    private func hubsSection(_ s: HomeState) -> some View {
        Section {
            if s.hubs.isEmpty {
                Text("No hubs yet. Set one up below.")
                    .foregroundStyle(.secondary)
            }
            ForEach(s.hubs) { hub in
                HStack {
                    Circle()
                        .fill(hub.pending ? Color.blue : hub.online ? Color.green : Color.orange)
                        .frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(hub.pending ? hub.id : hub.name)
                        Text(hub.pending ? "Wants to join" : "\(hub.online ? "Online" : "Offline") · \(hub.lights) lights\(hub.fw.map { " · v\($0)" } ?? "")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if hub.pending {
                        Button("Approve") { model.fire("/api/hub/approve", ["id": hub.id]) }
                            .buttonStyle(.borderedProminent)
                        Button("Ignore") { model.fire("/api/hub/reject", ["id": hub.id]) }
                            .buttonStyle(.bordered)
                    } else {
                        Menu {
                            Button("Rename") {
                                hubName = hub.name
                                renaming = hub
                            }
                            Button("Remove", role: .destructive) { removing = hub }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
        } header: {
            Text("Hubs")
        } footer: {
            Text("Approve only a hub ID you recognise. It’s printed on the hub’s setup page.")
        }
    }

    private var setupSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Get an ESP32 board (“ESP32 DevKit”, about $8) and a USB power adapter.", systemImage: "1.circle")
                Label("On a computer with Chrome or Edge, open your server address and choose “Install hub software”. Plug the board in with a USB cable and follow the steps.", systemImage: "2.circle")
                Label("On this iPhone, join the Wi-Fi network “Hue-Hub-…”. Pick your home Wi-Fi, enter your server address, and save.", systemImage: "3.circle")
                Label("Come back here and tap Approve.", systemImage: "4.circle")
            }
            .font(.footnote)
            if let url = model.serverURL {
                Button("Open the hub installer page") { openURL(url) }
            }
        } header: {
            Text("Set up a hub")
        } footer: {
            Text("Put the hub within about 10 m of your lights. For lights spread around the house, add a second hub.")
        }
    }
}
