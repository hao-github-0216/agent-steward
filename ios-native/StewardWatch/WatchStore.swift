import Foundation
import Combine
import WatchConnectivity
import WidgetKit

@MainActor
final class WatchStore: NSObject, ObservableObject {
    @Published private(set) var snapshot: WatchSnapshot?
    @Published private(set) var isReachable = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var suggestions: [String: [String]] = [:]
    @Published private(set) var chats: [String: [WatchChatLine]] = [:]
    @Published private(set) var askingProjects: Set<String> = []
    @Published private(set) var pendingProjects: Set<String> = []
    @Published private(set) var movingCards: Set<String> = []
    @Published private(set) var actionResults: [String: String] = [:]
    @Published var errorMessage: String?

    private let session: WCSession?
    private let defaults = UserDefaults(suiteName: WatchWire.appGroup)
    private var unansweredQuestions: [String: String] = [:]
    #if DEBUG
    private let fixture: WatchFixture?
    #endif

    override init() {
        #if DEBUG
        fixture = WatchFixture.isEnabled ? WatchFixture() : nil
        #endif
        session = WCSession.isSupported() ? WCSession.default : nil
        super.init()
        #if DEBUG
        if let fixture {
            snapshot = fixture.snapshot
            isReachable = true
            return
        }
        #endif
        readCache()
        session?.delegate = self
        session?.activate()
    }

    func project(_ id: String) -> WatchProject? {
        snapshot?.projects.first { $0.id == id }
    }

    func canAccessContents(_ id: String) -> Bool {
        guard let project = project(id) else { return false }
        return !project.isPrivate
    }

