// app 的骨架,排版跟管家網頁一樣:
//   標題列:「專案管家 ▸」(打開左邊的專案欄換專案)| 看板・程式碼・終端機 | 這個模式的工具(＋支線、管家 ▸)| ⚙
//   內容:看板是原生畫面;程式碼、終端機是管家網頁;程式碼/終端機下面可以打開管家側欄
//   右下角:貓咪浮動球(問管家)和它旁邊的圈選鈕(全 app 只有這一個圈選入口)
import SwiftUI

struct AppShell: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        @Bindable var snap = model.snap
        GeometryReader { geo in
            VStack(spacing: 0) {
                TitleBar()
                ZStack {
                    // 網頁一旦打開就一直留著(切回看板再回來還是原本的畫面),看板時藏起來
                    if model.mode.isWeb || webLoaded {
                        WebContainer()
                            .opacity(model.mode.isWeb ? 1 : 0)
                            .allowsHitTesting(model.mode.isWeb)
                    }
                    if model.mode == .board {
                        BoardView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                if model.mode.isWeb && model.drawerOpen {
                    StewardDrawer()
                        .frame(height: max(180, geo.size.height * 0.36))
                        .transition(.move(edge: .bottom))
                }
            }
            .background(Theme.bg)
            // 專案欄:從左邊滑出來(標題列下面),跟網頁窄螢幕一樣
            .overlay(alignment: .topLeading) {
                if model.showNav {
                    ProjectSidebar(width: min(300, geo.size.width * 0.85))
                        .padding(.top, TitleBar.height)
                        .transition(.move(edge: .leading))
                }
            }
            // 浮動球 + 圈選鈕
            .overlay {
                BallLayer(bottomInset: model.mode.isWeb && model.drawerOpen ? max(180, geo.size.height * 0.36) : 0)
            }
        }
        .animation(.easeOut(duration: 0.2), value: model.showNav)
        .animation(.easeOut(duration: 0.2), value: model.drawerOpen)
        .onChange(of: model.mode) { _, m in if m.isWeb { webLoaded = true } }
        .onAppear { if model.mode.isWeb { webLoaded = true } }
        // 圈選層(原生畫面):截圖鋪滿螢幕,提示放在安全區域裡
        .overlay {
            if let screen = snap.screen {
                SnapOverlay(screen: screen, onDone: { snap.finish($0, label: model.screenLabel) }, onCancel: { snap.cancel() })
            }
        }
        .sheet(item: $snap.result) { r in
            SnapSheet(snap: r, projectId: model.currentProjectId ?? "")
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $model.showChat) {
            ChatPanel()
                .presentationDetents([.fraction(0.75), .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: Binding(get: { model.openCardId.map(CardRef.init) }, set: { model.openCardId = $0?.id })) { ref in
            CardPopup(cardId: ref.id)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $model.showSettings) { SettingsView() }
        .sheet(item: $model.webSheet) { WebSheetView(sheet: $0) }
        .alert("這個專案還沒有 herdr space", isPresented: Binding(get: { model.mode == .terminal && model.needSpace != nil && model.needSpace == model.currentProjectId }, set: { if !$0 { model.needSpace = nil } })) {
            Button("建立並跳過去") { model.web.createSpace(); model.needSpace = nil }
            Button("先不要", role: .cancel) { model.needSpace = nil }
        } message: {
            Text("管家會在 herdr 開一個「\(model.current?.name ?? "")」的 space,終端機跳過去。")
        }
    }

    @State private var webLoaded = false
}

struct CardRef: Identifiable { let id: String }

// MARK: - 標題列

struct TitleBar: View {
    static let height: CGFloat = 50

    var body: some View {
        // 放得下就用一般大小;放不下(小螢幕的終端機模式)改成緊湊排法
        ViewThatFits(in: .horizontal) {
            TitleBarContent(compact: false)
            TitleBarContent(compact: true)
        }
        .frame(height: Self.height)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

private struct TitleBarContent: View {
    @Environment(AppModel.self) private var model
    let compact: Bool

    var body: some View {
        @Bindable var model = model
        HStack(spacing: compact ? 5 : 8) {
            // 專案管家 ▸:開合專案欄
            Button { model.showNav.toggle() } label: {
                HStack(spacing: 3) {
                    Text("專案管家").font(.system(size: compact ? 15 : 16, weight: .bold))
                    Text(model.showNav ? "◂" : "▸").font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                .foregroundStyle(Theme.ink)
                .fixedSize()
            }
            .accessibilityLabel(model.showNav ? "收起專案欄" : "打開專案欄,目前專案:\(model.current?.name ?? "")")
            ModeSegment(selection: $model.mode, compact: compact)
            if model.mode == .terminal { branchTools }
            if model.mode.isWeb {
                Button { model.drawerOpen.toggle() } label: {
                    Text(compact ? "管家" : (model.drawerOpen ? "管家 ◂" : "管家 ▸")).fixedSize()
                }
                .buttonStyle(SmallButtonStyle(compact: compact))
                .accessibilityLabel(model.drawerOpen ? "收起管家側欄" : "打開管家側欄")
            }
            Spacer(minLength: 0)
            // 網頁在手機的終端機模式放不下設定鈕,這裡也一樣(到看板或程式碼再按)
            if model.mode != .terminal {
                Button { model.showSettings = true } label: {
                    Image(systemName: "gearshape").font(.system(size: 17)).foregroundStyle(Theme.muted)
                }
                .accessibilityLabel("設定")
            }
        }
        .padding(.horizontal, compact ? 8 : 12)
        .frame(height: TitleBar.height)
    }

    /// 終端機的支線工具(跟網頁一樣:herdr 停在 agent 上才能開支線;停在支線上換成「帶回」)
    @ViewBuilder
    private var branchTools: some View {
        if let main = model.termState.branchMain {
            Button("帶回") { model.web.handoff() }
                .buttonStyle(SmallButtonStyle(primary: true, compact: compact))
                .disabled(!model.termState.mainAlive)
                .accessibilityLabel(model.termState.mainAlive ? "把這條支線的結論帶回「\(main)」" : "主線已經關閉,沒辦法帶回")
        } else if model.termState.agent {
            Menu {
                Button("開支線(另開 worktree)") { model.web.openBranch(here: false) }
                Button("同資料夾開(不建 worktree)") { model.web.openBranch(here: true) }
            } label: {
                Text(compact ? "＋支線" : "＋支線 ▾").fixedSize()
            } primaryAction: {
                model.web.openBranch(here: false)
            }
            .buttonStyle(SmallButtonStyle(compact: compact))
            .accessibilityLabel("從 herdr 目前的 agent 開一條支線;長按有其他開法")
        }
    }
}

/// 網頁的 .seg:細框一組按鈕,選到的藍底白字
struct ModeSegment: View {
    @Binding var selection: Mode
    var compact = false

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Mode.allCases) { m in
                Button { selection = m } label: {
                    Text(m.title)
                        .font(.system(size: 13, weight: selection == m ? .semibold : .regular))
                        .padding(.horizontal, compact ? 6 : 9).padding(.vertical, 5)
                        .foregroundStyle(selection == m ? Color.white : Theme.ink)
                        .background(selection == m ? Theme.accent : Color.clear)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == m ? .isSelected : [])
                if m != Mode.allCases.last { Rectangle().fill(Theme.line).frame(width: 1, height: 26) }
            }
        }
        .background(Theme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
        .fixedSize()
    }
}

// MARK: - 浮動球(貓咪)和圈選鈕

struct BallLayer: View {
    @Environment(AppModel.self) private var model
    let bottomInset: CGFloat
    @State private var drag: CGSize = .zero
    @State private var dragging = false

    private let size: CGFloat = 56
    private let inset: CGFloat = 18

    var body: some View {
        GeometryReader { geo in
            let c = model.ballCorner
            let x = c.isRight ? geo.size.width - inset - size / 2 : inset + size / 2
            let topY = TitleBar.height + inset + size / 2
            let bottomY = geo.size.height - bottomInset - inset - size / 2
            let y = c.isBottom ? bottomY : topY
            ZStack {
                // 圈選鈕:在貓的內側上方(網頁 #ballSnap:right 66 / bottom 58)
                if !dragging {
                    SnapButton()
                        .position(x: x + (c.isRight ? -40 : 40), y: y + (c.isBottom ? -40 : 40))
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
                    .simultaneousGesture(TapGesture().onEnded { model.chatUnread = false; model.showChat = true })
                    .accessibilityElement()
                    .accessibilityLabel("問管家")
                    .accessibilityHint("可以拖到畫面四個角落")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { model.chatUnread = false; model.showChat = true }
            }
            .animation(.spring(duration: 0.25), value: model.ballCorner)
        }
        .ignoresSafeArea(.keyboard)
    }
}

/// 圈選鈕:看板用 app 的圈選(Vision 讀字);程式碼、終端機用網頁自己的圈選(帶行號、分得出 agent 窗格)
struct SnapButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            if model.mode.isWeb { model.web.snap() } else { model.snap.begin() }
        } label: {
            Image(systemName: "text.bubble")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 36, height: 36)
                .background(Theme.panel, in: Circle())
                .overlay(Circle().stroke(Theme.line))
                .shadow(color: .black.opacity(0.2), radius: 3, y: 2)
                .foregroundStyle(Theme.accent)
        }
        .accessibilityLabel("圈選畫面問管家")
    }
}

