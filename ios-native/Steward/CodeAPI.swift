// 程式碼頁(原生)用的管家 API:檔案(列資料夾、搜尋、讀、存、新增/改名/丟垃圾桶)和 Git
import Foundation

struct CodeFile: Decodable {
    var path: String
    var name: String
    var size: Int?
    var kind: String // text | image | pdf | office | binary | toolarge
    var content: String?
    var hash: String?
    var readonly: Bool?
    var truncated: Truncated?
    struct Truncated: Decodable { var total: Int; var shown: Int }
}

struct GitFile: Decodable, Hashable, Identifiable {
    var path: String
    var code: String?
    var from: String?
    var id: String { path }
}

struct GitStatus: Decodable {
    var repo: Bool
    var branch: String?
    var upstream: String?
    var ahead: Int?
    var behind: Int?
    var staged: [GitFile]?
    var unstaged: [GitFile]?
    var untracked: [GitFile]?
    var conflicted: [GitFile]?
}

struct GitCommit: Decodable, Hashable, Identifiable {
    var hash: String
    var short: String?
    var author: String?
    var date: String?
    var subject: String?
    var id: String { hash }
}

struct GitCommitDetail: Decodable {
    var hash: String
    var author: String?
    var date: String?
    var body: String?
    var files: [GitFile]
}

struct GitBranch: Decodable, Hashable, Identifiable {
    var current: Bool
    var name: String
    var upstream: String?
    var remote: Bool?
    var id: String { name }
}

struct DiffSides: Decodable {
    var original: String
    var modified: String
}

/// 存檔時檔案已經被別人改過(409)
struct SaveConflict: Error {
    let message: String
    let diskContent: String
    let diskHash: String
}

extension API {
    private func codePath(_ project: String, _ op: String, _ q: [URLQueryItem] = []) -> String {
        var c = URLComponents()
        c.path = "api/code/\(project)/\(op)"
        if !q.isEmpty { c.queryItems = q }
        return c.string ?? ""
    }

    func readFile(project: String, path: String) async throws -> CodeFile {
        try await call(request(codePath(project, "file", [URLQueryItem(name: "path", value: path)])), slow: true)
    }

    /// 圖片、PDF、Notebook、Office 的原始內容
    func rawFile(project: String, path: String) async throws -> Data {
        let r = try request(codePath(project, "raw", [URLQueryItem(name: "path", value: path)]))
        let (data, resp) = try await API.slowSession.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(code, msg ?? "讀不到檔案")
        }
        return data
    }

    /// 存檔;別人改過(hash 不同)丟 SaveConflict,force 就直接蓋過去
    func saveFile(project: String, path: String, content: String, baseHash: String?, force: Bool = false) async throws -> String? {
        var body: [String: Any] = ["path": path, "content": content, "force": force]
        if let baseHash { body["baseHash"] = baseHash }
        let r = try request(codePath(project, "file"), method: "PUT", body: body)
        let (data, resp) = try await API.session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if code == 409, let disk = json?["disk"] as? [String: Any] {
            throw SaveConflict(message: json?["error"] as? String ?? "檔案在你開啟之後被改過了", diskContent: disk["content"] as? String ?? "", diskHash: disk["hash"] as? String ?? "")
        }
        guard (200..<300).contains(code) else { throw APIError.server(code, json?["error"] as? String ?? "存檔失敗") }
        return json?["hash"] as? String
    }

    /// 新檔案 mkfile、新資料夾 mkdir、改名 rename(to)、丟垃圾桶 trash
    func fsOp(project: String, op: String, path: String, to: String? = nil) async throws {
        struct R: Decodable {}
        var body: [String: Any] = ["op": op, "path": path]
        if let to { body["to"] = to }
        let _: R = try await call(request(codePath(project, "fs"), method: "POST", body: body))
    }

    // MARK: Git

    func gitStatus(project: String) async throws -> GitStatus {
        try await call(request(codePath(project, "git/status")))
    }

    /// which:staged | unstaged | untracked | commit
    func gitDiff(project: String, path: String, which: String, commit: String? = nil) async throws -> DiffSides {
        var q = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "which", value: which)]
        if let commit { q.append(URLQueryItem(name: "commit", value: commit)) }
        return try await call(request(codePath(project, "git/diff", q)), slow: true)
    }

    /// 回傳 {ok, out} 的 out 不管(暫存、取消暫存、捨棄、提交、切換分支、拉取、推送、抓取)
    func git(_ project: String, _ action: String, _ body: [String: Any] = [:]) async throws {
        struct R: Decodable { var ok: Bool? }
        let _: R = try await call(request(codePath(project, "git/\(action)"), method: "POST", body: body), slow: true)
    }

    private struct Out<T: Decodable>: Decodable { var out: T }

    func gitLog(project: String) async throws -> [GitCommit] {
        let r: Out<[GitCommit]> = try await call(request(codePath(project, "git/log"), method: "POST", body: [:]))
        return r.out
    }

    func gitShow(project: String, commit: String) async throws -> GitCommitDetail {
        let r: Out<GitCommitDetail> = try await call(request(codePath(project, "git/show"), method: "POST", body: ["commit": commit]))
        return r.out
    }

    func gitBranches(project: String) async throws -> [GitBranch] {
        let r: Out<[GitBranch]> = try await call(request(codePath(project, "git/branches"), method: "POST", body: [:]))
        return r.out
    }

    /// 請管家依變更寫提交訊息
    func commitMessage(project: String) async throws -> String {
        struct R: Decodable { var message: String }
        let r: R = try await call(request(codePath(project, "git/commitmsg"), method: "POST", body: [:]), slow: true)
        return r.message
    }
}
