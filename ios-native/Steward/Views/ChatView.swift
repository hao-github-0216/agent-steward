// 問管家:跟網頁浮動球是同一份對話紀錄(在電腦上問的這裡也看得到)
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    let project: Project

    @State private var items: [ChatEntry] = []
    @State private var more = false
    @State private var loading = true
    @State private var loadError: String?
    @State private var suggestions: [String] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var showDraft = false
    @FocusState private var inputFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if more {
                        Button("載入更早的對話") { Task { await loadOlder() } }
                            .font(.footnote)
                            .padding(.top, 4)
                    }
                    if let loadError {
                        Label(loadError, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                    }
                    if !loading && items.isEmpty && loadError == nil {
                        ContentUnavailableView("還沒問過管家", systemImage: "bubble.left.and.bubble.right",
                                               description: Text("問這個專案的進度、卡在哪、下一步該做什麼。"))
                            .padding(.top, 40)
                    }
                    ForEach(items) { e in
                        MessageBubble(entry: e, project: project) { updated in
                            if let i = items.firstIndex(where: { $0.id == updated.id }) { items[i] = updated }
                        }
                        .id(e.id)
                    }
                    if sending {
                        HStack {
                            ProgressView()
                            Text("管家想一下…").font(.footnote).foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal)
                        .id("thinking")
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: items.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: sending) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .safeAreaInset(edge: .bottom) { inputBar }
        }
        .navigationTitle("問管家")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showDraft = true } label: { Image(systemName: "plus.rectangle.on.rectangle") }
                    .accessibilityLabel("開工作卡")
                    .disabled(sending)
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("問管家").font(.headline)
                    Text(project.name).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showDraft) {
            NewDraftSheet { message in startDraft(message) }
                .presentationDetents([.medium])
        }
    }

    /// 請管家擬工作卡:跟提問一樣先把「開工作卡:…」放上去,草稿回來後顯示成可以修改的卡片
    private func startDraft(_ message: String) {
        guard let api = model.api, !sending else { return }
        sending = true
        let tempId = "local-\(UUID().uuidString)"
        items.append(ChatEntry(id: tempId, role: "me", text: message.isEmpty ? "開工作卡" : "開工作卡:\(message)"))
        Task {
            do {
                let r = try await api.draftCard(project: project.id, message: message)
                if let me = r.me, let i = items.firstIndex(where: { $0.id == tempId }) { items[i] = me }
                if let bot = r.bot { items.append(bot) }
            } catch {
                items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: error.localizedDescription, error: true))
            }
            sending = false
        }
    }

    private var inputBar: some View {
        VStack(spacing: 8) {
            if !suggestions.isEmpty && draft.isEmpty && !sending {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(suggestions, id: \.self) { s in
                            Button { send(s) } label: {
                                Text(s).font(.subheadline).lineLimit(1)
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .background(Color(.secondarySystemBackground), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("問管家…", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                Button { send(draft) } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                .accessibilityLabel("送出")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func load() async {
        guard let api = model.api else { return }
        loading = true
        do {
            let page = try await api.chat(project: project.id)
            items = page.items
            more = page.more ?? false
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
        suggestions = (try? await api.suggestions(project: project.id)) ?? []
    }

    private func loadOlder() async {
        guard let api = model.api, let first = items.first else { return }
        if let page = try? await api.chat(project: project.id, before: first.id) {
            items.insert(contentsOf: page.items, at: 0)
            more = page.more ?? false
        }
    }

    private func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending, let api = model.api else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        draft = ""
        sending = true
        // 先把問題放上去(管家那邊回答要一段時間)
        let tempId = "local-\(UUID().uuidString)"
        items.append(ChatEntry(id: tempId, role: "me", text: text))
        Task {
            do {
                let r = try await api.ask(project: project.id, message: text)
                if let i = items.firstIndex(where: { $0.id == tempId }) {
                    if let me = r.me { items[i] = me }
                }
                if let bot = r.bot {
                    items.append(bot)
                } else if let answer = r.answer {
                    items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: answer))
                }
                UINotificationFeedbackGenerator().notificationOccurred(r.bot?.error == true ? .error : .success)
            } catch {
                items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: error.localizedDescription, error: true))
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            sending = false
            suggestions = (try? await api.suggestions(project: project.id)) ?? suggestions
        }
    }
}

struct NewDraftSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onSubmit: (String) -> Void
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("要做什麼?例如:修好登入頁在手機上跑版", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                } footer: {
                    Text("管家會依這個專案的狀態和剛才的對話擬一張工作卡草稿,你確認或修改後再放進提案或直接派工。留空就讓管家從對話裡判斷。")
                }
            }
            .navigationTitle("開工作卡")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("請管家擬") { onSubmit(text.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                }
            }
        }
    }
}

