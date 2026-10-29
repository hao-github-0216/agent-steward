// 工作卡視窗:內容和能做的事跟網頁的工作卡視窗一樣,元件用 Apple 的清單和系統按鈕
//   提案:核准派工 / 不要;卡住:重新派工 / 標成完成;完成:重做一次;進行中/卡住/完成又有窗格:在終端機看這個窗格
import SwiftUI

struct CardPopup: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let cardId: String
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let c = model.card(cardId) {
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
                        if let error {
                            Section { Text(error).foregroundStyle(.red) }
                        }
                    }
                    .listStyle(.insetGrouped)
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
