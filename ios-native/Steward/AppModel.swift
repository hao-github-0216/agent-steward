// 整個 app 共用的狀態。排版照管家網頁:標題列「專案管家 ▸」(打開專案欄換專案)+ 看板|程式碼|終端機 三種模式,
// 右下角貓咪浮動球(問管家)和圈選鈕,程式碼/終端機下面有管家側欄。
// 「目前專案」在最上層,三種模式都是看這個專案(跟網頁的 sel 一樣,跨裝置同步)。
import Foundation
import Observation

enum Mode: String, CaseIterable, Identifiable {
    case board, code, terminal
    var id: String { rawValue }

    var title: String {
        switch self {
        case .board: "看板"
        case .code: "程式碼"
        case .terminal: "終端機"
        }
    }

    /// 網頁 setMode 用的名稱
    var webName: String {
        switch self {
        case .board: "board"
        case .code: "code"
        case .terminal: "term"
        }
    }

    var isWeb: Bool { self != .board }
}

/// 從別的地方(圈選、網頁程式碼頁的「問管家」)帶著東西打開問管家
enum ChatIntent: Equatable {
    case quote(ChatQuote)
    case draft(String)
}

/// 終端機的支線狀態(網頁的 renderBranchBtns 告訴我們)
struct TermState: Equatable {
    var agent = false
    var branchMain: String?
    var mainAlive = false
}

