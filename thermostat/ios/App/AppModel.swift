import SwiftUI
import UIKit

/// App state: refreshes every few seconds while open and sends changes.
@MainActor
final class AppModel: ObservableObject {
    @Published var state: ClimateState? = SharedStore.lastState
    @Published var signedIn = SharedStore.token != nil
    @Published var sending: String?   // what's being sent, for the status chip
    @Published var error: String?
    @Published var lastUpdate: Date?

    private var timer: Timer?

    var webURL: URL? { SharedStore.serverURL }

    func start() {
        stop()
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() async {
        guard signedIn else { return }
        do {
            state = try await Climate.refresh()
            lastUpdate = Date()
            if sending == nil { error = nil }
        } catch {
            self.error = error.localizedDescription
            signedIn = SharedStore.token != nil
        }
    }

    func signIn(server: String, name: String, passcode: String) async {
        var address = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if !address.lowercased().hasPrefix("http") { address = "https://" + address }
        guard let url = URL(string: address), url.host != nil else {
            error = "That server address doesn’t look right"
            return
        }
        do {
            let token = try await ClimateAPI(baseURL: url, token: nil).login(name: name, passcode: passcode)
            SharedStore.serverURL = url
            SharedStore.token = token
            SharedStore.name = name
            error = nil
            signedIn = true
            start()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signOut() {
        stop()
        SharedStore.signOut()
        state = nil
        signedIn = false
    }

    // MARK: changes

    func nudge(_ steps: Int) {
        guard var s = state else { return }
        tap()
        s.program.target += Double(steps) * Temp.stepF(unit: s.unit)
        state = s // show it right away
        send("\(Temp.target(s.program.target, unit: s.unit))", ["delta": Double(steps) * Temp.stepF(unit: s.unit)])
    }

    func setMode(_ mode: ModeOption) {
        guard state?.mode != mode else { return }
        tap()
        state?.program.mode = mode.rawValue
        send(mode.title, ["mode": mode.rawValue])
    }

    func setFan(_ value: String) {
        guard state?.program.fan != value else { return }
        tap()
        state?.program.fan = value
        send("fan", ["fan": value])
    }

    /// Tap a sensor: follow just that one. Combine: add or remove it.
    func useSensor(_ id: String, combine: Bool) {
        guard let s = state else { return }
        var sensors = combine ? s.program.sensors : []
        if combine, let i = sensors.firstIndex(of: id) {
            guard sensors.count > 1 else {
                error = "At least one sensor is needed"
                return
            }
            sensors.remove(at: i)
        } else if !sensors.contains(id) {
            sensors.append(id)
        }
        if !combine && s.program.sensors == [id] { return }
        tap()
        state?.program.sensors = sensors
        send("sensors", ["sensors": sensors])
    }

    func resume() {
        tap()
        sending = "schedule"
        Task {
            do {
                state = try await Climate.resume()
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            sending = nil
        }
    }

    private func send(_ label: String, _ body: [String: Any]) {
        sending = label
        Task {
            do {
                state = try await Climate.control(body)
                error = state?.lastError
            } catch {
                self.error = error.localizedDescription
                await refresh()
            }
            sending = nil
        }
    }

    private func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
