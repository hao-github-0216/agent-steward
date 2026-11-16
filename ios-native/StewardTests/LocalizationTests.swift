import XCTest

final class LocalizationTests: XCTestCase {
    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    private func containsCJK(_ value: String) -> Bool {
        value.unicodeScalars.contains {
            (0x3400...0x9FFF).contains($0.value) || (0xF900...0xFAFF).contains($0.value) ||
                (0x20000...0x323AF).contains($0.value)
        }
    }

    private func formats(_ value: String) -> [String] {
        let pattern = #"%%|%(?:\d+\$)?[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|ll|h|l|L|z|t|j)?[@diuoxXfFeEgGaAcCsSp]"#
        let regex = try! NSRegularExpression(pattern: pattern)
        var nextPosition = 1
        let arguments: [(Int, String)] = regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).compactMap {
            let specifier = (value as NSString).substring(with: $0.range)
            guard specifier != "%%" else { return nil }
            let positionRange = specifier.range(of: #"(?<=%)\d+\$"#, options: .regularExpression)
            let position = positionRange.flatMap { Int(specifier[$0].dropLast()) } ?? nextPosition
            nextPosition += 1
            let type = specifier.replacingOccurrences(of: #"^%\d+\$"#, with: "%", options: .regularExpression)
            return (position, type)
        }
        return arguments.sorted { $0.0 < $1.0 }.map { "\($0.0):\($0.1)" }
    }

    private func compiled(_ language: String, table: String = "Localizable") throws -> [String: String] {
        let folder = try XCTUnwrap(Bundle.main.url(forResource: language, withExtension: "lproj"))
        let data = try Data(contentsOf: folder.appendingPathComponent("\(table).strings"))
        return try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
    }

    func testCompiledEnglishCoversTraditionalChinese() throws {
        let chinese = try compiled("zh-Hant")
        let english = try compiled("en")
        XCTAssertGreaterThan(chinese.count, 800)
        XCTAssertEqual(Set(chinese.keys), Set(english.keys), "編譯後的兩種語言必須有相同的 key")
        for key in chinese.keys.sorted() {
            let value = try XCTUnwrap(english[key], "缺少英文：\(key)")
            XCTAssertFalse(value.isEmpty && !key.isEmpty, "英文不得空白：\(key)")
            XCTAssertFalse(containsCJK(value), "英文含有中文字：\(key) → \(value)")
            XCTAssertEqual(formats(key), formats(value), "英文插值的數量或型別不同：\(key)")
            XCTAssertEqual(formats(key), formats(chinese[key]!), "繁中插值的數量或型別不同：\(key)")
        }
    }

    func testCatalogsHaveCompleteEnglish() throws {
        for name in ["Localizable", "InfoPlist"] {
            let data = try Data(contentsOf: sourceRoot.appendingPathComponent("Steward/\(name).xcstrings"))
            let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(catalog["sourceLanguage"] as? String, "zh-Hant")
            let strings = try XCTUnwrap(catalog["strings"] as? [String: [String: Any]])
            for (key, entry) in strings {
                let localizations = try XCTUnwrap(entry["localizations"] as? [String: [String: Any]], key)
                let unit = try XCTUnwrap(localizations["en"]?["stringUnit"] as? [String: String], key)
                let english = try XCTUnwrap(unit["value"], key)
                XCTAssertEqual(unit["state"], "translated", key)
                XCTAssertFalse(containsCJK(english), "英文含有中文字：\(key)")
                XCTAssertEqual(formats(key), formats(english), key)
            }
        }
    }

    func testCompiledInfoPlistTranslations() throws {
        let english = try compiled("en", table: "InfoPlist")
        let chinese = try compiled("zh-Hant", table: "InfoPlist")
        XCTAssertEqual(english["CFBundleDisplayName"], "Agent Steward")
        XCTAssertEqual(chinese["CFBundleDisplayName"], "專案管家")
        for key in ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription", "io.github.haogithub0216.agentsteward.native.tab"] {
            let value = try XCTUnwrap(english[key], key)
            XCTAssertFalse(value.isEmpty)
            XCTAssertFalse(containsCJK(value), key)
            XCTAssertNotNil(chinese[key], key)
        }
    }

    func testPrimaryLanguageSelection() {
        for language in ["zh", "zh-Hant", "zh-Hans", "zh-CN", "zh-HK", "zh-TW", "ZH-hans"] {
            XCTAssertEqual(AppLanguage.code(for: language), "zh-Hant", language)
        }
        for language in ["en", "en-US", "fr", "ja", "de", "ko", ""] {
            XCTAssertEqual(AppLanguage.code(for: language), "en", language)
        }
        XCTAssertEqual(AppLanguage.code(for: nil), "en")
    }

