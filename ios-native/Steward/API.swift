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

    func ask(project: String, message: String) async throws -> ChatReply {
        try await call(request("api/chat", method: "POST", body: ["project": project, "message": message]), slow: true)
    }

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
