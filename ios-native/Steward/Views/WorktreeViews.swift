// 分支總覽(原生):程式碼頁 Git 裡列出專案所有 git worktree(Claude Code 開的、管家「開支線」開的、手動 git worktree add 的)
// 每列可以跟它對話、看/改檔案、合併回主線、移除;最上方的黃色提示處理 worktree 被 git 追蹤到的問題。API 見 docs/worktrees-api.md
import SwiftUI

// MARK: - 讀取(管家還沒更新時 Debug 版用示意資料)

enum WorktreeLoader {
    /// demo = 管家還沒有這個 API,顯示的是示意資料
    static func fetch(_ api: API, project: String) async -> (list: WorktreeList?, demo: Bool, error: String?) {
        do {
            return (try await api.worktrees(project: project), false, nil)
        } catch let e as WorktreeError where e.status == 404 {
            #if DEBUG
            return (WorktreeDemo.list, true, nil)
            #else
            return (nil, false, nil)
            #endif
        } catch {
            return (nil, false, error.localizedDescription)
        }
    }
}

/// 規格裡的範例(docs/worktrees-api.md),只在 Debug 版、管家還沒部署新版時出現
enum WorktreeDemo {
    static let list: WorktreeList? = {
        let now = ISO8601DateFormatter().string(from: .now)
        let json = """
        {"repo":true,"repoRoot":"/demo/course","prefix":"hw1","target":"main","items":[
         {"id":"0000000000","path":"/demo/course","cwd":"/demo/course/hw1","exists":true,"source":"main","branch":"main","ahead":0,"behind":0,"dirty":0,"changed":0,"relevant":true,"lastModified":"\(now)"},
         {"id":"a1b2c3d4e5","path":"/demo/course/.claude/worktrees/hw1-extra","cwd":"/demo/course/.claude/worktrees/hw1-extra/hw1","exists":true,"source":"claude","branch":"worktree-hw1-extra","locked":"claude session hw1-extra","ahead":1,"behind":0,"dirty":5,"changed":2,"relevant":true,"lastModified":"\(now)","nested":true,"ignored":false,
          "session":{"agent":"claude","via":"claude-transcript","pane":{"paneId":"w3:p2","tabId":"w3:t2","workspaceId":"w3","agentStatus":"idle"},"alive":true}},
         {"id":"b2f18a42c0","path":"/demo/.agent-steward/worktrees/course-fix","cwd":"/demo/.agent-steward/worktrees/course-fix/hw1","exists":true,"source":"steward","branch":"steward/fix","ahead":2,"behind":1,"dirty":0,"changed":3,"relevant":true,"lastModified":"2026-10-30T10:00:00.000Z",
          "session":{"agent":"codex","via":"steward-branch","alive":false},"stewardBranchId":"b2f18a42"},
         {"id":"c3d4e5f6a7","path":"/demo/course-hw2","exists":true,"source":"manual","branch":"hw2-try","ahead":0,"behind":4,"dirty":0,"changed":0,"relevant":false,"lastModified":"2026-10-20T10:00:00.000Z"}
        ],"warnings":{"unignored":[{"id":"a1b2c3d4e5","path":"/demo/course/.claude/worktrees/hw1-extra","pattern":".claude/worktrees/"}],"gitlinks":[".claude/worktrees/hw1-extra"]}}
        """
        return try? JSONDecoder().decode(WorktreeList.self, from: Data(json.utf8))
    }()
}

// MARK: - 程式碼頁 Git 裡的「分支」區塊

/// 分支區塊的狀態和動作:區塊畫在清單裡,視窗(合併、移除確認)掛在整個清單上(掛在清單的 Section 上不一定跳得出來)
@Observable @MainActor
final class WorktreeController {
    var list: WorktreeList?
    /// 管家還沒有這個 API,顯示的是示意資料
    var demo = false
    /// 樹狀圖(資料夾樹 + 分岔圖);管家還沒有就 nil(退回平列表),Debug 版用示意資料(treeDemo)
    var tree: WorktreeTree?
    var treeDemo = false
    var info: String?
    var error: String?
    /// 正在處理的 worktree id,或 "ignore" / "untrack"
    var busy: String?
    var merging: Worktree?
    var removing: Worktree?
    /// 管家回 409:這一項(alive / locked / dirty)要使用者同意;confirm 是已經同意的
    var removeAsk: RemoveAsk?
    var fixing: Fix?
    var note: String?

