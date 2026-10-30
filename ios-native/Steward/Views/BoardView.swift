// 看板:結構跟網頁看板一樣(五欄工作卡 + 專案說明),元件用 Apple 的:
//   系統清單(下拉更新)、像「提醒事項」欄位那樣左右滑的五欄(提案、已核准、進行中、卡住、完成)、
//   卡片點了看詳情,長按跳出動作選單(跟網頁工作卡視窗的按鈕一樣),也可以拖到別欄;
//   下面是專案說明:目標、目前進度、下一步、卡住的地方、重要決定、最近的工作、herdr space、隱私專案
import SwiftUI

/// 網頁的 COLS
let boardColumns: [(id: String, label: String)] = [("proposed", "提案"), ("approved", "已核准"), ("running", "進行中"), ("blocked", "卡住"), ("done", "完成")]
let columnLabel: [String: String] = Dictionary(uniqueKeysWithValues: boardColumns.map { ($0.id, $0.label) } + [("rejected", "不要了")])

struct BoardView: View {
    @Environment(AppModel.self) private var model
    @State private var visibleColumn: String? = "proposed"
    @State private var showAllDone = false
    @State private var moveError: String?

    var body: some View {
        GeometryReader { geo in
            List {
                if !model.boardCollapsed {
                    Section {
                        columns(width: geo.size.width)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                        dots
                            .listRowBackground(Color.clear)
                    } header: {
                        Text(model.allCards ? "所有專案的工作卡" : "工作卡")
                    } footer: {
                        Text("點卡片看詳情;長按選動作,或拖到「已核准」= 派工或重新派工、拖回「提案」= 退回")
                    }
                }
                if let p = model.current {
                    BriefSections(project: p)
                } else {
                    Section { Text("選一個專案").foregroundStyle(.secondary) }
                }
                // 浮動球不要蓋到最後一段
                Section {} footer: { Color.clear.frame(height: 60) }
            }
            .listStyle(.insetGrouped)
            .refreshable { await model.refresh() }
        }
        .alert("沒辦法移動這張卡", isPresented: Binding(get: { moveError != nil }, set: { if !$0 { moveError = nil } })) {
            Button("好") {}
        } message: {
            Text(moveError ?? "")
        }
        .onChange(of: model.scrollToColumn) { _, col in
            if let col { withAnimation { visibleColumn = col }; model.scrollToColumn = nil }
        }
        .onAppear {
            if let col = model.scrollToColumn { visibleColumn = col; model.scrollToColumn = nil }
        }
    }

    private var cards: [Card] {
        model.cards.filter { $0.column != "rejected" && (model.allCards || $0.projectId == model.currentProjectId) }
    }

