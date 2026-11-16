import SwiftUI

struct AgentSettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var detecting = false

    private var available: [SettingsAgent] {
        store.agents.filter { $0.installed == true && $0.dispatch == true }
    }

    private var selectedAgent: String {
        let saved = store.settings.string("cards.defaultAgent")
        let normalized = saved.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return available.first {
            $0.id.lowercased() == normalized || $0.name?.lowercased() == normalized
        }?.id ?? saved
    }

    private var defaultAgentBinding: Binding<String> {
        let binding = store.stringBinding("cards.defaultAgent")
        return Binding(get: { selectedAgent }, set: { binding.wrappedValue = $0 })
    }

    var body: some View {
        SettingsForm("Agent") {
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Text("這台電腦上偵測到的 AI agent。「接上專案管家」會修改它的設定檔(先備份成 *.bak-steward-日期),之後開工就能讀到專案進度、問管家、回報;「拿掉」只移除專案管家加的部分。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section {
                Picker("交給", selection: defaultAgentBinding) {
                    Text("讓管家決定").tag("")
                    if !selectedAgent.isEmpty && !available.contains(where: { $0.id == selectedAgent }) {
                        Text("\(store.settings.string("cards.defaultAgent"))(沒有安裝)")
                            .tag(selectedAgent)
                            .disabled(true)
                    }
                    ForEach(available) { agent in
                        Text(agent.name ?? agent.id).tag(agent.id)
                    }
                }
                .accessibilityIdentifier("cards.defaultAgent")
                .disabled(detecting)
            } header: {
                Text("自動提案預設交給")
            } footer: {
                Text("管家自動提案、開工作卡時交給誰;選『讓管家決定』時只會從這台電腦裝好的 agent 裡挑。每張卡在核准前都還能改。")
            }
            Section {
                if detecting {
                    ProgressView("偵測中…")
                } else {
                    let installed = store.agents.filter { $0.installed == true }
                    if installed.isEmpty {
                        Text("沒有偵測到支援的 agent").foregroundStyle(.secondary)
                    }
                    ForEach(installed) { agent in
                        NavigationLink {
                            AgentSettingsDetailView(agentID: agent.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(agent.name ?? agent.id)
                                AgentSettingsCapabilities(agent: agent)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section {
                let other = store.agents.filter { $0.installed != true }
                DisclosureGroup("其他支援的 agent(這台電腦沒有裝,\(other.count) 個)") {
                    ForEach(other) { agent in
                        NavigationLink(agent.name ?? agent.id) {
                            AgentSettingsDetailView(agentID: agent.id)
                        }
                    }
                }
                Button("重新偵測") { Task { await detectAgents() } }
                    .disabled(detecting)
            }
        }
        .task { await detectAgents() }
    }

    private func detectAgents() async {
        detecting = true
        defer { detecting = false }
        await store.loadAgents()
    }
}

private struct AgentSettingsCapabilities: View {
    let agent: SettingsAgent
    static let parts: [(id: String, title: String)] = [
        ("brief", "開工簡報"), ("mcp", "MCP 工具"), ("instructions", "工作說明")
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Self.parts, id: \.id) { part in
                if agent.can?[part.id] == true {
                    Text(part.title + (agent.on?[part.id] == true ? " ✓" : ""))
                        .accessibilityValue(agent.on?[part.id] == true ? "已接上" : "還沒接上")
                }
            }
            if agent.records == true { Text("自動記錄") }
            if agent.dispatch == true { Text("可派工") }
        }
    }
}

private struct AgentSettingsDetailView: View {
    @Environment(SettingsStore.self) private var store
    let agentID: String
    @State private var changing = false

    private var agent: SettingsAgent? { store.agents.first { $0.id == agentID } }

    var body: some View {
        Form {
            if let agent {
                Section {
                    ForEach(AgentSettingsCapabilities.parts, id: \.id) { part in
                        LabeledContent(part.title, value: agent.can?[part.id] == true
                            ? (agent.on?[part.id] == true ? "已接上" : "還沒接上") : "—")
                    }
                    LabeledContent("自動記錄", value: agent.records == true ? "✓" : "—")
                        .accessibilityHint("管家會自動讀它的對話記錄")
                    LabeledContent("可派工", value: agent.dispatch == true ? "✓" : "—")
                        .accessibilityHint("看板可以把工作卡派給它(要有 herdr)")
                } footer: {
                    if agent.records == true { Text("管家會自動讀它的對話記錄") }
                    if agent.dispatch == true { Text("看板可以把工作卡派給它(要有 herdr)") }
                }
                Section {
                    Text(agent.installed == true ? (agent.path ?? "—") : "這台電腦沒有裝")
                        .font(.footnote)
                        .textSelection(.enabled)
                    if let manual = agent.manual, !manual.isEmpty, agent.installed == true {
                        DisclosureGroup("手動接上 MCP") {
                            Text(manual)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }
                if agent.can?.values.contains(true) == true {
                    Section {
                        Button(changing ? "設定中…" : agent.integrated == true ? "拿掉" : "接上專案管家") {
                            Task { await setIntegration(agent) }
                        }
                        .disabled(changing || store.saving)
                    }
                }
            } else {
                Text("沒有偵測到支援的 agent").foregroundStyle(.secondary)
            }
            if let error = store.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if let message = store.message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(agent?.name ?? agentID)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func setIntegration(_ agent: SettingsAgent) async {
        guard !changing else { return }
        changing = true
        defer { changing = false }
        store.error = nil
        store.message = nil
        let result = await store.action("api/settings/agents/\(agent.id)", body: ["enable": .bool(agent.integrated != true)])
        if let result {
            let count = result.changed?.count ?? 0
            store.message = count > 0 ? "已更新 \(count) 個設定" : "沒有需要改的"
        }
        await store.loadAgents()
    }
}
