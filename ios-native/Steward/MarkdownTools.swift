import Foundation

enum MarkdownTools {
    // 選取範圍以 UTF-16 計算，與文字編輯器的 NSRange 一致。
    static func toggleWrap(text: String, range: NSRange, marker: String) -> (text: String, selection: NSRange) {
        let source = text as NSString
        let size = (marker as NSString).length
        let start = range.location
        let end = NSMaxRange(range)
        if start >= size, end + size <= source.length,
           source.substring(with: NSRange(location: start - size, length: size)) == marker,
           source.substring(with: NSRange(location: end, length: size)) == marker {
            let result = source.substring(to: start - size) + source.substring(with: range) + source.substring(from: end + size)
            return (result, NSRange(location: start - size, length: range.length))
        }
        if range.length >= size * 2,
           source.substring(with: NSRange(location: start, length: size)) == marker,
           source.substring(with: NSRange(location: end - size, length: size)) == marker {
            let content = source.substring(with: NSRange(location: start + size, length: range.length - size * 2))
            return (source.substring(to: start) + content + source.substring(from: end),
                    NSRange(location: start, length: range.length - size * 2))
        }
        return (source.substring(to: start) + marker + source.substring(with: range) + marker + source.substring(from: end),
                NSRange(location: start + size, length: range.length))
    }

    static func toggleLinePrefix(text: String, range: NSRange, prefix: String) -> (text: String, selection: NSRange) {
        let source = text as NSString
        var start = 0
        var end = 0
        source.getLineStart(&start, end: nil, contentsEnd: nil, for: NSRange(location: range.location, length: 0))
        // 選取終點若在下一行開頭，只處理前一行。
        let last = range.length > 0 ? NSMaxRange(range) - 1 : range.location
        source.getLineStart(nil, end: nil, contentsEnd: &end, for: NSRange(location: last, length: 0))
        let lines = source.substring(with: NSRange(location: start, length: end - start)).components(separatedBy: "\n")
        let remove = lines.allSatisfy { $0.hasPrefix(prefix) }
        let heading = prefix.range(of: #"^#{1,6} $"#, options: .regularExpression) != nil
        let replacement = lines.map { line in
            if remove { return (line as NSString).substring(from: (prefix as NSString).length) }
            let content = heading ? line.replacingOccurrences(of: #"^#{1,6}[ \t]+"#, with: "", options: .regularExpression) : line
            return prefix + content
        }.joined(separator: "\n")
        return (source.replacingCharacters(in: NSRange(location: start, length: end - start), with: replacement),
                NSRange(location: start, length: (replacement as NSString).length))
    }

    static func makeTable(cols: Int, rows: Int) -> String {
        let cols = max(1, min(10, cols == 0 ? 3 : cols))
        let rows = max(1, min(30, rows == 0 ? 3 : rows))
        func row(_ cells: [String]) -> String { "| " + cells.joined(separator: " | ") + " |" }
        return ([row((1...cols).map { "Column \($0)" }), row(Array(repeating: "---", count: cols))]
                + Array(repeating: row(Array(repeating: " ", count: cols)), count: rows - 1)).joined(separator: "\n")
    }

    static func safeImageName(_ name: String, date: Date = Date()) -> String {
        let base = name.components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? ""
        let extRange = (base as NSString).range(of: #"\.[a-zA-Z0-9]+$"#, options: .regularExpression)
        let ext = extRange.location == NSNotFound ? "" : (base as NSString).substring(with: extRange)
        let rawStem = extRange.location == NSNotFound ? base : (base as NSString).substring(to: extRange.location)
        let normalized = rawStem.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"[^\p{L}\p{N}_-]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        // 最多保留 100 個 UTF-16 碼元，不切斷非基本平面字元。
        var stem = ""
        var length = 0
        for scalar in normalized.unicodeScalars {
            let size = scalar.value > 0xFFFF ? 2 : 1
            guard length + size <= 100 else { break }
            stem.unicodeScalars.append(scalar)
            length += size
        }
        let milliseconds = Int64((date.timeIntervalSince1970 * 1_000).rounded())
        return "\(stem.isEmpty ? "image" : stem)-\(milliseconds)\(ext)"
    }

    static func imageName(_ name: String, attempt: Int) -> String {
        guard attempt > 1 else { return name }
        let source = name as NSString
        let dot = source.range(of: ".", options: .backwards)
        guard dot.location != NSNotFound else { return "\(name)-\(attempt)" }
        return source.substring(to: dot.location) + "-\(attempt)" + source.substring(from: dot.location)
    }

    static func expandSnippet(_ snippet: String) -> (text: String, selection: NSRange) {
        let source = snippet as NSString
        let placeholders = try! NSRegularExpression(pattern: #"\$\{(\d+)(?::([^}]*))?\}|\$(\d+)"#)
        var text = ""
        var from = 0
        var firstNumber = Int.max
        var selection: NSRange?
        for match in placeholders.matches(in: snippet, range: NSRange(location: 0, length: source.length)) {
            text += source.substring(with: NSRange(location: from, length: match.range.location - from))
            let numberRange = match.range(at: 1).location == NSNotFound ? match.range(at: 3) : match.range(at: 1)
            let number = Int(source.substring(with: numberRange)) ?? 0
            let valueRange = match.range(at: 2)
            let value = valueRange.location == NSNotFound ? "" : source.substring(with: valueRange)
            if number > 0, number < firstNumber {
                firstNumber = number
                selection = NSRange(location: (text as NSString).length, length: (value as NSString).length)
            }
            text += value
            from = NSMaxRange(match.range)
        }
        text += source.substring(from: from)
        return (text, selection ?? NSRange(location: (text as NSString).length, length: 0))
    }

    static let mathTemplates: [String: String] = [
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

    static let mermaidTemplates: [String: String] = [
        "flowchart": "flowchart TD\n    A[Start] --> B[End]",
        "sequence": "sequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hello",
        "gantt": "gantt\n    title Schedule\n    dateFormat YYYY-MM-DD\n    section Tasks\n    Task :a1, 2026-01-01, 1d",
        "pie": "pie title Distribution\n    \"Group A\" : 60\n    \"Group B\" : 40",
        "class": "classDiagram\n    class Item {\n        +String name\n    }",
    ]
}
