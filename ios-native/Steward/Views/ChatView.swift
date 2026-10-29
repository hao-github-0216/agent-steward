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
                        MessageBubble(entry: e).id(e.id)
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
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("問管家").font(.headline)
                    Text(project.name).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .task { await load() }
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

struct MessageBubble: View {
    let entry: ChatEntry

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
