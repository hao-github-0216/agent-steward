// 圈選提問(原生畫面):按圈選鈕 → 畫面凍結 → 手指拉框圈一塊 → 用 Vision 讀出框裡的字 → 小框直接問管家。
// 跟網頁版一樣「文字優先」:讀得到字就送文字(整個畫面的字當周圍內容),讀不到才送截圖。
// 終端機、程式碼頁是管家網頁,它自己的圈選鈕可以用(能分辨是哪個 agent 窗格、交給那個 agent)。
import SwiftUI
import UIKit
import Vision
import WebKit

@MainActor
@Observable
final class SnapState {
    /// 凍結的整個畫面;有值時顯示圈選層
    var screen: UIImage?
    /// 圈好的結果;有值時顯示提問小框
    var result: SnapResult?

    /// 終端機:網頁畫面在視窗裡的位置(圈好後換算成網頁座標拿原文)
    private var webFrame: CGRect?
    /// 終端機:給網頁座標的範圍,回傳那一塊終端機的原文(AppModel 接上 WebStore)
    @ObservationIgnored var terminalText: ((CGRect) async -> String?)?
    /// 程式碼頁每一格顯示的檔案和它在視窗裡的位置(圈選開始時記下來;圈到哪一格就對回哪一格)
    @ObservationIgnored var codeFiles: [(frame: CGRect, path: String, content: String)] = []

    /// web:終端機的網頁畫面。一般截圖截不到網頁內容,另外截下來合成進凍結的畫面
    func begin(web: WKWebView? = nil) {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        let base = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        webFrame = nil
        guard let web, web.window === window, !web.isHidden else { screen = base; return }
        let frame = web.convert(web.bounds, to: window)
        web.takeSnapshot(with: nil) { [weak self] img, _ in
            Task { @MainActor in
                guard let self else { return }
                guard let img else { self.screen = base; return }
                self.webFrame = frame
                self.screen = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    base.draw(at: .zero)
                    img.draw(in: frame)
                }
            }
        }
    }

    func cancel() { screen = nil }

    /// rect 是畫面上的點座標;裁下來、讀字。kind:terminal(終端機,管家會認出是哪個 agent 窗格)或 page
    func finish(_ rect: CGRect, label: String, kind: String = "page") {
        guard let screen, rect.width > 12, rect.height > 12 else { cancel(); return }
        let crop = screen.cropped(to: rect)
        self.screen = nil
        let wf = webFrame
        Task {
            async let inside = Self.ocr(crop)
            async let whole = Self.ocr(screen)
            var (text, around) = await (inside, whole)
            // 圈到終端機:用終端機裡的原文(比文字辨識準,跟網頁版圈選一樣)
            if kind == "terminal", let wf, rect.intersects(wf), let exact = await terminalText?(rect.intersection(wf).offsetBy(dx: -wf.minX, dy: -wf.minY)), !exact.isEmpty {
                text = exact
            }
            var r = SnapResult(image: crop, text: text, context: around, label: label, kind: kind)
            // 圈到程式碼:讀到的字對回檔案的行號,改用檔案原文 + 前後 30 行(跟網頁版圈選一樣)
            // 圈的範圍跨好幾格:以重疊最多的那一格為準
            let f = codeFiles.max { a, b in
                let ia = a.frame.intersection(rect), ib = b.frame.intersection(rect)
                return (ia.isNull ? 0 : ia.width * ia.height) < (ib.isNull ? 0 : ib.width * ib.height)
            }
            if kind == "code", let f, !f.frame.intersection(rect).isNull, let m = Self.matchLines(ocr: text, in: f.content) {
                let lines = f.content.components(separatedBy: "\n")
                r.text = lines[(m.from - 1)...(m.to - 1)].joined(separator: "\n")
                r.path = f.path
                r.from = m.from
                r.to = m.to
                r.label = "\(f.path) 第 \(m.from)\(m.to != m.from ? "–\(m.to)" : "") 行"
                let a = max(0, m.from - 31), b = min(lines.count, m.to + 30)
                r.context = lines[a..<b].enumerated().map { "\(a + $0.offset + 1): \($0.element)" }.joined(separator: "\n")
            } else if kind == "code" {
                r.kind = "page"
            }
            result = r
        }
    }

    /// 圈到的字 → 檔案的第幾行到第幾行:先看行首的行號(檢視模式左邊有行號),
    /// 沒有就拿那一行的文字去檔案裡找(編輯模式沒有行號)
    nonisolated static func matchLines(ocr: String, in content: String) -> (from: Int, to: Int)? {
        let lines = content.components(separatedBy: "\n")
        let norm = { (s: String) in s.filter { !$0.isWhitespace } }
        let normLines = lines.map(norm)
        var hits: [Int] = []
        for raw in ocr.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            // 行首是行號:「12 import SwiftUI」或只有「12」
            let head = t.prefix { $0.isNumber }
            if let n = Int(head), n >= 1, n <= lines.count {
                let rest = norm(String(t.dropFirst(head.count)))
                if rest.isEmpty || normLines[n - 1].contains(rest.prefix(12)) || rest.count < 4 { hits.append(n); continue }
            }
            // 拿文字去找(至少 6 個字,免得太常見的短字亂對)
            let key = norm(t)
            if key.count >= 6, let i = normLines.firstIndex(where: { $0.contains(key) || (key.count > 12 && $0.contains(key.prefix(12))) }) {
                hits.append(i + 1)
            }
        }
        guard let lo = hits.min(), let hi = hits.max(), hi - lo < 400 else { return nil }
        return (lo, hi)
    }

    /// iPhone 內建的文字辨識(繁中、簡中、英文),照閱讀順序接起來
    nonisolated static func ocr(_ image: UIImage) async -> String {
        guard let cg = image.cgImage else { return "" }
        return await withCheckedContinuation { cont in
            let req = VNRecognizeTextRequest { req, _ in
                let lines = (req.results as? [VNRecognizedTextObservation] ?? [])
                    .sorted { a, b in
                        // 由上而下、同一行由左而右(Vision 的 y 軸朝上)
                        abs(a.boundingBox.midY - b.boundingBox.midY) > 0.01 ? a.boundingBox.midY > b.boundingBox.midY : a.boundingBox.minX < b.boundingBox.minX
                    }
                    .compactMap { $0.topCandidates(1).first?.string }
                cont.resume(returning: lines.joined(separator: "\n"))
            }
            req.recognitionLevel = .accurate
            req.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"]
            req.usesLanguageCorrection = true
            do { try VNImageRequestHandler(cgImage: cg, orientation: .up).perform([req]) } catch { cont.resume(returning: "") }
        }
    }
}

