import Foundation

final class DemoURLProtocol: URLProtocol {
    private let lock = NSRecursiveLock()
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "demo.agentsteward.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let reply = DemoData.response(for: request)
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                                     headerFields: ["Content-Type": reply.contentType, "Cache-Control": "no-store"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        guard !stopped else { return }
        client?.urlProtocol(self, didLoad: reply.data)
        if reply.write {
            NotificationCenter.default.post(name: .stewardDemoWrite, object: nil)
        }
        // 即時事件只送一次註解，連線保持開啟，直到 App 取消請求。
        if !stopped && !reply.eventStream { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() {
        lock.lock()
        stopped = true
        lock.unlock()
    }
}

extension Notification.Name {
    static let stewardDemoWrite = Notification.Name("stewardDemoWrite")
}
