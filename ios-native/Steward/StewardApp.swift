import SwiftUI

@main
struct StewardApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var push = PushState.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.orange)
                .task { await model.connect() }
                .onOpenURL { model.open($0) }
                // 連上管家後:要推播權限、把 token 交給管家
                .onChange(of: model.phase) { _, now in
                    if now == .ready { Task { await push.requestAndRegister(); await push.sendToken(api: model.api) } }
                }
                .onReceive(NotificationCenter.default.publisher(for: .stewardPushToken)) { _ in
                    Task { await push.sendToken(api: model.api) }
                }
                // 點了通知:跳到那個專案
                .onChange(of: push.pendingLink) { _, link in
                    if let link { model.open(link); push.pendingLink = nil }
                }
                .onChange(of: scenePhase) { _, now in
                    // 回到前景就更新一次(管家那邊可能已經有新進度)
                    // 回到前景:更新一次並接回即時事件;到背景就先斷開(iOS 本來就會停掉)
                    if now == .active, case .ready = model.phase { model.startEvents(); Task { await model.refresh() } }
                    if now == .background { model.stopEvents() }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.phase {
        case .setup:
            SetupView()
        case .checking:
            VStack(spacing: 14) {
                CatLogo().frame(width: 72, height: 72)
                ProgressView("連線到管家…")
            }
        case .needPassword(let why):
            LoginView(reason: why)
        case .offline(let why):
            OfflineView(reason: why)
        case .ready:
            MainTabs()
        }
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            ProjectListView()
                .tabItem { Label("專案", systemImage: "square.stack.3d.up") }
                .tag(0)
            CardsView()
                .tabItem { Label("工作卡", systemImage: "checklist") }
                .badge(model.cards.filter { $0.column == "proposed" || $0.column == "blocked" }.count)
                .tag(3)
            WebPanelView()
                .tabItem { Label("終端機", systemImage: "terminal") }
                .tag(1)
            SettingsView()
                .tabItem { Label("設定", systemImage: "gearshape") }
                .tag(2)
        }
    }
}
