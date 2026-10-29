// 問管家(點貓咪浮動球打開,跟網頁的浮動球面板一樣):
//   標題「問管家 · 專案」[清除紀錄][關閉] / 對話 / 建議問題 / 引用 / 附件(＋ 檔案、＋ 圖片、目前檔案)/ 輸入框 [送出][開工作卡]
// 跟網頁浮動球是同一份紀錄
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Group {
                if let p = model.current {
                    ChatContent(project: p).id(p.id)
                } else {
                    ContentUnavailableView("先選一個專案", systemImage: "tray")
                }
            }
        }
        // 草稿「打開工作卡」:在問管家面板上面再升起一層(不能跟面板同一層)
        .sheet(item: Binding(get: { model.chatCardId.map(CardRef.init) }, set: { model.chatCardId = $0?.id })) { ref in
            CardPopup(cardId: ref.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }
}

private struct ChatContent: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project

    @State private var items: [ChatEntry] = []
    @State private var more = false
    @State private var loading = true
    @State private var loadError: String?
    @State private var suggestions: [String] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var quote: ChatQuote?
    @State private var attachments: [Attachment] = []
    @State private var currentFile: (path: String, unsaved: String?)?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showProjectFiles = false
    @State private var showPhoneFiles = false
    @State private var attachError: String?
    @FocusState private var inputFocused: Bool

    @State private var confirmClear = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    if more {
                        Button("載入更早的對話") { Task { await loadOlder() } }
                            .font(.footnote).padding(.top, 4)
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
                        MessageBubble(entry: e, project: project, onUpdate: replace, onRetry: { retry(e) })
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("問管家").font(.headline)
                    Text(project.name).font(.caption2).foregroundStyle(.secondary)
                }
            }
            ToolbarItem(placement: .cancellationAction) { Button("關閉") { dismiss() } }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("開工作卡") { startDraft(draft) }
                    .disabled(sending)
                    .accessibilityHint("根據目前的對話、加入的檔案和輸入框的話,擬一張工作卡")
                Menu {
                    Button(role: .destructive) { confirmClear = true } label: { Label("清除紀錄", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("更多")
            }
        }
        .confirmationDialog("清除這個專案的問答紀錄?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("清除紀錄", role: .destructive) { Task { await clear() } }
        } message: {
            Text("只清畫面上的問答,管家記得的專案進度不受影響。")
        }
        .task { await load() }
        .task { await consumePending() }
        .onChange(of: model.pendingChat) { _, _ in Task { await consumePending() } }
    }

    // MARK: 下面:建議問題、引用、附件、輸入列(iMessage 式)

    private var inputBar: some View {
        VStack(alignment: .leading, spacing: 8) {
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
                        Button { Task { await regenSuggestions() } } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("換一組建議問題")
                    }
                    .padding(.horizontal)
                }
            }
            if let q = quote {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("引用 \(quoteLabel(q))").font(.caption).foregroundStyle(.secondary)
                        Text(q.text ?? "").font(.caption.monospaced()).lineLimit(3)
                    }
                    Spacer()
                    Button { quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .accessibilityLabel("拿掉引用")
                }
                .padding(10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)
            }
            if !attachments.isEmpty || currentFileSuggestion != nil || attachError != nil {
                attachmentStrip
            }
            HStack(alignment: .bottom, spacing: 8) {
                attachMenu
                TextField("問管家這個專案的事…", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                Button { send(draft) } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && quote == nil) || sending)
                .accessibilityLabel("送出")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var imageCount: Int { attachments.filter { if case .image = $0.kind { true } else { false } }.count }
    private var fileCount: Int { attachments.count - imageCount }
    private var attachedPaths: Set<String> {
        Set(attachments.compactMap { switch $0.kind { case .projectFile(let r): r; case .editorFile(let r, _): r; default: nil } })
    }

    /// 程式碼模式時建議加入「目前檔案」(還沒加的話)
    private var currentFileSuggestion: (path: String, unsaved: String?)? {
        guard let cf = currentFile, !attachedPaths.contains(cf.path) else { return nil }
        return cf
    }

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label("照片", systemImage: "photo.on.rectangle") }
                .disabled(imageCount >= Attachment.maxImages)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: { Label("拍照", systemImage: "camera") }
                    .disabled(imageCount >= Attachment.maxImages)
            }
            Button { showProjectFiles = true } label: { Label("專案裡的檔案", systemImage: "folder") }
                .disabled(fileCount >= Attachment.maxFiles)
            Button { showPhoneFiles = true } label: { Label("iPhone 上的檔案", systemImage: "doc") }
                .disabled(fileCount >= Attachment.maxFiles)
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
        }
        .disabled(sending)
        .accessibilityLabel("加入檔案或圖片")
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: max(1, Attachment.maxImages - imageCount), matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data), let a = Attachment.image(img), imageCount < Attachment.maxImages {
                        attachments.append(a)
                    }
                }
                photoItems = []
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { img in if let a = Attachment.image(img) { attachments.append(a) } }.ignoresSafeArea()
        }
        .sheet(isPresented: $showProjectFiles) {
            ProjectFilePicker(project: project, already: attachedPaths) { rels in
                for r in rels where !attachedPaths.contains(r) && fileCount < Attachment.maxFiles { attachments.append(Attachment(kind: .projectFile(r))) }
            }
        }
        .fileImporter(isPresented: $showPhoneFiles, allowedContentTypes: [.text, .plainText, .sourceCode, .json, .xml, .commaSeparatedText, .data], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                attachError = nil
                for u in urls where fileCount < Attachment.maxFiles {
                    do { attachments.append(try Attachment.phoneFile(u)) } catch { attachError = error.localizedDescription }
                }
            case .failure(let e):
                attachError = e.localizedDescription
            }
        }
    }

    private var attachmentStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { a in
                        HStack(spacing: 6) {
                            if let img = a.preview {
                                Image(uiImage: img).resizable().scaledToFill()
                                    .frame(width: 36, height: 36).clipShape(RoundedRectangle(cornerRadius: 6))
                            } else {
                                Image(systemName: { if case .phoneFile = a.kind { "iphone" } else { "doc.text" } }()).foregroundStyle(.secondary)
                                Text(a.label).font(.caption).lineLimit(1).frame(maxWidth: 140)
                            }
                            Button { attachments.removeAll { $0.id == a.id } } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .accessibilityLabel("拿掉 \(a.label)")
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    }
                    if let cf = currentFileSuggestion {
                        Button {
                            if let text = cf.unsaved { attachments.append(Attachment(kind: .editorFile(cf.path, text))) } else { attachments.append(Attachment(kind: .projectFile(cf.path))) }
                        } label: {
                            Label("目前檔案:\((cf.path as NSString).lastPathComponent)", systemImage: "plus")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityHint("把正在看的檔案加進來")
                    }
                }
                .padding(.horizontal)
            }
            if let attachError { Text(attachError).font(.caption).foregroundStyle(.red).padding(.horizontal) }
        }
    }

    // MARK: 動作

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
        model.chatUnread = false
        // 在程式碼頁打開:正在看的檔案當「目前檔案」
        if model.mode == .code, model.codeShowsFile, let f = model.activeCodeFile { currentFile = f }
        suggestions = (try? await api.suggestions(project: project.id)) ?? []
    }

    private func consumePending() async {
        guard let intent = model.pendingChat else { return }
        model.pendingChat = nil
        switch intent {
        case .quote(let q):
            quote = q
            inputFocused = true
        case .draft(let message):
            startDraft(message)
        case .file(let path):
            if !attachedPaths.contains(path) { attachments.append(Attachment(kind: .projectFile(path))) }
            inputFocused = true
        }
    }

    private func loadOlder() async {
        guard let api = model.api, let first = items.first else { return }
        if let page = try? await api.chat(project: project.id, before: first.id) {
            items.insert(contentsOf: page.items, at: 0)
            more = page.more ?? false
        }
    }

    private func regenSuggestions() async {
        guard let api = model.api else { return }
        suggestions = (try? await api.regenerateSuggestions(project: project.id)) ?? suggestions
    }

    private func replace(_ e: ChatEntry) {
        if let i = items.firstIndex(where: { $0.id == e.id }) { items[i] = e }
    }

    /// 清除紀錄(確認過才清)
    private func clear() async {
        do { try await model.api?.clearChat(project: project.id); items = []; more = false } catch { loadError = error.localizedDescription }
    }

    private func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let atts = attachments, q = quote
        guard !text.isEmpty || !atts.isEmpty || q != nil, !sending, let api = model.api else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        draft = ""
        attachments = []
        quote = nil
        attachError = nil
        sending = true
        model.chatBusy = true
        let tempId = "local-\(UUID().uuidString)"
        var mine = ChatEntry(id: tempId, role: "me", text: text)
        mine.quote = q
        mine.files = atts.compactMap { switch $0.kind { case .projectFile(let r), .editorFile(let r, _): r; case .phoneFile(let n, _): "iPhone/\(n)"; case .image: nil } }
        mine.images = atts.compactMap { if case .image(_, _, let t) = $0.kind { t } else { nil } }
        items.append(mine)
        Task {
            do {
                let r = try await api.ask(project: project.id, message: text, attachments: atts, quote: q)
                if let me = r.me, let i = items.firstIndex(where: { $0.id == tempId }) { items[i] = me }
                if let bot = r.bot { items.append(bot) } else if let answer = r.answer { items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: answer)) }
                UINotificationFeedbackGenerator().notificationOccurred(r.bot?.error == true ? .error : .success)
            } catch {
                items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: error.localizedDescription, error: true))
            }
            sending = false
            model.chatBusy = false
            if !model.showChat { model.chatUnread = true }
            suggestions = (try? await api.suggestions(project: project.id)) ?? suggestions
        }
    }

    /// 主要模型沒回應:改用備用模型回答同一題
    private func retry(_ failed: ChatEntry) {
        guard let api = model.api, !sending, let i = items.firstIndex(where: { $0.id == failed.id }) else { return }
        let question = items[..<i].last(where: \.isMine)?.text ?? ""
        sending = true
        model.chatBusy = true
        Task {
            do {
                let r = try await api.retryWithFallback(project: project.id, message: question)
                if let bot = r.bot { items.append(bot) }
            } catch {
                items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: error.localizedDescription, error: true))
            }
            sending = false
            model.chatBusy = false
        }
    }

    /// 開工作卡:根據目前的對話、加入的檔案和輸入框的話,請管家擬一張草稿
    private func startDraft(_ message: String) {
        guard let api = model.api, !sending else { return }
        var text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        // 有引用一段程式:一起交給管家擬卡
        if let q = quote, let t = q.text, !t.isEmpty {
            text = "依照這段程式碼開工作卡\(text.isEmpty ? "" : "\n要做的事:\(text)")\n出處:\(quoteLabel(q))\n內容:\n```\n\(t.prefix(3000))\n```"
            quote = nil
        }
        let files = attachments.compactMap { switch $0.kind { case .projectFile(let r), .editorFile(let r, _): r; default: nil } }
        draft = ""
        sending = true
        model.chatBusy = true
        let tempId = "local-\(UUID().uuidString)"
        items.append(ChatEntry(id: tempId, role: "me", text: text.isEmpty ? "開工作卡" : "開工作卡:\(text)"))
        Task {
            do {
                let r = try await api.draftCard(project: project.id, message: text, files: files)
                if let me = r.me, let i = items.firstIndex(where: { $0.id == tempId }) { items[i] = me }
                if let bot = r.bot { items.append(bot) }
            } catch {
                items.append(ChatEntry(id: "local-\(UUID().uuidString)", role: "bot", text: error.localizedDescription, error: true))
            }
            sending = false
            model.chatBusy = false
        }
    }

    private func quoteLabel(_ q: ChatQuote) -> String {
        guard let p = q.path else { return "" }
        if let f = q.from { return "\(p) 第 \(f)\(q.to.map { $0 != f ? "–\($0)" : "" } ?? "") 行" }
        return p
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
                Label("工作卡草稿", systemImage: "rectangle.stack.badge.plus").font(.caption.bold()).foregroundStyle(Theme.accent)
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
                statusLine("已放進提案", icon: "tray.and.arrow.down")
            case "dispatched":
                statusLine("已派工", icon: "paperplane.fill")
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
                .controlSize(.small)
                .disabled(busy != nil)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func statusLine(_ text: String, icon: String) -> some View {
        Button {
            if let id = draft.cardId { model.chatCardId = id }
        } label: {
            Label(draft.cardId != nil ? "\(text) · 打開工作卡" : text, systemImage: icon).font(.subheadline.bold())
        }
        .disabled(draft.cardId == nil)
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

/// 一則對話(iMessage 式):我的是藍色泡泡、管家的是灰色泡泡
struct MessageBubble: View {
    let entry: ChatEntry
    var project: Project? = nil
    var onUpdate: (ChatEntry) -> Void = { _ in }
    var onRetry: () -> Void = {}

    var body: some View {
        HStack(alignment: .top) {
            if entry.isMine { Spacer(minLength: 48) }
            VStack(alignment: entry.isMine ? .trailing : .leading, spacing: 4) {
                if let thumbs = entry.images, !thumbs.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(thumbs.enumerated()), id: \.offset) { _, t in
                            if let img = imageFromDataURL(t) {
                                Image(uiImage: img).resizable().scaledToFill()
                                    .frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 12))
                            }
                        }
                    }
                }
                if let files = entry.files, !files.isEmpty {
                    VStack(alignment: entry.isMine ? .trailing : .leading, spacing: 2) {
                        ForEach(files, id: \.self) { f in
                            Label((f as NSString).lastPathComponent, systemImage: f.hasPrefix("iPhone/") ? "iphone" : "doc.text")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if let q = entry.quote, let t = q.text, !t.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        if let p = q.path { Text("\(entry.via == "圈選" ? "圈選:" : "")\(p)\(q.from.map { " 第 \($0) 行" } ?? "")").font(.caption.bold()) }
                        Text(t).font(.caption.monospaced()).lineLimit(5)
                    }
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .background(Color(.tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                }
                if let project, entry.draft != nil {
                    DraftCardView(entry: entry, project: project, onUpdate: onUpdate)
                } else if !entry.text.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        if entry.isMine { Text(entry.text).textSelection(.enabled) } else { MarkdownText(entry.text) }
                        if entry.retryable == true {
                            Button("改用備用模型回答這一題", action: onRetry)
                                .buttonStyle(.bordered).controlSize(.small)
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
        if entry.isMine { return Theme.accent }
        return entry.error == true ? Color.red.opacity(0.1) : Color(.secondarySystemBackground)
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let via = entry.via { parts.append("↪ \(via)") }
        if let alt = entry.alt { parts.append(alt) }
        if let d = Fmt.date(entry.at) { parts.append(Fmt.ago(d)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
