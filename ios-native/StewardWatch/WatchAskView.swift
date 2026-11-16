import SwiftUI

struct WatchAskView: View {
    @EnvironmentObject private var store: WatchStore
    let projectID: String

    var body: some View {
        List {
            WatchConnectionStatus()
            if store.canAccessContents(projectID) {
                if store.askingProjects.contains(projectID) {
                    ProgressView("管家在想…")
                }
                if store.pendingProjects.contains(projectID) {
                    Text("管家還在想，答案好了會出現在這裡")
                        .font(.footnote)
                }
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
                Section("最近的對話") {
                    ForEach(Array((store.chats[projectID] ?? []).suffix(5).enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(["user", "me"].contains(line.role) ? String(localized: "你") : String(localized: "管家"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            WatchMarkdownText(text: line.text)
                        }
                    }
                }
                Button {
                    Task { await store.refreshChat(projectID) }
                } label: {
                    Label("重新整理", systemImage: "arrow.clockwise")
                }
                .disabled(!store.isReachable || store.askingProjects.contains(projectID))
            } else {
                Text("隱私專案只顯示數量，請在 iPhone 上查看內容。")
            }
        }
        .navigationTitle("問管家")
        .task { await store.loadConversation(projectID) }
        .refreshable { await store.refreshChat(projectID) }
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
