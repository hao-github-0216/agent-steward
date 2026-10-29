// 整個 app 共用的狀態:管家網址、登入狀態、專案清單。
import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case setup // 還沒填管家網址
        case checking
        case needPassword(String)
        case ready
        case offline(String)
    }

    /// 管家網址存在 UserDefaults(key: serverURL);測試時可以用 `simctl spawn … defaults write` 先填好
    private(set) var server: URL? = UserDefaults.standard.string(forKey: "serverURL").flatMap(API.normalize)
    var phase: Phase = .setup
    var projects: [Project] = []
    var cards: [Card] = []
    var spaces: [String: SpaceInfo] = [:]
    var loading = false
    var lastError: String?
    /// 專案分頁的導覽路徑、目前的分頁(agentsteward:// 連結和之後的推播通知用來直接跳過去)
    var path: [Route] = []
    var tab = 0

    var api: API? { server.map(API.init(base:)) }

    init() {
        phase = server == nil ? .setup : .checking
    }

    func setServer(_ url: URL) {
        server = url
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        phase = .checking
    }

    func forgetServer() {
        server = nil
        UserDefaults.standard.removeObject(forKey: "serverURL")
        projects = []
        phase = .setup
    }

    /// 打開 app 或回到前景:確認連得上、身分過了,再載專案
    func connect() async {
        guard let api else { phase = .setup; return }
        if case .ready = phase {} else { phase = .checking }
        do {
            let s = try await api.authStatus()
            if s.authed {
                phase = .ready
                await refresh()
                // 啟動參數 -openURL agentsteward://…(Xcode scheme 或 simctl launch 帶)直接跳到那個畫面
                if let link = UserDefaults.standard.string(forKey: "openURL"), let url = URL(string: link), path.isEmpty {
                    open(url)
                }
            } else {
                phase = .needPassword(s.reason ?? "請輸入管家的管理密碼")
            }
        } catch {
            phase = .offline(error.localizedDescription)
        }
    }

    func login(_ password: String) async {
        guard let api else { return }
        do {
            try await api.login(password: password)
            await connect()
        } catch {
            phase = .needPassword(error.localizedDescription)
        }
    }

    func refresh() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            let b = try await api.board()
            projects = b.projects.filter(\.isActiveProject).sorted { ($0.lastActive ?? .distantPast) > ($1.lastActive ?? .distantPast) }
            cards = b.cards ?? []
            spaces = b.spaceInfo ?? [:]
            lastError = nil
        } catch APIError.needLogin(let why) {
            phase = .needPassword(why)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// agentsteward://project/<專案 id>、agentsteward://project/<專案 id>/chat
    func open(_ url: URL) {
        guard url.scheme == "agentsteward", url.host() == "project" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard let id = parts.first else { return }
        tab = 0
        path = parts.dropFirst().first == "chat" ? [.project(id), .chat(id)] : [.project(id)]
    }

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    func working(_ p: Project) -> Int { spaces[p.id]?.working ?? 0 }

    func openCards(_ p: Project) -> [Card] {
        cards.filter { $0.projectId == p.id && ["proposed", "approved", "running", "blocked"].contains($0.column) }
    }
}

enum Route: Hashable {
    case project(String)
    case chat(String)
}
