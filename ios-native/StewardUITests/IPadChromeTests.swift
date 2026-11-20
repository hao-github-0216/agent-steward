import XCTest

final class IPadChromeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = true
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("只檢查 iPad 的浮動切換列") }
    }

    override func tearDown() {
        XCUIApplication().terminate()
        XCUIDevice.shared.orientation = .portrait
        super.tearDown()
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func launch(_ orientation: UIDeviceOrientation) -> XCUIApplication {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW",
                               "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES",
                               "-codeSection", "files", "-ballCorner", "br"]
        app.launch()
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 20))
        app.buttons["程式碼"].firstMatch.tap()
        setSidebar(app, open: true)
        let readme = element(app, "row-README.md")
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        XCTAssertTrue(element(app, "tab-file:README.md").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["原文"].waitForExistence(timeout: 15))
        return app
    }

    private func launchFloatingChat() -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW",
                               "-demo", "YES", "-resetCodeLayout", "YES", "-resetChatWindow", "YES",
                               "-noPush", "YES", "-codeSection", "files", "-ballCorner", "br", "-mode", "board"]
        app.launch()
        let ball = element(app, "steward-ball")
        XCTAssertTrue(ball.waitForExistence(timeout: 20))
        ball.tap()
        XCTAssertTrue(element(app, "chat-window").waitForExistence(timeout: 10))
        return app
    }

    func testFloatingChatDoesNotBlockBackground() {
        let app = launchFloatingChat()
        let window = element(app, "chat-window")
        app.buttons["程式碼"].firstMatch.tap()
        XCTAssertTrue(window.exists, "切換分頁不能關閉問管家")
        setSidebar(app, open: true)
        let readme = element(app, "row-README.md")
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        XCTAssertTrue(element(app, "tab-file:README.md").waitForExistence(timeout: 10))
        XCTAssertTrue(window.exists, "打開檔案不能關閉問管家")
        setDrawer(app, open: true)
        XCTAssertTrue(window.exists, "打開管家側欄不能關閉問管家")
        setDrawer(app, open: false)
        attach(app, "floating-chat-background", frames: ["window: \(window.frame)"])
    }

    func testFloatingChatResizeAndMove() {
        let app = launchFloatingChat()
        let window = element(app, "chat-window")
        let original = window.frame
        let corner = element(app, "chat-resize-sw")
        XCTAssertTrue(corner.waitForExistence(timeout: 5))
        let start = corner.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: -120, dy: 120)))
        let resized = window.frame
        XCTAssertGreaterThanOrEqual(resized.width, original.width + 80, "往左下拖應增加寬度")
        XCTAssertGreaterThanOrEqual(resized.height, original.height + 80, "往左下拖應增加高度")

        let title = element(app, "chat-window-titlebar").coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5))
        title.press(forDuration: 0.1, thenDragTo: title.withOffset(CGVector(dx: -200, dy: 0)))
        let moved = window.frame
        XCTAssertLessThan(moved.minX, resized.minX - 150, "標題列應能往左移動視窗")
        app.buttons["chat-window-close"].tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: window)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        element(app, "steward-ball").tap()
        XCTAssertTrue(window.waitForExistence(timeout: 5))
        XCTAssertEqual(window.frame.minX, moved.minX, accuracy: 2)
        XCTAssertEqual(window.frame.minY, moved.minY, accuracy: 2)
        XCTAssertEqual(window.frame.width, moved.width, accuracy: 2)
        XCTAssertEqual(window.frame.height, moved.height, accuracy: 2)
        attach(app, "floating-chat-resized-reopened", frames: ["original: \(original)", "resized: \(resized)", "moved: \(moved)", "reopened: \(window.frame)"])
    }

    private func attach(_ app: XCUIApplication, _ name: String, frames: [String]) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let geometry = XCTAttachment(string: frames.joined(separator: "\n"))
        geometry.name = "\(name)-frames"
        geometry.lifetime = .keepAlways
        add(geometry)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func modeButtons(_ app: XCUIApplication) -> [XCUIElement] {
        ["rectangle.split.3x1", "chevron.left.forwardslash.chevron.right", "terminal"].map { app.buttons[$0].firstMatch }
    }

    private func visible(_ item: XCUIElement, in app: XCUIApplication) -> Bool {
        item.exists && item.frame.width > 0 && item.frame.height > 0 && app.frame.intersects(item.frame)
    }

    private func checkChrome(_ app: XCUIApplication, _ state: String, sidebar: Bool, drawer: Bool,
                             title: String = "天氣小幫手",
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTContext.runActivity(named: state) { _ in
            let bounds = app.frame
            let tabs = modeButtons(app).compactMap { tab -> (String, CGRect)? in
                guard tab.exists else { return nil }
                return (tab.label, tab.frame)
            }
            XCTAssertEqual(tabs.count, 3, "\(state)：切換列應有三個按鈕", file: file, line: line)

            // 被切換列蓋住的按鈕仍要檢查，不能用 isHittable 把它們排除。
            var controls = app.navigationBars.buttons.allElementsBoundByIndex
            controls += app.segmentedControls.buttons.allElementsBoundByIndex
            let labels = ["新增、上傳檔案", "編輯", "預覽", "原文", "在檔案中尋找", "更多"]
            controls += app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ OR identifier == %@ OR label IN %@", "tab-", "code-sidebar-back", labels)).allElementsBoundByIndex
            controls += app.scrollViews.matching(identifier: "分頁").allElementsBoundByIndex
            let captured = controls.compactMap { control -> (String, String, CGRect)? in
                let label = control.label
                guard !label.isEmpty else { return nil }
                let frame = control.frame
                guard frame.width > 0, frame.height > 0, bounds.intersects(frame) else { return nil }
                return (control.identifier, label, frame)
            }
            let hasOverflow = captured.contains { $0.0 == "TopOverflowBarButtonItem" }
            for label in [sidebar ? "收起側欄" : "打開側欄", "程式碼頁選項"] {
                XCTAssertTrue(captured.contains { $0.1 == label } || hasOverflow,
                              "\(state)：缺少 \(label)", file: file, line: line)
            }
            XCTAssertTrue(captured.contains { $0.0 == "drawer-toggle" } || hasOverflow,
                          "\(state)：缺少 drawer-toggle", file: file, line: line)
            XCTAssertTrue(captured.contains { $0.1.contains(title) }, "\(state)：專案標題選單不見了", file: file, line: line)
            if drawer {
                let panel = element(app, "drawer-panel")
                XCTAssertTrue(panel.buttons["完成"].firstMatch.exists, "\(state)：缺少 完成", file: file, line: line)
                // 問管家改由貓咪的浮動視窗負責，側欄裡不再放這個按鈕
                XCTAssertFalse(panel.buttons["問管家"].firstMatch.exists, "\(state)：側欄不該有問管家", file: file, line: line)
            }
            var frames = tabs.map { "切換列 \($0.0): \($0.1)" }
            frames += captured.map { "\($0.0) | \($0.1): \($0.2)" }
            attach(app, state, frames: frames)
            for (label, frame) in tabs {
                XCTAssertFalse(frame.isEmpty, file: file, line: line)
                for (_, controlLabel, controlFrame) in captured {
                    XCTAssertFalse(frame.intersects(controlFrame),
                                   "\(state)：切換列「\(label)」\(frame) 擋住「\(controlLabel)」\(controlFrame)",
                                   file: file, line: line)
                }
            }
        }
    }

    private func setSidebar(_ app: XCUIApplication, open: Bool) {
        let toggle = app.buttons[open ? "打開側欄" : "收起側欄"].firstMatch
        if toggle.exists { toggle.tap() }
        XCTAssertTrue(app.buttons[open ? "收起側欄" : "打開側欄"].firstMatch.waitForExistence(timeout: 5))
    }

    private func setDrawer(_ app: XCUIApplication, open: Bool) {
        let panel = element(app, "drawer-panel")
        if open {
            let button = app.buttons["drawer-toggle"].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5))
            button.tap()
            XCTAssertTrue(panel.waitForExistence(timeout: 5))
            XCTAssertTrue(panel.buttons["完成"].firstMatch.exists)
        } else {
            panel.buttons["完成"].firstMatch.tap()
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: panel)
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        }
    }

    private func chromeStates(_ orientation: UIDeviceOrientation, name: String) {
        let app = launch(orientation == .portrait ? .landscapeLeft : .portrait)
        XCUIDevice.shared.orientation = orientation
        checkChrome(app, "\(name)-sidebar-open-drawer-closed", sidebar: true, drawer: false)
        setSidebar(app, open: false)
        checkChrome(app, "\(name)-sidebar-closed-drawer-closed", sidebar: false, drawer: false)
        setDrawer(app, open: true)
        checkChrome(app, "\(name)-sidebar-closed-drawer-open", sidebar: false, drawer: true)
        setSidebar(app, open: true)
        checkChrome(app, "\(name)-sidebar-open-drawer-open", sidebar: true, drawer: true)
        setDrawer(app, open: false)
        checkChrome(app, "\(name)-drawer-restored", sidebar: true, drawer: false)
    }

    /// 看 PDF:打開、點一下全螢幕、再點一下回來，每一步切換列都不能擋住導覽列上的按鈕(要接 18799 的隔離管家)
    private func pdfRoundTrip(_ orientation: UIDeviceOrientation, name: String) throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PDF_PROJECT"],
              let title = env["STEWARD_PDF_PROJECT_NAME"], let pdfPath = env["STEWARD_PDF_FILE"],
              let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799 else {
            throw XCTSkip("PDF 全螢幕測試需要 18799 的隔離管家")
        }
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", server, "-resetCodeLayout", "YES", "-codeSidebar", "YES",
                               "-openURL", "agentsteward://project/\(project)/code?file=\(pdfPath)"]
        app.launch()
        let pdf = element(app, "pdf-view")
        XCTAssertTrue(pdf.waitForExistence(timeout: 20), "沒有打開 PDF")
        sleep(2)
        checkChrome(app, "\(name)-pdf-open", sidebar: true, drawer: false, title: title)
        pdf.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element(app, "steward-ball"))
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed, "點 PDF 沒有進入全螢幕")
        sleep(1)
        let frames = ["PDF: \(pdf.frame)"] + modeButtons(app).filter { $0.exists }.map { "\($0.label): \($0.frame)" }
        attach(app, "\(name)-pdf-fullscreen", frames: frames)
        // 全螢幕時切換列留著(收起再放回來會讓導覽列不再讓位),導覽列收起來
        XCTAssertEqual(modeButtons(app).filter { visible($0, in: app) }.count, 3, "\(name):全螢幕時切換列應該留著")
        XCTAssertEqual(app.navigationBars.count, 0, "\(name):全螢幕仍有導覽列")
        pdf.tap()
        XCTAssertTrue(element(app, "steward-ball").waitForExistence(timeout: 5), "再點一下沒有離開全螢幕")
        sleep(2)
        checkChrome(app, "\(name)-pdf-after-fullscreen", sidebar: true, drawer: false, title: title)
    }

    func testPDFFullScreenRoundTripPortrait() throws { try pdfRoundTrip(.portrait, name: "portrait") }
    func testPDFFullScreenRoundTripLandscape() throws { try pdfRoundTrip(.landscapeLeft, name: "landscape") }

    /// 找檔名平常是按鈕，點了才變成輸入框;取消後變回按鈕
    func testFileSearchOpensOnTap() {
        let app = launch(.portrait)
        XCTAssertEqual(app.textFields.count, 0, "沒在找檔名時不應該有輸入框")
        let placeholder = app.buttons["找檔名"].firstMatch
        XCTAssertTrue(placeholder.waitForExistence(timeout: 5), "找不到找檔名按鈕")
        placeholder.tap()
        let field = app.textFields["找檔名"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "點了沒有出現輸入框")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5) || field.value(forKey: "hasKeyboardFocus") as? Bool == true, "輸入框沒有拿到焦點")
        field.typeText("READ")
        XCTAssertEqual(field.value as? String, "READ", "打的字沒有進輸入框")
        app.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(app.buttons["找檔名"].firstMatch.waitForExistence(timeout: 5), "取消後沒有變回按鈕")
        XCTAssertEqual(app.textFields.count, 0, "取消後輸入框還在")
    }

    func testPortraitChrome() {
        chromeStates(.portrait, name: "portrait")
    }

    func testLandscapeChrome() {
        chromeStates(.landscapeLeft, name: "landscape")
    }

    private func back(_ app: XCUIApplication) {
        let sidebarBack = app.buttons["code-sidebar-back"]
        let button = sidebarBack.exists ? sidebarBack : app.navigationBars.buttons["BackButton"].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }

    func testSidebarFolderAndHistoryNavigation() {
        let app = launch(.landscapeLeft)
        app.staticTexts["docs"].firstMatch.tap()
        let notes = element(app, "row-docs/notes.md")
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        checkChrome(app, "landscape-folder", sidebar: true, drawer: false)
        notes.tap()
        XCTAssertTrue(element(app, "tab-file:docs/notes.md").waitForExistence(timeout: 10))
        back(app)
        XCTAssertTrue(element(app, "row-README.md").waitForExistence(timeout: 5))
        app.segmentedControls.buttons["版本控制"].tap()
        XCTAssertTrue(app.buttons["全部暫存"].waitForExistence(timeout: 10))
        checkChrome(app, "landscape-git", sidebar: true, drawer: false)
        let history = app.buttons["最近的提交"].firstMatch
        for _ in 0..<10 {
            if history.exists && history.isHittable { break }
            let list = app.collectionViews.allElementsBoundByIndex.first { $0.frame.minX < 100 && $0.frame.width < 400 }
                ?? app.tables.firstMatch
            list.swipeUp()
        }
        XCTAssertTrue(history.waitForExistence(timeout: 5))
        history.tap()
        let commit = app.staticTexts["補上今日天氣摘要的測試"].firstMatch
        XCTAssertTrue(commit.waitForExistence(timeout: 10))
        checkChrome(app, "landscape-history", sidebar: true, drawer: false)
        commit.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "範例作者")).firstMatch.waitForExistence(timeout: 10))
        checkChrome(app, "landscape-commit", sidebar: true, drawer: false)
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "weather.py")).firstMatch.tap()
        XCTAssertTrue(element(app, "tab-diff:commit@a1b2c3d000000000000000000000000000000000:weather.py").waitForExistence(timeout: 10))
        back(app)
        XCTAssertTrue(commit.waitForExistence(timeout: 5))
        back(app)
        XCTAssertTrue(app.segmentedControls.buttons["版本控制"].waitForExistence(timeout: 5))
        app.segmentedControls.buttons["檔案"].tap()
        XCTAssertTrue(element(app, "row-README.md").waitForExistence(timeout: 5))
        checkChrome(app, "landscape-navigation-returned", sidebar: true, drawer: false)
    }

    private func sidebarList(_ app: XCUIApplication) -> XCUIElement {
        app.collectionViews.allElementsBoundByIndex.first {
            $0.frame.minX < 100 && $0.frame.width < 400 && $0.isHittable
        } ?? app.tables.firstMatch
    }

    private func revealInSidebar(_ target: XCUIElement, app: XCUIApplication) {
        for _ in 0..<40 {
            let list = sidebarList(app)
            if target.exists && target.isHittable && list.frame.contains(target.frame) { return }
            list.swipeUp()
        }
        XCTFail("側欄找不到 \(target.identifier)")
    }

    /// 終端機分頁只顯示終端機:網頁版自己的標題列(看板/程式碼/終端機、⚙)要藏起來,由 app 的原生標題列負責
    func testTerminalTabShowsOnlyTerminal() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PROJECT"],
              let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799 else {
            throw XCTSkip("要接 18799 的隔離管家")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", server, "-openURL", "agentsteward://project/\(project)/code"]
        app.launch()
        defer { app.terminate() }
        let term = app.buttons["終端機"].firstMatch
        XCTAssertTrue(term.waitForExistence(timeout: 20))
        term.tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20), "終端機分頁沒有網頁")
        sleep(4)
        attach(app, "terminal-tab", frames: ["web: \(web.frame)"])
        for label in ["看板", "程式碼"] {
            let b = web.buttons[label].firstMatch
            XCTAssertFalse(b.exists && b.isHittable, "終端機分頁裡出現網頁版的「\(label)」:整個網頁版都顯示出來了")
        }
        // 網頁版的設定精靈、密碼提示會打開網頁樣式的設定:app 裡不顯示(設定走原生畫面)
        let wizard = web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "第一次設定")).firstMatch
        XCTAssertFalse(wizard.exists, "終端機分頁跳出網頁版的設定精靈")
        let banner = web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "還沒設定管理密碼")).firstMatch
        XCTAssertFalse(banner.exists, "終端機分頁出現網頁版的密碼提示")
    }

    func testSidebarPreservesScrollPosition() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PROJECT"],
              let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799 else {
            throw XCTSkip("捲動位置測試需要 18799 的隔離管家與暫存專案")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", server, "-resetCodeLayout", "YES", "-codeSection", "files",
                               "-openURL", "agentsteward://project/\(project)/code"]
        app.launch()
        XCTAssertTrue(app.buttons["sidebar.left"].firstMatch.waitForExistence(timeout: 20))
        setSidebar(app, open: true)
        let parent = element(app, "row-browse")
        XCTAssertTrue(parent.waitForExistence(timeout: 20))
        parent.tap()
        XCTAssertTrue(element(app, "row-browse/folder_00").waitForExistence(timeout: 10))
        let folder = element(app, "row-browse/folder_40")
        revealInSidebar(folder, app: app)
        XCTAssertTrue(folder.isHittable)
        let folderFrame = folder.frame
        attach(app, "sidebar-folder-before-push", frames: ["folder: \(folderFrame)"])
        folder.tap()
        XCTAssertTrue(element(app, "row-browse/folder_40/readme.txt").waitForExistence(timeout: 10))
        back(app)
        let folderReturned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: folder)
        XCTAssertEqual(XCTWaiter.wait(for: [folderReturned], timeout: 5), .completed)
        XCTAssertEqual(folder.frame.minY, folderFrame.minY, accuracy: 2, "返回父資料夾後捲動位置改變")
        attach(app, "sidebar-folder-after-pop", frames: ["before: \(folderFrame)", "after: \(folder.frame)"])
        back(app)
        let git = app.segmentedControls.buttons["版本控制"]
        XCTAssertTrue(git.waitForExistence(timeout: 5))
        git.tap()
        XCTAssertTrue(app.buttons["全部暫存"].waitForExistence(timeout: 15))
        let history = app.buttons["最近的提交"].firstMatch
        XCTAssertFalse(history.exists && history.isHittable, "暫存專案應有足夠變更，讓提交紀錄必須往下捲才看得到")
        revealInSidebar(history, app: app)
        let historyFrame = history.frame
        attach(app, "sidebar-git-before-push", frames: ["history: \(historyFrame)"])
        history.tap()
        XCTAssertTrue(app.buttons["code-sidebar-back"].waitForExistence(timeout: 10))
        back(app)
        let historyReturned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: history)
        XCTAssertEqual(XCTWaiter.wait(for: [historyReturned], timeout: 5), .completed)
        XCTAssertEqual(history.frame.minY, historyFrame.minY, accuracy: 2, "返回版本控制後捲動位置改變")
        attach(app, "sidebar-git-after-pop", frames: ["before: \(historyFrame)", "after: \(history.frame)"])
    }

    private func reader(_ orientation: UIDeviceOrientation, name: String, split: Bool) {
        let app = launch(orientation)
        if split {
            element(app, "row-weather.py").tap()
            let tab = element(app, "tab-file:weather.py")
            XCTAssertTrue(tab.waitForExistence(timeout: 5))
            setSidebar(app, open: false)
            tab.press(forDuration: 1)
            app.buttons["在右邊打開"].tap()
            XCTAssertTrue(element(app, "pane-1-0").waitForExistence(timeout: 5))
            element(app, "tab-file:README.md").tap()
        }
        let preview = app.webViews["markdown-view"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 20))
        let content = preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch
        XCTAssertTrue(content.waitForExistence(timeout: 20))
        content.tap()
        let ball = element(app, "steward-ball")
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: ball)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        let tabs = modeButtons(app)
        let frames = ["內容: \(preview.frame)"] + tabs.filter { $0.exists }.map { "\($0.label): \($0.frame)" }
        attach(app, "\(name)-fullscreen-\(split ? "split" : "single")", frames: frames)
        // 全螢幕時切換列留著、浮在內容上;一開始的標題和第一段文字不能被它蓋住
        let heading = preview.staticTexts["天氣小幫手"].firstMatch
        for tab in tabs where visible(tab, in: app) {
            for text in [heading, content] where text.exists {
                XCTAssertFalse(tab.frame.intersects(text.frame), "全螢幕切換列蓋住「\(text.label)」\(text.frame)")
            }
        }
        XCTAssertEqual(app.navigationBars.count, 0, "全螢幕仍有導覽列")
        XCTAssertFalse(element(app, "tab-file:weather.py").isHittable, "全螢幕仍顯示其他格的分頁")
        preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch.tap()
        XCTAssertTrue(ball.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chevron.left.forwardslash.chevron.right"].firstMatch.exists)
        if split { XCTAssertTrue(element(app, "pane-1-0").exists) }
        sleep(1)
        checkChrome(app, "\(name)-after-fullscreen-\(split ? "split" : "single")", sidebar: !split, drawer: false)
    }

    func testPortraitFullScreen() {
        reader(.portrait, name: "portrait", split: false)
    }

    func testLandscapeSplitFullScreen() {
        reader(.landscapeLeft, name: "landscape", split: true)
    }

    // MARK: 一列導覽：專案標題、模式切換列、右側按鈕在同一列，各種狀態下位置都不變

    /// 量頂端那一列：切換列要在導覽列那一列裡，不能壓到任何按鈕，專案標題要看得到。回傳導覽列的 minY,給不同狀態比對
    @discardableResult
    private func topRow(_ app: XCUIApplication, _ name: String, title: String = "天氣小幫手",
                        file: StaticString = #filePath, line: UInt = #line) -> CGFloat {
        let tabs = modeButtons(app).filter { $0.exists && $0.frame.width > 0 }
        let bar = app.navigationBars.firstMatch
        guard tabs.count == 3, bar.exists else {
            XCTFail("\(name)：找不到切換列或導覽列", file: file, line: line)
            return .infinity
        }
        let buttons = bar.buttons.allElementsBoundByIndex.filter { $0.frame.width > 0 && !$0.label.isEmpty }
        var frames = ["nav: \(bar.frame)"] + tabs.map { "切換列 \($0.label): \($0.frame)" }
        frames += buttons.map { "\($0.identifier) | \($0.label): \($0.frame)" }
        attach(app, name, frames: frames)
        for tab in tabs {
            XCTAssertTrue(tab.frame.midY > bar.frame.minY && tab.frame.midY < bar.frame.maxY,
                          "\(name)：切換列 \(tab.frame) 不在導覽列 \(bar.frame) 那一列", file: file, line: line)
            for b in buttons where !tabs.contains(where: { $0.label == b.label }) {
                XCTAssertFalse(tab.frame.intersects(b.frame), "\(name)：切換列「\(tab.label)」擋住「\(b.label)」", file: file, line: line)
            }
        }
        XCTAssertTrue(buttons.contains { $0.label.hasPrefix(title) }, "\(name)：看不到專案標題「\(title)」", file: file, line: line)
        let drawer = element(app, "drawer-panel")
        if drawer.exists {
            XCTAssertGreaterThanOrEqual(drawer.frame.minY, bar.frame.maxY - 1, "\(name)：管家側欄蓋到頂端那一列", file: file, line: line)
        }
        return bar.frame.minY
    }

    private func assertSameRow(_ ys: [(String, CGFloat)], file: StaticString = #filePath, line: UInt = #line) {
        guard let first = ys.first else { return }
        for (name, y) in ys {
            XCTAssertEqual(y, first.1, accuracy: 1, "\(name) 的導覽列在 \(y),\(first.0) 在 \(first.1)", file: file, line: line)
        }
    }

    private func setDrawerToggle(_ app: XCUIApplication, open: Bool) {
        let toggle = app.buttons["drawer-toggle"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "找不到管家側欄開關(drawer-toggle)")
        let panel = element(app, "drawer-panel")
        if panel.exists != open { toggle.tap() }
        let done = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == %@", NSNumber(value: open)), object: panel)
        XCTAssertEqual(XCTWaiter.wait(for: [done], timeout: 5), .completed, open ? "管家側欄沒打開" : "管家側欄沒收起")
    }

    /// 示範模式：切分頁、打開檔案、全螢幕來回、開關管家側欄、轉向，頂端那一列都不動
    func testOneRowAcrossStates() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW",
                               "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES", "-codeSection", "files", "-mode", "board"]
        app.launch()
        XCTAssertTrue(app.buttons["程式碼"].firstMatch.waitForExistence(timeout: 20))
        sleep(2)
        var ys = [("board", topRow(app, "row-board"))]
        app.buttons["程式碼"].firstMatch.tap(); sleep(2)
        ys.append(("code", topRow(app, "row-code")))
        setSidebar(app, open: true)
        element(app, "row-README.md").tap()
        let paragraph = app.webViews["markdown-view"].staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 20))
        ys.append(("readme", topRow(app, "row-readme")))
        paragraph.tap(); sleep(2)
        XCTAssertEqual(app.navigationBars.count, 0, "全螢幕仍有導覽列")
        paragraph.tap(); sleep(2)
        ys.append(("after-fullscreen", topRow(app, "row-after-fullscreen")))
        setDrawerToggle(app, open: true); sleep(1)
        ys.append(("code-drawer", topRow(app, "row-code-drawer")))
        app.buttons["終端機"].firstMatch.tap(); sleep(2)
        ys.append(("terminal-drawer", topRow(app, "row-terminal-drawer")))
        setDrawerToggle(app, open: false); sleep(1)
        ys.append(("terminal", topRow(app, "row-terminal")))
        app.buttons["程式碼"].firstMatch.tap(); sleep(1)
        setSidebar(app, open: false)
        ys.append(("code-no-sidebar", topRow(app, "row-code-no-sidebar")))
        XCUIDevice.shared.orientation = .landscapeLeft; sleep(2)
        topRow(app, "row-landscape")
        XCUIDevice.shared.orientation = .portrait; sleep(2)
        ys.append(("rotated-back", topRow(app, "row-rotated-back")))
        assertSameRow(ys)
    }

    /// 全新安裝：設定畫面 →「先看示範」(主畫面晚建立，跟 App Store 審查的路徑一樣)
    func testOneRowFromSetupDemo() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", "", "-resetCodeLayout", "YES", "-codeSection", "files", "-mode", "board"]
        app.launch()
        let demo = app.buttons["demo-enter"].firstMatch
        XCTAssertTrue(demo.waitForExistence(timeout: 20), "沒有出現設定畫面")
        sleep(2) // 停在設定畫面一下，主畫面才會是啟動後才建立的
        attach(app, "setup-screen", frames: [])
        // 切換列在設定畫面底下：點它的位置不能換分頁(VoiceOver 讀不讀得到要在實機確認)
        let hiddenCode = app.buttons["程式碼"].firstMatch
        if hiddenCode.exists { hiddenCode.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        demo.tap()
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 20))
        sleep(2)
        XCTAssertTrue(app.buttons["看板"].firstMatch.isSelected, "在設定畫面點到了底下的切換列")
        var ys = [("board", topRow(app, "setup-demo-board"))]
        for (label, name) in [("程式碼", "code"), ("終端機", "terminal"), ("看板", "board-again")] {
            app.buttons[label].firstMatch.tap(); sleep(2)
            ys.append((name, topRow(app, "setup-demo-\(name)")))
        }
        XCUIDevice.shared.orientation = .landscapeLeft; sleep(2)
        XCUIDevice.shared.orientation = .portrait; sleep(2)
        ys.append(("rotated", topRow(app, "setup-demo-rotated")))
        assertSameRow(ys)
    }

    /// 登入後直接打開 PDF:初始、換分頁、進出全螢幕、重開 App,頂端那一列都不動。
    /// 要接 18799 的隔離管家(有設密碼):測試會把同一個密碼再設一次，讓所有登入失效
    func testLoginThenPDFKeepsOneRow() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PDF_PROJECT"],
              let pdfPath = env["STEWARD_PDF_FILE"], let other = env["STEWARD_PDF_FILE_2"], let password = env["STEWARD_TEST_PASSWORD"],
              let title = env["STEWARD_PDF_PROJECT_NAME"],
              let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799 else {
            throw XCTSkip("登入後的版面測試需要 18799 的隔離管家和它的密碼")
        }
        resetStewardLogins(url, password)
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", server, "-resetCodeLayout", "YES", "-codeSidebar", "YES",
                               "-openURL", "agentsteward://project/\(project)/code?file=\(pdfPath)"]
        app.launch()
        let field = app.secureTextFields["管理密碼"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "沒有出現登入畫面")
        field.tap()
        field.typeText(password + "\n")
        let pdf = element(app, "pdf-view")
        XCTAssertTrue(pdf.waitForExistence(timeout: 20), "登入後沒有打開 PDF")
        sleep(2)
        let initial = topRow(app, "login-pdf-initial", title: title)
        let row = element(app, "row-\(other)")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(element(app, "tab-file:\(other)").waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertEqual(topRow(app, "login-pdf-second-tab", title: title), initial, accuracy: 1, "換分頁後頂端那一列移動了")
        pdf.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element(app, "steward-ball"))
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed, "點 PDF 沒有進入全螢幕")
        pdf.tap()
        XCTAssertTrue(element(app, "steward-ball").waitForExistence(timeout: 5), "再點一下沒有離開全螢幕")
        sleep(2)
        XCTAssertEqual(topRow(app, "login-pdf-after-fullscreen", title: title), initial, accuracy: 1, "進出全螢幕後頂端那一列移動了")
        // 重開 App(登入還在):一般啟動也要一樣
        app.terminate()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", server, "-codeSidebar", "YES"]
        app.launch()
        XCTAssertTrue(element(app, "pdf-view").waitForExistence(timeout: 20), "重開後沒有回到 PDF")
        sleep(2)
        XCTAssertEqual(topRow(app, "login-pdf-relaunch", title: title), initial, accuracy: 1, "重開 App 後頂端那一列移動了")
    }
}

