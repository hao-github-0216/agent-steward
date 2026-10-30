// 模擬器手勢測試(手指拖動、往上拉視窗這種沒辦法用連結測的)。要連到真的管家:
//   xcodebuild test -project Steward.xcodeproj -scheme Steward -destination 'id=<模擬器 UDID>' TEST_RUNNER_STEWARD_PROJECT=<專案 id>
//   截圖在測試結果裡:xcrun xcresulttool export attachments --path <.xcresult> --output-path <資料夾>
// 只會打開看板/程式碼頁和管家側欄,不會切到終端機(不會動到電腦上 herdr 的畫面)
import XCTest

final class GestureTests: XCTestCase {
    private var project: String { ProcessInfo.processInfo.environment["STEWARD_PROJECT"] ?? "" }
    /// 有給隔離的管家(TEST_RUNNER_STEWARD_TEST_SERVER)就接它:用連結打開專案會把它記成「目前專案」,
    /// 接真的管家會把你其他裝置的專案也換掉
    private var serverArgs: [String] { ProcessInfo.processInfo.environment["STEWARD_TEST_SERVER"].map { ["-serverURL", $0] } ?? [] }

    override func setUp() { continueAfterFailure = true }

    /// reset:程式碼頁從空的版面開始(-resetCodeLayout,也清掉記著的草稿)
    private func launch(_ link: String, reset: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES"] + serverArgs + (reset ? ["-resetCodeLayout", "YES"] : []) + ["-openURL", link]
        app.launch()
        return app
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// 程式碼:手指往左拖看得到每一行右邊的內容
    func testCodeScrollsHorizontally() {
        let app = launch("agentsteward://project/\(project)/code?file=ios-native/Steward/Theme.swift")
        sleep(6)
        shot(app, "code-1-before")
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.35))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.35)))
        sleep(1)
        shot(app, "code-2-after-drag-left")
    }

    /// 找檔名在「檔案|版本控制」下面;管家側欄半個螢幕,往上拖展開
    func testSearchAndDrawer() {
        let app = launch("agentsteward://project/\(project)/code")
        sleep(6)
        shot(app, "drawer-0-code-home")
        app.buttons["管家"].firstMatch.tap()
        sleep(2)
        shot(app, "drawer-1-medium")
        let grab = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.53))
        grab.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)))
        sleep(2)
        shot(app, "drawer-2-large")
    }

    /// 終端機(要接隔離的管家,不碰真的 herdr):點一下 = 滑鼠點一下、不跳鍵盤;按鍵列 ⌨︎ 叫出鍵盤、↓ 送方向鍵
    ///   TEST_RUNNER_STEWARD_TEST_SERVER=http://127.0.0.1:8797 TEST_RUNNER_STEWARD_TEST_PROJECT=<隔離管家的專案 id>
    func testTerminalKeysAndTap() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let proj = env["STEWARD_TEST_PROJECT"] else { throw XCTSkip("要接隔離的管家才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-serverURL", server, "-openURL", "agentsteward://project/\(proj)/terminal"]
        app.launch()
        sleep(14)
        if app.buttons["之後再說"].firstMatch.exists { app.buttons["之後再說"].firstMatch.tap(); sleep(2) }
        shot(app, "term-1-open")
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.4)).tap()
        sleep(2)
        shot(app, "term-2-after-tap")
        let afterTap = app.keyboards.count
        let kbd = app.buttons["叫出或收起鍵盤"].firstMatch
        XCTAssertTrue(kbd.waitForExistence(timeout: 5), "找不到 ⌨︎")
        kbd.tap()
        sleep(2)
        shot(app, "term-3-after-kbd")
        let afterKbd = app.keyboards.count
        app.buttons["下"].firstMatch.tap()
        sleep(1)
        shot(app, "term-4-after-down")
        let note = XCTAttachment(string: "keyboards after tap=\(afterTap), after kbd=\(afterKbd)")
        note.name = "keyboard-counts"; note.lifetime = .keepAlways; add(note)
        XCTAssertEqual(afterTap, 0, "點終端機不該跳鍵盤")
        XCTAssertGreaterThan(afterKbd, 0, "按 ⌨︎ 要叫出鍵盤")
    }

    /// 終端機按鍵列(隔離的管家):在按鍵上左右滑要捲動、不能送鍵;點一下 ↓ 送一次。
    /// 用座標拖(網頁裡的按鍵 XCUITest 常判斷成看不見)
    func testTerminalKeyBarSwipe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let proj = env["STEWARD_TEST_PROJECT"] else { throw XCTSkip("要接隔離的管家才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-serverURL", server, "-openURL", "agentsteward://project/\(proj)/terminal"]
        app.launch()
        sleep(14)
        if app.buttons["之後再說"].firstMatch.exists { app.buttons["之後再說"].firstMatch.tap(); sleep(2) }
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 5))
        let f = web.frame
        let barY = f.maxY - 24
        let at = { (x: CGFloat) in app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: barY)) }
        shot(app, "bar-1-before")
        // 從列的右半邊(按鍵上)往左拖:要捲動、不送鍵
        at(f.width * 0.72).press(forDuration: 0.05, thenDragTo: at(f.width * 0.12))
        sleep(2)
        shot(app, "bar-2-after-swipe")
        // 拖回最左邊(拖兩次),再點一下 ↓(⌨︎ 固定在左邊,↓ 是捲動區的第二個鍵)
        for _ in 0..<2 {
            at(f.width * 0.2).press(forDuration: 0.05, thenDragTo: at(f.width * 0.95))
            sleep(2)
        }
        at(54 + 4 + 42 + 6 + 21).tap()
        sleep(2)
        shot(app, "bar-3-after-tap")
    }

    /// iPad 分割編輯區:側欄點第二個檔案 → 長按分頁「在右邊打開」→ 拖分隔線 → 把側欄檔案拖到右邊那格下緣分割 → 重開 app 版面還在
    func testIPadSplitEditor() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad 才跑") }
        var app = launch("agentsteward://project/\(project)/code?file=ios-native/Steward/Theme.swift", reset: true)
        sleep(8)
        let el = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        XCTAssertTrue(el("tab-file:ios-native/Steward/Theme.swift").waitForExistence(timeout: 5), "沒有 Theme.swift 分頁")
        shot(app, "ipad-1-one-tab")
        // 側欄點 LICENSE → 同一格多一個分頁
        XCTAssertTrue(el("row-LICENSE").waitForExistence(timeout: 5), "側欄找不到 LICENSE")
        el("row-LICENSE").tap()
        sleep(3)
        shot(app, "ipad-2-two-tabs")
        // 長按 LICENSE 分頁 → 在右邊打開
        XCTAssertTrue(el("tab-file:LICENSE").waitForExistence(timeout: 5), "沒有 LICENSE 分頁")
        el("tab-file:LICENSE").press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["在右邊打開"].waitForExistence(timeout: 3), "長按選單沒有「在右邊打開」")
        app.buttons["在右邊打開"].tap()
        sleep(3)
        shot(app, "ipad-3-split-right")
        XCTAssertTrue(el("pane-1-0").exists, "沒有分出右邊那一格")
        // 拖欄之間的分隔線往左 120 點
        let divider = el("左右調整格子大小")
        if divider.waitForExistence(timeout: 3) {
            let c = divider.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            c.press(forDuration: 0.3, thenDragTo: c.withOffset(CGVector(dx: -120, dy: 0)))
            sleep(2)
            shot(app, "ipad-4-divider")
        }
        // 把側欄的 install.sh 拖到右邊那一格的下緣 → 分出下面一格
        if el("row-install.sh").waitForExistence(timeout: 3), el("pane-1-0").exists {
            el("row-install.sh").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .press(forDuration: 1.2, thenDragTo: el("pane-1-0").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)))
            sleep(3)
            shot(app, "ipad-5-drag-bottom")
            XCTAssertTrue(el("pane-1-1").exists, "拖到下緣沒有分出下面一格")
        }
        // 重開 app:版面還在
        app.terminate()
        app = launch("agentsteward://project/\(project)/code")
        sleep(8)
        shot(app, "ipad-6-relaunch")
    }

    /// iPhone 分頁:打開兩個檔案、點分頁切換、關掉一個
    func testIPhoneTabs() throws {
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("iPhone 才跑") }
        let app = launch("agentsteward://project/\(project)/code?file=ios-native/Steward/Theme.swift")
        sleep(8)
        shot(app, "iphone-1-editor")
        app.navigationBars.buttons.element(boundBy: 0).tap() // 回清單
        sleep(2)
        let lic = app.descendants(matching: .any)["row-LICENSE"].firstMatch
        if !lic.waitForExistence(timeout: 3) { app.swipeUp(); sleep(1) }
        XCTAssertTrue(lic.waitForExistence(timeout: 5), "清單找不到 LICENSE")
        lic.tap()
        sleep(3)
        shot(app, "iphone-2-two-tabs")
        let themeTab = app.descendants(matching: .any)["tab-file:ios-native/Steward/Theme.swift"].firstMatch
        XCTAssertTrue(themeTab.waitForExistence(timeout: 5))
        themeTab.tap()
        sleep(2)
        shot(app, "iphone-3-switched")
    }

    /// iPad:外接鍵盤 ⌘⇧]/⌘⇧[ 切分頁、⌘\ 向右分割、⌘W 關分頁;把分頁拖到格子右緣分割;
    /// 版本控制點新檔案 → 差異分頁;⋯ 帶入網頁版的版面、關閉所有分頁
    func testIPadMore() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad 才跑") }
        let app = launch("agentsteward://project/\(project)/code?file=ios-native/Steward/Theme.swift", reset: true)
        sleep(8)
        let el = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        // 長按「關閉其他分頁」(從空的版面開始,只是走一遍選單),再開 LICENSE(同一格兩個分頁)
        if el("tab-file:ios-native/Steward/Theme.swift").waitForExistence(timeout: 5) {
            el("tab-file:ios-native/Steward/Theme.swift").press(forDuration: 1.0)
            if app.buttons["關閉其他分頁"].waitForExistence(timeout: 3) { app.buttons["關閉其他分頁"].tap() }
        }
        sleep(1)
        el("row-LICENSE").tap()
        sleep(2)
        // ⌘⇧] / ⌘⇧[:同一格裡換分頁(⌃Tab 有時被 iPadOS 拿去移動鍵盤焦點,不測)。
        // 模擬器常把整個測試的第一個按鍵吃掉(之後都正常),先按一個沒用到的組合鍵暖身
        XCTAssertTrue(el("tab-file:LICENSE").isSelected, "剛點的 LICENSE 不是目前的分頁")
        app.typeKey(.F12, modifierFlags: [.command, .shift])
        sleep(1)
        // 模擬器偶爾還是會吃掉一下:沒換過去才再按一次(按兩次都沒反應才算失敗)
        func press(_ key: String, until ok: () -> Bool) -> Bool {
            for _ in 0..<2 {
                app.typeKey(key, modifierFlags: [.command, .shift])
                sleep(1)
                if ok() { return true }
            }
            return false
        }
        XCTAssertTrue(press("]") { el("tab-file:ios-native/Steward/Theme.swift").isSelected }, "⌘⇧] 沒有換到下一個分頁")
        XCTAssertTrue(press("[") { el("tab-file:LICENSE").isSelected }, "⌘⇧[ 沒有換回上一個分頁")
        shot(app, "more-0-cycled")
        // ⌘\:目前的分頁(LICENSE)移到右邊新的一格
        app.typeKey("\\", modifierFlags: .command)
        sleep(2)
        shot(app, "more-1-cmd-backslash")
        XCTAssertTrue(el("pane-1-0").exists, "⌘\\ 沒有向右分割")
        // ⌘W:關掉目前的分頁(右邊那格收掉)
        app.typeKey("w", modifierFlags: .command)
        sleep(2)
        shot(app, "more-2-cmd-w")
        XCTAssertFalse(el("pane-1-0").exists, "⌘W 沒有關掉分頁")
        // 再開 LICENSE,把它的分頁拖到這一格的右緣 → 分出右邊一格
        el("row-LICENSE").tap()
        sleep(2)
        el("tab-file:LICENSE").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 1.2, thenDragTo: el("pane-0-0").coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)))
        sleep(3)
        shot(app, "more-2b-drag-tab-right")
        XCTAssertTrue(el("pane-1-0").exists, "把分頁拖到右緣沒有分出右邊一格")
        // 版本控制:點「新檔案」裡的 test/code-focus.test.mjs → 差異分頁
        app.buttons["版本控制"].firstMatch.tap()
        sleep(4)
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'code-focus.test.mjs'")).firstMatch
        if row.waitForExistence(timeout: 5) {
            row.tap()
            sleep(3)
            shot(app, "more-3-diff-tab")
        }
        app.buttons["檔案"].firstMatch.tap()
        sleep(1)
        // ⋯ → 帶入網頁版的版面
        app.buttons["程式碼頁選項"].firstMatch.tap()
        XCTAssertTrue(app.buttons["帶入網頁版的版面"].waitForExistence(timeout: 3))
        app.buttons["帶入網頁版的版面"].tap()
        sleep(3)
        shot(app, "more-4-import-alert")
        if app.alerts.buttons["好"].waitForExistence(timeout: 3) { app.alerts.buttons["好"].tap() }
        sleep(2)
        shot(app, "more-5-imported")
        // ⋯ → 關閉所有分頁
        app.buttons["程式碼頁選項"].firstMatch.tap()
        XCTAssertTrue(app.buttons["關閉所有分頁"].waitForExistence(timeout: 3))
        app.buttons["關閉所有分頁"].tap()
        sleep(2)
        shot(app, "more-6-closed-all")
        XCTAssertTrue(app.staticTexts["沒有打開的檔案"].exists, "關閉所有分頁後還有分頁")
    }

    /// iPad:⌘\ 把有兩個分頁的格子分到右邊;「關閉所有分頁」留下改了沒存的;沒存的按 ⌘W 會先問(只按「不存,直接關閉」)
    /// 用 ios-native/zz-scratch.txt(測試前建、測完刪);-resetCodeLayout 從空的版面開始
    func testIPadSplitAndUnsavedClose() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad 才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES"] + serverArgs + ["-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=ios-native/zz-scratch.txt"]
        app.launch()
        sleep(8)
        let el = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        let scratch = el("tab-file:ios-native/zz-scratch.txt")
        XCTAssertTrue(scratch.waitForExistence(timeout: 5), "沒有 zz-scratch.txt 分頁")
        // 同一格再開 LICENSE,⌘\ → LICENSE 到右邊新的一格
        el("row-LICENSE").tap()
        sleep(2)
        app.typeKey("\\", modifierFlags: .command)
        sleep(2)
        shot(app, "unsaved-1-cmd-backslash")
        XCTAssertTrue(el("pane-1-0").exists, "⌘\\ 沒有分到右邊")
        // 回到 zz-scratch.txt,編輯、打字(不存)
        scratch.tap()
        sleep(1)
        let left = el("pane-0-0")
        left.buttons["編輯"].firstMatch.tap()
        sleep(1)
        left.textViews.firstMatch.tap()
        left.textViews.firstMatch.typeText("unsaved")
        sleep(1)
        shot(app, "unsaved-2-dirty")
        // ⋯ → 關閉所有分頁:LICENSE 關掉,沒存的 zz-scratch.txt 留著
        app.buttons["程式碼頁選項"].firstMatch.tap()
        XCTAssertTrue(app.buttons["關閉所有分頁"].waitForExistence(timeout: 3))
        app.buttons["關閉所有分頁"].tap()
        sleep(2)
        XCTAssertTrue(scratch.exists, "關閉所有分頁把沒存的分頁也關了")
        XCTAssertFalse(el("tab-file:LICENSE").exists, "關閉所有分頁沒有關掉 LICENSE")
        // ⌘W:沒存 → 先問
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.buttons["不存,直接關閉"].waitForExistence(timeout: 3), "沒存的分頁關閉前沒有問")
        shot(app, "unsaved-3-confirm")
        app.buttons["不存,直接關閉"].tap()
        sleep(1)
        shot(app, "unsaved-4-closed")
        XCTAssertFalse(scratch.exists, "選了不存直接關閉,分頁還在")
    }

    /// iPhone:改了沒存的分頁,長按選「關閉」會先問(只按「不存,直接關閉」);用 ios-native/zz-scratch.txt
    func testIPhoneUnsavedClose() throws {
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("iPhone 才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES"] + serverArgs + ["-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=ios-native/zz-scratch.txt"]
        app.launch()
        sleep(8)
        let el = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        let scratch = el("tab-file:ios-native/zz-scratch.txt")
        XCTAssertTrue(scratch.waitForExistence(timeout: 5), "沒有 zz-scratch.txt 分頁")
        app.navigationBars.buttons["編輯"].firstMatch.tap()
        sleep(1)
        let tv = app.textViews.firstMatch
        tv.tap()
        sleep(1)
        shot(app, "iphone-unsaved-0-focus")
        tv.typeText("unsaved")
        sleep(1)
        shot(app, "iphone-unsaved-1-dirty")
        scratch.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["關閉"].waitForExistence(timeout: 3))
        app.buttons["關閉"].tap()
        XCTAssertTrue(app.buttons["不存,直接關閉"].waitForExistence(timeout: 3), "沒存的分頁關閉前沒有問")
        shot(app, "iphone-unsaved-2-confirm")
        app.buttons["不存,直接關閉"].tap()
        sleep(1)
        XCTAssertFalse(scratch.exists, "選了不存直接關閉,分頁還在")
    }

    /// iPad:格子裡按「編輯」後點編輯框要拿得到鍵盤焦點
    /// (以前動作列用 safeAreaInset 浮在內容上面,iPad 格子裡的編輯框點了沒反應)
    func testIPadPaneEditorFocus() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad 才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES"] + serverArgs + ["-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=LICENSE"]
        app.launch()
        sleep(8)
        let pane = app.descendants(matching: .any)["pane-0-0"].firstMatch
        XCTAssertTrue(pane.waitForExistence(timeout: 5))
        pane.buttons["編輯"].firstMatch.tap()
        sleep(1)
        let tv = pane.textViews.firstMatch
        XCTAssertTrue(tv.waitForExistence(timeout: 3))
        tv.tap()
        sleep(1)
        shot(app, "pane-editor-focus")
        XCTAssertEqual(tv.value(forKey: "hasKeyboardFocus") as? Bool, true, "格子裡的編輯框拿不到鍵盤焦點")
        // 只按了編輯、沒改:重開 app 後分頁不能算「還沒存」
        sleep(2)
        app.terminate()
        let again = launch("agentsteward://project/\(project)/code")
        sleep(8)
        let tab = again.descendants(matching: .any)["tab-file:LICENSE"].firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 5))
        XCTAssertFalse(tab.label.contains("還沒存"), "沒改的分頁重開後被當成還沒存:\(tab.label)")
    }

    /// 標題列(要接隔離的管家:會換專案,不能碰真的管家):長名字不被右邊的按鈕蓋住、隱私專案有副標題;
    /// 點標題出選單,選別的專案就換過去;「所有專案…」打開完整的專案清單
    ///   TEST_RUNNER_STEWARD_TEST_SERVER=http://127.0.0.1:8797 TEST_RUNNER_STEWARD_TITLE_PROJECT=<長名字、隱私的專案 id>
    ///   TEST_RUNNER_STEWARD_TITLE_NAME=<它的名字> TEST_RUNNER_STEWARD_TITLE_OTHER=<另一個專案的名字>
    func testProjectTitleMenu() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let proj = env["STEWARD_TITLE_PROJECT"],
              let name = env["STEWARD_TITLE_NAME"], let other = env["STEWARD_TITLE_OTHER"] else { throw XCTSkip("要接隔離的管家才跑") }
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-serverURL", server, "-openURL", "agentsteward://project/\(proj)/code"]
        app.launch()
        sleep(8)
        // 標題在哪一條導覽列(iPad 有側欄、編輯區、管家側欄好幾條;只有專案標題是按鈕)
        func titleIn(_ n: String) -> (bar: XCUIElement, title: XCUIElement)? {
            let pred = NSPredicate(format: "label CONTAINS %@", n)
            for bar in app.navigationBars.allElementsBoundByIndex {
                let t = bar.buttons.matching(pred).firstMatch
                if t.exists { return (bar, t) }
            }
            return nil
        }
        // 標題整個在畫面裡,也不跟同一排的任何按鈕重疊(工具列按鈕不一定在導覽列底下,用位置找同一排的)
        func assertNotCovered(_ n: String, _ step: String) {
            guard let (_, title) = titleIn(n) else { return XCTFail("\(step):標題列找不到專案名稱") }
            let tf = title.frame
            XCTAssertGreaterThanOrEqual(tf.minX, 0, "\(step):標題左邊被切掉")
            XCTAssertLessThanOrEqual(tf.maxX, app.windows.firstMatch.frame.maxX, "\(step):標題右邊超出畫面")
            var checked: [String] = []
            for b in app.buttons.allElementsBoundByIndex where b.exists && !b.label.contains(n) {
                let f = b.frame
                guard f.height > 0, f.height < 120, abs(f.midY - tf.midY) < 30 else { continue }
                checked.append(b.label)
                XCTAssertFalse(tf.intersects(f), "\(step):標題被「\(b.label)」蓋住")
            }
            let a = XCTAttachment(string: "\(step) 標題 \(tf) 檢查過的按鈕:\(checked)")
            a.name = "covered-check"; a.lifetime = .keepAlways; add(a)
            XCTAssertFalse(checked.isEmpty, "\(step):同一排找不到其他按鈕,檢查沒有意義")
        }
        XCTAssertTrue(app.navigationBars.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch.waitForExistence(timeout: 5), "標題列找不到專案名稱")
        shot(app, "title-1-long")
        assertNotCovered(name, "長名字")
        XCTAssertTrue(app.navigationBars.staticTexts["隱私專案"].exists, "隱私專案沒有副標題")
        if UIDevice.current.userInterfaceIdiom == .pad, let (bar, _) = titleIn(name) {
            // iPad:再打開管家側欄,中間那欄最窄的時候標題還是不能被蓋住
            _ = bar
            app.buttons["管家"].firstMatch.tap()
            sleep(3)
            shot(app, "title-1b-ipad-drawer")
            assertNotCovered(name, "iPad 打開管家側欄")
            if app.buttons["收起管家"].firstMatch.exists { app.buttons["收起管家"].firstMatch.tap(); sleep(2) }
        }
        // 點標題 → 選單 → 選另一個專案
        titleIn(name)?.title.tap()
        XCTAssertTrue(app.buttons["所有專案…"].waitForExistence(timeout: 5), "點標題沒有出選單")
        shot(app, "title-2-menu")
        app.buttons[other].firstMatch.tap()
        sleep(2)
        XCTAssertNotNil(titleIn(other), "選單選了專案沒有換過去")
        XCTAssertFalse(app.navigationBars.staticTexts["隱私專案"].exists, "換到一般專案還有隱私副標題")
        // 再點標題 →「所有專案…」→ 完整的專案清單
        titleIn(other)?.title.tap()
        XCTAssertTrue(app.buttons["所有專案…"].waitForExistence(timeout: 5))
        app.buttons["所有專案…"].tap()
        XCTAssertTrue(app.navigationBars["專案"].waitForExistence(timeout: 5), "沒有打開完整的專案清單")
        shot(app, "title-3-picker")
        app.navigationBars["專案"].buttons["完成"].tap()
    }

    // MARK: 看檔案(PDF、圖片、文字):縮放下限、點一下全螢幕

    /// 全螢幕:導覽列、底下的分頁列、浮動球都收起來
    private func assertFullScreen(_ app: XCUIApplication, _ on: Bool, _ step: String) {
        let tab = app.tabBars.buttons["看板"]
        let ball = app.descendants(matching: .any)["steward-ball"]
        if on {
            XCTAssertEqual(app.navigationBars.count, 0, "\(step):導覽列還在")
            XCTAssertFalse(tab.exists && tab.isHittable, "\(step):底下的分頁列還在")
            XCTAssertFalse(ball.exists, "\(step):浮動球還在")
        } else {
            XCTAssertGreaterThan(app.navigationBars.count, 0, "\(step):導覽列沒回來")
            XCTAssertTrue(ball.exists, "\(step):浮動球沒回來")
        }
    }

    /// PDF:最小只能縮到最寬的那頁塞滿寬度;點一下全螢幕,再點一下回來
    /// 用 ios-native/zz-mixed.pdf(三頁,第二頁比較寬;測試前建,見 README)
    func testReaderPDF() throws {
        let app = launch("agentsteward://project/\(project)/code?file=ios-native/zz-mixed.pdf", reset: true)
        sleep(8)
        let pdf = app.descendants(matching: .any)["pdf-view"].firstMatch
        XCTAssertTrue(pdf.waitForExistence(timeout: 8), "沒有 PDF")
        shot(app, "pdf-1-fit")
        XCTAssertEqual(pdf.value as? String, "縮放 100%", "一打開不是最寬的那頁塞滿寬度")
        pdf.pinch(withScale: 0.3, velocity: -2)
        sleep(1)
        shot(app, "pdf-2-pinched-out")
        XCTAssertEqual(pdf.value as? String, "縮放 100%", "還能縮得比最寬的那頁塞滿寬度更小")
        pdf.pinch(withScale: 2.5, velocity: 2)
        sleep(1)
        XCTAssertNotEqual(pdf.value as? String, "縮放 100%", "放不大")
        pdf.tap()
        sleep(2)
        shot(app, "pdf-3-fullscreen")
        assertFullScreen(app, true, "PDF 點一下")
        pdf.tap()
        sleep(2)
        assertFullScreen(app, false, "PDF 再點一下")
    }

    /// 圖片:最小只能縮到圖片寬度塞滿畫面;雙擊放大、再雙擊還原;點一下全螢幕,再點一下回來
    func testReaderImage() throws {
        let app = launch("agentsteward://project/\(project)/code?file=docs/images/board.png", reset: true)
        sleep(8)
        let img = app.descendants(matching: .any)["image-view"].firstMatch
        XCTAssertTrue(img.waitForExistence(timeout: 8), "沒有圖片")
        XCTAssertEqual(img.value as? String, "縮放 100%", "一打開不是塞滿寬度")
        img.pinch(withScale: 0.3, velocity: -2)
        sleep(1)
        XCTAssertEqual(img.value as? String, "縮放 100%", "還能縮得比塞滿寬度更小")
        img.doubleTap()
        sleep(1)
        XCTAssertEqual(img.value as? String, "縮放 250%", "雙擊沒有放大")
        img.doubleTap()
        sleep(1)
        XCTAssertEqual(img.value as? String, "縮放 100%", "雙擊沒有還原")
        img.tap()
        sleep(2)
        shot(app, "image-fullscreen")
        assertFullScreen(app, true, "圖片點一下")
        img.tap()
        sleep(2)
        assertFullScreen(app, false, "圖片再點一下")
    }

    /// 文字(程式碼):點一下全螢幕,再點一下回來;點行號是選行,不會全螢幕
    func testReaderText() throws {
        let app = launch("agentsteward://project/\(project)/code?file=LICENSE", reset: true)
        sleep(8)
        let lineOne = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^ *1$")).firstMatch
        XCTAssertTrue(lineOne.waitForExistence(timeout: 5), "找不到行號 1")
        let middle = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.55))
        middle.tap()
        sleep(2)
        shot(app, "text-fullscreen")
        assertFullScreen(app, true, "文字點一下")
        middle.tap()
        sleep(2)
        assertFullScreen(app, false, "文字再點一下")
        lineOne.tap()
        sleep(2)
        assertFullScreen(app, false, "點行號")
    }

    /// iPad 分割:點別格的 PDF 先只是換到那一格;再點一下全螢幕(側欄、別格、分頁列都收起來,PDF 還是塞滿寬度);再點回來
    func testIPadReaderFullScreen() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad 才跑") }
        let app = launch("agentsteward://project/\(project)/code?file=ios-native/zz-mixed.pdf", reset: true)
        sleep(8)
        let el = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        el("row-LICENSE").tap()
        sleep(2)
        app.typeKey(.F12, modifierFlags: [.command, .shift])
        sleep(1)
        app.typeKey("\\", modifierFlags: .command)
        sleep(2)
        XCTAssertTrue(el("pane-1-0").exists, "⌘\\ 沒有分到右邊")
        let pdf = el("pdf-view")
        XCTAssertTrue(pdf.waitForExistence(timeout: 5), "沒有 PDF")
        pdf.tap()
        sleep(2)
        XCTAssertTrue(app.navigationBars["程式碼"].exists, "點別格的 PDF 就全螢幕了")
        pdf.tap()
        sleep(2)
        shot(app, "ipad-reader-fullscreen")
        XCTAssertFalse(app.navigationBars["程式碼"].exists, "全螢幕時側欄還在")
        XCTAssertFalse(el("tab-file:LICENSE").exists, "全螢幕時別格的分頁還在")
        XCTAssertFalse(app.descendants(matching: .any)["steward-ball"].exists, "全螢幕時浮動球還在")
        XCTAssertEqual(pdf.value as? String, "縮放 100%", "全螢幕變寬後 PDF 沒有跟著塞滿寬度")
        pdf.tap()
        sleep(2)
        XCTAssertTrue(app.navigationBars["程式碼"].exists, "側欄沒回來")
        XCTAssertTrue(el("tab-file:LICENSE").exists, "別格沒回來")
    }

    /// Markdown 預覽跟網頁一樣排版:標題、專案裡的圖片(經 app 讀)、表格;點文字全螢幕、再點回來;點連結打開專案裡的檔案
    func testReaderMarkdown() throws {
        let app = launch("agentsteward://project/\(project)/code?file=README.md", reset: true)
        sleep(8)
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 10), "沒有 Markdown 預覽")
        let title = web.staticTexts["專案管家 agent-steward"]
        XCTAssertTrue(title.waitForExistence(timeout: 15), "標題沒有排出來(排版程式沒載到?)")
        let img = web.images["看板"]
        XCTAssertTrue(img.waitForExistence(timeout: 10), "沒有圖片")
        XCTAssertGreaterThan(img.frame.height, 20, "專案裡的圖片沒載到")
        shot(app, "md-1-top")
        web.swipeUp()
        sleep(1)
        shot(app, "md-2-tables")
        web.swipeDown()
        sleep(1)
        title.tap()
        sleep(2)
        assertFullScreen(app, true, "Markdown 點一下")
        title.tap()
        sleep(2)
        assertFullScreen(app, false, "Markdown 再點一下")
        web.links["English"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["tab-file:README.en.md"].waitForExistence(timeout: 8), "點連結沒有打開 README.en.md")
        shot(app, "md-3-link-opened")
    }

    /// 工作卡追問(隔離的管家,先塞好兩張卡):完成的卡顯示對話串(原本的結果、問題、agent 的回覆)和輸入框;
    /// 進行中的卡:送出問題 → 排隊中 → 取消
    ///   TEST_RUNNER_STEWARD_TEST_SERVER=http://127.0.0.1:8797 TEST_RUNNER_STEWARD_FU_DONE=<完成的卡> TEST_RUNNER_STEWARD_FU_RUNNING=<進行中的卡>
    func testCardFollowUp() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["STEWARD_TEST_SERVER"], let done = env["STEWARD_FU_DONE"], let running = env["STEWARD_FU_RUNNING"] else { throw XCTSkip("要接隔離的管家才跑") }
        var app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-serverURL", server, "-openURL", "agentsteward://card/\(done)"]
        app.launch()
        sleep(8)
        let any = { (id: String) in app.descendants(matching: .any)[id].firstMatch }
        XCTAssertTrue(app.staticTexts["原本的結果"].waitForExistence(timeout: 8), "沒有對話串")
        XCTAssertTrue(app.staticTexts["為什麼投影不會改變 loss?"].exists, "沒有問題")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS '內積不變'")).firstMatch.exists, "沒有 agent 的回覆")
        XCTAssertTrue(any("card-ask-field").exists, "完成的卡沒有追問輸入框")
        shot(app, "fu-1-done-thread")
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-serverURL", server, "-openURL", "agentsteward://card/\(running)"]
        app.launch()
        sleep(8)
        let field = app.descendants(matching: .any)["card-ask-field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 8), "進行中的卡沒有追問輸入框")
        field.tap()
        field.typeText("做完順便說明哪些測試失敗")
        app.descendants(matching: .any)["card-ask-send"].firstMatch.tap()
        let queued = app.staticTexts["排隊中,這一輪做完就送出"]
        XCTAssertTrue(queued.waitForExistence(timeout: 8), "送出後沒有排隊中")
        XCTAssertTrue(app.staticTexts["做完順便說明哪些測試失敗"].exists, "對話裡沒有剛問的問題")
        shot(app, "fu-2-queued")
        app.buttons["取消"].firstMatch.tap()
        sleep(3)
        XCTAssertFalse(queued.exists, "取消後還在排隊")
        shot(app, "fu-3-cancelled")
    }
}
