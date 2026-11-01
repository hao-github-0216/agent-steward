// 分支(worktree)總覽的管家 API:規格在 docs/worktrees-api.md
import Foundation

struct WorktreeList: Decodable {
    var repo: Bool
    var repoRoot: String?
    var prefix: String?
    /// 主資料夾目前的分支 = 合併目標;detached 時 nil
    var target: String?
    var items: [Worktree]?
    var warnings: Warnings?

    struct Warnings: Decodable {
        var unignored: [Unignored]?
        var gitlinks: [String]?
    }
    struct Unignored: Decodable, Hashable {
        var id: String?
        var path: String
        var pattern: String?
    }

    /// 主資料夾以外的
    var others: [Worktree] { (items ?? []).filter { $0.source != "main" } }
}

struct Worktree: Decodable, Hashable, Identifiable {
    var id: String
    var path: String
    /// 專案資料夾在 worktree 裡的位置
    var cwd: String?
    var exists: Bool?
    /// main | claude | steward | manual
    var source: String
    var branch: String?
    var head: String?
    var locked: String?
    var prunable: String?
    var ahead: Int?
    var behind: Int?
    /// 沒 commit 的改動檔案數
    var dirty: Int?
    /// 在這個專案資料夾裡改到的檔案數
    var changed: Int?
    var relevant: Bool?
    var lastModified: String?
    var nested: Bool?
    var ignored: Bool?
    var session: Session?
    var stewardBranchId: String?
    /// 樹狀圖用:歸在 repo 裡哪個登記成專案的子資料夾("" = 直接掛在 repo 底下;主資料夾一律 "")
    var folder: String?

    struct Session: Decodable, Hashable {
        var agent: String?
        var id: String?
        var via: String?
        var originalCwd: String?
        var startedAt: String?
        var pane: Pane?
        var alive: Bool?
    }
    struct Pane: Decodable, Hashable {
        var paneId: String
        var tabId: String?
        var workspaceId: String?
        var agentStatus: String?
    }

    var isMissing: Bool { exists == false || prunable != nil }

    var sourceLabel: String {
        switch source {
        case "main": "主資料夾"
        case "claude": "Claude Code"
        case "steward": "管家支線"
        default: "手動"
        }
    }
    var sourceIcon: String {
        switch source {
        case "main": "house"
        case "claude": "sparkles"
        case "steward": "arrow.triangle.branch"
        default: "hand.raised"
        }
    }
}

/// 樹狀圖:資料夾樹(repo → 子專案資料夾 → worktree / 留下的分支)+ 分岔圖
struct WorktreeTree: Decodable {
    var repo: Bool
    var repoRoot: String?
    var repoName: String?
    var target: String?
    var currentFolder: String?
    /// repo 裡登記成專案的子資料夾;整個 repo 就是一個專案時是空的
    var folders: [Folder]?
    var items: [Worktree]?
    var leftovers: [Leftover]?
    var graph: Graph?

    struct Folder: Decodable, Hashable, Identifiable {
        var path: String
        var projectId: String?
        var name: String?
        var current: Bool?
        var id: String { path }
    }
    /// agent 留下、worktree 已移除的分支:只顯示
    struct Leftover: Decodable, Hashable, Identifiable {
        var branch: String
        var head: String?
        var source: String?
        var folder: String?
        var ahead: Int?
        var merged: Bool?
        var session: Worktree.Session?
        var lastModified: String?
        var savedOnRemove: SavedOnRemove?
        var id: String { "branch:\(branch)" }
    }
    /// 移除 worktree 時「存進分支」產生的 commit;判斷合併時不算它們
    struct SavedOnRemove: Decodable, Hashable {
        var commits: Int?
        var files: [String]?
    }
    struct Graph: Decodable {
        var nodes: [Node]
        var branches: [Branch]
        var truncated: Bool?
    }
    struct Node: Decodable, Hashable {
        var hash: String
        var short: String?
        var subject: String?
        var date: String?
        /// 和前一個點之間省略的 commit 數
        var gapBefore: Int?
    }
    struct Branch: Decodable, Hashable, Identifiable {
        /// worktree 的 id(對得上 items),或 "branch:<名稱>"(留下的分支)
        var key: String
        var branch: String?
        var forkAt: Int
        var mergedAt: Int?
        var ahead: Int?
        var savedOnRemove: SavedOnRemove?
        var id: String { key }
    }

    var others: [Worktree] { (items ?? []).filter { $0.source != "main" } }
}

struct WorktreeMergePreview: Decodable {
    var target: String?
    var branch: String?
    var commits: [Commit]
    var files: [File]
    var stat: String?
    var diff: String?
    var blocker: String?
    var uncommitted: Int?

    struct Commit: Decodable, Hashable, Identifiable {
        var hash: String
        var subject: String?
        var id: String { hash }
    }
    struct File: Decodable, Hashable, Identifiable {
        var status: String
        var path: String
        var id: String { path }
    }
}

