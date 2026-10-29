// app 的骨架:結構跟管家網頁一樣(專案在最上層,下面是看板/程式碼/終端機),元件用 Apple 的:
//   底部系統分頁列:看板 · 程式碼 · 終端機(跟網頁的三個模式同順序)
//   每一頁頂端的系統導覽列:標題是目前專案,點一下打開專案清單換專案
//   右下角:貓咪浮動球(問管家)和它旁邊的圈選鈕(全 app 只有這一個圈選入口)
import SwiftUI

struct AppShell: View {
    @Environment(AppModel.self) private var model
    @State private var chatDetent: PresentationDetent = .large
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        @Bindable var model = model
        @Bindable var snap = model.snap
        TabView(selection: $model.mode) {
            BoardTab()
                .tabItem { Label("看板", systemImage: "rectangle.split.3x1") }
                .tag(Mode.board)
            CodeTab()
                .tabItem { Label("程式碼", systemImage: "chevron.left.forwardslash.chevron.right") }
                .tag(Mode.code)
            WebModeTab(mode: .terminal)
                .tabItem { Label("終端機", systemImage: "terminal") }
                .tag(Mode.terminal)
        }
        // 圈選層(看板用的原生圈選):截圖鋪滿螢幕,提示放在安全區域裡
        .overlay {
            if let screen = snap.screen {
                SnapOverlay(screen: screen, onDone: { snap.finish($0, label: model.screenLabel, kind: model.snapKind) }, onCancel: { snap.cancel() })
            }
        }
        // 從底下升起的視窗都掛在這裡;收好時叫 drainPending,接著打開排隊的下一個
        .sheet(item: $snap.result, onDismiss: { model.drainPending() }) { r in
            SnapSheet(snap: r, projectId: model.currentProjectId ?? "")
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $model.showChat, onDismiss: { model.drainPending() }) {
            ChatPanel()
                // 一打開就是全高(對話需要空間),往下拉變半高
                .presentationDetents([.large, .medium], selection: $chatDetent)
                .presentationDragIndicator(.visible)
                .onAppear { chatDetent = .large }
        }
        .sheet(item: Binding(get: { model.openCardId.map(CardRef.init) }, set: { model.openCardId = $0?.id }), onDismiss: { model.drainPending() }) { ref in
            CardPopup(cardId: ref.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $model.showSettings, onDismiss: { model.drainPending() }) { SettingsView() }
        .sheet(item: $model.webSheet, onDismiss: { model.drainPending() }) { sheet in
            // 拆出子資料夾是原生畫面;其他(建立專案、整理 spaces、設定各頁)還是網頁
            if case .split(let p) = sheet { SplitProjectView(projectId: p) } else { WebSheetView(sheet: sheet) }
        }
        .sheet(isPresented: $model.showProjectPicker, onDismiss: { model.drainPending() }) { ProjectPicker() }
        .onChange(of: sizeClass, initial: true) { _, c in model.compact = c != .regular }
        .alert("這個專案還沒有 herdr space", isPresented: Binding(get: { model.mode == .terminal && model.needSpace != nil && model.needSpace == model.currentProjectId }, set: { if !$0 { model.needSpace = nil } })) {
            Button("建立並跳過去") { model.web.createSpace(); model.needSpace = nil }
            Button("先不要", role: .cancel) { model.needSpace = nil }
        } message: {
            Text("管家會在 herdr 開一個「\(model.current?.name ?? "")」的 space,終端機跳過去。")
        }
    }
}

struct CardRef: Identifiable { let id: String }

// MARK: - 每一頁共用的頂端:標題是目前專案(點了換專案)

struct ProjectChrome: ViewModifier {
    func body(content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { ProjectTitleButton() }
            }
    }
}

struct ProjectTitleButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.present(.projectPicker) } label: {
            HStack(spacing: 4) {
                if model.current?.private == true {
                    Image(systemName: "lock.fill").font(.caption).foregroundStyle(.secondary)
                }
                Text(model.current?.name ?? "選專案")
                    .font(.headline)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: 240)
        }
        .accessibilityLabel("目前專案:\(model.current?.name ?? "未選")")
        .accessibilityHint("點一下換專案")
    }
}

struct SettingsToolbarButton: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Button { model.present(.settings) } label: { Image(systemName: "gearshape") }
            .accessibilityLabel("設定")
    }
}

// MARK: - 看板分頁

