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
}
