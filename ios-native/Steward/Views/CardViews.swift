// 工作卡:跨專案的看板(依欄位分頁)、單張卡的詳情與動作(核准派工、標完成、退回…)
import SwiftUI

struct CardsView: View {
    @Environment(AppModel.self) private var model
    private var column: String { model.cardColumn }

    private static let tabs: [(String, String, [String])] = [
        ("proposed", "提案", ["proposed"]),
        ("running", "進行中", ["approved", "running"]),
        ("blocked", "卡住", ["blocked"]),
        ("done", "完成", ["done"]),
    ]

    private var shown: [Card] {
        let cols = Self.tabs.first { $0.0 == column }?.2 ?? []
        return model.cards.filter { cols.contains($0.column) }
            .sorted { ($0.lastChanged ?? .distantPast) > ($1.lastChanged ?? .distantPast) }
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            List {
                Section {
                    Picker("欄位", selection: $model.cardColumn) {
                        ForEach(Self.tabs, id: \.0) { t in
                            let n = model.cards.filter { t.2.contains($0.column) }.count
                            Text(n > 0 && t.0 != "done" ? "\(t.1) \(n)" : t.1).tag(t.0)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                ForEach(shown) { c in
                    NavigationLink(value: Route.card(c.id)) {
                        CardRow(card: c, showProject: true)
                    }
                    .swipeActions(edge: .trailing) { CardSwipeActions(card: c) }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("工作卡")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .card(let id): CardDetailView(cardId: id)
                case .project(let id): ProjectDetailView(projectId: id)
                case .chat(let id):
                    if let p = model.project(id) { ChatView(project: p) }
                }
            }
            .refreshable { await model.refresh() }
            .overlay {
                if shown.isEmpty {
                    ContentUnavailableView(column == "proposed" ? "沒有等核准的提案" : "這一欄是空的", systemImage: "checklist")
                }
            }
        }
    }
}

struct CardRow: View {
    @Environment(AppModel.self) private var model
    let card: Card
    var showProject = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                ColumnBadge(column: card.column, label: card.columnLabel)
                if showProject, let p = model.project(card.projectId) {
                    Text(p.name).font(.caption.bold()).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(Fmt.ago(card.lastChanged)).font(.caption).foregroundStyle(.tertiary)
            }
            Text(card.title).font(.subheadline.weight(.medium))
            HStack(spacing: 6) {
                if let a = card.agent { Label(a, systemImage: "person.crop.square").font(.caption).foregroundStyle(.secondary) }
                if let note = card.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct ColumnBadge: View {
    let column: String
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.bold())
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    var color: Color {
        switch column {
        case "blocked": .red
        case "running", "approved": .orange
        case "proposed": .blue
        case "done": .green
        default: .secondary
        }
    }
}

/// 列表上往左滑:最常用的那一個動作
struct CardSwipeActions: View {
    @Environment(AppModel.self) private var model
    let card: Card
    @State private var error: String?

    var body: some View {
        ForEach(card.actions.prefix(2)) { a in
            Button(role: a.destructive ? .destructive : nil) {
                Task { try? await model.move(card, a) }
            } label: {
                Label(a.label, systemImage: a.icon)
            }
            .tint(a.destructive ? .red : (a == .dispatch || a == .redispatch ? .orange : .blue))
        }
    }
}

struct CardDetailView: View {
    @Environment(AppModel.self) private var model
    let cardId: String
    @State private var busy: CardAction?
    @State private var error: String?
    @State private var confirm: CardAction?

    var body: some View {
        if let c = model.card(cardId) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            ColumnBadge(column: c.column, label: c.columnLabel)
                            if let p = model.project(c.projectId) { Text(p.name).font(.caption).foregroundStyle(.secondary) }
                        }
                        Text(c.title).font(.title3.bold())
                        if let a = c.agent { Label("交給 \(a)", systemImage: "person.crop.square").font(.subheadline).foregroundStyle(.secondary) }
                    }
                }
                if let note = c.note, !note.isEmpty {
                    Section("最新狀態") { MarkdownText(note, fixEscapes: true) }
                }
                if let ins = c.instructions, !ins.isEmpty {
                    Section("工作說明") { MarkdownText(ins) }
                }
                if let done = c.doneCriteria, !done.isEmpty {
                    Section("完成標準") { MarkdownText(done) }
                }
                Section {
                    ForEach(c.actions) { a in
                        Button(role: a.destructive ? .destructive : nil) {
                            if a == .dispatch || a == .redispatch { confirm = a } else { Task { await run(c, a) } }
                        } label: {
                            HStack {
                                Label(a.label, systemImage: a.icon)
                                Spacer()
                                if busy == a { ProgressView() }
                            }
                        }
                        .disabled(busy != nil)
                    }
                    if c.paneId != nil, c.column == "running" || c.column == "approved" || c.column == "blocked" {
                        Button {
                            Task {
                                do { try await model.api?.focusCard(c.id); model.tab = 1 } catch { self.error = error.localizedDescription }
                            }
                        } label: {
                            Label("在終端機看這個 agent", systemImage: "terminal")
                        }
                    }
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("工作卡")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.refresh() }
            .confirmationDialog(confirm == .redispatch ? "要重新派工嗎?" : "要核准並派工嗎?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
                if let a = confirm {
                    Button(a.label) { Task { await run(c, a) } }
                }
            } message: {
                Text("管家會在 herdr 開一個 \(c.agent ?? "agent") 開始做這張卡。")
            }
        } else {
            ContentUnavailableView("找不到這張工作卡", systemImage: "questionmark.square.dashed")
        }
    }

    private func run(_ c: Card, _ a: CardAction) async {
        busy = a
        defer { busy = nil }
        do {
            try await model.move(c, a)
            error = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

/// 某個專案的程式碼頁面(檔案、版本控制、編輯器):沿用管家網頁,全螢幕顯示
struct CodeWebView: View {
    @Environment(AppModel.self) private var model
    let project: Project

    var body: some View {
        Group {
            if let base = model.server,
               let url = URL(string: "?app=1&project=\(project.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? project.id)#code", relativeTo: base)?.absoluteURL {
                WebView(url: url, reloadToken: 0)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
    }
}
