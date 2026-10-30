// 程式碼頁的編輯區(跟網頁程式碼頁一樣可以自由排版,外觀用 Apple 的分頁列、分隔線、長按選單、拖曳):
//   iPad:分割成多格(最多 4 欄 × 每欄 3 格),拖分隔線調大小;把分頁或側欄的檔案拖到某一格的邊緣就分割、拖到中間加成分頁
//   iPhone 和窄視窗:一格,上方分頁列(所有分頁排在一起)
import SwiftUI
import UniformTypeIdentifiers

// MARK: - iPad:分割編輯區

struct EditorArea: View {
    @Environment(AppModel.self) private var model
    let project: Project
    /// 一格最窄、最矮(再小就自動少開幾欄/幾格)
    static let minPaneWidth: CGFloat = 280
    static let minPaneHeight: CGFloat = 170
    @State private var dragStart: [Double]?

    var body: some View {
        let ws = model.code
        GeometryReader { geo in
            let cols = ws.layout.columns
            let total = cols.reduce(0) { $0 + $1.size }
            let avail = max(0, geo.size.width - CGFloat(cols.count - 1))
            // 看檔案全螢幕:目前這一格佔滿,其他格縮成 0(不拿掉,回來時不用重新載入)
            let full: UUID? = model.isReaderFullScreen ? ws.activePaneID : nil
            HStack(spacing: 0) {
                ForEach(Array(cols.enumerated()), id: \.element.id) { ci, col in
                    let shown = full.map { id in col.panes.contains { $0.id == id } } ?? true
                    ColumnView(project: project, column: col, ci: ci, height: geo.size.height, fullPane: full)
                        .frame(width: full == nil ? max(0, avail * col.size / total) : (shown ? geo.size.width : 0))
                        .opacity(shown ? 1 : 0)
                        .allowsHitTesting(shown)
                        .accessibilityHidden(!shown)
                    if ci < cols.count - 1 && full == nil {
                        SplitDivider(axis: .vertical) { delta in
                            let start = dragStart ?? cols.map(\.size)
                            if dragStart == nil { dragStart = start }
                            ws.setColumnSizes(Self.resized(start, at: ci, delta: delta / avail * total, min: Self.minPaneWidth / avail * total))
                        } onEnd: {
                            dragStart = nil
                            ws.setColumnSizes(ws.layout.columns.map(\.size), save: true)
                        }
                    }
                }
            }
            .onChange(of: geo.size, initial: true) { _, size in
                // 剛出現時寬高可能還是 0:量好了才看要不要少開幾欄(不然會把版面全部併成一格)
                guard size.width >= 200, size.height >= 200 else { return }
                ws.fit(maxColumns: Int(size.width / Self.minPaneWidth), maxRows: Int(size.height / Self.minPaneHeight))
            }
        }
        .background(Color(.systemBackground))
        .background { EditorShortcuts() }
    }

    /// 拖分隔線:第 i 個和第 i+1 個一起調(一個變大另一個就變小),都不小於 min
    static func resized(_ start: [Double], at i: Int, delta: Double, min m: Double) -> [Double] {
        guard start.indices.contains(i + 1) else { return start }
        var s = start
        let pair = start[i] + start[i + 1]
        let a = Swift.min(Swift.max(start[i] + delta, m), pair - m)
        s[i] = a
        s[i + 1] = pair - a
        return s
    }
}

/// 一欄:由上到下幾格,格子之間的分隔線上下拖
struct ColumnView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let column: EditorColumn
    let ci: Int
    let height: CGFloat
    /// 看檔案全螢幕的那一格(nil = 沒有全螢幕)
    var fullPane: UUID?
    @State private var dragStart: [Double]?

    var body: some View {
        let ws = model.code
        let total = column.panes.reduce(0) { $0 + $1.size }
        let avail = max(0, height - CGFloat(column.panes.count - 1))
        VStack(spacing: 0) {
            ForEach(Array(column.panes.enumerated()), id: \.element.id) { pi, pane in
                let shown = fullPane.map { $0 == pane.id } ?? true
                PaneView(project: project, pane: pane)
                    .frame(height: fullPane == nil ? max(0, avail * pane.size / total) : (shown ? height : 0))
                    .opacity(shown ? 1 : 0)
                    .allowsHitTesting(shown)
                    .accessibilityHidden(!shown)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("pane-\(ci)-\(pi)")
                if pi < column.panes.count - 1 && fullPane == nil {
                    SplitDivider(axis: .horizontal) { delta in
                        let start = dragStart ?? column.panes.map(\.size)
                        if dragStart == nil { dragStart = start }
                        ws.setPaneSizes(column: ci, EditorArea.resized(start, at: pi, delta: delta / avail * total, min: EditorArea.minPaneHeight / avail * total))
                    } onEnd: {
                        dragStart = nil
                        if ws.layout.columns.indices.contains(ci) { ws.setPaneSizes(column: ci, ws.layout.columns[ci].panes.map(\.size), save: true) }
                    }
                }
            }
        }
    }
}

