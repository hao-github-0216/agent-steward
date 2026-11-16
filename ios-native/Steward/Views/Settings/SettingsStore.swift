import SwiftUI
import Observation

@MainActor
@Observable
final class SettingsStore {
    var settings = SettingsValues()
    var response: SettingsResponse?
    var auth: AuthStatus?
    var models: SettingsModels?
    var agents: [SettingsAgent] = []
    var plugins: [SettingsPlugin] = []
    var update: SettingsUpdate?
    var pushStatus: SettingsPushStatus?
    var updateLog = ""
    var loading = false
    var saving = false
    var error: String?
    var message: String?
    private(set) var api: API?
    @ObservationIgnored private var writeTail: Task<Bool, Never>?
    @ObservationIgnored private var pluginTask: Task<Void, Never>?
    @ObservationIgnored private var updateTask: Task<Void, Never>?

    var providers: [SettingsProvider] {
        guard let value = settings["providers"], let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([SettingsProvider].self, from: data)) ?? []
    }

    func load(api: API?) async {
        self.api = api
        await reload()
    }

    func reload() async {
        guard let api else { error = "請先連線到管家"; return }
        _ = await writeTail?.value
        loading = true
        defer { loading = false }
        do {
            let value = try await api.getSettings()
            guard let settings = value.settings else { throw APIError.server(200, "看不懂管家的回應(管家可能要更新)") }
            self.settings = settings
            response = value
            auth = try await api.authStatus()
        } catch { self.error = error.localizedDescription }
    }

    /// 寫入依序送出；失敗時保留上一次已儲存的值。
    @discardableResult
    func set(_ path: String, _ value: SettingsValue) async -> Bool {
        var patch = SettingsValues()
        patch[path] = value
        return await save(patch)
    }

    @discardableResult
    func save(_ patch: SettingsValues) async -> Bool {
        let previous = writeTail
        let task = Task { [self] in
            _ = await previous?.value
            guard let api else { error = "請先連線到管家"; return false }
            let clean = SettingsValue.object(patch.fields).withoutSecrets.object ?? [:]
            guard !clean.isEmpty else { return true }
            if patch.fields.allSatisfy({ settings.fields[$0.0] == $0.1 }) { return true }
            let before = settings
            for (name, value) in patch.fields { settings.fields[name] = merged(settings.fields[name], value) }
            saving = true
            defer { saving = false }
            do {
                let value = try await api.putSettings(SettingsValues(clean))
                guard let updated = value.settings else { throw APIError.server(200, "看不懂管家的回應(管家可能要更新)") }
                settings = updated
                response?.settings = updated
                message = value.restartNeeded == true ? "已儲存。埠號或位址要重新啟動管家才會生效" : "設定已儲存"
                return true
            } catch {
                settings = before
                self.error = error.localizedDescription
                return false
            }
        }
        writeTail = task
        return await task.value
    }

    private func merged(_ old: SettingsValue?, _ new: SettingsValue) -> SettingsValue {
        guard let incoming = new.object else { return new }
        var object = old?.object ?? [:]
        for (name, value) in incoming { object[name] = merged(object[name], value) }
        return .object(object)
    }

    func boolBinding(_ path: String, default fallback: Bool = false) -> Binding<Bool> {
        Binding(get: { self.settings.bool(path, default: fallback) }, set: { value in Task { await self.set(path, .bool(value)) } })
    }
    func stringBinding(_ path: String, default fallback: String = "") -> Binding<String> {
        Binding(get: { self.settings.string(path, default: fallback) }, set: { value in Task { await self.set(path, .string(value)) } })
    }

    @discardableResult
    func saveProviders(_ providers: [SettingsProvider]) async -> Bool {
        do { return await set("providers", try SettingsValue.encoded(providers)) }
        catch { self.error = error.localizedDescription; return false }
    }

    @discardableResult
    func setProvider(_ id: String, field: String, value: SettingsValue) async -> Bool {
        guard var providers = settings["providers"]?.array,
              let index = providers.firstIndex(where: { $0.object?["id"]?.string == id }),
              var object = providers[index].object else { return false }
        object[field] = value
        providers[index] = .object(object)
        return await set("providers", .array(providers))
    }

    @discardableResult
    func action(_ path: String, method: String = "POST", body: [String: SettingsValue] = [:]) async -> SettingsAction? {
        guard let api else { error = "請先連線到管家"; return nil }
        do {
            let result = try await api.settingsAction(path, method: method, body: body)
            if let why = result.error { throw APIError.server(200, why) }
            if result.ok == false { throw APIError.server(200, "設定失敗") }
            if let settings = result.settings { self.settings = settings; response?.settings = settings }
            if let plugins = result.plugins { self.plugins = plugins; monitorPlugins() }
            return result
        } catch { self.error = error.localizedDescription; return nil }
    }

    func loadModels() async {
        do { models = try await api?.getSettingsModels() }
        catch { self.error = error.localizedDescription }
    }
    func loadAgents() async {
        do { agents = try await api?.getSettingsAgents() ?? [] }
        catch { self.error = error.localizedDescription }
    }
    func loadPlugins() async {
        do { plugins = try await api?.getSettingsPlugins() ?? []; monitorPlugins() }
        catch { self.error = error.localizedDescription }
    }
    func loadUpdate(force: Bool = false) async {
        do { update = try await api?.getSettingsUpdate(force: force); if update?.running == true { monitorUpdate() } }
        catch { self.error = error.localizedDescription }
    }
    func loadPushStatus() async {
        do { pushStatus = try await api?.getSettingsPushStatus() }
        catch { self.error = error.localizedDescription }
    }
    func loadAuth() async {
        do { auth = try await api?.authStatus() }
        catch { self.error = error.localizedDescription }
    }

    func monitorPlugins() {
        guard pluginTask == nil, plugins.contains(where: { $0.job?.running == true }) else { return }
        pluginTask = Task { [self] in
            defer { pluginTask = nil }
            while plugins.contains(where: { $0.job?.running == true }) {
                do {
                    try await Task.sleep(for: .milliseconds(1500))
                    plugins = try await api?.getSettingsPlugins() ?? []
                } catch { self.error = error.localizedDescription; return }
            }
        }
    }

    func monitorUpdate() {
        guard updateTask == nil else { return }
        update?.running = true
        updateTask = Task { [self] in
            defer { updateTask = nil }
            for _ in 0..<900 {
                do {
                    try await Task.sleep(for: .seconds(2))
                    let result = try await api?.settingsAction("api/settings/update/log", method: "GET")
                    updateLog = result?.log ?? updateLog
                    let last = updateLog.components(separatedBy: "=====").last ?? ""
                    if last.contains("已經裝好") || last.contains("is installed.") {
                        message = "更新完成,重新整理頁面就是新版"
                        update = try await api?.getSettingsUpdate()
                        return
                    }
                    if last.contains("錯誤:") || last.contains("錯誤：") || last.contains("Error: ") {
                        update?.running = false
                        error = last
                        return
                    }
                } catch { self.message = "正在更新…(完成後管家會自動重啟,這頁重新整理即可)" }
            }
            update?.running = false
            error = "更新仍未完成，請重新整理查看進度。"
        }
    }
}

