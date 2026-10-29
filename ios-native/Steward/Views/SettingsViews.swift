// 設定(標題列的 ⚙):跟網頁的設定同樣幾頁(打開就是網頁那一頁),加上這支 iPhone 自己的設定(管家網址、iPhone 推播)
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false

    /// 網頁的 SET_TABS
    private static let webTabs: [(String, String, String)] = [
        ("general", "一般", "gearshape"), ("ai", "AI 接口", "cpu"), ("routing", "路由", "arrow.triangle.branch"),
        ("agents", "Agent", "person.2"), ("access", "存取", "lock.shield"), ("notify", "推播", "bell"),
        ("plugins", "外掛", "puzzlepiece.extension"), ("about", "關於", "info.circle"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section("管家設定") {
                    ForEach(Self.webTabs, id: \.0) { t in
                        NavigationLink {
                            WebPage(sheet: .settings(t.0, t.1))
                        } label: {
                            Label(t.1, systemImage: t.2)
                        }
                    }
                }
                Section {
                    LabeledContent("管家網址", value: model.server?.absoluteString ?? "—")
                    Button("更換管家網址", role: .destructive) { confirmForget = true }
                } header: {
                    Text("這支 iPhone")
                }
                PushSettingsSection()
                Section {
                    NavigationLink { WebPage(sheet: .full) } label: { Label("完整網頁版", systemImage: "safari") }
                } footer: {
                    Text("跟電腦上打開的網頁一模一樣(看板拖拉、建立專案、整理 spaces 都在)。")
                }
                Section {
                    LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .confirmationDialog("要更換管家網址嗎?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("更換", role: .destructive) { dismiss(); model.forgetServer() }
            }
        }
    }
}

struct PushSettingsSection: View {
    @Environment(AppModel.self) private var model
    @State private var push = PushState.shared
    @State private var serverReady: Bool?
    @State private var testing = false
    @State private var result: String?

    var body: some View {
        Section {
            LabeledContent("iPhone 權限") {
                switch push.authorized {
                case .some(true): Text("已允許").foregroundStyle(.green)
                case .some(false): Text("已關閉").foregroundStyle(.red)
                case .none: Text("還沒問過")
                }
            }
            LabeledContent("管家推播金鑰") {
                switch serverReady {
                case .some(true): Text("已設定").foregroundStyle(.green)
                case .some(false): Text("還沒設定").foregroundStyle(.orange)
                case .none: ProgressView()
                }
            }
            if push.authorized == false {
                Button("到 iPhone 設定打開通知") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }
            } else if push.authorized == nil {
                Button("允許推播通知") { Task { await push.requestAndRegister() } }
            }
            Button {
                Task { await test() }
            } label: {
                if testing { ProgressView() } else { Text("傳一則測試通知") }
            }
            .disabled(push.token == nil || serverReady != true || testing)
        } header: {
            Text("推播通知")
        } footer: {
            Text(result ?? push.lastError ?? "有新提案、工作卡卡住、派出去的工作完成或在等你回應時通知你;點通知會打開那個專案。")
        }
        .task {
            await push.refreshAuthorization()
            serverReady = (try? await model.api?.pushStatus())?.configured ?? false
        }
    }

    private func test() async {
        guard let api = model.api, let token = push.token else { return }
        testing = true
        defer { testing = false }
        await push.sendToken(api: api)
        do {
            try await api.testPush(token: token)
            result = "已送出,幾秒內會收到。"
        } catch {
            result = error.localizedDescription
        }
    }
}
