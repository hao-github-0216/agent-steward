#if DEBUG
import Foundation
import SwiftUI

/// UI 測試只攔截保留的假主機，不建立伺服器或轉送請求。
enum SettingsFixture {
    static let base = URL(string: "https://fixture.agentsteward.invalid/")!
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "settingsFixture") }
    static let didChange = Notification.Name("SettingsFixtureDidChange")
    private static let lock = NSLock()
    private static var receipt = String(localized: "尚無 PUT", bundle: AppLanguage.bundle)
    private static var retiredCalls = 0
    private static let sample = SettingsSample(
        desktop: !UserDefaults.standard.bool(forKey: "settingsFixtureNoDesktop"),
        failingWrites: UserDefaults.standard.bool(forKey: "settingsFixtureFailure"),
        updateScenario: UserDefaults.standard.string(forKey: "settingsFixtureUpdate")
            .flatMap(SettingsSample.UpdateScenario.init(rawValue:)) ?? .currentDesktop
    )

    static func configure(_ configuration: URLSessionConfiguration) {
        if enabled { configuration.protocolClasses = [SettingsFixtureProtocol.self] + (configuration.protocolClasses ?? []) }
    }
    static func install() { URLProtocol.registerClass(SettingsFixtureProtocol.self) }
    static var lastWrite: String { lock.lock(); defer { lock.unlock() }; return receipt }
    static var retiredUpdateCalls: Int { lock.lock(); defer { lock.unlock() }; return retiredCalls }

    static func response(for request: URLRequest, body: Data?) -> (Int, [String: Any]) {
        let path = request.url?.path ?? ""
        let updatePath = "/api/settings/update"
        if (request.httpMethod == "POST" && path == updatePath) || path == updatePath + "/log" {
            lock.lock()
            retiredCalls += 1
            lock.unlock()
            DispatchQueue.main.async { NotificationCenter.default.post(name: didChange, object: nil) }
        }
        if request.httpMethod == "PUT" {
            let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let record: [String: Any] = ["method": "PUT", "path": request.url?.path ?? "", "body": input]
            lock.lock()
            receipt = (try? String(data: JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)) ?? ""
            lock.unlock()
            DispatchQueue.main.async { NotificationCenter.default.post(name: didChange, object: nil) }
        }
        return sample.response(for: request, body: body)
    }
}

final class SettingsFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        SettingsFixture.enabled && request.url?.host == SettingsFixture.base.host
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            data = body
        }
        let (code, object) = SettingsFixture.response(for: request, body: data)
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]),
              let body = try? JSONSerialization.data(withJSONObject: object) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct SettingsFixtureProbe: View {
    @State private var receipt = SettingsFixture.lastWrite
    @State private var retiredCalls = SettingsFixture.retiredUpdateCalls
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(receipt).font(.caption2).lineLimit(2)
                .accessibilityIdentifier("fixture-last-put")
            Text(verbatim: String(retiredCalls)).font(.caption2)
                .accessibilityIdentifier("fixture-retired-update-calls")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(6).background(.thinMaterial)
        .onReceive(NotificationCenter.default.publisher(for: SettingsFixture.didChange)) { _ in
            receipt = SettingsFixture.lastWrite
            retiredCalls = SettingsFixture.retiredUpdateCalls
        }
    }
}
#endif
