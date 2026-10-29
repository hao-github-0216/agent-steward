// 模擬器手勢測試(手指拖動、往上拉視窗這種沒辦法用連結測的)。要連到真的管家:
//   xcodebuild test -project Steward.xcodeproj -scheme Steward -destination 'id=<模擬器 UDID>' TEST_RUNNER_STEWARD_PROJECT=<專案 id>
//   截圖在測試結果裡:xcrun xcresulttool export attachments --path <.xcresult> --output-path <資料夾>
// 只會打開看板/程式碼頁和管家側欄,不會切到終端機(不會動到電腦上 herdr 的畫面)
import XCTest

final class GestureTests: XCTestCase {
    private var project: String { ProcessInfo.processInfo.environment["STEWARD_PROJECT"] ?? "" }

    override func setUp() { continueAfterFailure = true }

    private func launch(_ link: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-noPush", "YES", "-openURL", link]
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
}
