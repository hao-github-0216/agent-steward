import SwiftUI
import WebKit

struct HTMLPreviewView: UIViewRepresentable {
    @Environment(AppModel.self) private var model
    let project: String
    let path: String
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let c = context.coordinator
        c.files.api = model.api
        c.files.project = project
        c.files.useView = true
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.setURLSchemeHandler(c.files, forURLScheme: MarkdownWebView.scheme)
        let v = WKWebView(frame: .zero, configuration: config)
        // 網頁沒設背景色時跟瀏覽器一樣是白底(深色模式也是,否則黑字會疊在深色底上)
        v.backgroundColor = .white
        v.scrollView.backgroundColor = .white
        v.navigationDelegate = c
        v.accessibilityIdentifier = "html-preview"
        c.load(v, path: path, reloadToken: reloadToken)
        return v
    }

    func updateUIView(_ v: WKWebView, context: Context) {
        let c = context.coordinator
        c.files.api = model.api
        c.files.project = project
        if c.path != path || c.reloadToken != reloadToken {
            c.load(v, path: path, reloadToken: reloadToken)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        let files = ProjectFileSchemeHandler()
        var path = ""
        var reloadToken = -1

        func load(_ v: WKWebView, path: String, reloadToken: Int) {
            self.path = path
            self.reloadToken = reloadToken
            var url = URLComponents()
            url.scheme = MarkdownWebView.scheme
            url.host = "p"
            url.path = "/\(path)"
            guard let url = url.url else { return }
            v.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            switch url.scheme?.lowercased() {
            case MarkdownWebView.scheme:
                decisionHandler(url.host == "p" ? .allow : .cancel)
            case "http", "https":
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            default:
                decisionHandler(.cancel)
            }
        }
    }
}
