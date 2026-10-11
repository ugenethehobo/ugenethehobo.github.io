import SwiftUI
import WidgetKit

struct ClimateEntry: TimelineEntry {
    let date: Date
    let state: ClimateState?
    let error: String?
}

/// Fetches fresh state for every widget. iOS decides how often widgets
/// refresh (roughly every 15–30 minutes); tapping a widget button or using
/// the app refreshes them right away.
struct ClimateProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClimateEntry {
        ClimateEntry(date: .now, state: .preview, error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ClimateEntry) -> Void) {
        completion(ClimateEntry(date: .now, state: SharedStore.lastState ?? .preview, error: nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ClimateEntry>) -> Void) {
        Task {
            let entry: ClimateEntry
            do {
                let state = try await Climate.refresh(reloadWidgets: false)
                entry = ClimateEntry(date: .now, state: state, error: nil)
            } catch {
                entry = ClimateEntry(date: .now, state: SharedStore.lastState, error: error.localizedDescription)
            }
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }
}
