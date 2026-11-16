import Foundation
import UIKit
import WatchConnectivity

@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private var session: WCSession?
    private var latestSnapshot: WatchSnapshot?
    private var sentContent: WatchSnapshot?

    func start() {
        guard session == nil, WCSession.isSupported() else { return }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
    }

    func publish(board: Board, demo: Bool) {
        latestSnapshot = WatchSnapshot.make(board: board, demo: demo)
        sendSnapshot()
    }

    private func sendSnapshot() {
        guard let session, session.activationState == .activated,
              session.isPaired, session.isWatchAppInstalled, let snapshot = latestSnapshot else { return }
        do {
            let limited = try snapshot.limited()
            var content = limited
            content.at = ""
            guard content != sentContent else { return }
            try session.updateApplicationContext([WatchWire.snapshotKey: try limited.encodedForContext()])
            // 只有系統接受後才記住內容，啟用或配對前失敗仍可重試。
            sentContent = content
        } catch {
            // 保留最新快照，等下次更新或連線狀態改變再試。
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            self.sentContent = nil
            self.sendSnapshot()
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        Task { @MainActor in
            self.sentContent = nil
            self.session?.activate()
        }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in
            self.sentContent = nil
            self.sendSnapshot()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        let data = message[WatchWire.payloadKey] as? Data
        Task { @MainActor in
            self.receive(data, replyHandler: replyHandler)
        }
    }

    private func receive(_ data: Data?, replyHandler: @escaping ([String: Any]) -> Void) {
        let delivery = Delivery(replyHandler: replyHandler)
        delivery.background = UIApplication.shared.beginBackgroundTask(withName: "WatchBridge") { [weak delivery] in
            Task { @MainActor in delivery?.expire() }
        }
        do {
            guard let data else { throw WatchProtocolError.invalidMessage }
            let request = try WatchWire.decode(WatchRequest.self, from: data)
            switch request.action {
            case .suggestions(let project), .chat(let project), .ask(let project, _): delivery.project = project
            case .refresh, .move: break
            }
            if case .ask = request.action {
                // 從收到問題起算，專案驗證的網路時間也不能拖過即時回覆期限。
                delivery.timer = Task { @MainActor in
                    do { try await Task.sleep(for: .seconds(25)) }
                    catch { return }
                    delivery.sendPending()
                }
            }
            delivery.operation = Task { await self.handle(request, delivery: delivery) }
        } catch {
            delivery.finish(WatchResponse(ok: false, error: Self.errorCode(error)))
        }
    }

    private func handle(_ request: WatchRequest, delivery: Delivery) async {
        let defaults = UserDefaults.standard
        let demo = defaults.bool(forKey: "isDemo")
        let base = demo ? DemoData.baseURL : defaults.string(forKey: "serverURL").flatMap(API.normalize)
        guard let base else {
            delivery.finish(WatchResponse(ok: false, error: WatchProtocolError.notConfigured.rawValue, project: delivery.project))
            return
        }
        let api = API(base: base)
        do {
            let board = try await api.board()
            try Task.checkCancellation()
            guard !delivery.finished else { return }
            switch request.action {
            case .refresh:
                let snapshot = try WatchSnapshot.make(board: board, demo: demo).limited()
                publish(board: board, demo: demo)
                delivery.finish(WatchResponse(ok: true, snapshot: snapshot))
            case .suggestions(let project):
                try Self.requirePublicProject(project, board: board)
                let suggestions = try await api.suggestions(project: project)
                delivery.finish(WatchResponse(ok: true, suggestions: suggestions, project: project))
            case .chat(let project):
                try Self.requirePublicProject(project, board: board)
                let page = try await api.chat(project: project)
                let chat = page.items.suffix(5).map { WatchChatLine(role: $0.role, text: $0.text, at: $0.at) }
                delivery.finish(WatchResponse(ok: true, chat: chat, project: project))
            case .move(let cardID, let column):
                guard let card = board.cards?.first(where: { $0.id == cardID }) else { throw WatchProtocolError.notFound }
                delivery.project = card.projectId
                try Self.requirePublicProject(card.projectId, board: board)
                let allowed = (card.column == "proposed" && ["approved", "rejected"].contains(column))
                    || (card.column == "blocked" && ["approved", "done"].contains(column))
                guard allowed else { throw WatchProtocolError.invalidMove }
                _ = try await api.moveCard(cardID, to: column)
                try Task.checkCancellation()
                let updated = try await api.board()
                try Task.checkCancellation()
                let snapshot = try WatchSnapshot.make(board: updated, demo: demo).limited()
                publish(board: updated, demo: demo)
                delivery.finish(WatchResponse(ok: true, snapshot: snapshot, project: card.projectId))
            case .ask(let project, let text):
                try Self.requirePublicProject(project, board: board)
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WatchProtocolError.invalidMessage }
                delivery.askStarted = true
                // 計時與請求各自執行；逾時只先回覆等待，不取消模型請求，也不等待工作群組收尾。
                let reply = try await api.ask(project: project, message: text)
                let answer = reply.answer ?? reply.bot?.text
                let error = reply.error ?? (answer == nil ? WatchProtocolError.unavailable.rawValue : nil)
                delivery.finish(WatchResponse(ok: error == nil, error: error, answer: answer, project: project))
            }
        } catch {
            delivery.finish(WatchResponse(ok: false, error: Self.errorCode(error), project: delivery.project))
        }
    }

    private static func requirePublicProject(_ id: String, board: Board) throws {
        guard let project = board.projects.first(where: { $0.id == id }) else { throw WatchProtocolError.notFound }
        guard project.private != true else { throw WatchProtocolError.privateProject }
    }

    private static func errorCode(_ error: Error) -> String {
        if error is CancellationError { return WatchProtocolError.unavailable.rawValue }
        return (error as? WatchProtocolError)?.rawValue ?? error.localizedDescription
    }

    @MainActor
    private final class Delivery {
        var project: String?
        var background: UIBackgroundTaskIdentifier = .invalid
        var operation: Task<Void, Never>?
        var timer: Task<Void, Never>?
        var askStarted = false
        private(set) var finished = false
        private var replyHandler: (([String: Any]) -> Void)?

        init(replyHandler: @escaping ([String: Any]) -> Void) {
            self.replyHandler = replyHandler
        }

        func sendPending() {
            guard !finished, replyHandler != nil else { return }
            timer?.cancel()
            timer = nil
            reply(WatchResponse(ok: true, pending: true, project: project))
        }

        func finish(_ response: WatchResponse) {
            guard !finished else { return }
            finished = true
            timer?.cancel()
            timer = nil
            operation = nil
            if replyHandler != nil {
                reply(response)
            } else if WCSession.isSupported() {
                // 已回覆等待的長問題，最終答案連同專案識別交由系統排程送達。
                WCSession.default.transferUserInfo(Self.payload(response))
            }
            endBackground()
        }

        func expire() {
            guard !finished else { return }
            if askStarted {
                sendPending()
                endBackground()
            } else {
                operation?.cancel()
                finish(WatchResponse(ok: false, error: WatchProtocolError.unavailable.rawValue, project: project))
            }
        }

        private func reply(_ response: WatchResponse) {
            let handler = replyHandler
            replyHandler = nil
            handler?(Self.payload(response))
        }

        private static func payload(_ response: WatchResponse) -> [String: Any] {
            do { return [WatchWire.payloadKey: try WatchWire.encode(response)] }
            catch {
                // 協定固定版本的純字串錯誤回覆必定可編碼。
                let fallback = WatchResponse(ok: false, error: WatchProtocolError.invalidMessage.rawValue, project: response.project)
                return [WatchWire.payloadKey: try! WatchWire.encode(fallback)]
            }
        }

        private func endBackground() {
            guard background != .invalid else { return }
            UIApplication.shared.endBackgroundTask(background)
            background = .invalid
        }
    }
}

