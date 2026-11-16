import SwiftUI

struct RoutingSettingsView: View {
    @Environment(SettingsStore.self) private var store

    private static let roles: [(id: String, title: String, detail: String)] = [
        ("chat", "聊天室問答", "浮動球裡的問答"),
        ("suggest", "建議問題", "聊天室上方的三個建議問題"),
        ("digest", "整理 agent 回報", "agent 做完一段工作後整理專案進度(量最大)"),
        ("judge", "提案檢查", "決定要不要開工作卡給 agent(唯一能開卡的)"),
        ("commitmsg", "產生提交訊息", "程式碼頁 Git 的「產生提交訊息」")
    ]

    var body: some View {
        SettingsForm("路由") {
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if store.models == nil {
                ProgressView("讀取模型清單中…")
            } else {
                Section {
                    Text("每項工作選一個主要模型;可以再選一個備用。主要的失敗時:背景工作(整理回報、提案檢查、建議問題、提交訊息)自動改用備用;聊天室會讓你按「改用備用模型回答這一題」。剛新增的接口要先儲存才會出現在選單裡。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(Self.roles, id: \.id) { role in
                    Section {
                        modelPicker("主要", path: "routing.\(role.id).primary", noCLI: role.id == "digest" || role.id == "judge")
                        modelPicker("備用", path: "routing.\(role.id).fallback", noCLI: role.id == "digest" || role.id == "judge")
                    } header: {
                        Text(role.title)
                    } footer: {
                        Text(role.detail)
                    }
                }
                Section {
                    modelPicker("模型", path: "routing.privacy", onlyLocal: true, noCLI: true)
                } header: {
                    Text("隱私專案")
                } footer: {
                    Text("隱私專案的所有工作都只用這個模型,不會用備用、也不會送到雲端。只能選本地模型。")
                }
                Section {
                    modelPicker("模型", path: "routing.embedding", onlyLocal: true, noCLI: true, embedding: true)
                } header: {
                    Text("記憶搜尋(向量)")
                } footer: {
                    Text("從已整理掉的舊對話找相關內容,自動附在這次的問題裡。只支援本地或自架(OpenAI 相容)接口,例如 Ollama 的 bge-m3;不設定就只用關鍵字搜尋。")
                }
            }
        }
        .task { await store.loadModels() }
    }

    private func modelPicker(_ title: String, path: String, onlyLocal: Bool = false, noCLI: Bool = false, embedding: Bool = false) -> some View {
        let providers = store.models?.providers ?? []
        let selected = store.settings.string(path)
        let known = providers.contains { provider in
            (provider.models ?? []).contains { "\(provider.id)/\($0)" == selected }
        }
        return Picker(title, selection: store.stringBinding(path)) {
            Text("(不設定)").tag("")
            if !selected.isEmpty && !known {
                Text("\(selected)(找不到這個模型)").tag(selected)
            }
            ForEach(providers) { provider in
                Section {
                    ForEach(provider.models ?? [], id: \.self) { model in
                        let cli = provider.type == "agent-cli" || !(provider.cli ?? "").isEmpty
                        let disabled = (onlyLocal && provider.local != true) || (noCLI && cli)
                            || (embedding && provider.type == "builtin")
                        let suffix = disabled ? (cli ? "(CLI,這項不能用)" : "(雲端,不能用)") : ""
                        Text(model + suffix)
                            .tag("\(provider.id)/\(model)")
                            .disabled(disabled)
                    }
                } header: {
                    Text((provider.name ?? provider.id) + (provider.local == true ? "(本地)" : ""))
                }
            }
        }
        .accessibilityIdentifier(path)
    }
}
