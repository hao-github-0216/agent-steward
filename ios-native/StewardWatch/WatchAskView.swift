import SwiftUI

struct WatchAskView: View {
    @EnvironmentObject private var store: WatchStore
    let projectID: String

    /// 捲動錨點:最新一則訊息、最底部(輸入區)
    private static let latestID = "watch-chat-latest"
    private static let bottomID = "watch-chat-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            List {
                WatchConnectionStatus()
                if store.canAccessContents(projectID) {
                    // 對話照時間由上往下排,最新的在最下面;往上捲看更早的訊息
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        WatchChatBubble(line: line, projectID: projectID)
                            .listRowBackground(Color.clear)
                            .accessibilityIdentifier("watch-bubble-\(index)")
                            .id(index == lines.count - 1 ? Self.latestID : "watch-chat-\(index)")
                    }
                    if store.askingProjects.contains(projectID) {
                        ProgressView("管家在想…")
                            .listRowBackground(Color.clear)
                    }
                    if store.pendingProjects.contains(projectID) {
                        Text("管家還在想，答案好了會出現在這裡")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .listRowBackground(Color.clear)
                    }
                    // 輸入區放在最下面,跟訊息 App 一樣
                    Section("建議問題") {
                        ForEach(Array((store.suggestions[projectID] ?? []).enumerated()), id: \.offset) { index, question in
                            Button(question) { submit(question) }
                                .disabled(!canAsk)
                                .accessibilityIdentifier("watch-suggestion-\(index)")
                        }
                        TextFieldLink("說出問題") { text in
                            submit(text)
                        }
                        .disabled(!canAsk)
                    }
                    Button {
                        Task { await store.refreshChat(projectID) }
                    } label: {
                        Label("重新整理", systemImage: "arrow.clockwise")
                    }
                    .disabled(!store.isReachable || store.askingProjects.contains(projectID))
                    .id(Self.bottomID)
                } else {
                    Text("隱私專案只顯示數量，請在 iPhone 上查看內容。")
                }
            }
            .navigationTitle("問管家")
            .accessibilityIdentifier("watch-ask-page")
            .task {
                await store.loadConversation(projectID)
                scrollToBottom(proxy, animated: false)
            }
            .refreshable { await store.refreshChat(projectID) }
            // 有新訊息或管家開始/結束思考時,自動捲到最新
            .onChange(of: lines.count) { scrollToBottom(proxy) }
            .onChange(of: store.askingProjects.contains(projectID)) { scrollToBottom(proxy) }
            .onDisappear { WatchSpeaker.shared.stop() }
        }
    }

    private var lines: [WatchChatLine] {
        Array((store.chats[projectID] ?? []).suffix(20))
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        guard store.canAccessContents(projectID) else { return }
        // 手錶螢幕小:讓最新一則訊息從畫面頂端開始,輸入區接在下面;還沒有對話就直接到輸入區
        let scroll = {
            if store.askingProjects.contains(projectID) || lines.isEmpty {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            } else {
                proxy.scrollTo(Self.latestID, anchor: .top)
            }
        }
        if animated { withAnimation { scroll() } } else { scroll() }
    }

    private var canAsk: Bool {
        store.isReachable && store.canAccessContents(projectID)
            && !store.askingProjects.contains(projectID)
            && !store.pendingProjects.contains(projectID)
    }

    private func submit(_ text: String) {
        Task { await store.ask(text, projectID: projectID) }
    }
}

/// 一則對話泡泡:自己的靠右、用強調色;管家的靠左、用灰底
struct WatchChatBubble: View {
    let line: WatchChatLine
    let projectID: String
    @State private var showsMenu = false
    @StateObject private var handoff = WatchHandoff.Session()

    private var isMine: Bool { ["user", "me"].contains(line.role) }

