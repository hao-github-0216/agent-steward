// 程式碼頁的編輯區版面(跟網頁程式碼頁一樣:欄 → 格 → 分頁)。
//   iPad 寬畫面最多 4 欄 × 每欄 3 格;iPhone(和 iPad 很窄的視窗)只顯示一格,所有分頁排在一起,但不改動版面。
//   每個專案在這台裝置各自記;同一個檔案全場只開一個分頁(已開著就切過去)。
//   編輯中還沒存的內容也記在這裡(切分頁、重開 app 都還在)。
import Foundation
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// 程式碼頁的分頁(拖到別的格子分割、搬動;只在這個 app 裡面用)
    static let stewardTab = UTType(exportedAs: "io.github.haogithub0216.agentsteward.native.tab")
}

/// 一個分頁:檔案或 Git 差異
struct EditorTab: Codable, Hashable, Identifiable, Transferable {
    enum Kind: String, Codable { case file, diff }
    var kind: Kind
    var path: String
    /// 差異:staged | unstaged | untracked | commit
    var which: String?
    var commit: String?

    static func file(_ path: String) -> EditorTab { EditorTab(kind: .file, path: path) }
    static func diff(_ path: String, which: String, commit: String? = nil) -> EditorTab { EditorTab(kind: .diff, path: path, which: which, commit: commit) }

    var id: String { kind == .file ? "file:\(path)" : "diff:\(which ?? "")@\(commit ?? ""):\(path)" }
    var name: String { (path as NSString).lastPathComponent }
    /// 差異分頁的說明(分頁上的小字)
    var detail: String? {
        guard kind == .diff else { return nil }
        switch which {
        case "staged": return "已暫存"
        case "untracked": return "新檔案"
        case "commit": return "提交 \((commit ?? "").prefix(7))"
        default: return "變更"
        }
    }

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .stewardTab)
    }
}

/// 一格:自己的分頁和目前顯示的分頁
struct EditorPane: Codable, Hashable, Identifiable {
    var id = UUID()
    var tabs: [EditorTab] = []
    var active: String?
    /// 在這一欄裡的高度比例
    var size: Double = 1
    var activeTab: EditorTab? { tabs.first { $0.id == active } ?? tabs.first }
}

/// 一欄:由上到下幾格
struct EditorColumn: Codable, Hashable, Identifiable {
    var id = UUID()
    var panes: [EditorPane] = [EditorPane()]
    /// 欄寬比例
    var size: Double = 1
}

struct EditorLayout: Codable, Equatable {
    var columns: [EditorColumn] = [EditorColumn()]
    var activePane: UUID?
}

/// 放到某一格的哪裡:中間 = 加成那一格的分頁;邊緣 = 在那一邊分出新的一格
enum SplitZone: Equatable { case left, right, top, bottom, center }

/// 編輯中還沒存的內容;baseHash 是開始編輯時檔案的指紋(存檔時偵測別人改過)
struct EditorDraft: Codable, Equatable {
    var text: String
    var baseHash: String?
}

@MainActor @Observable
final class CodeWorkspace {
    static let maxColumns = 4, maxRows = 3

    private(set) var projectId: String?
    private(set) var layout = EditorLayout()
    private(set) var drafts: [String: EditorDraft] = [:]
    /// 有沒存修改的分頁(分頁上的小圓點)
    private(set) var dirty: Set<String> = []
    /// 分頁目前顯示的文字(圈選對回行號用)
    @ObservationIgnored var texts: [String: String] = [:]
    /// 每一格在視窗裡的位置(圈選找格子用)
    @ObservationIgnored var paneFrames: [UUID: CGRect] = [:]
    /// Office 檔已經自動用 Quick Look 開過的分頁(切回來不要再自動開)
    @ObservationIgnored var quickLooked: Set<String> = []
    @ObservationIgnored private var draftSave: Task<Void, Never>?

    // MARK: 換專案、存起來

    /// 換到某個專案的版面(這台裝置上次的樣子)
    func use(project: String?) {
        guard project != projectId else { return }
        draftSave?.cancel()
        persistDraftsNow()
        projectId = project
        // 啟動參數 -resetCodeLayout YES(UI 測試用):從空的版面開始
        let reset = UserDefaults.standard.bool(forKey: "resetCodeLayout")
        layout = reset ? EditorLayout() : project.flatMap { Self.load(EditorLayout.self, "codeLayout.\($0)") } ?? EditorLayout()
        drafts = reset ? [:] : project.flatMap { Self.load([String: EditorDraft].self, "codeDrafts.\($0)") } ?? [:]
        dirty = Set(drafts.keys)
        texts = [:]
        paneFrames = [:]
        quickLooked = []
        normalize()
        // 重設:記著的版面和草稿也馬上清掉(不然上一次留下的會在之後不重設的啟動又跑回來)
        if reset { persist(); persistDraftsNow() }
    }

