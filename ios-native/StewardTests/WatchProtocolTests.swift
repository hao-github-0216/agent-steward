import XCTest
@testable import Steward

final class WatchProtocolTests: XCTestCase {
    private func project(_ id: String = "weather", isPrivate: Bool = false) -> Project {
        Project(id: id, name: "Weather Helper", kind: "project", status: "active", private: isPrivate,
                state: ProjectState(goal: "Build a weather app", progress: "Rain reminders are in progress.",
                                    nextSteps: ["Test reminders"], blockers: ["Choose icons"]))
    }

    private func card(_ id: String, project: String = "weather", column: String = "proposed") -> Card {
        Card(id: id, projectId: project, title: "Add a forecast", agent: "Sample Assistant",
             doneCriteria: "Seven readable days", column: column, note: "Choose an icon style")
    }

    func testSnapshotRoundTrip() throws {
        let original = WatchSnapshot.make(board: Board(projects: [project()], cards: [card("forecast")]), demo: false)
        let data = try original.encodedForContext()
        let decoded = try WatchWire.decode(WatchSnapshot.self, from: data)
        XCTAssertEqual(original, decoded)
        XCTAssertEqual(decoded.v, 1)
        XCTAssertNotNil(ISO8601DateFormatter().date(from: decoded.at))
    }

    func testSnapshotOnlyHasActiveProjectsNewestFirst() {
        var older = project("older"); older.lastActivityAt = "2026-11-01T00:00:00Z"
        var newer = project("newer"); newer.lastActivityAt = "2026-11-15T00:00:00Z"
        var closed = project("closed"); closed.status = "closed"
        var ignored = project("ignored"); ignored.status = "ignored"
        var pending = project("pending"); pending.status = "pending"
        var misc = project("misc"); misc.kind = "builtin"
        let board = Board(projects: [older, closed, ignored, pending, misc, newer])
        XCTAssertEqual(WatchSnapshot.make(board: board, demo: false).projects.map(\.id), ["newer", "older"])
    }

    func testRejectOtherVersions() throws {
        var snapshot = WatchSnapshot.make(board: Board(projects: [project()]), demo: false)
        snapshot.v = 2
        XCTAssertThrowsError(try WatchWire.decode(WatchSnapshot.self, from: JSONEncoder().encode(snapshot))) {
            XCTAssertEqual($0 as? WatchProtocolError, .unsupportedVersion)
        }
        var request = WatchRequest(.refresh)
        request.v = 2
        XCTAssertThrowsError(try WatchWire.decode(WatchRequest.self, from: JSONEncoder().encode(request))) {
            XCTAssertEqual($0 as? WatchProtocolError, .unsupportedVersion)
        }
        let response = WatchResponse(ok: true, snapshot: snapshot)
        XCTAssertThrowsError(try WatchWire.decode(WatchResponse.self, from: JSONEncoder().encode(response))) {
            XCTAssertEqual($0 as? WatchProtocolError, .unsupportedVersion)
        }
        XCTAssertThrowsError(try WatchWire.encode(snapshot))
    }

    func testRejectMalformedMessages() {
        for value in ["not json", "{}", "{\"v\":1}", "{\"v\":1,\"action\":{\"delete\":{}}}"] {
            XCTAssertThrowsError(try WatchWire.decode(WatchRequest.self, from: Data(value.utf8))) {
                XCTAssertEqual($0 as? WatchProtocolError, .invalidMessage)
            }
        }
    }

    func testPrivateProjectContainsOnlyCounts() throws {
        var hidden = project(isPrivate: true)
        hidden.name = "Secret project name"
        hidden.state = ProjectState(goal: "Secret goal", progress: "Secret progress", nextSteps: ["Secret next"], blockers: ["Secret blocker"])
        var secretCard = card("secret-card")
        secretCard.title = "Secret card title"
        let columns = ["proposed", "approved", "running", "blocked", "done"]
        let cards = columns.enumerated().map { index, column in card("card-\(index)", column: column) } + [secretCard]
        let snapshot = WatchSnapshot.make(board: Board(projects: [hidden], cards: cards), demo: false)
        let value = try XCTUnwrap(snapshot.projects.first)
        XCTAssertTrue(value.isPrivate)
        XCTAssertEqual(value.name, String(localized: "隱私專案", bundle: AppLanguage.bundle))
        XCTAssertNil(value.goal)
        XCTAssertNil(value.progress)
        XCTAssertTrue(value.nextSteps.isEmpty)
        XCTAssertTrue(value.blockers.isEmpty)
        XCTAssertTrue(value.cards.isEmpty)
        XCTAssertEqual(value.counts, WatchCounts(proposed: 2, approved: 1, inProgress: 1, blocked: 1, done: 1))
        let text = String(decoding: try snapshot.encodedForContext(), as: UTF8.self)
        XCTAssertFalse(text.contains("Secret"))
        XCTAssertFalse(text.contains("secret-card"))
    }

