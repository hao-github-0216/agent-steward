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
        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        app.buttons["程式碼"].firstMatch.tap()
        setSidebar(app, open: true)
        let readme = element(app, "row-README.md")
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        XCTAssertTrue(element(app, "tab-file:README.md").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["原文"].waitForExistence(timeout: 15))
        return app
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
            for label in [sidebar ? "收起側欄" : "打開側欄", drawer ? "收起管家" : "管家", "設定", "程式碼頁選項"] {
                XCTAssertTrue(captured.contains { $0.1 == label } || hasOverflow,
                              "\(state)：缺少 \(label)", file: file, line: line)
            }
            XCTAssertTrue(captured.contains { $0.1.contains(title) }, "\(state)：專案標題選單不見了", file: file, line: line)
            if drawer {
                for label in ["問管家", "完成"] {
                    XCTAssertTrue(captured.contains { $0.1 == label }, "\(state)：缺少 \(label)", file: file, line: line)
                }
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
        if open {
            let button = app.buttons["管家"].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5))
            button.tap()
            XCTAssertTrue(app.navigationBars.buttons["完成"].firstMatch.waitForExistence(timeout: 5))
        } else {
            app.navigationBars.buttons["完成"].firstMatch.tap()
            XCTAssertTrue(app.buttons["管家"].firstMatch.waitForExistence(timeout: 5))
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

    // MARK: 主畫面晚建立時，切換列和導覽列之間不能多出空白

    /// 切換列底到導覽列頂的距離。正常約 14pt;主畫面在啟動後才建立時會變成 34pt(設定畫面進示範)或 88pt(登入後)
    private func chromeGap(_ app: XCUIApplication, _ name: String) -> CGFloat {
        let tabs = modeButtons(app).filter { $0.exists }
        let bar = app.navigationBars.firstMatch
        guard tabs.count == 3, bar.exists else {
            XCTFail("\(name)：找不到切換列或導覽列")
            return .infinity
        }
        let gap = bar.frame.minY - tabs.map(\.frame.maxY).max()!
        attach(app, name, frames: ["gap: \(gap)", "nav: \(bar.frame)"] + tabs.map { "\($0.label): \($0.frame)" })
        return gap
    }

    /// 全新安裝:設定畫面 →「先看示範」→ 程式碼頁(不用管家，跟 App Store 審查的路徑一樣)
    func testDemoFromSetupHasNoChromeGap() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES",
                               "-isDemo", "NO", "-serverURL", "", "-resetCodeLayout", "YES", "-codeSection", "files"]
        app.launch()
        let demo = app.buttons["demo-enter"].firstMatch
        XCTAssertTrue(demo.waitForExistence(timeout: 20), "沒有出現設定畫面")
        sleep(2) // 停在設定畫面一下，主畫面才會是啟動後才建立的
        demo.tap()
        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        app.buttons["程式碼"].firstMatch.tap()
        sleep(2)
        let initial = chromeGap(app, "setup-demo-code-initial")
        XCTAssertLessThanOrEqual(initial, 24, "從設定畫面進示範後，切換列和導覽列之間有 \(initial)pt 空白")
        // 轉一次方向系統會重新排版;排版前後應該一樣
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(2)
        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        let rotated = chromeGap(app, "setup-demo-code-rotated")
        XCTAssertEqual(initial, rotated, accuracy: 1, "轉向前後切換列和導覽列的距離不一樣")
    }

    /// 登入後直接打開 PDF:初始、換分頁、進出全螢幕，切換列和導覽列的距離都一樣。
    /// 要接 18799 的隔離管家(有設密碼):測試會把同一個密碼再設一次，讓所有登入失效
    func testLoginThenPDFHasNoChromeGap() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let project = env["STEWARD_PDF_PROJECT"],
              let pdfPath = env["STEWARD_PDF_FILE"], let other = env["STEWARD_PDF_FILE_2"], let password = env["STEWARD_TEST_PASSWORD"],
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
        let initial = chromeGap(app, "login-pdf-initial")
        XCTAssertLessThanOrEqual(initial, 24, "登入後切換列和導覽列之間有 \(initial)pt 空白")
        let row = element(app, "row-\(other)")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(element(app, "tab-file:\(other)").waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertEqual(chromeGap(app, "login-pdf-second-tab"), initial, accuracy: 1, "換分頁後距離變了")
        pdf.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element(app, "steward-ball"))
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed, "點 PDF 沒有進入全螢幕")
        pdf.tap()
        XCTAssertTrue(element(app, "steward-ball").waitForExistence(timeout: 5), "再點一下沒有離開全螢幕")
        sleep(2)
        XCTAssertEqual(chromeGap(app, "login-pdf-after-fullscreen"), initial, accuracy: 1, "進出全螢幕後距離變了")
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
        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        app.tabBars.buttons["程式碼"].tap()
        let readme = app.descendants(matching: .any)["row-README.md"].firstMatch
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        readme.tap()
        let preview = app.webViews["markdown-view"].firstMatch
        let paragraph = preview.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "一個用 Python 練習的天氣網頁 App。")).firstMatch
        XCTAssertTrue(paragraph.waitForExistence(timeout: 20))
        let board = app.tabBars.buttons["看板"]
        XCTAssertTrue(board.exists && board.isHittable, "進入全螢幕前應有底部分頁列")
        paragraph.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false OR hittable == false"), object: board)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertTrue(app.tabBars.count == 0 || !board.exists || !board.isHittable)
        XCTAssertEqual(app.navigationBars.count, 0)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iphone-reader-fullscreen"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        paragraph.tap()
        XCTAssertTrue(board.waitForExistence(timeout: 5))
        XCTAssertTrue(board.isHittable, "結束全螢幕後應恢復底部分頁列")
    }

    func testDemoDrawerKeepsAskOnLeadingEdge() {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-demo", "YES", "-resetCodeLayout", "YES", "-noPush", "YES"]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["demo-exit"].waitForExistence(timeout: 20))
        app.tabBars.buttons["程式碼"].tap()
        let drawer = app.navigationBars.buttons["管家"].firstMatch
        XCTAssertTrue(drawer.waitForExistence(timeout: 5))
        drawer.tap()
        let ask = app.navigationBars.buttons["問管家"].firstMatch
        let done = app.navigationBars.buttons["完成"].firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        XCTAssertTrue(done.exists)
        XCTAssertLessThan(ask.frame.minX, app.frame.minX + app.frame.width / 3)
        XCTAssertGreaterThan(done.frame.midX, app.frame.midX)
        XCTAssertFalse(ask.frame.intersects(done.frame))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iphone-drawer-leading-ask"
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