    func testAllChineseLiteralsAreLocalizedOrExplained() throws {
        let directory = sourceRoot.appendingPathComponent("Steward")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        var failures: [String] = []
        for case let file as URL in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            failures += unlocalizedLiterals(in: source).map { "\(file.lastPathComponent):\($0)" }
        }
        XCTAssertTrue(failures.isEmpty, "未本地化的中文字面值：\n" + failures.joined(separator: "\n"))
    }

    func testStaticCheckerRejectsUnlocalizedAndConcatenatedLiterals() {
        XCTAssertEqual(unlocalizedLiterals(in: "let title = \"未翻譯\"").count, 1)
        XCTAssertEqual(unlocalizedLiterals(in: "Text(\"未翻譯\" + name)").count, 1)
        XCTAssertTrue(unlocalizedLiterals(in: "Text(\"已翻譯\")").isEmpty)
        XCTAssertTrue(unlocalizedLiterals(in: "let title = String(localized: \"已翻譯\")").isEmpty)
        XCTAssertTrue(unlocalizedLiterals(in: "// let title = \"註解\"").isEmpty)
        XCTAssertTrue(unlocalizedLiterals(in: "let id = \"協定\" // i18n-ok: 伺服器欄位值").isEmpty)
    }

    private func unlocalizedLiterals(in source: String) -> [String] {
        let scanner = SwiftLiteralScanner(source)
        let characters = scanner.characters
        let lines = source.components(separatedBy: "\n")
        let automatic = #"(?:\b(?:Text|Button|Label|Section|TextField|SecureField|Toggle|Picker|ProgressView|ContentUnavailableView|NavigationLink|Link|LabeledContent|Menu)|\.(?:navigationTitle|alert|confirmationDialog|accessibilityLabel|accessibilityHint|help|searchable))\(\s*$"#
        let explicit = #"(?:String\(localized:|LocalizedStringResource\(|String\(localized: "[A-Za-z0-9_.]+",\s*defaultValue:)\s*$"#
        return scanner.scan().compactMap { token in
            guard containsCJK(token.literal) else { return nil }
            let startLine = scanner.line(at: token.start)
            let endLine = scanner.line(at: token.end - 1)
            if lines[startLine - 1].contains("// i18n-ok:") || lines[endLine - 1].contains("// i18n-ok:") { return nil }
            let prefix = String(characters[max(0, token.start - 180)..<token.start])
            let suffix = String(characters[token.end...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if prefix.range(of: explicit, options: .regularExpression) != nil { return nil }
            if !suffix.hasPrefix("+"), prefix.range(of: automatic, options: .regularExpression) != nil { return nil }
            return "\(startLine): \(String(token.literal.prefix(100)))"
        }
    }
}

/// 掃描 Swift 字面值，略過註解，並將插值中的字串分開檢查。
private final class SwiftLiteralScanner {
    struct Token {
        let start: Int
        let end: Int
        let literal: String
    }

    let characters: [Character]
    private let lineNumbers: [Int]
    private var tokens: [Token] = []

    init(_ source: String) {
        characters = Array(source)
        var line = 1
        lineNumbers = characters.map { character in
            let current = line
            if character == "\n" { line += 1 }
            return current
        }
    }

    func line(at index: Int) -> Int { lineNumbers[index] }

    func scan() -> [Token] {
        _ = code(from: 0, interpolation: false)
        return tokens.sorted { $0.start < $1.start }
    }

    private func matches(_ value: String, at index: Int) -> Bool {
        let needle = Array(value)
        guard index + needle.count <= characters.count else { return false }
        return characters[index..<(index + needle.count)].elementsEqual(needle)
    }

    private func code(from start: Int, interpolation: Bool) -> Int {
        var index = start
        var depth = 1
        while index < characters.count {
            if matches("//", at: index) {
                while index < characters.count && characters[index] != "\n" { index += 1 }
            } else if matches("/*", at: index) {
                var comments = 1
                index += 2
                while index < characters.count && comments > 0 {
                    if matches("/*", at: index) { comments += 1; index += 2 }
                    else if matches("*/", at: index) { comments -= 1; index += 2 }
                    else { index += 1 }
                }
            } else if let end = string(from: index) {
                index = end
            } else {
                if interpolation {
                    if characters[index] == "(" { depth += 1 }
                    if characters[index] == ")" {
                        depth -= 1
                        if depth == 0 { return index + 1 }
                    }
                }
                index += 1
            }
        }
        return index
    }

    private func string(from start: Int) -> Int? {
        var index = start
        var hashes = ""
        while index < characters.count && characters[index] == "#" { hashes += "#"; index += 1 }
        guard index < characters.count && characters[index] == "\"" else { return nil }
        let quotes = matches("\"\"\"", at: index) ? "\"\"\"" : "\""
        index += quotes.count
        var literal = ""
        while index < characters.count {
            if matches(quotes + hashes, at: index) {
                index += quotes.count + hashes.count
                tokens.append(Token(start: start, end: index, literal: literal))
                return index
            }
            if matches("\\" + hashes + "(", at: index) {
                index = code(from: index + hashes.count + 2, interpolation: true)
            } else if matches("\\" + hashes, at: index), index + hashes.count + 1 < characters.count {
                index += hashes.count + 1
                literal.append(characters[index])
                index += 1
            } else {
                literal.append(characters[index])
                index += 1
            }
        }
        return index
    }
}