struct SnapResult: Identifiable {
    let id = UUID()
    let image: UIImage
    var text: String
    var context: String
    var label: String
    var kind = "page"
    /// 程式碼:檔案路徑和第幾行到第幾行
    var path: String?
    var from: Int?
    var to: Int?
}

extension UIImage {
    /// 用點座標裁切(會換算成像素)
    func cropped(to rect: CGRect) -> UIImage {
        let px = CGRect(x: rect.minX * scale, y: rect.minY * scale, width: rect.width * scale, height: rect.height * scale).integral
        guard let cg = cgImage?.cropping(to: px) else { return self }
        return UIImage(cgImage: cg, scale: scale, orientation: imageOrientation)
    }
}

/// 圈選層:凍結的畫面變暗,手指拉框;放開就圈好。
/// 截圖、變暗、選框鋪滿整個螢幕(座標跟截圖一致);提示和「取消」放在安全區域裡,不會被瀏海/動態島擋住
struct SnapOverlay: View {
    let screen: UIImage
    let onDone: (CGRect) -> Void
    let onCancel: () -> Void
    @State private var start: CGPoint?
    @State private var current: CGPoint?

    private var rect: CGRect? {
        guard let start, let current else { return nil }
        return CGRect(x: min(start.x, current.x), y: min(start.y, current.y), width: abs(current.x - start.x), height: abs(current.y - start.y))
    }

