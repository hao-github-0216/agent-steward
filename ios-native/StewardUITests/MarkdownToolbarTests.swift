import XCTest

final class MarkdownToolbarTests: XCTestCase {
    private var project: String { ProcessInfo.processInfo.environment["STEWARD_TEST_PROJECT"] ?? "" }
    private var server: String { ProcessInfo.processInfo.environment["STEWARD_TEST_SERVER"] ?? "" }

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799, !project.isEmpty else {
            throw XCTSkip("Markdown 測試只接 18799 的隔離管家")
        }
        XCUIDevice.shared.orientation = .portrait
        let body = try JSONSerialization.data(withJSONObject: ["path": "notes.md", "content": "hello world\n", "force": true])
        _ = try request("file", method: "PUT", body: body)
    }

    private func request(_ op: String = "file", method: String = "GET", body: Data? = nil) throws -> Data {
        var url = URLComponents(string: "\(server)/api/code/\(project)/\(op)")!
        url.queryItems = [URLQueryItem(name: "path", value: "notes.md")]
        var request = URLRequest(url: url.url!)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "content-type") }
        let done = expectation(description: "Markdown request")
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if let response = response as? HTTPURLResponse, response.statusCode == 200 { result = .success(data ?? Data()) }
            else { result = .failure(NSError(domain: "Markdown test", code: (response as? HTTPURLResponse)?.statusCode ?? 0)) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        return try XCTUnwrap(result).get()
    }

    private func savedText() throws -> String {
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: request()) as? [String: Any])
        return try XCTUnwrap(metadata["content"] as? String)
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func launch(selection: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES", "-isDemo", "NO", "-serverURL", server,
                               "-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=notes.md", "-mdTestSelect", selection]
        app.launch()
        let edit = app.buttons["編輯"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 30))
        edit.tap()
        XCTAssertTrue(app.textViews["markdown-editor"].waitForExistence(timeout: 15))
        XCTAssertTrue(element(app, "md-tool-bold").exists)
        return app
    }

    private func revealTool(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        let tool = element(app, identifier)
        let toolbar = element(app, "markdown-toolbar")
        for _ in 0..<10 {
            if tool.exists && toolbar.frame.contains(tool.frame) { return tool }
            toolbar.swipeLeft()
        }
        XCTAssertTrue(tool.exists && toolbar.frame.contains(tool.frame), "無法顯示 \(identifier)")
        return tool
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "\(app.frame.width > 700 ? "ipad" : "iphone")-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func save(_ app: XCUIApplication) {
        let save = app.buttons["儲存"].firstMatch
        XCTAssertTrue(save.isEnabled)
        save.tap()
        let finished = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.textViews["markdown-editor"])
        wait(for: [finished], timeout: 20)
        XCTAssertTrue(app.buttons["編輯"].firstMatch.exists)
    }

    /// 深色模式：空白檔案先按工具列再打字，字要是亮色(看得到),不能是預設的黑字
    func testDarkModeToolbarTextIsVisible() throws {
        let body = try JSONSerialization.data(withJSONObject: ["path": "notes.md", "content": "", "force": true])
        _ = try request("file", method: "PUT", body: body)
        XCUIDevice.shared.appearance = .dark
        defer { XCUIDevice.shared.appearance = .light }
        let app = launch(selection: "0,0")
        defer { app.terminate() }
        let editor = app.textViews["markdown-editor"]
        element(app, "md-tool-bold").tap()
        editor.typeText("Dark mode text")
        XCTAssertTrue((editor.value as? String ?? "").contains("Dark mode text"))
        sleep(1)
        shot(app, "markdown-dark")
        // 編輯器上方一塊裡要有夠亮的字(深色底上的黑字一個亮點都沒有)
        let screenshot = app.screenshot().image
        let scale = screenshot.scale
        let area = CGRect(x: editor.frame.minX * scale, y: editor.frame.minY * scale,
                          width: editor.frame.width * scale, height: min(120, editor.frame.height) * scale)
        let (bright, dark, total) = pixels(in: screenshot, area: area)
        XCTAssertGreaterThan(Double(dark) / Double(max(total, 1)), 0.5, "畫面不是深色模式，這個測試量不到")
        XCTAssertGreaterThan(bright, 30, "深色模式下工具列插入的文字看不到")
    }

    /// 數一塊畫面裡的亮點和暗點
    private func pixels(in image: UIImage, area: CGRect) -> (bright: Int, dark: Int, total: Int) {
        guard let cg = image.cgImage?.cropping(to: area) else { return (0, 0, 0) }
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return (0, 0, 0) }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var bright = 0, dark = 0
        for i in stride(from: 0, to: data.count, by: 4) {
            let (r, g, b) = (data[i], data[i + 1], data[i + 2])
            if r > 200 && g > 200 && b > 200 { bright += 1 } else if r < 60 && g < 60 && b < 60 { dark += 1 }
        }
        return (bright, dark, w * h)
    }

    func testBoldAndTableSaveToDisk() throws {
        var app = launch(selection: "0,5")
        defer { app.terminate() }
        shot(app, "markdown-toolbar")
        element(app, "md-tool-bold").tap()
        XCTAssertEqual(app.textViews["markdown-editor"].value as? String, "**hello** world\n")
        save(app)
        let bold = try savedText()
        XCTAssertTrue(bold.contains("**hello**"), bold)
        app.terminate()
        app = launch(selection: "\((bold as NSString).length),0")
        let editor = app.textViews["markdown-editor"]
        revealTool(app, "md-tool-table").tap()
        let cols = app.alerts["插入表格"].textFields["欄數"]
        let rows = app.alerts["插入表格"].textFields["列數（含標題）"]
        XCTAssertTrue(cols.waitForExistence(timeout: 5))
        for field in [cols, rows] {
            field.tap()
            let value = field.value as? String ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count) + "2")
        }
        element(app, "md-tool-table-insert").tap()
        XCTAssertTrue((editor.value as? String ?? "").contains("| --- | --- |"))
        shot(app, "markdown-table")
        save(app)
        let saved = try savedText()
        XCTAssertTrue(saved.contains("**hello**"), saved)
        XCTAssertTrue(saved.contains("| Column 1 | Column 2 |"), saved)
        XCTAssertTrue(saved.contains("| --- | --- |"), saved)
    }

    func testMermaidTemplateRendersInPreview() throws {
        let app = launch(selection: "12,0")
        defer { app.terminate() }
        revealTool(app, "md-tool-mermaid").tap()
        let flowchart = element(app, "md-tool-mermaid-flowchart")
        XCTAssertTrue(flowchart.waitForExistence(timeout: 5))
        flowchart.tap()
        save(app)
        let saved = try savedText()
        XCTAssertTrue(saved.contains("```mermaid\nflowchart TD"), saved)
        app.buttons["預覽"].firstMatch.tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        let diagram = web.images.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "Start", "End")).firstMatch
        XCTAssertTrue(diagram.waitForExistence(timeout: 45), web.debugDescription)
        shot(app, "mermaid-preview")
    }
}
