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

    private func reveal(_ target: XCUIElement, in app: XCUIApplication, towardTop: Bool = false) {
        for _ in 0..<9 {
            if target.exists && target.isHittable && app.frame.intersects(target.frame) { return }
            let form = app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ??
                app.tables.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app
            if towardTop { form.swipeDown() } else { form.swipeUp() }
        }
        XCTAssertTrue(target.exists && target.isHittable, "無法顯示 \(target.identifier)")
    }

    private func assertNoSettingsError(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(app.alerts["設定失敗"].exists, file: file, line: line)
        let errors = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ OR label CONTAINS %@ OR label CONTAINS %@ OR label CONTAINS %@",
            "示範模式沒有這個功能", "看不懂管家的回應", "連不上管家", "範例資料未定義的路由"
        ))
        XCTAssertEqual(errors.count, 0, "示範設定頁不應顯示錯誤", file: file, line: line)
    }

    private func walkSettings(_ app: XCUIApplication) {
        app.buttons["看板"].firstMatch.tap()
        let settings = app.navigationBars.buttons["設定"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 10))
        let pages: [(String, String)] = [
            ("general", "user.name"), ("ai", "ai-providers"),
            ("routing", "routing.chat.primary"), ("agents", "cards.defaultAgent"),
            ("access", "settings-password-status"), ("notify", "notify.kind"),
            ("plugins", "settings-plugins-list"), ("about", "settings-current-version")
        ]
        for (tab, identifier) in pages {
            XCTContext.runActivity(named: "示範設定：\(tab)") { _ in
                let link = element(app, "settings-\(tab)")
                reveal(link, in: app)
                link.tap()
                let marker = element(app, identifier)
                XCTAssertTrue(marker.waitForExistence(timeout: 10), "\(tab) 缺少原生欄位")
                XCTAssertGreaterThan(marker.frame.width, 0)
                XCTAssertTrue(app.frame.intersects(marker.frame), "欄位不得被裁到畫面外")
                XCTAssertEqual(app.webViews.count, 0, "設定分頁不得嵌網頁")
                switch tab {
                case "general":
                    let name = app.textFields["user.name"]
                    let original = name.value as? String ?? ""
                    name.tap()
                    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: original.count) + "示範使用者\n")
                    let renamed = NSPredicate(format: "value == %@", "示範使用者")
                    expectation(for: renamed, evaluatedWith: name)
                    waitForExpectations(timeout: 5)
                    let toggle = app.switches["paths.usePiPrivacy"]
                    reveal(toggle, in: app)
                    XCTAssertEqual(toggle.value as? String, "0")
                    let control = toggle.switches.firstMatch
                    if control.exists { control.tap() } else { toggle.tap() }
                    let enabled = NSPredicate(format: "value == %@", "1")
                    expectation(for: enabled, evaluatedWith: toggle)
                    waitForExpectations(timeout: 5)
                    app.navigationBars.buttons["重新整理"].tap()
                    reveal(toggle, in: app)
                    expectation(for: enabled, evaluatedWith: toggle)
                    waitForExpectations(timeout: 5)
                    reveal(name, in: app, towardTop: true)
                    XCTAssertEqual(name.value as? String, "示範使用者")
                case "ai":
                    XCTAssertTrue(app.staticTexts["OpenAI"].firstMatch.waitForExistence(timeout: 5))
                    XCTAssertTrue(app.buttons["用 ChatGPT 登入"].waitForExistence(timeout: 5))
                case "agents":
                    XCTAssertTrue(app.staticTexts["Claude Code"].firstMatch.waitForExistence(timeout: 5))
                case "notify":
                    let status = element(app, "notify.phonePushStatus")
                    reveal(status, in: app)
                    XCTAssertTrue(status.waitForExistence(timeout: 5))
                    XCTAssertTrue(status.label.contains("還沒設定推播中繼"))
                    XCTAssertFalse(element(app, "notify.testPhonePush").exists)
                    XCTAssertFalse(element(app, "notify.phonePushEncryptionWarning").exists)
                    let test = app.buttons["notify.test"]
                    reveal(test, in: app)
                    test.tap()
                    XCTAssertTrue(app.staticTexts["已送出測試推播"].waitForExistence(timeout: 5))
                case "plugins":
                    XCTAssertTrue(app.staticTexts["LaTeX 編譯"].firstMatch.waitForExistence(timeout: 5))
                case "about":
                    XCTAssertTrue(marker.label.contains("0.4.0"))
                default: break
                }
                assertNoSettingsError(app)
                let back = app.navigationBars.buttons.element(boundBy: 0)
                XCTAssertTrue(back.waitForExistence(timeout: 5))
                back.tap()
                XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 5))
                assertNoSettingsError(app)
            }
        }
        shot(app, "08-settings")
        app.navigationBars.buttons["完成"].tap()
        let notice = element(app, "demo-write-notice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertTrue(notice.label.contains("示範模式不會真的執行"))
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

        walkSettings(app)

        app.buttons["demo-exit"].tap()
        XCTAssertTrue(element(app, "server-url").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["demo-enter"].exists)
        shot(app, "07-setup")
    }
}