struct BoardTab: View {
    @Environment(AppModel.self) private var model
    @State private var showRules = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            BoardView()
                .overlay { BallLayer() }
                .modifier(ProjectChrome())
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Menu {
                            Toggle("顯示所有專案的工作卡", isOn: $model.allCards)
                            Toggle("收起看板", isOn: $model.boardCollapsed)
                            Button("工作卡規則…") { showRules = true }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .accessibilityLabel("看板選項")
                        SettingsToolbarButton()
                    }
                }
                .alert("工作卡的規則", isPresented: $showRules) {
                    Button("好") {}
                } message: {
                    Text("提案 → 已核准:派工\n卡住/完成 → 已核准:重新派工(附上次結果)\n進行中/卡住 → 完成:手動標記\n任何 → 提案:退回\n「進行中」只能由派工產生\n\n點卡片看詳情;長按卡片選動作,或拖到別欄。")
                }
        }
    }
}

// MARK: - 程式碼/終端機分頁(管家網頁)

struct WebModeTab: View {
    @Environment(AppModel.self) private var model
    let mode: Mode
    @State private var attachToken = 0

    var body: some View {
        NavigationStack {
            Group {
                if model.current != nil {
                    WebContainer(token: attachToken)
                        .overlay { BallLayer() }
                } else {
                    ContentUnavailableView("還沒有專案", systemImage: "tray")
                }
            }
            .modifier(ProjectChrome())
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if mode == .terminal { branchTools }
                    Button(model.drawerOpen ? "收起管家" : "管家") { model.drawerOpen.toggle() }
                        .accessibilityHint("打開或收起管家側欄")
                }
            }
        }
        // 程式碼和終端機共用同一個網頁:這一頁出現時把網頁搬過來
        .onAppear { attachToken += 1 }
        .modifier(DrawerInspector(mode: mode))
    }

    /// 終端機的支線工具(跟網頁一樣:herdr 停在 agent 上才能開支線;停在支線上換成「帶回」)
    @ViewBuilder
    private var branchTools: some View {
        if let main = model.termState.branchMain {
            Button("帶回") { model.web.handoff() }
                .disabled(!model.termState.mainAlive)
                .accessibilityLabel(model.termState.mainAlive ? "把這條支線的結論帶回「\(main)」" : "主線已經關閉,沒辦法帶回")
        } else if model.termState.agent {
            Menu {
                Button("開支線(另開 worktree)") { model.web.openBranch(here: false) }
                Button("同資料夾開(不建 worktree)") { model.web.openBranch(here: true) }
            } label: {
                Text("＋支線")
            } primaryAction: {
                model.web.openBranch(here: false)
            }
            .accessibilityHint("從 herdr 目前的 agent 開一條支線;長按有其他開法")
        }
    }
}

// MARK: - 浮動球(貓咪)和圈選鈕

struct BallLayer: View {
    @Environment(AppModel.self) private var model
    @State private var drag: CGSize = .zero
    @State private var dragging = false

    private let size: CGFloat = 56
    private let inset: CGFloat = 16

    var body: some View {
        GeometryReader { geo in
            let c = model.ballCorner
            let x = c.isRight ? geo.size.width - inset - size / 2 : inset + size / 2
            let y = c.isBottom ? geo.size.height - inset - size / 2 : inset + size / 2
            ZStack {
                // 圈選鈕:在貓的內側上方(網頁的位置)
                if !dragging {
                    SnapButton()
                        .position(x: x + (c.isRight ? -44 : 44), y: y + (c.isBottom ? -44 : 44))
                }
                CatBall(busy: model.chatBusy, unread: model.chatUnread)
                    .frame(width: size, height: size)
                    .position(x: x + drag.width, y: y + drag.height)
                    .gesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { v in dragging = true; drag = v.translation }
                            .onEnded { v in
                                // 放開:吸到最近的角落(跟網頁一樣)
                                let fx = x + v.translation.width, fy = y + v.translation.height
                                let right = fx > geo.size.width / 2, bottom = fy > geo.size.height / 2
                                model.ballCorner = bottom ? (right ? .br : .bl) : (right ? .tr : .tl)
                                drag = .zero
                                dragging = false
                            }
                    )
                    .simultaneousGesture(TapGesture().onEnded { openChat() })
                    .accessibilityElement()
                    .accessibilityLabel("問管家")
                    .accessibilityHint("可以拖到畫面四個角落")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { openChat() }
            }
            .animation(.spring(duration: 0.25), value: model.ballCorner)
        }
    }

    private func openChat() {
        model.chatUnread = false
        model.present(.chat)
    }
}

/// 圈選鈕:三個分頁都用 app 自己的圈選(iPhone 的文字辨識);終端機圈的會請管家認出是哪個 agent 窗格
struct SnapButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            model.beginSnap()
        } label: {
            Image(systemName: "text.viewfinder")
                .font(.title3)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
        }
        .tint(Theme.accent)
        .accessibilityLabel("圈選畫面問管家")
    }
}

