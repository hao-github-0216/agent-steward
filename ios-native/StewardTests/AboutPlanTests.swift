import XCTest
@testable import Steward

final class AboutPlanTests: XCTestCase {
    private func decode(_ json: String) throws -> SettingsUpdate {
        try JSONDecoder().decode(SettingsUpdate.self, from: Data(json.utf8))
    }

    private func plan(_ json: String, responseDesktop: Bool? = nil, platform: String? = "darwin") throws -> AboutPlan {
        AboutPlan.make(update: try decode(json), responseDesktop: responseDesktop, platform: platform)
    }

    func testCurrentDesktop() throws {
        let update = try decode(#"{"current":"0.4.0","latest":"0.4.1","hasUpdate":true,"dev":false,"desktop":true,"downloadUrl":"https://example.invalid/download","releaseUrl":"https://example.invalid/releases/0.4.0","integrity":{"status":"ok","counts":{"changed":0,"missing":0,"added":0}},"components":[]}"#)
        XCTAssertTrue(update.supportsDesktopDownload)
        XCTAssertNil(update.running)
        XCTAssertEqual(AboutPlan.make(update: update, responseDesktop: false, platform: "darwin"),
                       AboutPlan(update: .desktopCheck, uninstall: .desktop, integrity: .none))
    }

    func testCurrentServiceDownloadsDesktopAppWithoutUninstallCommand() throws {
        let result = try plan(#"{"current":"0.4.0","latest":"0.4.1","hasUpdate":true,"dev":false,"desktop":false,"downloadUrl":"https://example.invalid/download","releaseUrl":"https://example.invalid/releases/0.4.0","integrity":{"status":"ok","counts":{"changed":0,"missing":0,"added":0}},"components":[]}"#, responseDesktop: true)
        XCTAssertEqual(result.update, .downloadApp(URL(string: "https://example.invalid/download")!))
        XCTAssertEqual(result.uninstall, .unknown)
        XCTAssertEqual(result.integrity, .none)
    }

    func testDevelopmentUninstallRequiresCurrentProtocolAndUnixPlatform() throws {
        let json = #"{"current":"0.4.0","hasUpdate":true,"desktop":false,"dev":true,"releaseUrl":null}"#
        for platform in ["darwin", "linux"] {
            XCTAssertEqual(try plan(json, platform: platform).uninstall, .devScript, platform)
        }
        let unsupported: [String?] = ["win32", "unknown", nil]
        for platform in unsupported {
            XCTAssertEqual(try plan(json, platform: platform).uninstall, .unknown, platform ?? "nil")
        }
        XCTAssertEqual(try plan(#"{"hasUpdate":true,"desktop":false,"dev":true,"downloadUrl":"https://example.invalid/download"}"#).uninstall, .unknown)
    }

    func testLegacy040CannotDownloadOrUpdateService() throws {
        let update = try decode(#"{"current":"0.4.0","latest":"0.4.1","hasUpdate":true,"dev":false,"url":"https://example.invalid/release","notes":"Release notes","running":false,"desktop":false,"downloadUrl":"https://example.invalid/download","components":[{"id":"herdr","name":"herdr","version":"1.0","license":"MIT","home":"https://example.invalid/herdr"}]}"#)
        XCTAssertFalse(update.supportsDesktopDownload)
        XCTAssertEqual(update.running, false)
        XCTAssertEqual(update.downloadUrl, "https://example.invalid/download")
        XCTAssertEqual(update.components?.first?.id, "herdr")
        XCTAssertEqual(AboutPlan.make(update: update, responseDesktop: nil, platform: "darwin"),
                       AboutPlan(update: .legacyGuide, uninstall: .unknown, integrity: .none))
    }

    func testLegacyDesktopStillChecksForUpdates() throws {
        let result = try plan(#"{"current":"0.4.0","latest":"0.4.1","hasUpdate":true,"dev":false,"running":false,"desktop":true,"downloadUrl":"https://example.invalid/download","components":[]}"#)
        XCTAssertEqual(result.update, .desktopCheck)
        XCTAssertEqual(result.uninstall, .desktop)
    }

    func testLegacy03WithoutDownloadURLDecodes() throws {
        let update = try decode(#"{"current":"0.3.0","latest":"0.4.1","hasUpdate":true,"dev":false,"running":false,"desktop":false,"components":[]}"#)
        XCTAssertNil(update.downloadUrl)
        XCTAssertFalse(update.supportsDesktopDownload)
        let result = AboutPlan.make(update: update, responseDesktop: nil, platform: "darwin")
        XCTAssertEqual(result.update, .legacyGuide)
        XCTAssertEqual(result.uninstall, .unknown)
    }

    func testUnavailableDownloadURLsDecodeWithoutFailure() throws {
        let values: [String?] = [nil, #""javascript:alert(1)""#, #""ftp://x""#, #""not a url""#, "123"]
        for value in values {
            let download = value.map { ",\"downloadUrl\":\($0)" } ?? ""
            let result = try plan("{\"hasUpdate\":true,\"desktop\":false,\"releaseUrl\":null\(download)}")
            XCTAssertEqual(result.update, .downloadUnavailable, value ?? "missing")
        }
    }

    func testProtocolCapabilityUsesKeyPresenceRatherThanValue() throws {
        for json in [
            #"{"hasUpdate":true,"releaseUrl":null}"#,
            #"{"hasUpdate":true,"integrity":null}"#,
            #"{"hasUpdate":true,"releaseUrl":123}"#,
            #"{"hasUpdate":true,"integrity":"weird"}"#
        ] {
            let update = try decode(json)
            XCTAssertTrue(update.supportsDesktopDownload)
            let result = AboutPlan.make(update: update, responseDesktop: nil, platform: nil)
            XCTAssertEqual(result.update, .downloadUnavailable)
            XCTAssertEqual(result.integrity, .none)
        }
    }

    func testIntegrityPendingAndModified() throws {
        XCTAssertEqual(try plan(#"{"integrity":{"status":"pending"}}"#).integrity, .none)
        let modified = try plan(#"{"releaseUrl":"https://example.invalid/releases/0.4.0","integrity":{"status":"modified","changed":["a"],"missing":["b"],"added":["c"],"counts":{"changed":1,"missing":1,"added":1}}}"#)
        XCTAssertEqual(modified.integrity, .modified(count: 3, installer: URL(string: "https://example.invalid/releases/0.4.0")!))
        XCTAssertEqual(try plan(#"{"releaseUrl":"javascript:alert(1)","integrity":{"status":"modified"}}"#).integrity,
                       .modified(count: nil, installer: nil))
        XCTAssertEqual(try plan(#"{"integrity":"weird"}"#).integrity, .none)
        for status in ["ok", "unavailable", "error"] {
            XCTAssertEqual(try plan("{\"integrity\":{\"status\":\"\(status)\"}}").integrity, .none)
        }
    }

    func testIntegrityCountsDecodeLoosely() throws {
        for counts in ["null", #""invalid""#] {
            XCTAssertEqual(try plan("{\"integrity\":{\"status\":\"modified\",\"counts\":\(counts)}}").integrity,
                           .modified(count: nil, installer: nil))
        }
        XCTAssertEqual(try plan(#"{"integrity":{"status":"modified","counts":{"changed":"wrong","missing":2,"added":null}}}"#).integrity,
                       .modified(count: 2, installer: nil))
        XCTAssertEqual(try plan(#"{"integrity":{"status":"modified","counts":{}}}"#).integrity,
                       .modified(count: 0, installer: nil))
        let update = try decode(#"{"integrity":{"status":123,"counts":{"changed":1}}}"#)
        XCTAssertNil(update.integrity?.status)
        XCTAssertEqual(update.integrity?.counts?.changed, 1)
    }

    func testEveryUpdateFieldDecodesLoosely() throws {
        let update = try decode(#"{"current":123,"latest":false,"hasUpdate":"yes","running":[],"desktop":"false","dev":1,"error":{},"url":123,"notes":true,"components":[{"id":123}],"downloadUrl":123,"releaseUrl":false,"integrity":"x"}"#)
        XCTAssertNil(update.current)
        XCTAssertNil(update.latest)
        XCTAssertNil(update.hasUpdate)
        XCTAssertNil(update.running)
        XCTAssertNil(update.desktop)
        XCTAssertNil(update.dev)
        XCTAssertNil(update.error)
        XCTAssertNil(update.url)
        XCTAssertNil(update.notes)
        XCTAssertNil(update.components)
        XCTAssertNil(update.downloadUrl)
        XCTAssertNil(update.releaseUrl)
        XCTAssertNil(update.integrity)
        XCTAssertTrue(update.supportsDesktopDownload)
    }

    func testMissingUpdateAndNoNewVersion() throws {
        XCTAssertEqual(AboutPlan.make(update: nil, responseDesktop: nil, platform: nil),
                       AboutPlan(update: .none, uninstall: .unknown, integrity: .none))
        XCTAssertEqual(AboutPlan.make(update: nil, responseDesktop: true, platform: nil),
                       AboutPlan(update: .desktopCheck, uninstall: .desktop, integrity: .none))
        for json in [#"{}"#, #"{"hasUpdate":false,"releaseUrl":null}"#] {
            XCTAssertEqual(try plan(json).update, .none)
        }
        XCTAssertEqual(try plan(#"{"hasUpdate":false,"desktop":true}"#).update, .desktopCheck)
        XCTAssertEqual(try plan(#"{"hasUpdate":false}"#, responseDesktop: true).update, .desktopCheck)
    }

    func testSourcesDoNotUseRetiredUpdateOrUninstallPaths() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let directory = sourceRoot.appendingPathComponent("Steward")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        let action = try NSRegularExpression(pattern: #"\b(?:action|settingsAction)\s*\(\s*"api/settings/update""#)
        for case let file as URL in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            for path in ["api/settings/update/log", "uninstall.ps1", "app/uninstall.sh"] {
                XCTAssertFalse(source.contains(path), "\(file.lastPathComponent) 不應使用 \(path)")
            }
            XCTAssertNil(action.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
                         "\(file.lastPathComponent) 不應呼叫一鍵更新")
        }
    }
}
