import SwiftUI

struct SchedulesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editing: Schedule?

    var body: some View {
        let list = model.state?.schedules ?? []
        List {
            if list.isEmpty {
                ContentUnavailableView("No schedules", systemImage: "calendar", description: Text("Turn lights on at sunset, fade them up to wake you, or off at bedtime."))
            }
            ForEach(list) { s in
                Button {
                    editing = s
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(s.name)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            Text(summary(s))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("", isOn: Binding(get: { s.enabled }, set: { on in
                            var copy = list
                            if let i = copy.firstIndex(where: { $0.id == s.id }) { copy[i].enabled = on }
                            Task { await model.saveSchedules(copy) }
                        }))
                        .labelsHidden()
                    }
                }
            }
            .onDelete { idx in
                var copy = list
                copy.remove(atOffsets: idx)
                Task { await model.saveSchedules(copy) }
            }
            if let next = model.state?.nextSchedule {
                Section {
                    Text("Next: \(next.name), \(Date(ms: next.at).formatted(.dateTime.weekday(.wide).hour().minute()))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Schedules")
        .toolbar {
            Button {
                editing = Schedule.new()
            } label: {
                Image(systemName: "plus")
            }
        }
        .sheet(item: $editing) { s in
            ScheduleEditor(schedule: s, isNew: !list.contains { $0.id == s.id })
        }
    }

    private func summary(_ s: Schedule) -> String {
        let when: String
        if let sun = s.sun {
            let off = s.offset == 0 ? "" : s.offset > 0 ? "\(s.offset) min after " : "\(-s.offset) min before "
            when = off + sun
        } else {
            when = s.time ?? ""
        }
        let what = s.action.power == "off" ? "Off" : "On" + (s.action.bri.map { " \(Int((Double($0) / 254 * 100).rounded()))%" } ?? "")
        let fade = s.action.fade > 0 ? ", \(s.action.fade) min fade" : ""
        return "\(when) · \(dayText(s.days)) · \(what)\(fade)"
    }
}

func dayText(_ days: [Int]) -> String {
    let set = Set(days)
    if set.count == 7 { return "Every day" }
    if set == [1, 2, 3, 4, 5] { return "Weekdays" }
    if set == [0, 6] { return "Weekends" }
    let names = Calendar.current.shortWeekdaySymbols
    return days.sorted().map { names[$0] }.joined(separator: " ")
}

struct ScheduleEditor: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State var schedule: Schedule
    let isNew: Bool

    @State private var when: String = "time"
    @State private var time = Date()
    @State private var colorMode = "white"
    @State private var color = Color(hex: Palette.chiefsRed)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $schedule.name)
                    Toggle("On", isOn: $schedule.enabled)
                }
                Section("When") {
                    Picker("At", selection: $when) {
                        Text("A time").tag("time")
                        Text("Sunrise").tag("sunrise")
                        Text("Sunset").tag("sunset")
                    }
                    .pickerStyle(.segmented)
                    if when == "time" {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    } else {
                        Stepper(value: $schedule.offset, in: -240...240, step: 5) {
                            Text(schedule.offset == 0 ? "At \(when)" : schedule.offset > 0 ? "\(schedule.offset) min after \(when)" : "\(-schedule.offset) min before \(when)")
                        }
                        if model.state?.settings.lat == nil {
                            Text("Set your location in Settings so sunrise and sunset are known.")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                    }
                    DayPicker(days: $schedule.days)
                }
                Section("Lights") {
                    Toggle("All lights", isOn: Binding(get: { schedule.target.all == true }, set: { all in
                        schedule.target = all ? .init(all: true, rooms: nil, lights: nil) : .init(all: nil, rooms: [], lights: [])
                    }))
                    if schedule.target.all != true {
                        ForEach(model.state?.rooms ?? [], id: \.self) { room in
                            checkRow(room, isOn: schedule.target.rooms?.contains(room) == true) {
                                toggle(&schedule.target.rooms, room)
                            }
                        }
                        ForEach(model.state?.lights ?? []) { light in
                            checkRow(light.name + (light.room.isEmpty ? "" : " · \(light.room)"), isOn: schedule.target.lights?.contains(light.id) == true) {
                                toggle(&schedule.target.lights, light.id)
                            }
                        }
                    }
                }
                Section("Do") {
                    Picker("Turn", selection: $schedule.action.power) {
                        Text("On").tag("on")
                        Text("Off").tag("off")
                    }
                    .pickerStyle(.segmented)
                    if schedule.action.power == "on" {
                        HStack {
                            Text("Brightness")
                            Slider(value: Binding(get: { Double(schedule.action.bri ?? 254) }, set: { schedule.action.bri = Int($0) }), in: 1...254)
                            Text("\(Int((Double(schedule.action.bri ?? 254) / 254 * 100).rounded()))%")
                                .monospacedDigit()
                                .frame(width: 44, alignment: .trailing)
                        }
                        Picker("Colour", selection: $colorMode) {
                            Text("Keep").tag("keep")
                            Text("White").tag("white")
                            Text("Colour").tag("color")
                        }
                        .pickerStyle(.segmented)
                        if colorMode == "white" {
                            Picker("White", selection: Binding(get: { schedule.action.ct ?? 366 }, set: { schedule.action.ct = $0 })) {
                                ForEach(Palette.whites, id: \.ct) { w in Text(w.name).tag(w.ct) }
                            }
                        } else if colorMode == "color" {
                            ColorPicker("Colour", selection: $color, supportsOpacity: false)
                        }
                    }
                    Stepper(value: $schedule.action.fade, in: 0...60) {
                        Text(schedule.action.fade == 0 ? "No fade" : "Fade over \(schedule.action.fade) min")
                    }
                } footer: {
                    Text(schedule.action.power == "on" ? "A fade starts dim and brightens slowly, like a sunrise alarm." : "A fade dims slowly, then turns off.")
                }
                if !isNew {
                    Section {
                        Button("Run it now") {
                            Task {
                                if await save() { await model.send("/api/schedule/run", ["id": schedule.id]) }
                            }
                        }
                    }
                }
            }
            .navigationTitle(isNew ? "New schedule" : schedule.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { if await save() { dismiss() } }
                    }
                    .disabled(schedule.days.isEmpty)
                }
            }
            .onAppear(perform: load)
        }
    }

    private func checkRow(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).foregroundStyle(.primary)
                Spacer()
                if isOn { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
    }

    private func toggle(_ list: inout [String]?, _ item: String) {
        var l = list ?? []
        if let i = l.firstIndex(of: item) { l.remove(at: i) } else { l.append(item) }
        list = l
    }

    private func load() {
        when = schedule.sun ?? "time"
        let parts = (schedule.time ?? "07:00").split(separator: ":").compactMap { Int($0) }
        time = Calendar.current.date(bySettingHour: parts.first ?? 7, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        if let hex = schedule.action.color {
            colorMode = "color"
            color = Color(hex: hex)
        } else if schedule.action.ct != nil {
            colorMode = "white"
        } else {
            colorMode = "keep"
        }
    }

    private func save() async -> Bool {
        var s = schedule
        if when == "time" {
            let c = Calendar.current.dateComponents([.hour, .minute], from: time)
            s.time = String(format: "%02d:%02d", c.hour ?? 7, c.minute ?? 0)
            s.sun = nil
            s.offset = 0
        } else {
            s.sun = when
            s.time = nil
        }
        switch colorMode {
        case "color":
            s.action.color = color.hexString
            s.action.ct = nil
        case "white":
            s.action.color = nil
            s.action.ct = s.action.ct ?? 366
        default:
            s.action.color = nil
            s.action.ct = nil
        }
        var list = model.state?.schedules ?? []
        if let i = list.firstIndex(where: { $0.id == s.id }) { list[i] = s } else { list.append(s) }
        return await model.saveSchedules(list)
    }
}

struct DayPicker: View {
    @Binding var days: [Int]

    var body: some View {
        let names = Calendar.current.veryShortWeekdaySymbols
        HStack {
            ForEach(0..<7, id: \.self) { d in
                let on = days.contains(d)
                Button {
                    if on { days.removeAll { $0 == d } } else { days.append(d); days.sort() }
                } label: {
                    Text(names[d])
                        .font(.subheadline.bold())
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(on ? Color.accentColor : Color(.tertiarySystemFill)))
                        .foregroundStyle(on ? .white : .primary)
                }
                .buttonStyle(.plain)
                if d < 6 { Spacer(minLength: 0) }
            }
        }
    }
}
