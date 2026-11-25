import Foundation

/// 設定保留尚未認得的欄位，修改時只傳送指定的部分。
indirect enum SettingsValue: Codable, Equatable {
    case string(String), bool(Bool), number(Double), array([SettingsValue]), object([String: SettingsValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([SettingsValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: SettingsValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    var array: [SettingsValue]? { if case .array(let v) = self { return v }; return nil }
    var object: [String: SettingsValue]? { if case .object(let v) = self { return v }; return nil }
    /// 遮罩及留白的金鑰不寫回；其他空字串仍可用來清除一般設定。
    var withoutSecrets: SettingsValue {
        switch self {
        case .object(let values):
            return .object(values.reduce(into: [:]) { result, entry in
                if let text = entry.value.string,
                   text.hasPrefix("••••") || (["apiKey", "botToken"].contains(entry.key) && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { return }
                result[entry.key] = entry.value.withoutSecrets
            })
        case .array(let values): return .array(values.map(\.withoutSecrets))
        default: return self
        }
    }
    static func encoded<T: Encodable>(_ value: T) throws -> SettingsValue {
        try JSONDecoder().decode(SettingsValue.self, from: JSONEncoder().encode(value))
    }
}
struct SettingsValues: Codable, Equatable {
    var fields: [String: SettingsValue] = [:]
    init(_ fields: [String: SettingsValue] = [:]) { self.fields = fields }
    init(from decoder: Decoder) throws { fields = try decoder.singleValueContainer().decode([String: SettingsValue].self) }
    func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(fields) }
    subscript(_ path: String) -> SettingsValue? {
        get {
            var value = SettingsValue.object(fields)
            for part in path.split(separator: ".") { guard let next = value.object?[String(part)] else { return nil }; value = next }
            return value
        }
        set {
            let keys = path.split(separator: ".").map(String.init)
            func replacing(_ object: [String: SettingsValue], _ keys: ArraySlice<String>) -> [String: SettingsValue] {
                guard let key = keys.first else { return object }
                var result = object
                result[key] = keys.count == 1 ? newValue : .object(replacing(object[key]?.object ?? [:], keys.dropFirst()))
                return result
            }
            fields = replacing(fields, keys[...])
        }
    }
    func string(_ path: String, default fallback: String = "") -> String { self[path]?.string ?? fallback }
    func bool(_ path: String, default fallback: Bool = false) -> Bool { self[path]?.bool ?? fallback }
    func strings(_ path: String) -> [String] { self[path]?.array?.compactMap(\.string) ?? [] }
    func integer(_ path: String, default fallback: Int = 0) -> Int { Int(self[path]?.number ?? Double(fallback)) }
}
struct SettingsResponse: Codable {
    var settings: SettingsValues?
    var platform: String?
    var desktop: Bool?
    var detected: SettingsDetected?
    var restartNeeded: Bool?
}
struct SettingsDetected: Codable {
    var tailscale: Bool?
    var piPrivacy: Bool?
    var hermes: Bool?
    var lanIps: [String]?
    var port: Int?
}
struct SettingsProvider: Codable, Identifiable, Equatable {
    var id: String
    var type: String?
    var name: String?
    var builtin: String?
    var auth: String?
    var apiKey: String?
    var baseUrl: String?
    var models: [String]?
    var piProvider: String?
    var cli: String?
    var local: Bool?
}
struct SettingsModels: Codable {
    var providers: [SettingsModelProvider]?
    var loginProviders: [String: String]?
    var cliProviders: [SettingsProvider]?
    var cliNotes: [String: String]?
    var piProviders: [SettingsProvider]?
    var builtins: [String]?
}
struct SettingsModelProvider: Codable, Identifiable {
    var id: String
    var name: String?
    var type: String?
    var local: Bool?
    var models: [String]?
    var signedIn: Bool?
    var cli: String?
}
struct SettingsAgent: Codable, Identifiable {
    var id: String
    var name: String?
    var installed: Bool?
    var path: String?
    var can: [String: Bool]?
    var on: [String: Bool]?
    var records: Bool?
    var dispatch: Bool?
    var integrated: Bool?
    var manual: String?
}
struct SettingsPlugin: Codable, Identifiable {
    var id: String
    var name: String?
    var enabled: Bool?
    var status: String?
    var size: String?
    var description: String?
    var detail: String?
    var removable: Bool?
    var job: SettingsPluginJob?
}
struct SettingsPluginJob: Codable {
    var running: Bool?
    var progress: Double?
    var message: String?
    var log: [String]?
    var error: String?
}
struct SettingsUpdate: Decodable {
    var current: String?
    var latest: String?
    var hasUpdate: Bool?
    var running: Bool?
    var desktop: Bool?
    var dev: Bool?
    var error: String?
    var url: String?
    var notes: String?
    var components: [SettingsComponent]?
    var downloadUrl: String?
    var releaseUrl: String?
    var integrity: SettingsIntegrity?
    let supportsDesktopDownload: Bool

    private enum CodingKeys: String, CodingKey {
        case current, latest, hasUpdate, running, desktop, dev, error, url, notes, components
        case downloadUrl, releaseUrl, integrity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = try? c.decodeIfPresent(String.self, forKey: .current)
        latest = try? c.decodeIfPresent(String.self, forKey: .latest)
        hasUpdate = try? c.decodeIfPresent(Bool.self, forKey: .hasUpdate)
        running = try? c.decodeIfPresent(Bool.self, forKey: .running)
        desktop = try? c.decodeIfPresent(Bool.self, forKey: .desktop)
        dev = try? c.decodeIfPresent(Bool.self, forKey: .dev)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        components = try? c.decodeIfPresent([SettingsComponent].self, forKey: .components)
        downloadUrl = try? c.decodeIfPresent(String.self, forKey: .downloadUrl)
        releaseUrl = try? c.decodeIfPresent(String.self, forKey: .releaseUrl)
        integrity = try? c.decodeIfPresent(SettingsIntegrity.self, forKey: .integrity)
        supportsDesktopDownload = c.contains(.releaseUrl) || c.contains(.integrity)
    }
}

struct SettingsIntegrity: Decodable, Equatable {
    var status: String?
    var counts: Counts?

    struct Counts: Decodable, Equatable {
        var changed: Int?
        var missing: Int?
        var added: Int?

        private enum CodingKeys: String, CodingKey { case changed, missing, added }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            changed = try? c.decodeIfPresent(Int.self, forKey: .changed)
            missing = try? c.decodeIfPresent(Int.self, forKey: .missing)
            added = try? c.decodeIfPresent(Int.self, forKey: .added)
        }
    }

    private enum CodingKeys: String, CodingKey { case status, counts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        counts = try? c.decodeIfPresent(Counts.self, forKey: .counts)
    }
}

struct AboutPlan: Equatable {
    enum Update: Equatable { case desktopCheck, downloadApp(URL), downloadUnavailable, legacyGuide, none }
    enum Uninstall: Equatable { case desktop, devScript, unknown }
    enum Integrity: Equatable { case none, modified(count: Int?, installer: URL?) }
    var update: Update
    var uninstall: Uninstall
    var integrity: Integrity

    static func make(update: SettingsUpdate?, responseDesktop: Bool?, platform: String?) -> AboutPlan {
        let desktop = update?.desktop ?? responseDesktop ?? false
        let updatePlan: Update
        if desktop {
            updatePlan = .desktopCheck
        } else if update?.hasUpdate != true {
            updatePlan = .none
        } else if update?.supportsDesktopDownload == true {
            if let url = settingsWebURL(update?.downloadUrl) { updatePlan = .downloadApp(url) }
            else { updatePlan = .downloadUnavailable }
        } else {
            updatePlan = .legacyGuide
        }

        let uninstall: Uninstall
        if desktop {
            uninstall = .desktop
        } else if update?.supportsDesktopDownload == true, update?.dev == true,
                  platform == "darwin" || platform == "linux" {
            uninstall = .devScript
        } else {
            uninstall = .unknown
        }

        let integrity: Integrity
        if update?.supportsDesktopDownload == true, update?.integrity?.status == "modified" {
            let count = update?.integrity?.counts.map { ($0.changed ?? 0) + ($0.missing ?? 0) + ($0.added ?? 0) }
            integrity = .modified(count: count, installer: settingsWebURL(update?.releaseUrl))
        } else {
            integrity = .none
        }
        return AboutPlan(update: updatePlan, uninstall: uninstall, integrity: integrity)
    }
}
struct SettingsComponent: Codable, Identifiable {
    var id: String
    var name: String?
    var version: String?
    var license: String?
    var home: String?
}
struct SettingsPushStatus: Codable {
    var mode: String?
    var configured: Bool?
    var devices: [SettingsPushDevice]?
}
struct SettingsPushDevice: Codable {
    var name: String?
    var encrypted: Bool?
    var platform: String?
    var env: String?
}
struct SettingsAction: Codable {
    var ok: Bool?
    var error: String?
    var settings: SettingsValues?
    var plugins: [SettingsPlugin]?
    var changed: [SettingsValue]?
    var started: Bool?
    var url: String?
    var session: String?
    var status: String?
    var message: String?
    var userCode: String?
    var log: String?
    var model: String?
    var reply: String?
    var latencyMs: Double?
    var models: [String]?
}
extension API {
    func getSettings() async throws -> SettingsResponse { try await call(request("api/settings")) }
    func putSettings(_ patch: SettingsValues) async throws -> SettingsResponse {
        let clean = SettingsValue.object(patch.fields).withoutSecrets
        let data = try JSONEncoder().encode(clean)
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return try await call(request("api/settings", method: "PUT", body: ["settings": body]))
    }
    func getSettingsModels() async throws -> SettingsModels { try await call(request("api/settings/models")) }
    func getSettingsAgents() async throws -> [SettingsAgent] {
        struct Result: Decodable { var agents: [SettingsAgent]? }
        let r: Result = try await call(request("api/settings/agents")); return r.agents ?? []
    }
    func getSettingsPlugins() async throws -> [SettingsPlugin] {
        struct Result: Decodable { var plugins: [SettingsPlugin]? }
        let r: Result = try await call(request("api/settings/plugins")); return r.plugins ?? []
    }
    func getSettingsUpdate(force: Bool = false) async throws -> SettingsUpdate {
        try await call(request("api/settings/update" + (force ? "?force=1" : "")))
    }
    func getSettingsPushStatus() async throws -> SettingsPushStatus { try await call(request("api/push/status")) }
    func settingsAction(_ path: String, method: String = "POST", body: [String: SettingsValue] = [:]) async throws -> SettingsAction {
        let data = try JSONEncoder().encode(body)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return try await call(request(path, method: method, body: method == "GET" ? nil : json), slow: method != "GET")
    }
}