    var body: some View {
        HStack {
            if isMine { Spacer(minLength: 16) }
            WatchMarkdownText(text: line.text)
                .font(.footnote)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .foregroundStyle(isMine ? Color.white : Color.primary)
                .background(isMine ? Color.accentColor : Color.gray.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityLabel(Text(isMine ? String(localized: "你") : String(localized: "管家")) + Text(": ") + Text(line.text))
            if !isMine { Spacer(minLength: 16) }
        }
        .contentShape(Rectangle())
        .watchLongPress { showsMenu = true }
        .sheet(isPresented: $showsMenu) {
            WatchBubbleMenu(line: line, projectID: projectID, handoff: handoff)
                .onDisappear { handoff.menuClosed() }
        }
        .onDisappear { handoff.stop() }
    }
}

struct WatchBubbleMenu: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var speaker = WatchSpeaker.shared
    let line: WatchChatLine
    let projectID: String
    @ObservedObject var handoff: WatchHandoff.Session
    @State private var confirmsDraft = false
    @State private var isDrafting = false

    private var isMine: Bool { ["user", "me"].contains(line.role) }
    private var canAsk: Bool {
        store.isReachable && store.canAccessContents(projectID)
            && !store.askingProjects.contains(projectID) && !store.pendingProjects.contains(projectID)
    }

    var body: some View {
        List {
            if isMine {
                Button("再問一次") {
                    Task { await store.ask(line.text, projectID: projectID) }
                    dismiss()
                }
                .disabled(!canAsk)
                .accessibilityIdentifier("watch-bubble-again")
            } else {
                Button(speaker.isSpeaking ? String(localized: "停止") : String(localized: "唸出來")) {
                    if speaker.isSpeaking { speaker.stop() } else { speaker.speak(line.text) }
                }
                .accessibilityIdentifier("watch-bubble-speak")
                Button("做成工作卡草稿") { confirmsDraft = true }
                    .disabled(!store.isReachable || !store.canAccessContents(projectID) || isDrafting)
                    .accessibilityIdentifier("watch-bubble-draft")
                Button("在 iPhone 上看完整") {
                    handoff.open("agentsteward://project/\(projectID)/chat")
                }
                .accessibilityIdentifier("watch-bubble-handoff")
                if handoff.showsHint {
                    Text("在 iPhone 的 App 切換器或 Dock 點專案管家")
                        .font(.footnote)
                }
                if isDrafting { ProgressView("正在更新…") }
                if let result = store.actionResults[projectID] {
                    Text(result).foregroundStyle(.green)
                }
            }
        }
        .accessibilityIdentifier("watch-bubble-menu")
        .confirmationDialog("做成工作卡草稿", isPresented: $confirmsDraft, titleVisibility: .visible) {
            Button("做成工作卡草稿") {
                Task {
                    isDrafting = true
                    _ = await store.draftCard(line.text, projectID: projectID)
                    isDrafting = false
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("確定要把這段回答送到 iPhone 整理成工作卡草稿？")
        }
    }
}

struct WatchMarkdownText: View {
    let text: String

    var body: some View {
        let plainText = WatchMarkdown.hidingCode(in: text)
        if let markdown = try? AttributedString(markdown: plainText) {
            Text(markdown)
        } else {
            Text(plainText)
        }
    }
}

enum WatchMarkdown {
    /// 手錶只顯示文字內容，圍欄與縮排程式碼統一留到 iPhone 閱讀。
    static func hidingCode(in text: String) -> String {
        let placeholder = String(localized: "(程式碼，請在 iPhone 上看)")
        var output: [String] = []
        var fence: (marker: Character, count: Int)?
        var inIndentedCode = false
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let indentation = line.prefix { $0 == " " }.count
            if let active = fence {
                if trimmed.first == active.marker,
                   trimmed.prefix(while: { $0 == active.marker }).count >= active.count,
                   trimmed.allSatisfy({ $0 == active.marker || $0.isWhitespace }) {
                    fence = nil
                }
                continue
            }
            if indentation <= 3, let marker = trimmed.first, marker == "`" || marker == "~" {
                let count = trimmed.prefix { $0 == marker }.count
                if count >= 3 {
                    fence = (marker, count)
                    output.append(placeholder)
                    inIndentedCode = false
                    continue
                }
            }
            let codeIndentation = line.prefix { $0 == " " || $0 == "\t" }.reduce(0) { width, character in
                character == "\t" ? width + (4 - width % 4) : width + 1
            }
            if codeIndentation >= 4 {
                if !inIndentedCode { output.append(placeholder) }
                inIndentedCode = true
                continue
            }
            if trimmed.isEmpty, inIndentedCode { continue }
            inIndentedCode = false
            output.append(line)
        }
        return output.joined(separator: "\n")
    }
}
