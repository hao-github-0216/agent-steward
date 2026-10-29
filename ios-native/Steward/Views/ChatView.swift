// 問管家:跟網頁浮動球是同一份對話紀錄(在電腦上問的這裡也看得到)
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

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
    // 附件
    @State private var attachments: [Attachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showProjectFiles = false
    @State private var showPhoneFiles = false
    @State private var attachError: String?
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
            if !attachments.isEmpty || attachError != nil {
                attachmentStrip
            }
            HStack(alignment: .bottom, spacing: 8) {
                attachMenu
                TextField("問管家…", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                Button { send(draft) } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                }
                .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty) || sending)
                .accessibilityLabel("送出")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var imageCount: Int { attachments.filter { if case .image = $0.kind { true } else { false } }.count }
    private var fileCount: Int { attachments.count - imageCount }

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label("照片", systemImage: "photo.on.rectangle") }
                .disabled(imageCount >= Attachment.maxImages)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { showCamera = true } label: { Label("拍照", systemImage: "camera") }
                    .disabled(imageCount >= Attachment.maxImages)
            }
            Button { showProjectFiles = true } label: { Label("專案檔案", systemImage: "folder") }
                .disabled(fileCount >= Attachment.maxFiles)
            Button { showPhoneFiles = true } label: { Label("iPhone 上的檔案", systemImage: "doc") }
                .disabled(fileCount >= Attachment.maxFiles)
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
        }
        .disabled(sending)
        .accessibilityLabel("附加檔案或圖片")
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
            CameraPicker { img in if let a = Attachment.image(img) { attachments.append(a) } }
                .ignoresSafeArea()
        }
        .sheet(isPresented: $showProjectFiles) {
            ProjectFilePicker(project: project, already: Set(attachments.compactMap { if case .projectFile(let r) = $0.kind { r } else { nil } })) { rels in
                let have = Set(attachments.compactMap { if case .projectFile(let r) = $0.kind { r } else { nil } })
                for r in rels where !have.contains(r) && fileCount < Attachment.maxFiles { attachments.append(Attachment(kind: .projectFile(r))) }
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
                                Image(systemName: { if case .phoneFile = a.kind { "iphone" } else { "doc.text" } }())
                                    .foregroundStyle(.secondary)
                                Text(a.label).font(.caption).lineLimit(1).frame(maxWidth: 140)
                            }
                            Button {
                                attachments.removeAll { $0.id == a.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .accessibilityLabel("移除 \(a.label)")
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
                .padding(.horizontal)
            }
            if let attachError {
                Text(attachError).font(.caption).foregroundStyle(.red).padding(.horizontal)
            }
        }
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
        let atts = attachments
        guard !text.isEmpty || !atts.isEmpty, !sending, let api = model.api else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        draft = ""
        attachments = []
        attachError = nil
        sending = true
        // 先把問題放上去(管家那邊回答要一段時間)
        let tempId = "local-\(UUID().uuidString)"
        var mine = ChatEntry(id: tempId, role: "me", text: text)
        mine.files = atts.compactMap { switch $0.kind { case .projectFile(let r): r; case .phoneFile(let n, _): "iPhone/\(n)"; case .image: nil } }
        mine.images = atts.compactMap { if case .image(_, _, let t) = $0.kind { t } else { nil } }
        items.append(mine)
        Task {
            do {
                let r = try await api.ask(project: project.id, message: text, attachments: atts)
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
                if let thumbs = entry.images, !thumbs.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(thumbs.enumerated()), id: \.offset) { _, t in
                            if let img = imageFromDataURL(t) {
                                Image(uiImage: img).resizable().scaledToFill()
                                    .frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 10))
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
                if let project, entry.draft != nil {
                    DraftCardView(entry: entry, project: project, onUpdate: onUpdate)
                } else {
                if !entry.text.isEmpty {
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