struct CatBall: View {
    let busy: Bool
    let unread: Bool
    @State private var blink = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Circle().fill(Theme.ball)
                .shadow(color: .black.opacity(0.3), radius: 9, y: 6)
            CatLogo().padding(4)
                .scaleEffect(busy && blink ? 1.06 : 1)
            if unread {
                Circle().fill(Theme.bad).frame(width: 12, height: 12)
                    .overlay(Circle().stroke(Color.white, lineWidth: 2))
                    .accessibilityLabel("有新的回答")
            }
        }
        .onChange(of: busy) { _, b in
            if b { withAnimation(.easeInOut(duration: 0.6).repeatForever()) { blink = true } } else { blink = false }
        }
    }
}

// MARK: - 管家側欄(程式碼/終端機下面,跟網頁的 #drawer 一樣)

struct StewardDrawer: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.current?.name ?? "管家").font(.system(size: 15, weight: .bold))
                    Text("目前的專案").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("收起") { model.drawerOpen = false }.buttonStyle(.small)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if let p = model.current {
                        drawerBody(p)
                    } else {
                        Text("在看板、程式碼頁面或 herdr 選一個專案").foregroundStyle(Theme.muted)
                    }
                }
                .font(.system(size: 14))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }
        .background(Theme.panel)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    @ViewBuilder
    private func drawerBody(_ p: Project) -> some View {
        let s = p.state
        let labels: [(String, String)] = [("proposed", "待核准"), ("running", "進行中"), ("blocked", "卡住")]
        ForEach(labels, id: \.0) { col, label in
            let list = model.cards.filter { $0.projectId == p.id && ($0.column == col || (col == "running" && $0.column == "approved")) }
            if !list.isEmpty {
                SectionLabel("\(label) \(list.count)")
                ForEach(list) { c in KCard(card: c) }
            }
        }
        if let progress = s?.progress, !progress.isEmpty {
            SectionLabel("目前進度 · \(Fmt.ago(Fmt.date(s?.updatedAt)))")
            MarkdownText(progress, fixEscapes: true)
        } else {
            Text("還沒有紀錄").foregroundStyle(Theme.muted)
        }
        BulletList(title: "下一步", items: s?.nextSteps)
        BulletList(title: "卡住的地方", items: s?.blockers)
    }
}

/// 網頁 brief 的 <h4> + <ul>
struct BulletList: View {
    let title: String
    let items: [String]?

    var body: some View {
        if let items, !items.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                if !title.isEmpty { SectionLabel(title) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, s in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(Theme.muted)
                        MarkdownText(s, fixEscapes: true)
                    }
                }
            }
        }
    }
}
