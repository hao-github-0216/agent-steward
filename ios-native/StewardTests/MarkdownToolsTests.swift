import XCTest
@testable import Steward

final class MarkdownToolsTests: XCTestCase {
    private func assertEdit(_ result: (text: String, selection: NSRange), _ text: String, _ location: Int, _ length: Int,
                            file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(result.text, text, file: file, line: line)
        XCTAssertEqual(result.selection, NSRange(location: location, length: length), file: file, line: line)
    }

    func testToggleWrapKeepsSelectedContent() {
        assertEdit(MarkdownTools.toggleWrap(text: "abc", range: NSRange(location: 1, length: 1), marker: "**"), "a**b**c", 3, 1)
    }

    func testToggleWrapRemovesSurroundingOrSelectedMarkers() {
        assertEdit(MarkdownTools.toggleWrap(text: "a**b**c", range: NSRange(location: 3, length: 1), marker: "**"), "abc", 1, 1)
        assertEdit(MarkdownTools.toggleWrap(text: "a~~b~~c", range: NSRange(location: 1, length: 5), marker: "~~"), "abc", 1, 1)
    }

    func testToggleWrapAtEmptySelection() {
        assertEdit(MarkdownTools.toggleWrap(text: "ab", range: NSRange(location: 1, length: 0), marker: "`"), "a``b", 2, 0)
        assertEdit(MarkdownTools.toggleWrap(text: "****", range: NSRange(location: 2, length: 0), marker: "**"), "", 0, 0)
        assertEdit(MarkdownTools.toggleWrap(text: "", range: NSRange(location: 0, length: 0), marker: "$"), "$$", 1, 0)
    }

    func testToggleWrapRoundTripsAllToolbarMarkers() {
        for marker in ["**", "*", "~~", "`", "$"] {
            let wrapped = MarkdownTools.toggleWrap(text: "hello", range: NSRange(location: 0, length: 5), marker: marker)
            assertEdit(MarkdownTools.toggleWrap(text: wrapped.text, range: wrapped.selection, marker: marker), "hello", 0, 5)
        }
    }

    func testToggleWrapUsesUTF16ForEmoji() {
        let wrapped = MarkdownTools.toggleWrap(text: "😀甲🧑‍💻乙", range: NSRange(location: 3, length: 5), marker: "**")
        assertEdit(wrapped, "😀甲**🧑‍💻**乙", 5, 5)
        assertEdit(MarkdownTools.toggleWrap(text: wrapped.text, range: wrapped.selection, marker: "**"), "😀甲🧑‍💻乙", 3, 5)
        assertEdit(MarkdownTools.toggleWrap(text: "😀**甲**", range: NSRange(location: 2, length: 5), marker: "**"), "😀甲", 2, 1)
    }

