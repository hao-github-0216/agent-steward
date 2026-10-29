// 圈選提問(原生畫面):按圈選鈕 → 畫面凍結 → 手指拉框圈一塊 → 用 Vision 讀出框裡的字 → 小框直接問管家。
// 跟網頁版一樣「文字優先」:讀得到字就送文字(整個畫面的字當周圍內容),讀不到才送截圖。
// 終端機、程式碼頁是管家網頁,它自己的圈選鈕可以用(能分辨是哪個 agent 窗格、交給那個 agent)。
import SwiftUI
import UIKit
import Vision

@MainActor
@Observable
final class SnapState {
    /// 凍結的整個畫面;有值時顯示圈選層
    var screen: UIImage?
    /// 圈好的結果;有值時顯示提問小框
    var result: SnapResult?

    func begin() {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        let r = UIGraphicsImageRenderer(bounds: window.bounds)
        screen = r.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: false) }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func cancel() { screen = nil }

    /// rect 是畫面上的點座標;裁下來、讀字
    func finish(_ rect: CGRect, label: String) {
        guard let screen, rect.width > 12, rect.height > 12 else { cancel(); return }
        let crop = screen.cropped(to: rect)
        self.screen = nil
        Task {
            async let inside = Self.ocr(crop)
            async let whole = Self.ocr(screen)
            let (text, around) = await (inside, whole)
            result = SnapResult(image: crop, text: text, context: around, label: label)
        }
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
    let text: String
    let context: String
    let label: String
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

/// 圈好之後的提問小框
struct SnapSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let snap: SnapResult
    @State private var projectId: String
    @State private var question = ""
    @State private var turns: [(q: String, a: String, error: Bool)] = []
    @State private var busy = false
    @State private var showText = false

    private static let quick: [(String, String)] = [
        ("解釋", "解釋這段內容"),
        ("翻譯", "把這段翻譯成繁體中文;如果本來就是中文,翻成英文"),
        ("找錯", "這裡有什麼錯誤或問題?說明原因和怎麼修"),
    ]

    init(snap: SnapResult, projectId: String) {
        self.snap = snap
        _projectId = State(initialValue: projectId)
    }

    private var hasText: Bool { !snap.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Image(uiImage: snap.image)
                        .resizable().scaledToFit()
                        .frame(maxHeight: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator)))
                    DisclosureGroup(isExpanded: $showText) {
                        Text(hasText ? snap.text : "沒有讀到文字,會把圈到的圖片送給管家看。")
                            .font(.footnote).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Text(hasText ? "讀到的文字(\(snap.text.count) 字)" : "沒有讀到文字").font(.footnote)
                    }
                    Picker("問哪個專案", selection: $projectId) {
                        ForEach(model.projects) { p in Text(p.name).tag(p.id) }
                    }
                    .disabled(busy || !turns.isEmpty)
                    // 跟網頁的圈選小框一樣:還沒問之前是快速問題 + 開工作卡
                    if turns.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(Self.quick, id: \.0) { q in
                                    Button(q.0) { Task { await ask(q.1, shown: q.0) } }.buttonStyle(.bordered)
                                }
                                Button("開工作卡") { Task { await draft() } }.buttonStyle(.bordered)
                            }
                        }
                        .disabled(busy)
                    }
                    ForEach(Array(turns.enumerated()), id: \.offset) { _, t in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t.q).font(.caption).foregroundStyle(.secondary)
                            if t.error { Text(t.a).foregroundStyle(.red) } else { MarkdownText(t.a) }
                        }
                        Divider()
                    }
                    if busy { HStack { ProgressView(); Text("管家想一下…").font(.footnote).foregroundStyle(.secondary) } }
                    // 問過之後:複製、到問管家繼續、開工作卡(網頁的 sp-acts)
                    if !turns.isEmpty && !busy {
                        HStack(spacing: 8) {
                            if let last = turns.last(where: { !$0.error })?.a {
                                Button("複製") { UIPasteboard.general.string = last }
                            }
                            Button("到問管家繼續") {
                                model.switchProject(projectId)
                                model.pendingPresentation = .chat // 圈選小框收好再打開問管家
                                dismiss()
                            }
                            Button("開工作卡") { Task { await draft() } }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding()
            }
            .safeAreaInset(edge: .bottom) {
                HStack(alignment: .bottom, spacing: 8) {
                    // 寫問題按送出;寫要做的事按「開工作卡」(會照這裡寫的擬工作卡)
                    TextField(turns.isEmpty ? "問這一塊,或寫要做的事(再按「開工作卡」)…" : "接著問,或寫要做的事(再按「開工作卡」)…", text: $question, axis: .vertical)
                        .lineLimit(1...4)
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
                .padding()
                .background(.bar)
            }
            .navigationTitle("圈選提問")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("關閉") { dismiss() } }
            }
        }
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
            } else {
                r = try await api.ask(project: projectId, message: message)
            }
            let ok = r.bot?.error != true && r.error == nil
            turns.append((shown, r.answer ?? r.bot?.text ?? r.error ?? "", !ok))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
        } catch {
            turns.append((shown, error.localizedDescription, true))
        }
    }

    /// 依圈到的內容開工作卡:到問管家裡請管家擬草稿(跟網頁圈選的「開工作卡」一樣)。
    /// 輸入框裡寫的話(問題或要做的事)放最前面,管家照它擬;沒寫就讓管家從圈到的內容判斷
    private func draft() async {
        let task = question.trimmingCharacters(in: .whitespacesAndNewlines)
        question = ""
        let body = hasText ? snap.text : "(圈到的是圖片,沒有文字)"
        let answer = turns.last(where: { !$0.error })?.a
        model.switchProject(projectId)
        model.pendingChat = .draft(Self.cardMessage(task: task, label: snap.label, body: body, answer: answer))
        model.pendingPresentation = .chat // 圈選小框收好再打開問管家
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
