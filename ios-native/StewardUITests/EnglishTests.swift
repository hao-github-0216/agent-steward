import XCTest

final class EnglishTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(languages: String = "(en)", locale: String = "en_US") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", languages, "-AppleLocale", locale, "-demo", "YES", "-resetCodeLayout", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        return app
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func assertEnglish(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label MATCHES %@", #"(?s).*[\u3400-\u9fff\uf900-\ufaff\x{20000}-\x{323af}].*"#)
        let elements = app.staticTexts.matching(predicate).allElementsBoundByIndex + app.buttons.matching(predicate).allElementsBoundByIndex
        let failures = elements.compactMap { element -> String? in
            // UIKit 依系統語言加上的選單無障礙後綴，不屬於 App 顯示的文字。
            let label = element.label.replacingOccurrences(of: #", 「動作」選單$"#, with: "", options: .regularExpression)
            let containsCJK = label.unicodeScalars.contains {
                (0x3400...0x9FFF).contains($0.value) || (0xF900...0xFAFF).contains($0.value) ||
                    (0x20000...0x323AF).contains($0.value)
            }
            return containsCJK ? "\(element.identifier): \(label)" : nil
        }
        XCTAssertTrue(failures.isEmpty, "英文畫面出現中文字：\n" + failures.joined(separator: "\n"), file: file, line: line)
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        assertEnglish(app)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func reveal(_ target: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<9 {
            if target.exists && target.isHittable && app.frame.intersects(target.frame) { return }
            let form = app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ??
                app.tables.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app
            form.swipeUp()
        }
        XCTAssertTrue(target.exists && target.isHittable, "無法顯示 \(target.identifier)")
    }

    private func walkSettings(_ app: XCUIApplication) {
        app.buttons["Board"].firstMatch.tap()
        let settings = app.navigationBars.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 10))
        shot(app, "en-07-settings")
        let pages: [(String, String)] = [
            ("general", "user.name"), ("ai", "ai-providers"),
            ("routing", "routing.chat.primary"), ("agents", "cards.defaultAgent"),
            ("access", "settings-password-status"), ("notify", "notify.kind"),
            ("plugins", "settings-plugins-list"), ("about", "settings-current-version")
        ]
        for (tab, identifier) in pages {
            XCTContext.runActivity(named: "English settings: \(tab)") { _ in
                let link = element(app, "settings-\(tab)")
                reveal(link, in: app)
                link.tap()
                XCTAssertTrue(element(app, identifier).waitForExistence(timeout: 10))
                XCTAssertEqual(app.webViews.count, 0)
                shot(app, "en-08-settings-\(tab)")
                let form = app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ??
                    app.tables.allElementsBoundByIndex.last(where: { $0.isHittable })
                for _ in 0..<2 {
                    form?.swipeUp()
                    assertEnglish(app)
                }
                let back = app.navigationBars.buttons.element(boundBy: 0)
                XCTAssertTrue(back.waitForExistence(timeout: 5))
                back.tap()
                XCTAssertTrue(element(app, "settings-general").waitForExistence(timeout: 5))
                assertEnglish(app)
            }
        }
        app.navigationBars.buttons["Done"].tap()
    }

    func testEnglishDemoWalkthrough() {
        let app = launch()
        defer { app.terminate() }
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Add a weekly weather forecast")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Board"].firstMatch.exists)
        shot(app, "en-01-board")

        card.tap()
        XCTAssertTrue(app.navigationBars["Card"].waitForExistence(timeout: 5))
        let instructions = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Add forecast cards for the next seven days")).firstMatch
        XCTAssertTrue(instructions.waitForExistence(timeout: 5))
        shot(app, "en-02-card")
        app.buttons["Close"].firstMatch.tap()

        element(app, "steward-ball").tap()
        let conversation = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "This is all sample data.")).firstMatch
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        shot(app, "en-03-chat")
        let input = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Explain demo mode")
        app.buttons["Send"].tap()
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "This is demo mode, with no connection to a real steward.")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 10))
        shot(app, "en-04-demo-answer")
        app.buttons["Close"].firstMatch.tap()

        app.buttons["Code"].firstMatch.tap()
        let openSidebar = app.buttons["Open sidebar"].firstMatch
        if openSidebar.exists {
            shot(app, "en-05-code-sidebar-closed")
            openSidebar.tap()
        }
        let readme = element(app, "row-README.md")
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        XCTAssertTrue(element(app, "tab-file:README.md").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Source"].waitForExistence(timeout: 10))
        let preview = app.webViews["markdown-view"]
        let title = preview.staticTexts["Weather Helper"]
        XCTAssertTrue(title.waitForExistence(timeout: 20))
        shot(app, "en-05-code")

        let git = app.segmentedControls.buttons["Version control"]
        if !git.exists || !git.isHittable {
            let back = app.navigationBars.buttons["BackButton"]
            XCTAssertTrue(back.waitForExistence(timeout: 5))
            back.tap()
        }
        XCTAssertTrue(git.waitForExistence(timeout: 5))
        git.tap()
        XCTAssertTrue(git.isSelected)
        XCTAssertTrue(app.buttons["Stage all"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["weather.py"].firstMatch.waitForExistence(timeout: 5))
        shot(app, "en-06-git")
        let log = app.buttons["Recent commits"]
        reveal(log, in: app)
        XCTAssertTrue(log.waitForExistence(timeout: 5))
        log.tap()
        let commit = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Add tests for today")).firstMatch
        XCTAssertTrue(commit.waitForExistence(timeout: 10))
        shot(app, "en-06-git-log")

        walkSettings(app)
        app.buttons["demo-exit"].tap()
        XCTAssertTrue(element(app, "server-url").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["demo-enter"].exists)
        shot(app, "en-09-setup")
    }

    func testNonChinesePrimaryLanguageUsesEnglish() {
        let app = launch(languages: "(fr, zh-Hant)", locale: "fr_FR")
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["Board"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Add a weekly weather forecast")).firstMatch.exists)
        assertEnglish(app)
    }

    func testSimplifiedChineseUsesTraditionalChinese() {
        let app = launch(languages: "(zh-Hans, en)", locale: "zh_CN")
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "加入一週天氣預報")).firstMatch.exists)
        XCTAssertTrue(app.navigationBars.buttons["設定"].exists)
    }
}
