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

struct FileStamp: Decodable {
    var hash: String?
    var gone: Bool?
}

struct OfficeVersion: Decodable, Hashable, Identifiable {
    var id: String
    var at: Double // 毫秒
    var size: Int?
}

struct OfficeInfo: Decodable {
    var editing: Bool?
    var owner: String?
    var versions: [OfficeVersion]?
}

/// 上傳進度(URLSession 每送一段就回報)
final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let onProgress: @Sendable (Double) -> Void
    init(_ onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        if totalBytesExpectedToSend > 0 { onProgress(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) }
    }
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

    /// more:很大的檔案只給頭尾各一段,more 多載入幾行(跟網頁「載入更多」一樣每次多 2000 行)
    func readFile(project: String, path: String, more: Int = 0) async throws -> CodeFile {
        var q = [URLQueryItem(name: "path", value: path)]
        if more > 0 { q.append(URLQueryItem(name: "more", value: String(more))) }
        return try await call(request(codePath(project, "file", q)), slow: true)
    }

    /// 檔案現在的指紋(看檔案在電腦上有沒有被改過、被刪掉)
    func stamps(project: String, paths: [String]) async throws -> [String: FileStamp] {
        try await call(request(codePath(project, "stamps"), method: "POST", body: ["paths": paths]))
    }

    // MARK: Office 歷史版本(從 Office 存檔前留下的舊版本)

    func officeInfo(project: String, path: String) async throws -> OfficeInfo {
        try await call(request(codePath(project, "office/info", [URLQueryItem(name: "path", value: path)])))
    }

    func officeVersion(project: String, path: String, id: String) async throws -> Data {
        let r = try request(codePath(project, "office/version", [URLQueryItem(name: "path", value: path), URLQueryItem(name: "id", value: id)]))
        let (data, resp) = try await API.slowSession.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.server(code, "讀不到這個版本") }
        return data
    }

    func officeRestore(project: String, path: String, id: String) async throws {
        struct R: Decodable { var ok: Bool? }
        let _: R = try await call(request(codePath(project, "office/restore"), method: "POST", body: ["path": path, "id": id]))
    }

    // MARK: 上傳(跟網頁一樣一個檔案一個 PUT;同名檔案要 overwrite 才蓋,舊檔先移到電腦的垃圾桶)

    enum UploadResult { case ok, exists }

    /// 上傳大檔可能很久:另外一個不會 30 秒就逾時的連線
    static let uploadSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 6 * 3600
        c.httpCookieStorage = .shared
        return URLSession(configuration: c)
    }()

    func upload(project: String, path: String, file: URL, overwrite: Bool, progress: @escaping @Sendable (Double) -> Void) async throws -> UploadResult {
        var r = try request(codePath(project, "upload", [URLQueryItem(name: "path", value: path), URLQueryItem(name: "overwrite", value: overwrite ? "1" : "0")]), method: "PUT")
        r.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await API.uploadSession.upload(for: r, fromFile: file, delegate: UploadProgress(progress))
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if code == 409, json?["exists"] as? Bool == true { return .exists }
        if code == 401 || code == 403 { throw APIError.needLogin(json?["error"] as? String ?? "請先登入") }
        guard (200..<300).contains(code) else { throw APIError.server(code, json?["error"] as? String ?? "上傳失敗") }
        return .ok
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