    var body: some View {
        ZStack {
            Image(uiImage: screen).resizable().ignoresSafeArea()
            // 變暗 + 挖出選框 + 虛線框:一張 Canvas 畫,座標就是整個螢幕的點座標(跟拖拉手勢的 global 座標一致)
            Canvas { ctx, size in
                ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black.opacity(0.35)))
                if let rect {
                    ctx.blendMode = .clear
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 6), with: .color(.black))
                    ctx.blendMode = .normal
                    ctx.stroke(Path(roundedRect: rect, cornerRadius: 6), with: .color(.orange), style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            Color.clear
                .contentShape(Rectangle())
                .ignoresSafeArea()
                .gesture(
                    DragGesture(minimumDistance: 4, coordinateSpace: .global)
                        .onChanged { v in
                            if start == nil { start = v.startLocation }
                            current = v.location
                        }
                        .onEnded { _ in
                            if let rect { onDone(rect) } else { onCancel() }
                            start = nil; current = nil
                        }
                )
        }
        .overlay(alignment: .top) {
            HStack {
                Text("拉一個框圈出要問的地方").font(.subheadline)
                Button("取消", action: onCancel).buttonStyle(.bordered)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
            .padding(.top, 8)
            .opacity(start == nil ? 1 : 0) // 拉框的時候先藏起來,不擋到要圈的地方
            .animation(.easeOut(duration: 0.15), value: start == nil)
        }
        .accessibilityAddTraits(.isModal)
    }
}

