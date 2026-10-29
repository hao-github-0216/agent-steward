// 程式碼、終端機沿用管家網頁(?app=1:網頁只負責程式碼/終端機本身;標題列、專案欄、浮動球、側欄由 app 的原生畫面照同樣排版負責)。
// 跟網頁一樣:程式碼和終端機是同一頁,切模式叫網頁的 setMode;換專案叫 selectProject。
// 網頁和 app 之間用 window.webkit.messageHandlers.steward 傳訊息(見 web/index.html 的 toApp)。
import SwiftUI
import WebKit

@MainActor
final class WebStore {
    weak var model: AppModel?
    private var main: WKWebView?
    /// 網頁載好了沒(網頁送 ready 才算);還沒好之前叫的換模式、換專案,等 ready 時再對一次
    private var ready = false
    private lazy var bridge = WebBridge { [weak self] msg in
        if msg["type"] as? String == "ready" { self?.didBecomeReady(mode: msg["mode"] as? String, project: msg["project"] as? String) }
        self?.model?.handleWeb(msg)
    }

    init(model: AppModel) { self.model = model }

    /// 程式碼/終端機共用的網頁(第一次切到程式碼或終端機時才載入)
    func view() -> WKWebView {
        if let main { return main }
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(bridge, name: "steward")
        let v = WKWebView(frame: .zero, configuration: config)
        v.isInspectable = true
        v.scrollView.contentInsetAdjustmentBehavior = .never
        main = v
        load()
        return v
    }

    private var url: URL? {
        guard let model, let base = model.server else { return nil }
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "app", value: "1")] + (model.currentProjectId.map { [URLQueryItem(name: "project", value: $0)] } ?? [])
        c?.fragment = "terminal"
        return c?.url
    }

    func load() {
        if let main, let u = url { ready = false; main.load(URLRequest(url: u)) }
    }

    private func js(_ s: String) { if ready { main?.evaluateJavaScript(s) } }

    /// 網頁載好了:模式或專案跟 app 現在的不一樣就再叫一次。
    /// 順序:要去終端機就先換專案再切終端機(herdr 跳到新專案);其他模式先切模式再換專案(換專案不會讓 herdr 跳)
    private func didBecomeReady(mode: String?, project: String?) {
        ready = true
        guard let model else { return }
        let fixProject = { if let id = model.currentProjectId, id != project { self.select(id) } }
        let fixMode = { if mode != Self.webMode(model.mode) { self.setMode(model.mode) } }
        if model.mode == .terminal { fixProject(); fixMode() } else { fixMode(); fixProject() }
    }

    /// 切模式:看板時網頁也切回看板(藏著),在看板換專案才不會讓 herdr 跳過去;切到終端機時 herdr 跟著目前專案(跟網頁一樣)
    func setMode(_ mode: Mode) { js("window.setMode && setMode('\(Self.webMode(mode))')") }

    /// 共用網頁只負責終端機;看板、程式碼是原生畫面,這時網頁切回看板(藏著,換專案不會讓 herdr 跳)
    static func webMode(_ mode: Mode) -> String { mode == .terminal ? "term" : "board" }

    func select(_ projectId: String) { js("window.selectProject && selectProject(\(Self.jsString(projectId)), 'app')") }

    /// 圈選:程式碼帶行號和前後文、終端機分得出是哪個 agent 窗格,用網頁自己的圈選
    func snap() { js("window.snapStart && window.snapStart()") }

    func createSpace() { js("window.enterTerminal && enterTerminal({ create: true })") }

    /// 開支線(here = 同資料夾開,不建 worktree)
    func openBranch(here: Bool) { js("window.openBranchHere && openBranchHere(\(here))") }

    /// 帶回主線:打開網頁的帶回主線視窗
    func handoff() { js("document.getElementById('handoffBtn')?.click()") }

    /// 程式碼頁目前的檔案(問管家的「目前檔案」用)和它還沒存的內容
    func currentFile() async -> (path: String, unsaved: String?)? {
        guard let main else { return nil }
        let r = try? await main.evaluateJavaScript("(() => { const p = window.codeMode?.lastFile?.(); return p ? [p, window.codeMode.fileText(p)] : null })()")
        guard let arr = r as? [Any], let path = arr.first as? String else { return nil }
        return (path, arr.count > 1 ? arr[1] as? String : nil)
    }

    func reset() {
        main?.removeFromSuperview()
        main = nil
    }

    static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
}