    func testToggleLinePrefixAddsAndRemovesWholeLines() {
        let added = MarkdownTools.toggleLinePrefix(text: "one\ntwo\n", range: NSRange(location: 1, length: 4), prefix: "- ")
        assertEdit(added, "- one\n- two\n", 0, 11)
        assertEdit(MarkdownTools.toggleLinePrefix(text: added.text, range: added.selection, prefix: "- "), "one\ntwo\n", 0, 7)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "- one\ntwo", range: NSRange(location: 0, length: 9), prefix: "- "), "- - one\n- two", 0, 13)
    }

    func testToggleLinePrefixExcludesNextLineAtSelectionEnd() {
        assertEdit(MarkdownTools.toggleLinePrefix(text: "one\ntwo\nthree", range: NSRange(location: 1, length: 7), prefix: "> "), "> one\n> two\nthree", 0, 11)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "one\n", range: NSRange(location: 0, length: 4), prefix: "- "), "- one\n", 0, 5)
    }

    func testToggleLinePrefixAtEmptyLineAndCursor() {
        assertEdit(MarkdownTools.toggleLinePrefix(text: "", range: NSRange(location: 0, length: 0), prefix: "- "), "- ", 0, 2)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "one\n", range: NSRange(location: 4, length: 0), prefix: "- "), "one\n- ", 4, 2)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "one\ntwo", range: NSRange(location: 5, length: 0), prefix: "1. "), "one\n1. two", 4, 6)
    }

    func testToggleLinePrefixRoundTripsToolbarPrefixesAndBlankLines() {
        for prefix in ["# ", "## ", "### ", "1. ", "- [ ] ", "> "] {
            let added = MarkdownTools.toggleLinePrefix(text: "one\n\ntwo", range: NSRange(location: 0, length: 8), prefix: prefix)
            assertEdit(MarkdownTools.toggleLinePrefix(text: added.text, range: added.selection, prefix: prefix), "one\n\ntwo", 0, 8)
        }
    }

    func testToggleLinePrefixReplacesOldHeadingLevel() {
        assertEdit(MarkdownTools.toggleLinePrefix(text: "# Title", range: NSRange(location: 3, length: 0), prefix: "### "), "### Title", 0, 9)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "### Title", range: NSRange(location: 0, length: 9), prefix: "### "), "Title", 0, 5)
        let text = "# One\n## Two\nPlain"
        let result = MarkdownTools.toggleLinePrefix(text: text, range: NSRange(location: 0, length: (text as NSString).length), prefix: "## ")
        assertEdit(result, "## One\n## Two\n## Plain", 0, 22)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "#hashtag", range: NSRange(location: 0, length: 0), prefix: "## "), "## #hashtag", 0, 11)
    }

    func testToggleLinePrefixUsesUTF16AndPreservesCRLF() {
        assertEdit(MarkdownTools.toggleLinePrefix(text: "😀\n甲🧑‍💻\n乙", range: NSRange(location: 4, length: 5), prefix: "> "), "😀\n> 甲🧑‍💻\n乙", 3, 8)
        assertEdit(MarkdownTools.toggleLinePrefix(text: "one\r\ntwo\r\nthree", range: NSRange(location: 1, length: 9), prefix: "- "), "- one\r\n- two\r\nthree", 0, 12)
    }

    func testMakeTableIncludesHeaderInRowCount() {
        XCTAssertEqual(MarkdownTools.makeTable(cols: 3, rows: 2), "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|   |   |   |")
        XCTAssertEqual(MarkdownTools.makeTable(cols: 1, rows: 1), "| Column 1 |\n| --- |")
    }

    func testMakeTableDefaultsAndLimits() {
        let maximum = MarkdownTools.makeTable(cols: Int.max, rows: Int.max).components(separatedBy: "\n")
        XCTAssertEqual(maximum.count, 31)
        XCTAssertEqual(maximum[0].components(separatedBy: "|").count, 12)
        XCTAssertEqual(MarkdownTools.makeTable(cols: 0, rows: 0).components(separatedBy: "\n").count, 4)
        XCTAssertEqual(MarkdownTools.makeTable(cols: 0, rows: 0), MarkdownTools.makeTable(cols: 3, rows: 3))
        XCTAssertEqual(MarkdownTools.makeTable(cols: Int.min, rows: Int.min), MarkdownTools.makeTable(cols: 1, rows: 1))
    }

    func testSafeImageNameKeepsChineseAndExtension() {
        let date = Date(timeIntervalSince1970: 0.123)
        XCTAssertEqual(MarkdownTools.safeImageName("我的 圖片.PNG", date: date), "我的-圖片-123.PNG")
        XCTAssertEqual(MarkdownTools.safeImageName("a/b/../hello world.jpeg", date: date), "hello-world-123.jpeg")
        XCTAssertEqual(MarkdownTools.safeImageName(#"C:\photos\我的 圖片.PNG"#, date: date), "我的-圖片-123.PNG")
        XCTAssertEqual(MarkdownTools.safeImageName(" []?#.png", date: date), "image-123.png")
        XCTAssertEqual(MarkdownTools.safeImageName("paste.png", date: date), "paste-123.png")
        XCTAssertEqual(MarkdownTools.safeImageName("", date: date), "image-123")
        XCTAssertEqual(MarkdownTools.safeImageName("無副檔名", date: date), "無副檔名-123")
        XCTAssertEqual(MarkdownTools.safeImageName("a)(<script>\".svg", date: date), "a-script-123.svg")
    }

    func testSafeImageNameNormalizesAndLimitsStem() {
        let date = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(MarkdownTools.safeImageName("ＡＢＣ １２.png", date: date), "ABC-12-0.png")
        XCTAssertEqual(MarkdownTools.safeImageName(String(repeating: "中", count: 120) + ".jpg", date: date), String(repeating: "中", count: 100) + "-0.jpg")
        XCTAssertEqual(MarkdownTools.safeImageName(String(repeating: "a", count: 99) + "𠮷.png", date: date), String(repeating: "a", count: 99) + "-0.png")
    }

    func testSafeImageNameUsesMilliseconds() {
        let date = Date(timeIntervalSince1970: 1_700_000_000.123)
        XCTAssertEqual(MarkdownTools.safeImageName("photo.jpg", date: date), "photo-1700000000123.jpg")
        let before = Int64((Date().timeIntervalSince1970 * 1_000).rounded())
        let name = MarkdownTools.safeImageName("photo")
        let after = Int64((Date().timeIntervalSince1970 * 1_000).rounded())
        let milliseconds = Int64(name.dropFirst("photo-".count))
        XCTAssertNotNil(milliseconds)
        if let milliseconds { XCTAssertTrue((before...after).contains(milliseconds)) }
    }

    func testImageNameCollisionAttempts() {
        XCTAssertEqual(MarkdownTools.imageName("我的-123.PNG", attempt: 1), "我的-123.PNG")
        XCTAssertEqual(MarkdownTools.imageName("我的-123.PNG", attempt: 2), "我的-123-2.PNG")
        XCTAssertEqual(MarkdownTools.imageName("我的-123.PNG", attempt: 12), "我的-123-12.PNG")
        XCTAssertEqual(MarkdownTools.imageName("photo.part.jpeg", attempt: 3), "photo.part-3.jpeg")
        XCTAssertEqual(MarkdownTools.imageName("photo", attempt: 2), "photo-2")
        let safe = MarkdownTools.safeImageName("我的 圖片.PNG", date: Date(timeIntervalSince1970: 0.123))
        XCTAssertEqual(MarkdownTools.imageName(safe, attempt: 2), "我的-圖片-123-2.PNG")
    }

    func testExpandSnippetSelectsFirstNumberedPlaceholder() {
        assertEdit(MarkdownTools.expandSnippet(#"\frac{${1:a}}{${2:b}}$0"#), #"\frac{a}{b}"#, 6, 1)
        assertEdit(MarkdownTools.expandSnippet("${2:second} ${1:first}$0"), "second first", 7, 5)
        assertEdit(MarkdownTools.expandSnippet("${1:x} ${1:x} ${2:y}"), "x x y", 0, 1)
        assertEdit(MarkdownTools.expandSnippet("a$2 b${1}c${3:}"), "a bc", 3, 0)
    }

    func testExpandSnippetUsesUTF16() {
        assertEdit(MarkdownTools.expandSnippet("😀 ${1:🧑‍💻} ${2:中文}$0"), "😀 🧑‍💻 中文", 3, 5)
    }

    func testExpandSnippetWithoutPlaceholderSelectsEnd() {
        assertEdit(MarkdownTools.expandSnippet(#"\alpha$0"#), #"\alpha"#, 6, 0)
        assertEdit(MarkdownTools.expandSnippet("😀"), "😀", 2, 0)
        assertEdit(MarkdownTools.expandSnippet("$0 end"), " end", 4, 0)
        assertEdit(MarkdownTools.expandSnippet(""), "", 0, 0)
    }

    func testAllMathTemplatesMatchWebSnippets() {
        let expected: [String: String] = [
            "fraction": #"\frac{${1:a}}{${2:b}}$0"#,
            "sqrt": #"\sqrt{${1:x}}$0"#,
            "power": #"${1:x}^{${2:n}}$0"#,
            "subscript": #"${1:x}_{${2:i}}$0"#,
            "sum": #"\sum_{${1:i=1}}^{${2:n}}$0"#,
            "integral": #"\int_{${1:a}}^{${2:b}} ${3:f(x)}\,dx$0"#,
            "limit": #"\lim_{${1:x} \to ${2:\infty}}$0"#,
            "matrix": #"\begin{pmatrix} ${1:a} & ${2:b} \\ ${3:c} & ${4:d} \end{pmatrix}$0"#,
            "aligned": #"\begin{aligned} ${1:a} &= ${2:b} \\ ${3:c} &= ${4:d} \end{aligned}$0"#,
            "alpha": #"\alpha$0"#, "beta": #"\beta$0"#, "gamma": #"\gamma$0"#,
            "delta": #"\delta$0"#, "epsilon": #"\epsilon$0"#, "theta": #"\theta$0"#,
            "lambda": #"\lambda$0"#, "mu": #"\mu$0"#, "pi": #"\pi$0"#,
            "sigma": #"\sigma$0"#, "phi": #"\phi$0"#, "omega": #"\omega$0"#,
        ]
        XCTAssertEqual(MarkdownTools.mathTemplates.count, 21)
        XCTAssertEqual(MarkdownTools.mathTemplates, expected)
        for snippet in MarkdownTools.mathTemplates.values {
            XCTAssertTrue(snippet.hasSuffix("$0"))
            let expanded = MarkdownTools.expandSnippet(snippet)
            XCTAssertFalse(expanded.text.contains("${"))
            XCTAssertFalse(expanded.text.contains("$0"))
            XCTAssertLessThanOrEqual(NSMaxRange(expanded.selection), (expanded.text as NSString).length)
        }
        XCTAssertEqual(MarkdownTools.expandSnippet(expected["matrix"]!).text, #"\begin{pmatrix} a & b \\ c & d \end{pmatrix}"#)
        XCTAssertEqual(MarkdownTools.expandSnippet(expected["aligned"]!).text, #"\begin{aligned} a &= b \\ c &= d \end{aligned}"#)
        XCTAssertEqual(MarkdownTools.expandSnippet(expected["limit"]!).text, #"\lim_{x \to \infty}"#)
    }

    func testAllMermaidTemplatesMatchWebSources() {
        let expected = [
            "flowchart": "flowchart TD\n    A[Start] --> B[End]",
            "sequence": "sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hello",
            "gantt": "gantt\n    title Schedule\n    dateFormat YYYY-MM-DD\n    section Tasks\n    Task :a1, 2026-01-01, 1d",
            "pie": "pie title Distribution\n    \"Group A\" : 60\n    \"Group B\" : 40",
            "class": "classDiagram\n    class Item {\n        +String name\n    }",
        ]
        XCTAssertEqual(MarkdownTools.mermaidTemplates.count, 5)
        XCTAssertEqual(MarkdownTools.mermaidTemplates, expected)
        let starts = ["flowchart": "flowchart TD\n", "sequence": "sequenceDiagram\n", "gantt": "gantt\n", "pie": "pie title ", "class": "classDiagram\n"]
        for (key, snippet) in MarkdownTools.mermaidTemplates {
            XCTAssertTrue(snippet.hasPrefix(starts[key]!))
            assertEdit(MarkdownTools.expandSnippet(snippet), snippet, (snippet as NSString).length, 0)
        }
    }
}