/// 格子之間的分隔線:看起來是一條細線,中間有小把手;可以按住拖的範圍比線寬
struct SplitDivider: View {
    enum Axis { case vertical, horizontal }
    /// vertical:欄和欄之間(左右拖);horizontal:同一欄的格子之間(上下拖)
    let axis: Axis
    let onDrag: (CGFloat) -> Void
    let onEnd: () -> Void
    @State private var dragging = false

    var body: some View {
        let v = axis == .vertical
        Rectangle()
            .fill(dragging ? Theme.accent : Color(.separator))
            .frame(width: v ? 1 : nil, height: v ? nil : 1)
            .overlay {
                Capsule()
                    .fill(dragging ? Theme.accent : Color(.tertiaryLabel))
                    .frame(width: v ? 5 : 36, height: v ? 36 : 5)
            }
            .overlay {
                Color.clear
                    .frame(width: v ? 18 : nil, height: v ? nil : 18)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 1, coordinateSpace: .global)
                            .onChanged { g in
                                if !dragging { dragging = true; UISelectionFeedbackGenerator().selectionChanged() }
                                onDrag(v ? g.translation.width : g.translation.height)
                            }
                            .onEnded { _ in
                                dragging = false
                                onEnd()
                            }
                    )
            }
            .zIndex(1)
            .accessibilityElement()
            .accessibilityLabel(v ? "左右調整格子大小" : "上下調整格子大小")
    }
}

// MARK: - 一格

struct PaneView: View {
    @Environment(AppModel.self) private var model
    let project: Project
    let pane: EditorPane
    @State private var dropZone: SplitZone?
    @State private var size: CGSize = .zero

    var body: some View {
        let ws = model.code
        let isActive = ws.activePaneID == pane.id
        VStack(spacing: 0) {
            if !model.isReaderFullScreen {
                TabStrip(tabs: pane.tabs, activeId: pane.activeTab?.id, paneId: pane.id, highlighted: isActive && ws.paneCount > 1)
            }
            if let t = pane.activeTab {
                TabContent(project: project, tab: t, embedded: true, isActive: isActive)
                    .id(t.id)
            } else {
                ContentUnavailableView("沒有打開的檔案", systemImage: "doc.text", description: Text("在左邊的清單點檔案,或把檔案拖到這裡。"))
            }
        }
        .background(Color(.systemBackground))
        .overlay { if let dropZone { DropHighlight(zone: dropZone) } }
        // 點到這一格:側欄點檔案會開在這裡
        .simultaneousGesture(TapGesture().onEnded { ws.focus(pane.id) })
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { r in
            size = r.size
            ws.paneFrames[pane.id] = r
        }
        .onDrop(of: [.stewardTab], delegate: PaneDropDelegate(size: size, zone: $dropZone) { tab, zone in
            model.openCode(tab, in: pane.id, zone: zone)
        })
    }
}

/// 拖分頁或檔案到一格上:看手指在哪一塊決定分割的方向(跟網頁一樣邊緣 22% 算那一邊)
struct PaneDropDelegate: DropDelegate {
    let size: CGSize
    @Binding var zone: SplitZone?
    let onDrop: (EditorTab, SplitZone) -> Void

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.stewardTab]) }
    func dropEntered(info: DropInfo) { zone = zoneFor(info.location) }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        let z = zoneFor(info.location)
        if z != zone { zone = z; UISelectionFeedbackGenerator().selectionChanged() }
        return DropProposal(operation: .move)
    }
    func dropExited(info: DropInfo) { zone = nil }

    func performDrop(info: DropInfo) -> Bool {
        let z = zone ?? .center
        zone = nil
        guard let provider = info.itemProviders(for: [.stewardTab]).first else { return false }
        _ = provider.loadTransferable(type: EditorTab.self) { result in
            if case .success(let tab) = result { DispatchQueue.main.async { onDrop(tab, z) } }
        }
        return true
    }

    private func zoneFor(_ p: CGPoint) -> SplitZone {
        guard size.width > 0, size.height > 0 else { return .center }
        let x = p.x / size.width, y = p.y / size.height
        if x < 0.22 { return .left }
        if x > 0.78 { return .right }
        if y < 0.22 { return .top }
        if y > 0.78 { return .bottom }
        return .center
    }
}

