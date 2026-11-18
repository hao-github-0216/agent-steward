#if DEBUG
import Foundation

@MainActor
final class WatchFixture {
    static var isEnabled: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-watchFixture"), arguments.indices.contains(index + 1) else {
            return false
        }
        return arguments[index + 1] == "YES"
    }

    private(set) var snapshot: WatchSnapshot
    private var chat: [WatchChatLine]
    private let english: Bool

    init() {
        let english = Locale.preferredLanguages.first?.hasPrefix("en") == true
        self.english = english
        snapshot = WatchSnapshot(
            at: ISO8601DateFormatter().string(from: Date()),
            demo: true,
            projects: [
                WatchProject(
                    id: "watch-weather",
                    name: english ? "Weather Helper" : "天氣小幫手",
                    goal: english ? "Make everyday weather easier to plan around." : "讓每天的天氣更容易安排。",
                    progress: english
                        ? "Rain reminders are in progress.\nThe daily forecast is ready.\nLocation settings are ready.\nNotifications are being checked.\nA weekly forecast is next."
                        : "正在加入降雨提醒。\n每日預報已完成。\n地點設定已完成。\n正在檢查通知。\n下一步是一週預報。",
                    nextSteps: [english ? "Review the weekly forecast proposal." : "看看一週預報的提案。"],
                    blockers: [english ? "Choose a reminder time." : "需要選擇提醒時間。"],
                    counts: WatchCounts(proposed: 1, inProgress: 1, blocked: 1),
                    cards: [
                        WatchCard(
                            id: "watch-proposal",
                            title: english ? "Add a weekly forecast" : "加入一週預報",
                            column: "proposed",
                            agent: "Claude Code",
                            doneCriteria: english ? "Show the next seven days of weather." : "顯示未來七天的天氣。",
                            note: english ? "Keep the forecast easy to scan." : "讓預報一眼就看懂。"
                        ),
                        WatchCard(id: "watch-blocked", title: english ? "Choose reminder time" : "選擇提醒時間", column: "blocked"),
                        WatchCard(id: "watch-progress-card", title: english ? "Add rain reminders" : "加入降雨提醒", column: "inProgress")
                    ]
                ),
                WatchProject(id: "watch-private", name: "", counts: WatchCounts(proposed: 2, blocked: 1), isPrivate: true)
            ]
        )
        chat = english ? [
            WatchChatLine(role: "user", text: "How far along is this project?"),
            WatchChatLine(role: "assistant", text: "The daily forecast is ready. **Rain reminders** are next."),
            WatchChatLine(role: "user", text: "What is blocked?"),
            WatchChatLine(role: "assistant", text: "The weather icon style is still undecided, so the icon card is paused."),
        ] : [
            WatchChatLine(role: "user", text: "這個專案做到哪了？"),
            WatchChatLine(role: "assistant", text: "每日預報已完成，接著加入**降雨提醒**。"),
            WatchChatLine(role: "user", text: "現在卡在哪？"),
            WatchChatLine(role: "assistant", text: "天氣圖示的樣式還沒決定，圖示工作卡先暫停。"),
        ]
    }

    func reply(to action: WatchRequest.Action) throws -> WatchResponse {
        // 假資料也經過共用編解碼，避免測試走不同的協定格式。
        let request = try WatchWire.decode(WatchRequest.self, from: WatchWire.encode(WatchRequest(action)))
        let response: WatchResponse
        switch request.action {
        case .refresh:
            snapshot.at = ISO8601DateFormatter().string(from: Date())
            response = WatchResponse(ok: true, snapshot: snapshot)
        case .suggestions(let project):
            try validate(project)
            response = WatchResponse(ok: true, suggestions: [
                english ? "What could we do next?" : "下一步可以先做什麼？",
                english ? "What is blocked?" : "目前卡在哪裡？"
            ], project: project)
        case .chat(let project):
            try validate(project)
            response = WatchResponse(ok: true, chat: Array(chat.suffix(5)), project: project)
        case .ask(let project, let text):
            try validate(project)
            chat.append(WatchChatLine(role: "user", text: text))
            let answer = english
                ? "We could **add a weekly forecast** next.\n\n```swift\nlet forecast = 7\n```"
                : "下一步可以**加入一週預報**。\n\n```swift\nlet forecast = 7\n```"
            chat.append(WatchChatLine(role: "assistant", text: answer))
            response = WatchResponse(ok: true, answer: answer, chat: Array(chat.suffix(5)), project: project)
        case .agents:
            response = WatchResponse(ok: true, agents: [
                WatchAgent(id: "claude-code", name: "Claude Code"),
                WatchAgent(id: "codex", name: "Codex")
            ])
        case .askCard(let cardID, let text):
            let (projectIndex, _) = try cardLocation(cardID)
            let projectID = snapshot.projects[projectIndex].id
            try validate(projectID)
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WatchProtocolError.invalidMessage }
            response = WatchResponse(ok: true, project: projectID)
        case .assignCard(let cardID, let agent):
            let (projectIndex, cardIndex) = try cardLocation(cardID)
            let projectID = snapshot.projects[projectIndex].id
            try validate(projectID)
            snapshot.projects[projectIndex].cards[cardIndex].agent = agent
            response = WatchResponse(ok: true, snapshot: snapshot, project: projectID)
        case .draftCard(let project, _):
            try validate(project)
            response = WatchResponse(ok: true, project: project)
        case .move(let cardID, let column):
            guard let projectIndex = snapshot.projects.firstIndex(where: { project in project.cards.contains { $0.id == cardID } }),
                  let cardIndex = snapshot.projects[projectIndex].cards.firstIndex(where: { $0.id == cardID }) else {
                throw WatchProtocolError.notFound
            }
            let previous = snapshot.projects[projectIndex].cards[cardIndex].column
            guard (previous == "proposed" && ["approved", "rejected"].contains(column))
                    || (previous == "blocked" && ["approved", "done"].contains(column)) else {
                throw WatchProtocolError.invalidMove
            }
            snapshot.projects[projectIndex].cards[cardIndex].column = column
            let cards = snapshot.projects[projectIndex].cards
            snapshot.projects[projectIndex].counts = WatchCounts(
                proposed: cards.filter { $0.column == "proposed" }.count,
                approved: cards.filter { $0.column == "approved" }.count,
                inProgress: cards.filter { $0.column == "inProgress" }.count,
                blocked: cards.filter { $0.column == "blocked" }.count,
                done: cards.filter { $0.column == "done" }.count
            )
            response = WatchResponse(ok: true, snapshot: snapshot)
        }
        return try WatchWire.decode(WatchResponse.self, from: WatchWire.encode(response))
    }

    private func cardLocation(_ cardID: String) throws -> (Int, Int) {
        guard let projectIndex = snapshot.projects.firstIndex(where: { $0.cards.contains { $0.id == cardID } }),
              let cardIndex = snapshot.projects[projectIndex].cards.firstIndex(where: { $0.id == cardID }) else {
            throw WatchProtocolError.notFound
        }
        return (projectIndex, cardIndex)
    }

    private func validate(_ projectID: String) throws {
        guard let project = snapshot.projects.first(where: { $0.id == projectID }) else {
            throw WatchProtocolError.notFound
        }
        guard !project.isPrivate else { throw WatchProtocolError.privateProject }
    }
}
#endif