/// WKUserContentController 會強引用 handler:用一個小物件轉手,避免循環引用
final class WebBridge: NSObject, WKScriptMessageHandler {
    let onMessage: @MainActor ([String: Any]) -> Void
    init(_ onMessage: @escaping @MainActor ([String: Any]) -> Void) { self.onMessage = onMessage }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as? [String: Any] ?? [:]
        MainActor.assumeIsolated { onMessage(body) }
    }
}

/// 把共用的 WKWebView 放進 SwiftUI。程式碼和終端機兩個分頁共用同一個網頁(跟網頁一樣同一頁切模式),
/// 分頁出現時 token 會變,updateUIView 就把網頁搬到這個分頁(不搬的話另一頁會空白)
struct WebContainer: UIViewRepresentable {
    @Environment(AppModel.self) private var model
    let token: Int

    func makeUIView(context: Context) -> UIView {
        let host = UIView()
        host.backgroundColor = .clear
        attach(to: host)
        return host
    }

    func updateUIView(_ host: UIView, context: Context) {
        if model.web.view().superview !== host { attach(to: host) }
    }

    private func attach(to host: UIView) {
        let web = model.web.view()
        web.removeFromSuperview()
        web.frame = host.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(web)
    }
}

/// 一次性的網頁畫面(從下面升起):建立專案、整理 spaces、拆出子資料夾
struct WebSheetView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sheet: WebSheet

    var body: some View {
        NavigationStack {
            WebPage(sheet: sheet)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                }
        }
        .onDisappear { Task { await model.refresh() } }
    }
}

/// 一次性的網頁:設定的某一頁、建立專案、整理 spaces、拆出子資料夾、完整網頁版。
/// 網頁裡的設定/對話框關掉時自動回去
struct WebPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sheet: WebSheet

    private var title: String {
        switch sheet {
        case .settings(_, let t): t
        case .create: "建立專案"
        case .tidy: "整理 spaces"
        case .split: "拆出子資料夾"
        case .codeEditor: "網頁版編輯器"
        case .full: "完整網頁版"
        }
    }

    private var url: URL? {
        guard let base = model.server else { return nil }
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)
        switch sheet {
        case .settings(let s, _): c?.queryItems = [.init(name: "app", value: "1"), .init(name: "settings", value: s)]
        case .create: c?.queryItems = [.init(name: "app", value: "1"), .init(name: "open", value: "create")]
        case .tidy: c?.queryItems = [.init(name: "app", value: "1"), .init(name: "open", value: "tidy")]
        // 拆出子資料夾畫在看板的專案說明裡:用完整網頁版(不進 app 模式)
        case .split(let p): c?.queryItems = [.init(name: "project", value: p), .init(name: "open", value: "split")]
        case .codeEditor:
            c?.queryItems = [.init(name: "app", value: "1")] + (model.currentProjectId.map { [.init(name: "project", value: $0)] } ?? [])
            c?.fragment = "code"
        case .full: break
        }
        return c?.url
    }

    /// 完整網頁版、拆出子資料夾不接橋:網頁不進 app 模式,看板、浮動球都照常
    private var bridged: Bool {
        switch sheet {
        case .full, .split: false
        default: true
        }
    }

    var body: some View {
        Group {
            if let url {
                OneShotWebView(url: url, bridge: bridged) { msg in
                    let t = msg["type"] as? String
                    if t == "settingsClosed" || t == "dialogClosed" { dismiss() }
                }
                .ignoresSafeArea(edges: .bottom)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct OneShotWebView: UIViewRepresentable {
    let url: URL
    var bridge = true
    let onMessage: @MainActor ([String: Any]) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        if bridge { config.userContentController.add(WebBridge(onMessage), name: "steward") }
        let v = WKWebView(frame: .zero, configuration: config)
        v.isInspectable = true
        v.allowsBackForwardNavigationGestures = true
        v.load(URLRequest(url: url))
        return v
    }

    func updateUIView(_ v: WKWebView, context: Context) {}

    static func dismantleUIView(_ v: WKWebView, coordinator: ()) {
        v.configuration.userContentController.removeScriptMessageHandler(forName: "steward")
    }
}
