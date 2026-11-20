import XCTest

final class SettingsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(failingWrites: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-settingsFixture", "YES", "-noPush", "YES", "-mode", "board", "-settingsFixtureFailure", failingWrites ? "YES" : "NO"]
        app.launch()
        let title = app.navigationBars.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "選專案")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 20), "未經 fixture 登入進入 App")
        let more = app.buttons.matching(identifier: "more-menu").allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(more, "找不到右上角的 ⋯")
        more?.tap()
        let settings = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "menu-settings", "設定…")).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 10))
        return app
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func reveal(_ target: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<9 {
            if target.exists && target.isHittable && app.frame.intersects(target.frame) { return }
            if let form = app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) { form.swipeUp() }
            else if let form = app.tables.allElementsBoundByIndex.last(where: { $0.isHittable }) { form.swipeUp() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(target.exists && target.isHittable, "無法顯示 \(target.identifier)")
    }

    private func flip(_ toggle: XCUIElement) {
        let control = toggle.switches.firstMatch
        if control.exists { control.tap() } else { toggle.tap() }
    }

    private func open(_ tab: String, in app: XCUIApplication) {
        let link = element(app, "settings-\(tab)")
        reveal(link, in: app)
        link.tap()
    }

    private func backToSettings(_ app: XCUIApplication) {
        let back = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 5))
    }

    private func screenshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func lastWrite(_ app: XCUIApplication) throws -> [String: Any] {
        let receipt = element(app, "fixture-last-put")
        XCTAssertTrue(receipt.waitForExistence(timeout: 5))
        let wrote = NSPredicate(format: "label CONTAINS %@", "\"method\":\"PUT\"")
        expectation(for: wrote, evaluatedWith: receipt)
        waitForExpectations(timeout: 10)
        let data = try XCTUnwrap(receipt.label.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertOnlyPatch(_ app: XCUIApplication, _ expected: [String: Any]) throws {
        let record = try lastWrite(app)
        XCTAssertEqual(record["method"] as? String, "PUT")
        XCTAssertEqual(record["path"] as? String, "/api/settings")
        let body = try XCTUnwrap(record["body"] as? [String: Any])
        XCTAssertTrue(NSDictionary(dictionary: body).isEqual(to: ["settings": expected]), "PUT 不應夾帶未修改的設定: \(body)")
    }

    func testAllEightNativePagesAndScreenshots() {
        let app = launch()
        let pages: [(String, String)] = [
            ("general", "user.name"), ("ai", "ai-providers"),
            ("routing", "routing.chat.primary"), ("agents", "cards.defaultAgent"),
            ("access", "settings-password-status"), ("notify", "notify.kind"),
            ("plugins", "settings-plugins-list"), ("about", "settings-current-version")
        ]
        for (tab, identifier) in pages {
            XCTContext.runActivity(named: tab) { _ in
                open(tab, in: app)
                let marker = element(app, identifier)
                XCTAssertTrue(marker.waitForExistence(timeout: 10), "\(tab) 缺少原生欄位")
                XCTAssertEqual(app.webViews.count, 0, "設定分頁不得嵌網頁")
                XCTAssertGreaterThan(marker.frame.width, 0)
                XCTAssertTrue(app.frame.intersects(marker.frame), "欄位不得被裁到畫面外")
                if tab == "ai" { XCTAssertTrue(app.staticTexts["OpenAI"].firstMatch.waitForExistence(timeout: 5)) }
                if tab == "plugins" { XCTAssertTrue(app.staticTexts["LaTeX 編譯"].firstMatch.waitForExistence(timeout: 5)) }
                screenshot(app, "settings-\(tab == "agents" ? "agents" : tab)")
                backToSettings(app)
            }
        }
    }

    func testToggleSendsOnlyChangedField() throws {
        let app = launch()
        open("general", in: app)
        let toggle = app.switches["paths.usePiPrivacy"]
        reveal(toggle, in: app)
        XCTAssertEqual(toggle.value as? String, "0")
        flip(toggle)
        try assertOnlyPatch(app, ["paths": ["usePiPrivacy": true]])
        let enabled = NSPredicate(format: "value == %@", "1")
        expectation(for: enabled, evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
    }

    func testFailedToggleRollsBackAndShowsError() {
        let app = launch(failingWrites: true)
        open("general", in: app)
        let toggle = app.switches["paths.usePiPrivacy"]
        reveal(toggle, in: app)
        flip(toggle)
        let alert = app.alerts["設定失敗"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10))
        XCTAssertTrue(alert.staticTexts["測試儲存失敗"].exists)
        alert.buttons["好"].tap()
        XCTAssertEqual(toggle.value as? String, "0")
    }

    func testMaskedSecretIsNotSentWhenBlank() throws {
        let app = launch()
        open("notify", in: app)
        let modify = app.buttons["修改Bot token"]
        reveal(modify, in: app)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "已設定")).firstMatch.exists)
        XCTAssertFalse(app.secureTextFields["notify.telegram.botToken"].exists)
        modify.tap()
        let field = app.secureTextFields["notify.telegram.botToken"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("\n")
        XCTAssertEqual(element(app, "fixture-last-put").label, "尚無 PUT")
        XCTAssertTrue(modify.waitForExistence(timeout: 5))
        modify.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("fixture-replacement\n")
        try assertOnlyPatch(app, ["notify": ["telegram": ["botToken": "fixture-replacement"]]])
    }

    func testTextSavesOnKeyboardDone() throws {
        let app = launch()
        open("general", in: app)
        let field = app.textFields["user.name"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "測試使用者".count) + "原生設定")
        XCTAssertEqual(element(app, "fixture-last-put").label, "尚無 PUT", "輸入途中不應儲存")
        field.typeText("\n")
        try assertOnlyPatch(app, ["user": ["name": "原生設定"]])
    }
}
