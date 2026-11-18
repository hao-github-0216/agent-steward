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

    private func launch(_ path: String, testEdit: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(zh-Hant)", "-AppleLocale", "zh_TW", "-noPush", "YES", "-isDemo", "NO", "-serverURL", server,
                               "-resetCodeLayout", "YES", "-openURL", "agentsteward://project/\(project)/code?file=\(path)"]
        if testEdit { app.launchArguments += ["-pdfMarkupTestEdit", "YES"] }
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

    private func inkAnnotations(_ data: Data) throws -> [PDFAnnotation] {
        let document = try XCTUnwrap(PDFDocument(data: data))
        return try XCTUnwrap(document.page(at: 0)).annotations.filter { $0.type == "Ink" }
    }

    private func waitForSave(_ app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts["已儲存"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(element(app, "pdf-markup").isEnabled)
        XCTAssertFalse(element(app, "pdf-markup-saving").exists)
        XCTAssertTrue(element(app, "pdf-view").exists)
    }

    func testMarkupButtonOpensQuickLook() throws {
        let before = try request()
        let app = launch("notes.pdf")
        defer { app.terminate() }
        element(app, "pdf-markup").tap()
        let done = app.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", ["完成", "Done"])).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 30))
        let markup = element(app, "QLOverlayMarkupButtonAccessibilityIdentifier")
        XCTAssertTrue(markup.waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true AND enabled == true"), object: markup)
        let result = XCTWaiter.wait(for: [ready], timeout: 30)
        shot(app, "pdf-01-system-markup")
        XCTAssertEqual(result, .completed, app.debugDescription)
        done.tap()
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: done)
        wait(for: [dismissed], timeout: 15)
        XCTAssertTrue(element(app, "pdf-view").exists)
        XCTAssertTrue(element(app, "pdf-markup").isHittable)
        XCTAssertEqual(try request(), before)
    }

    func testMarkupSaveWritesBack() throws {
        let before = try request()
        let initial = try inkAnnotations(before).count
        let app = launch("notes.pdf", testEdit: true)
        defer { app.terminate() }
        element(app, "pdf-markup").tap()
        waitForSave(app)
        let after = try request()
        XCTAssertNotEqual(after, before)
        let annotations = try inkAnnotations(after)
        XCTAssertEqual(annotations.count, initial + 1)
        XCTAssertEqual(annotations.last?.bounds, CGRect(x: 100, y: 100, width: 100, height: 50))
        shot(app, "pdf-02-saved")
    }

    func testMarkupConflict() throws {
        let before = try request()
        let initial = try inkAnnotations(before).count
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: request("file")) as? [String: Any])
        let hash = try XCTUnwrap(metadata["hash"] as? String)
        let app = launch("notes.pdf", testEdit: true)
        defer { app.terminate() }
        let markup = element(app, "pdf-markup")
        XCTAssertTrue(markup.isHittable)
        let diskDocument = try XCTUnwrap(PDFDocument(data: before))
        var attributes = diskDocument.documentAttributes ?? [:]
        attributes[PDFDocumentAttribute.subjectAttribute] = UUID().uuidString
        diskDocument.documentAttributes = attributes
        _ = try request("pdf", method: "PUT", body: XCTUnwrap(diskDocument.dataRepresentation()), hash: hash)
        let changedOnDisk = try request()
        markup.tap()
        XCTAssertTrue(app.buttons["蓋過去"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(try request(), changedOnDisk)
        shot(app, "pdf-03-conflict")
        app.buttons["蓋過去"].firstMatch.tap()
        waitForSave(app)
        let after = try request()
        XCTAssertNotEqual(after, changedOnDisk)
        XCTAssertEqual(try inkAnnotations(after).count, initial + 1)
    }

    func testLaTeXPDFIsReadOnly() {
        let app = launch("hw.pdf")
        defer { app.terminate() }
        XCTAssertTrue(element(app, "pdf-latex-notice").waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["這是 LaTeX 產生的 PDF,請改 .tex"].exists)
        XCTAssertFalse(element(app, "pdf-markup").exists)
        shot(app, "pdf-04-latex-readonly")
    }
}
