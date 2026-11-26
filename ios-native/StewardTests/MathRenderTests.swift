import UIKit
import XCTest
@testable import Steward

@MainActor final class MathRenderTests: XCTestCase {
    private var originalFallback: (@MainActor (String, CGFloat, Bool, Bool) -> Markdown.MathRender?)?

    override func setUp() async throws {
        try await super.setUp()
        originalFallback = Markdown.mathFallback
    }

    override func tearDown() async throws {
        if let originalFallback { Markdown.mathFallback = originalFallback }
        originalFallback = nil
        try await super.tearDown()
    }

    func testDoubleIntegralRendersWithSwiftMath() {
        Markdown.mathFallback = { latex, _, _, _ in
            XCTFail("SwiftMath 應可排版: \(latex)")
            return nil
        }
        for latex in [#"\iint f\,dx\,dt"#, #"\iiint f"#] {
            XCTAssertNotNil(Markdown.render(latex, size: 17, display: true, dark: false), latex)
        }
    }

    func testWholeReplyEveryFormulaRenders() {
        let source = #"""
        ## 分解式

        $$E_D[L] = \underbrace{\text{noise}}_{\text{資料雜訊}} + \underbrace{\text{bias}^2}_{\text{modeling error}}$$

        - 內層 $\displaystyle\int \{h(\mathbf{x})-t\}^2 p(t\mid\mathbf{x})\,dt$:固定一個 $\mathbf{x}$
        - 合起來是 $\iint f(\mathbf{x},t)\,d\mathbf{x}\,dt$

        > 記法:$\mathbb{E}_{\mathbf{x},t}[f]$ 的下標有 $\text{兩個}$ 東西

        | 項 | 式子 |
        |---|---|
        | 權重 | $\alpha_t=\frac12\ln\frac{1-\epsilon_t}{\epsilon_t}$ |
        """#
        var formulas: [(latex: String, display: Bool)] = []
        for block in Markdown.blocks(source) {
            switch block {
            case .math(let latex):
                formulas.append((latex, true))
            case .text(let text), .heading(let text), .quote(let text):
                formulas += Markdown.extractMath(text).1.map { ($0, false) }
            case .table(let rows):
                for cell in rows.flatMap({ $0 }) {
                    formulas += Markdown.extractMath(cell).1.map { ($0, false) }
                }
            case .code:
                break
            }
        }
        XCTAssertEqual(formulas.count, 7)
        var fallbackLatex: [String] = []
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }
        Markdown.mathFallback = { latex, _, _, _ in
            fallbackLatex.append(latex)
            return Markdown.MathRender(image: image, descent: 0)
        }
        for formula in formulas {
            XCTAssertNotNil(Markdown.render(formula.latex, size: 17, display: formula.display, dark: false), formula.latex)
        }
        let expectedFallback = [
            #"E_D[L] = \underbrace{\text{noise}}_{\text{資料雜訊}} + \underbrace{\text{bias}^2}_{\text{modeling error}}"#,
            #"\text{兩個}"#,
        ]
        XCTAssertEqual(fallbackLatex, expectedFallback)
        XCTAssertFalse(fallbackLatex.contains { $0.contains(#"\iint"#) })
    }

    func testKaTeXRendersUnsupportedFormula() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: URL(string: "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js")!)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 5
        let response: URLResponse
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            throw XCTSkip("KaTeX CDN 無法連線: \(error.localizedDescription)")
        }
        guard let response = response as? HTTPURLResponse, (200..<400).contains(response.statusCode) else {
            throw XCTSkip("KaTeX CDN 未回傳成功狀態")
        }

        let deadline = Date().addingTimeInterval(20)
        var result: Markdown.MathRender?
        repeat {
            result = KaTeXMath.shared.image(#"\underbrace{x}_{\text{資料雜訊}}"#, size: 17, display: true, dark: false)
            if result != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        } while Date() < deadline
        let rendered = try XCTUnwrap(result, "KaTeX 應在 20 秒內排好圖片")
        XCTAssertGreaterThan(rendered.image.size.width, 10)
        XCTAssertGreaterThan(rendered.image.size.height, 10)
        let attachment = XCTAttachment(image: rendered.image)
        attachment.name = "katex-sample"
        attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertTrue(Self.hasInk(rendered.image), "KaTeX 截圖不應是空白")
    }

    /// 圖片裡有沒有不透明的像素(排版結果不是一張全透明的空白圖)
    private static func hasInk(_ image: UIImage) -> Bool {
        guard let cg = image.cgImage else { return false }
        let w = cg.width, h = cg.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] > 128 }
    }
}
