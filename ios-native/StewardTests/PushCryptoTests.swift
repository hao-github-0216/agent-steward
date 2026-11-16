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
        // 選填欄位:舊向量沒有 category/card,必須保持 nil
        XCTAssertEqual(actual.category, expected.category, "\(label):category 不符", file: file, line: line)
        XCTAssertEqual(actual.card, expected.card, "\(label):card 不符", file: file, line: line)
    }

    /// 每組固定向量都要能解密,並與 plaintext 欄位解出的 PushPlain 完全一致
    func testVectorsDecrypt() throws {
        let fixtures = try loadFixtures()
        // 固定向量共四組(含帶 category/card 的 vector-4)
        XCTAssertEqual(fixtures.vectors.count, 4, "應有四組固定向量")
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

    /// vector-4 應解出 category=proposal、card=card-action-1;前三組舊向量無新欄位,必須為 nil
    func testVectorFourCategoryAndCard() throws {
        let fixtures = try loadFixtures()
        for vector in fixtures.vectors {
            guard let keyData = Data(base64Encoded: vector.key) else {
                XCTFail("\(vector.name):金鑰不是有效的 base64")
                continue
            }
            let decrypted = try PushCrypto.decrypt(keyData: keyData, payload: vector.payload)
            if vector.name == "vector-4" {
                XCTAssertEqual(decrypted.category, "proposal", "vector-4:category 應為 proposal")
                XCTAssertEqual(decrypted.card, "card-action-1", "vector-4:card 應為 card-action-1")
            } else {
                // 舊三組 fixture 不含新欄位,選填欄位應解成 nil
                XCTAssertNil(decrypted.category, "\(vector.name):category 應為 nil")
                XCTAssertNil(decrypted.card, "\(vector.name):card 應為 nil")
            }
        }
        // 確認 vector-4 確實存在(否則上面迴圈不會驗證到新欄位)
        XCTAssertTrue(fixtures.vectors.contains { $0.name == "vector-4" }, "fixture 應包含 vector-4")
    }

    /// 純函式:approve 對應 approved 欄
    func testPushActionColumnApprove() {
        XCTAssertEqual(PushAction.column(for: "approve"), "approved")
    }

    /// 純函式:reject 對應 rejected 欄
    func testPushActionColumnReject() {
        XCTAssertEqual(PushAction.column(for: "reject"), "rejected")
    }

    /// 純函式:redispatch 與 approve 同樣落到 approved 欄
    func testPushActionColumnRedispatch() {
        XCTAssertEqual(PushAction.column(for: "redispatch"), "approved")
    }

    /// 純函式:done 對應 done 欄
    func testPushActionColumnDone() {
        XCTAssertEqual(PushAction.column(for: "done"), "done")
    }

    /// 純函式:未知的 action 識別字串一律回傳 nil
    func testPushActionColumnUnknown() {
        XCTAssertNil(PushAction.column(for: "destroy-everything"))
        // 空字串與系統保留的 action 字串也不是合法的 action 識別碼
        XCTAssertNil(PushAction.column(for: ""))
        XCTAssertNil(PushAction.column(for: "com.apple.developer.category"))
    }

    /// 密文不是有效 base64 時必須拋錯
    func testInvalidBase64PayloadThrows() {
        let key = PushCrypto.newKey()
        XCTAssertThrowsError(try PushCrypto.decrypt(keyData: key, payload: "%%%not-base64%%%"))
    }
}
