import XCTest

/// 驗證共用推播密文的解密結果。
final class PushCryptoTests: XCTestCase {

    /// 一組測試向量:金鑰(base64)、明文 JSON 字串、密文(base64)
    private struct Vector: Decodable {
        let name: String
        let key: String
        let plaintext: String
        let payload: String
    }

    /// 整個 vectors.json 的結構:固定向量群 + 一組故意用錯金鑰的向量
    private struct Fixtures: Decodable {
        let vectors: [Vector]
        let wrongKey: Vector
    }

    /// 從測試 bundle 讀 vectors.json 並解碼
    private func loadFixtures() throws -> Fixtures {
        guard let url = Bundle(for: PushCryptoTests.self).url(forResource: "vectors", withExtension: "json") else {
            XCTFail("找不到測試資源 vectors.json")
            throw CocoaError(.fileNoSuchFile)
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Fixtures.self, from: data)
    }

    /// 逐欄位比對解密結果與預期的 PushPlain
    private func assertEqual(_ actual: PushPlain, _ expected: PushPlain, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.title, expected.title, "\(label):title 不符", file: file, line: line)
        XCTAssertEqual(actual.body, expected.body, "\(label):body 不符", file: file, line: line)
        XCTAssertEqual(actual.link, expected.link, "\(label):link 不符", file: file, line: line)
        XCTAssertEqual(actual.thread, expected.thread, "\(label):thread 不符", file: file, line: line)
    }

    /// 每組固定向量都要能解密,並與 plaintext 欄位解出的 PushPlain 完全一致
    func testVectorsDecrypt() throws {
        let fixtures = try loadFixtures()
        XCTAssertFalse(fixtures.vectors.isEmpty, "vectors 不應為空")
        for vector in fixtures.vectors {
            guard let keyData = Data(base64Encoded: vector.key) else {
                XCTFail("\(vector.name):金鑰不是有效的 base64")
                continue
            }
            let decrypted = try PushCrypto.decrypt(keyData: keyData, payload: vector.payload)
            guard let expectedData = vector.plaintext.data(using: .utf8) else {
                XCTFail("\(vector.name):明文編碼失敗")
                continue
            }
            let expected = try JSONDecoder().decode(PushPlain.self, from: expectedData)
            assertEqual(decrypted, expected, vector.name)
        }
    }

    /// 金鑰對不上(內容與 vector-1 相同但金鑰換掉)必須拋錯,不能解出內容
    func testWrongKeyThrows() throws {
        let fixtures = try loadFixtures()
        guard let keyData = Data(base64Encoded: fixtures.wrongKey.key) else {
            XCTFail("wrongKey 金鑰不是有效的 base64")
            return
        }
        XCTAssertThrowsError(try PushCrypto.decrypt(keyData: keyData, payload: fixtures.wrongKey.payload))
    }

    /// 密文不是有效 base64 時必須拋錯
    func testInvalidBase64PayloadThrows() {
        let key = PushCrypto.newKey()
        XCTAssertThrowsError(try PushCrypto.decrypt(keyData: key, payload: "%%%not-base64%%%"))
    }
}
