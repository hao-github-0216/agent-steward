import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class MarkdownEditorController: ObservableObject {
    fileprivate weak var editor: MarkdownTextView?
    @Published private(set) var uploading = false
    @Published private(set) var uploadProgress = 0.0
    @Published private(set) var uploadStatus = ""
    fileprivate var pasteImages: (([MarkdownImage]) -> Void)?
    private var imageAnchor: NSRange?
    private weak var uploadEditor: MarkdownTextView?

    var text: String { editor?.text ?? "" }
    var selection: NSRange { editor?.selectedRange ?? NSRange(location: 0, length: 0) }

    func apply(_ transform: (String, NSRange) -> (text: String, selection: NSRange)) {
        guard let editor else { return }
        let result = transform(editor.text, editor.selectedRange)
        editor.apply(text: result.text, selection: result.selection)
        editor.becomeFirstResponder()
    }

    func insert(_ text: String, selection: NSRange? = nil) {
        apply { source, range in
            let result = (source as NSString).replacingCharacters(in: range, with: text)
            let local = selection ?? NSRange(location: (text as NSString).length, length: 0)
            return (result, NSRange(location: range.location + local.location, length: local.length))
        }
    }

    func wrap(_ marker: String) {
        apply { MarkdownTools.toggleWrap(text: $0, range: $1, marker: marker) }
    }

    func prefix(_ prefix: String) {
        apply { MarkdownTools.toggleLinePrefix(text: $0, range: $1, prefix: prefix) }
    }

    func insertLink() {
        let selected = (text as NSString).substring(with: selection)
        let label = selected.isEmpty ? String(localized: "連結文字", bundle: AppLanguage.bundle) : selected
        let url = String(localized: "網址", bundle: AppLanguage.bundle)
        insert("[\(label)](\(url))", selection: NSRange(location: (label as NSString).length + 3, length: (url as NSString).length))
    }

    func insertFence() {
        let selected = (text as NSString).substring(with: selection)
        let longest = selected.split(omittingEmptySubsequences: false, whereSeparator: { $0 != "`" }).map(\.count).max() ?? 0
        let ticks = String(repeating: "`", count: max(3, longest + 1))
        let source = text as NSString
        let newLine = selection.location > 0 && source.character(at: selection.location - 1) != 10 ? "\n" : ""
        let before = newLine + ticks + "\n"
        insert(before + selected + "\n" + ticks + "\n", selection: NSRange(location: (before as NSString).length, length: (selected as NSString).length))
    }

    func insertDisplayMath() {
        let selected = (text as NSString).substring(with: selection)
        insert("\n$$\n" + selected + "\n$$\n", selection: NSRange(location: 4, length: (selected as NSString).length))
    }

    func insertMath(_ key: String) {
        guard let snippet = MarkdownTools.mathTemplates[key] else { return }
        var expanded = MarkdownTools.expandSnippet(snippet)
        if !MarkdownMathContext.contains(text, offset: selection.location) {
            expanded.text = "$" + expanded.text + "$"
            expanded.selection.location += 1
            if !snippet.contains("${") { expanded.selection.location = (expanded.text as NSString).length }
        }
        insert(expanded.text, selection: expanded.selection)
    }

    func insertDiagram(_ key: String) {
        guard let snippet = MarkdownTools.mermaidTemplates[key] else { return }
        insert("\n```mermaid\n" + snippet + "\n```\n")
    }

    fileprivate func trackEdit(range: NSRange, replacementLength: Int) {
        guard let anchor = imageAnchor else { return }
        let delta = replacementLength - range.length
        if NSMaxRange(range) <= anchor.location {
            imageAnchor = NSRange(location: max(0, anchor.location + delta), length: anchor.length)
        } else if range.location < NSMaxRange(anchor) {
            let start = min(anchor.location, range.location)
            let end = max(range.location + replacementLength, NSMaxRange(anchor) + delta)
            imageAnchor = NSRange(location: start, length: max(0, end - start))
        }
    }

    fileprivate func beginUpload() -> Bool {
        guard !uploading, let editor else { return false }
        uploading = true
        uploadProgress = 0
        uploadStatus = String(localized: "圖片上傳中…", bundle: AppLanguage.bundle)
        uploadEditor = editor
        imageAnchor = editor.selectedRange
        return true
    }

    fileprivate func setProgress(_ value: Double) { uploadProgress = value }

    fileprivate func insertImage(_ text: String) {
        guard let editor, editor === uploadEditor, let imageAnchor else { return }
        let source = editor.text as NSString
        guard NSMaxRange(imageAnchor) <= source.length else { return }
        let end = imageAnchor.location + (text as NSString).length
        editor.apply(text: source.replacingCharacters(in: imageAnchor, with: text), selection: NSRange(location: end, length: 0))
        self.imageAnchor = NSRange(location: end, length: 0)
    }

    fileprivate func finishUpload(success: Bool) {
        uploading = false
        uploadProgress = success ? 1 : 0
        uploadStatus = success ? String(localized: "圖片上傳完成", bundle: AppLanguage.bundle) : String(localized: "圖片上傳失敗", bundle: AppLanguage.bundle)
        imageAnchor = nil
        uploadEditor = nil
    }
}