struct WorktreeChatResult: Decodable {
    /// focus 跳到開著的窗格 / resume 新 tab 接回原本的對話 / new 新 agent
    var kind: String
    var paneId: String?
    var agent: String?
    var label: String?
    var note: String?
}

/// 程式碼頁正在看的 worktree(所有程式碼頁請求加上 ?wt=<id>)
struct CodeWorktree: Codable, Hashable {
    var id: String
    var branch: String?
    var cwd: String?
}

/// 管家回的錯誤:{ error, code?, detail? };error 直接給使用者看
struct WorktreeError: LocalizedError {
    var status: Int
    var message: String
    var code: String?
    /// 移除時 409 dirty 才有:沒 commit 的檔案、建議捨棄還是存進分支
    var dirty: DirtyDetail?
    var errorDescription: String? { message }
}

struct DirtyDetail: Decodable, Hashable {
    var files: [String]?
    var total: Int?
    var merged: Bool?
    /// discard | commit
    var suggest: String?
    var canCommit: Bool?
}

/// 移除前使用者同意過的項目
struct WorktreeRemoveConfirm: Hashable {
    var alive = false
    var locked = false
    /// 沒 commit 的改動:"discard" 捨棄 / "commit" 存進分支
    var dirty: String?

    var body: [String: Any] {
        var b: [String: Any] = [:]
        if alive { b["alive"] = true }
        if locked { b["locked"] = true }
        if let dirty { b["dirty"] = dirty }
        return b
    }
}

extension API {
    private func worktreePath(_ project: String, _ sub: String = "") -> String {
        "api/code/\(project)/worktrees\(sub.isEmpty ? "" : "/\(sub)")"
    }

    /// 跟 call 一樣,但錯誤帶著 code(移除的 409 要知道是哪一項要確認)
    private func wtCall<T: Decodable>(_ r: URLRequest) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await API.slowSession.data(for: r)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status == 401 || status == 403 { throw APIError.needLogin(json?["error"] as? String ?? "請先登入") }
        guard (200..<300).contains(status) else {
            let code = json?["code"] as? String
            var dirty: DirtyDetail?
            if code == "dirty", let d = json?["detail"], let raw = try? JSONSerialization.data(withJSONObject: d) {
                dirty = try? JSONDecoder().decode(DirtyDetail.self, from: raw)
            }
            throw WorktreeError(status: status, message: json?["error"] as? String ?? "管家回應錯誤(\(status))", code: code, dirty: dirty)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.server(status, "看不懂管家的回應(管家可能要更新)")
        }
    }

    func worktrees(project: String) async throws -> WorktreeList {
        try await wtCall(request(worktreePath(project)))
    }

    func worktreeTree(project: String) async throws -> WorktreeTree {
        try await wtCall(request(worktreePath(project, "tree")))
    }

    /// 專案欄的徽章:{ 專案 ID: 主資料夾以外、算進這個專案的 worktree 數 }
    func worktreeCounts() async throws -> [String: Int] {
        struct R: Decodable { var counts: [String: Int] }
        let r: R = try await call(request("api/worktree-counts"))
        return r.counts
    }

    func worktreeChat(project: String, id: String) async throws -> WorktreeChatResult {
        try await wtCall(request(worktreePath(project, "\(id)/chat"), method: "POST", body: [:]))
    }

    func worktreeMergePreview(project: String, id: String) async throws -> WorktreeMergePreview {
        try await wtCall(request(worktreePath(project, "\(id)/merge")))
    }

    /// 回傳合併後的 commit(短雜湊)
    func worktreeMerge(project: String, id: String) async throws -> String? {
        struct R: Decodable { var merged: Bool?; var commit: String? }
        let r: R = try await wtCall(request(worktreePath(project, "\(id)/merge"), method: "POST", body: [:]))
        return r.commit
    }

    /// confirm:使用者已經同意的項目;還有沒同意的會丟 409 WorktreeError(code = alive / locked / dirty)
    func worktreeRemove(project: String, id: String, confirm: WorktreeRemoveConfirm) async throws {
        struct R: Decodable { var removed: Bool? }
        let _: R = try await wtCall(request(worktreePath(project, "\(id)/remove"), method: "POST", body: ["confirm": confirm.body]))
    }

    /// 把 repo 裡的 worktree 資料夾加進 .gitignore;回傳加了哪些樣式、寫進哪個檔案
    func worktreeIgnore(project: String) async throws -> (added: [String], file: String?) {
        struct R: Decodable { var added: [String]?; var file: String? }
        let r: R = try await wtCall(request(worktreePath(project, "ignore"), method: "POST", body: [:]))
        return (r.added ?? [], r.file)
    }

    /// git rm --cached 被誤 commit 的 worktree(只放進暫存區,沒 commit);回傳要給使用者看的說明
    func worktreeUntrack(project: String) async throws -> String? {
        struct R: Decodable { var untracked: [String]?; var note: String? }
        let r: R = try await wtCall(request(worktreePath(project, "untrack"), method: "POST", body: [:]))
        return r.note ?? (r.untracked.map { "已從版本控制移除:\($0.joined(separator: "、"))" })
    }
}
