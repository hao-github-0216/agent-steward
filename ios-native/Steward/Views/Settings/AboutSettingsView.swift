import SwiftUI

struct AboutSettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var loading = false
    @State private var checkingDesktop = false

    private var plan: AboutPlan {
        AboutPlan.make(update: store.update, responseDesktop: store.response?.desktop, platform: store.response?.platform)
    }
    private var busy: Bool { loading || checkingDesktop }

    var body: some View {
        SettingsForm(String(localized: "關於", bundle: AppLanguage.bundle)) {
            Section {
                LabeledContent("目前版本") {
                    Text(store.update?.current ?? "")
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-current-version")
                }
                updateStatus
                if case .modified(let count, let installer) = plan.integrity {
                    Group {
                        if let count {
                            Text("程式檔案和官方 \(store.update?.current ?? "") 版不同(共 \(count) 個檔案)。如果不是你自己改的，請重新下載安裝。")
                        } else {
                            Text("程式檔案和官方 \(store.update?.current ?? "") 版不同。如果不是你自己改的，請重新下載安裝。")
                        }
                    }
                    .font(.footnote)
                    if let installer {
                        Link("下載 \(store.update?.current ?? "") 安裝檔", destination: installer)
                            .accessibilityIdentifier("settings-integrity-installer")
                    }
                }
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
                switch plan.update {
                case .desktopCheck:
                    Button {
                        Task { await requestDesktopUpdate() }
                    } label: {
                        HStack {
                            Text(store.update?.hasUpdate == true ? String(localized: "更新 App 到 \(store.update?.latest ?? "")", bundle: AppLanguage.bundle) : String(localized: "用 App 檢查更新", bundle: AppLanguage.bundle))
                            if checkingDesktop { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy)
                case .downloadApp(let url):
                    Text("這個安裝方式不能在 App 裡更新。請在電腦上下載並安裝桌面 App。")
                        .font(.footnote).foregroundStyle(.secondary)
                    Link("下載桌面 App", destination: url)
                        .accessibilityIdentifier("settings-download-app")
                case .downloadUnavailable:
                    Text("這個安裝方式不能在 App 裡更新，管家也沒有提供可用的下載連結。請在電腦上打開專案管家網頁的「設定 → 關於」查看。")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings-update-guide")
                case .legacyGuide:
                    Text("這台電腦上的管家版本較舊，App 不會替它更新。請在電腦上打開專案管家網頁的「設定 → 關於」查看更新方式。")
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings-update-guide")
                case .none:
                    EmptyView()
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
                switch plan.uninstall {
                case .desktop:
                    Text("在 Mac 把 App 拖到垃圾桶；Windows 到『設定 → 應用程式』移除")
                        .accessibilityIdentifier("settings-uninstall-guide")
                case .devScript:
                    Text("如果這是用 scripts/deploy.sh 部署的開發版，在這台電腦的終端機執行(資料會保留;加 --purge 連資料一起刪除):")
                        .accessibilityIdentifier("settings-uninstall-guide")
                    Text(verbatim: "sh ~/.agent-steward/app/scripts/dev/uninstall.sh")
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-uninstall-command")
                case .unknown:
                    Text("App 無法確認這台電腦的安裝方式，所以不提供移除指令。請在電腦上打開專案管家網頁的「設定 → 關於」，照那裡的說明移除。")
                        .accessibilityIdentifier("settings-uninstall-guide")
                }
            }
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .task { await loadUpdate(force: false) }
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
}
