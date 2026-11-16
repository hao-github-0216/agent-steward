import XCTest

final class DemoTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func assertBannerDoesNotCoverNavigation(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let banner = element(app, "demo-banner")
        XCTAssertTrue(banner.waitForExistence(timeout: 5), file: file, line: line)
        let frame = banner.frame
        XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
        let buttons = app.navigationBars.buttons.allElementsBoundByIndex.filter { $0.isHittable }
        XCTAssertFalse(buttons.isEmpty, file: file, line: line)
        for button in buttons + app.tabBars.buttons.allElementsBoundByIndex.filter({ $0.isHittable }) {
            XCTAssertFalse(frame.intersects(button.frame), "橫幅 \(frame) 遮住 \(button.label) \(button.frame)", file: file, line: line)
        }
    }

    func testDemoWalkthrough() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "YES", "-resetCodeLayout", "YES"]
        app.launch()
        defer { app.terminate() }

        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "加入一週天氣預報")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(app.navigationBars.buttons["設定"].exists)
        assertBannerDoesNotCoverNavigation(app)
        shot(app, "01-board")

        card.tap()
        XCTAssertTrue(app.navigationBars["工作卡"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["在今日天氣下方加入未來七天的預報卡片，先使用範例資料。"].waitForExistence(timeout: 5))
        shot(app, "02-card")
        app.buttons["關閉"].firstMatch.tap()

        element(app, "steward-ball").tap()
        let conversation = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "這些都是範例資料，沒有真的派工或執行程式。")).firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        shot(app, "03-chat")

        let input = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("請說明示範模式")
        app.buttons["送出"].tap()
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "這是示範模式，沒有連到真的管家。")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        shot(app, "04-demo-answer")
        app.buttons["關閉"].firstMatch.tap()

        app.buttons["程式碼"].firstMatch.tap()
        let readme = element(app, "row-README.md")
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        assertBannerDoesNotCoverNavigation(app)
        readme.tap()
        XCTAssertTrue(element(app, "tab-file:README.md").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["原文"].waitForExistence(timeout: 10))
        let preview = app.webViews["markdown-view"]
        let readmeText = preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch
        XCTAssertTrue(readmeText.waitForExistence(timeout: 20))
        let image = preview.descendants(matching: .any)["範例天氣圖示"].firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(image.frame.height, 50)
        XCTAssertTrue(preview.staticTexts["範例天氣：晴時多雲"].exists)
        assertBannerDoesNotCoverNavigation(app)
        shot(app, "05-readme")

        let git = app.segmentedControls.buttons["版本控制"]
        if !git.exists || !git.isHittable {
            let back = app.navigationBars.buttons["BackButton"]
            XCTAssertTrue(back.waitForExistence(timeout: 5))
            back.tap()
        }
        XCTAssertTrue(git.waitForExistence(timeout: 5))
        XCTAssertTrue(git.isHittable)
        git.tap()
        XCTAssertTrue(git.isSelected)
        XCTAssertTrue(app.buttons["全部暫存"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["weather.py"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "變更(1)")).firstMatch.exists)
        assertBannerDoesNotCoverNavigation(app)
        shot(app, "06-git-status")

        app.buttons["demo-exit"].tap()
        XCTAssertTrue(element(app, "server-url").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["demo-enter"].exists)
        shot(app, "07-setup")
    }
}
