// 管家的回答是 Markdown(管家提問時會告訴模型這個對話框支援哪些格式)。
// 支援:段落裡的粗體/斜體/行內程式/連結、小標題、引用、程式區塊、表格、數學式
// (行內 $…$、\(…\);獨立一行 $$…$$、\[…\],用 SwiftMath 在手機上直接排版,不經網頁)。
import SwiftMath
import SwiftUI
import UIKit

enum Markdown {
    enum Block: Hashable {
        case text(String)
        case heading(String)
        case code(String)
        case quote(String)
        case math(String)
        case table([[String]])
    }

    /// fixEscapes:管家整理的專案狀態偶爾把換行存成字面上的 \n,當成真的換行。
    /// 只用在專案狀態;對話裡的 \neq、\nabla 這類數學式不能動。
    static func blocks(_ src: String, fixEscapes: Bool = false) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var code: [String]? = nil
        var math: [String]? = nil
        var mathClose = "$$"
        var quote: [String] = []
        var table: [String] = []
        func flush() {
            let t = para.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !t.isEmpty { out.append(.text(t)) }
            para = []
        }
        func flushQuote() {
            if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        func flushTable() {
            guard !table.isEmpty else { return }
            let rows = table
                .filter { !$0.replacingOccurrences(of: " ", with: "").allSatisfy { "|-:".contains($0) } } // 去掉 |---|:--| 分隔列
                .map { row -> [String] in
                    var r = row.trimmingCharacters(in: .whitespaces)
                    if r.hasPrefix("|") { r.removeFirst() }
                    if r.hasSuffix("|") { r.removeLast() }
                    return r.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                }
            if !rows.isEmpty { out.append(.table(rows)) }
            table = []
        }
        func flushAll() { flush(); flushQuote(); flushTable() }

        let src = fixEscapes ? src.replacingOccurrences(of: "\\n", with: "\n") : src
        lines: for line in src.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // 程式區塊
            if trimmed.hasPrefix("```") {
                if let c = code {
                    out.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    flushAll()
                    code = []
                }
                continue
            }
            if code != nil { code!.append(line); continue }
            // 獨立一行的數學式:$$ … $$ 或 \[ … \],可以寫在同一行或跨好幾行
            if var m = math {
                if trimmed.hasSuffix(mathClose) {
                    m.append(String(trimmed.dropLast(mathClose.count)))
                    out.append(.math(m.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)))
                    math = nil
                } else {
                    m.append(line)
                    math = m
                }
                continue
            }
            for (open, close) in [("$$", "$$"), ("\\[", "\\]")] where trimmed.hasPrefix(open) {
                flushAll()
                let rest = String(trimmed.dropFirst(open.count))
                if rest.count >= close.count && rest.hasSuffix(close) {
                    out.append(.math(String(rest.dropLast(close.count)).trimmingCharacters(in: .whitespaces)))
                } else {
                    math = [rest]
                    mathClose = close
                }
                continue lines
            }
            // 表格
            if trimmed.hasPrefix("|") {
                flush(); flushQuote()
                table.append(trimmed)
                continue
            }
            flushTable()
            // 引用
            if trimmed.hasPrefix(">") {
                flush()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            flushQuote()
            if trimmed.hasPrefix("#") {
                let h = trimmed.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                if !h.isEmpty { flush(); out.append(.heading(h)); continue }
            }
            if trimmed.isEmpty || trimmed == "---" || trimmed == "***" { flush(); continue }
            para.append(line)
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flushAll()
        if let m = math { out.append(.text("$$" + m.joined(separator: "\n"))) } // 沒有收尾:照原文
        return out
    }