    private static func load<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private func persist() {
        guard let projectId, let d = try? JSONEncoder().encode(layout) else { return }
        UserDefaults.standard.set(d, forKey: "codeLayout.\(projectId)")
    }

    /// app 到背景:還沒寫進手機的草稿馬上寫(被滑掉也不會掉字)
    func flushDrafts() {
        draftSave?.cancel()
        persistDraftsNow()
    }

    private func persistDraftsNow() {
        guard let projectId else { return }
        if drafts.isEmpty { UserDefaults.standard.removeObject(forKey: "codeDrafts.\(projectId)"); return }
        if let d = try? JSONEncoder().encode(drafts) { UserDefaults.standard.set(d, forKey: "codeDrafts.\(projectId)") }
    }

    // MARK: 查詢

    var panes: [EditorPane] { layout.columns.flatMap(\.panes) }
    var allTabs: [EditorTab] { panes.flatMap(\.tabs) }
    var paneCount: Int { panes.count }
    var activePaneID: UUID {
        let ps = panes
        return ps.first { $0.id == layout.activePane }?.id ?? ps.first?.id ?? UUID()
    }
    var activeTab: EditorTab? { pane(activePaneID)?.activeTab }
    func pane(_ id: UUID) -> EditorPane? { panes.first { $0.id == id } }
    func paneOf(tab id: String) -> UUID? { panes.first { $0.tabs.contains { $0.id == id } }?.id }

    private func indexOf(pane id: UUID) -> (c: Int, p: Int)? {
        for (ci, col) in layout.columns.enumerated() {
            if let pi = col.panes.firstIndex(where: { $0.id == id }) { return (ci, pi) }
        }
        return nil
    }

    private func mutatePane(_ id: UUID, _ f: (inout EditorPane) -> Void) {
        guard let (c, p) = indexOf(pane: id) else { return }
        f(&layout.columns[c].panes[p])
    }

    private func removeTab(_ tabId: String, from paneId: UUID) {
        mutatePane(paneId) { pane in
            guard let i = pane.tabs.firstIndex(where: { $0.id == tabId }) else { return }
            pane.tabs.remove(at: i)
            if pane.active == tabId { pane.active = pane.tabs.isEmpty ? nil : pane.tabs[min(i, pane.tabs.count - 1)].id }
        }
    }

    // MARK: 打開、切換、關閉

    /// 打開分頁:已經開著就切過去;不然開在指定的格子(預設目前這一格)
    func open(_ tab: EditorTab, in paneId: UUID? = nil) {
        if let p = paneOf(tab: tab.id) {
            activate(tab.id, in: p)
            return
        }
        let target = paneId.flatMap { pane($0)?.id } ?? activePaneID
        mutatePane(target) {
            $0.tabs.append(tab)
            $0.active = tab.id
        }
        layout.activePane = target
        persist()
    }

    func activate(_ tabId: String, in paneId: UUID) {
        mutatePane(paneId) { $0.active = tabId }
        layout.activePane = paneId
        persist()
    }

    /// 點到某一格:那一格變成「目前這一格」(側欄點檔案會開在這裡)
    func focus(_ paneId: UUID) {
        guard layout.activePane != paneId, pane(paneId) != nil else { return }
        layout.activePane = paneId
        persist()
    }

    /// 要關的分頁有沒存的修改:先問(畫面上的確認視窗看這個)
    var pendingClose: EditorTab?
    /// 存檔、暫存之後 +1:iPad 一直開著的側欄(檔案的 Git 標記、版本控制清單)跟著重新整理
    var gitChanged = 0

    /// 關分頁:有沒存的修改先問,沒有就直接關
    func requestClose(_ tab: EditorTab) {
        if dirty.contains(tab.id) { pendingClose = tab } else { close(tab.id) }
    }

    /// 目前這一格的下一個/上一個分頁(⌃Tab / ⌃⇧Tab)
    func cycleTab(_ step: Int) {
        let id = activePaneID
        guard let p = pane(id), p.tabs.count > 1, let a = p.activeTab, let i = p.tabs.firstIndex(of: a) else { return }
        activate(p.tabs[(i + step + p.tabs.count) % p.tabs.count].id, in: id)
    }