/// 放下去會到哪:藍色半透明蓋住那一半(中間 = 整格)
struct DropHighlight: View {
    let zone: SplitZone

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            let r: CGRect = switch zone {
            case .left: CGRect(x: 0, y: 0, width: w / 2, height: h)
            case .right: CGRect(x: w / 2, y: 0, width: w / 2, height: h)
            case .top: CGRect(x: 0, y: 0, width: w, height: h / 2)
            case .bottom: CGRect(x: 0, y: h / 2, width: w, height: h / 2)
            case .center: CGRect(x: 0, y: 0, width: w, height: h)
            }
            RoundedRectangle(cornerRadius: 10)
                .fill(Theme.accent.opacity(0.18))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.accent, lineWidth: 2))
                .frame(width: r.width - 8, height: r.height - 8)
                .position(x: r.midX, y: r.midY)
                .animation(.snappy(duration: 0.18), value: zone)
        }
        .allowsHitTesting(false)
    }
}

/// 分頁的內容:檔案或 Git 差異
struct TabContent: View {
    let project: Project
    let tab: EditorTab
    var embedded: Bool
    var isActive: Bool

    var body: some View {
        switch tab.kind {
        case .file:
            FileView(project: project, path: tab.path, tabId: tab.id, embedded: embedded, isActive: isActive)
        case .diff:
            DiffView(project: project, path: tab.path, which: tab.which ?? "unstaged", commit: tab.commit, tabId: tab.id, embedded: embedded)
        }
    }
}

// MARK: - 分頁列

struct TabStrip: View {
    @Environment(AppModel.self) private var model
    let tabs: [EditorTab]
    let activeId: String?
    /// 這一列屬於哪一格(iPad);iPhone 單格傳 nil(每個分頁回到它自己所在的那一格)
    let paneId: UUID?
    var highlighted = false

    var body: some View {
        let ws = model.code
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(tabs) { t in
                        TabChip(tab: t, active: t.id == activeId, dirty: ws.dirty.contains(t.id), canSplit: paneId != nil && !model.compact) {
                            if let p = paneId ?? ws.paneOf(tab: t.id) { ws.activate(t.id, in: p) }
                        }
                        .id(t.id)
                    }
                }
                .padding(.horizontal, 8)
            }
            .onAppear { if let activeId { proxy.scrollTo(activeId) } }
            .onChange(of: activeId) { _, id in if let id { withAnimation(.snappy) { proxy.scrollTo(id) } } }
        }
        .frame(height: 42)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .bottom) {
            if highlighted { Rectangle().fill(Theme.accent).frame(height: 2) } else { Divider() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("分頁")
    }
}

struct TabChip: View {
    @Environment(AppModel.self) private var model
    let tab: EditorTab
    let active: Bool
    let dirty: Bool
    /// iPad 才有「在右邊/下面打開」
    let canSplit: Bool
    let onSelect: () -> Void

