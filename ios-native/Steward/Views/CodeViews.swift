// 程式碼頁(原生):結構跟網頁的程式碼頁一樣(上面切「檔案|版本控制」),元件用 Apple 的。
//   檔案:系統清單一層層點進資料夾、搜尋、Git 標記;點檔案用原生檢視(程式碼/文字可以編輯存檔、Markdown 預覽、
//         圖片、PDF、Word/Excel/PowerPoint 用 Quick Look、Notebook)
//   版本控制:見 GitViews.swift
// 編譯 LaTeX、執行 Notebook、分割編輯器這些重的功能留在網頁:「在網頁版編輯器打開」
import PDFKit
import PhotosUI
import QuickLook
import SwiftUI

enum CodeRoute: Hashable {
    case folder(String)
    /// iPhone 和窄視窗:單格的編輯畫面(上方分頁列)
    case editor
    case history
    case commit(String)
}

struct CodeTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Group {
            // iPad(寬畫面):左側欄 + 右邊分割編輯區;iPhone 和窄視窗:清單 → 單格編輯畫面(上方分頁列)
            if sizeClass == .regular { RegularCodeLayout() } else { CompactCodeLayout() }
        }
        // 寬畫面:編輯區一直看得到,不用推進編輯畫面(窄 → 寬、或開 app 時已經推進去的都拿掉)
        .onChange(of: sizeClass, initial: true) { _, c in if c == .regular { model.codePath.removeAll { $0 == .editor } } }
        // 上傳進度(在浮動球下面一層,球不會被蓋住)
        .overlay(alignment: .bottom) { UploadStatusBar().padding(.bottom, 8).animation(.snappy, value: model.uploads.running) }
        // 浮動球和圈選鈕掛在整個程式碼分頁上:點進檔案、差異、提交紀錄也都在
        .overlay { if !model.isReaderFullScreen { BallLayer().padding(.top, 50) } }
        .modifier(UploadConflictDialog())
        // 管家側欄掛在最外層:iPad 是右邊獨立一欄(有自己的標題列),iPhone 是從底下升起的視窗
        .modifier(DrawerInspector(mode: .code))
    }
}

/// 程式碼頁共用的導覽目的地(資料夾、提交紀錄;iPhone 還有編輯畫面)
struct CodeDestination: View {
    @Environment(AppModel.self) private var model
    let route: CodeRoute

    var body: some View {
        if let p = model.current {
            switch route {
            case .folder(let dir): FolderView(project: p, dir: dir).navigationTitle((dir as NSString).lastPathComponent)
            case .editor: CompactEditor(project: p)
            case .history: HistoryView(project: p)
            case .commit(let hash): CommitView(project: p, hash: hash)
            }
        } else {
            ContentUnavailableView("還沒有專案", systemImage: "tray")
        }
    }
}

/// 導覽列右邊:管家、設定、⋯(帶入網頁版的版面、關閉所有分頁)
struct CodeToolbarItems: ToolbarContent {
    @Environment(AppModel.self) private var model
    @Binding var notice: String?

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(model.drawerOpen ? "收起管家" : "管家") { model.drawerOpen.toggle() }
            SettingsToolbarButton()
            Menu {
                Button { Task { await importWeb() } } label: { Label("帶入網頁版的版面", systemImage: "square.and.arrow.down.on.square") }
                // 沒存的留著(分頁上有小圓點),跟長按分頁的「關閉其他分頁」一樣
                Button(role: .destructive) { model.code.closeAll() } label: {
                    Label("關閉所有分頁", systemImage: "xmark.square")
                }
                .disabled(model.code.allTabs.isEmpty)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("程式碼頁選項")
        }
    }

    /// 帶入電腦上網頁版的版面(只讀,不寫回)
    private func importWeb() async {
        guard let api = model.api, let pid = model.currentProjectId else { return }
        do {
            let n = model.code.importWeb(try await api.codeSession(project: pid))
            notice = n > 0 ? "已帶入網頁版的版面(\(n) 個分頁)" : "網頁版還沒有存版面"
            if n > 0, model.compact, model.codePath.last != .editor { model.codePath.append(.editor) }
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// iPhone 和窄視窗:原本的一層層點進去;打開檔案推進單格編輯畫面
struct CompactCodeLayout: View {
    @Environment(AppModel.self) private var model
    @State private var notice: String?

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.codePath) {
            Group {
                if let p = model.current {
                    CodeHome(project: p).id(p.id)
                } else {
                    ContentUnavailableView("還沒有專案", systemImage: "tray")
                }
            }
            .modifier(ProjectChrome())
            .toolbar { CodeToolbarItems(notice: $notice) }
            .navigationDestination(for: CodeRoute.self) { CodeDestination(route: $0) }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) { Button("好") {} }
    }
}

/// iPad:側欄版面(像「檔案」app、Mac 上的 Xcode):左邊「檔案|版本控制」,右邊分割編輯區。
/// 自己排兩欄(系統的分割視圖直式時會把側欄蓋在編輯區上面),直式橫式都並排;左上角按鈕收起/打開側欄
struct RegularCodeLayout: View {
    @Environment(AppModel.self) private var model
    @AppStorage("codeSidebar") private var showSidebar = true
    @State private var notice: String?

    var body: some View {
        @Bindable var model = model
        HStack(spacing: 0) {
            // 看檔案全螢幕時側欄先收起來(記著的開關不動)
            if showSidebar && !model.isReaderFullScreen {
                NavigationStack(path: $model.codePath) {
                    Group {
                        if let p = model.current {
                            CodeHome(project: p).id(p.id)
                        } else {
                            ContentUnavailableView("還沒有專案", systemImage: "tray")
                        }
                    }
                    .navigationTitle("程式碼")
                    .navigationBarTitleDisplayMode(.inline)
                    .navigationDestination(for: CodeRoute.self) { CodeDestination(route: $0) }
                }
                .frame(width: 320)
                .transition(.move(edge: .leading))
                Divider().ignoresSafeArea()
            }
            NavigationStack {
                Group {
                    if let p = model.current {
                        EditorArea(project: p).id(p.id)
                    } else {
                        ContentUnavailableView("還沒有專案", systemImage: "tray")
                    }
                }
                .modifier(ProjectChrome())
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { withAnimation(.snappy) { showSidebar.toggle() } } label: { Image(systemName: "sidebar.left") }
                            .accessibilityLabel(showSidebar ? "收起側欄" : "打開側欄")
                    }
                    CodeToolbarItems(notice: $notice)
                }
            }
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) { Button("好") {} }
    }
}

