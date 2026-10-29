// 程式碼頁(原生):結構跟網頁的程式碼頁一樣(上面切「檔案|版本控制」),元件用 Apple 的。
//   檔案:系統清單一層層點進資料夾、搜尋、Git 標記;點檔案用原生檢視(程式碼/文字可以編輯存檔、Markdown 預覽、
//         圖片、PDF、Word/Excel/PowerPoint 用 Quick Look、Notebook)
//   版本控制:見 GitViews.swift
// 編譯 LaTeX、執行 Notebook、分割編輯器這些重的功能留在網頁:「在網頁版編輯器打開」
import PDFKit
import QuickLook
import SwiftUI

enum CodeRoute: Hashable {
    case folder(String)
    case file(String)
    case diff(path: String, which: String, commit: String?)
    case history
    case commit(String)
}

struct CodeTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.codePath) {
            VStack(spacing: 0) {
                Group {
                    if let p = model.current {
                        CodeHome(project: p).id(p.id)
                    } else {
                        ContentUnavailableView("還沒有專案", systemImage: "tray")
                    }
                }
                .overlay { BallLayer() }
                if model.drawerOpen {
                    StewardDrawer().transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: model.drawerOpen)
            .modifier(ProjectChrome())
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button(model.drawerOpen ? "收起管家" : "管家") { model.drawerOpen.toggle() }
                    SettingsToolbarButton()
                }
            }
            .navigationDestination(for: CodeRoute.self) { route in
                if let p = model.current {
                    switch route {
                    case .folder(let dir): FolderView(project: p, dir: dir).navigationTitle((dir as NSString).lastPathComponent)
                    case .file(let path): FileView(project: p, path: path)
                    case .diff(let path, let which, let commit): DiffView(project: p, path: path, which: which, commit: commit)
                    case .history: HistoryView(project: p)
                    case .commit(let hash): CommitView(project: p, hash: hash)
                    }
                } else {
                    ContentUnavailableView("還沒有專案", systemImage: "tray")
                }
            }
        }
    }
}

/// 程式碼頁的第一層:檔案 | 版本控制(跟網頁程式碼頁左邊的兩個按鈕一樣)
struct CodeHome: View {
    @Environment(AppModel.self) private var model
    let project: Project

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            Picker("檢視", selection: $model.codeSection) {
                Text("檔案").tag("files")
                Text("版本控制").tag("git")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal).padding(.vertical, 8)
            if model.codeSection == "git" {
                GitView(project: project)
            } else {
                FolderView(project: project, dir: "")
            }
        }
        .background(Color(.systemGroupedBackground))
    }
}

// MARK: - 檔案清單

