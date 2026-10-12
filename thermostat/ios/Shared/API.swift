import Foundation
import WidgetKit

struct ClimateError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Talks to your Home Climate server (the Cloudflare worker).
struct ClimateAPI {
    let baseURL: URL
    let token: String?

    static var current: ClimateAPI? {
        guard let url = SharedStore.serverURL else { return nil }
        return ClimateAPI(baseURL: url, token: SharedStore.token)
    }

    /// Signs in with the household passcode and returns a token for this phone.
    func login(name: String, passcode: String) async throws -> String {
        let data = try await send("/api/login", method: "POST", body: ["name": name, "passcode": passcode, "client": "native"], auth: false)
        struct Reply: Decodable { let token: String? }
        guard let token = try JSONDecoder().decode(Reply.self, from: data).token else {
            throw ClimateError(message: "The server didn’t return a token. Update the server and try again.")
        }
        return token
    }

    func state() async throws -> ClimateState {
        try decodeState(try await send("/api/widget", method: "GET", body: nil))
    }

    func control(_ body: [String: Any]) async throws -> ClimateState {
        try decodeState(try await send("/api/control?view=widget", method: "POST", body: body))
    }

    func schedule() async throws -> ScheduleState {
        try JSONDecoder().decode(ScheduleState.self, from: try await send("/api/schedule", method: "GET", body: nil))
    }

    func saveSchedule(_ schedule: ScheduleState.Schedule) async throws -> ClimateState {
        let data = try JSONEncoder().encode(schedule)
        return try decodeState(try await send("/api/schedule?view=widget", method: "PUT", body: nil, rawBody: data))
    }

    func resume() async throws -> ClimateState {
        try decodeState(try await send("/api/resume?view=widget", method: "POST", body: [:]))
    }

    private func decodeState(_ data: Data) throws -> ClimateState {
        struct Reply: Decodable { let widget: ClimateState }
        return try JSONDecoder().decode(Reply.self, from: data).widget
    }

    private func send(_ path: String, method: String, body: [String: Any]?, rawBody: Data? = nil, auth: Bool = true) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw ClimateError(message: "Bad server address")
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        } else if let rawBody {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = rawBody
        }
        if auth, let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let result: (Data, URLResponse)
        do {
            result = try await URLSession.shared.data(for: req)
        } catch {
            throw ClimateError(message: "Can’t reach your Home Climate server")
        }
        let (data, response) = result
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            struct Failure: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            if status == 401 { SharedStore.token = nil }
            throw ClimateError(message: message ?? "Server error \(status)")
        }
        return data
    }
}

/// Shared helpers for the app, widgets, controls and Siri.
enum Climate {
    static func api() throws -> ClimateAPI {
        guard let api = ClimateAPI.current, api.token != nil else {
            throw ClimateError(message: "Open Climate and sign in first")
        }
        return api
    }

    /// Fetches fresh state. Widgets pass `reloadWidgets: false` so a timeline
    /// refresh doesn't trigger another refresh.
    @discardableResult
    static func refresh(reloadWidgets: Bool = true) async throws -> ClimateState {
        let state = try await api().state()
        save(state, reloadWidgets: reloadWidgets)
        return state
    }

    @discardableResult
    static func control(_ body: [String: Any]) async throws -> ClimateState {
        let state = try await api().control(body)
        save(state, reloadWidgets: true)
        return state
    }

    static func schedule() async throws -> ScheduleState {
        try await api().schedule()
    }

    @discardableResult
    static func saveSchedule(_ schedule: ScheduleState.Schedule) async throws -> ClimateState {
        let state = try await api().saveSchedule(schedule)
        save(state, reloadWidgets: true)
        return state
    }

    @discardableResult
    static func resume() async throws -> ClimateState {
        let state = try await api().resume()
        save(state, reloadWidgets: true)
        return state
    }

    /// Most recent state, fetching it if nothing is cached.
    static func latest() async -> ClimateState? {
        if let cached = SharedStore.lastState { return cached }
        return try? await refresh(reloadWidgets: false)
    }

    static func save(_ state: ClimateState, reloadWidgets: Bool) {
        SharedStore.lastState = state
        if reloadWidgets {
            WidgetCenter.shared.reloadAllTimelines()
            ControlCenter.shared.reloadAllControls()
        }
    }
}