/// 程式碼頁的第一層:檔案 | 版本控制(跟網頁程式碼頁左邊的兩個按鈕一樣)
struct CodeHome: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var query = ""

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
                // 找檔名(搜整個專案)放在「檔案|版本控制」下面
                SearchField(prompt: "找檔名", text: $query)
                    .padding(.horizontal).padding(.bottom, 6)
                FolderView(project: project, dir: "", rootQuery: $query)
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
    /// 最上層的找檔名(搜尋框在 CodeHome,點進資料夾就沒有)
    var rootQuery: Binding<String>?
    private var query: String { rootQuery?.wrappedValue ?? "" }
    @State private var results: [String] = []
    @State private var naming: NameAction?
    @State private var newName = ""
    @State private var trashing: FileEntry?
    // 上傳:傳到哪個資料夾、從哪裡挑
    @State private var uploadBase = ""
    @State private var importing = false
    @State private var importFolder = false
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var dropTargeted = false

    /// 新檔案/新資料夾帶著要建在哪個資料夾(長按資料夾「在這裡新增」)
    enum NameAction: Identifiable {
        case newFile(String), newFolder(String), rename(FileEntry)
        var id: String {
            switch self {
            case .newFile(let d): "newFile-\(d)"
            case .newFolder(let d): "newFolder-\(d)"
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
                        FileOpenRow(rel: rel) {
                            Label {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text((rel as NSString).lastPathComponent)
                                    Text(rel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            } icon: { Image(systemName: fileIcon(rel)) }
                        }
                        .contextMenu { openMenu(rel) }
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
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { results = []; return }
            try? await Task.sleep(for: .milliseconds(250))
            results = (try? await model.api?.findFiles(project: project.id, query: q)) ?? []
        }
        .task(id: model.showHiddenFiles) { await load() }
        .refreshable { await load() }
        .onChange(of: model.uploads.refresh) { Task { await load() } }
        .onChange(of: model.code.gitChanged) { Task { await load() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Section {
                        Button { newName = ""; naming = .newFile(dir) } label: { Label("新檔案", systemImage: "doc.badge.plus") }
                        Button { newName = ""; naming = .newFolder(dir) } label: { Label("新資料夾", systemImage: "folder.badge.plus") }
                    }
                    Section(dir.isEmpty ? "上傳到專案最上層" : "上傳到「\((dir as NSString).lastPathComponent)」") { uploadButtons(to: dir) }
                    Section {
                        Toggle(isOn: Binding(get: { model.showHiddenFiles }, set: { model.showHiddenFiles = $0 })) {
                            Label("顯示 . 開頭的檔案", systemImage: "eye")
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("新增、上傳檔案")
            }
        }
        // 上傳:從「檔案」挑(檔案或整個資料夾)、從照片挑、拍照、iPad 拖進來
        .fileImporter(isPresented: $importing, allowedContentTypes: importFolder ? [.folder] : [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            let base = uploadBase
            Task { await startUpload(to: base) { await model.uploads.importPicked(urls) } }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 30, selectionBehavior: .ordered, matching: .any(of: [.images, .videos]), preferredItemEncoding: .compatible)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            let base = uploadBase
            Task { await startUpload(to: base) { await model.uploads.importPhotos(items) } }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker(onPick: { img in
                let base = uploadBase
                Task { await startUpload(to: base) { model.uploads.importPhoto(img) } }
            })
            .ignoresSafeArea()
        }
        .onDrop(of: [.item], delegate: UploadDropDelegate(targeted: $dropTargeted) { providers in
            let base = dir
            Task { await startUpload(to: base) { await model.uploads.importDropped(providers) } }
        })
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.accent, lineWidth: 3).padding(6).allowsHitTesting(false)
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
        case .newFile(let d): d == dir ? "新檔案" : "在「\((d as NSString).lastPathComponent)」新增檔案"
        case .newFolder(let d): d == dir ? "新資料夾" : "在「\((d as NSString).lastPathComponent)」新增資料夾"
        case .rename: "重新命名"
        case nil: ""
        }
    }

    /// 上傳的四個來源(+ 選單和長按資料夾共用)
    @ViewBuilder
    private func uploadButtons(to base: String) -> some View {
        Button { uploadBase = base; importFolder = false; importing = true } label: { Label("從「檔案」上傳…", systemImage: "arrow.up.doc") }
        Button { uploadBase = base; importFolder = true; importing = true } label: { Label("上傳整個資料夾…", systemImage: "folder") }
        Button { uploadBase = base; pickingPhotos = true } label: { Label("從照片上傳…", systemImage: "photo.on.rectangle") }
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button { uploadBase = base; takingPhoto = true } label: { Label("拍照上傳", systemImage: "camera") }
        }
    }

    private func startUpload(to base: String, _ gather: () async -> [UploadItem]) async {
        guard let api = model.api else { return }
        guard !model.uploads.running else { model.uploads.notice("還有檔案在上傳,等它傳完"); return }
        let items = await gather()
        let pid = project.id
        await model.uploads.upload(items, to: base, project: pid, api: api) { model.currentProjectId == pid }
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
            FileOpenRow(rel: e.rel) { label }
        }
    }

    /// iPad:檔案開在右邊/下面(長按選單)
    @ViewBuilder
    private func openMenu(_ rel: String) -> some View {
        if !model.compact {
            Button { model.openCode(.file(rel), zone: .right) } label: { Label("在右邊打開", systemImage: "rectangle.righthalf.inset.filled") }
            Button { model.openCode(.file(rel), zone: .bottom) } label: { Label("在下面打開", systemImage: "rectangle.bottomhalf.inset.filled") }
        }
    }

    /// 長按的動作(寫在這個畫面裡,不另外做成會讀環境的 View:長按選單畫在一般畫面樹外面)
    @ViewBuilder
    private func menu(_ e: FileEntry) -> some View {
        if !e.isDir {
            openMenu(e.rel)
            Button { model.pendingChat = .file(e.rel); model.present(.chat) } label: { Label("問管家這個檔案", systemImage: "bubble.left.and.text.bubble.right") }
        } else {
            Menu { uploadButtons(to: e.rel) } label: { Label("上傳到這個資料夾", systemImage: "square.and.arrow.up") }
            Button { newName = ""; naming = .newFile(e.rel) } label: { Label("在這裡新增檔案", systemImage: "doc.badge.plus") }
            Button { newName = ""; naming = .newFolder(e.rel) } label: { Label("在這裡新增資料夾", systemImage: "folder.badge.plus") }
        }
        Button { newName = e.name; naming = .rename(e) } label: { Label("重新命名", systemImage: "pencil") }
        Button { UIPasteboard.general.string = e.rel } label: { Label("複製路徑", systemImage: "doc.on.doc") }
        Button(role: .destructive) { trashing = e } label: { Label("移到垃圾桶", systemImage: "trash") }
    }

    private func load() async {
        do {
            entries = try await model.api?.tree(project: project.id, dir: dir, hidden: model.showHiddenFiles)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func commitName() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let join = { (d: String, n: String) in d.isEmpty ? n : "\(d)/\(n)" }
        switch naming {
        case .newFile(let d): await op("mkfile", join(d, name))
        case .newFolder(let d): await op("mkdir", join(d, name))
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

/// 系統樣式的搜尋框(系統的 .searchable 只能放在導覽列,這個可以放在「檔案|版本控制」下面)
/// 清單裡的一個檔案:點了打開成分頁(iPhone 推進編輯畫面、iPad 開在目前那一格);
/// iPad 上目前開著的檔案標亮,也可以拖到右邊編輯區的某一格
struct FileOpenRow<RowLabel: View>: View {
    @Environment(AppModel.self) private var model
    let rel: String
    @ViewBuilder let label: () -> RowLabel

    var body: some View {
        let open = model.code.activeTab?.id == EditorTab.file(rel).id
        Button { model.openCode(.file(rel)) } label: {
            HStack(spacing: 0) {
                label()
                if model.compact {
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("row-\(rel)")
        .listRowBackground(!model.compact && open ? Theme.accent.opacity(0.14) : nil)
        .if(!model.compact) { $0.draggable(EditorTab.file(rel)) }
    }
}

/// 從「檔案」app 拖檔案進清單 = 上傳;app 裡拖的分頁不算
struct UploadDropDelegate: DropDelegate {
    @Binding var targeted: Bool
    let onDrop: ([NSItemProvider]) -> Void

    func validateDrop(info: DropInfo) -> Bool { !info.hasItemsConforming(to: [.stewardTab]) && info.hasItemsConforming(to: [.item]) }
    func dropEntered(info: DropInfo) { targeted = validateDrop(info: info) }
    func dropExited(info: DropInfo) { targeted = false }
    func dropUpdated(info: DropInfo) -> DropProposal? { validateDrop(info: info) ? DropProposal(operation: .copy) : DropProposal(operation: .forbidden) }

    func performDrop(info: DropInfo) -> Bool {
        targeted = false
        guard validateDrop(info: info) else { return false }
        onDrop(info.itemProviders(for: [.item]))
        return true
    }
}

struct SearchField: View {
    let prompt: String
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(prompt, text: $text)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                if !text.isEmpty {
                    Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("清除")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Color(.tertiarySystemFill), in: Capsule())
            if focused {
                Button("取消") { text = ""; focused = false }
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: focused)
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
    /// 這個分頁的 id:編輯中還沒存的內容記在版面資料裡(切分頁、重開 app 都還在)
    var tabId: String?
    /// 在分割編輯區的格子裡:用格子自己的動作列,不用導覽列
    var embedded = false
    /// 是目前這一格(⌘S、⌘F 只給它)
    var isActive = true
    @State private var file: CodeFile?
    /// 開始編輯時檔案的指紋(存檔時偵測別人改過)
    @State private var baseHash: String?
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
    /// 很大的檔案多載入的行數(跟網頁「載入更多」一樣每次多 2000 行)
    @State private var more = 0
    /// 目前顯示的內容的指紋:電腦上的檔案改了(agent 改檔)就自動重新載入
    @State private var stamp: String?
    @State private var gone = false
    @State private var note: String?
    /// 點行號選取的行(問管家、開工作卡、複製)
    @State private var lineSel: ClosedRange<Int>?
    /// 這一格剛變成目前這一格的時間(那一下點擊是用來換格子的,不切全螢幕)
    @State private var activatedAt = Date.distantPast
    @State private var finding = false
    @State private var findText = ""
    @State private var findIndex = 0
    @FocusState private var findFocused: Bool
    @State private var showHistory = false

    private var ext: String { (path as NSString).pathExtension.lowercased() }
    private var isMarkdown: Bool { ["md", "markdown"].contains(ext) }
    private var isNotebook: Bool { ext == "ipynb" }

    var body: some View {
        dialogs(lifecycle(chrome))
    }

    /// 內容 + 導覽列/動作列。
    /// 格子裡:動作列和提示列直接排在內容上面(用浮在上面的列的話,iPad 格子裡的編輯框會拿不到焦點);
    /// 不在格子裡:提示列浮在上面、按鈕在導覽列
    private var chrome: some View {
        VStack(spacing: 0) {
            if embedded && !fullScreen { topBars }
            Group {
                if let error {
                    ContentUnavailableView("打不開", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if let file {
                    content(file)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .if(!embedded) {
            $0.navigationTitle((path as NSString).lastPathComponent)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .safeAreaInset(edge: .top, spacing: 0) { if !fullScreen { topBars } }
        }
        // 全螢幕:導覽列、底下的分頁列收起來(狀態列在 AppShell 收;其他的列和按鈕看 model.isReaderFullScreen 自己收)
        .toolbar(fullScreen ? .hidden : .automatic, for: .navigationBar, .tabBar)
        .background {
            // 外接鍵盤 Esc 也能結束全螢幕
            if fullScreen { Button("結束全螢幕") { toggleFullScreen() }.keyboardShortcut(.escape, modifiers: []).hidden() }
        }
    }

    // MARK: 全螢幕閱讀(點一下畫面切換,像「照片」「檔案」app)

    /// 全螢幕記的是哪一個分頁(沒有分頁就用路徑)
    private var readerKey: String { tabId ?? "file:\(path)" }
    private var fullScreen: Bool { model.readerFullScreen == readerKey }
    /// 看(不是編輯)的時候才能全螢幕:編輯中、選行、尋找時點一下不切換
    private var canFullScreen: Bool {
        guard let f = file, !editing, lineSel == nil, !finding else { return false }
        return ["text", "image", "pdf"].contains(f.kind)
    }

    private func toggleFullScreen() {
        // iPad 分割:點別格先只是換到那一格(PDF、圖片收不到格子的點擊,這裡自己換),再點一下才全螢幕。
        // PDF、圖片的單擊要等雙擊沒成立才算,那時格子可能已經被點成目前這一格:剛換過來的這一下也不算
        if embedded && !fullScreen && (!isActive || Date.now.timeIntervalSince(activatedAt) < 0.6) {
            if !isActive, let tabId, let p = model.code.paneOf(tab: tabId) { model.code.focus(p) }
            return
        }
        guard fullScreen || canFullScreen else { return }
        withAnimation(.easeInOut(duration: 0.2)) { model.readerFullScreen = fullScreen ? nil : readerKey }
    }

    /// 載入、監看、記下編輯中的內容
    private func lifecycle(_ v: some View) -> some View {
        v
        .task { await load() }
        // 沒在編輯時每 4 秒看一次電腦上的檔案有沒有被改(跟網頁一樣)
        .task(id: editing) { await watch() }
        .onChange(of: file?.content) { _, c in if file?.kind == "text", !editing, let c, let tabId { model.code.texts[tabId] = c } }
        .onChange(of: draft) { _, d in
            guard editing, let tabId else { return }
            model.code.texts[tabId] = d
            model.code.setDraft(tabId, EditorDraft(text: d, baseHash: baseHash ?? file?.hash), dirty: d != file?.content)
        }
        .onChange(of: editing) { _, e in
            guard !e, let tabId else { return }
            model.code.setDraft(tabId, nil, dirty: false)
            if let c = file?.content { model.code.texts[tabId] = c }
        }
        .onChange(of: findText) { findIndex = 0 }
        .onDisappear {
            if let tabId { model.code.texts[tabId] = nil }
            if fullScreen { model.readerFullScreen = nil }
        }
        // 換到別的分頁、開始編輯:結束全螢幕
        .onChange(of: isActive) { _, a in
            if a { activatedAt = .now }
            if !a, fullScreen { model.readerFullScreen = nil }
        }
        .onChange(of: editing) { _, e in if e, fullScreen { model.readerFullScreen = nil } }
    }

    /// Quick Look、歷史版本、存檔失敗、被改過的提醒
    private func dialogs(_ v: some View) -> some View {
        v
        .quickLookPreview($quickLookURL)
        .sheet(isPresented: $showHistory) {
            OfficeHistoryView(project: project, path: path) { Task { await reloadFromDisk(note: "已還原") } }
        }
        .alert("存檔失敗", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("好") {}
        } message: {
            Text(saveError ?? "")
        }
        .alert("檔案在你打開之後被改過了", isPresented: Binding(get: { conflict != nil }, set: { if !$0 { conflict = nil } })) {
            Button("用我的覆蓋", role: .destructive) { Task { await save(force: true) } }
            Button("放棄我的、載入新版") {
                if let c = conflict { file?.content = c.diskContent; file?.hash = c.diskHash; stamp = c.diskHash; draft = c.diskContent }
                editing = false
                baseHash = nil
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
                    .findNavigator(isPresented: $finding)
            } else if isNotebook && showPreview, let d = (f.content ?? "").data(using: .utf8) {
                NotebookView(json: d).modifier(ReaderTap(fullScreen: fullScreen) { toggleFullScreen() })
            } else if isMarkdown && showPreview {
                ScrollView { MarkdownText(f.content ?? "").padding() }.modifier(ReaderTap(fullScreen: fullScreen) { toggleFullScreen() })
            } else {
                CodeText(
                    text: f.content ?? "",
                    truncated: f.truncated.map { "檔案太大,只顯示開頭和結尾各 \($0.shown) 行(共 \($0.total) 行)" },
                    onMore: f.truncated == nil ? nil : { more += 2000; Task { await reloadFromDisk(note: nil) } },
                    find: finding ? findText : "",
                    findIndex: findIndex,
                    // 只顯示頭尾的大檔行號不連續:不給選
                    selection: f.truncated == nil ? $lineSel : nil
                )
                .modifier(ReaderTap(fullScreen: fullScreen) { toggleFullScreen() })
            }
        case "image":
            if let data, let img = UIImage(data: data) {
                ZoomableImage(image: img) { toggleFullScreen() }
                    .ignoresSafeArea(edges: fullScreen ? .all : [])
                    .accessibilityAction(named: fullScreen ? "結束全螢幕" : "全螢幕") { toggleFullScreen() }
            } else { ProgressView() }
        case "pdf":
            if let data {
                PDFKitView(data: data) { toggleFullScreen() }
                    .ignoresSafeArea(edges: fullScreen ? .all : .bottom)
                    .accessibilityAction(named: fullScreen ? "結束全螢幕" : "全螢幕") { toggleFullScreen() }
            } else { ProgressView() }
        case "office":
            VStack(spacing: 16) {
                Image(systemName: fileIcon(path)).font(.system(size: 56)).foregroundStyle(.secondary)
                Text((path as NSString).lastPathComponent).font(.headline)
                Button("用 Quick Look 預覽") { Task { await openQuickLook() } }.buttonStyle(.borderedProminent)
                Button { showHistory = true } label: { Label("歷史版本", systemImage: "clock.arrow.circlepath") }.buttonStyle(.bordered)
                Text("要編輯 Word / Excel / PowerPoint,在電腦上用 Office 打開").font(.footnote).foregroundStyle(.secondary)
            }
            .padding()
        case "toolarge":
            ContentUnavailableView("檔案太大", systemImage: "doc.badge.ellipsis", description: Text("超過能預覽的大小。"))
        default:
            ContentUnavailableView("不是文字檔", systemImage: "doc.questionmark", description: Text("這個檔案沒辦法在這裡預覽。"))
        }
    }

    private var canEdit: Bool { file?.kind == "text" && file?.readonly != true && (!isNotebook || !showPreview) }
    private var hasPreview: Bool { file?.kind == "text" && (isMarkdown || isNotebook) }

    private func startEdit() {
        guard let f = file else { return }
        draft = f.content ?? ""
        baseHash = f.hash
        lineSel = nil
        editing = true
        showPreview = false
    }

    private func cancelEdit() {
        editing = false
        draft = file?.content ?? ""
        baseHash = nil
    }

    /// 「⋯」選單(導覽列和格子的動作列共用)
    @ViewBuilder
    private var moreMenu: some View {
        Button { model.pendingChat = .file(path); model.present(.chat) } label: { Label("問管家這個檔案", systemImage: "bubble.left.and.text.bubble.right") }
        if let f = file, f.kind == "text", !editing, !(isMarkdown && showPreview), !(isNotebook && showPreview) {
            Button { finding = true; findFocused = true } label: { Label("在檔案中尋找", systemImage: "magnifyingglass") }
            if f.truncated == nil {
                Button { lineSel = 1...1 } label: { Label("選取幾行來問管家或開工作卡", systemImage: "text.line.first.and.arrowtriangle.forward") }
            }
        }
        if file?.kind == "office" {
            Button { showHistory = true } label: { Label("歷史版本", systemImage: "clock.arrow.circlepath") }
        }
        Button { UIPasteboard.general.string = path } label: { Label("複製路徑", systemImage: "doc.on.doc") }
        Button { model.present(.web(.codeEditor)) } label: { Label("在網頁版編輯器打開", systemImage: "safari") }
    }

    /// 格子裡的動作列(像 Xcode 編輯器上方那一條):路徑、預覽/原文、編輯(或取消/儲存)、尋找、⋯
    private var actionBar: some View {
        HStack(spacing: 14) {
            Text(path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)
            if editing {
                Button("取消") { cancelEdit() }
                Button { Task { await save(force: false) } } label: {
                    if saving { ProgressView() } else { Text("儲存").bold() }
                }
                .keyboardShortcut(isActive ? KeyboardShortcut("s", modifiers: .command) : nil)
                .disabled(saving || draft == file?.content)
            } else {
                if hasPreview {
                    Picker("檢視", selection: $showPreview) {
                        Text("預覽").tag(true)
                        Text("原文").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 110)
                }
                if canEdit { Button("編輯") { startEdit() } }
            }
            if file?.kind == "text" {
                Button { finding.toggle() } label: { Image(systemName: "magnifyingglass") }
                    .keyboardShortcut(isActive ? KeyboardShortcut("f", modifiers: .command) : nil)
                    .accessibilityLabel("在檔案中尋找")
            }
            Menu { moreMenu } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("更多")
        }
        .font(.subheadline)
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// 導覽列上的按鈕(格子裡不用,改用格子自己的動作列)
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !embedded { navToolbar }
    }

    @ToolbarContentBuilder
    private var navToolbar: some ToolbarContent {
        if editing {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { cancelEdit() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button { Task { await save(force: false) } } label: {
                    if saving { ProgressView() } else { Text("儲存").bold() }
                }
                .keyboardShortcut("s", modifiers: .command)
                .disabled(saving || draft == file?.content)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { finding.toggle() } label: { Image(systemName: "magnifyingglass") }
                    .keyboardShortcut("f", modifiers: .command)
                    .accessibilityLabel("在檔案中尋找")
            }
        } else {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let f = file, f.kind == "text", isMarkdown || isNotebook {
                    Picker("檢視", selection: $showPreview) {
                        Text("預覽").tag(true)
                        Text("原文").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 120)
                }
                if canEdit {
                    Button("編輯") { startEdit() }
                }
                Menu { moreMenu } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("更多")
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            let f = try await api.readFile(project: project.id, path: path, more: more)
            file = f
            stamp = f.hash
            if let tabId {
                if let d = model.code.drafts[tabId], f.kind == "text" {
                    draft = d.text
                    baseHash = d.baseHash
                    editing = true
                    showPreview = false
                    model.code.texts[tabId] = d.text
                } else if let c = f.content {
                    model.code.texts[tabId] = c
                }
            }
            if let o = model.codeOpenLines, o.path == path { model.codeOpenLines = nil; if f.kind == "text", f.truncated == nil { lineSel = o.lines; showPreview = false } }
            if let o = model.codeOpenFind, o.path == path { model.codeOpenFind = nil; if f.kind == "text" { findText = o.text; finding = true; showPreview = false } }
            if f.kind == "image" || f.kind == "pdf" { data = try await api.rawFile(project: project.id, path: path) }
            // Office 檔第一次打開時自動用 Quick Look 預覽(只一次;之後用按鈕)
            if f.kind == "office", !quickLookedOnce, tabId.map({ !model.code.quickLooked.contains($0) }) ?? true {
                quickLookedOnce = true
                if let tabId { model.code.quickLooked.insert(tabId) }
                await openQuickLook()
            }
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

    /// 電腦上的檔案被改了(agent 改檔、Office 存檔、LaTeX 重新產生 PDF)就重新載入;被刪掉就提示
    private func watch() async {
        guard !editing else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, !editing, model.mode == .code, let api = model.api, let f = file, ["text", "image", "pdf", "office"].contains(f.kind) else { continue }
            guard let st = try? await api.stamps(project: project.id, paths: [path])[path] else { continue }
            if st.gone == true { gone = true; continue }
            gone = false
            guard let h = st.hash else { continue }
            if stamp == nil { stamp = h } else if h != stamp { await reloadFromDisk(note: "電腦上的檔案改過了,已更新") }
        }
    }

    private func reloadFromDisk(note msg: String?) async {
        guard let api = model.api else { return }
        do {
            let f = try await api.readFile(project: project.id, path: path, more: more)
            guard !editing else { return }
            if f.kind == "image" || f.kind == "pdf" { data = try await api.rawFile(project: project.id, path: path) }
            file = f
            if let h = f.hash { stamp = h } else if let h = try? await api.stamps(project: project.id, paths: [path])[path]?.hash { stamp = h }
            if let msg { flash(msg) }
        } catch {}
    }

    private func flash(_ msg: String) {
        withAnimation { note = msg }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if note == msg { withAnimation { note = nil } }
        }
    }

    /// 上面的提示列:檔案被刪了、已更新、尋找、選取的行
    @ViewBuilder
    private var topBars: some View {
        VStack(spacing: 0) {
            if embedded { actionBar }
            if gone {
                Label("這個檔案已經被刪除或改名了", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity).padding(8).background(.bar)
            } else if let note {
                Label(note, systemImage: "arrow.triangle.2.circlepath")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(8).background(.bar)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if finding && !editing { findBar }
            if let sel = lineSel, !editing { selectionBar(sel) }
        }
    }

    private var findHits: [Int] { CodeText.matches((file?.content ?? "").components(separatedBy: "\n"), findText) }

    private var findBar: some View {
        let hits = findHits
        return HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("在檔案中尋找", text: $findText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($findFocused)
                .onSubmit { if !hits.isEmpty { findIndex = (findIndex + 1) % hits.count } }
            if !findText.isEmpty {
                Text(hits.isEmpty ? "找不到" : "\(min(findIndex, hits.count - 1) + 1)/\(hits.count)")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Button { findIndex = (findIndex - 1 + hits.count) % max(hits.count, 1) } label: { Image(systemName: "chevron.up") }
                .disabled(hits.isEmpty).accessibilityLabel("上一個")
            Button { findIndex = (findIndex + 1) % max(hits.count, 1) } label: { Image(systemName: "chevron.down") }
                .disabled(hits.isEmpty).accessibilityLabel("下一個")
            Button("完成") { finding = false; findText = "" }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
        .onAppear { findFocused = true }
    }

    private func selectionBar(_ sel: ClosedRange<Int>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(lineLabel(sel)).font(.subheadline.weight(.semibold)).monospacedDigit()
                Spacer(minLength: 4)
                Button("問管家") { askLines(sel) }
                Button("開工作卡") { cardLines(sel) }
                Button("複製") { UIPasteboard.general.string = lineText(sel); flash("已複製 \(lineLabel(sel))"); lineSel = nil }
                Button { lineSel = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel("取消選取")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            Text("點左邊的行號選取;再點另一個行號選一段範圍").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private func lineLabel(_ sel: ClosedRange<Int>) -> String {
        sel.lowerBound == sel.upperBound ? "第 \(sel.lowerBound) 行" : "第 \(sel.lowerBound)–\(sel.upperBound) 行"
    }

    private func lineText(_ sel: ClosedRange<Int>) -> String {
        let lines = (file?.content ?? "").components(separatedBy: "\n")
        let lo = max(1, sel.lowerBound), hi = min(lines.count, sel.upperBound)
        return lo <= hi ? lines[(lo - 1)..<hi].joined(separator: "\n") : ""
    }

    /// 選取的行 → 問管家(當成引用,跟網頁編輯器右鍵「問管家」一樣)
    private func askLines(_ sel: ClosedRange<Int>) {
        model.pendingChat = .quote(ChatQuote(path: path, from: sel.lowerBound, to: sel.upperBound, text: lineText(sel)))
        lineSel = nil
        model.present(.chat)
    }

    /// 選取的行 → 請管家擬工作卡(跟圈選的「開工作卡」一樣,擬好可以改再放進提案)
    private func cardLines(_ sel: ClosedRange<Int>) {
        model.pendingChat = .draft("依照這段程式碼開工作卡\n出處:\(path) \(lineLabel(sel))\n內容:\n```\n\(lineText(sel).prefix(3000))\n```")
        lineSel = nil
        model.present(.chat)
    }

    private func save(force: Bool) async {
        guard let api = model.api else { return }
        saving = true
        defer { saving = false }
        do {
            let hash = try await api.saveFile(project: project.id, path: path, content: draft, baseHash: baseHash ?? file?.hash, force: force)
            file?.content = draft
            file?.hash = hash
            stamp = hash
            baseHash = nil
            editing = false
            model.code.gitChanged += 1
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch let c as SaveConflict {
            conflict = c
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            saveError = error.localizedDescription
        }
    }
}

/// 唯讀的程式碼:左邊行號、等寬字、可以左右捲(長行不折)。
/// 尋找時符合的行標黃色、目前這個捲過去;點行號選行(再點另一個行號選一段範圍)
struct CodeText: View {
    let text: String
    var truncated: String?
    var onMore: (() -> Void)?
    var find = ""
    var findIndex = 0
    var selection: Binding<ClosedRange<Int>?>?

    /// 含有關鍵字的行(從 0 開始,不分大小寫)
    static func matches(_ lines: [String], _ q: String) -> [Int] {
        let q = q.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        return lines.indices.filter { lines[$0].range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    /// 程式碼的字型(跟下面的 .footnote 等寬字一樣,量寬度用)
    private static var uiFont: UIFont { UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular) }
    private static let widthCache = NSCache<NSString, NSNumber>()

    /// 最長那一行的寬度:先用字數挑出最長的幾行(中日韓字、emoji 算兩格、tab 算四格),再實際量
    static func longestLineWidth(_ lines: [String], text: String) -> CGFloat {
        let font = uiFont
        let key = "\(text.hashValue)-\(text.utf16.count)-\(font.pointSize)" as NSString
        if let w = widthCache.object(forKey: key) { return CGFloat(w.doubleValue) }
        let cols = lines.map { line in
            line.unicodeScalars.reduce(0) { n, u in n + (u.value == 9 ? 4 : (u.value >= 0x2E80 || u.properties.isEmojiPresentation) ? 2 : 1) }
        }
        let top = cols.indices.sorted { cols[$0] > cols[$1] }.prefix(6)
        let w = top.map { (lines[$0] as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        widthCache.setObject(NSNumber(value: Double(w)), forKey: key)
        return w
    }

    var body: some View {
        let lines = text.components(separatedBy: "\n")
        let width = String(lines.count).count
        let gutter = ("0" as NSString).size(withAttributes: [.font: Self.uiFont]).width * CGFloat(width) + 8 + 12
        let contentWidth = ceil(gutter + Self.longestLineWidth(lines, text: text) + 12)
        let hits = Self.matches(lines, find)
        let hitSet = Set(hits)
        let current = hits.isEmpty ? nil : hits[min(findIndex, hits.count - 1)]
        let sel = selection?.wrappedValue
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: 0) {
                        if let truncated {
                            HStack(spacing: 12) {
                                Text(truncated).foregroundStyle(.secondary)
                                if let onMore { Button("載入更多", action: onMore) }
                            }
                            .font(.caption)
                            .padding(.bottom, 8)
                        }
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(String(i + 1).leftPad(width))
                                        .foregroundStyle(sel?.contains(i + 1) == true ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.tertiary))
                                        .padding(.horizontal, 4)
                                        .contentShape(Rectangle())
                                        .onTapGesture { tap(i + 1) }
                                    Text(line.isEmpty ? " " : line)
                                        .textSelection(.enabled)
                                }
                                .font(.system(.footnote, design: .monospaced))
                                .fixedSize(horizontal: true, vertical: false)
                                // 每一行都跟最長那一行一樣寬:清單才會比螢幕寬,手指才拖得動
                                .frame(width: max(contentWidth, geo.size.width - 24), alignment: .leading)
                                .background(background(i, sel: sel, hit: hitSet.contains(i), current: i == current))
                                .id(i)
                            }
                        }
                    }
                    .frame(width: max(contentWidth, geo.size.width - 24), alignment: .leading)
                    .padding(.vertical)
                    .padding(.horizontal, 12)
                }
                .onChange(of: current) { _, c in
                    if let c { withAnimation { proxy.scrollTo(c, anchor: UnitPoint(x: 0, y: 0.35)) } }
                }
                .onAppear {
                    if let current { proxy.scrollTo(current, anchor: UnitPoint(x: 0, y: 0.35)) }
                    else if let sel, sel.lowerBound > 1 { proxy.scrollTo(sel.lowerBound - 1, anchor: UnitPoint(x: 0, y: 0.3)) }
                }
            }
        }
        .background(Color(.systemBackground))
    }

    private func background(_ i: Int, sel: ClosedRange<Int>?, hit: Bool, current: Bool) -> Color {
        if sel?.contains(i + 1) == true { return Theme.accent.opacity(0.16) }
        if current { return Color.yellow.opacity(0.45) }
        if hit { return Color.yellow.opacity(0.18) }
        return .clear
    }

    /// 點行號:沒選 → 選這行;點同一行 → 取消;點範圍裡面 → 從這行重選;點外面 → 延伸範圍
    private func tap(_ n: Int) {
        guard let selection else { return }
        if let s = selection.wrappedValue {
            if s.lowerBound == n && s.upperBound == n { selection.wrappedValue = nil }
            else if s.contains(n) { selection.wrappedValue = n...n }
            else { selection.wrappedValue = min(s.lowerBound, n)...max(s.upperBound, n) }
        } else {
            selection.wrappedValue = n...n
        }
        UISelectionFeedbackGenerator().selectionChanged()
    }
}

extension String {
    func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: " ", count: n - count) + self }
}

/// 文字類的檢視(程式碼、Markdown、Notebook):點一下切換全螢幕(點行號選行、長按選字照常)
struct ReaderTap: ViewModifier {
    let fullScreen: Bool
    let action: () -> Void

    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .onTapGesture { action() }
            .accessibilityAction(named: fullScreen ? "結束全螢幕" : "全螢幕") { action() }
    }
}

/// 圖片:系統的縮放(雙指在手指的位置放大、雙擊放大/還原);最小只能縮到圖片寬度剛好塞滿畫面;點一下切換全螢幕
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var onTap: () -> Void = {}

    func makeUIView(context: Context) -> ImageZoomView { ImageZoomView(image: image) }
    func updateUIView(_ v: ImageZoomView, context: Context) { v.onTap = onTap }
}

final class ImageZoomView: UIScrollView, UIScrollViewDelegate {
    private let imageView: UIImageView
    var onTap: () -> Void = {}
    /// 圖片寬度剛好塞滿畫面的縮放(最小只能縮到這裡)
    private var fitScale: CGFloat = 0

    init(image: UIImage) {
        imageView = UIImageView(image: image)
        super.init(frame: .zero)
        delegate = self
        addSubview(imageView)
        imageView.frame = CGRect(origin: .zero, size: image.size)
        contentSize = image.size
        contentInsetAdjustmentBehavior = .never
        showsHorizontalScrollIndicator = false
        decelerationRate = .fast
        backgroundColor = .systemBackground
        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        double.numberOfTapsRequired = 2
        let single = UITapGestureRecognizer(target: self, action: #selector(singleTapped))
        single.require(toFail: double)
        addGestureRecognizer(double)
        addGestureRecognizer(single)
        accessibilityIdentifier = "image-view"
    }

    required init?(coder: NSCoder) { fatalError() }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { center(); report() }

    /// 縮放(塞滿寬度 = 100%):VoiceOver 和 UI 測試讀這個
    private func report() {
        guard fitScale > 0 else { return }
        accessibilityValue = "縮放 \(Int((zoomScale / fitScale * 100).rounded()))%"
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = imageView.image?.size.width ?? 0
        guard w > 0, bounds.width > 1 else { return }
        let fit = bounds.width / w
        if abs(fit - fitScale) > 0.0001 {
            // 原本就是塞滿寬度(或還沒設過):畫面變寬變窄(轉向、拖格子)後還是塞滿
            let wasFit = fitScale == 0 || zoomScale <= fitScale + 0.0001
            fitScale = fit
            minimumZoomScale = fit
            maximumZoomScale = max(fit * 6, 3)
            if wasFit || zoomScale < fit { zoomScale = fit }
        }
        center()
        report()
    }

    /// 圖比畫面矮(或縮小時比畫面窄)就置中
    private func center() {
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        let dy = max(0, (bounds.height - contentSize.height) / 2)
        let inset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        if contentInset != inset { contentInset = inset }
    }

    @objc private func doubleTapped(_ g: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.001 {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let s = min(maximumZoomScale, minimumZoomScale * 2.5)
            let p = g.location(in: imageView)
            let size = CGSize(width: bounds.width / s, height: bounds.height / s)
            zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }

    @objc private func singleTapped() { onTap() }
}

/// PDF:最小只能縮到最寬的那一頁剛好塞滿寬度(不會無限縮小);點一下切換全螢幕
/// (等雙擊放大沒成立才算;點到連結、有選取文字時照 PDF 原本的行為)
struct PDFKitView: UIViewRepresentable {
    let data: Data
    var onTap: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> FitPDFView {
        let v = FitPDFView()
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.autoScales = false
        v.document = PDFDocument(data: data)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped))
        tap.delegate = context.coordinator
        v.addGestureRecognizer(tap)
        context.coordinator.tap = tap
        context.coordinator.pdfView = v
        return v
    }

    func updateUIView(_ v: FitPDFView, context: Context) {
        context.coordinator.onTap = onTap
        context.coordinator.waitForDoubleTaps()
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var pdfView: PDFView?
        weak var tap: UITapGestureRecognizer?
        var onTap: () -> Void = {}
        private var waited = Set<ObjectIdentifier>()

        @objc func tapped() { onTap() }

        /// PDF 自己的雙擊(放大)要先失敗,單擊才算(PDF 內部的手勢是之後才建的,每次更新都補一次)
        func waitForDoubleTaps() {
            guard let v = pdfView, let tap else { return }
            func walk(_ view: UIView) {
                for g in view.gestureRecognizers ?? [] {
                    if let t = g as? UITapGestureRecognizer, t !== tap, t.numberOfTapsRequired >= 2, waited.insert(ObjectIdentifier(t)).inserted {
                        tap.require(toFail: t)
                    }
                }
                view.subviews.forEach(walk)
            }
            walk(v)
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            waitForDoubleTaps()
            guard let v = pdfView else { return true }
            // 有選取的文字:這一下是取消選取
            if v.currentSelection != nil { return false }
            // 點到連結:照常開連結
            let p = g.location(in: v)
            if let page = v.page(for: p, nearest: false), let a = page.annotation(at: v.convert(p, to: page)),
               a.type == "Link" || a.url != nil || a.action != nil {
                return false
            }
            return true
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

final class FitPDFView: PDFView {
    /// 最寬的那一頁剛好塞滿寬度的縮放(最小只能縮到這裡)
    private var fitScale: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "pdf-view"
        NotificationCenter.default.addObserver(self, selector: #selector(report), name: .PDFViewScaleChanged, object: self)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateFit()
    }

    /// 縮放(最寬的那頁塞滿寬度 = 100%):VoiceOver 和 UI 測試讀這個
    @objc private func report() {
        guard fitScale > 0 else { return }
        accessibilityValue = "縮放 \(Int((scaleFactor / fitScale * 100).rounded()))%"
    }

    private func updateFit() {
        guard let doc = document, doc.pageCount > 0, bounds.width > 1 else { return }
        var widest: CGFloat = 0
        // 很多頁的檔案只看前 500 頁(夠用,也不會卡)
        for i in 0..<min(doc.pageCount, 500) {
            guard let page = doc.page(at: i) else { continue }
            let b = page.bounds(for: displayBox)
            widest = max(widest, page.rotation % 180 == 0 ? b.width : b.height)
        }
        guard widest > 0 else { return }
        let m = pageBreakMargins
        let fit = (bounds.width - safeAreaInsets.left - safeAreaInsets.right - m.left - m.right) / widest
        guard fit > 0, abs(fit - fitScale) > 0.0001 else { return }
        // 原本就是塞滿寬度(或還沒設過):畫面變寬變窄(轉向、拖格子、全螢幕)後還是塞滿
        let wasFit = fitScale == 0 || scaleFactor <= fitScale + 0.0001
        fitScale = fit
        minScaleFactor = fit
        maxScaleFactor = max(fit * 8, 4)
        if wasFit || scaleFactor < fit { scaleFactor = fit }
        report()
    }
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

/// Office 檔的歷史版本:每次從 Office 存檔前留下的舊版本(最近 20 版、30 天內),可以預覽、還原(跟網頁一樣)
struct OfficeHistoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project
    let path: String
    let onRestored: () -> Void
    @State private var info: OfficeInfo?
    @State private var error: String?
    @State private var busy: String?
    @State private var restoring: OfficeVersion?
    @State private var preview: URL?

    private var name: String { (path as NSString).lastPathComponent }

    var body: some View {
        NavigationStack {
            List {
                if info?.editing == true {
                    Section {
                        Label("這個檔案正在電腦的 Office 編輯中\(info?.owner.map { "(\($0))" } ?? "")", systemImage: "pencil.circle")
                            .foregroundStyle(.orange)
                    }
                }
                Section {
                    ForEach(info?.versions ?? []) { v in
                        Button { Task { await open(v) } } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Self.time(v.at)).foregroundStyle(.primary)
                                    if let size = v.size {
                                        Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if busy == v.id { ProgressView() } else { Image(systemName: "eye").foregroundStyle(.secondary) }
                            }
                        }
                        .swipeActions { Button("還原") { restoring = v }.tint(.orange) }
                        .contextMenu {
                            Button { Task { await open(v) } } label: { Label("預覽", systemImage: "eye") }
                            Button { restoring = v } label: { Label("還原成這個版本", systemImage: "clock.arrow.circlepath") }
                        }
                    }
                } footer: {
                    if let vs = info?.versions {
                        Text(vs.isEmpty ? "還沒有歷史版本。從電腦的 Office 存檔之後,每次存檔前的版本會留在這裡。" : "每次從 Office 存檔前會留下舊版本(最近 20 版、30 天內)。點一下預覽;左滑或長按可以還原,還原時目前的版本也會先留一份。")
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .listStyle(.insetGrouped)
            .overlay { if info == nil && error == nil { ProgressView() } }
            .navigationTitle("歷史版本 · \(name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
            .refreshable { await load() }
            .quickLookPreview($preview)
            .confirmationDialog("還原這個版本?", isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }), titleVisibility: .visible, presenting: restoring) { v in
                Button("還原") { Task { await restore(v) } }
            } message: { v in
                Text("把「\(name)」還原成 \(Self.time(v.at)) 的版本?目前的版本會先留一份在歷史版本裡。\(info?.editing == true ? "\n注意:這個檔案正在 Office 編輯中,還原後請在 Office 重新打開,否則 Office 存檔時會蓋掉還原的內容。" : "")")
            }
        }
    }

    static func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.year().month().day().hour().minute())
    }

    private func load() async {
        do {
            info = try await model.api?.officeInfo(project: project.id, path: path)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// 用 Quick Look 預覽舊版本(副檔名要對,Quick Look 才認得)
    private func open(_ v: OfficeVersion) async {
        guard let api = model.api else { return }
        busy = v.id
        defer { busy = nil }
        do {
            let d = try await api.officeVersion(project: project.id, path: path, id: v.id)
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            let stamp = Date(timeIntervalSince1970: v.at / 1000).formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).timeSeparator(.omitted))
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(base)(\(stamp)).\(ext)")
            try d.write(to: url, options: .atomic)
            preview = url
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func restore(_ v: OfficeVersion) async {
        guard let api = model.api else { return }
        busy = v.id
        defer { busy = nil }
        do {
            try await api.officeRestore(project: project.id, path: path, id: v.id)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onRestored()
            await load()
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

extension View {
    /// 條件成立才套用(例如只有不在格子裡時才設導覽列標題)
    @ViewBuilder
    func `if`<T: View>(_ condition: Bool, _ transform: (Self) -> T) -> some View {
        if condition { transform(self) } else { self }
    }
}