    /// 關掉分頁(沒存的內容一起丟掉;要不要先問由畫面決定)。一格的分頁都關了,那一格就收掉
    func close(_ tabId: String) {
        guard let p = paneOf(tab: tabId) else { return }
        removeTab(tabId, from: p)
        setDraft(tabId, nil, dirty: false)
        texts[tabId] = nil
        normalize()
        persist()
    }

    /// 關掉同一格的其他分頁(沒存的留著,跟「關閉所有分頁」一樣)
    func closeOthers(_ tabId: String) {
        guard let p = paneOf(tab: tabId), let others = pane(p)?.tabs.filter({ $0.id != tabId && !dirty.contains($0.id) }) else { return }
        for t in others { close(t.id) }
    }

    /// 分頁(或從側欄拖來的檔案)放到某一格:中間 = 加成分頁;邊緣 = 分出新的一格(欄、格滿了就加成分頁)
    func place(_ tab: EditorTab, at paneId: UUID, zone: SplitZone) {
        guard pane(paneId) != nil else { return }
        let src = paneOf(tab: tab.id)
        if zone == .center {
            if src == paneId { activate(tab.id, in: paneId); return }
            if let src { removeTab(tab.id, from: src) }
            mutatePane(paneId) {
                $0.tabs.append(tab)
                $0.active = tab.id
            }
            layout.activePane = paneId
        } else {
            // 一格只有這個分頁、又放到自己的邊緣:沒變
            if src == paneId, pane(paneId)?.tabs.count == 1 { return }
            guard let newId = insertPane(next: paneId, zone: zone) else {
                place(tab, at: paneId, zone: .center)
                return
            }
            if let src { removeTab(tab.id, from: src) }
            mutatePane(newId) {
                $0.tabs = [tab]
                $0.active = tab.id
            }
            layout.activePane = newId
        }
        normalize()
        persist()
    }

    /// 在某一格旁邊分出新的一格(左右 = 新的一欄、上下 = 同一欄新的一格);到上限回 nil
    private func insertPane(next paneId: UUID, zone: SplitZone) -> UUID? {
        guard let (ci, pi) = indexOf(pane: paneId) else { return nil }
        var new = EditorPane()
        switch zone {
        case .left, .right:
            guard layout.columns.count < Self.maxColumns else { return nil }
            let half = layout.columns[ci].size / 2
            layout.columns[ci].size = half
            var col = EditorColumn(panes: [new])
            col.size = half
            layout.columns.insert(col, at: zone == .right ? ci + 1 : ci)
        case .top, .bottom:
            guard layout.columns[ci].panes.count < Self.maxRows else { return nil }
            let half = layout.columns[ci].panes[pi].size / 2
            layout.columns[ci].panes[pi].size = half
            new.size = half
            layout.columns[ci].panes.insert(new, at: zone == .bottom ? pi + 1 : pi)
        case .center:
            return paneId
        }
        return new.id
    }

    // MARK: 調大小、塞不下時合併

    /// 拖欄之間的分隔線:sizes 是每一欄的新比例
    func setColumnSizes(_ sizes: [Double], save: Bool = false) {
        guard sizes.count == layout.columns.count else { return }
        for i in sizes.indices { layout.columns[i].size = max(sizes[i], 0.05) }
        if save { persist() }
    }

    /// 拖同一欄裡格子之間的分隔線
    func setPaneSizes(column ci: Int, _ sizes: [Double], save: Bool = false) {
        guard layout.columns.indices.contains(ci), sizes.count == layout.columns[ci].panes.count else { return }
        for i in sizes.indices { layout.columns[ci].panes[i].size = max(sizes[i], 0.05) }
        if save { persist() }
    }

    /// 畫面放不下這麼多欄/格:多出來的併成旁邊那一格的分頁
    func fit(maxColumns: Int, maxRows: Int) {
        let mc = max(1, min(maxColumns, Self.maxColumns)), mr = max(1, min(maxRows, Self.maxRows))
        var changed = false
        while layout.columns.count > mc {
            let extra = layout.columns.removeLast()
            let last = layout.columns.count - 1
            let target = layout.columns[last].panes.count - 1
            for p in extra.panes { layout.columns[last].panes[target].tabs.append(contentsOf: p.tabs) }
            layout.columns[last].size += extra.size
            changed = true
        }
        for ci in layout.columns.indices {
            while layout.columns[ci].panes.count > mr {
                let extra = layout.columns[ci].panes.removeLast()
                let target = layout.columns[ci].panes.count - 1
                layout.columns[ci].panes[target].tabs.append(contentsOf: extra.tabs)
                layout.columns[ci].panes[target].size += extra.size
                changed = true
            }
        }
        if changed {
            normalize()
            persist()
        }
    }