    static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }

    /// 列表裡的一兩行摘要:拿掉 Markdown 記號
    static func plain(_ s: String) -> String {
        String(inline(s.replacingOccurrences(of: "\n", with: " ")).characters)
    }

    // MARK: 行內數學式

    /// 找出 $…$ 和 \(…\),換成佔位字元(U+E000 起)。
    /// $ 後面緊接空白或數字的不算(避免「$5 和 $10」被當成數學式);\$ 是真的錢字號
    static func extractMath(_ s: String) -> (String, [String]) {
        var formulas: [String] = []
        var out = ""
        var i = s.startIndex
        func add(_ f: Substring) {
            formulas.append(String(f))
            out.unicodeScalars.append(UnicodeScalar(0xE000 + formulas.count - 1)!)
        }
        while i < s.endIndex {
            let rest = s[i...]
            if rest.hasPrefix("\\("), let end = rest.range(of: "\\)") {
                let body = s[s.index(i, offsetBy: 2)..<end.lowerBound]
                if !body.isEmpty { add(body); i = end.upperBound; continue }
            }
            if rest.hasPrefix("\\$") {
                out.append("$")
                i = s.index(i, offsetBy: 2)
                continue
            }
            if s[i] == "$", !rest.hasPrefix("$$") {
                let start = s.index(after: i)
                if start < s.endIndex, !s[start].isWhitespace, !s[start].isNumber,
                   let close = s[start...].firstIndex(of: "$"), close > start,
                   !s[s.index(before: close)].isWhitespace,
                   !s[start..<close].contains("\n") {
                    add(s[start..<close])
                    i = s.index(after: close)
                    continue
                }
            }
            out.append(s[i])
            i = s.index(after: i)
        }
        return (out, formulas)
    }

    final class MathRender {
        let image: UIImage
        let descent: CGFloat
        init(image: UIImage, descent: CGFloat) { self.image = image; self.descent = descent }
    }

    private static let cache = NSCache<NSString, MathRender>()

    /// SwiftMath 不認得的常見寫法,換成它認得的等價寫法(實際查過它的指令表)
    private static let rewrites: [(NSRegularExpression, String)] = [
        (#"\\dots[cbmio]?(?![a-zA-Z])"#, #"\\ldots "#),
        (#"\\[dt]frac(?![a-zA-Z])"#, #"\\frac"#),
        (#"\\boldsymbol(?![a-zA-Z])"#, #"\\mathbf"#),
        (#"\\operatorname\*?\{([^}]*)\}"#, #"\\mathrm{$1}"#),
        (#"\\arg(max|min)(?![a-zA-Z])"#, #"\\mathrm{arg$1}"#),
        (#"\\[lr]Vert(?![a-zA-Z])"#, #"\\Vert "#),
        (#"\\[lr]vert(?![a-zA-Z])"#, "|"),
        (#"\\(big|Big|bigg|Bigg)[lrm]?(?![a-zA-Z])"#, ""), // 括號大小:拿掉,括號照樣顯示
        (#"\\middle(?![a-zA-Z])"#, ""),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    static func normalize(_ latex: String) -> String {
        var s = latex
        for (re, to) in rewrites {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: to)
        }
        return s
    }

    /// 把一個數學式排成圖;排不出來(不支援的指令)回 nil,呼叫的人改顯示原文
    static func render(_ latex: String, size: CGFloat, display: Bool, dark: Bool) -> MathRender? {
        let key = "\(display ? "D" : "T")|\(size)|\(dark ? "d" : "l")|\(latex)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let color = UIColor.label.resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var m = MathImage(latex: normalize(latex), fontSize: size, textColor: color, labelMode: display ? .display : .text, textAlignment: .left)
        let (err, img, layout) = m.asImage()
        guard err == nil, let img, img.size.width > 0 else { return nil }
        let r = MathRender(image: img, descent: layout?.descent ?? 0)
        cache.setObject(r, forKey: key)
        return r
    }

    /// 一段文字(可能夾著數學式)→ 一個 Text:先把數學式換成佔位字元再解析 Markdown,
    /// 「**$x_i$ 的角色**」這種粗體裡夾數學式的才不會壞掉
    static func text(_ s: String, size: CGFloat, dark: Bool) -> Text {
        let (masked, formulas) = extractMath(s)
        let attr = inline(masked)
        guard !formulas.isEmpty else { return Text(attr) }
        var result = Text("")
        for run in attr.runs {
            var buf = ""
            func emitBuf() {
                guard !buf.isEmpty else { return }
                let t = Text(AttributedString(buf, attributes: run.attributes))
                result = Text("\(result)\(t)")
                buf = ""
            }
            for scalar in String(attr[run.range].characters).unicodeScalars {
                let n = Int(scalar.value) - 0xE000
                if n >= 0, n < formulas.count {
                    emitBuf()
                    if let r = render(formulas[n], size: size, display: false, dark: dark) {
                        let img = Text(Image(uiImage: r.image)).baselineOffset(-r.descent)
                        result = Text("\(result)\(img)")
                    } else {
                        let raw = Text("$\(formulas[n])$").font(.system(size: size * 0.9, design: .monospaced))
                        result = Text("\(result)\(raw)")
                    }
                } else {
                    buf.unicodeScalars.append(scalar)
                }
            }
            emitBuf()
        }
        return result
    }
}

struct MarkdownText: View {
    let source: String
    var fixEscapes = false
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 17

    init(_ source: String, fixEscapes: Bool = false) { self.source = source; self.fixEscapes = fixEscapes }

    var body: some View {
        let dark = scheme == .dark
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Markdown.blocks(source, fixEscapes: fixEscapes).enumerated()), id: \.offset) { _, b in
                switch b {
                case .text(let t):
                    Markdown.text(t, size: bodySize, dark: dark)
                case .heading(let h):
                    Markdown.text(h, size: bodySize, dark: dark).font(.headline)
                case .quote(let q):
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1.5).fill(Color.orange.opacity(0.6)).frame(width: 3)
                        Markdown.text(q, size: bodySize, dark: dark).foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case .code(let c):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(c)
                            .font(.system(.footnote, design: .monospaced))
                            .padding(10)
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                case .math(let m):
                    if let r = Markdown.render(m, size: bodySize * 1.1, display: true, dark: dark) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Image(uiImage: r.image).padding(.vertical, 4)
                        }
                        .accessibilityLabel(m)
                    } else {
                        Text("$$\(m)$$").font(.system(.footnote, design: .monospaced))
                    }
                case .table(let rows):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        Markdown.text(cell, size: bodySize * 0.9, dark: dark)
                                            .font(i == 0 ? .subheadline.bold() : .subheadline)
                                            .fixedSize()
                                    }
                                }
                                if i == 0 { Divider() }
                            }
                        }
                        .padding(10)
                    }
                    .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .textSelection(.enabled)
    }
}
