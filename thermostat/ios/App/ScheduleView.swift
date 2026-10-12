import SwiftUI

/// The weekly schedule: each time sets the mode, temperature, fan and which
/// sensors the thermostat follows. Manual changes hold until the next time.
struct ScheduleView: View {
    @EnvironmentObject private var model: AppModel
    @State private var data: ScheduleState?
    @State private var editing: ScheduleState.Entry?
    @State private var isNew = false
    @State private var error: String?
    @State private var saving = false

    private static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    var body: some View {
        List {
            if let data {
                Section {
                    Toggle(isOn: Binding(get: { data.schedule.enabled }, set: { on in save(enabled: on, entries: data.schedule.entries) })) {
                        VStack(alignment: .leading) {
                            Text("Use schedule")
                            Text(data.schedule.enabled ? "Manual changes hold until the next time" : "Off: the thermostat stays where you set it")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Times") {
                    if data.schedule.entries.isEmpty {
                        Text("No times yet. Tap + to add one, like Night · 10:00 PM · 66° · Bedroom.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(sorted(data.schedule.entries)) { entry in
                        Button {
                            isNew = false
                            editing = entry
                        } label: {
                            row(entry, data: data)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { offsets in
                        let list = sorted(data.schedule.entries)
                        let ids = Set(offsets.map { list[$0].id })
                        save(enabled: data.schedule.enabled, entries: data.schedule.entries.filter { !ids.contains($0.id) })
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Schedule")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if saving {
                    ProgressView()
                } else {
                    Button {
                        guard let data else { return }
                        isNew = true
                        editing = ScheduleState.Entry(
                            id: UUID().uuidString.lowercased(),
                            name: "",
                            time: "22:00",
                            days: Array(0...6),
                            mode: data.program.mode,
                            target: data.program.target,
                            fan: data.program.fan,
                            sensors: data.program.sensors
                        )
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(data == nil)
                }
            }
        }
        .sheet(item: $editing) { entry in
            if let data {
                EntryEditor(entry: entry, data: data, isNew: isNew) { updated in
                    var entries = data.schedule.entries.filter { $0.id != updated.id }
                    entries.append(updated)
                    // Adding the first time turns the schedule on.
                    save(enabled: data.schedule.enabled || data.schedule.entries.isEmpty, entries: entries)
                } onDelete: {
                    save(enabled: data.schedule.enabled, entries: data.schedule.entries.filter { $0.id != entry.id })
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func row(_ e: ScheduleState.Entry, data: ScheduleState) -> some View {
        let mode = ModeOption(rawValue: e.mode) ?? .off
        let sensorNames = e.sensors.compactMap { id in data.sensors.first { $0.id == id }?.name }
        return HStack(spacing: 14) {
            Text(time12(e.time))
                .font(.title3.weight(.semibold).monospacedDigit())
                .frame(minWidth: 92, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(e.name.isEmpty ? mode.title : e.name).font(.headline)
                    Text(mode == .off ? "Off" : "\(mode.title) \(Temp.target(e.target, unit: data.unit))")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(mode.color.opacity(0.15), in: Capsule())
                        .foregroundStyle(mode.color)
                    if e.id == data.activeId && data.schedule.enabled {
                        Circle().fill(mode.color).frame(width: 6, height: 6)
                    }
                }
                Text(([daysLabel(e.days)] + (data.sensorControl && !sensorNames.isEmpty ? [sensorNames.joined(separator: " + ")] : [])).joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private func sorted(_ entries: [ScheduleState.Entry]) -> [ScheduleState.Entry] {
        entries.sorted { ($0.time, $0.days.first ?? 0) < ($1.time, $1.days.first ?? 0) }
    }

    private func daysLabel(_ days: [Int]) -> String {
        let set = Set(days)
        if set == Set(0...6) { return "Every day" }
        if set == Set(1...5) { return "Weekdays" }
        if set == Set([0, 6]) { return "Weekends" }
        return days.sorted().map { Self.dayNames[$0] }.joined(separator: ", ")
    }

    private func time12(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return hhmm }
        let h = parts[0] % 12 == 0 ? 12 : parts[0] % 12
        return String(format: "%d:%02d %@", h, parts[1], parts[0] < 12 ? "AM" : "PM")
    }

    private func load() async {
        do {
            data = try await Climate.schedule()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(enabled: Bool, entries: [ScheduleState.Entry]) {
        saving = true
        Task {
            do {
                model.state = try await Climate.saveSchedule(.init(enabled: enabled, entries: entries))
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            await load()
            saving = false
        }
    }
}

struct EntryEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var entry: ScheduleState.Entry
    let data: ScheduleState
    let isNew: Bool
    let onSave: (ScheduleState.Entry) -> Void
    let onDelete: () -> Void

    private static let letters = ["S", "M", "T", "W", "T", "F", "S"]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Starts at", selection: timeBinding, displayedComponents: .hourAndMinute)
                    TextField("Name (optional), e.g. Night", text: $entry.name)
                }
                Section("Days") {
                    HStack(spacing: 6) {
                        ForEach(0..<7, id: \.self) { day in
                            let on = entry.days.contains(day)
                            Button {
                                if on { entry.days.removeAll { $0 == day } } else { entry.days.append(day); entry.days.sort() }
                            } label: {
                                Text(Self.letters[day])
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 36)
                                    .background(on ? Color.accentColor : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                                    .foregroundStyle(on ? .white : .primary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    HStack {
                        preset("Every day", Array(0...6))
                        preset("Weekdays", Array(1...5))
                        preset("Weekends", [0, 6])
                    }
                }
                Section("Mode") {
                    Picker("Mode", selection: $entry.mode) {
                        ForEach(ModeOption.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    if entry.mode != ModeOption.off.rawValue {
                        Stepper(value: targetBinding, in: targetRange, step: data.unit == "C" ? 0.5 : 1) {
                            HStack {
                                Text("Temperature")
                                Spacer()
                                Text(Temp.target(entry.target, unit: data.unit)).bold().monospacedDigit()
                            }
                        }
                    }
                }
                if data.sensorControl {
                    Section {
                        ForEach(data.sensors) { sensor in
                            let on = entry.sensors.contains(sensor.id)
                            Button {
                                if on {
                                    if entry.sensors.count > 1 { entry.sensors.removeAll { $0 == sensor.id } }
                                } else {
                                    entry.sensors.append(sensor.id)
                                }
                            } label: {
                                HStack {
                                    Text(sensor.name).foregroundStyle(.primary)
                                    Spacer()
                                    Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(on ? Color.accentColor : .secondary)
                                }
                            }
                        }
                    } header: {
                        Text("Temperature from")
                    } footer: {
                        Text(entry.sensors.count > 1 ? "The thermostat averages the selected sensors." : "Select more than one to average them.")
                    }
                }
                if !data.fanModes.isEmpty {
                    Section("Fan") {
                        Picker("Fan", selection: Binding(get: { entry.fan ?? data.fanModes.first?.value ?? "" }, set: { entry.fan = $0 })) {
                            ForEach(data.fanModes, id: \.self) { mode in
                                Text(mode.label).tag(mode.value)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                if !isNew {
                    Section {
                        Button("Delete this time", role: .destructive) {
                            onDelete()
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(isNew ? "New time" : "Edit time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(entry)
                        dismiss()
                    }
                    .disabled(entry.days.isEmpty || (data.sensorControl && entry.sensors.isEmpty))
                }
            }
        }
    }

    private func preset(_ title: String, _ days: [Int]) -> some View {
        Button(title) { entry.days = days }
            .font(.caption)
            .buttonStyle(.bordered)
    }

    // Temperatures are stored in °F; the stepper works in the displayed unit.
    private var targetBinding: Binding<Double> {
        Binding(
            get: { Temp.toUnit(entry.target, unit: data.unit) },
            set: { entry.target = Temp.fromUnit($0, unit: data.unit) }
        )
    }

    private var targetRange: ClosedRange<Double> {
        Temp.toUnit(50, unit: data.unit)...Temp.toUnit(90, unit: data.unit)
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                let parts = entry.time.split(separator: ":").compactMap { Int($0) }
                var c = DateComponents()
                c.hour = parts.first ?? 0
                c.minute = parts.count > 1 ? parts[1] : 0
                return Calendar.current.date(from: c) ?? Date()
            },
            set: { date in
                let c = Calendar.current.dateComponents([.hour, .minute], from: date)
                entry.time = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
            }
        )
    }
}