struct CatBall: View {
    let busy: Bool
    let unread: Bool
    @State private var pulse = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Circle().fill(Theme.ball)
                .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
            CatLogo().padding(4)
                .scaleEffect(busy && pulse ? 1.06 : 1)
            if unread {
                Circle().fill(.red).frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Color.white, lineWidth: 2))
                    .accessibilityLabel("有新的回答")
            }
        }
        .onChange(of: busy) { _, b in
            if b { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { pulse = true } } else { pulse = false }
        }
    }
}

// MARK: - 管家側欄(程式碼/終端機下面,網頁的 #drawer)

/// 管家側欄用 Apple 的 inspector:iPhone(窄畫面)是從底下升起、疊在程式碼/終端機上面的視窗,
/// 預設半個螢幕、往上拖展開,半高時後面還可以操作;iPad(寬畫面)是右邊一欄,跟程式碼/終端機並排
struct DrawerInspector: ViewModifier {
    @Environment(AppModel.self) private var model
    let mode: Mode
    @State private var detent: PresentationDetent = .medium

    func body(content: Content) -> some View {
        content.inspector(isPresented: Binding(get: { model.drawerOpen && model.mode == mode }, set: { if !$0 { model.drawerCardId = nil; model.drawerOpen = false } })) {
            StewardDrawer()
                .presentationDetents([.medium, .large], selection: $detent)
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
                .onAppear { detent = .medium }
        }
    }
}

/// 管家側欄(跟網頁的管家側欄一樣:待核准/進行中/卡住的工作卡、目前進度、下一步、卡住的地方)。
/// iPhone 上點工作卡在側欄上面再疊一層;iPad 上照常打開工作卡視窗
struct StewardDrawer: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            Group {
                if let p = model.current {
                    List { sections(p) }
                        .listStyle(.insetGrouped)
                } else {
                    ContentUnavailableView("還沒有專案", systemImage: "tray", description: Text("在看板、程式碼頁面或 herdr 選一個專案"))
                }
            }
            .navigationTitle(model.current?.name ?? "管家")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.present(.chat) } label: { Label("問管家", systemImage: "bubble.left.and.bubble.right") }
                }
                ToolbarItem(placement: .confirmationAction) { Button("完成") { model.drawerCardId = nil; model.drawerOpen = false } }
            }
        }
        // 收好了:排隊的視窗(問管家、換專案…)接著打開
        .onDisappear { model.drainPending() }
        .sheet(item: Binding(get: { model.drawerCardId.map(CardRef.init) }, set: { model.drawerCardId = $0?.id })) { ref in
            CardPopup(cardId: ref.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private func sections(_ p: Project) -> some View {
        let s = p.state
        let groups: [(String, [String])] = [("待核准", ["proposed"]), ("進行中", ["approved", "running"]), ("卡住", ["blocked"])]
        ForEach(groups, id: \.0) { label, cols in
            let list = model.cards.filter { $0.projectId == p.id && cols.contains($0.column) }
            if !list.isEmpty {
                Section("\(label) \(list.count)") {
                    ForEach(list) { c in
                        Button { model.present(.card(c.id)) } label: { DrawerCardRow(card: c) }
                            .foregroundStyle(.primary)
                    }
                }
            }
        }
        Section {
            if let progress = s?.progress, !progress.isEmpty {
                MarkdownText(progress, fixEscapes: true).font(.subheadline)
            } else {
                Text("還沒有紀錄").foregroundStyle(.secondary)
            }
        } header: {
            Text(s?.updatedAt != nil ? "目前進度 · \(Fmt.ago(Fmt.date(s?.updatedAt)))" : "目前進度")
        }
        if let next = s?.nextSteps, !next.isEmpty {
            Section("下一步") {
                ForEach(Array(next.enumerated()), id: \.offset) { _, t in MarkdownText(t, fixEscapes: true).font(.subheadline) }
            }
        }
        if let blockers = s?.blockers, !blockers.isEmpty {
            Section("卡住的地方") {
                ForEach(Array(blockers.enumerated()), id: \.offset) { _, t in MarkdownText(t, fixEscapes: true).font(.subheadline) }
            }
        }
    }
}

/// 管家側欄裡的一張工作卡:欄位顏色點、標題、交給誰 · 多久前
private struct DrawerCardRow: View {
    let card: Card

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(columnColor(card.column)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title).lineLimit(2)
                let meta = [card.agent, card.lastChanged.map { Fmt.ago($0) }].compactMap { $0 }
                if !meta.isEmpty { Text(meta.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}

/// 標題 + 項目符號清單(管家側欄用)
struct BulletList: View {
    let title: String
    let items: [String]?

    var body: some View {
        if let items, !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if !title.isEmpty { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, s in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        MarkdownText(s, fixEscapes: true).font(.subheadline)
                    }
                }
            }
        }
    }
}