/// 管家擬的工作卡草稿:還沒處理時可以改欄位、放進提案或直接派工
struct DraftCardView: View {
    @Environment(AppModel.self) private var model
    let entry: ChatEntry
    let project: Project
    let onUpdate: (ChatEntry) -> Void
    @State private var draft: CardDraft
    @State private var busy: String?
    @State private var error: String?
    @State private var editing = false

    init(entry: ChatEntry, project: Project, onUpdate: @escaping (ChatEntry) -> Void) {
        self.entry = entry
        self.project = project
        self.onUpdate = onUpdate
        _draft = State(initialValue: entry.draft!)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("工作卡草稿", systemImage: "rectangle.stack.badge.plus").font(.caption.bold()).foregroundStyle(.orange)
                Spacer()
                if draft.status == "draft" {
                    Button(editing ? "完成" : "修改") { editing.toggle() }.font(.caption)
                }
            }
            if editing {
                TextField("標題", text: $draft.title).textFieldStyle(.roundedBorder)
                Picker("交給", selection: $draft.agent) {
                    ForEach(model.agents.isEmpty ? [AgentInfo(id: draft.agent)] : model.agents) { a in Text(a.name ?? a.id).tag(a.id) }
                }
                TextField("工作說明", text: $draft.instructions, axis: .vertical).lineLimit(3...10).textFieldStyle(.roundedBorder)
                TextField("完成標準", text: $draft.doneCriteria, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
            } else {
                Text(draft.title).font(.headline)
                Label("交給 \(draft.agent)", systemImage: "person.crop.square").font(.caption).foregroundStyle(.secondary)
                Text(draft.instructions).font(.subheadline).lineLimit(6)
                if !draft.doneCriteria.isEmpty {
                    Text("完成標準:\(draft.doneCriteria)").font(.caption).foregroundStyle(.secondary).lineLimit(4)
                }
            }
            switch draft.status {
            case "proposed":
                statusLink("已放進提案", icon: "tray.and.arrow.down")
            case "dispatched":
                statusLink("已派工", icon: "paperplane.fill")
            default:
                HStack {
                    Button { Task { await act("propose") } } label: {
                        if busy == "propose" { ProgressView() } else { Text("放進提案") }
                    }
                    .buttonStyle(.bordered)
                    Button { Task { await act("dispatch") } } label: {
                        if busy == "dispatch" { ProgressView() } else { Text("直接派工") }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .disabled(busy != nil)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.orange.opacity(0.35)))
    }

    @ViewBuilder
    private func statusLink(_ text: String, icon: String) -> some View {
        if let id = draft.cardId {
            NavigationLink(value: Route.card(id)) { Label(text, systemImage: icon).font(.subheadline.bold()) }
        } else {
            Label(text, systemImage: icon).font(.subheadline.bold()).foregroundStyle(.secondary)
        }
    }

    private func act(_ action: String) async {
        guard let api = model.api else { return }
        busy = action
        defer { busy = nil }
        do {
            let r = try await api.draftAction(project: project.id, entry: entry.id, action: action, draft: draft)
            if let bot = r.bot { onUpdate(bot); if let d = bot.draft { draft = d } }
            editing = false
            error = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await model.refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct MessageBubble: View {
    let entry: ChatEntry
    var project: Project? = nil
    var onUpdate: (ChatEntry) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .top) {
            if entry.isMine { Spacer(minLength: 48) }
            VStack(alignment: entry.isMine ? .trailing : .leading, spacing: 4) {
                if let q = entry.quote, let t = q.text, !t.isEmpty {
                    Text(quoteLabel(q) + t)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                        .padding(8)
                        .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                if let project, entry.draft != nil {
                    DraftCardView(entry: entry, project: project, onUpdate: onUpdate)
                } else {
                Group {
                    if entry.isMine {
                        Text(entry.text).textSelection(.enabled)
                    } else {
                        MarkdownText(entry.text)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .foregroundStyle(entry.isMine ? Color.white : (entry.error == true ? Color.red : Color.primary))
                .background(bubbleColor, in: RoundedRectangle(cornerRadius: 18))
                }
                if let meta = metaLine {
                    Text(meta).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if !entry.isMine { Spacer(minLength: 24) }
        }
        .padding(.horizontal)
    }

    private var bubbleColor: Color {
        if entry.isMine { return .orange }
        return entry.error == true ? Color.red.opacity(0.1) : Color(.secondarySystemBackground)
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let via = entry.via { parts.append("↪ \(via)") }
        if let alt = entry.alt { parts.append(alt) }
        if let d = Fmt.date(entry.at) { parts.append(Fmt.ago(d)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func quoteLabel(_ q: ChatQuote) -> String {
        guard let path = q.path else { return "" }
        if let from = q.from { return "\(path) 第 \(from) 行\n" }
        return "\(path)\n"
    }
}
