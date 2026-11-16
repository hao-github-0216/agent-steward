import SwiftUI

struct AccessSettingsView: View {
    @Environment(SettingsStore.self) private var store
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var repeated = ""
    @State private var changingPassword = false
    @State private var changingTailscale = false
    @State private var confirmLogout = false
    @FocusState private var passwordFocus: Int?

    private var hasPassword: Bool { store.auth?.hasPassword == true }
    private var tailscaleEnabled: Bool { store.settings.bool("access.tailscale.enabled") }

    var body: some View {
        SettingsForm(String(localized: "存取", bundle: AppLanguage.bundle)) {
            Section {
                LabeledContent("管理密碼", value: hasPassword ? String(localized: "已設定", bundle: AppLanguage.bundle) : String(localized: "還沒設定", bundle: AppLanguage.bundle))
                    .accessibilityIdentifier("settings-password-status")
                if hasPassword {
                    SecureField("目前的密碼", text: $current)
                        .textContentType(.password)
                        .focused($passwordFocus, equals: 0)
                }
                SecureField("新密碼(至少 8 個字)", text: $next)
                    .textContentType(.newPassword)
                    .focused($passwordFocus, equals: 1)
                SecureField("再輸入一次", text: $repeated)
                    .textContentType(.newPassword)
                    .focused($passwordFocus, equals: 2)
                    .submitLabel(.done)
                    .onSubmit { passwordFocus = nil; Task { await setPassword() } }
                Button(hasPassword ? String(localized: "修改密碼", bundle: AppLanguage.bundle) : String(localized: "設定密碼", bundle: AppLanguage.bundle)) { passwordFocus = nil; Task { await setPassword() } }
                    .disabled(changingPassword || next.isEmpty)
                if changingPassword { ProgressView("設定中…") }
                if store.auth?.how == "password" {
                    Button("登出這個瀏覽器", role: .destructive) { confirmLogout = true }
                }
            } header: { Text("管理密碼") } footer: {
                Text((hasPassword ? String(localized: "已設定。", bundle: AppLanguage.bundle) : String(localized: "還沒設定:目前只有這台電腦本身能使用專案管家。", bundle: AppLanguage.bundle)) + String(localized: "從別的裝置、瀏覽器登入時要輸入這組密碼(Tailscale 本人的裝置免密碼)。", bundle: AppLanguage.bundle))
            }
            Section {
                Toggle("開啟 Tailscale 遠端存取", isOn: Binding(get: { tailscaleEnabled }, set: { value in
                    Task {
                        changingTailscale = true
                        defer { changingTailscale = false }
                        if let result = await store.action("api/settings/tailscale", body: ["enable": .bool(value)]) {
                            store.message = value ? String(localized: "已開啟:\(result.url ?? "")", bundle: AppLanguage.bundle) : String(localized: "已關閉 Tailscale 遠端存取", bundle: AppLanguage.bundle)
                        }
                    }
                }))
                .disabled(store.response?.detected?.tailscale != true || changingTailscale)
                .accessibilityIdentifier("access.tailscale.enabled")
                if changingTailscale { ProgressView("設定中…") }
                if tailscaleEnabled, let url = settingsWebURL(store.settings.string("server.publicUrl")) {
                    Link(url.absoluteString, destination: url).textSelection(.enabled)
                }
                SettingsTextField(String(localized: "免密碼的 Tailscale 帳號(一行一個)", bundle: AppLanguage.bundle), path: "access.tailscaleUsers", multiline: true)
            } header: { Text("Tailscale 遠端存取") } footer: {
                Text(store.response?.detected?.tailscale == true
                     ? String(localized: "從任何地方經 Tailscale 連進來,有 https 網址(手機複製貼上才能用)。下面這些帳號的個人裝置(手機、筆電)免密碼;其他人要用管理密碼登入。", bundle: AppLanguage.bundle)
                     : String(localized: "這台電腦沒有偵測到 Tailscale。裝好並登入 Tailscale 後,這裡就能開啟。", bundle: AppLanguage.bundle))
            }
            Section {
                Toggle(hasPassword ? String(localized: "開啟區網存取", bundle: AppLanguage.bundle) : String(localized: "開啟區網存取(先設定管理密碼)", bundle: AppLanguage.bundle), isOn: store.boolBinding("access.lan.enabled"))
                    .disabled(!hasPassword)
                    .accessibilityIdentifier("access.lan.enabled")
            } header: { Text("區網存取") } footer: {
                Text(lanDescription)
            }
            Section {
                DisclosureGroup(String(localized: "進階", bundle: AppLanguage.bundle)) {
                    SettingsTextField(String(localized: "對外網址(推播訊息裡的連結;從 http 打開時會轉到這個 https 網址)", bundle: AppLanguage.bundle), path: "server.publicUrl", placeholder: String(localized: "空白 = http://127.0.0.1:\(store.settings.integer("server.port"))/", bundle: AppLanguage.bundle))
                    SettingsTextField(String(localized: "埠號", bundle: AppLanguage.bundle), path: "server.port", number: true)
                    SettingsTextField(String(localized: "網頁終端機埠號", bundle: AppLanguage.bundle), path: "server.terminalPort", number: true)
                    SettingsTextField(String(localized: "聽哪些位址(一行一個;127.0.0.1 一定會有)", bundle: AppLanguage.bundle), path: "server.hosts", multiline: true)
                    Text("埠號和位址改了要重新啟動管家才會生效。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .task { await store.loadAuth() }
        .confirmationDialog("登出這個瀏覽器", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("登出", role: .destructive) {
                Task {
                    if await store.action("api/auth/logout") != nil {
                        model.stopEvents()
                        model.phase = .needPassword(String(localized: "請先登入", bundle: AppLanguage.bundle))
                        dismiss()
                    }
                }
            }
        }
    }

    private var lanDescription: String {
        let ips = store.response?.detected?.lanIps ?? []
        let urls = ips.map { "http://\($0):\(store.response?.detected?.port ?? 0)/" }.joined(separator: "、")
        return String(localized: "同一個 Wi-Fi 的裝置可以打開專案管家,要用管理密碼登入", bundle: AppLanguage.bundle) + (urls.isEmpty ? "" : String(localized: ",網址:\(urls)", bundle: AppLanguage.bundle)) + String(localized: "。改了要重新啟動管家才生效。", bundle: AppLanguage.bundle)
    }

    private func setPassword() async {
        guard !changingPassword else { return }
        guard next == repeated else { store.error = String(localized: "兩次輸入的新密碼不一樣", bundle: AppLanguage.bundle); return }
        guard next.count >= 8 else { store.error = String(localized: "新密碼至少要 8 個字", bundle: AppLanguage.bundle); return }
        changingPassword = true
        defer { changingPassword = false }
        if await store.action("api/auth/password", body: ["current": .string(current), "next": .string(next)]) != nil {
            current = ""; next = ""; repeated = ""
            store.message = String(localized: "管理密碼已設定", bundle: AppLanguage.bundle)
            await store.loadAuth()
        }
    }
}
