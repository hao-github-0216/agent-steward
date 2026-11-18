import PDFKit
import XCTest

final class PDFAnnotateTests: XCTestCase {
    private var project: String { ProcessInfo.processInfo.environment["STEWARD_TEST_PROJECT"] ?? "" }
    private var server: String { ProcessInfo.processInfo.environment["STEWARD_TEST_SERVER"] ?? "" }

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let url = URL(string: server), url.host == "127.0.0.1", url.port == 18799, !project.isEmpty else {
            throw XCTSkip("PDF 測試只接 18799 的隔離管家")
        }
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: request("file")) as? [String: Any])
        _ = try request("pdf", method: "PUT", body: request(path: "hw.pdf"), hash: metadata["hash"] as? String)
    }

    private func launch(_ path: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES", "-serverURL", server,
                               "-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=\(path)"]
        app.launch()
        XCTAssertTrue(element(app, "pdf-view").waitForExistence(timeout: 30))
        return app
    }

    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func request(_ op: String = "raw", method: String = "GET", body: Data? = nil, hash: String? = nil, path: String = "notes.pdf") throws -> Data {
        var url = URLComponents(string: "\(server)/api/code/\(project)/\(op)")!
        url.queryItems = [URLQueryItem(name: "path", value: path)]
        if let hash { url.queryItems?.append(URLQueryItem(name: "baseHash", value: hash)) }
        var request = URLRequest(url: url.url!)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/pdf", forHTTPHeaderField: "content-type") }
        let done = expectation(description: "PDF request")
        var result: Result<Data, Error>?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { result = .failure(error) }
            else if let response = response as? HTTPURLResponse, response.statusCode == 200 { result = .success(data ?? Data()) }
            else { result = .failure(NSError(domain: "PDF test", code: (response as? HTTPURLResponse)?.statusCode ?? 0)) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        return try XCTUnwrap(result).get()
    }

    private func count(_ app: XCUIApplication, equals value: Int) {
        let count = element(app, "pdf-annotation-count")
        let predicate = NSPredicate(format: "label == %@", "標註 \(value) 個")
        XCTAssertTrue(expectation(for: predicate, evaluatedWith: count).expectationDescription.count > 0)
        waitForExpectations(timeout: 30)
    }

    private func reveal(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        let target = element(app, identifier)
        let toolbar = element(app, "pdf-tools")
        for _ in 0..<4 {
            if target.exists {
                let frame = target.frame
                let visible = toolbar.frame.intersection(app.frame)
                if !frame.isEmpty, visible.contains(CGPoint(x: frame.midX, y: frame.midY)) { return target }
            }
            let origin = toolbar.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: toolbar.frame.width * 0.65, dy: 25))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: toolbar.frame.width * 0.1, dy: 25)))
        }
        XCTAssertTrue(target.exists && toolbar.frame.intersects(target.frame))
        return target
    }

    private func draw(_ app: XCUIApplication) {
        reveal(app, "pdf-tool-ink").tap()
        let pdf = element(app, "pdf-view")
        pdf.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3))
            .press(forDuration: 0.05, thenDragTo: pdf.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.4)))
    }

    private func selectFirstLine(_ app: XCUIApplication) {
        let pdf = element(app, "pdf-view")
        // 測試 PDF 的第一行距頁面頂端 72pt，左右各留 48pt。
        let scale = (pdf.frame.width - 16) / 612
        let start = pdf.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 8 + 50 * scale, dy: 8 + 70 * scale))
        start.press(forDuration: 1.1, thenDragTo: start.withOffset(CGVector(dx: 220 * scale, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    func testSelectionMenuAndUndo() throws {
        let initial = try XCTUnwrap(PDFDocument(data: request())?.page(at: 0)?.annotations.count)
        let app = launch("notes.pdf")
        defer { app.terminate() }
        selectFirstLine(app)
        let underline = app.menuItems["底線"].firstMatch
        XCTAssertTrue(underline.waitForExistence(timeout: 5))
        underline.tap()
        count(app, equals: initial + 1)
        shot(app, "pdf-07-selection-menu")
        element(app, "pdf-annotate").tap()
        reveal(app, "pdf-undo").tap()
        count(app, equals: initial)
    }

    func testConflictKeepsTabOpen() throws {
        let before = try request()
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: request("file")) as? [String: Any])
        let hash = try XCTUnwrap(metadata["hash"] as? String)
        let app = launch("notes.pdf")
        defer { app.terminate() }
        element(app, "pdf-annotate").tap()
        draw(app)
        let diskDocument = try XCTUnwrap(PDFDocument(data: before))
        var attributes = diskDocument.documentAttributes ?? [:]
        attributes[PDFDocumentAttribute.subjectAttribute] = UUID().uuidString
        diskDocument.documentAttributes = attributes
        _ = try request("pdf", method: "PUT", body: XCTUnwrap(diskDocument.dataRepresentation()), hash: hash)
        let changedOnDisk = try request()
        app.buttons["關閉 notes.pdf"].firstMatch.tap()
        XCTAssertTrue(app.buttons["存檔再關閉"].waitForExistence(timeout: 5))
        app.buttons["存檔再關閉"].tap()
        XCTAssertTrue(app.alerts["沒存成"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.alerts.staticTexts["檔案在你開啟之後被改過了"].exists)
        app.alerts.buttons["好"].tap()
        XCTAssertTrue(element(app, "tab-file:notes.pdf").exists)
        XCTAssertEqual(try request(), changedOnDisk)
        reveal(app, "pdf-save").tap()
        XCTAssertTrue(app.buttons["蓋過去"].waitForExistence(timeout: 10))
        shot(app, "pdf-08-conflict")
        app.buttons["蓋過去"].tap()
        let saved = expectation(for: NSPredicate(format: "enabled == false"), evaluatedWith: element(app, "pdf-save"))
        wait(for: [saved], timeout: 15)
        XCTAssertNotEqual(try request(), changedOnDisk)
    }

    func testAnnotateAndSave() throws {
        let before = try request()
        let initial = try XCTUnwrap(PDFDocument(data: before)?.page(at: 0)?.annotations.count)
        let app = launch("notes.pdf")
        defer { app.terminate() }
        element(app, "pdf-annotate").tap()
        reveal(app, "pdf-tool-highlight").tap()
        let pdf = element(app, "pdf-view")
        selectFirstLine(app)
        count(app, equals: initial + 1)
        shot(app, "pdf-01-highlight")
        draw(app)
        count(app, equals: initial + 2)
        shot(app, "pdf-02-ink")
        reveal(app, "pdf-tool-freeText").tap()
        pdf.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5)).tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("中文筆記")
        app.alerts.buttons["加上"].tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.alerts["輸入標註文字"])
        wait(for: [dismissed], timeout: 30)
        count(app, equals: initial + 3)
        shot(app, "pdf-03-chinese-text")
        reveal(app, "pdf-save").tap()
        XCTAssertTrue(expectation(for: NSPredicate(format: "enabled == false"), evaluatedWith: element(app, "pdf-save")).expectationDescription.count > 0)
        waitForExpectations(timeout: 15)
        let after = try request()
        XCTAssertNotEqual(before, after)
        let document = try XCTUnwrap(PDFDocument(data: after))
        let annotations = try XCTUnwrap(document.page(at: 0)).annotations
        XCTAssertEqual(annotations.count, initial + 3)
        XCTAssertTrue(annotations.contains { $0.type == "Highlight" })
        XCTAssertTrue(annotations.contains { $0.type == "Ink" })
        XCTAssertTrue(annotations.contains { $0.type == "FreeText" && $0.contents == "中文筆記" })
        XCTAssertTrue(annotations.filter { $0.userName == "Agent Steward" }.allSatisfy { $0.modificationDate != nil })
        shot(app, "pdf-04-saved")
    }

    func testLaTeXPDFIsReadOnly() {
        let app = launch("hw.pdf")
        defer { app.terminate() }
        XCTAssertTrue(element(app, "pdf-latex-notice").waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "pdf-annotate").exists)
        shot(app, "pdf-05-latex-readonly")
    }

    func testUnsavedSwitchAndClose() throws {
        let before = try request()
        let initial = try XCTUnwrap(PDFDocument(data: before)?.page(at: 0)?.annotations.count)
        let app = launch("hw.pdf")
        defer { app.terminate() }
        let notes = element(app, "row-notes.pdf")
        if !notes.isHittable { app.navigationBars.buttons["BackButton"].firstMatch.tap() }
        XCTAssertTrue(notes.waitForExistence(timeout: 10))
        notes.tap()
        XCTAssertTrue(element(app, "pdf-annotate").waitForExistence(timeout: 10))
        element(app, "pdf-annotate").tap()
        draw(app)
        count(app, equals: initial + 1)
        element(app, "tab-file:hw.pdf").tap()
        XCTAssertTrue(app.buttons["存檔再切換"].waitForExistence(timeout: 10))
        if app.buttons["取消"].firstMatch.exists { app.buttons["取消"].firstMatch.tap() }
        else { element(app, "PopoverDismissRegion").tap() }
        XCTAssertTrue(element(app, "pdf-annotate").exists)
        count(app, equals: initial + 1)
        element(app, "tab-file:hw.pdf").tap()
        XCTAssertTrue(app.buttons["不存,直接切換"].waitForExistence(timeout: 10))
        app.buttons["不存,直接切換"].tap()
        XCTAssertTrue(element(app, "pdf-latex-notice").waitForExistence(timeout: 10))
        XCTAssertEqual(try request(), before)
        element(app, "tab-file:notes.pdf").tap()
        XCTAssertTrue(element(app, "pdf-annotate").waitForExistence(timeout: 10))
        count(app, equals: initial)
        element(app, "pdf-annotate").tap()
        draw(app)
        count(app, equals: initial + 1)
        app.buttons["關閉 notes.pdf"].firstMatch.tap()
        XCTAssertTrue(app.buttons["存檔再關閉"].waitForExistence(timeout: 5))
        app.buttons["存檔再關閉"].tap()
        XCTAssertTrue(expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element(app, "tab-file:notes.pdf")).expectationDescription.count > 0)
        waitForExpectations(timeout: 15)
        XCTAssertNotEqual(try request(), before)
        shot(app, "pdf-06-save-and-close")
    }
}