struct FolderView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let dir: String
    @State private var entries: [FileEntry]?
    @State private var error: String?
    @State private var query = ""
    @State private var results: [String] = []
    @State private var naming: NameAction?
    @State private var newName = ""
    @State private var trashing: FileEntry?

    enum NameAction: Identifiable {
        case newFile, newFolder, rename(FileEntry)
        var id: String {
            switch self {
            case .newFile: "newFile"
            case .newFolder: "newFolder"
            case .rename(let e): "rename-\(e.rel)"
            }
        }
    }

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Section("搜尋結果") {
                    if results.isEmpty { Text("找不到").foregroundStyle(.secondary) }
                    ForEach(results, id: \.self) { rel in
                        NavigationLink(value: CodeRoute.file(rel)) {
                            Label {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text((rel as NSString).lastPathComponent)
                                    Text(rel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            } icon: { Image(systemName: fileIcon(rel)) }
                        }
                    }
                }
            } else {
                ForEach(entries ?? []) { e in
                    row(e)
                        .contextMenu { menu(e) }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { trashing = e } label: { Label("移到垃圾桶", systemImage: "trash") }
                            Button { newName = e.name; naming = .rename(e) } label: { Label("重新命名", systemImage: "pencil") }.tint(.gray)
                        }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if entries == nil && error == nil { ProgressView() } }
        // 只有最上層有搜尋(搜的是整個專案);點進資料夾不再疊一條搜尋列
        .modifier(SearchIfRoot(isRoot: dir.isEmpty, query: $query))
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { results = []; return }
            try? await Task.sleep(for: .milliseconds(250))
            results = (try? await model.api?.findFiles(project: project.id, query: q)) ?? []
        }
        .task { await load() }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { newName = ""; naming = .newFile } label: { Label("新檔案", systemImage: "doc.badge.plus") }
                    Button { newName = ""; naming = .newFolder } label: { Label("新資料夾", systemImage: "folder.badge.plus") }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("新增檔案或資料夾")
            }
        }
        .alert(alertTitle, isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("名稱", text: $newName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("好") { Task { await commitName() } }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("把「\(trashing?.name ?? "")」移到垃圾桶?", isPresented: Binding(get: { trashing != nil }, set: { if !$0 { trashing = nil } }), titleVisibility: .visible) {
            Button("移到垃圾桶", role: .destructive) { if let e = trashing { Task { await op("trash", e.rel) } } }
        } message: {
            Text("會移到電腦的垃圾桶,救得回來。")
        }
    }

    private var alertTitle: String {
        switch naming {
        case .newFile: "新檔案"
        case .newFolder: "新資料夾"
        case .rename: "重新命名"
        case nil: ""
        }
    }

    @ViewBuilder
    private func row(_ e: FileEntry) -> some View {
        let label = HStack(spacing: 10) {
            Image(systemName: e.isDir ? "folder.fill" : fileIcon(e.name))
                .foregroundStyle(e.isDir ? Theme.accent : .secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(e.name).lineLimit(1)
                if !e.isDir, let size = e.size {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            if let g = e.git { GitMark(code: g) }
        }
        .opacity(e.ignored == true ? 0.5 : 1)
        if e.isDir {
            NavigationLink(value: CodeRoute.folder(e.rel)) { label }
        } else {
            NavigationLink(value: CodeRoute.file(e.rel)) { label }
        }
    }

    /// 長按的動作(寫在這個畫面裡,不另外做成會讀環境的 View:長按選單畫在一般畫面樹外面)
    @ViewBuilder
    private func menu(_ e: FileEntry) -> some View {
        if !e.isDir {
            Button { model.pendingChat = .file(e.rel); model.present(.chat) } label: { Label("問管家這個檔案", systemImage: "bubble.left.and.text.bubble.right") }
        }
        Button { newName = e.name; naming = .rename(e) } label: { Label("重新命名", systemImage: "pencil") }
        Button { UIPasteboard.general.string = e.rel } label: { Label("複製路徑", systemImage: "doc.on.doc") }
        Button(role: .destructive) { trashing = e } label: { Label("移到垃圾桶", systemImage: "trash") }
    }

    private func load() async {
        do {
            entries = try await model.api?.tree(project: project.id, dir: dir)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func commitName() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let join = { (n: String) in dir.isEmpty ? n : "\(dir)/\(n)" }
        switch naming {
        case .newFile: await op("mkfile", join(name))
        case .newFolder: await op("mkdir", join(name))
        case .rename(let e):
            let parent = (e.rel as NSString).deletingLastPathComponent
            await op("rename", e.rel, to: parent.isEmpty ? name : "\(parent)/\(name)")
        case nil: break
        }
    }

    private func op(_ op: String, _ path: String, to: String? = nil) async {
        do {
            try await model.api?.fsOp(project: project.id, op: op, path: path, to: to)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SearchIfRoot: ViewModifier {
    let isRoot: Bool
    @Binding var query: String
    func body(content: Content) -> some View {
        if isRoot { content.searchable(text: $query, prompt: "找檔名") } else { content }
    }
}

/// Git 標記(跟網頁的檔案樹一樣:U 新檔、M 修改、A 新增、D 刪除、! 衝突、• 資料夾裡有變更)
struct GitMark: View {
    let code: String
    var body: some View {
        Text(code)
            .font(.caption.monospaced().bold())
            .foregroundStyle(gitColor(code))
            .accessibilityLabel(gitLabel(code))
    }
}

func gitColor(_ code: String) -> Color {
    switch code {
    case "U", "?", "A": .green
    case "M", "R": .orange
    case "D": .red
    case "!": .red
    default: .secondary
    }
}

func gitLabel(_ code: String) -> String {
    switch code {
    case "U", "?": "新檔案"
    case "A": "新增"
    case "M": "修改過"
    case "D": "刪除"
    case "R": "改名"
    case "!": "衝突"
    default: "裡面有變更"
    }
}

/// 依副檔名挑 SF Symbols 圖示
func fileIcon(_ name: String) -> String {
    switch (name as NSString).pathExtension.lowercased() {
    case "swift", "ts", "tsx", "js", "jsx", "mjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "m", "sh", "zsh": "chevron.left.forwardslash.chevron.right"
    case "md", "markdown", "txt", "rtf": "doc.plaintext"
    case "json", "yml", "yaml", "toml", "xml", "plist": "curlybraces"
    case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg": "photo"
    case "pdf": "doc.richtext"
    case "doc", "docx": "doc.text"
    case "xls", "xlsx", "xlsm", "csv": "tablecells"
    case "ppt", "pptx": "rectangle.on.rectangle"
    case "ipynb": "book.pages"
    case "tex", "bib": "function"
    case "html", "css": "globe"
    default: "doc"
    }
}

// MARK: - 打開一個檔案

struct FileView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let path: String
    @State private var file: CodeFile?
    @State private var error: String?
    @State private var data: Data?
    @State private var showPreview = true
    @State private var editing = false
    @State private var draft = ""
    @State private var saving = false
    @State private var conflict: SaveConflict?
    @State private var quickLookURL: URL?
    @State private var saveError: String?
    @State private var quickLookedOnce = false

    private var ext: String { (path as NSString).pathExtension.lowercased() }
    private var isMarkdown: Bool { ["md", "markdown"].contains(ext) }
    private var isNotebook: Bool { ext == "ipynb" }

    var body: some View {
        Group {
            if let error {
                ContentUnavailableView("打不開", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if let file {
                content(file)
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task { await load() }
        .quickLookPreview($quickLookURL)
        .alert("存檔失敗", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("好") {}
        } message: {
            Text(saveError ?? "")
        }
        .alert("檔案在你打開之後被改過了", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })) {
            Button("用我的覆蓋", role: .destructive) { Task { await save(force: true) } }
            Button("放棄我的、載入新版") {
                if let c = conflict { file?.content = c.diskContent; file?.hash = c.diskHash; draft = c.diskContent }
                editing = false
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("可能是 agent 或電腦上的編輯器改的。")
        }
    }

    @ViewBuilder
    private func content(_ f: CodeFile) -> some View {
        switch f.kind {
        case "text":
            if editing {
                TextEditor(text: $draft)
                    .font(.system(.footnote, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 8)
            } else if isNotebook, let d = (f.content ?? "").data(using: .utf8) {
                NotebookView(json: d)
            } else if isMarkdown && showPreview {
                ScrollView { MarkdownText(f.content ?? "").padding() }
            } else {
                CodeText(text: f.content ?? "", truncated: f.truncated.map { "檔案太大,只顯示開頭和結尾各 \($0.shown) 行(共 \($0.total) 行)" })
            }
        case "image":
            if let data, let img = UIImage(data: data) { ZoomableImage(image: img) } else { ProgressView() }
        case "pdf":
            if let data { PDFKitView(data: data).ignoresSafeArea(edges: .bottom) } else { ProgressView() }
        case "office":
            VStack(spacing: 16) {
                Image(systemName: fileIcon(path)).font(.system(size: 56)).foregroundStyle(.secondary)
                Text((path as NSString).lastPathComponent).font(.headline)
                Button("用 Quick Look 預覽") { Task { await openQuickLook() } }.buttonStyle(.borderedProminent)
                Text("要編輯 Word / Excel / PowerPoint,在電腦上用 Office 打開").font(.footnote).foregroundStyle(.secondary)
            }
            .padding()
        case "toolarge":
            ContentUnavailableView("檔案太大", systemImage: "doc.badge.ellipsis", description: Text("超過能預覽的大小。"))
        default:
            ContentUnavailableView("不是文字檔", systemImage: "doc.questionmark", description: Text("這個檔案沒辦法在這裡預覽。"))
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if editing {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { editing = false; draft = file?.content ?? "" }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button { Task { await save(force: false) } } label: {
                    if saving { ProgressView() } else { Text("儲存").bold() }
                }
                .disabled(saving || draft == file?.content)
            }
        } else {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let f = file, f.kind == "text", isMarkdown {
                    Picker("檢視", selection: $showPreview) {
                        Text("預覽").tag(true)
                        Text("原文").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 120)
                }
                if let f = file, f.kind == "text", f.readonly != true, !isNotebook {
                    Button("編輯") { draft = f.content ?? ""; editing = true; showPreview = false }
                }
                Menu {
                    Button { model.pendingChat = .file(path); model.present(.chat) } label: { Label("問管家這個檔案", systemImage: "bubble.left.and.text.bubble.right") }
                    Button { UIPasteboard.general.string = path } label: { Label("複製路徑", systemImage: "doc.on.doc") }
                    Button { model.present(.web(.codeEditor)) } label: { Label("在網頁版編輯器打開", systemImage: "safari") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("更多")
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            let f = try await api.readFile(project: project.id, path: path)
            file = f
            if f.kind == "image" || f.kind == "pdf" { data = try await api.rawFile(project: project.id, path: path) }
            // Office 檔第一次打開時自動用 Quick Look 預覽(只一次;之後用按鈕)
            if f.kind == "office", !quickLookedOnce { quickLookedOnce = true; await openQuickLook() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Office 檔:下載到暫存資料夾,用 iPhone 內建的 Quick Look 預覽
    private func openQuickLook() async {
        guard let api = model.api else { return }
        do {
            let d = try await api.rawFile(project: project.id, path: path)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent((path as NSString).lastPathComponent)
            try d.write(to: url, options: .atomic)
            quickLookURL = url
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(force: Bool) async {
        guard let api = model.api else { return }
        saving = true
        defer { saving = false }
        do {
            let hash = try await api.saveFile(project: project.id, path: path, content: draft, baseHash: file?.hash, force: force)
            file?.content = draft
            file?.hash = hash
            editing = false
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch let c as SaveConflict {
            conflict = c
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            saveError = error.localizedDescription
        }
    }
}

/// 唯讀的程式碼:左邊行號、等寬字、可以左右捲(長行不折)
struct CodeText: View {
    let text: String
    var truncated: String?

    var body: some View {
        let lines = text.components(separatedBy: "\n")
        let width = String(lines.count).count
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                if let truncated {
                    Text(truncated).font(.caption).foregroundStyle(.secondary).padding(.bottom, 8)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(String(i + 1).leftPad(width))
                                .foregroundStyle(.tertiary)
                            Text(line.isEmpty ? " " : line)
                                .textSelection(.enabled)
                        }
                        .font(.system(.footnote, design: .monospaced))
                        .fixedSize(horizontal: true, vertical: false)
                    }
                }
            }
            .padding()
        }
        .background(Color(.systemBackground))
    }
}

extension String {
    func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: " ", count: n - count) + self }
}

struct ZoomableImage: View {
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var last: CGFloat = 1

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: UIScreen.main.bounds.width * scale)
                .padding()
        }
        .gesture(MagnifyGesture().onChanged { v in scale = max(1, min(6, last * v.magnification)) }.onEnded { _ in last = scale })
        .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5; last = scale } }
        .background(Color(.systemBackground))
    }
}

struct PDFKitView: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.document = PDFDocument(data: data)
        return v
    }

    func updateUIView(_ v: PDFView, context: Context) {}
}

/// Notebook(.ipynb):Markdown 格子照排版、程式格子等寬、文字和圖片輸出;要執行用網頁版
struct NotebookView: View {
    let json: Data

    private struct Cell: Identifiable {
        let id: Int
        let type: String
        let source: String
        let outputs: [Output]
    }
    private struct Output: Identifiable {
        let id: Int
        let text: String?
        let image: UIImage?
    }

    private var cells: [Cell] {
        guard let root = try? JSONSerialization.jsonObject(with: json) as? [String: Any], let raw = root["cells"] as? [[String: Any]] else { return [] }
        func str(_ v: Any?) -> String { (v as? [String])?.joined() ?? (v as? String) ?? "" }
        return raw.enumerated().map { i, c in
            let outs = (c["outputs"] as? [[String: Any]] ?? []).enumerated().map { j, o -> Output in
                let data = o["data"] as? [String: Any]
                let png = (data?["image/png"] as? String).flatMap { Data(base64Encoded: $0.replacingOccurrences(of: "\n", with: "")) }.flatMap(UIImage.init(data:))
                let text = str(o["text"]).isEmpty ? str(data?["text/plain"]) : str(o["text"])
                return Output(id: j, text: text.isEmpty ? nil : text, image: png)
            }
            return Cell(id: i, type: c["cell_type"] as? String ?? "code", source: str(c["source"]), outputs: outs)
        }
    }

    var body: some View {
        let list = cells
        if list.isEmpty {
            ContentUnavailableView("讀不出這個 Notebook", systemImage: "book.pages")
        } else {
            List {
                ForEach(list) { c in
                    Section {
                        if c.type == "markdown" {
                            MarkdownText(c.source)
                        } else {
                            Text(c.source.isEmpty ? " " : c.source)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                            ForEach(c.outputs) { o in
                                if let img = o.image { Image(uiImage: img).resizable().scaledToFit() }
                                if let t = o.text {
                                    Text(t).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
                Section {} footer: { Text("要執行 Notebook:右上「⋯」→ 在網頁版編輯器打開。") }
            }
            .listStyle(.insetGrouped)
        }
    }
}
