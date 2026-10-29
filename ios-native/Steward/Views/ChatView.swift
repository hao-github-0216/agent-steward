// 問管家(點貓咪浮動球打開,跟網頁的浮動球面板一樣):
//   標題「問管家 · 專案」[清除紀錄][關閉] / 對話 / 建議問題 / 引用 / 附件(＋ 檔案、＋ 圖片、目前檔案)/ 輸入框 [送出][開工作卡]
// 跟網頁浮動球是同一份紀錄
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let p = model.current {
                ChatContent(project: p).id(p.id)
            } else {
                ContentUnavailableView("先選一個專案", systemImage: "tray")
            }
        }
        .background(Theme.panel)
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
    @State private var clearArmed = false
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

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if more {
                            Button("載入更早的對話") { Task { await loadOlder() } }
                                .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(4)
                        }
                        if let loadError {
                            Text(loadError).font(.system(size: 13)).foregroundStyle(Theme.bad)
                        }
                        if !loading && items.isEmpty && loadError == nil {
                            Text("問管家這個專案的事:進度、卡在哪、下一步該做什麼。")
                                .font(.system(size: 13)).foregroundStyle(Theme.muted).padding(.top, 30)
                        }
                        ForEach(items) { e in
                            MessageBubble(entry: e, project: project, onUpdate: replace, onRetry: { retry(e) })
                                .id(e.id)
                        }
                        if sending {
                            HStack {
                                Text("管家想一下…").font(.system(size: 14)).foregroundStyle(Theme.muted)
                                    .padding(.horizontal, 10).padding(.vertical, 8)
                                    .background(Theme.chip, in: RoundedRectangle(cornerRadius: 10))
                                Spacer()
                            }
                            .id("thinking")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                .onChange(of: items.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: sending) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            footer
        }
        .task { await load() }
        .task { await consumePending() }
        .onChange(of: model.pendingChat) { _, _ in Task { await consumePending() } }
    }

    // MARK: 標題列

    private var header: some View {
        HStack(spacing: 6) {
            Text("問管家 · \(project.name)").font(.system(size: 15, weight: .bold)).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(clearArmed ? "再按一次清除" : "清除紀錄") { Task { await clear() } }
                .buttonStyle(.small)
                .accessibilityHint("清除這個專案畫面上的問答紀錄(管家記得的專案進度不受影響)")
            Button("關閉") { dismiss() }.buttonStyle(.small)
        }
        .padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    // MARK: 下面:建議問題、引用、附件、輸入框

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !suggestions.isEmpty && draft.isEmpty && !sending {
                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(suggestions.prefix(3), id: \.self) { s in
                            Button { send(s) } label: {
                                Text(s).font(.system(size: 13)).multilineTextAlignment(.leading)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
                                    .foregroundStyle(Theme.ink)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    Button { Task { await regenSuggestions() } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.small)
                        .accessibilityLabel("換一組建議問題")
                }
            }
            if let q = quote {
                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("引用 \(quoteLabel(q))").font(.system(size: 12)).foregroundStyle(Theme.muted)
                        Text(q.text ?? "").font(.system(size: 12, design: .monospaced)).lineLimit(4)
                    }
                    Spacer()
                    Button { quote = nil } label: { Image(systemName: "xmark") }.buttonStyle(.small).accessibilityLabel("拿掉引用")
                }
                .padding(8)
                .background(Theme.chip, in: RoundedRectangle(cornerRadius: 8))
            }
            ctxRow
            if let attachError { Text(attachError).font(.system(size: 12)).foregroundStyle(Theme.bad) }
            HStack(alignment: .bottom, spacing: 6) {
                TextField("問管家這個專案的事…", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .font(.system(size: 15))
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                VStack(spacing: 6) {
                    Button("送出") { send(draft) }
                        .buttonStyle(.smallPrimary)
                        .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && quote == nil) || sending)
                    Button("開工作卡") { startDraft(draft) }
                        .buttonStyle(.small)
                        .disabled(sending)
                        .accessibilityHint("根據目前的對話、加入的檔案和輸入框的話,擬一張工作卡")
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var imageCount: Int { attachments.filter { if case .image = $0.kind { true } else { false } }.count }
    private var fileCount: Int { attachments.count - imageCount }
    private var attachedPaths: Set<String> {
        Set(attachments.compactMap { switch $0.kind { case .projectFile(let r): r; case .editorFile(let r, _): r; default: nil } })
    }

    /// 網頁的 bpCtx:已加的圖片、檔案 📎、「目前檔案:xxx ＋」、＋ 檔案、＋ 圖片
    private var ctxRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { a in
                    HStack(spacing: 4) {
                        if let img = a.preview {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 28, height: 28).clipShape(RoundedRectangle(cornerRadius: 5))
                        } else {
                            Text("📎 \(a.label)").font(.system(size: 12)).lineLimit(1)
                        }
                        Button { attachments.removeAll { $0.id == a.id } } label: { Text("×").font(.system(size: 13, weight: .bold)) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("拿掉 \(a.label)")
                    }
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Theme.chip, in: Capsule())
                }
                if let cf = currentFile, !attachedPaths.contains(cf.path) {
                    Button {
                        if let text = cf.unsaved { attachments.append(Attachment(kind: .editorFile(cf.path, text))) } else { attachments.append(Attachment(kind: .projectFile(cf.path))) }
                    } label: {
                        Text("目前檔案:\((cf.path as NSString).lastPathComponent) ＋").font(.system(size: 12))
                    }
                    .buttonStyle(.small)
                    .accessibilityHint("把正在看的檔案加進來")
                }
                Menu {
                    Button { showProjectFiles = true } label: { Label("專案裡的檔案", systemImage: "folder") }
                    Button { showPhoneFiles = true } label: { Label("iPhone 上的檔案", systemImage: "iphone") }
                } label: { Text("＋ 檔案").font(.system(size: 12)) }
                .buttonStyle(.small)
                .disabled(fileCount >= Attachment.maxFiles)
                Menu {
                    Button { showPhotos = true } label: { Label("照片", systemImage: "photo.on.rectangle") }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: { Label("拍照", systemImage: "camera") }
                    }
                } label: { Text("＋ 圖片").font(.system(size: 12)) }
                .buttonStyle(.small)
                .disabled(imageCount >= Attachment.maxImages)
            }
        }
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
        // 在程式碼模式打開:提供「目前檔案」(含還沒存的修改)
        if model.mode == .code { currentFile = await model.web.currentFile() }
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

    /// 清除紀錄:跟網頁一樣按兩次才清(3 秒內)
    private func clear() async {
        guard clearArmed else {
            clearArmed = true
            try? await Task.sleep(for: .seconds(3))
            clearArmed = false
            return
        }
        clearArmed = false
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
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
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
                Text("工作卡草稿").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                Spacer()
                if draft.status == "draft" {
                    Button(editing ? "完成" : "修改") { editing.toggle() }.buttonStyle(.small)
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
                Text(draft.title).font(.system(size: 15, weight: .bold))
                Text("交給 \(draft.agent)").font(.system(size: 12)).foregroundStyle(Theme.muted)
                Text(draft.instructions).font(.system(size: 14)).lineLimit(6)
                if !draft.doneCriteria.isEmpty {
                    Text("完成標準:\(draft.doneCriteria)").font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(4)
                }
            }
            switch draft.status {
            case "proposed":
                statusLine("已放進提案")
            case "dispatched":
                statusLine("已派工")
            default:
                HStack {
                    Spacer()
                    Button(busy == "propose" ? "放進提案…" : "放進提案") { Task { await act("propose") } }.buttonStyle(.small)
                    Button(busy == "dispatch" ? "直接派工…" : "直接派工") { Task { await act("dispatch") } }.buttonStyle(.smallPrimary)
                }
                .disabled(busy != nil)
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.bad) }
        }
        .padding(10)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
    }

    private func statusLine(_ text: String) -> some View {
        Button {
            if let id = draft.cardId { model.openCardId = id }
        } label: {
            Text(draft.cardId != nil ? "\(text) · 打開工作卡" : text).font(.system(size: 13, weight: .semibold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.accent)
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

/// 一則對話:我的是藍底白字、管家的是淡底(跟網頁 .msg.me / .msg.bot 一樣)
struct MessageBubble: View {
    let entry: ChatEntry
    var project: Project? = nil
    var onUpdate: (ChatEntry) -> Void = { _ in }
    var onRetry: () -> Void = {}

    var body: some View {
        HStack(alignment: .top) {
            if entry.isMine { Spacer(minLength: 40) }
            VStack(alignment: entry.isMine ? .trailing : .leading, spacing: 4) {
                if let thumbs = entry.images, !thumbs.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(thumbs.enumerated()), id: \.offset) { _, t in
                            if let img = imageFromDataURL(t) {
                                Image(uiImage: img).resizable().scaledToFill()
                                    .frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
                if let project, entry.draft != nil {
                    DraftCardView(entry: entry, project: project, onUpdate: onUpdate)
                } else if !entry.text.isEmpty || entry.quote != nil || !(entry.files ?? []).isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        if let q = entry.quote, let t = q.text, !t.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                if let p = q.path { Text("\(entry.via == "圈選" ? "圈選:" : "")\(p)\(q.from.map { " 第 \($0) 行" } ?? "")").font(.system(size: 12)) }
                                Text(t).font(.system(size: 12, design: .monospaced)).lineLimit(5)
                            }
                            .padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                        }
                        if let files = entry.files, !files.isEmpty {
                            ForEach(files, id: \.self) { f in Text("📎 \((f as NSString).lastPathComponent)").font(.system(size: 12)) }
                        }
                        if !entry.text.isEmpty {
                            if entry.isMine { Text(entry.text).textSelection(.enabled) } else { MarkdownText(entry.text) }
                        }
                        if entry.retryable == true {
                            Button("改用備用模型回答這一題", action: onRetry).buttonStyle(.small)
                        }
                    }
                    .font(.system(size: 15))
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .foregroundStyle(entry.isMine ? Color.white : (entry.error == true ? Theme.warn : Theme.ink))
                    .background(entry.isMine ? Theme.accent : Theme.chip, in: RoundedRectangle(cornerRadius: 10))
                }
                if let meta = metaLine {
                    Text(meta).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
            }
            if !entry.isMine { Spacer(minLength: 16) }
        }
    }

    private var metaLine: String? {
        var parts: [String] = []
        if let via = entry.via { parts.append("↪ \(via)") }
        if let alt = entry.alt { parts.append(alt) }
        if let d = Fmt.date(entry.at) { parts.append(Fmt.ago(d)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
