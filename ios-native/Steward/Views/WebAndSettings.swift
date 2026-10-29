// 終端機、程式碼、Office 這些重的工具沿用管家網頁,放在原生 app 的一個分頁裡;再加上設定頁
import SwiftUI
import WebKit

struct WebPanelView: View {
    @Environment(AppModel.self) private var model
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            Group {
                // ?app=1:管家網頁的 app 模式,藏掉網頁自己的專案切換和看板/程式碼/終端機按鈕,只留終端機和工具列
                if let base = model.server, let url = URL(string: "?app=1#terminal", relativeTo: base)?.absoluteURL {
                    WebView(url: url, reloadToken: reloadToken)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView("還沒設定管家網址", systemImage: "link")
                }
            }
            .navigationTitle("終端機")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button { reloadToken += 1 } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("重新載入")
            }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int

    final class Coordinator { var token = 0 }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.allowsBackForwardNavigationGestures = true
        web.isInspectable = true
        web.load(URLRequest(url: url))
        context.coordinator.token = reloadToken
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.token != reloadToken {
            context.coordinator.token = reloadToken
            web.load(URLRequest(url: url))
        }
    }
}

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmForget = false

    var body: some View {
        NavigationStack {
            Form {
                Section("管家") {
                    LabeledContent("網址", value: model.server?.absoluteString ?? "—")
                    LabeledContent("專案", value: "\(model.projects.count) 個")
                    Button("更換管家網址", role: .destructive) { confirmForget = true }
                }
                Section {
                    LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                } footer: {
                    Text("原生版試用中:專案和問管家是原生畫面,終端機、程式碼、檔案預覽在「終端機」分頁用網頁版。")
                }
            }
            .navigationTitle("設定")
            .confirmationDialog("要更換管家網址嗎?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("更換", role: .destructive) { model.forgetServer() }
            }
        }
    }
}
