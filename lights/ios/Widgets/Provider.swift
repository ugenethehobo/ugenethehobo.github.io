import SwiftUI
import WidgetKit

struct LightsEntry: TimelineEntry {
    let date: Date
    let state: HomeState?
    let error: String?
}

/// Fetches fresh state for the widgets. iOS decides how often widgets refresh
/// (roughly every 15–30 minutes); tapping a widget button or using the app
/// refreshes them right away.
struct LightsProvider: TimelineProvider {
    func placeholder(in context: Context) -> LightsEntry {
        LightsEntry(date: .now, state: nil, error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (LightsEntry) -> Void) {
        completion(LightsEntry(date: .now, state: SharedStore.lastState, error: nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LightsEntry>) -> Void) {
        Task {
            let entry: LightsEntry
            do {
                let state = try await Lights.refresh(reloadWidgets: false)
                entry = LightsEntry(date: .now, state: state, error: nil)
            } catch {
                entry = LightsEntry(date: .now, state: SharedStore.lastState, error: error.localizedDescription)
            }
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }
}
