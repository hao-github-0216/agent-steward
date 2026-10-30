// 工作卡視窗:內容和能做的事跟網頁的工作卡視窗一樣,元件用 Apple 的清單和系統按鈕
//   提案:核准派工 / 不要;卡住:重新派工 / 標成完成;完成:重做一次;進行中/卡住/完成又有窗格:在終端機看這個窗格
//   追問:完成/卡住的卡在下面輸入框接著問做這張卡的 agent,進行中的先排隊;問題和 agent 的完整回覆排成一串對話
import SwiftUI

struct CardPopup: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let cardId: String
    @State private var busy = false
    @State private var error: String?
    @State private var question = ""
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Group {
                if let c = model.card(cardId) {
                    ScrollViewReader { proxy in
                    List {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(c.title).font(.title3.bold())
                                meta(c)
                            }
                            .padding(.vertical, 2)
                        }
                        if let note = c.note, !note.isEmpty {
                            Section("最新狀態") { Text(note).textSelection(.enabled) }
                        }
                        Section("指示") {
                            Text(c.instructions?.isEmpty == false ? c.instructions! : "(沒有)")
                                .font(.callout.monospaced())
                                .textSelection(.enabled)
                        }
                        Section("完成標準") {
                            Text(c.doneCriteria?.isEmpty == false ? c.doneCriteria! : "(沒有)")
                        }
                        actions(c)
                        if let thread = c.thread, !thread.isEmpty {
                            Section("追問") {
                                ForEach(thread) { turn in
                                    TurnRow(card: c, turn: turn, onAction: { action in Task { await followUp(c, turn, action) } })
                                        .id(turn.id)
                                }
                                if c.column == "running", thread.contains(where: { $0.status == "sent" }) {
                                    HStack(spacing: 10) {
                                        ProgressView()
                                        Text("\(c.agent ?? "agent") 回覆中…").foregroundStyle(.secondary)
                                    }
                                    .id("waiting")
                                }
                            }
                        }
                        if let error {
                            Section { Text(error).foregroundStyle(.red) }
                        }
                    }
                    .listStyle(.insetGrouped)
                    // 輸入框在最下面(像「訊息」):完成/卡住的馬上送,進行中的先排隊
                    .safeAreaInset(edge: .bottom) { if c.askable { askBar(c) } }
                    .onAppear { scrollToEnd(c, proxy, animated: false) }
                    .onChange(of: c.thread?.count) { scrollToEnd(c, proxy, animated: true) }
                    }
                } else {
                    ContentUnavailableView("找不到這張工作卡", systemImage: "questionmark.square.dashed")
                }
            }
            .navigationTitle("工作卡")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("關閉") { dismiss() } }
            }
        }
    }

    private func meta(_ c: Card) -> some View {
        let p = model.project(c.projectId)
        let parts = ["#\(c.id)", c.agent, p?.name, (c.attempts ?? 0) > 1 ? "第 \(c.attempts!) 次派工" : nil, c.lastChanged.map { Fmt.ago($0) }].compactMap { $0 }
        return HStack(spacing: 8) {
            Text(columnLabel[c.column] ?? c.column)
                .font(.caption.bold())
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(columnColor(c.column).opacity(0.15), in: Capsule())
                .foregroundStyle(columnColor(c.column))
            Text(parts.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    @ViewBuilder
    private func actions(_ c: Card) -> some View {
        let canJump = (c.terminalId != nil || c.paneId != nil) && ["running", "blocked", "done"].contains(c.column)
        let moves: [(String, String, Bool)] = {
            switch c.column {
            case "proposed": [("核准派工", "approved", true), ("不要", "rejected", false)]
            case "blocked": [("重新派工", "approved", true), ("標成完成", "done", false)]
            case "done": [("重做一次", "approved", false)]
            default: []
            }
        }()
        if !moves.isEmpty || canJump {
            Section {
                ForEach(moves, id: \.1) { label, column, primary in
                    Button(role: column == "rejected" ? .destructive : nil) {
                        Task { await move(c, column) }
                    } label: {
                        HStack {
                            Text(label).fontWeight(primary ? .semibold : .regular)
                            Spacer()
                            if busy { ProgressView() }
                        }
                    }
                    .disabled(busy)
                }
                if canJump {
                    Button { Task { await jump(c) } } label: { Label("在終端機看這個窗格", systemImage: "terminal") }
                }
            }
        }
    }

    /// 追問的輸入列
    private func askBar(_ c: Card) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(c.column == "running" ? "追問(這一輪做完就送出)" : "追問這張卡…", text: $question, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .accessibilityIdentifier("card-ask-field")
            Button { Task { await send(c) } } label: {
                if sending { ProgressView().frame(width: 32, height: 32) } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
            }
            .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            .accessibilityLabel("送出追問")
            .accessibilityIdentifier("card-ask-send")
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    private func send(_ c: Card) async {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            try await model.ask(c.id, q)
            question = ""
            error = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func followUp(_ c: Card, _ turn: CardTurn, _ action: String) async {
        do { try await model.followUp(c.id, turn: turn.id, action) } catch { self.error = error.localizedDescription }
    }

    /// 捲到對話最後面(打開、多一則時)
    private func scrollToEnd(_ c: Card, _ proxy: ScrollViewProxy, animated: Bool) {
        guard let last = c.thread?.last else { return }
        let target: String = c.column == "running" && c.thread?.contains(where: { $0.status == "sent" }) == true ? "waiting" : last.id
        DispatchQueue.main.async {
            if animated { withAnimation { proxy.scrollTo(target, anchor: .bottom) } } else { proxy.scrollTo(target, anchor: .bottom) }
        }
    }

    private func move(_ c: Card, _ column: String) async {
        busy = true
        defer { busy = false }
        do {
            try await model.move(c.id, to: column)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func jump(_ c: Card) async {
        do { try await model.showInTerminal(c) } catch { self.error = error.localizedDescription }
    }
}

/// 追問對話的一則:原本的結果、你的問題(排隊中可以取消,送不出去可以重送)、agent 的完整回覆
private struct TurnRow: View {
    let card: Card
    let turn: CardTurn
    let onAction: (String) -> Void

    var body: some View {
        if turn.isUser {
            VStack(alignment: .trailing, spacing: 6) {
                Text(turn.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                status
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("turn-\(turn.id)")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Label(turn.original == true ? "原本的結果" : (card.agent ?? "agent"), systemImage: turn.original == true ? "checkmark.seal" : "sparkles")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                MarkdownText(turn.text)
                    .textSelection(.enabled)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("turn-\(turn.id)")
        }
    }

    @ViewBuilder
    private var status: some View {
        switch turn.status {
        case "queued":
            HStack(spacing: 10) {
                Text(card.column == "running" ? "排隊中,這一輪做完就送出" : "等這個 agent 空下來就送出").font(.caption).foregroundStyle(.secondary)
                Button("取消") { onAction("cancel") }.font(.caption).buttonStyle(.borderless)
            }
        case "sent":
            Text("已送出,等回覆").font(.caption).foregroundStyle(.secondary)
        case "failed":
            VStack(alignment: .trailing, spacing: 4) {
                Text(turn.note ?? "送不出去").font(.caption).foregroundStyle(.red)
                HStack(spacing: 14) {
                    Button("重送") { onAction("retry") }.buttonStyle(.borderless)
                    Button("取消", role: .destructive) { onAction("cancel") }.buttonStyle(.borderless)
                }
                .font(.caption)
            }
        default:
            EmptyView()
        }
    }
}
