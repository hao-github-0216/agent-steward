// 看板(原生),排版跟網頁的看板一樣:
//   ☐ 顯示所有專案的工作卡 / 規則提示 / 收起看板
//   ● ○ ○ ○ ○  五欄(提案、已核准、進行中、卡住、完成)左右滑,每欄 78% 寬,下一欄露一點;點欄名收合
//   專案說明卡:名稱、路徑、herdr space、目標、目前進度、下一步、卡住的地方、重要決定、最近的工作、隱私專案、拆出子資料夾
import SwiftUI
import UniformTypeIdentifiers

/// 網頁的 COLS
let boardColumns: [(id: String, label: String)] = [("proposed", "提案"), ("approved", "已核准"), ("running", "進行中"), ("blocked", "卡住"), ("done", "完成")]
let columnLabel: [String: String] = Dictionary(uniqueKeysWithValues: boardColumns.map { ($0.id, $0.label) } + [("rejected", "不要了")])

struct BoardView: View {
    @Environment(AppModel.self) private var model
    @State private var visibleColumn: String? = "proposed"
    @State private var showAllDone = false
    @State private var moveError: String?
    @State private var showRules = false

    var body: some View {
        @Bindable var model = model
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    CheckBox(title: "顯示所有專案的工作卡", isOn: $model.allCards)
                    Button { showRules = true } label: {
                        Text("拖到「已核准」= 派工或重新派工 · 拖回「提案」= 退回 · 點這裡看完整規則")
                            .font(.system(size: 12)).foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    HStack {
                        Spacer()
                        Button(model.boardCollapsed ? "展開看板" : "收起看板") { model.boardCollapsed.toggle() }
                            .buttonStyle(.small)
                    }
                    if !model.boardCollapsed {
                        dots
                        columns(width: geo.size.width, height: geo.size.height)
                    }
                    if let p = model.current {
                        BriefCard(project: p)
                    } else {
                        Text("選一個專案").foregroundStyle(Theme.muted).modifier(CardPanel())
                    }
                }
                .padding(12)
                // 浮動球不要蓋到最後一段
                .padding(.bottom, 70)
            }
            .refreshable { await model.refresh() }
        }
        .background(Theme.bg)
        .alert("沒辦法移動這張卡", isPresented: Binding(get: { moveError != nil }, set: { if !$0 { moveError = nil } })) {
            Button("好") {}
        } message: {
            Text(moveError ?? "")
        }
        .alert("工作卡的規則", isPresented: $showRules) {
            Button("好") {}
        } message: {
            Text("提案 → 已核准:派工\n卡住/完成 → 已核准:重新派工(附上次結果)\n進行中/卡住 → 完成:手動標記\n任何 → 提案:退回\n「進行中」只能由派工產生\n\n長按卡片拖到別欄,或點卡片用按鈕。")
        }
        .onChange(of: model.scrollToColumn) { _, col in
            if let col { withAnimation { visibleColumn = col }; model.scrollToColumn = nil }
        }
        .onAppear {
            // 從程式碼/終端機用連結跳過來時,看板這時才出現
            if let col = model.scrollToColumn { visibleColumn = col; model.scrollToColumn = nil }
        }
    }

    private var cards: [Card] {
        model.cards.filter { $0.column != "rejected" && (model.allCards || $0.projectId == model.currentProjectId) }
    }

    /// 欄位指示點(網頁的 #bdots):目前這一欄是長的藍點,點了跳過去
    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(boardColumns, id: \.id) { c in
                Capsule()
                    .fill(visibleColumn == c.id ? Theme.accent : Theme.line)
                    .frame(width: visibleColumn == c.id ? 18 : 8, height: 8)
                    .onTapGesture { withAnimation { visibleColumn = c.id } }
                    .accessibilityLabel(c.label)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func columns(width: CGFloat, height: CGFloat) -> some View {
        let colWidth = (width - 24) * 0.78 / 0.96 // 網頁每欄 78vw
        // 高度跟著卡片數:空的時候矮(跟網頁一樣約 120),多的時候最高到畫面 42%(網頁看板最高 45dvh),欄裡自己捲
        let most = boardColumns.map { col in
            let n = cards.filter { $0.column == col.id }.count
            return col.id == "done" && !showAllDone ? min(n, 8) + (n > 8 ? 1 : 0) : n
        }.max() ?? 0
        let colHeight = min(max(120, 44 + CGFloat(most) * 42), max(220, height * 0.42))
        return ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 10) {
                ForEach(boardColumns, id: \.id) { col in
                    BoardColumn(
                        id: col.id, label: col.label,
                        cards: cards.filter { $0.column == col.id }.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") },
                        folded: model.foldedColumns.contains(col.id),
                        showAllDone: $showAllDone,
                        onDrop: { cardId in Task { await drop(cardId, to: col.id) } }
                    )
                    .frame(width: model.foldedColumns.contains(col.id) ? 40 : colWidth, height: colHeight)
                    .id(col.id)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $visibleColumn, anchor: .leading)
        .scrollClipDisabled()
    }

    private func drop(_ cardId: String, to column: String) async {
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
    let folded: Bool
    @Binding var showAllDone: Bool
    let onDrop: (String) -> Void
    @State private var targeted = false

    private static let doneShown = 8 // 完成欄只顯示最近 8 張

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !folded {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        let shown = id == "done" && !showAllDone ? Array(cards.prefix(Self.doneShown)) : cards
                        ForEach(shown) { c in
                            KCard(card: c, showProject: model.allCards)
                                // 拖拉時的預覽畫在 app 的畫面樹外面,拿不到 AppModel:只能用不讀環境的 KCardFace
                                .draggable(c.id) {
                                    KCardFace(card: c, projectName: nil).frame(width: 220).opacity(0.9)
                                }
                        }
                        if id == "done" && cards.count > Self.doneShown {
                            Button(showAllDone ? "只看最近 \(Self.doneShown) 張" : "看更多(\(cards.count - Self.doneShown))") { showAllDone.toggle() }
                                .buttonStyle(.small)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .padding(folded ? 2 : 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.col, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(targeted ? Theme.accent : Color.clear, lineWidth: 2))
        .dropDestination(for: String.self) { items, _ in
            if let first = items.first { onDrop(first) }
            return true
        } isTargeted: { targeted = $0 }
    }

    /// 欄名:左邊名稱、右邊張數和收合符號;點一下收合/展開
    private var header: some View {
        Button {
            if folded { model.foldedColumns.remove(id) } else { model.foldedColumns.insert(id) }
        } label: {
            Group {
                if folded {
                    VStack(spacing: 6) {
                        Text(label).font(.system(size: 12, weight: .semibold))
                        Text("\(cards.count)").font(.system(size: 12))
                        Text("▸").font(.system(size: 11)).opacity(0.5)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    HStack {
                        Text(label).font(.system(size: 12, weight: .semibold))
                        Spacer()
                        Text("\(cards.count)").font(.system(size: 12))
                        Text("◂").font(.system(size: 11)).opacity(0.5)
                    }
                    .padding(.horizontal, 4)
                }
            }
            .foregroundStyle(Theme.muted)
            .padding(.top, 2).padding(.bottom, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) \(cards.count) 張,\(folded ? "展開" : "收合")這一欄")
    }
}

/// 網頁的 .kcard:粗體標題一行,右邊小標籤(有備註的點、第幾次派工、專案名稱)。點了打開工作卡視窗
struct KCard: View {
    @Environment(AppModel.self) private var model
    let card: Card
    var showProject = false

    var body: some View {
        KCardFace(card: card, projectName: showProject ? model.project(card.projectId)?.name : nil)
            .contentShape(Rectangle())
            .onTapGesture { model.openCardId = card.id }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("打開工作卡")
    }
}

/// 工作卡的樣子(不讀 app 的環境:拖拉預覽也能用)
struct KCardFace: View {
    let card: Card
    let projectName: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(card.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                if let n = card.note, !n.isEmpty {
                    Circle().fill(Theme.warn).frame(width: 8, height: 8).accessibilityLabel("有備註")
                }
                if let a = card.attempts, a > 1 { Text("×\(a)") }
                if let projectName { Text(projectName).lineLimit(1).frame(maxWidth: 90) }
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
        .shadow(color: .black.opacity(0.05), radius: 3, y: 1)
    }
}

/// 專案說明卡(網頁的 #brief)
struct BriefCard: View {
    @Environment(AppModel.self) private var model
    let project: Project
    @State private var busy = false
    @State private var message: String?

    private var space: SpaceInfo? { model.spaces[project.id] }
    private var isProject: Bool { project.kind == "project" }

    var body: some View {
        let s = project.state
        VStack(alignment: .leading, spacing: 4) {
            Text("\(project.private == true ? "🔒 " : "")\(project.name)").font(.system(size: 17, weight: .bold))
            Text("\(project.root ?? "")\(s?.updatedAt?.isEmpty == false ? " · 更新於 \(Fmt.ago(Fmt.date(s?.updatedAt)))" : "")")
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
                .textSelection(.enabled)
            if isProject { spaceLine.padding(.top, 4) }
            if let goal = s?.goal, !goal.isEmpty {
                SectionLabel("目標")
                MarkdownText(goal, fixEscapes: true)
            }
            if let progress = s?.progress, !progress.isEmpty {
                SectionLabel("目前進度")
                MarkdownText(progress, fixEscapes: true)
            } else {
                Text(isProject ? "管家還沒有這個專案的紀錄。agent 收工後會自動整理,或現在就從現有記錄補建。" : "管家還沒有這個專案的紀錄。agent 收工後會自動整理。")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted).padding(.top, 6)
                if isProject {
                    Button(busy ? "整理中…(約 1 分鐘)" : "從現有記錄補建") { Task { await bootstrap() } }
                        .buttonStyle(.smallPrimary).disabled(busy)
                }
            }
            BulletList(title: "下一步", items: s?.nextSteps)
            BulletList(title: "卡住的地方", items: s?.blockers)
            if let d = s?.decisions, !d.isEmpty {
                DisclosureGroup {
                    BulletList(title: "", items: d)
                } label: {
                    Text("重要決定(\(d.count))").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                }
                .padding(.top, 6)
            }
            if let recent = s?.recent, !recent.isEmpty {
                SectionLabel("最近的工作")
                ForEach(Array(recent.prefix(6).enumerated()), id: \.offset) { _, r in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(Theme.muted)
                        Text("\(Fmt.ago(Fmt.date(r.at))) · \(r.agent ?? ""):\(Markdown.plain(r.summary ?? ""))")
                    }
                }
            }
            if isProject { toggles.padding(.top, 10) }
            if let message { Text(message).font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.top, 4) }
        }
        .font(.system(size: 14))
        .modifier(CardPanel())
    }

    /// herdr space 的狀態:名稱不一樣、有窗格跑到別的 space 時給修正按鈕
    @ViewBuilder
    private var spaceLine: some View {
        if let label = space?.label {
            VStack(alignment: .leading, spacing: 6) {
                Chip(text: "herdr space:\(label)")
                if space?.nameDiffers == true {
                    Text("名稱和專案不同").font(.system(size: 12)).foregroundStyle(Theme.warn)
                    HStack {
                        Button("專案改名為「\(label)」") { Task { await fixName("space") } }.buttonStyle(.small)
                        Button("space 改回「\(project.name)」") { Task { await fixName("project") } }.buttonStyle(.small)
                    }
                }
                if let n = space?.strays, n > 0 {
                    HStack {
                        Text("有 \(n) 個窗格在別的 space").font(.system(size: 12)).foregroundStyle(Theme.warn)
                        Button("搬過去") { Task { await moveStrays() } }.buttonStyle(.smallPrimary)
                    }
                }
            }
        } else {
            HStack(spacing: 6) {
                Chip(text: "還沒有綁定 herdr space", dim: true)
                Text("跳轉或派工時會自動建立,也可以用「整理 spaces」").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
        }
    }

    private var toggles: some View {
        VStack(alignment: .leading, spacing: 8) {
            CheckBox(title: "隱私專案(只用「隱私專案」指定的模型)", isOn: Binding(get: { project.private == true }, set: { v in Task { await update(["private": v]) } }))
            Button("拆出子資料夾") { model.webSheet = .split(project.id) }.buttonStyle(.small)
            Text("改名、在終端機開啟、停止追蹤:左側專案旁的「⋯」").font(.system(size: 12)).foregroundStyle(Theme.muted)
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