    struct RemoveAsk: Identifiable {
        var worktree: Worktree
        var confirm: Set<String>
        var item: String
        var message: String
        var id: String { "\(worktree.id):\(item)" }
    }
    enum Fix: String, Identifiable { case ignore, untrack; var id: String { rawValue } }

    func load(_ model: AppModel, _ project: Project) async {
        guard let api = model.api else { return }
        let r = await WorktreeLoader.fetch(api, project: project.id)
        list = r.list
        demo = r.demo
        error = r.error.map { "讀不到分支總覽:\($0)" }
        guard r.list?.repo == true, !r.demo else { tree = r.demo ? WorktreeTreeDemo.tree : nil; treeDemo = r.demo; return }
        do {
            tree = try await api.worktreeTree(project: project.id)
            treeDemo = false
        } catch let e as WorktreeError where e.status == 404 {
            #if DEBUG
            tree = WorktreeTreeDemo.tree
            treeDemo = true
            #else
            tree = nil
            #endif
        } catch {
            tree = nil
        }
    }

    /// 示意資料裡的 worktree(真的管家上沒有):動作只提示,不送出去
    func fake(_ w: Worktree) -> Bool {
        demo || (treeDemo && !(list?.items?.contains { $0.id == w.id } ?? false))
    }

    var patterns: String {
        Set((list?.warnings?.unignored ?? []).map { $0.pattern ?? $0.path }).sorted().joined(separator: "、")
    }
    var gitlinks: String { (list?.warnings?.gitlinks ?? []).joined(separator: "、") }

