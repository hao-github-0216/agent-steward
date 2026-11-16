import XCTest

final class WatchWalkthroughTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func reveal(_ target: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<12 {
            if target.exists && target.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(target.exists && target.isHittable, "無法顯示 \(target.identifier)")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func back(_ app: XCUIApplication) {
        let identified = app.buttons["BackButton"].firstMatch
        let button = identified.exists ? identified : app.navigationBars.buttons.firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    private func walk(language: String) {
        let english = language == "en"
        let app = XCUIApplication()
        app.launchArguments = ["-watchFixture", "YES", "-AppleLanguages", "(\(language))", "-AppleLocale", english ? "en_US" : "zh_TW"]
        app.launch()
        defer { app.terminate() }

        let project = element(app, "watch-project-watch-weather")
        XCTAssertTrue(element(app, "watch-projects").waitForExistence(timeout: 20))
        reveal(project, in: app)
        XCTAssertTrue(project.label.contains(english ? "Weather Helper" : "天氣小幫手"))
        shot(app, "watch-01-projects")
        project.tap()

        let progress = element(app, "watch-progress")
        reveal(progress, in: app)
        XCTAssertTrue(progress.label.contains(english ? "Rain reminders are in progress." : "正在加入降雨提醒。"))
        shot(app, "watch-02-project")

        let cards = element(app, "watch-cards")
        reveal(cards, in: app)
        cards.tap()
        let card = element(app, "watch-card-watch-proposal")
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        shot(app, "watch-03-cards")
        card.tap()

        let approve = element(app, "watch-approve")
        reveal(approve, in: app)
        XCTAssertTrue(approve.label.contains(english ? "Approve and dispatch" : "核准派工"))
        shot(app, "watch-04-card")
        back(app)
        back(app)

        let ask = element(app, "watch-ask")
        reveal(ask, in: app)
        ask.tap()
        let suggestion = element(app, "watch-suggestion-0")
        XCTAssertTrue(suggestion.waitForExistence(timeout: 10))
        reveal(suggestion, in: app)
        XCTAssertTrue(suggestion.label.contains(english ? "What could we do next?" : "下一步可以先做什麼？"))
        shot(app, "watch-05-ask")
    }

    func testEnglishWalkthrough() {
        walk(language: "en")
    }

    func testTraditionalChineseWalkthrough() {
        walk(language: "zh-Hant")
    }
}
