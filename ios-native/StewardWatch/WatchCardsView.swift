import SwiftUI

struct WatchCardsView: View {
    @EnvironmentObject private var store: WatchStore
    let projectID: String
    @State private var menuCard: WatchCard?
    @StateObject private var handoff = WatchHandoff.Session()

    var body: some View {
        List {
            WatchConnectionStatus()
            if let result = store.actionResults[projectID] {
                Label(result, systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            if store.canAccessContents(projectID) {
                cardSection("提案", column: "proposed")
                cardSection("卡住", column: "blocked")
                cardSection("進行中", column: "inProgress")
                if visibleCards.isEmpty {
                    Text("沒有工作卡")
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("隱私專案只顯示數量，請在 iPhone 上查看內容。")
            }
        }
        .navigationTitle("工作卡")
        .refreshable { await store.refresh() }
        .sheet(item: $menuCard) { card in
            NavigationStack {
                WatchCardMenu(projectID: projectID, initialCard: card, handoff: handoff)
            }
            .onDisappear { handoff.menuClosed() }
        }
        .onDisappear { handoff.stop() }
    }

    private var visibleCards: [WatchCard] {
        (store.project(projectID)?.cards ?? []).filter {
            ["proposed", "blocked", "inProgress"].contains($0.column)
        }
    }

    @ViewBuilder
    private func cardSection(_ title: LocalizedStringKey, column: String) -> some View {
        let cards = visibleCards.filter { $0.column == column }
        if !cards.isEmpty {
            Section(title) {
                ForEach(cards) { card in
                    NavigationLink {
                        WatchCardView(projectID: projectID, initialCard: card)
                    } label: {
                        Text(card.title)
                    }
                    .accessibilityIdentifier("watch-card-\(card.id)")
                    .watchLongPress { menuCard = card }
                }
            }
        }
    }
}

struct WatchCardView: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    let projectID: String
    let initialCard: WatchCard
    @State private var selectedMove: CardMove?

    var body: some View {
        List {
            WatchConnectionStatus()
            if store.canAccessContents(projectID) {
                Section { WatchMarkdownText(text: card.title) }
                if let agent = card.agent, !agent.isEmpty {
                    Section("Agent") { Text(agent) }
                }
                if let criteria = card.doneCriteria, !criteria.isEmpty {
                    Section("完成標準") { WatchMarkdownText(text: criteria) }
                }
                if let note = card.note, !note.isEmpty {
                    Section(card.column == "blocked" ? String(localized: "卡住原因") : String(localized: "備註")) {
                        WatchMarkdownText(text: note)
                    }
                }
                if store.movingCards.contains(card.id) {
                    ProgressView("正在更新…")
                }
                if card.column == "proposed" {
                    moveButton(.approve)
                        .accessibilityIdentifier("watch-approve")
                    moveButton(.reject)
                } else if card.column == "blocked" {
                    moveButton(.redispatch)
                    moveButton(.done)
                }
            } else {
                Text("隱私專案只顯示數量，請在 iPhone 上查看內容。")
            }
        }
        .navigationTitle("工作卡")
        .confirmationDialog(selectedMove?.title ?? "", isPresented: Binding(
            get: { selectedMove != nil },
            set: { if !$0 { selectedMove = nil } }
        ), titleVisibility: .visible, presenting: selectedMove) { move in
            Button(move.title, role: move == .reject ? .destructive : nil) {
                Task {
                    if await store.move(card.id, to: move.column, projectID: projectID, result: move.result) {
                        dismiss()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("確定要更新這張工作卡？")
        }
    }

    private var card: WatchCard {
        store.project(projectID)?.cards.first { $0.id == initialCard.id } ?? initialCard
    }

    private func moveButton(_ move: CardMove) -> some View {
        Button(move.title, role: move == .reject ? .destructive : nil) {
            selectedMove = move
        }
        .disabled(!store.isReachable || store.movingCards.contains(card.id))
    }
}

struct WatchCardMenu: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    let projectID: String
    let initialCard: WatchCard
    @ObservedObject var handoff: WatchHandoff.Session
    @State private var selectedMove: CardMove?
    @State private var selectedAgent: WatchAgent?

    var body: some View {
        List {
            Text(card.title).lineLimit(2)
            if card.column == "proposed" {
                moveButton(.approve, identifier: "approve")
                moveButton(.reject, identifier: "reject")
            } else if card.column == "blocked" {
                moveButton(.redispatch, identifier: "redispatch")
                moveButton(.done, identifier: "done")
            }
            TextFieldLink("追問 agent") { text in
                Task {
                    if await store.askCard(card.id, text: text, projectID: projectID) { dismiss() }
                }
            }
            .disabled(unavailable)
            .accessibilityIdentifier("watch-card-menu-ask")
            if ["proposed", "blocked"].contains(card.column) {
                NavigationLink {
                    agentList
                } label: {
                    Text("換 agent")
                }
                .disabled(unavailable)
                .accessibilityIdentifier("watch-card-menu-assign")
            }
            Button("在 iPhone 上打開") {
                handoff.open("agentsteward://card/\(card.id)")
            }
            .accessibilityIdentifier("watch-card-menu-handoff")
            if handoff.showsHint {
                Text("在 iPhone 的 App 切換器或 Dock 點專案管家")
                    .font(.footnote)
            }
        }
        .accessibilityIdentifier("watch-card-menu")
        .confirmationDialog(selectedMove?.title ?? "", isPresented: Binding(
            get: { selectedMove != nil },
            set: { if !$0 { selectedMove = nil } }
        ), titleVisibility: .visible, presenting: selectedMove) { move in
            Button(move.title, role: move == .reject ? .destructive : nil) {
                Task {
                    if await store.move(card.id, to: move.column, projectID: projectID, result: move.result) {
                        dismiss()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("確定要更新這張工作卡？")
        }
    }

    private var card: WatchCard {
        store.project(projectID)?.cards.first { $0.id == initialCard.id } ?? initialCard
    }

    private var unavailable: Bool {
        !store.isReachable || !store.canAccessContents(projectID) || store.movingCards.contains(card.id)
    }

    private func moveButton(_ move: CardMove, identifier: String) -> some View {
        Button(move.title, role: move == .reject ? .destructive : nil) { selectedMove = move }
            .disabled(unavailable)
            .accessibilityIdentifier("watch-card-menu-\(identifier)")
    }

    private var agentList: some View {
        List(store.agents, id: \.id) { agent in
            Button(agent.name ?? agent.id) { selectedAgent = agent }
                .disabled(unavailable)
        }
        .navigationTitle("換 agent")
        .task { await store.loadAgents() }
        .confirmationDialog("換 agent", isPresented: Binding(
            get: { selectedAgent != nil },
            set: { if !$0 { selectedAgent = nil } }
        ), titleVisibility: .visible, presenting: selectedAgent) { agent in
            Button("換 agent") {
                Task {
                    if await store.assignCard(card.id, agent: agent.id, projectID: projectID) { dismiss() }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { agent in
            Text("確定要換成 \(agent.name ?? agent.id)？")
        }
    }
}

private enum CardMove {
    case approve, reject, redispatch, done

    var column: String {
        switch self {
        case .approve, .redispatch: return "approved"
        case .reject: return "rejected"
        case .done: return "done"
        }
    }

    var title: String {
        switch self {
        case .approve: return String(localized: "核准派工")
        case .reject: return String(localized: "不要")
        case .redispatch: return String(localized: "重新派工")
        case .done: return String(localized: "標成完成")
        }
    }

    var result: String {
        switch self {
        case .approve: return String(localized: "已核准")
        case .reject: return String(localized: "不要了")
        case .redispatch: return String(localized: "已重新派工")
        case .done: return String(localized: "已標成完成")
        }
    }
}