struct SettingsForm<Content: View>: View {
    @Environment(SettingsStore.self) private var store
    let title: String
    @ViewBuilder var content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) { self.title = title; self.content = content }
    var body: some View {
        Form {
            if store.loading { ProgressView("讀取中…") }
            if store.response != nil { content() }
            if let message = store.message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            if store.saving { ProgressView("儲存中…") }
        }
        .disabled(store.saving)
        #if DEBUG
        .safeAreaInset(edge: .bottom) { if SettingsFixture.enabled { SettingsFixtureProbe() } }
        #endif
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("重新整理", systemImage: "arrow.clockwise") {
                    Task {
                        await store.reload()
                        switch title {
                        case "AI 接口", "路由": await store.loadModels()
                        case "Agent": await store.loadAgents()
                        case "推播": await store.loadPushStatus()
                        case "外掛": await store.loadPlugins()
                        case "關於": await store.loadUpdate()
                        default: break
                        }
                    }
                }
            }
        }
    }
}

struct SettingsTextField: View {
    @Environment(SettingsStore.self) private var store
    let title: String
    let path: String
    var placeholder = ""
    var multiline = false
    var number = false
    @State private var draft = ""
    @State private var original = ""
    @FocusState private var focused: Bool

    init(_ title: String, path: String, placeholder: String = "", multiline: Bool = false, number: Bool = false) {
        self.title = title; self.path = path; self.placeholder = placeholder; self.multiline = multiline; self.number = number
    }

