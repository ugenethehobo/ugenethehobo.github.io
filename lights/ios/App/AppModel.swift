import SwiftUI
import UIKit

/// App state: refreshes every few seconds while open and sends changes.
@MainActor
final class AppModel: ObservableObject {
    @Published var state: HomeState? = SharedStore.lastState
    @Published var signedIn = SharedStore.token != nil
    @Published var error: String?
    @Published var busy = false

    private var timer: Timer?
    private var fast = false

    var serverURL: URL? { SharedStore.serverURL }

    func start() {
        stop()
        Task { await refresh() }
        schedule()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Polls faster while searching for lights or during a game.
    private func schedule() {
        let wantFast = (state?.scan.running ?? false) || (state?.chiefs.polling ?? false)
        fast = wantFast
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: wantFast ? 1.5 : 3, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }

    func refresh() async {
        guard signedIn else { return }
        do {
            let s = try await Lights.refresh(reloadWidgets: false)
            state = s
            if !busy { error = nil }
            let wantFast = s.scan.running || s.chiefs.polling
            if wantFast != fast, timer != nil { schedule() }
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
            let api = LightsAPI(baseURL: url, token: nil)
            let hello = try await api.hello()
            if hello.app != "home-lights" {
                throw LightsError(message: "That address isn’t a Home Lights server. (The thermostat has its own address.)")
            }
            let token = try await api.login(name: name, passcode: passcode, create: hello.needsSetup)
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

    // MARK: sending changes

    /// Sends a change and shows the result. Returns false if it failed.
    @discardableResult
    func send(_ path: String, method: String = "POST", _ body: [String: Any] = [:]) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            state = try await Lights.call(path, method: method, body)
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            await refresh()
            return false
        }
    }

    func fire(_ path: String, method: String = "POST", _ body: [String: Any] = [:]) {
        Task { await send(path, method: method, body) }
    }

    func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // Lights

    func setPower(_ on: Bool, ids: [String]) {
        tap()
        for id in ids {
            if let i = state?.lights.firstIndex(where: { $0.id == id }) { state?.lights[i].on = on }
        }
        fire("/api/lights", ["target": ["ids": ids], "on": on])
    }

    func setPower(_ on: Bool, room: String?) {
        tap()
        if var s = state {
            for i in s.lights.indices where room == nil || s.lights[i].room == room { s.lights[i].on = on }
            state = s
        }
        let target: [String: Any] = room.map { ["room": $0] } ?? ["all": true]
        fire("/api/lights", ["target": target, "on": on])
    }

    func setBrightness(_ bri: Int, target: [String: Any]) {
        fire("/api/lights", ["target": target, "bri": bri])
    }

    func setColor(_ hex: String, target: [String: Any]) {
        tap()
        fire("/api/lights", ["target": target, "color": hex])
    }

    func setWhite(_ ct: Int, target: [String: Any]) {
        tap()
        fire("/api/lights", ["target": target, "ct": ct])
    }

    func saveSchedules(_ list: [Schedule]) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            state = try await Lights.saveSchedules(list)
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func setChiefs(_ patch: [String: Any]) {
        fire("/api/chiefs", method: "PUT", patch)
    }
}
