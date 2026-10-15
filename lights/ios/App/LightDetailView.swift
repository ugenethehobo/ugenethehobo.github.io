import SwiftUI

/// Brightness, colour and white controls for one light or a whole room.
struct LightControls: View {
    @EnvironmentObject private var model: AppModel
    let target: [String: Any]
    let on: Bool
    let bri: Int
    let canColor: Bool
    let canWhite: Bool
    let currentHex: String

    @State private var brightness: Double = 254
    @State private var pickedColor: Color = .white
    @State private var white: Double = 366
    @State private var editing = false
    @State private var colorTask: Task<Void, Never>?

    var body: some View {
        Group {
            Section("Brightness") {
                HStack {
                    Image(systemName: "sun.min")
                    Slider(value: $brightness, in: 1...254) { isEditing in
                        editing = isEditing
                        if !isEditing { model.setBrightness(Int(brightness), target: target) }
                    }
                    Image(systemName: "sun.max.fill")
                }
                .foregroundStyle(.secondary)
            }
            if canColor {
                Section("Colour") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                        ForEach(Palette.swatches, id: \.hex) { swatch in
                            Button {
                                model.setColor(swatch.hex, target: target)
                            } label: {
                                Circle()
                                    .fill(Color(hex: swatch.hex))
                                    .frame(width: 44, height: 44)
                                    .overlay(Circle().stroke(Color.primary.opacity(0.15)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(swatch.name)
                        }
                    }
                    .padding(.vertical, 4)
                    ColorPicker("Any colour", selection: Binding(get: { pickedColor }, set: { c in
                        pickedColor = c
                        sendColorSoon(c)
                    }), supportsOpacity: false)
                }
            }
            if canWhite {
                Section("White") {
                    HStack(spacing: 8) {
                        ForEach(Palette.whites, id: \.ct) { w in
                            Button(w.name) { model.setWhite(w.ct, target: target) }
                                .buttonStyle(.bordered)
                                .font(.caption)
                        }
                    }
                    HStack {
                        Image(systemName: "flame")
                            .foregroundStyle(.orange)
                        // Left is warm (500 mireds), right is cool (153).
                        Slider(value: Binding(get: { 653 - white }, set: { white = 653 - $0 }), in: 153...500) { isEditing in
                            if !isEditing { model.setWhite(Int(white), target: target) }
                        }
                        Image(systemName: "snowflake")
                            .foregroundStyle(.blue)
                    }
                }
            }
        }
        .onAppear {
            brightness = Double(bri)
            pickedColor = Color(hex: currentHex)
        }
        .onChange(of: bri) { _, b in
            if !editing { brightness = Double(b) }
        }
    }

    /// The colour wheel changes continuously while dragging: send the
    /// latest colour at most a few times a second.
    private func sendColorSoon(_ c: Color) {
        colorTask?.cancel()
        colorTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            if Task.isCancelled { return }
            model.setColor(c.hexString, target: target)
        }
    }
}

struct LightDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let lightId: String
    @State private var name = ""
    @State private var room = ""
    @State private var confirmRemove = false

    var body: some View {
        NavigationStack {
            if let light = model.state?.light(lightId) {
                Form {
                    Section {
                        HStack {
                            Image(systemName: light.on ? "lightbulb.fill" : "lightbulb")
                                .font(.largeTitle)
                                .foregroundStyle(light.on ? light.color : .secondary)
                            VStack(alignment: .leading) {
                                Text(light.status)
                                    .font(.headline)
                                if let model = light.model, !model.isEmpty {
                                    Text(model)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Toggle("", isOn: Binding(get: { light.on }, set: { model.setPower($0, ids: [light.id]) }))
                                .labelsHidden()
                        }
                        if !light.reachable {
                            Text(help(light))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    LightControls(target: ["ids": [light.id]], on: light.on, bri: light.bri, canColor: light.canColor, canWhite: light.canWhite, currentHex: light.hex)
                    Section("Name and room") {
                        TextField("Name", text: $name)
                            .onSubmit { model.fire("/api/light", method: "PUT", ["id": light.id, "name": name]) }
                        TextField("Room (e.g. Living room)", text: $room)
                            .onSubmit { model.fire("/api/light", method: "PUT", ["id": light.id, "room": room]) }
                        if let rooms = model.state?.rooms, !rooms.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack {
                                    ForEach(rooms, id: \.self) { r in
                                        Button(r) {
                                            room = r
                                            model.fire("/api/light", method: "PUT", ["id": light.id, "room": r])
                                        }
                                        .buttonStyle(.bordered)
                                        .tint(r == light.room ? .accentColor : .gray)
                                    }
                                }
                            }
                        }
                    }
                    Section {
                        Button("Blink this light") {
                            model.fire("/api/light/identify", ["id": light.id])
                        }
                        Button("Remove light", role: .destructive) {
                            confirmRemove = true
                        }
                    } footer: {
                        Text("ID \(light.id)")
                    }
                }
                .onAppear {
                    name = light.name
                    room = light.room
                }
                .confirmationDialog("Remove \(light.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                    Button("Remove", role: .destructive) {
                        Task {
                            if await model.send("/api/light/forget", ["id": light.id]) { dismiss() }
                        }
                    }
                } message: {
                    Text("The hub forgets the light. You can pair it again later.")
                }
                .navigationTitle(light.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            saveText(light)
                            dismiss()
                        }
                    }
                }
            } else {
                ContentUnavailableView("Light removed", systemImage: "lightbulb.slash")
            }
        }
    }

    private func saveText(_ light: Light) {
        var body: [String: Any] = ["id": light.id]
        if name != light.name, !name.isEmpty { body["name"] = name }
        if room != light.room { body["room"] = room }
        if body.count > 1 { model.fire("/api/light", method: "PUT", body) }
    }

    private func help(_ light: Light) -> String {
        if light.unpaired == true { return "The hub no longer knows this light. Add it again from + on the main screen." }
        if !light.hubOnline { return "Its hub is offline. Check that the hub has power and Wi-Fi." }
        return "The hub can’t reach it. Is it switched on at the wall, and within about 10 m of the hub? Close the Hue app on your PC: a light talks to one device at a time."
    }
}

struct RoomView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let room: String
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            let lights = model.state?.lights.filter { $0.room == room } ?? []
            Form {
                Section {
                    Toggle("On", isOn: Binding(get: { lights.contains { $0.on } }, set: { model.setPower($0, room: room) }))
                }
                LightControls(
                    target: ["room": room],
                    on: lights.contains { $0.on },
                    bri: lights.filter(\.on).map(\.bri).max() ?? 254,
                    canColor: lights.contains { $0.canColor },
                    canWhite: lights.contains { $0.canWhite },
                    currentHex: lights.first?.hex ?? "#ffffff"
                )
                Section("Lights") {
                    ForEach(lights) { l in
                        HStack {
                            Circle().fill(l.on ? l.color : Color(.tertiarySystemFill)).frame(width: 14, height: 14)
                            Text(l.name)
                            Spacer()
                            Text(l.status).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Rename room") {
                    TextField(room, text: $newName)
                    Button("Rename") {
                        Task {
                            if await model.send("/api/rooms", method: "PUT", ["rename": ["from": room, "to": newName]]) { dismiss() }
                        }
                    }
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .navigationTitle(room)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