    func refresh() async {
        guard !isRefreshing, isReachable else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            _ = try await request(.refresh)
        } catch { report(error) }
    }

    func loadConversation(_ projectID: String) async {
        guard isReachable, canAccessContents(projectID) else { return }
        do {
            _ = try await request(.suggestions(project: projectID))
        } catch { report(error) }
        await refreshChat(projectID)
    }

    func refreshChat(_ projectID: String) async {
        guard isReachable, canAccessContents(projectID) else { return }
        do {
            _ = try await request(.chat(project: projectID))
        } catch { report(error) }
    }

    func ask(_ text: String, projectID: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, isReachable, canAccessContents(projectID),
              !askingProjects.contains(projectID), !pendingProjects.contains(projectID) else { return }
        askingProjects.insert(projectID)
        unansweredQuestions[projectID] = text
        chats[projectID, default: []].append(WatchChatLine(role: "user", text: text))
        trimChat(projectID)
        defer { askingProjects.remove(projectID) }
        do {
            _ = try await request(.ask(project: projectID, text: text))
        } catch {
            unansweredQuestions[projectID] = nil
            report(error)
        }
    }

    func move(_ cardID: String, to column: String, projectID: String, result: String) async -> Bool {
        guard isReachable, canAccessContents(projectID), !movingCards.contains(cardID) else { return false }
        movingCards.insert(cardID)
        defer { movingCards.remove(cardID) }
        do {
            _ = try await request(.move(card: cardID, column: column))
            actionResults[projectID] = result
            await refresh()
            return true
        } catch {
            report(error)
            return false
        }
    }

    private func request(_ action: WatchRequest.Action) async throws -> WatchResponse {
        guard isReachable else { throw WatchProtocolError.unavailable }
        let response: WatchResponse
        #if DEBUG
        if let fixture {
            response = try fixture.reply(to: action)
        } else {
            response = try await send(action)
        }
        #else
        response = try await send(action)
        #endif
        try receive(response, action: action)
        return response
    }

    private func send(_ action: WatchRequest.Action) async throws -> WatchResponse {
        guard let session, session.activationState == .activated, session.isReachable else {
            throw WatchProtocolError.unavailable
        }
        let data = try WatchWire.encode(WatchRequest(action))
        return try await withCheckedThrowingContinuation { continuation in
            session.sendMessage([WatchWire.payloadKey: data], replyHandler: { reply in
                do {
                    guard let payload = reply[WatchWire.payloadKey] as? Data else {
                        throw WatchProtocolError.invalidMessage
                    }
                    let response = try WatchWire.decode(WatchResponse.self, from: payload)
                    continuation.resume(returning: response)
                } catch { continuation.resume(throwing: error) }
            }, errorHandler: { error in
                continuation.resume(throwing: error)
            })
        }
    }

    private func receive(_ response: WatchResponse, action: WatchRequest.Action? = nil) throws {
        guard response.ok else {
            if let projectID = response.project {
                pendingProjects.remove(projectID)
                unansweredQuestions[projectID] = nil
            }
            throw ResponseFailure(message: Self.localizedError(response.error ?? WatchProtocolError.invalidMessage.rawValue))
        }
        if let snapshot = response.snapshot { accept(snapshot) }
        let projectID: String?
        switch action {
        case .suggestions(let id), .chat(let id), .ask(let id, _): projectID = id
        default: projectID = response.project
        }
        guard let projectID, canAccessContents(projectID) else { return }
        if let values = response.suggestions { suggestions[projectID] = values }
        if let lines = response.chat {
            chats[projectID] = Array(lines.suffix(20))
        } else if let answer = response.answer, !answer.isEmpty {
            chats[projectID, default: []].append(WatchChatLine(role: "assistant", text: answer))
            trimChat(projectID)
        }
        if response.pending {
            pendingProjects.insert(projectID)
        } else {
            let answeredInChat: Bool
            if let question = unansweredQuestions[projectID], let lines = response.chat,
               let index = lines.lastIndex(where: { ["user", "me"].contains($0.role) && $0.text == question }) {
                answeredInChat = lines.dropFirst(index + 1).contains { ["assistant", "bot"].contains($0.role) }
            } else {
                answeredInChat = false
            }
            if response.answer != nil || answeredInChat {
                pendingProjects.remove(projectID)
                unansweredQuestions[projectID] = nil
            }
        }
    }

    private func trimChat(_ projectID: String) {
        chats[projectID] = Array((chats[projectID] ?? []).suffix(20))
    }

    private func accept(_ value: WatchSnapshot) {
        snapshot = value
        let visibleIDs = Set(value.projects.filter { !$0.isPrivate }.map(\.id))
        suggestions = suggestions.filter { (projectID, _) in visibleIDs.contains(projectID) }
        chats = chats.filter { (projectID, _) in visibleIDs.contains(projectID) }
        pendingProjects.formIntersection(visibleIDs)
        unansweredQuestions = unansweredQuestions.filter { (projectID, _) in visibleIDs.contains(projectID) }
        #if DEBUG
        if fixture != nil { return }
        #endif
        do {
            defaults?.set(try WatchWire.encode(value), forKey: WatchWire.cacheKey)
            WidgetCenter.shared.reloadAllTimelines()
        } catch { report(error) }
    }

    private func readCache() {
        guard let data = defaults?.data(forKey: WatchWire.cacheKey) else { return }
        do { snapshot = try WatchWire.decode(WatchSnapshot.self, from: data) }
        catch { report(error) }
    }

    private func receiveContext(_ context: [String: Any], onlyIfNewer: Bool = false) -> Bool {
        guard let data = context[WatchWire.snapshotKey] as? Data else { return false }
        do {
            let value = try WatchWire.decode(WatchSnapshot.self, from: data)
            // 啟動時系統留著的 context 可能比手錶自己存的快照還舊,舊的不要蓋掉新的
            if onlyIfNewer, let current = snapshot, current.at > value.at { return true }
            accept(value)
            return true
        } catch {
            report(error)
            return false
        }
    }

    private func receivePayload(_ payload: [String: Any]) throws {
        guard let data = payload[WatchWire.payloadKey] as? Data else {
            throw WatchProtocolError.invalidMessage
        }
        try receive(WatchWire.decode(WatchResponse.self, from: data))
    }

    private func report(_ error: Error) {
        if let error = error as? WatchProtocolError {
            errorMessage = Self.localizedError(error.rawValue)
        } else {
            errorMessage = error.localizedDescription
        }
    }

    private static func localizedError(_ rawValue: String) -> String {
        guard WatchProtocolError(rawValue: rawValue) != nil else { return rawValue }
        return NSLocalizedString(rawValue, comment: "共用手錶協定錯誤")
    }

    private struct ResponseFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}

extension WatchStore: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            if !self.receiveContext(session.receivedApplicationContext, onlyIfNewer: true) { self.readCache() }
            self.isReachable = activationState == .activated && session.isReachable
            if let error { self.report(error) }
            // 打開手錶 App 時主動請 iPhone 抓最新看板,不要一直顯示上次存下來的清單
            if self.isReachable { await self.refresh() }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in
            let wasReachable = self.isReachable
            self.isReachable = session.activationState == .activated && session.isReachable
            // 從連不到變成連得到(例如 iPhone 回到身邊)時也更新一次
            if !wasReachable, self.isReachable { await self.refresh() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in _ = self.receiveContext(applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in
            do { try self.receivePayload(message) }
            catch { self.report(error) }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            let response: WatchResponse
            do {
                try self.receivePayload(message)
                response = WatchResponse(ok: true)
            } catch {
                self.report(error)
                response = WatchResponse(ok: false, error: (error as? WatchProtocolError)?.rawValue ?? error.localizedDescription)
            }
            if let data = try? WatchWire.encode(response) {
                replyHandler([WatchWire.payloadKey: data])
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        Task { @MainActor in
            do { try self.receivePayload(userInfo) }
            catch { self.report(error) }
        }
    }
}

extension WatchCounts {
    var total: Int { proposed + approved + inProgress + blocked + done }
}
