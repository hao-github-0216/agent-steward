// 管家 API 回傳的資料。欄位一律可有可無:舊版管家或還沒整理過的專案會缺東西,不能讓整個畫面解不出來。
import Foundation

struct ProjectState: Codable, Hashable {
    var goal: String?
    var progress: String?
    var nextSteps: [String]?
    var decisions: [String]?
    var blockers: [String]?
    var recent: [RecentWork]?
    var updatedAt: String?
}

struct RecentWork: Codable, Hashable {
    var at: String?
    var agent: String?
    var summary: String?
}

struct Project: Codable, Hashable, Identifiable {
    var id: String
    var root: String?
    var name: String
    var kind: String?
    var status: String?
    var `private`: Bool?
    var state: ProjectState?
    var lastActivityAt: String?
    var closedAt: String?

    /// 看板上要顯示的:真正的專案、而且在進行中(雜務、總覽、收起來的不算)
    var isActiveProject: Bool { kind == "project" && status == "active" }

    var lastActive: Date? { Fmt.date(lastActivityAt) ?? Fmt.date(state?.updatedAt) }
}

struct Card: Codable, Hashable, Identifiable {
    var id: String
    var projectId: String
    var title: String
    var agent: String?
    var instructions: String?
    var doneCriteria: String?
    var column: String
    var note: String?
    var paneId: String?
    var terminalId: String?
    var attempts: Int?
    var createdAt: String?
    var updatedAt: String?

    var lastChanged: Date? { Fmt.date(updatedAt) ?? Fmt.date(createdAt) }

    /// 這張卡現在可以做的動作(跟管家的 moveRule 一致)
    var actions: [CardAction] {
        switch column {
        case "proposed": [.dispatch, .reject]
        case "approved", "running": [.markDone, .markBlocked]
        case "blocked": [.redispatch, .markDone, .backToProposed]
        case "done": [.redispatch, .backToProposed]
        case "rejected": [.backToProposed]
        default: []
        }
    }

    var columnLabel: String {
        switch column {
        case "proposed": "提案"
        case "approved": "已核准"
        case "running": "進行中"
        case "blocked": "卡住"
        case "done": "完成"
        case "rejected": "退回"
        default: column
        }
    }
}

enum CardAction: String, Identifiable {
    case dispatch, redispatch, reject, markDone, markBlocked, backToProposed
    var id: String { rawValue }

    var column: String {
        switch self {
        case .dispatch, .redispatch: "approved"
        case .reject: "rejected"
        case .markDone: "done"
        case .markBlocked: "blocked"
        case .backToProposed: "proposed"
        }
    }

    var label: String {
        switch self {
        case .dispatch: "核准並派工"
        case .redispatch: "重新派工"
        case .reject: "不要了"
        case .markDone: "標成完成"
        case .markBlocked: "標成卡住"
        case .backToProposed: "退回提案"
        }
    }

    var icon: String {
        switch self {
        case .dispatch, .redispatch: "paperplane.fill"
        case .reject: "xmark"
        case .markDone: "checkmark"
        case .markBlocked: "exclamationmark.triangle"
        case .backToProposed: "arrow.uturn.backward"
        }
    }

    var destructive: Bool { self == .reject }
}

struct AgentInfo: Codable, Hashable, Identifiable {
    var id: String
    var name: String?
}

struct CardDraft: Codable, Hashable {
    var title: String
    var agent: String
    var instructions: String
    var doneCriteria: String
    var status: String // draft | proposed | dispatched
    var cardId: String?
}

struct SpaceInfo: Codable, Hashable {
    var label: String?
    var nameDiffers: Bool?
    var strays: Int?
    var panes: Int?
    var working: Int?
}

struct Board: Codable {
    var projects: [Project]
    var cards: [Card]?
    var spaceInfo: [String: SpaceInfo]?
}

struct ChatQuote: Codable, Hashable {
    var path: String?
    var from: Int?
    var to: Int?
    var text: String?
}

struct ChatEntry: Codable, Hashable, Identifiable {
    var id: String
    var role: String // "me" | "bot"
    var text: String
    var quote: ChatQuote?
    var via: String?
    var files: [String]?
    var at: String?
    var error: Bool?
    var alt: String?
    var draft: CardDraft?
    var images: [String]? // 附的圖片縮圖(data URL)
    var retryable: Bool? // 主要模型沒回應,可以改用備用模型

    var isMine: Bool { role == "me" }
}

struct FileEntry: Codable, Hashable, Identifiable {
    var name: String
    var rel: String
    var type: String // dir | file
    var size: Int?
    var ignored: Bool?
    var git: String? // U 新檔、M 修改、A 新增、D 刪除、! 衝突、• 資料夾裡有變更
    var id: String { rel }
    var isDir: Bool { type == "dir" }
}

struct ChatPage: Codable {
    var items: [ChatEntry]
    var more: Bool?
}

struct ChatReply: Codable {
    var answer: String?
    var error: String?
    var me: ChatEntry?
    var bot: ChatEntry?
    var card: Card?
    /// 圈選提問:管家認出來圈的是哪個專案、哪個 agent 窗格(終端機才有窗格)
    var snap: SnapReply?
}

struct SnapReply: Codable {
    var project: String?
    var pane: SnapPane?
}

struct SnapPane: Codable {
    var paneId: String
    var agent: String?
}

struct Suggestions: Codable {
    var items: [String]?
}

struct AuthStatus: Codable {
    var authed: Bool
    var how: String?
    var user: String?
    var hasPassword: Bool?
    var reason: String?
}

enum Fmt {
    // 管家的時間是 ISO 8601、帶毫秒(2026-10-29T07:41:07.420Z);沒毫秒的舊資料也要吃
    private static let withMs: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return withMs.date(from: s) ?? plain.date(from: s)
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "zh-Hant")
        f.unitsStyle = .short
        return f
    }()

    static func ago(_ d: Date?) -> String {
        guard let d else { return "" }
        return relative.localizedString(for: d, relativeTo: .now)
    }
}
