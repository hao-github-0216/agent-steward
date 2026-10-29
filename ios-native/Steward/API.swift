// 跟電腦上的專案管家講話。
// 身分:透過 Tailscale(https://xxx.ts.net)連線時管家自動認得;否則用管理密碼登入,cookie 由系統記住。
import Foundation

enum APIError: LocalizedError {
    case badURL
    case needLogin(String)
    case server(Int, String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "管家網址不對"
        case .needLogin(let why): why
        case .server(let code, let msg): msg.isEmpty ? "管家回應錯誤(\(code))" : msg
        case .network(let msg): "連不上管家:\(msg)"
        }
    }
}

struct API {
    let base: URL

    /// 一般請求 30 秒;問管家要等模型回答,管家那邊最多等 180 秒
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        c.httpCookieStorage = .shared
        c.httpShouldSetCookies = true
        return URLSession(configuration: c)
    }()

    private static let slowSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 210
        c.timeoutIntervalForResource = 240
        c.httpCookieStorage = .shared
        return URLSession(configuration: c)
    }()

    /// 「my-mac.ts.net」「https://my-mac.ts.net:8793/xxx」都整理成 https://host:port/
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let u = URLComponents(string: s), let host = u.host, !host.isEmpty else { return nil }
        var out = URLComponents()
        out.scheme = u.scheme
        out.host = host
        out.port = u.port
        out.path = "/"
        return out.url
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: base) else { throw APIError.badURL }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "accept")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func call<T: Decodable>(_ r: URLRequest, slow: Bool = false) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await (slow ? Self.slowSession : Self.session).data(for: r)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 {
            let msg = (try? JSONDecoder().decode([String: String?].self, from: data))?["error"] ?? nil
            throw APIError.needLogin(msg ?? "請先登入")
        }
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(code, msg ?? "")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.server(code, "看不懂管家的回應(管家可能要更新)")
        }
    }

    func authStatus() async throws -> AuthStatus {
        try await call(request("api/auth/status"))
    }

    func login(password: String) async throws {
        struct OK: Decodable { var ok: Bool? }
        let _: OK = try await call(request("api/auth/login", method: "POST", body: ["password": password]))
    }

    func board() async throws -> Board {
        try await call(request("api/board"))
    }

    func chat(project: String, before: String? = nil) async throws -> ChatPage {
        var path = "api/chat/\(project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project)?limit=40"
        if let before { path += "&before=\(before)" }
        return try await call(request(path))
    }

    func ask(project: String, message: String, attachments: [Attachment] = []) async throws -> ChatReply {
        var body: [String: Any] = ["project": project, "message": message]
        let files: [[String: String]] = attachments.compactMap {
            switch $0.kind {
            case .projectFile(let rel): ["path": rel]
            case .phoneFile(let name, let content): ["path": "iPhone/\(name)", "content": content]
            case .image: nil
            }
        }
        let images: [(data: String, mime: String, thumb: String)] = attachments.compactMap {
            if case .image(let data, let mime, let thumb) = $0.kind { return (data, mime, thumb) }
            return nil
        }
        if !files.isEmpty { body["files"] = files }
        if !images.isEmpty {
            body["images"] = images.map { ["data": $0.data, "mimeType": $0.mime] }
            body["thumbs"] = images.map(\.thumb)
        }
        return try await call(request("api/chat", method: "POST", body: body), slow: true)
    }

    /// 圈選提問:讀得到字送文字(整個畫面的字當周圍內容),讀不到才送截圖
    func askSnap(project: String, message: String, snap: SnapResult) async throws -> ChatReply {
        let text = snap.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var body: [String: Any] = [
            "project": project,
            "message": message,
            "snap": ["kind": "page", "label": snap.label, "text": text, "context": String(snap.context.prefix(12_000))],
        ]
        if text.isEmpty, let a = await MainActor.run(body: { Attachment.image(snap.image) }), case .image(let data, let mime, let thumb) = a.kind {
            body["images"] = [["data": data, "mimeType": mime]]
            body["thumbs"] = [thumb]
        }
        return try await call(request("api/chat", method: "POST", body: body), slow: true)
    }

    // MARK: 專案檔案(附檔案用)

    private func codePath(_ project: String, _ op: String, _ q: [URLQueryItem]) -> String {
        var c = URLComponents()
        c.path = "api/code/\(project)/\(op)"
        c.queryItems = q
        return c.string ?? ""
    }

    func tree(project: String, dir: String) async throws -> [FileEntry] {
        struct R: Decodable { var entries: [FileEntry] }
        let r: R = try await call(request(codePath(project, "tree", [URLQueryItem(name: "dir", value: dir)])))
        return r.entries
    }

    func findFiles(project: String, query: String) async throws -> [String] {
        struct R: Decodable { var files: [String] }
        let r: R = try await call(request(codePath(project, "find", [URLQueryItem(name: "q", value: query)])))
        return r.files
    }

    // MARK: 工作卡

    func moveCard(_ id: String, to column: String) async throws -> Card {
        try await call(request("api/cards/\(id)/move", method: "POST", body: ["column": column]))
    }

    /// 在終端機切到這張卡的窗格
    func focusCard(_ id: String) async throws {
        struct OK: Decodable { var ok: Bool? }
        let _: OK = try await call(request("api/cards/\(id)/focus", method: "POST", body: [:]))
    }

    func agents() async throws -> [AgentInfo] {
        struct R: Decodable { var agents: [AgentInfo] }
        let r: R = try await call(request("api/agents"))
        return r.agents
    }

    /// 請管家擬一張工作卡草稿(會記進問管家的對話)
    func draftCard(project: String, message: String) async throws -> ChatReply {
        let id = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        return try await call(request("api/chat/\(id)/draft", method: "POST", body: ["message": message]), slow: true)
    }

    /// 對草稿動作:save / propose / dispatch
    func draftAction(project: String, entry: String, action: String, draft: CardDraft) async throws -> ChatReply {
        let id = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        let body: [String: Any] = ["action": action, "draft": ["title": draft.title, "agent": draft.agent, "instructions": draft.instructions, "doneCriteria": draft.doneCriteria]]
        return try await call(request("api/chat/\(id)/draft/\(entry)", method: "POST", body: body))
    }

    /// 管家的即時事件(SSE):資料一有變動就收到一行 data: {"what": "cards"}
    func events() throws -> URLRequest {
        var r = try request("api/events")
        r.setValue("text/event-stream", forHTTPHeaderField: "accept")
        r.timeoutInterval = 3600
        return r
    }

    static let streamSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120 // 管家每 25 秒送一次 ping
        c.timeoutIntervalForResource = 24 * 3600
        c.httpCookieStorage = .shared
        return URLSession(configuration: c)
    }()

    struct PushStatus: Decodable { var configured: Bool? }

    func registerPush(token: String, env: String, name: String) async throws {
        struct OK: Decodable { var ok: Bool? }
        let _: OK = try await call(request("api/push/register", method: "POST", body: ["token": token, "env": env, "name": name]))
    }

    func pushStatus() async throws -> PushStatus {
        try await call(request("api/push/status"))
    }

    func testPush(token: String) async throws {
        struct OK: Decodable { var ok: Bool? }
        let _: OK = try await call(request("api/push/test", method: "POST", body: ["token": token]))
    }

    func suggestions(project: String) async throws -> [String] {
        let id = project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project
        let s: Suggestions = try await call(request("api/chat/\(id)/suggest?ensure=1"), slow: true)
        return s.items ?? []
    }
}