    var body: some View {
        VStack(alignment: .leading) {
            Text(title).font(.subheadline)
            TextField(placeholder.isEmpty ? title : placeholder, text: $draft, axis: multiline ? .vertical : .horizontal)
                .lineLimit(multiline ? 3...8 : 1...1)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(number ? .numbersAndPunctuation : .default)
                .submitLabel(.done)
                .focused($focused)
                .accessibilityIdentifier(path)
                .onSubmit { focused = false; commit() }
        }
        .onAppear(perform: reset)
        .onChange(of: focused) { old, new in if old && !new { commit() } }
        .onChange(of: store.settings) { _, _ in if !focused && draft == original { reset() } }
        .onDisappear { commit() }
        .toolbar {
            if focused { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { focused = false; commit() } } }
        }
    }

    private func reset() {
        draft = multiline ? store.settings.strings(path).joined(separator: "\n") : number ? String(store.settings.integer(path)) : store.settings.string(path)
        original = draft
    }
    private func commit() {
        guard draft != original else { return }
        let value: SettingsValue
        if multiline { value = .array(draft.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.map(SettingsValue.string)) }
        else if number {
            guard let number = Double(draft), number.isFinite else { draft = original; store.error = "請輸入有效的數字"; return }
            value = .number(number)
        } else { value = .string(draft) }
        let submitted = draft
        original = submitted
        Task {
            if !(await store.set(path, value)) { reset() }
            else if draft == submitted { reset() }
        }
    }
}

struct SettingsSecretField: View {
    @Environment(SettingsStore.self) private var store
    let title: String
    let path: String
    @State private var editing = false
    init(_ title: String, path: String) { self.title = title; self.path = path }
    var body: some View {
        LabeledContent(title, value: store.settings.string(path).isEmpty ? "還沒設定" : "已設定")
        Button(store.settings.string(path).isEmpty ? "輸入\(title)" : "修改\(title)") { editing = true }
            .sheet(isPresented: $editing) { SettingsSecretEditor(title: title, path: path) }
    }
}

private struct SettingsSecretEditor: View {
    @Environment(SettingsStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let title: String
    let path: String
    @State private var draft = ""
    @State private var saving = false
    @State private var finished = false
    @State private var cancelled = false
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                SecureField(title, text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($focused)
                    .accessibilityIdentifier(path)
                    .onSubmit { Task { await commit() } }
                    .onChange(of: focused) { old, new in
                        if old && !new && !draft.isEmpty { Task { await commit() } }
                    }
                Text("空白不覆蓋原值。")
                    .font(.footnote).foregroundStyle(.secondary)
                if saving { ProgressView("儲存中…") }
                if let error = store.error { Text(error).foregroundStyle(.red) }
            }
            .disabled(saving)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { cancelled = true; dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { Task { await commit() } }.disabled(saving)
                }
            }
            .onDisappear { if !cancelled && !finished && !draft.isEmpty { Task { await commit() } } }
        }
    }
    private func commit() async {
        guard !saving, !finished, !cancelled else { return }
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.hasPrefix("••••") else { finished = true; dismiss(); return }
        saving = true
        defer { saving = false }
        if await store.set(path, .string(value)) { finished = true; draft = ""; dismiss() }
    }
}

func settingsWebURL(_ raw: String?) -> URL? {
    guard let raw, let url = URL(string: raw), url.host != nil,
          ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { return nil }
    return url
}