extension WatchSnapshot {
    static func make(board: Board, demo: Bool) -> WatchSnapshot {
        let cards = Dictionary(grouping: board.cards ?? [], by: \.projectId)
        let projects = board.projects.map { project in
            let projectCards = cards[project.id] ?? []
            let counts = WatchCounts(
                proposed: projectCards.filter { $0.column == "proposed" }.count,
                approved: projectCards.filter { $0.column == "approved" }.count,
                inProgress: projectCards.filter { $0.column == "running" || $0.column == "inProgress" }.count,
                blocked: projectCards.filter { $0.column == "blocked" }.count,
                done: projectCards.filter { $0.column == "done" }.count
            )
            if project.private == true {
                return WatchProject(id: project.id, name: String(localized: "隱私專案", bundle: AppLanguage.bundle),
                                    counts: counts, isPrivate: true)
            }
            let visibleCards = projectCards.filter { ["proposed", "blocked", "running", "inProgress"].contains($0.column) }.prefix(15).map {
                WatchCard(id: $0.id, title: $0.title, column: $0.column == "running" ? "inProgress" : $0.column,
                          agent: $0.agent, doneCriteria: $0.doneCriteria, note: $0.note)
            }
            return WatchProject(id: project.id, name: project.name, goal: project.state?.goal,
                                progress: project.state?.progress, nextSteps: Array((project.state?.nextSteps ?? []).prefix(3)),
                                blockers: Array((project.state?.blockers ?? []).prefix(3)), counts: counts, cards: visibleCards)
        }
        return WatchSnapshot(at: ISO8601DateFormatter().string(from: .now), demo: demo, projects: projects)
    }
}
