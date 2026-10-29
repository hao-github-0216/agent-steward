// 管家的回答是 Markdown。第一版:程式區塊用等寬灰底框,標題加粗,其他段落用系統的行內 Markdown
// (粗體、斜體、行內程式、連結)。表格和數學式先照原文顯示。
import SwiftUI

enum Markdown {
    enum Block: Hashable {
        case text(String)
        case heading(String)
        case code(String)
        case quote(String)
    }

    /// fixEscapes:管家整理的專案狀態偶爾把換行存成字面上的 \n,當成真的換行。
    /// 只用在專案狀態;對話裡的 \neq、\nabla 這類數學式不能動。
    static func blocks(_ src: String, fixEscapes: Bool = false) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var code: [String]? = nil
        func flush() {
            let t = para.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !t.isEmpty { out.append(.text(t)) }
            para = []
        }
        let src = fixEscapes ? src.replacingOccurrences(of: "\\n", with: "\n") : src
        var quote: [String] = []
        func flushQuote() {
            if !quote.isEmpty { out.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }
        for line in src.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let c = code {
                    out.append(.code(c.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    flushQuote()
                    code = []
                }
                continue
            }
            if code != nil { code!.append(line); continue }
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
            if trimmed.isEmpty { flush(); continue }
            if trimmed == "---" || trimmed == "***" { flush(); continue }
            para.append(line)
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flush()
        flushQuote()
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
}

struct MarkdownText: View {
    let source: String
    var fixEscapes = false
    init(_ source: String, fixEscapes: Bool = false) { self.source = source; self.fixEscapes = fixEscapes }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Markdown.blocks(source, fixEscapes: fixEscapes).enumerated()), id: \.offset) { _, b in
                switch b {
                case .text(let t):
                    Text(Markdown.inline(t))
                case .heading(let h):
                    Text(Markdown.inline(h)).font(.headline)
                case .quote(let q):
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1.5).fill(Color.orange.opacity(0.6)).frame(width: 3)
                        Text(Markdown.inline(q)).foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                case .code(let c):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(c)
                            .font(.system(.footnote, design: .monospaced))
                            .padding(10)
                    }
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .textSelection(.enabled)
    }
}
