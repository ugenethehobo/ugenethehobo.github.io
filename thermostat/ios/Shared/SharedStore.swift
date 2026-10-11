import Foundation

/// Settings shared between the app and its widgets through the App Group
/// (falls back to app-only storage if the App Group isn't available).
enum SharedStore {
    static let defaults: UserDefaults = {
        if let id = Bundle.main.object(forInfoDictionaryKey: "AppGroupID") as? String,
           let shared = UserDefaults(suiteName: id) {
            return shared
        }
        return .standard
    }()

    static var serverURL: URL? {
        get { defaults.string(forKey: "serverURL").flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: "serverURL") }
    }

    static var token: String? {
        get { defaults.string(forKey: "token") }
        set { defaults.set(newValue, forKey: "token") }
    }

    static var name: String? {
        get { defaults.string(forKey: "name") }
        set { defaults.set(newValue, forKey: "name") }
    }

    static var lastState: ClimateState? {
        get {
            guard let data = defaults.data(forKey: "lastState") else { return nil }
            return try? JSONDecoder().decode(ClimateState.self, from: data)
        }
        set {
            defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "lastState")
        }
    }

    static func signOut() {
        token = nil
        lastState = nil
    }
}
