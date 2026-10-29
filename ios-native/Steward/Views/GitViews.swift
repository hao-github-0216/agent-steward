// 版本控制(原生):內容跟網頁程式碼頁的 Git 一樣,元件用 Apple 的清單、左滑、確認視窗
import SwiftUI

struct GitView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var status: GitStatus?
    @State private var branches: [GitBranch] = []
    @State private var error: String?
    @State private var info: String?
    @State private var message = ""
    @State private var busy: String?
    @State private var discarding: [String]?
    @State private var newBranch: String?

    var body: some View {
        List {
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            if let s = status, !s.repo {
                ContentUnavailableView("不是 git repo", systemImage: "arrow.triangle.branch", description: Text("這個專案的資料夾還沒有用 git 管理。"))
            } else if let s = status {
                header(s)
                commitSection(s)
                files("衝突", s.conflicted, which: "unstaged")
                files("已暫存", s.staged, which: "staged")
                files("變更", s.unstaged, which: "unstaged")
                files("新檔案", s.untracked, which: "untracked")
                Section {
                    NavigationLink(value: CodeRoute.history) { Label("最近的提交", systemImage: "clock.arrow.circlepath") }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if status == nil && error == nil { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: model.uploads.refresh) { Task { await load() } }
        .onChange(of: model.code.gitChanged) { Task { await load() } }
        .confirmationDialog(discarding.map { $0.count > 1 ? "捨棄 \($0.count) 個檔案的變更?" : "捨棄這些變更?" } ?? "", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible) {
            Button("捨棄", role: .destructive) { if let paths = discarding { Task { await run("discard", ["paths": paths]) } } }
        } message: {
            Text("改過的檔案會還原成上次提交的內容;新檔案會移到電腦的垃圾桶(救得回來)。")
        }
        .alert("建立新分支", isPresented: Binding(get: { newBranch != nil }, set: { if !$0 { newBranch = nil } })) {
            TextField("分支名稱", text: Binding(get: { newBranch ?? "" }, set: { newBranch = $0 }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("建立並切換") {
                let name = (newBranch ?? "").trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { Task { await run("checkout", ["branch": name, "create": true], done: "已建立並切換到 \(name)") } }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("從目前的分支開一個新分支,然後切過去。")
        }
    }

    /// 分支、領先/落後、拉取/推送/抓取
    private func header(_ s: GitStatus) -> some View {
        Section {
            HStack {
                Menu {
                    ForEach(branches.filter { $0.remote != true }) { b in
                        Button { Task { await run("checkout", ["branch": b.name]) } } label: {
                            if b.current { Label(b.name, systemImage: "checkmark") } else { Text(b.name) }
                        }
                        .disabled(b.current)
                    }
                    Divider()
                    Button { newBranch = "" } label: { Label("建立新分支…", systemImage: "plus") }
                } label: {
                    Label(s.branch ?? "(沒有分支)", systemImage: "arrow.triangle.branch").font(.headline)
                }
                Spacer()
                if let a = s.ahead, a > 0 { Label("\(a)", systemImage: "arrow.up").font(.caption).foregroundStyle(.secondary).accessibilityLabel("領先 \(a) 個提交") }
                if let b = s.behind, b > 0 { Label("\(b)", systemImage: "arrow.down").font(.caption).foregroundStyle(.secondary).accessibilityLabel("落後 \(b) 個提交") }
            }
            HStack(spacing: 8) {
                gitButton("拉取", "pull", "arrow.down.circle")
                gitButton("推送", "push", "arrow.up.circle")
                gitButton("抓取", "fetch", "arrow.triangle.2.circlepath")
            }
            .buttonStyle(.bordered)
        } footer: {
            if let info { Text(info) } else if let up = s.upstream { Text("追蹤 \(up)") }
        }
    }

    private func gitButton(_ title: String, _ action: String, _ icon: String) -> some View {
        Button {
            Task { await run(action, [:], done: "\(title)完成") }
        } label: {
            if busy == action { ProgressView().frame(maxWidth: .infinity) } else { Label(title, systemImage: icon).frame(maxWidth: .infinity) }
        }
        .disabled(busy != nil)
    }

    /// 提交訊息 + 產生 + 提交
    private func commitSection(_ s: GitStatus) -> some View {
        let stagedCount = s.staged?.count ?? 0
        return Section {
            TextField("提交訊息", text: $message, axis: .vertical)
                .lineLimit(2...6)
            HStack {
                Button {
                    Task { await generate() }
                } label: {
                    if busy == "commitmsg" { ProgressView() } else { Label("產生", systemImage: "sparkles") }
                }
                .buttonStyle(.bordered)
                .disabled(busy != nil || (stagedCount + (s.unstaged?.count ?? 0) + (s.untracked?.count ?? 0)) == 0)
                Spacer()
                Button {
                    Task { if await run("commit", ["message": message], done: "已提交") { message = "" } }
                } label: {
                    if busy == "commit" { ProgressView() } else { Text(stagedCount > 0 ? "提交(\(stagedCount) 個檔案)" : "提交") }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy != nil || stagedCount == 0 || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        } header: {
            Text("提交")
        } footer: {
            if stagedCount == 0 { Text("先把要提交的檔案暫存(在變更清單左滑「暫存」)。") }
        }
    }

    @ViewBuilder
    private func files(_ title: String, _ list: [GitFile]?, which: String) -> some View {
        if let list, !list.isEmpty {
            Section {
                ForEach(list) { f in
                    DiffOpenRow(tab: .diff(f.path, which: which)) {
                        GitFileRow(file: f, untracked: which == "untracked")
                    }
                    .swipeActions(edge: .trailing) {
                        if which == "staged" {
                            Button { Task { await run("unstage", ["paths": [f.path]]) } } label: { Label("取消暫存", systemImage: "minus.circle") }.tint(.orange)
                        } else {
                            Button(role: .destructive) { discarding = [f.path] } label: { Label("捨棄", systemImage: "arrow.uturn.backward") }
                            Button { Task { await run("stage", ["paths": [f.path]]) } } label: { Label("暫存", systemImage: "plus.circle") }.tint(.green)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("\(title)(\(list.count))")
                    Spacer()
                    if which == "staged" {
                        Button("全部取消暫存") { Task { await run("unstage", ["all": true]) } }.font(.caption).textCase(nil)
                    } else if title != "衝突" {
                        Button("全部捨棄") { discarding = list.map(\.path) }.font(.caption).textCase(nil).tint(.red)
                        Button("全部暫存") { Task { await run("stage", ["paths": list.map(\.path)]) } }.font(.caption).textCase(nil)
                    }
                }
            } footer: {
                if title == "衝突" { Text("合併衝突請到終端機處理。") }
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            status = try await api.gitStatus(project: project.id)
            if status?.repo == true { branches = (try? await api.gitBranches(project: project.id)) ?? [] }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    @discardableResult
    private func run(_ action: String, _ body: [String: Any], done: String? = nil) async -> Bool {
        guard let api = model.api else { return false }
        busy = action
        defer { busy = nil }
        var ok = false
        do {
            try await api.git(project.id, action, body)
            info = done
            error = nil
            ok = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        await load()
        return ok
    }

    /// 請管家依變更寫提交訊息
    private func generate() async {
        guard let api = model.api else { return }
        busy = "commitmsg"
        defer { busy = nil }
        do { message = try await api.commitMessage(project: project.id); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct GitFileRow: View {
    let file: GitFile
    var untracked = false

    var body: some View {
        let code = untracked ? "U" : (file.code ?? "M")
        HStack(spacing: 10) {
            GitMark(code: code).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text((file.path as NSString).lastPathComponent).lineLimit(1)
                let dir = (file.path as NSString).deletingLastPathComponent
                if !dir.isEmpty || file.from != nil {
                    Text((file.from.map { "\($0) → " } ?? "") + dir).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 差異

/// 清單裡一個有變更的檔案:點了打開差異分頁(iPhone 推進編輯畫面、iPad 開在目前那一格);iPad 上可以拖到編輯區
struct DiffOpenRow<RowLabel: View>: View {
    @Environment(AppModel.self) private var model
    let tab: EditorTab
    @ViewBuilder let label: () -> RowLabel

    var body: some View {
        let open = model.code.activeTab?.id == tab.id
        Button { model.openCode(tab) } label: {
            HStack(spacing: 0) {
                label()
                Spacer(minLength: 6)
                if model.compact { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(!model.compact && open ? Theme.accent.opacity(0.14) : nil)
        .if(!model.compact) { $0.draggable(tab) }
        .contextMenu {
            if !model.compact {
                Button { model.openCode(tab, zone: .right) } label: { Label("在右邊打開", systemImage: "rectangle.righthalf.inset.filled") }
                Button { model.openCode(tab, zone: .bottom) } label: { Label("在下面打開", systemImage: "rectangle.bottomhalf.inset.filled") }
            }
            Button { model.openCode(.file(tab.path)) } label: { Label("打開檔案", systemImage: "doc.text") }
        }
    }
}

// MARK: - 差異

struct DiffView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let path: String
    let which: String
    let commit: String?
    /// 這個分頁的 id(暫存/取消暫存後關掉分頁)
    var tabId: String?
    /// 在分割編輯區的格子裡:用格子自己的動作列,不用導覽列
    var embedded = false
    @State private var rows: [DiffRow]?
    @State private var error: String?
    @State private var busy = false

    private var kindLabel: String {
        switch which {
        case "staged": "已暫存的變更"
        case "untracked": "新檔案"
        case "commit": "提交 \((commit ?? "").prefix(7)) 的變更"
        default: "還沒暫存的變更"
        }
    }

    var body: some View {
        Group {
            if let error {
                ContentUnavailableView("讀不到差異", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if let rows {
                if rows.isEmpty {
                    ContentUnavailableView("沒有差異", systemImage: "equal")
                } else {
                    DiffText(rows: rows)
                }
            } else {
                ProgressView()
            }
        }
        .if(!embedded) { $0.navigationTitle((path as NSString).lastPathComponent).navigationBarTitleDisplayMode(.inline) }
        .toolbar {
            if !embedded, commit == nil {
                ToolbarItem(placement: .topBarTrailing) { stageButton }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if embedded {
                HStack(spacing: 12) {
                    Text("\(path) · \(kindLabel)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: 4)
                    if commit == nil { stageButton.font(.subheadline) }
                    Button { model.openCode(.file(path)) } label: { Image(systemName: "doc.text") }
                        .font(.subheadline)
                        .accessibilityLabel("打開檔案")
                }
                .buttonStyle(.borderless)
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(.bar)
                .overlay(alignment: .bottom) { Divider() }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private var stageButton: some View {
        if which == "staged" {
            Button("取消暫存") { Task { await act("unstage") } }.disabled(busy)
        } else {
            Button("暫存") { Task { await act("stage") } }.disabled(busy)
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            let sides = try await api.gitDiff(project: project.id, path: path, which: which, commit: commit)
            rows = DiffRow.unified(old: sides.original, new: sides.modified)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func act(_ action: String) async {
        busy = true
        defer { busy = false }
        do {
            try await model.api?.git(project.id, action, ["paths": [path]])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // 暫存/取消暫存之後這份差異就不在原本的清單了:關掉分頁(iPhone 只剩它就回清單)
            model.code.gitChanged += 1
            if let tabId { model.code.close(tabId) } else if !model.codePath.isEmpty { model.codePath.removeLast() }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// 差異內容:照最長那一行算寬度(清單比螢幕寬,手指才左右拖得動)
struct DiffText: View {
    let rows: [DiffRow]

    var body: some View {
        let font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular)
        let longest = rows.max { $0.text.utf16.count < $1.text.utf16.count }?.text ?? ""
        let textW = (longest as NSString).size(withAttributes: [.font: font]).width
        GeometryReader { geo in
            let w = max(ceil(34 * 2 + 8 * 3 + 12 + textW * 1.05 + 16), geo.size.width)
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { r in DiffLine(row: r).frame(width: w, alignment: .leading) }
                }
                .frame(width: w, alignment: .leading)
                .padding(.vertical, 8)
            }
        }
        .background(Color(.systemBackground))
    }
}

struct DiffRow: Identifiable {
    enum Kind { case same, added, removed, skipped }
    let id: Int
    let kind: Kind
    let oldNo: Int?
    let newNo: Int?
    let text: String

    /// 兩份完整內容 → 統一格式的差異(沒變的段落只留前後 3 行,中間收起來)
    static func unified(old: String, new: String) -> [DiffRow] {
        let a = old.isEmpty ? [] : old.components(separatedBy: "\n")
        let b = new.isEmpty ? [] : new.components(separatedBy: "\n")
        let diff = b.difference(from: a)
        var removed = Set<Int>(), inserted = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }
        var all: [(Kind, Int?, Int?, String)] = []
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i < a.count && removed.contains(i) {
                all.append((.removed, i + 1, nil, a[i])); i += 1
            } else if j < b.count && inserted.contains(j) {
                all.append((.added, nil, j + 1, b[j])); j += 1
            } else if i < a.count && j < b.count {
                all.append((.same, i + 1, j + 1, a[i])); i += 1; j += 1
            } else if i < a.count {
                all.append((.removed, i + 1, nil, a[i])); i += 1
            } else {
                all.append((.added, nil, j + 1, b[j])); j += 1
            }
        }
        guard all.contains(where: { $0.0 != .same }) else { return [] }
        // 只留改動前後 3 行
        var keep = Array(repeating: false, count: all.count)
        for (k, r) in all.enumerated() where r.0 != .same {
            for x in max(0, k - 3)...min(all.count - 1, k + 3) { keep[x] = true }
        }
        var out: [DiffRow] = []
        var hidden = 0
        for (k, r) in all.enumerated() {
            if keep[k] {
                if hidden > 0 { out.append(DiffRow(id: out.count, kind: .skipped, oldNo: nil, newNo: nil, text: "⋯ \(hidden) 行沒變")); hidden = 0 }
                out.append(DiffRow(id: out.count, kind: r.0, oldNo: r.1, newNo: r.2, text: r.3))
            } else {
                hidden += 1
            }
        }
        if hidden > 0 { out.append(DiffRow(id: out.count, kind: .skipped, oldNo: nil, newNo: nil, text: "⋯ \(hidden) 行沒變")) }
        return out
    }
}

struct DiffLine: View {
    let row: DiffRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(row.oldNo.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.tertiary)
            Text(row.newNo.map(String.init) ?? "").frame(width: 34, alignment: .trailing).foregroundStyle(.tertiary)
            Text(sign).foregroundStyle(color)
            Text(row.text.isEmpty ? " " : row.text)
                .foregroundStyle(row.kind == .skipped ? Color.secondary : Color.primary)
                .fixedSize(horizontal: true, vertical: false)
        }
        .font(.system(.caption, design: .monospaced))
        .padding(.horizontal, 8).padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
    }

    private var sign: String {
        switch row.kind {
        case .added: "+"
        case .removed: "−"
        default: " "
        }
    }

    private var color: Color {
        switch row.kind {
        case .added: .green
        case .removed: .red
        default: .secondary
        }
    }

    private var background: Color {
        switch row.kind {
        case .added: Color.green.opacity(0.15)
        case .removed: Color.red.opacity(0.15)
        case .skipped: Color(.secondarySystemBackground)
        case .same: .clear
        }
    }
}

// MARK: - 提交紀錄

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var commits: [GitCommit]?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(commits ?? []) { c in
                NavigationLink(value: CodeRoute.commit(c.hash)) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(c.subject ?? "").lineLimit(2)
                        Text("\(c.short ?? String(c.hash.prefix(7))) · \(c.author ?? "") · \(Fmt.ago(Fmt.date(c.date)))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if commits == nil && error == nil { ProgressView() } }
        .navigationTitle("最近的提交")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { commits = try await model.api?.gitLog(project: project.id) } catch { self.error = error.localizedDescription }
        }
    }
}

struct CommitView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let hash: String
    @State private var detail: GitCommitDetail?
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let d = detail {
                Section {
                    Text(d.body ?? "").textSelection(.enabled)
                    LabeledContent("作者", value: d.author ?? "")
                    LabeledContent("時間", value: Fmt.ago(Fmt.date(d.date)))
                    LabeledContent("提交", value: String(d.hash.prefix(10)))
                }
                Section("改了 \(d.files.count) 個檔案") {
                    ForEach(d.files) { f in
                        DiffOpenRow(tab: .diff(f.path, which: "commit", commit: d.hash)) {
                            GitFileRow(file: f)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if detail == nil && error == nil { ProgressView() } }
        .navigationTitle(String(hash.prefix(7)))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do { detail = try await model.api?.gitShow(project: project.id, commit: hash) } catch { self.error = error.localizedDescription }
        }
    }
}