final class IPhoneChromeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("只檢查 iPhone 的全螢幕閱讀") }
        XCUIDevice.shared.orientation = .portrait
    }

    func testDemoReaderFullScreenHidesTabBar() {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 20))
        app.tabBars.buttons["程式碼"].tap()
        let readme = app.descendants(matching: .any)["row-README.md"].firstMatch
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        let preview = app.webViews["markdown-view"].firstMatch
        let paragraph = preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 20))
        let board = app.tabBars.buttons["看板"]
        let ask = app.buttons["file-ask"].firstMatch
        XCTAssertFalse(board.exists && board.isHittable, "打開檔案後應隱藏底部分頁列")
        XCTAssertTrue(ask.waitForExistence(timeout: 5) && ask.isHittable)
        paragraph.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false OR hittable == false"), object: ask)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertFalse(board.exists && board.isHittable)
        XCTAssertEqual(app.navigationBars.count, 0)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iphone-reader-fullscreen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        paragraph.tap()
        XCTAssertTrue(ask.waitForExistence(timeout: 5) && ask.isHittable)
        XCTAssertFalse(board.exists && board.isHittable, "結束全螢幕後分頁列仍應隱藏")
        let back = app.navigationBars.buttons["BackButton"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        XCTAssertTrue(board.waitForExistence(timeout: 5) && board.isHittable, "返回清單後應恢復底部分頁列")
    }

    func testDemoFileBottomToolbar() {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES", "-ballCorner", "br"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 20))
        app.tabBars.buttons["程式碼"].tap()
        let readme = app.descendants(matching: .any)["row-README.md"].firstMatch
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        let preview = app.webViews["markdown-view"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 20))
        XCTAssertTrue(app.navigationBars.buttons["編輯"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars.segmentedControls.buttons["原文"].exists)
        XCTAssertFalse(app.navigationBars.segmentedControls.buttons["預覽"].exists)
        XCTAssertFalse(app.navigationBars.buttons["更多"].exists)

        let identifiers = ["file-find", "file-select-lines", "file-ask", "file-preview-toggle", "file-more"]
        let controls = identifiers.map { app.buttons[$0].firstMatch }
        let cat = app.descendants(matching: .any)["steward-ball"].firstMatch
        XCTAssertFalse(cat.exists, "檔案打開時只顯示工具列的貓咪")
        for (index, control) in controls.enumerated() {
            XCTAssertTrue(control.waitForExistence(timeout: 5) && control.isHittable, identifiers[index])
            XCTAssertGreaterThanOrEqual(control.frame.minY, app.frame.midY, identifiers[index])
            for other in controls.dropFirst(index + 1) {
                XCTAssertFalse(control.frame.intersects(other.frame), "\(identifiers[index]) 和 \(other.identifier) 重疊")
            }
        }
        let toggle = app.buttons["file-preview-toggle"].firstMatch
        XCTAssertEqual(toggle.label, "原文")
        toggle.tap()
        XCTAssertEqual(toggle.label, "預覽")
        app.buttons["file-select-lines"].firstMatch.tap()
        XCTAssertTrue(app.buttons["複製"].firstMatch.waitForExistence(timeout: 5))
        let toolbarCat = app.buttons["file-ask"].firstMatch
        toolbarCat.tap()
        XCTAssertTrue(app.navigationBars.buttons["關閉"].firstMatch.waitForExistence(timeout: 5))
        let attachedFile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "拿掉 ", "README.md")).firstMatch
        XCTAssertTrue(attachedFile.waitForExistence(timeout: 5), "問管家應自動附上 README.md")
        app.navigationBars.buttons["關閉"].firstMatch.tap()

        // 長按貓咪直接進入圈選(沒有選單、不會打開問管家或側欄)
        for _ in 0..<3 {
            toolbarCat.press(forDuration: 0.7)
            let hint = app.staticTexts["拉一個框圈出要問的地方"].firstMatch
            XCTAssertTrue(hint.waitForExistence(timeout: 5), "長按貓咪應直接進入圈選")
            XCTAssertFalse(app.navigationBars.buttons["關閉"].firstMatch.exists, "長按不能同時打開問管家")
            XCTAssertFalse(app.descendants(matching: .any)["drawer-panel"].firstMatch.exists, "長按不能打開側欄")
            app.buttons["取消"].firstMatch.tap()
            let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: hint)
            XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed)
        }
        let back = app.navigationBars.buttons["BackButton"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        XCTAssertTrue(readme.waitForExistence(timeout: 5))
        XCTAssertTrue(cat.waitForExistence(timeout: 5), "返回檔案清單後應恢復浮動貓咪")
        cat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3)))
        XCTAssertLessThan(cat.frame.midY, app.frame.midY, "貓咪應能拖到上方角落")
        cat.tap()
        XCTAssertTrue(app.navigationBars.buttons["關閉"].firstMatch.waitForExistence(timeout: 5), "單擊貓咪應打開問管家")
        // 貓咪的位置會被記住：放回右下角，後面的測試和截圖才不會被擋住
        app.navigationBars.buttons["關閉"].firstMatch.tap()
        cat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.75)))
        XCTAssertGreaterThan(cat.frame.midY, app.frame.midY, "貓咪應放回下方角落")
    }

    /// iPhone 的管家側欄只有「完成」:問管家走貓咪
    func testDemoDrawerHasNoAskButton() {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["看板"].firstMatch.waitForExistence(timeout: 20))
        app.tabBars.buttons["程式碼"].tap()
        app.buttons["程式碼頁選項"].firstMatch.tap()
        let drawer = app.buttons["drawer-toggle"].firstMatch
        XCTAssertTrue(drawer.waitForExistence(timeout: 5))
        drawer.tap()
        let done = app.navigationBars.buttons["完成"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(done.frame.midX, app.frame.midX)
        XCTAssertFalse(app.navigationBars.buttons["問管家"].firstMatch.exists, "側欄不該有問管家")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iphone-drawer-no-ask"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        done.tap()
    }

    /// iPhone:登入後直接打開 PDF,導覽列、檔案分頁列、PDF 之間不能有空白(要接 18799 的隔離管家)
    func testLoginThenPDFHasNoGap() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PDF_PROJECT"],
              let pdfPath = env["STEWARD_PDF_FILE"], let password = env["STEWARD_TEST_PASSWORD"],
              let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799 else {
            throw XCTSkip("登入後的版面測試需要 18799 的隔離管家和它的密碼")
        }
        resetStewardLogins(url, password)
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES", "-isDemo", "NO",
                               "-serverURL", server, "-resetCodeLayout", "YES",
                               "-openURL", "agentsteward://project/\(project)/code?file=\(pdfPath)"]
        app.launch()
        defer { app.terminate() }
        let field = app.secureTextFields["管理密碼"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20), "沒有出現登入畫面")
        field.tap()
        field.typeText(password + "\n")
        let pdf = app.descendants(matching: .any)["pdf-view"].firstMatch
        XCTAssertTrue(pdf.waitForExistence(timeout: 20), "登入後沒有打開 PDF")
        sleep(2)
        let bar = app.navigationBars.firstMatch
        let strip = app.scrollViews.matching(identifier: "分頁").firstMatch
        XCTAssertTrue(bar.exists && strip.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iphone-login-pdf"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertLessThanOrEqual(strip.frame.minY - bar.frame.maxY, 10, "導覽列和檔案分頁列之間有空白")
        XCTAssertLessThanOrEqual(pdf.frame.minY - strip.frame.maxY, 48, "檔案分頁列和 PDF 之間有空白(中間只有「標示」那一列)")
    }
}

extension XCTestCase {
    /// 把同一個密碼再設一次:隔離管家會清掉所有登入，App 下次啟動要重新登入
    func resetStewardLogins(_ server: URL, _ password: String) {
        let session = URLSession(configuration: .ephemeral)
        for (path, body) in [("api/auth/login", ["password": password]), ("api/auth/password", ["current": password, "next": password])] {
            var request = URLRequest(url: server.appendingPathComponent(path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            let done = expectation(description: path)
            session.dataTask(with: request) { _, response, _ in
                XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "\(path) 失敗")
                done.fulfill()
            }.resume()
            wait(for: [done], timeout: 10)
        }
    }
}
