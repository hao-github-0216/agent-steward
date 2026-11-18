import SwiftUI
import WidgetKit

struct StewardWatchEntry: TimelineEntry {
    let date: Date
    let snapshot: WatchSnapshot?
    let projectID: String?

    private var selectedProject: WatchProject? {
        guard let projectID else { return nil }
        return snapshot?.projects.first { $0.id == projectID }
    }

    private var projects: [WatchProject] {
        if let selectedProject { return [selectedProject] }
        return snapshot?.projects ?? []
    }

    var blocked: Int { projects.reduce(0) { $0 + $1.counts.blocked } }
    var proposed: Int { projects.reduce(0) { $0 + $1.counts.proposed } }
    var projectName: String? {
        if let selectedProject {
            return selectedProject.isPrivate ? String(localized: "隱私專案") : selectedProject.name
        }
        return snapshot?.projects.filter { !$0.isPrivate }.max {
            $0.counts.blocked + $0.counts.proposed < $1.counts.blocked + $1.counts.proposed
        }?.name
    }
}

struct StewardWatchProvider: TimelineProvider {
    func placeholder(in context: Context) -> StewardWatchEntry {
        StewardWatchEntry(date: .now, snapshot: nil, projectID: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (StewardWatchEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StewardWatchEntry>) -> Void) {
        completion(Timeline(entries: [entry()], policy: .after(.now.addingTimeInterval(15 * 60))))
    }

    private func entry() -> StewardWatchEntry {
        let defaults = UserDefaults(suiteName: WatchWire.appGroup)
        let data = defaults?.data(forKey: WatchWire.cacheKey)
        let snapshot = data.flatMap { try? WatchWire.decode(WatchSnapshot.self, from: $0) }
        let projectID = defaults?.string(forKey: WatchWire.complicationProjectKey)
        return StewardWatchEntry(date: .now, snapshot: snapshot, projectID: projectID)
    }
}

struct StewardComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StewardWatchEntry

    var body: some View {
        Group {
            if entry.snapshot == nil {
                Label("專案管家", systemImage: "list.bullet.clipboard")
            } else {
                switch family {
                case .accessoryCircular:
                    VStack(spacing: 1) {
                        Image(systemName: "exclamationmark.triangle")
                        Text(entry.blocked, format: .number).font(.title3.bold())
                    }
                    .accessibilityLabel(Text("卡住 \(entry.blocked)"))
                case .accessoryRectangular:
                    VStack(alignment: .leading) {
                        Text("卡住 \(entry.blocked)・提案 \(entry.proposed)").font(.headline)
                        if let name = entry.projectName {
                            Text(verbatim: name).lineLimit(1)
                        }
                    }
                default:
                    Text("卡住 \(entry.blocked)・提案 \(entry.proposed)")
                }
            }
        }
        .containerBackground(for: .widget) { Color.clear }
        .widgetURL(URL(string: "agentsteward-watch://projects"))
    }
}

@main
struct StewardWatchWidgets: Widget {
    let kind = "StewardComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: StewardWatchProvider()) { entry in
            StewardComplicationView(entry: entry)
        }
        .configurationDisplayName("專案管家")
        .description("在錶面上查看卡住與提案的工作卡。")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
