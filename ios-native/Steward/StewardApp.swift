import SwiftUI

@main
struct StewardApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @State private var push = PushState.shared
    @Environment(\.scenePhase) private var scenePhase

    #if DEBUG
    init() {
        if SettingsFixture.enabled {
            SettingsFixture.install()
            let fixtureModel = AppModel()
            fixtureModel.setServer(SettingsFixture.base)
            _model = State(initialValue: fixtureModel)
        }
    }
    #endif

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent) // 跟網頁一樣的藍
                .task {
                    if UserDefaults.standard.bool(forKey: "demo") { model.enterDemo() }
                    await model.connect()
                }
                .onOpenURL { model.open($0) }
                // 連上管家後:要推播權限、把 token 交給管家
                .onChange(of: model.phase) { _, now in
                    // 啟動參數 -noPush(模擬器截圖用)時不問推播權限
                    if now == .ready, !model.isDemo, !UserDefaults.standard.bool(forKey: "noPush") {
                        Task {
                            guard !model.isDemo else { return }
                            await push.requestAndRegister()
                            guard !model.isDemo else { return }
                            await push.sendToken(api: model.api)
                        }
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .stewardPushToken)) { _ in
                    guard !model.isDemo, model.phase == .ready else { return }
                    Task { await push.sendToken(api: model.api) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .stewardDemoWrite).receive(on: RunLoop.main)) { _ in
                    if model.isDemo { model.lastError = DemoData.writeNotice }
                }
                // 點了通知:跳到那個專案
                .onChange(of: push.pendingLink) { _, link in
                    if let link {
                        if !model.isDemo { model.open(link) }
                        push.pendingLink = nil
                    }
                }
                .onChange(of: scenePhase) { _, now in
                    // 回到前景:更新一次、接回即時事件、跟上別的裝置換過的專案;到背景就先斷開(iOS 本來就會停掉)
                    if now == .active, case .ready = model.phase { model.startEvents(); Task { await model.refresh(); await model.syncCurrentFromServer() } }
                    if now == .background { model.stopEvents(); model.code.flushDrafts() }
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
            AppShell()
        }
    }
}