    var body: some View {
        let ws = model.code
        HStack(spacing: 6) {
            Image(systemName: tab.kind == .diff ? "plusminus" : fileIcon(tab.name))
                .font(.caption)
                .foregroundStyle(active ? Theme.accent : .secondary)
            Text(tab.name)
                .font(.subheadline.weight(active ? .semibold : .regular))
                .lineLimit(1)
            if let d = tab.detail { Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
            if dirty {
                Circle().fill(Theme.accent).frame(width: 7, height: 7).accessibilityLabel("還沒存")
            }
            Button { ws.requestClose(tab) } label: {
                Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(.secondary).padding(4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("關閉 \(tab.name)")
        }
        .padding(.leading, 10).padding(.trailing, 4)
        .frame(height: 32)
        .background {
            if active {
                RoundedRectangle(cornerRadius: 9).fill(Color(.systemBackground))
                    .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 9))
        .onTapGesture { onSelect() }
        .contextMenu { menu }
        // 沒存先問:掛在分頁上,iPad 的問句會指著要關的這個分頁
        .modifier(CloseTabDialog(tab: tab))
        .draggable(tab) {
            Label(tab.name, systemImage: tab.kind == .diff ? "plusminus" : fileIcon(tab.name))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(active ? [.isSelected, .isButton] : .isButton)
        // 合併後 ✕ 點不到:VoiceOver 用「動作」關
        .accessibilityAction(named: "關閉") { ws.requestClose(tab) }
        .accessibilityIdentifier("tab-\(tab.id)")
    }

    /// 長按的選單(寫在這裡,不另外做成會讀環境的 View:長按選單畫在一般畫面樹外面)
    @ViewBuilder
    private var menu: some View {
        let ws = model.code
        if canSplit, let p = ws.paneOf(tab: tab.id) {
            Button { model.openCode(tab, in: p, zone: .right) } label: { Label("在右邊打開", systemImage: "rectangle.righthalf.inset.filled") }
            Button { model.openCode(tab, in: p, zone: .bottom) } label: { Label("在下面打開", systemImage: "rectangle.bottomhalf.inset.filled") }
            Divider()
        }
        if tab.kind == .file {
            Button { model.pendingChat = .file(tab.path); model.present(.chat) } label: { Label("問管家這個檔案", systemImage: "bubble.left.and.text.bubble.right") }
        }
        Button { UIPasteboard.general.string = tab.path } label: { Label("複製路徑", systemImage: "doc.on.doc") }
        Divider()
        Button { ws.closeOthers(tab.id) } label: { Label("關閉其他分頁", systemImage: "xmark.square") }
        Button(role: .destructive) { ws.requestClose(tab) } label: { Label("關閉", systemImage: "xmark") }
    }
}

/// 要關的分頁還沒存:問要存檔再關、不存直接關、還是取消
struct CloseTabDialog: ViewModifier {
    @Environment(AppModel.self) private var model
    let tab: EditorTab
    @State private var error: String?

    func body(content: Content) -> some View {
        let ws = model.code
        content
            .confirmationDialog("「\(tab.name)」還沒存", isPresented: Binding(get: { ws.pendingClose?.id == tab.id }, set: { if !$0, ws.pendingClose?.id == tab.id { ws.pendingClose = nil } }), titleVisibility: .visible, presenting: ws.pendingClose) { tab in
                Button("存檔再關閉") { Task { await saveAndClose(tab) } }
                Button("不存,直接關閉", role: .destructive) { ws.close(tab.id) }
                Button("取消", role: .cancel) {}
            } message: { _ in
                Text("不存的話,這次的修改會不見。")
            }
            .alert("沒存成", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("好") {}
            } message: {
                Text(error ?? "")
            }
    }

    private func saveAndClose(_ tab: EditorTab) async {
        let ws = model.code
        guard let api = model.api, let pid = model.currentProjectId, let d = ws.drafts[tab.id] else { ws.close(tab.id); return }
        do {
            _ = try await api.saveFile(project: pid, path: tab.path, content: d.text, baseHash: d.baseHash)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            ws.gitChanged += 1
            ws.close(tab.id)
        } catch is SaveConflict {
            if let p = ws.paneOf(tab: tab.id) { ws.activate(tab.id, in: p) }
            error = "「\(tab.name)」在你開始改之後被別人改過了,先在分頁裡決定要覆蓋還是載入新版。"
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// iPad 外接鍵盤:⌘\ 向右分割、⌘W 關分頁、⌘⇧] / ⌘⇧[ 切分頁(跟 Safari 一樣)。
/// ⌃Tab / ⌃⇧Tab 也登記了,但 iPadOS 會拿 Tab 系列的鍵移動鍵盤焦點,不一定收得到。⌘S 存檔、⌘F 尋找在檔案的動作列
struct EditorShortcuts: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let ws = model.code
        VStack {
            Button("向右分割") { if let t = ws.activeTab { model.openCode(t, in: ws.activePaneID, zone: .right) } }
                .keyboardShortcut("\\", modifiers: .command)
            Button("關閉分頁") { if let t = ws.activeTab { ws.requestClose(t) } }
                .keyboardShortcut("w", modifiers: .command)
            Button("下一個分頁") { ws.cycleTab(1) }
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("上一個分頁") { ws.cycleTab(-1) }
                .keyboardShortcut("[", modifiers: [.command, .shift])
            Button("下一個分頁(⌃Tab)") { ws.cycleTab(1) }
                .keyboardShortcut(.tab, modifiers: .control)
            Button("上一個分頁(⌃⇧Tab)") { ws.cycleTab(-1) }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - iPhone 和窄視窗:一格 + 分頁列

struct CompactEditor: View {
    @Environment(AppModel.self) private var model
    let project: Project

    var body: some View {
        let ws = model.code
        let tabs = ws.allTabs
        let active = ws.activeTab
        VStack(spacing: 0) {
            if !model.isReaderFullScreen { TabStrip(tabs: tabs, activeId: active?.id, paneId: nil) }
            if let t = active {
                TabContent(project: project, tab: t, embedded: false, isActive: true)
                    .id(t.id)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { r in
                        if let p = ws.paneOf(tab: t.id) { ws.paneFrames[p] = r }
                    }
            } else {
                ContentUnavailableView("沒有打開的檔案", systemImage: "doc.text")
            }
        }
        // 分頁都關了:回清單
        .onChange(of: tabs.isEmpty) { _, empty in
            if empty, model.codePath.last == .editor { model.codePath.removeLast() }
        }
    }
}