    /// 欄位頁點(跟系統的頁面指示一樣),點了跳到那一欄
    private var dots: some View {
        HStack(spacing: 8) {
            ForEach(boardColumns, id: \.id) { c in
                Circle()
                    .fill(visibleColumn == c.id ? Color.primary : Color.secondary.opacity(0.35))
                    .frame(width: 7, height: 7)
                    .onTapGesture { withAnimation { visibleColumn = c.id } }
                    .accessibilityLabel(c.label)
                    .accessibilityAddTraits(visibleColumn == c.id ? .isSelected : [])
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func columns(width: CGFloat) -> some View {
        // 手機:一欄約 86% 寬,下一欄露一點;iPad 等寬螢幕:每欄固定寬,一次看得到好幾欄
        let colWidth = width > 700 ? 340 : (width - 40) * 0.86
        return ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 12) {
                ForEach(boardColumns, id: \.id) { col in
                    BoardColumn(
                        id: col.id, label: col.label,
                        cards: cards.filter { $0.column == col.id }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") },
                        showAllDone: $showAllDone,
                        onMove: { cardId, column in Task { await move(cardId, to: column) } }
                    )
                    .frame(width: colWidth)
                    .id(col.id)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 20)
            .padding(.vertical, 4)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $visibleColumn, anchor: .leading)
    }

    private func move(_ cardId: String, to column: String) async {
        guard let c = model.card(cardId), c.column != column else { return }
        do {
            try await model.move(cardId, to: column)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            moveError = error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

struct BoardColumn: View {
    @Environment(AppModel.self) private var model
    let id: String
    let label: String
    let cards: [Card]
    @Binding var showAllDone: Bool
    let onMove: (String, String) -> Void
    @State private var targeted = false

    private static let doneShown = 8 // 完成欄只顯示最近 8 張(跟網頁一樣)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(columnColor(id)).frame(width: 8, height: 8)
                Text(label).font(.headline)
                Spacer()
                Text("\(cards.count)").font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
            let shown = id == "done" && !showAllDone ? Array(cards.prefix(Self.doneShown)) : cards
            if shown.isEmpty {
                Text("沒有工作卡")
                    .font(.subheadline).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .background(RoundedRectangle(cornerRadius: 12).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(.quaternary))
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(shown) { c in
                            KCard(card: c, showProject: model.allCards)
                                // 長按選單也畫在一般畫面樹外面:不讀環境,把 model 直接傳進去(跟拖拉預覽同一個坑)
                                .contextMenu { CardActions(model: model, card: c, onMove: onMove) }
                                // 拖拉預覽畫在 app 的畫面樹外面,拿不到 AppModel:只能用不讀環境的 KCardFace
                                .draggable(c.id) { KCardFace(card: c, projectName: nil).frame(width: 240) }
                        }
                        if id == "done" && cards.count > Self.doneShown {
                            Button(showAllDone ? "只看最近 \(Self.doneShown) 張" : "看更多(\(cards.count - Self.doneShown))") { showAllDone.toggle() }
                                .font(.subheadline)
                                .padding(.top, 2)
                        }
                    }
                }
                .frame(maxHeight: 360)
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .padding(10)
        .background(targeted ? Theme.accent.opacity(0.12) : Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
        .dropDestination(for: String.self) { items, _ in
            if let first = items.first { onMove(first, id) }
            return true
        } isTargeted: { targeted = $0 }
    }
}

/// 長按卡片的動作:跟網頁工作卡視窗一樣(提案:核准派工/不要;卡住:重新派工/標成完成;完成:重做一次),
/// 加上打開和在終端機看這個窗格
struct CardActions: View {
    let model: AppModel
    let card: Card
    let onMove: (String, String) -> Void

    var body: some View {
        Button { model.present(.card(card.id)) } label: { Label("打開", systemImage: "doc.text") }
        switch card.column {
        case "proposed":
            Button { onMove(card.id, "approved") } label: { Label("核准派工", systemImage: "paperplane") }
            Button(role: .destructive) { onMove(card.id, "rejected") } label: { Label("不要", systemImage: "xmark") }
        case "blocked":
            Button { onMove(card.id, "approved") } label: { Label("重新派工", systemImage: "arrow.clockwise") }
            Button { onMove(card.id, "done") } label: { Label("標成完成", systemImage: "checkmark") }
        case "done":
            Button { onMove(card.id, "approved") } label: { Label("重做一次", systemImage: "arrow.uturn.backward") }
        default:
            EmptyView()
        }
        if (card.terminalId != nil || card.paneId != nil) && ["running", "blocked", "done"].contains(card.column) {
            Button { Task { try? await model.showInTerminal(card) } } label: { Label("在終端機看這個窗格", systemImage: "terminal") }
        }
    }
}

/// 工作卡:系統的白色圓角格,標題 + 「agent · 專案」,有備註/第幾次派工用小圖示。點了打開工作卡視窗
struct KCard: View {
    @Environment(AppModel.self) private var model
    let card: Card
    var showProject = false

    var body: some View {
        KCardFace(card: card, projectName: showProject ? model.project(card.projectId)?.name : nil)
            .contentShape(Rectangle())
            .onTapGesture { model.present(.card(card.id)) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("打開工作卡;長按有更多動作")
    }
}

/// 工作卡的樣子(不讀 app 的環境:拖拉預覽也能用)
struct KCardFace: View {
    let card: Card
    let projectName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(card.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                Text([card.agent, projectName].compactMap { $0 }.joined(separator: " · "))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let a = card.attempts, a > 1 {
                    Label("\(a)", systemImage: "arrow.triangle.2.circlepath").labelStyle(.titleAndIcon)
                        .accessibilityLabel("第 \(a) 次派工")
                }
                // 追問過幾次(在等回覆時用藍色)
                let asked = card.thread?.filter(\.isUser).count ?? 0
                if asked > 0 {
                    let waiting = card.thread?.contains { $0.status == "sent" || $0.status == "queued" } == true
                    Label("\(asked)", systemImage: "bubble.left.and.bubble.right.fill").labelStyle(.titleAndIcon)
                        .foregroundStyle(waiting ? Theme.accent : .secondary)
                        .accessibilityLabel(waiting ? "追問 \(asked) 次,等回覆中" : "追問 \(asked) 次")
                }
                if let n = card.note, !n.isEmpty {
                    Image(systemName: "text.bubble.fill").foregroundStyle(.orange).accessibilityLabel("有備註")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// 專案說明(網頁看板下面的說明卡),用清單的分段
struct BriefSections: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var busy = false
    @State private var message: String?

    private var space: SpaceInfo? { model.spaces[project.id] }
    private var isProject: Bool { project.kind == "project" }

    var body: some View {
        let s = project.state
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name).font(.title3.bold())
                Text("\(project.root ?? "")\(s?.updatedAt?.isEmpty == false ? " · 更新於 \(Fmt.ago(Fmt.date(s?.updatedAt)))" : "")")
                    .font(.footnote).foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .padding(.vertical, 2)
            if isProject { spaceRows }
        }
        if let goal = s?.goal, !goal.isEmpty {
            Section("目標") { MarkdownText(goal, fixEscapes: true) }
        }
        if let progress = s?.progress, !progress.isEmpty {
            Section("目前進度") { MarkdownText(progress, fixEscapes: true) }
        } else {
            Section {
                if isProject {
                    Button {
                        Task { await bootstrap() }
                    } label: {
                        HStack {
                            Label(busy ? "整理中…(約 1 分鐘)" : "從現有記錄補建", systemImage: "arrow.triangle.2.circlepath")
                            Spacer()
                            if busy { ProgressView() }
                        }
                    }
                    .disabled(busy)
                }
            } header: {
                Text("目前進度")
            } footer: {
                Text(isProject ? "管家還沒有這個專案的紀錄。agent 收工後會自動整理,或現在就從現有記錄補建。" : "管家還沒有這個專案的紀錄。agent 收工後會自動整理。")
            }
        }
        rows("下一步", s?.nextSteps)
        rows("卡住的地方", s?.blockers)
        if let d = s?.decisions, !d.isEmpty {
            Section {
                DisclosureGroup("重要決定(\(d.count))") {
                    ForEach(Array(d.enumerated()), id: \.offset) { _, x in MarkdownText(x, fixEscapes: true) }
                }
            }
        }
        if let recent = s?.recent, !recent.isEmpty {
            Section("最近的工作") {
                ForEach(Array(recent.prefix(6).enumerated()), id: \.offset) { _, r in
                    VStack(alignment: .leading, spacing: 3) {
                        MarkdownText(r.summary ?? "", fixEscapes: true)
                        Text("\(Fmt.ago(Fmt.date(r.at))) · \(r.agent ?? "")").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        if isProject {
            Section {
                Toggle("隱私專案", isOn: Binding(get: { project.private == true }, set: { v in Task { await update(["private": v]) } }))
                Button("拆出子資料夾") { model.present(.web(.split(project.id))) }
            } footer: {
                Text("隱私專案只用「隱私專案」指定的模型。改名、在終端機開啟、停止追蹤:在專案清單裡長按專案。\(message.map { "\n\($0)" } ?? "")")
            }
        }
    }

    /// herdr space:綁定的名稱;名稱不一樣、有窗格跑到別的 space 時給修正按鈕(跟網頁一樣)
    @ViewBuilder
    private var spaceRows: some View {
        if let label = space?.label {
            LabeledContent("herdr space", value: label)
            if space?.nameDiffers == true {
                Button("專案改名為「\(label)」") { Task { await fixName("space") } }
                Button("space 改回「\(project.name)」") { Task { await fixName("project") } }
            }
            if let n = space?.strays, n > 0 {
                Button("把 \(n) 個在別的 space 的窗格搬過去") { Task { await moveStrays() } }
            }
        } else {
            LabeledContent("herdr space", value: "還沒有綁定")
        }
    }

    @ViewBuilder
    private func rows(_ title: String, _ items: [String]?) -> some View {
        if let items, !items.isEmpty {
            Section(title) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, x in MarkdownText(x, fixEscapes: true) }
            }
        }
    }

    private func update(_ body: [String: Any]) async {
        do { try await model.updateProject(project.id, body); message = nil } catch { message = error.localizedDescription }
    }

    private func bootstrap() async {
        busy = true
        defer { busy = false }
        do { try await model.api?.bootstrap(project.id); await model.refresh(); message = nil } catch { message = "補建失敗:\(error.localizedDescription)" }
    }

    private func fixName(_ use: String) async {
        do { try await model.api?.fixSpaceName(project.id, use: use); await model.refresh() } catch { message = error.localizedDescription }
    }

    private func moveStrays() async {
        do { message = try await model.api?.moveStrays(project.id); await model.refresh() } catch { message = error.localizedDescription }
    }
}
