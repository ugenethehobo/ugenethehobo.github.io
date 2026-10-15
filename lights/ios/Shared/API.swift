import Foundation
import WidgetKit

struct LightsError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Talks to your Home Lights server (the Cloudflare worker).
struct LightsAPI {
    let baseURL: URL
    let token: String?

    static var current: LightsAPI? {
        guard let url = SharedStore.serverURL else { return nil }
        return LightsAPI(baseURL: url, token: SharedStore.token)
    }

    struct Hello: Decodable {
        let app: String?
        let needsSetup: Bool
    }

    func hello() async throws -> Hello {
        try JSONDecoder().decode(Hello.self, from: try await send("/api/hello", method: "GET", body: nil, auth: false))
    }

    /// Signs in (or, on a brand-new server, creates the household passcode)
    /// and returns a token for this phone.
    func login(name: String, passcode: String, create: Bool) async throws -> String {
        let path = create ? "/api/setup" : "/api/login"
        let data = try await send(path, method: "POST", body: ["name": name, "passcode": passcode, "client": "native"], auth: false)
        struct Reply: Decodable { let token: String? }
        guard let token = try JSONDecoder().decode(Reply.self, from: data).token else {
            throw LightsError(message: "The server didn’t return a token.")
        }
        return token
    }

    func state() async throws -> HomeState {
        try decode(try await send("/api/state", method: "GET", body: nil))
    }

    /// Any change: returns the house as it is afterwards.
    func call(_ path: String, method: String = "POST", body: [String: Any]) async throws -> HomeState {
        try decode(try await send(path, method: method, body: body))
    }

    func saveSchedules(_ schedules: [Schedule]) async throws -> HomeState {
        struct Body: Encodable { let schedules: [Schedule] }
        let data = try JSONEncoder().encode(Body(schedules: schedules))
        return try decode(try await send("/api/schedules", method: "PUT", body: nil, rawBody: data))
    }

    private func decode(_ data: Data) throws -> HomeState {
        struct Reply: Decodable { let state: HomeState }
        do {
            return try JSONDecoder().decode(Reply.self, from: data).state
        } catch {
            throw LightsError(message: "The server sent something this app doesn’t understand. Update the app and the server to the same version.")
        }
    }

    private func send(_ path: String, method: String, body: [String: Any]?, rawBody: Data? = nil, auth: Bool = true) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw LightsError(message: "Bad server address")
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(TimeZone.current.identifier, forHTTPHeaderField: "X-Time-Zone")
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
            throw LightsError(message: "Can’t reach your Home Lights server")
        }
        let (data, response) = result
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            struct Failure: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            if status == 401 { SharedStore.token = nil }
            if status == 404 && message == nil {
                throw LightsError(message: "Your server doesn’t have this yet. If you just updated it, wait a few minutes for Cloudflare to finish deploying.")
            }
            throw LightsError(message: message ?? "Server error \(status)")
        }
        return data
    }
}

/// Shared helpers for the app, widgets, controls and Siri.
enum Lights {
    static func api() throws -> LightsAPI {
        guard let api = LightsAPI.current, api.token != nil else {
            throw LightsError(message: "Open Lights and sign in first")
        }
        return api
    }

    @discardableResult
    static func refresh(reloadWidgets: Bool = true) async throws -> HomeState {
        let state = try await api().state()
        save(state, reloadWidgets: reloadWidgets)
        return state
    }

    @discardableResult
    static func call(_ path: String, method: String = "POST", _ body: [String: Any] = [:]) async throws -> HomeState {
        let state = try await api().call(path, method: method, body: body)
        save(state, reloadWidgets: true)
        return state
    }

    @discardableResult
    static func saveSchedules(_ schedules: [Schedule]) async throws -> HomeState {
        let state = try await api().saveSchedules(schedules)
        save(state, reloadWidgets: false)
        return state
    }

    /// Turns lights on or off: every light, or one room.
    @discardableResult
    static func power(_ on: Bool, room: String? = nil) async throws -> HomeState {
        let target: [String: Any] = room.map { ["room": $0] } ?? ["all": true]
        return try await call("/api/lights", ["target": target, "on": on])
    }

    static func latest() async -> HomeState? {
        if let cached = SharedStore.lastState { return cached }
        return try? await refresh(reloadWidgets: false)
    }

    static func save(_ state: HomeState, reloadWidgets: Bool) {
        SharedStore.lastState = state
        if reloadWidgets {
            WidgetCenter.shared.reloadAllTimelines()
            ControlCenter.shared.reloadAllControls()
        }
    }
}
