import SwiftUI
import UIKit

struct GeneralSettingsView: View {
    @Environment(SettingsStore.self) private var store

    var body: some View {
        SettingsForm(String(localized: "一般", bundle: AppLanguage.bundle)) {
            Section {
                SettingsTextField(
                    String(localized: "管家怎麼稱呼你", bundle: AppLanguage.bundle),
                    path: "user.name",
                    placeholder: String(localized: "例如:小明(空白就叫「使用者」)", bundle: AppLanguage.bundle)
                )
                Picker(
                    "語言",
                    selection: store.stringBinding("ui.lang", default: "zh-TW")
                ) {
                    Text("繁體中文").tag("zh-TW")
                    Text("English").tag("en")
                }
                .accessibilityIdentifier("ui.lang")
                Text("網頁介面、安裝與更新程式、App 選單的語言。換了之後頁面會重新載入。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if store.response?.desktop == true {
                desktopSection
            }

            Section {
                SettingsTextField(
                    String(localized: "「建立專案」瀏覽資料夾的起點", bundle: AppLanguage.bundle),
                    path: "paths.createRoot",
                    placeholder: String(localized: "~ 代表家目錄,例如 ~/Projects", bundle: AppLanguage.bundle)
                )
            }

            Section("隱私路徑") {
                Text("這些資料夾底下的專案只會用「隱私專案」指定的模型(通常是本地模型),內容不會送到雲端。一行一個,可以用 ~ 開頭。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                SettingsTextField(
                    String(localized: "隱私路徑", bundle: AppLanguage.bundle),
                    path: "paths.privacy",
                    multiline: true
                )
                Toggle(
                    store.response?.detected?.piPrivacy == true
                        ? String(localized: "同時沿用 pi 的隱私清單", bundle: AppLanguage.bundle)
                        : String(localized: "同時沿用 pi 的隱私清單(這台電腦沒有 pi 的清單)", bundle: AppLanguage.bundle),
                    isOn: store.boolBinding("paths.usePiPrivacy")
                )
                .disabled(store.response?.detected?.piPrivacy != true)
                .accessibilityIdentifier("paths.usePiPrivacy")
            }

            Section("程式碼頁面") {
                Text("開著程式碼頁面時，定期在背景抓取遠端（只抓不合併，不會動到檔案），遠端有新的 commit 就在 Git 標出 ↓ 數字，提醒你拉取。抓取時不會跳出登入視窗；登入失敗會自動停止，手動按「抓取」成功後恢復。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Picker(
                    "自動抓取遠端",
                    selection: store.stringBinding("code.autoFetch", default: "ask")
                ) {
                    Text("先問我").tag("ask")
                    Text("開啟").tag("on")
                    Text("關閉").tag("off")
                }
                .accessibilityIdentifier("code.autoFetch")
                Stepper(
                    value: Binding(
                        get: {
                            store.settings.integer("code.autoFetchMinutes", default: 3)
                        },
                        set: { value in
                            Task {
                                await store.set(
                                    "code.autoFetchMinutes",
                                    .number(Double(value))
                                )
                            }
                        }
                    ),
                    in: 1...60
                ) {
                    LabeledContent(
                        "每隔幾分鐘",
                        value: String(
                            store.settings.integer("code.autoFetchMinutes", default: 3)
                        )
                    )
                }
                .accessibilityIdentifier("code.autoFetchMinutes")
            }
        }
    }

    private var desktopSection: some View {
        Section("App") {
            Toggle(
                "在終端機也能用 herdr 指令",
                isOn: store.boolBinding("desktop.herdrCli")
            )
            .accessibilityIdentifier("desktop.herdrCli")
            Text("（會在 ~/.local/bin 放一個指向 App 內 herdr 的連結；你自己裝的 herdr 不會被覆蓋）")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Toggle(
                "herdr 快捷鍵與外掛",
                isOn: store.boolBinding("desktop.herdrConfig")
            )
            .accessibilityIdentifier("desktop.herdrConfig")
            Text("（會在 herdr 的 config.toml 加上資料夾導覽快捷鍵 prefix+e，並先備份）")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Toggle(
                "登入時自動啟動專案管家",
                isOn: store.boolBinding("desktop.autostart")
            )
            .accessibilityIdentifier("desktop.autostart")
            Toggle(
                "自動檢查 App 更新",
                isOn: store.boolBinding("desktop.autoUpdate")
            )
            .accessibilityIdentifier("desktop.autoUpdate")
            Toggle(
                "顯示系統通知",
                isOn: store.boolBinding("desktop.notify")
            )
            .accessibilityIdentifier("desktop.notify")
            Text("（提案、卡住、工作完成等事件會跳出系統通知）")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}
