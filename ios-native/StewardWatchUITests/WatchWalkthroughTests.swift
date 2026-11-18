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

    private func launchFixture(language: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-watchFixture", "YES", "-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "zh_TW"]
        app.launch()
        XCTAssertTrue(element(app, "watch-projects").waitForExistence(timeout: 20))
        return app
    }

    private func walk(language: String) {
        let english = language == "en"
        let app = launchFixture(language: language)
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

    private func approveFromLongPress(language: String) {
        let app = launchFixture(language: language)
        defer { app.terminate() }
        let project = element(app, "watch-project-watch-weather")
        reveal(project, in: app)
        shot(app, "\(language)-card-01-projects")
        project.tap()
        let cards = element(app, "watch-cards")
        reveal(cards, in: app)
        shot(app, "\(language)-card-02-project")
        cards.tap()
        let proposal = element(app, "watch-card-watch-proposal")
        XCTAssertTrue(proposal.waitForExistence(timeout: 5))
        reveal(proposal, in: app)
        shot(app, "\(language)-card-03-list")
        proposal.press(forDuration: 0.8)
        XCTAssertTrue(element(app, "watch-card-menu").waitForExistence(timeout: 5))
        shot(app, "\(language)-card-04-menu")
        let approve = element(app, "watch-card-menu-approve")
        reveal(approve, in: app)
        approve.tap()
        let confirm = app.tables.buttons[language == "en" ? "Approve and dispatch" : "核准派工"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot(app, "\(language)-card-05-confirmation")
        confirm.tap()
        let result = app.staticTexts[language == "en" ? "Approved" : "已核准"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "watch-card-menu").exists)
        XCTAssertFalse(proposal.exists, "The approved card must leave the proposal section")
        XCTAssertTrue(element(app, "watch-card-watch-blocked").exists)
        shot(app, "\(language)-card-06-approved")
    }

    private func askFromProjectLongPress(language: String) {
        let app = launchFixture(language: language)
        defer { app.terminate() }
        let project = element(app, "watch-project-watch-weather")
        reveal(project, in: app)
        shot(app, "\(language)-project-01-list")
        project.press(forDuration: 0.8)
        XCTAssertTrue(element(app, "watch-project-menu").waitForExistence(timeout: 5))
        shot(app, "\(language)-project-02-menu")
        let ask = element(app, "watch-project-menu-ask")
        reveal(ask, in: app)
        ask.tap()
        XCTAssertTrue(element(app, "watch-ask-page").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "watch-suggestion-0").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "watch-project-menu").exists)
        shot(app, "\(language)-project-03-ask")
    }

    private func draftFromBubbleLongPress(language: String) {
        let app = launchFixture(language: language)
        defer { app.terminate() }
        let project = element(app, "watch-project-watch-weather")
        reveal(project, in: app)
        shot(app, "\(language)-bubble-01-projects")
        project.tap()
        let ask = element(app, "watch-ask")
        reveal(ask, in: app)
        shot(app, "\(language)-bubble-02-project")
        ask.tap()
        let answer = element(app, "watch-bubble-3")
        XCTAssertTrue(answer.waitForExistence(timeout: 10))
        reveal(answer, in: app)
        shot(app, "\(language)-bubble-03-answer")
        answer.press(forDuration: 0.8)
        XCTAssertTrue(element(app, "watch-bubble-menu").waitForExistence(timeout: 5))
        for identifier in ["watch-bubble-speak", "watch-bubble-draft", "watch-bubble-handoff"] {
            XCTAssertTrue(element(app, identifier).exists, identifier)
        }
        shot(app, "\(language)-bubble-04-menu")
        let draft = element(app, "watch-bubble-draft")
        reveal(draft, in: app)
        draft.tap()
        let confirm = app.tables.buttons[language == "en" ? "Make a card draft" : "做成工作卡草稿"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot(app, "\(language)-bubble-05-confirmation")
        confirm.tap()
        let result = app.staticTexts[language == "en" ? "Draft sent to iPhone" : "草稿已送到 iPhone"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        reveal(result, in: app)
        shot(app, "\(language)-bubble-06-draft-sent")
    }

    func testEnglishCardLongPressApproval() {
        approveFromLongPress(language: "en")
    }

    func testTraditionalChineseCardLongPressApproval() {
        approveFromLongPress(language: "zh-Hant")
    }

    func testEnglishProjectLongPressAsk() {
        askFromProjectLongPress(language: "en")
    }

    func testTraditionalChineseProjectLongPressAsk() {
        askFromProjectLongPress(language: "zh-Hant")
    }

    func testEnglishBubbleLongPressDraft() {
        draftFromBubbleLongPress(language: "en")
    }

    func testTraditionalChineseBubbleLongPressDraft() {
        draftFromBubbleLongPress(language: "zh-Hant")
    }

    func testEnglishWalkthrough() {
        walk(language: "en")
    }

    func testTraditionalChineseWalkthrough() {
        walk(language: "zh-Hant")
    }
}
