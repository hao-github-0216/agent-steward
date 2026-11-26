import Observation
import UIKit
import WebKit

@MainActor @Observable final class KaTeXMath: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = KaTeXMath()
    var version = 0

    private struct Request {
        let latex: String
        let size: CGFloat
        let display: Bool
        let dark: Bool

        var key: String { "\(display ? "D" : "T")|\(size)|\(dark ? "d" : "l")|\(latex)" }
    }

    private struct Parameters: Encodable {
        let latex: String
        let size: CGFloat
        let display: Bool
        let color: String
    }

    @ObservationIgnored private let cache = NSCache<NSString, Markdown.MathRender>()
    @ObservationIgnored private var failed = Set<String>()
    @ObservationIgnored private var queue: [Request] = []
    @ObservationIgnored private var active: Request?
    @ObservationIgnored private var webView: WKWebView?
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var unavailable = false
    @ObservationIgnored private var timeout: Task<Void, Never>?

    private override init() { super.init() }

    func image(_ latex: String, size: CGFloat, display: Bool, dark: Bool) -> Markdown.MathRender? {
        let request = Request(latex: latex, size: size, display: display, dark: dark)
        if let hit = cache.object(forKey: request.key as NSString) { return hit }
        guard !failed.contains(request.key) else { return nil }
        if active?.key != request.key, !queue.contains(where: { $0.key == request.key }) {
            queue.append(request)
        }
        Task { @MainActor in self.startNext() }
        return nil
    }

    private func startNext() {
        guard active == nil, !queue.isEmpty else { return }
        guard !unavailable else { failAll(); return }
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { return }

        if webView == nil {
            let configuration = WKWebViewConfiguration()
            configuration.userContentController.add(self, name: "math")
            let view = WKWebView(frame: CGRect(x: -10000, y: 0, width: 1024, height: 256), configuration: configuration)
            view.isOpaque = false
            view.backgroundColor = .clear
            view.scrollView.backgroundColor = .clear
            view.scrollView.isScrollEnabled = false
            // 截圖使用網頁座標,不加入安全區域的位移。
            view.scrollView.contentInsetAdjustmentBehavior = .never
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            view.navigationDelegate = self
            window.addSubview(view)
            webView = view
            view.loadHTMLString(Self.page, baseURL: nil)
            timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, !self.ready else { return }
                self.failAll()
            }
        } else if webView?.window !== window, let webView {
            window.addSubview(webView)
        }
        guard ready, let webView else { return }

        let request = queue.removeFirst()
        active = request
        let color = UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: request.dark ? .dark : .light))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let hex = String(format: "#%02X%02X%02X", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
        let parameters = Parameters(latex: request.latex, size: request.size, display: request.display, color: hex)
        guard let data = try? JSONEncoder().encode(parameters) else { finish(nil); return }
        let json = String(decoding: data, as: UTF8.self)
        webView.evaluateJavaScript("renderMath(\(json)).then(result => window.webkit.messageHandlers.math.postMessage({type: 'rendered', ...result})); null") { [weak self] _, error in
            guard let self, self.active?.key == request.key, error != nil else { return }
            self.finish(nil)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !unavailable, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            timeout?.cancel()
            startNext()
        case "failed":
            failAll()
        case "rendered":
            snapshot(body)
        default:
            break
        }
    }

    private func snapshot(_ body: [String: Any]) {
        guard let request = active, let webView else { return }
        guard body["ok"] as? Bool == true,
              let x = body["x"] as? Double, let y = body["y"] as? Double,
              let width = body["width"] as? Double, let height = body["height"] as? Double,
              let descent = body["descent"] as? Double,
              [x, y, width, height, descent].allSatisfy(\.isFinite),
              x >= 0, y >= 0, width > 0, height > 0 else { finish(nil); return }
        let rect = CGRect(x: x, y: y, width: width, height: height)
        webView.frame.size = CGSize(width: ceil(rect.maxX + 8), height: ceil(rect.maxY + 8))
        webView.frame.origin.x = -webView.frame.width - 10000
        webView.layoutIfNeeded()
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        configuration.afterScreenUpdates = true
        // 等網頁更新兩個動畫影格,再截取調整尺寸後的畫面。
        webView.callAsyncJavaScript("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return null;", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, self.active?.key == request.key else { return }
            guard case .success = result else { self.finish(nil); return }
            webView.takeSnapshot(with: configuration) { [weak self] image, error in
                guard let self, self.active?.key == request.key else { return }
                if error == nil, let image, image.size.width > 0, image.size.height > 0 {
                    self.finish(Markdown.MathRender(image: image, descent: CGFloat(descent)))
                } else {
                    self.finish(nil)
                }
            }
        }
    }

    private func finish(_ result: Markdown.MathRender?) {
        guard let request = active else { return }
        if let result {
            cache.setObject(result, forKey: request.key as NSString)
        } else {
            failed.insert(request.key)
        }
        active = nil
        version += 1
        startNext()
    }

    private func failAll() {
        unavailable = true
        ready = false
        timeout?.cancel()
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
        let requests = queue + (active.map { [$0] } ?? [])
        queue.removeAll()
        active = nil
        for request in requests where failed.insert(request.key).inserted {
            version += 1
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failAll() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failAll() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failAll() }

    private static let page = #"""
    <!doctype html>
    <html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script>
    const post = message => window.webkit.messageHandlers.math.postMessage(message);
    let cssReady = false;
    function checkReady() {
      if (cssReady && window.katex && document.readyState !== "loading") post({type: "ready"});
    }
    document.addEventListener("DOMContentLoaded", checkReady);
    async function renderMath({latex, display, color, size}) {
      try {
        const el = document.getElementById("math");
        const line = document.getElementById("line");
        line.style.color = color;
        line.style.fontSize = size + "px";
        katex.render(latex, el, {displayMode: display, throwOnError: true, output: "html"});
        el.getBoundingClientRect();
        await document.fonts.ready;
        const rect = el.querySelector(".katex").getBoundingClientRect();
        const baseline = document.getElementById("baseline").getBoundingClientRect().top;
        const x = Math.floor(rect.left), y = Math.floor(rect.top);
        const bottom = Math.ceil(rect.bottom);
        return {ok: true, x, y, width: Math.ceil(rect.right) - x, height: bottom - y, descent: bottom - baseline};
      } catch (_) { return {ok: false}; }
    }
    </script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" onload="cssReady = true; checkReady()" onerror="post({type: 'failed'})">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js" onload="checkReady()" onerror="post({type: 'failed'})"></script>
    <style>
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: transparent; }
    #line { position: absolute; left: 8px; top: 8px; white-space: nowrap; }
    .katex-display { display: inline; margin: 0; }
    .katex, .katex-display > .katex { display: inline-block; text-align: left; }
    #baseline { display: inline-block; width: 0; height: 0; vertical-align: baseline; }
    </style>
    </head><body><span id="line"><span id="math"></span><span id="baseline"></span></span></body></html>
    """#
}
