import Foundation

enum WatchProtocolError: String, Error {
    case unsupportedVersion
    case invalidMessage
    case snapshotTooLarge
    case notConfigured
    case privateProject
    case notFound
    case invalidMove
    case unavailable
}

protocol WatchVersioned: Codable {
    var v: Int { get }
}

enum WatchWire {
    private struct Header: Decodable { let v: Int }

    static let version = 1
    static let payloadKey = "payload"
    static let snapshotKey = "snapshot"
    static let appGroup = "group.io.github.haogithub0216.agentsteward.watch"
    static let cacheKey = "watchSnapshot"
    static let snapshotByteLimit = 60_000

    static func encode<T: WatchVersioned>(_ value: T) throws -> Data {
        guard value.v == version else { throw WatchProtocolError.unsupportedVersion }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }

    static func decode<T: WatchVersioned>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        let header: Header
        do { header = try decoder.decode(Header.self, from: data) }
        catch { throw WatchProtocolError.invalidMessage }
        guard header.v == version else { throw WatchProtocolError.unsupportedVersion }
        do {
            let value = try decoder.decode(type, from: data)
            if let response = value as? WatchResponse, let snapshot = response.snapshot, snapshot.v != version {
                throw WatchProtocolError.unsupportedVersion
            }
            return value
        } catch let error as WatchProtocolError { throw error }
        catch { throw WatchProtocolError.invalidMessage }
    }
}

struct WatchSnapshot: WatchVersioned, Equatable {
    var v = WatchWire.version
    var at: String
    var demo: Bool
    var projects: [WatchProject]

    /// 先縮短進度，再逐張減少工作卡；必要欄位仍超出上限時不傳送。
    func limited() throws -> WatchSnapshot {
        var snapshot = self
        while try WatchWire.encode(snapshot).count >= WatchWire.snapshotByteLimit {
            let hasProgress = snapshot.projects.contains { !($0.progress ?? "").isEmpty }
            if hasProgress {
                for index in snapshot.projects.indices {
                    if let progress = snapshot.projects[index].progress, !progress.isEmpty {
                        let count = progress.count / 2
                        snapshot.projects[index].progress = count == 0 ? nil : String(progress.prefix(count))
                    }
                }
            } else if snapshot.projects.contains(where: { !$0.cards.isEmpty }) {
                for index in snapshot.projects.indices where !snapshot.projects[index].cards.isEmpty {
                    snapshot.projects[index].cards.removeLast()
                }
            } else {
                throw WatchProtocolError.snapshotTooLarge
            }
        }
        return snapshot
    }

    func encodedForContext() throws -> Data {
        try WatchWire.encode(limited())
    }
}

struct WatchCounts: Codable, Equatable {
    var proposed = 0
    var approved = 0
    var inProgress = 0
    var blocked = 0
    var done = 0
}

struct WatchProject: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var goal: String?
    var progress: String?
    var nextSteps: [String] = []
    var blockers: [String] = []
    var counts = WatchCounts()
    var cards: [WatchCard] = []
    var isPrivate = false
}

struct WatchCard: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var column: String
    var agent: String?
    var doneCriteria: String?
    var note: String?
}

struct WatchRequest: WatchVersioned, Equatable {
    enum Action: Codable, Equatable {
        case refresh
        case suggestions(project: String)
        case ask(project: String, text: String)
        case chat(project: String)
        case move(card: String, column: String)
    }

    var v = WatchWire.version
    var action: Action

    init(_ action: Action) { self.action = action }
}

struct WatchChatLine: Codable, Equatable {
    var role: String
    var text: String
    var at: String?
}

struct WatchResponse: WatchVersioned, Equatable {
    var v = WatchWire.version
    var ok: Bool
    var error: String?
    var snapshot: WatchSnapshot?
    var suggestions: [String]?
    var answer: String?
    var pending = false
    var chat: [WatchChatLine]?
    var project: String?
}
