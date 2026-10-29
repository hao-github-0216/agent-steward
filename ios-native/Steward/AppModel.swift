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
    var cardColumn = "proposed" // 工作卡分頁目前看哪一欄
    /// 可以派工的 agent(擬工作卡時選)
    var agents: [AgentInfo] = []
    /// 即時更新連著沒
    var live = false
    private var eventsTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?

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
        stopEvents()
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
                startEvents()
                if agents.isEmpty { agents = (try? await api.agents()) ?? [] }
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

    // MARK: 即時更新

    /// 連著管家的即時事件;資料一變動就更新(連續好幾個事件合併成一次)。斷線 3 秒後重連
    func startEvents() {
        guard eventsTask == nil else { return }
        eventsTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let api = self.api, let req = try? api.events() else { return }
                do {
                    let (bytes, resp) = try await API.streamSession.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.network("events") }
                    self.live = true
                    for try await line in bytes.lines where line.hasPrefix("data:") {
                        self.scheduleRefresh()
                    }
                } catch {
                    if Task.isCancelled { break }
                }
                self.live = false
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    func stopEvents() {
        eventsTask?.cancel()
        eventsTask = nil
        live = false
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            await self?.refresh()
        }
    }

    // MARK: 工作卡

    /// 移動工作卡(核准派工、標完成…);管家拒絕時丟出它說的原因
    func move(_ card: Card, _ action: CardAction) async throws {
        guard let api else { return }
        let updated = try await api.moveCard(card.id, to: action.column)
        if let i = cards.firstIndex(where: { $0.id == card.id }) { cards[i] = updated }
        await refresh()
    }

    func card(_ id: String) -> Card? { cards.first { $0.id == id } }

    /// agentsteward://project/<專案 id>、agentsteward://project/<專案 id>/chat
    func open(_ url: URL) {
        guard url.scheme == "agentsteward" else { return }
        if url.host() == "cards" { tab = 3; cardColumn = url.pathComponents.dropFirst().first ?? cardColumn; return }
        if url.host() == "card", let id = url.pathComponents.dropFirst().first { tab = 0; path = [.card(id)]; return }
        guard url.host() == "project" else { return }
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
    case card(String)
}
