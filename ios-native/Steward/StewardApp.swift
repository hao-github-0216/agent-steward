import SwiftUI

@main
struct StewardApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.orange)
                .task { await model.connect() }
                .onOpenURL { model.open($0) }
                .onChange(of: scenePhase) { _, now in
                    // 回到前景就更新一次(管家那邊可能已經有新進度)
                    if now == .active, case .ready = model.phase { Task { await model.refresh() } }
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
            WebPanelView()
                .tabItem { Label("終端機", systemImage: "terminal") }
                .tag(1)
            SettingsView()
                .tabItem { Label("設定", systemImage: "gearshape") }
                .tag(2)
        }
    }
}
