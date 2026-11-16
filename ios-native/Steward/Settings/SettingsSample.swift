import Foundation

/// 設定範例只保存在記憶體，重新啟動 App 後還原。
final class SettingsSample {
    private let lock = NSLock()
    private let demo: Bool
    private let desktop: Bool
    private let failingWrites: Bool
    private var values = SettingsSample.initialSettings
    private var pluginPolls = 0
    private var updating = false
    private var updatePolls = 0
    private var loginActive = false
    private var loginPolls = 0
    private var passwordSet = true

    init(demo: Bool = false, desktop: Bool = true, failingWrites: Bool = false) {
        self.demo = demo
        self.desktop = desktop
        self.failingWrites = failingWrites
    }

    private static let initialSettings: [String: Any] = [
        "version": 1,
        "user": ["name": "測試使用者"], "ui": ["lang": "zh-TW"],
        "desktop": ["herdrCli": true, "herdrConfig": true, "autostart": true, "autoUpdate": true, "notify": true],
        "paths": ["createRoot": "~/Projects", "privacy": ["~/Private"], "usePiPrivacy": false],
        "code": ["autoFetch": "ask", "autoFetchMinutes": 3],
        "cards": ["defaultAgent": ""],
        "access": ["passwordHash": "set", "tailscale": ["enabled": false], "tailscaleUsers": ["tester@example.invalid"], "lan": ["enabled": false]],
        "server": ["publicUrl": "", "port": 8800, "terminalPort": 8801, "hosts": ["127.0.0.1"]],
        "providers": [
            ["id": "openai", "type": "builtin", "builtin": "openai", "auth": "apiKey", "name": "OpenAI", "apiKey": "••••test"],
            ["id": "ollama", "type": "openai-compatible", "name": "Ollama", "baseUrl": "http://localhost:11434/v1", "local": true, "models": ["llama3", "bge-m3"]],
            ["id": "claude-cli", "type": "agent-cli", "name": "Claude CLI", "cli": "claude", "local": false]
        ],
        "routing": [
            "chat": ["primary": "openai/gpt-4.1", "fallback": "ollama/llama3"],
            "suggest": ["primary": "openai/gpt-4.1", "fallback": ""],
            "digest": ["primary": "openai/gpt-4.1", "fallback": ""],
            "judge": ["primary": "openai/gpt-4.1", "fallback": ""],
            "commitmsg": ["primary": "claude-cli/default", "fallback": ""],
            "privacy": "ollama/llama3", "embedding": "ollama/bge-m3"
        ],
        "notify": ["kind": "telegram", "telegram": ["botToken": "••••test", "chatId": "12345"], "webhook": ["url": ""], "hermes": ["url": "", "route": "steward"]],
        "plugins": ["latex": ["enabled": false], "notebook": ["enabled": false], "office": ["enabled": true]],
        "futureSetting": ["unknown": "kept"]
    ]

    private func merged(_ old: [String: Any], _ incoming: [String: Any]) -> [String: Any] {
        var result = old
        for (name, value) in incoming {
            if let text = value as? String, text.hasPrefix("••••") { continue }
            if let nested = value as? [String: Any] { result[name] = merged(result[name] as? [String: Any] ?? [:], nested) }
            else { result[name] = value }
        }
        return result
    }

    private var plugins: [[String: Any]] {
        let running = (1...2).contains(pluginPolls)
        return [
            ["id": "latex", "name": "LaTeX 編譯", "enabled": pluginPolls >= 3, "status": running ? "installing" : pluginPolls >= 3 ? "installed" : "missing", "size": "約 250 MB(TinyTeX)", "description": "程式碼頁打開 .tex 時可以編譯,錯誤會列出來並跳到那一行,PDF 在旁邊自動更新。缺少的 LaTeX 套件會在編譯時自動安裝。", "detail": "還沒安裝", "removable": pluginPolls >= 3, "job": pluginPolls > 0 ? ["running": running, "progress": min(100, pluginPolls * 35), "message": running ? "下載中…" : "安裝完成", "log": ["準備安裝…", "下載中…"]] : NSNull()],
            ["id": "notebook", "name": "Notebook 執行", "enabled": false, "status": "system", "size": "約 300 MB(Python + Jupyter)", "description": "程式碼頁的 .ipynb 可以直接執行儲存格。", "detail": "沿用電腦上已經裝了 ipykernel 的 Python", "removable": false],
            ["id": "office", "name": "Office 編輯", "enabled": true, "status": "ready", "size": "不用下載", "description": "程式碼頁的 Word / Excel / PowerPoint 檔多一個「用 Office 編輯」。", "detail": "不需要安裝(Office 在你自己的電腦上)", "removable": false]
        ]
    }

