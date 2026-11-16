import SwiftUI

struct WatchProjectsView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            if let snapshot = store.snapshot {
                                Text("更新於\(minutesSince(snapshot.at, now: context.date))分鐘前")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        WatchConnectionStatus()
                        if store.snapshot?.demo == true {
                            Label("示範模式", systemImage: "play.circle")
                        }
                    }
                    .font(.footnote)
                }
                if let projects = store.snapshot?.projects, !projects.isEmpty {
                    ForEach(projects) { project in
                        NavigationLink {
                            WatchProjectView(projectID: project.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                if project.isPrivate {
                                    Label("隱私專案", systemImage: "lock.fill")
                                } else {
                                    Text(project.name)
                                }
                                WatchCountBadges(counts: project.counts)
                            }
                        }
                        .accessibilityIdentifier("watch-project-\(project.id)")
                    }
                } else {
                    Text("還沒有專案")
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task { await store.refresh() }
                } label: {
                    if store.isRefreshing {
                        ProgressView("正在更新…")
                    } else {
                        Label("重新整理", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(!store.isReachable || store.isRefreshing)
                .accessibilityIdentifier("watch-refresh")
            }
            .accessibilityIdentifier("watch-projects")
            .navigationTitle("專案")
            .refreshable { await store.refresh() }
        }
        .alert("錯誤", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("好", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }

    private func minutesSince(_ timestamp: String, now: Date) -> Int {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp) ?? now
        return max(0, Int(now.timeIntervalSince(date) / 60))
    }
}

struct WatchConnectionStatus: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        if !store.isReachable {
            Label("iPhone 不在附近", systemImage: "iphone.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

struct WatchCountBadges: View {
    let counts: WatchCounts

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { badges }
            VStack(alignment: .leading, spacing: 4) { badges }
        }
        .font(.caption)
    }

    private var badges: some View {
        Group {
            Text("卡住 \(counts.blocked)")
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(.red)
                .background(.red.opacity(0.15), in: Capsule())
            Text("提案 \(counts.proposed)")
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .foregroundStyle(.blue)
                .background(.blue.opacity(0.15), in: Capsule())
        }
    }
}

struct WatchProjectView: View {
    @EnvironmentObject private var store: WatchStore
    let projectID: String
    @State private var showsFullProgress = false

    var body: some View {
        List {
            WatchConnectionStatus()
            if let project = store.project(projectID) {
                if project.isPrivate {
                    Section("隱私專案") {
                        WatchCountBadges(counts: project.counts)
                        Text("工作卡（\(project.counts.total)）")
                        Text("隱私專案只顯示數量，請在 iPhone 上查看內容。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button("問管家") {}.disabled(true)
                    Button("工作卡（\(project.counts.total)）") {}.disabled(true)
                } else {
                    if let goal = project.goal, !goal.isEmpty {
                        Section("目標") { WatchMarkdownText(text: goal) }
                    }
                    if let progress = project.progress, !progress.isEmpty {
                        Section("目前進度") {
                            WatchMarkdownText(text: progress)
                                .lineLimit(showsFullProgress ? nil : 4)
                                .accessibilityIdentifier("watch-progress")
                            Button(showsFullProgress ? String(localized: "收起") : String(localized: "更多")) {
                                showsFullProgress.toggle()
                            }
                        }
                    }
                    if !project.nextSteps.isEmpty {
                        Section("下一步") {
                            ForEach(Array(project.nextSteps.enumerated()), id: \.offset) { _, text in
                                WatchMarkdownText(text: text)
                            }
                        }
                    }
                    if !project.blockers.isEmpty {
                        Section("卡住的地方") {
                            ForEach(Array(project.blockers.enumerated()), id: \.offset) { _, text in
                                WatchMarkdownText(text: text)
                            }
                        }
                    }
                    Section {
                        NavigationLink {
                            WatchAskView(projectID: projectID)
                        } label: {
                            Label("問管家", systemImage: "bubble.left.and.bubble.right")
                        }
                        .disabled(!store.isReachable)
                        .accessibilityIdentifier("watch-ask")
                        NavigationLink {
                            WatchCardsView(projectID: projectID)
                        } label: {
                            Text("工作卡（\(project.cards.count)）")
                        }
                        .accessibilityIdentifier("watch-cards")
                    }
                }
            } else {
                Text("找不到專案")
            }
        }
        .navigationTitle(store.project(projectID).map { $0.isPrivate ? String(localized: "隱私專案") : $0.name } ?? String(localized: "專案"))
    }
}
