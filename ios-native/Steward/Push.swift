// 跟 iOS 要推播權限、把裝置憑證和加密金鑰交給管家、點通知跳到專案
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class PushState {
    static let shared = PushState()
    var authorized: Bool? = nil // nil = 還沒問過
    var token: String?
    var registeredWith: String? // 已登記的管家網址、裝置憑證和金鑰
    var lastError: String?
    /// 使用者點了通知:AppModel 看到就打開這個連結
    var pendingLink: URL?

    /// Xcode / devicectl 直接裝的開發版(簽名檔裡 aps-environment = development)走 sandbox;TestFlight、App Store 走 production
    var environment: String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return "production" }
        return text.contains("<key>aps-environment</key>") && text.range(of: #"<key>aps-environment</key>\s*<string>development</string>"#, options: .regularExpression) != nil ? "sandbox" : "production"
        #endif
    }

    func refreshAuthorization() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        switch s.authorizationStatus {
        case .notDetermined: authorized = nil
        case .denied: authorized = false
        default: authorized = true
        }
    }

    /// 第一次連上管家後問一次權限;已經允許就直接登記
    func requestAndRegister() async {
        await refreshAuthorization()
        if authorized == nil {
            let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            authorized = ok
        }
        if authorized == true { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// 把裝置憑證和金鑰交給管家；網址、憑證或金鑰變了才重送
    func sendToken(api: API?) async {
        guard let api, let token else { return }
        do {
            let key = try PushCrypto.loadOrCreateKey().base64EncodedString()
            let registration = "\(api.base.absoluteString)|\(token)|\(key)"
            guard registeredWith != registration else { return }
            try await api.registerPush(token: token, env: environment, name: UIDevice.current.name, platform: "ios", key: key)
            registeredWith = registration
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: PushAction.approve.rawValue, title: PushAction.approve.title, options: [.authenticationRequired])
        let reject = UNNotificationAction(identifier: PushAction.reject.rawValue, title: PushAction.reject.title, options: [.authenticationRequired, .destructive])
        let redispatch = UNNotificationAction(identifier: PushAction.redispatch.rawValue, title: PushAction.redispatch.title, options: [.authenticationRequired])
        let done = UNNotificationAction(identifier: PushAction.done.rawValue, title: PushAction.done.title, options: [.authenticationRequired])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "proposal", actions: [approve, reject], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "blocked", actions: [redispatch, done], intentIdentifiers: [], options: [])
        ])
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            PushState.shared.token = hex
            NotificationCenter.default.post(name: .stewardPushToken, object: nil)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushState.shared.lastError = String(localized: "iPhone 沒有給推播憑證:\(error.localizedDescription)", bundle: AppLanguage.bundle) }
    }

    // app 開著的時候也顯示通知
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    // 點通知開專案；按鈕只在背景移動工作卡，不打開畫面。
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        guard !UserDefaults.standard.bool(forKey: "isDemo") else {
            completionHandler()
            return
        }
        let userInfo = response.notification.request.content.userInfo
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            Task { @MainActor in
                if let s = userInfo["link"] as? String, let url = URL(string: s) {
                    PushState.shared.pendingLink = url
                }
                completionHandler()
            }
            return
        }
        guard let action = PushAction(rawValue: response.actionIdentifier),
              let column = PushAction.column(for: response.actionIdentifier),
              let card = userInfo["card"] as? String, !card.isEmpty else {
            completionHandler()
            return
        }
        let link = userInfo["link"] as? String
        Task { @MainActor in
            PushActionRequest(action: action, link: link, completion: completionHandler).start(card: card, column: column)
        }
    }
}

/// 到期與網路回覆都回到主執行緒，只能結束一次。
@MainActor
private final class PushActionRequest {
    private let action: PushAction
    private let link: String?
    private var completion: (() -> Void)?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var task: Task<Void, Never>?

    init(action: PushAction, link: String?, completion: @escaping () -> Void) {
        self.action = action
        self.link = link
        self.completion = completion
    }

    func start(card: String, column: String) {
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PushAction") {
            Task { @MainActor in
                self.task?.cancel()
                self.finish(reason: String(localized: "背景執行時間已到，請打開專案確認工作卡狀態", bundle: AppLanguage.bundle))
            }
        }
        guard backgroundTask != .invalid else {
            finish(reason: String(localized: "無法取得背景執行時間，請打開專案再試一次", bundle: AppLanguage.bundle))
            return
        }
        task = Task { @MainActor in
            do {
                guard let base = UserDefaults.standard.string(forKey: "serverURL").flatMap(API.normalize) else {
                    throw APIError.badURL
                }
                _ = try await API(base: base).moveCard(card, to: column)
                finish()
            } catch {
                finish(reason: error.localizedDescription)
            }
        }
    }

    private func finish(reason: String? = nil) {
        guard let completion else { return }
        self.completion = nil
        task = nil
        if let reason {
            let content = UNMutableNotificationContent()
            content.title = String(localized: "沒辦法\(action.title):\(reason)", bundle: AppLanguage.bundle)
            content.sound = .default
            if let link { content.userInfo["link"] = link }
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        completion()
    }
}

extension Notification.Name {
    static let stewardPushToken = Notification.Name("stewardPushToken")
}