/// 圈好之後的提問視窗(Apple 樣式:系統清單 + iMessage 式輸入列)
struct SnapSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let snap: SnapResult
    @State private var projectId: String
    @State private var question = ""
    @State private var turns: [(q: String, a: String, error: Bool)] = []
    @State private var busy = false
    @State private var showText = false
    /// 管家認出來圈的是哪個 agent 窗格(終端機才有)
    @State private var pane: SnapPane?
    @State private var info: String?
    @FocusState private var inputFocused: Bool

    private static let quick: [(String, String, String)] = [
        ("解釋", "lightbulb", "解釋這段內容"),
        ("翻譯", "character.book.closed", "把這段翻譯成繁體中文;如果本來就是中文,翻成英文"),
        ("找錯", "ladybug", "這裡有什麼錯誤或問題?說明原因和怎麼修"),
    ]

    init(snap: SnapResult, projectId: String) {
        self.snap = snap
        _projectId = State(initialValue: projectId)
    }

    private var hasText: Bool { !snap.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var lastAnswer: String? { turns.last(where: { !$0.error })?.a }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Image(uiImage: snap.image)
                        .resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .listRowInsets(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10))
                    DisclosureGroup(isExpanded: $showText) {
                        Text(hasText ? snap.text : "沒有讀到文字,會把圈到的圖片送給管家看。")
                            .font(.footnote).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } label: {
                        Label(hasText ? "讀到的文字(\(snap.text.count) 字)" : "沒有讀到文字", systemImage: "text.viewfinder")
                    }
                } footer: {
                    Text(snap.label)
                }
                Section {
                    Picker(selection: $projectId) {
                        ForEach(model.projects) { p in Text(p.name).tag(p.id) }
                    } label: {
                        Label("問哪個專案", systemImage: "folder")
                    }
                    .pickerStyle(.menu)
                    .disabled(busy || !turns.isEmpty)
                }
                if turns.isEmpty {
                    Section("快速問") {
                        ForEach(Self.quick, id: \.0) { q in
                            Button { Task { await ask(q.2, shown: q.0) } } label: { Label(q.0, systemImage: q.1) }
                        }
                        Button { Task { await draft() } } label: { Label("開工作卡", systemImage: "rectangle.stack.badge.plus") }
                    }
                    .disabled(busy)
                }
                ForEach(Array(turns.enumerated()), id: \.offset) { _, t in
                    Section {
                        if t.error { Text(t.a).foregroundStyle(.red) } else { MarkdownText(t.a) }
                    } header: {
                        Text(t.q).textCase(nil)
                    }
                }
                if busy {
                    Section { HStack(spacing: 10) { ProgressView(); Text("管家想一下…").foregroundStyle(.secondary) } }
                }
                if !turns.isEmpty && !busy {
                    Section {
                        if let a = lastAnswer {
                            Button { UIPasteboard.general.string = a; info = "已複製" } label: { Label("複製回答", systemImage: "doc.on.doc") }
                        }
                        if let pane, lastAnswer != nil {
                            Button { Task { await handToAgent(pane) } } label: { Label("交給 \(pane.agent ?? "這個 agent")", systemImage: "arrow.turn.down.right") }
                        }
                        Button {
                            model.switchProject(projectId)
                            model.pendingPresentation = .chat // 圈選視窗收好再打開問管家
                            dismiss()
                        } label: { Label("到問管家繼續", systemImage: "bubble.left.and.text.bubble.right") }
                        Button { Task { await draft() } } label: { Label("開工作卡", systemImage: "rectangle.stack.badge.plus") }
                    } footer: {
                        if let info { Text(info) } else if pane != nil { Text("「交給」會把圈到的內容和管家的建議貼進那個 agent 的輸入框,看過再按 Enter 送出。") }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { inputBar }
            .navigationTitle("圈選提問")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("關閉") { dismiss() } }
            }
        }
    }

    /// iMessage 式的輸入列:寫問題按送出;寫要做的事按「開工作卡」(會照這裡寫的擬工作卡)
    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(turns.isEmpty ? "問這一塊,或寫要做的事(再按「開工作卡」)…" : "接著問,或寫要做的事(再按「開工作卡」)…", text: $question, axis: .vertical)
                .lineLimit(1...4)
                .focused($inputFocused)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
            Button {
                let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
                question = ""
                Task { await ask(q.isEmpty ? "解釋這段內容" : q, shown: q.isEmpty ? "解釋" : q) }
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
            }
            .accessibilityLabel("送出")
            .disabled(busy)
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    /// 第一題帶圈選內容(管家記成「↪ 圈選」的引用);之後接著問就是一般提問,管家有前面的對話
    private func ask(_ message: String, shown: String) async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let r: ChatReply
            if turns.isEmpty {
                r = try await api.askSnap(project: projectId, message: message, snap: snap)
                pane = r.snap?.pane
                // 終端機圈的:管家依窗格判斷是哪個專案的事
                if let p = r.snap?.project, p != projectId, model.project(p) != nil { projectId = p }
            } else {
                r = try await api.ask(project: projectId, message: message)
            }
            let ok = r.bot?.error != true && r.error == nil
            turns.append((shown, r.answer ?? r.bot?.text ?? r.error ?? "", !ok))
            info = nil
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
        } catch {
            turns.append((shown, error.localizedDescription, true))
        }
    }

    /// 交給這個 agent:herdr 切到那個窗格,把圈到的內容和管家的建議貼進它的輸入框(不按 Enter)
    private func handToAgent(_ pane: SnapPane) async {
        guard let api = model.api, let answer = lastAnswer else { return }
        do {
            try await api.snapAgent(pane: pane.paneId)
            let text = "關於這段:\n\(snap.text)\n\n管家的建議:\n\(answer.trimmingCharacters(in: .whitespacesAndNewlines))"
            dismiss()
            model.mode = .terminal
            try? await Task.sleep(for: .milliseconds(400))
            model.web.pasteToTerminal(text)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            info = "沒辦法切到那個 agent:\(error.localizedDescription)"
        }
    }

    /// 依圈到的內容開工作卡:到問管家裡請管家擬草稿(跟網頁圈選的「開工作卡」一樣)。
    /// 輸入框裡寫的話(問題或要做的事)放最前面,管家照它擬;沒寫就讓管家從圈到的內容判斷
    private func draft() async {
        let task = question.trimmingCharacters(in: .whitespacesAndNewlines)
        question = ""
        let body = hasText ? snap.text : "(圈到的是圖片,沒有文字)"
        model.switchProject(projectId)
        model.pendingChat = .draft(Self.cardMessage(task: task, label: snap.label, body: body, answer: lastAnswer))
        model.pendingPresentation = .chat // 圈選視窗收好再打開問管家
        dismiss()
    }

    /// 給管家擬工作卡的話(跟網頁 snap.js 的格式一樣)
    static func cardMessage(task: String, label: String, body: String, answer: String?) -> String {
        var m = "依照這段圈選的內容開工作卡"
        if !task.isEmpty { m += "\n要做的事:\(task)" }
        m += "\n出處:\(label)\n內容:\n\(body.prefix(3000))"
        if let answer { m += "\n\n管家的看法:\n\(answer.prefix(2000))" }
        return m
    }
}
