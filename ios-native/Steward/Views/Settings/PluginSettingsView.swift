import SwiftUI

struct PluginSettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var loading = false

    var body: some View {
        SettingsForm("外掛") {
            Section {
                Text("外掛需要的軟體會下載到 ~/.agent-steward/tools,不需要管理員權限。關閉只是把功能藏起來,下載的東西會保留;「移除下載的檔案」只刪專案管家自己下載的,不會動你自己裝的軟體。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                if loading { ProgressView("讀取中…") }
                ForEach(store.plugins) { plugin in
                    NavigationLink {
                        PluginSettingsDetailView(pluginID: plugin.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(plugin.name ?? plugin.id)
                            Text(plugin.statusTitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            if let size = plugin.size, !size.isEmpty {
                                Text(size).font(.caption).foregroundStyle(.secondary)
                            }
                            if plugin.job?.running == true {
                                ProgressView("安裝中…")
                            }
                        }
                    }
                }
            }
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .accessibilityIdentifier("settings-plugins-list")
        .task {
            loading = true
            defer { loading = false }
            await store.loadPlugins()
        }
    }
}

private struct PluginSettingsDetailView: View {
    @Environment(SettingsStore.self) private var store
    let pluginID: String
    @State private var busy = false
    @State private var confirmRemove = false

    private var plugin: SettingsPlugin? { store.plugins.first { $0.id == pluginID } }

    var body: some View {
        Form {
            if let plugin {
                Section {
                    LabeledContent("狀態", value: plugin.statusTitle)
                    if let size = plugin.size, !size.isEmpty { Text(size).foregroundStyle(.secondary) }
                    if let description = plugin.description { Text(description) }
                    if let detail = plugin.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                    Toggle(plugin.enableTitle, isOn: Binding(
                        get: { self.plugin?.enabled == true },
                        set: { value in Task { await setEnabled(value) } }
                    ))
                    .disabled(busy || plugin.job?.running == true)
                    if busy { ProgressView("設定中…") }
                }
                if let job = plugin.job {
                    Section {
                        if job.running == true {
                            if let progress = job.progress, progress.isFinite {
                                ProgressView("安裝中…", value: min(100, max(0, progress)), total: 100)
                            } else {
                                ProgressView("安裝中…")
                            }
                        }
                        if let message = job.message { Text(message) }
                        if let error = job.error, !error.isEmpty { Text(error).foregroundStyle(.red) }
                        if let log = job.log, !log.isEmpty {
                            DisclosureGroup("安裝紀錄") {
                                ScrollView(.horizontal) {
                                    Text(log.joined(separator: "\n"))
                                        .font(.system(.footnote, design: .monospaced))
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
                if plugin.removable == true {
                    Section {
                        Button("移除下載的檔案", role: .destructive) { confirmRemove = true }
                            .disabled(busy || plugin.job?.running == true)
                    }
                }
            }
            if let message = store.message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle(plugin?.name ?? pluginID)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("移除下載的檔案", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("移除", role: .destructive) { Task { await remove() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("刪掉專案管家為這個外掛下載的軟體?之後要用再開啟就會重新下載。你自己裝的軟體不受影響。")
        }
    }

    private func setEnabled(_ value: Bool) async {
        guard !busy, plugin?.job?.running != true else { return }
        busy = true
        defer { busy = false }
        store.error = nil
        if let result = await store.action("api/settings/plugins/\(pluginID)", body: ["enable": .bool(value)]), result.started == true {
            store.message = "開始下載安裝,可以先做別的事"
        }
    }

    private func remove() async {
        guard !busy, plugin?.removable == true, plugin?.job?.running != true else { return }
        busy = true
        defer { busy = false }
        store.error = nil
        if await store.action("api/settings/plugins/\(pluginID)/remove") != nil {
            store.message = "已移除"
        }
    }
}

private extension SettingsPlugin {
    var statusTitle: String {
        switch status {
        case "ready": return "可以用"
        case "system": return "沿用電腦上的"
        case "installed": return "已安裝"
        case "missing": return "還沒安裝"
        case "installing": return "安裝中"
        default: return status ?? ""
        }
    }

    var enableTitle: String {
        if job?.running == true { return "安裝中…" }
        if enabled == true { return "已開啟" }
        return status == "missing" ? "開啟並安裝" : "開啟"
    }
}
