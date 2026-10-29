// 推播通知:跟 iOS 要權限、拿到 device token 交給管家(管家用它直接送 APNs)、點通知跳到那個專案
import SwiftUI
import UIKit
import UserNotifications

@MainActor
@Observable
final class PushState {
    static let shared = PushState()
    var authorized: Bool? = nil // nil = 還沒問過
    var token: String?
    var registeredWith: String? // 已經交給哪個管家(網址)
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

    /// 把 token 交給管家;換了管家網址或 token 變了才重送
    func sendToken(api: API?) async {
        guard let api, let token else { return }
        let key = "\(api.base.absoluteString)|\(token)"
        guard registeredWith != key else { return }
        do {
            try await api.registerPush(token: token, env: environment, name: UIDevice.current.name)
            registeredWith = key
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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
        Task { @MainActor in PushState.shared.lastError = "iPhone 沒有給推播憑證:\(error.localizedDescription)" }
    }

    // app 開著的時候也顯示通知
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    // 點通知 → 打開那個專案
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let s = response.notification.request.content.userInfo["link"] as? String, let url = URL(string: s) {
            await MainActor.run { PushState.shared.pendingLink = url }
        }
    }
}

extension Notification.Name {
    static let stewardPushToken = Notification.Name("stewardPushToken")
}
