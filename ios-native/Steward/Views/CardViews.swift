// 工作卡視窗(網頁的 #cardPop;手機上一樣從下面升起):標題、欄位/編號/agent/專案、備註、指示、完成標準,
// 下面是動作按鈕,每一欄能做的事跟網頁一樣
import SwiftUI

struct CardPopup: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let cardId: String
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        if let c = model.card(cardId) {
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    Text(c.title).font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.ink)
                    Spacer()
                    Button("關閉") { dismiss() }.buttonStyle(.small)
                }
                .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 10)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        meta(c)
                        if let note = c.note, !note.isEmpty {
                            Text(note)
                                .font(.system(size: 14))
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.chip, in: RoundedRectangle(cornerRadius: 8))
                                .textSelection(.enabled)
                        }
                        SectionLabel("指示")
                        Text(c.instructions?.isEmpty == false ? c.instructions! : "(沒有)")
                            .font(.system(size: 13, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8))
                            .textSelection(.enabled)
                        SectionLabel("完成標準")
                        Text(c.doneCriteria?.isEmpty == false ? c.doneCriteria! : "(沒有)").font(.system(size: 14))
                        if let error { Text(error).font(.system(size: 13)).foregroundStyle(Theme.bad).padding(.top, 6) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                }
                Divider()
                footer(c)
                    .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .background(Theme.panel)
        } else {
            ContentUnavailableView("找不到這張工作卡", systemImage: "questionmark.square.dashed")
        }
    }

    private func meta(_ c: Card) -> some View {
        let p = model.project(c.projectId)
        let parts = ["#\(c.id)", c.agent.map { "· \($0)" }, p.map { "· \($0.name)" }, (c.attempts ?? 0) > 1 ? "· 第 \(c.attempts!) 次派工" : nil, c.lastChanged.map { "· \(Fmt.ago($0))" }].compactMap { $0 }
        return HStack(spacing: 6) {
            Chip(text: columnLabel[c.column] ?? c.column)
            Text(parts.joined(separator: " ")).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(2)
        }
    }

    /// 網頁 renderCardPop 的按鈕:提案(不要/核准派工)、卡住(標成完成/重新派工)、完成(重做一次);
    /// 進行中/卡住/完成又有窗格的可以「在終端機看這個窗格」
    @ViewBuilder
    private func footer(_ c: Card) -> some View {
        let canJump = (c.terminalId != nil || c.paneId != nil) && ["running", "blocked", "done"].contains(c.column)
        HStack(spacing: 8) {
            if canJump {
                Button("在終端機看這個窗格") { Task { await jump(c) } }.buttonStyle(.small)
            }
            Spacer()
            switch c.column {
            case "proposed":
                Button("不要") { Task { await move(c, "rejected") } }.buttonStyle(.small)
                Button("核准派工") { Task { await move(c, "approved") } }.buttonStyle(.smallPrimary)
            case "blocked":
                Button("標成完成") { Task { await move(c, "done") } }.buttonStyle(.small)
                Button("重新派工") { Task { await move(c, "approved") } }.buttonStyle(.smallPrimary)
            case "done":
                Button("重做一次") { Task { await move(c, "approved") } }.buttonStyle(.small)
            default:
                EmptyView()
            }
        }
        .disabled(busy)
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