    func testOversizeBoardIsTruncatedBelow60KB() throws {
        let projects = (0..<20).map { index -> Project in
            var value = project("project-\(index)")
            value.state?.progress = String(repeating: "Very long progress. ", count: 4_000)
            return value
        }
        let cards = projects.flatMap { project in
            (0..<30).map { index -> Card in
                var value = card("\(project.id)-\(index)", project: project.id)
                value.note = String(repeating: "Long card note. ", count: 200)
                return value
            }
        }
        let snapshot = WatchSnapshot.make(board: Board(projects: projects, cards: cards), demo: false)
        XCTAssertGreaterThan(try WatchWire.encode(snapshot).count, WatchWire.snapshotByteLimit)
        let data = try snapshot.encodedForContext()
        XCTAssertLessThan(data.count, 60_000)
        let decoded = try WatchWire.decode(WatchSnapshot.self, from: data)
        XCTAssertEqual(decoded.projects.count, projects.count)
        XCTAssertTrue(decoded.projects.allSatisfy { $0.counts.proposed == 30 })
        XCTAssertLessThan(decoded.projects.reduce(0) { $0 + $1.cards.count }, 20 * 15)
    }

    func testDemoBoardProjectCounts() throws {
        let data = try JSONSerialization.data(withJSONObject: ["projects": DemoData.projects, "cards": DemoData.cards])
        let board = try JSONDecoder().decode(Board.self, from: data)
        let snapshot = WatchSnapshot.make(board: board, demo: true)
        XCTAssertTrue(snapshot.demo)
        // 示範資料的「雜務」不是專案,手錶只放兩個進行中的專案
        XCTAssertEqual(snapshot.projects.count, 2)
        XCTAssertFalse(snapshot.projects.contains { $0.id == "demo-errands" })
        let weather = try XCTUnwrap(snapshot.projects.first { $0.id == DemoData.projectID })
        XCTAssertEqual(weather.counts, WatchCounts(proposed: 2, approved: 1, inProgress: 2, blocked: 1, done: 2))
        XCTAssertEqual(weather.cards.count, 5)
        XCTAssertTrue(snapshot.projects.filter { $0.id != DemoData.projectID }.allSatisfy { $0.counts == WatchCounts() })
    }

    func testOnlyActionableCardsAndAtMostFifteen() throws {
        let columns = ["proposed", "approved", "running", "blocked", "done", "rejected"]
        let cards = (0..<60).map { card("card-\($0)", column: columns[$0 % columns.count]) }
        let snapshot = WatchSnapshot.make(board: Board(projects: [project()], cards: cards), demo: false)
        let value = try XCTUnwrap(snapshot.projects.first)
        XCTAssertEqual(value.cards.count, 15)
        XCTAssertTrue(value.cards.allSatisfy { ["proposed", "blocked", "inProgress"].contains($0.column) })
        XCTAssertEqual(value.counts, WatchCounts(proposed: 10, approved: 10, inProgress: 10, blocked: 10, done: 10))
    }

    func testNextStepsAndBlockersAreLimitedToThree() throws {
        var source = project()
        source.state?.nextSteps = (0..<10).map { "Step \($0)" }
        source.state?.blockers = (0..<10).map { "Blocker \($0)" }
        let value = try XCTUnwrap(WatchSnapshot.make(board: Board(projects: [source]), demo: false).projects.first)
        XCTAssertEqual(value.nextSteps, ["Step 0", "Step 1", "Step 2"])
        XCTAssertEqual(value.blockers, ["Blocker 0", "Blocker 1", "Blocker 2"])
    }

    func testRequestAndResponseRoundTrips() throws {
        let actions: [WatchRequest.Action] = [.refresh, .suggestions(project: "weather"), .ask(project: "weather", text: "What next?"),
                                               .chat(project: "weather"), .move(card: "forecast", column: "approved")]
        for action in actions {
            let request = WatchRequest(action)
            XCTAssertEqual(try WatchWire.decode(WatchRequest.self, from: WatchWire.encode(request)), request)
        }
        let response = WatchResponse(ok: true, answer: "Ready", pending: true,
                                     chat: [WatchChatLine(role: "bot", text: "Ready", at: "2026-11-16T00:00:00Z")], project: "weather")
        XCTAssertEqual(try WatchWire.decode(WatchResponse.self, from: WatchWire.encode(response)), response)
    }

    func testDoesNotSendIrreducibleOversizeSnapshot() {
        let snapshot = WatchSnapshot(at: "2026-11-16T00:00:00Z", demo: false,
                                     projects: [WatchProject(id: "huge", name: String(repeating: "x", count: 70_000))])
        XCTAssertThrowsError(try snapshot.encodedForContext()) {
            XCTAssertEqual($0 as? WatchProtocolError, .snapshotTooLarge)
        }
    }
}
