import SwiftUI
import Observation
import UIKit

struct AISettingsView: View {
    @Environment(SettingsStore.self) private var store
    @State private var login = AIProviderLoginController()
    @State private var addedID: String?
    @State private var adding = false

    private var providerIDs: Set<String> { Set(store.providers.map(\.id)) }
    private var loginIDs: [String] {
        (store.models?.loginProviders ?? [:]).keys.sorted().filter { id in
            !store.providers.contains { $0.id == id && $0.auth == "login" }
        }
    }

    var body: some View {
        SettingsForm(String(localized: "AI 接口", bundle: AppLanguage.bundle)) {
            Section {
                Text("管家用到的 AI 都從這裡設定。改了會自動儲存;「測試連線」會先幫你儲存。")
                    .font(.footnote).foregroundStyle(.secondary)
                if store.providers.isEmpty {
                    Text("還沒有任何 AI 接口,從下面新增一個。")
                }
                ForEach(store.providers) { provider in
                    NavigationLink {
                        AIProviderDetailView(providerID: provider.id, login: login)
                    } label: {
                        AIProviderSummary(provider: provider, info: modelInfo(provider.id))
                    }
                }
            }
            Section("用訂閱登入(不需要 API 金鑰)") {
                Text("用你已經有的訂閱(ChatGPT、Claude Pro / Max、GitHub Copilot、SuperGrok / X Premium、Kimi Code、Meta),不另外付 API 費用;OpenRouter 用登入代替貼金鑰。")
                    .font(.footnote).foregroundStyle(.secondary)
                if store.models == nil {
                    Text("讀取中…")
                } else if loginIDs.isEmpty {
                    Text("都已經接上了")
                }
                ForEach(loginIDs, id: \.self) { id in
                    Button("用 \(AIProviderLabels.loginName(id)) 登入") {
                        Task { await login.start(provider: id, store: store) }
                    }
                    .help(store.models?.loginProviders?[id] ?? id)
                    .disabled(login.starting)
                }
                if store.providers.contains(where: {
                    store.models?.loginProviders?[$0.id] != nil && $0.auth != "login"
                }) {
                    Text("已經有同一家的接口時,登入後會改用訂閱(原本的 API 金鑰或 pi 登入不再使用)。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("新增接口") {
                Menu("雲端服務(用 API 金鑰)") {
                    ForEach(AIProviderLabels.builtins.filter { !providerIDs.contains($0.id) }) { option in
                        Button(option.name) {
                            add(SettingsProvider(id: option.id, type: "builtin", name: option.name,
                                                 builtin: option.id, auth: "apiKey", apiKey: ""))
                        }
                    }
                }
                .disabled(AIProviderLabels.builtins.allSatisfy { providerIDs.contains($0.id) })
                Menu("本地或自架(OpenAI 相容)") {
                    ForEach(AIProviderLabels.compatible) { option in
                        Button(option.name) {
                            var id = option.id
                            var suffix = 2
                            while providerIDs.contains(id) { id = "\(option.id)\(suffix)"; suffix += 1 }
                            add(SettingsProvider(id: id, type: "openai-compatible", name: option.savedName,
                                                 apiKey: "", baseUrl: option.url, models: [], local: true))
                        }
                    }
                }
                let cli = (store.models?.cliProviders ?? []).filter { !providerIDs.contains($0.id) }
                if !cli.isEmpty {
                    Menu("電腦上的 agent CLI(用它自己的訂閱)") {
                        ForEach(cli) { provider in
                            Button(provider.name ?? provider.id) { add(provider) }
                        }
                    }
                }
                let pi = (store.models?.piProviders ?? []).filter { !providerIDs.contains($0.id) }
                if !pi.isEmpty {
                    Menu("沿用 pi(這台電腦偵測到的)") {
                        ForEach(pi) { provider in
                            Button(provider.name ?? provider.id) { add(provider) }
                        }
                    }
                }
                if adding { ProgressView("儲存中…") }
            }
            .disabled(adding || store.saving)
        }
        .accessibilityIdentifier("ai-providers")
        .task { await store.loadModels() }
        .navigationDestination(item: $addedID) { id in
            AIProviderDetailView(providerID: id, login: login)
        }
        .sheet(isPresented: Binding(get: { login.presented }, set: { login.presented = $0 })) {
            AIProviderLoginView(controller: login)
        }
    }

    private func modelInfo(_ id: String) -> SettingsModelProvider? {
        store.models?.providers?.first { $0.id == id }
    }

    private func add(_ provider: SettingsProvider) {
        guard !adding, !providerIDs.contains(provider.id) else { return }
        adding = true
        Task {
            defer { adding = false }
            // 寫入前再次確認接口代號沒有重複。
            guard !store.providers.contains(where: { $0.id == provider.id }) else { return }
            if await store.saveProviders(store.providers + [provider]) {
                addedID = provider.id
                await store.loadModels()
            }
        }
    }
}

private enum AIProviderLabels {
    struct Builtin: Identifiable { let id: String; let name: String }
    struct Compatible: Identifiable { let id: String; let name: String; let savedName: String; let url: String }
    static let builtins: [Builtin] = [
        .init(id: "openai", name: "OpenAI"), .init(id: "anthropic", name: "Anthropic(Claude)"),
        .init(id: "google", name: "Google Gemini"), .init(id: "openrouter", name: "OpenRouter"),
        .init(id: "deepseek", name: "DeepSeek"), .init(id: "groq", name: "Groq"),
        .init(id: "mistral", name: "Mistral"), .init(id: "xai", name: "xAI(Grok)"),
        .init(id: "kimi-coding", name: "Kimi Code")
    ]
    static let compatible: [Compatible] = [
        .init(id: "ollama", name: "Ollama", savedName: "Ollama", url: "http://localhost:11434/v1"),
        .init(id: "lmstudio", name: "LM Studio", savedName: "LM Studio", url: "http://localhost:1234/v1"),
        .init(id: "local", name: String(localized: "vLLM / 其他網址", bundle: AppLanguage.bundle), savedName: String(localized: "自架模型", bundle: AppLanguage.bundle), url: "http://")
    ]
    static func loginName(_ id: String) -> String {
        ["openai": "ChatGPT", "anthropic": "Claude", "github-copilot": "GitHub Copilot", "xai": "Grok",
         "kimi-coding": "Kimi Code", "meta": "Meta", "openrouter": "OpenRouter"][id] ?? id
    }
    static func kind(_ provider: SettingsProvider) -> String {
        switch provider.type {
        case "builtin":
            return provider.auth == "pi" ? String(localized: "沿用 pi 的登入", bundle: AppLanguage.bundle) : provider.auth == "login" ? String(localized: "訂閱登入", bundle: AppLanguage.bundle) : String(localized: "API 金鑰", bundle: AppLanguage.bundle)
        case "pi-models": return String(localized: "沿用 pi 的模型設定", bundle: AppLanguage.bundle)
        case "agent-cli": return String(localized: "電腦上的 CLI", bundle: AppLanguage.bundle)
        default: return String(localized: "OpenAI 相容網址", bundle: AppLanguage.bundle)
        }
    }
}

private struct AIProviderSummary: View {
    let provider: SettingsProvider
    let info: SettingsModelProvider?
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text((provider.name?.isEmpty == false ? provider.name : nil) ?? provider.id)
                .font(.headline)
            Text(AIProviderLabels.kind(provider)).font(.subheadline)
            Text(String(localized: "代號 \(provider.id)", bundle: AppLanguage.bundle) + (info?.models.map { String(localized: " · \($0.count) 個模型", bundle: AppLanguage.bundle) } ?? ""))
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct AIProviderDetailView: View {
    @Environment(SettingsStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let providerID: String
    let login: AIProviderLoginController
    @State private var drafts: [String: String] = [:]
    @State private var originals: [String: String] = [:]
    @State private var editingKey = false
    @State private var pendingWrites = 0
    @State private var writeTail: Task<Bool, Never>?
    @State private var testing = false
    @State private var busy = false
    @State private var testResult: SettingsAction?
    @State private var testError: String?
    @State private var deleting = false
    @FocusState private var focused: String?

    private var provider: SettingsProvider? { store.providers.first { $0.id == providerID } }
    private var info: SettingsModelProvider? { store.models?.providers?.first { $0.id == providerID } }

    var body: some View {
        Form {
            if let provider {
                Section {
                    AIProviderSummary(provider: provider, info: info)
                    textField(String(localized: "顯示名稱", bundle: AppLanguage.bundle), field: "name")
                }
                if provider.auth == "login" {
                    Section {
                        Text("\(info?.signedIn == true ? String(localized: "✓ 已登入", bundle: AppLanguage.bundle) : String(localized: "還沒登入", bundle: AppLanguage.bundle)) · 登入資料存在這台電腦的 ~/.agent-steward/auth.json")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button(info?.signedIn == true ? String(localized: "重新登入", bundle: AppLanguage.bundle) : String(localized: "登入", bundle: AppLanguage.bundle)) {
                            perform { await login.start(provider: providerID, store: store) }
                        }
                        .disabled(login.starting)
                        if info?.signedIn == true {
                            Button("登出") {
                                perform {
                                    if await store.action("api/settings/logout-provider", body: ["provider": .string(providerID)]) != nil {
                                        store.message = String(localized: "已登出", bundle: AppLanguage.bundle)
                                        await store.loadModels()
                                    }
                                }
                            }
                        }
                    }
                }
                if provider.type == "builtin" && provider.auth != "pi" && provider.auth != "login" {
                    Section { secretField(String(localized: "API 金鑰", bundle: AppLanguage.bundle), provider: provider) }
                }
                if provider.builtin == "google" && provider.auth != "pi" {
                    Section {
                        Text(.init(String(localized: "沒有金鑰?到 [Google AI Studio](https://aistudio.google.com/apikey) 用 Google 帳號登入就能免費建立(有免費額度)。", bundle: AppLanguage.bundle)))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if provider.type == "openai-compatible" {
                    Section {
                        textField(String(localized: "網址(OpenAI 相容,通常結尾是 /v1)", bundle: AppLanguage.bundle), field: "baseUrl")
                        secretField(String(localized: "API 金鑰(沒有就空白)", bundle: AppLanguage.bundle), provider: provider)
                        localToggle(provider)
                    }
                }
                if provider.type == "agent-cli" {
                    Section {
                        Text("直接用這台電腦上已經登入好的 CLI 回答(用它自己的訂閱)。CLI 不能呼叫管家的工具,所以只能用在聊天室問答、建議問題、產生提交訊息;整理回報和提案檢查請用其他接口。\(store.models?.cliNotes?[provider.cli ?? ""] ?? "")")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if provider.type == "pi-models" {
                    Section {
                        Text("網址、金鑰、模型清單都讀 pi 的設定(~/.pi/agent/models.json 的「\(provider.piProvider ?? provider.id)」),pi 改了這裡跟著變。")
                            .font(.footnote).foregroundStyle(.secondary)
                        localToggle(provider)
                    }
                }
                Section {
                    Button("測試連線") { testConnection() }
                    if testing { ProgressView("儲存並測試中…") }
                    if let result = testResult {
                        Text("✓ 連線成功").foregroundStyle(.green)
                        Text(":\(result.model ?? "") 回覆「\(result.reply ?? "")」,\(result.latencyMs.map { $0.formatted() } ?? "—") 毫秒;共 \(result.models?.count ?? 0) 個模型")
                            .font(.footnote).textSelection(.enabled)
                    }
                    if let testError { Text("✗ \(testError)").foregroundStyle(.red) }
                    Button("刪除", role: .destructive) { focused = nil; deleting = true }
                }
            } else {
                Text("找不到這個接口")
            }
        }
        .navigationTitle((provider?.name?.isEmpty == false ? provider?.name : nil) ?? providerID)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(store.saving || testing || busy)
        .onAppear { synchronize(force: true) }
        .onChange(of: focused) { old, new in if old != nil && old != new { _ = commitDrafts() } }
        .onChange(of: provider) { _, _ in if pendingWrites == 0 { synchronize() } }
        .onDisappear { _ = commitDrafts() }
        .confirmationDialog("刪除", isPresented: $deleting, titleVisibility: .visible) {
            Button("刪除", role: .destructive) {
                perform {
                    if await store.saveProviders(store.providers.filter { $0.id != providerID }) {
                        await store.loadModels()
                        dismiss()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .toolbar {
            if focused != nil {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成") { focused = nil; _ = commitDrafts() }
                }
            }
        }
    }

    private func textField(_ title: String, field: String) -> some View {
        VStack(alignment: .leading) {
            Text(title).font(.subheadline)
            TextField(title, text: draftBinding(field))
                .keyboardType(field == "baseUrl" ? .URL : .default)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focused, equals: field).submitLabel(.done)
                .onSubmit { focused = nil; _ = commitDrafts() }
                .accessibilityIdentifier("ai-provider-\(providerID)-\(field)")
        }
    }

    @ViewBuilder private func secretField(_ title: String, provider: SettingsProvider) -> some View {
        if editingKey || provider.apiKey?.isEmpty != false {
            SecureField(title, text: draftBinding("apiKey"))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focused, equals: "apiKey").submitLabel(.done)
                .onSubmit { focused = nil; _ = commitDrafts() }
                .accessibilityIdentifier("ai-provider-\(providerID)-apiKey")
        } else {
            HStack {
                Text(title)
                Spacer()
                Text("已設定").foregroundStyle(.secondary)
                Button("修改") { editingKey = true; focused = "apiKey" }
            }
        }
    }

    private func localToggle(_ provider: SettingsProvider) -> some View {
        Toggle("這是本地/自架模型(隱私專案可以用)", isOn: Binding(
            get: { self.provider?.local ?? false },
            set: { value in
                perform {
                    if await store.setProvider(provider.id, field: "local", value: .bool(value)) {
                        await store.loadModels()
                    }
                }
            }
        ))
    }

    private func draftBinding(_ field: String) -> Binding<String> {
        Binding(get: { drafts[field] ?? "" }, set: { drafts[field] = $0 })
    }

    private func synchronize(force: Bool = false) {
        guard let provider else { return }
        for (field, value) in ["name": provider.name ?? "", "baseUrl": provider.baseUrl ?? ""] {
            if force || (focused != field && drafts[field] == originals[field]) {
                drafts[field] = value
                originals[field] = value
            }
        }
        if force { drafts["apiKey"] = ""; originals["apiKey"] = "" }
    }

    /// 失焦或完成時收集修改；後續動作等待這些欄位儲存完成。
    @discardableResult private func commitDrafts() -> Task<Bool, Never> {
        let previous = writeTail
        var changes: [(String, String)] = []
        for field in ["name", "baseUrl", "apiKey"] {
            guard let draft = drafts[field] else { continue }
            let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            if field == "apiKey" {
                guard !value.isEmpty, !value.hasPrefix("••••") else {
                    drafts[field] = ""
                    continue
                }
            }
            guard value != originals[field] else { continue }
            changes.append((field, value))
            originals[field] = value
            drafts[field] = value
        }
        guard !changes.isEmpty else {
            return previous ?? Task { true }
        }
        let submitted = changes
        pendingWrites += 1
        let task = Task { @MainActor in
            var succeeded = await previous?.value ?? true
            for (field, value) in submitted {
                if !(await store.setProvider(providerID, field: field, value: .string(value))) {
                    succeeded = false
                    break
                }
            }
            pendingWrites -= 1
            if submitted.contains(where: { $0.0 == "apiKey" }) {
                drafts["apiKey"] = ""
                originals["apiKey"] = ""
                editingKey = false
            }
            if pendingWrites == 0 {
                writeTail = nil
                // 儲存或回復後，重新顯示目前已儲存的欄位值。
                for field in ["name", "baseUrl"] where focused != field {
                    let value = field == "name" ? provider?.name ?? "" : provider?.baseUrl ?? ""
                    drafts[field] = value
                    originals[field] = value
                }
            }
            return succeeded
        }
        writeTail = task
        return task
    }

    private func perform(_ operation: @escaping @MainActor () async -> Void) {
        guard !busy, !testing else { return }
        focused = nil
        let saved = commitDrafts()
        busy = true
        Task {
            defer { busy = false }
            guard await saved.value else { return }
            await operation()
        }
    }

    private func testConnection() {
        guard !testing, !busy else { return }
        focused = nil
        let saved = commitDrafts()
        testing = true
        testResult = nil
        testError = nil
        Task {
            defer { testing = false }
            guard await saved.value else { testError = store.error ?? String(localized: "失敗", bundle: AppLanguage.bundle); return }
            testResult = await store.action("api/settings/test-provider", body: ["id": .string(providerID)])
            if testResult == nil { testError = store.error ?? String(localized: "失敗", bundle: AppLanguage.bundle) }
            // 測試後重新讀取管家找到的模型清單。
            await store.reload()
            await store.loadModels()
        }
    }
}

@MainActor
@Observable
private final class AIProviderLoginController {
    var presented = false
    var starting = false
    var providerID = ""
    var sessionID: String?
    var status = SettingsAction(status: "waiting")
    var sending = false
    var notice: String?
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var opened = false

    var name: String { AIProviderLabels.loginName(providerID) }
    var finished: Bool { status.status == "done" || status.status == "error" }
    var browserURL: URL? {
        guard let value = status.url, let url = URL(string: value),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        return url
    }

    func start(provider: String, store: SettingsStore) async {
        guard !starting else { return }
        await cancel(store: store)
        let token = UUID()
        generation = token
        providerID = provider
        status = SettingsAction(status: "waiting")
        notice = nil
        opened = false
        starting = true
        presented = true
        let result = await store.action("api/settings/login", body: ["provider": .string(provider)])
        guard generation == token else {
            if let session = result?.session {
                _ = await store.action("api/settings/login/\(session)/cancel")
            }
            return
        }
        starting = false
        guard let result, let session = result.session, !session.isEmpty else {
            status = SettingsAction(status: "error", message: store.error ?? String(localized: "登入失敗", bundle: AppLanguage.bundle))
            return
        }
        sessionID = session
        status = result
        openIfNeeded(store: store)
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.generation == token, !self.finished else { return }
                await self.refresh(store: store)
                do { try await Task.sleep(for: .milliseconds(1500)) }
                catch { return }
            }
        }
    }

    func refresh(store: SettingsStore) async {
        guard let sessionID, !finished else { return }
        let token = generation
        guard let result = await store.action("api/settings/login/\(sessionID)", method: "GET") else {
            guard generation == token, !finished else { return }
            status = SettingsAction(status: "error", message: store.error ?? String(localized: "連不上管家", bundle: AppLanguage.bundle))
            polling?.cancel()
            return
        }
        guard generation == token, !finished else { return }
        status = result
        openIfNeeded(store: store)
        if status.status == "done" {
            polling?.cancel()
            self.sessionID = nil
            store.message = String(localized: "登入完成", bundle: AppLanguage.bundle)
            notice = String(localized: "登入完成", bundle: AppLanguage.bundle)
            await store.reload()
            await store.loadModels()
        } else if status.status == "error" {
            polling?.cancel()
        }
    }

    func sendCallback(_ callback: String, store: SettingsStore) async {
        let code = callback.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sessionID, !code.isEmpty, !sending, !finished else { return }
        let token = generation
        sending = true
        defer { if generation == token { sending = false } }
        if await store.action("api/settings/login/\(sessionID)/code", body: ["code": .string(code)]) != nil,
           generation == token {
            notice = String(localized: "驗證中…", bundle: AppLanguage.bundle)
            await refresh(store: store)
        }
    }

    func openBrowser(store: SettingsStore) {
        guard let url = browserURL else { store.error = String(localized: "登入網址必須是 http 或 https 網址", bundle: AppLanguage.bundle); return }
        UIApplication.shared.open(url, options: [:]) { success in
            if !success {
                Task { @MainActor in store.error = String(localized: "無法打開登入頁面，請複製網址到瀏覽器開啟", bundle: AppLanguage.bundle) }
            }
        }
    }

    private func openIfNeeded(store: SettingsStore) {
        guard status.url != nil, !opened, !finished else { return }
        opened = true
        openBrowser(store: store)
    }

    func cancel(store: SettingsStore) async {
        generation = UUID()
        polling?.cancel()
        polling = nil
        let session = sessionID
        sessionID = nil
        starting = false
        sending = false
        if let session { _ = await store.action("api/settings/login/\(session)/cancel") }
    }
}

private struct AIProviderLoginView: View {
    @Environment(SettingsStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let controller: AIProviderLoginController
    @State private var callback = ""
    @FocusState private var callbackFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if controller.status.status == "error" {
                        Text("✗ 登入失敗:\(controller.status.message ?? "")").foregroundStyle(.red)
                    } else if controller.status.status == "done" {
                        Text("登入完成").foregroundStyle(.green)
                    } else {
                        Text("正在登入 \(controller.name)").font(.headline)
                        if let code = controller.status.userCode, !code.isEmpty {
                            Text("已經打開 \(controller.name) 的登入頁面(沒看到的話點這裡打開,手機或別台電腦也可以開這個網址),在頁面上輸入這組代碼:")
                                .font(.footnote)
                            Text(code).font(.title.monospaced()).textSelection(.enabled)
                            Button("複製代碼") { UIPasteboard.general.string = code }
                            Text("輸入並同意後,這裡會自動完成。")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            Text(controller.status.url == nil ? String(localized: "準備中…", bundle: AppLanguage.bundle) : String(localized: "已經打開 \(controller.name) 的登入頁面(沒看到的話點這裡打開)。", bundle: AppLanguage.bundle))
                                .font(.footnote)
                            Text("在這台電腦登入的話,完成後會自動接上。用手機或別台電腦時,登入後的頁面會打不開(網址開頭是 http://127.0.0.1 或 http://localhost),把那一頁的整段網址貼到這裡:")
                                .font(.footnote).foregroundStyle(.secondary)
                            TextField("http://127.0.0.1:…/callback?code=…", text: $callback, axis: .vertical)
                                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($callbackFocused).submitLabel(.send)
                                .onSubmit { send() }
                            Button("送出") { send() }
                                .disabled(callback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || controller.sending || controller.sessionID == nil)
                        }
                        if let url = controller.browserURL {
                            Button("點這裡打開") { controller.openBrowser(store: store) }
                            Text(url.absoluteString).font(.caption).textSelection(.enabled)
                        }
                        if controller.starting || controller.sending { ProgressView("準備中…") }
                        Text("從瀏覽器回來後可以按「重新整理」查看登入狀態。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("重新整理") { Task { await controller.refresh(store: store) } }
                            .disabled(controller.sessionID == nil)
                    }
                    if let notice = controller.notice { Text(notice).font(.footnote) }
                    if let error = store.error { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("訂閱登入")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(controller.finished ? String(localized: "關閉", bundle: AppLanguage.bundle) : String(localized: "取消", bundle: AppLanguage.bundle)) {
                        Task { await controller.cancel(store: store); dismiss() }
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await controller.refresh(store: store) } }
            }
            .onDisappear { Task { await controller.cancel(store: store) } }
        }
    }

    private func send() {
        callbackFocused = false
        Task { await controller.sendCallback(callback, store: store) }
    }
}
