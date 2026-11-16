import SwiftUI

struct AboutSettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var loading = false
    @State private var applying = false
    @State private var checkingDesktop = false
    @State private var confirmUpdate = false
    @State private var pendingUpdate: SettingsUpdate?

    private var desktop: Bool { store.update?.desktop ?? store.response?.desktop ?? false }
    private var windows: Bool { store.response?.platform == "win32" }
    private var busy: Bool { loading || applying || checkingDesktop || store.update?.running == true }

    var body: some View {
        SettingsForm(String(localized: "關於", bundle: AppLanguage.bundle)) {
            Section {
                LabeledContent("目前版本") {
                    Text(store.update?.current ?? "")
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-current-version")
                }
                updateStatus
                if let update = store.update, update.hasUpdate == true,
                   let notes = update.notes, !notes.isEmpty {
                    Text(notes).font(.footnote).textSelection(.enabled)
                }
                Button {
                    Task { await loadUpdate(force: true) }
                } label: {
                    HStack {
                        Text("檢查更新")
                        if loading { Spacer(); ProgressView() }
                    }
                }
                .disabled(busy)
                if desktop {
                    Button {
                        Task { await requestDesktopUpdate() }
                    } label: {
                        HStack {
                            Text(store.update?.hasUpdate == true ? String(localized: "更新 App 到 \(store.update?.latest ?? "")", bundle: AppLanguage.bundle) : String(localized: "用 App 檢查更新", bundle: AppLanguage.bundle))
                            if checkingDesktop { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy)
                } else if store.update?.hasUpdate == true {
                    Button {
                        pendingUpdate = store.update
                        confirmUpdate = true
                    } label: {
                        HStack {
                            Text("更新到 \(store.update?.latest ?? "")")
                            if applying { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || store.update?.latest?.isEmpty != false)
                }
            }
            if store.update?.running == true || !store.updateLog.isEmpty {
                Section("更新紀錄") {
                    if store.update?.running == true { ProgressView("正在更新…") }
                    ScrollView(.horizontal) {
                        Text(store.updateLog)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            Section("第三方元件") {
                Text("安裝程式會從各元件的官方來源下載這些軟體，並驗證 SHA-256。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let components = store.update?.components {
                    ForEach(components) { component in
                        VStack(alignment: .leading, spacing: 4) {
                            Text([component.name, component.version, component.license].compactMap { $0 }.joined(separator: " · "))
                            if let url = settingsWebURL(component.home) {
                                Link("首頁連結", destination: url)
                            } else if let home = component.home {
                                Text(home).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Text(store.update == nil ? String(localized: "讀取中…", bundle: AppLanguage.bundle) : String(localized: "無法載入第三方元件", bundle: AppLanguage.bundle))
                        .foregroundStyle(.secondary)
                }
            }
            Section("移除專案管家") {
                if desktop {
                    Text("在 Mac 把 App 拖到垃圾桶；Windows 到『設定 → 應用程式』移除")
                } else {
                    Text("在這台電腦的終端機執行(資料會保留;加 \(windows ? "-Purge" : "--purge") 連資料一起刪除):")
                    Text(windows ? "powershell -ExecutionPolicy Bypass -File $HOME\\.agent-steward\\app\\uninstall.ps1" : "sh ~/.agent-steward/app/uninstall.sh")
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .task { await loadUpdate(force: false) }
        .confirmationDialog("更新專案管家", isPresented: $confirmUpdate, titleVisibility: .visible, presenting: pendingUpdate) { update in
            Button("更新") { Task { await applyUpdate(update) } }
            Button("取消", role: .cancel) {}
        } message: { update in
            Text("從 \(update.current ?? "") 更新到 \(update.latest ?? "")。\n會從 GitHub 下載 \(update.latest ?? "") 的安裝程式和專案管家程式(含相依套件),再依新版的設定更新 herdr、herdr 外掛和你已經接上的 agent。\n更新時背景服務會重新啟動,開著的網頁終端機會斷線一次。")
        }
    }

    @ViewBuilder
    private var updateStatus: some View {
        if loading || store.update == nil {
            Text("檢查中…").foregroundStyle(.secondary)
        } else if let update = store.update {
            if update.running == true {
                Text("正在更新…(完成後管家會自動重啟,這頁重新整理即可)")
                    .foregroundStyle(.secondary)
            } else if update.hasUpdate == true {
                Text("有新版本 \(update.latest ?? "")").bold()
                if let url = settingsWebURL(update.url) { Link("更新內容", destination: url) }
            } else if let error = update.error {
                Text(error).foregroundStyle(.red)
            } else if update.dev == true {
                Text("這是開發版,不會自動更新\(update.latest.map { String(localized: "(最新發布版 \($0))", bundle: AppLanguage.bundle) } ?? "")")
                    .foregroundStyle(.secondary)
            } else {
                Text("已經是最新版").foregroundStyle(.secondary)
            }
        }
    }

    private func loadUpdate(force: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        store.error = nil
        await store.loadUpdate(force: force)
    }

    private func requestDesktopUpdate() async {
        guard !busy else { return }
        checkingDesktop = true
        defer { checkingDesktop = false }
        store.error = nil
        if await store.action("api/desktop/update") != nil {
            store.message = String(localized: "已請 App 檢查更新，請看 App 跳出的視窗", bundle: AppLanguage.bundle)
        }
    }

    private func applyUpdate(_ update: SettingsUpdate) async {
        guard !busy, !desktop, let tag = update.latest, !tag.isEmpty else { return }
        applying = true
        defer { applying = false }
        store.error = nil
        if await store.action("api/settings/update", body: ["tag": .string(tag)]) != nil {
            store.monitorUpdate()
        }
    }
}