    /// 整理:拿掉空的格子和欄(至少留一格)、目前分頁和目前這一格要存在
    private func normalize() {
        let total = panes.count
        if total > 1 {
            for ci in layout.columns.indices { layout.columns[ci].panes.removeAll { $0.tabs.isEmpty } }
        }
        layout.columns.removeAll { $0.panes.isEmpty }
        if layout.columns.isEmpty { layout.columns = [EditorColumn()] }
        for ci in layout.columns.indices {
            for pi in layout.columns[ci].panes.indices {
                var p = layout.columns[ci].panes[pi]
                // 同一個分頁不會出現兩次
                var seen = Set<String>()
                p.tabs = p.tabs.filter { seen.insert($0.id).inserted }
                if p.active == nil || !p.tabs.contains(where: { $0.id == p.active }) { p.active = p.tabs.first?.id }
                layout.columns[ci].panes[pi] = p
            }
        }
        // 同一個分頁在不同格各出現一次(例如帶入的版面):只留第一個
        var seen = Set<String>()
        for ci in layout.columns.indices {
            for pi in layout.columns[ci].panes.indices {
                layout.columns[ci].panes[pi].tabs.removeAll { !seen.insert($0.id).inserted }
            }
        }
        if panes.count > 1 {
            for ci in layout.columns.indices { layout.columns[ci].panes.removeAll { $0.tabs.isEmpty } }
            layout.columns.removeAll { $0.panes.isEmpty }
            if layout.columns.isEmpty { layout.columns = [EditorColumn()] }
        }
        if !panes.contains(where: { $0.id == layout.activePane }) { layout.activePane = panes.first?.id }
    }

    // MARK: 編輯中還沒存的內容

    /// 記下(或清掉)某個分頁編輯中的內容;寫進手機的動作稍微延後,不會每打一個字就寫一次。
    /// 跟檔案一樣的不記:重開 app 時記著的分頁都算「還沒存」
    func setDraft(_ tabId: String, _ d: EditorDraft?, dirty isDirty: Bool) {
        let d = isDirty ? d : nil
        if drafts[tabId] != d { drafts[tabId] = d }
        if isDirty { if !dirty.contains(tabId) { dirty.insert(tabId) } } else if dirty.contains(tabId) { dirty.remove(tabId) }
        draftSave?.cancel()
        draftSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            self?.persistDraftsNow()
        }
    }

    // MARK: 帶入網頁版的版面

    /// 網頁版存在管家伺服器上的版面(/api/code/<專案>/session)→ 這台裝置的版面;回傳帶進來幾個分頁。
    /// 編輯中還沒存的分頁留著(加在第一格)
    func importWeb(_ session: [String: Any]) -> Int {
        guard let l = session["layout"] as? [String: Any], let cols = l["cols"] as? [[String: Any]] else { return 0 }
        var columns: [EditorColumn] = []
        for c in cols.prefix(Self.maxColumns) {
            var col = EditorColumn(panes: [])
            col.size = (c["size"] as? Double) ?? 1
            for g in ((c["groups"] as? [[String: Any]]) ?? []).prefix(Self.maxRows) {
                var pane = EditorPane()
                pane.size = (g["size"] as? Double) ?? 1
                for t in (g["tabs"] as? [[String: Any]]) ?? [] {
                    guard let path = t["path"] as? String, !path.isEmpty else { continue }
                    switch t["kind"] as? String {
                    case "diff":
                        if let which = t["which"] as? String { pane.tabs.append(.diff(path, which: which, commit: t["commit"] as? String)) }
                    default:
                        pane.tabs.append(.file(path))
                    }
                }
                if let a = g["active"] as? Int, pane.tabs.indices.contains(a) { pane.active = pane.tabs[a].id }
                if !pane.tabs.isEmpty { col.panes.append(pane) }
            }
            if !col.panes.isEmpty { columns.append(col) }
        }
        let imported = columns.reduce(0) { $0 + $1.panes.reduce(0) { $0 + $1.tabs.count } }
        guard imported > 0 else { return 0 }
        let keep = allTabs.filter { drafts[$0.id] != nil }
        layout = EditorLayout(columns: columns, activePane: columns.first?.panes.first?.id)
        for t in keep where paneOf(tab: t.id) == nil { layout.columns[0].panes[0].tabs.append(t) }
        normalize()
        persist()
        return imported
    }
}