    func response(for request: URLRequest, body: Data?) -> (Int, [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch (method, path) {
        case ("GET", "/api/auth/status"):
            return (200, ["authed": true, "how": demo ? "demo" : "tailscale", "hasPassword": passwordSet, "local": false])
        case ("GET", "/api/board"):
            return (200, ["projects": [], "cards": [], "spaceInfo": [:]])
        case ("GET", "/api/current"): return (200, [:])
        case ("GET", "/api/agents"): return (200, ["agents": []])
        case ("GET", "/api/worktree-counts"): return (200, ["counts": [:]])
        case ("GET", "/api/settings"):
            return (200, ["settings": values, "platform": "darwin", "desktop": desktop, "detected": ["tailscale": true, "piPrivacy": true, "hermes": false, "lanIps": ["192.0.2.10"], "port": 8800]])
        case ("PUT", "/api/settings"):
            if failingWrites { return (500, ["error": "測試儲存失敗"]) }
            let patch = input["settings"] as? [String: Any] ?? [:]
            values = merged(values, patch)
            return (200, ["settings": values, "restartNeeded": patch["server"] != nil || (patch["access"] as? [String: Any])?["lan"] != nil])
        case ("GET", "/api/settings/models"):
            let providers = values["providers"] as? [[String: Any]] ?? []
            return (200, ["providers": providers.map { provider -> [String: Any] in
                let id = provider["id"] as? String ?? ""
                return ["id": id, "name": provider["name"] ?? id, "type": provider["type"] ?? "builtin", "local": provider["local"] ?? false, "signedIn": provider["auth"] as? String == "login", "models": provider["models"] ?? (id == "openai" ? ["gpt-4.1"] : ["default"]), "cli": provider["cli"] ?? NSNull()]
            }, "loginProviders": ["openai": "ChatGPT", "anthropic": "Claude", "github-copilot": "GitHub Copilot"], "cliProviders": [["id": "codex-cli", "name": "Codex CLI", "type": "agent-cli", "cli": "codex"]], "piProviders": [["id": "pi-local", "name": "pi 本地", "type": "pi-models", "piProvider": "pi-local", "local": true]], "cliNotes": ["claude": "使用 Claude 訂閱"], "builtins": ["openai", "anthropic", "google"]])
        case ("GET", "/api/settings/agents"):
            return (200, ["agents": [["id": "claude", "name": "Claude Code", "installed": true, "path": "/sample/bin/claude", "dispatch": true, "records": true, "can": ["brief": true, "mcp": true, "instructions": true], "on": ["brief": true, "mcp": true, "instructions": true], "integrated": true, "manual": "claude mcp add steward"], ["id": "codex", "name": "Codex", "installed": false, "dispatch": true, "records": true, "can": ["mcp": true], "on": [:], "integrated": false]]])
        case ("GET", "/api/settings/plugins"):
            if pluginPolls > 0 && pluginPolls < 3 { pluginPolls += 1 }
            return (200, ["plugins": plugins])
        case ("GET", "/api/settings/update"):
            return (200, ["current": "0.4.0", "latest": "0.4.1", "hasUpdate": true, "running": updating, "desktop": desktop, "dev": false, "url": "https://example.invalid/release", "notes": "範例版本更新說明", "components": [["id": "herdr", "name": "herdr", "version": "1.0", "license": "MIT", "home": "https://example.invalid/herdr"]]])
        case ("GET", "/api/settings/update/log"):
            updatePolls += 1
            if updatePolls > 1 { updating = false }
            return (200, ["log": updating ? "正在下載…" : "已經裝好"])
        case ("GET", "/api/push/status"):
            if demo { return (200, ["configured": false, "mode": "none", "devices": [[String: Any]]()]) }
            return (200, ["configured": true, "mode": "relay", "devices": [["name": "測試 iPhone", "platform": "ios", "encrypted": true], ["name": "舊版裝置", "platform": "ios", "encrypted": false]]])
        case ("POST", "/api/settings/test-provider"):
            return (200, ["ok": true, "model": "gpt-4.1", "reply": "OK", "latencyMs": 12, "models": ["gpt-4.1"]])
        case ("POST", "/api/auth/password"):
            if !demo {
                guard (input["next"] as? String ?? "").count >= 8 else { return (400, ["error": "新密碼至少要 8 個字"]) }
                passwordSet = true
            }
            return (200, ["ok": true])
        case ("POST", "/api/settings/tailscale"):
            if demo { return (200, ["ok": true, "url": "", "settings": values]) }
            let enabled = input["enable"] as? Bool ?? false
            let base = request.url.flatMap { URL(string: "/", relativeTo: $0)?.absoluteURL.absoluteString } ?? ""
            values = merged(values, ["access": ["tailscale": ["enabled": enabled]], "server": ["publicUrl": enabled ? base : ""]])
            return (200, ["ok": true, "url": enabled ? base : "", "settings": values])
        case ("POST", "/api/settings/update"):
            if !demo { updating = true; updatePolls = 0 }
            return (200, ["ok": true])
        case ("POST", "/api/settings/login"):
            if !demo { loginActive = true; loginPolls = 0 }
            return (200, ["session": "0123456789abcdef01234567"])
        case ("POST", "/api/settings/logout-provider"), ("POST", "/api/settings/test-notify"), ("POST", "/api/push/test"), ("POST", "/api/auth/login"), ("POST", "/api/auth/logout"), ("POST", "/api/desktop/update"):
            return (200, ["ok": true])
        default:
            if path.hasPrefix("/api/settings/login/") {
                // 示範登入直接完成，不提供會開啟瀏覽器的網址。
                if demo { return (200, ["ok": true, "status": "done"]) }
                if path.hasSuffix("/cancel") { loginActive = false; return (200, ["ok": true]) }
                if path.hasSuffix("/code") { loginPolls = 2; return (200, ["ok": true]) }
                loginPolls += 1
                return (200, ["status": loginPolls > 2 || !loginActive ? "done" : "waiting", "userCode": "TEST-CODE", "url": "https://example.invalid/login"])
            }
            if method == "POST", path.hasPrefix("/api/settings/agents/") {
                return (200, ["changed": demo ? [] : ["/sample/agent.json"]])
            }
            if method == "POST", path.hasPrefix("/api/settings/plugins/") {
                if demo { return (200, ["plugins": plugins, "started": false]) }
                if path.hasSuffix("/remove") { pluginPolls = 0 }
                else if input["enable"] as? Bool == true { pluginPolls = 1 }
                else { pluginPolls = 0 }
                return (200, ["plugins": plugins, "started": pluginPolls == 1])
            }
            return (404, ["error": "範例資料未定義的路由: \(method) \(path)"])
        }
    }
}
