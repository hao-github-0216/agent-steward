// 專案列表與專案詳情
import SwiftUI

struct ProjectListView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    private var shown: [Project] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return model.projects }
        return model.projects.filter { $0.name.localizedCaseInsensitiveContains(q) || ($0.root ?? "").localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            List {
                if let err = model.lastError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(.red)
                }
                ForEach(shown) { p in
                    NavigationLink(value: Route.project(p.id)) { ProjectRow(project: p) }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("專案")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .project(let id): ProjectDetailView(projectId: id)
                case .chat(let id):
                    if let p = model.project(id) { ChatView(project: p) } else { ContentUnavailableView("找不到這個專案", systemImage: "questionmark.folder") }
                }
            }
            .searchable(text: $query, prompt: "找專案")
            .refreshable { await model.refresh() }
            .overlay {
                if model.projects.isEmpty && !model.loading {
                    ContentUnavailableView("還沒有專案", systemImage: "tray", description: Text("在電腦上用 agent 開始工作後,管家會自動建立專案。"))
                } else if !query.isEmpty && shown.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
        }
    }
}

struct ProjectRow: View {
    @Environment(AppModel.self) private var model
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(project.name).font(.headline).lineLimit(1)
                if project.private == true {
                    Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                let n = model.working(project)
                if n > 0 {
                    Label("\(n)", systemImage: "bolt.fill")
                        .font(.caption.bold())
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(.orange.opacity(0.18), in: Capsule())
                        .foregroundStyle(.orange)
                        .accessibilityLabel("\(n) 個 agent 工作中")
                }
            }
            if let progress = project.state?.progress, !progress.isEmpty {
                Text(Markdown.plain(progress))
                    .font(.subheadline).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text(Fmt.ago(project.lastActive))
                .font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

struct ProjectDetailView: View {
    @Environment(AppModel.self) private var model
    let projectId: String

    private var project: Project? { model.projects.first { $0.id == projectId } }

    var body: some View {
        if let p = project {
            List {
                Section {
                    NavigationLink(value: Route.chat(p.id)) {
                        Label("問管家", systemImage: "bubble.left.and.text.bubble.right.fill")
                            .font(.headline)
                            .foregroundStyle(.orange)
                    }
                }
                if let goal = p.state?.goal, !goal.isEmpty {
                    Section("目標") { MarkdownText(goal, fixEscapes: true) }
                }
                if let progress = p.state?.progress, !progress.isEmpty {
                    Section("目前進度") { MarkdownText(progress, fixEscapes: true) }
                }
                let cards = model.openCards(p)
                if !cards.isEmpty {
                    Section("工作卡") {
                        ForEach(cards) { c in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(c.columnLabel)
                                        .font(.caption.bold())
                                        .padding(.horizontal, 6).padding(.vertical, 1)
                                        .background(columnColor(c.column).opacity(0.18), in: Capsule())
                                        .foregroundStyle(columnColor(c.column))
                                    if let a = c.agent { Text(a).font(.caption).foregroundStyle(.secondary) }
                                }
                                Text(c.title).font(.subheadline)
                                if let note = c.note, !note.isEmpty {
                                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                }
                            }
                        }
                    }
                }
                bullets("下一步", p.state?.nextSteps)
                bullets("卡住的地方", p.state?.blockers)
                bullets("重要決定", p.state?.decisions)
                if let recent = p.state?.recent, !recent.isEmpty {
                    Section("最近的工作") {
                        ForEach(Array(recent.prefix(8).enumerated()), id: \.offset) { _, r in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(Fmt.ago(Fmt.date(r.at))) · \(r.agent ?? "")")
                                    .font(.caption).foregroundStyle(.secondary)
                                MarkdownText(r.summary ?? "", fixEscapes: true)
                            }
                        }
                    }
                }
            }
            .navigationTitle(p.name)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.refresh() }
        } else {
            ContentUnavailableView("找不到這個專案", systemImage: "questionmark.folder")
        }
    }

    @ViewBuilder
    private func bullets(_ title: String, _ items: [String]?) -> some View {
        if let items, !items.isEmpty {
            Section(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, s in MarkdownText(s, fixEscapes: true) }
            }
        }
    }

    private func columnColor(_ c: String) -> Color {
        switch c {
        case "blocked": .red
        case "running": .orange
        case "approved": .blue
        default: .secondary
        }
    }
}
