import CryptoKit
import Foundation
import Security

struct PushPlain: Decodable {
    let title: String
    let body: String
    let link: String?
    let thread: String?
}

enum PushCrypto {
    enum Failure: LocalizedError {
        case invalidBase64
        case invalidKey
        case missingKeychainGroup
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .invalidBase64: "推播密文不是有效的 base64"
            case .invalidKey: "推播金鑰必須是 32 位元組"
            case .missingKeychainGroup: "尚未設定推播鑰匙圈群組"
            case .keychain(let status): "推播鑰匙圈錯誤（\(status)）"
            }
        }
    }

    static func newKey() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }

    static func decrypt(keyData: Data, payload: String) throws -> PushPlain {
        guard keyData.count == 32 else { throw Failure.invalidKey }
        guard let combined = Data(base64Encoded: payload) else { throw Failure.invalidBase64 }
        let box = try AES.GCM.SealedBox(combined: combined)
        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: keyData),
                                         authenticating: Data("agent-steward-push-v1".utf8))
        return try JSONDecoder().decode(PushPlain.self, from: plaintext)
    }

    private static func keychainQuery() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "StewardKeychainGroup") as? String,
              !group.isEmpty else { throw Failure.missingKeychainGroup }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "agent-steward-push",
            kSecAttrAccount as String: "device-key",
            kSecAttrAccessGroup as String: group
        ]
    }

    static func loadKey() throws -> Data? {
        var query = try keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        guard let data = result as? Data, data.count == 32 else { throw Failure.invalidKey }
        return data
    }

    static func loadOrCreateKey() throws -> Data {
        if let key = try loadKey() { return key }
        let key = newKey()
        var query = try keychainQuery()
        query[kSecValueData as String] = key
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem, let existing = try loadKey() { return existing }
        guard status == errSecSuccess else { throw Failure.keychain(status) }
        return key
    }
}
