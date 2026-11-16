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
                        WatchChatBubble(line: line)
                            .listRowBackground(Color.clear)
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
            .task {
                await store.loadConversation(projectID)
                scrollToBottom(proxy, animated: false)
            }
            .refreshable { await store.refreshChat(projectID) }
            // 有新訊息或管家開始/結束思考時,自動捲到最新
            .onChange(of: lines.count) { scrollToBottom(proxy) }
            .onChange(of: store.askingProjects.contains(projectID)) { scrollToBottom(proxy) }
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