    /// 窗格開著就跳過去;關了就在同 space 開新 tab 接回對話;對不到就在 worktree 資料夾開新 agent。管家會在 herdr 切過去,app 跟著切到終端機
    func chat(_ w: Worktree, _ model: AppModel, _ project: Project) async {
        if fake(w) { info = "示意資料:管家更新後會跳到 \(w.session?.pane?.paneId ?? "新的 tab")"; return }
        guard let api = model.api else { return }
        busy = w.id
        defer { busy = nil }
        do {
            let r = try await api.worktreeChat(project: project.id, id: w.id)
            error = nil
            switch r.kind {
            case "focus": info = "已在 herdr 跳到 \(r.paneId ?? "窗格")"
            case "resume": info = "已在新 tab「\(r.label ?? "")」接回原本的對話"
            default: info = "已在 worktree 裡開新的 \(r.agent ?? "agent")(找不到原本的對話)"
            }
            if let n = r.note, !n.isEmpty { note = n }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // 新 tab 開在這個專案的 space,切到終端機就看得到;跳到的舊窗格可能在別的 space,切過去網頁會把 herdr 拉回專案的 space,所以不切
            if r.kind != "focus" { model.mode = .terminal }
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// 程式碼頁切到 worktree 資料夾(nil = 回主資料夾)
    func browse(_ w: Worktree?, _ model: AppModel) {
        if let w, fake(w) { info = "示意資料:管家更新前讀不到這個 worktree 的檔案"; return }
        model.codeWorktree = w.map { CodeWorktree(id: $0.id, branch: $0.branch, cwd: $0.cwd ?? $0.path) }
        model.codeSection = "files"
    }

    func remove(_ w: Worktree, confirm: Set<String>, _ model: AppModel, _ project: Project) async {
        if fake(w) { info = "示意資料:管家更新後才能移除"; return }
        guard let api = model.api else { return }
        busy = w.id
        defer { busy = nil }
        do {
            try await api.worktreeRemove(project: project.id, id: w.id, confirm: confirm)
            info = "已移除 \(w.branch ?? "worktree") 的資料夾,分支保留"
            error = nil
            if model.codeWorktree?.id == w.id { model.codeWorktree = nil }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch let e as WorktreeError where e.status == 409 && ["alive", "locked", "dirty"].contains(e.code ?? "") && !confirm.contains(e.code ?? "") {
            removeAsk = RemoveAsk(worktree: w, confirm: confirm, item: e.code ?? "", message: e.message)
            return
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        await load(model, project)
    }

    func apply(_ fix: Fix, _ model: AppModel, _ project: Project) async {
        if demo { info = "示意資料:管家更新後才能修"; return }
        guard let api = model.api else { return }
        busy = fix.rawValue
        defer { busy = nil }
        do {
            switch fix {
            case .ignore:
                let r = try await api.worktreeIgnore(project: project.id)
                info = r.added.isEmpty ? "已經在 .gitignore 裡了" : "已把 \(r.added.joined(separator: "、")) 加進 \(r.file ?? ".gitignore")"
            case .untrack:
                if let n = try await api.worktreeUntrack(project: project.id) { note = n }
                info = "已從版本控制移除(在暫存區,還沒提交)"
            }
            error = nil
            model.code.gitChanged += 1
        } catch {
            self.error = error.localizedDescription
        }
        await load(model, project)
    }
}

/// 程式碼頁 Git 裡的「分支」區塊(黃色提示 + 清單)
struct WorktreeSection: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let ctl: WorktreeController
    /// 資料夾樹 tree / 分岔圖 graph
    @AppStorage("worktreeView") private var view = "tree"
    /// 展開的資料夾;nil = 還沒動過(只展開目前專案的資料夾)
    @State private var expanded: Set<String>?

    var body: some View {
        if let l = ctl.list, l.repo {
            let others = l.others
            let relevant = others.filter { $0.relevant != false }
            let unrelated = others.filter { $0.relevant == false }
            if !(l.warnings?.unignored ?? []).isEmpty { banner(.ignore) }
            if !(l.warnings?.gitlinks ?? []).isEmpty { banner(.untrack) }
            Section {
                if let error = ctl.error { Text(error).font(.footnote).foregroundStyle(.red) }
                if let t = ctl.tree, t.repo {
                    Picker("檢視", selection: $view) {
                        Text("資料夾樹").tag("tree")
                        Text("分岔圖").tag("graph")
                    }
                    .pickerStyle(.segmented)
                    if view == "graph" {
                        WorktreeGraphView(tree: t) { w in actions(w) }
                            .listRowInsets(EdgeInsets())
                    } else {
                        folderTree(t)
                    }
                } else {
                    if let main = l.items?.first(where: { $0.source == "main" }) { row(main, l.target) }
                    if others.isEmpty { Text("只有主資料夾,沒有其他 worktree。").font(.subheadline).foregroundStyle(.secondary) }
                    ForEach(relevant) { row($0, l.target) }
                    if !unrelated.isEmpty {
                        DisclosureGroup("同 repo 的其他 worktree(\(unrelated.count))") {
                            ForEach(unrelated) { row($0, l.target) }
                        }
                    }
                }
            } header: {
                HStack {
                    Text("分支(\(ctl.tree?.others.count ?? relevant.count))")
                    if let name = ctl.tree?.repoName { Text("· \(name)").textCase(nil) }
                    if ctl.demo || ctl.treeDemo { Text("示意資料").font(.caption2).foregroundStyle(.orange).textCase(nil) }
                }
            } footer: {
                if let info = ctl.info { Text(info) } else if !others.isEmpty { Text("點一下看所有動作;左滑合併或移除,右滑跟它對話。") }
            }
        } else if let error = ctl.error {
            Section("分支") { Text(error).font(.footnote).foregroundStyle(.red) }
        }
    }

    /// 最上方的黃色防呆提示,使用者按了才動
    private func banner(_ fix: WorktreeController.Fix) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text(fix == .ignore
                         ? "worktree 資料夾放在專案裡,但沒被 .gitignore 排除(\(ctl.patterns)),「全部加入」時會被一起加進去。"
                         : "\(ctl.gitlinks) 已經被 commit 成子專案,git 會把它當成另一個 repo。")
                        .font(.subheadline)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
                }
                Button {
                    ctl.fixing = fix
                } label: {
                    if ctl.busy == fix.rawValue { ProgressView() } else { Text(fix == .ignore ? "加入 .gitignore" : "從版本控制移除") }
                }
                .buttonStyle(.bordered)
                .tint(.orange)
                .disabled(ctl.busy != nil)
            }
            .padding(.vertical, 2)
        }
        .listRowBackground(Color.yellow.opacity(0.15))
    }

    /// 資料夾樹:repo(主資料夾)→ 作業資料夾 → 歸在那裡的 worktree 與留下的分支;歸不到的放「其他」
    @ViewBuilder
    private func folderTree(_ t: WorktreeTree) -> some View {
        if let main = t.items?.first(where: { $0.source == "main" }) ?? ctl.list?.items?.first(where: { $0.source == "main" }) {
            row(main, t.target)
        }
        ForEach(t.folders ?? []) { f in
            folder(t, path: f.path, name: f.name ?? f.path, current: f.current == true)
        }
        if !t.items(in: "").isEmpty || !t.leftovers(in: "").isEmpty {
            folder(t, path: "", name: "其他", current: false)
        }
    }

    private func folder(_ t: WorktreeTree, path: String, name: String, current: Bool) -> some View {
        let items = t.items(in: path)
        let leftovers = t.leftovers(in: path)
        let open = Binding(
            get: { (expanded ?? defaultExpanded(t)).contains(path) },
            set: { on in
                var s = expanded ?? defaultExpanded(t)
                if on { s.insert(path) } else { s.remove(path) }
                expanded = s
            })
        return DisclosureGroup(isExpanded: open) {
            ForEach(items) { row($0, t.target) }
            ForEach(leftovers) { WorktreeLeftoverRow(leftover: $0, target: t.target) }
            if items.isEmpty && leftovers.isEmpty { Text("沒有分支").font(.subheadline).foregroundStyle(.secondary) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: path.isEmpty ? "tray" : "folder").foregroundStyle(.secondary)
                Text(name).lineLimit(1)
                if current { Text("目前專案").font(.caption2.bold()).foregroundStyle(Theme.accent) }
                Spacer(minLength: 4)
                if !open.wrappedValue {
                    let n = t.count(in: path)
                    if n > 0 { Text("\(n)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private func defaultExpanded(_ t: WorktreeTree) -> Set<String> {
        Set((t.folders ?? []).filter { $0.current == true }.map(\.path) + [t.currentFolder].compactMap { $0 })
    }

    private func row(_ w: Worktree, _ target: String?) -> some View {
        let isMain = w.source == "main"
        let viewing = isMain ? model.codeWorktree == nil : model.codeWorktree?.id == w.id
        return Menu {
            actions(w)
        } label: {
            WorktreeRow(worktree: w, target: target, viewing: viewing, busy: ctl.busy == w.id)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if !isMain && !w.isMissing {
                Button(role: .destructive) { ctl.removing = w } label: { Label("移除", systemImage: "trash") }
                Button { ctl.merging = w } label: { Label("合併", systemImage: "arrow.triangle.merge") }.tint(.green)
            }
        }
        .swipeActions(edge: .leading) {
            if !isMain && !w.isMissing {
                Button { Task { await ctl.chat(w, model, project) } } label: { Label("對話", systemImage: "bubble.left.and.bubble.right") }.tint(Theme.accent)
            }
        }
    }

    @ViewBuilder
    private func actions(_ w: Worktree) -> some View {
        if w.source == "main" {
            Button { ctl.browse(nil, model) } label: { Label("看/改主資料夾的檔案", systemImage: "folder") }
        } else if w.isMissing {
            Text("資料夾已經不在了")
        } else {
            Button { Task { await ctl.chat(w, model, project) } } label: { Label("跟它對話", systemImage: "bubble.left.and.bubble.right") }
            Button { ctl.browse(w, model) } label: { Label("看/改檔案", systemImage: "folder") }
            Button { ctl.merging = w } label: { Label("合併回主線…", systemImage: "arrow.triangle.merge") }
                .disabled(w.branch == nil)
            Divider()
            Button(role: .destructive) { ctl.removing = w } label: { Label("移除…", systemImage: "trash") }
        }
    }
}

/// 分支區塊的視窗:掛在整個 Git 清單上
struct WorktreeDialogs: ViewModifier {
    @Environment(AppModel.self) private var model
    let project: Project
    @Bindable var ctl: WorktreeController

    func body(content: Content) -> some View {
        content
            .sheet(item: $ctl.merging) { w in
                let target = ctl.list?.target ?? "主線"
                WorktreeMergeSheet(project: project, worktree: w, target: target, demo: ctl.fake(w)) { commit, removeAfter in
                    ctl.info = "已把 \(w.branch ?? "") 合併進 \(target)" + (commit.map { "(\($0))" } ?? "")
                    model.code.gitChanged += 1
                    Task { if removeAfter { await ctl.remove(w, confirm: [], model, project) } else { await ctl.load(model, project) } }
                }
            }
            .confirmationDialog(ctl.removing.map { "移除 \($0.branch ?? "這個 worktree") 的資料夾?" } ?? "", isPresented: Binding(get: { ctl.removing != nil }, set: { if !$0 { ctl.removing = nil } }), titleVisibility: .visible, presenting: ctl.removing) { w in
                Button("移除資料夾", role: .destructive) { Task { await ctl.remove(w, confirm: [], model, project) } }
            } message: { w in
                Text("只刪資料夾,分支 \(w.branch ?? "") 會保留,之後還能再開回來。" + ((w.dirty ?? 0) > 0 ? "\n⚠️ 裡面有 \(w.dirty ?? 0) 個沒 commit 的改動。" : ""))
            }
            .alert("還要移除嗎?", isPresented: Binding(get: { ctl.removeAsk != nil }, set: { if !$0 { ctl.removeAsk = nil } }), presenting: ctl.removeAsk) { ask in
                Button("仍然移除", role: .destructive) { Task { await ctl.remove(ask.worktree, confirm: ask.confirm.union([ask.item]), model, project) } }
                Button("取消", role: .cancel) {}
            } message: { ask in
                Text(ask.message)
            }
            .confirmationDialog(ctl.fixing == .ignore ? "把 worktree 資料夾加入 .gitignore?" : "把 worktree 從版本控制移除?", isPresented: Binding(get: { ctl.fixing != nil }, set: { if !$0 { ctl.fixing = nil } }), titleVisibility: .visible, presenting: ctl.fixing) { fix in
                Button(fix == .ignore ? "加入 .gitignore" : "從版本控制移除") { Task { await ctl.apply(fix, model, project) } }
            } message: { fix in
                Text(fix == .ignore
                     ? "會在 .gitignore 加上 \(ctl.patterns),之後「全部加入」就不會把 worktree 資料夾一起加進去。"
                     : "會執行 git rm --cached \(ctl.gitlinks):只從版本控制拿掉,資料夾和檔案都不動。只放進暫存區,還要你自己提交。")
            }
            .alert("提醒", isPresented: Binding(get: { ctl.note != nil }, set: { if !$0 { ctl.note = nil } })) {
                Button("好") {}
            } message: {
                Text(ctl.note ?? "")
            }
    }
}


struct WorktreeRow: View {
    let worktree: Worktree
    let target: String?
    var viewing = false
    var busy = false

    var body: some View {
        let w = worktree
        let main = target ?? "主線"
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: w.source == "main" ? "house" : "arrow.triangle.branch").foregroundStyle(.secondary).font(.caption)
                Text(w.branch ?? "(沒有分支)").font(.subheadline.weight(.semibold)).lineLimit(1)
                if viewing { Text("正在看").font(.caption2.bold()).foregroundStyle(Theme.accent) }
                Spacer(minLength: 4)
                if busy { ProgressView().controlSize(.small) }
                HStack(spacing: 3) {
                    Image(systemName: w.sourceIcon)
                    Text(w.sourceLabel)
                }
                .font(.caption2)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Color(.tertiarySystemFill), in: Capsule())
            }
            if w.isMissing {
                Label("資料夾已經不在了", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            } else if w.source != "main" {
                HStack(spacing: 10) {
                    Text(aheadText(w, main))
                    if let d = w.dirty, d > 0 {
                        HStack(spacing: 3) {
                            Circle().fill(.orange).frame(width: 6, height: 6)
                            Text("\(d) 個沒 commit")
                        }
                    }
                    Text(Fmt.ago(Fmt.date(w.lastModified)))
                }
                .font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    if let s = w.session {
                        Text(s.agent ?? "agent")
                        if let p = s.pane { Text("·"); Text(p.paneId) }
                        Text(s.alive == true ? "開著" : "已關").foregroundStyle(s.alive == true ? .green : .secondary)
                    } else {
                        Text("開它的 agent:不明")
                    }
                    if w.locked != nil { Image(systemName: "lock.fill").accessibilityLabel("已鎖定") }
                }
                .font(.caption).foregroundStyle(.tertiary)
            }
            Text(w.path).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func aheadText(_ w: Worktree, _ main: String) -> String {
        let a = w.ahead ?? 0, b = w.behind ?? 0
        if a == 0 && b == 0 { return "跟 \(main) 一樣" }
        return [a > 0 ? "領先 \(main) \(a)" : nil, b > 0 ? "落後 \(b)" : nil].compactMap { $0 }.joined(separator: "、")
    }
}

// MARK: - 合併回主線

/// 先看要合進來的東西,確認才合併(git merge --no-ff);主線髒或衝突就停下來說明;成功後問要不要移除資料夾(預設不勾)
struct WorktreeMergeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let project: Project
    let worktree: Worktree
    let target: String
    var demo = false
    let onMerged: (_ commit: String?, _ removeAfter: Bool) -> Void
    @State private var preview: WorktreeMergePreview?
    @State private var error: String?
    @State private var merging = false
    /// 合併成功:外層 some 表示已合併,裡面是新的 commit(可能沒有)
    @State private var merged: String??
    @State private var removeAfter = false

    var body: some View {
        NavigationStack {
            List {
                if let error { Section { Label(error, systemImage: "hand.raised.fill").foregroundStyle(.orange) } }
                if let commit = merged {
                    Section {
                        Label("已把 \(worktree.branch ?? "") 合併進 \(target)" + (commit.map { "(\($0))" } ?? ""), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Toggle("一併移除這個 worktree", isOn: $removeAfter)
                    } footer: {
                        Text("只刪資料夾,分支保留。")
                    }
                } else if let p = preview {
                    if let blocker = p.blocker {
                        Section("先停下來") { Label(blocker, systemImage: "hand.raised.fill").foregroundStyle(.orange) }
                    }
                    if let u = p.uncommitted, u > 0 {
                        Section { Label("worktree 裡還有 \(u) 個沒 commit 的改動,不會一起合併。", systemImage: "exclamationmark.triangle").font(.subheadline) }
                    }
                    Section("要合進 \(p.target ?? target) 的提交(\(p.commits.count))") {
                        if p.commits.isEmpty { Text("沒有新的提交,不用合併。").foregroundStyle(.secondary) }
                        ForEach(p.commits) { c in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.subject ?? "").lineLimit(2)
                                Text(c.hash).font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if !p.files.isEmpty {
                        Section {
                            ForEach(p.files) { f in
                                GitFileRow(file: GitFile(path: f.path, code: String(f.status.prefix(1))))
                            }
                            if let d = p.diff, !d.isEmpty {
                                NavigationLink { WorktreeDiffView(diff: d, title: worktree.branch ?? "差異") } label: { Label("看完整差異", systemImage: "plus.forwardslash.minus") }
                            }
                        } header: {
                            Text("改到的檔案(\(p.files.count))")
                        } footer: {
                            if let s = p.stat?.split(separator: "\n").last { Text(String(s).trimmingCharacters(in: .whitespaces)) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .overlay { if preview == nil && error == nil { ProgressView() } }
            .navigationTitle("合併 \(worktree.branch ?? "")")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let commit = merged {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成") { onMerged(commit, removeAfter); dismiss() }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        if merging { ProgressView() } else {
                            Button("合併") { Task { await merge() } }
                                .disabled(preview == nil || preview?.blocker != nil || (preview?.commits.isEmpty ?? true))
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if merged == nil {
                    Text("會在主資料夾執行 git merge --no-ff \(worktree.branch ?? "")。有衝突會自動取消,主資料夾不變。")
                        .font(.caption).foregroundStyle(.secondary).padding(8).frame(maxWidth: .infinity).background(.bar)
                }
            }
            .task { await load() }
        }
        .interactiveDismissDisabled(merged != nil || merging)
    }

    private func load() async {
        if demo {
            preview = WorktreeMergePreview(target: target, branch: worktree.branch, commits: [.init(hash: "34f3aef", subject: "示意:加上第二題的推導")],
                                           files: [.init(status: "M", path: "hw1/main.tex")], stat: " 1 file changed, 12 insertions(+)",
                                           diff: "diff --git a/hw1/main.tex b/hw1/main.tex\n@@ -1,3 +1,4 @@\n \\section{Q2}\n-舊的推導\n+新的推導\n+補上一步\n", blocker: nil, uncommitted: worktree.dirty)
            return
        }
        guard let api = model.api else { return }
        do { preview = try await api.worktreeMergePreview(project: project.id, id: worktree.id) } catch { self.error = error.localizedDescription }
    }

    private func merge() async {
        if demo { error = "示意資料:管家更新後才能合併"; return }
        guard let api = model.api else { return }
        merging = true
        defer { merging = false }
        do {
            merged = .some(try await api.worktreeMerge(project: project.id, id: worktree.id))
            error = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            // 409 main-dirty / conflict(已自動取消)、400 nothing:直接顯示管家的說明
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

/// 合併預覽的完整差異(git diff 的文字)
struct WorktreeDiffView: View {
    let diff: String
    let title: String

    var body: some View {
        let lines = diff.components(separatedBy: "\n")
        let rows = lines.enumerated().map { i, l -> DiffRow in
            let kind: DiffRow.Kind
            if l.hasPrefix("diff --git") || l.hasPrefix("@@") || l.hasPrefix("index ") || l.hasPrefix("+++") || l.hasPrefix("---") { kind = .skipped }
            else if l.hasPrefix("+") { kind = .added }
            else if l.hasPrefix("-") { kind = .removed }
            else { kind = .same }
            let text = kind == .skipped ? l : String(l.dropFirst())
            return DiffRow(id: i, kind: kind, oldNo: nil, newNo: nil, text: text)
        }
        DiffText(rows: rows)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - 程式碼頁上方:正在看 worktree

struct WorktreeViewingBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let w = model.codeWorktree {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                Text("正在看 worktree:\(w.branch ?? w.id)").lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Button("回主資料夾") { model.codeWorktree = nil }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
            .font(.subheadline)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Color.yellow.opacity(0.25))
        }
    }
}

// MARK: - 專案欄的徽章

/// 專案名旁邊的「⑂N」:主資料夾以外的 worktree 數
struct WorktreeBadge: View {
    @Environment(AppModel.self) private var model
    let project: Project

    var body: some View {
        let n = model.worktreeCounts[project.id] ?? 0
        if n > 0 {
            Text("⑂\(n)")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
                .accessibilityLabel("\(n) 個 worktree")
        }
    }
}
