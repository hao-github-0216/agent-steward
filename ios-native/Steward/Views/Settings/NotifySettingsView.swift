import SwiftUI
import UIKit

struct NotifySettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var testing = false

    var body: some View {
        SettingsForm("推播") {
            Section {
                Text("工作卡提案、卡住、每日提醒時推播給你。")
                    .font(.footnote).foregroundStyle(.secondary)
                Picker("推播", selection: store.stringBinding("notify.kind", default: "none")) {
                    Text("不推播").tag("none")
                    Text("Telegram 機器人").tag("telegram")
                    Text("通用 webhook").tag("webhook")
                    Text("Hermes").tag("hermes")
                }
                .accessibilityIdentifier("notify.kind")
            }

            switch store.settings.string("notify.kind", default: "none") {
            case "telegram":
                Section("Telegram 機器人") {
                    Text("在 Telegram 找 @BotFather 建一個機器人拿到 token;先傳一句話給你的機器人,再打開 https://api.telegram.org/bot<token>/getUpdates 找到 chat 的 id。")
                        .font(.footnote).foregroundStyle(.secondary)
                    SettingsSecretField("Bot token", path: "notify.telegram.botToken")
                    SettingsTextField("Chat ID", path: "notify.telegram.chatId")
                }
            case "webhook":
                Section("通用 webhook") {
                    Text("會用 POST 送出 JSON:{\"text\": …, \"content\": …, \"message\": …}。Slack、Discord、ntfy 之類的服務都能接。")
                        .font(.footnote).foregroundStyle(.secondary)
                    SettingsTextField("Webhook 網址", path: "notify.webhook.url", placeholder: "https://...")
                }
            case "hermes":
                Section("Hermes") {
                    Text(store.response?.detected?.hermes == true
                         ? "已找到 Hermes 的推播路由。"
                         : "還沒找到 Hermes 的推播路由(~/.hermes/webhook_subscriptions.json)。")
                        .font(.footnote).foregroundStyle(.secondary)
                    SettingsTextField("Webhook 網址", path: "notify.hermes.url", placeholder: "例如 http://127.0.0.1:8644/p/<profile>/webhooks/steward")
                    SettingsTextField("路由名稱", path: "notify.hermes.route")
                }
            default:
                EmptyView()
            }

            Section {
                Button("儲存並發一則測試推播") {
                    testNotification("api/settings/test-notify")
                }
                .accessibilityIdentifier("notify.test")
                .disabled(testing)
                if testing { ProgressView("儲存並測試中…") }
            }

            if let status = store.pushStatus {
                phonePushSection(status)
            }
        }
        .task { await store.loadPushStatus() }
    }

    private func phonePushSection(_ status: SettingsPushStatus) -> some View {
        Section {
            Text(phonePushDescription(status))
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("notify.phonePushStatus")
            let oldDevices = (status.devices ?? []).filter { $0.encrypted == false }.count
            if oldDevices > 0 {
                Text("\(oldDevices) 台裝置的 App 太舊，更新 App 後才收得到加密通知。")
                    .font(.footnote).foregroundStyle(.orange)
                    .accessibilityIdentifier("notify.phonePushEncryptionWarning")
            }
            if status.mode == "direct" || status.mode == "relay" {
                Button("送測試推播到手機") {
                    testNotification("api/push/test")
                }
                .accessibilityIdentifier("notify.testPhonePush")
                .disabled(testing)
            }
        }
    }

    private func phonePushDescription(_ status: SettingsPushStatus) -> String {
        let count = status.devices?.count ?? 0
        switch status.mode {
        case "direct":
            return "手機 App 推播：用這台管家的 APNs 金鑰直接送出，\(count) 台裝置。"
        case "relay":
            return "手機 App 推播：經推播中繼送出，內容端對端加密，\(count) 台裝置。"
        default:
            return "手機 App 推播：還沒設定推播中繼。"
        }
    }

    private func testNotification(_ path: String) {
        guard !testing else { return }
        testing = true
        store.error = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { @MainActor in
            defer { testing = false }
            // 失焦先讓共用欄位排入寫入，再用空 patch 等候 writeTail；不另送 PUT。
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.async { continuation.resume() }
            }
            guard await store.save(SettingsValues()), store.error == nil else { return }
            if await store.action(path) != nil {
                store.message = "已送出測試推播"
            }
        }
    }
}