@MainActor
final class MarkdownTextView: UITextView {
    fileprivate weak var markdownController: MarkdownEditorController?
    fileprivate var onFindingChange: ((Bool) -> Void)?
    fileprivate var onTextChange: (() -> Void)?
    fileprivate var wantsFindNavigator = false
    private var didSelectTestRange = false

    override var keyCommands: [UIKeyCommand]? {
        let commands = [
            UIKeyCommand(input: "b", modifierFlags: .command, action: #selector(markdownBold)),
            UIKeyCommand(input: "i", modifierFlags: .command, action: #selector(markdownItalic)),
            UIKeyCommand(input: "k", modifierFlags: .command, action: #selector(markdownLink))
        ]
        commands.forEach { $0.wantsPriorityOverSystemBehavior = true }
        return commands + (super.keyCommands ?? [])
    }

    @objc private func markdownBold() { markdownController?.wrap("**") }
    @objc private func markdownItalic() { markdownController?.wrap("*") }
    @objc private func markdownLink() { markdownController?.insertLink() }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        guard !board.hasStrings, board.hasImages, let paste = markdownController?.pasteImages else {
            super.paste(sender)
            return
        }
        let images = board.items.compactMap { item -> MarkdownImage? in
            for (type, value) in item where UTType(type)?.conforms(to: .image) == true {
                if let data = value as? Data {
                    let png = UTType(type)?.conforms(to: .png) == true ? data : UIImage(data: data)?.pngData()
                    if let png { return MarkdownImage(data: png, name: "paste.png", type: .png) }
                }
                if let image = value as? UIImage, let data = image.pngData() { return MarkdownImage(data: data, name: "paste.png", type: .png) }
            }
            return nil
        }
        if images.isEmpty, let image = board.image, let data = image.pngData() {
            paste([MarkdownImage(data: data, name: "paste.png", type: .png)])
        } else if !images.isEmpty {
            paste(images)
        } else {
            super.paste(sender)
        }
    }

    override func findInteraction(_ interaction: UIFindInteraction, didBegin session: UIFindSession) {
        super.findInteraction(interaction, didBegin: session)
        onFindingChange?(true)
    }

    override func findInteraction(_ interaction: UIFindInteraction, didEnd session: UIFindSession) {
        super.findInteraction(interaction, didEnd: session)
        onFindingChange?(false)
    }

    // 工具列的修改與選取範圍一起加入復原紀錄。
    fileprivate func apply(text newText: String, selection: NSRange) {
        let before = text ?? ""
        let oldSelection = selectedRange
        if before != newText {
            undoManager?.registerUndo(withTarget: self) { target in target.apply(text: before, selection: oldSelection) }
            textStorage.replaceCharacters(in: NSRange(location: 0, length: textStorage.length), with: newText)
        }
        selectedRange = Self.clamped(selection, length: (newText as NSString).length)
        scrollRangeToVisible(selectedRange)
        onTextChange?()
    }

    fileprivate static func changedRange(before: String, after: String) -> (range: NSRange, length: Int) {
        let old = Array(before.utf16), new = Array(after.utf16)
        var start = 0, oldEnd = old.count, newEnd = new.count
        while start < oldEnd && start < newEnd && old[start] == new[start] { start += 1 }
        while oldEnd > start && newEnd > start && old[oldEnd - 1] == new[newEnd - 1] { oldEnd -= 1; newEnd -= 1 }
        return (NSRange(location: start, length: oldEnd - start), newEnd - start)
    }

    fileprivate static func clamped(_ range: NSRange, length: Int) -> NSRange {
        let start = min(max(0, range.location), length)
        return NSRange(location: start, length: min(max(0, range.length), length - start))
    }

    fileprivate func synchronizeFinding() {
        guard window != nil, let interaction = findInteraction, interaction.isFindNavigatorVisible != wantsFindNavigator else { return }
        if wantsFindNavigator { interaction.presentFindNavigator(showingReplace: false) }
        else { interaction.dismissFindNavigator() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        synchronizeFinding()
        #if DEBUG
        guard window != nil, !didSelectTestRange else { return }
        didSelectTestRange = true
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-mdTestSelect"), arguments.indices.contains(index + 1) else { return }
        let values = arguments[index + 1].split(separator: ",").compactMap { Int($0) }
        guard values.count == 2 else { return }
        selectedRange = Self.clamped(NSRange(location: max(0, values[0]), length: max(0, values[1])), length: (text as NSString).length)
        becomeFirstResponder()
        #endif
    }
}

struct MarkdownEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var finding: Bool
    let controller: MarkdownEditorController

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MarkdownTextView {
        let view = MarkdownTextView()
        view.font = .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.autocorrectionType = .no
        view.autocapitalizationType = .none
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        view.alwaysBounceVertical = true
        view.isFindInteractionEnabled = true
        view.wantsFindNavigator = finding
        view.accessibilityIdentifier = "markdown-editor"
        view.text = text
        view.delegate = context.coordinator
        view.markdownController = controller
        controller.editor = view
        view.onTextChange = { [weak view, weak coordinator = context.coordinator] in
            guard let view else { return }
            coordinator?.textViewDidChange(view)
        }
        view.onFindingChange = { [weak coordinator = context.coordinator] visible in
            DispatchQueue.main.async { coordinator?.parent.finding = visible }
        }
        return view
    }

    func updateUIView(_ view: MarkdownTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            let selection = view.selectedRange
            let change = MarkdownTextView.changedRange(before: view.text, after: text)
            controller.trackEdit(range: change.range, replacementLength: change.length)
            view.text = text
            context.coordinator.previousText = text
            view.undoManager?.removeAllActions()
            view.selectedRange = MarkdownTextView.clamped(selection, length: (text as NSString).length)
        }
        view.wantsFindNavigator = finding
        view.synchronizeFinding()
    }

    static func dismantleUIView(_ view: MarkdownTextView, coordinator: Coordinator) {
        if coordinator.parent.controller.editor === view { coordinator.parent.controller.editor = nil }
        view.onTextChange = nil
        view.onFindingChange = nil
        view.delegate = nil
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MarkdownEditor
        var previousText: String
        init(_ parent: MarkdownEditor) {
            self.parent = parent
            previousText = parent.text
        }
        func textViewDidChange(_ textView: UITextView) {
            let text = textView.text ?? ""
            let change = MarkdownTextView.changedRange(before: previousText, after: text)
            parent.controller.trackEdit(range: change.range, replacementLength: change.length)
            previousText = text
            parent.text = text
        }
    }
}

struct MarkdownToolbar: View {
    @Environment(AppModel.self) private var model
    @ObservedObject var controller: MarkdownEditorController
    let project: String
    let path: String
    let onError: (String) -> Void
    @State private var showingTable = false
    @State private var columns = "3"
    @State private var rows = "3"
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var importingImage = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    tool("bold", String(localized: "粗體", bundle: AppLanguage.bundle), "bold") { controller.wrap("**") }
                    tool("italic", String(localized: "斜體", bundle: AppLanguage.bundle), "italic") { controller.wrap("*") }
                    tool("strike", String(localized: "刪除線", bundle: AppLanguage.bundle), "strikethrough") { controller.wrap("~~") }
                    tool("inline", String(localized: "行內程式碼", bundle: AppLanguage.bundle), "chevron.left.forwardslash.chevron.right") { controller.wrap("`") }
                    Menu {
                        ForEach(1...3, id: \.self) { level in
                            let label = String(localized: "標題 \(level)", bundle: AppLanguage.bundle)
                            Button(label) { controller.prefix(String(repeating: "#", count: level) + " ") }
                                .accessibilityLabel(label).accessibilityIdentifier("md-tool-heading-\(level)")
                        }
                    } label: { Image(systemName: "number") }
                    .accessibilityLabel(String(localized: "標題", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-heading")
                    tool("bullet", String(localized: "項目清單", bundle: AppLanguage.bundle), "list.bullet") { controller.prefix("- ") }
                    tool("number", String(localized: "編號清單", bundle: AppLanguage.bundle), "list.number") { controller.prefix("1. ") }
                    tool("check", String(localized: "核取清單", bundle: AppLanguage.bundle), "checklist") { controller.prefix("- [ ] ") }
                    tool("quote", String(localized: "引用", bundle: AppLanguage.bundle), "text.quote") { controller.prefix("> ") }
                    tool("fence", String(localized: "程式碼區塊", bundle: AppLanguage.bundle), "curlybraces") { controller.insertFence() }
                    tool("link", String(localized: "連結", bundle: AppLanguage.bundle), "link") { controller.insertLink() }
                    mathMenu
                    diagramMenu
                    tool("table", String(localized: "表格", bundle: AppLanguage.bundle), "tablecells") { columns = "3"; rows = "3"; showingTable = true }
                    Menu {
                        menuButton("image-photos", String(localized: "從照片上傳…", bundle: AppLanguage.bundle)) { pickingPhotos = true }
                        menuButton("image-files", String(localized: "從「檔案」上傳…", bundle: AppLanguage.bundle)) { importingImage = true }
                    } label: { Image(systemName: "photo") }
                    .disabled(controller.uploading)
                    .accessibilityLabel(String(localized: "插入圖片", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-image")
                }
                .buttonStyle(.borderless)
                .controlSize(.regular)
                .font(.body)
                .padding(.horizontal, 8).padding(.vertical, 10)
            }
            if controller.uploading {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: controller.uploadStatus).font(.caption)
                    ProgressView(value: controller.uploadProgress)
                }
                .padding(.horizontal, 12).padding(.bottom, 6)
            }
        }
        .background(.bar)
        .accessibilityIdentifier("markdown-toolbar")
        .alert(String(localized: "插入表格", bundle: AppLanguage.bundle), isPresented: $showingTable) {
            TextField(String(localized: "欄數", bundle: AppLanguage.bundle), text: $columns)
                .keyboardType(.numberPad).accessibilityLabel(String(localized: "欄數", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-table-cols")
            TextField(String(localized: "列數（含標題）", bundle: AppLanguage.bundle), text: $rows)
                .keyboardType(.numberPad).accessibilityLabel(String(localized: "列數（含標題）", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-table-rows")
            Button(String(localized: "插入", bundle: AppLanguage.bundle)) {
                controller.insert("\n" + MarkdownTools.makeTable(cols: min(10, max(1, Int(columns) ?? 3)), rows: min(30, max(1, Int(rows) ?? 3))) + "\n")
            }
            .accessibilityLabel(String(localized: "插入", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-table-insert")
            Button(String(localized: "取消", bundle: AppLanguage.bundle), role: .cancel) {}
                .accessibilityLabel(String(localized: "取消", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-table-cancel")
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, matching: .images, preferredItemEncoding: .current)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await uploadPhotos(items) }
        }
        .fileImporter(isPresented: $importingImage, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await uploadFiles(urls) }
            case .failure(let error): onError(error.localizedDescription)
            }
        }
        .onAppear {
            controller.pasteImages = { images in Task { await upload(images) } }
        }
        .onDisappear { controller.pasteImages = nil }
    }

    private func tool(_ id: String, _ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(minWidth: 32, minHeight: 28) }
            .accessibilityLabel(title).accessibilityIdentifier("md-tool-" + id)
    }

    private func menuButton(_ id: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .accessibilityLabel(title).accessibilityIdentifier("md-tool-" + id)
    }

    private var mathMenu: some View {
        Menu {
            menuButton("math-inline", String(localized: "行內公式", bundle: AppLanguage.bundle)) { controller.wrap("$") }
            menuButton("math-display", String(localized: "獨立公式", bundle: AppLanguage.bundle)) { controller.insertDisplayMath() }
            ForEach(Self.mathLabels, id: \.0) { key, label in
                menuButton("math-" + key, label) { controller.insertMath(key) }
            }
        } label: { Image(systemName: "sum") }
        .accessibilityLabel(String(localized: "數學公式", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-math")
    }

    private var diagramMenu: some View {
        Menu {
            ForEach(Self.diagramLabels, id: \.0) { key, label in
                Button(label) { controller.insertDiagram(key) }
                    .accessibilityLabel(label).accessibilityIdentifier("md-tool-mermaid-" + key)
            }
        } label: { Image(systemName: "flowchart") }
        .accessibilityLabel(String(localized: "圖表", bundle: AppLanguage.bundle)).accessibilityIdentifier("md-tool-mermaid")
    }

    private static let mathLabels = [
        ("fraction", String(localized: "分數", bundle: AppLanguage.bundle)), ("sqrt", String(localized: "平方根", bundle: AppLanguage.bundle)), ("power", String(localized: "上標", bundle: AppLanguage.bundle)), ("subscript", String(localized: "下標", bundle: AppLanguage.bundle)), ("sum", String(localized: "加總", bundle: AppLanguage.bundle)),
        ("integral", String(localized: "積分", bundle: AppLanguage.bundle)), ("limit", String(localized: "極限", bundle: AppLanguage.bundle)), ("matrix", String(localized: "矩陣", bundle: AppLanguage.bundle)), ("aligned", String(localized: "多行對齊", bundle: AppLanguage.bundle)),
        ("alpha", "α"), ("beta", "β"), ("gamma", "γ"), ("delta", "δ"), ("epsilon", "ε"), ("theta", "θ"),
        ("lambda", "λ"), ("mu", "μ"), ("pi", "π"), ("sigma", "σ"), ("phi", "φ"), ("omega", "ω")
    ]
    private static let diagramLabels = [("flowchart", String(localized: "流程圖", bundle: AppLanguage.bundle)), ("sequence", String(localized: "循序圖", bundle: AppLanguage.bundle)), ("gantt", String(localized: "甘特圖", bundle: AppLanguage.bundle)), ("pie", String(localized: "圓餅圖", bundle: AppLanguage.bundle)), ("class", String(localized: "類別圖", bundle: AppLanguage.bundle))]

    private func uploadPhotos(_ items: [PhotosPickerItem]) async {
        guard startUpload() else { return }
        do {
            var images: [MarkdownImage] = []
            for item in items {
                guard let picked = try await item.loadTransferable(type: PickedFile.self) else { throw MarkdownImageError.invalid }
                defer { try? FileManager.default.removeItem(at: picked.url.deletingLastPathComponent()) }
                images.append(try MarkdownImage.read(picked.url))
            }
            try await uploadPrepared(images)
            controller.finishUpload(success: true)
        } catch { uploadFailed(error) }
    }

    private func uploadFiles(_ urls: [URL]) async {
        guard !urls.isEmpty, startUpload() else { return }
        do {
            var images: [MarkdownImage] = []
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let staged = try await Task.detached { try UploadCenter.stage(url) }.value
                defer { try? FileManager.default.removeItem(at: staged.deletingLastPathComponent()) }
                images.append(try MarkdownImage.read(staged))
            }
            try await uploadPrepared(images)
            controller.finishUpload(success: true)
        } catch { uploadFailed(error) }
    }

    private func upload(_ images: [MarkdownImage]) async {
        guard !images.isEmpty, startUpload() else { return }
        do {
            try await uploadPrepared(images)
            controller.finishUpload(success: true)
        } catch { uploadFailed(error) }
    }

    private func startUpload() -> Bool {
        guard !controller.uploading else {
            onError(String(localized: "還有檔案在上傳,等它傳完", bundle: AppLanguage.bundle))
            return false
        }
        guard model.api != nil else { onError(String(localized: "圖片上傳失敗", bundle: AppLanguage.bundle)); return false }
        return controller.beginUpload()
    }

    private func uploadFailed(_ error: Error) {
        controller.finishUpload(success: false)
        onError(error.localizedDescription)
    }

    private func uploadPrepared(_ images: [MarkdownImage]) async throws {
        guard let api = model.api else { throw MarkdownImageError.invalid }
        let parent = (path as NSString).deletingLastPathComponent
        let base = parent.isEmpty ? "images/" : parent + "/images/"
        for (index, image) in images.enumerated() {
            try Task.checkCancellation()
            let prepared = try image.prepared()
            guard prepared.data.count <= UploadCenter.limit else { throw MarkdownImageError.tooLarge }
            let dir = try UploadCenter.tempDir()
            defer { try? FileManager.default.removeItem(at: dir) }
            let local = dir.appendingPathComponent(prepared.name)
            try prepared.data.write(to: local)
            let safe = MarkdownTools.safeImageName(prepared.name)
            var attempt = 1
            while true {
                try Task.checkCancellation()
                let filename = MarkdownTools.imageName(safe, attempt: attempt)
                let result = try await api.upload(project: project, path: base + filename, file: local, overwrite: false) { fraction in
                    Task { @MainActor in controller.setProgress((Double(index) + fraction) / Double(images.count)) }
                }
                if case .ok = result {
                    let alt = image.altText
                    controller.insertImage("![\(alt)](images/\(filename))\n")
                    break
                }
                attempt += 1
            }
        }
    }
}

fileprivate enum MarkdownImageError: LocalizedError {
    case invalid, tooLarge
    var errorDescription: String? {
        switch self {
        case .invalid: String(localized: "圖片上傳失敗", bundle: AppLanguage.bundle)
        case .tooLarge: String(localized: "檔案超過 500 MB", bundle: AppLanguage.bundle)
        }
    }
}

@MainActor
fileprivate struct MarkdownImage {
    let data: Data
    let name: String
    let type: UTType?

    static func read(_ url: URL) throws -> MarkdownImage {
        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        guard (values.fileSize ?? 0) <= UploadCenter.limit else { throw MarkdownImageError.tooLarge }
        return MarkdownImage(data: try Data(contentsOf: url), name: url.lastPathComponent, type: values.contentType)
    }

    func prepared() throws -> (data: Data, name: String) {
        guard data.count <= UploadCenter.limit else { throw MarkdownImageError.tooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let identifier = CGImageSourceGetType(source),
              let detected = UTType(identifier as String), detected.conforms(to: .image) else { throw MarkdownImageError.invalid }
        let ext = (name as NSString).pathExtension.lowercased()
        if detected.conforms(to: .heic) || detected.conforms(to: .heif) || ["heic", "heif"].contains(ext) {
            guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.85) else { throw MarkdownImageError.invalid }
            return (jpeg, (name as NSString).deletingPathExtension + ".jpg")
        }
        let suffix = detected.preferredFilenameExtension ?? type?.preferredFilenameExtension ?? "png"
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        return (data, stem + "." + suffix)
    }

    var altText: String {
        let stem = (name as NSString).deletingPathExtension
        return stem.map { char in
            if char == "\r" || char == "\n" { return " " }
            return "\\[]<>`*_".contains(char) ? "\\" + String(char) : String(char)
        }.joined()
    }
}

// 判斷游標是否在公式內，略過程式碼與跳脫的分隔符號。
private enum MarkdownMathContext {
    static func contains(_ text: String, offset: Int) -> Bool {
        let source = text as NSString
        let length = source.length
        let code = codeRanges(source)
        func isCode(_ at: Int) -> Bool { code.contains { NSLocationInRange(at, $0) } }
        func escaped(_ at: Int) -> Bool {
            var index = at, count = 0
            while index > 0 && source.character(at: index - 1) == 92 { count += 1; index -= 1 }
            return count % 2 == 1
        }
        func has(_ token: String, at: Int) -> Bool {
            let size = (token as NSString).length
            return at + size <= length && source.substring(with: NSRange(location: at, length: size)) == token
        }
        func whitespace(_ at: Int) -> Bool {
            at < length && (CharacterSet.whitespacesAndNewlines as NSCharacterSet).characterIsMember(source.character(at: at))
        }
        var index = 0
        while index < length {
            if isCode(index) || escaped(index) { index += 1; continue }
            let left: String
            if has("$$", at: index) { left = "$$" }
            else if has("\\[", at: index) { left = "\\[" }
            else if has("\\(", at: index) { left = "\\(" }
            else if has("$", at: index) { left = "$" }
            else { index += 1; continue }
            let right = left == "\\[" ? "\\]" : left == "\\(" ? "\\)" : left
            let from = index + (left as NSString).length
            let inline = left == "$"
            if inline && (from == length || whitespace(from)) { index += 1; continue }
            var end = from
            var closing: Int?
            while end < length {
                if inline && source.character(at: end) == 10 { break }
                if has(right, at: end), !escaped(end), !code.contains(where: { $0.location < end + (right as NSString).length && NSMaxRange($0) > from }) {
                    let next = end + (right as NSString).length
                    let nextIsDigit = next < length && (48...57).contains(source.character(at: next))
                    if !inline || (end > from && !whitespace(end - 1) && !nextIsDigit) { closing = next; break }
                }
                end += 1
            }
            if let closing {
                if offset > index && offset < closing { return true }
                index = closing
            } else {
                let remainder = source.substring(from: from)
                let startsWithDigit = from < length && (48...57).contains(source.character(at: from))
                if (!inline || (!remainder.contains("\n") && !startsWithDigit)), offset > index && offset <= length { return true }
                index += 1
            }
        }
        return false
    }

    private static func codeRanges(_ source: NSString) -> [NSRange] {
        var ranges: [NSRange] = []
        let full = NSRange(location: 0, length: source.length)
        let fences = try! NSRegularExpression(pattern: "(?m)^ {0,3}(`{3,}|~{3,})[^\\n]*(?:\\n|$)")
        var end = 0
        for match in fences.matches(in: source as String, range: full) where match.range.location >= end {
            let marker = source.substring(with: match.range(at: 1))
            let closing = try! NSRegularExpression(pattern: "(?m)^ {0,3}" + NSRegularExpression.escapedPattern(for: String(marker.prefix(1))) + "{\(marker.count),}[ \\t]*(?:\\n|$)")
            let from = NSMaxRange(match.range)
            end = closing.firstMatch(in: source as String, range: NSRange(location: from, length: source.length - from)).map { NSMaxRange($0.range) } ?? source.length
            ranges.append(NSRange(location: match.range.location, length: end - match.range.location))
        }
        let ticks = try! NSRegularExpression(pattern: "`+")
        end = 0
        for match in ticks.matches(in: source as String, range: full) where match.range.location >= end {
            if ranges.contains(where: { NSLocationInRange(match.range.location, $0) }) { continue }
            let from = NSMaxRange(match.range)
            let closing = try! NSRegularExpression(pattern: "(?<!`)`{\(match.range.length)}(?!`)")
            if let found = closing.firstMatch(in: source as String, range: NSRange(location: from, length: source.length - from)),
               !ranges.contains(where: { NSLocationInRange(found.range.location, $0) }) {
                end = NSMaxRange(found.range)
                ranges.append(NSRange(location: match.range.location, length: end - match.range.location))
            }
        }
        return ranges
    }
}