enum BallCorner: String {
    case br, bl, tr, tl
    var isBottom: Bool { self == .br || self == .bl }
    var isRight: Bool { self == .br || self == .tr }
}

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
    /// 管家記得的所有專案(含雜務、總覽、收起來的、停止追蹤的、待登記的資料夾)
    var allProjects: [Project] = []
    var cards: [Card] = []
    var spaces: [String: SpaceInfo] = [:]
    var loading = false
    var lastError: String?
    var agents: [AgentInfo] = []
    var live = false

    // MARK: 畫面狀態(跟網頁一樣記住:模式、看板收合、顯示所有專案的工作卡、浮動球角落)

    private(set) var currentProjectId: String? = UserDefaults.standard.string(forKey: "currentProject")
    var mode: Mode = Mode(rawValue: UserDefaults.standard.string(forKey: "mode") ?? "") ?? .board {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: "mode")
            web.setMode(mode)
        }
    }
    var showNav = false
    var showChat = false
    var showSettings = false
    /// 程式碼/終端機下面的管家側欄展開了沒(網頁的 body.drawer)
    var drawerOpen = UserDefaults.standard.object(forKey: "drawer") as? Bool ?? false {
        didSet { UserDefaults.standard.set(drawerOpen, forKey: "drawer") }
    }
    var allCards = UserDefaults.standard.bool(forKey: "allCards") {
        didSet { UserDefaults.standard.set(allCards, forKey: "allCards") }
    }
    var boardCollapsed = UserDefaults.standard.bool(forKey: "boardCollapsed") {
        didSet { UserDefaults.standard.set(boardCollapsed, forKey: "boardCollapsed") }
    }
    var foldedColumns: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "foldedColumns") ?? []) {
        didSet { UserDefaults.standard.set(Array(foldedColumns), forKey: "foldedColumns") }
    }
    var ballCorner = BallCorner(rawValue: UserDefaults.standard.string(forKey: "ballCorner") ?? "") ?? .br {
        didSet { UserDefaults.standard.set(ballCorner.rawValue, forKey: "ballCorner") }
    }
    /// 看板要捲到哪一欄(連結 agentsteward://cards/<欄位>)
    var scrollToColumn: String?
    /// 打開的工作卡視窗
    var openCardId: String?
    /// 要帶到問管家的東西
    var pendingChat: ChatIntent?
    /// 問管家:等回答中(貓咪眼睛動)、有沒看過的回答(貓咪上的點)
    var chatBusy = false
    var chatUnread = false
    /// 終端機:這個專案還沒有 herdr space,問要不要建立
    var needSpace: String?
    var termState = TermState()
    /// 一次性的網頁畫面(建立專案、整理 spaces、拆出子資料夾、設定)
    var webSheet: WebSheet?

    /// 圈選提問(原生畫面用;程式碼和終端機用網頁自己的圈選)
    let snap = SnapState()
    /// 程式碼和終端機共用一個網頁(跟網頁一樣在同一頁切模式)
    @ObservationIgnored private(set) var web: WebStore!

    private var eventsTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?

    var api: API? { server.map(API.init(base:)) }

    init() {
        phase = server == nil ? .setup : .checking
        web = WebStore(model: self)
    }

    // MARK: 專案清單(分組跟網頁的專案欄一樣)

    private func byActivity(_ a: Project, _ b: Project) -> Bool { (a.lastActive ?? .distantPast) > (b.lastActive ?? .distantPast) }
    var projects: [Project] { allProjects.filter(\.isActiveProject).sorted(by: byActivity) }
    /// 雜務、總覽
    var specialProjects: [Project] { allProjects.filter { $0.kind != nil && $0.kind != "project" } }
    var pendingFolders: [Project] { allProjects.filter { $0.status == "pending" } }
    var closedProjects: [Project] {
        allProjects.filter { $0.kind == "project" && $0.status == "closed" }.sorted { ($0.closedAt ?? "") > ($1.closedAt ?? "") }
    }
    /// 停止追蹤、但還有紀錄的(沒紀錄的略過資料夾不列)
    var stoppedProjects: [Project] {
        allProjects.filter { p in p.kind == "project" && p.status == "ignored" && (p.state?.updatedAt?.isEmpty == false || cards.contains { $0.projectId == p.id }) }
    }

    var current: Project? { currentProjectId.flatMap(project) }
    func project(_ id: String) -> Project? { allProjects.first { $0.id == id } }
    func card(_ id: String) -> Card? { cards.first { $0.id == id } }
    func working(_ p: Project) -> Int { spaces[p.id]?.working ?? 0 }
    /// 專案欄的數字:提案 + 卡住(跟網頁一樣)
    func openCount(_ p: Project) -> Int { cards.filter { $0.projectId == p.id && ($0.column == "proposed" || $0.column == "blocked") }.count }

    /// 換目前專案。fromWeb:網頁(herdr 自己切了 space)告訴我們的,不用再叫網頁換
    func switchProject(_ id: String, fromWeb: Bool = false) {
        guard id != currentProjectId, project(id) != nil else { return }
        currentProjectId = id
        UserDefaults.standard.set(id, forKey: "currentProject")
        needSpace = nil
        if !fromWeb {
            lastLocalSwitch = .now
            web.select(id)
            if let api { Task { try? await api.putCurrent(project: id) } }
        }
    }
    private var lastLocalSwitch = Date.distantPast

    /// 專案清單載好後確定有個目前專案:這支手機上次選的 → 管家記的最後一個 → 最近活動的
    private func ensureCurrent() async {
        if let id = currentProjectId, project(id) != nil { return }
        if let r = try? await api?.getCurrent(), let id = r.project, project(id) != nil {
            currentProjectId = id
        } else {
            currentProjectId = projects.first?.id
        }
        UserDefaults.standard.set(currentProjectId, forKey: "currentProject")
    }

    /// 回到前景:別的裝置換過專案就跟上(跟網頁的 syncCurrent 一樣,不會即時拉走正在看的畫面)
    func syncCurrentFromServer() async {
        // 剛在這支手機換過:管家那邊可能還沒收到,不要拿舊的蓋回來
        guard Date.now.timeIntervalSince(lastLocalSwitch) > 10 else { return }
        guard let api, let r = try? await api.getCurrent(), let id = r.project, id != currentProjectId, project(id) != nil else { return }
        currentProjectId = id
        UserDefaults.standard.set(id, forKey: "currentProject")
        web.select(id)
    }

    // MARK: 連線

    func setServer(_ url: URL) {
        server = url
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        phase = .checking
    }

    func forgetServer() {
        stopEvents()
        web.reset()
        server = nil
        UserDefaults.standard.removeObject(forKey: "serverURL")
        allProjects = []
        phase = .setup
    }

    func connect() async {
        guard let api else { phase = .setup; return }
        if case .ready = phase {} else { phase = .checking }
        do {
            let s = try await api.authStatus()
            if s.authed {
                await refresh()
                await ensureCurrent()
                phase = .ready
                startEvents()
                if agents.isEmpty { agents = (try? await api.agents()) ?? [] }
                if let link = UserDefaults.standard.string(forKey: "openURL"), let url = URL(string: link) { open(url) }
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
            allProjects = b.projects
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

    /// 移動工作卡(拖拉或工作卡視窗的按鈕);管家拒絕時丟出它說的原因
    func move(_ cardId: String, to column: String) async throws {
        guard let api else { return }
        let updated = try await api.moveCard(cardId, to: column)
        if let i = cards.firstIndex(where: { $0.id == cardId }) { cards[i] = updated }
        await refresh()
    }

    /// 在終端機看這張卡的窗格
    func showInTerminal(_ card: Card) async throws {
        try await api?.focusCard(card.id)
        if card.projectId != currentProjectId { switchProject(card.projectId) }
        openCardId = nil
        mode = .terminal
    }

    func updateProject(_ id: String, _ body: [String: Any]) async throws {
        try await api?.updateProject(id, body)
        await refresh()
    }

    // MARK: 連結

    /// agentsteward://project/<id>[/chat|/code|/terminal]、agentsteward://card/<id>、agentsteward://cards/<欄位>
    func open(_ url: URL) {
        guard url.scheme == "agentsteward" else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host() {
        case "nav":
            showNav = true
        case "snap":
            // 圈選提問(跟按圈選鈕一樣);等畫面畫好再截圖
            Task { try? await Task.sleep(for: .milliseconds(600)); if mode.isWeb { web.snap() } else { snap.begin() } }
        case "cards":
            mode = .board
            boardCollapsed = false
            scrollToColumn = parts.first
        case "card":
            guard let id = parts.first else { return }
            if let c = card(id) { switchProject(c.projectId) }
            mode = .board
            openCardId = id
        case "project":
            guard let id = parts.first else { return }
            switchProject(id)
            switch parts.dropFirst().first {
            case "chat": showChat = true
            case "code": mode = .code
            case "terminal": mode = .terminal
            default: mode = .board
            }
        default:
            break
        }
    }

    /// 圈選提問的出處說明
    var screenLabel: String {
        if showChat { return "iPhone app 問管家(\(current?.name ?? ""))" }
        if let id = openCardId, let c = card(id) { return "iPhone app 工作卡「\(c.title)」" }
        return "iPhone app \(mode.title)(\(current?.name ?? ""))"
    }

    /// 網頁傳來的訊息(見 web/index.html 的 toApp)
    func handleWeb(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "project":
            if let id = msg["id"] as? String { switchProject(id, fromWeb: true) }
        case "chat":
            if let id = msg["project"] as? String { switchProject(id) }
            if let q = msg["quote"] as? [String: Any], let text = q["text"] as? String {
                pendingChat = .quote(ChatQuote(path: q["path"] as? String, from: q["from"] as? Int, to: q["to"] as? Int, text: text))
            }
            showChat = true
        case "draft":
            if let id = msg["project"] as? String { switchProject(id) }
            if let m = msg["message"] as? String { pendingChat = .draft(m) }
            showChat = true
        case "needSpace":
            needSpace = msg["project"] as? String
        case "termState":
            let b = msg["branch"] as? [String: Any]
            termState = TermState(agent: msg["agent"] as? Bool ?? false, branchMain: b?["mainLabel"] as? String, mainAlive: b?["mainAlive"] as? Bool ?? false)
        default:
            break
        }
    }
}

/// 一次性的網頁畫面
enum WebSheet: Identifiable, Equatable {
    case settings(String, String) // 分頁 id、標題
    case create
    case tidy
    case split(String) // 專案 id
    case full

    var id: String {
        switch self {
        case .settings(let s, _): "settings-\(s)"
        case .create: "create"
        case .tidy: "tidy"
        case .split(let p): "split-\(p)"
        case .full: "full"
        }
    }
}
